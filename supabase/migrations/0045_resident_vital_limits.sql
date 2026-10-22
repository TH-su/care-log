-- =====================================================================
-- 0045: 方ごとの個人のバイタルの閾値（有効開始日つき・追記のみ）resident_vital_limits
--       （2026-10-22 代表者承認・計画の正本は【AI取締役】の 20261022_段階2_計画_v1.md の 3.2・5章・6章の質問4,5,6）
--
-- 0001〜0044 を当てたあとに実行する。冪等（何度実行しても同じ結果）。既存の表・列・データ・関数・ポリシーは消さない・変えない
-- （表1つ・トリガの関数1つ・索引・トリガ・ポリシーを足すだけ。0034 の private.resident_targets_writable() は呼ぶだけ）。
-- 足すもの:
--   1. resident_vital_limits（1行 = その方の、ある日（valid_from）から効く個人の閾値の一式）
--        9項目は施設の基準（src/lib/vitalThresholds.ts の既定値の一式）と1対1: 体温の注意の高・危険の高・危険の低／
--        血圧の上の危険の高・注意の低／血圧の下の危険の高・注意の低／脈の危険の高・注意の低。
--        null＝その項目は施設の基準。全部 null の行＝「この日から施設の基準に戻す」。9項目はそれぞれ単独で null にできる
--        （SpO2 の個別の下限のような「2つ組で両方あるか両方 null」の決まりにはしない＝検証計画 v2 の 3.4 の6番とは違う作り）。
--        basis＝根拠（主治医の指示とその日付など・必須・200字まで）。set_by＝決めた職員。
--        端末の判定は「記録の日（measured_on）以前で一番新しい valid_from の行」を使い、項目ごとに 個人 > 施設の設定 > 既定
--        で合成する（src/lib/vitalLimits.ts）。これで、個人の値がある項目の、有効開始日より前の日の記録の印は、閾値を
--        変えても変わらない（施設の基準・SpO2 の個別の下限・個人の値が null の項目は今と同じ「いまの基準」）。
--   2. 追記のみを DB で守るトリガ（resident_vital_limits_guard・0042 と同じ作法。ただし事務所・管理者も止める）:
--        追加 … valid_from は足した日（日本時間）以降だけ（遡れない。主治医の指示の日は根拠に書く）
--        更新 … 値の列・valid_from・resident_id・basis・set_by・client_key は変えられない。変えられるのは取り消し
--               （deleted_at・deleted_by・edited_by）だけで、足した日（日本時間）の当日だけ（取り違えの直し）。
--               取り消した行を戻す（deleted_at を null に戻す）こともできない。それより後は新しい行を足す
--        止めた時: SQLSTATE P0001・message は 'vital_limits_backdated:'／'vital_limits_immutable:'／'vital_limits_cancel_late:'
--        で始まる（0033 の 'note_locked:' と同じ作法）。表には書かない（判定だけ）。
--        役割の分からない接続（private.my_role() が null＝表の所有者・service_role・SQL エディタ）は止めない（保守のため）。
--   3. RLS: 読む＝許可リストの職員（member_only）。書く（insert・update＝取り消し）＝事務所と管理者だけ
--        （0034 の private.resident_targets_writable() を呼ぶだけ・変えない）。delete のポリシーは作らず、
--        authenticated から delete・truncate の権限を外す（0034 と同じ）。anon は何もできない。
--   Realtime には載せない（0034 の resident_targets と同じ。画面は開いた時に読む）。
--
-- 旧クライアント×新サーバー: 旧版は新しい表を読まないので、全員が施設の基準のまま（今と同じ）。
-- 新クライアント×旧サーバー（このファイルを当てる前に画面を出した時）: 端末は表が無い（42P01／PGRST205）を「個人の閾値なし」
--   として施設の基準で判定し、カルテのカードに「個人の閾値はまだ使えません」と出す。
-- 戻す時（必要な時だけ）: 表と中身は消さない（データを消さない）。画面の読み込みを外すと全員が施設の基準に戻る。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名・記録本文・閾値の値を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 1. 個人の閾値 ----------
create table if not exists public.resident_vital_limits (
  id                 bigint generated always as identity primary key,
  resident_id        bigint not null references public.residents(id),
  valid_from         date not null,                    -- この日の記録から効く（足した日以降だけ。下のトリガで守る）
  temp_warn_high     numeric(3,1),
  temp_danger_high   numeric(3,1),
  temp_danger_low    numeric(3,1),
  sys_bp_danger_high smallint,
  sys_bp_warn_low    smallint,
  dia_bp_danger_high smallint,
  dia_bp_warn_low    smallint,
  pulse_danger_high  smallint,
  pulse_warn_low     smallint,
  basis              text not null,                    -- 根拠（主治医の指示とその日付など）
  set_by             bigint references public.staff(id),
  rev                integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_by         bigint references public.staff(id),
  edited_by          bigint references public.staff(id),  -- 最後にこの行を書き換えた職員（0010 と同じ意味）
  client_key         text unique                          -- 端末生成の冪等キー（全体 unique）
);

