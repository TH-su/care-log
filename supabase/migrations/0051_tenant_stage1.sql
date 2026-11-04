-- =====================================================================
-- 0051: 施設の印（tenant_id）の段階1 ― 全27表に施設の列を足し、今ある記録に今の施設の印を入れる
--       （代表者の決定 2026-11-04「同じデータベースを施設の印で分ける」「4回に分けて入れる」）
--
-- 0001〜0050 を当てたあとに実行する。冪等（何度流しても同じ）。
-- なぜ: ケアログの表には施設の列が無く、他の施設が同じデータベースを使い始めると、施設を越えて読み書きできてしまう。
--   4回に分けて塞ぐ。①（この SQL）列を足して印を入れる → ②自動の記録・取込・履歴を施設ごとに動く形にする
--   → ③施設をまたいでぶつかる番号を施設ごとにし、印を必須にする → ④守り（RLS）を「自分の施設だけ」に替える。
-- 何を:
--   - 27表に tenant_id（uuid・null 可・care-backend の tenants を参照）を足す
--   - 今ある行に、今の施設の印を入れる。★施設がちょうど1つの時だけ入る（2つ以上あると (select id from tenants) が
--     「2行以上」の誤りで止まる＝どの施設の記録か分からない行に印を付けない）
--   - 新しい行に印を自動で入れる（足す前のトリガ private.carelog_fill_tenant）。印が無い時は、ログインした人の施設
--     （private.my_tenant()）、それも無い時（自動の記録・取込などサーバーの接続）は施設がちょうど1つの時だけその施設。
--     どれでも決まらない時は null のまま（段階③で必須にするまでは今までどおり書ける）
-- 変えないもの: 守り（RLS・ポリシー）・一意・外部キー・関数・画面。読み書きできる範囲は今と同じ。
--   画面が受け取る行に tenant_id の列が1つ増えるだけ（画面は使わない）。
-- 旧クライアント×新サーバー: 画面は tenant_id を送らず読まないので、今の画面のままで同じに動く（足した行にはトリガが印を入れる）。
-- 戻し方（逆順）:
--   各表で drop trigger if exists carelog_fill_tenant on public.<表>; のあと alter table public.<表> drop column if exists tenant_id;
--   最後に drop function if exists private.carelog_fill_tenant();
--   （supabase/rollback/0051_back.sql にまとめてある）
-- ★ do $$ … $$ のブロックは使わない。個人情報を書かない。
-- =====================================================================

-- 新しい行に施設の印を入れる（印が来ていればそのまま）
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

-- residents
alter table public.residents add column if not exists tenant_id uuid references public.tenants(id);
update public.residents set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.residents;
create trigger carelog_fill_tenant before insert on public.residents for each row execute function private.carelog_fill_tenant();

-- staff
alter table public.staff add column if not exists tenant_id uuid references public.tenants(id);
update public.staff set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.staff;
create trigger carelog_fill_tenant before insert on public.staff for each row execute function private.carelog_fill_tenant();

-- vitals
alter table public.vitals add column if not exists tenant_id uuid references public.tenants(id);
update public.vitals set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.vitals;
create trigger carelog_fill_tenant before insert on public.vitals for each row execute function private.carelog_fill_tenant();

-- meals
alter table public.meals add column if not exists tenant_id uuid references public.tenants(id);
update public.meals set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.meals;
create trigger carelog_fill_tenant before insert on public.meals for each row execute function private.carelog_fill_tenant();

-- fluid_intake
alter table public.fluid_intake add column if not exists tenant_id uuid references public.tenants(id);
update public.fluid_intake set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.fluid_intake;
create trigger carelog_fill_tenant before insert on public.fluid_intake for each row execute function private.carelog_fill_tenant();

-- notes
alter table public.notes add column if not exists tenant_id uuid references public.tenants(id);
update public.notes set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.notes;
create trigger carelog_fill_tenant before insert on public.notes for each row execute function private.carelog_fill_tenant();

-- note_reads
alter table public.note_reads add column if not exists tenant_id uuid references public.tenants(id);
update public.note_reads set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.note_reads;
create trigger carelog_fill_tenant before insert on public.note_reads for each row execute function private.carelog_fill_tenant();

