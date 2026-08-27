照合完了。監査指摘9の根拠（events の facility・kind 列）と移行API構造を実物で確認しました（実在パスは `/Users/Takeshi/Claude/Repos/gas-sync/moushiokuri-viewer/コード.js`。元設計が引いた `gas/moushiokuri-api.gs` は存在せず、本改訂版では実在パスへ差し替えます）。

---

# care-log DB・検索・バックエンド設計 改訂版（Subagent 1・監査反映）

## 結論（確信度: 高）

監査指摘13件を **12件受諾・1件部分受諾**（#10: UI動線はSubagent 2管轄、DB側責務のみ本設計に反映）。骨格（Supabase 新規プロジェクト・日付チャンク取得・pg_trgm 基線・rev トリガ楽観ロック）は維持しつつ、**①夜間 pg_dump バックアップ（§9新設）②操作職員ピッカーによる既読主体の確定（§4）③upsert 全廃＝insert/update 明示分岐（§5）④切替日Dまでの入力封鎖と importer skip 規則（§7）⑤RPC `timeline_chunk` による1往復取得（§2）**を構造に組み込んだ。テーブルは計11（業務8＋設定1＋運用2）。

## 1. テーブル設計（DDLスケッチ）

方針は元設計どおり: 冪等DDL（0008/0009 の流儀。根拠: `/Users/Takeshi/Claude/Projects/kitchen-app/.claude/worktrees/remote-control-65a07c/supabase/migrations/0008_restrict_read_to_authenticated.sql`・`0009_app_settings.sql`）、**delete ポリシー不作成＝物理削除構造的不可**、soft delete のみ。

```sql
-- 利用者スナップショット（正本= GAS master.gs getRoster。読み取り専用の写し）
residents ( id bigint identity PK,
  source_id text unique not null, name text not null, kana text, room text,
  gender text, care_level text,
  active boolean not null default true,
  needs_review boolean not null default false,   -- id一致・氏名大幅不一致の保留印
  synced_at timestamptz not null default now() )

-- 職員スナップショット（正本=統合GAS クラウドキー staff。name 実質キー）
staff ( id bigint identity PK, name text unique not null,
  active boolean not null default true, synced_at timestamptz default now() )
-- 氏名変更=新行・旧行 inactive（過去記録の表示が遡って変わらない）
-- 将来の個別アカウント移行用に auth_uid uuid null を最初から定義（列だけ。運用は§4）

-- バイタル（1行=1測定）
vitals ( id bigint identity PK,
  resident_id bigint not null references residents(id),
  measured_on date not null,          -- 業務日付（JST・クライアント明示指定）
  kind text not null check (kind in ('routine','recheck','observation')),
  measured_at time,
  temp numeric(3,1) check (temp between 30 and 45),
  sys_bp smallint check (sys_bp between 40 and 300),
  dia_bp smallint check (dia_bp between 20 and 200),
  pulse smallint check (pulse between 20 and 250),
  spo2 smallint check (spo2 between 50 and 100),
  note text, raw_flags jsonb,          -- 数値化不能原文の保持（0にしない）
  import_key text unique,              -- 蓄積スプシ由来の冪等キー（ネイティブ入力=null）
  recorded_by bigint references staff(id), rev int not null default 1,
  created_at/updated_at timestamptz, deleted_at timestamptz, deleted_by bigint )
-- 部分unique: (resident_id, measured_on) where kind='routine' and deleted_at is null
--   ※DB側防波堤としてのみ。アプリは upsert を使わない（§5・監査#3）

-- 食事（1行=1食。水分は別表）
meals ( id bigint identity PK, resident_id bigint not null references residents(id),
  meal_on date not null,
  meal_slot text not null check (meal_slot in ('breakfast','lunch','dinner','snack')),
  main_amount smallint check (main_amount between 0 and 10),
  side_amount smallint check (side_amount between 0 and 10),
  status text check (status in ('eaten','out','hospital','refused')),
  note text, raw_flags jsonb, import_key text unique,
  recorded_by/rev/監査列/soft delete列 同上 )
-- 部分unique: (resident_id, meal_on, meal_slot) where deleted_at is null（同上・防波堤のみ）

-- 水分（1行=1回。日合計はクエリ算出）
fluid_intake ( id bigint identity PK, resident_id bigint not null references residents(id),
  taken_on date not null, taken_at time, amount_ml int check (amount_ml between 0 and 2000),
  kind text, recorded_by/rev/監査列/soft delete列 同上 )

-- 申し送り（1行=1件）
notes ( id bigint identity PK,
  note_on date not null,
  shift text not null check (shift in ('day','daycare','night')),
  facility text,                       -- ★監査#9: 移行元 events.facility の受け皿
  category text,                       -- ★監査#9: 移行元 events.kind（種別）の受け皿
  resident_id bigint references residents(id),   -- null=全体連絡
  role_tags text[] not null default '{}',
  importance text not null default 'normal' check (importance in ('normal','important','critical')),
  body text not null check (body <> ''),
  occurred_at time,
  ongoing boolean not null default false, ended_at timestamptz, ended_by bigint,
  import_key text unique,              -- events.key 格納（冪等）
  reporter_id bigint references staff(id),   -- 移行分の夜勤は null 許容
  rev/監査列/soft delete列 同上 )

-- 既読（1行=1職員×1申し送り）
note_reads ( note_id bigint references notes(id), staff_id bigint references staff(id),
  read_at timestamptz not null default now(), PK (note_id, staff_id) )

-- 外出・外泊
outings ( id bigint identity PK, resident_id bigint not null references residents(id),
  kind text not null check (kind in ('outing','overnight')),
  start_on date not null, start_at time, end_on date, end_at time,  -- 帰着未定=null
  companion text, note text, recorded_by/rev/監査列/soft delete列 同上 )

-- app_settings … 0009 流用。★追加キー: 'native_input_enabled'（切替日Dの機能フラグ・監査#4）
-- import_days ( source, day, imported_at, src_rows, inserted, updated, skipped,
--   native_skip, unmatched, PK(source,day) )   ★列拡張（監査#4/#9）
-- master_sync_log ( id, synced_at, source, before_count, after_count, added, deactivated, renamed )
```

