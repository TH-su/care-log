-- =====================================================================
-- 0014: 事故・ヒヤリハットの記録（incidents）＋ 事故報告書に刷る事業所の情報（app_settings のキー）
--
-- 0001〜0013 を当てたあとに実行する。既存のテーブル・列・データは一切削除しない（追加のみ）。
--
-- ★再実行について（必ず読む）:
--   **このファイルは初回に1回だけ流す。2回目以降は「Realtime への登録（alter publication … add table）」の文で
--   「既に登録済み（42710）」のエラーになり、ファイル全体が巻き戻る（それより前の文の変更も入らない）。**
--   したがって、このファイルを書き換えて流し直すことで修正はできない。
--   **修正が要る時は、新しい番号のファイル（0015_… 等）を作って、その差分だけを流すこと。**
--   do $$ … $$ のブロック（登録済みかを確かめてから足す書き方）は使えない
--   （Supabase の SQL エディタが誤解釈するため・0001 の注記）。そのため登録の1文をファイルの最後の方へ置いた。
--   ※0001 / 0003 の「alter publication … set table（一覧の置き換え）」を後から流し直すと、
--     incidents が配信対象から外れる。その場合はこのファイルの alter publication 文だけを流し直す。
--
-- 背景（2026-09-26 代表承認）:
--   事故・ヒヤリハットは今は紙で運用している。care-log に記録し、熊本市へ出す「事故報告書（事業者→熊本市）」の
--   様式で A4 縦に印刷できるようにする。第1報に要る最小の項目だけで保存でき、残りの欄は後から追記する（rev 照合）。
--   入力解禁は app_settings の input_enabled_incident（0012 で 'false' を入れ済み）。身体拘束の記録はここでは作らない。
--
-- 追加するもの:
--   1. app_settings: 事故報告書に刷る事業所の情報のキー（値 ''。既にあれば触らない）
--        corp_name（法人名）／office_name_facility・office_name_visit・office_name_daycare（事業所名）／
--        office_no_facility・office_no_visit・office_no_daycare（事業所番号）／office_address（所在地）
--      ★値はこのファイルに書かない（公開リポジトリ）。チーフが本番の SQL エディタで入れる:
--        update public.app_settings set value = '（値）' where key = 'corp_name';
--      空のままなら、印刷はその欄を手書き用の空欄で刷る
--   2. incidents 表（soft delete・rev 楽観ロック・変更の記録トリガ・RLS＋member_only）
--   3. 対象者の氏名の写しを入れるトリガ（アプリは氏名を送らない。サーバーで名簿から写す・前の写しを残す・印があれば名簿の氏名で写し直す）
--   4. Realtime への登録（初回のみ。上の注記）
--
-- 個人情報: このファイルに実在の氏名・記録本文・事業所の名前・番号・住所・電話番号を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 1. 事故報告書に刷る事業所の情報（値は空。チーフが本番で入れる） ----------
insert into public.app_settings (key, value)
values
  ('corp_name', ''),
  ('office_name_facility', ''),
  ('office_name_visit', ''),
  ('office_name_daycare', ''),
  ('office_no_facility', ''),
  ('office_no_visit', ''),
  ('office_no_daycare', ''),
  ('office_address', '')
on conflict (key) do nothing;

-- ---------- 2. 事故・ヒヤリハット ----------
-- 1行 = 1件。列で持つのは一覧・集計・絞り込みに使う項目だけ。様式の残りの欄は detail（jsonb）に持つ
-- （欄のキーはアプリの src/lib/types.ts の IncidentDetail が正本。キーは平らに持つ）。
-- 選択肢のキー（アプリの types.ts の INCIDENT_* と同じ）:
--   kind      accident=事故 / nearmiss=ヒヤリハット
--   office    facility=入所 / visit=訪問 / daycare=通所（様式のサービス種別）
--   place     room_private=居室（個室）/ room_shared=居室（多床室）/ toilet=トイレ / hallway=廊下 / common=食堂等共用部 /
--             bathroom=浴室・脱衣室 / training=機能訓練室 / premises=施設敷地内の建物外 / offsite=敷地外 / other=その他（place_other）
--   types     fall=転倒 / fall_from=転落 / aspiration=誤嚥・窒息 / pica=異食 / med_error=誤薬、与薬もれ等 /
--             medical=医療処置関連（チューブ抜去等）/ unknown=不明 / other=その他（複数選択可）
--   severity  treated=受診(外来･往診)、自施設で応急処置 / hospitalized=入院 / death=死亡 / other=その他
--   status    open=対応中 / closed=完了（closed_at＝完了にした日時。完了の時だけ値を持つ）
--   report_stage  first=第1報 / nth=第＿報（report_no）/ final=最終報告
-- occurred_on は発生日（JST・クライアントが明示指定する）。occurred_at は発生日時。
-- client_key は端末生成の冪等キー（全体 unique ＝削除済みの行もキーを押さえたまま。0012 と同じ考え方）。自然キーは持たない。
create table if not exists public.incidents (
  id                 bigint generated always as identity primary key,
  kind               text not null,
  resident_id        bigint references public.residents(id),   -- ヒヤリハットは null（対象者なし）も可
  occurred_on        date not null,
  occurred_at        timestamptz not null,
  office             text,
  place              text,
  place_other        text,
  types              text[] not null,
  severity           text,
  status             text not null default 'open',
  closed_at          timestamptz,                               -- 完了にした日時（対応中に戻したら null。委員会集計の「月末時点で未完了」の判定に使う）
  report_stage       text,
  report_no          int,
  submitted_on       date,
  city_report_needed boolean not null default false,          -- 市への報告が必要（人が判断して付ける）
  city_reported_on   date,
  reporter_id        bigint references public.staff(id),       -- 記録者
  confirmer_id       bigint references public.staff(id),       -- 確認者（権限の強制はまだ無い）
  confirmed_at       timestamptz,
  detail             jsonb not null default '{}'::jsonb,
  rev                int not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_by         bigint references public.staff(id),
  edited_by          bigint references public.staff(id),       -- 最後にこの行を書き換えた職員（0010 と同じ意味）
  client_key         text unique
);