-- outings
alter table public.outings add column if not exists tenant_id uuid references public.tenants(id);
update public.outings set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.outings;
create trigger carelog_fill_tenant before insert on public.outings for each row execute function private.carelog_fill_tenant();

-- attendance
alter table public.attendance add column if not exists tenant_id uuid references public.tenants(id);
update public.attendance set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.attendance;
create trigger carelog_fill_tenant before insert on public.attendance for each row execute function private.carelog_fill_tenant();

-- app_settings
alter table public.app_settings add column if not exists tenant_id uuid references public.tenants(id);
update public.app_settings set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.app_settings;
create trigger carelog_fill_tenant before insert on public.app_settings for each row execute function private.carelog_fill_tenant();

-- import_days
alter table public.import_days add column if not exists tenant_id uuid references public.tenants(id);
update public.import_days set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.import_days;
create trigger carelog_fill_tenant before insert on public.import_days for each row execute function private.carelog_fill_tenant();

-- master_sync_log
alter table public.master_sync_log add column if not exists tenant_id uuid references public.tenants(id);
update public.master_sync_log set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.master_sync_log;
create trigger carelog_fill_tenant before insert on public.master_sync_log for each row execute function private.carelog_fill_tenant();

-- record_history
alter table public.record_history add column if not exists tenant_id uuid references public.tenants(id);
update public.record_history set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.record_history;
create trigger carelog_fill_tenant before insert on public.record_history for each row execute function private.carelog_fill_tenant();

-- bath_records
alter table public.bath_records add column if not exists tenant_id uuid references public.tenants(id);
update public.bath_records set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.bath_records;
create trigger carelog_fill_tenant before insert on public.bath_records for each row execute function private.carelog_fill_tenant();

-- med_slots
alter table public.med_slots add column if not exists tenant_id uuid references public.tenants(id);
update public.med_slots set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.med_slots;
create trigger carelog_fill_tenant before insert on public.med_slots for each row execute function private.carelog_fill_tenant();

-- med_admin
alter table public.med_admin add column if not exists tenant_id uuid references public.tenants(id);
update public.med_admin set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.med_admin;
create trigger carelog_fill_tenant before insert on public.med_admin for each row execute function private.carelog_fill_tenant();

-- incidents
alter table public.incidents add column if not exists tenant_id uuid references public.tenants(id);
update public.incidents set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.incidents;
create trigger carelog_fill_tenant before insert on public.incidents for each row execute function private.carelog_fill_tenant();

-- resident_targets
alter table public.resident_targets add column if not exists tenant_id uuid references public.tenants(id);
update public.resident_targets set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.resident_targets;
create trigger carelog_fill_tenant before insert on public.resident_targets for each row execute function private.carelog_fill_tenant();

-- resident_vital_limits
alter table public.resident_vital_limits add column if not exists tenant_id uuid references public.tenants(id);
update public.resident_vital_limits set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.resident_vital_limits;
create trigger carelog_fill_tenant before insert on public.resident_vital_limits for each row execute function private.carelog_fill_tenant();

-- daycare_days
alter table public.daycare_days add column if not exists tenant_id uuid references public.tenants(id);
update public.daycare_days set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.daycare_days;
create trigger carelog_fill_tenant before insert on public.daycare_days for each row execute function private.carelog_fill_tenant();

-- daycare_attendance
alter table public.daycare_attendance add column if not exists tenant_id uuid references public.tenants(id);
update public.daycare_attendance set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.daycare_attendance;
create trigger carelog_fill_tenant before insert on public.daycare_attendance for each row execute function private.carelog_fill_tenant();

-- daycare_activity_log
alter table public.daycare_activity_log add column if not exists tenant_id uuid references public.tenants(id);
update public.daycare_activity_log set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.daycare_activity_log;
create trigger carelog_fill_tenant before insert on public.daycare_activity_log for each row execute function private.carelog_fill_tenant();

-- daycare_training_sessions
alter table public.daycare_training_sessions add column if not exists tenant_id uuid references public.tenants(id);
update public.daycare_training_sessions set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.daycare_training_sessions;
create trigger carelog_fill_tenant before insert on public.daycare_training_sessions for each row execute function private.carelog_fill_tenant();

