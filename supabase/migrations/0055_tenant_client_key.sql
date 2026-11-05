-- =====================================================================
-- 0055: 施設の印（tenant_id）の段階4の続き ― 端末・自動の記録の冪等キー（client_key）の一意を施設ごとにする
--       （代表者の決定 2026-11-04「同じデータベースを施設の印で分ける」・2026-11-05 反証レビュー2巡目 中1）
--
-- 0001〜0054 を当てたあとに実行する。冪等（何度流しても同じ）。2つの取引に分ける（下の「2段に分ける理由」）。
-- なぜ: 0054 で、よその施設の利用者の番号で足すと記録の有る無しに関係なく 23503 になるようにしたが、冪等キーの一意
--   （15表の client_key）は施設をまたいで1つのまま残した。自動の記録のキーは決まった形（'auto:med:日付:時間帯:利用者番号'・
--   'auto:bath:日付:利用者番号'・'auto:dcatt:日付:利用者番号'）なので、施設 A の職員が自分の施設の行の client_key を施設 B の
--   利用者のキーにして足すと、B に自動の記録があれば 23505・無ければ足せる＝よその施設の与薬・入浴・デイの到着の有る無しを
--   当てられる。先の日付のキーを先に入れておくと、B の自動の記録（on conflict do nothing）が黙って作られなくなる。
-- 何を（15表: bath_records・daycare_activity_log・daycare_attendance・daycare_home_visits・daycare_staffing・
--       daycare_training_sessions・incidents・med_admin・med_slots・resident_targets・resident_vital_limits の
--       <表>_client_key_key（一意の制約）と、fluid_intake・notes・outings・vitals の uq_<表>_client_key（一意の索引））
--   1段目（取引1）: 先に確かめ（0054 が入っている・15本と欄ごとの保存が思っていた形。合わなければ何も変えずに止める）、
--     15表に (tenant_id, client_key) の一意の索引を足し（仮の名前 <名前>_t）、欄ごとの保存（public.apply_cell_edits）の
--     on conflict (client_key) を on conflict (tenant_id, client_key) にする（本文は今の定義のまま・その1か所だけ）。
--     古い一意（client_key だけ）は残す。索引を足す間は書き込みだけが待ち、読むのは止まらない。
--   2段目（取引2）: 15表の錠を、画面が読む順（申し送り→バイタル→水分→外出→…）で取ってから、古い一意を外し、
--     仮の名前の索引を元の名前にする（一意の制約だった11本は、その索引を使う一意の制約として同じ名前で付け直す）。
--   2段に分ける理由（2026-11-05 反証レビュー3巡目 中1）: 1つの取引で古い一意を外して関数を替えると、流している瞬間に
--     錠を待っていた欄ごとの保存が古い本文のまま動き、名指す一意が無くて 42P10 になり、画面が「取り消し」として端末に残す。
--     1段目は古い一意を残したまま新しい本文へ替え、2段目は新しい本文が名指す一意を残したまま古い一意だけを外すので、
--     どの瞬間に動いた保存も、名指す一意がある。
--   2段目が錠を5秒待っても取れずに止まった時は、1段目だけが入った形（古い一意と新しい一意が両方ある＝今と同じに動く）で
--   残るので、少し置いてもう一度全文を流す（1段目は2回目は何もしない）。戻す SQL が1段目だけで止まった形からも、
--   この全文を流せば入った形に戻る（戻す SQL が足した古い形の一意 <名前>_b を外す）。
-- 変えないもの: 守り・表・列・データ・印を入れるトリガ・ほかの関数・cron・画面・取込の道具。
--   画面は 23505 を番号で見分け、冪等キーの一意の名前を見ていない（同じ名前のまま）。端末のキーは同じ端末・同じ施設の中で
--   1つなので、施設を足しても何が重複かは変わらない。自動の記録は衝突の先を名指さない on conflict do nothing なので、
--   施設ごとの一意にそのまま当たる（施設の中では今までどおり重ならない）。
-- 施設が1つの今の動き: 同じ。
-- 旧クライアント×新サーバー: 画面は施設の印を送らず、冪等キーの一意の名前も見ない（23505 を番号で見分けて読み直す）＝同じ版のまま動く
--   （画面の公開は要らない）。読み直しは守り（0054）で自分の施設の行だけになるので、同じキーの自分の行を見つける動きも同じ。
-- 戻す: supabase/rollback/0055_back.sql（同じく2段で 0054 の後の形へ戻す）。0054 を戻す前に、必ずこちらを先に戻す
--   （0054_back.sql は 0055 が入っていると何も変えずに止まる）。
-- 流し方: SQL Editor で全文を貼る → Run。最後の確かめ（3行）が全部 ok なら完了。
--   2段目の間（1秒ほど）は15表が錠で止まり、画面の読む・書くは待ってから通る。錠は1表ずつ取り、取れない表を5秒待つ間は
--   取れた表も止まったままになる。自動の記録・デイの自動（5分ごと）・毎時の取込の時刻を避ける。
-- ★ do $$ … $$ のブロックは使わない（関数の本文 as $fn$ … $fn$ は使ってよい）。個人情報を書かない。
-- =====================================================================

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