-- 制約は名前を付けて「落としてから作る」（定義を差し替えられる）
alter table public.incidents drop constraint if exists incidents_kind_check;
alter table public.incidents add constraint incidents_kind_check
  check (kind in ('accident', 'nearmiss'));

-- 事故は対象者が必須（対象者なしはヒヤリハットだけ）
alter table public.incidents drop constraint if exists incidents_accident_needs_resident;
alter table public.incidents add constraint incidents_accident_needs_resident
  check (kind <> 'accident' or resident_id is not null);

alter table public.incidents drop constraint if exists incidents_office_check;
alter table public.incidents add constraint incidents_office_check
  check (office is null or office in ('facility', 'visit', 'daycare'));

alter table public.incidents drop constraint if exists incidents_place_check;
alter table public.incidents add constraint incidents_place_check
  check (place is null or place in ('room_private', 'room_shared', 'toilet', 'hallway', 'common',
                                    'bathroom', 'training', 'premises', 'offsite', 'other'));

-- 種別は1つ以上・選択肢のキーだけ（null の要素も不可。array_position で null を探す）
alter table public.incidents drop constraint if exists incidents_types_check;
alter table public.incidents add constraint incidents_types_check
  check (
    cardinality(types) >= 1
    and types <@ array['fall', 'fall_from', 'aspiration', 'pica', 'med_error', 'medical', 'unknown', 'other']::text[]
    and array_position(types, null) is null
  );

alter table public.incidents drop constraint if exists incidents_severity_check;
alter table public.incidents add constraint incidents_severity_check
  check (severity is null or severity in ('treated', 'hospitalized', 'death', 'other'));

alter table public.incidents drop constraint if exists incidents_status_check;
alter table public.incidents add constraint incidents_status_check
  check (status in ('open', 'closed'));

-- 完了（closed）の時だけ完了にした日時を持つ（対応中は null）。アプリは状態と一緒に送る
alter table public.incidents drop constraint if exists incidents_closed_at_check;
alter table public.incidents add constraint incidents_closed_at_check
  check ((status = 'closed') = (closed_at is not null));

alter table public.incidents drop constraint if exists incidents_report_stage_check;
alter table public.incidents add constraint incidents_report_stage_check
  check (report_stage is null or report_stage in ('first', 'nth', 'final'));

alter table public.incidents drop constraint if exists incidents_report_no_check;
alter table public.incidents add constraint incidents_report_no_check
  check (report_no is null or report_no between 1 and 99);

-- detail は jsonb のオブジェクト（配列・文字などは不可）
alter table public.incidents drop constraint if exists incidents_detail_check;
alter table public.incidents add constraint incidents_detail_check
  check (jsonb_typeof(detail) = 'object');

comment on table public.incidents is
  '事故・ヒヤリハットの記録（1行=1件）。様式は熊本市の事故報告書（事業者→熊本市）。様式の残りの欄は detail（jsonb）。';
comment on column public.incidents.detail is
  '様式の残りの欄（キーはアプリの types.ts の IncidentDetail が正本）。subject_name は記録時点の対象者の氏名の写し（トリガが入れる）。';
comment on column public.incidents.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味（更新・削除のたびにアプリが送る）。';

-- 一覧（発生日の新しい順）・月次集計
create index if not exists idx_incidents_timeline
  on public.incidents (occurred_on desc, id desc)
  where deleted_at is null;

-- 個人カルテ（利用者 × 期間）
create index if not exists idx_incidents_resident
  on public.incidents (resident_id, occurred_on desc)
  where deleted_at is null;

