-- 0056（居場所を施設ごとのチャンネルに分ける）を戻す。
-- 守り2本を 0029 の形（トピック cl_note_presence・許可リストの職員）へ戻し、0056 の2つの関数を外す。
-- 戻すと、新しい版の画面は関数が無いので古いトピックで参加する（今までどおり）。施設が2つ以上ある時に戻すと、
-- よその施設の職員の居場所（番号）が見えるようになる。
-- ★ do $$ … $$ のブロックは使わない。何度流しても同じ。

begin;
set local lock_timeout = '5s';

alter policy "cl_presence_read" on realtime.messages
  using (
    realtime.messages.extension = 'presence'
    and (select realtime.topic()) = 'cl_note_presence'
    and (select private.is_member())
  );

alter policy "cl_presence_write" on realtime.messages
  with check (
    realtime.messages.extension = 'presence'
    and (select realtime.topic()) = 'cl_note_presence'
    and (select private.is_member())
  );

drop function if exists private.carelog_presence_topic_ok(text);
drop function if exists public.carelog_presence_topic();

commit;

select '居場所の守りが 0029 の形・0056 の関数が無い' as what,
       case when (select pg_catalog.count(*) from pg_catalog.pg_policies
                   where schemaname = 'realtime' and tablename = 'messages'
                     and policyname in ('cl_presence_read', 'cl_presence_write')
                     and coalesce(qual, with_check) like '%cl_note_presence%'
                     and coalesce(qual, with_check) not like '%carelog_presence_topic_ok%') = 2
             and pg_catalog.to_regprocedure('public.carelog_presence_topic()') is null
             and pg_catalog.to_regprocedure('private.carelog_presence_topic_ok(text)') is null
            then 'ok' else 'NG' end as result;
