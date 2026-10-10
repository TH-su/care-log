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
//   ・申し送りの既にある行の変更・取り消しは RPC apply_note_edits（0017）で欄ごとに書く（2026-09-29 本人承認）。
//     バイタル・食事と同じ送信待ち（cl_sendQueue2 の rows、行キー notes#<id>）を通し、競合した入力は端末に残す。
//   ・水分・申し送り・外出は HEAD（c592dad）の送り方のまま: insert は端末生成の冪等キー client_key を必ず付け、
//     23505 なら「既に届いている」証拠として既存行を読み直し、二重登録を作らない（申し送りは新規登録だけがこの経路）。
//   ・物理削除はしない（soft delete = deleted_at のみ）。
//   ・水分・外出の更新は rev 照合（.eq('rev', rev)）。0行 = 競合 → 'conflict' を返し、
//     呼び出し側の入力は消さない。
//   ・通信失敗・認証切れの書込は永続キュー（localStorage cl_sendQueue／バイタル・食事は cl_sendQueue2）へ退避し 'queued' を返す。
//     キューから消すのは「サーバーに載ったことを観測できた時」だけ（multi-device-sync 原則6・8）。
//     業務データを置く localStorage は cl_sendQueue / cl_sendQueue2 / cl_draftNote / cl_dailyDraft:<日付> の
//     4キーだけ（cl_dailyDraft は日報の書きかけ＝2026-09-02 追加。2026-09-29 からタブごとに分けて持ち、期限では消さない。
//     cl_sendQueue2 はバイタル・食事・申し送りの変更の送信待ち＝2026-09-23 第3段 #1。旧ビルドへ戻しても消えないよう
//     cl_sendQueue から分けた）。読めなく
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
  BathCancelReason,
  BathRecord,
  BathResult,
  FluidIntake,
  ImportDay,
  Importance,
  Incident,
  IncidentDetail,
  IncidentKind,
  IncidentOffice,
  IncidentPlace,
  IncidentReportStage,
  IncidentSeverity,
  IncidentStatus,
  InputKind,
  Meal,
  MedAdmin,
  MedAdminSlot,
  MedSlot,
  MedSlotsSetting,
  MedStatus,
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
import { validateNoteAlias } from './types'
import { rememberCreatedAt } from './nextMorning'
import {
  BATH_CANCEL_REASONS,
  BATH_RESULTS,
  INCIDENT_KINDS,
  INCIDENT_OFFICES,
  INCIDENT_PLACES,
  INCIDENT_REPORT_STAGES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  LS,
  MED_ADMIN_SLOTS,
  MED_STATUSES,
} from './types'
import { matchBathPlan, monthDays, monthRange, validateBathInput } from './bath'
import type { BathPlanEntry, BathPlanRow } from './bath'
import { normalizeMedSlots, validateMedAdminInput } from './med'
import { normalizeChoices, normalizeIncidentDetail, validateIncidentInput } from './incident'
import type { IncidentInput } from './incident'
import {
  notePresence,
  othersFromState,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_TOPIC,
  presenceMeta,
  samePresence,
} from './presence'
import type { PresenceHere, PresenceSeen } from './presence'
// 古い版の入力止め（min_client_build・F28③）。appVersion は supabase に依存しない純粋なモジュール
import { clientBuildAllowed } from './appVersion'
import type { BuildStamp } from './appVersion'

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
// created_at（バイタル・水分・申し送り）は、夜勤明けに前日の欄へ書いた記録の「翌」の判定に使うので読む
// （F34・2026-10-10。行の型には載せず nextMorning.ts に id で控える。与薬の MED_ADMIN_COLS と同じ扱い）
const VITAL_COLS =
  'id,resident_id,measured_on,kind,measured_at,temp,sys_bp,dia_bp,pulse,spo2,note,symptom,recorded_by,rev,created_at'
const MEAL_COLS = 'id,resident_id,meal_on,meal_slot,main_amount,side_amount,status,note,recorded_by,rev'
const FLUID_COLS = 'id,resident_id,taken_on,taken_at,amount_ml,kind,recorded_by,rev,created_at'
// ended_by（継続を終了した職員・0001 からある列）は F08（2026-10-10）で読むようにした。〔くらべて選ぶ〕の基準と表示が
// 「未入力」のままだと、2台目の終了が何度送っても競合のまま終わらなかったため
const NOTE_COLS =
  'id,note_on,shift,facility,category,resident_id,role_tags,importance,body,occurred_at,ongoing,ended_at,ended_by,reporter_id,color,after16,rev,created_at'
const OUTING_COLS = 'id,resident_id,kind,start_on,start_at,end_on,end_at,companion,note,recorded_by,rev'
const ATTENDANCE_COLS = 'day,staff_id,role,sort'
const IMPORT_DAY_COLS = 'source,day,imported_at,src_rows,inserted,updated,skipped,native_skip,unmatched'
/**
 * 入浴記録（0012_bath_records.sql）。監査列・client_key は端末へ持ち出さない。
 * auto（自動で入った記録の印）は 0015_auto_check.sql で追加（0015 を当ててからこの版を公開する）
 */
const BATH_COLS = 'id,resident_id,bath_on,result,cancel_reason,note,recorded_by,rev,auto'
/** 服薬の時間帯（0013_med_admin.sql）。監査列・client_key は端末へ持ち出さない */
const MED_SLOTS_COLS = 'id,resident_id,slots,note,rev'
/**
 * 与薬の記録（0013_med_admin.sql）。client_key・監査列（updated_at・deleted_*・edited_by）は持ち出さない。
 * created_at だけは画面が「いつ記録したか」（時間帯の記録の時刻）に使うので読む。
 * auto（自動で入った記録の印）は 0015_auto_check.sql で追加（0015 を当ててからこの版を公開する）
 */
const MED_ADMIN_COLS =
  'id,resident_id,admin_on,slot,status,given_at,prn_drug,prn_reason,prn_effect,note,recorded_by,rev,created_at,auto'
/**
 * 事故・ヒヤリハットの一覧・カルテ・集計で読む列（0014_incidents.sql）。様式の残りの欄（detail）は持ち出さない
 * （detail には対象者の氏名の写しが入る。一覧・カルテ・集計は名簿の氏名を使う）。client_key・監査列も持ち出さない
 */
const INCIDENT_LIST_COLS =
  'id,kind,resident_id,occurred_on,occurred_at,office,place,place_other,types,severity,status,report_stage,report_no,' +
  'submitted_on,city_report_needed,city_reported_on,reporter_id,confirmer_id,confirmed_at,closed_at,rev'
/** 1件の入力・編集・印刷で読む列（detail を含む） */
const INCIDENT_COLS = `${INCIDENT_LIST_COLS},detail`

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
  | 'forbidden' // このアカウントは記録アプリを使えない（許可リストに無い・無効。403 / 42501・F61）

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
  notesPending:
    'サーバー側の更新待ちのため、保存済みの申し送りの変更はこの端末に保存して送信待ちにしています。サーバーが更新されると自動で送ります（新しい申し送りの登録はそのまま送れます）。',
  notKept:
    'この端末に控えを残せませんでした（保存領域の不足など）。入力は画面に残っています。この画面を閉じずに、もう一度お試しください。',
  forbidden:
    'このアカウントでは記録アプリを使えません（許可リストに無い、または無効になっています）。施設の Google アカウントでログインし直すか、管理者に連絡してください。',
  outdated:
    'この端末のアプリは古い版のため、記録できません（記録の形が新しくなりました）。〔更新〕を押して新しい版にしてください。送れていない記録は端末に残っていて、更新した後に送られます。',
} as const

/** 許可リスト外のアカウントへの案内（F61。画面が入力解禁の forbidden を受けた時に出す） */
export const FORBIDDEN_REASON: string = MSG.forbidden

/** 古い版の端末への案内（F28③。入力解禁の outdated・書込の入口で止めた時に出す） */
export const OUTDATED_REASON: string = MSG.outdated

function serverMsg(action: '読み込め' | '保存でき' | '操作でき', code: string): string {
  const tail = code === '' ? '' : `（コード: ${code}）`
  return `${action}ませんでした（サーバーエラー）${tail}。しばらく待ってから再試行してください。続く場合は管理者に連絡してください。`
}

/**
 * サーバーに拒否された時の例外（F61）。権限の拒否（403・42501）は、許可リストから外れた・無効にされたアカウントで
 * 起きる（RLS member_only）。待っても直らないので「サーバーエラー・しばらく待って再試行」とは別の案内にする。
 * 再ログインの導線（fireAuthExpired）へは回さない（同じアカウントで入り直しても直らず、送り直しを繰り返すため）
 */
