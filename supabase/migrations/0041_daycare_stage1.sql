-- =====================================================================
-- 0041: デイ（せせらぎ）の記録 段階1（到着・在席・帰宅・欠席・予定の写し）＋ 入浴の中止の理由に「欠席」
--       （2026-10-22 代表者承認「推奨どおりで進めて」・計画の正本は【AI取締役】の Phase3報告と承認事項_v1）
--
-- 0001〜0040 を当てたあとに実行する。冪等（何度実行しても同じ結果）。既存の表・列・データ・関数は消さない・変えない。
-- 足すもの（すべて追加のみ）:
--   1. app_settings: input_enabled_daycare（値 'false'。既にあれば触らない）
--        デイの画面の入力解禁。既存の種類ごとの旗（0012 の input_enabled_bath など）と同じ読み方。
--        デイのバイタルは既存の保存（0011 apply_cell_edits）を通るので native_input_enabled にも従う。
--        欠席日の入浴は既存の入浴の記録（bath_records）を通るので input_enabled_bath にも従う。
--   2. bath_records.cancel_reason に 'absent'（欠席）を足す（check の差し替え。既存の4つと null はそのまま通る）
--        欠席の人に 12:30 の自動の「全身浴」（0015・0016）を残さないため、欠席を記録した時に入浴の行を
--        「中止・欠席」にする（自動の行は取り消し済みを含めて行があれば作られない＝0016 の既存の決まり）。
--        入浴の画面の理由の選択肢は変えない（欠席はデイの到着・在席の画面からだけ付く）。
--   3. daycare_days（1日1行）… その日の予定の写し。開所の最初のタップ（当日だけ）で、その日の予定の全行を
--        jsonb で写す（daycare_open_day）。週間計画の履歴は30版で消えるため、過去の日の「予定があった人」の根拠を残す。
--        plan_source = 'kv'（予定あり）／'none'（写しはあるがその日の予定なし）／'unknown'（予定を読めなかった）。
--        写しは動かさない（update は unknown の行を、読めた写しに1回だけ置き換える時だけ通す）。氏名は持たない。
--   4. daycare_attendance（1人1日1件）… 到着・帰宅・欠席。状態は保存せず列から導く
--        （欠席＝absent／到着の時刻あり・帰宅なし＝在席／帰宅あり＝帰宅／どれも無い＝予定）。到着の1タップで在席。
--        client_key（端末生成の冪等キー）・rev・変更の記録・soft delete・RLS は 0012 の bath_records と同じ形。
--   5. 関数 daycare_plan(p_date) … その日のデイの予定（週間計画の写し kv_entries の care_schedule_v2 から・読むだけ）。
--        予定1件ごとに1行（同じ人の同じ曜日の2件は2行＝1枠に畳まない）。照合はサーバーの中で行い、氏名は返さない。
--   6. 関数 daycare_open_day(p_day, p_staff) … 今日の予定の写し（daycare_days）を作って返す。今日以外は断る
--   7. Realtime に daycare_attendance を足す（既に載っていれば何もしない＝冪等。端末は別のチャンネルで購読する）
--
-- 触らないもの: vitals（デイの測定は既存の kind 'observation' のまま・冪等キー client_key を 'dc:<日>:<利用者id>:<回>'
--   の形にして見分ける。0011・vitals の制約は変えない）、週間計画（kv_entries は読むだけ）、residents（外部利用者は
--   段階1〜3の対象外）、cron（0015・0016 の自動の記録は変えない）。
--
-- 旧クライアント×新サーバー: 旧版は新しい表・関数を知らないので何も変わらない。'absent' の入浴の行は旧版では
--   「中止・理由なし」に読まれる（行は残る）。旧版で区分を押し直すと理由が消えうるので、旗 input_enabled_daycare を
--   true にする前に min_client_build を上げる（検証計画 v2 の V3）。
-- 新クライアント×旧サーバー（このファイルを当てる前に画面を出した時）: デイの画面は表・関数が無い（42P01／PGRST205・
--   PGRST202）を「サーバー側の設定待ち」として入力を止める。旗の行が無い＝封鎖（既存の旗と同じ）。既存の画面は変わらない。
-- 適用の順: DB 先 → アプリ。旗は false のまま公開 → 全端末の版を確かめる → min_client_build → 旗を true。
-- 戻す時（必要な時だけ）: 旗を 'false' に戻す（記録は残る）。デイの記録がある時はアプリを古い版へ戻さず、前へ進めて直す。
--   表・関数・値の追加は戻さない（データを消さない。記録は5年保存）。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 1. デイの入力解禁フラグ ----------
-- 値が無い・'true' 以外はアプリ側が封鎖として扱う（安全側）。現場で 'true' にした後に再実行しても戻さない
insert into public.app_settings (key, value)
values ('input_enabled_daycare', 'false')
on conflict (key) do nothing;

