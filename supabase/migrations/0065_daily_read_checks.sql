-- =====================================================================
-- 0065: 日報の「確認欄」— 職員がその日の日報を読んだ印（1人1日1件）（2026-11-19 本人指示）
--
-- 足すだけ・既存を変えない。0001〜0064 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- 既存の表・列・データ・関数・ポリシー・移行は消さない・変えない。
-- 足すもの（すべて追加のみ）:
--   1. daily_read_checks（施設・日・職員ごとに1行・生きている行で一意）… その日の日報を読んだ印（✔）。
--        staff_id＝読んだ職員・day＝読んだ日報の日（業務日・JST）・checked_at＝✔ を付けた時刻・recorded_by＝押した端末の記録者。
--        ✔ の取り消しは論理削除（deleted_at／deleted_by）。取り消した後にもう一度 ✔ を付けると新しい行になる。
--   2. 書ける日の守り public.daily_read_check_guard()（トリガ専用・誰にも実行の権限を渡さない）
--
-- 作り（0061・0062 と同じ形）:
--   - 施設の印 tenant_id … 必須（not null）・care-backend の tenants を参照。既定は足す前のトリガ carelog_fill_tenant
--     （0051 の名前・0052 の本文。関数は作らずに使うだけ）。画面は印を送らない
--   - 外部キーは全部（施設の印, 番号）の組（0053 と同じ名前の付け方 <表>_<列>_fkey）。職員・押した職員・取り消した職員は staff (tenant_id, id)
--   - 一意は施設の印が先頭（0054 と同じ）。1人1日1件は生きている行だけ（部分 unique）
--   - rev・updated_at（set_updated_at_rev）・deleted_at／deleted_by・recorded_by／edited_by
--   - RLS: 0044 と同じ4本（読み書きとも許可リストの職員・delete のポリシーは作らない）＋ 0054 と同じ tenant_only（自分の施設の行だけ）
--   - 物理削除はできない: delete のポリシーを作らず、authenticated から delete・truncate の権限も外す。anon には何も渡さない
--   - 冪等キーは持たない（送信待ちの経路を作らない。2台が同時に同じ人の ✔ を付けた時は一意の 23505 になり、画面は「付いている」とみなす）
--   - 書ける日の守り（0061 の作法）: まだ来ていない日は誰も書けない（22023・read_check_future: …）。
--     現場（field）のログインは今日から14日前までの日（休み明けに、休みの間の日報も読んで ✔ を付けられるように）。
--     それより前の日は事務所・管理者のログインだけ（42501・read_check_past_office_only: …）。
--     書き換えで職員・日を変えることは誰もできない（22023・read_check_fixed: …）。取り消しの印を外す（生き返らせる）こともできない
--     （取り消した後はもう一度 ✔ を付ける＝新しい行）。役割が分からない接続（表の所有者・サーバーの接続）と my_role() が無い DB では
--     日の守りだけを外す（職員・日を変えない守りは残す）
--   - Realtime には載せない（日報の〔最新に更新〕・開き直しで読み直す）
-- 入力解禁: 既存の native_input_enabled に合わせない（✔ は記録ではなく「読んだ」印のため、入力封鎖中でも付けられる。既読と同じ扱い）。
--
-- 旧クライアント×新サーバー: 旧版は新しい表を知らないので何も変わらない（確認欄が無いだけ）。
-- 新クライアント×旧サーバー（このファイルを当てる前に画面を出した時）: 確認欄は表が無い（42P01／PGRST205）を
--   「確認欄はまだ使えません（サーバー側の設定待ち）」として ✔ を押せなくする。日報のほかの部分はそのまま使える。
-- 適用の順: DB 先 → アプリ。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
--
-- 戻し方（必要な時だけ・付けた ✔ も消える。先に表の中身を書き出してから流す）: supabase/rollback/0065_back.sql
--   ★戻す順: 新しい移行から順に戻す。supabase/rollback/0053_back.sql・0054_back.sql を流す前に、必ずこの表を先に戻す
--     （0061・0062 と同じ理由: この表がある間は 0053_back は職員の（施設の印, 番号）の一意を外せず止まり、0054_back は
--      最後の確かめ「足した守り tenant_only が残っていない」が NG になる）。
-- =====================================================================

begin;
set local lock_timeout = '5s';

-- ---------- 1. 日報を読んだ印（施設・日・職員ごとに1行） ----------
create table if not exists public.daily_read_checks (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references public.tenants(id),  -- 施設の印（足す前のトリガ carelog_fill_tenant が入れる）
  day           date not null,                                -- 読んだ日報の日（業務日・JST・クライアントが明示指定する）
  staff_id      bigint not null,                              -- 読んだ職員
  checked_at    timestamptz not null default now(),           -- ✔ を付けた時刻
  recorded_by   bigint,                                       -- ✔ を押した端末の記録者
  rev           integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    bigint,
  edited_by     bigint,                                       -- 最後にこの行を書き換えた職員（0010 と同じ意味）
  constraint daily_read_checks_staff_id_fkey    foreign key (tenant_id, staff_id)    references public.staff (tenant_id, id),
  constraint daily_read_checks_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id),
  constraint daily_read_checks_deleted_by_fkey  foreign key (tenant_id, deleted_by)  references public.staff (tenant_id, id),
  constraint daily_read_checks_edited_by_fkey   foreign key (tenant_id, edited_by)   references public.staff (tenant_id, id)
);

comment on table public.daily_read_checks is
  '日報の確認欄（その日の日報を読んだ印・施設・日・職員ごとに1行）。取り消しは論理削除。0065。';
