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
  hasPendingDaycareAttendance,
  isSelfWrite,
  kindBlockedMessage,
  openDaycareDay,
  queuePending,
  queueSubscribe,
  subscribeBathChanges,
  subscribeChanges,
  subscribeDaycareActivityChanges,
  subscribeDaycareChanges,
  subscribeMyRole,
} from '../lib/db'
import type { DaycareMealRow, MyRole } from '../lib/db'
import { lunchShortLabel, personPath } from '../lib/daycarePerson'
import type { DaycareActivity } from '../lib/daycareActivity'
import { RecorderBar } from '../components/RecorderBar'
import { ErrorBlock, LoadingBlock, ResidentPickerModal, useToast } from '../components/ui'
import { hasTimes, hmShort, useDaycareAttendanceOps } from '../components/DaycareAttendanceOps'
import {
  bathCountsUnchecked,
  buildDaycareBoard,
  canChangeDaycareTimes,
  canEditPastDaycareTimes,
  daycareBathShortLabel,
  daycareBathStatus,
  fmtPlanTimes,
  nowHm,
  vitalNeedsRecheck,
} from '../lib/daycare'
import type { DaycareBoardRow, KeyedVital } from '../lib/daycare'
import { useVitalLimits } from '../hooks/useVitalLimits'
import { VitalLimitsFailedNote } from '../components/VitalLimitsFailedNote'
import { addDays, fmtDayLabel, todayIso } from '../lib/format'
import { DAYCARE_ABSENT_REASON_LABEL } from '../lib/types'
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
  /** 昼食・おやつ（取り込みの印つき）と水分（段階2a・行の小さな印と1人の記録への入口に使う） */
  meals: DaycareMealRow[]
  fluids: FluidIntake[]
  /** 活動・レク（段階2b・行の小さな印）。null＝読めない（0044 未適用・通信エラー）＝印を出さない（「記録なし」に見せない） */
  activities: DaycareActivity[] | null
}

/** カードの〔取消〕（押せる範囲 44px・角は 6px） */
const DANGER_CELL_BTN =
  'inline-flex min-h-tap min-w-tap items-center justify-center rounded border border-danger bg-surface px-2 text-base text-danger disabled:border-border disabled:text-ink3'
/** 〔休み〕は押しやすく（カードの右上にそろえ、幅をそろえる＝代表者の要望） */
const REST_BTN =
  'inline-flex min-h-tap min-w-[5rem] items-center justify-center rounded border-2 border-border-strong bg-surface px-3 text-base font-bold text-ink disabled:border-border disabled:text-ink3'

/** 状態の表示（記号＋文字＋時刻。色だけに頼らない） */
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

