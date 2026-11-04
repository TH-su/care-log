-- 0053（施設の印の段階3）を戻す。段階④以降を入れた後には流さない（先にそちらを戻す）。0052 を戻す前に流す。
-- 一意・主キー・外部キー・null 可・計画書の期限の写しの関数を、0052 の後の形（名前・定義・説明とも）へそのまま戻し、
-- 0053 で足した（施設の印, id）の一意と施設の印の索引を外す。表・列・記録・印を入れるトリガには触れない。
-- 施設が2つ以上ある時は、最初の確かめで何も変えずに止まる（下の確かめ）。2つ目の施設の行が施設をまたいで同じ値（利用者No・職員の名前・旗の key・取込の日・その日の写し・計画書の規則の1行・
-- 同じ日の施設長・取込の印）を持っていると、施設をまたぐ一意に戻せずに途中で止まる（begin … commit なので何も戻らない）。
-- ★ do $$ … $$ のブロックは使わない。何度流しても同じ。

begin;

-- 待つのは5秒まで（止まったら何も戻らないので、もう一度流す）
set local lock_timeout = '5s';

-- ── 先に確かめる（2026-11-04 反証レビュー 低1）──
-- 施設が2つ以上あると、施設をまたぐ一意に戻す所で誤りになり、その誤りの文に重なった値（職員の名前・利用者No など）が
-- そのまま出る。値を出さないよう、施設が1つでない時は最初に止める（表の名前も値も出さない・何も変えない）
create or replace function pg_temp.carelog_stage3_back_check()
returns void
language plpgsql
as $fn$
begin
  if (select pg_catalog.count(*) from public.tenants) <> 1 then
    raise exception 'tenant_stage3_back: 施設が1つではないので、施設をまたぐ一意に戻せません。何も変えずに止めました';
  end if;
end
$fn$;
select pg_temp.carelog_stage3_back_check();

-- ── 計画書の期限の写し（0046 の本文のまま） ──
create or replace function public.daycare_training_due_sync(p_rows jsonb, p_settings jsonb, p_staff bigint)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_existing integer;
  v_incoming integer;
  v_matched integer;
  v_matched_rows integer;
  v_cancel integer;
  v_in jsonb;
  v_now timestamptz := now();
  v_rule text;
  v_warn integer;
