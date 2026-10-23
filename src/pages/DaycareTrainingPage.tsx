// デイ（せせらぎ）段階3a: 個別機能訓練の画面（/record/daycare/training・?day= で業務日）。
// 2026-10-23 代表者承認・段階3の計画 v1 の 1章（画面とタップ数）・3章・5章・6章・8章。
//
// ・その日の配置: 機能訓練指導員・看護職員を職員が選ぶ（手入力が正本・資格の判定はしない）。時間帯は任意。
//   機能訓練指導員が1人もいない日・時間帯を分けずに両方の役割に入っている方は、止めずに知らせる
// ・今日の対象者: その日に来た方（在席・帰宅）。〔完了〕は1タップ（内容＝前回・時間＝20分・指導員＝その日の配置の機能訓練指導員・
//   開始時刻＝押した時刻−時間。取り消しはトーストの〔元に戻す〕）。前回の内容が無い方・配置に指導員がいない時は、小窓で入れる
// ・〔一部〕〔中止〕〔記録を開く〕は小窓。中止は時間を持たず理由が必須（その他は一言も）。記録がある方には〔完了〕を出さない（1人1日1件）
// ・過去の日は事務所のログインだけが入力・修正できる（0046 のトリガと同じ決まり。現場は見るだけ）
// ・入力解禁は機能訓練だけの旗 input_enabled_daycare_training。表が無い DB は「設定待ち」
// ・端末に業務データを残さない（localStorage を使わない）。送り先（方・日）は押した時に固定する

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  DbError,
  FORBIDDEN_REASON,
  OUTDATED_REASON,
  fetchAllResidents,
  fetchDaycareAttendance,
  fetchDaycareDay,
  fetchDaycarePlan,
  fetchDaycarePlanWeek,
  fetchMyRole,
  fetchRecentTrainingSessions,
  fetchStaffing,
  fetchTrainingDueCopy,
  fetchTrainingSessions,
  getKindInputGate,
  insertStaffing,
  insertTrainingSession,
  isQueuePersisted,
  isSelfWrite,
  isTrainingMissingError,
  kindBlockedMessage,
  pendingTrainingOps,
  queuePending,
  queueSubscribe,
  softDeleteStaffing,
  softDeleteTrainingSession,
  subscribeDaycareChanges,
  subscribeDaycareTrainingChanges,
  updateTrainingSession,
} from '../lib/db'
import type { MyRole } from '../lib/db'
import { RecorderBar } from '../components/RecorderBar'
import { DaycareHomeVisitSection } from '../components/DaycareHomeVisitSection'
import { DaycareReviewDueSection } from '../components/DaycareReviewDueSection'
import { TARGET_NO_PLAN_LABEL, orderTargetsByPlan, weekScope } from '../lib/trainingDue'
import type { DueCopyLoad, WeekScope } from '../lib/trainingDue'
import { ConfirmDialog, ErrorBlock, LoadingBlock, ModalShell, useToast } from '../components/ui'
import { buildDaycareBoard, canEditPastDaycareTimes } from '../lib/daycare'
import {
  STAFFING_ROLES,
  STAFFING_ROLE_LABEL,
  TRAINING_CANCEL_NOTE_MAX,
  TRAINING_CANCEL_REASONS,
  TRAINING_CANCEL_REASON_LABEL,
  TRAINING_DEFAULT_MIN,
  TRAINING_NOTE_MAX,
  TRAINING_PROGRAM_CHIPS,
  TRAINING_PROGRAM_MAX,
  TRAINING_RESULTS,
  TRAINING_RESULT_LABEL,
  defaultStartTime,
  dualRoleWithoutTime,
  instructorFor,
  previousProgram,
  sessionOf,
  sessionText,
  sessionsOutsideTargets,
  staffingTimeText,
  trainersOf,
  trainingInputErrors,
  trainingPayload,
  trainingTargets,
} from '../lib/daycareTraining'
import type { DaycareStaffing, DaycareTrainingSession, StaffingRole, TrainingInput, TrainingResult } from '../lib/daycareTraining'
import { personPath, readPersonDay } from '../lib/daycarePerson'
import { addDays, fmtDayLabel, todayIso } from '../lib/format'
import type { DaycareAttendance, DaycareDay, DaycarePlanRow, DaycarePlanSource, Resident, Staff } from '../lib/types'
import { DaycareNav } from './DaycarePage'

const ERR_LOAD = 'デイの記録を読み込めませんでした。通信状態を確認して、再試行してください。'
const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから入れてください。'
const MSG_GATE_UNKNOWN =
  'デイの機能訓練の記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。記録の閲覧はこのままできます。'
const MSG_MISSING = 'デイの機能訓練の記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。'
const MSG_PAST = '過去の日の機能訓練の記録と配置は、事務所のログインでだけ入力・修正できます（現場の端末は見るだけです）。'
const MSG_QUEUED = '電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度押してください。'
const MSG_TAKEN = '先に別の端末で記録されていました。その記録を開きました。確かめてください。'
const MSG_CONFLICT = '他の端末で先に直されていました。読み直しました。確かめてから、もう一度直してください。'
const MSG_STOPPED =
  '送れずに止まっている記録があります。設定の「送れていない記録」で、いまの記録とくらべて選ぶか、取り下げてください。'
const MSG_PAST_START = '過去の日の記録です。開始時刻を実際の時刻で入れてください（押した時刻は使いません）。'

/** 機能訓練の画面のルート（業務日は ?day= で持つ。今日は付けない） */
export function trainingPath(day: string, today: string): string {
  return `/record/daycare/training${day === today ? '' : `?day=${day}`}`
}

interface TrainingData {
  day: string
  planRows: DaycarePlanRow[]
  planSource: DaycarePlanSource
  attendance: DaycareAttendance[]
  /** null＝読めない（表が無い・通信エラー） */
  sessions: DaycareTrainingSession[] | null
  staffing: DaycareStaffing[] | null
  /** 前回の内容を選ぶ元（読めない時は空＝前回なし扱い） */
  recent: DaycareTrainingSession[]
  missing: boolean
  /** 計画書の期限の写し（段階3c。'missing'＝表が無い・'error'＝読めない） */
  copy: DueCopyLoad | 'missing'
}

