-- =====================================================================
-- 0052: 施設の印（tenant_id）の段階2 ― 自動の記録（pg_cron）・デイの開所・変更の記録を施設ごとに動く形にする
--       （代表者の決定 2026-11-04「同じデータベースを施設の印で分ける」「4回に分けて入れる」の2回目）
--
-- 0001〜0051 を当てたあとに実行する。冪等（何度流しても同じ。関数を create or replace で置き換えるだけ）。
-- なぜ: 段階1（0051）で全27表に施設の印が付いたが、定時の処理（与薬・入浴・デイの到着と帰宅）は
--   「施設がちょうど1つ」を前提に書かれていて、2つ目の施設が週間計画を使い始めた時点で全部止まる
--   （care_auto_tenant が例外）。旗（app_settings）・名簿・服薬の時間帯・デイの予定の写しも施設を見ずに読む。
--   デイの開所（daycare_open_day・画面から呼ぶ）も施設を見ずに日付だけで写しを読み書きする。変更の記録は印を持たない。
-- 何を:
--   1. private.carelog_cur_tenant() … 今の施設（サーバーが set_config('carelog.tenant', …) で決めた施設、
--        無ければログインした人の施設 private.my_tenant()）
--      private.carelog_job_tenant() … 上、それも無い時は施設がちょうど1つの時だけその施設（決まらなければ null）
--      private.carelog_fill_tenant（0051 の印を入れるトリガ）は carelog_job_tenant を使う
--        （ログインした人の行の印は今と同じ。取込・定時の処理が施設を決めて書いた行には、その施設の印が入る）
--   2. 定時の処理の入口（cron が呼ぶ care_auto_med(時間帯)・care_auto_bath()・daycare_auto_attendance()）は、
--      施設（public.tenants）を1つずつ回し、carelog.tenant をその施設にして今までの本体を呼ぶ。
--      施設ごとに区切り（begin … exception）、1つの施設で失敗しても他の施設は続ける（警告に出すのは施設の番号と
--      誤りの符号だけ）。全部の施設で失敗した時だけ、最後の誤りをそのまま上げる（施設が1つの今と同じく cron の記録に
--      失敗が残る）。回し終えたら carelog.tenant を呼ぶ前の値に戻す
--   3. 本体（care_auto_med_on・care_auto_bath_on・daycare_auto_attendance_at）と部品（care_auto_flag_on・
--      care_auto_daycare_closed・daycare_auto_plan・daycare_auto_excluded）は、その施設の行だけを読み、
--      足す行に施設の印を明示する（トリガ任せにしない）。旗（app_settings）もその施設の行だけを見る。
--      読み方の決まり: 記録を「作る」側の読み（名簿・服薬の時間帯・予定の写し・旗）は施設の印で絞る。
--      「作らない」側の読み（その方の記録が既にあるか・外出中か）は、その施設の名簿で絞った利用者の番号で引き、
--      印の無い行も数える（作り直さない側に倒す）。書き換え（自動の帰宅）は施設の印で絞る
--      care_auto_tenant は carelog.tenant が決まっていればその施設を返し、決まっていなければ今と同じ
--   4. デイの開所（public.daycare_open_day）は、ログインした人の施設（private.my_tenant()）の写しだけを読み書きする。
--      public.daycare_plan の名簿・週間計画の読みは private.carelog_cur_tenant() の施設で絞る
--      （画面から直接呼んだ時も、security definer の開所の中から呼んだ時も、その人の施設の名簿だけ）。
--      引数・返り値・権限は変えない
--   5. 変更の記録のトリガ（record_history_capture・attendance_history_capture・note_alias_history_capture）は、
--      記録の行に元の行の施設の印を入れる（new、無ければ old）
-- 変えないもの: 守り（RLS・ポリシー）・一意・外部キー・null 可・表・列・データ・cron のジョブ・画面。
--   一意（app_settings の key・daycare_days の day・import_days の (source, day) など）は段階③で施設ごとにするため、
--   よその施設の行を読む・書くことはないが、それまでは一意が施設をまたいで1つなので、先にその日の写し（daycare_days）や
--   取込の日（import_days）・取込の印（import_key）を作った施設が勝ち、もう一方の施設の開所・自動の到着・取込が止まる
--   （どちらの施設が止まるかは先に作った順で決まる・2026-11-04 反証レビュー 高1・高2）。
--   ★運用の決まり: 段階③が入るまで、2つ目の施設の職員を許可リストに入れない・2つ目の施設の取込を走らせない。
--     （段階③＝0053 の後も、段階④で守りを替えるまでは同じ決まりを続ける。0053 の冒頭を見る）
--   ★施設が2つになった後に SQL Editor で app_settings に行を足す時は tenant_id を必ず書く（書かないと印が null になり、
--     旗・休業日がどの施設にも効かない・中2）。
--   施設が2つになると、1つの施設の自動の記録が失敗しても、ほかの施設が成功すれば cron の記録は成功になる
--   （失敗は WARNING に施設の番号と誤りの符号だけ残る・中1）。施設が1つの今は、失敗は今までどおり cron の失敗になる。
-- 施設が1つの今の動き: 同じ（どの読みも、今ある行は全部その施設の印を持つ。段階1の確かめで印の無い行は0）。
-- 旧クライアント×新サーバー: 画面は関数の引数・返り値・権限が同じなので今の画面のままで同じに動く。
--   画面は施設の印を送らず読まない（足した行・記録にはトリガが印を入れる）。
-- 新クライアント×旧サーバー: この移行は画面の挙動に関係しない。
-- 戻し方: supabase/rollback/0052_back.sql（前の本文をそのまま流し直し、足した2つの関数を外す）。
--   0051 を戻す前に、必ずこちらを先に戻す。
-- ★ do $$ … $$ のブロックは使わない（関数の本文 as $fn$ … $fn$ は使ってよい）。個人情報を書かない。
-- =====================================================================

