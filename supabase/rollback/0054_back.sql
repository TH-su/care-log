-- 0054（施設の印の段階4）を戻す。0053 を戻す前に流す。
-- 0054 で足した守り tenant_only（27表に1本ずつ）を外すだけ。今の102件の守り・表・列・記録・関数には触れない。
-- 戻すと、許可リストの人は全部の施設の行を読める・書ける形（0053 の後）に戻る。施設が2つ以上ある時に流すと
-- よその施設の記録が見えるようになるので、その時は代表者が決めてから流す（流す前に下の確かめで施設の数が出る）。
-- ★ do $$ … $$ のブロックは使わない。何度流しても同じ。

begin;

-- 待つのは5秒まで（止まったら何も戻らないので、もう一度流す）
set local lock_timeout = '5s';

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

commit;

-- ── 確かめ（読むだけ）──
select '足した守り tenant_only が残っていない' as what,
       case when not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and policyname = 'tenant_only')
            then 'ok' else 'NG' end as result
union all
select '施設の数（1 なら戻してもよその施設の記録は無い）', (select pg_catalog.count(*)::text from public.tenants);
