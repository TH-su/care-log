-- =====================================================================
-- 0002: タイムライン1往復取得の RPC（timeline_chunk）
--   適用方法: Supabase ダッシュボード > SQL Editor に、0001_init.sql を実行した後で
--             このファイルの内容を貼り付けて実行する（冪等・何度実行してもよい）
--
-- 背景（docs/design/db-design.md §2・qa-verification.md 監査#5）:
--   タイムラインの1日を構成するのは notes / note_reads / vitals / meals / fluid_intake /
--   outings / import_days の7種。素朴に別々の SELECT で取ると、既読（note_reads）だけで
--   10日チャンクあたり約3,400行がそのまま流れ、往復回数もデータ量も無駄になる。
--   本 RPC は10日チャンク分を1往復で返し、既読は notes 側へ read_count・my_read として
--   畳み込む（行を返さない）。
--
-- 返り値（jsonb・キー名は docs/design/contracts.md の凍結契約どおり）:
--   { from, to, notes, vitals, meals, fluids, outings, import_days, pinned }
--   ・notes … 期間内の申し送り（read_count = 既読人数 / my_read = p_staff_id が既読か）
--   ・pinned … 期間内に有効な継続（ongoing）申し送り。開始日が期間より前のものを拾うための枠。
--              開始日が期間内のものは notes にも含まれる（重複は意図的。表示側でピン留め枠と
--              通常リストの両方に出せるようにするため）
--   ・fluids … fluid_intake 表。列名は src/lib/types.ts の型どおり
--   ・import_days … 「記録なし（行あり0件）」と「未取込（行なし）」を画面で区別するための台帳
--   ・列は types.ts の型に載っている列だけを返す（import_key・raw_flags・監査列は返さない）
--   ・soft delete 済み（deleted_at is not null）の行は全系列で除外する
--
-- 権限（db-design.md §4）:
--   security invoker（＝呼び出したユーザーの権限で実行＝各表の RLS がそのまま効く）。
--   PUBLIC の既定 EXECUTE を剥がし、anon から revoke・authenticated へ grant する。
--
-- 全件ロード禁止の担保:
--   全系列を「両端のある日付レンジ」で絞る。期間の上限（100日）を超える呼び出しは例外にする。
--   継続申し送り（pinned）と外出・外泊（outings）は期間より前に始まった行を拾う必要があるため、
--   遡りを 60日 に限る（ui-design.md §3 のタイムライン保持上限60日と揃える）。
--   ただし「まだ終了していない継続（ongoing かつ ended_at is null）」だけは遡り上限を掛けない。
--   契約（contracts.md）の pinned は「期間内に有効な ongoing」であり、60日を過ぎても有効な継続は
--   まだ有効だから。ここで落とすと、ピン留め枠にしか無い「継続を終了」ボタンごと画面から消え、
--   終了操作ができない申し送りが毎日残り続ける。件数は「終了していない継続」だけなので有界で、
--   下の部分索引（idx_notes_ongoing_open）で拾うため全件走査にはならない。
--   それより古い「終了済み」の継続はタイムラインに出ないだけで、個人カルテ・検索からは
--   従来どおり到達できる（データは消さない）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 「終了していない継続」を遡り上限なしで拾うための部分索引（冪等）。
-- pinned の where 条件（deleted_at is null / ongoing / ended_at is null）と同じ形にしてあるので、
-- 全件走査ではなくこの索引だけを読む。対象行は「終了していない継続」に限られるため小さい。
-- ---------------------------------------------------------------------
create index if not exists idx_notes_ongoing_open
  on notes (note_on desc, id desc)
  where deleted_at is null and ongoing and ended_at is null;

-- 既存版がある場合は同一シグネチャのものだけを落としてから作り直す。
-- create or replace は引数名・返り値型の変更を受け付けないため、再実行可能性のために置く。
-- （関数は再作成できるオブジェクトであり、業務データには一切触れない）
drop function if exists public.timeline_chunk(date, date, bigint);

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
  c_lookback_days constant int := 60;   -- 終了済みの継続・外出を遡って拾う上限（ui-design §3 の保持上限と同値。
                                        -- 終了していない継続には掛けない＝有効な限りピン留めに出す）
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
               n.ongoing, n.ended_at, n.reporter_id, n.rev,
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
               n.ongoing, n.ended_at, n.reporter_id, n.rev,
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
            -- まだ終了していない継続は「今も有効」なので開始日の遡り上限を掛けない
            n.ended_at is null
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
               v.recorded_by, v.rev
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
               f.recorded_by, f.rev
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
  'タイムライン10日チャンクを1往復で返す（notes は既読を read_count/my_read に畳み込み）。security invoker・authenticated 限定。';

-- ---------------------------------------------------------------------
-- 実行権限: PUBLIC の既定 EXECUTE を剥がし、anon を明示 revoke・authenticated に grant。
-- （anon / authenticated ロールは Supabase に常在。ローカル復元試験の環境ではロールを先に作る
--   ＝ tools/backup の手順書に記載。do ブロックでの存在判定は Supabase SQL Editor が
--   PL/pgSQL を誤解釈して失敗した実績があるため使わない・2026-08-28）
-- ---------------------------------------------------------------------
revoke all on function public.timeline_chunk(date, date, bigint) from public;
revoke execute on function public.timeline_chunk(date, date, bigint) from anon;
grant execute on function public.timeline_chunk(date, date, bigint) to authenticated;

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST202 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 検証（SQL Editor で実行して確認する）
--
-- 1) 権限: anon が false・authenticated が true になること
--    select has_function_privilege('anon',          'public.timeline_chunk(date,date,bigint)', 'execute') as anon_exec,
--           has_function_privilege('authenticated', 'public.timeline_chunk(date,date,bigint)', 'execute') as auth_exec;
--
-- 2) security invoker であること（prosecdef が false）
--    select proname, prosecdef, provolatile, proconfig from pg_proc
--     where pronamespace = 'public'::regnamespace and proname = 'timeline_chunk';
--
-- 3) 返り値の形（7キー＋from/to が揃うこと・データが無くても [] が返ること）
--    select jsonb_object_keys(public.timeline_chunk(current_date - 9, current_date, null)) order by 1;
--
-- 4) 期間ガード（例外になること）
--    select public.timeline_chunk(current_date - 200, current_date, null);  -- → 「取得期間が長すぎます」
--    select public.timeline_chunk(current_date, current_date - 1, null);    -- → 「期間の指定が逆になっています」
--
-- 5) 実行計画（qa-verification.md §合成データ検証）: 関数呼び出しの EXPLAIN では内側の計画が
--    見えないため、内側の各 SELECT を同じ where 条件で個別に EXPLAIN (analyze, buffers) して
--    notes/vitals/meals/fluid_intake に Seq Scan が出ないことを確認する。
--    例: explain (analyze, buffers)
--        select * from vitals where deleted_at is null
--         and measured_on between current_date - 9 and current_date;
--
-- ロールバック（この RPC を取り除く。業務データには影響しない）:
--    drop function if exists public.timeline_chunk(date, date, bigint);
-- ---------------------------------------------------------------------