**索引一覧**（すべて `where deleted_at is null` 部分索引、note_reads除く）:
- 各業務表: `(note_on desc, id desc)` / `(measured_on desc, id desc)` / `(meal_on desc, id desc)` / `(taken_on desc, id desc)` / outings `(start_on desc, id desc)` — タイムライン用
- 各業務表: `(resident_id, 日付列 desc)` — 個人カルテ用。**notes にも `(resident_id, note_on desc)` を追加**（監査#12受諾。関連申し送り・記入者絞込の全域スキャン防止）
- notes: `gin (body gin_trgm_ops)` — 検索用
- **db.ts 規約: 全読取クエリに `.is('deleted_at', null)` を機械付与**（部分索引の使用条件。監査#12）。ラッパー関数で強制し、素の `supabase.from()` を db.ts 外から呼ばない

updated_at トリガ（0001 の `set_updated_at()` 踏襲）で `new.rev = old.rev + 1` も実行。

## 2. データ量とクエリ計画

蓄積見積り（変更なし・チャンクサイズはストレージ非依存）: 10年で合計約240万行・**約340MB**（無料枠500MBの約7割）。水分150行/日・既読10人/件は**仮定・未実測**。最大の note_reads（約125MB）は180日超の定期削減（要承認）で半減可。

**チャンクは初期10日・追加10日に統一**（監査#7受諾。要求原文「直近10日分」に整合）。10日チャンクの行数再計算:

| 系列 | 行/10日チャンク |
|---|---|
| notes | ≈340 |
| vitals | ≈400 |
| meals | ≈1,000 |
| fluid_intake | ≈1,500 |
| outings | ≈20 |
| 合計 | **≈3,260行 ≈ 300KB JSON（gzip後 約50KB・概算）** |

