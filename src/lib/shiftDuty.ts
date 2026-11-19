// 勤務表（シフト作成アプリ・共通 DB の kv_entries）から「その日に施設・デイで勤務か休みか」を決める純粋な部品（2026-11-19・日報の確認欄）。
//
// 記号の読み方はシフト作成アプリ（care-tools の shift-symbols.js の parseCell）と同じにする（2026-11-07 の決定「記号の読み方は
// シフト作成アプリと同じ」）。ここでは「勤務の部分があるか」だけを使う:
//   勤務 … 勤務記号（type work・時刻の範囲 9-12 など）または夜勤入り（(21・(22・8)(22 の後ろ）を含むセル
//   休み … 休み系（休・希・公・有・明 など type off／publicOff／paidOff）と、夜勤上がりだけのセル（7)・8)・)）
//   空欄 … 何も書いていない（休み扱い＝未読者に出さない）
//   判定できない … 読めない記号だけのセル（画面は「判定できない」と出し、勤務とも休みとも決めない）
// 使う欄（2026-11-07 の決定「施設の日報の出勤者は施設が主の職員の主の欄と他の職員の施設の応援の欄から作る」を、
// 日報にデイの欄もあるため通所にも広げた＝仮置き）: 主の区分が施設・通所の職員の主の欄（cells）と、全職員の施設・通所の応援の欄（subCells）。
// 主の区分が訪問の職員の主の欄は使わない（訪問の勤務は日報の対象外）。主の区分が無い職員は施設とみなす（勤怠と同じ）。
// 実績（sched:YYYY-MM:actual）にその人・その日のセルがあればそれを使い、無ければ予定（sched:YYYY-MM:plan）を使う（実績→予定）。
//
// 個人情報: 読んだ勤務表は呼び出し側のメモリにだけ持つ。この部品は氏名と勤務の区分だけを返し、勤務記号・労務の項目は返さない。

/** シフト作成アプリの記号マスタの1件（使う項目だけ） */
export interface ShiftSymbol {
  code: string
  type: string
  disabled?: boolean
}

/** 既定の記号（シフト作成アプリの DEFAULT_SYMBOLS の code と type。記号マスタが読めない時だけ使う） */
export const DEFAULT_SHIFT_SYMBOLS: readonly ShiftSymbol[] = [
  { code: '早', type: 'work' },
  { code: '日1', type: 'work' },
  { code: '日2', type: 'work' },
  { code: '日3', type: 'work' },
  { code: '遅', type: 'work' },
  { code: '(21', type: 'nightIn' },
  { code: '(22', type: 'nightIn' },
  { code: '7)', type: 'nightOut' },
  { code: '8)', type: 'nightOut' },
  { code: '休', type: 'off' },
  { code: '希', type: 'off' },
  { code: '公', type: 'publicOff' },
  { code: '有', type: 'paidOff' },
  { code: '明', type: 'off' },
]

/** 別名（シフト作成アプリの ALIASES と同じ） */
const ALIASES: Record<string, string> = { 希休: '希', 有休: '有', 公休: '公', 希望休: '希', 有給: '有' }

/** セルの部分の種類（シフト作成アプリの parts[].kind と同じ名前） */
export type CellPartKind = 'work' | 'nightIn' | 'nightOut' | 'off' | 'publicOff' | 'paidOff'

/** 全角→半角・揺れの正規化（シフト作成アプリの normalizeCell と同じ） */
export function normalizeCell(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  const s = String(raw)
  const FW = '０１２３４５６７８９'
  let out = ''
  for (const c of s) {
    const fi = FW.indexOf(c)
    if (fi >= 0) {
      out += String(fi)
      continue
    }
    if (c === '（') { out += '('; continue }
    if (c === '）') { out += ')'; continue }
    if (c === '：') { out += ':'; continue }
    if (c === '～' || c === '〜' || c === '−' || c === 'ー' || c === '－' || c === '―') { out += '-'; continue }
    if (c === '　' || c === ' ' || c === '\t') continue
    out += c
  }
  return out
}

