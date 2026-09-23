-- =====================================================================
-- 0011: 欄ごとの compare-and-set（RPC apply_cell_edits）
--       バイタル・食事の同時入力を「サーバー側で、行ロックの下で、欄ごとに」裁く
--
-- 適用方法: Supabase ダッシュボード > SQL Editor に、0001 → … → 0010 を実行した後で
--           このファイルの内容を貼り付けて実行する（冪等・何度実行してもよい）。
--           作るのは関数1つだけで、テーブル・列・データ・索引には一切触れない（追加のみ）。
--           0010 の edited_by 列と record_history のトリガが前提（書いた行の旧値はトリガが残す）。
--
-- アプリとの適用順: DB 先 → アプリ配信。
--   旧版のアプリはこの関数を呼ばないので、先に当てても旧版は壊れない。
--   新版のアプリは起動時にこの関数の有無を確かめ（p_table='probe'）、無ければバイタル・食事の入力を
--   「サーバー側の更新待ち」として止める（旧い書き方へは戻さない）。
--
-- 背景（2026-09-23 本人承認「サーバー側判定へ切替」）:
--   これまでは端末が「いまの値を読む」→「rev 照合で書く」の2往復で同時入力を裁いていた。
--   読んでから書くまでの間に必ず時間差があり、その間に他の端末が書くと、端末側の継ぎ当てでは
--   閉じきれない取りこぼし（追い越し・送信中の入力・23505 からの載せ直し）が毎回形を変えて出た。
--   判定と書き込みを1つのトランザクション・1つの行ロックの下で行えば、この時間差そのものが無くなる。
--
-- 判定（欄ごと・行ロックの下）:
--   ① いまの値 = あなたの値                 → settled（もう載っている。書かない）
--   ② いまの値 = 基準（base＝編集を始めた時に画面に出ていた値） → 書く
--   ③ それ以外                             → 競合（書かない。reason='changed'）
--   ・base キーが無い欄（基準が分からない）は、いまの値が空の時だけ書く（同じ値なら ①）
--   ・血圧の上と下（sys_bp / dia_bp）は1つの組: どちらかが ③ なら、送られてきた相方も書かず、① の「載っている」
--     ともせずに競合へ入れる（誰も測っていない上下の組み合わせを作らない。組の判定は ① より優先）
--   ・1欄でも書く時だけ行を更新する: edited_by を p_editor にし、measured_at・recorded_by は
--     空いている時だけ p_fill の値で埋める（食い違いの判定には使わない）。rev は 0001 のトリガで +1、
--     旧値は 0010 のトリガが record_history へ残す。書く欄が無ければ行に触れない（rev を進めない）
--   ・生きている行（deleted_at is null）だけを相手にする。
--     行が無く、非 null の基準を持つ欄が無い → insert（自然キー・client_key）
--     行が無く、非 null の基準を持つ欄がある → 全欄を競合（reason='missing'。取り消された行を復活させない）
--
-- 行の指し方（p_key）:
--   vitals 定時      … {resident_id, measured_on}                       （uq_vitals_routine_day）
--   vitals 定時以外  … {client_key, resident_id, measured_on, kind}     （uq_vitals_client_key・insert 可）
--                      または {id}（既にある行の更新だけ。insert しない）
--   meals            … {resident_id, meal_on, meal_slot}                （uq_meals_slot）
--   自然キーを持つ行は常に自然キーで指す（id では指さない）のがアプリ側の約束。
--
-- 返り値（jsonb）:
--   {version:1, status:'applied'|'partial'|'conflict'|'noop'|'probe',
--    row:{…アプリが読む列…}|null, applied:[欄], settled:[欄],
--    conflicts:[{field, server, base, mine, reason:'changed'|'missing'}]}
--   partial ＝ 書けた欄と競合の欄が両方ある。組の相方として止めた欄も、競合した側と同じ reason で返す。
--
-- 実装上の約束（設計書 design-rpc-cas.md「実装上の注意」）:
--   ・volatile（既定）。stable にしない（stable だと PostgREST が読み取り専用の tx で呼び、書けない）
--   ・security invoker（呼んだ職員の権限＝各表の RLS がそのまま効く）。FOR UPDATE は update ポリシー
--     （0001 の update_auth: using (true)）を通る
--   ・自然キーの同時 insert は on conflict … do nothing（部分 unique 索引の推論。where 句は 0001 の
--     索引定義と完全に一致させる）で吸収し、その後 select … for update で取り直す（例外ブロックを使わない）
--   ・動的 SQL を使わない。書ける欄の許可リストは関数本文そのもの。未知の欄は拒否（例外）
--   ・値の比較は列の型にそろえてから行う（temp は numeric(3,1)、血圧・脈拍・SpO2・主食・副食は
--     smallint、測定時刻は time、文字の欄は空文字を null とみなした文字列）
--   ・ロック待ちは statement_timeout で切れる（端末は一時的な失敗として送り直す）。
--     1回の呼び出しで掴む行は1行だけなのでデッドロックは起きない
--
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
--   関数本体の as $fn$ … $fn$ は使ってよい（0005 と同じ）。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

