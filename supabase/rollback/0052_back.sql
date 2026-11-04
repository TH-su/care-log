-- 0052（施設の印の段階2）を戻す。段階③以降を入れた後には流さない（先にそちらを戻す）。0051 を戻す前に流す。
-- 関数を 0052 の前の本文（0015・0016・0021・0024・0025・0041・0047・0048・0049・0051 の最後の定義）へそのまま戻し、
-- 0052 で足した2つの関数を外す。表・列・記録・cron のジョブには触れない（記録に入った施設の印もそのまま残る）。
-- 0041 の2つ（daycare_plan・daycare_open_day）は元は drop → create だったが、権限を保つため create or replace で戻す（本文は同じ）。
-- ★ do $$ … $$ のブロックは使わない。

-- ── 0051 の印を入れるトリガ ──
create or replace function private.carelog_fill_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tenant_id is null then
    new.tenant_id := coalesce(
      private.my_tenant(),
      (select t.id from public.tenants t where (select count(*) from public.tenants) = 1)
    );
  end if;
  return new;
end
$$;
revoke all on function private.carelog_fill_tenant() from public, anon, authenticated;

-- ── 0015 の部品と入口 ──
create or replace function private.care_auto_flag_on(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    (select pg_catalog.lower(pg_catalog.btrim(s.value)) in ('true', '1', 'on', 'yes', 'enabled')
       from public.app_settings s
      where s.key = p_key),
    false)
$fn$;

-- 週間計画の写し（kv_entries の care_schedule_v2）と入居者マスタの写し（master_residents）にある唯一のテナント。
-- どちらにも無ければ null（入院の判定は、ある方の写しだけで続ける）。合わせて2つ以上あれば判定できない＝例外で止める
create or replace function private.care_auto_tenant()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_n      integer;
  v_tenant uuid;
begin
  select count(*), min(t.tenant_id::text)::uuid into v_n, v_tenant
    from (select k.tenant_id from public.kv_entries k where k.key = 'care_schedule_v2'
          union
          select m.tenant_id from public.master_residents m) t;
  if v_n > 1 then
    raise exception 'care_auto: テナントが1つに定まりません（%件）', v_n;
  end if;
  return v_tenant;
end
$fn$;

create or replace function private.care_auto_med(p_slot text)
returns integer
language sql
volatile
security definer
set search_path = ''
as $fn$
  select private.care_auto_med_on(p_slot, private.care_auto_today(now()))
$fn$;

create or replace function private.care_auto_bath()
returns integer
language sql
volatile
security definer
set search_path = ''
as $fn$
  select private.care_auto_bath_on(private.care_auto_today(now()))
$fn$;

-- ── 0016 の本体と休業日 ──
create or replace function private.care_auto_med_on(p_slot text, p_on date)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_at     time;
  v_tenant uuid;
  v_n      integer;
