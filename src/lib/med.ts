// 服薬介助の実施チェックの純ロジック（副作用なし・DB/DOM に触れない）。
// 与薬チェック（MedRecordPage）・服薬の時間帯（MedSlotsPage）・月次表（MedMonthPage）・db.ts が共通で使う。
// 拡張子付きで import する（bath.ts と同じ。tests/med.test.mjs から直接読めるようにするため）
//
// 時間帯（朝・昼・夕・眠前）は入居者ごとに med_slots が持つ。その人に設定の無い時間帯は「—」（押せない）。
// 「未」＝設定のある時間帯で、締め時刻を過ぎても記録が無いもの。過去の日は締めを過ぎたものとして扱う。
// 個人情報: ここには氏名も記録本文も薬の名前も書かない（型と計算だけ）。

import { MED_ADMIN_SLOTS, MED_SLOTS, MED_STATUSES } from './types.ts'
import type { MedAdmin, MedAdminSlot, MedSlot, MedStatus } from './types.ts'
import { monthDays } from './bath.ts'

// ── 締め時刻 ────────────────────────────────────────────────────────────────

/**
 * 締め時刻（端末の時刻＝JST 運用）。これを過ぎた今日の未記録は「未」。
 * 将来は設定から読めるよう、判定は必ずこの表を通す（画面・月次表に時刻を直書きしない）
 */
export const MED_DEADLINES: Readonly<Record<MedSlot, string>> = {
  morning: '10:00',
  noon: '14:00',
  evening: '20:00',
  bedtime: '23:00',
}

/** 画面の「未」を取り直す間隔（ms）。今日の表示だけ、この間隔で締めを判定し直す */
export const MED_RECHECK_MS = 60_000