-- 作り直しは同じシグネチャだけを落としてから作る（オーバーロードを作らない）
drop function if exists public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text);

create function public.apply_cell_edits(
  p_table      text,                    -- 'vitals' | 'meals' | 'probe'
  p_key        jsonb,                   -- 行の指し方（上の「行の指し方」）
  p_edits      jsonb,                   -- {欄: {value, base}}。base キー無し＝基準が分からない
  p_fill       jsonb  default '{}',     -- {measured_at, recorded_by}。空いていれば埋める・判定に使わない
  p_editor     bigint default null,     -- edited_by（最後にこの行を書き換えた職員）
  p_client_key text   default null      -- 定時以外のバイタルの冪等キー（p_key.client_key と同じ値）
)
returns jsonb
language plpgsql
volatile
security invoker
-- pg_temp を明示的に末尾へ置き、一時テーブルによる名前の乗っ取りを防ぐ（0005 と同じ）
set search_path = public, pg_temp
as $fn$
declare
  -- 書ける欄の許可リスト（並びは返り値の並び）
  c_vital_fields constant text[] := array['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2', 'measured_at', 'note', 'symptom'];
  c_meal_fields  constant text[] := array['main_amount', 'side_amount', 'status', 'note'];
  v_fields    text[];
  v_fill_ok   text[];
  v_edits     jsonb := coalesce(p_edits, '{}'::jsonb);
  v_fill      jsonb := coalesce(p_fill, '{}'::jsonb);
  v_bad       text;
  v_vrow      vitals%rowtype;
  v_mrow      meals%rowtype;
  v_found     boolean := false;  -- 生きている行（deleted_at is null）を掴んだ
  v_gone      boolean := false;  -- client_key の行は届いているが、取り消されている
  v_inserted  boolean := false;  -- この呼び出しで行を作った
  v_by_id     boolean := false;  -- 行 id で指している（insert しない）
  v_cur       jsonb;             -- 掴んだ行（判定用）
  v_ck        text;
  v_resident  bigint;
  v_day       date;
  v_slot      text;
  v_kind      text;
  v_any_base  boolean := false;  -- 非 null の基準を持つ欄がある
  v_any_value boolean := false;  -- 非 null の値を持つ欄がある（insert するか）
  v_missing   boolean := false;
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
  v_try       int;