-- 制約は名前を付けて「落としてから作る」（定義を差し替えられる・何度流しても同じ）
-- 値の範囲（src/lib/vitalLimits.ts の VITAL_LIMIT_RANGES と同じ。変える時は同時に）
alter table public.resident_vital_limits drop constraint if exists resident_vital_limits_range_check;
alter table public.resident_vital_limits add constraint resident_vital_limits_range_check
  check (
        (temp_warn_high     is null or temp_warn_high     between 35.0 and 41.0)
    and (temp_danger_high   is null or temp_danger_high   between 35.0 and 42.0)
    and (temp_danger_low    is null or temp_danger_low    between 33.0 and 37.0)
    and (sys_bp_danger_high is null or sys_bp_danger_high between 100 and 250)
    and (sys_bp_warn_low    is null or sys_bp_warn_low    between 60 and 140)
    and (dia_bp_danger_high is null or dia_bp_danger_high between 60 and 150)
    and (dia_bp_warn_low    is null or dia_bp_warn_low    between 30 and 90)
    and (pulse_danger_high  is null or pulse_danger_high  between 60 and 200)
    and (pulse_warn_low     is null or pulse_warn_low     between 30 and 80)
  );
-- 同じ項目の段階の順（両方ある時だけ）
alter table public.resident_vital_limits drop constraint if exists resident_vital_limits_order_check;
alter table public.resident_vital_limits add constraint resident_vital_limits_order_check
  check (
        (temp_warn_high  is null or temp_danger_high   is null or temp_warn_high  < temp_danger_high)
    and (temp_danger_low is null or temp_warn_high     is null or temp_danger_low < temp_warn_high)
    and (temp_danger_low is null or temp_danger_high   is null or temp_danger_low < temp_danger_high)
    and (sys_bp_warn_low is null or sys_bp_danger_high is null or sys_bp_warn_low < sys_bp_danger_high)
    and (dia_bp_warn_low is null or dia_bp_danger_high is null or dia_bp_warn_low < dia_bp_danger_high)
    and (pulse_warn_low  is null or pulse_danger_high  is null or pulse_warn_low  < pulse_danger_high)
  );
alter table public.resident_vital_limits drop constraint if exists resident_vital_limits_basis_check;
alter table public.resident_vital_limits add constraint resident_vital_limits_basis_check
  check (pg_catalog.char_length(pg_catalog.btrim(basis)) between 1 and 200);

comment on table public.resident_vital_limits is
  '方ごとの個人のバイタルの閾値（有効開始日 valid_from から効く・追記のみ）。null の項目は施設の基準。書けるのは office・admin だけ（0045）。';
comment on column public.resident_vital_limits.valid_from is 'この日（日本時間の業務日）の記録から効く。足した日以降だけ（遡れない）';
comment on column public.resident_vital_limits.basis is '根拠（主治医の指示とその日付など・1〜200字）';
comment on column public.resident_vital_limits.edited_by is
  '最後にこの行を書き換えた職員（取り消した職員）。vitals.edited_by と同じ意味。';

-- 1人・1開始日に1件（生きている行だけ）
create unique index if not exists uq_resident_vital_limits
  on public.resident_vital_limits (resident_id, valid_from)
  where deleted_at is null;
-- その方の行を新しい開始日から読む
create index if not exists ix_resident_vital_limits_resident
  on public.resident_vital_limits (resident_id, valid_from desc)
  where deleted_at is null;

-- updated_at ＋ rev 自動加算（0001）／変更の記録（0010。業務日の列は valid_from）
create or replace trigger trg_updated_resident_vital_limits
  before update on public.resident_vital_limits
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_resident_vital_limits
  after update on public.resident_vital_limits
  for each row execute function public.record_history_capture('valid_from');

