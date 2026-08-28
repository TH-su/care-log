# スプレッドシート模倣UI 実装契約（凍結・全ビルダー共通）

現行スプシ（申し送り／バイタル1階／バイタル2階／食事量の4タブ）を、アプリ上で**見た目・操作感ごと**置き換える。
本文書は 2026-08-28 に実物を画面で確認して採取した実測値に基づく。**推測で寸法を変えない。**

既存の契約は `docs/design/contracts.md` が引き続き有効。本文書はそれに**追加**するもので、既存APIの変更はしない。

---

## 0. 確定済みの方針（管理者裁定・2026-08-28）

| 論点 | 裁定 |
|---|---|
| 文字サイズ | **スプシ完全一致（13px）を既定**とし、画面上部に 100%/125%/150% の倍率切替を置く。端末ごとに記憶する |
| 日付の並び | **スプシと同じ横並び**（バイタル4日・食事11日）。居室と氏名の列は左に固定して常に見える |
| 起動時の画面 | **スプシ風日報を既定**。既存タイムラインは残す（廃止しない） |
| 申し送りの入力 | **セルに直接書き込む**（スプシと同じ操作感） |
| 付帯ブロック | 外出者・外泊者・発熱者・他症状者・出勤者を**全部作る**。「＋追加」で行を増やせる。**0件のブロックは畳んでスペースを取らない** |
| 行の色 | **後から好みの色に変えられる**。既定は ピンク=予定 / 黄=全体連絡 |
| 既存の入力画面 | バイタル一括・食事一括（キーパッド式）は**両方残す**（小さい画面用） |
| 細部の再現 | 「↓16時以降の記録」区切り・バイタル「再検」枠・日付リンク を再現する（食事の「予備」行は作らない＝入居者マスタ連動で不要） |

---

## 1. スプシ実測値（100% 表示時の基準。CSS 変数で持つ）

`src/styles/sheet.css` に定義し、倍率は `--sheet-zoom`（1 / 1.25 / 1.5）を掛けて算出する。

```
--sheet-font:     13px   /* スプシ 10〜11pt 相当。倍率で 13 / 16.25 / 19.5 になる */
--sheet-row-h:    22px   /* バイタル・食事の1行 */
--sheet-row-h-note: 23px /* 申し送りの1行（本文が長い行は内容に応じて伸びる） */
--sheet-head-h:   24px   /* 見出し行 */

/* 列幅（バイタル） */
--w-room:   60px   --w-name: 110px  --w-temp: 60px
--w-sys:    60px   --w-dia:   60px  --w-pulse: 50px  --w-spo2: 65px

/* 列幅（食事） */
--w-room-m: 68px   --w-name-m: 118px  --w-meal: 30px  /* 主食・副食それぞれ */

/* 列幅（申し送り） */
--w-datelink: 117px  --w-target: 138px  --w-reporter: 60px
```

配色（現行スプシの実測。**トークンに寄せてダークモードでも読める色へ解決する**）

| 用途 | ライト | 備考 |
|---|---|---|
| 見出し帯（バイタル・食事） | `--c-surface2` ＋ 下罫線 | スプシは薄灰 |
| 朝 | 文字 `--c-danger` 系 | スプシは朝＝赤文字・ヘッダ薄桃 |
| 昼 | 文字 `--c-ok` 系 | スプシは昼＝緑文字・ヘッダ薄緑 |
| 夕 | 文字 `--c-ink` | スプシは夕＝黒文字 |
| しきい値超過 | `types.ts` の Level に従う（記号 ↑↑ ↑ ↓ ↓↓ を必ず併記） | 色だけで意味を伝えない |
| 行の色 pink/yellow/blue/green/orange | `--c-*-bg` 系の淡色 | ダークでは同じ意味の暗色へ |

**罫線は 1px。セルは 0 マージンで詰める（スプシの密度を再現する）。**

---

## 2. 画面とルーティング

| パス | 画面 | 位置づけ |
|---|---|---|
| `/` | **日報シート**（DailySheetPage） | 既定。現行スプシ「申し送り」タブの完全再現 |
| `/sheet/vitals` | **バイタル一覧**（VitalsSheetPage） | 現行スプシ「バイタル1階/2階」タブ |
| `/sheet/meals` | **食事一覧**（MealsSheetPage） | 現行スプシ「食事量」タブ |
| `/karte` `/karte/:id` | 個人カルテ | 変更なし |
| `/more` | **その他**（MorePage・新規） | 検索・タイムライン・記録（キーパッド式）・設定への入口 |
| `/timeline` | タイムライン | **既存 TimelinePage をこのパスへ移す**（中身は変更しない） |
| `/search` `/settings` `/record/*` | 既存 | 変更なし |

