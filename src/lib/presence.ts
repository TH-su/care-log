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
/**
 * 操作が無いまま、これだけ経ったら「入力中」「書いています」を配るのをやめる（F22・F21・2026-10-10 本人回答: 3分）。
 * 欄を開いたまま席を外した端末の「入力中」が、相手の画面に出続けないため。欄（居場所）そのものは持ったままにし、
 * 次に操作した時に配り直す（入力の値・開いたキーパッドは消さない）
 */
export const PRESENCE_IDLE_MS = 3 * 60_000

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
 * - opts.firstSeen（受け手がこの要素を初めて見た時刻・F24）を渡した時は、古さを at ではなく受け手の時計で測る
 *   （now - firstSeen が PRESENCE_STALE_MS を超えたら捨てる）。at は形だけ確かめる＝送り手の時計のずれに左右されない
 */
export function normalizePresence(row: unknown, now: number, opts: { firstSeen?: number } = {}): PresenceHere | null {
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
    const age = opts.firstSeen !== undefined ? now - opts.firstSeen : now - t
    if (age > PRESENCE_STALE_MS) return null
    out.at = r.at
  }
  return out
}

/**
 * 受け手の側で控える「その要素を初めて見た時刻」（F24）。鍵は `参加の鍵|presence_ref|at`。
 * joinPresence が参加ごとに1つ持ち、othersFromState に渡す（消えた要素の控えは othersFromState が消す）
 */
export type PresenceSeen = Map<string, number>

/**
 * チャンネルの presenceState（鍵 → meta の並び）から「自分以外」を取り出す。
 * 自分の鍵（この端末・このタブの参加）だけを除く＝同じ職員が別の端末で開いている分は出す。
 * 1つの鍵に meta が複数ある時（再接続の直後に、古い接続の meta が片付くまで残る）は、読めるものの中で
 * at が最も新しいものを1つだけ採る（F23・2026-10-10。at の無い旧版の要素は at のある要素に負ける。並びは
 * サーバーが返す順で決まり、先頭が古い欄のことがあるため、以前の「先頭を使う」では古い欄を出し・入力中を消していた）。
 * 同じ鍵の meta は同じ端末・同じタブが出したもの＝同じ時計なので、at の比べ方に時計のずれは効かない。
 * seen（F24）を渡すと、at のある要素の古さを受け手が初めて見た時刻で測る（送り手の時計に左右されない）
 */
export function othersFromState(state: unknown, selfKey: string, now: number, seen?: PresenceSeen): PresenceHere[] {
  const s = asRecord(state)
  if (s === null) return []
  const out: PresenceHere[] = []
  const live = new Set<string>()
  for (const [k, metas] of Object.entries(s)) {
    if (k === selfKey) continue
    if (!Array.isArray(metas)) continue
    let best: PresenceHere | null = null
    let bestAt = -Infinity
    for (const m of metas) {
      let firstSeen: number | undefined
      if (seen !== undefined) {
        const r = asRecord(m)
        if (r !== null && typeof r.at === 'string') {
          const ref = typeof r.presence_ref === 'string' ? r.presence_ref : ''
          const id = `${k}|${ref}|${r.at}`
          live.add(id)
          const was = seen.get(id)
          // 受け手の時計が戻った（was が未来）時は、今を初めて見た時刻にし直す
          firstSeen = was !== undefined && was <= now ? was : now
          if (firstSeen !== was) seen.set(id, firstSeen)
        }
      }
      const p = normalizePresence(m, now, firstSeen !== undefined ? { firstSeen } : {})
      if (p === null) continue
      const t = p.at !== undefined ? Date.parse(p.at) : -Infinity
      // 同じ新しさなら先に並んでいる方（旧版と同じ読み方）
      if (best === null || t > bestAt) {
        best = p
        bestAt = t
      }
    }
    if (best !== null) out.push(best)
  }
  // 消えた要素の控えは捨てる（控えが増え続けない）
  if (seen !== undefined) for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id)
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
/**
 * 受け手と同じ職員（この端末の記録者と同じ職員ID）の別の端末・別のタブの表示（F26・2026-10-10 本人回答）。
 * 他の職員の入力と見分けて、「自分の別の端末に開きっぱなしの入力がある」と気づけるようにする
 */
export const PRESENCE_SELF_OTHER = 'あなたの別の端末'

