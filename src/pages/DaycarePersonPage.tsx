// デイ（せせらぎ）段階2a: 1人の1日記録（/record/daycare/person/:residentId・業務日は ?day=）。
//
// 上から この方（到着・帰宅・休み）・バイタル（要約・入力はバイタル一括）・入浴・昼食・おやつ・水分・排泄（表示と入口）。
// 2026-10-24（代表者の決定 §9.4 の1〜2）: 今日の画面をカードにし、カードに残すボタンを〔休み〕（休みの方は〔取消〕）だけにしたので、
//   到着・帰宅・時刻の直し・休みの理由・休みの取り消し・入浴の操作はこの画面で行う（今日の画面と同じ部品＝DaycareAttendanceOps）。
//   書き込みの下準備（入浴の旗の観測・役割・休業日・開所の写し）はこの画面が自分で取る（入口の画面に頼らない＝M-085）。
//   今日で記録の無い在籍中の方は「予定外」として〔予定外で到着〕を出す（今日の画面の〔予定にない方を追加〕から来た方・〔休み〕は出さない）。
// 〔前の方〕〔次の方〕は、一括の画面と同じ方（予定の方のうち休み・入院中を除く全員と予定外で来た方）を五十音で回る。
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
  cachedMyRole,
  discardPendingRow,
  fetchAllResidents,
  fetchBathDay,
  fetchDaycareAttendance,
  fetchDaycareDay,
  fetchDaycareIntake,
  fetchDaycarePlan,
  fetchDaycareVitals,
  fetchMyRole,
  fetchResidentTargets,
  getAppSetting,
  getKindInputGate,
  hasPendingDaycareAttendance,
  insertFluid,
  isQueuePersisted,
  isSelfWrite,
  kindBlockedMessage,
  openDaycareDay,
  pendingRow,
  queuePending,
  queueSubscribe,
  saveMealEdits,
  softDeleteFluid,
  subscribeBathChanges,
  subscribeChanges,
  subscribeDaycareChanges,
  subscribeMyRole,
} from '../lib/db'
import type { CellConflict, CellEditInput, DaycareMealRow, MealCellField, MealTarget, MyRole } from '../lib/db'
import { RecorderBar } from '../components/RecorderBar'
import { DaycareActivitySection } from '../components/DaycareActivitySection'
import { DaycareTrainingCard } from '../components/DaycareTrainingCard'
import { hasTimes, hmShort, useDaycareAttendanceOps } from '../components/DaycareAttendanceOps'
import { writeDaycareHandoffFor } from '../lib/daycareHandoff'
import {
  daycareDayMemo,
  memoForDay,
  memoWithAttendance,
  memoWithBath,
  memoWithFluid,
  memoWithMeal,
  memoWithoutAttendance,
  memoWithoutFluid,
  rememberDaycareDay,
  updateDaycareDayMemo,
} from '../lib/daycareDayMemo'
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
  canChangeDaycareTimes,
  daycareBathLabel,
  daycareBathStatus,
  fmtPlanTimes,
  nowHm,
  vitalLevel,
} from '../lib/daycare'
import type { DaycareBoardRow, DaycareVitalField, KeyedVital } from '../lib/daycare'
import { useVitalLimits } from '../hooks/useVitalLimits'
import { VitalLimitsFailedNote } from '../components/VitalLimitsFailedNote'
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
/** 食事・水分を読めなかった（その欄だけ止める。出欠・入浴の操作は動かす＝親の検収 軽3） */
const MSG_INTAKE_FAILED = '昼食・おやつ・水分の記録を読めませんでした。通信状態を確認して〔再試行〕を押してください（到着・休み・入浴はこのまま記録できます）。'