function timeToMin(t: string): number | null {
  const m = normalizeCell(t).match(/^(\d{1,2})(?::(\d{2}))?$/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const mm = m[2] ? parseInt(m[2], 10) : 0
  if (h > 30 || mm > 59) return null
  return h * 60 + mm
}

function findSymbol(symbols: readonly ShiftSymbol[], codeNorm: string): ShiftSymbol | null {
  for (const s of symbols) {
    if (s.disabled) continue
    if (normalizeCell(s.code) === codeNorm) return s
  }
  return null
}

function symbolKind(sym: ShiftSymbol): CellPartKind {
  if (sym.type === 'work' || sym.type === 'nightIn' || sym.type === 'nightOut' || sym.type === 'paidOff' || sym.type === 'publicOff') return sym.type
  return 'off'
}

const RE_RANGE = /^(\d{1,2}(?::\d{2})?)-(\d{1,2}(?::\d{2})?)$/
const RE_NIGHT_OUT = /^(\d{1,2}(?::\d{2})?)\)/
const RE_NIGHT_IN = /\((\d{1,2}(?::\d{2})?)$/

/**
 * セル → 部分の種類の並びと、読めない所があったか（シフト作成アプリの parseCell の parts[].kind と error の有無に合わせる）。
 * 試験（tests/shift-duty.test.mjs）がシフト作成アプリの結果を写した見本と突き合わせる。
 */
export function parseCellKinds(raw: unknown, symbols: readonly ShiftSymbol[] = DEFAULT_SHIFT_SYMBOLS): { parts: CellPartKind[]; error: boolean } {
  let rawStr = raw === null || raw === undefined ? '' : String(raw)
  const gm = rawStr.match(/[/／][\s　]*同[\s　]*$/)
  if (gm && gm.index !== undefined) rawStr = rawStr.slice(0, gm.index)
  const toks = rawStr.split(/[\s　\t]+/).filter((t) => t !== '')
  if (toks.length >= 2) {
    const parts: CellPartKind[] = []
    let error = false
    for (const t of toks) {
      const sub = parseCellKinds(t, symbols)
      parts.push(...sub.parts)
      if (sub.error) error = true
    }
    return { parts, error }
  }
  let norm = normalizeCell(rawStr)
  if (norm === '') return { parts: [], error: false }
  if (ALIASES[norm]) norm = ALIASES[norm]

  const sym = findSymbol(symbols, norm)
  if (sym) return { parts: [symbolKind(sym)], error: false }

  const m = norm.match(RE_RANGE)
  if (m) {
    const st = timeToMin(m[1])
    const en = timeToMin(m[2])
    if (st !== null && en !== null && en > st && en <= 24 * 60) return { parts: ['work'], error: false }
    return { parts: [], error: true }
  }

  const parts: CellPartKind[] = []
  let rest = norm
  const mo = rest.match(RE_NIGHT_OUT)
  if (mo) {
    parts.push('nightOut')
    rest = rest.slice(mo[0].length)
  } else if (rest.charAt(0) === ')') {
    parts.push('nightOut')
    rest = rest.slice(1)
  }
  if (rest !== '') {
    const mi = rest.match(RE_NIGHT_IN)
    if (mi && rest.charAt(0) === '(') {
      parts.push('nightIn')
      rest = ''
    } else if (rest.charAt(0) === '(') {
      let alt = rest.slice(1)
      if (ALIASES[alt]) alt = ALIASES[alt]
      const altSym = findSymbol(symbols, alt)
      if (altSym && altSym.type !== 'work') {
        parts.push(symbolKind(altSym))
        rest = ''
      }
    }
  }
  return { parts, error: parts.length === 0 || rest !== '' }
}

/** その日の勤務の区分 */
export type DutyStatus = 'duty' | 'off' | 'blank' | 'unknown'

/** セル1つの区分 */
export function cellDuty(raw: unknown, symbols: readonly ShiftSymbol[] = DEFAULT_SHIFT_SYMBOLS): DutyStatus {
  const { parts, error } = parseCellKinds(raw, symbols)
  if (parts.some((k) => k === 'work' || k === 'nightIn')) return 'duty'
  if (parts.length === 0) return error ? 'unknown' : 'blank'
  return 'off'
}

/** シフト作成アプリの職員の1件（使う項目だけ） */
export interface ShiftStaff {
  id: string
  name: string
  mainDivision?: string
  active?: boolean
  status?: string
  retireMonth?: string
}

/** 勤務表の月（cells・subCells だけ） */
export interface ShiftMonth {
  cells?: Record<string, Record<string, unknown>>
  subCells?: Record<string, Record<string, Record<string, unknown>>>
}

/** 日報の対象の区分（施設・通所）。訪問は使わない */
const DAILY_DIVISIONS = ['施設', '通所'] as const

function isYm(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)
}

