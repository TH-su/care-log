-- =====================================================================
-- 0058: 申し送りの記入者に、職員の一覧に無い名前も書けるようにする（本人指示 2026-11-07「一覧に無い名前も自由に書ける」）
--
-- 0001〜0057 を当てたあとに実行する。冪等（何度流しても同じ）。begin … commit で包む。**アプリの公開より先に当てる**
-- （新しい版は申し送りを読む時にこの列を選ぶので、列が無いと読み取りが失敗する）。
--
-- 1. notes に列 reporter_name（記入者の名前の文字・空でよい・前後の空白を除いて1〜20字）を足す。
--    記入者は今までどおり職員（reporter_id）を選ぶのが基本。一覧に無い人（応援・実習生など）の時だけ名前の文字を残す。
--    表示は「職員の名前 → 無ければこの名前」の順（両方ある時は職員が勝つ）。既存の行・データには触れない。
-- 2. apply_note_edits（0039 の本文を引き継いで create or replace。同じ名前・引数・返り値）
--    変えたのは、書ける欄と見た行で比べる欄に reporter_name を足したこと、職員と名前を組として扱う（両方送られて片方が競合なら
--    相方も競合・継続の終了の組と同じ）こと、書いた後の行に職員がいる時は reporter_name をいつも空にすること、
--    返す行に reporter_name を足したことだけ。ほかの判定の決まりは 0039 のまま。
--    **0017・0027・0032・0039 を流し直したら、このファイルも流し直す**（同じ関数を create or replace するため）。
-- 3. timeline_chunk（0050 の本文を引き継いで create or replace）の notes・pinned に reporter_name を足す。ほかは 0050 のまま。
--    **0050 を流し直したら、このファイルも流し直す**。
--
-- 旧クライアント×新サーバー: 旧版はこの列を読まない・書かない。名前だけの記入者の行は、旧版では記入者が空に見える（データは消えない）。
--   旧版で職員を選び直すと、名前は空に戻る（職員が記入者になる・上の 2）。旧版で名前だけの行の「記入者を消す」を押しても
--   名前は消えない（旧版には空に見えるので、消えたように見える）。全端末を新しい版へ上げてから名前を使う。
-- 新クライアント×旧サーバー（0057 まで）: 申し送りの読み取りが列の無さで失敗する＝この移行を先に当てる。
-- 戻す: supabase/rollback/0058_back.sql（関数を 0039・0050 の本文に戻してから列を外す。名前だけの記入者の文字は消える）
--
-- 実装上の約束（0017・0027・0032・0039・0050 と同じ）: volatile・security invoker・search_path = public, pg_temp・動的 SQL なし。
-- ★ do $$ … $$ のブロックは使わない（関数本体の as $fn$ … $fn$ は使ってよい）。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

begin;
set local lock_timeout = '5s';

alter table public.notes add column if not exists reporter_name text;
alter table public.notes drop constraint if exists notes_reporter_name_check;
alter table public.notes add constraint notes_reporter_name_check
  check (reporter_name is null or char_length(btrim(reporter_name)) between 1 and 20);
