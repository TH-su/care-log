-- =====================================================================
-- 0020: 保存済みのバイタル（発熱者・他症状者の測定1件）の取り消し（RPC delete_vital）
--       「見た値のままなら取り消す・食い違えば取り消さずに返す」を、行ロックの下で裁く
--
-- 適用方法: Supabase ダッシュボード > SQL Editor に、0001 → … → 0019 を実行した後で
--           このファイルの内容を貼り付けて実行する（冪等・何度実行してもよい）。
--           作るのは関数1つだけで、テーブル・列・データ・索引・ポリシーには一切触れない（追加のみ）。
--           drop を使わない（create or replace）ので、破壊的な操作の確認は出ない想定。
--           0010 の edited_by 列と record_history のトリガが前提（取り消した行の旧値はトリガが op='delete' で残す）。
--
-- アプリとの適用順: DB 先 → アプリ配信（0011・0017 と同じ）。
--   旧版のアプリはこの関数を呼ばないので、先に当てても旧版は壊れない。
--   新版のアプリは、この関数が無い間に「✕」を押されても何も消さず、「サーバー側の更新待ち」の一言を出す。
--
-- 背景（2026-10-09 本人裁定「保存済みの発熱者・他症状者は1回分ずつ消せるようにして進めて」）:
--   0011 apply_cell_edits の許可リストには deleted_at が無く、保存済みの発熱者・他症状者を消す道が無かった。
--   apply_cell_edits を作り直して許可リストを広げる案は採らない:
--   ・apply_cell_edits はバイタル・食事の全保存が通る関数で、広げるには約400行を作り直すことになり、
--     1か所の誤りが全保存を止める。この関数は追加だけで、既存の経路に一切触れない（戻しは drop 1行）
--   ・取り消しの前提は「行全体（8欄）を見たまま」であり、欄ごとに {value, base} で裁く apply_cell_edits の
--     判定の単位と形が違う
--
-- 判定（行ロックの下）:
--   ・p_seen（呼び手が画面で見ていたサーバーの生の値）に 8欄（temp, sys_bp, dia_bp, pulse, spo2, measured_at,
--     note, symptom）すべてのキーが要る。欠けていれば拒否（見ていない欄がある取り消しを受けない）
--   ・生きている行で、8欄すべてが p_seen と一致 → deleted_at = now()・edited_by = p_editor（status 'applied'）
--   ・1欄でも食い違う → 書かない（status 'conflict'・reason 'changed'・row にいまの行）
--   ・既に取り消されている → 書かない（status 'settled'。目的は達している）
--   ・行が無い（または RLS で見えない）→ 書かない（status 'conflict'・reason 'missing'）
--   ・取り消せるのは発熱者（observation）・他症状者（symptom）だけ。それ以外の種別は拒否
--   ・値の比較は 0011 と同じく列の型にそろえた文字列どうし（temp は numeric(3,1)、血圧・脈拍・SpO2 は smallint、
--     測定時刻は time、文字の欄は空文字を null とみなす）
--   ・rev は 0001 のトリガで +1、旧値は 0010 のトリガが record_history に op='delete' で残す
--   ・物理削除はしない。0008 の import_tombstoned_at には触れない（人の取り消し＝再取込で復活させない）
--
-- 返り値（jsonb）:
--   {version:1, status:'applied'|'settled'|'conflict'|'probe', reason:'changed'|'missing'|null,
--    row:{…アプリが読む列…}|null（取り消せなかった時のいまの行。取り消した・既に取り消し済み・行が無い時は null）}
--
-- 実装上の約束（0011・0017 と同じ）:
--   ・volatile（既定）。security invoker（呼んだ職員の権限＝vitals の RLS・0019 の member_only がそのまま効く）
--   ・動的 SQL を使わない。1回の呼び出しで掴む行は1行だけ（デッドロックは起きない）
--
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
--   関数本体の as $fn$ … $fn$ は使ってよい（0005・0011・0017 と同じ）。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

create or replace function public.delete_vital(
  p_id     bigint,                  -- バイタルの行 id（null＝関数があるかの確かめ）
  p_seen   jsonb,                   -- {temp, sys_bp, dia_bp, pulse, spo2, measured_at, note, symptom}（見た生の値）
  p_editor bigint default null      -- edited_by（取り消した職員）
)
returns jsonb
language plpgsql
volatile
security invoker
-- pg_temp を明示的に末尾へ置き、一時テーブルによる名前の乗っ取りを防ぐ（0005・0011・0017 と同じ）
set search_path = public, pg_temp
as $fn$
declare
  c_fields constant text[] := array['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2', 'measured_at', 'note', 'symptom'];
  v_seen   jsonb := coalesce(p_seen, '{}'::jsonb);
  v_row    vitals%rowtype;
  v_cur    jsonb;
  v_bad    text;
  f        text;
  c_srv    text;
  c_seen   text;
  v_same   boolean := true;
