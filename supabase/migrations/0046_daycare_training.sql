-- =====================================================================
-- 0046: デイ（せせらぎ）の記録 段階3 — 個別機能訓練の実施記録・居宅訪問・計画書の期限の写し・その日の配置
--       （2026-10-23 代表者承認・計画の正本は【AI取締役】の 20261023_段階3_計画_v1.md の 3章）
--
-- 0001〜0045 を当てたあとに実行する。冪等（何度実行しても同じ結果）。既存の表・列・データ・関数・ポリシーは消さない・変えない。
-- 足すもの（すべて追加のみ）:
--   1. app_settings: input_enabled_daycare_training（値 'false'。既にあれば触らない）
--        機能訓練だけの入力解禁。デイの旗（input_enabled_daycare）・活動の旗とは別にし、試用中の段階1・2を止めずに閉じたまま出す。
--   2. daycare_training_sessions … 個別機能訓練の実施記録（1人1日1件）。完了・一部は 日時・内容・時間・指導員・結果 が必須。
--        中止は時間を持たず（していない訓練の時間を残さない）、理由が必須（その他は一言も）。
--   3. daycare_home_visits … 居宅訪問の記録（1人・1日・1目的に1件）。確かめた生活の状況は必須。説明の相手・日・内容は後日に足せる。
--   4. daycare_training_due … 計画書アプリの索引の期限の写し（1人1行）。期限の状態は持たない（表示の時に出す）。書くのは事務所・管理者。
--   5. daycare_training_due_settings … 写しの規則と間近の日数（1行だけ）。書くのは事務所・管理者（app_settings は 0022 で画面から
--        書けないので使わない）。
--   6. daycare_staffing … その日の配置（機能訓練指導員・看護職員。時間帯は任意）。
--   7. 関数 daycare_training_due_sync … 写しを1回の取引で入れ替える（空上書きの保護つき・security invoker＝書けるかは RLS が決める）。
--   8. 過去の日の守り … 実施記録と配置は、現場（field）のログインでは当日だけ（0042 と同じ作法のトリガ）。実施記録は未来の日を誰も
--        書けない。居宅訪問は守りの対象にしない（後日の記録・後日の説明を現場でもできる）が、未来の訪問日・説明の日は誰も書けない。
--   9. Realtime に実施記録・居宅訪問・配置を足す（既に載っていれば何もしない）。写しは載せない（事務所が写した時だけ変わる）。
--
-- RLS: 実施記録・居宅訪問・配置は 0041／0044 と同じ（読み書きとも許可リストの職員・delete のポリシーは作らない）。
--      写しとその設定は、読むのは許可リストの職員・書くのは事務所・管理者（0040 の private.office_writable() を呼ぶだけ・変えない）。
-- 物理削除はできない: delete のポリシーを作らず、authenticated から delete・truncate の権限も外す（0034・0044 と同じ）。
--
-- 触らないもの: 段階1・2の表と守り（daycare_days・daycare_attendance・daycare_activity_log・resident_vital_limits）・既存の旗・
--   週間計画・計画書アプリと計画書の GAS（書かない）・職員マスタ・勤務表・cron。
--
-- 旧クライアント×新サーバー: 旧版は新しい表を知らないので何も変わらない（機能訓練の画面が無いだけ）。
-- 新クライアント×旧サーバー（このファイルを当てる前に画面を出した時）: 機能訓練の画面は表が無い（42P01／PGRST205）を
--   「機能訓練はまだ使えません（サーバー側の設定待ち）」として入力を止める。旗の行が無い＝封鎖（既存の旗と同じ）。
-- 適用の順: DB 先 → アプリ。旗は false のまま公開 → 全端末の版を確かめる → 旗を true。
-- 戻す時（必要な時だけ）: 旗を 'false' に戻す（機能訓練だけ止まる。記録は残る）。表・値の追加は戻さない（記録は5年保存）。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 1. 機能訓練だけの入力解禁フラグ ----------
insert into public.app_settings (key, value)
values ('input_enabled_daycare_training', 'false')
on conflict (key) do nothing;

