// 同時入力の「食い違い」の判定と表示用の文字（純関数・副作用なし）。
//
// 用語（この画面群で共通）:
//   base   … あなたが入力を始めた時に見ていたサーバーの値（新規なら全部 空）
//   mine   … あなたが**実際に編集した**列だけ（列 → あなたの値）。競合した時点で控え、
//            以後は利用者が編集した時だけ増える。読み直しても増えない（base との差分から推定しない。
//            推定すると、読み直しで描き直した「相手が変えた値」まで自分の入力に数えてしまう＝
//            2026-09-23 レビュー指摘 H1）
//   latest … いまのサーバーの値（読み直した・くらべる画面を開いた時点）
//
// 食い違い = あなたが変えた列で、サーバー側も base から変わっていて、しかもあなたの値とも違う列。
//   他端末が触っていない列（latest = base）は食い違いではない（あなたの編集をそのまま載せてよい）。
//   他端末が同じ値にしていた列（latest = mine）も食い違いではない（もう載っている）。
//
// 規約（5画面共通・2026-09-23）: 競合状態の行は、くらべて選ぶ画面で3択のどれかを選ぶまで
//   通常の確定では保存しない（holdsNormalSave）。「最新を読み込む」を押しても、食い違う列が
//   残っていれば競合のまま。食い違いが無くなった列だけ通常に戻す（src/lib/rowSync.ts の reconcileOnLoad）。
//
// 拡張子付きで import する（actor.ts と同じ。tests/logic.test.mjs から直接読めるようにするため）

import { MEAL_STATUS_LABEL } from './types.ts'
import type { MealStatus, Staff } from './types.ts'

type Cells<F extends string> = Partial<Record<F, unknown>>

const TIME_RE = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/

/** 'HH:MM' / 'H:MM' / 'HH:MM:SS' → '9:05'（時刻として読めなければ null） */
function timeKey(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = TIME_RE.exec(v.trim())
  return m ? `${Number(m[1])}:${m[2]}` : null
}

function has<F extends string>(o: Cells<F>, f: F): boolean {
  return Object.prototype.hasOwnProperty.call(o, f) && o[f] !== undefined
}

/**
 * 同じ値か。null・undefined・空文字は「空」として同じに扱い、
 * 数値は数値として比べる（numeric 列が文字列 '36.5' で返っても 36.5 と同じ）。
 */
export function sameValue(a: unknown, b: unknown): boolean {
  const ea = a === undefined || a === null || a === ''
  const eb = b === undefined || b === null || b === ''
  if (ea || eb) return ea && eb
  // 時刻は時・分で比べる（DB は '09:05:00'、入力は '9:05' のように書き方が違う）
  const ta = timeKey(a)
  const tb = timeKey(b)
  if (ta !== null && tb !== null) return ta === tb
  const na = typeof a === 'number' ? a : typeof a === 'string' ? Number(a) : Number.NaN
  const nb = typeof b === 'number' ? b : typeof b === 'string' ? Number(b) : Number.NaN
  if ((typeof a === 'number' || typeof b === 'number') && Number.isFinite(na) && Number.isFinite(nb)) {
    return na === nb
  }
  return String(a) === String(b)
}

/** 文字の欄（数値や時刻に変換して比べない＝'07' と '7' は別の記録。送信キューの規約 I8・L4） */
export const TEXT_FIELDS: ReadonlySet<string> = new Set(['note', 'symptom', 'body', 'status'])

/** 1つの組として判定する欄（血圧の上と下。片方だけ食い違っても組ごと競合にする＝I8・L5） */
export const PAIRED_FIELDS: readonly (readonly [string, string])[] = [['sys_bp', 'dia_bp']]

/** 欄ごとの「同じ値か」。文字の欄は文字列として比べ、それ以外は sameValue（数値・時刻として比べる） */
export function sameField(field: string, a: unknown, b: unknown): boolean {
  if (!TEXT_FIELDS.has(field)) return sameValue(a, b)
  const ea = a === undefined || a === null || a === ''
  const eb = b === undefined || b === null || b === ''
  if (ea || eb) return ea && eb
  return String(a) === String(b)
}

/** 組の欄の相方（無ければ null） */
export function pairOf(field: string): string | null {
  for (const [a, b] of PAIRED_FIELDS) {
    if (field === a) return b
    if (field === b) return a
  }
  return null
}

export interface ConflictColumn<F extends string> {
  field: F
  /** 先に入っている値（いまのサーバーの値） */
  theirs: unknown
  /** あなたの入力 */
  mine: unknown
}