begin
  -- 関数が当たっているかの確認（アプリが呼ぶ形）
  if p_id is null then
    return jsonb_build_object('version', 1, 'status', 'probe');
  end if;

  -- ---------- 引数の検査（エラー文は何が起きたか＋次にどうするか。個人情報は含めない） ----------
  if jsonb_typeof(v_seen) <> 'object' then
    raise exception '取り消す記録の内容を読み取れませんでした。アプリを再読み込みしてからもう一度お試しください'
      using errcode = '22023';
  end if;
  select k into v_bad from unnest(c_fields) as k where not (v_seen ? k) limit 1;
  if v_bad is not null then
    raise exception '取り消す記録の内容が足りません（%）。アプリを再読み込みしてからもう一度お試しください', v_bad
      using errcode = '22023';
  end if;

  -- ---------- 行を掴む（取り消し済みも掴む＝「もう取り消されている」を見分ける） ----------
  select * into v_row from vitals where id = p_id for update;
  if not found then
    return jsonb_build_object('version', 1, 'status', 'conflict', 'reason', 'missing', 'row', null);
  end if;
  if v_row.kind not in ('observation', 'symptom') then
    raise exception 'この種類の記録はここでは取り消せません。アプリを再読み込みしてからもう一度お試しください'
      using errcode = '22023';
  end if;
  if v_row.deleted_at is not null then
    return jsonb_build_object('version', 1, 'status', 'settled', 'reason', null, 'row', null);
  end if;

  -- ---------- 見た値との突き合わせ（列の型にそろえた文字列どうしで比べる） ----------
  v_cur := to_jsonb(v_row);
  foreach f in array c_fields loop
    c_seen := case
      when f = 'temp' then (nullif(v_seen ->> f, '')::numeric(3,1))::text
      when f = 'measured_at' then (nullif(v_seen ->> f, '')::time)::text
      when f in ('note', 'symptom') then nullif(v_seen ->> f, '')
      else (nullif(v_seen ->> f, '')::smallint)::text
    end;
    c_srv := case
      when f = 'temp' then (nullif(v_cur ->> f, '')::numeric(3,1))::text
      when f = 'measured_at' then (nullif(v_cur ->> f, '')::time)::text
      when f in ('note', 'symptom') then nullif(v_cur ->> f, '')
      else (nullif(v_cur ->> f, '')::smallint)::text
    end;
    if c_srv is distinct from c_seen then
      v_same := false;
      exit;
    end if;
  end loop;

  if not v_same then
    -- 見ていない値は消さない。いまの行を返し、画面が描き直せるようにする
    return jsonb_build_object(
      'version', 1, 'status', 'conflict', 'reason', 'changed',
      'row', jsonb_build_object(
        'id', v_row.id, 'resident_id', v_row.resident_id, 'measured_on', v_row.measured_on, 'kind', v_row.kind,
        'measured_at', v_row.measured_at, 'temp', v_row.temp, 'sys_bp', v_row.sys_bp, 'dia_bp', v_row.dia_bp,
        'pulse', v_row.pulse, 'spo2', v_row.spo2, 'note', v_row.note, 'symptom', v_row.symptom,
        'recorded_by', v_row.recorded_by, 'rev', v_row.rev
      )
    );
  end if;

  update vitals set
    deleted_at = now(),
    edited_by  = p_editor
  where id = v_row.id;

  return jsonb_build_object('version', 1, 'status', 'applied', 'reason', null, 'row', null);
end;
$fn$;

comment on function public.delete_vital(bigint, jsonb, bigint) is
  '発熱者・他症状者の測定1件の取り消し（行ロックの下で、見た8欄と一致する時だけ deleted_at を書く）。security invoker・authenticated 限定。';

-- ---------------------------------------------------------------------
-- 実行権限: PUBLIC の既定 EXECUTE を剥がし、anon を明示 revoke・authenticated に grant。
-- （0002・0005・0011・0017 と同じ手順。do ブロックでのロール存在判定は使わない）
-- ---------------------------------------------------------------------
revoke all     on function public.delete_vital(bigint, jsonb, bigint) from public;
revoke execute on function public.delete_vital(bigint, jsonb, bigint) from anon;
grant  execute on function public.delete_vital(bigint, jsonb, bigint) to   authenticated;

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST202 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) 権限: anon が false・authenticated が true
--    select has_function_privilege('anon',          'public.delete_vital(bigint,jsonb,bigint)', 'execute') as anon_exec,
--           has_function_privilege('authenticated', 'public.delete_vital(bigint,jsonb,bigint)', 'execute') as auth_exec;
--
-- 2) security invoker・volatile であること（prosecdef = false・provolatile = 'v'）
--    select proname, prosecdef, provolatile, proconfig from pg_proc
--     where pronamespace = 'public'::regnamespace and proname = 'delete_vital';
--
-- 3) 生存確認（アプリが呼ぶ形。何も書かない）
--    select public.delete_vital(null, '{}');
--    → {"status": "probe", "version": 1}
--
-- ロールバック（この RPC を取り除く。業務データには影響しない。新版アプリは「✕」を押しても消さずに待つ）:
--    drop function if exists public.delete_vital(bigint, jsonb, bigint);
-- ---------------------------------------------------------------------