-- ---------- 2. 個別機能訓練の実施記録（1人1日1件） ----------
create table if not exists public.daycare_training_sessions (
  id             bigint generated always as identity primary key,
  resident_id    bigint not null references public.residents(id),
  day            date not null,                          -- 業務日（JST・クライアントが明示指定する）
  started_at     time not null,                          -- 開始時刻（中止の時は実施しようとした時刻）
  duration_min   smallint,                               -- 実施した時間（分）。中止の時は空
  program        text not null,                          -- 内容（100字まで・前後の空白なし）
  result         text not null,                          -- done=完了 / partial=一部 / cancelled=中止
  cancel_reason  text,                                   -- condition=体調不良 / refused=本人の希望 / time=時間が取れなかった / other=その他
  cancel_note    text,                                   -- その他の一言（100字まで）
  instructor_id  bigint not null references public.staff(id),   -- 直接実施した（実施しようとした）機能訓練指導員
  assisted_by    bigint references public.staff(id),            -- 補助した職員（任意）
  note           text,
  recorded_by    bigint references public.staff(id),
  rev            integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  deleted_by     bigint references public.staff(id),
  edited_by      bigint references public.staff(id),
  client_key     text unique
);
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_program_check;
alter table public.daycare_training_sessions add constraint daycare_training_sessions_program_check
  check (program = pg_catalog.btrim(program) and pg_catalog.char_length(program) between 1 and 100);
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_result_check;
alter table public.daycare_training_sessions add constraint daycare_training_sessions_result_check
  check (result in ('done', 'partial', 'cancelled'));
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_duration_check;
alter table public.daycare_training_sessions add constraint daycare_training_sessions_duration_check
  check (duration_min is null or duration_min between 1 and 240);
-- 実施した時（完了・一部）だけ時間がある。中止の時は時間を持たない
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_duration_result_check;
alter table public.daycare_training_sessions add constraint daycare_training_sessions_duration_result_check
  check ((result = 'cancelled') = (duration_min is null));
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_reason_check;
alter table public.daycare_training_sessions add constraint daycare_training_sessions_reason_check
  check (cancel_reason is null or cancel_reason in ('condition', 'refused', 'time', 'other'));
-- 中止の時だけ理由がある（両向き・0041 の欠席の理由と同じ）
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_reason_result_check;
alter table public.daycare_training_sessions add constraint daycare_training_sessions_reason_result_check
  check ((result = 'cancelled') = (cancel_reason is not null));
-- その他は一言が要る（空白だけは通さない）
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_other_note_check;
alter table public.daycare_training_sessions add constraint daycare_training_sessions_other_note_check
  check (cancel_reason is distinct from 'other' or (cancel_note is not null and pg_catalog.btrim(cancel_note) <> ''));
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_cancel_note_check;
alter table public.daycare_training_sessions add constraint daycare_training_sessions_cancel_note_check
  check (cancel_note is null or pg_catalog.char_length(cancel_note) <= 100);
alter table public.daycare_training_sessions drop constraint if exists daycare_training_sessions_note_check;
alter table public.daycare_training_sessions add constraint daycare_training_sessions_note_check
  check (note is null or pg_catalog.char_length(note) <= 200);
comment on table public.daycare_training_sessions is
  'デイの個別機能訓練の実施記録（1人1日1件）。完了・一部は時間が必須、中止は時間なし・理由が必須。指導員は直接実施した職員。';
comment on column public.daycare_training_sessions.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味（更新・削除のたびにアプリが送る）。';
-- 1人1日1件（生きている行だけ）
create unique index if not exists uq_daycare_training_session
  on public.daycare_training_sessions (resident_id, day)
  where deleted_at is null;
create index if not exists ix_daycare_training_session_day
  on public.daycare_training_sessions (day desc, id desc)
  where deleted_at is null;
create index if not exists ix_daycare_training_session_resident_day
  on public.daycare_training_sessions (resident_id, day desc)
  where deleted_at is null;
