// デイ（せせらぎ）段階4: 連絡帳の紙面の組み立て（純関数・副作用なし・DB/DOM に触れない）。2026-11-09 計画C。
// tests/daycare-contact.test.mjs から node で直接読む（拡張子付きで import する）。
//
// ・材料は今ある読み込み（今日の画面と同じ loadDaycareDayParts の読み手＋fetchTrainingSessions）と、連絡帳の2表（0061）
//   （その日の全員共通の一文 daycare_day_notes・1人1日のひと言 daycare_contact_notes）。新しい RPC は作らない
// ・紙面の並び（DESIGN v1 §7・写真は載せない）: 見出し（事業所名・「連絡帳」・日付）／「◯◯ 様」／今日のご様子（体温・血圧・脈拍・
//   SpO2 の表。再測定がある時は「※ 再測定した値を載せています」）／入浴・お食事・水分・活動・機能訓練／
//   職員より（共通の一文＋個別のひと言）／看護職より（基準を外れたバイタルがある時だけ）／ご家族より（手書きの罫線4本）／
//   下端（記入者・次回のご利用日。どちらも手書きの欄）
// ・「記録なし」は記録の項目（バイタル・食事・水分・入浴・活動・訓練）にだけ使う（空の欄・「—」・「異常なし」にしない）。
//   読めなかった項目は「読み込めませんでした」（記録が無いことと取り違えない）。入浴の予定が無い日は「今日は入浴の予定はありませんでした」
// ・ひと言の欄（職員より＝共通の一文・個別のひと言、看護職より）は、空なら見出しごと紙面に出さない（「記録なし」と刷らない。
//   2026-11-09 親の決定）。基準外なのに看護職のひと言が空の時は、印刷の前に画面が注意を出す（それでも刷る時は欄を出さない）
// ・バイタルは欄ごとに「値のある一番後の回」の値を合わせて載せ、その合わせた値で基準外を判定する（血圧は上と下を組で同じ回から。
//   2026-11-09 反証 重1）。再測定の注記は値のある回が2つ以上の時
// ・送信待ちの記録（この端末で入れて、まだ届いていない値）は、今日の画面と同じ決まり（daycareProgress.ts の lunchShownWith・
//   daycareVitalSlotsWithPending・vitalShownValues・activityShownCells）で紙面に重ねる（2026-11-09 反証 中2）。バイタルは紙だけ、
//   送信中（state 'pending'）の値に限って重ねる（競合・拒否で止まった値は載せず、印刷の前の確かめに並べる＝確認の反証 中2）。訓練の送信待ちの追加は
//   中身を読めないので紙は「記録なし」のままにし、見本の「送信待ちを含む」と印刷の前の確かめにだけ出す（2026-11-09 親の決定）
// ・来ていない方（休み・入院中・まだ到着していない方）の紙は作れるが、本文は「本日はお休みでした」などの1文で、記録の欄を出さない
// ・紙面には判定の記号（↑↓）を載せない。基準を外れたかは今の vitalNeedsRecheck（利用者ごとの基準が優先）で判定し、値は数値で出す
// ・〔未測定〕の印（2026-11-10・0062）のある欄は、紙と見本に「未測定」と出す（「記録なし」と分ける）。値がある欄は値（印は無視）。
//   どの回の印かは問わない（値が無く、どれかの回に印がある欄）。印を読めなかった時は印なし（今までどおり「記録なし」）
// 個人情報は扱わない（数値と記録の言葉だけ。氏名は画面が渡し、ここでは並べるだけ）。

