// デイ（せせらぎ）段階2a: 1人の1日記録（/record/daycare/person/:residentId・業務日は ?day=）。
//
// 上から バイタル（要約・入力はバイタル一括）・入浴（状態・操作は今日の画面）・昼食・おやつ・水分・排泄（表示と入口）。
// 〔前の方〕〔次の方〕で在席・帰宅の方を順に回る。
//
// 規律（段階1と同じ）:
//   ・取得・保存は db.ts の関数だけ。昼食・おやつは既存の saveMealEdits（meals の lunch・snack）、水分は既存の insertFluid・
//     softDeleteFluid。入力の旗は既存の native_input_enabled（db.ts の入口で効く）。画面はデイの旗 input_enabled_daycare で出し入れ
//   ・昼食は取り込み（申し送りのスプレッドシート）の値を初めの値として見せ、直すと画面の入力として保存する（edited_by が付き、
//     取り込みはその行を上書きしない＝tools/import.mjs の app_protected）。取り込み側は変えない
//   ・排泄は排泄ケアアプリ（haiben-record）を読むだけ（excretionClient）。入口は ?masterId=<residents.source_id>。書かない・変えない
//   ・氏名・記録を localStorage・console に出さない。現在地は URL（業務日は ?day=）で戻る
//   ・色だけに頼らない（記号＋言葉）・押す所は 44px 以上

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  DbError,
  FORBIDDEN_REASON,
  OUTDATED_REASON,
  discardPendingRow,
  fetchAllResidents,
  fetchBathDay,
  fetchDaycareAttendance,
  fetchDaycareDay,
  fetchDaycareIntake,
  fetchDaycarePlan,
  fetchDaycareVitals,
  fetchResidentTargets,
  getKindInputGate,
  insertFluid,
  isQueuePersisted,
  isSelfWrite,
  kindBlockedMessage,
  pendingRow,
  queuePending,
  queueSubscribe,
  saveMealEdits,
  softDeleteFluid,
  subscribeBathChanges,
  subscribeChanges,
  subscribeDaycareChanges,
} from '../lib/db'
import type { CellConflict, CellEditInput, DaycareMealRow, MealCellField, MealTarget } from '../lib/db'
import { RecorderBar } from '../components/RecorderBar'
import { DaycareActivitySection } from '../components/DaycareActivitySection'
import { useDaycareNoteMarks } from '../components/DaycareNoteMark'
import { activityText } from '../lib/daycareActivity'
import { activityMarkText, excretionMarkText, fluidMarkText, mealMarkText, vitalMarkText } from '../lib/daycareNoteMark'
import { ConfirmDialog, ErrorBlock, LoadingBlock, useToast } from '../components/ui'
import {
  DAYCARE_VITAL_FIELDS,
  DAYCARE_VITAL_LABEL,
  DAYCARE_VITAL_UNIT,
  LEVEL_WORD,
  buildDaycareBoard,
  daycareBathLabel,
  daycareBathStatus,
  nowHm,
  vitalLevel,
} from '../lib/daycare'
import type { DaycareBoardRow, DaycareVitalField, KeyedVital } from '../lib/daycare'
import {
  DAYCARE_FLUID_STEPS,
  DAYCARE_MEAL_AMOUNTS,
  DAYCARE_SNACK_CHOICES,
  fluidAmountError,
  fluidTotalOf,
  haibenAppHref,
  lunchLabel,
  mealSourceLabel,
  personNav,
  personPath,
  readPersonDay,
  settleQueuedFluid,
  snackLabel,
} from '../lib/daycarePerson'
import { excretionFailMessage, excretionViewFor, fetchExcretion, MSG_EXCRETION_UNCONFIGURED } from '../lib/excretionClient'
import type { ExcretionView } from '../lib/excretionClient'
import type { ResidentTargets } from '../lib/vitalAlerts'
import { addDays, fmtDayLabel, todayIso } from '../lib/format'
import { DAYCARE_ABSENT_REASON_LABEL, LEVEL_MARK } from '../lib/types'
import type { BathRecord, DaycareAttendance, DaycareDay, DaycarePlanRow, DaycarePlanSource, FluidIntake, Meal, Resident, Staff } from '../lib/types'

const ERR_LOAD = 'デイの記録を読み込めませんでした。通信状態を確認して、再試行してください。'
const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから入れてください。'
const MSG_QUEUED = '電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度押してください。'
const MSG_GATE_UNKNOWN =
  'デイの記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。記録の閲覧はこのままできます。'

interface PersonData {
  day: string
  planRows: DaycarePlanRow[]
  planSource: DaycarePlanSource
  missing: boolean
  attendance: DaycareAttendance[]
  baths: BathRecord[]
  vitals: KeyedVital[]
  meals: DaycareMealRow[]
  fluids: FluidIntake[]
}

type MealSlot2 = 'lunch' | 'snack'
type MealField = 'main_amount' | 'side_amount' | 'status'
/**
 * 昼食・おやつの保存の状態。人・日・枠ごとに持つ（保存の途中で人や日を切り替えても、前の方の結果を次の方の欄に出さない＝
 * 2a の反証 中3）。食い違い・止まり・拒否は、その送り先（target）を持ち、解く操作はその送り先へ送る
 */
type SaveState =
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'queued'; persisted: boolean }
  | { kind: 'conflict'; conflicts: CellConflict[]; target: MealTarget }
  | { kind: 'held'; target: MealTarget }
  | { kind: 'rejected'; target: MealTarget; reason?: string }
  | { kind: 'error'; text: string }

const mealKeyOf = (t: MealTarget) => `${t.residentId}:${t.day}:${t.slot}`
const personKeyOf = (residentId: number, day: string) => `${residentId}:${day}`

type ExState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'error'; message: string }
  | { status: 'ok'; view: ExcretionView }

function stateText(row: DaycareBoardRow | undefined): string {
  if (row === undefined) return '予定・記録なし'
  const a = row.attendance
  const hm = (t: string | null | undefined) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(t ?? '')
    return m === null ? '' : ` ${Number(m[1])}:${m[2]}`
  }
  if (row.state === 'absent') return `欠席（${a?.absent_reason ? DAYCARE_ABSENT_REASON_LABEL[a.absent_reason] : '理由なし'}）`
  if (row.state === 'left') return `帰宅${hm(a?.left_at)}`
  if (row.state === 'present') return `在席${hm(a?.arrived_at)}`
  if (row.hospitalized) return '入院中'
  return row.extra ? '予定外' : '予定'
}