-- ---------- 3. 対象者の氏名の写し ----------
-- アプリは対象者の氏名を送らない（画面でも直せない。氏名は名簿の値だけを使う・送信待ち＝端末の保存領域に氏名を置かないため）。
-- 氏名が無い時（空・null・キーなし）は、ここで:
--   ・追加 … 名簿（residents.name）の氏名を写す
--   ・更新 … 対象者が同じなら前の写しを残す／対象者を変えたら新しい対象者の氏名を写す
--   ・対象者なし（ヒヤリハット）… 何もしない
-- 「名簿の氏名に合わせる」: アプリは氏名の代わりに detail へ一時の印 _resync_subject_name を入れて送る。
--   印がある時は、印を取り除いてから、名簿の現在の氏名で写し直す（他の欄は変えない）。印は行に残さない
-- security invoker（呼んだ職員の権限で residents を読む）。search_path は空にし、全部の名前を修飾する。
create or replace function public.incidents_subject_snapshot() returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  resync boolean := false;
begin
  -- detail が無い・オブジェクトでない時は触らない（not null・incidents_detail_check がそのまま弾く）
  if new.detail is null or pg_catalog.jsonb_typeof(new.detail) <> 'object' then
    return new;
  end if;
  if new.detail ? '_resync_subject_name' then
    resync := true;
    new.detail := new.detail - '_resync_subject_name';
  end if;
  if new.resident_id is null then
    return new;
  end if;
  if not resync and coalesce(pg_catalog.btrim(new.detail ->> 'subject_name'), '') <> '' then
    return new;
  end if;
  if not resync
     and tg_op = 'UPDATE'
     and old.resident_id is not distinct from new.resident_id
     and coalesce(pg_catalog.btrim(old.detail ->> 'subject_name'), '') <> '' then
    new.detail := new.detail || pg_catalog.jsonb_build_object('subject_name', old.detail -> 'subject_name');
  else
    new.detail := new.detail || pg_catalog.jsonb_build_object(
      'subject_name', (select r.name from public.residents r where r.id = new.resident_id));
  end if;
  return new;
end;
$fn$;

revoke all on function public.incidents_subject_snapshot() from public, anon;

create or replace trigger trg_incidents_subject_snapshot
  before insert or update on public.incidents
  for each row execute function public.incidents_subject_snapshot();

-- updated_at ＋ rev 自動加算（0001）／変更の記録（0010。業務日付の列は occurred_on）
create or replace trigger trg_updated_incidents
  before update on public.incidents
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_incidents
  after update on public.incidents
  for each row execute function public.record_history_capture('occurred_on');

-- RLS（0012・0013 と同じ方針: 読み書きとも authenticated 限定・delete ポリシーは作らない＝物理削除は構造的に不可）
alter table public.incidents enable row level security;
drop policy if exists "read_auth"   on public.incidents;
drop policy if exists "insert_auth" on public.incidents;
drop policy if exists "update_auth" on public.incidents;
drop policy if exists member_only   on public.incidents;
create policy "read_auth"   on public.incidents for select to authenticated using (true);
create policy "insert_auth" on public.incidents for insert to authenticated with check (true);
create policy "update_auth" on public.incidents for update to authenticated using (true) with check (true);
-- 許可リストの有効な人だけ（care-backend 0001_foundation.sql の member_only と同じ形）。restrictive は上の3つと AND で効く
create policy member_only on public.incidents as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());

-- ---------- 4. Realtime（初回のみ。2回目以降はこの文で止まる＝冒頭の注記） ----------
-- set table（一覧の置き換え）は使わない。add table は既に載っていると 42710 で止まる（それ以前の文は冪等）。
alter publication supabase_realtime add table public.incidents;

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST205 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（結果が表で出る。目視する。列名の末尾の数が期待値）
-- ---------------------------------------------------------------------
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'incidents')                          as incident_table_1,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'incidents')                             as incident_policies_4,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'incidents'
      and policyname = 'member_only' and permissive = 'RESTRICTIVE')                     as incident_member_only_1,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'incidents' and cmd = 'DELETE')          as incident_delete_policies_0,
  (select count(distinct trigger_name) from information_schema.triggers
    where event_object_table = 'incidents')                                              as incident_triggers_3,
  (select count(*) from pg_indexes
    where schemaname = 'public'
      and indexname in ('idx_incidents_timeline', 'idx_incidents_resident'))             as incident_indexes_2,
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'incidents')                                                       as realtime_1,
  (select count(*) from public.app_settings
    where key in ('corp_name', 'office_name_facility', 'office_name_visit', 'office_name_daycare',
                  'office_no_facility', 'office_no_visit', 'office_no_daycare', 'office_address')) as office_keys_8,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'incidents' and column_name = 'closed_at')  as closed_at_col_1,
  (select count(*) from public.app_settings where key = 'input_enabled_incident')        as input_flag_1;