import { BATH_CANCEL_REASON_LABEL, BATH_RESULT_LABEL, MEAL_STATUS_LABEL } from './types.ts'
import type { BathRecord, FluidIntake, Meal } from './types.ts'
import { DAYCARE_VITAL_FIELDS, daycareBathStatus, vitalNeedsRecheck } from './daycare.ts'
import type { AttendanceState, DaycareVitalField, KeyedVital } from './daycare.ts'
import { DAYCARE_ACTIVITY_CHIPS, activityText, participationOf } from './daycareActivity.ts'
import type { DaycareActivity } from './daycareActivity.ts'
import { TRAINING_CANCEL_REASON_LABEL, sessionOf } from './daycareTraining.ts'
import type { DaycareTrainingSession } from './daycareTraining.ts'
import { fluidTotalOf } from './daycarePerson.ts'
import { activityShownCells, daycareVitalSlotsWithPending, lunchShownWith, unmeasuredFieldsOf, vitalShownValues } from './daycareProgress.ts'
import type { ActivityPendingLike, DaycareVitalUnmeasured } from './daycareProgress.ts'
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
  /** 〔印刷する〕で印刷に送った最後の時刻（ISO）。Ctrl+P・⌘P で刷った時は書かない（2026-11-09 親の決定） */
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

/**
 * 入れかけの文と、入れ始めた時の保存値・いまの保存値の関係（2026-11-09 反証 中1: 入れかけの文が他の端末の保存を黙って上書きしない）。
 *   keep    … 入れ始めた後に保存値は変わっていない（そのまま入れ続けてよい）
 *   drop    … 保存値は変わったが、入れかけの文は入れ始めた時のまま・または新しい保存値と同じ（入れかけを捨てて新しい保存値を出す）
 *   changed … 保存値が変わり、入れかけの文もそれと違う（欄の下に知らせを出す。保存の基準は入れ始めた時のままにして上書きしない）
 */
export function draftAgainstSaved(draft: string, base: string | null, saved: string | null): 'keep' | 'drop' | 'changed' {
  const b = normalizeNoteText(base)
  const s = normalizeNoteText(saved)
  if (b === s) return 'keep'
  const d = normalizeNoteText(draft)
  return d === b || d === s ? 'drop' : 'changed'
}

// ══════════════════════════════════════════════════════════════
// 紙面の組み立て
// ══════════════════════════════════════════════════════════════

/** 記録が無い項目の言葉（記録の項目にだけ使う。空の欄・「—」・「異常なし」にしない） */
export const NO_RECORD = '記録なし'
/** 〔未測定〕の印のある、値の無いバイタルの欄の言葉（2026-11-10・「記録なし」と分ける） */
export const UNMEASURED = '未測定'
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
  /** 職員より（共通の一文・個別のひと言。両方無い時は見出しごと出さない） */
  staff: { common: string | null; personal: string | null }
  /** ひと言（連絡帳の2表）を読めなかった（職員より・看護職よりは「読み込めませんでした」） */
  notesUnread: boolean
  /** 基準を外れたバイタルがある（欄ごとに合わせた値で判定） */
  abnormal: boolean
  /** 看護職のひと言（abnormal の時だけ。空なら null＝看護職の欄は出さない） */
  nurse: string | null
  /** 送信待ちの値を重ねた項目の名前（画面の見本に「送信待ちを含む」と出す。紙には出さない） */
  pendingLabels: string[]
  /** 読めなかった項目の名前（印刷の前の確かめに並べる） */
  unreadLabels: string[]
  /** 入浴が自動の記録（12:30 の自動の行・まだ人が確かめていない）のまま（印刷の前の確かめに並べる。紙の文言は変えない） */
  autoBath: boolean
  /**
   * 機能訓練にこの端末の送信待ちがある（サーバーに記録が無い時の追加・サーバーの記録への直し／取り消し）。紙はサーバーの記録のまま
   * （送信待ちの中身は読めないため）。印刷の前の確かめに「送信待ちの機能訓練がある方」として並べる＝2026-11-09 親の決定・確認の反証 軽2
   */
  trainingQueued: boolean
  /** バイタルの送信待ちのうち、競合・拒否で送れずに止まっている値がある（紙には載せない。印刷の前の確かめに並べる） */
  vitalsStopped: boolean
}

