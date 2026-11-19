# carelog_0065_daily_read_checks（supabase/migrations/0065_daily_read_checks.sql）

## 2026-11-19 09:47（日本時間）
- 流した道具: apply_migration（流した時の名前: carelog_0065_daily_read_checks・本文はファイルの begin〜commit の間と同じ＝注記も空白もそのまま）
- 確かめの結果: ok（流す前後で比べた物: public の表 +1（daily_read_checks）・守り +5（read_auth・insert_auth・update_auth・member_only・tenant_only）・関数 +2（daily_read_check_guard・carelog_shift_duty）・トリガ +3。ほかの表の守りと anon・authenticated の権限の指紋は流す前と同じ。ファイル末尾の確かめの行が ok。carelog_shift_duty は事務所のログインを真似た取引（rollback）で呼び、mode live・職員の項目は id・name・mainDivision・active・status・retireMonth の6つだけを返すことを確かめた）
- 戻す SQL: supabase/rollback/0065_back.sql
