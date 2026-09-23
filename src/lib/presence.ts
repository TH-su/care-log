// いま誰がどこを入力しているか（Presence）の純関数。
// 設計: docs/design/concurrent-entry.md §8（欄単位の「入力中」表示）
//
// - 通信・DOM・React に触れない（tests/logic.test.mjs から直接読み込んで確かめる）
// - 配る中身は「職員ID・日付・利用者ID・表と列名（＋食事の区分・バイタルの種別・行 id）・時刻」だけ。
//   入力中の値・氏名・本文は配らない（受け取った側が自分の職員名簿で名前を引く）
// - 旧版アプリ（staffId が数値でない要素を捨て、{ staffId, day, residentId } だけを読む）と
//   同じチャンネルで混在しても壊れない形にする（足すのは任意の cell と at だけ）
// - 表示は補助であり、保存を妨げない（ロックしない）。記録の保全はサーバー側の欄ごとの判定が担う

import type { MealSlot, VitalKind } from './types'

/** Presence のチャンネル名（申し送りの居場所と同じチャンネルを使う＝重複実装しない） */
export const PRESENCE_TOPIC = 'cl_note_presence'
/** 受け取った要素の at がこれより古ければ捨てる（切断を検知できなかった端末の残骸対策） */
export const PRESENCE_STALE_MS = 3 * 60_000
/** 配っている間、at を配り直す間隔（打鍵ごとには配らない） */
export const PRESENCE_HEARTBEAT_MS = 60_000
/** 欄を離れてから取り消すまでの待ち（欄の移動で表示をちらつかせない） */
export const PRESENCE_RELEASE_MS = 1_500
/**
 * 押すだけで終わる入力（食事一括の量・状態のボタン）で、最後に操作してから取り消すまでの待ち。
 * タッチ端末ではボタンに触れた後に blur が起きないことがあるため、操作のたびに延ばし、無くなったら取り消す
 */
export const PRESENCE_TOUCH_HOLD_MS = 20_000

export type PresenceTable = 'vitals' | 'meals'

/** 書き込める列（db.ts の VitalCellField・MealCellField と同じ並び。未知の列名は受け取らない） */
const VITAL_FIELDS = ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2', 'measured_at', 'note', 'symptom'] as const
const MEAL_FIELDS = ['main_amount', 'side_amount', 'status', 'note'] as const
const MEAL_SLOTS: readonly MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack']
const VITAL_KINDS: readonly VitalKind[] = ['routine', 'recheck', 'observation', 'symptom']

/**
 * 入力中の欄。
 * - slot … 食事の区分（食事は必須。自然キーの一部）
 * - kind … バイタルの種別（省略は定時）
 * - id   … 定時以外のバイタルで、既にある行の id（1名1日に複数行あるため）。まだ行が無い枠は省略
 */
export interface PresenceCell {
  table: PresenceTable
  field: string
  slot?: MealSlot
  kind?: VitalKind
  id?: number
}

/** 1端末ぶんの居場所（配る形・受け取って正規化した形の両方） */
export interface PresenceHere {
  /** 職員ID。null＝記録する職員を選んでいない端末（表示は「別の端末」） */
  staffId: number | null
  /** 開いている日（YYYY-MM-DD） */
  day: string
  /** 対象の利用者ID。null＝対象を選んでいない／全体宛 */
  residentId: number | null
  /** 入力中の欄。無い＝申し送りの居場所（旧版と同じ意味） */
  cell?: PresenceCell
  /** 最後に配り直した時刻（ISO）。旧版の要素には無い */
  at?: string
}

/** 画面の欄を指す形（照合キーを作る元） */
export interface CellTarget {
  table: PresenceTable
  day: string
  residentId: number
  field: string
  slot?: MealSlot
  kind?: VitalKind
  id?: number | null
}

// ── 受け取った値の正規化 ─────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** 正の整数だけを ID として読む（数字の文字列も受ける。db.ts の idNum と同じ規則） */
function idNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

function dateStr(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null
}

/** 欄の正規化。未知の表・列・区分は null（＝その要素ごと捨てる。誤った欄に印を付けない） */
function normalizeCell(v: unknown): PresenceCell | null {
  const r = asRecord(v)
  if (r === null) return null
  const table = oneOf(r.table, ['vitals', 'meals'] as const)
  if (table === null) return null
  if (table === 'meals') {
    const field = oneOf(r.field, MEAL_FIELDS)
    const slot = oneOf(r.slot, MEAL_SLOTS)
    if (field === null || slot === null) return null
    return { table, field, slot }
  }
  const field = oneOf(r.field, VITAL_FIELDS)
  if (field === null) return null
  // 種別は省略なら定時。値があって読めない時は壊れた要素として捨てる
  const kind = r.kind === undefined || r.kind === null ? 'routine' : oneOf(r.kind, VITAL_KINDS)
  if (kind === null) return null
  const cell: PresenceCell = { table, field, kind }
  if (kind !== 'routine') {
    if (r.id !== undefined && r.id !== null) {
      const id = idNum(r.id)
      if (id === null) return null
      cell.id = id
    }
  }
  return cell
}