/** 昼食の送信待ち（db.ts の pendingRow('meals', …) の形） */
export type LunchPendingLike = { state: string; values: Record<string, unknown> } | null
/** 測定の回の送信待ち（db.ts の pendingRow('vitals', …) の形。state＝'pending'（送信中）・'conflict'・'rejected'） */
export type VitalPendingLike = { state: string; values: Record<string, unknown> } | null
/** 機能訓練の送信待ち（db.ts の PendingTrainingOp の形の一部。追加は人と日・直し／取り消しは行の番号） */
export type TrainingPendingLike = { kind: string; table: string; residentId?: number; day?: string; rowId?: number }

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
  /** 測定の回のキー（'dc:<日>:<利用者id>:<回>'）ごとの送信待ち（省くと送信待ちなし） */
  vitalPending?: (key: string) => VitalPendingLike
  /** 個別の目標（SpO2 の下限など・無ければ null） */
  target: ResidentTargets | null | undefined
  /** その方・その日の基準（useVitalLimits の lookup。利用者ごとの基準が優先） */
  thresholds: VitalThresholds
  /** その方のその日の入浴の行（無ければ null） */
  bath: BathRecord | null
  bathsOk: boolean
  /** その方のその日の昼食（無ければ null） */
  lunch: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null
  /** その方のその日の昼食の送信待ち（省くと送信待ちなし） */
  lunchPending?: LunchPendingLike
  /** その日の水分（全員分でよい） */
  fluids: readonly Pick<FluidIntake, 'resident_id' | 'taken_on' | 'amount_ml'>[]
  /** 昼食・水分を読めたか */
  intakeOk: boolean
  /** その日の活動（全員分でよい・null＝読めない） */
  activities: readonly DaycareActivity[] | null
  /** 活動の送信待ち（db.ts の pendingActivityOps。省くと送信待ちなし） */
  activityPending?: readonly ActivityPendingLike[]
  /** その日の機能訓練の記録（全員分でよい・null＝読めない） */
  training: readonly DaycareTrainingSession[] | null
  /** 機能訓練の送信待ち（db.ts の pendingTrainingOps。省くと送信待ちなし） */
  trainingPending?: readonly TrainingPendingLike[]
  /** その日の全員共通の一文 */
  dayNote: string | null
  /** その方のその日のひと言の行（無ければ null） */
  note: Pick<DaycareContactNote, 'body' | 'nurse_note'> | null
  /** ひと言（共通の一文・1人のひと言）を読めたか（省くと読めた） */
  notesOk?: boolean
  /** その日の〔未測定〕の印（全員分でよい・省く／null＝印なし。2026-11-10・0062） */
  unmeasured?: readonly Pick<DaycareVitalUnmeasured, 'resident_id' | 'day' | 'seq' | 'field'>[] | null
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

/** 紙面に出す測定の1回（サーバーの値に送信中の値を重ねた値） */
export interface ShownVitalSlot {
  seq: number
  vals: Record<DaycareVitalField, number | null>
  /** この回に送信中の値を重ねた */
  pending: boolean
  /** この回に、競合・拒否で送れずに止まっている値がある（紙には重ねていない） */
  stopped: boolean
}

/** 紙に重ねてよい送信待ち（送信中＝state 'pending' だけ。昼食の lunchShownWith と同じ範囲） */
function sendingOnly(p: VitalPendingLike): VitalPendingLike {
  return p !== null && p.state === 'pending' ? p : null
}

/**
 * 1人のその日の測定の回（今日の画面と同じ決まり: サーバーの行＋送信待ちにだけある回。値は送信待ち → サーバーの順）。
 * pendingOf＝その回のキーの送信待ち（db.ts の pendingRow('vitals', …)）。紙だけの決まりとして、重ねるのは送信中（'pending'）の値だけ
 * （競合・拒否で止まった値は重ねず stopped で知らせる＝2026-11-09 確認の反証 中2。今日の画面・一括の画面の重ね方は変えない）
 */
export function contactVitalSlots(
  live: readonly KeyedVital[],
  residentId: number,
  day: string,
  pendingOf: (key: string) => VitalPendingLike = () => null,
): ShownVitalSlot[] {
  const keys = live.flatMap((v) => (typeof v.client_key === 'string' ? [v.client_key] : []))
  return daycareVitalSlotsWithPending(live, keys, residentId, day, [], (key) => pendingOf(key) !== null).map((slot) => {
    const raw = pendingOf(slot.key)
    const p = sendingOnly(raw)
    return {
      seq: slot.seq,
      vals: vitalShownValues(p, slot.vital),
      pending: p !== null && DAYCARE_VITAL_FIELDS.some((f) => f in p.values),
      stopped: raw !== null && p === null && DAYCARE_VITAL_FIELDS.some((f) => f in raw.values),
    }
  })
}