function rejectError(action: '読み込め' | '保存でき' | '操作でき', code: string, status = 0): DbError {
  if (status === 403 || code === '42501') return new DbError('forbidden', MSG.forbidden)
  return new DbError('server', serverMsg(action, code))
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

/**
 * 1回の問い合わせに応答待ちの上限を付ける（その問い合わせだけ。クライアント全体の fetch には付けない）。
 * 上限を過ぎたら中断を頼み（abortSignal が使える時）、通信断と同じ応答（status 0）を返す＝呼び手の既存の安全側
 * （一時エラー→送信待ちへ退避）に乗せる。ms を省くと待ち続ける
 */
async function withTimeout(
  run: (signal: AbortSignal | null) => PromiseLike<Res<unknown>>,
  ms: number | undefined,
): Promise<Res<unknown>> {
  if (ms === undefined || !(ms > 0) || typeof AbortController !== 'function') return await run(null)
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const timedOut = new Promise<Res<unknown>>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort()
      resolve({ data: null, error: { message: 'timeout', code: '' }, status: 0 } as unknown as Res<unknown>)
    }, ms)
  })
  try {
    return await Promise.race([Promise.resolve(run(ctrl.signal)), timedOut])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 送信の経路（送信ロック・同じタブの送信の順番待ちの中）の1要求の応答待ちの上限（ms・F04）。応答の返らない要求が
 * 1件あると、そのタブの送信がすべて止まり、保存も「保存中」のまま戻らなかった。上限を過ぎた要求は通信断（status 0）と
 * 同じ扱いで送り直す（apply_cell_edits・apply_note_edits は同じ値なら「済み」、insert は冪等キー、update は 0行の時の
 * 読み直し＝F02 で、届いていても二重にならない）。サーバーのロック待ちは statement_timeout で切れる（0011・0017）ので、
 * それより長くする（申し送りの登録の上限 L7-1 と同じ考え方）
 */
let sendReqTimeoutMs = 25_000

/**
 * 送信の経路の問い合わせ1件に応答待ちの上限を付ける（F04）。中断できるビルダー（abortSignal）なら中断も頼む。
 * クライアント全体の fetch には付けない（月表・印刷などの大きな読み取りを切らない）
 */
function bounded(q: PromiseLike<unknown>): Promise<Res<unknown>> {
  return withTimeout((signal) => {
    const b = q as unknown as { abortSignal?: (s: AbortSignal) => PromiseLike<unknown> }
    const run = signal !== null && typeof b.abortSignal === 'function' ? b.abortSignal(signal) : q
    return run as PromiseLike<Res<unknown>>
  }, sendReqTimeoutMs)
}

/**
 * ログインの控え（session）が無いか（F58・2026-10-10）。supabase-js はトークンの更新が通信エラーで失敗すると、その後の
 * 約60秒（失敗の控えの期間）は session=null を返し、要求を anon キーで出す。anon では RLS で行が見えないだけで、エラーに
 * ならない（select は0行・rev 照合の update も0行）。この間の「0行」を競合・空の名簿・未解禁と断定すると、送信待ちが
 * 二度と送られない・利用者0人・「スプレッドシート期間」の誤表示になる。判定を確定する直前（0行→競合、空→0件・未解禁、
 * 拒否→止める）にだけ呼ぶ。確かめる手段を持たないクライアント（試験の偽物）は false（従来どおり）。
 * src/lib/supabase.ts は凍結契約なので、関門はここ（db.ts）に置く
 */
async function sessionMissing(sb: SupabaseClient): Promise<boolean> {
  const auth = (sb as unknown as { auth?: { getSession?: () => Promise<unknown> } }).auth
  if (auth === undefined || auth === null || typeof auth.getSession !== 'function') return false
  try {
    const data = asRecord(asRecord(await auth.getSession())?.data)
    return data === null || data.session === null || data.session === undefined
  } catch {
    return true // 確かめられない＝ログイン中とは断定しない（送らない・観測しない側）
  }
}

/** 一覧の読み取りが0件で、ログインの控えも無い（anon で読んだ＝見えなかっただけ）なら通信エラーにする（F58） */
async function assertSessionIfEmpty(sb: SupabaseClient, count: number): Promise<void> {
  if (count === 0 && (await sessionMissing(sb))) throw new DbError('network', MSG.networkRead)
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
  return rejectError('読み込め', errCode(res), res.status)
}

/** キューに載せない書込（削除・部分更新）の失敗をユーザー向けエラーへ変換する */
function writeError(res: Res<unknown>): DbError {
  if (isAuthFail(res)) {
    fireAuthExpired()
    return new DbError('auth', MSG.authWrite)
  }
  if (isTransient(res)) return new DbError('network', MSG.networkWrite)
  return rejectError('操作でき', errCode(res), res.status)
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

/** ログインの出来事を受けて送り直す（attachAuthWatch と試験の差し込み口から呼ぶ） */
async function onAuthEvent(event: string): Promise<void> {
  if (event !== 'SIGNED_IN' && event !== 'TOKEN_REFRESHED') return
  // ログインし直した: 拒否で止まった退避 op を1回だけ送り直す（F37。権限が直った後なら届く。TOKEN_REFRESHED では解かない）。
  // 許可リスト外の印（F61）も外す（別のアカウントで入り直した。次の入力解禁の確認で確かめ直す）
  if (event === 'SIGNED_IN') {
    memberDenied = false
    await retryRejectedOnce().catch(() => undefined)
  }
  await flushQueue(true)
}

function attachAuthWatch(sb: SupabaseClient): void {
  if (authWatchAttached) return
  authWatchAttached = true
  // 再ログイン・トークン更新に成功したら、退避してある書込を自動で送り直す。
  // 直前の 401 で待ち時間が伸びていても送る（force）＝「再ログインすると自動で送信されます」を守る
  sb.auth.onAuthStateChange((event) => {
    void onAuthEvent(event)
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
  // 作成時刻は「翌」の判定のために控える（返さない経路では何もしない＝前に控えた値を使う）
  rememberCreatedAt('vitals', id, r.created_at)
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
  // 作成時刻は「翌」の判定のために控える（返さない経路では何もしない＝前に控えた値を使う）
  rememberCreatedAt('fluid_intake', id, r.created_at)
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
  // 作成時刻は「翌」の判定のために控える（返さない経路では何もしない＝前に控えた値を使う）
  rememberCreatedAt('notes', id, r.created_at)
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
  // 継続を終了した職員（F08）。列を返さない経路（0017 の応答・タイムラインの RPC）では付けない＝「分からない」。
  // 分からないのに null を基準にして送ると、自分で競合を作るため（null と区別する）
  if (Object.prototype.hasOwnProperty.call(r, 'ended_by')) note.ended_by = idNum(r.ended_by)
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

function normalizeBath(row: unknown): BathRecord | null {
  const r = asRecord(row)
  if (!r) return null
  const id = idNum(r.id)
  const resident_id = idNum(r.resident_id)
  const bath_on = dateStr(r.bath_on)
  const result = oneOf<BathResult>(r.result, BATH_RESULTS)
  if (id === null || resident_id === null || bath_on === null || result === null) return null
  return {
    id,
    resident_id,
    bath_on,
    result,
    // 中止以外は理由を持たない（DB の check と同じ。受信値を信じない）
    cancel_reason: result === 'cancel' ? oneOf<BathCancelReason>(r.cancel_reason, BATH_CANCEL_REASONS) : null,
    note: str(r.note),
    recorded_by: idNum(r.recorded_by),
    rev: num(r.rev) ?? 1,
    // 自動で入った記録の印（true の時だけ自動。無い・読めない値は手動として扱う）
    auto: r.auto === true,
  }
}

function normalizeMedSlotsRow(row: unknown): MedSlotsSetting | null {
  const r = asRecord(row)
  if (!r) return null
  const id = idNum(r.id)
  const resident_id = idNum(r.resident_id)
  if (id === null || resident_id === null) return null
  return {
    id,
    resident_id,
    // 知らない値・重複は落とし、朝→昼→夕→眠前の順にそろえる（DB の check と同じ。受信値を信じない）
    slots: normalizeMedSlots(r.slots),
    note: str(r.note),
    rev: num(r.rev) ?? 1,
  }
}

function normalizeMedAdmin(row: unknown): MedAdmin | null {
  const r = asRecord(row)
  if (!r) return null
  const id = idNum(r.id)
  const resident_id = idNum(r.resident_id)
  const admin_on = dateStr(r.admin_on)
  const slot = oneOf<MedAdminSlot>(r.slot, MED_ADMIN_SLOTS)
  const status = oneOf<MedStatus>(r.status, MED_STATUSES)
  if (id === null || resident_id === null || admin_on === null || slot === null || status === null) return null
  const prn = slot === 'prn'
  return {
    id,
    resident_id,
    admin_on,
    slot,
    status,
    // 頓服以外は頓服の項目を持たない（DB の check と同じ考え方。受信値を信じない）
    given_at: prn ? str(r.given_at) : null,
    prn_drug: prn ? str(r.prn_drug) : null,
    prn_reason: prn ? str(r.prn_reason) : null,
    prn_effect: prn ? str(r.prn_effect) : null,
    note: str(r.note),
    recorded_by: idNum(r.recorded_by),
    rev: num(r.rev) ?? 1,
    created_at: str(r.created_at),
    // 自動で入った記録の印（true の時だけ自動。無い・読めない値は手動として扱う）
    auto: r.auto === true,
  }
}

/** 事故・ヒヤリハット（受信値を信じない: 知らない選択肢は null／配列から外す。detail が無い列の取得では空の既定値） */
function normalizeIncident(row: unknown): Incident | null {
  const r = asRecord(row)
  if (!r) return null
  const id = idNum(r.id)
  const kind = oneOf<IncidentKind>(r.kind, INCIDENT_KINDS)
  const occurred_on = dateStr(r.occurred_on)
  const occurred_at = str(r.occurred_at)
  if (id === null || kind === null || occurred_on === null || occurred_at === null) return null
  const reportNo = num(r.report_no)
  const status = oneOf<IncidentStatus>(r.status, INCIDENT_STATUSES) ?? 'open'
  return {
    id,
    kind,
    resident_id: idNum(r.resident_id),
    occurred_on,
    occurred_at,
    office: oneOf<IncidentOffice>(r.office, INCIDENT_OFFICES),
    place: oneOf<IncidentPlace>(r.place, INCIDENT_PLACES),
    place_other: str(r.place_other),
    types: normalizeChoices(r.types, INCIDENT_TYPES),
    severity: oneOf<IncidentSeverity>(r.severity, INCIDENT_SEVERITIES),
    status,
    // 完了の時だけ持つ（DB の check と同じ考え方。受信値を信じない）
    closed_at: status === 'closed' ? str(r.closed_at) : null,
    report_stage: oneOf<IncidentReportStage>(r.report_stage, INCIDENT_REPORT_STAGES),
    report_no: reportNo !== null && Number.isInteger(reportNo) ? reportNo : null,
    submitted_on: dateStr(r.submitted_on),
    city_report_needed: r.city_report_needed === true,
    city_reported_on: dateStr(r.city_reported_on),
    reporter_id: idNum(r.reporter_id),
    confirmer_id: idNum(r.confirmer_id),
    confirmed_at: str(r.confirmed_at),
    detail: normalizeIncidentDetail(r.detail),
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

/**
 * 旧経路（HEAD の送り方）のまま送る業務表。
 * bath_records（入浴記録・2026-09-26 追加）と med_slots / med_admin（服薬の時間帯・与薬の記録・2026-09-26 追加）も
 * 同じ経路に乗せる（client_key・rev 照合・送信待ち・edited_by）。
 * incidents（事故・ヒヤリハット・2026-09-26 追加）も同じ経路（自然キーは持たない）。
 * 入力解禁の判定だけは表ごとに違う（writeGate: 入浴は input_enabled_bath、服薬は input_enabled_med、事故は input_enabled_incident）
 */
type LegacyTable = 'fluid_intake' | 'notes' | 'outings' | 'bath_records' | 'med_slots' | 'med_admin' | 'incidents'

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
   * サーバーに受け付けられなかった回数（F31。通信不能・認証切れは数えない＝圏外が続いた op が1回の拒否で止まらない）。
   * MAX_TRIES に達したら自動再送を止める。無い＝0（旧版が積んだ op）
   */
  rejects?: number
  /** 最後に受け付けられなかった時のエラーコード（F31。DB の版の食い違いに由来する拒否は、次の起動で1回だけ送り直す） */
  errCode?: string
  /** 直前の失敗が通信不能・認証切れ（F06。他の送信が届いた時・画面に戻った時は待ち時間を置かずに送り直す） */
  netFail?: true
  /**
   * 拒否で止まった後、ログインし直した時に1回だけ送り直した印（F37。権限の直った後の再ログインで送れるように。
   * 恒久的な拒否で送り直しを繰り返さないよう1回まで。旧版が書き戻して印が消えても、送り直すのがもう1回増えるだけ）
   */
  authRetried?: true
  /**
   * 積んだ（引き取った）タブの印（F03 手直し・2026-10-10）。送信ロックを取ったタブは、この印のタブが閉じている
   * （そのタブの生存の Web Lock が無い）op だけを引き取る。印の無い op（旧ビルドが積んだ分）は引き取らない＝従来どおり
   * 次の起動で送る。生きているタブの op を横取りすると、元のタブが続けて直した値が自分の変更との「競合」で止まるため
   */
  owner?: string
  /**
   * 送信中（この op の応答待ち）。統合先にしない印。
   * 送信リクエストを出した後のペイロード差し替えは、応答が 'sent' になった時点で
   * 「送っていない入力」ごとキューから消えてしまう（観測なしの消滅）。localStorage には残さない。
   */
  sending?: boolean
}

/** 水分・申し送り・外出・入浴への insert / update（HEAD と同じ形） */
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

const LEGACY_TABLES: readonly LegacyTable[] = [
  'fluid_intake',
  'notes',
  'outings',
  'bath_records',
  'med_slots',
  'med_admin',
  'incidents',
]

/** 旧版が使っていた退避キー。値は cl_sendQueue の中へ移し、移せたことを観測してから取り除く */
const LEGACY_BROKEN_KEY = `${LS.sendQueue}_broken`

let queue: QueueOp[] = []
let queueBroken = false
/** 読めなかった原文。cl_sendQueue の brokenRaw として持ち続ける（消さずに残すため） */
let queueBrokenRaw: string | null = null
/** cl_sendQueue2 の中の読めなかった原文。cl_sendQueue2 の brokenRaw として持ち続ける */
let cellBrokenRaw: string | null = null
/**
 * cl_sendQueue2 の brokenRaw から外した行（救い出して rows へ戻した行・利用者が取り下げた行）。
 * 保存先の古い原文を読み直しても brokenRaw へ戻さない（この起動の間）
 */
const droppedBroken = new Set<string>()
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
  const rejects = num(r.rejects)
  if (rejects !== null && rejects > 0) base.rejects = rejects
  const code = str(r.errCode)
  if (code !== null && code !== '') base.errCode = code
  if (r.netFail === true) base.netFail = true
  if (r.authRetried === true) base.authRetried = true
  const owner = str(r.owner)
  if (owner !== null && owner !== '') base.owner = owner

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
  if (where === 'cells') {
    // cl_sendQueue2 の原文は1行ずつの集まりとして持つ（2026-09-29。旧ビルドが畳んだ申し送りの行を救い出した後、
    // 救い出した行・利用者が取り下げた行を、保存先の古い原文から戻さないため）
    const have = cellBrokenRaw === null ? [] : cellBrokenRaw.split('\n')
    const set = new Set(have)
    for (const c of chunks) {
      for (const line of c.split('\n')) {
        if (line === '' || set.has(line) || droppedBroken.has(line)) continue
        set.add(line)
        have.push(line)
      }
    }
    cellBrokenRaw = have.length === 0 ? null : have.join('\n')
    if (cellBrokenRaw !== null) queueBroken = true
    return
  }
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
function parseQueueOps(
  rawOps: unknown,
  requireQid: boolean,
): { ops: QueueOp[]; dropped: string[]; foreign: Record<string, unknown>[] } {
  const ops: QueueOp[] = []
  const dropped: string[] = []
  const foreign: Record<string, unknown>[] = []
  if (!Array.isArray(rawOps)) return { ops, dropped, foreign }
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
    if (op !== null) ops.push(op)
    else if (isForeignOp(row)) foreign.push(row as Record<string, unknown>)
    else dropped.push(rawOf(row))
  }
  return { ops, dropped, foreign }
}

/** この版が知っている退避 op の表・種別 */
const KNOWN_OP_TABLES: readonly string[] = [...LEGACY_TABLES, 'vitals', 'meals', 'note_reads', 'attendance', 'residents']
const KNOWN_OP_KINDS: readonly string[] = ['insert', 'update', 'read', 'attendance', 'alias']

/**
 * この版が知らない表・種別の op（新しい版のタブが積んだ分。F27②）か。形（qid・表・種別・中身）は整っているもの。
 * brokenRaw へ畳まずに cl_sendQueue の ops へ原文のまま残す（この版は送らないが、数えて残す＝次に新しい版で開けば送られる）。
 * 知っている表・種別で形が壊れている op は従来どおり brokenRaw へ
 */
function isForeignOp(row: unknown): boolean {
  const r = asRecord(row)
  if (r === null || typeof r.qid !== 'string' || r.qid === '' || asRecord(r.payload) === null) return false
  if (typeof r.table !== 'string' || typeof r.kind !== 'string') return false
  return !KNOWN_OP_TABLES.includes(r.table) || !KNOWN_OP_KINDS.includes(r.kind)
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

/** 欄ごとの送信待ちを持つ表（RPC apply_cell_edits で送る表） */
export type CellTable = 'vitals' | 'meals'
/**
 * 送信待ち（cl_sendQueue2 の rows）に載る表。申し送り（notes）は 2026-09-29 に加えた（RPC apply_note_edits・0017）。
 * 申し送りの行キーは notes#<id>（既にある行の変更・取り消しだけ。新規登録は従来の insert・client_key の経路）
 */
type RowTable = CellTable | 'notes'
/** 申し送りで送れる欄（0017 apply_note_edits の許可リストから取り消し deleted_at を除いたもの） */
export type NoteEditField =
  | 'body'
  | 'resident_id'
  | 'importance'
  | 'color'
  | 'after16'
  | 'occurred_at'
  | 'reporter_id'
  | 'role_tags'
  | 'shift'
  | 'ongoing'
  | 'ended_at'
  | 'ended_by'
/** 0017 の許可リスト（取り消し deleted_at を含む。deleted_at の基準は「見た本文」） */
const NOTE_CELL_FIELDS: readonly string[] = [
  'body',
  'resident_id',
  'importance',
  'color',
  'after16',
  'occurred_at',
  'reporter_id',
  'role_tags',
  'shift',
  'ongoing',
  'ended_at',
  'ended_by',
  'deleted_at',
]
/** 申し送りの行の指し方（既にある行の id） */
export type NoteTarget =
  /** 既にある行（id）。fork は別のタブの入力と食い違った時に分けて持つ入力の印（下の「分けて持つ」） */
  | { id: number; fork?: string }
  /**
   * 送信待ち・応答待ちの登録（冪等キー client_key）の行（2026-09-29 第3巡 チーフ裁定）。登録の op の中身は二度と
   * 書き換えず、登録を押した後にその行へ加えた変更はすべて notes#ck:<client_key> に積む（基準＝登録で送った値）。
   * 登録が届いた後に client_key で行を見つけ、notes#<id> と同じく apply_note_edits で送る
   */
  | { clientKey: string; fork?: string }
/**
 * 送信待ちの申し送りの控え（どの日・どの区分・どの対象の行か）。「送れていない申し送り」の一覧で日ごとに出す・
 * 〔新しい行として登録〕で同じ日・同じ区分・同じ対象に作るために、保存の時に画面が渡す。本文は持たない（本文は欄の値）
 */
export interface NoteMeta {
  note_on: string
  shift: Shift
  resident_id: number | null
  after16: boolean
}
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
const CELL_FILL_KEYS: Record<RowTable, readonly string[]> = {
  vitals: ['measured_at', 'recorded_by'],
  meals: ['recorded_by'],
  notes: [],
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
  /**
   * 申し送りの取り消しが「見た行」（seen）と食い違って止まった時の、食い違った欄（F09・0027）。
   * 本文が同じでも、重要度・対象・継続などが他の端末で直されていたら入る。旧いサーバー（0017）では付かない
   */
  fields?: string[]
}

/** 欄の値（申し送りの区切り・継続は真偽、職種タグは文字の配列） */
type CellValue = number | string | boolean | string[] | null

/** 送信待ちの1欄 */
interface CellEdit {
  value: CellValue
  /** 基準。キーが無い＝分からない */
  base?: CellValue
  /** 最後に値を受けた時刻（送る順・別タブとの突き合わせに使う） */
  at: number
  /** 版（タブの印.連番）。応答で消してよいかの見分けに使う */
  ver: string
  /**
   * この値を入力した職員（F07。送信待ちの間に別の職員が同じ行へ入力した時、職員ごとに分けて edited_by を送る）。
   * キーが無い＝分からない（旧版の控え・旧形式の読み替え）＝行の editor を使う
   */
  by?: number | null
  /**
   * 申し送りの取り消し（deleted_at）だけ: 取り消すと決めた時に画面に出ていた行の欄（F09・0027）。サーバーは base（見た本文）に
   * 加えて、ここに書いた欄がすべていまの値のままの時だけ取り消す。キーが無い＝旧版の控え（本文だけで判定＝従来どおり）
   */
  seen?: Record<string, CellValue>
}

type CellState = 'pending' | 'conflict' | 'rejected'

/** 送信待ちの1行（localStorage の rows に入る形） */
interface CellEntry {
  table: RowTable
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
  /**
   * 申し送り: 旧ビルドが rev 照合で退避した変更（cl_sendQueue の notes の update）を読み替えた行の、その時の rev。
   * 基準（編集を始めた時の値）を持たないので、送る直前に1行読み、rev が同じなら「いまの値＝基準」として基準を埋める
   * （rev が違えば基準は分からないまま送る＝サーバーは空の欄だけ書き、本文は競合で止める）
   */
  baseRev?: number
  /** 申し送り: どの日・区分・対象の行か（画面が保存の時に渡す控え。旧形式から読み替えた行には無い） */
  meta?: NoteMeta
  state: CellState
  conflicts?: CellConflict[]
  tries: number
  nextAt: number
  /** 最後に書いたタブの印 */
  tab: string
  /** 最後に書き換えた時刻（別タブとの突き合わせで新しい方の状態を採る） */
  at: number
  /** 直前の送信の失敗が通信不能・認証切れ（F06。つながったと分かった時は待ち時間を置かずに送り直す） */
  netFail?: true
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

/**
 * 退避 op（cl_sendQueue）の「送り終えた・取り下げた」印（墓標・2026-10-10 F05・F03）。cl_sendQueue2 の done に
 * 行キー op:<qid> で同じ形の記録として置く（全タブが書込ロックの中で和集合を取っている既存の仕組みに乗せる。
 * cl_sendQueue の形 { ops, brokenRaw } は HEAD c592dad のまま変えない＝旧ビルドへ戻しても読み書きできる。
 * cl_sendQueue に done を足すと parseStore1 が「移す分あり」と読み、cl_sendQueue2 に書けない間 cl_sendQueue まで
 * 書けなくなる）。版には op の中身の指紋を入れる（墓標を付けた後に元のタブが同じ op へ重ねた入力は、指紋が変わるので
 * 外さない＝見せていない入力を消さない）。旧ビルドはこの記録を読み飛ばすだけ（バイタル・食事の行キーと重ならない）
 */
const OP_MARK_PREFIX = 'op:'
/** 墓標を持つ期間（送り終えた op を古い控えのまま長く開いている別のタブから復活させない猶予） */
const OP_DONE_KEEP_MS = 8 * 24 * 60 * 60 * 1000
const OP_DONE_MAX = 500

/**
 * DB の版の食い違い（新しい画面×移行を当てていない DB）に由来する拒否のエラーコード（F31）。check 制約違反・列や表が無い・
 * スキーマのキャッシュに無い。これらで止まった op は、起動のたびに1回だけ送り直す（移行を当てた後に自動で回復する）
 */
const SCHEMA_REJECT_CODES: ReadonlySet<string> = new Set(['23514', '42703', '42P01', 'PGRST204', 'PGRST205'])

/** この起動（タブ）の印。欄の版の先頭に付け、どのタブが書いた版かを見分ける */
let tabId = newTabId()
/**
 * タブの生存の Web Lock の名前の頭（F03 手直し）。各タブは開いている間ずっと `cl_tab_<tabId>` を持ち、閉じる・破棄されると
 * ブラウザが手放す。送信ロックを取ったタブは navigator.locks.query() でこれを見て、持ち主が閉じた op だけを引き取る
 */
const TAB_LOCK_PREFIX = 'cl_tab_'
/** このタブの生存の Web Lock を手放す（試験で「タブを閉じた」を再現する・起動のやり直しで持ち替える） */
let releaseTabLock: (() => void) | null = null
holdTabLock()
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

/** 記録の和集合（同じ版は1つ・古い記録と多すぎる分は捨てる。退避 op の墓標は別の期間・件数で持つ） */
function unionDone(a: DoneMark[], b: DoneMark[]): DoneMark[] {
  const byVer = new Map<string, DoneMark>()
  for (const m of [...a, ...b]) {
    const cur = byVer.get(m.v)
    if (cur === undefined || m.t > cur.t) byVer.set(m.v, m)
  }
  const now = Date.now()
  const cells: DoneMark[] = []
  const ops: DoneMark[] = []
  for (const m of byVer.values()) {
    if (isOpMark(m)) {
      if (m.t >= now - OP_DONE_KEEP_MS) ops.push(m)
    } else if (m.t >= now - DONE_KEEP_MS) cells.push(m)
  }
  const cap = (xs: DoneMark[], n: number): DoneMark[] => {
    xs.sort((x, y) => x.t - y.t)
    return xs.length > n ? xs.slice(xs.length - n) : xs
  }
  const out = [...cap(cells, DONE_MAX), ...cap(ops, OP_DONE_MAX)]
  out.sort((x, y) => x.t - y.t)
  return out
}

/** 退避 op の墓標か（バイタル・食事・申し送りの欄の記録ではない） */
function isOpMark(m: DoneMark): boolean {
  return m.k.startsWith(OP_MARK_PREFIX)
}

/** 文字列の短い指紋（FNV-1a 32bit・36進） */
function textTag(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** 退避 op の墓標の版（qid と中身の指紋。中身が変わった op は別の版＝墓標で外さない） */
function opMarkVer(op: QueueOp): string {
  const text = rawOf([op.table, op.kind, 'rowId' in op ? (op.rowId ?? null) : null, 'rev' in op ? (op.rev ?? null) : null, op.payload])
  return `${OP_MARK_PREFIX}${op.qid}:${textTag(text)}`
}

/** 退避 op を「送り終えた（sent）・取り下げた（drop）」と記録する（次の書き戻しで保存先にも残り、他のタブが外す） */
function markOpDone(op: QueueOp, why: 'sent' | 'drop'): void {
  doneMarks.push({ k: `${OP_MARK_PREFIX}${op.qid}`, f: why, v: opMarkVer(op), at: op.at, t: Date.now() })
}

/** 墓標の版の集まり（このタブの記録＋保存先から読んだ記録） */
function opDoneIndex(extra?: DoneMark[]): Set<string> {
  const out = new Set<string>()
  for (const m of doneMarks) if (isOpMark(m)) out.add(m.v)
  for (const m of extra ?? []) if (isOpMark(m)) out.add(m.v)
  return out
}

/** その op（同じ中身）に墓標が付いているか */
function isOpDone(op: QueueOp, idx: Set<string>): boolean {
  return idx.has(opMarkVer(op))
}

/** その qid の op を「送り終えた」と記録したタブがあるか（中身を問わない。取り下げの結果の見分けに使う） */
function opSentMarked(qid: string, extra?: DoneMark[]): boolean {
  const k = `${OP_MARK_PREFIX}${qid}`
  return [...doneMarks, ...(extra ?? [])].some((m) => m.k === k && m.f === 'sent')
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
  return textTag(JSON.stringify(v))
}

/**
 * このタブの生存の Web Lock を取って持ち続ける（F03 手直し）。navigator.locks が無い環境では何もしない（その環境では
 * 引き取り自体をしない）。取れなくても保存・送信は止めない（引き取られないだけ＝次の起動で送る）
 */
function holdTabLock(): void {
  const locks = webLocks()
  if (locks === null) return
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  releaseTabLock = release
  try {
    void locks.request(`${TAB_LOCK_PREFIX}${tabId}`, () => held).catch(() => undefined)
  } catch {
    releaseTabLock = null
  }
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

/** 送信待ちに載る表か（バイタル・食事・申し送り） */
function isRowTable(t: unknown): t is RowTable {
  return isCellTable(t) || t === 'notes'
}

function cellFieldsOf(table: RowTable): readonly string[] {
  return table === 'vitals' ? VITAL_CELL_FIELDS : table === 'meals' ? MEAL_CELL_FIELDS : NOTE_CELL_FIELDS
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
    // ── 申し送り（0017。欄の名前はバイタル・食事と重ならない） ──
    case 'body':
      return typeof v === 'string' ? v : undefined
    case 'resident_id':
    case 'reporter_id':
    case 'ended_by':
      return idNum(v) ?? undefined
    case 'importance':
      return oneOf(v, IMPORTANCES) ?? undefined
    case 'color':
      return oneOf(v, NOTE_COLORS) ?? undefined
    case 'shift':
      return oneOf(v, SHIFTS) ?? undefined
    case 'after16':
    case 'ongoing':
      return typeof v === 'boolean' ? v : undefined
    case 'occurred_at': {
      if (typeof v !== 'string') return undefined
      const m = CELL_TIME_RE.exec(v.trim())
      if (!m) return undefined
      const h = Number(m[1])
      if (h > 23 || Number(m[2]) > 59 || (m[3] !== undefined && Number(m[3]) > 59)) return undefined
      const sec = m[3] !== undefined && m[3] !== '00' ? `:${m[3]}` : ''
      return `${String(h).padStart(2, '0')}:${m[2]}${sec}`
    }
    case 'role_tags':
      return Array.isArray(v) && v.every((t) => typeof t === 'string') ? [...(v as string[])] : undefined
    case 'ended_at':
    case 'deleted_at':
      return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined
  }
  return undefined
}

/** 保存先から読んだ値（数値・文字列・真偽・文字の配列・null だけを受ける） */
function storedCellValue(v: unknown): CellValue | undefined {
  if (v === null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (Array.isArray(v) && v.every((t) => typeof t === 'string')) return [...(v as string[])]
  return undefined
}

/** 行の指し方を RPC の p_key へ。読めなければ null */
function keyOfTarget(
  table: RowTable,
  target: VitalTarget | MealTarget | NoteTarget,
): Record<string, string | number> | null {
  if (table === 'notes') {
    // 申し送りは既にある行の id か、送信待ちの登録の冪等キーで指す（新規登録そのものはこの経路を通らない）
    const t = target as NoteTarget
    const fork: Record<string, string> = typeof t.fork === 'string' && t.fork !== '' ? { fork: t.fork } : {}
    if ('clientKey' in t) {
      return typeof t.clientKey === 'string' && t.clientKey !== '' ? { client_key: t.clientKey, ...fork } : null
    }
    const id = idNum(t.id)
    return id === null ? null : { id, ...fork }
  }
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
function normalizeCellKey(table: RowTable, key: Record<string, unknown>): Record<string, string | number> | null {
  if (table === 'notes') {
    const fork = str(key.fork) ?? undefined
    if (Object.prototype.hasOwnProperty.call(key, 'id')) return keyOfTarget('notes', { id: idNum(key.id) ?? 0, fork })
    return keyOfTarget('notes', { clientKey: str(key.client_key) ?? '', fork })
  }
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

/**
 * 行キー（設計書: vitals@<利用者>|<日付>|routine ／ meals@<利用者>|<日付>|<食事枠> ／ vitals~<client_key> ／ vitals#<id> ／
 * 申し送り notes#<id>）
 */
function cellRowKey(table: RowTable, key: Record<string, string | number>): string {
  if (table === 'notes') {
    const base = key.id !== undefined ? `notes#${key.id}` : `notes#ck:${key.client_key}`
    return key.fork !== undefined ? `${base}!${key.fork}` : base
  }
  if (key.id !== undefined) return `${table}#${key.id}`
  if (table === 'meals') return `meals@${key.resident_id}|${key.meal_on}|${key.meal_slot}`
  if (key.client_key !== undefined) return `vitals~${key.client_key}`
  return `vitals@${key.resident_id}|${key.measured_on}|routine`
}

/** 保存先から読んだ1行を検め直す。読めない行は null（原文を brokenRaw に残す）・欄の無い行は 'empty' */
function normalizeCellEntry(raw: unknown): { rowKey: string; entry: CellEntry } | null | 'empty' {
  const r = asRecord(raw)
  if (r === null || !isRowTable(r.table)) return null
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
    // 入力した職員（F07）。キーがあって読めない値は「分からない」（null）
    if (Object.prototype.hasOwnProperty.call(e, 'by')) edit.by = idNum(e.by)
    if (Object.prototype.hasOwnProperty.call(e, 'base')) {
      const b = storedCellValue(e.base)
      if (b === undefined) return null
      edit.base = b
    }
    // 申し送りの取り消しの「見た行」（F09）。読めない控えは送らない（照合の弱い取り消しにしない＝原文を残して止める）
    if (Object.prototype.hasOwnProperty.call(e, 'seen')) {
      if (table !== 'notes' || f !== 'deleted_at') return null
      const seen = noteSeenOf(e.seen, (_f, x) => storedCellValue(x))
      if (seen === null) return null
      edit.seen = seen
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
  if (r.netFail === true) entry.netFail = true
  if (table === 'notes') {
    const br = num(r.baseRev)
    if (br !== null) entry.baseRev = br
    const meta = normalizeNoteMeta(r.meta)
    if (meta !== null) entry.meta = meta
  }
  if (Array.isArray(r.conflicts)) {
    const cs: CellConflict[] = []
    for (const c of r.conflicts) {
      const cr = asRecord(c)
      const field = str(cr?.field)
      const reason = oneOf(cr?.reason, ['changed', 'missing'] as const)
      if (cr === null || field === null || !fields.includes(field) || reason === null) continue
      const fs = conflictFieldsOf(cr.fields, fields)
      cs.push({ field, server: cr.server ?? null, base: cr.base ?? null, mine: cr.mine ?? null, reason, ...(fs !== null ? { fields: fs } : {}) })
    }
    if (cs.length > 0) entry.conflicts = cs
  }
  return { rowKey: cellRowKey(table, key), entry }
}

/** 取り消しの「見た行」に書ける欄（deleted_at を除く申し送りの欄。0027 の c_seen_fields と同じ） */
const NOTE_SEEN_FIELD_LIST = [
  'body',
  'resident_id',
  'importance',
  'color',
  'after16',
  'occurred_at',
  'reporter_id',
  'role_tags',
  'shift',
  'ongoing',
  'ended_at',
  'ended_by',
] as const
const NOTE_SEEN_FIELDS: readonly string[] = NOTE_SEEN_FIELD_LIST
/**
 * 端末が取り消しの「見た行」として送る欄（F09）。画面で見分けられ、変わっていたら消してはいけない欄に絞る
 * （記入者・職種・区分・時刻・16時以降・終了者まで照らすと、見えない理由で止まる件が増える）。サーバー（0027）は12欄すべてを受ける
 */
const NOTE_SEEN_SENT: readonly string[] = ['body', 'resident_id', 'importance', 'color', 'ongoing', 'ended_at']

/**
 * 取り消しの「見た行」（F09）を検め直す。read は1欄の値の読み方（画面から＝cellValueOf・保存先から＝storedCellValue）。
 * 知らない欄は落とす。読めない値が1つでもあれば null（照合できない取り消しを送らない）。欄が1つも無ければ null
 */
function noteSeenOf(
  v: unknown,
  read: (f: string, x: unknown) => CellValue | undefined,
): Record<string, CellValue> | null {
  const r = asRecord(v)
  if (r === null) return null
  const out: Record<string, CellValue> = {}
  for (const f of NOTE_SEEN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(r, f) || r[f] === undefined) continue
    const x = read(f, r[f])
    if (x === undefined) return null
    out[f] = x
  }
  return Object.keys(out).length > 0 ? out : null
}

/** 競合の fields（食い違った欄の名前・F09）。無い・読めなければ null */
function conflictFieldsOf(v: unknown, fields: readonly string[]): string[] | null {
  if (!Array.isArray(v)) return null
  const out = v.filter((x): x is string => typeof x === 'string' && fields.includes(x))
  return out.length > 0 ? out : null
}

/** 申し送りの控え（日・区分・対象）を検め直す。読めなければ null（控えが無いだけで、送信待ちそのものは読む） */
function normalizeNoteMeta(v: unknown): NoteMeta | null {
  const m = asRecord(v)
  if (m === null) return null
  const day = dateStr(m.note_on)
  const shift = oneOf(m.shift, SHIFTS)
  if (day === null || shift === null) return null
  return { note_on: day, shift, resident_id: idNum(m.resident_id), after16: bool(m.after16, false) }
}

/**
 * 旧ビルドが rev 照合で退避した申し送りの変更（cl_sendQueue の notes の update）を、送信待ちの1行（notes#<id>）へ
 * 読み替える（2026-09-29）。基準は分からない（キー無し）。退避した時の rev を baseRev に持ち、送る直前に1行読んで
 * rev が同じなら「いまの値＝基準」として埋める。止まっていた op（blocked）はその状態のまま（一覧から選び直せる）。
 * 送れない欄がある op は null（原文を brokenRaw に残す＝消さない）
 */
function convertLegacyNoteOp(r: Record<string, unknown>, verTag: string): { rowKey: string; entry: CellEntry } | null {
  const payload = asRecord(r.payload)
  const rowId = idNum(r.rowId)
  const rev = num(r.rev)
  if (payload === null || r.kind !== 'update' || rowId === null || rev === null) return null
  const at = num(r.at) ?? 0
  const edits: Record<string, CellEdit> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'edited_by' || k === 'read_count' || k === 'my_read') continue
    if (!NOTE_CELL_FIELDS.includes(k)) return null
    const value = cellValueOf(k, v)
    if (value === undefined) return null
    if (k === 'body' && (value === null || (typeof value === 'string' && value.trim() === ''))) return null
    edits[k] = { value, at, ver: `v1.${verTag}.${k}.${valueTag(value)}` }
  }
  if (Object.keys(edits).length === 0) return null
  const key = { id: rowId }
  const entry: CellEntry = {
    table: 'notes',
    key,
    edits,
    fill: {},
    editor: idNum(payload.edited_by),
    baseRev: rev,
    state: r.blocked === 'conflict' ? 'conflict' : r.blocked === 'rejected' ? 'rejected' : 'pending',
    tries: 0,
    nextAt: 0,
    tab: '',
    at,
    bound: true,
  }
  return { rowKey: cellRowKey('notes', key), entry }
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
    if (Object.prototype.hasOwnProperty.call(e, 'by')) out.by = e.by
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
  /** brokenRaw から op として読み戻せた行（F27①。書き戻しで ops に載せ、brokenRaw から外す） */
  rescued: string[]
  /** この版が知らない表・種別の op（新しい版のタブが積んだ分。原文のまま ops に残す・F27②） */
  foreign: Record<string, unknown>[]
}

/** cl_sendQueue2 の中身 */
interface Store2 {
  rows: Map<string, CellEntry>
  done: DoneMark[]
  /** 読めなかった原文（cl_sendQueue2 の brokenRaw へ畳む） */
  dropped: string[]
  brokenRaw: string | null
  /**
   * brokenRaw の中の申し送りの行のうち、同じ行キーの送信待ちと中身が食い違うため rows へ戻さなかったもの
   * （brokenRaw に残したまま、「送れていない申し送り」に別の本文として出す＝両方の本文を残す）
   */
  collided: { rowKey: string; entry: CellEntry; raw: string }[]
  /** この版が知らない表・欄を持つ行（新しい版のタブが積んだ分。行キー → 原文。rows に原文のまま残す・F27②） */
  foreign: Map<string, unknown>
}

/**
 * 旧ビルドへ戻した時に畳まれた申し送りの行を救い出す（2026-09-29・ロールバック互換）。
 * 旧ビルドは cl_sendQueue2 の rows の notes#<id> を読めずに brokenRaw へ畳み、rows から外して書き戻す。
 * その1行（JSON）を読み直して送信待ちの行に戻す。読めない・申し送りでない行は null（brokenRaw に残す）
 */
function rescueBrokenLine(line: string): { rowKey: string; entry: CellEntry } | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  // 申し送りに限らず、バイタル・食事の行も戻す（F27①。送り終えた・取り下げた版は和集合の時に done の記録で外れる）
  if (!isRowTable(asRecord(v)?.table)) return null
  const n = normalizeCellEntry(v)
  return n === null || n === 'empty' ? null : n
}

/** 救い出した行を、同じ行キーの送信待ちへ重ねられるか（同じ欄に違う値が無い＝どちらの入力も失わない） */
function rescueFits(prev: CellEntry, next: CellEntry): boolean {
  for (const [f, e] of Object.entries(next.edits)) {
    const cur = prev.edits[f]
    if (cur !== undefined && JSON.stringify(cur.value) !== JSON.stringify(e.value)) return false
  }
  return true
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
    // 申し送りの変更（update）は送信待ちの行へ読み替える（2026-09-29。下の HEAD の形と同じ扱い）
    const legacyRaw2: unknown[] = []
    if (Array.isArray(box.legacyOps)) {
      box.legacyOps.forEach((row, i) => {
        const r = asRecord(row)
        if (r === null || r.table !== 'notes' || r.kind !== 'update') {
          legacyRaw2.push(row)
          return
        }
        const qid = str(r.qid)
        const c = requireQid && qid === null ? null : convertLegacyNoteOp(r, qid ?? `m${i}`)
        if (c === null) {
          dropped.push(rawOf(r))
          return
        }
        const prev = cells.get(c.rowKey)
        if (prev === undefined) cells.set(c.rowKey, c.entry)
        else mergeConverted(prev, c.entry)
      })
    }
    const legacy = parseQueueOps(legacyRaw2, requireQid)
    return {
      legacy: legacy.ops,
      cells,
      migrating: true,
      dropped: dropped.concat(legacy.dropped),
      brokenRaw: str(box.brokenRaw),
      rescued: [],
      foreign: legacy.foreign,
    }
  }
  // HEAD の形（op の配列／{ ops, brokenRaw, done }）。done（送り終えた・解決した op の印）の op は読み込まない
  const rawOps0 = box === null ? parsed : box.ops
  // 旧ビルドのタブが知らない表の op（入浴・与薬・事故など）を brokenRaw へ畳んでいたら、op として読み戻す（F27①。
  // 戻した op は書き戻しで ops に載せ、brokenRaw から外す＝1回の setItem。書けなければ保存先の原文は元のまま）。
  // 出勤者は戻さない（古い一覧を送り直すと、後から足された職員を外しうる＝読めない原文のまま残して知らせる）
  const have = new Set((Array.isArray(rawOps0) ? rawOps0 : []).map((r) => str(asRecord(r)?.qid)).filter((q) => q !== null))
  const rescue = rescueBrokenOps(str(box?.brokenRaw), have)
  const rawOps = rescue.ops.length === 0 ? rawOps0 : [...(Array.isArray(rawOps0) ? rawOps0 : []), ...rescue.ops]
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
      // 申し送りの変更（update）も送信待ちの行へ読み替える（2026-09-29。新規登録 insert は従来の退避 op のまま）
      else if (r !== null && r.table === 'notes' && r.kind === 'update') cellRaw.push({ r, i })
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
    const c = r.table === 'notes' ? convertLegacyNoteOp(r, qid ?? `n${i}`) : convertLegacyCellOp(r, qid ?? `n${i}`)
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
    brokenRaw: rescue.lines.length === 0 ? str(box?.brokenRaw) : rescue.remain,
    rescued: rescue.lines,
    foreign: legacy.foreign,
  }
}

/**
 * cl_sendQueue の brokenRaw（1行＝1つの原文）のうち、この版が op として読める行を取り出す（F27①）。
 * 取り出すのは qid があり、この版で送れる形に読める op だけ（退避 op・バイタル/食事の旧形式・申し送りの変更）。
 * 送り終えた op の原文が残っていた場合も取り出す（書き戻しの時に墓標・送れた印で外れる＝「読み取れませんでした」が消える）
 */
function rescueBrokenOps(brokenRaw: string | null, have: Set<string | null>): { ops: unknown[]; lines: string[]; remain: string | null } {
  const ops: unknown[] = []
  const lines: string[] = []
  const remain: string[] = []
  if (brokenRaw === null) return { ops, lines, remain: null }
  for (const line of brokenRaw.split('\n')) {
    if (line === '') continue
    let v: unknown = null
    try {
      v = JSON.parse(line)
    } catch {
      v = null
    }
    const r = asRecord(v)
    const qid = str(r?.qid)
    let ok = false
    if (r !== null && qid !== null && qid !== '' && r.kind !== 'attendance' && !have.has(qid)) {
      if (isCellTable(r.table) && (r.kind === 'insert' || r.kind === 'update')) ok = convertLegacyCellOp(r, qid) !== null
      else if (r.table === 'notes' && r.kind === 'update') ok = convertLegacyNoteOp(r, qid) !== null
      else ok = normalizeQueueOp(r) !== null
    }
    if (ok) {
      ops.push(v)
      lines.push(line)
      have.add(qid)
    } else remain.push(line)
  }
  return { ops, lines, remain: remain.length === 0 ? null : remain.join('\n') }
}

/** cl_sendQueue2 の原文を読む（JSON として読めない・形が違えば例外） */
function parseStore2(raw: string): Store2 {
  const box = asRecord(JSON.parse(raw))
  if (box === null || box.ver !== 2) throw new Error('unknown shape')
  const rows = new Map<string, CellEntry>()
  const dropped: string[] = []
  const foreign = new Map<string, unknown>()
  for (const [k, v] of Object.entries(asRecord(box.rows) ?? {})) {
    const n = normalizeCellEntry(v)
    if (n === 'empty') continue
    if (n === null) {
      // 新しい版のタブが積んだ、この版が知らない表・欄の行は原文のまま rows に残す（F27②。brokenRaw へ畳まない）
      if (isForeignRow(v)) foreign.set(k, v)
      else dropped.push(rawOf(v))
      continue
    }
    const prev = rows.get(n.rowKey)
    if (prev === undefined) rows.set(n.rowKey, n.entry)
    else mergeConverted(prev, n.entry)
  }
  // 旧ビルドが畳んだ申し送りの行を rows へ戻す（戻した行は brokenRaw から外す。書き戻しは1回の setItem で、
  // rows に入った中身ごと読み直して確かめる＝persistUnderLock。書けなければ保存先の原文はそのまま残る）
  const collided: Store2['collided'] = []
  const remaining: string[] = []
  const br = str(box.brokenRaw)
  if (br !== null) {
    for (const line of br.split('\n')) {
      if (line === '' || droppedBroken.has(line)) continue
      const r = rescueBrokenLine(line)
      if (r === null) {
        remaining.push(line)
        continue
      }
      const prev = rows.get(r.rowKey)
      if (prev === undefined) {
        rows.set(r.rowKey, r.entry)
        continue
      }
      if (rescueFits(prev, r.entry)) {
        for (const [f, e] of Object.entries(r.entry.edits)) if (prev.edits[f] === undefined) prev.edits[f] = e
        if (prev.meta === undefined && r.entry.meta !== undefined) prev.meta = r.entry.meta
        continue
      }
      // 同じ欄に違う値がある: どちらも捨てない（救い出した方は brokenRaw に残し、一覧に別の本文として出す）
      remaining.push(line)
      collided.push({ ...r, raw: line })
    }
  }
  return {
    rows,
    done: normalizeDone(box.done),
    dropped,
    brokenRaw: remaining.length === 0 ? null : remaining.join('\n'),
    collided,
    foreign,
  }
}

/**
 * 送信待ちの行のうち、この版が知らない表・欄を持つ（新しい版のタブが積んだ）ものか（F27②）。行の形（表・行キー・欄の
 * 編集）は整っていて、表かいずれかの欄名をこの版が知らない時だけ。知っている表・欄で値が壊れている行は従来どおり brokenRaw へ
 */
function isForeignRow(raw: unknown): boolean {
  const r = asRecord(raw)
  if (r === null || typeof r.table !== 'string' || asRecord(r.key) === null) return false
  const edits = asRecord(r.edits)
  if (edits === null) return false
  if (!isRowTable(r.table)) return true
  const fields = cellFieldsOf(r.table)
  return Object.keys(edits).some((f) => !fields.includes(f))
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
      // 読み戻した行を先に控えから外してから、残りを控える（控えの中で読めない行を二重にしない）
      dropRescuedLines(s1.rescued)
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
  // 申し送りの控え・読み替えた時の rev は、どちらか一方にあれば残す（基準を埋め終えた方＝baseRev を外した方が新しい
  // 時はそちらに従う）
  const noteMeta = meta.meta ?? m?.meta ?? s?.meta
  if (noteMeta !== undefined) out.meta = noteMeta
  if (meta.baseRev === undefined) delete out.baseRev
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
      // 他のタブが送り終えた・取り下げた op（墓標のある同じ中身）は読み込まない（F05。二重に送らない・取り下げを戻さない）
      const opDone = opDoneIndex()
      queue = s1.legacy.filter((o) => !isOpDone(o, opDone))
      // DB の版の食い違い（移行の当て忘れ）で拒否されて止まった op は、起動のたびに1回だけ送り直す（F31。移行を当てた後に
      // 自動で送られる。まだ拒否されれば1回でまた止まる）。版の印（ビルド番号）は持たないので、起動を「新しい版」の代わりにする
      for (const o of queue) {
        if (o.blocked !== 'rejected' || o.errCode === undefined || !SCHEMA_REJECT_CODES.has(o.errCode)) continue
        delete o.blocked
        o.rejects = MAX_TRIES - 1
        o.nextAt = 0
      }
      if (s1.cells.size > 0) cellRows = mergeCells(cellRows, stampFresh(s1.cells, [cellRows]), doneIndexOf(doneMarks))
      // 正規化できなかった行も消さない（設定画面の「読み取れませんでした」に乗せて残す）
      keepBroken(s1.dropped, 'queue')
      // 前に解釈できなかった原文。消さずに持ち続け「未送信データあり」を出し続ける
      if (s1.brokenRaw !== null) keepBroken([s1.brokenRaw], 'queue')
      // バイタル・食事の分を cl_sendQueue2 へ移す（書けたと確かめてから cl_sendQueue から外す＝消さない）
      if (s1.migrating) convertedOnLoad = true
      // 旧ビルドが畳んだ op を読み戻した（F27①）。書き戻して ops へ載せ、brokenRaw から外す
      if (s1.rescued.length > 0) convertedOnLoad = true
    } catch {
      // 壊れた値は解釈できないが、消さない。原文を控え、次の書き込みで同じキーの
      // brokenRaw として一緒に書き戻す（multi-device-sync 原則8: 消去は保全ゲートの後ろ）
      keepBroken([r1], 'queue')
      queue = []
      console.warn('未送信データの読み込みに失敗しました（内容は表示しません）')
    }
  }
  // 旧ビルドが畳んだ申し送りを救い出したら、書き戻して brokenRaw から外す（書けたと確かめるまで保存先は元のまま）
  if (r2 !== null && r2BrokenBefore(r2) !== null && cellBrokenRaw !== r2BrokenBefore(r2)) convertedOnLoad = true
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
 * cl_sendQueue の brokenRaw から op として読み戻した行を、このタブが持つ原文の控えから外す（F27①）。
 * 読み戻した op は書き戻しで ops に載る（同じ1回の setItem で brokenRaw から外れる。書けなければ保存先は元のまま）
 */
function dropRescuedLines(lines: string[]): void {
  if (queueBrokenRaw === null || lines.length === 0) return
  const drop = new Set(lines)
  const rest = queueBrokenRaw.split('\n').filter((l) => !drop.has(l))
  queueBrokenRaw = rest.every((l) => l === '') ? null : rest.join('\n')
}

/** 保存先の cl_sendQueue2 の brokenRaw（そのまま。救い出しで変わったかの見分けに使う） */
function r2BrokenBefore(r2: string): string | null {
  try {
    return str(asRecord(JSON.parse(r2))?.brokenRaw)
  } catch {
    return null
  }
}

/**
 * 書き戻す退避 op（水分・申し送り等）の一覧。localStorage を読み直し、他タブが退避した op を qid で
 * 和集合にしてから返す（HEAD と同じ）。全置換で書くと、同じ端末で2つ目のタブを開いた時に相手の未送信 op を
 * 消してしまう。ここでは他タブの op をこのタブのメモリ（queue）に入れない（書き戻すだけ）。
 * 他タブの op を送るのは、送信ロックを取ったタブが runFlush の中で引き取る時だけ（adoptOrphanOps・2026-10-10 F03。
 * 元のタブを閉じた後も送られる。引き取るのは持ち主のタブが閉じた op だけ＝手直し。二重に送らないのは墓標＝送り終えた印と、
 * update の 0行の読み直し＝F02 による）。
 * このタブの op は、保存先から消えていても捨てない（送り終えたと観測した sentQids と、墓標のある同じ中身だけを外す）
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
  // 他のタブが送り終えた・取り下げた op（墓標のある同じ中身）は、このタブのメモリと保存先の控えから外す（F05・F03。
  // 「保存先から消えた」だけでは外さない＝墓標がある時だけ。送信中の op は応答で決める）
  const opDone = opDoneIndex()
  queue = queue.filter((o) => o.sending === true || !isOpDone(o, opDone))
  const ops = mergeLegacyForPersist(s1 === null ? null : s1.legacy.filter((o) => !isOpDone(o, opDone)))
  if (typeof localStorage === 'undefined') {
    queuePersisted = false
    notifyQueue()
    return
  }
  // 新しい版のタブが積んだ、この版が知らない op・行は原文のまま書き戻す（F27②。送らないが消さない）。
  // 他のタブが送り終えて墓標を残した op は書き戻さない
  const doneQids = new Set(doneMarks.filter(isOpMark).map((m) => m.k.slice(OP_MARK_PREFIX.length)))
  const opQids = new Set(ops.map((o) => o.qid))
  const foreignOps = (s1?.foreign ?? []).filter((r) => {
    const q = str(r.qid) ?? ''
    if (opQids.has(q) || doneQids.has(q)) return false
    opQids.add(q)
    return true
  })
  const foreignRows: Record<string, unknown> = {}
  for (const [k, v] of s2?.foreign ?? []) {
    // 同じ行キーをこの版も持っている時は、原文を brokenRaw へ控える（どちらの入力も消さない）
    if (cellRows.has(k)) keepBroken([rawOf(v)], 'cells')
    else foreignRows[k] = v
  }
  let ok2 = false
  try {
    const out2: Record<string, unknown> = { ver: 2, rows: { ...foreignRows, ...Object.fromEntries(cellRows) }, done: doneMarks }
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
      const out1: Record<string, unknown> = { ops: foreignOps.length === 0 ? ops : [...ops, ...foreignOps] }
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
  // 読めなかった原文が残っているか（救い出して外した後は「読み取れませんでした」を出し続けない）
  queueBroken = queueBrokenRaw !== null || cellBrokenRaw !== null || legacyBrokenPending
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
  const { s1, s2 } = readStoresQuiet()
  const opDone = opDoneIndex(s2?.done)
  for (const op of storedOps()) ids.add(`op:${op.qid}`)
  for (const op of queue) if (op.sending === true || !isOpDone(op, opDone)) ids.add(`op:${op.qid}`)
  for (const k of currentCellRows().keys()) ids.add(`row:${k}`)
  // 新しい版のタブが積んだ、この版が送れない op・行も「未送信」として数える（F27②。数えないと 0件と出たまま残る）
  for (const r of s1?.foreign ?? []) ids.add(`op:${str(r.qid) ?? ''}`)
  for (const k of s2?.foreign.keys() ?? []) ids.add(`row:${k}`)
  return ids.size
}

/**
 * この版では送れない未送信の件数（F27③）: 読めずに原文のまま控えている行（brokenRaw）と、新しい版のタブが積んだ op・行。
 * 0 でない時、画面は「この端末に別の版の画面のタブが開いています。すべて閉じてから開き直してください」と知らせる
 * （古いタブが入浴・与薬・事故などの送信待ちを読めずに畳んだ・新しい版の送信待ちがある）。読むだけ
 */
export function queueUnreadableCount(): number {
  const { s1, s2 } = readStoresQuiet()
  const lines = (raw: string | null): number => (raw === null ? 0 : raw.split('\n').filter((l) => l !== '').length)
  return lines(queueBrokenRaw) + lines(cellBrokenRaw) + (s1?.foreign.length ?? 0) + (s2?.foreign.size ?? 0)
}

/**
 * 保存先（同じ端末の他のタブの控えを含む）にある退避 op のうち、まだ送り終えていない・取り下げていないもの（読むだけ。
 * 墓標のある同じ中身と、このタブが送れたと観測した qid を除く）
 */
function storedOps(): QueueOp[] {
  const { s1, s2 } = readStoresQuiet()
  if (s1 === null) return []
  const opDone = opDoneIndex(s2?.done)
  return s1.legacy.filter((o) => !sentQids.has(o.qid) && !isOpDone(o, opDone))
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
      if (q.kind !== 'update' || q.rowId === undefined || q.rowId !== op.rowId) continue
      // 操作した職員が違う update は1つにまとめない（F07。まとめると先の職員の変更も後の職員の edited_by で残る）。
      // 後の op の rev は、先の op が載った後に送る時に付け替える（rebaseFollowingOps）
      const a = q.payload.edited_by
      const b = op.payload.edited_by
      if (a !== undefined && b !== undefined && idNum(a) !== idNum(b)) continue
      return q
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
      // 見ていた役割（F70）も先勝ち（最初に見た役割が「この端末が変えたか」の基準）。先の op に無い（旧版の形）時は
      // 基準が分からないので持たない（役割は従来どおり書く）
      const prevRoles = asRecord(prevPayload.roles)
      const nextRoles = asRecord(op.payload.roles)
      if (prevRoles !== null) target.payload.roles = { ...(nextRoles ?? {}), ...prevRoles }
      else delete target.payload.roles
    }
    // 表示名の基準（変更前の表示名）は先勝ち（F71。送信待ちの間、設定画面は自分の値を出しているので、2回目の基準は
    // 自分の送信待ちの値になる。後勝ちにすると基準が自分の値になり、他の端末の変更を見逃す）。先の op に基準が無ければ
    // （旧版が積んだ op）基準は分からないまま
    if (op.kind === 'alias') {
      if (Object.prototype.hasOwnProperty.call(prevPayload, 'base')) target.payload.base = prevPayload.base
      else delete target.payload.base
    }
    target.tries = 0
    delete target.rejects
    delete target.errCode
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
      // 積んだタブの印（F03 手直し。このタブが開いている間は、他のタブが引き取って送らない）
      owner: tabId,
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
let pendingFlush: { force: boolean; boost: boolean; waitMs: number; run: Promise<void> } | null = null

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
function scheduleFlush(force: boolean, waitMs: number, boost = false): Promise<void> {
  if (pendingFlush !== null) {
    pendingFlush.force = pendingFlush.force || force
    pendingFlush.boost = pendingFlush.boost || boost
    pendingFlush.waitMs = Math.max(pendingFlush.waitMs, waitMs)
    return pendingFlush.run
  }
  const slot = { force, boost, waitMs, run: Promise.resolve() }
  slot.run = flushTail
    .then(async () => {
      if (pendingFlush === slot) pendingFlush = null
      await runFlush(slot.force, slot.waitMs, slot.boost)
    })
    .catch(() => undefined)
  pendingFlush = slot
  flushTail = slot.run
  return slot.run
}

/**
 * この回の送信で、サーバーの応答を1件でも受け取れたか（F06。つながったと分かった合図）。
 * 通信不能で待っていた分を、待ち時間を置かずに同じ回の中で送り直すために使う
 */
let deliveredThisRound = false

/**
 * boost=true は「画面に戻った」時の送信（F06）。直前の失敗が通信不能・認証切れだった書込だけ、待ち時間を置かずに送る
 * （サーバーに拒否された書込は待ち時間どおり＝拒否の回数を早く進めない）
 */
async function runFlush(force: boolean, waitMs: number, boost = false): Promise<void> {
  if (!isSupabaseConfigured()) return
  // 古い版（F28③）は送信待ちを送らない（古い版の書き方でサーバーへ書かない）。送信待ちは端末に残り、更新した版が送る
  if (buildOutdated) return
  if (queue.length === 0 && !hasCellWork() && !hasOrphanOps()) return
  try {
    await withSendLock(async () => {
      const sb = await getClient()
      // 他のタブが積んだ行・送り終えた行を取り込んでから送る（別タブの和集合）
      await persistQueueLocked()
      // 閉じた・止まった他のタブが積んだ退避 op を引き取る（F03。送信ロックを持つタブだけ・墓標で二重に送らない）
      await adoptOrphanOps()
      // 止まった行 id の行を、読み取りだけで自然キーへ付け替える（F1。画面から見えるようにする）
      await bindStoppedIdRows(sb)
      // ログインの控えが無い間に「競合」で止まってしまった update を判定し直す（F58。この修正の前の版で止まった分も含む）
      await recheckFalseConflicts(sb)
      deliveredThisRound = false
      await sendDueCells(sb, force, boost)
      await sendDueOps(sb, force, boost)
      // 1件でも届いた＝つながっている。通信不能で待っていた分を、待ち時間を置かずに同じ回で送る（F06）
      if (deliveredThisRound && !force) {
        await sendDueCells(sb, false, true)
        await sendDueOps(sb, false, true)
      }
      // 送信待ちの登録が送れた後の、その登録への変更（notes#ck:）を同じ送信の中で送る
      if ([...cellRows.values()].some((c) => c.table === 'notes' && c.key.client_key !== undefined && c.state === 'pending')) {
        await sendDueCells(sb, force)
      }
      // 送り終えた印（墓標）を、送信ロックを手放す前に保存先へ残す（次に送信ロックを取ったタブが同じ op を送らない）
      await persistQueueLocked()
    }, waitMs)
  } catch {
    // 接続先未設定・クライアント初期化失敗・ロックを取れなかった。キューはそのまま保持する
  } finally {
    await persistQueueLocked()
    armRetryTimer()
  }
}

/** この起動中に「本当に競合している（または読めない）」と確かめた止まった update の qid（毎回読み直さない） */
const conflictRechecked = new Set<string>()

/**
 * 「競合」で止まった update を1回だけ読み直し、偽の競合なら止めを外して送り直す（F58）。
 * 行の版が op の見ていた版のまま・取り消されていない＝その後に誰も変えていないので、条件付きの更新はそのまま通る。
 * そうなっているのに止まった op は、ログインの控えが無い間（anon キーで出た要求は RLS で0行になる）に止まった偽の競合。
 * 本当の競合（版が進んだ・取り消された）は止めたまま（人が選ぶまで送らない）。読めなければ次の機会に確かめ直す。
 * 送信ロックの中からだけ呼ぶ
 */
async function recheckFalseConflicts(sb: SupabaseClient): Promise<void> {
  const targets = queue.filter(
    (o): o is RowQueueOp =>
      o.blocked === 'conflict' && o.kind === 'update' && o.rowId !== undefined && o.rev !== undefined && !conflictRechecked.has(o.qid),
  )
  if (targets.length === 0 || (await sessionMissing(sb))) return
  let changed = false
  for (const op of targets) {
    const res = await bounded(sb.from(op.table).select('id,rev,deleted_at').eq('id', op.rowId as number).limit(1).maybeSingle())
    if (res.error !== null) {
      if (isAuthFail(res) || isTransient(res)) return // つながっていない。次の機会に
      conflictRechecked.add(op.qid)
      continue
    }
    const row = asRecord(res.data)
    if (row === null && (await sessionMissing(sb))) return
    conflictRechecked.add(op.qid)
    if (row === null || num(row.rev) !== op.rev || (row.deleted_at !== null && row.deleted_at !== undefined)) continue
    delete op.blocked
    op.nextAt = 0
    changed = true
  }
  if (changed) await persistQueueLocked()
}

/**
 * 同じ端末の他のタブが積んで、まだ送り終えていない退避 op が保存先にあるか（このタブのメモリに無い分。F03）。
 * 引き取れるのは Web Locks がある時だけ（無い環境は送信の主体を1つに絞れないので、従来どおり次の起動で送る）。
 * 持ち主のタブが生きているかはここでは見ない（同期で判定できないため。引き取るかどうかは adoptOrphanOps が決める）
 */
function hasOrphanOps(): boolean {
  if (webLocks() === null) return false
  const mine = new Set(queue.map((o) => o.qid))
  return storedOps().some((o) => !mine.has(o.qid))
}

/**
 * 保存先にあって、このタブのメモリに無い退避 op のうち、持ち主のタブが閉じたものを引き取る（F03。送信ロックの中からだけ呼ぶ）。
 * 元のタブを閉じた・破棄された時、残ったタブが再読み込みまで送らなかった。止まった印・回数・待ち時間はそのまま
 * 持ち込む（拒否で止まった op を勝手に再開しない）。
 * ★持ち主のタブが開いている op は引き取らない（F03 手直し・2026-10-10）。引き取って送ると、元のタブが同じ行を続けて
 *   直した値（統合先は送り終えた op・rev は最初に見た値）が、自分の変更との「競合」で止まった。持ち主の印の無い op
 *   （旧ビルドのタブが積んだ分）も引き取らない（旧ビルドは墓標を知らず、自分でもう一度送って止まるため）。
 *   どちらも、持ち主のタブが自分で送るか、次の起動で送る（修正前と同じ）。
 * 引き取った op は持ち主をこのタブに書き換える（別のタブがさらに引き取らない）。navigator.locks.query が無い・読めない時は
 * 引き取らない（安全側＝修正前と同じ）
 */
async function adoptOrphanOps(): Promise<void> {
  const locks = webLocks()
  if (locks === null || typeof locks.query !== 'function') return
  if (!hasOrphanOps()) return
  let alive: Set<string>
  try {
    const snap = await locks.query()
    alive = new Set([...(snap.held ?? []), ...(snap.pending ?? [])].map((l) => l.name ?? ''))
  } catch {
    return
  }
  // 問い合わせを待つ間に変わったかもしれないので、メモリの queue は読み直してから比べる
  const mine = new Set(queue.map((o) => o.qid))
  for (const o of storedOps()) {
    if (mine.has(o.qid)) continue
    if (o.owner === undefined || o.owner === tabId || alive.has(`${TAB_LOCK_PREFIX}${o.owner}`)) continue
    mine.add(o.qid)
    queue.push({ ...o, owner: tabId })
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
  // 閉じた他のタブが積んだ退避 op も、待ち時間が明けたら引き取って送る（F03）
  if (webLocks() !== null) {
    const mine = new Set(queue.map((o) => o.qid))
    for (const op of storedOps()) {
      // 期限が過ぎている分も、次の機会（RETRY_BASE_MS 後）に引き取る（このタブの送信が走らないまま置き去りにしない）
      if (!mine.has(op.qid) && op.blocked === undefined) consider(op.nextAt > now ? op.nextAt : now + RETRY_BASE_MS, op.at)
    }
  }
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
async function sendDueOps(sb: SupabaseClient, force: boolean, boost = false): Promise<void> {
  const now = Date.now()
  const due = queue.filter(
    (op) => op.blocked === undefined && (force || op.nextAt <= now || (boost && op.netFail === true)),
  )
  for (const op of due) {
    // 他のタブが取り下げた・送り終えた・この回で既に外した op は送らない
    if (!queue.includes(op)) continue
    // 送信中は統合先にしない印を立てる（応答待ちの間にペイロードを差し替えられると、
    // 'sent' の判定で「まだ送っていない入力」ごと消えるため）
    op.sending = true
    let result: SendResult
    lastSendCode = ''
    lastLandedRev = null
    try {
      result = await sendQueuedOp(sb, op)
      // ログインの控えが無い間（トークン更新の失敗中＝anon キーで出た）の0行・拒否は、競合・拒否と断定しない（F58。
      // 止めると二度と送られない）。控えが戻れば（TOKEN_REFRESHED）送り直す
      if ((result === 'conflict' || result === 'rejected') && (await sessionMissing(sb))) result = 'retry'
    } finally {
      delete op.sending
    }
    if (result !== 'retry') deliveredThisRound = true
    if (result === 'sent') {
      sentQids.add(op.qid) // 他タブの古い控えから書き戻されても復活させない
      markOpDone(op, 'sent') // 同じ端末の他のタブにも「送り終えた」を残す（墓標・F05/F03）
      queue = queue.filter((o) => o.qid !== op.qid) // 観測できた時だけ消す（保全ゲート）
      rebaseFollowingOps(op, lastLandedRev)
      continue
    }
    op.tries += 1
    if (result === 'conflict') {
      delete op.netFail
      op.blocked = 'conflict'
    } else if (result === 'rejected') {
      delete op.netFail
      // 回数は拒否だけを数える（F31。通信不能で増えた tries を拒否の上限に使わない）
      op.rejects = (op.rejects ?? 0) + 1
      if (lastSendCode !== '') op.errCode = lastSendCode
      if (op.rejects >= MAX_TRIES) op.blocked = 'rejected'
      else op.nextAt = Date.now() + backoff(op.tries)
    } else {
      // 通信不能・認証切れ: 回数では諦めず、間隔だけ広げて待つ
      op.netFail = true
      op.nextAt = Date.now() + backoff(op.tries)
      break // つながっていないので、この回はここで打ち切る
    }
  }
}

/**
 * 同じ行への後続の update（職員が違うので1つにまとめなかった op・F07）の rev を、送り終えた op の結果の版へ付け替える。
 * 先の op はこの端末の書込なので、条件付きの更新が通った後の版（op.rev+1）は自分が進めた版＝後続の op が観測した
 * 状態の続き。付け替えないと、後続の op は必ず 0行（競合）で止まる
 */
function rebaseFollowingOps(sent: QueueOp, landedRev: number | null): void {
  if (sent.kind !== 'update' || sent.rowId === undefined || sent.rev === undefined || landedRev === null) return
  for (const q of queue) {
    if (q === sent || q.kind !== 'update' || q.table !== sent.table || q.rowId !== sent.rowId) continue
    if (q.rev === sent.rev && q.sending !== true && q.blocked === undefined) q.rev = landedRev
  }
}

type SendResult = 'sent' | 'retry' | 'conflict' | 'rejected'

/** 直近の送信が受け付けられなかった時のエラーコード（F31。sendQueuedOp の中で控える） */
let lastSendCode = ''
/** 直近の送信（update）が載った後の行の版（F07。後続の op の付け替えに使う。分からなければ null） */
let lastLandedRev: number | null = null

/** 受け付けられなかった（拒否）として返す。エラーコードを控える（F31） */
function rejectedBy(res: Res<unknown>): 'rejected' {
  lastSendCode = errCode(res)
  return 'rejected'
}

async function sendQueuedOp(sb: SupabaseClient, op: QueueOp): Promise<SendResult> {
  lastLandedRev = null
  // 業務表の insert / update とは書き方が違う種別を先に振り分ける（以降 op は業務表の op）
  if (op.kind === 'read') return sendQueuedRead(sb, op)
  if (op.kind === 'attendance') return sendQueuedAttendance(sb, op)
  if (op.kind === 'alias') return sendQueuedAlias(sb, op)

  const cols = colsOf(op.table)
  if (op.kind === 'insert') {
    const res = await bounded(sb.from(op.table).insert(op.payload).select(cols).maybeSingle())
    if (res.error === null) {
      markSelfRow(op.table, res.data, num(asRecord(res.data)?.rev)) // 版が確定した
      const sentCk = str(op.payload.client_key)
      if (op.table === 'notes' && sentCk !== null && sentCk !== '') rememberNoteSent(sentCk, op.payload)
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
        // 申し送りの登録の op の中身は書き換えない（第3巡の不変条件）。登録後の変更は notes#ck:<client_key> にあり、
        // この後に client_key で行を見つけて送る＝ここで比べ直す物は無い
        if (op.table === 'notes') {
          // 申し送り: 届いていた行と、この op の中身が食い違う欄は、登録できた行への変更として積んでから外す（R6(A)・R6-1）
          const landedNote = await findByKey(sb, 'notes', ck, NOTE_COLS, true)
          if (landedNote === null) return 'retry'
          const row = normalizeNote(landedNote.row)
          if (row === null) return 'retry'
          // 基準はこのタブが記録した「この冪等キーで最初に送った中身」。確かめられない時は null（偽の競合は許すが、
          // 黙って外さない＝別のタブが同じキーで積んだ op の中身を消さない・R6-1 の安全網）
          const key = str(op.payload.client_key) ?? ''
          const ok = await stageNoteDupDiff(row, op.payload, firstSentNote.get(key))
          if (!ok) return 'retry' // 積めなければ外さない
          return 'sent'
        }
        const landed = await findByKey(sb, op.table, ck, 'id,rev', true)
        if (landed !== null) return 'sent'
        // 先に載っていたのが自動の記録（0015 の cron・auto=true）なら、その行をこの手動の記録で上書きする（チーフ指摘5）。
        // 圏外で「中止」を記録している間に 12:30 の自動の「全身浴」が先に載った、などの時に職員の記録を優先するため。
        // 手動の記録どうし（auto=false）は従来どおり conflict。送信待ちの中身は書き換えない（送る時の解決だけ）
        const overAuto = await overrideAutoRow(sb, op.table, op.payload)
        if (overAuto !== null) return overAuto
        // 入浴記録（1人1日1件）・服薬の時間帯（1人1件）・与薬の記録（1人1日1時間帯1件）は自然キー（部分unique）も持つ。
        // 自分の client_key が載っておらず、同じ自然キーの生きている行がある＝他の端末が先に記録した。
        // 再送しても通らないので止める（消さずに残し「未送信」として数え続ける＝rev 不一致の update と同じ扱い）
        if (await naturalKeyTaken(sb, op.table, op.payload)) return 'conflict'
        return 'retry'
      }
    }
    return rejectedBy(res)
  }

  // 退避した update。印は書けた（届いていたと確かめた）時だけ付け、応答を待つ間のこの行の通知は預かる（F10）
  const end = beginRowWrite(op.table, op.rowId)
  try {
    return await sendQueuedUpdate(sb, op, cols)
  } finally {
    end(lastLandedRev ?? undefined)
  }
}

/** 退避した update を送る（rev 照合）。0行の時は読み直して、自分の書込が届いていたかを確かめる（F02） */
async function sendQueuedUpdate(sb: SupabaseClient, op: RowQueueOp, cols: string): Promise<SendResult> {
  // 退避した update は、退避した時点の操作者を edited_by として持っている（列が無い DB では外して送る）。
  // 旧版が退避した op で edited_by が無ければ null を足す（操作者が分からない書き換え）
  const res = await sendWithEditor(withEditorNull(op.payload), (p) =>
    bounded(
      sb
        .from(op.table)
        .update(p)
        .eq('id', op.rowId as number)
        .eq('rev', op.rev as number)
        .is('deleted_at', null)
        .select(cols)
        .maybeSingle(),
    ),
  )
  if (res.error !== null) {
    if (isAuthFail(res)) {
      fireAuthExpired()
      return 'retry'
    }
    return isTransient(res) ? 'retry' : rejectedBy(res)
  }
  if (res.data !== null) {
    lastLandedRev = num(asRecord(res.data)?.rev) ?? (op.rev as number) + 1
    return 'sent'
  }
  return verifyLandedUpdate(sb, op, cols)
}

/**
 * rev 照合の update が 0行だった時、行を1行読み直して「自分の書込が既に載っているか」を確かめる（F02）。
 * 応答だけが失われた（サーバーには載って rev が進んだ）・同じ端末の別のタブが同じ op を先に送った、の2つは、
 * 再送が自分の書込と競合して「未送信」に永久に残っていた。行の版が op の版より進んでいて、op の中身（edited_by を除く。
 * 取り消しは取り消されているかどうか）がいまの行と同じなら、届いていたものとして外す（原則6。中身が同じなら届いたと
 * みなす＝2026-10-10 本人回答）。違えば従来どおり競合（黙って外さない）。読めなければ次の送信で確かめ直す
 */
async function verifyLandedUpdate(sb: SupabaseClient, op: RowQueueOp, cols: string): Promise<SendResult> {
  // 取り消された行も読む（.is('deleted_at', null) を付けない＝届いていた取り消しを「行が無い」と取り違えない）
  const res = await bounded(sb.from(op.table).select(`${cols},deleted_at`).eq('id', op.rowId as number).limit(1).maybeSingle())
  if (res.error !== null) {
    if (isAuthFail(res)) {
      fireAuthExpired()
      return 'retry'
    }
    return isTransient(res) ? 'retry' : 'conflict'
  }
  const row = asRecord(res.data)
  const rev = num(row?.rev)
  if (row === null || rev === null || rev <= (op.rev as number)) return 'conflict'
  if (!payloadLanded(op.payload, row)) return 'conflict'
  lastLandedRev = rev
  return 'sent'
}

/** 退避した update の中身が、読み直した行にそのまま載っているか（F02。比べ方は landedValueEq） */
function payloadLanded(payload: Record<string, unknown>, row: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'edited_by') continue // 列が無い DB では送っていない・記入者は中身ではない
    if (k === 'deleted_at') {
      // 端末が付けた時刻と、サーバーが返す時刻の書き方（Z と +00:00）が違う。取り消されているかどうかで比べる
      if ((v === null || v === undefined) !== (row.deleted_at === null || row.deleted_at === undefined)) return false
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(row, k)) return false // 読めなかった列は確かめられない＝競合のまま
    if (!landedValueEq(v, row[k])) return false
  }
  return true
}

const LANDED_TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/
const LANDED_STAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

/**
 * 送った値と読み直した値が同じか（F02）。時刻は "13:10" と "13:10:00" を同じ、日時は同じ瞬間なら同じ（Z と +00:00）、
 * 数値は数値として、配列は順に、オブジェクト（jsonb）は送った鍵だけを比べる（サーバーが書き足す鍵＝事故の氏名の写しは見ない）。
 * 文字の欄は数値に読み替えない（'07' と '7' は別）
 */
function landedValueEq(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined)
  }
  if (typeof a === 'number' || typeof b === 'number') {
    if (typeof a === 'string' && typeof b === 'number') return a.trim() !== '' && Number(a) === b
    if (typeof b === 'string' && typeof a === 'number') return b.trim() !== '' && Number(b) === a
    return a === b
  }
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return true
    const ta = LANDED_TIME_RE.exec(a)
    const tb = LANDED_TIME_RE.exec(b)
    if (ta !== null && tb !== null) {
      return Number(ta[1]) === Number(tb[1]) && ta[2] === tb[2] && Number(ta[3] ?? 0) === Number(tb[3] ?? 0)
    }
    if (LANDED_STAMP_RE.test(a) && LANDED_STAMP_RE.test(b)) {
      const pa = Date.parse(a)
      const pb = Date.parse(b)
      return Number.isFinite(pa) && pa === pb
    }
    return false
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => landedValueEq(x, b[i]))
  }
  const ra = asRecord(a)
  const rb = asRecord(b)
  if (ra !== null && rb !== null) return Object.keys(ra).every((k) => landedValueEq(ra[k], rb[k]))
  return a === b
}

