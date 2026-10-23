-- =====================================================================
-- 0047: デイ（せせらぎ）の今日の画面の改善 1回目 … 到着・帰宅の自動（定時の処理）・休みの理由「後で」
--       （2026-10-23 代表者の決定・正本は【AI取締役】の 20261023_今日の画面の改善_決定_v1.md の 3 の「1回目」）
--
-- 0001〜0046 を当てたあとに実行する。冪等（何度実行しても同じ結果）。表・列・値・関数・ジョブを足すだけで、既存のデータは消さない。
-- 足すもの:
--   1. app_settings: auto_enabled_daycare_attendance（値 'false'。既にあれば触らない）
--        自動の到着・帰宅だけを止める旗。true にするまで定時の処理は何も書かない。デイの入力の旗 input_enabled_daycare も見る
--        （0015 の与薬・入浴の自動と同じく、入力が封鎖されている間は自動で書かない）
--   2. daycare_attendance.arrived_auto・left_auto（boolean・既定 false）… 定時の処理が入れた到着・帰宅の印（入浴の auto と同じ考え）
--   3. 印を外すトリガ（daycare_attendance の before insert・update）: 人が時刻を直す・休みにする・取り消すと印を外す。
--        時刻が無いのに印だけがある形を持たない（古い画面・直接の更新でも外れる）
--   4. 関数 private.daycare_auto_plan(日付, テナント) … 0041 の daycare_plan と同じ照合で、その日のデイの予定を返す（読むだけ）。
--        daycare_plan は職員のログイン（JWT のメール）からテナントを決めるため、ログインの無い定時の処理からは読めない。
--        そこでテナントを引数で受ける写しを private に置く（0016 の入浴の自動が予定をテナントの明示で読むのと同じ）。
--        daycare_plan は変えない。同じデータで同じ行を返すことを tests/daycare-auto-contract.mjs で固定する
--   5. 関数 private.daycare_auto_hm(文字) … 予定の時刻（'9:30' のような1桁の時も）を time に。読めなければ null（画面の planHm と同じ）
--   6. 関数 private.daycare_auto_attendance_at(時刻) … その時刻（日本時間）の自動の到着・帰宅の本体。
--        private.daycare_auto_attendance() … 今の時刻で上を呼ぶ（cron が呼ぶ入口）
--   7. cron ジョブ care_auto_daycare_attendance（5分ごと・名前付き＝登録し直しても重複しない）
--
-- 既存に触る点（PR 本文にも書く）:
--   ・daycare_attendance の absent_reason の check（0041 の daycare_attendance_absent_reason_check）を同じ名前で差し替え、
--     選択肢に 'later'（理由は後で）を足す。既存の5つと null はそのまま通る（既存の行は違反しない）
--
-- 自動の到着・帰宅の決まり（決定 3 の 1回目）:
--   ・予定は「その日の予定の写し」（daycare_days・0041）を見る。写しが無い（または読めなかった＝unknown）日は、いまの週間計画を
--     読み、開始の時刻を過ぎた方が初めて出た回に、写しを作ってから記録する（開所の職員は空。daycare_open_day と同じ形の行）。
--     写しがある日は、その写しだけを見る（今日の画面の一覧と、自動で入れる相手を食い違わせない）
--   ・入れる予定: 名簿と照合できた予定（match が mid・name）で、dup でない・外部でない・入院中でない・時刻を読める予定だけ。
--     同じ方に予定が2件以上ある日は、データの誤りとして自動にしない（代表者「そのような日はない」2026-10-23）。時刻を読めない側は入れない
--   ・到着: 開始の時刻を過ぎた方に、開始の時刻で入れる（arrived_auto=true・記入者なし）。その日の生きている行がもうある方
--     （休み・手で押した到着・到着を取り消した＝時刻を消した行）には入れない＝人が記録・取り消した後に作り直さない。
--     取り消し済み（deleted_at）の行は数えない: 行を消すのは、押す前に行が無かった方の休みの直後の〔元に戻す〕だけで
--     （画面の決まり・時刻のある行は消さない）、押す前と同じ「行が無い」形に戻す＝その後も自動で到着を入れる（決定 4）
--   ・帰宅: 到着があり帰宅が無い行（手で押した到着も含む）に、終了の時刻で入れる（left_auto=true）。帰宅は到着の後の時だけ。
--     予定の終了の時刻より後に行が書き換えられていたら入れない（人が帰宅を取り消した・直した後に作り直さない）。
--     定時の処理が止まっていて、終了の後に初めて到着を入れる時は、到着と帰宅を一緒に入れる
--   ・入れない方: 在籍でない方・入居者マスタの写しで入院中の方・外泊の期間中や外出中の方（0015 の与薬の自動と同じ判定。
--     時刻は予定の開始）・デイの休業日（daycare_closed_dates・0016）・予定外の来所（予定が無い方）
--   ・テナントが2つ以上ある時は care_auto_tenant が例外で止める（何も書かない＝0015 と同じ）
--
-- 旧クライアント×新サーバー: 旧版は新しい列を読まない（自動の到着は普通の到着に見える）。旧版で時刻を直すとトリガが印を外す。
--   'later' の休みは旧版では「欠席（理由なし）」に読まれる（normalizeDaycareAttendance が知らない理由を null にする・壊れない）。
--   旧版で理由を選び直すとその理由になる（正しい動き）。
-- 新クライアント×旧サーバー（このファイルを当てる前）: 新しい画面は列が無い（42703・PGRST204）時に列を外して読み直し、
--   印は「無い」として出す。〔休み〕の1タップは 'later' を check が通さない（23514）ので、理由を選ぶ小窓に切り替える（db.ts）。
-- 適用の順: DB 先 → アプリ（旗 auto_enabled_daycare_attendance は false のまま公開）→ 全端末の版を確かめる → min_client_build →
--   旗を true。
-- 戻す時（必要な時だけ）: 旗を 'false' に戻す（記録は残る）。ジョブを止める時は select cron.unschedule('care_auto_daycare_attendance');
--   列・関数・値の追加は戻さない（データを消さない。記録は5年保存）。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 1. 自動の到着・帰宅の旗 ----------
-- 値が無い・'true' 以外は動かない（安全側）。現場で 'true' にした後に再実行しても戻さない
insert into public.app_settings (key, value)
values ('auto_enabled_daycare_attendance', 'false')
on conflict (key) do nothing;

