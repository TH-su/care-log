// 温度板（A7・2026-10-16 本人回答）の中身の組み立て（純関数・副作用なし・DB/DOM に触れない）。
// 紙に出す形（TempSheet.tsx）はここの結果を描くだけ。tests/vital-display-screens.test.mjs から node で直接読む。
//
// ・期間は今日を含む14日（古い順）。カルテが読んだ記録（表示期間は最短でも2週＝14日を含む）から作る＝新しく読みに行かない
// ・バイタルは1日1点（カルテのグラフと同じ選び方: 定時→再検→経過観察→他症状の順、同じ区分は時刻の早い方・「翌」は夜の後ろ）
// ・体温の印は今の基準（↑・↑↑・↓↓）を優先し、平熱+1.0℃以上だけの時は「平熱+1.2↑」（A1・judgeTemp）
// ・SpO2 は個別の下限があればそれで判定（A9・spo2LevelFor）
// ・食事は朝・昼・夕の主／副（同じ枠に2行あれば id の大きい方＝カルテの表と同じ）。半分以下（主＋副10以下・拒食）は斜線（A6）、
//   1食6以下は ▲（今までの低摂取の印）。拒食・外出・入院は1文字（拒・外・入）
// ・摂取低下（A2）は表示の外の前の日も数えた連続日数（▼・▼2日目）
// ・水分（A3）は日合計と目標との比（記録が無い日は空）
// 個人情報は扱わない（数値と記号だけ。氏名は描く側が持つ）。

import { LEVEL_MARK, isLowIntake } from '../../lib/types.ts'
import type { FluidIntake, Level, Meal, MealSlot, Vital, VitalKind } from '../../lib/types.ts'
import { timeSortKey, vitalIsNextMorning } from '../../lib/nextMorning.ts'
import { vitalThresholds } from '../../lib/vitalThresholds.ts'
import type { VitalThresholds } from '../../lib/vitalThresholds.ts'
import { fluidProgress, fluidTargetOf, judgeTemp, mealLowStreaks, mealShade, spo2LevelFor, spo2Limits } from '../../lib/vitalAlerts.ts'
import type { ResidentTargets } from '../../lib/vitalAlerts.ts'

/** 温度板の日数 */
export const TEMP_SHEET_DAYS = 14

/** 表の食事の枠（朝・昼・夕） */
export const TEMP_SHEET_SLOTS: readonly MealSlot[] = ['breakfast', 'lunch', 'dinner']

/** 'YYYY-MM-DD' に n 日足す（UTC で数える＝端末の時刻帯に左右されない） */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return day
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** today を含む n 日（古い順） */
export function sheetDays(today: string, n: number = TEMP_SHEET_DAYS): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i))
  return out
}

export interface TempSheetInput {
  /** 並べる日（古い順・sheetDays） */
  days: readonly string[]
  /** この方の利用者ID（他の方の記録が混ざっても使わない） */
  residentId: number
  vitals: readonly Vital[]
  /** 食事（摂取低下の連続日数を数えるため、days より前の日も渡してよい） */
  meals: readonly Meal[]
  fluids: readonly FluidIntake[]
  /** 平熱（5回未満・読めない時は null） */
  usual: number | null | undefined
  /** 個別の目標（無ければ null） */
  target: ResidentTargets | null | undefined
  /** 基準値（省くといまの基準値） */
  thresholds?: VitalThresholds
}

export interface MealMark {
  /** マスの文字（'8/7'・'▲3/2'・'拒'・'外'・'入'・記録なしは ''） */
  text: string
  /** 半分以下（斜線を引く） */
  hatched: boolean
}