/** 勤務表に出す職員か（勤怠の staffVisible と同じ条件） */
export function shiftStaffVisible(st: ShiftStaff, ym: string): boolean {
  if (!st || typeof st.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(st.id)) return false
  if (st.active === false) return false
  if (st.status === '休職' || st.status === '非表示' || st.status === '退職') return false
  if (st.retireMonth && isYm(st.retireMonth) && ym > st.retireMonth) return false
  return true
}

function cellOf(cells: Record<string, unknown> | undefined, d: number): unknown {
  if (!cells || typeof cells !== 'object') return ''
  let v = cells[String(d)]
  if (v == null) v = cells[d < 10 ? '0' + d : String(d)]
  return v == null ? '' : v
}

/** 主の区分（無い・知らない値は施設＝勤怠と同じ） */
function mainDivisionOf(st: ShiftStaff): string {
  return st.mainDivision === '施設' || st.mainDivision === '訪問' || st.mainDivision === '通所' ? st.mainDivision : '施設'
}

/** 職員・日の、日報の対象の欄（施設・通所の主の欄と応援の欄）のセルを集める */
function dailyCells(st: ShiftStaff, month: ShiftMonth | null | undefined, d: number): unknown[] {
  if (!month) return []
  const out: unknown[] = []
  if ((DAILY_DIVISIONS as readonly string[]).includes(mainDivisionOf(st))) out.push(cellOf(month.cells?.[st.id], d))
  const subs = month.subCells?.[st.id]
  if (subs && typeof subs === 'object') {
    for (const dv of DAILY_DIVISIONS) out.push(cellOf(subs[dv], d))
  }
  return out
}

function hasAny(cells: unknown[]): boolean {
  return cells.some((c) => normalizeCell(c) !== '')
}

/**
 * 1人・1日の区分。実績に日報の対象の欄のセルが1つでもあれば実績だけで、無ければ予定で決める。
 * 欄のどれかが勤務なら勤務・読めない欄があれば判定できない・休みの欄があれば休み・全部空なら空欄。
 */
export function staffDayDuty(
  st: ShiftStaff,
  d: number,
  plan: ShiftMonth | null | undefined,
  actual: ShiftMonth | null | undefined,
  symbols: readonly ShiftSymbol[],
): DutyStatus {
  const act = dailyCells(st, actual, d)
  const cells = hasAny(act) ? act : dailyCells(st, plan, d)
  const kinds = cells.map((c) => cellDuty(c, symbols))
  if (kinds.includes('duty')) return 'duty'
  if (kinds.includes('unknown')) return 'unknown'
  if (kinds.includes('off')) return 'off'
  return 'blank'
}

/** 職員が日報の対象（主の区分が施設・通所、または施設・通所の応援の欄がある）か */
export function staffInDaily(st: ShiftStaff, months: readonly (ShiftMonth | null | undefined)[]): boolean {
  if ((DAILY_DIVISIONS as readonly string[]).includes(mainDivisionOf(st))) return true
  return months.some((m) => {
    const subs = m?.subCells?.[st.id]
    if (!subs || typeof subs !== 'object') return false
    return DAILY_DIVISIONS.some((dv) => {
      const row = subs[dv]
      return !!row && typeof row === 'object' && Object.values(row).some((v) => normalizeCell(v) !== '')
    })
  })
}

