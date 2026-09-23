-- =====================================================================
-- 0010: 変更の記録（更新・削除のたびに旧値をサーバー側で必ず残す）
--
-- 0001〜0009 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- 既存のテーブル・列・データは一切削除しない（列・表・索引・トリガの追加のみ）。
--
-- 背景（2026-09-23 指示「同時入力で、どちらの記録も残るように」）:
--   2台の端末が同じ利用者・同じ日の記録をほぼ同時に書くと、後から保存した側が
--   先の値を書き換えることがある（アプリ側は 2026-09-23 に、23505 の載せ直しでは
--   空いている欄だけ埋め、食い違えば書かずに止めるよう直した）。
--   それでも「いつ・誰が・何を・何から何へ変えたか」が残っていないと、
--   書き換えや削除が起きた後に元の値を確かめる手段が無い。
--   そこで業務5表の update をトリガで捕まえ、旧行・新行をそのまま record_history に残す。
--   **アプリの善意に依存しない**（アプリがどの経路で書いても、DB が必ず残す）。
--
-- 追加するもの:
--   1. 業務5表（vitals / meals / fluid_intake / notes / outings）に edited_by
--        「最後にこの行を書き換えた職員」。アプリは更新・削除のたびに必ず送る（操作者が
--        分からない時は null）。取込（tools/import.mjs）も更新のたびに null を明示する。
--        送らない更新があると、前に触った人の値が残り、変更の記録に別の人が「操作者」として出るため。
--   2. record_history 表（旧行・新行を jsonb で1行ずつ）
--   3. after update トリガ（5表）
--        ・rev / updated_at / edited_by 以外に変化が無い更新は記録しない
--        ・deleted_at が 空→値あり になった更新は op='delete'（それ以外は 'update'）
--        ・changed_by_staff に new.edited_by を写す／changed_by_uid はログイン中の uid
--   4. RLS: authenticated は select のみ。insert / update / delete のポリシーは作らない
--        ＝トリガ経由でしか入らない（改ざん・削除できない）。anon は全拒否。
--
-- アプリとの適用順:
--   どちらが先でもよい。アプリは edited_by 列が無い DB（このファイル未適用）で
--   列が無いエラー（PGRST204 / 42703）を受けると、edited_by を外して送り直し、
--   その起動中は以後付けない（保存は失敗しない）。変更の記録の画面は
--   表が無い間「未設定」と出す。
--
-- 注意:
--   ・取込（tools/import.mjs 等）が業務表を update した場合も記録される（changed_by_staff は空）。
--     内容が変わらない再取込（rev / updated_at だけが動く更新）は記録しない。
--   ・insert は記録しない（行そのものが最初の値＝旧値が無い）。
--   ・このファイルに実在の氏名・記録本文を書かない（構造だけを定義する）。
--
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
--   関数本体の as $$ … $$ は使ってよい（0001 の set_updated_at_rev と同じ）。
-- =====================================================================

-- ---------- 1. 最後にこの行を書き換えた職員 ----------
alter table vitals       add column if not exists edited_by bigint references staff(id);
alter table meals        add column if not exists edited_by bigint references staff(id);
alter table fluid_intake add column if not exists edited_by bigint references staff(id);
alter table notes        add column if not exists edited_by bigint references staff(id);
alter table outings      add column if not exists edited_by bigint references staff(id);

comment on column vitals.edited_by is
  '最後にこの行を書き換えた職員（更新・削除のたびにアプリが送る。操作者が分からない更新と取込の更新は null を書く）。変更の記録（record_history.changed_by_staff）に写される。';
comment on column meals.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味。';
comment on column fluid_intake.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味。';
comment on column notes.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味。';
comment on column outings.edited_by is
  '最後にこの行を書き換えた職員。vitals.edited_by と同じ意味。';

-- ---------- 2. 変更の記録 ----------
create table if not exists record_history (
  id               bigint generated always as identity primary key,
  table_name       text not null,                    -- vitals / meals / fluid_intake / notes / outings
  row_id           bigint not null,                  -- その表の id
  resident_id      bigint,                           -- null = 全体連絡の申し送り
  record_day       date,                             -- measured_on / meal_on / taken_on / note_on / start_on
  op               text not null check (op in ('update','delete')),
  rev_before       int,
  rev_after        int,
  old_row          jsonb not null,                   -- 更新前の行そのもの
  new_row          jsonb not null,                   -- 更新後の行そのもの
  changed_at       timestamptz not null default now(),
  changed_by_staff bigint,                           -- new.edited_by を写す（分からない更新は null）
  changed_by_uid   uuid default auth.uid()           -- ログイン中の uid（取込など直接接続では null）
);

comment on table record_history is
  '業務5表の更新・削除の記録（旧行・新行）。トリガ record_history_capture だけが書く。アプリからは読むだけ（insert/update/delete 不可）。';