-- ---------- 2. 入浴の中止の理由に「欠席」 ----------
-- 0012 の bath_records_cancel_reason_check を同じ名前で差し替える（既存の4つと null はそのまま通る＝既存の行は違反しない）
alter table public.bath_records drop constraint if exists bath_records_cancel_reason_check;
alter table public.bath_records add constraint bath_records_cancel_reason_check
  check (cancel_reason is null or cancel_reason in ('condition', 'refusal', 'facility', 'other', 'absent'));

-- ---------- 3. その日の予定の写し ----------
create table if not exists public.daycare_days (
  id              bigint generated always as identity primary key,
  day             date not null,                        -- 業務日（JST）
  plan_source     text not null,                        -- kv / none / unknown
  plan_rev        integer,                              -- 写した時の週間計画の版（kv_entries.rev）
  plan_updated_at timestamptz,                          -- 写した時の週間計画の更新時刻
  plan_rows       jsonb not null default '[]'::jsonb,   -- daycare_plan(day) の全行（氏名なし）
  opened_by       bigint references public.staff(id),   -- 開所のタップをした職員
  rev             integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  edited_by       bigint references public.staff(id)
);

alter table public.daycare_days drop constraint if exists daycare_days_plan_source_check;
alter table public.daycare_days add constraint daycare_days_plan_source_check
  check (plan_source in ('kv', 'none', 'unknown'));
alter table public.daycare_days drop constraint if exists daycare_days_plan_rows_check;
alter table public.daycare_days add constraint daycare_days_plan_rows_check
  check (pg_catalog.jsonb_typeof(plan_rows) = 'array');

comment on table public.daycare_days is
  'デイの1日の予定の写し（開所の最初のタップで daycare_plan の全行を写す・氏名なし）。plan_source=kv/none/unknown。';

-- 1日1行（写しは1つ）
create unique index if not exists uq_daycare_days_day on public.daycare_days (day);

create or replace trigger trg_updated_daycare_days
  before update on public.daycare_days
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_daycare_days
  after update on public.daycare_days
  for each row execute function public.record_history_capture('day');

-- RLS: 読む・作る＝許可リストの職員（現場を含む）。更新は「読めなかった写し（unknown）」の置き換えだけ。delete のポリシーは作らない
alter table public.daycare_days enable row level security;
drop policy if exists "read_auth"   on public.daycare_days;
drop policy if exists "insert_auth" on public.daycare_days;
drop policy if exists "update_auth" on public.daycare_days;
drop policy if exists member_only   on public.daycare_days;
create policy "read_auth"   on public.daycare_days for select to authenticated using (true);
create policy "insert_auth" on public.daycare_days for insert to authenticated with check (true);
create policy "update_auth" on public.daycare_days for update to authenticated using (plan_source = 'unknown') with check (true);
create policy member_only on public.daycare_days as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());

-- ---------- 4. 到着・帰宅・欠席（1人1日1件） ----------
create table if not exists public.daycare_attendance (
  id            bigint generated always as identity primary key,
  resident_id   bigint not null references public.residents(id),
  day           date not null,                        -- 業務日（JST・クライアントが明示指定する）
  arrived_at    time,                                 -- 到着（＝在席）の時刻
  left_at       time,                                 -- 帰宅の時刻
  absent        boolean not null default false,       -- 欠席
  absent_reason text,                                 -- condition=体調不良 / hospital=受診・入院 / wish=本人の希望 / family=ご家族の都合 / other=その他
  note          text,
  recorded_by   bigint references public.staff(id),
  rev           integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    bigint references public.staff(id),
  edited_by     bigint references public.staff(id),   -- 最後にこの行を書き換えた職員（0010 と同じ意味）
  client_key    text unique                           -- 端末生成の冪等キー（全体 unique＝削除済みの行もキーを押さえたまま）
);

