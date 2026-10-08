// カルテのグラフ（自前SVG・KartePage の VitalChart）の寸法と縦軸を決める純関数（2026-10-08 代表指示）。
// 「画面内になるべく広げて、数値や傾向ができるだけ読み取れる状態にする」ための部品:
// - 縦軸は記録の値に合わせて拡大する（しきい値・帯は軸に含めない。範囲外のしきい値は軸の端に「38.1↑」で示す）
// - 目盛は区切りのよい値（体温0.5刻み・血圧10刻みなど）。点が詰まる時は刻みを 2・5・10 倍に広げる
// - グラフの高さは画面の高さから決める（200〜360px）。印刷は今までと同じ 160px
// - 食事・水分のグラフの値（表と同じ集計）
// React に依存しない（tests/chart.test.mjs から node で直接読む）。個人情報は持たない。

import type { FluidIntake, Meal, MealSlot } from './types'

// ══════════════════════════════════════════════════════════════
// 縦軸
// ══════════════════════════════════════════════════════════════

export interface AxisSpec {
  /** 記録が無い時の表示範囲 */
  base: readonly [number, number]
  /**
   * 縦軸の最小の幅（値の単位）。記録の幅がこれより狭い時は、記録の中央を保ってここまで広げる。
   * 測定のばらつき程度の差がグラフいっぱいの上下に見えて、急変と取り違えるのを防ぐ
   */
  minSpan: number
  /** 目盛の基本の刻み（区切りのよい値）。軸の両端もこの倍数にそろえる */
  step: number
  /** 値としてありうる範囲（SpO2 は 100 まで等）。表示範囲をこの内側へずらす */
  bounds?: readonly [number, number]
  /** 記録に関係なく固定する範囲（食事 0〜20。点数の上限・下限が決まっている指標は軸が動かない方が読める） */
  fixed?: readonly [number, number]
}

/**
 * 指標ごとの縦軸。最小の幅は「目盛2本分（刻み×2）が必ず見える」でそろえた:
 * - 体温 1.0℃（0.5×2）: 腋窩温の測り直しで 0.2〜0.3℃ は普通に動く。1.0℃ あれば 0.1℃ 刻みの差が誇張されない
 * - 血圧 20mmHg（10×2）: 同じ人でも測るたびに 10mmHg 前後は動く。上下2本の線があるので普段はこれより広い
 * - 脈拍 20回/分（10×2）: 体動・会話で 10回/分 程度は動く
 * - SpO2 4%（1×2 の余裕込み）: パルスオキシメータの誤差は ±2% 程度。値は 100 を超えない
 * - 体重 2kg（1×2）: 着衣・食事の前後で 0.5〜1kg は動く。月1回の測定で増減の向きが読める幅
 * - 水分 500ml（250×2）: 1回の提供量（コップ1杯 200〜250ml）の2回分
 */
export const KARTE_AXES = {
  temp: { base: [35, 39], minSpan: 1.0, step: 0.5, bounds: [30, 45] },
  bp: { base: [40, 180], minSpan: 20, step: 10, bounds: [20, 300] },
  pulse: { base: [40, 120], minSpan: 20, step: 10, bounds: [20, 250] },
  spo2: { base: [88, 100], minSpan: 4, step: 1, bounds: [50, 100] },
  weight: { base: [40, 60], minSpan: 2, step: 1, bounds: [0, 300] },
  /** 主食＋副食（各 0〜10 の合計）。0〜20 で固定 */
  meal: { base: [0, 20], minSpan: 20, step: 5, fixed: [0, 20] },
  fluid: { base: [0, 1500], minSpan: 500, step: 250, bounds: [0, 10000] },
} as const satisfies Record<string, AxisSpec>

const EPS = 1e-9