/**
 * 退避してあった既読を送る。23505（他の経路で既に既読になっていた）は成功と同じ扱い。
 * note_reads は rev も deleted_at も持たない表なので、insert 1文だけで完結する。
 */
async function sendQueuedRead(sb: SupabaseClient, op: ReadQueueOp): Promise<SendResult> {
  const noteId = idNum(op.payload.note_id)
  const staffId = idNum(op.payload.staff_id)
  if (noteId === null || staffId === null) return 'rejected' // 送り先を特定できない
  const res = await bounded(sb.from('note_reads').insert({ note_id: noteId, staff_id: staffId }).select('note_id').maybeSingle())
  if (res.error === null) return 'sent'
  if (isUniqueViolation(res)) return 'sent' // 既に既読＝目的は達している
  if (isAuthFail(res)) {
    fireAuthExpired()
    return 'retry'
  }
  return isTransient(res) ? 'retry' : rejectedBy(res)
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
    await applyAttendance(sb, day, rows, baseline, attendanceRolesOf(op.payload.roles))
    return 'sent'
  } catch (e) {
    // 施設長が他の端末で選ばれていた（0026 の索引・F70）: 捨てずに止める（設定タブの「送れていない記録」で選ぶ）
    if (e instanceof DbError && e.message === SHEET_MSG.managerTaken) return 'conflict'
    if (e instanceof DbError) return e.kind === 'network' || e.kind === 'auth' ? 'retry' : 'rejected'
    return 'rejected'
  }
}

/**
 * 退避してあった「申し送りでの表示名」を送る。書くのは note_alias の1列だけ。
 * 2026-10-10（F71）: 基準も重複の確認も無しに上書きしていたため、圏外の間に他の端末が付けた表示名を黙って消す・
 * 同じ表示名が2人に付くことがあった。送る前に全員の氏名・表示名を読み直して重複の確認（validateNoteAlias）をやり直し、
 * 「いまの表示名が見ていた値（base）のまま」の時だけ書く条件付きの更新にする。食い違えば送らずに止める（'conflict'＝
 * 止まっている送信待ちの一覧に出し、人が選ぶ）。基準が分からない op（旧版が積んだ分）は、いまの表示名が空の時だけ書く。
 * 対象の利用者が居なくなっていた場合は、再送しても永久に書けないので 'sent' にする（従来どおり）
 */
async function sendQueuedAlias(sb: SupabaseClient, op: AliasQueueOp): Promise<SendResult> {
  const id = idNum(op.payload.id)
  if (id === null) return 'rejected'
  // 文字列（設定する）と null（設定を外す）だけを送る。読めない値を null として送ると
  // 付けてあった表示名を無言で消してしまうため、その退避は送らない（原則4・5）
  const raw = op.payload.note_alias
  if (raw !== null && typeof raw !== 'string') return 'rejected'
  const alias = str(raw)
  const hasBase = Object.prototype.hasOwnProperty.call(op.payload, 'base')
  const rawBase = op.payload.base
  if (hasBase && rawBase !== null && typeof rawBase !== 'string') return 'rejected'
  const failed = (res: Res<unknown>): SendResult => {
    if (isAuthFail(res)) {
      fireAuthExpired()
      return 'retry'
    }
    return isTransient(res) ? 'retry' : rejectedBy(res)
  }
  const all = await bounded(sb.from('residents').select(RESIDENT_COLS).order('id', { ascending: true }).limit(MAX_ROWS))
  if (all.error !== null) return failed(all)
  const residents = list(all.data, normalizeResident)
  const self = residents.find((r) => r.id === id)
  // 居なくなった利用者には永久に書けないので外す。ただしログインの控えが無い間（anon で読んで0人に見えた）は外さない（F58）
  if (self === undefined) return (await sessionMissing(sb)) ? 'retry' : 'sent'
  const same = (a: string | null, b: string | null): boolean => (a ?? '').trim() === (b ?? '').trim()
  if (same(self.note_alias, alias)) return 'sent' // もう同じ表示名になっている
  // 圏外の間に他の利用者へ同じ表示名が付いていないか、送る直前に確かめ直す（取り違え防止の仕組みが取り違えを作らない）
  if (alias !== null && !validateNoteAlias(alias, id, residents).ok) return 'conflict'
  // 基準: 見ていた値（無い op は「いまが空の時だけ」）。いまの値が基準と違う＝他の端末が後から付けた
  const seen = hasBase ? str(rawBase) : null
  if (!same(self.note_alias, seen)) return 'conflict'
  let q = sb.from('residents').update({ note_alias: alias }).eq('id', id)
  // 読んだ後に他の端末が書いた時も上書きしない（条件付きの更新。0行なら読み直して決める）
  q = self.note_alias === null ? q.is('note_alias', null) : q.eq('note_alias', self.note_alias)
  const res = await bounded(q.select('id').maybeSingle())
  if (res.error !== null) return failed(res)
  if (res.data !== null) return 'sent'
  const again = await bounded(sb.from('residents').select('id,note_alias').eq('id', id).limit(1).maybeSingle())
  if (again.error !== null) return failed(again)
  const now = asRecord(again.data)
  if (now === null) return (await sessionMissing(sb)) ? 'retry' : 'sent'
  return same(str(now.note_alias), alias) ? 'sent' : 'conflict'
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
    case 'bath_records':
      return BATH_COLS
    case 'med_slots':
      return MED_SLOTS_COLS
    case 'med_admin':
      return MED_ADMIN_COLS
    case 'incidents':
      return INCIDENT_COLS
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
/**
 * 冪等キーなどで1行を探す。見つかった＝行、無い＝'none'、読めなかった（通信・権限）＝'error'（L2。「無い」と取り違えない）
 */
async function findByKeyResult(
  sb: SupabaseClient,
  table: QueueTable,
  key: Record<string, unknown>,
  cols: string,
): Promise<{ id: number; rev: number; row: unknown } | 'none' | 'error'> {
  let q = sb.from(table).select(cols).limit(1)
  for (const [k, v] of Object.entries(key)) q = q.eq(k, v as never)
  const res = await bounded(q.maybeSingle())
  if (res.error !== null) return 'error'
  if (res.data === null) return 'none'
  const r = asRecord(res.data)
  const id = idNum(r?.id)
  const rev = num(r?.rev)
  return id !== null && rev !== null ? { id, rev, row: res.data } : 'error'
}

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
  const res = await bounded(q.maybeSingle())
  if (res.error !== null || res.data === null) return null
  const r = asRecord(res.data)
  const id = idNum(r?.id)
  const rev = num(r?.rev)
  return id !== null && rev !== null ? { id, rev, row: res.data } : null
}

/**
 * 入浴記録の自然キー（同じ人・同じ日）に生きている行があるか。
 * 読めなかった時は false（＝他の端末の行とは断定しない。呼び側は再試行へ回す）
 */
async function bathDayTaken(sb: SupabaseClient, payload: Record<string, unknown>): Promise<boolean> {
  const residentId = idNum(payload.resident_id)
  const day = dateStr(payload.bath_on)
  if (residentId === null || day === null) return false
  return (await findByKey(sb, 'bath_records', { resident_id: residentId, bath_on: day })) !== null
}

/**
 * 服薬の時間帯（1人1件）・与薬の記録（1人1日1時間帯1件。頓服は自然キーを持たない）の自然キーに生きている行があるか。
 * 読めなかった時は false（入浴と同じ）
 */
async function medKeyTaken(
  sb: SupabaseClient,
  table: 'med_slots' | 'med_admin',
  payload: Record<string, unknown>,
): Promise<boolean> {
  const residentId = idNum(payload.resident_id)
  if (residentId === null) return false
  if (table === 'med_slots') return (await findByKey(sb, 'med_slots', { resident_id: residentId })) !== null
  const day = dateStr(payload.admin_on)
  const slot = oneOf<MedAdminSlot>(payload.slot, MED_ADMIN_SLOTS)
  if (day === null || slot === null || slot === 'prn') return false
  return (await findByKey(sb, 'med_admin', { resident_id: residentId, admin_on: day, slot })) !== null
}

/**
 * 送信待ちの手動の追加（入浴・与薬の時間帯の記録）が自然キーで衝突した時、衝突した生きている行が自動の記録（auto=true）なら、
 * その行を読んだ rev で、送信待ちの中身（区分・理由・備考 / 状態・備考・記入者）と auto=false に update する。
 * 戻り値: 上書きできた 'sent'／通信・ログインの失敗や読んだ後に行が変わった 'retry'（次の送信で判定し直す）／
 *         受け付けられなかった 'rejected'／自動の記録ではない・行が無い・対象外の表 null（呼び側は従来どおり判定する）。
 * 送信待ちの op は書き換えない（上書きの中身は op.payload から毎回組み立てる）
 */
async function overrideAutoRow(
  sb: SupabaseClient,
  table: QueueTable,
  payload: Record<string, unknown>,
): Promise<SendResult | null> {
  const residentId = idNum(payload.resident_id)
  if (residentId === null) return null
  let key: Record<string, unknown>
  let patch: Record<string, unknown>
  if (table === 'bath_records') {
    const day = dateStr(payload.bath_on)
    if (day === null) return null
    key = { resident_id: residentId, bath_on: day }
    patch = { result: payload.result, cancel_reason: payload.cancel_reason ?? null, note: payload.note ?? null }
  } else if (table === 'med_admin') {
    const day = dateStr(payload.admin_on)
    const slot = oneOf<MedAdminSlot>(payload.slot, MED_ADMIN_SLOTS)
    if (day === null || slot === null || slot === 'prn') return null
    key = { resident_id: residentId, admin_on: day, slot }
    patch = { status: payload.status, note: payload.note ?? null }
  } else {
    return null
  }
  const found = await findByKey(sb, table, key, 'id,rev,auto')
  if (found === null || asRecord(found.row)?.auto !== true) return null
  const recorder = idNum(payload.recorded_by)
  const sent = {
    ...patch,
    recorded_by: recorder,
    auto: false,
    // 変更の記録の「変えた職員」は送信待ちに残っている操作者（無ければ記録者）
    edited_by: idNum(payload.edited_by) ?? recorder,
  }
  // 印は上書きできた時だけ付け、応答を待つ間のこの行の通知は預かる（F10）
  const end = beginRowWrite(table, found.id)
  let landed: number | undefined
  try {
    const res = await sendWithEditor(sent, (p) =>
      bounded(
        sb
          .from(table)
          .update(p)
          .eq('id', found.id)
          .eq('rev', found.rev)
          .is('deleted_at', null)
          .select(colsOf(table))
          .maybeSingle(),
      ),
    )
    if (res.error !== null) {
      if (isAuthFail(res)) {
        fireAuthExpired()
        return 'retry'
      }
      return isTransient(res) ? 'retry' : rejectedBy(res)
    }
    // 0行＝読んだ後に他の端末が変えた（または取り消した）。次の送信で判定し直す（手動になっていれば conflict で止まる）
    if (res.data === null) return 'retry'
    landed = num(asRecord(res.data)?.rev) ?? found.rev + 1
    return 'sent'
  } finally {
    end(landed)
  }
}

/**
 * 自然キー（部分unique）を持つ表の、その追加の自然キー（F37。止まった追加の相手の行を引く）。
 * 入浴＝同じ人・同じ日／服薬の時間帯＝同じ人／与薬＝同じ人・同じ日・同じ時間帯（頓服は自然キーを持たない）。それ以外は null
 */
function naturalKeyOf(table: QueueTable, payload: Record<string, unknown>): Record<string, unknown> | null {
  const residentId = idNum(payload.resident_id)
  if (residentId === null) return null
  if (table === 'bath_records') {
    const day = dateStr(payload.bath_on)
    return day === null ? null : { resident_id: residentId, bath_on: day }
  }
  if (table === 'med_slots') return { resident_id: residentId }
  if (table === 'med_admin') {
    const day = dateStr(payload.admin_on)
    const slot = oneOf<MedAdminSlot>(payload.slot, MED_ADMIN_SLOTS)
    return day === null || slot === null || slot === 'prn' ? null : { resident_id: residentId, admin_on: day, slot }
  }
  return null
}