comment on column public.notes.reporter_name is
  '一覧に無い記入者の名前（応援・実習生など・1〜20字）。表示は職員（reporter_id）の名前が先、無ければこの名前。0058（2026-11-07）';

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
    'body', 'resident_id', 'importance', 'color', 'after16', 'occurred_at', 'reporter_id', 'reporter_name',
    'role_tags', 'categories', 'shift', 'ongoing', 'ended_at', 'ended_by', 'deleted_at'
  ];
  -- 分類の7値（並びは書く時の並び。types.ts の NOTE_CATEGORIES と同じ。0032・0039 で「予定」を追加）
  c_categories constant text[] := array['体調', '食事', '薬', '支援調整', '消耗品', '家族', '予定'];
  -- 取り消しの seen で比べられる欄（deleted_at を除く全欄。知らない欄は比べない）
  c_seen_fields constant text[] := array[
    'body', 'resident_id', 'importance', 'color', 'after16', 'occurred_at', 'reporter_id', 'reporter_name',
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
  -- ---------- 記入者の組（0058）: 職員と一覧に無い名前が両方送られ、片方が競合なら相方も書かずに競合へ ----------
  -- （他の端末が選んだ職員と、この端末が書いた名前が両方残る行を作らない。継続の終了の組と同じ作り）
  if v_edits ? 'reporter_id' and v_edits ? 'reporter_name' then
    if 'reporter_id' = any (v_conf) and not ('reporter_name' = any (v_conf)) then
      v_write := array_remove(v_write, 'reporter_name');
      v_settled := array_remove(v_settled, 'reporter_name');
      v_conf := v_conf || 'reporter_name'::text;
      v_reason := v_reason || jsonb_build_object('reporter_name', v_reason ->> 'reporter_id');
    elsif 'reporter_name' = any (v_conf) and not ('reporter_id' = any (v_conf)) then
      v_write := array_remove(v_write, 'reporter_id');
      v_settled := array_remove(v_settled, 'reporter_id');
      v_conf := v_conf || 'reporter_id'::text;
      v_reason := v_reason || jsonb_build_object('reporter_id', v_reason ->> 'reporter_name');
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
      -- 一覧に無い記入者の名前（0058）。書いた後の行に職員がいる時はいつも空にする（職員と名前が両方残る行を作らない）
      reporter_name = case when (case when 'reporter_id' = any (v_write) then nullif(v_edits -> 'reporter_id' ->> 'value', '')::bigint
                                      else reporter_id end) is not null then null
                           when 'reporter_name' = any (v_write) then nullif(btrim(v_edits -> 'reporter_name' ->> 'value'), '')
                           else reporter_name end,
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
      'reporter_id', v_row.reporter_id, 'reporter_name', v_row.reporter_name, 'color', v_row.color, 'after16', v_row.after16, 'rev', v_row.rev
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
  '[0058: 一覧に無い記入者の名前 reporter_name を書ける] 申し送りの欄ごとの compare-and-set（行ロックの下で判定と書き込み。取り消しは見た本文と、seen があれば見た行と一致する時だけ。継続の終了は組）。security invoker・authenticated 限定。0027 で改訂・0032 で分類（categories）を追加・0039 で分類に「予定」を追加。';

-- 実行権限（0017 と同じ。create or replace は権限を保つが、単独で流しても同じ状態になるよう明示する）
revoke all     on function public.apply_note_edits(bigint, jsonb, bigint) from public;
revoke execute on function public.apply_note_edits(bigint, jsonb, bigint) from anon;
grant  execute on function public.apply_note_edits(bigint, jsonb, bigint) to   authenticated;

create or replace function public.timeline_chunk(
  p_from     date,
  p_to       date,
  p_staff_id bigint default null   -- 操作職員（actor）。null 可＝my_read は全て false
)
returns jsonb
language plpgsql
stable
security invoker
-- pg_temp を明示的に末尾へ置き、一時テーブルによる名前の乗っ取りを防ぐ
set search_path = public, pg_temp
as $fn$
declare
  c_max_span_days constant int := 100;  -- 1回で取得できる最大日数（通常運用は10日チャンク）
  c_lookback_days constant int := 60;   -- 継続・外出を遡って拾う上限（ui-design §3 の保持上限と同値）。
                                        -- 終了済みの継続・外出は期間開始日から、終了していない継続は日本時間の今日から数える（0050）。
                                        -- 終了していない最重要の継続には掛けない
  -- 終了していない継続の境目（0050）。now() は stable（同じ文・同じトランザクションの中では同じ値）なので、この関数の stable は崩れない
  c_open_from constant date := (now() at time zone 'Asia/Tokyo')::date - c_lookback_days;
begin
  -- 引数検証。エラー文は「何が起きたか＋次にどうすればよいか」（個人情報は含めない）
  if p_from is null or p_to is null then
    raise exception '期間が指定されていません。開始日と終了日を指定して取得し直してください';
  end if;
  if p_from > p_to then
    raise exception '期間の指定が逆になっています（開始 % / 終了 %）。開始日を終了日より前にしてください', p_from, p_to;
  end if;
  if (p_to - p_from) > c_max_span_days then
    raise exception '取得期間が長すぎます（最大 % 日・指定 % 日）。期間を分けて取得してください',
      c_max_span_days, (p_to - p_from);
  end if;

  return jsonb_build_object(
    'from', p_from,
    'to',   p_to,

    -- ── 申し送り（既読を畳み込む） ──────────────────────────────
    'notes', (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by x.note_on desc, x.occurred_at asc nulls last, x.id asc),
        '[]'::jsonb)
      from (
        select n.id, n.note_on, n.shift, n.facility, n.category, n.resident_id,
               n.role_tags, n.importance, n.body, n.occurred_at,
               n.ongoing, n.ended_at, n.ended_by, n.color, n.reporter_id, n.reporter_name, n.rev, n.created_at,
               coalesce(r.read_count, 0)  as read_count,
               coalesce(r.my_read, false) as my_read
        from notes n
        -- note_reads は PK(note_id, staff_id) の先頭列で引ける。行は返さず件数と自分の既読だけ畳み込む
        left join lateral (
          select count(*)::int                      as read_count,
                 bool_or(nr.staff_id = p_staff_id)  as my_read
          from note_reads nr
          where nr.note_id = n.id
        ) r on true
        where n.deleted_at is null
          and n.note_on between p_from and p_to
      ) x
    ),

    -- ── 継続（ongoing）申し送り＝ピン留め枠 ─────────────────────
    -- 期間より前に始まり、まだ終了していない（または期間開始日以降に終了した）ものを拾う。
    -- 終了判定は業務日付（JST）で比較する（ended_at は timestamptz のため時差で1日ずれない形にする）
    'pinned', (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by
          array_position(array['critical','important','normal']::text[], x.importance),
          x.note_on desc, x.id asc),
        '[]'::jsonb)
      from (
        select n.id, n.note_on, n.shift, n.facility, n.category, n.resident_id,
               n.role_tags, n.importance, n.body, n.occurred_at,
               n.ongoing, n.ended_at, n.ended_by, n.color, n.reporter_id, n.reporter_name, n.rev, n.created_at,
               coalesce(r.read_count, 0)  as read_count,
               coalesce(r.my_read, false) as my_read
        from notes n
        left join lateral (
          select count(*)::int                      as read_count,
                 bool_or(nr.staff_id = p_staff_id)  as my_read
          from note_reads nr
          where nr.note_id = n.id
        ) r on true
        where n.deleted_at is null
          and n.ongoing
          and n.note_on <= p_to
          and (
            -- まだ終了していない継続は、開始日が「日本時間の今日−遡り上限」以降の分だけ（0050・代表者の決定 2026-10-29 案A）。
            -- 境目は期間に関係なく今日で決める＝タイムラインの帯〔60日より前に始まった継続が N件〕と同じ日（どの10日の区切りでも
            -- 帯に数える継続をピン留めに出さない）。上限より古い分は帯で案内する。
            -- 最重要（critical）は入居者の安全のため上限を掛けない（今日の要注意が「最重要の申し送り（継続）」に使う。帯にも数えない）
            (n.ended_at is null
             and (n.note_on >= c_open_from
                  or n.importance = 'critical'))
            -- 終了済みは、期間開始日以降に終了した分だけ（開始日は遡り上限内に限る）
            or ((n.ended_at at time zone 'Asia/Tokyo')::date >= p_from
                and n.note_on >= p_from - c_lookback_days)
          )
      ) x
    ),

    -- ── バイタル ────────────────────────────────────────────────
    'vitals', (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by x.measured_on desc, x.resident_id asc,
                  x.measured_at asc nulls last, x.id asc),
        '[]'::jsonb)
      from (
        select v.id, v.resident_id, v.measured_on, v.kind, v.measured_at,
               v.temp, v.sys_bp, v.dia_bp, v.pulse, v.spo2, v.note,
               v.recorded_by, v.rev, v.created_at
        from vitals v
        where v.deleted_at is null
          and v.measured_on between p_from and p_to
      ) x
    ),

    -- ── 食事（朝→昼→夕→間食の順で返す） ───────────────────────
    'meals', (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by x.meal_on desc, x.resident_id asc,
                  array_position(array['breakfast','lunch','dinner','snack']::text[], x.meal_slot),
                  x.id asc),
        '[]'::jsonb)
      from (
        select m.id, m.resident_id, m.meal_on, m.meal_slot,
               m.main_amount, m.side_amount, m.status, m.note,
               m.recorded_by, m.rev
        from meals m
        where m.deleted_at is null
          and m.meal_on between p_from and p_to
      ) x
    ),

    -- ── 水分（日合計は表示側で算出する。ここでは1回=1行のまま返す） ──
    'fluids', (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by x.taken_on desc, x.resident_id asc,
                  x.taken_at asc nulls last, x.id asc),
        '[]'::jsonb)
      from (
        select f.id, f.resident_id, f.taken_on, f.taken_at, f.amount_ml, f.kind,
               f.recorded_by, f.rev, f.created_at
        from fluid_intake f
        where f.deleted_at is null
          and f.taken_on between p_from and p_to
      ) x
    ),

    -- ── 外出・外泊 ──────────────────────────────────────────────
    -- 期間に重なる行（開始が期間前・帰着未定 end_on is null を含む）を返す。
    -- meals.status='out' とは連動させない（片方の訂正が他方を無言変更する経路を作らない）
    'outings', (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by x.start_on desc, x.resident_id asc, x.id asc),
        '[]'::jsonb)
      from (
        select o.id, o.resident_id, o.kind, o.start_on, o.start_at,
               o.end_on, o.end_at, o.companion, o.note,
               o.recorded_by, o.rev
        from outings o
        where o.deleted_at is null
          and o.start_on <= p_to
          and o.start_on >= p_from - c_lookback_days
          and (o.end_on is null or o.end_on >= p_from)
      ) x
    ),

    -- ── 日次取込台帳（行あり0件=「記録なし」／行なし=「未取込」） ──
    'import_days', (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by x.day desc, x.source asc),
        '[]'::jsonb)
      from (
        select d.source, d.day, d.imported_at, d.src_rows, d.inserted, d.updated,
               d.skipped, d.native_skip, d.unmatched
        from import_days d
        where d.day between p_from and p_to
      ) x
    )
  );
