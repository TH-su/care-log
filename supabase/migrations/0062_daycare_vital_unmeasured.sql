-- =====================================================================
-- 0062: デイ（せせらぎ）のバイタル・食事の画面の〔未測定〕を残す表（2026-11-10 親の決定・案1）
--       職員が〔未測定〕を押した欄を「入力済み」に数えるための印（昼食の「拒食」と同じく、測らなかったことを記録した意思のある入力）。
--
-- 足すだけ・既存を変えない・本番は代表者が SQL Editor で流す（このファイルの全文）。
-- 0001〜0061 を当てたあとに実行する。冪等（何度実行しても同じ結果）。既存の表・列・データ・関数・ポリシー・移行は消さない・変えない。
-- vitals とその保存の関数（0011 の apply_cell_edits）・タイムライン・カルテには触れない（印は別の表に置く）。
-- 足すもの（すべて追加のみ）:
--   1. daycare_vital_unmeasured（施設・利用者・日・測定の回・欄ごとに1行・生きている行で一意）… 〔未測定〕の印。
--        seq＝デイの測定の回（vitals.client_key 'dc:<日>:<利用者id>:<回>' の <回> と同じ番号・1〜9999）、
--        field＝欄（'temp'・'sys_bp'・'dia_bp'・'pulse'・'spo2'）。
--        印を外す（〔未測定〕の取り消し・値を入れた時）は論理削除（deleted_at）。値のある欄の印は画面が無視する（値が優先）。
--   2. 過去の日の守り public.daycare_vital_unmeasured_day_guard()（トリガ専用・誰にも実行の権限を渡さない）
--
-- 作り（0061 の連絡帳の2表と同じ形）:
--   - 施設の印 tenant_id … 必須（not null）・care-backend の tenants を参照。既定は足す前のトリガ carelog_fill_tenant
--     （0051 の名前・0052 の本文。関数は作らずに使うだけ）。画面は印を送らない
--   - 外部キーは全部（施設の印, 番号）の組（0053 と同じ名前の付け方 <表>_<列>_fkey）。利用者は residents (tenant_id, id)、
--     記録者・最後に書き換えた職員・取り消した職員は staff (tenant_id, id)
--   - 一意は施設の印が先頭（0054 と同じ）。1つの回の1つの欄に1行は生きている行だけ（部分 unique）
--   - rev・updated_at（set_updated_at_rev）・変更の記録（record_history_capture('day')）・deleted_at／deleted_by・recorded_by／edited_by
--   - RLS: 0044 と同じ（読み書きとも許可リストの職員・delete のポリシーは作らない）＋ 0054 と同じ tenant_only（自分の施設の行だけ）
--   - 物理削除はできない: delete のポリシーを作らず、authenticated から delete・truncate の権限も外す。anon には何も渡さない
--   - 冪等キー（client_key）は持たない（送信待ちの経路を作らない＝2026-11-10 の仮置き。2台が同時に同じ欄に印を付けた時は
--     自然キーの一意の 23505 になり、画面は読み直して今ある印を使う）
--   - 過去の日の守り（0061 の daycare_contact_day_guard と同じ考え・同じ作法）: 現場（field）のログインは、その日（JST の今日）
--     の行だけ書ける。過去の日の行は事務所・管理者のログインだけ（42501・daycare_unmeasured_past_office_only: …）。まだ来ていない日の
--     行は誰も書けない（22023・daycare_unmeasured_future: …）。役割が分からない接続（表の所有者・サーバーの接続＝my_role() が null）と
--     my_role() が無い DB では止めない。トリガ専用の関数を1つ作り、0059・0060 と同じく誰にも実行の権限を渡さない
--     （トリガが動く時は実行の権限を見ない）。誤りの文の頭は連絡帳（daycare_contact_*）と分ける（画面が案内を取り違えない）
--   - Realtime には載せない（画面はバイタルと同じ読み直しのきっかけで読み直す）
-- 入力解禁: 既存の input_enabled_daycare（app_settings には何も足さない）。
--
-- 旧クライアント×新サーバー: 旧版は新しい表を知らないので何も変わらない（〔未測定〕は今までどおり空欄のまま次の欄へ）。
-- 新クライアント×旧サーバー（このファイルを当てる前に画面を出した時）: 印の読み込みは表が無い（42P01／PGRST205）を「印なし」として
--   画面を止めない。〔未測定〕を押すと「設定待ち」の文を出し、欄は空のまま（入力済みに数えない）。バイタルの入力はそのまま使える。
-- 適用の順: DB 先 → アプリ。0061 の後に流す（0061 が無い DB でも流せるが、番号の順に当てる決まりに合わせる）。
-- 流し方: SQL Editor で全文を貼る → Run。最後の確かめ（1行）が ok なら完了。
--   begin … commit で包む（途中で止まった時は何も入らない）。表の錠を待つのは5秒まで（lock_timeout）。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
-- 個人情報: このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
--
-- 戻し方（必要な時だけ・付けた〔未測定〕の印も消える。先に表の中身を書き出してから流す）:
--   drop table if exists public.daycare_vital_unmeasured;
--   drop function if exists public.daycare_vital_unmeasured_day_guard();
--   （表と一緒に、この移行で足した索引・トリガ・守り・外部キーも外れる。既存の表・関数には触れない）
--   ★戻す順: 新しい移行から順に戻す（この表 → 0061 の2表 → …）。supabase/rollback/0053_back.sql・0054_back.sql を流す前に、
--     必ずこの表の drop を先に流す（0061 と同じ理由: この表がある間は、0053_back は利用者・職員の（施設の印, 番号）の一意を外せず
--     誤りで止まり＝何も変わらない、0054_back は通るが最後の確かめ「足した守り tenant_only が残っていない」が NG になる）。
--     同じ理由で、この移行の後に 0053 をもう一度流すと「決まった76本」の確かめで何も変えずに止まる（tests/pg-run-all.mjs の FINAL_RERUN_SKIP_FK）
-- =====================================================================

