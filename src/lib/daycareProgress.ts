// デイ（せせらぎ）計画B（2026-11-09）: 今日のカードの状態の4色・進み具合の印・一括の4画面の「未入力 n名」の純ロジック
// （副作用なし・DB/DOM に触れない）。tests/daycare-progress.test.mjs から node で直接読む（拡張子付きで import する）。
//
// ・状態の4色（カードの地と枠）: 来所前・予定外＝点線の枠／在席＝緑／帰宅＝青／休み・入院中＝灰。色だけに頼らず記号と言葉を併記する
// ・進み具合の印: バイタル・昼食・活動・訓練・入浴の5つ。済・未・対象外・要確認・読めない を枠の形と文字でも分ける（押せない表示）
// ・未入力の数: 在席・帰宅の方だけ数える（送信待ち・順番待ち・端末の値は入力済み）。まだ来ていない方は別に数える
// 個人情報は扱わない（数値と記号だけ。氏名は画面が持つ）。

import { fmtPlanTimes } from './daycare.ts'
import type { AttendanceState, DaycareBathStatus, DaycareBoardRow } from './daycare.ts'
import { DAYCARE_ABSENT_REASON_LABEL } from './types.ts'
import type { Meal } from './types.ts'

/** 'H:MM'（読めない・無い時は ''） */
function hm(t: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? '')
  return m === null ? '' : `${Number(m[1])}:${m[2]}`
}

/** 来た（在席か帰宅） */
export function hasCome(state: AttendanceState): boolean {
  return state === 'present' || state === 'left'
}

// ── 状態の4色（今日のカード） ──

export type DaycareStateKind = 'before' | 'planError' | 'unplanned' | 'present' | 'left' | 'absent' | 'hospitalized'

export interface DaycareStateTone {
  kind: DaycareStateKind
  /** 記号（画面では aria-hidden） */
  mark: string
  /** 言葉と時刻（読み上げる） */
  word: string
  /** カードの枠と地（tokens.css のトークンだけ） */
  cardCls: string
}

/** 来所前・予定外（点線の枠）／在席（緑）／帰宅（青）／休み・入院中（灰＝今の休みと同じ） */
export const DAYCARE_CARD_CLS = {
  before: 'border-dashed border-border-strong bg-surface',
  present: 'border-ok bg-ok-bg',
  left: 'border-info bg-info-bg',
  muted: 'border-border bg-surface2',
} as const

/**
 * カードの状態の段（記号＋言葉＋時刻）と、カードの枠と地（2026-11-09 計画B）。
 * 予定の誤り（週間計画の記録が2件・同じ日に予定が2件）は、まだ来ていない方だけこの段で知らせる（来た方・休みの方は状態を出す）。
 * 時刻は1つだけ（来所前＝予定の始まり・在席＝到着・帰宅＝帰宅）。iPad 横の6列のカードの幅（中身 約155px）で1行に収め、5段を見せるため
 * （親の決定 2026-11-09: 「○ 来所前 9:30〜15:30」「✓ 帰宅 9:32〜15:28」は 15px 太字で2行に折れた）
 */
export function daycareStateTone(
  row: Pick<DaycareBoardRow, 'state' | 'attendance' | 'planned' | 'dup' | 'plans' | 'hospitalized'>,
): DaycareStateTone {
  const a = row.attendance
  if (row.state === 'absent') {
    const reason = a?.absent_reason ? DAYCARE_ABSENT_REASON_LABEL[a.absent_reason] : '理由なし'
    return { kind: 'absent', mark: '✕', word: `休み（${reason}）`, cardCls: DAYCARE_CARD_CLS.muted }
  }
  if (row.state === 'left') return { kind: 'left', mark: '✓', word: `帰宅 ${hm(a?.left_at)}`.trimEnd(), cardCls: DAYCARE_CARD_CLS.left }
  if (row.state === 'present') return { kind: 'present', mark: '●', word: `在席 ${hm(a?.arrived_at)}〜`, cardCls: DAYCARE_CARD_CLS.present }
  if (row.hospitalized) return { kind: 'hospitalized', mark: '－', word: '入院中', cardCls: DAYCARE_CARD_CLS.muted }
  if (row.dup) return { kind: 'planError', mark: '▲', word: '予定 要確認（週間計画にこの方の記録が2件あります）', cardCls: DAYCARE_CARD_CLS.before }
  if (row.plans.length > 1) {
    // 同じ方に同じ日の予定が2件＝データの誤り（代表者の回答 A2「そのような日はない」）。定時の処理も到着・帰宅を入れない
    return { kind: 'planError', mark: '▲', word: '予定 要確認（週間計画にこの方の予定が同じ日に2件あります）', cardCls: DAYCARE_CARD_CLS.before }
  }
  if (row.planned) {
    // 予定の始まりの時刻だけ（読めない・時間未定の時は言葉だけ）
    const start = hm(row.plans[0]?.start)
    return { kind: 'before', mark: '○', word: start === '' ? '来所前' : `来所前 ${start}〜`, cardCls: DAYCARE_CARD_CLS.before }
  }
  return { kind: 'unplanned', mark: '○', word: '予定外の来所', cardCls: DAYCARE_CARD_CLS.before }
}

