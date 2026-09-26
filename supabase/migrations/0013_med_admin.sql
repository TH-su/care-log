-- =====================================================================
-- 0013: 服薬介助の実施チェック（med_slots ＝入居者ごとの服薬の時間帯／med_admin ＝実施の記録）
--
-- 0001〜0012 を当てたあとに実行する。既存のテーブル・列・データは一切削除しない（追加のみ）。
--
-- ★再実行について（必ず読む）:
--   **このファイルは初回に1回だけ流す。2回目以降は「Realtime への登録（alter publication … add table）」の文で
--   「既に登録済み（42710）」のエラーになり、ファイル全体が巻き戻る（それより前の文の変更も入らない）。**
--   したがって、このファイルを書き換えて流し直すことで修正はできない。
--   **修正が要る時は、新しい番号のファイル（0014_… 等）を作って、その差分だけを流すこと。**
--   do $$ … $$ のブロック（登録済みかを確かめてから足す書き方）は使えない
--   （Supabase の SQL エディタが誤解釈するため・0001 の注記）。そのため登録の2文をファイルの最後の方へ置いた。
--   ※0001 / 0003 の「alter publication … set table（一覧の置き換え）」を後から流し直すと、
--     med_slots / med_admin が配信対象から外れる。その場合はこのファイルの alter publication 文だけを流し直す。
--
-- 背景（2026-09-26 代表承認）:
--   住宅型の服薬介助（一包化された袋を時間帯ごとに渡す）の実施チェック。薬の名前は持たない
--   （処方の正本は入居者マスタで自由記述のため）。入居者ごとに「服薬のある時間帯」だけを持ち、
--   時間帯ごとに渡した・渡せなかったを記録する。頓服だけは使った薬・理由を自由記述で残す。
--   入力解禁は app_settings の input_enabled_med（0012 で 'false' を入れ済み）。
--
-- 追加するもの:
--   1. med_slots 表（1人1件・時間帯の配列・soft delete・rev 楽観ロック・変更の記録トリガ・RLS＋member_only）
--   2. med_admin 表（1人1日1時間帯1件（頓服は何件でも）・soft delete・rev・変更の記録トリガ・RLS＋member_only）
--   3. Realtime への登録（初回のみ。上の注記）
--
-- 個人情報: このファイルに実在の氏名・記録本文・薬の名前を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 1. 服薬の時間帯（入居者ごと） ----------
-- 1行 = 1人。slots は 'morning'=朝 / 'noon'=昼 / 'evening'=夕 / 'bedtime'=眠前 の配列（空＝服薬なし）。
-- client_key は端末生成の冪等キー（全体 unique ＝削除済みの行もキーを押さえたまま。0012 と同じ考え方）。
-- (resident_id) の部分 unique は「1人1件」の防波堤。アプリは upsert を使わず、無ければ insert・あれば rev 照合の update。
--   23505（自分のキーでない）は「他の端末が先に設定した」証拠として読み直しを促す。
create table if not exists public.med_slots (
  id            bigint generated always as identity primary key,
  resident_id   bigint not null references public.residents(id),
  slots         text[] not null default '{}',
  note          text,                                -- 備考（看護師・事務所のメモ。薬の名前は書かない運用）
  rev           int not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    bigint references public.staff(id),
  edited_by     bigint references public.staff(id),  -- 最後にこの行を書き換えた職員（0010 と同じ意味）
  client_key    text unique
);

-- 制約は名前を付けて「落としてから作る」（定義を差し替えられる）。
-- 要素は4つのどれかだけ（null の要素も不可。array_position で null を探す）
alter table public.med_slots drop constraint if exists med_slots_slots_check;
alter table public.med_slots add constraint med_slots_slots_check
  check (
    slots <@ array['morning', 'noon', 'evening', 'bedtime']::text[]
    and array_position(slots, null) is null
  );

comment on table public.med_slots is
  '入居者ごとの服薬の時間帯（1人1件）。slots は morning/noon/evening/bedtime の配列。薬の名前は持たない（処方の正本は入居者マスタ）。';
comment on column public.med_slots.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味（更新・削除のたびにアプリが送る）。';

-- 1人1件（生きている行だけ）
create unique index if not exists uq_med_slots_resident
  on public.med_slots (resident_id)
  where deleted_at is null;

-- updated_at ＋ rev 自動加算（0001）／変更の記録（0010）。
-- この表には業務日付の列が無いので、record_history.record_day には「変更した日」として updated_at を渡す
-- （record_history_capture は (新しい行 ->> 列名)::date で日付を取る。set_updated_at_rev が before で now() を入れた値。
--  jsonb の時刻はセッションの時刻帯（Supabase の既定は UTC）で書かれるため、日本時間 0〜9 時の変更は前日の日付になる）
create or replace trigger trg_updated_med_slots
  before update on public.med_slots
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_med_slots
  after update on public.med_slots
  for each row execute function public.record_history_capture('updated_at');

-- RLS（0012 と同じ方針: 読み書きとも authenticated 限定・delete ポリシーは作らない＝物理削除は構造的に不可）
alter table public.med_slots enable row level security;
drop policy if exists "read_auth"   on public.med_slots;
drop policy if exists "insert_auth" on public.med_slots;
drop policy if exists "update_auth" on public.med_slots;
drop policy if exists member_only   on public.med_slots;
create policy "read_auth"   on public.med_slots for select to authenticated using (true);
create policy "insert_auth" on public.med_slots for insert to authenticated with check (true);
create policy "update_auth" on public.med_slots for update to authenticated using (true) with check (true);
-- 許可リストの有効な人だけ（care-backend 0001_foundation.sql の member_only と同じ形）。restrictive は上の3つと AND で効く
create policy member_only on public.med_slots as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());

