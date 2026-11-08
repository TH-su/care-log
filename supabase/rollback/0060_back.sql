-- 0060（残りのトリガ専用の関数の実行の権限）を戻す。表・列・記録・トリガには触れない。
-- ★ do $$ … $$ のブロックは使わない。何度流しても同じ。

grant execute on function public.attendance_history_capture() to public, anon, authenticated;
grant execute on function public.note_alias_history_capture() to public, anon, authenticated;
grant execute on function public.set_updated_at_rev() to public, anon, authenticated;
grant execute on function public.daycare_home_visit_guard() to public, anon, authenticated;
grant execute on function public.incidents_detail_merge() to public, anon, authenticated;
grant execute on function public.incidents_subject_snapshot() to public, anon, authenticated;

select '0060 の前の形（authenticated が6つを実行できる）' as what,
       case when pg_catalog.has_function_privilege('authenticated', 'public.attendance_history_capture()', 'execute')
             and pg_catalog.has_function_privilege('authenticated', 'public.note_alias_history_capture()', 'execute')
            then 'ok' else 'NG' end as result;
