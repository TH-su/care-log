-- 0055（冪等キーの一意を施設ごとにする）を戻す。0054 を戻す前に流す。
-- 15表の client_key の一意を、施設の印の無い形（0054 の後の形・名前は同じ・制約は制約のまま）へ戻し、
-- 欄ごとの保存（apply_cell_edits）の on conflict (tenant_id, client_key) を on conflict (client_key) へ戻す（本文はその1か所だけ）。
-- 施設が2つ以上あって同じキーの行が施設をまたいである時は、施設をまたぐ一意に戻す所で重複で止まる（begin … commit なので何も戻らない）。
-- ★ do $$ … $$ のブロックは使わない。何度流しても同じ。

begin;

-- 待つのは5秒まで（止まったら何も戻らないので、もう一度流す）
set local lock_timeout = '5s';

lock table public.bath_records, public.daycare_activity_log, public.daycare_attendance, public.daycare_home_visits, public.daycare_staffing, public.daycare_training_sessions, public.incidents, public.med_admin, public.med_slots, public.resident_targets, public.resident_vital_limits, public.fluid_intake, public.notes, public.outings, public.vitals in access exclusive mode;

-- ── 欄ごとの保存の冪等キーの衝突の先を戻す（本文は今の定義のまま・1か所だけ置き換える）──
create or replace function pg_temp.carelog_ck_back_cell_fn()
returns void
language plpgsql
as $fn$
declare
  v_def text := pg_catalog.pg_get_functiondef('public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure);
begin
  if pg_catalog.strpos(v_def, 'on conflict (tenant_id, client_key) do nothing') = 0 then
    return;  -- もう戻してある
  end if;
  execute pg_catalog.replace(v_def, 'on conflict (tenant_id, client_key) do nothing', 'on conflict (client_key) do nothing');
end
$fn$;
select pg_temp.carelog_ck_back_cell_fn();

-- ── 冪等キーの一意（制約11本）──
alter table public.bath_records drop constraint if exists bath_records_client_key_key;
alter table public.bath_records add constraint bath_records_client_key_key unique (client_key);
alter table public.daycare_activity_log drop constraint if exists daycare_activity_log_client_key_key;
alter table public.daycare_activity_log add constraint daycare_activity_log_client_key_key unique (client_key);
alter table public.daycare_attendance drop constraint if exists daycare_attendance_client_key_key;
alter table public.daycare_attendance add constraint daycare_attendance_client_key_key unique (client_key);
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_client_key_key;
alter table public.daycare_home_visits add constraint daycare_home_visits_client_key_key unique (client_key);
alter table public.daycare_staffing drop constraint if exists daycare_staffing_client_key_key;
alter table public.daycare_staffing add constraint daycare_staffing_client_key_key unique (client_key);
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_client_key_key;
alter table public.daycare_training_sessions add constraint daycare_training_sessions_client_key_key unique (client_key);
alter table public.incidents drop constraint if exists incidents_client_key_key;
alter table public.incidents add constraint incidents_client_key_key unique (client_key);
alter table public.med_admin drop constraint if exists med_admin_client_key_key;
alter table public.med_admin add constraint med_admin_client_key_key unique (client_key);
alter table public.med_slots drop constraint if exists med_slots_client_key_key;
alter table public.med_slots add constraint med_slots_client_key_key unique (client_key);
alter table public.resident_targets drop constraint if exists resident_targets_client_key_key;
alter table public.resident_targets add constraint resident_targets_client_key_key unique (client_key);
alter table public.resident_vital_limits drop constraint if exists resident_vital_limits_client_key_key;
alter table public.resident_vital_limits add constraint resident_vital_limits_client_key_key unique (client_key);
-- ── 冪等キーの一意（索引4本）──
drop index if exists public.uq_fluid_client_key_b5;
create unique index uq_fluid_client_key_b5 on public.fluid_intake (client_key);
drop index public.uq_fluid_client_key;
alter index public.uq_fluid_client_key_b5 rename to uq_fluid_client_key;
drop index if exists public.uq_notes_client_key_b5;
create unique index uq_notes_client_key_b5 on public.notes (client_key);
drop index public.uq_notes_client_key;
alter index public.uq_notes_client_key_b5 rename to uq_notes_client_key;
drop index if exists public.uq_outings_client_key_b5;
create unique index uq_outings_client_key_b5 on public.outings (client_key);
drop index public.uq_outings_client_key;
alter index public.uq_outings_client_key_b5 rename to uq_outings_client_key;
drop index if exists public.uq_vitals_client_key_b5;
create unique index uq_vitals_client_key_b5 on public.vitals (client_key);
drop index public.uq_vitals_client_key;
alter index public.uq_vitals_client_key_b5 rename to uq_vitals_client_key;

commit;

-- ── 確かめ（読むだけ）──
select '冪等キーの一意15本の頭が施設の印でない（0054 の後の形）' as what,
       case when (select pg_catalog.count(*) from pg_catalog.pg_class i
                   where i.relnamespace = 'public'::regnamespace and i.relkind = 'i'
                     and i.relname in ('bath_records_client_key_key', 'daycare_activity_log_client_key_key', 'daycare_attendance_client_key_key', 'daycare_home_visits_client_key_key', 'daycare_staffing_client_key_key', 'daycare_training_sessions_client_key_key', 'incidents_client_key_key', 'med_admin_client_key_key', 'med_slots_client_key_key', 'resident_targets_client_key_key', 'resident_vital_limits_client_key_key', 'uq_fluid_client_key', 'uq_notes_client_key', 'uq_outings_client_key', 'uq_vitals_client_key')
                     and pg_catalog.pg_get_indexdef(i.oid) like '%USING btree (client_key)') = 15
            then 'ok' else 'NG' end as result
union all
select '欄ごとの保存の冪等キーの衝突の先が 0054 の後の形',
       case when (select pg_catalog.count(*) from pg_catalog.pg_proc
                   where oid = 'public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure
                     and prosrc like '%on conflict (client_key) do nothing%' and prosrc not like '%on conflict (tenant_id, client_key)%') = 1
            then 'ok' else 'NG' end;
