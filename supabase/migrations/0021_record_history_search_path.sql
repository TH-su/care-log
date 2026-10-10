-- =====================================================================
-- 0021: 変更の記録のトリガ関数（record_history_capture）の search_path に pg_temp を末尾で明示する（監査 F39・2026-10-10）
--
-- 0001〜0020 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- テーブル・列・データには触れない（関数を同じ本文で作り直すだけ）。
--
-- なぜ:
--   0010 の record_history_capture は security definer（所有者の権限で record_history に書く）なのに
--   search_path を public だけにしていた。PostgreSQL は search_path に pg_temp が書かれていないと一時スキーマを
--   **先頭**で探すので、SQL を直接流せる接続で一時表 record_history を作ってから業務表を更新すると、変更の記録が
--   本物の表ではなく一時表へ入って残らない（所有者の権限で一時表のトリガまで動く）。PostgREST 経由では一時表を
--   作れないので今は実害が無いが、0011・0017・0020 と同じく pg_temp を明示的に末尾へ置く。
--
-- 形:
--   ・`alter function … set search_path` だけにしない。0010 は create or replace で書かれているので、後で 0010 を
--     流し直すと search_path=public に黙って戻る。ここでは本文ごと create or replace し直す
--     （**0010 を流し直したら、このファイルも流し直す**）。
--   ・本文は 0010 と1文字も変えない（「内容が同じなら記録しない」判定・op の判定・changed_by_staff の写し）。
--     tools/import.mjs は changed_by_uid が null でない履歴を見て「アプリで直した取込行」を判定しているため。
--   ・create or replace は関数の OID を変えないので、9表のトリガ（0010 の5表・0012・0013 の2表・0014）は
--     付け直さなくても新しい設定で動く。
--
-- 旧クライアント×新サーバー: 端末からは何も変わらない（記録の中身・書き方は同じ）。データは消えない。
-- 新クライアント×旧サーバー: この移行は端末の挙動に関係しない。
--
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

create or replace function record_history_capture() returns trigger
language plpgsql
security definer
-- pg_temp を明示的に末尾へ置き、一時テーブルによる名前の乗っ取りを防ぐ（0011・0017・0020 と同じ）
set search_path = public, pg_temp
as $$
declare
  o       jsonb;
  n       jsonb;
  day_col text;
begin
  o := to_jsonb(old);
  n := to_jsonb(new);
  day_col := tg_argv[0];

  -- 版・更新時刻・触った人だけが動いた更新（内容が同じ再保存・再取込）は記録しない
  if (o - 'rev' - 'updated_at' - 'edited_by') = (n - 'rev' - 'updated_at' - 'edited_by') then
    return null;
  end if;

  insert into record_history (
    table_name, row_id, resident_id, record_day, op,
    rev_before, rev_after, old_row, new_row, changed_by_staff
  ) values (
    tg_table_name,
    (n ->> 'id')::bigint,
    (n ->> 'resident_id')::bigint,
    (n ->> day_col)::date,
    case when (o ->> 'deleted_at') is null and (n ->> 'deleted_at') is not null
         then 'delete' else 'update' end,
    (o ->> 'rev')::int,
    (n ->> 'rev')::int,
    o,
    n,
    (n ->> 'edited_by')::bigint
  );
  return null; -- after トリガなので戻り値は使われない
end;
$$;

-- PostgREST のスキーマキャッシュを即時リロード（関数の設定を変えただけなので念のため）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) search_path に pg_temp が末尾で入ったか
--    select proconfig, prosecdef from pg_proc where proname = 'record_history_capture';
--    → {"search_path=public, pg_temp"}・t
--
-- 戻す時（必要な時だけ）: 0010 の create or replace function record_history_capture の節だけを流し直す。
-- ---------------------------------------------------------------------