/** 浮動小数の誤差を落とす（36.500000000004 → 36.5） */
function clean(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

/**
 * 表示範囲 [下端, 上端]。
 * 記録の最小〜最大 → 最小の幅まで中央を保って広げる → 値としてありうる範囲の内側へずらす
 * → 刻みの倍数へ外側にそろえる → 両端に刻みの半分の余白（端の点・記号が枠に貼り付かないように）。
 * 記録が無い時は base を同じ手順で整える。固定の指標は記録に関係なく fixed に 5% の余白。
 * しきい値・帯は範囲に含めない（含めると平熱の人の軸が 35〜39℃ に引き伸ばされて動きが読めない）
 */
export function chartDomain(values: Iterable<number>, axis: AxisSpec): [number, number] {
  if (axis.fixed) {
    const pad = (axis.fixed[1] - axis.fixed[0]) * 0.05
    return [clean(axis.fixed[0] - pad), clean(axis.fixed[1] + pad)]
  }
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (lo === Infinity) {
    lo = axis.base[0]
    hi = axis.base[1]
  }
  if (hi - lo < axis.minSpan) {
    const c = (lo + hi) / 2
    lo = c - axis.minSpan / 2
    hi = c + axis.minSpan / 2
  }
  if (axis.bounds) {
    const [b0, b1] = axis.bounds
    if (lo < b0) {
      hi += b0 - lo
      lo = b0
    }
    if (hi > b1) {
      lo -= hi - b1
      hi = b1
    }
    lo = Math.max(lo, b0)
    hi = Math.min(hi, b1)
  }
  const s = axis.step
  lo = Math.floor(lo / s + EPS) * s
  hi = Math.ceil(hi / s - EPS) * s
  return [clean(lo - s / 2), clean(hi + s / 2)]
}

/** 刻みの広げ方（基本の刻みの何倍まで広げるか） */
const STEP_MULTIPLES = [1, 2, 5, 10, 20, 50, 100]

/**
 * 目盛の値。基本の刻みで目盛の間隔が minGapPx 未満になる時は 2・5・10 倍…と広げる
 * （文字を大きくした端末・低いグラフでも目盛の数字が重ならない）。
 */
export function chartTicks(
  domain: [number, number],
  step: number,
  plotH: number,
  minGapPx: number,
): { step: number; values: number[] } {
  const span = domain[1] - domain[0]
  if (!(span > 0) || !(plotH > 0) || !(step > 0)) return { step, values: [] }
  let s = step * STEP_MULTIPLES[STEP_MULTIPLES.length - 1]
  for (const m of STEP_MULTIPLES) {
    if ((plotH * step * m) / span >= minGapPx) {
      s = step * m
      break
    }
  }
  const values: number[] = []
  const first = Math.ceil(domain[0] / s - EPS)
  const last = Math.floor(domain[1] / s + EPS)
  for (let k = first; k <= last; k++) values.push(clean(k * s))
  return { step: s, values }
}

// ══════════════════════════════════════════════════════════════
// しきい値（帯の端・基準線）を範囲の内と外に分ける
// ══════════════════════════════════════════════════════════════

export interface ThresholdMark {
  value: number
  label: string
}

/**
 * 範囲内のしきい値と、範囲外（上・下）のしきい値に分ける。
 * 上・下は「遠い順」（上は大きい順・下は小さい順）。軸の端から内側へ積むと、紙の上でも実際の並びと同じ順になる
 */
export function splitThresholds(
  marks: ThresholdMark[],
  domain: [number, number],
): { inside: ThresholdMark[]; above: ThresholdMark[]; below: ThresholdMark[] } {
  const inside: ThresholdMark[] = []
  const above: ThresholdMark[] = []
  const below: ThresholdMark[] = []
  for (const m of marks) {
    if (m.value > domain[1] + EPS) above.push(m)
    else if (m.value < domain[0] - EPS) below.push(m)
    else inside.push(m)
  }
  above.sort((a, b) => b.value - a.value)
  below.sort((a, b) => a.value - b.value)
  return { inside, above, below }
}

/** 範囲外のしきい値の表示文字（「38.1↑」＝しきい値はこの軸より上にある） */
export function offRangeText(label: string, side: 'above' | 'below'): string {
  return `${label}${side === 'above' ? '↑' : '↓'}`
}

/** 範囲外のしきい値の読み上げ文（グラフは role=img のため、SVG 内の文字は読み上げられない） */
export function offRangeSpeech(above: ThresholdMark[], below: ThresholdMark[]): string {
  const parts: string[] = []
  if (above.length > 0) parts.push(`しきい値 ${above.map((m) => m.label).join('・')} は表示範囲より上`)
  if (below.length > 0) parts.push(`しきい値 ${below.map((m) => m.label).join('・')} は表示範囲より下`)
  return parts.length > 0 ? `${parts.join('、')}にあります（縦軸は記録の値に合わせて拡大しています）。` : ''
}

// ══════════════════════════════════════════════════════════════
// 左の目盛の文字の並べ方（重なりを作らない）
// ══════════════════════════════════════════════════════════════

/**
 * 左の列の文字の縦位置（文字の中心）を決める。
 * - しきい値の文字（fixed）は優先して全部出す。lineH 未満に近づく時は下へずらし、下端を越える時は上へ押し戻す
 * - 目盛の文字（ticks）は、しきい値の文字・ほかの目盛の文字と lineH 未満に近づくもの・範囲外のものを出さない
 *   （目盛の線は残す。数字が重なって読めなくなるよりよい）
 * 返す ticks は出す目盛の添字
 */
export function layoutAxisLabels(
  fixed: number[],
  ticks: number[],
  lineH: number,
  top: number,
  bottom: number,
): { fixed: number[]; ticks: number[] } {
  const order = fixed.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y)
  const placed = order.map((o) => o.y)
  for (let k = 0; k < placed.length; k++) {
    const min = k === 0 ? top : placed[k - 1] + lineH
    if (placed[k] < min) placed[k] = min
  }
  for (let k = placed.length - 1; k >= 0; k--) {
    const max = k === placed.length - 1 ? bottom : placed[k + 1] - lineH
    if (placed[k] > max) placed[k] = max
  }
  const outFixed = new Array<number>(fixed.length)
  order.forEach((o, k) => {
    outFixed[o.i] = placed[k]
  })
  const keep: number[] = []
  let prev = -Infinity
  ticks
    .map((y, i) => ({ y, i }))
    .sort((a, b) => a.y - b.y)
    .forEach(({ y, i }) => {
      if (y < top - EPS || y > bottom + EPS) return
      if (y - prev < lineH - EPS) return
      if (placed.some((p) => Math.abs(p - y) < lineH - EPS)) return
      keep.push(i)
      prev = y
    })
  keep.sort((a, b) => a - b)
  return { fixed: outFixed, ticks: keep }
}

