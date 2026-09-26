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
--      private.care_auto_flag_on(キー)        … app_settings の旗がオンか（アプリと同じ解釈: true/1/on/yes/enabled・大小文字と前後の空白を問わない）
--      private.care_auto_tenant()             … 週間計画の写し・入居者マスタの写しにある唯一のテナント（無ければ null・2つ以上なら例外）
--      private.care_auto_med_on(時間帯, 日付) … その日のその時間帯の自動の与薬の記録（本体）
--      private.care_auto_med(時間帯)          … 今日（日本時間）について上を呼ぶ（cron が呼ぶ）
--      private.care_auto_bath_on(日付)        … その日の自動の入浴の記録（本体）
--      private.care_auto_bath()               … 今日（日本時間）について上を呼ぶ（cron が呼ぶ）
--      どれも security definer・search_path は空（名前は全部修飾する）。anon / authenticated からは呼べない（revoke）
--   4. cron ジョブ4件（名前付き。同じ名前で登録し直すと置き換わる＝重複しない）
--   5. 自動の印を外すトリガ（bath_records・med_admin の before update）: 自動の記録の区分・状態・理由・備考が変わる更新なら
--      auto を false にする（古い画面からの更新でも自動の印が外れる・2026-09-27 チーフ指摘6）
--   6. app_settings に 'daycare_closed_dates'（デイの休業日 'YYYY-MM-DD' のカンマ区切り・初期値 ''・既存は触らない）
--
-- 自動にしない人（与薬）:
--   ・その時間帯が服薬の時間帯（med_slots）に無い人・在籍でない人（residents.active=false）
--   ・入院中（入居者マスタの写し master_residents.hospitalized=true、または週間計画の写しの residents[].hospitalized=true。
--     masterId＝residents.source_id で照合。テナントは care_auto_tenant。写しが無い方の判定は、ある方だけで続ける・チーフ指摘4）
--   ・外泊の期間中（outings.kind='overnight' で start_on ≤ その日 ≤ end_on・取り消し済みは除く）。
--     帰着未定（end_on が null）の外泊は継続中とみなし、start_on 以降の毎日を除く（カルテの扱いとそろえる・2026-09-27 チーフ裁定）
--   ・外出中（outings.kind='outing'）。帰着未定（end_on が null）の外出は外泊と同じく継続中とみなし start_on 以降の毎日を除く
--             （チーフ指摘3）。帰着日が入っている外出だけ、日付の範囲に当たり かつ 自動の時刻に外出の時刻がかかる時に除く
--             （出発時刻が無い＝その日の初めから、帰着時刻が無い＝まだ戻っていないとみなす＝安全側に倒して自動にしない）
--   ・その日その時間帯に記録が既にある人（**取り消し済みの行も含む**＝職員が消した・直した後に作り直さない）
-- 自動にしない人（入浴）:
--   ・その日の曜日に入浴の予定が無い人（daycare_bath_plan と同じ抽出。テナントは care_auto_tenant）
--   ・その日がデイの休業日（app_settings の daycare_closed_dates に載っている日）なら誰も自動にしない（0件）
--   ・退居・外部・入居前（写しの movedOut / external / preAdmitted）・入院中（写しの hospitalized、または
--     入居者マスタの写し master_residents.hospitalized=true）・care-log の名簿で在籍でない人・名簿と突き合わせられない人
--   ・その日に記録が既にある人（取り消し済みの行も含む）
-- 共通: 種類ごとの入力解禁（app_settings の input_enabled_med / input_enabled_bath）がオンでない間は何もしない
--       （封鎖中は画面から直せないため。封鎖の挙動を変えない。オンの解釈はアプリと同じ＝care_auto_flag_on）。
--       テナントが2つ以上あって定まらない時だけ例外で止める（何も入れない）。
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

