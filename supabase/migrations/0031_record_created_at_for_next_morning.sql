-- =====================================================================
-- 0031: タイムライン（timeline_chunk）と食事一覧の水分（meals_sheet_fluids）が
--       行の作成時刻 created_at を返すようにする（F34・2026-10-10 本人裁定「夜勤明けに前日の欄へ書いた記録は『翌』を付けて
--       夜の記録の後ろに並べる」の判定に使う）
--
-- 0001〜0030 を当てたあとに実行する。冪等。テーブル・列・データには触れない（created_at は 0001 からある列）。
-- timeline_chunk は 0030 と同じ名前・引数・返り値で create or replace（本文は 0030 に created_at を4か所足しただけ）。
-- meals_sheet_fluids は 0005 と同じ名前・引数・返り値で create or replace（entries の各要素に created_at を足しただけ。
-- 返り値の列は変わらないので drop しない）。
--
-- なぜ: 「翌」は「時刻が 9 時より前・作成時刻が記録日の翌日の 0:00〜9:10」で決める（src/lib/nextMorning.ts）。
--   日報・カルテ・検索・一覧のバイタル／申し送りは表を直接読むので created_at を読めるが、この2つの RPC は返さない。
--   未適用の間、タイムラインと食事一覧の水分の内訳では「翌」が付かず、夜勤明けに前日の列へ書いた水分が「2:00」として
--   その日の先頭に並ぶ。**アプリの公開より先に当てる**。
-- 旧クライアント×新サーバー: 知らない列を正規化で捨てるだけ。新クライアント×旧サーバー: 作成時刻なし＝「翌」なし。
-- ★ do $$ … $$ のブロックは使わない。個人情報を書かない。
-- =====================================================================

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
               n.ongoing, n.ended_at, n.ended_by, n.color, n.reporter_id, n.rev, n.created_at,
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
               n.ongoing, n.ended_at, n.ended_by, n.color, n.reporter_id, n.rev, n.created_at,
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
  'タイムライン10日チャンクを1往復で返す（notes は既読を read_count/my_read に畳み込み。notes・pinned に ended_by＝0030。notes・pinned・vitals・fluids に created_at＝0031）。security invoker・authenticated 限定。';

-- 実行権限（0002 と同じ。create or replace は権限を保つが、単独で流しても同じ状態になるよう明示する）


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
               'rev',         f.rev,
               'created_at',  f.created_at
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
  '食事一覧の水分を1名1日=1行（合計・内訳）で返す。内訳に created_at＝0031。';

revoke all     on function public.meals_sheet_fluids(date, date) from public;
revoke execute on function public.meals_sheet_fluids(date, date) from anon;
grant  execute on function public.meals_sheet_fluids(date, date) to   authenticated;
revoke all on function public.timeline_chunk(date, date, bigint) from public;
revoke execute on function public.timeline_chunk(date, date, bigint) from anon;
grant execute on function public.timeline_chunk(date, date, bigint) to authenticated;

notify pgrst, 'reload schema';

-- 適用後の確認:
--   select jsonb_object_keys(v) from jsonb_array_elements(public.timeline_chunk(current_date - 9, current_date, null) -> 'vitals') v limit 20;
--   select jsonb_object_keys(e) from public.meals_sheet_fluids(current_date - 3, current_date) x, jsonb_array_elements(x.entries) e limit 10;
--   → どちらにも created_at が出る
-- 戻す時: 0030 と 0005 の関数の部分を流し直す（業務データには影響しない）
