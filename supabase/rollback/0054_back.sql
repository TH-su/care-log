-- 0054（施設の印の段階4）を戻す。0053 を戻す前に流す。
-- 0054 で足した守り tenant_only（27表に1本ずつ）を外し、頭に施設の印を足した一意15本（自然キー13本・出勤者と既読の主キー）を
-- 0053 の後の形（名前・条件とも）へ戻し、欄ごとの保存（apply_cell_edits）の衝突の先の2か所を戻す。今の102件の守り・表・列・記録には触れない。
-- 戻すと、許可リストの人は全部の施設の行を読める・書ける形（0053 の後）に戻る。施設が2つ以上ある時に流すと
-- よその施設の記録が見えるようになるので、その時は代表者が決めてから流す（流す前に下の確かめで施設の数が出る）。
-- ★ do $$ … $$ のブロックは使わない。何度流しても同じ。

begin;

-- 待つのは5秒まで（止まったら何も戻らないので、もう一度流す）
set local lock_timeout = '5s';

-- ── 先に確かめる（2026-11-05 反証レビュー3巡目 低1）: 0055（冪等キーの一意を施設ごと）が入っていたら、先にそちらを戻す ──
create or replace function pg_temp.carelog_stage4_back_check()
returns void
language plpgsql
as $fn$
begin
  if exists (select 1 from pg_catalog.pg_class i
              where i.relnamespace = 'public'::regnamespace and i.relkind = 'i'
                and i.relname in ('uq_vitals_client_key', 'med_admin_client_key_key', 'uq_vitals_client_key_t', 'uq_vitals_client_key_b')
                and pg_catalog.pg_get_indexdef(i.oid) like '%(tenant_id, client_key)') then
    raise exception 'tenant_stage4_back: 0055 が入っています。先に supabase/rollback/0055_back.sql を流してください（何も変えていません）';
  end if;
end
$fn$;
select pg_temp.carelog_stage4_back_check();

drop policy if exists tenant_only on public.residents;
drop policy if exists tenant_only on public.staff;
drop policy if exists tenant_only on public.vitals;
drop policy if exists tenant_only on public.meals;
drop policy if exists tenant_only on public.fluid_intake;
drop policy if exists tenant_only on public.notes;
drop policy if exists tenant_only on public.note_reads;
drop policy if exists tenant_only on public.outings;
drop policy if exists tenant_only on public.attendance;
drop policy if exists tenant_only on public.app_settings;
drop policy if exists tenant_only on public.import_days;
drop policy if exists tenant_only on public.master_sync_log;
drop policy if exists tenant_only on public.record_history;
drop policy if exists tenant_only on public.bath_records;
drop policy if exists tenant_only on public.med_slots;
drop policy if exists tenant_only on public.med_admin;
drop policy if exists tenant_only on public.incidents;
drop policy if exists tenant_only on public.resident_targets;
drop policy if exists tenant_only on public.resident_vital_limits;
drop policy if exists tenant_only on public.daycare_days;
drop policy if exists tenant_only on public.daycare_attendance;
drop policy if exists tenant_only on public.daycare_activity_log;
drop policy if exists tenant_only on public.daycare_training_sessions;
drop policy if exists tenant_only on public.daycare_home_visits;
drop policy if exists tenant_only on public.daycare_training_due;
drop policy if exists tenant_only on public.daycare_training_due_settings;
drop policy if exists tenant_only on public.daycare_staffing;

