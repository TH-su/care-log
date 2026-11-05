-- =====================================================================
-- 0055: 施設の印（tenant_id）の段階4の続き ― 端末・自動の記録の冪等キー（client_key）の一意を施設ごとにする
--       （代表者の決定 2026-11-04「同じデータベースを施設の印で分ける」・2026-11-05 反証レビュー2巡目 中1）
--
-- 0001〜0054 を当てたあとに実行する。冪等（何度流しても同じ）。begin … commit で包む（途中で止まった時は何も入らない）。
-- なぜ: 0054 で、よその施設の利用者の番号で足すと記録の有る無しに関係なく 23503 になるようにしたが、冪等キーの一意
--   （15表の client_key）は施設をまたいで1つのまま残した。自動の記録のキーは決まった形（'auto:med:日付:時間帯:利用者番号'・
--   'auto:bath:日付:利用者番号'・'auto:dcatt:日付:利用者番号'）なので、施設 A の職員が自分の施設の行の client_key を施設 B の
--   利用者のキーにして足すと、B に自動の記録があれば 23505・無ければ足せる＝よその施設の与薬・入浴・デイの到着の有る無しを
--   当てられる。先の日付のキーを先に入れておくと、B の自動の記録（on conflict do nothing）が黙って作られなくなる。
-- 何を:
--   1. 先に確かめる（0054 が入っている・15本の一意が思っていた形・欄ごとの保存の衝突の先が思っていた形。合わなければ何も変えずに止める）
--   2. 15表の client_key の一意の頭に施設の印を足す（名前は同じ。一意の制約11本は制約のまま、索引4本は索引のまま）
--        bath_records・daycare_activity_log・daycare_attendance・daycare_home_visits・daycare_staffing・daycare_training_sessions・
--        incidents・med_admin・med_slots・resident_targets・resident_vital_limits（<表>_client_key_key・制約）
--        fluid_intake・notes・outings・vitals（uq_<表>_client_key・索引）
--   3. 欄ごとの保存（public.apply_cell_edits）の on conflict (client_key) を on conflict (tenant_id, client_key) にする
--      （本文は今の定義のまま・その1か所だけ置き換える。ほかの関数は冪等キーを衝突の先に名指さない＝自動の記録は
--       on conflict do nothing で、施設ごとの一意にそのまま当たる）
--   流す前に27表の錠をまとめて取る（取ってから作り直すので、途中で表ごとに待って長く止まることが無い・反証レビュー2巡目 低1）
-- 変えないもの: 守り・表・列・データ・印を入れるトリガ・ほかの関数・cron・画面・取込の道具。
--   画面は 23505 を番号で見分け、冪等キーの一意の名前を見ていない（同じ名前のまま）。端末のキーは同じ端末・同じ施設の中で
--   1つなので、施設を足しても何が重複かは変わらない。
-- 施設が1つの今の動き: 同じ。
-- 旧クライアント×新サーバー: 画面は施設の印を送らず、冪等キーの一意の名前も見ない（23505 を番号で見分けて読み直す）＝同じ版のまま動く
--   （画面の公開は要らない）。読み直しは守り（0054）で自分の施設の行だけになるので、同じキーの自分の行を見つける動きも同じ。
-- 戻す: supabase/rollback/0055_back.sql（15本と欄ごとの保存の1か所を 0054 の後の形へ戻す）。0054 を戻す前に、必ずこちらを先に戻す。
-- 流し方: SQL Editor で全文を貼る → Run。最後の確かめ（3行）が全部 ok なら完了。
--   流している間（数秒）は15表が錠で止まり、画面の読む・書くは待ってから通る。自動の記録・デイの自動（5分ごと）・毎時の取込の
--   時刻を避ける。錠を5秒待っても取れない時は誤りで止まり何も入らないので、少し置いてもう一度流す。
-- ★ do $$ … $$ のブロックは使わない（関数の本文 as $fn$ … $fn$ は使ってよい）。個人情報を書かない。
-- =====================================================================

begin;
set local lock_timeout = '5s';

