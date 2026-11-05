-- 0057（取込の道具の版を記録する）を戻す。列 tool_ver と関数 private.carelog_import_min_ver() を外す。
-- 戻しても取込の道具は動く（新しい版の道具は、列・関数が無い時は版を書かず・比べずに取り込む）。
-- ★ do $$ … $$ のブロックは使わない。何度流しても同じ。

begin;
set local lock_timeout = '5s';

drop function if exists private.carelog_import_min_ver();
alter table public.import_days drop column if exists tool_ver;

commit;

select '取込の日に道具の版の列が無い・求める版の関数が無い' as what,
       case when not exists (select 1 from pg_catalog.pg_attribute
                              where attrelid = 'public.import_days'::regclass and attname = 'tool_ver' and not attisdropped)
             and pg_catalog.to_regprocedure('private.carelog_import_min_ver()') is null
            then 'ok' else 'NG' end as result;
