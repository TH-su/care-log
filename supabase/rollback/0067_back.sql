-- 0067 を戻す: carelog_shift_duty を 0066 の中身（職員は id・氏名・主の区分・在籍の印だけ）に戻す。表・権限は変えない。冪等。
-- 画面は facworkExclude が来ない時、外部支援専任の人も今までどおり施設の勤務に数える（出勤者・確認欄・未読者に出る）。

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