-- 作り直す15表の錠を、作り直す前にまとめて取る（取れなければ5秒で止まり、何も入らない）
lock table public.bath_records, public.daycare_activity_log, public.daycare_attendance, public.daycare_home_visits,
           public.daycare_staffing, public.daycare_training_sessions, public.incidents, public.med_admin, public.med_slots,
           public.resident_targets, public.resident_vital_limits, public.fluid_intake, public.notes, public.outings, public.vitals
  in access exclusive mode;

create or replace function pg_temp.carelog_ck_list()
returns table (tbl text, name text, kind text)
language sql immutable as $fn$
  select * from (values
    ('bath_records', 'bath_records_client_key_key', 'con'),
    ('daycare_activity_log', 'daycare_activity_log_client_key_key', 'con'),
    ('daycare_attendance', 'daycare_attendance_client_key_key', 'con'),
    ('daycare_home_visits', 'daycare_home_visits_client_key_key', 'con'),
    ('daycare_staffing', 'daycare_staffing_client_key_key', 'con'),
    ('daycare_training_sessions', 'daycare_training_sessions_client_key_key', 'con'),
    ('incidents', 'incidents_client_key_key', 'con'),
    ('med_admin', 'med_admin_client_key_key', 'con'),
    ('med_slots', 'med_slots_client_key_key', 'con'),
    ('resident_targets', 'resident_targets_client_key_key', 'con'),
    ('resident_vital_limits', 'resident_vital_limits_client_key_key', 'con'),
    ('fluid_intake', 'uq_fluid_client_key', 'idx'),
    ('notes', 'uq_notes_client_key', 'idx'),
    ('outings', 'uq_outings_client_key', 'idx'),
    ('vitals', 'uq_vitals_client_key', 'idx')
  ) as x(tbl, name, kind)
$fn$;

-- ── 1・2. 先に確かめて、15本の頭に施設の印を足す ──
create or replace function pg_temp.carelog_ck_apply()
returns void
language plpgsql
as $fn$
declare
  r      record;
  v_def  text;
  v_bad  text[] := '{}';
begin
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'vitals' and policyname = 'tenant_only') then
    raise exception 'tenant_client_key: 0054 が先です（何も変えていません）';
  end if;
  -- 先に全部を確かめる（1本でも違えば、何も変えずに止める）
  for r in select * from pg_temp.carelog_ck_list() loop
    select pg_catalog.pg_get_indexdef(i.oid) into v_def
      from pg_catalog.pg_class i where i.relname = r.name and i.relnamespace = 'public'::regnamespace and i.relkind = 'i';
    if v_def is null
       or (v_def <> 'CREATE UNIQUE INDEX ' || r.name || ' ON public.' || r.tbl || ' USING btree (client_key)'
           and v_def <> 'CREATE UNIQUE INDEX ' || r.name || ' ON public.' || r.tbl || ' USING btree (tenant_id, client_key)')
       or (r.kind = 'con') <> exists (select 1 from pg_catalog.pg_constraint k
                                       where k.conname = r.name and k.conrelid = ('public.' || r.tbl)::regclass and k.contype = 'u') then
      v_bad := v_bad || r.name;
    end if;
  end loop;
  if pg_catalog.cardinality(v_bad) > 0 then
    raise exception 'tenant_client_key: 冪等キーの一意の形が思っていたものと違います（何も変えていません）: %', pg_catalog.array_to_string(v_bad, '、');
  end if;
  for r in select * from pg_temp.carelog_ck_list() loop
    select pg_catalog.pg_get_indexdef(i.oid) into v_def
      from pg_catalog.pg_class i where i.relname = r.name and i.relnamespace = 'public'::regnamespace and i.relkind = 'i';
    if pg_catalog.strpos(v_def, '(tenant_id, client_key)') > 0 then
      continue;  -- もう施設の印が頭にある（2回目）
    end if;
    if r.kind = 'con' then
      execute pg_catalog.format('alter table public.%I drop constraint %I', r.tbl, r.name);
      execute pg_catalog.format('alter table public.%I add constraint %I unique (tenant_id, client_key)', r.tbl, r.name);
    else
      execute pg_catalog.format('create unique index %I on public.%I (tenant_id, client_key)', r.name || '_s4', r.tbl);
      execute pg_catalog.format('drop index public.%I', r.name);
      execute pg_catalog.format('alter index public.%I rename to %I', r.name || '_s4', r.name);
    end if;
  end loop;
