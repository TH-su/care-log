// ─────────────────────────────────────────────────────────────────────────────
// src/lib/db.ts — care-log の全データアクセス層
//
// 契約（docs/design/contracts.md）:
//   ・supabase.from() / supabase.rpc() を直接呼ぶのはこのファイルと gasClient.ts だけ。
//     他のファイルはここが export する関数だけを使う。
//   ・全読取に .is('deleted_at', null)（列を持つ業務表のみ）と limit を機械付与する。
//     日付レンジ or resident_id の無いクエリを書かない（全件ロード禁止）。
//   ・upsert は使わない。insert が 23505（他端末先行の証拠）なら既存行を読み直して update に切替える。
//     自然キーを持たない表（notes / fluid_intake / outings）は端末生成の冪等キー client_key を必ず付け、
//     23505 なら「既に届いている」証拠として既存行を読み直し、二重登録を作らない。
//   ・物理削除はしない（soft delete = deleted_at のみ）。
//   ・更新は rev 照合（.eq('rev', rev)）。0行 = 競合 → 'conflict' を返し、呼び出し側の入力は消さない。
//   ・通信失敗・認証切れの書込は永続キュー（localStorage cl_sendQueue）へ退避し 'queued' を返す。
//     キューから消すのは「サーバーに載ったことを観測できた時」だけ（multi-device-sync 原則6・8）。
//     業務データを置く localStorage は cl_sendQueue / cl_draftNote の2キーだけ。読めなくなった
//     キューの原文も別キーを作らず cl_sendQueue の中（brokenRaw）へ畳んで保持する。
//   ・console に応答本文・氏名・記録本文を出さない（件数など非個人情報のみ）。
//
// 設計根拠: docs/design/db-design.md §2（RPC timeline_chunk・索引）／§5（書込・同期）、
//           docs/design/ui-design.md §0.5（入力封鎖）／§6.5（キューと下書きの保持規則）、
//           ~/.claude/rules/multi-device-sync.md（原則1・3・4・5・6・8・9・10）。
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  FluidIntake,
  ImportDay,
  Importance,
  Meal,
  MealSlot,
  MealStatus,
  Note,
  Outing,
  OutingKind,
  Resident,
  Shift,
  Staff,
  TimelineChunk,
  Vital,
  VitalKind,
} from './types'
import { LS } from './types'

// ── 契約で定義された戻り値 ───────────────────────────────────────────────────
export type Conflict = 'conflict'
export type Queued = 'queued'

const CONFLICT: Conflict = 'conflict'
const QUEUED: Queued = 'queued'

// ── 定数 ─────────────────────────────────────────────────────────────────────

/** 1リクエストの取得上限（qa-verification §2「1リクエストの行数 ≤2,000」） */
const MAX_ROWS = 2000
/** 個人カルテの折れ線・申し送りの取得上限（db-design §2「.limit(1000) ガード」） */
const KARTE_ROWS = 1000
/** 検索結果の既定件数（ui-design §4「order by note_on desc limit 50」） */
const SEARCH_ROWS = 50
/** 入力解禁フラグの再取得間隔（ms）。「前提情報は毎回取り直す」規範の実装上の粒度 */
const GATE_TTL_MS = 60_000
/** 職員スナップショット（記入者検索用）のキャッシュ寿命（ms） */
const STAFF_TTL_MS = 60_000
/** 再送のバックオフ下限・上限（ms） */
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 30 * 60_000
/** 自動再送を打ち切ってキューに留め置く試行回数（消さずに残す＝保全ゲート） */
const MAX_TRIES = 10
/** 既読者一覧の取得上限（氏名の表示だけに使う。1件の申し送りを100名が既読にする運用は無い） */
const READERS_ROWS = 100
/** 送信主体を1タブに絞るための Web Locks 名（同一端末で2タブ開いた時の二重送信を防ぐ） */
const SEND_LOCK = 'cl_sendQueue_flush'

const VITAL_KINDS: readonly VitalKind[] = ['routine', 'recheck', 'observation']
const MEAL_SLOTS: readonly MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack']
const MEAL_STATUSES: readonly MealStatus[] = ['eaten', 'out', 'hospital', 'refused']
const SHIFTS: readonly Shift[] = ['day', 'daycare', 'night']
const IMPORTANCES: readonly Importance[] = ['normal', 'important', 'critical']
const OUTING_KINDS: readonly OutingKind[] = ['outing', 'overnight']

// select する列は types.ts と一致させる（* を使わず、監査列・import_key を端末へ持ち出さない）
const RESIDENT_COLS = 'id,source_id,name,kana,room,gender,care_level,active,needs_review'
const STAFF_COLS = 'id,name,active'
const VITAL_COLS =
  'id,resident_id,measured_on,kind,measured_at,temp,sys_bp,dia_bp,pulse,spo2,note,recorded_by,rev'
const MEAL_COLS = 'id,resident_id,meal_on,meal_slot,main_amount,side_amount,status,note,recorded_by,rev'
const FLUID_COLS = 'id,resident_id,taken_on,taken_at,amount_ml,kind,recorded_by,rev'
const NOTE_COLS =
  'id,note_on,shift,facility,category,resident_id,role_tags,importance,body,occurred_at,ongoing,ended_at,reporter_id,rev'
const OUTING_COLS = 'id,resident_id,kind,start_on,start_at,end_on,end_at,companion,note,recorded_by,rev'

/** Realtime を購読する表（受信は「どの表が変わったか」だけを伝える） */
const REALTIME_TABLES = ['notes', 'vitals', 'meals', 'fluid_intake', 'outings', 'note_reads'] as const

// ── エラー ───────────────────────────────────────────────────────────────────

export type DbErrorKind =
  | 'unconfigured' // 接続先が未設定
  | 'blocked' // 入力解禁フラグが false（並走期間）
  | 'gate-unknown' // 入力可否を確認できない（通信不可かつ未観測）
  | 'auth' // ログインの有効期限切れ・権限なし
  | 'network' // 通信できない
  | 'server' // サーバー側で拒否された（制約違反など）

/** 画面にそのまま出せる日本語メッセージ（何が起きたか＋次にどうすればよいか）を持つエラー */
export class DbError extends Error {
  readonly kind: DbErrorKind
  constructor(kind: DbErrorKind, message: string) {
    super(message)
    this.name = 'DbError'
    this.kind = kind
  }
}

const MSG = {
  unconfigured:
    '接続先が設定されていません。設定画面で接続先を確認するか、管理者に連絡してください。',
  blocked: '現在はスプレッドシートで記録する期間です（アプリ入力の開始日は施設で決定します）',
  gateUnknown:
    '入力できるかどうかを確認できませんでした（通信エラー）。電波状態を確認して、つながってからもう一度お試しください。入力は消えていません。',
  queuedAuth:
    '保存できていません（ログインの有効期限切れ）。再ログインすると自動で送信されます。入力は消えていません。',
  authRead: '読み込めませんでした（ログインの有効期限切れ）。再ログインしてからもう一度お試しください。',
  authWrite:
    '操作できませんでした（ログインの有効期限切れ）。再ログインしてからもう一度お試しください。記録は変わっていません。',
  networkRead: '読み込めませんでした（通信エラー）。電波状態を確認して、再試行してください。',
  networkWrite:
    '操作できませんでした（通信エラー）。電波状態を確認して、つながってからもう一度お試しください。記録は変わっていません。',
  raceInsert:
    '他の端末が同時に保存したため、保存できませんでした。画面を再読み込みしてから、もう一度お試しください。入力は消えていません。',
  emptyBody: '本文が空です。内容を入力してから送信してください。',
  emptyPatch: '変更する項目がありません。値を入力してから、もう一度お試しください。',
  broken:
    '受け取ったデータを読み取れませんでした。画面を再読み込みしてください。続く場合は管理者に連絡してください。',
} as const

function serverMsg(action: '読み込め' | '保存でき' | '操作でき', code: string): string {
  const tail = code === '' ? '' : `（コード: ${code}）`
  return `${action}ませんでした（サーバーエラー）${tail}。しばらく待ってから再試行してください。続く場合は管理者に連絡してください。`
}

// PostgREST の応答から取り出す最小形（supabase-js の戻り値はこの3つを必ず持つ）
interface Res<T> {
  data: T | null
  error: { message: string; code?: string; details?: string; hint?: string } | null
  status: number
}

function errCode(res: Res<unknown>): string {
  return typeof res.error?.code === 'string' ? res.error.code : ''
}

/** ログインの有効期限切れ・未ログイン（401 / PGRST30x） */
function isAuthFail(res: Res<unknown>): boolean {
  const code = errCode(res)
  return res.status === 401 || code === 'PGRST301' || code === 'PGRST302' || code === 'PGRST303'
}

