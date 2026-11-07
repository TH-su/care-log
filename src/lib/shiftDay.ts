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
//   1. 職員ごとに、その日の記号を 実績 → 確定 → 予定 の順に最初に入っている表から読む
//   2. 記号の読み方はシフト作成アプリ（care-tools の shift-app.html の parseCell）と同じ順:
//      別名（有休→有 など）→ 記号の一覧に完全一致 → 時刻の範囲（9-12）→ 先頭の夜勤明け（7)・)）→ 末尾の夜勤入り（(21）
//      → 夜枠の代替記号（(有）。空白で区切った「7-9 17-21」は1語ずつ読む。読めない記号（欠・研修 など）は出勤に数えない
//   3. 施設の日報の出勤者は、主な所属が施設の職員（所属が空も施設・シフト作成アプリと同じ）の主の欄と、
//      ほかの所属の職員の「施設」の応援の欄（subCells）で、勤務（work）の記号がある人
//   4. 夜勤入りの施設の職員がちょうど1人の時だけ、その人を夜勤の記入者にする（0人・2人以上・結べない人がいる時は決めない）
//   5. 勤務表の職員とケアログの職員は氏名で結ぶ（名簿の同期と同じ比べ方。空白を除き NFKC でそろえる）。
//      同じ氏名のケアログの職員が2人以上いる・在籍していない・勤務表で退職の職員は結ばない（推測しない）
//   6. 出勤者は勤務表の並び（order）の順。夜勤入りの施設職員は、その日の出勤者の最後に入れる（日報の出勤者の欄に記名していた分）

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

