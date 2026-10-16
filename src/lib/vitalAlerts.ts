// バイタル・食事・水分の見やすさ（A1・A2・A3・A5・A6・A9。2026-10-16 本人回答）の判定の純関数（副作用なし・DB/DOM に触れない）。
// 基準値は vitalThresholds.ts（A8）から読む。引数 t を省くと「いまの基準値」（既定値か app_settings の上書き）を使う。
//
//   A1 平熱との差   … judgeTemp（今の 37.5↑・38.1↑↑・35.5↓↓ の印は残し、平熱+1.0℃以上で「平熱+…↑」。両方なら重い方の印＋平熱差の注記）
//   A9 SpO2 の個別の下限 … spo2Limits・spo2LevelFor（個別の下限が無い方は 93 未満＝注意・90 未満＝危険）
//   A3 水分の目標   … fluidTargetOf・fluidProgress（「800／1,200ml（67%）」と横棒の割合）
//   A2 摂取低下     … mealHalfOrLess・mealDayLow・mealLowStreaks・mealLowLabel（1日に2食以上が主＋副10以下＝▼摂取低下（N日目））
//   A6 濃淡の段階   … intakeShade・mealShade（5段階＋半分以下は斜線）
//   A5 今日の要注意 … buildDayAlerts（その日の利用者ごとの理由の一覧）
//
// 数の比べ方: 体温は 0.1℃ 単位の整数（Math.round(x*10)）、水分の割合は百分率の整数で比べる（37.3−36.3 が 0.9999… になる
// 浮動小数の誤差で境目が外れないように）。
// 拡張子付きで import する（tests から node で直接読めるようにするため）。個人情報は扱わない（型と計算だけ）。

import { LEVEL_MARK, MED_SLOT_LABEL, MED_SLOTS, diaBpLevel, pulseLevel, sysBpLevel } from './types.ts'
import type { Level, Meal, MealSlot, MedSlot, Note, Vital } from './types.ts'
import type { MedDayRow } from './med.ts'
import { MEAL_CHART_SLOTS, mealIntake } from './chart.ts'
import { FLUID_TARGET_RANGE, MEAL_FULL, SPO2_LIMIT_RANGE, spo2LevelBy, tempLevelBy, vitalThresholds } from './vitalThresholds.ts'
import type { VitalThresholds } from './vitalThresholds.ts'

// ══════════════════════════════════════════════════════════════
// 個別の目標（resident_targets・0034）と平熱（vital_usual_temps・0034）の形
// ══════════════════════════════════════════════════════════════

/** 方ごとの個別の目標（1人1件）。null＝施設の既定を使う */
export interface ResidentTargets {
  id: number
  resident_id: number
  /** 水分の1日の目標（ml）。null＝施設の既定（初期 1,200ml） */
  fluid_target_ml: number | null
  /** SpO2 の個別の注意の下限（この値未満で ↓）。危険の下限と2つ組 */
  spo2_warn_below: number | null
  /** SpO2 の個別の危険の下限（この値未満で ↓↓） */
  spo2_danger_below: number | null
  rev: number
}

/** 保存する値（画面の入力。null＝その項目は施設の既定に戻す） */
export interface ResidentTargetsInput {
  fluid_target_ml: number | null
  spo2_warn_below: number | null
  spo2_danger_below: number | null
}