/** 通信不能・一時的なサーバー側事情（status 0 = fetch 自体の失敗） */
function isTransient(res: Res<unknown>): boolean {
  return res.status === 0 || res.status === 429 || (res.status >= 500 && res.status <= 599)
}

/** 一意制約違反（他端末が先に同じ行を作った証拠） */
function isUniqueViolation(res: Res<unknown>): boolean {
  return errCode(res) === '23505' || res.status === 409
}

/** 読取の失敗をユーザー向けエラーへ変換する（401 は再ログイン導線も起動する） */
function readError(res: Res<unknown>): DbError {
  if (isAuthFail(res)) {
    fireAuthExpired()
    return new DbError('auth', MSG.authRead)
  }
  if (isTransient(res)) return new DbError('network', MSG.networkRead)
  return new DbError('server', serverMsg('読み込め', errCode(res)))
}

/** キューに載せない書込（削除・部分更新）の失敗をユーザー向けエラーへ変換する */
function writeError(res: Res<unknown>): DbError {
  if (isAuthFail(res)) {
    fireAuthExpired()
    return new DbError('auth', MSG.authWrite)
  }
  if (isTransient(res)) return new DbError('network', MSG.networkWrite)
  return new DbError('server', serverMsg('操作でき', errCode(res)))
}

// ── Supabase クライアント（遅延生成） ────────────────────────────────────────
// supabase.ts は env 未設定だと createClient() の時点で例外を投げる（実測: supabase-js
// v2 は supabaseUrl 空で throw）。このファイルが静的 import すると読み込むだけで白画面に
// なるため、動的 import で「使う時に初めて評価する」形にしている。

let clientPromise: Promise<SupabaseClient> | null = null

/** 接続先（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）が設定されているか */
export function isSupabaseConfigured(): boolean {
  // 型は src/vite-env.d.ts（vite/client）で付くが、未設定・非 Vite 実行でも落ちないよう
  // キャスト経由で optional に読む。ビルド時に Vite が実体へ置換することは実測済み。
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const url = env?.VITE_SUPABASE_URL ?? ''
  const key = env?.VITE_SUPABASE_ANON_KEY ?? ''
  return url !== '' && key !== ''
}

async function getClient(): Promise<SupabaseClient> {
  if (!isSupabaseConfigured()) throw new DbError('unconfigured', MSG.unconfigured)
  if (!clientPromise) {
    clientPromise = import('./supabase')
      .then((m) => {
        const sb: SupabaseClient = m.supabase
        attachAuthWatch(sb)
        return sb
      })
      .catch(() => {
        clientPromise = null // 一時的な読み込み失敗なら次回やり直せるようにする
        throw new DbError('unconfigured', MSG.unconfigured)
      })
  }
  return clientPromise
}

// ── 認証失効（401）の通知 ────────────────────────────────────────────────────

const authExpiredCbs = new Set<() => void>()
let authWatchAttached = false

/** 401 を検知したら呼ばれる。キューは保全したまま再ログイン導線へ渡す（M-038 対策） */
export function onAuthExpired(cb: () => void): void {
  authExpiredCbs.add(cb)
}

function fireAuthExpired(): void {
  for (const cb of authExpiredCbs) {
    try {
      cb()
    } catch {
      // 購読側の例外でデータアクセス層を巻き込まない
    }
  }
}

function attachAuthWatch(sb: SupabaseClient): void {
  if (authWatchAttached) return
  authWatchAttached = true
  // 再ログイン・トークン更新に成功したら、退避してある書込を自動で送り直す。
  // 直前の 401 で待ち時間が伸びていても送る（force）＝「再ログインすると自動で送信されます」を守る
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') void flushQueue(true)
  })
}

