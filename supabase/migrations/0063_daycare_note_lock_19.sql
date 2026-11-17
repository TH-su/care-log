-- =====================================================================
-- 0063: デイの申し送りの欄のロックを 17:00 から 19:00 にする（2026-11-17 本人指示）
--
-- 0033 の private.note_lock_at の本文だけを置き換える（create or replace）。冪等。表・列・データ・トリガ・権限には触れない。
-- ロックの時刻（日本時間・行の note_on＝記録日 X に対して）:
--   日勤（shift='day' かつ after16=false）… X の 17:00（変えない）
--   デイ（shift='daycare'）             … X の 19:00（17:00 から変える）
--   16時以降（shift='day' かつ after16=true）… X+1 の 0:00（変えない）
--   夜勤（shift='night'）               … X+1 の 8:00（変えない）
--   サーバーの判定だけ 30分の猶予を足すのは 0033 のまま（notes_lock_guard は変えない）。画面の判定 src/lib/noteLock.ts も同じ規則。
--
-- 旧クライアント×新サーバー: 旧版の画面は 17:00 でデイの欄を読み取り専用にする（サーバーは 19:30 まで受ける）。書けない時間が
--   伸びるだけで、書いた記録が消えることはない。新クライアント×旧サーバー: 17:30〜19:00 に書いたデイの記録はサーバーが断り、
--   送信待ちは止まった記録として残る（消えない）。適用の順: DB 先 → アプリ。
-- 戻し方: supabase/rollback/0063_back.sql（0033 の本文に戻す）
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

create or replace function private.note_lock_at(p_day date, p_shift text, p_after16 boolean)
returns timestamptz
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select case
    when p_day is null or p_shift is null then null
    -- 夜勤: 翌朝 8:00
    when p_shift = 'night' then ((p_day + 1) + time '08:00') at time zone 'Asia/Tokyo'
    -- デイ: 当日 19:00（0063）
    when p_shift = 'daycare' then (p_day + time '19:00') at time zone 'Asia/Tokyo'
    -- 16時以降: 日付が変わった時（翌 0:00）
    when p_shift = 'day' and coalesce(p_after16, false) then ((p_day + 1) + time '00:00') at time zone 'Asia/Tokyo'
    -- 日勤（16時前）: 当日 17:00
    else (p_day + time '17:00') at time zone 'Asia/Tokyo'
  end
$fn$;

comment on function public.notes_lock_guard() is
  '申し送りの時間によるロック（現場のログインだけ。日勤 17:00／デイ 19:00（0063）／16時以降 24:00／夜勤 翌8:00＋猶予30分・日本時間。継続の終了だけの更新は止めない）。止めた時は P0001・note_locked: …。0033・0063。';

-- 確かめ（1行）: デイは 19:00・日勤は 17:00 のまま
select '0063 デイのロックは 19:00・日勤は 17:00' as what,
       case when private.note_lock_at(date '2026-11-01', 'daycare', false) = timestamptz '2026-11-01 19:00:00+09'
             and private.note_lock_at(date '2026-11-01', 'daycare', true)  = timestamptz '2026-11-01 19:00:00+09'
             and private.note_lock_at(date '2026-11-01', 'day', false)     = timestamptz '2026-11-01 17:00:00+09'
             and private.note_lock_at(date '2026-11-01', 'day', true)      = timestamptz '2026-11-02 00:00:00+09'
             and private.note_lock_at(date '2026-11-01', 'night', false)   = timestamptz '2026-11-02 08:00:00+09'
            then 'ok' else 'NG' end as result;