begin
  if not private.office_writable() then
    raise exception 'training_due_office_only: 計画書の期限の写しは、事務所のログインでだけ行えます'
      using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'training_due_bad_rows: 写しの行の形が違います' using errcode = '22023';
  end if;
  v_rule := coalesce(p_settings->>'due_rule', 'calendar');
  if v_rule not in ('calendar', 'days90', 'min') then
    v_rule := 'calendar';
  end if;
  v_warn := case when (p_settings->>'warn_days') ~ '^[0-9]{1,3}$' then (p_settings->>'warn_days')::integer else 28 end;
  if v_warn > 365 then
    v_warn := 28;
  end if;

  select count(*) into v_existing from public.daycare_training_due where deleted_at is null;
  v_incoming := pg_catalog.jsonb_array_length(p_rows);

  -- 利用者番号（residents.source_id）で結べた行だけを、値をそろえて集める。同じ方が2行来たら、後ろの行を採る（決め手を固定）
  select coalesce(pg_catalog.jsonb_agg(x), '[]'::jsonb) into v_in
    from (
      select distinct on (r.id)
             r.id as resident_id,
             nullif(e.v->>'latest_plan_date', '')::date as latest_plan_date,
             nullif(e.v->>'next_due', '')::date as next_due,
             case when e.v->>'stop_reason' in ('discharge', 'stopped', 'notNeeded') then e.v->>'stop_reason' end as stop_reason,
             nullif(e.v->>'stop_from', '')::date as stop_from,
             case when e.v->>'plan_status' in ('none', 'draft_ai', 'reviewed', 'printed', 'signed') then e.v->>'plan_status' end as plan_status
        from pg_catalog.jsonb_array_elements(p_rows) with ordinality as e(v, ord)
        join public.residents r on r.source_id = e.v->>'master_id'
       order by r.id, e.ord desc
    ) x;
  v_matched := pg_catalog.jsonb_array_length(v_in);
  -- 結べなかった行の数は、来た行のうち番号で結べなかった行の数（同じ方の2行目は「結べた」に数える）
  select count(*) into v_matched_rows
    from pg_catalog.jsonb_array_elements(p_rows) as e
    join public.residents r on r.source_id = e->>'master_id';
  select count(*) into v_cancel
    from public.daycare_training_due d
   where d.deleted_at is null
     and not exists (select 1 from pg_catalog.jsonb_to_recordset(v_in) as i(resident_id bigint) where i.resident_id = d.resident_id);

  if v_incoming = 0 and v_existing > 0 then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'empty', 'existing', v_existing);
  end if;
  if v_matched = 0 and v_existing > 0 then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'nomatch', 'existing', v_existing, 'incoming', v_incoming);
  end if;
  if v_existing > 0 and v_cancel * 2 > v_existing then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'too_many', 'existing', v_existing, 'cancel', v_cancel);
  end if;

  -- 今ある行を更新（値が同じでも写した日時は進める）
  update public.daycare_training_due d
     set latest_plan_date = i.latest_plan_date, next_due = i.next_due, stop_reason = i.stop_reason,
         stop_from = i.stop_from, plan_status = i.plan_status, synced_at = v_now, synced_by = p_staff
    from pg_catalog.jsonb_to_recordset(v_in)
         as i(resident_id bigint, latest_plan_date date, next_due date, stop_reason text, stop_from date, plan_status text)
   where d.resident_id = i.resident_id and d.deleted_at is null;
  -- 無い方は足す
  insert into public.daycare_training_due (resident_id, latest_plan_date, next_due, stop_reason, stop_from, plan_status, synced_at, synced_by)
  select i.resident_id, i.latest_plan_date, i.next_due, i.stop_reason, i.stop_from, i.plan_status, v_now, p_staff
    from pg_catalog.jsonb_to_recordset(v_in)
         as i(resident_id bigint, latest_plan_date date, next_due date, stop_reason text, stop_from date, plan_status text)
   where not exists (select 1 from public.daycare_training_due d where d.resident_id = i.resident_id and d.deleted_at is null);
  -- 今回来なかった方は取り消しの印（物理削除はしない）
  update public.daycare_training_due d
     set deleted_at = v_now, deleted_by = p_staff
   where d.deleted_at is null
     and not exists (select 1 from pg_catalog.jsonb_to_recordset(v_in) as i(resident_id bigint) where i.resident_id = d.resident_id);
  -- 規則と日数
  insert into public.daycare_training_due_settings (id, due_rule, warn_days, synced_at, synced_by, updated_at)
  values (1, v_rule, v_warn, v_now, p_staff, v_now)
  on conflict (id) do update
    set due_rule = excluded.due_rule, warn_days = excluded.warn_days,
        synced_at = excluded.synced_at, synced_by = excluded.synced_by, updated_at = excluded.updated_at;

  return pg_catalog.jsonb_build_object('ok', true, 'written', v_matched, 'unmatched', v_incoming - v_matched_rows,
                                       'cancelled', v_cancel, 'synced_at', v_now);
end;
$fn$;
comment on function public.daycare_training_due_sync(jsonb, jsonb, bigint) is
  '計画書アプリの索引の期限を daycare_training_due に写す（1回の取引・利用者番号で結ぶ・空上書きの保護つき）。事務所・管理者だけ。0046。';
revoke all on function public.daycare_training_due_sync(jsonb, jsonb, bigint) from public, anon;
grant execute on function public.daycare_training_due_sync(jsonb, jsonb, bigint) to authenticated;

-- ── 施設の印の索引を外す ──
drop index if exists public.ix_fluid_intake_tenant_id;
drop index if exists public.ix_note_reads_tenant_id;
drop index if exists public.ix_outings_tenant_id;
drop index if exists public.ix_attendance_tenant_id;
drop index if exists public.ix_master_sync_log_tenant_id;
drop index if exists public.ix_record_history_tenant_id;
drop index if exists public.ix_bath_records_tenant_id;
drop index if exists public.ix_med_slots_tenant_id;
drop index if exists public.ix_med_admin_tenant_id;
drop index if exists public.ix_incidents_tenant_id;
drop index if exists public.ix_resident_targets_tenant_id;
drop index if exists public.ix_resident_vital_limits_tenant_id;
drop index if exists public.ix_daycare_attendance_tenant_id;
drop index if exists public.ix_daycare_activity_log_tenant_id;
drop index if exists public.ix_daycare_training_sessions_tenant_id;
drop index if exists public.ix_daycare_home_visits_tenant_id;
drop index if exists public.ix_daycare_training_due_tenant_id;
drop index if exists public.ix_daycare_staffing_tenant_id;
-- ── 一意・主キーを施設をまたぐ形へ戻す ──
drop index if exists public.uq_daycare_days_day;
create unique index uq_daycare_days_day on public.daycare_days (day);
drop index if exists public.uq_attendance_manager_day;
create unique index uq_attendance_manager_day
  on public.attendance (day)
  where role = 'manager' and sort >= 0;