begin
  -- 自動にするのは朝・昼・夕・眠前（頓服は自動にしない）。時刻は代表指示（日本時間）
  v_at := case p_slot
            when 'morning' then time '08:50'
            when 'noon'    then time '13:00'
            when 'evening' then time '18:20'
            when 'bedtime' then time '21:00'
          end;
  if v_at is null then
    raise exception 'care_auto_med: 自動にできない時間帯です（%）', p_slot;
  end if;
  if p_on is null then
    raise exception 'care_auto_med: 日付がありません';
  end if;

  -- 与薬の入力が解禁されていない間は何もしない（封鎖中は画面から直せない）
  if not private.care_auto_flag_on('input_enabled_med') then
    return 0;
  end if;

  -- 入院の判定に使うテナント（写しが無ければ null＝ある方の写しだけで判定する。2つ以上なら例外で止まる）
  v_tenant := private.care_auto_tenant();

  insert into public.med_admin (resident_id, admin_on, slot, status, recorded_by, auto, client_key)
  select r.id, p_on, p_slot, 'taken', null, true,
         'auto:med:' || pg_catalog.to_char(p_on, 'YYYY-MM-DD') || ':' || p_slot || ':' || r.id::text
    from public.residents r
    join public.med_slots ms
      on ms.resident_id = r.id
     and ms.deleted_at is null
     and p_slot = any (ms.slots)
   where r.active
     -- (1) 入院中（入居者マスタの写し、または週間計画の写しのどちらかで入院中）
     and not exists (
           select 1 from public.master_residents mr
            where mr.tenant_id = v_tenant
              and mr.source_id = r.source_id
              and mr.hospitalized is true)
     and not exists (
           select 1
             from public.kv_entries k
            cross join lateral pg_catalog.jsonb_array_elements(
                    case when pg_catalog.jsonb_typeof(k.data -> 'residents') = 'array'
                         then k.data -> 'residents' else '[]'::jsonb end) kr(v)
            where k.tenant_id = v_tenant
              and k.key = 'care_schedule_v2'
              and nullif(pg_catalog.btrim(kr.v ->> 'masterId'), '') = r.source_id
              and coalesce(kr.v ->> 'hospitalized', '') = 'true')
     -- (2) 外泊の期間中／外出中（帰着未定は継続中。帰着日のある外出は自動の時刻に外出の時刻がかかる時だけ）
     and not exists (
           select 1 from public.outings o
            where o.resident_id = r.id
              and o.deleted_at is null
              and o.start_on <= p_on
              and (
                    -- 外泊: 帰着日まで（帰着未定は継続中＝以降の毎日）
                    (o.kind = 'overnight' and (o.end_on is null or p_on <= o.end_on))
                    -- 外出・帰着未定: 外泊と同じく継続中（時刻は見ない）
                    or (o.kind = 'outing' and o.end_on is null)
                    or (
                         -- 外出・帰着日あり: 帰着日までの日付で、自動の時刻に外出の時刻がかかる時
                         o.kind = 'outing'
                         and o.end_on is not null
                         and p_on <= o.end_on
                         and (o.start_on < p_on or o.start_at is null or o.start_at <= v_at)
                         and (o.end_on > p_on or o.end_at is null or o.end_at >= v_at)
                       )
                  ))
     -- (3) その日その時間帯に記録が既にある（取り消し済みも含む＝職員が消した・直した後に作り直さない）
     and not exists (
           select 1 from public.med_admin a
            where a.resident_id = r.id
              and a.admin_on = p_on
              and a.slot = p_slot)
  on conflict do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

create or replace function private.care_auto_daycare_closed(p_on date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from public.app_settings s
     cross join lateral pg_catalog.unnest(pg_catalog.string_to_array(s.value, ',')) d(v)
     where s.key = 'daycare_closed_dates'
       and pg_catalog.btrim(d.v) in (pg_catalog.to_char(p_on, 'YYYY-MM-DD'), pg_catalog.to_char(p_on, 'MM-DD')))
$fn$;

create or replace function private.care_auto_bath_on(p_on date)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_tenant uuid;
  v_result text;
  v_n      integer;