begin;
set local lock_timeout = '5s';

-- ---------- 1. 〔未測定〕の印（施設・利用者・日・測定の回・欄ごとに1行） ----------
create table if not exists public.daycare_vital_unmeasured (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references public.tenants(id),  -- 施設の印（足す前のトリガ carelog_fill_tenant が入れる）
  resident_id   bigint not null,
  day           date not null,                                -- 業務日（JST・クライアントが明示指定する）
  seq           integer not null,                             -- デイの測定の回（vitals.client_key 'dc:<日>:<利用者id>:<回>' の <回>）
  field         text not null,                                -- 欄（'temp'・'sys_bp'・'dia_bp'・'pulse'・'spo2'）
  recorded_by   bigint,
  rev           integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    bigint,
  edited_by     bigint,                                       -- 最後にこの行を書き換えた職員（0010 と同じ意味）
  constraint daycare_vital_unmeasured_resident_id_fkey foreign key (tenant_id, resident_id) references public.residents (tenant_id, id),
  constraint daycare_vital_unmeasured_recorded_by_fkey foreign key (tenant_id, recorded_by) references public.staff (tenant_id, id),
  constraint daycare_vital_unmeasured_deleted_by_fkey  foreign key (tenant_id, deleted_by)  references public.staff (tenant_id, id),
  constraint daycare_vital_unmeasured_edited_by_fkey   foreign key (tenant_id, edited_by)   references public.staff (tenant_id, id)
);

alter table public.daycare_vital_unmeasured drop constraint if exists daycare_vital_unmeasured_seq_check;
alter table public.daycare_vital_unmeasured add constraint daycare_vital_unmeasured_seq_check
  check (seq between 1 and 9999);
