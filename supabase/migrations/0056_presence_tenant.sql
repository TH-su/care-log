-- =====================================================================
-- 0056: 「入力中」「書いています」の居場所（Presence）を施設ごとのチャンネルに分ける
--       （施設の印の段階4の続き・2026-11-05 反証レビュー 低3・代表者「勝手にばんばんすすめて」）
--
-- 0001〜0055 を当てたあとに実行する。冪等（何度流しても同じ）。begin … commit で包む。
-- なぜ: 0029 の居場所のチャンネルは全部の施設で1本（トピック cl_note_presence）で、守りは「許可リストの職員か」だけだったため、
--   2つ目の施設の職員にも1つ目の施設の職員の番号・利用者の番号・入力中の欄が届いてしまう（氏名は届かない）。
-- 何を:
--   1. public.carelog_presence_topic() … ログインした人の施設のトピック名（'cl_note_presence:' || 施設の番号）を返す。
--      許可リストに無い人・施設の決まらない人には null。画面はこれを1回聞いて、そのトピックで参加する
--   2. private.carelog_presence_topic_ok(トピック) … 参加してよいトピックか。自分の施設のトピックは常に可。
--      古い1本のトピック（cl_note_presence）は、施設がちょうど1つの間だけ可（古い版の画面が今までどおり動くため）。
--      2つ目の施設を足した瞬間に古いトピックは閉じる（古い版の画面は「入力中」が出ないだけで、保存・画面は止まらない）
--   3. 0029 の2本の守り（cl_presence_read・cl_presence_write）を、上の確かめで絞る形に置き換える（alter policy・名前は同じ）
-- 変えないもの: 表・列・データ・ほかの守り・画面の保存。Realtime の表の変更通知（postgres_changes）は 0054 の守りで施設ごと済み。
-- 旧クライアント×新サーバー: 古い版の画面は古いトピックで参加する。施設が1つの今は今までどおり見える。
-- 新クライアント×旧サーバー: 新しい版の画面は関数が無いと古いトピックで参加する（今までどおり）。
-- 戻す: supabase/rollback/0056_back.sql（守りを 0029 の形へ戻し、2つの関数を外す）。
-- ★ do $$ … $$ のブロックは使わない（関数の本文 as $fn$ … $fn$ は使ってよい）。個人情報を書かない。
-- =====================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.carelog_presence_topic()
returns text
language sql
stable
set search_path = ''
as $fn$
  select case when coalesce(private.is_member(), false) and private.my_tenant() is not null
              then 'cl_note_presence:' || private.my_tenant()::text end
$fn$;
revoke all on function public.carelog_presence_topic() from public, anon;
grant execute on function public.carelog_presence_topic() to authenticated;

-- 施設の数は、ログインした人には自分の施設の1行しか見えない（tenants の守り）ので、特別な権限で数える（数だけを返す）
create or replace function private.carelog_presence_topic_ok(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select p_topic is not null
     and (p_topic = 'cl_note_presence:' || private.my_tenant()::text
          or (p_topic = 'cl_note_presence' and (select pg_catalog.count(*) from public.tenants) = 1))
$fn$;
revoke all on function private.carelog_presence_topic_ok(text) from public, anon;
grant execute on function private.carelog_presence_topic_ok(text) to authenticated;

alter policy "cl_presence_read" on realtime.messages
  using (
    realtime.messages.extension = 'presence'
    and (select private.carelog_presence_topic_ok((select realtime.topic())))
    and (select private.is_member())
  );

alter policy "cl_presence_write" on realtime.messages
  with check (
    realtime.messages.extension = 'presence'
    and (select private.carelog_presence_topic_ok((select realtime.topic())))
    and (select private.is_member())
  );

commit;

-- ── 確かめ（読むだけ。全部 ok なら入った）──
select '居場所の守り2本が施設ごとのトピックの確かめを使う' as what,
       case when (select pg_catalog.count(*) from pg_catalog.pg_policies
                   where schemaname = 'realtime' and tablename = 'messages'
                     and policyname in ('cl_presence_read', 'cl_presence_write')
                     and coalesce(qual, with_check) like '%carelog_presence_topic_ok%'
                     and coalesce(qual, with_check) like '%is_member%') = 2
            then 'ok' else 'NG' end as result
union all
select 'ログインした人が自分の施設のトピック名を聞ける（未ログインは聞けない）',
       case when pg_catalog.has_function_privilege('authenticated', 'public.carelog_presence_topic()', 'execute')
             and not pg_catalog.has_function_privilege('anon', 'public.carelog_presence_topic()', 'execute')
            then 'ok' else 'NG' end;