/** 自然キー（部分unique）を持つ表で、同じキーの生きている行があるか。自然キーを持たない表は false */
async function naturalKeyTaken(sb: SupabaseClient, table: QueueTable, payload: Record<string, unknown>): Promise<boolean> {
  if (table === 'bath_records') return bathDayTaken(sb, payload)
  if (table === 'med_slots' || table === 'med_admin') return medKeyTaken(sb, table, payload)
  return false
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
    // 画面に戻った: 直前の失敗が通信不能だった書込は待ち時間を置かずに送る（F06。onLine が変わらないまま電波が戻った時も
    // 最大30分待たせない）。拒否された書込は待ち時間どおり（拒否の回数を早く進めない）
    if (document.visibilityState === 'visible') void scheduleFlush(false, 0, true)
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

/**
 * この起動中に「このアカウントは許可リストに無い（RLS で業務表が見えない）」と確かめたか（F61・2026-10-10）。
 * 許可リストから外れた・無効にされたアカウントでは app_settings の行も見えず、入力解禁を「false を観測」として
 * 「スプレッドシートで記録する期間です」と誤って案内していた。設定の行が見えない時だけ、職員の名簿を1行読んで確かめる
 * （名簿は空にならない＝見えなければ許可リスト外）。設定の行が見えた・ログインし直した時に false へ戻す
 */
let memberDenied = false

/**
 * 設定の行が見えなかった時、それが許可リスト外のためか（true なら memberDenied を立てる）。
 * 名簿が見える・確かめられない（通信エラー・ログインの控えが無い）時は false＝従来どおり「未登録」として扱う
 */
async function deniedWhenSettingMissing(): Promise<boolean> {
  try {
    const sb = await getClient()
    const res = await bounded(sb.from('staff').select('id').limit(1))
    if (res.error !== null) return false
    if (Array.isArray(res.data) && res.data.length > 0) {
      memberDenied = false
      return false
    }
    if (await sessionMissing(sb)) return false
    memberDenied = true
    return true
  } catch {
    return false
  }
}

// ── 古い版の入力止め（app_settings の min_client_build・0023・F28③） ─────────────────
//
// 互換の無い変更を配る時、管理者が min_client_build（入力を許す最も古い公開の通し番号）を上げると、それより古い版の
// 端末は入力と送信待ちの送信を止め、App が「新しい版に更新してください」を出す（閲覧の画面は受け皿に置き換わる）。
// 読めない・未設定・空は止めない（観測できていないことを断定しない）。開発中の版（'dev'）も止めない（clientBuildAllowed）。
// 一度「古い」と観測したら、この起動中は戻さない（値を下げた時は再読み込みで戻る）。送信待ちは端末に残る（消さない）

/** この起動中に、この版が min_client_build より古いと観測したか */
let buildOutdated = false
/** 比べるこの端末の版（試験だけが差し替える。undefined＝焼き込んだ版 CLIENT_BUILD） */
let buildForGate: BuildStamp | undefined = undefined
let buildGateFetchedAt = 0
let buildGateInFlight: Promise<boolean> | null = null
/** 古い版だと分かった時の受け口（App が受け皿を出す） */
const buildOutdatedListeners = new Set<() => void>()

/**
 * min_client_build を取り直してこの版と比べる。戻り値は「古い版か」（読めない時は直近の観測のまま）。
 * 同時に呼ばれた分は1回にまとめる。App が起動時・画面に戻った時・数分おきに呼ぶ（入力解禁の確認からも呼ぶ）
 */
export async function checkClientBuild(): Promise<boolean> {
  if (buildGateInFlight !== null) return buildGateInFlight
  const run = (async (): Promise<boolean> => {
    try {
      const raw = await getAppSetting('min_client_build')
      buildGateFetchedAt = Date.now()
      if (!buildOutdated && !clientBuildAllowed(raw, buildForGate)) {
        buildOutdated = true
        for (const fn of [...buildOutdatedListeners]) {
          try {
            fn()
          } catch {
            // 受け口の例外でデータアクセス層を巻き込まない
          }
        }
      }
    } catch {
      // 読めない（通信・ログインの控えが無い）: 直近の観測のまま（未観測なら止めない）
    } finally {
      buildGateInFlight = null
    }
    return buildOutdated
  })()
  buildGateInFlight = run
  return run
}

/** この起動中に、この版が古い（min_client_build より前）と観測したか */
export function isClientBuildOutdated(): boolean {
  return buildOutdated
}

/** 古い版だと分かった時に呼ばれる受け口を登録する（戻り値で外す） */
export function onClientBuildOutdated(fn: () => void): () => void {
  buildOutdatedListeners.add(fn)
  return () => {
    buildOutdatedListeners.delete(fn)
  }
}

/** 入力解禁の確認と一緒に使う。直近（GATE_TTL_MS 以内）に確かめていれば問い合わせない */
async function buildGateForGate(): Promise<boolean> {
  if (buildOutdated || Date.now() - buildGateFetchedAt < GATE_TTL_MS) return buildOutdated
  return checkClientBuild()
}

async function refreshGate(): Promise<boolean | null> {
  if (gateInFlight !== null) return gateInFlight
  const run = (async (): Promise<boolean | null> => {
    try {
      const raw = await getAppSetting('native_input_enabled')
      if (raw !== null) memberDenied = false
      // 許可リスト外（行が見えないだけ）: 封鎖を観測したことにしない（観測できなかった扱い・F61）
      else if (await deniedWhenSettingMissing()) return null
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

// 申し送りの変更・取り消しに使う RPC（0017 apply_note_edits）の有無。考え方は apply_cell_edits と同じ
let noteRpcState: 'ready' | 'missing' | null = null
let noteRpcCheckedAt = 0
let noteProbeInFlight: Promise<'ready' | 'missing' | null> | null = null

function markNoteRpc(state: 'ready' | 'missing'): void {
  noteRpcState = state
  noteRpcCheckedAt = Date.now()
}

/** apply_note_edits の有無を問い合わせる（p_id=null。何も書かない）。同時に呼ばれた分は1回にまとめる */
async function probeNoteRpc(): Promise<'ready' | 'missing' | null> {
  if (noteProbeInFlight !== null) return noteProbeInFlight
  const run = (async (): Promise<'ready' | 'missing' | null> => {
    try {
      const sb = await getClient()
      const res = (await sb.rpc('apply_note_edits', { p_id: null, p_edits: {} })) as Res<unknown>
      if (res.error !== null) {
        if (!isMissingRpc(res)) return null
        markNoteRpc('missing')
        return 'missing'
      }
      const state = asRecord(res.data)?.status === 'probe' ? 'ready' : 'missing'
      const was = noteRpcState
      markNoteRpc(state)
      // サーバー側の更新（0017）が入った: 待たせていた申し送りの送信待ちをすぐ送る
      if (was === 'missing' && state === 'ready') void flushQueue(true)
      return state
    } catch {
      return null
    } finally {
      noteProbeInFlight = null
    }
  })()
  noteProbeInFlight = run
  return run
}

async function noteRpcForGate(): Promise<'ready' | 'missing' | 'unknown'> {
  if (noteRpcState === 'ready' && Date.now() - noteRpcCheckedAt < GATE_TTL_MS) return 'ready'
  const c = await probeNoteRpc()
  if (c !== null) return c
  return noteRpcState ?? 'unknown'
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
  /**
   * 保存済みの申し送りの変更・取り消しに使う RPC（0017）: ready＝使える／missing＝サーバー側の更新待ち
   * （保存済みの申し送りの変更を止めて理由を出す。新しい申し送りの登録は止めない）／unknown＝確かめられない
   */
  notes: 'ready' | 'missing' | 'unknown'
  /**
   * このアカウントは記録アプリを使えない（許可リストに無い・無効。F61）。true の時は observed=false。
   * 画面は封鎖（スプレッドシート期間）でも通信エラーでもなく FORBIDDEN_REASON を出す
   */
  forbidden?: true
  /**
   * この端末のアプリが古い版（app_settings の min_client_build より前・F28③）。true の時は value=false・observed=true。
   * 画面は封鎖（スプレッドシート期間）ではなく OUTDATED_REASON を出す（App が受け皿で画面ごと置き換える）
   */
  outdated?: true
}

/**
 * app_settings.native_input_enabled と「サーバーの値を観測できたか」。
 * observed=false は「入力できるかどうかが分からない」状態で、封鎖（＝スプシ期間）とは別物。
 * 画面はこの2つを区別し、observed=false では封鎖理由ではなく通信エラーと再試行を出す
 * （multi-device-sync 原則5: 観測できていないことを断定しない）。
 * 同時に 0011 の有無も確かめる（cells）。申し送り・水分・外出の入力は cells に関係なく value で決める。
 */
export async function getNativeInputGate(): Promise<NativeInputGate> {
  const [v, cells, notes, outdated] = await Promise.all([refreshGate(), cellRpcForGate(), noteRpcForGate(), buildGateForGate()])
  if (memberDenied) return { value: false, observed: false, cells, notes, forbidden: true }
  // 古い版（F28③）: 入力を止める。封鎖（スプレッドシート期間）とは別の案内（OUTDATED_REASON）
  if (outdated) return { value: false, observed: true, cells, notes, outdated: true }
  if (v !== null) return { value: v, observed: true, cells, notes }
  // 取り直せなかった。この起動中に一度でも観測できていれば、その値を使う（観測済み扱い）
  if (gateValue !== null) return { value: gateValue, observed: true, cells, notes }
  return { value: false, observed: false, cells, notes }
}

/**
 * app_settings.native_input_enabled。取得できない時は最後に観測した値、それも無ければ false。
 * 「観測できなかった」と「false を観測した」を区別したい画面は getNativeInputGate を使う。
 */
export async function getNativeInputEnabled(): Promise<boolean> {
  return (await getNativeInputGate()).value
}

/**
 * 古い版の書込止め（F28③）。古い版と観測済みなら書かずに止める（送信待ちにも積まない＝古い版の書き方で後から送らない）。
 * 確かめてから時間がたっていれば背景で取り直す（この書込は待たせない）
 */
function assertBuildCurrent(): void {
  if (buildOutdated) throw new DbError('blocked', MSG.outdated)
  if (Date.now() - buildGateFetchedAt >= GATE_TTL_MS) void checkClientBuild()
}

/**
 * 書込の入口ガード。封鎖中は書かずに理由文で止める。
 * 一度も「解禁」を観測できていない状態では書かせない（並走期間の二重記録を防ぐ側に倒す）。
 */
async function assertWritable(): Promise<void> {
  if (!isSupabaseConfigured()) throw new DbError('unconfigured', MSG.unconfigured)
  assertBuildCurrent()
  // 許可リスト外と確かめた後は、確かめ直してから止める（管理者が戻した後に入力できるように・F61）
  if (memberDenied) {
    await refreshGate()
    if (memberDenied) throw new DbError('forbidden', MSG.forbidden)
  }
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

/**
 * 保存済みの申し送りの変更・取り消しの入口ガード。入力解禁に加えて、0017 が当たっていない DB では
 * 「サーバー側の更新待ち」で止める（rev 照合の旧経路へ落とさない）。確かめられない時は止めない（送信待ちに積む）
 */
async function assertNoteWritable(): Promise<void> {
  await assertWritable()
  // 0017 が無い DB でも入力は捨てない（2026-09-29 修正依頼2）: 送信待ち（notes#<id>）に積んで保存し、関数が入り次第送る。
  // 関数の有無は背景で確かめ直す（送る時にも関数が無ければ、消さずに間隔を空けて送り直す）
  if (noteRpcState !== 'ready' || Date.now() - noteRpcCheckedAt >= GATE_TTL_MS) void probeNoteRpc()
}

/** 保存済みの申し送りの変更を送れない理由（0017 が無い DB）。送信待ちの行に添える */
export const NOTES_PENDING_REASON: string = MSG.notesPending

/** 申し送りの関数（0017）が無いと観測している（送信待ちは端末に残して、関数が入り次第送る） */
export function isNoteRpcMissing(): boolean {
  return noteRpcState === 'missing'
}

// ── 種類ごとの入力解禁（2026-09-26 追加・入浴／服薬／事故） ─────────────────────
//
// app_settings の input_enabled_<種類>（0012 で 'false' を入れる）。既存の native_input_enabled と
// その封鎖（assertWritable・getNativeInputGate・cells）は一切変えない。新しい種類の書き込みは
// native_input_enabled ではなく、自分の種類の旗で判定する（assertKindWritable）。
// 取り直しの間隔・真偽の読み方・「観測できたか」の扱いは refreshGate / assertWritable と同じ。

/** 封鎖中の理由文（種類ごと）。入浴は代表指定の文言。服薬・事故は画面ができる時に見直す */
const KIND_BLOCKED_MSG: Record<InputKind, string> = {
  bath: '入浴の記録はまだ使い始めていません（開始日に解禁します）',
  med: '服薬の記録はまだ使い始めていません（開始日に解禁します）',
  incident: '事故・ヒヤリハットの記録はまだ使い始めていません（開始日に解禁します）',
}

interface KindGateState {
  /** 未観測 = null */
  value: boolean | null
  fetchedAt: number
  inFlight: Promise<boolean | null> | null
}

function newKindGates(): Record<InputKind, KindGateState> {
  return {
    bath: { value: null, fetchedAt: 0, inFlight: null },
    med: { value: null, fetchedAt: 0, inFlight: null },
    incident: { value: null, fetchedAt: 0, inFlight: null },
  }
}

let kindGates = newKindGates()

/** その種類の封鎖中の理由文（画面の案内に使う） */
export function kindBlockedMessage(kind: InputKind): string {
  return KIND_BLOCKED_MSG[kind]
}

async function refreshKindGate(kind: InputKind): Promise<boolean | null> {
  const st = kindGates[kind]
  if (st.inFlight !== null) return st.inFlight
  const run = (async (): Promise<boolean | null> => {
    try {
      const raw = await getAppSetting(`input_enabled_${kind}`)
      if (raw !== null) memberDenied = false
      // 許可リスト外（行が見えないだけ）: 封鎖を観測したことにしない（観測できなかった扱い・F61）
      else if (await deniedWhenSettingMissing()) return null
      const v = raw !== null && TRUE_WORDS.has(raw.trim().toLowerCase())
      st.value = v
      st.fetchedAt = Date.now()
      return v
    } catch {
      return null // 直近の観測値（st.value）は消さない
    } finally {
      st.inFlight = null
    }
  })()
  st.inFlight = run
  return run
}

/**
 * app_settings.input_enabled_<kind> と「サーバーの値を観測できたか」。画面を開くたびに取り直す。
 * observed=false は「入力できるかどうかが分からない」（通信エラー）で、封鎖とは別物（getNativeInputGate と同じ）。
 */
export async function getKindInputGate(
  kind: InputKind,
): Promise<{ value: boolean; observed: boolean; forbidden?: true; outdated?: true }> {
  const [v, outdated] = await Promise.all([refreshKindGate(kind), buildGateForGate()])
  // 許可リスト外（F61）: 封鎖（まだ使い始めていません）とも通信エラーとも別の案内（FORBIDDEN_REASON）を出す
  if (memberDenied) return { value: false, observed: false, forbidden: true }
  // 古い版（F28③）: 入力を止める（OUTDATED_REASON）
  if (outdated) return { value: false, observed: true, outdated: true }
  if (v !== null) return { value: v, observed: true }
  const last = kindGates[kind].value
  if (last !== null) return { value: last, observed: true }
  return { value: false, observed: false }
}

/**
 * 種類ごとの書込の入口ガード（assertWritable と同じ作り。旗だけが違う）。
 * 一度も「解禁」を観測できていない状態では書かせない。
 */
async function assertKindWritable(kind: InputKind): Promise<void> {
  if (!isSupabaseConfigured()) throw new DbError('unconfigured', MSG.unconfigured)
  assertBuildCurrent()
  if (memberDenied) {
    await refreshKindGate(kind)
    if (memberDenied) throw new DbError('forbidden', MSG.forbidden)
  }
  const st = kindGates[kind]
  if (st.value === true) {
    // 解禁を観測済み。期限切れなら背景で取り直し、この書込は待たせない（オフラインでもキューに載る）
    if (Date.now() - st.fetchedAt >= GATE_TTL_MS) void refreshKindGate(kind)
    return
  }
  const v = await refreshKindGate(kind)
  if (v === null) throw new DbError('gate-unknown', MSG.gateUnknown)
  if (!v) throw new DbError('blocked', KIND_BLOCKED_MSG[kind])
}

/**
 * 表ごとの書込の入口ガード。入浴記録は input_enabled_bath、与薬の記録は input_enabled_med、
 * 事故・ヒヤリハットは input_enabled_incident、それ以外は従来どおり native_input_enabled。
 * 服薬の時間帯（med_slots）はどの旗の封鎖も受けない（接続先の設定だけを確かめる）。
 * 与薬を使い始める前に看護師が時間帯を設定できるようにするため（2026-09-26 チーフ裁定）
 */
async function writeGate(table: LegacyTable): Promise<void> {
  if (table === 'bath_records') return assertKindWritable('bath')
  if (table === 'med_admin') return assertKindWritable('med')
  if (table === 'incidents') return assertKindWritable('incident')
  if (table === 'med_slots') {
    if (!isSupabaseConfigured()) throw new DbError('unconfigured', MSG.unconfigured)
    assertBuildCurrent() // 旗の封鎖は受けないが、古い版の止め（F28③）は受ける
    return
  }
  return assertWritable()
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
  const rows = list(res.data, normalizeResident)
  await assertSessionIfEmpty(sb, rows.length) // anon で読んだ0人を「利用者なし」と出さない（F58）
  return rows
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
  const rows = list(res.data, normalizeResident)
  await assertSessionIfEmpty(sb, rows.length) // anon で読んだ0人を「利用者なし」と出さない（F58）
  return rows
}

/**
 * 申し送りでの表示名を設定する（null＝設定を外してマスタの氏名に戻す）。
 *
 * ・この列**だけ**を書く（他の列に触れない＝マスタ同期と喧嘩しない。原則12の専用書き込み分離）
 * ・空文字は保存しない。呼ぶ側が types.ts の validateNoteAlias を通してから渡すこと
 * ・入力解禁フラグでは止めない。記録ではなく表示の設定で、並走中こそ整えておく必要があるため
 * ・通信できない・ログインが切れている時は永続キューへ退避して 'queued' を返す
 *   （同じ利用者の退避は後勝ちで1件にまとまる＝古い名前が後から復活しない）
 * ・base＝画面が見ていた変更前の表示名（F71・2026-10-10。省略＝分からない）。退避した分を送り直す時、いまの表示名が
 *   base と違えば（他の端末が後から付けた）送らずに止める。オンラインでそのまま書く経路の挙動は変えない
 */
export async function setResidentNoteAlias(
  id: number,
  alias: string | null,
  base?: string | null,
): Promise<Resident | Queued> {
  // 入力解禁の旗は受けないが、古い版の止め（F28③）は受ける（古い版の書き方で書かない）
  assertBuildCurrent()
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
    const seen = base === undefined ? undefined : base === null || base.trim() === '' ? null : base.trim()
    const payload: Record<string, unknown> = { id, note_alias: value, ...(seen !== undefined ? { base: seen } : {}) }
    if (isAuthFail(res)) {
      fireAuthExpired()
      return enqueue({ table: 'residents', kind: 'alias', payload })
    }
    if (isTransient(res)) return enqueue({ table: 'residents', kind: 'alias', payload })
    throw writeError(res)
  }
  if (res.data === null && (await sessionMissing(sb))) {
    // ログインの控えが無い間（anon キーで出た）の0行は書けていない（F58）。送信待ちに積み、控えが戻れば送る
    const seen = base === undefined ? undefined : base === null || base.trim() === '' ? null : base.trim()
    return enqueue({ table: 'residents', kind: 'alias', payload: { id, note_alias: value, ...(seen !== undefined ? { base: seen } : {}) } })
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
  await assertSessionIfEmpty(sb, staff.length) // anon で読んだ0人を「職員なし」と出さない（F58）
  return staff
}

/**
 * 職員スナップショット（**退職者も含む全員**・氏名昇順。F48・2026-10-10）。
 * 過去の記録の記入者名・出勤者名の引き当てと、記入者検索に使う（退職者が書いた過去の申し送りが「職員ID n」・「—」に
 * なり、記入者検索で見つからなかった）。記入者・出勤者を選ぶ候補や記録者の既定の照合には使わない（それは fetchStaff）
 */
export async function fetchAllStaff(): Promise<Staff[]> {
  const sb = await getClient()
  const res = (await sb
    .from('staff')
    .select(STAFF_COLS)
    .order('name', { ascending: true })
    .limit(MAX_ROWS)) as Res<unknown>
  if (res.error !== null) throw readError(res)
  const staff = list(res.data, normalizeStaff)
  await assertSessionIfEmpty(sb, staff.length) // anon で読んだ0人を「職員なし」と出さない（F58）
  allStaffCache = staff
  allStaffCachedAt = Date.now()
  return staff
}

let allStaffCache: Staff[] | null = null
let allStaffCachedAt = 0

/** 記入者検索の照合に使う職員の一覧（退職者も含む全員。F48） */
async function staffSnapshot(): Promise<Staff[]> {
  if (allStaffCache !== null && Date.now() - allStaffCachedAt < STAFF_TTL_MS) return allStaffCache
  return fetchAllStaff()
}

// ── 名簿が変わった合図と、App の職員名簿の取り直し（F47・F50・2026-10-10） ─────────────────────
// App の職員名簿は起動時に1回しか取られず、マスタ同期で職員が増えても・退職扱いになっても、開きっぱなしの端末では
// 日報の記入者などの候補が古いまま残った（「最新に更新」を押しても取り直さない）。名簿が変わった合図と、
// 画面に戻った・電波が戻った時の取り直しをここに1つ置き、App は watchStaffRoster を張るだけにする。

/** 名簿が変わった合図の受け口 */
const mastersListeners = new Set<() => void>()
/** 画面に戻った・電波が戻った時（RESYNC と同じ時）に名簿を取り直す受け口 */
const rosterResumeHooks = new Set<() => void>()

/**
 * 名簿が変わった（変わったかもしれない）ことを知らせる。マスタ同期・名簿の氏名の採用の後に gasClient が呼ぶ。
 * 画面の「最新に更新」から名簿も取り直したい時もこれを呼ぶ。受け口の例外は飲む（データアクセス層を巻き込まない）
 */
export function notifyMastersChanged(): void {
  for (const fn of [...mastersListeners]) {
    try {
      fn()
    } catch {
      // 受け口の例外で同期の結果を失わせない
    }
  }
}

/** 名簿が変わった合図を受ける（戻り値の関数で外す）。利用者の一覧を持つ画面の取り直しなどに使う */
export function subscribeMastersChanged(fn: () => void): () => void {
  mastersListeners.add(fn)
  return () => {
    mastersListeners.delete(fn)
  }
}

/**
 * 2つの職員名簿が同じ中身か（id・氏名・在籍の並びが同じ）。同じなら画面へ新しい配列を渡さない
 * （日報などは名簿の配列を effect の依存に持つので、参照が変わるだけで読み直しが走る）
 */
export function sameStaffRoster(a: readonly Staff[] | null, b: readonly Staff[] | null): boolean {
  if (a === b) return true
  if (a === null || b === null || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.id !== y.id || x.name !== y.name || x.active !== y.active) return false
  }
  return true
}

/**
 * App の職員名簿（在籍のみ・fetchStaff）を新しく保つ（F47）。次の時に取り直し、中身が変わった時だけ onChange を呼ぶ:
 *   ・名簿が変わった合図（notifyMastersChanged＝マスタ同期の後・名簿の氏名の採用の後・画面の「最新に更新」から）
 *   ・画面に戻った（RESYNC_HIDDEN_MS 以上隠れていた・ページがキャッシュから戻った）・電波が戻った
 * - 取り直しに失敗した時は何も呼ばない（今の名簿を残す。全画面のエラー・読み込み中に戻さない＝入力中の画面を消さない）
 * - 中身（id・氏名・在籍）が同じなら呼ばない（配列の参照を変えない）
 * - 重なった合図は1本にまとめ、取っている間に来た合図はその後にもう1回だけ取り直す
 * base は今 App が持っている名簿。戻り値の関数で外す（画面を閉じる・ログアウトする時）
 */
export function watchStaffRoster(base: Staff[] | null, onChange: (next: Staff[]) => void): () => void {
  let last = base
  let alive = true
  let running = false
  let again = false
  const run = async (): Promise<void> => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        try {
          const next = await fetchStaff()
          if (!alive) return
          if (!sameStaffRoster(last, next)) {
            last = next
            onChange(next)
          }
        } catch {
          // 取り直せない（圏外など）。今の名簿を残す
        }
      } while (again && alive)
    } finally {
      running = false
    }
  }
  const trigger = (): void => {
    if (alive) void run()
  }
  const off = subscribeMastersChanged(trigger)
  rosterResumeHooks.add(trigger)
  return () => {
    alive = false
    off()
    rosterResumeHooks.delete(trigger)
  }
}

/**
 * 名簿の最終同期の時刻（master_sync_log の最新・利用者と職員それぞれ。F50）。記録が無ければ null。
 * 設定画面の「最終同期 ◯日前」と、自動同期の間隔の判定（他の端末が直前に同期したか）に使う
 */
export async function fetchLastMasterSync(): Promise<{ residents: string | null; staff: string | null }> {
  const sb = await getClient()
  const latest = async (source: 'residents' | 'staff'): Promise<string | null> => {
    const res = (await sb
      .from('master_sync_log')
      .select('synced_at')
      .eq('source', source)
      .order('synced_at', { ascending: false })
      .limit(1)) as Res<unknown>
    if (res.error !== null) throw readError(res)
    const rows = Array.isArray(res.data) ? res.data : []
    const v = asRecord(rows[0])?.synced_at
    return typeof v === 'string' && v !== '' ? v : null
  }
  const [residents, staff] = await Promise.all([latest('residents'), latest('staff')])
  return { residents, staff }
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
  const chunk: TimelineChunk = {
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
  // anon で読んだ空のタイムラインを「記録なし」と出さない（F58）
  const n = chunk.notes.length + chunk.vitals.length + chunk.meals.length + chunk.fluids.length + chunk.outings.length + chunk.pinned.length
  await assertSessionIfEmpty(sb, n)
  return chunk
}

/**
 * 個人カルテ（resident_id＋日付レンジ必須・系列ごとに limit ガード）。
 * baths（入浴記録・2026-09-26 追加）は表が無い DB（0012 未適用）でも空として返し、カルテ全体を失敗させない。
 * meds（与薬の記録・2026-09-26 追加）も同じ（0013 未適用の DB では空）。
 * incidents（事故・ヒヤリハット・2026-09-26 追加）も同じ（0014 未適用の DB では空）。一覧の列だけ（detail は持ち出さない）
 */
export async function fetchKarte(
  residentId: number,
  fromIso: string,
  toIso: string,
): Promise<{
  vitals: Vital[]
  meals: Meal[]
  fluids: FluidIntake[]
  notes: Note[]
  outings: Outing[]
  baths: BathRecord[]
  meds: MedAdmin[]
  incidents: Incident[]
}> {
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

  const [vitals, meals, fluids, notes, outings, baths, meds, incidents] = await Promise.all([
    range<unknown>('vitals', VITAL_COLS, 'measured_on', KARTE_ROWS),
    range<unknown>('meals', MEAL_COLS, 'meal_on', MAX_ROWS),
    range<unknown>('fluid_intake', FLUID_COLS, 'taken_on', MAX_ROWS),
    range<unknown>('notes', NOTE_COLS, 'note_on', KARTE_ROWS),
    outingsQuery,
    range<unknown>('bath_records', BATH_COLS, 'bath_on', KARTE_ROWS),
    // 与薬は1日に5件前後あるので、食事と同じ上限（MAX_ROWS）にする（KARTE_ROWS では1年表示で欠ける）
    range<unknown>('med_admin', MED_ADMIN_COLS, 'admin_on', MAX_ROWS),
    range<unknown>('incidents', INCIDENT_LIST_COLS, 'occurred_on', KARTE_ROWS),
  ])
  for (const res of [vitals, meals, fluids, notes, outings]) {
    if (res.error !== null) throw readError(res)
  }
  // 入浴記録の表がまだ無い（0012 未適用）だけなら空で返す。それ以外の失敗は他の系列と同じく例外
  if (baths.error !== null && !isMissingTable(baths)) throw readError(baths)
  // 与薬の記録の表がまだ無い（0013 未適用）だけなら空で返す
  if (meds.error !== null && !isMissingTable(meds)) throw readError(meds)
  // 事故・ヒヤリハットの表がまだ無い（0014 未適用）だけなら空で返す
  if (incidents.error !== null && !isMissingTable(incidents)) throw readError(incidents)
  return {
    vitals: list(vitals.data, normalizeVital, KARTE_ROWS),
    meals: list(meals.data, normalizeMeal),
    fluids: list(fluids.data, normalizeFluid),
    notes: list(notes.data, normalizeNote, KARTE_ROWS),
    outings: list(outings.data, normalizeOuting, KARTE_ROWS),
    baths: baths.error !== null ? [] : list(baths.data, normalizeBath, KARTE_ROWS),
    meds: meds.error !== null ? [] : list(meds.data, normalizeMedAdmin),
    incidents: incidents.error !== null ? [] : list(incidents.data, normalizeIncident, KARTE_ROWS),
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
  // 行が無い＝未登録。ただしログインの控えが無い間（anon キーで読んだ＝RLS で見えないだけ）は、未登録と断定しない
  // （F58。入力解禁の「false を観測」にすると、スプレッドシート期間の案内が出て入力が止まる）
  if (res.data === null) await assertSessionIfEmpty(sb, 0)
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
  /** 冪等キーで「既に届いている」行を返す前に呼ぶ（送った中身と食い違う欄を残すため。例外で成功扱いを止める・R6(A)） */
  onDuplicate?: (row: T) => Promise<void>,
  /**
   * 応答を待つ上限（ms）。過ぎたら送信を打ち切り、通信断と同じ扱い（status 0＝一時エラー）で送信待ちへ退避する
   * （同じ冪等キーで送り直す＝後から届いていても1行に収まる・L7-1）。省くと待ち続ける（従来どおり）
   */
  timeoutMs?: number,
): Promise<T | Queued> {
  await writeGate(table)
  const sb = await getClient()
  const cols = colsOf(table)
  const res = await withTimeout(
    (signal) => {
      const q = sb.from(table).insert(payload).select(cols) as unknown as {
        abortSignal?: (s: AbortSignal) => unknown
        maybeSingle: () => PromiseLike<unknown>
      }
      const withSignal = signal !== null && typeof q.abortSignal === 'function' ? (q.abortSignal(signal) as typeof q) : q
      return withSignal.maybeSingle() as PromiseLike<Res<unknown>>
    },
    timeoutMs,
  )

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
        if (row !== null && onDuplicate !== undefined) await onDuplicate(row)
        return row ?? enqueue({ table, kind: 'insert', payload })
      }
      // 自然キーを持たない表は冪等キーでしか 23505 にならない。万一来た時は従来どおりの例外
      throw new DbError('server', MSG.raceInsert)
    }
    throw rejectError('保存でき', errCode(res), res.status)
  }
  markSelfRow(table, res.data, num(asRecord(res.data)?.rev)) // 版が確定した
  kickAfterDelivered()
  const row = normalize(res.data)
  if (row === null) throw new DbError('server', MSG.broken)
  return row
}

/**
 * 直接の書込（送信待ちを通らない保存）がサーバーに届いた＝つながっている。通信不能で待っていた送信待ちを、待ち時間を
 * 置かずに送る（F06。届いた保存の後も最大30分前の送信待ちが送られなかった）。通信不能で待っている分が無ければ何もしない
 */
function kickAfterDelivered(): void {
  const waiting = queue.some((o) => o.netFail === true && o.blocked === undefined) || [...cellRows.values()].some((e) => e.netFail === true && e.state === 'pending')
  if (waiting) void scheduleFlush(false, 0, true)
}

async function updateRow<T>(
  table: LegacyTable,
  id: number,
  rev: number,
  patch: Record<string, unknown>,
  normalize: (row: unknown) => T | null,
  opts?: WriteOpts,
): Promise<T | Conflict | Queued> {
  await writeGate(table)
  if (Object.keys(patch).length === 0) throw new DbError('server', MSG.emptyPatch)
  const sb = await getClient()
  // edited_by を必ず添える（分からない時は null。退避する時も添えたまま＝触った人を後から取り違えない）
  const sent = withEditor(patch, opts?.editedBy)
  // 自分の更新は rev + 1 になる。印は書けた（応答で版が確定した）時だけ付け、応答を待つ間に届いたこの行の通知は
  // 預かる（F10。競り負け・退避の時に、他の端末の同じ版の通知を自分の書込として捨てない）
  const end = beginRowWrite(table, id)
  let landed: number | undefined
  try {
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
        return await enqueue({ table, kind: 'update', payload: sent, rowId: id, rev })
      }
      if (isTransient(res)) return await enqueue({ table, kind: 'update', payload: sent, rowId: id, rev })
      throw rejectError('保存でき', errCode(res), res.status)
    }
    if (res.data === null) {
      // ログインの控えが無い間（anon キーで出た）の0行は競合ではない（F58）。送信待ちに積み、控えが戻れば送る
      if (await sessionMissing(sb)) return await enqueue({ table, kind: 'update', payload: sent, rowId: id, rev })
      return CONFLICT // 0行 = 他端末が先に更新（または削除済み）
    }
    landed = num(asRecord(res.data)?.rev) ?? rev + 1
    kickAfterDelivered()
    const row = normalize(res.data)
    if (row === null) throw new DbError('server', MSG.broken)
    return row
  } finally {
    end(landed)
  }
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
  await writeGate(table)
  const sb = await getClient()
  const sent = withEditor(patch, opts?.editedBy) // edited_by を必ず添える（分からない時は null。退避にも添えたまま）
  // 印は書けた時だけ付け、応答を待つ間のこの行の通知は預かる（F10。updateRow と同じ）
  const end = beginRowWrite(table, id)
  let landed: number | undefined
  try {
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
        return await enqueue({ table, kind: 'update', payload: sent, rowId: id, rev })
      }
      if (isTransient(res)) return await enqueue({ table, kind: 'update', payload: sent, rowId: id, rev })
      throw writeError(res)
    }
    if (res.data === null) {
      // ログインの控えが無い間（anon キーで出た）の0行は競合ではない（F58）。送信待ちに積み、控えが戻れば送る
      if (await sessionMissing(sb)) return await enqueue({ table, kind: 'update', payload: sent, rowId: id, rev })
      return CONFLICT
    }
    landed = num(asRecord(res.data)?.rev) ?? rev + 1
    kickAfterDelivered()
    const row = normalize(res.data)
    if (row === null) throw new DbError('server', MSG.broken)
    return row
  } finally {
    end(landed)
  }
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
  await writeGate(table)
  const sb = await getClient()
  // edited_by を必ず添える（誰が消したかを変更の記録に残す。分からない時は null。退避にも添えたまま）
  const payload = withEditor({ deleted_at: new Date().toISOString() }, opts?.editedBy)
  // 印は書けた時だけ付け（取り消しは rev + 1）、応答を待つ間のこの行の通知は預かる（F10）
  const end = beginRowWrite(table, id)
  let landed: number | undefined
  try {
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
        return await enqueue({ table, kind: 'update', payload, rowId: id, rev })
      }
      if (isTransient(res)) return await enqueue({ table, kind: 'update', payload, rowId: id, rev })
      throw writeError(res)
    }
    if (res.data === null) {
      // ログインの控えが無い間（anon キーで出た）の0行は競合ではない（F58）。送信待ちに積み、控えが戻れば送る
      if (await sessionMissing(sb)) return await enqueue({ table, kind: 'update', payload, rowId: id, rev })
      return CONFLICT
    }
    landed = rev + 1
    kickAfterDelivered()
    return true
  } finally {
    end(landed)
  }
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
export type CellEditInput<F extends string> = Partial<
  // seen は申し送りの取り消し（deleted_at）だけ（F09・取り消すと決めた時に画面に出ていた行の欄）
  Record<F, { value: unknown; base?: unknown; seen?: Record<string, unknown> }>
>

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
  /** 申し送り: どの日・区分・対象の行か（「送れていない申し送り」の一覧・〔新しい行として登録〕に使う控え） */
  meta?: NoteMeta
  /** 送信待ちに積むだけで、送信の結果を待たない（stageNoteEdits） */
  stageOnly?: boolean
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

function parseCellResult(table: RowTable, data: unknown): CellResult | null {
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
      // 取り消しが見た行と食い違った欄（F09・0027）。名前は申し送りの欄だけ（deleted_at 自身は入らない）
      const fs = conflictFieldsOf(cr.fields, NOTE_SEEN_FIELDS)
      conflicts.push({ field, server: cr.server ?? null, base: cr.base ?? null, mine: cr.mine ?? null, reason, ...(fs !== null ? { fields: fs } : {}) })
    }
  }
  return { status, row: asRecord(r.row), applied: names(r.applied), settled: names(r.settled), conflicts }
}

/** 期限の来たバイタル・食事の行を、古い入力の順に1行ずつ送る（行ごとに独立。つながらなければ打ち切る） */
async function sendDueCells(sb: SupabaseClient, force: boolean, boost = false): Promise<void> {
  const now = Date.now()
  const oldest = (e: CellEntry): number => Math.min(...Object.values(e.edits).map((x) => x.at))
  // boost＝つながったと分かった・画面に戻った: 直前の失敗が通信不能だった行は待ち時間を置かずに送る（F06）
  const due = [...cellRows.entries()]
    .filter(([, e]) => e.state === 'pending' && (force || e.nextAt <= now || (boost && e.netFail === true)))
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
  if (e.table === 'notes' && e.key.client_key !== undefined) {
    // 送信待ちの登録への変更（notes#ck:<client_key>）: 登録が届いて行が分かってから、その行の変更として送る
    const bound = await bindNoteClientKey(sb, rowKey, e)
    if (bound === null) return 'ok' // まだ届いていない・確かめられない（消さずに待つ）
    rowKey = bound
    e = cellRows.get(rowKey)
    if (e === undefined || e.state !== 'pending') return 'ok'
  }
  if (e.table === 'notes') {
    // 旧ビルドの退避を読み替えた申し送り: 送る直前に1行読み、rev が同じなら基準を埋める（読むだけ・書かない）
    if (e.baseRev !== undefined && (await fillNoteBase(sb, e)) === 'offline') return 'offline'
    e = cellRows.get(rowKey)
    if (e === undefined || e.state !== 'pending') return 'ok'
  } else if (e.key.id !== undefined && (e.table === 'meals' || e.bound !== true)) {
    const bound = await bindIdKey(sb, rowKey, e)
    if (bound === 'offline') return 'offline'
    if (bound === null) return 'ok'
    rowKey = bound
    e = cellRows.get(rowKey)
    if (e === undefined || e.state !== 'pending') return 'ok'
  }
  const seq = cellRecordSeq
  const table = e.table
  const rowId = idNum(e.key.id)
  // 行 id で指す行は、応答を待つ間に届いたその行の通知を預かる（F10。印は応答で版が確定した後に付ける）
  const endWrite = beginRowWrite(table, rowId)
  try {
    // 送信待ちの間に別の職員が同じ行へ入力していたら、職員ごとに分けて送る（F07。edited_by を職員ごとに残す）
    const groups = editorGroups(e)
    let combined: CellResult | null = null
    /**
     * 前のまとまりで食い違った欄（F07 手直し）。1人目の職員の欄が他の端末と食い違っても、食い違っていない別の職員の欄は
     * 続けて送る（止めると、誰とも食い違っていない欄まで「止まっている」に入り、〔先の値を残す〕で一緒に捨てられた）。
     * 行の状態（conflict）は最後のまとまりの応答で1回だけ決める（F07 手直し2回目）。途中で conflict にすると、残りの
     * まとまりを送っている間に画面が行を「止まっている」と読み、まだ送っていない欄（後の職員の脈拍など）まで
     * 「あなたの入力」に取り込んで、送れた後も「保存されません」と出した（画面の取り込みは足すだけで外さない）
     */
    let priorConflicts: CellConflict[] = []
    /** 行の状態を最後のまとまりの応答で決めたか（後のまとまりの欄が応答の片付けで消えて送らずに終わった時の決め直し用） */
    let decided = true
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]
      const cur0 = cellRows.get(rowKey)
      if (cur0 === undefined) break
      // 拒否で止まった行は送らない（前のまとまりの食い違いでは状態を変えないので、ここでは pending のまま）
      if (cur0.state !== 'pending') break
      const sent = new Map<string, CellEdit>()
      const pEdits: Record<string, unknown> = {}
      for (const f of g.fields) {
        const ed = cur0.edits[f]
        if (ed === undefined) continue
        sent.set(f, ed)
        pEdits[f] = Object.prototype.hasOwnProperty.call(ed, 'base') ? { value: ed.value, base: ed.base } : { value: ed.value }
        // 申し送りの取り消しの見た行（F09・0027）。0017 のサーバーはこのキーを読まない（本文だけで判定＝従来どおり）
        if (ed.seen !== undefined) (pEdits[f] as Record<string, unknown>).seen = ed.seen
      }
      if (sent.size === 0) continue
      const res = await bounded(
        table === 'notes'
          ? sb.rpc('apply_note_edits', { p_id: cur0.key.id, p_edits: pEdits, p_editor: g.editor })
          : sb.rpc('apply_cell_edits', {
              p_table: table,
              p_key: cur0.key,
              p_edits: pEdits,
              // 空いていれば埋める欄（記入者・測定時刻）は最初のまとまりだけに付ける（先に入れた人の値を保つ）
              p_fill: gi === 0 ? cur0.fill : {},
              p_editor: g.editor,
              p_client_key: cur0.clientKey ?? null,
            }),
      )
      const cur = cellRows.get(rowKey)
      if (res.error !== null) {
        const retry = (net: boolean): 'offline' => {
          if (cur !== undefined) {
            cur.tries += 1
            cur.nextAt = Date.now() + backoff(cur.tries)
            // 通信不能・認証切れは、つながったと分かった時に待ち時間を置かずに送り直す（F06）
            if (net) cur.netFail = true
            else delete cur.netFail
          }
          cellOutcomes.set(rowKey, { seq, kind: 'queued' })
          return 'offline'
        }
        if (isAuthFail(res)) {
          fireAuthExpired()
          return retry(true)
        }
        if (isTransient(res)) return retry(true)
        // ログインの控えが無い間（anon キーで出た）の拒否（403・42501）は止めない（F58。控えが戻れば送る）
        if (await sessionMissing(sb)) return retry(true)
        deliveredThisRound = true
        // 関数がまだ無い: 旧経路へ落とさず、消さずに待つ（入力は「サーバー側の更新待ち」で止まる）
        if (isMissingRpc(res)) {
          if (table === 'notes') {
            // 申し送りの関数（0017）がまだ無い: 送信待ちに残して間隔を空けて送り直す（その間もバイタル・食事は送る）
            markNoteRpc('missing')
            retry(false)
            return 'ok'
          }
          markCellRpc('missing')
          return retry(false)
        }
        // サーバーに拒否された（型にできない値・範囲外など）。新しい入力が来るまで送らない（控えは残す）
        if (cur !== undefined) {
          cur.state = 'rejected'
          cur.tries += 1
          cur.at = Date.now()
          delete cur.netFail
        }
        cellOutcomes.set(rowKey, { seq, kind: 'rejected', code: errCode(res) })
        await persistQueueLocked()
        return 'ok'
      }
      deliveredThisRound = true
      if (cur !== undefined) delete cur.netFail
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
      if (table === 'notes') markNoteRpc('ready')
      else markCellRpc('ready')
      // 書けた＝この版の変更通知は自分が出したもの（書かなかった時の版は他の端末の変更なので覚えない）
      if (result.applied.length > 0 && result.row !== null) markSelfRow(table, result.row, num(result.row.rev))
      else if (table === 'notes' && result.applied.length > 0 && result.row === null && rowId !== null) {
        // 申し送りを取り消せた（0017 は取り消した後の行を返さない）。取り消した行は他の端末が書き換えられない
        // （0017・旧経路とも取り消し済みの行は書かない）ので、版なしの印を通常の猶予で付けてよい（F11。
        // 付けないと、自分の取り消しの通知で「他の端末で記録が更新されました」が出る）
        markSelfRow('notes', { id: rowId }, null, SELF_ROW_TTL_MS)
      }
      // 後に送るまとまりが残っていれば、状態は決めずに食い違いだけ持ち越す（途中で抜けた時＝通信不能・応答が読めない時は
      // 行を送る状態のまま残し、次の送信で前のまとまりも送り直して食い違いを取り直す。書かない呼び出しなので害は無い）
      const last = groups.slice(gi + 1).every((x) => x.fields.every((f) => cellRows.get(rowKey)?.edits[f] === undefined))
      priorConflicts = applyCellResponse(rowKey, sent, result, priorConflicts, last)
      decided = last
      combined = combined === null ? result : combineCellResults(combined, result)
      cellOutcomes.set(rowKey, { seq, kind: 'result', result: combined })
      await persistQueueLocked()
    }
    if (!decided) {
      // 残っていたまとまりを送らずに終わった（欄が先の応答で片付いた）: 持ち越した食い違いで行の状態を決める
      const cur = cellRows.get(rowKey)
      const cs = cur === undefined ? [] : priorConflicts.filter((c) => c.field in cur.edits)
      if (cur !== undefined && cur.state === 'pending' && cs.length > 0) {
        cur.conflicts = cs
        cur.state = 'conflict'
        await persistQueueLocked()
      }
    }
    return 'ok'
  } finally {
    endWrite()
  }
}

/**
 * 送信待ちの1行を、入力した職員ごとのまとまりに分ける（F07・2026-10-10 本人回答「職員ごとに分けて送る」）。
 * 欄ごとの入力者（by。無い欄＝旧版の控えは行の editor）で分け、最初に入力された順に並べる。
 * 血圧の上と下は1つの組（0011 が1回の呼び出しの中で組として判定する）なので割らず、後に入力した職員の方へまとめる。
 * 申し送りの取り消し（deleted_at）を含む行は分けない（取り消しの基準＝見た本文の判定を、本文の変更と同じ1回で行う）
 */
function editorGroups(e: CellEntry): { editor: number | null; fields: string[] }[] {
  // 入力された順（同じミリ秒でも同じタブの版は連番で決まる＝newerEdit）
  const entries = Object.entries(e.edits).sort((a, b) => (a[1].ver === b[1].ver ? 0 : newerEdit(a[1], b[1]) === a[1] ? 1 : -1))
  const byOf = new Map<string, number | null>()
  for (const [f, ed] of entries) byOf.set(f, ed.by !== undefined ? ed.by : e.editor)
  const distinct = new Set(byOf.values())
  if (distinct.size <= 1 || e.edits.deleted_at !== undefined) {
    return [{ editor: distinct.size === 1 ? ([...distinct][0] ?? null) : e.editor, fields: entries.map(([f]) => f) }]
  }
  for (const f of Object.keys(BP_PAIR)) {
    const o = BP_PAIR[f]
    const a = e.edits[f]
    const b = e.edits[o]
    if (a === undefined || b === undefined || byOf.get(f) === byOf.get(o)) continue
    const later = newerEdit(a, b) === a ? f : o
    const ed = byOf.get(later) ?? null
    byOf.set(f, ed)
    byOf.set(o, ed)
  }
  const groups: { editor: number | null; fields: string[] }[] = []
  for (const [f] of entries) {
    const ed = byOf.get(f) ?? null
    const g = groups.find((x) => x.editor === ed)
    if (g !== undefined) g.fields.push(f)
    else groups.push({ editor: ed, fields: [f] })
  }
  return groups
}

/** 職員ごとに分けて送った結果を1つにまとめる（保存の呼び手へ返す結果。状態は 0011 と同じ決め方） */
function combineCellResults(a: CellResult, b: CellResult): CellResult {
  const applied = [...a.applied, ...b.applied.filter((f) => !a.applied.includes(f))]
  const conflicts = [...a.conflicts, ...b.conflicts.filter((c) => !a.conflicts.some((x) => x.field === c.field))]
  const status = applied.length > 0 && conflicts.length > 0 ? 'partial' : applied.length > 0 ? 'applied' : conflicts.length > 0 ? 'conflict' : 'noop'
  return {
    status,
    row: b.row ?? a.row,
    applied,
    settled: [...a.settled, ...b.settled.filter((f) => !a.settled.includes(f))],
    conflicts,
  }
}

/**
 * 継続の終了で、〔くらべて選ぶ〕で人が選んだ送信か（F08 手直し・2026-10-10）。ended_by の基準が「先に終了した職員」
 * （非 null）の時だけ true。〔継続を終了〕は基準なし、または終了していない行を見て押した＝基準 null で送る
 * （0030 でタイムラインが ended_by を返すようになり、画面は基準 null を付けて送る。基準の有無だけで見分けると、
 * 後着の終了がボタンの操作なのに「人の選択」とみなされ、外れずに「止まっています」に残った）。
 * 人が選ぶのは食い違いを見た後＝先の終了が見えている（基準が非 null）ので、この見分けで取り違えない
 */
function chosenEnd(ed: { base?: unknown }): boolean {
  return Object.prototype.hasOwnProperty.call(ed, 'base') && ed.base !== null && ed.base !== undefined
}

/** 継続の終了の組（F08） */
const END_FIELDS: readonly string[] = ['ended_at', 'ended_by']

/**
 * 継続の終了の後着か（F08・2026-10-10 本人回答「後の終了は既に終了済みとして黙って外す＝最初の終了を正」）。
 * 終了の操作（ended_by を含む送信）が競合で返り、サーバーがもう終了している（終了した職員が入っている、または終了時刻が
 * この端末の終了時刻以前）なら true。ended_at が非 null なだけでは終了済みとみなさない（登録時に予定の期限が入るため）。
 * ended_at・ended_by のどちらかが書けた（組が割れた）時は外さない（〔くらべて選ぶ〕で組をそろえてもらう）
 */
function lateEndSettled(e: CellEntry, result: CellResult): boolean {
  // 〔くらべて選ぶ〕で人が選んだ値（ended_by の基準に、先に終了した職員＝非 null が入る）は外さない
  if (e.table !== 'notes' || e.edits.ended_by === undefined || chosenEnd(e.edits.ended_by)) return false
  if (result.applied.some((f) => END_FIELDS.includes(f))) return false
  const byC = result.conflicts.find((c) => c.field === 'ended_by' && c.reason === 'changed')
  if (byC !== undefined && byC.server !== null && byC.server !== undefined) return true
  const atC = result.conflicts.find((c) => c.field === 'ended_at' && c.reason === 'changed')
  const mine = e.edits.ended_at?.value
  if (atC === undefined || typeof atC.server !== 'string' || typeof mine !== 'string') return false
  const srv = Date.parse(atC.server)
  const at = Date.parse(mine)
  return Number.isFinite(srv) && Number.isFinite(at) && srv <= at
}

/**
 * 応答を送信待ちへ当てる。書けた欄・もう載っていた欄は、送った時と版が同じ時だけ消す。
 * 送信中に同じ欄を打ち直していたら、その欄は残して基準を「いまサーバーにある値（送って載った値）」へ持ち直す
 * （持ち直さないと、次の送信で自分が載せた値と競合する）。書かなかった欄は残し、行を conflict にする
 */
