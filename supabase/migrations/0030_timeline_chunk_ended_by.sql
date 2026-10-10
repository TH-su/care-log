-- =====================================================================
-- 0030: タイムラインの RPC（timeline_chunk）の申し送り（notes・pinned）に ended_by（継続を終了した職員）を足す
--       （監査 F08 の続き・タイムラインの担当からの依頼・2026-10-10）
--
-- 0001〜0029 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- 0002 の関数を**同じ名前・同じ引数・同じ返り値**で create or replace し直すだけ（drop しない）。
-- 本文は 0002 と同じで、notes と pinned の列に n.ended_by と n.color を足しただけ。テーブル・列・データには触れない。
-- **0002 を流し直したら、このファイルも流し直す**（0002 は drop→create なので、流し直すと ended_by が無い形に戻る）。
--
-- なぜ:
--   タイムラインの継続の〔終了〕は、終了した職員（ended_by）の基準を「行に値がある時だけ」付ける（F08・TimelinePage）。
--   この RPC が ended_by を返していなかったため、タイムラインから読んだ行では基準が付かず、2台目の〔終了〕が
--   「最初の終了を正」として外れる判定（db.ts の lateEndSettled）にしか頼れなかった。0027 の apply_note_edits の返り値の
--   row にも ended_by を足したので、形をそろえる。
--   n.color（行の色・0003）も足す（F09 の手直し・2026-10-10）。端末は削除の「見た行」に色を入れて送り、0027 は見た色と
--   いまの色が違えば取り消さない。この RPC が色を返さないと、タイムラインから読んだ行は「色なし（null）」になり、
--   色の付いた申し送りをタイムラインから消すと、誰も触っていないのに毎回「他の端末で先に変更」で止まった。
--   タイムラインの画面は色を描かない（表示は変わらない）。
--
-- 旧クライアント×新サーバー: 旧版は返り値の行の知らない列（ended_by）を読まないだけ（正規化で捨てる）。データは消えない。
-- 新クライアント×旧サーバー: 行に ended_by が無い＝「分からない」として扱う（types.ts の Note.ended_by の注記・従来どおり）。
--
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
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
               n.ongoing, n.ended_at, n.ended_by, n.color, n.reporter_id, n.rev,
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
               n.ongoing, n.ended_at, n.ended_by, n.color, n.reporter_id, n.rev,
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
  'タイムライン10日チャンクを1往復で返す（notes は既読を read_count/my_read に畳み込み。notes・pinned に ended_by＝0030）。security invoker・authenticated 限定。';

-- 実行権限（0002 と同じ。create or replace は権限を保つが、単独で流しても同じ状態になるよう明示する）
revoke all on function public.timeline_chunk(date, date, bigint) from public;
revoke execute on function public.timeline_chunk(date, date, bigint) from anon;
grant execute on function public.timeline_chunk(date, date, bigint) to authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--   select jsonb_object_keys(n) from jsonb_array_elements(public.timeline_chunk(current_date - 9, current_date, null) -> 'notes') n limit 20;
--   → id・note_on・…・ended_at・ended_by・reporter_id・rev・read_count・my_read（申し送りが1件以上ある時）
--
-- 戻す時（必要な時だけ）: 0002 のファイルをそのまま流し直す（ended_by が無い形に戻る。業務データには影響しない）。
-- ---------------------------------------------------------------------
