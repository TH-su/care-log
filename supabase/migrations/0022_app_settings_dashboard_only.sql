-- =====================================================================
-- 0022: 設定表（app_settings）を現場のログインからは書けなくする（ダッシュボード＝SQL エディタだけで変える）
--       （監査 F40①・2026-10-10 本人回答「app_settings は authenticated から書けなくする」）
--
-- 0001〜0021 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- テーブル・列・データには触れない（書き込みの許可を外すだけ。読む許可 read_auth と member_only は残す）。
--
-- なぜ:
--   0001 は app_settings に insert_auth・update_auth（authenticated なら誰でも）を作っていた。アプリは読むだけ
--   （db.ts の getAppSetting と事業所情報の読み取りは select）なのに、許可リストの職員なら自分のログインと公開の
--   anon キーで input_enabled_med・daycare_closed_dates などを書き換えられ、0015・0016 の自動チェック（与薬・入浴の
--   自動の記録・休業日の訪問扱い）の作られ方が変わる。変更の記録も残らない。
--   値を変える手順書（0009・0012・0014・0015・0016・0023 の注記）はどれも SQL エディタ（postgres の権限）で流す形なので、
--   書き込みの許可を外しても運用は変わらない。tools/import.mjs・tools/seed-synthetic.mjs は Postgres へ直接つなぐ
--   （RLS の外）ので影響しない。kitchen-app は別の Supabase プロジェクト。
--
-- 将来、画面から設定を変える必要が出たら: 施設長などの役割で絞った update のポリシー（private.has_role 等）か、
--   security definer の RPC を別に作る（docs/design/ui-design.md の「app_settings を管理する画面の要否」）。
--
-- 旧クライアント×新サーバー: 旧版も app_settings は読むだけなので何も変わらない。データは消えない。
-- 新クライアント×旧サーバー: 端末は読むだけなので、どちらでも同じに動く。
--
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
-- 個人情報: このファイルに実在の氏名・設定の値を書かない（構造だけを定義する）。
-- =====================================================================

-- 書き込みの許可（ポリシー）を外す。read_auth（select）と 0019 の member_only はそのまま
drop policy if exists "insert_auth" on public.app_settings;
drop policy if exists "update_auth" on public.app_settings;

-- 表の権限も外す（ポリシーが無ければ RLS で拒否されるが、truncate は RLS を通らないので必ず外す。record_history と同じ形）
revoke insert, update, delete, truncate on public.app_settings from anon, authenticated;

comment on table public.app_settings is
  'アプリ全体の設定値（key/value）。アプリは読むだけ。値は Supabase の SQL エディタ（ダッシュボード）で変える（0022 で authenticated の書き込みを外した）。';

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) ポリシーが read_auth と member_only だけか
--    select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'app_settings' order by 1;
--    → member_only ALL ／ read_auth SELECT の2行
--
-- 2) 権限（authenticated は SELECT だけ）
--    select has_table_privilege('authenticated', 'public.app_settings', 'select') as sel,
--           has_table_privilege('authenticated', 'public.app_settings', 'update') as upd,
--           has_table_privilege('authenticated', 'public.app_settings', 'insert') as ins;
--    → t / f / f
--
-- 戻す時（必要な時だけ。0001 と同じ許可に戻す）:
--    grant insert, update on public.app_settings to authenticated;
--    create policy "insert_auth" on public.app_settings for insert to authenticated with check (true);
--    create policy "update_auth" on public.app_settings for update to authenticated using (true) with check (true);
-- ---------------------------------------------------------------------
