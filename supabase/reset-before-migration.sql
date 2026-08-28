-- ═══════════════════════════════════════════════════════════════════
-- 移行前のリセット（疑似データの一掃）
--
-- 何をするか: 業務表11本を空にして、id の採番を1から振り直す。
--   app_settings（施設名・施設長印・入力解禁フラグ）だけは残す。
--
-- 何をしないか: **スキーマ・索引・RLSポリシー・権限には一切触れない。**
--   drop schema public でも作り直しでもないので、Supabase 側の既定の権限
--   （anon / authenticated / service_role への GRANT）が壊れる心配がない。
--   ＝アプリが動かなくなる経路を最初から作らない。
--
-- いつ使うか: 実在の入居者マスタを入れる**直前に1回だけ**。
--   実データが1件でも入った後は絶対に流さないこと。
--
-- 実行場所: Supabase ダッシュボードの SQL エディタ。
--   postgres 権限で走るので RLS を素通りする。
--   アプリ経由では削除ポリシーが無いため実行できない＝現場の誤操作では絶対に起きない。
--
-- ★ do $$ … $$ のブロックは使わない。Supabase の SQL エディタはこの書き方を
--   誤解釈して別のエラー（42P01 relation ... does not exist）を出す
--   ＝ 2026-08-28 に実機で確認済み。安全弁は「人が目で見る SELECT」で担保する。
--
-- 注意: truncate は取り消せない。実行前に必ずバックアップを取ること:
--   ターミナルで  ~/bin/care-log-backup.sh --force
-- ═══════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────
-- 【手順1】安全弁。まずこれだけを実行して、目で 0 を確認する。
--   import_key を持つ行＝蓄積スプシから取り込んだ本物の記録。
--   0 以外が出たら**この先へ進まない**（本物の記録が入っている＝流してはいけない）。
-- ───────────────────────────────────────────────────────────────────

select count(*) as "取込済みの本物の記録（0なら手順2へ）"
from (
  select 1 from notes  where import_key is not null
  union all
  select 1 from vitals where import_key is not null
  union all
  select 1 from meals  where import_key is not null
) x;


-- ───────────────────────────────────────────────────────────────────
-- 【手順2】手順1が 0 だったときだけ、ここから下を実行する。
--   参照の向きに関係なく一括で空にする（cascade は外部キーで繋がる表も対象）。
--   restart identity で id を1から振り直す＝移行後の id が飛ばない。
-- ───────────────────────────────────────────────────────────────────

begin;

truncate table
  note_reads,
  notes,
  vitals,
  meals,
  fluid_intake,
  outings,
  attendance,
  import_days,
  master_sync_log,
  residents,
  staff
restart identity cascade;

commit;


-- ───────────────────────────────────────────────────────────────────
-- 【手順3】確認。app_settings 以外がすべて 0 になっていること。
-- ───────────────────────────────────────────────────────────────────

select 'notes' as "表", count(*) as "件数" from notes
union all select 'note_reads',           count(*) from note_reads
union all select 'vitals',               count(*) from vitals
union all select 'meals',                count(*) from meals
union all select 'fluid_intake',         count(*) from fluid_intake
union all select 'outings',              count(*) from outings
union all select 'attendance',           count(*) from attendance
union all select 'residents',            count(*) from residents
union all select 'staff',                count(*) from staff
union all select 'import_days',          count(*) from import_days
union all select 'master_sync_log',      count(*) from master_sync_log
union all select 'app_settings（残す）', count(*) from app_settings
order by 1;