/**
 * 1要素の「誰」。職員未選択は「別の端末」、名簿に無ければ「他の職員」。
 * selfStaffId（受け手の記録者）と同じ職員なら「あなたの別の端末」（null なら出し分けない）
 */
export function presenceWho(
  p: PresenceHere,
  nameOf: (staffId: number) => string | null,
  selfStaffId: number | null = null,
): string {
  if (p.staffId === null) return PRESENCE_NO_STAFF
  if (selfStaffId !== null && p.staffId === selfStaffId) return PRESENCE_SELF_OTHER
  const n = nameOf(p.staffId)
  return n !== null && n !== '' ? n : PRESENCE_UNKNOWN_STAFF
}

/**
 * 「誰」の並び。同じ職員は1つにまとめ（2台で開いていても1回）、職員を選んでいない端末は
 * 台数でまとめる（1台＝「別の端末」、2台以上＝「別の端末（2台）」）。並びは最初に現れた順。
 * unknown: 名簿で引けない職員の表示。null を渡すとその職員は並びに入れない（呼び出し側が「他 n 名」等で補う）
 * selfStaffId: 受け手の記録者。同じ職員の要素は名前の代わりに「あなたの別の端末」（F26。省略・null は従来どおり）
 */
export function presenceWhoNames(
  list: PresenceHere[],
  nameOf: (staffId: number) => string | null,
  unknown: string | null = PRESENCE_UNKNOWN_STAFF,
  selfStaffId: number | null = null,
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
    if (selfStaffId !== null && p.staffId === selfStaffId) {
      if (!out.includes(PRESENCE_SELF_OTHER)) out.push(PRESENCE_SELF_OTHER)
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
function whoList(
  list: PresenceHere[],
  nameOf: (staffId: number) => string | null,
  selfStaffId: number | null,
): string[] {
  return presenceWhoNames(list, nameOf, PRESENCE_UNKNOWN_STAFF, selfStaffId)
}

export interface BusyText {
  /** 欄に出す短い文字（例「職員B 入力中」「別の端末で入力中」） */
  label: string
  /** 読み上げの文（例「職員Bが入力中です」） */
  speech: string
}

/**
 * 欄のラベル。当たる要素が無ければ null（何も出さない）。
 * selfStaffId（受け手の記録者）と同じ職員の要素は「あなたの別の端末で入力中」（F26。省略・null は従来どおり）
 */
export function cellBusyText(
  list: PresenceHere[],
  nameOf: (staffId: number) => string | null,
  selfStaffId: number | null = null,
): BusyText | null {
  if (list.length === 0) return null
  const who = whoList(list, nameOf, selfStaffId)
  if (who.length === 1 && (who[0].startsWith(PRESENCE_NO_STAFF) || who[0] === PRESENCE_SELF_OTHER)) {
    return { label: `${who[0]}で入力中`, speech: `${who[0]}で入力中です` }
  }
  const joined = who.join('・')
  return { label: `${joined} 入力中`, speech: `${joined}が入力中です` }
}

/** 行見出しのラベル（例「入力中: 職員B」）。当たる要素が無ければ null。selfStaffId は cellBusyText と同じ */
export function rowBusyText(
  list: PresenceHere[],
  nameOf: (staffId: number) => string | null,
  selfStaffId: number | null = null,
): string | null {
  if (list.length === 0) return null
  return `入力中: ${whoList(list, nameOf, selfStaffId).join('・')}`
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
 * - selfStaffId（受け手の記録者）と同じ職員の欄は「あなたの別の端末（…）」にまとめる（F26。省略・null は従来どおり）。
 *   2台以上なら職員を選んでいない端末と同じく台数を添える
 * 先頭の「✎」は描く側が付ける（読み上げに記号を読ませない）
 */
export function presenceSummaryText(
  entries: SummaryEntry[],
  nameOf: (staffId: number) => string | null,
  max = 3,
  selfStaffId: number | null = null,
): string | null {
  interface Group {
    who: string
    whats: string[]
    devices: number
    noStaff: boolean
  }
  const groups = new Map<string, Group>()
  for (const { p, what } of entries) {
    const self = selfStaffId !== null && p.staffId === selfStaffId
    const key = p.staffId === null ? 'x' : self ? 'me' : `s${p.staffId}`
    let g = groups.get(key)
    if (!g) {
      const n = p.staffId === null || self ? null : nameOf(p.staffId)
      g = {
        who:
          p.staffId === null
            ? PRESENCE_NO_STAFF
            : self
              ? PRESENCE_SELF_OTHER
              : n !== null && n !== ''
                ? n
                : PRESENCE_UNKNOWN_STAFF,
        whats: [],
        devices: 0,
        // 台数を添えるまとまり（職員を選んでいない端末・自分の別の端末）
        noStaff: p.staffId === null || self,
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

// ── 操作している時だけ配る（F21・F22・2026-10-10） ─────────────────────────

/**
 * 最後に操作した時刻を持ち、「いま操作中か」（最後の操作から idleMs 以内か）を答える入れ物（F22）。
 * 欄を開いたまま席を外した端末の「入力中」、戻しただけの書きかけの「書いています」を配り続けないために使う。
 * - 作った直後は「まだ操作していない」（戻した書きかけを、開いただけで配らない）
 * - touch(now) で操作を記録する。戻り値は「操作していない状態から操作中に戻ったか」（配り直しの合図）
 * - dueAt() は操作中が切れる時刻（操作していなければ null）。タイマーをここに合わせる
 * 時計が戻った（最後の操作が未来）時は操作中とみなす（取り消しを早めすぎない）
 */
export function createActivityGate(idleMs: number = PRESENCE_IDLE_MS) {
  let last: number | null = null
  const active = (now: number): boolean => last !== null && (now < last || now - last < idleMs)
  return {
    touch(now: number): boolean {
      const was = active(now)
      last = now
      return !was
    },
    active,
    dueAt(): number | null {
      return last === null ? null : last + idleMs
    },
    /** 操作の記録を捨てる（画面を離れる時） */
    reset(): void {
      last = null
    },
  }
}

/** 申し送りの書きかけの行のうち、「書いています」の判定に使う欄だけ（日報の NoteDraft と同じ名前） */
export interface ComposingRow {
  key: string
  residentId: number | null
  targetPicked: boolean
  body: string
  /** 送信待ちに退避した行（止まった登録を含む）。書いている最中ではない */
  locked: boolean
}

/**
 * いま「書いています」を配るべき書きかけ（F21・2026-10-10 本人回答「操作している時だけ」）。
 * - touched（行の key → この起動中にこの画面で手を入れた時刻。メモリだけで持ち、端末の控えには書かない）に印があり、
 *   最後に手を入れてから idleMs 以内の行だけを数える
 * - 控えから戻しただけの行（手を入れていない）・送信待ちの行（locked。止まった登録も）は数えない
 * - 中身（対象を選んだ・本文がある）の無い行は数えない
 * 当たる行のうち最後に手を入れた行の { residentId（対象を選んでいなければ null）, at（手を入れた時刻） }、無ければ null。
 * 名前は配る端末のいまの記録者で出す（手を入れた人＝その端末で操作している人）
 */
export function liveComposing(
  rows: readonly ComposingRow[],
  touched: ReadonlyMap<string, number>,
  now: number,
  idleMs: number = PRESENCE_IDLE_MS,
): { residentId: number | null; at: number } | null {
  let best: { residentId: number | null; at: number } | null = null
  for (const d of rows) {
    if (d.locked) continue
    if (!d.targetPicked && d.body.trim() === '') continue
    const at = touched.get(d.key)
    if (at === undefined || (now >= at && now - at >= idleMs)) continue
    if (best === null || at > best.at) {
      best = { residentId: d.targetPicked ? d.residentId : null, at }
    }
  }
  return best
}

/**
 * 日ごとの「書いています」から、配る1つを選ぶ（F21）。最後に手を入れた日を採る
 * （以前は Map に入った順の先頭を採っていたため、区切りの中の過去の日に戻った書きかけが今日の入力を隠した）
 */
export function latestComposing(
  byDay: ReadonlyMap<string, { residentId: number | null; at: number }>,
): { day: string; residentId: number | null } | null {
  let best: { day: string; residentId: number | null; at: number } | null = null
  for (const [day, v] of byDay) {
    if (best === null || v.at > best.at) best = { day, residentId: v.residentId, at: v.at }
  }
  return best === null ? null : { day: best.day, residentId: best.residentId }
}