// ── 受信データの正規化（multi-device-sync 原則10: 受信データを信じない） ──────

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function idNum(v: unknown): number | null {
  const n = num(v)
  return n !== null && Number.isInteger(n) && n > 0 ? n : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

/** date 列（'YYYY-MM-DD'）。timestamptz が返ってきても日付部分だけ採る */
function dateStr(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 配列を正規化しつつ、壊れた行は落とす。上限を超えた分は切り捨てる（全件ロード防止） */
function list<T>(v: unknown, normalize: (row: unknown) => T | null, cap = MAX_ROWS): T[] {
  if (!Array.isArray(v)) return []
  const out: T[] = []
  for (const row of v) {
    if (out.length >= cap) break
    const t = normalize(row)
    if (t !== null) out.push(t)
  }
  return out
}

function normalizeResident(row: unknown): Resident | null {
  const r = asRecord(row)
  if (!r) return null
  const id = idNum(r.id)
  const name = str(r.name)
  if (id === null || name === null) return null
  return {
    id,
    source_id: str(r.source_id) ?? '',
    name,
    kana: str(r.kana),
    room: str(r.room),
    gender: str(r.gender),
    care_level: str(r.care_level),
    active: bool(r.active, true),
    needs_review: bool(r.needs_review, false),
  }
}

function normalizeStaff(row: unknown): Staff | null {
  const r = asRecord(row)
  if (!r) return null
  const id = idNum(r.id)
  const name = str(r.name)
  if (id === null || name === null) return null
  return { id, name, active: bool(r.active, true) }
}

function normalizeVital(row: unknown): Vital | null {
  const r = asRecord(row)
  if (!r) return null
  const id = idNum(r.id)
  const resident_id = idNum(r.resident_id)
  const measured_on = dateStr(r.measured_on)
  const kind = oneOf(r.kind, VITAL_KINDS)
  if (id === null || resident_id === null || measured_on === null || kind === null) return null
  return {
    id,
    resident_id,
    measured_on,
    kind,
    measured_at: str(r.measured_at),
    temp: num(r.temp),
    sys_bp: num(r.sys_bp),
    dia_bp: num(r.dia_bp),
    pulse: num(r.pulse),
    spo2: num(r.spo2),
    note: str(r.note),
    recorded_by: idNum(r.recorded_by),
    rev: num(r.rev) ?? 1,
  }
}

function normalizeMeal(row: unknown): Meal | null {
  const r = asRecord(row)
  if (!r) return null
  const id = idNum(r.id)
  const resident_id = idNum(r.resident_id)
  const meal_on = dateStr(r.meal_on)
  const meal_slot = oneOf(r.meal_slot, MEAL_SLOTS)
  if (id === null || resident_id === null || meal_on === null || meal_slot === null) return null
  return {
    id,
    resident_id,
    meal_on,
    meal_slot,
    main_amount: num(r.main_amount),
    side_amount: num(r.side_amount),
    status: oneOf(r.status, MEAL_STATUSES),
    note: str(r.note),
    recorded_by: idNum(r.recorded_by),
    rev: num(r.rev) ?? 1,
  }
}

function normalizeFluid(row: unknown): FluidIntake | null {
  const r = asRecord(row)
  if (!r) return null
  const id = idNum(r.id)
  const resident_id = idNum(r.resident_id)
  const taken_on = dateStr(r.taken_on)
  const amount_ml = num(r.amount_ml)
  if (id === null || resident_id === null || taken_on === null || amount_ml === null) return null
  return {
    id,
    resident_id,
    taken_on,
    taken_at: str(r.taken_at),
    amount_ml,
    kind: str(r.kind),
    recorded_by: idNum(r.recorded_by),
    rev: num(r.rev) ?? 1,
  }
}

function normalizeNote(row: unknown): Note | null {
  const r = asRecord(row)
  if (!r) return null
  const id = idNum(r.id)
  const note_on = dateStr(r.note_on)
  const shift = oneOf(r.shift, SHIFTS)
  const body = str(r.body)
  if (id === null || note_on === null || shift === null || body === null) return null
  const readCount = num(r.read_count)
  const note: Note = {
    id,
    note_on,
    shift,
    facility: str(r.facility),
    category: str(r.category),
    resident_id: idNum(r.resident_id),
    role_tags: strArray(r.role_tags),
    importance: oneOf(r.importance, IMPORTANCES) ?? 'normal',
    body,
    occurred_at: str(r.occurred_at),
    ongoing: bool(r.ongoing, false),
    ended_at: str(r.ended_at),
    reporter_id: idNum(r.reporter_id),
    rev: num(r.rev) ?? 1,
  }
  if (readCount !== null) note.read_count = readCount
  if (typeof r.my_read === 'boolean') note.my_read = r.my_read
  return note
}

function normalizeOuting(row: unknown): Outing | null {
  const r = asRecord(row)
  if (!r) return null
  const id = idNum(r.id)
  const resident_id = idNum(r.resident_id)
  const start_on = dateStr(r.start_on)
  const kind = oneOf(r.kind, OUTING_KINDS)
  if (id === null || resident_id === null || start_on === null || kind === null) return null
  return {
    id,
    resident_id,
    kind,
    start_on,
    start_at: str(r.start_at),
    end_on: dateStr(r.end_on),
    end_at: str(r.end_at),
    companion: str(r.companion),
    note: str(r.note),
    recorded_by: idNum(r.recorded_by),
    rev: num(r.rev) ?? 1,
  }
}

function normalizeImportDay(row: unknown): ImportDay | null {
  const r = asRecord(row)
  if (!r) return null
  const day = dateStr(r.day)
  if (day === null) return null
  return {
    source: str(r.source) ?? '',
    day,
    imported_at: str(r.imported_at) ?? '',
    src_rows: num(r.src_rows) ?? 0,
    inserted: num(r.inserted) ?? 0,
    updated: num(r.updated) ?? 0,
    skipped: num(r.skipped) ?? 0,
    native_skip: num(r.native_skip) ?? 0,
    unmatched: num(r.unmatched) ?? 0,
  }
}

// ── 送信キュー（localStorage: cl_sendQueue） ─────────────────────────────────
// 保持するのは resident_id・日付・数値・本文だけ（氏名は入れない）。
// ui-design §6.5「保持必須・成功で即削除」＋ multi-device-sync 原則8「消去は保全ゲートの後ろ」。

type QueueTable = 'vitals' | 'meals' | 'fluid_intake' | 'notes' | 'outings'

interface QueueOp {
  qid: string
  table: QueueTable
  kind: 'insert' | 'update'
  payload: Record<string, unknown>
  rowId?: number
  rev?: number
  at: number
  tries: number
  nextAt: number
  /** 自動再送を止めた印。消さずにキューへ残し「未送信」として数え続ける */
  blocked?: 'conflict' | 'rejected'
  /**
   * 送信中（この op の応答待ち）。統合先にしない印。
   * 送信リクエストを出した後のペイロード差し替えは、応答が 'sent' になった時点で
   * 「送っていない入力」ごとキューから消えてしまう（観測なしの消滅）。localStorage には残さない。
   */
  sending?: boolean
}

const QUEUE_TABLES: readonly QueueTable[] = ['vitals', 'meals', 'fluid_intake', 'notes', 'outings']

/** localStorage に入れるキューの形（旧版の「op の配列」も読めるようにしてある） */
interface QueueFile {
  ops: QueueOp[]
  /** 解釈できなくなった前回の原文。消さずに持ち続ける（保全ゲート） */
  brokenRaw?: string
}

/** 旧版が使っていた退避キー。値は cl_sendQueue の中へ移し、移せたことを観測してから取り除く */
const LEGACY_BROKEN_KEY = `${LS.sendQueue}_broken`

let queue: QueueOp[] = []
let queueBroken = false
/** 読めなかった原文。cl_sendQueue の brokenRaw として持ち続ける（消さずに残すため） */
let queueBrokenRaw: string | null = null
/** 旧キーからの移行待ち。現行キーへ書けたことを観測してからだけ旧キーを消す */
let legacyBrokenPending = false
/** 直近の永続化に成功しているか（false = メモリ上だけ＝タブを閉じると失われる） */
let queuePersisted = true
/** この起動中に「サーバーへ載った」ことを観測できた op の qid（他タブの控えから復活させない印） */
const sentQids = new Set<string>()
const queueCbs = new Set<(n: number) => void>()
let flushing = false

function normalizeQueueOp(row: unknown): QueueOp | null {
  const r = asRecord(row)
  if (!r) return null
  const table = oneOf(r.table, QUEUE_TABLES)
  const kind = r.kind === 'insert' || r.kind === 'update' ? r.kind : null
  const payload = asRecord(r.payload)
  if (table === null || kind === null || payload === null) return null
  const op: QueueOp = {
    qid: str(r.qid) ?? `q${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    table,
    kind,
    payload,
    at: num(r.at) ?? Date.now(),
    tries: num(r.tries) ?? 0,
    nextAt: num(r.nextAt) ?? 0,
  }
  const rowId = idNum(r.rowId)
  if (rowId !== null) op.rowId = rowId
  const rev = num(r.rev)
  if (rev !== null) op.rev = rev
  if (r.blocked === 'conflict' || r.blocked === 'rejected') op.blocked = r.blocked
  if (kind === 'update' && (op.rowId === undefined || op.rev === undefined)) return null
  return op
}

/** 端末側で作る一意キー。送信キューの qid と、insert の冪等キー client_key に同じ値を使う */
function newQid(): string {
  return `q${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 捨てずに控えるための原文。文字列化できない値は空文字（＝控えない）を返す */
function rawOf(row: unknown): string {
  try {
    const s = JSON.stringify(row)
    return typeof s === 'string' ? s : ''
  } catch {
    return '' // 循環参照など。JSON 由来の値では起きないが、控えの作成で例外を外へ出さない
  }
}

/**
 * 解釈できなかった原文を brokenRaw へ畳む（消さずに持ち続ける＝保全ゲート）。
 * 同じ原文は重ねない（書き戻しのたびに増え続けないようにする）。
 */
function keepBroken(chunks: string[]): void {
  for (const c of chunks) {
    if (c === '') continue
    if (queueBrokenRaw === null) queueBrokenRaw = c
    else if (!queueBrokenRaw.includes(c)) queueBrokenRaw = `${queueBrokenRaw}\n${c}`
    queueBroken = true
  }
}

/**
 * 退避 op の配列を正規化する。解釈できなかった行・上限超過で入りきらなかった行は
 * 捨てずに原文（dropped）で返し、呼び出し側が brokenRaw へ畳む。
 * 黙って落とすと「端末に保存しました」と案内した入力が観測なしに消える（原則5・8）。
 * requireQid=true は他タブの控えを読む時に使う（qid が無いと同一性を判定できず、
 * 書き戻すたびに別の op として増えてしまうため取り込まない）。
 */
function parseQueueOps(rawOps: unknown, requireQid: boolean): { ops: QueueOp[]; dropped: string[] } {
  const ops: QueueOp[] = []
  const dropped: string[] = []
  if (!Array.isArray(rawOps)) return { ops, dropped }
  for (const row of rawOps) {
    if (ops.length >= MAX_ROWS) {
      dropped.push(rawOf(row))
      continue
    }
    if (requireQid && typeof asRecord(row)?.qid !== 'string') {
      dropped.push(rawOf(row))
      continue
    }
    const op = normalizeQueueOp(row)
    if (op === null) dropped.push(rawOf(row))
    else ops.push(op)
  }
  return { ops, dropped }
}

function loadQueue(): void {
  if (typeof localStorage === 'undefined') return
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LS.sendQueue)
  } catch {
    return // 読めない環境ではキュー無しで動く（既存の値は触らない）
  }
  if (raw !== null && raw !== '') {
    try {
      const parsed: unknown = JSON.parse(raw)
      // 現行形式 { ops, brokenRaw } と旧形式（op の配列）の両方を受ける
      const box = asRecord(parsed)
      const parsedOps = parseQueueOps(box === null ? parsed : box.ops, false)
      queue = parsedOps.ops
      // 正規化できなかった行も消さない（設定画面の「読み取れませんでした」に乗せて残す）
      keepBroken(parsedOps.dropped)
      const kept = box === null ? null : str(box.brokenRaw)
      // 前に解釈できなかった原文。消さずに持ち続け「未送信データあり」を出し続ける
      if (kept !== null) keepBroken([kept])
    } catch {
      // 壊れた値は解釈できないが、消さない。原文を控え、次の書き込みで同じキーの
      // brokenRaw として一緒に書き戻す（multi-device-sync 原則8: 消去は保全ゲートの後ろ）
      keepBroken([raw])
      queue = []
      console.warn('未送信データの読み込みに失敗しました（内容は表示しません）')
    }
  }
  // 旧版が別キーへ退避していた原文を引き継ぐ（現行キーへ書けてから旧キーを消す）
  try {
    const legacy = localStorage.getItem(LEGACY_BROKEN_KEY)
    if (legacy !== null && legacy !== '') {
      queueBroken = true
      queueBrokenRaw = queueBrokenRaw === null ? legacy : `${queueBrokenRaw}\n${legacy}`
      legacyBrokenPending = true
    }
  } catch {
    // 参照できない環境では引き継がない（旧キーの値はそのまま残る＝消さない）
  }
}

/**
 * 書き戻す op の一覧。localStorage を読み直し、他タブが退避した op を qid で和集合にしてから返す。
 * 全置換で書くと、同じ端末で2つ目のタブを開いた時に相手の未送信 op を消してしまう
 * （「端末に保存しました」と案内した記録が観測なしに消える＝multi-device-sync 原則5・8に反する）。
 * 取り込んだ他タブの op はこのタブのメモリ（queue）には入れない。入れると同じ op を2タブが
 * 同時に送って二重登録になるため、保持だけして送信は元のタブ（または次回起動）に任せる。
 */
function mergeForPersist(): QueueOp[] {
  if (typeof localStorage === 'undefined') return queue
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LS.sendQueue)
  } catch {
    return queue
  }
  if (raw === null || raw === '') return queue
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 解釈できない値（別版・別タブが書いた原文）も消さずに持ち続ける（保全ゲート）
    keepBroken([raw])
    return queue
  }
  const box = asRecord(parsed)
  // qid を持たない値・正規化できない行は同一性を判定できない。取り込むと書き戻すたびに
  // 別の op として増え二重登録になるため、op としては取り込まず原文を brokenRaw へ畳んで残す
  const parsedOps = parseQueueOps(box === null ? parsed : box.ops, true)
  keepBroken(parsedOps.dropped)
  const stored = parsedOps.ops
  const mine = new Set(queue.map((o) => o.qid))
  // 送信できたことを観測した op は復活させない（他タブの古い控えからの二重送信を防ぐ）
  const others = stored.filter((o) => !mine.has(o.qid) && !sentQids.has(o.qid))
  return others.length === 0 ? queue : queue.concat(others)
}

