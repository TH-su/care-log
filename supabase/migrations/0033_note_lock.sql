-- =====================================================================
-- 0033: 申し送りの時間によるロック（現場のログインは、時刻を過ぎた欄へ追加・変更・取り消しができない）
--       （2026-10-15 本人回答。仕様の正本は daily-sheet-features の仕様 §2）
--
-- 0001〜0032 を当てたあとに実行する。冪等（何度実行しても同じ結果）。テーブル・列・データには触れない
-- （関数3つとトリガ1つを create or replace するだけ）。
--
-- ロックの時刻（日本時間・行の note_on＝記録日 X に対して）:
--   日勤（shift='day' かつ after16=false）・デイ（shift='daycare'）… X の 17:00
--   16時以降（shift='day' かつ after16=true）                         … X+1 の 0:00（X の 24:00）
--   夜勤（shift='night'）                                              … X+1 の 8:00
--   ちょうどその時刻からロック（17:00:00 は書けない）。未来の日はまだ時刻が来ていないのでロックしない。
--   サーバーの判定だけ **30分の猶予** を足す（圏外で書いて後から届く分のため。画面の判定 src/lib/noteLock.ts は猶予なし）。
--
-- 止める相手: private.my_role() が 'field'（現場）の時だけ。null（取込 tools/import.mjs の所有者の接続・cron・
--   service_role・許可リスト外）と office／admin は止めない。private.my_role() が無い DB（care-backend の土台を当てて
--   いない環境）では役割が分からない＝null として止めない（旧来どおり書ける）。
--
-- 止める操作: notes の BEFORE INSERT（新しい行の位置）と BEFORE UPDATE（OLD と NEW の両方の位置。開いている欄から
--   ロック中の欄への付け替えも、ロック中の欄から外へ出すのも止める）。取り消し（deleted_at）も更新なので止まる。
--   例外: 継続の終了（ended_at・ended_by だけが変わる更新）は止めない（継続の申し送りは日をまたいで後から終了する）。
--   比べる時に外す列: ended_at・ended_by（例外の対象）と、updated_at・rev（トリガ set_updated_at_rev が付ける）・
--   edited_by（apply_note_edits が書くたびに操作した職員を入れる。外さないと RPC 経由の終了が全部止まる）。
--
-- 止めた時: SQLSTATE P0001・message は 'note_locked: …' で始まる（端末 db.ts はこの2つで見分け、
--   「ロック中のため保存できませんでした（事務所で解除できます）」と出し、送信待ちは止まった記録として残す）。
--
-- 関数:
--   private.note_lock_at(日, 区分, 16時以降)            … ロックの時刻（timestamptz）。時刻帯は Asia/Tokyo を明示
--                                                       （セッションの timezone に左右されない）
--   private.note_lock_blocked(日, 区分, 16時以降, いま, 猶予) … いまがロックの時刻＋猶予以降か（試験は時刻を引数で渡す）
--   private.note_lock_now()                              … いまの時刻（now()）。試験は使い捨ての DB の中でだけこの関数を
--                                                       差し替えて時刻を動かす（本番のトリガに試験用の設定値を読ませない）
--   public.notes_lock_guard()                            … トリガの本体
-- security definer にする理由（notes_lock_guard だけ）: 役割の判定 private.my_role() は care-backend が authenticated に
--   だけ実行権限を配っている。トリガは書いた人の権限で動くので、invoker のままだと service_role など実行権限の無い
--   接続の書き込みが 42501 で失敗する。definer（所有者）で呼べば、どの接続でも JWT の中身だけで役割が決まる
--   （JWT の role が authenticated でない接続は my_role() が null＝止めない）。本体は読み取りと判定だけで、表には書かない。
--   search_path は public, pg_temp に固定する（0021 と同じ）。private の3つは表に触れない計算だけ。
--
-- 旧クライアント×新サーバー: ロック外の記録は今までどおり書ける。ロック中の欄への書き込み（現場のログイン）は
--   P0001 で拒否される（旧版は「サーバーエラー（コード: P0001）」と出し、送信待ちは止まった記録として残る＝消えない）。
-- 戻す時（必要な時だけ）: drop trigger if exists trg_notes_lock on notes;（関数は残っても害は無い）
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

