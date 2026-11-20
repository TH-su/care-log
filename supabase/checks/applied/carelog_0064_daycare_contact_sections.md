# carelog_0064_daycare_contact_sections（supabase/migrations/0064_daycare_contact_sections.sql）

## 2026-11-18 20:34（日本時間・移行の一覧の分にそろえた。初めの見出しは 20:35）
- 流した道具: apply_migration（流した時の名前: carelog_0064_daycare_contact_sections・本文はファイルの begin〜commit の間と同じ＝機械で照合）
- 確かめの結果: ok（流す前後で比べた物: daycare_contact_notes の列は4本（vital_meal_note・activity_note・training_note・behavior_note・text・null 可）だけ増え、制約は字数の守り4本だけ増えた。守り5本（read_auth・insert_auth・update_auth・member_only・tenant_only）・トリガ4本・anon と authenticated の権限（消す・空にする権限なし）は同じ。ファイル末尾の確かめの行が ok）
- 戻す SQL: supabase/rollback/0064_back.sql