begin
  if p_on is null then
    raise exception 'care_auto_bath: 日付がありません';
  end if;

  -- 入浴の入力が解禁されていない間は何もしない（封鎖中は画面から直せない）
  if not private.care_auto_flag_on('input_enabled_bath') then
    return 0;
  end if;

  -- デイの休業日（daycare_closed_dates）は訪問介護に振り替えて入浴する＝訪問介護で入浴（visit）。それ以外は全身浴（full）
  v_result := case when private.care_auto_daycare_closed(p_on) then 'visit' else 'full' end;

  -- テナント（2つ以上なら例外で止まる）。週間計画の写しが無ければ予定が無い＝0件（下の src が空になる）
  v_tenant := private.care_auto_tenant();

  -- 予定の抽出は daycare_bath_plan（0012）と同じ（auth に頼らずテナントを明示する）
  with src as (
    select k.data
      from public.kv_entries k
     where k.tenant_id = v_tenant
       and k.key = 'care_schedule_v2'
     limit 1
  ),
  plan as (
    select distinct x.source_id
      from src s
     cross join lateral pg_catalog.jsonb_array_elements(
             case when pg_catalog.jsonb_typeof(s.data -> 'residents') = 'array'
                  then s.data -> 'residents' else '[]'::jsonb end) r(v)
     cross join lateral pg_catalog.jsonb_array_elements(
             case when pg_catalog.jsonb_typeof(r.v -> 'events') = 'array'
                  then r.v -> 'events' else '[]'::jsonb end) e(v)
     cross join lateral (
       select nullif(pg_catalog.btrim(r.v ->> 'masterId'), '') as source_id
     ) x
     where x.source_id is not null
       and coalesce(r.v ->> 'movedOut', '') <> 'true'
       and coalesce(r.v ->> 'preAdmitted', '') <> 'true'
       and coalesce(r.v ->> 'external', '') <> 'true'
       and coalesce(r.v ->> 'hospitalized', '') <> 'true'
       and (e.v ->> 'serviceType') = 'daycare'
       and (e.v ->> 'bathing') = 'true'
       and (case when (e.v ->> 'dayOfWeek') ~ '^[0-6]$' then (e.v ->> 'dayOfWeek')::int end)
           = (extract(isodow from p_on)::int - 1)
  )
  insert into public.bath_records (resident_id, bath_on, result, cancel_reason, note, recorded_by, auto, client_key)
  select r.id, p_on, v_result, null, null, null, true,
         'auto:bath:' || pg_catalog.to_char(p_on, 'YYYY-MM-DD') || ':' || r.id::text
    from plan p
    join public.residents r
      on r.source_id = p.source_id
     and r.active
   where
     -- 入院中（入居者マスタの写し。写しの hospitalized は上の抽出で除いている）
     not exists (
           select 1 from public.master_residents mr
            where mr.tenant_id = v_tenant
              and mr.source_id = r.source_id
              and mr.hospitalized is true)
     -- その日に記録が既にある（取り消し済みも含む＝職員が消した・直した後に作り直さない）
     and not exists (
           select 1 from public.bath_records b
            where b.resident_id = r.id
              and b.bath_on = p_on)
  on conflict do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

-- ── 0047 の予定の写しと入口 ──
create or replace function private.daycare_auto_plan(p_date date, p_tenant uuid)
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
  bath_resident_id bigint,
  plan_rev     integer,
  updated_at   timestamptz
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with src as (
    select k.data, k.updated_at, k.rev
      from public.kv_entries k
     where k.tenant_id = p_tenant
       and k.key = 'care_schedule_v2'
     limit 1
  ),
  ok as (
    select s.data, s.updated_at, s.rev
      from src s
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
           case when f.mid is not null and not f.external and not f.hospitalized
                     and coalesce(e.v ->> 'bathing', '') = 'true'
                then (select ro.id from roster ro where ro.source_id = f.mid order by ro.id limit 1)
           end as bath_resident_id,
           f.ord,
           e.ord as eord,
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
       and (case when (e.v ->> 'dayOfWeek') ~ '^[0-6]$' then (e.v ->> 'dayOfWeek')::int end)
           = (extract(isodow from p_date)::int - 1)
  )
  select q.sched_id, q.event_id, q.resident_id, q.match, q.dup, q.external, q.hospitalized,
         q.start_time, q.end_time, q.bathing, q.bath_resident_id, q.plan_rev, q.updated_at
    from (
      select p.sched_id, p.event_id, p.resident_id, p.match, p.dup, p.external, p.hospitalized,
             p.start_time, p.end_time, p.bathing, p.bath_resident_id, s.rev as plan_rev, s.updated_at,
             0 as grp, p.start_key, p.ord, p.eord
        from plan p cross join ok s
      union all
      select null, null, null, null, null, null, null, null, null, null, null, s.rev, s.updated_at,
             1, null, null, null
        from ok s
       where not exists (select 1 from plan)
    ) q
   order by q.grp, q.start_key nulls last, q.ord, q.eord
$fn$;

create or replace function private.daycare_auto_attendance()
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $fn$
  select private.daycare_auto_attendance_at(pg_catalog.now())
$fn$;

