-- =====================================================================
-- 0012: デイの入浴記録（bath_records）＋ 種類ごとの入力解禁フラグ ＋ 入浴予定の読み口
--
-- 0001〜0011 を当てたあとに実行する。既存のテーブル・列・データは一切削除しない（追加のみ）。
--
-- ★再実行について（必ず読む）:
--   **このファイルは初回に1回だけ流す。2回目以降は「Realtime への登録（alter publication … add table）」の文で
--   「既に登録済み（42710）」のエラーになり、ファイル全体が巻き戻る（それより前の文の変更も入らない）。**
--   したがって、このファイルを書き換えて流し直すことで修正はできない。
--   **修正が要る時は、新しい番号のファイル（0013_… 等）を作って、その差分だけを流すこと。**
--   do $$ … $$ のブロック（登録済みかを確かめてから足す書き方）は使えない
--   （Supabase の SQL エディタが誤解釈するため・0001 の注記）。そのためこの1文をファイルの最後の方へ置いた。
--   ※0001 / 0003 の「alter publication … set table（一覧の置き換え）」を後から流し直すと、
--     bath_records が配信対象から外れる。その場合はこのファイルの alter publication 文だけを流し直す。
--
-- 背景（2026-09-26 代表承認）:
--   デイ（通所介護）は入浴介助加算Ⅰを算定しているが、入浴した日・しなかった日の記録が無い。
--   デイの利用者は全員が入居者（外部利用者はいない）。入浴予定の正本は週間計画（care_schedule_v2）で、
--   その写しが同じ Supabase の public.kv_entries にある。予定は写しから読み、実施はこの表へ書く。
--
-- 追加するもの:
--   1. app_settings: input_enabled_bath / input_enabled_med / input_enabled_incident（値 'false'。既にあれば触らない）
--        種類ごとの入力解禁。native_input_enabled（切替日D）とは別に、種類ごとに開始日を決められるようにする
--   2. bath_records 表（1人1日1件・soft delete・rev 楽観ロック・変更の記録トリガ・RLS）
--   3. 関数 daycare_bath_plan(p_date) … その日のデイの入浴予定（週間計画の写しから）
--   4. Realtime への登録（初回のみ。上の注記）
--
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 1. 種類ごとの入力解禁フラグ ----------
-- 値が無い・'true' 以外はアプリ側が封鎖として扱う（安全側）。現場で 'true' にした後に再実行しても戻さない
insert into public.app_settings (key, value)
values
  ('input_enabled_bath', 'false'),
  ('input_enabled_med', 'false'),
  ('input_enabled_incident', 'false')
on conflict (key) do nothing;

-- ---------- 2. 入浴記録 ----------
-- 1行 = 1人 × 1業務日（JST）。result は区分、中止のときだけ理由を持つ。
-- client_key は端末生成の冪等キー（全体 unique ＝削除済みの行もキーを押さえたまま。0001 の notes 等と同じ考え方）。
-- (resident_id, bath_on) の部分 unique は「1人1日1件」の防波堤。アプリは upsert を使わず、
--   23505 は「他の端末が先に記録した」証拠として読み直しを促す。
create table if not exists public.bath_records (
  id            bigint generated always as identity primary key,
  resident_id   bigint not null references public.residents(id),
  bath_on       date not null,                       -- 業務日付（JST・クライアントが明示指定する）
  result        text not null,                       -- full=全身浴 / shower=シャワー浴 / partial=部分浴・清拭 / cancel=中止
  cancel_reason text,                                -- condition=体調不良 / refusal=本人の拒否 / facility=事業所の都合 / other=その他
  note          text,                                -- 備考（理由が「その他」の時はアプリが必須にする）
  recorded_by   bigint references public.staff(id),
  rev           int not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    bigint references public.staff(id),
  edited_by     bigint references public.staff(id),  -- 最後にこの行を書き換えた職員（0010 と同じ意味）
  client_key    text unique
);

-- 制約は名前を付けて「落としてから作る」（再実行で重複しない・定義を差し替えられる）
alter table public.bath_records drop constraint if exists bath_records_result_check;
alter table public.bath_records add constraint bath_records_result_check
  check (result in ('full', 'shower', 'partial', 'cancel'));

