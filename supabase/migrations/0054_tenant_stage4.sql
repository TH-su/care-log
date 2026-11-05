-- =====================================================================
-- 0054: 施設の印（tenant_id）の段階4 ― ログインした人は、自分の施設の行だけを読める・書ける
--       （代表者の決定 2026-11-04「同じデータベースを施設の印で分ける」「4回に分けて入れる」の4回目・
--        2026-11-05「1本ずつ足す」）
--
-- 0001〜0053 を当てたあとに実行する。冪等（何度流しても同じ。守りは名前を決めて外してから付け直す）。
-- begin … commit で包む（途中で止まった時は何も入らない）。表の錠を待つのは5秒まで（lock_timeout）。
-- なぜ: 段階3（0053）で27表の施設の印が必須になり、よその施設の利用者・職員・申し送りを指す記録は作れなくなったが、
--   守り（RLS）はまだ「許可リストの人は全部の施設の行を読める・書ける」（read_auth の using(true) など）のまま。
--   2つ目の施設の職員がログインすると、1つ目の施設の記録が読めてしまう。
-- 何を:
--   1. 先に確かめる（どれか1つでも合わなければ、何も変えずに誤りで止める）
--      - 27表とも守りが入っている（RLS が有効）・施設の印が必須
--      - 27表とも今の「許可リストの人だけ」の守り（member_only・restrictive）がある
--   2. 27表に、守り tenant_only を1本ずつ足す（restrictive＝今の守りのどれとも「かつ」でつながる・
--      ログインした人（authenticated）の読む・足す・直す・消すの全部に効く）
--        using      (tenant_id = (select private.my_tenant()))   … 読む・直す・消す時、自分の施設の行だけが見える
--        with check (tenant_id = (select private.my_tenant()))   … 足す・直す時、自分の施設の印の行だけを書ける
--      （足す時の印は、印を入れるトリガ carelog_fill_tenant（0051・0052）が先にログインした人の施設を入れる。
--        画面は印を送らない。よその施設の印を送っても、直してよその施設へ移しても、42501 で止まる）
--      （select …）で包むのは、1回の問い合わせで施設を1回だけ調べるため（行ごとに調べない・0053 の施設の印の索引が効く）
-- 変えないもの: 今の102件の守り（member_only・read_auth・insert_*・update_* の本文と名前）・表・列・データ・
--   印を入れるトリガ・関数・cron のジョブ・画面・取込の道具。
--   サーバーの接続（自動の記録・取込・cron。postgres・service_role）は守りを通らないので、今までどおり（施設ごとに回る＝0052）。
--   特別な権限で動く関数（daycare_open_day・履歴の記録のトリガ）は 0052 で施設ごとにしてある（ここでは触らない）。
-- 施設が1つの今の動き: 同じ（どの行もログインした人の施設の印を持つので、全部の行がこれまでどおり見え・書ける）。
--   許可リストに無い人・ログインしていない人は、今までどおり member_only で何も見えない。
-- 旧クライアント×新サーバー: 画面は施設の印を送らず読まない＝同じ版のまま動く（画面の公開は要らない）。
-- 戻す: supabase/rollback/0054_back.sql（足した27本の守りを外すだけ）。0053 を戻す前に、必ずこちらを先に戻す。
-- 流し方: SQL Editor で全文を貼る → Run。最後の確かめ（3行）が全部 ok なら完了。
--   流している間（1秒ほど）は27表が錠で止まり、画面の読み書きは待ってから通る。自動の記録・デイの自動（5分ごと）・
--   毎時の取込の時刻を避ける。錠を5秒待っても取れない時は誤りで止まり何も入らないので、少し置いてもう一度流す。
-- ★ do $$ … $$ のブロックは使わない（関数の本文 as $fn$ … $fn$ は使ってよい）。個人情報を書かない。
-- =====================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp.carelog_stage4_tables() returns text[] language sql immutable as $fn$
  select array['residents', 'staff', 'vitals', 'meals', 'fluid_intake', 'notes', 'note_reads', 'outings', 'attendance',
               'app_settings', 'import_days', 'master_sync_log', 'record_history', 'bath_records', 'med_slots', 'med_admin',
               'incidents', 'resident_targets', 'resident_vital_limits', 'daycare_days', 'daycare_attendance',
               'daycare_activity_log', 'daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due',
               'daycare_training_due_settings', 'daycare_staffing']::text[]