/** シフト作成アプリの別名（ALIASES と同じ） */
const ALIASES: Record<string, string> = { 希休: '希', 有休: '有', 公休: '公', 希望休: '希', 有給: '有' }
/** 記号の一覧が読めない時の記号（シフト作成アプリの既定のうち、休み・夜勤の分） */
const DEFAULT_SYMBOLS: { code: string; type: string }[] = [
  { code: '早', type: 'work' },
  { code: '遅', type: 'work' },
  { code: '日1', type: 'work' },
  { code: '日2', type: 'work' },
  { code: '日3', type: 'work' },
  { code: '(21', type: 'nightIn' },
  { code: '(22', type: 'nightIn' },
  { code: '7)', type: 'nightOut' },
  { code: '8)', type: 'nightOut' },
  { code: '休', type: 'off' },
  { code: '希', type: 'off' },
  { code: '明', type: 'off' },
  { code: '有', type: 'paidOff' },
  { code: '公', type: 'publicOff' },
]
const RE_RANGE = /^(\d{1,2}(?::\d{2})?)-(\d{1,2}(?::\d{2})?)$/
const RE_NIGHT_OUT = /^(\d{1,2}(?::\d{2})?)\)/
const RE_NIGHT_IN = /\((\d{1,2}(?::\d{2})?)$/

/** シフト作成アプリの normalizeCell と同じ（全角数字・かっこ・コロン・長音などの横線をそろえ、空白を除く） */
function normalizeCell(raw: string): string {
  let out = ''
  for (const c of raw) {
    const fi = '０１２３４５６７８９'.indexOf(c)
    if (fi >= 0) out += String(fi)
    else if (c === '（') out += '('
    else if (c === '）') out += ')'
    else if (c === '：') out += ':'
    else if ('～〜−ー－―'.includes(c)) out += '-'
    else if (c === '　' || c === ' ' || c === '\t') continue
    else out += c
  }
  return out
}

function norm(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '')
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** 記号の一覧（記号 → 種類）。読めない・空の時は既定の一覧 */
export function symbolTypes(symbols: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (Array.isArray(symbols)) {
    for (const s of symbols) {
      const r = rec(s)
      if (r === null || r.disabled === true || typeof r.code !== 'string' || typeof r.type !== 'string') continue
      const k = normalizeCell(r.code)
      if (k !== '' && !out.has(k)) out.set(k, r.type)
    }
  }
  if (out.size === 0) for (const s of DEFAULT_SYMBOLS) out.set(normalizeCell(s.code), s.type)
  return out
}

/** 1つの記号を読む（シフト作成アプリの parseCell と同じ順）: 夜勤入りか・日中の勤務か */
export function readShiftCell(raw: string, types: ReadonlyMap<string, string>): { nightIn: boolean; dayWork: boolean } {
  const out = { nightIn: false, dayWork: false }
  let str = raw.replace(/[\/／][\s　]*同[\s　]*$/, '')
  const toks = str.split(/[\s　\t]+/).filter((t) => t !== '')
  if (toks.length >= 2) {
    for (const t of toks) {
      const r = readShiftCell(t, types)
      out.nightIn ||= r.nightIn
      out.dayWork ||= r.dayWork
    }
    return out
  }
  let n = normalizeCell(str)
  if (n === '') return out
  if (ALIASES[n]) n = ALIASES[n]
  const sym = types.get(n)
  if (sym !== undefined) {
    if (sym === 'work') out.dayWork = true
    else if (sym === 'nightIn') out.nightIn = true
    return out
  }
  if (RE_RANGE.test(n)) {
    out.dayWork = true
    return out
  }
  let rest = n
  const mo = RE_NIGHT_OUT.exec(rest)
  if (mo !== null) rest = rest.slice(mo[0].length)
  else if (rest.startsWith(')')) rest = rest.slice(1)
  // 残りが「(21」だけなら夜勤入り。「(有」のような夜枠の代替記号・読めない残りは何も数えない
  if (/^\(\d{1,2}(?::\d{2})?$/.test(rest) && RE_NIGHT_IN.test(rest)) out.nightIn = true
  return out
}

/** 表の data.cells（職員id → 日 → 記号）と data.subCells（職員id → 所属 → 日 → 記号）からその日の記号を引く */
function cellOf(doc: unknown, sid: string, d: string, division: string | null): string | null {
  const data = rec(doc)
  const base = division === null ? rec(data?.cells)?.[sid] : rec(rec(data?.subCells)?.[sid])?.[division]
  const v = rec(base)?.[d]
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/** 勤務表の1日分を、ケアログの職員の id に直す */
export function resolveShiftDay(docs: ShiftMonthDocs, dayIso: string, careStaff: readonly Staff[]): ShiftDay {
  const mo = shiftMonthOf(dayIso)
  if (mo === null || !Array.isArray(docs.staff)) return EMPTY_SHIFT_DAY
  const sources = (['actual', 'official', 'plan'] as const).filter((k) => rec(docs[k]) !== null)
  if (sources.length === 0) return EMPTY_SHIFT_DAY

  // ケアログの職員（在籍）を氏名で引く。同じ氏名が2人以上なら結ばない
  const byName = new Map<string, number | null>()
  for (const s of careStaff) {
    if (!s.active) continue
    const k = norm(s.name)
    if (k === '') continue
    byName.set(k, byName.has(k) ? null : s.id)
  }
  const types = symbolTypes(docs.symbols)
  /** 職員ごとに 実績 → 確定 → 予定 の順で最初に入っている記号（division=null は主の欄） */
  const pick = (sid: string, division: string | null): { code: string; src: ShiftSource } | null => {
    for (const k of sources) {
      const c = cellOf(docs[k], sid, mo.d, division)
      if (c !== null) return { code: c, src: k }
    }
    return null
  }

  let used: ShiftSource | null = null
  const note = (src: ShiftSource) => {
    if (used === null || sources.indexOf(src) < sources.indexOf(used)) used = src
  }
  const day: { id: number; order: number; idx: number }[] = []
  const night: number[] = []
  let nightUnknown = false
  const seen = new Set<string>()
  docs.staff.forEach((e, i) => {
    const r = rec(e)
    if (r === null || typeof r.id !== 'string' || typeof r.name !== 'string' || seen.has(r.id)) return
    seen.add(r.id)
    const retired = r.active === false || r.status === '退職'
    const careId = retired ? null : (byName.get(norm(r.name)) ?? null)
    const order = typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : 100000 + i
    const facilityMain = (typeof r.mainDivision === 'string' && r.mainDivision !== '' ? r.mainDivision : '施設') === '施設'
    // 施設の欄: 施設が主の職員は主の欄、ほかの職員は施設の応援の欄
    const cell = pick(r.id, facilityMain ? null : '施設')
    if (cell === null) return
    note(cell.src)
    const c = readShiftCell(cell.code, types)
    if (c.nightIn) {
      if (careId === null) nightUnknown = true
      else night.push(careId)
    }
    if (c.dayWork && careId !== null) day.push({ id: careId, order, idx: i })
  })
  if (used === null) return EMPTY_SHIFT_DAY
  day.sort((a, b) => a.order - b.order || a.idx - b.idx)
  const staffIds: number[] = []
  for (const x of day) if (!staffIds.includes(x.id)) staffIds.push(x.id)
  const nightStaffId = !nightUnknown && night.length === 1 ? night[0] : null
  if (nightStaffId !== null && !staffIds.includes(nightStaffId)) staffIds.push(nightStaffId)
  return { source: used, staffIds, nightStaffId }
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