-- ---------- 1. 今の施設 ----------
-- ログインした人の施設（private.my_tenant()）、無ければ（自動の記録・取込などサーバーの接続）サーバーが決めた施設
-- （set_config('carelog.tenant', …)）。★ログインした人の施設を先に見る（画面側から carelog.tenant を設定できる道が
-- 将来できても、よその施設を名乗れないように・2026-11-04 反証レビュー 中3）
-- 画面から呼ばれる daycare_plan（security invoker）が使うので authenticated も呼べる（読むだけ・引数なし）
create or replace function private.carelog_cur_tenant()
returns uuid
language sql
stable
set search_path = ''
as $fn$
  select coalesce(private.my_tenant(), nullif(pg_catalog.current_setting('carelog.tenant', true), '')::uuid)
$fn$;
revoke all on function private.carelog_cur_tenant() from public, anon;
grant execute on function private.carelog_cur_tenant() to authenticated;

-- 上、それも無い時（取込・定時の処理などサーバーの接続）は施設がちょうど1つの時だけその施設。決まらなければ null
create or replace function private.carelog_job_tenant()
returns uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    private.carelog_cur_tenant(),
    (select t.id from public.tenants t where (select pg_catalog.count(*) from public.tenants) = 1)
  )
$fn$;
revoke all on function private.carelog_job_tenant() from public, anon, authenticated;

-- 新しい行に施設の印を入れる（印が来ていればそのまま）。0051 との違いは、サーバーが決めた施設を先に見ること
create or replace function private.carelog_fill_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tenant_id is null then
    new.tenant_id := private.carelog_job_tenant();
  end if;
  return new;
end
$$;
revoke all on function private.carelog_fill_tenant() from public, anon, authenticated;

-- ---------- 2. 部品 ----------
-- 旗（app_settings）がオンか。その施設の行だけを見る（解釈は 0015 と同じ）
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
      where s.key = p_key
        and s.tenant_id = private.carelog_job_tenant()),
    false)
$fn$;

-- 週間計画の写し・入居者マスタの写しの施設。carelog.tenant が決まっていればその施設（定時の処理は施設ごとに回る）。
-- 決まっていなければ 0015 と同じ（写しにある唯一の施設・無ければ null・2つ以上なら例外）
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
  v_tenant := nullif(pg_catalog.current_setting('carelog.tenant', true), '')::uuid;
  if v_tenant is not null then
    return v_tenant;
  end if;
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

