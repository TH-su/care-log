-- =====================================================================
-- 0064: デイ（せせらぎ）の連絡帳に、項目ごとの記載の欄を4つ足す（2026-11-18 本人指示・代表者の決定「4項目」）
--
-- 足すだけ・既存を変えない。0001〜0063 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- 足すもの（daycare_contact_notes＝1人1日1行の表に列を足すだけ。新しい表・関数・RPC は作らない）:
--   vital_meal_note … バイタル・食事のようす（200字まで・空は null）。バイタル・食事の画面と連絡帳の画面の両方から書く
--   activity_note   … 活動のようす（200字まで）。活動の画面と連絡帳の画面から書く
--   training_note   … 機能訓練（リハビリ）のようす（200字まで）。機能訓練の画面と連絡帳の画面から書く
--   behavior_note   … 行動・ご様子（200字まで）。活動の画面と連絡帳の画面から書く
--   どの画面から書いても同じ行の同じ列を書く（写しを作らない＝どちらから直しても同じ文になる）。画面は変えた欄だけを送り rev を照合する。
--   既存の body（個別のひと言）・nurse_note（看護職のひと言）・printed_at はそのまま。
-- 守り: 0061 の行の守りがそのまま効く（施設の印・RLS の5本・消す権限なし・過去の日は事務所だけ・未来の日は誰も書けない・
--   変更の記録 record_history_capture('day')・rev）。列を足しても守りの本数は変わらない。
--
-- 旧クライアント×新サーバー: 旧版は新しい列を読まない・送らないので何も変わらない（新しい欄が画面に無いだけ）。
-- 新クライアント×旧サーバー（このファイルを当てる前に画面を出した時）: 画面は列が無い（42703／PGRST204）時に古い列だけで読み直し、
--   新しい欄を「まだ使えません（サーバー側の設定待ち）」として押せなくする（個別のひと言・看護職のひと言・印刷は今までどおり）。
-- 適用の順: DB 先 → アプリ。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- 戻し方（必要な時だけ・書いた4欄の文も消える。先に中身を書き出してから流す）: supabase/rollback/0064_back.sql
-- =====================================================================

begin;
set local lock_timeout = '5s';

alter table public.daycare_contact_notes add column if not exists vital_meal_note text;
alter table public.daycare_contact_notes add column if not exists activity_note text;
alter table public.daycare_contact_notes add column if not exists training_note text;
alter table public.daycare_contact_notes add column if not exists behavior_note text;

alter table public.daycare_contact_notes drop constraint if exists daycare_contact_notes_vital_meal_note_check;
alter table public.daycare_contact_notes add constraint daycare_contact_notes_vital_meal_note_check
  check (vital_meal_note is null or pg_catalog.char_length(vital_meal_note) <= 200);
alter table public.daycare_contact_notes drop constraint if exists daycare_contact_notes_activity_note_check;
alter table public.daycare_contact_notes add constraint daycare_contact_notes_activity_note_check
  check (activity_note is null or pg_catalog.char_length(activity_note) <= 200);
alter table public.daycare_contact_notes drop constraint if exists daycare_contact_notes_training_note_check;
alter table public.daycare_contact_notes add constraint daycare_contact_notes_training_note_check
  check (training_note is null or pg_catalog.char_length(training_note) <= 200);
alter table public.daycare_contact_notes drop constraint if exists daycare_contact_notes_behavior_note_check;
alter table public.daycare_contact_notes add constraint daycare_contact_notes_behavior_note_check
  check (behavior_note is null or pg_catalog.char_length(behavior_note) <= 200);

comment on column public.daycare_contact_notes.vital_meal_note is
  'バイタル・食事のようす（連絡帳の項目ごとの記載・200字まで）。バイタル・食事の画面と連絡帳の画面の両方から書く。0064。';
comment on column public.daycare_contact_notes.activity_note is
  '活動のようす（連絡帳の項目ごとの記載・200字まで）。活動の画面と連絡帳の画面の両方から書く。0064。';
comment on column public.daycare_contact_notes.training_note is
  '機能訓練（リハビリ）のようす（連絡帳の項目ごとの記載・200字まで）。機能訓練の画面と連絡帳の画面の両方から書く。回ごとの備考 daycare_training_sessions.note とは別。0064。';
comment on column public.daycare_contact_notes.behavior_note is
  '行動・ご様子（連絡帳の項目ごとの記載・200字まで）。活動の画面と連絡帳の画面の両方から書く。0064。';

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（読むだけ。ok なら入った）
-- ---------------------------------------------------------------------
select '連絡帳の項目ごとの4欄（列4本・字数の守り4本・行の守りは0061のまま）' as what,
       case when (select pg_catalog.count(*) from information_schema.columns
                   where table_schema = 'public' and table_name = 'daycare_contact_notes'
                     and column_name in ('vital_meal_note', 'activity_note', 'training_note', 'behavior_note')
                     and data_type = 'text' and is_nullable = 'YES') = 4
             and (select pg_catalog.count(*) from pg_catalog.pg_constraint
                   where conrelid = 'public.daycare_contact_notes'::regclass
                     and conname in ('daycare_contact_notes_vital_meal_note_check', 'daycare_contact_notes_activity_note_check',
                                     'daycare_contact_notes_training_note_check', 'daycare_contact_notes_behavior_note_check')) = 4
             and (select pg_catalog.count(*) from pg_catalog.pg_policies
                   where schemaname = 'public' and tablename = 'daycare_contact_notes') = 5
             and (select pg_catalog.count(*) from information_schema.role_table_grants
                   where table_schema = 'public' and table_name = 'daycare_contact_notes'
                     and grantee in ('authenticated', 'anon') and privilege_type in ('DELETE', 'TRUNCATE')) = 0
             and (select pg_catalog.count(*) from pg_catalog.pg_trigger
                   where not tgisinternal and tgname = 'trg_daycare_contact_notes_day_guard') = 1
            then 'ok' else 'NG' end as result;