/**
 * 一括の画面の氏名の下の来た・まだ（○ 来所前／● 在席 9:32／✓ 帰宅 15:28）。色は文字だけ（在席＝緑・帰宅＝青・来所前＝灰）で、
 * 記号でも分かる。withPlan＝来所前に予定の時刻を添える（食事一括＝それまでの「未到着（予定 …）」の時刻を残す）
 */
export function daycareCameMark(
  row: Pick<DaycareBoardRow, 'state' | 'attendance' | 'planned' | 'dup' | 'plans'> | undefined,
  withPlan = false,
): { mark: string; word: string; textCls: string } {
  const a = row?.attendance ?? null
  if (row?.state === 'left') return { mark: '✓', word: `帰宅 ${hm(a?.left_at)}`.trimEnd(), textCls: 'text-info' }
  if (row?.state === 'present') return { mark: '●', word: `在席 ${hm(a?.arrived_at)}`.trimEnd(), textCls: 'text-ok' }
  if (withPlan && row !== undefined && row.planned && !row.dup && row.plans.length === 1) {
    return { mark: '○', word: `来所前 ${fmtPlanTimes(row.plans)}`, textCls: 'text-ink2' }
  }
  return { mark: '○', word: '来所前', textCls: 'text-ink2' }
}

// ── 進み具合の印（今日のカードの段4） ──

export type ProgressKey = 'vitals' | 'lunch' | 'activity' | 'training' | 'bath'
export type ProgressState = 'done' | 'todo' | 'na' | 'check' | 'unread'

export interface ProgressMark {
  key: ProgressKey
  /** 札の文字（VS／食／活／訓／浴。画面では aria-hidden） */
  short: string
  /** 読み上げ・title の名前 */
  label: string
  state: ProgressState
}

export const PROGRESS_ITEMS: readonly { key: ProgressKey; short: string; label: string }[] = [
  { key: 'vitals', short: 'VS', label: 'バイタル' },
  { key: 'lunch', short: '食', label: '昼食' },
  { key: 'activity', short: '活', label: '活動' },
  { key: 'training', short: '訓', label: '訓練' },
  { key: 'bath', short: '浴', label: '入浴' },
]

/** 状態の言葉（読み上げ・title） */
export const PROGRESS_STATE_WORD: Record<ProgressState, string> = {
  done: '済',
  todo: '未',
  na: '対象外',
  check: '要確認',
  unread: '読み込めません',
}

/** 札の形（色だけに頼らない: 塗り＝済・点線＝未・枠なし＝対象外・太枠＝要確認・細かい点線＝読めない） */
export const PROGRESS_MARK_CLS: Record<ProgressState, string> = {
  done: 'border border-ok bg-ok-bg font-bold text-ok',
  todo: 'border border-dashed border-ink2 text-ink',
  na: 'border border-transparent text-ink3',
  check: 'border-2 border-warn bg-warn-bg font-bold text-ink',
  unread: 'border border-dotted border-ink2 text-ink2',
}

/** 昼食が入力済みか（拒食か、主食・副食の両方がある＝lunchUnfilledCount と同じ考え） */
export function lunchFilled(meal: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null | undefined): boolean {
  if (meal === null || meal === undefined) return false
  if (meal.status === 'refused') return true
  return meal.main_amount !== null && meal.side_amount !== null
}

export interface ProgressInput {
  state: AttendanceState
  /** 週間計画で入院中（カードの「入院中」は state が planned の時だけ） */
  hospitalized: boolean
  /** バイタルを測った（どれかの値がある）・最新の測定が再測定の目安に当たる */
  vitals: { done: boolean; abnormal: boolean }
  lunch: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null | undefined
  /** その日のその方の活動の記録の数。null＝読めない */
  activityCount: number | null
  /** その日のその方の機能訓練の記録がある（送信待ちの追加を含む）。null＝読めない */
  training: boolean | null
  bath: DaycareBathStatus
}

/**
 * 進み具合の印（2026-11-09 計画B）。来た＝在席か帰宅。
 * ・バイタル: 来ていない → 対象外。再測定の目安に当たる → 要確認。測った → 済。ほか → 未
 * ・昼食: 来ていない → 入力済みなら済・ほかは対象外。来た → 入力済みなら済・ほかは未
 * ・活動・訓練: 読めない → 読めない。来ていない → 記録があれば済・ほかは対象外。来た → 記録があれば済・ほかは未
 * ・入浴: 休みの方に入浴の記録が残っている → 要確認。予定なし → 対象外。記録あり（自動・中止を含む）→ 済。
 *   予定あり・未記録 → 休み・入院中なら対象外、ほかは未
 */
