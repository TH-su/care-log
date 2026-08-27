// 型・定数・しきい値の正本（凍結契約）。
// ビルダーはこのファイルを変更しない。変更が必要になったら実装せずチーフへ差し戻す。

export type VitalKind = 'routine' | 'recheck' | 'observation'
export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack'
export type MealStatus = 'eaten' | 'out' | 'hospital' | 'refused'
export type Shift = 'day' | 'daycare' | 'night'
export type Importance = 'normal' | 'important' | 'critical'
export type OutingKind = 'outing' | 'overnight'

export interface Resident {
  id: number
  source_id: string
  name: string
  kana: string | null
  room: string | null
  gender: string | null
  care_level: string | null
  active: boolean
  needs_review: boolean
}

export interface Staff {
  id: number
  name: string
  active: boolean
}

export interface Vital {
  id: number
  resident_id: number
  measured_on: string
  kind: VitalKind
  measured_at: string | null
  temp: number | null
  sys_bp: number | null
  dia_bp: number | null
  pulse: number | null
  spo2: number | null
  note: string | null
  recorded_by: number | null
  rev: number
}

export interface Meal {
  id: number
  resident_id: number
  meal_on: string
  meal_slot: MealSlot
  main_amount: number | null
  side_amount: number | null
  status: MealStatus | null
  note: string | null
  recorded_by: number | null
  rev: number
}

export interface FluidIntake {
  id: number
  resident_id: number
  taken_on: string
  taken_at: string | null
  amount_ml: number
  kind: string | null
  recorded_by: number | null
  rev: number
}

export interface Note {
  id: number
  note_on: string
  shift: Shift
  facility: string | null
  category: string | null
  resident_id: number | null
  role_tags: string[]
  importance: Importance
  body: string
  occurred_at: string | null
  ongoing: boolean
  ended_at: string | null
  reporter_id: number | null
  rev: number
  read_count?: number
  my_read?: boolean
}

export interface Outing {
  id: number
  resident_id: number
  kind: OutingKind
  start_on: string
  start_at: string | null
  end_on: string | null
  end_at: string | null
  companion: string | null
  note: string | null
  recorded_by: number | null
  rev: number
}

export interface ImportDay {
  source: string
  day: string
  imported_at: string
  src_rows: number
  inserted: number
  updated: number
  skipped: number
  native_skip: number
  unmatched: number
}

export interface TimelineChunk {
  from: string
  to: string
  notes: Note[]
  vitals: Vital[]
  meals: Meal[]
  fluids: FluidIntake[]
  outings: Outing[]
  importDays: ImportDay[]
  pinned: Note[]
}

export interface DayData {
  day: string
  notes: Note[]
  vitals: Vital[]
  meals: Meal[]
  fluids: FluidIntake[]
  outings: Outing[]
  importDay: ImportDay | null
  pinned: Note[]
}

// ── しきい値（現行スプシの条件付き書式の凡例を定数化。値の変更は本人承認が必要） ──
export type Level = 'danger-high' | 'warn-high' | 'warn-low' | 'danger-low' | null

export function tempLevel(v: number | null): Level {
  if (v == null) return null
  if (v >= 38.1) return 'danger-high'
  if (v >= 37.5) return 'warn-high'
  if (v <= 35.5) return 'danger-low'
  return null
}
export function sysBpLevel(v: number | null): Level {
  if (v == null) return null
  if (v >= 151) return 'danger-high'
  if (v < 90) return 'warn-low'
  return null
}
export function diaBpLevel(v: number | null): Level {
  if (v == null) return null
  if (v >= 91) return 'danger-high'
  if (v < 50) return 'warn-low'
  return null
}
export function pulseLevel(v: number | null): Level {
  if (v == null) return null
  if (v >= 101) return 'danger-high'
  if (v < 40) return 'warn-low'
  return null
}
export function spo2Level(v: number | null): Level {
  if (v == null) return null
  if (v < 90) return 'danger-low'
  if (v < 93) return 'warn-low'
  return null
}

// 色だけに頼らない記号（↑↑=危険高値 ↑=注意高値 ↓=注意低値 ↓↓=危険低値）
export const LEVEL_MARK: Record<Exclude<Level, null>, string> = {
  'danger-high': '↑↑',
  'warn-high': '↑',
  'warn-low': '↓',
  'danger-low': '↓↓',
}

export function vitalHasAlert(v: Vital): boolean {
  return !!(
    tempLevel(v.temp) ||
    sysBpLevel(v.sys_bp) ||
    diaBpLevel(v.dia_bp) ||
    pulseLevel(v.pulse) ||
    spo2Level(v.spo2)
  )
}

// 食事の低摂取判定（仮置き: 主+副の合計が6以下。★本人確認事項）
export function isLowIntake(m: Meal): boolean {
  if (m.status && m.status !== 'eaten') return false
  if (m.main_amount == null && m.side_amount == null) return false
  return (m.main_amount ?? 0) + (m.side_amount ?? 0) <= 6
}

// バイタル入力の許容範囲（DB の check 制約と一致させる）
export const VITAL_RANGE: Record<'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2', [number, number]> = {
  temp: [30, 45],
  sys_bp: [40, 300],
  dia_bp: [20, 200],
  pulse: [20, 250],
  spo2: [50, 100],
}

// ── localStorage キー（dev-principles 原則11: UI状態のみ。氏名・記録本文を保存しない。
//    例外は sendQueue / draftNote（データ保護レイヤー・保持規則は docs/design/ui-design.md §6.5）と
//    staffId（数値のみ・staff スナップショットと照合して復元） ──
export const LS = {
  view: 'cl_view',
  recordTab: 'cl_recordTab',
  vitalsFloor: 'cl_vitalsFloor',
  karteRange: 'cl_karteRange',
  mode: 'cl_mode',
  staffId: 'cl_staffId',
  sendQueue: 'cl_sendQueue',
  draftNote: 'cl_draftNote',
  gasUrl: 'cl_gasUrl',
  gasToken: 'cl_gasToken',
} as const

// ── 表示ラベル ──
export const SHIFT_LABEL: Record<Shift, string> = { day: '日勤', daycare: 'デイ', night: '夜勤' }
export const IMPORTANCE_LABEL: Record<Importance, string> = {
  normal: '通常',
  important: '▲ 重要',
  critical: '‼ 最重要',
}
export const MEAL_SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: '朝',
  lunch: '昼',
  dinner: '夕',
  snack: '間食',
}
export const MEAL_STATUS_LABEL: Record<MealStatus, string> = {
  eaten: '喫食',
  out: '外出',
  hospital: '入院',
  refused: '拒食',
}
export const OUTING_KIND_LABEL: Record<OutingKind, string> = { outing: '外出', overnight: '外泊' }

// 職種タグの語彙（初期値。★運用開始時に本人確認）
export const ROLE_TAGS = ['介護', '看護', 'デイ', '厨房', 'ケアマネ', '事務'] as const