-- ── 0048 の自動にしない方の判定 ──
create or replace function private.daycare_auto_excluded(p_rid bigint, p_day date, p_at time, p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select not exists (select 1 from public.residents r where r.id = p_rid and r.active)
      or exists (
           select 1
             from public.residents r
             join public.master_residents mr
               on mr.tenant_id = p_tenant
              and mr.source_id = r.source_id
              and mr.hospitalized is true
            where r.id = p_rid)
      or exists (
           select 1
             from public.residents r
             join public.kv_entries k
               on k.tenant_id = p_tenant
              and k.key = 'care_schedule_v2'
            cross join lateral pg_catalog.jsonb_array_elements(
                    case when pg_catalog.jsonb_typeof(k.data -> 'residents') = 'array'
                         then k.data -> 'residents' else '[]'::jsonb end) kr(v)
            where r.id = p_rid
              and nullif(pg_catalog.btrim(kr.v ->> 'masterId'), '') = r.source_id
              and coalesce(kr.v ->> 'hospitalized', '') = 'true')
      or exists (
           select 1 from public.outings o
            where o.resident_id = p_rid
              and o.deleted_at is null
              and o.start_on <= p_day
              and (
                    (o.kind = 'overnight' and (o.end_on is null or p_day <= o.end_on))
                    or (o.kind = 'outing' and o.end_on is null)
                    or (
                         o.kind = 'outing'
                         and o.end_on is not null
                         and p_day <= o.end_on
                         and (o.start_on < p_day or o.start_at is null or o.start_at <= p_at)
                         and (o.end_on > p_day or o.end_at is null or o.end_at >= p_at)
                       )
                  ))
$fn$;

-- ── 0049 の自動の到着・帰宅の本体 ──
create or replace function private.daycare_auto_attendance_at(p_at timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_day    date;
  v_time   time;
  v_tenant uuid;
  v_src    text;
  v_rows   jsonb;
  v_live   jsonb;
  v_n      integer;
  v_real   integer;
  v_rev    integer;
  v_upd    timestamptz;
  v_snap   boolean := false;
  v_arr    integer := 0;
  v_left   integer := 0;
  -- 取り戻すのは60分まで（この時刻より前の開始・終了は入れない＝反証 中3）
  v_from   timestamptz;
begin
  if p_at is null then
    raise exception 'daycare_auto_attendance: 時刻がありません';
  end if;
  v_day  := (p_at at time zone 'Asia/Tokyo')::date;
  v_time := (p_at at time zone 'Asia/Tokyo')::time;
  v_from := p_at - interval '60 minutes';

  -- 自動の旗と、デイの入力の旗（封鎖中は画面から直せないので書かない＝0015 と同じ）
  if not private.care_auto_flag_on('auto_enabled_daycare_attendance') or not private.care_auto_flag_on('input_enabled_daycare') then
    return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', false, 'skipped', 'flag');
  end if;
  -- デイの休業日（0016 の判定）
  if private.care_auto_daycare_closed(v_day) then
    return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', false, 'skipped', 'closed');
  end if;

  -- テナント（2つ以上なら例外で止まる＝何も書かない）
  v_tenant := private.care_auto_tenant();

  -- その日の予定の写し
  select d.plan_source, d.plan_rows into v_src, v_rows from public.daycare_days d where d.day = v_day;
  if not found or v_src = 'unknown' then
    -- 写しが無い・読めなかった日: いまの週間計画を読み、開始の時刻を過ぎた方が初めて出た回に写しを作る
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p)), '[]'::jsonb),
           pg_catalog.count(*),
           pg_catalog.count(*) filter (where p.sched_id is not null),
           pg_catalog.max(p.plan_rev),
           pg_catalog.max(p.updated_at)
      into v_live, v_n, v_real, v_rev, v_upd
      from private.daycare_auto_plan(v_day, v_tenant) p;
    if v_n = 0 then
      return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', false, 'skipped', 'unread');
    end if;
    if v_real = 0 then
      -- 予定なしの日は写しを作らない（職員の開所に任せる）
      return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', false, 'skipped', 'noplan');
    end if;
    if not exists (
         select 1
           from pg_catalog.jsonb_array_elements(v_live) e(v)
          where (e.v ->> 'match') in ('mid', 'name')
            and coalesce(e.v ->> 'dup', '') <> 'true'
            and coalesce(e.v ->> 'external', '') <> 'true'
            and coalesce(e.v ->> 'hospitalized', '') <> 'true'
            and private.daycare_auto_hm(e.v ->> 'start_time') <= v_time
            and ((v_day + private.daycare_auto_hm(e.v ->> 'start_time')) at time zone 'Asia/Tokyo') > v_from) then
      return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', false, 'skipped', 'early');
    end if;
    -- 写しを作る（daycare_open_day と同じ形の行・開所の職員は空）。既に職員が作っていればそれを使う。unknown の写しは1回置き換える
    insert into public.daycare_days (day, plan_source, plan_rev, plan_updated_at, plan_rows, opened_by, edited_by)
    values (v_day, 'kv', v_rev, v_upd, v_live, null, null)
    on conflict (day) do nothing;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      update public.daycare_days
         set plan_source = 'kv', plan_rev = v_rev, plan_updated_at = v_upd, plan_rows = v_live, edited_by = null
       where day = v_day and plan_source = 'unknown';
      get diagnostics v_n = row_count;
    end if;
    v_snap := v_n > 0;
    select d.plan_source, d.plan_rows into v_src, v_rows from public.daycare_days d where d.day = v_day;
  end if;
  if v_src is distinct from 'kv' then
    return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', v_snap, 'skipped', 'noplan');
  end if;

  -- 到着（開始の時刻を過ぎて60分以内の方・その日の行がまだ無い方）。終了の時刻も過ぎていれば帰宅も一緒に入れる
  with ev as (
    select (e.v ->> 'resident_id')::bigint as rid,
           private.daycare_auto_hm(e.v ->> 'start_time') as st,
           private.daycare_auto_hm(e.v ->> 'end_time') as et
      from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(v_rows) = 'array' then v_rows else '[]'::jsonb end) e(v)
     where pg_catalog.jsonb_typeof(e.v) = 'object'
       and (e.v ->> 'resident_id') ~ '^[0-9]+$'
       and (e.v ->> 'match') in ('mid', 'name')
       and coalesce(e.v ->> 'dup', '') <> 'true'
       and coalesce(e.v ->> 'external', '') <> 'true'
       and coalesce(e.v ->> 'hospitalized', '') <> 'true'
  ),
  per as (
    -- 1人1件の予定の方だけ（同じ方に予定が2件以上ある日は、データの誤りとして自動にしない＝代表者の回答 A2）
    select ev.rid, pg_catalog.min(ev.st) as st, pg_catalog.min(ev.et) as et
      from ev
     group by ev.rid
    having pg_catalog.count(*) = 1
  )
  insert into public.daycare_attendance (resident_id, day, arrived_at, left_at, arrived_auto, left_auto, recorded_by, client_key)
  select p.rid, v_day, p.st,
         case when p.et is not null and p.et <= v_time and p.et >= p.st then p.et end,
         true,
         p.et is not null and p.et <= v_time and p.et >= p.st,
         null,
         'auto:dcatt:' || pg_catalog.to_char(v_day, 'YYYY-MM-DD') || ':' || p.rid::text
    from per p
   where p.st is not null
     and p.st <= v_time
     and ((v_day + p.st) at time zone 'Asia/Tokyo') > v_from
     -- 在籍でない・入院中・外泊や外出の時刻にかかる（時刻は予定の開始）
     and not private.daycare_auto_excluded(p.rid, v_day, p.st, v_tenant)
     -- その日の生きている行がもうある（休み・手で押した到着・時刻を消した行＝人が記録・取り消した後に作り直さない）。
     -- 取り消し済みの行は数えない（休みの直後の〔元に戻す〕で「行が無い」形に戻した方には、その後も自動で入れる）
     and not exists (
           select 1 from public.daycare_attendance a
            where a.resident_id = p.rid
              and a.day = v_day
              and a.deleted_at is null)
  on conflict do nothing;
  get diagnostics v_arr = row_count;

  -- 帰宅（到着があり帰宅が無い行・終了の時刻を過ぎて60分以内の方）。予定の終了の後に行が書き換えられていたら入れない。
  -- 在籍でない・入院中・外泊や外出の時刻にかかる方（時刻は予定の終了）にも入れない（反証 軽5）
  with ev as (
    select (e.v ->> 'resident_id')::bigint as rid,
           private.daycare_auto_hm(e.v ->> 'end_time') as et
      from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(v_rows) = 'array' then v_rows else '[]'::jsonb end) e(v)
     where pg_catalog.jsonb_typeof(e.v) = 'object'
       and (e.v ->> 'resident_id') ~ '^[0-9]+$'
       and (e.v ->> 'match') in ('mid', 'name')
       and coalesce(e.v ->> 'dup', '') <> 'true'
       and coalesce(e.v ->> 'external', '') <> 'true'
       and coalesce(e.v ->> 'hospitalized', '') <> 'true'
  ),
  per as (
    -- 到着と同じく、1人1件の予定の方だけ
    select ev.rid, pg_catalog.min(ev.et) as et
      from ev
     group by ev.rid
    having pg_catalog.count(*) = 1
  )
  update public.daycare_attendance a
     set left_at = p.et,
         left_auto = true,
         -- 最後にこの行を書き換えたのは人ではない（定時の処理）＝空にする。端末は、送信待ちの書き換えをこの帰宅の後の版に
         -- 乗せ替えてよいかを「最後の書き換えが定時の処理か」で確かめる（0049・確認の反証 軽1）
         edited_by = null
    from per p
   where a.resident_id = p.rid
     and a.day = v_day
     and a.deleted_at is null
     and not a.absent
     and a.arrived_at is not null
     and a.left_at is null
     and p.et is not null
     and p.et <= v_time
     and p.et >= a.arrived_at
     and ((v_day + p.et) at time zone 'Asia/Tokyo') > v_from
     and a.updated_at <= ((v_day + p.et) at time zone 'Asia/Tokyo')
     and not private.daycare_auto_excluded(a.resident_id, v_day, p.et, v_tenant);
  get diagnostics v_left = row_count;

  return pg_catalog.jsonb_build_object('day', v_day, 'arrived', v_arr, 'left', v_left, 'snapshot', v_snap, 'skipped', null);
