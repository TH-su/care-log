-- 0063（デイの申し送りのロックを 19:00）を戻す＝デイも日勤と同じ 17:00 に戻す（0033 の本文）。表・トリガ・権限には触れない。
-- ★ do $$ … $$ のブロックは使わない。何度流しても同じ。

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
    -- 16時以降: 日付が変わった時（翌 0:00）
    when p_shift = 'day' and coalesce(p_after16, false) then ((p_day + 1) + time '00:00') at time zone 'Asia/Tokyo'
    -- 日勤（16時前）・デイ: 当日 17:00
    else (p_day + time '17:00') at time zone 'Asia/Tokyo'
  end
$fn$;

comment on function public.notes_lock_guard() is
  '申し送りの時間によるロック（現場のログインだけ。日勤・デイ 17:00／16時以降 24:00／夜勤 翌8:00＋猶予30分・日本時間。継続の終了だけの更新は止めない）。止めた時は P0001・note_locked: …。0033。';

select '0063 の前の形（デイのロックは 17:00）' as what,
       case when private.note_lock_at(date '2026-11-01', 'daycare', false) = timestamptz '2026-11-01 17:00:00+09'
            then 'ok' else 'NG' end as result;
