-- =====================================================================
-- 0040: 入居者・職員の写しと、取込・同期の台帳の書き込みを事務所・管理者だけにする（代表者の決定 2026-10-22）
--
-- 0001〜0039 を当てたあとに実行する。冪等（何度実行しても同じ結果）。テーブル・列・データには触れない
-- （関数2つ・トリガ1つを create or replace し、4表の insert／update のポリシーを差し替えるだけ）。
--
-- なぜ: 0001 から residents・staff・import_days・master_sync_log は「許可リストの人なら誰でも書ける」定義だった。
--   現場の端末でも名簿の同期が走り、写しを書き換えられた。書き込みの役割を DB で守る（方針 v1・決定 2・3）。
--   服薬の時間帯（med_slots）と申し送りでの表示名（residents.note_alias）は、現場も書けるままにする
--   （代表者の決定 2026-10-22。今は事務所PCで設定しているが、現場から書けないようにはしない）。
--
-- 1. staff・import_days・master_sync_log … 書く（insert・update）＝役割が office か admin のログインだけ（0034 と同じ作り）
--    private.office_writable()（security invoker・has_role が無い DB では false＝誰も書けない側に倒す）を
--    「with check」に置く。update の using は true（行は見える）＝現場の更新は「0行」で黙って終わらず 42501 で止まる。
--    読む（read_auth）はそのまま全員（許可リストの人）。restrictive の member_only（0019）はそのまま残る。
-- 2. residents … insert＝office・admin だけ（上と同じポリシー）。update のポリシーは今のまま（誰でも）にして、
--    BEFORE UPDATE のトリガ residents_master_guard で中身を見る: 現場（private.my_role() が 'field'）の更新は、
--    note_alias（と、あれば自動で変わる updated_at・rev）だけが変わる時だけ通し、ほかの列が変わる時は 42501 で止める。
--    作法は 0033 の notes_lock_guard と同じ: security definer（my_role() の実行権限を持たない接続でも JWT だけで役割が決まる）・
--    search_path 固定・my_role() が無い DB では止めない・役割が null（取込 tools/import.mjs の所有者の接続・cron・
--    service_role）と office／admin は止めない。表には書かない（読み取りと判定だけ）。
--    止めた時: SQLSTATE 42501・message は 'resident_master_office_only: …' で始まる。
-- 3. med_slots と記録の表（vitals・meals・fluid_intake・notes・note_reads・outings・attendance・bath_records・
--    med_admin・incidents）は触らない。
--
-- DB の定時の処理（0015・0016 の自動の記録）と変更の記録（0010・0025）は security definer で、この4表を書かない
--   （書くのは med_admin・bath_records・record_history）＝影響なし。取込の台本は表の所有者の接続＝RLS を通らず、
--   トリガは役割が null なので通る。
--
-- 旧クライアント×新サーバー: 事務所・管理者のログインは今までどおり。現場のログインの端末で名簿の同期が走ると、
--   書く所で 42501 になり、同期の失敗の帯が出る（書けなかった分は今の値のまま・データは消えない）。
--   ＝**画面（現場では同期しない版）を先に公開してから、この移行を当てる**。表示名と服薬の時間帯は今までどおり書ける。
-- 新クライアント×旧サーバー: 画面が現場で同期を呼ばなくなるだけ（事務所PCは今までどおり同期する）。
-- 戻す時（必要な時だけ）: 下の「戻す」を流す（表の中身には触れない）。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 書いてよい役割か（office・admin） ----------
-- 0034 の private.resident_targets_writable と同じ本文（そちらは触らない）。has_role が無い DB では false。
-- language plpgsql＋動的 execute: has_role を直接書くと、関数の無い DB では create の時点で 42883 になりファイルが巻き戻るため。
create or replace function private.office_writable()
returns boolean
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v boolean;
begin
  if to_regprocedure('private.has_role(text[])') is null then
    return false;
  end if;
  execute 'select private.has_role(variadic array[''office'', ''admin''])' into v;
  return coalesce(v, false);
end;
$fn$;

comment on function private.office_writable() is
  '入居者・職員の写しと取込・同期の台帳を書いてよい役割か（office・admin）。has_role が無い DB では false。0040。';

revoke all on function private.office_writable() from public, anon;
grant execute on function private.office_writable() to authenticated;

-- ---------- 1. staff・import_days・master_sync_log: 書くのは事務所・管理者だけ ----------
drop policy if exists "insert_auth"   on public.staff;
drop policy if exists "update_auth"   on public.staff;
drop policy if exists "insert_office" on public.staff;
drop policy if exists "update_office" on public.staff;
create policy "insert_office" on public.staff for insert to authenticated
  with check (private.office_writable());