/** 氏名の突き合わせの鍵（ケアログの職員の同期と同じ: NFKC・空白を除く） */
export function nameKey(s: string | null | undefined): string {
  if (!s) return ''
  return s.normalize('NFKC').replace(/\s+/g, '')
}

/** 月ごとの勤務表の材料 */
export interface ShiftSource {
  staff: ShiftStaff[]
  symbols: ShiftSymbol[]
  /** 'YYYY-MM' → 予定・実績 */
  months: Record<string, { plan: ShiftMonth | null; actual: ShiftMonth | null }>
}

/** 日ごとの区分の表: 日 → 氏名の鍵 → 区分。対象（日報の区分）の職員だけを持つ */
export type DutyTable = Map<string, Map<string, DutyStatus>>

/**
 * 表示中の日（'YYYY-MM-DD'）ごとに、日報の対象の職員の区分を決める。
 * その日の月の勤務表が無い日は表に入れない（呼び出し側が「勤務表が無い」として出勤者の欄へ戻す）。
 * 同じ氏名の職員が2人いる時は、勤務の方を優先する（未読者を見落とさない側に倒す）。
 */
export function buildDutyTable(src: ShiftSource, days: readonly string[]): DutyTable {
  const out: DutyTable = new Map()
  const rank: Record<DutyStatus, number> = { duty: 3, unknown: 2, off: 1, blank: 0 }
  for (const day of days) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
    if (!m) continue
    const ym = `${m[1]}-${m[2]}`
    const mon = src.months[ym]
    if (!mon || !mon.plan) continue
    const d = parseInt(m[3], 10)
    const row = new Map<string, DutyStatus>()
    for (const st of src.staff) {
      if (!shiftStaffVisible(st, ym)) continue
      if (!staffInDaily(st, [mon.plan, mon.actual])) continue
      const key = nameKey(st.name)
      if (!key) continue
      const v = staffDayDuty(st, d, mon.plan, mon.actual, src.symbols.length ? src.symbols : DEFAULT_SHIFT_SYMBOLS)
      const prev = row.get(key)
      if (prev === undefined || rank[v] > rank[prev]) row.set(key, v)
    }
    out.set(day, row)
  }
  return out
}

/** kv_get の応答の data から、使う項目だけを取り出す（労務の項目は捨てる） */
export function projectShiftStaff(data: unknown): ShiftStaff[] | null {
  if (!Array.isArray(data)) return null
  const out: ShiftStaff[] = []
  for (const it of data) {
    if (!it || typeof it !== 'object') continue
    const r = it as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.name !== 'string' || r.name.trim() === '') continue
    out.push({
      id: r.id,
      name: r.name,
      mainDivision: typeof r.mainDivision === 'string' ? r.mainDivision : undefined,
      active: r.active === false ? false : undefined,
      status: typeof r.status === 'string' ? r.status : undefined,
      retireMonth: typeof r.retireMonth === 'string' ? r.retireMonth : undefined,
    })
  }
  return out
}

export function projectShiftSymbols(data: unknown): ShiftSymbol[] {
  if (!Array.isArray(data)) return []
  const out: ShiftSymbol[] = []
  for (const it of data) {
    if (!it || typeof it !== 'object') continue
    const r = it as Record<string, unknown>
    if (typeof r.code !== 'string' || typeof r.type !== 'string') continue
    out.push({ code: r.code, type: r.type, disabled: r.disabled === true ? true : undefined })
  }
  return out
}

export function projectShiftMonth(data: unknown): ShiftMonth | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const r = data as Record<string, unknown>
  const cells = r.cells && typeof r.cells === 'object' && !Array.isArray(r.cells) ? (r.cells as ShiftMonth['cells']) : {}
  const subCells = r.subCells && typeof r.subCells === 'object' && !Array.isArray(r.subCells) ? (r.subCells as ShiftMonth['subCells']) : {}
  return { cells, subCells }
}