function applyCellResponse(
  rowKey: string,
  sent: Map<string, CellEdit>,
  result: CellResult,
  /** 同じ回で先に送ったまとまりの食い違い（F07 手直し。職員ごとに分けて送る時だけ。この応答の欄は除いて重ねる） */
  prior: readonly CellConflict[] = [],
  /**
   * 行の状態を決めるか（F07 手直し2回目）。false＝同じ行に後で送るまとまりが残っている: 欄の片付けだけ行い、
   * 状態（conflict）と食い違いの一覧は書かずに戻り値で返す（最後のまとまりの応答で prior として重ねて決める）
   */
  final = true,
): CellConflict[] {
  const e = cellRows.get(rowKey)
  if (e === undefined) return []
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
      const srv =
        result.row === null ? undefined : f === 'deleted_at' ? cellValueOf('body', result.row.body) : cellValueOf(f, result.row[f])
      e.edits[f] = { ...cur, base: srv === undefined ? was.value : srv }
    }
  }
  let conflicts = result.conflicts.filter((c) => c.field in e.edits)
  for (const c of prior) {
    if (c.field in e.edits && !sent.has(c.field) && !conflicts.some((x) => x.field === c.field)) conflicts.push(c)
  }
  for (const f of heldPair) {
    const ed = e.edits[f]
    conflicts.push({ field: f, server: result.row?.[f] ?? null, base: ed.base ?? null, mine: ed.value, reason: 'changed' })
  }
  if (lateEndSettled(e, result)) {
    // 継続の終了の後着（F08）: サーバーはもう終了している＝最初の終了を正として、この端末の終了は「済み」で外す
    for (const f of END_FIELDS) {
      const cur = e.edits[f]
      const was = sent.get(f)
      if (cur === undefined) continue
      if (was !== undefined) markDone(rowKey, f, was)
      if (was === undefined || cur.ver === was.ver) delete e.edits[f]
    }
    conflicts = conflicts.filter((c) => !END_FIELDS.includes(c.field))
    // 呼び手へ返す結果も「済み」にそろえる（画面に「止まっています」を出さない）
    result.conflicts = result.conflicts.filter((c) => !END_FIELDS.includes(c.field))
    for (const f of END_FIELDS) if (sent.has(f) && !result.settled.includes(f)) result.settled.push(f)
    result.status = result.applied.length > 0 ? (result.conflicts.length > 0 ? 'partial' : 'applied') : result.conflicts.length > 0 ? 'conflict' : 'noop'
  }
  if (!final) {
    // 残りのまとまりを送る間は送る状態のまま（画面・別のタブに「止まっている」と見せない）
    delete e.conflicts
    e.state = 'pending'
  } else if (conflicts.length > 0) {
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
  return conflicts
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
  const res = await bounded(
    sb
      .from(e.table)
      .select(isMeal ? 'id,resident_id,meal_on,meal_slot' : 'id,resident_id,measured_on,kind')
      .eq('id', e.key.id as number)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle(),
  )
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
    if (Object.prototype.hasOwnProperty.call(newer, 'by')) merged.by = newer.by
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

/** その冪等キーの申し送りの登録が、まだ送信待ち（このタブ・同じ端末の他のタブの cl_sendQueue）に残っているか */
function noteInsertQueued(clientKey: string): QueueOp | null {
  const mine = queue.find((o) => o.qid === clientKey && o.table === 'notes' && o.kind === 'insert')
  if (mine !== undefined) return mine
  if (sentQids.has(clientKey)) return null
  return storedOps().find((o) => o.qid === clientKey && o.table === 'notes' && o.kind === 'insert') ?? null
}

/**
 * 送信待ちの登録への変更（notes#ck:<client_key>・分けて持つ入力を含む）を、登録が届いた行（notes#<id>）へ付け替える
 * （2026-09-29 第3巡）。登録がまだ送信待ちに残っている・届いた行が見つからない・読めない時は付け替えずに待つ（null。消さない）。
 * 付け替える時は、同じ行の送信待ち（notes#<id>）へ重ねる（値は後の方・基準は先の方＝登録で送った値）
 */
async function bindNoteClientKey(sb: SupabaseClient, rowKey: string, e: CellEntry): Promise<string | null> {
  const ck = String(e.key.client_key)
  if (noteInsertQueued(ck) !== null) return null // 登録を先に送る（登録が送れた後の送信で付け替える）
  const found = await findByKeyResult(sb, 'notes', { client_key: ck }, 'id,rev')
  if (found === 'error') {
    // 読めない: 間隔を空けて確かめ直す（消さない）
    e.tries += 1
    e.nextAt = Date.now() + backoff(e.tries)
    return null
  }
  if (found === 'none') {
    // 登録が送信待ち（このタブ・保存先）にもサーバーにも無い＝送り先の登録が無くなった（取り下げた・別の新しい行として
    // 登録した。第4巡 R4-2）。自動では送らず「止まっている」件にして照会を止める（消さない。一覧の〔新しい行として登録〕
    // 〔取り下げ〕で回収する。この行へ新しい入力が積まれた時だけ、もう一度確かめる）
    await withWriteLock(() => {
      refreshCells()
      const cur = cellRows.get(rowKey)
      if (cur !== undefined && cur.state === 'pending') {
        cur.state = 'rejected'
        cur.tries += 1
        cur.at = Date.now()
      }
      persistUnderLock()
    })
    return null
  }
  const key: Record<string, string | number> = { id: found.id }
  if (e.key.fork !== undefined) key.fork = e.key.fork
  const nextKey = cellRowKey('notes', key)
  let out = nextKey
  await withWriteLock(() => {
    refreshCells()
    const cur = cellRows.get(rowKey)
    if (cur === undefined) {
      out = nextKey
      persistUnderLock()
      return
    }
    const now = Date.now()
    const target = cellRows.get(nextKey)
    const moved: CellEntry = { ...cur, key, edits: target ? { ...target.edits } : {}, at: now, tab: tabId }
    if (target?.meta !== undefined && moved.meta === undefined) moved.meta = target.meta
    for (const [f, ed] of Object.entries(cur.edits)) {
      markDone(rowKey, f, ed)
      const prev = moved.edits[f]
      const next: CellEdit = { value: ed.value, at: ed.at, ver: newCellVer() }
      if (Object.prototype.hasOwnProperty.call(ed, 'by')) next.by = ed.by
      // 基準は先の方（同じ行に先に積んであった入力の基準＝その人が見ていた値。無ければ登録で送った値）
      const baseFrom = prev !== undefined && Object.prototype.hasOwnProperty.call(prev, 'base') ? prev : ed
      if (Object.prototype.hasOwnProperty.call(baseFrom, 'base')) next.base = baseFrom.base
      if (prev !== undefined) markDone(nextKey, f, prev)
      moved.edits[f] = prev !== undefined && prev.at > ed.at ? { ...prev, ver: newCellVer() } : next
    }
    if (target !== undefined && (target.state === 'conflict' || target.state === 'rejected')) {
      moved.state = target.state
      if (target.conflicts !== undefined) moved.conflicts = target.conflicts
    }
    cellRows.delete(rowKey)
    cellRows.set(nextKey, moved)
    persistUnderLock()
  })
  return out
}

/**
 * 旧ビルドが rev 照合で退避した申し送りの変更（baseRev つき）に、送る直前に基準を埋める（読むだけ）。
 * いまの行の rev が退避した時の rev と同じ＝退避した後に誰も書いていない＝いまの値がその時に見ていた値。
 * rev が違う・行が無い・取り消された時は基準を埋めない（基準が分からないまま送る＝サーバーは空の欄だけ書き、
 * 本文は競合で止める＝黙って上書きしない）。どちらでも baseRev は外す（次からは読まない）。
 * 通信できなければ 'offline'（baseRev を残して次の送信で読み直す）
 */
async function fillNoteBase(sb: SupabaseClient, e: CellEntry): Promise<'ok' | 'offline'> {
  const res = await bounded(sb.from('notes').select(`${NOTE_COLS},deleted_at`).eq('id', e.key.id as number).limit(1).maybeSingle())
  if (res.error !== null) {
    if (isAuthFail(res)) fireAuthExpired()
    if (isAuthFail(res) || isTransient(res)) {
      e.tries += 1
      e.nextAt = Date.now() + backoff(e.tries)
      return 'offline'
    }
    // 読めない（権限など）: 基準は分からないまま送る（サーバーが欄ごとに裁く）
    delete e.baseRev
    return 'ok'
  }
  const row = asRecord(res.data)
  if (row !== null && row.deleted_at === null && num(row.rev) === e.baseRev) {
    for (const [f, ed] of Object.entries(e.edits)) {
      if (Object.prototype.hasOwnProperty.call(ed, 'base')) continue
      // 取り消しの基準は「その時に見ていた本文」
      const b = f === 'deleted_at' ? cellValueOf('body', row.body) : cellValueOf(f, row[f])
      if (b !== undefined) e.edits[f] = { ...ed, base: b }
    }
  }
  delete e.baseRev
  e.at = Date.now()
  await persistQueueLocked()
  return 'ok'
}

/**
 * 止まった（競合・拒否）行 id の行を、読み取りだけで自然キーへ付け替える（第4段 F1。書込はしない）。
 * 旧ビルドで止まった食事・定時バイタルの op は、読み替えると行 id のまま残り、送られないので送る前の付け替えも走らず、
 * どの画面にも出なかった。付け替えると画面の pendingRow から競合・拒否として見え、〔くらべて選ぶ〕で解決できる。
 * 行が取り消されている・読めない時は行 id のまま残す（消さない・未送信に数え続ける）。通信できなければ次の送信の時にもう一度
 */
async function bindStoppedIdRows(sb: SupabaseClient): Promise<void> {
  for (const [rowKey, e] of [...cellRows.entries()]) {
    if (e.table === 'notes') continue // 申し送りは行 id のまま（自然キーを持たない）
    if (e.state === 'pending' || e.key.id === undefined || e.bindChecked === true) continue
    if (e.table === 'vitals' && e.bound === true) continue
    if ((await bindIdKey(sb, rowKey, e, { readOnly: true })) === 'offline') break
  }
}

/**
 * 行 id で指した行の、冪等キーで作った同じ行の控え（#6）。1つの記録の行キーは作られた時の形（vitals~ck）のまま
 * 変えないので、画面が行 id で指しても、見る・送る・取り下げるのはこの控え。無ければ null
 */
function aliasRowKey(table: RowTable, key: Record<string, string | number>, rows: Map<string, CellEntry>): string | null {
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
  table: RowTable,
  target: VitalTarget | MealTarget | NoteTarget,
  sendEdits: CellEditInput<string>,
  opts?: CellSaveOpts,
): Promise<CellSaveInternal> {
  if (table === 'notes') await assertNoteWritable()
  else await assertCellWritable()
  const key0 = keyOfTarget(table, target)
  if (key0 === null) throw new DbError('server', MSG.broken)
  let key: Record<string, string | number> = key0
  let rowKey = cellRowKey(table, key)
  // 値を先に検める（読めない値は送信待ちへ入れない）。送る値は列の精度にそろえる
  const fields = cellFieldsOf(table)
  const asNew = opts?.asNew === true
  const incoming: { f: string; value: CellValue; base?: CellValue; seen?: Record<string, CellValue> }[] = []
  for (const [f, ed] of Object.entries(sendEdits)) {
    if (ed === undefined) continue
    const value = fields.includes(f) ? cellValueOf(f, ed.value) : undefined
    if (value === undefined) throw new DbError('server', MSG.broken)
    // 申し送りの本文を空にする編集は送信待ちへ入れない（0001 の check と同じ。入力は画面に残る）
    if (table === 'notes' && f === 'body' && (value === null || (typeof value === 'string' && value.trim() === ''))) {
      throw new DbError('server', MSG.emptyBody)
    }
    // 新しい行として保存: 空にする欄は送らない・基準は空（F4）
    if (asNew && value === null) continue
    const item: { f: string; value: CellValue; base?: CellValue } = asNew ? { f, value, base: null } : { f, value }
    // 基準が無い・読めない（rowSync の「基準不明」の印を含む）時は、基準を持たない＝サーバーは空の時だけ書く
    if (!asNew && Object.prototype.hasOwnProperty.call(ed, 'base') && ed.base !== undefined && typeof ed.base !== 'symbol') {
      // 申し送りの取り消し（deleted_at）の基準は「見た本文」
      const b = table === 'notes' && f === 'deleted_at' ? cellValueOf('body', ed.base) : cellValueOf(f, ed.base)
      if (b !== undefined) item.base = b
    }
    // 申し送りの取り消しの「見た行」（F09）。読めない値があれば送らない（照合の弱い取り消しにしない）
    if (table === 'notes' && f === 'deleted_at' && !asNew && ed.seen !== undefined) {
      const seen = noteSeenOf(ed.seen, cellValueOf)
      if (seen === null) throw new DbError('server', MSG.broken)
      ;(item as { seen?: Record<string, CellValue> }).seen = seen
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
        else e.edits[f] = { value: ed.value, base: null, at: now, ver: newCellVer(), ...(Object.prototype.hasOwnProperty.call(ed, 'by') ? { by: ed.by } : {}) }
      }
    }
    for (const it of incoming) before.set(it.f, e.edits[it.f])
    // 申し送り: 別のタブ（前の起動を含む）が入れた送信待ちの値を見ないまま打った入力は、同じ欄に重ねず分けて持つ
    // （2026-09-29 第3巡。後の入力が先の入力を黙って消さない＝分けた方は送ると競合になり〔くらべて選ぶ〕に出る）。
    // 見ていた値（画面が渡す基準＝送信待ちを重ねて出していた値）が、いまの送信待ちの値と同じなら続きの入力として重ねる
    const forks: { f: string; value: CellValue; base?: CellValue; seen?: Record<string, CellValue> }[] = []
    if (table === 'notes' && opts?.rebase !== true && !asNew) {
      for (const it of incoming) {
        const cur = e.edits[it.f]
        if (cur === undefined || it.base === undefined) continue
        const sameAsSeen = JSON.stringify(cur.value) === JSON.stringify(it.base)
        if (!sameAsSeen && verParts(cur.ver).tab !== tabId) forks.push(it)
      }
    }
    for (const it of incoming) {
      if (forks.includes(it)) continue
      const cur = e.edits[it.f]
      const ver = newCellVer()
      // 入力した職員を欄ごとに持つ（F07。送信待ちの間に別の職員が同じ行へ入力しても、職員ごとに分けて送る）
      const ed: CellEdit = { value: it.value, at: now, ver, by: editor }
      // 置き換わる版は済んだ印を付ける（他のタブ・旧形式の読み替えから古い値を復活させない）
      if (cur !== undefined) markDone(rowKey, it.f, cur)
      if (cur !== undefined && opts?.rebase !== true && !asNew) {
        // 値は後勝ち・基準は先勝ち（送信待ちの自分の値を基準にしない）。取り消しの見た行も基準と一緒に先勝ち（F09）
        if (Object.prototype.hasOwnProperty.call(cur, 'base')) {
          ed.base = cur.base
          if (cur.seen !== undefined) ed.seen = cur.seen
        } else if (it.seen !== undefined) ed.seen = it.seen
      } else if (it.base !== undefined) {
        ed.base = it.base
        if (it.seen !== undefined) ed.seen = it.seen
      }
      e.edits[it.f] = ed
      vers.set(it.f, ver)
    }
    for (const [k, v] of Object.entries(fill)) if (e.fill[k] === undefined || e.fill[k] === null) e.fill[k] = v
    if (table === 'notes' && opts?.meta !== undefined) {
      const meta = normalizeNoteMeta(opts.meta)
      if (meta !== null) e.meta = meta
    }
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
    if (Object.keys(e.edits).length > 0) cellRows.set(rowKey, e)
    if (forks.length > 0) {
      // 分けて持つ入力（行キー <元の行キー>!<印>）。送る先は同じ行、基準は見ていた値
      const forkId = newCellVer().replace('.', '-')
      const fkey: Record<string, string | number> = { ...key, fork: forkId }
      const fe: CellEntry = {
        table,
        key: fkey,
        edits: {},
        fill: {},
        editor,
        state: 'pending',
        tries: 0,
        nextAt: 0,
        tab: tabId,
        at: now,
        bound: true,
      }
      if (e.meta !== undefined) fe.meta = e.meta
      for (const it of forks) {
        const ed: CellEdit = { value: it.value, at: now, ver: newCellVer(), by: editor }
        if (it.base !== undefined) ed.base = it.base
        fe.edits[it.f] = ed
      }
      cellRows.set(cellRowKey(table, fkey), fe)
    }
    cellRecordSeq += 1
    mySeq = cellRecordSeq
    held = e.state === 'conflict'
    persistUnderLock()
  })
  armRetryTimer()
  let outcome: CellSaveInternal['outcome']
  if (opts?.stageOnly === true) {
    // 積むだけ（送るのは背景の送信に任せる）。端末に残せたかは呼び手が isQueuePersisted で確かめる
    void flushQueue()
    outcome = { kind: 'queued' }
  } else if (held) {
    // 競合で止まっている行へまとめた。〔くらべて選ぶ〕で選ぶまで送らない（送信キューの規約 I6 と同じ）
    outcome = { kind: 'result', held: true, result: heldResult(cellRows.get(rowKey)) }
  } else if (knownOffline()) {
    // つながっていないと分かっている間は試みない（待ち時間を延ばさない＝I7。電波が戻れば online で送る）
    outcome = { kind: 'queued' }
  } else {
    // 送信の終わりを待つ上限（F04）。前の送信の応答が返らない間も保存を「保存中」のまま止めない。過ぎたら送信待ちとして
    // 返す（送信の順番待ちそのものは切らない＝同じタブで2本同時に送らない。後から届いた結果は送信待ちの表示に反映される）
    let waited = true
    let timer: ReturnType<typeof setTimeout> | null = null
    await Promise.race([
      scheduleFlush(false, SEND_LOCK_WAIT_MS),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          waited = false
          resolve()
        }, SEND_LOCK_WAIT_MS + sendReqTimeoutMs + 1_000)
      }),
    ])
    if (timer !== null) clearTimeout(timer)
    outcome = waited ? await outcomeFor(table, key, rowKey, mySeq, [...vers.keys()]) : { kind: 'queued' }
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
  table: RowTable,
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
  table: RowTable,
  key: Record<string, string | number>,
): Promise<Record<string, unknown> | null | undefined> {
  try {
    const sb = await getClient()
    const res = await bounded(
      table === 'notes'
        ? sb.rpc('apply_note_edits', { p_id: key.id, p_edits: {} })
        : sb.rpc('apply_cell_edits', { p_table: table, p_key: key, p_edits: {} }),
    )
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
  if (o.kind === 'rejected') throw rejectError('保存でき', o.code)
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

// ── 発熱者・他症状者の測定1件の取り消し（RPC delete_vital・0020・2026-10-09 本人裁定） ──────────
//
// 送信待ち（cl_sendQueue2）には乗せない。電波が無い時は消さずに止める（安全側）。理由:
//   ・取り消しの前提は「行全体（8欄）を見たまま」で、送信待ちの欄ごとの {値, 基準} とは判定の単位が違う
//   ・乗せるには 0011 の作り直し・送信待ちの中核（申し送りの消失対策と共有）・〔くらべて選ぶ〕の欄単位の画面を
//     すべて変えることになる
// 判定（見た値のままなら取り消す・食い違えば取り消さない）は 0020 が行ロックの下で行う。

export const MSG_VITAL_DELETE_PENDING =
  'サーバー側の更新待ちのため、保存済みの測定はまだ削除できません。記録は消していません。管理者に連絡してください。'
export const MSG_VITAL_DELETE_OFFLINE =
  '削除できませんでした（通信エラー）。記録は消していません。電波状態を確認して、つながってからもう一度お試しください。'

/** 取り消しの結果。conflict の時の row は「いまの行」（missing＝行が見当たらない時は null） */
export type VitalDeleteResult =
  | { status: 'applied' | 'settled'; row: null }
  | { status: 'conflict'; reason: 'changed' | 'missing'; row: Vital | null }

/**
 * 発熱者・他症状者の測定1件を取り消す（soft delete）。seen＝取り消すと決めた時に画面に出ていたサーバーの生の値。
 * サーバーは、いまの8欄がそれと同じ時だけ取り消す（見ていない値を消さない）。
 * 通信できない・関数が無い・拒否された時は DbError（何も消えていない）
 */
export async function deleteVitalEntry(
  seen: Pick<Vital, 'id' | 'rev' | VitalCellField>,
  opts?: WriteOpts,
): Promise<VitalDeleteResult> {
  await assertWritable()
  const sb = await getClient()
  const id = seen.id
  const p_seen: Record<string, unknown> = {}
  for (const f of VITAL_CELL_FIELDS) p_seen[f] = seen[f] ?? null
  // 自分の取り消しは rev + 1 になる。印は取り消せた時だけ付け、応答を待つ間に届いたこの行の通知は預かる
  // （F10。応答より先に届く自分の通知を「他の端末の変更」と取り違えず、取り消せなかった時は他の端末の変更を捨てない）
  const end = beginRowWrite('vitals', id)
  let landed: number | undefined
  try {
    let res: Res<unknown>
    try {
      res = (await sb.rpc('delete_vital', { p_id: id, p_seen, p_editor: idNum(opts?.editedBy) ?? editorId })) as Res<unknown>
    } catch {
      throw new DbError('network', MSG_VITAL_DELETE_OFFLINE)
    }
    if (res.error !== null) {
      if (isMissingRpc(res)) throw new DbError('server', MSG_VITAL_DELETE_PENDING)
      if (isAuthFail(res)) {
        fireAuthExpired()
        throw new DbError('auth', MSG.authWrite)
      }
      if (isTransient(res)) throw new DbError('network', MSG_VITAL_DELETE_OFFLINE)
      throw rejectError('操作でき', errCode(res), res.status)
    }
    const r = asRecord(res.data)
    const status = r?.status
    if (status === 'applied') landed = seen.rev + 1
    if (status === 'applied' || status === 'settled') return { status, row: null }
    if (status === 'conflict') {
      const reason = r?.reason === 'missing' ? 'missing' : 'changed'
      const row = r?.row == null ? null : normalizeVital(r.row)
      return { status: 'conflict', reason, row }
    }
    // 応答の形が違う＝同じ名前の別の関数（版が合わない）。消えたかどうか分からないので読み直しを促す
    throw new DbError('server', MSG.broken)
  } finally {
    end(landed)
  }
}

/** 送信待ち・止まっている1行（画面の重ね表示と〔くらべて選ぶ〕の「あなたの入力」に使う） */
export interface PendingCellRow {
  table: CellTable | 'notes'
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
  /**
   * 欄ごとの入力した職員（F41 手直し）。欄の入力者（F07 の by）が無い欄（旧版の控え）は行の操作者。null＝分からない
   * （操作者が未選択・旧形式の読み替え）。共用の端末で「誰が打った変更か」を、取り下げの確認・一覧に出すのに使う
   */
  bys?: Record<string, number | null>
}

function pendingViewOf(e: CellEntry): PendingCellRow {
  const values: Record<string, unknown> = {}
  const bases: Record<string, unknown> = {}
  const vers: Record<string, string> = {}
  const bys: Record<string, number | null> = {}
  for (const [f, ed] of Object.entries(e.edits)) {
    values[f] = ed.value
    vers[f] = ed.ver
    if (Object.prototype.hasOwnProperty.call(ed, 'base')) bases[f] = ed.base
    bys[f] = ed.by !== undefined ? ed.by : (e.editor ?? null)
  }
  return { table: e.table, key: { ...e.key }, values, bases, state: e.state, conflicts: [...(e.conflicts ?? [])], vers, bys }
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

// ── 申し送りの変更・取り消し（送信待ち pending store → RPC apply_note_edits・0017） ──────────────
//
// 2026-09-29（本人承認）: 既にある申し送りの変更（本文・対象・記入者・色・重要度・職種タグ・区切り・継続の終了）と
// 取り消しは、バイタル・食事と同じ送信待ち（cl_sendQueue2 の rows、行キー notes#<id>）へ書いてから
// apply_note_edits で送る。判定（いまの値＝あなたの値なら済み／基準のままなら書く／それ以外は競合）はサーバーが
// 行ロックの下で行う。競合した本文は送信待ちに「競合」として残り（再読み込み・画面移動・アプリ終了でも消えない）、
// 〔くらべて選ぶ〕で選ぶまで送らない。rev 照合の旧経路（updateRow）へは落とさない。
// 新規登録（insert・client_key）は従来の経路のまま（insertNote）。

/**
 * 申し送り1件の欄を保存する（経路は1本: 送信待ちへ書く → すぐ送る → その行の結果を待つ）。
 * ・sendEdits の base は「その欄を直し始めた時に画面に出ていたサーバーの生の値」（送信待ちの重ね表示の値ではない）
 * ・通信できない時は 'queued'。止まっている行（conflict）へは rebase しない限りまとめるだけ（held: true）
 * ・サーバーに拒否された時は DbError（送信待ちには rejected として残る）
 * ・opts.meta（日・区分・対象）は「送れていない申し送り」の一覧と〔新しい行として登録〕に使う控え
 */
export async function saveNoteEdits(
  target: NoteTarget,
  sendEdits: CellEditInput<NoteEditField>,
  opts?: CellSaveOpts,
): Promise<CellSaveResult<Note> | Queued> {
  // 継続の終了を、画面がもう終了済みと見ている申し送りに重ねて押した（F08。同じ日のピン留めには終了済みの継続も残り、
  // 〔継続を終了〕を押せる）: 最初の終了を正として送らない。送ると終了時刻だけが書き換わり、終了した職員は先の人の
  // まま（誰も操作していない組）になる
  if (opts?.rebase !== true && isRepeatedEnd(sendEdits)) return { status: 'noop', row: null, applied: [], settled: ['ended_at', 'ended_by'], conflicts: [] }
  return publicOutcome(await saveCellEditsInternal('notes', target, sendEdits, opts), normalizeNote)
}

/**
 * 終了の操作（〔継続を終了〕＝ended_by を基準なし・基準 null で送る）で、基準の終了時刻が押した時刻以前＝もう終了している
 * 申し送りへの重ね押しか（F08）。〔くらべて選ぶ〕の〔自分の内容で直す〕は rebase で送り、ended_by の基準に先の終了者が
 * 入るので当たらない（人の選択は止めない）
 */
function isRepeatedEnd(edits: CellEditInput<NoteEditField>): boolean {
  if (edits.ended_by === undefined || edits.ended_at === undefined) return false
  // 人が選んだ値（基準に先の終了者）は止めない（F08 手直し。基準 null＝終了していない行を見て押した〔継続を終了〕）
  if (chosenEnd(edits.ended_by)) return false
  const base = edits.ended_at.base
  const value = edits.ended_at.value
  if (typeof base !== 'string' || typeof value !== 'string') return false
  const b = Date.parse(base)
  const v = Date.parse(value)
  return Number.isFinite(b) && Number.isFinite(v) && b <= v
}

/**
 * 申し送り1件を取り消す（soft delete）。seen＝取り消すと決めた時に画面に出ていたサーバーの行（生の値）。
 * 文字を渡した時は本文だけ（従来の呼び方）。行を渡すと、本文に加えて対象・重要度・色・継続・終了などの欄も送り（F09・0027）、
 * サーバーは見た本文のまま・見た欄のままの時だけ取り消す（他の端末が重要度を上げた・対象を付け替えた後の古い表示から
 * 消さない）。食い違えば競合として送信待ちに残る（競合の fields に食い違った欄）。0017 のサーバーは本文だけで判定する。
 * 書けた（applied）・既に取り消されていた（settled）時は row が null
 */
export async function deleteNote(
  target: NoteTarget,
  seen: string | NoteSeenRow,
  opts?: CellSaveOpts,
): Promise<CellSaveResult<Note> | Queued> {
  const seenBody = typeof seen === 'string' ? seen : seen.body
  const seenRow = typeof seen === 'string' ? undefined : noteSeenInput(seen)
  const edits: CellEditInput<string> = {
    deleted_at: { value: new Date().toISOString(), base: seenBody, ...(seenRow !== undefined ? { seen: seenRow } : {}) },
  }
  return publicOutcome(await saveCellEditsInternal('notes', target, edits, opts), normalizeNote)
}

/**
 * 取り消しの「見た行」（F09）。画面に出ていた行（Note や RPC の行）をそのまま渡してよい。照らすのは画面で見分けられる欄
 * （本文・対象・重要度・色・継続・終了時刻＝NOTE_SEEN_SENT）で、行に無い欄（undefined）は照らさない
 */
export type NoteSeenRow = { body: string } & { [K in (typeof NOTE_SEEN_FIELD_LIST)[number]]?: unknown }

function noteSeenInput(row: NoteSeenRow): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  for (const f of NOTE_SEEN_SENT) {
    const v = (row as Record<string, unknown>)[f]
    if (v !== undefined) out[f] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 取り消しが済んだ（書けた・既に取り消されていた）か */
export function noteDeleted(r: CellSaveResult<Note>): boolean {
  return r.applied.includes('deleted_at') || r.settled.includes('deleted_at')
}

/** 送信待ち・止まっている申し送り1件（画面の重ね表示・〔くらべて選ぶ〕の「あなたの入力」） */
export interface PendingNoteRow extends PendingCellRow {
  /** 行 id（送信待ちの登録への変更＝ck の時は 0） */
  id: number
  /** 送信待ちの登録への変更（notes#ck:<client_key>）の冪等キー */
  ck?: string
  /** 別のタブの入力と分けて持つ入力の印（notes#…!<fork>） */
  fork?: string
  /** この送信待ちを指す（saveNoteEdits・discardPendingNote にそのまま渡す） */
  target: NoteTarget
  /** どの日・区分・対象の行か（旧形式から読み替えた行には無い） */
  meta: NoteMeta | null
}

function pendingNoteViewOf(e: CellEntry): PendingNoteRow | null {
  if (e.table !== 'notes') return null
  const fork = e.key.fork === undefined ? undefined : String(e.key.fork)
  const id = idNum(e.key.id)
  if (id !== null) {
    const target: NoteTarget = fork === undefined ? { id } : { id, fork }
    return { ...pendingViewOf(e), id, target, meta: e.meta ?? null, ...(fork !== undefined ? { fork } : {}) }
  }
  const ck = str(e.key.client_key)
  if (ck === null) return null
  const target: NoteTarget = fork === undefined ? { clientKey: ck } : { clientKey: ck, fork }
  return { ...pendingViewOf(e), id: 0, ck, target, meta: e.meta ?? null, ...(fork !== undefined ? { fork } : {}) }
}

function noteTargetOf(t: number | NoteTarget): NoteTarget {
  return typeof t === 'number' ? { id: t } : t
}

/** その申し送り（行 id・送信待ちの登録の冪等キー）の送信待ち（このタブ＋同じ端末の他のタブの控え）。無ければ null */
export function pendingNoteRow(target: number | NoteTarget): PendingNoteRow | null {
  const key = keyOfTarget('notes', noteTargetOf(target))
  if (key === null) return null
  const e = currentCellRows().get(cellRowKey('notes', key))
  return e === undefined ? null : pendingNoteViewOf(e)
}

/** 送信待ち・止まっている申し送りの全件（行 id → 送信待ち。画面に重ねる本体だけ＝分けて持つ入力・登録への変更は除く） */
export function pendingNoteRows(): Map<number, PendingNoteRow> {
  const out = new Map<number, PendingNoteRow>()
  for (const e of currentCellRows().values()) {
    const v = e.table === 'notes' ? pendingNoteViewOf(e) : null
    if (v !== null && v.ck === undefined && v.fork === undefined) out.set(v.id, v)
  }
  return out
}

/** 送信待ちの登録への変更（冪等キー → 送信待ち。送信待ちの登録の行に重ねて出す本体だけ） */
export function pendingNoteCkRows(): Map<string, PendingNoteRow> {
  const out = new Map<string, PendingNoteRow>()
  for (const e of currentCellRows().values()) {
    const v = e.table === 'notes' ? pendingNoteViewOf(e) : null
    if (v !== null && v.ck !== undefined && v.fork === undefined) out.set(v.ck, v)
  }
  return out
}

/**
 * 申し送りの送信待ちを取り下げる（〔先の本文を残す〕〔取り下げる〕など、利用者の明示的な取り下げだけで使う）。
 * vers（pendingNoteRow の vers＝画面が見た版）を渡すと、その版のままの欄だけを外す（見た後に打ち直した値は外さない）
 */
export async function discardPendingNote(
  target: number | NoteTarget,
  fields?: readonly string[],
  vers?: Record<string, string>,
): Promise<void> {
  const key = keyOfTarget('notes', noteTargetOf(target))
  if (key === null) return
  const onlyVers = vers === undefined ? undefined : new Map(Object.entries(vers))
  await withWriteLock(() => {
    refreshCells()
    dropCellFields(cellRowKey('notes', key), fields, onlyVers)
    persistUnderLock()
  })
  armRetryTimer()
}

/**
 * 申し送り1件の欄を送信待ちに積むだけ（送信は背景に任せ、結果を待たない・2026-09-29 第3巡）。
 * 端末に残せた（読み直して確かめた）時 true。書きかけ・画面の控えを外すのは、true を受けてから（外す→積むの順を作らない）
 */
export async function stageNoteEdits(
  target: NoteTarget,
  sendEdits: CellEditInput<NoteEditField>,
  opts?: CellSaveOpts,
): Promise<boolean> {
  await saveCellEditsInternal('notes', target, sendEdits, { ...opts, stageOnly: true })
  return queuePersisted
}

/** 登録を待っている申し送り（cl_sendQueue の notes の insert） */
export interface QueuedNoteInsert {
  qid: string
  /** pending＝送信待ち（電波が戻れば送る）／rejected＝サーバーに受け付けられず自動の再送を止めた／conflict＝止まった */
  state: 'pending' | 'conflict' | 'rejected'
  note_on: string | null
  shift: Shift | null
  resident_id: number | null
  body: string
  reporter_id: number | null
  after16: boolean
  /** 色（登録で送った値に、登録後の変更を重ねた値） */
  color: NoteColor | null
  /** 登録後の変更（notes#ck:<qid>）。body などは、この値を重ねて出している */
  changes: PendingNoteRow | null
}

/** 送れていない申し送りの一覧の1件 */
export type UnsentNote =
  | { kind: 'edit'; row: PendingNoteRow }
  | { kind: 'insert'; op: QueuedNoteInsert }
  /**
   * 旧ビルドへ戻した間に畳まれた申し送りの入力のうち、同じ申し送りへの別の入力と食い違うため送信待ちへ戻さなかったもの
   * （両方の本文を残す。〔新しい行として登録〕か〔取り下げ〕を選ぶ）。raw＝保存先の原文の1行
   */
  | { kind: 'rescued'; row: PendingNoteRow; raw: string }

/**
 * 送れていない申し送りの一覧（H1・L2）。送信待ち・止まった変更（cl_sendQueue2 の notes#<id>。旧ビルドが
 * cl_sendQueue に積んだ変更は起動時に読み替え済み）と、登録を待っている・拒否で止まった新規登録（cl_sendQueue の
 * notes の insert。同じ端末の他のタブが積んだ分も含む）。読むだけ（保存先は書き換えない）
 */
export function listUnsentNotes(): UnsentNote[] {
  const out: UnsentNote[] = []
  const seen = new Set<string>()
  // 他のタブが取り下げた・送り終えた登録（墓標）は出さない（F05）
  const opDone = opDoneIndex(readStoresQuiet().s2?.done)
  const ops = [...queue.filter((o) => !isOpDone(o, opDone)), ...storedOps()]
  const ckRows = pendingNoteCkRows()
  const insertCks = new Set<string>()
  for (const op of ops) {
    if (op.table !== 'notes' || op.kind !== 'insert' || seen.has(op.qid) || sentQids.has(op.qid)) continue
    seen.add(op.qid)
    insertCks.add(op.qid)
    // 登録の中身に、登録後の変更（notes#ck:<qid>）を重ねて出す（登録の op そのものは書き換えない）
    const changes = ckRows.get(op.qid) ?? null
    const p = { ...op.payload, ...(changes?.values ?? {}) }
    out.push({
      kind: 'insert',
      op: {
        qid: op.qid,
        state: op.blocked ?? 'pending',
        note_on: dateStr(p.note_on),
        shift: oneOf(p.shift, SHIFTS),
        resident_id: idNum(p.resident_id),
        body: str(p.body) ?? '',
        reporter_id: idNum(p.reporter_id),
        after16: bool(p.after16, false),
        color: oneOf(p.color, NOTE_COLORS),
        changes,
      },
    })
  }
  for (const e of currentCellRows().values()) {
    const row = e.table === 'notes' ? pendingNoteViewOf(e) : null
    if (row === null) continue
    // 登録がまだ送信待ちにある変更は、上の登録の行に重ねて出した（別の行にしない）
    if (row.ck !== undefined && row.fork === undefined && insertCks.has(row.ck)) continue
    out.push({ kind: 'edit', row })
  }
  const { s2 } = readStoresQuiet()
  for (const c of s2?.collided ?? []) {
    if (droppedBroken.has(c.raw)) continue
    const row = pendingNoteViewOf(c.entry)
    if (row !== null) out.push({ kind: 'rescued', row, raw: c.raw })
  }
  return out
}

/**
 * 旧ビルドへ戻した間に畳まれて、食い違いのため戻さなかった申し送りの入力（kind='rescued'）を保存先から外す。
 * 〔新しい行として登録〕で登録できた後、または利用者が「あなたの本文は保存されません」を確かめて取り下げた後にだけ呼ぶ
 */
export async function dropRescuedNote(raw: string): Promise<void> {
  droppedBroken.add(raw)
  await withWriteLock(() => {
    if (cellBrokenRaw !== null) {
      const rest = cellBrokenRaw.split('\n').filter((l) => l !== '' && l !== raw)
      cellBrokenRaw = rest.length === 0 ? null : rest.join('\n')
    }
    persistUnderLock()
  })
}

/**
 * 冪等キーで登録した申し送り（届いていれば行・無ければ null・読めなければ undefined＝届いたか分からない。L2）。
 * 取り消された行も「届いた」証拠として探す（取り消されていれば、登録後の変更は送信待ちで「行が無い」になり一覧に出る）
 */
export async function findNoteByClientKey(clientKey: string): Promise<Note | null | undefined> {
  try {
    const sb = await getClient()
    const found = await findByKeyResult(sb, 'notes', { client_key: clientKey }, NOTE_COLS)
    if (found === 'error') return undefined
    if (found === 'none') return null
    return normalizeNote(found.row) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 登録を待っている申し送り（新規登録の退避 op）を取り下げる。利用者が「あなたの本文は保存されません」を確かめた
 * 後にだけ呼ぶ。このタブの退避から外し、保存先に残っている他のタブの控えからも復活させない。
 * shownVers＝一覧で見せた登録後の変更（notes#ck:<qid>）の版（QueuedNoteInsert.changes.vers）。見せた版の欄だけを外す
 * （見せた後に積まれた変更と、分けて持つ入力 !<印> は外さない＝送り先の無い変更として「止まっている」件に出る。第4巡 R4-2）
 */
export async function discardQueuedNoteInsert(qid: string, shownVers?: Record<string, string>): Promise<void> {
  // 墓標を残す（F05。同じ端末の他のタブがメモリに持っている同じ op も、次の書き戻し・送信の前に外す）
  await discardOpInternal(qid)
  if (shownVers !== undefined && Object.keys(shownVers).length > 0) await discardPendingNote({ clientKey: qid }, undefined, shownVers)
  armRetryTimer()
}

/**
 * 退避 op を取り下げる（墓標を付けて、このタブ・同じ端末の他のタブ・次の起動から外す。F05）。
 * 他のタブがいま送っている最中なら、その送信が終わるまで待ってから取り下げる（送信ロック。待ちきれなければそのまま
 * 取り下げる）。送り終えていた時は 'sent'（取り下げられない＝既に登録された）、見当たらない時は 'missing'
 */
async function discardOpInternal(qid: string): Promise<'dropped' | 'sent' | 'missing'> {
  let out: 'dropped' | 'sent' | 'missing' = 'missing'
  const run = async (): Promise<void> => {
    out = await withWriteLock(() => {
      const s2done = readStoresQuiet().s2?.done
      const opDone = opDoneIndex(s2done)
      const op = queue.find((o) => o.qid === qid && !isOpDone(o, opDone)) ?? storedOps().find((o) => o.qid === qid)
      let r: 'dropped' | 'sent' | 'missing' = 'missing'
      if (op !== undefined) {
        markOpDone(op, 'drop')
        sentQids.add(qid)
        queue = queue.filter((o) => o.qid !== qid)
        r = 'dropped'
      } else if (opSentMarked(qid, s2done)) r = 'sent'
      persistUnderLock()
      return r
    })
  }
  const got = await withSendLock(run, SEND_LOCK_WAIT_MS).catch(() => false)
  if (!got) await run()
  return out
}

/** 止まっている（自動では送らない）退避 op の1件（F02・F31・F71。申し送りの登録は listUnsentNotes が出す） */
export interface StoppedOp {
  qid: string
  /** 表（fluid_intake・outings・bath_records・med_slots・med_admin・incidents・notes・note_reads・attendance・residents） */
  table: string
  kind: 'insert' | 'update' | 'read' | 'attendance' | 'alias'
  /** conflict＝他の端末が先に変えた（いまの値とくらべて選ぶ）／rejected＝サーバーに受け付けられなかった */
  state: 'conflict' | 'rejected'
  /** update の行 id（無ければ null） */
  rowId: number | null
  /** update が見ていた版（無ければ null） */
  rev: number | null
  /** 送ろうとした中身の写し（表示名の op は note_alias と基準 base） */
  payload: Record<string, unknown>
  /** 最後に受け付けられなかった時のエラーコード（分からなければ null） */
  errCode: string | null
  /** 退避した時刻 */
  at: number
}

/**
 * 止まっている退避 op の一覧（このタブ＋同じ端末の他のタブの控え。読むだけ）。設定画面の「送れていない記録」に出し、
 * 〔もう一度送る〕（resendQueuedOp）〔取り下げ〕（discardQueuedOp）を選ばせる。申し送りの登録は listUnsentNotes に出るので除く
 */
export function listStoppedOps(): StoppedOp[] {
  const out: StoppedOp[] = []
  const seen = new Set<string>()
  const opDone = opDoneIndex(readStoresQuiet().s2?.done)
  for (const op of [...queue.filter((o) => !isOpDone(o, opDone)), ...storedOps()]) {
    if (op.blocked === undefined || seen.has(op.qid)) continue
    seen.add(op.qid)
    if (op.table === 'notes' && op.kind === 'insert') continue
    out.push({
      qid: op.qid,
      table: op.table,
      kind: op.kind,
      state: op.blocked,
      rowId: 'rowId' in op ? (op.rowId ?? null) : null,
      rev: 'rev' in op ? (op.rev ?? null) : null,
      payload: { ...op.payload },
      errCode: op.errCode ?? null,
      at: op.at,
    })
  }
  return out
}

/**
 * 止まっている退避 op を取り下げる（利用者が中身を確かめた後にだけ呼ぶ）。'dropped'＝取り下げた／'sent'＝既に送り終えて
 * いた（取り下げられない）／'missing'＝見当たらない（他のタブが処理した）
 */
export async function discardQueuedOp(qid: string): Promise<'dropped' | 'sent' | 'missing'> {
  const r = await discardOpInternal(qid)
  armRetryTimer()
  return r
}

/**
 * 止まっている退避 op の送り先の、いまの行（くらべて選ぶ時に並べる）。update は行（取り消された行も deleted_at 付きで）、
 * 表示名は { id, note_alias }、それ以外は null。読めなければ undefined
 */
export async function fetchQueuedOpTarget(qid: string): Promise<Record<string, unknown> | null | undefined> {
  const op = queue.find((o) => o.qid === qid) ?? storedOps().find((o) => o.qid === qid)
  if (op === undefined) return null
  try {
    const sb = await getClient()
    if (op.kind === 'insert') {
      // 入浴・与薬の時間帯の記録・服薬の時間帯の追加が自然キーで止まった（F37）: 先に記録された相手の行（生きている行）。
      // 〔自分の内容で直す〕は、この行の id と版を resendQueuedOp の seen に渡す。相手の行が無い（取り消された）なら null
      const key = naturalKeyOf(op.table, op.payload)
      if (key === null) return null
      let q = sb.from(op.table).select(colsOf(op.table)).is('deleted_at', null).limit(1)
      for (const [k, v] of Object.entries(key)) q = q.eq(k, v as never)
      const res = await bounded(q.maybeSingle())
      if (res.error !== null) return undefined
      if (res.data === null && (await sessionMissing(sb))) return undefined
      return asRecord(res.data)
    }
    if (op.kind === 'update' && op.rowId !== undefined) {
      const res = await bounded(sb.from(op.table).select(`${colsOf(op.table)},deleted_at`).eq('id', op.rowId).limit(1).maybeSingle())
      return res.error !== null ? undefined : asRecord(res.data)
    }
    if (op.kind === 'alias') {
      const id = idNum(op.payload.id)
      if (id === null) return null
      const res = await bounded(sb.from('residents').select('id,note_alias').eq('id', id).limit(1).maybeSingle())
      return res.error !== null ? undefined : asRecord(res.data)
    }
    return null
  } catch {
    return undefined
  }
}

/**
 * 止まっている退避 op を、利用者の選択でもう一度送る（1回だけ。また拒否・競合になれば止まる）。
 * 他の端末が先に変えていた update（conflict）は、いまの行を見せてから選ばせること: seen.rev＝見せた行の版を渡すと、
 * その版の上にこの端末の中身を書く（見せていない変更を黙って上書きしない＝渡さなければ送らずに 'conflict'）。
 * 表示名（alias）の conflict は seen.alias＝見せたいまの表示名を渡すと、それを基準にして送る（重複の確認はやり直す）。
 * 戻り値: 'sent'＝届いた／'queued'＝まだ届いていない（送信待ちに残る）／'conflict'・'rejected'＝また止まった／'missing'＝見当たらない
 */
export async function resendQueuedOp(
  qid: string,
  seen?: { rev?: number; alias?: string | null; id?: number },
): Promise<'sent' | 'queued' | 'conflict' | 'rejected' | 'missing'> {
  let op = queue.find((o) => o.qid === qid)
  if (op === undefined) {
    const other = storedOps().find((o) => o.qid === qid)
    if (other === undefined) return 'missing'
    op = { ...other }
    queue.push(op)
  }
  if (op.table !== 'note_reads' && op.table !== 'attendance' && op.table !== 'residents') await writeGate(op.table)
  if (op.blocked === 'conflict') {
    if (op.kind === 'insert' && seen !== undefined && (seen.id !== undefined || seen.rev !== undefined)) {
      // 〔自分の内容で直す〕（F37）: 自然キーで先に記録された相手の行（見せた行の id と版）を、この端末の中身で直す。
      // 見せた版の上にだけ書く（その後に変わっていれば、また競合で止まる＝見せていない変更を黙って上書きしない）
      const id = idNum(seen.id)
      const rev = num(seen.rev)
      const patch = insertAsUpdatePatch(op.table, op.payload)
      if (id === null || rev === null || patch === null) return 'conflict'
      const converted = op as RowQueueOp
      converted.kind = 'update'
      converted.rowId = id
      converted.rev = rev
      converted.payload = patch
    } else if (op.kind === 'update') {
      const rev = num(seen?.rev)
      if (rev === null) return 'conflict'
      op.rev = rev
    } else if (op.kind === 'alias') {
      if (seen === undefined || !Object.prototype.hasOwnProperty.call(seen, 'alias')) return 'conflict'
      const a = seen.alias
      op.payload = { ...op.payload, base: typeof a === 'string' && a.trim() !== '' ? a.trim() : null }
    }
  }
  delete op.blocked
  delete op.netFail
  // 利用者の指示で送るのは1回だけ（また受け付けられなければ、すぐに止まる）
  op.rejects = MAX_TRIES - 1
  op.tries = 0
  op.nextAt = 0
  await persistQueueLocked()
  await flushQueue(true)
  const after = queue.find((o) => o.qid === qid)
  if (after === undefined) return 'sent'
  return after.blocked ?? 'queued'
}

/**
 * 自然キーで止まった追加（入浴・与薬・服薬の時間帯）の中身を、相手の行を直す update の中身にする（F37）。
 * 自然キーの列・冪等キーは送らない（行は同じ）。入浴・与薬は自動の記録の印を外す（人の記録にする）。
 * 変更の記録の「変えた職員」は積んだ時の操作者（無ければ記録者）。自然キーを持たない表は null
 */
function insertAsUpdatePatch(table: string, payload: Record<string, unknown>): Record<string, unknown> | null {
  if (table !== 'bath_records' && table !== 'med_admin' && table !== 'med_slots') return null
  const out = omitKeys(payload, ['client_key', 'resident_id', 'bath_on', 'admin_on', 'slot', 'id', 'rev', 'deleted_at'])
  if (table !== 'med_slots') out.auto = false
  out.edited_by = idNum(payload.edited_by) ?? idNum(payload.recorded_by) ?? null
  return out
}

/**
 * ログインし直した時（SIGNED_IN）、拒否で止まった退避 op を1回だけ送る状態へ戻す（F37）。
 * 権限が直った後の再ログインで届くようにする。1つの op につき1回まで（authRetried）＝恒久的な拒否で送り直しを繰り返さない
 */
async function retryRejectedOnce(): Promise<void> {
  let changed = false
  for (const op of queue) {
    if (op.blocked !== 'rejected' || op.authRetried === true) continue
    delete op.blocked
    op.rejects = MAX_TRIES - 1 // もう一度拒否されたら、すぐに止まる
    op.nextAt = 0
    op.authRetried = true
    changed = true
  }
  if (changed) await persistQueueLocked()
}

/**
 * 登録後の変更のうち分けて持つ入力（notes#ck:<from>!<印>）を、別の登録（冪等キー to）への変更へ移す（第4巡 R4-2）。
 * 登録を新しい行として出し直した時に使う。送る先は新しい行（届けば notes#<id>!<印>）、基準はその人が見ていた値のまま
 * （新しい行の本文と食い違えば〔くらべて選ぶ〕に出る＝消さない）
 */
async function moveNoteCkForks(from: string, to: string): Promise<void> {
  await withWriteLock(() => {
    refreshCells()
    const now = Date.now()
    for (const [rowKey, e] of [...cellRows.entries()]) {
      if (e.table !== 'notes' || e.key.client_key !== from || e.key.fork === undefined) continue
      const key: Record<string, string | number> = { client_key: to, fork: e.key.fork }
      const nextKey = cellRowKey('notes', key)
      if (cellRows.has(nextKey)) continue
      const edits: Record<string, CellEdit> = {}
      for (const [f, ed] of Object.entries(e.edits)) {
        markDone(rowKey, f, ed) // 他のタブの古い控えから元の行キーで復活させない
        edits[f] = { ...ed, ver: newCellVer() }
      }
      const moved: CellEntry = { ...e, key, edits, state: 'pending', tries: 0, nextAt: 0, at: now, tab: tabId }
      delete moved.conflicts
      cellRows.delete(rowKey)
      cellRows.set(nextKey, moved)
    }
    persistUnderLock()
  })
}

/**
 * 登録できなかった（拒否で止まった）申し送りを、登録の中身＋登録後の変更を合わせた本文で新しい行として登録する
 * （2026-09-29 第3巡）。冪等キーは元の登録から決める（押し直しても1行）。登録できた・送信待ちに残せた後で、
 * 分けて持つ入力（別のタブの入力）を新しい行への変更へ移し、元の登録と、合わせた版の変更を取り下げる
 * （残せなければ取り下げない。合わせた後に積まれた変更は外さない＝送り先の無い変更として一覧に出る。第4巡 R4-2）
 */
export async function registerQueuedInsertAsNew(qid: string): Promise<Note | Queued> {
  const op = noteInsertQueued(qid)
  if (op === null) throw new DbError('server', MSG.broken)
  const changes = pendingNoteRow({ clientKey: qid })
  const newKey = `nr-${qid}`
  const payload: Record<string, unknown> = { ...op.payload, ...(changes?.values ?? {}), client_key: newKey }
  delete payload.deleted_at
  if (str(payload.body)?.trim() === '' || str(payload.body) === null) throw new DbError('server', MSG.emptyBody)
  const res = await insertRow('notes', payload, normalizeNote)
  if (res === 'queued' && !isQueuePersisted()) return res
  await moveNoteCkForks(qid, newKey)
  await discardQueuedNoteInsert(qid, changes?.vers ?? {})
  return res
}

/**
 * 登録を待っている申し送りを、いま送り直す（〔新しい行として登録〕）。止まっていた op（拒否）も送る状態へ戻す。
 * 同じ冪等キー（client_key）で送るので、既に届いていれば二重登録にならない。
 * 返り値: 'sent'＝届いた／'queued'＝まだ届いていない（送信待ちに残る）
 */
export async function resendQueuedNoteInsert(qid: string): Promise<'sent' | 'queued'> {
  await assertWritable()
  let op = queue.find((o) => o.qid === qid)
  if (op === undefined) {
    // 同じ端末の他のタブが積んだ分: このタブの退避へ引き取って送る（同じ冪等キーなので二重に送っても1行）
    const other = storedOps().find((o) => o.qid === qid)
    if (other === undefined) return 'sent'
    op = { ...other }
    queue.push(op)
  }
  delete op.blocked
  op.tries = 0
  op.nextAt = 0
  await persistQueueLocked()
  await flushQueue(true)
  return queue.some((o) => o.qid === qid) ? 'queued' : 'sent'
}

/**
 * 〔新しい行として残す〕〔新しい行として保存〕: 同じ日・同じ区分・同じ対象に、あなたの本文を新しい行として登録する。
 * key は冪等キー（その競合1件ごとに固定＝押し直しても1行に収まる）。記入者は reporterId（この端末の操作者）
 */
export async function insertNoteAsNew(p: {
  key: string
  meta: NoteMeta
  body: string
  reporterId: number | null
}): Promise<Note | Queued> {
  if (p.body.trim() === '') throw new DbError('server', MSG.emptyBody)
  const payload: Record<string, unknown> = {
    note_on: p.meta.note_on,
    shift: p.meta.shift,
    facility: null,
    category: null,
    resident_id: p.meta.resident_id,
    role_tags: [],
    importance: 'normal',
    body: p.body.trim(),
    occurred_at: null,
    ongoing: false,
    ended_at: null,
    reporter_id: p.reporterId,
    color: null,
    after16: p.meta.after16,
    client_key: p.key,
  }
  return insertRow('notes', payload, normalizeNote)
}

/**
 * 送信待ちの1件の、冪等キー（〔新しい行として…〕用）。行 id と、その時の本文の版から決める
 * （同じ競合で押し直しても同じキー＝二重登録にならない。本文を打ち直せば別のキー）
 */
export function noteAsNewKey(id: number, ver: string): string {
  return `nn${id}-${valueTag(ver)}`
}

/**
 * 申し送り1件の日・区分・対象（〔新しい行として…〕の行き先）。送信待ちの控え → いまの行 → 変更の記録（取り消された
 * 行の元の値）の順に探す。どれでも分からなければ null（その時は登録できない理由を出す）
 */
export async function resolveNoteMeta(id: number): Promise<NoteMeta | null> {
  const p = pendingNoteRow(id)
  if (p?.meta) return p.meta
  const latest = await fetchLatestNote(id).catch(() => null)
  if (latest !== null) {
    const n = latest.row
    return { note_on: n.note_on, shift: n.shift, resident_id: n.resident_id, after16: n.after16 }
  }
  const hist = await fetchNoteHistory(id).catch(() => null)
  if (hist?.available) {
    for (const e of hist.entries) {
      const m = normalizeNoteMeta(e.old_row)
      if (m !== null) return m
    }
  }
  return null
}

/** 申し送り1件の最新（〔くらべて選ぶ〕の「先の本文・記入者・時刻」）。取り消されている・無い時は null */
export async function fetchLatestNote(id: number): Promise<LatestRow<Note> | null> {
  return fetchLatestRow('notes', { id }, normalizeNote)
}

/** 申し送りを行 id でまとめて読み直す（送信待ちが送れた後に画面のその行を最新にする＝H2）。取り消された行は返らない */
export async function fetchNoteRows(ids: readonly number[]): Promise<Note[]> {
  const want = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))].slice(0, READ_LOOKUP_ROWS)
  if (want.length === 0) return []
  const sb = await getClient()
  const res = (await sb
    .from('notes')
    .select(NOTE_COLS)
    .in('id', want)
    .is('deleted_at', null)
    .limit(want.length)) as Res<unknown>
  if (res.error !== null) throw readError(res)
  return list(res.data, normalizeNote, want.length)
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

/** 登録で送った欄のうち、登録の後に書きかけで直せる欄の値（「その冪等キーで最初に送った中身」を画面の控えに持つ形・R6-3） */
export type NoteFirstSent = Partial<Record<'body' | 'resident_id' | 'reporter_id' | 'color', unknown>>

/**
 * 申し送りの新規登録。opts.clientKey を渡すと、その冪等キーで送る（画面が同じ行の登録を後から直す＝
 * 登録後の変更 notes#ck:<client_key> を届いた行へ結び付けるため。省くと新しいキー）。
 * opts.firstSent＝その冪等キーで最初に送った中身（戻した書きかけを確定し直す時に画面が渡す。null＝分からない）。
 * 同じ冪等キーの登録は Web Lock で1本ずつ（別のタブで同時に確定しても、送信待ちを確かめる→送る→積むが重ならない・R6-1）
 */
export async function insertNote(
  n: Omit<Note, 'id' | 'rev' | 'read_count' | 'my_read'>,
  opts?: { clientKey?: string; firstSent?: NoteFirstSent | null },
): Promise<Note | Queued> {
  if (n.body.trim() === '') throw new DbError('server', MSG.emptyBody)
  const given = opts?.clientKey
  const payload =
    typeof given === 'string' && given !== ''
      ? { ...cleanPayload(n as unknown as Record<string, unknown>), client_key: given }
      : withClientKey(n as unknown as Record<string, unknown>)
  const ckRaw = str(payload.client_key)
  if (ckRaw === null || ckRaw === '') return insertRow('notes', payload, normalizeNote)
  const ck = ckRaw
  const run = (): Promise<Note | Queued> => insertNoteUnderKey(payload, ck, opts?.firstSent)
  const locks = webLocks()
  if (locks === null) return run()
  return (await locks.request(`${NOTE_REG_LOCK}:${ck}`, run)) as Note | Queued
}

/** 同じ冪等キーの申し送りの登録を1本ずつにする Web Lock の名前（後ろに冪等キーを付ける） */
const NOTE_REG_LOCK = 'cl_noteRegister'

async function insertNoteUnderKey(
  payload: Record<string, unknown>,
  ck: string,
  givenFirst: NoteFirstSent | null | undefined,
): Promise<Note | Queued> {
  const queued = noteInsertQueued(ck)
  // この冪等キーで最初に送った中身（食い違いの基準）: 画面が渡した値（null＝分からない）→ このタブの記録 →
  // どれも無く送信待ちにも無い＝このキーで初めて送る＝この中身
  let first: Record<string, unknown> | undefined =
    givenFirst !== undefined ? (givenFirst ?? undefined) : firstSentNote.get(ck)
  const assumed = givenFirst === undefined && first === undefined && queued === null
  if (assumed) first = payload
  if (first !== undefined) rememberNoteSent(ck, first)
  if (queued !== null) {
    // 同じ冪等キーの登録が送信待ちに残っている（戻した書きかけを確定し直した・別のタブが先に確定した）: 登録を二重に
    // 積まず（同じ qid の op が2本並ぶと、先の op が届いた時に後の op ごと外れる）、その op と食い違う欄を登録への変更
    // （notes#ck:）に積む。基準は最初に送った中身（分からなければ null＝空欄なら書く・それ以外は競合＝黙って上書きしない。
    // 別のタブの登録を見ていない入力は〔くらべて選ぶ〕に出る・R6(B)・R6-1）
    const edits: CellEditInput<NoteEditField> = {}
    for (const f of NOTE_REG_FIELDS) {
      const v = payload[f] ?? null
      if (sameValue(v, queued.payload[f])) continue
      edits[f] = { value: v, base: first !== undefined ? (first[f] ?? null) : null }
    }
    if (Object.keys(edits).length > 0) {
      const ok = await stageNoteEdits({ clientKey: ck }, edits, { meta: noteMetaOfPayload(payload) })
      if (!ok) throw new DbError('server', MSG.notKept)
    }
    return QUEUED
  }
  return insertRow('notes', payload, normalizeNote, async (landed) => {
    // （応答待ちの上限は下の noteInsertTimeoutMs。過ぎたら送信待ちへ退避＝この登録ロックを握り続けない・L7-1）
    // 同じ冪等キーの登録が既に届いていた（R6(A)）: 送った中身と食い違う欄を、登録できた行への変更として積む。
    // 基準は最初に送った中身（分からなければ null）。初めて送るとみなしていたのに届いていた＝前にこのキーで送った
    // 中身は分からない（基準 null）。積めなければ成功にしない（書きかけを外させない）
    if (assumed) firstSentNote.delete(ck)
    if (!(await stageNoteDupDiff(landed, payload, assumed ? undefined : first))) throw new DbError('server', MSG.notKept)
  }, noteInsertTimeoutMs)
}

/** 登録ロックの中の申し送りの登録の、応答を待つ上限（ms・L7-1）。テストだけが __testHooks で短くする */
let noteInsertTimeoutMs = 20_000

/** 登録の後に書きかけで直せる欄（同じ冪等キーの登録どうしの食い違いを比べる欄・R6） */
const NOTE_REG_FIELDS = ['body', 'resident_id', 'reporter_id', 'color'] as const
/** この端末が冪等キーごとに最初に送った登録の中身（食い違いの基準に使う。メモリだけ・R6） */
const firstSentNote = new Map<string, Record<string, unknown>>()
function rememberNoteSent(ck: string, payload: Record<string, unknown>): void {
  if (!firstSentNote.has(ck)) firstSentNote.set(ck, payload)
}
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}
function noteMetaOfPayload(p: Record<string, unknown>): NoteMeta {
  return {
    note_on: dateStr(p.note_on) ?? '',
    shift: oneOf(p.shift, SHIFTS) ?? 'day',
    resident_id: idNum(p.resident_id),
    after16: bool(p.after16, false),
  }
}

/**
 * 同じ冪等キーで届いていた行（landed）と、送った登録の中身（payload）が食い違う欄を、登録できた行への変更
 * （notes#<id>）として積む（R6(A)）。基準は first（この端末が最初に送った中身）の値、無ければ null。
 * first の値のままの欄はこの端末の変更ではない（届いた後に他の端末が直した）ので積まない。積めなかった時 false
 */
async function stageNoteDupDiff(
  landed: Note,
  payload: Record<string, unknown>,
  first: Record<string, unknown> | undefined,
): Promise<boolean> {
  const row = landed as unknown as Record<string, unknown>
  const edits: CellEditInput<NoteEditField> = {}
  for (const f of NOTE_REG_FIELDS) {
    if (!(f in payload)) continue
    const v = payload[f] ?? null
    if (sameValue(v, row[f])) continue
    const b = first !== undefined ? (first[f] ?? null) : null
    if (first !== undefined && sameValue(v, b)) continue
    edits[f] = { value: v, base: b }
  }
  if (Object.keys(edits).length === 0) return true
  return stageNoteEdits({ id: landed.id }, edits, { meta: noteMetaOfPayload(row) })
}

// 既にある申し送りの変更・取り消し・継続の終了は、上の「申し送りの変更・取り消し」（saveNoteEdits・deleteNote＝
// 送信待ち → apply_note_edits）だけで行う（2026-09-29。rev 照合の updateNote・updateNoteFields・softDeleteNote・
// endOngoingNote は廃止＝画面から旧経路へ落とさない）

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

/**
 * その日（dayIso）にその方に在る外出・外泊（開始が当日以前で、帰着が無いか当日以降・取り消しを除く・開始の古い順）。
 * 外出の登録画面で「同じ日・同じ方の既存」を参考に出す（F56・2026-10-10。2台で同じ出来事を登録して2件になるのを、
 * 書く前に気づけるように。保存は止めない）。条件は日報の外出者と同じ（fetchDailyReport）
 */
export async function fetchOutingsOn(residentId: number, dayIso: string): Promise<Outing[]> {
  assertDay(dayIso)
  const rid = idNum(residentId)
  if (rid === null) return []
  const sb = await getClient()
  const res = (await sb
    .from('outings')
    .select(OUTING_COLS)
    .eq('resident_id', rid)
    .lte('start_on', dayIso)
    .or(`end_on.is.null,end_on.gte.${dayIso}`)
    .is('deleted_at', null)
    .order('start_on', { ascending: true })
    .order('id', { ascending: true })
    .limit(DAY_ROWS)) as Res<unknown>
  if (res.error !== null) throw readError(res)
  return list(res.data, normalizeOuting, DAY_ROWS)
}

/**
 * 外出・外泊1件の削除（soft delete・2026-10-09 日報の行の「✕」）。水分・入浴と同じ経路（rev 照合・送信待ち・edited_by）。
 * 読んだ後に他の端末が直していれば 'conflict'（黙って消さない）。旧行は 0010 のトリガが record_history に op='delete' で残す
 */
export async function softDeleteOuting(id: number, rev: number, opts?: WriteOpts): Promise<true | Conflict | Queued> {
  return softDelete('outings', id, rev, opts)
}

// ── 入浴記録（デイ・2026-09-26 追加・0012_bath_records.sql） ─────────────────────
//
// 書き方は水分・申し送り・外出と同じ経路（client_key・rev 照合・送信待ち・edited_by・soft delete）。
// 違うのは2点だけ:
//   ・入力解禁は input_enabled_bath（writeGate / assertKindWritable）
//   ・「1人1日1件」の自然キー（部分unique）を持つ。23505 のうち自分の client_key が載っていないものは
//     「他の端末が先に記録した」証拠 → 'conflict' を返す（画面は入力を消さず読み直しを促す）。
//     送信待ちから送った分は同じ判定で止める（sendQueuedOp）

const BATH_MSG = {
  missing: '入浴の記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。',
  badMonth: '月を読み取れませんでした。月を選び直してください。',
} as const

/** 1日の入浴記録の取得上限（1日の利用者数がこれを超える運用は無い） */
const BATH_DAY_ROWS = DAY_ROWS
/** 1か月の入浴記録の取得上限（在籍33名×31日≒1,000件。超えたら黙って切らずに知らせる） */
const BATH_MONTH_ROWS = MAX_ROWS

/** 表が無い（0012 未適用）時は「サーバー側の設定待ち」で止める（読めない理由を取り違えさせない） */
function bathReadError(res: Res<unknown>): DbError {
  if (isMissingTable(res)) return new DbError('server', BATH_MSG.missing)
  return readError(res)
}

/** 保存前の検証（画面と同じ関数）。通らなければ書かずに理由文で止める */
function assertBathInput(v: {
  bath_on: string
  result: BathResult
  cancel_reason: BathCancelReason | null
  note: string | null
}): void {
  const check = validateBathInput(v, localToday())
  if (!check.ok) throw new DbError('server', check.message)
}

/**
 * 自動で入った記録（0015 の cron が作る・auto=true・recorded_by=null）を職員が直す時に一緒に送る項目。
 * auto=false（手動の記録になる）と、記入者＝直した職員（opts.editedBy、無ければ端末の既定の操作者）。
 * 自動でない記録には何も足さない（従来どおりの送り方のまま）。rev 照合なので、読んだ時点で自動だった行にだけ効く
 */
function autoOffPatch(current: { auto: boolean }, opts?: WriteOpts): Record<string, unknown> {
  if (current.auto !== true) return {}
  return { auto: false, recorded_by: idNum(opts?.editedBy) ?? editorId }
}

/** 端末の今日（YYYY-MM-DD・ローカル時刻＝JST 運用）。format.ts の todayIso と同じ計算 */
function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** その日の入浴記録（削除済みを除く） */
export async function fetchBathDay(dayIso: string): Promise<BathRecord[]> {
  assertDay(dayIso)
  const sb = await getClient()
  const res = (await sb
    .from('bath_records')
    .select(BATH_COLS)
    .eq('bath_on', dayIso)
    .is('deleted_at', null)
    .order('id', { ascending: true })
    .limit(BATH_DAY_ROWS)) as Res<unknown>
  if (res.error !== null) throw bathReadError(res)
  const rows = list(res.data, normalizeBath, BATH_DAY_ROWS)
  await assertSessionIfEmpty(sb, rows.length) // anon で読んだ0件を「未記録」と出さない（F58）
  return rows
}

/** その月（'yyyy-MM'）の入浴記録（削除済みを除く）。取り切れない時は黙って切らずに例外 */
export async function fetchBathMonth(monthKey: string): Promise<BathRecord[]> {
  const range = monthRange(monthKey)
  if (range === null) throw new DbError('server', BATH_MSG.badMonth)
  const sb = await getClient()
  const res = (await sb
    .from('bath_records')
    .select(BATH_COLS)
    .gte('bath_on', range.from)
    .lte('bath_on', range.to)
    .is('deleted_at', null)
    .order('bath_on', { ascending: true })
    .order('id', { ascending: true })
    .limit(BATH_MONTH_ROWS)) as Res<unknown>
  if (res.error !== null) throw bathReadError(res)
  assertLoadedAll(res, BATH_MONTH_ROWS)
  return list(res.data, normalizeBath, BATH_MONTH_ROWS)
}

/**
 * その日のデイの入浴予定（週間計画の写しから・RPC daycare_bath_plan）。
 * available=false … 予定を取得できない（写しが無い・関数が無い＝0012 未適用）。画面は記録を妨げない。
 * updatedAt       … 写しの更新時刻（RPC の updated_at 列。写しの中身＝介護度などは端末へ持ち出さない）
 * unmatched       … 名簿（residents.source_id）と突き合わせられなかった予定の件数
 * residents を渡さない時は在籍の名簿を取って突き合わせる。通信できない等は例外（DbError）。
 */
export interface BathPlanResult {
  available: boolean
  updatedAt: string | null
  entries: BathPlanEntry[]
  unmatched: number
}

export async function fetchBathPlan(dayIso: string, residents?: Resident[]): Promise<BathPlanResult> {
  assertDay(dayIso)
  const sb = await getClient()
  const [res, roster] = await Promise.all([
    sb.rpc('daycare_bath_plan', { p_date: dayIso }) as unknown as Promise<Res<unknown>>,
    residents !== undefined ? Promise.resolve(residents) : fetchResidents(),
  ])
  if (res.error !== null) {
    if (isMissingRpc(res)) return { available: false, updatedAt: null, entries: [], unmatched: 0 }
    throw readError(res)
  }
  const rows: BathPlanRow[] = []
  let updatedAt: string | null = null
  if (Array.isArray(res.data)) {
    for (const raw of res.data.slice(0, MAX_ROWS)) {
      const r = asRecord(raw)
      if (r === null) continue
      updatedAt = updatedAt ?? str(r.updated_at)
      rows.push({
        source_id: str(r.source_id),
        start_time: str(r.start_time),
        end_time: str(r.end_time),
        hospitalized: r.hospitalized === true,
      })
    }
  }
  // 0行＝写しが無い（読めない）。source_id が null の1行だけ＝写しはあるが、その日の予定は無い
  if (rows.length === 0) return { available: false, updatedAt: null, entries: [], unmatched: 0 }
  const { entries, unmatched } = matchBathPlan(rows, roster)
  return { available: true, updatedAt, entries, unmatched }
}

/**
 * 入浴記録の追加。端末生成の冪等キー client_key を必ず付ける（再送しても1行に収まる）。
 * 戻り値: 追加した行／'conflict'（同じ人・同じ日に他の端末が先に記録した）／'queued'（通信できない）
 */
export async function insertBath(b: Omit<BathRecord, 'id' | 'rev' | 'auto'>): Promise<BathRecord | Conflict | Queued> {
  const cancel_reason = b.result === 'cancel' ? b.cancel_reason : null
  const note = b.note === null || b.note.trim() === '' ? null : b.note
  assertBathInput({ bath_on: b.bath_on, result: b.result, cancel_reason, note })
  await writeGate('bath_records')
  const payload = withClientKey({
    resident_id: b.resident_id,
    bath_on: b.bath_on,
    result: b.result,
    cancel_reason,
    note,
    recorded_by: idNum(b.recorded_by),
  })
  const sb = await getClient()
  const res = (await sb.from('bath_records').insert(payload).select(BATH_COLS).maybeSingle()) as Res<unknown>
  if (res.error !== null) {
    if (isAuthFail(res)) {
      fireAuthExpired()
      return enqueue({ table: 'bath_records', kind: 'insert', payload })
    }
    if (isTransient(res)) return enqueue({ table: 'bath_records', kind: 'insert', payload })
    if (isUniqueViolation(res)) {
      const ck = clientKeyOf(payload)
      // 自分の送信が既に載っている（再送の行き違い）→ 載っている行を返す
      const landed = ck === null ? null : await findByKey(sb, 'bath_records', ck, BATH_COLS, true)
      const row = landed === null ? null : normalizeBath(landed.row)
      if (row !== null) return row
      // 他の端末が同じ人・同じ日を先に記録した（1人1日1件）→ 入力を消さず読み直しを促す
      if (await bathDayTaken(sb, payload)) return CONFLICT
      // どちらとも確かめられない（読めない）→ 送信待ちへ（次の再送で同じ判定をやり直す）
      return enqueue({ table: 'bath_records', kind: 'insert', payload })
    }
    throw rejectError('保存でき', errCode(res), res.status)
  }
  markSelfRow('bath_records', res.data, num(asRecord(res.data)?.rev))
  const row = normalizeBath(res.data)
  if (row === null) throw new DbError('server', MSG.broken)
  return row
}

/**
 * 入浴記録の修正（rev 照合の部分更新）。区分を中止以外にしたら理由は空（null）にして送る。
 * 送る前に、修正後の値（current と patch を重ねたもの）を検証する。
 * 自動で入った記録（current.auto）を直す時は auto=false と記入者（recorded_by）を一緒に送る（autoOffPatch）
 */
export async function updateBath(
  current: BathRecord,
  patch: Partial<Pick<BathRecord, 'result' | 'cancel_reason' | 'note'>>,
  opts?: WriteOpts,
): Promise<BathRecord | Conflict | Queued> {
  const result = patch.result ?? current.result
  const cancel_reason = result === 'cancel' ? (patch.cancel_reason !== undefined ? patch.cancel_reason : current.cancel_reason) : null
  const rawNote = patch.note !== undefined ? patch.note : current.note
  const note = rawNote === null || rawNote.trim() === '' ? null : rawNote
  assertBathInput({ bath_on: current.bath_on, result, cancel_reason, note })
  const sent: Record<string, unknown> = {}
  if (patch.result !== undefined) sent.result = result
  if (patch.result !== undefined || patch.cancel_reason !== undefined) sent.cancel_reason = cancel_reason
  if (patch.note !== undefined) sent.note = note
  if (Object.keys(sent).length > 0) Object.assign(sent, autoOffPatch(current, opts))
  return updateRow('bath_records', current.id, current.rev, sent, normalizeBath, opts)
}

/** 入浴記録の取り消し（soft delete。物理削除はしない） */
export async function softDeleteBath(id: number, rev: number, opts?: WriteOpts): Promise<true | Conflict | Queued> {
  return softDelete('bath_records', id, rev, opts)
}

/**
 * この端末（このタブ）の送信待ちに、その人・その日の入浴記録の追加、またはその記録（recordId）の修正・取り消しが
 * 残っているか（送信中を含む。自動再送を止めた＝blocked の op は含めない）。**読むだけで送信待ちは書き換えない**。
 * 画面はこれが true の行の区分ボタン・取り消しを押せなくする（圏外で同じ人を続けて押して2件目の追加が
 * 23505 で止まるのを防ぐ・2026-09-26 レビュー3巡目。送信待ちの経路そのものは他の表と同じ）
 */
export function hasPendingBath(residentId: number, day: string, recordId: number | null): boolean {
  for (const q of queue) {
    if (q.table !== 'bath_records' || q.blocked !== undefined) continue
    if (q.kind === 'insert') {
      if (idNum(q.payload.resident_id) === residentId && dateStr(q.payload.bath_on) === day) return true
    } else if (q.kind === 'update' && recordId !== null && q.rowId === recordId) {
      return true
    }
  }
  return false
}

/**
 * 施設全体で最初の入浴記録の日（削除済みを除く・無ければ null）。月次表の「未」を、記録を始めた日以降にだけ付けるために使う。
 * 期間を持たない読み取りだが、1行だけ（limit 1）を (bath_on) の索引で引くので全件を読まない。
 */
export async function fetchBathFirstDay(): Promise<string | null> {
  const sb = await getClient()
  const res = (await sb
    .from('bath_records')
    .select('bath_on')
    .is('deleted_at', null)
    .order('bath_on', { ascending: true })
    .limit(1)
    .maybeSingle()) as Res<unknown>
  if (res.error !== null) throw bathReadError(res)
  return dateStr(asRecord(res.data)?.bath_on)
}

// ── 与薬チェック（服薬介助・2026-09-26 追加・0013_med_admin.sql） ─────────────────
//
// 書き方は入浴記録と同じ経路（client_key・rev 照合・送信待ち cl_sendQueue・edited_by・soft delete）。
//   ・入力解禁は input_enabled_med（writeGate / assertKindWritable）。与薬の記録だけ。服薬の時間帯は封鎖しない
//     （使い始める前に看護師が設定できるように・2026-09-26 チーフ裁定）
//   ・自然キー（部分unique）: 服薬の時間帯は1人1件、与薬の記録は1人1日1時間帯1件（頓服は持たない）。
//     23505 のうち自分の client_key が載っていないものは「他の端末が先に記録した」→ 'conflict'。
//     送信待ちから送った分も同じ判定で止める（sendQueuedOp の naturalKeyTaken）
//   ・送信待ちの中身は書き換えない・破棄しない（入浴のレビュー3巡目の教訓）。未送信の行・マスは
//     hasPendingMed / hasPendingMedSlots で画面が押せなくする

const MED_MSG = {
  missing: '与薬の記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。',
  badMonth: '月を読み取れませんでした。月を選び直してください。',
  badSlots: '服薬の時間帯を読み取れませんでした。選び直してから、もう一度お試しください。',
  badCurrent: '設定を読み取れませんでした。画面を読み直してから、もう一度お試しください。入力は消えていません。',
} as const

/** 1日の与薬の記録の取得上限（在籍33名×（4時間帯＋頓服数件）。これを超える運用は無い） */
const MED_DAY_ROWS = DAY_ROWS
/** 1回の月の取得上限。取り切れない時は黙って切らずに例外 */
const MED_MONTH_ROWS = MAX_ROWS
/**
 * 全員の月次表を引く時の1回の日数。在籍33名×7日×（4時間帯＋頓服）≒1,200件で 2,000件に収まる
 * （1か月をまとめて引くと 33名×31日×4≒4,100件で上限を超えるため、7日ずつ分けて引く）
 */
const MED_MONTH_CHUNK_DAYS = 7

/** 表が無い（0013 未適用）時は「サーバー側の設定待ち」で止める */
function medReadError(res: Res<unknown>): DbError {
  if (isMissingTable(res)) return new DbError('server', MED_MSG.missing)
  return readError(res)
}

/**
 * 在籍の方の服薬の時間帯（削除済みを除く・1人1件）。residents を渡さない時は在籍の名簿を取る。
 * 名簿の利用者ID で絞って引く（全件ロードしない）。在籍の方が0人なら問い合わせない
 */
export async function fetchMedSlots(residents?: Resident[]): Promise<MedSlotsSetting[]> {
  const roster = residents ?? (await fetchResidents())
  const ids = roster.filter((r) => r.active).map((r) => r.id)
  if (ids.length === 0) return []
  const sb = await getClient()
  const res = (await sb
    .from('med_slots')
    .select(MED_SLOTS_COLS)
    .in('resident_id', ids.slice(0, MAX_ROWS))
    .is('deleted_at', null)
    .order('resident_id', { ascending: true })
    .order('id', { ascending: true })
    .limit(MAX_ROWS)) as Res<unknown>
  if (res.error !== null) throw medReadError(res)
  return list(res.data, normalizeMedSlotsRow)
}

/** その日の与薬の記録（時間帯・頓服とも。削除済みを除く） */
export async function fetchMedDay(dayIso: string): Promise<MedAdmin[]> {
  assertDay(dayIso)
  const sb = await getClient()
  const res = (await sb
    .from('med_admin')
    .select(MED_ADMIN_COLS)
    .eq('admin_on', dayIso)
    .is('deleted_at', null)
    .order('id', { ascending: true })
    .limit(MED_DAY_ROWS)) as Res<unknown>
  if (res.error !== null) throw medReadError(res)
  assertLoadedAll(res, MED_DAY_ROWS)
  const rows = list(res.data, normalizeMedAdmin, MED_DAY_ROWS)
  await assertSessionIfEmpty(sb, rows.length) // anon で読んだ0件を「未記録」と出さない（F58）
  return rows
}

/**
 * その月（'yyyy-MM'）の与薬の記録（削除済みを除く）。residentId を渡せばその人だけ（1回で引く）、
 * 省略すると全員（MED_MONTH_CHUNK_DAYS 日ずつ分けて引く）。どの回も取り切れない時は黙って切らずに例外
 */
export async function fetchMedMonth(monthKey: string, residentId?: number): Promise<MedAdmin[]> {
  const days = monthDays(monthKey)
  if (days.length === 0) throw new DbError('server', MED_MSG.badMonth)
  const sb = await getClient()
  const one = async (from: string, to: string): Promise<MedAdmin[]> => {
    let q = sb.from('med_admin').select(MED_ADMIN_COLS)
    if (residentId !== undefined) q = q.eq('resident_id', residentId)
    const res = (await q
      .gte('admin_on', from)
      .lte('admin_on', to)
      .is('deleted_at', null)
      .order('admin_on', { ascending: true })
      .order('id', { ascending: true })
      .limit(MED_MONTH_ROWS)) as Res<unknown>
    if (res.error !== null) throw medReadError(res)
    assertLoadedAll(res, MED_MONTH_ROWS)
    return list(res.data, normalizeMedAdmin, MED_MONTH_ROWS)
  }
  if (residentId !== undefined) return one(days[0], days[days.length - 1])
  const spans: [string, string][] = []
  for (let i = 0; i < days.length; i += MED_MONTH_CHUNK_DAYS) {
    spans.push([days[i], days[Math.min(i + MED_MONTH_CHUNK_DAYS, days.length) - 1]])
  }
  const parts = await Promise.all(spans.map(([from, to]) => one(from, to)))
  return parts.flat()
}

/**
 * 施設全体で最初の与薬の記録の日（削除済みを除く・無ければ null）。月次表の「未」を、記録を始めた日以降にだけ付けるために使う。
 * 1行だけ（limit 1）を (admin_on) の索引で引くので全件を読まない
 */
export async function fetchMedFirstDay(): Promise<string | null> {
  const sb = await getClient()
  const res = (await sb
    .from('med_admin')
    .select('admin_on')
    .is('deleted_at', null)
    .order('admin_on', { ascending: true })
    .limit(1)
    .maybeSingle()) as Res<unknown>
  if (res.error !== null) throw medReadError(res)
  return dateStr(asRecord(res.data)?.admin_on)
}

/**
 * 自然キー（部分unique）を持つ表への追加（入浴記録の insertBath と同じ作り）。
 * 自分の送信が既に載っていればその行、他の端末が同じ自然キーを先に記録していれば 'conflict'、
 * 通信できなければ送信待ち（'queued'）
 */
async function insertKeyed<T>(
  table: 'med_slots' | 'med_admin',
  payload: Record<string, unknown>,
  normalize: (row: unknown) => T | null,
): Promise<T | Conflict | Queued> {
  await writeGate(table)
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
      // 自分の送信が既に載っている（再送の行き違い）→ 載っている行を返す
      const landed = ck === null ? null : await findByKey(sb, table, ck, cols, true)
      const row = landed === null ? null : normalize(landed.row)
      if (row !== null) return row
      // 他の端末が同じ自然キーを先に記録した → 入力を消さず読み直しを促す
      if (await naturalKeyTaken(sb, table, payload)) return CONFLICT
      // どちらとも確かめられない（読めない）→ 送信待ちへ（次の再送で同じ判定をやり直す）
      return enqueue({ table, kind: 'insert', payload })
    }
    throw rejectError('保存でき', errCode(res), res.status)
  }
  markSelfRow(table, res.data, num(asRecord(res.data)?.rev))
  const row = normalize(res.data)
  if (row === null) throw new DbError('server', MSG.broken)
  return row
}

/**
 * 服薬の時間帯を保存する（upsert は使わない）。current＝画面が読んだその人の設定（無ければ null）。
 * ・current が null … insert（client_key 付き）。他の端末が先に設定していれば 'conflict'
 * ・current がある … rev 照合の update（slots と note）。他の端末が先に変えていれば 'conflict'
 * slots は朝→昼→夕→眠前の順にそろえて送る。知らない値が混じっていれば書かずに止める
 */
export async function setMedSlots(
  residentId: number,
  slots: readonly MedSlot[],
  note: string | null,
  current: MedSlotsSetting | null,
  opts?: WriteOpts,
): Promise<MedSlotsSetting | Conflict | Queued> {
  const normalized = normalizeMedSlots(slots)
  if (normalized.length !== new Set(slots).size) throw new DbError('server', MED_MSG.badSlots)
  if (idNum(residentId) === null || (current !== null && current.resident_id !== residentId)) {
    throw new DbError('server', MED_MSG.badCurrent)
  }
  const cleanNote = note === null || note.trim() === '' ? null : note
  if (current === null) {
    const payload = withClientKey({ resident_id: residentId, slots: normalized, note: cleanNote })
    return insertKeyed('med_slots', payload, normalizeMedSlotsRow)
  }
  // 変えた列だけを送る（F29・2026-10-10）。読んだ時に知らない時間帯は正規化で落ちているので、備考だけを直した古い版が
  // slots を送ると、新しい版が足した時間帯がサーバーから消える。どちらも変わっていなければ従来どおり両方送る
  const patch: Record<string, unknown> = {}
  if (JSON.stringify(normalized) !== JSON.stringify(normalizeMedSlots(current.slots))) patch.slots = normalized
  if (cleanNote !== (current.note === null || current.note.trim() === '' ? null : current.note)) patch.note = cleanNote
  if (Object.keys(patch).length === 0) {
    patch.slots = normalized
    patch.note = cleanNote
  }
  return updateRow('med_slots', current.id, current.rev, patch, normalizeMedSlotsRow, opts)
}

/** 保存前の検証（画面と同じ関数）。通らなければ書かずに理由文で止める */
function assertMedInput(v: {
  admin_on: string
  slot: MedAdminSlot
  status: MedStatus
  given_at: string | null
  prn_drug: string | null
  prn_reason: string | null
  prn_effect: string | null
  note: string | null
}): void {
  const check = validateMedAdminInput(v, localToday())
  if (!check.ok) throw new DbError('server', check.message)
}

/** 空白だけの文字は null にする（自由記述の欄） */
function textOrNull(v: string | null | undefined): string | null {
  return v === null || v === undefined || v.trim() === '' ? null : v
}

/**
 * 与薬の記録の追加。端末生成の冪等キー client_key を必ず付ける（再送しても1行に収まる）。
 * 頓服以外は頓服の項目（使用時刻・薬・理由・効果）を null にして送る。
 * 戻り値: 追加した行／'conflict'（同じ人・同じ日・同じ時間帯を他の端末が先に記録した）／'queued'（通信できない）
 */
export async function insertMedAdmin(
  m: Omit<MedAdmin, 'id' | 'rev' | 'created_at' | 'auto'>,
): Promise<MedAdmin | Conflict | Queued> {
  const prn = m.slot === 'prn'
  const v = {
    admin_on: m.admin_on,
    slot: m.slot,
    status: m.status,
    given_at: prn ? m.given_at : null,
    prn_drug: prn ? textOrNull(m.prn_drug) : null,
    prn_reason: prn ? textOrNull(m.prn_reason) : null,
    prn_effect: prn ? textOrNull(m.prn_effect) : null,
    note: textOrNull(m.note),
  }
  assertMedInput(v)
  const payload = withClientKey({ resident_id: m.resident_id, ...v, recorded_by: idNum(m.recorded_by) })
  return insertKeyed('med_admin', payload, normalizeMedAdmin)
}

/**
 * 与薬の記録の修正（rev 照合の部分更新）。送るのは patch に入れた項目だけ。
 * 送る前に、修正後の値（current と patch を重ねたもの）を検証する（頓服は服用済みだけ・頓服以外は頓服の項目を持たない）
 * 自動で入った記録（current.auto）を直す時は auto=false と記入者（recorded_by）を一緒に送る（autoOffPatch）
 */
export async function updateMedAdmin(
  current: MedAdmin,
  patch: Partial<Pick<MedAdmin, 'status' | 'note' | 'given_at' | 'prn_drug' | 'prn_reason' | 'prn_effect'>>,
  opts?: WriteOpts,
): Promise<MedAdmin | Conflict | Queued> {
  const pick = <K extends keyof typeof patch>(k: K): MedAdmin[K] =>
    (patch[k] !== undefined ? patch[k] : current[k]) as MedAdmin[K]
  const v = {
    admin_on: current.admin_on,
    slot: current.slot,
    status: pick('status'),
    given_at: pick('given_at'),
    prn_drug: textOrNull(pick('prn_drug')),
    prn_reason: textOrNull(pick('prn_reason')),
    prn_effect: textOrNull(pick('prn_effect')),
    note: textOrNull(pick('note')),
  }
  assertMedInput(v)
  const sent: Record<string, unknown> = {}
  for (const k of ['status', 'note', 'given_at', 'prn_drug', 'prn_reason', 'prn_effect'] as const) {
    if (patch[k] !== undefined) sent[k] = v[k]
  }
  if (Object.keys(sent).length > 0) Object.assign(sent, autoOffPatch(current, opts))
  return updateRow('med_admin', current.id, current.rev, sent, normalizeMedAdmin, opts)
}

/** 与薬の記録の取り消し（soft delete。物理削除はしない） */
export async function softDeleteMedAdmin(id: number, rev: number, opts?: WriteOpts): Promise<true | Conflict | Queued> {
  return softDelete('med_admin', id, rev, opts)
}

/**
 * この端末（このタブ）の送信待ちに、その人・その日・その時間帯の与薬の記録の追加、またはその記録（recordId）の
 * 修正・取り消しが残っているか（送信中を含む。自動再送を止めた＝blocked の op は含めない）。
 * **読むだけで送信待ちは書き換えない**。画面はこれが true のマスを押せなくする（hasPendingBath と同じ考え方）。
 * 頓服（slot='prn'）で recordId を渡した時は、その記録の修正・取り消しだけを見る（頓服の追加は別の記録のため）
 */
export function hasPendingMed(residentId: number, day: string, slot: MedAdminSlot, recordId: number | null = null): boolean {
  for (const q of queue) {
    if (q.table !== 'med_admin' || q.blocked !== undefined) continue
    if (q.kind === 'insert') {
      // 頓服は1日に何件でも持てるので、まだ送っていない頓服の追加は、既にある頓服の記録（recordId）を止めない
      if (slot === 'prn' && recordId !== null) continue
      if (
        idNum(q.payload.resident_id) === residentId &&
        dateStr(q.payload.admin_on) === day &&
        q.payload.slot === slot
      ) {
        return true
      }
    } else if (q.kind === 'update' && recordId !== null && q.rowId === recordId) {
      return true
    }
  }
  return false
}

/** 送信待ちから組み立てた、まだサーバーに載っていない頓服の記録（画面の表示用・読むだけ） */
export interface PendingPrn {
  /** 送信待ちの qid（＝client_key） */
  qid: string
  residentId: number
  givenAt: string | null
  drug: string | null
  reason: string | null
  note: string | null
  /** waiting＝送信待ち／sending＝送信中／blocked＝自動再送を止めた（止まっている） */
  state: 'waiting' | 'sending' | 'blocked'
}

/**
 * この端末（このタブ）の送信待ちにある、その日の頓服の追加（未送信・送信中・止まっているものを含む）。
 * **読むだけで送信待ちは書き換えない・破棄しない**。送信待ちは起動時に localStorage から読み直されるので、
 * 再読み込み・日付の切り替えの後も、送れるまで画面に「未送信」として出し続けられる（二重記録を防ぐ）
 */
export function pendingPrnOps(day: string): PendingPrn[] {
  const out: PendingPrn[] = []
  for (const q of queue) {
    if (q.table !== 'med_admin' || q.kind !== 'insert') continue
    if (q.payload.slot !== 'prn' || dateStr(q.payload.admin_on) !== day) continue
    const residentId = idNum(q.payload.resident_id)
    if (residentId === null) continue
    out.push({
      qid: q.qid,
      residentId,
      givenAt: str(q.payload.given_at),
      drug: str(q.payload.prn_drug),
      reason: str(q.payload.prn_reason),
      note: str(q.payload.note),
      state: q.blocked !== undefined ? 'blocked' : q.sending === true ? 'sending' : 'waiting',
    })
  }
  return out
}

/**
 * この端末（このタブ）の送信待ちに、その人の服薬の時間帯の追加、またはその設定（recordId）の修正が残っているか。
 * 読むだけ。画面はこれが true の行を保存できなくする
 */
export function hasPendingMedSlots(residentId: number, recordId: number | null): boolean {
  for (const q of queue) {
    if (q.table !== 'med_slots' || q.blocked !== undefined) continue
    if (q.kind === 'insert') {
      if (idNum(q.payload.resident_id) === residentId) return true
    } else if (q.kind === 'update' && recordId !== null && q.rowId === recordId) {
      return true
    }
  }
  return false
}

// ── 事故・ヒヤリハット（2026-09-26 追加・0014_incidents.sql） ─────────────────────
//
// 書き方は入浴・与薬と同じ経路（client_key・rev 照合・送信待ち cl_sendQueue・edited_by・soft delete）。
//   ・入力解禁は input_enabled_incident（writeGate / assertKindWritable）
//   ・自然キーは持たない（1件ごとに別の記録）。23505 は自分の client_key が既に載っている＝再送の行き違いだけ
//   ・送信待ちの中身は書き換えない・破棄しない。未送信の記録は hasPendingIncident で画面が編集できなくする。
//     まだサーバーに無い追加は pendingIncidentOps で送信待ちから読むだけ（一覧に「未送信」として出す）
//   ・対象者の氏名の写し（detail.subject_name）は**アプリからは一切送らない**（2026-09-26 チーフ裁定: 氏名は名簿の値だけを使う・
//     画面では直せない）。サーバーのトリガが名簿から写す／前の写しを残す（氏名を送信待ち＝端末の保存領域に置かないため）

const INCIDENT_MSG = {
  missing: '事故・ヒヤリハットの記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。',
  badRange: '期間を読み取れませんでした。期間を選び直してください。',
} as const

/** 一覧・集計の1回の取得上限（取り切れない時は黙って切らずに例外。期間を狭めてもらう） */
const INCIDENT_LIST_ROWS = MAX_ROWS

/** 表が無い（0014 未適用）時は「サーバー側の設定待ち」で止める */
function incidentReadError(res: Res<unknown>): DbError {
  if (isMissingTable(res)) return new DbError('server', INCIDENT_MSG.missing)
  return readError(res)
}

/** 一覧・集計の取得条件。期間（発生日）は必須（全件ロードしない） */
export interface IncidentQuery {
  fromIso: string
  toIso: string
  kind?: IncidentKind | null
  status?: IncidentStatus | null
  /**
   * 対象者で絞る（F56・2026-10-10）。事故の新規登録で、同じ日・同じ方の既存の記録を参考に出す時に使う
   * （fromIso=toIso=発生日）。省く・null は絞らない（一覧・集計は従来どおり）
   */
  residentId?: number | null
}

/** 期間（発生日）の記録を新しい順に（削除済みを除く・detail は持ち出さない）。区分・状態で絞れる */
export async function fetchIncidents(q: IncidentQuery): Promise<Incident[]> {
  assertDay(q.fromIso)
  assertDay(q.toIso)
  if (q.fromIso > q.toIso) throw new DbError('server', INCIDENT_MSG.badRange)
  const sb = await getClient()
  let query = sb
    .from('incidents')
    .select(INCIDENT_LIST_COLS)
    .gte('occurred_on', q.fromIso)
    .lte('occurred_on', q.toIso)
    .is('deleted_at', null)
  if (q.kind != null) query = query.eq('kind', q.kind)
  if (q.status != null) query = query.eq('status', q.status)
  if (q.residentId != null) {
    const rid = idNum(q.residentId)
    if (rid === null) return []
    query = query.eq('resident_id', rid)
  }
  const res = (await query
    .order('occurred_on', { ascending: false })
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(INCIDENT_LIST_ROWS)) as Res<unknown>
  if (res.error !== null) throw incidentReadError(res)
  assertLoadedAll(res, INCIDENT_LIST_ROWS)
  return list(res.data, normalizeIncident, INCIDENT_LIST_ROWS)
}

/** 'YYYY-MM-DD' の翌日 0:00（端末の時刻＝JST 運用）の ISO。その日の「終わり」の境目 */
function nextDayStartIso(dayIso: string): string {
  const [y, m, d] = dayIso.split('-').map(Number)
  return new Date(y, m - 1, d + 1, 0, 0, 0, 0).toISOString()
}

/**
 * その日（dayIso）の終わりの時点で未完了だった記録（削除済みを除く・発生日の古い順・detail は持ち出さない）。
 * ＝その日までに発生し、いま対応中（status='open'）か、完了にした日時（closed_at）がその日より後のもの。
 * 委員会用の月次集計の「未完了の一覧」（月末時点。前月以前からの持ち越しを含む・月末より後に発生したものは除く）に使う。
 * 対応中と「月末より後に完了」の2回に分けて引く（or の式に値を差し込まない）。上限を超えたら黙って切らずに例外
 */
export async function fetchIncidentsOpenAt(dayIso: string): Promise<Incident[]> {
  assertDay(dayIso)
  const boundary = nextDayStartIso(dayIso)
  const sb = await getClient()
  const base = () =>
    sb.from('incidents').select(INCIDENT_LIST_COLS).lte('occurred_on', dayIso).is('deleted_at', null)
  const [openRes, laterRes] = (await Promise.all([
    base().eq('status', 'open').order('occurred_on', { ascending: true }).order('id', { ascending: true }).limit(INCIDENT_LIST_ROWS),
    base()
      .eq('status', 'closed')
      .gte('closed_at', boundary)
      .order('occurred_on', { ascending: true })
      .order('id', { ascending: true })
      .limit(INCIDENT_LIST_ROWS),
  ])) as unknown as [Res<unknown>, Res<unknown>]
  for (const res of [openRes, laterRes]) {
    if (res.error !== null) throw incidentReadError(res)
    assertLoadedAll(res, INCIDENT_LIST_ROWS)
  }
  const out = new Map<number, Incident>()
  for (const res of [openRes, laterRes]) {
    for (const i of list(res.data, normalizeIncident, INCIDENT_LIST_ROWS)) out.set(i.id, i)
  }
  return [...out.values()].sort((a, b) => (a.occurred_on === b.occurred_on ? a.id - b.id : a.occurred_on < b.occurred_on ? -1 : 1))
}

/** 1件（様式の残りの欄 detail を含む）。無い・取り消し済みなら null */
export async function fetchIncident(id: number): Promise<Incident | null> {
  if (idNum(id) === null) return null
  const sb = await getClient()
  const res = (await sb
    .from('incidents')
    .select(INCIDENT_COLS)
    .eq('id', id)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()) as Res<unknown>
  if (res.error !== null) throw incidentReadError(res)
  return res.data === null ? null : normalizeIncident(res.data)
}

/** 空白だけの文字の列は null にそろえ、detail の選択肢を照合し直す（送る前・検証の前に通す） */
function cleanIncident(v: IncidentInput): IncidentInput {
  return {
    ...v,
    place_other: textOrNull(v.place_other),
    // 種別はそのまま（知らない値・重複は検証で止める。黙って落として別の記録にしない）
    types: Array.isArray(v.types) ? [...v.types] : [],
    detail: normalizeIncidentDetail(v.detail),
  }
}

/** 保存前の検証（画面と同じ関数）。通らなければ書かずに理由文で止める */
function assertIncidentInput(v: IncidentInput): void {
  const check = validateIncidentInput(v, localToday())
  if (!check.ok) throw new DbError('server', check.message)
}

/**
 * detail を送る形に。氏名の写し（subject_name）は渡されても必ず外す＝送らない（サーバーのトリガが名簿から写す・残す）。
 * 送信待ち（cl_sendQueue）に入る payload はこの形なので、送信待ちに氏名が入る経路が無い
 */
function incidentDetailPayload(d: IncidentDetail): Record<string, unknown> {
  const out: Record<string, unknown> = { ...d }
  delete out.subject_name
  return out
}

/** 列で持つ項目（detail 以外）。insert・update の送り方をそろえるための並び */
const INCIDENT_FIELDS = [
  'kind',
  'resident_id',
  'occurred_on',
  'occurred_at',
  'office',
  'place',
  'place_other',
  'types',
  'severity',
  'status',
  'report_stage',
  'report_no',
  'submitted_on',
  'city_report_needed',
  'city_reported_on',
  'reporter_id',
  'confirmer_id',
  'confirmed_at',
] as const

/**
 * 事故・ヒヤリハットの追加。端末生成の冪等キー client_key を必ず付ける（再送しても1行に収まる）。
 * detail.subject_name（氏名の写し）は送らない（サーバーが名簿から写す）。
 * 戻り値: 追加した行／'queued'（通信できない・送信待ちへ）
 */
export async function insertIncident(i: IncidentInput): Promise<Incident | Queued> {
  const v = cleanIncident(i)
  assertIncidentInput(v)
  const row: Record<string, unknown> = {}
  for (const k of INCIDENT_FIELDS) row[k] = v[k]
  row.closed_at = v.status === 'closed' ? new Date().toISOString() : null
  row.detail = incidentDetailPayload(v.detail)
  return insertRow('incidents', withClientKey(row), normalizeIncident)
}

/** 追記・修正で送る変更（列は変えた項目だけ、detail は変えた欄だけを渡す） */
export type IncidentPatch = Partial<Omit<Incident, 'id' | 'rev' | 'detail'>> & {
  detail?: Partial<IncidentDetail>
  /**
   * 氏名の写しを名簿の現在の氏名で写し直す（「名簿の氏名に合わせる」）。氏名そのものは送らず、detail に一時の印
   * RESYNC_SUBJECT_KEY を入れて送る。0014 のトリガが印を見て写し直し、印を取り除く
   */
  resyncSubjectName?: boolean
}

/** 氏名の写しを写し直させる一時の印（detail のキー。0014 の incidents_subject_snapshot と同じ名前） */
export const RESYNC_SUBJECT_KEY = '_resync_subject_name'

// ── 事故の detail をサーバーで重ねる移行（0028）が当たっているか（F29） ─────────────────
// 当たっている DB には detail の「変えたキーだけ」を送る（古い版になった後も、新しい版が足した欄・選択肢を黙って消さない）。
// 当たっていない・確かめられない DB には従来どおり丸ごと送る（変えたキーだけを旧い DB へ送ると、他の欄が消える）。

/** 確かめた結果を持つ時間（DB の移行を戻す時は、端末を再読み込みしてから。0028 の注記） */
const DETAIL_MERGE_TTL_MS = 10 * 60_000
let detailMergeState: 'ready' | 'missing' | null = null
let detailMergeCheckedAt = 0
let detailMergeInFlight: Promise<'ready' | 'missing' | null> | null = null

/** 0028 の incidents_detail_merge_ready() を呼んで確かめる（同時に呼ばれた分は1回にまとめる） */
async function incidentDetailMergeReady(): Promise<boolean> {
  if (detailMergeState !== null && Date.now() - detailMergeCheckedAt < DETAIL_MERGE_TTL_MS) return detailMergeState === 'ready'
  // 圏外と分かっている時は問い合わせない（保存を待たせない。丸ごと送る＝消さない側）
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return detailMergeState === 'ready'
  if (detailMergeInFlight === null) {
    detailMergeInFlight = (async (): Promise<'ready' | 'missing' | null> => {
      try {
        const sb = await getClient()
        const res = await bounded(sb.rpc('incidents_detail_merge_ready'))
        if (res.error !== null) {
          if (!isMissingRpc(res)) return null // 通信できない等＝確かめられなかった
          detailMergeState = 'missing'
          detailMergeCheckedAt = Date.now()
          return 'missing'
        }
        const st = res.data === true ? 'ready' : 'missing'
        detailMergeState = st
        detailMergeCheckedAt = Date.now()
        return st
      } catch {
        return null
      } finally {
        detailMergeInFlight = null
      }
    })()
  }
  // 確かめられない時は「当たっていない」側（丸ごと送る＝消さない側）
  return (await detailMergeInFlight) === 'ready'
}

/**
 * 事故・ヒヤリハットの追記・修正（rev 照合の部分更新）。current は fetchIncident で読んだ1件（detail を含む）。
 * 送る前に、修正後の値（current と patch を重ねたもの）を検証する（一覧の列だけの行を渡すと detail が空で通らない＝消さない）。
 * 状態を変えた時は closed_at（完了にした日時）を一緒に送る（完了＝いまの日時・対応中に戻す＝null）。
 * detail は、サーバーが「送られたキーだけを前の値に重ねる」移行（0028）を持つ時は変えたキーだけを送る（F29・2026-10-10。
 * 空にした欄は null を明示して送る）。持たない・確かめられない時は current.detail に patch.detail を重ねた全体を送る
 * （jsonb は列ごと置き換わるため）。
 * 氏名の写しは送らない（patch.detail に subject_name があっても無視。サーバーが前の写しを残す／対象者を変えたら写し直す）
 */
export async function updateIncident(
  current: Incident,
  patch: IncidentPatch,
  opts?: WriteOpts,
): Promise<Incident | Conflict | Queued> {
  const { detail: detailPatch, resyncSubjectName, ...cols } = patch
  const base: IncidentInput = {
    kind: current.kind,
    resident_id: current.resident_id,
    occurred_on: current.occurred_on,
    occurred_at: current.occurred_at,
    office: current.office,
    place: current.place,
    place_other: current.place_other,
    types: current.types,
    severity: current.severity,
    status: current.status,
    report_stage: current.report_stage,
    report_no: current.report_no,
    submitted_on: current.submitted_on,
    city_report_needed: current.city_report_needed,
    city_reported_on: current.city_reported_on,
    reporter_id: current.reporter_id,
    confirmer_id: current.confirmer_id,
    confirmed_at: current.confirmed_at,
    closed_at: current.closed_at,
    detail: current.detail,
  }
  const merged = cleanIncident({
    ...base,
    ...cleanPayload(cols as Record<string, unknown>),
    detail: { ...current.detail, ...(detailPatch ?? {}) },
  } as IncidentInput)
  assertIncidentInput(merged)
  const sent: Record<string, unknown> = {}
  for (const k of INCIDENT_FIELDS) {
    if (cols[k] !== undefined) sent[k] = merged[k]
  }
  // 状態を送る時は、完了にした日時を必ず一緒に送る（patch の closed_at は使わない）。
  //   対応中 … null ／ 完了 … 手元の記録も完了で日時があればその日時のまま、無ければいまの日時。
  //   手元の記録が古くても（送信待ちの後など）、状態と日時が DB の check（incidents_closed_at_check）で食い違わないようにする
  if (cols.status !== undefined) {
    sent.closed_at =
      merged.status !== 'closed'
        ? null
        : current.status === 'closed' && current.closed_at !== null
          ? current.closed_at
          : new Date().toISOString()
  }
  // 氏名の写しは送らないので、変更の有無の判定からも外す
  const detailKeys = Object.keys(detailPatch ?? {}).filter((k) => k !== 'subject_name')
  // 対象者を変えた時は detail も送る（氏名の写しを新しい対象者で写し直させるため）
  if (detailKeys.length > 0 || cols.resident_id !== undefined || resyncSubjectName === true) {
    const full = incidentDetailPayload(merged.detail)
    if (await incidentDetailMergeReady()) {
      // 変えたキーだけ（F29）。対象者を変えただけ・写し直しだけの時は空の detail（0028 が前の値に重ね、0014 が氏名を写す）
      const only: Record<string, unknown> = {}
      for (const k of detailKeys) if (Object.prototype.hasOwnProperty.call(full, k)) only[k] = full[k]
      sent.detail = only
    } else {
      sent.detail = full
    }
    // 「名簿の氏名に合わせる」: 印だけを送る（氏名は送らない。トリガが写し直して印を取り除く）
    if (resyncSubjectName === true) (sent.detail as Record<string, unknown>)[RESYNC_SUBJECT_KEY] = true
  }
  return updateRow('incidents', current.id, current.rev, sent, normalizeIncident, opts)
}

/** 事故・ヒヤリハットの取り消し（soft delete。物理削除はしない） */
export async function softDeleteIncident(id: number, rev: number, opts?: WriteOpts): Promise<true | Conflict | Queued> {
  return softDelete('incidents', id, rev, opts)
}

/**
 * この端末（このタブ）の送信待ちに、その記録（recordId）の追記・修正・取り消しが残っているか
 * （送信中を含む。自動再送を止めた＝blocked の op は含めない）。**読むだけで送信待ちは書き換えない**。
 * 画面はこれが true の記録を編集できなくする（入浴・与薬と同じ考え方）
 */
export function hasPendingIncident(recordId: number): boolean {
  for (const q of queue) {
    if (q.table !== 'incidents' || q.blocked !== undefined) continue
    if (q.kind === 'update' && q.rowId === recordId) return true
  }
  return false
}

/** 送信待ちから組み立てた、まだサーバーに載っていない事故・ヒヤリハットの追加（画面の表示用・読むだけ） */
export interface PendingIncident {
  /** 送信待ちの qid（＝client_key） */
  qid: string
  kind: IncidentKind | null
  residentId: number | null
  occurredOn: string | null
  occurredAt: string | null
  types: string[]
  /** waiting＝送信待ち／sending＝送信中／blocked＝自動再送を止めた（止まっている） */
  state: 'waiting' | 'sending' | 'blocked'
}

/**
 * この端末（このタブ）の送信待ちにある事故・ヒヤリハットの追加（未送信・送信中・止まっているものを含む）。
 * **読むだけで送信待ちは書き換えない・破棄しない**。一覧に「未送信」として出し、二重に記録しないようにする
 */
export function pendingIncidentOps(): PendingIncident[] {
  const out: PendingIncident[] = []
  for (const q of queue) {
    if (q.table !== 'incidents' || q.kind !== 'insert') continue
    out.push({
      qid: q.qid,
      kind: oneOf<IncidentKind>(q.payload.kind, INCIDENT_KINDS),
      residentId: idNum(q.payload.resident_id),
      occurredOn: dateStr(q.payload.occurred_on),
      occurredAt: str(q.payload.occurred_at),
      types: normalizeChoices(q.payload.types, INCIDENT_TYPES),
      state: q.blocked !== undefined ? 'blocked' : q.sending === true ? 'sending' : 'waiting',
    })
  }
  return out
}

/** 事故報告書に刷る事業所の情報（app_settings・0014 でキーを空で作る。値はチーフが本番で入れる） */
export interface OfficeProfile {
  corpName: string
  address: string
  officeName: Record<IncidentOffice, string>
  officeNo: Record<IncidentOffice, string>
}

const OFFICE_KEYS = [
  'corp_name',
  'office_name_facility',
  'office_name_visit',
  'office_name_daycare',
  'office_no_facility',
  'office_no_visit',
  'office_no_daycare',
  'office_address',
] as const

/** 事業所の情報を読む（無いキー・空の値は ''＝印刷は手書き用の空欄）。読めない時は例外 */
export async function fetchOfficeProfile(): Promise<OfficeProfile> {
  const sb = await getClient()
  const res = (await sb
    .from('app_settings')
    .select('key,value')
    .in('key', [...OFFICE_KEYS])
    .limit(OFFICE_KEYS.length)) as Res<unknown>
  if (res.error !== null) throw readError(res)
  const got = new Map<string, string>()
  if (Array.isArray(res.data)) {
    for (const raw of res.data) {
      const r = asRecord(raw)
      const key = str(r?.key)
      const value = typeof r?.value === 'string' ? r.value.trim() : ''
      if (key !== null) got.set(key, value)
    }
  }
  const v = (k: (typeof OFFICE_KEYS)[number]): string => got.get(k) ?? ''
  return {
    corpName: v('corp_name'),
    address: v('office_address'),
    officeName: { facility: v('office_name_facility'), visit: v('office_name_visit'), daycare: v('office_name_daycare') },
    officeNo: { facility: v('office_no_facility'), visit: v('office_no_visit'), daycare: v('office_no_daycare') },
  }
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
function markSelfRow(table: string, row: unknown, rev: number | null, ttlMs?: number): void {
  const rec = asRecord(row)
  if (rec === null) return
  const key = selfRowKey(table, rec)
  if (key === null) return
  const now = Date.now()
  for (const [k, v] of selfRows) if (v.exp <= now) selfRows.delete(k)
  const ttl = ttlMs ?? (rev === null ? SELF_ROW_NOREV_TTL_MS : SELF_ROW_TTL_MS)
  const prev = selfRows.get(key)
  // 同じ行を続けて書いた時は新しい版を採る（古い版で上書きしない）
  const next = rev === null || prev === undefined || prev.rev === null ? rev : Math.max(prev.rev, rev)
  selfRows.set(key, { rev: next, exp: now + ttl })
}

// ── 応答待ちの書込の行に届いた変更通知（F10・2026-10-10） ──────────────────────────
//
// 以前は rev 照合の書込（updateRow・updateNow・softDelete・送信待ちの再送・自動の記録の上書き・測定の取り消し）が
// 送る前に「rev+1 は自分が書いた」と覚えていた。競り負けた（他の端末が先に同じ rev+1 を作った）時・通信できず送信待ちへ
// 退避した時も印が残り、その間に届いた他の端末の rev+1 の通知を自分の書込として捨てていた（捨てた通知は再生されない）。
// いまは、応答を待つ間に届いたその行の通知を画面へ渡さずに預かり、応答で版が確定した後（書けた時だけ印を付ける）に
// 渡す。書けなかった（競合・退避・例外）時は印を付けずに渡す＝画面は他の端末の変更として取り直す。
// 応答より先に届いた自分の通知も、印を付けた後に渡るので「他の端末で更新」と取り違えない。

/** 応答を待っている書込の行（行の鍵 → 待っている書込の数） */
const inFlightRows = new Map<string, number>()
/** 応答待ちの行に届いて預かっている変更通知（行の鍵 → 渡す手続き） */
const heldChanges: { key: string; deliver: () => void }[] = []
/** 預かる上限（ms）。応答が返らないままでも、これを過ぎたら渡す（他の端末の変更として取り直す＝安全側） */
const HOLD_MAX_MS = 30_000
const holdTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 預かっていた通知を渡す（受け取る側の例外で他の通知を落とさない） */
function releaseHeld(key: string): void {
  const t = holdTimers.get(key)
  if (t !== undefined) {
    clearTimeout(t)
    holdTimers.delete(key)
  }
  const out: (() => void)[] = []
  for (let i = heldChanges.length - 1; i >= 0; i--) {
    if (heldChanges[i].key !== key) continue
    out.unshift(heldChanges[i].deliver)
    heldChanges.splice(i, 1)
  }
  for (const d of out) {
    try {
      d()
    } catch {
      // 購読側の例外でデータアクセス層を巻き込まない
    }
  }
}

/**
 * 行 id の行への書込を始める（応答を待つ間、その行の変更通知を預かる）。返す関数を応答の後に必ず1回呼ぶ:
 * 書けて版が確定した時は landed にその版（null＝版を持たない印）、書けなかった時は引数なし
 */
function beginRowWrite(table: string, id: number | null | undefined): (landed?: number | null, ttlMs?: number) => void {
  const key = id === null || id === undefined ? null : selfRowKey(table, { id })
  if (key === null) return () => undefined
  inFlightRows.set(key, (inFlightRows.get(key) ?? 0) + 1)
  let done = false
  return (landed, ttlMs) => {
    if (done) return
    done = true
    // 書けた時だけ覚える（競り負け・退避・例外の後に、他の端末の同じ版の通知を自分の書込として捨てない）
    if (landed !== undefined) markSelfRow(table, { id }, landed, ttlMs)
    const n = (inFlightRows.get(key) ?? 1) - 1
    if (n > 0) {
      inFlightRows.set(key, n)
      return
    }
    inFlightRows.delete(key)
    releaseHeld(key)
  }
}

/** 応答待ちの行の通知なら預かる（true）。行を特定できない通知・待っていない行は預からない（すぐ渡す） */
function holdIfInFlight(table: string, info: ChangeInfo, deliver: () => void): boolean {
  if (info.row === null) return false
  const key = selfRowKey(table, info.row)
  if (key === null || !inFlightRows.has(key)) return false
  heldChanges.push({ key, deliver })
  if (!holdTimers.has(key)) {
    const t = setTimeout(() => releaseHeld(key), HOLD_MAX_MS)
    ;(t as unknown as { unref?: () => void }).unref?.()
    holdTimers.set(key, t)
  }
  return true
}

/** Realtime の通知を受け取る側へ渡す（応答待ちの行の通知は預かる＝F10） */
function deliverChange(table: string, payload: unknown, cb: (table: string, info?: ChangeInfo) => void, live: () => boolean): void {
  const info = changeInfoOf(payload)
  const deliver = (): void => {
    if (live()) cb(table, info)
  }
  if (!holdIfInFlight(table, info, deliver)) deliver()
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
  /** 'INSERT' | 'UPDATE' | 'DELETE' | 'RESYNC'（取り出せなければ空文字） */
  event: string
  /** 変更後の行（DELETE・RESYNC と、行を取り出せなかった時は null） */
  row: Record<string, unknown> | null
  /**
   * event='RESYNC'（取り直しの合図・F14）の理由。切れていた間の変更は Realtime が送り直さないので、どの行が変わったか
   * 分からない＝表ごとに row=null で流す（画面は「分からない＝取り直す」側に倒す作りのまま受けられる）。
   *   reconnect … 購読がつながり直した（一度つながった後に切れて、また つながった。Wi-Fi の切替・瞬断・ロック解除）
   *   resume    … 画面に戻った（RESYNC_HIDDEN_MS 以上隠れていた・ページがキャッシュから戻った）
   *   online    … 端末の電波が戻った
   * 案内の帯を出す画面（日報）は、自分の間引きの規則で resume・online を捨ててよい
   */
  resync?: ResyncReason
}

/** 取り直しの合図の理由（F14。ChangeInfo.resync） */
export type ResyncReason = 'reconnect' | 'resume' | 'online'

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

// ── 取り直しの合図（F14・2026-10-10） ─────────────────────────────────────────
// Realtime は切れていた間の postgres_changes を送り直さない（ロック中・Wi-Fi の切替・瞬断）。購読の状態を受け取らずに
// いたため、つながり直しても画面は気づけず、与薬の「未」の列などが手で読み直すまで古いまま残った。
// 購読ごとに状態の移り変わりを見て、つながり直した時に表ごとの RESYNC（row=null）を流す。あわせて、画面に戻った・
// 電波が戻った時も流す（iOS は死んだ WebSocket を開いたまま残すことがあり、心拍の時間切れまで再接続が遅れるため）。

/** 画面に戻った時に取り直す、隠れていた時間の下限（ms）。日報・バイタル・食事の画面の復帰のしきい値と同じ */
const RESYNC_HIDDEN_MS = 30_000

/** 生きている購読ごとの合図の送り口（画面に戻った・電波が戻った時に一斉に流す） */
const resyncEmitters = new Set<(reason: ResyncReason) => void>()

/** 画面が隠れた時刻（隠れていなければ null） */
let hiddenSince: number | null = null

function emitResyncAll(reason: ResyncReason): void {
  for (const emit of [...resyncEmitters]) {
    try {
      emit(reason)
    } catch {
      // 購読側の例外でデータアクセス層を巻き込まない
    }
  }
  // 職員名簿も同じ時に取り直す（F47。開きっぱなしの端末で、マスタ同期の後の名簿が届くように）
  for (const fn of [...rosterResumeHooks]) {
    try {
      fn()
    } catch {
      // 同上
    }
  }
}

/**
 * 端末の出来事（画面の表示・電波）を受けて合図を流す。window のイベントと試験の差し込み口から呼ぶ。
 * hidden→visible は隠れていた時間が RESYNC_HIDDEN_MS 以上の時だけ（短い切替で読み直し・案内を出し続けない）。
 * pageshow はページがキャッシュから戻った時（persisted）だけ呼ぶこと
 */
function onLifecycle(ev: 'hidden' | 'visible' | 'online' | 'pageshow', now = Date.now()): void {
  if (ev === 'hidden') {
    if (hiddenSince === null) hiddenSince = now
    setPresencePageVisible(false) // 画面を隠したら「入力中」を取り消す（F22）
    return
  }
  if (ev === 'visible') {
    const since = hiddenSince
    hiddenSince = null
    setPresencePageVisible(true) // 戻ったら、開いたままの欄を配り直す（F22）
    if (since !== null && now - since >= RESYNC_HIDDEN_MS) emitResyncAll('resume')
    return
  }
  if (ev === 'pageshow') setPresencePageVisible(true)
  emitResyncAll(ev === 'online' ? 'online' : 'resume')
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => onLifecycle('online'))
  window.addEventListener('pageshow', (e) => {
    if ((e as { persisted?: boolean }).persisted === true) onLifecycle('pageshow')
  })
  // ページを離れる・キャッシュへしまわれる時も「入力中」を取り消す（F22。visibilitychange が来ない遷移がある）
  window.addEventListener('pagehide', () => setPresencePageVisible(false))
  document.addEventListener('visibilitychange', () => {
    onLifecycle(document.visibilityState === 'visible' ? 'visible' : 'hidden')
  })
}

/**
 * 購読のチャンネルを参加させ、状態の移り変わりを見る（F14）。一度 SUBSCRIBED になった後に CHANNEL_ERROR・TIMED_OUT・
 * CLOSED を経て再び SUBSCRIBED になった時、そのチャンネルの表ごとに RESYNC を流す。
 * 最初の SUBSCRIBED では流さない（画面は開いた時に読んだばかり＝開くたびに二重に読まない。開いてから参加するまでの
 * 数百 ms に入った変更は拾えない＝既知の隙間）。画面を閉じた後（live()=false）は何も流さない（removeChannel でも
 * CLOSED が届くため）。返す関数を購読の解除で必ず呼ぶ（画面に戻った・電波が戻った時の送り口を外す）
 */
function watchChannel(
  ch: ReturnType<SupabaseClient['channel']>,
  tables: readonly string[],
  cb: (table: string, info?: ChangeInfo) => void,
  live: () => boolean,
): () => void {
  let joined = false
  let lost = false
  const emit = (reason: ResyncReason): void => {
    if (!live()) return
    for (const table of tables) {
      if (!live()) return
      cb(table, { event: 'RESYNC', row: null, resync: reason })
    }
  }
  ch.subscribe((status: string) => {
    if (!live()) return
    if (status === 'SUBSCRIBED') {
      if (joined && lost) emit('reconnect')
      joined = true
      lost = false
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      if (joined) lost = true
    }
  })
  resyncEmitters.add(emit)
  return () => {
    resyncEmitters.delete(emit)
  }
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
  // 画面に戻った・電波が戻った時の合図の送り口（F14）。解除で外す
  let unwatch: (() => void) | null = null

  void (async () => {
    try {
      const sb = await getClient()
      if (cancelled) return
      client = sb
      let ch = sb.channel(`cl_changes_${Math.random().toString(36).slice(2, 10)}`)
      for (const table of REALTIME_TABLES) {
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload: unknown) => {
          // 応答待ちの書込の行の通知は、応答で版が確定するまで預かる（F10）
          if (!cancelled) deliverChange(table, payload, cb, () => !cancelled)
        })
      }
      channel = ch
      // 状態の移り変わりを受け取り、つながり直した時に表ごとの RESYNC を流す（F14）
      unwatch = watchChannel(ch, REALTIME_TABLES, cb, () => !cancelled)
    } catch {
      // 接続先未設定・通信不可。購読なしで動く
    }
  })()

  return () => {
    cancelled = true
    unwatch?.()
    unwatch = null
    if (client !== null && channel !== null) void client.removeChannel(channel)
    channel = null
  }
}

