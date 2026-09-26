-- =====================================================================
-- 0016: 自動チェックの追加（眠前の与薬 21:00・デイの休業日は訪問介護での入浴として自動で記録）
--
-- 0001〜0015 を当てたあとに実行する（0015 の関数・cron・daycare_closed_dates を前提にする）。
-- 既存のテーブル・列・データは一切削除しない（関数の置き換え・check の差し替え・cron の追加・設定値の初期化だけ）。
--
-- ★初回のみ流す（必ず読む）:
--   **このファイルは初回に1回だけ流す。** 中の文はどれも「あれば触らない／同じ名前なら置き換える」形なので、
--   誤って2回流しても記録は増えず壊れないが、**修正が要る時は新しい番号のファイル（0017_… 等）を作って差分だけを流すこと**
--   （0012〜0015 と同じ運用）。do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため・0001 の注記）。
--   関数本体の as $fn$ … $fn$ は使ってよい（0011・0012・0015 と同じ）。
--   **このファイルを当ててからアプリを公開する**（アプリの区分「訪問介護で入浴」（visit）は、この check の差し替え前の DB では保存できない。
--   古いアプリのままこのファイルを当てても、眠前の自動の記録は通常の記録として出るので壊れない）。
--
-- 背景（2026-09-27 代表指示）:
--   ・与薬: 眠前も 21:00（日本時間）に自動で「服用済み」にする（朝・昼・夕と同じ扱い。除外条件も同じ）。
--   ・入浴: デイの休業日は日曜日と 12月31日〜1月3日。休業日は訪問介護に振り替えて入浴するので、入浴自体は実施する。
--           そこで休業日は、その曜日の入浴予定者を「訪問介護で入浴」（visit・デイの入浴介助加算の対象外）として自動で記録する。
--           日曜は週間計画にデイの予定が無いので従来どおり0件（変更なし）。
--
-- 変えるもの:
--   1. private.care_auto_med_on … 'bedtime'（眠前・21:00）を受け付ける。除外条件（在籍・服薬の時間帯・入院・外泊・外出・既にある記録・
--      入力の封鎖）は朝・昼・夕と同じ。外出の時刻判定は 21:00。本体の他の部分は 0015 と同じ
--   2. bath_records.result の check（bath_records_result_check・0012 で作った名前）に 'visit'（訪問介護で入浴）を足す（drop → add）
--   3. private.care_auto_daycare_closed(日付)（新設）… その日がデイの休業日か。app_settings の daycare_closed_dates は
--      カンマ区切りで、各項目は 'YYYY-MM-DD'（その日だけ）か 'MM-DD'（毎年くり返す）。前後の空白は無視する
--   4. private.care_auto_bath_on … 休業日なら予定者に result='visit'・auto=true で入れる（デイの入浴としては入れない）。
--      休業日でなければ従来どおり 'full'。予定の抽出・除外（退居・外部・入居前・入院・在籍でない・既にある記録）は 0015 と同じ
--   5. cron ジョブ care_auto_med_bedtime（'0 12 * * *'＝UTC 12:00＝日本時間 21:00・名前付き＝登録し直しても重複しない）
--   6. daycare_closed_dates の値を '12-31,01-01,01-02,01-03' にする（**既存値が空の時だけ**。空でなければ触らない＝現場で入れた値を戻さない）
--
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 1. 与薬: 眠前も自動にする ----------
-- 0015 の本体と同じ（変えたのは時刻の表に眠前 21:00 を足したことだけ）。挿入した件数を返す
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
  -- 自動にするのは朝・昼・夕・眠前（頓服は自動にしない）。時刻は代表指示（日本時間）
  v_at := case p_slot
            when 'morning' then time '08:50'
            when 'noon'    then time '13:00'
            when 'evening' then time '18:20'
            when 'bedtime' then time '21:00'
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
                    -- 外出・帰着未定: 外泊と同じく継続中（時刻は見ない）
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

-- ---------- 2. 入浴の区分に「訪問介護で入浴」（visit）を足す ----------
-- 制約名は 0012 で付けた bath_records_result_check（名前を付けて「落としてから作る」＝0012 と同じ作法）。
-- visit は理由を持たない（中止だけが理由を持つ＝bath_records_cancel_needs_reason はそのまま）
alter table public.bath_records drop constraint if exists bath_records_result_check;
alter table public.bath_records add constraint bath_records_result_check
  check (result in ('full', 'shower', 'partial', 'cancel', 'visit'));

comment on column public.bath_records.result is
  'full=全身浴 / shower=シャワー浴 / partial=部分浴・清拭 / cancel=中止 / visit=訪問介護で入浴（デイの休業日・デイの入浴介助加算の対象外。0016）';

