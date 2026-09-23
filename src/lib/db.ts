// ─────────────────────────────────────────────────────────────────────────────
// src/lib/db.ts — care-log の全データアクセス層
//
// 契約（docs/design/contracts.md）:
//   ・supabase.from() / supabase.rpc() を直接呼ぶのはこのファイルと gasClient.ts だけ。
//     他のファイルはここが export する関数だけを使う。
//   ・全読取に .is('deleted_at', null)（列を持つ業務表のみ）と limit を機械付与する。
//     日付レンジ or resident_id の無いクエリを書かない（全件ロード禁止）。
//   ・upsert は使わない。
//   ・バイタル・食事は RPC apply_cell_edits（0011）で欄ごとに書く（2026-09-23 フェーズ2'）。判定（いまの値＝
//     あなたの値なら済み／基準のままなら書く／それ以外は競合）はサーバーが行ロックの下で行い、端末は判定しない。
//     定時以外のバイタルの新しい行は端末生成の冪等キー client_key で1行に収める。
//   ・水分・申し送り・外出は HEAD（c592dad）の送り方のまま: insert は端末生成の冪等キー client_key を必ず付け、
//     23505 なら「既に届いている」証拠として既存行を読み直し、二重登録を作らない。
//   ・物理削除はしない（soft delete = deleted_at のみ）。
//   ・水分・申し送り・外出の更新は rev 照合（.eq('rev', rev)）。0行 = 競合 → 'conflict' を返し、
//     呼び出し側の入力は消さない。
//   ・通信失敗・認証切れの書込は永続キュー（localStorage cl_sendQueue／バイタル・食事は cl_sendQueue2）へ退避し 'queued' を返す。
//     キューから消すのは「サーバーに載ったことを観測できた時」だけ（multi-device-sync 原則6・8）。
//     業務データを置く localStorage は cl_sendQueue / cl_sendQueue2 / cl_draftNote / cl_dailyDraft:<日付> の
//     4キーだけ（cl_dailyDraft は日報の書きかけ＝2026-09-02 追加。24時間で失効させる。cl_sendQueue2 はバイタル・食事の
//     送信待ち＝2026-09-23 第3段 #1。旧ビルドへ戻しても消えないよう cl_sendQueue から分けた）。読めなく
//     なったキューの原文も別キーを作らず、読んだキューの中（brokenRaw）へ畳んで保持する。
//   ・console に応答本文・氏名・記録本文を出さない（件数など非個人情報のみ）。
//
// 設計根拠: docs/design/db-design.md §2（RPC timeline_chunk・索引）／§5（書込・同期）、
//           docs/design/ui-design.md §0.5（入力封鎖）／§6.5（キューと下書きの保持規則）、
//           ~/.claude/rules/multi-device-sync.md（原則1・3・4・5・6・8・9・10）。
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Attendance,
  FluidIntake,
  ImportDay,
  Importance,
  Meal,
  MealSlot,
  MealStatus,
  Note,
  NoteColor,
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
/** 日報1日分の1系列あたりの取得上限（1日の申し送り・付帯行がこれを超える運用は無い） */
const DAY_ROWS = 500
/** 1日の取込台帳（source 別に数行）の取得上限 */
const IMPORT_DAY_ROWS = 10
/** 日報で既読状態を引く申し送りの件数上限（URL 長対策。1日の申し送りがこれを超える運用は無い） */
const READ_LOOKUP_ROWS = 200
/**
 * 食事一覧（横並び）の食事の取得上限。1行 = 1名1日1コマ なので 人数 × 4コマ × 日数 で増える
 * （既定11日なら 45名分まで載る）。水分とは別枠にして、片方を触ってももう片方の余裕が
 * 動かないようにする（同じ定数を共有すると、どちらの都合で決めた値か分からなくなる）。
 */
const MEALS_SHEET_ROWS = MAX_ROWS
/**
 * 食事一覧の水分の取得上限。RPC meals_sheet_fluids が 1行 = 1名1日（合計＋内訳）にまとめて
 * 返すので 人数 × 日数 で増える（既定11日なら 181名分まで載る）。
 */
const FLUID_DAY_ROWS = MAX_ROWS
/**
 * 水分の内訳（1回 = 1件）をほどいた後の総件数の上限。
 * 規模モデル（33名 × 11日 × 5件/日 ≒ 1,800件）の5倍以上の余裕を取った歯止めで、
 * 超えた時は黙って切り捨てず日数を減らす案内を出す（無言の欠落を作らない）。
 */
const FLUID_ENTRY_ROWS = 10_000
/** 出勤者から外した行に付ける並び順（物理削除しないので、この印で非表示にして復活もできる） */
const ATTENDANCE_HIDDEN_SORT = -1

const VITAL_KINDS: readonly VitalKind[] = ['routine', 'recheck', 'observation', 'symptom']
const NOTE_COLORS: readonly NoteColor[] = ['pink', 'yellow', 'blue', 'green', 'orange']
const ATTENDANCE_ROLES: readonly Attendance['role'][] = ['manager', 'staff']
const MEAL_SLOTS: readonly MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack']
const MEAL_STATUSES: readonly MealStatus[] = ['eaten', 'out', 'hospital', 'refused']
const SHIFTS: readonly Shift[] = ['day', 'daycare', 'night']
const IMPORTANCES: readonly Importance[] = ['normal', 'important', 'critical']
const OUTING_KINDS: readonly OutingKind[] = ['outing', 'overnight']

// select する列は types.ts と一致させる（* を使わず、監査列・import_key を端末へ持ち出さない）
const RESIDENT_COLS = 'id,source_id,name,kana,room,gender,care_level,active,needs_review,note_alias'
const STAFF_COLS = 'id,name,active'
const VITAL_COLS =
  'id,resident_id,measured_on,kind,measured_at,temp,sys_bp,dia_bp,pulse,spo2,note,symptom,recorded_by,rev'
const MEAL_COLS = 'id,resident_id,meal_on,meal_slot,main_amount,side_amount,status,note,recorded_by,rev'
const FLUID_COLS = 'id,resident_id,taken_on,taken_at,amount_ml,kind,recorded_by,rev'
const NOTE_COLS =
  'id,note_on,shift,facility,category,resident_id,role_tags,importance,body,occurred_at,ongoing,ended_at,reporter_id,color,after16,rev'
const OUTING_COLS = 'id,resident_id,kind,start_on,start_at,end_on,end_at,companion,note,recorded_by,rev'
const ATTENDANCE_COLS = 'day,staff_id,role,sort'
const IMPORT_DAY_COLS = 'source,day,imported_at,src_rows,inserted,updated,skipped,native_skip,unmatched'

/**
 * Realtime を購読する表（受信は「どの表が変わったか」だけを伝える）。
 * attendance も対象（0003_sheet_ui.sql で publication に追加済み）。
 * 他端末の出勤者の追加・取り消しでも日報シートに「最新に更新」を出すため。
 */
