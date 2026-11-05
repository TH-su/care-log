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
--      - 今の守り（tenant_only 以外）がちょうど102件（画面から足した守りなどがあれば、先に止めて確かめる・反証レビュー 低2）
--      - ログインした人（authenticated）が施設を調べる関数（private.my_tenant）を呼べる（呼べないと全部の読み書きが止まる）
--   2. 27表に、守り tenant_only を1本ずつ足す（restrictive＝今の守りのどれとも「かつ」でつながる・
--      ログインした人（authenticated）の読む・足す・直す・消すの全部に効く）
--        using      (tenant_id = (select private.my_tenant()))   … 読む・直す・消す時、自分の施設の行だけが見える
--        with check (tenant_id = (select private.my_tenant()))   … 足す・直す時、自分の施設の印の行だけを書ける
--      （足す時の印は、印を入れるトリガ carelog_fill_tenant（0051・0052）が先にログインした人の施設を入れる。
--        画面は印を送らない。よその施設の印を送っても、直してよその施設へ移しても、42501 で止まる）
--      （select …）で包むのは、1回の問い合わせで施設を1回だけ調べるため（行ごとに調べない・0053 の施設の印の索引が効く）
--   3. 「1人1日1件」などの自然キーの一意（13本）と、出勤者 (day, staff_id)・既読 (note_id, staff_id) の主キーの頭に施設の印を足す
--      （名前・条件は同じ。2026-11-05 反証レビュー 中1: よその施設の利用者の番号で足すと、その日の記録があれば 23505・
--       無ければ 23503 と、誤りの種類の違いで記録の有る無しを当てられた。頭に施設の印があれば、自分の施設の中だけでぶつかり、
--       よその施設の番号は必ず 23503 になる）。利用者・職員・申し送りの番号は1つの施設にだけ属する（0053 の組の外部キー）ので、
--       何が重複かは変わらない。画面は 23505 を番号で見分け、名前で見分けるのは施設長の索引だけ（0053 で施設ごと済み）。
--      変えない一意: 各表の主キー id（番号は画面から決められない）・client_key（端末が作る冪等キー。欄ごとの保存が
--        on conflict (client_key) で名指す）。
--   4. 欄ごとの保存（public.apply_cell_edits）だけが、定時のバイタルと食事の一意を列で名指して on conflict … do nothing を使うので、
--      その2か所の列に施設の印を足す（本文は今の定義のまま・2か所だけ置き換える。ほかの関数は衝突の先を列で名指していない）
-- 変えないもの: 今の102件の守り（member_only・read_auth・insert_*・update_* の本文と名前）・表・列・データ・
--   印を入れるトリガ・関数（欄ごとの保存の衝突の先の2か所を除く）・cron のジョブ・画面・取込の道具。
--   サーバーの接続（自動の記録・取込・cron。postgres・service_role）は守りを通らないので、今までどおり（施設ごとに回る＝0052）。
--   特別な権限で動く関数（daycare_open_day・履歴の記録のトリガ）は 0052 で施設ごとにしてある（ここでは触らない）。
-- 施設が1つの今の動き: 同じ（どの行もログインした人の施設の印を持つので、全部の行がこれまでどおり見え・書ける）。
--   許可リストに無い人・ログインしていない人は、今までどおり member_only で何も見えない。
-- 旧クライアント×新サーバー: 画面は施設の印を送らず読まない＝同じ版のまま動く（画面の公開は要らない）。
-- 戻す: supabase/rollback/0054_back.sql（足した27本の守りを外すだけ）。0053 を戻す前に、必ずこちらを先に戻す。
-- 流し方: SQL Editor で全文を貼る → Run。最後の確かめ（5行）が全部 ok なら完了（6行目は施設の数などの知らせ）。
--   流している間（数秒）は27表が錠で止まり、画面の読む・書くは待ってから通る。自動の記録・デイの自動（5分ごと）・
--   毎時の取込の時刻を避ける。錠を5秒待っても取れない時・画面の保存と錠の順番がぶつかった時（40P01）は誤りで止まり
--   何も入らないので、少し置いてもう一度流す（ぶつかった相手の画面の保存が1回失敗することがある＝画面の送信待ちが送り直す）。
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
  if (select pg_catalog.count(*) from pg_catalog.pg_policies p
       where p.schemaname = 'public' and p.tablename = any(pg_temp.carelog_stage4_tables()) and p.policyname <> 'tenant_only') <> 102 then
    v_bad := v_bad || '今の守りが102件ではない（足された守り・消えた守りを先に確かめる）'::text;
  end if;
  if pg_catalog.to_regprocedure('private.my_tenant()') is null
     or not pg_catalog.has_function_privilege('authenticated', 'private.my_tenant()', 'execute') then
    v_bad := v_bad || 'ログインした人が施設を調べる関数（private.my_tenant）を呼べない'::text;
  end if;
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

