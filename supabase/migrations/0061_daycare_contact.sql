-- =====================================================================
-- 0061: デイ（せせらぎ）の記録 段階4 — 連絡帳（その日の全員共通の一文・1人1日のひと言）
--       （2026-11-09 計画C・正本は【AI取締役】の 20261109_すぐろく以上_改善計画_v1.md の §3 C・§4、
--        構成と連携の設計 v1 の (9) daycare_day_notes・daycare_contact_notes の案）
--
-- 足すだけ・既存を変えない・本番は親が流す。
-- 0001〜0060 を当てたあとに実行する。冪等（何度実行しても同じ結果）。既存の表・列・データ・関数・ポリシー・移行は消さない・変えない。
-- 足すもの（すべて追加のみ）:
--   1. daycare_day_notes（施設ごと・日ごとに1行・生きている行で一意）… その日の全員共通の一文（body・200字まで）。
--        一度書けば、その日の全員の連絡帳の「職員より」に入る。
--   2. daycare_contact_notes（施設・利用者・日ごとに1行・生きている行で一意）… 1人1日の連絡帳のひと言。
--        body＝職員の個別のひと言（200字まで）・nurse_note＝看護職のひと言（150字まで）・printed_at＝最後に印刷した時刻（任意）。
--        body と nurse_note は別々に書く欄（画面は変えた欄だけを送る＝多端末同期の規約 原則3）。
--   写真の列・ご家族への送信の列は作らない（写真は掲載の同意の運用が先・送信は将来の拡張＝計画 §3 の見送り）。
--   記録の中身（バイタル・入浴・食事・水分・活動・機能訓練）は表に写さない（画面が今ある読み込みから組み立てる＝転記しない）。
--
-- 作り（0055 の後の daycare_* の表と同じ形で最初から作る）:
--   - 施設の印 tenant_id … 必須（not null）・care-backend の tenants を参照。既定は足す前のトリガ carelog_fill_tenant
--     （0051 の名前・0052 の本文。関数は作らずに使うだけ）。画面は印を送らない
--   - 外部キーは全部（施設の印, 番号）の組（0053 と同じ名前の付け方 <表>_<列>_fkey）。利用者は residents (tenant_id, id)、
--     記録者・最後に書き換えた職員・取り消した職員は staff (tenant_id, id)
--   - 一意は施設の印が先頭（0054 と同じ）。1日1行・1人1日1行は生きている行だけ（部分 unique）
--   - rev・updated_at（set_updated_at_rev）・変更の記録（record_history_capture('day')）・deleted_at／deleted_by・recorded_by／edited_by
--   - RLS: 0044 と同じ（読み書きとも許可リストの職員・delete のポリシーは作らない）＋ 0054 と同じ tenant_only（自分の施設の行だけ）
--   - 物理削除はできない: delete のポリシーを作らず、authenticated から delete・truncate の権限も外す。anon には何も渡さない
--   - 冪等キー（client_key）は持たない（送信待ちの経路を作らない＝2026-11-09 計画C の仮置き。2台が同時に1行目を作った時は
--     自然キーの一意の 23505 になり、画面は読み直して知らせる）
--   - 新しいトリガ関数は作らない（0059・0060 の権限の剥がしは要らない）。Realtime には載せない（画面は〔最新に更新〕で読み直す）
-- 入力解禁: 既存の input_enabled_daycare（app_settings には何も足さない）。
--
-- 旧クライアント×新サーバー: 旧版は新しい表を知らないので何も変わらない（連絡帳の画面が無いだけ）。
-- 新クライアント×旧サーバー（このファイルを当てる前に画面を出した時）: 連絡帳の画面は表が無い（42P01／PGRST205）を
--   「連絡帳はまだ使えません（サーバー側の設定待ち）」として、ひと言の欄を押せなくする。記録の見本と印刷はそのまま使える。
-- 適用の順: DB 先 → アプリ。
-- 流し方: SQL Editor で全文を貼る → Run。最後の確かめ（1行）が ok なら完了。
--   begin … commit で包む（途中で止まった時は何も入らない）。表の錠を待つのは5秒まで（lock_timeout）。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
--
-- 戻し方（必要な時だけ・書いた連絡帳のひと言も消える。先に表の中身を書き出してから流す）:
--   drop table if exists public.daycare_contact_notes;
--   drop table if exists public.daycare_day_notes;
--   （表と一緒に、この移行で足した索引・トリガ・守り・外部キーも外れる。既存の表・関数には触れない）
--   ★戻す順: 新しい移行から順に戻す。supabase/rollback/0053_back.sql・0054_back.sql を流す前に、必ずこの2表の drop を先に流す
--     （2表がある間は、0053_back は利用者・職員の（施設の印, 番号）の一意を外せず誤りで止まり＝何も変わらない、0054_back は通るが
--      最後の確かめ「足した守り tenant_only が残っていない」が NG になる＝この2表の守りが残るため）。
--     同じ理由で、この移行の後に 0053 をもう一度流すと「決まった76本」の確かめで何も変えずに止まる（tests/pg-run-all.mjs の FINAL_RERUN_SKIP_FK）
-- =====================================================================