function persistQueue(): void {
  if (typeof localStorage !== 'undefined') {
    try {
      // 解釈できなかった原文も同じキーの中に持つ（業務データを置く localStorage は
      // cl_sendQueue / cl_draftNote の2キーだけという契約を守るため）。
      // 1回の setItem なので「キューは書けたが原文が消えた」という中途半端な状態を作らない
      const box: QueueFile = { ops: mergeForPersist() }
      if (queueBrokenRaw !== null) box.brokenRaw = queueBrokenRaw
      localStorage.setItem(LS.sendQueue, JSON.stringify(box))
      queuePersisted = true
      if (legacyBrokenPending) {
        // 現行キーへ書けたことを観測できたので、旧キーを取り除く（消去は保全ゲートの後ろ）
        localStorage.removeItem(LEGACY_BROKEN_KEY)
        legacyBrokenPending = false
      }
    } catch {
      // 保存できなくてもメモリ上のキューは維持する（この起動中は再送できる）
      queuePersisted = false
    }
  } else {
    queuePersisted = false
  }
  notifyQueue()
}

function notifyQueue(): void {
  const n = queuePending()
  for (const cb of queueCbs) {
    try {
      cb(n)
    } catch {
      // 購読側の例外でデータアクセス層を巻き込まない
    }
  }
}

/**
 * localStorage に控えてある未送信 op の qid。
 * このタブのメモリキューに無い（＝同じ端末の別タブが退避した）分も数えるために読み直す。
 * 送信できたと観測済みの qid は除く。解釈できない行はここでは数えない（isQueueBroken 側で示す）。
 */
function storedPendingQids(): Set<string> {
  const out = new Set<string>()
  if (typeof localStorage === 'undefined') return out
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LS.sendQueue)
  } catch {
    return out
  }
  if (raw === null || raw === '') return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  const box = asRecord(parsed)
  const rawOps = box === null ? parsed : box.ops
  if (!Array.isArray(rawOps)) return out
  for (const row of rawOps) {
    const qid = str(asRecord(row)?.qid)
    if (qid === null || qid === '' || sentQids.has(qid)) continue
    if (normalizeQueueOp(row) === null) continue
    out.add(qid)
  }
  return out
}

/**
 * 未送信件数（自動再送を止めた分も「未送信」として数える）。
 * 同じ端末の別タブが退避した分も数える（メモリキューと localStorage の和集合）。
 * 数えないと、2つ目のタブでは「未送信 0件」と表示されたまま送られていない記録が残る。
 */
export function queuePending(): number {
  const qids = storedPendingQids()
  for (const op of queue) qids.add(op.qid)
  return qids.size
}

/** 未送信件数の変化を購読する。登録直後に現在値を1回通知する */
export function queueSubscribe(cb: (n: number) => void): () => void {
  queueCbs.add(cb)
  try {
    cb(queuePending())
  } catch {
    // 初回通知の例外は無視する
  }
  return () => {
    queueCbs.delete(cb)
  }
}

type PendingOp = Omit<QueueOp, 'qid' | 'at' | 'tries' | 'nextAt'>

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => a[k] === b[k])
}

/**
 * 同じ行を指す退避済みの op（統合先）。無ければ null。
 * 分けて積むと、先の op が成功して rev が進んだ瞬間に後の op が必ず競合して送れなくなるため、
 * 1行につき1件へまとめる（multi-device-sync 原則3: 部分更新／原則5: 無言消失を作らない）。
 * 自動再送を止めた op（blocked）は裁定待ちなので統合先にしない。
 * 送信中の op（sending）も統合先にしない。リクエストは差し替え前のペイロードで既に出ており、
 * 応答が 'sent' になると op ごと消えるため、重ねた入力が観測されないまま消える（原則6・8）。
 */
function findMergeTarget(op: PendingOp): QueueOp | null {
  for (const q of queue) {
    if (q.blocked !== undefined || q.sending === true) continue
    if (q.table !== op.table || q.kind !== op.kind) continue
    if (op.kind === 'update') {
      if (q.rowId !== undefined && q.rowId === op.rowId) return q
      continue
    }
    // insert は自然キー（部分unique索引）が一致する時だけ同じ行を指す。
    // キーを持たない表（水分・申し送り・外出）は1タップ＝1行なので統合しない
    const a = conflictKeyOf(op.table, op.payload)
    const b = conflictKeyOf(q.table, q.payload)
    if (a !== null && b !== null && sameKey(a, b)) return q
  }
  return null
}

/**
 * 退避済みペイロードへ新しい入力を重ねる（後勝ち）。
 * ただし insert 由来の null は「未入力（DB既定）」であって「空にせよ」の指示ではないので、
 * 先に退避してある値を消さない。明示的な消去は update 経路（確認ダイアログ付き）が担う。
 */
function mergePayload(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
  kind: QueueOp['kind'],
): Record<string, unknown> {
  const out = { ...base }
  for (const [k, v] of Object.entries(next)) {
    if (kind === 'insert' && v === null) continue
    out[k] = v
  }
  return out
}

function enqueue(op: PendingOp): Queued {
  const target = findMergeTarget(op)
  if (target !== null) {
    // rev は「最初に観測した値」を保つ（統合先の op はまだ1度もサーバーへ載っていない）
    target.payload = mergePayload(target.payload, op.payload, op.kind)
    target.tries = 0
    target.nextAt = 0 // 新しい入力が乗ったので待ち時間を置かずに次の再送で送る
  } else {
    // insert は端末生成の冪等キー（client_key）をそのまま qid にする。
    // 再送のたびに同じ client_key で送るので、二重送信になっても DB 側で1行に収束する
    const ck = str(op.payload.client_key)
    queue.push({
      ...op,
      qid: ck !== null && ck !== '' ? ck : newQid(),
      at: Date.now(),
      tries: 0,
      nextAt: 0,
    })
  }
  persistQueue()
  return QUEUED
}

function backoff(tries: number): number {
  return Math.min(RETRY_BASE_MS * Math.pow(2, Math.max(0, tries - 1)), RETRY_MAX_MS)
}

/**
 * 退避してある書込を送り直す。サーバーに載ったことを観測できた分だけキューから消す。
 * 競合（rev 不一致）・サーバー拒否が続く分は消さずに残し、未送信件数として表示し続ける。
 *
 * force=true は「再ログイン直後」「設定画面で職員が明示的に再送を指示した」場合に使う。
 * 直前の失敗で待ち時間（最大30分）が残っていても無視して送る。
 * これを尊重すると「再ログインすると自動で送信されます」「今すぐ再送する」の案内が
 * 実挙動と食い違い、職員が指示しても1件も送られない状態になるため。
 */
export async function flushQueue(force = false): Promise<void> {
  if (flushing) return
  if (queue.length === 0) return
  if (!isSupabaseConfigured()) return
  flushing = true
  try {
    await withSendLock(() => sendDueOps(force))
  } catch {
    // 接続先未設定・クライアント初期化失敗・ロックを取れなかった。キューはそのまま保持する
  } finally {
    flushing = false
    persistQueue()
  }
}

/**
 * 送信の主体を1タブに絞る（Web Locks）。同じ端末で2つのタブを開いていると、起動時に
 * 双方が同じ未送信 op を取り込み、同時に送って二重登録になるため。
 * ロックを取れないタブはこの回は送らない（相手のタブが送る／次の機会に送る）。
 * navigator.locks が無い環境（古い WebView 等）は従来どおりそのまま送る。
 */