create policy "update_office" on public.staff for update to authenticated
  using (true) with check (private.office_writable());

drop policy if exists "insert_auth"   on public.import_days;
drop policy if exists "update_auth"   on public.import_days;
drop policy if exists "insert_office" on public.import_days;
drop policy if exists "update_office" on public.import_days;
create policy "insert_office" on public.import_days for insert to authenticated
  with check (private.office_writable());
create policy "update_office" on public.import_days for update to authenticated
  using (true) with check (private.office_writable());

drop policy if exists "insert_auth"   on public.master_sync_log;
drop policy if exists "update_auth"   on public.master_sync_log;
drop policy if exists "insert_office" on public.master_sync_log;
drop policy if exists "update_office" on public.master_sync_log;
create policy "insert_office" on public.master_sync_log for insert to authenticated
  with check (private.office_writable());
create policy "update_office" on public.master_sync_log for update to authenticated
  using (true) with check (private.office_writable());

-- ---------- 2. residents: 足すのは事務所・管理者だけ。更新はトリガで列を見る ----------
drop policy if exists "insert_auth"   on public.residents;
drop policy if exists "insert_office" on public.residents;
create policy "insert_office" on public.residents for insert to authenticated
  with check (private.office_writable());
-- update_auth（using true・with check true）は 0001 のまま残す（表示名は現場も書ける）

create or replace function public.residents_master_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  -- 現場も変えてよい列（表示名）と、自動で変わる列（今の residents には無いが、足された時に止めないため）
  c_skip constant text[] := array['note_alias', 'updated_at', 'rev'];
  v_role text;
begin
  -- 役割（care-backend の private.my_role()。無い DB では分からない＝止めない・0033 と同じ）
  if to_regprocedure('private.my_role()') is null then
    return new;
  end if;
  execute 'select private.my_role()' into v_role;
  if v_role is distinct from 'field' then
    return new;
  end if;
  -- 表示名だけが変わる更新は通す
  if (to_jsonb(new) - c_skip) = (to_jsonb(old) - c_skip) then
    return new;
  end if;
  raise exception 'resident_master_office_only: 入居者の名簿の内容（氏名・部屋・在籍など）は事務・管理者のログインでだけ変えられます（現場のログインで変えられるのは申し送りでの表示名だけです）'
    using errcode = '42501',
          hint = '事務所（office・admin）のログインで名簿の同期を行ってください';
end;
$fn$;

comment on function public.residents_master_guard() is
  '現場（field）のログインの residents の更新は、申し送りでの表示名（note_alias）だけが変わる時だけ通す。ほかは 42501・resident_master_office_only: …。役割 null・office・admin は止めない。0040。';

revoke all on function public.residents_master_guard() from public, anon, authenticated;

create or replace trigger trg_residents_master_guard
  before update on public.residents
  for each row execute function public.residents_master_guard();

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) ポリシー: residents は insert_office・member_only・read_auth・update_auth の4行。
--    staff・import_days・master_sync_log は insert_office・member_only・read_auth・update_office の4行ずつ。
--    （insert_auth が残っていない・DELETE は無い）
--    select tablename, policyname, cmd from pg_policies
--     where schemaname = 'public' and tablename in ('residents', 'staff', 'import_days', 'master_sync_log')
--     order by 1, 2;
-- 2) トリガ: 1行（trg_residents_master_guard・BEFORE・UPDATE）
--    select trigger_name, action_timing, event_manipulation from information_schema.triggers
--     where event_object_table = 'residents' and trigger_name = 'trg_residents_master_guard';
-- 3) 事務所PCで設定の画面の「マスタを同期する」を押し、「マスタを同期しました」と出ること
--
-- 戻す（必要な時だけ。先頭の -- を外して流す）:
--   drop trigger if exists trg_residents_master_guard on public.residents;
--   drop policy if exists "insert_office" on public.residents;
--   create policy "insert_auth" on public.residents for insert to authenticated with check (true);
--   （staff・import_days・master_sync_log は、それぞれ次の4文）
--   drop policy if exists "insert_office" on public.staff;
--   drop policy if exists "update_office" on public.staff;
--   create policy "insert_auth" on public.staff for insert to authenticated with check (true);
--   create policy "update_auth" on public.staff for update to authenticated using (true) with check (true);
-- ---------------------------------------------------------------------
