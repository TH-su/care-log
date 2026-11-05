-- =====================================================================
-- 0053: 施設の印（tenant_id）の段階3 ― 施設をまたいでぶつかる一意を施設ごとにし、印を必須にし、
--       ケアログの表どうしの外部キーを「同じ施設の行だけ」を指す形にする
--       （代表者の決定 2026-11-04「同じデータベースを施設の印で分ける」「4回に分けて入れる」の3回目）
--
-- 0001〜0052 を当てたあとに実行する。冪等（何度流しても同じ。外部キー・一意・主キーは名前を決めて外してから付け直す）。
-- begin … commit で包む（途中で止まった時は何も入らない＝半分だけ入った形を残さない）。表の錠を待つのは5秒まで（lock_timeout）。
-- なぜ: 段階2（0052）で自動の記録・取込・開所は施設ごとに動く形になったが、一意（旗の key・その日の写しの day・
--   取込の日の (source, day)・利用者No・職員の名前・取込の印 import_key・施設長は1日1人・計画書の規則の1行）が
--   施設をまたいで1つのため、先に書いた施設が勝ち、もう一方の施設の開所・自動の到着・取込が止まる（0052 の冒頭の決まり）。
--   また施設の印は null でも書けてしまい、ケアログの表どうしの外部キー（利用者・職員・申し送りの番号）は施設を見ないので、
--   よその施設の利用者や職員を指す記録も作れてしまう。
-- 何を:
--   1. 先に確かめる（どれか1つでも合わなければ、何も変えずに誤りで止める。誤りの文に出すのは表の名前と行数だけ）
--      - 27表に印の無い行（tenant_id が null）が無い
--      - 利用者・職員・申し送りを指す外部キーが、決まった名前の76本だけ（名前が違うと付け直しの対象から漏れるため）
--      - その76本のどれも、よその施設の行を指していない（記録の施設の印と、指している利用者・職員・申し送りの施設の印が同じ）
--   2. 27表の tenant_id を必須（not null）にする。印を入れるトリガ（carelog_fill_tenant・0052）はそのまま
--      （印が決まらない書き込みは、今までの「null のまま入る」から「not null の誤り 23502 で止まる」に変わる）
--   3. 利用者・職員・申し送りに（施設, 番号）の一意を足し（residents_tenant_id_id_key ほか）、76本の外部キーを
--      同じ名前のまま（施設の印, 番号）→（施設の印, id）の組に付け直す（消した時・番号を変えた時の動きは今と同じ NO ACTION・
--      遅らせない・MATCH SIMPLE＝番号が空の行は今までどおり確かめない）
--   4. 一意を施設ごとにする（前 → 後）
--      - residents_source_id_key unique (source_id) → residents_tenant_id_source_id_key unique (tenant_id, source_id)
--      - staff_name_key unique (name) → staff_tenant_id_name_key unique (tenant_id, name)
--      - vitals・meals・notes の <表>_import_key_key unique (import_key) → <表>_tenant_id_import_key_key unique (tenant_id, import_key)
--      - app_settings_pkey primary key (key) → 同じ名前で primary key (tenant_id, key)
--      - import_days_pkey primary key (source, day) → 同じ名前で primary key (tenant_id, source, day)
--      - daycare_training_due_settings_pkey primary key (id) → 同じ名前で primary key (tenant_id, id)（1行だけの決まり id = 1 は
--        そのまま＝施設ごとに1行）
--      - uq_attendance_manager_day (day) where role = 'manager' and sort >= 0 → 同じ名前・同じ条件で (tenant_id, day)
--        （画面は 23505 の索引の名前で「施設長はもういます」を見分けるので名前を変えない）
--      - uq_daycare_days_day (day) → 同じ名前で (tenant_id, day)
--      変えない一意: 各表の client_key（端末が作る番号・自動の記録の番号は利用者の番号を含む）、利用者の番号を先頭に持つ
--        「1人1日1件」などの部分 unique（利用者の番号は施設をまたいで1つ＝ぶつからない）、出勤者 (day, staff_id)・
--        既読 (note_id, staff_id)（職員・申し送りの番号は施設をまたいで1つ）
--   5. 施設の印で始まる索引の無い18表に、施設の印の索引（ix_<表>_tenant_id）を足す（段階④で守りが施設の印で絞る時のため）
--   6. 計画書の期限の写し（public.daycare_training_due_sync）は、ログインした人の施設（private.carelog_cur_tenant()）の
--      利用者・写しの行・規則の1行だけを読み書きする（規則の1行の衝突の先は (tenant_id, id)）。引数・返り値・権限・
--      止める理由（empty・nomatch・too_many）は変えない。利用者No が施設ごとの一意になり、よその施設の同じ利用者No の方と
--      結んでしまわないため
--   ※取込の道具（tools/import.mjs）の取込の日（import_days）の衝突の先は、名前（on conflict on constraint import_days_pkey）で
--     指す形に変えた（主キーの名前は前後で同じ＝この移行の前でも後でも同じ道具で動く）
-- 変えないもの: 守り（RLS・ポリシー）・表・列・データ・印を入れるトリガ・cron のジョブ・0052 の関数・画面。
--   守りはまだ「許可リストの人は全部の施設の行を読める」（using(true)）のまま（段階④で替える）。
--   ★運用の決まり（段階④が入るまで）: 2つ目の施設の職員を許可リストに入れない・2つ目の施設の取込を走らせない・
--     SQL Editor でも2つ目の施設の行を作らない。一意が施設ごとになったので2つ目の施設の行は書けるようになったが、
--     画面は旗・設定を key だけで1行読む（.eq('key', …).limit(1)）ため、2つ目の施設の旗の行があると、
--     今の施設の画面がその行を読むことがある（守りが施設で絞るまで）
-- 施設が1つの今の動き: 同じ（どの行も同じ施設の印を持つので、施設を足した一意・組の外部キーは今の一意・外部キーと同じ行を
--   通し、同じ行を止める。止まった時の誤りの符号（23505・23503）も同じ。誤りの文に出る一意の名前は、施設長の索引と
--   主キーは同じ・利用者No・職員の名前・取込の印は新しい名前になる（画面はこの3つの名前を見ていない））。
-- 旧クライアント×新サーバー: 画面は施設の印を送らず読まない・関数の引数と返り値は同じ。ただし申し送りの既読者の一覧
--   （src/lib/db.ts の fetchNoteReaders）は職員を外部キーの列の名前で指していたため、外部キーが2列になると PostgREST が
--   つながりを見つけられず読めなくなる（2026-11-04 反証レビュー 高1）。外部キーの名前で指す形に直した画面を先に公開してから流す。
-- ★流す順: ①この移行と同じ PR の画面・取込の道具（tools/import.mjs）を取り込んで公開する → ②取込を動かしている機械の写しが
--   新しい版になったことを確かめる（古い版は 0053 の後、取込の日を書く所で止まる） → ③この SQL を流す。
--   画面の書き込みはどれも衝突の先を名指しない（upsert を使わない）。施設長の索引の名前も同じ。
--   取込の道具は、古い版（on conflict (source, day)）のままだと取込の日を書く所で止まる（何も書かずにその窓は rollback）。
--   この移行と同じ版の道具（on conflict on constraint import_days_pkey）は前後どちらでも動くので、道具を先に入れる。
-- 新クライアント×旧サーバー: この移行は画面の挙動に関係しない。
-- 戻し方: supabase/rollback/0053_back.sql（一意・主キー・外部キー・null 可・関数を 0052 の後の形へそのまま戻す）。
--   0052 を戻す前に、必ずこちらを先に戻す。2つ目の施設の行がある時は戻せない（施設をまたぐ一意に戻せない）。
-- 流し方: SQL Editor で全文を貼る → Run。最後の確かめ（7行）が全部 ok なら完了。
--   流している間（数秒）は27表が錠で止まり、画面の読み書きは待ってから通る。自動の記録（日本時間 8:50・12:30・13:00・
--   18:20・21:00）・デイの自動（5分ごと＝0分・5分…）・毎時の取込の時刻を避ける。錠を5秒待っても取れない時・
--   ほかの取引とぶつかった時は誤りで止まり何も入らないので、少し置いてもう一度流す。
-- ★ do $$ … $$ のブロックは使わない（関数の本文 as $fn$ … $fn$ は使ってよい）。個人情報を書かない。
-- =====================================================================

