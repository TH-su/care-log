// デイ（せせらぎ）段階3a: 個別機能訓練の実施記録とその日の配置の純ロジック（副作用なし・DB/DOM に触れない）。
// tests/daycare-training.test.mjs から node で直接読む（拡張子付きで import する）。
//
// ・表は daycare_training_sessions（1人1日1件）と daycare_staffing（移行 0046）。2026-10-23 代表者承認・段階3の計画 v1 の 1章・3章・8章
// ・完了・一部は 開始時刻・内容・時間・指導員・結果 が必須。中止は時間を持たず、理由が必須（その他は一言も）
// ・〔完了〕の既定: 内容＝その方の前回（中止を除く）・時間＝20分・指導員＝その日の配置の機能訓練指導員・開始時刻＝押した時刻−時間（来所時刻より前にはしない）
// ・前回コピーは内容だけ（DESIGN v1 の決まり。時間・結果はコピーしない）
// 個人情報は扱わない（内容・時刻・数値・職員ID だけ。氏名は画面が持つ）。
import { daycareBulkRows } from './daycare.ts'
import type { DaycareBoardRow } from './daycare.ts'
import type { DaycareAttendance } from './types.ts'

export type TrainingResult = 'done' | 'partial' | 'cancelled'
export const TRAINING_RESULTS: readonly TrainingResult[] = ['done', 'partial', 'cancelled']
export const TRAINING_RESULT_LABEL: Record<TrainingResult, string> = { done: '完了', partial: '一部', cancelled: '中止' }

export type TrainingCancelReason = 'condition' | 'refused' | 'time' | 'other'
export const TRAINING_CANCEL_REASONS: readonly TrainingCancelReason[] = ['condition', 'refused', 'time', 'other']
/** 中止の理由（代表者の決定 2026-10-23・段階3の計画の質問7）。欠席の方は対象者に出ないので入れない */
export const TRAINING_CANCEL_REASON_LABEL: Record<TrainingCancelReason, string> = {
  condition: '体調不良',
  refused: '本人の希望',
  time: '時間が取れなかった',
  other: 'その他',
}

export type StaffingRole = 'trainer' | 'nurse'
export const STAFFING_ROLES: readonly StaffingRole[] = ['trainer', 'nurse']
export const STAFFING_ROLE_LABEL: Record<StaffingRole, string> = { trainer: '機能訓練指導員', nurse: '看護職員' }

/** 内容の定型のチップ（初回の入れやすさのため。〔その他〕は自由入力） */
export const TRAINING_PROGRAM_CHIPS: readonly string[] = ['立ち上がり', '歩行', '筋力', 'バランス', '関節の運動', '手指の運動']
/** 内容の長さの上限（DB の check と同じ） */
export const TRAINING_PROGRAM_MAX = 100
/** 時間の既定（分・DESIGN v1）と範囲（DB の check と同じ） */
export const TRAINING_DEFAULT_MIN = 20
export const TRAINING_MIN_MIN = 1
export const TRAINING_MAX_MIN = 240
/** その他の一言・備考の長さの上限（DB の check と同じ） */
export const TRAINING_CANCEL_NOTE_MAX = 100
export const TRAINING_NOTE_MAX = 200

/** 実施記録の1行（daycare_training_sessions・削除済みは持たない） */
export interface DaycareTrainingSession {
  id: number
  resident_id: number
  /** 業務日（JST・YYYY-MM-DD） */
  day: string
  /** 開始時刻 'HH:MM'（秒は落とす） */
  started_at: string
  /** 実施した時間（分）。中止は null */
  duration_min: number | null
  program: string
  result: TrainingResult
  cancel_reason: TrainingCancelReason | null
  cancel_note: string | null
  instructor_id: number
  assisted_by: number | null
  note: string | null
  recorded_by: number | null
  rev: number
}

/** その日の配置の1行（daycare_staffing・削除済みは持たない） */
export interface DaycareStaffing {
  id: number
  day: string
  staff_id: number
  role: StaffingRole
  /** 'HH:MM' か null */
  from_time: string | null
  to_time: string | null
  note: string | null
  rev: number
}

