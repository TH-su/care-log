-- =====================================================================
-- 0039: 申し送りの分類に「予定」を足す（本人指示 2026-10-20「事務所で使う『予定』の分類。予定の行はピンク・
--       同じ方の記録でもまとめない」）
--
-- 0001〜0038 を当てたあとに実行する。冪等（何度実行しても同じ結果）。**アプリの公開より先に当てる**
-- （新しい版は「予定」を送れるため、当てる前に公開すると「予定」を付けた保存が check で止まる）。
--
-- 1. check notes_categories_check に「予定」を足す（体調・食事・薬・支援調整・消耗品・家族・予定 の7つ）。
--    既存の行・データには触れない（制約を付け替えるだけ。今ある値はすべて7つの中に入る）。
-- 2. apply_note_edits（0032 の本文を引き継いで create or replace。同じ名前・引数・返り値）
--    変えたのは c_categories（書く時の並び）に「予定」を足したことだけ。判定・返り値の形は 0032 のまま。
--    **0017・0027・0032 を流し直したら、このファイルも流し直す**（同じ関数を create or replace するため、
--    後から流した方の本文になる。0032 だけを流し直すと「予定」を書けなくなる）。
--
-- 旧クライアント×新サーバー: 旧版は「予定」を知らない。読んだ行の「予定」は表示から落とすだけ（データは消えない）。
--   旧版でその行の分類を変えると、基準（予定なし）とサーバー（予定あり）が食い違うので競合として止まる＝黙って
--   「予定」を消さない。全端末を新しい版へ上げてから「予定」を使うのが確実。
-- 新クライアント×旧サーバー（0038 まで）: 「予定」を付けた保存が check で拒否される＝この移行を先に当てる。
--
-- 実装上の約束（0017・0027・0032 と同じ）: volatile・security invoker・search_path = public, pg_temp・動的 SQL なし。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

alter table notes drop constraint if exists notes_categories_check;
alter table notes add constraint notes_categories_check
  check (categories <@ array['体調', '食事', '薬', '支援調整', '消耗品', '家族', '予定']::text[]);

