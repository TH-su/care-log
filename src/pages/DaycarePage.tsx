// デイ（せせらぎ）の「今日」（記録ハブ →「デイ（せせらぎ）」／ルート /record/daycare）。2026-10-22 デイ段階1・代表承認。
//
// 一覧＝その日の予定（週間計画の写し・RPC daycare_plan。開所の後はその日の写し daycare_days）＋記録のある人＋予定外に足した人。
// 各行: 氏名・予定の時間・状態（予定○／在席●時刻／帰宅✓時刻／欠席✕理由）・次の操作（到着を記録／帰宅を記録）・欠席・
//       進み具合（バイタル・入浴）。到着の1タップで在席（代表者の回答 5.2 の8）。1タップの操作はトーストの「元に戻す」（8秒）。
// 2026-11-09 計画B: カードは 氏名と〔休み〕／ふりがな／状態の段（記号＋言葉＋時刻）／進み具合の印（VS・食・活・訓・浴）の4段。
//       カードの地と枠は状態の4色（daycareProgress.ts の daycareStateTone）。上の切り替えに未入力の数を添える（今日の画面だけ）
// 欠席: 理由（体調不良・受診入院・本人の希望・ご家族の都合・その他）を選んだ時点で記録する。在席・帰宅の人は
//       「到着の記録を取り消して欠席にします」と確かめる。欠席を記録したら、その日の入浴を「中止・欠席」にする
//       （db.ts の recordAbsentBath: 読む → あれば更新（自動の行は手入力へ）→ 無ければ追加 → 23505 なら読み直して更新）。
//       人が記録した「入浴した」がある時は確認を挟む。欠席の取り消しは確認つき・入浴の行は消さずに案内する。
// 予定の3値: 読めない（unknown）は上の帯「予定を確かめられません」＝空の一覧を「利用者なし」と見せない／
//            予定なし（none）は「本日のデイの予定はありません」／名簿に無い方（外部利用者など）は「名簿に無い方 n 名」とだけ出す。
// 開所の最初のタップ（今日だけ）で、その日の予定の写しを作る（openDaycareDay）。開くだけでは書かない。
//
// 規律:
// - 取得・保存は db.ts の関数のみ（supabase を直呼びしない）
// - 入力解禁は input_enabled_daycare（getKindInputGate('daycare')）。封鎖中は隠さずにディセーブル＋理由文。
//   入浴の行は input_enabled_bath にも従う（入浴が封鎖なら欠席だけを記録し、理由を出す）
// - 修正は rev 照合。他の端末が先に書いていたら（conflict）読み直して知らせる。通信できない時は送信待ち（'queued'）
// - 日付は画面の中だけで持つ（業務データに紐づく状態は保存しない＝原則11の既定）。現在地は URL で復元
// - 氏名・記録を localStorage・console に出さない。色だけで意味を伝えない（記号・文字を併記）。押す所は 44px 以上・主操作は 56px

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  DbError,
  FORBIDDEN_REASON,
  OUTDATED_REASON,
  cachedMyRole,
  fetchDaycareActivities,
  fetchBathDay,
  fetchDaycareAttendance,
  fetchDaycareDay,
  fetchDaycareIntake,
  fetchDaycarePlan,
  fetchDaycareVitalUnmeasured,
  fetchDaycareVitalsLive,
  fetchMyRole,
  fetchResidentTargets,
  fetchTrainingSessions,
  getAppSetting,
  getKindInputGate,
  hasPendingDaycareAttendance,
  isSelfWrite,
  kindBlockedMessage,
  openDaycareDay,
  pendingActivityOps,
  pendingRow,
  pendingTrainingOps,
  queuePending,
  queueSubscribe,
  subscribeBathChanges,
  subscribeChanges,
  subscribeDaycareActivityChanges,
  subscribeDaycareChanges,
  subscribeMyRole,
} from '../lib/db'
import type { DaycareMealRow, MyRole, VitalTarget } from '../lib/db'
// 名簿は読み込みの控えを通し、在籍者は全員の名簿から切り出す（同じ取得に相乗り＝residents 表を1回だけ読む・2026-10-29）
import { fetchAllResidents, fetchResidentsFromAll } from '../lib/cachedReads'
import { personPath } from '../lib/daycarePerson'
import { contactPath } from '../lib/daycareContact'
import { DAYCARE_VITALS_MEALS_PATH } from '../lib/daycareRoutes'
import type { DaycareActivity } from '../lib/daycareActivity'
import { loadDaycareDayParts } from '../lib/daycareDayLoad'
import type { DaycareDayReaders } from '../lib/daycareDayLoad'
import { RecorderBar } from '../components/RecorderBar'
import { ErrorBlock, LoadingBlock, ResidentPickerModal, useToast } from '../components/ui'
import { hasTimes, useDaycareAttendanceOps } from '../components/DaycareAttendanceOps'
import { HAIBEN_DAYCARE_HREF, writeDaycareHandoffFor } from '../lib/daycareHandoff'
import {
  daycareDayMemo,
  memoBathsOk,
  memoForDay,
  memoVitalsOk,
  memoWithAttendance,
  memoWithBath,
  memoWithoutAttendance,
  rememberDaycareDay,
  updateDaycareDayMemo,
} from '../lib/daycareDayMemo'
import {
  DAYCARE_VITAL_FIELDS,
  bathCountsUnchecked,
  buildDaycareBoard,
  canChangeDaycareTimes,
  canEditPastDaycareTimes,
  daycareBathStatus,
  daycareBulkRows,
  daycareVitalKey,
  nowHm,
  vitalNeedsRecheck,
} from '../lib/daycare'
import type { KeyedVital } from '../lib/daycare'
import {
  DAYCARE_CATEGORY_CLS,
  PROGRESS_MARK_CLS,
  PROGRESS_STATE_WORD,
  activityCellsFilled,
  activityShownCells,
  daycareCountSeq,
  daycareNavPending,
  daycareProgressMarks,
  daycareStateTone,
  daycareVitalSlotsWithPending,
  lunchBlankFields,
  lunchShownWith,
  navPendingOf,
  progressCategoryLine,
  recordBlankFields,
  unreadProgressLabels,
  unreadProgressNotice,
  trainingFilled,
  unmeasuredFieldsOf,
  unmeasuredSeqsOf,
  unmeasuredSlotSeqs,
  vitalBlankFields,
  vitalShownValues,
  vitalSlotsFilled,
  vitalsMealsBlankFields,
  vitalsTileDone,
} from '../lib/daycareProgress'
import type { DaycareCategory, DaycareNavPending, DaycareVitalUnmeasured, ProgressMark } from '../lib/daycareProgress'
import type { DaycareTrainingSession } from '../lib/daycareTraining'
import { useVitalLimits } from '../hooks/useVitalLimits'
import { VitalLimitsFailedNote } from '../components/VitalLimitsFailedNote'
import { addDays, fmtDayLabel, todayIso } from '../lib/format'
import type {
  BathRecord,
  FluidIntake,
  DaycareAttendance,
  DaycareDay,
  DaycarePlanRow,
  DaycarePlanSource,
  Resident,
  Staff,
} from '../lib/types'
import type { ResidentTargets } from '../lib/vitalAlerts'

// ── 文言（何が起きたか＋次にどうするか） ──
const ERR_LOAD = 'デイの記録を読み込めませんでした。通信状態を確認して、再試行してください。'
const MSG_GATE_UNKNOWN =
  'デイの記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。記録の閲覧はこのままできます。'

