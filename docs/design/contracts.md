# モジュール契約（凍結・全ビルダー共通）

L0承認済み。詳細設計の正本: `docs/PLAN.md`・`docs/design/db-design.md`・`docs/design/ui-design.md`・`docs/design/qa-verification.md`。
**実装済み・変更禁止**: `src/lib/types.ts` / `src/lib/format.ts` / `src/lib/supabase.ts` / `src/main.tsx` / `src/index.css` / `src/styles/tokens.css` / `tailwind.config.js` / 各種設定ファイル。
契約の変更が必要になったら、実装せず「積み残し」として報告する。

## 共通規律

- Tailwind はトークン由来クラスのみ。arbitrary value（`text-[14px]`・`bg-[#…]`）と色・px直書き禁止
- `supabase.from()` / `supabase.rpc()` の直呼びは `src/lib/db.ts` と `src/lib/gasClient.ts` のみ。他は db.ts の関数を使う
- 個人情報（氏名・本文・応答データ）を console に出さない。コード・コメント・placeholder に実名を書かない（例示は「山田」等の汎用サンプル可・実在データ由来は不可）
- 全画面にローディング／エラー／空の3状態。エラー文は「何が起きたか＋次にどうすればよいか」
- タップ要素は min-height/width 44px（`min-h-tap`）＋隣接 gap 8px（`gap-gap` 等）
- 破壊的操作（削除・確定上書き）は確認ダイアログ or Undo。1タップ不可逆を作らない
- 読み取り経路から書き込まない（既読付与も明示操作のみ）
- 更新系は rev 照合。conflict 時は入力を消さず再読込を促す

## ルーティング（HashRouter・App.tsx が定義）

`/`=タイムライン ・ `/record`=記録ハブ ・ `/record/vitals` ・ `/record/meals` ・ `/record/note` ・ `/record/outing` ・ `/karte`=利用者一覧 ・ `/karte/:id` ・ `/search` ・ `/settings` ・ `/login`

追加（2026-09-26・代表承認）: `/record/bath`=入浴（デイ）の記録（記録ハブの5つ目）・`/bath/month`=入浴 月次表（「その他」から。`LS.view` の既知値 `bathMonth`）

追加（2026-09-26・代表承認）: `/record/med`=与薬チェック（記録ハブの6つ目）・`/med/slots`=服薬の時間帯・`/med/month`=与薬 月次表
（後の2つは「その他」から。`LS.view` の既知値 `medSlots` / `medMonth`）

リロード復元: HashRouter のURLが第一。ベースURL直開き時のみ `LS.view` の既知値照合で復元。

## src/lib/db.ts が export するAPI（他ビルダーはこれを import する）

2026-09-23 に db.ts の export と照合して更新（撤去済みの insertVital / updateVital / insertMeal / updateMeal を外し、
バイタル・食事の保存 API と Presence を足した）。日報・一覧画面用の追加 API（fetchDailyReport(s)・fetchVitalsSheet・
fetchMealsSheet・updateNoteFields・saveAttendance・fetchNotesForTargetDay）は `docs/design/sheet-contracts.md` §3。