end
$fn$;

revoke all on function private.care_auto_flag_on(text)                              from public, anon, authenticated;
revoke all on function private.care_auto_tenant()                                   from public, anon, authenticated;
revoke all on function private.care_auto_daycare_closed(date)                       from public, anon, authenticated;
revoke all on function private.care_auto_med_on(text, date)                         from public, anon, authenticated;
revoke all on function private.care_auto_med(text)                                  from public, anon, authenticated;
revoke all on function private.care_auto_bath_on(date)                              from public, anon, authenticated;
revoke all on function private.care_auto_bath()                                     from public, anon, authenticated;
revoke all on function private.daycare_auto_plan(date, uuid)                        from public, anon, authenticated;
revoke all on function private.daycare_auto_excluded(bigint, date, time, uuid)      from public, anon, authenticated;
revoke all on function private.daycare_auto_attendance_at(timestamptz)              from public, anon, authenticated;
revoke all on function private.daycare_auto_attendance()                            from public, anon, authenticated;

-- ── 0041 のその日の予定・デイの開所 ──
create or replace function public.daycare_plan(p_date date)
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
  bath_resident_id bigint,
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
           -- 12:30 の自動の入浴（0016）がこの予定から行を作る相手（cron と同じ規則: 利用者No があり・外部でも入院中でもなく・
           -- 入浴の予定があり、利用者No で在籍者に結べる。氏名は見ない＝mismatch の予定でも入る）
           case when f.mid is not null and not f.external and not f.hospitalized
                     and coalesce(e.v ->> 'bathing', '') = 'true'
                then (select ro.id from roster ro where ro.source_id = f.mid order by ro.id limit 1)
           end as bath_resident_id,
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
         q.start_time, q.end_time, q.bathing, q.bath_resident_id, q.plan_rev, q.updated_at
    from (
      select p.sched_id, p.event_id, p.resident_id, p.match, p.dup, p.external, p.hospitalized,
             p.start_time, p.end_time, p.bathing, p.bath_resident_id, s.rev as plan_rev, s.updated_at,
             0 as grp, p.start_key, p.ord, p.eord
        from plan p cross join ok s
      union all
      -- 写しはあるが、その日の予定が無い（none）
      select null, null, null, null, null, null, null, null, null, null, null, s.rev, s.updated_at,
             1, null, null, null
        from ok s
       where not exists (select 1 from plan)
    ) q
   order by q.grp, q.start_key nulls last, q.ord, q.eord