begin;
set local lock_timeout = '5s';

-- ---------- 1. その日の全員共通の一文（施設ごと・日ごとに1行） ----------
create table if not exists public.daycare_day_notes (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references public.tenants(id),  -- 施設の印（足す前のトリガ carelog_fill_tenant が入れる）
  day           date not null,                                -- 業務日（JST・クライアントが明示指定する）
  body          text,                                         -- 全員共通の一文（200字まで・空は null）
  recorded_by   bigint,
  rev           integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    bigint,
  edited_by     bigint,                                       -- 最後にこの行を書き換えた職員（0010 と同じ意味）
  constraint daycare_day_notes_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id),
  constraint daycare_day_notes_deleted_by_fkey  foreign key (tenant_id, deleted_by)  references public.staff (tenant_id, id),
  constraint daycare_day_notes_edited_by_fkey   foreign key (tenant_id, edited_by)   references public.staff (tenant_id, id)
);

alter table public.daycare_day_notes drop constraint if exists daycare_day_notes_body_check;
alter table public.daycare_day_notes add constraint daycare_day_notes_body_check
  check (body is null or pg_catalog.char_length(body) <= 200);

comment on table public.daycare_day_notes is
  'デイの連絡帳の、その日の全員共通の一文（施設ごと・日ごとに1行）。0061。';
comment on column public.daycare_day_notes.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味（更新・削除のたびにアプリが送る）。';

-- 1日1行（生きている行だけ・施設の印が先頭）
create unique index if not exists uq_daycare_day_notes
  on public.daycare_day_notes (tenant_id, day)
  where deleted_at is null;

drop trigger if exists carelog_fill_tenant on public.daycare_day_notes;
create trigger carelog_fill_tenant before insert on public.daycare_day_notes
  for each row execute function private.carelog_fill_tenant();
create or replace trigger trg_updated_daycare_day_notes
  before update on public.daycare_day_notes
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_daycare_day_notes
  after update on public.daycare_day_notes
  for each row execute function public.record_history_capture('day');

-- ---------- 2. 1人1日の連絡帳のひと言（施設・利用者・日ごとに1行） ----------
create table if not exists public.daycare_contact_notes (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references public.tenants(id),  -- 施設の印（足す前のトリガ carelog_fill_tenant が入れる）
  resident_id   bigint not null,
  day           date not null,                                -- 業務日（JST・クライアントが明示指定する）
  body          text,                                         -- 職員の個別のひと言（200字まで・空は null）
  nurse_note    text,                                         -- 看護職のひと言（150字まで・空は null）
  printed_at    timestamptz,                                  -- 最後に印刷した時刻（任意）
  recorded_by   bigint,
  rev           integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    bigint,
  edited_by     bigint,                                       -- 最後にこの行を書き換えた職員（0010 と同じ意味）
  constraint daycare_contact_notes_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id),
  constraint daycare_contact_notes_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id),
  constraint daycare_contact_notes_deleted_by_fkey  foreign key (tenant_id, deleted_by)  references public.staff (tenant_id, id),
  constraint daycare_contact_notes_edited_by_fkey   foreign key (tenant_id, edited_by)   references public.staff (tenant_id, id)
);

alter table public.daycare_contact_notes drop constraint if exists daycare_contact_notes_body_check;
alter table public.daycare_contact_notes add constraint daycare_contact_notes_body_check
  check (body is null or pg_catalog.char_length(body) <= 200);
alter table public.daycare_contact_notes drop constraint if exists daycare_contact_notes_nurse_note_check;
alter table public.daycare_contact_notes add constraint daycare_contact_notes_nurse_note_check
  check (nurse_note is null or pg_catalog.char_length(nurse_note) <= 150);

comment on table public.daycare_contact_notes is
  'デイの連絡帳の1人1日のひと言（職員の個別のひと言 body・看護職のひと言 nurse_note・最後に印刷した時刻 printed_at）。写真・送信の列は持たない。0061。';
comment on column public.daycare_contact_notes.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味（更新・削除のたびにアプリが送る）。';

-- 1人1日1行（生きている行だけ・施設の印が先頭）
create unique index if not exists uq_daycare_contact_notes
  on public.daycare_contact_notes (tenant_id, resident_id, day)
  where deleted_at is null;
-- 日ごとの一覧（連絡帳の画面はその日の全員分を読む）
create index if not exists ix_daycare_contact_notes_day
  on public.daycare_contact_notes (tenant_id, day)
  where deleted_at is null;