// ══════════════════════════════════════════════════════════════
// グラフの高さ
// ══════════════════════════════════════════════════════════════

export const CHART_H_MIN = 200
export const CHART_H_MAX = 360
/** 印刷の高さ（今までの紙と同じ） */
export const CHART_H_PRINT = 160

export interface ChartHeightInput {
  /** 画面（表示領域）の高さ */
  viewportH: number
  /** 上部の固定部分（アプリのヘッダ＋カルテの氏名バー） */
  topH: number
  /** 下部の固定部分（下のナビ。広い画面では 0） */
  bottomH: number
  /** グラフ1枚ごとの見出し・読み上げ行・数値表の開閉などの高さ */
  overheadH: number
  /** 1画面に収めたい枚数（iPhone は 1、広い画面は 2） */
  perScreen: number
}

/** グラフ1枚の高さ。使える高さを枚数で割り、見出しなどを除いた残り。200〜360px に収める */
export function chartHeight({ viewportH, topH, bottomH, overheadH, perScreen }: ChartHeightInput): number {
  const n = perScreen >= 1 ? Math.floor(perScreen) : 1
  const usable = viewportH - topH - bottomH
  const h = Math.floor(usable / n - overheadH)
  if (!Number.isFinite(h)) return CHART_H_MIN
  return Math.min(CHART_H_MAX, Math.max(CHART_H_MIN, h))
}

// ══════════════════════════════════════════════════════════════
// 食事・水分（表とグラフで同じ集計を使う）
// ══════════════════════════════════════════════════════════════

export interface MealDay {
  meals: Map<MealSlot, Meal>
  /** その日の水分の合計（ml）。記録が無ければ null */
  fluid: number | null
}

/** 日ごとの食事（同じ枠に複数行がある時は id の大きい＝後から入った行）と水分の合計 */
export function mealDays(meals: Meal[], fluids: FluidIntake[]): Map<string, MealDay> {
  const byDay = new Map<string, MealDay>()
  for (const m of meals) {
    if (!m || typeof m.meal_on !== 'string') continue
    const cell = byDay.get(m.meal_on) ?? { meals: new Map<MealSlot, Meal>(), fluid: null }
    const prev = cell.meals.get(m.meal_slot)
    if (!prev || m.id > prev.id) cell.meals.set(m.meal_slot, m)
    byDay.set(m.meal_on, cell)
  }
  for (const f of fluids) {
    if (!f || typeof f.taken_on !== 'string') continue
    const cell = byDay.get(f.taken_on) ?? { meals: new Map<MealSlot, Meal>(), fluid: null }
    const add = typeof f.amount_ml === 'number' && Number.isFinite(f.amount_ml) ? f.amount_ml : 0
    cell.fluid = (cell.fluid ?? 0) + add
    byDay.set(f.taken_on, cell)
  }
  return byDay
}

/** グラフに使う食事の枠（表と同じ朝・昼・夕。間食は量の尺度が違うため入れない） */
export const MEAL_CHART_SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner']

/**
 * 1食の主食＋副食（0〜20）。外出・入院・拒食や、主食・副食とも未記入の食事は null（＝平均に入れない。
 * 表の「▲低摂取」の判定 isLowIntake と同じ扱い）
 */
export function mealIntake(m: Meal | undefined): number | null {
  if (!m) return null
  if (m.status && m.status !== 'eaten') return null
  const main = typeof m.main_amount === 'number' && Number.isFinite(m.main_amount) ? m.main_amount : null
  const side = typeof m.side_amount === 'number' && Number.isFinite(m.side_amount) ? m.side_amount : null
  if (main == null && side == null) return null
  return (main ?? 0) + (side ?? 0)
}

/** 日ごとの「1食あたりの主食＋副食」の平均（小数1桁）。数えられる食事が無い日は値を持たない（線を切る） */
export function mealIntakeSeries(byDay: Map<string, MealDay>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [day, cell] of byDay) {
    let sum = 0
    let n = 0
    for (const slot of MEAL_CHART_SLOTS) {
      const v = mealIntake(cell.meals.get(slot))
      if (v == null) continue
      sum += v
      n += 1
    }
    if (n > 0) out.set(day, Math.round((sum / n) * 10) / 10)
  }
  return out
}

/** 日ごとの水分の合計（ml）。記録の無い日は値を持たない */
export function fluidSeries(byDay: Map<string, MealDay>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [day, cell] of byDay) if (cell.fluid != null) out.set(day, cell.fluid)
  return out
}

/** 低摂取の目安（主＋副がこの値以下。表の ▲ と同じ isLowIntake の値） */
export const LOW_INTAKE_MAX = 6
