// バイタル・食事・水分の基準値の正本（A8・2026-10-16 本人回答）。
// 以前は types.ts の tempLevel など（判定）と KartePage の帯（グラフ）に同じ数値が別々に書かれていた。ここに1か所でまとめ、
// 判定（types.ts の tempLevel・sysBpLevel・diaBpLevel・pulseLevel・spo2Level・isLowIntake）も、グラフの帯（KartePage）も、
// A1〜A9 の新しい判定（vitalAlerts.ts）も、ここの値を読む。
//
// 本番で値を変える方法: app_settings のキー 'vital_thresholds' に JSON を入れる（読むだけ。app_settings は 0022 で現場の
// ログインから書けないので、変えるのは Supabase の SQL エディタ）。書いた項目だけが既定を上書きする（書かない項目は既定）。例:
//   insert into app_settings (key, value) values ('vital_thresholds', '{"temp":{"warnHigh":37.4},"fluidTargetMl":1300}')
//   on conflict (key) do update set value = excluded.value, updated_at = now();
// 受け取った値は信じない（multi-device-sync 原則10）: JSON として読めない・数でない・範囲の外・注意と危険の順が逆、の
// どれか1つでもあれば**全部を既定値に戻す**（一部だけ採ると、どの値が効いているか現場で分からなくなるため）。
//
// 上書きの効き方: db.ts の loadVitalThresholds が起動中に1回読み、applyVitalThresholds で「いまの基準値」を差し替える。
// types.ts の tempLevel などは呼ばれるたびに vitalThresholds() を読むので、差し替えた後に描いた画面から効く
// （差し替える前に描いた画面は、次に描き直すまで既定のまま）。chart.ts の LOW_INTAKE_MAX は読み込み時の既定値の写し（定数）。
//
// 拡張子付きで import する（tests から node で直接読めるようにするため。med.ts と同じ）。個人情報は扱わない。

import type { Level } from './types.ts'

/** 基準値の一式（数の意味は各項目の注記。判定の向き＝「以上」「未満」「以下」は関数の側に固定） */
export interface VitalThresholds {
  /** 体温（℃）: dangerHigh 以上＝↑↑・warnHigh 以上＝↑・dangerLow 以下＝↓↓ */
  temp: { dangerHigh: number; warnHigh: number; dangerLow: number }
  /** 血圧の上（mmHg）: dangerHigh 以上＝↑↑・warnLow 未満＝↓ */
  sysBp: { dangerHigh: number; warnLow: number }
  /** 血圧の下（mmHg）: dangerHigh 以上＝↑↑・warnLow 未満＝↓ */
  diaBp: { dangerHigh: number; warnLow: number }
  /** 脈拍（回/分）: dangerHigh 以上＝↑↑・warnLow 未満＝↓ */
  pulse: { dangerHigh: number; warnLow: number }
  /** SpO2（%）: dangerBelow 未満＝↓↓・warnBelow 未満＝↓（A9 の個別の下限が無い方に使う） */
  spo2: { warnBelow: number; dangerBelow: number }
  /** 低摂取の ▲（1食の主食＋副食がこの値以下） */
  lowIntakeMax: number
  /** A1: 平熱よりこの値（℃）以上高ければ「平熱+…↑」 */
  usualTempRise: number
  /** A2: 1食の主食＋副食（0〜20）が max 以下の食事が、1日に minMeals 食以上あれば「▼摂取低下」 */
  mealHalf: { max: number; minMeals: number }
  /** A3: 水分の1日の目標（ml）。個別の目標が無い方に使う */
  fluidTargetMl: number
  /** A5: fromHour 時以降（日本時間）に、その日の水分が目標の ratio 未満なら「水分不足」 */
  fluidShort: { ratio: number; fromHour: number }
}

