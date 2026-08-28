-- =====================================================================
-- 0005: 食事一覧（横並び）の水分を「1名1日 = 1行」で返す RPC（meals_sheet_fluids）
--
-- 適用方法: Supabase ダッシュボード > SQL Editor に、0001 → 0002 → 0003 → 0004 を
--           実行した後でこのファイルの内容を貼り付けて実行する（冪等・何度実行してもよい）。
--           作るのは関数だけで、テーブル・列・データには一切触れない。
--
-- 背景（docs/design/sheet-contracts.md §7・qa-verification.md「1リクエストの行数 ≤2,000」）:
--   食事一覧の既定は11日表示で、水分は「1回の飲水 = 1行」で貯まる。
--   本プロジェクトの規模モデル（利用者33名・水分135〜165件/日）では
--   11日分の生の行数が 1,485〜1,815 行になり、1リクエストの上限 2,000 行の 74〜91% を
--   水分だけで占める。利用者が増える・水分記録の粒度が上がるだけで上限に達し、
--   食事一覧が「部分的に欠けた表」ではなく画面ごとエラーになって開けなくなる。
--
--   画面が水分に求めるのは
--     ・セルに出す1名1日の合計
--     ・セルをタップした時に出す内訳（時刻と量）
--   の2つだけで、行を1件ずつ横に並べるわけではない。
--   そこで「1名1日 = 1行」へまとめ、内訳は同じ行の jsonb に畳んで返す。
--   取得行数は 人数 × 日数（33名 × 11日 = 363行）になり、上限に対する占有率は 18% まで下がる
--   ＝上限に達するのは 181名（11日表示）以降。内訳を落とさないので画面の見え方は変わらない。
--
-- 返り値（1行 = 1名1日）:
--   resident_id … 利用者
--   taken_on    … 業務日付
--   total_ml    … その日の合計（内訳の合計と一致する。画面は内訳から出しても同じ値になる）
--   entries     … 内訳の配列 [{ id, taken_at, amount_ml, kind, recorded_by, rev }, ...]
--                 時刻昇順（時刻なしは後ろ）→ id 昇順。
--                 resident_id / taken_on は親の行に入っているので内訳では繰り返さない
--                 （src/lib/db.ts が親の値を補って FluidIntake に戻す）。
--
-- 権限・全件ロード禁止の担保は 0002_timeline_rpc.sql と同じ:
--   security invoker（各表の RLS がそのまま効く）／PUBLIC の既定 EXECUTE を剥がす／
--   anon revoke・authenticated grant／両端のある日付レンジ必須・期間上限あり。
--
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

-- 既存版がある場合は同一シグネチャのものだけを落としてから作り直す
-- （create or replace は返り値型の変更を受け付けないため、再実行可能性のために置く）。
drop function if exists public.meals_sheet_fluids(date, date);

create or replace function public.meals_sheet_fluids(
  p_from date,
  p_to   date
)
returns table (
  resident_id bigint,
  taken_on    date,
  total_ml    int,
  entries     jsonb
)
language plpgsql
stable
security invoker
-- pg_temp を明示的に末尾へ置き、一時テーブルによる名前の乗っ取りを防ぐ
set search_path = public, pg_temp
as $fn$
declare
  c_max_span_days constant int := 100;  -- 1回で取得できる最大日数（食事一覧の既定は11日）
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

  return query
  select f.resident_id,
         f.taken_on,
         coalesce(sum(f.amount_ml), 0)::int as total_ml,
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',          f.id,
               'taken_at',    f.taken_at,
               'amount_ml',   f.amount_ml,
               'kind',        f.kind,
               'recorded_by', f.recorded_by,
               'rev',         f.rev
             )
             order by f.taken_at asc nulls last, f.id asc
           ),
           '[]'::jsonb
         ) as entries
    from fluid_intake f
   where f.deleted_at is null            -- soft delete 済みは返さない（読取の機械付与と同じ）
     and f.taken_on between p_from and p_to
   group by f.resident_id, f.taken_on
   order by f.taken_on desc, f.resident_id asc;  -- 新しい日が左（sheet-contracts §6・§7）
end;
$fn$;

comment on function public.meals_sheet_fluids(date, date) is
  '食事一覧の水分を1名1日=1行（合計＋内訳jsonb）で返す。security invoker・authenticated 限定。';

-- ---------------------------------------------------------------------
-- 実行権限: PUBLIC の既定 EXECUTE を剥がし、anon を明示 revoke・authenticated に grant。
-- （0002 と同じ手順。do ブロックでのロール存在判定は Supabase SQL Editor が PL/pgSQL を
--   誤解釈して失敗した実績があるため使わない）
-- ---------------------------------------------------------------------
revoke all     on function public.meals_sheet_fluids(date, date) from public;
revoke execute on function public.meals_sheet_fluids(date, date) from anon;
grant  execute on function public.meals_sheet_fluids(date, date) to   authenticated;

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST202 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 検証（SQL Editor で実行して確認する）
--
-- 1) 権限: anon が false・authenticated が true になること
--    select has_function_privilege('anon',          'public.meals_sheet_fluids(date,date)', 'execute') as anon_exec,
--           has_function_privilege('authenticated', 'public.meals_sheet_fluids(date,date)', 'execute') as auth_exec;
--
-- 2) security invoker であること（prosecdef が false）
--    select proname, prosecdef, provolatile, proconfig from pg_proc
--     where pronamespace = 'public'::regnamespace and proname = 'meals_sheet_fluids';
--
-- 3) 行数が「人数 × 日数」に収まること（11日表示の既定）
--    select count(*) from public.meals_sheet_fluids(current_date - 10, current_date);
--    → 生の行数（select count(*) from fluid_intake
--                  where deleted_at is null and taken_on between current_date - 10 and current_date）
--      よりはっきり少ないこと
--
-- 4) 合計と内訳が食い違わないこと（0行）
--    select count(*) from public.meals_sheet_fluids(current_date - 10, current_date) x
--     where x.total_ml <> (select coalesce(sum((e->>'amount_ml')::int), 0)
--                            from jsonb_array_elements(x.entries) e);
--
-- 5) 期間ガード（例外になること）
--    select * from public.meals_sheet_fluids(current_date - 200, current_date);  -- 「取得期間が長すぎます」
--    select * from public.meals_sheet_fluids(current_date, current_date - 1);    -- 「期間の指定が逆になっています」
--
-- 6) 実行計画（Seq Scan が出ないこと。関数の EXPLAIN では内側が見えないため本体を直接見る）
--    explain (analyze, buffers)
--    select resident_id, taken_on, sum(amount_ml) from fluid_intake
--     where deleted_at is null and taken_on between current_date - 10 and current_date
--     group by 1, 2;
--
-- ロールバック（この RPC を取り除く。業務データには影響しない）:
--    drop function if exists public.meals_sheet_fluids(date, date);
-- ---------------------------------------------------------------------
