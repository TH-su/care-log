-- =====================================================================
-- 0044: デイ（せせらぎ）の記録 段階2b — 活動・レク（daycare_activity_log）と活動だけの入力の旗
--       （2026-10-22 代表者承認・計画の正本は【AI取締役】の 20261022_段階2_計画_v1.md の 3.1）
--
-- 0001〜0043 を当てたあとに実行する。冪等（何度実行しても同じ結果）。既存の表・列・データ・関数・ポリシーは消さない・変えない。
-- 足すもの（すべて追加のみ）:
--   1. app_settings: input_enabled_daycare_activity（値 'false'。既にあれば触らない）
--        活動だけの入力解禁。デイの旗（input_enabled_daycare）とは別にして、活動だけを止めて戻せるようにする
--        （デイの旗で戻すと段階1の到着・在席・バイタル一括まで止まるため）。読み方は既存の種類ごとの旗と同じ。
--   2. daycare_activity_log（1人1日1項目1行）… 活動・レクの記録。項目（label）は定型のチップか自由入力（40字まで）。
--        参加の度合い participation = full（参加）／partial（一部）／observed（見学）／declined（不参加）。既定は参加。
--        項目は前後の空白を持たない（同じ項目が空白の違いで2行にならない。画面は NFKC にそろえて前後の空白を落として送る）。
--        client_key（端末生成の冪等キー）・rev・変更の記録（業務日の列 day）・soft delete・RLS は 0041 の daycare_attendance と同じ形。
--        2台で同じ方・同じ日・同じ項目を入れても、生きている行は1つ（部分 unique）。合流の規則（度合いが同じなら成功・
--        違えば「先に記録があります」）は端末側（src/lib/db.ts の insertDaycareActivity と送信待ちの経路）が持つ。
--   3. Realtime に daycare_activity_log を足す（既に載っていれば何もしない＝冪等。端末は活動だけの別のチャンネルで購読する）
--
-- 過去の日: 現場も記録できる（欠席・入浴と同じ扱い。時刻を持たないので 0042・0043 のような守りは要らない）。
-- 物理削除はできない: delete のポリシーを作らず、authenticated から delete・truncate の権限も外す（0034 の resident_targets と同じ）。
--   取り消しは deleted_at を付ける更新（変更の記録に残る）。
--
-- 触らないもの: 段階1の表（daycare_days・daycare_attendance）・0042／0043 の守り・既存の旗・週間計画・cron・食事・水分・申し送り。
--
-- 旧クライアント×新サーバー: 旧版は新しい表を知らないので何も変わらない（活動の画面が無いだけ）。
-- 新クライアント×旧サーバー（このファイルを当てる前に画面を出した時）: 活動の欄は表が無い（42P01／PGRST205）を
--   「デイの活動はまだ使えません（サーバー側の設定待ち）」として入力を止める。旗の行が無い＝封鎖（既存の旗と同じ）。
--   段階1・2a の画面（到着・在席・食事・水分・排泄）はそのまま動く。
-- 適用の順: DB 先 → アプリ。旗は false のまま公開 → 全端末の版を確かめる → 旗を true。
-- 戻す時（必要な時だけ）: 旗を 'false' に戻す（活動の欄だけ止まる。記録は残る）。表・値の追加は戻さない（データを消さない・記録は5年保存）。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 1. 活動だけの入力解禁フラグ ----------
-- 値が無い・'true' 以外はアプリ側が封鎖として扱う（安全側）。現場で 'true' にした後に再実行しても戻さない
insert into public.app_settings (key, value)
values ('input_enabled_daycare_activity', 'false')
on conflict (key) do nothing;

-- ---------- 2. 活動・レク（1人1日1項目1行） ----------
create table if not exists public.daycare_activity_log (
  id            bigint generated always as identity primary key,
  resident_id   bigint not null references public.residents(id),
  day           date not null,                         -- 業務日（JST・クライアントが明示指定する）
  label         text not null,                         -- 項目（定型のチップの名前か自由入力・40字まで・前後の空白なし）
  participation text not null default 'full',          -- full=参加 / partial=一部 / observed=見学 / declined=不参加
  note          text,
  recorded_by   bigint references public.staff(id),
  rev           integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    bigint references public.staff(id),
  edited_by     bigint references public.staff(id),    -- 最後にこの行を書き換えた職員（0010 と同じ意味）
  client_key    text unique                            -- 端末生成の冪等キー（全体 unique＝削除済みの行もキーを押さえたまま）
);