/** 既定値（2026-10-16 時点の運用の値。types.ts・KartePage に別々にあった値をそのまま移した） */
export const DEFAULT_VITAL_THRESHOLDS: VitalThresholds = Object.freeze({
  temp: Object.freeze({ dangerHigh: 38.1, warnHigh: 37.5, dangerLow: 35.5 }),
  sysBp: Object.freeze({ dangerHigh: 151, warnLow: 90 }),
  diaBp: Object.freeze({ dangerHigh: 91, warnLow: 50 }),
  pulse: Object.freeze({ dangerHigh: 101, warnLow: 40 }),
  spo2: Object.freeze({ warnBelow: 93, dangerBelow: 90 }),
  lowIntakeMax: 6,
  usualTempRise: 1.0,
  mealHalf: Object.freeze({ max: 10, minMeals: 2 }),
  fluidTargetMl: 1200,
  fluidShort: Object.freeze({ ratio: 0.6, fromHour: 16 }),
}) as VitalThresholds

/** app_settings のキー */
export const VITAL_THRESHOLDS_SETTING_KEY = 'vital_thresholds'

/** 1食の主食＋副食の満点（主食・副食とも 0〜10。DB の check 制約と同じ） */
export const MEAL_FULL = 20

let current: VitalThresholds = DEFAULT_VITAL_THRESHOLDS

/** いまの基準値（上書きが無い・壊れている時は既定値） */
export function vitalThresholds(): VitalThresholds {
  return current
}

/** いまの基準値を差し替える（db.ts が app_settings を読んだ後に呼ぶ。null で既定値へ戻す）。検証は parseVitalThresholds で済ませた値を渡す */
export function applyVitalThresholds(t: VitalThresholds | null): void {
  current = t ?? DEFAULT_VITAL_THRESHOLDS
}

// ── 上書きの読み取り ─────────────────────────────────────────────────────────

/** 読み取りの結果。ok=false の時 value は既定値で、reason に理由（画面には出さない・試験と記録用） */
export interface ThresholdsParse {
  value: VitalThresholds
  ok: boolean
  /** 'none'＝上書きなし（未登録・空）／'json'＝JSON として読めない／'shape'＝形・範囲・順序の誤り／'ok' */
  reason: 'none' | 'json' | 'shape' | 'ok'
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 既定の上に、書かれた項目だけを重ねる（型は見ない＝後で validate が全部見る）。知らない項目は捨てる */
function overlay(base: Record<string, unknown>, over: unknown): Record<string, unknown> | null {
  if (!isObj(over)) return null
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(base)) {
    const b = base[k]
    if (!Object.prototype.hasOwnProperty.call(over, k)) {
      out[k] = isObj(b) ? { ...b } : b
      continue
    }
    const o = over[k]
    if (isObj(b)) {
      const inner = overlay(b, o)
      if (inner === null) return null // 入れ子のはずの所に数などが来た＝形の誤り
      out[k] = inner
    } else {
      out[k] = o
    }
  }
  return out
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const int = (v: unknown): v is number => fin(v) && Number.isInteger(v)

/** 形・範囲・順序が正しいか（1つでも外れたら false） */
export function isValidThresholds(t: unknown): t is VitalThresholds {
  if (!isObj(t)) return false
  const temp = t.temp
  const sys = t.sysBp
  const dia = t.diaBp
  const pulse = t.pulse
  const spo2 = t.spo2
  const half = t.mealHalf
  const short = t.fluidShort
  if (!isObj(temp) || !isObj(sys) || !isObj(dia) || !isObj(pulse) || !isObj(spo2) || !isObj(half) || !isObj(short)) return false
  // 体温: 30 ≤ 危険の低 < 注意の高 < 危険の高 ≤ 45（DB の check 制約 30〜45 の内側）
  if (!fin(temp.dangerLow) || !fin(temp.warnHigh) || !fin(temp.dangerHigh)) return false
  if (!(temp.dangerLow >= 30 && temp.dangerLow < temp.warnHigh && temp.warnHigh < temp.dangerHigh && temp.dangerHigh <= 45)) return false
  // 血圧・脈: 下限 ≤ 注意の低 < 危険の高 ≤ 上限（DB の check 制約の範囲）
  const pair = (g: Record<string, unknown>, lo: number, hi: number): boolean =>
    fin(g.warnLow) && fin(g.dangerHigh) && g.warnLow >= lo && g.warnLow < g.dangerHigh && g.dangerHigh <= hi
  if (!pair(sys, 40, 300) || !pair(dia, 20, 200) || !pair(pulse, 20, 250)) return false
  // SpO2: 50 ≤ 危険 ≤ 注意 ≤ 100（同じ値は「注意の帯なし」）
  if (!fin(spo2.dangerBelow) || !fin(spo2.warnBelow)) return false
  if (!(spo2.dangerBelow >= 50 && spo2.dangerBelow <= spo2.warnBelow && spo2.warnBelow <= 100)) return false
  if (!int(t.lowIntakeMax) || t.lowIntakeMax < 0 || t.lowIntakeMax > MEAL_FULL) return false
  if (!fin(t.usualTempRise) || t.usualTempRise < 0.1 || t.usualTempRise > 5) return false
  if (!int(half.max) || half.max < 0 || half.max > MEAL_FULL) return false
  if (!int(half.minMeals) || half.minMeals < 1 || half.minMeals > 3) return false
  if (!int(t.fluidTargetMl) || t.fluidTargetMl < FLUID_TARGET_RANGE[0] || t.fluidTargetMl > FLUID_TARGET_RANGE[1]) return false
  if (!fin(short.ratio) || short.ratio <= 0 || short.ratio > 1) return false
  if (!int(short.fromHour) || short.fromHour < 0 || short.fromHour > 23) return false
  return true
}

/**
 * app_settings の 'vital_thresholds' の値（文字列）を読む。null・空＝上書きなし。
 * 壊れていれば既定値（ok=false）。書かれた項目だけが既定を上書きする
 */
export function parseVitalThresholds(raw: unknown): ThresholdsParse {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { value: DEFAULT_VITAL_THRESHOLDS, ok: true, reason: 'none' }
  }
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { value: DEFAULT_VITAL_THRESHOLDS, ok: false, reason: 'json' }
    }
  }
  const merged = overlay(DEFAULT_VITAL_THRESHOLDS as unknown as Record<string, unknown>, parsed)
  if (merged === null || !isValidThresholds(merged)) return { value: DEFAULT_VITAL_THRESHOLDS, ok: false, reason: 'shape' }
  return { value: merged, ok: true, reason: 'ok' }
}