-- ---------- 2. 休みの理由に「後で」（既存に触る点） ----------
-- 0041 の daycare_attendance_absent_reason_check を同じ名前で差し替える（既存の5つと null はそのまま通る）
alter table public.daycare_attendance drop constraint if exists daycare_attendance_absent_reason_check;
alter table public.daycare_attendance add constraint daycare_attendance_absent_reason_check
  check (absent_reason is null or absent_reason in ('condition', 'hospital', 'wish', 'family', 'other', 'later'));

comment on column public.daycare_attendance.absent_reason is
  'condition=体調不良 / hospital=受診・入院 / wish=本人の希望 / family=ご家族の都合 / other=その他 / later=理由は後で（0047・今日の画面の〔休み〕の1タップ）';

-- ---------- 3. 自動の印 ----------
alter table public.daycare_attendance add column if not exists arrived_auto boolean not null default false;
alter table public.daycare_attendance add column if not exists left_auto    boolean not null default false;

comment on column public.daycare_attendance.arrived_auto is
  '定時の処理（0047 の daycare_auto_attendance）が予定の開始の時刻で入れた到着。人が時刻を直す・休みにすると false（トリガ）。';
comment on column public.daycare_attendance.left_auto is
  '定時の処理（0047 の daycare_auto_attendance）が予定の終了の時刻で入れた帰宅。人が時刻を直す・取り消すと false（トリガ）。';