```ts
export type Conflict = 'conflict'
export type Queued = 'queued'   // 通信失敗→永続キュー(cl_sendQueue／バイタル・食事は cl_sendQueue2)に退避済み

isSupabaseConfigured(): boolean                  // 接続先（.env）が設定されているか
fetchResidents(): Promise<Resident[]>            // active・room昇順
fetchAllResidents(): Promise<Resident[]>         // 退居された方も含む全員・居室昇順（申し送りでの表示名の重複判定用）
setResidentNoteAlias(id: number, alias: string | null): Promise<Resident | Queued>  // 申し送りでの表示名
fetchStaff(): Promise<Staff[]>                   // active・name昇順
fetchTimelineChunk(fromIso: string, toIso: string, staffId: number | null): Promise<TimelineChunk>  // RPC timeline_chunk
fetchKarte(residentId: number, fromIso: string, toIso: string):
  Promise<{ vitals: Vital[]; meals: Meal[]; fluids: FluidIntake[]; notes: Note[]; outings: Outing[]; baths: BathRecord[]; meds: MedAdmin[] }>
                                                               // baths / meds は 2026-09-26 追加。0012 / 0013 未適用の DB では [] で返し、カルテ全体を失敗させない
searchNotes(p: { q: string; target: 'body' | 'reporter'; fromIso: string; toIso: string;
  importance?: Importance; shift?: Shift; limit?: number }): Promise<Note[]>

// バイタル・食事の保存（送信待ち → RPC apply_cell_edits の1本。設計の正本は docs/design/concurrent-entry.md）
saveVitalEdits(target: VitalTarget, sendEdits: CellEditInput<VitalCellField>, opts?: CellSaveOpts):
  Promise<CellSaveResult<Vital> | Queued>                      // 例外＝サーバーが拒否（送信待ちに rejected として残る）
saveMealEdits(target: MealTarget, sendEdits: CellEditInput<MealCellField>, opts?: CellSaveOpts):
  Promise<CellSaveResult<Meal> | Queued>
pendingRow(table: CellTable, target: VitalTarget | MealTarget): PendingCellRow | null   // その行の送信待ち・止まっている入力
discardPendingRow(table: CellTable, target: VitalTarget | MealTarget, fields?: readonly string[],
  vers?: Record<string, string>): Promise<void>                // 取り下げ（vers＝画面が見た版のままの欄だけ）
fetchLatestVital(target: { routine: true; residentId: number; day: string } | { routine: false; id: number }):
  Promise<LatestRow<Vital> | null>                             // くらべて選ぶ画面の取り直し
fetchLatestMeal(residentId: number, day: string, slot: MealSlot): Promise<LatestRow<Meal> | null>
newClientKey(): string                                         // 定時以外のバイタル・申し送り等の冪等キー

// 水分・申し送り・外出（従来の送り方。opts.editedBy で記入者を記録ごとに渡せる）
insertFluid(f: Omit<FluidIntake, 'id' | 'rev'>): Promise<FluidIntake | Queued>
softDeleteFluid(id: number, rev: number, opts?: WriteOpts): Promise<true | Conflict | Queued>   // 通信断はキューへ退避（2026-09-02）
insertNote(n: Omit<Note, 'id' | 'rev' | 'read_count' | 'my_read'>): Promise<Note | Queued>
updateNote(id: number, rev: number, patch: Partial<Omit<Note, 'id' | 'rev'>>, opts?: WriteOpts): Promise<Note | Conflict | Queued>
softDeleteNote(id: number, rev: number, opts?: WriteOpts): Promise<true | Conflict | Queued>
endOngoingNote(id: number, rev: number, endedBy: number | null, opts?: WriteOpts): Promise<Note | Conflict | Queued>  // ended_by に操作者を書く
insertOuting(o: Omit<Outing, 'id' | 'rev'>): Promise<Outing | Queued>
setOutingEnd(id: number, rev: number, endOn: string, endAt: string | null, opts?: WriteOpts): Promise<Outing | Conflict | Queued>  // 部分更新・他項目を送らない
setEditor(id: number | null): void                             // 更新系で edited_by として送る操作者（App が確定・切替のたびに呼ぶ）

markRead(noteId: number, staffId: number): Promise<void>       // 明示操作からのみ呼ぶ。通信断はキュー（kind:'read'）へ退避し例外を投げない
fetchNoteReaders(noteId: number): Promise<Staff[]>             // note_reads×staff・read_at昇順・limit100・氏名表示のみ
fetchUnreadCount(staffId: number, sinceIso: string): Promise<number>
getNativeInputGate(): Promise<{ value: boolean; observed: boolean }>  // observed=サーバー値を一度でも観測できたか
getNativeInputEnabled(): Promise<boolean>                      // 互換用。gate.value を返す（既定 false）
getAppSetting(key: string): Promise<string | null>

subscribeChanges(cb: (table: string, info?: ChangeInfo) => void): () => void
                                                               // Realtime。第2引数は変更行（DELETE は row=null）。受信値は型検査・表示ウィンドウ外は無視
isSelfWrite(table: string, row: unknown): boolean             // 自分の書込の通知か（行単位で見分ける）
isSeenRev(seenRev: number | null, row: unknown): boolean
joinPresence(self: PresenceHere | null, onChange: (others: PresenceHere[]) => void):
  { update: (next: PresenceHere | null) => void; stop: () => void }   // 居場所の Presence（チャンネル cl_note_presence・DBに書かない）
joinNotePresence(self: PresenceHere, onChange: (others: PresenceHere[]) => void):
  { update: (next: PresenceHere) => void; stop: () => void }          // 同じチャンネルの申し送りの居場所だけ（欄を入力中の要素は除く）
queuePending(): number
queueSubscribe(cb: (n: number) => void): () => void
flushQueue(force?: boolean): Promise<void>                     // 成功観測後にのみキューから消す（保全ゲート）
onNetworkBack(): void                                          // 電波が戻った時の再送（待ち時間が残っていても送る）
isQueueBroken(): boolean                                       // localStorage の未送信データが壊れていて読めなかったか
isQueuePersisted(): boolean                                    // 退避した書込を端末に残せているか（false＝メモリ上だけ）
onAuthExpired(cb: () => void): void                            // 401検知→キュー保全のまま再ログインへ
fetchRecordHistory(p: { residentId?: number | null; fromIso: string; toIso: string; limit?: number }):
  Promise<RecordHistoryResult>                                 // 変更の記録（0010 未適用なら available:false）
diffHistoryRow(oldRow: unknown, newRow: unknown): { column: string; before: unknown; after: unknown }[]

// ── 入浴（デイ）・種類ごとの入力解禁（2026-09-26 追加・代表承認の契約改訂。既存の定義は変えない） ──
getKindInputGate(kind: InputKind): Promise<{ value: boolean; observed: boolean }>  // app_settings.input_enabled_<kind>（bath/med/incident）
kindBlockedMessage(kind: InputKind): string                    // 封鎖中の理由文（入浴:「入浴の記録はまだ使い始めていません（開始日に解禁します）」）
fetchBathDay(dayIso: string): Promise<BathRecord[]>            // その日の入浴記録（削除済みを除く）
fetchBathMonth(monthKey: string): Promise<BathRecord[]>        // 'yyyy-MM' の月の入浴記録。取り切れない時は例外（黙って切らない）
fetchBathPlan(dayIso: string, residents?: Resident[]): Promise<BathPlanResult>
                                                               // RPC daycare_bath_plan を名簿と source_id で突き合わせる
                                                               // { available, updatedAt（写しの更新時刻）, entries:[{residentId,startTime,endTime,hospitalized}], unmatched }
insertBath(b: Omit<BathRecord, 'id' | 'rev'>): Promise<BathRecord | Conflict | Queued>
                                                               // client_key 付き。1人1日1件の 23505（自分のキーでない）は 'conflict'
hasPendingBath(residentId: number, day: string, recordId: number | null): boolean
                                                               // このタブの送信待ち（送信中を含む・blocked は除く）に、その人・その日の追加か
                                                               // その記録の修正・取り消しがあるか。読むだけ。画面はこの行の区分ボタン・取り消しを押せなくする
                                                               // （送信待ちの経路は他の表と同じ。差し替え・破棄はしない＝2026-09-26 レビュー3巡目）
fetchBathFirstDay(): Promise<string | null>                    // 施設全体で最初の入浴記録の日（月次表の「未」を付け始める日。1行だけ引く）
updateBath(current: BathRecord, patch: Partial<Pick<BathRecord, 'result' | 'cancel_reason' | 'note'>>, opts?: WriteOpts):
  Promise<BathRecord | Conflict | Queued>                      // rev 照合の部分更新。中止以外にしたら cancel_reason は null で送る
softDeleteBath(id: number, rev: number, opts?: WriteOpts): Promise<true | Conflict | Queued>
subscribeBathChanges(cb): () => void                           // 入浴記録の Realtime（既存7表とは別のチャンネル）

// ── 与薬チェック（服薬介助・2026-09-26 追加・代表承認の契約改訂。既存の定義は変えない） ──
fetchMedSlots(residents?: Resident[]): Promise<MedSlotsSetting[]>   // 在籍の方の服薬の時間帯（resident_id で絞って引く）
fetchMedDay(dayIso: string): Promise<MedAdmin[]>               // その日の与薬の記録（時間帯・頓服とも。削除済みを除く）
fetchMedMonth(monthKey: string, residentId?: number): Promise<MedAdmin[]>
                                                               // 1人なら1回・全員なら7日ずつ分けて引く（1回2,000行を超えない）。取り切れない時は例外
fetchMedFirstDay(): Promise<string | null>                     // 施設全体で最初の与薬の記録の日（月次表の「未」を付け始める日）
setMedSlots(residentId: number, slots: readonly MedSlot[], note: string | null, current: MedSlotsSetting | null, opts?: WriteOpts):
  Promise<MedSlotsSetting | Conflict | Queued>                 // current が null なら insert（client_key）、あれば rev 照合 update。upsert は使わない
insertMedAdmin(m: Omit<MedAdmin, 'id' | 'rev' | 'created_at'>): Promise<MedAdmin | Conflict | Queued>
                                                               // client_key 付き。1人1日1時間帯1件の 23505（自分のキーでない）は 'conflict'
updateMedAdmin(current: MedAdmin, patch: Partial<Pick<MedAdmin, 'status' | 'note' | 'given_at' | 'prn_drug' | 'prn_reason' | 'prn_effect'>>,
  opts?: WriteOpts): Promise<MedAdmin | Conflict | Queued>     // rev 照合の部分更新（変えた項目と edited_by だけ）
softDeleteMedAdmin(id: number, rev: number, opts?: WriteOpts): Promise<true | Conflict | Queued>
hasPendingMed(residentId: number, day: string, slot: MedAdminSlot, recordId?: number | null): boolean
                                                               // このタブの送信待ち（送信中を含む・blocked は除く）にそのマスの追加か、その記録の修正・取り消しがあるか。
                                                               // 読むだけ。頓服で recordId を渡した時はその記録の修正・取り消しだけを見る
hasPendingMedSlots(residentId: number, recordId: number | null): boolean   // 服薬の時間帯の同じ判定
pendingPrnOps(day: string): PendingPrn[]                       // このタブの送信待ちにある、その日の頓服の追加（未送信・送信中・止まっている）。読むだけ。
                                                               // 頓服一覧は「サーバーの記録」＋これで描く（再読み込み・日付切替で未送信が消えない＝二重記録を防ぐ）
subscribeMedChanges(cb): () => void                            // med_slots・med_admin の Realtime（既存・入浴とは別のチャンネル）
```