-- 利用者 × 業務日付（個人の変更の記録を日付範囲で引く）
create index if not exists idx_record_history_resident
  on record_history (resident_id, record_day desc);
-- 1行の変更の履歴（同じ記録が何度書き換えられたか）
create index if not exists idx_record_history_row
  on record_history (table_name, row_id, changed_at desc);

-- ---------- 3. トリガ ----------
-- 引数（tg_argv[0]）はその表の業務日付の列名。5表で同じ関数を使う。
-- security definer: 呼び出した職員の権限では record_history に書けない（ポリシーが無い）ので、
--   関数の所有者の権限で書く。search_path を public に固定して、別スキーマの同名表へ
--   すり替えられないようにする。
create or replace function record_history_capture() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  o       jsonb;
  n       jsonb;
  day_col text;
begin
  o := to_jsonb(old);
  n := to_jsonb(new);
  day_col := tg_argv[0];

  -- 版・更新時刻・触った人だけが動いた更新（内容が同じ再保存・再取込）は記録しない
  if (o - 'rev' - 'updated_at' - 'edited_by') = (n - 'rev' - 'updated_at' - 'edited_by') then
    return null;
  end if;

  insert into record_history (
    table_name, row_id, resident_id, record_day, op,
    rev_before, rev_after, old_row, new_row, changed_by_staff
  ) values (
    tg_table_name,
    (n ->> 'id')::bigint,
    (n ->> 'resident_id')::bigint,
    (n ->> day_col)::date,
    case when (o ->> 'deleted_at') is null and (n ->> 'deleted_at') is not null
         then 'delete' else 'update' end,
    (o ->> 'rev')::int,
    (n ->> 'rev')::int,
    o,
    n,
    (n ->> 'edited_by')::bigint
  );
  return null; -- after トリガなので戻り値は使われない
end;
$$;

create or replace trigger trg_history_vitals
  after update on vitals       for each row execute function record_history_capture('measured_on');
create or replace trigger trg_history_meals
  after update on meals        for each row execute function record_history_capture('meal_on');
create or replace trigger trg_history_fluid_intake
  after update on fluid_intake for each row execute function record_history_capture('taken_on');
create or replace trigger trg_history_notes
  after update on notes        for each row execute function record_history_capture('note_on');
create or replace trigger trg_history_outings
  after update on outings      for each row execute function record_history_capture('start_on');

-- ---------- 4. RLS ----------
-- select だけを authenticated に許す。insert / update / delete のポリシーは作らない
-- （ポリシー不存在 = 全拒否）。anon にはポリシーを1つも作らない＝全拒否。
-- 権限も明示的に外す（truncate は RLS を通らないので必ず外す）。
alter table record_history enable row level security;
drop policy if exists "read_auth" on record_history;
create policy "read_auth" on record_history for select to authenticated using (true);

revoke insert, update, delete, truncate on record_history from anon, authenticated;
revoke select on record_history from anon;

-- PostgREST のスキーマキャッシュを即時リロード（適用直後の 404/PGRST205 期間を短縮）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) edited_by が5表に入ったか
--    select table_name from information_schema.columns
--     where table_schema = 'public' and column_name = 'edited_by' order by table_name;
--    → fluid_intake / meals / notes / outings / vitals の5行
--
-- 2) トリガが5表に付いたか
--    select event_object_table, trigger_name from information_schema.triggers
--     where trigger_name like 'trg_history_%' order by event_object_table;
--    → 5行（fluid_intake / meals / notes / outings / vitals）
--
-- 3) ポリシーが select だけか（insert / update / delete の行が無いこと）
--    select policyname, roles, cmd from pg_policies
--     where schemaname = 'public' and tablename = 'record_history';
--    → read_auth {authenticated} SELECT の1行だけ
--
-- 4) 権限（anon は何も持たない／authenticated は SELECT だけ）
--    select grantee, privilege_type from information_schema.role_table_grants
--     where table_schema = 'public' and table_name = 'record_history'
--       and grantee in ('anon','authenticated') order by grantee, privilege_type;
--    → authenticated の行は SELECT（と REFERENCES / TRIGGER）だけ。anon の SELECT / INSERT /
--      UPDATE / DELETE / TRUNCATE が無いこと
--
-- 5) 記録されるか（合成データで確認する。実データでは試さない）
--    update vitals set temp = temp where id = <合成行のid>;       -- 内容が同じ → 記録されない
--    update vitals set note = '確認' where id = <同上>;           -- 内容が変わる → 1行増える
--    select op, rev_before, rev_after, old_row->>'note', new_row->>'note'
--      from record_history where table_name = 'vitals' and row_id = <同上>
--     order by changed_at desc limit 5;
--    → op='update'・rev が1つ進んでいる。確認後は note を元へ戻す（戻した更新も1行残る）
-- ---------------------------------------------------------------------