ナビゲーション
- `<1024px` 下部タブ5つ: 日報 / バイタル / 食事 / カルテ / その他
- `≥1024px` 左レール8つ: 日報 / バイタル / 食事 / カルテ / 検索 / タイムライン / 記録 / 設定

**既存画面は1つも削除しない**（dev-principles 原則1）。`LS.view` の既知値に `daily` `vitalsSheet` `mealsSheet` `more` を足す。

---

## 3. src/lib/db.ts に追加する API（他ビルダーはこれを import する）

```ts
/** 日報1日分をまとめて取る（申し送り・付帯ブロック・出勤者を1往復で） */
fetchDailyReport(dayIso: string, staffId: number | null): Promise<DailyReport>

export interface DailyReport {
  day: string
  notes: Note[]          // 全 shift。画面側が shift と after16 で仕分ける
  outings: Outing[]      // その日に在るもの（start_on <= day <= end_on または end_on is null）
  observations: Vital[]  // kind='observation'（発熱者）
  symptoms: Vital[]      // kind='symptom'（他症状者）
  attendance: Attendance[]
  importDay: ImportDay | null
}

/** 一覧（横並び）用。期間 × 全利用者のバイタルを取る */
fetchVitalsSheet(fromIso: string, toIso: string): Promise<Vital[]>
/**
 * 一覧（横並び）用。期間 × 全利用者の食事と水分を取る。
 * 水分は RPC meals_sheet_fluids（0005）で「1名1日 = 1行（合計＋内訳）」にまとめて受け取り、
 * db.ts が従来どおりの1回=1行へ戻して返す。**呼び出し側が受け取る形は変わらない**（内訳も落とさない）。
 * 食事と水分は取得上限の枠を分ける（同じ定数を共有しない）。
 */
fetchMealsSheet(fromIso: string, toIso: string): Promise<{ meals: Meal[]; fluids: FluidIntake[] }>

/** 申し送りの部分更新（セル直接編集用。送った項目だけ書き、他は温存する） */
updateNoteFields(id: number, rev: number,
  patch: Partial<Pick<Note, 'body' | 'resident_id' | 'importance' | 'color' | 'after16' | 'occurred_at' | 'reporter_id' | 'role_tags' | 'shift'>>
): Promise<Note | Conflict | Queued>

/**
 * バイタル（発熱者・他症状者を含む）の追加。kind を明示する（insertVital のエイリアスでよい）。
 * kind='routine' 以外は自然キーが無い（同じ人の同じ日に複数行を書ける）ので、
 * 端末生成の冪等キー client_key を必ず付ける＝キューの再送で同じ記録が2行にならない。
 * 0004 の uq_vitals_client_key に載る。定時（routine）には付けない（uq_vitals_routine_day が担う）。
 */
insertVitalKind(v: Omit<Vital, 'id' | 'rev'>): Promise<Vital | Queued>

/**
 * 出勤者の登録。rows に有る人を追加・更新し、**baseline に有って rows に無い人だけ**取り消す。
 * **その日の一覧を丸ごと置き換えるのではない**（`rows=[]` は「baseline の人を全員取り消す」であって
 * 「その日の出勤者を全員取り消す」ではない）。baseline に無い行は、この端末の読み込み後に
 * 他端末が足した行かもしれないので触らない（未知の行は消さない＝和集合側へ倒す）。
 * その日の全員を取り消したい時は、読み込み時の staff_id を全部 baseline に渡す。
 * baseline は必須引数（省略すると取り消しが1件も起きないまま成功して見える無言の no-op になるため）。
 * 呼び出し側は fetchDailyReport で受け取った attendance の staff_id をそのまま渡す。
 */
saveAttendance(
  dayIso: string,
  rows: { staff_id: number; role: 'manager' | 'staff'; sort: number }[],
  options: { baseline: number[] },
): Promise<void>
```

**規律（既存のまま）**: `.is('deleted_at', null)` と limit を機械付与。upsert は使わない。更新は rev 照合。
通信失敗は既存の永続キューへ退避（`enqueue`）。**新 API も必ずこの経路に乗せる**。
自然キー（部分unique索引）を持たない insert には端末生成の冪等キー `client_key` を必ず付ける
（notes / fluid_intake / outings ＋ **定時以外のバイタル**）。