end;
$fn$;

comment on function public.timeline_chunk(date, date, bigint) is
  'タイムライン10日チャンクを1往復で返す（notes は既読を read_count/my_read に畳み込み。notes・pinned に ended_by＝0030。notes・pinned・vitals・fluids に created_at＝0031。pinned の終了していない継続は開始日が日本時間の今日−60日以降か最重要のものだけ＝0050。notes・pinned に reporter_name＝0058）。security invoker・authenticated 限定。';

-- 実行権限（0002 と同じ。create or replace は権限を保つが、単独で流しても同じ状態になるよう明示する）
revoke all on function public.timeline_chunk(date, date, bigint) from public;
revoke execute on function public.timeline_chunk(date, date, bigint) from anon;
grant execute on function public.timeline_chunk(date, date, bigint) to authenticated;

commit;

notify pgrst, 'reload schema';

-- 確かめ（全部 ok なら完了）
select '申し送りに記入者の名前の列がある（空でよい・1〜20字）' as what,
       case when exists (select 1 from pg_catalog.pg_attribute
                          where attrelid = 'public.notes'::regclass and attname = 'reporter_name' and not attisdropped and not attnotnull)
             and exists (select 1 from pg_catalog.pg_constraint where conname = 'notes_reporter_name_check' and conrelid = 'public.notes'::regclass)
            then 'ok' else 'NG' end as result
union all
select '記入者を直す関数が記入者の名前を書ける', case when (select prosrc from pg_catalog.pg_proc where oid = 'public.apply_note_edits(bigint, jsonb, bigint)'::regprocedure)
                                       like '%reporter_name = case when ''reporter_name'' = any (v_write)%' then 'ok' else 'NG' end
union all
select 'タイムラインが記入者の名前を返す', case when (select prosrc from pg_catalog.pg_proc where oid = 'public.timeline_chunk(date, date, bigint)'::regprocedure)
                                       like '%n.reporter_name%' then 'ok' else 'NG' end
union all
select '権限は今までどおり（ログインした人だけが呼べる）',
       case when has_function_privilege('authenticated', 'public.apply_note_edits(bigint, jsonb, bigint)', 'execute')
             and not has_function_privilege('anon', 'public.apply_note_edits(bigint, jsonb, bigint)', 'execute')
             and has_function_privilege('authenticated', 'public.timeline_chunk(date, date, bigint)', 'execute')
             and not has_function_privilege('anon', 'public.timeline_chunk(date, date, bigint)', 'execute')
            then 'ok' else 'NG' end;