/**
 * 受け取った Presence の1要素を正規化する。読めない要素・古い要素は null（表示しない）。
 * - staffId: 無い／null は「職員を選んでいない端末」。値があって読めない時は壊れた要素として捨てる
 * - cell: 無ければ申し送りの居場所（旧形式）。あって読めない時は捨てる。cell があるのに利用者が無い時も捨てる
 * - at: 無ければ旧版の要素として受ける。あって読めない・PRESENCE_STALE_MS より古い時は捨てる
 *   （相手の時計が進んでいる＝未来の時刻は、時計のずれとして受ける）
 */
export function normalizePresence(row: unknown, now: number): PresenceHere | null {
  const r = asRecord(row)
  if (r === null) return null
  let staffId: number | null = null
  if (r.staffId !== undefined && r.staffId !== null) {
    staffId = idNum(r.staffId)
    if (staffId === null) return null
  }
  const day = dateStr(r.day)
  if (day === null) return null
  const residentId = idNum(r.residentId)
  const out: PresenceHere = { staffId, day, residentId }
  if (r.cell !== undefined && r.cell !== null) {
    const cell = normalizeCell(r.cell)
    if (cell === null || residentId === null) return null
    out.cell = cell
  }
  if (r.at !== undefined && r.at !== null) {
    if (typeof r.at !== 'string') return null
    const t = Date.parse(r.at)
    if (!Number.isFinite(t)) return null
    if (now - t > PRESENCE_STALE_MS) return null
    out.at = r.at
  }
  return out
}

/**
 * チャンネルの presenceState（鍵 → meta の並び）から「自分以外」を取り出す。
 * 自分の鍵（この端末・このタブの参加）だけを除く＝同じ職員が別の端末で開いている分は出す。
 * 1つの鍵に meta が複数ある時は先頭を使う（旧版と同じ読み方）。
 */
export function othersFromState(state: unknown, selfKey: string, now: number): PresenceHere[] {
  const s = asRecord(state)
  if (s === null) return []
  const out: PresenceHere[] = []
  for (const [k, metas] of Object.entries(s)) {
    if (k === selfKey) continue
    const first = Array.isArray(metas) ? metas[0] : null
    const p = normalizePresence(first, now)
    if (p !== null) out.push(p)
  }
  return out
}

/** 申し送りの居場所だけ（欄を入力中の要素を除く）。申し送りの「いま書いています」表示に使う */
export function notePresence(list: PresenceHere[]): PresenceHere[] {
  return list.filter((p) => p.cell === undefined)
}

/** その日を開いている要素だけ（申し送りフォームで、開いている日の「書いています」だけを出す） */
export function presenceOnDay(list: PresenceHere[], day: string): PresenceHere[] {
  return list.filter((p) => p.day === day)
}

/**
 * いま入っている欄を1つだけ持つ入れ物。入るたびに印（token）を返し、離れる時はその印で外す。
 * 外すのは「入った時の印」がまだ今の印の時だけ＝入った後に欄の形が変わっても（再検の欄に行 id が付く等）
 * 外し損ねず、別の欄へ移った後に古い欄の「離れた」が届いても新しい欄を外さない
 */
export function createFocusSlot<T>() {
  let cur: { value: T; token: number } | null = null
  let seq = 0
  return {
    enter(value: T): number {
      seq += 1
      cur = { value, token: seq }
      return seq
    },
    /** 印の欄がまだ今の欄か */
    isCurrent(token: number): boolean {
      return cur !== null && cur.token === token
    },
    /** 印の欄がまだ今の欄なら外して true（それ以外は何もしないで false） */
    leave(token: number): boolean {
      if (cur === null || cur.token !== token) return false
      cur = null
      return true
    },
    /** 今の欄（無ければ null） */
    current(): T | null {
      return cur === null ? null : cur.value
    },
    /** 全部外す（画面を離れる時） */
    clear(): void {
      cur = null
    },
  }
}

/** 配る meta を作る（at を今の時刻で付ける）。欄が無ければ cell を載せない（旧版と同じ形） */
export function presenceMeta(
  self: { staffId: number | null; day: string; residentId: number | null; cell?: PresenceCell },
  now: number,
): PresenceHere {
  const meta: PresenceHere = { staffId: self.staffId, day: self.day, residentId: self.residentId }
  if (self.cell) meta.cell = { ...self.cell }
  meta.at = new Date(now).toISOString()
  return meta
}