- **①タイムライン**: RPC **`timeline_chunk(p_from date, p_to date, p_staff_id bigint)`** 1発で notes（`read_count`・`my_read` 畳み込み済み）＋vitals＋meals＋fluid＋outings＋import_days を返す（監査#5受諾。素朴実装の note_reads 素通し≈3,400行/チャンクを排除）。`security invoker`・`revoke execute from anon` ＋ `grant execute to authenticated`。全表 index scan、サーバー実行 <20ms、E2E 目標 **初期表示 p95 500ms・追加チャンク p95 400ms**（実測前の目標値。Subagent 3 の検収基準）。無限スクロールは日付境界 keyset（`p_to = 最古取得日 - 1`）。offset 不使用。
- **②個人カルテ**: `(resident_id, 日付列 desc)` 索引。折れ線は期間指定必須（既定90日・`.limit(1000)` ガード）。E2E 目標 p95 300ms。
- **③検索**: §3。目標 p95 500ms。
- **未読バッジ**: `notes where not exists(note_reads…) and note_on >= 直近30日` の count（`(note_on desc)` 索引で足りる。全域走査しない）。
- **全件ロード禁止の担保**: 全クエリを `src/lib/db.ts` に集約。「日付レンジ or resident_id＋limit の無いクエリを書かない」規約＋既定 `.limit(2000)` 上限。
- 性能実測は M-026 準拠・**合成データ10年相当規模（notes 13万・note_reads 130万以上）**で①②③を計測。

## 3. 検索設計（変更なし・要旨）

- 利用者名・かな: 33名スナップショットをメモリ保持しクライアント内0msインクリメンタル。
- 申し送り本文: `pg_trgm` GIN＋`ilike`。日本語2文字クエリは索引が効かない既知の弱点（確信度: 高）だが、notes は10年12.4万行→seq scan で実用域の可能性が高い。**要実測**。超過時のみ pgroonga 昇格（新規プロジェクトでの有効化可否は**要実測**）。両方不可なら「取得済みウィンドウ内クライアント検索＋期間指定サーバー検索」の2段へ縮退。
- クライアント: debounce 250ms・最小2文字・`order by note_on desc limit 50`・既定「直近90日」。

## 4. 認証・RLS・既読主体・PII

**認証は A案（施設共有アカウント）を推奨**（比較表は元設計から変更なし: 運用負荷ほぼゼロ・共有タブレット実態に整合・B案は実質Aに退化）。staff.auth_uid 列を最初から定義してあるため将来Bへの移行はスキーマ変更ゼロ。

**操作職員（actor）設計 — 監査#2受諾・新設**:
- **起動時＋シフト交代時に職員ピッカー**（active=true の staff から選択）を表示。選択値は localStorage `cl_actorStaffId` に **staff_id 数値のみ**保持（氏名・トークンは保持しない）。
- 復元時は staff スナップショットとの**ホワイトリスト照合**。不在・inactive・不正値は再選択画面へフォールバック（dev-principles 原則11 の既知値照合と同型）。
- `recorded_by`・`note_reads.staff_id`・`p_staff_id` はすべてこの actor 値を使う。**既読付与は明示操作（本文展開タップ or 既読ボタン）に限定**し、一覧描画から書かない（multi-device-sync 原則9）。
- 制約の明示: 共有アカウントゆえ actor は**自己申告**であり証跡性は弱い。この限界は承認時に本人へ明示し、認証方式の裁定と一体で確定する。

RLS（全表共通・0008 流儀）: `read_auth`（select・authenticated）／`write_auth`（insert/update・authenticated）／**delete ポリシーなし**。anon はポリシー不存在で全拒否（pg_policies 照合で検証）。RPC も authenticated 限定（§2）。
PII: 実名ゼロ・`VITE_*` に施設情報を置かない（0009 実測知見）・GAS トークンは localStorage 手入力のみ・console に応答本文を出さない（根拠: `/Users/Takeshi/Claude/Projects/kitchen-app/.claude/worktrees/remote-control-65a07c/src/lib/wsClient.ts` 規約1・3）。

## 5. 書込・同期設計