-- ── 3. 自然キーの一意と2つの主キーの頭に施設の印を足す（名前・条件は同じ）──
create or replace function pg_temp.carelog_stage4_uniques()
returns void
language plpgsql
as $fn$
declare
  r      record;
  v_def  text;
  v_new  text;
begin
  for r in select * from (values
      ('vitals',                    'uq_vitals_routine_day',       'idx',  'resident_id, measured_on'),
      ('meals',                     'uq_meals_slot',               'idx',  'resident_id, meal_on, meal_slot'),
      ('bath_records',              'uq_bath_records_day',         'idx',  'resident_id, bath_on'),
      ('med_admin',                 'uq_med_admin_slot',           'idx',  'resident_id, admin_on, slot'),
      ('med_slots',                 'uq_med_slots_resident',       'idx',  'resident_id'),
      ('resident_targets',          'uq_resident_targets_resident','idx',  'resident_id'),
      ('resident_vital_limits',     'uq_resident_vital_limits',    'idx',  'resident_id, valid_from'),
      ('daycare_attendance',        'uq_daycare_attendance_day',   'idx',  'resident_id, day'),
      ('daycare_activity_log',      'uq_daycare_activity',         'idx',  'resident_id, day, label'),
      ('daycare_training_sessions', 'uq_daycare_training_session', 'idx',  'resident_id, day'),
      ('daycare_home_visits',       'uq_daycare_home_visit',       'idx',  'resident_id, visited_on, purpose'),
      ('daycare_training_due',      'uq_daycare_training_due',     'idx',  'resident_id'),
      ('daycare_staffing',          'uq_daycare_staffing',         'idx',  'day, staff_id, role, COALESCE(from_time, ''00:00:00''::time without time zone)'),
      ('attendance',                'attendance_pkey',             'pkey', 'day, staff_id'),
      ('note_reads',                'note_reads_pkey',             'pkey', 'note_id, staff_id')
    ) as x(tbl, name, kind, cols)
  loop
    select pg_catalog.pg_get_indexdef(i.oid) into v_def
      from pg_catalog.pg_class i
     where i.relname = r.name and i.relnamespace = 'public'::regnamespace and i.relkind = 'i';
    if v_def is null then
      raise exception 'tenant_stage4: 一意 % が見つかりません（何も変えていません）', r.name;
    end if;
    if pg_catalog.strpos(v_def, 'USING btree (tenant_id, ' || r.cols || ')') > 0 then
      continue;  -- もう施設の印が頭にある（2回目）
    end if;
    if pg_catalog.strpos(v_def, 'ON public.' || r.tbl || ' USING btree (' || r.cols || ')') = 0 then
      raise exception 'tenant_stage4: 一意 % の形が思っていたものと違います（何も変えていません）', r.name;
    end if;
    if r.kind = 'pkey' then
      execute pg_catalog.format('alter table public.%I drop constraint %I', r.tbl, r.name);
      execute pg_catalog.format('alter table public.%I add constraint %I primary key (tenant_id, %s)', r.tbl, r.name, r.cols);
    else
      v_new := pg_catalog.replace(v_def, 'CREATE UNIQUE INDEX ' || r.name || ' ON', 'CREATE UNIQUE INDEX ' || r.name || '_s4 ON');
      v_new := pg_catalog.replace(v_new, 'USING btree (' || r.cols || ')', 'USING btree (tenant_id, ' || r.cols || ')');
      execute v_new;
      execute pg_catalog.format('drop index public.%I', r.name);
      execute pg_catalog.format('alter index public.%I rename to %I', r.name || '_s4', r.name);
    end if;
  end loop;
end
$fn$;
select pg_temp.carelog_stage4_uniques();