-- 理由の値は4つのどれか（空は可）
alter table public.bath_records drop constraint if exists bath_records_cancel_reason_check;
alter table public.bath_records add constraint bath_records_cancel_reason_check
  check (cancel_reason is null or cancel_reason in ('condition', 'refusal', 'facility', 'other'));

-- 中止（cancel）の時は理由が必須
alter table public.bath_records drop constraint if exists bath_records_cancel_needs_reason;
alter table public.bath_records add constraint bath_records_cancel_needs_reason
  check (result <> 'cancel' or cancel_reason is not null);

comment on table public.bath_records is
  'デイの入浴記録（1人1日1件）。予定は週間計画の写し（kv_entries の care_schedule_v2）を daycare_bath_plan で読む。';
comment on column public.bath_records.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味（更新・削除のたびにアプリが送る）。';

-- 1人1日1件（生きている行だけ）
create unique index if not exists uq_bath_records_day
  on public.bath_records (resident_id, bath_on)
  where deleted_at is null;

-- 日ごとの一覧・月次表（日付降順）
create index if not exists idx_bath_records_timeline
  on public.bath_records (bath_on desc, id desc)
  where deleted_at is null;

-- 個人カルテ（利用者 × 期間）
create index if not exists idx_bath_records_resident
  on public.bath_records (resident_id, bath_on desc)
  where deleted_at is null;

-- updated_at ＋ rev 自動加算（0001）／変更の記録（0010。業務日付の列は bath_on）
create or replace trigger trg_updated_bath_records
  before update on public.bath_records
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_bath_records
  after update on public.bath_records
  for each row execute function public.record_history_capture('bath_on');

-- RLS（0001 と同じ方針: 読み書きとも authenticated 限定・delete ポリシーは作らない＝物理削除は構造的に不可）
alter table public.bath_records enable row level security;
drop policy if exists "read_auth"   on public.bath_records;
drop policy if exists "insert_auth" on public.bath_records;
drop policy if exists "update_auth" on public.bath_records;
drop policy if exists member_only   on public.bath_records;
create policy "read_auth"   on public.bath_records for select to authenticated using (true);
create policy "insert_auth" on public.bath_records for insert to authenticated with check (true);
create policy "update_auth" on public.bath_records for update to authenticated using (true) with check (true);
-- 許可リストの有効な人だけ（care-backend 0001_foundation.sql の member_only と同じ形）。
-- restrictive は上の3つと AND で効く＝既存の決まりは緩めない。0001_foundation を当てた後に作る表なので、ここで個別に付ける
create policy member_only on public.bath_records as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());

-- ---------- 3. その日のデイの入浴予定（週間計画の写しから） ----------
-- 読むのは kv_entries（key='care_schedule_v2'・自分のテナントの行）の data.residents[] だけ。
--   ・movedOut / preAdmitted / external が true の人は除く
--   ・events のうち serviceType='daycare' かつ bathing=true かつ dayOfWeek = その日の曜日
--     （dayOfWeek は 0=月 … 6=日。Postgres の isodow は 1=月 … 7=日 なので 1 を引く）
--   ・同じ人に複数あれば、開始時刻の最も早い1件（時刻は「9:30」と「09:30」を同じ順に並べる）
--   ・返すのは source_id（= masterId）・開始・終了・入院中かどうか・写しの更新時刻だけ（介護度など他の項目は返さない）
-- 返り値の読み方:
--   ・0行                         … 写しが無い（自分のテナントに care_schedule_v2 が無い・読めない）
--   ・source_id が null の1行だけ … 写しはあるが、その日の入浴予定は無い（updated_at は写しの更新時刻）
--   ・それ以外                     … 1行 = 1人の予定（全行に同じ updated_at）
-- security invoker（呼んだ職員の権限＝kv_entries の RLS がそのまま効く）。search_path は空にし、全部の名前を修飾する。
drop function if exists public.daycare_bath_plan(date);