create or replace trigger trg_updated_daycare_training_sessions
  before update on public.daycare_training_sessions
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_daycare_training_sessions
  after update on public.daycare_training_sessions
  for each row execute function public.record_history_capture('day');

-- ---------- 3. 居宅訪問（1人・1日・1目的に1件） ----------
create table if not exists public.daycare_home_visits (
  id             bigint generated always as identity primary key,
  resident_id    bigint not null references public.residents(id),
  visited_on     date not null,
  visitor_id     bigint not null references public.staff(id),
  purpose        text not null,                          -- initial=初回（計画を作る前） / periodic=定期（3か月ごと）
  life_status    text not null,                          -- 確かめた生活の状況（500字まで）
  explained_to   text,                                   -- 説明した相手 user=本人 / family=家族 / both=両方（後日に足せる）
  explained_on   date,                                   -- 説明した日（訪問と別の日でもよい）
  explanation    text,                                   -- 説明の内容（500字まで）
  plan_revised   boolean not null default false,         -- 計画を見直したか
  recorded_by    bigint references public.staff(id),
  rev            integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  deleted_by     bigint references public.staff(id),
  edited_by      bigint references public.staff(id),
  client_key     text unique
);
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_purpose_check;
alter table public.daycare_home_visits add constraint daycare_home_visits_purpose_check
  check (purpose in ('initial', 'periodic'));
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_life_status_check;
alter table public.daycare_home_visits add constraint daycare_home_visits_life_status_check
  check (pg_catalog.char_length(pg_catalog.btrim(life_status)) between 1 and 500);
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_explained_to_check;
alter table public.daycare_home_visits add constraint daycare_home_visits_explained_to_check
  check (explained_to is null or explained_to in ('user', 'family', 'both'));
alter table public.daycare_home_visits drop constraint if exists daycare_home_visits_explanation_check;
alter table public.daycare_home_visits add constraint daycare_home_visits_explanation_check
  check (explanation is null or pg_catalog.char_length(explanation) <= 500);
comment on table public.daycare_home_visits is
  'デイの個別機能訓練の居宅訪問（1人・1日・1目的に1件）。生活の状況は必須。説明の相手・日・内容は後日に足せる（片方ずつでもよい）。';
create unique index if not exists uq_daycare_home_visit
  on public.daycare_home_visits (resident_id, visited_on, purpose)
  where deleted_at is null;
create index if not exists ix_daycare_home_visit_resident
  on public.daycare_home_visits (resident_id, visited_on desc)
  where deleted_at is null;
create or replace trigger trg_updated_daycare_home_visits
  before update on public.daycare_home_visits
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_daycare_home_visits
  after update on public.daycare_home_visits
  for each row execute function public.record_history_capture('visited_on');

-- ---------- 4. 計画書の期限の写し（1人1行・事務所・管理者が書く） ----------
create table if not exists public.daycare_training_due (
  id                bigint generated always as identity primary key,
  resident_id       bigint not null references public.residents(id),
  latest_plan_date  date,                                -- 最新の計画の作成日
  next_due          date,                                -- 次の期限（計画書アプリの計算のまま）
  stop_reason       text,                                -- 通知を止めた理由 discharge / stopped / notNeeded
  stop_from         date,                                -- 通知を止めた日
  plan_status       text,                                -- 計画書の状態 none / draft_ai / reviewed / printed / signed
  synced_at         timestamptz not null,
  synced_by         bigint references public.staff(id),
  rev               integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        bigint references public.staff(id)
);
alter table public.daycare_training_due drop constraint if exists daycare_training_due_stop_reason_check;
alter table public.daycare_training_due add constraint daycare_training_due_stop_reason_check
  check (stop_reason is null or stop_reason in ('discharge', 'stopped', 'notNeeded'));