-- 今の形: 'old'（client_key だけ）・'both'（1段目だけ入った）・'new'（入った）・
--   'backhalf'（入った後に戻す SQL の1段目だけが入った＝古い形の一意 <名前>_b が足されている）・'bad'（思っていた形と違う）
create or replace function pg_temp.carelog_ck_state(p_tbl text, p_name text, p_kind text)
returns text
language plpgsql
as $fn$
declare
  v_def  text;
  v_tmp  text;
  v_bk   text;
  v_con  boolean;
begin
  select pg_catalog.pg_get_indexdef(i.oid) into v_def
    from pg_catalog.pg_class i where i.relname = p_name and i.relnamespace = 'public'::regnamespace and i.relkind = 'i';
  select pg_catalog.pg_get_indexdef(i.oid) into v_tmp
    from pg_catalog.pg_class i where i.relname = p_name || '_t' and i.relnamespace = 'public'::regnamespace and i.relkind = 'i';
  select pg_catalog.pg_get_indexdef(i.oid) into v_bk
    from pg_catalog.pg_class i where i.relname = p_name || '_b' and i.relnamespace = 'public'::regnamespace and i.relkind = 'i';
  v_con := exists (select 1 from pg_catalog.pg_constraint k
                    where k.conname = p_name and k.conrelid = ('public.' || p_tbl)::regclass and k.contype = 'u');
  if v_con is distinct from (p_kind = 'con') then
    return 'bad';
  end if;
  if v_def = 'CREATE UNIQUE INDEX ' || p_name || ' ON public.' || p_tbl || ' USING btree (tenant_id, client_key)' and v_tmp is null then
    if v_bk is null then
      return 'new';
    end if;
    if v_bk = 'CREATE UNIQUE INDEX ' || p_name || '_b ON public.' || p_tbl || ' USING btree (client_key)' then
      return 'backhalf';
    end if;
    return 'bad';
  end if;
  if v_def = 'CREATE UNIQUE INDEX ' || p_name || ' ON public.' || p_tbl || ' USING btree (client_key)' then
    if v_tmp is null then
      return 'old';
    end if;
    if v_tmp = 'CREATE UNIQUE INDEX ' || p_name || '_t ON public.' || p_tbl || ' USING btree (tenant_id, client_key)' then
      return 'both';
    end if;
  end if;
  return 'bad';
end
$fn$;

-- ════ 1段目（取引1）: 新しい一意を足し、欄ごとの保存を新しい一意へ替える（古い一意は残す）════
begin;
set local lock_timeout = '5s';