comment on index public.uq_attendance_manager_day is
  '日報の施設長は1日1人（表示中＝sort >= 0 の role=manager）。外した行（sort < 0）は数えない。2026-10-10 F70。';
alter table public.daycare_training_due_settings drop constraint if exists daycare_training_due_settings_pkey;
alter table public.daycare_training_due_settings add constraint daycare_training_due_settings_pkey primary key (id);
alter table public.import_days drop constraint if exists import_days_pkey;
alter table public.import_days add constraint import_days_pkey primary key (source, day);
alter table public.app_settings drop constraint if exists app_settings_pkey;
alter table public.app_settings add constraint app_settings_pkey primary key (key);
alter table public.notes drop constraint if exists notes_tenant_id_import_key_key;
alter table public.notes drop constraint if exists notes_import_key_key;
alter table public.notes add constraint notes_import_key_key unique (import_key);
alter table public.meals drop constraint if exists meals_tenant_id_import_key_key;
alter table public.meals drop constraint if exists meals_import_key_key;
alter table public.meals add constraint meals_import_key_key unique (import_key);
alter table public.vitals drop constraint if exists vitals_tenant_id_import_key_key;
alter table public.vitals drop constraint if exists vitals_import_key_key;
alter table public.vitals add constraint vitals_import_key_key unique (import_key);
alter table public.staff drop constraint if exists staff_tenant_id_name_key;
alter table public.staff drop constraint if exists staff_name_key;
alter table public.staff add constraint staff_name_key unique (name);
alter table public.residents drop constraint if exists residents_tenant_id_source_id_key;
alter table public.residents drop constraint if exists residents_source_id_key;
alter table public.residents add constraint residents_source_id_key unique (source_id);