-- その日がデイの休業日か。その施設の行だけを見る（読み方は 0016 と同じ）
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
       and s.tenant_id = private.carelog_job_tenant()
       and pg_catalog.btrim(d.v) in (pg_catalog.to_char(p_on, 'YYYY-MM-DD'), pg_catalog.to_char(p_on, 'MM-DD')))
$fn$;

-- ---------- 3. 与薬の自動（本体） ----------
-- 0016 の本体と同じ。違いは、その施設の名簿・服薬の時間帯だけを読み、足す行に施設の印を明示すること
create or replace function private.care_auto_med_on(p_slot text, p_on date)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_at     time;
  v_tenant uuid;
  v_own    uuid;
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

  -- 施設（定時の処理は入口が施設ごとに決める。決まらなければ何も入れずに止める）
  v_own := private.carelog_job_tenant();
  if v_own is null then
    raise exception 'care_auto_med: 施設が1つに定まりません';
  end if;

  -- 与薬の入力が解禁されていない間は何もしない（封鎖中は画面から直せない）
  if not private.care_auto_flag_on('input_enabled_med') then
    return 0;
  end if;

  -- 入院の判定に使うテナント（写しが無ければ null＝ある方の写しだけで判定する）
  v_tenant := private.care_auto_tenant();

  insert into public.med_admin (resident_id, admin_on, slot, status, recorded_by, auto, client_key, tenant_id)
  select r.id, p_on, p_slot, 'taken', null, true,
         'auto:med:' || pg_catalog.to_char(p_on, 'YYYY-MM-DD') || ':' || p_slot || ':' || r.id::text,
         v_own
    from public.residents r
    join public.med_slots ms
      on ms.resident_id = r.id
     and ms.tenant_id = v_own
     and ms.deleted_at is null
     and p_slot = any (ms.slots)
   where r.active
     and r.tenant_id = v_own
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
     -- (2) 外泊の期間中／外出中（その施設の利用者の番号で引く＝作らない側の読み）
     and not exists (
           select 1 from public.outings o
            where o.resident_id = r.id
              and o.deleted_at is null
              and o.start_on <= p_on
              and (
                    (o.kind = 'overnight' and (o.end_on is null or p_on <= o.end_on))
                    or (o.kind = 'outing' and o.end_on is null)
                    or (
                         o.kind = 'outing'
                         and o.end_on is not null
                         and p_on <= o.end_on
                         and (o.start_on < p_on or o.start_at is null or o.start_at <= v_at)
                         and (o.end_on > p_on or o.end_at is null or o.end_at >= v_at)
                       )
                  ))
     -- (3) その日その時間帯に記録が既にある（取り消し済みも含む・その施設の利用者の番号で引く）
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

-- ---------- 4. 入浴の自動（本体） ----------
-- 0016 の本体と同じ。違いは、その施設の名簿だけと結び、足す行に施設の印を明示すること
create or replace function private.care_auto_bath_on(p_on date)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_tenant uuid;
  v_own    uuid;
  v_result text;
  v_n      integer;
begin
  if p_on is null then
    raise exception 'care_auto_bath: 日付がありません';
  end if;

  -- 施設（定時の処理は入口が施設ごとに決める。決まらなければ何も入れずに止める）
  v_own := private.carelog_job_tenant();
  if v_own is null then
    raise exception 'care_auto_bath: 施設が1つに定まりません';
  end if;

  -- 入浴の入力が解禁されていない間は何もしない（封鎖中は画面から直せない）
  if not private.care_auto_flag_on('input_enabled_bath') then
    return 0;
  end if;

  -- デイの休業日（daycare_closed_dates）は訪問介護に振り替えて入浴する＝訪問介護で入浴（visit）。それ以外は全身浴（full）
  v_result := case when private.care_auto_daycare_closed(p_on) then 'visit' else 'full' end;

  -- テナント。週間計画の写しが無ければ予定が無い＝0件（下の src が空になる）
  v_tenant := private.care_auto_tenant();

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
  insert into public.bath_records (resident_id, bath_on, result, cancel_reason, note, recorded_by, auto, client_key, tenant_id)
  select r.id, p_on, v_result, null, null, null, true,
         'auto:bath:' || pg_catalog.to_char(p_on, 'YYYY-MM-DD') || ':' || r.id::text,
         v_own
    from plan p
    join public.residents r
      on r.source_id = p.source_id
     and r.active
     and r.tenant_id = v_own
   where
     -- 入院中（入居者マスタの写し。写しの hospitalized は上の抽出で除いている）
     not exists (
           select 1 from public.master_residents mr
            where mr.tenant_id = v_tenant
              and mr.source_id = r.source_id
              and mr.hospitalized is true)
     -- その日に記録が既にある（取り消し済みも含む・その施設の利用者の番号で引く）
     and not exists (
           select 1 from public.bath_records b
            where b.resident_id = r.id
              and b.bath_on = p_on)
  on conflict do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

