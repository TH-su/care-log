-- =====================================================================
-- 応急処置 2026-11-05（移行の番号の外）: 取込の日（import_days）に、古い版の取込の道具のための一時の一意 (source, day) を足す（2026-11-05・本番で取込が止まったための応急処置）
--
-- 0001〜0055 の後の本番にだけ当てる（移行の並び（supabase/migrations）には入れない＝試験は施設ごとの本来の形で確かめる）。冪等（if not exists）。足すだけ（表・列・データ・ほかの一意・守りには触れない）。
-- なぜ: 0053 で取込の日の主キーを (tenant_id, source, day) にした。新しい版の取込の道具は on conflict on constraint import_days_pkey で
--   書くが、取込を動かしている機械の道具が古い版（on conflict (source, day)）のままだったため、0053 の後の毎時の取込が取込の日を書く所で
--   42P10（名指す一意が無い）になり、その窓ごと取り消されて、記録が入らなくなっていた（本番の記録で 17:00〜21:00 の毎時に確認）。
-- 何を: import_days に一意の索引 import_days_source_day_bridge (source, day) を足す（古い版の on conflict (source, day) が当たる先）。
--   新しい版の道具の on conflict on constraint import_days_pkey は今までどおり動く（同じ行が両方の一意に当たる）。
-- ★応急処置: この一意は施設をまたいで (source, day) を1つにするので、2つ目の施設の取込は書けない。取込を動かしている機械の道具を
--   新しい版にした後、2つ目の施設を入れる前に supabase/hotfix/2026-11-05_import_days_bridge_back.sql で外す。
-- 旧クライアント×新サーバー: 画面は取込の日を書かない＝影響なし。
-- 戻す: supabase/hotfix/2026-11-05_import_days_bridge_back.sql（この索引を外すだけ）。
-- ★ do $$ … $$ のブロックは使わない。個人情報を書かない。
-- =====================================================================

begin;
set local lock_timeout = '5s';

create unique index if not exists import_days_source_day_bridge on public.import_days (source, day);
comment on index public.import_days_source_day_bridge is '一時の橋渡し（2026-11-05）: 古い版の取込の道具の on conflict (source, day) のため。取込の道具を新しい版にした後、2つ目の施設を入れる前に外す';

commit;

-- ── 確かめ（読むだけ）──
select '取込の日に一時の一意 (source, day) がある' as what,
       case when (select pg_catalog.pg_get_indexdef(i.oid) from pg_catalog.pg_class i
                   where i.relname = 'import_days_source_day_bridge' and i.relnamespace = 'public'::regnamespace)
                 = 'CREATE UNIQUE INDEX import_days_source_day_bridge ON public.import_days USING btree (source, day)'
            then 'ok' else 'NG' end as result
union all
select '取込の日の主キーは施設ごとのまま',
       case when pg_catalog.pg_get_constraintdef((select oid from pg_catalog.pg_constraint where conname = 'import_days_pkey' and conrelid = 'public.import_days'::regclass))
                 = 'PRIMARY KEY (tenant_id, source, day)'
            then 'ok' else 'NG' end;