alter table public.daycare_vital_unmeasured drop constraint if exists daycare_vital_unmeasured_field_check;
alter table public.daycare_vital_unmeasured add constraint daycare_vital_unmeasured_field_check
  check (field in ('temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2'));

comment on table public.daycare_vital_unmeasured is
  'デイのバイタル・食事の画面の〔未測定〕の印（施設・利用者・日・測定の回・欄ごとに1行）。印のある欄は入力済みに数える。値のある欄の印は画面が無視する（値が優先）。0062。';
comment on column public.daycare_vital_unmeasured.seq is
  'デイの測定の回（vitals.client_key ''dc:<日>:<利用者id>:<回>'' の <回> と同じ番号・1〜9999）。';
comment on column public.daycare_vital_unmeasured.field is
  '〔未測定〕を押した欄（temp・sys_bp・dia_bp・pulse・spo2）。';
comment on column public.daycare_vital_unmeasured.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味（取り消しのたびにアプリが送る）。';

-- 1つの回の1つの欄に1行（生きている行だけ・施設の印が先頭）
create unique index if not exists uq_daycare_vital_unmeasured
  on public.daycare_vital_unmeasured (tenant_id, resident_id, day, seq, field)
  where deleted_at is null;
-- 日ごとの一覧（画面はその日の全員分を読む）
create index if not exists ix_daycare_vital_unmeasured_day
  on public.daycare_vital_unmeasured (tenant_id, day)
  where deleted_at is null;

drop trigger if exists carelog_fill_tenant on public.daycare_vital_unmeasured;
create trigger carelog_fill_tenant before insert on public.daycare_vital_unmeasured
  for each row execute function private.carelog_fill_tenant();
create or replace trigger trg_updated_daycare_vital_unmeasured
  before update on public.daycare_vital_unmeasured
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_daycare_vital_unmeasured
  after update on public.daycare_vital_unmeasured
  for each row execute function public.record_history_capture('day');

-- ---------- 2. 過去の日の守り（現場のログインはその日だけ・過去の日は事務所・未来の日は誰も書けない） ----------
-- 0061 の daycare_contact_day_guard と同じ作法（security definer＝my_role() の実行権限を持たない接続でも JWT だけで役割が決まる・
-- my_role() が無い DB では止めない・役割が null の接続は止めない）。search_path は 0052 以降の関数と同じく空にして名前を全部書く
create or replace function public.daycare_vital_unmeasured_day_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_today date := (pg_catalog.now() at time zone 'Asia/Tokyo')::date;
  v_role text;
begin
  -- まだ来ていない日の印は書けない（役割を問わない。画面も今日より後の日を開かない）
  if new.day > v_today and (tg_op = 'INSERT' or new.day is distinct from old.day) then
    raise exception 'daycare_unmeasured_future: まだ来ていない日の〔未測定〕は記録できません'
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
  if pg_catalog.to_regprocedure('private.my_role()') is null then
    return new;
  end if;
  execute 'select private.my_role()' into v_role;
  if v_role is distinct from 'field' then
    return new;
  end if;
  raise exception 'daycare_unmeasured_past_office_only: 過去の日の〔未測定〕は、事務所のログインでだけ記録・取り消しできます（現場の端末は当日だけ）'
    using errcode = '42501',
          hint = '事務所（office・admin）のログインで操作してください';
end;
$fn$;
comment on function public.daycare_vital_unmeasured_day_guard() is
  '現場（field）のログインの、過去の日（JST）の daycare_vital_unmeasured への書き込みを 42501・daycare_unmeasured_past_office_only: … で止める。未来の日は役割を問わず 22023。0062。';
revoke all on function public.daycare_vital_unmeasured_day_guard() from public, anon, authenticated;
create or replace trigger trg_daycare_vital_unmeasured_day_guard
  before insert or update on public.daycare_vital_unmeasured
  for each row execute function public.daycare_vital_unmeasured_day_guard();