/**
 * 紙面に載せる値: 欄ごとに「値のある一番後の回」の値を合わせる（2026-11-09 反証 重1。再測定で一部の欄だけを入れた方の、
 * 入れなかった欄を前の回から出す）。血圧は上と下を組で、どちらかに値のある一番後の回から取る（違う回の上と下を混ぜない）。
 * recheck＝値のある回が2つ以上（再測定の注記）
 */
export function mergeVitalSlots(slots: readonly Pick<ShownVitalSlot, 'seq' | 'vals'>[]): {
  values: Record<DaycareVitalField, number | null> | null
  recheck: boolean
} {
  const withVal = slots.filter((s) => DAYCARE_VITAL_FIELDS.some((f) => s.vals[f] !== null)).sort((a, b) => a.seq - b.seq)
  if (withVal.length === 0) return { values: null, recheck: false }
  const out: Record<DaycareVitalField, number | null> = { temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null }
  for (const s of withVal) {
    // 後の回ほど後に上書きする（値の無い欄は前の回の値を残す）
    for (const f of ['temp', 'pulse', 'spo2'] as const) if (s.vals[f] !== null) out[f] = s.vals[f]
    if (s.vals.sys_bp !== null || s.vals.dia_bp !== null) {
      out.sys_bp = s.vals.sys_bp
      out.dia_bp = s.vals.dia_bp
    }
  }
  return { values: out, recheck: withVal.length >= 2 }
}

/** 紙面に載せる値（送信待ちを重ねた回から、欄ごとに合わせる）と、送信待ちを含むか */
export function sheetVitalValues(
  vitals: readonly KeyedVital[],
  residentId: number,
  day: string,
  pendingOf?: (key: string) => VitalPendingLike,
): { values: Record<DaycareVitalField, number | null> | null; recheck: boolean; pending: boolean; stopped: boolean } {
  const slots = contactVitalSlots(vitals, residentId, day, pendingOf)
  const m = mergeVitalSlots(slots)
  return {
    ...m,
    pending: slots.some((s) => s.pending && DAYCARE_VITAL_FIELDS.some((f) => s.vals[f] !== null)),
    stopped: slots.some((s) => s.stopped),
  }
}

/**
 * 紙面のバイタルの4欄（体温・血圧・脈拍・SpO2）。値が無い欄は「記録なし」。判定の記号は付けない。
 * 2026-11-10 未測定: unmeasured＝〔未測定〕の印のある欄（省くと印なし）。値が無く印のある欄は「未測定」（値があれば値＝印は無視）。
 * 血圧は上と下を別々に見て、両方とも同じ言葉ならその言葉だけ
 */
export function sheetVitalCells(
  values: Record<DaycareVitalField, number | null> | null,
  unmeasured?: ReadonlySet<DaycareVitalField> | null,
): SheetVitalCell[] {
  const v = values ?? { temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null }
  const none = (f: DaycareVitalField): string => (unmeasured?.has(f) === true ? UNMEASURED : NO_RECORD)
  const bp =
    v.sys_bp === null && v.dia_bp === null
      ? none('sys_bp') === none('dia_bp')
        ? none('sys_bp')
        : `上 ${none('sys_bp')}／下 ${none('dia_bp')}`
      : v.sys_bp !== null && v.dia_bp !== null
        ? `${v.sys_bp}/${v.dia_bp} mmHg`
        : `上 ${v.sys_bp === null ? none('sys_bp') : v.sys_bp}／下 ${v.dia_bp === null ? none('dia_bp') : v.dia_bp}`
  return [
    { label: '体温', value: v.temp === null ? none('temp') : `${v.temp.toFixed(1)}℃` },
    { label: '血圧', value: bp },
    { label: '脈拍', value: v.pulse === null ? none('pulse') : `${v.pulse} 回/分` },
    { label: 'SpO2', value: v.spo2 === null ? none('spo2') : `${v.spo2}%` },
  ]
}

