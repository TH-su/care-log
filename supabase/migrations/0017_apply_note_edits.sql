-- =====================================================================
-- 0017: 申し送り（notes）の欄ごとの compare-and-set（RPC apply_note_edits）
--       既にある申し送りの変更・取り消しを「サーバー側で、行ロックの下で、欄ごとに」裁く
--
-- 適用方法: Supabase ダッシュボード > SQL Editor に、0001 → … → 0016 を実行した後で
--           このファイルの内容を貼り付けて実行する（冪等・何度実行してもよい）。
--           作るのは関数1つと索引1つだけで、テーブル・列・データには一切触れない（追加のみ）。
--           0010 の edited_by 列と record_history のトリガが前提（書いた行の旧値はトリガが残す）。
--
-- アプリとの適用順: DB 先 → アプリ配信。
--   旧版のアプリはこの関数を呼ばない（従来どおり rev 照合で書く）ので、先に当てても旧版は壊れない。
--   新版のアプリは申し送りの変更・取り消しの前にこの関数の有無を確かめ（p_id=null）、無ければ
--   既にある申し送りの変更を「サーバー側の更新待ち」として止める（旧い書き方へは戻さない）。
--   申し送りの新規登録（insert・client_key）は従来の経路のままで、この関数に関係なく動く。
--
-- 背景（2026-09-29 本人承認「申し送りを同時に編集されても絶対に消えない作りに」）:
--   これまでの申し送りの変更は rev 照合（rev が合えば行ごと書く・合わなければ 0 行＝競合）だった。
--   ・日報で競合すると、打った本文は画面のどこにも残らず消えた
--   ・タイムラインは自動の取り直しで rev だけが新しくなり、他の端末が直した本文を黙って上書きした
--   ・色だけを変えた端末と本文を直した端末が同時だと、後の方が「競合」になって入力を失った
--   0011（バイタル・食事）と同じく、判定と書込を1つのトランザクション・1つの行ロックの下で行い、
--   欄ごとに「基準のままなら書く・食い違えば書かずに返す」ようにする。
--
-- 判定（欄ごと・行ロックの下）:
--   ① いまの値 = あなたの値                 → settled（もう載っている。書かない）
--   ② いまの値 = 基準（base＝編集を始めた時に画面に出ていたサーバーの生の値） → 書く
--   ③ それ以外                             → 競合（書かない。reason='changed'）
--   ・base キーが無い欄（基準が分からない）は、いまの値が空の時だけ書く（同じ値なら ①）
--   ・取り消し（deleted_at）は、base に「呼び手が見た本文」を載せる。いまの本文がそれと一致する時だけ
--     deleted_at を書く（見ていない本文を消さない）。一致しない・base が無い → 競合（reason='changed'。
--     返り値の server には、いまの本文を入れる）。既に取り消されていた → settled（目的は達している）
--   ・1欄でも書く時だけ行を更新する: edited_by を p_editor にする。rev は 0001 のトリガで +1、
--     旧値は 0010 のトリガが record_history へ残す。書く欄が無ければ行に触れない（rev を進めない）
--   ・行が無い → 全欄を競合（reason='missing'）
--   ・取り消し済みの行 → いまの値＝あなたの値の欄は settled（届いた後に取り消された）、それ以外は
--     競合（reason='missing'。取り消された行を書き換えない・復活させない）
--   ・本文を空にする編集は拒否する（0001 の check (body <> '') と同じ。例外 23514）
--   ・この関数は行を作らない（新規登録は従来の insert・client_key の経路）
--
-- 返り値（jsonb。0011 と同じ形）:
--   {version:1, status:'applied'|'partial'|'conflict'|'noop'|'probe',
--    row:{…アプリが読む列…}|null（呼んだ後に生きている行が無ければ null）, applied:[欄], settled:[欄],
--    conflicts:[{field, server, base, mine, reason:'changed'|'missing'}]}
--
-- 実装上の約束（0011 と同じ）:
--   ・volatile（既定）。security invoker（呼んだ職員の権限＝notes の RLS がそのまま効く）
--   ・動的 SQL を使わない。書ける欄の許可リストは関数本文そのもの。未知の欄は拒否（例外）
--   ・値の比較は列の型にそろえた文字列どうしで行う（文字の欄は空文字を null とみなす）
--   ・1回の呼び出しで掴む行は1行だけ（デッドロックは起きない）。ロック待ちは statement_timeout で切れる
--
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
--   関数本体の as $fn$ … $fn$ は使ってよい（0005・0011 と同じ）。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

-- 作り直しは同じシグネチャだけを落としてから作る（オーバーロードを作らない）
drop function if exists public.apply_note_edits(bigint, jsonb, bigint);