alter table public.daycare_training_due drop constraint if exists daycare_training_due_plan_status_check;
alter table public.daycare_training_due add constraint daycare_training_due_plan_status_check
  check (plan_status is null or plan_status in ('none', 'draft_ai', 'reviewed', 'printed', 'signed'));
comment on table public.daycare_training_due is
  '計画書アプリの索引（training_plan:index）から写した期限（1人1行）。氏名・疾患・計画の本文は持たない。状態は表示の時に出す。';
create unique index if not exists uq_daycare_training_due
  on public.daycare_training_due (resident_id)
  where deleted_at is null;
create or replace trigger trg_updated_daycare_training_due
  before update on public.daycare_training_due
  for each row execute function public.set_updated_at_rev();

-- ---------- 5. 写しの規則と間近の日数（1行だけ） ----------
create table if not exists public.daycare_training_due_settings (
  id          smallint primary key default 1,
  due_rule    text not null default 'calendar',          -- calendar=暦の月 / days90=90日 / min=早い方
  warn_days   smallint not null default 28,              -- 期限の何日前から「間近」か（0〜365）
  synced_at   timestamptz,
  synced_by   bigint references public.staff(id),
  updated_at  timestamptz not null default now()
);
alter table public.daycare_training_due_settings drop constraint if exists daycare_training_due_settings_one_row;
alter table public.daycare_training_due_settings add constraint daycare_training_due_settings_one_row check (id = 1);
alter table public.daycare_training_due_settings drop constraint if exists daycare_training_due_settings_rule_check;
alter table public.daycare_training_due_settings add constraint daycare_training_due_settings_rule_check
  check (due_rule in ('calendar', 'days90', 'min'));
alter table public.daycare_training_due_settings drop constraint if exists daycare_training_due_settings_warn_check;
alter table public.daycare_training_due_settings add constraint daycare_training_due_settings_warn_check
  check (warn_days between 0 and 365);
comment on table public.daycare_training_due_settings is
  '計画書アプリの期限の規則と間近の日数の写し（1行だけ）。写しのたびに上書きする。行が無い時は暦の月・28日。';

-- ---------- 6. その日の配置 ----------
create table if not exists public.daycare_staffing (
  id           bigint generated always as identity primary key,
  day          date not null,
  staff_id     bigint not null references public.staff(id),
  role         text not null,                            -- trainer=機能訓練指導員 / nurse=看護職員
  from_time    time,                                     -- 時間帯（任意）
  to_time      time,
  note         text,
  recorded_by  bigint references public.staff(id),
  rev          integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   bigint references public.staff(id),
  edited_by    bigint references public.staff(id),
  client_key   text unique
);
alter table public.daycare_staffing drop constraint if exists daycare_staffing_role_check;
alter table public.daycare_staffing add constraint daycare_staffing_role_check
  check (role in ('trainer', 'nurse'));
alter table public.daycare_staffing drop constraint if exists daycare_staffing_time_check;
alter table public.daycare_staffing add constraint daycare_staffing_time_check
  check (from_time is null or to_time is null or from_time < to_time);
alter table public.daycare_staffing drop constraint if exists daycare_staffing_note_check;
alter table public.daycare_staffing add constraint daycare_staffing_note_check
  check (note is null or pg_catalog.char_length(note) <= 100);
comment on table public.daycare_staffing is
  'デイのその日の配置（機能訓練指導員・看護職員）。職員が手で入れる（勤務表から取らない）。時間帯は任意で、同じ方の同じ役割を2つの時間帯に書ける。';
create unique index if not exists uq_daycare_staffing
  on public.daycare_staffing (day, staff_id, role, coalesce(from_time, '00:00'::time))
  where deleted_at is null;
create index if not exists ix_daycare_staffing_day
  on public.daycare_staffing (day desc, id)
  where deleted_at is null;
create or replace trigger trg_updated_daycare_staffing
  before update on public.daycare_staffing
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_daycare_staffing
  after update on public.daycare_staffing
  for each row execute function public.record_history_capture('day');

