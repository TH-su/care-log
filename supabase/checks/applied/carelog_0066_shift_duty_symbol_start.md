# carelog_0066_shift_duty_symbol_start（supabase/migrations/0066_shift_duty_symbol_start.sql）

## 2026-11-19（日本時間）
- 流した道具: apply_migration（流した時の名前: carelog_0066_shift_duty_symbol_start・本文はファイルの begin〜commit の間と同じ＝注記も空白もそのまま）
- 確かめの結果: ok（流す前後で比べた物: carelog_shift_duty の定義の指紋だけが変わった（ed760c95… → 38a979ef…）。権限の指紋（d1707186…）・security definer・search_path=""・同じ名前の関数の数（1）・public の表の権限の指紋（a97eeed1…）・public の守りの数（349）は流す前と同じ。ファイル末尾の確かめの行が ok。勤務表の記号マスタのうち start を持つ記号は 54 件）
- 戻す SQL: supabase/rollback/0066_back.sql