begin;

-- 待つのは5秒まで（長い取引の後ろで待つ間、ほかの書き込みを止めたままにしない。止まったら何も入らないので、もう一度流す）
set local lock_timeout = '5s';

-- ---------- 1. 先に確かめる（合わなければ何も変えずに止める） ----------
create or replace function pg_temp.carelog_stage3_check()
returns void
language plpgsql
set search_path = ''
as $fn$
declare
  v_t    text;
  v_n    bigint;
  v_want text[];
  v_have text[];
  r      record;
begin
  foreach v_t in array array['residents', 'staff', 'vitals', 'meals', 'fluid_intake', 'notes', 'note_reads', 'outings', 'attendance',
                             'app_settings', 'import_days', 'master_sync_log', 'record_history', 'bath_records', 'med_slots', 'med_admin',
                             'incidents', 'resident_targets', 'resident_vital_limits', 'daycare_days', 'daycare_attendance',
                             'daycare_activity_log', 'daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due',
                             'daycare_training_due_settings', 'daycare_staffing'] loop
    execute pg_catalog.format('select pg_catalog.count(*) from public.%I where tenant_id is null', v_t) into v_n;
    if v_n > 0 then
      raise exception 'tenant_stage3: 表 % に施設の印の無い行が % 行あります。0051 の確かめ「印の無い行が残っていない」を ok にしてから流してください', v_t, v_n;
    end if;
  end loop;

  -- ★並べ方は両方とも C の規則にそろえる（本番の DB は en_US の並べ方で、relname（name 型）は C の並べ方のため、
  --   同じ76本でも並び順が違って「違う」と誤って止まった・2026-11-05 本番で判明）
  select pg_catalog.array_agg((x.child || '.' || x.conname)::text collate "C" order by (x.child || '.' || x.conname)::text collate "C") into v_want from pg_temp.carelog_stage3_fks() x;
  select pg_catalog.array_agg((c.relname || '.' || k.conname)::text collate "C" order by (c.relname || '.' || k.conname)::text collate "C") into v_have
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class c on c.oid = k.conrelid
   where k.contype = 'f'
     and k.confrelid in ('public.residents'::regclass, 'public.staff'::regclass, 'public.notes'::regclass);
  if v_have is distinct from v_want then
    raise exception 'tenant_stage3: 利用者・職員・申し送りを指す外部キーが決まった76本と違います（今 % 本）。何も変えずに止めました', coalesce(pg_catalog.cardinality(v_have), 0);
  end if;

  for r in select * from pg_temp.carelog_stage3_fks() loop
    execute pg_catalog.format(
      'select pg_catalog.count(*) from public.%I c join public.%I p on p.id = c.%I where c.tenant_id is distinct from p.tenant_id',
      r.child, r.parent, r.col) into v_n;
    if v_n > 0 then
      raise exception 'tenant_stage3: 表 % の % が、よその施設の % を指す行が % 行あります。何も変えずに止めました', r.child, r.col, r.parent, v_n;
    end if;
  end loop;
end
$fn$;