- 服薬の時間帯（med_slots）・与薬の記録（med_admin）は入浴記録と同じ送り方（client_key・rev 照合・送信待ち cl_sendQueue・edited_by）。
  入力解禁は input_enabled_med（与薬の記録だけ）。服薬の時間帯はどの旗の封鎖も受けない（使い始める前に看護師が設定できるように・2026-09-26 チーフ裁定）。送信待ちの insert が自然キー（1人1件・1人1日1時間帯1件）の 23505 になった時は blocked='conflict' で止めて残す。
  送信待ちの中身は書き換えない・破棄しない（未送信のマス・行は画面が hasPendingMed / hasPendingMedSlots で押せなくする）
- 与薬チェックの日次表の「未」と「未記録 N」は、input_enabled_med が解禁済み かつ 記録を始めた日（fetchMedFirstDay）以降の日だけ（月次表とそろえる・medMissingAllowed）。
  カルテの与薬の取得上限は食事と同じ MAX_ROWS
- 純ロジック（締め判定・1日の表・件数・マスを押した時の動き・入力の検証・月次集計）は `src/lib/med.ts`。締め時刻は `MED_DEADLINES`（将来設定化できる形）
- 印刷の部品は向き（orientation='portrait'）と1ページずつ（paged・中身の .cl-print-page ごとに改ページ）を足した。既定（横・1枚に収める）は従来どおり

