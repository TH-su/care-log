-- =====================================================================
-- 0024: 日報の出勤者（attendance）の変更を変更の記録（record_history）に残す（監査 F40②・2026-10-10 本人回答）
--
-- 0001〜0023 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- テーブル・列・データには触れない（トリガ関数1つとトリガ1つの追加だけ）。
--
-- なぜ:
--   出勤者は rev・deleted_at を持たない後勝ちの表で（db-design.md）、外す＝sort を -1 にする更新、戻す＝sort を 0 以上へ
--   戻す更新で表す。例えば 8:30 に端末A が職員03 を外し、8:35 に圏外で積んでいた端末B の送信が職員03 を戻しても、
--   誰がいつ外した・戻したかがどこにも残らず、日報の出勤者欄の正誤を後から確かめられなかった。
--
-- 形:
--   ・0010 の record_history_capture はそのまま使えない（(new ->> 'id')::bigint を row_id（not null）へ入れる作りで、
--     attendance には id 列が無い＝付けると出勤者の保存が毎回失敗する）。出勤者専用の関数を足す。
--   ・row_id ＝ staff_id、record_day ＝ day（同じ日・同じ職員の行が (table_name, row_id, record_day) で引ける）。
--     resident_id は null（カルテの変更の記録は利用者で引くので、ここの行は出ない）。
--   ・op: 表示中（sort >= 0）→ 外した（sort < 0）は 'delete'、それ以外（役割・並び・戻した）は 'update'。
--   ・中身が同じ更新（同じ役割・同じ並びの書き直し）は記録しない（0010 と同じ）。
--   ・追加（insert）は記録しない（行そのものが最初の値・0010 と同じ）。
--   ・changed_by_staff は null（出勤者の書き込みは記入者を送っていない）。誰が変えたかは changed_by_uid
--     （ログインの uid・既定値 auth.uid()）で残る。記入者まで残すなら、出勤者に edited_by 列を足し、端末の
--     書き込み3経路（追加・更新・外す）と送信待ちの再送で送るように直す（別件）。
--   ・security definer（呼んだ職員の権限では record_history に書けない）。search_path は public, pg_temp
--     （0021 と同じく一時表による名前の乗っ取りを防ぐ）。
--
-- 旧クライアント×新サーバー: 出勤者の書き方は何も変わらない（トリガは after update で記録を足すだけ）。
--   データは消えない。記録の表（record_history）は 0010 で作ってあり、端末は今までどおり読むだけ。
-- 新クライアント×旧サーバー: この移行は端末の挙動に関係しない。
--
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
-- 個人情報: このファイルに実在の氏名を書かない（構造だけを定義する）。
-- =====================================================================

create or replace function public.attendance_history_capture() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o jsonb;
  n jsonb;
begin
  o := to_jsonb(old);
  n := to_jsonb(new);
  -- 中身が同じ書き直し（同じ役割・同じ並び）は記録しない
  if o = n then
    return null;
  end if;

  insert into record_history (
    table_name, row_id, resident_id, record_day, op,
    rev_before, rev_after, old_row, new_row, changed_by_staff
  ) values (
    'attendance',
    new.staff_id,
    null,
    new.day,
    case when old.sort >= 0 and new.sort < 0 then 'delete' else 'update' end,
    null,
    null,
    o,
    n,
    null
  );
  return null; -- after トリガなので戻り値は使われない
end;
$$;

revoke all on function public.attendance_history_capture() from public, anon;

create or replace trigger trg_history_attendance
  after update on public.attendance
  for each row execute function public.attendance_history_capture();

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) トリガが付いたか
--    select trigger_name from information_schema.triggers
--     where event_object_table = 'attendance' and trigger_name = 'trg_history_attendance';
--    → 1行（UPDATE）
--
-- 2) 記録されるか（合成のデータで確かめる。実データでは試さない）
--    select op, record_day, row_id, old_row ->> 'sort', new_row ->> 'sort', changed_at
--      from record_history where table_name = 'attendance' order by changed_at desc limit 5;
--
-- 戻す時（必要な時だけ。記録の行は残る）:
--    drop trigger if exists trg_history_attendance on public.attendance;
--    drop function if exists public.attendance_history_capture();
-- ---------------------------------------------------------------------