-- 付け直す外部キー（記録の表・外部キーの名前・番号の列・指す表）。76本
create or replace function pg_temp.carelog_stage3_fks()
returns table (child text, conname text, col text, parent text)
language sql
immutable
set search_path = ''
as $fn$
  values
      ('attendance', 'attendance_staff_id_fkey', 'staff_id', 'staff'),
      ('bath_records', 'bath_records_deleted_by_fkey', 'deleted_by', 'staff'),
      ('bath_records', 'bath_records_edited_by_fkey', 'edited_by', 'staff'),
      ('bath_records', 'bath_records_recorded_by_fkey', 'recorded_by', 'staff'),
      ('bath_records', 'bath_records_resident_id_fkey', 'resident_id', 'residents'),
      ('daycare_activity_log', 'daycare_activity_log_deleted_by_fkey', 'deleted_by', 'staff'),
      ('daycare_activity_log', 'daycare_activity_log_edited_by_fkey', 'edited_by', 'staff'),
      ('daycare_activity_log', 'daycare_activity_log_recorded_by_fkey', 'recorded_by', 'staff'),
      ('daycare_activity_log', 'daycare_activity_log_resident_id_fkey', 'resident_id', 'residents'),
      ('daycare_attendance', 'daycare_attendance_deleted_by_fkey', 'deleted_by', 'staff'),
      ('daycare_attendance', 'daycare_attendance_edited_by_fkey', 'edited_by', 'staff'),
      ('daycare_attendance', 'daycare_attendance_recorded_by_fkey', 'recorded_by', 'staff'),
      ('daycare_attendance', 'daycare_attendance_resident_id_fkey', 'resident_id', 'residents'),
      ('daycare_days', 'daycare_days_edited_by_fkey', 'edited_by', 'staff'),
      ('daycare_days', 'daycare_days_opened_by_fkey', 'opened_by', 'staff'),
      ('daycare_home_visits', 'daycare_home_visits_deleted_by_fkey', 'deleted_by', 'staff'),
      ('daycare_home_visits', 'daycare_home_visits_edited_by_fkey', 'edited_by', 'staff'),
      ('daycare_home_visits', 'daycare_home_visits_recorded_by_fkey', 'recorded_by', 'staff'),
      ('daycare_home_visits', 'daycare_home_visits_resident_id_fkey', 'resident_id', 'residents'),
      ('daycare_home_visits', 'daycare_home_visits_visitor_id_fkey', 'visitor_id', 'staff'),
      ('daycare_staffing', 'daycare_staffing_deleted_by_fkey', 'deleted_by', 'staff'),
      ('daycare_staffing', 'daycare_staffing_edited_by_fkey', 'edited_by', 'staff'),
      ('daycare_staffing', 'daycare_staffing_recorded_by_fkey', 'recorded_by', 'staff'),
      ('daycare_staffing', 'daycare_staffing_staff_id_fkey', 'staff_id', 'staff'),
      ('daycare_training_due', 'daycare_training_due_deleted_by_fkey', 'deleted_by', 'staff'),
      ('daycare_training_due', 'daycare_training_due_resident_id_fkey', 'resident_id', 'residents'),
      ('daycare_training_due', 'daycare_training_due_synced_by_fkey', 'synced_by', 'staff'),
      ('daycare_training_due_settings', 'daycare_training_due_settings_synced_by_fkey', 'synced_by', 'staff'),
      ('daycare_training_sessions', 'daycare_training_sessions_assisted_by_fkey', 'assisted_by', 'staff'),
      ('daycare_training_sessions', 'daycare_training_sessions_deleted_by_fkey', 'deleted_by', 'staff'),
      ('daycare_training_sessions', 'daycare_training_sessions_edited_by_fkey', 'edited_by', 'staff'),
      ('daycare_training_sessions', 'daycare_training_sessions_instructor_id_fkey', 'instructor_id', 'staff'),
      ('daycare_training_sessions', 'daycare_training_sessions_recorded_by_fkey', 'recorded_by', 'staff'),
      ('daycare_training_sessions', 'daycare_training_sessions_resident_id_fkey', 'resident_id', 'residents'),
      ('fluid_intake', 'fluid_intake_deleted_by_fkey', 'deleted_by', 'staff'),
      ('fluid_intake', 'fluid_intake_edited_by_fkey', 'edited_by', 'staff'),
      ('fluid_intake', 'fluid_intake_recorded_by_fkey', 'recorded_by', 'staff'),
      ('fluid_intake', 'fluid_intake_resident_id_fkey', 'resident_id', 'residents'),
      ('incidents', 'incidents_confirmer_id_fkey', 'confirmer_id', 'staff'),
      ('incidents', 'incidents_deleted_by_fkey', 'deleted_by', 'staff'),
      ('incidents', 'incidents_edited_by_fkey', 'edited_by', 'staff'),
      ('incidents', 'incidents_reporter_id_fkey', 'reporter_id', 'staff'),
      ('incidents', 'incidents_resident_id_fkey', 'resident_id', 'residents'),
      ('meals', 'meals_deleted_by_fkey', 'deleted_by', 'staff'),
      ('meals', 'meals_edited_by_fkey', 'edited_by', 'staff'),
      ('meals', 'meals_recorded_by_fkey', 'recorded_by', 'staff'),
      ('meals', 'meals_resident_id_fkey', 'resident_id', 'residents'),
      ('med_admin', 'med_admin_deleted_by_fkey', 'deleted_by', 'staff'),
      ('med_admin', 'med_admin_edited_by_fkey', 'edited_by', 'staff'),
      ('med_admin', 'med_admin_recorded_by_fkey', 'recorded_by', 'staff'),
      ('med_admin', 'med_admin_resident_id_fkey', 'resident_id', 'residents'),
      ('med_slots', 'med_slots_deleted_by_fkey', 'deleted_by', 'staff'),
      ('med_slots', 'med_slots_edited_by_fkey', 'edited_by', 'staff'),
      ('med_slots', 'med_slots_resident_id_fkey', 'resident_id', 'residents'),
      ('note_reads', 'note_reads_note_id_fkey', 'note_id', 'notes'),
      ('note_reads', 'note_reads_staff_id_fkey', 'staff_id', 'staff'),
      ('notes', 'notes_deleted_by_fkey', 'deleted_by', 'staff'),
      ('notes', 'notes_edited_by_fkey', 'edited_by', 'staff'),
      ('notes', 'notes_ended_by_fkey', 'ended_by', 'staff'),
      ('notes', 'notes_reporter_id_fkey', 'reporter_id', 'staff'),
      ('notes', 'notes_resident_id_fkey', 'resident_id', 'residents'),
      ('outings', 'outings_deleted_by_fkey', 'deleted_by', 'staff'),
      ('outings', 'outings_edited_by_fkey', 'edited_by', 'staff'),
      ('outings', 'outings_recorded_by_fkey', 'recorded_by', 'staff'),
      ('outings', 'outings_resident_id_fkey', 'resident_id', 'residents'),
      ('resident_targets', 'resident_targets_deleted_by_fkey', 'deleted_by', 'staff'),
      ('resident_targets', 'resident_targets_edited_by_fkey', 'edited_by', 'staff'),
      ('resident_targets', 'resident_targets_resident_id_fkey', 'resident_id', 'residents'),
      ('resident_vital_limits', 'resident_vital_limits_deleted_by_fkey', 'deleted_by', 'staff'),
      ('resident_vital_limits', 'resident_vital_limits_edited_by_fkey', 'edited_by', 'staff'),
      ('resident_vital_limits', 'resident_vital_limits_resident_id_fkey', 'resident_id', 'residents'),
      ('resident_vital_limits', 'resident_vital_limits_set_by_fkey', 'set_by', 'staff'),
      ('vitals', 'vitals_deleted_by_fkey', 'deleted_by', 'staff'),
      ('vitals', 'vitals_edited_by_fkey', 'edited_by', 'staff'),
      ('vitals', 'vitals_recorded_by_fkey', 'recorded_by', 'staff'),
      ('vitals', 'vitals_resident_id_fkey', 'resident_id', 'residents')