-- ---------- 5. デイの予定（定時の処理用）・自動にしない方 ----------
-- 0047 と同じ照合。違いは、名簿をその施設（p_tenant）の在籍者だけにすること
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
       and p.tenant_id = p_tenant
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

-- 0048 と同じ判定。違いは、在籍の確かめをその施設の名簿だけで行うこと（入院・外出は作らない側の読み＝利用者の番号で引く）
create or replace function private.daycare_auto_excluded(p_rid bigint, p_day date, p_at time, p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select not exists (select 1 from public.residents r
                      where r.id = p_rid and r.active and r.tenant_id = private.carelog_job_tenant())
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

-- ---------- 6. デイの自動の到着・帰宅（本体） ----------
-- 0049 の本体と同じ。違いは、その日の予定の写し（daycare_days）をその施設の行だけ読み書きし、
-- 足す行に施設の印を明示し、自動の帰宅をその施設の行だけに入れること。
-- その日の写しの行を作れない時（段階③までの一意＝日付だけ。よその施設がもうその日の行を持つ）は何もしない（noplan）
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
  v_own    uuid;
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

  -- 施設（定時の処理は入口が施設ごとに決める。決まらなければ何も書かずに止める）
  v_own := private.carelog_job_tenant();
  if v_own is null then
    raise exception 'daycare_auto_attendance: 施設が1つに定まりません';
  end if;

  -- 自動の旗と、デイの入力の旗（封鎖中は画面から直せないので書かない＝0015 と同じ）
  if not private.care_auto_flag_on('auto_enabled_daycare_attendance') or not private.care_auto_flag_on('input_enabled_daycare') then
    return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', false, 'skipped', 'flag');
  end if;
  -- デイの休業日（0016 の判定）
  if private.care_auto_daycare_closed(v_day) then
    return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', false, 'skipped', 'closed');
  end if;

  -- 週間計画・入居者マスタの写しの施設
  v_tenant := private.care_auto_tenant();

  -- その日の予定の写し（その施設の行）
  select d.plan_source, d.plan_rows into v_src, v_rows from public.daycare_days d where d.day = v_day and d.tenant_id = v_own;
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
    -- 写しを作る（daycare_open_day と同じ形の行・開所の職員は空）。既に職員が作っていればそれを使う。unknown の写しは1回置き換える。
    -- 衝突の先は名指ししない（今の一意は日付だけ・段階③で施設と日付になっても同じ文で動く）
    insert into public.daycare_days (day, plan_source, plan_rev, plan_updated_at, plan_rows, opened_by, edited_by, tenant_id)
    values (v_day, 'kv', v_rev, v_upd, v_live, null, null, v_own)
    on conflict do nothing;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      update public.daycare_days
         set plan_source = 'kv', plan_rev = v_rev, plan_updated_at = v_upd, plan_rows = v_live, edited_by = null
       where day = v_day and tenant_id = v_own and plan_source = 'unknown';
      get diagnostics v_n = row_count;
    end if;
    v_snap := v_n > 0;
    v_src := null;
    v_rows := null;
    select d.plan_source, d.plan_rows into v_src, v_rows from public.daycare_days d where d.day = v_day and d.tenant_id = v_own;
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
  insert into public.daycare_attendance (resident_id, day, arrived_at, left_at, arrived_auto, left_auto, recorded_by, client_key, tenant_id)
  select p.rid, v_day, p.st,
         case when p.et is not null and p.et <= v_time and p.et >= p.st then p.et end,
         true,
         p.et is not null and p.et <= v_time and p.et >= p.st,
         null,
         'auto:dcatt:' || pg_catalog.to_char(v_day, 'YYYY-MM-DD') || ':' || p.rid::text,
         v_own
    from per p
   where p.st is not null
     and p.st <= v_time
     and ((v_day + p.st) at time zone 'Asia/Tokyo') > v_from
     -- 在籍でない（その施設の名簿に無い）・入院中・外泊や外出の時刻にかかる（時刻は予定の開始）
     and not private.daycare_auto_excluded(p.rid, v_day, p.st, v_tenant)
     -- その日の生きている行がもうある（作らない側の読み＝利用者の番号で引く）
     and not exists (
           select 1 from public.daycare_attendance a
            where a.resident_id = p.rid
              and a.day = v_day
              and a.deleted_at is null)
  on conflict do nothing;
  get diagnostics v_arr = row_count;

  -- 帰宅（到着があり帰宅が無い行・終了の時刻を過ぎて60分以内の方）。予定の終了の後に行が書き換えられていたら入れない。
  -- 在籍でない・入院中・外泊や外出の時刻にかかる方（時刻は予定の終了）にも入れない（反証 軽5）。書き換えるのはその施設の行だけ
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
         -- 最後にこの行を書き換えたのは人ではない（定時の処理）＝空にする（0049・確認の反証 軽1）
         edited_by = null
    from per p
   where a.resident_id = p.rid
     and a.day = v_day
     and a.tenant_id = v_own
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

-- ---------- 7. 定時の処理の入口（cron が呼ぶ・施設ごとに回す） ----------
-- 施設を1つずつ回し、carelog.tenant をその施設にして本体を呼ぶ。施設ごとに区切り、失敗した施設は警告（施設の番号と
-- 誤りの符号だけ）を出して次の施設へ進む。全部の施設で失敗した時だけ最後の誤りをそのまま上げる（施設が1つの今と同じ）。
-- 回し終えたら carelog.tenant を呼ぶ前の値に戻す。cron のジョブの文（select private.care_auto_med('morning') など）は変えない
create or replace function private.care_auto_med(p_slot text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_prev  text := pg_catalog.current_setting('carelog.tenant', true);
  v_on    date := private.care_auto_today(pg_catalog.now());
  v_t     uuid;
  v_sum   integer := 0;
  v_ok    integer := 0;
  v_fail  integer := 0;
  v_state text;
  v_msg   text;
begin
  for v_t in select t.id from public.tenants t order by t.id loop
    begin
      perform pg_catalog.set_config('carelog.tenant', v_t::text, true);
      v_sum := v_sum + coalesce(private.care_auto_med_on(p_slot, v_on), 0);
      v_ok := v_ok + 1;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      v_fail := v_fail + 1;
      raise warning 'care_auto_med: 施設 % の自動の与薬を飛ばしました（%）', v_t, v_state;
    end;
  end loop;
  perform pg_catalog.set_config('carelog.tenant', coalesce(v_prev, ''), true);
  if v_fail > 0 and v_ok = 0 then
    raise exception using errcode = v_state, message = v_msg;
  end if;
  return v_sum;
end
$fn$;

create or replace function private.care_auto_bath()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_prev  text := pg_catalog.current_setting('carelog.tenant', true);
  v_on    date := private.care_auto_today(pg_catalog.now());
  v_t     uuid;
  v_sum   integer := 0;
  v_ok    integer := 0;
  v_fail  integer := 0;
  v_state text;
  v_msg   text;
begin
  for v_t in select t.id from public.tenants t order by t.id loop
    begin
      perform pg_catalog.set_config('carelog.tenant', v_t::text, true);
      v_sum := v_sum + coalesce(private.care_auto_bath_on(v_on), 0);
      v_ok := v_ok + 1;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      v_fail := v_fail + 1;
      raise warning 'care_auto_bath: 施設 % の自動の入浴を飛ばしました（%）', v_t, v_state;
    end;
  end loop;
  perform pg_catalog.set_config('carelog.tenant', coalesce(v_prev, ''), true);
  if v_fail > 0 and v_ok = 0 then
    raise exception using errcode = v_state, message = v_msg;
  end if;
  return v_sum;
end
$fn$;

-- 返り値は今と同じ形 {day, arrived, left, snapshot, skipped}。arrived・left は施設の合計、snapshot はどこかで写しを作ったか、
-- skipped はどこかの施設で動いた時は null・どこも動かなかった時は最初の施設の理由（施設が1つの時はその施設の返り値と同じ）
create or replace function private.daycare_auto_attendance()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_prev  text := pg_catalog.current_setting('carelog.tenant', true);
  v_at    timestamptz := pg_catalog.now();
  v_t     uuid;
  v_r     jsonb;
  v_arr   integer := 0;
  v_left  integer := 0;
  v_snap  boolean := false;
  v_ran   boolean := false;
  v_skip  text;
  v_ok    integer := 0;
  v_fail  integer := 0;
  v_state text;
  v_msg   text;
begin
  for v_t in select t.id from public.tenants t order by t.id loop
    begin
      perform pg_catalog.set_config('carelog.tenant', v_t::text, true);
      v_r := private.daycare_auto_attendance_at(v_at);
      v_arr := v_arr + coalesce((v_r ->> 'arrived')::integer, 0);
      v_left := v_left + coalesce((v_r ->> 'left')::integer, 0);
      v_snap := v_snap or coalesce((v_r ->> 'snapshot')::boolean, false);
      if (v_r ->> 'skipped') is null then
        v_ran := true;
      elsif v_ok = 0 then
        v_skip := v_r ->> 'skipped';
      end if;
      v_ok := v_ok + 1;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      v_fail := v_fail + 1;
      raise warning 'daycare_auto_attendance: 施設 % の自動の到着・帰宅を飛ばしました（%）', v_t, v_state;
    end;
  end loop;
  perform pg_catalog.set_config('carelog.tenant', coalesce(v_prev, ''), true);
  if v_fail > 0 and v_ok = 0 then
    raise exception using errcode = v_state, message = v_msg;
  end if;
  return pg_catalog.jsonb_build_object(
    'day', (v_at at time zone 'Asia/Tokyo')::date, 'arrived', v_arr, 'left', v_left, 'snapshot', v_snap,
    'skipped', case when v_ran then null when v_ok = 0 then 'notenant' else v_skip end);
end
$fn$;

-- 権限: cron（postgres）だけが呼ぶ（置き換えた関数の権限を剥がし直す）
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

-- ---------- 8. その日のデイの予定（画面から呼ぶ）・デイの開所 ----------
-- 0041 と同じ照合。違いは、週間計画と名簿を private.carelog_cur_tenant() の施設で絞ること
-- （画面から呼んだ時はログインした人の施設。security definer の開所の中から呼んだ時も同じ施設の名簿だけ）
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
     where k.tenant_id = private.carelog_cur_tenant()
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
       and p.tenant_id = private.carelog_cur_tenant()
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
           -- 12:30 の自動の入浴（0016）がこの予定から行を作る相手（cron と同じ規則）
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

-- 0041 と同じ。違いは、ログインした人の施設（private.my_tenant()）の写しだけを読み書きすること。
-- 施設が分からないログインは今の許可リスト外と同じく断る（42501）。その日の写しの行を作れない時
-- （段階③までの一意＝日付だけ。よその施設がもうその日の行を持つ）は「作れませんでした」（40001）で返す
create or replace function public.daycare_open_day(p_day date, p_staff bigint default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_today  date := (pg_catalog.now() at time zone 'Asia/Tokyo')::date;
  v_t      uuid;
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
  v_t := private.my_tenant();
  if v_t is null then
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

  select d.plan_source into v_cur from public.daycare_days d where d.day = p_day and d.tenant_id = v_t;
  if not found then
    -- 衝突の先は名指ししない（今の一意は日付だけ・段階③で施設と日付になっても同じ文で動く）
    insert into public.daycare_days (day, plan_source, plan_rev, plan_updated_at, plan_rows, opened_by, edited_by, tenant_id)
    values (p_day, v_source, v_rev, v_upd, v_rows, p_staff, p_staff, v_t)
    on conflict do nothing;
  elsif v_cur = 'unknown' and v_source <> 'unknown' then
    update public.daycare_days
       set plan_source = v_source, plan_rev = v_rev, plan_updated_at = v_upd, plan_rows = v_rows, edited_by = p_staff
     where day = p_day and tenant_id = v_t and plan_source = 'unknown';
  end if;

  select * into v_row from public.daycare_days d where d.day = p_day and d.tenant_id = v_t;
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

-- ---------- 9. 変更の記録に施設の印 ----------
-- 0021 と同じ本文。違いは、記録の行に元の行の施設の印（new、無ければ old）を入れることだけ
-- （「内容が同じなら記録しない」判定・op の判定・changed_by_staff の写しは変えない＝取込の判定が変わらない）
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
    rev_before, rev_after, old_row, new_row, changed_by_staff, tenant_id
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
    (n ->> 'edited_by')::bigint,
    coalesce(n ->> 'tenant_id', o ->> 'tenant_id')::uuid
  );
  return null; -- after トリガなので戻り値は使われない
end;
$$;

-- 0024 と同じ本文。違いは、記録の行に出勤者の行の施設の印を入れることだけ
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
    rev_before, rev_after, old_row, new_row, changed_by_staff, tenant_id
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
    null,
    coalesce(new.tenant_id, old.tenant_id)
  );
  return null; -- after トリガなので戻り値は使われない
end;
$$;

revoke all on function public.attendance_history_capture() from public, anon;

-- 0025 と同じ本文。違いは、記録の行に入居者の行の施設の印を入れることだけ（氏名などは写さない）
create or replace function public.note_alias_history_capture() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into record_history (
    table_name, row_id, resident_id, record_day, op,
    rev_before, rev_after, old_row, new_row, changed_by_staff, tenant_id
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
    null,
    coalesce(new.tenant_id, old.tenant_id)
  );
  return null; -- after トリガなので戻り値は使われない
end;
$$;

revoke all on function public.note_alias_history_capture() from public, anon;

-- PostgREST のスキーマキャッシュを即時リロード（関数を置き換えたので念のため）
notify pgrst, 'reload schema';

-- ── 確かめ（Run の結果に6行。全部 ok なら完了）──
select '今の施設を決める関数がある' as check_item,
       case when to_regprocedure('private.carelog_cur_tenant()') is not null
             and to_regprocedure('private.carelog_job_tenant()') is not null
             and position('carelog_job_tenant' in (select prosrc from pg_proc where oid = 'private.carelog_fill_tenant()'::regprocedure)) > 0
            then 'ok' else 'NG' end as status
union all
select '定時の処理の入口が施設ごとに回る（3つ）',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'private' and p.proname in ('care_auto_med', 'care_auto_bath', 'daycare_auto_attendance')
                     and position('public.tenants' in p.prosrc) > 0 and position('carelog.tenant' in p.prosrc) > 0) = 3
            then 'ok' else 'NG' end