async function withSendLock(run: () => Promise<void>): Promise<void> {
  const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { locks?: LockManager })
  const locks = nav?.locks
  if (!locks || typeof locks.request !== 'function') {
    await run()
    return
  }
  await locks.request(SEND_LOCK, { ifAvailable: true }, async (lock) => {
    if (lock === null) return // 別のタブが送信中。ここでは送らない（未送信のまま残す＝消さない）
    await run()
  })
}

/** 期限の来た op を順に送る（flushQueue の送信ループ本体。ロックの内側でだけ動かす） */
async function sendDueOps(force: boolean): Promise<void> {
  const sb = await getClient()
  const now = Date.now()
  const due = queue.filter((op) => op.blocked === undefined && (force || op.nextAt <= now))
  for (const op of due) {
    // 送信中は統合先にしない印を立てる（応答待ちの間にペイロードを差し替えられると、
    // 'sent' の判定で「まだ送っていない入力」ごと消えるため）
    op.sending = true
    let result: SendResult
    try {
      result = await sendQueuedOp(sb, op)
    } finally {
      delete op.sending
    }
    if (result === 'sent') {
      sentQids.add(op.qid) // 他タブの古い控えから書き戻されても復活させない
      queue = queue.filter((o) => o.qid !== op.qid) // 観測できた時だけ消す（保全ゲート）
      continue
    }
    op.tries += 1
    if (result === 'conflict') {
      op.blocked = 'conflict'
    } else if (result === 'rejected') {
      if (op.tries >= MAX_TRIES) op.blocked = 'rejected'
      else op.nextAt = Date.now() + backoff(op.tries)
    } else {
      // 通信不能・認証切れ: 回数では諦めず、間隔だけ広げて待つ
      op.nextAt = Date.now() + backoff(op.tries)
      break // つながっていないので、この回はここで打ち切る
    }
  }
}

type SendResult = 'sent' | 'retry' | 'conflict' | 'rejected'

async function sendQueuedOp(sb: SupabaseClient, op: QueueOp): Promise<SendResult> {
  const cols = colsOf(op.table)
  if (op.kind === 'insert') {
    const res = (await sb.from(op.table).insert(op.payload).select(cols).maybeSingle()) as Res<unknown>
    if (res.error === null) return 'sent'
    if (isAuthFail(res)) {
      fireAuthExpired()
      return 'retry'
    }
    if (isTransient(res)) return 'retry'
    if (isUniqueViolation(res)) {
      const ck = clientKeyOf(op.payload)
      if (ck !== null) {
        // 端末が付けた冪等キーの衝突＝この op は既にサーバーへ届いている（二重送信）。
        // 届いていることを読んで確かめられた時だけキューから外す（削除済みでも「届いた」証拠）。
        // 読めなければ消さずに再試行へ回す（観測できない消去はしない＝原則8）
        const landed = await findByKey(sb, op.table, ck, 'id,rev', true)
        return landed === null ? 'retry' : 'sent'
      }
      // 他端末（または同じ端末の後続入力）が先に同じ行を作っていた。再読込して update へ切り替える。
      // ただし退避した値は「退避した時点のスナップショット」なので、既に値が入っている列は
      // 上書きしない（＝空いている列だけ埋める和集合）。食い違う列が残る場合は送らずに
      // 'conflict' として未送信のまま残し、人の裁定に回す（multi-device-sync 原則5・6）。
      const key = conflictKeyOf(op.table, op.payload)
      if (key === null) return 'rejected'
      const existing = await findByKey(sb, op.table, key, cols)
      if (existing === null) return 'rejected'
      const patch = fillGapsOnly(op.payload, key, existing.row)
      if (patch === null) return 'conflict' // 別の値が既に載っている＝巻き戻さない
      if (Object.keys(patch).length === 0) return 'sent' // 書く差分が無い＝既に載っている
      const up = (await sb
        .from(op.table)
        .update(patch)
        .eq('id', existing.id)
        .eq('rev', existing.rev)
        .is('deleted_at', null)
        .select(cols)
        .maybeSingle()) as Res<unknown>
      if (up.error !== null) return isTransient(up) || isAuthFail(up) ? 'retry' : 'rejected'
      return up.data === null ? 'conflict' : 'sent'
    }
    return 'rejected'
  }

  const res = (await sb
    .from(op.table)
    .update(op.payload)
    .eq('id', op.rowId as number)
    .eq('rev', op.rev as number)
    .is('deleted_at', null)
    .select(cols)
    .maybeSingle()) as Res<unknown>
  if (res.error !== null) {
    if (isAuthFail(res)) {
      fireAuthExpired()
      return 'retry'
    }
    return isTransient(res) ? 'retry' : 'rejected'
  }
  return res.data === null ? 'conflict' : 'sent'
}

function colsOf(table: QueueTable): string {
  switch (table) {
    case 'vitals':
      return VITAL_COLS
    case 'meals':
      return MEAL_COLS
    case 'fluid_intake':
      return FLUID_COLS
    case 'notes':
      return NOTE_COLS
    case 'outings':
      return OUTING_COLS
  }
}

/**
 * 部分unique索引に対応する自然キー。23505 の時にこのキーで既存行を読み直す。
 * 該当が無い表（水分・申し送り・外出）は null＝再読込先を特定できないため update へ切り替えない。
 */
function conflictKeyOf(table: QueueTable, payload: Record<string, unknown>): Record<string, unknown> | null {
  if (table === 'vitals' && payload.kind === 'routine') {
    const resident = idNum(payload.resident_id)
    const on = dateStr(payload.measured_on)
    if (resident === null || on === null) return null
    return { resident_id: resident, measured_on: on, kind: 'routine' }
  }
  if (table === 'meals') {
    const resident = idNum(payload.resident_id)
    const on = dateStr(payload.meal_on)
    const slot = oneOf(payload.meal_slot, MEAL_SLOTS)
    if (resident === null || on === null || slot === null) return null
    return { resident_id: resident, meal_on: on, meal_slot: slot }
  }
  return null
}

/**
 * 端末生成の冪等キー（client_key）。自然キーを持たない表（申し送り・水分・外出）で
 * 「23505 = この端末が送った行が既に載っている」ことを確かめるために使う。
 */
function clientKeyOf(payload: Record<string, unknown>): Record<string, unknown> | null {
  const k = str(payload.client_key)
  return k === null || k === '' ? null : { client_key: k }
}

/**
 * 自然キーで既存行を1件だけ読み直す（23505 の切替先を特定するため）。
 * includeDeleted=true は「その行が届いているか」だけを見る用途（client_key の衝突確認）。
 * 削除済みでも「届いた」ことに変わりはないので、退避 op を消してよい判断材料になる。
 */
async function findByKey(
  sb: SupabaseClient,
  table: QueueTable,
  key: Record<string, unknown>,
  cols = 'id,rev',
  includeDeleted = false,
): Promise<{ id: number; rev: number; row: unknown } | null> {
  let q = sb.from(table).select(cols).limit(1)
  if (!includeDeleted) q = q.is('deleted_at', null)
  for (const [k, v] of Object.entries(key)) q = q.eq(k, v as never)
  const res = (await q.maybeSingle()) as Res<unknown>
  if (res.error !== null || res.data === null) return null
  const r = asRecord(res.data)
  const id = idNum(r?.id)
  const rev = num(r?.rev)
  return id !== null && rev !== null ? { id, rev, row: res.data } : null
}

function omitKeys(src: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) if (!keys.includes(k)) out[k] = v
  return out
}

/**
 * insert → update へ切り替える時の patch から null の項目を落とす。
 * insert のペイロードの null は「未入力（DB既定）」であって「空にせよ」の指示ではない。
 * そのまま update へ流すと、他端末が先に書いた列（体温だけ・血圧だけ等）を無言で消してしまう
 * （multi-device-sync 原則3=部分更新／原則4=null と空の区別／原則5=無言消失の禁止）。
 * 明示的な消去は updateVital / updateMeal（確認ダイアログ付きの経路）が担う。
 */
function dropNulls(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) if (v !== null) out[k] = v
  return out
}

/** サーバーの値と退避した値が実質同じか（数値は数値として、それ以外は文字列として比べる） */
function sameCell(a: unknown, b: unknown): boolean {
  const na = num(a)
  const nb = num(b)
  if (na !== null && nb !== null) return na === nb
  return String(a) === String(b)
}

/**
 * 退避してあった insert を、既にサーバーにある行へ載せ直すための patch を作る。
 * 返すのは「サーバー側が空いている列だけを埋める」和集合の patch。
 * 既に値が入っていて内容も食い違う列が1つでもあれば null（＝上書きしない・conflict にする）。
 *
 * 退避中に他端末（または同じ端末の後続入力）が書いた新しい値を、古いスナップショットで
 * 無言に巻き戻さないための判定（multi-device-sync 原則5: 無言消失の禁止／既定は和集合）。
 * 記入者（recorded_by）は行を先に作った端末の値を正とし、食い違っても競合として扱わない。
 */