/** 個別の目標の入力の検証（サーバーの check 制約 0034 と同じ規則）。通らなければ理由の文 */
export function validateResidentTargets(v: ResidentTargetsInput): { ok: true } | { ok: false; message: string } {
  const f = v.fluid_target_ml
  if (f !== null && !(Number.isInteger(f) && f >= FLUID_TARGET_RANGE[0] && f <= FLUID_TARGET_RANGE[1])) {
    return { ok: false, message: `水分の目標は ${FLUID_TARGET_RANGE[0]}〜${fmtMl(FLUID_TARGET_RANGE[1])}ml の整数で入れてください。` }
  }
  const w = v.spo2_warn_below
  const d = v.spo2_danger_below
  if ((w === null) !== (d === null)) {
    return { ok: false, message: 'SpO2 の個別の下限は、注意と危険の両方を入れてください（片方だけは保存できません）。' }
  }
  if (w !== null && d !== null) {
    const inRange = (x: number) => Number.isInteger(x) && x >= SPO2_LIMIT_RANGE[0] && x <= SPO2_LIMIT_RANGE[1]
    if (!inRange(w) || !inRange(d)) {
      return { ok: false, message: `SpO2 の下限は ${SPO2_LIMIT_RANGE[0]}〜${SPO2_LIMIT_RANGE[1]}% の整数で入れてください。` }
    }
    if (d > w) return { ok: false, message: 'SpO2 の危険の下限は、注意の下限と同じかそれより低くしてください。' }
  }
  return { ok: true }
}

// ══════════════════════════════════════════════════════════════
// 書式
// ══════════════════════════════════════════════════════════════