-- ---------- 7. 過去の日・未来の日の守り ----------
-- 実施記録と配置: 現場（field）のログインは当日だけ（0042 と同じ作法: security definer・役割 null と office／admin は止めない・
-- my_role() が無い DB では止めない）。実施記録は未来の日を誰も書けない（役割を問わない）。
create or replace function public.daycare_training_day_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_role text;
begin
  -- 実施記録は未来の日を書けない（業務日を先に送ると、まだ行っていない訓練が記録に残る）
  if tg_table_name = 'daycare_training_sessions' and new.day > v_today
     and (tg_op = 'INSERT' or new.day is distinct from old.day) then
    raise exception 'daycare_training_future: まだ来ていない日の機能訓練は記録できません'
      using errcode = '22023';
  end if;
  -- 当日・未来の日だけに関わる書き込みは止めない
  if tg_op = 'INSERT' then
    if new.day >= v_today then
      return new;
    end if;
  else
    if new.day >= v_today and old.day >= v_today then
      return new;
    end if;
  end if;
  if to_regprocedure('private.my_role()') is null then
    return new;
  end if;
  execute 'select private.my_role()' into v_role;
  if v_role is distinct from 'field' then
    return new;
  end if;
  raise exception 'daycare_training_past_office_only: 過去の日の機能訓練の記録と配置は、事務所のログインでだけ入力・修正できます（現場の端末は当日だけ）'
    using errcode = '42501',
          hint = '事務所（office・admin）のログインで入力してください。居宅訪問は現場でも後日に記録できます';
end;
$fn$;
comment on function public.daycare_training_day_guard() is
  '現場（field）のログインの、過去の日（JST）の daycare_training_sessions・daycare_staffing への書き込みを 42501・daycare_training_past_office_only: … で止める。実施記録の未来の日は役割を問わず 22023。0046。';
revoke all on function public.daycare_training_day_guard() from public, anon, authenticated;
create or replace trigger trg_daycare_training_sessions_day_guard
  before insert or update on public.daycare_training_sessions
  for each row execute function public.daycare_training_day_guard();
create or replace trigger trg_daycare_staffing_day_guard
  before insert or update on public.daycare_staffing
  for each row execute function public.daycare_training_day_guard();

-- 居宅訪問: 過去の日は止めない（後日の記録・後日の説明）。未来の訪問日・説明の日は誰も書けない
create or replace function public.daycare_home_visit_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if new.visited_on > v_today and (tg_op = 'INSERT' or new.visited_on is distinct from old.visited_on) then
    raise exception 'daycare_home_visit_future: まだ来ていない日の居宅訪問は記録できません'
      using errcode = '22023';
  end if;
  if new.explained_on is not null and new.explained_on > v_today
     and (tg_op = 'INSERT' or new.explained_on is distinct from old.explained_on) then
    raise exception 'daycare_home_visit_future: まだ来ていない日の説明は記録できません'
      using errcode = '22023';
  end if;
  return new;
end;
$fn$;
comment on function public.daycare_home_visit_guard() is
  'daycare_home_visits の未来の訪問日・説明の日を 22023・daycare_home_visit_future: … で止める（役割を問わない）。過去の日は止めない。0046。';
revoke all on function public.daycare_home_visit_guard() from public, anon;
create or replace trigger trg_daycare_home_visits_guard
  before insert or update on public.daycare_home_visits
  for each row execute function public.daycare_home_visit_guard();

-- ---------- 8. RLS ----------
-- 実施記録・居宅訪問・配置: 0041／0044 と同じ（読み書きとも許可リストの職員・delete のポリシーは作らない）
alter table public.daycare_training_sessions enable row level security;
drop policy if exists "read_auth"   on public.daycare_training_sessions;
drop policy if exists "insert_auth" on public.daycare_training_sessions;
drop policy if exists "update_auth" on public.daycare_training_sessions;
drop policy if exists member_only   on public.daycare_training_sessions;
create policy "read_auth"   on public.daycare_training_sessions for select to authenticated using (true);
create policy "insert_auth" on public.daycare_training_sessions for insert to authenticated with check (true);
create policy "update_auth" on public.daycare_training_sessions for update to authenticated using (true) with check (true);
create policy member_only on public.daycare_training_sessions as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());
revoke all on public.daycare_training_sessions from anon;
revoke delete, truncate on public.daycare_training_sessions from authenticated;

