-- =====================================================================
-- care-log 初期スキーマ（テーブル11 = 業務8＋設定1＋運用2）
--
-- 適用方法: Supabase ダッシュボード > SQL Editor にこのファイルを貼り付けて実行する。
--           全体が冪等（create ... if not exists / drop policy if exists → create）なので
--           途中で失敗して再実行しても、既にできているものは作り直されない。
--
-- 設計の正本: docs/design/db-design.md §1・§4／docs/design/contracts.md「supabase/migrations の契約」
-- 流儀の踏襲元: kitchen-app の 0001_init.sql（identity PK・set_updated_at・do $$ ループ）／
--               0008_restrict_read_to_authenticated.sql（read も authenticated 限定）／0009_app_settings.sql
--
-- データ保護の骨格（dev-principles 原則4）:
--   1. delete ポリシーを1つも作らない ＝ anon/authenticated からの物理削除が構造的に不可能。
--      削除は deleted_at / deleted_by による soft delete のみ（アプリは確認ダイアログ or Undo を挟む）。
--   2. 更新は before update トリガで rev を必ず +1 する。クライアントが rev を送っても無視される
--      （版数照合を「書く側の善意」に依存させない）。
--   3. 部分unique（定時バイタル・食事コマ）は二重登録に対する DB 側の防波堤。
--      アプリは upsert を使わず insert → 23505 なら再読込して update に切り替える。
--      自然キーを作れない表（申し送り・水分・外出）は端末が付ける冪等キー client_key を
--      unique にして同じ役目を持たせる（再送・2タブ同時送信でも1行に収束する）。
--
-- 個人情報: このファイルに実在の氏名・居室・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 拡張 ----------
-- 申し送り本文の部分一致検索（ilike）用。Supabase では拡張は extensions スキーマへ入れる慣例だが、
-- ローカル PostgreSQL（復元試験用）には extensions スキーマが無いため、有無を見て入れ先を切り替える。
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    if exists (select 1 from pg_namespace where nspname = 'extensions') then
      execute 'create extension pg_trgm with schema extensions';
    else
      execute 'create extension pg_trgm';
    end if;
  end if;
end $$;

-- =====================================================================
-- マスタ系スナップショット（正本は既存GAS。care-log からは書き戻さない＝読み取り専用の写し）
-- =====================================================================

-- 利用者（正本 = master.gs getRoster の最小射影）
create table if not exists residents (
  id           bigint generated always as identity primary key,
  source_id    text unique not null,               -- 正本側の利用者ID（照合キー）
  name         text not null,
  kana         text,
  room         text,
  gender       text,
  care_level   text,
  active       boolean not null default true,      -- 退居・非表示は false（行は消さない）
  needs_review boolean not null default false,     -- source_id 一致・氏名大幅不一致の保留印（M-034 二重照合）
  synced_at    timestamptz not null default now()
);

-- 職員（正本 = 統合GAS の staff。氏名が実質キー）
-- 氏名変更は「新行を足して旧行を active=false」にする＝過去記録の記入者表示が遡って変わらない。
create table if not exists staff (
  id        bigint generated always as identity primary key,
  name      text unique not null,
  active    boolean not null default true,
  auth_uid  uuid,                                  -- 将来の職員個別アカウント移行用の予約列（現運用では未使用）
  synced_at timestamptz not null default now()
);

-- =====================================================================
-- 業務表（すべて soft delete・rev 楽観ロック）
--   import_key: 蓄積スプシからの取込に対する冪等キー。ネイティブ入力は null。
--               D以前（取込）= 値あり／D以降（アプリ入力）= null で出自を判別できる。
--   raw_flags : 数値化できなかった原文の保持（「37度台」等を 0 に潰さないための逃がし）。
-- =====================================================================

-- バイタル（1行 = 1測定。定時・再検・経過観察を kind で統一）
create table if not exists vitals (
  id          bigint generated always as identity primary key,
  resident_id bigint not null references residents(id),
  measured_on date not null,                       -- 業務日付（JST・クライアントが明示指定する）
  kind        text not null check (kind in ('routine','recheck','observation')),
  measured_at time,
  temp        numeric(3,1) check (temp between 30 and 45),
  sys_bp      smallint     check (sys_bp between 40 and 300),
  dia_bp      smallint     check (dia_bp between 20 and 200),
  pulse       smallint     check (pulse between 20 and 250),
  spo2        smallint     check (spo2 between 50 and 100),
  note        text,
  raw_flags   jsonb,
  import_key  text unique,
  recorded_by bigint references staff(id),
  rev         int not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  bigint references staff(id)
);