export function daycareProgressMarks(input: ProgressInput): ProgressMark[] {
  const came = hasCome(input.state)
  const recorded = (has: boolean): ProgressState => (has ? 'done' : came ? 'todo' : 'na')
  const vitals: ProgressState = !came ? 'na' : input.vitals.abnormal ? 'check' : input.vitals.done ? 'done' : 'todo'
  const lunch = recorded(lunchFilled(input.lunch))
  const activity: ProgressState = input.activityCount === null ? 'unread' : recorded(input.activityCount > 0)
  const training: ProgressState = input.training === null ? 'unread' : recorded(input.training)
  const b = input.bath
  const absent = input.state === 'absent'
  const bath: ProgressState =
    absent && (b.kind === 'auto' || b.kind === 'done')
      ? 'check'
      : b.kind === 'noPlan'
        ? 'na'
        : b.kind !== 'todo'
          ? 'done'
          : absent || (input.hospitalized && input.state === 'planned')
            ? 'na'
            : 'todo'
  const by: Record<ProgressKey, ProgressState> = { vitals, lunch, activity, training, bath }
  return PROGRESS_ITEMS.map((it) => ({ ...it, state: by[it.key] }))
}

// ── 未入力の数（一括の4画面の上・今日の画面の切り替え） ──

/**
 * 在席・帰宅の方のうち、入力済みでない方の数（unfilled）。在席・帰宅でない方（まだ来ていない方）は数えず、別に数を返す（notArrived）。
 * filled は画面に出している値（送信待ち・順番待ち・端末の値を重ねた値）で決める
 */
export function attendedUnfilledCount(rows: readonly { state: AttendanceState; filled: boolean }[]): { unfilled: number; notArrived: number } {
  let unfilled = 0
  let notArrived = 0
  for (const r of rows) {
    if (!hasCome(r.state)) notArrived += 1
    else if (!r.filled) unfilled += 1
  }
  return { unfilled, notArrived }
}

/** 切り替えの key（DaycareNav の項目）と印の対応 */
export type DaycareNavPendingKey = 'vitals' | 'meals' | 'activity' | 'training'
export type DaycareNavPending = Partial<Record<DaycareNavPendingKey, number>>

const NAV_OF: readonly [DaycareNavPendingKey, ProgressKey][] = [
  ['vitals', 'vitals'],
  ['meals', 'lunch'],
  ['activity', 'activity'],
  ['training', 'training'],
]

/**
 * 今日の画面の切り替えに添える未入力の数: 来た方で印が「未」の数（一括の画面と同じ数え方・読めない印は数えない）。0 の項目は入れない
 */
export function daycareNavPending(rows: readonly { state: AttendanceState; marks: readonly ProgressMark[] }[]): DaycareNavPending {
  const out: DaycareNavPending = {}
  for (const [nav, key] of NAV_OF) {
    const n = rows.filter((r) => hasCome(r.state) && r.marks.some((m) => m.key === key && m.state === 'todo')).length
    if (n > 0) out[nav] = n
  }
  return out
}

/** 切り替えに出す数（1以上の整数の時だけ。0・無い・壊れた値は null＝出さない） */
export function navPendingOf(pending: DaycareNavPending | undefined, key: string): number | null {
  const n = pending?.[key as DaycareNavPendingKey]
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

// ── 各画面の「入力済み」 ──

/** バイタル一括: どれかの回のどれかの欄に値がある（画面に出している値＝サーバー・送信待ち・端末の値） */
export function vitalSlotsFilled(slots: readonly (readonly (number | null | undefined)[])[]): boolean {
  return slots.some((vals) => vals.some((v) => typeof v === 'number'))
}

/** 活動一括: 活動の枠のどれかに記録がある（画面に出している値。取り消しの送信待ちの枠は数えない） */
export function activityCellsFilled(cells: readonly { shown: unknown; deleting: boolean }[]): boolean {
  return cells.some((c) => c.shown !== null && c.shown !== undefined && !c.deleting)
}

/** 機能訓練: その方のその日の記録がある（読めた記録・この端末の送信待ちの追加＝止まっている分も含む） */
export function trainingFilled(
  sessions: readonly { resident_id: number; day: string }[],
  pending: readonly { kind: string; table: string; residentId?: number; day?: string }[],
  residentId: number,
  day: string,
): boolean {
  return (
    sessions.some((s) => s.resident_id === residentId && s.day === day) ||
    pending.some((p) => p.kind === 'add' && p.table === 'daycare_training_sessions' && p.residentId === residentId && p.day === day)
  )
}
