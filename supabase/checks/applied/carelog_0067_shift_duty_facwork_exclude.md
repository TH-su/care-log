# carelog_0067_shift_duty_facwork_exclude（supabase/migrations/0067_shift_duty_facwork_exclude.sql）

## 2026-11-20（日本時間）
- 流した道具: apply_migration（流した時の名前: carelog_0067_shift_duty_facwork_exclude・本文はファイルの begin〜commit の間と同じ＝注記も空白もそのまま）。そのあと notify pgrst, 'reload schema'
- 確かめの結果: ok（流す前後で比べた物: carelog_shift_duty の定義の指紋だけが変わった（38a979ef… → 02751cdf…）。権限の指紋（b4461a82…）・security definer・search_path=""・同じ名前の関数の数（1）・public の表の権限の指紋（45f6b4a8…）・public の守りの数（365）は流す前と同じ。ファイル末尾の確かめの行が ok。勤務表の名簿のうち rules.facworkExclude が true の職員は 1 人・true 以外の値は 0 件・同じ氏名の職員は 0 組）
- 戻す SQL: supabase/rollback/0067_back.sql
