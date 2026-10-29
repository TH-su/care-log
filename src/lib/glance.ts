// ひと目ボード（/glance/:id）と見守りボード（/glance）の集計の純関数（2026-10-29 本人承認の ROOT）。副作用なし・DB/DOM に触れない。
// GlancePage・GlanceBoardPage・開発用の見本（src/dev/glancePreview.tsx）が使う。tests/glance.test.mjs から node で直接読む。
//
// ・期間: 直近 R 日（既定 7・切替 14）対 その前の 28 日（基準の長さは固定）。平均は「日ごとの平均」を、記録のある日だけで
//   平均する（欠けた日・入院中/外泊中の日は分母に入れない）
// ・変化の兆し: 規則は GLANCE_RULES（数値はここ1か所）。判定は既存の部品を呼ぶ（体温＝judgeTemp・SpO2＝spo2LevelFor・
//   血圧/脈＝vitalThresholds の判定・摂取低下＝mealLowStreaks・水分の目標＝fluidTargetOf・排便＝excretionClient の写し）。
//   重い順に最大 8 件。入院中/外泊中の日は数えない。今日が入院中/外泊中なら兆しは出さない（見守りボードの「印は数えない」と同じ）
// ・医療の欄: res_glance_get の結果（db.ts の fetchResGlance が畳んだ ResGlanceResult）を状態に分け、行を string[] に整える
// ・端末に覚えるのは期間（cl_glanceRange）と並び（cl_glanceSort）の値だけ。ここは読み取り（既知値の照合）だけで、書くのは画面
//   （types.ts の LS は凍結契約のため、キーはここに置く＝alertsModel.ts の ALERTS_FLOOR_KEY と同じ作法）
// 拡張子付きで import する（tests から node で直接読めるようにするため）。db.ts・supabase・gasClient は import しない。
// 個人情報は持たない（型と計算だけ。氏名は呼ぶ側から受け取った値をそのまま返すだけで、保存しない）。

import { LEVEL_MARK, MED_SLOTS } from './types.ts'
import type { BathRecord, FluidIntake, Incident, Level, Meal, MealSlot, MedAdmin, MedSlot, Note, Outing, Resident, Vital } from './types.ts'
import type { MedDayRow } from './med.ts'
import { KARTE_AXES, MEAL_CHART_SLOTS, chartDomain, mealDays, mealIntake } from './chart.ts'
import { fluidTargetOf, fmtMl, judgeTemp, mealLowLabel, mealLowStreaks, spo2LevelFor } from './vitalAlerts.ts'
import type { ResidentTargets } from './vitalAlerts.ts'
import { MEAL_FULL, diaBpLevelBy, pulseLevelBy, sysBpLevelBy, vitalThresholds } from './vitalThresholds.ts'
import type { VitalThresholds } from './vitalThresholds.ts'
import {
  HAIBEN_DEFAULT_STOOL,
  HAIBEN_RECENT_DAYS,
  addDaysIsoUtc,
  excretionMatchMessage,
  matchExcretionResident,
  stoolAlertLabel,
  stoolResetSeries,
  stoolStatusOf,
} from './excretionClient.ts'
import type { HbRecord, HbSnapshot, StoolStatus } from './excretionClient.ts'
import type { WeightEntry } from './weightClient.ts'

// ══════════════════════════════════════════════════════════════
// 規則の数値（1か所。後で設定へ移せる形）
// ══════════════════════════════════════════════════════════════

/** 体重減少の目安の1期間（減少率 % が warnPct 以上で注意・dangerPct 以上で要注意） */
export interface WeightLossRule {
  months: 1 | 3 | 6
  warnPct: number
  dangerPct: number
}

export const GLANCE_RULES = Object.freeze({
  /** 直近の期間の既定（日）と基準の期間（日・固定） */
  recentDays: 7,
  baselineDays: 28,
  /** 温度板の幅（日） */
  boardDays: 14,
  /** 見守りボードの体温の小さい線の日数 */
  boardSparkDays: 7,
  /** 体重: 栄養スクリーニングの体重減少の目安（1か月 3%/5%・3か月 3%/7.5%・6か月 3%/10%） */
  weightLoss: Object.freeze([
    Object.freeze({ months: 1, warnPct: 3, dangerPct: 5 }),
    Object.freeze({ months: 3, warnPct: 3, dangerPct: 7.5 }),
    Object.freeze({ months: 6, warnPct: 3, dangerPct: 10 }),
  ]) as readonly WeightLossRule[],
  /** 水分: 直近 fluidDays 日（今日を除く）の1日平均が目標の fluidRatio 未満 */
  fluidRatio: 0.8,
  fluidDays: 3,
  /** 食事: 直近の平均（1食の主食＋副食を 10 段階に直した値）が基準より mealDrop10 以上低い */
  mealDrop10: 2,
  /** 与薬: 直近 medDays 日（今日を含む）に「未」「拒否」が合わせて medCount 回以上 */
  medCount: 2,
  medDays: 7,
  /** SpO2: 直近の平均が基準の平均より spo2Drop ポイント以上低い */
  spo2Drop: 2,
  /** 排便: 排便記録アプリの判定の既定（2日で注意・3日で要注意）。数は excretionClient の正本を指す */
  stool: HAIBEN_DEFAULT_STOOL,
  /** 排便の間隔を数える窓（日・今日を含む） */
  stoolWindowDays: HAIBEN_RECENT_DAYS,
  /** 記録の欠け: 直近 gapDays 日（今日を含む）にバイタルが1件も無い */
  gapDays: 3,
  /** 基準値の外れ（体温・血圧・脈・SpO2）を見る日数（今日を含む） */
  vitalLookbackDays: 3,
  /** 摂取低下（mealLowStreaks）を見る日数（今日を含む） */
  mealLowLookbackDays: 3,
  /** 事故・ヒヤリハットを兆しに数える日数（今日を含む） */
  incidentDays: 14,
  /** 兆しの最大件数 */
  signsMax: 8,
  /** 最新の体調変化: 申し送りの件数・事故とヒヤリの日数・与薬と入浴の中止の日数 */
  recentNotes: 5,
  recentIncidentDays: 30,
  recentMedDays: 7,
  recentBathDays: 14,
  /** 医療の欄: 写しがこの日数より古ければ「◯月◯日時点の写し」 */
  medicalStaleDays: 3,
  /** 差が flat（→）とみなす幅（絶対値がこれ未満なら flat） */
  flatBelow: Object.freeze({ temp: 0.1, sysBp: 1, diaBp: 1, pulse: 1, spo2: 1, meal10: 0.1, fluidMl: 10 }),
})

// ══════════════════════════════════════════════════════════════
// 期間と並び（端末に覚える UI 状態）
// ══════════════════════════════════════════════════════════════

/** 期間の保存先（ひと目ボードだけが使う） */
export const GLANCE_RANGE_KEY = 'cl_glanceRange'
/** 並びの保存先（見守りボードだけが使う） */
export const GLANCE_SORT_KEY = 'cl_glanceSort'

/** 直近の期間（'7'＝直近7日・'14'＝直近14日。基準はどちらもその前の28日） */
export type GlanceRange = '7' | '14'
export const GLANCE_RANGES: readonly GlanceRange[] = ['7', '14']
export const DEFAULT_GLANCE_RANGE: GlanceRange = '7'

/** 見守りボードの並び（'room'＝居室の順・'changes'＝変化の多い順） */
export type GlanceSort = 'room' | 'changes'
export const GLANCE_SORTS: readonly GlanceSort[] = ['room', 'changes']
export const DEFAULT_GLANCE_SORT: GlanceSort = 'room'

/** 保存した期間を読む（既知値だけ。壊れた値・未知値は既定の '7'） */
export function parseGlanceRange(raw: unknown): GlanceRange {
  return typeof raw === 'string' && (GLANCE_RANGES as readonly string[]).includes(raw) ? (raw as GlanceRange) : DEFAULT_GLANCE_RANGE
}

/** 保存した並びを読む（既知値だけ。壊れた値・未知値は既定の 'room'） */
export function parseGlanceSort(raw: unknown): GlanceSort {
  return typeof raw === 'string' && (GLANCE_SORTS as readonly string[]).includes(raw) ? (raw as GlanceSort) : DEFAULT_GLANCE_SORT
}

/** 期間の日数 */
export function rangeDays(range: GlanceRange): number {
  return range === '14' ? 14 : GLANCE_RULES.recentDays
}

export interface GlanceWindows {
  recentFrom: string
  recentTo: string
  baseFrom: string
  baseTo: string
  /** 温度板の始まり（今日−13日） */
  boardFrom: string
  /** 読み込みに要る始まり（基準・温度板・最新の体調変化の30日のうち最も古い日） */
  fetchFrom: string
}

/** 期間の境目（today は日本時間の今日 'YYYY-MM-DD'） */
export function glanceWindows(today: string, range: GlanceRange): GlanceWindows {
  const r = rangeDays(range)
  const recentFrom = addDaysIsoUtc(today, -(r - 1))
  const baseTo = addDaysIsoUtc(recentFrom, -1)
  const baseFrom = addDaysIsoUtc(baseTo, -(GLANCE_RULES.baselineDays - 1))
  const boardFrom = addDaysIsoUtc(today, -(GLANCE_RULES.boardDays - 1))
  const recentChangesFrom = addDaysIsoUtc(today, -(GLANCE_RULES.recentIncidentDays - 1))
  const fetchFrom = [baseFrom, boardFrom, recentChangesFrom].sort()[0]
  return { recentFrom, recentTo: today, baseFrom, baseTo, boardFrom, fetchFrom }
}