// ── 未読者欄の数え方（2026-11-19 代表者の指示「日勤者は前日分から・夜勤者は当日の日中分から」「デイ職員・厨房職員は氏名を出さない」）──
// 未読者欄は施設（ラウレアハレ）の勤務だけで数える: 主の区分が施設の職員の主の欄と、全職員の施設の応援の欄。
// 主の区分が通所（デイ職員）の人は外す（施設の応援の欄があっても外す＝仮置き）。厨房の職員は勤務表の名簿に居ない（2026-11-19 実測）ので
// 名簿で見つからない人は数えない（＝氏名は出ない）。日勤（勤務の部分）と夜勤入りを分けて持つ（日報 R を読む人＝R の夜勤入り＋R の翌日の日勤）。

/** 施設の勤務の1人1日ぶん */
export interface FacilityDuty {
  /** 施設で日勤（勤務の部分）がある */
  work: boolean
  /** 施設で夜勤入りがある */
  nightIn: boolean
  /** 勤務の部分が無く、読めない欄がある */
  unknown: boolean
}

/** 日 → 氏名の鍵 → 施設の勤務。その日の月の勤務表（予定）が無い日は入れない */
export type FacilityDutyTable = Map<string, Map<string, FacilityDuty>>

function facilityCells(st: ShiftStaff, month: ShiftMonth | null | undefined, d: number): unknown[] {
  if (!month) return []
  const out: unknown[] = []
  if (mainDivisionOf(st) === '施設') out.push(cellOf(month.cells?.[st.id], d))
  const subs = month.subCells?.[st.id]
  if (subs && typeof subs === 'object') out.push(cellOf(subs['施設'], d))
  return out
}

/** 1人・1日の施設の勤務（実績に施設の欄のセルが1つでもあれば実績だけ、無ければ予定） */
export function staffDayFacility(
  st: ShiftStaff,
  d: number,
  plan: ShiftMonth | null | undefined,
  actual: ShiftMonth | null | undefined,
  symbols: readonly ShiftSymbol[],
): FacilityDuty {
  const act = facilityCells(st, actual, d)
  const cells = hasAny(act) ? act : facilityCells(st, plan, d)
  let work = false
  let nightIn = false
  let err = false
  for (const c of cells) {
    const { parts, error } = parseCellKinds(c, symbols)
    if (parts.includes('work')) work = true
    if (parts.includes('nightIn')) nightIn = true
    if (error && parts.length === 0) err = true
  }
  return { work, nightIn, unknown: err && !work && !nightIn }
}

/**
 * 日ごとの施設の勤務の表。主の区分が通所の人は入れない。同じ氏名が2人いる時は勤務の部分を合わせる（見落とさない側）。
 */
export function buildFacilityDutyTable(src: ShiftSource, days: readonly string[]): FacilityDutyTable {
  const out: FacilityDutyTable = new Map()
  for (const day of days) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
    if (!m) continue
    const ym = `${m[1]}-${m[2]}`
    const mon = src.months[ym]
    if (!mon || !mon.plan) continue
    const d = parseInt(m[3], 10)
    const row = new Map<string, FacilityDuty>()
    for (const st of src.staff) {
      if (!shiftStaffVisible(st, ym)) continue
      if (mainDivisionOf(st) === '通所') continue
      const key = nameKey(st.name)
      if (!key) continue
      const v = staffDayFacility(st, d, mon.plan, mon.actual, src.symbols.length ? src.symbols : DEFAULT_SHIFT_SYMBOLS)
      const prev = row.get(key)
      row.set(key, prev ? { work: prev.work || v.work, nightIn: prev.nightIn || v.nightIn, unknown: prev.unknown || v.unknown } : v)
    }
    out.set(day, row)
  }
  return out
}
