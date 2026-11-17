# carelog_0063_daycare_note_lock_19（supabase/migrations/0063_daycare_note_lock_19.sql）

## 2026-11-17 18:38（日本時間）
- 流した道具: apply_migration（流した時の名前: carelog_0063_daycare_note_lock_19）
- 確かめの結果: ok（流す前後で比べた物: private.note_lock_at の本文の指紋が変わり、note_lock_blocked・note_lock_now・notes_lock_guard の指紋・security definer・search_path・権限は同じ・トリガ trg_notes_lock は1本のまま・ロックの時刻の確かめの行が ok）
- 戻す SQL: supabase/rollback/0063_back.sql