-- ── 欄ごとの保存の衝突の先を、0053 の後の形（施設の印の無い列）へ戻す（本文は今の定義のまま・2か所だけ置き換える）──
-- 一意を戻す前に戻す（同じ取引の中なので順番は問わないが、読みやすさのため）
create or replace function pg_temp.carelog_stage4_back_cell_fn()
returns void
language plpgsql
as $fn$
declare
  v_def text := pg_catalog.pg_get_functiondef('public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure);
begin
  if pg_catalog.strpos(v_def, 'on conflict (tenant_id, resident_id, ') = 0 then
    return;  -- もう戻してある
  end if;
  execute pg_catalog.replace(pg_catalog.replace(v_def,
    'on conflict (tenant_id, resident_id, measured_on) where kind = ''routine'' and deleted_at is null do nothing',
    'on conflict (resident_id, measured_on) where kind = ''routine'' and deleted_at is null do nothing'),
    'on conflict (tenant_id, resident_id, meal_on, meal_slot) where deleted_at is null do nothing',
    'on conflict (resident_id, meal_on, meal_slot) where deleted_at is null do nothing');
end
$fn$;
select pg_temp.carelog_stage4_back_cell_fn();

-- ── 自然キーの一意13本を、施設の印の無い形（0053 の後の形・名前と条件は同じ）へ戻す ──
-- 施設が2つ以上あって、施設をまたいで同じ利用者・職員の番号の行は無い（番号は1つの施設にだけ属する）ので、戻しても重複で止まらない
drop index if exists public.uq_vitals_routine_day_b4;
create unique index uq_vitals_routine_day_b4 on public.vitals (resident_id, measured_on) where kind = 'routine' and deleted_at is null;
drop index public.uq_vitals_routine_day;
alter index public.uq_vitals_routine_day_b4 rename to uq_vitals_routine_day;
drop index if exists public.uq_meals_slot_b4;
create unique index uq_meals_slot_b4 on public.meals (resident_id, meal_on, meal_slot) where deleted_at is null;
drop index public.uq_meals_slot;
alter index public.uq_meals_slot_b4 rename to uq_meals_slot;
drop index if exists public.uq_bath_records_day_b4;
create unique index uq_bath_records_day_b4 on public.bath_records (resident_id, bath_on) where deleted_at is null;
drop index public.uq_bath_records_day;
alter index public.uq_bath_records_day_b4 rename to uq_bath_records_day;
drop index if exists public.uq_med_admin_slot_b4;
create unique index uq_med_admin_slot_b4 on public.med_admin (resident_id, admin_on, slot) where deleted_at is null and slot <> 'prn';
drop index public.uq_med_admin_slot;
alter index public.uq_med_admin_slot_b4 rename to uq_med_admin_slot;
drop index if exists public.uq_med_slots_resident_b4;
create unique index uq_med_slots_resident_b4 on public.med_slots (resident_id) where deleted_at is null;
drop index public.uq_med_slots_resident;
alter index public.uq_med_slots_resident_b4 rename to uq_med_slots_resident;
drop index if exists public.uq_resident_targets_resident_b4;
create unique index uq_resident_targets_resident_b4 on public.resident_targets (resident_id) where deleted_at is null;
drop index public.uq_resident_targets_resident;
alter index public.uq_resident_targets_resident_b4 rename to uq_resident_targets_resident;
drop index if exists public.uq_resident_vital_limits_b4;
create unique index uq_resident_vital_limits_b4 on public.resident_vital_limits (resident_id, valid_from) where deleted_at is null;
drop index public.uq_resident_vital_limits;
alter index public.uq_resident_vital_limits_b4 rename to uq_resident_vital_limits;
drop index if exists public.uq_daycare_attendance_day_b4;
create unique index uq_daycare_attendance_day_b4 on public.daycare_attendance (resident_id, day) where deleted_at is null;
drop index public.uq_daycare_attendance_day;
alter index public.uq_daycare_attendance_day_b4 rename to uq_daycare_attendance_day;
drop index if exists public.uq_daycare_activity_b4;
create unique index uq_daycare_activity_b4 on public.daycare_activity_log (resident_id, day, label) where deleted_at is null;
drop index public.uq_daycare_activity;
alter index public.uq_daycare_activity_b4 rename to uq_daycare_activity;
drop index if exists public.uq_daycare_training_session_b4;
create unique index uq_daycare_training_session_b4 on public.daycare_training_sessions (resident_id, day) where deleted_at is null;
drop index public.uq_daycare_training_session;
alter index public.uq_daycare_training_session_b4 rename to uq_daycare_training_session;
drop index if exists public.uq_daycare_home_visit_b4;
create unique index uq_daycare_home_visit_b4 on public.daycare_home_visits (resident_id, visited_on, purpose) where deleted_at is null;
drop index public.uq_daycare_home_visit;
alter index public.uq_daycare_home_visit_b4 rename to uq_daycare_home_visit;
drop index if exists public.uq_daycare_training_due_b4;
create unique index uq_daycare_training_due_b4 on public.daycare_training_due (resident_id) where deleted_at is null;
drop index public.uq_daycare_training_due;
alter index public.uq_daycare_training_due_b4 rename to uq_daycare_training_due;
drop index if exists public.uq_daycare_staffing_b4;
create unique index uq_daycare_staffing_b4 on public.daycare_staffing (day, staff_id, role, coalesce(from_time, '00:00:00'::time)) where deleted_at is null;
drop index public.uq_daycare_staffing;
alter index public.uq_daycare_staffing_b4 rename to uq_daycare_staffing;
-- 出勤者・既読の主キー（名前は同じ）
alter table public.attendance drop constraint attendance_pkey;
alter table public.attendance add constraint attendance_pkey primary key (day, staff_id);
alter table public.note_reads drop constraint note_reads_pkey;
alter table public.note_reads add constraint note_reads_pkey primary key (note_id, staff_id);


commit;

-- ── 確かめ（読むだけ）──
select '足した守り tenant_only が残っていない' as what,
       case when not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and policyname = 'tenant_only')
            then 'ok' else 'NG' end as result
union all
select '一意15本の頭が施設の印でない（0053 の後の形）',
       case when (select pg_catalog.count(*) from pg_catalog.pg_class i
                   where i.relnamespace = 'public'::regnamespace and i.relkind = 'i'
                     and i.relname in ('uq_vitals_routine_day', 'uq_meals_slot', 'uq_bath_records_day', 'uq_med_admin_slot', 'uq_med_slots_resident',
                                       'uq_resident_targets_resident', 'uq_resident_vital_limits', 'uq_daycare_attendance_day', 'uq_daycare_activity',
                                       'uq_daycare_training_session', 'uq_daycare_home_visit', 'uq_daycare_training_due', 'uq_daycare_staffing',
                                       'attendance_pkey', 'note_reads_pkey')
                     and pg_catalog.pg_get_indexdef(i.oid) not like '%USING btree (tenant_id, %') = 15
            then 'ok' else 'NG' end
union all
select '欄ごとの保存の衝突の先が 0053 の後の形',
       case when (select pg_catalog.count(*) from pg_catalog.pg_proc
                   where oid = 'public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure
                     and prosrc not like '%on conflict (tenant_id, resident_id,%'
                     and prosrc like '%on conflict (resident_id, measured_on) where kind = ''routine'' and deleted_at is null do nothing%'
                     and prosrc like '%on conflict (resident_id, meal_on, meal_slot) where deleted_at is null do nothing%') = 1
            then 'ok' else 'NG' end
union all
select '施設の数（1 なら戻してもよその施設の記録は無い）', (select pg_catalog.count(*)::text from public.tenants);