type Gate = { value: boolean; observed: boolean; forbidden?: true; outdated?: true }
type Msg = { tone: 'info' | 'warn' | 'danger'; text: string }
/** 小窓（新しい記録は row=null・その方・その日を押した時に固定する） */
type Editor = { rid: number; day: string; row: DaycareTrainingSession | null; input: TrainingInput; note?: string; showErr?: true }

export interface DaycareTrainingPageProps {
  staff?: Staff[] | null
  actorId?: number | null
}

const nowMinutes = () => {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

export function DaycareTrainingPage({ staff = undefined, actorId = null }: DaycareTrainingPageProps = {}) {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const [today, setToday] = useState(todayIso())
  const day = readPersonDay(search.get('day'), today)
  const [data, setData] = useState<TrainingData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [residents, setResidents] = useState<Resident[]>([])
  const [gate, setGate] = useState<Gate | null>(null)
  const [role, setRole] = useState<MyRole | null>(null)
  const [busy, setBusy] = useState(false)
  const [rowMsg, setRowMsg] = useState<{ rid: number; day: string; msg: Msg } | null>(null)
  const [staffMsg, setStaffMsg] = useState<{ day: string; msg: Msg } | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [delSession, setDelSession] = useState<{ row: DaycareTrainingSession; name: string } | null>(null)
  const [delStaff, setDelStaff] = useState<DaycareStaffing | null>(null)
  const [addRole, setAddRole] = useState<StaffingRole>('trainer')
  const [addStaffId, setAddStaffId] = useState<string>('')
  const [addFrom, setAddFrom] = useState('')
  const [addTo, setAddTo] = useState('')
  const [, setQueueTick] = useState(0)
  /** 読み直しの回数（居宅訪問の区画も合わせて読み直す・段階3b） */
  const [dataTick, setDataTick] = useState(0)
  /**
   * 週間計画で、週のどこかの曜日にデイの予定がある方（見直しの期限の一覧を絞る・積み残し 51）。
   * undefined＝読み込み中。ids が null なら絞らない（読めない・照合できない予定がある＝多めに出す）
   */
  const [week, setWeek] = useState<WeekScope | undefined>(undefined)
  const { toast, show } = useToast()
  const genRef = useRef(0)
  const dayRef = useRef(day)
  dayRef.current = day

  useEffect(() => {
    const t = window.setInterval(() => setToday(todayIso()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    let alive = true
    setGate(null)
    getKindInputGate('daycare_training')
      .then((g) => alive && setGate(g))
      .catch(() => alive && setGate({ value: false, observed: false }))
    fetchAllResidents()
      .then((all) => alive && setResidents(all))
      .catch(() => {})
    fetchMyRole()
      .then((r) => alive && setRole(r))
      .catch(() => {})
    fetchDaycarePlanWeek(todayIso())
      .then((plans) => alive && setWeek(weekScope(plans)))
      .catch(() => alive && setWeek({ ids: null, reason: 'unread', unmatched: 0 }))
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
      let dayMissing = false
      try {
        snapshot = await fetchDaycareDay(target)
      } catch (e) {
        if (e instanceof DbError && e.kind === 'server') dayMissing = true
        else throw e
      }
      const usable = snapshot !== null && snapshot.plan_source !== 'unknown'
      let missing = false
      const onTrainingError = (e: unknown) => {
        if (isTrainingMissingError(e)) missing = true
        return null
      }
      const [plan, attendance, sessions, staffing, recent, copy] = await Promise.all([
        usable ? Promise.resolve(null) : fetchDaycarePlan(target),
        dayMissing ? Promise.resolve([] as DaycareAttendance[]) : fetchDaycareAttendance(target),
        fetchTrainingSessions(target).catch(onTrainingError),
        fetchStaffing(target).catch(onTrainingError),
        fetchRecentTrainingSessions(target).catch(() => [] as DaycareTrainingSession[]),
        // 計画書の期限の写し（読むだけ・見直しの期限と対象者の並びに使う。読めない時は「確かめられません」）
        fetchTrainingDueCopy().catch((e: unknown): 'missing' | 'error' => (isTrainingMissingError(e) ? 'missing' : 'error')),
      ])
      if (gen !== genRef.current || target !== dayRef.current) return
      setData({
        day: target,
        planRows: usable && snapshot !== null ? snapshot.plan_rows : (plan?.rows ?? []),
        planSource: usable && snapshot !== null ? snapshot.plan_source : (plan?.source ?? 'unknown'),
        attendance,
        sessions,
        staffing,
        recent: recent ?? [],
        missing,
        copy,
      })
      setDataTick((n) => n + 1)
      setError(null)
    } catch {
      if (gen !== genRef.current) return
      if (!quiet) setError(ERR_LOAD)
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setRowMsg(null)
    setStaffMsg(null)
    setEditor(null)
    void load(day, false)
  }, [day, reloadKey, load])

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
    const offB = subscribeDaycareTrainingChanges(onChange)
    let last = queuePending()
    const offQ = queueSubscribe((n) => {
      setQueueTick((x) => x + 1)
      if (n < last) scheduleReload()
      last = n
    })
    return () => {
      offA()
      offB()
      offQ()
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    }
  }, [scheduleReload])

  const board = useMemo(
    () => (data === null ? null : buildDaycareBoard({ planRows: data.planRows, source: data.planSource, residents, attendance: data.attendance })),
    [data, residents],
  )
  const targets = board === null ? [] : trainingTargets(board.rows)
  // 計画書の写しで「計画がある・終了でない方」を上に（計画 6章）。写しが無い・読めない時は到着の並びのまま
  const planOrder =
    data === null || data.copy === 'missing'
      ? null
      : orderTargetsByPlan({ targets, copy: data.copy, people: residents.map((r) => ({ id: r.id, active: r.active })), today })
  const staffList = (staff ?? []).filter((s) => s.active !== false)
  const nameOf = (id: number) => residents.find((r) => r.id === id)?.name ?? `利用者ID ${id}`
  const staffName = (id: number | null) => (id === null ? '' : ((staff ?? []).find((s) => s.id === id)?.name ?? `職員ID ${id}`))
  const missing = data?.missing ?? false
  const pastLocked = day < today && !canEditPastDaycareTimes(role)
  const gateOk = gate !== null && gate.observed && gate.value === true
  const canWrite = gateOk && !missing && data !== null && data.sessions !== null && data.staffing !== null && day <= today && !pastLocked
  const sessions = data?.sessions ?? []
  const pending = pendingTrainingOps()
  // 送信待ちの配置の追加（止まっていない分）も、時間帯ごと配置として数える（圏外で入れた指導員で〔完了〕できるように・反証 軽4。
  // 時間帯を落とすと終日の指導員に見えて取り違える＝直しの確認の反証 中1）。id は負の数
  const pendingStaffing: DaycareStaffing[] = pending.flatMap((p, i) =>
    p.kind === 'add' && p.table === 'daycare_staffing' && p.day === day && !p.stopped
      ? [{ id: -(i + 1), day, staff_id: p.staffId, role: p.role, from_time: p.fromTime, to_time: p.toTime, note: null, rev: 0 }]
      : [],
  )
  // 一覧には送信待ちの印つきで出す（staffingShown）。指導員として数えるのは、圏外で〔外す〕を押した配置（送信待ちの取り消し）を
  // 除いた分（staffing。追加と扱いをそろえる＝直しの確認の反証 軽5）
  const staffingShown = [...(data?.staffing ?? []), ...pendingStaffing]
  const removedStaffing = new Set(
    pending.flatMap((p) => (p.kind === 'update' && p.table === 'daycare_staffing' && p.deleted && !p.stopped ? [p.rowId] : [])),
  )
  const staffing = staffingShown.filter((s) => !removedStaffing.has(s.id))
  const trainers = trainersOf(staffing, day)
  const dual = dualRoleWithoutTime(staffing, day)
  // 対象者でない方の記録（到着を取り消した・欠席にした方。直す入口を残す＝反証 中4）
  const outside = sessionsOutsideTargets(sessions, targets, day)
  /** その方の今日の送信待ちの追加（stopped＝止まっている） */
  const pendingAdd = (rid: number) =>
    pending.find((p) => p.kind === 'add' && p.table === 'daycare_training_sessions' && p.residentId === rid && p.day === day)
  /** 表と行の番号で探す（実施記録と配置は番号の採番が別＝反証 軽1） */
  const pendingRow = (table: 'daycare_training_sessions' | 'daycare_staffing', rowId: number) =>
    pending.find((p) => p.kind === 'update' && p.table === table && p.rowId === rowId)

  const precheck = (): string | null => {
    if (missing) return MSG_MISSING
    if (pastLocked) return MSG_PAST
    if (!canWrite) {
      return gate?.forbidden
        ? FORBIDDEN_REASON
        : gate?.outdated
          ? OUTDATED_REASON
          : gate?.observed
            ? kindBlockedMessage('daycare_training')
            : MSG_GATE_UNKNOWN
    }
    if (actorId === null) return MSG_NO_RECORDER
    return null
  }
  /** 居宅訪問が書けない理由（過去の日の守りは受けない＝計画 3.6。旗・記録者だけを見る・段階3b） */
  const homeVisitBlocked = (): string | null => {
    if (missing) return MSG_MISSING
    if (!(gateOk && !missing)) {
      return gate?.forbidden
        ? FORBIDDEN_REASON
        : gate?.outdated
          ? OUTDATED_REASON
          : gate?.observed
            ? kindBlockedMessage('daycare_training')
            : MSG_GATE_UNKNOWN
    }
    if (actorId === null) return MSG_NO_RECORDER
    return null
  }
  const errText = (e: unknown, d: string) => {
    if (e instanceof DbError && e.kind === 'forbidden' && d < todayIso()) return MSG_PAST
    if (e instanceof DbError) return e.message
    return '保存できませんでした。通信状態を確認して、もう一度お試しください。'
  }
  const queuedMsg = (): Msg => (isQueuePersisted() ? { tone: 'info', text: MSG_QUEUED } : { tone: 'danger', text: MSG_NOT_PERSISTED })

  /** 新しい記録の小窓の初めの値 */
  const freshInput = (rid: number, d: string, result: TrainingResult): TrainingInput => {
    const minutes = TRAINING_DEFAULT_MIN
    // 過去の日は押した時刻を使わない（開始時刻は空にして入れてもらう＝反証 中2）
    const start = d === todayIso() ? defaultStartTime(nowMinutes(), result === 'cancelled' ? 0 : minutes) : ''
    return {
      result,
      started_at: start,
      minutes: String(minutes),
      program: previousProgram(data?.recent ?? [], rid, d) ?? '',
      // 開始時刻の時間帯の機能訓練指導員が1人に決まる時だけ入れる（午前・午後で違う日に取り違えない＝反証 中1）
      instructor_id: instructorFor(staffing, d, start),
      assisted_by: null,
      cancel_reason: null,
      cancel_note: '',
      note: '',
    }
  }
  const inputOf = (row: DaycareTrainingSession): TrainingInput => ({
    result: row.result,
    started_at: row.started_at,
    minutes: row.duration_min === null ? String(TRAINING_DEFAULT_MIN) : String(row.duration_min),
    program: row.program,
    instructor_id: row.instructor_id,
    assisted_by: row.assisted_by,
    cancel_reason: row.cancel_reason,
    cancel_note: row.cancel_note ?? '',
    note: row.note ?? '',
  })

  const openNew = (rid: number, result: TrainingResult) => {
    const why = precheck()
    if (why !== null) {
      setRowMsg({ rid, day, msg: { tone: 'warn', text: why } })
      return
    }
    openNewWith(rid, day, freshInput(rid, day, result))
  }
  const openRow = (row: DaycareTrainingSession, note?: string) => setEditor({ rid: row.resident_id, day: row.day, row, input: inputOf(row), note })
  const openNewWith = (rid: number, d: string, input: TrainingInput) =>
    setEditor({ rid, day: d, row: null, input, note: d < todayIso() ? MSG_PAST_START : undefined })

  /** 〔完了〕1タップ。前回の内容と配置の指導員がそろっている時だけ小窓を出さずに保存する */
  const quickDone = async (rid: number) => {
    const d = day
    const why = precheck()
    if (why !== null) {
      setRowMsg({ rid, day: d, msg: { tone: 'warn', text: why } })
      return
    }
    const input = freshInput(rid, d, 'done')
    // 1タップで保存するのは、今日で・前回の内容があり・指導員が1人に決まる時だけ。ほかは小窓で確かめてもらう
    if (d < todayIso() || input.program === '' || input.instructor_id === null) {
      openNewWith(rid, d, input)
      return
    }
    await saveNew(rid, d, input, true)
  }

  /** 〔元に戻す〕（取り消し）。結果を必ず知らせる（取り消せなかった・送信待ち・止まった時も黙らない＝反証 軽2） */
  const undoSession = async (row: DaycareTrainingSession) => {
    try {
      const r = await softDeleteTrainingSession(row, { editedBy: actorId })
      if (r === 'queued') setRowMsg({ rid: row.resident_id, day: row.day, msg: queuedMsg() })
      else if (r === 'conflict') setRowMsg({ rid: row.resident_id, day: row.day, msg: { tone: 'warn', text: `取り消せませんでした。${MSG_CONFLICT}` } })
      else setRowMsg({ rid: row.resident_id, day: row.day, msg: { tone: 'info', text: '記録を取り消しました。' } })
    } catch (e) {
      setRowMsg({ rid: row.resident_id, day: row.day, msg: { tone: 'danger', text: `取り消せませんでした。${errText(e, row.day)}` } })
    } finally {
      scheduleReload()
    }
  }

  /** 新しい記録を送る。小窓を閉じてよい（保存した・送信待ち）時は true。先の記録があった時は、その記録の小窓に替えるので false */
  const saveNew = async (rid: number, d: string, input: TrainingInput, quick: boolean): Promise<boolean> => {
    if (Object.keys(trainingInputErrors(input)).length > 0) return false
    setBusy(true)
    try {
      const r = await insertTrainingSession({ resident_id: rid, day: d, recorded_by: actorId, ...trainingPayload(input) })
      if (r.kind === 'queued') {
        setRowMsg({ rid, day: d, msg: queuedMsg() })
      } else if (r.kind === 'taken') {
        setRowMsg({ rid, day: d, msg: { tone: 'warn', text: MSG_TAKEN } })
        if (r.row !== null) openRow(r.row, MSG_TAKEN)
        else setEditor(null)
        return false
      } else {
        const row = r.row
        setRowMsg(null)
        const detail = quick ? `（${row.program}・${row.started_at.replace(/^0(\d)/, '$1')}から${row.duration_min ?? '—'}分・指導員 ${staffName(row.instructor_id)}）` : ''
        show(`${nameOf(rid)}さんの機能訓練を「${TRAINING_RESULT_LABEL[row.result]}」で記録しました${detail}`, () => {
          void undoSession(row)
        })
      }
      return true
    } catch (e) {
      const text = errText(e, d)
      if (quick) setRowMsg({ rid, day: d, msg: { tone: 'danger', text } })
      else setEditor((cur) => (cur === null ? cur : { ...cur, note: text }))
      return false
    } finally {
      setBusy(false)
      scheduleReload()
    }
  }

  const saveEditor = async () => {
    const ed = editor
    if (ed === null) return
    // 足りない項目は、押した時に欄の近くへ出す（開いた直後からは出さない）
    if (Object.keys(trainingInputErrors(ed.input)).length > 0) {
      setEditor({ ...ed, showErr: true })
      return
    }
    const why = precheck()
    if (why !== null) {
      setEditor({ ...ed, note: why })
      return
    }
    // 小窓は保存できるまで閉じない（拒否された時に入れた内容を失わない＝反証 軽7）
    if (ed.row === null) {
      if (await saveNew(ed.rid, ed.day, ed.input, false)) setEditor(null)
      return
    }
    setBusy(true)
    try {
      const r = await updateTrainingSession(ed.row, trainingPayload(ed.input), { editedBy: actorId })
      setEditor(null)
      if (r === 'queued') setRowMsg({ rid: ed.rid, day: ed.day, msg: queuedMsg() })
      else if (r === 'conflict') setRowMsg({ rid: ed.rid, day: ed.day, msg: { tone: 'warn', text: MSG_CONFLICT } })
      else setRowMsg({ rid: ed.rid, day: ed.day, msg: { tone: 'info', text: '直しました。' } })
    } catch (e) {
      const text = errText(e, ed.day)
      setEditor((cur) => (cur === null ? cur : { ...cur, note: text }))
    } finally {
      setBusy(false)
      scheduleReload()
    }
  }

  const cancelSession = async () => {
    const t = delSession
    setDelSession(null)
    if (t === null) return
    const why = precheck()
    if (why !== null) {
      setRowMsg({ rid: t.row.resident_id, day: t.row.day, msg: { tone: 'warn', text: why } })
      return
    }
    setBusy(true)
    try {
      const r = await softDeleteTrainingSession(t.row, { editedBy: actorId })
      if (r === 'queued') setRowMsg({ rid: t.row.resident_id, day: t.row.day, msg: queuedMsg() })
      else if (r === 'conflict') setRowMsg({ rid: t.row.resident_id, day: t.row.day, msg: { tone: 'warn', text: MSG_CONFLICT } })
      else setRowMsg({ rid: t.row.resident_id, day: t.row.day, msg: { tone: 'info', text: '記録を取り消しました。' } })
    } catch (e) {
      setRowMsg({ rid: t.row.resident_id, day: t.row.day, msg: { tone: 'danger', text: errText(e, t.row.day) } })
    } finally {
      setBusy(false)
      scheduleReload()
    }
  }

  const addStaffing = async () => {
    const d = day
    const why = precheck()
    if (why !== null) {
      setStaffMsg({ day: d, msg: { tone: 'warn', text: why } })
      return
    }
    const sid = Number(addStaffId)
    if (!Number.isInteger(sid) || sid <= 0) return
    setBusy(true)
    try {
      const r = await insertStaffing({
        day: d,
        staff_id: sid,
        role: addRole,
        from_time: addFrom === '' ? null : addFrom,
        to_time: addTo === '' ? null : addTo,
        recorded_by: actorId,
      })
      if (r.kind === 'queued') setStaffMsg({ day: d, msg: queuedMsg() })
      else if (r.kind === 'taken') setStaffMsg({ day: d, msg: { tone: 'warn', text: 'その方は同じ役割・同じ時間帯で、もう配置に入っています。' } })
      else {
        setStaffMsg(null)
        setAddStaffId('')
        setAddFrom('')
        setAddTo('')
      }
    } catch (e) {
      setStaffMsg({ day: d, msg: { tone: 'danger', text: errText(e, d) } })
    } finally {
      setBusy(false)
      scheduleReload()
    }
  }

  const removeStaffing = async () => {
    const t = delStaff
    setDelStaff(null)
    if (t === null) return
    const why = precheck()
    if (why !== null) {
      setStaffMsg({ day: t.day, msg: { tone: 'warn', text: why } })
      return
    }
    setBusy(true)
    try {
      const r = await softDeleteStaffing(t, { editedBy: actorId })
      if (r === 'queued') setStaffMsg({ day: t.day, msg: queuedMsg() })
      else if (r === 'conflict') setStaffMsg({ day: t.day, msg: { tone: 'warn', text: MSG_CONFLICT } })
      else setStaffMsg(null)
    } catch (e) {
      setStaffMsg({ day: t.day, msg: { tone: 'danger', text: errText(e, t.day) } })
    } finally {
      setBusy(false)
      scheduleReload()
    }
  }

  const goDay = (d: string) => navigate(trainingPath(d, today), { replace: true })
  const btn = 'min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:text-ink3'
  const primaryBtn =
    'min-h-tap rounded border-2 border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border-strong disabled:bg-surface disabled:text-ink3'
  const chipCls = (on: boolean) =>
    on
      ? 'min-h-tap min-w-tap max-w-full rounded border-2 border-primary bg-primary px-3 text-base font-bold text-primary-ink'
      : 'min-h-tap min-w-tap max-w-full rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:text-ink3'
  const msgBox = (m: Msg) => (
    <p role="status" className={`rounded border p-2 text-base text-ink ${m.tone === 'info' ? 'border-primary bg-surface' : m.tone === 'warn' ? 'border-warn bg-warn-bg' : 'border-danger bg-danger-bg'}`}>
      <span aria-hidden="true">{m.tone === 'info' ? 'ⓘ ' : '▲ '}</span>
      {m.text}
    </p>
  )

  const header = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <DaycareNav current="training" />
        <RecorderBar actorId={actorId} staff={staff ?? null} />
      </div>
      <div className="flex flex-wrap items-center gap-gap" role="group" aria-label="日付">
        <button type="button" onClick={() => goDay(addDays(day, -1))} className={`${btn} min-w-tap text-lg`} aria-label="前の日へ">
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
          className={`${btn} min-w-tap text-lg`}
          aria-label="次の日へ"
        >
          <span aria-hidden="true">›</span>
        </button>
        <button type="button" onClick={() => setReloadKey((n) => n + 1)} className={btn}>
          最新に更新
        </button>
      </div>
      {missing ? (
        <p role="alert" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {MSG_MISSING}
        </p>
      ) : gate !== null && !gateOk ? (
        <p role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {gate.forbidden
            ? FORBIDDEN_REASON
            : gate.outdated
              ? OUTDATED_REASON
              : gate.observed
                ? `${kindBlockedMessage('daycare_training')}。記録の閲覧はできます。`
                : MSG_GATE_UNKNOWN}
        </p>
      ) : pastLocked ? (
        <p role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">ⓘ </span>
          {MSG_PAST}
        </p>
      ) : null}
    </div>
  )

  if ((loading && data === null) || (data !== null && data.day !== day && error === null)) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        {header}
        <LoadingBlock label="その日の機能訓練を読み込んでいます…" />
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

  const ed = editor
  const edErr = ed === null ? {} : trainingInputErrors(ed.input)
  // 直前の値から足す（続けて押した時に、前の変更を古い値で上書きしない）
  const setInput = (patch: Partial<TrainingInput>) => setEditor((cur) => (cur === null ? cur : { ...cur, input: { ...cur.input, ...patch } }))
  const errLine = (id: string, text: string | undefined) =>
    text === undefined || ed?.showErr !== true ? null : (
      <span id={id} className="mt-1 block text-sm text-danger">
        {text}
      </span>
    )

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      {header}

      <section aria-labelledby="h-staffing" className="space-y-3 rounded-lg border border-border bg-surface p-3">
        <h2 id="h-staffing" className="text-xl font-bold text-ink">
          その日の配置
        </h2>
        {data.staffing === null && !missing ? (
          <p role="alert" className="rounded border border-danger bg-danger-bg p-2 text-base text-ink">
            <span aria-hidden="true">▲ </span>配置を読み込めませんでした。通信状態を確認して、〔最新に更新〕を押してください。
          </p>
        ) : null}
        {data.staffing !== null && trainers.length === 0 ? (
          <p role="status" className="rounded border border-warn bg-warn-bg p-2 text-base text-ink">
            <span aria-hidden="true">▲ </span>この日の機能訓練指導員の配置が記録されていません。
          </p>
        ) : null}
        {dual.length > 0 ? (
          <p role="status" className="rounded border border-warn bg-warn-bg p-2 text-base text-ink">
            <span aria-hidden="true">▲ </span>
            {dual.map((id) => `${staffName(id)}さん`).join('・')}は、機能訓練指導員と看護職員の両方に入っています。兼務の時は時間帯を分けて書いてください。
          </p>
        ) : null}
        {staffingShown.length > 0 ? (
          <ul className="divide-y divide-border">
            {STAFFING_ROLES.flatMap((r) => staffingShown.filter((s) => s.role === r)).map((s) => {
              const p = s.id > 0 ? pendingRow('daycare_staffing', s.id) : undefined
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-gap py-2">
                  <p className="text-base text-ink">
                    <span className="font-bold">{STAFFING_ROLE_LABEL[s.role]}</span> {staffName(s.staff_id)}
                    {staffingTimeText(s) !== '' ? <span className="ml-2 text-ink2">{staffingTimeText(s)}</span> : null}
                    {s.id < 0 ? <span className="ml-2 text-sm text-warn">（送信待ち）</span> : null}
                    {p !== undefined ? (
                      <span className="ml-2 text-sm text-warn">（{p.stopped ? '止まっています' : p.kind === 'update' && p.deleted ? '外す・送信待ち' : '送信待ち'}）</span>
                    ) : null}
                  </p>
                  {s.id > 0 ? (
                    <button type="button" disabled={!canWrite || busy} onClick={() => setDelStaff(s)} className={btn} aria-label={`${STAFFING_ROLE_LABEL[s.role]} ${staffName(s.staff_id)}さんを配置から外す`}>
                      外す
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
        {/* min-w-0: fieldset は既定で中身の最小幅より狭くならず、選択欄の長い氏名に引っぱられて横にはみ出した（積み残し 47） */}
        <fieldset className="min-w-0 space-y-2" disabled={!canWrite || busy}>
          <legend className="text-base font-bold text-ink">配置に入れる</legend>
          <div className="flex flex-wrap gap-gap" role="group" aria-label="役割">
            {STAFFING_ROLES.map((r) => (
              <button key={r} type="button" aria-pressed={addRole === r} onClick={() => setAddRole(r)} className={chipCls(addRole === r)}>
                {addRole === r ? <span aria-hidden="true">✓ </span> : null}
                {STAFFING_ROLE_LABEL[r]}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-gap">
            <label className="min-w-0 max-w-full text-sm text-ink2">
              職員
              <select value={addStaffId} onChange={(e) => setAddStaffId(e.target.value)} className="mt-1 block min-h-tap max-w-full rounded border border-border-strong bg-surface px-2 text-lg text-ink">
                <option value="">選んでください</option>
                {staffList.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-ink2">
              から（任意）
              <input type="time" value={addFrom} onChange={(e) => setAddFrom(e.target.value)} className="mt-1 block min-h-tap rounded border border-border-strong bg-surface px-2 text-lg text-ink" />
            </label>
            <label className="text-sm text-ink2">
              まで（任意）
              <input type="time" value={addTo} onChange={(e) => setAddTo(e.target.value)} className="mt-1 block min-h-tap rounded border border-border-strong bg-surface px-2 text-lg text-ink" />
            </label>
            <button type="button" disabled={addStaffId === ''} onClick={() => void addStaffing()} className={primaryBtn}>
              配置に入れる
            </button>
          </div>
        </fieldset>
        {staffMsg !== null && staffMsg.day === day ? msgBox(staffMsg.msg) : null}
      </section>

      <DaycareReviewDueSection
        today={today}
        residents={residents}
        copy={data.copy}
        role={role}
        actorId={actorId}
        blockedReason={homeVisitBlocked()}
        onSynced={scheduleReload}
        scope={week}
      />

      <DaycareHomeVisitSection
        today={today}
        residents={residents}
        targets={targets}
        staff={staff}
        actorId={actorId}
        blockedReason={homeVisitBlocked()}
        refreshKey={dataTick}
      />

      <section aria-labelledby="h-targets" className="space-y-2 rounded-lg border border-border bg-surface p-3">
        <h2 id="h-targets" className="text-xl font-bold text-ink">
          {day === today ? '今日' : 'この日'}の対象者
        </h2>
        <p className="text-base text-ink2">
          その日に来た方（在席・帰宅）です。〔完了〕は前回と同じ内容・{TRAINING_DEFAULT_MIN}分・配置の機能訓練指導員で記録します（違う時は〔一部〕か、記録の後に〔記録を開く〕で直してください）。
        </p>
        {data.sessions === null && !missing ? (
          <p role="alert" className="rounded border border-danger bg-danger-bg p-2 text-base text-ink">
            <span aria-hidden="true">▲ </span>機能訓練の記録を読み込めませんでした。通信状態を確認して、〔最新に更新〕を押してください。
          </p>
        ) : null}
        {planOrder?.notice === 'error' && targets.length > 0 ? (
          <p role="status" className="rounded border border-warn bg-warn-bg p-2 text-base text-ink">
            <span aria-hidden="true">▲ </span>計画書の期限を確かめられません（写しを読み込めませんでした）。並びは到着の順のままです。
          </p>
        ) : planOrder?.notice === 'empty' && targets.length > 0 ? (
          // 写しが0件（まだ写していない・1人も載っていない）の時も、並びを変えていないことを知らせる（段階3c の反証 中1）
          <p role="status" className="rounded border border-border p-2 text-base text-ink">
            <span aria-hidden="true">ⓘ </span>計画書の写しに載っている方がいないため、並びは到着の順のままです。
          </p>
        ) : null}
        {targets.length === 0 ? (
          <p className="text-base text-ink2">この日に来た方（在席・帰宅）がまだいません。到着を記録すると、ここに出ます。</p>
        ) : (
          <ul className="divide-y divide-border">
            {(planOrder?.order ?? targets).map((rid) => {
              const s = sessionOf(sessions, rid, day)
              const prev = previousProgram(data.recent, rid, day)
              const add = pendingAdd(rid)
              const waiting = add !== undefined
              const p = s === null ? undefined : pendingRow('daycare_training_sessions', s.id)
              const name = nameOf(rid)
              return (
                <li key={rid} className="space-y-2 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-gap">
                    <div className="min-w-0">
                      <p className="text-lg font-bold text-ink">{name}</p>
                      {planOrder?.noPlan.has(rid) ? <p className="text-sm text-ink2">{TARGET_NO_PLAN_LABEL[planOrder.noPlan.get(rid) ?? 'nocopy']}</p> : null}
                      <p className="text-base text-ink2">
                        {s !== null
                          ? `${sessionText(s)}・指導員 ${staffName(s.instructor_id)}`
                          : waiting
                            ? add.stopped
                              ? '記録（送れずに止まっています）'
                              : '記録（送信待ち）'
                            : data.sessions === null
                              ? missing
                                ? '（設定待ち）'
                                : '（読み込めませんでした）'
                              : `記録なし${prev !== null ? `（前回: ${prev}）` : '（前回の記録なし）'}`}
                        {p !== undefined ? `（${p.stopped ? '止まっています' : '送信待ち'}）` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-gap">
                      {s !== null ? (
                        <button type="button" disabled={busy} onClick={() => openRow(s)} className={btn} aria-label={`${name}さんの機能訓練の記録を開く`}>
                          記録を開く
                        </button>
                      ) : (
                        <>
                          <button type="button" disabled={!canWrite || busy || waiting} onClick={() => void quickDone(rid)} className={primaryBtn} aria-label={`${name}さんの機能訓練を完了で記録する`}>
                            完了
                          </button>
                          <button type="button" disabled={!canWrite || busy || waiting} onClick={() => openNew(rid, 'partial')} className={btn} aria-label={`${name}さんの機能訓練を一部で記録する`}>
                            一部
                          </button>
                          <button type="button" disabled={!canWrite || busy || waiting} onClick={() => openNew(rid, 'cancelled')} className={btn} aria-label={`${name}さんの機能訓練を中止で記録する`}>
                            中止
                          </button>
                        </>
                      )}
                      <Link
                        to={personPath(rid, day, today)}
                        aria-label={`${name}さんの1日の記録を開く`}
                        className="inline-flex min-h-tap items-center rounded-full border border-primary bg-surface px-4 text-base font-bold text-primary"
                      >
                        1日の記録<span aria-hidden="true"> ›</span>
                      </Link>
                    </div>
                  </div>
                  {add?.stopped === true || p?.stopped === true ? msgBox({ tone: 'warn', text: MSG_STOPPED }) : null}
                  {rowMsg !== null && rowMsg.rid === rid && rowMsg.day === day ? msgBox(rowMsg.msg) : null}
                </li>
              )
            })}
          </ul>
        )}
        {outside.length > 0 ? (
          <div className="space-y-1 border-t border-border pt-2">
            <h3 className="text-lg font-bold text-ink">対象者でない方の記録（{outside.length}件）</h3>
            <p className="text-sm text-ink2">到着を取り消した・欠席にした方などの記録です。来ていない方の記録なら、開いて取り消してください。</p>
            <ul className="divide-y divide-border">
              {outside.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-gap py-2">
                  <p className="min-w-0 text-base text-ink">
                    <span className="font-bold">{nameOf(s.resident_id)}</span> {sessionText(s)}
                  </p>
                  <button type="button" disabled={busy} onClick={() => openRow(s)} className={btn} aria-label={`${nameOf(s.resident_id)}さんの機能訓練の記録を開く（対象者でない方）`}>
                    記録を開く
                  </button>
                </li>
              ))}
            </ul>
            {rowMsg !== null && rowMsg.day === day && outside.some((s) => s.resident_id === rowMsg.rid) ? msgBox(rowMsg.msg) : null}
          </div>
        ) : null}
      </section>

      <ModalShell open={ed !== null} label={ed?.row === null ? '機能訓練を記録する' : '機能訓練の記録'} onClose={() => setEditor(null)}>
        {ed !== null ? (
          <>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <h2 className="text-lg font-bold text-ink">
              {nameOf(ed.rid)}さんの機能訓練（{fmtDayLabel(ed.day)}）
            </h2>
            {ed.note !== undefined ? msgBox({ tone: 'warn', text: ed.note }) : null}
            <fieldset disabled={!canWrite || busy} className="min-w-0 space-y-3">
              <div role="group" aria-label="結果" className="flex flex-wrap gap-gap">
                {TRAINING_RESULTS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={ed.input.result === r}
                    onClick={() => setInput({ result: r, ...(r === 'cancelled' ? {} : { cancel_reason: null, cancel_note: '' }) })}
                    className={chipCls(ed.input.result === r)}
                  >
                    {ed.input.result === r ? <span aria-hidden="true">✓ </span> : null}
                    {TRAINING_RESULT_LABEL[r]}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-gap">
                <label className="text-sm text-ink2">
                  {ed.input.result === 'cancelled' ? '実施しようとした時刻' : '開始時刻'}
                  <input
                    type="time"
                    value={ed.input.started_at}
                    onChange={(e) => setInput({ started_at: e.target.value })}
                    aria-invalid={ed.showErr === true && edErr.started_at !== undefined}
                    aria-describedby={ed.showErr === true && edErr.started_at !== undefined ? 'tr-start-err' : undefined}
                    className="mt-1 block min-h-tap rounded border border-border-strong bg-surface px-2 text-lg text-ink"
                  />
                  {errLine('tr-start-err', edErr.started_at)}
                </label>
                {ed.input.result !== 'cancelled' ? (
                  <label className="text-sm text-ink2">
                    時間（分）
                    <input
                      type="text"
                      inputMode="numeric"
                      value={ed.input.minutes}
                      onChange={(e) => setInput({ minutes: e.target.value })}
                      aria-invalid={ed.showErr === true && edErr.minutes !== undefined}
                      aria-describedby={ed.showErr === true && edErr.minutes !== undefined ? 'tr-min-err' : undefined}
                      className="mt-1 block min-h-tap w-24 rounded border border-border-strong bg-surface px-2 text-lg text-ink"
                    />
                    {errLine('tr-min-err', edErr.minutes)}
                  </label>
                ) : null}
              </div>
              <div className="space-y-1">
                <div className="flex flex-wrap gap-gap" role="group" aria-label="内容の定型">
                  {TRAINING_PROGRAM_CHIPS.map((c) => (
                    <button key={c} type="button" onClick={() => setInput({ program: c })} className={chipCls(ed.input.program === c)}>
                      {c}
                    </button>
                  ))}
                </div>
                <label className="block text-sm text-ink2">
                  内容（{TRAINING_PROGRAM_MAX}字まで）
                  <input
                    type="text"
                    value={ed.input.program}
                    maxLength={TRAINING_PROGRAM_MAX * 2}
                    onChange={(e) => setInput({ program: e.target.value })}
                    aria-invalid={ed.showErr === true && edErr.program !== undefined}
                    aria-describedby={ed.showErr === true && edErr.program !== undefined ? 'tr-prog-err' : undefined}
                    className="mt-1 block min-h-tap w-full rounded border border-border-strong bg-surface px-2 text-lg text-ink"
                  />
                  {errLine('tr-prog-err', edErr.program)}
                </label>
              </div>
              <div className="flex flex-wrap items-end gap-gap">
                <label className="min-w-0 max-w-full text-sm text-ink2">
                  指導員（直接行った職員）
                  <select
                    value={ed.input.instructor_id === null ? '' : String(ed.input.instructor_id)}
                    onChange={(e) => setInput({ instructor_id: e.target.value === '' ? null : Number(e.target.value) })}
                    aria-invalid={ed.showErr === true && edErr.instructor_id !== undefined}
                    aria-describedby={ed.showErr === true && edErr.instructor_id !== undefined ? 'tr-ins-err' : undefined}
                    className="mt-1 block min-h-tap max-w-full rounded border border-border-strong bg-surface px-2 text-lg text-ink"
                  >
                    <option value="">選んでください</option>
                    {staffList.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {s.name}
                        {trainers.includes(s.id) ? '（配置の機能訓練指導員）' : ''}
                      </option>
                    ))}
                  </select>
                  {errLine('tr-ins-err', edErr.instructor_id)}
                </label>
                <label className="min-w-0 max-w-full text-sm text-ink2">
                  補助（任意）
                  <select
                    value={ed.input.assisted_by === null ? '' : String(ed.input.assisted_by)}
                    onChange={(e) => setInput({ assisted_by: e.target.value === '' ? null : Number(e.target.value) })}
                    className="mt-1 block min-h-tap max-w-full rounded border border-border-strong bg-surface px-2 text-lg text-ink"
                  >
                    <option value="">なし</option>
                    {staffList.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {ed.input.instructor_id !== null && !trainers.includes(ed.input.instructor_id) ? (
                <p role="status" className="text-sm text-warn">
                  <span aria-hidden="true">▲ </span>この方は、この日の配置の機能訓練指導員に入っていません（保存はできます）。
                </p>
              ) : null}
              {ed.input.result === 'cancelled' ? (
                <div className="space-y-1">
                  <div className="flex flex-wrap gap-gap" role="group" aria-label="中止の理由" aria-describedby={ed.showErr === true && edErr.cancel_reason !== undefined ? 'tr-why-err' : undefined}>
                    {TRAINING_CANCEL_REASONS.map((r) => (
                      <button key={r} type="button" aria-pressed={ed.input.cancel_reason === r} onClick={() => setInput({ cancel_reason: r })} className={chipCls(ed.input.cancel_reason === r)}>
                        {ed.input.cancel_reason === r ? <span aria-hidden="true">✓ </span> : null}
                        {TRAINING_CANCEL_REASON_LABEL[r]}
                      </button>
                    ))}
                  </div>
                  {errLine('tr-why-err', edErr.cancel_reason)}
                  {ed.input.cancel_reason === 'other' ? (
                    <label className="block text-sm text-ink2">
                      その他の理由（{TRAINING_CANCEL_NOTE_MAX}字まで）
                      <input
                        type="text"
                        value={ed.input.cancel_note}
                        maxLength={TRAINING_CANCEL_NOTE_MAX * 2}
                        onChange={(e) => setInput({ cancel_note: e.target.value })}
                        aria-invalid={ed.showErr === true && edErr.cancel_note !== undefined}
                        aria-describedby={ed.showErr === true && edErr.cancel_note !== undefined ? 'tr-cnote-err' : undefined}
                        className="mt-1 block min-h-tap w-full rounded border border-border-strong bg-surface px-2 text-lg text-ink"
                      />
                      {errLine('tr-cnote-err', edErr.cancel_note)}
                    </label>
                  ) : null}
                </div>
              ) : null}
              <label className="block text-sm text-ink2">
                備考（任意・{TRAINING_NOTE_MAX}字まで）
                <input
                  type="text"
                  value={ed.input.note}
                  maxLength={TRAINING_NOTE_MAX * 2}
                  onChange={(e) => setInput({ note: e.target.value })}
                  aria-invalid={ed.showErr === true && edErr.note !== undefined}
                  aria-describedby={ed.showErr === true && edErr.note !== undefined ? 'tr-note-err' : undefined}
                  className="mt-1 block min-h-tap w-full rounded border border-border-strong bg-surface px-2 text-lg text-ink"
                />
                {errLine('tr-note-err', edErr.note)}
              </label>
            </fieldset>
          </div>
            <div className="flex flex-wrap justify-between gap-gap border-t border-border p-4">
              {ed.row !== null ? (
                <button
                  type="button"
                  disabled={!canWrite || busy}
                  onClick={() => {
                    const row = ed.row
                    setEditor(null)
                    if (row !== null) setDelSession({ row, name: nameOf(ed.rid) })
                  }}
                  className="min-h-tap rounded border border-danger px-4 text-base font-bold text-danger disabled:border-border disabled:text-ink3"
                >
                  <span aria-hidden="true">▲ </span>記録を取り消す
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-gap">
                <button type="button" onClick={() => setEditor(null)} className={btn}>
                  閉じる
                </button>
                <button type="button" disabled={!canWrite || busy} onClick={() => void saveEditor()} className={primaryBtn}>
                  {ed.row === null ? '記録する' : '直す'}
                </button>
              </div>
            </div>
          </>
        ) : null}
      </ModalShell>
      <ConfirmDialog
        open={delSession !== null}
        title="機能訓練の記録を取り消しますか"
        body={delSession === null ? '' : `${delSession.name}さんの ${fmtDayLabel(delSession.row.day)} の記録（${sessionText(delSession.row)}）を取り消します。変更の記録には残ります。`}
        confirmLabel="取り消す"
        danger
        onConfirm={() => void cancelSession()}
        onCancel={() => setDelSession(null)}
      />
      <ConfirmDialog
        open={delStaff !== null}
        title="配置から外しますか"
        body={delStaff === null ? '' : `${STAFFING_ROLE_LABEL[delStaff.role]} ${staffName(delStaff.staff_id)}さん${staffingTimeText(delStaff) !== '' ? `（${staffingTimeText(delStaff)}）` : ''}を、この日の配置から外します。`}
        confirmLabel="外す"
        danger
        onConfirm={() => void removeStaffing()}
        onCancel={() => setDelStaff(null)}
      />
      {toast}
    </div>
  )
}
