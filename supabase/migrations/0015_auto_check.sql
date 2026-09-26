-- =====================================================================
-- 0015: 与薬・デイの入浴の自動チェック（pg_cron で時刻になったら DB 側で記録を作る）
--
-- 0001〜0014 を当てたあとに実行する。既存のテーブル・列・データは一切削除しない（追加のみ）。
--
-- ★初回のみ流す（必ず読む）:
--   **このファイルは初回に1回だけ流す。** 中の文はどれも「あれば触らない／同じ名前なら置き換える」形なので、
--   誤って2回流しても記録は増えず壊れないが、**修正が要る時は新しい番号のファイル（0016_… 等）を作って差分だけを流すこと**
--   （0012〜0014 と同じ運用）。do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため・0001 の注記）。
--   関数本体の as $fn$ … $fn$ は使ってよい（0011・0012 と同じ）。
--
-- 背景（2026-09-27 代表指示）:
--   ・与薬: 一包化の袋を時間帯ごとに渡す運用で、仕組み上「与薬漏れ」は起きない。そこで時刻を過ぎたら自動で「服用済み」にする。
--           朝食後 8:50・昼食後 13:00・夕食後 18:20（日本時間）。眠前は自動にしない（指示に無い）。
--           例外（拒否・落薬など）は職員が画面で状態を変える（変えた記録は auto=false・記入者つきになる＝アプリ側）。
--   ・デイの入浴: 12:30 に、その日の入浴予定者を自動で「全身浴」にする。入浴しなかった方は職員が画面で
--           「チェックを外す」（中止＋理由。行は消さない＝加算の根拠として入浴しなかった理由を残す）。
--   自動の記録は DB 側（このファイルの関数を pg_cron が呼ぶ）だけで作る。端末では作らない。
--
-- 追加するもの:
--   1. 拡張 pg_cron（Supabase の作法どおり pg_catalog に入れる。ジョブの表・関数は cron スキーマにできる）
--   2. bath_records.auto / med_admin.auto（boolean not null default false）… 自動で入った記録の印
--   3. private.care_auto_today(時刻)          … その時刻の日本時間の日付（UTC 23:50 → 日本時間の翌日）
--      private.care_auto_med_on(時間帯, 日付) … その日のその時間帯の自動の与薬の記録（本体）
--      private.care_auto_med(時間帯)          … 今日（日本時間）について上を呼ぶ（cron が呼ぶ）
--      private.care_auto_bath_on(日付)        … その日の自動の入浴の記録（本体）
--      private.care_auto_bath()               … 今日（日本時間）について上を呼ぶ（cron が呼ぶ）
--      どれも security definer・search_path は空（名前は全部修飾する）。anon / authenticated からは呼べない（revoke）
--   4. cron ジョブ4件（名前付き。同じ名前で登録し直すと置き換わる＝重複しない）
--
-- 自動にしない人（与薬）:
--   ・その時間帯が服薬の時間帯（med_slots）に無い人・在籍でない人（residents.active=false）
--   ・入院中（入居者マスタの写し master_residents.hospitalized=true。テナントは写しにある唯一のテナント）
--   ・外泊の期間中（outings.kind='overnight' で start_on ≤ その日 ≤ end_on・取り消し済みは除く）。
--     帰着未定（end_on が null）の外泊は継続中とみなし、start_on 以降の毎日を除く（カルテの扱いとそろえる・2026-09-27 チーフ裁定）
--   ・外出中（outings.kind='outing' で同じ日付の範囲、かつ自動の時刻に外出の時刻がかかる。
--             出発時刻が無い＝その日の初めから、帰着時刻が無い＝まだ戻っていないとみなす＝安全側に倒して自動にしない）
--   ・その日その時間帯に記録が既にある人（**取り消し済みの行も含む**＝職員が消した・直した後に作り直さない）
-- 自動にしない人（入浴）:
--   ・その日の曜日に入浴の予定が無い人（daycare_bath_plan と同じ抽出。テナントは写しにある唯一のテナント）
--   ・退居・外部・入居前（写しの movedOut / external / preAdmitted）・入院中（写しの hospitalized、または
--     入居者マスタの写し master_residents.hospitalized=true）・care-log の名簿で在籍でない人・名簿と突き合わせられない人
--   ・その日に記録が既にある人（取り消し済みの行も含む）
-- 共通: 種類ごとの入力解禁（app_settings の input_enabled_med / input_enabled_bath）が 'true' でない間は何もしない
--       （封鎖中は画面から直せないため。封鎖の挙動を変えない）。
--
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 1. 拡張 pg_cron ----------
-- Supabase の手順どおり pg_catalog に入れる（pg_cron は置き場所を変えられない拡張。ジョブは cron.job に入る）。
-- ダッシュボードの Database → Extensions で pg_cron を有効にしてあれば、この文は何もしない。
create extension if not exists pg_cron with schema pg_catalog;