alter table public.daycare_home_visits enable row level security;
drop policy if exists "read_auth"   on public.daycare_home_visits;
drop policy if exists "insert_auth" on public.daycare_home_visits;
drop policy if exists "update_auth" on public.daycare_home_visits;
drop policy if exists member_only   on public.daycare_home_visits;
create policy "read_auth"   on public.daycare_home_visits for select to authenticated using (true);
create policy "insert_auth" on public.daycare_home_visits for insert to authenticated with check (true);
create policy "update_auth" on public.daycare_home_visits for update to authenticated using (true) with check (true);
create policy member_only on public.daycare_home_visits as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());
revoke all on public.daycare_home_visits from anon;
revoke delete, truncate on public.daycare_home_visits from authenticated;

alter table public.daycare_staffing enable row level security;
drop policy if exists "read_auth"   on public.daycare_staffing;
drop policy if exists "insert_auth" on public.daycare_staffing;
drop policy if exists "update_auth" on public.daycare_staffing;
drop policy if exists member_only   on public.daycare_staffing;
create policy "read_auth"   on public.daycare_staffing for select to authenticated using (true);
create policy "insert_auth" on public.daycare_staffing for insert to authenticated with check (true);
create policy "update_auth" on public.daycare_staffing for update to authenticated using (true) with check (true);
create policy member_only on public.daycare_staffing as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());
revoke all on public.daycare_staffing from anon;
revoke delete, truncate on public.daycare_staffing from authenticated;

-- 写しとその設定: 読むのは許可リストの職員・書くのは事務所・管理者（0040 の private.office_writable() を呼ぶだけ）
alter table public.daycare_training_due enable row level security;
drop policy if exists "read_auth"     on public.daycare_training_due;
drop policy if exists "insert_office" on public.daycare_training_due;
drop policy if exists "update_office" on public.daycare_training_due;
drop policy if exists member_only     on public.daycare_training_due;
create policy "read_auth"     on public.daycare_training_due for select to authenticated using (true);
create policy "insert_office" on public.daycare_training_due for insert to authenticated
  with check (private.office_writable());
create policy "update_office" on public.daycare_training_due for update to authenticated
  using (true) with check (private.office_writable());
create policy member_only on public.daycare_training_due as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());
revoke all on public.daycare_training_due from anon;
revoke delete, truncate on public.daycare_training_due from authenticated;

alter table public.daycare_training_due_settings enable row level security;
drop policy if exists "read_auth"     on public.daycare_training_due_settings;
drop policy if exists "insert_office" on public.daycare_training_due_settings;
drop policy if exists "update_office" on public.daycare_training_due_settings;
drop policy if exists member_only     on public.daycare_training_due_settings;
create policy "read_auth"     on public.daycare_training_due_settings for select to authenticated using (true);
create policy "insert_office" on public.daycare_training_due_settings for insert to authenticated
  with check (private.office_writable());
create policy "update_office" on public.daycare_training_due_settings for update to authenticated
  using (true) with check (private.office_writable());
create policy member_only on public.daycare_training_due_settings as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());
revoke all on public.daycare_training_due_settings from anon;
revoke delete, truncate on public.daycare_training_due_settings from authenticated;

