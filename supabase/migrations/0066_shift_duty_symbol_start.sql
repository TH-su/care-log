-- 0066: 日報の確認欄の勤務表の読み口 carelog_shift_duty が、記号の開始時刻（start）も返す（2026-11-19 代表者の指示）
--
-- 何のため: 未読者欄に職員の名前を出すのを「休みが終わった次の出勤日の、出勤の時刻より後」にするため。
--   勤務の時刻の範囲（7-16 など）と夜勤入り（(21 など）はセルの文字から開始の時刻が分かるが、
--   早・日1・遅 など記号マスタの記号は、記号マスタの start（07:00 の形）を見ないと分からない。
-- 変えるのは関数の中身だけ（同じ名前・同じ引数・同じ戻り値の型・同じ権限）。記号の項目に start を1つ足すだけで、
-- 職員（id・氏名・主の区分・在籍の印）と月（cells・subCells）は 0065 と同じ。表・守り・トリガは変えない。足すだけ。
-- 戻す SQL: supabase/rollback/0066_back.sql（0065 の中身に戻す）
-- 冪等: create or replace だけ（何度流しても同じ中身・同じ権限になる）。
-- 旧クライアント×新サーバー: 古い画面は記号の start を読まない（知らない項目は捨てる＝projectShiftSymbols）ので、今までどおり動く。
-- 新クライアント×旧サーバー: start が来ない時、記号の出勤の時刻は分からない扱い（その日の0時とみなす）＝未読者に名前が出るのが早くなるだけ。

begin;

create or replace function public.carelog_shift_duty(p_months text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_tenant uuid := private.my_tenant();
  v_mode text;
  v_staff jsonb;
  v_syms jsonb;
  v_months jsonb := '{}'::jsonb;
  v_ym text;
begin
  if not private.is_member() or v_tenant is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_months is null or pg_catalog.cardinality(p_months) < 1 or pg_catalog.cardinality(p_months) > 3 then
    raise exception 'carelog_shift_duty: 月は1〜3個' using errcode = '22023';
  end if;
  foreach v_ym in array p_months loop
    if v_ym is null or v_ym !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
      raise exception 'carelog_shift_duty: 月の形が違います' using errcode = '22023';
    end if;
  end loop;
  -- 切り替えの印: 種類ごとの印（care-backend 0007）があればそれ、無ければ staff の行の印
  if pg_catalog.to_regprocedure('private.kv_family_mode(uuid,text)') is not null then
    execute 'select private.kv_family_mode($1, ''shift'')' into v_mode using v_tenant;
  else
    select e.mode into v_mode from public.kv_entries e where e.tenant_id = v_tenant and e.key = 'staff';
  end if;
  if v_mode is distinct from 'live' then
    return pg_catalog.jsonb_build_object('mode', coalesce(v_mode, 'none'));
  end if;
  select case when pg_catalog.jsonb_typeof(e.data) = 'array' then e.data end into v_staff
    from public.kv_entries e where e.tenant_id = v_tenant and e.key = 'staff';
  select case when pg_catalog.jsonb_typeof(e.data) = 'array' then e.data end into v_syms
    from public.kv_entries e where e.tenant_id = v_tenant and e.key = 'symbols';
  foreach v_ym in array p_months loop
    v_months := v_months || pg_catalog.jsonb_build_object(v_ym, pg_catalog.jsonb_build_object(
      'plan', (select case when pg_catalog.jsonb_typeof(e.data) = 'object'
                           then pg_catalog.jsonb_build_object('cells', coalesce(e.data -> 'cells', '{}'::jsonb), 'subCells', coalesce(e.data -> 'subCells', '{}'::jsonb)) end
                 from public.kv_entries e where e.tenant_id = v_tenant and e.key = 'sched:' || v_ym || ':plan'),
      'actual', (select case when pg_catalog.jsonb_typeof(e.data) = 'object'
                             then pg_catalog.jsonb_build_object('cells', coalesce(e.data -> 'cells', '{}'::jsonb), 'subCells', coalesce(e.data -> 'subCells', '{}'::jsonb)) end
                   from public.kv_entries e where e.tenant_id = v_tenant and e.key = 'sched:' || v_ym || ':actual')));
  end loop;
  return pg_catalog.jsonb_build_object(
    'mode', 'live',
    'staff', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
               'id', case when pg_catalog.jsonb_typeof(x -> 'id') = 'string' then x -> 'id' end,
               'name', case when pg_catalog.jsonb_typeof(x -> 'name') = 'string' then x -> 'name' end,
               'mainDivision', case when pg_catalog.jsonb_typeof(x -> 'mainDivision') = 'string' then x -> 'mainDivision' end,
               'active', case when pg_catalog.jsonb_typeof(x -> 'active') = 'boolean' then x -> 'active' end,
               'status', case when pg_catalog.jsonb_typeof(x -> 'status') = 'string' then x -> 'status' end,
               'retireMonth', case when pg_catalog.jsonb_typeof(x -> 'retireMonth') = 'string' then x -> 'retireMonth' end)) order by i)
        from pg_catalog.jsonb_array_elements(v_staff) with ordinality t(x, i)
       where pg_catalog.jsonb_typeof(x) = 'object'), '[]'::jsonb),
    'symbols', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
               'code', case when pg_catalog.jsonb_typeof(x -> 'code') = 'string' then x -> 'code' end,
               'type', case when pg_catalog.jsonb_typeof(x -> 'type') = 'string' then x -> 'type' end,
               'disabled', case when pg_catalog.jsonb_typeof(x -> 'disabled') = 'boolean' then x -> 'disabled' end,
               'start', case when pg_catalog.jsonb_typeof(x -> 'start') = 'string' then x -> 'start' end)) order by i)
        from pg_catalog.jsonb_array_elements(v_syms) with ordinality t(x, i)
       where pg_catalog.jsonb_typeof(x) = 'object'), '[]'::jsonb),
    'months', v_months);
end;
$fn$;
comment on function public.carelog_shift_duty(text[]) is
  '日報の確認欄の未読者の判定に使う勤務表（職員の id・氏名・主の区分・在籍の印、記号の code・type・start、月の cells・subCells だけ）。許可リストの人・自分の施設だけ。live でなければ {mode} だけ。0065・0066（記号の start を足した）。';
revoke all on function public.carelog_shift_duty(text[]) from public, anon;
grant execute on function public.carelog_shift_duty(text[]) to authenticated;

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（読むだけ。ok なら入った）
-- ---------------------------------------------------------------------
select '勤務表の読み口が記号の start を返す（0066）・権限は authenticated だけ' as what,
       case when pg_catalog.pg_get_functiondef('public.carelog_shift_duty(text[])'::regprocedure) like '%''start''%'
             and pg_catalog.has_function_privilege('authenticated', 'public.carelog_shift_duty(text[])', 'execute')
             and not pg_catalog.has_function_privilege('anon', 'public.carelog_shift_duty(text[])', 'execute')
            then 'ok' else 'NG' end as result;