/**
 * 入浴記録の Realtime を購読する表（2026-09-26 追加）。
 * 既存の REALTIME_TABLES のチャンネルには混ぜず、別のチャンネルで購読する。
 * Realtime は「配信対象（publication）に無い表」を1つでも含む購読をチャンネルごと拒否するため、
 * 0012 を当てる前の DB で既存7表の購読まで止まらないようにする（既存画面の同期を変えない）。
 */
const REALTIME_BATH_TABLES = ['bath_records'] as const

/**
 * 入浴記録の変更通知（入浴の画面だけが使う）。呼び方・渡す情報は subscribeChanges と同じ。
 * 接続できない・配信対象に無い（0012 未適用）場合は通知が来ないだけで、画面は手動更新で成立する。
 */
export function subscribeBathChanges(cb: (table: string, info?: ChangeInfo) => void): () => void {
  let cancelled = false
  let client: SupabaseClient | null = null
  let channel: ReturnType<SupabaseClient['channel']> | null = null
  // 画面に戻った・電波が戻った時の合図の送り口（F14）。解除で外す
  let unwatch: (() => void) | null = null

  void (async () => {
    try {
      const sb = await getClient()
      if (cancelled) return
      client = sb
      let ch = sb.channel(`cl_bath_${Math.random().toString(36).slice(2, 10)}`)
      for (const table of REALTIME_BATH_TABLES) {
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload: unknown) => {
          // 応答待ちの書込の行の通知は、応答で版が確定するまで預かる（F10）
          if (!cancelled) deliverChange(table, payload, cb, () => !cancelled)
        })
      }
      channel = ch
      // 状態の移り変わりを受け取り、つながり直した時に表ごとの RESYNC を流す（F14）
      unwatch = watchChannel(ch, REALTIME_BATH_TABLES, cb, () => !cancelled)
    } catch {
      // 接続先未設定・通信不可。購読なしで動く
    }
  })()

  return () => {
    cancelled = true
    unwatch?.()
    unwatch = null
    if (client !== null && channel !== null) void client.removeChannel(channel)
    channel = null
  }
}