/** 1日の画面のデータ（読み込みの単位） */
interface DayData {
  day: string
  /** 予定（写しがあれば写し・無ければいまの週間計画） */
  planRows: DaycarePlanRow[]
  planSource: DaycarePlanSource
  /** その日の写し（無ければ null）。過去の日で写しが無い時は「いまの週間計画で出しています」 */
  snapshot: DaycareDay | null
  /** サーバー側の設定待ち（0041 未適用） */
  missing: boolean
  attendance: DaycareAttendance[]
  baths: BathRecord[]
  vitals: KeyedVital[]
  /**
   * 入浴・バイタルを読めたか（2026-11-09 反証 中6: 読めない時の空の一覧で印を「未」に見せない＝「読めない」の印）。
   * 控えで開いた時は、控えに残した「読めたか」を使う（daycareDayMemo の bathsOk・vitalsOk＝確認の反証 中1）
   */
  bathsOk: boolean
  vitalsOk: boolean
  /** 昼食・おやつ（取り込みの印つき）と水分（段階2a・行の小さな印と1人の記録への入口に使う） */
  meals: DaycareMealRow[]
  fluids: FluidIntake[]
  /** 活動・レク（段階2b・行の小さな印）。null＝読めない（0044 未適用・通信エラー）＝「記録なし」に見せない（2026-11-09 計画B から「読めない」の印） */
  activities: DaycareActivity[] | null
  /**
   * その日の機能訓練の記録（2026-11-09 計画B・カードの「訓」の印と切り替えの未入力の数）。null＝読めない（表が無い・通信エラー）＝
   * 印を「読めない」にするだけで、画面の他の部分は止めない
   */
  training: DaycareTrainingSession[] | null
  /**
   * その日の〔未測定〕の印（2026-11-10・0062。切り替えの未入力の数で、印のある欄を入力済みにする）。null＝読めない（表が無い・通信エラー・
   * 控えで開いた）＝印なしで数える（未入力を多めに出す側）。件数の帯「バイタル未」とカードの VS の印も、5欄が値か印で埋まった方を済にする（2026-11-10 確認の反証 軽5）
   */
  unmeasured: DaycareVitalUnmeasured[] | null
  /** 昼食・おやつ・水分を読めたか（読めない時の空の一覧を控えに「読めた」として入れない＝確認の反証 中1） */
  intakeOk: boolean
  /** サーバーに届かず、控え（daycareDayMemo）で開いた時の控えの「読んだ時点」。サーバーから読めた時は null（親の確かめ 中1・2026-10-25） */
  memoAt: number | null
  /** この一覧をサーバーから読めた時刻（控えに入れる「読んだ時点」＝親の反証 軽4） */
  readAt: number
}

/** 1日の読み込みに使う読み取り（db.ts の関数。バイタルは生きている行だけ＝次の回のキーはこの画面では使わない） */
const DAY_READERS: DaycareDayReaders = {
  day: fetchDaycareDay,
  plan: fetchDaycarePlan,
  attendance: fetchDaycareAttendance,
  baths: fetchBathDay,
  vitals: fetchDaycareVitalsLive,
  intake: fetchDaycareIntake,
  activities: fetchDaycareActivities,
  isServerMissing: (e) => e instanceof DbError && e.kind === 'server',
}

/** カードの〔取消〕（押せる範囲 44px・角は 6px） */
const DANGER_CELL_BTN =
  'inline-flex min-h-tap min-w-tap items-center justify-center rounded border border-danger bg-surface px-1.5 text-sm text-danger disabled:border-border disabled:text-ink3'
/**
 * 〔休み〕は押しやすく（カードの右上にそろえ、幅をそろえる＝代表者の要望）。2026-11-09 代表者の指示「ボタン自体を小さくし、
 * より多くの利用者を１画面で」で、幅は 5rem から押せる下限の 44px に（どのカードも同じ幅のまま・太い枠で押し間違えない）
 */
const REST_BTN =
  'inline-flex min-h-tap min-w-tap items-center justify-center rounded border-2 border-border-strong bg-surface px-1.5 text-sm font-bold text-ink disabled:border-border disabled:text-ink3'

/**
 * デイの画面の上の切り替え（今日／バイタル／食事／排泄／活動／機能訓練）。今いる画面は塗りと aria-current で示す。
 * 〔排泄〕（2026-10-25 §9.7）は別のアプリ（排泄ケアアプリのデイの表示）へ同じタブで移る＝Link でなく a。押した直前に handoff を呼ぶ
 * （今日の一覧を持つ画面は受け渡しのキーを書き直す。今日の一覧が無い画面は渡さない＝書かずに移る）
 * pending（2026-11-09 計画B）: 今日の画面だけ、〔バイタル・食事〕〔活動一括〕〔機能訓練〕に未入力の数（計画B2: それぞれの一括の画面の
 * 「未入力 n名」の n と同じ数え方＝到着を問わず、空の欄がある方の数）を
 * 「未5」と添える（0 は出さない）。読み上げは見えている名前から「バイタル・食事（未入力 5名）」。ほかの画面は渡さない（今のまま）
 * 2026-11-09 計画B3: 〔バイタル一括〕〔食事一括〕を〔バイタル・食事〕1つにまとめた（未入力の数も1人7欄で1つ）。項目の頭に分類の色の印
 * （縦の短い棒・バイタル＝ティール・食事＝イエロー・活動＝コーラル・機能訓練＝ローズ。読み上げない。意味は名前で伝える）
 */