-- 食事（1行 = 1食。主食・副食は同一人が同時に入力する値なので同居させてよい）
create table if not exists meals (
  id          bigint generated always as identity primary key,
  resident_id bigint not null references residents(id),
  meal_on     date not null,
  meal_slot   text not null check (meal_slot in ('breakfast','lunch','dinner','snack')),
  main_amount smallint check (main_amount between 0 and 10),
  side_amount smallint check (side_amount between 0 and 10),
  status      text     check (status in ('eaten','out','hospital','refused')),
  note        text,
  raw_flags   jsonb,
  import_key  text unique,
  recorded_by bigint references staff(id),
  rev         int not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  bigint references staff(id)
);

-- 水分（1行 = 1回の飲水。日合計はクエリ側で算出する＝合計欄を二重管理しない）
-- 移行元スプシに水分の列が無いため import_key は持たない（切替後の新規記録のみ蓄積される）。
create table if not exists fluid_intake (
  id          bigint generated always as identity primary key,
  resident_id bigint not null references residents(id),
  taken_on    date not null,
  taken_at    time,
  amount_ml   int not null check (amount_ml between 0 and 2000),
  kind        text,                                -- 茶・水・汁物 等（自由記述）
  client_key  text,                                -- 端末生成の冪等キー（下の unique 索引で二重登録を防ぐ。取込・旧データは null）
  recorded_by bigint references staff(id),
  rev         int not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  bigint references staff(id)
);

-- 申し送り（1行 = 1件）
--   resident_id null = 全体連絡（スタッフ宛）
--   ongoing + ended_at = 「※前シートからの再掲」手作業の置換（継続中は日をまたいでピン留めされる）
--   facility / category = 蓄積スプシ events の facility / kind の受け皿（取込で無言に落とさない）
--   reporter_id は移行分の夜勤（記入者欄なし）のため null 許容
create table if not exists notes (
  id          bigint generated always as identity primary key,
  note_on     date not null,
  shift       text not null check (shift in ('day','daycare','night')),
  facility    text,
  category    text,
  resident_id bigint references residents(id),
  role_tags   text[] not null default '{}'::text[],
  importance  text not null default 'normal' check (importance in ('normal','important','critical')),
  body        text not null check (body <> ''),    -- 空文字での上書きを DB 側で拒否する
  occurred_at time,
  ongoing     boolean not null default false,
  ended_at    timestamptz,
  ended_by    bigint references staff(id),
  import_key  text unique,
  client_key  text,                                -- 端末生成の冪等キー（下の unique 索引で二重登録を防ぐ。取込・旧データは null）
  reporter_id bigint references staff(id),
  rev         int not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  bigint references staff(id)
);

-- 既読（1行 = 1職員 × 1申し送り）
-- 付与は明示操作からのみ（表示・スクロールでは書かない＝multi-device-sync 原則9）。
create table if not exists note_reads (
  note_id  bigint not null references notes(id),
  staff_id bigint not null references staff(id),
  read_at  timestamptz not null default now(),
  primary key (note_id, staff_id)
);

-- 外出・外泊（帰着未定は end_on / end_at が null。帰着入力は時刻だけの部分更新）
-- meals.status='out' とは自動連動させない（片方の訂正が他方を無言で書き換える経路を作らない）。
create table if not exists outings (
  id          bigint generated always as identity primary key,
  resident_id bigint not null references residents(id),
  kind        text not null check (kind in ('outing','overnight')),
  start_on    date not null,
  start_at    time,
  end_on      date,
  end_at      time,
  companion   text,
  note        text,
  client_key  text,                                -- 端末生成の冪等キー（下の unique 索引で二重登録を防ぐ。取込・旧データは null）
  recorded_by bigint references staff(id),
  rev         int not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  bigint references staff(id)
);

-- =====================================================================
-- 設定・運用表
-- =====================================================================

-- アプリ設定（kitchen-app 0009 と同形の key/value 1行設定）
--   native_input_enabled … 切替日D の機能フラグ。'true' になるまでアプリの入力UIは封鎖（閲覧・検索・カルテは可）。
--                          値が無い場合はアプリ側が false 扱い（安全側）。
create table if not exists app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- 入力封鎖フラグの初期値。既に行がある場合は触らない（現場で 'true' にした後に再実行しても戻さない）。
insert into app_settings (key, value)
values ('native_input_enabled', 'false')
on conflict (key) do nothing;

-- 日別の取込台帳。行あり = その日は取込済み（0件なら「記録なし」）／行なし = 「未取込」。
-- 計数式: 源泉 src_rows = inserted + updated + skipped + native_skip + unmatched（不成立ならその期間を rollback）
create table if not exists import_days (
  source      text not null,                       -- 取込元の識別子（events / measures 等）
  day         date not null,
  imported_at timestamptz not null default now(),
  src_rows    int not null default 0,
  inserted    int not null default 0,
  updated     int not null default 0,
  skipped     int not null default 0,              -- 墓標（soft delete 済み行に当たった等）
  native_skip int not null default 0,              -- import_key 無し＝アプリ入力行を上書きしなかった件数
  unmatched   int not null default 0,              -- 利用者を特定できなかった件数
  primary key (source, day)
);

