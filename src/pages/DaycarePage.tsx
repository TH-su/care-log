// デイ（せせらぎ）の「今日」（記録ハブ →「デイ（せせらぎ）」／ルート /record/daycare）。2026-10-22 デイ段階1・代表承認。
//
// 一覧＝その日の予定（週間計画の写し・RPC daycare_plan。開所の後はその日の写し daycare_days）＋記録のある人＋予定外に足した人。
// 各行: 氏名・予定の時間・状態（予定○／在席●時刻／帰宅✓時刻／欠席✕理由）・次の操作（到着を記録／帰宅を記録）・欠席・
//       進み具合（バイタル・入浴）。到着の1タップで在席（代表者の回答 5.2 の8）。1タップの操作はトーストの「元に戻す」（8秒）。
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
  fetchAllResidents,
  cachedMyRole,
  daycareAutoColumnsSeen,
  fetchDaycareActivities,
  fetchBathDay,
  fetchDaycareAttendance,
  fetchDaycareDay,
  fetchDaycareIntake,
  fetchDaycarePlan,
  fetchDaycareVitals,
  fetchMyRole,
  fetchResidentTargets,
  fetchResidents,
  getAppSetting,
  getKindInputGate,
  hasPendingBath,
  hasPendingDaycareAttendance,
  insertBath,
  insertDaycareAttendance,
  isQueuePersisted,
  isSelfWrite,
  kindBlockedMessage,
  openDaycareDay,
  queuePending,
  queueSubscribe,
  recordAbsentBath,
  softDeleteDaycareAttendance,
  subscribeBathChanges,
  subscribeChanges,
  subscribeDaycareActivityChanges,
  subscribeDaycareChanges,
  subscribeMyRole,
  updateBath,
  updateDaycareAttendance,
} from '../lib/db'
import type { AbsentBathResult, DaycareMealRow, MyRole } from '../lib/db'
import { lunchLabel, personPath } from '../lib/daycarePerson'
import type { DaycareActivity } from '../lib/daycareActivity'
import { RecorderBar } from '../components/RecorderBar'
import { ConfirmDialog, ErrorBlock, LoadingBlock, ModalShell, ResidentPickerModal, useToast } from '../components/ui'
import {
  attendanceState,
  bathCountsUnchecked,
  buildDaycareBoard,
  canChangeDaycareTimes,
  canEditPastDaycareTimes,
  daycareBathLabel,
  daycareBathShortLabel,
  daycareBathStatus,
  fmtPlanTimes,
  hasManualTimes,
  hmOf,
  isAutoOnlyAttendance,
  nowHm,
  planHm,
  validateAttendance,
  vitalNeedsRecheck,
} from '../lib/daycare'
import type { DaycareBoardRow, KeyedVital } from '../lib/daycare'
import { useVitalLimits } from '../hooks/useVitalLimits'
import { VitalLimitsFailedNote } from '../components/VitalLimitsFailedNote'
import { resultForBathed } from '../lib/bath'
import { addDays, fmtDayLabel, todayIso } from '../lib/format'
import { BATH_CANCEL_REASON_LABEL, BATH_RESULT_LABEL, DAYCARE_ABSENT_REASONS, DAYCARE_ABSENT_REASON_LABEL } from '../lib/types'
import type {
  BathCancelReason,
  BathRecord,
  FluidIntake,
  BathResult,
  DaycareAbsentReason,
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
const MSG_CONFLICT = '他の端末が先にこの方の記録を保存・変更しました。最新の内容に読み直しました。確かめてから、もう一度押してください。'
const MSG_QUEUED = '電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度押してください。'
const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから記録してください。'
const MSG_ROW_PENDING = '未送信の記録があります（送信が終わると押せるようになります）'
const MSG_FUTURE = '未来の日には記録できません。'
/** 過去の日の到着・帰宅の時刻は事務所のログインだけ（代表者の決定 2026-10-22・移行 0042 のトリガも同じ規則） */
const MSG_PAST_TIME =
  '過去の日の到着・帰宅の時刻は、事務所のログインで入力・修正します（現場の端末は当日だけ）。休み・入浴は記録できます。時刻は事務所に伝えてください。'
/** 時刻の入った方の過去の日の休み・帰宅の取り消し（時刻を消すため事務所だけ） */
const MSG_PAST_TIME_CLEAR =
  '過去の日に、到着・帰宅の時刻が入っている方を休みにする・帰宅を取り消すのは、事務所のログインで行います（時刻を消すため）。'
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
  /** 昼食・おやつ（取り込みの印つき）と水分（段階2a・行の小さな印と1人の記録への入口に使う） */
  meals: DaycareMealRow[]
  fluids: FluidIntake[]
  /** 活動・レク（段階2b・行の小さな印）。null＝読めない（0044 未適用・通信エラー）＝印を出さない（「記録なし」に見せない） */
  activities: DaycareActivity[] | null
}

type RowMsg = { tone: 'warn' | 'danger' | 'info' | 'ok'; text: string }

/** 状態の表示（記号＋文字＋時刻。色だけに頼らない） */
/**
 * 一覧の1行（代表者の決定 2026-10-23・1人1行）: 広い画面は 氏名・予定｜到着｜帰宅｜入浴｜昼食｜バイタル｜休み の表、
 * 狭い画面は氏名の下に残りを折り返す（横に動かす表にはしない）。切り替えの幅と列は src/index.css の .dc-row（em で決める＝
 * 利用者が文字を大きくした端末では折り返す形に戻り、氏名の列がつぶれない）
 */
/** 一覧の欄のボタン（押せる範囲 44px・角は 6px） */
const CELL_BTN =
  'inline-flex min-h-tap min-w-tap items-center justify-center rounded border border-border-strong bg-surface px-2 text-base text-ink disabled:text-ink3'
const DANGER_CELL_BTN =
  'inline-flex min-h-tap min-w-tap items-center justify-center rounded border border-danger bg-surface px-2 text-base text-danger disabled:border-border disabled:text-ink3'
const PRIMARY_CELL_BTN =
  'inline-flex min-h-tap min-w-tap items-center justify-center rounded border border-primary bg-primary px-3 text-base font-bold text-primary-ink disabled:border-border disabled:bg-surface2 disabled:text-ink3'
/** 〔休み〕は押しやすく（右端にそろえ、幅をそろえる＝代表者の要望） */
const REST_BTN =
  'inline-flex min-h-tap min-w-[5rem] items-center justify-center rounded border-2 border-border-strong bg-surface px-3 text-base font-bold text-ink disabled:border-border disabled:text-ink3'

function stateLabel(row: DaycareBoardRow): { mark: string; text: string; tone: 'plain' | 'ok' | 'info' | 'muted' } {
  const a = row.attendance
  if (row.state === 'absent') {
    const reason = a?.absent_reason ? DAYCARE_ABSENT_REASON_LABEL[a.absent_reason] : '理由なし'
    return { mark: '✕', text: `休み（${reason}）`, tone: 'muted' }
  }
  if (row.state === 'left') return { mark: '✓', text: `帰宅 ${hmShort(a?.left_at ?? null)}`, tone: 'muted' }
  if (row.state === 'present') return { mark: '●', text: `在席 ${hmShort(a?.arrived_at ?? null)}`, tone: 'ok' }
  if (row.hospitalized) return { mark: '－', text: '入院中', tone: 'muted' }
  return { mark: '○', text: row.extra ? '予定外' : '予定', tone: 'plain' }
}

function hmShort(t: string | null): string {
  if (t === null) return ''
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  return m === null ? '' : `${Number(m[1])}:${m[2]}`
}

