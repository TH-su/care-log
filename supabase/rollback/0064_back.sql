-- 0064 を戻す（連絡帳の項目ごとの4欄の列を外す）。★書いた4欄の文も消える。流す前に中身を書き出しておく。
-- 順番: (1) 画面を 0064 より前の版に戻す（main を戻して公開）→ (2) 全端末のケアログを読み込み直す → (3) この SQL を流す。
--   ★(2) を飛ばすと、新しい版を開いたままのタブで保存が失敗し続け、そのタブでは「直した人」の記録も外れる（書き込みの道は列が無い時に
--   古い列で読み直さないため・反証 中2）。読み込み直したタブは、読み取りで列が無いと分かって古い列だけで動く。
-- 冪等。0061 の行の守り・ほかの列には触れない。
begin;
set local lock_timeout = '5s';
alter table public.daycare_contact_notes drop constraint if exists daycare_contact_notes_vital_meal_note_check;
alter table public.daycare_contact_notes drop constraint if exists daycare_contact_notes_activity_note_check;
alter table public.daycare_contact_notes drop constraint if exists daycare_contact_notes_training_note_check;
alter table public.daycare_contact_notes drop constraint if exists daycare_contact_notes_behavior_note_check;
alter table public.daycare_contact_notes drop column if exists vital_meal_note;
alter table public.daycare_contact_notes drop column if exists activity_note;
alter table public.daycare_contact_notes drop column if exists training_note;
alter table public.daycare_contact_notes drop column if exists behavior_note;
commit;
notify pgrst, 'reload schema';

select '0064 を戻した（4欄の列が無い）' as what,
       case when (select pg_catalog.count(*) from information_schema.columns
                   where table_schema = 'public' and table_name = 'daycare_contact_notes'
                     and column_name in ('vital_meal_note', 'activity_note', 'training_note', 'behavior_note')) = 0
            then 'ok' else 'NG' end as result;
