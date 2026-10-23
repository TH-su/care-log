-- =====================================================================
-- 0048: 0047（デイ 今日の画面の改善 1回目: 自動の到着・帰宅）の反証1回の直し（2026-10-23）
--
-- 0001〜0047 を当てたあとに実行する。冪等（何度実行しても同じ結果）。0047 は main に取り込まれたため書き換えない
-- （取り込み済みの移行は書き換えない約束・0043 と同じ）。表・列・ポリシー・トリガ・データ・旗・cron ジョブには触れない。
-- 関数を1つ足し（private.daycare_auto_excluded）、1つを同じ名前で置き換える（private.daycare_auto_attendance_at）だけ。
--
-- 直す3つ（定時の処理の本体）:
--   ・取り戻すのは60分まで（反証 中3）: 開始・終了の時刻から60分を過ぎた分は入れない。旗を日中に true にした・止めた後に
--     戻した・定時の処理が長く止まっていた時に、行の無い予定の方の全員へ、さかのぼって到着・帰宅が入らないようにする
--     （来なかった方の実績を作らない）。その時は写しも作らない。入れ損なった分は画面で記録する
--   ・自動にしない方の判定を到着・帰宅で同じにする（反証 軽5）: 0047 は帰宅に除外が無く、到着の後に外出・入院になった方にも
--     予定の終了の時刻で帰宅を入れていた。到着＝予定の開始・帰宅＝予定の終了の時刻で、同じ判定を通す
--   ・入院の判定に今の週間計画の写しも足す（反証 軽6・0015 の与薬の自動と同じ）: その日の写しを作った後に週間計画で入院に
--     した方にも到着を入れていた（入居者マスタの写しが同時に更新されない時）
--   0047 の他の決まり（その日の写しを見る・照合できた1人1件の予定だけ・人が記録・取り消した後に作り直さない・終了の後に
--   書き換えられた行に帰宅を入れない・休業日・旗）は変えない。
--
-- 旧クライアント×新サーバー／新クライアント×旧サーバー: 画面は定時の処理を呼ばない（cron だけが呼ぶ）ので、どちらも影響なし。
-- 0048 を当てる前（0047 だけ）は、上の3つの筋が残る（旗 auto_enabled_daycare_attendance を true にする前に当てる）。
-- 戻す時（必要な時だけ）: 0047 の本体の関数の部分をもう一度流す（0047 を流し直す＝冪等。足した関数は残してよい）。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 1. 自動にしない方の判定（到着・帰宅で同じ・新設） ----------
-- 在籍でない（名簿に無い）・入院中（入居者マスタの写し、または今の週間計画の写し＝0015 の与薬の自動と同じ）・
-- 外泊の期間中や外出中（0015 と同じ判定。p_at はその時刻＝到着は予定の開始・帰宅は予定の終了）なら true
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

comment on function private.daycare_auto_excluded(bigint, date, time, uuid) is
  '自動の到着・帰宅（0047）にしない方か（在籍でない・入院中・外泊や外出の時刻にかかる）。';

-- ---------- 2. 自動の到着・帰宅（本体・0047 の同じ名前の関数を置き換える） ----------
-- p_at の日本時間の日付と時刻で動く。返り値は {day, arrived, left, snapshot, skipped}（skipped は何もしなかった理由・動いた時は null）。
-- 試験では p_at をずらして呼ぶ（cron が呼ぶのは下の引数なしの入口だけ）
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
         left_auto = true
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

comment on function private.daycare_auto_attendance_at(timestamptz) is
  'その時刻（日本時間）の自動の到着・帰宅の本体（0047）。予定の開始・終了の時刻で記録する。{day, arrived, left, snapshot, skipped} を返す。';

-- 権限: cron（postgres）だけが呼ぶ。新設の関数と、置き換えた関数の権限を剥がし直す
revoke all on function private.daycare_auto_excluded(bigint, date, time, uuid) from public, anon, authenticated;
revoke all on function private.daycare_auto_attendance_at(timestamptz)          from public, anon, authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（結果が表で出る。目視する。列名の末尾が期待値）
-- ---------------------------------------------------------------------
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'daycare_auto_excluded')                          as excluded_fn_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'daycare_auto_attendance_at'
      and position('v_from' in p.prosrc) > 0)                                                      as window_in_body_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'daycare\_auto\_%'
      and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute')))                        as callable_by_app_0,
  (select value from public.app_settings where key = 'auto_enabled_daycare_attendance')            as auto_flag_unchanged;