/** デイの画面の上の切り替え（今日／バイタル／活動）。今いる画面は塗りと aria-current で示す */
export function DaycareNav({ current }: { current: 'today' | 'vitals' | 'activity' | 'training' }) {
  const items: { key: 'today' | 'vitals' | 'activity' | 'training'; to: string; label: string }[] = [
    { key: 'today', to: '/record/daycare', label: '今日（到着・休み）' },
    { key: 'vitals', to: '/record/daycare/vitals', label: 'バイタル一括' },
    // 段階2b（2026-10-22）: 活動・レクをまとめて記録
    { key: 'activity', to: '/record/daycare/bulk', label: '活動をまとめて' },
    // 段階3a（2026-10-23）: 個別機能訓練（配置と実施記録）
    { key: 'training', to: '/record/daycare/training', label: '機能訓練' },
  ]
  return (
    <nav aria-label="デイの画面" className="flex flex-wrap gap-gap print:hidden">
      {items.map((it) => (
        <Link
          key={it.key}
          to={it.to}
          aria-current={current === it.key ? 'page' : undefined}
          className={
            current === it.key
              ? 'flex min-h-tap items-center rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink'
              : 'flex min-h-tap items-center rounded border border-border-strong bg-surface px-4 text-base text-ink'
          }
        >
          {current === it.key ? <span aria-hidden="true">✓ </span> : null}
          {it.label}
        </Link>
      ))}
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
        <span aria-hidden="true">▲ </span>予定を確かめられません（週間計画の写しが読めません）。「予定なし」ではありません。来所した方は〔予定にない方を追加〕から記録できます。
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
        <span aria-hidden="true">▲ </span>週間計画と照合できない予定 {unconfirmed} 件（氏名の食い違いなど）。事務所で週間計画を確かめてください。来所した方は〔予定にない方を追加〕から記録できます。
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
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [rowMsg, setRowMsg] = useState<Map<number, RowMsg>>(new Map())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [absentFor, setAbsentFor] = useState<DaycareBoardRow | null>(null)
  /** 入浴の区分・中止を選ぶ小窓の対象 */
  const [bathFor, setBathFor] = useState<DaycareBoardRow | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; danger?: boolean; run: () => void } | null>(null)
  /** ログインの役割（事務所・管理者だけ過去の日の到着・帰宅の時刻を入れられる。分からない間は現場と同じ扱い） */
  const [role, setRole] = useState<MyRole | null | undefined>(cachedMyRole())
  /** 時刻を入れる・直す小窓（事務所のログイン）。arrive＝到着を記録・leave＝帰宅を記録・fix＝時刻を直す */
  const [timeFor, setTimeFor] = useState<{ row: DaycareBoardRow; mode: 'arrive' | 'leave' | 'fix' } | null>(null)
  const [timeArr, setTimeArr] = useState('')
  const [timeLeft, setTimeLeft] = useState('')
  const [timeErr, setTimeErr] = useState<string | null>(null)
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

  // ── 名簿・個別の目標・休業日（1回） ──
  useEffect(() => {
    let alive = true
    Promise.all([fetchAllResidents(), fetchResidents(), fetchResidentTargets().catch(() => new Map<number, ResidentTargets>()), getAppSetting('daycare_closed_dates').catch(() => null)])
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
      let snapshot: DaycareDay | null = null
      let missing = false
      try {
        snapshot = await fetchDaycareDay(target)
      } catch (e) {
        if (e instanceof DbError && e.kind === 'server') missing = true
        else throw e
      }
      // 写しが「読めなかった」（unknown）の日は、いまの週間計画も読む（読めれば表示に使い、次のタップで写し直す＝反証レビュー中2）
      const usable = snapshot !== null && snapshot.plan_source !== 'unknown'
      const [plan, attendance, baths, dv, intake] = await Promise.all([
        usable ? Promise.resolve(null) : fetchDaycarePlan(target),
        missing ? Promise.resolve([] as DaycareAttendance[]) : fetchDaycareAttendance(target),
        fetchBathDay(target).catch(() => [] as BathRecord[]),
        fetchDaycareVitals(target).catch(() => ({ live: [] as KeyedVital[], keys: [] as string[] })),
        fetchDaycareIntake(target).catch(() => ({ meals: [] as DaycareMealRow[], fluids: [] as FluidIntake[] })),
      ])
      const activities = await fetchDaycareActivities(target).catch(() => null)
      if (gen !== genRef.current || target !== dayRef.current) return
      const next: DayData = {
        day: target,
        planRows: usable && snapshot !== null ? snapshot.plan_rows : (plan?.rows ?? []),
        planSource: usable && snapshot !== null ? snapshot.plan_source : (plan?.source ?? 'unknown'),
        snapshot,
        missing: missing || plan?.missing === true,
        attendance,
        baths,
        vitals: dv.live,
        meals: intake.meals,
        fluids: intake.fluids,
        activities,
      }
      setData(next)
      setError(null)
    } catch {
      if (gen !== genRef.current) return
      if (!quiet) setError(ERR_LOAD)
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setExtraIds([])
    setRowMsg(new Map())
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

  // ── 一覧 ──
  const board = useMemo(
    () =>
      data === null
        ? null
        : buildDaycareBoard({ planRows: data.planRows, source: data.planSource, residents, attendance: data.attendance, extraIds }),
    [data, residents, extraIds],
  )
  const nameOf = useCallback(
    (id: number) => residents.find((r) => r.id === id)?.name ?? `利用者ID ${id}`,
    [residents],
  )
  const bathOf = useCallback((id: number) => data?.baths.find((b) => b.resident_id === id) ?? null, [data])
  /** 段階2a: 行の昼食の欄。水分・活動の札は 1人1行にした時に一覧から外し、1人の記録の画面で見る（代表者の回答 A3・2026-10-23） */
  const lunchOf = (id: number) => data?.meals.find((m) => m.meal.resident_id === id && m.meal.meal_slot === 'lunch')?.meal ?? null
  const vitalsOf = useCallback((id: number) => (data?.vitals ?? []).filter((v) => v.resident_id === id), [data])

  const canWrite = gate !== null && gate.observed && gate.value === true && !(data?.missing ?? false)
  const isFuture = day > today

  const setMsg = (id: number, m: RowMsg | null) =>
    setRowMsg((prev) => {
      const next = new Map(prev)
      if (m === null) next.delete(id)
      else next.set(id, m)
      return next
    })
  const setRowBusy = (id: number, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

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

  /** 書き込みの前の確かめ（記録者・旗・日付・未送信）。通らなければ理由を行に出して false */
  const precheck = (row: DaycareBoardRow): boolean => {
    if (!canWrite) {
      setMsg(row.residentId, { tone: 'warn', text: gate?.forbidden ? FORBIDDEN_REASON : gate?.outdated ? OUTDATED_REASON : kindBlockedMessage('daycare') })
      return false
    }
    if (isFuture) {
      setMsg(row.residentId, { tone: 'warn', text: MSG_FUTURE })
      return false
    }
    if (actorId === null) {
      setMsg(row.residentId, { tone: 'warn', text: MSG_NO_RECORDER })
      return false
    }
    if (hasPendingDaycareAttendance(row.residentId, day, row.attendance?.id ?? null)) {
      setMsg(row.residentId, { tone: 'info', text: MSG_ROW_PENDING })
      return false
    }
    return true
  }

  /** 保存の結果を行へ（読み直し・案内）。成功は true */
  const afterWrite = (id: number, r: DaycareAttendance | 'conflict' | 'queued'): boolean => {
    if (r === 'conflict') {
      setMsg(id, { tone: 'warn', text: MSG_CONFLICT })
      scheduleReload()
      return false
    }
    if (r === 'queued') {
      setMsg(id, { tone: 'info', text: isQueuePersisted() ? MSG_QUEUED : MSG_NOT_PERSISTED })
      return true
    }
    setData((prev) => {
      if (prev === null || prev.day !== r.day) return prev
      const others = prev.attendance.filter((a) => a.id !== r.id && a.resident_id !== r.resident_id)
      return { ...prev, attendance: [...others, r] }
    })
    setMsg(id, null)
    return true
  }

  /**
   * 失敗の文言。timesTouched＝到着・帰宅の時刻を変える書き込み（到着・帰宅・時刻を消す欠席・取り消し）。過去の日のその書き込みが
   * DB（0042 のトリガ）で止まった時だけ「このアカウントでは使えません」ではなく「時刻は事務所で」と出す（入浴など時刻と関係ない
   * 書き込みの拒否は今までどおりの文言＝反証レビュー4巡目 F7）
   */
  const errText = (e: unknown, timesTouched = false) => {
    if (timesTouched && e instanceof DbError && e.kind === 'forbidden' && dayRef.current < todayIso()) return MSG_PAST_TIME
    return e instanceof DbError ? e.message : '保存できませんでした。通信状態を確認して、もう一度押してください。'
  }
  /** その書き込みで到着・帰宅の時刻が変わるか（いまの行と比べる。時刻の無い方の欠席は変わらない） */
  const touchesTimes = (patch: Partial<Pick<DaycareAttendance, 'arrived_at' | 'left_at'>>, cur: DaycareAttendance | null) =>
    (patch.arrived_at !== undefined && hmOf(patch.arrived_at) !== hmOf(cur?.arrived_at ?? null)) ||
    (patch.left_at !== undefined && hmOf(patch.left_at) !== hmOf(cur?.left_at ?? null))

  /** 到着の時刻・帰宅の時刻・欠席を書く（行が無ければ追加・あれば変えた列だけ）。戻り値は書いた後の行（送信待ち・競合は null） */
  const writeAttendance = async (
    row: DaycareBoardRow,
    patch: Partial<Pick<DaycareAttendance, 'arrived_at' | 'left_at' | 'absent' | 'absent_reason'>>,
  ): Promise<DaycareAttendance | null | 'failed'> => {
    const id = row.residentId
    try {
      await ensureOpened()
      const cur = row.attendance
      const r =
        cur === null
          ? await insertDaycareAttendance({
              resident_id: id,
              day,
              arrived_at: patch.arrived_at ?? null,
              left_at: patch.left_at ?? null,
              absent: patch.absent ?? false,
              absent_reason: patch.absent_reason ?? null,
              note: null,
              recorded_by: actorId,
            })
          : await updateDaycareAttendance(cur, patch, { editedBy: actorId })
      const ok = afterWrite(id, r)
      if (!ok) return 'failed'
      return r === 'queued' ? null : (r as DaycareAttendance)
    } catch (e) {
      setMsg(id, { tone: 'danger', text: errText(e, touchesTimes(patch, row.attendance)) })
      return 'failed'
    }
  }

  // ── 到着（＝在席） ──
  const onArrive = async (row: DaycareBoardRow) => {
    if (!precheck(row)) return
    if (day !== todayIso()) {
      // 過去の日: 事務所のログインは時刻を入れる小窓（予定の開始を初めの値に）。現場は止める
      if (canEditPastDaycareTimes(role)) openTime(row, 'arrive')
      else setMsg(row.residentId, { tone: 'warn', text: MSG_PAST_TIME })
      return
    }
    setRowBusy(row.residentId, true)
    const t = nowHm()
    const res = await writeAttendance(row, { arrived_at: t, left_at: null, absent: false, absent_reason: null })
    setRowBusy(row.residentId, false)
    if (res === 'failed') return
    show(`${nameOf(row.residentId)}さんの到着を記録しました（${hmShort(t)}・在席）`, res === null ? undefined : () => void undo(res, { arrived_at: null }))
  }

  // ── 帰宅 ──
  const onLeave = async (row: DaycareBoardRow) => {
    if (!precheck(row)) return
    if (day !== todayIso()) {
      if (canEditPastDaycareTimes(role)) openTime(row, 'leave')
      else setMsg(row.residentId, { tone: 'warn', text: MSG_PAST_TIME })
      return
    }
    setRowBusy(row.residentId, true)
    const t = nowHm()
    const res = await writeAttendance(row, { left_at: t })
    setRowBusy(row.residentId, false)
    if (res === 'failed') return
    show(`${nameOf(row.residentId)}さんの帰宅を記録しました（${hmShort(t)}）`, res === null ? undefined : () => void undo(res, { left_at: null }))
  }

  /** 元に戻す（トーストから・rev 照合。他の端末が先に変えていたら読み直して知らせる） */
  const undo = async (row: DaycareAttendance, patch: Partial<Pick<DaycareAttendance, 'arrived_at' | 'left_at' | 'absent' | 'absent_reason'>>) => {
    try {
      const r = await updateDaycareAttendance(row, patch, { editedBy: actorId })
      afterWrite(row.resident_id, r)
    } catch (e) {
      setMsg(row.resident_id, { tone: 'danger', text: errText(e, touchesTimes(patch, row)) })
    }
  }

  // ── 欠席（理由を選んだ時点で記録） ──
  const onAbsentPick = async (row: DaycareBoardRow, reason: DaycareAbsentReason) => {
    setAbsentFor(null)
    if (!precheck(row)) return
    setRowBusy(row.residentId, true)
    // 元に戻す時に到着・帰宅の時刻も戻す（欠席は時刻を消すため＝反証レビュー軽8）
    const prev = row.attendance
    const res = await writeAttendance(row, { absent: true, absent_reason: reason, arrived_at: null, left_at: null })
    if (res === 'failed') {
      setRowBusy(row.residentId, false)
      return
    }
    const bath = await recordAbsentBath({ residentId: row.residentId, day, bathingPlanned: row.bathingPlanned, recordedBy: actorId })
    setRowBusy(row.residentId, false)
    afterAbsentBath(row, bath)
    const bathTouched = bath.status === 'done' || bath.status === 'queued' || bath.status === 'already'
    show(
      `${nameOf(row.residentId)}さんを休みにしました（${DAYCARE_ABSENT_REASON_LABEL[reason]}）`,
      res === null ? undefined : () => void undoAbsent(res, prev, bathTouched),
    )
    scheduleReload()
  }

  const afterAbsentBath = (row: DaycareBoardRow, r: AbsentBathResult) => {
    const id = row.residentId
    if (r.status === 'needsConfirm') {
      setConfirm({
        title: '入浴の記録を直しますか',
        body: `${nameOf(id)}さんには「入浴した」の記録があります。休みにすると、入浴の記録を「入浴していない（欠席）」に直します。`,
        label: '入浴の記録を直す',
        run: () => {
          setConfirm(null)
          void (async () => {
            setRowBusy(id, true)
            const again = await recordAbsentBath({ residentId: id, day, bathingPlanned: row.bathingPlanned, recordedBy: actorId, confirmManual: true })
            setRowBusy(id, false)
            afterAbsentBath(row, again)
            scheduleReload()
          })()
        },
      })
      return
    }
    if (r.status === 'blocked') setMsg(id, { tone: 'warn', text: `休みは記録しました。入浴の記録は直していません（${r.message}）` })
    else if (r.status === 'conflict') setMsg(id, { tone: 'warn', text: '休みは記録しました。入浴の記録が他の端末で直されていたため、入浴の記録は直していません。入浴の画面で確かめてください。' })
    else if (r.status === 'queued') setMsg(id, { tone: 'info', text: `休みは記録しました。入浴の「入浴していない（欠席）」は${MSG_QUEUED}` })
    else if (r.status === 'kept') setMsg(id, { tone: 'info', text: '休みは記録しました。入浴は「入浴していない」の記録があるので、そのままにしました。' })
  }

  const undoAbsent = async (row: DaycareAttendance, prev: DaycareAttendance | null, bathTouched: boolean) => {
    await undo(row, { absent: false, absent_reason: null, arrived_at: prev?.arrived_at ?? null, left_at: prev?.left_at ?? null })
    if (bathTouched) {
      setMsg(row.resident_id, {
        tone: 'info',
        text: '休みを取り消しました。入浴の記録は「入浴していない（欠席）」のままです。入浴した場合は、行の入浴の欄から記録し直してください。',
      })
    }
    scheduleReload()
  }

  /** 欠席を取り消した後: 入浴の「中止・欠席」は消さずに案内する */
  const noteBathAfterAbsentCancel = (id: number) => {
    const b = bathOf(id)
    if (b !== null && b.result === 'cancel' && b.cancel_reason === 'absent') {
      setMsg(id, { tone: 'info', text: '休みを取り消しました。入浴の記録は「入浴していない（欠席）」のままです。入浴した場合は、行の入浴の欄から記録し直してください。' })
    }
  }

  /** 欠席の方に入浴の記録（自動・人の入浴）が残っている時、入浴を「中止・欠席」に直す（人の入浴は確認つき） */
  const onAbsentBathFix = async (row: DaycareBoardRow) => {
    if (!precheck(row)) return
    setRowBusy(row.residentId, true)
    const r = await recordAbsentBath({ residentId: row.residentId, day, bathingPlanned: true, recordedBy: actorId })
    setRowBusy(row.residentId, false)
    afterAbsentBath(row, r)
    scheduleReload()
  }

  const askAbsent = (row: DaycareBoardRow) => {
    if (!precheck(row)) return
    if (hasTimes(row) && !canChangeDaycareTimes(day, todayIso(), role)) {
      setMsg(row.residentId, { tone: 'warn', text: MSG_PAST_TIME_CLEAR })
      return
    }
    setAbsentFor(row)
  }

  // ── 休みの1タップ（代表者の決定 2026-10-23: 〔休み〕を押すだけで理由「後で」の休み。理由は行から後で選ぶ） ──
  // ・自動の到着・帰宅（0047）の後でも、時刻を消して休みにする（確かめは挟まない）。人が入れた時刻がある方だけ確かめを挟む
  // ・入浴は既存の recordAbsentBath で「中止（欠席）」に直す。直後の〔元に戻す〕は全部を元どおりにする（決定 4）
  // ・0047 を当てる前の DB（自動の印の列を読めない）は「後で」を受け付けないので、理由を選ぶ小窓にする（能力の観測）
  const onRest = (row: DaycareBoardRow) => {
    if (!precheck(row)) return
    if (hasTimes(row) && !canChangeDaycareTimes(day, todayIso(), role)) {
      setMsg(row.residentId, { tone: 'warn', text: MSG_PAST_TIME_CLEAR })
      return
    }
    if (daycareAutoColumnsSeen() !== true) {
      setAbsentFor(row)
      return
    }
    const a = row.attendance
    if (a !== null && hasManualTimes(a)) {
      setConfirm({
        title: '休みにしますか',
        body: `${nameOf(row.residentId)}さんの到着${a.left_at !== null ? '・帰宅' : ''}の記録（${hmShort(a.arrived_at)}${a.left_at !== null ? `〜${hmShort(a.left_at)}` : ''}）を取り消して休みにします。`,
        label: '休みにする',
        danger: true,
        run: () => {
          setConfirm(null)
          void restNow(row)
        },
      })
      return
    }
    void restNow(row)
  }

  const restNow = async (row: DaycareBoardRow) => {
    const id = row.residentId
    const patch = { absent: true, absent_reason: 'later' as const, arrived_at: null, left_at: null }
    const prevBath = bathOf(id)
    setRowBusy(id, true)
    let before: DaycareAttendance | null = row.attendance
    let saved: DaycareAttendance | null
    try {
      await ensureOpened()
      let r =
        before === null
          ? await insertDaycareAttendance({ resident_id: id, day, ...patch, note: null, recorded_by: actorId })
          : await updateDaycareAttendance(before, patch, { editedBy: actorId })
      if (r === 'conflict' && before === null) {
        // 押した瞬間に定時の処理の自動の到着が先に入った: 読み直し、人が手を入れていない自動の行ならそのまま休みに直す
        const now = (await fetchDaycareAttendance(day)).find((x) => x.resident_id === id) ?? null
        if (now !== null && isAutoOnlyAttendance(now)) {
          before = now
          r = await updateDaycareAttendance(now, patch, { editedBy: actorId })
        }
      }
      if (!afterWrite(id, r)) {
        setRowBusy(id, false)
        return
      }
      saved = r === 'queued' ? null : (r as DaycareAttendance)
    } catch (e) {
      setMsg(id, { tone: 'danger', text: errText(e, touchesTimes(patch, before)) })
      setRowBusy(id, false)
      return
    }
    const bath = await recordAbsentBath({ residentId: id, day, bathingPlanned: row.bathingPlanned, recordedBy: actorId })
    setRowBusy(id, false)
    afterAbsentBath(row, bath)
    show(
      `${nameOf(id)}さんを休みにしました（理由は行の〔理由〕から選べます）`,
      saved === null ? undefined : () => void undoRest(row, saved, before, prevBath, bath),
    )
    scheduleReload()
  }

  /**
   * 休みの直後の〔元に戻す〕（決定 4: 全部を元どおり）。到着・帰宅の時刻と自動の印を戻す（もともと定時の処理が入れた行を元の形に
   * 戻すだけ）。押す前に行が無かった方は行を取り消して「行が無い」形に戻す（定時の処理がその後も到着を入れる）。
   * 入浴は（代表者の回答 A5）、休みで「中止（欠席）」にした行を 12:30 の自動と同じ区分に戻す: 自動の行を直していた時は元の区分、
   * 休みで新しく作った行は休業日なら訪問介護で入浴・それ以外は全身浴。ただし自動の印は付けない（0015 からの決まり「端末は
   * 自動の記録を作らない」＝tests/med.test.mjs を守る）ので、画面は人の記録と同じ「✓ 全身浴」と出る。
   * 人が入れた入浴の行は休みで直していない（確認を挟む）ので触らない
   */
  const undoRest = async (row: DaycareBoardRow, saved: DaycareAttendance, before: DaycareAttendance | null, prevBath: BathRecord | null, bath: AbsentBathResult) => {
    const id = row.residentId
    try {
      const r =
        before === null
          ? await softDeleteDaycareAttendance(saved, { editedBy: actorId })
          : await updateDaycareAttendance(
              saved,
              {
                absent: before.absent,
                absent_reason: before.absent ? before.absent_reason : null,
                arrived_at: before.arrived_at,
                left_at: before.left_at,
                arrived_auto: before.arrived_auto === true,
                left_auto: before.left_auto === true,
              },
              { editedBy: actorId },
            )
      if (r === 'conflict') {
        setMsg(id, { tone: 'warn', text: MSG_CONFLICT })
        scheduleReload()
        return
      }
      if (r !== true) afterWrite(id, r)
      else
        setData((prev) => (prev === null || prev.day !== saved.day ? prev : { ...prev, attendance: prev.attendance.filter((a) => a.id !== saved.id) }))
    } catch (e) {
      setMsg(id, { tone: 'danger', text: errText(e, true) })
      return
    }
    if (bath.status === 'done' && (prevBath === null || (prevBath.auto && prevBath.result !== 'cancel'))) {
      const back: 'full' | 'visit' =
        prevBath !== null && (prevBath.result === 'full' || prevBath.result === 'visit') ? prevBath.result : resultForBathed(day, closedDates) === 'visit' ? 'visit' : 'full'
      try {
        const b =
          bath.record.result === 'cancel' && bath.record.cancel_reason === 'absent'
            ? await updateBath(bath.record, { result: back, cancel_reason: null }, { editedBy: actorId })
            : null
        if (b === 'conflict') setMsg(id, { tone: 'warn', text: '休みは取り消しました。入浴の記録が他の端末で直されていたため、入浴は戻していません。入浴の欄で確かめてください。' })
      } catch (e) {
        setMsg(id, { tone: 'warn', text: `休みは取り消しました。入浴の記録は「入浴していない（欠席）」のままです（${errText(e)}）。入浴の欄から直してください。` })
      }
    }
    scheduleReload()
  }

  /** 休みの理由を後から選ぶ（「後で」の休みの行から）。休みのまま理由だけを変える */
  const onReasonPick = async (row: DaycareBoardRow, reason: DaycareAbsentReason) => {
    setAbsentFor(null)
    const a = row.attendance
    if (!precheck(row) || a === null || !a.absent) return
    setRowBusy(row.residentId, true)
    try {
      const r = await updateDaycareAttendance(a, { absent_reason: reason }, { editedBy: actorId })
      if (afterWrite(row.residentId, r) && r !== 'queued') {
        show(`${nameOf(row.residentId)}さんの休みの理由を記録しました（${DAYCARE_ABSENT_REASON_LABEL[reason]}）`)
      }
    } catch (e) {
      setMsg(row.residentId, { tone: 'danger', text: errText(e) })
    } finally {
      setRowBusy(row.residentId, false)
    }
  }

  /** 到着・帰宅の時刻が入っているか（欠席にする・取り消すと時刻を消す） */
  const hasTimes = (row: DaycareBoardRow) => row.attendance !== null && (row.attendance.arrived_at !== null || row.attendance.left_at !== null)

  // ── 時刻を入れる・直す（事務所のログイン・過去の日も） ──
  const openTime = (row: DaycareBoardRow, mode: 'arrive' | 'leave' | 'fix') => {
    const a = row.attendance
    const plan = row.plans[0] ?? null
    setTimeArr(hmOf(a?.arrived_at) ?? (mode === 'arrive' ? (planHm(plan?.start) ?? '') : ''))
    setTimeLeft(hmOf(a?.left_at) ?? (mode === 'leave' ? (planHm(row.plans[row.plans.length - 1]?.end) ?? '') : ''))
    setTimeErr(null)
    setTimeFor({ row, mode })
  }
  const saveTime = async () => {
    const t = timeFor
    if (t === null) return
    const arrived_at = timeArr === '' ? null : timeArr
    const left_at = timeLeft === '' ? null : timeLeft
    if (arrived_at === null) {
      setTimeErr('到着の時刻を入れてください。')
      return
    }
    const v = validateAttendance({ absent: false, absent_reason: null, arrived_at, left_at })
    if (!v.ok) {
      setTimeErr(v.message)
      return
    }
    if (!precheck(t.row)) {
      setTimeFor(null)
      return
    }
    setTimeFor(null)
    setRowBusy(t.row.residentId, true)
    const res = await writeAttendance(t.row, { arrived_at, left_at, absent: false, absent_reason: null })
    setRowBusy(t.row.residentId, false)
    if (res === 'failed') return
    const prev = t.row.attendance
    show(
      `${nameOf(t.row.residentId)}さんの時刻を記録しました（到着 ${hmShort(arrived_at)}${left_at !== null ? `・帰宅 ${hmShort(left_at)}` : ''}）`,
      res === null ? undefined : () => void undo(res, { arrived_at: prev?.arrived_at ?? null, left_at: prev?.left_at ?? null }),
    )
  }

  const askCancelAbsent = (row: DaycareBoardRow) => {
    if (!precheck(row) || row.attendance === null) return
    const a = row.attendance
    setConfirm({
      title: '休みを取り消しますか',
      body: `${nameOf(row.residentId)}さんの休みの記録を取り消して「予定」に戻します。到着は自動では戻りません（〔到着〕を押してください）。入浴の記録は消しません。`,
      label: '休みを取り消す',
      danger: true,
      run: () => {
        setConfirm(null)
        void (async () => {
          setRowBusy(row.residentId, true)
          await undo(a, { absent: false, absent_reason: null })
          setRowBusy(row.residentId, false)
          noteBathAfterAbsentCancel(row.residentId)
        })()
      },
    })
  }

  const askCancelLeave = (row: DaycareBoardRow) => {
    if (!precheck(row) || row.attendance === null) return
    if (!canChangeDaycareTimes(day, todayIso(), role)) {
      setMsg(row.residentId, { tone: 'warn', text: MSG_PAST_TIME_CLEAR })
      return
    }
    const a = row.attendance
    setConfirm({
      title: '帰宅の記録を取り消しますか',
      body: `${nameOf(row.residentId)}さんの帰宅（${hmShort(a.left_at)}）を取り消して「在席」に戻します。`,
      label: '帰宅を取り消す',
      danger: true,
      run: () => {
        setConfirm(null)
        void (async () => {
          setRowBusy(row.residentId, true)
          await undo(a, { left_at: null })
          setRowBusy(row.residentId, false)
        })()
      },
    })
  }

  // ── 入浴（既存の入浴記録 bath_records と insertBath／updateBath をそのまま使う） ──
  // 〔予定どおり実施〕: 記録が無ければ「全身浴」（休業日は訪問介護で入浴）を追加、自動の記録（確かめていない予定値）なら
  //   同じ区分のまま人の記録にする（updateBath が auto=false と記入者を一緒に送る＝確かめた印）。
  // 〔区分・中止を選ぶ〕: 全身浴・シャワー浴・部分浴・清拭・入浴していない（理由）。押し直しで直せる（取り消しは入浴の画面）。
  // cron（private.care_auto_bath_on）と input_enabled_bath は変えない
  const writeBath = async (row: DaycareBoardRow, result: BathResult, reason: BathCancelReason | null, word: string) => {
    if (!precheck(row)) return
    const id = row.residentId
    const cur = bathOf(id)
    if (hasPendingBath(id, day, cur?.id ?? null)) {
      setMsg(id, { tone: 'info', text: MSG_ROW_PENDING })
      return
    }
    setRowBusy(id, true)
    try {
      await ensureOpened()
      const cancel_reason = result === 'cancel' ? reason : null
      const r =
        cur === null
          ? await insertBath({ resident_id: id, bath_on: day, result, cancel_reason, note: null, recorded_by: actorId })
          : await updateBath(cur, { result, cancel_reason }, { editedBy: actorId })
      if (r === 'conflict') {
        setMsg(id, { tone: 'warn', text: MSG_CONFLICT })
        scheduleReload()
      } else if (r === 'queued') {
        setMsg(id, { tone: 'info', text: isQueuePersisted() ? MSG_QUEUED : MSG_NOT_PERSISTED })
      } else {
        setData((prev) => (prev === null || prev.day !== r.bath_on ? prev : { ...prev, baths: [...prev.baths.filter((b) => b.resident_id !== id), r] }))
        setMsg(id, null)
        show(`${nameOf(id)}さんの入浴を「${word}」で記録しました（直す時は行の入浴の欄を押してください）`)
      }
    } catch (e) {
      setMsg(id, { tone: 'danger', text: errText(e) })
    } finally {
      setRowBusy(id, false)
    }
  }

  /** 〔予定どおり実施〕（1タップ）。自動の記録は区分をそのままに人の記録へ、記録が無ければ全身浴（休業日は訪問介護で入浴） */
  const onBathAsPlanned = (row: DaycareBoardRow) => {
    const cur = bathOf(row.residentId)
    const result: BathResult = cur !== null && cur.auto && cur.result !== 'cancel' ? cur.result : resultForBathed(day, closedDates)
    void writeBath(row, result, null, `予定どおり実施（${BATH_RESULT_LABEL[result]}）`)
  }

  const onBathPick = (row: DaycareBoardRow, result: BathResult, reason: BathCancelReason | null) => {
    setBathFor(null)
    const word = result === 'cancel' ? `入浴していない（${reason === null ? '理由なし' : BATH_CANCEL_REASON_LABEL[reason]}）` : BATH_RESULT_LABEL[result]
    void writeBath(row, result, reason, word)
  }

  const addExtra = (id: number | null) => {
    setPickerOpen(false)
    if (id === null) return
    setExtraIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
  }

  // ── 描画 ──
  const header = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <DaycareNav current="today" />
        <RecorderBar actorId={actorId} staff={staff ?? null} />
      </div>
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
          <button type="button" onClick={() => setDay(today)} className="min-h-tap rounded border border-primary px-4 text-base font-bold text-primary">
            今日を開く
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setReloadKey((n) => n + 1)}
          className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink"
        >
          最新に更新
        </button>
      </div>
      {day < today ? (
        <p role="status" className="rounded-lg border border-border bg-surface2 p-3 text-sm text-ink2">
          {canEditPastDaycareTimes(role)
            ? '過去の日を表示しています。到着・帰宅は時刻を入れて記録します（事務所のログイン）。行の時刻を押すと直せます。'
            : '過去の日を表示しています。到着・帰宅の時刻は事務所のログインで入力・修正します。休み・入浴は記録できます（時刻が入っている方の休み・帰宅の取り消しは事務所）。'}
        </p>
      ) : null}
      {gate !== null && !(gate.observed && gate.value === true) ? (
        <p role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {gate.forbidden ? FORBIDDEN_REASON : gate.outdated ? OUTDATED_REASON : gate.observed ? `${kindBlockedMessage('daycare')}。記録の閲覧はできます。` : MSG_GATE_UNKNOWN}
        </p>
      ) : null}
    </div>
  )

  if (loading && data === null) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
        {header}
        <LoadingBlock label="デイの予定と記録を読み込んでいます…" />
      </div>
    )
  }
  if (error !== null && (data === null || data.day !== day)) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
        {header}
        <ErrorBlock message={error} onRetry={() => setReloadKey((n) => n + 1)} />
      </div>
    )
  }
  if (data === null || board === null) return null

  const c = board.counts
  const vitalsDone = (id: number) => vitalsOf(id).some((v) => v.temp !== null || v.sys_bp !== null || v.pulse !== null || v.spo2 !== null)
  const vitalsAbnormal = (id: number) => {
    const list = vitalsOf(id)
    const latest = list.length === 0 ? null : list.reduce((a, b) => (b.id > a.id ? b : a))
    return latest !== null && vitalNeedsRecheck(latest, targets.get(id), limits.lookup(id, data.day))
  }
  const vitalsWaiting = board.rows.filter((r) => r.state === 'present' && !vitalsDone(r.residentId)).length
  // 入浴を確かめていない方（代表者の決定 2026-10-23 の 3: 自動の行は「済」で数えない。12:30 を過ぎても行が無い方と、
  // 休みの方に自動の行が残っている方だけ＝daycare.ts の bathCountsUnchecked）
  const bathClock = { pastDay: data.day < today, nowHm: nowHm() }
  const bathUnchecked = board.rows.filter((r) => bathCountsUnchecked(daycareBathStatus(bathOf(r.residentId), r.bathingPlanned), r.state, bathClock)).length

  const tiles: { label: string; value: number; tone?: 'warn' }[] = [
    { label: '予定', value: c.planned },
    { label: '在席', value: c.present },
    { label: '帰宅', value: c.left },
    { label: '休み', value: c.absent },
    { label: '未到着', value: c.waiting },
    { label: 'バイタル未', value: vitalsWaiting, tone: vitalsWaiting > 0 ? 'warn' : undefined },
    { label: '入浴 未確認', value: bathUnchecked, tone: bathUnchecked > 0 ? 'warn' : undefined },
  ]

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
      {header}
      {limits.failed ? <VitalLimitsFailedNote className="" onRetry={() => void limits.refresh()} /> : null}
      <PlanBanners data={data} notInRoster={board.notInRoster} unconfirmed={board.unconfirmed} today={today} />

      {/* 件数の帯（1行に詰める＝代表者の要望 2026-10-23。注意の数は ▲ と太字と枠で示す＝色だけに頼らない） */}
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-surface px-3 py-2" aria-label="件数">
        {tiles.map((t) => (
          <li
            key={t.label}
            className={`inline-flex items-baseline gap-1 text-sm ${t.tone === 'warn' ? 'rounded border border-warn bg-warn-bg px-1 font-bold text-ink' : 'text-ink2'}`}
          >
            {t.tone === 'warn' ? <span aria-hidden="true">▲</span> : null}
            <span>{t.label}</span>
            <span className="font-num text-lg font-bold text-ink">{t.value}</span>
          </li>
        ))}
      </ul>

      {board.rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-base text-ink">
            {data.planSource === 'unknown'
              ? '予定を確かめられないため、一覧を出せません（「利用者なし」ではありません）。'
              : 'この日の予定・記録はまだありません。'}
          </p>
          <p className="mt-2 text-base text-ink2">来所した方は〔予定にない方を追加〕から到着を記録できます。</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          {/* 列の見出し（広い画面だけ。狭い画面は各欄に小さな見出しを出す） */}
          <div aria-hidden="true" className="dc-row-head border-b border-border px-3 py-2 text-sm font-bold text-ink2">
            <span>氏名・予定</span>
            <span>到着</span>
            <span>帰宅</span>
            <span>入浴</span>
            <span>昼食</span>
            <span>バイタル</span>
            <span className="text-right">休み</span>
          </div>
          <ul className="divide-y divide-border" aria-label="利用者の一覧">
            {board.rows.map((row) => {
              const pending = hasPendingDaycareAttendance(row.residentId, day, row.attendance?.id ?? null)
              const isBusy = busy.has(row.residentId) || pending
              const bath = bathOf(row.residentId)
              const bst = daycareBathStatus(bath, row.bathingPlanned)
              const m = rowMsg.get(row.residentId)
              const name = nameOf(row.residentId)
              const disabled = !canWrite || isFuture || isBusy
              /** 到着・帰宅の時刻を変える操作: 今日は誰でも・過去の日は事務所のログインだけ（現場は止める＝0042 と同じ規則） */
              const timesOk = canChangeDaycareTimes(day, today, role)
              const stampDisabled = disabled || !timesOk
              const rowHasTimes = hasTimes(row)
              const vDone = vitalsDone(row.residentId)
              const vAbn = vDone && vitalsAbnormal(row.residentId)
              const attended = row.state === 'present' || row.state === 'left'
              const a = row.attendance
              /** 時刻の欄（押すと直す小窓。押せない時は時刻だけ）。画面には「自動」の文字は出さない（代表者の指示 2026-10-23） */
              const timeCell = (t: string | null, which: '到着' | '帰宅') =>
                timesOk && !disabled ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (precheck(row)) openTime(row, 'fix')
                    }}
                    aria-label={`${name}さんの${which}の時刻（${hmShort(t)}）を直す`}
                    className={CELL_BTN}
                  >
                    <span className="font-num">{hmShort(t)}</span>
                  </button>
                ) : (
                  <span className="font-num text-base text-ink">{hmShort(t)}</span>
                )
              /** 休みの方に入浴の記録（自動・人の入浴）が残っている＝直す要る（▲ と注意の枠で示す。緑の「済」に見せない） */
              const absentBathLeft = row.state === 'absent' && (bst.kind === 'auto' || bst.kind === 'done')
              const bathCls = absentBathLeft
                ? 'border-2 border-warn bg-warn-bg font-bold text-ink'
                : bst.kind === 'todo'
                  ? 'border border-dashed border-border-strong text-ink'
                  : bst.kind === 'done' || bst.kind === 'auto'
                    ? 'border border-ok bg-ok-bg text-ink'
                    : 'border border-border bg-surface2 text-ink'
              const bathText = absentBathLeft ? `▲ ${daycareBathShortLabel(bst)}` : daycareBathShortLabel(bst)
              /** 入浴の欄を押せるか（在席・帰宅の方は区分・中止の小窓。休みの方は入浴の行が残っている時だけ「欠席」に直す小窓） */
              const bathTappable = attended || absentBathLeft
              return (
                <li key={row.residentId} className="px-3 py-2">
                  <div className="dc-row flex flex-wrap items-center gap-x-gap gap-y-2">
                    {/* 氏名・予定（押すと1人の記録へ） */}
                    <Link
                      to={personPath(row.residentId, day, today)}
                      className="flex min-h-tap min-w-0 basis-full flex-col justify-center rounded px-1 hover:bg-surface2"
                    >
                      <span className="truncate text-lg font-bold text-ink">
                        {name}
                        <span className="sr-only">さんの1日の記録を開く</span>
                      </span>
                      <span className="text-sm text-ink2">
                        {row.dup
                          ? '予定 要確認（週間計画にこの方の記録が2件あります）'
                          : row.planned
                            ? fmtPlanTimes(row.plans)
                            : '予定外の来所'}
                        {row.bathingPlanned ? '・入浴の予定あり' : ''}
                      </span>
                    </Link>

                    {row.state === 'absent' ? (
                      // 休みの方は到着・帰宅の2欄をまとめて状態を出す
                      <span className="inline-flex min-h-tap items-center text-base text-ink dc-span2">
                        <span aria-hidden="true">✕&nbsp;</span>
                        {stateLabel(row).text}
                      </span>
                    ) : (
                      <>
                        <span className="inline-flex items-center gap-1">
                          <span className="dc-cell-label text-sm text-ink2">到着</span>
                          {row.hospitalized && row.state === 'planned' ? (
                            <span className="text-base text-ink2">入院中</span>
                          ) : a?.arrived_at ? (
                            timeCell(a.arrived_at, '到着')
                          ) : (
                            <button
                              type="button"
                              onClick={() => void onArrive(row)}
                              disabled={stampDisabled}
                              aria-label={`${name}さんの到着を記録（在席にする）`}
                              className={PRIMARY_CELL_BTN}
                            >
                              到着
                            </button>
                          )}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <span className="dc-cell-label text-sm text-ink2">帰宅</span>
                          {row.state === 'present' ? (
                            <button
                              type="button"
                              onClick={() => void onLeave(row)}
                              disabled={stampDisabled}
                              aria-label={`${name}さんの帰宅を記録`}
                              className={PRIMARY_CELL_BTN}
                            >
                              帰宅
                            </button>
                          ) : row.state === 'left' ? (
                            timeCell(a?.left_at ?? null, '帰宅')
                          ) : (
                            <span className="text-base text-ink3" aria-label="帰宅はまだありません">—</span>
                          )}
                        </span>
                      </>
                    )}

                    {/* 入浴（押すと区分・中止の小窓） */}
                    <span className="inline-flex items-center gap-1">
                      <span className="dc-cell-label text-sm text-ink2">入浴</span>
                      {bst.kind === 'noPlan' && !attended ? (
                        <span className="text-base text-ink3">—</span>
                      ) : bathTappable ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (precheck(row)) setBathFor(row)
                          }}
                          disabled={disabled}
                          aria-label={
                            absentBathLeft
                              ? `${name}さんは休みですが入浴の記録（${daycareBathLabel(bst)}）が残っています。直す`
                              : `${name}さんの入浴（${daycareBathLabel(bst)}）の区分・中止を選ぶ`
                          }
                          className={`inline-flex min-h-tap items-center rounded px-2 text-base disabled:text-ink3 ${bathCls}`}
                        >
                          {bathText}
                        </button>
                      ) : (
                        <span className={`inline-flex min-h-tap items-center rounded px-2 text-base ${bathCls}`}>{bathText}</span>
                      )}
                    </span>

                    {/* 昼食（表示だけ。入力は1人の記録） */}
                    <span className="inline-flex items-center gap-1">
                      <span className="dc-cell-label text-sm text-ink2">昼食</span>
                      <span className="text-sm text-ink">{attended ? lunchLabel(lunchOf(row.residentId)) : '—'}</span>
                    </span>

                    {/* バイタル（押すとバイタル一括へ） */}
                    <span className="inline-flex items-center gap-1">
                      <span className="dc-cell-label text-sm text-ink2">バイタル</span>
                      {attended || vDone ? (
                        <Link
                          to="/record/daycare/vitals"
                          aria-label={`${name}さんのバイタル（${vAbn ? '要確認' : vDone ? '済' : '未'}）を一括の画面で入れる`}
                          className={`inline-flex min-h-tap items-center rounded px-2 text-base ${
                            vAbn ? 'border-2 border-warn bg-warn-bg text-ink' : vDone ? 'border border-ok bg-ok-bg text-ink' : 'border border-dashed border-border-strong text-ink'
                          }`}
                        >
                          <span className="font-bold">{vAbn ? '▲ 要確認' : vDone ? '✓ 済' : '— 未'}</span>
                        </Link>
                      ) : (
                        <span className="text-base text-ink3">—</span>
                      )}
                    </span>

                    {/* 休み（右端にそろえる） */}
                    <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-1">
                      {row.state === 'absent' ? (
                        <>
                          <button
                            type="button"
                            onClick={() => askAbsent(row)}
                            disabled={disabled}
                            aria-label={`${name}さんの休みの理由を選ぶ`}
                            className={CELL_BTN}
                          >
                            理由
                          </button>
                          <button
                            type="button"
                            onClick={() => askCancelAbsent(row)}
                            disabled={disabled}
                            aria-label={`${name}さんの休みを取り消す`}
                            className={DANGER_CELL_BTN}
                          >
                            取消
                          </button>
                        </>
                      ) : row.hospitalized && row.state === 'planned' ? null : (
                        <button
                          type="button"
                          onClick={() => onRest(row)}
                          disabled={disabled || (rowHasTimes && !timesOk)}
                          aria-label={`${name}さんを休みにする`}
                          className={REST_BTN}
                        >
                          休み
                        </button>
                      )}
                    </span>
                  </div>

                  {pending ? (
                    <p className="mt-2 text-sm text-ink2" role="status">
                      <span aria-hidden="true">↻ </span>未送信の記録があります（電波が戻ると自動で送信します）
                    </p>
                  ) : null}
                  {m !== undefined ? (
                    <p
                      role={m.tone === 'danger' ? 'alert' : 'status'}
                      className={`mt-2 rounded border p-2 text-sm text-ink ${
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
        </div>
      )}

      <div className="flex flex-wrap gap-gap">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={!canWrite || isFuture}
          className="min-h-tap rounded border border-primary px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
        >
          ＋ 予定にない方を追加
        </button>
      </div>

      <ResidentPickerModal open={pickerOpen} residents={active} onPick={addExtra} onClose={() => setPickerOpen(false)} />

      <ModalShell open={absentFor !== null} label="休みの理由" onClose={() => setAbsentFor(null)}>
        {absentFor !== null ? (
          <div className="p-4">
            <h2 className="text-lg font-bold text-ink">休みの理由（{nameOf(absentFor.residentId)}さん）</h2>
            {attendanceState(absentFor.attendance) === 'present' ? (
              <p className="mt-2 text-base text-ink2">到着の記録（{hmShort(absentFor.attendance?.arrived_at ?? null)}）を取り消して休みにします。</p>
            ) : null}
            <p className="mt-2 text-sm text-ink2">
              {absentFor.attendance?.absent === true
                ? '理由を押すと、休みの理由を記録します。'
                : '理由を押すと休みを記録します（入浴の予定は「入浴していない（欠席）」になります）。'}
            </p>
            <ul className="mt-3 grid grid-cols-1 gap-gap sm:grid-cols-2">
              {DAYCARE_ABSENT_REASONS.map((r) => (
                <li key={r}>
                  <button
                    type="button"
                    onClick={() => void (absentFor.attendance?.absent === true ? onReasonPick(absentFor, r) : onAbsentPick(absentFor, r))}
                    className="min-h-14 w-full rounded border border-border-strong bg-surface px-4 text-lg text-ink"
                  >
                    {DAYCARE_ABSENT_REASON_LABEL[r]}
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={() => setAbsentFor(null)} className="min-h-tap rounded border border-border-strong px-4 text-base text-ink">
                キャンセル
              </button>
            </div>
          </div>
        ) : null}
      </ModalShell>

      <ModalShell open={timeFor !== null} label="到着・帰宅の時刻" onClose={() => setTimeFor(null)}>
        {timeFor !== null ? (
          <div className="p-4">
            <h2 className="text-lg font-bold text-ink">
              {timeFor.mode === 'arrive' ? '到着を記録' : timeFor.mode === 'leave' ? '帰宅を記録' : '時刻を直す'}（{nameOf(timeFor.row.residentId)}さん・{fmtDayLabel(day)}）
            </h2>
            <p className="mt-2 text-sm text-ink2">
              {day === today
                ? '到着・帰宅の時刻を入れます（遅れて来た日・早く帰った日は実際の時刻に直してください）。帰宅は空のままにできます。'
                : '到着・帰宅の時刻を入れます（事務所のログイン）。帰宅は空のままにできます。'}
            </p>
            <div className="mt-3 grid grid-cols-1 gap-gap sm:grid-cols-2">
              <label className="block text-base text-ink">
                到着の時刻
                <input
                  type="time"
                  step={60}
                  value={timeArr}
                  onChange={(e) => {
                    setTimeArr(e.target.value)
                    setTimeErr(null)
                  }}
                  className="mt-1 block min-h-tap w-full rounded border border-border-strong bg-surface px-3 text-lg text-ink"
                />
              </label>
              <label className="block text-base text-ink">
                帰宅の時刻
                <input
                  type="time"
                  step={60}
                  value={timeLeft}
                  onChange={(e) => {
                    setTimeLeft(e.target.value)
                    setTimeErr(null)
                  }}
                  className="mt-1 block min-h-tap w-full rounded border border-border-strong bg-surface px-3 text-lg text-ink"
                />
              </label>
            </div>
            {timeErr !== null ? (
              <p role="alert" className="mt-3 rounded border border-danger bg-danger-bg p-2 text-base text-ink">
                <span aria-hidden="true">▲ </span>
                {timeErr}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap justify-end gap-gap">
              {timeFor.mode === 'fix' && timeFor.row.attendance?.left_at ? (
                <button
                  type="button"
                  onClick={() => {
                    const r = timeFor.row
                    setTimeFor(null)
                    askCancelLeave(r)
                  }}
                  className="mr-auto min-h-tap rounded border border-danger px-4 text-base text-danger"
                >
                  帰宅を取り消す
                </button>
              ) : null}
              <button type="button" onClick={() => setTimeFor(null)} className="min-h-tap rounded border border-border-strong px-4 text-base text-ink">
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void saveTime()}
                className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
              >
                記録する
              </button>
            </div>
          </div>
        ) : null}
      </ModalShell>

      <ModalShell open={bathFor !== null} label="入浴の区分・中止" onClose={() => setBathFor(null)}>
        {bathFor !== null ? (
          <div className="p-4">
            <h2 className="text-lg font-bold text-ink">入浴の記録（{nameOf(bathFor.residentId)}さん）</h2>
            {attendanceState(bathFor.attendance) === 'absent' ? (
              <>
                <p className="mt-2 text-base text-ink">休みの方に入浴の記録が残っています。「入浴していない（欠席）」に直します。</p>
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => {
                      const r = bathFor
                      setBathFor(null)
                      void onAbsentBathFix(r)
                    }}
                    className="min-h-14 w-full rounded border border-primary bg-primary px-3 text-lg font-bold text-primary-ink"
                  >
                    入浴を「入浴していない（欠席）」にする
                  </button>
                </div>
              </>
            ) : (
              <>
            <p className="mt-2 text-sm text-ink2">押した区分で記録します（押し直すと直せます）。</p>
            {daycareBathStatus(bathOf(bathFor.residentId), bathFor.bathingPlanned).kind === 'todo' ? (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => {
                    const r = bathFor
                    setBathFor(null)
                    onBathAsPlanned(r)
                  }}
                  className="min-h-14 w-full rounded border border-primary bg-primary px-3 text-lg font-bold text-primary-ink"
                >
                  予定どおり実施
                </button>
              </div>
            ) : null}
            <h3 className="mt-3 text-base font-bold text-ink">入浴した</h3>
            <ul className="mt-2 grid grid-cols-1 gap-gap sm:grid-cols-3">
              {(['full', 'shower', 'partial'] as const).map((res) => (
                <li key={res}>
                  <button
                    type="button"
                    onClick={() => onBathPick(bathFor, res === 'full' ? resultForBathed(day, closedDates) : res, null)}
                    className="min-h-14 w-full rounded border border-primary bg-surface px-3 text-lg text-primary"
                  >
                    {BATH_RESULT_LABEL[res]}
                  </button>
                </li>
              ))}
            </ul>
            <h3 className="mt-4 text-base font-bold text-ink">入浴していない（中止の理由）</h3>
            <ul className="mt-2 grid grid-cols-1 gap-gap sm:grid-cols-2">
              {(['condition', 'refusal', 'facility', null] as const).map((rs) => (
                <li key={rs ?? 'none'}>
                  <button
                    type="button"
                    onClick={() => onBathPick(bathFor, 'cancel', rs)}
                    className="min-h-14 w-full rounded border border-border-strong bg-surface px-3 text-lg text-ink"
                  >
                    {rs === null ? '理由を選ばない' : BATH_CANCEL_REASON_LABEL[rs]}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-ink2">休みの時は、この小窓ではなく行の〔休み〕から記録してください（入浴も「入浴していない（欠席）」になります）。</p>
              </>
            )}
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={() => setBathFor(null)} className="min-h-tap rounded border border-border-strong px-4 text-base text-ink">
                キャンセル
              </button>
            </div>
          </div>
        ) : null}
      </ModalShell>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        body={confirm?.body}
        confirmLabel={confirm?.label}
        danger={confirm?.danger}
        onConfirm={() => confirm?.run()}
        onCancel={() => setConfirm(null)}
      />
      {toast}
    </div>
  )
}

export default DaycarePage
