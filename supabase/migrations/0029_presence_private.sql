-- =====================================================================
-- 0029: 「入力中」「書いています」の居場所（Presence・チャンネル cl_note_presence）を、許可リストの職員だけに限る
--       （監査 F25・2026-10-10 本人回答「Presence を private チャンネル＋realtime.messages のポリシーで許可リストの職員だけに」）
--
-- 0001〜0028 を当てたあとに実行する。冪等（何度実行しても同じ結果）。
-- 業務の表・列・データには触れない（Realtime の認可の表 realtime.messages にポリシーを2つ足すだけ）。
--
-- なぜ:
--   居場所のチャンネルは公開（private の指定なし）で、公開の JS に載っている anon キーさえあれば、ログインしていない者でも
--   「どの職員ID が・どの日の・どの利用者ID の・どの欄を入力中か」を実時間で受け取れ、偽の「入力中」を全端末へ流せた。
--   表のほうは 0019 で member_only（許可リストの有効な人だけ）に絞ってあるが、居場所はその外にあった。
--
-- 形（Supabase の Realtime 認可＝private チャンネルは realtime.messages の RLS で参加・受信・送信を判定する）:
--   ・受け取る（select）と配る（insert）の2本。どちらも to authenticated・extension = 'presence'・
--     トピックが cl_note_presence（realtime.topic() の値。'realtime:' の接頭辞は付かない）・private.is_member()。
--     片方だけだと「受け取れるが配れない」「配れるが受け取れない」になり、画面は黙って何も出さない（気づけない）。
--   ・anon にはポリシーを作らない＝ログインしていない者は参加できない。
--   ・他のトピック・broadcast には何も許さない（このアプリは居場所の private チャンネルしか使わない）。
--   ・記録の自動反映（postgres_changes の4本）は公開チャンネルのまま（この移行の対象外）。**ダッシュボードの Realtime 設定で
--     「公開チャンネルを許す」を切ってはいけない**（切ると記録の多端末同期が止まる）。
--
-- ★適用の順番: **DB が先、アプリが後**。ポリシーを先に足しても、いまの公開チャンネル（旧版の端末）には何も影響しない。
--   新しい版の端末は private チャンネルに参加する。行き渡るまでは、新旧の端末どうしで互いの「入力中」が見えない
--   （表示の補助が欠けるだけで、保存・画面は止まらない）。
-- ★適用の後に必ず確かめる: 職員の端末2台で同じ日報を開き、互いの「入力中」が見えること（private の参加が断られると
--   画面は何も出さないので、見えないままなら設定かポリシーの不備）。
--
-- 旧クライアント×新サーバー: 旧版は公開チャンネルのままで、ポリシーは公開チャンネルに掛からない＝今までどおり。
--   データ（記録）には関係しない。
-- 新クライアント×旧サーバー（ポリシーが無い）: 新しい版の private チャンネルは参加を断られ、「入力中」が出ないだけ
--   （保存・画面は止まらない。端末は失敗を console に1回残す）。
--
-- ★ do $$ … $$ のブロックは使わない（Supabase の SQL エディタが誤解釈するため）。
-- 個人情報: このファイルに実在の氏名を書かない（構造だけを定義する）。
-- =====================================================================

-- 受け取る（他の端末の居場所を見る・参加する）
drop policy if exists "cl_presence_read" on realtime.messages;
create policy "cl_presence_read" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'presence'
    and (select realtime.topic()) = 'cl_note_presence'
    and (select private.is_member())
  );

-- 配る（自分の居場所を track する）
drop policy if exists "cl_presence_write" on realtime.messages;
create policy "cl_presence_write" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and (select realtime.topic()) = 'cl_note_presence'
    and (select private.is_member())
  );

-- ---------------------------------------------------------------------
-- 適用後の確認（SQL エディタで実行して目視する）
--
-- 1) ポリシーが2本あるか
--    select policyname, cmd, roles from pg_policies where schemaname = 'realtime' and tablename = 'messages'
--      and policyname like 'cl_presence_%' order by 1;
--    → cl_presence_read SELECT {authenticated} ／ cl_presence_write INSERT {authenticated}
--
-- 2) 職員の端末2台で日報を開き、互いの「入力中」が見えること（上の★）
--
-- 戻す時（必要な時だけ。新しい版の端末は「入力中」が出なくなるだけ）:
--    drop policy if exists "cl_presence_read" on realtime.messages;
--    drop policy if exists "cl_presence_write" on realtime.messages;
-- ---------------------------------------------------------------------
