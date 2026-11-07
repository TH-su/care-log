// 勤務表（シフト作成アプリ）の1日分から、その日の出勤者と夜勤の施設職員を決める（2026-11-07 代表者の決定）。
//
//   ・日報の出勤者の欄は、その日の勤務表の出勤者で自動で埋まり、申し送りの記入者の候補になる
//   ・夜勤（shift='night'）の記入者は、勤務表で決まっているその夜の夜勤の施設職員（1人）を自動で入れる。記入者の欄は出さない
//
// 勤務表の写しは共通 DB の kv_entries（シフト作成アプリが書く）にある。読むのは次のキーだけ:
//   sched:YYYY-MM:actual（実績）・sched:YYYY-MM:official（確定）・sched:YYYY-MM:plan（予定）… data.cells = { 職員id: { 日: 記号 } }
//   staff（勤務表の職員の一覧 … id・name・mainDivision・order）・symbols（記号の一覧 … code・type）
// この部品は純関数だけ（通信しない・端末に残さない）。読むのは db.ts の fetchShiftDay。
//
// 決め方（仮置き 2026-11-07・代表者へ報告済み）:
//   1. その日に記号が1つでも入っている表を、実績 → 確定 → 予定 の順に1つだけ使う
//   2. 記号の「(21」「（22」は夜勤入り、「7)」「8)」は夜勤明け。これを除いて残った記号が休み（休・希・明・有・公 など
//      記号の一覧で休みの種類のもの）でも空でもなければ、その日の出勤
//   3. 夜勤入りの職員のうち、主な所属が「施設」の人がちょうど1人の時だけ、その人を夜勤の記入者にする（0人・2人以上は決めない）
//   4. 勤務表の職員とケアログの職員は氏名で結ぶ（名簿の同期と同じ比べ方。空白を除き NFKC でそろえる）。
//      同じ氏名のケアログの職員が2人以上いる・在籍していない時は結ばない（推測しない）
//   5. 出勤者は勤務表の並び（order）の順。夜勤入りの施設職員は、その日の出勤者の最後に入れる（日報の出勤者の欄に記名していた分）

import type { Staff } from './types'

export type ShiftSource = 'actual' | 'official' | 'plan'

export interface ShiftMonthDocs {
  actual?: unknown
  official?: unknown
  plan?: unknown
  /** 勤務表の職員の一覧（kv_entries の staff） */
  staff?: unknown
  /** 記号の一覧（kv_entries の symbols） */
  symbols?: unknown
}

export interface ShiftDay {
  /** 使った表（その日の記号が1つも無い時 null） */
  source: ShiftSource | null
  /** その日の出勤者（ケアログの職員 id・勤務表の並び。夜勤入りの施設職員は最後） */
  staffIds: number[]
  /** その夜の夜勤の施設職員（ケアログの職員 id）。決まらない時 null */
  nightStaffId: number | null
}

export const EMPTY_SHIFT_DAY: ShiftDay = { source: null, staffIds: [], nightStaffId: null }

/** 記号の一覧が読めない時の休みの記号（シフト作成アプリの既定と同じ） */
const DEFAULT_OFF = ['休', '希', '明', '有', '公']
const OFF_TYPES = new Set(['off', 'paidOff', 'publicOff'])

const NIGHT_IN = /\(\s*\d{1,2}(?::\d{2})?/g
const NIGHT_OUT = /\d{1,2}(?::\d{2})?\s*\)/g

function norm(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '')
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** 'YYYY-MM-DD' → 月のキー 'YYYY-MM' と日（先頭の0なし）。形が違えば null */
export function shiftMonthOf(dayIso: string): { ym: string; d: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayIso)
  if (m === null) return null
  const d = Number(m[3])
  if (d < 1 || d > 31) return null
  return { ym: `${m[1]}-${m[2]}`, d: String(d) }
}

/** kv_entries から読むキー（その月の3つの表と、職員・記号の一覧） */
export function shiftKeysFor(dayIso: string): string[] {
  const mo = shiftMonthOf(dayIso)
  if (mo === null) return []
  return [`sched:${mo.ym}:actual`, `sched:${mo.ym}:official`, `sched:${mo.ym}:plan`, 'staff', 'symbols']
}

/** 1つの記号を読む: 夜勤入りか・夜勤の印を除いて日中の出勤か */
export function readShiftCell(raw: string, off: ReadonlySet<string>): { nightIn: boolean; dayWork: boolean } {
  const v = raw.normalize('NFKC')
  const nightIn = new RegExp(NIGHT_IN.source).test(v)
  const rest = norm(v.replace(NIGHT_IN, '').replace(NIGHT_OUT, ''))
  return { nightIn, dayWork: rest !== '' && !off.has(rest) }
}