$fn$;

select pg_temp.carelog_stage3_check();

-- ---------- 2. 施設の印を必須にする ----------
alter table public.residents alter column tenant_id set not null;
alter table public.staff alter column tenant_id set not null;
alter table public.vitals alter column tenant_id set not null;
alter table public.meals alter column tenant_id set not null;
alter table public.fluid_intake alter column tenant_id set not null;
alter table public.notes alter column tenant_id set not null;
alter table public.note_reads alter column tenant_id set not null;
alter table public.outings alter column tenant_id set not null;
alter table public.attendance alter column tenant_id set not null;
alter table public.app_settings alter column tenant_id set not null;
alter table public.import_days alter column tenant_id set not null;
alter table public.master_sync_log alter column tenant_id set not null;
alter table public.record_history alter column tenant_id set not null;
alter table public.bath_records alter column tenant_id set not null;
alter table public.med_slots alter column tenant_id set not null;
alter table public.med_admin alter column tenant_id set not null;
alter table public.incidents alter column tenant_id set not null;
alter table public.resident_targets alter column tenant_id set not null;
alter table public.resident_vital_limits alter column tenant_id set not null;
alter table public.daycare_days alter column tenant_id set not null;
alter table public.daycare_attendance alter column tenant_id set not null;
alter table public.daycare_activity_log alter column tenant_id set not null;
alter table public.daycare_training_sessions alter column tenant_id set not null;
alter table public.daycare_home_visits alter column tenant_id set not null;
alter table public.daycare_training_due alter column tenant_id set not null;
alter table public.daycare_training_due_settings alter column tenant_id set not null;
alter table public.daycare_staffing alter column tenant_id set not null;

-- ---------- 3. 利用者・職員・申し送りの（施設, 番号）と、それを指す76本の外部キー ----------
-- 先に76本を外す（付け直す一意に外部キーが掛かっていると外せないため）。名前は前と同じ
alter table public.attendance drop constraint if exists attendance_staff_id_fkey;
alter table public.bath_records drop constraint if exists bath_records_deleted_by_fkey;
alter table public.bath_records drop constraint if exists bath_records_edited_by_fkey;
alter table public.bath_records drop constraint if exists bath_records_recorded_by_fkey;
alter table public.bath_records drop constraint if exists bath_records_resident_id_fkey;
alter table public.daycare_activity_log drop constraint if exists daycare_activity_log_deleted_by_fkey;
alter table public.daycare_activity_log drop constraint if exists daycare_activity_log_edited_by_fkey;
alter table public.daycare_activity_log drop constraint if exists daycare_activity_log_recorded_by_fkey;
alter table public.daycare_activity_log drop constraint if exists daycare_activity_log_resident_id_fkey;
alter table public.daycare_attendance drop constraint if exists daycare_attendance_deleted_by_fkey;
alter table public.daycare_attendance drop constraint if exists daycare_attendance_edited_by_fkey;
alter table public.daycare_attendance drop constraint if exists daycare_attendance_recorded_by_fkey;
alter table public.daycare_attendance drop constraint if exists daycare_attendance_resident_id_fkey;
alter table public.daycare_days drop constraint if exists daycare_days_edited_by_fkey;
alter table public.daycare_days drop constraint if exists daycare_days_opened_by_fkey;
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_deleted_by_fkey;
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_edited_by_fkey;
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_recorded_by_fkey;
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_resident_id_fkey;
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_visitor_id_fkey;
alter table public.daycare_staffing drop constraint if exists daycare_staffing_deleted_by_fkey;
alter table public.daycare_staffing drop constraint if exists daycare_staffing_edited_by_fkey;
alter table public.daycare_staffing drop constraint if exists daycare_staffing_recorded_by_fkey;
alter table public.daycare_staffing drop constraint if exists daycare_staffing_staff_id_fkey;
alter table public.daycare_training_due drop constraint if exists daycare_training_due_deleted_by_fkey;
alter table public.daycare_training_due drop constraint if exists daycare_training_due_resident_id_fkey;
alter table public.daycare_training_due drop constraint if exists daycare_training_due_synced_by_fkey;
alter table public.daycare_training_due_settings drop constraint if exists daycare_training_due_settings_synced_by_fkey;
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_assisted_by_fkey;
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_deleted_by_fkey;
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_edited_by_fkey;
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_instructor_id_fkey;
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_recorded_by_fkey;
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_resident_id_fkey;
alter table public.fluid_intake drop constraint if exists fluid_intake_deleted_by_fkey;
alter table public.fluid_intake drop constraint if exists fluid_intake_edited_by_fkey;
alter table public.fluid_intake drop constraint if exists fluid_intake_recorded_by_fkey;
alter table public.fluid_intake drop constraint if exists fluid_intake_resident_id_fkey;
alter table public.incidents drop constraint if exists incidents_confirmer_id_fkey;
alter table public.incidents drop constraint if exists incidents_deleted_by_fkey;
alter table public.incidents drop constraint if exists incidents_edited_by_fkey;
alter table public.incidents drop constraint if exists incidents_reporter_id_fkey;
alter table public.incidents drop constraint if exists incidents_resident_id_fkey;
alter table public.meals drop constraint if exists meals_deleted_by_fkey;
alter table public.meals drop constraint if exists meals_edited_by_fkey;
alter table public.meals drop constraint if exists meals_recorded_by_fkey;
alter table public.meals drop constraint if exists meals_resident_id_fkey;
alter table public.med_admin drop constraint if exists med_admin_deleted_by_fkey;
alter table public.med_admin drop constraint if exists med_admin_edited_by_fkey;
alter table public.med_admin drop constraint if exists med_admin_recorded_by_fkey;
alter table public.med_admin drop constraint if exists med_admin_resident_id_fkey;
alter table public.med_slots drop constraint if exists med_slots_deleted_by_fkey;
alter table public.med_slots drop constraint if exists med_slots_edited_by_fkey;
alter table public.med_slots drop constraint if exists med_slots_resident_id_fkey;
alter table public.note_reads drop constraint if exists note_reads_note_id_fkey;
alter table public.note_reads drop constraint if exists note_reads_staff_id_fkey;
alter table public.notes drop constraint if exists notes_deleted_by_fkey;
alter table public.notes drop constraint if exists notes_edited_by_fkey;
alter table public.notes drop constraint if exists notes_ended_by_fkey;
alter table public.notes drop constraint if exists notes_reporter_id_fkey;
alter table public.notes drop constraint if exists notes_resident_id_fkey;
alter table public.outings drop constraint if exists outings_deleted_by_fkey;
alter table public.outings drop constraint if exists outings_edited_by_fkey;
alter table public.outings drop constraint if exists outings_recorded_by_fkey;
alter table public.outings drop constraint if exists outings_resident_id_fkey;
alter table public.resident_targets drop constraint if exists resident_targets_deleted_by_fkey;
alter table public.resident_targets drop constraint if exists resident_targets_edited_by_fkey;
alter table public.resident_targets drop constraint if exists resident_targets_resident_id_fkey;
alter table public.resident_vital_limits drop constraint if exists resident_vital_limits_deleted_by_fkey;
alter table public.resident_vital_limits drop constraint if exists resident_vital_limits_edited_by_fkey;
alter table public.resident_vital_limits drop constraint if exists resident_vital_limits_resident_id_fkey;
alter table public.resident_vital_limits drop constraint if exists resident_vital_limits_set_by_fkey;
alter table public.vitals drop constraint if exists vitals_deleted_by_fkey;
alter table public.vitals drop constraint if exists vitals_edited_by_fkey;
alter table public.vitals drop constraint if exists vitals_recorded_by_fkey;
alter table public.vitals drop constraint if exists vitals_resident_id_fkey;