-- ---------- 2. 自動の印 ----------
alter table public.bath_records add column if not exists auto boolean not null default false;
alter table public.med_admin    add column if not exists auto boolean not null default false;

comment on column public.bath_records.auto is
  '自動で入った記録（0015 の care_auto_bath が作る）。職員が画面で直すと false になる（記入者つき）。';
comment on column public.med_admin.auto is
  '自動で入った記録（0015 の care_auto_med が作る）。職員が画面で直すと false になる（記入者つき）。';

-- ---------- 3. 関数 ----------
-- 置き場は private（API に出さない。care-backend 0001_foundation の private スキーマ）

-- その時刻の日本時間の日付。cron は UTC で動くので、UTC 23:50（朝の与薬）は日本時間の翌日の日付になる
create or replace function private.care_auto_today(p_at timestamptz default now())
returns date
language sql
stable
security definer
set search_path = ''
as $fn$
  select (p_at at time zone 'Asia/Tokyo')::date
$fn$;

-- その日のその時間帯の自動の与薬の記録（本体）。挿入した件数を返す
create or replace function private.care_auto_med_on(p_slot text, p_on date)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_at     time;
  v_tenant uuid;
  v_n      integer;
begin
  -- 自動にするのは朝・昼・夕だけ（眠前・頓服は自動にしない）。時刻は代表指示（日本時間）
  v_at := case p_slot
            when 'morning' then time '08:50'
            when 'noon'    then time '13:00'
            when 'evening' then time '18:20'
          end;
  if v_at is null then
    raise exception 'care_auto_med: 自動にできない時間帯です（%）', p_slot;
  end if;
  if p_on is null then
    raise exception 'care_auto_med: 日付がありません';
  end if;

  -- 与薬の入力が解禁されていない間は何もしない（封鎖中は画面から直せない）
  if coalesce((select s.value from public.app_settings s where s.key = 'input_enabled_med'), '') <> 'true' then
    return 0;
  end if;

  -- 入院中の判定に使う入居者マスタの写しのテナント（唯一のテナントでなければ判定できない＝何も入れずに止める）
  if (select count(distinct m.tenant_id) from public.master_residents m) <> 1 then
    raise exception 'care_auto_med: 入居者マスタの写しのテナントが1つに定まりません';
  end if;
  select m.tenant_id into v_tenant from public.master_residents m limit 1;

  insert into public.med_admin (resident_id, admin_on, slot, status, recorded_by, auto, client_key)
  select r.id, p_on, p_slot, 'taken', null, true,
         'auto:med:' || pg_catalog.to_char(p_on, 'YYYY-MM-DD') || ':' || p_slot || ':' || r.id::text
    from public.residents r
    join public.med_slots ms
      on ms.resident_id = r.id
     and ms.deleted_at is null
     and p_slot = any (ms.slots)
   where r.active
     -- (1) 入院中（入居者マスタの写し）
     and not exists (
           select 1 from public.master_residents mr
            where mr.tenant_id = v_tenant
              and mr.source_id = r.source_id
              and mr.hospitalized is true)
     -- (2) 外泊の期間中／外出中（自動の時刻に外出の時刻がかかる）
     and not exists (
           select 1 from public.outings o
            where o.resident_id = r.id
              and o.deleted_at is null
              and o.start_on <= p_on
              and (
                    -- 外泊: 帰着日まで（帰着未定は継続中＝以降の毎日）
                    (o.kind = 'overnight' and (o.end_on is null or p_on <= o.end_on))
                    or (
                         -- 外出: 同じ日付の範囲（帰着日が無ければ出発日だけ）で、自動の時刻に外出の時刻がかかる
                         o.kind = 'outing'
                         and p_on <= coalesce(o.end_on, o.start_on)
                         and (o.start_on < p_on or o.start_at is null or o.start_at <= v_at)
                         and (coalesce(o.end_on, o.start_on) > p_on or o.end_at is null or o.end_at >= v_at)
                       )
                  ))
     -- (3) その日その時間帯に記録が既にある（取り消し済みも含む＝職員が消した・直した後に作り直さない）
     and not exists (
           select 1 from public.med_admin a
            where a.resident_id = r.id
              and a.admin_on = p_on
              and a.slot = p_slot)
  on conflict do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