$fn$;

revoke all on function public.daycare_plan(date) from public, anon;
grant execute on function public.daycare_plan(date) to authenticated;

create or replace function public.daycare_open_day(p_day date, p_staff bigint default null)
returns jsonb
language plpgsql
volatile
security definer
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
  if not coalesce(private.is_member(), false) then
    raise exception 'このアカウントではデイの記録を使えません（許可リストを確かめてください）' using errcode = '42501';
  end if;
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

revoke all on function public.daycare_open_day(date, bigint) from public, anon;
grant execute on function public.daycare_open_day(date, bigint) to authenticated;

-- ── 0021・0024・0025 の変更の記録 ──
create or replace function record_history_capture() returns trigger
language plpgsql
security definer
-- pg_temp を明示的に末尾へ置き、一時テーブルによる名前の乗っ取りを防ぐ（0011・0017・0020 と同じ）
set search_path = public, pg_temp
as $$
declare
  o       jsonb;
  n       jsonb;
  day_col text;
begin
  o := to_jsonb(old);
  n := to_jsonb(new);
  day_col := tg_argv[0];

  -- 版・更新時刻・触った人だけが動いた更新（内容が同じ再保存・再取込）は記録しない
  if (o - 'rev' - 'updated_at' - 'edited_by') = (n - 'rev' - 'updated_at' - 'edited_by') then
    return null;
  end if;

  insert into record_history (
    table_name, row_id, resident_id, record_day, op,
    rev_before, rev_after, old_row, new_row, changed_by_staff
  ) values (
    tg_table_name,
    (n ->> 'id')::bigint,
    (n ->> 'resident_id')::bigint,
    (n ->> day_col)::date,
    case when (o ->> 'deleted_at') is null and (n ->> 'deleted_at') is not null
         then 'delete' else 'update' end,
    (o ->> 'rev')::int,
    (n ->> 'rev')::int,
    o,
    n,
    (n ->> 'edited_by')::bigint
  );
  return null; -- after トリガなので戻り値は使われない