create function public.apply_note_edits(
  p_id     bigint,                  -- 申し送りの行 id（null＝関数があるかの確かめ）
  p_edits  jsonb,                   -- {欄: {value, base}}。base キー無し＝基準が分からない
  p_editor bigint default null      -- edited_by（最後にこの行を書き換えた職員）
)
returns jsonb
language plpgsql
volatile
security invoker
-- pg_temp を明示的に末尾へ置き、一時テーブルによる名前の乗っ取りを防ぐ（0005・0011 と同じ）
set search_path = public, pg_temp
as $fn$
declare
  -- 書ける欄の許可リスト（並びは返り値の並び）
  c_fields constant text[] := array[
    'body', 'resident_id', 'importance', 'color', 'after16', 'occurred_at', 'reporter_id',
    'role_tags', 'shift', 'ongoing', 'ended_at', 'ended_by', 'deleted_at'
  ];
  v_edits     jsonb := coalesce(p_edits, '{}'::jsonb);
  v_bad       text;
  v_row       notes%rowtype;
  v_found     boolean := false;  -- 行がある（取り消し済みを含む）
  v_live      boolean := false;  -- 生きている行（deleted_at is null）
  v_cur       jsonb;             -- 掴んだ行（判定用）
  f           text;
  e           jsonb;
  c_srv       text;
  c_mine      text;
  c_base      text;
  v_write     text[] := '{}';
  v_settled   text[] := '{}';
  v_conf      text[] := '{}';
  v_reason    jsonb := '{}'::jsonb;   -- 欄 → 'changed' | 'missing'
  v_conflicts jsonb := '[]'::jsonb;
  v_row_json  jsonb;
  v_status    text;