alter table public.daycare_attendance drop constraint if exists daycare_attendance_absent_reason_check;
alter table public.daycare_attendance add constraint daycare_attendance_absent_reason_check
  check (absent_reason is null or absent_reason in ('condition', 'hospital', 'wish', 'family', 'other'));
-- 欠席には理由が要る・欠席でなければ理由を持たない
alter table public.daycare_attendance drop constraint if exists daycare_attendance_absent_needs_reason;
alter table public.daycare_attendance add constraint daycare_attendance_absent_needs_reason
  check (not absent or absent_reason is not null);
alter table public.daycare_attendance drop constraint if exists daycare_attendance_reason_only_absent;
alter table public.daycare_attendance add constraint daycare_attendance_reason_only_absent
  check (absent or absent_reason is null);
-- 欠席の日は到着・帰宅の時刻を持たない
alter table public.daycare_attendance drop constraint if exists daycare_attendance_absent_no_times;
alter table public.daycare_attendance add constraint daycare_attendance_absent_no_times
  check (not absent or (arrived_at is null and left_at is null));
-- 帰宅は到着の後（到着なしの帰宅は持たない）
alter table public.daycare_attendance drop constraint if exists daycare_attendance_left_after_arrived;
alter table public.daycare_attendance add constraint daycare_attendance_left_after_arrived
  check (left_at is null or (arrived_at is not null and left_at >= arrived_at));

comment on table public.daycare_attendance is
  'デイの到着・帰宅・欠席（1人1日1件）。状態は列から導く（欠席／在席＝到着あり帰宅なし／帰宅／予定）。';
comment on column public.daycare_attendance.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味（更新・削除のたびにアプリが送る）。';

-- 1人1日1件（生きている行だけ）
create unique index if not exists uq_daycare_attendance_day
  on public.daycare_attendance (resident_id, day)
  where deleted_at is null;

-- 日ごとの一覧
create index if not exists idx_daycare_attendance_day
  on public.daycare_attendance (day desc, id desc)
  where deleted_at is null;

create or replace trigger trg_updated_daycare_attendance
  before update on public.daycare_attendance
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_daycare_attendance
  after update on public.daycare_attendance
  for each row execute function public.record_history_capture('day');

-- RLS（0012 の bath_records と同じ: 読み書きとも許可リストの職員・delete のポリシーは作らない＝物理削除は構造的に不可）
alter table public.daycare_attendance enable row level security;
drop policy if exists "read_auth"   on public.daycare_attendance;
drop policy if exists "insert_auth" on public.daycare_attendance;
drop policy if exists "update_auth" on public.daycare_attendance;
drop policy if exists member_only   on public.daycare_attendance;
create policy "read_auth"   on public.daycare_attendance for select to authenticated using (true);
create policy "insert_auth" on public.daycare_attendance for insert to authenticated with check (true);
create policy "update_auth" on public.daycare_attendance for update to authenticated using (true) with check (true);
create policy member_only on public.daycare_attendance as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());