/** from〜to の日の列（古い順・両端を含む） */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  let d = from
  for (let i = 0; i < 400 && d <= to; i++) {
    out.push(d)
    d = addDaysIsoUtc(d, 1)
  }
  return out
}

/** 'YYYY-MM-DD' から n か月前（月末は丸める: 3/31 の1か月前は 2/28 か 2/29） */
export function addMonthsIso(day: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return day
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n
  const y = Math.floor(total / 12)
  const mo = total - y * 12
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
  const d = Math.min(Number(m[3]), last)
  return `${String(y).padStart(4, '0')}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// ══════════════════════════════════════════════════════════════
// 平均・差・向き
// ══════════════════════════════════════════════════════════════

export type Direction = 'up' | 'down' | 'flat'

/** 向きの記号（色だけに頼らない） */
export const DIRECTION_MARK: Readonly<Record<Direction, string>> = { up: '↑', down: '↓', flat: '→' }

/** 数の配列の平均（数でない値は捨てる。1つも無ければ null） */
export function meanOf(values: ReadonlyArray<number | null | undefined>): number | null {
  let sum = 0
  let n = 0
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    sum += v
    n += 1
  }
  return n > 0 ? sum / n : null
}

/**
 * 日ごとの値（day → 値）の、[from, to] の平均。値の無い日と skip の日（入院中/外泊中）は分母に入れない
 */
export function windowAverage(byDay: ReadonlyMap<string, number>, from: string, to: string, skip?: ReadonlySet<string>): { avg: number | null; days: number } {
  const vals: number[] = []
  for (const [day, v] of byDay) {
    if (day < from || day > to) continue
    if (skip?.has(day)) continue
    if (!Number.isFinite(v)) continue
    vals.push(v)
  }
  return { avg: meanOf(vals), days: vals.length }
}

/** 差（recent − base）と向き。どちらかが無ければ null。|差| が flatBelow 未満は flat */
export function compareAverages(recent: number | null, base: number | null, flatBelow: number): { diff: number | null; dir: Direction | null } {
  if (recent === null || base === null || !Number.isFinite(recent) || !Number.isFinite(base)) return { diff: null, dir: null }
  const diff = recent - base
  // 浮動小数の誤差（0.1 が 0.0999…）で境目が外れないよう、幅の 1/1000 単位の整数で比べる
  const scaled = Math.round((Math.abs(diff) / flatBelow) * 1000)
  if (scaled < 1000) return { diff, dir: 'flat' }
  return { diff, dir: diff > 0 ? 'up' : 'down' }
}

// ══════════════════════════════════════════════════════════════
// 入院中・外泊中
// ══════════════════════════════════════════════════════════════

export type AwayKind = 'hospital' | 'overnight'

/** 札の文字 */
export const AWAY_LABEL: Readonly<Record<AwayKind, string>> = { hospital: '入院中', overnight: '外泊中' }

/**
 * その方のその日が入院中/外泊中か。入院＝その日の食事の記録の状態が「入院」（excretionClient の isHospitalDay と同じ見分け）、
 * 外泊＝外泊（kind 'overnight'）の記録の期間（start_on〜end_on。帰着未定は続いている）に入る日。日帰りの外出は数える（不在扱いにしない）
 */
export function awayKindOn(
  meals: ReadonlyArray<Pick<Meal, 'resident_id' | 'meal_on' | 'status'>>,
  outings: ReadonlyArray<Pick<Outing, 'resident_id' | 'kind' | 'start_on' | 'end_on'>>,
  residentId: number,
  day: string,
): AwayKind | null {
  for (const m of meals) {
    if (m && m.resident_id === residentId && m.meal_on === day && m.status === 'hospital') return 'hospital'
  }
  for (const o of outings) {
    if (!o || o.resident_id !== residentId || o.kind !== 'overnight') continue
    if (o.start_on <= day && (o.end_on === null || o.end_on >= day)) return 'overnight'
  }
  return null
}

/**
 * 今日の札。今日の食事に入院がある・今日が外泊の期間、または今日の主な食事がまだ無く昨日が入院なら入院中（朝食の記録の前の時間帯）
 */
export function awayToday(
  meals: ReadonlyArray<Pick<Meal, 'resident_id' | 'meal_on' | 'status' | 'meal_slot'>>,
  outings: ReadonlyArray<Pick<Outing, 'resident_id' | 'kind' | 'start_on' | 'end_on'>>,
  residentId: number,
  today: string,
): AwayKind | null {
  const k = awayKindOn(meals, outings, residentId, today)
  if (k) return k
  const hasToday = meals.some((m) => m && m.resident_id === residentId && m.meal_on === today && MEAL_CHART_SLOTS.includes(m.meal_slot))
  if (!hasToday && awayKindOn(meals, [], residentId, addDaysIsoUtc(today, -1)) === 'hospital') return 'hospital'
  return null
}

// ══════════════════════════════════════════════════════════════
// 体重減少の目安
// ══════════════════════════════════════════════════════════════

export type Severity = 'danger' | 'warn'

export interface WeightPeriod {
  months: 1 | 3 | 6
  /** 基準の測定（期間の始まりの日以前で最も近い測定）。無ければ null */
  base: WeightEntry | null
  /** 減少率（%・小数2桁。増えた時は負）。基準か最新が無ければ null */
  lossPct: number | null
  level: Severity | null
}

export interface WeightLoss {
  latest: WeightEntry | null
  periods: WeightPeriod[]
  /** 最も重い期間（同じ重さなら短い期間） */
  worst: WeightPeriod | null
  level: Severity | null
}

/**
 * 体重の減少率（1・3・6か月）。各期間の基準＝「今日の n か月前の日」以前で最も近い測定（無ければその期間は null）。
 * 最新＝今日以前で最も新しい測定。最新が基準より後でなければ null。比べ方は 0.01% 単位の整数（境目ちょうどは当たる）
 */
export function classifyWeightLoss(
  entries: ReadonlyArray<WeightEntry> | null | undefined,
  today: string,
  rules: readonly WeightLossRule[] = GLANCE_RULES.weightLoss,
): WeightLoss {
  const list = (entries ?? [])
    .filter((e) => e && typeof e.date === 'string' && e.date <= today && typeof e.weight === 'number' && Number.isFinite(e.weight) && e.weight > 0)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const latest = list.length > 0 ? list[list.length - 1] : null
  const periods: WeightPeriod[] = rules.map((r) => {
    const start = addMonthsIso(today, -r.months)
    let base: WeightEntry | null = null
    for (const e of list) if (e.date <= start) base = e
    if (!base || !latest || latest.date <= base.date) return { months: r.months, base, lossPct: null, level: null }
    // 0.01% 単位: (基準−最新)/基準×10000（体重は 0.1kg 単位なので、10 倍の整数で割り算の誤差を避ける）
    const b10 = Math.round(base.weight * 10)
    const l10 = Math.round(latest.weight * 10)
    const bp = Math.round(((b10 - l10) * 10000) / b10)
    const level: Severity | null = bp >= Math.round(r.dangerPct * 100) ? 'danger' : bp >= Math.round(r.warnPct * 100) ? 'warn' : null
    return { months: r.months, base, lossPct: bp / 100, level }
  })
  let worst: WeightPeriod | null = null
  for (const p of periods) {
    if (!p.level) continue
    if (!worst || (p.level === 'danger' && worst.level !== 'danger')) worst = p
  }
  return { latest, periods, worst, level: worst?.level ?? null }
}

// ══════════════════════════════════════════════════════════════
// 医療の欄（res_glance_get）
// ══════════════════════════════════════════════════════════════

/**
 * db.ts の fetchResGlance の戻り（1人分）。row は受け取ったままの形（normalizeMedicalRow で整える）。
 * no_function＝関数がまだ無い（PGRST202/42883）・no_shadow＝写しが無い（row null か synced_at null）・error＝許可なし（42501）ほか
 */
export type ResGlanceResult =
  | { kind: 'ok'; row: unknown; syncedAt: string }
  | { kind: 'no_function' }
  | { kind: 'no_shadow'; syncedAt?: string | null }
  | { kind: 'error' }

export type MedicalState = 'ok' | 'no_function' | 'no_shadow' | 'not_linked' | 'error'

/** 状態ごとの欄の文（ROOT どおり。ok は文なし） */
export const MEDICAL_STATE_MESSAGE: Readonly<Record<Exclude<MedicalState, 'ok'>, string>> = {
  no_function: '病歴・内服薬の読む口がまだ用意されていません（管理者が共通 DB に 0037 を適用すると出ます）',
  no_shadow: '入居者マスタの写しがまだありません（管理者が入居者マスタを開くと1日1回写ります）',
  not_linked: 'マスタとの照合が済んでいません',
  error: '病歴・内服薬を読み込めませんでした。時間をおいて開き直してください。',
}

/** 医療の欄を読みに行ってよい方か（source_id が空・needs_review の方は呼ばない） */
export function medicalLinkable(resident: Pick<Resident, 'source_id' | 'needs_review'> | null | undefined): boolean {
  if (!resident) return false
  const sid = typeof resident.source_id === 'string' ? resident.source_id.trim() : ''
  return sid !== '' && resident.needs_review !== true
}

/** 医療の欄の状態。照合が済んでいない方は結果に関係なく not_linked。結果が無い（読めていない）は error */
export function classifyMedicalState(
  resident: Pick<Resident, 'source_id' | 'needs_review'> | null | undefined,
  result: ResGlanceResult | null | undefined,
): MedicalState {
  if (!medicalLinkable(resident)) return 'not_linked'
  if (!result || typeof result !== 'object') return 'error'
  switch (result.kind) {
    case 'ok':
      return 'ok'
    case 'no_function':
      return 'no_function'
    case 'no_shadow':
      return 'no_shadow'
    default:
      return 'error'
  }
}

/** 写しが古い時の注記（「10月24日時点の写し」）。新しい・読めない時は null。nowMs は Date.now() の値 */
export function medicalStaleText(syncedAt: string | null | undefined, nowMs: number): string | null {
  if (typeof syncedAt !== 'string' || syncedAt === '') return null
  const at = Date.parse(syncedAt)
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return null
  if (nowMs - at <= GLANCE_RULES.medicalStaleDays * 86400000) return null
  const d = new Date(at + 9 * 3600 * 1000)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日時点の写し`
}