drop trigger if exists carelog_fill_tenant on public.daycare_contact_notes;
create trigger carelog_fill_tenant before insert on public.daycare_contact_notes
  for each row execute function private.carelog_fill_tenant();
create or replace trigger trg_updated_daycare_contact_notes
  before update on public.daycare_contact_notes
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_daycare_contact_notes
  after update on public.daycare_contact_notes
  for each row execute function public.record_history_capture('day');

-- ---------- 3. RLS（0044 と同じ4本＋0054 と同じ tenant_only） ----------
alter table public.daycare_day_notes enable row level security;
drop policy if exists "read_auth"   on public.daycare_day_notes;
drop policy if exists "insert_auth" on public.daycare_day_notes;
drop policy if exists "update_auth" on public.daycare_day_notes;
drop policy if exists member_only   on public.daycare_day_notes;
drop policy if exists tenant_only   on public.daycare_day_notes;
create policy "read_auth"   on public.daycare_day_notes for select to authenticated using (true);
create policy "insert_auth" on public.daycare_day_notes for insert to authenticated with check (true);
create policy "update_auth" on public.daycare_day_notes for update to authenticated using (true) with check (true);
create policy member_only on public.daycare_day_notes as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());
create policy tenant_only on public.daycare_day_notes as restrictive for all to authenticated
  using (tenant_id = (select private.my_tenant())) with check (tenant_id = (select private.my_tenant()));
revoke all on public.daycare_day_notes from anon;
revoke delete, truncate on public.daycare_day_notes from authenticated;

alter table public.daycare_contact_notes enable row level security;
drop policy if exists "read_auth"   on public.daycare_contact_notes;
drop policy if exists "insert_auth" on public.daycare_contact_notes;
drop policy if exists "update_auth" on public.daycare_contact_notes;
drop policy if exists member_only   on public.daycare_contact_notes;
drop policy if exists tenant_only   on public.daycare_contact_notes;
create policy "read_auth"   on public.daycare_contact_notes for select to authenticated using (true);
create policy "insert_auth" on public.daycare_contact_notes for insert to authenticated with check (true);
create policy "update_auth" on public.daycare_contact_notes for update to authenticated using (true) with check (true);
create policy member_only on public.daycare_contact_notes as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());
create policy tenant_only on public.daycare_contact_notes as restrictive for all to authenticated
  using (tenant_id = (select private.my_tenant())) with check (tenant_id = (select private.my_tenant()));
revoke all on public.daycare_contact_notes from anon;
revoke delete, truncate on public.daycare_contact_notes from authenticated;

commit;

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST205 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（読むだけ。ok なら入った）
-- ---------------------------------------------------------------------
select '連絡帳の2表（施設の印が必須・印のトリガ・守り5本ずつ・消す守りと権限なし・1日1行と1人1日1行の一意）' as what,
       case when (select pg_catalog.count(*) from information_schema.columns
                   where table_schema = 'public' and column_name = 'tenant_id' and is_nullable = 'NO'
                     and table_name in ('daycare_day_notes', 'daycare_contact_notes')) = 2
             and (select pg_catalog.count(*) from pg_catalog.pg_trigger
                   where tgname = 'carelog_fill_tenant' and not tgisinternal
                     and tgrelid in ('public.daycare_day_notes'::regclass, 'public.daycare_contact_notes'::regclass)) = 2
             and (select pg_catalog.count(*) from pg_catalog.pg_policies
                   where schemaname = 'public' and tablename in ('daycare_day_notes', 'daycare_contact_notes')) = 10
             and (select pg_catalog.count(*) from pg_catalog.pg_policies
                   where schemaname = 'public' and tablename in ('daycare_day_notes', 'daycare_contact_notes')
                     and policyname in ('member_only', 'tenant_only') and permissive = 'RESTRICTIVE') = 4
             and (select pg_catalog.count(*) from pg_catalog.pg_policies
                   where schemaname = 'public' and tablename in ('daycare_day_notes', 'daycare_contact_notes') and cmd = 'DELETE') = 0
             and (select pg_catalog.count(*) from information_schema.role_table_grants
                   where table_schema = 'public' and table_name in ('daycare_day_notes', 'daycare_contact_notes')
                     and grantee in ('authenticated', 'anon') and privilege_type in ('DELETE', 'TRUNCATE')) = 0
             and (select pg_catalog.count(*) from pg_catalog.pg_indexes
                   where schemaname = 'public'
                     and indexname in ('uq_daycare_day_notes', 'uq_daycare_contact_notes')
                     and indexdef like '%USING btree (tenant_id, %WHERE (deleted_at IS NULL)') = 2
            then 'ok' else 'NG' end as result;
