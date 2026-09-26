// デイの入浴記録の純ロジック（副作用なし・DB/DOM に触れない）。
// 入浴記録の画面（BathRecordPage）・月次表（BathMonthPage）・db.ts が共通で使う。
// 拡張子付きで import する（historyView.ts と同じ。tests/logic.test.mjs から直接読めるようにするため）
//
// 予定の正本は週間計画（care_schedule_v2）で、その写しを RPC daycare_bath_plan（0012）が
// 「その日の曜日に入浴の予定がある人」として返す。予定は曜日ベース（毎週同じ）なので、
// 月次表の「未」は「その日の曜日に予定があって、その日の記録が無い」日。
// 個人情報: ここには氏名も記録本文も書かない（型と計算だけ）。

import { BATH_CANCEL_REASONS, BATH_RESULTS } from './types.ts'
import type { BathCancelReason, BathRecord, BathResult, Resident } from './types.ts'

// ── 日付・月 ────────────────────────────────────────────────────────────────

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

/**
 * 週間計画の曜日番号（0=月 … 6=日）。SQL 側の extract(isodow) - 1 と同じ値になる。
 * 形が不正な日付は null。
 */
export function isoWeekdayIndex(dayIso: string): number | null {
  const m = DAY_RE.exec(dayIso)
  if (m === null) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  // 存在しない日付（2月30日・13月など）は Date が繰り上げるので、年・月・日が元のままかで弾く
  if (
    Number.isNaN(d.getTime()) ||
    d.getFullYear() !== Number(m[1]) ||
    d.getMonth() !== Number(m[2]) - 1 ||
    d.getDate() !== Number(m[3])
  ) {
    return null
  }
  return (d.getDay() + 6) % 7
}

/** 'YYYY-MM-DD' → 'YYYY-MM' */
export function monthKeyOf(dayIso: string): string {
  return dayIso.slice(0, 7)
}

/**
 * localStorage 等から読んだ月の値を照合する（原則11: 既知の形だけ受け入れる）。
 * 'yyyy-MM' の形で、今月（currentMonth）より先でない時だけその値を返す。それ以外は null（呼び側が今月へ戻す）。
 */
export function parseMonthKey(raw: unknown, currentMonth: string): string | null {
  if (typeof raw !== 'string' || !MONTH_RE.test(raw)) return null
  if (MONTH_RE.test(currentMonth) && raw > currentMonth) return null
  return raw
}

/** 月を n か月ずらす（'2026-01' と -1 → '2025-12'） */
export function shiftMonth(key: string, n: number): string {
  const m = MONTH_RE.exec(key)
  if (m === null) return key
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n
  const y = Math.floor(total / 12)
  const mo = total - y * 12 + 1
  return `${y}-${String(mo).padStart(2, '0')}`
}

/** その月の日付の一覧（1日〜月末） */
export function monthDays(key: string): string[] {
  const m = MONTH_RE.exec(key)
  if (m === null) return []
  const y = Number(m[1])
  const mo = Number(m[2])
  const last = new Date(y, mo, 0).getDate()
  const out: string[] = []
  for (let d = 1; d <= last; d++) out.push(`${key}-${String(d).padStart(2, '0')}`)
  return out
}

/** 月の最初の日と最後の日 */
export function monthRange(key: string): { from: string; to: string } | null {
  const days = monthDays(key)
  if (days.length === 0) return null
  return { from: days[0], to: days[days.length - 1] }
}

/** 'yyyy-MM' → '2026年9月' */
export function fmtMonthLabel(key: string): string {
  const m = MONTH_RE.exec(key)
  if (m === null) return key
  return `${Number(m[1])}年${Number(m[2])}月`
}