end;
$$;

create or replace function public.attendance_history_capture() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o jsonb;
  n jsonb;
begin
  o := to_jsonb(old);
  n := to_jsonb(new);
  -- 中身が同じ書き直し（同じ役割・同じ並び）は記録しない
  if o = n then
    return null;
  end if;

  insert into record_history (
    table_name, row_id, resident_id, record_day, op,
    rev_before, rev_after, old_row, new_row, changed_by_staff
  ) values (
    'attendance',
    new.staff_id,
    null,
    new.day,
    case when old.sort >= 0 and new.sort < 0 then 'delete' else 'update' end,
    null,
    null,
    o,
    n,
    null
  );
  return null; -- after トリガなので戻り値は使われない
end;
$$;

revoke all on function public.attendance_history_capture() from public, anon;

create or replace function public.note_alias_history_capture() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into record_history (
    table_name, row_id, resident_id, record_day, op,
    rev_before, rev_after, old_row, new_row, changed_by_staff
  ) values (
    'residents',
    new.id,
    new.id,
    null,
    'update',
    null,
    null,
    jsonb_build_object('id', old.id, 'note_alias', old.note_alias),
    jsonb_build_object('id', new.id, 'note_alias', new.note_alias),
    null
  );
  return null; -- after トリガなので戻り値は使われない
end;
$$;

revoke all on function public.note_alias_history_capture() from public, anon;


-- ── 0052 で足した関数を外す（上で使う所が無くなってから） ──
drop function if exists private.carelog_job_tenant();
drop function if exists private.carelog_cur_tenant();

notify pgrst, 'reload schema';

-- ── 確かめ（Run の結果に2行。全部 ok なら戻し終わり）──
select '0052 で足した関数が無い' as check_item,
       case when to_regprocedure('private.carelog_cur_tenant()') is null
             and to_regprocedure('private.carelog_job_tenant()') is null then 'ok' else 'NG' end as status
union all
select '定時の処理の入口が施設を回さない（0052 の前の形）',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'private' and p.proname in ('care_auto_med', 'care_auto_bath', 'daycare_auto_attendance')
                     and position('public.tenants' in p.prosrc) > 0) = 0 then 'ok' else 'NG' end;