-- ---------- 5. その日のデイの予定（週間計画の写しから・読むだけ） ----------
-- 読むのは kv_entries（key='care_schedule_v2'・自分のテナントの行）の data.residents[] と events[] だけ。
--   ・movedOut / preAdmitted が true の記録は除く（外部利用者 external は「名簿に無い方」に数えるため返す）
--   ・events のうち serviceType='daycare' かつ dayOfWeek = その日の曜日（0=月 … 6=日）。予定1件ごとに1行
--   ・照合（不変条件: 利用者No で引いて氏名を突き合わせる・氏名で引くのは利用者No の無い記録で一意に絞れる時だけ・
--     別の利用者No に束縛済みの在籍者を氏名で拾わない・同じ人の記録が2つなら後勝ちにしない）はサーバーで行い、
--     氏名は返さない（現場の端末へ週間計画の氏名を降ろさない）。氏名の比べ方は空白（半角・全角）を除いた文字の一致。
--     match: mid（利用者No と氏名が一致）／name（利用者No の無い記録を氏名で1人に絞れた）／mismatch（利用者No は
--            合うが氏名が違う）／external（外部利用者）／absent_roster（名簿の在籍者に居ない）／ambiguous（氏名で絞れない）
--     dup: 同じ利用者No の記録が2つ以上・または2つ以上の記録が同じ在籍者に結び付く（どちらの行にも付ける）
-- 返り値の読み方:
--   ・0行                        … 予定を読めない（写しが無い・residents が配列でない・空）＝unknown
--   ・sched_id が null の1行だけ … 写しはあるが、その日のデイの予定が無い（plan_rev・updated_at は写しの版と時刻）＝none
--   ・それ以外                    … 予定1件ごとに1行（全行に同じ plan_rev・updated_at）
-- security invoker（呼んだ職員の権限＝kv_entries・residents の RLS がそのまま効く）。search_path は空にし、全部の名前を修飾する。
drop function if exists public.daycare_plan(date);

