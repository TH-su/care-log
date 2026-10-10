-- tests/migrations-pg.mjs が使う Realtime 認可の真似（0029 を素の Postgres に当てるため）。本物の Supabase には最初からあるので本番には流さない。
-- 当てる順: care-backend の supabase/tests/00_supabase_stub.sql → private.is_member() の差し替え → この真似 → migrations 0001〜
-- 試験専用: Supabase の Realtime 認可（realtime.messages と realtime.topic()）の最小の真似。
-- 本物は Realtime サーバーが参加・track のたびに、利用者の JWT の役割で realtime.messages の RLS を確かめる。
-- ここでは set_config('realtime.topic', …) と select / insert で同じ判定を起こす。
create schema if not exists realtime;
grant usage on schema realtime to anon, authenticated;
create table if not exists realtime.messages (
  id uuid not null default gen_random_uuid() primary key,
  topic text not null,
  extension text not null,
  payload jsonb,
  event text,
  private boolean default false,
  inserted_at timestamp not null default now(),
  updated_at timestamp not null default now()
);
alter table realtime.messages enable row level security;
grant select, insert on realtime.messages to anon, authenticated;
create or replace function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')::text
$$;
grant execute on function realtime.topic() to anon, authenticated;