// ── 欄との照合 ───────────────────────────────────────────────

/**
 * 欄を照合するキー。
 * - 食事: 表|日|利用者|列|区分
 * - 定時のバイタル: 表|日|利用者|列|routine（自然キーで1行に決まる）
 * - 定時以外のバイタル: 表|日|利用者|列|種別#行id（まだ行が無い枠は #new）
 */
export function cellKey(t: CellTarget): string {
  if (t.table === 'meals') return `meals|${t.day}|${t.residentId}|${t.field}|${t.slot ?? ''}`
  const kind = t.kind ?? 'routine'
  const row = kind === 'routine' ? '' : `#${t.id != null ? t.id : 'new'}`
  return `vitals|${t.day}|${t.residentId}|${t.field}|${kind}${row}`
}

/** 行（利用者）単位の照合キー。欄が画面外でも行見出しで気づけるように使う */
export function rowKey(table: PresenceTable, day: string, residentId: number): string {
  return `${table}|${day}|${residentId}`
}

/** 受け取った要素の欄のキー（欄が無ければ null） */
export function presenceCellKey(p: PresenceHere): string | null {
  if (!p.cell || p.residentId === null) return null
  return cellKey({ ...p.cell, day: p.day, residentId: p.residentId })
}

export interface PresenceIndex {
  byCell: Map<string, PresenceHere[]>
  byRow: Map<string, PresenceHere[]>
}

/** 欄・行ごとに引けるようにまとめる（描画のたびに全件をなめない） */
export function indexPresence(list: PresenceHere[]): PresenceIndex {
  const byCell = new Map<string, PresenceHere[]>()
  const byRow = new Map<string, PresenceHere[]>()
  const push = (m: Map<string, PresenceHere[]>, k: string, p: PresenceHere) => {
    const cur = m.get(k)
    if (cur) cur.push(p)
    else m.set(k, [p])
  }
  for (const p of list) {
    const ck = presenceCellKey(p)
    if (ck === null || !p.cell || p.residentId === null) continue
    push(byCell, ck, p)
    push(byRow, rowKey(p.cell.table, p.day, p.residentId), p)
  }
  return { byCell, byRow }
}

/** 欄（複数の列をまとめて描く欄＝日報の血圧などは列を並べて渡す）に当たる要素 */
export function presenceForCell(ix: PresenceIndex, targets: CellTarget[]): PresenceHere[] {
  const out: PresenceHere[] = []
  for (const t of targets) for (const p of ix.byCell.get(cellKey(t)) ?? []) if (!out.includes(p)) out.push(p)
  return out
}

/**
 * 行（利用者）に当たる要素。days は画面に出している日（複数日の一覧は全部）。
 * kinds を渡すと、その種別のバイタルだけ（その画面に出ていない種別＝日報の画面での定時など、では行に印を付けない）
 */
export function presenceForRow(
  ix: PresenceIndex,
  table: PresenceTable,
  days: string[],
  residentId: number,
  kinds?: readonly VitalKind[],
): PresenceHere[] {
  const out: PresenceHere[] = []
  for (const d of days) {
    for (const p of ix.byRow.get(rowKey(table, d, residentId)) ?? []) {
      if (kinds && table === 'vitals' && !kinds.includes(p.cell?.kind ?? 'routine')) continue
      if (!out.includes(p)) out.push(p)
    }
  }
  return out
}

// ── 表示の文字 ───────────────────────────────────────────────

/** 名前を引けない職員の表示（名簿に無い・名簿を読めない） */
export const PRESENCE_UNKNOWN_STAFF = '他の職員'
/** 職員を選んでいない端末の表示 */
export const PRESENCE_NO_STAFF = '別の端末'

/** 1要素の「誰」。職員未選択は「別の端末」、名簿に無ければ「他の職員」 */
export function presenceWho(p: PresenceHere, nameOf: (staffId: number) => string | null): string {
  if (p.staffId === null) return PRESENCE_NO_STAFF
  const n = nameOf(p.staffId)
  return n !== null && n !== '' ? n : PRESENCE_UNKNOWN_STAFF
}

/**
 * 「誰」の並び。同じ職員は1つにまとめ（2台で開いていても1回）、職員を選んでいない端末は
 * 台数でまとめる（1台＝「別の端末」、2台以上＝「別の端末（2台）」）。並びは最初に現れた順。
 * unknown: 名簿で引けない職員の表示。null を渡すとその職員は並びに入れない（呼び出し側が「他 n 名」等で補う）
 */