create function public.daycare_bath_plan(p_date date)
returns table (
  source_id    text,
  start_time   text,
  end_time     text,
  hospitalized boolean,
  updated_at   timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  with src as (
    select k.data, k.updated_at
      from public.kv_entries k
     where k.tenant_id = private.my_tenant()
       and k.key = 'care_schedule_v2'
     limit 1
  ),
  plan as (
    select distinct on (x.source_id)
           x.source_id, x.start_time, x.end_time, x.hospitalized
      from src s
     cross join lateral pg_catalog.jsonb_array_elements(
             case when pg_catalog.jsonb_typeof(s.data -> 'residents') = 'array'
                  then s.data -> 'residents' else '[]'::jsonb end) r(v)
     cross join lateral pg_catalog.jsonb_array_elements(
             case when pg_catalog.jsonb_typeof(r.v -> 'events') = 'array'
                  then r.v -> 'events' else '[]'::jsonb end) e(v)
     cross join lateral (
       select nullif(pg_catalog.btrim(r.v ->> 'masterId'), '') as source_id,
              e.v ->> 'startTime' as start_time,
              e.v ->> 'endTime' as end_time,
              coalesce(r.v ->> 'hospitalized', '') = 'true' as hospitalized,
              -- 並べ替え用: 「9:30」を「09:30」にそろえる（時刻の形でなければ後ろへ）
              case when (e.v ->> 'startTime') ~ '^[0-9]{1,2}:[0-9]{2}'
                   then pg_catalog.lpad(pg_catalog.split_part(e.v ->> 'startTime', ':', 1), 2, '0')
                        || ':' || pg_catalog.substr(pg_catalog.split_part(e.v ->> 'startTime', ':', 2), 1, 2)
              end as start_key
     ) x
     where x.source_id is not null
       and coalesce(r.v ->> 'movedOut', '') <> 'true'
       and coalesce(r.v ->> 'preAdmitted', '') <> 'true'
       and coalesce(r.v ->> 'external', '') <> 'true'
       and (e.v ->> 'serviceType') = 'daycare'
       and (e.v ->> 'bathing') = 'true'
       -- 形が 0〜6 の時だけ数にする（and の評価順に頼らない。不正な値は null＝一致しない）
       and (case when (e.v ->> 'dayOfWeek') ~ '^[0-6]$' then (e.v ->> 'dayOfWeek')::int end)
           = (extract(isodow from p_date)::int - 1)
     order by x.source_id, x.start_key nulls last, x.end_time nulls last
  )
  select p.source_id, p.start_time, p.end_time, p.hospitalized, s.updated_at
    from src s
    left join plan p on true
$fn$;

comment on function public.daycare_bath_plan(date) is
  'その日のデイの入浴予定（週間計画の写し care_schedule_v2 から）。0行=写しが無い／source_id が null の1行=写しはあるが予定なし。';

-- 権限: PUBLIC の既定 EXECUTE を剥がし、anon を拒否、authenticated だけに許す（0002・0005 と同じ）
revoke all on function public.daycare_bath_plan(date) from public, anon;
grant execute on function public.daycare_bath_plan(date) to authenticated;

-- ---------- 4. Realtime（初回のみ。2回目以降はこの1文で止まる＝冒頭の注記） ----------
-- set table（一覧の置き換え）は使わない。add table は既に載っていると 42710 で止まる（それ以前の文は冪等）。
alter publication supabase_realtime add table public.bath_records;

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST205 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（結果が表で出る。目視する）
-- ---------------------------------------------------------------------
select
  (select count(*) from public.app_settings
    where key in ('input_enabled_bath', 'input_enabled_med', 'input_enabled_incident'))  as input_flags_3,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'bath_records')                       as bath_table_1,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'bath_records')                          as bath_policies_4,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'bath_records'
      and policyname = 'member_only' and permissive = 'RESTRICTIVE')                     as bath_member_only_1,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'bath_records' and cmd = 'DELETE')       as bath_delete_policies_0,
  (select count(*) from information_schema.triggers
    where event_object_table = 'bath_records')                                           as bath_triggers_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'daycare_bath_plan')                      as plan_function_1,
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'bath_records')                                                    as realtime_1;