export interface MedicalView {
  /** 満年齢（取れなければ null） */
  age: number | null
  allergy: string[]
  allergenTags: string[]
  forbiddenTags: string[]
  swallow: string[]
  mealForm: string[]
  thickener: string[]
  medicalCare: string[]
  infections: string[]
  medMgmt: string[]
  /** 病名表（{name,onset,hospital} は「病名（発症・医療機関）」の1行に） */
  diseases: string[]
  currentDiseases: string[]
  pastHistory: string[]
  sideEffects: string[]
  medsRegular: string[]
  /** 定期薬の行数（1行1剤） */
  medsRegularCount: number
  medsPrn: string[]
  highRiskMeds: string[]
  hospital: string[]
  doctor: string[]
  visitDay: string[]
}

/** 医療の欄の文字の項目（row の項目名と同じ） */
export const MEDICAL_TEXT_FIELDS = [
  'allergy',
  'allergenTags',
  'forbiddenTags',
  'swallow',
  'mealForm',
  'thickener',
  'medicalCare',
  'infections',
  'medMgmt',
  'currentDiseases',
  'pastHistory',
  'sideEffects',
  'medsRegular',
  'medsPrn',
  'highRiskMeds',
  'hospital',
  'doctor',
  'visitDay',
] as const

type MedicalTextField = (typeof MEDICAL_TEXT_FIELDS)[number]

/** 1つの値を行の列に（文字は改行で分ける・配列は要素ごと・数は文字に・null/真偽/オブジェクトは捨てる）。空行は捨てる */
export function toLines(v: unknown, depth = 0): string[] {
  if (v === null || v === undefined) return []
  if (typeof v === 'string') {
    return v
      .split(/\r\n|\r|\n/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
  }
  if (typeof v === 'number') return Number.isFinite(v) ? [String(v)] : []
  if (Array.isArray(v) && depth === 0) {
    const out: string[] = []
    for (const x of v) out.push(...toLines(x, depth + 1))
    return out
  }
  return []
}

/** 病名表の1要素（文字か {name,onset,hospital}）を1行に。名前の無いオブジェクト・壊れた形は null */
function diseaseLine(v: unknown): string | null {
  if (typeof v === 'string') {
    const s = v.trim()
    return s === '' ? null : s
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (name === '') return null
  const extra = [o.onset, o.hospital]
    .map((x) => (typeof x === 'string' ? x.trim() : typeof x === 'number' && Number.isFinite(x) ? String(x) : ''))
    .filter((s) => s !== '')
  return extra.length > 0 ? `${name}（${extra.join('・')}）` : name
}

/** 病名表（配列か文字）を行の列に */
function diseaseLines(v: unknown): string[] {
  if (typeof v === 'string') return toLines(v)
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    if (typeof x === 'string') out.push(...toLines(x))
    else {
      const line = diseaseLine(x)
      if (line !== null) out.push(line)
    }
  }
  return out
}

/** 年齢（整数 0〜130 だけ。数字の文字も受ける） */
function ageOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d{1,3}\s*$/.test(v) ? Number(v) : NaN
  return Number.isInteger(n) && n >= 0 && n <= 130 ? n : null
}

/** res_glance_get の row を画面の形へ。どの値も文字・配列・null・壊れた形がありうる前提で、壊れた形は空（画面は「—」）にする。例外は投げない */
export function normalizeMedicalRow(raw: unknown): MedicalView {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const text = {} as Record<MedicalTextField, string[]>
  for (const k of MEDICAL_TEXT_FIELDS) text[k] = toLines(o[k])
  return {
    age: ageOf(o.age),
    ...text,
    diseases: diseaseLines(o.diseases),
    medsRegularCount: text.medsRegular.length,
  }
}

// ══════════════════════════════════════════════════════════════
// 変化の兆し
// ══════════════════════════════════════════════════════════════

/** 兆しの種類（同じ重さの中の並びはこの順） */
export type GlanceSignKey =
  | 'temp'
  | 'spo2'
  | 'bp'
  | 'pulse'
  | 'spo2Drop'
  | 'stool'
  | 'fluid'
  | 'mealLow'
  | 'mealDrop'
  | 'weight'
  | 'med'
  | 'incident'
  | 'note'
  | 'gap'

export const GLANCE_SIGN_ORDER: readonly GlanceSignKey[] = [
  'temp',
  'spo2',
  'bp',
  'pulse',
  'spo2Drop',
  'stool',
  'fluid',
  'mealLow',
  'mealDrop',
  'weight',
  'med',
  'incident',
  'note',
  'gap',
]

/** 見守りボードの列（左→右） */
export type BoardColumn = 'temp' | 'bp' | 'pulse' | 'spo2' | 'meal' | 'fluid' | 'stool' | 'weight' | 'med' | 'incident' | 'note' | 'gap'

export const BOARD_COLUMNS: readonly BoardColumn[] = ['temp', 'bp', 'pulse', 'spo2', 'meal', 'fluid', 'stool', 'weight', 'med', 'incident', 'note', 'gap']

export const BOARD_COLUMN_LABEL: Readonly<Record<BoardColumn, string>> = {
  temp: '体温',
  bp: '血圧',
  pulse: '脈',
  spo2: 'SpO2',
  meal: '食事',
  fluid: '水分',
  stool: '排便',
  weight: '体重',
  med: '与薬',
  incident: '事故',
  note: '申し送り',
  gap: '記録の欠け',
}

const SIGN_COLUMN: Readonly<Record<GlanceSignKey, BoardColumn>> = {
  temp: 'temp',
  spo2: 'spo2',
  bp: 'bp',
  pulse: 'pulse',
  spo2Drop: 'spo2',
  stool: 'stool',
  fluid: 'fluid',
  mealLow: 'meal',
  mealDrop: 'meal',
  weight: 'weight',
  med: 'med',
  incident: 'incident',
  note: 'note',
  gap: 'gap',
}

/** 兆しを押した時に移るひと目ボードの区画（DOM の id。画面はこの id を区画に付ける） */
export const GLANCE_ANCHORS = Object.freeze({
  vitals: 'glance-vitals',
  board: 'glance-board',
  intake: 'glance-intake',
  changes: 'glance-changes',
})
export type GlanceAnchor = (typeof GLANCE_ANCHORS)[keyof typeof GLANCE_ANCHORS]

const SIGN_ANCHOR: Readonly<Record<GlanceSignKey, GlanceAnchor>> = {
  temp: GLANCE_ANCHORS.vitals,
  spo2: GLANCE_ANCHORS.vitals,
  bp: GLANCE_ANCHORS.vitals,
  pulse: GLANCE_ANCHORS.vitals,
  spo2Drop: GLANCE_ANCHORS.vitals,
  stool: GLANCE_ANCHORS.intake,
  fluid: GLANCE_ANCHORS.intake,
  mealLow: GLANCE_ANCHORS.intake,
  mealDrop: GLANCE_ANCHORS.intake,
  weight: GLANCE_ANCHORS.vitals,
  med: GLANCE_ANCHORS.changes,
  incident: GLANCE_ANCHORS.changes,
  note: GLANCE_ANCHORS.changes,
  gap: GLANCE_ANCHORS.board,
}

/** 重さの記号（色だけに頼らない: 要注意 '!!'・注意 '!'） */
export const SEVERITY_SYMBOL: Readonly<Record<Severity, '!!' | '!'>> = { danger: '!!', warn: '!' }
export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = { danger: '要注意', warn: '注意' }

export interface GlanceSign {
  key: GlanceSignKey
  column: BoardColumn
  severity: Severity
  symbol: '!!' | '!'
  /** 兆しの一覧に出す文（印つき） */
  label: string
  /** 見守りボードのマスに出す短い値 */
  short: string
  anchor: GlanceAnchor
  /** 根拠の日（無ければ null） */
  day: string | null
}

const sevRank = (s: Severity | null | undefined): number => (s === 'danger' ? 2 : s === 'warn' ? 1 : 0)