/** 入浴が自動の記録（12:30 の自動の行・まだ人が確かめていない）のままか（中止の行は除く） */
export function bathIsAuto(bath: BathRecord | null): boolean {
  return bath !== null && bath.auto && bath.result !== 'cancel'
}

/** 入浴の欄 */
export function sheetBathText(bath: BathRecord | null, bathingPlanned: boolean, bathsOk: boolean): string {
  if (!bathsOk) return UNREAD
  const st = daycareBathStatus(bath, bathingPlanned)
  if (st.kind === 'noPlan') return NO_BATH_PLAN
  if (st.kind === 'todo') return NO_RECORD
  // 自動の記録（予定から入った全身浴など）は、今日の画面と同じく入ったものとして出す（代表者の決定 2026-10-23 の 3）
  if ((st.kind === 'auto' || st.kind === 'done') && st.record.result !== 'cancel') return `入浴しました（${BATH_RESULT_LABEL[st.record.result]}）`
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

/** 昼食の送信待ちを重ねた値と、重ねたか（今日の画面と同じ lunchShownWith＝送っている途中の値だけ重ねる） */
export function sheetLunchShown(
  lunch: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null,
  pending: LunchPendingLike | undefined,
): { lunch: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null; pending: boolean } {
  const p = pending ?? null
  const used = p !== null && p.state === 'pending' && ['main_amount', 'side_amount', 'status'].some((f) => f in p.values)
  return { lunch: lunchShownWith(lunch, p), pending: used }
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

/** 活動の欄（その日の活動の名前。参加以外は度合いを添える。送信待ちは今日の画面と同じ activityShownCells で重ねる） */
export function sheetActivityText(
  activities: readonly DaycareActivity[] | null,
  residentId: number,
  day: string,
  pending: readonly ActivityPendingLike[] = [],
): string {
  return sheetActivityShown(activities, residentId, day, pending).text
}

/** 活動の欄と、送信待ちを重ねたか */
export function sheetActivityShown(
  activities: readonly DaycareActivity[] | null,
  residentId: number,
  day: string,
  pending: readonly ActivityPendingLike[] = [],
): { text: string; pending: boolean } {
  if (activities === null) return { text: UNREAD, pending: false }
  const mine = activities.filter((a) => a.resident_id === residentId && a.day === day)
  const ids = new Set(mine.map((a) => a.id))
  const relevant = pending.filter((p) => (p.kind === 'add' ? p.residentId === residentId && p.day === day : ids.has(p.rowId)))
  const rank = (label: string) => {
    const i = DAYCARE_ACTIVITY_CHIPS.indexOf(label)
    return i < 0 ? DAYCARE_ACTIVITY_CHIPS.length : i
  }
  const order = (label: string) => mine.find((a) => a.label === label)?.id ?? Number.MAX_SAFE_INTEGER
  const shown = activityShownCells(mine, relevant, residentId, day)
    .filter((c) => c.shown !== null && !c.deleting)
    .sort((a, b) => rank(a.label) - rank(b.label) || order(a.label) - order(b.label))
    .map((c) => activityText({ label: c.label, participation: participationOf(c.shown) ?? 'full' }))
  // 止まった変更・取り消しは重ねない（activityShownCells）ので数えない。止まった追加はサーバーに無い項目なら重ねるので数える
  return { text: shown.length === 0 ? NO_RECORD : shown.join('・'), pending: relevant.some((p) => p.kind === 'add' || !p.stopped) }
}

/** 機能訓練の欄（実施・内容） */
export function sheetTrainingText(
  training: readonly DaycareTrainingSession[] | null,
  residentId: number,
  day: string,
  pending: readonly TrainingPendingLike[] = [],
): string {
  return sheetTrainingShown(training, residentId, day, pending).text
}

/**
 * 機能訓練の欄と、送信待ちがあるか。送信待ちの中身は読めない（db.ts の pendingTrainingOps は追加なら人と日・直し／取り消しなら
 * 行の番号だけ）ので、紙はサーバーの記録のまま（無ければ「記録なし」＝2026-11-09 親の決定）。queued＝その方の送信待ちの追加
 * （サーバーに記録が無い時）か、サーバーの記録への直し・取り消し（中止への変更など＝確認の反証 軽2）がある。見本の
 * 「送信待ちを含む」と印刷の前の確かめに使う
 */
export function sheetTrainingShown(
  training: readonly DaycareTrainingSession[] | null,
  residentId: number,
  day: string,
  pending: readonly TrainingPendingLike[] = [],
): { text: string; queued: boolean } {
  if (training === null) return { text: UNREAD, queued: false }
  const s = sessionOf(training, residentId, day)
  if (s === null) {
    const queued = pending.some((p) => p.kind === 'add' && p.table === 'daycare_training_sessions' && p.residentId === residentId && p.day === day)
    return { text: NO_RECORD, queued }
  }
  const updating = pending.some((p) => p.kind === 'update' && p.table === 'daycare_training_sessions' && p.rowId === s.id)
  if (s.result === 'cancelled') return { text: s.cancel_reason === null ? '中止' : `中止（${TRAINING_CANCEL_REASON_LABEL[s.cancel_reason]}）`, queued: updating }
  const head = s.result === 'partial' ? '一部実施' : '実施'
  return { text: `${head}（${s.program}${s.duration_min === null ? '' : `・${s.duration_min}分`}）`, queued: updating }
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
      pendingLabels: [],
      unreadLabels: notesUnread ? ['ひと言'] : [],
      autoBath: false,
      trainingQueued: false,
      vitalsStopped: false,
    }
  }
  const v = sheetVitalValues(p.vitals, p.residentId, p.day, p.vitalPending)
  const abnormal = p.vitalsOk && v.values !== null && vitalNeedsRecheck(v.values, p.target ?? null, p.thresholds)
  const lunch = sheetLunchShown(p.lunch, p.lunchPending)
  const act = sheetActivityShown(p.activities, p.residentId, p.day, p.activityPending)
  const tr = sheetTrainingShown(p.training, p.residentId, p.day, p.trainingPending)
  const pendingLabels: string[] = []
  if (p.vitalsOk && v.pending) pendingLabels.push('バイタル')
  if (p.intakeOk && lunch.pending) pendingLabels.push('お食事')
  if (act.pending) pendingLabels.push('活動')
  // 機能訓練は紙を「記録なし」のままにし、見本の印と印刷の前の確かめにだけ出す
  if (tr.queued) pendingLabels.push('機能訓練')
  const unreadLabels: string[] = []
  if (!p.vitalsOk) unreadLabels.push('バイタル')
  if (!p.bathsOk) unreadLabels.push('入浴')
  if (!p.intakeOk) unreadLabels.push('お食事・水分')
  if (p.activities === null) unreadLabels.push('活動')
  if (p.training === null) unreadLabels.push('機能訓練')
  if (notesUnread) unreadLabels.push('ひと言')
  return {
    ...base,
    attended: true,
    absentText: null,
    vitals: p.vitalsOk
      ? { kind: 'ok', cells: sheetVitalCells(v.values, unmeasuredFieldsOf(p.unmeasured, p.residentId, p.day)), recheck: v.recheck }
      : { kind: 'unread' },
    items: [
      { label: '入浴', value: sheetBathText(p.bath, p.bathingPlanned, p.bathsOk) },
      { label: 'お食事', value: sheetLunchText(lunch.lunch, p.intakeOk) },
      { label: '水分', value: sheetFluidText(p.fluids, p.residentId, p.day, p.intakeOk) },
      { label: '活動', value: act.text },
      { label: '機能訓練', value: tr.text },
    ],
    staff: { common: notesUnread ? null : normalizeNoteText(p.dayNote), personal },
    notesUnread,
    abnormal,
    nurse: abnormal && !notesUnread ? normalizeNoteText(p.note?.nurse_note ?? null) : null,
    pendingLabels,
    unreadLabels,
    autoBath: p.bathsOk && bathIsAuto(p.bath),
    trainingQueued: tr.queued,
    vitalsStopped: p.vitalsOk && v.stopped,
  }
}