-- デイの休業日（'YYYY-MM-DD' のカンマ区切り。例 '2026-12-30,2026-12-31'）。この日は入浴の自動を0件にする。
-- 初期値は空（既にあれば触らない＝現場で入れた値を戻さない）
insert into public.app_settings (key, value)
values ('daycare_closed_dates', '')
on conflict (key) do nothing;

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

-- app_settings の旗がオンか。アプリ（db.ts の TRUE_WORDS）と同じ解釈: 前後の空白を除き小文字にして true/1/on/yes/enabled
create or replace function private.care_auto_flag_on(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    (select pg_catalog.lower(pg_catalog.btrim(s.value)) in ('true', '1', 'on', 'yes', 'enabled')
       from public.app_settings s
      where s.key = p_key),
    false)
$fn$;

-- 週間計画の写し（kv_entries の care_schedule_v2）と入居者マスタの写し（master_residents）にある唯一のテナント。
-- どちらにも無ければ null（入院の判定は、ある方の写しだけで続ける）。合わせて2つ以上あれば判定できない＝例外で止める
create or replace function private.care_auto_tenant()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_n      integer;
  v_tenant uuid;
begin
  select count(*), min(t.tenant_id::text)::uuid into v_n, v_tenant
    from (select k.tenant_id from public.kv_entries k where k.key = 'care_schedule_v2'
          union
          select m.tenant_id from public.master_residents m) t;
  if v_n > 1 then
    raise exception 'care_auto: テナントが1つに定まりません（%件）', v_n;
  end if;
  return v_tenant;