function sign(key: GlanceSignKey, severity: Severity, label: string, short: string, day: string | null = null): GlanceSign {
  return { key, column: SIGN_COLUMN[key], severity, symbol: SEVERITY_SYMBOL[severity], label, short, anchor: SIGN_ANCHOR[key], day }
}

/** 兆しを重い順（要注意→注意）・同じ重さは GLANCE_SIGN_ORDER の順に並べ、最大 signsMax 件にする */
export function orderSigns(signs: readonly GlanceSign[], max: number = GLANCE_RULES.signsMax): GlanceSign[] {
  const idx = (k: GlanceSignKey) => GLANCE_SIGN_ORDER.indexOf(k)
  return signs
    .map((s, i) => ({ s, i }))
    .sort((a, b) => sevRank(b.s.severity) - sevRank(a.s.severity) || idx(a.s.key) - idx(b.s.key) || a.i - b.i)
    .slice(0, Math.max(0, max))
    .map((x) => x.s)
}

const sevOfLevel = (lv: Level): Severity => (lv === 'danger-high' || lv === 'danger-low' ? 'danger' : 'warn')

// ══════════════════════════════════════════════════════════════
// 入力と結果の形
// ══════════════════════════════════════════════════════════════

/** 排便の入力（排便記録アプリの全員分の写し＋照合に使う在籍の全員）。null＝この端末は未接続・読めなかった */
export interface GlanceExcretionInput {
  snap: HbSnapshot
  /** 同じ氏名の数を数えるための在籍の全員（excretionViewFor と同じ） */
  careLog: ReadonlyArray<Pick<Resident, 'id' | 'name' | 'room' | 'active'>>
}

export interface GlanceInput {
  resident: Pick<Resident, 'id' | 'name' | 'room' | 'active' | 'care_level' | 'source_id' | 'needs_review'>
  /** 日本時間の今日（'YYYY-MM-DD'） */
  today: string
  /** いまの時刻（Date.now()）。排便の経過時間に使う */
  nowMs: number
  range: GlanceRange
  /** 以下は glanceWindows の fetchFrom〜today の分（取り消し済みは渡さない）。ほかの方の行が混ざっても捨てる */
  vitals: readonly Vital[]
  meals: readonly Meal[]
  fluids: readonly FluidIntake[]
  outings: readonly Outing[]
  /** その期間の申し送りと継続中（pinned）を重ねずにまとめたもの */
  notes: readonly Note[]
  meds: readonly MedAdmin[]
  /** 与薬の日ごとの表（med.ts の buildMedDayRows のその方の行）。「未」はここから数える。省くと「拒否」だけを数える */
  medRows?: ReadonlyArray<{ day: string; row: MedDayRow }>
  baths: readonly BathRecord[]
  incidents: readonly Incident[]
  /** 平熱（vital_usual_temps。5回未満は null） */
  usualTemp: number | null
  target: ResidentTargets | null
  /** 体重の列（weightClient）。null＝未接続・読めなかった */
  weights: ReadonlyArray<WeightEntry> | null
  excretion: GlanceExcretionInput | null
  /** 基準値（省くといまの基準値） */
  thresholds?: VitalThresholds
  /** 個人の閾値（vitalLimits.ts の thresholdsLookup）。体温・血圧・脈の判定に使う */
  thresholdsFor?: (residentId: number, day: string) => VitalThresholds
}

export type VitalKey = 'temp' | 'sysBp' | 'diaBp' | 'pulse' | 'spo2'

export interface VitalStat {
  key: VitalKey
  /** 最新の測定（値・日・時刻） */
  latest: { value: number; day: string; time: string | null } | null
  recentAvg: number | null
  baseAvg: number | null
  /** 平均に入れた日数 */
  recentDays: number
  baseDays: number
  diff: number | null
  dir: Direction | null
  /** 温度板の14日の日ごとの平均（古い順・無い日は null） */
  spark: (number | null)[]
}

export interface TempBoardDay {
  day: string
  away: AwayKind | null
  /** 日帰りの外出がある日 */
  outing: boolean
  /** 日ごとの平均（無ければ null） */
  temp: number | null
  sysBp: number | null
  diaBp: number | null
  pulse: number | null
  spo2: number | null
  /** その日の測定の中で最も重い基準外の印（無ければ null） */
  vitalSeverity: Severity | null
  vitalCount: number
  /** 朝昼夕の主食＋副食（0〜20。外出・入院・未記入は null） */
  meals: Record<'breakfast' | 'lunch' | 'dinner', number | null>
  /** 水分の合計（ml。記録が無ければ null）と目標比（%） */
  fluidMl: number | null
  fluidPct: number | null
  /** 排便1回分の回数（未接続・照合できない時は null） */
  stools: number | null
  medMissing: number
  medRefused: number
  bath: BathRecord['result'] | null
  bathCancelled: boolean
  notesCritical: number
  /** 体調の分類の申し送り */
  notesHealth: number
  incidents: number
}

export interface IntakePair {
  recent: number | null
  base: number | null
}

export type GlanceExcretion =
  | { state: 'unconnected' }
  | { state: 'unlinked'; message: string }
  | {
      state: 'linked'
      status: StoolStatus
      /** 直近14日（今日を含む）の排便1回分の回数 */
      count: number
      /** 直近14日の排便1回分どうしの平均の間隔（日・小数1桁。2回未満は null） */
      avgIntervalDays: number | null
      /** 今日が入院中（日数の判定を出さない） */
      hospital: boolean
      /** デイだけの方（日数の判定を出さない） */
      dayOnly: boolean
    }

export interface GlanceIntake {
  /** 1食の主食＋副食を 10 段階に直した平均（主食と副食の平均と同じ） */
  meal: { recentAvg10: number | null; baseAvg10: number | null; diff: number | null; dir: Direction | null }
  main: IntakePair
  side: IntakePair
  /** 朝昼夕の別（10 段階） */
  bySlot: Record<'breakfast' | 'lunch' | 'dinner', IntakePair>
  /** 直近の摂取低下の連続日数（0＝低下なし） */
  lowStreak: number
  fluid: {
    recentAvgMl: number | null
    baseAvgMl: number | null
    diff: number | null
    dir: Direction | null
    targetMl: number
    individual: boolean
    /** 直近の1日平均の目標比（%・整数） */
    recentPct: number | null
    /** 兆しの判定に使う直近 fluidDays 日（今日を除く）の1日平均と目標比 */
    shortAvgMl: number | null
    shortPct: number | null
  }
  excretion: GlanceExcretion
}

export interface GlanceRecentChanges {
  /** 申し送り（最重要・継続中・体調の分類を優先、新しい順）最大 recentNotes 件 */
  notes: Note[]
  /** 直近30日の事故・ヒヤリハット（新しい順） */
  incidents: Incident[]
  /** 直近7日の与薬の「未」「拒否」（新しい順） */
  medIssues: Array<{ day: string; slot: MedSlot; kind: 'missing' | 'refused' }>
  /** 直近14日の入浴の中止（新しい順） */
  bathCancels: BathRecord[]
}

export interface GlanceModel {
  residentId: number
  today: string
  range: GlanceRange
  windows: GlanceWindows
  /** 今日の札（入院中・外泊中） */
  away: AwayKind | null
  /** 各データの最終日（無ければ null） */
  lastDays: { vitals: string | null; meals: string | null; fluids: string | null; notes: string | null; weight: string | null; stool: string | null }
  usualTemp: number | null
  vitals: Record<VitalKey, VitalStat>
  weight: WeightLoss | null
  board: TempBoardDay[]
  intake: GlanceIntake
  signs: GlanceSign[]
  /** 並べる前の兆しの件数（最大件数で切る前） */
  signTotal: number
  /** 兆しの全件（重い順・最大件数で切らない）。見守りボードのマスはこちらから作る */
  allSigns: GlanceSign[]
  recentChanges: GlanceRecentChanges
}

// ══════════════════════════════════════════════════════════════
// 集計
// ══════════════════════════════════════════════════════════════

const VITAL_FIELD: Readonly<Record<VitalKey, 'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2'>> = {
  temp: 'temp',
  sysBp: 'sys_bp',
  diaBp: 'dia_bp',
  pulse: 'pulse',
  spo2: 'spo2',
}

const hmOf = (v: string | null | undefined): string | null => (typeof v === 'string' && /^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : null)

const r1 = (n: number): number => Math.round(n * 10) / 10

/** バイタルの日ごとの平均（項目ごと） */
function dailyVitalMeans(vitals: readonly Vital[], key: VitalKey): Map<string, number> {
  const f = VITAL_FIELD[key]
  const acc = new Map<string, number[]>()
  for (const v of vitals) {
    const x = v[f]
    if (typeof x !== 'number' || !Number.isFinite(x)) continue
    const list = acc.get(v.measured_on) ?? []
    list.push(x)
    acc.set(v.measured_on, list)
  }
  const out = new Map<string, number>()
  for (const [d, xs] of acc) {
    const m = meanOf(xs)
    if (m !== null) out.set(d, m)
  }
  return out
}