// ── 判定（types.ts の tempLevel などはここを、いまの基準値で呼ぶ） ───────────────

export function tempLevelBy(v: number | null, t: VitalThresholds): Level {
  if (v == null) return null
  if (v >= t.temp.dangerHigh) return 'danger-high'
  if (v >= t.temp.warnHigh) return 'warn-high'
  if (v <= t.temp.dangerLow) return 'danger-low'
  return null
}

function highLowLevel(v: number | null, g: { dangerHigh: number; warnLow: number }): Level {
  if (v == null) return null
  if (v >= g.dangerHigh) return 'danger-high'
  if (v < g.warnLow) return 'warn-low'
  return null
}

export function sysBpLevelBy(v: number | null, t: VitalThresholds): Level {
  return highLowLevel(v, t.sysBp)
}
export function diaBpLevelBy(v: number | null, t: VitalThresholds): Level {
  return highLowLevel(v, t.diaBp)
}
export function pulseLevelBy(v: number | null, t: VitalThresholds): Level {
  return highLowLevel(v, t.pulse)
}

/** SpO2 の判定。limits を渡すとその下限（A9 の個別の下限）で、省くと t.spo2 で判定する */
export function spo2LevelBy(v: number | null, t: VitalThresholds, limits?: { warnBelow: number; dangerBelow: number }): Level {
  if (v == null) return null
  const g = limits ?? t.spo2
  if (v < g.dangerBelow) return 'danger-low'
  if (v < g.warnBelow) return 'warn-low'
  return null
}

// ── 個別の目標（A3・A9）の値の範囲（サーバーの check 制約 0034 と同じ。変える時は移行と同時に） ──

/** 水分の目標（ml）として受け付ける範囲（両端を含む） */
export const FLUID_TARGET_RANGE: readonly [number, number] = [100, 5000]
/** SpO2 の個別の下限として受け付ける範囲（両端を含む） */
export const SPO2_LIMIT_RANGE: readonly [number, number] = [50, 100]