const REALTIME_TABLES = [
  'notes',
  'vitals',
  'meals',
  'fluid_intake',
  'outings',
  'note_reads',
  'attendance',
] as const

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
  /**
   * サーバーへ**一部だけ書き込んだ後**に失敗したか（既定 false ＝1行も書けていない）。
   * true の時、画面は入力を保存前へ巻き戻してはいけない（載った分を「保存されていない」と
   * 見せることになるため）。読み直しを促す案内に切り替える。
   */
  readonly partial: boolean
  constructor(kind: DbErrorKind, message: string, partial = false) {
    super(message)
    this.name = 'DbError'
    this.kind = kind
    this.partial = partial
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
  cellsPending:
    'サーバー側の更新待ちのため、バイタル・食事はまだ保存できません。管理者に連絡してください。入力は消えていません。',
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

/** 一意制約違反（他端末が先に同じ行を作った・既に届いている証拠） */
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

/** テストが差し込んだ偽のクライアント（本番では常に null。差し込み口は __testHooks.setClient だけ） */
let testClient: SupabaseClient | null = null

/** 接続先（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）が設定されているか */
export function isSupabaseConfigured(): boolean {
  if (testClient !== null) return true
  // 型は src/vite-env.d.ts（vite/client）で付くが、未設定・非 Vite 実行でも落ちないよう
  // キャスト経由で optional に読む。ビルド時に Vite が実体へ置換することは実測済み。
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const url = env?.VITE_SUPABASE_URL ?? ''
  const key = env?.VITE_SUPABASE_ANON_KEY ?? ''
  return url !== '' && key !== ''
}

async function getClient(): Promise<SupabaseClient> {
  if (testClient !== null) return testClient
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
    // 申し送りでの表示名。列がまだ無いDB（0007 未適用）でも undefined → null になり、
    // マスタの氏名を出す従来どおりの動きに落ちる（画面は壊れない）
    note_alias: str(r.note_alias),
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
    // 他症状者ブロックの症状欄（0003 で追加した列。旧サーバーが返さなければ null）
    symptom: str(r.symptom),
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
    // 行の色・16時区切り（0003 で追加した列。旧サーバーが返さなければ色なし・区切り前として扱う）
    color: oneOf(r.color, NOTE_COLORS),
    after16: bool(r.after16, false),
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

// ── 送信キュー（localStorage: cl_sendQueue ＋ cl_sendQueue2） ─────────────────────
// 保持するのは resident_id・日付・数値・本文だけ（氏名は入れない）。
// ui-design §6.5「保持必須・成功で即削除」＋ multi-device-sync 原則8「消去は保全ゲートの後ろ」。
//
// 2026-09-23 フェーズ2'（本人承認「サーバー側判定へ切替」）から、2つのキーに分けて持つ（第3段 #1）:
//   ・cl_sendQueue  … 水分・申し送り・外出・既読・出勤者・表示名の退避 op。形は HEAD c592dad と同じ
//                     { ops: [op…], brokenRaw? }（旧ビルドへ戻しても、そのまま読み書きできる）
//   ・cl_sendQueue2 … バイタル・食事の送信待ち（1行＝1エントリ・欄ごとに「値・基準・版」）と、送信済み・取り下げた
//                     版の記録（done）。{ ver: 2, rows: { [行キー]: エントリ }, done: [記録…], brokenRaw? }。
//                     判定は RPC apply_cell_edits（0011）が行ロックの下で欄ごとに行う（端末は判定しない）。旧ビルドは触らない
// cl_sendQueue にあるバイタル・食事の op（旧ビルドが積んだ分・旧形式）は cl_sendQueue2 の rows へ読み替えて移す。
// cl_sendQueue から外すのは、cl_sendQueue2 に書けたことを読み直して確かめた後だけ（書けなければ外さない＝消さない）。
// 書き戻しはすべて書込ロック（cl_sendQueue_write）の中で「読み直し → 和集合 → 書き戻し」（#5）。

/** 旧経路（HEAD の送り方）のまま送る業務表 */
type LegacyTable = 'fluid_intake' | 'notes' | 'outings'

/** 列の並び・rev 照合の作法が共通の業務表（読み取りの列は colsOf） */
type QueueTable = 'vitals' | 'meals' | LegacyTable

/**
 * 上の表とは書き方が違う退避先（rev を持たない・差分計算が要る・1列だけ書く）。
 * LegacyTable は広げない＝insert/update の経路にこれらの表が紛れ込まないよう型で分ける。
 */
type ExtraQueueTable = 'note_reads' | 'attendance' | 'residents'

/** 退避 op に共通の管理項目（表・種別ごとの違いは下の4つの形が持つ） */
interface QueueOpBase {
  qid: string
  payload: Record<string, unknown>
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

/** 水分・申し送り・外出への insert / update（HEAD と同じ形） */
interface RowQueueOp extends QueueOpBase {
  table: LegacyTable
  kind: 'insert' | 'update'
  rowId?: number
  rev?: number
}

/** 上の表以外への退避（表は ExtraQueueTable のいずれか。kind と1対1で対応させる） */
interface ExtraQueueOp<T extends ExtraQueueTable> extends QueueOpBase {
  table: T
}

/** 既読の付与（note_reads への insert。23505 は「既に既読」＝成功と同じ） */
interface ReadQueueOp extends ExtraQueueOp<'note_reads'> {
  kind: 'read'
}

/** 出勤者の登録（送信時にサーバー現況を読み直して差分を計算する。スナップショットを流し込まない） */
interface AttendanceQueueOp extends ExtraQueueOp<'attendance'> {
  kind: 'attendance'
}

/** 申し送りでの表示名（residents.note_alias の1列だけを書く。rev 照合なし） */
interface AliasQueueOp extends ExtraQueueOp<'residents'> {
  kind: 'alias'
}

type QueueOp = RowQueueOp | ReadQueueOp | AttendanceQueueOp | AliasQueueOp

const LEGACY_TABLES: readonly LegacyTable[] = ['fluid_intake', 'notes', 'outings']

/** 旧版が使っていた退避キー。値は cl_sendQueue の中へ移し、移せたことを観測してから取り除く */
const LEGACY_BROKEN_KEY = `${LS.sendQueue}_broken`

let queue: QueueOp[] = []
let queueBroken = false
/** 読めなかった原文。cl_sendQueue の brokenRaw として持ち続ける（消さずに残すため） */
let queueBrokenRaw: string | null = null
/** cl_sendQueue2 の中の読めなかった原文。cl_sendQueue2 の brokenRaw として持ち続ける */
let cellBrokenRaw: string | null = null
/** 旧キーからの移行待ち。現行キーへ書けたことを観測してからだけ旧キーを消す */
let legacyBrokenPending = false
/** 起動時に cl_sendQueue から cl_sendQueue2 へ移す分があった（書き戻して移す） */
let convertedOnLoad = false
/** 直近の永続化に成功しているか（false = メモリ上だけ＝タブを閉じると失われる） */
let queuePersisted = true
/** この起動中に「サーバーへ載った」ことを観測できた op の qid（他タブの控えから復活させない印） */
const sentQids = new Set<string>()
const queueCbs = new Set<(n: number) => void>()

function normalizeQueueOp(row: unknown): QueueOp | null {
  const r = asRecord(row)
  if (!r) return null
  const payload = asRecord(r.payload)
  if (payload === null) return null
  const base: QueueOpBase = {
    qid: str(r.qid) ?? `q${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    payload,
    at: num(r.at) ?? Date.now(),
    tries: num(r.tries) ?? 0,
    nextAt: num(r.nextAt) ?? 0,
  }
  if (r.blocked === 'conflict' || r.blocked === 'rejected') base.blocked = r.blocked

  // 水分・申し送り・外出への insert / update（旧版が書いた値もそのまま読める）
  if (r.kind === 'insert' || r.kind === 'update') {
    const table = oneOf(r.table, LEGACY_TABLES)
    if (table === null) return null
    const op: RowQueueOp = { ...base, table, kind: r.kind }
    const rowId = idNum(r.rowId)
    if (rowId !== null) op.rowId = rowId
    const rev = num(r.rev)
    if (rev !== null) op.rev = rev
    if (r.kind === 'update' && (op.rowId === undefined || op.rev === undefined)) return null
    return op
  }
  // 追加した種別は kind と table の組が合っている時だけ受ける（取り違えた op を送らない）
  if (r.kind === 'read' && r.table === 'note_reads') return { ...base, table: 'note_reads', kind: 'read' }
  if (r.kind === 'attendance' && r.table === 'attendance') {
    return { ...base, table: 'attendance', kind: 'attendance' }
  }
  if (r.kind === 'alias' && r.table === 'residents') return { ...base, table: 'residents', kind: 'alias' }
  return null
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
 * where＝どのキーの brokenRaw に持つか（読めなかった原文は、読んだキーの中に残す）
 */
function keepBroken(chunks: string[], where: 'queue' | 'cells' = 'queue'): void {
  for (const c of chunks) {
    if (c === '') continue
    const cur = where === 'queue' ? queueBrokenRaw : cellBrokenRaw
    const next = cur === null ? c : cur.includes(c) ? cur : `${cur}\n${c}`
    if (where === 'queue') queueBrokenRaw = next
    else cellBrokenRaw = next
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

// ── バイタル・食事の送信待ち（pending store。送るのは RPC apply_cell_edits） ──────
//
// 1行（行キー）につき1エントリ。欄ごとに「値・基準・版」を持つ。
//   値   … 利用者がその欄に最後に入れた値（後勝ち。同じ欄を続けて直したら差し替える）
//   基準 … その欄を直し始めた時に画面に出ていたサーバーの生の値（先勝ち。後から直しても変えない。
//          送信待ちの自分の値を基準にすると、サーバーにまだ無い値と比べて偽の競合になる）。
//          キーが無い＝基準が分からない（旧版の退避など）。サーバーは「空の時だけ書く」
//   版   … 送った時の版と応答の時の版が同じ欄だけを消す（送信中に打ち直した欄は消さない）
// 行の状態: pending（送る）／conflict（他の端末が変えた欄がある。〔くらべて選ぶ〕で選ぶまで送らない）／
//          rejected（サーバーに拒否された。新しい入力が来るまで送らない）
// 行キー: vitals@<利用者>|<日付>|routine ／ meals@<利用者>|<日付>|<食事枠> ／ vitals~<client_key> ／
//         vitals#<id>（meals#<id> は旧形式の読み替えだけが作る。送る前に自然キーへ付け替える）
// 別タブ: 書き戻す時に保存先を読み直し、行キー単位・欄単位の和集合にしてから書く（persistQueue）。
//   欄の版の先頭にはタブの印が付く。保存先に載ったことを観測した版が後で消えていたら、
//   他のタブが送り終えたとみなして、このタブのメモリからも外す（二重に送り続けない）。

/** 欄ごとの送信待ちを持つ表 */
export type CellTable = 'vitals' | 'meals'
/** バイタルで送れる欄（0011 apply_cell_edits の許可リストと同じ） */
export type VitalCellField = 'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2' | 'measured_at' | 'note' | 'symptom'
/** 食事で送れる欄（0011 apply_cell_edits の許可リストと同じ） */
export type MealCellField = 'main_amount' | 'side_amount' | 'status' | 'note'

const VITAL_CELL_FIELDS: readonly VitalCellField[] = [
  'temp',
  'sys_bp',
  'dia_bp',
  'pulse',
  'spo2',
  'measured_at',
  'note',
  'symptom',
]
const MEAL_CELL_FIELDS: readonly MealCellField[] = ['main_amount', 'side_amount', 'status', 'note']
/** 空いていれば埋める付随の欄（判定には使わない） */
const CELL_FILL_KEYS: Record<CellTable, readonly string[]> = {
  vitals: ['measured_at', 'recorded_by'],
  meals: ['recorded_by'],
}
/** 冪等キー（client_key）で1行に収める種別（定時は自然キー） */
const KEYLESS_KINDS: readonly VitalKind[] = ['recheck', 'observation', 'symptom']
const CELL_DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const CELL_TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/

/**
 * バイタルの行の指し方。定時は（利用者, 日付）、それ以外の既にある行は id、
 * それ以外の新しい行は端末が付ける冪等キー client_key（同じ入力を何度送っても1行に収まる）
 */
export type VitalTarget =
  | { routine: true; residentId: number; day: string }
  | { routine: false; id: number }
  | { routine: false; clientKey: string; residentId: number; day: string; kind: Exclude<VitalKind, 'routine'> }

/** 食事の行の指し方（利用者 × 日付 × 食事枠。1名1日1コマ1行） */
export interface MealTarget {
  residentId: number
  day: string
  slot: MealSlot
}

/** サーバーが「書かなかった」欄（他の端末が変えていた／行が無い） */
export interface CellConflict {
  field: string
  /** いまサーバーにある値（行が無い時は null） */
  server: unknown
  /** 送った基準（基準が分からなかった欄は null） */
  base: unknown
  /** あなたの値 */
  mine: unknown
  /** changed＝他の端末が変えた（血圧の組の相方も含む）／missing＝行が無い（取り消された） */
  reason: 'changed' | 'missing'
}

type CellValue = number | string | null

/** 送信待ちの1欄 */
interface CellEdit {
  value: CellValue
  /** 基準。キーが無い＝分からない */
  base?: CellValue
  /** 最後に値を受けた時刻（送る順・別タブとの突き合わせに使う） */
  at: number
  /** 版（タブの印.連番）。応答で消してよいかの見分けに使う */
  ver: string
}

type CellState = 'pending' | 'conflict' | 'rejected'

/** 送信待ちの1行（localStorage の rows に入る形） */
interface CellEntry {
  table: CellTable
  /** RPC の p_key そのもの */
  key: Record<string, string | number>
  edits: Record<string, CellEdit>
  /** 空いていれば埋める付随の欄（measured_at・recorded_by）。先に入れた値を保つ */
  fill: Record<string, CellValue>
  /** edited_by として送る職員（最後に入力した人） */
  editor: number | null
  clientKey?: string
  /**
   * 冪等キーで作った行の行 id（応答で分かった後）。画面が行 id で指しても、この行（vitals~ck）を指す（#6。
   * 1つの記録の行キーは作られた時の形のまま変えない）
   */
  rowId?: number
  /** 行 id で指したバイタルが定時でないことを確かめた（送る前の1行読みを省く。#2） */
  bound?: true
  /**
   * 止まった（競合・拒否）行 id の行を読み取りで付け替えようとしたが、行が取り消されていた・読めなかった（第4段 F1）。
   * 行 id のまま残し（未送信に数え続ける）、次からは読まない
   */
  bindChecked?: true
  state: CellState
  conflicts?: CellConflict[]
  tries: number
  nextAt: number
  /** 最後に書いたタブの印 */
  tab: string
  /** 最後に書き換えた時刻（別タブとの突き合わせで新しい方の状態を採る） */
  at: number
}

/**
 * 送信済み・取り下げた版の記録（#5）。別のタブが「保存先から消えた」だけで自分の入力を捨てないよう、
 * 消した側が cl_sendQueue2 に残す証拠。同じ行・同じ欄の、これより古い版も済んだものとみなす（値は後勝ち）
 */
interface DoneMark {
  /** 行キー */
  k: string
  /** 欄 */
  f: string
  /** 版 */
  v: string
  /** その版が値を受けた時刻 */
  at: number
  /** 記録した時刻（古い記録を捨てる） */
  t: number
}
/**
 * 送信済みの記録を持つ期間と件数（これより古い・多い分は捨てる。端末の保存領域を食い続けないため）。
 * 捨てた後に、それより長く開いたままの別のタブから古い版が戻っても、送ればサーバーが欄ごとに判定する
 * （同じ値なら「載っている」、違えば競合＝黙って上書きも消失もしない）
 */
const DONE_KEEP_MS = 24 * 60 * 60 * 1000
const DONE_MAX = 1000

/** この起動（タブ）の印。欄の版の先頭に付け、どのタブが書いた版かを見分ける */
let tabId = newTabId()
let cellVerSeq = 0
let cellRows = new Map<string, CellEntry>()
/** 送信済み・取り下げた版の記録（このタブの分と、保存先から読んだ他のタブの分の和集合） */
let doneMarks: DoneMark[] = []

/** 送り終えた・取り下げた版を記録する（次の書き戻しで保存先にも残り、他のタブ・次の起動で復活しない） */
function markDone(rowKey: string, field: string, ed: CellEdit): void {
  doneMarks.push({ k: rowKey, f: field, v: ed.ver, at: ed.at, t: Date.now() })
}

function normalizeDone(raw: unknown): DoneMark[] {
  if (!Array.isArray(raw)) return []
  const out: DoneMark[] = []
  for (const x of raw) {
    const r = asRecord(x)
    const k = str(r?.k)
    const f = str(r?.f)
    const v = str(r?.v)
    if (r === null || k === null || f === null || v === null || v === '') continue
    out.push({ k, f, v, at: num(r.at) ?? 0, t: num(r.t) ?? 0 })
  }
  return out
}

/** 記録の和集合（同じ版は1つ・古い記録と多すぎる分は捨てる） */
function unionDone(a: DoneMark[], b: DoneMark[]): DoneMark[] {
  const byVer = new Map<string, DoneMark>()
  for (const m of [...a, ...b]) {
    const cur = byVer.get(m.v)
    if (cur === undefined || m.t > cur.t) byVer.set(m.v, m)
  }
  const floor = Date.now() - DONE_KEEP_MS
  const out = [...byVer.values()].filter((m) => m.t >= floor)
  out.sort((x, y) => x.t - y.t)
  return out.length > DONE_MAX ? out.slice(out.length - DONE_MAX) : out
}

interface DoneIndex {
  vers: Set<string>
}

function doneIndexOf(marks: DoneMark[]): DoneIndex {
  return { vers: new Set(marks.map((m) => m.v)) }
}

/**
 * その欄の版が、送り終えた・取り下げた・後の入力に置き換わった版か。同じ版の時だけ（第4段 F2。版は値を含むので、
 * 同じ版＝同じ値。「同じ欄のより新しい版が済んだ」では判定しない＝旧ビルドのタブが同じ op に重ねた値を捨てない）
 */
function isDone(idx: DoneIndex, _rowKey: string, _field: string, ed: CellEdit): boolean {
  return idx.vers.has(ed.ver)
}

/**
 * 値の短い指紋（FNV-1a 32bit・36進）。旧形式の読み替えの版に含める（第4段 F2。旧ビルドのタブは同じ op に値を重ねても
 * qid を変えないので、qid と欄だけの版だと、重ねた値が先に送った値と同じ版になり「送信済み」とみなされて消える）
 */
function valueTag(v: CellValue): string {
  const text = JSON.stringify(v)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

function newTabId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function newCellVer(): string {
  cellVerSeq += 1
  return `${tabId}.${cellVerSeq}`
}

function isCellTable(t: unknown): t is CellTable {
  return t === 'vitals' || t === 'meals'
}

function cellFieldsOf(table: CellTable): readonly string[] {
  return table === 'vitals' ? VITAL_CELL_FIELDS : MEAL_CELL_FIELDS
}

/** 小数 digits 桁に四捨五入する（0.5 は 0 から遠い側＝Postgres の numeric と同じ）。指数表記で2進数の誤差を避ける */
function roundDecimal(n: number, digits: number): number {
  const sign = n < 0 ? -1 : 1
  const shifted = Number(`${Math.abs(n)}e${digits}`)
  const r = Number.isFinite(shifted) ? Math.round(shifted) : Math.round(Math.abs(n) * 10 ** digits)
  return sign * Number(`${r}e-${digits}`)
}

/**
 * 送る値を列の型と精度にそろえる（裁定6。そろえずに送ると、サーバーが丸めた値と自分の値が食い違って見える）。
 * temp は numeric(3,1)、血圧・脈拍・SpO2・主食・副食は smallint、測定時刻は time、状態は許容値だけ。
 * 空（null・undefined・空文字）は null。読めない値は undefined（送らない）
 */
function cellValueOf(field: string, v: unknown): CellValue | undefined {
  if (v === null || v === undefined || v === '') return null
  switch (field) {
    case 'temp': {
      const n = num(v)
      return n === null ? undefined : roundDecimal(n, 1)
    }
    case 'sys_bp':
    case 'dia_bp':
    case 'pulse':
    case 'spo2':
    case 'main_amount':
    case 'side_amount': {
      const n = num(v)
      return n === null ? undefined : roundDecimal(n, 0)
    }
    case 'measured_at': {
      if (typeof v !== 'string') return undefined
      const m = CELL_TIME_RE.exec(v.trim())
      if (!m) return undefined
      const h = Number(m[1])
      if (h > 23 || Number(m[2]) > 59 || (m[3] !== undefined && Number(m[3]) > 59)) return undefined
      const sec = m[3] !== undefined && m[3] !== '00' ? `:${m[3]}` : ''
      return `${String(h).padStart(2, '0')}:${m[2]}${sec}`
    }
    case 'status':
      return oneOf(v, MEAL_STATUSES) ?? undefined
    case 'note':
    case 'symptom':
      return typeof v === 'string' ? v : undefined
  }
  return undefined
}

/** 保存先から読んだ値（数値・文字列・null だけを受ける） */
function storedCellValue(v: unknown): CellValue | undefined {
  if (v === null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') return v
  return undefined
}

/** 行の指し方を RPC の p_key へ。読めなければ null */
function keyOfTarget(table: CellTable, target: VitalTarget | MealTarget): Record<string, string | number> | null {
  if (table === 'meals') {
    const t = target as MealTarget
    const resident = idNum(t.residentId)
    const slot = oneOf(t.slot, MEAL_SLOTS)
    if (resident === null || slot === null || typeof t.day !== 'string' || !CELL_DAY_RE.test(t.day)) return null
    return { resident_id: resident, meal_on: t.day, meal_slot: slot }
  }
  const t = target as VitalTarget
  if (t.routine) {
    const resident = idNum(t.residentId)
    if (resident === null || typeof t.day !== 'string' || !CELL_DAY_RE.test(t.day)) return null
    return { resident_id: resident, measured_on: t.day }
  }
  if ('id' in t) {
    const id = idNum(t.id)
    return id === null ? null : { id }
  }
  const resident = idNum(t.residentId)
  const kind = oneOf(t.kind, KEYLESS_KINDS)
  if (typeof t.clientKey !== 'string' || t.clientKey === '' || resident === null || kind === null) return null
  if (typeof t.day !== 'string' || !CELL_DAY_RE.test(t.day)) return null
  return { client_key: t.clientKey, resident_id: resident, measured_on: t.day, kind }
}

/** 保存先から読んだ p_key を検め直す（受信データを信じない）。読めなければ null */
function normalizeCellKey(table: CellTable, key: Record<string, unknown>): Record<string, string | number> | null {
  const id = idNum(key.id)
  if (Object.prototype.hasOwnProperty.call(key, 'id')) return id === null ? null : { id }
  if (table === 'meals') {
    return keyOfTarget('meals', {
      residentId: num(key.resident_id) ?? 0,
      day: str(key.meal_on) ?? '',
      slot: key.meal_slot as MealSlot,
    })
  }
  if (Object.prototype.hasOwnProperty.call(key, 'client_key')) {
    return keyOfTarget('vitals', {
      routine: false,
      clientKey: str(key.client_key) ?? '',
      residentId: num(key.resident_id) ?? 0,
      day: str(key.measured_on) ?? '',
      kind: key.kind as Exclude<VitalKind, 'routine'>,
    })
  }
  return keyOfTarget('vitals', { routine: true, residentId: num(key.resident_id) ?? 0, day: str(key.measured_on) ?? '' })
}

/** 血圧の上と下（組の欄）。片方だけを送る・消す・取り下げると、誰も測っていない組み合わせができる */
const BP_PAIR: Readonly<Record<string, string>> = { sys_bp: 'dia_bp', dia_bp: 'sys_bp' }

/**
 * 外す欄の集まりを、血圧の組でそろえる（#3・#9）。片方を外す時は相方も外す。ただし onlyVers（画面が見た版）が
 * あって相方がその版と違う（見た後に打ち直した）・見ていない時は、どちらも外さない（組を割らない）
 */
function pairDrop(e: CellEntry, drop: Set<string>, onlyVers?: Map<string, string>): Set<string> {
  const out = new Set(drop)
  for (const f of Object.keys(BP_PAIR)) {
    const o = BP_PAIR[f]
    if (!out.has(f) || out.has(o) || e.edits[o] === undefined) continue
    if (onlyVers === undefined || onlyVers.get(o) === e.edits[o].ver) out.add(o)
    else out.delete(f)
  }
  return out
}

/** 行キー（設計書: vitals@<利用者>|<日付>|routine ／ meals@<利用者>|<日付>|<食事枠> ／ vitals~<client_key> ／ vitals#<id>） */
function cellRowKey(table: CellTable, key: Record<string, string | number>): string {
  if (key.id !== undefined) return `${table}#${key.id}`
  if (table === 'meals') return `meals@${key.resident_id}|${key.meal_on}|${key.meal_slot}`
  if (key.client_key !== undefined) return `vitals~${key.client_key}`
  return `vitals@${key.resident_id}|${key.measured_on}|routine`
}

/** 保存先から読んだ1行を検め直す。読めない行は null（原文を brokenRaw に残す）・欄の無い行は 'empty' */
function normalizeCellEntry(raw: unknown): { rowKey: string; entry: CellEntry } | null | 'empty' {
  const r = asRecord(raw)
  if (r === null || !isCellTable(r.table)) return null
  const table = r.table
  const keyRec = asRecord(r.key)
  const key = keyRec === null ? null : normalizeCellKey(table, keyRec)
  const editsRec = asRecord(r.edits)
  if (key === null || editsRec === null) return null
  const fields = cellFieldsOf(table)
  const edits: Record<string, CellEdit> = {}
  for (const [f, ev] of Object.entries(editsRec)) {
    const e = asRecord(ev)
    if (!fields.includes(f) || e === null) return null
    const value = storedCellValue(e.value)
    const ver = str(e.ver)
    if (value === undefined || ver === null || ver === '') return null
    const edit: CellEdit = { value, at: num(e.at) ?? 0, ver }
    if (Object.prototype.hasOwnProperty.call(e, 'base')) {
      const b = storedCellValue(e.base)
      if (b === undefined) return null
      edit.base = b
    }
    edits[f] = edit
  }
  if (Object.keys(edits).length === 0) return 'empty'
  const fill: Record<string, CellValue> = {}
  const fillRec = asRecord(r.fill) ?? {}
  for (const k of CELL_FILL_KEYS[table]) {
    const v = storedCellValue(fillRec[k])
    if (v !== undefined && Object.prototype.hasOwnProperty.call(fillRec, k)) fill[k] = v
  }
  const entry: CellEntry = {
    table,
    key,
    edits,
    fill,
    editor: idNum(r.editor),
    state: oneOf(r.state, ['pending', 'conflict', 'rejected'] as const) ?? 'pending',
    tries: num(r.tries) ?? 0,
    nextAt: num(r.nextAt) ?? 0,
    tab: str(r.tab) ?? '',
    at: num(r.at) ?? 0,
  }
  const ck = str(r.clientKey)
  if (ck !== null && ck !== '') entry.clientKey = ck
  const rid = idNum(r.rowId)
  if (rid !== null) entry.rowId = rid
  if (r.bound === true) entry.bound = true
  if (r.bindChecked === true) entry.bindChecked = true
  if (Array.isArray(r.conflicts)) {
    const cs: CellConflict[] = []
    for (const c of r.conflicts) {
      const cr = asRecord(c)
      const field = str(cr?.field)
      const reason = oneOf(cr?.reason, ['changed', 'missing'] as const)
      if (cr === null || field === null || !fields.includes(field) || reason === null) continue
      cs.push({ field, server: cr.server ?? null, base: cr.base ?? null, mine: cr.mine ?? null, reason })
    }
    if (cs.length > 0) entry.conflicts = cs
  }
  return { rowKey: cellRowKey(table, key), entry }
}

/**
 * 旧形式（送信キューの op）の vitals / meals を、送信待ちの1行へ読み替える（1 op 分・裁定8）。
 *   insert → 基準は空（null）。定時の測定時刻・記入者は「空いていれば埋める」
 *   基準つきの update → その基準のまま／基準の無い update → 基準が分からない（キー無し）
 *   送信中に届いた書込（late）は payload に畳む／競合で止まった op → conflict／拒否で止まった op → rejected
 * 版は op の qid と欄から決める（同じ旧形式を2つのタブが読み替えても同じ版になり、二重にならない）。
 * 読み替えられない op（行を特定できない・送れない欄や値がある）は null（原文を brokenRaw に残す）
 */
function convertLegacyCellOp(r: Record<string, unknown>, verTag: string): { rowKey: string; entry: CellEntry } | null {
  const table = r.table
  const payload0 = asRecord(r.payload)
  if (!isCellTable(table) || payload0 === null || (r.kind !== 'insert' && r.kind !== 'update')) return null
  const isInsert = r.kind === 'insert'
  const at = num(r.at) ?? 0
  // 送信中に届いた書込（late）を畳む（insert の null は「未入力」なので重ねない）。late だけの欄は late の基準
  const late = asRecord(r.late)
  const payload: Record<string, unknown> = { ...payload0 }
  let bases = asRecord(r.bases)
  if (late !== null) {
    const lateBases = asRecord(r.lateBases)
    const merged: Record<string, unknown> = { ...(bases ?? {}) }
    for (const [k, v] of Object.entries(late)) {
      if (isInsert && v === null) continue
      if (!Object.prototype.hasOwnProperty.call(payload, k) && lateBases !== null && k in lateBases) merged[k] = lateBases[k]
      payload[k] = v
    }
    if (bases !== null || lateBases !== null) bases = merged
  }
  const fields = cellFieldsOf(table)
  // 行を特定する列・管理用の列（値としては送らない）
  const meta = new Set(['id', 'resident_id', 'measured_on', 'kind', 'meal_on', 'meal_slot', 'client_key', 'edited_by', 'recorded_by'])
  let key: Record<string, string | number> | null
  const fill: Record<string, CellValue> = {}
  let clientKey: string | undefined
  let timeIsFill = false
  if (isInsert) {
    if (table === 'meals') {
      key = keyOfTarget('meals', {
        residentId: num(payload.resident_id) ?? 0,
        day: str(payload.meal_on) ?? '',
        slot: payload.meal_slot as MealSlot,
      })
    } else if (payload.kind === 'routine') {
      key = keyOfTarget('vitals', { routine: true, residentId: num(payload.resident_id) ?? 0, day: str(payload.measured_on) ?? '' })
      timeIsFill = true // 定時の測定時刻は端末の時刻（自動）。食い違いを競合にしない
    } else {
      // 冪等キーの無い旧い退避は qid をキーにする（その op の再送は同じキーで1行に収まる）
      const ck = str(payload.client_key) || str(r.qid) || ''
      clientKey = ck
      key = keyOfTarget('vitals', {
        routine: false,
        clientKey: ck,
        residentId: num(payload.resident_id) ?? 0,
        day: str(payload.measured_on) ?? '',
        kind: payload.kind as Exclude<VitalKind, 'routine'>,
      })
    }
    const rec = idNum(payload.recorded_by)
    if (rec !== null) fill.recorded_by = rec
  } else {
    const rowId = idNum(r.rowId)
    key = rowId === null ? null : { id: rowId }
  }
  if (key === null) return null
  const edits: Record<string, CellEdit> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (meta.has(k)) continue
    if (timeIsFill && k === 'measured_at') {
      const t = cellValueOf(k, v)
      if (t === undefined) return null
      if (t !== null) fill.measured_at = t
      continue
    }
    if (!fields.includes(k)) {
      if (v === null && isInsert) continue // insert の未入力（送らない列の null）は値ではない
      return null // 送れない欄に値がある＝読み替えると黙って落とすことになる
    }
    const value = cellValueOf(k, v)
    if (value === undefined) return null
    if (isInsert && value === null) continue // insert の null は「未入力」であって「空にせよ」ではない
    // 版は op の qid・欄・値から決める（同じ旧形式を2つのタブが読み替えても同じ版＝二重にならない。値が変われば別の版＝F2）
    const edit: CellEdit = { value, at, ver: `v1.${verTag}.${k}.${valueTag(value)}` }
    if (isInsert) edit.base = null
    else if (bases !== null && Object.prototype.hasOwnProperty.call(bases, k)) {
      const b = cellValueOf(k, bases[k])
      if (b !== undefined) edit.base = b
    }
    edits[k] = edit
  }
  if (Object.keys(edits).length === 0) return null
  const entry: CellEntry = {
    table,
    key,
    edits,
    fill,
    editor: idNum(payload.edited_by),
    state: r.blocked === 'conflict' ? 'conflict' : r.blocked === 'rejected' ? 'rejected' : 'pending',
    tries: 0,
    nextAt: 0,
    tab: '',
    at,
  }
  if (clientKey !== undefined) entry.clientKey = clientKey
  return { rowKey: cellRowKey(table, key), entry }
}

/**
 * 同じ行の読み替えを重ねる（後の op を後から重ねる）。値は後勝ち・基準は先勝ち。
 * 止まった op が1つでもあれば、その行は止まったまま（conflict を rejected より優先）
 */
function mergeConverted(into: CellEntry, next: CellEntry): void {
  for (const [f, e] of Object.entries(next.edits)) {
    const cur = into.edits[f]
    if (cur === undefined) {
      into.edits[f] = e
      continue
    }
    const out: CellEdit = { value: e.value, at: e.at, ver: e.ver }
    if (Object.prototype.hasOwnProperty.call(cur, 'base')) out.base = cur.base
    into.edits[f] = out
  }
  for (const [k, v] of Object.entries(next.fill)) if (into.fill[k] === undefined || into.fill[k] === null) into.fill[k] = v
  if (next.editor !== null) into.editor = next.editor
  if (next.state === 'conflict' || (next.state === 'rejected' && into.state === 'pending')) into.state = next.state
  if (next.at > into.at) into.at = next.at
}

/** cl_sendQueue（HEAD の形）の中身 */
interface Store1 {
  legacy: QueueOp[]
  /** バイタル・食事の分（旧ビルドが積んだ op・途中の版が書いた rows）を送信待ちの行へ読み替えたもの */
  cells: Map<string, CellEntry>
  /**
   * cl_sendQueue2 へ移す分があった（読み替えられなかった分・HEAD の形でない中身を含む）。
   * この時は、cl_sendQueue2 に書けたと読み直して確かめるまで cl_sendQueue を書き換えない
   */
  migrating: boolean
  /** 読めなかった原文（cl_sendQueue の brokenRaw へ畳む） */
  dropped: string[]
  brokenRaw: string | null
}

/** cl_sendQueue2 の中身 */
interface Store2 {
  rows: Map<string, CellEntry>
  done: DoneMark[]
  /** 読めなかった原文（cl_sendQueue2 の brokenRaw へ畳む） */
  dropped: string[]
  brokenRaw: string | null
}

/**
 * cl_sendQueue の原文を読む（JSON として読めなければ例外）。HEAD の形（{ ops }・op の配列）と、途中の版が書いた形
 * （{ ver: 2, rows, legacyOps }）の両方を受ける。requireQid は parseQueueOps と同じ
 */
function parseStore1(raw: string, requireQid: boolean): Store1 {
  const parsed: unknown = JSON.parse(raw)
  const box = asRecord(parsed)
  const cells = new Map<string, CellEntry>()
  const dropped: string[] = []
  if (box !== null && box.ver === 2) {
    for (const v of Object.values(asRecord(box.rows) ?? {})) {
      const n = normalizeCellEntry(v)
      if (n === 'empty') continue // 欄の無い行（中身が無い）
      if (n === null) {
        dropped.push(rawOf(v))
        continue
      }
      const prev = cells.get(n.rowKey)
      if (prev === undefined) cells.set(n.rowKey, n.entry)
      else mergeConverted(prev, n.entry)
    }
    const legacy = parseQueueOps(box.legacyOps, requireQid)
    return { legacy: legacy.ops, cells, migrating: true, dropped: dropped.concat(legacy.dropped), brokenRaw: str(box.brokenRaw) }
  }
  // HEAD の形（op の配列／{ ops, brokenRaw, done }）。done（送り終えた・解決した op の印）の op は読み込まない
  const rawOps = box === null ? parsed : box.ops
  const done = new Set<string>()
  if (box !== null && Array.isArray(box.done)) {
    for (const t of box.done) {
      const q = str(asRecord(t)?.q)
      if (q !== null && q !== '') done.add(q)
    }
  }
  const legacyRaw: unknown[] = []
  const cellRaw: { r: Record<string, unknown>; i: number }[] = []
  if (Array.isArray(rawOps)) {
    rawOps.forEach((row, i) => {
      const r = asRecord(row)
      const qid = str(r?.qid)
      if (qid !== null && done.has(qid)) return
      if (r !== null && isCellTable(r.table) && (r.kind === 'insert' || r.kind === 'update')) cellRaw.push({ r, i })
      else legacyRaw.push(row)
    })
  }
  // 同じ行へ重ねる順は、退避した時刻の順（同時刻は並び順）
  cellRaw.sort((a, b) => (num(a.r.at) ?? 0) - (num(b.r.at) ?? 0) || a.i - b.i)
  for (const { r, i } of cellRaw) {
    const qid = str(r.qid)
    if (requireQid && qid === null) {
      dropped.push(rawOf(r))
      continue
    }
    const c = convertLegacyCellOp(r, qid ?? `n${i}`)
    if (c === null) {
      dropped.push(rawOf(r))
      continue
    }
    const prev = cells.get(c.rowKey)
    if (prev === undefined) cells.set(c.rowKey, c.entry)
    else mergeConverted(prev, c.entry)
  }
  const legacy = parseQueueOps(legacyRaw, requireQid)
  return {
    legacy: legacy.ops,
    cells,
    migrating: cellRaw.length > 0 || (box !== null && box.done !== undefined),
    dropped: dropped.concat(legacy.dropped),
    brokenRaw: str(box?.brokenRaw),
  }
}

/** cl_sendQueue2 の原文を読む（JSON として読めない・形が違えば例外） */
function parseStore2(raw: string): Store2 {
  const box = asRecord(JSON.parse(raw))
  if (box === null || box.ver !== 2) throw new Error('unknown shape')
  const rows = new Map<string, CellEntry>()
  const dropped: string[] = []
  for (const v of Object.values(asRecord(box.rows) ?? {})) {
    const n = normalizeCellEntry(v)
    if (n === 'empty') continue
    if (n === null) {
      dropped.push(rawOf(v))
      continue
    }
    const prev = rows.get(n.rowKey)
    if (prev === undefined) rows.set(n.rowKey, n.entry)
    else mergeConverted(prev, n.entry)
  }
  return { rows, done: normalizeDone(box.done), dropped, brokenRaw: str(box.brokenRaw) }
}

function getRaw(key: string): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(key)
    return raw === null || raw === '' ? null : raw
  } catch {
    return null
  }
}

/** 両方のキーを読む（読めない原文は、それぞれのキーの brokenRaw へ畳む） */
function readStores(): { s1: Store1 | null; s2: Store2 | null } {
  const r1 = getRaw(LS.sendQueue)
  const r2 = getRaw(LS.sendQueue2)
  let s1: Store1 | null = null
  let s2: Store2 | null = null
  if (r1 !== null) {
    try {
      s1 = parseStore1(r1, true)
      keepBroken(s1.dropped, 'queue')
      if (s1.brokenRaw !== null) keepBroken([s1.brokenRaw], 'queue')
    } catch {
      // 解釈できない値（別版・別タブが書いた原文）も消さずに持ち続ける（保全ゲート）
      keepBroken([r1], 'queue')
    }
  }
  if (r2 !== null) {
    try {
      s2 = parseStore2(r2)
      keepBroken(s2.dropped, 'cells')
      if (s2.brokenRaw !== null) keepBroken([s2.brokenRaw], 'cells')
    } catch {
      keepBroken([r2], 'cells')
    }
  }
  return { s1, s2 }
}

/** readStoresQuiet の直近の解析（原文が同じ間は使い回す。食事一覧は表示中の食事の数だけ pendingRow を呼ぶ） */
let quietCache: { key: string; s1: Store1 | null; s2: Store2 | null } | null = null

/** 両方のキーを読むだけ（件数・画面の重ね表示用。控え・メモリには触らない） */
function readStoresQuiet(): { s1: Store1 | null; s2: Store2 | null } {
  const r1 = getRaw(LS.sendQueue)
  const r2 = getRaw(LS.sendQueue2)
  const key = `${r1 ?? ''}\u0000${r2 ?? ''}`
  if (quietCache !== null && quietCache.key === key) return quietCache
  let s1: Store1 | null = null
  let s2: Store2 | null = null
  try {
    s1 = r1 === null ? null : parseStore1(r1, true)
  } catch {
    s1 = null
  }
  try {
    s2 = r2 === null ? null : parseStore2(r2)
  } catch {
    s2 = null
  }
  quietCache = { key, s1, s2 }
  return quietCache
}

/** 版を「タブの印」と「連番」に分ける（旧形式の読み替えの版など、連番の無い版は -1） */
function verParts(ver: string): { tab: string; seq: number } {
  const i = ver.lastIndexOf('.')
  const seq = i < 0 ? Number.NaN : Number(ver.slice(i + 1))
  return Number.isInteger(seq) ? { tab: ver.slice(0, i), seq } : { tab: ver, seq: -1 }
}

/**
 * 版の新しい方。同じタブの版は連番で決める（同じミリ秒に続けて記録しても、後の記録が必ず勝つ。
 * 文字列で比べると「.10」が「.9」より小さくなり、古い値・古い基準が残る）。別のタブの版は最後に値を受けた
 * 時刻、同時刻ならタブの印・連番で決める（どのタブでも同じ答え）
 */
function newerEdit(a: CellEdit, b: CellEdit): CellEdit {
  const pa = verParts(a.ver)
  const pb = verParts(b.ver)
  if (pa.tab === pb.tab && pa.seq >= 0 && pb.seq >= 0) return pa.seq > pb.seq ? a : b
  if (a.at !== b.at) return a.at > b.at ? a : b
  if (pa.tab !== pb.tab) return pa.tab > pb.tab ? a : b
  return pa.seq > pb.seq ? a : b
}

/**
 * 同じ行の2つの控え（m・s）を、欄単位で和集合にする（#5）。
 * ・両方にあって版が違う … 新しい方
 * ・片方だけ … 送信済みの記録（done）でその版か、同じ欄のより新しい版が済んでいれば外す。それ以外は残す
 *   （「保存先から消えていた」だけでは捨てない。読み違い・他の版の書き戻しで入力を失わない）
 * 行の状態・競合・付随の欄は、最後に書き換えた方（at が新しい方）を採る
 */
function mergeCellEntry(
  rowKey: string,
  m: CellEntry | undefined,
  s: CellEntry | undefined,
  idx: DoneIndex,
  superseded?: (rowKey: string, field: string, ed: CellEdit) => void,
): CellEntry | null {
  const edits: Record<string, CellEdit> = {}
  const names = new Set([...Object.keys(m?.edits ?? {}), ...Object.keys(s?.edits ?? {})])
  for (const f of names) {
    const me = m?.edits[f]
    const se = s?.edits[f]
    const pick = me !== undefined && se !== undefined ? (me.ver === se.ver ? me : newerEdit(me, se)) : (me ?? se)
    // 後の入力に置き換わった版は済んだ印を付ける（他のタブ・次の起動で古い値を復活させない。同じ端末の別タブは後勝ち）
    if (superseded !== undefined && me !== undefined && se !== undefined && me.ver !== se.ver) superseded(rowKey, f, pick === me ? se : me)
    if (pick !== undefined && !isDone(idx, rowKey, f, pick)) edits[f] = pick
  }
  if (Object.keys(edits).length === 0) return null
  const meta = s === undefined ? (m as CellEntry) : m === undefined ? s : s.at > m.at ? s : m
  const out: CellEntry = { ...meta, edits, fill: { ...(s?.fill ?? {}), ...(m?.fill ?? {}), ...meta.fill } }
  const rowId = meta.rowId ?? m?.rowId ?? s?.rowId
  if (rowId !== undefined) out.rowId = rowId
  if (m?.bound === true || s?.bound === true) out.bound = true
  if (m?.bindChecked === true || s?.bindChecked === true) out.bindChecked = true
  if (out.conflicts !== undefined) {
    const cs = out.conflicts.filter((c) => c.field in edits)
    if (cs.length > 0) out.conflicts = cs
    else delete out.conflicts
  }
  return out
}

function mergeCells(
  mem: Map<string, CellEntry>,
  stored: Map<string, CellEntry>,
  idx: DoneIndex,
  superseded?: (rowKey: string, field: string, ed: CellEdit) => void,
): Map<string, CellEntry> {
  const out = new Map<string, CellEntry>()
  for (const k of new Set([...mem.keys(), ...stored.keys()])) {
    const e = mergeCellEntry(k, mem.get(k), stored.get(k), idx, superseded)
    if (e !== null) out.set(k, e)
  }
  return out
}

/**
 * cl_sendQueue から読み替えた欄のうち、このタブにも cl_sendQueue2 にもまだ無い版（旧ビルドのタブが新しく積んだ・同じ op に
 * 重ねた値＝F2）は、いま観測した入力として扱う（値を受けた時刻をいまにする）。旧ビルドは op に値を重ねても時刻を進めない
 * ため、そのままだと先に読み替えた古い値と後先が決まらない。既に知っている版は時刻を変えない
 */
function stampFresh(cells: Map<string, CellEntry>, known: Map<string, CellEntry>[]): Map<string, CellEntry> {
  const now = Date.now()
  const out = new Map<string, CellEntry>()
  for (const [k, e] of cells) {
    let copy: CellEntry | null = null
    for (const [f, ed] of Object.entries(e.edits)) {
      if (known.some((rows) => rows.get(k)?.edits[f]?.ver === ed.ver)) continue
      // 既に知っている同じ欄の版より必ず後にする（同じミリ秒でも後先が決まるように）
      const knownAt = Math.max(0, ...known.map((rows) => rows.get(k)?.edits[f]?.at ?? 0))
      if (copy === null) copy = { ...e, edits: { ...e.edits } }
      copy.edits[f] = { ...ed, at: Math.max(ed.at, now, knownAt + 1) }
    }
    out.set(k, copy ?? e)
  }
  return out
}

/** 保存先にある送信待ちの行（cl_sendQueue2 の rows と、cl_sendQueue にまだ残っているバイタル・食事の分） */
function storedCells(
  s1: Store1 | null,
  s2: Store2 | null,
  idx: DoneIndex,
  superseded?: (rowKey: string, field: string, ed: CellEdit) => void,
): Map<string, CellEntry> {
  const a = s2?.rows ?? new Map<string, CellEntry>()
  if (s1 === null || s1.cells.size === 0) return a
  return mergeCells(a, stampFresh(s1.cells, [cellRows, a]), idx, superseded)
}

/** メモリ＋保存先（読むだけ）。画面へ渡す送信待ち・競合の一覧はここから作る */
function currentCellRows(): Map<string, CellEntry> {
  const { s1, s2 } = readStoresQuiet()
  if (s1 === null && s2 === null) return cellRows
  const idx = doneIndexOf(s2 === null ? doneMarks : unionDone(doneMarks, s2.done))
  return mergeCells(cellRows, storedCells(s1, s2, idx), idx)
}

/** 保存先を読み直した和集合（書込ロックの中から呼ぶ）。後の入力に置き換わった版に済んだ印を付ける */
function mergeFromStores(s1: Store1 | null, s2: Store2 | null): Map<string, CellEntry> {
  const idx = doneIndexOf(doneMarks)
  const marks: [string, string, CellEdit][] = []
  const note = (k: string, f: string, ed: CellEdit): void => {
    marks.push([k, f, ed])
  }
  const merged = mergeCells(cellRows, storedCells(s1, s2, idx, note), idx, note)
  for (const [k, f, ed] of marks) markDone(k, f, ed)
  if (marks.length === 0) return merged
  // 印を付けた版を落として、もう一度そろえる（同じ版が別の行に残っていても外す）
  const idx2 = doneIndexOf(doneMarks)
  return mergeCells(merged, new Map(), idx2)
}

function loadQueue(): void {
  if (typeof localStorage === 'undefined') return
  const r2 = getRaw(LS.sendQueue2)
  if (r2 !== null) {
    try {
      const s2 = parseStore2(r2)
      cellRows = s2.rows
      doneMarks = unionDone([], s2.done)
      keepBroken(s2.dropped, 'cells')
      if (s2.brokenRaw !== null) keepBroken([s2.brokenRaw], 'cells')
    } catch {
      keepBroken([r2], 'cells')
    }
  }
  const r1 = getRaw(LS.sendQueue)
  if (r1 !== null) {
    try {
      const s1 = parseStore1(r1, false)
      queue = s1.legacy
      if (s1.cells.size > 0) cellRows = mergeCells(cellRows, stampFresh(s1.cells, [cellRows]), doneIndexOf(doneMarks))
      // 正規化できなかった行も消さない（設定画面の「読み取れませんでした」に乗せて残す）
      keepBroken(s1.dropped, 'queue')
      // 前に解釈できなかった原文。消さずに持ち続け「未送信データあり」を出し続ける
      if (s1.brokenRaw !== null) keepBroken([s1.brokenRaw], 'queue')
      // バイタル・食事の分を cl_sendQueue2 へ移す（書けたと確かめてから cl_sendQueue から外す＝消さない）
      if (s1.migrating) convertedOnLoad = true
    } catch {
      // 壊れた値は解釈できないが、消さない。原文を控え、次の書き込みで同じキーの
      // brokenRaw として一緒に書き戻す（multi-device-sync 原則8: 消去は保全ゲートの後ろ）
      keepBroken([r1], 'queue')
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
 * 書き戻す退避 op（水分・申し送り等）の一覧。localStorage を読み直し、他タブが退避した op を qid で
 * 和集合にしてから返す（HEAD と同じ）。全置換で書くと、同じ端末で2つ目のタブを開いた時に相手の未送信 op を
 * 消してしまう。取り込んだ他タブの op はこのタブのメモリ（queue）には入れない。入れると同じ op を2タブが
 * 同時に送って二重登録になるため、保持だけして送信は元のタブ（または次回起動）に任せる。
 * このタブの op は、保存先から消えていても捨てない（送り終えたと観測した sentQids だけを外す）
 */
function mergeLegacyForPersist(stored: QueueOp[] | null): QueueOp[] {
  if (stored === null) return queue
  const mine = new Set(queue.map((o) => o.qid))
  // 送信できたことを観測した op は復活させない（他タブの古い控えからの二重送信を防ぐ）
  const others = stored.filter((o) => !mine.has(o.qid) && !sentQids.has(o.qid))
  return others.length === 0 ? queue : queue.concat(others)
}

/**
 * 書き戻す（書込ロックの中からだけ呼ぶ＝persistQueueLocked・withWriteLock）。
 * 両方のキーを読み直し、バイタル・食事は欄単位（送信済みの記録で照合）、退避 op は qid で和集合にしてから書く。
 * 順番: cl_sendQueue2 を書いて読み直しで確かめる → cl_sendQueue を書く。cl_sendQueue にバイタル・食事の分
 * （移す分）があった時は、cl_sendQueue2 を確かめられなければ cl_sendQueue を書き換えない（移す前に外さない）。
 * このタブのメモリも和集合の結果にそろえる（他のタブの入力も、このタブが送れる）
 */
function persistUnderLock(): void {
  const { s1, s2 } = readStores()
  if (s2 !== null) doneMarks = unionDone(doneMarks, s2.done)
  else doneMarks = unionDone(doneMarks, [])
  cellRows = mergeFromStores(s1, s2)
  const ops = mergeLegacyForPersist(s1?.legacy ?? null)
  if (typeof localStorage === 'undefined') {
    queuePersisted = false
    notifyQueue()
    return
  }
  let ok2 = false
  try {
    const out2: Record<string, unknown> = { ver: 2, rows: Object.fromEntries(cellRows), done: doneMarks }
    if (cellBrokenRaw !== null) out2.brokenRaw = cellBrokenRaw
    const json2 = JSON.stringify(out2)
    localStorage.setItem(LS.sendQueue2, json2)
    ok2 = localStorage.getItem(LS.sendQueue2) === json2 // 読み直して確かめる（書けたつもりで外さない）
  } catch {
    ok2 = false
  }
  let ok1 = false
  if (ok2 || s1 === null || !s1.migrating) {
    try {
      // HEAD と同じ形（{ ops, brokenRaw }）。解釈できなかった原文も同じキーの中に持つ
      // （1回の setItem なので「キューは書けたが原文が消えた」という中途半端な状態を作らない）
      const out1: Record<string, unknown> = { ops }
      if (queueBrokenRaw !== null) out1.brokenRaw = queueBrokenRaw
      localStorage.setItem(LS.sendQueue, JSON.stringify(out1))
      ok1 = true
      if (legacyBrokenPending) {
        // 現行キーへ書けたことを観測できたので、旧キーを取り除く（消去は保全ゲートの後ろ）
        localStorage.removeItem(LEGACY_BROKEN_KEY)
        legacyBrokenPending = false
      }
    } catch {
      ok1 = false
    }
  }
  if (ok1 && ok2) convertedOnLoad = false
  // 保存できなくてもメモリ上のキューは維持する（この起動中は再送できる）
  queuePersisted = ok1 && ok2
  notifyQueue()
}

/** 書き戻しを同じ端末の他のタブと順番にする Web Locks の名前（裁定9） */
const WRITE_LOCK = 'cl_sendQueue_write'

/** Web Locks（使えない環境は null） */
function webLocks(): LockManager | null {
  const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { locks?: LockManager })
  const locks = nav?.locks
  return locks && typeof locks.request === 'function' ? locks : null
}

/**
 * 読み直し→和集合→書き戻しを、同じ端末の他のタブの書き戻しと重ならないように包む（裁定9・#5）。
 * navigator.locks が無い環境（古い WebView 等）はそのまま動かす（従来どおり）
 */
async function withWriteLock<T>(run: () => T | Promise<T>): Promise<T> {
  const locks = webLocks()
  if (locks === null) return run()
  return (await locks.request(WRITE_LOCK, async () => run())) as T
}

/** 書き戻す（書込ロックの中で）。書き戻しは必ずここか withWriteLock の中の persistUnderLock を通す */
async function persistQueueLocked(): Promise<void> {
  await withWriteLock(() => persistUnderLock())
}

/** 保存先を読み直して、他のタブの入力・送り終えた行をメモリへ取り込む（書き戻さない。書込ロックの中で呼ぶ） */
function refreshCells(): void {
  const { s1, s2 } = readStores()
  if (s2 !== null) doneMarks = unionDone(doneMarks, s2.done)
  cellRows = mergeFromStores(s1, s2)
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
 * 未送信件数（自動再送を止めた分も「未送信」として数える）。
 * 退避 op は1件ずつ、バイタル・食事は1行ずつ数える。同じ端末の別タブが退避した分も数える
 * （メモリと localStorage の和集合）。数えないと、2つ目のタブでは「未送信 0件」と表示されたまま
 * 送られていない記録が残る。数えるだけで localStorage は書き換えない。
 */
export function queuePending(): number {
  const ids = new Set<string>()
  const { s1 } = readStoresQuiet()
  if (s1 !== null) for (const op of s1.legacy) if (!sentQids.has(op.qid)) ids.add(`op:${op.qid}`)
  for (const op of queue) ids.add(`op:${op.qid}`)
  for (const k of currentCellRows().keys()) ids.add(`row:${k}`)
  return ids.size
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

/**
 * 退避を積む時に渡す形（管理項目はここで採番・付与する）。
 * Omit を union へ直接掛けると共通の項目しか残らない（rowId / rev が落ちる）ので、
 * 形ごとに掛けてから union にする。
 */
type Pending<T> = Omit<T, 'qid' | 'at' | 'tries' | 'nextAt'>
type PendingOp =
  | Pending<RowQueueOp>
  | Pending<ReadQueueOp>
  | Pending<AttendanceQueueOp>
  | Pending<AliasQueueOp>

/**
 * 同じ行を指す退避済みの op（統合先）。無ければ null。
 * 分けて積むと、先の op が成功して rev が進んだ瞬間に後の op が必ず競合して送れなくなるため、
 * 1行につき1件へまとめる（multi-device-sync 原則3: 部分更新／原則5: 無言消失を作らない）。
 * 自動再送を止めた op（blocked）は裁定待ちなので統合先にしない。
 * 送信中の op（sending）も統合先にしない。リクエストは差し替え前のペイロードで既に出ており、
 * 応答が 'sent' になると op ごと消えるため、重ねた入力が観測されないまま消える（原則6・8）。
 *
 * 追加した種別（既読・出勤者・表示名）も同じ対象を指す op を1件にまとめる
 * ・既読 … 同じ（申し送り, 職員）は重複させない（何度押しても1件）
 * ・表示名 … 同じ利用者なら後勝ちで1件
 * ・出勤者 … 同じ日なら後勝ちで1件（古いスナップショットを積み残さない）
 * insert（水分・申し送り・外出）は自然キーを持たない＝1タップ＝1行なので統合しない
 */
function findMergeTarget(op: PendingOp): QueueOp | null {
  for (const q of queue) {
    if (q.blocked !== undefined || q.sending === true) continue
    if (q.table !== op.table || q.kind !== op.kind) continue
    if (op.kind === 'update') {
      if (q.kind === 'update' && q.rowId !== undefined && q.rowId === op.rowId) return q
      continue
    }
    if (op.kind === 'read') {
      if (q.kind !== 'read') continue
      const note = idNum(op.payload.note_id)
      const staff = idNum(op.payload.staff_id)
      if (note === null || staff === null) continue
      if (idNum(q.payload.note_id) === note && idNum(q.payload.staff_id) === staff) return q
      continue
    }
    if (op.kind === 'alias') {
      if (q.kind !== 'alias') continue
      const id = idNum(op.payload.id)
      if (id !== null && idNum(q.payload.id) === id) return q
      continue
    }
    if (op.kind === 'attendance') {
      if (q.kind !== 'attendance') continue
      const day = dateStr(op.payload.day)
      if (day !== null && dateStr(q.payload.day) === day) return q
      continue
    }
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

/**
 * 出勤者の baseline（この端末が観測していた行）を重ねる。
 * 後勝ちで差し替えると、先に外した職員が baseline から抜けて再送時に非表示にできず、
 * 「外したはずの人」が次の取り直しで無言のうちに戻る（原則5: 無言消失を作らない）。
 * baseline は「観測した行の集合」なので、和集合が本来の意味と一致する。
 */
function mergeBaseline(a: unknown, b: unknown): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const src of [a, b]) {
    if (!Array.isArray(src)) continue
    for (const v of src) {
      const id = idNum(v)
      if (id === null || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

async function enqueue(op: PendingOp): Promise<Queued> {
  const target = findMergeTarget(op)
  if (target !== null) {
    const prevPayload = target.payload
    // rev は「最初に観測した値」を保つ（統合先の op はまだ1度もサーバーへ載っていない）
    target.payload = mergePayload(target.payload, op.payload, op.kind)
    // 出勤者だけは baseline を後勝ちにしない（統合前の取り消しを取りこぼさない）
    if (op.kind === 'attendance') {
      target.payload.baseline = mergeBaseline(prevPayload.baseline, op.payload.baseline)
    }
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
  // 書込ロックの中で「読み直し → 和集合 → 書き戻し」（#5。他のタブの書き戻しと重ねない）
  await persistQueueLocked()
  armRetryTimer() // 電波が戻った合図が来なくても、待ち時間が明けたら送り直す（I7）
  return QUEUED
}

function backoff(tries: number): number {
  return Math.min(RETRY_BASE_MS * Math.pow(2, Math.max(0, tries - 1)), RETRY_MAX_MS)
}

// ── 送信（退避 op と、バイタル・食事の送信待ち） ─────────────────────────────

/** 保存の直後に送る時、別のタブの送信が終わるのを待つ上限（ms）。過ぎたら送信待ちとして返す */
const SEND_LOCK_WAIT_MS = 10_000

/** 走っている送信の後ろ（同じタブの送信は1本ずつ順に動かす） */
let flushTail: Promise<void> = Promise.resolve()
/** まだ動き出していない送信（その間に頼まれた送信は、ここへまとめる） */
let pendingFlush: { force: boolean; waitMs: number; run: Promise<void> } | null = null

/**
 * 退避してある書込を送り直す。サーバーに載ったことを観測できた分だけキューから消す。
 * 競合（rev 不一致・他の端末が変えた欄）・サーバー拒否が続く分は消さずに残し、未送信件数として表示し続ける。
 *
 * force=true は「再ログイン直後」「電波が戻った」「設定画面で職員が明示的に再送を指示した」場合に使う。
 * 直前の失敗で待ち時間（最大30分）が残っていても無視して送る。
 * これを尊重すると「再ログインすると自動で送信されます」「今すぐ再送する」の案内が
 * 実挙動と食い違い、職員が指示しても1件も送られない状態になるため。
 */
export async function flushQueue(force = false): Promise<void> {
  await scheduleFlush(force, 0)
}

/**
 * 送信を1本ずつ順に動かす（同じタブで2本同時に送らない）。まだ動き出していない送信があれば、
 * そこへまとめる（保存が続いても送信は1回で済む）。waitMs は他のタブの送信を待つ上限
 */
function scheduleFlush(force: boolean, waitMs: number): Promise<void> {
  if (pendingFlush !== null) {
    pendingFlush.force = pendingFlush.force || force
    pendingFlush.waitMs = Math.max(pendingFlush.waitMs, waitMs)
    return pendingFlush.run
  }
  const slot = { force, waitMs, run: Promise.resolve() }
  slot.run = flushTail
    .then(async () => {
      if (pendingFlush === slot) pendingFlush = null
      await runFlush(slot.force, slot.waitMs)
    })
    .catch(() => undefined)
  pendingFlush = slot
  flushTail = slot.run
  return slot.run
}

async function runFlush(force: boolean, waitMs: number): Promise<void> {
  if (!isSupabaseConfigured()) return
  if (queue.length === 0 && !hasCellWork()) return
  try {
    await withSendLock(async () => {
      const sb = await getClient()
      // 他のタブが積んだ行・送り終えた行を取り込んでから送る（別タブの和集合）
      await persistQueueLocked()
      // 止まった行 id の行を、読み取りだけで自然キーへ付け替える（F1。画面から見えるようにする）
      await bindStoppedIdRows(sb)
      await sendDueCells(sb, force)
      await sendDueOps(sb, force)
    }, waitMs)
  } catch {
    // 接続先未設定・クライアント初期化失敗・ロックを取れなかった。キューはそのまま保持する
  } finally {
    await persistQueueLocked()
    armRetryTimer()
  }
}

/** バイタル・食事の送信待ちがあるか（このタブのメモリか、同じ端末の他のタブの控え） */
function hasCellWork(): boolean {
  if (cellRows.size > 0) return true
  return currentCellRows().size > 0
}

/** 端末が「つながっていない」と分かっている時（navigator.onLine=false）。分からない環境では false */
function knownOffline(): boolean {
  return typeof navigator !== 'undefined' && (navigator as { onLine?: boolean }).onLine === false
}

/** 待ち時間が明けたら自動で送り直すタイマー（I7）。1本だけ持ち、張り直す時は前のを外す */
interface TimerApi {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}
const realTimer: TimerApi = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms)
    // Node（テスト）ではタイマーが残ってもプロセスの終了を妨げない
    ;(h as unknown as { unref?: () => void }).unref?.()
    return h
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}
let timerApi: TimerApi = realTimer
let retryTimer: unknown = null
let retryDueAt = 0

/**
 * 次に送り直す時刻に1本だけタイマーを張る。待ち時間の付いた書込はその時刻、退避したばかりでまだ一度も
 * 再送していない書込は退避から RETRY_BASE_MS 後（電波が戻った合図が来ないまま、つながっている場合の備え）
 */
function armRetryTimer(): void {
  const now = Date.now()
  let next = Number.POSITIVE_INFINITY
  const consider = (nextAt: number, at: number): void => {
    const due = nextAt > 0 ? nextAt : at + RETRY_BASE_MS
    if (due > now && due < next) next = due
  }
  for (const op of queue) if (op.blocked === undefined) consider(op.nextAt, op.at)
  for (const e of cellRows.values()) if (e.state === 'pending') consider(e.nextAt, e.at)
  if (retryTimer !== null && retryDueAt === next) return // 同じ時刻に張ってある（重複して張らない）
  if (retryTimer !== null) {
    timerApi.clear(retryTimer)
    retryTimer = null
    retryDueAt = 0
  }
  if (next === Number.POSITIVE_INFINITY) return
  retryDueAt = next
  retryTimer = timerApi.set(() => {
    retryTimer = null
    retryDueAt = 0
    // つながっていない間は試みない（待ち時間を延ばさない）。電波が戻れば online で送る
    if (knownOffline()) return
    void flushQueue()
  }, Math.max(0, next - now) + 50)
}

/**
 * 送信の主体を1タブに絞る（Web Locks）。同じ端末で2つのタブを開いていると、起動時に
 * 双方が同じ未送信 op を取り込み、同時に送って二重登録になるため。
 * waitMs=0 … ロックを取れないタブはこの回は送らない（相手のタブが送る／次の機会に送る）
 * waitMs>0 … 保存の直後に送る時。相手のタブの送信が終わるのを waitMs まで待つ（過ぎたら送らない）
 * navigator.locks が無い環境（古い WebView 等）は従来どおりそのまま送る。送ったら true
 */
async function withSendLock(run: () => Promise<void>, waitMs = 0): Promise<boolean> {
  const locks = webLocks()
  if (locks === null) {
    await run()
    return true
  }
  if (waitMs <= 0) {
    let ran = false
    await locks.request(SEND_LOCK, { ifAvailable: true }, async (lock) => {
      if (lock === null) return // 別のタブが送信中。ここでは送らない（未送信のまま残す＝消さない）
      ran = true
      await run()
    })
    return ran
  }
  const ctrl = typeof AbortController === 'undefined' ? null : new AbortController()
  const timer = ctrl === null ? null : setTimeout(() => ctrl.abort(), waitMs)
  try {
    await locks.request(SEND_LOCK, ctrl === null ? {} : { signal: ctrl.signal }, async () => {
      if (timer !== null) clearTimeout(timer)
      await run()
    })
    return true
  } catch (e) {
    if ((e as { name?: unknown } | null)?.name === 'AbortError') return false // 待ちきれなかった（送信待ちのまま）
    throw e
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 期限の来た退避 op を順に送る（HEAD の送信ループ。ロックの内側でだけ動かす） */
async function sendDueOps(sb: SupabaseClient, force: boolean): Promise<void> {
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
  // 退避ぶんの再送も「自分の書込」。更新は rev + 1 になることが分かっている
  if (op.kind === 'update' && op.rowId !== undefined && op.rev !== undefined) {
    markSelfRow(op.table, { id: op.rowId }, op.rev + 1)
  }

  // 業務表の insert / update とは書き方が違う種別を先に振り分ける（以降 op は業務表の op）
  if (op.kind === 'read') return sendQueuedRead(sb, op)
  if (op.kind === 'attendance') return sendQueuedAttendance(sb, op)
  if (op.kind === 'alias') return sendQueuedAlias(sb, op)

  const cols = colsOf(op.table)
  if (op.kind === 'insert') {
    const res = (await sb.from(op.table).insert(op.payload).select(cols).maybeSingle()) as Res<unknown>
    if (res.error === null) {
      markSelfRow(op.table, res.data, num(asRecord(res.data)?.rev)) // 版が確定した
      return 'sent'
    }
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
    }
    return 'rejected'
  }

  // 退避した update は、退避した時点の操作者を edited_by として持っている（列が無い DB では外して送る）。
  // 旧版が退避した op で edited_by が無ければ null を足す（操作者が分からない書き換え）
  const res = await sendWithEditor(
    withEditorNull(op.payload),
    async (p) =>
      (await sb
        .from(op.table)
        .update(p)
        .eq('id', op.rowId as number)
        .eq('rev', op.rev as number)
        .is('deleted_at', null)
        .select(cols)
        .maybeSingle()) as Res<unknown>,
  )
  if (res.error !== null) {
    if (isAuthFail(res)) {
      fireAuthExpired()
      return 'retry'
    }
    return isTransient(res) ? 'retry' : 'rejected'
  }
  return res.data === null ? 'conflict' : 'sent'
}

/**
 * 退避してあった既読を送る。23505（他の経路で既に既読になっていた）は成功と同じ扱い。
 * note_reads は rev も deleted_at も持たない表なので、insert 1文だけで完結する。
 */
async function sendQueuedRead(sb: SupabaseClient, op: ReadQueueOp): Promise<SendResult> {
  const noteId = idNum(op.payload.note_id)
  const staffId = idNum(op.payload.staff_id)
  if (noteId === null || staffId === null) return 'rejected' // 送り先を特定できない
  const res = (await sb
    .from('note_reads')
    .insert({ note_id: noteId, staff_id: staffId })
    .select('note_id')
    .maybeSingle()) as Res<unknown>
  if (res.error === null) return 'sent'
  if (isUniqueViolation(res)) return 'sent' // 既に既読＝目的は達している
  if (isAuthFail(res)) {
    fireAuthExpired()
    return 'retry'
  }
  return isTransient(res) ? 'retry' : 'rejected'
}

/**
 * 退避してあった出勤者の登録を送る。**退避した一覧をそのまま流し込まない**——
 * 送信時にサーバーの現況を読み直し、saveAttendance と同じ差分計算をやり直す。
 * そうしないと、オフラインの間に他端末が足した出勤者を古いスナップショットで消してしまう
 * （multi-device-sync 原則5: 無言消失の禁止）。非表示にしてよいのは baseline の職員だけ。
 */
async function sendQueuedAttendance(sb: SupabaseClient, op: AttendanceQueueOp): Promise<SendResult> {
  const day = dateStr(op.payload.day)
  // rows が配列として読めない退避は「全員取り消し」に化けうるので送らない（消える側へ倒さない）
  if (day === null || !Array.isArray(op.payload.rows)) return 'rejected'
  const rows = op.payload.rows as { staff_id: number; role: Attendance['role']; sort: number }[]
  const baseline: number[] = []
  if (Array.isArray(op.payload.baseline)) {
    for (const id of op.payload.baseline) {
      const staffId = idNum(id)
      if (staffId !== null) baseline.push(staffId)
    }
  }
  try {
    await applyAttendance(sb, day, rows, baseline)
    return 'sent'
  } catch (e) {
    if (e instanceof DbError) return e.kind === 'network' || e.kind === 'auth' ? 'retry' : 'rejected'
    return 'rejected'
  }
}

/**
 * 退避してあった「申し送りでの表示名」を送る。書くのは note_alias の1列だけ（rev 照合なし）。
 * 対象の利用者が居なくなっていた場合（0行）も送信自体は受理されているので 'sent' にする
 * ——再送しても永久に0行のままで、未送信として数え続ける意味が無いため。
 */
async function sendQueuedAlias(sb: SupabaseClient, op: AliasQueueOp): Promise<SendResult> {
  const id = idNum(op.payload.id)
  if (id === null) return 'rejected'
  // 文字列（設定する）と null（設定を外す）だけを送る。読めない値を null として送ると
  // 付けてあった表示名を無言で消してしまうため、その退避は送らない（原則4・5）
  const raw = op.payload.note_alias
  if (raw !== null && typeof raw !== 'string') return 'rejected'
  const alias = str(raw)
  const res = (await sb
    .from('residents')
    .update({ note_alias: alias })
    .eq('id', id)
    .select('id')
    .maybeSingle()) as Res<unknown>
  if (res.error === null) return 'sent'
  if (isAuthFail(res)) {
    fireAuthExpired()
    return 'retry'
  }
  return isTransient(res) ? 'retry' : 'rejected'
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
 * 端末生成の冪等キー（client_key）。自然キーを持たない表（申し送り・水分・外出）で
 * 「23505 = この端末が送った行が既に載っている」ことを確かめるために使う。
 */
function clientKeyOf(payload: Record<string, unknown>): Record<string, unknown> | null {
  const k = str(payload.client_key)
  return k === null || k === '' ? null : { client_key: k }
}

/**
 * 冪等キーで既存行を1件だけ読み直す（23505 の時に「届いているか」を確かめるため）。
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

/** undefined の項目は送らない（部分更新＝送らない列はサーバーの値を温存する。null は「空にせよ」の明示） */
function cleanPayload(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) if (v !== undefined) out[k] = v
  return out
}

/**
 * 自然キーを持たない insert（申し送り・水分・外出）に、端末生成の冪等キーを付ける。
 * 同じ入力を再送しても DB 側の unique 制約で1行に収束する（2タブ・再送の行き違いでの二重登録防止）。
 */
function withClientKey(src: Record<string, unknown>): Record<string, unknown> {
  const out = cleanPayload(src)
  out.client_key = newQid()
  return out
}

/**
 * くらべて選ぶ画面の〔両方残す〕が使う冪等キー。その競合1件ごとに同じ値を返す
 * （開き直して2回押しても、DB の unique 制約で1行に収まる）。
 */
export function newClientKey(): string {
  return newQid()
}

/** 電波が戻った時の再送（online イベント）。待ち時間が残っていても送る（送信キューの規約 I7） */
export function onNetworkBack(): void {
  void flushQueue(true)
}

// 電波復帰・画面復帰で自動再送する（ui-design §6.5「電波復帰で自動再送」）
if (typeof window !== 'undefined') {
  loadQueue()
  // 旧キーに退避が残っていた・cl_sendQueue から cl_sendQueue2 へ移す分があった場合だけ、書き戻す
  // （書込ロックの中で。cl_sendQueue2 に書けたと確かめた後に cl_sendQueue から外す）
  if (legacyBrokenPending || convertedOnLoad) void persistQueueLocked()
  // 電波が戻った: 待ち時間（backoff）が残っていても送る（I7。通信断の間に積んだ分を、次の画面復帰まで待たせない）
  window.addEventListener('online', onNetworkBack)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushQueue()
  })
}

// ── 入力解禁フラグ（並走期間の封鎖・ui-design §0.5 の二重ガード） ────────────

let gateValue: boolean | null = null // 未観測 = null
let gateFetchedAt = 0

const TRUE_WORDS = new Set(['true', '1', 'on', 'yes', 'enabled'])

/**
 * 走っている取得（同時に呼ばれた分をまとめる）。
 * 画面を開くと App と画面自身が同じ瞬間にこのフラグを取りに行き、同じ値を2回引いていた
 * （2026-09-05 実測。入力画面の出入りごとに app_settings が2要求）。
 * **古い値を配るのではなく、走っている1回の結果を共有する**だけなので、
 * 「前提情報は参照するその時点で実測する」規範はそのまま守られる。
 */
let gateInFlight: Promise<boolean | null> | null = null

async function refreshGate(): Promise<boolean | null> {
  if (gateInFlight !== null) return gateInFlight
  const run = (async (): Promise<boolean | null> => {
    try {
      const raw = await getAppSetting('native_input_enabled')
      const v = raw !== null && TRUE_WORDS.has(raw.trim().toLowerCase())
      gateValue = v
      gateFetchedAt = Date.now()
      return v
    } catch {
      return null // 直近の観測値（gateValue）は消さない
    } finally {
      gateInFlight = null
    }
  })()
  gateInFlight = run
  return run
}

// ── RPC apply_cell_edits（0011）が当たっているか（バイタル・食事の保存の前提） ────
//
// 関数の無い DB（PGRST202 / 42883）では旧経路へ落とさない（裁定5）。入力解禁フラグの確認と同時に確かめ、
// 無ければバイタル・食事の入力を「サーバー側の更新待ち」として止める（申し送り・水分・外出は止めない）。

/** null＝まだ確かめていない・確かめられなかった */
let cellRpcState: 'ready' | 'missing' | null = null
let cellRpcCheckedAt = 0
let cellProbeInFlight: Promise<'ready' | 'missing' | null> | null = null

function markCellRpc(state: 'ready' | 'missing'): void {
  cellRpcState = state
  cellRpcCheckedAt = Date.now()
}

/** 関数が無い（PostgREST のスキーマキャッシュに無い／Postgres の undefined_function） */
function isMissingRpc(res: Res<unknown>): boolean {
  const code = errCode(res)
  return code === 'PGRST202' || code === '42883'
}

/** 関数の有無を問い合わせる（p_table='probe'。何も書かない）。同時に呼ばれた分は1回にまとめる */
async function probeCellRpc(): Promise<'ready' | 'missing' | null> {
  if (cellProbeInFlight !== null) return cellProbeInFlight
  const run = (async (): Promise<'ready' | 'missing' | null> => {
    try {
      const sb = await getClient()
      const res = (await sb.rpc('apply_cell_edits', { p_table: 'probe', p_key: {}, p_edits: {} })) as Res<unknown>
      if (res.error !== null) {
        if (!isMissingRpc(res)) return null // 通信できない等＝確かめられなかった
        markCellRpc('missing')
        return 'missing'
      }
      // 応答の形が違う＝同じ名前の別の関数（版が合わない）。使わない
      const state = asRecord(res.data)?.status === 'probe' ? 'ready' : 'missing'
      markCellRpc(state)
      return state
    } catch {
      return null
    } finally {
      cellProbeInFlight = null
    }
  })()
  cellProbeInFlight = run
  return run
}

/** 入力解禁の確認と一緒に使う。直近に「使える」を観測していれば問い合わせない */
async function cellRpcForGate(): Promise<'ready' | 'missing' | 'unknown'> {
  if (cellRpcState === 'ready' && Date.now() - cellRpcCheckedAt < GATE_TTL_MS) return 'ready'
  const c = await probeCellRpc()
  if (c !== null) return c
  return cellRpcState ?? 'unknown' // 確かめられなかった。この起動中に観測した値があればそれを使う
}

/** 入力解禁フラグと、バイタル・食事の保存の前提（0011）の確認結果 */
export interface NativeInputGate {
  value: boolean
  observed: boolean
  /**
   * バイタル・食事の保存に使う RPC（0011）: ready＝使える／missing＝サーバー側の更新待ち
   * （バイタル・食事の入力を止めて理由を出す）／unknown＝確かめられない（通信エラー）
   */
  cells: 'ready' | 'missing' | 'unknown'
}

/**
 * app_settings.native_input_enabled と「サーバーの値を観測できたか」。
 * observed=false は「入力できるかどうかが分からない」状態で、封鎖（＝スプシ期間）とは別物。
 * 画面はこの2つを区別し、observed=false では封鎖理由ではなく通信エラーと再試行を出す
 * （multi-device-sync 原則5: 観測できていないことを断定しない）。
 * 同時に 0011 の有無も確かめる（cells）。申し送り・水分・外出の入力は cells に関係なく value で決める。
 */
export async function getNativeInputGate(): Promise<NativeInputGate> {
  const [v, cells] = await Promise.all([refreshGate(), cellRpcForGate()])
  if (v !== null) return { value: v, observed: true, cells }
  // 取り直せなかった。この起動中に一度でも観測できていれば、その値を使う（観測済み扱い）
  if (gateValue !== null) return { value: gateValue, observed: true, cells }
  return { value: false, observed: false, cells }
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

/**
 * バイタル・食事の書込の入口ガード。入力解禁に加えて、0011 が当たっていない DB では
 * 「サーバー側の更新待ち」で止める（旧経路へ落とさない）。確かめられない（通信できない）時は止めない
 * （送信待ちに積む。送る時に関数が無ければ、消さずに待ち続ける）
 */
async function assertCellWritable(): Promise<void> {
  await assertWritable()
  const fresh = Date.now() - cellRpcCheckedAt < GATE_TTL_MS
  if (cellRpcState === 'ready') {
    if (!fresh) void probeCellRpc() // 観測済み。期限切れなら背景で取り直し、この書込は待たせない
    return
  }
  if (cellRpcState === 'missing' && fresh) throw new DbError('blocked', MSG.cellsPending)
  if ((await probeCellRpc()) === 'missing') throw new DbError('blocked', MSG.cellsPending)
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

/**
 * 利用者スナップショット（**退居された方も含む全員**・居室昇順）。
 * 申し送りでの表示名の重複判定に使う。退居された方の氏名は過去の記録に残り続けるので、
 * その名前と同じ表示名を付けられてしまうと取り違えのもとになる＝突き合わせ相手に含める。
 */
export async function fetchAllResidents(): Promise<Resident[]> {
  const sb = await getClient()
  const res = (await sb
    .from('residents')
    .select(RESIDENT_COLS)
    .order('room', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .limit(MAX_ROWS)) as Res<unknown>
  if (res.error !== null) throw readError(res)
  return list(res.data, normalizeResident)
}

/**
 * 申し送りでの表示名を設定する（null＝設定を外してマスタの氏名に戻す）。
 *
 * ・この列**だけ**を書く（他の列に触れない＝マスタ同期と喧嘩しない。原則12の専用書き込み分離）
 * ・空文字は保存しない。呼ぶ側が types.ts の validateNoteAlias を通してから渡すこと
 * ・入力解禁フラグでは止めない。記録ではなく表示の設定で、並走中こそ整えておく必要があるため
 * ・通信できない・ログインが切れている時は永続キューへ退避して 'queued' を返す
 *   （同じ利用者の退避は後勝ちで1件にまとまる＝古い名前が後から復活しない）
 */
export async function setResidentNoteAlias(id: number, alias: string | null): Promise<Resident | Queued> {
  const sb = await getClient()
  const trimmed = alias === null ? null : alias.trim()
  const value = trimmed === '' ? null : trimmed
  const res = (await sb
    .from('residents')
    .update({ note_alias: value })
    .eq('id', id)
    .select(RESIDENT_COLS)
    .maybeSingle()) as Res<unknown>
  if (res.error !== null) {
    const payload = { id, note_alias: value }
    if (isAuthFail(res)) {
      fireAuthExpired()
      return enqueue({ table: 'residents', kind: 'alias', payload })
    }
    if (isTransient(res)) return enqueue({ table: 'residents', kind: 'alias', payload })
    throw writeError(res)
  }
  const row = normalizeResident(res.data)
  if (row === null) throw new DbError('server', MSG.broken)
  return row
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
 * ilike 用のパターンを作る。LIKE メタ文字（% _ \）だけを無効化し、% で挟んで返す。
 * 二重引用符では包まない: supabase-js は値を丸ごと URL エンコードして単一フィルタ値として
 * 送るため、引用符を付けるとそれ自体がパターンの一部になり全件不一致になる
 * （2026-08-28 実機で確認。予約文字の引用が要るのは in.(...) 等のリスト値だけ）。
 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
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

// ── 最後にこの行を書き換えた職員（edited_by） ────────────────────────────────
//
// 0010_record_history.sql で業務5表に edited_by を足し、更新のたびにサーバー側のトリガが
// 旧値・新値を record_history へ残す。edited_by はその「誰が変えたか」の欄に写される。
//
// 操作者は actor.ts の仕組み（App が resolveActor で名簿と照合した操作者）をそのまま使う。
// App が操作者の確定・切替のたびに setEditor で渡す。
//
// ★列がある DB では、更新のたびに**必ず** edited_by を送る（操作者が分からない時は null）。
//   トリガは new.edited_by を「変えた職員」に写すので、送らない更新では前に触った人の値が残り、
//   別の人が変更の記録に「操作者」として出てしまうため（2026-09-23 再審 指摘4）。
//   キュー経路・23505 からの載せ直し・soft delete も同じ。取込（tools/import.mjs）も null を明示する。
//
// 後方互換: 0010 を当てる前の DB には列が無い。列が無いエラー（PGRST204 / 42703）を受けたら
// その起動中は edited_by を付けずに1回だけ送り直し、以後は付けない（保存を失敗させない）。

/** 操作者の staff_id（App が setEditor で渡す。null＝分からない＝edited_by に null を送る） */
let editorId: number | null = null
/** この起動中に「edited_by 列が無い」ことを観測したか（true の間は付けない） */
let editedByUnsupported = false

/**
 * 更新系で edited_by として送る操作者を設定する。App が操作者の確定・切替のたびに呼ぶ。
 * 渡すのは名簿と照合済みの操作者（resolveActor の結果）。null・不正値は「分からない」（null を送る）。
 */
export function setEditor(id: number | null): void {
  editorId = idNum(id)
}

/**
 * 更新系の任意の指定。記入者を記録ごとに選ぶ画面（申し送りフォームの登録直後の「元に戻す」など）は、
 * 選んだ記入者を editedBy で渡す。省略・null・不正値の時は端末の既定の操作者（setEditor）を使う。
 */
export interface WriteOpts {
  editedBy?: number | null
}

/**
 * edited_by を必ず足した patch を返す（元の patch は変えない）。操作者が分からない時は null。
 * 列が無い DB（0010 未適用）と分かった後は足さない（後方互換）。
 */
function withEditor(patch: Record<string, unknown>, editedBy?: number | null): Record<string, unknown> {
  if (editedByUnsupported) return patch
  return { ...patch, edited_by: idNum(editedBy) ?? editorId }
}

/** 退避してあった書込に edited_by が無ければ null を足す（旧版が退避した op・退避した insert の載せ直し） */
function withEditorNull(payload: Record<string, unknown>): Record<string, unknown> {
  if (editedByUnsupported || Object.prototype.hasOwnProperty.call(payload, 'edited_by')) return payload
  return { ...payload, edited_by: null }
}

/** 列が無いエラー（PostgREST のスキーマキャッシュに無い／Postgres の undefined_column） */
function isMissingColumn(res: Res<unknown>): boolean {
  const code = errCode(res)
  return code === 'PGRST204' || code === '42703'
}

/**
 * edited_by を含みうる update を送る。列が無いと分かったら edited_by を外して1回だけ送り直し、
 * この起動中は以後付けない。退避済みの op（edited_by 入り）もここを通すので、同じく外して送る。
 */
async function sendWithEditor(
  patch: Record<string, unknown>,
  run: (p: Record<string, unknown>) => PromiseLike<Res<unknown>>,
): Promise<Res<unknown>> {
  const first = editedByUnsupported ? omitKeys(patch, ['edited_by']) : patch
  const res = await run(first)
  if (res.error !== null && 'edited_by' in first && isMissingColumn(res)) {
    editedByUnsupported = true
    return run(omitKeys(first, ['edited_by']))
  }
  return res
}

// ── 書込（insert / update / soft delete） ────────────────────────────────────
// 水分・申し送り・外出の書込（HEAD の送り方＋edited_by）。バイタル・食事は下の「バイタル・食事の保存」。

async function insertRow<T>(
  table: LegacyTable,
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
      // 自然キーを持たない表は冪等キーでしか 23505 にならない。万一来た時は従来どおりの例外
      throw new DbError('server', MSG.raceInsert)
    }
    throw new DbError('server', serverMsg('保存でき', errCode(res)))
  }
  markSelfRow(table, res.data, num(asRecord(res.data)?.rev)) // 版が確定した
  const row = normalize(res.data)
  if (row === null) throw new DbError('server', MSG.broken)
  return row
}

async function updateRow<T>(
  table: LegacyTable,
  id: number,
  rev: number,
  patch: Record<string, unknown>,
  normalize: (row: unknown) => T | null,
  opts?: WriteOpts,
): Promise<T | Conflict | Queued> {
  await assertWritable()
  if (Object.keys(patch).length === 0) throw new DbError('server', MSG.emptyPatch)
  const sb = await getClient()
  // edited_by を必ず添える（分からない時は null。退避する時も添えたまま＝触った人を後から取り違えない）
  const sent = withEditor(patch, opts?.editedBy)
  // 自分の更新は rev + 1 になる。応答を待たずに覚えてよい（版で限定するので他端末の変更は落ちない）
  markSelfRow(table, { id }, rev + 1)
  const res = await sendWithEditor(
    sent,
    async (p) =>
      (await sb
        .from(table)
        .update(p)
        .eq('id', id)
        .eq('rev', rev)
        .is('deleted_at', null)
        .select(colsOf(table))
        .maybeSingle()) as Res<unknown>,
  )

  if (res.error !== null) {
    if (isAuthFail(res)) {
      fireAuthExpired()
      return enqueue({ table, kind: 'update', payload: sent, rowId: id, rev })
    }
    if (isTransient(res)) return enqueue({ table, kind: 'update', payload: sent, rowId: id, rev })
    throw new DbError('server', serverMsg('保存でき', errCode(res)))
  }
  if (res.data === null) return CONFLICT // 0行 = 他端末が先に更新（または削除済み）
  const row = normalize(res.data)
  if (row === null) throw new DbError('server', MSG.broken)
  return row
}

/**
 * rev 照合つきの部分更新（削除・帰着記入・継続終了など、最新の rev が要る操作）。
 * 通信できない・ログインが切れている時は永続キューへ退避して 'queued' を返す（電波が戻れば自動で送る）。
 * 退避しても rev は観測した値のまま送るので、その間に他端末が同じ行を更新していれば競合として
 * キューに残る＝古い値で無言に上書きしない（multi-device-sync 原則5・6）。
 */
async function updateNow<T>(
  table: LegacyTable,
  id: number,
  rev: number,
  patch: Record<string, unknown>,
  normalize: (row: unknown) => T | null,
  opts?: WriteOpts,
): Promise<T | Conflict | Queued> {
  await assertWritable()
  const sb = await getClient()
  const sent = withEditor(patch, opts?.editedBy) // edited_by を必ず添える（分からない時は null。退避にも添えたまま）
  // 自分の更新は rev + 1 になる。応答を待たずに覚えてよい（版で限定するので他端末の変更は落ちない）
  markSelfRow(table, { id }, rev + 1)
  const res = await sendWithEditor(
    sent,
    async (p) =>
      (await sb
        .from(table)
        .update(p)
        .eq('id', id)
        .eq('rev', rev)
        .is('deleted_at', null)
        .select(colsOf(table))
        .maybeSingle()) as Res<unknown>,
  )
  if (res.error !== null) {
    if (isAuthFail(res)) {
      fireAuthExpired()
      return enqueue({ table, kind: 'update', payload: sent, rowId: id, rev })
    }
    if (isTransient(res)) return enqueue({ table, kind: 'update', payload: sent, rowId: id, rev })
    throw writeError(res)
  }
  if (res.data === null) return CONFLICT
  const row = normalize(res.data)
  if (row === null) throw new DbError('server', MSG.broken)
  return row
}

/**
 * soft delete（物理削除はしない）。rev 照合で 0行 なら competing 更新＝conflict。
 * 通信できない・ログインが切れている時は deleted_at を書く update として退避する（'queued'）。
 */
async function softDelete(
  table: LegacyTable,
  id: number,
  rev: number,
  opts?: WriteOpts,
): Promise<true | Conflict | Queued> {
  await assertWritable()
  const sb = await getClient()
  // edited_by を必ず添える（誰が消したかを変更の記録に残す。分からない時は null。退避にも添えたまま）
  const payload = withEditor({ deleted_at: new Date().toISOString() }, opts?.editedBy)
  markSelfRow(table, { id }, rev + 1)
  const res = await sendWithEditor(
    payload,
    async (p) =>
      (await sb
        .from(table)
        .update(p)
        .eq('id', id)
        .eq('rev', rev)
        .is('deleted_at', null)
        .select('id')
        .maybeSingle()) as Res<unknown>,
  )
  if (res.error !== null) {
    if (isAuthFail(res)) {
      fireAuthExpired()
      return enqueue({ table, kind: 'update', payload, rowId: id, rev })
    }
    if (isTransient(res)) return enqueue({ table, kind: 'update', payload, rowId: id, rev })
    throw writeError(res)
  }
  return res.data === null ? CONFLICT : true
}

// ── バイタル・食事の保存（送信待ち pending store → RPC apply_cell_edits） ──────────
//
// 経路は1本（裁定3）: 欄の編集を送信待ちへ書く（値は後勝ち・基準は先勝ち）→ 書き戻す → すぐ送る →
// その行の結果を待つ。オンラインなら {status, row, applied, settled, conflicts}、通信できなければ 'queued'。
// 判定（いまの値＝あなたの値なら済み／基準のままなら書く／それ以外は競合）は 0011 が行ロックの下で行う。
// 端末は送る前に判定しない（判定と書込の間の時間差を作らない）。
// 関数が当たっていない DB（PGRST202/42883）では旧経路へ落とさない（入力を止めて「サーバー側の更新待ち」）。

/**
 * saveVitalEdits / saveMealEdits に渡す1欄。rowSync の FieldEdit をそのまま渡せる。
 * base はサーバーが返した生の値（表示用に整えた値を渡さない）。base が無い・読めない＝基準が分からない
 */
export type CellEditInput<F extends string> = Partial<Record<F, { value: unknown; base?: unknown }>>

export interface CellSaveOpts {
  /** 空いていれば埋める付随の欄（新しい行の測定時刻・記入者）。判定には使わない */
  fill?: { measured_at?: string | null; recorded_by?: number | null }
  /** edited_by として送る職員。省略・null・不正値は端末の既定の操作者（setEditor） */
  editedBy?: number | null
  /**
   * 〔くらべて選ぶ〕で「いまの値」を見てから選んだ送信。基準を先勝ちにせず渡した基準へ置き換え、
   * 止まっている行（conflict）も送る状態へ戻す
   */
  rebase?: boolean
  /**
   * この保存と同時に、同じ行の送信待ちから取り下げる欄（欄 → 画面が見た版）。食事の〔両方残す〕で、主食・副食・状態の
   * 「あなたの入力」をメモの追記へ置き換える時に使う（#8）。保存が送信待ちに確保された・書けた時だけ取り下げを確定し、
   * 拒否・競合の時は取り下げた欄と、この保存で書いた欄を元に戻す
   */
  dropVers?: Record<string, string>
  /**
   * 〔新しい行として保存〕（第4段 F4）。同じ行の送信待ちの全ての欄を「空欄を見て書いた」（基準 null）に置き換えて送る。
   * 空にする欄（値 null）は新しい行では意味が無いので外す。基準の残った欄があると、行が無いサーバーは何度送っても
   * 「行が無い」で戻すため。rebase も兼ねる（止まった行を送る状態へ戻す）
   */
  asNew?: boolean
}

/** saveVitalEdits / saveMealEdits の結果（オンラインで送れた時） */
export interface CellSaveResult<T> {
  status: 'applied' | 'partial' | 'conflict' | 'noop'
  /** いまの行（行が無い＝取り消された・作らなかった時は null） */
  row: T | null
  /** 書けた欄 */
  applied: string[]
  /** もう同じ値が載っていた欄 */
  settled: string[]
  /** 書かなかった欄（他の端末が変えていた・行が無い）。送信待ちに「競合」として残る */
  conflicts: CellConflict[]
  /** 競合で止まっている行へまとめた（送っていない）。〔くらべて選ぶ〕で選ぶまで送らない */
  held?: boolean
}

/** サーバーの応答（受信データを信じない＝parseCellResult で検める） */
interface CellResult {
  status: 'applied' | 'partial' | 'conflict' | 'noop'
  row: Record<string, unknown> | null
  applied: string[]
  settled: string[]
  conflicts: CellConflict[]
}

/** 送った行の結果。seq＝その送信が含んでいた記録の番号（それ以前の記録はこの結果に含まれている） */
type CellOutcome =
  | { seq: number; kind: 'result'; result: CellResult }
  | { seq: number; kind: 'queued' }
  | { seq: number; kind: 'rejected'; code: string }

/** 欄を送信待ちへ書いた回数（送信がどの記録まで含んでいたかの見分けに使う） */
let cellRecordSeq = 0
/** 行キー → 直近の送信の結果（保存の呼び出しが自分の結果を受け取るのに使う） */
const cellOutcomes = new Map<string, CellOutcome>()

const CELL_STATUSES = ['applied', 'partial', 'conflict', 'noop'] as const
const CELL_REASONS = ['changed', 'missing'] as const

function parseCellResult(table: CellTable, data: unknown): CellResult | null {
  const r = asRecord(data)
  if (r === null || r.version !== 1) return null
  const status = oneOf(r.status, CELL_STATUSES)
  if (status === null) return null
  const fields = cellFieldsOf(table)
  const names = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && fields.includes(x)) : []
  const conflicts: CellConflict[] = []
  if (Array.isArray(r.conflicts)) {
    for (const c of r.conflicts) {
      const cr = asRecord(c)
      const field = str(cr?.field)
      const reason = oneOf(cr?.reason, CELL_REASONS)
      if (cr === null || field === null || !fields.includes(field) || reason === null) continue
      conflicts.push({ field, server: cr.server ?? null, base: cr.base ?? null, mine: cr.mine ?? null, reason })
    }
  }
  return { status, row: asRecord(r.row), applied: names(r.applied), settled: names(r.settled), conflicts }
}

/** 期限の来たバイタル・食事の行を、古い入力の順に1行ずつ送る（行ごとに独立。つながらなければ打ち切る） */
async function sendDueCells(sb: SupabaseClient, force: boolean): Promise<void> {
  const now = Date.now()
  const oldest = (e: CellEntry): number => Math.min(...Object.values(e.edits).map((x) => x.at))
  const due = [...cellRows.entries()]
    .filter(([, e]) => e.state === 'pending' && (force || e.nextAt <= now))
    .sort((a, b) => oldest(a[1]) - oldest(b[1]))
    .map(([k]) => k)
  for (const rowKey of due) {
    if ((await sendCellRow(sb, rowKey)) === 'offline') break
  }
}

/** 1行を送る。通信できなかったら 'offline'（この回の送信を打ち切る） */
async function sendCellRow(sb: SupabaseClient, firstKey: string): Promise<'ok' | 'offline'> {
  let rowKey = firstKey
  let e = cellRows.get(rowKey)
  if (e === undefined || e.state !== 'pending') return 'ok'
  if (e.key.id !== undefined && (e.table === 'meals' || e.bound !== true)) {
    const bound = await bindIdKey(sb, rowKey, e)
    if (bound === 'offline') return 'offline'
    if (bound === null) return 'ok'
    rowKey = bound
    e = cellRows.get(rowKey)
    if (e === undefined || e.state !== 'pending') return 'ok'
  }
  const seq = cellRecordSeq
  const sent = new Map<string, CellEdit>()
  const pEdits: Record<string, unknown> = {}
  for (const [f, ed] of Object.entries(e.edits)) {
    sent.set(f, ed)
    pEdits[f] = Object.prototype.hasOwnProperty.call(ed, 'base') ? { value: ed.value, base: ed.base } : { value: ed.value }
  }
  const table = e.table
  const res = (await sb.rpc('apply_cell_edits', {
    p_table: table,
    p_key: e.key,
    p_edits: pEdits,
    p_fill: e.fill,
    p_editor: e.editor,
    p_client_key: e.clientKey ?? null,
  })) as Res<unknown>
  const cur = cellRows.get(rowKey)
  if (res.error !== null) {
    const retry = (): 'offline' => {
      if (cur !== undefined) {
        cur.tries += 1
        cur.nextAt = Date.now() + backoff(cur.tries)
      }
      cellOutcomes.set(rowKey, { seq, kind: 'queued' })
      return 'offline'
    }
    if (isAuthFail(res)) {
      fireAuthExpired()
      return retry()
    }
    if (isTransient(res)) return retry()
    // 関数がまだ無い: 旧経路へ落とさず、消さずに待つ（入力は「サーバー側の更新待ち」で止まる）
    if (isMissingRpc(res)) {
      markCellRpc('missing')
      return retry()
    }
    // サーバーに拒否された（型にできない値・範囲外など）。新しい入力が来るまで送らない（控えは残す）
    if (cur !== undefined) {
      cur.state = 'rejected'
      cur.tries += 1
      cur.at = Date.now()
    }
    cellOutcomes.set(rowKey, { seq, kind: 'rejected', code: errCode(res) })
    await persistQueueLocked()
    return 'ok'
  }
  const result = parseCellResult(table, res.data)
  if (result === null) {
    // 応答を読めない（書けたかどうか分からない）。消さずに送り直す（書けていれば次は「済み」になる）
    if (cur !== undefined) {
      cur.tries += 1
      cur.nextAt = Date.now() + backoff(cur.tries)
      if (cur.tries >= MAX_TRIES) cur.state = 'rejected'
    }
    cellOutcomes.set(rowKey, { seq, kind: 'queued' })
    return 'ok'
  }
  markCellRpc('ready')
  // 書けた＝この版の変更通知は自分が出したもの（書かなかった時の版は他の端末の変更なので覚えない）
  if (result.applied.length > 0 && result.row !== null) markSelfRow(table, result.row, num(result.row.rev))
  applyCellResponse(rowKey, sent, result)
  cellOutcomes.set(rowKey, { seq, kind: 'result', result })
  await persistQueueLocked()
  return 'ok'
}

/**
 * 応答を送信待ちへ当てる。書けた欄・もう載っていた欄は、送った時と版が同じ時だけ消す。
 * 送信中に同じ欄を打ち直していたら、その欄は残して基準を「いまサーバーにある値（送って載った値）」へ持ち直す
 * （持ち直さないと、次の送信で自分が載せた値と競合する）。書かなかった欄は残し、行を conflict にする
 */
function applyCellResponse(rowKey: string, sent: Map<string, CellEdit>, result: CellResult): void {
  const e = cellRows.get(rowKey)
  if (e === undefined) return
  // 冪等キーで作った行は、応答で分かった行 id を覚える（画面が行 id で指しても、この行を指す＝#6）
  if (e.clientKey !== undefined && result.row !== null) {
    const id = idNum(result.row.id)
    if (id !== null) e.rowId = id
  }
  // 血圧の組: 相方が競合なのに、片方が「書けた・載っていた」で返っても消さない（組を割らない＝#3。旧いサーバーへの備え）
  const conflictNames = new Set(result.conflicts.map((c) => c.field))
  const heldPair = new Set<string>()
  for (const f of Object.keys(BP_PAIR)) {
    if (conflictNames.has(BP_PAIR[f]) && !conflictNames.has(f) && e.edits[f] !== undefined) heldPair.add(f)
  }
  for (const f of [...result.applied, ...result.settled]) {
    if (heldPair.has(f)) continue
    const cur = e.edits[f]
    const was = sent.get(f)
    if (cur === undefined || was === undefined) continue
    markDone(rowKey, f, was)
    if (cur.ver === was.ver) {
      delete e.edits[f]
    } else {
      const srv = result.row === null ? undefined : cellValueOf(f, result.row[f])
      e.edits[f] = { ...cur, base: srv === undefined ? was.value : srv }
    }
  }
  const conflicts = result.conflicts.filter((c) => c.field in e.edits)
  for (const f of heldPair) {
    const ed = e.edits[f]
    conflicts.push({ field: f, server: result.row?.[f] ?? null, base: ed.base ?? null, mine: ed.value, reason: 'changed' })
  }
  if (conflicts.length > 0) {
    e.conflicts = conflicts
    e.state = 'conflict'
  } else {
    delete e.conflicts
    e.state = 'pending'
  }
  e.tries = 0
  e.nextAt = 0
  e.at = Date.now()
  if (Object.keys(e.edits).length === 0) cellRows.delete(rowKey)
}

/**
 * 旧形式の読み替えで行 id しか分からない行を、送る直前に1行読んで自然キーへ付け替える（付け替えた行キーを返す）。
 *   食事 … 利用者・日付・食事枠（0011 は食事の id 指定を受けない）
 *   バイタルの定時 … 利用者・日付（#2。一覧・一括は定時を自然キーで指すので、行 id のままだと画面から見えない）
 *   バイタルの定時以外（発熱者・他症状者・再検）… 行 id のまま（日報・一覧も行 id で指す）。確かめた印だけ付ける
 * 行が見当たらない（取り消された）時は、全欄を「行が無い」競合として止める（null）
 */
async function bindIdKey(
  sb: SupabaseClient,
  rowKey: string,
  e: CellEntry,
  opts?: { readOnly?: boolean },
): Promise<string | 'offline' | null> {
  const readOnly = opts?.readOnly === true
  const isMeal = e.table === 'meals'
  const res = (await sb
    .from(e.table)
    .select(isMeal ? 'id,resident_id,meal_on,meal_slot' : 'id,resident_id,measured_on,kind')
    .eq('id', e.key.id as number)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()) as Res<unknown>
  if (res.error !== null) {
    if (isAuthFail(res)) fireAuthExpired()
    if (isAuthFail(res) || isTransient(res)) {
      if (!readOnly) {
        e.tries += 1
        e.nextAt = Date.now() + backoff(e.tries)
      }
      return 'offline'
    }
    if (readOnly) {
      // 止まった行の付け替え（F1）: 読めなかった。行 id のまま残し、状態は変えない（次からは読まない）
      e.bindChecked = true
      await persistQueueLocked()
      return null
    }
    e.state = 'rejected'
    e.tries += 1
    await persistQueueLocked()
    return null
  }
  const r = asRecord(res.data)
  if (r !== null && !isMeal && r.kind !== 'routine') {
    // 定時以外は行 id のまま送る（日報・一覧も行 id で指すので見える）。次からは読まない
    e.bound = true
    await persistQueueLocked()
    return rowKey
  }
  const key =
    r === null
      ? null
      : isMeal
        ? keyOfTarget('meals', {
            residentId: num(r.resident_id) ?? 0,
            day: dateStr(r.meal_on) ?? '',
            slot: r.meal_slot as MealSlot,
          })
        : keyOfTarget('vitals', { routine: true, residentId: num(r.resident_id) ?? 0, day: dateStr(r.measured_on) ?? '' })
  if (key === null && readOnly) {
    // 止まった行の付け替え（F1）: 行が取り消されていた。行 id のまま残し（未送信に数え続ける）、次からは読まない
    e.bindChecked = true
    await persistQueueLocked()
    return null
  }
  if (key === null) {
    e.state = 'conflict'
    e.conflicts = Object.entries(e.edits).map(([field, ed]) => ({
      field,
      server: null,
      base: ed.base ?? null,
      mine: ed.value,
      reason: 'missing' as const,
    }))
    e.at = Date.now()
    await persistQueueLocked()
    return null
  }
  const nextKey = cellRowKey(e.table, key)
  // 付け替えた欄は新しい版にする（古い行キーの版は済んだ印を付けて、保存先・他のタブ・旧形式の読み替えから復活させない）
  const now = Date.now()
  const target = cellRows.get(nextKey)
  const moved: CellEntry = { ...e, key, edits: {}, at: now, tab: tabId }
  delete moved.bound
  for (const [f, ed] of Object.entries(e.edits)) {
    markDone(rowKey, f, ed)
    const next: CellEdit = { ...ed, ver: newCellVer() }
    const cur = target?.edits[f]
    if (cur === undefined) {
      moved.edits[f] = next
      continue
    }
    // 同じ欄が両方にある: 値は新しい方、基準は古い方（先勝ち）
    const newer = cur.at >= next.at ? cur : next
    const older = newer === cur ? next : cur
    const merged: CellEdit = { value: newer.value, at: newer.at, ver: newer === cur ? cur.ver : next.ver }
    if (Object.prototype.hasOwnProperty.call(older, 'base')) merged.base = older.base
    moved.edits[f] = merged
  }
  cellRows.delete(rowKey)
  if (target === undefined) cellRows.set(nextKey, moved)
  else {
    // 同じ行に送信待ちが既にあった: 止まった方の状態を残す（競合＞拒否＞送信待ち。止まった値を黙って送らない）
    const rank = (x: CellState): number => (x === 'conflict' ? 2 : x === 'rejected' ? 1 : 0)
    const state = rank(moved.state) >= rank(target.state) ? moved.state : target.state
    const edits = { ...target.edits, ...moved.edits }
    const conflicts = [...(target.conflicts ?? []), ...(moved.conflicts ?? [])].filter((c, i, all) => c.field in edits && all.findIndex((x) => x.field === c.field) === i)
    const merged: CellEntry = { ...target, edits, state, at: now }
    if (conflicts.length > 0) merged.conflicts = conflicts
    else delete merged.conflicts
    cellRows.set(nextKey, merged)
  }
  await persistQueueLocked()
  return nextKey
}

/**
 * 止まった（競合・拒否）行 id の行を、読み取りだけで自然キーへ付け替える（第4段 F1。書込はしない）。
 * 旧ビルドで止まった食事・定時バイタルの op は、読み替えると行 id のまま残り、送られないので送る前の付け替えも走らず、
 * どの画面にも出なかった。付け替えると画面の pendingRow から競合・拒否として見え、〔くらべて選ぶ〕で解決できる。
 * 行が取り消されている・読めない時は行 id のまま残す（消さない・未送信に数え続ける）。通信できなければ次の送信の時にもう一度
 */
async function bindStoppedIdRows(sb: SupabaseClient): Promise<void> {
  for (const [rowKey, e] of [...cellRows.entries()]) {
    if (e.state === 'pending' || e.key.id === undefined || e.bindChecked === true) continue
    if (e.table === 'vitals' && e.bound === true) continue
    if ((await bindIdKey(sb, rowKey, e, { readOnly: true })) === 'offline') break
  }
}

/**
 * 行 id で指した行の、冪等キーで作った同じ行の控え（#6）。1つの記録の行キーは作られた時の形（vitals~ck）のまま
 * 変えないので、画面が行 id で指しても、見る・送る・取り下げるのはこの控え。無ければ null
 */
function aliasRowKey(table: CellTable, key: Record<string, string | number>, rows: Map<string, CellEntry>): string | null {
  if (table !== 'vitals' || typeof key.id !== 'number') return null
  for (const [k, e] of rows) if (e.clientKey !== undefined && e.rowId === key.id) return k
  return null
}

/** この保存の中身（内部用。この保存で書いた欄とその版を持つ） */
interface CellSaveInternal {
  rowKey: string
  /** この保存で書いた欄 → 版 */
  vers: Map<string, string>
  outcome:
    | { kind: 'result'; result: CellResult; held: boolean }
    | { kind: 'queued' }
    | { kind: 'rejected'; code: string }
}

async function saveCellEditsInternal(
  table: CellTable,
  target: VitalTarget | MealTarget,
  sendEdits: CellEditInput<string>,
  opts?: CellSaveOpts,
): Promise<CellSaveInternal> {
  await assertCellWritable()
  const key0 = keyOfTarget(table, target)
  if (key0 === null) throw new DbError('server', MSG.broken)
  let key: Record<string, string | number> = key0
  let rowKey = cellRowKey(table, key)
  // 値を先に検める（読めない値は送信待ちへ入れない）。送る値は列の精度にそろえる
  const fields = cellFieldsOf(table)
  const asNew = opts?.asNew === true
  const incoming: { f: string; value: CellValue; base?: CellValue }[] = []
  for (const [f, ed] of Object.entries(sendEdits)) {
    if (ed === undefined) continue
    const value = fields.includes(f) ? cellValueOf(f, ed.value) : undefined
    if (value === undefined) throw new DbError('server', MSG.broken)
    // 新しい行として保存: 空にする欄は送らない・基準は空（F4）
    if (asNew && value === null) continue
    const item: { f: string; value: CellValue; base?: CellValue } = asNew ? { f, value, base: null } : { f, value }
    // 基準が無い・読めない（rowSync の「基準不明」の印を含む）時は、基準を持たない＝サーバーは空の時だけ書く
    if (!asNew && Object.prototype.hasOwnProperty.call(ed, 'base') && ed.base !== undefined && typeof ed.base !== 'symbol') {
      const b = cellValueOf(f, ed.base)
      if (b !== undefined) item.base = b
    }
    incoming.push(item)
  }
  if (incoming.length === 0) throw new DbError('server', MSG.emptyPatch)
  const fill: Record<string, CellValue> = {}
  const fillSrc = (opts?.fill ?? {}) as Record<string, unknown>
  for (const k of CELL_FILL_KEYS[table]) {
    const v = k === 'recorded_by' ? idNum(fillSrc[k]) : cellValueOf(k, fillSrc[k])
    if (v !== null && v !== undefined) fill[k] = v
  }
  const editor = idNum(opts?.editedBy) ?? editorId
  const clientKey = typeof key.client_key === 'string' ? key.client_key : undefined
  const vers = new Map<string, string>()
  let mySeq = 0
  let held = false
  /** dropVers で取り下げた欄（元に戻すため）と、この保存で重ねる前の欄・状態 */
  const dropped = new Map<string, CellEdit>()
  const before = new Map<string, CellEdit | undefined>()
  let beforeState: CellState = 'pending'
  let beforeConflicts: CellConflict[] | undefined
  await withWriteLock(() => {
    // 他のタブの入力を取り込んでから重ねる（基準の先勝ちを、他のタブが先に入れた欄にも効かせる）
    refreshCells()
    // 行 id で指した保存でも、冪等キーで作った同じ行の控えがあれば、そちらへまとめる（#6）
    const alias = aliasRowKey(table, key, cellRows)
    if (alias !== null) {
      rowKey = alias
      key = (cellRows.get(alias) as CellEntry).key
    }
    const now = Date.now()
    const e: CellEntry = cellRows.get(rowKey) ?? {
      table,
      key,
      edits: {},
      fill: {},
      editor,
      state: 'pending',
      tries: 0,
      nextAt: 0,
      tab: tabId,
      at: now,
      ...(clientKey !== undefined ? { clientKey } : {}),
      // 画面が行 id で指すのは定時以外（発熱者・他症状者・再検）。送る前に1行読んで確かめなくてよい（#2）
      ...(typeof key.id === 'number' ? { bound: true as const } : {}),
    }
    beforeState = e.state
    beforeConflicts = e.conflicts === undefined ? undefined : [...e.conflicts]
    if (opts?.dropVers !== undefined) {
      // 画面が見た版のままの欄だけ取り下げる（見た後に打ち直した欄は残す）。この保存で書く欄は取り下げない
      const seen = new Map(Object.entries(opts.dropVers))
      const want = new Set<string>()
      for (const [f, ver] of seen) if (e.edits[f]?.ver === ver && !incoming.some((it) => it.f === f)) want.add(f)
      for (const f of pairDrop(e, want, seen)) {
        dropped.set(f, e.edits[f])
        // 済んだ印を先に付ける（付けないと、この後の書き戻しの和集合で保存先の同じ版が戻ってくる）。元に戻す時は新しい版で戻す
        markDone(rowKey, f, e.edits[f])
        delete e.edits[f]
      }
      if (e.conflicts !== undefined) {
        const cs = e.conflicts.filter((c) => !dropped.has(c.field))
        if (cs.length > 0) e.conflicts = cs
        else delete e.conflicts
      }
    }
    if (asNew) {
      // 新しい行として保存（F4）: この保存で送らない欄も、空にする欄は外し、値のある欄は基準を空にする（新しい版で）
      for (const [f, ed] of Object.entries(e.edits)) {
        if (incoming.some((it) => it.f === f)) continue
        markDone(rowKey, f, ed)
        if (ed.value === null) delete e.edits[f]
        else e.edits[f] = { value: ed.value, base: null, at: now, ver: newCellVer() }
      }
    }
    for (const it of incoming) before.set(it.f, e.edits[it.f])
    for (const it of incoming) {
      const cur = e.edits[it.f]
      const ver = newCellVer()
      const ed: CellEdit = { value: it.value, at: now, ver }
      // 置き換わる版は済んだ印を付ける（他のタブ・旧形式の読み替えから古い値を復活させない）
      if (cur !== undefined) markDone(rowKey, it.f, cur)
      if (cur !== undefined && opts?.rebase !== true && !asNew) {
        // 値は後勝ち・基準は先勝ち（送信待ちの自分の値を基準にしない）
        if (Object.prototype.hasOwnProperty.call(cur, 'base')) ed.base = cur.base
      } else if (it.base !== undefined) {
        ed.base = it.base
      }
      e.edits[it.f] = ed
      vers.set(it.f, ver)
    }
    for (const [k, v] of Object.entries(fill)) if (e.fill[k] === undefined || e.fill[k] === null) e.fill[k] = v
    e.editor = editor
    if (opts?.rebase === true || asNew || e.state === 'rejected') {
      // 〔くらべて選ぶ〕で選んだ・拒否された後の新しい入力は、送る状態へ戻す
      e.state = 'pending'
      delete e.conflicts
    }
    e.tries = 0
    e.nextAt = 0
    e.at = now
    e.tab = tabId
    cellRows.set(rowKey, e)
    cellRecordSeq += 1
    mySeq = cellRecordSeq
    held = e.state === 'conflict'
    persistUnderLock()
  })
  armRetryTimer()
  let outcome: CellSaveInternal['outcome']
  if (held) {
    // 競合で止まっている行へまとめた。〔くらべて選ぶ〕で選ぶまで送らない（送信キューの規約 I6 と同じ）
    outcome = { kind: 'result', held: true, result: heldResult(cellRows.get(rowKey)) }
  } else if (knownOffline()) {
    // つながっていないと分かっている間は試みない（待ち時間を延ばさない＝I7。電波が戻れば online で送る）
    outcome = { kind: 'queued' }
  } else {
    await scheduleFlush(false, SEND_LOCK_WAIT_MS)
    outcome = await outcomeFor(table, key, rowKey, mySeq, [...vers.keys()])
  }
  if (dropped.size > 0) {
    const failed =
      outcome.kind === 'rejected' ||
      (outcome.kind === 'result' && (outcome.held || outcome.result.conflicts.some((c) => vers.has(c.field))))
    await settleDropped(rowKey, dropped, failed ? { vers, before, beforeState, beforeConflicts } : null)
  }
  return { rowKey, vers, outcome }
}

/**
 * dropVers で取り下げた欄の後始末（#8）。restore=null は保存が確保された（書けた・送信待ちにした）＝取り下げを確定する
 * （済んだ印は取り下げた時に付けてある）。restore ありは拒否・競合＝取り下げた欄と、この保存で書いた欄（打ち直されて
 * いない分）を元に戻す。戻す欄は新しい版にする（古い版には済んだ印が付いているので、同じ版のままだと和集合で落ちる）
 */
async function settleDropped(
  rowKey: string,
  dropped: Map<string, CellEdit>,
  restore: {
    vers: Map<string, string>
    before: Map<string, CellEdit | undefined>
    beforeState: CellState
    beforeConflicts: CellConflict[] | undefined
  } | null,
): Promise<void> {
  await withWriteLock(() => {
    refreshCells()
    if (restore === null) {
      persistUnderLock()
      return
    }
    const e = cellRows.get(rowKey)
    if (e === undefined) {
      // この保存の欄は送り終えて行ごと消えた（まれ）。取り下げた欄だけを元の状態で戻す
      persistUnderLock()
      return
    }
    const now = Date.now()
    for (const [f, ver] of restore.vers) {
      const cur = e.edits[f]
      if (cur === undefined || cur.ver !== ver) continue
      markDone(rowKey, f, cur)
      const prev = restore.before.get(f)
      if (prev === undefined) delete e.edits[f]
      else e.edits[f] = { ...prev, ver: newCellVer(), at: now }
    }
    for (const [f, ed] of dropped) if (e.edits[f] === undefined) e.edits[f] = { ...ed, ver: newCellVer(), at: now }
    e.state = restore.beforeState
    const cs = (restore.beforeConflicts ?? []).filter((c) => c.field in e.edits)
    if (cs.length > 0) e.conflicts = cs
    else {
      delete e.conflicts
      if (e.state === 'conflict') e.state = 'pending'
    }
    e.at = Date.now()
    if (Object.keys(e.edits).length === 0) cellRows.delete(rowKey)
    persistUnderLock()
  })
  armRetryTimer()
}

function heldResult(e: CellEntry | undefined): CellResult {
  return { status: 'conflict', row: null, applied: [], settled: [], conflicts: e?.conflicts ?? [] }
}

/** 保存を送り終えた後の、その行の結果（送れなかった・他のタブが送った時もここで決める） */
async function outcomeFor(
  table: CellTable,
  key: Record<string, string | number>,
  rowKey: string,
  mySeq: number,
  fields: string[],
): Promise<CellSaveInternal['outcome']> {
  const o = cellOutcomes.get(rowKey)
  if (o !== undefined && o.seq >= mySeq) {
    if (o.kind === 'result') return { kind: 'result', result: o.result, held: false }
    if (o.kind === 'queued') return { kind: 'queued' }
    return { kind: 'rejected', code: o.code }
  }
  const e = cellRows.get(rowKey)
  if (e !== undefined) {
    // 他のタブが送って止まった・拒否された行へまとめた／送れていない（別のタブの送信を待ちきれなかった等）
    if (e.state === 'conflict') return { kind: 'result', held: true, result: heldResult(e) }
    if (e.state === 'rejected') return { kind: 'rejected', code: '' }
    return { kind: 'queued' }
  }
  // このタブが送る前に、同じ端末の他のタブがこの行を送り終えた。いまの行を読んで返す
  const row = await readCellRow(table, key)
  if (row === undefined) return { kind: 'queued' }
  return { kind: 'result', held: false, result: { status: 'noop', row, applied: [], settled: fields, conflicts: [] } }
}

/** いまの1行（何も書かない呼び出し。行ロックの下で読む）。読めなければ undefined・行が無ければ null */
async function readCellRow(
  table: CellTable,
  key: Record<string, string | number>,
): Promise<Record<string, unknown> | null | undefined> {
  try {
    const sb = await getClient()
    const res = (await sb.rpc('apply_cell_edits', { p_table: table, p_key: key, p_edits: {} })) as Res<unknown>
    if (res.error !== null) return undefined
    const r = parseCellResult(table, res.data)
    return r === null ? undefined : r.row
  } catch {
    return undefined
  }
}

function publicOutcome<T>(r: CellSaveInternal, normalize: (row: unknown) => T | null): CellSaveResult<T> | Queued {
  const o = r.outcome
  if (o.kind === 'queued') return QUEUED
  if (o.kind === 'rejected') throw new DbError('server', serverMsg('保存でき', o.code))
  const row = o.result.row === null ? null : normalize(o.result.row)
  if (o.result.row !== null && row === null) throw new DbError('server', MSG.broken)
  return {
    status: o.result.status,
    row,
    applied: o.result.applied,
    settled: o.result.settled,
    conflicts: o.result.conflicts,
    ...(o.held ? { held: true } : {}),
  }
}

/**
 * バイタル1行の欄を保存する（経路は1本: 送信待ちへ書く → すぐ送る → その行の結果を待つ）。
 * ・sendEdits の base は「その欄を直し始めた時に画面に出ていたサーバーの生の値」
 * ・通信できない時は 'queued'（送信待ちに残り、電波が戻れば送る）
 * ・止まっている行（conflict）へは、rebase しない限りまとめるだけで送らない（held: true）
 * ・サーバーに拒否された時は DbError（送信待ちには rejected として残る）
 */
export async function saveVitalEdits(
  target: VitalTarget,
  sendEdits: CellEditInput<VitalCellField>,
  opts?: CellSaveOpts,
): Promise<CellSaveResult<Vital> | Queued> {
  return publicOutcome(await saveCellEditsInternal('vitals', target, sendEdits, opts), normalizeVital)
}

/** 食事1行（利用者 × 日付 × 食事枠）の欄を保存する。約束は saveVitalEdits と同じ */
export async function saveMealEdits(
  target: MealTarget,
  sendEdits: CellEditInput<MealCellField>,
  opts?: CellSaveOpts,
): Promise<CellSaveResult<Meal> | Queued> {
  return publicOutcome(await saveCellEditsInternal('meals', target, sendEdits, opts), normalizeMeal)
}

/** 送信待ち・止まっている1行（画面の重ね表示と〔くらべて選ぶ〕の「あなたの入力」に使う） */
export interface PendingCellRow {
  table: CellTable
  /** 行を特定する値（RPC の p_key） */
  key: Record<string, string | number>
  /** 送信待ち・止まっている欄の値 */
  values: Record<string, unknown>
  /** 欄ごとの基準（分かる欄だけ） */
  bases: Record<string, unknown>
  state: 'pending' | 'conflict' | 'rejected'
  /** 書かなかった欄（conflict の時） */
  conflicts: CellConflict[]
  /** 欄ごとの版。取り下げる時に discardPendingRow へそのまま渡す（画面が見た版だけを外す＝#9） */
  vers: Record<string, string>
}

function pendingViewOf(e: CellEntry): PendingCellRow {
  const values: Record<string, unknown> = {}
  const bases: Record<string, unknown> = {}
  const vers: Record<string, string> = {}
  for (const [f, ed] of Object.entries(e.edits)) {
    values[f] = ed.value
    vers[f] = ed.ver
    if (Object.prototype.hasOwnProperty.call(ed, 'base')) bases[f] = ed.base
  }
  return { table: e.table, key: { ...e.key }, values, bases, state: e.state, conflicts: [...(e.conflicts ?? [])], vers }
}

/**
 * その行の送信待ち（このタブ＋同じ端末の他のタブの控え）。無ければ null。
 * 画面の送信待ちの重ね表示・止まっている行の「あなたの入力」は、これ1本から読む
 */
export function pendingRow(table: CellTable, target: VitalTarget | MealTarget): PendingCellRow | null {
  const key = keyOfTarget(table, target)
  if (key === null) return null
  const rows = currentCellRows()
  // 冪等キーで作った同じ行の控えがあれば、それを見せる（#6。行 id で指しても ck 側と食い違わない）
  const e = rows.get(aliasRowKey(table, key, rows) ?? cellRowKey(table, key))
  return e === undefined ? null : pendingViewOf(e)
}

/**
 * 送信待ちの欄を外す。onlyVers を渡すと、その版のままの欄だけ（後から打ち直した欄は残す）。
 * 外した版は、このタブが消した印を付ける（保存先からも外し、他のタブ・次の起動で復活させない）
 */
function dropCellFields(rowKey: string, fields?: readonly string[], onlyVers?: Map<string, string>): void {
  const e = cellRows.get(rowKey)
  if (e === undefined) return
  const want = new Set<string>()
  for (const [f, ed] of Object.entries(e.edits)) {
    if (fields !== undefined && !fields.includes(f)) continue
    if (onlyVers !== undefined && onlyVers.get(f) !== ed.ver) continue
    want.add(f)
  }
  // 血圧の上と下は組で外す（片方だけを取り下げない＝#3）
  for (const f of pairDrop(e, want, onlyVers)) {
    markDone(rowKey, f, e.edits[f])
    delete e.edits[f]
  }
  if (e.conflicts !== undefined) {
    const cs = e.conflicts.filter((c) => c.field in e.edits)
    if (cs.length > 0) e.conflicts = cs
    else {
      delete e.conflicts
      if (e.state === 'conflict') e.state = 'pending' // 食い違う欄が残っていない＝残りは送ってよい
    }
  }
  e.at = Date.now()
  if (Object.keys(e.edits).length === 0) cellRows.delete(rowKey)
}

/**
 * 送信待ち・止まっている行の欄を取り下げる（〔先の値を残す〕など、利用者の明示的な取り下げだけで使う）。
 * fields を省くと行ごと。vers（pendingRow の vers＝画面が見た版）を渡すと、その版のままの欄だけを外す（#9。
 * 見た後に打ち直した・他のタブが入れた新しい値は外さない）。血圧は組で外す（#3）。
 * 冪等キーで作った行は、行 id で指しても ck 側の控えを外す（#6）。取り下げた欄は、他のタブ・次の起動で復活しない
 */
export async function discardPendingRow(
  table: CellTable,
  target: VitalTarget | MealTarget,
  fields?: readonly string[],
  vers?: Record<string, string>,
): Promise<void> {
  const key = keyOfTarget(table, target)
  if (key === null) return
  const onlyVers = vers === undefined ? undefined : new Map(Object.entries(vers))
  await withWriteLock(() => {
    refreshCells()
    const direct = cellRowKey(table, key)
    const alias = aliasRowKey(table, key, cellRows)
    dropCellFields(direct, fields, onlyVers)
    if (alias !== null && alias !== direct) dropCellFields(alias, fields, onlyVers)
    persistUnderLock()
  })
  armRetryTimer()
}

// ── 水分 ─────────────────────────────────────────────────────────────────────

export async function insertFluid(f: Omit<FluidIntake, 'id' | 'rev'>): Promise<FluidIntake | Queued> {
  return insertRow('fluid_intake', withClientKey(f as unknown as Record<string, unknown>), normalizeFluid)
}

export async function softDeleteFluid(
  id: number,
  rev: number,
  opts?: WriteOpts,
): Promise<true | Conflict | Queued> {
  return softDelete('fluid_intake', id, rev, opts)
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
  opts?: WriteOpts,
): Promise<Note | Conflict | Queued> {
  if (patch.body !== undefined && patch.body.trim() === '') throw new DbError('server', MSG.emptyBody)
  const clean = cleanPayload(patch as Record<string, unknown>)
  delete clean.read_count // 集計値はサーバー側の畳み込み。書き戻さない
  delete clean.my_read
  return updateRow('notes', id, rev, clean, normalizeNote, opts)
}

export async function softDeleteNote(
  id: number,
  rev: number,
  opts?: WriteOpts,
): Promise<true | Conflict | Queued> {
  return softDelete('notes', id, rev, opts)
}

/**
 * 継続申し送りを終了する。ended_at と ended_by（終了させた職員）だけを書く部分更新。
 * ongoing フラグは触らない（過去日のピン留めは「その日時点で有効だった継続」＝
 * note_on ≦ 対象日 ≦ ended_at で判定する契約。qa-verification [low/both] の裁定）。
 * endedBy は操作者が分からない場合 null（列は 0001_init.sql から null 許容）。
 */
export async function endOngoingNote(
  id: number,
  rev: number,
  endedBy: number | null,
  opts?: WriteOpts,
): Promise<Note | Conflict | Queued> {
  const patch = { ended_at: new Date().toISOString(), ended_by: idNum(endedBy) }
  return updateNow('notes', id, rev, patch, normalizeNote, opts)
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
  opts?: WriteOpts,
): Promise<Outing | Conflict | Queued> {
  return updateNow('outings', id, rev, { end_on: endOn, end_at: endAt }, normalizeOuting, opts)
}

// ── 既読 ─────────────────────────────────────────────────────────────────────

/**
 * 既読を付ける。明示操作（本文展開タップ・既読ボタン）からのみ呼ぶこと
 * （multi-device-sync 原則9: 読み取り経路から書かない）。
 * 閲覧機能なので入力解禁フラグの封鎖対象にしない（並走期間も閲覧は全機能有効）。
 *
 * 通信できない・ログインが切れている時は永続キューへ退避して正常終了する（電波が戻れば自動で送る）。
 * 既読は「読んだ」という取り消しのきかない事実で、同じ（申し送り, 職員）は何度送っても1件に
 * 収束する（23505 は成功と同じ扱い）ため、退避しても二重登録にならない。
 */
export async function markRead(noteId: number, staffId: number): Promise<void> {
  const sb = await getClient()
  markSelfRow('note_reads', { note_id: noteId, staff_id: staffId }, null) // 既読は追加のみ（版を持たない）
  const res = (await sb
    .from('note_reads')
    .insert({ note_id: noteId, staff_id: staffId })
    .select('note_id')
    .maybeSingle()) as Res<unknown>
  if (res.error === null) return
  if (isUniqueViolation(res)) return // 既に既読。成功と同じ
  const payload = { note_id: noteId, staff_id: staffId }
  if (isAuthFail(res)) {
    fireAuthExpired()
    await enqueue({ table: 'note_reads', kind: 'read', payload })
    return
  }
  if (isTransient(res)) {
    await enqueue({ table: 'note_reads', kind: 'read', payload })
    return
  }
  throw writeError(res)
}

// ── 自分がこの端末から書いた版（Realtime の通知を自分の書込と見分ける）──────
//
// ★以前は「自分の保存から3秒間の通知は捨てる」という時刻だけの作りだった。
//   これは**同じ3秒に届いた他端末の変更まで捨てて**おり、捨てた通知は再生されないため、
//   次の通知が来るか人が手で更新するまで、その変更は無期限に画面へ出なかった
//   （2026-09-05 の監査で発見。バイタル一覧・食事一覧・日報の3画面が該当）。
//
// 行を特定するだけでも足りない。同じ行を**他端末が直後に書き換えた**通知まで
// 自分のものとして落としてしまうため、「どの行の、どの版まで書いたか」で見分ける。
//   ・自分が書いて確定した版（rev）以下の通知 … 画面へ反映済み＝無視してよい
//   ・それより新しい版の通知 … 他端末が後から書いた＝必ず拾う
// 判定できない時（行が無い・版が無い・覚えのない行）は**他端末の変更として扱う**。
// 迷ったら「取り直す・知らせる」側へ倒す＝変更を見落とさない。
//
// 覚えるのは応答が返って版が確定した後だけにする。応答より先に通知が届いた場合は
// 「自分のものと分からない」＝取り直す側に倒れるだけで、記録は失われない。
const SELF_ROW_TTL_MS = 20_000
/** 版を持たない表（出勤者）の猶予。自分の書込の通知だけを拾える最小限に留める */
const SELF_ROW_NOREV_TTL_MS = 3_000

interface SelfRow {
  /** この端末が書いて確定した版。null＝版を持たない表（この鍵は猶予いっぱい一致させる） */
  rev: number | null
  exp: number
}
/** 鍵 → 自分が書いた版。件数は1端末の直近の書込ぶんだけなので上限管理は要らない */
const selfRows = new Map<string, SelfRow>()

/** 行を一意に指す鍵。書く側の応答と、受け取る側の Realtime の行から同じ文字列が出るようにする */
function selfRowKey(table: string, row: Record<string, unknown>): string | null {
  const id = idNum(row.id)
  if (id !== null) return `${table}#${id}`
  // id を持たない表: 出勤者（日×職員）・既読（申し送り×職員）
  const staffId = idNum(row.staff_id)
  if (staffId === null) return null
  const day = dateStr(row.day)
  if (day !== null) return `${table}@${day}|${staffId}`
  const noteId = idNum(row.note_id)
  if (noteId !== null) return `${table}@${noteId}|${staffId}`
  return null
}

/**
 * この端末が書いた版として覚える。
 * rev は「書き込みが終わった後の版」を渡す（更新なら送った rev + 1、応答があるならその値）。
 */
function markSelfRow(table: string, row: unknown, rev: number | null): void {
  const rec = asRecord(row)
  if (rec === null) return
  const key = selfRowKey(table, rec)
  if (key === null) return
  const now = Date.now()
  for (const [k, v] of selfRows) if (v.exp <= now) selfRows.delete(k)
  const ttl = rev === null ? SELF_ROW_NOREV_TTL_MS : SELF_ROW_TTL_MS
  const prev = selfRows.get(key)
  // 同じ行を続けて書いた時は新しい版を採る（古い版で上書きしない）
  const next = rev === null || prev === undefined || prev.rev === null ? rev : Math.max(prev.rev, rev)
  selfRows.set(key, { rev: next, exp: now + ttl })
}

/**
 * 届いた行の版が「この端末が書いた版まで」に収まるか（isSelfWrite の判定の核・純関数）。
 * seenRev=null は版を持たない表（出勤者・既読）で、猶予の間だけ自分のものとみなす。
 * **版が読めない通知は false**＝他端末の変更として扱う（見落とさない側へ倒す）。
 */
export function isSeenRev(seenRev: number | null, row: unknown): boolean {
  if (seenRev === null) return true
  const rev = num(asRecord(row)?.rev)
  return rev !== null && rev <= seenRev
}

/**
 * Realtime で届いた変更が、この端末が既に画面へ反映済みの書込か。
 * **覚えのない行・版が新しい行・行を特定できない通知は false**（＝他端末の変更として扱う）。
 */
export function isSelfWrite(table: string, row: unknown): boolean {
  const rec = asRecord(row)
  if (rec === null) return false
  const key = selfRowKey(table, rec)
  if (key === null) return false
  const hit = selfRows.get(key)
  if (hit === undefined || hit.exp <= Date.now()) return false
  return isSeenRev(hit.rev, rec)
}

// ── Realtime ─────────────────────────────────────────────────────────────────

/** 変更通知の付帯情報（第2引数）。row が無い＝行を特定できない通知＝呼び出し側は安全側に倒す */
export interface ChangeInfo {
  /** 'INSERT' | 'UPDATE' | 'DELETE'（取り出せなければ空文字） */
  event: string
  /** 変更後の行（DELETE と、行を取り出せなかった時は null） */
  row: Record<string, unknown> | null
}

/** 中身の無いレコード（DELETE の new のような {}）は「行が無い」として扱う */
function payloadRow(v: unknown): Record<string, unknown> | null {
  const r = asRecord(v)
  return r === null || Object.keys(r).length === 0 ? null : r
}

/**
 * Realtime の通知から、呼び出し側が「表示中の期間の行か」を判定するための情報を取り出す。
 * DELETE は行を渡さない（既定の replica identity では主キーしか届かず、日付列で絞れないため。
 * 行を特定できないまま期間外と判定して取り直しを飛ばすより、安全側＝取り直す側へ倒す）。
 */
function changeInfoOf(payload: unknown): ChangeInfo {
  const p = asRecord(payload)
  if (p === null) return { event: '', row: null }
  const event = str(p.eventType) ?? ''
  return { event, row: event === 'DELETE' ? null : payloadRow(p.new) ?? payloadRow(p.old) }
}

/**
 * 変更通知の購読。どの表が変わったかと、可能なら変更のあった行（info）を渡す。
 * 表示ウィンドウ内かの判断は呼び出し側（info.row が無い時は「分からない」＝取り直す側に倒すこと）。
 * 第2引数は任意なので、従来どおり第1引数だけを使う購読はそのまま動く。
 * 接続できない場合は購読しないだけで、画面は手動更新で成立する。
 */
export function subscribeChanges(cb: (table: string, info?: ChangeInfo) => void): () => void {
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
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload: unknown) => {
          if (!cancelled) cb(table, changeInfoOf(payload))
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

/**
 * いま誰がどこを書いているか（Presence）。
 *
 * ★現場の実態（2026-09-05 聞き取り）: 申し送り欄は「他者がいつ記載しているかを把握できない」ため、
 *   同じ入居者・同じ出来事を二人が同時に書いてしまうことがある。実測でも、同じ日・同じ入居者・
 *   同じ勤務帯を別の記入者が書いた組が1日あたり5.6組あった。
 *   打鍵中の文字そのものを配る必要はなく（書きかけの文は誤読のもとになる）、
 *   **「いま誰がどこを開いているか」**が分かれば、書く前に気づいて声をかけられる。
 *
 * ★DBには一切書かない（Realtime の Presence はサーバー上の一時状態）。
 *   行数・転送量・バックアップ対象のどれも増えない。接続できない環境では
 *   「誰も居ない」として静かに成立する（画面はこれが無くても使える）。
 * ★配るのは職員IDと居場所（日付・対象の利用者ID）だけ。**氏名も本文も配らない**
 *   （受け取った側が自分の持つ職員名簿で引いて表示する）。
 */
export interface PresenceHere {
  /** 職員ID。名簿と照合して氏名を出すのは受け取る側 */
  staffId: number
  /** 開いている日（YYYY-MM-DD） */
  day: string
  /** 対象の利用者ID。null＝対象を選んでいない／全体宛 */
  residentId: number | null
}

function normalizePresence(row: unknown): PresenceHere | null {
  const r = asRecord(row)
  if (r === null) return null
  const staffId = idNum(r.staffId)
  const day = dateStr(r.day)
  if (staffId === null || day === null) return null
  return { staffId, day, residentId: idNum(r.residentId) }
}

/**
 * 申し送りを書いている人の居場所を配り、他の人の居場所を受け取る。
 * room は用途ごとに分ける（いまは申し送りだけ）。戻り値の update で自分の居場所を更新し、
 * 戻り値の stop で抜ける（画面を離れる時に必ず呼ぶ）。
 */
export function joinNotePresence(
  self: PresenceHere,
  onChange: (others: PresenceHere[]) => void,
): { update: (next: PresenceHere) => void; stop: () => void } {
  let cancelled = false
  let client: SupabaseClient | null = null
  let channel: ReturnType<SupabaseClient['channel']> | null = null
  let current = self
  const key = `s${self.staffId}-${Math.random().toString(36).slice(2, 8)}`

  void (async () => {
    try {
      const sb = await getClient()
      if (cancelled) return
      client = sb
      const ch = sb.channel('cl_note_presence', { config: { presence: { key } } })
      ch.on('presence', { event: 'sync' }, () => {
        if (cancelled) return
        const state = ch.presenceState() as Record<string, unknown[]>
        const others: PresenceHere[] = []
        for (const [k, metas] of Object.entries(state)) {
          if (k === key) continue // 自分は出さない
          const first = Array.isArray(metas) ? metas[0] : null
          const p = normalizePresence(first)
          if (p !== null) others.push(p)
        }
        onChange(others)
      })
      channel = ch
      ch.subscribe((status: string) => {
        if (!cancelled && status === 'SUBSCRIBED') void ch.track(current)
      })
    } catch {
      // 接続できない。誰も居ない扱いで画面は成立する
    }
  })()

  return {
    update: (next: PresenceHere) => {
      current = next
      if (channel !== null && !cancelled) void channel.track(next)
    },
    stop: () => {
      cancelled = true
      if (client !== null && channel !== null) {
        void channel.untrack()
        void client.removeChannel(channel)
      }
      channel = null
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// スプレッドシート模倣UI（日報シート・バイタル一覧・食事一覧）の追加API
//
// 契約: docs/design/sheet-contracts.md §3。既存の関数・型は変更していない（追加のみ）。
// 前提: supabase/migrations の 0003 → 0004 → 0005 を適用済みであること
//       ・0003_sheet_ui.sql        … vitals.symptom / vitals.kind='symptom' / notes.color /
//                                    notes.after16 / attendance
//       ・0004_vitals_client_key.sql … vitals.client_key（定時以外のバイタルの冪等キー）
//       ・0005_meals_sheet_fluids.sql … RPC meals_sheet_fluids（水分を1名1日=1行で返す）
// 規律は既存と同じ: 全読取に .is('deleted_at', null)（列を持つ表のみ）と limit を機械付与、
//       日付レンジ無しのクエリを書かない、upsert を使わない、更新は rev 照合、物理削除はしない。
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_MSG = {
  badDay: '日付を読み取れませんでした。画面を再読み込みして、日付を選び直してください。',
  tooManyDays:
    '表示する日数が多すぎて、すべてを読み込めませんでした。日数を減らして（例: 4日）から、もう一度お試しください。',
  badColor:
    '行の色を保存できませんでした（対応していない色です）。色を選び直してから、もう一度お試しください。入力は消えていません。',
  badStaff:
    '出勤者を保存できませんでした（職員を特定できない行があります）。職員を選び直してから、もう一度お試しください。',
  attendanceRace:
    '他の端末が同時に出勤者を保存したため、保存できませんでした。画面を再読み込みしてから、もう一度お試しください。',
  attendancePartial:
    '出勤者の一部だけが保存されました。「最新に更新」を押して、いまの出勤者を確認してから足りない人を選び直してください。',
} as const

/**
 * サーバーへ一部だけ書き込んだ後の失敗（saveAttendance は追加・更新・非表示を逐次実行するため、
 * 途中で失敗すると「もう載っている行」と「まだの行」が混ざる）。
 * partial=true を立てて、呼び出し側が画面を保存前へ巻き戻さないようにする。
 */
function partialWriteError(): DbError {
  return new DbError('server', SHEET_MSG.attendancePartial, true)
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 日付の形（YYYY-MM-DD）を検査する。or フィルタへ値を差し込む前の予約文字ガードも兼ねる */
function assertDay(iso: string): void {
  if (!DAY_RE.test(iso)) throw new DbError('server', SHEET_MSG.badDay)
}

/**
 * limit いっぱいまで返ってきた＝取り切れていない可能性がある。
 * 黙って切り捨てると「入力したのに一覧に出ない」＝無言の欠落になるため、
 * 日数を減らす案内を出して読み込みを失敗させる（qa-verification「1リクエスト ≤2,000行」も守る）。
 */
function assertLoadedAll(res: Res<unknown>, cap: number): void {
  if (Array.isArray(res.data) && res.data.length >= cap) {
    throw new DbError('server', SHEET_MSG.tooManyDays)
  }
}

function normalizeAttendance(row: unknown): Attendance | null {
  const r = asRecord(row)
  if (!r) return null
  const day = dateStr(r.day)
  const staff_id = idNum(r.staff_id)
  if (day === null || staff_id === null) return null
  return {
    day,
    staff_id,
    role: oneOf(r.role, ATTENDANCE_ROLES) ?? 'staff',
    sort: num(r.sort) ?? 0,
  }
}

/** 日報シート（現行スプシ「申し送り」タブ）1日分 */
export interface DailyReport {
  day: string
  /** 全 shift。画面側が shift と after16 で仕分ける */
  notes: Note[]
  /** その日に在るもの（start_on ≤ day かつ（end_on is null または end_on ≥ day）） */
  outings: Outing[]
  /** 発熱者ブロック（kind='observation'） */
  observations: Vital[]
  /** 他症状者ブロック（kind='symptom'） */
  symptoms: Vital[]
  /** 出勤者（sort < 0 ＝ 取り消し済みは除く） */
  attendance: Attendance[]
  /** その日の取込台帳（複数 source があれば直近1件）。null = 未取込 */
  importDay: ImportDay | null
}

/**
 * 日報1日分をまとめて取る（申し送り・付帯ブロック・出勤者・取込状態を並列で）。
 * staffId は既読の表示にだけ使う。ここから既読を書かない（multi-device-sync 原則9）。
 */
/**
 * 日報を**まとめて**取る（表示している区切りの全日を1回で）。
 *
 * ★1日ずつ取ると、10日の区切りで 5要求 × 10日 = 50要求になっていた（2026-09-05 実測）。
 *   表ごとに範囲で1回ずつ引き、日ごとに振り分ければ **5要求**で足りる。
 *   件数・中身は1日ずつ取るのと同じで、取りこぼしも増えない
 *   （将来日も同じ1回に含まれるので、先の日付で入れた外出予定も従来どおり出る）。
 *
 * 上限は「日数 × 1日ぶんの上限」。超えた時は assertLoadedAll と同じ考えで、
 * 黙って切り詰めず**その旨を投げる**（欠けた表を「記録なし」と見せない）。
 */
/**
 * その日・その対象の申し送りを引く（申し送りフォームの「本日この方の記録」用）。
 *
 * ★同じ出来事を別の職員が二重に書く組が **1日あたり5.6組** あった（2026-09-05 実測）。
 *   フォームは対象を選んでも既存の記録を一切読み込んでおらず、書き手には
 *   「いま誰かが打っている内容」どころか「もう保存されている記録」すら見えていなかった。
 *   対象を選んだ時点で、その日その方の記録を出して気づけるようにする。
 * residentId=null は「スタッフへ（全体）」宛の記録を指す（未選択とは呼び出し側が区別する）。
 */
export async function fetchNotesForTargetDay(
  residentId: number | null,
  dayIso: string,
): Promise<Note[]> {
  assertDay(dayIso)
  const sb = await getClient()
  let q = sb.from('notes').select(NOTE_COLS).eq('note_on', dayIso).is('deleted_at', null)
  q = residentId === null ? q.is('resident_id', null) : q.eq('resident_id', residentId)
  const res = (await q.order('id', { ascending: true }).limit(DAY_ROWS)) as Res<unknown>
  if (res.error !== null) throw readError(res)
  return list(res.data, normalizeNote, DAY_ROWS)
}

export async function fetchDailyReports(
  days: readonly string[],
  staffId: number | null,
): Promise<Map<string, DailyReport>> {
  const list0 = [...new Set(days)].sort()
  const out = new Map<string, DailyReport>()
  if (list0.length === 0) return out
  for (const d of list0) assertDay(d)
  const from = list0[0]
  const to = list0[list0.length - 1]
  const cap = Math.min(MAX_ROWS, DAY_ROWS * list0.length)
  const sb = await getClient()

  const [notesRes, outingsRes, vitalsRes, attendanceRes, importRes] = await Promise.all([
    sb
      .from('notes')
      .select(NOTE_COLS)
      .gte('note_on', from)
      .lte('note_on', to)
      .is('deleted_at', null)
      .order('id', { ascending: true }) // 記入順＝スプシの行順
      .limit(cap) as unknown as Promise<Res<unknown>>,
    // 外出・外泊は「期間が範囲に重なるもの」を採り、日ごとの割り当ては下で行う
    sb
      .from('outings')
      .select(OUTING_COLS)
      .lte('start_on', to)
      .or(`end_on.is.null,end_on.gte.${from}`)
      .is('deleted_at', null)
      .order('start_on', { ascending: true })
      .order('id', { ascending: true })
      .limit(cap) as unknown as Promise<Res<unknown>>,
    sb
      .from('vitals')
      .select(VITAL_COLS)
      .gte('measured_on', from)
      .lte('measured_on', to)
      .in('kind', ['observation', 'symptom'])
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .limit(cap) as unknown as Promise<Res<unknown>>,
    sb
      .from('attendance')
      .select(ATTENDANCE_COLS)
      .gte('day', from)
      .lte('day', to)
      .gte('sort', 0)
      .order('sort', { ascending: true })
      .order('staff_id', { ascending: true })
      .limit(cap) as unknown as Promise<Res<unknown>>,
    sb
      .from('import_days')
      .select(IMPORT_DAY_COLS)
      .gte('day', from)
      .lte('day', to)
      .order('imported_at', { ascending: false })
      .limit(Math.min(MAX_ROWS, IMPORT_DAY_ROWS * list0.length)) as unknown as Promise<Res<unknown>>,
  ])

  for (const res of [notesRes, outingsRes, vitalsRes, attendanceRes, importRes]) {
    if (res.error !== null) throw readError(res)
  }
  // 上限に届いた＝この範囲を読み切れていない。欠けたまま「記録なし」と見せない
  for (const res of [notesRes, outingsRes, vitalsRes, attendanceRes]) assertLoadedAll(res, cap)

  const notes = list(notesRes.data, normalizeNote, cap)
  const outings = list(outingsRes.data, normalizeOuting, cap)
  const vitals = list(vitalsRes.data, normalizeVital, cap)
  const attendance = list(attendanceRes.data, normalizeAttendance, cap)
  const importDays = list(importRes.data, normalizeImportDay, cap)

  // 既読は範囲ぶんまとめて1回（1日ずつだと申し送りのある日の数だけ往復していた）
  await attachReadState(sb, notes, staffId)

  for (const day of list0) {
    const dayVitals = vitals.filter((v) => v.measured_on === day)
    out.set(day, {
      day,
      notes: notes.filter((n) => n.note_on === day),
      // 開始が当日以前で、帰着が無いか当日以降＝その日の外出者（1日ずつ取る時と同じ条件）
      outings: outings.filter((o) => o.start_on <= day && (o.end_on === null || o.end_on >= day)),
      observations: dayVitals.filter((v) => v.kind === 'observation'),
      symptoms: dayVitals.filter((v) => v.kind === 'symptom'),
      attendance: attendance.filter((a) => a.day === day),
      // その日の台帳は直近1件（imported_at 降順で引いているので先頭が最新）
      importDay: importDays.find((i) => i.day === day) ?? null,
    })
  }
  return out
}

export async function fetchDailyReport(dayIso: string, staffId: number | null): Promise<DailyReport> {
  assertDay(dayIso)
  const sb = await getClient()

  const [notesRes, outingsRes, vitalsRes, attendanceRes, importRes] = await Promise.all([
    sb
      .from('notes')
      .select(NOTE_COLS)
      .eq('note_on', dayIso)
      .is('deleted_at', null)
      .order('id', { ascending: true }) // 記入順＝スプシの行順
      .limit(DAY_ROWS) as unknown as Promise<Res<unknown>>,
    // 外出・外泊は「その日に在るもの」を採る（開始が前日以前でも、帰着前ならその日の外出者）
    sb
      .from('outings')
      .select(OUTING_COLS)
      .lte('start_on', dayIso)
      .or(`end_on.is.null,end_on.gte.${dayIso}`)
      .is('deleted_at', null)
      .order('start_on', { ascending: true })
      .order('id', { ascending: true })
      .limit(DAY_ROWS) as unknown as Promise<Res<unknown>>,
    // 発熱者（observation）と他症状者（symptom）は1往復で取り、画面側の2ブロックへ振り分ける
    sb
      .from('vitals')
      .select(VITAL_COLS)
      .eq('measured_on', dayIso)
      .in('kind', ['observation', 'symptom'])
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .limit(DAY_ROWS) as unknown as Promise<Res<unknown>>,
    // attendance は soft delete 列を持たない表（note_reads と同じ）。取り消しは sort < 0 で表す
    sb
      .from('attendance')
      .select(ATTENDANCE_COLS)
      .eq('day', dayIso)
      .gte('sort', 0)
      .order('sort', { ascending: true })
      .order('staff_id', { ascending: true })
      .limit(DAY_ROWS) as unknown as Promise<Res<unknown>>,
    sb
      .from('import_days')
      .select(IMPORT_DAY_COLS)
      .eq('day', dayIso)
      .order('imported_at', { ascending: false })
      .limit(IMPORT_DAY_ROWS) as unknown as Promise<Res<unknown>>,
  ])

  for (const res of [notesRes, outingsRes, vitalsRes, attendanceRes, importRes]) {
    if (res.error !== null) throw readError(res)
  }

  const notes = list(notesRes.data, normalizeNote, DAY_ROWS)
  const vitals = list(vitalsRes.data, normalizeVital, DAY_ROWS)
  const importDays = list(importRes.data, normalizeImportDay, IMPORT_DAY_ROWS)

  await attachReadState(sb, notes, staffId)

  return {
    day: dayIso,
    notes,
    outings: list(outingsRes.data, normalizeOuting, DAY_ROWS),
    observations: vitals.filter((v) => v.kind === 'observation'),
    symptoms: vitals.filter((v) => v.kind === 'symptom'),
    attendance: list(attendanceRes.data, normalizeAttendance, DAY_ROWS),
    importDay: importDays[0] ?? null,
  }
}

/**
 * 申し送りに既読の表示情報（既読人数・自分が読んだか）を付ける。
 * 失敗しても日報本体は出す（既読は補助表示なので、これで1日分の記録を隠さない）。
 * 取れなかった時は read_count / my_read を未設定のまま残す＝画面は「0人」ではなく何も出さない
 * （観測できていない値を断定しない）。
 */
async function attachReadState(sb: SupabaseClient, notes: Note[], staffId: number | null): Promise<void> {
  if (staffId === null || notes.length === 0) return
  const ids = notes.slice(0, READ_LOOKUP_ROWS).map((n) => n.id)
  let res: Res<unknown>
  try {
    res = (await sb
      .from('note_reads')
      .select('note_id,staff_id')
      .in('note_id', ids)
      .limit(MAX_ROWS)) as Res<unknown>
  } catch {
    return // 通信できない。既読の印は出さない（本体の表示は続ける）
  }
  if (res.error !== null || !Array.isArray(res.data)) return
  const counts = new Map<number, number>()
  const mine = new Set<number>()
  for (const row of res.data) {
    const r = asRecord(row)
    const noteId = idNum(r?.note_id)
    if (noteId === null) continue
    counts.set(noteId, (counts.get(noteId) ?? 0) + 1)
    if (idNum(r?.staff_id) === staffId) mine.add(noteId)
  }
  const lookedUp = new Set(ids)
  for (const n of notes) {
    if (!lookedUp.has(n.id)) continue
    n.read_count = counts.get(n.id) ?? 0
    n.my_read = mine.has(n.id)
  }
}

/**
 * 一覧（横並び）用。期間 × 全利用者のバイタルを取る。
 * kind は絞らない（画面が routine / recheck / observation / symptom を仕分ける）。
 */
export async function fetchVitalsSheet(fromIso: string, toIso: string): Promise<Vital[]> {
  assertDay(fromIso)
  assertDay(toIso)
  const sb = await getClient()
  const res = (await sb
    .from('vitals')
    .select(VITAL_COLS)
    .gte('measured_on', fromIso)
    .lte('measured_on', toIso)
    .is('deleted_at', null)
    .order('measured_on', { ascending: false }) // 新しい日が左（sheet-contracts §6）
    .order('resident_id', { ascending: true })
    .order('id', { ascending: true })
    .limit(MAX_ROWS)) as Res<unknown>
  if (res.error !== null) throw readError(res)
  assertLoadedAll(res, MAX_ROWS)
  return list(res.data, normalizeVital)
}

/**
 * RPC meals_sheet_fluids の1行（1名1日）を、画面が使う「1回 = 1行」の並びへ戻す。
 * resident_id / taken_on は親の行にしか持たせていない（内訳で繰り返さない）ので、ここで補う。
 * 壊れた行・読めない内訳は落とす（既存の list と同じ扱い）。
 * 総件数が上限を超えたら、黙って切り捨てず日数を減らす案内を出す（無言の欠落を作らない）。
 */
function expandFluidDays(data: unknown): FluidIntake[] {
  if (!Array.isArray(data)) return []
  const out: FluidIntake[] = []
  for (const row of data) {
    const r = asRecord(row)
    if (r === null) continue
    const resident_id = idNum(r.resident_id)
    const taken_on = dateStr(r.taken_on)
    if (resident_id === null || taken_on === null || !Array.isArray(r.entries)) continue
    for (const entry of r.entries) {
      const e = asRecord(entry)
      if (e === null) continue
      const f = normalizeFluid({ ...e, resident_id, taken_on })
      if (f === null) continue
      if (out.length >= FLUID_ENTRY_ROWS) throw new DbError('server', SHEET_MSG.tooManyDays)
      out.push(f)
    }
  }
  return out
}

/**
 * 一覧（横並び）用。期間 × 全利用者の食事と水分を取る（水分の日合計・内訳は画面側で出す）。
 *
 * 水分は RPC meals_sheet_fluids で「1名1日 = 1行（合計＋内訳）」にまとめて受け取り、
 * expandFluidDays で従来どおりの1回=1行へ戻す。**呼び出し側が受け取る形は変えていない。**
 * 生の行のまま引くと、既定の11日表示では水分だけで取得上限の 7〜9割を占め、利用者が増える・
 * 水分記録の粒度が上がるだけで、食事一覧が「一部が欠けた表」ではなく画面ごとエラーになって
 * 開けなくなるため（背景は 0005_meals_sheet_fluids.sql の冒頭）。
 * 食事と水分は取得上限の枠を分けている（MEALS_SHEET_ROWS / FLUID_DAY_ROWS）。
 */
export async function fetchMealsSheet(
  fromIso: string,
  toIso: string,
): Promise<{ meals: Meal[]; fluids: FluidIntake[] }> {
  assertDay(fromIso)
  assertDay(toIso)
  const sb = await getClient()
  const [mealsRes, fluidsRes] = await Promise.all([
    sb
      .from('meals')
      .select(MEAL_COLS)
      .gte('meal_on', fromIso)
      .lte('meal_on', toIso)
      .is('deleted_at', null)
      .order('meal_on', { ascending: false })
      .order('resident_id', { ascending: true })
      .order('id', { ascending: true })
      .limit(MEALS_SHEET_ROWS) as unknown as Promise<Res<unknown>>,
    // 期間の絞り込みは RPC の引数（両端のある日付レンジ・期間上限つき）が担う
    sb
      .rpc('meals_sheet_fluids', { p_from: fromIso, p_to: toIso })
      .limit(FLUID_DAY_ROWS) as unknown as Promise<Res<unknown>>,
  ])
  if (mealsRes.error !== null) throw readError(mealsRes)
  assertLoadedAll(mealsRes, MEALS_SHEET_ROWS)
  if (fluidsRes.error !== null) throw readError(fluidsRes)
  assertLoadedAll(fluidsRes, FLUID_DAY_ROWS)
  return {
    meals: list(mealsRes.data, normalizeMeal, MEALS_SHEET_ROWS),
    fluids: expandFluidDays(fluidsRes.data),
  }
}

/** updateNoteFields が書き込んでよい項目（これ以外は送らない＝サーバーの値を温存する） */
type NoteFieldPatch = Partial<
  Pick<
    Note,
    | 'body'
    | 'resident_id'
    | 'importance'
    | 'color'
    | 'after16'
    | 'occurred_at'
    | 'reporter_id'
    | 'role_tags'
    | 'shift'
  >
>

/**
 * 申し送りの部分更新（セル直接編集用）。
 * 渡された項目だけを書き、渡していない項目はサーバーの値を温存する（multi-device-sync 原則3）。
 * rev 照合で 0行 なら 'conflict'（呼び出し側の入力は消さない）。通信失敗は永続キューへ退避して 'queued'。
 */
export async function updateNoteFields(
  id: number,
  rev: number,
  patch: NoteFieldPatch,
  opts?: WriteOpts,
): Promise<Note | Conflict | Queued> {
  const src = patch as Record<string, unknown>
  const payload: Record<string, unknown> = {}
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined

  if (has('body')) {
    const body = str(src.body)
    // 空文字での上書きは DB 側の check でも拒否される。手前で理由を出して入力を残す
    if (body === null || body.trim() === '') throw new DbError('server', MSG.emptyBody)
    payload.body = body
  }
  if (has('resident_id')) payload.resident_id = idNum(src.resident_id) // 不正値は「全体連絡」= null
  if (has('importance')) payload.importance = oneOf(src.importance, IMPORTANCES) ?? 'normal'
  if (has('color')) {
    const color = src.color === null ? null : oneOf(src.color, NOTE_COLORS)
    if (color === null && src.color !== null) throw new DbError('server', SHEET_MSG.badColor)
    payload.color = color // null = 色なし（明示的な消去）
  }
  if (has('after16')) payload.after16 = bool(src.after16, false)
  if (has('occurred_at')) payload.occurred_at = str(src.occurred_at)
  if (has('reporter_id')) payload.reporter_id = idNum(src.reporter_id)
  if (has('role_tags')) payload.role_tags = strArray(src.role_tags)
  if (has('shift')) {
    const shift = oneOf(src.shift, SHIFTS)
    if (shift !== null) payload.shift = shift // 未知の値は送らない（現在のシフトを温存する）
  }

  return updateRow('notes', id, rev, payload, normalizeNote, opts)
}

/**
 * 出勤者の登録（rows に有る人を追加・更新し、**baseline に有って rows に無い人だけ**取り消す）。
 * **その日の一覧を丸ごと置き換えるのではない**（rows=[] は「baseline の人を全員取り消す」であって
 * 「その日の出勤者を全員取り消す」ではない）。baseline は必須引数にしてある＝渡し忘れると
 * 取り消しが1件も起きないまま成功して見える無言の no-op になるため、型で弾く。
 *
 * attendance には delete ポリシーが無く、物理削除もしない契約なので「置き換え」は
 *   ・一覧に無い既存行 → sort = -1 に更新して非表示にする（行は残るので再登録で復活する）
 *   ・一覧に有って既存行が無い → insert
 *   ・両方に有る → role / sort が変わった時だけ update
 * で表す。追加・更新を先に、非表示を最後に実行する（途中で失敗した時に「消える」側でなく
 * 「残る」側へ倒す＝multi-device-sync 原則5）。
 *
 * rev 列を持たない表なので rev 照合はできない。競合の粒度は (day, staff_id) の1行単位で、
 * 同じ職員の役割・並び順を2端末が同時に変えた場合だけ後勝ちになる。
 * **1件も書く前**の通信失敗・認証切れは永続キューへ退避して 'queued' を返す。退避した op は
 * 送信時にサーバー現況を読み直して差分を計算し直す（スナップショットを流し込まないので、
 * オフラインの間に他端末が入れた出勤者を無言で消さない）。
 * **1件でも書き込んだ後の失敗は DbError.partial=true** で返す（呼び出し側は画面を
 * 保存前へ巻き戻さず、読み直しを促す＝載った分を「保存されていない」と見せない）。
 *
 * **非表示にしてよいのは「この端末が画面に持っていた行（baseline）」だけ**。
 * baseline に無い行は、他端末がこの端末の読み込み後に足した行かもしれないので触らない
 * （未知の行は消さない＝和集合側へ倒す。multi-device-sync 原則5「消失より復活・無言消失の禁止」）。
 * 呼び出し側は fetchDailyReport で受け取った attendance の staff_id をそのまま渡す。
 */
export async function saveAttendance(
  dayIso: string,
  rows: { staff_id: number; role: 'manager' | 'staff'; sort: number }[],
  options: { baseline: number[] },
): Promise<void | Queued> {
  assertDay(dayIso)
  await assertWritable()
  const sb = await getClient()
  const baseline = options?.baseline ?? []
  try {
    await applyAttendance(sb, dayIso, rows, baseline)
  } catch (e) {
    // 1件も書けていない通信失敗・認証切れだけ退避する（書けた後は partial のまま throw）
    if (e instanceof DbError && !e.partial && (e.kind === 'network' || e.kind === 'auth')) {
      return enqueue({
        table: 'attendance',
        kind: 'attendance',
        payload: { day: dayIso, rows, baseline },
      })
    }
    throw e
  }
}

/**
 * 出勤者の差分計算と書き込みの本体（画面からの保存と、退避 op の再送の両方がここを通る）。
 * 入力解禁フラグの確認・日付の検査は呼び出し側（saveAttendance）が済ませている前提。
 * サーバーの現況をその場で読み直すので、退避した古い一覧をそのまま流し込むことにはならない。
 */
async function applyAttendance(
  sb: SupabaseClient,
  dayIso: string,
  rows: { staff_id: number; role: 'manager' | 'staff'; sort: number }[],
  baselineIds: number[],
): Promise<void> {
  // 入力の正規化（同じ職員が2回来たら先勝ち＝主キー day+staff_id に合わせる）
  const wanted = new Map<number, { role: Attendance['role']; sort: number }>()
  rows.forEach((row, i) => {
    const staffId = idNum(row?.staff_id)
    if (staffId === null) throw new DbError('server', SHEET_MSG.badStaff)
    if (wanted.has(staffId)) return
    const sort = Number.isInteger(row.sort) && row.sort >= 0 ? row.sort : i
    wanted.set(staffId, { role: oneOf(row.role, ATTENDANCE_ROLES) ?? 'staff', sort })
  })

  const existing = await fetchAttendanceRows(sb, dayIso)

  const toInsert: Attendance[] = []
  const toUpdate: Attendance[] = []
  for (const [staffId, want] of wanted) {
    const cur = existing.get(staffId)
    if (cur === undefined) {
      toInsert.push({ day: dayIso, staff_id: staffId, role: want.role, sort: want.sort })
    } else if (cur.role !== want.role || cur.sort !== want.sort) {
      // 取り消し済み（sort < 0）の行もここで復活する
      toUpdate.push({ day: dayIso, staff_id: staffId, role: want.role, sort: want.sort })
    }
  }
  // この端末が観測していた行だけを非表示の対象にする（未観測の行は他端末が足したものとして残す）。
  // baseline は必須引数だが、型検査を通らない経路から呼ばれても落ちないよう実行時は空配列へ倒す
  // （＝1件も取り消さない＝消える側ではなく残る側へ倒す）
  const baseline = new Set<number>()
  for (const id of Array.isArray(baselineIds) ? baselineIds : []) {
    const staffId = idNum(id)
    if (staffId !== null) baseline.add(staffId)
  }
  const toHide: number[] = []
  for (const [staffId, cur] of existing) {
    if (!wanted.has(staffId) && cur.sort >= 0 && baseline.has(staffId)) toHide.push(staffId)
  }
  if (toInsert.length === 0 && toUpdate.length === 0 && toHide.length === 0) return // 差分なし

  // 「1件でもサーバーへ書き込んだ後」に失敗したかを持ち回る。
  // 途中失敗を素の writeError（「記録は変わっていません」）で返すと、
  // 既に載った追加・更新まで「保存されていない」と案内することになるため
  let wrote = false

  // この差分で触る行を、送る前にまとめて覚える（自分の書込で「他の端末で更新」を出さない）
  for (const row of toInsert) markSelfRow('attendance', { day: dayIso, staff_id: row.staff_id }, null)
  for (const row of toUpdate) markSelfRow('attendance', { day: dayIso, staff_id: row.staff_id }, null)
  for (const staffId of toHide) markSelfRow('attendance', { day: dayIso, staff_id: staffId }, null)

  // 1. 追加（不足分だけ）
  if (toInsert.length > 0) {
    await insertAttendanceRows(sb, dayIso, toInsert) // 途中失敗は内部で partial を投げ分ける
    wrote = true
  }
  // 2. 役割・並び順の変更（1行ずつ。主キーで1行だけを狙う）
  for (const row of toUpdate) {
    const res = (await sb
      .from('attendance')
      .update({ role: row.role, sort: row.sort })
      .eq('day', dayIso)
      .eq('staff_id', row.staff_id)
      .select('staff_id')
      .maybeSingle()) as Res<unknown>
    if (res.error !== null) throw wrote ? partialWriteError() : writeError(res)
    wrote = true
  }
  // 3. 一覧から外れた人を非表示にする（行は消さない＝再登録で戻せる）
  if (toHide.length > 0) {
    const res = (await sb
      .from('attendance')
      .update({ sort: ATTENDANCE_HIDDEN_SORT })
      .eq('day', dayIso)
      .in('staff_id', toHide)
      .select('staff_id')) as Res<unknown>
    if (res.error !== null) throw wrote ? partialWriteError() : writeError(res)
  }
}

/** その日の出勤者行（取り消し済み＝sort < 0 も含む）。置き換えの差分計算に使う */
async function fetchAttendanceRows(
  sb: SupabaseClient,
  dayIso: string,
): Promise<Map<number, Attendance>> {
  const res = (await sb
    .from('attendance')
    .select(ATTENDANCE_COLS)
    .eq('day', dayIso)
    .order('staff_id', { ascending: true })
    .limit(MAX_ROWS)) as Res<unknown>
  if (res.error !== null) throw readError(res)
  const out = new Map<number, Attendance>()
  for (const row of list(res.data, normalizeAttendance)) out.set(row.staff_id, row)
  return out
}

/**
 * 出勤者を追加する。23505（他端末が同じ職員を先に登録した）は1度だけ読み直して、
 * 本当に足りない分だけを入れ直す。upsert は使わない（既存契約）。
 */
async function insertAttendanceRows(
  sb: SupabaseClient,
  dayIso: string,
  rows: Attendance[],
): Promise<void> {
  const res = (await sb.from('attendance').insert(rows).select('staff_id')) as Res<unknown>
  if (res.error === null) return
  if (!isUniqueViolation(res)) throw writeError(res)

  const existing = await fetchAttendanceRows(sb, dayIso)
  const missing = rows.filter((r) => !existing.has(r.staff_id))
  // 最初の insert は1文なので、23505 で戻った時点ではまだ1行も書けていない。
  // ここから下は書けた分と書けていない分が混ざりうるので、書けたかどうかを持ち回る
  let wrote = false
  // 既に載っている行は role / sort を書き直す（他端末が先に作った行を自分の並びへ合わせる）
  for (const row of rows) {
    const cur = existing.get(row.staff_id)
    if (cur === undefined || (cur.role === row.role && cur.sort === row.sort)) continue
    const up = (await sb
      .from('attendance')
      .update({ role: row.role, sort: row.sort })
      .eq('day', dayIso)
      .eq('staff_id', row.staff_id)
      .select('staff_id')
      .maybeSingle()) as Res<unknown>
    if (up.error !== null) throw wrote ? partialWriteError() : writeError(up)
    wrote = true
  }
  if (missing.length === 0) return
  const retry = (await sb.from('attendance').insert(missing).select('staff_id')) as Res<unknown>
  if (retry.error === null) return
  throw wrote ? partialWriteError() : new DbError('server', SHEET_MSG.attendanceRace)
}

// ── 食い違いの解決画面（くらべて選ぶ）が使う「いまの1行」 ─────────────────────
//
// 競合した行だけを、開いた時点のサーバーの最新で取り直す（範囲は1行＝全件ロードしない）。
// 記入者の表示（edited_by → recorded_by）と「いつ入った値か」（updated_at）も一緒に取る。

/** いまの1行と、その行を最後に書き換えた職員・時刻（列が無い DB では editedBy は null） */
export interface LatestRow<T> {
  row: T
  editedBy: number | null
  updatedAt: string | null
}

/**
 * 1行を取り直す共通部分。edited_by は 0010 未適用の DB には無いので、列が無いエラーなら
 * 付けずに取り直す（取得そのものは失敗させない）。見つからなければ null。
 */
async function fetchLatestRow<T>(
  table: 'vitals' | 'meals',
  filters: Record<string, unknown>,
  normalize: (row: unknown) => T | null,
): Promise<LatestRow<T> | null> {
  const sb = await getClient()
  const cols = colsOf(table)
  const run = async (extra: string): Promise<Res<unknown>> => {
    let q = sb.from(table).select(`${cols},${extra}`).is('deleted_at', null)
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v as never)
    return (await q.order('id', { ascending: false }).limit(1).maybeSingle()) as Res<unknown>
  }
  let res = editedByUnsupported ? await run('updated_at') : await run('edited_by,updated_at')
  if (res.error !== null && isMissingColumn(res)) {
    editedByUnsupported = true
    res = await run('updated_at')
  }
  if (res.error !== null) throw readError(res)
  if (res.data === null) return null
  const row = normalize(res.data)
  if (row === null) throw new DbError('server', MSG.broken)
  const r = asRecord(res.data)
  return { row, editedBy: idNum(r?.edited_by), updatedAt: str(r?.updated_at) }
}

/**
 * バイタル1行の最新。定時は（利用者, 日付）で引く（定時は1名1日1行＝部分unique索引）。
 * それ以外（再検・発熱者・他症状者）は行の id で引く。
 */
export async function fetchLatestVital(
  target: { routine: true; residentId: number; day: string } | { routine: false; id: number },
): Promise<LatestRow<Vital> | null> {
  if (target.routine) {
    assertDay(target.day)
    return fetchLatestRow(
      'vitals',
      { resident_id: target.residentId, measured_on: target.day, kind: 'routine' },
      normalizeVital,
    )
  }
  return fetchLatestRow('vitals', { id: target.id }, normalizeVital)
}

/** 食事1行（利用者 × 日付 × 食事枠）の最新 */
export async function fetchLatestMeal(
  residentId: number,
  day: string,
  slot: MealSlot,
): Promise<LatestRow<Meal> | null> {
  assertDay(day)
  return fetchLatestRow('meals', { resident_id: residentId, meal_on: day, meal_slot: slot }, normalizeMeal)
}

// ── 変更の記録（record_history・0010_record_history.sql） ─────────────────────
//
// 業務5表の更新・削除のたびに、サーバー側のトリガが旧行・新行を1行ずつ残す（アプリからは書けない）。
// ここは読むだけ。範囲（日付レンジ必須・件数上限つき）でしか引かない＝全件ロードしない。

/** record_history の1行。old_row / new_row は更新前後の行そのもの（列は表ごとに違う） */
export interface RecordHistoryEntry {
  id: number
  /** vitals / meals / fluid_intake / notes / outings */
  table_name: string
  row_id: number
  /** null＝全体連絡の申し送り */
  resident_id: number | null
  /** その記録の業務日付（measured_on / meal_on / taken_on / note_on / start_on） */
  record_day: string | null
  op: 'update' | 'delete'
  rev_before: number | null
  rev_after: number | null
  old_row: Record<string, unknown>
  new_row: Record<string, unknown>
  changed_at: string
  /**
   * 変えた職員（その更新で送られた edited_by を写したもの）。アプリは更新のたびに必ず送り、
   * 操作者が分からない更新・取込（tools/import.mjs）の更新は null。0010 を当てる前の更新は記録されない
   */
  changed_by_staff: number | null
}

/** 表がまだ無い（0010 未適用）時は available:false。画面は「未設定」と出す */
export type RecordHistoryResult = { available: true; entries: RecordHistoryEntry[] } | { available: false }

/** 1回に引く既定件数（画面の1ページ分） */
const HISTORY_ROWS = 200

// changed_by_uid（端末ログインの uid）は画面で使わないので端末へ持ち出さない
const HISTORY_COLS =
  'id,table_name,row_id,resident_id,record_day,op,rev_before,rev_after,old_row,new_row,changed_at,changed_by_staff'

const HISTORY_OPS: readonly RecordHistoryEntry['op'][] = ['update', 'delete']

function normalizeHistory(row: unknown): RecordHistoryEntry | null {
  const r = asRecord(row)
  if (!r) return null
  const id = idNum(r.id)
  const table_name = str(r.table_name)
  const row_id = idNum(r.row_id)
  const op = oneOf(r.op, HISTORY_OPS)
  const old_row = asRecord(r.old_row)
  const new_row = asRecord(r.new_row)
  if (id === null || table_name === null || row_id === null || op === null) return null
  if (old_row === null || new_row === null) return null
  return {
    id,
    table_name,
    row_id,
    resident_id: idNum(r.resident_id),
    record_day: dateStr(r.record_day),
    op,
    rev_before: num(r.rev_before),
    rev_after: num(r.rev_after),
    old_row,
    new_row,
    changed_at: str(r.changed_at) ?? '',
    changed_by_staff: idNum(r.changed_by_staff),
  }
}

/** 表が無い（42P01 = undefined_table／PGRST205 = スキーマキャッシュに無い）＝ 0010 未適用 */
function isMissingTable(res: Res<unknown>): boolean {
  const code = errCode(res)
  return code === '42P01' || code === 'PGRST205'
}

/**
 * 変更の記録を業務日付の範囲で引く（新しい変更が先）。
 * residentId: 数値＝その利用者／null＝全体連絡（利用者なし）／省略＝範囲内の全員。
 * 日付レンジは必須（全件ロード禁止）。limit は 1〜2000 に丸める（既定 200）。
 * 表が無い時は例外にせず { available: false } を返す（画面が「未設定」と出せるように）。
 */
export async function fetchRecordHistory(p: {
  residentId?: number | null
  fromIso: string
  toIso: string
  limit?: number
}): Promise<RecordHistoryResult> {
  assertDay(p.fromIso)
  assertDay(p.toIso)
  const cap = Math.min(Math.max(1, Math.floor(p.limit ?? HISTORY_ROWS)), MAX_ROWS)
  const sb = await getClient()
  let q = sb
    .from('record_history')
    .select(HISTORY_COLS)
    .gte('record_day', p.fromIso)
    .lte('record_day', p.toIso)
  if (p.residentId === null) q = q.is('resident_id', null)
  else if (p.residentId !== undefined) q = q.eq('resident_id', p.residentId)
  const res = (await q
    .order('record_day', { ascending: false })
    .order('changed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(cap)) as Res<unknown>
  if (res.error !== null) {
    if (isMissingTable(res)) return { available: false }
    throw readError(res)
  }
  return { available: true, entries: list(res.data, normalizeHistory, cap) }
}

/** 差分に出さない列（版・更新時刻・触った人は毎回変わる／raw_flags は取込の内部控え） */
const HISTORY_DIFF_SKIP: readonly string[] = ['rev', 'updated_at', 'edited_by', 'raw_flags']

/** 値の同一判定（配列・オブジェクトは中身で比べる。欠けている列は null と同じ扱い） */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * 変更の記録1件の「変わった列だけ」を返す（純関数）。
 * rev・updated_at・edited_by・raw_flags は除く。列の並びは更新前の行の順（更新後にだけある列は後ろ）。
 * 片方にしか無い列は null として比べる（両方とも空なら変化なし）。
 */
export function diffHistoryRow(
  oldRow: unknown,
  newRow: unknown,
): { column: string; before: unknown; after: unknown }[] {
  const o = asRecord(oldRow) ?? {}
  const n = asRecord(newRow) ?? {}
  const cols: string[] = []
  for (const k of [...Object.keys(o), ...Object.keys(n)]) {
    if (!cols.includes(k) && !HISTORY_DIFF_SKIP.includes(k)) cols.push(k)
  }
  const out: { column: string; before: unknown; after: unknown }[] = []
  for (const column of cols) {
    const before = o[column] ?? null
    const after = n[column] ?? null
    if (!sameJson(before, after)) out.push({ column, before, after })
  }
  return out
}

// ── 保守用（積み残しの可視化） ───────────────────────────────────────────────

/** localStorage の未送信データが壊れていて読めなかったか（設定画面での注意表示用） */
export function isQueueBroken(): boolean {
  return queueBroken
}

/**
 * 退避した書込を端末に残せているか（false = メモリ上だけ＝タブを閉じると失われる）。
 * 'queued' を受けた画面が「入力の控え（下書き）を消してよいか」を判断するための保全ゲート。
 * multi-device-sync 原則8「消去は保全ゲートの後ろ」。キュー（退避 op・バイタル・食事の送信待ち）が空なら
 * 残すものが無いので true。
 */
export function isQueuePersisted(): boolean {
  return (queue.length === 0 && cellRows.size === 0) || queuePersisted
}

// ── テスト専用の差し込み口（裁定11: 1つにまとめる） ─────────────────────────────
//
// **tests/logic.test.mjs だけが使う。本番コードから呼ばないこと。**
// 画面のどこからも import しないので、本番のバンドルには入らない（ビルドの tree-shaking で落ちる。
// dist に __testHooks・restartQueue が無いことを第1段の検収で確かめた）。

export const __testHooks = import.meta.env?.PROD === true ? undefined : {
  /**
   * 偽の Supabase クライアントを差し込み、接続先の設定と入力解禁（解禁を観測済み）を満たした状態にする。
   * null を渡すと差し込みを外し、未設定・未観測の状態へ戻す。
   * 差し替えのたびに操作者（setEditor）と「edited_by 列が無い」印も初期化する。
   * cellRpc は 0011 の有無（既定 'ready'＝観測済み。null＝未観測で、保存の前に問い合わせる）
   */
  setClient(sb: SupabaseClient | null, opts?: { cellRpc?: 'ready' | 'missing' | null }): void {
    testClient = sb
    gateValue = sb === null ? null : true
    gateFetchedAt = sb === null ? 0 : Date.now()
    // 差し替えは「別の起動」とみなし、起動単位の状態（操作者・edited_by 列が無い印）を初期化する
    editorId = null
    editedByUnsupported = false
    const state = opts?.cellRpc === undefined ? 'ready' : opts.cellRpc
    cellRpcState = sb === null ? null : state
    cellRpcCheckedAt = sb === null || state === null ? 0 : Date.now()
  },
  /** 「次の起動」を再現する: メモリ上のキュー・送信待ちを捨て、localStorage から読み直す（起動時の読み替えも行う） */
  async restartQueue(): Promise<void> {
    queue = []
    cellRows = new Map()
    doneMarks = []
    sentQids.clear()
    cellOutcomes.clear()
    pendingFlush = null
    flushTail = Promise.resolve()
    tabId = newTabId()
    queueBroken = false
    queueBrokenRaw = null
    cellBrokenRaw = null
    quietCache = null
    convertedOnLoad = false
    legacyBrokenPending = false
    loadQueue()
    if (legacyBrokenPending || convertedOnLoad) await persistQueueLocked()
  },
  /** 待ち時間のタイマー（I7）を差し替える。null で元に戻す。張ってあったタイマーは外す */
  setTimer(api: TimerApi | null): void {
    if (retryTimer !== null) timerApi.clear(retryTimer)
    retryTimer = null
    retryDueAt = 0
    timerApi = api ?? realTimer
  },
  /** このタブの印（別タブの書き込みを再現する時に使う） */
  tabId(): string {
    return tabId
  },
}