comment on column public.daily_read_checks.staff_id is '日報を読んだ職員。';
comment on column public.daily_read_checks.recorded_by is '✔ を押した端末の記録者（ふつうは staff_id と同じ）。';

-- 1人1日1件（生きている行だけ・施設の印が先頭）
create unique index if not exists uq_daily_read_checks
  on public.daily_read_checks (tenant_id, day, staff_id)
  where deleted_at is null;
-- 日ごとの一覧（日報は表示中の日の分をまとめて読む）
create index if not exists ix_daily_read_checks_day
  on public.daily_read_checks (tenant_id, day)
  where deleted_at is null;

drop trigger if exists carelog_fill_tenant on public.daily_read_checks;
create trigger carelog_fill_tenant before insert on public.daily_read_checks
  for each row execute function private.carelog_fill_tenant();
create or replace trigger trg_updated_daily_read_checks
  before update on public.daily_read_checks
  for each row execute function public.set_updated_at_rev();

-- ---------- 2. 書ける日の守り ----------
-- 0061 の daycare_contact_day_guard と同じ作法（security definer・search_path は空・my_role() が無い DB では日の守りを止めない）
create or replace function public.daily_read_check_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_today date := (pg_catalog.now() at time zone 'Asia/Tokyo')::date;
  v_role text;
begin
  -- 書き換えで職員・日を変えない・取り消しの印を外さない（役割を問わない）
  if tg_op = 'UPDATE' then
    if new.staff_id is distinct from old.staff_id or new.day is distinct from old.day then
      raise exception 'read_check_fixed: 確認の印の職員と日は変えられません'
        using errcode = '22023';
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'read_check_fixed: 取り消した確認の印は戻せません（もう一度 ✔ を付けてください）'
        using errcode = '22023';
    end if;
  end if;
  -- まだ来ていない日は書けない（役割を問わない）
  if new.day > v_today then
    raise exception 'read_check_future: まだ来ていない日の確認は付けられません'
      using errcode = '22023';
  end if;
  -- 今日から14日前までは誰でも書ける
  if new.day >= v_today - 14 then
    return new;
  end if;
  if pg_catalog.to_regprocedure('private.my_role()') is null then
    return new;
  end if;
  execute 'select private.my_role()' into v_role;
  if v_role is distinct from 'field' then
    return new;
  end if;
  raise exception 'read_check_past_office_only: 14日より前の日の確認は、事務所のログインでだけ付けられます'
    using errcode = '42501',
          hint = '事務所（office・admin）のログインで付けてください';
end;
$fn$;
comment on function public.daily_read_check_guard() is
  'daily_read_checks の守り: 職員・日を書き換えない・取り消しを戻さない（22023 read_check_fixed）・未来の日は書けない（22023 read_check_future）・現場（field）は今日から14日前まで（42501 read_check_past_office_only）。0065。';
revoke all on function public.daily_read_check_guard() from public, anon, authenticated;
create or replace trigger trg_daily_read_checks_guard
  before insert or update on public.daily_read_checks
  for each row execute function public.daily_read_check_guard();

-- ---------- 3. RLS（0044 と同じ4本＋0054 と同じ tenant_only） ----------
alter table public.daily_read_checks enable row level security;
drop policy if exists "read_auth"   on public.daily_read_checks;
drop policy if exists "insert_auth" on public.daily_read_checks;
drop policy if exists "update_auth" on public.daily_read_checks;
drop policy if exists member_only   on public.daily_read_checks;
drop policy if exists tenant_only   on public.daily_read_checks;
create policy "read_auth"   on public.daily_read_checks for select to authenticated using (true);
create policy "insert_auth" on public.daily_read_checks for insert to authenticated with check (true);
create policy "update_auth" on public.daily_read_checks for update to authenticated using (true) with check (true);
create policy member_only on public.daily_read_checks as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());
create policy tenant_only on public.daily_read_checks as restrictive for all to authenticated
  using (tenant_id = (select private.my_tenant())) with check (tenant_id = (select private.my_tenant()));
revoke all on public.daily_read_checks from anon;
revoke delete, truncate on public.daily_read_checks from authenticated;

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（読むだけ。ok なら入った）
-- ---------------------------------------------------------------------
select '日報の確認欄の表（施設の印が必須・印のトリガ・守り5本・消す権限なし・1人1日1件の一意・書ける日の守り）' as what,
       case when (select pg_catalog.count(*) from information_schema.columns
                   where table_schema = 'public' and table_name = 'daily_read_checks'
                     and column_name = 'tenant_id' and is_nullable = 'NO') = 1
             and (select pg_catalog.count(*) from pg_catalog.pg_trigger
                   where not tgisinternal and tgrelid = 'public.daily_read_checks'::regclass
                     and tgname in ('carelog_fill_tenant', 'trg_updated_daily_read_checks', 'trg_daily_read_checks_guard')) = 3
             and (select pg_catalog.count(*) from pg_catalog.pg_policies
                   where schemaname = 'public' and tablename = 'daily_read_checks') = 5
             and (select pg_catalog.count(*) from pg_catalog.pg_policies
                   where schemaname = 'public' and tablename = 'daily_read_checks'
                     and policyname in ('member_only', 'tenant_only') and permissive = 'RESTRICTIVE') = 2
             and (select pg_catalog.count(*) from information_schema.role_table_grants
                   where table_schema = 'public' and table_name = 'daily_read_checks'
                     and grantee in ('authenticated', 'anon') and privilege_type in ('DELETE', 'TRUNCATE')) = 0
             and (select pg_catalog.count(*) from pg_catalog.pg_indexes
                   where schemaname = 'public' and tablename = 'daily_read_checks' and indexname = 'uq_daily_read_checks') = 1
            then 'ok' else 'NG' end as result;