- 入浴記録（bath_records）は水分・申し送り・外出と同じ送り方（client_key・rev 照合・送信待ち cl_sendQueue・edited_by）。
  入力解禁だけは native_input_enabled ではなく input_enabled_bath で判定する（既存の封鎖・cells の挙動は変えない）。
  送信待ちの insert が「他の端末が先に同じ人・同じ日を記録した」23505 になった時は blocked='conflict' で止めて残す
- Realtime は既存の購読（REALTIME_TABLES の1チャンネル）に混ぜない。配信対象に無い表を含む購読はチャンネルごと拒否されるため、
  0012 を当てる前の DB でも既存7表の同期が止まらないよう、入浴は別チャンネル（subscribeBathChanges）にした
- 純ロジック（曜日・予定と記録の突き合わせ・件数・月次集計・入力の検証）は `src/lib/bath.ts`。印刷の部品は `src/components/print/PrintArea.tsx`

- バイタル・食事は insert / update を端末から直接呼ばない（saveVitalEdits / saveMealEdits → RPC apply_cell_edits が欄ごとに裁く）。
  下の insert 系の規則は、それ以外の表（水分・申し送り・外出・既読・出勤者・表示名）の従来の送り方に当てはまる
- insert系: 23505（unique衝突）は他端末先行の証拠 → 既存行を再読込して update に切替（upsert は使わない）
- 自然キーを持たない insert（notes / fluid_intake / outings / **vitals の routine 以外＝recheck・observation・symptom**）は
  端末生成の冪等キー `client_key` を必ず付ける。キューへ退避した op は同じ client_key で再送し、
  23505 は「既に届いている」証拠として既存行を読み直して成功扱いにする
  （**vitals routine と meals は部分unique索引が同じ役目を果たすため付けない**。routine に付けると 23505 の切替先が
  client_key になり、他端末が先に作った定時行へ update で合流できなくなる）