-- 今日（日本時間）のその時間帯（cron が呼ぶ）
create or replace function private.care_auto_med(p_slot text)
returns integer
language sql
volatile
security definer
set search_path = ''
as $fn$
  select private.care_auto_med_on(p_slot, private.care_auto_today(now()))
$fn$;

-- その日の自動の入浴の記録（本体）。挿入した件数を返す。予定の無い曜日（デイの休業日など）は0件
create or replace function private.care_auto_bath_on(p_on date)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_tenant uuid;
  v_n      integer;
begin
  if p_on is null then
    raise exception 'care_auto_bath: 日付がありません';
  end if;

  -- 入浴の入力が解禁されていない間は何もしない（封鎖中は画面から直せない）
  if coalesce((select s.value from public.app_settings s where s.key = 'input_enabled_bath'), '') <> 'true' then
    return 0;
  end if;

  -- 週間計画の写しのテナント（唯一のテナント。写しが無ければ予定が無い＝0件。2つ以上なら判定できない＝止める）
  if (select count(*) from public.kv_entries k where k.key = 'care_schedule_v2') = 0 then
    return 0;
  end if;
  if (select count(distinct k.tenant_id) from public.kv_entries k where k.key = 'care_schedule_v2') <> 1 then
    raise exception 'care_auto_bath: 週間計画の写しのテナントが1つに定まりません';
  end if;
  select k.tenant_id into v_tenant from public.kv_entries k where k.key = 'care_schedule_v2' limit 1;

  -- 予定の抽出は daycare_bath_plan（0012）と同じ（auth に頼らずテナントを明示する）
  with src as (
    select k.data
      from public.kv_entries k
     where k.tenant_id = v_tenant
       and k.key = 'care_schedule_v2'
     limit 1
  ),
  plan as (
    select distinct x.source_id
      from src s
     cross join lateral pg_catalog.jsonb_array_elements(
             case when pg_catalog.jsonb_typeof(s.data -> 'residents') = 'array'
                  then s.data -> 'residents' else '[]'::jsonb end) r(v)
     cross join lateral pg_catalog.jsonb_array_elements(
             case when pg_catalog.jsonb_typeof(r.v -> 'events') = 'array'
                  then r.v -> 'events' else '[]'::jsonb end) e(v)
     cross join lateral (
       select nullif(pg_catalog.btrim(r.v ->> 'masterId'), '') as source_id
     ) x
     where x.source_id is not null
       and coalesce(r.v ->> 'movedOut', '') <> 'true'
       and coalesce(r.v ->> 'preAdmitted', '') <> 'true'
       and coalesce(r.v ->> 'external', '') <> 'true'
       and coalesce(r.v ->> 'hospitalized', '') <> 'true'
       and (e.v ->> 'serviceType') = 'daycare'
       and (e.v ->> 'bathing') = 'true'
       and (case when (e.v ->> 'dayOfWeek') ~ '^[0-6]$' then (e.v ->> 'dayOfWeek')::int end)
           = (extract(isodow from p_on)::int - 1)
  )
  insert into public.bath_records (resident_id, bath_on, result, cancel_reason, note, recorded_by, auto, client_key)
  select r.id, p_on, 'full', null, null, null, true,
         'auto:bath:' || pg_catalog.to_char(p_on, 'YYYY-MM-DD') || ':' || r.id::text
    from plan p
    join public.residents r
      on r.source_id = p.source_id
     and r.active
   where
     -- 入院中（入居者マスタの写し。写しの hospitalized は上の抽出で除いている）
     not exists (
           select 1 from public.master_residents mr
            where mr.tenant_id = v_tenant
              and mr.source_id = r.source_id
              and mr.hospitalized is true)
     -- その日に記録が既にある（取り消し済みも含む＝職員が消した・直した後に作り直さない）
     and not exists (
           select 1 from public.bath_records b
            where b.resident_id = r.id
              and b.bath_on = p_on)
  on conflict do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