-- ---------- 4. 印を外すトリガ ----------
-- 人が時刻を直すと印を外す（入浴の care_auto_off_on_edit と同じ考え。印は2つあるので専用の関数にする）。
-- ・更新: 印のある側の時刻・欠席・利用者・日が変わったら、その側の印を外す（到着だけ直しても帰宅の印は残す）。取り消し（deleted_at だけ）では外さない
-- ・追加・更新とも: 時刻が無いのに印だけがある形は持たない（休みの日は時刻を持たない＝0041 の check）
-- 印を付けられるのは、定時の処理（追加）と、休みの直後の〔元に戻す〕（時刻と一緒に戻す）だけ（画面の決まり）。
-- before トリガは名前の順に動く（trg_auto_off_… → trg_daycare_attendance_past_guard → trg_updated_…）。印は時刻の守り（0042・0043）に
-- 関わらない（時刻の変わる書き込みは、印の有無にかかわらず 0042 の守りを通る）
create or replace function public.daycare_attendance_auto_off()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'UPDATE' then
    if old.arrived_auto and new.arrived_auto
       and (new.arrived_at is distinct from old.arrived_at
            or new.absent is distinct from old.absent
            or new.resident_id is distinct from old.resident_id
            or new.day is distinct from old.day) then
      new.arrived_auto := false;
    end if;
    if old.left_auto and new.left_auto
       and (new.left_at is distinct from old.left_at
            or new.absent is distinct from old.absent
            or new.resident_id is distinct from old.resident_id
            or new.day is distinct from old.day) then
      new.left_auto := false;
    end if;
  end if;
  if new.arrived_at is null then
    new.arrived_auto := false;
  end if;
  if new.left_at is null then
    new.left_auto := false;
  end if;
  return new;
end
$fn$;

revoke all on function public.daycare_attendance_auto_off() from public, anon, authenticated;

create or replace trigger trg_auto_off_daycare_attendance
  before insert or update on public.daycare_attendance
  for each row execute function public.daycare_attendance_auto_off();

-- ---------- 5. 予定の時刻を time に ----------
-- 画面の planHm（src/lib/daycare.ts）と同じ: 先頭の空白を除き 'H:MM' か 'HH:MM' で始まり、0:00〜23:59 の時だけ。読めなければ null
create or replace function private.daycare_auto_hm(p_text text)
returns time
language sql
immutable
security definer
set search_path = ''
as $fn$
  select case
           when m is null then null
           when m[1]::int > 23 or m[2]::int > 59 then null
           else pg_catalog.make_time(m[1]::int, m[2]::int, 0)
         end
    from (select pg_catalog.regexp_match(coalesce(p_text, ''), '^[[:space:]]*([0-9]{1,2}):([0-9]{2})') as m) x
$fn$;