interface PersonData {
  day: string
  planRows: DaycarePlanRow[]
  planSource: DaycarePlanSource
  /** その日の写し（無ければ null）。開所の最初のタップ（今日だけ）で作る＝ensureOpened */
  snapshot: DaycareDay | null
  missing: boolean
  attendance: DaycareAttendance[]
  baths: BathRecord[]
  vitals: KeyedVital[]
  meals: DaycareMealRow[]
  fluids: FluidIntake[]
  /** 食事・水分を読めたか（読めない時はその欄だけ「読めませんでした」・出欠と入浴の操作は動かす＝親の検収 軽3） */
  intakeOk: boolean
  /**
   * 食事・水分を、この読み込みでサーバーから読めたか（親の反証 中1・2026-10-25）。intakeOk（表示に使える値がある）と分ける:
   * 静かな読み直しで食事・水分だけ読めなかった時は、前の値を出す（intakeOk）が、送信待ちの水分の消し込み・控えへの書き込みは
   * 「今回読めた」時だけ行う（古い一覧を最新として消し込まない）
   */
  intakeFresh: boolean
  /** サーバーの控え（daycareDayMemo）で開いた時の控えの「読んだ時点」。サーバーから読めた時は null */
  memoAt: number | null
  /** この一覧をサーバーから読めた時刻（控えに入れる「読んだ時点」） */
  readAt: number
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
  if (row.state === 'absent') return `休み（${a?.absent_reason ? DAYCARE_ABSENT_REASON_LABEL[a.absent_reason] : '理由なし'}）`
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
  // 段階2d-2: 個人のバイタルの閾値（印をその方のその日の基準で出す。読めない時は施設の基準・その旨を出す）
  const limits = useVitalLimits(reloadKey)
  const [gate, setGate] = useState<{ value: boolean; observed: boolean; forbidden?: true; outdated?: true } | null>(null)
  /** ログインの役割（事務所・管理者だけ過去の日の到着・帰宅の時刻を入れられる。分からない間は現場と同じ扱い） */
  const [role, setRole] = useState<MyRole | null | undefined>(cachedMyRole())
  /** 休業日（入浴の「全身浴」を休業日は訪問介護で入浴にする） */
  const [closedDates, setClosedDates] = useState<string | null>(null)
  const opening = useRef<Promise<void> | null>(null)
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

  // 時計（60秒ごと・画面に戻った時に今日を取り直す＝今日の画面と同じ）。到着・休みをこの画面で押すので、前の日のまま眠っていた端末を
  // 起こした直後に前の日へ書かないように、画面に戻った時にもすぐ取り直す（反証 軽4）
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

  // 入浴の旗（input_enabled_bath）も開くたびに取り直す（表示には使わない）。この画面の入浴の記録（〔予定どおり実施〕・区分・休み）は、
  // 端末が「入浴を記録できる」を一度観測していれば、電波が無くても送信待ちに積まれる（db.ts の assertKindWritable）。
  // 今日の画面と同じく、この画面が自分で取る（入口の画面に頼らない＝M-085・#43）
  useEffect(() => {
    void getKindInputGate('bath').catch(() => undefined)
  }, [reloadKey])

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

