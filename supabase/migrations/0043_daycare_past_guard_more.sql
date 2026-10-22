-- =====================================================================
-- 0043: 0042 の過去の日の時刻の守りに、2つの書き込みを足す（反証レビュー4巡目 F6・2026-10-22）
--
-- 0001〜0042 を当てたあとに実行する。冪等（関数を create or replace するだけ。表・列・ポリシー・トリガ・データには触れない）。
-- 0042 は main に入ったため書き換えない（取り込み済みの移行は書き換えない約束）。0042 と続けて当てる。
--
-- 足す2つ（どちらも現場（field）のログイン・業務日が JST の今日より前の行だけ）:
--   ・時刻の入った行を別の方へ付け替える（resident_id が変わる）→ 時刻が別の方へ移るため 42501
--   ・取り消した時刻の入った行を戻す（deleted_at を空にする）→ 時刻が戻るため 42501
--   時刻の無い行の付け替え・取り消しの戻しは今までどおり通す。事務所・管理者・役割なしは止めない（0042 と同じ）。
--   画面からは届かない書き込み（PostgREST を直接使った時だけ）だが、DB の規則として 0042 の決定と合わせる。
--
-- 旧クライアント×新サーバー: 画面はこの2つの書き込みを出さない（付け替え・取り消しの戻しの操作が無い）＝影響なし。
-- 新クライアント×旧サーバー（0043 未適用）: 0042 の守りのまま（この2つだけ DB で止まらない）。
-- 0042 の説明への補足: 圏外で当日に押した到着が日付をまたいで届くと、現場のログインでは止まる（消えない）。送信待ちの再送の
--   間隔（30秒から倍々・上限30分・10回）を使い切るまで約2時間はその方の行が「未送信の記録があります」で押せず、その後に
--   止まった送信の一覧に出る。デイの時間帯（日中）では起きない想定。
-- 戻す時（必要な時だけ）: 0042 の関数の本文をもう一度流す（0042 を流し直す＝冪等）。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名を書かない（構造だけを定義する）。
-- =====================================================================

create or replace function public.daycare_attendance_past_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_role text;
begin
  -- 過去の日の行でなければ止めない（今日・未来の日の検証は 0041 の制約と画面の役目）
  if tg_op = 'INSERT' then
    if new.day >= v_today then
      return new;
    end if;
    if new.arrived_at is null and new.left_at is null then
      return new;
    end if;
  else
    if new.day >= v_today and old.day >= v_today then
      return new;
    end if;
    if new.arrived_at is not distinct from old.arrived_at
       and new.left_at is not distinct from old.left_at
       and new.day = old.day
       and (new.resident_id = old.resident_id or (old.arrived_at is null and old.left_at is null))
       and not (new.deleted_at is not null and old.deleted_at is null
                and (old.arrived_at is not null or old.left_at is not null))
       and not (new.deleted_at is null and old.deleted_at is not null
                and (new.arrived_at is not null or new.left_at is not null)) then
      return new;
    end if;
  end if;
  -- 役割（care-backend の private.my_role()。無い DB では分からない＝止めない・0033／0040 と同じ）
  if to_regprocedure('private.my_role()') is null then
    return new;
  end if;
  execute 'select private.my_role()' into v_role;
  if v_role is distinct from 'field' then
    return new;
  end if;
  raise exception 'daycare_past_times_office_only: 過去の日の到着・帰宅の時刻は、事務所のログインでだけ入力・修正できます（現場の端末は当日だけ）'
    using errcode = '42501',
          hint = '事務所（office・admin）のログインで入力してください。過去の日の欠席・入浴は現場でも記録できます（時刻が入っている方の欠席・到着の取り消しは事務所）';
end;
$fn$;

comment on function public.daycare_attendance_past_guard() is
  '現場（field）のログインの、過去の日（JST）の daycare_attendance の到着・帰宅の時刻を変える書き込みを 42501・daycare_past_times_office_only: … で止める（時刻の入った行の付け替え・取り消した時刻の入った行の戻しも）。役割 null・office・admin は止めない。0042・0043。';

revoke all on function public.daycare_attendance_past_guard() from public, anon, authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）: 関数の本文に resident_id の比べが入っている（1行・t）
--   select position('new.resident_id = old.resident_id' in prosrc) > 0 from pg_proc where proname = 'daycare_attendance_past_guard';
-- ---------------------------------------------------------------------