-- ---------- 6. その日のデイの予定（テナントを引数で受ける写し） ----------
-- 0041 の public.daycare_plan と同じ照合・同じ列・同じ並び。違いはテナントを引数で受けること（private.my_tenant() を使わない）と、
-- security definer（表の所有者の権限＝ログインの無い定時の処理から読める）であることだけ。
-- daycare_plan の照合を変える時は、こちらも同じに変える（tests/daycare-auto-contract.mjs が同じ行を返すことを確かめる）
create or replace function private.daycare_auto_plan(p_date date, p_tenant uuid)
returns table (
  sched_id     text,
  event_id     text,
  resident_id  bigint,
  match        text,
  dup          boolean,
  external     boolean,
  hospitalized boolean,
  start_time   text,
  end_time     text,
  bathing      boolean,
  bath_resident_id bigint,
  plan_rev     integer,
  updated_at   timestamptz
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with src as (
    select k.data, k.updated_at, k.rev
      from public.kv_entries k
     where k.tenant_id = p_tenant
       and k.key = 'care_schedule_v2'
     limit 1
  ),
  ok as (
    select s.data, s.updated_at, s.rev
      from src s
     where (case when pg_catalog.jsonb_typeof(s.data -> 'residents') = 'array'
                 then pg_catalog.jsonb_array_length(s.data -> 'residents') else 0 end) > 0
  ),
  res as (
    select r.ord,
           r.v,
           coalesce(nullif(pg_catalog.btrim(r.v ->> 'id'), ''), '#' || r.ord::text) as sched_id,
           nullif(pg_catalog.btrim(r.v ->> 'masterId'), '') as mid,
           pg_catalog.regexp_replace(coalesce(r.v ->> 'name', ''), '[[:space:]　]', '', 'g') as nkey,
           coalesce(r.v ->> 'external', '') = 'true' as external,
           coalesce(r.v ->> 'hospitalized', '') = 'true' as hospitalized
      from ok s
     cross join lateral pg_catalog.jsonb_array_elements(s.data -> 'residents') with ordinality r(v, ord)
     where pg_catalog.jsonb_typeof(r.v) = 'object'
       and coalesce(r.v ->> 'movedOut', '') <> 'true'
       and coalesce(r.v ->> 'preAdmitted', '') <> 'true'
  ),
  mids as (
    select x.mid, pg_catalog.count(*) as n from res x where x.mid is not null and not x.external group by x.mid
  ),
  roster as (
    select p.id, p.source_id,
           pg_catalog.regexp_replace(p.name, '[[:space:]　]', '', 'g') as nkey
      from public.residents p
     where p.active
  ),
  matched as (
    select x.*,
           case
             when x.external then 'external'
             when x.mid is not null then
               case
                 when not exists (select 1 from roster ro where ro.source_id = x.mid) then 'absent_roster'
                 when exists (select 1 from roster ro where ro.source_id = x.mid and ro.nkey = x.nkey and x.nkey <> '') then 'mid'
                 else 'mismatch'
               end
             when x.nkey = '' then 'ambiguous'
             else
               case (select pg_catalog.count(*) from roster ro where ro.nkey = x.nkey)
                 when 0 then 'absent_roster'
                 when 1 then
                   case when exists (select 1 from roster ro join mids m on m.mid = ro.source_id where ro.nkey = x.nkey)
                        then 'ambiguous' else 'name' end
                 else 'ambiguous'
               end
           end as match
      from res x
  ),
  bound as (
    select m.*,
           case
             when m.match = 'mid' then (select ro.id from roster ro where ro.source_id = m.mid limit 1)
             when m.match = 'name' then (select ro.id from roster ro where ro.nkey = m.nkey limit 1)
           end as resident_id
      from matched m
  ),
  flagged as (
    select b.*,
           (b.mid is not null and coalesce((select mm.n from mids mm where mm.mid = b.mid), 0) > 1)
             or (b.resident_id is not null
                 and (select pg_catalog.count(*) from bound b2 where b2.resident_id = b.resident_id) > 1) as dup
      from bound b
  ),
  plan as (
    select f.sched_id,
           nullif(pg_catalog.btrim(e.v ->> 'id'), '') as event_id,
           f.resident_id,
           f.match,
           f.dup,
           f.external,
           f.hospitalized,
           e.v ->> 'startTime' as start_time,
           e.v ->> 'endTime' as end_time,
           coalesce(e.v ->> 'bathing', '') = 'true' as bathing,
           case when f.mid is not null and not f.external and not f.hospitalized
                     and coalesce(e.v ->> 'bathing', '') = 'true'
                then (select ro.id from roster ro where ro.source_id = f.mid order by ro.id limit 1)
           end as bath_resident_id,
           f.ord,
           e.ord as eord,
           case when (e.v ->> 'startTime') ~ '^[0-9]{1,2}:[0-9]{2}'
                then pg_catalog.lpad(pg_catalog.split_part(e.v ->> 'startTime', ':', 1), 2, '0')
                     || ':' || pg_catalog.substr(pg_catalog.split_part(e.v ->> 'startTime', ':', 2), 1, 2)
           end as start_key
      from flagged f
     cross join lateral pg_catalog.jsonb_array_elements(
             case when pg_catalog.jsonb_typeof(f.v -> 'events') = 'array'
                  then f.v -> 'events' else '[]'::jsonb end) with ordinality e(v, ord)
     where pg_catalog.jsonb_typeof(e.v) = 'object'
       and (e.v ->> 'serviceType') = 'daycare'
       and (case when (e.v ->> 'dayOfWeek') ~ '^[0-6]$' then (e.v ->> 'dayOfWeek')::int end)
           = (extract(isodow from p_date)::int - 1)
  )
  select q.sched_id, q.event_id, q.resident_id, q.match, q.dup, q.external, q.hospitalized,
         q.start_time, q.end_time, q.bathing, q.bath_resident_id, q.plan_rev, q.updated_at
    from (
      select p.sched_id, p.event_id, p.resident_id, p.match, p.dup, p.external, p.hospitalized,
             p.start_time, p.end_time, p.bathing, p.bath_resident_id, s.rev as plan_rev, s.updated_at,
             0 as grp, p.start_key, p.ord, p.eord
        from plan p cross join ok s
      union all
      select null, null, null, null, null, null, null, null, null, null, null, s.rev, s.updated_at,
             1, null, null, null
        from ok s
       where not exists (select 1 from plan)
    ) q
   order by q.grp, q.start_key nulls last, q.ord, q.eord
$fn$;

comment on function private.daycare_auto_plan(date, uuid) is
  '0041 の daycare_plan と同じ照合で、そのテナントのその日のデイの予定を返す（定時の処理用・読むだけ）。0047。';

-- ---------- 7. 自動の到着・帰宅（本体） ----------
-- p_at の日本時間の日付と時刻で動く。返り値は {day, arrived, left, snapshot, skipped}（skipped は何もしなかった理由・動いた時は null）。
-- 試験では p_at をずらして呼ぶ（cron が呼ぶのは下の引数なしの入口だけ）
create or replace function private.daycare_auto_attendance_at(p_at timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_day    date;
  v_time   time;
  v_tenant uuid;
  v_src    text;
  v_rows   jsonb;
  v_live   jsonb;
  v_n      integer;
  v_real   integer;
  v_rev    integer;
  v_upd    timestamptz;
  v_snap   boolean := false;
  v_arr    integer := 0;
  v_left   integer := 0;
begin
  if p_at is null then
    raise exception 'daycare_auto_attendance: 時刻がありません';
  end if;
  v_day  := (p_at at time zone 'Asia/Tokyo')::date;
  v_time := (p_at at time zone 'Asia/Tokyo')::time;

  -- 自動の旗と、デイの入力の旗（封鎖中は画面から直せないので書かない＝0015 と同じ）
  if not private.care_auto_flag_on('auto_enabled_daycare_attendance') or not private.care_auto_flag_on('input_enabled_daycare') then
    return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', false, 'skipped', 'flag');
  end if;
  -- デイの休業日（0016 の判定）
  if private.care_auto_daycare_closed(v_day) then
    return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', false, 'skipped', 'closed');
  end if;

  -- テナント（2つ以上なら例外で止まる＝何も書かない）
  v_tenant := private.care_auto_tenant();

  -- その日の予定の写し
  select d.plan_source, d.plan_rows into v_src, v_rows from public.daycare_days d where d.day = v_day;
  if not found or v_src = 'unknown' then
    -- 写しが無い・読めなかった日: いまの週間計画を読み、開始の時刻を過ぎた方が初めて出た回に写しを作る
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p)), '[]'::jsonb),
           pg_catalog.count(*),
           pg_catalog.count(*) filter (where p.sched_id is not null),
           pg_catalog.max(p.plan_rev),
           pg_catalog.max(p.updated_at)
      into v_live, v_n, v_real, v_rev, v_upd
      from private.daycare_auto_plan(v_day, v_tenant) p;
    if v_n = 0 then
      return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', false, 'skipped', 'unread');
    end if;
    if v_real = 0 then
      -- 予定なしの日は写しを作らない（職員の開所に任せる）
      return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', false, 'skipped', 'noplan');
    end if;
    if not exists (
         select 1
           from pg_catalog.jsonb_array_elements(v_live) e(v)
          where (e.v ->> 'match') in ('mid', 'name')
            and coalesce(e.v ->> 'dup', '') <> 'true'
            and coalesce(e.v ->> 'external', '') <> 'true'
            and coalesce(e.v ->> 'hospitalized', '') <> 'true'
            and private.daycare_auto_hm(e.v ->> 'start_time') <= v_time) then
      return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', false, 'skipped', 'early');
    end if;
    -- 写しを作る（daycare_open_day と同じ形の行・開所の職員は空）。既に職員が作っていればそれを使う。unknown の写しは1回置き換える
    insert into public.daycare_days (day, plan_source, plan_rev, plan_updated_at, plan_rows, opened_by, edited_by)
    values (v_day, 'kv', v_rev, v_upd, v_live, null, null)
    on conflict (day) do nothing;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      update public.daycare_days
         set plan_source = 'kv', plan_rev = v_rev, plan_updated_at = v_upd, plan_rows = v_live, edited_by = null
       where day = v_day and plan_source = 'unknown';
      get diagnostics v_n = row_count;
    end if;
    v_snap := v_n > 0;
    select d.plan_source, d.plan_rows into v_src, v_rows from public.daycare_days d where d.day = v_day;
  end if;
  if v_src is distinct from 'kv' then
    return pg_catalog.jsonb_build_object('day', v_day, 'arrived', 0, 'left', 0, 'snapshot', v_snap, 'skipped', 'noplan');
  end if;

  -- 到着（開始の時刻を過ぎた方・その日の行がまだ無い方）。終了の時刻も過ぎていれば帰宅も一緒に入れる（止まっていた後の取り戻し）
  with ev as (
    select (e.v ->> 'resident_id')::bigint as rid,
           private.daycare_auto_hm(e.v ->> 'start_time') as st,
           private.daycare_auto_hm(e.v ->> 'end_time') as et
      from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(v_rows) = 'array' then v_rows else '[]'::jsonb end) e(v)
     where pg_catalog.jsonb_typeof(e.v) = 'object'
       and (e.v ->> 'resident_id') ~ '^[0-9]+$'
       and (e.v ->> 'match') in ('mid', 'name')
       and coalesce(e.v ->> 'dup', '') <> 'true'
       and coalesce(e.v ->> 'external', '') <> 'true'
       and coalesce(e.v ->> 'hospitalized', '') <> 'true'
  ),
  per as (
    -- 1人1件の予定の方だけ（同じ方に予定が2件以上ある日は、データの誤りとして自動にしない＝代表者の回答 A2）
    select ev.rid, pg_catalog.min(ev.st) as st, pg_catalog.min(ev.et) as et
      from ev
     group by ev.rid
    having pg_catalog.count(*) = 1
  )
  insert into public.daycare_attendance (resident_id, day, arrived_at, left_at, arrived_auto, left_auto, recorded_by, client_key)
  select p.rid, v_day, p.st,
         case when p.et is not null and p.et <= v_time and p.et >= p.st then p.et end,
         true,
         p.et is not null and p.et <= v_time and p.et >= p.st,
         null,
         'auto:dcatt:' || pg_catalog.to_char(v_day, 'YYYY-MM-DD') || ':' || p.rid::text
    from per p
    join public.residents r
      on r.id = p.rid
     and r.active
   where p.st is not null
     and p.st <= v_time
     -- 入院中（入居者マスタの写し。週間計画の写しの入院は上で除いている）
     and not exists (
           select 1 from public.master_residents mr
            where mr.tenant_id = v_tenant
              and mr.source_id = r.source_id
              and mr.hospitalized is true)
     -- 外泊の期間中／外出中（0015 の与薬の自動と同じ判定。時刻は予定の開始）
     and not exists (
           select 1 from public.outings o
            where o.resident_id = r.id
              and o.deleted_at is null
              and o.start_on <= v_day
              and (
                    (o.kind = 'overnight' and (o.end_on is null or v_day <= o.end_on))
                    or (o.kind = 'outing' and o.end_on is null)
                    or (
                         o.kind = 'outing'
                         and o.end_on is not null
                         and v_day <= o.end_on
                         and (o.start_on < v_day or o.start_at is null or o.start_at <= p.st)
                         and (o.end_on > v_day or o.end_at is null or o.end_at >= p.st)
                       )
                  ))
     -- その日の生きている行がもうある（休み・手で押した到着・時刻を消した行＝人が記録・取り消した後に作り直さない）。
     -- 取り消し済みの行は数えない（休みの直後の〔元に戻す〕で「行が無い」形に戻した方には、その後も自動で入れる）
     and not exists (
           select 1 from public.daycare_attendance a
            where a.resident_id = p.rid
              and a.day = v_day
              and a.deleted_at is null)
  on conflict do nothing;
  get diagnostics v_arr = row_count;

  -- 帰宅（到着があり帰宅が無い行・終了の時刻を過ぎた方）。予定の終了の後に行が書き換えられていたら入れない
  with ev as (
    select (e.v ->> 'resident_id')::bigint as rid,
           private.daycare_auto_hm(e.v ->> 'end_time') as et
      from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(v_rows) = 'array' then v_rows else '[]'::jsonb end) e(v)
     where pg_catalog.jsonb_typeof(e.v) = 'object'
       and (e.v ->> 'resident_id') ~ '^[0-9]+$'
       and (e.v ->> 'match') in ('mid', 'name')
       and coalesce(e.v ->> 'dup', '') <> 'true'
       and coalesce(e.v ->> 'external', '') <> 'true'
       and coalesce(e.v ->> 'hospitalized', '') <> 'true'
  ),
  per as (
    -- 到着と同じく、1人1件の予定の方だけ
    select ev.rid, pg_catalog.min(ev.et) as et
      from ev
     group by ev.rid
    having pg_catalog.count(*) = 1
  )
  update public.daycare_attendance a
     set left_at = p.et,
         left_auto = true
    from per p
   where a.resident_id = p.rid
     and a.day = v_day
     and a.deleted_at is null
     and not a.absent
     and a.arrived_at is not null
     and a.left_at is null
     and p.et is not null
     and p.et <= v_time
     and p.et >= a.arrived_at
     and a.updated_at <= ((v_day + p.et) at time zone 'Asia/Tokyo');
  get diagnostics v_left = row_count;

  return pg_catalog.jsonb_build_object('day', v_day, 'arrived', v_arr, 'left', v_left, 'snapshot', v_snap, 'skipped', null);