/** 最新の測定（日・時刻の新しい順） */
function latestVital(vitals: readonly Vital[], key: VitalKey): VitalStat['latest'] {
  const f = VITAL_FIELD[key]
  let best: Vital | null = null
  for (const v of vitals) {
    const x = v[f]
    if (typeof x !== 'number' || !Number.isFinite(x)) continue
    if (
      !best ||
      v.measured_on > best.measured_on ||
      (v.measured_on === best.measured_on && ((hmOf(v.measured_at) ?? '') > (hmOf(best.measured_at) ?? '') || ((hmOf(v.measured_at) ?? '') === (hmOf(best.measured_at) ?? '') && v.id > best.id)))
    ) {
      best = v
    }
  }
  if (!best) return null
  return { value: best[f] as number, day: best.measured_on, time: hmOf(best.measured_at) }
}

interface Ctx {
  rid: number
  today: string
  w: GlanceWindows
  away: Map<string, AwayKind | null>
  awaySet: Set<string>
  t: VitalThresholds
  tFor: (day: string) => VitalThresholds
}

function vitalStat(vitals: readonly Vital[], key: VitalKey, c: Ctx, flat: number): VitalStat {
  const byDay = dailyVitalMeans(vitals, key)
  const rec = windowAverage(byDay, c.w.recentFrom, c.w.recentTo, c.awaySet)
  const base = windowAverage(byDay, c.w.baseFrom, c.w.baseTo, c.awaySet)
  const { diff, dir } = compareAverages(rec.avg, base.avg, flat)
  const spark = daysBetween(c.w.boardFrom, c.today).map((d) => byDay.get(d) ?? null)
  return { key, latest: latestVital(vitals, key), recentAvg: rec.avg, baseAvg: base.avg, recentDays: rec.days, baseDays: base.days, diff, dir, spark }
}

/** 1件のバイタルの基準外（体温＝judgeTemp・血圧/脈＝基準値・SpO2＝個別の下限込み）。最も重いものを項目ごとに */
interface VitalHit {
  key: 'temp' | 'bp' | 'pulse' | 'spo2'
  severity: Severity
  label: string
  short: string
  day: string
  order: string
}

function vitalHits(v: Vital, usual: number | null, target: ResidentTargets | null, t: VitalThresholds): VitalHit[] {
  const out: VitalHit[] = []
  const order = `${v.measured_on} ${hmOf(v.measured_at) ?? '99:99'} ${String(v.id).padStart(12, '0')}`
  const base = { day: v.measured_on, order }
  if (v.temp != null) {
    const j = judgeTemp(v.temp, usual, t)
    if (j.level) {
      const s = `${v.temp.toFixed(1)}${j.mark ?? ''}`
      out.push({ ...base, key: 'temp', severity: sevOfLevel(j.level), label: `体温 ${s}${j.note ? `（${j.note}）` : ''}`, short: s })
    } else if (j.overUsual) {
      out.push({ ...base, key: 'temp', severity: 'warn', label: `体温 ${v.temp.toFixed(1)}（${j.mark ?? ''}）`, short: j.mark ?? v.temp.toFixed(1) })
    }
  }
  const sl = sysBpLevelBy(v.sys_bp, t)
  const dl = diaBpLevelBy(v.dia_bp, t)
  if (sl || dl) {
    const part = (x: number | null, lv: Level) => `${x ?? '—'}${lv ? LEVEL_MARK[lv] : ''}`
    const s = `${part(v.sys_bp, sl)}/${part(v.dia_bp, dl)}`
    out.push({ ...base, key: 'bp', severity: sl === 'danger-high' || dl === 'danger-high' ? 'danger' : 'warn', label: `血圧 ${s}`, short: s })
  }
  const pl = pulseLevelBy(v.pulse, t)
  if (pl) out.push({ ...base, key: 'pulse', severity: sevOfLevel(pl), label: `脈拍 ${v.pulse}${LEVEL_MARK[pl]}`, short: `${v.pulse}${LEVEL_MARK[pl]}` })
  const ol = spo2LevelFor(v.spo2, target, t)
  if (ol) out.push({ ...base, key: 'spo2', severity: sevOfLevel(ol), label: `SpO2 ${v.spo2}%${LEVEL_MARK[ol]}`, short: `${v.spo2}%${LEVEL_MARK[ol]}` })
  return out
}

/** 与薬の「未」「拒否」（日・時間帯ごと。頓服は数えない。同じマスは「拒否」の記録を優先しない＝表の新しい記録だけ） */
function medIssuesOf(meds: readonly MedAdmin[], medRows: GlanceInput['medRows'], rid: number, from: string, to: string): Array<{ day: string; slot: MedSlot; kind: 'missing' | 'refused' }> {
  const latest = new Map<string, MedAdmin>()
  for (const m of meds) {
    if (!m || m.resident_id !== rid || m.slot === 'prn' || m.admin_on < from || m.admin_on > to) continue
    const k = `${m.admin_on}|${m.slot}`
    const prev = latest.get(k)
    if (!prev || m.id > prev.id) latest.set(k, m)
  }
  const out: Array<{ day: string; slot: MedSlot; kind: 'missing' | 'refused' }> = []
  const seen = new Set<string>()
  for (const [k, m] of latest) {
    if (m.status !== 'refused') continue
    seen.add(k)
    out.push({ day: m.admin_on, slot: m.slot as MedSlot, kind: 'refused' })
  }
  for (const { day, row } of medRows ?? []) {
    if (!row || row.residentId !== rid || day < from || day > to) continue
    for (const slot of MED_SLOTS) {
      const cell = row.cells[slot]
      const k = `${day}|${slot}`
      if (seen.has(k)) continue
      if (cell?.kind === 'missing') {
        seen.add(k)
        out.push({ day, slot, kind: 'missing' })
      } else if (cell?.kind === 'record' && cell.record.status === 'refused') {
        seen.add(k)
        out.push({ day, slot, kind: 'refused' })
      }
    }
  }
  out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : MED_SLOTS.indexOf(a.slot) - MED_SLOTS.indexOf(b.slot)))
  return out
}

/** 排便の札（照合・判定は excretionClient の写しをそのまま呼ぶ） */
function excretionOf(x: GlanceExcretionInput | null, resident: GlanceInput['resident'], today: string, nowMs: number, hospital: boolean): GlanceExcretion {
  if (!x || !x.snap) return { state: 'unconnected' }
  const m = matchExcretionResident(resident, x.careLog, x.snap.residents)
  if (!m.ok) return { state: 'unlinked', message: excretionMatchMessage(m) }
  const pool: readonly HbRecord[] = x.snap.recs.get(m.hb.id) ?? []
  const status = stoolStatusOf(pool, m.hb, x.snap.cfg, nowMs)
  const from = addDaysIsoUtc(today, -(GLANCE_RULES.stoolWindowDays - 1))
  const stools = stoolResetSeries(pool.filter((r) => r.type === 'stool' || r.type === 'both'))
  const inWin = stools.filter((r) => r.date >= from && r.date <= today)
  const times = inWin.map((r) => (typeof r.tsUTC === 'number' && Number.isFinite(r.tsUTC) ? r.tsUTC : Date.parse(r.datetime))).filter((n) => Number.isFinite(n))
  let avgIntervalDays: number | null = null
  if (times.length >= 2) {
    times.sort((a, b) => a - b)
    avgIntervalDays = r1((times[times.length - 1] - times[0]) / (times.length - 1) / 86400000)
  }
  return { state: 'linked', status, count: inWin.length, avgIntervalDays, hospital, dayOnly: m.hb.dayOnly }
}

/** 排便1回分の日ごとの回数（温度板） */
function stoolsByDay(x: GlanceExcretionInput | null, resident: GlanceInput['resident']): Map<string, number> | null {
  if (!x || !x.snap) return null
  const m = matchExcretionResident(resident, x.careLog, x.snap.residents)
  if (!m.ok) return null
  const out = new Map<string, number>()
  const pool = x.snap.recs.get(m.hb.id) ?? []
  for (const r of stoolResetSeries(pool.filter((r) => r.type === 'stool' || r.type === 'both'))) out.set(r.date, (out.get(r.date) ?? 0) + 1)
  return out
}

/** 申し送りの優先（最重要 > 継続中 > 体調の分類 > その他） */
function notePriority(n: Note): number {
  const open = n.ongoing && n.ended_at == null
  if (n.importance === 'critical') return 3
  if (open) return 2
  if (Array.isArray(n.categories) && n.categories.includes('体調')) return 1
  return 0
}

const noteNewer = (a: Note, b: Note): number =>
  a.note_on !== b.note_on ? (a.note_on < b.note_on ? 1 : -1) : (b.occurred_at ?? '').localeCompare(a.occurred_at ?? '') || b.id - a.id

/**
 * 1人分の集計（ひと目ボード）。見守りボードも同じ関数で全員分を数える（buildBoardRows）
 */