export function DaycareNav({
  current,
  handoff,
  pending,
}: {
  current: 'today' | 'vitalsMeals' | 'activity' | 'training'
  handoff?: () => void
  pending?: DaycareNavPending
}) {
  const items: { key: 'today' | 'vitalsMeals' | 'activity' | 'training'; to: string; label: string; cats: readonly DaycareCategory[] }[] = [
    { key: 'today', to: '/record/daycare', label: '今日（到着・休み）', cats: [] },
    // 2026-11-09 計画B3: バイタル一括（2026-10-22）と食事一括（今日の画面の改善 2回目・2026-10-24）を1つの画面に
    { key: 'vitalsMeals', to: DAYCARE_VITALS_MEALS_PATH, label: 'バイタル・食事', cats: ['vitals', 'meals'] },
    // 段階2b（2026-10-22）: 活動・レクをまとめて記録
    { key: 'activity', to: '/record/daycare/bulk', label: '活動一括', cats: ['activity'] },
    // 段階3a（2026-10-23）: 個別機能訓練（配置と実施記録）
    { key: 'training', to: '/record/daycare/training', label: '機能訓練', cats: ['training'] },
  ]
  // 2026-11-09 代表者の指示（1画面に多く）: 押せる高さ 44px は保ち、文字と左右の余白を詰める（どの画面でも上の段が1段で収まるように）
  const navCls = 'flex min-h-tap items-center rounded border border-border-strong bg-surface px-3 text-sm text-ink'
  const excretion = (
    <a
      key="excretion"
      href={HAIBEN_DAYCARE_HREF}
      // 押した直前に書く。中クリック（auxclick）・長押しのメニュー（contextmenu）から新しいタブで開く時も書く（反証 軽4）
      onClick={() => handoff?.()}
      onAuxClick={() => handoff?.()}
      onContextMenu={() => handoff?.()}
      className={navCls}
    >
      {/* 読み上げの名前は見えている文字から始める（「排泄（別アプリ）」＝声の操作で言える。反証 軽5） */}
      排泄<span className="ml-1 text-sm">（別アプリ）</span>
      <span className="sr-only">：排泄ケアアプリのデイの表示へ移ります</span>
    </a>
  )
  return (
    <nav aria-label="デイの画面" className="flex flex-wrap gap-gap print:hidden">
      {items.flatMap((it) => [
        <Link
          key={it.key}
          to={it.to}
          aria-current={current === it.key ? 'page' : undefined}
          className={
            current === it.key
              ? 'flex min-h-tap items-center rounded border border-primary bg-primary px-3 text-sm font-bold text-primary-ink'
              : navCls
          }
        >
          {current === it.key ? <span aria-hidden="true">✓ </span> : null}
          {/* 分類の色の印（2026-11-09 計画B3・読み上げない）。バイタル・食事は2本。今いる画面（primary の塗り）の上では印が溶けるので、
              地の色（surface）の細い縁を付ける（反証 軽6: 縁と primary は明 8.6・暗 7.9、印と縁は 3.3 以上） */}
          {it.cats.length > 0 ? (
            <span aria-hidden="true" className={`mr-1.5 inline-flex ${current === it.key ? 'gap-1' : 'gap-0.5'}`}>
              {it.cats.map((c) => (
                <span key={c} className={`inline-block h-4 w-1 rounded-sm ${DAYCARE_CATEGORY_CLS[c].dot}${current === it.key ? ' ring-1 ring-surface' : ''}`} />
              ))}
            </span>
          ) : null}
          {/* 1280px 未満では括弧の補足を出さない（「今日（到着・休み）」→「今日」。狭い画面で切り替えが2段に収まる）。
              2026-11-09 計画B: 640px（sm）から 1280px（xl）に上げた（今日の画面で未入力の数を添えても、iPad 横 1180px で切り替えと
              記録者が1段に収まるように＝親の決定。デイの5画面で共通） */}
          {it.label.indexOf('（') > 0 ? (
            <>
              {it.label.slice(0, it.label.indexOf('（'))}
              <span className="hidden xl:inline">{it.label.slice(it.label.indexOf('（'))}</span>
            </>
          ) : (
            it.label
          )}
          {navPendingOf(pending, it.key) !== null ? (
            <>
              <span aria-hidden="true" className="ml-1 rounded bg-danger-bg px-1 font-bold text-danger">
                未{navPendingOf(pending, it.key)}
              </span>
              <span className="sr-only">（未入力 {navPendingOf(pending, it.key)}名）</span>
            </>
          ) : null}
        </Link>,
        // 記録の順（バイタル → 食事 → 排泄）に、食事の次へ置く（2026-11-09 計画B3: 食事一括はバイタル・食事にまとめたので、その次）
        ...(it.key === 'vitalsMeals' ? [excretion] : []),
      ])}
    </nav>
  )
}

/** 予定の帯（3値・名簿に無い方・照合できない予定・写し） */
function PlanBanners({ data, notInRoster, unconfirmed, today }: { data: DayData; notInRoster: number; unconfirmed: number; today: string }) {
  const out: ReactNode[] = []
  if (data.missing) {
    out.push(
      <p key="missing" role="alert" className="rounded-lg border border-danger bg-danger-bg p-3 text-base text-ink">
        <span aria-hidden="true">▲ </span>デイの記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。
      </p>,
    )
  } else if (data.planSource === 'unknown') {
    out.push(
      <p key="unknown" role="alert" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
        <span aria-hidden="true">▲ </span>予定を確かめられません（週間計画の写しが読めません）。「予定なし」ではありません。来所した方は〔予定にない方を追加〕でカードを足し、そのカードを押した1人の画面の〔予定外で到着〕で記録できます。
      </p>,
    )
  } else if (data.planSource === 'none') {
    out.push(
      <p key="none" role="status" className="rounded-lg border border-border bg-surface2 p-3 text-base text-ink">
        本日のデイの予定はありません（週間計画で確かめました）。
      </p>,
    )
  }
  if (notInRoster > 0) {
    out.push(
      <p key="nir" role="status" className="rounded-lg border border-border bg-surface2 p-3 text-base text-ink">
        <span aria-hidden="true">ⓘ </span>名簿に無い方 {notInRoster} 名（この画面では記録しません。これまでどおりの方法で記録してください）
      </p>,
    )
  }
  if (unconfirmed > 0) {
    out.push(
      <p key="unc" role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
        <span aria-hidden="true">▲ </span>週間計画と照合できない予定 {unconfirmed} 件（氏名の食い違いなど）。事務所で週間計画を確かめてください。来所した方は〔予定にない方を追加〕でカードを足し、そのカードを押した1人の画面の〔予定外で到着〕で記録できます。
      </p>,
    )
  }
  // 過去の日で写しが無い・写しが「確かめられない」だった時は、いまの週間計画で出している旨を出す（反証レビュー2巡目 軽3）。
  // いまの週間計画も読めない時は「予定を確かめられません」の帯だけにする（両方出すと食い違う）
  if (data.day < today && !data.missing && data.planSource !== 'unknown' && (data.snapshot === null || data.snapshot.plan_source === 'unknown')) {
    out.push(
      <p key="nosnap" role="status" className="rounded-lg border border-border bg-surface2 p-3 text-sm text-ink2">
        {data.snapshot === null ? 'この日の予定の写しがありません。' : 'この日は予定の写しを取れませんでした（週間計画が読めませんでした）。'}
        いまの週間計画で予定を出しています（当日の予定と違うことがあります）。
      </p>,
    )
  }
  return out.length === 0 ? null : <div className="space-y-2">{out}</div>
}

export interface DaycarePageProps {
  /** App.tsx が持っている職員名簿（記録者の表示に使う） */
  staff?: Staff[] | null
  /** App.tsx の操作者（記録者） */
  actorId?: number | null
}