-- マスタ同期の増減両方向の記録（M-024: 減った件数も必ず数えて残す）
create table if not exists master_sync_log (
  id           bigint generated always as identity primary key,
  synced_at    timestamptz not null default now(),
  source       text not null,                      -- residents / staff
  before_count int,
  after_count  int,
  added        int,
  deactivated  int,
  renamed      int
);

-- =====================================================================
-- 索引
--   業務表は「where deleted_at is null」の部分索引に統一する。
--   ※読取クエリ側が .is('deleted_at', null) を付けないとこの索引は使われない（db.ts が機械付与する規約）。
-- =====================================================================

-- タイムライン（日付降順チャンク取得）
create index if not exists idx_notes_timeline   on notes        (note_on desc, id desc)     where deleted_at is null;
create index if not exists idx_vitals_timeline  on vitals       (measured_on desc, id desc) where deleted_at is null;
create index if not exists idx_meals_timeline   on meals        (meal_on desc, id desc)     where deleted_at is null;
create index if not exists idx_fluid_timeline   on fluid_intake (taken_on desc, id desc)    where deleted_at is null;
create index if not exists idx_outings_timeline on outings      (start_on desc, id desc)    where deleted_at is null;

-- 個人カルテ（利用者 × 期間）。notes にも付けて「関連申し送り」の全域スキャンを防ぐ。
create index if not exists idx_notes_resident   on notes        (resident_id, note_on desc)     where deleted_at is null;
create index if not exists idx_vitals_resident  on vitals       (resident_id, measured_on desc) where deleted_at is null;
create index if not exists idx_meals_resident   on meals        (resident_id, meal_on desc)     where deleted_at is null;
create index if not exists idx_fluid_resident   on fluid_intake (resident_id, taken_on desc)    where deleted_at is null;
create index if not exists idx_outings_resident on outings      (resident_id, start_on desc)    where deleted_at is null;

-- 二重登録の防波堤（アプリは upsert を使わず、23505 を「他端末が先に入れた」証拠として扱う）
create unique index if not exists uq_vitals_routine_day
  on vitals (resident_id, measured_on)
  where kind = 'routine' and deleted_at is null;

create unique index if not exists uq_meals_slot
  on meals (resident_id, meal_on, meal_slot)
  where deleted_at is null;

-- 自然キーを作れない表（申し送り・水分・外出）の二重登録の防波堤。
--   ・client_key は端末が1入力につき1つ生成する冪等キー。再送のたびに同じ値を送る。
--   ・null は複数行あってよい（Postgres の unique 索引は null どうしを重複扱いしない）。
--     取込データ・切替前の行は null のまま入る。
--   ・deleted_at で絞らない全体unique にする。削除済みの行が同じキーを押さえたままになるので、
--     退避していた再送が「もう届いている」ことを 23505 で判定できる（消えた行を作り直さない）。
-- 既に作成済みのデータベースへ後から足せるよう、列追加と索引作成を冪等に書く
-- （create table if not exists は既存テーブルに列を足さないため）。
alter table notes        add column if not exists client_key text;
alter table fluid_intake add column if not exists client_key text;
alter table outings      add column if not exists client_key text;

create unique index if not exists uq_notes_client_key   on notes        (client_key);
create unique index if not exists uq_fluid_client_key   on fluid_intake (client_key);
create unique index if not exists uq_outings_client_key on outings      (client_key);

-- 申し送り本文の部分一致検索（pg_trgm GIN）。
-- 演算子クラス名は拡張を入れたスキーマ側にあるため、実際の格納先を引いて修飾する
-- （extensions スキーマの有無で分岐した上の do ブロックに対応させる）。
do $$
declare ext_schema text;
begin
  if to_regclass('public.idx_notes_body_trgm') is null then
    select n.nspname into ext_schema
      from pg_extension e join pg_namespace n on n.oid = e.extnamespace
     where e.extname = 'pg_trgm';
    if ext_schema is null then
      raise exception 'pg_trgm 拡張が見つかりません。このファイル冒頭の拡張ブロックを先に実行してください。';
    end if;
    execute format(
      'create index idx_notes_body_trgm on notes using gin (body %I.gin_trgm_ops) where deleted_at is null',
      ext_schema);
  end if;
end $$;

-- =====================================================================
-- updated_at ＋ rev 自動加算トリガ
--   rev は old.rev + 1 で必ずサーバー側が決める。クライアントが rev を送っても採用しない。
--   更新側は .eq('rev', 取得時のrev) を付けるので、競合すると 0行更新（= 再読込を促す）になる。
--   ※ rev 列と updated_at 列を持つ業務表にだけ付ける（マスタ系・設定表には付けない）。
-- =====================================================================
create or replace function set_updated_at_rev() returns trigger as $$
begin
  new.updated_at = now();
  new.rev = old.rev + 1;
  return new;