function offCodes(symbols: unknown): Set<string> {
  const out = new Set<string>()
  if (Array.isArray(symbols)) {
    for (const s of symbols) {
      const r = rec(s)
      if (r === null || typeof r.code !== 'string' || typeof r.type !== 'string') continue
      if (OFF_TYPES.has(r.type)) out.add(norm(r.code))
    }
  }
  if (out.size === 0) for (const c of DEFAULT_OFF) out.add(c)
  return out
}

/** その日のセル（職員id → 記号）。記号が1つも無ければ null */
function dayCells(doc: unknown, d: string): Map<string, string> | null {
  const cells = rec(rec(doc)?.cells)
  if (cells === null) return null
  const out = new Map<string, string>()
  for (const [sid, days] of Object.entries(cells)) {
    const v = rec(days)?.[d]
    if (typeof v === 'string' && v.trim() !== '') out.set(sid, v)
  }
  return out.size > 0 ? out : null
}

/** 勤務表の1日分を、ケアログの職員の id に直す */
export function resolveShiftDay(docs: ShiftMonthDocs, dayIso: string, careStaff: readonly Staff[]): ShiftDay {
  const mo = shiftMonthOf(dayIso)
  if (mo === null) return EMPTY_SHIFT_DAY
  let source: ShiftSource | null = null
  let cells: Map<string, string> | null = null
  for (const s of ['actual', 'official', 'plan'] as const) {
    cells = dayCells(docs[s], mo.d)
    if (cells !== null) {
      source = s
      break
    }
  }
  if (cells === null || source === null) return EMPTY_SHIFT_DAY

  // ケアログの職員（在籍）を氏名で引く。同じ氏名が2人以上なら結ばない
  const byName = new Map<string, number | null>()
  for (const s of careStaff) {
    if (!s.active) continue
    const k = norm(s.name)
    if (k === '') continue
    byName.set(k, byName.has(k) ? null : s.id)
  }
  // 勤務表の職員（id → 氏名・所属・並び）
  const roster = new Map<string, { careId: number | null; facility: boolean; order: number }>()
  if (Array.isArray(docs.staff)) {
    docs.staff.forEach((e, i) => {
      const r = rec(e)
      if (r === null || typeof r.id !== 'string' || typeof r.name !== 'string') return
      if (roster.has(r.id)) return
      const careId = byName.get(norm(r.name)) ?? null
      const order = typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : 100000 + i
      roster.set(r.id, { careId, facility: r.mainDivision === '施設', order })
    })
  }

  const off = offCodes(docs.symbols)
  const day: { id: number; order: number; sid: string }[] = []
  const night: number[] = []
  let nightUnknown = false
  for (const [sid, code] of cells) {
    const who = roster.get(sid)
    const c = readShiftCell(code, off)
    if (c.nightIn && (who === undefined || who.facility)) {
      // 夜勤入りの施設職員（所属の分からない勤務表の職員は数に入れる＝決めない側へ倒す）
      if (who === undefined || who.careId === null) nightUnknown = true
      else night.push(who.careId)
    }
    if (c.dayWork && who !== undefined && who.careId !== null) day.push({ id: who.careId, order: who.order, sid })
  }
  day.sort((a, b) => a.order - b.order || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0))
  const staffIds: number[] = []
  for (const x of day) if (!staffIds.includes(x.id)) staffIds.push(x.id)
  const nightStaffId = !nightUnknown && night.length === 1 ? night[0] : null
  if (nightStaffId !== null && !staffIds.includes(nightStaffId)) staffIds.push(nightStaffId)
  return { source, staffIds, nightStaffId }
}

/**
 * 記入者の候補（その日の出勤者）。日報の出勤者の欄（attendance・表示中の行）を正とし、
 * 欄が空の日は勤務表の出勤者、それも無い日は空（＝画面は今までどおり全職員から選ぶ）。在籍していない職員は外す
 */
export function reporterCandidates(
  attendanceIds: readonly number[],
  shift: ShiftDay,
  activeStaff: readonly Staff[],
): number[] {
  const active = new Set(activeStaff.filter((s) => s.active).map((s) => s.id))
  const base = attendanceIds.length > 0 ? attendanceIds : shift.staffIds
  const out: number[] = []
  for (const id of base) if (active.has(id) && !out.includes(id)) out.push(id)
  return out
}

/**
 * 日報の出勤者の欄を勤務表から自動で埋めてよい日か（仮置き: 今日と昨日だけ。日本時間の今日を渡す）。
 * 過ぎた日の紙を後から書き換えない・先の日は勤務が変わり得るので埋めない
 */
export function canAutoFillAttendance(dayIso: string, todayIso: string): boolean {
  const t = Date.parse(`${todayIso}T00:00:00Z`)
  const d = Date.parse(`${dayIso}T00:00:00Z`)
  if (!Number.isFinite(t) || !Number.isFinite(d)) return false
  const diff = (t - d) / 86_400_000
  return diff === 0 || diff === 1
}