- **粒度**: 1レコード=1測定/1食/1飲水/1件。独立編集値の同居禁止（multi-device-sync 原則3。主食/副食は同一人の同時入力＝同居可）。
- **upsert 全廃 — 監査#3受諾**: PostgREST の upsert（`on_conflict`）は部分uniqueインデックスを指定できず失敗する見込み（確信度: 高・未実証）。db.ts の保存は**「グリッド表示時に既存行の id/rev を把握 → id無し=insert（unique違反 23505/409 は他端末先行の証拠→再読込して update に切替）／id有り=update `.eq(id).eq(rev)`」**に統一。部分unique はDB防波堤として残す。**実装前スパイクで 23505 経路を実証する**（M-029）。
- **版整合（M-039）**: rev はDBトリガで自動加算。update は `.select('rev')` で新版数を観測、0行=競合→再読込UI。全書込経路の新版数返却を「トリガ＋db.ts 単一経路」で構造的に担保。捨てた案: LWW（申し送り訂正合戦で無言消失→原則5違反）。
- **空上書き保護**: update ペイロードは編集列のみ（部分更新）。body 空文字は DB check で拒否。削除は確認ダイアログ→soft delete。
- **Realtime**: insert/update を無フィルタ購読（約500イベント/日）。表示ウィンドウ内ならパッチ・外は無視。受信値は型検査（原則10）。
- **オフラインキュー**: localStorage プレフィクスは **`cl_` に統一**（監査#8。元設計の `clg_` 廃止）。キュー内容は resident_id・数値・本文のみ（氏名なし）。完了判定は新 rev 観測時（原則6）。失敗は指数バックオフ再送。キュー消去は保全ゲート後のみ（原則8）。
- **401復帰経路 — 監査#11受諾**: db.ts 仕様として「401検知→**キューを保全したまま**再ログイン画面へ→ログイン成功で自動再送」を明記。エラー文: 「保存できていません（ログインの有効期限切れ）。再ログインすると自動で送信されます。入力は消えていません」。
- **下書き — 監査#8受諾**: 送信失敗キューは保持必須（原則4優先）。**入力途中下書きは「送信成功または明示破棄で即削除＋24時間期限」付き保持を推奨案**とし、共有iPad平文残留リスクとのトレードオフを承認時に1点確認する。

## 6. マスタ連携（変更なし・要旨）

クライアント pull 型（wsClient.ts 前例）。起動時＋TTL60分で getRoster（現場トークン・最小射影: id/name/kana/room/gender/careLevel）＋ staff（name のみ）→ スナップショットへ upsert（residents/staff は部分uniqueでなく通常uniqueのため upsert 可・監査#3の対象外）。照合は source_id→氏名正規化比較（M-034 二重照合）、大幅不一致は `needs_review=true` 保留。増減両方向を master_sync_log に計数（M-024）。書込アクションのコードパスを作らない。GAS読取クォータ +72〜150回/日（1%未満・概算未実測）。

## 7. 移行設計

- **取込元は蓄積スプシ**（パース済み・回帰テスト付き）。`apiEvents`/`apiMeasures`（from/to 指定・上限150日/呼）で遡りページング。根拠: `/Users/Takeshi/Claude/Repos/gas-sync/moushiokuri-viewer/コード.js` L1596-1602（期間丸め）・L1609・L1710。events の列は `key,date,facility,shift,row,residentRaw,residentName,kind,timeHM,body,reporter,…`（同 L127-130 実測）— **facility→notes.facility、kind→notes.category に格納**（監査#9受諾。列単位の落丁も M-024 計数対象に含める）。
- **importer は直結Postgres接続 — 監査#6受諾**: PostgREST 経由では複数行トランザクション不可のため、Mac ローカル Node スクリプト＋`pg` ライブラリ＋**session pooler 直結**（接続文字列は環境変数のみ・リポ外）で期間単位トランザクション。計数不一致時は rollback。`import_key` unique で冪等。
- **並走期間の衝突規則 — 監査#4受諾**: **切替日Dまで care-log の入力UIを機能フラグ（app_settings.native_input_enabled）で封鎖**（閲覧・検証専用）。万一のネイティブ行混入に備え、importer は import_key 無しの既存 (resident, day, slot) を **native_skip** として計数し上書きしない。計数式: **源泉 = inserted + updated + skipped(墓標) + native_skip + unmatched** — 不成立ならその期間を rollback。
- **「記録なし」と「未取込」の区別**: import_days に行あり=「表示（0件=記録なし）」、なし=「未取込」バッジ（取込GAS の ingestedDates 思想を継承。同 L1540-1542: 保持は直近200日のみ）。D以降はネイティブ入力＝0件は記録なし。
- **データ流れ**:

```
職員 ─手入力→ 現行スプシ ─取込GAS(30分毎)→ 蓄積スプシ ─→ 申送ビューア（現行系・無変更）
                                  └─ importer(手動・直結TX・冪等) → Supabase ─→ care-log（〜D: 閲覧・検証専用）
切替日D（app_settings で解禁・本人判断）以降: 職員 ─care-log UI→ Supabase（正本）
※D以前=import_key あり／D以降=null で出自判別可能
```

- 日次AI抽出はデータ源が現行スプシのまま並走中は無影響。切替後は別課題（本人判断）。
- **外出・外泊（監査#10・DB側責務のみ）**: outings と meals.status='out' は**自動連動させない**（片方の訂正が他方を無言変更する経路を作らない。原則1）。表示上の併記は Subagent 2 のタイムライン設計（日付ヘッダチップ・記録ハブ導線）に委ねる。timeline_chunk は outings を返却済み（§2）。
- **出勤者ブロック（監査#13受諾）**: 要求5項目の**スコープ外と明示裁定**。切替後はワースケ/シフトアプリ参照を既定とし、承認時に本人確認。必要な場合の最小受け皿は `daily_notes (day date PK, body text, rev, 監査列)` 1表を追加（app_settings への日次上書きは履歴が残らないため不採用）。

## 8. バックアップ・復元（§新設 — 監査#1受諾）

Supabase 無料枠に自動バックアップは無い（確信度: 高）。介護記録の正本を置く以上、dev-principles 原則4 の必須要件として以下を初期リリースに含める:

- **夜間 pg_dump**: Mac の launchd で毎日 03:30 に `pg_dump --format=custom`（session pooler 直結・sslmode=require）。接続文字列は `~/.pgpass` またはキーチェーン（リポ外・環境変数経由）。
- **保存先・世代**: `~/Claude/Backups/care-log/`（リポ外・Time Machine 対象）。**日次14世代＋月次12世代**をスクリプトでローテーション。
- **死活監視**: 最新バックアップが48時間超なら通知（launchd 成否ログ＋鮮度チェック）。無料枠の自動一時停止（非アクティブ時）もこの監視で検知できる。
- **復元試験**: ローカル PostgreSQL（Homebrew/Docker）へ `pg_restore` し行数照合。初回リリース時に1回＋四半期1回。**本番プロジェクトへの復元リハーサルはしない**（M-026 同型）。
- **手順書**: 復元手順（どの世代を・どこへ・何を照合するか）を README に記載。
- 未検証: pg_dump クライアントと Supabase の PostgreSQL メジャーバージョン整合（Homebrew libpq の版指定）。実装時に実測。

## 9. リスクと代替案（上位3・改訂）

1. **日本語2文字検索で pg_trgm 索引不使用**（可能性: 高／影響: 中）→ seq scan 実測→超過時のみ pgroonga →不可なら2段検索に縮退。
2. **note_reads 肥大で500MB接近**（可能性: 中／影響: 中・10年後）→ 180日超削減 or Pro。分離済みのため他表に波及しない。
3. **無料枠2プロジェクト目不可**（可能性: 低／影響: 高）→ kitchen-app 同一プロジェクト内の別スキーマ `carelog`＋スキーマ限定RLS（public 無干渉）。GAS+スプシ回帰は不採用。

---

## 監査対応（13件の裁定一覧）