end;
$$ language plpgsql;

do $$
declare t text;
begin
  foreach t in array array['vitals','meals','fluid_intake','notes','outings'] loop
    execute format('drop trigger if exists trg_updated_%I on %I;', t, t);
    execute format('create trigger trg_updated_%I before update on %I
                    for each row execute function set_updated_at_rev();', t, t);
  end loop;
end $$;

-- =====================================================================
-- RLS
--   ・read も authenticated 限定（0008 と同方針）。anon キーは公開バンドルに載るため、
--     匿名で読めると入居者の記録が無認証で外に出る。
--   ・書き込みは insert / update のみ。for all は delete を含んでしまうので使わない。
--   ・delete ポリシーは意図的に「作らない」。ポリシー不存在 = 該当操作は全拒否。
--     したがって anon は select/insert/update/delete のすべてが拒否される。
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'residents','staff','vitals','meals','fluid_intake','notes','note_reads','outings',
    'app_settings','import_days','master_sync_log'
  ] loop
    execute format('alter table %I enable row level security;', t);

    execute format('drop policy if exists "read_auth"   on %I;', t);
    execute format('drop policy if exists "insert_auth" on %I;', t);
    execute format('drop policy if exists "update_auth" on %I;', t);
    -- 参考: kitchen-app 0001 由来の名前が残っている場合に備えて落としておく（care-log では作らない）
    execute format('drop policy if exists "read_all"    on %I;', t);
    execute format('drop policy if exists "write_auth"  on %I;', t);

    execute format('create policy "read_auth"   on %I for select to authenticated using (true);', t);
    execute format('create policy "insert_auth" on %I for insert to authenticated with check (true);', t);
    execute format('create policy "update_auth" on %I for update to authenticated using (true) with check (true);', t);
  end loop;
end $$;

-- =====================================================================
-- Realtime（postgres_changes）
--   ・supabase_realtime パブリケーションに載っていない表の変更は配信されない。
--     登録しないと db.ts の subscribeChanges は接続だけして1件も通知を受けず、
--     他端末の記録が画面に反映されない（手動更新は効くのでデータは壊れないが無音で不動作）。
--   ・冪等: 既に載っている表は追加しない（重複追加は 42710 になる）。
--   ・パブリケーションが無いプロジェクト（Realtime 未有効）では何もしない。
--     その場合はダッシュボードの Database → Replication で supabase_realtime を作り、
--     下の6表を有効にしてからこのブロックを再実行する。
-- =====================================================================
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime が無いため Realtime 登録をスキップしました（ダッシュボードで有効化してください）';
    return;
  end if;
  foreach t in array array['notes','vitals','meals','fluid_intake','outings','note_reads'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I;', t);
    end if;
  end loop;
end $$;

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST205 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の検証（SQL Editor で実行して目視確認する）
--
-- 1) テーブル11個が揃っているか
--    select table_name from information_schema.tables
--     where table_schema = 'public' order by table_name;
--    → app_settings / fluid_intake / import_days / master_sync_log / meals / note_reads /
--      notes / outings / residents / staff / vitals の11行
--
-- 2) anon が全拒否になっているか（roles に public / anon が1つも出ないこと）
--    select tablename, policyname, roles, cmd from pg_policies
--     where schemaname = 'public' order by tablename, policyname;
--    → 各表に read_auth {authenticated} SELECT ／ insert_auth {authenticated} INSERT ／
--      update_auth {authenticated} UPDATE の3行だけが並び、cmd = DELETE の行が0件であること
--
-- 3) rev トリガが効くか（合成データで確認する。実データでは試さない）
--    update notes set body = body where id = <合成行のid>;
--    select rev, updated_at from notes where id = <同上>;  → rev が +1 されている
--
-- 4) Realtime が配信対象になっているか（他端末の記録が自動で画面に出るかの前提）
--    select tablename from pg_publication_tables
--     where pubname = 'supabase_realtime' and schemaname = 'public' order by tablename;
--    → fluid_intake / meals / note_reads / notes / outings / vitals の6行が含まれること。
--      0行・パブリケーション無しの場合はダッシュボード Database → Replication で
--      supabase_realtime を有効にしてから、上の do $$ ブロックを再実行する
--
-- 5) 本文検索が索引を使うか
--    explain analyze select id from notes
--     where deleted_at is null and body ilike '%発熱%' order by note_on desc limit 50;
--    → Bitmap Index Scan on idx_notes_body_trgm が出ること（2文字クエリは出ない想定・要実測）
-- ---------------------------------------------------------------------