function fillGapsOnly(
  payload: Record<string, unknown>,
  key: Record<string, unknown>,
  existingRow: unknown,
): Record<string, unknown> | null {
  const current = asRecord(existingRow) ?? {}
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(omitKeys(payload, Object.keys(key)))) {
    if (v === null || v === undefined) continue // 未入力は「空にせよ」の指示ではない（dropNulls 参照）
    const cur = current[k]
    if (cur === null || cur === undefined) {
      patch[k] = v // サーバー側が空いている＝埋めてよい
      continue
    }
    if (k === 'recorded_by') continue // 先に保存した端末の記入者を残す
    if (!sameCell(cur, v)) return null
  }
  return patch
}

/** undefined の項目は送らない（部分更新＝送らない列はサーバーの値を温存する。null は「空にせよ」の明示） */
function cleanPayload(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) if (v !== undefined) out[k] = v
  return out
}

/**
 * 自然キー（部分unique索引）を持たない表の insert に、端末生成の冪等キーを付ける。
 * 同じ入力を再送しても DB 側の unique 制約で1行に収束する（2タブ・再送の行き違いでの二重登録防止）。
 * 定時バイタル・食事は部分unique索引が同じ役目を果たすので付けない。
 */
function withClientKey(src: Record<string, unknown>): Record<string, unknown> {
  const out = cleanPayload(src)
  out.client_key = newQid()
  return out
}

// 電波復帰・画面復帰で自動再送する（ui-design §6.5「電波復帰で自動再送」）
if (typeof window !== 'undefined') {
  loadQueue()
  // 旧キーに退避が残っていた場合だけ、現行キーへ移し替える（書けた後に旧キーを消す）
  if (legacyBrokenPending) persistQueue()
  window.addEventListener('online', () => {
    void flushQueue()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushQueue()
  })
}

// ── 入力解禁フラグ（並走期間の封鎖・ui-design §0.5 の二重ガード） ────────────

let gateValue: boolean | null = null // 未観測 = null
let gateFetchedAt = 0

const TRUE_WORDS = new Set(['true', '1', 'on', 'yes', 'enabled'])

async function refreshGate(): Promise<boolean | null> {
  try {
    const raw = await getAppSetting('native_input_enabled')
    const v = raw !== null && TRUE_WORDS.has(raw.trim().toLowerCase())
    gateValue = v
    gateFetchedAt = Date.now()
    return v
  } catch {
    return null // 直近の観測値（gateValue）は消さない
  }
}

/**
 * app_settings.native_input_enabled と「サーバーの値を観測できたか」。
 * observed=false は「入力できるかどうかが分からない」状態で、封鎖（＝スプシ期間）とは別物。
 * 画面はこの2つを区別し、observed=false では封鎖理由ではなく通信エラーと再試行を出す
 * （multi-device-sync 原則5: 観測できていないことを断定しない）。
 */
export async function getNativeInputGate(): Promise<{ value: boolean; observed: boolean }> {
  const v = await refreshGate()
  if (v !== null) return { value: v, observed: true }
  // 取り直せなかった。この起動中に一度でも観測できていれば、その値を使う（観測済み扱い）
  if (gateValue !== null) return { value: gateValue, observed: true }
  return { value: false, observed: false }
}

/**
 * app_settings.native_input_enabled。取得できない時は最後に観測した値、それも無ければ false。
 * 「観測できなかった」と「false を観測した」を区別したい画面は getNativeInputGate を使う。
 */
export async function getNativeInputEnabled(): Promise<boolean> {
  return (await getNativeInputGate()).value
}

/**
 * 書込の入口ガード。封鎖中は書かずに理由文で止める。
 * 一度も「解禁」を観測できていない状態では書かせない（並走期間の二重記録を防ぐ側に倒す）。
 */
async function assertWritable(): Promise<void> {
  if (!isSupabaseConfigured()) throw new DbError('unconfigured', MSG.unconfigured)
  if (gateValue === true) {
    // 解禁を観測済み。期限切れなら背景で取り直し、この書込は待たせない（オフラインでもキューに載る）
    if (Date.now() - gateFetchedAt >= GATE_TTL_MS) void refreshGate()
    return
  }
  const v = await refreshGate()
  if (v === null) throw new DbError('gate-unknown', MSG.gateUnknown)
  if (!v) throw new DbError('blocked', MSG.blocked)
}

// ── 読取 ─────────────────────────────────────────────────────────────────────