const HM_RE = /^(\d{1,2}):(\d{2})$/
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** 'H:MM' → 0時からの分。読めなければ null */
export function hmToMinutes(hm: string): number | null {
  const m = HM_RE.exec(hm)
  if (m === null) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** 締め時刻（0時からの分）。deadlines を渡せば差し替えられる（将来の設定化用） */
export function deadlineMinutes(slot: MedSlot, deadlines: Readonly<Record<MedSlot, string>> = MED_DEADLINES): number {
  return hmToMinutes(deadlines[slot]) ?? 24 * 60
}

/** 端末の時刻の「0時からの分」 */
export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * その日のその時間帯が締めを過ぎているか。
 * ・今日より前の日 … 過ぎている　・今日より後の日 … 過ぎていない　・今日 … 今の時刻が締め時刻以降なら過ぎている
 */
export function isPastDeadline(
  slot: MedSlot,
  day: string,
  today: string,
  nowMin: number,
  deadlines: Readonly<Record<MedSlot, string>> = MED_DEADLINES,
): boolean {
  if (day < today) return true
  if (day > today) return false
  return nowMin >= deadlineMinutes(slot, deadlines)
}

// ── 時間帯の設定 ────────────────────────────────────────────────────────────

/** 受け取った時間帯の配列を正規化する（知らない値・重複は落とし、朝→昼→夕→眠前の順にそろえる） */
export function normalizeMedSlots(v: unknown): MedSlot[] {
  if (!Array.isArray(v)) return []
  const set = new Set(v.filter((x): x is string => typeof x === 'string'))
  return MED_SLOTS.filter((s) => set.has(s))
}

/** 2つの時間帯の設定が同じか（順は問わない） */
export function sameMedSlots(a: readonly MedSlot[], b: readonly MedSlot[]): boolean {
  const na = normalizeMedSlots(a)
  const nb = normalizeMedSlots(b)
  return na.length === nb.length && na.every((s, i) => s === nb[i])
}

// ── 1日の表 ────────────────────────────────────────────────────────────────

/**
 * 表の1マス。
 * none    … その人にこの時間帯の設定が無く、記録も無い（「—」・押せない）
 * record  … 記録がある（状態の1文字。押すと状態の小窓）
 * missing … 設定があり、締めを過ぎても記録が無い（「未」）
 * open    … 設定があり、締め前で記録が無い（空欄。押すと「服用済み」で記録）
 */
export type MedCell =
  | { kind: 'none' }
  | { kind: 'record'; record: MedAdmin }
  | { kind: 'missing' }
  | { kind: 'open' }

export interface MedDayRow {
  residentId: number
  /** その人の設定（朝→眠前の順） */
  configured: MedSlot[]
  cells: Record<MedSlot, MedCell>
}

/** 1マスを決める（締めの判定は isPastDeadline） */
export function medCellOf(p: {
  configured: boolean
  record: MedAdmin | null
  slot: MedSlot
  day: string
  today: string
  nowMin: number
}): MedCell {
  if (p.record !== null) return { kind: 'record', record: p.record }
  if (!p.configured) return { kind: 'none' }
  return isPastDeadline(p.slot, p.day, p.today, p.nowMin) ? { kind: 'missing' } : { kind: 'open' }
}

/**
 * 1日の表を組む。行は order（居室順の在籍の利用者ID）の順。
 * order に居ない人でも、その日に時間帯の記録がある人は後ろ（ID順）に足す（記録を無言で隠さない）。
 * 頓服（prn）はこの表に入れない（下の頓服の区画）。同じマスに記録が2件あれば新しい id を採る。
 */
export function buildMedDayRows(p: {
  order: number[]
  slotsByResident: ReadonlyMap<number, readonly MedSlot[]>
  records: MedAdmin[]
  day: string
  today: string
  nowMin: number
}): MedDayRow[] {
  const byResident = new Map<number, Map<MedSlot, MedAdmin>>()
  for (const r of p.records) {
    if (r.admin_on !== p.day || r.slot === 'prn') continue
    const m = byResident.get(r.resident_id) ?? new Map<MedSlot, MedAdmin>()
    const prev = m.get(r.slot)
    if (prev === undefined || r.id > prev.id) m.set(r.slot, r)
    byResident.set(r.resident_id, m)
  }
  const ids: number[] = []
  const seen = new Set<number>()
  for (const id of p.order) {
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  const extra = Array.from(byResident.keys())
    .filter((id) => !seen.has(id))
    .sort((a, b) => a - b)
  return [...ids, ...extra].map((id) => {
    const configured = normalizeMedSlots(p.slotsByResident.get(id) ?? [])
    const recs = byResident.get(id)
    const cells = {} as Record<MedSlot, MedCell>
    for (const slot of MED_SLOTS) {
      cells[slot] = medCellOf({
        configured: configured.includes(slot),
        record: recs?.get(slot) ?? null,
        slot,
        day: p.day,
        today: p.today,
        nowMin: p.nowMin,
      })
    }
    return { residentId: id, configured, cells }
  })
}

/** 落薬・誤薬（事故・ヒヤリハットとして記録が要る状態） */
export function isIncidentStatus(s: MedStatus): boolean {
  return s === 'dropped' || s === 'wrong'
}

/**
 * 上部の件数。「未記録 N」「落薬・誤薬 N」
 * ・未記録 … 「未」のマスの数（締めを過ぎた設定のある時間帯で記録が無い）
 * ・落薬・誤薬 … その状態の記録の数
 * ・記録済み … 記録のあるマスの数
 */
export function countMedDay(rows: MedDayRow[]): { missing: number; incident: number; recorded: number } {
  let missing = 0
  let incident = 0
  let recorded = 0
  for (const r of rows) {
    for (const slot of MED_SLOTS) {
      const c = r.cells[slot]
      if (c.kind === 'missing') missing += 1
      if (c.kind === 'record') {
        recorded += 1
        if (isIncidentStatus(c.record.status)) incident += 1
      }
    }
  }
  return { missing, incident, recorded }
}

/**
 * マスを押した時の動き。
 * ・押せない（none・封鎖中・未送信の記録がある・保存中）… 'none'
 * ・記録がある … 'dialog'（状態の小窓）
 * ・未記録（空欄・「未」）… 'insert'（「服用済み」で記録する）
 */
export function tapActionOf(cell: MedCell, blocked: boolean): 'none' | 'dialog' | 'insert' {
  if (blocked || cell.kind === 'none') return 'none'
  if (cell.kind === 'record') return 'dialog'
  return 'insert'
}

/** その時間帯で選べる状態（頓服は「服用済み」だけ） */
export function statusChoicesFor(slot: MedAdminSlot): readonly MedStatus[] {
  return slot === 'prn' ? ['taken'] : MED_STATUSES
}

// ── 入力の検証（画面と db.ts の両方で通す） ────────────────────────────────

export interface MedAdminInput {
  admin_on: string
  slot: MedAdminSlot
  status: MedStatus
  given_at: string | null
  prn_drug: string | null
  prn_reason: string | null
  prn_effect: string | null
  note: string | null
}

export type MedInputCheck = { ok: true } | { ok: false; message: string }

/** 使用時刻を少しだけ先の時刻まで許す（端末の時計のずれ） */
const FUTURE_GRACE_MS = 5 * 60_000

/** ISO の時刻を端末の日付（YYYY-MM-DD）に。読めなければ null */
export function localDayOf(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** ISO の時刻 → 端末の時刻 'H:MM'。読めなければ '' */
export function fmtClock(iso: string | null): string {
  if (iso === null || iso === '') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** ISO の時刻 → 入力欄の値 'HH:MM'。読めなければ '' */
export function clockInputValue(iso: string | null): string {
  if (iso === null || iso === '') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 日付 'YYYY-MM-DD' と時刻 'HH:MM'（端末の時刻）→ ISO 8601。読めなければ null */
export function localDateTimeIso(day: string, hm: string): string | null {
  const dm = DAY_RE.exec(day)
  const min = hmToMinutes(hm)
  if (dm === null || min === null) return null
  const d = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Math.floor(min / 60), min % 60, 0, 0)
  if (Number.isNaN(d.getTime()) || d.getDate() !== Number(dm[3])) return null
  return d.toISOString()
}

const blank = (s: string | null): boolean => s === null || s.trim() === ''

/**
 * 保存前の検証。today は端末の今日（JST の業務日付）、now は端末の現在時刻。
 * ・日付は今日以前 ・時間帯と状態は決まった値のどれか
 * ・頓服は「服用済み」だけ・使用時刻（その日の時刻・今より先は不可）・薬・理由が必須（空白だけも不可）
 * ・頓服以外は使用時刻・薬・理由・効果を持たない（null）
 */
export function validateMedAdminInput(v: MedAdminInput, today: string, now: Date = new Date()): MedInputCheck {
  if (!DAY_RE.test(v.admin_on)) return { ok: false, message: '日付を読み取れませんでした。日付を選び直してください。' }
  if (DAY_RE.test(today) && v.admin_on > today) {
    return { ok: false, message: '未来の日付には記録できません。日付を今日以前にしてください。' }
  }
  if (!(MED_ADMIN_SLOTS as readonly string[]).includes(v.slot)) {
    return { ok: false, message: '時間帯を読み取れませんでした。画面を読み直してから、もう一度お試しください。' }
  }
  if (!(MED_STATUSES as readonly string[]).includes(v.status)) {
    return { ok: false, message: '状態を選んでください。' }
  }
  if (v.slot === 'prn') {
    if (v.status !== 'taken') return { ok: false, message: '頓服は「服用済み」だけを記録できます。' }
    if (v.given_at === null || localDayOf(v.given_at) === null) {
      return { ok: false, message: '頓服を使った時刻を入れてください。' }
    }
    if (localDayOf(v.given_at) !== v.admin_on) {
      return { ok: false, message: '頓服を使った時刻は、選んでいる日付の時刻にしてください。' }
    }
    if (new Date(v.given_at).getTime() > now.getTime() + FUTURE_GRACE_MS) {
      return { ok: false, message: '頓服を使った時刻が今より先になっています。時刻を確かめてください。' }
    }
    if (blank(v.prn_drug)) return { ok: false, message: '頓服の薬を入れてください。' }
    if (blank(v.prn_reason)) return { ok: false, message: '頓服を使った理由を入れてください。' }
    return { ok: true }
  }
  if (v.given_at !== null || v.prn_drug !== null || v.prn_reason !== null || v.prn_effect !== null) {
    return { ok: false, message: '頓服の項目（時刻・薬・理由・効果）は頓服の記録にだけ入れられます。' }
  }
  return { ok: true }
}

// ── 月次表（1人） ──────────────────────────────────────────────────────────

/** 月次表の1マス。状態／締めを過ぎても記録なし（missing）／何もない（null） */
export type MedMonthMark = MedStatus | 'missing' | null

export interface MedMonthDay {
  day: string
  cells: Record<MedSlot, MedMonthMark>
  /** その日の頓服の回数 */
  prn: number
}

export interface MedMonthTotals {
  /** 状態ごとの件数（時間帯の記録だけ。頓服は prn に数える） */
  byStatus: Record<MedStatus, number>
  /** 「未」の数 */
  missing: number
  /** 頓服の回数 */
  prn: number
  /** 列ごとの記録の数と「未」の数 */
  bySlot: Record<MedSlot, { recorded: number; missing: number }>
}

export interface MedMonthTable {
  residentId: number
  days: MedMonthDay[]
  totals: MedMonthTotals
}

function emptyTotals(): MedMonthTotals {
  const byStatus = {} as Record<MedStatus, number>
  for (const s of MED_STATUSES) byStatus[s] = 0
  const bySlot = {} as Record<MedSlot, { recorded: number; missing: number }>
  for (const s of MED_SLOTS) bySlot[s] = { recorded: 0, missing: 0 }
  return { byStatus, missing: 0, prn: 0, bySlot }
}

/**
 * 1人の月次表を組む。行＝その月の1日〜月末、列＝朝・昼・夕・眠前・頓服。
 * ・マス … 記録があれば状態。記録が無く、次の全部を満たす時だけ「未」（missing）:
 *     その人の設定（slots＝現在の設定）にある時間帯／締めを過ぎている（今日より前の日、または今日の締め時刻以降）／
 *     startDay（施設全体で最初の与薬の記録の日）以降。startDay が null（記録が1件も無い）なら付けない／退居された方でない
 * ・頓服 … その日の頓服の回数
 * その人・その月以外の記録は数えない。同じマスに記録が2件あれば新しい id を採る。
 */
export function aggregateMedMonth(p: {
  monthKey: string
  residentId: number
  slots: readonly MedSlot[]
  records: MedAdmin[]
  startDay: string | null
  today: string
  nowMin: number
  retired?: boolean
}): MedMonthTable {
  const days = monthDays(p.monthKey)
  const inMonth = new Set(days)
  const configured = new Set(normalizeMedSlots(p.slots))
  const cellRec = new Map<string, MedAdmin>()
  const prnCount = new Map<string, number>()
  for (const r of p.records) {
    if (r.resident_id !== p.residentId || !inMonth.has(r.admin_on)) continue
    if (r.slot === 'prn') {
      prnCount.set(r.admin_on, (prnCount.get(r.admin_on) ?? 0) + 1)
      continue
    }
    const key = `${r.admin_on}|${r.slot}`
    const prev = cellRec.get(key)
    if (prev === undefined || r.id > prev.id) cellRec.set(key, r)
  }
  const totals = emptyTotals()
  const out: MedMonthDay[] = days.map((day) => {
    const cells = {} as Record<MedSlot, MedMonthMark>
    for (const slot of MED_SLOTS) {
      const rec = cellRec.get(`${day}|${slot}`)
      if (rec !== undefined) {
        cells[slot] = rec.status
        totals.byStatus[rec.status] += 1
        totals.bySlot[slot].recorded += 1
        continue
      }
      const missing =
        configured.has(slot) &&
        p.retired !== true &&
        p.startDay !== null &&
        day >= p.startDay &&
        isPastDeadline(slot, day, p.today, p.nowMin)
      if (missing) {
        totals.missing += 1
        totals.bySlot[slot].missing += 1
      }
      cells[slot] = missing ? 'missing' : null
    }
    const prn = prnCount.get(day) ?? 0
    totals.prn += prn
    return { day, cells, prn }
  })
  return { residentId: p.residentId, days: out, totals }
}

/** 月次表の「未」の1文字 */
export const MED_MONTH_MISSING_MARK = '未'