function fmtMl(n: number): string {
  return `${n.toLocaleString('ja-JP')} ml`
}

export interface DaycarePersonPageProps {
  staff?: Staff[] | null
  actorId?: number | null
}

export function DaycarePersonPage({ staff = undefined, actorId = null }: DaycarePersonPageProps = {}) {
  const params = useParams()
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const residentId = Number(params.residentId)
  const validId = Number.isSafeInteger(residentId) && residentId > 0
  const [today, setToday] = useState(todayIso())
  const day = readPersonDay(search.get('day'), today)
  const [data, setData] = useState<PersonData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [residents, setResidents] = useState<Resident[]>([])
  const [targets, setTargets] = useState<Map<number, ResidentTargets>>(new Map())
  const [gate, setGate] = useState<{ value: boolean; observed: boolean; forbidden?: true; outdated?: true } | null>(null)
  const [mealState, setMealState] = useState<Record<string, SaveState>>({})
  /** 水分の一言（人・日ごと。いま開いている人・日の分だけ出す） */
  // queued: 送信待ちにした旨の一言（add＝足した分が載ったら・delId＝取り消した行がサーバーから消えたら外す）
  const [fluidMsg, setFluidMsg] = useState<{ key: string; tone: 'warn' | 'danger' | 'info'; text: string; queued?: { add: true } | { delId: number } } | null>(null)
  /**
   * 送信待ちの水分（人・日ごと）。base＝退避した時のサーバーの合計、ml＝まだ載っていない量、lost＝端末に控えを残せなかった。
   * 合計と一覧に重ねて出し、取り直した合計で載った分だけ減らす（既存の食事・水分の一括入力と同じ消し込み＝2a の反証 中4）
   */
  const [queuedFluids, setQueuedFluids] = useState<Record<string, { base: number; ml: number; lost: boolean }>>({})
  /** 取り消しを送信待ちにした水分の行（id → その行の日。その日の読み込みでサーバーから消えるまで画面から外す・同じ行の取り消しを二重に積まない） */
  const [hiddenFluidIds, setHiddenFluidIds] = useState<Map<number, string>>(new Map())
  const [fluidOther, setFluidOther] = useState('')
  const [fluidBusy, setFluidBusy] = useState(false)
  const [delFluid, setDelFluid] = useState<FluidIntake | null>(null)
  const [ex, setEx] = useState<ExState>({ status: 'loading' })
  const [exTick, setExTick] = useState(0)
  const [queueTick, setQueueTick] = useState(0)
  const { toast, show } = useToast()
  const genRef = useRef(0)
  const dayRef = useRef(day)
  dayRef.current = day
  const residentRef = useRef(residentId)
  residentRef.current = residentId

  useEffect(() => {
    const t = window.setInterval(() => setToday(todayIso()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    let alive = true
    setGate(null)
    getKindInputGate('daycare')
      .then((g) => alive && setGate(g))
      .catch(() => alive && setGate({ value: false, observed: false }))
    return () => {
      alive = false
    }
  }, [reloadKey])

  useEffect(() => {
    let alive = true
    Promise.all([fetchAllResidents(), fetchResidentTargets().catch(() => new Map<number, ResidentTargets>())])
      .then(([all, tg]) => {
        if (!alive) return
        setResidents(all)
        setTargets(tg)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [reloadKey])

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
      const usable = snapshot !== null && snapshot.plan_source !== 'unknown'
      const [plan, attendance, baths, dv, intake] = await Promise.all([
        usable ? Promise.resolve(null) : fetchDaycarePlan(target),
        missing ? Promise.resolve([] as DaycareAttendance[]) : fetchDaycareAttendance(target),
        fetchBathDay(target).catch(() => [] as BathRecord[]),
        fetchDaycareVitals(target).catch(() => ({ live: [] as KeyedVital[], keys: [] as string[] })),
        fetchDaycareIntake(target),
      ])
      if (gen !== genRef.current || target !== dayRef.current) return
      setData({
        day: target,
        planRows: usable && snapshot !== null ? snapshot.plan_rows : (plan?.rows ?? []),
        planSource: usable && snapshot !== null ? snapshot.plan_source : (plan?.source ?? 'unknown'),
        missing: missing || plan?.missing === true,
        attendance,
        baths,
        vitals: dv.live,
        meals: intake.meals,
        fluids: intake.fluids,
      })
      setError(null)
    } catch {
      if (gen !== genRef.current) return
      if (!quiet) setError(ERR_LOAD)
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setFluidOther('')
    // 人・日の切り替えと〔最新に更新〕では、その場限りの知らせ（保存しました・保存できませんでした）を外す。
    // 送信待ち・食い違い・拒否の知らせは残し、届いた・解けたと分かった時に外す（下の出し直し）
    setMealState((prev) => {
      const next: Record<string, SaveState> = {}
      for (const [k, v] of Object.entries(prev)) if (v.kind !== 'saved' && v.kind !== 'error') next[k] = v
      return next
    })
    setFluidMsg((m) => (m !== null && m.queued !== undefined ? m : null))
    void load(day, false)
  }, [day, residentId, reloadKey, load])

  // 他の端末の変更（Realtime）と送信待ちの減り（送れた）で静かに読み直す
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
      offQ()
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    }
  }, [scheduleReload])

  const resident = useMemo(() => residents.find((r) => r.id === residentId) ?? null, [residents, residentId])
  const board = useMemo(
    () => (data === null ? null : buildDaycareBoard({ planRows: data.planRows, source: data.planSource, residents, attendance: data.attendance })),
    [data, residents],
  )
  const row = board?.rows.find((r) => r.residentId === residentId)
  const nav = board === null ? { prev: null, next: null } : personNav(board.rows, residentId)
  const nameOf = (id: number) => residents.find((r) => r.id === id)?.name ?? `利用者ID ${id}`

  // 排泄（排泄ケアアプリを読むだけ）
  useEffect(() => {
    if (resident === null) return
    let alive = true
    setEx({ status: 'loading' })
    fetchExcretion({ force: exTick > 0 })
      .then((r) => {
        if (!alive) return
        if (r === null) setEx({ status: 'unconfigured' })
        else if (!r.ok) setEx({ status: 'error', message: excretionFailMessage(r.reason) })
        else setEx({ status: 'ok', view: excretionViewFor(r.snap, resident, residents, Date.now()) })
      })
      .catch(() => alive && setEx({ status: 'error', message: excretionFailMessage('network') }))
    return () => {
      alive = false
    }
  }, [resident, residents, exTick])

  const canWrite = gate !== null && gate.observed && gate.value === true && !(data?.missing ?? false) && day <= today

  // ── 昼食・おやつ ──
  const targetOf = (slot: MealSlot2): MealTarget => ({ residentId, day, slot })
  const mealRowFor = (t: MealTarget): DaycareMealRow | null =>
    data === null || data.day !== t.day
      ? null
      : (data.meals.find((m) => m.meal.resident_id === t.residentId && m.meal.meal_slot === t.slot) ?? null)
  const mealRowOf = (slot: MealSlot2): DaycareMealRow | null => mealRowFor(targetOf(slot))
  /**
   * 画面に出す値: 送信待ち（まだ送っていない・送っている途中）の値だけ重ねる。止まった値（食い違い）・拒まれた値は重ねず、
   * サーバーの値を出して欄の下で知らせる（既存の食事・水分の一括入力と同じ＝2a の反証 重大1）
   */
  const mealShownFor = (t: MealTarget): Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null => {
    const cur = mealRowFor(t)?.meal ?? null
    const p = pendingRow('meals', t)
    if (p === null || p.state !== 'pending') return cur
    const pick = <K extends MealField>(f: K): Meal[K] | null =>
      (f in p.values ? (p.values[f] as Meal[K] | null) : (cur?.[f] ?? null)) as Meal[K] | null
    return { main_amount: pick('main_amount'), side_amount: pick('side_amount'), status: pick('status') }
  }
  const mealShown = (slot: MealSlot2) => mealShownFor(targetOf(slot))
  const setMealFor = (t: MealTarget, st: SaveState | null) =>
    setMealState((prev) => {
      const next = { ...prev }
      const k = mealKeyOf(t)
      if (st === null) delete next[k]
      else next[k] = st
      return next
    })

  const precheck = (): string | null => {
    if (!canWrite) {
      return gate?.forbidden ? FORBIDDEN_REASON : gate?.outdated ? OUTDATED_REASON : gate?.observed ? kindBlockedMessage('daycare') : MSG_GATE_UNKNOWN
    }
    if (actorId === null) return MSG_NO_RECORDER
    return null
  }

  // 申し送りの印（段階2c）。申し送りへの書き込みはこの部品の中だけ（この画面の書き込みの経路は増やさない）
  const marks = useDaycareNoteMarks({
    residentId,
    day,
    actorId,
    canWrite,
    blockedReason: canWrite
      ? null
      : gate?.forbidden
        ? FORBIDDEN_REASON
        : gate?.outdated
          ? OUTDATED_REASON
          : gate?.observed
            ? kindBlockedMessage('daycare')
            : MSG_GATE_UNKNOWN,
    refreshKey: reloadKey,
    show,
  })

  /**
   * 昼食・おやつの欄を保存する（既存の saveMealEdits。基準は読んだ時のサーバーの値。rebase は〔あなたの値で直す〕・〔元に戻す〕）。
   * 送り先（t）は押した時の人・日・枠で固定する（応答の前に人や日を切り替えても、次の方へ書かない＝2a の反証 中3）
   */
  const saveMeal = async (
    t: MealTarget,
    patch: Partial<Record<MealField, number | string | null>>,
    opts: { rebase?: Record<string, unknown>; undoable?: boolean } = {},
  ) => {
    const why = precheck()
    if (why !== null) {
      setMealFor(t, { kind: 'error', text: why })
      return
    }
    const before = mealShownFor(t)
    const cur = mealRowFor(t)?.meal ?? null
    const send: Record<string, { value: unknown; base: unknown }> = {}
    for (const [f, v] of Object.entries(patch)) {
      const base = opts.rebase !== undefined && f in opts.rebase ? opts.rebase[f] : (cur?.[f as MealField] ?? null)
      send[f] = { value: v, base }
    }
    setMealFor(t, { kind: 'saving' })
    const here = () => residentRef.current === t.residentId && dayRef.current === t.day
    try {
      const r = await saveMealEdits(t, send as CellEditInput<MealCellField>, {
        // 記入者は新しい行の時だけ（更新では編集した欄だけ＝部分更新）。edited_by は既定の操作者＝取り込みの上書きを止める印
        ...(cur === null ? { fill: { recorded_by: actorId } } : {}),
        editedBy: actorId,
        rebase: opts.rebase !== undefined,
      })
      if (r === 'queued') {
        // 送信待ちにした: 〔元に戻す〕は出さない（送る前の値を基準にした取り消しが、送った時に偽の食い違いになるため＝中2）
        setMealFor(t, { kind: 'queued', persisted: isQueuePersisted() })
        return
      }
      if (r.row !== null) {
        const saved = r.row
        const wrote = r.applied.length > 0
        setData((prev) => {
          if (prev === null || prev.day !== saved.meal_on) return prev
          const old = prev.meals.find((m) => m.meal.id === saved.id)
          const meals = [
            ...prev.meals.filter((m) => m.meal.id !== saved.id),
            // 画面の入力の印は、実際に書けた時だけ（同じ値＝何も書かなかった時は edited_by が付かない）
            { meal: saved, imported: old?.imported ?? false, editedInApp: (old?.editedInApp ?? false) || wrote },
          ]
          return { ...prev, meals }
        })
      }
      if (r.held === true) {
        const p = pendingRow('meals', t)
        setMealFor(t, p !== null && p.conflicts.length > 0 ? { kind: 'conflict', conflicts: p.conflicts, target: t } : { kind: 'held', target: t })
        return
      }
      if (r.conflicts.length > 0) {
        setMealFor(t, { kind: 'conflict', conflicts: r.conflicts, target: t })
        return
      }
      setMealFor(t, { kind: 'saved' })
      // 〔元に戻す〕はオンラインで実際に書けた時だけ（既存の食事・水分の一括入力と同じ）。人・日を移った後は出さない
      if (opts.undoable !== false && r.applied.length > 0 && here()) {
        const word = t.slot === 'lunch' ? '昼食' : 'おやつ'
        const undoPatch: Partial<Record<MealField, number | string | null>> = {}
        for (const f of Object.keys(patch) as MealField[]) undoPatch[f] = before?.[f] ?? null
        show(`${nameOf(t.residentId)}さんの${word}を記録しました`, () => {
          const base: Record<string, unknown> = {}
          for (const f of Object.keys(patch)) base[f] = patch[f as MealField] ?? null
          void saveMeal(t, undoPatch, { rebase: base, undoable: false })
        })
      }
    } catch (e) {
      const text = e instanceof DbError ? e.message : '保存できませんでした。通信状態を確認して、もう一度押してください。'
      // 拒まれた値が送信待ちに残った時は、押した直後から〔取り下げる〕を出す（読み直すまで外す手段が無いままにしない）
      const p = pendingRow('meals', t)
      setMealFor(t, p !== null && p.state === 'rejected' ? { kind: 'rejected', target: t, reason: text } : { kind: 'error', text })
    }
  }

  /** 食い違い・止まり・拒否を解く（送り先は状態が持つ target） */
  const resolveTake = async (t: MealTarget, fields?: readonly string[]) => {
    const p = pendingRow('meals', t)
    await discardPendingRow('meals', t, fields ?? (p === null ? [] : Object.keys(p.values)), p?.vers)
    setMealFor(t, null)
    scheduleReload()
  }
  const resolveMine = async (t: MealTarget, conflicts: CellConflict[]) => {
    const p = pendingRow('meals', t)
    const patch: Partial<Record<MealField, number | string | null>> = {}
    const base: Record<string, unknown> = {}
    for (const c of conflicts) {
      const mine = p !== null && Object.prototype.hasOwnProperty.call(p.values, c.field) ? p.values[c.field] : c.mine
      patch[c.field as MealField] = (mine ?? null) as number | string | null
      base[c.field] = c.server
    }
    await saveMeal(t, patch, { rebase: base, undoable: false })
  }

  // 読み込みの後と、送信待ちが動いた時（背景の再送で止まった・拒まれた・届いた）: 昼食・おやつの欄の下の知らせを、送信待ちの今の状態に合わせて出し直す
  // （止まった値を保存済みのように見せない＝重大1。画面を開いたまま背景で止まった時も切り替える＝2a の確認の反証 中2）
  useEffect(() => {
    if (data === null) return
    setMealState((prev) => {
      let next = prev
      for (const slot of ['lunch', 'snack'] as const) {
        const t: MealTarget = { residentId, day: data.day, slot }
        const k = mealKeyOf(t)
        const cur = prev[k]
        if (cur !== undefined && cur.kind === 'saving') continue
        const p = pendingRow('meals', t)
        let st: SaveState | undefined = cur
        if (p !== null && p.state !== 'pending') {
          if (p.state === 'rejected') st = cur !== undefined && cur.kind === 'rejected' ? cur : { kind: 'rejected', target: t }
          else if (p.conflicts.length > 0)
            st =
              cur !== undefined && cur.kind === 'conflict' && JSON.stringify(cur.conflicts) === JSON.stringify(p.conflicts)
                ? cur
                : { kind: 'conflict', conflicts: p.conflicts, target: t }
          else st = cur !== undefined && cur.kind === 'held' ? cur : { kind: 'held', target: t }
        } else if (cur !== undefined && (cur.kind === 'conflict' || cur.kind === 'held' || cur.kind === 'rejected' || (cur.kind === 'queued' && p === null))) {
          // 届いた（送信待ちから消えた）・別のタブで解かれた: 送信待ち・食い違い・拒否の知らせを外す
          st = undefined
        }
        if (st === cur) continue
        if (next === prev) next = { ...prev }
        if (st === undefined) delete next[k]
        else next[k] = st
      }
      return next
    })
  }, [data, residentId, queueTick])

  /** 割合・おやつのボタン: 状態が「食べた」以外（拒食・外出・入院）なら「食べた」に戻して送る（2a の反証 中5） */
  const withEaten = (status: string | null | undefined, patch: Partial<Record<MealField, number | string | null>>) =>
    status === null || status === undefined || status === 'eaten' ? patch : { ...patch, status: 'eaten' }

  // ── 水分 ──
  const personKey = personKeyOf(residentId, day)
  const fluidsOf = useMemo(
    () =>
      data === null
        ? []
        : data.fluids.filter((f) => f.resident_id === residentId && f.taken_on === data.day && !hiddenFluidIds.has(f.id)),
    [data, residentId, hiddenFluidIds],
  )
  // 読み込みの後: 送信待ちの水分は、取り直した合計（取り消しを送信待ちにして外した行を除く）で載った分だけ減らす（観測ベース）。
  // 未送信が1件も無ければ、送信待ちの水分も残さない（届いた後に読み直している＝消し込みの取りこぼしの安全網）。
  // 取り消しを送った行は、その行の日の読み込みでサーバーから消えたら外す（別の日を読んだだけでは外さない＝2a の確認の反証 軽4）
  useEffect(() => {
    if (data === null) return
    const visible = data.fluids.filter((f) => !hiddenFluidIds.has(f.id))
    const nothingQueued = queuePending() === 0
    setQueuedFluids((prev) => {
      let next = prev
      for (const [k, held] of Object.entries(prev)) {
        const [ridText, d] = k.split(':')
        if (d !== data.day && !nothingQueued) continue
        const r = nothingQueued ? null : settleQueuedFluid(held, fluidTotalOf(visible, Number(ridText), d))
        if (r !== null && r.base === held.base && r.ml === held.ml) continue
        if (next === prev) next = { ...prev }
        if (r === null) delete next[k]
        else next[k] = { ...held, ...r }
      }
      return next
    })
    setHiddenFluidIds((prev) => {
      const gone = [...prev].filter(([id, d]) => d === data.day && !data.fluids.some((f) => f.id === id))
      if (gone.length === 0) return prev
      const still = new Map(prev)
      for (const [id] of gone) still.delete(id)
      return still
    })
  }, [data, hiddenFluidIds])
  // 送信待ちにした旨の一言は、届いたと観測できたら外す（「電波が戻ると自動で送信します」を送った後に残さない）
  useEffect(() => {
    setFluidMsg((m) => {
      if (m === null || m.queued === undefined) return m
      if ('add' in m.queued) return queuedFluids[m.key] === undefined ? null : m
      if (data === null || !m.key.endsWith(`:${data.day}`)) return m
      const delId = m.queued.delId
      return data.fluids.some((f) => f.id === delId) ? m : null
    })
  }, [queuedFluids, data])

  const addFluid = async (ml: number) => {
    const rid = residentId
    const d = day
    const key = personKeyOf(rid, d)
    const why = precheck()
    if (why !== null) {
      setFluidMsg({ key, tone: 'warn', text: why })
      return
    }
    setFluidBusy(true)
    try {
      const r = await insertFluid({
        resident_id: rid,
        taken_on: d,
        // 今日だけいまの時刻（過去の日にいまの時刻を入れない＝段階1の反証レビュー中7と同じ考え）
        taken_at: d === todayIso() ? nowHm() : null,
        amount_ml: ml,
        kind: null,
        recorded_by: actorId,
      })
      if (r === 'queued') {
        const persisted = isQueuePersisted()
        setQueuedFluids((prev) => {
          const held = prev[key]
          // base は最初に退避した時点のサーバーの合計を保つ（重ねて退避しても基準をずらさない）
          const base =
            held !== undefined
              ? held.base
              : data === null || data.day !== d
                ? 0
                : fluidTotalOf(
                    data.fluids.filter((x) => !hiddenFluidIds.has(x.id)),
                    rid,
                    d,
                  )
          return { ...prev, [key]: { base, ml: (held?.ml ?? 0) + ml, lost: (held?.lost ?? false) || !persisted } }
        })
        setFluidMsg({ key, tone: persisted ? 'info' : 'danger', text: `＋${fmtMl(ml)}：${persisted ? MSG_QUEUED : MSG_NOT_PERSISTED}`, queued: { add: true } })
        return
      }
      const saved = r
      setData((prev) => (prev === null || prev.day !== saved.taken_on ? prev : { ...prev, fluids: [...prev.fluids, saved] }))
      setFluidMsg((m) => (m !== null && m.key === key ? null : m))
      if (residentRef.current === rid && dayRef.current === d) {
        show(`${nameOf(rid)}さんの水分 ＋${fmtMl(ml)} を記録しました`, () => void removeFluid(saved, true))
      }
    } catch (e) {
      setFluidMsg({ key, tone: 'danger', text: e instanceof DbError ? e.message : '保存できませんでした。通信状態を確認して、もう一度押してください。' })
    } finally {
      setFluidBusy(false)
    }
  }
  const removeFluid = async (f: FluidIntake, fromUndo = false) => {
    setDelFluid(null)
    const key = personKeyOf(f.resident_id, f.taken_on)
    const why = precheck()
    if (why !== null) {
      setFluidMsg({ key, tone: 'warn', text: why })
      return
    }
    try {
      const r = await softDeleteFluid(f.id, f.rev, { editedBy: actorId })
      if (r === 'queued') {
        // 取り消しを送信待ちにした: 画面からは先に外す（同じ行の取り消しを二重に積まない）。控えを残せたかで文言を分ける
        setHiddenFluidIds((prev) => new Map([...prev, [f.id, f.taken_on]]))
        const persisted = isQueuePersisted()
        setFluidMsg({ key, tone: persisted ? 'info' : 'danger', text: `${fmtMl(f.amount_ml)} の取り消し：${persisted ? MSG_QUEUED : MSG_NOT_PERSISTED}`, queued: { delId: f.id } })
      } else if (r === true) {
        setData((prev) => (prev === null ? prev : { ...prev, fluids: prev.fluids.filter((x) => x.id !== f.id) }))
        if (!fromUndo) show(`水分 ${fmtMl(f.amount_ml)} を取り消しました`)
      } else {
        setFluidMsg({ key, tone: 'warn', text: '他の端末が先にこの記録を直していました。最新の内容に読み直しました。確かめてから、もう一度押してください。' })
        scheduleReload()
      }
    } catch (e) {
      setFluidMsg({ key, tone: 'danger', text: e instanceof DbError ? e.message : '取り消せませんでした。通信状態を確認して、もう一度押してください。' })
    }
  }
  const otherErr = fluidOther === '' ? null : fluidAmountError(fluidOther)

  // ── 描画 ──
  const goDay = (d: string) => navigate(personPath(residentId, d, today), { replace: true })
  const header = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <Link
          to={day === today ? '/record/daycare' : `/record/daycare`}
          className="inline-flex min-h-tap items-center rounded-full border border-border-strong bg-surface px-4 text-base text-ink"
        >
          <span aria-hidden="true">‹ </span>デイの一覧へ
        </Link>
        <RecorderBar actorId={actorId} staff={staff ?? null} />
      </div>
      <div className="flex flex-wrap items-center gap-gap" role="group" aria-label="日付">
        <button
          type="button"
          onClick={() => goDay(addDays(day, -1))}
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
          onClick={() => goDay(addDays(day, 1) > today ? day : addDays(day, 1))}
          disabled={day >= today}
          className="min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-lg text-ink disabled:text-ink3"
          aria-label="次の日へ"
        >
          <span aria-hidden="true">›</span>
        </button>
        <button
          type="button"
          onClick={() => setReloadKey((n) => n + 1)}
          className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink"
        >
          最新に更新
        </button>
      </div>
      {gate !== null && !(gate.observed && gate.value === true) ? (
        <p role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {gate.forbidden ? FORBIDDEN_REASON : gate.outdated ? OUTDATED_REASON : gate.observed ? `${kindBlockedMessage('daycare')}。記録の閲覧はできます。` : MSG_GATE_UNKNOWN}
        </p>
      ) : null}
      {data?.missing ? (
        <p role="alert" className="rounded-lg border border-danger bg-danger-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>デイの記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。
        </p>
      ) : null}
    </div>
  )

  if (!validId) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        {header}
        <ErrorBlock message="開く方が分かりませんでした。デイの一覧から開き直してください。" />
      </div>
    )
  }
  if ((loading && data === null) || (data !== null && data.day !== day && error === null)) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        {header}
        <LoadingBlock label="この方の記録を読み込んでいます…" />
      </div>
    )
  }
  if (error !== null && (data === null || data.day !== day)) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        {header}
        <ErrorBlock message={error} onRetry={() => setReloadKey((n) => n + 1)} />
      </div>
    )
  }
  if (data === null) return null

  const name = resident?.name ?? nameOf(residentId)
  const myVitals = data.vitals
    .filter((v) => v.resident_id === residentId)
    .sort((a, b) => (a.measured_at ?? '').localeCompare(b.measured_at ?? '') || a.id - b.id)
  const latestOf = (f: DaycareVitalField): number | null => {
    for (let i = myVitals.length - 1; i >= 0; i -= 1) {
      const v = myVitals[i][f]
      if (typeof v === 'number') return v
    }
    return null
  }
  const bath = data.baths.find((b) => b.resident_id === residentId) ?? null
  const bathText = daycareBathLabel(daycareBathStatus(bath, row?.bathingPlanned ?? false))
  const lunchRow = mealRowOf('lunch')
  const lunch = mealShown('lunch')
  const snack = mealShown('snack')
  const queuedNow = queuedFluids[personKey] ?? null
  const fluidTotal = fluidTotalOf(fluidsOf, residentId, data.day) + (queuedNow?.ml ?? 0)
  const sectionCls = 'rounded-lg border border-border bg-surface p-3 space-y-2'
  const chipCls = (on: boolean) =>
    on
      ? 'min-h-tap min-w-tap rounded border-2 border-primary bg-primary px-2 text-lg font-bold text-primary-ink'
      : 'min-h-tap min-w-tap rounded border border-border-strong bg-surface px-2 text-lg text-ink disabled:text-ink3'

  const exDay = ex.status === 'ok' && ex.view.linked ? (ex.view.days.find((d) => d.day === data.day) ?? null) : null

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      {header}

      <section aria-label="この方" className="rounded-lg border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-gap">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-ink">{name}</h2>
            <p className="text-base text-ink2">{stateText(row)}</p>
          </div>
          <div className="flex flex-wrap gap-gap" role="group" aria-label="在席の方を順に">
            <button
              type="button"
              onClick={() => nav.prev !== null && navigate(personPath(nav.prev, day, today))}
              disabled={nav.prev === null}
              className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink disabled:text-ink3"
            >
              <span aria-hidden="true">‹ </span>前の方
            </button>
            <button
              type="button"
              onClick={() => nav.next !== null && navigate(personPath(nav.next, day, today))}
              disabled={nav.next === null}
              className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink disabled:text-ink3"
            >
              次の方<span aria-hidden="true"> ›</span>
            </button>
          </div>
        </div>
      </section>

      <section aria-labelledby="h-vital" className={sectionCls}>
        <h3 id="h-vital" className="text-lg font-bold text-ink">
          バイタル
        </h3>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-base text-ink">
          {DAYCARE_VITAL_FIELDS.map((f) => {
            const v = latestOf(f)
            const lv = vitalLevel(f, v, targets.get(residentId))
            return (
              <li key={f}>
                {DAYCARE_VITAL_LABEL[f]} <span className="font-num font-bold">{v === null ? '—' : v}</span>
                {v === null ? null : <span className="text-sm text-ink2">{DAYCARE_VITAL_UNIT[f]}</span>}
                {lv !== null ? (
                  <span className="ml-1 font-bold">
                    {LEVEL_MARK[lv]} {LEVEL_WORD[lv]}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
        <Link to="/record/daycare/vitals" className="inline-flex min-h-tap items-center rounded border border-border-strong px-4 text-base text-link">
          バイタル一括で入力する<span aria-hidden="true"> ›</span>
        </Link>
        {marks.button(
          { kind: 'vital' },
          vitalMarkText({ temp: latestOf('temp'), sys_bp: latestOf('sys_bp'), dia_bp: latestOf('dia_bp'), pulse: latestOf('pulse'), spo2: latestOf('spo2') }),
        )}
      </section>

      <section aria-labelledby="h-bath" className={sectionCls}>
        <h3 id="h-bath" className="text-lg font-bold text-ink">
          入浴
        </h3>
        <p className="text-base text-ink">{bathText}</p>
        <Link to="/record/daycare" className="inline-flex min-h-tap items-center rounded border border-border-strong px-4 text-base text-link">
          今日の一覧で入浴を記録する<span aria-hidden="true"> ›</span>
        </Link>
      </section>

      <section aria-labelledby="h-lunch" className={sectionCls}>
        <div className="flex flex-wrap items-baseline justify-between gap-gap">
          <h3 id="h-lunch" className="text-lg font-bold text-ink">
            昼食
          </h3>
          {mealSourceLabel(lunchRow) !== null ? <span className="text-sm text-ink2">{mealSourceLabel(lunchRow)}</span> : null}
        </div>
        <p className="text-base text-ink">
          いま: <span className="font-bold">{lunchLabel(lunch)}</span>
        </p>
        {(['main_amount', 'side_amount'] as const).map((f) => (
          <div key={f} role="group" aria-label={f === 'main_amount' ? '昼食 主食の割合' : '昼食 副食の割合'}>
            <p className="text-sm text-ink2">{f === 'main_amount' ? '主食（割）' : '副食（割）'}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {DAYCARE_MEAL_AMOUNTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={lunch?.[f] === n && (lunch?.status ?? 'eaten') === 'eaten'}
                  aria-label={`${f === 'main_amount' ? '主食' : '副食'} ${n}割`}
                  disabled={!canWrite}
                  onClick={() => void saveMeal(targetOf('lunch'), withEaten(lunch?.status, { [f]: n }))}
                  className={chipCls(lunch?.[f] === n && (lunch?.status ?? 'eaten') === 'eaten')}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-gap" role="group" aria-label="昼食の状態">
          <button
            type="button"
            aria-pressed={lunch?.status === 'refused'}
            disabled={!canWrite}
            onClick={() => void saveMeal(targetOf('lunch'), { status: lunch?.status === 'refused' ? 'eaten' : 'refused' })}
            className={chipCls(lunch?.status === 'refused')}
          >
            {lunch?.status === 'refused' ? '拒食を取り消す' : '拒食'}
          </button>
        </div>
        <MealStatusLine
          st={mealState[mealKeyOf(targetOf('lunch'))]}
          onTake={(t, fields) => void resolveTake(t, fields)}
          onMine={(t, cs) => void resolveMine(t, cs)}
        />
        {/* 申し送りの文はサーバーの値から（送信待ちの値は送れてから） */}
        {marks.button({ kind: 'lunch' }, mealMarkText('lunch', lunchLabel(lunchRow?.meal ?? null)))}
      </section>

      <section aria-labelledby="h-snack" className={sectionCls}>
        <h3 id="h-snack" className="text-lg font-bold text-ink">
          おやつ
        </h3>
        <p className="text-base text-ink">
          いま: <span className="font-bold">{snackLabel(snack)}</span>
        </p>
        <div className="flex flex-wrap gap-gap" role="group" aria-label="おやつ">
          {DAYCARE_SNACK_CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-pressed={snack?.main_amount === c.value && (snack?.status ?? 'eaten') === 'eaten'}
              disabled={!canWrite}
              onClick={() => void saveMeal(targetOf('snack'), withEaten(snack?.status, { main_amount: c.value }))}
              className={chipCls(snack?.main_amount === c.value && (snack?.status ?? 'eaten') === 'eaten')}
            >
              {c.label}
            </button>
          ))}
        </div>
        <MealStatusLine
          st={mealState[mealKeyOf(targetOf('snack'))]}
          onTake={(t, fields) => void resolveTake(t, fields)}
          onMine={(t, cs) => void resolveMine(t, cs)}
        />
        {marks.button({ kind: 'snack' }, mealMarkText('snack', snackLabel(mealRowOf('snack')?.meal ?? null)))}
      </section>

      <section aria-labelledby="h-fluid" className={sectionCls}>
        <h3 id="h-fluid" className="text-lg font-bold text-ink">
          水分
        </h3>
        <p className="text-base text-ink">
          この日の合計 <span className="font-num text-xl font-bold">{fmtMl(fluidTotal)}</span>
        </p>
        <div className="flex flex-wrap items-end gap-gap" role="group" aria-label="水分を足す">
          {DAYCARE_FLUID_STEPS.map((ml) => (
            <button
              key={ml}
              type="button"
              disabled={!canWrite || fluidBusy}
              onClick={() => void addFluid(ml)}
              className="min-h-tap rounded border border-primary bg-surface px-4 text-lg font-bold text-primary disabled:border-border disabled:text-ink3"
            >
              ＋{ml}
            </button>
          ))}
          <label className="text-sm text-ink2">
            ほかの量（ml）
            <input
              type="text"
              inputMode="numeric"
              value={fluidOther}
              onChange={(e) => setFluidOther(e.target.value)}
              className="mt-1 block min-h-tap w-28 rounded border border-border-strong bg-surface px-3 text-lg text-ink"
            />
          </label>
          <button
            type="button"
            disabled={!canWrite || fluidBusy || fluidOther === '' || otherErr !== null}
            onClick={() => {
              const n = Number(fluidOther.normalize('NFKC').trim())
              setFluidOther('')
              void addFluid(n)
            }}
            className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink disabled:text-ink3"
          >
            足す
          </button>
        </div>
        {otherErr !== null ? (
          <p role="alert" className="text-sm text-danger">
            <span aria-hidden="true">▲ </span>
            {otherErr}
          </p>
        ) : null}
        {fluidMsg !== null && fluidMsg.key === personKey ? (
          <p role={fluidMsg.tone === 'danger' ? 'alert' : 'status'} className={`text-sm ${fluidMsg.tone === 'danger' ? 'text-danger' : fluidMsg.tone === 'warn' ? 'text-warn' : 'text-ink2'}`}>
            <span aria-hidden="true">{fluidMsg.tone === 'info' ? '⚠ ' : '▲ '}</span>
            {fluidMsg.text}
          </p>
        ) : null}
        <ul aria-label="この日の水分の記録" className="space-y-1">
          {fluidsOf.length === 0 && queuedNow === null ? <li className="text-base text-ink2">まだ記録はありません</li> : null}
          {queuedNow !== null ? (
            <li className={`text-base ${queuedNow.lost ? 'text-danger' : 'text-ink2'}`}>
              <span aria-hidden="true">⚠ </span>
              {queuedNow.lost ? '送れていない（この端末にも控えなし）' : '送信待ち'} ＋{fmtMl(queuedNow.ml)}（合計に含めています）
            </li>
          ) : null}
          {fluidsOf.map((f) => (
            <li key={f.id} className="space-y-1 text-base text-ink">
              <div className="flex flex-wrap items-center justify-between gap-gap">
                <span>
                  {f.taken_at === null ? '時刻なし' : f.taken_at.slice(0, 5)}　{fmtMl(f.amount_ml)}
                </span>
                <button
                  type="button"
                  disabled={!canWrite}
                  onClick={() => setDelFluid(f)}
                  aria-label={`${f.taken_at === null ? '時刻なし' : f.taken_at.slice(0, 5)} の ${fmtMl(f.amount_ml)} を取り消す`}
                  className="min-h-tap rounded border border-danger px-3 text-base text-danger disabled:border-border disabled:text-ink3"
                >
                  取り消す
                </button>
              </div>
              {marks.button({ kind: 'fluid', id: f.id }, fluidMarkText(f))}
            </li>
          ))}
        </ul>
      </section>

      {/* 活動・レク（段階2b・0044）。活動だけの旗に従う別の部品（昼食・水分の保存とは混ぜない） */}
      <DaycareActivitySection
        residentId={residentId}
        residentName={name}
        day={data.day}
        today={today}
        actorId={actorId}
        show={show}
        refreshKey={reloadKey}
        markSlot={(a) => marks.button({ kind: 'activity', id: a.id }, activityMarkText(activityText(a)))}
      />

      <section aria-labelledby="h-ex" className={sectionCls}>
        <h3 id="h-ex" className="text-lg font-bold text-ink">
          排泄
        </h3>
        <p className="text-sm text-ink2">排泄ケアアプリの記録です（この画面では読むだけです）。記録は排泄ケアアプリで行います。</p>
        {ex.status === 'loading' ? (
          <LoadingBlock label="排泄ケアアプリの記録を読み込んでいます…" />
        ) : ex.status === 'unconfigured' ? (
          <p className="text-base text-ink2">
            <span aria-hidden="true">ⓘ </span>
            {MSG_EXCRETION_UNCONFIGURED}
          </p>
        ) : ex.status === 'error' ? (
          <ErrorBlock message={ex.message} onRetry={() => setExTick((n) => n + 1)} />
        ) : !ex.view.linked ? (
          <p className="text-base text-warn">
            <span aria-hidden="true">▲ </span>
            {ex.view.message}
          </p>
        ) : (
          <div className="space-y-1 text-base text-ink">
            {exDay === null ? (
              <p>この日の記録は、排泄ケアアプリで見てください（ここに出すのは直近の日だけです）。</p>
            ) : (
              <p>
                この日: 排尿 <span className="font-num font-bold">{exDay.urine}</span>回・排便{' '}
                <span className="font-num font-bold">{exDay.stools.length}</span>回
                {exDay.laxatives.length > 0 ? <>・下剤 {exDay.laxatives.length}回</> : null}
              </p>
            )}
            <p className="text-ink2">
              {ex.view.status.level !== 'ok' ? <span aria-hidden="true">{ex.view.status.level === 'danger' ? '▲▲ ' : '▲ '}</span> : null}
              最後の排便から{ex.view.status.days === null ? '—' : `${ex.view.status.days}${ex.view.status.atLeast ? '日以上' : '日'}`}
            </p>
          </div>
        )}
        <a
          href={haibenAppHref(resident?.source_id)}
          className="inline-flex min-h-tap items-center rounded border border-border-strong px-4 text-base text-link"
        >
          排泄ケアアプリで記録する<span aria-hidden="true"> ›</span>
        </a>
        {marks.button({ kind: 'ex' }, excretionMarkText(exDay), ex.status === 'ok' && ex.view.linked && exDay !== null)}
      </section>

      {marks.dialogs}
      <ConfirmDialog
        open={delFluid !== null}
        title="水分の記録を取り消しますか"
        body={delFluid === null ? '' : `${delFluid.taken_at === null ? '時刻なし' : delFluid.taken_at.slice(0, 5)} の ${fmtMl(delFluid.amount_ml)} を取り消します。`}
        confirmLabel="取り消す"
        danger
        onConfirm={() => delFluid !== null && void removeFluid(delFluid)}
        onCancel={() => setDelFluid(null)}
      />
      {toast}
    </div>
  )
}

/** 昼食・おやつの保存の状態（送信中・送信待ち・食い違い・失敗） */
function MealStatusLine({
  st,
  onTake,
  onMine,
}: {
  st: SaveState | undefined
  onTake: (t: MealTarget, fields?: readonly string[]) => void
  onMine: (t: MealTarget, cs: CellConflict[]) => void
}) {
  if (st === undefined) return null
  if (st.kind === 'saving') return <p className="text-sm text-ink2" role="status">↻ 送信中…</p>
  if (st.kind === 'saved') return <p className="text-sm text-ok" role="status">✓ 保存しました</p>
  if (st.kind === 'queued')
    return (
      <p className="text-sm text-ink2" role="status">
        <span aria-hidden="true">⚠ </span>
        {st.persisted ? MSG_QUEUED : MSG_NOT_PERSISTED}
      </p>
    )
  if (st.kind === 'error')
    return (
      <p className="text-sm text-danger" role="alert">
        <span aria-hidden="true">▲ </span>
        {st.text}
      </p>
    )
  if (st.kind === 'held' || st.kind === 'rejected')
    return (
      <div role="alert" className="space-y-2 rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
        <p>
          <span aria-hidden="true">▲ </span>
          {st.kind === 'held'
            ? '他の端末の記録と食い違って止まっている値があります（送っていません）。上の「いま」はサーバーの値です。'
            : `${st.reason === undefined ? '' : `${st.reason} `}サーバーに受け付けられなかった値があります（送っていません）。上の「いま」はサーバーの値です。`}
          〔取り下げる〕で送信待ちから外し、必要なら押し直してください。
        </p>
        <button type="button" onClick={() => onTake(st.target)} className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink">
          取り下げる
        </button>
      </div>
    )
  const words: Record<string, string> = { main_amount: '主食', side_amount: '副食', status: '状態' }
  const val = (v: unknown) =>
    v === null || v === undefined
      ? '—'
      : v === 'refused'
        ? '拒食'
        : v === 'eaten'
          ? '食べた'
          : v === 'out'
            ? '外出'
            : v === 'hospital'
              ? '入院'
              : String(v)
  return (
    <div role="alert" className="space-y-2 rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
      <p>
        <span aria-hidden="true">▲ </span>
        他の端末が先に記録しました（上の「いま」はサーバーの値です）。
        {st.conflicts.map((c) => `${words[c.field] ?? c.field}: いまの値 ${val(c.server)}（あなた ${val(c.mine)}）`).join('・')}
      </p>
      <div className="flex flex-wrap gap-gap">
        <button
          type="button"
          onClick={() => onTake(st.target, st.conflicts.map((c) => c.field))}
          className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink"
        >
          いまの値にする
        </button>
        <button type="button" onClick={() => onMine(st.target, st.conflicts)} className="min-h-tap rounded border border-primary bg-surface px-3 text-base text-primary">
          あなたの値で直す
        </button>
      </div>
    </div>
  )
}

export default DaycarePersonPage
