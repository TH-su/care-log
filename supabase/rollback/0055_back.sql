-- 0055（冪等キーの一意を施設ごとにする）を戻す。0054 を戻す前に流す。
-- 15表の client_key の一意を、施設の印の無い形（0054 の後の形・名前は同じ・制約は制約のまま）へ戻し、
-- 欄ごとの保存（apply_cell_edits）の on conflict (tenant_id, client_key) を on conflict (client_key) へ戻す（本文はその1か所だけ）。
-- 0055 と同じく2段に分ける（1段目: 古い形の一意を足して関数を戻す・2段目: 施設の印つきの一意を外す）。どの瞬間に動いた
-- 欄ごとの保存も、名指す一意がある。
-- ★施設が2つ以上あって、施設をまたいで同じ冪等キーの行がある時は、施設をまたぐ一意に戻せない。1段目の先の確かめで、
--   重なっている件数だけを出して何も変えずに止まる（キーの値は出さない）。その時は戻さずに代表者へ渡す
--   （どちらの行のキーを付け替えるかは、その施設の記録を見て決めることになる）。
-- 2段目が錠を待てずに止まった時は、1段目だけが入った形（両方の一意がある＝今と同じに動く）で残るので、もう一度全文を流す。
-- 0055 が2段目で止まった形（仮の索引 <名前>_t が残っている）からも、この全文を流せば 0054 の後の形に戻る。
-- ★ do $$ … $$ のブロックは使わない。何度流しても同じ。

create or replace function pg_temp.carelog_ckb_list()
returns table (tbl text, name text, kind text)
language sql immutable as $fn$
  select * from (values
    ('bath_records', 'bath_records_client_key_key', 'con'),
    ('daycare_activity_log', 'daycare_activity_log_client_key_key', 'con'),
    ('daycare_attendance', 'daycare_attendance_client_key_key', 'con'),
    ('daycare_home_visits', 'daycare_home_visits_client_key_key', 'con'),
    ('daycare_staffing', 'daycare_staffing_client_key_key', 'con'),
    ('daycare_training_sessions', 'daycare_training_sessions_client_key_key', 'con'),
    ('incidents', 'incidents_client_key_key', 'con'),
    ('med_admin', 'med_admin_client_key_key', 'con'),
    ('med_slots', 'med_slots_client_key_key', 'con'),
    ('resident_targets', 'resident_targets_client_key_key', 'con'),
    ('resident_vital_limits', 'resident_vital_limits_client_key_key', 'con'),
    ('fluid_intake', 'uq_fluid_client_key', 'idx'),
    ('notes', 'uq_notes_client_key', 'idx'),
    ('outings', 'uq_outings_client_key', 'idx'),
    ('vitals', 'uq_vitals_client_key', 'idx')
  ) as x(tbl, name, kind)
$fn$;

-- ════ 1段目（取引1）════
begin;
set local lock_timeout = '5s';

-- 重なりを数えてから一意を足すまでの間に、施設をまたぐ同じキーの行が足されないよう、書き込みだけを止める（読むのは止めない）
-- （足されると一意づくりが 23505 で止まり、その誤りの文にキーの値が出るため・2026-11-05 反証レビュー4巡目 低4）
lock table public.notes, public.vitals, public.fluid_intake, public.outings,
           public.bath_records, public.med_slots, public.med_admin, public.incidents, public.resident_targets,
           public.resident_vital_limits, public.daycare_attendance, public.daycare_activity_log,
           public.daycare_training_sessions, public.daycare_home_visits, public.daycare_staffing
  in share mode;