export interface TempSheetModel {
  days: string[]
  temp: (number | null)[]
  sys: (number | null)[]
  dia: (number | null)[]
  pulse: (number | null)[]
  spo2: (number | null)[]
  /** 体温の点の印（↑・↑↑・↓↓・平熱+1.2↑。無ければ null） */
  tempMarks: (string | null)[]
  /** 体温の点の段階（点を大きくする目安） */
  tempLevels: Level[]
  sysMarks: (string | null)[]
  diaMarks: (string | null)[]
  pulseMarks: (string | null)[]
  spo2Marks: (string | null)[]
  /** 平熱（無ければ null） */
  usual: number | null
  spo2Limits: { warnBelow: number; dangerBelow: number; individual: boolean }
  meals: Record<'breakfast' | 'lunch' | 'dinner', MealMark[]>
  /** 摂取低下の印（'▼'・'▼2日目'・無ければ ''） */
  lowLabels: string[]
  /** 水分（日合計 'ml' の数字と目標比 '67%'。記録なしは両方 ''） */
  fluid: { total: string; ratio: string }[]
  fluidTarget: { ml: number; individual: boolean }
  /** 基準値（線を引く値） */
  thresholds: VitalThresholds
}

const KIND_ORDER: Record<VitalKind, number> = { routine: 0, recheck: 1, observation: 2, symptom: 3 }

function cmpTime(a: string | null, b: string | null): number {
  const x = a ?? '99:99:99'
  const y = b ?? '99:99:99'
  return x < y ? -1 : x > y ? 1 : 0
}