/**
 * 与薬チェックの Realtime を購読する表（2026-09-26 追加）。入浴と同じく既存のチャンネルには混ぜない
 * （0013 を当てる前の DB で既存7表・入浴の購読まで止まらないようにする）
 */
const REALTIME_MED_TABLES = ['med_slots', 'med_admin'] as const

/**
 * 服薬の時間帯・与薬の記録の変更通知（与薬の画面だけが使う）。呼び方・渡す情報は subscribeChanges と同じ。
 * 接続できない・配信対象に無い（0013 未適用）場合は通知が来ないだけで、画面は手動更新で成立する。
 */
export function subscribeMedChanges(cb: (table: string, info?: ChangeInfo) => void): () => void {
  let cancelled = false
  let client: SupabaseClient | null = null
  let channel: ReturnType<SupabaseClient['channel']> | null = null
  // 画面に戻った・電波が戻った時の合図の送り口（F14）。解除で外す
  let unwatch: (() => void) | null = null

  void (async () => {
    try {
      const sb = await getClient()
      if (cancelled) return
      client = sb
      let ch = sb.channel(`cl_med_${Math.random().toString(36).slice(2, 10)}`)
      for (const table of REALTIME_MED_TABLES) {
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload: unknown) => {
          // 応答待ちの書込の行の通知は、応答で版が確定するまで預かる（F10）
          if (!cancelled) deliverChange(table, payload, cb, () => !cancelled)
        })
      }
      channel = ch
      // 状態の移り変わりを受け取り、つながり直した時に表ごとの RESYNC を流す（F14）
      unwatch = watchChannel(ch, REALTIME_MED_TABLES, cb, () => !cancelled)
    } catch {
      // 接続先未設定・通信不可。購読なしで動く
    }
  })()

  return () => {
    cancelled = true
    unwatch?.()
    unwatch = null
    if (client !== null && channel !== null) void client.removeChannel(channel)
    channel = null
  }
}