end
$fn$;

comment on function private.daycare_auto_attendance_at(timestamptz) is
  'その時刻（日本時間）の自動の到着・帰宅の本体（0047）。予定の開始・終了の時刻で記録する。{day, arrived, left, snapshot, skipped} を返す。';

-- 入口（cron が呼ぶ）: 今の時刻で本体を呼ぶ
create or replace function private.daycare_auto_attendance()
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $fn$
  select private.daycare_auto_attendance_at(pg_catalog.now())
$fn$;

comment on function private.daycare_auto_attendance() is
  '今の時刻で自動の到着・帰宅を記録する（pg_cron が5分ごとに呼ぶ・0047）。旗 auto_enabled_daycare_attendance が true の時だけ書く。';

-- 権限: cron（postgres）だけが呼ぶ。PUBLIC の既定 EXECUTE と anon / authenticated を剥がす
revoke all on function private.daycare_auto_hm(text)                    from public, anon, authenticated;
revoke all on function private.daycare_auto_plan(date, uuid)            from public, anon, authenticated;
revoke all on function private.daycare_auto_attendance_at(timestamptz)  from public, anon, authenticated;
revoke all on function private.daycare_auto_attendance()                from public, anon, authenticated;

-- ---------- 8. cron ジョブ（5分ごと） ----------
-- 同じ名前で登録し直すと置き換わる（重複しない）。旗が false の間は関数がすぐ戻る（何も書かない）
select cron.schedule('care_auto_daycare_attendance', '*/5 * * * *', 'select private.daycare_auto_attendance()');

-- PostgREST のスキーマキャッシュを即時リロード（新しい列を画面が読めるように）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（結果が表で出る。目視する。列名の末尾が期待値）
-- ---------------------------------------------------------------------
select
  (select value from public.app_settings where key = 'auto_enabled_daycare_attendance')            as auto_flag_false,
  (select count(*) from pg_constraint
    where conname = 'daycare_attendance_absent_reason_check'
      and pg_get_constraintdef(oid) like '%later%')                                               as later_check_1,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'daycare_attendance'
      and column_name in ('arrived_auto', 'left_auto'))                                           as auto_columns_2,
  (select count(*) from information_schema.triggers
    where event_object_table = 'daycare_attendance' and trigger_name = 'trg_auto_off_daycare_attendance') as auto_off_trigger_2,
  (select count(*) from cron.job
    where jobname = 'care_auto_daycare_attendance' and schedule = '*/5 * * * *')                as auto_job_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'daycare\_auto\_%'
      and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute')))                        as callable_by_app_0;
