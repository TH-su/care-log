-- 試験専用: Supabase が最初から持っている役割と auth 関数を、素の PostgreSQL に真似て作る（tests/pg-run-all.mjs が最初に当てる）。
-- 本番の Supabase には流さない（本番には最初からある）。中身は care-backend の supabase/tests/00_supabase_stub.sql と同じ考え方で、
-- GitHub Actions からは care-backend を読めないため、このリポジトリに置く（2026-10-10 監査 F13）。
-- 役割はクラスタ全体に1つなので、同じクラスタで何度流しても止まらないように「無ければ作る」にしてある。

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
end
$$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;

-- 今の PostgREST と同じく、リクエストの JWT は request.jwt.claims に入る（実行器はここに uid を置く）
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role, supabase_auth_admin;

-- Supabase の public スキーマの既定権限（全部配る）を再現する。
-- 移行がこれを締められているかを試験で確かめるため、わざと緩い状態から始める。
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- care-log の移行が前提にしているもの
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;