/** 3桁ごとのカンマ（1200 → '1,200'）。端末の言語設定に左右されない */
export function fmtMl(n: number): string {
  const s = String(Math.round(n))
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 0.1 単位の整数（36.55 のような値も 0.1 単位に丸める） */
function tenths(x: number): number {
  return Math.round(x * 10)
}

/** 0.1 単位の整数を小数1桁の文字に（13 → '1.3'・-4 → '-0.4'） */
function fmtTenths(n: number): string {
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  return `${sign}${Math.floor(a / 10)}.${a % 10}`
}

// ══════════════════════════════════════════════════════════════
// A1 平熱との差
// ══════════════════════════════════════════════════════════════

/** 体温の判定の結果 */
export interface TempJudge {
  /** 今の印の段階（37.5↑・38.1↑↑・35.5↓↓。平熱とは関係なく今までどおり） */
  level: Level
  /** 平熱より usualTempRise（初期 +1.0℃）以上高いか（平熱が無い時は false） */
  overUsual: boolean
  /** 平熱との差（℃・小数1桁。平熱か体温が無ければ null） */
  diff: number | null
  /** 出す印。今の印があればそれ（重い方）・無くて平熱を超えていれば「平熱+1.2↑」・どちらも無ければ null */
  mark: string | null
  /** 両方当たる時の平熱差の注記（「平熱+1.2」）。片方だけの時は null */
  note: string | null
}

/**
 * 体温を、今の基準（tempLevel）と平熱（usual）の両方で判定する。
 * usual は vital_usual_temps の値（5回未満で null）。null・undefined なら A1 は出さない（今の印だけ）
 */
export function judgeTemp(temp: number | null, usual: number | null | undefined, t: VitalThresholds = vitalThresholds()): TempJudge {
  const level = tempLevelBy(temp, t)
  if (temp == null || !Number.isFinite(temp) || usual == null || !Number.isFinite(usual)) {
    return { level, overUsual: false, diff: null, mark: level ? LEVEL_MARK[level] : null, note: null }
  }
  const d = tenths(temp) - tenths(usual)
  const overUsual = d >= tenths(t.usualTempRise)
  const diffText = `平熱+${fmtTenths(d)}`
  let mark: string | null = null
  if (level) mark = LEVEL_MARK[level]
  else if (overUsual) mark = `${diffText}↑`
  return { level, overUsual, diff: d / 10, mark, note: level && overUsual ? diffText : null }
}

/** 平熱の表示（36.5 → '36.5'。null は null） */
export function fmtUsualTemp(usual: number | null | undefined): string | null {
  return usual == null || !Number.isFinite(usual) ? null : fmtTenths(tenths(usual))
}

// ══════════════════════════════════════════════════════════════
// A9 SpO2 の個別の下限
// ══════════════════════════════════════════════════════════════

/** その方の SpO2 の下限（individual＝個別の下限を使っているか） */
export function spo2Limits(
  target: ResidentTargets | null | undefined,
  t: VitalThresholds = vitalThresholds(),
): { warnBelow: number; dangerBelow: number; individual: boolean } {
  const w = target?.spo2_warn_below
  const d = target?.spo2_danger_below
  if (w != null && d != null && validateResidentTargets({ fluid_target_ml: null, spo2_warn_below: w, spo2_danger_below: d }).ok) {
    return { warnBelow: w, dangerBelow: d, individual: true }
  }
  return { warnBelow: t.spo2.warnBelow, dangerBelow: t.spo2.dangerBelow, individual: false }
}

/** SpO2 を、その方の下限（個別の下限が無い・壊れていれば施設の基準）で判定する */
export function spo2LevelFor(v: number | null, target: ResidentTargets | null | undefined, t: VitalThresholds = vitalThresholds()): Level {
  const lim = spo2Limits(target, t)
  return spo2LevelBy(v, t, lim)
}

// ══════════════════════════════════════════════════════════════
// A3 水分の目標
// ══════════════════════════════════════════════════════════════

/** その方の水分の目標（ml）。個別の目標が無い・範囲外なら施設の既定 */
export function fluidTargetOf(target: ResidentTargets | null | undefined, t: VitalThresholds = vitalThresholds()): { ml: number; individual: boolean } {
  const f = target?.fluid_target_ml
  if (f != null && Number.isInteger(f) && f >= FLUID_TARGET_RANGE[0] && f <= FLUID_TARGET_RANGE[1]) return { ml: f, individual: true }
  return { ml: t.fluidTargetMl, individual: false }
}

export interface FluidProgress {
  /** その日の合計（ml。記録が無ければ 0） */
  total: number
  /** 記録が1件でもあるか（totalMl に null を渡した時 false） */
  recorded: boolean
  /** 目標（ml） */
  target: number
  /** 個別の目標か */
  individual: boolean
  /** 目標に対する百分率（整数・四捨五入。100 を超えることもある） */
  percent: number
  /** 横棒の長さ（0〜1。目標を超えたら 1） */
  bar: number
  /** 「800／1,200ml（67%）」 */
  label: string
}

/** 水分の日合計と目標の比（A3） */
export function fluidProgress(
  totalMl: number | null | undefined,
  target: ResidentTargets | null | undefined,
  t: VitalThresholds = vitalThresholds(),
): FluidProgress {
  const recorded = totalMl != null && Number.isFinite(totalMl)
  const total = recorded ? Math.max(0, Math.round(totalMl as number)) : 0
  const tg = fluidTargetOf(target, t)
  const percent = Math.round((total * 100) / tg.ml)
  return {
    total,
    recorded,
    target: tg.ml,
    individual: tg.individual,
    percent,
    bar: Math.min(1, total / tg.ml),
    label: `${fmtMl(total)}／${fmtMl(tg.ml)}ml（${percent}%）`,
  }
}

/**
 * 水分不足か（A5）: 目標の fluidShort.ratio（初期 60%）未満。境目ちょうど（720／1,200ml）は不足でない。
 * 時刻の条件は buildDayAlerts が見る（ここは量だけ）
 */
export function isFluidShort(totalMl: number | null | undefined, target: ResidentTargets | null | undefined, t: VitalThresholds = vitalThresholds()): boolean {
  const total = totalMl != null && Number.isFinite(totalMl) ? Math.max(0, Math.round(totalMl)) : 0
  const tg = fluidTargetOf(target, t).ml
  return total * 100 < tg * Math.round(t.fluidShort.ratio * 100)
}

// ══════════════════════════════════════════════════════════════
// A2 摂取低下（1日に2食以上が半分以下）
// ══════════════════════════════════════════════════════════════

/**
 * 1食が「半分以下」か。true＝半分以下（主＋副が mealHalf.max 以下・拒食）／false＝半分より多い／
 * null＝数えない（外出・入院・主食副食とも未記入・間食・記録なし）。食事の状態が喫食か未設定の食事は量で、拒食は半分以下に数える
 */
export function mealHalfOrLess(m: Meal | undefined, t: VitalThresholds = vitalThresholds()): boolean | null {
  if (!m || !MEAL_CHART_SLOTS.includes(m.meal_slot)) return null
  const v = mealIntake(m) // 拒食は 0・外出／入院と未記入は null（chart.ts と同じ数え方）
  if (v == null) return null
  return v <= t.mealHalf.max
}

export interface MealDayLow {
  /** 数えた食事（朝・昼・夕のうち、喫食・未設定で量のあるもの＋拒食） */
  counted: number
  /** そのうち半分以下の食事 */
  halfOrLess: number
  /** ▼摂取低下か（半分以下が mealHalf.minMeals 食以上） */
  low: boolean
}

/** 1人1日の食事（同じ枠に複数あれば id の大きい方＝表と同じ）から、摂取低下かを決める */
export function mealDayLow(meals: readonly Meal[], t: VitalThresholds = vitalThresholds()): MealDayLow {
  const bySlot = new Map<MealSlot, Meal>()
  for (const m of meals) {
    if (!m) continue
    const prev = bySlot.get(m.meal_slot)
    if (!prev || m.id > prev.id) bySlot.set(m.meal_slot, m)
  }
  let counted = 0
  let half = 0
  for (const slot of MEAL_CHART_SLOTS) {
    const r = mealHalfOrLess(bySlot.get(slot), t)
    if (r === null) continue
    counted += 1
    if (r) half += 1
  }
  return { counted, halfOrLess: half, low: half >= t.mealHalf.minMeals }
}

export interface MealLowDay extends MealDayLow {
  day: string
  /** 摂取低下が続いている日数（その日を含む。低下でない日は 0） */
  streak: number
}

/** 'YYYY-MM-DD' の翌日 */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * 利用者ごと・日ごとの摂取低下と連続日数（A2）。渡した食事の範囲の中だけで数える
 * （表示の初日の「N日目」を正しく出すには、表示より前の数日分も渡す）。食事の記録が1件も無い日は低下でない＝連続が切れる
 */
export function mealLowStreaks(meals: readonly Meal[], t: VitalThresholds = vitalThresholds()): Map<number, Map<string, MealLowDay>> {
  const byRes = new Map<number, Map<string, Meal[]>>()
  for (const m of meals) {
    if (!m || typeof m.meal_on !== 'string') continue
    const days = byRes.get(m.resident_id) ?? new Map<string, Meal[]>()
    const list = days.get(m.meal_on) ?? []
    list.push(m)
    days.set(m.meal_on, list)
    byRes.set(m.resident_id, days)
  }
  const out = new Map<number, Map<string, MealLowDay>>()
  for (const [rid, days] of byRes) {
    const res = new Map<string, MealLowDay>()
    let prevDay: string | null = null
    let prevStreak = 0
    for (const day of [...days.keys()].sort()) {
      const d = mealDayLow(days.get(day) ?? [], t)
      const streak = d.low ? (prevDay !== null && nextDay(prevDay) === day ? prevStreak : 0) + 1 : 0
      res.set(day, { ...d, day, streak })
      prevDay = day
      prevStreak = streak
    }
    out.set(rid, res)
  }
  return out
}

/** 摂取低下の印（1日目は「▼摂取低下」・2日目からは「▼摂取低下（2日目）」）。0 以下は '' */
export function mealLowLabel(streak: number): string {
  if (!(streak >= 1)) return ''
  return streak === 1 ? '▼摂取低下' : `▼摂取低下（${Math.floor(streak)}日目）`
}

// ══════════════════════════════════════════════════════════════
// A6 摂取量の濃淡
// ══════════════════════════════════════════════════════════════

/**
 * マスの地の濃淡の段階。stage は 0〜4 の5段階（4＝全量・0＝ほとんど食べていない）。hatched＝半分以下（斜線を重ねる）。
 * 色の割り当てと斜線の描き方は画面の側（色だけに頼らない＝数字は残す）
 */
export interface IntakeShade {
  stage: 0 | 1 | 2 | 3 | 4
  hatched: boolean
}

/** 段階の数 */
export const INTAKE_SHADE_STAGES = 5

function stageOf(amount: number, full: number): IntakeShade['stage'] {
  // 全量＝4・8割以上＝3・半分より多い＝2・2割より多い＝1・それ以下＝0（0〜10 なら 10／8〜9／6〜7／3〜5／0〜2）
  if (amount >= full) return 4
  if (amount * 10 >= full * 8) return 3
  if (amount * 2 > full) return 2
  if (amount * 5 > full) return 1
  return 0
}

/** 主食または副食の1マス（0〜full。既定 10）の濃淡。値が無い・数でない時は null。範囲外は端にそろえる */
export function intakeShade(amount: number | null | undefined, full = 10): IntakeShade | null {
  if (amount == null || !Number.isFinite(amount) || !(full > 0)) return null
  const a = Math.min(full, Math.max(0, amount))
  return { stage: stageOf(a, full), hatched: a * 2 <= full }
}

/**
 * 1食（主＋副 0〜20）の濃淡。斜線は A2 と同じ「主＋副が mealHalf.max 以下」。拒食は 0（段階 0・斜線）、
 * 外出・入院・未記入は null（地を塗らない）
 */
export function mealShade(m: Meal | undefined, t: VitalThresholds = vitalThresholds()): IntakeShade | null {
  const v = mealIntake(m)
  if (v == null) return null
  const a = Math.min(MEAL_FULL, Math.max(0, v))
  return { stage: stageOf(a, MEAL_FULL), hatched: a <= t.mealHalf.max }
}

// ══════════════════════════════════════════════════════════════
// A5 今日の要注意
// ══════════════════════════════════════════════════════════════

/** 理由の種類（並びはこの順） */
export type AlertKind = 'vital' | 'mealLow' | 'fluidShort' | 'criticalNote' | 'medMissing'

/** 押した時に移るカルテの欄 */
export type AlertSection = 'vitals' | 'meals' | 'notes' | 'meds'

export interface AlertReason {
  kind: AlertKind
  section: AlertSection
  /** 'danger'＝危険（↑↑・↓↓）／'warn'＝注意（それ以外） */
  severity: 'danger' | 'warn'
  /** 画面に出す短い文（色に頼らない印つき。氏名・本文は入れない） */
  label: string
  /** 測定・記録の時刻（'HH:MM'。無ければ null） */
  time: string | null
  /** 元の記録の id（バイタル・申し送り。無ければ null） */
  recordId: number | null
}

export interface ResidentAlerts {
  residentId: number
  reasons: AlertReason[]
}

export interface DayAlertsInput {
  /** 対象の日（'YYYY-MM-DD'・日本時間の業務日） */
  day: string
  /** 今日（日本時間） */
  today: string
  /** いまの時刻（日本時間・0 時からの分）。今日の水分不足は fluidShort.fromHour 時以降だけ出す */
  nowMin: number
  /** 対象の方（並び順。階で絞った在籍の方）。ここに居ない方の理由は出さない */
  residentIds: readonly number[]
  /** バイタル（day の分を使う。取り消し済みは渡さない） */
  vitals: readonly Vital[]
  /** 食事（day を含む数日分。連続日数を数えるため前の日も渡す） */
  meals: readonly Meal[]
  /** day の水分の合計（利用者ID → ml。記録の無い方は入れなくてよい＝0ml） */
  fluidTotals: ReadonlyMap<number, number>
  /** 申し送り（最重要＝importance 'critical' の、その方のものを拾う。day の分と、続いている継続） */
  notes: readonly Note[]
  /** 与薬の1日の表（med.ts の buildMedDayRows の結果）。「未」の時間帯を拾う。省くと与薬は見ない */
  medRows?: readonly MedDayRow[]
  /** 平熱（利用者ID → 平熱。5回未満は null・無い方は入れなくてよい） */
  usualTemps: ReadonlyMap<number, number | null>
  /** 個別の目標（利用者ID → 目標） */
  targets: ReadonlyMap<number, ResidentTargets>
  /** 基準値（省くといまの基準値） */
  thresholds?: VitalThresholds
}

const sevOf = (lv: Level): 'danger' | 'warn' => (lv === 'danger-high' || lv === 'danger-low' ? 'danger' : 'warn')
const hm = (v: string | null): string | null => (typeof v === 'string' && /^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : null)

/** 1件のバイタルの基準外の理由（体温＝A1 込み・血圧・脈・SpO2＝A9 込み） */
function vitalReasons(v: Vital, usual: number | null | undefined, target: ResidentTargets | undefined, t: VitalThresholds): AlertReason[] {
  const out: AlertReason[] = []
  const base = { kind: 'vital' as const, section: 'vitals' as const, time: hm(v.measured_at), recordId: v.id }
  if (v.temp != null) {
    const j = judgeTemp(v.temp, usual, t)
    if (j.level) {
      // 今の印（重い方）＋両方当たる時は平熱差の注記: 「体温 37.8↑（平熱+1.3）」
      out.push({ ...base, severity: sevOf(j.level), label: `体温 ${v.temp.toFixed(1)}${j.mark}${j.note ? `（${j.note}）` : ''}` })
    } else if (j.overUsual) {
      // 平熱との差だけ: 「体温 37.3（平熱+1.0↑）」
      out.push({ ...base, severity: 'warn', label: `体温 ${v.temp.toFixed(1)}（${j.mark}）` })
    }
  }
  const sl = sysBpLevel(v.sys_bp)
  const dl = diaBpLevel(v.dia_bp)
  if (sl || dl) {
    const part = (x: number | null, lv: Level) => `${x ?? '—'}${lv ? LEVEL_MARK[lv] : ''}`
    const severity = sl === 'danger-high' || dl === 'danger-high' ? 'danger' : 'warn'
    out.push({ ...base, severity, label: `血圧 ${part(v.sys_bp, sl)}/${part(v.dia_bp, dl)}` })
  }
  const pl = pulseLevel(v.pulse)
  if (pl) out.push({ ...base, severity: sevOf(pl), label: `脈拍 ${v.pulse}${LEVEL_MARK[pl]}` })
  const ol = spo2LevelFor(v.spo2, target, t)
  if (ol) {
    const lim = spo2Limits(target, t)
    out.push({ ...base, severity: sevOf(ol), label: `SpO2 ${v.spo2}%${LEVEL_MARK[ol]}${lim.individual ? '（個別の下限）' : ''}` })
  }
  return out
}

/** その方のその日の食事が、外出・入院だけか（水分不足を出さない＝施設に居なかった） */
function awayAllDay(meals: readonly Meal[]): boolean {
  const main = meals.filter((m) => MEAL_CHART_SLOTS.includes(m.meal_slot))
  return main.length > 0 && main.every((m) => m.status === 'out' || m.status === 'hospital')
}

/**
 * その日の要注意の一覧（A5）。residentIds の順に、理由が1つ以上ある方だけを返す。理由の並びは
 * バイタル（測定の順）→ 摂取低下 → 水分不足 → 最重要の申し送り → 与薬の「未」
 */
export function buildDayAlerts(p: DayAlertsInput): ResidentAlerts[] {
  const t = p.thresholds ?? vitalThresholds()
  const want = new Set(p.residentIds)
  const streaks = mealLowStreaks(p.meals.filter((m) => want.has(m.resident_id) && m.meal_on <= p.day), t)
  // 水分不足を見てよいか: 過ぎた日はいつでも・今日は fromHour 時以降・先の日は見ない
  const fluidOpen = p.day < p.today || (p.day === p.today && p.nowMin >= t.fluidShort.fromHour * 60)
  const medByRes = new Map<number, MedDayRow>()
  for (const r of p.medRows ?? []) medByRes.set(r.residentId, r)

  const out: ResidentAlerts[] = []
  const seen = new Set<number>()
  for (const rid of p.residentIds) {
    if (seen.has(rid)) continue
    seen.add(rid)
    const reasons: AlertReason[] = []
    const target = p.targets.get(rid)

    // バイタル（測定の時刻順・時刻の無いものは後ろ）
    const vs = p.vitals
      .filter((v) => v.resident_id === rid && v.measured_on === p.day)
      .slice()
      .sort((a, b) => (hm(a.measured_at) ?? '99:99').localeCompare(hm(b.measured_at) ?? '99:99') || a.id - b.id)
    for (const v of vs) reasons.push(...vitalReasons(v, p.usualTemps.get(rid), target, t))

    // 摂取低下（A2）
    const ml = streaks.get(rid)?.get(p.day)
    if (ml && ml.low) {
      reasons.push({ kind: 'mealLow', section: 'meals', severity: 'warn', label: mealLowLabel(ml.streak), time: null, recordId: null })
    }

    // 水分不足（A3 の目標の fluidShort.ratio 未満）
    if (fluidOpen) {
      const dayMeals = p.meals.filter((m) => m.resident_id === rid && m.meal_on === p.day)
      const total = p.fluidTotals.get(rid) ?? 0
      if (!(awayAllDay(dayMeals) && total === 0) && isFluidShort(total, target, t)) {
        reasons.push({ kind: 'fluidShort', section: 'meals', severity: 'warn', label: `水分 ${fluidProgress(total, target, t).label}`, time: null, recordId: null })
      }
    }

    // 最重要の申し送り（その日の分と、その日に続いている継続）
    for (const n of p.notes) {
      if (n.resident_id !== rid || n.importance !== 'critical') continue
      const onDay = n.note_on === p.day
      const ongoing = n.ongoing && n.ended_at == null && n.note_on <= p.day
      if (!onDay && !ongoing) continue
      reasons.push({ kind: 'criticalNote', section: 'notes', severity: 'danger', label: ongoing && !onDay ? '最重要の申し送り（継続）' : '最重要の申し送り', time: hm(n.occurred_at), recordId: n.id })
    }

    // 与薬の「未」
    const med = medByRes.get(rid)
    if (med) {
      const miss = (MED_SLOTS as readonly MedSlot[]).filter((s) => med.cells[s]?.kind === 'missing')
      if (miss.length > 0) {
        reasons.push({ kind: 'medMissing', section: 'meds', severity: 'warn', label: `与薬 未（${miss.map((s) => MED_SLOT_LABEL[s]).join('・')}）`, time: null, recordId: null })
      }
    }

    if (reasons.length > 0) out.push({ residentId: rid, reasons })
  }
  return out
}

/** その日の水分の合計（利用者ID → ml）。取り消し済みは渡さない。数でない量は 0 として数える（chart.ts の mealDays と同じ） */
export function fluidTotalsOf(fluids: readonly { resident_id: number; taken_on: string; amount_ml: number }[], day: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const f of fluids) {
    if (!f || f.taken_on !== day) continue
    const add = typeof f.amount_ml === 'number' && Number.isFinite(f.amount_ml) ? f.amount_ml : 0
    out.set(f.resident_id, (out.get(f.resident_id) ?? 0) + add)
  }
  return out
}
