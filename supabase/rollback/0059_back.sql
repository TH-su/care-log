-- 0059（トリガ専用の2つの関数の権限と search_path）を戻す。表・列・記録・トリガには触れない。
-- ★ do $$ … $$ のブロックは使わない。何度流しても同じ。

grant execute on function public.record_history_capture() to public, anon, authenticated;
alter function public.set_updated_at_rev() reset search_path;

select '0059 の前の形（anon が EXECUTE を持つ・search_path 未設定）' as what,
       case when pg_catalog.has_function_privilege('anon', 'public.record_history_capture()', 'execute')
             and (select proconfig from pg_catalog.pg_proc where oid = 'public.set_updated_at_rev()'::regprocedure) is null
            then 'ok' else 'NG' end as result;