-- ---------- 2. 与薬の記録 ----------
-- 1行 = 1人 × 1業務日（JST）× 1時間帯。頓服（slot='prn'）だけは同じ日に何件でも持てる。
-- status: taken=服用済み / partial=一部残し / refused=拒否（再度の声かけ後も） / absent=不在（外出・入院） /
--         stopped=医師指示で中止 / dropped=落薬 / wrong=誤薬。頓服は taken のみ。
-- 頓服は given_at（使用時刻）・prn_drug（薬・自由記述）・prn_reason（理由）が必須、prn_effect（効果）は後から追記する。
create table if not exists public.med_admin (
  id            bigint generated always as identity primary key,
  resident_id   bigint not null references public.residents(id),
  admin_on      date not null,                       -- 業務日付（JST・クライアントが明示指定する）
  slot          text not null,
  status        text not null,
  given_at      timestamptz,                         -- 頓服の使用時刻（頓服では必須）
  prn_drug      text,                                -- 頓服の薬（自由記述・頓服では必須）
  prn_reason    text,                                -- 頓服の理由（頓服では必須）
  prn_effect    text,                                -- 頓服の効果（任意・後から追記）
  note          text,                                -- 備考
  recorded_by   bigint references public.staff(id),
  rev           int not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    bigint references public.staff(id),
  edited_by     bigint references public.staff(id),  -- 最後にこの行を書き換えた職員（0010 と同じ意味）
  client_key    text unique
);

alter table public.med_admin drop constraint if exists med_admin_slot_check;
alter table public.med_admin add constraint med_admin_slot_check
  check (slot in ('morning', 'noon', 'evening', 'bedtime', 'prn'));

alter table public.med_admin drop constraint if exists med_admin_status_check;
alter table public.med_admin add constraint med_admin_status_check
  check (status in ('taken', 'partial', 'refused', 'absent', 'stopped', 'dropped', 'wrong'));

-- 頓服は「服用済み」だけ・使用時刻と薬と理由が必須（空白だけも不可）
alter table public.med_admin drop constraint if exists med_admin_prn_check;
alter table public.med_admin add constraint med_admin_prn_check
  check (
    slot <> 'prn'
    or (
      status = 'taken'
      and given_at is not null
      and nullif(btrim(prn_drug), '') is not null
      and nullif(btrim(prn_reason), '') is not null
    )
  );

comment on table public.med_admin is
  '与薬の実施の記録（1人1日1時間帯1件。頓服 slot=prn は何件でも）。時間帯の設定は med_slots。';
comment on column public.med_admin.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味（更新・削除のたびにアプリが送る）。';

-- 1人1日1時間帯1件（生きている行だけ・頓服は除く）
create unique index if not exists uq_med_admin_slot
  on public.med_admin (resident_id, admin_on, slot)
  where deleted_at is null and slot <> 'prn';

-- 日ごとの一覧・月次表（日付降順）
create index if not exists idx_med_admin_timeline
  on public.med_admin (admin_on desc, id desc)
  where deleted_at is null;

-- 個人カルテ・1人の月次表（利用者 × 期間）
create index if not exists idx_med_admin_resident
  on public.med_admin (resident_id, admin_on desc)
  where deleted_at is null;

-- updated_at ＋ rev 自動加算（0001）／変更の記録（0010。業務日付の列は admin_on）
create or replace trigger trg_updated_med_admin
  before update on public.med_admin
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_med_admin
  after update on public.med_admin
  for each row execute function public.record_history_capture('admin_on');

alter table public.med_admin enable row level security;
drop policy if exists "read_auth"   on public.med_admin;
drop policy if exists "insert_auth" on public.med_admin;
drop policy if exists "update_auth" on public.med_admin;
drop policy if exists member_only   on public.med_admin;
create policy "read_auth"   on public.med_admin for select to authenticated using (true);
create policy "insert_auth" on public.med_admin for insert to authenticated with check (true);
create policy "update_auth" on public.med_admin for update to authenticated using (true) with check (true);
create policy member_only on public.med_admin as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());

-- ---------- 3. Realtime（初回のみ。2回目以降はこの文で止まる＝冒頭の注記） ----------
-- set table（一覧の置き換え）は使わない。add table は既に載っていると 42710 で止まる（それ以前の文は冪等）。
alter publication supabase_realtime add table public.med_slots;
alter publication supabase_realtime add table public.med_admin;

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST205 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（結果が表で出る。目視する。列名の末尾の数が期待値）
-- ---------------------------------------------------------------------
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name in ('med_slots', 'med_admin'))           as med_tables_2,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('med_slots', 'med_admin'))             as med_policies_8,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('med_slots', 'med_admin')
      and policyname = 'member_only' and permissive = 'RESTRICTIVE')                     as med_member_only_2,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('med_slots', 'med_admin')
      and cmd = 'DELETE')                                                                as med_delete_policies_0,
  (select count(*) from information_schema.triggers
    where event_object_table in ('med_slots', 'med_admin'))                              as med_triggers_4,
  (select count(*) from pg_indexes
    where schemaname = 'public'
      and indexname in ('uq_med_slots_resident', 'uq_med_admin_slot',
                        'idx_med_admin_timeline', 'idx_med_admin_resident'))             as med_indexes_4,
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename in ('med_slots', 'med_admin'))                                       as realtime_2,
  (select count(*) from public.app_settings where key = 'input_enabled_med')             as input_flag_1;
