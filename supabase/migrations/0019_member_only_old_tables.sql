-- 0019: 古い表（0001〜0011 で作った表）にも、許可リストの有効な人だけに絞る member_only を足す（監査10月版 #11・2026-10-09 代表決定 4a）
--
-- なぜ: 0012 以降の表（入浴・与薬・事故報告）には member_only があるが、0001〜0011 の表には無く、
--       ログインした人（authenticated）なら誰でも全部の行を読み書きできる定義だった。
--       許可リストに無いアカウントは登録の段階で断っている（care-backend 0002 の hook）ので今は実害が無いが、
--       守りを1か所（登録の入口）だけに頼らず、表ごとにも同じ条件を掛ける。
-- 形: care-backend 0001_foundation.sql と、この care-log の 0012〜0014 と同じ
--     （as restrictive for all to authenticated using (private.is_member()) with check (private.is_member())）。
--     既存の read_auth・insert_auth・update_auth はそのまま残す（restrictive は「かつ」で掛かるので、許可の範囲を狭めるだけ）。
-- 影響: 許可リストの有効な人（今の記録アプリの職員）は今までどおり。入浴・与薬・事故報告の表を使えている人は、同じ条件なのでこの表も使える。
--       service_role（GAS の取り込み・管理用）は RLS を通らないので影響なし。
--       security definer の関数（timeline_chunk・apply_cell_edits など）は関数の持ち主の権限で読むので影響なし。
-- 実行: Supabase のダッシュボード → SQL Editor にこのファイルの中身を貼って Run（ターミナルではない）。
--       実行の前に、記録アプリをどれか1台で開き、入浴チェックの画面が開けること（＝その人が member であること）を確かめる。
-- 戻す時: 下の「戻す」の drop policy を流す（表の中身には触れない）。

do $$
declare t text;
begin
  foreach t in array array['residents','staff','vitals','meals','fluid_intake','notes','note_reads','outings',
                           'app_settings','import_days','master_sync_log','attendance','record_history'] loop
    execute format('drop policy if exists member_only on public.%I', t);
    execute format('create policy member_only on public.%I as restrictive for all to authenticated '
                   'using (private.is_member()) with check (private.is_member())', t);
  end loop;
end $$;

-- 確認（13 行・どれも permissive = RESTRICTIVE・roles = {authenticated}・cmd = ALL なら成功）
select tablename, policyname, permissive, roles, cmd
  from pg_policies
 where schemaname = 'public' and policyname = 'member_only'
   and tablename in ('residents','staff','vitals','meals','fluid_intake','notes','note_reads','outings',
                     'app_settings','import_days','master_sync_log','attendance','record_history')
 order by tablename;

-- 戻す（必要な時だけ。先頭の -- を外して流す）
-- do $$ declare t text; begin
--   foreach t in array array['residents','staff','vitals','meals','fluid_intake','notes','note_reads','outings',
--                            'app_settings','import_days','master_sync_log','attendance','record_history'] loop
--     execute format('drop policy if exists member_only on public.%I', t);
--   end loop; end $$;
