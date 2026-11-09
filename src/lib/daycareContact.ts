// デイ（せせらぎ）段階4: 連絡帳の紙面の組み立て（純関数・副作用なし・DB/DOM に触れない）。2026-11-09 計画C。
// tests/daycare-contact.test.mjs から node で直接読む（拡張子付きで import する）。
//
// ・材料は今ある読み込み（今日の画面と同じ loadDaycareDayParts の読み手＋fetchTrainingSessions）と、連絡帳の2表（0061）
//   （その日の全員共通の一文 daycare_day_notes・1人1日のひと言 daycare_contact_notes）。新しい RPC は作らない
// ・紙面の並び（DESIGN v1 §7・写真は載せない）: 見出し（事業所名・「連絡帳」・日付）／「◯◯ 様」／今日のご様子（体温・血圧・脈拍・
//   SpO2 の表。再測定がある時は最後の回の値と「※ 再測定した値を載せています」）／入浴・お食事・水分・活動・機能訓練／
//   職員より（共通の一文＋個別のひと言）／看護職より（基準を外れたバイタルがある時だけ）／ご家族より（手書きの罫線4本）／
//   下端（記入者・次回のご利用日。どちらも手書きの欄）
// ・記録が無い項目は必ず「記録なし」（空の欄・「—」・「異常なし」にしない）。読めなかった項目は「読み込めませんでした」
//   （記録が無いことと取り違えない）。入浴の予定が無い日は「今日は入浴の予定はありませんでした」
// ・来ていない方（休み・入院中・まだ到着していない方）の紙は作れるが、本文は「本日はお休みでした」などの1文で、記録の欄を出さない
// ・紙面には判定の記号（↑↓）を載せない。基準を外れたかは今の vitalNeedsRecheck（利用者ごとの基準が優先）で判定し、値は数値で出す
// 個人情報は扱わない（数値と記録の言葉だけ。氏名は画面が渡し、ここでは並べるだけ）。

import { BATH_CANCEL_REASON_LABEL, BATH_RESULT_LABEL, MEAL_STATUS_LABEL } from './types.ts'
import type { BathRecord, FluidIntake, Meal } from './types.ts'
import { DAYCARE_VITAL_FIELDS, daycareBathStatus, daycareVitalSlots, vitalNeedsRecheck } from './daycare.ts'
import type { AttendanceState, DaycareVitalField, KeyedVital } from './daycare.ts'
import { activitiesOf, activityText } from './daycareActivity.ts'
import type { DaycareActivity } from './daycareActivity.ts'
import { TRAINING_CANCEL_REASON_LABEL, sessionOf } from './daycareTraining.ts'
import type { DaycareTrainingSession } from './daycareTraining.ts'
import { fluidTotalOf } from './daycarePerson.ts'
import type { ResidentTargets } from './vitalAlerts.ts'
import type { VitalThresholds } from './vitalThresholds.ts'

// ══════════════════════════════════════════════════════════════
// 連絡帳の2表の行（0061）と、ひと言の長さ
// ══════════════════════════════════════════════════════════════

/** 全員共通の一文の上限（字・DB の check と同じ） */
export const DAY_NOTE_MAX = 200
/** 個別のひと言の上限（字・DB の check と同じ） */
export const CONTACT_BODY_MAX = 200
/** 看護職のひと言の上限（字・DB の check と同じ） */
export const CONTACT_NURSE_MAX = 150

/** その日の全員共通の一文（daycare_day_notes・削除済みは持たない） */
export interface DaycareDayNote {
  id: number
  day: string
  body: string | null
  rev: number
}

/** 1人1日の連絡帳のひと言（daycare_contact_notes・削除済みは持たない） */
export interface DaycareContactNote {
  id: number
  resident_id: number
  day: string
  /** 職員の個別のひと言 */
  body: string | null
  /** 看護職のひと言 */
  nurse_note: string | null
  /** 最後に印刷した時刻（ISO） */
  printed_at: string | null
  rev: number
}

/** 1人のひと言の欄（別々に書く欄＝変えた欄だけを送る） */
export type ContactNoteField = 'body' | 'nurse_note'

/** 欄の上限（字） */
export function contactFieldMax(field: ContactNoteField): number {
  return field === 'body' ? CONTACT_BODY_MAX : CONTACT_NURSE_MAX
}

/** 字数（DB の char_length と同じ数え方＝サロゲートの文字も1字） */
export function noteLength(text: string): number {
  return [...text].length
}