begin
  -- 関数が当たっているかの確認（アプリの起動時・入力解禁の確認と同時に呼ぶ）
  if p_table = 'probe' then
    return jsonb_build_object('version', 1, 'status', 'probe');
  end if;

  -- ---------- 引数の検査（エラー文は何が起きたか＋次にどうするか。個人情報は含めない） ----------
  if p_table = 'vitals' then
    v_fields := c_vital_fields;
    v_fill_ok := array['measured_at', 'recorded_by'];
  elsif p_table = 'meals' then
    v_fields := c_meal_fields;
    v_fill_ok := array['recorded_by'];
  else
    raise exception '保存先を読み取れませんでした（%）。アプリを再読み込みしてからもう一度お試しください', p_table
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_key) is distinct from 'object'
     or jsonb_typeof(v_edits) <> 'object'
     or jsonb_typeof(v_fill) <> 'object' then
    raise exception '保存する内容を読み取れませんでした。アプリを再読み込みしてからもう一度お試しください'
      using errcode = '22023';
  end if;
  select k into v_bad from jsonb_object_keys(v_edits) as k where k <> all (v_fields) limit 1;
  if v_bad is not null then
    raise exception '保存できない欄です（%）。アプリを再読み込みしてからもう一度お試しください', v_bad
      using errcode = '22023';
  end if;
  select k into v_bad from jsonb_object_keys(v_fill) as k where k <> all (v_fill_ok) limit 1;
  if v_bad is not null then
    raise exception '保存できない付随の欄です（%）。アプリを再読み込みしてからもう一度お試しください', v_bad
      using errcode = '22023';
  end if;
  foreach f in array v_fields loop
    continue when not (v_edits ? f);
    e := v_edits -> f;
    if jsonb_typeof(e) <> 'object' or not (e ? 'value') then
      raise exception '欄の値を読み取れませんでした（%）。アプリを再読み込みしてからもう一度お試しください', f
        using errcode = '22023';
    end if;
    if nullif(e ->> 'value', '') is not null then v_any_value := true; end if;
    if nullif(e ->> 'base', '') is not null then v_any_base := true; end if;
  end loop;
  if p_key ? 'client_key' and p_client_key is not null and (p_key ->> 'client_key') is distinct from p_client_key then
    raise exception '冪等キーが食い違っています。アプリを再読み込みしてからもう一度お試しください'
      using errcode = '22023';
  end if;

  -- ---------- 行を掴む（無ければ作る） ----------
  if p_table = 'vitals' then
    v_ck := nullif(coalesce(p_key ->> 'client_key', p_client_key), '');
    if p_key ? 'id' then
      -- 行 id で指す: 既にある行（定時以外）の更新だけ。行が無くても作らない
      v_by_id := true;
      select * into v_vrow from vitals
       where id = (p_key ->> 'id')::bigint and deleted_at is null
       for update;
      v_found := found;
    elsif v_ck is not null then
      -- 定時以外（再検・発熱者・他症状者）: 端末が付けた冪等キーで1行に収める
      v_resident := (p_key ->> 'resident_id')::bigint;
      v_day := (p_key ->> 'measured_on')::date;
      v_kind := p_key ->> 'kind';
      if v_resident is null or v_day is null or v_kind is null or v_kind not in ('recheck', 'observation', 'symptom') then
        raise exception '記録の行を特定できませんでした。アプリを再読み込みしてからもう一度お試しください'
          using errcode = '22023';
      end if;
      for v_try in 1..2 loop
        -- deleted_at を問わない（取り消されていても「届いた」証拠。作り直さない）
        select * into v_vrow from vitals where client_key = v_ck for update;
        if found then
          -- 同じキーで別の利用者・日・種別の行を書き換えない（端末の取り違えを止める）
          if v_vrow.resident_id <> v_resident or v_vrow.measured_on <> v_day or v_vrow.kind <> v_kind then
            raise exception '冪等キーが別の記録を指しています。アプリを再読み込みしてからもう一度お試しください'
              using errcode = '22023';
          end if;
          v_found := v_vrow.deleted_at is null;
          v_gone := not v_found;
          exit;
        end if;
        exit when v_any_base or not v_any_value;  -- 基準のある編集・値の無い編集では行を作らない
        insert into vitals (
          client_key, resident_id, measured_on, kind,
          temp, sys_bp, dia_bp, pulse, spo2, measured_at, note, symptom,
          recorded_by, edited_by
        ) values (
          v_ck, v_resident, v_day, v_kind,
          case when v_edits ? 'temp'   then nullif(v_edits -> 'temp'   ->> 'value', '')::numeric(3,1) end,
          case when v_edits ? 'sys_bp' then nullif(v_edits -> 'sys_bp' ->> 'value', '')::smallint end,
          case when v_edits ? 'dia_bp' then nullif(v_edits -> 'dia_bp' ->> 'value', '')::smallint end,
          case when v_edits ? 'pulse'  then nullif(v_edits -> 'pulse'  ->> 'value', '')::smallint end,
          case when v_edits ? 'spo2'   then nullif(v_edits -> 'spo2'   ->> 'value', '')::smallint end,
          case when v_edits ? 'measured_at' then nullif(v_edits -> 'measured_at' ->> 'value', '')::time
               else nullif(v_fill ->> 'measured_at', '')::time end,
          case when v_edits ? 'note'    then nullif(v_edits -> 'note'    ->> 'value', '') end,
          case when v_edits ? 'symptom' then nullif(v_edits -> 'symptom' ->> 'value', '') end,
          nullif(v_fill ->> 'recorded_by', '')::bigint,
          p_editor
        )
        on conflict (client_key) do nothing
        returning * into v_vrow;
        if found then
          v_inserted := true;
          v_found := true;
          exit;
        end if;
        -- 他の送信（同じ端末の再送・別タブ）が先に作った。次の周回で取り直す
      end loop;
    else
      -- 定時: 1名1日1行（部分 unique 索引 uq_vitals_routine_day）
      v_resident := (p_key ->> 'resident_id')::bigint;
      v_day := (p_key ->> 'measured_on')::date;
      if v_resident is null or v_day is null then
        raise exception '記録の行を特定できませんでした。アプリを再読み込みしてからもう一度お試しください'
          using errcode = '22023';
      end if;
      for v_try in 1..2 loop
        select * into v_vrow from vitals
         where resident_id = v_resident and measured_on = v_day and kind = 'routine' and deleted_at is null
         for update;
        if found then
          v_found := true;
          exit;
        end if;
        exit when v_any_base or not v_any_value;
        insert into vitals (
          resident_id, measured_on, kind,
          temp, sys_bp, dia_bp, pulse, spo2, measured_at, note, symptom,
          recorded_by, edited_by
        ) values (
          v_resident, v_day, 'routine',
          case when v_edits ? 'temp'   then nullif(v_edits -> 'temp'   ->> 'value', '')::numeric(3,1) end,
          case when v_edits ? 'sys_bp' then nullif(v_edits -> 'sys_bp' ->> 'value', '')::smallint end,
          case when v_edits ? 'dia_bp' then nullif(v_edits -> 'dia_bp' ->> 'value', '')::smallint end,
          case when v_edits ? 'pulse'  then nullif(v_edits -> 'pulse'  ->> 'value', '')::smallint end,
          case when v_edits ? 'spo2'   then nullif(v_edits -> 'spo2'   ->> 'value', '')::smallint end,
          case when v_edits ? 'measured_at' then nullif(v_edits -> 'measured_at' ->> 'value', '')::time
               else nullif(v_fill ->> 'measured_at', '')::time end,
          case when v_edits ? 'note'    then nullif(v_edits -> 'note'    ->> 'value', '') end,
          case when v_edits ? 'symptom' then nullif(v_edits -> 'symptom' ->> 'value', '') end,
          nullif(v_fill ->> 'recorded_by', '')::bigint,
          p_editor
        )
        -- 0001 の uq_vitals_routine_day と同じ where 句（部分索引の推論に必要）
        on conflict (resident_id, measured_on) where kind = 'routine' and deleted_at is null do nothing
        returning * into v_vrow;
        if found then
          v_inserted := true;
          v_found := true;
          exit;
        end if;
        -- 他の端末が同時に同じ利用者・日の行を作った（その tx の確定を待ってから何もしなかった）。
        -- 次の周回でその行を掴み直し、欄ごとに判定する
      end loop;
    end if;
    if v_found or v_gone then v_cur := to_jsonb(v_vrow); end if;
  else
    -- 食事: 1名1日1コマ1行（部分 unique 索引 uq_meals_slot）
    if p_key ? 'id' or p_key ? 'client_key' then
      raise exception '食事の行は利用者・日付・食事枠で指定してください。アプリを再読み込みしてからもう一度お試しください'
        using errcode = '22023';
    end if;
    v_resident := (p_key ->> 'resident_id')::bigint;
    v_day := (p_key ->> 'meal_on')::date;
    v_slot := p_key ->> 'meal_slot';
    if v_resident is null or v_day is null or v_slot is null or v_slot not in ('breakfast', 'lunch', 'dinner', 'snack') then
      raise exception '記録の行を特定できませんでした。アプリを再読み込みしてからもう一度お試しください'
        using errcode = '22023';
    end if;
    for v_try in 1..2 loop
      select * into v_mrow from meals
       where resident_id = v_resident and meal_on = v_day and meal_slot = v_slot and deleted_at is null
       for update;
      if found then
        v_found := true;
        exit;
      end if;
      exit when v_any_base or not v_any_value;
      insert into meals (
        resident_id, meal_on, meal_slot,
        main_amount, side_amount, status, note,
        recorded_by, edited_by
      ) values (
        v_resident, v_day, v_slot,
        case when v_edits ? 'main_amount' then nullif(v_edits -> 'main_amount' ->> 'value', '')::smallint end,
        case when v_edits ? 'side_amount' then nullif(v_edits -> 'side_amount' ->> 'value', '')::smallint end,
        case when v_edits ? 'status'      then nullif(v_edits -> 'status'      ->> 'value', '') end,
        case when v_edits ? 'note'        then nullif(v_edits -> 'note'        ->> 'value', '') end,
        nullif(v_fill ->> 'recorded_by', '')::bigint,
        p_editor
      )
      -- 0001 の uq_meals_slot と同じ where 句（部分索引の推論に必要）
      on conflict (resident_id, meal_on, meal_slot) where deleted_at is null do nothing
      returning * into v_mrow;
      if found then
        v_inserted := true;
        v_found := true;
        exit;
      end if;
    end loop;
    if v_found then v_cur := to_jsonb(v_mrow); end if;
  end if;

  -- 作ってよい編集なのに2周しても行を掴めなかった（作った直後に取り消された等のごく短い隙間）。
  -- 一時的な失敗として返し、端末に送り直させる（何も書いていない）
  if not v_found and not v_gone and not v_by_id and not v_any_base and v_any_value then
    raise exception '他の端末と同時に保存したため、もう一度送ります' using errcode = '40001';
  end if;
  -- 生きている行が無い: 基準のある編集・行 id で指した編集は、取り消された行への編集として全欄を競合にする
  v_missing := not v_found and not v_gone and (v_any_base or v_by_id);

  -- ---------- 欄ごとの判定（列の型にそろえた文字列どうしで比べる） ----------
  foreach f in array v_fields loop
    continue when not (v_edits ? f);
    e := v_edits -> f;
    c_mine := case
      when f = 'temp' then (nullif(e ->> 'value', '')::numeric(3,1))::text
      when f = 'measured_at' then (nullif(e ->> 'value', '')::time)::text
      when f in ('note', 'symptom', 'status') then nullif(e ->> 'value', '')
      else (nullif(e ->> 'value', '')::smallint)::text
    end;
    c_base := case
      when f = 'temp' then (nullif(e ->> 'base', '')::numeric(3,1))::text
      when f = 'measured_at' then (nullif(e ->> 'base', '')::time)::text
      when f in ('note', 'symptom', 'status') then nullif(e ->> 'base', '')
      else (nullif(e ->> 'base', '')::smallint)::text
    end;
    c_srv := case
      when v_cur is null then null
      when f = 'temp' then (nullif(v_cur ->> f, '')::numeric(3,1))::text
      when f = 'measured_at' then (nullif(v_cur ->> f, '')::time)::text
      when f in ('note', 'symptom', 'status') then nullif(v_cur ->> f, '')
      else (nullif(v_cur ->> f, '')::smallint)::text
    end;

    if v_inserted then
      -- この呼び出しで作った行: 値のある欄は書けた、空の欄は何もしていない
      if c_mine is null then v_settled := v_settled || f; else v_write := v_write || f; end if;
    elsif v_missing then
      v_conf := v_conf || f;
      v_reason := v_reason || jsonb_build_object(f, 'missing');
    elsif v_gone then
      -- 届いた後に取り消された行: 同じ値なら届いている（作り直さない）、違えば取り消された行への編集
      if not v_any_base and c_srv is not distinct from c_mine then
        v_settled := v_settled || f;
      else
        v_conf := v_conf || f;
        v_reason := v_reason || jsonb_build_object(f, 'missing');
      end if;
    elsif not v_found then
      -- 行が無く、作る必要も無い（値の無い編集だけ）
      v_settled := v_settled || f;
    elsif c_srv is not distinct from c_mine then
      v_settled := v_settled || f;                                     -- ① もう載っている
    elsif (e ? 'base' and c_srv is not distinct from c_base) or (not (e ? 'base') and c_srv is null) then
      v_write := v_write || f;                                         -- ② 基準のまま（基準不明は空の時だけ）
    else
      v_conf := v_conf || f;                                           -- ③ 他の端末が変えた
      v_reason := v_reason || jsonb_build_object(f, 'changed');
    end if;
  end loop;

  -- 血圧の上と下は1つの組: 片方が競合なら、送られてきた相方も書かず・「載っている」ともせずに競合へ
  -- （誰も測っていない組み合わせを作らない。相方が settled で外れると、後の〔自分の値で直す〕が片方だけを送り、
  --  組が割れる＝2026-09-23 第3段 #3。組の判定は settled の判定より優先する）
  if 'sys_bp' = any (v_conf) and v_edits ? 'dia_bp' and not ('dia_bp' = any (v_conf)) then
    v_write := array_remove(v_write, 'dia_bp');
    v_settled := array_remove(v_settled, 'dia_bp');
    v_conf := v_conf || 'dia_bp'::text;
    v_reason := v_reason || jsonb_build_object('dia_bp', v_reason ->> 'sys_bp');
  elsif 'dia_bp' = any (v_conf) and v_edits ? 'sys_bp' and not ('sys_bp' = any (v_conf)) then
    v_write := array_remove(v_write, 'sys_bp');
    v_settled := array_remove(v_settled, 'sys_bp');
    v_conf := v_conf || 'sys_bp'::text;
    v_reason := v_reason || jsonb_build_object('sys_bp', v_reason ->> 'dia_bp');
  end if;

  -- ---------- 書く（1欄でも書く時だけ。作った行はもう書けている） ----------
  if not v_inserted and v_found and cardinality(v_write) > 0 then
    if p_table = 'vitals' then
      update vitals set
        temp        = case when 'temp'   = any (v_write) then nullif(v_edits -> 'temp'   ->> 'value', '')::numeric(3,1) else temp end,
        sys_bp      = case when 'sys_bp' = any (v_write) then nullif(v_edits -> 'sys_bp' ->> 'value', '')::smallint else sys_bp end,
        dia_bp      = case when 'dia_bp' = any (v_write) then nullif(v_edits -> 'dia_bp' ->> 'value', '')::smallint else dia_bp end,
        pulse       = case when 'pulse'  = any (v_write) then nullif(v_edits -> 'pulse'  ->> 'value', '')::smallint else pulse end,
        spo2        = case when 'spo2'   = any (v_write) then nullif(v_edits -> 'spo2'   ->> 'value', '')::smallint else spo2 end,
        -- 測定時刻: 利用者が書いた時はその値。編集として送られて書かなかった時（競合・同じ値）は触らない。
        -- 編集に無い時だけ、空いていれば p_fill で埋める
        measured_at = case when 'measured_at' = any (v_write) then nullif(v_edits -> 'measured_at' ->> 'value', '')::time
                           when v_edits ? 'measured_at' then measured_at
                           else coalesce(measured_at, nullif(v_fill ->> 'measured_at', '')::time) end,
        note        = case when 'note'    = any (v_write) then nullif(v_edits -> 'note'    ->> 'value', '') else note end,
        symptom     = case when 'symptom' = any (v_write) then nullif(v_edits -> 'symptom' ->> 'value', '') else symptom end,
        recorded_by = coalesce(recorded_by, nullif(v_fill ->> 'recorded_by', '')::bigint),
        edited_by   = p_editor
      where id = v_vrow.id
      returning * into v_vrow;
    else
      update meals set
        main_amount = case when 'main_amount' = any (v_write) then nullif(v_edits -> 'main_amount' ->> 'value', '')::smallint else main_amount end,
        side_amount = case when 'side_amount' = any (v_write) then nullif(v_edits -> 'side_amount' ->> 'value', '')::smallint else side_amount end,
        status      = case when 'status'      = any (v_write) then nullif(v_edits -> 'status'      ->> 'value', '') else status end,
        note        = case when 'note'        = any (v_write) then nullif(v_edits -> 'note'        ->> 'value', '') else note end,
        recorded_by = coalesce(recorded_by, nullif(v_fill ->> 'recorded_by', '')::bigint),
        edited_by   = p_editor
      where id = v_mrow.id
      returning * into v_mrow;
    end if;
  end if;

  -- ---------- 返り値 ----------
  foreach f in array v_fields loop
    continue when not (f = any (v_conf));
    e := v_edits -> f;
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
      'field', f,
      'server', case when v_found then v_cur -> f else 'null'::jsonb end,
      'base', coalesce(e -> 'base', 'null'::jsonb),
      'mine', coalesce(e -> 'value', 'null'::jsonb),
      'reason', v_reason ->> f
    ));
  end loop;

  if v_found and p_table = 'vitals' then
    v_row_json := jsonb_build_object(
      'id', v_vrow.id, 'resident_id', v_vrow.resident_id, 'measured_on', v_vrow.measured_on,
      'kind', v_vrow.kind, 'measured_at', v_vrow.measured_at, 'temp', v_vrow.temp,
      'sys_bp', v_vrow.sys_bp, 'dia_bp', v_vrow.dia_bp, 'pulse', v_vrow.pulse, 'spo2', v_vrow.spo2,
      'note', v_vrow.note, 'symptom', v_vrow.symptom, 'recorded_by', v_vrow.recorded_by, 'rev', v_vrow.rev
    );
  elsif v_found then
    v_row_json := jsonb_build_object(
      'id', v_mrow.id, 'resident_id', v_mrow.resident_id, 'meal_on', v_mrow.meal_on,
      'meal_slot', v_mrow.meal_slot, 'main_amount', v_mrow.main_amount, 'side_amount', v_mrow.side_amount,
      'status', v_mrow.status, 'note', v_mrow.note, 'recorded_by', v_mrow.recorded_by, 'rev', v_mrow.rev
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

comment on function public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text) is
  'バイタル・食事の欄ごとの compare-and-set（行ロックの下で判定と書き込み）。security invoker・authenticated 限定。';