-- ---------- 9. 写しを1回の取引で入れ替える ----------
-- p_rows: [{ master_id, latest_plan_date, next_due, stop_reason, stop_from, plan_status }]（端末で値をそろえてから送る）
-- p_settings: { due_rule, warn_days }。p_staff: 写した職員
-- 書けるかは RLS（事務所・管理者）が決める（security invoker）。先に役割を確かめ、現場なら何も読まずに 42501。
-- 次の時は何も書かずに止め、理由を返す（空上書きの保護）:
--   empty     … 来た行が0件で、今ある行が1件以上
--   nomatch   … 結べた行が0件で、今ある行が1件以上（接続先の取り違え・番号の書式の違いなど）
--   too_many  … 取り消す件数が、今ある行の半数を超える
create or replace function public.daycare_training_due_sync(p_rows jsonb, p_settings jsonb, p_staff bigint)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_existing integer;
  v_incoming integer;
  v_matched integer;
  v_matched_rows integer;
  v_cancel integer;
  v_in jsonb;
  v_now timestamptz := now();
  v_rule text;
  v_warn integer;
begin
  if not private.office_writable() then
    raise exception 'training_due_office_only: 計画書の期限の写しは、事務所のログインでだけ行えます'
      using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'training_due_bad_rows: 写しの行の形が違います' using errcode = '22023';
  end if;
  v_rule := coalesce(p_settings->>'due_rule', 'calendar');
  if v_rule not in ('calendar', 'days90', 'min') then
    v_rule := 'calendar';
  end if;
  v_warn := case when (p_settings->>'warn_days') ~ '^[0-9]{1,3}$' then (p_settings->>'warn_days')::integer else 28 end;
  if v_warn > 365 then
    v_warn := 28;
  end if;

  select count(*) into v_existing from public.daycare_training_due where deleted_at is null;
  v_incoming := pg_catalog.jsonb_array_length(p_rows);

  -- 利用者番号（residents.source_id）で結べた行だけを、値をそろえて集める。同じ方が2行来たら、後ろの行を採る（決め手を固定）
  select coalesce(pg_catalog.jsonb_agg(x), '[]'::jsonb) into v_in
    from (
      select distinct on (r.id)
             r.id as resident_id,
             nullif(e.v->>'latest_plan_date', '')::date as latest_plan_date,
             nullif(e.v->>'next_due', '')::date as next_due,
             case when e.v->>'stop_reason' in ('discharge', 'stopped', 'notNeeded') then e.v->>'stop_reason' end as stop_reason,
             nullif(e.v->>'stop_from', '')::date as stop_from,
             case when e.v->>'plan_status' in ('none', 'draft_ai', 'reviewed', 'printed', 'signed') then e.v->>'plan_status' end as plan_status
        from pg_catalog.jsonb_array_elements(p_rows) with ordinality as e(v, ord)
        join public.residents r on r.source_id = e.v->>'master_id'
       order by r.id, e.ord desc
    ) x;
  v_matched := pg_catalog.jsonb_array_length(v_in);
  -- 結べなかった行の数は、来た行のうち番号で結べなかった行の数（同じ方の2行目は「結べた」に数える）
  select count(*) into v_matched_rows
    from pg_catalog.jsonb_array_elements(p_rows) as e
    join public.residents r on r.source_id = e->>'master_id';
  select count(*) into v_cancel
    from public.daycare_training_due d
   where d.deleted_at is null
     and not exists (select 1 from pg_catalog.jsonb_to_recordset(v_in) as i(resident_id bigint) where i.resident_id = d.resident_id);

  if v_incoming = 0 and v_existing > 0 then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'empty', 'existing', v_existing);
  end if;
  if v_matched = 0 and v_existing > 0 then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'nomatch', 'existing', v_existing, 'incoming', v_incoming);
  end if;
  if v_existing > 0 and v_cancel * 2 > v_existing then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'too_many', 'existing', v_existing, 'cancel', v_cancel);
  end if;

  -- 今ある行を更新（値が同じでも写した日時は進める）
  update public.daycare_training_due d
     set latest_plan_date = i.latest_plan_date, next_due = i.next_due, stop_reason = i.stop_reason,
         stop_from = i.stop_from, plan_status = i.plan_status, synced_at = v_now, synced_by = p_staff
    from pg_catalog.jsonb_to_recordset(v_in)
         as i(resident_id bigint, latest_plan_date date, next_due date, stop_reason text, stop_from date, plan_status text)
   where d.resident_id = i.resident_id and d.deleted_at is null;
  -- 無い方は足す
  insert into public.daycare_training_due (resident_id, latest_plan_date, next_due, stop_reason, stop_from, plan_status, synced_at, synced_by)
  select i.resident_id, i.latest_plan_date, i.next_due, i.stop_reason, i.stop_from, i.plan_status, v_now, p_staff
    from pg_catalog.jsonb_to_recordset(v_in)
         as i(resident_id bigint, latest_plan_date date, next_due date, stop_reason text, stop_from date, plan_status text)
   where not exists (select 1 from public.daycare_training_due d where d.resident_id = i.resident_id and d.deleted_at is null);
  -- 今回来なかった方は取り消しの印（物理削除はしない）
  update public.daycare_training_due d
     set deleted_at = v_now, deleted_by = p_staff
   where d.deleted_at is null
     and not exists (select 1 from pg_catalog.jsonb_to_recordset(v_in) as i(resident_id bigint) where i.resident_id = d.resident_id);
  -- 規則と日数
  insert into public.daycare_training_due_settings (id, due_rule, warn_days, synced_at, synced_by, updated_at)
  values (1, v_rule, v_warn, v_now, p_staff, v_now)
  on conflict (id) do update
    set due_rule = excluded.due_rule, warn_days = excluded.warn_days,
        synced_at = excluded.synced_at, synced_by = excluded.synced_by, updated_at = excluded.updated_at;

  return pg_catalog.jsonb_build_object('ok', true, 'written', v_matched, 'unmatched', v_incoming - v_matched_rows,
                                       'cancelled', v_cancel, 'synced_at', v_now);
