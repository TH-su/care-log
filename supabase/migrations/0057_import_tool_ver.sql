-- =====================================================================
-- 0057: 取込の道具の版を記録する（2026-11-05 本人指示「両方進めて」）
--
-- 0001〜0056 を当てたあとに実行する。冪等（何度流しても同じ）。begin … commit で包む。
-- なぜ: 2026-11-05 に、取込を動かしている機械の取込の道具が古い版のままで、0053 の後の毎時の取込が5時間止まった。
--   道具の版をデータベースに残し、古い版のまま動いていれば毎朝の点検（共通の DB の ops_carelog_health）が知らせるようにする。
-- 何を:
--   1. import_days に列 tool_ver（その日を最後に書いた取込の道具の版・整数）を足す。空でよい（古い版の道具は書かない）
--   2. private.carelog_import_min_ver() … 今のデータベースが求める取込の道具の版（いまは 57）。
--      取込の道具は動き始めにこれと自分の版を比べ、古ければ何も書かずに止まる（「古い版です」と出す）。
--      データベースの形を変えて古い版の道具が動かなくなる移行では、この数を上げる
-- 変えないもの: 表のほかの列・一意・守り・データ。画面は列も関数も使わない。
-- 旧クライアント×新サーバー: 古い版の取込の道具は今までどおり動く（列を書かないだけ・版を比べない）。画面は変わらない。
-- 新クライアント×旧サーバー: 新しい版の取込の道具は、列・関数が無い DB では版を書かず・比べずに取り込む。
-- 戻す: supabase/rollback/0057_back.sql（列と関数を外す）。
-- ★ do $$ … $$ のブロックは使わない（関数の本文 as $fn$ … $fn$ は使ってよい）。個人情報を書かない。
-- =====================================================================

begin;
set local lock_timeout = '5s';

alter table public.import_days add column if not exists tool_ver integer;

create or replace function private.carelog_import_min_ver()
returns integer
language sql
immutable
set search_path = ''
as $fn$ select 57 $fn$;

revoke all on function private.carelog_import_min_ver() from public, anon, authenticated;

commit;

select '取込の日に道具の版の列がある・求める版の関数がある' as what,
       case when exists (select 1 from pg_catalog.pg_attribute
                          where attrelid = 'public.import_days'::regclass and attname = 'tool_ver' and not attisdropped and not attnotnull)
             and private.carelog_import_min_ver() = 57
            then 'ok' else 'NG' end as result;
