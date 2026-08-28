-- =====================================================================
-- 0003: スプレッドシート模倣UI（日報・バイタル一覧・食事一覧）のための追加
--
-- 0001 を当てたあとに実行する。すべて冪等（何度実行しても同じ結果になる）。
-- 既存のテーブル・列・データは一切削除しない（追加のみ）。
--
-- 追加するもの:
--   1. vitals.symptom          … 現行スプシ「他症状者」ブロックの症状欄
--   2. vitals.kind に 'symptom' … 発熱者（observation）と他症状者（symptom）を区別する
--   3. notes.color             … 行の色（既定は用途に紐づくが後から変更できる）
--   4. notes.after16           … 日勤の「↓16時以降の記録」区切りより後の行
--   5. attendance              … 出勤者・施設長（現行スプシ上部の欄）
--
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 1・2. バイタル（他症状者の症状欄と種別の追加） ----------
alter table vitals add column if not exists symptom text;

-- kind の許容値に 'symptom' を足す（既存行は routine/recheck/observation のままなので影響なし）
alter table vitals drop constraint if exists vitals_kind_check;
alter table vitals add constraint vitals_kind_check
  check (kind in ('routine', 'recheck', 'observation', 'symptom'));

-- ---------- 3・4. 申し送り（行の色と16時区切り） ----------
alter table notes add column if not exists color text;
alter table notes add column if not exists after16 boolean not null default false;

alter table notes drop constraint if exists notes_color_check;
alter table notes add constraint notes_color_check
  check (color is null or color in ('pink', 'yellow', 'blue', 'green', 'orange'));

-- ---------- 5. 出勤者（施設長＋その日の勤務者） ----------
-- 1日1行ではなく「1日 × 職員」で持つ。並び順は sort（現行スプシの左からの並びに対応）。
-- 職員が名簿から消えても過去の日報は残す（staff は soft delete しない設計＝active=false のみ）。
create table if not exists attendance (
  day       date   not null,
  staff_id  bigint not null references staff(id),
  role      text   not null default 'staff' check (role in ('manager', 'staff')),
  sort      int    not null default 0,
  created_at timestamptz not null default now(),
  primary key (day, staff_id)
);

create index if not exists idx_attendance_day on attendance (day desc);

-- RLS（0001 と同じ方針: 読み書きとも authenticated 限定・delete ポリシーは作らない）
alter table attendance enable row level security;
drop policy if exists "read_auth"   on attendance;
drop policy if exists "insert_auth" on attendance;
drop policy if exists "update_auth" on attendance;
create policy "read_auth"   on attendance for select to authenticated using (true);
create policy "insert_auth" on attendance for insert to authenticated with check (true);
create policy "update_auth" on attendance for update to authenticated using (true) with check (true);

-- 出勤者は「その日の記録」なので、行の取り消しは delete ではなく再登録で表現する。
-- 誤って登録した行を消す必要が出た場合に備え、削除だけは service_role（管理者）に限る
-- ＝ authenticated には delete ポリシーを作らない（0001 の全表と同じ考え方）。

-- ---------- 索引（日報画面が1日分をまとめて引くため） ----------
create index if not exists idx_vitals_day_kind on vitals (measured_on desc, kind)
  where deleted_at is null;
create index if not exists idx_notes_day_after16 on notes (note_on desc, after16)
  where deleted_at is null;

-- Realtime（0001 で登録済みの6表に attendance を足す）
alter publication supabase_realtime
  set table notes, vitals, meals, fluid_intake, outings, note_reads, attendance;

-- PostgREST のスキーマキャッシュを即時リロード
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL Editor で実行して目視する）
--
-- 1) 列が増えているか
--    select column_name from information_schema.columns
--     where table_name='notes' and column_name in ('color','after16');
--    → color / after16 の2行
--
-- 2) 種別が増えているか
--    select pg_get_constraintdef(oid) from pg_constraint where conname='vitals_kind_check';
--    → symptom を含む check 式
--
-- 3) attendance が anon から見えないか
--    select tablename, policyname, roles from pg_policies where tablename='attendance';
--    → roles に anon / public が出ないこと（authenticated のみ）
-- ---------------------------------------------------------------------