/** デイの画面の上の切り替え（今日／バイタル／食事／活動／機能訓練）。今いる画面は塗りと aria-current で示す */
export function DaycareNav({ current }: { current: 'today' | 'vitals' | 'meals' | 'activity' | 'training' }) {
  const items: { key: 'today' | 'vitals' | 'meals' | 'activity' | 'training'; to: string; label: string }[] = [
    { key: 'today', to: '/record/daycare', label: '今日（到着・休み）' },
    { key: 'vitals', to: '/record/daycare/vitals', label: 'バイタル一括' },
    // 今日の画面の改善 2回目（2026-10-24）: 昼食・おやつをまとめて入れる
    { key: 'meals', to: '/record/daycare/meals', label: '食事一括' },
    // 段階2b（2026-10-22）: 活動・レクをまとめて記録
    { key: 'activity', to: '/record/daycare/bulk', label: '活動一括' },
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
    putAttendance: (r) =>
      setData((prev) => {
        if (prev === null || prev.day !== r.day) return prev
        const others = prev.attendance.filter((a) => a.id !== r.id && a.resident_id !== r.resident_id)
        return { ...prev, attendance: [...others, r] }
      }),
    dropAttendance: (saved) =>
      setData((prev) => (prev === null || prev.day !== saved.day ? prev : { ...prev, attendance: prev.attendance.filter((a) => a.id !== saved.id) })),
    putBath: (r) =>
      setData((prev) => (prev === null || prev.day !== r.bath_on ? prev : { ...prev, baths: [...prev.baths.filter((b) => b.resident_id !== r.resident_id), r] })),
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
        // カード（2026-10-24 代表者の決定 §9.4 の1〜3）: 五十音の通しの並び（見出しなし）。カードを押すと1人の画面へ
        // （到着・帰宅・時刻の直し・休みの理由・入浴はそこで）。〔休み〕〔取消〕はリンクの外の別のボタン（入れ子にしない）。
        // 列の数は幅で自動（src/index.css の .dc-cards・タブレット横で4列）
        <ul className="dc-cards" aria-label="利用者の一覧">
          {board.rows.map((row) => {
            const pending = hasPendingDaycareAttendance(row.residentId, day, row.attendance?.id ?? null)
            const isBusy = ops.busy.has(row.residentId) || pending
            const bath = bathOf(row.residentId)
            const bst = daycareBathStatus(bath, row.bathingPlanned)
            const m = ops.rowMsg.get(row.residentId)
            const name = nameOf(row.residentId)
            const kana = kanaOf(row.residentId)
            const disabled = !canWrite || isFuture || isBusy
            /** 時刻の入った方を休みにする（時刻を消す）のは、今日は誰でも・過去の日は事務所のログインだけ（0042 と同じ規則） */
            const timesOk = canChangeDaycareTimes(day, today, role)
            const rowHasTimes = hasTimes(row)
            const vDone = vitalsDone(row.residentId)
            const vAbn = vDone && vitalsAbnormal(row.residentId)
            const attended = row.state === 'present' || row.state === 'left'
            const absent = row.state === 'absent'
            const a = row.attendance
            /** 休みの方に入浴の記録（自動・人の入浴）が残っている＝直す要る（▲ と注意の枠で示す。緑の「済」に見せない） */
            const absentBathLeft = absent && (bst.kind === 'auto' || bst.kind === 'done')
            const bathText = bst.kind === 'noPlan' && !attended ? '—' : daycareBathShortLabel(bst)
            const lunch = lunchOf(row.residentId)
            const planText = row.dup
              ? '予定 要確認（週間計画にこの方の記録が2件あります）'
              : row.plans.length > 1
                ? // 同じ方に同じ日の予定が2件＝データの誤り（代表者の回答 A2「そのような日はない」）。定時の処理も到着・帰宅を入れない
                  '予定 要確認（週間計画にこの方の予定が同じ日に2件あります）'
                : row.planned
                  ? `予定 ${fmtPlanTimes(row.plans)}`
                  : '予定外の来所'
            return (
              <li
                key={row.residentId}
                className={`dc-card relative flex min-w-0 flex-col gap-1 rounded-lg border p-3 ${absent ? 'border-border bg-surface2' : 'border-border-strong bg-surface'}`}
              >
                <div className="flex flex-wrap items-start gap-2">
                  {/* 氏名（押すと1人の記録へ。カード全体を押せる＝.dc-card-link の ::after）。長い氏名は切らずに折り返す。
                      カードが狭い時（拡大表示・大きな文字）は〔休み〕を氏名の下へ回す（氏名の幅を 5 文字分は残す） */}
                  <Link to={personPath(row.residentId, day, today)} className="dc-card-link min-w-[5em] flex-1 rounded">
                    <span className={`block break-words text-lg font-bold ${absent ? 'text-ink2' : 'text-ink'}`}>
                      {name}
                      <span className="sr-only">さんの1日の記録を開く</span>
                    </span>
                  </Link>
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
                {/* ふりがなは〔休み〕の下の幅いっぱいに出す（ボタンの横だと 1024px の4列で切れた） */}
                {kana !== null && kana !== '' ? <p className="break-words text-sm text-ink2">{kana}</p> : null}
                <p className="break-words text-sm text-ink2">
                  {planText}
                  {row.bathingPlanned ? '・入浴' : ''}
                </p>
                {absent ? (
                  <p className="text-base font-bold text-ink2">
                    <span aria-hidden="true">✕ </span>
                    {stateLabel(row).text}
                  </p>
                ) : row.hospitalized && row.state === 'planned' ? (
                  <p className="text-base text-ink2">入院中</p>
                ) : (
                  <p className="flex flex-wrap gap-x-3 text-base text-ink">
                    <span className="whitespace-nowrap">
                      到着 <span className="font-num font-bold">{a?.arrived_at ? hmShort(a.arrived_at) : '—'}</span>
                    </span>
                    <span className="whitespace-nowrap">
                      帰宅 <span className="font-num font-bold">{a?.left_at ? hmShort(a.left_at) : '—'}</span>
                    </span>
                  </p>
                )}
                {/* 入浴・昼食・バイタルの状態（文字だけ・押せない。記録は1人の画面・食事一括・バイタル一括） */}
                <p className="flex flex-wrap gap-x-3 text-sm text-ink">
                  <span className={absentBathLeft ? 'rounded border-2 border-warn bg-warn-bg px-1 font-bold' : undefined}>
                    {absentBathLeft ? <span aria-hidden="true">▲ </span> : null}入浴 {bathText}
                  </span>
                  <span>昼食 {attended || lunch !== null ? lunchShortLabel(lunch) : '—'}</span>
                  <span className={vAbn ? 'rounded border-2 border-warn bg-warn-bg px-1 font-bold' : undefined}>
                    バイタル {vAbn ? '▲ 要確認' : vDone ? '✓ 済' : attended ? '未' : '—'}
                  </span>
                </p>
                {pending ? (
                  <p className="text-sm text-ink2" role="status">
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

      {ops.dialogs}
      {toast}
    </div>
  )
}

export default DaycarePage
