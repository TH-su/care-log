-- =====================================================================
-- 0060: 残りのトリガ専用の関数も、ログインした人・ログインしていない人の役割から実行の権限を外す（データベースの点検の指摘・2026-11-08）
--
-- 0001〜0059 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- 表・列・データ・トリガ・関数の本文には触れない（権限だけ）。
--
-- なぜ:
--   0059 で record_history_capture の権限を外した。同じく所有者の権限で動く attendance_history_capture（0024）・
--   note_alias_history_capture（0025）も、authenticated が EXECUTE を持っていて点検に指摘されていた。
--   所有者の権限で動かない4つ（set_updated_at_rev・daycare_home_visit_guard・incidents_detail_merge・incidents_subject_snapshot）も
--   同じ扱いにそろえ、「トリガ専用の関数は誰も実行の権限を持たない」を1つの決まりにする。
--   トリガが動く時は実行の権限を確かめないので、記録・守り・時刻の書き込みはこれまでどおり動く。
--
-- 旧クライアント×新サーバー: 端末からは何も変わらない。データは消えない。
-- ★ do $$ … $$ のブロックは使わない。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない。
-- =====================================================================

revoke execute on function public.attendance_history_capture() from public, anon, authenticated;
revoke execute on function public.note_alias_history_capture() from public, anon, authenticated;
revoke execute on function public.set_updated_at_rev() from public, anon, authenticated;
revoke execute on function public.daycare_home_visit_guard() from public, anon, authenticated;
revoke execute on function public.incidents_detail_merge() from public, anon, authenticated;
revoke execute on function public.incidents_subject_snapshot() from public, anon, authenticated;

select 'トリガ専用の関数を anon・authenticated が実行できない' as what,
       case when not exists (
         select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
            and (pg_catalog.has_function_privilege('anon', p.oid, 'execute')
              or pg_catalog.has_function_privilege('authenticated', p.oid, 'execute'))
            and not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.objid = p.oid and d.deptype = 'e'))
            then 'ok' else 'NG' end as result;