create or replace function pg_temp.carelog_ck_phase1()
returns void
language plpgsql
as $fn$
declare
  r      record;
  v_bad  text[] := '{}';
  v_def  text := pg_catalog.pg_get_functiondef('public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure);
  a_old  text := 'on conflict (client_key) do nothing';
  a_new  text := 'on conflict (tenant_id, client_key) do nothing';
  v_cnt  integer;
begin
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'vitals' and policyname = 'tenant_only') then
    raise exception 'tenant_client_key: 0054 が先です（何も変えていません）';
  end if;
  -- 先に全部を確かめる（1本でも違えば、何も変えずに止める）
  for r in select * from pg_temp.carelog_ck_list() loop
    if pg_temp.carelog_ck_state(r.tbl, r.name, r.kind) = 'bad' then
      v_bad := v_bad || r.name;
    end if;
  end loop;
  if pg_catalog.cardinality(v_bad) > 0 then
    raise exception 'tenant_client_key: 冪等キーの一意の形が思っていたものと違います（何も変えていません）: %', pg_catalog.array_to_string(v_bad, '、');
  end if;
  v_cnt := (pg_catalog.length(v_def) - pg_catalog.length(pg_catalog.replace(v_def, a_old, ''))) / pg_catalog.length(a_old);
  if not ((v_cnt = 1 and pg_catalog.strpos(v_def, a_new) = 0) or (v_cnt = 0 and pg_catalog.strpos(v_def, a_new) > 0)) then
    raise exception 'tenant_client_key: 欄ごとの保存の関数の冪等キーの衝突の先が思っていた形と違います（何も変えていません）';
  end if;
  -- 新しい一意を仮の名前で足す（もうあれば足さない）
  for r in select * from pg_temp.carelog_ck_list() loop
    if pg_temp.carelog_ck_state(r.tbl, r.name, r.kind) = 'old' then
      execute pg_catalog.format('create unique index %I on public.%I (tenant_id, client_key)', r.name || '_t', r.tbl);
    end if;
  end loop;
  -- 欄ごとの保存を新しい一意へ（まだなら）
  if v_cnt = 1 then
    execute pg_catalog.replace(v_def, a_old, a_new);
  end if;
end
$fn$;
select pg_temp.carelog_ck_phase1();

commit;

-- ════ 2段目（取引2）: 古い一意を外し、新しい一意を元の名前にする ════
begin;
set local lock_timeout = '5s';

-- 画面が読む順（申し送り・バイタル・水分・外出の順に読む timeline_chunk と同じ）で錠を取る
lock table public.notes, public.vitals, public.fluid_intake, public.outings,
           public.bath_records, public.med_slots, public.med_admin, public.incidents, public.resident_targets,
           public.resident_vital_limits, public.daycare_attendance, public.daycare_activity_log,
           public.daycare_training_sessions, public.daycare_home_visits, public.daycare_staffing
  in access exclusive mode;

create or replace function pg_temp.carelog_ck_phase2()
returns void
language plpgsql
as $fn$
declare
  r      record;
  v_st   text;
begin
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure),
                       'on conflict (tenant_id, client_key) do nothing') = 0 then
    raise exception 'tenant_client_key: 1段目が入っていません（何も変えていません）';
  end if;
  for r in select * from pg_temp.carelog_ck_list() loop
    v_st := pg_temp.carelog_ck_state(r.tbl, r.name, r.kind);
    if v_st = 'new' then
      continue;
    end if;
    if v_st = 'backhalf' then
      execute pg_catalog.format('drop index public.%I', r.name || '_b');  -- 戻す SQL の1段目が足した古い形を外す
      continue;
    end if;
    if v_st <> 'both' then
      raise exception 'tenant_client_key: 冪等キーの一意 % が1段目の後の形ではありません（2段目は何も変えていません）', r.name;
    end if;
    if r.kind = 'con' then
      execute pg_catalog.format('alter table public.%I drop constraint %I', r.tbl, r.name);
      execute pg_catalog.format('alter index public.%I rename to %I', r.name || '_t', r.name);
      execute pg_catalog.format('alter table public.%I add constraint %I unique using index %I', r.tbl, r.name, r.name);
    else
      execute pg_catalog.format('drop index public.%I', r.name);
      execute pg_catalog.format('alter index public.%I rename to %I', r.name || '_t', r.name);
    end if;
  end loop;
end
$fn$;
select pg_temp.carelog_ck_phase2();

commit;

-- ── 確かめ（読むだけ。全部 ok なら入った）──
select '冪等キーの一意15本の頭が施設の印（名前は同じ・制約は制約のまま）' as what,
       case when (select pg_catalog.count(*) from pg_temp.carelog_ck_list() l
                   where pg_temp.carelog_ck_state(l.tbl, l.name, l.kind) = 'new') = 15
            then 'ok' else 'NG' end as result
union all
select '欄ごとの保存の冪等キーの衝突の先が施設の印つき（1か所）',
       case when (select pg_catalog.count(*) from pg_catalog.pg_proc
                   where oid = 'public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure
                     and prosrc like '%on conflict (tenant_id, client_key) do nothing%'
                     and prosrc not like '%on conflict (client_key)%') = 1
            then 'ok' else 'NG' end
union all
-- 番号（id）は画面から決められない（いつも自動で振る）ので、施設の印の無い一意として残してよい
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