/** 受信した結果・理由・役割の検査（知らない値は null＝受信値を信じない） */
export function trainingResultOf(v: unknown): TrainingResult | null {
  return typeof v === 'string' && (TRAINING_RESULTS as readonly string[]).includes(v) ? (v as TrainingResult) : null
}
export function cancelReasonOf(v: unknown): TrainingCancelReason | null {
  return typeof v === 'string' && (TRAINING_CANCEL_REASONS as readonly string[]).includes(v) ? (v as TrainingCancelReason) : null
}
export function staffingRoleOf(v: unknown): StaffingRole | null {
  return typeof v === 'string' && (STAFFING_ROLES as readonly string[]).includes(v) ? (v as StaffingRole) : null
}

/** 時刻を 'HH:MM' にそろえる（'10:05:00' → '10:05'）。読めなければ null */
export function hhmm(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/.exec(v.trim())
  return m === null ? null : `${m[1]}:${m[2]}`
}

/** 内容を送る形にそろえる: 全角・半角をそろえ（NFKC）、空白の並びを1つにし、前後の空白を落とす */
export function normalizeProgram(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

/** 時間の入力（全角・空白を許す）を数にする。整数でなければ null */
export function parseMinutes(text: string): number | null {
  const t = text.normalize('NFKC').trim()
  if (!/^\d{1,3}$/.test(t)) return null
  return Number(t)
}

/** 実施記録の入力（画面の小窓の値） */
export interface TrainingInput {
  result: TrainingResult
  /** 'HH:MM' */
  started_at: string
  /** 時間の入力（文字）。中止の時は使わない */
  minutes: string
  program: string
  instructor_id: number | null
  assisted_by: number | null
  cancel_reason: TrainingCancelReason | null
  cancel_note: string
  note: string
}

/** 欄ごとの理由（無ければ空） */
export type TrainingInputErrors = Partial<Record<'started_at' | 'minutes' | 'program' | 'instructor_id' | 'cancel_reason' | 'cancel_note' | 'note', string>>

/**
 * 実施記録の入力の検査（DB の check と同じ決まり）。完了・一部は 開始時刻・内容・時間・指導員 が必須。
 * 中止は時間を持たず、理由が必須（その他は一言も・空白だけは不可）
 */
export function trainingInputErrors(v: TrainingInput): TrainingInputErrors {
  const out: TrainingInputErrors = {}
  if (hhmm(v.started_at) === null) out.started_at = '開始時刻を入れてください。'
  const program = normalizeProgram(v.program)
  if (program === '') out.program = '内容を入れてください。'
  else if ([...program].length > TRAINING_PROGRAM_MAX) out.program = `内容は ${TRAINING_PROGRAM_MAX} 字までで入れてください。`
  if (v.instructor_id === null) out.instructor_id = '指導員を選んでください。'
  if (v.result === 'cancelled') {
    if (v.cancel_reason === null) out.cancel_reason = '中止の理由を選んでください。'
    else if (v.cancel_reason === 'other' && v.cancel_note.trim() === '') out.cancel_note = 'その他の理由を一言入れてください。'
    // 一言は「その他」の時だけ送るので、長さもその時だけ見る（理由を替えた後の見えない一言で保存できなくしない＝直しの確認の反証 軽2）
    else if (v.cancel_reason === 'other' && [...v.cancel_note].length > TRAINING_CANCEL_NOTE_MAX) out.cancel_note = `一言は ${TRAINING_CANCEL_NOTE_MAX} 字までで入れてください。`
  } else {
    const m = parseMinutes(v.minutes)
    if (m === null) out.minutes = '時間（分）を数字で入れてください。'
    else if (m < TRAINING_MIN_MIN || m > TRAINING_MAX_MIN) out.minutes = `時間は ${TRAINING_MIN_MIN}〜${TRAINING_MAX_MIN} 分で入れてください。`
  }
  if ([...v.note].length > TRAINING_NOTE_MAX) out.note = `備考は ${TRAINING_NOTE_MAX} 字までで入れてください。`
  return out
}

/** 送る形（検査を通った入力だけを渡す）。中止は時間を送らず、中止でなければ理由を送らない（DB の両向きの check に合わせる） */
export function trainingPayload(v: TrainingInput): {
  result: TrainingResult
  started_at: string
  duration_min: number | null
  program: string
  instructor_id: number
  assisted_by: number | null
  cancel_reason: TrainingCancelReason | null
  cancel_note: string | null
  note: string | null
} {
  const cancelled = v.result === 'cancelled'
  const note = v.note.trim() === '' ? null : v.note
  // 一言は「その他」の時だけ送る（理由を替えた後に、見えない一言を残さない＝段階3a の反証 軽6）
  const cancelNote = cancelled && v.cancel_reason === 'other' && v.cancel_note.trim() !== '' ? v.cancel_note.trim() : null
  return {
    result: v.result,
    started_at: hhmm(v.started_at) ?? '00:00',
    duration_min: cancelled ? null : (parseMinutes(v.minutes) ?? TRAINING_DEFAULT_MIN),
    program: normalizeProgram(v.program),
    instructor_id: v.instructor_id ?? 0,
    assisted_by: v.assisted_by,
    cancel_reason: cancelled ? v.cancel_reason : null,
    cancel_note: cancelled ? cancelNote : null,
    note,
  }
}

/** 日本時間の 0 時からの分を 'HH:MM' に（範囲の外は 0〜23:59 に収める） */
export function minToHhmm(min: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.floor(min)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/**
 * 開始時刻の既定: 押した時刻から時間を引いた時刻（〔完了〕は訓練の後に押すため・段階3の計画の質問6）。0 時より前にはしない。
 * 来所時刻（'HH:MM'）が分かる時は、来所より前にしない（来所直後に押すと来所前の時刻になるため・第6弾3）。
 * 来所時刻が押した時刻より後（端末の時計のずれ・入れ間違い）の時は、押した時刻より後にもしない
 */
export function defaultStartTime(nowMin: number, minutes: number = TRAINING_DEFAULT_MIN, arrivedAt: string | null = null): string {
  const start = nowMin - minutes
  const a = hhmm(arrivedAt)
  if (a === null) return minToHhmm(start)
  const arrivedMin = Number(a.slice(0, 2)) * 60 + Number(a.slice(3, 5))
  return minToHhmm(Math.max(start, Math.min(arrivedMin, nowMin)))
}

/** 開始時刻の既定を来所時刻へ寄せたか（寄せた時は 開始＋時間 が押した時刻より後になるので、一押しで保存せず小窓で確かめてもらう） */
export function startFloored(nowMin: number, minutes: number = TRAINING_DEFAULT_MIN, arrivedAt: string | null = null): boolean {
  return defaultStartTime(nowMin, minutes, arrivedAt) !== defaultStartTime(nowMin, minutes)
}

/** その日のその方の来所時刻（'HH:MM'・休みと時刻の無い行は見ない・2行あれば早い方）。無ければ null */
export function arrivedAtOf(list: readonly Pick<DaycareAttendance, 'resident_id' | 'day' | 'arrived_at' | 'absent'>[], residentId: number, day: string): string | null {
  let best: string | null = null
  for (const r of list) {
    if (r.resident_id !== residentId || r.day !== day || r.absent) continue
    const a = hhmm(r.arrived_at)
    if (a !== null && (best === null || a < best)) best = a
  }
  return best
}

/** その方の前回の内容（day より前の日の、中止でない記録のうち、いちばん新しい日の内容）。無ければ null */
export function previousProgram(list: readonly DaycareTrainingSession[], residentId: number, day: string): string | null {
  let best: DaycareTrainingSession | null = null
  for (const s of list) {
    if (s.resident_id !== residentId || s.day >= day || s.result === 'cancelled') continue
    if (best === null || s.day > best.day || (s.day === best.day && s.id > best.id)) best = s
  }
  return best?.program ?? null
}

/** その日の実施記録（その方の1件・無ければ null） */
export function sessionOf(list: readonly DaycareTrainingSession[], residentId: number, day: string): DaycareTrainingSession | null {
  return list.find((s) => s.resident_id === residentId && s.day === day) ?? null
}

/**
 * 今日の対象者: 一括の画面と同じ（予定の方のうち休み・入院中を除く全員と、予定外で来た方＝daycareBulkRows・2026-10-24 §9.4 の4。
 * それまでは段階3の計画の 6章で在席・帰宅だけ）。名簿に無い方は出さない
 */
export function trainingTargets(rows: readonly Pick<DaycareBoardRow, 'residentId' | 'state' | 'planned' | 'hospitalized'>[]): number[] {
  return daycareBulkRows(rows).map((r) => r.residentId)
}

/**
 * 〔完了〕の指導員の既定（段階3a の反証 中1）。その日の機能訓練指導員のうち、開始時刻 at（'HH:MM'）を含む時間帯の方
 * （時間帯の無い行は終日、片側だけ時刻がある行は無い側を一日の端とみなす）が1人に決まる時だけ、その方。at が空の時は、その日の指導員が1人だけならその方。
 * 決まらない（0人・2人以上）時は null（〔完了〕は小窓を開き、職員に選んでもらう）
 */
export function instructorFor(list: readonly DaycareStaffing[], day: string, at: string): number | null {
  const t = hhmm(at)
  const ids = new Set<number>()
  for (const s of list) {
    if (s.day !== day || s.role !== 'trainer') continue
    // 片側だけ時刻がある行は、無い側を一日の始まり・終わりとみなす（「〜12:00」の方を午後に選ばない＝直しの確認の反証 軽1）
    if (t !== null && !((s.from_time ?? '00:00') <= t && t < (s.to_time ?? '24:00'))) continue
    ids.add(s.staff_id)
  }
  return ids.size === 1 ? [...ids][0] : null
}

/** その日の記録のうち、今日の対象者に入っていない方の記録（到着を取り消した・欠席にした方など。画面は別の一覧で直せるように出す） */
export function sessionsOutsideTargets(list: readonly DaycareTrainingSession[], targets: readonly number[], day: string): DaycareTrainingSession[] {
  return list.filter((s) => s.day === day && !targets.includes(s.resident_id))
}

/** その日の配置の機能訓練指導員（職員ID・重なりなし・配置の順） */
export function trainersOf(list: readonly DaycareStaffing[], day: string): number[] {
  const out: number[] = []
  for (const s of list) if (s.day === day && s.role === 'trainer' && !out.includes(s.staff_id)) out.push(s.staff_id)
  return out
}

/**
 * 時間帯を分けずに、同じ日に機能訓練指導員と看護職員の両方に入っている職員（兼務の時は勤務表等で時間を明確に分けるとされる
 * ＝段階3の計画 3.4・11.2）。どちらかの行の時間帯が空なら数える。止めずに知らせるだけ
 */
export function dualRoleWithoutTime(list: readonly DaycareStaffing[], day: string): number[] {
  const out: number[] = []
  const rows = list.filter((s) => s.day === day)
  for (const t of rows) {
    if (t.role !== 'trainer') continue
    const n = rows.filter((s) => s.staff_id === t.staff_id && s.role === 'nurse')
    if (n.length === 0) continue
    const untimed = (s: DaycareStaffing) => s.from_time === null || s.to_time === null
    if ((untimed(t) || n.some(untimed)) && !out.includes(t.staff_id)) out.push(t.staff_id)
  }
  return out
}

/** 配置の時間帯の表示（'9:00〜10:00'・無ければ ''） */
export function staffingTimeText(s: Pick<DaycareStaffing, 'from_time' | 'to_time'>): string {
  const f = (t: string | null) => (t === null ? '' : t.replace(/^0(\d)/, '$1'))
  if (s.from_time === null && s.to_time === null) return ''
  return `${f(s.from_time)}〜${f(s.to_time)}`
}

/** 実施記録の1行の要約（一覧・1人の画面のカード） */
export function sessionText(s: DaycareTrainingSession): string {
  const t = s.started_at.replace(/^0(\d)/, '$1')
  if (s.result === 'cancelled') {
    const why = s.cancel_reason === null ? '' : TRAINING_CANCEL_REASON_LABEL[s.cancel_reason]
    return `中止（${why}${s.cancel_reason === 'other' && s.cancel_note ? `・${s.cancel_note}` : ''}）${t}`
  }
  return `${TRAINING_RESULT_LABEL[s.result]} ${t}〜 ${s.duration_min ?? '—'}分 ${s.program}`
}