/** 送る形にそろえる（前後の空白を落とし、空は null＝欄を空にする） */
export function normalizeNoteText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null
  const t = text.trim()
  return t === '' ? null : t
}

/** 長さの誤り（上限を超えたら理由の文・それ以外は null） */
export function noteLengthError(text: string, max: number): string | null {
  const t = normalizeNoteText(text)
  if (t === null) return null
  return noteLength(t) > max ? `${max}字までにしてください（いま ${noteLength(t)}字）。` : null
}

/** その方・その日のひと言の行（無ければ null） */
export function contactNoteOf(list: readonly DaycareContactNote[], residentId: number, day: string): DaycareContactNote | null {
  return list.find((n) => n.resident_id === residentId && n.day === day) ?? null
}

// ══════════════════════════════════════════════════════════════
// 紙面の組み立て
// ══════════════════════════════════════════════════════════════

/** 記録が無い項目の言葉（空の欄・「—」・「異常なし」にしない） */
export const NO_RECORD = '記録なし'
/** 読めなかった項目の言葉（記録が無いことと取り違えない） */
export const UNREAD = '読み込めませんでした'
/** 入浴の予定が無い日 */
export const NO_BATH_PLAN = '今日は入浴の予定はありませんでした'
/** 再測定がある時の注記 */
export const RECHECK_NOTE = '※ 再測定した値を載せています'

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土']

/** '2026-11-09' → '2026年11月9日（月）'（紙面の日付） */
export function sheetDateLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (Number.isNaN(dt.getTime())) return iso
  return `${y}年${m}月${d}日（${WEEKDAY[dt.getUTCDay()]}）`
}

/** 紙面のバイタルの1欄 */
export interface SheetVitalCell {
  label: string
  value: string
}

/** 紙面の項目（入浴・お食事・水分・活動・機能訓練） */
export interface SheetItem {
  label: string
  value: string
}

/** 1人の紙面 */
export interface ContactSheet {
  residentId: number
  /** 事業所名（空なら出さない） */
  officeName: string
  dateLabel: string
  name: string
  /** 来た方（在席・帰宅）。来ていない方は記録の欄を出さない */
  attended: boolean
  /** 来ていない方の本文（来た方は null） */
  absentText: string | null
  /** 今日のご様子（来ていない方は null）。unread＝バイタルを読めなかった */
  vitals: { kind: 'ok'; cells: SheetVitalCell[]; recheck: boolean } | { kind: 'unread' } | null
  /** 入浴・お食事・水分・活動・機能訓練（来ていない方は空） */
  items: SheetItem[]
  /** 職員より（共通の一文・個別のひと言。両方無い時は空＝紙面は「記録なし」） */
  staff: { common: string | null; personal: string | null }
  /** ひと言（連絡帳の2表）を読めなかった（職員より・看護職よりは「読み込めませんでした」） */
  notesUnread: boolean
  /** 基準を外れたバイタルがある（最後の回の値で判定）。看護職の欄を出す */
  abnormal: boolean
  /** 看護職のひと言（abnormal の時だけ紙面に出す。空なら「記録なし」） */
  nurse: string | null
}

/** 紙面の材料（1人分）。一覧の読み込みをそのまま渡す（ほかの方の行が混ざってもその方の分だけ使う） */
export interface ContactSheetInput {
  residentId: number
  day: string
  name: string
  officeName: string
  state: AttendanceState
  hospitalized: boolean
  bathingPlanned: boolean
  /** その日のデイの測定（生きている行・client_key つき） */
  vitals: readonly KeyedVital[]
  vitalsOk: boolean
  /** 個別の目標（SpO2 の下限など・無ければ null） */
  target: ResidentTargets | null | undefined
  /** その方・その日の基準（useVitalLimits の lookup。利用者ごとの基準が優先） */
  thresholds: VitalThresholds
  /** その方のその日の入浴の行（無ければ null） */
  bath: BathRecord | null
  bathsOk: boolean
  /** その方のその日の昼食（無ければ null） */
  lunch: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null
  /** その日の水分（全員分でよい） */
  fluids: readonly Pick<FluidIntake, 'resident_id' | 'taken_on' | 'amount_ml'>[]
  /** 昼食・水分を読めたか */
  intakeOk: boolean
  /** その日の活動（全員分でよい・null＝読めない） */
  activities: readonly DaycareActivity[] | null
  /** その日の機能訓練の記録（全員分でよい・null＝読めない） */
  training: readonly DaycareTrainingSession[] | null
  /** その日の全員共通の一文 */
  dayNote: string | null
  /** その方のその日のひと言の行（無ければ null） */
  note: Pick<DaycareContactNote, 'body' | 'nurse_note'> | null
  /** ひと言（共通の一文・1人のひと言）を読めたか（省くと読めた） */
  notesOk?: boolean
}