export function computeGlance(p: GlanceInput): GlanceModel {
  const rid = p.resident.id
  const today = p.today
  const w = glanceWindows(today, p.range)
  const t = p.thresholds ?? vitalThresholds()
  const mine = <T extends { resident_id: number | null }>(xs: readonly T[] | null | undefined): T[] => (xs ?? []).filter((x) => x != null && x.resident_id === rid)
  const vitals = mine(p.vitals)
  const meals = mine(p.meals)
  const fluids = mine(p.fluids)
  const outings = mine(p.outings)
  const notes = mine(p.notes)
  const baths = mine(p.baths)
  const incidents = mine(p.incidents)

  // 入院中/外泊中の日（基準の始まり〜今日）
  const away = new Map<string, AwayKind | null>()
  const awaySet = new Set<string>()
  for (const d of daysBetween(w.fetchFrom, today)) {
    const k = awayKindOn(meals, outings, rid, d)
    away.set(d, k)
    if (k) awaySet.add(d)
  }
  const awayNow = awayToday(meals, outings, rid, today)
  if (awayNow) {
    away.set(today, awayNow)
    awaySet.add(today)
  }
  const tFor = (day: string) => p.thresholdsFor?.(rid, day) ?? t
  const c: Ctx = { rid, today, w, away, awaySet, t, tFor }
  const flat = GLANCE_RULES.flatBelow

  // ── バイタル ──
  const vs: Record<VitalKey, VitalStat> = {
    temp: vitalStat(vitals, 'temp', c, flat.temp),
    sysBp: vitalStat(vitals, 'sysBp', c, flat.sysBp),
    diaBp: vitalStat(vitals, 'diaBp', c, flat.diaBp),
    pulse: vitalStat(vitals, 'pulse', c, flat.pulse),
    spo2: vitalStat(vitals, 'spo2', c, flat.spo2),
  }

  // ── 食事・水分 ──
  const md = mealDays(meals, fluids)
  const meal10ByDay = new Map<string, number>()
  const mainByDay = new Map<string, number>()
  const sideByDay = new Map<string, number>()
  const slotByDay: Record<'breakfast' | 'lunch' | 'dinner', Map<string, number>> = { breakfast: new Map(), lunch: new Map(), dinner: new Map() }
  const fluidByDay = new Map<string, number>()
  for (const [day, cell] of md) {
    const all: number[] = []
    const mains: number[] = []
    const sides: number[] = []
    for (const slot of MEAL_CHART_SLOTS) {
      const m = cell.meals.get(slot)
      const v = mealIntake(m)
      if (v == null) continue
      all.push((v * 10) / MEAL_FULL)
      slotByDay[slot as 'breakfast' | 'lunch' | 'dinner'].set(day, (v * 10) / MEAL_FULL)
      if (m && m.status === 'refused') {
        mains.push(0)
        sides.push(0)
      } else if (m) {
        if (typeof m.main_amount === 'number' && Number.isFinite(m.main_amount)) mains.push(m.main_amount)
        if (typeof m.side_amount === 'number' && Number.isFinite(m.side_amount)) sides.push(m.side_amount)
      }
    }
    const a = meanOf(all)
    if (a !== null) meal10ByDay.set(day, a)
    const mm = meanOf(mains)
    if (mm !== null) mainByDay.set(day, mm)
    const sm = meanOf(sides)
    if (sm !== null) sideByDay.set(day, sm)
    if (cell.fluid !== null) fluidByDay.set(day, cell.fluid)
  }
  const pair = (m: ReadonlyMap<string, number>): IntakePair => ({
    recent: windowAverage(m, w.recentFrom, w.recentTo, awaySet).avg,
    base: windowAverage(m, w.baseFrom, w.baseTo, awaySet).avg,
  })
  const mealPair = pair(meal10ByDay)
  const mealCmp = compareAverages(mealPair.recent, mealPair.base, flat.meal10)
  const fluidPair = pair(fluidByDay)
  const fluidCmp = compareAverages(fluidPair.recent, fluidPair.base, flat.fluidMl)
  const tg = fluidTargetOf(p.target, t)
  const shortFrom = addDaysIsoUtc(today, -GLANCE_RULES.fluidDays)
  const shortTo = addDaysIsoUtc(today, -1)
  const shortVals: number[] = []
  for (const d of daysBetween(shortFrom, shortTo)) {
    if (awaySet.has(d)) continue
    const v = fluidByDay.get(d)
    if (v !== undefined) shortVals.push(v)
  }
  const shortSum = shortVals.reduce((s, v) => s + v, 0)
  const shortAvg = shortVals.length > 0 ? shortSum / shortVals.length : null
  const pct = (avg: number | null) => (avg === null ? null : Math.round((avg * 100) / tg.ml))
  const streaks = mealLowStreaks(meals, t).get(rid)
  let lowStreak = 0
  let lowDay: string | null = null
  for (const d of daysBetween(addDaysIsoUtc(today, -(GLANCE_RULES.mealLowLookbackDays - 1)), today)) {
    if (awaySet.has(d)) continue
    const s = streaks?.get(d)
    if (s && s.low) {
      lowStreak = s.streak
      lowDay = d
    }
  }
  const excretion = excretionOf(p.excretion, p.resident, today, p.nowMs, awayNow === 'hospital')

  const intake: GlanceIntake = {
    meal: { recentAvg10: mealPair.recent, baseAvg10: mealPair.base, ...mealCmp },
    main: pair(mainByDay),
    side: pair(sideByDay),
    bySlot: { breakfast: pair(slotByDay.breakfast), lunch: pair(slotByDay.lunch), dinner: pair(slotByDay.dinner) },
    lowStreak,
    fluid: {
      recentAvgMl: fluidPair.recent,
      baseAvgMl: fluidPair.base,
      ...fluidCmp,
      targetMl: tg.ml,
      individual: tg.individual,
      recentPct: pct(fluidPair.recent),
      shortAvgMl: shortAvg,
      shortPct: pct(shortAvg),
    },
    excretion,
  }

  // ── 体重 ──
  const weight = p.weights === null ? null : classifyWeightLoss(p.weights, today)

  // ── 与薬・入浴・事故・申し送り ──
  const medFrom = addDaysIsoUtc(today, -(GLANCE_RULES.medDays - 1))
  const medAll = medIssuesOf(p.meds, p.medRows, rid, addDaysIsoUtc(today, -(Math.max(GLANCE_RULES.medDays, GLANCE_RULES.recentMedDays, GLANCE_RULES.boardDays) - 1)), today)
  const recentMedFrom = addDaysIsoUtc(today, -(GLANCE_RULES.recentMedDays - 1))
  const incFrom = addDaysIsoUtc(today, -(GLANCE_RULES.incidentDays - 1))
  const recentIncFrom = addDaysIsoUtc(today, -(GLANCE_RULES.recentIncidentDays - 1))
  const recentBathFrom = addDaysIsoUtc(today, -(GLANCE_RULES.recentBathDays - 1))
  const incidentsSorted = incidents
    .filter((i) => i.occurred_on <= today)
    .slice()
    .sort((a, b) => (a.occurred_on !== b.occurred_on ? (a.occurred_on < b.occurred_on ? 1 : -1) : b.occurred_at.localeCompare(a.occurred_at) || b.id - a.id))
  const openNotes = notes.filter((n) => n.ongoing && n.ended_at == null && n.note_on <= today)

  // ── 温度板（14日） ──
  const stoolDay = stoolsByDay(p.excretion, p.resident)
  const latestBath = new Map<string, BathRecord>()
  for (const b of baths) {
    const prev = latestBath.get(b.bath_on)
    if (!prev || b.id > prev.id) latestBath.set(b.bath_on, b)
  }
  const board: TempBoardDay[] = daysBetween(w.boardFrom, today).map((day, i) => {
    const dv = vitals.filter((v) => v.measured_on === day)
    let vsev: Severity | null = null
    for (const v of dv) for (const h of vitalHits(v, p.usualTemp, p.target, tFor(day))) if (sevRank(h.severity) > sevRank(vsev)) vsev = h.severity
    const cell = md.get(day)
    const slotVal = (s: MealSlot) => (cell ? mealIntake(cell.meals.get(s)) : null)
    const fl = cell?.fluid ?? null
    const issues = medAll.filter((x) => x.day === day)
    const bath = latestBath.get(day) ?? null
    const dn = notes.filter((n) => n.note_on === day)
    // spark は温度板と同じ日の列（boardFrom〜今日）なので、同じ位置の値
    const at = (k: VitalKey) => vs[k].spark[i] ?? null
    return {
      day,
      away: away.get(day) ?? null,
      outing: outings.some((o) => o.kind === 'outing' && o.start_on <= day && (o.end_on === null || o.end_on >= day)),
      temp: at('temp'),
      sysBp: at('sysBp'),
      diaBp: at('diaBp'),
      pulse: at('pulse'),
      spo2: at('spo2'),
      vitalSeverity: vsev,
      vitalCount: dv.length,
      meals: { breakfast: slotVal('breakfast'), lunch: slotVal('lunch'), dinner: slotVal('dinner') },
      fluidMl: fl,
      fluidPct: fl === null ? null : Math.round((fl * 100) / tg.ml),
      stools: stoolDay === null ? null : (stoolDay.get(day) ?? 0),
      medMissing: issues.filter((x) => x.kind === 'missing').length,
      medRefused: issues.filter((x) => x.kind === 'refused').length,
      bath: bath ? bath.result : null,
      bathCancelled: bath ? bath.result === 'cancel' : false,
      notesCritical: dn.filter((n) => n.importance === 'critical').length,
      notesHealth: dn.filter((n) => Array.isArray(n.categories) && n.categories.includes('体調')).length,
      incidents: incidents.filter((i) => i.occurred_on === day).length,
    }
  })

  // ── 最新の体調変化 ──
  const recentChanges: GlanceRecentChanges = {
    notes: notes
      .filter((n) => n.note_on <= today)
      .slice()
      .sort((a, b) => notePriority(b) - notePriority(a) || noteNewer(a, b))
      .slice(0, GLANCE_RULES.recentNotes),
    incidents: incidentsSorted.filter((i) => i.occurred_on >= recentIncFrom),
    medIssues: medAll.filter((x) => x.day >= recentMedFrom),
    bathCancels: baths
      .filter((b) => b.result === 'cancel' && b.bath_on >= recentBathFrom && b.bath_on <= today)
      .slice()
      .sort((a, b) => (a.bath_on < b.bath_on ? 1 : a.bath_on > b.bath_on ? -1 : b.id - a.id)),
  }

  // ── 変化の兆し ──
  const raw = awayNow
    ? []
    : deriveSigns({
        today,
        awaySet,
        vitals,
        usualTemp: p.usualTemp,
        target: p.target,
        tFor,
        spo2: vs.spo2,
        intake,
        lowDay,
        weight,
        medIssues: medAll.filter((x) => x.day >= medFrom && !awaySet.has(x.day)),
        incidents: incidentsSorted.filter((i) => i.occurred_on >= incFrom),
        openNotes,
      })
  const lastOf = (xs: readonly string[]): string | null => xs.reduce<string | null>((m, d) => (d <= today && (m === null || d > m) ? d : m), null)
  const lastWeight = weight?.latest?.date ?? null
  const lastStool = excretion.state === 'linked' && excretion.status.lastAt ? excretion.status.lastAt.slice(0, 10) : null

  return {
    residentId: rid,
    today,
    range: p.range,
    windows: w,
    away: awayNow,
    lastDays: {
      vitals: lastOf(vitals.map((v) => v.measured_on)),
      meals: lastOf(meals.map((m) => m.meal_on)),
      fluids: lastOf(fluids.map((f) => f.taken_on)),
      notes: lastOf(notes.map((n) => n.note_on)),
      weight: lastWeight,
      stool: lastStool,
    },
    usualTemp: p.usualTemp,
    vitals: vs,
    weight,
    board,
    intake,
    signs: orderSigns(raw),
    signTotal: raw.length,
    allSigns: orderSigns(raw, raw.length),
    recentChanges,
  }
}