**前提マイグレーション**: `0003_sheet_ui.sql` → `0004_vitals_client_key.sql`（vitals.client_key）
→ `0005_meals_sheet_fluids.sql`（RPC meals_sheet_fluids）の順で適用済みであること。
未適用のまま動かすと、定時以外のバイタルの保存と食事一覧の読み込みが失敗する。

---

## 4. src/components/sheet.tsx（新規・共通部品）

```tsx
/** 倍率つきのシート枠。子はテーブル。横スクロールはこのコンポーネントが持つ */
SheetFrame({ children, className? })

/** 表示倍率の切替（100/125/150%）。LS.zoom に保存し、CSS変数 --sheet-zoom を書き換える */
ZoomBar()

/** スプシ風セル。編集可能なら onCommit を渡す（Enter/Tabで確定・Escで取消） */
SheetCell({ value, onCommit?, align?, width?, level?, tone?, placeholder?, multiline?, ariaLabel })

/** 行の色を選ぶ小さなボタン群（NoteColor + 「色なし」） */
ColorPicker({ value, onChange, ariaLabel })

/** 0件のときは見出しだけの1行に畳むブロック。「＋追加」で行を増やす */
CollapsibleBlock({ title, count, children, onAdd, addLabel, defaultOpen? })
```

- `SheetCell` は **セル自体がボタン**（tabIndex）で、クリック/Enter で入力に切り替わる。
- 入力中は `input`/`textarea` をその場に描画。確定で `onCommit(value)`、Esc で破棄。
- **タップ領域（2026-08-28 実装時に裁定を確定）**: セルの高さは 22px でスプシと同じ。`SheetCell` は擬似要素で
  縦の当たり判定を**下方向にだけ**広げる（`TimelinePage` の `NAME_HIT` と同じ手法）。上へ広げないのは、
  上方向の拡張がツリー順で前の行の操作を奪い「押した行の1つ上が反応する」取り違えを生むため。
  - **22px ピッチの連続行に全行 44px を配ることは幾何学的に不可能**（総面積が2倍要る＝必ず隣の行から奪う）。
    したがって実効 44px になるのは「直下に操作対象が無い場所」（表・ブロックの最終行など）に限られる。
  - 詰まった行で 44px が要る場面は、**表示倍率 200%**（行高 22px × 2 = 44px）で満たす。既定は 100%（スプシ完全一致）。
    介護現場要件（タップ44px）は「その密度を選べること」で満たし、密度そのものは職員が選ぶ。
  - `overflow: hidden`（Tailwind の `truncate`）を当たり判定を持つボタン自身に付けない。`::before` が切り取られて拡張が死ぬ。
    省略は内側の span に持たせる。
  - 行が詰まっていて広げられない場合は、`title` 属性ではなく `aria-label` で読み上げを担保する。
- しきい値の色は `level` を渡すと `LEVEL_MARK` の記号を自動で併記する。

---

## 5. DailySheetPage（現行スプシ「申し送り」タブの再現）

上から順に。**0件のブロックは見出し1行に畳む**（`CollapsibleBlock`）。

```
[日付バー]  ‹ 8/28（金） ›  ＋ 日付リンク（当月の日を横に並べる・スプシ左端の再現）  ＋ ZoomBar
[ヘッダ]    施設名（app_settings.facility_name）／「日勤・夜勤日報」／日付（大きく）
[出勤者]    施設長 [職員ピッカー] ／ 出勤者 [＋追加] で職員チップを並べる
[外出者 n名]  氏名 | 外出先 | 出発時刻 | 〜 | 到着時刻 | 付添        [＋追加]
[外泊者 n名]  氏名 | 宿泊先 | 出発日時 | 〜 | 到着日時 | 付添        [＋追加]
[発熱者 n名]  氏名 | (時 KT SpO2 BP P) × 3セット                    [＋追加]
[他症状者 n名] 氏名 | 時 KT SpO2 BP P | 症状                        [＋追加]
[日勤申し送り] 対象 | 本文 | 記入者   ← 行の色を選べる            [＋追加]
   ── ↓16時以降の記録 ──（黒帯・区切り。ここより下は after16=true）
[デイサービス] 対象 | 本文 | 記入者                                  [＋追加]
[夜勤申し送り] 対象 | 本文（記入者欄なし＝現行運用どおり任意）        [＋追加]
```

