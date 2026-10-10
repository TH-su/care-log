-- =====================================================================
-- 0025: 申し送りでの表示名（residents.note_alias）の変更を変更の記録（record_history）に残す
--       （監査 F40②・2026-10-10 本人回答「出勤者・表示名の変更にも record_history を付ける」）
--
-- 0001〜0024 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- テーブル・列・データには触れない（トリガ関数1つとトリガ1つの追加だけ）。
--
-- なぜ:
--   表示名は同姓の取り違えを防ぐための設定だが、端末A（圏外）と端末B が同じ方に別の表示名を付けると、
--   後から届いた方が残り、前の値も誰がいつ変えたかも残らなかった（送信待ちの再送は 2026-10-10 F71 で基準と重複を
--   確かめるようにしたが、オンラインの書き込みと旧版の再送は今も後勝ち）。
--
-- 形:
--   ・note_alias が変わった更新だけを記録する（`after update of note_alias … when (… is distinct from …)`）。
--     residents はマスタ同期（gasClient の applyResidents）が氏名・部屋・在籍を一括で書くので、表全体に付けると
--     同期のたびに記録が増えて埋まる。マスタ同期は note_alias に触れない約束（db.ts の setResidentNoteAlias の注記）。
--   ・old_row / new_row は {id, note_alias} だけ（利用者の氏名・部屋などを記録の表へ写さない）。
--   ・row_id ＝ resident_id ＝ 利用者の id。record_day は null（業務日付の無い設定なので、カルテの日付範囲の
--     「変更の記録」には出ない＝画面の表示は今までどおり）。
--   ・changed_by_staff は null（表示名の書き込みは記入者を送っていない）。誰が変えたかは changed_by_uid で残る。
--   ・security definer・search_path = public, pg_temp（0021・0024 と同じ）。
--
-- 旧クライアント×新サーバー: 表示名の書き方は何も変わらない（記録を足すだけ）。データは消えない。
-- 新クライアント×旧サーバー: この移行は端末の挙動に関係しない。
--
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
-- 個人情報: このファイルに実在の氏名・表示名を書かない（構造だけを定義する）。
-- =====================================================================

create or replace function public.note_alias_history_capture() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into record_history (
    table_name, row_id, resident_id, record_day, op,
    rev_before, rev_after, old_row, new_row, changed_by_staff
  ) values (
    'residents',
    new.id,
    new.id,
    null,
    'update',
    null,
    null,
    jsonb_build_object('id', old.id, 'note_alias', old.note_alias),
    jsonb_build_object('id', new.id, 'note_alias', new.note_alias),
    null
  );
  return null; -- after トリガなので戻り値は使われない
end;
$$;

revoke all on function public.note_alias_history_capture() from public, anon;

create or replace trigger trg_history_note_alias
  after update of note_alias on public.residents
  for each row
  when (old.note_alias is distinct from new.note_alias)
  execute function public.note_alias_history_capture();

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) トリガが付いたか
--    select trigger_name, action_condition from information_schema.triggers
--     where event_object_table = 'residents' and trigger_name = 'trg_history_note_alias';
--    → 1行（条件 old.note_alias IS DISTINCT FROM new.note_alias）
--
-- 2) 記録の見方
--    select row_id, old_row ->> 'note_alias', new_row ->> 'note_alias', changed_at, changed_by_uid
--      from record_history where table_name = 'residents' order by changed_at desc limit 10;
--
-- 戻す時（必要な時だけ。記録の行は残る）:
--    drop trigger if exists trg_history_note_alias on public.residents;
--    drop function if exists public.note_alias_history_capture();
-- ---------------------------------------------------------------------