-- ---------------------------------------------------------------------
-- 実行権限: PUBLIC の既定 EXECUTE を剥がし、anon を明示 revoke・authenticated に grant。
-- （0002・0005 と同じ手順。do ブロックでのロール存在判定は使わない）
-- ---------------------------------------------------------------------
revoke all     on function public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text) from public;
revoke execute on function public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text) from anon;
grant  execute on function public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text) to   authenticated;

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST202 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) 権限: anon が false・authenticated が true
--    select has_function_privilege('anon',          'public.apply_cell_edits(text,jsonb,jsonb,jsonb,bigint,text)', 'execute') as anon_exec,
--           has_function_privilege('authenticated', 'public.apply_cell_edits(text,jsonb,jsonb,jsonb,bigint,text)', 'execute') as auth_exec;
--
-- 2) security invoker・volatile であること（prosecdef = false・provolatile = 'v'）
--    select proname, prosecdef, provolatile, proconfig from pg_proc
--     where pronamespace = 'public'::regnamespace and proname = 'apply_cell_edits';
--
-- 3) 生存確認（アプリが起動時に呼ぶ形）
--    select public.apply_cell_edits('probe', '{}', '{}');
--    → {"status": "probe", "version": 1}
--
-- 4) 未知の欄は拒否されること（例外「保存できない欄です」）
--    select public.apply_cell_edits('vitals', '{"resident_id": 1, "measured_on": "2000-01-01"}',
--                                   '{"rev": {"value": 9}}');
--
-- ロールバック（この RPC を取り除く。業務データには影響しない。新版アプリは入力を止めて待つ）:
--    drop function if exists public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text);
-- ---------------------------------------------------------------------
