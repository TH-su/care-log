-- =====================================================================
-- 0034: 方ごとの個別の目標（水分の目標・SpO2 の個別の下限）の表と、平熱（直近30日の定時の体温の中央値）を返す RPC
--       （バイタル・食事・水分の見やすさ A1・A3・A9。2026-10-16 本人回答）
--
-- 0001〜0033 を当てたあとに実行する。冪等（何度実行しても同じ結果）。既存のテーブル・列・データには触れない
-- （表1つ・関数2つ・索引・トリガ・ポリシーを足すだけ）。Realtime には載せない（画面は開いた時に読む。
-- alter publication … add table は2回目に 42710 で止まり冪等にできないため・0013 の注記）。
--
-- 1. resident_targets（1行 = 1人。生きている行は1人1件）
--    fluid_target_ml   … A3 水分の1日の目標（ml・制限のある方だけ。null＝施設の既定 1,200ml＝app_settings の vital_thresholds で変更可）
--    spo2_warn_below   … A9 SpO2 の個別の注意の下限（この値未満で ↓。医師の指示がある方だけ）
--    spo2_danger_below … A9 SpO2 の個別の危険の下限（この値未満で ↓↓）。注意と危険は2つ組（片方だけは持てない）・危険 ≤ 注意
--    rev・updated_at（0001 の set_updated_at_rev）・edited_by・変更の記録（0010 の record_history_capture。業務日付の列が
--    無いので 0013 の med_slots と同じく updated_at を渡す）・論理削除（deleted_at・deleted_by。delete のポリシーは作らない）・
--    client_key（端末生成の冪等キー・全体 unique）は med_slots（0013）と同じ形。値の範囲は src/lib/vitalThresholds.ts の
--    FLUID_TARGET_RANGE・SPO2_LIMIT_RANGE と同じ（変える時は同時に）。
--    RLS: 読む＝許可リストの職員（member_only）。書く（insert・update＝論理削除を含む）＝役割が office か admin のログインだけ
--      （care-backend の private.has_role('office','admin')。admin は二段階認証でない時 office に丸められるが、どちらも書ける）。
--      現場（field）・役割の分からないログイン（null）は 42501 で止まる。private.has_role が無い DB（care-backend の土台を
--      当てていない環境）では誰も書けない側に倒す（private.resident_targets_writable の to_regprocedure）。
--      取込（tools/import.mjs）などの表の所有者の接続・service_role は RLS を通らないので書ける（この表は取込の対象ではない）。
--      update の using は true（行は見える）・with check で役割を見る＝現場の更新は「0行」で黙って終わらず 42501 で止まる
--      （端末 db.ts はこの 42501 を「個別の目標は事務・管理者のログインでだけ変えられます」と出す）。
--
-- 2. public.vital_usual_temps(p_day date default null) … A1 の平熱
--    p_day（日本時間の業務日。省くとサーバーのいまの日本時間の日付）を含む直近30日（p_day−29 〜 p_day）の、
--    定時（kind='routine'）・取り消していない・体温のある測定を方ごとに数え、中央値を小数1桁（四捨五入）で返す。
--    測定が5回未満なら usual_temp は null（平熱なし＝A1 の印を出さない）。samples は数えた回数。
--    中央値は numeric のまま求める（percentile_disc の昇順と降順の平均＝偶数個の時は真ん中の2つの平均。
--    浮動小数を通さないので 36.55 が 36.5 に化けない）。
--    security invoker（vitals の RLS・member_only が中でも掛かる＝許可リストに無いログインには0行）・search_path 固定・
--    anon は実行できない。
--
-- 旧クライアント×新サーバー: 旧版はこの表も関数も知らないので何も変わらない（読まない・書かない）。既存の表・関数は触らない。
-- 新クライアント×旧サーバー（このファイルを当てる前に画面を出した時）: 端末は表が無い（42P01／PGRST205）・関数が無い
--   （PGRST202／42883）を「個別の目標なし」「平熱なし」として読み（施設の既定の基準で判定・A1 の印を出さない）、
--   目標の保存だけを「サーバー側の設定待ち」で止める。
-- 戻す時（必要な時だけ）: drop function if exists public.vital_usual_temps(date); と、表のポリシーを外す
--   （drop policy … on public.resident_targets）。表と中身は消さない（データを消さない）。
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。関数本体の as $fn$ … $fn$ は使ってよい。
-- 個人情報: このファイルに実在の氏名・記録本文・目標の値を書かない（構造だけを定義する）。
-- =====================================================================

-- ---------- 1. 個別の目標 ----------
create table if not exists public.resident_targets (
  id                bigint generated always as identity primary key,
  resident_id       bigint not null references public.residents(id),
  fluid_target_ml   int,
  spo2_warn_below   smallint,
  spo2_danger_below smallint,
  rev               int not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        bigint references public.staff(id),
  edited_by         bigint references public.staff(id),  -- 最後にこの行を書き換えた職員（0010 と同じ意味）
  client_key        text unique
);

-- 制約は名前を付けて「落としてから作る」（定義を差し替えられる・何度流しても同じ）
alter table public.resident_targets drop constraint if exists resident_targets_fluid_check;
alter table public.resident_targets add constraint resident_targets_fluid_check
  check (fluid_target_ml is null or fluid_target_ml between 100 and 5000);

alter table public.resident_targets drop constraint if exists resident_targets_spo2_check;
alter table public.resident_targets add constraint resident_targets_spo2_check
  check (
    (spo2_warn_below is null and spo2_danger_below is null)
    or (
      -- is not null を明示する（片方が null だと between が null＝check を素通りするため）
      spo2_warn_below is not null
      and spo2_danger_below is not null
      and spo2_warn_below between 50 and 100
      and spo2_danger_below between 50 and 100
      and spo2_danger_below <= spo2_warn_below
    )
  );

