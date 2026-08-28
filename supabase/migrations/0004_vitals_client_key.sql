-- =====================================================================
-- 0004: バイタルの冪等キー（client_key）
--
-- 適用方法: Supabase ダッシュボード > SQL Editor に、0001 → 0002 → 0003 を実行した後で
--           このファイルの内容を貼り付けて実行する。
--           全体が冪等（add column if not exists / create unique index if not exists）なので
--           何度実行しても同じ結果になり、既存のデータ・列・索引は一切消えない（追加のみ）。
--
-- 背景（0001_init.sql 冒頭の宣言との食い違いを埋める）:
--   0001 は「自然キーを作れない表は端末が付ける冪等キー client_key を unique にして
--   同じ役目を持たせる」と宣言し、notes / fluid_intake / outings にだけ列を足していた。
--   バイタルは定時（kind='routine'）だけが部分unique索引 uq_vitals_routine_day
--   （resident_id, measured_on）で守られていて、
--     ・再検        kind='recheck'
--     ・発熱者      kind='observation'
--     ・他症状者    kind='symptom'
--   は「同じ人の同じ日に複数行」を書ける運用＝自然キーが無い。
--   このため、サーバーには届いてコミットされたのに応答だけが失われた場合
--   （通信断・タイムアウト）に、送信キューの再送で同じ記録が2行できうる。
--   0001 の宣言どおり client_key を足し、DB 側で1行へ収束させる。
--
-- 収束のしかた（アプリ側の作法は既存のまま・src/lib/db.ts）:
--   ・端末は1入力につき1つの client_key を生成し、再送のたびに同じ値を送る。
--   ・2度目の insert は 23505 になる → 「もう届いている」証拠として既存行を読み直し、
--     新しい行を作らずに成功扱いにする（upsert は使わない）。
--   ・kind='routine' には付けない。付けると 23505 の切替先が client_key になり、
--     他端末が先に作った定時行へ update で合流できなくなるため（既存の挙動を変えない）。
--
-- null の扱い: Postgres の unique 索引は null どうしを重複扱いしないので、
--   client_key が null の行（取込データ・0004 適用前に入った行・定時バイタル）は
--   何行あってもよい。既存 12万行は null のまま残る＝過去データは変わらない。
--
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

-- 列（既に作成済みのデータベースへ後から足せるよう冪等に書く）
alter table vitals add column if not exists client_key text;

-- 二重登録の防波堤。deleted_at で絞らない全体unique にする理由は 0001 と同じで、
-- 削除済みの行が同じキーを押さえたままになり、退避していた再送を
-- 「もう届いている（消えた行を作り直さない）」と 23505 で判定できるため。
create unique index if not exists uq_vitals_client_key on vitals (client_key);

-- PostgREST のスキーマキャッシュを即時リロード（適用直後に PGRST204 が出る期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL Editor で実行して目視する）
--
-- 1) 列が増えているか
--    select column_name, is_nullable from information_schema.columns
--     where table_name='vitals' and column_name='client_key';
--    → client_key / YES（null 可）の1行
--
-- 2) unique 索引ができているか
--    select indexname, indexdef from pg_indexes
--     where tablename='vitals' and indexname='uq_vitals_client_key';
--    → create unique index ... on public.vitals using btree (client_key)
--
-- 3) 既存行が壊れていないか（すべて null のまま・行数が減っていないこと）
--    select count(*) as total, count(client_key) as with_key from vitals;
--    → total は適用前と同じ・with_key は 0（アプリ切替後の新規記録から増える）
--
-- ロールバック（業務データには影響しない。列を落とすと再送の重複判定だけが効かなくなる）:
--    drop index if exists uq_vitals_client_key;
--    -- 列は残しておいてよい（null のまま無害）。どうしても戻す場合のみ:
--    -- alter table vitals drop column if exists client_key;
-- ---------------------------------------------------------------------
