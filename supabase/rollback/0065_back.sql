-- 0065 を戻す（日報の確認欄の表を外す）。★付けた ✔ も消える。流す前に表の中身を書き出しておく。
-- 順番: (1) 画面を 0065 より前の版に戻す（main を戻して公開）→ (2) 全端末のケアログを読み込み直す → (3) この SQL を流す。
--   (2) を飛ばしても、新しい版の画面は表が無い時に「確認欄はまだ使えません」を出して ✔ を押せなくするだけ（日報のほかの部分は動く）。
-- 冪等。ほかの表・関数には触れない。
begin;
set local lock_timeout = '5s';
drop table if exists public.daily_read_checks;
drop function if exists public.daily_read_check_guard();
commit;
notify pgrst, 'reload schema';

select '0065 を戻した（確認欄の表と守りの関数が無い）' as what,
       case when pg_catalog.to_regclass('public.daily_read_checks') is null
             and pg_catalog.to_regprocedure('public.daily_read_check_guard()') is null
            then 'ok' else 'NG' end as result;