export interface DeriveSignsInput {
  today: string
  /** 入院中/外泊中の日（数えない） */
  awaySet: ReadonlySet<string>
  vitals: readonly Vital[]
  usualTemp: number | null
  target: ResidentTargets | null
  tFor: (day: string) => VitalThresholds
  spo2: Pick<VitalStat, 'recentAvg' | 'baseAvg'>
  intake: GlanceIntake
  /** 摂取低下の直近の日（無ければ null） */
  lowDay: string | null
  weight: WeightLoss | null
  /** 直近 medDays 日の「未」「拒否」（入院中/外泊中の日は除いたもの） */
  medIssues: ReadonlyArray<{ day: string; slot: MedSlot; kind: 'missing' | 'refused' }>
  /** 直近 incidentDays 日の事故・ヒヤリハット */
  incidents: readonly Incident[]
  /** 終わっていない継続中の申し送り */
  openNotes: readonly Note[]
}

/** 規則（GLANCE_RULES）で兆しを拾う（並べる前の全件）。並べるのは orderSigns */
export function deriveSigns(p: DeriveSignsInput): GlanceSign[] {
  const out: GlanceSign[] = []
  const R = GLANCE_RULES

  // 基準値の外れ（直近 vitalLookbackDays 日・入院中/外泊中の日を除く）。項目ごとに最も重い・同じ重さは新しいもの
  const vFrom = addDaysIsoUtc(p.today, -(R.vitalLookbackDays - 1))
  const best = new Map<VitalHit['key'], VitalHit>()
  for (const v of p.vitals) {
    if (v.measured_on < vFrom || v.measured_on > p.today || p.awaySet.has(v.measured_on)) continue
    for (const h of vitalHits(v, p.usualTemp, p.target, p.tFor(v.measured_on))) {
      const cur = best.get(h.key)
      if (!cur || sevRank(h.severity) > sevRank(cur.severity) || (h.severity === cur.severity && h.order > cur.order)) best.set(h.key, h)
    }
  }
  for (const h of best.values()) out.push(sign(h.key, h.severity, h.label, h.short, h.day))

  // SpO2 の平均の低下（0.1 単位の整数で比べる）
  const sr = p.spo2.recentAvg
  const sb = p.spo2.baseAvg
  if (sr !== null && sb !== null && Math.round(sb * 10) - Math.round(sr * 10) >= Math.round(R.spo2Drop * 10)) {
    const d = (Math.round(sb * 10) - Math.round(sr * 10)) / 10
    out.push(sign('spo2Drop', 'warn', `SpO2 平均 ${r1(sr).toFixed(1)}%（基準より−${d.toFixed(1)}）`, `平均−${d.toFixed(1)}`))
  }

  // 排便（排便記録アプリの判定そのまま。入院中・デイだけの方は出さない）
  const ex = p.intake.excretion
  if (ex.state === 'linked' && !ex.hospital && !ex.dayOnly && ex.status.level !== 'ok') {
    const s = ex.status
    out.push(sign('stool', s.level === 'danger' ? 'danger' : 'warn', stoolAlertLabel(s), s.days === null ? '日時不明' : `${s.days}日${s.atLeast ? '以上' : ''}`))
  }

  // 水分（直近 fluidDays 日の1日平均が目標の fluidRatio 未満。整数で比べる＝ちょうど8割は当たらない）
  const fl = p.intake.fluid
  if (fl.shortAvgMl !== null && fl.shortAvgMl * 100 < fl.targetMl * Math.round(R.fluidRatio * 100)) {
    out.push(sign('fluid', 'warn', `水分 ${R.fluidDays}日平均 ${fmtMl(fl.shortAvgMl)}／${fmtMl(fl.targetMl)}ml（${fl.shortPct}%）`, `${fl.shortPct}%`))
  }

  // 摂取低下（mealLowStreaks）
  if (p.lowDay !== null && p.intake.lowStreak >= 1) {
    out.push(sign('mealLow', 'warn', mealLowLabel(p.intake.lowStreak), `▼${p.intake.lowStreak}日目`, p.lowDay))
  }

  // 食事の平均の低下（10 段階で mealDrop10 以上。0.1 単位の整数で比べる）
  const mr = p.intake.meal.recentAvg10
  const mb = p.intake.meal.baseAvg10
  if (mr !== null && mb !== null && Math.round(mb * 10) - Math.round(mr * 10) >= Math.round(R.mealDrop10 * 10)) {
    const d = (Math.round(mb * 10) - Math.round(mr * 10)) / 10
    out.push(sign('mealDrop', 'warn', `食事 平均 ${r1(mr).toFixed(1)}/10（基準より−${d.toFixed(1)}）`, `平均−${d.toFixed(1)}`))
  }

  // 体重減少の目安（最も重い期間）
  const wl = p.weight?.worst
  if (wl && wl.level && wl.lossPct !== null) {
    out.push(sign('weight', wl.level, `体重 ${wl.months}か月で−${wl.lossPct.toFixed(1)}%`, `−${wl.lossPct.toFixed(1)}%`))
  }

  // 与薬の「未」「拒否」
  if (p.medIssues.length >= R.medCount) {
    out.push(sign('med', 'warn', `与薬 未・拒否 ${p.medIssues.length}回（${R.medDays}日）`, `${p.medIssues.length}回`))
  }

  // 事故・ヒヤリハット（事故は要注意・ヒヤリハットだけなら注意）
  if (p.incidents.length > 0) {
    const acc = p.incidents.filter((i) => i.kind === 'accident').length
    const near = p.incidents.length - acc
    const parts = [acc > 0 ? `事故 ${acc}件` : '', near > 0 ? `ヒヤリ ${near}件` : ''].filter((s) => s !== '')
    out.push(sign('incident', acc > 0 ? 'danger' : 'warn', `${parts.join('・')}（${R.incidentDays}日）`, acc > 0 ? `事故${acc}` : `ヒヤリ${near}`))
  }

  // 終わっていない継続（最重要があれば要注意）
  if (p.openNotes.length > 0) {
    const crit = p.openNotes.filter((n) => n.importance === 'critical').length
    out.push(
      crit > 0
        ? sign('note', 'danger', `最重要の継続 ${crit}件`, `最重要${crit}`)
        : sign('note', 'warn', `継続中の申し送り ${p.openNotes.length}件`, `継続${p.openNotes.length}`),
    )
  }

  // 記録の欠け（直近 gapDays 日のうち施設に居た日に、バイタルが1件も無い）
  const gapDays = daysBetween(addDaysIsoUtc(p.today, -(R.gapDays - 1)), p.today).filter((d) => !p.awaySet.has(d))
  if (gapDays.length === R.gapDays && !p.vitals.some((v) => gapDays.includes(v.measured_on))) {
    out.push(sign('gap', 'warn', `バイタルの記録なし（${R.gapDays}日）`, `${R.gapDays}日なし`))
  }
  return out
}

// ══════════════════════════════════════════════════════════════
// 見守りボード
// ══════════════════════════════════════════════════════════════

/** 1マス（記号＋短い値。色だけに頼らない） */
export interface BoardCell {
  severity: Severity | null
  symbol: '!!' | '!' | ''
  text: string
  /** 排便・体重が端末に未接続・照合できない（「—（カルテで確認）」） */
  unavailable: boolean
}