| # | 裁定 | 反映箇所・補足 |
|---|---|---|
| 1 | **受諾** | §8新設。launchd 夜間 pg_dump・14+12世代・ローカル復元試験・README 手順。初期リリースの必須要件に格上げ |
| 2 | **受諾** | §4に actor 設計新設。`cl_actorStaffId`（数値のみ・ホワイトリスト照合・不正値は再選択）。既読は明示操作限定。自己申告の限界を承認時に明示 |
| 3 | **受諾** | §5。upsert 全廃→id把握 insert/update 分岐＋23505→再読込 update。部分unique は防波堤として残置。実装前スパイクで実証（確信度: 高・PostgREST の on_conflict は部分uniqueを指定できない） |
| 4 | **受諾** | §7。切替日Dまで機能フラグで入力封鎖。native_skip 計数を追加し計数式を拡張。D は app_settings 保存 |
| 5 | **受諾** | §2。RPC timeline_chunk 新設（read_count/my_read 畳み込み・6系列1往復・invoker・authenticated 限定） |
| 6 | **受諾** | §7。importer は pg ライブラリ＋session pooler 直結でトランザクション。不一致 rollback |
| 7 | **受諾** | §2。初期10日・追加10日・RPC1発に統一。チャンク行数表を10日で再計算（≈3,260行・gzip後約50KB）。E2E目標を初期500ms/追加400msに再設定 |
| 8 | **受諾** | §5。キュー保持必須・下書きは「成功/破棄で即削除＋24h期限」案で承認時1点確認。プレフィクス `cl_` に統一 |
| 9 | **受諾** | §1・§7。notes に facility/category 追加。実物照合済み（`コード.js` L127-130 の EVENTS_HEADERS に facility・kind を確認）。列落丁も計数対象 |
| 10 | **部分受諾** | UI動線（ヘッダチップ・記録ハブボタン）は Subagent 2 の管轄のため本設計では定めない。DB側責務として「meals.status='out' と自動連動しない」を §7 に明記し、timeline_chunk が outings を返すことで表示要件の下地は提供済み |
| 11 | **受諾** | §5。401→キュー保全→再ログイン→自動再送を db.ts 仕様に明記。エラー文言も指定どおり採用 |
| 12 | **受諾** | §1。`(resident_id, note_on desc) where deleted_at is null` 追加＋`.is('deleted_at', null)` 機械付与規約 |
| 13 | **受諾** | §7。スコープ外と明示裁定＋ワースケ/シフト参照を既定。必要時の最小案は app_settings でなく `daily_notes` 1表（監査修正案の app_settings 案は日次上書きで履歴が残らないため、この点のみ実装形を変更） |

## 推奨アクション

1. 本改訂版を Subagent 2（timeline_chunk の返却形・actor ピッカー・入力封鎖フラグが前提）・Subagent 3（§2 の目標値と §8 のバックアップ検証を検収基準に追加）へ入力
2. 承認後の実装第一歩: **スパイク2件**（①部分unique×insert/23505 経路の実証 ②pgroonga 有効化可否）→ `0001_init.sql`（冪等DDL＋RLS＋rev トリガ＋timeline_chunk）→ 合成10年データ→①②③実測 → §8 バックアップ整備

## 残課題・要確認

- 水分の運用回数（仮定150行/日・未実測）／既読の平均閲覧者数（仮定10人/件）
- pg_trgm 2文字クエリ・pgroonga 有効化可否・PostgREST 23505 経路（いずれも要実測／スパイク）
- 既読行の180日超削減の承認可否（不可なら Pro 前提のコスト判断）
- 現場トークンを care-log 端末へ配る運用の可否
- 蓄積スプシの遡及範囲（ingestedDates は直近200日保持。それ以前は10日ファイル実物の残存に依存・未検証）
- 承認時の確定4点: 認証方式（A案推奨）＋actor 自己申告の許容／下書き24h保持の可否／出勤者ブロックのスコープ外裁定／切替日Dの運用
- pg_dump のバージョン整合・バックアップ保存先 `~/Claude/Backups/care-log/` の可否（README.md のフォルダ規律との整合は本人確認・未検証）