end
$fn$;
select pg_temp.carelog_ck_apply();

-- ── 3. 欄ごとの保存の on conflict (client_key) を施設の印つきにする（その1か所だけ置き換える）──
create or replace function pg_temp.carelog_ck_cell_fn()
returns void
language plpgsql
as $fn$
declare
  v_def  text := pg_catalog.pg_get_functiondef('public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure);
  a_old  text := 'on conflict (client_key) do nothing';
  a_new  text := 'on conflict (tenant_id, client_key) do nothing';
begin
  if pg_catalog.strpos(v_def, a_new) > 0 and pg_catalog.strpos(v_def, a_old) = 0 then
    return;  -- もう直してある（2回目）
  end if;
  if (pg_catalog.length(v_def) - pg_catalog.length(pg_catalog.replace(v_def, a_old, ''))) / pg_catalog.length(a_old) <> 1 then
    raise exception 'tenant_client_key: 欄ごとの保存の関数の冪等キーの衝突の先が思っていた形と違います（何も変えていません）';
  end if;
  execute pg_catalog.replace(v_def, a_old, a_new);
end
$fn$;
select pg_temp.carelog_ck_cell_fn();

commit;

-- ── 確かめ（読むだけ。全部 ok なら入った）──
select '冪等キーの一意15本の頭が施設の印（名前は同じ・制約は制約のまま）' as what,
       case when (select pg_catalog.count(*) from pg_temp.carelog_ck_list() l
                   join pg_catalog.pg_class i on i.relname = l.name and i.relnamespace = 'public'::regnamespace and i.relkind = 'i'
                  where pg_catalog.pg_get_indexdef(i.oid) = 'CREATE UNIQUE INDEX ' || l.name || ' ON public.' || l.tbl || ' USING btree (tenant_id, client_key)') = 15
             and (select pg_catalog.count(*) from pg_temp.carelog_ck_list() l
                   join pg_catalog.pg_constraint k on k.conname = l.name and k.conrelid = ('public.' || l.tbl)::regclass and k.contype = 'u'
                  where l.kind = 'con') = 11
            then 'ok' else 'NG' end as result
union all
select '欄ごとの保存の冪等キーの衝突の先が施設の印つき（1か所）',
       case when (select pg_catalog.count(*) from pg_catalog.pg_proc
                   where oid = 'public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure
                     and prosrc like '%on conflict (tenant_id, client_key) do nothing%'
                     and prosrc not like '%on conflict (client_key)%') = 1
            then 'ok' else 'NG' end
union all
select '施設の印の無い一意は、番号（id）だけ（27表）',
       case when not exists (select 1 from pg_catalog.pg_index x
                               join pg_catalog.pg_class i on i.oid = x.indexrelid
                               join pg_catalog.pg_class c on c.oid = x.indrelid
                              where x.indisunique and c.relnamespace = 'public'::regnamespace
                                and c.relname = any(array['residents', 'staff', 'vitals', 'meals', 'fluid_intake', 'notes', 'note_reads', 'outings',
                                                          'attendance', 'app_settings', 'import_days', 'master_sync_log', 'record_history',
                                                          'bath_records', 'med_slots', 'med_admin', 'incidents', 'resident_targets',
                                                          'resident_vital_limits', 'daycare_days', 'daycare_attendance', 'daycare_activity_log',
                                                          'daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due',
                                                          'daycare_training_due_settings', 'daycare_staffing'])
                                and pg_catalog.pg_get_indexdef(i.oid) not like '%USING btree (tenant_id, %'
                                and pg_catalog.pg_get_indexdef(i.oid) not like '%USING btree (id)')
            then 'ok' else 'NG' end;