- 送信キューの flush は Web Locks（`cl_sendQueue_flush` / `ifAvailable`）で1タブに絞る。取れなければ送らない
  （navigator.locks が無い環境は従来どおり送る＝冪等キー側で二重登録を防ぐ）
- 送信キューの localStorage は2つのキーに分ける（2026-09-23）。設計の正本は `docs/design/concurrent-entry.md`
  - `cl_sendQueue` … 水分・申し送り・外出・既読・出勤者・表示名の退避 op。形は `{ ops: [op…], brokenRaw? }`（旧ビルドと同じ形）
  - `cl_sendQueue2` … バイタル・食事の送信待ち。形は `{ ver: 2, rows: {行キー: 欄ごとの値・基準・版}, done: [送信済み・取り下げた版の記録], brokenRaw? }`。
    旧ビルドはこのキーに触れない（旧ビルドへ戻しても消えない。戻している間は送られず、新しいビルドへ戻すと送られる）。
    `cl_sendQueue` にあるバイタル・食事の op は、`cl_sendQueue2` に書けたと読み直して確かめてから移す
  - 書き戻しは両方とも Web Locks（`cl_sendQueue_write`）の中で「読み直し → 和集合 → 書き戻し」
- `queuePending()` / `queueSubscribe` は localStorage 上の qid 付き未送信 op とメモリキューの和集合を数える（他タブ由来も含む）
- 全読取に `.is('deleted_at', null)` と limit（既定上限2000）。日付レンジ or resident_id の無いクエリを書かない
- `fetchKarte` の outings は「start_on ≤ to かつ（end_on is null または end_on ≥ from）」＝期間に重なる行を採る

## src/lib/actor.ts

```ts
getActorId(): number | null
setActorId(id: number): void
clearActor(): void
resolveActor(staff: Staff[]): Staff | null   // 照合失敗（不在・inactive・不正値）は null
shouldReconfirm(): boolean                   // 日替わり or 最終操作から4時間
touchActivity(): void
```

## src/lib/gasClient.ts（読み取り専用。書込actionのコードパスを作らない）

```ts
export interface RosterEntry { id: string; name: string; kana?: string; room?: string; gender?: string; careLevel?: string }
pullRoster(url: string, token: string): Promise<RosterEntry[]>
pullStaffNames(url: string, token: string): Promise<string[]>
export interface SyncResult { before: number; after: number; added: number; deactivated: number; renamed: number; needsReview: number }
syncMasters(): Promise<{ residents: SyncResult; staff: SyncResult } | 'unconfigured'>
// LS.gasUrl / LS.gasToken（localStorage手入力）を読む。未設定なら 'unconfigured'。
// Supabase residents/staff スナップショットへ反映（source_id+氏名の二重照合・不一致は needs_review=true）。
// 増減両方向を master_sync_log に記録。応答本文を console に出さない。
```

## src/hooks/useTimeline.ts

```ts
useTimeline(staffId: number | null): {
  days: DayData[]; loading: boolean; error: string | null;
  loadMore(): void; hasMore: boolean; refresh(): void;
  trimmed: boolean;        // DOM上限60日で新しい側/古い側を落とした状態
  resetToLatest(): void;
}
// 初期10日＋追加10日（fetchTimelineChunk）。日単位に組み替えて DayData[]（新しい日が先頭）。
// Realtime: subscribeChanges で表示ウィンドウ内の日だけ再取得。保持上限60日。
```

## src/components/ui.tsx が export する共通部品

```tsx
Chip({ children, tone?: 'plain'|'warn'|'danger'|'ok'|'info'|'accent', onClick?, className? })   // onClick 有りは縦ヒット44px化
LevelCell({ value: number | null, level: Level, digits?: number })   // 値+記号(LEVEL_MARK)+色bg。null は「—」
SectionCard({ title?, children, className? })
LoadingBlock({ label? })
ErrorBlock({ message, onRetry? })
EmptyBlock({ message, actionLabel?, onAction? })
ConfirmDialog({ open, title, body?, confirmLabel?, danger?, onConfirm, onCancel })
useToast(): { toast: ReactNode; show(msg: string, undo?: () => void): void }   // Undo は8秒
SegmentPicker({ options: { value: string; label: string }[], value, onChange, ariaLabel? })
StaffPickerModal({ open, staff: Staff[], onPick(id: number), onClose?, title? })   // かな絞込付き・行高44px
ResidentPickerModal({ open, residents: Resident[], onPick(id: number | null), onClose, allowAll? })  // allowAll=「スタッフへ（全体）」= null
```