-- ---------- 2. 追記のみを守るトリガ ----------
create or replace function public.resident_vital_limits_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_role text;
begin
  -- 役割の分からない接続（表の所有者・service_role・SQL エディタ）は止めない（保守のため）。my_role() が無い DB も同じ
  if to_regprocedure('private.my_role()') is not null then
    execute 'select private.my_role()' into v_role;
  end if;
  if v_role is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.valid_from < v_today then
      raise exception 'vital_limits_backdated: 個人の閾値は、足した日（今日）より前の日から効かせることはできません（主治医の指示の日は根拠に書いてください）'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- 更新: 取り消し（deleted_at・deleted_by・edited_by）のほかは変えられない
  if new.resident_id is distinct from old.resident_id
     or new.valid_from is distinct from old.valid_from
     or new.temp_warn_high is distinct from old.temp_warn_high
     or new.temp_danger_high is distinct from old.temp_danger_high
     or new.temp_danger_low is distinct from old.temp_danger_low
     or new.sys_bp_danger_high is distinct from old.sys_bp_danger_high
     or new.sys_bp_warn_low is distinct from old.sys_bp_warn_low
     or new.dia_bp_danger_high is distinct from old.dia_bp_danger_high
     or new.dia_bp_warn_low is distinct from old.dia_bp_warn_low
     or new.pulse_danger_high is distinct from old.pulse_danger_high
     or new.pulse_warn_low is distinct from old.pulse_warn_low
     or new.basis is distinct from old.basis
     or new.set_by is distinct from old.set_by
     or new.client_key is distinct from old.client_key
     or new.created_at is distinct from old.created_at
     or (old.deleted_at is not null and new.deleted_at is null) then
    raise exception 'vital_limits_immutable: 個人の閾値の行は書き換えられません（変える時は新しい行を足してください）'
      using errcode = 'P0001';
  end if;
  -- 取り消しは足した日（日本時間）の当日だけ
  if old.deleted_at is null and new.deleted_at is not null
     and (old.created_at at time zone 'Asia/Tokyo')::date <> v_today then
    raise exception 'vital_limits_cancel_late: 個人の閾値の行を取り消せるのは、足した日の当日だけです（それより後は新しい行を足してください）'
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

comment on function public.resident_vital_limits_guard() is
  '個人の閾値（resident_vital_limits）を追記のみにする: 遡った追加・値の書き換え・取り消しの復活・後日の取り消しを P0001 で止める。役割 null は止めない。0045。';

revoke all on function public.resident_vital_limits_guard() from public, anon, authenticated;

create or replace trigger trg_resident_vital_limits_guard
  before insert or update on public.resident_vital_limits
  for each row execute function public.resident_vital_limits_guard();

-- ---------- 3. RLS（読む＝許可リストの職員・書く＝事務所と管理者。0034 と同じ形） ----------
alter table public.resident_vital_limits enable row level security;
drop policy if exists "read_auth"     on public.resident_vital_limits;
drop policy if exists "insert_office" on public.resident_vital_limits;
drop policy if exists "update_office" on public.resident_vital_limits;
drop policy if exists member_only     on public.resident_vital_limits;
create policy "read_auth"     on public.resident_vital_limits for select to authenticated using (true);
create policy "insert_office" on public.resident_vital_limits for insert to authenticated
  with check (private.resident_targets_writable());
create policy "update_office" on public.resident_vital_limits for update to authenticated
  using (true) with check (private.resident_targets_writable());
create policy member_only on public.resident_vital_limits as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());

-- 表の権限: anon は何もできない。authenticated の delete・truncate は外す（0034 と同じ）
revoke all on public.resident_vital_limits from anon;
revoke delete, truncate on public.resident_vital_limits from authenticated;

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST205 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（結果が表で出る。目視する）
-- ---------------------------------------------------------------------
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'resident_vital_limits')                 as limits_table_1,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'resident_vital_limits')                    as policies_4,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'resident_vital_limits' and cmd = 'DELETE') as delete_policies_0,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'resident_vital_limits'
      and grantee in ('authenticated', 'anon') and privilege_type in ('DELETE', 'TRUNCATE')) as delete_grants_0,
  (select count(*) from pg_trigger
    where tgname = 'trg_resident_vital_limits_guard' and not tgisinternal)                  as guard_trigger_1,
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'resident_vital_limits')            as realtime_0;