-- ── 4. 欄ごとの保存（public.apply_cell_edits）の衝突の先を、3. の新しい一意に合わせる ──
-- 本文は今の定義（pg_get_functiondef）のまま、衝突の先の2か所だけに施設の印を足す（ほかは一字も変えない）。
--   on conflict (resident_id, measured_on) where …       → on conflict (tenant_id, resident_id, measured_on) where …
--   on conflict (resident_id, meal_on, meal_slot) where … → on conflict (tenant_id, resident_id, meal_on, meal_slot) where …
-- 施設の印は足す前のトリガ（carelog_fill_tenant）が入れるので、衝突の判定にも同じ印が使われる。引数・返り値・権限は変わらない
create or replace function pg_temp.carelog_stage4_cell_fn()
returns void
language plpgsql
as $fn$
declare
  v_def  text := pg_catalog.pg_get_functiondef('public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure);
  v_new  text;
  a_old  text := 'on conflict (resident_id, measured_on) where kind = ''routine'' and deleted_at is null do nothing';
  a_new  text := 'on conflict (tenant_id, resident_id, measured_on) where kind = ''routine'' and deleted_at is null do nothing';
  b_old  text := 'on conflict (resident_id, meal_on, meal_slot) where deleted_at is null do nothing';
  b_new  text := 'on conflict (tenant_id, resident_id, meal_on, meal_slot) where deleted_at is null do nothing';
begin
  if pg_catalog.strpos(v_def, a_new) > 0 and pg_catalog.strpos(v_def, b_new) > 0 then
    return;  -- もう直してある（2回目）
  end if;
  if (pg_catalog.length(v_def) - pg_catalog.length(pg_catalog.replace(v_def, a_old, ''))) / pg_catalog.length(a_old) <> 1
     or (pg_catalog.length(v_def) - pg_catalog.length(pg_catalog.replace(v_def, b_old, ''))) / pg_catalog.length(b_old) <> 1 then
    raise exception 'tenant_stage4: 欄ごとの保存の関数の衝突の先が思っていた形と違います（何も変えていません）';
  end if;
  v_new := pg_catalog.replace(pg_catalog.replace(v_def, a_old, a_new), b_old, b_new);
  execute v_new;
end
$fn$;
select pg_temp.carelog_stage4_cell_fn();

-- 知らせの行（許可リストの表が無い土台＝ケアログの試験では「-」）
create or replace function pg_temp.carelog_stage4_info()
returns text
language plpgsql
as $fn$
declare
  v_n text := '-';
begin
  if pg_catalog.to_regclass('public.allowed_accounts') is not null then
    execute 'select pg_catalog.count(distinct a.tenant_id)::text from public.allowed_accounts a
              where a.is_active and not exists (select 1 from public.residents r where r.tenant_id = a.tenant_id)' into v_n;
  end if;
  return (select pg_catalog.count(*)::text from public.tenants) || '・' || v_n;
end
$fn$;

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
select '自然キーの一意13本と出勤者・既読の主キーの頭が施設の印（名前は同じ）',
       case when (select pg_catalog.count(*) from pg_catalog.pg_class i
                   where i.relnamespace = 'public'::regnamespace and i.relkind = 'i'
                     and i.relname in ('uq_vitals_routine_day', 'uq_meals_slot', 'uq_bath_records_day', 'uq_med_admin_slot', 'uq_med_slots_resident',
                                       'uq_resident_targets_resident', 'uq_resident_vital_limits', 'uq_daycare_attendance_day', 'uq_daycare_activity',
                                       'uq_daycare_training_session', 'uq_daycare_home_visit', 'uq_daycare_training_due', 'uq_daycare_staffing',
                                       'attendance_pkey', 'note_reads_pkey')
                     and pg_catalog.pg_get_indexdef(i.oid) like '%USING btree (tenant_id, %') = 15
             and (select pg_catalog.count(*) from pg_catalog.pg_constraint
                   where conname in ('attendance_pkey', 'note_reads_pkey') and contype = 'p') = 2
            then 'ok' else 'NG' end
union all
select '欄ごとの保存の衝突の先が施設の印つき（2か所）',
       case when (select pg_catalog.count(*) from pg_catalog.pg_proc
                   where oid = 'public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure
                     and prosrc like '%on conflict (tenant_id, resident_id, measured_on) where kind = ''routine'' and deleted_at is null do nothing%'
                     and prosrc like '%on conflict (tenant_id, resident_id, meal_on, meal_slot) where deleted_at is null do nothing%'
                     and prosrc not like '%on conflict (resident_id,%') = 1
            then 'ok' else 'NG' end
union all
select 'ログインした人が施設を調べる関数を呼べる',
       case when pg_catalog.has_function_privilege('authenticated', 'private.my_tenant()', 'execute') then 'ok' else 'NG' end
union all
select '27表とも守りが有効のまま',
       case when (select pg_catalog.count(*) from pg_catalog.pg_class c
                   where c.oid = any(select pg_catalog.to_regclass('public.' || x) from pg_catalog.unnest(pg_temp.carelog_stage4_tables()) x)
                     and c.relrowsecurity) = 27
            then 'ok' else 'NG' end
union all
-- 知らせ（ok/NG ではない）: 施設の数と、有効なアカウントがあるのにケアログの利用者が1人もいない施設の数（反証レビュー 中2。
-- 0 でない時は、その施設のアカウントの人の画面が空になる＝許可リストの施設の付け間違いでないかを確かめる。始めたばかりの施設なら正しい）
select '知らせ: 施設の数・アカウントはあるのに利用者のいない施設の数',
       pg_temp.carelog_stage4_info();
