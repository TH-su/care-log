-- 試験専用: care-log の移行が参照する、care-backend（本番の Supabase の土台）と拡張の部品の最小の真似（tests/pg-run-all.mjs が当てる）。
-- 本番の Supabase には流さない（本番には care-backend の移行と pg_cron が最初からある）。2026-10-10 監査 F13。
--   ・private.is_member() … 0012〜0014・0019・0029 の member_only が使う。試験では current_setting('test.member') が 'false' の時だけ非会員
--   ・private.my_tenant()・public.kv_entries … 0012・0015・0016 が週間計画の写し（care_schedule_v2）を読む
--   ・cron.job・cron.schedule・cron.unschedule … 0015・0016 の定時ジョブの登録を受けるだけ（ジョブは動かさない）。
--     0015 の `create extension if not exists pg_cron` は、素の Postgres に pg_cron が無いので pg-run-all.mjs が当てる時だけ外す

create schema if not exists private;
grant usage on schema private to authenticated;
create or replace function private.is_member() returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('test.member', true), ''), 'true')::boolean
$$;
grant execute on function private.is_member() to authenticated;

create or replace function private.my_tenant() returns uuid language sql stable as $$
  select '00000000-0000-0000-0000-0000000000aa'::uuid
$$;
grant execute on function private.my_tenant() to authenticated;

create table if not exists public.kv_entries (
  tenant_id uuid not null,
  key text not null,
  data jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create or replace function cron.schedule(p_name text, p_sched text, p_cmd text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (p_name, p_sched, p_cmd)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;
create or replace function cron.unschedule(p_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = p_name returning 1) select exists (select 1 from d)
$$;