export const BOARD_UNAVAILABLE_TEXT = '—（カルテで確認）'

export interface BoardRow {
  residentId: number
  name: string
  room: string | null
  /** 居室の順（fetchResidents の返す順の位置） */
  order: number
  away: AwayKind | null
  signCount: number
  topSeverity: Severity | null
  /** 兆し（重い順・最大 signsMax） */
  signs: GlanceSign[]
  cells: Record<BoardColumn, BoardCell>
  /** 体温の直近7日の日ごとの平均（古い順・無い日は null） */
  tempSpark: (number | null)[]
}

export interface BoardInput {
  /** 居室の順（fetchResidents の返す順）の在籍の方 */
  residents: ReadonlyArray<Pick<Resident, 'id' | 'name' | 'room' | 'active' | 'care_level' | 'source_id' | 'needs_review'>>
  today: string
  nowMs: number
  range?: GlanceRange
  vitals: readonly Vital[]
  meals: readonly Meal[]
  fluids: readonly FluidIntake[]
  outings: readonly Outing[]
  notes: readonly Note[]
  /** 与薬の記録。null＝表が無い・読めなかった（与薬の列を「—（カルテで確認）」にする） */
  meds: readonly MedAdmin[] | null
  /** 与薬の日ごとの表（day → buildMedDayRows の全員分の行）。省くと「拒否」だけを数える */
  medRowsByDay?: ReadonlyMap<string, readonly MedDayRow[]>
  /** 事故・ヒヤリ。null＝表が無い・読めなかった（事故の列を「—（カルテで確認）」にする） */
  incidents: readonly Incident[] | null
  usualTemps: ReadonlyMap<number, number | null>
  targets: ReadonlyMap<number, ResidentTargets>
  /** 体重（利用者ID → 列）。null＝未接続・読めなかった */
  weights: ReadonlyMap<number, ReadonlyArray<WeightEntry>> | null
  /** 排便記録の写し。null＝未接続・読めなかった */
  excretion: HbSnapshot | null
  thresholds?: VitalThresholds
  thresholdsFor?: (residentId: number, day: string) => VitalThresholds
}

function groupBy<T>(xs: readonly T[] | null | undefined, key: (x: T) => number | null | undefined): Map<number, T[]> {
  const out = new Map<number, T[]>()
  for (const x of xs ?? []) {
    if (x == null) continue
    const k = key(x)
    if (typeof k !== 'number') continue
    const list = out.get(k) ?? []
    list.push(x)
    out.set(k, list)
  }
  return out
}

const fmt1 = (n: number | null | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(1) : '')
const fmt0 = (n: number | null | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n)) : '')

/** 兆しの無いマスに出す短い値 */
function plainCell(col: BoardColumn, m: GlanceModel, weightLinked: boolean, medsRead: boolean, incidentsRead: boolean): BoardCell {
  const plain = (text: string, unavailable = false): BoardCell => ({ severity: null, symbol: '', text, unavailable })
  switch (col) {
    case 'temp':
      return plain(fmt1(m.vitals.temp.latest?.value))
    case 'bp': {
      const s = m.vitals.sysBp.latest
      const d = m.vitals.diaBp.latest
      return plain(s || d ? `${fmt0(s?.value) || '—'}/${fmt0(d?.value) || '—'}` : '')
    }
    case 'pulse':
      return plain(fmt0(m.vitals.pulse.latest?.value))
    case 'spo2':
      return plain(m.vitals.spo2.latest ? `${fmt0(m.vitals.spo2.latest.value)}%` : '')
    case 'meal':
      return plain(m.intake.meal.recentAvg10 === null ? '' : `${fmt1(m.intake.meal.recentAvg10)}/10`)
    case 'fluid':
      return plain(m.intake.fluid.recentPct === null ? '' : `${m.intake.fluid.recentPct}%`)
    case 'stool': {
      const ex = m.intake.excretion
      if (ex.state !== 'linked') return plain(BOARD_UNAVAILABLE_TEXT, true)
      if (ex.dayOnly) return plain('デイのみ')
      return plain(ex.status.days === null ? '' : `${ex.status.days}日${ex.status.atLeast ? '以上' : ''}`)
    }
    case 'weight':
      if (!weightLinked || !m.weight || !m.weight.latest) return plain(BOARD_UNAVAILABLE_TEXT, true)
      return plain(`${fmt1(m.weight.latest.weight)}kg`)
    // 与薬・事故は表が読めなかった時だけ「—（カルテで確認）」（「なし」と見せない）
    case 'med':
      return medsRead ? plain('') : plain(BOARD_UNAVAILABLE_TEXT, true)
    case 'incident':
      return incidentsRead ? plain('') : plain(BOARD_UNAVAILABLE_TEXT, true)
    // 申し送り・記録の欠けは、兆しが無ければ空欄（数える物が無い）
    case 'note':
    case 'gap':
      return plain('')
  }
}

/** 全員分の行（居室の順）。1人ずつは computeGlance と同じ規則（同じ関数）で数える */
export function buildBoardRows(p: BoardInput): BoardRow[] {
  const range = p.range ?? DEFAULT_GLANCE_RANGE
  const byV = groupBy(p.vitals, (x) => x.resident_id)
  const byM = groupBy(p.meals, (x) => x.resident_id)
  const byF = groupBy(p.fluids, (x) => x.resident_id)
  const byO = groupBy(p.outings, (x) => x.resident_id)
  const byN = groupBy(p.notes, (x) => x.resident_id)
  const byMed = groupBy(p.meds, (x) => x.resident_id)
  const byI = groupBy(p.incidents, (x) => x.resident_id)
  const rowsByRes = new Map<number, Array<{ day: string; row: MedDayRow }>>()
  for (const [day, rows] of p.medRowsByDay ?? []) {
    for (const row of rows) {
      if (!row) continue
      const list = rowsByRes.get(row.residentId) ?? []
      list.push({ day, row })
      rowsByRes.set(row.residentId, list)
    }
  }
  const careLog = p.residents
  const sparkFrom = addDaysIsoUtc(p.today, -(GLANCE_RULES.boardSparkDays - 1))
  const out: BoardRow[] = []
  const seen = new Set<number>()
  p.residents.forEach((r, order) => {
    if (!r || seen.has(r.id)) return
    seen.add(r.id)
    const wl = p.weights === null ? null : (p.weights.get(r.id) ?? null)
    const m = computeGlance({
      resident: r,
      today: p.today,
      nowMs: p.nowMs,
      range,
      vitals: byV.get(r.id) ?? [],
      meals: byM.get(r.id) ?? [],
      fluids: byF.get(r.id) ?? [],
      outings: byO.get(r.id) ?? [],
      notes: byN.get(r.id) ?? [],
      meds: byMed.get(r.id) ?? [],
      medRows: rowsByRes.get(r.id) ?? [],
      baths: [],
      incidents: byI.get(r.id) ?? [],
      usualTemp: p.usualTemps.get(r.id) ?? null,
      target: p.targets.get(r.id) ?? null,
      weights: p.weights === null ? null : (wl ?? []),
      excretion: p.excretion ? { snap: p.excretion, careLog } : null,
      thresholds: p.thresholds,
      thresholdsFor: p.thresholdsFor,
    })
    const cells = {} as Record<BoardColumn, BoardCell>
    for (const col of BOARD_COLUMNS) {
      // 8件で切った後でなく全件から取る（切られた列が「なし」と出ないように）
      const s = m.allSigns.find((x) => x.column === col)
      cells[col] = s ? { severity: s.severity, symbol: s.symbol, text: s.short, unavailable: false } : plainCell(col, m, wl !== null && wl.length > 0, p.meds !== null, p.incidents !== null)
    }
    const days = daysBetween(sparkFrom, p.today)
    const tempSpark = m.vitals.temp.spark.slice(m.vitals.temp.spark.length - days.length)
    let top: Severity | null = null
    for (const s of m.signs) if (sevRank(s.severity) > sevRank(top)) top = s.severity
    out.push({
      residentId: r.id,
      name: r.name,
      room: r.room,
      order,
      away: m.away,
      signCount: m.signTotal,
      topSeverity: top,
      signs: m.signs,
      cells,
      tempSpark,
    })
  })
  return out
}

/** 並べ替え（写しを返す）。room＝居室の順・changes＝兆しの件数の多い順→最も重い印の重い順→居室の順 */
export function sortBoardRows(rows: readonly BoardRow[], sort: GlanceSort): BoardRow[] {
  const list = rows.slice()
  if (sort === 'changes') {
    return list.sort((a, b) => b.signCount - a.signCount || sevRank(b.topSeverity) - sevRank(a.topSeverity) || a.order - b.order)
  }
  return list.sort((a, b) => a.order - b.order)
}

/** 見守りボードの体温の小さい線の縦軸（全員同じ。カルテの体温の軸の決め方＝chart.ts の chartDomain） */
export function boardTempDomain(rows: readonly Pick<BoardRow, 'tempSpark'>[]): [number, number] {
  const vals: number[] = []
  for (const r of rows) for (const v of r.tempSpark) if (typeof v === 'number' && Number.isFinite(v)) vals.push(v)
  return chartDomain(vals, KARTE_AXES.temp)
}