$fn$;

-- ── 1. 先に確かめる ──
create or replace function pg_temp.carelog_stage4_check()
returns void
language plpgsql
as $fn$
declare
  v_t    text;
  v_bad  text[] := '{}';
begin
  foreach v_t in array pg_temp.carelog_stage4_tables() loop
    if pg_catalog.to_regclass('public.' || v_t) is null then
      v_bad := v_bad || (v_t || '（表が無い）');
      continue;
    end if;
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('public.' || v_t)) then
      v_bad := v_bad || (v_t || '（守りが入っていない）');
    end if;
    if not exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = pg_catalog.to_regclass('public.' || v_t) and a.attname = 'tenant_id'
                      and a.attnotnull and not a.attisdropped) then
      v_bad := v_bad || (v_t || '（施設の印が必須でない＝0053 が先）');
    end if;
    if not exists (select 1 from pg_catalog.pg_policies p
                    where p.schemaname = 'public' and p.tablename = v_t and p.policyname = 'member_only'
                      and p.permissive = 'RESTRICTIVE') then
      v_bad := v_bad || (v_t || '（許可リストの守り member_only が無い）');
    end if;
  end loop;
  if pg_catalog.cardinality(v_bad) > 0 then
    raise exception 'tenant_stage4: 段階4を止めました（何も変えていません）: %', pg_catalog.array_to_string(v_bad, '、');
  end if;
end
$fn$;
select pg_temp.carelog_stage4_check();

-- ── 2. 27表に、自分の施設の行だけの守りを足す ──
create or replace function pg_temp.carelog_stage4_apply()
returns void
language plpgsql
as $fn$
declare
  v_t text;
begin
  foreach v_t in array pg_temp.carelog_stage4_tables() loop
    execute pg_catalog.format('drop policy if exists tenant_only on public.%I', v_t);
    execute pg_catalog.format(
      'create policy tenant_only on public.%I as restrictive for all to authenticated '
      'using (tenant_id = (select private.my_tenant())) '
      'with check (tenant_id = (select private.my_tenant()))', v_t);
  end loop;
end
$fn$;
select pg_temp.carelog_stage4_apply();

commit;

-- ── 確かめ（読むだけ。全部 ok なら入った）──
select '27表とも自分の施設の行だけの守りがある（restrictive・ログインした人の全部の操作）' as what,
       case when (select pg_catalog.count(*) from pg_catalog.pg_policies p
                   where p.schemaname = 'public' and p.tablename = any(pg_temp.carelog_stage4_tables())
                     and p.policyname = 'tenant_only' and p.permissive = 'RESTRICTIVE' and p.cmd = 'ALL'
                     and p.roles = '{authenticated}'::name[]
                     and p.qual = '(tenant_id = ( SELECT private.my_tenant() AS my_tenant))'
                     and p.with_check = '(tenant_id = ( SELECT private.my_tenant() AS my_tenant))') = 27
            then 'ok' else 'NG' end as result
union all
select '今の守り（102件）は変わっていない',
       case when (select pg_catalog.count(*) from pg_catalog.pg_policies p
                   where p.schemaname = 'public' and p.tablename = any(pg_temp.carelog_stage4_tables())
                     and p.policyname <> 'tenant_only') = 102
            then 'ok' else 'NG' end
union all
select '27表とも守りが有効のまま',
       case when (select pg_catalog.count(*) from pg_catalog.pg_class c
                   where c.oid = any(select pg_catalog.to_regclass('public.' || x) from pg_catalog.unnest(pg_temp.carelog_stage4_tables()) x)
                     and c.relrowsecurity) = 27
            then 'ok' else 'NG' end;