create or replace function public.apply_note_edits(
  p_id     bigint,                  -- 申し送りの行 id（null＝関数があるかの確かめ）
  p_edits  jsonb,                   -- {欄: {value, base}}。base キー無し＝基準が分からない。deleted_at は seen も持てる
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
    'role_tags', 'categories', 'shift', 'ongoing', 'ended_at', 'ended_by', 'deleted_at'
  ];
  -- 分類の7値（並びは書く時の並び。types.ts の NOTE_CATEGORIES と同じ。0032・0039 で「予定」を追加）
  c_categories constant text[] := array['体調', '食事', '薬', '支援調整', '消耗品', '家族', '予定'];
  -- 取り消しの seen で比べられる欄（deleted_at を除く全欄。知らない欄は比べない）
  c_seen_fields constant text[] := array[
    'body', 'resident_id', 'importance', 'color', 'after16', 'occurred_at', 'reporter_id',
    'role_tags', 'categories', 'shift', 'ongoing', 'ended_at', 'ended_by'
  ];
  v_edits     jsonb := coalesce(p_edits, '{}'::jsonb);
  v_bad       text;
  v_row       notes%rowtype;
  v_found     boolean := false;  -- 行がある（取り消し済みを含む）
  v_live      boolean := false;  -- 生きている行（deleted_at is null）
  v_cur       jsonb;             -- 掴んだ行（判定用）
  f           text;
  g           text;
  e           jsonb;
  c_srv       text;
  c_mine      text;
  c_base      text;
  c_seen      text;
  v_seen      jsonb;
  v_seen_diff text[] := '{}';    -- 取り消しの seen と食い違った欄
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
    -- 分類も文字の配列だけを受ける（6値以外は列の check notes_categories_check が 23514 で拒否する・0032）
    if f = 'categories' and (
         jsonb_typeof(e -> 'value') is distinct from 'array'
         or exists (select 1 from jsonb_array_elements(e -> 'value') as t where jsonb_typeof(t) <> 'string')
       ) then
      raise exception '分類を読み取れませんでした。アプリを再読み込みしてからもう一度お試しください'
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
  -- 取り消しの「見た行」（seen）はオブジェクトだけを受ける（読めない照合で取り消さない＝何も書かない・F09）
  if v_edits ? 'deleted_at' and (v_edits -> 'deleted_at') ? 'seen'
     and jsonb_typeof(v_edits -> 'deleted_at' -> 'seen') is distinct from 'object' then
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
        continue;
      elsif not v_live then
        v_settled := v_settled || f;                                   -- もう取り消されている
        continue;
      elsif not ((e ? 'base') and nullif(e ->> 'base', '') is not null
                 and v_row.body is not distinct from (e ->> 'base')) then
        v_conf := v_conf || f;                                         -- 見ていない本文は消さない
        v_reason := v_reason || jsonb_build_object(f, 'changed');
        continue;
      end if;
      -- 見た行（seen）がある時は、書かれた欄がすべていまの値のままか確かめる（F09。無い時は本文だけ＝従来どおり）
      if e ? 'seen' then
        v_seen := e -> 'seen';
        foreach g in array c_seen_fields loop
          continue when not (v_seen ? g);
          c_seen := case
            when jsonb_typeof(v_seen -> g) = 'null' then null
            when g in ('resident_id', 'reporter_id', 'ended_by') then (nullif(v_seen ->> g, '')::bigint)::text
            when g in ('after16', 'ongoing') then (nullif(v_seen ->> g, '')::boolean)::text
            when g = 'occurred_at' then (nullif(v_seen ->> g, '')::time)::text
            when g = 'ended_at' then (nullif(v_seen ->> g, '')::timestamptz)::text
            when g = 'role_tags' then (v_seen -> g)::text
            when g = 'categories' and jsonb_typeof(v_seen -> g) <> 'array' then (v_seen -> g)::text
            when g = 'categories' then (select coalesce(jsonb_agg(t order by t), '[]'::jsonb)::text
                                                  from (select distinct t from jsonb_array_elements_text(v_seen -> g) as t) as s)
            else nullif(v_seen ->> g, '')
          end;
          c_srv := case
            when jsonb_typeof(v_cur -> g) = 'null' then null
            when g in ('resident_id', 'reporter_id', 'ended_by') then (nullif(v_cur ->> g, '')::bigint)::text
            when g in ('after16', 'ongoing') then (nullif(v_cur ->> g, '')::boolean)::text
            when g = 'occurred_at' then (nullif(v_cur ->> g, '')::time)::text
            when g = 'ended_at' then (nullif(v_cur ->> g, '')::timestamptz)::text
            when g = 'role_tags' then (v_cur -> g)::text
            when g = 'categories' and jsonb_typeof(v_cur -> g) <> 'array' then (v_cur -> g)::text
            when g = 'categories' then (select coalesce(jsonb_agg(t order by t), '[]'::jsonb)::text
                                                  from (select distinct t from jsonb_array_elements_text(v_cur -> g) as t) as s)
            else nullif(v_cur ->> g, '')
          end;
          if c_srv is distinct from c_seen then
            v_seen_diff := v_seen_diff || g;
          end if;
        end loop;
      end if;
      if cardinality(v_seen_diff) > 0 then
        v_conf := v_conf || f;                                         -- 見た後に他の欄が直された → 消さない
        v_reason := v_reason || jsonb_build_object(f, 'changed');
      else
        v_write := v_write || f;                                       -- 見た本文（と見た行）のまま → 取り消す
      end if;
      continue;
    end if;

    c_mine := case
      when f in ('resident_id', 'reporter_id', 'ended_by') then (nullif(e ->> 'value', '')::bigint)::text
      when f in ('after16', 'ongoing') then (nullif(e ->> 'value', '')::boolean)::text
      when f = 'occurred_at' then (nullif(e ->> 'value', '')::time)::text
      when f = 'ended_at' then (nullif(e ->> 'value', '')::timestamptz)::text
      when f = 'role_tags' then (e -> 'value')::text
      when f = 'categories' and jsonb_typeof(e -> 'value') <> 'array' then (e -> 'value')::text
      when f = 'categories' then (select coalesce(jsonb_agg(t order by t), '[]'::jsonb)::text
                                  from (select distinct t from jsonb_array_elements_text(e -> 'value') as t) as s)
      else nullif(e ->> 'value', '')
    end;
    c_base := case
      when not (e ? 'base') or jsonb_typeof(e -> 'base') = 'null' then null
      when f in ('resident_id', 'reporter_id', 'ended_by') then (nullif(e ->> 'base', '')::bigint)::text
      when f in ('after16', 'ongoing') then (nullif(e ->> 'base', '')::boolean)::text
      when f = 'occurred_at' then (nullif(e ->> 'base', '')::time)::text
      when f = 'ended_at' then (nullif(e ->> 'base', '')::timestamptz)::text
      when f = 'role_tags' then (e -> 'base')::text
      when f = 'categories' and jsonb_typeof(e -> 'base') <> 'array' then (e -> 'base')::text
      when f = 'categories' then (select coalesce(jsonb_agg(t order by t), '[]'::jsonb)::text
                                  from (select distinct t from jsonb_array_elements_text(e -> 'base') as t) as s)
      else nullif(e ->> 'base', '')
    end;
    c_srv := case
      when v_cur is null or jsonb_typeof(v_cur -> f) = 'null' then null
      when f in ('resident_id', 'reporter_id', 'ended_by') then (nullif(v_cur ->> f, '')::bigint)::text
      when f in ('after16', 'ongoing') then (nullif(v_cur ->> f, '')::boolean)::text
      when f = 'occurred_at' then (nullif(v_cur ->> f, '')::time)::text
      when f = 'ended_at' then (nullif(v_cur ->> f, '')::timestamptz)::text
      when f = 'role_tags' then (v_cur -> f)::text
      when f = 'categories' and jsonb_typeof(v_cur -> f) <> 'array' then (v_cur -> f)::text
      when f = 'categories' then (select coalesce(jsonb_agg(t order by t), '[]'::jsonb)::text
                                  from (select distinct t from jsonb_array_elements_text(v_cur -> f) as t) as s)
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

  -- ---------- 継続の終了の組（F08）: 両方が送られ、片方が競合なら相方も書かず・「載っている」ともせずに競合へ ----------
  -- （誰も操作していない「終了時刻と終了者」の組を作らない。組の判定は settled の判定より優先する＝0011 の血圧と同じ）
  if v_edits ? 'ended_at' and v_edits ? 'ended_by' then
    if 'ended_at' = any (v_conf) and not ('ended_by' = any (v_conf)) then
      v_write := array_remove(v_write, 'ended_by');
      v_settled := array_remove(v_settled, 'ended_by');
      v_conf := v_conf || 'ended_by'::text;
      v_reason := v_reason || jsonb_build_object('ended_by', v_reason ->> 'ended_at');
    elsif 'ended_by' = any (v_conf) and not ('ended_at' = any (v_conf)) then
      v_write := array_remove(v_write, 'ended_at');
      v_settled := array_remove(v_settled, 'ended_at');
      v_conf := v_conf || 'ended_at'::text;
      v_reason := v_reason || jsonb_build_object('ended_at', v_reason ->> 'ended_by');
    end if;
  end if;

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
      -- 分類は重複を除き、6値の並び（c_categories）にそろえて書く（6値以外は check が拒否する）
      categories  = case when 'categories'  = any (v_write)
                         then array(select x
                                      from (select distinct jsonb_array_elements_text(v_edits -> 'categories' -> 'value') as x) as s
                                     order by array_position(c_categories, x), x)
                         else categories end,
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
    v_conflicts := v_conflicts || jsonb_build_array(
      jsonb_build_object(
        'field', f,
        -- 取り消しの競合は「いまの本文」を返す（見た本文と食い違った中身を画面が出せるように）
        'server', case when not v_found then 'null'::jsonb
                       when f = 'deleted_at' then coalesce(v_cur -> 'body', 'null'::jsonb)
                       else coalesce(v_cur -> f, 'null'::jsonb) end,
        'base', coalesce(e -> 'base', 'null'::jsonb),
        'mine', coalesce(e -> 'value', 'null'::jsonb),
        'reason', v_reason ->> f
      )
      -- 取り消しが「見た行」と食い違って止まった時だけ、食い違った欄の名前を添える（F09。旧版は読まない）
      || case when f = 'deleted_at' and cardinality(v_seen_diff) > 0
              then jsonb_build_object('fields', to_jsonb(v_seen_diff)) else '{}'::jsonb end
    );
  end loop;

  if v_found and v_row.deleted_at is null then
    v_row_json := jsonb_build_object(
      'id', v_row.id, 'note_on', v_row.note_on, 'shift', v_row.shift, 'facility', v_row.facility,
      'category', v_row.category, 'resident_id', v_row.resident_id, 'role_tags', to_jsonb(v_row.role_tags),
      'categories', to_jsonb(v_row.categories),
      'importance', v_row.importance, 'body', v_row.body, 'occurred_at', v_row.occurred_at,
      'ongoing', v_row.ongoing, 'ended_at', v_row.ended_at, 'ended_by', v_row.ended_by,
      'reporter_id', v_row.reporter_id, 'color', v_row.color, 'after16', v_row.after16, 'rev', v_row.rev
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
  '申し送りの欄ごとの compare-and-set（行ロックの下で判定と書き込み。取り消しは見た本文と、seen があれば見た行と一致する時だけ。継続の終了は組）。security invoker・authenticated 限定。0027 で改訂・0032 で分類（categories）を追加・0039 で分類に「予定」を追加。';

-- 実行権限（0017 と同じ。create or replace は権限を保つが、単独で流しても同じ状態になるよう明示する）
revoke all     on function public.apply_note_edits(bigint, jsonb, bigint) from public;
revoke execute on function public.apply_note_edits(bigint, jsonb, bigint) from anon;
grant  execute on function public.apply_note_edits(bigint, jsonb, bigint) to   authenticated;

-- PostgREST のスキーマキャッシュを即時リロード
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) 生存確認（アプリが呼ぶ形）: select public.apply_note_edits(null, '{}');  → {"status": "probe", "version": 1}
-- 2) security invoker のままか: select prosecdef, proconfig from pg_proc where proname = 'apply_note_edits';
--    → f ／ {"search_path=public, pg_temp"}
-- 3) seen がオブジェクトでない取り消しは拒否されること（例外「取り消しの指定を読み取れませんでした」）
--    select public.apply_note_edits(0, '{"deleted_at": {"value": "2026-01-01T00:00:00Z", "base": "x", "seen": 1}}');
--
-- 戻す時（必要な時だけ。0017 の判定に戻る。業務データには影響しない）: 0017 の create function の節を
--   drop function → create function ごと流し直す（0017 のファイルをそのまま流してよい）。
-- ---------------------------------------------------------------------