-- ---------- 3. RLS（0044 と同じ4本＋0054 と同じ tenant_only） ----------
alter table public.daycare_vital_unmeasured enable row level security;
drop policy if exists "read_auth"   on public.daycare_vital_unmeasured;
drop policy if exists "insert_auth" on public.daycare_vital_unmeasured;
drop policy if exists "update_auth" on public.daycare_vital_unmeasured;
drop policy if exists member_only   on public.daycare_vital_unmeasured;
drop policy if exists tenant_only   on public.daycare_vital_unmeasured;
create policy "read_auth"   on public.daycare_vital_unmeasured for select to authenticated using (true);
create policy "insert_auth" on public.daycare_vital_unmeasured for insert to authenticated with check (true);
create policy "update_auth" on public.daycare_vital_unmeasured for update to authenticated using (true) with check (true);
create policy member_only on public.daycare_vital_unmeasured as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());
create policy tenant_only on public.daycare_vital_unmeasured as restrictive for all to authenticated
  using (tenant_id = (select private.my_tenant())) with check (tenant_id = (select private.my_tenant()));
revoke all on public.daycare_vital_unmeasured from anon;
revoke delete, truncate on public.daycare_vital_unmeasured from authenticated;

commit;

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST205 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（読むだけ。ok なら入った）
-- ---------------------------------------------------------------------
select '〔未測定〕の表（施設の印が必須・印のトリガ・守り5本・消す守りと権限なし・anon の権限なし・1つの回の1つの欄に1行の一意・過去の日の守り）' as what,
       case when (select pg_catalog.count(*) from information_schema.columns
                   where table_schema = 'public' and column_name = 'tenant_id' and is_nullable = 'NO'
                     and table_name = 'daycare_vital_unmeasured') = 1
             and (select pg_catalog.count(*) from pg_catalog.pg_trigger
                   where tgname = 'carelog_fill_tenant' and not tgisinternal
                     and tgrelid = 'public.daycare_vital_unmeasured'::regclass) = 1
             and (select pg_catalog.count(*) from pg_catalog.pg_policies
                   where schemaname = 'public' and tablename = 'daycare_vital_unmeasured') = 5
             and (select pg_catalog.count(*) from pg_catalog.pg_policies
                   where schemaname = 'public' and tablename = 'daycare_vital_unmeasured'
                     and policyname in ('member_only', 'tenant_only') and permissive = 'RESTRICTIVE') = 2
             and (select pg_catalog.count(*) from pg_catalog.pg_policies
                   where schemaname = 'public' and tablename = 'daycare_vital_unmeasured' and cmd = 'DELETE') = 0
             and (select pg_catalog.count(*) from information_schema.role_table_grants
                   where table_schema = 'public' and table_name = 'daycare_vital_unmeasured'
                     and grantee = 'authenticated' and privilege_type in ('DELETE', 'TRUNCATE')) = 0
             and (select pg_catalog.count(*) from information_schema.role_table_grants
                   where table_schema = 'public' and table_name = 'daycare_vital_unmeasured' and grantee = 'anon') = 0
             and (select pg_catalog.count(*) from pg_catalog.pg_indexes
                   where schemaname = 'public' and indexname = 'uq_daycare_vital_unmeasured'
                     and indexdef like '%USING btree (tenant_id, resident_id, day, seq, field) WHERE (deleted_at IS NULL)') = 1
             and (select pg_catalog.count(*) from pg_catalog.pg_trigger
                   where not tgisinternal and tgname = 'trg_daycare_vital_unmeasured_day_guard'
                     and tgrelid = 'public.daycare_vital_unmeasured'::regclass) = 1
             and not pg_catalog.has_function_privilege('authenticated', 'public.daycare_vital_unmeasured_day_guard()', 'execute')
             and not pg_catalog.has_function_privilege('anon', 'public.daycare_vital_unmeasured_day_guard()', 'execute')
            then 'ok' else 'NG' end as result;
