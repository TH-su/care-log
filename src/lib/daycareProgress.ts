// デイ（せせらぎ）計画B（2026-11-09）: 今日のカードの状態の4色・進み具合の印・一括の4画面の「未入力 n名」の純ロジック
// （副作用なし・DB/DOM に触れない）。tests/daycare-progress.test.mjs から node で直接読む（拡張子付きで import する）。
//
// ・状態の4色（カードの地と枠）: 来所前・予定外＝点線の枠／在席＝緑／帰宅＝青／休み・入院中＝灰。色だけに頼らず記号と言葉を併記する
// ・進み具合の印: バイタル・昼食・活動・訓練・入浴の5つ。済・未・対象外・要確認・読めない を枠の形と文字でも分ける（押せない表示）
// ・未入力の数: 在席・帰宅の方だけ数える（送信待ち・順番待ち・端末の値は入力済み）。まだ来ていない方は別に数える
//   （2026-11-09 計画B2: 一括の4画面と切り替えの数は、到着を問わず空の欄を数える形 bulkBlankSummary に移した）
// ・空の欄（計画B2）: 一括の4画面の空の枠の見た目・1人の空の欄の数・合計（n名・m欄）・切り替えの数
// 個人情報は扱わない（数値と記号だけ。氏名は画面が持つ）。

import { DAYCARE_VITAL_FIELDS, daycareVitalKey, daycareVitalSlots, fmtPlanTimes, nextDaycareSeq } from './daycare.ts'
import type { AttendanceState, DaycareBathStatus, DaycareBoardRow, DaycareVitalField, DaycareVitalSlot, KeyedVital } from './daycare.ts'
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
  /**
   * 予定の誤り（▲ 予定 要確認（…））を状態の段の下に1行足す時の文（来た方・休みの方・入院中の方）。まだ来ていない方は状態の段そのものが
   * この文になるので null（反証 中3・2026-11-09: どの状態でも出す）
   */
  planWarn: string | null
}