/** 食い違っている列（fields の並び順） */
export function conflictColumns<F extends string>(
  fields: readonly F[],
  base: Cells<F>,
  mine: Cells<F>,
  latest: Cells<F>,
): ConflictColumn<F>[] {
  const out: ConflictColumn<F>[] = []
  for (const f of fields) {
    if (!has(mine, f)) continue
    const theirs = latest[f] ?? null
    if (sameField(f, theirs, base[f])) continue // 他端末はこの列を触っていない
    if (sameField(f, theirs, mine[f])) continue // もう同じ値が載っている
    out.push({ field: f, theirs, mine: mine[f] ?? null })
  }
  // 血圧の上と下は1つの組: 片方が食い違えば、自分の入力のある相方も並べる（組のまま選ぶ）
  for (const f of fields) {
    if (!has(mine, f) || out.some((c) => c.field === f)) continue
    const other = pairOf(f)
    if (other === null || !out.some((c) => c.field === other)) continue
    const theirs = latest[f] ?? null
    if (sameField(f, theirs, mine[f])) continue
    out.push({ field: f, theirs, mine: mine[f] ?? null })
  }
  return out.sort((a, b) => fields.indexOf(a.field) - fields.indexOf(b.field))
}

/**
 * 〔自分の値で直す〕で送る列。あなたが変えた列のうち、いまのサーバーの値と違うものだけ
 * （食い違った列＋他端末が触っていない自分の編集。同じ値の列は送らない＝rev を無駄に進めない）。
 */
export function patchForMine<F extends string>(
  fields: readonly F[],
  mine: Cells<F>,
  latest: Cells<F>,
): Cells<F> {
  const out: Cells<F> = {}
  for (const f of fields) {
    if (!has(mine, f)) continue
    if (!sameField(f, latest[f], mine[f])) out[f] = mine[f] ?? null
  }
  return out
}

/**
 * 〔自分の値で直す〕で送る欄を、血圧の組でそろえる（第3段 #3）。上下の片方だけが patch にある時は、相方も
 * 「あなたの組」の値で加える（あなたの入力にあればその値、無ければ見ていた値＝seen）。基準は呼び出し側が取り直した
 * 最新の組にする。片方だけを送ると、その間に相方を他の端末が変えていた時に誰も測っていない組ができる
 */
export function withBpPair(
  patch: Record<string, unknown>,
  mine: Record<string, unknown>,
  seen: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...patch }
  for (const [a, b] of PAIRED_FIELDS) {
    for (const [f, o] of [
      [a, b],
      [b, a],
    ] as const) {
      if (!Object.prototype.hasOwnProperty.call(out, f) || Object.prototype.hasOwnProperty.call(out, o)) continue
      out[o] = Object.prototype.hasOwnProperty.call(mine, o) ? mine[o] : (seen[o] ?? null)
    }
  }
  return out
}

/** 競合状態の行は、くらべて選ぶで選ぶまで通常の確定で保存しない（5画面共通の規約） */
export function holdsNormalSave(state: string | null | undefined): boolean {
  return state === 'conflict'
}

/**
 * 〔両方残す〕で新しい行に書く値。あなたが実際に編集した列のうち、値のあるものだけ
 * （測っていない値・相手の値を新しい行に作り出さない）。
 */
export function valuesForBoth<F extends string>(fields: readonly F[], mine: Cells<F>): Cells<F> {
  const out: Cells<F> = {}
  for (const f of fields) {
    const v = mine[f]
    if (v === undefined || v === null || v === '') continue
    out[f] = v
  }
  return out
}

// ── 表示用の文字 ─────────────────────────────────────────────

export type VitalField = 'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2'
export type MealField = 'main_amount' | 'side_amount' | 'status'

export const VITAL_FIELDS: readonly VitalField[] = ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2']
export const MEAL_FIELDS: readonly MealField[] = ['main_amount', 'side_amount', 'status']

export const VITAL_FIELD_NAME: Record<VitalField, string> = {
  temp: '体温',
  sys_bp: '血圧（上）',
  dia_bp: '血圧（下）',
  pulse: '脈拍',
  spo2: 'SpO2',
}
export const MEAL_FIELD_NAME: Record<MealField, string> = {
  main_amount: '主食',
  side_amount: '副食',
  status: '食事の状態',
}