begin
  -- 関数が当たっているかの確認（アプリが申し送りの変更の前に呼ぶ）
  if p_id is null then
    return jsonb_build_object('version', 1, 'status', 'probe');
  end if;

  -- ---------- 引数の検査（エラー文は何が起きたか＋次にどうするか。個人情報は含めない） ----------
  if jsonb_typeof(v_edits) is distinct from 'object' then
    raise exception '保存する内容を読み取れませんでした。アプリを再読み込みしてからもう一度お試しください'
      using errcode = '22023';
  end if;
  select k into v_bad from jsonb_object_keys(v_edits) as k where k <> all (c_fields) limit 1;
  if v_bad is not null then
    raise exception '保存できない欄です（%）。アプリを再読み込みしてからもう一度お試しください', v_bad
      using errcode = '22023';
  end if;
  foreach f in array c_fields loop
    continue when not (v_edits ? f);
    e := v_edits -> f;
    if jsonb_typeof(e) is distinct from 'object' or not (e ? 'value') then
      raise exception '欄の値を読み取れませんでした（%）。アプリを再読み込みしてからもう一度お試しください', f
        using errcode = '22023';
    end if;
    -- 職種タグは文字の配列だけを受ける（null・配列でない値は行の not null を壊す）
    if f = 'role_tags' and (
         jsonb_typeof(e -> 'value') is distinct from 'array'
         or exists (select 1 from jsonb_array_elements(e -> 'value') as t where jsonb_typeof(t) <> 'string')
       ) then
      raise exception '職種タグを読み取れませんでした。アプリを再読み込みしてからもう一度お試しください'
        using errcode = '22023';
    end if;
  end loop;
  -- 本文を空にする編集は拒否（0001 の check (body <> '') と同じ。判定の前に止める＝何も書かない）
  if v_edits ? 'body' and coalesce(v_edits -> 'body' ->> 'value', '') = '' then
    raise exception '本文が空です。内容を入力してから保存してください'
      using errcode = '23514';
  end if;
  -- 取り消しは時刻（端末で押した時刻）を値に持つ
  if v_edits ? 'deleted_at' and nullif(v_edits -> 'deleted_at' ->> 'value', '') is null then
    raise exception '取り消しの指定を読み取れませんでした。アプリを再読み込みしてからもう一度お試しください'
      using errcode = '22023';
  end if;

  -- ---------- 行を掴む（取り消し済みも掴む＝「届いた後に取り消された」を見分ける） ----------
  select * into v_row from notes where id = p_id for update;
  v_found := found;
  v_live := v_found and v_row.deleted_at is null;
  if v_found then v_cur := to_jsonb(v_row); end if;

  -- ---------- 欄ごとの判定（列の型にそろえた文字列どうしで比べる） ----------
  foreach f in array c_fields loop
    continue when not (v_edits ? f);
    e := v_edits -> f;

    if f = 'deleted_at' then
      if not v_found then
        v_conf := v_conf || f;
        v_reason := v_reason || jsonb_build_object(f, 'missing');
      elsif not v_live then
        v_settled := v_settled || f;                                   -- もう取り消されている
      elsif (e ? 'base') and nullif(e ->> 'base', '') is not null
            and v_row.body is not distinct from (e ->> 'base') then
        v_write := v_write || f;                                       -- 見た本文のまま → 取り消す
      else
        v_conf := v_conf || f;                                         -- 見ていない本文は消さない
        v_reason := v_reason || jsonb_build_object(f, 'changed');
      end if;
      continue;
    end if;

    c_mine := case
      when f in ('resident_id', 'reporter_id', 'ended_by') then (nullif(e ->> 'value', '')::bigint)::text
      when f in ('after16', 'ongoing') then (nullif(e ->> 'value', '')::boolean)::text
      when f = 'occurred_at' then (nullif(e ->> 'value', '')::time)::text
      when f = 'ended_at' then (nullif(e ->> 'value', '')::timestamptz)::text
      when f = 'role_tags' then (e -> 'value')::text
      else nullif(e ->> 'value', '')
    end;
    c_base := case
      when not (e ? 'base') or jsonb_typeof(e -> 'base') = 'null' then null
      when f in ('resident_id', 'reporter_id', 'ended_by') then (nullif(e ->> 'base', '')::bigint)::text
      when f in ('after16', 'ongoing') then (nullif(e ->> 'base', '')::boolean)::text
      when f = 'occurred_at' then (nullif(e ->> 'base', '')::time)::text
      when f = 'ended_at' then (nullif(e ->> 'base', '')::timestamptz)::text
      when f = 'role_tags' then (e -> 'base')::text
      else nullif(e ->> 'base', '')
    end;
    c_srv := case
      when v_cur is null or jsonb_typeof(v_cur -> f) = 'null' then null
      when f in ('resident_id', 'reporter_id', 'ended_by') then (nullif(v_cur ->> f, '')::bigint)::text
      when f in ('after16', 'ongoing') then (nullif(v_cur ->> f, '')::boolean)::text
      when f = 'occurred_at' then (nullif(v_cur ->> f, '')::time)::text
      when f = 'ended_at' then (nullif(v_cur ->> f, '')::timestamptz)::text
      when f = 'role_tags' then (v_cur -> f)::text
      else nullif(v_cur ->> f, '')
    end;

    if not v_found then
      v_conf := v_conf || f;
      v_reason := v_reason || jsonb_build_object(f, 'missing');
    elsif not v_live then
      -- 届いた後に取り消された行: 同じ値なら届いている（書かない）、違えば取り消された行への編集
      if c_srv is not distinct from c_mine then
        v_settled := v_settled || f;
      else
        v_conf := v_conf || f;
        v_reason := v_reason || jsonb_build_object(f, 'missing');
      end if;
    elsif c_srv is not distinct from c_mine then
      v_settled := v_settled || f;                                     -- ① もう載っている
    elsif (e ? 'base' and c_srv is not distinct from c_base) or (not (e ? 'base') and c_srv is null) then
      v_write := v_write || f;                                         -- ② 基準のまま（基準不明は空の時だけ）
    else
      v_conf := v_conf || f;                                           -- ③ 他の端末が変えた
      v_reason := v_reason || jsonb_build_object(f, 'changed');
    end if;
  end loop;

  -- ---------- 書く（1欄でも書く時だけ） ----------
  if v_live and cardinality(v_write) > 0 then
    update notes set
      body        = case when 'body'        = any (v_write) then v_edits -> 'body' ->> 'value' else body end,
      resident_id = case when 'resident_id' = any (v_write) then nullif(v_edits -> 'resident_id' ->> 'value', '')::bigint else resident_id end,
      importance  = case when 'importance'  = any (v_write) then v_edits -> 'importance' ->> 'value' else importance end,
      color       = case when 'color'       = any (v_write) then nullif(v_edits -> 'color' ->> 'value', '') else color end,
      after16     = case when 'after16'     = any (v_write) then (v_edits -> 'after16' ->> 'value')::boolean else after16 end,
      occurred_at = case when 'occurred_at' = any (v_write) then nullif(v_edits -> 'occurred_at' ->> 'value', '')::time else occurred_at end,
      reporter_id = case when 'reporter_id' = any (v_write) then nullif(v_edits -> 'reporter_id' ->> 'value', '')::bigint else reporter_id end,
      role_tags   = case when 'role_tags'   = any (v_write)
                         then array(select jsonb_array_elements_text(v_edits -> 'role_tags' -> 'value'))
                         else role_tags end,
      shift       = case when 'shift'       = any (v_write) then v_edits -> 'shift' ->> 'value' else shift end,
      ongoing     = case when 'ongoing'     = any (v_write) then (v_edits -> 'ongoing' ->> 'value')::boolean else ongoing end,
      ended_at    = case when 'ended_at'    = any (v_write) then nullif(v_edits -> 'ended_at' ->> 'value', '')::timestamptz else ended_at end,
      ended_by    = case when 'ended_by'    = any (v_write) then nullif(v_edits -> 'ended_by' ->> 'value', '')::bigint else ended_by end,
      deleted_at  = case when 'deleted_at'  = any (v_write) then (v_edits -> 'deleted_at' ->> 'value')::timestamptz else deleted_at end,
      edited_by   = p_editor
    where id = v_row.id
    returning * into v_row;
  end if;

  -- ---------- 返り値 ----------
  foreach f in array c_fields loop
    continue when not (f = any (v_conf));
    e := v_edits -> f;
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
      'field', f,
      -- 取り消しの競合は「いまの本文」を返す（見た本文と食い違った中身を画面が出せるように）
      'server', case when not v_found then 'null'::jsonb
                     when f = 'deleted_at' then coalesce(v_cur -> 'body', 'null'::jsonb)
                     else coalesce(v_cur -> f, 'null'::jsonb) end,
      'base', coalesce(e -> 'base', 'null'::jsonb),
      'mine', coalesce(e -> 'value', 'null'::jsonb),
      'reason', v_reason ->> f
    ));
  end loop;

  if v_found and v_row.deleted_at is null then
    v_row_json := jsonb_build_object(
      'id', v_row.id, 'note_on', v_row.note_on, 'shift', v_row.shift, 'facility', v_row.facility,
      'category', v_row.category, 'resident_id', v_row.resident_id, 'role_tags', to_jsonb(v_row.role_tags),
      'importance', v_row.importance, 'body', v_row.body, 'occurred_at', v_row.occurred_at,
      'ongoing', v_row.ongoing, 'ended_at', v_row.ended_at, 'reporter_id', v_row.reporter_id,
      'color', v_row.color, 'after16', v_row.after16, 'rev', v_row.rev
    );
  end if;

  v_status := case
    when cardinality(v_write) > 0 and cardinality(v_conf) > 0 then 'partial'
    when cardinality(v_write) > 0 then 'applied'
    when cardinality(v_conf) > 0 then 'conflict'
    else 'noop'
  end;

  return jsonb_build_object(
    'version', 1,
    'status', v_status,
    'row', v_row_json,
    'applied', to_jsonb(v_write),
    'settled', to_jsonb(v_settled),
    'conflicts', v_conflicts
  );
