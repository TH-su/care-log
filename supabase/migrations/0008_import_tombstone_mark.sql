-- =====================================================================
-- 0008: 「取込が付けた墓標」の印
--
-- 0001〜0007 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- 既存のテーブル・列・データは一切削除しない（列の追加のみ）。
--
-- 背景（2026-09-01 実測）:
--   移行元（集約シート）のキーは「日付|勤務帯|物理行番号」。行の挿入や勤務帯の
--   付け替えでキーが変わると、取込は旧キーの行を「移行元から消えた」とみなして
--   soft delete を付ける（reconcileTombstones）。
--   その後キーが元に戻っても、取込は復活させない作りだった。理由は
--   「こちらで消した行は復活させない＝職員がアプリで消した記録を再取込で戻さない」
--   という正しい規則があるためだが、**取込自身が付けた墓標と職員の削除を
--   区別できていなかった**。
--   実際に 2026-08-28 の日勤1件が、記録は残っているのに画面から消えたままになった。
--
-- この列の意味:
--   import_tombstoned_at が入っている … **取込が**「移行元から消えた」として消した行。
--       移行元にキーが戻ってきたら復活させてよい（消失より復活・multi-device-sync 原則）。
--   import_tombstoned_at が空          … 取込は消していない。
--       職員がアプリで消した行はこちら＝**再取込で復活させない**（消した判断を尊重）。
--
--   アプリ側の削除経路（db.ts の softDeleteNote 等）はこの列に触れないので、
--   人の削除は構造的に空のままになる。
--
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
-- =====================================================================

alter table notes  add column if not exists import_tombstoned_at timestamptz;
alter table vitals add column if not exists import_tombstoned_at timestamptz;
alter table meals  add column if not exists import_tombstoned_at timestamptz;

comment on column notes.import_tombstoned_at is
  '取込が「移行元から消えた」として soft delete を付けた時刻。移行元に戻れば復活させてよい印。職員がアプリで消した行は空のまま＝復活させない。';
comment on column vitals.import_tombstoned_at is
  '取込が「移行元から消えた」として soft delete を付けた時刻。notes.import_tombstoned_at と同じ意味。';
comment on column meals.import_tombstoned_at is
  '取込が「移行元から消えた」として soft delete を付けた時刻。notes.import_tombstoned_at と同じ意味。';

-- ---------------------------------------------------------------------
-- 一度きりの追い付き（この列を足す前に付いた墓標へ、後から印を入れる）
--
-- なぜ入れてよいと判断したか（2026-09-01 実測。判断の根拠を残す）:
--   ・対象は notes の96件のみ。vitals / meals の取込行に墓標は0件だった
--   ・96件の deleted_at は**マイクロ秒まで同一の3つの時刻**に固まっていた
--       2026-08-30 19:30:52.588965+00（1件）
--       2026-08-31 19:31:13.796648+00（11件）
--       2026-09-01 13:49:44.690176+00（84件）
--     これは `update ... where id = any($1)` の一括1文の署名で、人が画面から
--     1件ずつ消した形ではない（1件ずつなら時刻がばらつく）。
--     うち2つは import_days.imported_at の取込実行時刻と一致する
--   ・アプリ入力（import_key が空）の削除済は0件
--   → **この96件はすべて取込が付けた墓標**と確認できたので印を入れる。
--
-- 上限の時刻で区切るのは、この移行を後から流し直した時に、以降に発生した
-- **職員の削除**へ誤って印を付けないため（印が付くと再取込で復活してしまう）。
-- ---------------------------------------------------------------------

update notes
   set import_tombstoned_at = deleted_at
 where deleted_at is not null
   and import_key is not null
   and import_tombstoned_at is null
   and deleted_at <= timestamptz '2026-09-01 13:50:00+00';

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
--   select table_name, column_name from information_schema.columns
--    where column_name = 'import_tombstoned_at' order by table_name;
--   → meals / notes / vitals の3行
-- ---------------------------------------------------------------------
