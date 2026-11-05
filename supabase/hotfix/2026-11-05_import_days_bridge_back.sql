-- 応急処置 2026-11-05（取込の日の一時の一意）を外す。取込を動かしている機械の道具を新しい版にした後、2つ目の施設を入れる前に流す。
-- 古い版の道具のままで流すと、また毎時の取込が取込の日を書く所で止まる（応急処置の頭の説明）。
-- ★ do $$ … $$ のブロックは使わない。何度流しても同じ。

begin;
set local lock_timeout = '5s';

drop index if exists public.import_days_source_day_bridge;

commit;

select '取込の日の一時の一意が無い' as what,
       case when pg_catalog.to_regclass('public.import_days_source_day_bridge') is null then 'ok' else 'NG' end as result;
