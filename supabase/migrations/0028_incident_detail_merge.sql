-- =====================================================================
-- 0028: 事故・ヒヤリハットの detail（様式の残りの欄）を、サーバーで「前の値に送られた欄だけを重ねる」形にする
--       （監査 F29・2026-10-10 本人回答「事故の detail はサーバーで変えた欄だけ重ねる（SQL 移行）」）
--
-- 0001〜0027 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- テーブル・列・データには触れない（BEFORE UPDATE のトリガ関数1つとトリガ1つ、端末が有無を確かめる関数1つの追加だけ）。
--
-- なぜ:
--   端末は読んだ detail を正規化する（知らないキーは捨て、知らない選択肢は配列から外す・incident.ts）。これまで端末は
--   detail を丸ごと送り、0014 のトリガは氏名の写し（subject_name）しか前の値から引き継がなかった。そのため、様式の
--   改訂で detail にキー（例: 再発防止の評価日）を足した版を公開した後、古い版のまま開いた端末が「対応」だけを追記すると、
--   新しい版で入れた欄がサーバーから黙って消え、行政に出す報告書の記載が欠ける（旧値は record_history に残る）。
--
-- 形:
--   ・更新の時、new.detail := old.detail || new.detail（送られたキーだけを前の値に重ねる。送られなかったキーは前の値のまま）。
--     欄を空にする時は、端末はそのキーに null を明示して送る（|| は null をそのまま入れる。端末の正規化も null を空として読む）。
--   ・対象者を変えた更新（resident_id が変わった）では、前の氏名の写し（subject_name）を引き継がない
--     （引き継ぐと、後段の氏名の写しのトリガ（0014）が前の対象者の氏名を残してしまう）。
--   ・「名簿の氏名に合わせる」の印（_resync_subject_name）は重ねた後も残り、後段（0014）が取り除いて写し直す。
--   ・トリガの名前は trg_incidents_detail_merge。PostgreSQL は同じ時（before update）のトリガを名前の順に動かすので、
--     0014 の trg_incidents_subject_snapshot より先に動く（d < s）。updated_at・rev の trg_updated_incidents より前でも後でも
--     結果は同じ。
--   ・detail が無い・オブジェクトでない時は触らない（not null と incidents_detail_check がそのまま弾く）。
--   ・security invoker・search_path は空（全部の名前を修飾する。0014 と同じ）。
--
-- 限界（この移行だけでは守れないもの）:
--   ・配列の中の選択肢（visit_methods など）は、古い版が絞った配列を送ると配列ごと置き換わる（|| はキー単位）。
--     選択肢を足す改修では「新しい選択肢は既存の配列に混ぜず別のキーにする」か、古い版の端末を min_client_build（0023）で
--     止めてから配る。端末側の「変えたキーだけを送る」直し（db.ts の updateIncident）と組み合わせて使う。
--   ・追加（insert）は対象外（前の値が無い）。
--
-- 旧クライアント×新サーバー: 旧版は detail を丸ごと送る。知っているキーは送った値で上書きされ（今までどおり）、
--   旧版の知らないキー（新しい版が足した欄）は前の値のまま残る＝データは消えない。
-- 新クライアント×旧サーバー（0014 のまま）: 新しい版は変えたキーだけを送るので、旧サーバーでは detail が送ったキーだけに
--   置き換わって他の欄が消える。**必ずこの移行を先に流し、その後に端末を配る**（DB 先・アプリ後）。
--   端末は、この移行が当たっていない DB には detail を丸ごと送る（変えたキーだけを送るのは、この移行が当たったことを
--   incidents_detail_merge_ready() で確かめられた時だけ。確かめられない・関数が無い時は丸ごと送る）。
--
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

create or replace function public.incidents_detail_merge() returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  base jsonb;
begin
  if new.detail is null or pg_catalog.jsonb_typeof(new.detail) <> 'object'
     or old.detail is null or pg_catalog.jsonb_typeof(old.detail) <> 'object' then
    return new;
  end if;
  base := old.detail;
  -- 対象者を変えた更新では、前の対象者の氏名の写しを引き継がない（0014 のトリガが新しい対象者の氏名を写す）
  if old.resident_id is distinct from new.resident_id then
    base := base - 'subject_name';
  end if;
  new.detail := base || new.detail;
  return new;
end;
$fn$;

revoke all on function public.incidents_detail_merge() from public, anon;

create or replace trigger trg_incidents_detail_merge
  before update on public.incidents
  for each row execute function public.incidents_detail_merge();

-- 端末がこの移行の有無を確かめるための関数（呼ぶと true。無い DB では PGRST202 / 42883 になる）。
-- 新しい版は、これを確かめられた時だけ detail の「変えたキーだけ」を送る（無い・確かめられない時は丸ごと送る＝消さない側）
create or replace function public.incidents_detail_merge_ready() returns boolean
language sql
stable
security invoker
set search_path = ''
as $fn$ select true $fn$;

revoke all     on function public.incidents_detail_merge_ready() from public;
revoke execute on function public.incidents_detail_merge_ready() from anon;
grant  execute on function public.incidents_detail_merge_ready() to   authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) トリガが付いたか・動く順（名前の順）
--    select tgname from pg_trigger where tgrelid = 'public.incidents'::regclass and not tgisinternal order by tgname;
--    → trg_history_incidents ／ trg_incidents_detail_merge ／ trg_incidents_subject_snapshot ／ trg_updated_incidents
--      （before update の3本は detail_merge → subject_snapshot → updated の順に動く）
--
-- 2) 端末の確かめ: select public.incidents_detail_merge_ready();  → t
--
-- 戻す時（必要な時だけ。業務データには影響しない）: **先に確かめの関数を落とす**（新しい版の端末が丸ごと送る形へ戻る。
--   その起動中に確かめ済みの端末は次の確かめ（10分）まで変えたキーだけを送るので、端末を再読み込みしてからトリガを落とす）:
--    drop function if exists public.incidents_detail_merge_ready();
--    drop trigger if exists trg_incidents_detail_merge on public.incidents;
--    drop function if exists public.incidents_detail_merge();
-- ---------------------------------------------------------------------