function finite(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/** バイタルの値（単位つき）。空は「未入力」 */
export function fmtVitalValue(field: VitalField, v: unknown): string {
  const n = finite(v)
  if (n === null) return '未入力'
  if (field === 'temp') return `${n.toFixed(1)}℃`
  if (field === 'spo2') return `${Math.round(n)}%`
  if (field === 'pulse') return `${Math.round(n)}回/分`
  return `${Math.round(n)}mmHg`
}

/** 食事の値（主食・副食は「◯割」、状態はラベル）。空は「未入力」 */
export function fmtMealValue(field: MealField, v: unknown): string {
  if (field === 'status') {
    if (typeof v !== 'string' || v === '') return '未入力'
    return MEAL_STATUS_LABEL[v as MealStatus] ?? v
  }
  const n = finite(v)
  return n === null ? '未入力' : `${Math.round(n)}割`
}

/**
 * 先に入っている値の記入者。edited_by（最後に書き換えた人）→ recorded_by（作った人）の順に
 * 名簿から名前を引く。どちらも引けなければ「記入者不明」。
 */
export function recorderName(
  editedBy: number | null | undefined,
  recordedBy: number | null | undefined,
  staff: readonly Staff[] | null | undefined,
): string {
  const list = Array.isArray(staff) ? staff : []
  for (const id of [editedBy, recordedBy]) {
    if (typeof id !== 'number') continue
    const hit = list.find((s) => s != null && s.id === id)
    if (hit && typeof hit.name === 'string' && hit.name !== '') return hit.name
  }
  return '記入者不明'
}

/** 時刻（'09:05:00' → '9:05'）。空は「未入力」 */
export function fmtTimeValue(v: unknown): string {
  return timeKey(v) ?? '未入力'
}

/**
 * 食い違っているバイタルの列を1文にする（「血圧（上）（先の値 120mmHg／あなたの入力 130mmHg）」）。
 * 競合の一言に併記する。入力を止めた旨の一言と並べても、この併記は消さない
 */
export function vitalConflictDetail(columns: ConflictColumn<VitalField>[]): string {
  return columns
    .map(
      (c) =>
        `${VITAL_FIELD_NAME[c.field]}（先の値 ${fmtVitalValue(c.field, c.theirs)}／あなたの入力 ${fmtVitalValue(c.field, c.mine)}）`,
    )
    .join('・')
}

/**
 * 止まった食事の行に出す一言（「主食（先の値 8割／あなたの入力 5割）」）。
 * 止まっている間もサーバーの最新値を「先の値」として見せる（あなたの入力だけを見せて上書きさせない）。
 * あなたの入力が無い列・先の値と同じ列は出さない
 */
export function mealHeldText(
  mine: Partial<Record<MealField, unknown>>,
  latest: Partial<Record<MealField, unknown>>,
): string {
  return MEAL_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(mine, f) && mine[f] !== undefined)
    .filter((f) => !sameValue(mine[f], latest[f]))
    .map(
      (f) =>
        `${MEAL_FIELD_NAME[f]}（先の値 ${fmtMealValue(f, latest[f] ?? null)}／あなたの入力 ${fmtMealValue(f, mine[f])}）`,
    )
    .join('・')
}

/** 'YYYY-MM-DDTHH:MM…' → '9/1 10:05'（端末の時刻で表示）。読めなければ空文字 */
export function fmtStamp(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || iso === '') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 食事の〔両方残す〕で note に書き足す文を作る（既存の文字は消さず、改行して1行足す）。
 * 例: 「別の記入: 主食 5割・副食 6割・喫食（記入者名）」。
 * 書き足す値が1つも無ければ null（＝書き足さない）。
 */
export function appendAltMealNote(
  existing: string | null | undefined,
  entry: { main_amount?: number | null; side_amount?: number | null; status?: MealStatus | null },
  recorder: string | null | undefined,
): string | null {
  const parts: string[] = []
  if (finite(entry.main_amount) !== null) parts.push(`主食 ${fmtMealValue('main_amount', entry.main_amount)}`)
  if (finite(entry.side_amount) !== null) parts.push(`副食 ${fmtMealValue('side_amount', entry.side_amount)}`)
  const status: unknown = entry.status
  if (typeof status === 'string' && status !== '') parts.push(fmtMealValue('status', status))
  if (parts.length === 0) return null
  const who = typeof recorder === 'string' && recorder.trim() !== '' ? recorder.trim() : '記入者不明'
  const line = `別の記入: ${parts.join('・')}（${who}）`
  const prev = typeof existing === 'string' ? existing : ''
  return prev === '' ? line : `${prev}\n${line}`
}

/**
 * 入力を止める理由文（5画面共通）: サーバーに欄ごとの保存の仕組み（0011 apply_cell_edits）がまだ無い
 * （入力解禁の確認 getNativeInputGate の cells が 'missing'）。閲覧はできる
 */
export const CELLS_PENDING_REASON =
  'サーバー側の更新待ちのため、いまはバイタル・食事を入力できません（閲覧はできます）。管理者に連絡してください。'

/**
 * 相手の行が他の端末で取り消されていた時の一言（保存の応答の reason:'missing'）。
 * 日報の「行が無い控え」と同じ見せ方（値を並べ、〔新しい行として保存〕〔取り下げる〕を出す）
 */
export function missingRowText(values: string): string {
  return `この記録は他の端末で取り消されました。あなたの入力（${values || '値なし'}）はまだ保存していません。「新しい行として保存」で残すか、「取り下げる」を押してください。`
}

/** 「あなたの入力（血圧（上） 130mmHg・脈拍 70回/分）」の中身。値が無い列は「空にする」 */
export function describeMine(
  items: { name: string; value: string }[],
): string {
  return items.map((i) => `${i.name} ${i.value === '未入力' ? '（空にする）' : i.value}`).join('・')
}