/** 職員よりの欄を紙面に出すか（共通の一文か個別のひと言があるか、ひと言を読めなかった時。空なら見出しごと出さない） */
export function staffSectionShown(sheet: Pick<ContactSheet, 'staff' | 'notesUnread'>): boolean {
  return sheet.notesUnread || sheet.staff.common !== null || sheet.staff.personal !== null
}

/** 看護職よりの欄を紙面に出すか（基準外で、看護職のひと言がある時・ひと言を読めなかった時。空なら見出しごと出さない） */
export function nurseSectionShown(sheet: Pick<ContactSheet, 'abnormal' | 'nurse' | 'notesUnread'>): boolean {
  return sheet.abnormal && (sheet.notesUnread || sheet.nurse !== null)
}

/**
 * 印刷の前に確かめる方: 選んだ方のうち「基準を外れたバイタルがあるのに看護職のひと言が空」の方（並びは渡した順）。
 * ひと言を読めなかった方は入れない（空かどうか分からない。その方は「読めなかった項目がある方」の側にだけ並ぶ＝確認の反証 軽1）
 */
export function nurseNoteMissing(
  sheets: readonly Pick<ContactSheet, 'residentId' | 'abnormal' | 'nurse' | 'notesUnread'>[],
  picked: ReadonlySet<number>,
): number[] {
  return sheets.filter((s) => picked.has(s.residentId) && s.abnormal && s.nurse === null && !s.notesUnread).map((s) => s.residentId)
}