/** 写しの更新時刻 '2026-09-20T01:02:03Z' → '9/20 10:02'（端末の時刻で表示）。読めなければ '' */
export function fmtCopyStamp(iso: string | null): string {
  if (iso === null || iso === '') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ── 入力の検証（画面と db.ts の両方で通す） ────────────────────────────────

export interface BathInput {
  bath_on: string
  result: BathResult
  cancel_reason: BathCancelReason | null
  note: string | null
}

export type BathInputCheck = { ok: true } | { ok: false; message: string }

/**
 * 保存前の検証。today は端末の今日（JST の業務日付）。
 * ・区分は4つのどれか ・未来の日付は不可
 * ・中止は理由が必須、中止以外は理由を持たない（null）
 * ・理由が「その他」の時は備考が必須（空白だけも不可）
 */
export function validateBathInput(v: BathInput, today: string): BathInputCheck {
  if (!DAY_RE.test(v.bath_on)) return { ok: false, message: '日付を読み取れませんでした。日付を選び直してください。' }
  if (DAY_RE.test(today) && v.bath_on > today) {
    return { ok: false, message: '未来の日付には記録できません。日付を今日以前にしてください。' }
  }
  if (!(BATH_RESULTS as readonly string[]).includes(v.result)) {
    return { ok: false, message: '区分（全身浴・シャワー浴・部分浴・清拭・中止）を選んでください。' }
  }
  if (v.result === 'cancel') {
    if (v.cancel_reason === null || !(BATH_CANCEL_REASONS as readonly string[]).includes(v.cancel_reason)) {
      return { ok: false, message: '中止の理由を選んでください。' }
    }
    if (v.cancel_reason === 'other' && (v.note ?? '').trim() === '') {
      return { ok: false, message: '理由が「その他」の時は、備考に内容を書いてください。' }
    }
  } else if (v.cancel_reason !== null) {
    return { ok: false, message: '中止以外の区分に理由は付けられません。区分を選び直してください。' }
  }
  return { ok: true }
}

// ── 予定（RPC daycare_bath_plan の結果）と名簿の突き合わせ ─────────────────

/** RPC が返す1行（db.ts が型検査してから渡す） */
export interface BathPlanRow {
  source_id: string | null
  start_time: string | null
  end_time: string | null
  hospitalized: boolean
}

/** 名簿と突き合わせた予定1件 */
export interface BathPlanEntry {
  residentId: number
  startTime: string | null
  endTime: string | null
  hospitalized: boolean
}

/**
 * 予定の source_id（= 週間計画の masterId）を care-log の residents.source_id と突き合わせる。
 * 名簿に居ない source_id は捨てずに数える（unmatched。画面が「名簿に無い予定 n件」と知らせる）。
 * source_id が null の行（写しはあるが予定なし）は数えない。同じ人が2回来ても1件にする。
 */
export function matchBathPlan(
  rows: BathPlanRow[],
  residents: Pick<Resident, 'id' | 'source_id'>[],
): { entries: BathPlanEntry[]; unmatched: number } {
  const bySource = new Map<string, number>()
  for (const r of residents) if (r.source_id !== '') bySource.set(r.source_id, r.id)
  const entries: BathPlanEntry[] = []
  const seen = new Set<number>()
  let unmatched = 0
  for (const row of rows) {
    if (row.source_id === null || row.source_id === '') continue
    const id = bySource.get(row.source_id)
    if (id === undefined) {
      unmatched += 1
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    entries.push({ residentId: id, startTime: row.start_time, endTime: row.end_time, hospitalized: row.hospitalized })
  }
  return { entries, unmatched }
}

// ── 1日の一覧（予定 ∪ 記録 ∪ 予定外に足した人） ────────────────────────────

export interface BathDayRow {
  residentId: number
  /** その日の曜日に入浴の予定がある */
  planned: boolean
  startTime: string | null
  endTime: string | null
  /** 週間計画の写しで入院中 */
  hospitalized: boolean
  /** その日の記録（無ければ null＝予定があれば「未」） */
  record: BathRecord | null
}

/**
 * 1日の一覧を組む。並びは居室順（order＝居室順に並んだ名簿の利用者ID）。名簿に無い人は後ろ・ID順。
 * 行は「予定がある人」「その日に記録がある人」「予定外として画面で足した人（extraIds）」の和集合。
 * 同じ人に記録が2件あっても（通常は DB の1人1日1件で起きない）新しい id の1件だけを出す。
 */
export function buildBathDayRows(
  plan: BathPlanEntry[],
  records: BathRecord[],
  extraIds: number[],
  order: number[],
): BathDayRow[] {
  const rows = new Map<number, BathDayRow>()
  const blank = (id: number): BathDayRow => ({
    residentId: id,
    planned: false,
    startTime: null,
    endTime: null,
    hospitalized: false,
    record: null,
  })
  for (const p of plan) {
    rows.set(p.residentId, {
      ...blank(p.residentId),
      planned: true,
      startTime: p.startTime,
      endTime: p.endTime,
      hospitalized: p.hospitalized,
    })
  }
  for (const r of records) {
    const row = rows.get(r.resident_id) ?? blank(r.resident_id)
    if (row.record === null || r.id > row.record.id) row.record = r
    rows.set(r.resident_id, row)
  }
  for (const id of extraIds) if (!rows.has(id)) rows.set(id, blank(id))
  const pos = new Map<number, number>()
  order.forEach((id, i) => {
    if (!pos.has(id)) pos.set(id, i)
  })
  return Array.from(rows.values()).sort((a, b) => {
    const pa = pos.get(a.residentId)
    const pb = pos.get(b.residentId)
    if (pa !== undefined && pb !== undefined) return pa - pb
    if (pa !== undefined) return -1
    if (pb !== undefined) return 1
    return a.residentId - b.residentId
  })
}

/**
 * 未記録（「未」）として扱う行か。予定があって記録が無い人。
 * ただし入院中の方は予定があっても入浴できないので「未」にしない（画面は「入院」と出す・2026-09-26 チーフ裁定）
 */
export function isUnrecorded(row: BathDayRow): boolean {
  return row.planned && !row.hospitalized && row.record === null
}

/**
 * 上部の件数。「予定 N人・記録済み N・未記録 N」
 * ・予定     … その日の曜日に入浴の予定がある人（入院中の方は除く＝入浴できないため）
 * ・記録済み … その日に記録がある人（予定外・入院中の方の記録も含む）
 * ・未記録   … 予定があるのに記録が無い人（入院中の方は除く）
 */
export function countBathDay(rows: BathDayRow[]): { planned: number; recorded: number; unrecorded: number } {
  let planned = 0
  let recorded = 0
  let unrecorded = 0
  for (const r of rows) {
    if (r.planned && !r.hospitalized) planned += 1
    if (r.record !== null) recorded += 1
    if (isUnrecorded(r)) unrecorded += 1
  }
  return { planned, recorded, unrecorded }
}

// ── 月次表 ────────────────────────────────────────────────────────────────

/** 月次表の1マス。区分／予定があったのに記録なし（missing）／何もない（null） */
export type BathMonthMark = BathResult | 'missing' | null

export interface BathMonthTotals {
  /** 全身浴＋シャワー浴の回数（入浴介助加算の対象の見込み） */
  billable: number
  partial: number
  cancel: number
  /** 予定があったのに記録なし（「未」）の日数 */
  missing: number
}

export interface BathMonthRow {
  residentId: number
  /** 退居された方（その月に記録があるので行に出す。「未」は付けない） */
  retired: boolean
  /** 現在入院中の方（週間計画の写しの入院中。「未」は付けない＝記録画面と同じ判定） */
  hospitalized: boolean
  /** 月の日付と同じ並び（monthDays の順） */
  cells: BathMonthMark[]
  totals: BathMonthTotals
}

export interface BathMonthTable {
  days: string[]
  rows: BathMonthRow[]
  /** 表に出していない記録の件数（名簿のどこにも居ない方の記録）。0 でなければ画面が知らせる */
  hiddenRecords: number
}

/**
 * 月次表を組む。
 * ・行 … 名簿（order＝居室順に並んだ利用者ID。退居された方も含めてよい）のうち、
 *        在籍の方はその月に予定か記録がある人、退居された方（retiredIds）はその月に記録がある人だけ
 *        （加算の根拠を紙に残すため記録は出す。予定だけの退居者は出さない・2026-09-26 チーフ裁定）
 * ・列 … その月の1日〜月末
 * ・マス … 記録があれば区分。記録が無く、その日の曜日に予定があり、その日が today 以前なら 'missing'（「未」）。
 *          ただし「未」は次の全部を満たす時だけ（2026-09-26 レビュー M1・M2）:
 *            ・その日が startDay（施設全体で最初の入浴記録の日）以降。startDay が null（記録が1件も無い）なら付けない
 *              （startDay 以降なら、その月の記録が0件でも予定日には付ける＝記録の付け忘れの月を見逃さない）
 *            ・退居された方でない・現在入院中（hospitalizedIds）の方でない
 *              （過去の入院期間は分からないので、現在の入院で判断する＝記録画面の isUnrecorded と同じ）
 * plannedByWeekday … 曜日番号（0=月 … 6=日）→ 予定がある利用者ID。null は「予定を取得できなかった」（「未」を出さない）
 * 名簿のどこにも居ない方の記録は行を作らず hiddenRecords に数える（無言で消さない）。
 */
export function aggregateBathMonth(p: {
  monthKey: string
  order: number[]
  retiredIds?: ReadonlySet<number>
  hospitalizedIds?: ReadonlySet<number>
  /** 施設全体で最初の入浴記録の日（fetchBathFirstDay）。null＝記録が1件も無い＝「未」を付けない */
  startDay: string | null
  records: BathRecord[]
  plannedByWeekday: Map<number, Set<number>> | null
  today: string
}): BathMonthTable {
  const days = monthDays(p.monthKey)
  const dayIndex = new Map<string, number>()
  days.forEach((d, i) => dayIndex.set(d, i))
  const inOrder = new Set(p.order)

  // 利用者ID → 日の位置 → 記録（同じ日に2件あれば新しい id）
  const byResident = new Map<number, Map<number, BathRecord>>()
  let hiddenRecords = 0
  for (const r of p.records) {
    const i = dayIndex.get(r.bath_on)
    if (i === undefined) continue
    if (!inOrder.has(r.resident_id)) {
      hiddenRecords += 1
      continue
    }
    const m = byResident.get(r.resident_id) ?? new Map<number, BathRecord>()
    const prev = m.get(i)
    if (prev === undefined || r.id > prev.id) m.set(i, r)
    byResident.set(r.resident_id, m)
  }

  const weekdays = days.map((d) => isoWeekdayIndex(d))
  const retired = p.retiredIds ?? new Set<number>()
  const hospitalized = p.hospitalizedIds ?? new Set<number>()
  const missingAllowed = (id: number, d: string): boolean =>
    p.startDay !== null && d >= p.startDay && d <= p.today && !hospitalized.has(id)
  const plannedOn = (id: number, i: number): boolean => {
    if (p.plannedByWeekday === null || retired.has(id)) return false
    const w = weekdays[i]
    return w !== null && (p.plannedByWeekday.get(w)?.has(id) ?? false)
  }

  const rows: BathMonthRow[] = []
  const seen = new Set<number>()
  for (const id of p.order) {
    if (seen.has(id)) continue
    seen.add(id)
    const recs = byResident.get(id)
    const anyPlan = days.some((_, i) => plannedOn(id, i))
    if (recs === undefined && !anyPlan) continue
    const totals: BathMonthTotals = { billable: 0, partial: 0, cancel: 0, missing: 0 }
    const cells: BathMonthMark[] = days.map((d, i) => {
      const rec = recs?.get(i)
      if (rec !== undefined) {
        if (rec.result === 'full' || rec.result === 'shower') totals.billable += 1
        else if (rec.result === 'partial') totals.partial += 1
        else totals.cancel += 1
        return rec.result
      }
      if (plannedOn(id, i) && missingAllowed(id, d)) {
        totals.missing += 1
        return 'missing'
      }
      return null
    })
    rows.push({ residentId: id, retired: retired.has(id), hospitalized: hospitalized.has(id), cells, totals })
  }
  return { days, rows, hiddenRecords }
}

/** 月次表のマスの1文字（印刷・画面共通。白黒でも区別できる文字） */
export const BATH_MONTH_MISSING_MARK = '未'