alter table public.residents drop constraint if exists residents_tenant_id_id_key;
alter table public.residents add constraint residents_tenant_id_id_key unique (tenant_id, id);
alter table public.staff drop constraint if exists staff_tenant_id_id_key;
alter table public.staff add constraint staff_tenant_id_id_key unique (tenant_id, id);
alter table public.notes drop constraint if exists notes_tenant_id_id_key;
alter table public.notes add constraint notes_tenant_id_id_key unique (tenant_id, id);

-- 同じ名前で（施設の印, 番号）→（施設の印, id）に付け直す。消した時・番号を変えた時は今と同じ NO ACTION・遅らせない・MATCH SIMPLE
alter table public.attendance add constraint attendance_staff_id_fkey foreign key (tenant_id, staff_id) references public.staff (tenant_id, id);
alter table public.bath_records add constraint bath_records_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.bath_records add constraint bath_records_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.bath_records add constraint bath_records_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id);
alter table public.bath_records add constraint bath_records_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.daycare_activity_log add constraint daycare_activity_log_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.daycare_activity_log add constraint daycare_activity_log_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.daycare_activity_log add constraint daycare_activity_log_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id);
alter table public.daycare_activity_log add constraint daycare_activity_log_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.daycare_attendance add constraint daycare_attendance_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.daycare_attendance add constraint daycare_attendance_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.daycare_attendance add constraint daycare_attendance_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id);
alter table public.daycare_attendance add constraint daycare_attendance_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.daycare_days add constraint daycare_days_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.daycare_days add constraint daycare_days_opened_by_fkey foreign key (tenant_id, opened_by) references public.staff (tenant_id, id);
alter table public.daycare_home_visits add constraint daycare_home_visits_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.daycare_home_visits add constraint daycare_home_visits_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.daycare_home_visits add constraint daycare_home_visits_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id);
alter table public.daycare_home_visits add constraint daycare_home_visits_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.daycare_home_visits add constraint daycare_home_visits_visitor_id_fkey foreign key (tenant_id, visitor_id) references public.staff (tenant_id, id);
alter table public.daycare_staffing add constraint daycare_staffing_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.daycare_staffing add constraint daycare_staffing_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.daycare_staffing add constraint daycare_staffing_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id);
alter table public.daycare_staffing add constraint daycare_staffing_staff_id_fkey foreign key (tenant_id, staff_id) references public.staff (tenant_id, id);
alter table public.daycare_training_due add constraint daycare_training_due_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.daycare_training_due add constraint daycare_training_due_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.daycare_training_due add constraint daycare_training_due_synced_by_fkey foreign key (tenant_id, synced_by) references public.staff (tenant_id, id);
alter table public.daycare_training_due_settings add constraint daycare_training_due_settings_synced_by_fkey foreign key (tenant_id, synced_by) references public.staff (tenant_id, id);
alter table public.daycare_training_sessions add constraint daycare_training_sessions_assisted_by_fkey foreign key (tenant_id, assisted_by) references public.staff (tenant_id, id);
alter table public.daycare_training_sessions add constraint daycare_training_sessions_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.daycare_training_sessions add constraint daycare_training_sessions_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.daycare_training_sessions add constraint daycare_training_sessions_instructor_id_fkey foreign key (tenant_id, instructor_id) references public.staff (tenant_id, id);
alter table public.daycare_training_sessions add constraint daycare_training_sessions_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id);
alter table public.daycare_training_sessions add constraint daycare_training_sessions_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.fluid_intake add constraint fluid_intake_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.fluid_intake add constraint fluid_intake_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.fluid_intake add constraint fluid_intake_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id);
alter table public.fluid_intake add constraint fluid_intake_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.incidents add constraint incidents_confirmer_id_fkey foreign key (tenant_id, confirmer_id) references public.staff (tenant_id, id);
alter table public.incidents add constraint incidents_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.incidents add constraint incidents_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.incidents add constraint incidents_reporter_id_fkey foreign key (tenant_id, reporter_id) references public.staff (tenant_id, id);
alter table public.incidents add constraint incidents_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.meals add constraint meals_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.meals add constraint meals_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.meals add constraint meals_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id);
alter table public.meals add constraint meals_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.med_admin add constraint med_admin_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.med_admin add constraint med_admin_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.med_admin add constraint med_admin_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id);
alter table public.med_admin add constraint med_admin_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.med_slots add constraint med_slots_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.med_slots add constraint med_slots_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.med_slots add constraint med_slots_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.note_reads add constraint note_reads_note_id_fkey foreign key (tenant_id, note_id) references public.notes (tenant_id, id);
alter table public.note_reads add constraint note_reads_staff_id_fkey foreign key (tenant_id, staff_id) references public.staff (tenant_id, id);
alter table public.notes add constraint notes_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.notes add constraint notes_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.notes add constraint notes_ended_by_fkey foreign key (tenant_id, ended_by) references public.staff (tenant_id, id);
alter table public.notes add constraint notes_reporter_id_fkey foreign key (tenant_id, reporter_id) references public.staff (tenant_id, id);
alter table public.notes add constraint notes_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.outings add constraint outings_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.outings add constraint outings_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.outings add constraint outings_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id);
alter table public.outings add constraint outings_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.resident_targets add constraint resident_targets_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.resident_targets add constraint resident_targets_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.resident_targets add constraint resident_targets_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.resident_vital_limits add constraint resident_vital_limits_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.resident_vital_limits add constraint resident_vital_limits_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.resident_vital_limits add constraint resident_vital_limits_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);
alter table public.resident_vital_limits add constraint resident_vital_limits_set_by_fkey foreign key (tenant_id, set_by) references public.staff (tenant_id, id);
alter table public.vitals add constraint vitals_deleted_by_fkey foreign key (tenant_id, deleted_by) references public.staff (tenant_id, id);
alter table public.vitals add constraint vitals_edited_by_fkey foreign key (tenant_id, edited_by) references public.staff (tenant_id, id);
alter table public.vitals add constraint vitals_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id);
alter table public.vitals add constraint vitals_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id);

