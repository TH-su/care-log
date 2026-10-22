-- =====================================================================
-- 0042: デイの到着・帰宅の時刻は、過去の日は事務所のログインだけが入力・修正できる（代表者の決定 2026-10-22）
--
-- 0001〜0041 を当てたあとに実行する。冪等（何度実行しても同じ結果）。表・列・ポリシー・データには触れない
-- （関数1つを create or replace し、0041 の新しい表 daycare_attendance にトリガ1つを足すだけ）。
--
-- 決定（2026-10-22・代表者が選択）:
--   ・事務所のログイン（office・admin）だけ、過去の日の到着・帰宅の時刻を入力・修正できる。現場の端末は当日だけ
--   ・現場に止めるのは到着・帰宅の時刻だけ。過去の日の欠席・入浴は今どおり現場も記録できる
--   ・ただし、時刻が入っている方を過去の日に欠席へ変える操作と、到着・帰宅の取り消しは、時刻を消すことになるので事務所だけ
--
-- 作り: 0040 の residents_master_guard・0033 の notes_lock_guard と同じ作法。
--   BEFORE INSERT／UPDATE のトリガで中身を見る。security definer（my_role() の実行権限を持たない接続でも JWT だけで役割が決まる）・
--   search_path 固定・my_role() が無い DB では止めない・役割が null（表の所有者の接続・cron・service_role）と office／admin は止めない。
--   止めるのは役割が 'field'（現場）で、業務日（day）が JST の今日より前の行の、到着・帰宅の時刻が変わる書き込みだけ:
--     insert … arrived_at か left_at が入っている
--     update … arrived_at か left_at が変わる・業務日が変わる（どちらかが過去の日）・時刻の入った行を取り消す（deleted_at を入れる）・
--              時刻の入った行を別の方へ付け替える（resident_id が変わる）・取り消した時刻の入った行を戻す（deleted_at を空にする）
--   止めた時: SQLSTATE 42501・message は 'daycare_past_times_office_only: …' で始まる。表には書かない（読み取りと判定だけ）。
--   既存の関数・ポリシー（0041 の read_auth・insert_auth・update_auth・member_only）は変えない。
--
-- 旧クライアント×新サーバー: 段階1の画面は過去の日の到着・帰宅を押せない（止めてある）。帰宅の取り消し・時刻の入った方の欠席を
--   過去の日に現場で押すと 42501 になり、行に理由が出る（データは消えない・今の値のまま）。
-- 新クライアント×旧サーバー: 画面は現場で過去の日の時刻の操作を出さない。事務所の時刻の入力は通る（旧サーバーは止めないだけ）。
-- 圏外で当日に押した到着が日付をまたいで届くと、現場のログインでは過去の日の扱いで止まる（消えない。送信待ちの再送の間隔
--   〔30秒から倍々・上限30分・10回〕を使い切るまで約2時間はその方の行が「未送信の記録があります」で押せず、その後に止まった
--   送信の一覧に出る）。デイの時間帯（日中）では起きない想定。
-- 戻す時（必要な時だけ）: 下の「戻す」を流す（表の中身には触れない）。
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
  '現場（field）のログインの、過去の日（JST）の daycare_attendance の到着・帰宅の時刻を変える書き込みを 42501・daycare_past_times_office_only: … で止める。役割 null・office・admin は止めない。0042。';

revoke all on function public.daycare_attendance_past_guard() from public, anon, authenticated;

create or replace trigger trg_daycare_attendance_past_guard
  before insert or update on public.daycare_attendance
  for each row execute function public.daycare_attendance_past_guard();

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) トリガ: 2行（trg_daycare_attendance_past_guard・BEFORE・INSERT と UPDATE）
--    select trigger_name, action_timing, event_manipulation from information_schema.triggers
--     where event_object_table = 'daycare_attendance' and trigger_name = 'trg_daycare_attendance_past_guard';
-- 2) ポリシーは 0041 のまま（insert_auth・member_only・read_auth・update_auth の4行）
--    select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'daycare_attendance' order by 1;
--
-- 戻す（必要な時だけ。先頭の -- を外して流す）:
--   drop trigger if exists trg_daycare_attendance_past_guard on public.daycare_attendance;
--   drop function if exists public.daycare_attendance_past_guard();
-- ---------------------------------------------------------------------