  useEffect(() => {
    let alive = true
    Promise.all([
      fetchAllResidents(),
      fetchResidentTargets().catch(() => new Map<number, ResidentTargets>()),
      getAppSetting('daycare_closed_dates').catch(() => null),
    ])
      .then(([all, tg, closed]) => {
        if (!alive) return
        setResidents(all)
        setTargets(tg)
        setClosedDates(closed)
      })
      .catch(() => {
        // 名簿が読めない（電波が無い）時は、今日の画面が読んだ控えの名簿で氏名を出す（控えは画面のメモリだけ）
        const m = daycareDayMemo()
        if (alive && m !== null && m.residents.length > 0) setResidents((prev) => (prev.length > 0 ? prev : m.residents))
      })
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
        fetchDaycareIntake(target).catch(() => null),
      ])
      if (gen !== genRef.current || target !== dayRef.current) return
      setData((prev) => {
        // 静かな読み直し（他の端末の変更・送信待ちの減り）で食事・水分だけ読めない時は、いまの食事・水分を残す（空の一覧を
        // 「サーバーに何も無い」と見て、送信待ちの水分の消し込み・取り消した行の隠しを誤らせない＝確認の反証 中2）
        const keep = intake === null && quiet && prev !== null && prev.day === target && prev.intakeOk
        return {
          day: target,
          planRows: usable && snapshot !== null ? snapshot.plan_rows : (plan?.rows ?? []),
          planSource: usable && snapshot !== null ? snapshot.plan_source : (plan?.source ?? 'unknown'),
          snapshot,
          missing: missing || plan?.missing === true,
          attendance,
          baths,
          vitals: dv.live,
          meals: intake?.meals ?? (keep ? prev.meals : []),
          fluids: intake?.fluids ?? (keep ? prev.fluids : []),
          intakeOk: intake !== null || keep,
          intakeFresh: intake !== null,
          // 控えで開いた画面の食事・水分を残した時は、控えのまま（サーバーの値へ上げない＝帯を残し、控えに書き戻さない）
          memoAt: keep ? prev.memoAt : null,
          readAt: keep && prev.memoAt !== null ? prev.readAt : Date.now(),
        }
      })
      setError(null)
    } catch (e) {
      if (gen !== genRef.current) return
      // 電波が無い（通信の失敗）: 今日の画面が読んだ同じ日の控えがあれば、それで開く（到着・休み・入浴は送信待ちに積める＝親の検収 中1）。
      // 静かな読み直し（他の端末の変更・送信待ちの減り）の失敗では、いま出している内容を残す
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
          meals: m.meals,
          fluids: m.fluids,
          intakeOk: m.intakeOk,
          intakeFresh: false,
          memoAt: m.savedAt,
          readAt: m.savedAt,
        })
        setError(null)
        return
      }
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

  // サーバーから読めた一覧は控えにも入れる（次の方へ移った先で電波が切れても開ける）。控えで開いた時・食事を今回読めなかった時は入れない
  useEffect(() => {
    if (data === null || data.memoAt !== null || !data.intakeFresh || data.missing) return
    rememberDaycareDay({
      day: data.day,
      planRows: data.planRows,
      planSource: data.planSource,
      snapshot: data.snapshot,
      missing: data.missing,
      attendance: data.attendance,
      baths: data.baths,
      vitals: data.vitals,
      meals: data.meals,
      fluids: data.fluids,
      intakeOk: data.intakeOk,
      residents,
      savedAt: data.readAt,
    })
  }, [data, residents])

  // 控えで開いている間は、30秒ごとに静かに読み直す（電波が「切れた」と扱われないまま戻った時＝弱い電波・電波の無い Wi-Fi でも、
  // サーバーの内容に戻して帯を消す＝確認の反証 軽3）。読めない間は今の内容のまま
  const onMemo = data !== null && data.memoAt !== null
  useEffect(() => {
    if (!onMemo) return
    const t = window.setInterval(() => scheduleReload(), 30_000)
    return () => window.clearInterval(t)
  }, [onMemo, scheduleReload])

  const resident = useMemo(() => residents.find((r) => r.id === residentId) ?? null, [residents, residentId])
  // 今日の画面の〔予定にない方を追加〕から来た方（予定も記録も無い在籍中の方）は、予定外として足す（〔予定外で到着〕を出す）
  const extraSelf = resident !== null && resident.active
  const board = useMemo(
    () =>
      data === null
        ? null
        : buildDaycareBoard({ planRows: data.planRows, source: data.planSource, residents, attendance: data.attendance, extraIds: extraSelf ? [residentId] : [] }),
    [data, residents, extraSelf, residentId],
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

  /** 開所の最初のタップ（今日だけ）: その日の予定の写しを作る。通信できない時は次のタップでもう一度（記録は止めない）＝今日の画面と同じ */
  const ensureOpened = useCallback(async () => {
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
        // 写しは次のタップで作り直す（到着・休みの記録そのものは止めない）
      } finally {
        opening.current = null
      }
    })()
    return opening.current
  }, [data, day, actorId])

  // ── 到着・帰宅・休み・入浴（今日の画面と同じ部品。2026-10-24 §9.4 でカードから移した操作） ──
  const ops = useDaycareAttendanceOps({
    place: 'person',
    day,
    today,
    role,
    gate,
    canWrite: gate !== null && gate.observed && gate.value === true && !(data?.missing ?? false),
    actorId,
    closedDates,
    nameOf,
    bathOf: (id) => (data === null ? null : (data.baths.find((b) => b.resident_id === id) ?? null)),
    // 画面の data を直す時に、控えも同じ形で直す（控えで開いている間に書けた記録を、前の方・次の方や今日の画面でも出す＝親の確かめ 中2）
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
    resetKey: `${residentId}:${reloadKey}`,
  })

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

  /** 昼食・おやつ・水分の書き込みの前の確かめ（食事・水分を読めていない時は書かない＝基準の値が分からないため） */
  const precheck = (): string | null => {
    if (!canWrite) {
      return gate?.forbidden ? FORBIDDEN_REASON : gate?.outdated ? OUTDATED_REASON : gate?.observed ? kindBlockedMessage('daycare') : MSG_GATE_UNKNOWN
    }
    if (data !== null && !data.intakeOk) return MSG_INTAKE_FAILED
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
        // 画面と同じ形で控えも直す（親の反証 中2）。取り込み・画面の入力の印は、いま出している行から引き継ぐ
        const oldRow = (data?.meals ?? []).find((m) => m.meal.id === saved.id)
        updateDaycareDayMemo((m) =>
          memoWithMeal(m, { meal: saved, imported: oldRow?.imported ?? false, editedInApp: (oldRow?.editedInApp ?? false) || wrote }),
        )
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
    // 食事・水分を今回サーバーから読めていない時（空の一覧・前の値・控えの値）は消し込まない（確認の反証 中2・親の反証 中1）
    if (data === null || !data.intakeFresh) return
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
      if (data === null || !data.intakeFresh || !m.key.endsWith(`:${data.day}`)) return m
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
      // 画面と同じ形で控えにも足す（控えで開いている間に書けた水分を、前の方・次の方で戻っても出す＝親の反証 中2）
      updateDaycareDayMemo((m) => memoWithFluid(m, saved))
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
        updateDaycareDayMemo((m) => memoWithoutFluid(m, f))
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
          className="inline-flex min-h-tap items-center rounded border border-border-strong bg-surface px-4 text-base text-ink"
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
      {data !== null && data.memoAt !== null ? (
        // 電波が無く、今日の画面が読んだ控えで開いた（親の検収 中1）。押した記録は送信待ちに積み、電波が戻ると送って読み直す
        <p role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          サーバーに届かないため、今日の一覧で読んだ時点（{new Date(data.memoAt).toTimeString().slice(0, 5)}）の内容です。押した記録は送信待ちに積みます（つながると自動で送信します）。
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
  const bst = daycareBathStatus(bath, row?.bathingPlanned ?? false)
  const bathText = daycareBathLabel(bst)
  // 到着・帰宅・休み・入浴の操作の出し分け（今日の画面の1人1行と同じ決まり。2026-10-24 にカードからこの画面へ移した）
  const att = row?.attendance ?? null
  const attPending = row !== undefined && hasPendingDaycareAttendance(residentId, day, att?.id ?? null)
  const opsDisabled = !canWrite || ops.busy.has(residentId) || attPending
  /** 到着・帰宅の時刻を変える操作: 今日は誰でも・過去の日は事務所のログインだけ（0042 のトリガと同じ規則） */
  const timesOk = canChangeDaycareTimes(day, today, role)
  const attended = row !== undefined && (row.state === 'present' || row.state === 'left')
  const hospitalizedPlanned = row !== undefined && row.hospitalized && row.state === 'planned'
  /**
   * 予定も記録も無い在籍中の方（今日の画面の〔予定にない方を追加〕から来た方）: ボタンの名前を〔予定外で到着〕と分ける
   * （予定の無い方の画面を誤って開いても、ふつうの〔到着〕と見分けられる＝2026-10-24 親の回答 A3）。
   * care-log の名簿には入院の印が無いので、入院中かはその日の昼食・おやつの記録の「入院」で見て、入院の方には出さない。
   * 「記録が無い」は行の有無でなく「到着・帰宅の時刻も休みも無い」で見る（到着の〔元に戻す〕・休みの〔取消〕の後の空の行でも同じ扱い＝確認の反証 軽1）。
   * 照合できない予定でも 12:30 の自動の入浴の相手（autoBath）は予定のある方と同じに扱う（〔到着〕〔休み〕を出す＝休みで自動の入浴を「中止（欠席）」に直せる）
   */
  const extraNoRecord = row !== undefined && row.extra && !row.planned && row.autoBath !== true && !hasTimes(row) && att?.absent !== true
  const hospitalMeal = data.meals.some((m) => m.meal.resident_id === residentId && m.meal.status === 'hospital')
  /** 休みの方に入浴の記録（自動・人の入浴）が残っている＝「欠席」に直す要る */
  const absentBathLeft = row !== undefined && row.state === 'absent' && (bst.kind === 'auto' || bst.kind === 'done')
  const opsMsg = ops.rowMsg.get(residentId)
  const opBtn = 'min-h-tap min-w-tap rounded border border-border-strong bg-surface px-4 text-base text-ink disabled:text-ink3'
  const opPrimary =
    'min-h-tap min-w-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border disabled:bg-surface2 disabled:text-ink3'
  const opDanger = 'min-h-tap min-w-tap rounded border border-danger bg-surface px-4 text-base text-danger disabled:border-border disabled:text-ink3'
  const opRest =
    'min-h-tap min-w-[5rem] rounded border-2 border-border-strong bg-surface px-4 text-base font-bold text-ink disabled:border-border disabled:text-ink3'
  const lunchRow = mealRowOf('lunch')
  const lunch = mealShown('lunch')
  const snack = mealShown('snack')
  const queuedNow = queuedFluids[personKey] ?? null
  const fluidTotal = fluidTotalOf(fluidsOf, residentId, data.day) + (queuedNow?.ml ?? 0)
  const sectionCls = 'rounded-lg border border-border bg-surface p-3 space-y-2'
  /** 昼食・おやつ・水分の欄を押せるか（食事・水分を読めていない時は押せない） */
  const intakeWritable = canWrite && data.intakeOk
  const intakeFailedNote = data.intakeOk ? null : (
    <div role="alert" className="space-y-2 rounded border border-warn bg-warn-bg p-2 text-base text-ink">
      <p>
        <span aria-hidden="true">▲ </span>
        {MSG_INTAKE_FAILED}
      </p>
      <button type="button" onClick={() => setReloadKey((n) => n + 1)} className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink">
        再試行
      </button>
    </div>
  )
  const chipCls = (on: boolean) =>
    on
      ? 'min-h-tap min-w-tap rounded border-2 border-primary bg-primary px-2 text-lg font-bold text-primary-ink'
      : 'min-h-tap min-w-tap rounded border border-border-strong bg-surface px-2 text-lg text-ink disabled:text-ink3'

  const exDay = ex.status === 'ok' && ex.view.linked ? (ex.view.days.find((d) => d.day === data.day) ?? null) : null

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      {header}
      {limits.failed ? <VitalLimitsFailedNote className="" onRetry={() => void limits.refresh()} /> : null}

      <section aria-label="この方" className="rounded-lg border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-gap">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-ink">{name}</h2>
            {resident?.kana ? <p className="text-sm text-ink2">{resident.kana}</p> : null}
            <p className="text-base text-ink2">
              {stateText(row)}
              {row !== undefined && row.planned && !row.dup && row.plans.length === 1 ? `（予定 ${fmtPlanTimes(row.plans)}）` : null}
            </p>
          </div>
          <div className="flex flex-wrap gap-gap" role="group" aria-label="予定の方を順に">
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

      <section aria-labelledby="h-att" className={sectionCls}>
        <h3 id="h-att" className="text-lg font-bold text-ink">
          到着・帰宅・休み
        </h3>
        {row === undefined ? (
          <p className="text-base text-ink2">この日の予定・記録はありません（在籍中の方ではないため、ここからは記録できません）。</p>
        ) : (
          <>
            {row.state === 'absent' ? null : hospitalizedPlanned ? (
              <p className="text-base text-ink2">週間計画で入院中です。</p>
            ) : extraNoRecord && hospitalMeal ? (
              <p className="text-base text-ink2">
                {data.planSource === 'unknown' ? '予定を確かめられません（週間計画の写しが読めません）。' : 'この日のデイの予定はありません。'}
                食事の記録が「入院」のため、ここからは到着を記録しません。
              </p>
            ) : (
              <p className="text-base text-ink">
                到着 <span className="font-num font-bold">{att?.arrived_at ? hmShort(att.arrived_at) : '—'}</span>
                <span className="ml-4">帰宅 </span>
                <span className="font-num font-bold">{att?.left_at ? hmShort(att.left_at) : '—'}</span>
              </p>
            )}
            <div className="flex flex-wrap gap-gap" role="group" aria-label="到着・帰宅・休みの操作">
              {row.state === 'absent' ? (
                <>
                  <button type="button" onClick={() => ops.askAbsent(row)} disabled={opsDisabled} className={opBtn}>
                    理由を選ぶ
                  </button>
                  <button type="button" onClick={() => ops.askCancelAbsent(row)} disabled={opsDisabled} className={opDanger}>
                    休みを取り消す
                  </button>
                </>
              ) : hospitalizedPlanned || (extraNoRecord && hospitalMeal) ? null : (
                <>
                  {att?.arrived_at ? null : (
                    <button
                      type="button"
                      onClick={() => void ops.onArrive(row)}
                      disabled={opsDisabled || !timesOk}
                      aria-label={
                        extraNoRecord
                          ? `${name}さんを予定外で到着にする（${data.planSource === 'unknown' ? '予定を確かめられません' : 'この日のデイの予定はありません'}）`
                          : undefined
                      }
                      className={opPrimary}
                    >
                      {extraNoRecord ? '予定外で到着' : '到着'}
                    </button>
                  )}
                  {row.state === 'present' ? (
                    <button type="button" onClick={() => void ops.onLeave(row)} disabled={opsDisabled || !timesOk} className={opPrimary}>
                      帰宅
                    </button>
                  ) : null}
                  {hasTimes(row) && timesOk ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (ops.precheck(row)) ops.openTime(row, 'fix')
                      }}
                      disabled={opsDisabled}
                      className={opBtn}
                    >
                      時刻を直す
                    </button>
                  ) : null}
                  {/* 予定も記録も無い方（予定外で開いた方・日を送って予定の無い日に来た方）には〔休み〕を出さない（休みは予定の方の記録＝反証 軽2） */}
                  {extraNoRecord ? null : (
                    <button type="button" onClick={() => ops.onRest(row)} disabled={opsDisabled || (hasTimes(row) && !timesOk)} className={opRest}>
                      休み
                    </button>
                  )}
                </>
              )}
            </div>
            {extraNoRecord && !hospitalMeal ? (
              <p className="text-sm text-ink2">
                {data.planSource === 'unknown' ? '予定を確かめられません（週間計画の写しが読めません）。' : 'この日のデイの予定はありません。'}
                来所した時だけ〔予定外で到着〕を押してください。
              </p>
            ) : null}
            {!timesOk && day < today ? (
              <p className="text-sm text-ink2">過去の日の到着・帰宅の時刻は、事務所のログインで入力・修正します。</p>
            ) : null}
          </>
        )}
        {attPending ? (
          <p className="text-sm text-ink2" role="status">
            <span aria-hidden="true">↻ </span>未送信の記録があります（電波が戻ると自動で送信します）
          </p>
        ) : null}
        {opsMsg !== undefined ? (
          <p
            role={opsMsg.tone === 'danger' ? 'alert' : 'status'}
            className={`rounded border p-2 text-sm text-ink ${
              opsMsg.tone === 'danger' ? 'border-danger bg-danger-bg' : opsMsg.tone === 'warn' ? 'border-warn bg-warn-bg' : 'border-border bg-surface2'
            }`}
          >
            {opsMsg.tone === 'danger' || opsMsg.tone === 'warn' ? <span aria-hidden="true">▲ </span> : null}
            {opsMsg.text}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="h-vital" className={sectionCls}>
        <h3 id="h-vital" className="text-lg font-bold text-ink">
          バイタル
        </h3>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-base text-ink">
          {DAYCARE_VITAL_FIELDS.map((f) => {
            const v = latestOf(f)
            const lv = vitalLevel(f, v, targets.get(residentId), limits.lookup(residentId, data.day))
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
        <p className={absentBathLeft ? 'rounded border-2 border-warn bg-warn-bg p-2 text-base font-bold text-ink' : 'text-base text-ink'}>
          {absentBathLeft ? <span aria-hidden="true">▲ </span> : null}
          {bathText}
          {absentBathLeft ? '（休みの方に入浴の記録が残っています）' : null}
        </p>
        {/* 入浴の操作（2026-10-24 に今日の画面の入浴の欄から移した。来た方は区分・中止、休みの方は残った入浴を「欠席」に直す） */}
        {row !== undefined && (attended || absentBathLeft) ? (
          <div className="flex flex-wrap gap-gap" role="group" aria-label="入浴の記録">
            {attended && bst.kind === 'todo' ? (
              <button type="button" onClick={() => ops.onBathAsPlanned(row)} disabled={opsDisabled} className={opPrimary}>
                予定どおり実施
              </button>
            ) : null}
            <button type="button" onClick={() => ops.openBath(row)} disabled={opsDisabled} className={opBtn}>
              {absentBathLeft ? '入浴を「欠席」に直す' : '区分・中止を選ぶ'}
            </button>
          </div>
        ) : (
          <p className="text-sm text-ink2">入浴は、到着の後に記録できます。</p>
        )}
      </section>

      {intakeFailedNote}
      <section aria-labelledby="h-lunch" className={sectionCls}>
        <div className="flex flex-wrap items-baseline justify-between gap-gap">
          <h3 id="h-lunch" className="text-lg font-bold text-ink">
            昼食
          </h3>
          {mealSourceLabel(lunchRow) !== null ? <span className="text-sm text-ink2">{mealSourceLabel(lunchRow)}</span> : null}
        </div>
        <p className="text-base text-ink">
          いま: <span className="font-bold">{data.intakeOk ? lunchLabel(lunch) : '—（読めませんでした）'}</span>
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
                  disabled={!intakeWritable}
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
            disabled={!intakeWritable}
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
          いま: <span className="font-bold">{data.intakeOk ? snackLabel(snack) : '—（読めませんでした）'}</span>
        </p>
        <div className="flex flex-wrap gap-gap" role="group" aria-label="おやつ">
          {DAYCARE_SNACK_CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-pressed={snack?.main_amount === c.value && (snack?.status ?? 'eaten') === 'eaten'}
              disabled={!intakeWritable}
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
          この日の合計 <span className="font-num text-xl font-bold">{data.intakeOk ? fmtMl(fluidTotal) : '—（読めませんでした）'}</span>
        </p>
        <div className="flex flex-wrap items-end gap-gap" role="group" aria-label="水分を足す">
          {DAYCARE_FLUID_STEPS.map((ml) => (
            <button
              key={ml}
              type="button"
              disabled={!intakeWritable || fluidBusy}
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
            disabled={!intakeWritable || fluidBusy || fluidOther === '' || otherErr !== null}
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
          {fluidsOf.length === 0 && queuedNow === null ? (
            <li className="text-base text-ink2">{data.intakeOk ? 'まだ記録はありません' : '読めませんでした（上の〔再試行〕を押してください）'}</li>
          ) : null}
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
                  disabled={!intakeWritable}
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

      {/* 個別機能訓練（段階3a・0046）。読むだけ（記録は機能訓練の画面）。機能訓練だけの旗に従う */}
      <DaycareTrainingCard
        residentId={residentId}
        day={data.day}
        today={today}
        refreshKey={reloadKey}
        staffName={(id) => (staff ?? []).find((s) => s.id === id)?.name ?? `職員ID ${id}`}
        active={resident?.active}
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
          // 押した直前に受け渡しのキーを書き直す（排泄ケアアプリはデイの表示で開き、その方を選ぶ＝§9.7・§9.8 の A4）
          onClick={() => writeDaycareHandoffFor({ rows: board?.rows ?? null, residents, boardDay: data?.day ?? null, today })}
          onAuxClick={() => writeDaycareHandoffFor({ rows: board?.rows ?? null, residents, boardDay: data?.day ?? null, today })}
          onContextMenu={() => writeDaycareHandoffFor({ rows: board?.rows ?? null, residents, boardDay: data?.day ?? null, today })}
          className="inline-flex min-h-tap items-center rounded border border-border-strong px-4 text-base text-link"
        >
          排泄ケアアプリで記録する<span aria-hidden="true"> ›</span>
        </a>
        {marks.button({ kind: 'ex' }, excretionMarkText(exDay), ex.status === 'ok' && ex.view.linked && exDay !== null)}
      </section>

      {marks.dialogs}
      {ops.dialogs}
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
