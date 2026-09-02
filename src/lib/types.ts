// 型・定数・しきい値の正本（凍結契約）。
// ビルダーはこのファイルを変更しない。変更が必要になったら実装せずチーフへ差し戻す。

// routine=定時1回/日 ・ recheck=再検枠 ・ observation=発熱者（経過観察） ・ symptom=他症状者
// （observation / symptom は現行スプシの申し送りシート上部2ブロックに対応。1人1日複数行を許す）
export type VitalKind = 'routine' | 'recheck' | 'observation' | 'symptom'
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
  /**
   * 申し送りでの表示名（2026-09-01 指示）。同姓の入居者を見分けるための表示専用の別名。
   * 空（null）＝マスタの氏名（name）をそのまま出す。
   * ★申し送りを扱う画面**だけ**で使う。バイタル・食事・カルテ・外出外泊はマスタの氏名のまま。
   * ★マスタ同期（gasClient.applyResidents）はこの列に触れないので、同期で消えない。
   */
  note_alias: string | null
}

/** 申し送りでの表示名の最大文字数（長い別名は行の幅を壊すので上限を置く） */
export const NOTE_ALIAS_MAX = 30

/**
 * 氏名を突き合わせる時のキー。空白（半角・全角）を除いて比べる。
 * 姓と名の間が半角空白か全角空白か、という違いだけで別人と扱わないため。
 */
export function nameKey(s: string): string {
  return s.replace(/[\s\u3000]/g, '')
}

/**
 * 申し送りでの表示名。設定が無ければマスタの氏名を返す。
 * **申し送りを扱う画面だけがこれを呼ぶ**（呼ばない画面はマスタの氏名のまま）。
 */
export function noteDisplayName(r: Resident): string {
  const alias = r.note_alias === null ? '' : r.note_alias.trim()
  return alias === '' ? r.name : alias
}

/** 表示名を設定してあるか（マスタの氏名と違う名前で出している行か） */
export function hasNoteAlias(r: Resident): boolean {
  return noteDisplayName(r) !== r.name
}

export type NoteAliasCheck =
  | { ok: true; value: string | null }
  | { ok: false; message: string }

/**
 * 申し送りでの表示名の検証（保存前に必ず通す）。
 *
 * 空にした時は null を返す＝マスタの氏名に戻す（空文字を保存しない。null と空の区別・原則12）。
 *
 * ★**他の方のマスタ氏名・他の方の表示名と同じ名前は弾く。**
 *   取り違えを防ぐための機能なのに、別人と同じ表示にできてしまうと逆効果になるため。
 *   比較は nameKey（空白を除く）で行う。
 *
 * @param raw    入力された文字
 * @param selfId 設定しようとしている利用者のID（自分自身は突き合わせから外す）
 * @param others 突き合わせ相手（**退居された方も含めた全員**を渡す。過去の記録に残るため）
 */
export function validateNoteAlias(
  raw: string,
  selfId: number,
  others: Resident[],
): NoteAliasCheck {
  const value = raw.trim()
  if (value === '') return { ok: true, value: null }
  if (value.length > NOTE_ALIAS_MAX) {
    return { ok: false, message: `表示名は${NOTE_ALIAS_MAX}文字までにしてください。` }
  }
  const key = nameKey(value)
  if (key === '') return { ok: false, message: '空白だけの表示名は使えません。' }
  for (const o of others) {
    if (o.id === selfId) continue
    if (nameKey(o.name) === key) {
      return {
        ok: false,
        message: '別の利用者のお名前と同じ表示名は使えません（取り違えのもとになります）。',
      }
    }
    const alias = o.note_alias === null ? '' : o.note_alias.trim()
    if (alias !== '' && nameKey(alias) === key) {
      return {
        ok: false,
        message: '別の利用者の表示名と同じ表示名は使えません（取り違えのもとになります）。',
      }
    }
  }
  return { ok: true, value }
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
  /** 他症状者ブロックの「症状」欄（kind='symptom' で使う） */
  symptom: string | null
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
  /** 行の色。null=既定（白）。生の色コードでなくトークン名を持つ（ダークモードでも読める色へ解決する） */
  color: NoteColor | null
  /** 日勤の「↓16時以降の記録」より後に書かれた行（現行スプシの区切りを再現する） */
  after16: boolean
  rev: number
  read_count?: number
  my_read?: boolean
}

/** 申し送り行の色。既定は用途に紐づくが、記入者が後から変更できる（現行スプシの手動着色に相当） */
export type NoteColor = 'pink' | 'yellow' | 'blue' | 'green' | 'orange'

export const NOTE_COLOR_LABEL: Record<NoteColor, string> = {
  pink: '予定',
  yellow: '全体連絡',
  blue: '医療・受診',
  green: '完了・確認済み',
  orange: '要注意',
}

/** 出勤者（現行スプシ申し送りシート上部の「施設長／出勤者」欄） */
export interface Attendance {
  day: string
  staff_id: number
  role: 'manager' | 'staff'
  sort: number
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
  /**
   * 職員名簿の接続先（2026-08-29 追加）。
   * 利用者名簿は入居者マスタGAS、職員名簿はシフト連携GASと**別のGAS**が持っているため、
   * 1つのURLに両方を問い合わせても職員名簿は永久に取得できなかった。
   * 未設定なら利用者名簿と同じ接続先へ問い合わせる（従来の挙動のまま＝既存端末を壊さない）。
   */
  staffGasUrl: 'cl_staffGasUrl',
  staffGasToken: 'cl_staffGasToken',
  /** 表示倍率（100/125/150）。スプシと同じ文字サイズを既定にしつつ、端末ごとに拡大できる */
  zoom: 'cl_zoom',
  /** 一覧に横並びする日数（1/4/7/11） */
  sheetDays: 'cl_sheetDays',
  /** 一覧で表示中のフロア（1/2/all） */
  sheetFloor: 'cl_sheetFloor',
  /**
   * 日報のインライン下書き（2026-09-02 追加。データ保護レイヤー＝draftNote と同じ例外扱い）。
   * 実際のキーは `${dailyDraft}:${YYYY-MM-DD}`（日ごと）。
   * 保持するのは 利用者ID（数値）・記入者ID・色・未送信の文字だけで、**氏名は持たない**。
   * 24時間で失効し、保存済み・送信待ちに退避した行は持たない（二重登録を作らない）。
   * 以前は React state だけだったため、対象・記入者・色を選んで本文を打つ前に
   * リロードすると跡形もなく消えていた（保存経路の監査で判明）。
   */
  dailyDraft: 'cl_dailyDraft',
} as const

/**
 * 表示倍率の選択肢（%）。スプシ実測が 10〜11pt ≒ 13px なので 100% = 13px 基準。
 *
 * 200% を置いてあるのは文字を大きくするためだけではない。行高が 22px×2 = 44px になり、
 * 連続した行でもタップ領域が 44px 以上になる（介護現場要件）。
 * 22px ピッチのまま全行に 44px を配ることは幾何学的に不可能（隣の行から奪うことになる）なので、
 * 「スプシと同じ密度（100%）」と「手袋でも押せる密度（200%）」を職員が選べる形にした。
 */
export const ZOOM_STEPS = [100, 125, 150, 200] as const
export type Zoom = (typeof ZOOM_STEPS)[number]

/** 一覧の横並び日数（スプシ実測: バイタル4日・食事11日） */
export const SHEET_DAYS = [1, 4, 7, 11] as const
export type SheetDays = (typeof SHEET_DAYS)[number]

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