end;
$fn$;
comment on function public.daycare_training_due_sync(jsonb, jsonb, bigint) is
  '計画書アプリの索引の期限を daycare_training_due に写す（1回の取引・利用者番号で結ぶ・空上書きの保護つき）。事務所・管理者だけ。0046。';
revoke all on function public.daycare_training_due_sync(jsonb, jsonb, bigint) from public, anon;
grant execute on function public.daycare_training_due_sync(jsonb, jsonb, bigint) to authenticated;

-- ---------- 10. Realtime（実施記録・居宅訪問・配置） ----------
create or replace function pg_temp.cl_realtime_add(p_table text)
returns void
language plpgsql
as $fn$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_catalog.pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = p_table) then
    execute pg_catalog.format('alter publication supabase_realtime add table public.%I', p_table);
  end if;
end;
$fn$;

select pg_temp.cl_realtime_add('daycare_training_sessions');
select pg_temp.cl_realtime_add('daycare_home_visits');
select pg_temp.cl_realtime_add('daycare_staffing');

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（結果が表で出る。目視する）
-- ---------------------------------------------------------------------
select
  (select count(*) from public.app_settings where key = 'input_enabled_daycare_training')                as training_flag_1,
  (select count(*) from information_schema.tables where table_schema = 'public'
    and table_name in ('daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due',
                       'daycare_training_due_settings', 'daycare_staffing'))                              as tables_5,
  (select count(*) from pg_policies where schemaname = 'public'
    and tablename in ('daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due',
                      'daycare_training_due_settings', 'daycare_staffing')
    and policyname = 'member_only' and permissive = 'RESTRICTIVE')                                        as member_only_5,
  (select count(*) from pg_policies where schemaname = 'public'
    and tablename in ('daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due',
                      'daycare_training_due_settings', 'daycare_staffing') and cmd = 'DELETE')            as delete_policies_0,
  (select count(*) from information_schema.role_table_grants where table_schema = 'public'
    and table_name in ('daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due',
                       'daycare_training_due_settings', 'daycare_staffing')
    and grantee in ('authenticated', 'anon') and privilege_type in ('DELETE', 'TRUNCATE'))                as delete_grants_0,
  (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
    and tablename in ('daycare_training_sessions', 'daycare_home_visits', 'daycare_staffing'))            as realtime_3;