/** 利用者スナップショット（active のみ・居室昇順） */
export async function fetchResidents(): Promise<Resident[]> {
  const sb = await getClient()
  const res = (await sb
    .from('residents')
    .select(RESIDENT_COLS)
    .eq('active', true)
    .order('room', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .limit(MAX_ROWS)) as Res<unknown>
  if (res.error !== null) throw readError(res)
  return list(res.data, normalizeResident)
}

/** 職員スナップショット（active のみ・氏名昇順） */
export async function fetchStaff(): Promise<Staff[]> {
  const sb = await getClient()
  const res = (await sb
    .from('staff')
    .select(STAFF_COLS)
    .eq('active', true)
    .order('name', { ascending: true })
    .limit(MAX_ROWS)) as Res<unknown>
  if (res.error !== null) throw readError(res)
  const staff = list(res.data, normalizeStaff)
  staffCache = staff
  staffCachedAt = Date.now()
  return staff
}

let staffCache: Staff[] | null = null
let staffCachedAt = 0

async function staffSnapshot(): Promise<Staff[]> {
  if (staffCache !== null && Date.now() - staffCachedAt < STAFF_TTL_MS) return staffCache
  return fetchStaff()
}

/** タイムライン1チャンク（RPC timeline_chunk で6系列＋取込状態を1往復で取得） */
export async function fetchTimelineChunk(
  fromIso: string,
  toIso: string,
  staffId: number | null,
): Promise<TimelineChunk> {
  const sb = await getClient()
  const res = (await sb.rpc('timeline_chunk', {
    p_from: fromIso,
    p_to: toIso,
    p_staff_id: staffId,
  })) as Res<unknown>
  if (res.error !== null) throw readError(res)
  const raw = asRecord(res.data)
  if (raw === null) throw new DbError('server', MSG.broken)
  return {
    from: fromIso,
    to: toIso,
    notes: list(raw.notes, normalizeNote),
    vitals: list(raw.vitals, normalizeVital),
    meals: list(raw.meals, normalizeMeal),
    fluids: list(raw.fluids ?? raw.fluid_intake, normalizeFluid),
    outings: list(raw.outings, normalizeOuting),
    importDays: list(raw.import_days ?? raw.importDays, normalizeImportDay),
    pinned: list(raw.pinned, normalizeNote),
  }
}

/** 個人カルテ（resident_id＋日付レンジ必須・系列ごとに limit ガード） */
export async function fetchKarte(
  residentId: number,
  fromIso: string,
  toIso: string,
): Promise<{ vitals: Vital[]; meals: Meal[]; fluids: FluidIntake[]; notes: Note[]; outings: Outing[] }> {
  const sb = await getClient()
  const range = <T>(table: string, cols: string, dateCol: string, cap: number) =>
    sb
      .from(table)
      .select(cols)
      .eq('resident_id', residentId)
      .gte(dateCol, fromIso)
      .lte(dateCol, toIso)
      .is('deleted_at', null)
      .order(dateCol, { ascending: false })
      .order('id', { ascending: false })
      .limit(cap) as unknown as Promise<Res<T>>

  // 外出・外泊は「期間に重なるもの」を採る（開始が期間より前でも、期間内に在室していない日は
  // カルテ上で外出中として扱う必要があるため）。帰着未定（end_on is null）は継続中とみなす。
  // or フィルタへ値を差し込むので、日付の形を検査してから使う（予約文字の混入を防ぐ）。
  const rangeOk = /^\d{4}-\d{2}-\d{2}$/.test(fromIso) && /^\d{4}-\d{2}-\d{2}$/.test(toIso)
  const outingsQuery = (
    rangeOk
      ? sb
          .from('outings')
          .select(OUTING_COLS)
          .eq('resident_id', residentId)
          .lte('start_on', toIso)
          .or(`end_on.is.null,end_on.gte.${fromIso}`)
          .is('deleted_at', null)
          .order('start_on', { ascending: false })
          .order('id', { ascending: false })
          .limit(KARTE_ROWS)
      : // 日付の形が想定外なら従来どおり開始日レンジで絞る（不正値をフィルタ式へ載せない）
        range<unknown>('outings', OUTING_COLS, 'start_on', KARTE_ROWS)
  ) as unknown as Promise<Res<unknown>>

  const [vitals, meals, fluids, notes, outings] = await Promise.all([
    range<unknown>('vitals', VITAL_COLS, 'measured_on', KARTE_ROWS),
    range<unknown>('meals', MEAL_COLS, 'meal_on', MAX_ROWS),
    range<unknown>('fluid_intake', FLUID_COLS, 'taken_on', MAX_ROWS),
    range<unknown>('notes', NOTE_COLS, 'note_on', KARTE_ROWS),
    outingsQuery,
  ])
  for (const res of [vitals, meals, fluids, notes, outings]) {
    if (res.error !== null) throw readError(res)
  }
  return {
    vitals: list(vitals.data, normalizeVital, KARTE_ROWS),
    meals: list(meals.data, normalizeMeal),
    fluids: list(fluids.data, normalizeFluid),
    notes: list(notes.data, normalizeNote, KARTE_ROWS),
    outings: list(outings.data, normalizeOuting, KARTE_ROWS),
  }
}

/**
 * PostgREST のフィルタ値として安全な ilike パターンを作る。
 * LIKE メタ文字（% _ \）を無効化し、予約文字（, . : ( ) 等）に備えて二重引用符で囲む。
 */
function likePattern(q: string): string {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`)
  const quoted = `%${escaped}%`.replace(/[\\"]/g, (c) => `\\${c}`)
  return `"${quoted}"`
}

function normalizeName(s: string): string {
  return s.replace(/[\s　]/g, '').toLowerCase()
}

/** 申し送り検索（本文 or 記入者・期間必須・既定50件） */
export async function searchNotes(p: {
  q: string
  target: 'body' | 'reporter'
  fromIso: string
  toIso: string
  importance?: Importance
  shift?: Shift
  limit?: number
}): Promise<Note[]> {
  const q = p.q.trim()
  if (q === '') return []
  const cap = Math.min(Math.max(1, p.limit ?? SEARCH_ROWS), MAX_ROWS)
  const sb = await getClient()

  let reporterIds: number[] = []
  if (p.target === 'reporter') {
    const needle = normalizeName(q)
    reporterIds = (await staffSnapshot())
      .filter((s) => normalizeName(s.name).includes(needle))
      .slice(0, 100) // URL 長対策。100名を超える一致は現場運用上あり得ない
      .map((s) => s.id)
    if (reporterIds.length === 0) return []
  }

  let query = sb
    .from('notes')
    .select(NOTE_COLS)
    .gte('note_on', p.fromIso)
    .lte('note_on', p.toIso)
    .is('deleted_at', null)
  if (p.target === 'body') query = query.ilike('body', likePattern(q))
  else query = query.in('reporter_id', reporterIds)
  if (p.importance !== undefined) query = query.eq('importance', p.importance)
  if (p.shift !== undefined) query = query.eq('shift', p.shift)

  const res = (await query
    .order('note_on', { ascending: false })
    .order('id', { ascending: false })
    .limit(cap)) as Res<unknown>
  if (res.error !== null) throw readError(res)
  return list(res.data, normalizeNote, cap)
}

/** 自分（staffId）が未読の申し送り件数（sinceIso 以降・上限2000件の範囲で数える） */
export async function fetchUnreadCount(staffId: number, sinceIso: string): Promise<number> {
  const sb = await getClient()
  const notesRes = (await sb
    .from('notes')
    .select('id')
    .gte('note_on', sinceIso)
    .is('deleted_at', null)
    .order('id', { ascending: false })
    .limit(MAX_ROWS)) as Res<unknown>
  if (notesRes.error !== null) throw readError(notesRes)
  const ids: number[] = []
  if (Array.isArray(notesRes.data)) {
    for (const row of notesRes.data) {
      const id = idNum(asRecord(row)?.id)
      if (id !== null) ids.push(id)
    }
  }
  if (ids.length === 0) return 0

  let minId = ids[0]
  for (const id of ids) if (id < minId) minId = id
  const readsRes = (await sb
    .from('note_reads')
    .select('note_id')
    .eq('staff_id', staffId)
    .gte('note_id', minId)
    .limit(MAX_ROWS)) as Res<unknown>
  if (readsRes.error !== null) throw readError(readsRes)
  const read = new Set<number>()
  if (Array.isArray(readsRes.data)) {
    for (const row of readsRes.data) {
      const id = idNum(asRecord(row)?.note_id)
      if (id !== null) read.add(id)
    }
  }
  return ids.filter((id) => !read.has(id)).length
}

/**
 * 1件の申し送りを既読にした職員（既読の早い順・最大100名）。
 * 使うのは氏名の表示だけ（誰がいつ読んだかの時刻は画面に出さない）。
 * note_reads は soft delete 列を持たない表なので deleted_at の条件は付けない。
 */
export async function fetchNoteReaders(noteId: number): Promise<Staff[]> {
  const sb = await getClient()
  const res = (await sb
    .from('note_reads')
    .select(`read_at,staff:staff_id(${STAFF_COLS})`)
    .eq('note_id', noteId)
    .order('read_at', { ascending: true })
    .limit(READERS_ROWS)) as Res<unknown>
  if (res.error !== null) throw readError(res)
  const rows = Array.isArray(res.data) ? res.data : []
  const out: Staff[] = []
  const seen = new Set<number>()
  for (const row of rows) {
    if (out.length >= READERS_ROWS) break
    // 埋め込みは1対1でも配列で返る実装があるため、どちらの形でも受ける（受信を信じない）
    const embedded = asRecord(row)?.staff
    const one = Array.isArray(embedded) ? embedded[0] : embedded
    const staff = normalizeStaff(one)
    if (staff === null || seen.has(staff.id)) continue
    seen.add(staff.id)
    out.push(staff)
  }
  return out
}

/** app_settings（key/value・1行）の値。未登録は null */
export async function getAppSetting(key: string): Promise<string | null> {
  const sb = await getClient()
  const res = (await sb
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .limit(1)
    .maybeSingle()) as Res<unknown>
  if (res.error !== null) throw readError(res)
  return str(asRecord(res.data)?.value)
}

// ── 書込（insert / update / soft delete） ────────────────────────────────────

async function insertRow<T>(
  table: QueueTable,
  payload: Record<string, unknown>,
  normalize: (row: unknown) => T | null,
): Promise<T | Queued> {
  await assertWritable()
  const sb = await getClient()
  const cols = colsOf(table)
  const res = (await sb.from(table).insert(payload).select(cols).maybeSingle()) as Res<unknown>

  if (res.error !== null) {
    if (isAuthFail(res)) {
      fireAuthExpired()
      return enqueue({ table, kind: 'insert', payload })
    }
    if (isTransient(res)) return enqueue({ table, kind: 'insert', payload })
    if (isUniqueViolation(res)) {
      const ck = clientKeyOf(payload)
      if (ck !== null) {
        // 端末が付けた冪等キーの衝突＝同じ入力が既にサーバーへ載っている（再送の行き違い）。
        // 新しい行を作らず、載っている行をそのまま返す。読めなければ退避して次の再送で確かめる
        const landed = await findByKey(sb, table, ck, cols, true)
        const row = landed === null ? null : normalize(landed.row)
        return row ?? enqueue({ table, kind: 'insert', payload })
      }
      return insertAsUpdate(sb, table, payload, normalize)
    }
    throw new DbError('server', serverMsg('保存でき', errCode(res)))
  }
  const row = normalize(res.data)
  if (row === null) throw new DbError('server', MSG.broken)
  return row
}

/** 23505（他端末先行）→ 既存行を読み直して update に切り替える。upsert は使わない */
async function insertAsUpdate<T>(
  sb: SupabaseClient,
  table: QueueTable,
  payload: Record<string, unknown>,
  normalize: (row: unknown) => T | null,
): Promise<T> {
  const key = conflictKeyOf(table, payload)
  if (key === null) throw new DbError('server', MSG.raceInsert)
  const cols = colsOf(table)
  // null（＝この端末では未入力）は送らない。先に保存した端末の値を消さないため（dropNulls 参照）
  const patch = dropNulls(omitKeys(payload, Object.keys(key)))

  // 読み直し→rev 照合 update を2回まで試す（その間にさらに他端末が書いた場合の一巡）
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await findByKey(sb, table, key, cols)
    if (existing === null) break
    if (Object.keys(patch).length === 0) {
      // 書く差分が無い＝求めていた内容が既に載っている。読み直した行をそのまま返す
      const kept = normalize(existing.row)
      if (kept === null) throw new DbError('server', MSG.broken)
      return kept
    }
    const res = (await sb
      .from(table)
      .update(patch)
      .eq('id', existing.id)
      .eq('rev', existing.rev)
      .is('deleted_at', null)
      .select(cols)
      .maybeSingle()) as Res<unknown>
    if (res.error !== null) throw writeError(res)
    if (res.data !== null) {
      const row = normalize(res.data)
      if (row === null) throw new DbError('server', MSG.broken)
      return row
    }
  }
  throw new DbError('server', MSG.raceInsert)
}

async function updateRow<T>(
  table: QueueTable,
  id: number,
  rev: number,
  patch: Record<string, unknown>,
  normalize: (row: unknown) => T | null,
): Promise<T | Conflict | Queued> {
  await assertWritable()
  if (Object.keys(patch).length === 0) throw new DbError('server', MSG.emptyPatch)
  const sb = await getClient()
  const res = (await sb
    .from(table)
    .update(patch)
    .eq('id', id)
    .eq('rev', rev)
    .is('deleted_at', null)
    .select(colsOf(table))
    .maybeSingle()) as Res<unknown>

  if (res.error !== null) {
    if (isAuthFail(res)) {
      fireAuthExpired()
      return enqueue({ table, kind: 'update', payload: patch, rowId: id, rev })
    }
    if (isTransient(res)) return enqueue({ table, kind: 'update', payload: patch, rowId: id, rev })
    throw new DbError('server', serverMsg('保存でき', errCode(res)))
  }
  if (res.data === null) return CONFLICT // 0行 = 他端末が先に更新（または削除済み）
  const row = normalize(res.data)
  if (row === null) throw new DbError('server', MSG.broken)
  return row
}

/** rev 照合つきの部分更新。キューへは載せない（削除・帰着記入など、最新の rev が要る操作） */
async function updateNow<T>(
  table: QueueTable,
  id: number,
  rev: number,
  patch: Record<string, unknown>,
  normalize: (row: unknown) => T | null,
): Promise<T | Conflict> {
  await assertWritable()
  const sb = await getClient()
  const res = (await sb
    .from(table)
    .update(patch)
    .eq('id', id)
    .eq('rev', rev)
    .is('deleted_at', null)
    .select(colsOf(table))
    .maybeSingle()) as Res<unknown>
  if (res.error !== null) throw writeError(res)
  if (res.data === null) return CONFLICT
  const row = normalize(res.data)
  if (row === null) throw new DbError('server', MSG.broken)
  return row
}

/** soft delete（物理削除はしない）。rev 照合で 0行 なら competing 更新＝conflict */
async function softDelete(table: QueueTable, id: number, rev: number): Promise<true | Conflict> {
  await assertWritable()
  const sb = await getClient()
  const res = (await sb
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('rev', rev)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle()) as Res<unknown>
  if (res.error !== null) throw writeError(res)
  return res.data === null ? CONFLICT : true
}

// ── バイタル ─────────────────────────────────────────────────────────────────

export async function insertVital(v: Omit<Vital, 'id' | 'rev'>): Promise<Vital | Queued> {
  return insertRow('vitals', cleanPayload(v as unknown as Record<string, unknown>), normalizeVital)
}

export async function updateVital(
  id: number,
  rev: number,
  patch: Partial<Omit<Vital, 'id' | 'rev'>>,
): Promise<Vital | Conflict | Queued> {
  return updateRow('vitals', id, rev, cleanPayload(patch as Record<string, unknown>), normalizeVital)
}

// ── 食事 ─────────────────────────────────────────────────────────────────────

export async function insertMeal(m: Omit<Meal, 'id' | 'rev'>): Promise<Meal | Queued> {
  return insertRow('meals', cleanPayload(m as unknown as Record<string, unknown>), normalizeMeal)
}

export async function updateMeal(
  id: number,
  rev: number,
  patch: Partial<Omit<Meal, 'id' | 'rev'>>,
): Promise<Meal | Conflict | Queued> {
  return updateRow('meals', id, rev, cleanPayload(patch as Record<string, unknown>), normalizeMeal)
}

// ── 水分 ─────────────────────────────────────────────────────────────────────

export async function insertFluid(f: Omit<FluidIntake, 'id' | 'rev'>): Promise<FluidIntake | Queued> {
  return insertRow('fluid_intake', withClientKey(f as unknown as Record<string, unknown>), normalizeFluid)
}

export async function softDeleteFluid(id: number, rev: number): Promise<true | Conflict> {
  return softDelete('fluid_intake', id, rev)
}

// ── 申し送り ─────────────────────────────────────────────────────────────────

export async function insertNote(
  n: Omit<Note, 'id' | 'rev' | 'read_count' | 'my_read'>,
): Promise<Note | Queued> {
  if (n.body.trim() === '') throw new DbError('server', MSG.emptyBody)
  return insertRow('notes', withClientKey(n as unknown as Record<string, unknown>), normalizeNote)
}

export async function updateNote(
  id: number,
  rev: number,
  patch: Partial<Omit<Note, 'id' | 'rev'>>,
): Promise<Note | Conflict | Queued> {
  if (patch.body !== undefined && patch.body.trim() === '') throw new DbError('server', MSG.emptyBody)
  const clean = cleanPayload(patch as Record<string, unknown>)
  delete clean.read_count // 集計値はサーバー側の畳み込み。書き戻さない
  delete clean.my_read
  return updateRow('notes', id, rev, clean, normalizeNote)
}

export async function softDeleteNote(id: number, rev: number): Promise<true | Conflict> {
  return softDelete('notes', id, rev)
}

/**
 * 継続申し送りを終了する。ended_at だけを書く部分更新。
 * ongoing フラグは触らない（過去日のピン留めは「その日時点で有効だった継続」＝
 * note_on ≦ 対象日 ≦ ended_at で判定する契約。qa-verification [low/both] の裁定）。
 */
export async function endOngoingNote(id: number, rev: number): Promise<Note | Conflict> {
  return updateNow('notes', id, rev, { ended_at: new Date().toISOString() }, normalizeNote)
}

// ── 外出・外泊 ───────────────────────────────────────────────────────────────

export async function insertOuting(o: Omit<Outing, 'id' | 'rev'>): Promise<Outing | Queued> {
  return insertRow('outings', withClientKey(o as unknown as Record<string, unknown>), normalizeOuting)
}

/** 帰着の後追い記入。end_on / end_at だけを送り、他の項目はサーバーの値を温存する */
export async function setOutingEnd(
  id: number,
  rev: number,
  endOn: string,
  endAt: string | null,
): Promise<Outing | Conflict> {
  return updateNow('outings', id, rev, { end_on: endOn, end_at: endAt }, normalizeOuting)
}

// ── 既読 ─────────────────────────────────────────────────────────────────────

/**
 * 既読を付ける。明示操作（本文展開タップ・既読ボタン）からのみ呼ぶこと
 * （multi-device-sync 原則9: 読み取り経路から書かない）。
 * 閲覧機能なので入力解禁フラグの封鎖対象にしない（並走期間も閲覧は全機能有効）。
 */
export async function markRead(noteId: number, staffId: number): Promise<void> {
  const sb = await getClient()
  const res = (await sb
    .from('note_reads')
    .insert({ note_id: noteId, staff_id: staffId })
    .select('note_id')
    .maybeSingle()) as Res<unknown>
  if (res.error === null) return
  if (isUniqueViolation(res)) return // 既に既読。成功と同じ
  throw writeError(res)
}

// ── Realtime ─────────────────────────────────────────────────────────────────

/**
 * 変更通知の購読。どの表が変わったかだけを渡す（表示ウィンドウ内かの判断は呼び出し側）。
 * 接続できない場合は購読しないだけで、画面は手動更新で成立する。
 */
export function subscribeChanges(cb: (table: string) => void): () => void {
  let cancelled = false
  let client: SupabaseClient | null = null
  let channel: ReturnType<SupabaseClient['channel']> | null = null

  void (async () => {
    try {
      const sb = await getClient()
      if (cancelled) return
      client = sb
      let ch = sb.channel(`cl_changes_${Math.random().toString(36).slice(2, 10)}`)
      for (const table of REALTIME_TABLES) {
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
          if (!cancelled) cb(table)
        })
      }
      channel = ch
      ch.subscribe()
    } catch {
      // 接続先未設定・通信不可。購読なしで動く
    }
  })()

  return () => {
    cancelled = true
    if (client !== null && channel !== null) void client.removeChannel(channel)
    channel = null
  }
}

// ── 保守用（積み残しの可視化） ───────────────────────────────────────────────

/** localStorage の未送信データが壊れていて読めなかったか（設定画面での注意表示用） */
export function isQueueBroken(): boolean {
  return queueBroken
}

/**
 * 退避した書込を端末に残せているか（false = メモリ上だけ＝タブを閉じると失われる）。
 * 'queued' を受けた画面が「入力の控え（下書き）を消してよいか」を判断するための保全ゲート。
 * multi-device-sync 原則8「消去は保全ゲートの後ろ」。キューが空なら残すものが無いので true。
 */
export function isQueuePersisted(): boolean {
  return queue.length === 0 || queuePersisted
}