- 対象セル: 利用者ピッカー（`ResidentPickerModal`・`allowAll` で「スタッフへ（全体）」）
- 本文セル: `multiline`。**長文は行が伸びる**（スプシと同じ。clamp しない）
- 記入者セル: 職員ピッカー。既定は現在の操作者
- 行の色: 行頭の小さな色ボタン（`ColorPicker`）。既定は色なし。**予定を書くならピンク、全体連絡なら黄**を候補の先頭に置く
- 「＋追加」で空行を1行足す（**保存は本文が入った時点**。空行は送信しない＝空データを作らない）
- 発熱者・他症状者は `vitals`（kind='observation' / 'symptom'）に保存する。**同じ人の同じ日を複数行**書ける
  （＝自然キーが無いので、insert には冪等キー `client_key` を付ける。§3 の `insertVitalKind` を参照）
- 既読・重要度・職種タグは行の右端に小さく置く（スプシには無いが既存機能を殺さないため）

---

## 6. VitalsSheetPage（現行スプシ「バイタル1階/2階」タブの再現）

```
[操作バー] フロア(1階/2階/全) | 日数(1/4/7/11) | ‹ 期間 › | ZoomBar
[表]
  居室 | 入居者名 ‖ 8/28(金)                        ‖ 8/27(木) ...
                  ‖ 体温 血圧(上) 血圧(下) 脈 SpO2 ‖ ...
  102  | 利用者A  ‖ 36.5  122      78       80  97  ‖ ...
  ...
[再検]  各日の下に再検枠（kind='recheck'）。空行は1行だけ出し、入力されたら次の空行が生える
```

- **居室・氏名の2列は position: sticky で左に固定**（スプシより見やすくする・裁定済み）
- 見出し行も sticky（上）
- セルは直接編集。`normalizeVitalInput`（既存）で「365」→36.5・全角→半角を通す
- しきい値超過は背景色＋記号。`VITAL_RANGE` 外はインライン警告を出して保存しない
- 保存は**1名1日単位**（既存 `insertVital`/`updateVital`。routine の部分unique に載る）
- 日付は**新しい日が左**（スプシは古い日が左だが、当日を最初に見るため。※スプシとの差分はここだけ。管理者裁定が必要になったら日付順の切替を足す）

---

## 7. MealsSheetPage（現行スプシ「食事量」タブの再現）

```
[操作バー] フロア | 日数(既定11) | ‹ 期間 › | ZoomBar
[表]
  居室 | 入居者 ‖ 8/28(金)                    ‖ 8/27(木) ...
               ‖ 朝    | 昼    | 夕   | 水分 ‖
               ‖ 主 副 | 主 副 | 主 副| ml   ‖
  102  | 利用者A‖ 10 10 | 8  8  | 9 10 | 650  ‖
```

- 主食・副食は 0〜10 の直接入力（セルをタップ→数字キーパッドは出さず、その場で数値入力。既存の一括画面がキーパッド担当）
- 欠食は `status`（外出/入院/拒食）を選ぶと 2セットにまたがって「外出」等を表示（スプシと同じ見せ方）
- **水分は日合計の列を1つ足す**（スプシには無い新設項目。タップで内訳と加算チップ）。
  取得は1名1日にまとめた形（§3 `fetchMealsSheet`）。既定11日でも取得行数は 人数 × 日数 に収まる
- 朝＝赤系文字・昼＝緑系文字・夕＝通常（スプシの色分けを踏襲。**記号ではなく列見出しで区別がつくので色は補助**）
- 低摂取（`isLowIntake`）は淡い背景＋「▲」

---

## 8. 守るべきこと（既存契約の再掲・違反はレビューで差し戻す）

1. 既存画面・既存APIを削除・改名しない。ルート追加と `TimelinePage` の**パス変更のみ**
2. Tailwind の arbitrary value（`text-[13px]`・`bg-[#…]`）禁止。寸法は `sheet.css` の CSS 変数を使う
3. 個人情報をコード・コメント・placeholder・console に書かない
4. `supabase.from()` の直呼びは db.ts / gasClient.ts のみ
5. 入力封鎖中（`native_input_enabled=false`）は**編集を無効化**し理由文を出す。閲覧は可能
6. 3状態（ローディング／エラー／空）を全画面に置く
7. 破壊的操作（行の削除）は確認 or Undo。空行の自動削除は「保存していない行」に限る