-- ---------- 3. デイの休業日の判定 ----------
-- app_settings の daycare_closed_dates（カンマ区切り）に、その日が載っているか。
-- 各項目は 'YYYY-MM-DD'（その日だけ）か 'MM-DD'（毎年くり返す）。前後の空白は無視する。キーが無い・空なら休業日なし
create or replace function private.care_auto_daycare_closed(p_on date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from public.app_settings s
     cross join lateral pg_catalog.unnest(pg_catalog.string_to_array(s.value, ',')) d(v)
     where s.key = 'daycare_closed_dates'
       and pg_catalog.btrim(d.v) in (pg_catalog.to_char(p_on, 'YYYY-MM-DD'), pg_catalog.to_char(p_on, 'MM-DD')))
$fn$;

-- ---------- 4. 入浴: 休業日は訪問介護での入浴として入れる ----------
-- 0015 の本体と同じ（変えたのは、休業日に0件で返していたところを区分 visit で入れるようにしたことだけ）。挿入した件数を返す。
-- 予定の無い曜日（日曜など）は0件
create or replace function private.care_auto_bath_on(p_on date)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_tenant uuid;
  v_result text;
  v_n      integer;
begin
  if p_on is null then
    raise exception 'care_auto_bath: 日付がありません';
  end if;

  -- 入浴の入力が解禁されていない間は何もしない（封鎖中は画面から直せない）
  if not private.care_auto_flag_on('input_enabled_bath') then
    return 0;
  end if;

  -- デイの休業日（daycare_closed_dates）は訪問介護に振り替えて入浴する＝訪問介護で入浴（visit）。それ以外は全身浴（full）
  v_result := case when private.care_auto_daycare_closed(p_on) then 'visit' else 'full' end;

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
  select r.id, p_on, v_result, null, null, null, true,
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

comment on function private.care_auto_med(text) is
  '今日（日本時間）のその時間帯（morning/noon/evening/bedtime）の自動の与薬の記録を作る（pg_cron が呼ぶ）。挿入件数を返す。';
comment on function private.care_auto_bath() is
  '今日（日本時間）のデイの入浴予定者の自動の入浴の記録（全身浴。デイの休業日は訪問介護で入浴）を作る（pg_cron が呼ぶ）。挿入件数を返す。';

-- 権限: cron（postgres）だけが呼ぶ。create or replace は権限を保つが、新設の関数と合わせて剥がし直す
revoke all on function private.care_auto_med_on(text, date)     from public, anon, authenticated;
revoke all on function private.care_auto_daycare_closed(date)   from public, anon, authenticated;
revoke all on function private.care_auto_bath_on(date)          from public, anon, authenticated;

-- ---------- 5. cron ジョブ（UTC で書く。日本時間 = UTC + 9 時間） ----------
-- 与薬 眠前 … UTC 12:00 ＝ 日本時間 21:00（同じ日）。同じ名前で登録し直すと置き換わる（重複しない）
select cron.schedule('care_auto_med_bedtime', '0 12 * * *', 'select private.care_auto_med(''bedtime'')');

-- ---------- 6. デイの休業日の値 ----------
-- 12月31日〜1月3日（毎年くり返す 'MM-DD'）。既存値が空の時だけ入れる（空でなければ触らない＝現場で入れた値を戻さない）。
-- 日曜は週間計画にデイの予定が無いので、ここには書かない（書いても日曜は0件のまま）
insert into public.app_settings (key, value)
values ('daycare_closed_dates', '12-31,01-01,01-02,01-03')
on conflict (key) do nothing;
update public.app_settings
   set value = '12-31,01-01,01-02,01-03', updated_at = now()
 where key = 'daycare_closed_dates'
   and pg_catalog.btrim(value) = '';

-- PostgREST のスキーマキャッシュを即時リロード
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（結果が表で出る。目視する。列名の末尾が期待値）
-- ---------------------------------------------------------------------
select
  (select count(*) from cron.job
    where jobname = 'care_auto_med_bedtime' and schedule = '0 12 * * *')                   as bedtime_job_1,
  (select count(*) from cron.job
    where jobname in ('care_auto_med_morning', 'care_auto_med_noon', 'care_auto_med_evening',
                      'care_auto_med_bedtime', 'care_auto_bath'))                          as cron_jobs_5,
  (select count(*) from pg_constraint
    where conname = 'bath_records_result_check'
      and conrelid = 'public.bath_records'::regclass
      and pg_get_constraintdef(oid) like '%''visit''%')                                    as result_check_visit_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'care\_auto\_%'
      and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute')))                 as callable_by_app_0,
  (select value from public.app_settings where key = 'daycare_closed_dates')              as closed_dates_12_31_01_01_01_02_01_03;