-- ── 76本の外部キーを1列の形（番号 → id）へ戻す（名前は同じ） ──
alter table public.attendance drop constraint if exists attendance_staff_id_fkey;
alter table public.bath_records drop constraint if exists bath_records_deleted_by_fkey;
alter table public.bath_records drop constraint if exists bath_records_edited_by_fkey;
alter table public.bath_records drop constraint if exists bath_records_recorded_by_fkey;
alter table public.bath_records drop constraint if exists bath_records_resident_id_fkey;
alter table public.daycare_activity_log drop constraint if exists daycare_activity_log_deleted_by_fkey;
alter table public.daycare_activity_log drop constraint if exists daycare_activity_log_edited_by_fkey;
alter table public.daycare_activity_log drop constraint if exists daycare_activity_log_recorded_by_fkey;
alter table public.daycare_activity_log drop constraint if exists daycare_activity_log_resident_id_fkey;
alter table public.daycare_attendance drop constraint if exists daycare_attendance_deleted_by_fkey;
alter table public.daycare_attendance drop constraint if exists daycare_attendance_edited_by_fkey;
alter table public.daycare_attendance drop constraint if exists daycare_attendance_recorded_by_fkey;
alter table public.daycare_attendance drop constraint if exists daycare_attendance_resident_id_fkey;
alter table public.daycare_days drop constraint if exists daycare_days_edited_by_fkey;
alter table public.daycare_days drop constraint if exists daycare_days_opened_by_fkey;
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_deleted_by_fkey;
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_edited_by_fkey;
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_recorded_by_fkey;
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_resident_id_fkey;
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_visitor_id_fkey;
alter table public.daycare_staffing drop constraint if exists daycare_staffing_deleted_by_fkey;
alter table public.daycare_staffing drop constraint if exists daycare_staffing_edited_by_fkey;
alter table public.daycare_staffing drop constraint if exists daycare_staffing_recorded_by_fkey;
alter table public.daycare_staffing drop constraint if exists daycare_staffing_staff_id_fkey;
alter table public.daycare_training_due drop constraint if exists daycare_training_due_deleted_by_fkey;
alter table public.daycare_training_due drop constraint if exists daycare_training_due_resident_id_fkey;
alter table public.daycare_training_due drop constraint if exists daycare_training_due_synced_by_fkey;
alter table public.daycare_training_due_settings drop constraint if exists daycare_training_due_settings_synced_by_fkey;
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_assisted_by_fkey;
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_deleted_by_fkey;
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_edited_by_fkey;
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_instructor_id_fkey;
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_recorded_by_fkey;
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_resident_id_fkey;
alter table public.fluid_intake drop constraint if exists fluid_intake_deleted_by_fkey;
alter table public.fluid_intake drop constraint if exists fluid_intake_edited_by_fkey;
alter table public.fluid_intake drop constraint if exists fluid_intake_recorded_by_fkey;
alter table public.fluid_intake drop constraint if exists fluid_intake_resident_id_fkey;
alter table public.incidents drop constraint if exists incidents_confirmer_id_fkey;
alter table public.incidents drop constraint if exists incidents_deleted_by_fkey;
alter table public.incidents drop constraint if exists incidents_edited_by_fkey;
alter table public.incidents drop constraint if exists incidents_reporter_id_fkey;
alter table public.incidents drop constraint if exists incidents_resident_id_fkey;
alter table public.meals drop constraint if exists meals_deleted_by_fkey;
alter table public.meals drop constraint if exists meals_edited_by_fkey;
alter table public.meals drop constraint if exists meals_recorded_by_fkey;
alter table public.meals drop constraint if exists meals_resident_id_fkey;
alter table public.med_admin drop constraint if exists med_admin_deleted_by_fkey;
alter table public.med_admin drop constraint if exists med_admin_edited_by_fkey;
alter table public.med_admin drop constraint if exists med_admin_recorded_by_fkey;
alter table public.med_admin drop constraint if exists med_admin_resident_id_fkey;
alter table public.med_slots drop constraint if exists med_slots_deleted_by_fkey;
alter table public.med_slots drop constraint if exists med_slots_edited_by_fkey;
alter table public.med_slots drop constraint if exists med_slots_resident_id_fkey;
alter table public.note_reads drop constraint if exists note_reads_note_id_fkey;
alter table public.note_reads drop constraint if exists note_reads_staff_id_fkey;
alter table public.notes drop constraint if exists notes_deleted_by_fkey;
alter table public.notes drop constraint if exists notes_edited_by_fkey;
alter table public.notes drop constraint if exists notes_ended_by_fkey;
alter table public.notes drop constraint if exists notes_reporter_id_fkey;
alter table public.notes drop constraint if exists notes_resident_id_fkey;
alter table public.outings drop constraint if exists outings_deleted_by_fkey;
alter table public.outings drop constraint if exists outings_edited_by_fkey;
alter table public.outings drop constraint if exists outings_recorded_by_fkey;
alter table public.outings drop constraint if exists outings_resident_id_fkey;
alter table public.resident_targets drop constraint if exists resident_targets_deleted_by_fkey;
alter table public.resident_targets drop constraint if exists resident_targets_edited_by_fkey;
alter table public.resident_targets drop constraint if exists resident_targets_resident_id_fkey;
alter table public.resident_vital_limits drop constraint if exists resident_vital_limits_deleted_by_fkey;
alter table public.resident_vital_limits drop constraint if exists resident_vital_limits_edited_by_fkey;
alter table public.resident_vital_limits drop constraint if exists resident_vital_limits_resident_id_fkey;
alter table public.resident_vital_limits drop constraint if exists resident_vital_limits_set_by_fkey;
alter table public.vitals drop constraint if exists vitals_deleted_by_fkey;
alter table public.vitals drop constraint if exists vitals_edited_by_fkey;
alter table public.vitals drop constraint if exists vitals_recorded_by_fkey;
alter table public.vitals drop constraint if exists vitals_resident_id_fkey;
alter table public.notes drop constraint if exists notes_tenant_id_id_key;
alter table public.staff drop constraint if exists staff_tenant_id_id_key;
alter table public.residents drop constraint if exists residents_tenant_id_id_key;
alter table public.attendance add constraint attendance_staff_id_fkey foreign key (staff_id) references public.staff(id);
alter table public.bath_records add constraint bath_records_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.bath_records add constraint bath_records_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.bath_records add constraint bath_records_recorded_by_fkey foreign key (recorded_by) references public.staff(id);
alter table public.bath_records add constraint bath_records_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.daycare_activity_log add constraint daycare_activity_log_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.daycare_activity_log add constraint daycare_activity_log_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.daycare_activity_log add constraint daycare_activity_log_recorded_by_fkey foreign key (recorded_by) references public.staff(id);
alter table public.daycare_activity_log add constraint daycare_activity_log_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.daycare_attendance add constraint daycare_attendance_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.daycare_attendance add constraint daycare_attendance_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.daycare_attendance add constraint daycare_attendance_recorded_by_fkey foreign key (recorded_by) references public.staff(id);
alter table public.daycare_attendance add constraint daycare_attendance_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.daycare_days add constraint daycare_days_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.daycare_days add constraint daycare_days_opened_by_fkey foreign key (opened_by) references public.staff(id);
alter table public.daycare_home_visits add constraint daycare_home_visits_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.daycare_home_visits add constraint daycare_home_visits_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.daycare_home_visits add constraint daycare_home_visits_recorded_by_fkey foreign key (recorded_by) references public.staff(id);
alter table public.daycare_home_visits add constraint daycare_home_visits_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.daycare_home_visits add constraint daycare_home_visits_visitor_id_fkey foreign key (visitor_id) references public.staff(id);
alter table public.daycare_staffing add constraint daycare_staffing_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.daycare_staffing add constraint daycare_staffing_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.daycare_staffing add constraint daycare_staffing_recorded_by_fkey foreign key (recorded_by) references public.staff(id);
alter table public.daycare_staffing add constraint daycare_staffing_staff_id_fkey foreign key (staff_id) references public.staff(id);
alter table public.daycare_training_due add constraint daycare_training_due_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.daycare_training_due add constraint daycare_training_due_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.daycare_training_due add constraint daycare_training_due_synced_by_fkey foreign key (synced_by) references public.staff(id);
alter table public.daycare_training_due_settings add constraint daycare_training_due_settings_synced_by_fkey foreign key (synced_by) references public.staff(id);
alter table public.daycare_training_sessions add constraint daycare_training_sessions_assisted_by_fkey foreign key (assisted_by) references public.staff(id);
alter table public.daycare_training_sessions add constraint daycare_training_sessions_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.daycare_training_sessions add constraint daycare_training_sessions_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.daycare_training_sessions add constraint daycare_training_sessions_instructor_id_fkey foreign key (instructor_id) references public.staff(id);
alter table public.daycare_training_sessions add constraint daycare_training_sessions_recorded_by_fkey foreign key (recorded_by) references public.staff(id);
alter table public.daycare_training_sessions add constraint daycare_training_sessions_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.fluid_intake add constraint fluid_intake_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.fluid_intake add constraint fluid_intake_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.fluid_intake add constraint fluid_intake_recorded_by_fkey foreign key (recorded_by) references public.staff(id);
alter table public.fluid_intake add constraint fluid_intake_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.incidents add constraint incidents_confirmer_id_fkey foreign key (confirmer_id) references public.staff(id);
alter table public.incidents add constraint incidents_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.incidents add constraint incidents_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.incidents add constraint incidents_reporter_id_fkey foreign key (reporter_id) references public.staff(id);
alter table public.incidents add constraint incidents_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.meals add constraint meals_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.meals add constraint meals_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.meals add constraint meals_recorded_by_fkey foreign key (recorded_by) references public.staff(id);
alter table public.meals add constraint meals_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.med_admin add constraint med_admin_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.med_admin add constraint med_admin_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.med_admin add constraint med_admin_recorded_by_fkey foreign key (recorded_by) references public.staff(id);
alter table public.med_admin add constraint med_admin_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.med_slots add constraint med_slots_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.med_slots add constraint med_slots_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.med_slots add constraint med_slots_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.note_reads add constraint note_reads_note_id_fkey foreign key (note_id) references public.notes(id);
alter table public.note_reads add constraint note_reads_staff_id_fkey foreign key (staff_id) references public.staff(id);
alter table public.notes add constraint notes_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.notes add constraint notes_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.notes add constraint notes_ended_by_fkey foreign key (ended_by) references public.staff(id);
alter table public.notes add constraint notes_reporter_id_fkey foreign key (reporter_id) references public.staff(id);
alter table public.notes add constraint notes_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.outings add constraint outings_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.outings add constraint outings_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.outings add constraint outings_recorded_by_fkey foreign key (recorded_by) references public.staff(id);
alter table public.outings add constraint outings_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.resident_targets add constraint resident_targets_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.resident_targets add constraint resident_targets_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.resident_targets add constraint resident_targets_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.resident_vital_limits add constraint resident_vital_limits_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.resident_vital_limits add constraint resident_vital_limits_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.resident_vital_limits add constraint resident_vital_limits_resident_id_fkey foreign key (resident_id) references public.residents(id);
alter table public.resident_vital_limits add constraint resident_vital_limits_set_by_fkey foreign key (set_by) references public.staff(id);
alter table public.vitals add constraint vitals_deleted_by_fkey foreign key (deleted_by) references public.staff(id);
alter table public.vitals add constraint vitals_edited_by_fkey foreign key (edited_by) references public.staff(id);
alter table public.vitals add constraint vitals_recorded_by_fkey foreign key (recorded_by) references public.staff(id);
alter table public.vitals add constraint vitals_resident_id_fkey foreign key (resident_id) references public.residents(id);
-- ── 施設の印を null 可へ戻す ──
alter table public.residents alter column tenant_id drop not null;
alter table public.staff alter column tenant_id drop not null;
alter table public.vitals alter column tenant_id drop not null;
alter table public.meals alter column tenant_id drop not null;
alter table public.fluid_intake alter column tenant_id drop not null;
alter table public.notes alter column tenant_id drop not null;
alter table public.note_reads alter column tenant_id drop not null;
alter table public.outings alter column tenant_id drop not null;
alter table public.attendance alter column tenant_id drop not null;
alter table public.app_settings alter column tenant_id drop not null;
alter table public.import_days alter column tenant_id drop not null;
alter table public.master_sync_log alter column tenant_id drop not null;
alter table public.record_history alter column tenant_id drop not null;
alter table public.bath_records alter column tenant_id drop not null;
alter table public.med_slots alter column tenant_id drop not null;
alter table public.med_admin alter column tenant_id drop not null;
alter table public.incidents alter column tenant_id drop not null;
alter table public.resident_targets alter column tenant_id drop not null;
alter table public.resident_vital_limits alter column tenant_id drop not null;
alter table public.daycare_days alter column tenant_id drop not null;
alter table public.daycare_attendance alter column tenant_id drop not null;
alter table public.daycare_activity_log alter column tenant_id drop not null;
alter table public.daycare_training_sessions alter column tenant_id drop not null;
alter table public.daycare_home_visits alter column tenant_id drop not null;
alter table public.daycare_training_due alter column tenant_id drop not null;
alter table public.daycare_training_due_settings alter column tenant_id drop not null;
alter table public.daycare_staffing alter column tenant_id drop not null;
commit;