create function public.daycare_plan(p_date date)
returns table (
  sched_id     text,
  event_id     text,
  resident_id  bigint,
  match        text,
  dup          boolean,
  external     boolean,
  hospitalized boolean,
  start_time   text,
  end_time     text,
  bathing      boolean,
  plan_rev     integer,
  updated_at   timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  with src as (
    select k.data, k.updated_at, k.rev
      from public.kv_entries k
     where k.tenant_id = private.my_tenant()
       and k.key = 'care_schedule_v2'
     limit 1
  ),
  -- 空の名簿・配列でない名簿は「読めない」（成功として扱わない）
  ok as (
    select s.data, s.updated_at, s.rev
      from src s
     -- and の評価順に頼らない（配列でない時に jsonb_array_length を呼ばない）
     where (case when pg_catalog.jsonb_typeof(s.data -> 'residents') = 'array'
                 then pg_catalog.jsonb_array_length(s.data -> 'residents') else 0 end) > 0
  ),
  res as (
    select r.ord,
           r.v,
           coalesce(nullif(pg_catalog.btrim(r.v ->> 'id'), ''), '#' || r.ord::text) as sched_id,
           nullif(pg_catalog.btrim(r.v ->> 'masterId'), '') as mid,
           pg_catalog.regexp_replace(coalesce(r.v ->> 'name', ''), '[[:space:]　]', '', 'g') as nkey,
           coalesce(r.v ->> 'external', '') = 'true' as external,
           coalesce(r.v ->> 'hospitalized', '') = 'true' as hospitalized
      from ok s
     cross join lateral pg_catalog.jsonb_array_elements(s.data -> 'residents') with ordinality r(v, ord)
     where pg_catalog.jsonb_typeof(r.v) = 'object'
       and coalesce(r.v ->> 'movedOut', '') <> 'true'
       and coalesce(r.v ->> 'preAdmitted', '') <> 'true'
  ),
  mids as (
    select x.mid, pg_catalog.count(*) as n from res x where x.mid is not null and not x.external group by x.mid
  ),
  roster as (
    select p.id, p.source_id,
           pg_catalog.regexp_replace(p.name, '[[:space:]　]', '', 'g') as nkey
      from public.residents p
     where p.active
  ),
  matched as (
    select x.*,
           case
             when x.external then 'external'
             when x.mid is not null then
               case
                 when not exists (select 1 from roster ro where ro.source_id = x.mid) then 'absent_roster'
                 when exists (select 1 from roster ro where ro.source_id = x.mid and ro.nkey = x.nkey and x.nkey <> '') then 'mid'
                 else 'mismatch'
               end
             when x.nkey = '' then 'ambiguous'
             else
               case (select pg_catalog.count(*) from roster ro where ro.nkey = x.nkey)
                 when 0 then 'absent_roster'
                 when 1 then
                   -- 別の記録の利用者No に束縛済みの在籍者は氏名で拾わない
                   case when exists (select 1 from roster ro join mids m on m.mid = ro.source_id where ro.nkey = x.nkey)
                        then 'ambiguous' else 'name' end
                 else 'ambiguous'
               end
           end as match
      from res x
  ),
  bound as (
    select m.*,
           case
             when m.match = 'mid' then (select ro.id from roster ro where ro.source_id = m.mid limit 1)
             when m.match = 'name' then (select ro.id from roster ro where ro.nkey = m.nkey limit 1)
           end as resident_id
      from matched m
  ),
  flagged as (
    select b.*,
           (b.mid is not null and coalesce((select mm.n from mids mm where mm.mid = b.mid), 0) > 1)
             or (b.resident_id is not null
                 and (select pg_catalog.count(*) from bound b2 where b2.resident_id = b.resident_id) > 1) as dup
      from bound b
  ),
  plan as (
    select f.sched_id,
           nullif(pg_catalog.btrim(e.v ->> 'id'), '') as event_id,
           f.resident_id,
           f.match,
           f.dup,
           f.external,
           f.hospitalized,
           e.v ->> 'startTime' as start_time,
           e.v ->> 'endTime' as end_time,
           coalesce(e.v ->> 'bathing', '') = 'true' as bathing,
           f.ord,
           e.ord as eord,
           -- 並べ替え用: 「9:30」を「09:30」にそろえる（時刻の形でなければ後ろへ）
           case when (e.v ->> 'startTime') ~ '^[0-9]{1,2}:[0-9]{2}'
                then pg_catalog.lpad(pg_catalog.split_part(e.v ->> 'startTime', ':', 1), 2, '0')
                     || ':' || pg_catalog.substr(pg_catalog.split_part(e.v ->> 'startTime', ':', 2), 1, 2)
           end as start_key
      from flagged f
     cross join lateral pg_catalog.jsonb_array_elements(
             case when pg_catalog.jsonb_typeof(f.v -> 'events') = 'array'
                  then f.v -> 'events' else '[]'::jsonb end) with ordinality e(v, ord)
     where pg_catalog.jsonb_typeof(e.v) = 'object'
       and (e.v ->> 'serviceType') = 'daycare'
       -- 形が 0〜6 の時だけ数にする（不正な値は null＝一致しない）
       and (case when (e.v ->> 'dayOfWeek') ~ '^[0-6]$' then (e.v ->> 'dayOfWeek')::int end)
           = (extract(isodow from p_date)::int - 1)
  )
  select q.sched_id, q.event_id, q.resident_id, q.match, q.dup, q.external, q.hospitalized,
         q.start_time, q.end_time, q.bathing, q.plan_rev, q.updated_at
    from (
      select p.sched_id, p.event_id, p.resident_id, p.match, p.dup, p.external, p.hospitalized,
             p.start_time, p.end_time, p.bathing, s.rev as plan_rev, s.updated_at,
             0 as grp, p.start_key, p.ord, p.eord
        from plan p cross join ok s
      union all
      -- 写しはあるが、その日の予定が無い（none）
      select null, null, null, null, null, null, null, null, null, null, s.rev, s.updated_at,
             1, null, null, null
        from ok s
       where not exists (select 1 from plan)
    ) q
   order by q.grp, q.start_key nulls last, q.ord, q.eord
$fn$;

comment on function public.daycare_plan(date) is
  'その日のデイの予定（週間計画の写し care_schedule_v2 から・予定1件ごとに1行・照合はサーバー・氏名は返さない）。0行=読めない／sched_id が null の1行=予定なし。';

revoke all on function public.daycare_plan(date) from public, anon;
grant execute on function public.daycare_plan(date) to authenticated;

-- ---------- 6. 今日の予定の写しを作る（開所の最初のタップ） ----------
-- 今日（日本時間）の分だけ。既に写しがあればそのまま返す（写しは動かさない）。写しが unknown（読めなかった）で、
-- いま読めた時だけ1回置き換える。返り値は daycare_days の1行（jsonb）。
-- security invoker（daycare_days・kv_entries の RLS がそのまま効く）。
drop function if exists public.daycare_open_day(date, bigint);

create function public.daycare_open_day(p_day date, p_staff bigint default null)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $fn$
declare
  v_today  date := (pg_catalog.now() at time zone 'Asia/Tokyo')::date;
  v_rows   jsonb;
  v_n      integer;
  v_real   integer;
  v_rev    integer;
  v_upd    timestamptz;
  v_source text;
  v_cur    text;
  v_row    public.daycare_days%rowtype;
begin
  if p_day is null or p_day <> v_today then
    raise exception '予定の写しは今日の分だけ作れます。日付を今日にしてからもう一度お試しください'
      using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p)), '[]'::jsonb),
         pg_catalog.count(*),
         pg_catalog.count(*) filter (where p.sched_id is not null),
         pg_catalog.max(p.plan_rev),
         pg_catalog.max(p.updated_at)
    into v_rows, v_n, v_real, v_rev, v_upd
    from public.daycare_plan(p_day) p;

  v_source := case when v_n = 0 then 'unknown' when v_real = 0 then 'none' else 'kv' end;
  if v_real = 0 then
    v_rows := '[]'::jsonb;
  end if;

  select d.plan_source into v_cur from public.daycare_days d where d.day = p_day;
  if not found then
    insert into public.daycare_days (day, plan_source, plan_rev, plan_updated_at, plan_rows, opened_by, edited_by)
    values (p_day, v_source, v_rev, v_upd, v_rows, p_staff, p_staff)
    on conflict (day) do nothing;
  elsif v_cur = 'unknown' and v_source <> 'unknown' then
    update public.daycare_days
       set plan_source = v_source, plan_rev = v_rev, plan_updated_at = v_upd, plan_rows = v_rows, edited_by = p_staff
     where day = p_day and plan_source = 'unknown';
  end if;

  select * into v_row from public.daycare_days d where d.day = p_day;
  if not found then
    raise exception '予定の写しを作れませんでした。電波の届く所でもう一度お試しください' using errcode = '40001';
  end if;
  return pg_catalog.jsonb_build_object(
    'id', v_row.id, 'day', v_row.day, 'plan_source', v_row.plan_source, 'plan_rev', v_row.plan_rev,
    'plan_updated_at', v_row.plan_updated_at, 'plan_rows', v_row.plan_rows, 'opened_by', v_row.opened_by,
    'created_at', v_row.created_at, 'rev', v_row.rev
  );