-- ---------- 4. 一意を施設ごとにする ----------
-- 利用者No
alter table public.residents drop constraint if exists residents_source_id_key;
alter table public.residents drop constraint if exists residents_tenant_id_source_id_key;
alter table public.residents add constraint residents_tenant_id_source_id_key unique (tenant_id, source_id);
-- 職員の名前
alter table public.staff drop constraint if exists staff_name_key;
alter table public.staff drop constraint if exists staff_tenant_id_name_key;
alter table public.staff add constraint staff_tenant_id_name_key unique (tenant_id, name);
-- 取込の印
alter table public.vitals drop constraint if exists vitals_import_key_key;
alter table public.vitals drop constraint if exists vitals_tenant_id_import_key_key;
alter table public.vitals add constraint vitals_tenant_id_import_key_key unique (tenant_id, import_key);
alter table public.meals drop constraint if exists meals_import_key_key;
alter table public.meals drop constraint if exists meals_tenant_id_import_key_key;
alter table public.meals add constraint meals_tenant_id_import_key_key unique (tenant_id, import_key);
alter table public.notes drop constraint if exists notes_import_key_key;
alter table public.notes drop constraint if exists notes_tenant_id_import_key_key;
alter table public.notes add constraint notes_tenant_id_import_key_key unique (tenant_id, import_key);
-- 旗・設定（主キーの名前は同じ）
alter table public.app_settings drop constraint if exists app_settings_pkey;
alter table public.app_settings add constraint app_settings_pkey primary key (tenant_id, key);
-- 取込の日（主キーの名前は同じ。取込の道具は名前で衝突の先を指す）
alter table public.import_days drop constraint if exists import_days_pkey;
alter table public.import_days add constraint import_days_pkey primary key (tenant_id, source, day);
-- 計画書の期限の規則（施設ごとに1行。1行だけの決まり id = 1 はそのまま）
alter table public.daycare_training_due_settings drop constraint if exists daycare_training_due_settings_pkey;
alter table public.daycare_training_due_settings add constraint daycare_training_due_settings_pkey primary key (tenant_id, id);
-- 施設長は1日1人（画面が名前で見分けるので同じ名前・同じ条件）
drop index if exists public.uq_attendance_manager_day;
create unique index uq_attendance_manager_day
  on public.attendance (tenant_id, day)
  where role = 'manager' and sort >= 0;
comment on index public.uq_attendance_manager_day is
  '日報の施設長は1日1人（表示中＝sort >= 0 の role=manager）。外した行（sort < 0）は数えない。2026-10-10 F70。施設ごと（0053）。';
-- デイのその日の写しは1日1行（施設ごと）
drop index if exists public.uq_daycare_days_day;
create unique index uq_daycare_days_day on public.daycare_days (tenant_id, day);

-- ---------- 5. 施設の印の索引（施設の印で始まる索引の無い18表） ----------
create index if not exists ix_fluid_intake_tenant_id on public.fluid_intake (tenant_id);
create index if not exists ix_note_reads_tenant_id on public.note_reads (tenant_id);
create index if not exists ix_outings_tenant_id on public.outings (tenant_id);
create index if not exists ix_attendance_tenant_id on public.attendance (tenant_id);
create index if not exists ix_master_sync_log_tenant_id on public.master_sync_log (tenant_id);
create index if not exists ix_record_history_tenant_id on public.record_history (tenant_id);
create index if not exists ix_bath_records_tenant_id on public.bath_records (tenant_id);
create index if not exists ix_med_slots_tenant_id on public.med_slots (tenant_id);
create index if not exists ix_med_admin_tenant_id on public.med_admin (tenant_id);
create index if not exists ix_incidents_tenant_id on public.incidents (tenant_id);
create index if not exists ix_resident_targets_tenant_id on public.resident_targets (tenant_id);
create index if not exists ix_resident_vital_limits_tenant_id on public.resident_vital_limits (tenant_id);
create index if not exists ix_daycare_attendance_tenant_id on public.daycare_attendance (tenant_id);
create index if not exists ix_daycare_activity_log_tenant_id on public.daycare_activity_log (tenant_id);
create index if not exists ix_daycare_training_sessions_tenant_id on public.daycare_training_sessions (tenant_id);
create index if not exists ix_daycare_home_visits_tenant_id on public.daycare_home_visits (tenant_id);
create index if not exists ix_daycare_training_due_tenant_id on public.daycare_training_due (tenant_id);
create index if not exists ix_daycare_staffing_tenant_id on public.daycare_staffing (tenant_id);