notify pgrst, 'reload schema';

-- ── 確かめ（Run の結果に3行。全部 ok なら戻し終わり）──
select '施設の印が null 可に戻った（27表）' as check_item,
       case when (select pg_catalog.count(*) from information_schema.columns
                   where table_schema = 'public' and column_name = 'tenant_id' and is_nullable = 'YES'
                     and table_name in ('residents', 'staff', 'vitals', 'meals', 'fluid_intake', 'notes', 'note_reads', 'outings', 'attendance', 'app_settings', 'import_days', 'master_sync_log', 'record_history', 'bath_records', 'med_slots', 'med_admin', 'incidents', 'resident_targets', 'resident_vital_limits', 'daycare_days', 'daycare_attendance', 'daycare_activity_log', 'daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due', 'daycare_training_due_settings', 'daycare_staffing')) = 27
            then 'ok' else 'NG' end as status
union all
select '利用者・職員・申し送りを指す外部キーは76本とも1列の形',
       case when (select pg_catalog.count(*) from pg_catalog.pg_constraint k
                   where k.contype = 'f' and k.confrelid in ('public.residents'::regclass, 'public.staff'::regclass, 'public.notes'::regclass)
                     and pg_catalog.cardinality(k.conkey) = 1) = 76
            then 'ok' else 'NG' end
union all
select '一意・主キーが 0052 の後の形',
       case when pg_catalog.pg_get_constraintdef((select oid from pg_catalog.pg_constraint where conname = 'app_settings_pkey' and conrelid = 'public.app_settings'::regclass)) = 'PRIMARY KEY (key)'
             and pg_catalog.pg_get_constraintdef((select oid from pg_catalog.pg_constraint where conname = 'import_days_pkey' and conrelid = 'public.import_days'::regclass)) = 'PRIMARY KEY (source, day)'
             and (select pg_catalog.count(*) from pg_catalog.pg_constraint
                   where conname in ('residents_source_id_key', 'staff_name_key', 'vitals_import_key_key', 'meals_import_key_key', 'notes_import_key_key')) = 5
             and not exists (select 1 from pg_catalog.pg_constraint where conname like '%\_tenant\_id\_%\_key' and conrelid in ('public.residents'::regclass, 'public.staff'::regclass, 'public.notes'::regclass, 'public.vitals'::regclass, 'public.meals'::regclass))
            then 'ok' else 'NG' end;