comment on table public.resident_targets is
  '方ごとの個別の目標（1人1件）。水分の1日の目標 ml（A3）・SpO2 の個別の注意／危険の下限（A9）。null＝施設の既定。書けるのは office・admin のログインだけ（0034）。';
comment on column public.resident_targets.fluid_target_ml is '水分の1日の目標（ml・100〜5000）。null＝施設の既定（初期 1,200ml）';
comment on column public.resident_targets.spo2_warn_below is 'SpO2 の個別の注意の下限（この値未満で注意）。危険の下限と2つ組。null＝施設の既定（93）';
comment on column public.resident_targets.spo2_danger_below is 'SpO2 の個別の危険の下限（この値未満で危険）。注意の下限以下。null＝施設の既定（90）';
comment on column public.resident_targets.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味（更新・削除のたびにアプリが送る）。';

-- 1人1件（生きている行だけ）
create unique index if not exists uq_resident_targets_resident
  on public.resident_targets (resident_id)
  where deleted_at is null;

-- updated_at ＋ rev 自動加算（0001）／変更の記録（0010。業務日付の列が無いので updated_at を渡す＝0013 の med_slots と同じ）
create or replace trigger trg_updated_resident_targets
  before update on public.resident_targets
  for each row execute function public.set_updated_at_rev();
create or replace trigger trg_history_resident_targets
  after update on public.resident_targets
  for each row execute function public.record_history_capture('updated_at');

-- 書いてよい役割か（office・admin）。private.has_role が無い DB では false（誰も書けない側に倒す）。
-- language plpgsql＋動的 execute にする理由: sql の関数やポリシーに has_role を直接書くと、関数の無い DB では
-- create の時点で 42883 になり、このファイル全体が巻き戻る。security invoker（ログインの権限で has_role を呼ぶ。
-- care-backend は has_role の実行権限を authenticated に配っている）。表には触れない。
create or replace function private.resident_targets_writable()
returns boolean
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v boolean;
begin
  if to_regprocedure('private.has_role(text[])') is null then
    return false;
  end if;
  execute 'select private.has_role(variadic array[''office'', ''admin''])' into v;
  return coalesce(v, false);
end;
$fn$;

comment on function private.resident_targets_writable() is
  '個別の目標（resident_targets）を書いてよい役割か（office・admin）。has_role が無い DB では false。0034。';

revoke all on function private.resident_targets_writable() from public, anon;
grant execute on function private.resident_targets_writable() to authenticated;

-- RLS（読む＝許可リストの職員・書く＝事務所と管理者。delete のポリシーは作らない＝物理削除は構造的に不可）
alter table public.resident_targets enable row level security;
drop policy if exists "read_auth"     on public.resident_targets;
drop policy if exists "insert_office" on public.resident_targets;
drop policy if exists "update_office" on public.resident_targets;
drop policy if exists member_only     on public.resident_targets;
create policy "read_auth"     on public.resident_targets for select to authenticated using (true);
create policy "insert_office" on public.resident_targets for insert to authenticated
  with check (private.resident_targets_writable());
create policy "update_office" on public.resident_targets for update to authenticated
  using (true) with check (private.resident_targets_writable());
-- 許可リストの有効な人だけ（care-backend 0001 と同じ形）。restrictive は上の3つと AND で効く
create policy member_only on public.resident_targets as restrictive for all to authenticated
  using (private.is_member()) with check (private.is_member());

-- 表の権限: anon は何もできない。authenticated の delete・truncate は外す（truncate は RLS を通らない＝0022 と同じ考え方）
revoke all on public.resident_targets from anon;
revoke delete, truncate on public.resident_targets from authenticated;

-- ---------- 2. 平熱（A1） ----------
create or replace function public.vital_usual_temps(p_day date default null)
returns table (resident_id bigint, usual_temp numeric, samples int)
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  with d as (
    select coalesce(p_day, (now() at time zone 'Asia/Tokyo')::date) as day
  )
  select v.resident_id,
         case when count(*) >= 5 then
           round(
             (percentile_disc(0.5) within group (order by v.temp asc)
              + percentile_disc(0.5) within group (order by v.temp desc)) / 2,
             1
           )
         end as usual_temp,
         count(*)::int as samples
    from vitals v
    cross join d
   where v.kind = 'routine'
     and v.deleted_at is null
     and v.temp is not null
     and v.measured_on between d.day - 29 and d.day
   group by v.resident_id
   order by v.resident_id
$fn$;

comment on function public.vital_usual_temps(date) is
  '平熱（A1）: p_day を含む直近30日の定時の体温の中央値（小数1桁）を方ごとに返す。5回未満は usual_temp=null。security invoker。0034。';

revoke all     on function public.vital_usual_temps(date) from public;
revoke execute on function public.vital_usual_temps(date) from anon;
grant  execute on function public.vital_usual_temps(date) to authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) ポリシー: insert_office INSERT ／ member_only ALL ／ read_auth SELECT ／ update_office UPDATE の4行（DELETE は無い）
--    select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'resident_targets' order by 1;
-- 2) 権限: anon は select も false・authenticated は select/insert/update が true・delete が false
--    select has_table_privilege('anon', 'public.resident_targets', 'select') as anon_sel,
--           has_table_privilege('authenticated', 'public.resident_targets', 'delete') as auth_del,
--           has_function_privilege('anon', 'public.vital_usual_temps(date)', 'execute') as anon_exec;
--    → f / f / f
-- 3) 平熱: select * from public.vital_usual_temps((now() at time zone 'Asia/Tokyo')::date) limit 5;
--    → resident_id・usual_temp（5回未満は空）・samples
-- ---------------------------------------------------------------------