-- 今日（日本時間）の入浴（cron が呼ぶ）
create or replace function private.care_auto_bath()
returns integer
language sql
volatile
security definer
set search_path = ''
as $fn$
  select private.care_auto_bath_on(private.care_auto_today(now()))
$fn$;

comment on function private.care_auto_med(text) is
  '今日（日本時間）のその時間帯（morning/noon/evening）の自動の与薬の記録を作る（pg_cron が呼ぶ）。挿入件数を返す。';
comment on function private.care_auto_bath() is
  '今日（日本時間）のデイの入浴予定者の自動の入浴の記録（全身浴）を作る（pg_cron が呼ぶ）。挿入件数を返す。';

-- 権限: cron（postgres）だけが呼ぶ。PUBLIC の既定 EXECUTE と anon / authenticated を剥がす
revoke all on function private.care_auto_today(timestamptz)   from public, anon, authenticated;
revoke all on function private.care_auto_med_on(text, date)   from public, anon, authenticated;
revoke all on function private.care_auto_med(text)            from public, anon, authenticated;
revoke all on function private.care_auto_bath_on(date)        from public, anon, authenticated;
revoke all on function private.care_auto_bath()               from public, anon, authenticated;

-- ---------- 4. cron ジョブ（UTC で書く。日本時間 = UTC + 9 時間） ----------
-- cron.schedule(名前, 時刻, 実行する文) は同じ名前のジョブがあれば置き換える（重複しない）。
-- 実行する文は $$ でなく通常の文字列で渡す（SQL エディタの誤解釈を避ける）。
--   与薬 朝 … UTC 23:50 ＝ 日本時間 8:50（UTC では前日。関数は日本時間の今日＝翌日の日付で記録する）
--   与薬 昼 … UTC  4:00 ＝ 日本時間 13:00
--   与薬 夕 … UTC  9:20 ＝ 日本時間 18:20
--   入浴    … UTC  3:30 ＝ 日本時間 12:30
select cron.schedule('care_auto_med_morning', '50 23 * * *', 'select private.care_auto_med(''morning'')');
select cron.schedule('care_auto_med_noon',    '0 4 * * *',   'select private.care_auto_med(''noon'')');
select cron.schedule('care_auto_med_evening', '20 9 * * *',  'select private.care_auto_med(''evening'')');
select cron.schedule('care_auto_bath',        '30 3 * * *',  'select private.care_auto_bath()');

-- PostgREST のスキーマキャッシュを即時リロード（auto 列を画面が読めるように）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（結果が表で出る。目視する。列名の末尾の数が期待値）
-- ---------------------------------------------------------------------
select
  (select count(*) from pg_extension where extname = 'pg_cron')                            as pg_cron_1,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name in ('bath_records', 'med_admin')
      and column_name = 'auto' and is_nullable = 'NO')                                     as auto_cols_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname in ('care_auto_today', 'care_auto_med_on', 'care_auto_med',
                        'care_auto_bath_on', 'care_auto_bath'))                            as functions_5,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'care\_auto\_%'
      and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute')))                 as callable_by_app_0,
  (select count(*) from cron.job
    where jobname in ('care_auto_med_morning', 'care_auto_med_noon',
                      'care_auto_med_evening', 'care_auto_bath'))                          as cron_jobs_4;