create or replace function pg_temp.carelog_ckb_phase1()
returns void
language plpgsql
as $fn$
declare
  r      record;
  v_n    bigint;
  v_dup  bigint := 0;
  v_def  text := pg_catalog.pg_get_functiondef('public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure);
begin
  -- 施設をまたいで同じキーの行が無いか（件数だけ）
  for r in select * from pg_temp.carelog_ckb_list() loop
    execute pg_catalog.format('select pg_catalog.count(*) from (select client_key from public.%I where client_key is not null
                                group by client_key having pg_catalog.count(*) > 1) d', r.tbl) into v_n;
    v_dup := v_dup + v_n;
  end loop;
  if v_dup > 0 then
    raise exception 'tenant_client_key_back: 施設をまたいで同じ冪等キーの行が % 組あるので戻せません（何も変えていません）', v_dup;
  end if;
  for r in select * from pg_temp.carelog_ckb_list() loop
    if exists (select 1 from pg_catalog.pg_class i where i.relname = r.name and i.relnamespace = 'public'::regnamespace
                  and pg_catalog.pg_get_indexdef(i.oid) like '%USING btree (tenant_id, client_key)')
       and pg_catalog.to_regclass('public.' || r.name || '_b') is null then
      execute pg_catalog.format('create unique index %I on public.%I (client_key)', r.name || '_b', r.tbl);
    end if;
  end loop;
  if pg_catalog.strpos(v_def, 'on conflict (tenant_id, client_key) do nothing') > 0 then
    execute pg_catalog.replace(v_def, 'on conflict (tenant_id, client_key) do nothing', 'on conflict (client_key) do nothing');
  end if;
end
$fn$;
select pg_temp.carelog_ckb_phase1();

commit;

-- ════ 2段目（取引2）════
begin;
set local lock_timeout = '5s';

lock table public.notes, public.vitals, public.fluid_intake, public.outings,
           public.bath_records, public.med_slots, public.med_admin, public.incidents, public.resident_targets,
           public.resident_vital_limits, public.daycare_attendance, public.daycare_activity_log,
           public.daycare_training_sessions, public.daycare_home_visits, public.daycare_staffing
  in access exclusive mode;

create or replace function pg_temp.carelog_ckb_phase2()
returns void
language plpgsql
as $fn$
declare
  r record;
begin
  for r in select * from pg_temp.carelog_ckb_list() loop
    -- 0055 が1段目だけで止まっていた形（元の名前は古い形のまま・施設の印つきの仮の索引 <名前>_t がある）は、仮の索引を外すだけ
    --（2026-11-05 反証レビュー4巡目 中1: 外さずに ok と出て、0054 の戻しが先へ進めなくなっていた）
    if pg_catalog.to_regclass('public.' || r.name || '_t') is not null then
      execute pg_catalog.format('drop index public.%I', r.name || '_t');
    end if;
    if pg_catalog.to_regclass('public.' || r.name || '_b') is null then
      continue;  -- もう戻してある（または 0055 が入っていない）
    end if;
    if r.kind = 'con' then
      execute pg_catalog.format('alter table public.%I drop constraint %I', r.tbl, r.name);
      execute pg_catalog.format('alter index public.%I rename to %I', r.name || '_b', r.name);
      execute pg_catalog.format('alter table public.%I add constraint %I unique using index %I', r.tbl, r.name, r.name);
    else
      execute pg_catalog.format('drop index public.%I', r.name);
      execute pg_catalog.format('alter index public.%I rename to %I', r.name || '_b', r.name);
    end if;
  end loop;
end
$fn$;
select pg_temp.carelog_ckb_phase2();

commit;

-- ── 確かめ（読むだけ）──
select '冪等キーの一意15本の頭が施設の印でない（0054 の後の形・制約は制約のまま）' as what,
       case when (select pg_catalog.count(*) from pg_temp.carelog_ckb_list() l
                   join pg_catalog.pg_class i on i.relname = l.name and i.relnamespace = 'public'::regnamespace and i.relkind = 'i'
                  where pg_catalog.pg_get_indexdef(i.oid) = 'CREATE UNIQUE INDEX ' || l.name || ' ON public.' || l.tbl || ' USING btree (client_key)'
                    and (l.kind = 'con') = exists (select 1 from pg_catalog.pg_constraint k
                                                    where k.conname = l.name and k.conrelid = ('public.' || l.tbl)::regclass and k.contype = 'u')) = 15
             and not exists (select 1 from pg_temp.carelog_ckb_list() l
                              where pg_catalog.to_regclass('public.' || l.name || '_b') is not null
                                 or pg_catalog.to_regclass('public.' || l.name || '_t') is not null)
            then 'ok' else 'NG' end as result
union all
select '欄ごとの保存の冪等キーの衝突の先が 0054 の後の形',
       case when (select pg_catalog.count(*) from pg_catalog.pg_proc
                   where oid = 'public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure
                     and prosrc like '%on conflict (client_key) do nothing%' and prosrc not like '%on conflict (tenant_id, client_key)%') = 1
            then 'ok' else 'NG' end;