## App.tsx の責務

認証ゲート（useAuth: 未ready=ローディング／未ログイン=/login）→ 入力解禁フラグ取得（getNativeInputEnabled・封鎖中は入力画面をディセーブル＋理由文）→ actor ゲート（resolveActor 失敗 or shouldReconfirm で StaffPickerModal）→ シェル（スティッキーヘッダ: 画面名・未送信n件・操作者チップ／タブ: <768px下部・≥1024px左レール、アイコン+文字、各56px）。

## supabase/migrations の契約

- `0001_init.sql`: 冪等DDL（create table if not exists / create index if not exists / drop policy if exists→create）。
  テーブル・列は types.ts と完全一致＋監査列（created_at/updated_at/deleted_at/deleted_by/import_key/raw_flags は db-design.md どおり）。
  RLS: 全表 select/insert/update を authenticated のみ・delete ポリシー無し。anon はポリシー不存在で全拒否。
  updated_at トリガで rev = rev + 1。部分unique（vitals routine・meals slot）。pg_trgm 拡張＋notes.body GIN。
  notes / fluid_intake / outings は `client_key text`（null許容）＋ 全体unique索引（`uq_*_client_key`）。
  deleted_at で絞らない＝削除済みの行もキーを押さえたままにし、再送を「もう届いている」と判定できる。
- `0002_timeline_rpc.sql`: `timeline_chunk(p_from date, p_to date, p_staff_id bigint)` → jsonb
  `{ notes（read_count・my_read 畳み込み・deleted除外）, vitals, meals, fluids, outings, import_days, pinned（期間内に有効な ongoing） }`。
  security invoker・`revoke execute from anon` ＋ `grant execute to authenticated`。
- `0003_sheet_ui.sql`: スプシ模倣UIの追加分（`vitals.symptom` / kind に `'symptom'` / `notes.color` / `notes.after16` /
  `attendance` 表＋RLS＋索引）。**追加のみ・既存の列とデータは触らない**。
- `0004_vitals_client_key.sql`: `vitals.client_key`＋全体unique索引。routine 以外の再送二重登録を DB 側で止める。
- `0005_meals_sheet_fluids.sql`: RPC `meals_sheet_fluids(p_from, p_to)` → 1名1日=1行に畳み、内訳を jsonb で返す。
  食事一覧が水分で行数上限を食い潰さないための集約（security invoker・anon revoke・期間ガード付き）。
- `0012_bath_records.sql`（2026-09-26）: app_settings に input_enabled_bath / med / incident（'false'）・bath_records 表（1人1日1件の部分unique・
  client_key 全体unique・rev／変更の記録トリガ・RLS＋restrictive の member_only（care-backend と同じ形）・delete ポリシーなし）・RPC `daycare_bath_plan(p_date)`（週間計画の写し kv_entries の
  care_schedule_v2 から、その日のデイの入浴予定。0行＝写しなし／source_id が null の1行＝予定なし）・Realtime 登録。
  **初回に1回だけ流す。2回目以降は Realtime の登録（add table）の文でエラーになりファイル全体が巻き戻るので、修正は新しい番号のファイルで流す**
- `0013_med_admin.sql`（2026-09-26）: med_slots 表（1人1件の部分unique・slots は morning/noon/evening/bedtime の配列を check）・
  med_admin 表（1人1日1時間帯1件の部分unique・頓服 prn は除く・slot/status の check・頓服は taken だけで使用時刻・薬・理由が必須の check）・
  client_key 全体unique・rev／変更の記録トリガ（med_admin は admin_on、med_slots は業務日付が無いので updated_at を渡す）・
  RLS＋restrictive の member_only・delete ポリシーなし・Realtime 登録（2表）。0012 と同じく**初回に1回だけ流す**（修正は新しい番号で）
- **適用順は 0001 → 0002 → 0003 → 0004 → 0005**。0003〜0005 は互いに独立だが、
  0003 未適用のまま新UIを配ると「定時以外のバイタル保存」と「食事一覧の読み込み」が失敗する（意図的にフォールバックを作っていない）。
