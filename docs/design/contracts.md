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

リロード復元: HashRouter のURLが第一。ベースURL直開き時のみ `LS.view` の既知値照合で復元。

## src/lib/db.ts が export するAPI（他ビルダーはこれを import する）

```ts
export type Conflict = 'conflict'
export type Queued = 'queued'   // 通信失敗→永続キュー(cl_sendQueue)に退避済み

fetchResidents(): Promise<Resident[]>            // active・room昇順
fetchStaff(): Promise<Staff[]>                   // active・name昇順
fetchTimelineChunk(fromIso: string, toIso: string, staffId: number | null): Promise<TimelineChunk>  // RPC timeline_chunk
fetchKarte(residentId: number, fromIso: string, toIso: string):
  Promise<{ vitals: Vital[]; meals: Meal[]; fluids: FluidIntake[]; notes: Note[]; outings: Outing[] }>
searchNotes(p: { q: string; target: 'body' | 'reporter'; fromIso: string; toIso: string;
  importance?: Importance; shift?: Shift; limit?: number }): Promise<Note[]>

insertVital(v: Omit<Vital, 'id' | 'rev'>): Promise<Vital | Queued>
updateVital(id: number, rev: number, patch: Partial<Omit<Vital, 'id' | 'rev'>>): Promise<Vital | Conflict | Queued>
insertMeal(m: Omit<Meal, 'id' | 'rev'>): Promise<Meal | Queued>
updateMeal(id: number, rev: number, patch: Partial<Omit<Meal, 'id' | 'rev'>>): Promise<Meal | Conflict | Queued>
insertFluid(f: Omit<FluidIntake, 'id' | 'rev'>): Promise<FluidIntake | Queued>
softDeleteFluid(id: number, rev: number): Promise<true | Conflict>
insertNote(n: Omit<Note, 'id' | 'rev' | 'read_count' | 'my_read'>): Promise<Note | Queued>
updateNote(id: number, rev: number, patch: Partial<Omit<Note, 'id' | 'rev'>>): Promise<Note | Conflict | Queued>
softDeleteNote(id: number, rev: number): Promise<true | Conflict>
endOngoingNote(id: number, rev: number): Promise<Note | Conflict>
insertOuting(o: Omit<Outing, 'id' | 'rev'>): Promise<Outing | Queued>
setOutingEnd(id: number, rev: number, endOn: string, endAt: string | null): Promise<Outing | Conflict>  // 部分更新・他項目を送らない

markRead(noteId: number, staffId: number): Promise<void>       // 明示操作からのみ呼ぶ
fetchNoteReaders(noteId: number): Promise<Staff[]>             // note_reads×staff・read_at昇順・limit100・氏名表示のみ
fetchUnreadCount(staffId: number, sinceIso: string): Promise<number>
getNativeInputGate(): Promise<{ value: boolean; observed: boolean }>  // observed=サーバー値を一度でも観測できたか
getNativeInputEnabled(): Promise<boolean>                      // 互換用。gate.value を返す（既定 false）
getAppSetting(key: string): Promise<string | null>

subscribeChanges(cb: (table: string) => void): () => void      // Realtime。受信値は型検査・表示ウィンドウ外は無視
queuePending(): number
queueSubscribe(cb: (n: number) => void): () => void
flushQueue(): Promise<void>                                    // 成功観測後にのみキューから消す（保全ゲート）
onAuthExpired(cb: () => void): void                            // 401検知→キュー保全のまま再ログインへ
```

- insert系: 23505（unique衝突）は他端末先行の証拠 → 既存行を再読込して update に切替（upsert は使わない）
- 自然キーを持たない insert（notes / fluid_intake / outings）は端末生成の冪等キー `client_key` を必ず付ける。
  キューへ退避した op は同じ client_key で再送し、23505 は「既に届いている」証拠として既存行を読み直して成功扱いにする
  （vitals routine・meals は部分unique索引が同じ役目を果たすため付けない）
- 送信キューの flush は Web Locks（`cl_sendQueue_flush` / `ifAvailable`）で1タブに絞る。取れなければ送らない
  （navigator.locks が無い環境は従来どおり送る＝冪等キー側で二重登録を防ぐ）
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