end;
$fn$;

comment on function public.daycare_open_day(date, bigint) is
  '今日のデイの予定の写し（daycare_days）を作って返す。既にあればそのまま（unknown の写しだけ1回置き換える）。今日以外は 22023。';

revoke all on function public.daycare_open_day(date, bigint) from public, anon;
grant execute on function public.daycare_open_day(date, bigint) to authenticated;

-- ---------- 7. Realtime（到着・帰宅・欠席。既に載っていれば何もしない＝冪等） ----------
-- 0012 の add table は2回目に 42710 で止まるため、一時の関数で「載っていなければ足す」にする（do $$ を使わない）
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

select pg_temp.cl_realtime_add('daycare_attendance');

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST202・PGRST205 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（結果が表で出る。目視する）
-- ---------------------------------------------------------------------
select
  (select count(*) from public.app_settings where key = 'input_enabled_daycare')            as daycare_flag_1,
  (select count(*) from pg_constraint
    where conname = 'bath_records_cancel_reason_check'
      and pg_get_constraintdef(oid) like '%absent%')                                          as bath_absent_1,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name in ('daycare_days', 'daycare_attendance'))   as daycare_tables_2,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('daycare_days', 'daycare_attendance')
      and policyname = 'member_only' and permissive = 'RESTRICTIVE')                          as member_only_2,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('daycare_days', 'daycare_attendance')
      and cmd = 'DELETE')                                                                     as delete_policies_0,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('daycare_plan', 'daycare_open_day'))         as functions_2,
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'daycare_attendance')                                                   as realtime_1;