export function presenceWhoNames(
  list: PresenceHere[],
  nameOf: (staffId: number) => string | null,
  unknown: string | null = PRESENCE_UNKNOWN_STAFF,
): string[] {
  const out: string[] = []
  let noStaff = 0
  let noStaffAt = -1
  for (const p of list) {
    if (p.staffId === null) {
      if (noStaff === 0) {
        noStaffAt = out.length
        out.push(PRESENCE_NO_STAFF)
      }
      noStaff += 1
      continue
    }
    const n = nameOf(p.staffId)
    const w = n !== null && n !== '' ? n : unknown
    if (w !== null && !out.includes(w)) out.push(w)
  }
  if (noStaff > 1) out[noStaffAt] = `${PRESENCE_NO_STAFF}（${noStaff}台）`
  return out
}

/** 同じ人を二度出さない（同じ職員が2台で開いていても名前は1回・職員未選択は台数でまとめる） */
function whoList(list: PresenceHere[], nameOf: (staffId: number) => string | null): string[] {
  return presenceWhoNames(list, nameOf)
}

export interface BusyText {
  /** 欄に出す短い文字（例「職員B 入力中」「別の端末で入力中」） */
  label: string
  /** 読み上げの文（例「職員Bが入力中です」） */
  speech: string
}

/** 欄のラベル。当たる要素が無ければ null（何も出さない） */
export function cellBusyText(list: PresenceHere[], nameOf: (staffId: number) => string | null): BusyText | null {
  if (list.length === 0) return null
  const who = whoList(list, nameOf)
  if (who.length === 1 && who[0].startsWith(PRESENCE_NO_STAFF)) {
    return { label: `${who[0]}で入力中`, speech: `${who[0]}で入力中です` }
  }
  const joined = who.join('・')
  return { label: `${joined} 入力中`, speech: `${joined}が入力中です` }
}

/** 行見出しのラベル（例「入力中: 職員B」）。当たる要素が無ければ null */
export function rowBusyText(list: PresenceHere[], nameOf: (staffId: number) => string | null): string | null {
  if (list.length === 0) return null
  return `入力中: ${whoList(list, nameOf).join('・')}`
}

/** 要約に載せる1件（誰が・どこを） */
export interface SummaryEntry {
  p: PresenceHere
  /** どこを（例「利用者01 体温」）。画面が作る */
  what: string
}

/**
 * 表の上の一行に出す要約（例「入力中: 職員B（利用者01 体温）・別の端末（利用者03 昼 主食）」）。
 * - 同じ職員の欄はその職員の括弧の中にまとめる。職員を選んでいない端末は1つにまとめ、2台以上は「2台・」を添える
 * - 同じ「誰」が同じ欄にいる重複（同じ職員が2台で同じ欄など）は1件にまとめる
 * - 最大 max 件まで出し、残りは「ほか n 件」。1件も無ければ null
 * 先頭の「✎」は描く側が付ける（読み上げに記号を読ませない）
 */
export function presenceSummaryText(
  entries: SummaryEntry[],
  nameOf: (staffId: number) => string | null,
  max = 3,
): string | null {
  interface Group {
    who: string
    whats: string[]
    devices: number
    noStaff: boolean
  }
  const groups = new Map<string, Group>()
  for (const { p, what } of entries) {
    const key = p.staffId === null ? 'x' : `s${p.staffId}`
    let g = groups.get(key)
    if (!g) {
      const n = p.staffId === null ? null : nameOf(p.staffId)
      g = {
        who: p.staffId === null ? PRESENCE_NO_STAFF : n !== null && n !== '' ? n : PRESENCE_UNKNOWN_STAFF,
        whats: [],
        devices: 0,
        noStaff: p.staffId === null,
      }
      groups.set(key, g)
    }
    g.devices += 1
    if (!g.whats.includes(what)) g.whats.push(what)
  }
  const total = [...groups.values()].reduce((n, g) => n + g.whats.length, 0)
  if (total === 0) return null
  let left = max
  const parts: string[] = []
  for (const g of groups.values()) {
    if (left <= 0) break
    const shown = g.whats.slice(0, left)
    left -= shown.length
    const devices = g.noStaff && g.devices > 1 ? `${g.devices}台・` : ''
    parts.push(`${g.who}（${devices}${shown.join('、')}）`)
  }
  const rest = total - Math.min(total, max)
  return `入力中: ${parts.join('・')}${rest > 0 ? ` ほか ${rest} 件` : ''}`
}

/** 2つの一覧が同じ中身か（受け取るたびに画面を描き直さないための比較） */
export function samePresence(a: PresenceHere[], b: PresenceHere[]): boolean {
  if (a.length !== b.length) return false
  // at は配り直しのたびに変わるだけなので比べない（古い要素は正規化の時点で落ちている）
  const strip = (list: PresenceHere[]) => JSON.stringify(list.map(({ at: _at, ...rest }) => rest))
  return strip(a) === strip(b)
}