/** 来た方（在席・帰宅）か。印刷する方の既定もこれ */
export function attendedState(state: AttendanceState): boolean {
  return state === 'present' || state === 'left'
}

/** 来ていない方の本文 */
export function absentTextOf(state: AttendanceState, hospitalized: boolean): string {
  if (state === 'absent') return '本日はお休みでした。'
  if (hospitalized) return '入院中のため、本日はお休みでした。'
  return '本日のご利用の記録はありません。'
}

/** 紙面に載せる回（値のある回のうち一番後の回）と、値のある回が2つ以上か（再測定） */
export function sheetVitalValues(
  vitals: readonly KeyedVital[],
  residentId: number,
  day: string,
): { values: Record<DaycareVitalField, number | null> | null; recheck: boolean } {
  const slots = daycareVitalSlots(vitals, [], residentId, day).filter(
    (s) => s.vital !== null && DAYCARE_VITAL_FIELDS.some((f) => s.vital?.[f] !== null && s.vital?.[f] !== undefined),
  )
  if (slots.length === 0) return { values: null, recheck: false }
  const last = slots.reduce((a, b) => (b.seq > a.seq ? b : a))
  const v = last.vital as KeyedVital
  return {
    values: { temp: v.temp, sys_bp: v.sys_bp, dia_bp: v.dia_bp, pulse: v.pulse, spo2: v.spo2 },
    recheck: slots.length >= 2,
  }
}

/** 紙面のバイタルの4欄（体温・血圧・脈拍・SpO2）。値が無い欄は「記録なし」。判定の記号は付けない */
export function sheetVitalCells(values: Record<DaycareVitalField, number | null> | null): SheetVitalCell[] {
  const v = values ?? { temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null }
  const bp =
    v.sys_bp === null && v.dia_bp === null
      ? NO_RECORD
      : v.sys_bp !== null && v.dia_bp !== null
        ? `${v.sys_bp}/${v.dia_bp} mmHg`
        : `上 ${v.sys_bp === null ? NO_RECORD : v.sys_bp}／下 ${v.dia_bp === null ? NO_RECORD : v.dia_bp}`
  return [
    { label: '体温', value: v.temp === null ? NO_RECORD : `${v.temp.toFixed(1)}℃` },
    { label: '血圧', value: bp },
    { label: '脈拍', value: v.pulse === null ? NO_RECORD : `${v.pulse} 回/分` },
    { label: 'SpO2', value: v.spo2 === null ? NO_RECORD : `${v.spo2}%` },
  ]
}

/** 入浴の欄 */
export function sheetBathText(bath: BathRecord | null, bathingPlanned: boolean, bathsOk: boolean): string {
  if (!bathsOk) return UNREAD
  const st = daycareBathStatus(bath, bathingPlanned)
  if (st.kind === 'noPlan') return NO_BATH_PLAN
  if (st.kind === 'todo') return NO_RECORD
  // 自動の記録（予定から入った全身浴など）は、今日の画面と同じく入ったものとして出す（代表者の決定 2026-10-23 の 3）
  if (st.kind === 'auto' || st.kind === 'done') return `入浴しました（${BATH_RESULT_LABEL[st.record.result]}）`
  const r = st.record.cancel_reason
  return r === null ? '入浴しませんでした' : `入浴しませんでした（${BATH_CANCEL_REASON_LABEL[r]}）`
}

/** お食事の欄（昼食の主食・副食。片方だけ無い時はその側を「記録なし」） */
export function sheetLunchText(lunch: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null, intakeOk: boolean): string {
  if (!intakeOk) return UNREAD
  if (lunch === null) return NO_RECORD
  if (lunch.status === 'refused') return '昼食は召し上がりませんでした'
  if (lunch.status === 'out' || lunch.status === 'hospital') return `昼食 ${MEAL_STATUS_LABEL[lunch.status]}`
  const m = lunch.main_amount
  const s = lunch.side_amount
  if (m === null && s === null) return NO_RECORD
  return `昼食 主食 ${m === null ? NO_RECORD : `${m}割`}・副食 ${s === null ? NO_RECORD : `${s}割`}`
}