-- ---------- 6. 計画書の期限の写し（その施設の行だけ） ----------
-- 0046 と同じ本文。違いは、ログインした人の施設（private.carelog_cur_tenant()）の利用者・写しの行・規則の1行だけを
-- 読み書きすること（施設が決まらない時は 42501 で何も読まずに止める）と、規則の1行の衝突の先が (tenant_id, id) なことだけ
create or replace function public.daycare_training_due_sync(p_rows jsonb, p_settings jsonb, p_staff bigint)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_existing integer;
  v_incoming integer;
  v_matched integer;
  v_matched_rows integer;
  v_cancel integer;
  v_in jsonb;
  v_now timestamptz := now();
  v_rule text;
  v_warn integer;
  v_tenant uuid;
begin
  if not private.office_writable() then
    raise exception 'training_due_office_only: 計画書の期限の写しは、事務所のログインでだけ行えます'
      using errcode = '42501';
  end if;
  -- 施設（ログインした人の施設・0053）。決まらない時は何も読まずに止める（よその施設の行に触れない）
  v_tenant := private.carelog_cur_tenant();
  if v_tenant is null then
    raise exception 'training_due_office_only: 計画書の期限の写しは、事務所のログインでだけ行えます'
      using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'training_due_bad_rows: 写しの行の形が違います' using errcode = '22023';
  end if;
  v_rule := coalesce(p_settings->>'due_rule', 'calendar');
  if v_rule not in ('calendar', 'days90', 'min') then
    v_rule := 'calendar';
  end if;
  v_warn := case when (p_settings->>'warn_days') ~ '^[0-9]{1,3}$' then (p_settings->>'warn_days')::integer else 28 end;
  if v_warn > 365 then
    v_warn := 28;
  end if;

  select count(*) into v_existing from public.daycare_training_due where deleted_at is null and tenant_id = v_tenant;
  v_incoming := pg_catalog.jsonb_array_length(p_rows);

  -- 利用者番号（residents.source_id）で結べた行だけを、値をそろえて集める。同じ方が2行来たら、後ろの行を採る（決め手を固定）
  select coalesce(pg_catalog.jsonb_agg(x), '[]'::jsonb) into v_in
    from (
      select distinct on (r.id)
             r.id as resident_id,
             nullif(e.v->>'latest_plan_date', '')::date as latest_plan_date,
             nullif(e.v->>'next_due', '')::date as next_due,
             case when e.v->>'stop_reason' in ('discharge', 'stopped', 'notNeeded') then e.v->>'stop_reason' end as stop_reason,
             nullif(e.v->>'stop_from', '')::date as stop_from,
             case when e.v->>'plan_status' in ('none', 'draft_ai', 'reviewed', 'printed', 'signed') then e.v->>'plan_status' end as plan_status
        from pg_catalog.jsonb_array_elements(p_rows) with ordinality as e(v, ord)
        join public.residents r on r.source_id = e.v->>'master_id' and r.tenant_id = v_tenant
       order by r.id, e.ord desc
    ) x;
  v_matched := pg_catalog.jsonb_array_length(v_in);
  -- 結べなかった行の数は、来た行のうち番号で結べなかった行の数（同じ方の2行目は「結べた」に数える）
  select count(*) into v_matched_rows
    from pg_catalog.jsonb_array_elements(p_rows) as e
    join public.residents r on r.source_id = e->>'master_id' and r.tenant_id = v_tenant;
  select count(*) into v_cancel
    from public.daycare_training_due d
   where d.deleted_at is null
     and d.tenant_id = v_tenant
     and not exists (select 1 from pg_catalog.jsonb_to_recordset(v_in) as i(resident_id bigint) where i.resident_id = d.resident_id);

  if v_incoming = 0 and v_existing > 0 then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'empty', 'existing', v_existing);
  end if;
  if v_matched = 0 and v_existing > 0 then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'nomatch', 'existing', v_existing, 'incoming', v_incoming);
  end if;
  if v_existing > 0 and v_cancel * 2 > v_existing then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'too_many', 'existing', v_existing, 'cancel', v_cancel);
  end if;

  -- 今ある行を更新（値が同じでも写した日時は進める）
  update public.daycare_training_due d
     set latest_plan_date = i.latest_plan_date, next_due = i.next_due, stop_reason = i.stop_reason,
         stop_from = i.stop_from, plan_status = i.plan_status, synced_at = v_now, synced_by = p_staff
    from pg_catalog.jsonb_to_recordset(v_in)
         as i(resident_id bigint, latest_plan_date date, next_due date, stop_reason text, stop_from date, plan_status text)
   where d.resident_id = i.resident_id and d.deleted_at is null and d.tenant_id = v_tenant;
  -- 無い方は足す
  insert into public.daycare_training_due (resident_id, latest_plan_date, next_due, stop_reason, stop_from, plan_status, synced_at, synced_by, tenant_id)
  select i.resident_id, i.latest_plan_date, i.next_due, i.stop_reason, i.stop_from, i.plan_status, v_now, p_staff, v_tenant
    from pg_catalog.jsonb_to_recordset(v_in)
         as i(resident_id bigint, latest_plan_date date, next_due date, stop_reason text, stop_from date, plan_status text)
   where not exists (select 1 from public.daycare_training_due d where d.resident_id = i.resident_id and d.deleted_at is null);
  -- 今回来なかった方は取り消しの印（物理削除はしない）
  update public.daycare_training_due d
     set deleted_at = v_now, deleted_by = p_staff
   where d.deleted_at is null
     and d.tenant_id = v_tenant
     and not exists (select 1 from pg_catalog.jsonb_to_recordset(v_in) as i(resident_id bigint) where i.resident_id = d.resident_id);
  -- 規則と日数
  insert into public.daycare_training_due_settings (tenant_id, id, due_rule, warn_days, synced_at, synced_by, updated_at)
  values (v_tenant, 1, v_rule, v_warn, v_now, p_staff, v_now)
  on conflict (tenant_id, id) do update
    set due_rule = excluded.due_rule, warn_days = excluded.warn_days,
        synced_at = excluded.synced_at, synced_by = excluded.synced_by, updated_at = excluded.updated_at;

  return pg_catalog.jsonb_build_object('ok', true, 'written', v_matched, 'unmatched', v_incoming - v_matched_rows,
                                       'cancelled', v_cancel, 'synced_at', v_now);