-- daycare_home_visits
alter table public.daycare_home_visits add column if not exists tenant_id uuid references public.tenants(id);
update public.daycare_home_visits set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.daycare_home_visits;
create trigger carelog_fill_tenant before insert on public.daycare_home_visits for each row execute function private.carelog_fill_tenant();

-- daycare_training_due
alter table public.daycare_training_due add column if not exists tenant_id uuid references public.tenants(id);
update public.daycare_training_due set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.daycare_training_due;
create trigger carelog_fill_tenant before insert on public.daycare_training_due for each row execute function private.carelog_fill_tenant();

-- daycare_training_due_settings
alter table public.daycare_training_due_settings add column if not exists tenant_id uuid references public.tenants(id);
update public.daycare_training_due_settings set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.daycare_training_due_settings;
create trigger carelog_fill_tenant before insert on public.daycare_training_due_settings for each row execute function private.carelog_fill_tenant();

-- daycare_staffing
alter table public.daycare_staffing add column if not exists tenant_id uuid references public.tenants(id);
update public.daycare_staffing set tenant_id = (select id from public.tenants) where tenant_id is null;
drop trigger if exists carelog_fill_tenant on public.daycare_staffing;
create trigger carelog_fill_tenant before insert on public.daycare_staffing for each row execute function private.carelog_fill_tenant();

-- ── 確かめ（Run の結果に3行。全部 ok なら完了）──
select '27表に施設の列がある' as check_item,
       case when (select count(*) from information_schema.columns
                   where table_schema = 'public' and column_name = 'tenant_id'
                     and table_name in ('residents', 'staff', 'vitals', 'meals', 'fluid_intake', 'notes', 'note_reads', 'outings', 'attendance', 'app_settings', 'import_days', 'master_sync_log', 'record_history', 'bath_records', 'med_slots', 'med_admin', 'incidents', 'resident_targets', 'resident_vital_limits', 'daycare_days', 'daycare_attendance', 'daycare_activity_log', 'daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due', 'daycare_training_due_settings', 'daycare_staffing')) = 27
            then 'ok' else 'NG' end as status
union all
select '27表に印を入れるトリガがある',
       case when (select count(*) from pg_trigger where tgname = 'carelog_fill_tenant' and not tgisinternal) = 27 then 'ok' else 'NG' end
union all
select '印の無い行が残っていない（施設が1つの時）',
       case when (select count(*) from public.tenants) <> 1 then 'NG（施設が1つではない）'
            when (select count(*) from public.residents where tenant_id is null)
              + (select count(*) from public.staff where tenant_id is null)
              + (select count(*) from public.vitals where tenant_id is null)
              + (select count(*) from public.meals where tenant_id is null)
              + (select count(*) from public.fluid_intake where tenant_id is null)
              + (select count(*) from public.notes where tenant_id is null)
              + (select count(*) from public.note_reads where tenant_id is null)
              + (select count(*) from public.outings where tenant_id is null)
              + (select count(*) from public.attendance where tenant_id is null)
              + (select count(*) from public.app_settings where tenant_id is null)
              + (select count(*) from public.import_days where tenant_id is null)
              + (select count(*) from public.master_sync_log where tenant_id is null)
              + (select count(*) from public.record_history where tenant_id is null)
              + (select count(*) from public.bath_records where tenant_id is null)
              + (select count(*) from public.med_slots where tenant_id is null)
              + (select count(*) from public.med_admin where tenant_id is null)
              + (select count(*) from public.incidents where tenant_id is null)
              + (select count(*) from public.resident_targets where tenant_id is null)
              + (select count(*) from public.resident_vital_limits where tenant_id is null)
              + (select count(*) from public.daycare_days where tenant_id is null)
              + (select count(*) from public.daycare_attendance where tenant_id is null)
              + (select count(*) from public.daycare_activity_log where tenant_id is null)
              + (select count(*) from public.daycare_training_sessions where tenant_id is null)
              + (select count(*) from public.daycare_home_visits where tenant_id is null)
              + (select count(*) from public.daycare_training_due where tenant_id is null)
              + (select count(*) from public.daycare_training_due_settings where tenant_id is null)
              + (select count(*) from public.daycare_staffing where tenant_id is null) = 0 then 'ok' else 'NG' end;