end
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
  if not private.care_auto_flag_on('input_enabled_med') then
    return 0;
  end if;

  -- 入院の判定に使うテナント（写しが無ければ null＝ある方の写しだけで判定する。2つ以上なら例外で止まる）
  v_tenant := private.care_auto_tenant();

  insert into public.med_admin (resident_id, admin_on, slot, status, recorded_by, auto, client_key)
  select r.id, p_on, p_slot, 'taken', null, true,
         'auto:med:' || pg_catalog.to_char(p_on, 'YYYY-MM-DD') || ':' || p_slot || ':' || r.id::text
    from public.residents r
    join public.med_slots ms
      on ms.resident_id = r.id
     and ms.deleted_at is null
     and p_slot = any (ms.slots)
   where r.active
     -- (1) 入院中（入居者マスタの写し、または週間計画の写しのどちらかで入院中）
     and not exists (
           select 1 from public.master_residents mr
            where mr.tenant_id = v_tenant
              and mr.source_id = r.source_id
              and mr.hospitalized is true)
     and not exists (
           select 1
             from public.kv_entries k
            cross join lateral pg_catalog.jsonb_array_elements(
                    case when pg_catalog.jsonb_typeof(k.data -> 'residents') = 'array'
                         then k.data -> 'residents' else '[]'::jsonb end) kr(v)
            where k.tenant_id = v_tenant
              and k.key = 'care_schedule_v2'
              and nullif(pg_catalog.btrim(kr.v ->> 'masterId'), '') = r.source_id
              and coalesce(kr.v ->> 'hospitalized', '') = 'true')
     -- (2) 外泊の期間中／外出中（帰着未定は継続中。帰着日のある外出は自動の時刻に外出の時刻がかかる時だけ）
     and not exists (
           select 1 from public.outings o
            where o.resident_id = r.id
              and o.deleted_at is null
              and o.start_on <= p_on
              and (
                    -- 外泊: 帰着日まで（帰着未定は継続中＝以降の毎日）
                    (o.kind = 'overnight' and (o.end_on is null or p_on <= o.end_on))
                    -- 外出・帰着未定: 外泊と同じく継続中（時刻は見ない・チーフ指摘3）
                    or (o.kind = 'outing' and o.end_on is null)
                    or (
                         -- 外出・帰着日あり: 帰着日までの日付で、自動の時刻に外出の時刻がかかる時
                         o.kind = 'outing'
                         and o.end_on is not null
                         and p_on <= o.end_on
                         and (o.start_on < p_on or o.start_at is null or o.start_at <= v_at)
                         and (o.end_on > p_on or o.end_at is null or o.end_at >= v_at)
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

-- その日の自動の入浴の記録（本体）。挿入した件数を返す。予定の無い曜日（日曜など）・休業日（daycare_closed_dates）は0件
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
  if not private.care_auto_flag_on('input_enabled_bath') then
    return 0;
  end if;

  -- デイの休業日（app_settings の daycare_closed_dates に載っている日）は誰も自動にしない
  if exists (
       select 1
         from public.app_settings s
        cross join lateral pg_catalog.unnest(pg_catalog.string_to_array(s.value, ',')) d(v)
        where s.key = 'daycare_closed_dates'
          and pg_catalog.btrim(d.v) = pg_catalog.to_char(p_on, 'YYYY-MM-DD')) then
    return 0;
  end if;

  -- テナント（2つ以上なら例外で止まる）。週間計画の写しが無ければ予定が無い＝0件（下の src が空になる）
  v_tenant := private.care_auto_tenant();

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
revoke all on function private.care_auto_flag_on(text)        from public, anon, authenticated;
revoke all on function private.care_auto_tenant()             from public, anon, authenticated;
revoke all on function private.care_auto_med_on(text, date)   from public, anon, authenticated;
revoke all on function private.care_auto_med(text)            from public, anon, authenticated;
revoke all on function private.care_auto_bath_on(date)        from public, anon, authenticated;
revoke all on function private.care_auto_bath()               from public, anon, authenticated;

-- ---------- 4. 自動の印を外すトリガ（DB 側で強制・チーフ指摘6） ----------
-- 自動の記録（old.auto=true）の、引数に並べた列（区分・状態・理由・備考）のどれかが変わる更新なら new.auto を false にする。
-- アプリ（db.ts）も auto=false を送るが、古い画面・直接の更新でも印が外れるように DB でもそろえる。
-- 取り消し（deleted_at だけの更新）では外さない。before トリガは名前の順に動く（trg_auto_off_… → trg_updated_…）が、
-- set_updated_at_rev は updated_at と rev だけを触るので順は結果に影響しない。変更の記録（after）は外した後の行を残す。
create or replace function public.care_auto_off_on_edit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  k text;
begin
  if old.auto is true and new.auto is true then
    foreach k in array tg_argv loop
      if (pg_catalog.to_jsonb(old) -> k) is distinct from (pg_catalog.to_jsonb(new) -> k) then
        new.auto := false;
        exit;
      end if;
    end loop;
  end if;
  return new;
end
$fn$;

revoke all on function public.care_auto_off_on_edit() from public, anon, authenticated;

create or replace trigger trg_auto_off_bath_records
  before update on public.bath_records
  for each row execute function public.care_auto_off_on_edit('result', 'cancel_reason', 'note');
create or replace trigger trg_auto_off_med_admin
  before update on public.med_admin
  for each row execute function public.care_auto_off_on_edit('status', 'note', 'given_at', 'prn_drug', 'prn_reason', 'prn_effect');

-- ---------- 5. cron ジョブ（UTC で書く。日本時間 = UTC + 9 時間） ----------
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
      and p.proname in ('care_auto_today', 'care_auto_flag_on', 'care_auto_tenant', 'care_auto_med_on',
                        'care_auto_med', 'care_auto_bath_on', 'care_auto_bath'))           as functions_7,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'care\_auto\_%'
      and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute')))                 as callable_by_app_0,
  (select count(*) from information_schema.triggers
    where event_object_schema = 'public' and trigger_name in ('trg_auto_off_bath_records', 'trg_auto_off_med_admin')) as auto_off_triggers_2,
  (select count(*) from public.app_settings where key = 'daycare_closed_dates')          as closed_dates_key_1,
  (select count(*) from cron.job
    where jobname in ('care_auto_med_morning', 'care_auto_med_noon',
                      'care_auto_med_evening', 'care_auto_bath'))                          as cron_jobs_4;