end;
$fn$;

comment on function public.apply_note_edits(bigint, jsonb, bigint) is
  '申し送りの欄ごとの compare-and-set（行ロックの下で判定と書き込み。取り消しは見た本文と一致する時だけ）。security invoker・authenticated 限定。';

-- ---------------------------------------------------------------------
-- 実行権限: PUBLIC の既定 EXECUTE を剥がし、anon を明示 revoke・authenticated に grant。
-- （0002・0005・0011 と同じ手順。do ブロックでのロール存在判定は使わない）
-- ---------------------------------------------------------------------
revoke all     on function public.apply_note_edits(bigint, jsonb, bigint) from public;
revoke execute on function public.apply_note_edits(bigint, jsonb, bigint) from anon;
grant  execute on function public.apply_note_edits(bigint, jsonb, bigint) to   authenticated;

-- ---------------------------------------------------------------------
-- 変更の記録: 対象を付け替えた申し送りを、元の利用者のカルテからも辿れるようにする索引
-- （カルテの「変更の記録」は resident_id に加えて old_row の resident_id でも引く。追加のみ）
-- ---------------------------------------------------------------------
create index if not exists idx_record_history_old_resident
  on record_history ((old_row ->> 'resident_id'), record_day desc);

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST202 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) 権限: anon が false・authenticated が true
--    select has_function_privilege('anon',          'public.apply_note_edits(bigint,jsonb,bigint)', 'execute') as anon_exec,
--           has_function_privilege('authenticated', 'public.apply_note_edits(bigint,jsonb,bigint)', 'execute') as auth_exec;
--
-- 2) security invoker・volatile であること（prosecdef = false・provolatile = 'v'）
--    select proname, prosecdef, provolatile, proconfig from pg_proc
--     where pronamespace = 'public'::regnamespace and proname = 'apply_note_edits';
--
-- 3) 生存確認（アプリが呼ぶ形）
--    select public.apply_note_edits(null, '{}');
--    → {"status": "probe", "version": 1}
--
-- 4) 未知の欄は拒否されること（例外「保存できない欄です」）
--    select public.apply_note_edits(0, '{"rev": {"value": 9}}');
--
-- ロールバック（この RPC を取り除く。業務データには影響しない。新版アプリは申し送りの変更を止めて待つ）:
--    drop function if exists public.apply_note_edits(bigint, jsonb, bigint);
--    drop index if exists idx_record_history_old_resident;
-- ---------------------------------------------------------------------