/** 予定の誤りの文（週間計画の記録が2件・同じ日に予定が2件）。誤りが無ければ null */
export function daycarePlanWarning(row: Pick<DaycareBoardRow, 'dup' | 'plans'>): string | null {
  if (row.dup) return '予定 要確認（週間計画にこの方の記録が2件あります）'
  // 同じ方に同じ日の予定が2件＝データの誤り（代表者の回答 A2「そのような日はない」）。定時の処理も到着・帰宅を入れない
  if (row.plans.length > 1) return '予定 要確認（週間計画にこの方の予定が同じ日に2件あります）'
  return null
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
 * 予定の誤り（週間計画の記録が2件・同じ日に予定が2件）は、どの状態でも知らせる: まだ来ていない方はこの段で（▲ 予定 要確認（…））、
 * 来た方・休みの方・入院中の方は状態を出して、下に1行（planWarn）足す（反証 中3）。
 * 時刻は1つだけ（来所前＝予定の始まり・在席＝到着・帰宅＝帰宅）。iPad 横の6列のカードの幅（中身 約155px）で1行に収め、5段を見せるため
 * （親の決定 2026-11-09: 「○ 来所前 9:30〜15:30」「✓ 帰宅 9:32〜15:28」は 15px 太字で2行に折れた）
 */
export function daycareStateTone(
  row: Pick<DaycareBoardRow, 'state' | 'attendance' | 'planned' | 'dup' | 'plans' | 'hospitalized'>,
): DaycareStateTone {
  const a = row.attendance
  const warn = daycarePlanWarning(row)
  if (row.state === 'absent') {
    const reason = a?.absent_reason ? DAYCARE_ABSENT_REASON_LABEL[a.absent_reason] : '理由なし'
    return { kind: 'absent', mark: '✕', word: `休み（${reason}）`, cardCls: DAYCARE_CARD_CLS.muted, planWarn: warn }
  }
  if (row.state === 'left') return { kind: 'left', mark: '✓', word: `帰宅 ${hm(a?.left_at)}`.trimEnd(), cardCls: DAYCARE_CARD_CLS.left, planWarn: warn }
  if (row.state === 'present') return { kind: 'present', mark: '●', word: `在席 ${hm(a?.arrived_at)}〜`, cardCls: DAYCARE_CARD_CLS.present, planWarn: warn }
  if (row.hospitalized) return { kind: 'hospitalized', mark: '－', word: '入院中', cardCls: DAYCARE_CARD_CLS.muted, planWarn: warn }
  if (warn !== null) return { kind: 'planError', mark: '▲', word: warn, cardCls: DAYCARE_CARD_CLS.before, planWarn: null }
  if (row.planned) {
    // 予定の始まりの時刻だけ（読めない・時間未定の時は言葉だけ）
    const start = hm(row.plans[0]?.start)
    return { kind: 'before', mark: '○', word: start === '' ? '来所前' : `来所前 ${start}〜`, cardCls: DAYCARE_CARD_CLS.before, planWarn: null }
  }
  return { kind: 'unplanned', mark: '○', word: '予定外の来所', cardCls: DAYCARE_CARD_CLS.before, planWarn: null }
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

/**
 * 札の形（色だけに頼らない: 実線＝済・点線＝未・枠なし＝対象外・太枠＝要確認・細い点線＝読めない）。札の文字はどの状態も同じ
 * （VS・食・活・訓・浴）。読めない項目は、一覧の上の1行の知らせ（unreadProgressNotice）で名前を出す（親の決定 2026-11-09）。
 * 済の地は bg-surface（在席のカードの地 bg-ok-bg と同じ色にしない＝反証 軽3。text-ok と bg-surface は明 7.2・暗 8.8）
 */
export const PROGRESS_MARK_CLS: Record<ProgressState, string> = {
  done: 'border border-ok bg-surface font-bold text-ok',
  todo: 'border border-dashed border-ink2 text-ink',
  na: 'border border-transparent text-ink3',
  check: 'border-2 border-warn bg-warn-bg font-bold text-ink',
  unread: 'border border-dotted border-ink2 text-ink2',
}

/**
 * その日に読めなかった項目の名前（印の並び＝バイタル・昼食・活動・機能訓練・入浴の順）。読めない項目が無ければ空
 */
export function unreadProgressLabels(r: { vitalsOk: boolean; intakeOk: boolean; activitiesOk: boolean; trainingOk: boolean; bathsOk: boolean }): string[] {
  const out: string[] = []
  if (!r.vitalsOk) out.push('バイタル')
  if (!r.intakeOk) out.push('昼食')
  if (!r.activitiesOk) out.push('活動')
  if (!r.trainingOk) out.push('機能訓練')
  if (!r.bathsOk) out.push('入浴')
  return out
}

/** 一覧の上の1行の知らせ（何が起きたか＋次にどうするか）。読めない項目が無ければ null（出さない） */
export function unreadProgressNotice(labels: readonly string[]): string | null {
  if (labels.length === 0) return null
  return `${labels.join('・')}の記録を読み込めませんでした（印は細い点線）。通信状態を確認して、〔最新に更新〕を押してください。`
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
  /** バイタルを測った（どれかの値がある）・最新の測定が再測定の目安に当たる。null＝読めない */
  vitals: { done: boolean; abnormal: boolean } | null
  /** 昼食（画面に出している値＝送信待ちを重ねた値）。lunchRead=false＝読めない */
  lunch: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null | undefined
  lunchRead: boolean
  /** その日のその方の活動の記録がある（送信待ちを重ねた値）。null＝読めない */
  activity: boolean | null
  /** その日のその方の機能訓練の記録がある（送信待ちの追加を含む）。null＝読めない */
  training: boolean | null
  /** 入浴の状態。null＝読めない */
  bath: DaycareBathStatus | null
}

/**
 * 進み具合の印（2026-11-09 計画B）。来た＝在席か帰宅。読めない項目はどれも「読めない」（「未」に見せない＝反証 中6）。
 * ・バイタル: 再測定の目安に当たる → 要確認。測った → 済（来ていない方でも値があれば＝反証 中4）。値が無い → 来た方は未・ほかは対象外
 * ・昼食: 来ていない → 入力済みなら済・ほかは対象外。来た → 入力済みなら済・ほかは未
 * ・活動・訓練: 来ていない → 記録があれば済・ほかは対象外。来た → 記録があれば済・ほかは未
 * ・入浴: 休みの方に入浴の記録が残っている → 要確認。予定なし → 対象外。記録あり（自動・中止を含む）→ 済。
 *   予定あり・未記録 → 休み・入院中なら対象外、ほかは未
 */
export function daycareProgressMarks(input: ProgressInput): ProgressMark[] {
  const came = hasCome(input.state)
  const recorded = (has: boolean): ProgressState => (has ? 'done' : came ? 'todo' : 'na')
  const v = input.vitals
  const vitals: ProgressState = v === null ? 'unread' : v.abnormal ? 'check' : recorded(v.done)
  const lunch: ProgressState = !input.lunchRead ? 'unread' : recorded(lunchFilled(input.lunch))
  const activity: ProgressState = input.activity === null ? 'unread' : recorded(input.activity)
  const training: ProgressState = input.training === null ? 'unread' : recorded(input.training)
  const b = input.bath
  const absent = input.state === 'absent'
  const bath: ProgressState =
    b === null
      ? 'unread'
      : absent && (b.kind === 'auto' || b.kind === 'done')
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
 * filled は画面に出している値（送信待ち・順番待ち・端末の値を重ねた値）で決める。
 * 2026-11-09 計画B2: 一括の4画面の上の数と切り替えの数は、到着を問わず空の欄を数える bulkBlankSummary に移した（これは消さずに残す）
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

// ── 空の欄（2026-11-09 計画B2・代表者の指示「記載していない枠が目立つように」「全枠が埋まるまでは何かしらのアラートが出るように」） ──

/**
 * 記入していない枠の見た目（一括の4画面で共通）: 注意の地＋太い点線の枠。色だけに頼らず、枠の形（点線）と「未」の字
 * （DaycareBlankTag）でも分かる。入った枠は各画面の今の見た目（白い地 bg-surface など）に戻る。
 * 枠の線・地は排他で選ぶ（ほかの border・bg のクラスと重ねない＝重ねるとどちらが効くかは CSS の順で決まるため）
 */
export const DAYCARE_BLANK_CELL_CLS = 'border-2 border-dashed border-warn bg-warn-bg'

/**
 * バイタル一括の1人の空の欄の数: その方の最初の回の5欄（血圧の上・下・脈・SpO2・体温）のうち値の無い欄。再測定の回は数えない。
 * 値は画面に出している値（端末の値・送信待ち・サーバーの値）。回が無い時（null）は5欄とも空
 */
export function vitalBlankFields(first: Partial<Record<DaycareVitalField, number | null | undefined>> | null | undefined): number {
  return DAYCARE_VITAL_FIELDS.filter((f) => typeof first?.[f] !== 'number').length
}

/** 食事一括の1人の空の欄の数（主食・副食の2欄）: 拒食はどちらも入力済み（0）。lunchFilled と同じ考え（0 の時だけ入力済み） */
export function lunchBlankFields(meal: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null | undefined): number {
  if (meal === null || meal === undefined) return 2
  if (meal.status === 'refused') return 0
  return (meal.main_amount === null ? 1 : 0) + (meal.side_amount === null ? 1 : 0)
}

/** 活動一括・機能訓練の1人の空の欄の数（1人1欄）: 記録があれば 0・無ければ 1 */
export function recordBlankFields(filled: boolean): number {
  return filled ? 0 : 1
}

/** 一括の画面の上の数（people＝空の欄がある方の数・fields＝空の欄の合計） */
export interface BlankSummary {
  people: number
  fields: number
}

/**
 * 一括の画面の上の「▲ 未入力 n名（m欄）」（2026-11-09 計画B2）。数える相手は画面に出ている予定の方（daycareBulkRows＝休み・入院中を除く・
 * 予定外で来た方を含む）で、到着の有無を問わない（仮置き）。blanks は1人ずつの空の欄の数（vitalBlankFields・lunchBlankFields・recordBlankFields）
 */
export function bulkBlankSummary(blanks: readonly number[]): BlankSummary {
  let people = 0
  let fields = 0
  for (const b of blanks) {
    if (!Number.isInteger(b) || b <= 0) continue
    people += 1
    fields += b
  }
  return { people, fields }
}

/**
 * 切り替えの key（DaycareNav の項目）。2026-11-09 計画B3: バイタル一括と食事一括を1つの画面（バイタル・食事＝vitalsMeals）にした
 */
export type DaycareNavPendingKey = 'vitalsMeals' | 'activity' | 'training'
export type DaycareNavPending = Partial<Record<DaycareNavPendingKey, number>>

const NAV_KEYS: readonly DaycareNavPendingKey[] = ['vitalsMeals', 'activity', 'training']

/**
 * バイタル・食事の画面の1人の空の欄の数（2026-11-09 計画B3: 1人7欄＝バイタルの最初の回の5欄＋昼食の主食・副食）。
 * 画面の上の「未入力 n名（m欄）」と今日の画面の切り替えの数で同じ数え方にする。どちらかを読めない時（null）は数えない（null を返す）
 */
export function vitalsMealsBlankFields(vitalBlank: number | null, lunchBlank: number | null): number | null {
  if (vitalBlank === null || lunchBlank === null) return null
  return vitalBlank + lunchBlank
}

/**
 * 今日の画面の切り替えに添える未入力の数（2026-11-09 計画B2: 一括の画面の n と同じ数え方＝bulkBlankSummary の people）。
 * 項目ごとに、一括の画面に出る方（daycareBulkRows）の1人ずつの空の欄の数を渡す。null＝その日の記録を読めない（数を出さない）。0 の項目は入れない
 */
export function daycareNavPending(blanks: Readonly<Record<DaycareNavPendingKey, readonly number[] | null>>): DaycareNavPending {
  const out: DaycareNavPending = {}
  for (const key of NAV_KEYS) {
    const b = blanks[key]
    if (b === null || b === undefined) continue
    const n = bulkBlankSummary(b).people
    if (n > 0) out[key] = n
  }
  return out
}

/** 切り替えに出す数（1以上の整数の時だけ。0・無い・壊れた値は null＝出さない） */
export function navPendingOf(pending: DaycareNavPending | undefined, key: string): number | null {
  const n = pending?.[key as DaycareNavPendingKey]
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

// ── 2026-11-09 計画B3: 一括の表の行の地（1人ずつ交互）・分類の色・状態の列の印 ──

/**
 * 一括の表の行の地（代表者の指示「１名ずつ行のバックの色を少し変えて変化を持たせて」）。index は表の中の何人目か（0 始まり。
 * その方の再測定の行・知らせの行にも同じ index を渡す）。行（tr）と氏名の列（sticky の th）の両方にこの地を付けて色をそろえる
 * （氏名の列は下を流れる欄を透かさないよう、どちらの方も地を塗る）。1人おきの地は寒色の灰（--c-row-alt）で、空の枠の注意の地
 * （warn-bg・琥珀）とは色味で分ける
 */
export function daycareRowTone(index: number): 'bg-bg' | 'bg-row-alt' {
  return Number.isInteger(index) && index % 2 === 1 ? 'bg-row-alt' : 'bg-bg'
}

/** 分類（tokens.css の --c-cat-*）: バイタル＝ティール・食事＝イエロー・活動＝コーラル・機能訓練＝ローズ */
export type DaycareCategory = 'vitals' | 'meals' | 'activity' | 'training'

/**
 * 分類の色のクラス。band＝一括の表の見出しの帯（淡い色面＋下の細い線。帯の上の文字は text-ink）・line＝細い線だけ（カードの進み具合の札）・
 * dot＝今日の画面の切り替えの印（縦の短い棒）。状態の4色・危険・注意の代わりには使わない（意味は文字と記号で伝える）
 */
export const DAYCARE_CATEGORY_CLS: Record<DaycareCategory, { band: string; line: string; dot: string }> = {
  vitals: { band: 'bg-cat-vitals-bg dc-cat-line-vitals', line: 'dc-cat-line-vitals', dot: 'bg-cat-vitals' },
  meals: { band: 'bg-cat-meals-bg dc-cat-line-meals', line: 'dc-cat-line-meals', dot: 'bg-cat-meals' },
  activity: { band: 'bg-cat-activity-bg dc-cat-line-activity', line: 'dc-cat-line-activity', dot: 'bg-cat-activity' },
  training: { band: 'bg-cat-training-bg dc-cat-line-training', line: 'dc-cat-line-training', dot: 'bg-cat-training' },
}

/** 進み具合の札の分類（入浴は4つの分類に入らないので色を付けない） */
export const PROGRESS_CATEGORY: Record<ProgressKey, DaycareCategory | null> = {
  vitals: 'vitals',
  lunch: 'meals',
  activity: 'activity',
  training: 'training',
  bath: null,
}

/** 進み具合の札の下に付ける分類の色の細い線のクラス（分類の無い入浴は ''） */
export function progressCategoryLine(key: ProgressKey): string {
  const c = PROGRESS_CATEGORY[key]
  return c === null ? '' : DAYCARE_CATEGORY_CLS[c].line
}

/** 保存の印の急ぎの順（dcVitalSlotMark・mealBandMark と同じ順: 要確認 → 送信中 → 未送信 → 保存済み） */
const SAVE_MARK_RANK: Record<string, number> = { 要確認: 4, 送信中: 3, 未送信: 2, 保存済み: 1 }

/**
 * バイタル・食事の画面の「状態」の列の印（2026-11-09 計画B3）: バイタルの回の印（dcVitalSlotMark）と昼食の印（mealBandMark）のうち、
 * 手当ての要る方を1つ出す（同じ急ぎなら先に渡した方）。詳しい文は行の下に出す（バイタル＝その回の知らせ・昼食＝「昼食:」で始まる知らせ）。
 * どれも無ければ null
 */
export function mergeSaveMarks<T extends { text: string }>(...marks: readonly (T | null | undefined)[]): T | null {
  let best: T | null = null
  for (const m of marks) {
    if (m === null || m === undefined) continue
    if (best === null || (SAVE_MARK_RANK[m.text] ?? 0) > (SAVE_MARK_RANK[best.text] ?? 0)) best = m
  }
  return best
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

// ── 送信待ちの重ね（今日の画面と一括の画面で同じ決まり＝反証 中1・2026-11-09） ──

/**
 * 昼食の画面に出す値（食事一括の mealShownFor と同じ決まり）: 送信待ち（まだ送っていない・送っている途中＝state 'pending'）の値と、
 * 画面の順番待ち（後に押した方が先）だけ重ねる。止まった値（食い違い）・拒まれた値は重ねず、サーバーの値を出す
 */
export function lunchShownWith(
  cur: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null,
  pending: { state: string; values: Record<string, unknown> } | null,
  wait: readonly { values: Record<string, unknown> }[] = [],
): Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null {
  const p = pending !== null && pending.state === 'pending' ? pending : null
  if (p === null && wait.length === 0) return cur
  const pick = (f: 'main_amount' | 'side_amount' | 'status'): unknown => {
    // 順番待ちの値（後に押した方）→ 送信待ちの値 → サーバーの値
    for (let i = wait.length - 1; i >= 0; i--) if (f in wait[i].values) return wait[i].values[f]
    if (p !== null && f in p.values) return p.values[f]
    return cur?.[f] ?? null
  }
  return {
    main_amount: pick('main_amount') as Meal['main_amount'],
    side_amount: pick('side_amount') as Meal['side_amount'],
    status: pick('status') as Meal['status'],
  }
}

/**
 * 1人のその日の測定の回（バイタル一括の slotsOf と同じ決まり）: サーバーの行＋足した再測定（extra）＋送信待ちにだけある回。
 * hasPending(key)＝その回のキーに送信待ちがあるか（db.ts の pendingRow を画面が渡す）
 */
export function daycareVitalSlotsWithPending(
  live: readonly KeyedVital[],
  keys: readonly string[],
  residentId: number,
  day: string,
  extra: readonly number[],
  hasPending: (key: string) => boolean,
): DaycareVitalSlot[] {
  const top = nextDaycareSeq([...keys, ...extra.map((x) => daycareVitalKey(day, residentId, x))], day, residentId) + 3
  const queued: number[] = []
  for (let seq = 1; seq <= top; seq += 1) {
    const key = daycareVitalKey(day, residentId, seq)
    if (keys.includes(key)) continue
    if (hasPending(key)) queued.push(seq)
  }
  return daycareVitalSlots(live, keys, residentId, day, [...extra, ...queued])
}

/**
 * 測定の欄に出す値の、送信待ち → サーバーの値の部分（バイタル一括の valueOf と同じ決まり。送っていない値＝端末の下書きは画面が先に見る）。
 * 送信待ちの値は状態（送信待ち・食い違い・拒まれた）によらず重ねる（バイタル一括と同じ）
 */
export function vitalShownValue(
  pending: { values: Record<string, unknown> } | null,
  vital: Partial<Record<DaycareVitalField, unknown>> | null,
  f: DaycareVitalField,
): { v: number | null; local: boolean } {
  if (pending !== null && f in pending.values) {
    const pv = pending.values[f]
    return { v: typeof pv === 'number' ? pv : null, local: true }
  }
  const sv = vital?.[f]
  return { v: typeof sv === 'number' ? sv : null, local: false }
}

/** 回の5つの欄の値（vitalShownValue を5欄に） */
export function vitalShownValues(
  pending: { values: Record<string, unknown> } | null,
  vital: Partial<Record<DaycareVitalField, unknown>> | null,
): Record<DaycareVitalField, number | null> {
  const out = {} as Record<DaycareVitalField, number | null>
  for (const f of DAYCARE_VITAL_FIELDS) out[f] = vitalShownValue(pending, vital, f).v
  return out
}

/** 活動の送信待ち（db.ts の PendingActivityOp と同じ形） */
export type ActivityPendingLike =
  | { kind: 'add'; residentId: number; day: string; label: string; participation: string; stopped: boolean }
  | { kind: 'update'; rowId: number; participation: string | null; deleted: boolean; stopped: boolean }

/**
 * 1人のその日の活動の枠ごとの、画面に出す度合い（活動一括の cellOf と同じ決まり）:
 * ・サーバーの行: 止まっていない度合いの変更を重ねる。止まっていない取り消しは「取り消しの送信待ち」（deleting）。取り消しの後に
 *   入れ直した送信待ちの追加があれば、その度合い。止まった変更・取り消しは重ねない（サーバーの値）
 * ・サーバーに無い項目: 送信待ちの追加（止まっていない方 → 止まった方）の度合い
 */
export function activityShownCells(
  rows: readonly { id: number; resident_id: number; day: string; label: string; participation: string }[],
  pending: readonly ActivityPendingLike[],
  residentId: number,
  day: string,
): { label: string; shown: string | null; deleting: boolean }[] {
  const byLabel = new Map<string, { id: number; participation: string }>()
  for (const a of rows) if (a.resident_id === residentId && a.day === day) byLabel.set(a.label, a)
  const upd = new Map<number, { participation: string | null; deleted: boolean }>()
  const adds: { label: string; participation: string; stopped: boolean }[] = []
  for (const p of pending) {
    if (p.kind === 'update') {
      if (!p.stopped) upd.set(p.rowId, p)
    } else if (p.residentId === residentId && p.day === day) adds.push(p)
  }
  const labels = [...byLabel.keys()]
  for (const p of adds) if (!labels.includes(p.label)) labels.push(p.label)
  return labels.map((label) => {
    const a = byLabel.get(label) ?? null
    const liveAdd = adds.find((p) => p.label === label && !p.stopped)
    const stoppedAdd = adds.find((p) => p.label === label && p.stopped)
    if (a !== null) {
      const p = upd.get(a.id)
      const deleting = p?.deleted === true
      if (deleting && liveAdd !== undefined) return { label, shown: liveAdd.participation, deleting: false }
      return { label, shown: p?.participation ?? a.participation, deleting }
    }
    if (liveAdd !== undefined) return { label, shown: liveAdd.participation, deleting: false }
    if (stoppedAdd !== undefined) return { label, shown: stoppedAdd.participation, deleting: false }
    return { label, shown: null, deleting: false }
  })
}
