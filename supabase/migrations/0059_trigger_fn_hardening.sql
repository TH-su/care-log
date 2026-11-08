-- =====================================================================
-- 0059: トリガ専用の2つの関数を、外から直接呼べない・名前の乗っ取りを受けない形にする（データベースの点検の指摘・2026-11-08）
--
-- 0001〜0058 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- 表・列・データ・トリガには触れない。関数の本文も変えない（権限と search_path だけ）。
--
-- なぜ:
--   ・record_history_capture（0010・0021）は security definer なのに、anon・authenticated が EXECUTE を持っていた。
--     トリガ関数は直接呼んでも動かない（トリガの中でしか呼べない）が、点検は「外から呼べる definer 関数」として指摘する。
--     トリガが動く時は EXECUTE の権限を確かめないので、外しても変更の記録はこれまでどおり残る。
--   ・set_updated_at_rev（0001）は search_path を決めていなかった。本文は now() と new/old だけなので '' にしても同じに動く。
--
-- 旧クライアント×新サーバー: 端末からは何も変わらない。データは消えない。
-- ★ do $$ … $$ のブロックは使わない。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない。
-- =====================================================================

revoke execute on function public.record_history_capture() from public, anon, authenticated;
alter function public.set_updated_at_rev() set search_path = '';

select 'トリガ専用の2つの関数の権限と search_path' as what,
       case when not pg_catalog.has_function_privilege('anon', 'public.record_history_capture()', 'execute')
             and not pg_catalog.has_function_privilege('authenticated', 'public.record_history_capture()', 'execute')
             and (select proconfig from pg_catalog.pg_proc where oid = 'public.set_updated_at_rev()'::regprocedure) = array['search_path=""']
            then 'ok' else 'NG' end as result;