/**
 * 事故・ヒヤリハットの Realtime を購読する表（2026-09-26 追加）。入浴・与薬と同じく既存のチャンネルには混ぜない
 * （0014 を当てる前の DB で既存7表・入浴・与薬の購読まで止まらないようにする）
 */
const REALTIME_INCIDENT_TABLES = ['incidents'] as const

/**
 * 事故・ヒヤリハットの変更通知（事故・ヒヤリハットの画面だけが使う）。呼び方・渡す情報は subscribeChanges と同じ。
 * 接続できない・配信対象に無い（0014 未適用）場合は通知が来ないだけで、画面は手動更新で成立する。
 */
export function subscribeIncidentChanges(cb: (table: string, info?: ChangeInfo) => void): () => void {
  let cancelled = false
  let client: SupabaseClient | null = null
  let channel: ReturnType<SupabaseClient['channel']> | null = null
  // 画面に戻った・電波が戻った時の合図の送り口（F14）。解除で外す
  let unwatch: (() => void) | null = null

  void (async () => {
    try {
      const sb = await getClient()
      if (cancelled) return
      client = sb
      let ch = sb.channel(`cl_incident_${Math.random().toString(36).slice(2, 10)}`)
      for (const table of REALTIME_INCIDENT_TABLES) {
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload: unknown) => {
          // 応答待ちの書込の行の通知は、応答で版が確定するまで預かる（F10）
          if (!cancelled) deliverChange(table, payload, cb, () => !cancelled)
        })
      }
      channel = ch
      // 状態の移り変わりを受け取り、つながり直した時に表ごとの RESYNC を流す（F14）
      unwatch = watchChannel(ch, REALTIME_INCIDENT_TABLES, cb, () => !cancelled)
    } catch {
      // 接続先未設定・通信不可。購読なしで動く
    }
  })()

  return () => {
    cancelled = true
    unwatch?.()
    unwatch = null
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
 * ★2026-09-23 拡張（欄単位の「入力中」表示・docs/design/concurrent-entry.md §8）: 同じチャンネルで、
 *   バイタル・食事のどの欄を入力中か（表と列名・区分・種別・行 id）と、最後に配り直した時刻 at を足して配る。
 *   職員を選んでいない端末も staffId=null で参加する（旧版は staffId が数値でない要素を捨てるので、
 *   旧版の画面には出ないだけで壊れない）。入力中の値は配らない。
 */
// 型と受け取った値の正規化は src/lib/presence.ts（純関数・テスト対象）。画面はここから import する
export type { PresenceCell, PresenceHere } from './presence'

/**
 * 受け取った要素の at を見直す間隔（sync が来なくても、古くなった要素を消すため）。
 * 自分の at の配り直し（PRESENCE_HEARTBEAT_MS）もこの刻みで確かめる＝配り直しは 60〜75 秒ごと
 */
const PRESENCE_TICK_MS = 15_000
/** 同じ名前のチャンネルが閉じ終わるのを待つ上限（画面の切替直後。realtime-js は閉じるまで同じ実体を返す） */
const PRESENCE_WAIT_CLOSE_MS = 5_000

/**
 * いまページが隠れているか（F22・2026-10-10）。隠れている間は自分の居場所を配らない（untrack）。
 * 以前は画面を隠しても（ロック・別のアプリへ切替）取り消しを送らず、配り直しも止めなかったため、
 * 裏に回した端末の「入力中」が相手の画面に出続けた。起動時はページの表示状態から決める（window の無い試験では見えている）
 */
let presencePageHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
/** 参加中の Presence ごとの、表示状態の受け口 */
const presenceVisibilityHooks = new Set<() => void>()
/** private チャンネルへの参加を断られたことを、この起動中に console へ残したか（F25。画面ごとに繰り返し出さない） */
let presenceJoinWarned = false

/** ページの表示状態が変わった（onLifecycle・pagehide から呼ぶ）。参加中の Presence へ知らせる */
function setPresencePageVisible(visible: boolean): void {
  if (presencePageHidden === !visible) return
  presencePageHidden = !visible
  for (const fn of [...presenceVisibilityHooks]) {
    try {
      fn()
    } catch {
      // 表示の補助の失敗で画面を止めない
    }
  }
}

/**
 * 居場所を配り、他の端末の居場所を受け取る（Presence・チャンネル PRESENCE_TOPIC）。
 * - self が null の間は配らずに受け取るだけ（バイタル・食事の画面で、どの欄にも入っていない時）。
 *   update(null) で配るのをやめる（untrack）
 * - 配っている間は PRESENCE_HEARTBEAT_MS ごとに at を付け直して配り直す（打鍵ごとには配らない）
 * - ページが隠れている間は配らない（隠れた時に untrack。居場所は持ったままにし、見えたら配り直す・F22）
 * - 受け取った要素は正規化し、古いもの（受け手が初めて見てから PRESENCE_STALE_MS 超・F24）と自分の鍵を除いて
 *   onChange へ渡す。sync が来なくても PRESENCE_TICK_MS ごとに見直す（切断を検知できなかった端末の残骸を消す）
 * - 接続できない・Realtime が使えない時は、何も渡さず（誰も居ない扱い）例外も出さない
 * 戻り値の stop で抜ける（画面を離れる時に必ず呼ぶ）。
 */
export function joinPresence(
  self: PresenceHere | null,
  onChange: (others: PresenceHere[]) => void,
): { update: (next: PresenceHere | null) => void; stop: () => void } {
  let cancelled = false
  let client: SupabaseClient | null = null
  let channel: ReturnType<SupabaseClient['channel']> | null = null
  let joined = false
  let current: PresenceHere | null = self
  let trackedAt = 0
  let last: PresenceHere[] = []
  let tick: ReturnType<typeof setInterval> | null = null
  // 鍵は参加ごとに別（同じ職員が別の端末・別のタブで開いていても、自分の分だけを除ける）
  const key = `s${self?.staffId ?? 'x'}-${Math.random().toString(36).slice(2, 8)}`
  /**
   * 受け取った要素を初めて見た時刻（受け手の時計・F24）。古さを送り手の時計（at）で測ると、時計が遅れている端末の
   * 「入力中」が毎回捨てられ、進んでいる端末の残骸は消えなかった。配り直すたびに at（と presence_ref）が変わるので、
   * 生きている端末の要素は常に「最近初めて見た」ものになる（★配り直しのたびに at を付け直す push の作りに依存する）
   */
  const seen: PresenceSeen = new Map()

  const emit = (ch: ReturnType<SupabaseClient['channel']>) => {
    if (cancelled) return
    try {
      const next = othersFromState(ch.presenceState(), key, Date.now(), seen)
      if (samePresence(next, last)) return
      last = next
      onChange(next)
    } catch {
      // 受け取った値が読めない。表示しないだけで画面は続ける
    }
  }

  const push = () => {
    const ch = channel
    if (ch === null || cancelled || !joined) return
    const cur = current
    // 居場所が無い・ページが隠れている間は配らない（隠れている間も居場所は持ったまま＝見えたら配り直す）
    if (cur === null || presencePageHidden) {
      trackedAt = 0
      void ch.untrack().catch(() => {})
      return
    }
    trackedAt = Date.now()
    void ch.track(presenceMeta(cur, trackedAt)).catch(() => {})
  }

  // ページを隠した → 配っていれば取り消す。見えた → 居場所があれば配り直す（F22）
  const onVisibility = () => {
    if (cancelled) return
    if (presencePageHidden ? trackedAt !== 0 : current !== null) push()
  }
  presenceVisibilityHooks.add(onVisibility)

  void (async () => {
    try {
      const sb = await getClient()
      if (cancelled) return
      // 直前の画面が同じチャンネルを閉じている最中なら、閉じ終わるまで待つ
      // （閉じる前に channel() を呼ぶと閉じかけの実体が返り、受け口を足せずに参加できない）
      const topic = `realtime:${PRESENCE_TOPIC}`
      const waitUntil = Date.now() + PRESENCE_WAIT_CLOSE_MS
      const open = () => (typeof sb.getChannels === 'function' ? sb.getChannels() : [])
      while (open().some((c) => c.topic === topic)) {
        if (Date.now() > waitUntil) return // 閉じない。誰も居ない扱いで画面は成立する
        await new Promise((r) => setTimeout(r, 100))
        if (cancelled) return
      }
      client = sb
      // private チャンネル（F25・2026-10-10）: 参加・受信・送信を Realtime 認可（realtime.messages の RLS・0029）で
      // 許可リストの職員だけに限る（公開のままだと、公開の anon キーだけで職員ID・利用者ID・入力中の欄を読め、偽の「入力中」を
      // 流せた）。0029 が当たっていない・Realtime 設定で使えない時は参加を断られるだけで、保存・画面は止めない
      // （居場所は表示の補助。公開チャンネルへは戻さない＝穴を開け直さない）
      const ch = sb.channel(PRESENCE_TOPIC, { config: { private: true, presence: { key } } })
      ch.on('presence', { event: 'sync' }, () => emit(ch))
      channel = ch
      ch.subscribe((status: string) => {
        if (cancelled) return
        if (status !== 'SUBSCRIBED') {
          // 断られた・切れた（CHANNEL_ERROR・TIMED_OUT）: 誰も居ない扱いのまま。後から点検できるよう起動中に1回だけ残す
          if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !presenceJoinWarned) {
            presenceJoinWarned = true
            console.warn(`[care-log] 入力中の表示（Presence）に参加できませんでした（${status}）。保存には影響しません。`)
          }
          return
        }
        joined = true
        push()
      })
      tick = setInterval(() => {
        if (cancelled || !joined) return
        emit(ch)
        // 隠れている間は配り直さない（F22。隠れた時に取り消した後、心拍で配り直してしまわない）
        if (current !== null && !presencePageHidden && Date.now() - trackedAt >= PRESENCE_HEARTBEAT_MS) push()
      }, PRESENCE_TICK_MS)
    } catch {
      // 接続できない。誰も居ない扱いで画面は成立する
    }
  })()

  return {
    update: (next: PresenceHere | null) => {
      current = next
      push()
    },
    stop: () => {
      cancelled = true
      presenceVisibilityHooks.delete(onVisibility)
      seen.clear()
      if (tick !== null) clearInterval(tick)
      tick = null
      if (client !== null && channel !== null) {
        const ch = channel
        void ch.untrack().catch(() => {})
        void client.removeChannel(ch).catch(() => {})
      }
      channel = null
    },
  }
}

/**
 * 申し送りを書いている人の居場所を配り、他の人の居場所を受け取る。
 * 受け取るのは申し送りの居場所だけ（バイタル・食事の欄を入力中の要素は除く）。
 * 実体は joinPresence（同じチャンネル）。戻り値の update で自分の居場所を更新し、
 * 戻り値の stop で抜ける（画面を離れる時に必ず呼ぶ）。
 * self・update に null を渡している間は配らない（受け取るだけ）。書いていない端末が
 * 「書いています」と出続けないよう、書き始めるまでは null にする（2026-09-23）
 */
export function joinNotePresence(
  self: PresenceHere | null,
  onChange: (others: PresenceHere[]) => void,
): { update: (next: PresenceHere | null) => void; stop: () => void } {
  const p = joinPresence(self, (others) => onChange(notePresence(others)))
  return { update: (next: PresenceHere | null) => p.update(next), stop: p.stop }
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
  managerTaken:
    'この日の施設長は、ほかの端末で別の職員が選ばれています。「最新に更新」を押して、いまの施設長を確かめてから選び直してください。',
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
  // anon で読んだ0件を「記録なし」の日報として出さない（F58）
  await assertSessionIfEmpty(sb, notes.length + vitals.length + attendance.length)

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
  // anon で読んだ0件を「記録なし」の日報として出さない（F58）
  await assertSessionIfEmpty(sb, notes.length + vitals.length + (Array.isArray(attendanceRes.data) ? attendanceRes.data.length : 0))

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
  // 記録者の既定が無い端末（共用端末の通常の状態）でも人数は数える。自分が読んだか（my_read）だけは分からない（F66）
  if (notes.length === 0) return
  // URL 長対策で READ_LOOKUP_ROWS 件ずつに分けて引く（10日まとめ取りでは1回で引ける件数を超え、新しい方の約140件が
  // 「既読 0人」になっていた・F66）
  const chunks: Note[][] = []
  for (let i = 0; i < notes.length; i += READ_LOOKUP_ROWS) chunks.push(notes.slice(i, i + READ_LOOKUP_ROWS))
  await Promise.all(chunks.map((c) => attachReadChunk(sb, c, staffId)))
}

/**
 * attachReadState の1回分（ids は READ_LOOKUP_ROWS 件以内）。既読の行が取得上限（MAX_ROWS）に届いた＝読み切れていない
 * （どの行が切れたかは決まらない）時は、半分に分けて引き直す。1件でも届くなら、その申し送りの人数は付けない（断定しない）
 */
async function attachReadChunk(sb: SupabaseClient, notes: Note[], staffId: number | null): Promise<void> {
  const ids = notes.map((n) => n.id)
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
  if (res.data.length >= MAX_ROWS) {
    if (notes.length <= 1) return
    const half = Math.ceil(notes.length / 2)
    await Promise.all([attachReadChunk(sb, notes.slice(0, half), staffId), attachReadChunk(sb, notes.slice(half), staffId)])
    return
  }
  const counts = new Map<number, number>()
  const mine = new Set<number>()
  for (const row of res.data) {
    const r = asRecord(row)
    const noteId = idNum(r?.note_id)
    if (noteId === null) continue
    counts.set(noteId, (counts.get(noteId) ?? 0) + 1)
    if (staffId !== null && idNum(r?.staff_id) === staffId) mine.add(noteId)
  }
  for (const n of notes) {
    n.read_count = counts.get(n.id) ?? 0
    if (staffId !== null) n.my_read = mine.has(n.id)
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
  const rows = list(res.data, normalizeVital)
  await assertSessionIfEmpty(sb, rows.length) // anon で読んだ0件を「記録なし」と出さない（F58）
  return rows
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
  const meals = list(mealsRes.data, normalizeMeal, MEALS_SHEET_ROWS)
  const fluids = expandFluidDays(fluidsRes.data)
  await assertSessionIfEmpty(sb, meals.length + fluids.length) // anon で読んだ0件を「記録なし」と出さない（F58）
  return { meals, fluids }
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
  options: { baseline: number[]; roles?: Record<number, 'manager' | 'staff'> },
): Promise<void | Queued> {
  assertDay(dayIso)
  await assertWritable()
  const sb = await getClient()
  const baseline = options?.baseline ?? []
  const roles = attendanceRolesOf(options?.roles)
  try {
    await applyAttendance(sb, dayIso, rows, baseline, roles)
  } catch (e) {
    // 1件も書けていない通信失敗・認証切れだけ退避する（書けた後は partial のまま throw）
    if (e instanceof DbError && !e.partial && (e.kind === 'network' || e.kind === 'auth')) {
      return enqueue({
        table: 'attendance',
        kind: 'attendance',
        // roles（見ていた役割・F70）は任意。旧版はこのキーを読まない（役割を従来どおり書く）
        payload: { day: dayIso, rows, baseline, ...(roles !== null ? { roles: Object.fromEntries(roles) } : {}) },
      })
    }
    throw e
  }
}

/** 見ていた役割（{職員ID: 'manager'|'staff'}）を読む。無い・読めなければ null（＝役割の基準が分からない） */
function attendanceRolesOf(v: unknown): Map<number, Attendance['role']> | null {
  const r = asRecord(v)
  if (r === null) return null
  const out = new Map<number, Attendance['role']>()
  for (const [k, role] of Object.entries(r)) {
    const id = idNum(k)
    const ro = oneOf(role, ATTENDANCE_ROLES)
    if (id !== null && ro !== null) out.set(id, ro)
  }
  return out
}

/** 施設長は1日1人の索引（0026）に当たった 23505 か（F70） */
function isManagerTaken(res: Res<unknown>): boolean {
  if (!isUniqueViolation(res)) return false
  const text = `${res.error?.message ?? ''} ${res.error?.details ?? ''}`
  return text.includes('uq_attendance_manager_day')
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
  /**
   * 画面が見ていた役割（F70・2026-10-10）。null＝分からない（旧版の送信待ち）＝役割は従来どおり書く。
   * 分かる時は、この端末が変えていない役割（見ていた役割のまま送ってきた）を、他の端末が変えていれば書き戻さない
   * （古い一覧の保存で、他の端末が選んだ施設長を職員へ戻さない）。並び（sort）は従来どおり後勝ち
   */
  baselineRoles: Map<number, Attendance['role']> | null = null,
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
      continue
    }
    // この端末が変えていない役割（見ていた役割のまま）を、他の端末が変えていた → サーバーの役割を残す（F70）
    const seenRole = baselineRoles?.get(staffId)
    let role = seenRole !== undefined && seenRole === want.role && cur.role !== want.role ? cur.role : want.role
    // この端末の画面に出ていなかった職員（見ていた役割に無い）を、いま施設長の行から職員へ下げない（F70 手直し・2026-10-10）。
    // 古い画面のままの端末が出勤者のピッカーから足した・圏外で積んだ同じ操作の再送で、他の端末が選んだ施設長が黙って
    // 職員へ戻り、施設長の欄が空になった（0026 の索引は施設長が0人になる書き換えを止めない）。この端末はその職員の
    // 役割を見ていない＝変えるつもりが無いので、サーバーの役割を残す。見ていた役割が分からない旧い送信待ち（null）は従来どおり
    if (baselineRoles !== null && seenRole === undefined && cur.sort >= 0 && cur.role === 'manager' && want.role !== 'manager') {
      role = cur.role
    }
    if (cur.role !== role || cur.sort !== want.sort) {
      // 取り消し済み（sort < 0）の行もここで復活する
      toUpdate.push({ day: dayIso, staff_id: staffId, role, sort: want.sort })
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

  /** 施設長の索引（0026）に当たった失敗を、書けた分があるかで投げ分ける（F70。施設長は他の端末で選ばれている） */
  const failWith = (res: Res<unknown>): DbError => {
    if (isManagerTaken(res)) return new DbError('server', SHEET_MSG.managerTaken, wrote)
    return wrote ? partialWriteError() : writeError(res)
  }
  const updateOne = async (row: Attendance): Promise<void> => {
    const res = await bounded(
      sb.from('attendance').update({ role: row.role, sort: row.sort }).eq('day', dayIso).eq('staff_id', row.staff_id).select('staff_id').maybeSingle(),
    )
    if (res.error !== null) throw failWith(res)
    wrote = true
  }
  const hideRows = async (ids: number[]): Promise<void> => {
    if (ids.length === 0) return
    const res = await bounded(
      sb.from('attendance').update({ sort: ATTENDANCE_HIDDEN_SORT }).eq('day', dayIso).in('staff_id', ids).select('staff_id'),
    )
    if (res.error !== null) throw failWith(res)
    wrote = true
  }

  // 0. 施設長を手放す行（施設長→職員・施設長を外す）を先に書く（F70・0026: 施設長は1日1人の索引があるので、入れ替えは
  //    「前の施設長を外す→新しい施設長を入れる」の順でないと通らない）。手放さない行は従来どおりの順（残る側へ倒す）
  const isManager = (id: number): boolean => {
    const cur = existing.get(id)
    return cur !== undefined && cur.role === 'manager' && cur.sort >= 0
  }
  const releaseUpdates = toUpdate.filter((r) => isManager(r.staff_id) && r.role !== 'manager')
  const releaseHides = toHide.filter(isManager)
  for (const row of releaseUpdates) await updateOne(row)
  await hideRows(releaseHides)
  // 1. 追加（不足分だけ）
  if (toInsert.length > 0) {
    try {
      await insertAttendanceRows(sb, dayIso, toInsert) // 途中失敗は内部で partial を投げ分ける
    } catch (e) {
      // 施設長の索引に当たった時、手放す行を先に書いていれば一部だけ載った（画面を巻き戻さない）
      if (e instanceof DbError && e.message === SHEET_MSG.managerTaken && wrote && !e.partial) {
        throw new DbError('server', SHEET_MSG.managerTaken, true)
      }
      if (e instanceof DbError && wrote && !e.partial) throw partialWriteError()
      throw e
    }
    wrote = true
  }
  // 2. 役割・並び順の変更（1行ずつ。主キーで1行だけを狙う）
  for (const row of toUpdate) if (!releaseUpdates.includes(row)) await updateOne(row)
  // 3. 一覧から外れた人を非表示にする（行は消さない＝再登録で戻せる）
  await hideRows(toHide.filter((id) => !releaseHides.includes(id)))
}

/** その日の出勤者行（取り消し済み＝sort < 0 も含む）。置き換えの差分計算に使う */
async function fetchAttendanceRows(
  sb: SupabaseClient,
  dayIso: string,
): Promise<Map<number, Attendance>> {
  const res = await bounded(
    sb.from('attendance').select(ATTENDANCE_COLS).eq('day', dayIso).order('staff_id', { ascending: true }).limit(MAX_ROWS),
  )
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
  const res = await bounded(sb.from('attendance').insert(rows).select('staff_id'))
  if (res.error === null) return
  // 施設長は1日1人の索引（0026）に当たった＝他の端末が別の施設長を選んでいる（F70）。主キーの競走とは別の案内
  if (isManagerTaken(res)) throw new DbError('server', SHEET_MSG.managerTaken)
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
    const up = await bounded(
      sb.from('attendance').update({ role: row.role, sort: row.sort }).eq('day', dayIso).eq('staff_id', row.staff_id).select('staff_id').maybeSingle(),
    )
    if (up.error !== null) {
      if (isManagerTaken(up)) throw new DbError('server', SHEET_MSG.managerTaken, wrote)
      throw wrote ? partialWriteError() : writeError(up)
    }
    wrote = true
  }
  if (missing.length === 0) return
  const retry = await bounded(sb.from('attendance').insert(missing).select('staff_id'))
  if (retry.error === null) return
  if (isManagerTaken(retry)) throw new DbError('server', SHEET_MSG.managerTaken, wrote)
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
  table: 'vitals' | 'meals' | 'notes',
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
  const rid = p.residentId === null || p.residentId === undefined ? null : idNum(p.residentId)
  if (p.residentId !== null && p.residentId !== undefined && rid === null) throw new DbError('server', MSG.broken)
  const run = async (withOldRow: boolean): Promise<Res<unknown>> => {
    let q = sb
      .from('record_history')
      .select(HISTORY_COLS)
      .gte('record_day', p.fromIso)
      .lte('record_day', p.toIso)
    if (p.residentId === null) q = q.is('resident_id', null)
    else if (rid !== null) {
      // 対象を付け替えた記録（申し送りの対象を別の方へ直した等）も、元の利用者の側から辿れるよう、
      // 変更前の行（old_row）の resident_id でも引く（2026-09-29・H4。0017 の索引 idx_record_history_old_resident）
      q = withOldRow ? q.or(`resident_id.eq.${rid},old_row->>resident_id.eq.${rid}`) : q.eq('resident_id', rid)
    }
    return (await q
      .order('record_day', { ascending: false })
      .order('changed_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(cap)) as Res<unknown>
  }
  let res = await run(true)
  // old_row の条件を受け付けないサーバー（PostgREST の構文の食い違い＝PGRST100 等の 400）では、従来の条件で引き直す
  // （変更の記録の欄そのものを失敗させない）
  if (res.error !== null && rid !== null && res.status === 400 && !isMissingTable(res)) res = await run(false)
  if (res.error !== null) {
    if (isMissingTable(res)) return { available: false }
    throw readError(res)
  }
  return { available: true, entries: list(res.data, normalizeHistory, cap) }
}

/** 申し送り1件の変更の記録の上限（1件の申し送りがこれを超えて書き換えられる運用は無い想定） */
const NOTE_HISTORY_ROWS = 200

/**
 * 申し送り1件の変更の記録（新しい変更が先・2026-09-29・H4）。table_name='notes' と行 id で引く
 * （idx_record_history_row）。全体連絡（利用者なし）の申し送りも同じ。表が無い時は { available: false }
 */
export async function fetchNoteHistory(noteId: number): Promise<RecordHistoryResult> {
  const id = idNum(noteId)
  if (id === null) throw new DbError('server', MSG.broken)
  const sb = await getClient()
  const res = (await sb
    .from('record_history')
    .select(HISTORY_COLS)
    .eq('table_name', 'notes')
    .eq('row_id', id)
    .order('changed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(NOTE_HISTORY_ROWS)) as Res<unknown>
  if (res.error !== null) {
    if (isMissingTable(res)) return { available: false }
    throw readError(res)
  }
  return { available: true, entries: list(res.data, normalizeHistory, NOTE_HISTORY_ROWS) }
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

/**
 * 端末に残せていない申し送りがあるか（保存領域が一杯などで送信待ちを書き戻せず、このタブのメモリにだけある・L7-2）。
 * このままタブを閉じると消えるので、画面は事実どおりに知らせ、離れる前の確認に数える
 */
export function hasUnpersistedNotes(): boolean {
  if (queuePersisted) return false
  if (queue.some((o) => o.table === 'notes')) return true
  for (const e of cellRows.values()) if (e.table === 'notes') return true
  return false
}

/**
 * 端末に残せていない送信待ちがあるか（全ての表。F01・2026-10-10）。保存領域が一杯（同じオリジンの他のアプリと共有）で
 * 送信待ちを書き戻せず、このタブのメモリにだけある＝閉じる・再読み込み・iOS の自動終了で消える。
 * 'queued' を受けた画面は、これが true の間は「電波が戻ると自動で送信します」と案内せず（MSG_NOT_PERSISTED）、
 * 入力を送ったものとして消さない。離れる前の確認（leaveGuard の 'input'）とヘッダの未送信表示にも使う
 */
export function hasUnpersistedQueue(): boolean {
  if (queuePersisted) return false
  return queue.length > 0 || cellRows.size > 0
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
   * kinds は種類ごとの入力解禁（既定は native と同じく解禁を観測済み。false＝封鎖を観測済み／
   * null＝未観測で、書く前に app_settings へ問い合わせる）。native は native_input_enabled の観測値（既定 true。
   * null＝未観測＝取得に失敗した時の画面を再現する）
   */
  /** 古い版の確かめ（F28③）で比べるこの端末の版を差し替える（null＝焼き込んだ版に戻す。node の試験の版は 'dev'） */
  setClientBuild(b: BuildStamp | null): void {
    buildForGate = b ?? undefined
  },
  /** 申し送りの登録の応答待ちの上限（ms）を変える（既定 20 秒・L7-1） */
  setNoteInsertTimeout(ms: number): void {
    noteInsertTimeoutMs = ms
  },
  /** 送信の経路の1要求の応答待ちの上限（ms）を変える（既定 25 秒・F04。restartQueue で既定へ戻る） */
  setSendTimeout(ms: number): void {
    sendReqTimeoutMs = ms
  },
  setClient(
    sb: SupabaseClient | null,
    opts?: {
      cellRpc?: 'ready' | 'missing' | null
      noteRpc?: 'ready' | 'missing' | null
      kinds?: Partial<Record<InputKind, boolean | null>>
      native?: boolean | null
      /**
       * 古い版の確かめ（min_client_build・F28③）を済ませた扱いにするか（既定 true＝確かめ済み・古くない。
       * false＝未確認で、次の入力解禁の確認・書込で app_settings の min_client_build を問い合わせる）
       */
      buildChecked?: boolean
    },
  ): void {
    testClient = sb
    memberDenied = false
    // 事故の detail の重ね（0028）の確かめは、差し替えのたびに未確認へ戻す（次の追記で incidents_detail_merge_ready を呼ぶ）
    detailMergeState = null
    detailMergeCheckedAt = 0
    detailMergeInFlight = null
    buildOutdated = false
    buildGateInFlight = null
    buildGateFetchedAt = sb !== null && opts?.buildChecked !== false ? Date.now() : 0
    const native = sb === null ? null : opts?.native === undefined ? true : opts.native
    gateValue = native
    gateFetchedAt = native === null ? 0 : Date.now()
    kindGates = newKindGates()
    if (sb !== null) {
      for (const k of Object.keys(kindGates) as InputKind[]) {
        const v = opts?.kinds?.[k] === undefined ? true : (opts.kinds[k] ?? null)
        kindGates[k].value = v
        kindGates[k].fetchedAt = v === null ? 0 : Date.now()
      }
    }
    // 差し替えは「別の起動」とみなし、起動単位の状態（操作者・edited_by 列が無い印）を初期化する
    editorId = null
    editedByUnsupported = false
    const state = opts?.cellRpc === undefined ? 'ready' : opts.cellRpc
    cellRpcState = sb === null ? null : state
    cellRpcCheckedAt = sb === null || state === null ? 0 : Date.now()
    // 0017（申し送りの apply_note_edits）の有無も同じ既定（観測済みで使える）
    const nstate = opts?.noteRpc === undefined ? 'ready' : opts.noteRpc
    noteRpcState = sb === null ? null : nstate
    noteRpcCheckedAt = sb === null || nstate === null ? 0 : Date.now()
  },
  /** 「次の起動」を再現する: メモリ上のキュー・送信待ちを捨て、localStorage から読み直す（起動時の読み替えも行う） */
  async restartQueue(): Promise<void> {
    queue = []
    cellRows = new Map()
    doneMarks = []
    sentQids.clear()
    conflictRechecked.clear()
    hiddenSince = null
    firstSentNote.clear()
    noteInsertTimeoutMs = 20_000
    sendReqTimeoutMs = 25_000
    inFlightRows.clear()
    heldChanges.length = 0
    selfRows.clear()
    cellOutcomes.clear()
    pendingFlush = null
    flushTail = Promise.resolve()
    // 起動のやり直し＝別のタブになる（前のタブの生存の印は手放し、新しい印を持つ・F03 手直し）
    releaseTabLock?.()
    releaseTabLock = null
    tabId = newTabId()
    holdTabLock()
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
  /** このタブを閉じた状態を再現する（生存の Web Lock を手放す・F03 手直し。メモリの中身はそのまま＝以後は何もしない前提） */
  closeTab(): void {
    releaseTabLock?.()
    releaseTabLock = null
  },
  /** このタブの印（別タブの書き込みを再現する時に使う） */
  tabId(): string {
    return tabId
  },
  /** 画面に戻った時の送信（visibilitychange と同じ。F06） */
  async visibleFlush(): Promise<void> {
    await scheduleFlush(false, 0, true)
  },
  /**
   * 端末の出来事（画面が隠れた・戻った・電波が戻った・ページがキャッシュから戻った）を起こす（F14。window の無い Node で
   * visibilitychange・online・pageshow の代わり）。now は出来事の時刻（省くと今）
   */
  lifecycle(ev: 'hidden' | 'visible' | 'online' | 'pageshow', now?: number): void {
    onLifecycle(ev, now)
  },
  /** ログインの出来事（SIGNED_IN・TOKEN_REFRESHED）を起こす（F37。本物のクライアントの onAuthStateChange と同じ処理） */
  async authEvent(event: string): Promise<void> {
    await onAuthEvent(event)
  },
}
