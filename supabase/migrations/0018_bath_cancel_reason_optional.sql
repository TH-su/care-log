-- 0018: 入浴の「中止」に理由を必須にしない（2026-10-01 代表指示）。
--
-- 画面の入浴チェックを「入浴した／入浴していない」の2つだけにした。入浴していない（result='cancel'）は
-- 理由を選ばずに保存するため、0012 で付けた「中止には理由が必須」の制約（bath_records_cancel_needs_reason）を外す。
-- 理由の列（cancel_reason）と値の制約（bath_records_cancel_reason_check）はそのまま残す（以前の記録の理由を消さない）。
-- アプリ（care-log）より先に本番へ当てる（理由なしの中止を送る版より先）。
-- 戻す時: 理由なしの中止が1件も無いことを確かめてから、0012 の add constraint をもう一度流す。

alter table public.bath_records drop constraint if exists bath_records_cancel_needs_reason;

-- 確認（外れていれば 0 行）
select conname from pg_constraint
 where conrelid = 'public.bath_records'::regclass and conname = 'bath_records_cancel_needs_reason';