export function DaycarePage({ staff = undefined, actorId = null }: DaycarePageProps = {}) {
  const { toast, show } = useToast()
  const [today, setToday] = useState(todayIso())
  const [day, setDay] = useState(todayIso())
  const [data, setData] = useState<DayData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [residents, setResidents] = useState<Resident[]>([])
  const [active, setActive] = useState<Resident[]>([])
  const [targets, setTargets] = useState<Map<number, ResidentTargets>>(new Map())
  // 段階2d-2: 個人のバイタルの閾値（〔＋再測定〕の印をその方の基準で出す。読めない時は施設の基準・その旨を出す）
  const limits = useVitalLimits(reloadKey)
  const [closedDates, setClosedDates] = useState<string | null>(null)
  const [gate, setGate] = useState<{ value: boolean; observed: boolean; forbidden?: true; outdated?: true } | null>(null)
  const [extraIds, setExtraIds] = useState<number[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  /** ログインの役割（事務所・管理者だけ過去の日の到着・帰宅の時刻を入れられる。分からない間は現場と同じ扱い） */
  const [role, setRole] = useState<MyRole | null | undefined>(cachedMyRole())
  const [, setQueueTick] = useState(0)
  const genRef = useRef(0)
  const dayRef = useRef(day)
  dayRef.current = day
  const opening = useRef<Promise<void> | null>(null)

  useEffect(() => {
    let alive = true
    const ask = () => {
      void fetchMyRole().then((r) => {
        if (alive) setRole(r)
      })
    }
    ask()
    const off = subscribeMyRole(ask)
    return () => {
      alive = false
      off()
    }
  }, [])

  // ── 時計（60秒ごと・画面に戻った時に今日を取り直す） ──
  useEffect(() => {
    const tick = () => setToday(todayIso())
    const t = window.setInterval(tick, 60_000)
    const vis = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', vis)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', vis)
    }
  }, [])

  // ── 入力解禁（画面を開くたびに取り直す） ──
  useEffect(() => {
    let alive = true
    setGate(null)
    getKindInputGate('daycare')
      .then((g) => {
        if (alive) setGate(g)
      })
      .catch(() => {
        if (alive) setGate({ value: false, observed: false })
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  // 入浴の旗（input_enabled_bath）も開くたびに取り直す（表示には使わない）。この画面の入浴の記録（〔予定どおり実施〕・区分・休み）は、
  // 端末が「入浴を記録できる」を一度観測していれば、電波が無くても送信待ちに積まれる（db.ts の assertKindWritable）。
  // 2026-10-24 に記録ハブから入浴のボタンとその旗の取得を外したので、この画面が自分で取る（確認の反証 中1）
  useEffect(() => {
    void getKindInputGate('bath').catch(() => undefined)
  }, [reloadKey])

  // ── 名簿・個別の目標・休業日（1回） ──
  useEffect(() => {
    let alive = true
    Promise.all([fetchAllResidents(), fetchResidentsFromAll(), fetchResidentTargets().catch(() => new Map<number, ResidentTargets>()), getAppSetting('daycare_closed_dates').catch(() => null)])
      .then(([all, act, tg, closed]) => {
        if (!alive) return
        setResidents(all)
        setActive(act)
        setTargets(tg)
        setClosedDates(closed)
      })
      .catch(() => {
        // 名簿が読めない時は下の読み込みのエラーで知らせる（氏名の代わりに番号を出す）
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  // ── 1日の読み込み（世代つき。最新の世代 かつ 今の日付の応答だけを入れる） ──
  const load = useCallback(async (target: string, quiet: boolean) => {
    const gen = ++genRef.current
    if (!quiet) {
      setLoading(true)
      setError(null)
    }
    try {
      // 写し・出欠・入浴・バイタル・食事と水分・活動を同時に出し、予定だけを写しの後に出す（daycareDayLoad・2026-10-29 本人指示）。
      // 写しが「読めなかった」（unknown）の日は、いまの週間計画も読む（読めれば表示に使い、次のタップで写し直す＝反証レビュー中2）
      // 機能訓練の記録も同時に読む（2026-11-09 計画B）。読めない時は null（印を「読めない」にするだけ）。この読み込みの中に置くので、
      // 日の切り替え後の古い応答は入れず（世代と日付の守り）、送信待ちが届いた時・〔最新に更新〕の読み直しでも一緒に読み直す
      // 〔未測定〕の印（2026-11-10・0062）も同じ回で読む（1本）。読めない時は null（印なしで数えるだけ）
      const [{ snapshot, missing, plan, attendance, baths, vitals, bathsOk, vitalsOk, intake, activities }, training, unmeasured] = await Promise.all([
        loadDaycareDayParts(target, DAY_READERS),
        fetchTrainingSessions(target).catch((): DaycareTrainingSession[] | null => null),
        fetchDaycareVitalUnmeasured(target)
          .then((r) => r.rows)
          .catch((): DaycareVitalUnmeasured[] | null => null),
      ])
      const usable = snapshot !== null && snapshot.plan_source !== 'unknown'
      if (gen !== genRef.current || target !== dayRef.current) return
      const next: DayData = {
        day: target,
        planRows: usable && snapshot !== null ? snapshot.plan_rows : (plan?.rows ?? []),
        planSource: usable && snapshot !== null ? snapshot.plan_source : (plan?.source ?? 'unknown'),
        snapshot,
        missing: missing || plan?.missing === true,
        attendance,
        baths,
        vitals,
        bathsOk,
        vitalsOk,
        meals: intake?.meals ?? [],
        fluids: intake?.fluids ?? [],
        activities,
        training,
        unmeasured,
        intakeOk: intake !== null,
        memoAt: null,
        readAt: Date.now(),
      }
      setData(next)
      setError(null)
    } catch (e) {
      if (gen !== genRef.current) return
      // 電波が無い（通信の失敗）: 同じ日の控えがあれば、それで開く（1人の画面から戻った時も開ける・カードの〔休み〕は送信待ちに積める
      // ＝親の確かめ 中1）。静かな読み直しの失敗では、いま出している内容を残す
      const m = memoForDay(daycareDayMemo(), target, e)
      if (m !== null && target === dayRef.current && !quiet) {
        setData({
          day: m.day,
          planRows: m.planRows,
          planSource: m.planSource,
          snapshot: m.snapshot,
          missing: m.missing,
          attendance: m.attendance,
          baths: m.baths,
          vitals: m.vitals,
          // 控えに「読めなかった」と残っている時は、控えで開いても「読めない」の印（空の一覧を「未」に見せない＝確認の反証 中1）
          bathsOk: memoBathsOk(m),
          vitalsOk: memoVitalsOk(m),
          meals: m.meals,
          fluids: m.fluids,
          // 活動・機能訓練は控えに無い（読めない＝印を出さない／「読めない」の印）
          activities: null,
          training: null,
          intakeOk: m.intakeOk,
          memoAt: m.savedAt,
          readAt: m.savedAt,
          // 〔未測定〕の印も控えに無い（2026-11-10。印なしで数える）
          unmeasured: null,
        })
        // 名簿が読めていない（電波が無い）時は控えの名簿で氏名を出す（控えは画面のメモリだけ）
        if (m.residents.length > 0) setResidents((prev) => (prev.length > 0 ? prev : m.residents))
        setError(null)
        return
      }
      if (!quiet) setError(ERR_LOAD)
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setExtraIds([])
    void load(day, false)
  }, [day, reloadKey, load])

  // ── 他の端末の変更（Realtime）と送信待ちの減り（送れた）で読み直す ──
  const reloadTimer = useRef<number | null>(null)
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null
      void load(dayRef.current, true)
    }, 400)
  }, [load])
  useEffect(() => {
    const onChange = (table: string, info?: { event: string; row: Record<string, unknown> | null }) => {
      if (info?.row && isSelfWrite(table, info.row)) return
      scheduleReload()
    }
    const offA = subscribeDaycareChanges(onChange)
    const offB = subscribeBathChanges(onChange)
    const offC = subscribeChanges((table, info) => {
      if (table === 'vitals' || table === 'meals' || table === 'fluid_intake') onChange(table, info)
    })
    const offD = subscribeDaycareActivityChanges(onChange)
    let last = queuePending()
    const offQ = queueSubscribe((n) => {
      setQueueTick((x) => x + 1)
      if (n < last) scheduleReload()
      last = n
    })
    return () => {
      offA()
      offB()
      offC()
      offD()
      offQ()
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    }
  }, [scheduleReload])

  // ── その日の一覧の控え（画面のメモリだけ・端末には残さない＝daycareDayMemo）。電波の無い所でカードを押した時、1人の画面は
  // 通信の失敗の時だけこの控えで開く（到着・休み・入浴は送信待ちに積める＝親の検収 中1・2026-10-24） ──
  useEffect(() => {
    // 控えで開いた時は控えを書き直さない（書けた記録は put…で控えにも映す）
    if (data === null || data.missing || data.memoAt !== null) return
    rememberDaycareDay({
      day: data.day,
      planRows: data.planRows,
      planSource: data.planSource,
      snapshot: data.snapshot,
      missing: data.missing,
      attendance: data.attendance,
      baths: data.baths,
      vitals: data.vitals,
      // 入浴・バイタルを読めなかった一覧の時も、控えの値を前の値のまま残す（前に読めた値が無ければ「読めない」と控える＝確認の反証 中1）
      bathsOk: data.bathsOk,
      vitalsOk: data.vitalsOk,
      meals: data.meals,
      fluids: data.fluids,
      // 食事・水分を読めなかった一覧の時は、控えの食事・水分を前の値のまま残す（rememberDaycareDay の中＝親の反証 軽3）
      intakeOk: data.intakeOk,
      residents,
      savedAt: data.readAt,
    })
  }, [data, residents])
  // 控えで開いている間は、30秒ごとに静かに読み直す（1人の画面と同じ。読めた時にサーバーの内容に戻して帯を消す）
  const onMemo = data !== null && data.memoAt !== null
  useEffect(() => {
    if (!onMemo) return
    const t = window.setInterval(() => scheduleReload(), 30_000)
    return () => window.clearInterval(t)
  }, [onMemo, scheduleReload])
  // 1人の画面の部品は App の先読み（PAGE_PRELOADS）が読んでおく（電波の無い所でカードを押しても画面を開ける。先読みの失敗を
  // 「部品の取得失敗」と見分けない守りと、新しい版の確かめは App の仕組みに任せる＝確認の反証 軽1）

  // ── 一覧 ──
  const board = useMemo(
    () =>
      data === null
        ? null
        : buildDaycareBoard({ planRows: data.planRows, source: data.planSource, residents, attendance: data.attendance, extraIds }),
    [data, residents, extraIds],
  )
  // 排泄ケアアプリへの受け渡し（su_daycare_handoff_v1・§9.7）: 今日の一覧を作るたびに書き直す（開いた時・休みとその取り消し・
  // 〔元に戻す〕の後＝出欠が変わると一覧が作り直される）。過去の日は書かない。控えで開いた今日の一覧からは書いてよい
  useEffect(() => {
    if (board === null || data === null || data.day !== day) return
    writeDaycareHandoffFor({ rows: board.rows, residents, boardDay: data.day, today })
  }, [board, data, residents, day, today])
  const nameOf = useCallback(
    (id: number) => residents.find((r) => r.id === id)?.name ?? `利用者ID ${id}`,
    [residents],
  )
  /** ふりがな（カードの氏名の下。無ければ出さない） */
  const kanaOf = (id: number) => residents.find((r) => r.id === id)?.kana ?? null
  const bathOf = useCallback((id: number) => data?.baths.find((b) => b.resident_id === id) ?? null, [data])
  /** 段階2a: 行の昼食の欄。水分・活動の札は 1人1行にした時に一覧から外し、1人の記録の画面で見る（代表者の回答 A3・2026-10-23） */
  const lunchOf = (id: number) => data?.meals.find((m) => m.meal.resident_id === id && m.meal.meal_slot === 'lunch')?.meal ?? null
  const vitalsOf = useCallback((id: number) => (data?.vitals ?? []).filter((v) => v.resident_id === id), [data])

  const canWrite = gate !== null && gate.observed && gate.value === true && !(data?.missing ?? false)
  const isFuture = day > today

  /** 開所の最初のタップ（今日だけ）: その日の予定の写しを作る。通信できない時は次のタップでもう一度（記録は止めない） */
  const ensureOpened = useCallback(async () => {
    // 写しが無い日と、写しが「読めなかった」（unknown）日は作り直す（サーバーが unknown の写しだけを1回置き換える）
    if (data === null || (data.snapshot !== null && data.snapshot.plan_source !== 'unknown') || day !== todayIso()) return
    if (opening.current !== null) return opening.current
    opening.current = (async () => {
      try {
        const snap = await openDaycareDay(day, actorId)
        setData((prev) =>
          prev !== null && prev.day === snap.day
            ? snap.plan_source === 'unknown'
              ? { ...prev, snapshot: snap }
              : { ...prev, snapshot: snap, planRows: snap.plan_rows, planSource: snap.plan_source }
            : prev,
        )
      } catch {
        // 写しは次のタップで作り直す（到着・欠席の記録そのものは止めない）
      } finally {
        opening.current = null
      }
    })()
    return opening.current
  }, [data, day, actorId])

  // ── 到着・帰宅・休み・入浴の操作（今日の画面のカードと1人の画面で同じ部品＝DaycareAttendanceOps・2026-10-24 §9.4） ──
  // カードで使うのは〔休み〕〔取消〕（と 0047 が無い DB の理由の小窓）だけ。到着・帰宅・時刻の直し・休みの理由・入浴は1人の画面
  const ops = useDaycareAttendanceOps({
    place: 'board',
    day,
    today,
    role,
    gate,
    canWrite,
    actorId,
    closedDates,
    nameOf,
    bathOf,
    // 画面の data を直す時に、控えも同じ形で直す（控えで開いている間に書けた記録を、前の方・次の方や戻った先でも出す＝親の確かめ 中2）
    putAttendance: (r) => {
      updateDaycareDayMemo((m) => memoWithAttendance(m, r))
      setData((prev) => {
        if (prev === null || prev.day !== r.day) return prev
        const others = prev.attendance.filter((a) => a.id !== r.id && a.resident_id !== r.resident_id)
        return { ...prev, attendance: [...others, r] }
      })
    },
    dropAttendance: (saved) => {
      updateDaycareDayMemo((m) => memoWithoutAttendance(m, saved))
      setData((prev) => (prev === null || prev.day !== saved.day ? prev : { ...prev, attendance: prev.attendance.filter((a) => a.id !== saved.id) }))
    },
    putBath: (r) => {
      updateDaycareDayMemo((m) => memoWithBath(m, r))
      setData((prev) => (prev === null || prev.day !== r.bath_on ? prev : { ...prev, baths: [...prev.baths.filter((b) => b.resident_id !== r.resident_id), r] }))
    },
    scheduleReload,
    ensureOpened,
    show,
    resetKey: reloadKey,
  })

  const addExtra = (id: number | null) => {
    setPickerOpen(false)
    if (id === null) return
    setExtraIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
  }

  // ── 描画 ──
  // 上の段は2段（切り替え＋記録者／日付＋件数）に詰める（2026-11-09 代表者の指示「タイトル帯やその他表示が小さくなってもよい」）。
  // 件数（counts）は読み込めた後だけ、日付の右に並べる（幅が足りない時は次の行へ回る）。切り替えの未入力の数（navPending）も読み込めた後だけ
  const header = (counts: ReactNode = null, navPending?: DaycareNavPending) => (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <DaycareNav current="today" handoff={() => writeDaycareHandoffFor({ rows: board?.rows ?? null, residents, boardDay: data?.day ?? null, today })} pending={navPending} />
        <RecorderBar actorId={actorId} staff={staff ?? null} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-gap" role="group" aria-label="日付">
          <button
            type="button"
            onClick={() => setDay((d) => addDays(d, -1))}
            className="min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-lg text-ink"
            aria-label="前の日へ"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <span className="min-w-28 text-center text-lg font-bold text-ink" aria-live="polite">
            {fmtDayLabel(day)}
            {day === today ? <span className="ml-2 text-base text-ok">今日</span> : null}
          </span>
          <button
            type="button"
            onClick={() => setDay((d) => (addDays(d, 1) > today ? d : addDays(d, 1)))}
            disabled={day >= today}
            className="min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-lg text-ink disabled:text-ink3"
            aria-label="次の日へ"
          >
            <span aria-hidden="true">›</span>
          </button>
          {day !== today ? (
            <button type="button" onClick={() => setDay(today)} className="min-h-tap rounded border border-primary px-3 text-sm font-bold text-primary">
              今日を開く
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setReloadKey((n) => n + 1)}
            className="min-h-tap rounded border border-border-strong bg-surface px-3 text-sm text-ink"
          >
            最新に更新
          </button>
        </div>
        {counts}
      </div>
      {day < today ? (
        <p role="status" className="rounded-lg border border-border bg-surface2 px-3 py-1.5 text-sm text-ink2">
          {canEditPastDaycareTimes(role)
            ? '過去の日を表示しています。到着・帰宅は、カードを押した1人の画面で時刻を入れて記録・修正します（事務所のログイン）。'
            : '過去の日を表示しています。到着・帰宅の時刻は事務所のログインで入力・修正します。休みはカードの〔休み〕、入浴はカードを押した1人の画面で記録できます（時刻が入っている方の休み・帰宅の取り消しは事務所）。'}
        </p>
      ) : null}
      {gate !== null && !(gate.observed && gate.value === true) ? (
        <p role="status" className="rounded-lg border border-warn bg-warn-bg px-3 py-1.5 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {gate.forbidden ? FORBIDDEN_REASON : gate.outdated ? OUTDATED_REASON : gate.observed ? `${kindBlockedMessage('daycare')}。記録の閲覧はできます。` : MSG_GATE_UNKNOWN}
        </p>
      ) : null}
      {data !== null && data.day === day && data.memoAt !== null ? (
        // 電波が無く、控えで開いた（1人の画面と同じ帯＝親の確かめ 中1）。押した記録は送信待ちに積み、電波が戻ると送って読み直す
        <p role="status" className="rounded-lg border border-warn bg-warn-bg px-3 py-1.5 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          サーバーに届かないため、今日の一覧で読んだ時点（{new Date(data.memoAt).toTimeString().slice(0, 5)}）の内容です。押した記録は送信待ちに積みます（つながると自動で送信します）。
        </p>
      ) : null}
    </div>
  )

  if (loading && data === null) {
    return (
      <div className="w-full space-y-2">
        {header()}
        <LoadingBlock label="デイの予定と記録を読み込んでいます…" />
      </div>
    )
  }
  if (error !== null && (data === null || data.day !== day)) {
    return (
      <div className="w-full space-y-2">
        {header()}
        <ErrorBlock message={error} onRetry={() => setReloadKey((n) => n + 1)} />
      </div>
    )
  }
  if (data === null || board === null) return null

  const c = board.counts
  // バイタルの回ごとの値（サーバーの値に、この端末の送信待ちを重ねる＝バイタル一括と同じ純関数 daycareVitalSlotsWithPending・vitalShownValues
  // ・2026-11-09 反証 中1）。描くたびに1回だけ作る（送信待ちを読むのは端末の中だけ・通信しない）
  const vitalKeys = data.vitals.flatMap((v) => (typeof v.client_key === 'string' ? [v.client_key] : []))
  const vitalTarget = (id: number, key: string): VitalTarget => ({ routine: false, clientKey: key, residentId: id, day: data.day, kind: 'observation' })
  const vitalShown = new Map(
    board.rows.map((r) => {
      const id = r.residentId
      // 2026-11-10 確認の反証 軽1: 〔未測定〕の印だけの回も回に入れる（バイタル・食事の画面と同じ。この画面は取り消した測定の行のキーを
      // 読まないので、生きている行のキーだけで取り消した回を見分ける＝その回に印だけが残った稀な時は一括の画面とずれる）
      const markSeqs = unmeasuredSlotSeqs(data.unmeasured, id, data.day, vitalKeys, vitalKeys)
      const slots = daycareVitalSlotsWithPending(vitalsOf(id), vitalKeys, id, data.day, markSeqs, (key) => pendingRow('vitals', vitalTarget(id, key)) !== null)
      return [id, slots.map((slot) => ({ seq: slot.seq, vals: vitalShownValues(pendingRow('vitals', vitalTarget(id, slot.key)), slot.vital) }))]
    }),
  )
  /** 測った（どれかの回のどれかの欄に値がある。血圧の下も入れる＝反証 軽4・送信待ちを含む） */
  const vitalsDone = (id: number) => vitalSlotsFilled((vitalShown.get(id) ?? []).map((s) => DAYCARE_VITAL_FIELDS.map((f) => s.vals[f])))
  /** 値のある回のうち一番後の回が、再測定の目安に当たる */
  const vitalsAbnormal = (id: number) => {
    const withVal = (vitalShown.get(id) ?? []).filter((s) => DAYCARE_VITAL_FIELDS.some((f) => s.vals[f] !== null))
    const latest = withVal.length === 0 ? null : withVal.reduce((a, b) => (b.seq > a.seq ? b : a))
    return latest !== null && vitalNeedsRecheck(latest.vals, targets.get(id), limits.lookup(id, data.day))
  }
  /**
   * 数える回の空の欄の数（2026-11-10 反証 軽2: バイタル・食事の画面と同じ純関数 daycareCountSeq で数える回を決める＝取り消した
   * 測定の行のキーを読まないこの画面でも、同じ回の〔未測定〕の印を数える）。印のある欄は入力済み
   */
  const countBlankOf = (id: number): number => {
    const shown = vitalShown.get(id) ?? []
    const keyOf = (seq: number) => daycareVitalKey(data.day, id, seq)
    const live = new Set(vitalsOf(id).map((v) => v.client_key))
    const cs = daycareCountSeq(
      shown.filter((s) => live.has(keyOf(s.seq)) || pendingRow('vitals', vitalTarget(id, keyOf(s.seq))) !== null).map((s) => s.seq),
      unmeasuredSeqsOf(data.unmeasured, id, data.day),
      shown.map((s) => s.seq),
    )
    const first = shown.find((s) => s.seq === cs) ?? shown[0]
    return vitalBlankFields(first?.vals ?? null, unmeasuredFieldsOf(data.unmeasured, id, data.day, first?.seq ?? cs ?? 1))
  }
  // 2026-11-10 反証 軽7: 来所者で5欄とも値か〔未測定〕の印で埋まった方は「バイタル未」に入れない（確認の反証 軽5: カードの VS も同じ・仮置き）
  const vitalsWaiting = board.rows.filter((r) => r.state === 'present' && !vitalsTileDone(vitalsDone(r.residentId), countBlankOf(r.residentId))).length
  // 入浴を確かめていない方（代表者の決定 2026-10-23 の 3: 自動の行は「済」で数えない。12:30 を過ぎても行が無い方と、
  // 休みの方に自動の行が残っている方だけ＝daycare.ts の bathCountsUnchecked）
  const bathClock = { pastDay: data.day < today, nowHm: nowHm() }
  const bathUnchecked = board.rows.filter((r) => bathCountsUnchecked(daycareBathStatus(bathOf(r.residentId), r.bathingPlanned), r.state, bathClock)).length

  // 進み具合の印（2026-11-09 計画B・daycareProgress.ts）。カードの段4に使う（切り替えの未入力の数は計画B2 で一括の画面と同じ数え方にした＝下の navPending）。
  // 送信待ちは一括の画面と同じ決まりで重ねる（反証 中1: 食事＝送っている途中の値だけ・バイタル＝どの状態の値も・活動＝枠と同じ・訓練＝追加）。
  // 読めない項目は「読めない」の印（反証 中6）
  const trainingRead = data.training
  const trainingPending = trainingRead === null ? [] : pendingTrainingOps()
  const activityRead = data.activities
  const activityPending = activityRead === null ? [] : pendingActivityOps()
  const marksOf = new Map<number, ProgressMark[]>(
    board.rows.map((r) => {
      const id = r.residentId
      const vDone = vitalsDone(id)
      return [
        id,
        daycareProgressMarks({
          state: r.state,
          hospitalized: r.hospitalized,
          // 2026-11-10 確認の反証 軽5（仮置き）: VS の済も件数の帯と同じ vitalsTileDone（値が1つでもあるか、5欄が値か〔未測定〕で埋まった）。
          // 要確認（基準外）は値のある時だけ
          vitals: data.vitalsOk ? { done: vitalsTileDone(vDone, countBlankOf(id)), abnormal: vDone && vitalsAbnormal(id) } : null,
          lunch: lunchShownWith(lunchOf(id), pendingRow('meals', { residentId: id, day: data.day, slot: 'lunch' })),
          lunchRead: data.intakeOk,
          activity: activityRead === null ? null : activityCellsFilled(activityShownCells(activityRead, activityPending, id, data.day)),
          training: trainingRead === null ? null : trainingFilled(trainingRead, trainingPending, id, data.day),
          bath: data.bathsOk ? daycareBathStatus(bathOf(id), r.bathingPlanned) : null,
        }),
      ]
    }),
  )
  // 読めなかった項目の知らせ（一覧の上に1行）
  const unreadNotice = unreadProgressNotice(
    unreadProgressLabels({
      vitalsOk: data.vitalsOk,
      intakeOk: data.intakeOk,
      activitiesOk: data.activities !== null,
      trainingOk: data.training !== null,
      bathsOk: data.bathsOk,
    }),
  )
  // 切り替えの数は今日を見ている時だけ（リンクの先は今日を開くため＝反証 中2）。2026-11-09 計画B2: それぞれの一括の画面の「未入力 n名」の n と
  // 同じ数え方（一括の画面に出る方＝daycareBulkRows を到着を問わず・1人ずつの空の欄の数は一括の画面と同じ純関数・送信待ちを重ねた値）。
  // バイタル・食事＝最初の回の5欄と主食・副食（拒食は入力済み・2026-11-09 計画B3）・活動・訓練＝記録の有無。読めない項目（null）は数を出さない
  const bulk = daycareBulkRows(board.rows)
  const navPending =
    data.day === today
      ? daycareNavPending({
          // 2026-11-09 計画B3: バイタル・食事の画面の「未入力 n名」と同じ1人7欄（バイタルの最初の回の5欄＋昼食の主食・副食）。
          // バイタルか昼食のどちらかを読めない日は数を出さない（片方だけで数えると、画面の n と食い違うため）
          vitalsMeals:
            data.vitalsOk && data.intakeOk
              ? bulk.map(
                  (r) =>
                    vitalsMealsBlankFields(
                      // 2026-11-10 未測定: 数える回の〔未測定〕の印のある欄は入力済み（バイタル・食事の画面と同じ回・同じ純関数）
                      countBlankOf(r.residentId),
                      lunchBlankFields(lunchShownWith(lunchOf(r.residentId), pendingRow('meals', { residentId: r.residentId, day: data.day, slot: 'lunch' }))),
                    ) ?? 0,
                )
              : null,
          activity:
            activityRead === null
              ? null
              : bulk.map((r) => recordBlankFields(activityCellsFilled(activityShownCells(activityRead, activityPending, r.residentId, data.day)))),
          training:
            trainingRead === null ? null : bulk.map((r) => recordBlankFields(trainingFilled(trainingRead, trainingPending, r.residentId, data.day))),
        })
      : undefined

  // value=null＝読めない（バイタル・入浴を読めなかった日は数を「—」にし、▲ の注意の形にしない＝確認の反証 軽2）
  const tiles: { label: string; value: number | null; tone?: 'warn' }[] = [
    { label: '予定', value: c.planned },
    { label: '在席', value: c.present },
    { label: '帰宅', value: c.left },
    { label: '休み', value: c.absent },
    { label: '未到着', value: c.waiting },
    data.vitalsOk
      ? { label: 'バイタル未', value: vitalsWaiting, tone: vitalsWaiting > 0 ? 'warn' : undefined }
      : { label: 'バイタル未', value: null },
    data.bathsOk
      ? { label: '入浴 未確認', value: bathUnchecked, tone: bathUnchecked > 0 ? 'warn' : undefined }
      : { label: '入浴 未確認', value: null },
  ]

  return (
    // 幅の上限（max-w-5xl）と外側の余白（p-4）を外し、カードの列を画面の幅いっぱいに並べる（2026-11-09 代表者の指示・iPad 横で6列）
    <div className="w-full space-y-2">
      {header(
        // 件数の帯（1行に詰める＝代表者の要望 2026-10-23。注意の数は ▲ と太字と枠で示す＝色だけに頼らない）。日付の右に並べる（2026-11-09）
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface px-3 py-1" aria-label="件数">
          {tiles.map((t) => (
            <li
              key={t.label}
              className={`inline-flex items-baseline gap-1 text-sm ${t.tone === 'warn' ? 'rounded border border-warn bg-warn-bg px-1 font-bold text-ink' : 'text-ink2'}`}
            >
              {t.tone === 'warn' ? <span aria-hidden="true">▲</span> : null}
              <span>{t.label}</span>
              <span className="font-num text-lg font-bold text-ink">
                {t.value === null ? (
                  <>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">読み込めません</span>
                  </>
                ) : (
                  t.value
                )}
              </span>
            </li>
          ))}
        </ul>,
        navPending,
      )}
      {limits.failed ? <VitalLimitsFailedNote className="" onRetry={() => void limits.refresh()} /> : null}
      <PlanBanners data={data} notInRoster={board.notInRoster} unconfirmed={board.unconfirmed} today={today} />
      {/* その日に読めなかった項目があれば1行で知らせる（読めない項目の名前だけ・印は細い点線＝親の決定 2026-11-09）。カードがある時だけ */}
      {unreadNotice !== null && board.rows.length > 0 ? (
        <p role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {unreadNotice}
        </p>
      ) : null}

      {board.rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-base text-ink">
            {data.planSource === 'unknown'
              ? '予定を確かめられないため、一覧を出せません（「利用者なし」ではありません）。'
              : 'この日の予定・記録はまだありません。'}
          </p>
          <p className="mt-2 text-base text-ink2">来所した方は〔予定にない方を追加〕でカードを足し、そのカードを押した1人の画面の〔予定外で到着〕で記録できます。</p>
        </div>
      ) : (
        // カード（2026-10-24 代表者の決定 §9.4 の1〜3）: 五十音の通しの並び（見出しなし）。カードを押すと1人の画面へ
        // （到着・帰宅・時刻の直し・休みの理由・入浴はそこで）。〔休み〕〔取消〕はリンクの外の別のボタン（入れ子にしない）。
        // 列の数は幅で自動（src/index.css の .dc-cards・iPad 横で6列・縦で4列・スマホで2列＝2026-11-09 代表者の指示）。
        // 2026-11-09 計画B: カードの中は4段だけ（氏名と〔休み〕／ふりがな／状態の段／進み具合の印。段の間はあけない）。
        // iPad 横 1180×820 で 6列×5段＝30名が見える高さ（1枚 約121px 以下）に収める。未送信の印・行の知らせは出た時だけ下に足す
        <ul className="dc-cards" aria-label="利用者の一覧">
          {board.rows.map((row) => {
            const pending = hasPendingDaycareAttendance(row.residentId, day, row.attendance?.id ?? null)
            const isBusy = ops.busy.has(row.residentId) || pending
            const m = ops.rowMsg.get(row.residentId)
            const name = nameOf(row.residentId)
            const kana = kanaOf(row.residentId)
            const disabled = !canWrite || isFuture || isBusy
            /** 時刻の入った方を休みにする（時刻を消す）のは、今日は誰でも・過去の日は事務所のログインだけ（0042 と同じ規則） */
            const timesOk = canChangeDaycareTimes(day, today, role)
            const rowHasTimes = hasTimes(row)
            const absent = row.state === 'absent'
            /** 状態の段（記号＋言葉＋時刻）とカードの地と枠（状態の4色・色だけに頼らない） */
            const tone = daycareStateTone(row)
            const marks = marksOf.get(row.residentId) ?? []
            return (
              <li key={row.residentId} className={`dc-card relative flex min-w-0 flex-col rounded-lg border px-1.5 py-1.5 ${tone.cardCls}`}>
                <div className="flex flex-wrap items-center gap-2">
                  {/* 段1: 氏名（押すと1人の記録へ。カード全体を押せる＝.dc-card-link の ::after）と〔休み〕／〔取消〕（44px）。
                      長い氏名は切らずに折り返す（2行までなら〔休み〕の高さの中に収まる）。カードが狭い時（拡大表示・大きな文字）は
                      〔休み〕を氏名の下へ回す（氏名の幅を 5 文字分は残す） */}
                  <div className="min-w-[5em] flex-1">
                    <Link to={personPath(row.residentId, day, today)} className="dc-card-link block rounded">
                      <span className="block break-words text-base font-bold leading-tight text-ink">
                        {name}
                        <span className="sr-only">さんの1日の記録を開く</span>
                      </span>
                    </Link>
                  </div>
                  {/* 休み（リンクの外の別のボタン。休みの方は〔取消〕だけ・理由は1人の画面で選ぶ） */}
                  {absent ? (
                    <button
                      type="button"
                      onClick={() => ops.askCancelAbsent(row)}
                      disabled={disabled}
                      aria-label={`${name}さんの休みを取り消す`}
                      className={`relative z-[1] shrink-0 ${DANGER_CELL_BTN}`}
                    >
                      取消
                    </button>
                  ) : row.hospitalized && row.state === 'planned' ? null : (
                    <button
                      type="button"
                      onClick={() => ops.onRest(row)}
                      disabled={disabled || (rowHasTimes && !timesOk)}
                      aria-label={`${name}さんを休みにする`}
                      className={`relative z-[1] shrink-0 ${REST_BTN}`}
                    >
                      休み
                    </button>
                  )}
                </div>
                {/* 段2: ふりがな（カードの幅いっぱい・切らずに折り返す。〔休み〕の横に置かない＝2026-10-24 の決まりに戻した）。
                    文字は 14px（入居者マスタの決まり＝0.875rem 未満を使わない・2026-10-24 の A4 と同じ下限） */}
                {kana !== null && kana !== '' ? <p className="break-words text-xs leading-tight text-ink2">{kana}</p> : null}
                {/* 段3: 状態の段（予定・到着・帰宅を1段に。記号は読み上げない・言葉と時刻を読む） */}
                <p className="break-words text-sm font-bold leading-tight text-ink">
                  <span aria-hidden="true">{tone.mark} </span>
                  {tone.word}
                </p>
                {/* 予定の誤りは、来た方・休みの方・入院中の方でも状態の段の下に1行出す（その方のカードだけ伸びる＝反証 中3） */}
                {tone.planWarn !== null ? (
                  <p className="break-words text-sm font-bold leading-tight text-ink">
                    <span aria-hidden="true">▲ </span>
                    {tone.planWarn}
                  </p>
                ) : null}
                {/* 段4: 進み具合の印（押せない表示。VS バイタル・食 昼食・活 活動・訓 訓練・浴 入浴。形と文字でも分ける＝色だけに頼らない。
                    記録は1人の画面・上の切り替えの一括の画面で） */}
                <p className="flex flex-wrap gap-1">
                  {marks.map((mk) => (
                    <span
                      key={mk.key}
                      title={`${mk.label}: ${PROGRESS_STATE_WORD[mk.state]}`}
                      // 2026-11-09 計画B3: 札の下に分類の色の細い線（控えめに。枠の線＝済・未・対象外の形の区別はそのまま・入浴は線なし）
                      className={`rounded px-1 text-sm leading-tight ${PROGRESS_MARK_CLS[mk.state]} ${progressCategoryLine(mk.key)}`}
                    >
                      <span aria-hidden="true">{mk.short}</span>
                      <span className="sr-only">
                        {mk.label} {PROGRESS_STATE_WORD[mk.state]}
                      </span>
                    </span>
                  ))}
                </p>
                {pending ? (
                  <p className="text-sm leading-tight text-ink2" role="status">
                    <span aria-hidden="true">↻ </span>未送信の記録があります（電波が戻ると自動で送信します）
                  </p>
                ) : null}
                {m !== undefined ? (
                  <p
                    role={m.tone === 'danger' ? 'alert' : 'status'}
                    className={`rounded border p-2 text-sm text-ink ${
                      m.tone === 'danger' ? 'border-danger bg-danger-bg' : m.tone === 'warn' ? 'border-warn bg-warn-bg' : 'border-border bg-surface2'
                    }`}
                  >
                    {m.tone === 'danger' || m.tone === 'warn' ? <span aria-hidden="true">▲ </span> : null}
                    {m.text}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-gap">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={!canWrite || isFuture}
          className="min-h-tap rounded border border-primary px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
        >
          ＋ 予定にない方を追加
        </button>
        {/* 連絡帳（2026-11-09 計画C・段階4）: この日を開く。上の切り替え（DaycareNav）には足さない（1180px で1段に収めるため） */}
        <Link
          to={contactPath(day, today)}
          className="inline-flex min-h-tap items-center rounded border border-primary px-4 text-base font-bold text-primary"
        >
          連絡帳
        </Link>
        {/* 印の説明（一覧の下に1行。上の段には足さない＝2026-11-09 計画B） */}
        {board.rows.length > 0 ? (
          <p className="text-sm text-ink2">印: VS バイタル・食 昼食・活 活動・訓 訓練・浴 入浴（実線＝済・点線＝未・枠なし＝対象外・太枠＝要確認・細い点線＝読めない）</p>
        ) : null}
      </div>

      <ResidentPickerModal open={pickerOpen} residents={active} onPick={addExtra} onClose={() => setPickerOpen(false)} />

      {ops.dialogs}
      {toast}
    </div>
  )
}

export default DaycarePage