/** カルテのグラフと同じ並び（日→区分→時刻（翌は夜の後ろ）→id） */
function cmpVital(a: Vital, b: Vital): number {
  return (
    (a.measured_on < b.measured_on ? -1 : a.measured_on > b.measured_on ? 1 : 0) ||
    (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
    cmpTime(timeSortKey(a.measured_at, vitalIsNextMorning(a)), timeSortKey(b.measured_at, vitalIsNextMorning(b))) ||
    a.id - b.id
  )
}

type Field = 'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2'

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 1日1点（並びの最初の実測値） */
function daily(sorted: readonly Vital[], field: Field, days: readonly string[]): (number | null)[] {
  const m = new Map<string, number>()
  for (const v of sorted) {
    if (m.has(v.measured_on)) continue
    const n = v[field]
    if (fin(n)) m.set(v.measured_on, n)
  }
  return days.map((d) => m.get(d) ?? null)
}

const markOf = (lv: Level): string | null => (lv ? LEVEL_MARK[lv] : null)

/** 1食のマス */
function mealMark(m: Meal | undefined, t: VitalThresholds): MealMark {
  if (!m) return { text: '', hatched: false }
  const hatched = mealShade(m, t)?.hatched === true
  if (m.status === 'refused') return { text: '拒', hatched }
  if (m.status === 'out') return { text: '外', hatched: false }
  if (m.status === 'hospital') return { text: '入', hatched: false }
  if (m.main_amount == null && m.side_amount == null) return { text: '', hatched: false }
  const low = isLowIntake(m)
  return { text: `${low ? '▲' : ''}${m.main_amount ?? '—'}/${m.side_amount ?? '—'}`, hatched }
}

/** 温度板の中身を組み立てる */
export function buildTempSheet(p: TempSheetInput): TempSheetModel {
  const t = p.thresholds ?? vitalThresholds()
  const days = [...p.days]
  const last = days[days.length - 1] ?? ''
  const mine = <T extends { resident_id: number }>(rows: readonly T[]): T[] => rows.filter((r) => r != null && r.resident_id === p.residentId)

  const sorted = mine(p.vitals).slice().sort(cmpVital)
  const temp = daily(sorted, 'temp', days)
  const sys = daily(sorted, 'sys_bp', days)
  const dia = daily(sorted, 'dia_bp', days)
  const pulse = daily(sorted, 'pulse', days)
  const spo2 = daily(sorted, 'spo2', days)
  const usual = fin(p.usual) ? p.usual : null

  const tempJudges = temp.map((v) => judgeTemp(v, usual, t))
  const tempMarks = tempJudges.map((j) => j.mark)
  const tempLevels: Level[] = tempJudges.map((j) => j.level ?? (j.overUsual ? 'warn-high' : null))

  // 食事（同じ枠に2行あれば id の大きい方）
  const meals = mine(p.meals)
  const pick = new Map<string, Meal>()
  for (const m of meals) {
    if (!TEMP_SHEET_SLOTS.includes(m.meal_slot)) continue
    const k = `${m.meal_on}|${m.meal_slot}`
    const prev = pick.get(k)
    if (!prev || m.id > prev.id) pick.set(k, m)
  }
  const mealRow = (slot: MealSlot) => days.map((d) => mealMark(pick.get(`${d}|${slot}`), t))

  // 摂取低下（前の日も数える。表示の最後の日より後は数えない）
  const streaks = mealLowStreaks(
    meals.filter((m) => m.meal_on <= last),
    t,
  ).get(p.residentId)
  const lowLabels = days.map((d) => {
    const s = streaks?.get(d)?.streak ?? 0
    return s <= 0 ? '' : s === 1 ? '▼' : `▼${s}日目`
  })

  // 水分
  const totals = new Map<string, number>()
  for (const f of mine(p.fluids)) {
    const add = fin(f.amount_ml) ? f.amount_ml : 0
    totals.set(f.taken_on, (totals.get(f.taken_on) ?? 0) + add)
  }
  const fluid = days.map((d) => {
    if (!totals.has(d)) return { total: '', ratio: '' }
    const fp = fluidProgress(totals.get(d), p.target, t)
    return { total: String(fp.total), ratio: `${fp.percent}%` }
  })

  return {
    days,
    temp,
    sys,
    dia,
    pulse,
    spo2,
    tempMarks,
    tempLevels,
    sysMarks: sys.map((v) => markOf(v == null ? null : levelHighLow(v, t.sysBp))),
    diaMarks: dia.map((v) => markOf(v == null ? null : levelHighLow(v, t.diaBp))),
    pulseMarks: pulse.map((v) => markOf(v == null ? null : levelHighLow(v, t.pulse))),
    spo2Marks: spo2.map((v) => markOf(spo2LevelFor(v, p.target, t))),
    usual,
    spo2Limits: spo2Limits(p.target, t),
    meals: { breakfast: mealRow('breakfast'), lunch: mealRow('lunch'), dinner: mealRow('dinner') },
    lowLabels,
    fluid,
    fluidTarget: fluidTargetOf(p.target, t),
    thresholds: t,
  }
}

/** 血圧・脈の段階（vitalThresholds.ts の判定と同じ向き: 危険の高 以上＝↑↑・注意の低 未満＝↓） */
function levelHighLow(v: number, g: { dangerHigh: number; warnLow: number }): Level {
  if (v >= g.dangerHigh) return 'danger-high'
  if (v < g.warnLow) return 'warn-low'
  return null
}

/**
 * 縦軸の範囲。既定の範囲（base）に値がはみ出したら、刻み（step）の単位で広げる（線が枠の外に出ないように）
 */
export function axisRange(values: readonly (number | null | undefined)[], base: readonly [number, number], step: number): [number, number] {
  let lo = base[0]
  let hi = base[1]
  for (const v of values) {
    if (!fin(v)) continue
    if (v < lo) lo = Math.floor(v / step) * step
    if (v > hi) hi = Math.ceil(v / step) * step
  }
  // 刻みの端数（0.1 の浮動小数の誤差）をそろえる
  const r = (x: number) => Math.round(x * 1000) / 1000
  return [r(lo), r(hi)]
}

/** 値 → 縦の位置（top が上端・bottom が下端。範囲の外は端に止める） */
export function scaleY(v: number, range: readonly [number, number], top: number, bottom: number): number {
  const span = range[1] - range[0] || 1
  const raw = bottom - ((v - range[0]) / span) * (bottom - top)
  return Math.min(bottom, Math.max(top, raw))
}