/** 印刷の前に確かめる方: 選んだ方のうち、バイタルの送信待ちが競合・拒否で送れずに止まっている方（その値は紙に載らない） */
export function vitalsStoppedPicked(sheets: readonly Pick<ContactSheet, 'residentId' | 'vitalsStopped'>[], picked: ReadonlySet<number>): number[] {
  return sheets.filter((s) => picked.has(s.residentId) && s.vitalsStopped).map((s) => s.residentId)
}

/** 印刷の前に確かめる方: 選んだ方のうち読めなかった項目がある方（並びは渡した順・項目の名前つき） */
export function unreadPicked(
  sheets: readonly Pick<ContactSheet, 'residentId' | 'unreadLabels'>[],
  picked: ReadonlySet<number>,
): { residentId: number; labels: string[] }[] {
  return sheets.filter((s) => picked.has(s.residentId) && s.unreadLabels.length > 0).map((s) => ({ residentId: s.residentId, labels: s.unreadLabels }))
}

/** 選んだ方のうち、バイタルを読めず基準外かを確かめられない方（来た方だけ。看護職のひと言が要るか分からない） */
export function vitalsUnreadPicked(sheets: readonly Pick<ContactSheet, 'residentId' | 'vitals'>[], picked: ReadonlySet<number>): number[] {
  return sheets.filter((s) => picked.has(s.residentId) && s.vitals !== null && s.vitals.kind === 'unread').map((s) => s.residentId)
}

/** 印刷の前に確かめる方: 選んだ方のうち入浴が自動の記録のままの方（まだ人が確かめていない） */
export function autoBathPicked(sheets: readonly Pick<ContactSheet, 'residentId' | 'autoBath'>[], picked: ReadonlySet<number>): number[] {
  return sheets.filter((s) => picked.has(s.residentId) && s.autoBath).map((s) => s.residentId)
}

/** 印刷の前に確かめる方: 選んだ方のうち送信待ちの機能訓練がある方（送信が済んでから刷ると紙に載る） */
export function trainingQueuedPicked(sheets: readonly Pick<ContactSheet, 'residentId' | 'trainingQueued'>[], picked: ReadonlySet<number>): number[] {
  return sheets.filter((s) => picked.has(s.residentId) && s.trainingQueued).map((s) => s.residentId)
}

/** 印刷する方の既定（来た方＝在席・帰宅） */
export function defaultPicked(rows: readonly { residentId: number; state: AttendanceState }[]): Set<number> {
  return new Set(rows.filter((r) => attendedState(r.state)).map((r) => r.residentId))
}

/** 連絡帳の画面のルート（業務日は ?day= で持つ。今日は付けない） */
export function contactPath(day: string, today: string): string {
  return `/record/daycare/contact${day === today ? '' : `?day=${day}`}`
}