create or replace function private.note_lock_at(p_day date, p_shift text, p_after16 boolean)
returns timestamptz
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select case
    when p_day is null or p_shift is null then null
    -- 夜勤: 翌朝 8:00
    when p_shift = 'night' then ((p_day + 1) + time '08:00') at time zone 'Asia/Tokyo'
    -- 16時以降: 日付が変わった時（翌 0:00）
    when p_shift = 'day' and coalesce(p_after16, false) then ((p_day + 1) + time '00:00') at time zone 'Asia/Tokyo'
    -- 日勤（16時前）・デイ: 当日 17:00
    else (p_day + time '17:00') at time zone 'Asia/Tokyo'
  end
$fn$;

create or replace function private.note_lock_blocked(
  p_day     date,
  p_shift   text,
  p_after16 boolean,
  p_now     timestamptz,
  p_grace   interval default interval '0'
)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select coalesce(p_now >= private.note_lock_at(p_day, p_shift, p_after16) + coalesce(p_grace, interval '0'), false)
$fn$;

create or replace function private.note_lock_now()
returns timestamptz
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select now()
$fn$;

create or replace function public.notes_lock_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  c_grace constant interval := interval '30 minutes';  -- サーバーだけの猶予（圏外で書いて後から届く分）
  -- 継続の終了だけの更新かを比べる時に外す列（上の注記）
  c_skip  constant text[] := array['ended_at', 'ended_by', 'edited_by', 'updated_at', 'rev'];
  v_role  text;
  v_now   timestamptz;
  v_day   date;
  v_shift text;
  v_late  boolean;
begin
  -- 役割（care-backend の private.my_role()。無い DB では分からない＝止めない）
  if to_regprocedure('private.my_role()') is null then
    return new;
  end if;
  execute 'select private.my_role()' into v_role;
  if v_role is distinct from 'field' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- 継続の終了（ended_at・ended_by）だけが変わる更新は止めない
    if (to_jsonb(new) - c_skip) = (to_jsonb(old) - c_skip) then
      return new;
    end if;
  end if;

  v_now := private.note_lock_now();
  if tg_op = 'UPDATE' and private.note_lock_blocked(old.note_on, old.shift, old.after16, v_now, c_grace) then
    v_day := old.note_on; v_shift := old.shift; v_late := old.after16;
  elsif private.note_lock_blocked(new.note_on, new.shift, new.after16, v_now, c_grace) then
    v_day := new.note_on; v_shift := new.shift; v_late := new.after16;
  else
    return new;
  end if;

  raise exception 'note_locked: % の%の欄はロック中のため書き込めません（事務所で解除できます）',
      to_char(v_day, 'YYYY-MM-DD'),
      case when v_shift = 'night' then '夜勤'
           when v_shift = 'daycare' then 'デイ'
           when coalesce(v_late, false) then '16時以降'
           else '日勤' end
    using errcode = 'P0001',
          hint = '事務所（office・admin）のログインで解除してから保存してください';
end;
$fn$;

comment on function public.notes_lock_guard() is
  '申し送りの時間によるロック（現場のログインだけ。日勤・デイ 17:00／16時以降 24:00／夜勤 翌8:00＋猶予30分・日本時間。継続の終了だけの更新は止めない）。止めた時は P0001・note_locked: …。0033。';

-- 計算だけの関数は API から呼ばせない（トリガは所有者の権限で呼ぶ）
revoke all on function private.note_lock_at(date, text, boolean) from public, anon, authenticated;
revoke all on function private.note_lock_blocked(date, text, boolean, timestamptz, interval) from public, anon, authenticated;
revoke all on function private.note_lock_now() from public, anon, authenticated;
revoke all on function public.notes_lock_guard() from public, anon, authenticated;

create or replace trigger trg_notes_lock
  before insert or update on notes
  for each row execute function public.notes_lock_guard();

notify pgrst, 'reload schema';