/** 水分の欄（その日の合計 ml。記録の行が無ければ「記録なし」） */
export function sheetFluidText(
  fluids: readonly Pick<FluidIntake, 'resident_id' | 'taken_on' | 'amount_ml'>[],
  residentId: number,
  day: string,
  intakeOk: boolean,
): string {
  if (!intakeOk) return UNREAD
  if (!fluids.some((f) => f.resident_id === residentId && f.taken_on === day)) return NO_RECORD
  return `${fluidTotalOf(fluids, residentId, day).toLocaleString('ja-JP')} ml`
}

/** 活動の欄（その日の活動の名前。参加以外は度合いを添える） */
export function sheetActivityText(activities: readonly DaycareActivity[] | null, residentId: number, day: string): string {
  if (activities === null) return UNREAD
  const mine = activitiesOf(activities, residentId, day)
  return mine.length === 0 ? NO_RECORD : mine.map(activityText).join('・')
}

/** 機能訓練の欄（実施・内容） */
export function sheetTrainingText(training: readonly DaycareTrainingSession[] | null, residentId: number, day: string): string {
  if (training === null) return UNREAD
  const s = sessionOf(training, residentId, day)
  if (s === null) return NO_RECORD
  if (s.result === 'cancelled') return s.cancel_reason === null ? '中止' : `中止（${TRAINING_CANCEL_REASON_LABEL[s.cancel_reason]}）`
  const head = s.result === 'partial' ? '一部実施' : '実施'
  return `${head}（${s.program}${s.duration_min === null ? '' : `・${s.duration_min}分`}）`
}

/** 1人の紙面を組む */
export function buildContactSheet(p: ContactSheetInput): ContactSheet {
  const attended = attendedState(p.state)
  const notesUnread = p.notesOk === false
  const personal = notesUnread ? null : normalizeNoteText(p.note?.body ?? null)
  const base = {
    residentId: p.residentId,
    officeName: p.officeName.trim(),
    dateLabel: sheetDateLabel(p.day),
    name: p.name,
  }
  if (!attended) {
    // 来ていない方: 記録の欄を出さない（共通の一文はその日のご様子なので載せない。個別のひと言は書いてあれば載せる）
    return {
      ...base,
      attended: false,
      absentText: absentTextOf(p.state, p.hospitalized),
      vitals: null,
      items: [],
      staff: { common: null, personal },
      notesUnread,
      abnormal: false,
      nurse: null,
    }
  }
  const { values, recheck } = sheetVitalValues(p.vitals, p.residentId, p.day)
  const abnormal = p.vitalsOk && values !== null && vitalNeedsRecheck(values, p.target ?? null, p.thresholds)
  return {
    ...base,
    attended: true,
    absentText: null,
    vitals: p.vitalsOk ? { kind: 'ok', cells: sheetVitalCells(values), recheck } : { kind: 'unread' },
    items: [
      { label: '入浴', value: sheetBathText(p.bath, p.bathingPlanned, p.bathsOk) },
      { label: 'お食事', value: sheetLunchText(p.lunch, p.intakeOk) },
      { label: '水分', value: sheetFluidText(p.fluids, p.residentId, p.day, p.intakeOk) },
      { label: '活動', value: sheetActivityText(p.activities, p.residentId, p.day) },
      { label: '機能訓練', value: sheetTrainingText(p.training, p.residentId, p.day) },
    ],
    staff: { common: notesUnread ? null : normalizeNoteText(p.dayNote), personal },
    notesUnread,
    abnormal,
    nurse: abnormal && !notesUnread ? normalizeNoteText(p.note?.nurse_note ?? null) : null,
  }
}

/**
 * 印刷の前に確かめる方: 選んだ方のうち「基準を外れたバイタルがあるのに看護職のひと言が空」の方（並びは渡した順）。
 * ひと言を読めなかった方も入れる（空かどうかを確かめられない）
 */
export function nurseNoteMissing(
  sheets: readonly Pick<ContactSheet, 'residentId' | 'abnormal' | 'nurse' | 'notesUnread'>[],
  picked: ReadonlySet<number>,
): number[] {
  return sheets.filter((s) => picked.has(s.residentId) && s.abnormal && s.nurse === null).map((s) => s.residentId)
}

/** 印刷する方の既定（来た方＝在席・帰宅） */
export function defaultPicked(rows: readonly { residentId: number; state: AttendanceState }[]): Set<number> {
  return new Set(rows.filter((r) => attendedState(r.state)).map((r) => r.residentId))
}

/** 連絡帳の画面のルート（業務日は ?day= で持つ。今日は付けない） */
export function contactPath(day: string, today: string): string {
  return `/record/daycare/contact${day === today ? '' : `?day=${day}`}`
}