end;
$fn$;
comment on function public.daycare_training_due_sync(jsonb, jsonb, bigint) is
  '計画書アプリの索引の期限を daycare_training_due に写す（1回の取引・利用者番号で結ぶ・空上書きの保護つき）。事務所・管理者だけ。0046。その施設の行だけ（0053）。';
revoke all on function public.daycare_training_due_sync(jsonb, jsonb, bigint) from public, anon;
grant execute on function public.daycare_training_due_sync(jsonb, jsonb, bigint) to authenticated;

commit;

notify pgrst, 'reload schema';

-- ── 確かめ（Run の結果に7行。全部 ok なら完了）──
select '27表の施設の印が必須（not null）' as check_item,
       case when (select pg_catalog.count(*) from information_schema.columns
                   where table_schema = 'public' and column_name = 'tenant_id' and is_nullable = 'NO'
                     and table_name in ('residents', 'staff', 'vitals', 'meals', 'fluid_intake', 'notes', 'note_reads', 'outings', 'attendance', 'app_settings', 'import_days', 'master_sync_log', 'record_history', 'bath_records', 'med_slots', 'med_admin', 'incidents', 'resident_targets', 'resident_vital_limits', 'daycare_days', 'daycare_attendance', 'daycare_activity_log', 'daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due', 'daycare_training_due_settings', 'daycare_staffing')) = 27
            then 'ok' else 'NG' end as status
union all
select '27表に印を入れるトリガがある',
       case when (select pg_catalog.count(*) from pg_catalog.pg_trigger where tgname = 'carelog_fill_tenant' and not tgisinternal) = 27 then 'ok' else 'NG' end
union all
select '利用者・職員・申し送りを指す外部キーは76本とも（施設の印, 番号）の組',
       case when (select pg_catalog.count(*) from pg_catalog.pg_constraint k
                   where k.contype = 'f' and k.confrelid in ('public.residents'::regclass, 'public.staff'::regclass, 'public.notes'::regclass)
                     and pg_catalog.cardinality(k.conkey) = 2) = 76
             and (select pg_catalog.count(*) from pg_catalog.pg_constraint k
                   where k.contype = 'f' and k.confrelid in ('public.residents'::regclass, 'public.staff'::regclass, 'public.notes'::regclass)
                     and pg_catalog.cardinality(k.conkey) <> 2) = 0
            then 'ok' else 'NG' end
union all
select '施設をまたぐ一意が残っていない（利用者No・職員の名前・取込の印）',
       case when not exists (select 1 from pg_catalog.pg_constraint
                              where conname in ('residents_source_id_key', 'staff_name_key', 'vitals_import_key_key', 'meals_import_key_key', 'notes_import_key_key'))
             and (select pg_catalog.count(*) from pg_catalog.pg_constraint
                   where conname in ('residents_tenant_id_source_id_key', 'staff_tenant_id_name_key', 'vitals_tenant_id_import_key_key',
                                     'meals_tenant_id_import_key_key', 'notes_tenant_id_import_key_key',
                                     'residents_tenant_id_id_key', 'staff_tenant_id_id_key', 'notes_tenant_id_id_key')) = 8
            then 'ok' else 'NG' end
union all
select '主キーが施設ごと（旗・取込の日・計画書の規則）',
       case when pg_catalog.pg_get_constraintdef((select oid from pg_catalog.pg_constraint where conname = 'app_settings_pkey' and conrelid = 'public.app_settings'::regclass)) = 'PRIMARY KEY (tenant_id, key)'
             and pg_catalog.pg_get_constraintdef((select oid from pg_catalog.pg_constraint where conname = 'import_days_pkey' and conrelid = 'public.import_days'::regclass)) = 'PRIMARY KEY (tenant_id, source, day)'
             and pg_catalog.pg_get_constraintdef((select oid from pg_catalog.pg_constraint where conname = 'daycare_training_due_settings_pkey' and conrelid = 'public.daycare_training_due_settings'::regclass)) = 'PRIMARY KEY (tenant_id, id)'
            then 'ok' else 'NG' end
union all
select '施設長は1日1人・その日の写しは1日1行が施設ごと（名前は同じ）',
       case when (select indexdef from pg_catalog.pg_indexes where schemaname = 'public' and indexname = 'uq_attendance_manager_day')
                 = 'CREATE UNIQUE INDEX uq_attendance_manager_day ON public.attendance USING btree (tenant_id, day) WHERE ((role = ''manager''::text) AND (sort >= 0))'
             and (select indexdef from pg_catalog.pg_indexes where schemaname = 'public' and indexname = 'uq_daycare_days_day')
                 = 'CREATE UNIQUE INDEX uq_daycare_days_day ON public.daycare_days USING btree (tenant_id, day)'
            then 'ok' else 'NG' end
union all
select '計画書の期限の写しがその施設の行だけを書く（規則の1行の衝突の先が施設と番号）',
       case when (select pg_catalog.count(*) from pg_catalog.pg_proc
                   where oid = 'public.daycare_training_due_sync(jsonb, jsonb, bigint)'::regprocedure
                     and prosrc like '%on conflict (tenant_id, id) do update%'
                     and prosrc like '%private.carelog_cur_tenant()%') = 1
            then 'ok' else 'NG' end;
