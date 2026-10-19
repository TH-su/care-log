-- =====================================================================
-- 0038: 同じ入職日の中の順（staff.master_no・staff.master_no_manual）を持つ（本人指示 2026-10-19）
--
-- 0001〜0037 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- 列を2つ足すだけ（値は空・false で足す。既存の行・データには触れない）。
--
-- なぜ: 職員を選ぶ欄は入職日の順（0036）。同じ入職日の職員が複数いる時（開設時の職員など）、次の決め手が
--   名前の文字コード順だったため、本人の考える入職の順にならなかった（本人確認 2026-10-19）。
--   同じ入職日の中は master_no の小さい順にする。master_no は名簿の同期が職員マスタの職員No（数字の部分）から
--   入職日と一緒に取り込む。職員No の順が実際の入職の順と違う時のために、設定画面の「職員の入職日（並び順）」で
--   事務・管理者が手で順を入れられる（master_no_manual = true の行は名簿の同期で上書きしない。0037 と同じ考え方）。
--
-- 旧クライアント×新サーバー: 旧版はこの列を読まない・書かないので、今までどおりの順で並ぶだけ（データは消えない）。
-- 新クライアント×旧サーバー: 新版は職員を読む時にこの列を選ぶので、列が無いと職員の読み取りが失敗する
--   ＝**この移行を当ててからアプリを公開する**。
--
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
-- 個人情報: このファイルに実在の氏名を書かない（構造だけを定義する）。
-- =====================================================================

alter table public.staff add column if not exists master_no integer;
alter table public.staff add column if not exists master_no_manual boolean not null default false;

comment on column public.staff.master_no is
  '同じ入職日の中の順（小さい順）。名簿の同期が職員マスタの職員No（数字の部分）を書く。空は末尾。2026-10-19';
comment on column public.staff.master_no_manual is
  'true = 設定画面で手で入れた順（名簿の同期で上書きしない）。false = 職員マスタの職員No から取り込む。2026-10-19';

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'staff' and column_name in ('master_no', 'master_no_manual');
--   → 2行（master_no / integer、master_no_manual / boolean）
--
-- 戻す時（必要な時だけ。アプリを前の版に戻してから）:
--   alter table public.staff drop column if exists master_no_manual;
--   alter table public.staff drop column if exists master_no;
-- ---------------------------------------------------------------------