alter table public.daycare_activity_log drop constraint if exists daycare_activity_log_label_check;
alter table public.daycare_activity_log add constraint daycare_activity_log_label_check
  check (label = pg_catalog.btrim(label) and pg_catalog.char_length(label) between 1 and 40);
alter table public.daycare_activity_log drop constraint if exists daycare_activity_log_participation_check;
alter table public.daycare_activity_log add constraint daycare_activity_log_participation_check
  check (participation in ('full', 'partial', 'observed', 'declined'));
alter table public.daycare_activity_log drop constraint if exists daycare_activity_log_note_check;
alter table public.daycare_activity_log add constraint daycare_activity_log_note_check
  check (note is null or pg_catalog.char_length(note) <= 200);

comment on table public.daycare_activity_log is
  'デイの活動・レク（1人1日1項目1行）。項目は定型のチップか自由入力（40字まで）。参加の度合いは full／partial／observed／declined。';
comment on column public.daycare_activity_log.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味（更新・削除のたびにアプリが送る）。';

-- 1人1日1項目1行（生きている行だけ）
create unique index if not exists uq_daycare_activity
  on public.daycare_activity_log (resident_id, day, label)
  where deleted_at is null;

-- 日ごとの一覧・その方の前回（前回コピー）
create index if not exists ix_daycare_activity_day
  on public.daycare_activity_log (day desc, id desc)
  where deleted_at is null;
create index if not exists ix_daycare_activity_resident_day
  on public.daycare_activity_log (resident_id, day desc)
  where deleted_at is null;

create or replace trigger trg_updated_daycare_activity_log
  before update on public.daycare_activity_log
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_daycare_activity_log
  after update on public.daycare_activity_log
  for each row execute function public.record_history_capture('day');

-- RLS（0041 の daycare_attendance と同じ: 読み書きとも許可リストの職員・delete のポリシーは作らない）
alter table public.daycare_activity_log enable row level security;
drop policy if exists "read_auth"   on public.daycare_activity_log;
drop policy if exists "insert_auth" on public.daycare_activity_log;
drop policy if exists "update_auth" on public.daycare_activity_log;
drop policy if exists member_only   on public.daycare_activity_log;
create policy "read_auth"   on public.daycare_activity_log for select to authenticated using (true);
create policy "insert_auth" on public.daycare_activity_log for insert to authenticated with check (true);
create policy "update_auth" on public.daycare_activity_log for update to authenticated using (true) with check (true);
create policy member_only on public.daycare_activity_log as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());

-- 物理削除の権限を外す（0034 の resident_targets と同じ。取り消しは deleted_at）。anon には何も渡さない
revoke all on public.daycare_activity_log from anon;
revoke delete, truncate on public.daycare_activity_log from authenticated;

-- ---------- 3. Realtime（活動。既に載っていれば何もしない＝冪等） ----------
-- pg_temp の関数は流したその接続の中だけにある（0041 で作った物は残っていない）ので、ここで同じ本文を作り直してから呼ぶ
create or replace function pg_temp.cl_realtime_add(p_table text)
returns void
language plpgsql
as $fn$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_catalog.pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = p_table) then
    execute pg_catalog.format('alter publication supabase_realtime add table public.%I', p_table);
  end if;
end;
$fn$;

select pg_temp.cl_realtime_add('daycare_activity_log');

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST205 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（結果が表で出る。目視する）
-- ---------------------------------------------------------------------
select
  (select count(*) from public.app_settings where key = 'input_enabled_daycare_activity')   as activity_flag_1,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'daycare_activity_log')                 as activity_table_1,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'daycare_activity_log'
      and policyname = 'member_only' and permissive = 'RESTRICTIVE')                        as member_only_1,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'daycare_activity_log' and cmd = 'DELETE')  as delete_policies_0,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'daycare_activity_log'
      and grantee in ('authenticated', 'anon') and privilege_type in ('DELETE', 'TRUNCATE')) as delete_grants_0,
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'daycare_activity_log')                                               as realtime_1;