union all
select '定時の処理の本体が施設の印を明示して書く（3つ）',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'private' and p.proname in ('care_auto_med_on', 'care_auto_bath_on', 'daycare_auto_attendance_at')
                     and position('v_own' in p.prosrc) > 0 and position('tenant_id' in p.prosrc) > 0) = 3
            then 'ok' else 'NG' end
union all
select '変更の記録に施設の印を入れる（3つ）',
       case when (select count(*) from pg_proc
                   where proname in ('record_history_capture', 'attendance_history_capture', 'note_alias_history_capture')
                     and position('tenant_id' in prosrc) > 0) = 3
            then 'ok' else 'NG' end
union all
select 'デイの開所は自分の施設の写しだけ・予定は今の施設の名簿だけ',
       case when position('my_tenant' in (select prosrc from pg_proc where oid = 'public.daycare_open_day(date, bigint)'::regprocedure)) > 0
             and position('carelog_cur_tenant' in (select prosrc from pg_proc where oid = 'public.daycare_plan(date)'::regprocedure)) > 0
            then 'ok' else 'NG' end
union all
select '定時の処理の関数をアプリから呼べない',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'private'
                     and (p.proname like 'care\_auto\_%' or p.proname like 'daycare\_auto\_%' or p.proname = 'carelog_job_tenant')
                     and (has_function_privilege('anon', p.oid, 'execute')
                          or has_function_privilege('authenticated', p.oid, 'execute'))) = 0
            then 'ok' else 'NG' end;
