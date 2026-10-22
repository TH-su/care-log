// デイ（せせらぎ）のバイタル一括（ルート /record/daycare/vitals）。2026-10-22 デイ段階1・代表承認。
//
// 一覧＝その日のデイの方（既定は「到着した方」。絞り込みは端末の UI 状態 cl_dcVitalsFilter）。1人に1回目の行、
// 基準を外れた時は〔＋再測定〕で2回目以降の行を足す。欄を押すとテンキー（広い画面は右に常設・狭い画面は下から）。
// 欄送りは桁数で自動（体温 365→36.5・血圧の上と脈は先頭が1か2なら3桁・血圧の下と SpO2 は先頭が1なら3桁）。
// SpO2 が埋まると次の方の体温へ。物理キーボード（数字・.・Backspace・Enter・Esc）も効く。
// 保存（代表者の回答 5.2 の10）: 範囲外（DB の check と同じ VITAL_RANGE）と血圧の上下逆（上 ≦ 下）は保存しない（欄に理由・欄は進まない）。
//   血圧は上と下を組で送る（下を入れるまで上だけを送らない＝逆転した組は1欄も載らない）。
//   閾値を超えた値は保存して「38.1↑↑ 危険」と出し、〔＋再測定〕を出す。
// 保存の経路は既存の saveVitalEdits（0011 apply_cell_edits）そのまま。種類は既存の 'observation'（経過観察）、冪等キーを
//   'dc:<日>:<利用者id>:<回>' にしてデイの測定と見分ける（daycare.ts）。2台で同じ人を測ると同じキーの行に合流し、
//   後着は「他の端末が先に記録しました」になる（反証レビュー 中10）。〔いまの値にする〕〔あなたの値で直す〕で選ぶ。
// 前回値: その方の直近の測定（種類を問わない・14日以内・その日のデイの測定を除く）。
//
// 規律: 取得・保存は db.ts の関数のみ／入力解禁は input_enabled_daycare（＋既存のバイタルの旗 native_input_enabled が
//   saveVitalEdits の入口で効く）／氏名・値を localStorage・console に出さない（保存するのは絞り込みの既知値だけ）／
//   色だけに頼らない（記号＋言葉）／押す所は 44px 以上・テンキーは 56px

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DbError,
  FORBIDDEN_REASON,
  OUTDATED_REASON,
  discardPendingRow,
  fetchAllResidents,
  fetchDaycareAttendance,
  fetchDaycareDay,
  fetchDaycarePlan,
  fetchDaycareVitals,
  fetchRecentVitals,
  fetchResidentTargets,
  getKindInputGate,
  isQueuePersisted,
  isSelfWrite,
  kindBlockedMessage,
  openDaycareDay,
  pendingRow,
  queuePending,
  queueSubscribe,
  saveVitalEdits,
  subscribeChanges,
  subscribeDaycareChanges,
} from '../lib/db'
import type { CellConflict, CellEditInput, VitalCellField, VitalTarget } from '../lib/db'
import { RecorderBar } from '../components/RecorderBar'
import { ErrorBlock, LoadingBlock } from '../components/ui'
import { registerUnsaved } from '../lib/leaveGuard'
import { DaycareNav } from './DaycarePage'
import {
  DAYCARE_VITAL_FIELDS,
  DAYCARE_VITAL_LABEL,
  DAYCARE_VITAL_UNIT,
  DC_VITALS_FILTERS,
  LEVEL_WORD,
  bpPairError,
  buildDaycareBoard,
  daycareVitalKey,
  daycareVitalSlots,
  firstAbnormalField,
  keypadAppend,
  keypadComplete,
  keypadValue,
  nextDaycareSeq,
  nowHm,
  previousVitalOf,
  readDcVitalsFilter,
  vitalLevel,
  vitalNeedsRecheck,
  vitalRangeError,
} from '../lib/daycare'
import type { DaycareBoardRow, DaycareVitalField, DaycareVitalSlot, DcVitalsFilter, KeyedVital } from '../lib/daycare'
import { addDays, fmtDayLabel, todayIso, toHalfWidth } from '../lib/format'
import { LEVEL_MARK, LS } from '../lib/types'
import type { DaycareAttendance, DaycarePlanRow, DaycarePlanSource, Level, Resident, Staff } from '../lib/types'
import type { ResidentTargets } from '../lib/vitalAlerts'

const ERR_LOAD = 'デイのバイタルを読み込めませんでした。通信状態を確認して、再試行してください。'
const MSG_QUEUED = '電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度入れてください。'
const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから入れてください。'
const MSG_GATE_UNKNOWN =
  'デイの記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。記録の閲覧はこのままできます。'

const FILTER_LABEL: Record<DcVitalsFilter, string> = {
  present: '到着した方',
  planned: '予定の方全員',
  all: '全員（欠席・入院を含む）',
}

function readFilter(): DcVitalsFilter {
  try {
    return readDcVitalsFilter(window.localStorage.getItem(LS.dcVitalsFilter))
  } catch {
    return 'present'
  }
}
function writeFilter(v: DcVitalsFilter): void {
  try {
    window.localStorage.setItem(LS.dcVitalsFilter, v)
  } catch {
    // 保存できなくても操作は続ける
  }
}

interface VData {
  day: string
  planRows: DaycarePlanRow[]
  planSource: DaycarePlanSource
  opened: boolean
  missing: boolean
  attendance: DaycareAttendance[]
  live: KeyedVital[]
  keys: string[]
  recent: KeyedVital[]
}

/** 1回の測定の保存の状態（画面だけ） */
type SlotState =
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'queued'; persisted: boolean }
  | { kind: 'held' }
  | { kind: 'conflict'; conflicts: CellConflict[] }
  | { kind: 'error'; text: string }

/** テンキーで入れている欄 */
interface Active {
  residentId: number
  seq: number
  key: string
  field: DaycareVitalField
}

const fmtVal = (f: DaycareVitalField, v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : f === 'temp' ? v.toFixed(1) : String(v)

function levelTone(lv: Level): string {
  if (lv === 'danger-high' || lv === 'danger-low') return 'border-2 border-danger bg-danger-bg'
  if (lv !== null) return 'border-2 border-warn bg-warn-bg'
  return 'border border-border-strong bg-surface'
}

export interface DaycareVitalsPageProps {
  staff?: Staff[] | null
  actorId?: number | null
}

export function DaycareVitalsPage({ staff = undefined, actorId = null }: DaycareVitalsPageProps = {}) {
  const [today, setToday] = useState(todayIso())
  const [day, setDay] = useState(todayIso())
  const [data, setData] = useState<VData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [residents, setResidents] = useState<Resident[]>([])
  const [targets, setTargets] = useState<Map<number, ResidentTargets>>(new Map())
  const [gate, setGate] = useState<{ value: boolean; observed: boolean; forbidden?: true; outdated?: true } | null>(null)
  const [filter, setFilterState] = useState<DcVitalsFilter>(readFilter)
  const [extraSeqs, setExtraSeqs] = useState<Map<number, number[]>>(new Map())
  /** 入れたが送っていない値（血圧の上を下と組で送るまで持つ・送信中の値） */
  const [drafts, setDrafts] = useState<Map<string, Partial<Record<DaycareVitalField, number | null>>>>(new Map())
  const [slotState, setSlotState] = useState<Map<string, SlotState>>(new Map())
  const [active, setActive] = useState<Active | null>(null)
  const [buf, setBuf] = useState('')
  const [kpError, setKpError] = useState<string | null>(null)
  const [queueTick, setQueueTick] = useState(0)
  /** 血圧の上下逆で止めた測定（その上は送らない＝打ち直してもらう・反証レビュー中4） */
  const pairBlocked = useRef(new Set<string>())
  /** 入れたが送っていない値の写し（離れる時の確認に使う） */
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const genRef = useRef(0)
  const dayRef = useRef(day)
  dayRef.current = day
  const opening = useRef(false)

  useEffect(() => {
    const tick = () => setToday(todayIso())
    const t = window.setInterval(tick, 60_000)
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
      let missing = false
      let snapshot = null
      try {
        snapshot = await fetchDaycareDay(target)
      } catch (e) {
        if (e instanceof DbError && e.kind === 'server') missing = true
        else throw e
      }
      // 写しが「読めなかった」（unknown）日は、いまの週間計画も読む（次の保存で写し直す＝反証レビュー中2）
      const usable = snapshot !== null && snapshot.plan_source !== 'unknown'
      const [plan, attendance, dv] = await Promise.all([
        usable ? Promise.resolve(null) : fetchDaycarePlan(target),
        missing ? Promise.resolve([] as DaycareAttendance[]) : fetchDaycareAttendance(target),
        fetchDaycareVitals(target),
      ])
      const planRows = usable && snapshot !== null ? snapshot.plan_rows : (plan?.rows ?? [])
      const ids = new Set<number>()
      for (const r of planRows) if (r.resident_id !== null) ids.add(r.resident_id)
      for (const a of attendance) ids.add(a.resident_id)
      const recent = await fetchRecentVitals([...ids], addDays(target, -14), target).catch(() => [] as KeyedVital[])
      if (gen !== genRef.current || target !== dayRef.current) return
      setData({
        day: target,
        planRows,
        planSource: usable && snapshot !== null ? snapshot.plan_source : (plan?.source ?? 'unknown'),
        opened: usable,
        missing: missing || plan?.missing === true,
        attendance,
        live: dv.live,
        keys: dv.keys,
        recent,
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
    setActive(null)
    setExtraSeqs(new Map())
    setDrafts(new Map())
    setSlotState(new Map())
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
    const offA = subscribeChanges((table, info) => {
      if (table === 'vitals') onChange(table, info)
    })
    const offB = subscribeDaycareChanges(onChange)
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

  const setFilter = (v: DcVitalsFilter) => {
    setFilterState(v)
    writeFilter(v)
  }

  const board = useMemo(
    () => (data === null ? null : buildDaycareBoard({ planRows: data.planRows, source: data.planSource, residents, attendance: data.attendance })),
    [data, residents],
  )
  const shownRows: DaycareBoardRow[] = useMemo(() => {
    if (board === null) return []
    return board.rows.filter((r) => {
      if (filter === 'all') return true
      if (filter === 'present') return r.state === 'present' || r.state === 'left'
      return r.state !== 'absent' && !(r.hospitalized && r.state === 'planned')
    })
  }, [board, filter])

  const nameOf = useCallback((id: number) => residents.find((r) => r.id === id)?.name ?? `利用者ID ${id}`, [residents])

  /**
   * 1人の測定の並び（サーバーの行＋足した再測定＋送信待ちにだけある回）。送信待ちの回を出すのは、読み直しの後に圏外で入れた
   * 再測定が画面から消え、次の〔＋再測定〕で同じ回を上書きしないため（反証レビュー軽9）
   */
  const slotsOf = useCallback(
    (residentId: number): DaycareVitalSlot[] => {
      if (data === null) return []
      const extra = extraSeqs.get(residentId) ?? []
      const top = nextDaycareSeq([...data.keys, ...extra.map((x) => daycareVitalKey(data.day, residentId, x))], data.day, residentId) + 3
      const queued: number[] = []
      for (let seq = 1; seq <= top; seq += 1) {
        const key = daycareVitalKey(data.day, residentId, seq)
        if (data.keys.includes(key)) continue
        if (pendingRow('vitals', { routine: false, clientKey: key, residentId, day: data.day, kind: 'observation' }) !== null) queued.push(seq)
      }
      return daycareVitalSlots(data.live, data.keys, residentId, data.day, [...extra, ...queued])
    },
    // queueTick: 送信待ちが増減した時に並びを作り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, extraSeqs, queueTick],
  )
  const flatSlots = useMemo(() => shownRows.flatMap((r) => slotsOf(r.residentId)), [shownRows, slotsOf])

  const targetOf = (slot: DaycareVitalSlot): VitalTarget => ({
    routine: false,
    clientKey: slot.key,
    residentId: slot.residentId,
    day: dayRef.current,
    kind: 'observation',
  })

  /** 欄に出す値（送っていない値 → 送信待ちの値 → サーバーの値） */
  const valueOf = (slot: DaycareVitalSlot, f: DaycareVitalField): { v: number | null; local: boolean } => {
    const d = drafts.get(slot.key)
    if (d !== undefined && f in d) return { v: d[f] ?? null, local: true }
    const p = pendingRow('vitals', targetOf(slot))
    if (p !== null && f in p.values) {
      const pv = p.values[f]
      return { v: typeof pv === 'number' ? pv : null, local: true }
    }
    const sv = slot.vital?.[f]
    return { v: typeof sv === 'number' ? sv : null, local: false }
  }

  const canWrite = gate !== null && gate.observed && gate.value === true && !(data?.missing ?? false) && day <= today

  const setState = (key: string, st: SlotState | null) =>
    setSlotState((prev) => {
      const next = new Map(prev)
      if (st === null) next.delete(key)
      else next.set(key, st)
      return next
    })
  const setDraft = (key: string, f: DaycareVitalField, v: number | null | undefined) =>
    setDrafts((prev) => {
      const next = new Map(prev)
      const cur = { ...(next.get(key) ?? {}) }
      if (v === undefined) delete cur[f]
      else cur[f] = v
      if (Object.keys(cur).length === 0) next.delete(key)
      else next.set(key, cur)
      return next
    })

  /** 開所の最初の保存（今日だけ）: その日の予定の写しを作る（通信できない時は次の保存でもう一度） */
  const ensureOpened = async () => {
    if (data === null || data.opened || data.day !== todayIso() || opening.current) return
    opening.current = true
    try {
      const snap = await openDaycareDay(data.day, actorId)
      setData((prev) => (prev === null ? prev : { ...prev, opened: snap.plan_source !== 'unknown' }))
    } catch {
      // 次の保存でもう一度
    } finally {
      opening.current = false
    }
  }

  /** 1回の測定の欄を保存する（既存の saveVitalEdits＝0011 そのまま。基準は読んだ時のサーバーの値） */
  const saveSlot = async (slot: DaycareVitalSlot, edits: Partial<Record<DaycareVitalField, number | null>>, rebase?: Record<string, unknown>) => {
    if (actorId === null) {
      setState(slot.key, { kind: 'error', text: MSG_NO_RECORDER })
      return
    }
    const send: Record<string, { value: unknown; base?: unknown }> = {}
    for (const [f, v] of Object.entries(edits)) {
      const base = rebase !== undefined && f in rebase ? rebase[f] : (slot.vital?.[f as DaycareVitalField] ?? null)
      send[f] = { value: v, base }
    }
    setState(slot.key, { kind: 'saving' })
    void ensureOpened()
    try {
      const r = await saveVitalEdits(targetOf(slot), send as CellEditInput<VitalCellField>, {
        // 測定時刻は今日だけいまの時刻で埋める（過去の日にいまの時刻を入れない＝反証レビュー中7）
        fill: dayRef.current === todayIso() ? { measured_at: nowHm(), recorded_by: actorId } : { recorded_by: actorId },
        editedBy: actorId,
        rebase: rebase !== undefined,
      })
      for (const f of Object.keys(edits)) setDraft(slot.key, f as DaycareVitalField, undefined)
      if (r === 'queued') {
        setState(slot.key, { kind: 'queued', persisted: isQueuePersisted() })
        return
      }
      if (r.row !== null) {
        const row: KeyedVital = { ...r.row, client_key: slot.key }
        setData((prev) => {
          if (prev === null || prev.day !== row.measured_on) return prev
          const live = [...prev.live.filter((v) => v.id !== row.id && v.client_key !== slot.key), row]
          const keys = prev.keys.includes(slot.key) ? prev.keys : [...prev.keys, slot.key]
          return { ...prev, live, keys }
        })
      }
      if (r.held === true) {
        // 止まっている行へまとめた: 食い違いが分かれば〔いまの値にする〕〔あなたの値で直す〕を出す（反証レビュー中6）
        const pc = r.conflicts.length > 0 ? r.conflicts : (pendingRow('vitals', targetOf(slot))?.conflicts ?? [])
        setState(slot.key, pc.length > 0 ? { kind: 'conflict', conflicts: pc } : { kind: 'held' })
      }
      else if (r.conflicts.length > 0) setState(slot.key, { kind: 'conflict', conflicts: r.conflicts })
      else setState(slot.key, { kind: 'saved' })
    } catch (e) {
      setState(slot.key, { kind: 'error', text: e instanceof DbError ? e.message : '保存できませんでした。通信状態を確認して、もう一度入れてください。' })
    }
  }

  // ── テンキー ──
  const openCell = (slot: DaycareVitalSlot, field: DaycareVitalField) => {
    if (!canWrite) return
    // 血圧の上だけを入れて人・回を移った時は、上を単独で送る（上下の組は下を入れた時に送る）
    flushHeldSys(active, slot.key)
    setActive({ residentId: slot.residentId, seq: slot.seq, key: slot.key, field })
    setBuf('')
    setKpError(null)
  }

  /**
   * 血圧の上を持ったまま別の測定へ移る時: 上を単独で送る（下が無いので逆転は起きない）。
   * ただし上下逆で止めた後の上は送らない（打ち間違いの上だけが載るのを防ぐ＝反証レビュー中4）。理由を出して捨てる
   */
  const flushHeldSys = (cur: Active | null, nextKey: string | null) => {
    if (cur === null || cur.key === nextKey) return
    releaseHeldOf(cur.key)
  }

  /** その測定で持っている血圧の上を、送るか（上下逆で止めた後なら）捨てる */
  const releaseHeldOf = (key: string) => {
    const d = draftsRef.current.get(key)
    if (d === undefined || !('sys_bp' in d)) return
    if (pairBlocked.current.has(key)) {
      pairBlocked.current.delete(key)
      setDraft(key, 'sys_bp', undefined)
      setState(key, { kind: 'error', text: '血圧は上下逆のため保存していません。測り直して、上から入れ直してください。' })
      return
    }
    const slot = flatSlots.find((s) => s.key === key)
    if (slot === undefined) return
    const edits: Partial<Record<DaycareVitalField, number | null>> = { sys_bp: d.sys_bp ?? null }
    void saveSlot(slot, edits)
  }

  /** 日付の切り替え・読み直しの前: 持っている血圧の上を全部片づける（黙って消さない＝反証レビュー中3） */
  const releaseAllHeld = () => {
    for (const key of [...draftsRef.current.keys()]) releaseHeldOf(key)
    setActive(null)
    setBuf('')
    setKpError(null)
  }

  const closeKeypad = () => {
    flushHeldSys(active, null)
    setActive(null)
    setBuf('')
    setKpError(null)
  }

  /** 次の欄（SpO2 の次は次の方の体温） */
  const advance = (cur: Active) => {
    const i = DAYCARE_VITAL_FIELDS.indexOf(cur.field)
    if (i < DAYCARE_VITAL_FIELDS.length - 1) {
      setActive({ ...cur, field: DAYCARE_VITAL_FIELDS[i + 1] })
    } else {
      const at = flatSlots.findIndex((s) => s.key === cur.key)
      const next = flatSlots.slice(at + 1).find((s) => s.residentId !== cur.residentId) ?? null
      flushHeldSys(cur, next?.key ?? null)
      setActive(next === null ? null : { residentId: next.residentId, seq: next.seq, key: next.key, field: 'temp' })
    }
    setBuf('')
    setKpError(null)
  }

  /** 欄を確定する（範囲外・上下逆は止める＝保存しない・欄は進まない） */
  const commit = (cur: Active, text: string, skip: boolean) => {
    const slot = flatSlots.find((s) => s.key === cur.key)
    if (slot === undefined) return
    if (skip || text === '') {
      // 「未測定」・空のまま次へ: 記録しない（いまの値は消さない）
      if (cur.field === 'dia_bp') flushHeldSys(cur, null)
      advance(cur)
      return
    }
    const v = keypadValue(cur.field, text)
    if (v === null) {
      setKpError(`${DAYCARE_VITAL_LABEL[cur.field]}を読み取れませんでした。入れ直してください。`)
      return
    }
    const rangeErr = vitalRangeError(cur.field, v)
    if (rangeErr !== null) {
      setKpError(rangeErr)
      return
    }
    if (cur.field === 'sys_bp') {
      const dia = valueOf(slot, 'dia_bp').v
      const pairErr = bpPairError(v, dia)
      if (pairErr !== null) {
        setKpError(pairErr)
        return
      }
      // 上は下と組で送る（下を入れるまで持つ）。下が既にある時は今すぐ組で送る
      pairBlocked.current.delete(slot.key)
      if (dia !== null && valueOf(slot, 'dia_bp').local === false) void saveSlot(slot, { sys_bp: v, dia_bp: dia })
      else setDraft(slot.key, 'sys_bp', v)
      advance(cur)
      return
    }
    if (cur.field === 'dia_bp') {
      const sys = valueOf(slot, 'sys_bp').v
      const pairErr = bpPairError(sys, v)
      if (pairErr !== null) {
        // 下で止めた: 持っている上も送らない（打ち直すまで）
        pairBlocked.current.add(slot.key)
        setKpError(pairErr)
        return
      }
      pairBlocked.current.delete(slot.key)
      const edits: Partial<Record<DaycareVitalField, number | null>> = { dia_bp: v }
      if (sys !== null) edits.sys_bp = sys
      setDraft(slot.key, 'dia_bp', v)
      void saveSlot(slot, edits)
      advance(cur)
      return
    }
    setDraft(slot.key, cur.field, v)
    void saveSlot(slot, { [cur.field]: v })
    advance(cur)
  }

  const press = (key: string) => {
    if (active === null) return
    if (key === 'back') {
      setBuf((b) => b.slice(0, -1))
      setKpError(null)
      return
    }
    if (key === 'next') return commit(active, buf, false)
    if (key === 'skip') return commit(active, '', true)
    if (key === 'close') return closeKeypad()
    const nb = keypadAppend(active.field, buf, key)
    setBuf(nb)
    setKpError(null)
    if (nb !== buf && keypadComplete(active.field, nb)) commit(active, nb, false)
  }

  // 持っている血圧の上（下を入れる前）がある間は、画面を離れる・再読み込みの前に確かめる（既存の leaveGuard・反証レビュー中3）
  useEffect(() => registerUnsaved(() => [...draftsRef.current.values()].some((d) => 'sys_bp' in d)), [])

  // 物理キーボード（数字・小数点・Backspace・Enter・Esc）
  useEffect(() => {
    if (active === null) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      const k = toHalfWidth(e.key)
      if (/^\d$/.test(k) || k === '.') {
        e.preventDefault()
        press(k)
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        press('back')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        press('next')
      } else if (e.key === 'Escape') {
        e.preventDefault()
        press('close')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** 再測定の行を足す（次の回）＝基準を外れた欄から入れ始める */
  const addRecheck = (row: DaycareBoardRow, last: DaycareVitalSlot) => {
    if (!canWrite || data === null) return
    const local = (extraSeqs.get(row.residentId) ?? []).map((s) => daycareVitalKey(data.day, row.residentId, s))
    let seq = nextDaycareSeq([...data.keys, ...local, ...slotsOf(row.residentId).map((s) => s.key)], data.day, row.residentId)
    // 送信待ちにだけある回は使わない（上書きしない）
    for (let i = 0; i < 50; i += 1) {
      const key = daycareVitalKey(data.day, row.residentId, seq)
      if (pendingRow('vitals', { routine: false, clientKey: key, residentId: row.residentId, day: data.day, kind: 'observation' }) === null) break
      seq += 1
    }
    setExtraSeqs((prev) => {
      const next = new Map(prev)
      next.set(row.residentId, [...(next.get(row.residentId) ?? []), seq])
      return next
    })
    const vals: Partial<Record<DaycareVitalField, number | null>> = {}
    for (const f of DAYCARE_VITAL_FIELDS) vals[f] = valueOf(last, f).v
    flushHeldSys(active, null)
    setActive({ residentId: row.residentId, seq, key: daycareVitalKey(data.day, row.residentId, seq), field: firstAbnormalField(vals, targets.get(row.residentId)) })
    setBuf('')
    setKpError(null)
  }

  /** 競合の解き方: いまの値にする（自分の送信待ちを取り下げる）／あなたの値で直す（いまの値を基準にして送り直す） */
  const resolveTake = async (slot: DaycareVitalSlot, conflicts: CellConflict[]) => {
    const p = pendingRow('vitals', targetOf(slot))
    await discardPendingRow('vitals', targetOf(slot), conflicts.map((c) => c.field), p?.vers)
    setState(slot.key, null)
    scheduleReload()
  }
  const resolveMine = async (slot: DaycareVitalSlot, conflicts: CellConflict[]) => {
    const edits: Partial<Record<DaycareVitalField, number | null>> = {}
    const base: Record<string, unknown> = {}
    for (const c of conflicts) {
      edits[c.field as DaycareVitalField] = typeof c.mine === 'number' ? c.mine : c.mine == null ? null : Number(c.mine)
      base[c.field] = c.server
    }
    const pairErr = bpPairError(
      (edits.sys_bp ?? valueOf(slot, 'sys_bp').v) as number | null,
      (edits.dia_bp ?? valueOf(slot, 'dia_bp').v) as number | null,
    )
    if (pairErr !== null) {
      setState(slot.key, { kind: 'error', text: pairErr })
      return
    }
    await saveSlot(slot, edits, base)
  }

  // ── 描画 ──
  const header = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <DaycareNav current="vitals" />
        <RecorderBar actorId={actorId} staff={staff ?? null} />
      </div>
      <div className="flex flex-wrap items-center gap-gap" role="group" aria-label="日付">
        <button
          type="button"
          onClick={() => {
            releaseAllHeld()
            setDay((d) => addDays(d, -1))
          }}
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
          onClick={() => {
            releaseAllHeld()
            setDay((d) => (addDays(d, 1) > today ? d : addDays(d, 1)))
          }}
          disabled={day >= today}
          className="min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-lg text-ink disabled:text-ink3"
          aria-label="次の日へ"
        >
          <span aria-hidden="true">›</span>
        </button>
        {day !== today ? (
          <button
            type="button"
            onClick={() => {
              releaseAllHeld()
              setDay(today)
            }}
            className="min-h-tap rounded border border-primary px-4 text-base font-bold text-primary"
          >
            今日を開く
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            releaseAllHeld()
            setReloadKey((n) => n + 1)
          }}
          className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink"
        >
          最新に更新
        </button>
      </div>
      <div className="flex flex-wrap gap-gap" role="group" aria-label="表示する方">
        {DC_VITALS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={
              filter === f
                ? 'min-h-tap rounded-full border border-primary bg-primary px-4 text-base font-bold text-primary-ink'
                : 'min-h-tap rounded-full border border-border-strong bg-surface px-4 text-base text-ink'
            }
          >
            {filter === f ? <span aria-hidden="true">✓ </span> : null}
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>
      <p className="text-sm text-ink2">
        記号: ↑↑ 危険（高い）・↑ 注意（高い）・↓ 注意（低い）・↓↓ 危険（低い）・— 未測定。範囲外と血圧の上下逆は保存しません。
      </p>
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
      ) : data?.planSource === 'unknown' ? (
        <p role="alert" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>予定を確かめられません（週間計画の写しが読めません）。到着した方は表示されます。
        </p>
      ) : null}
    </div>
  )

  if (loading && data === null) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
        {header}
        <LoadingBlock label="デイのバイタルを読み込んでいます…" />
      </div>
    )
  }
  if (error !== null && (data === null || data.day !== day)) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
        {header}
        <ErrorBlock message={error} onRetry={() => setReloadKey((n) => n + 1)} />
      </div>
    )
  }
  if (data === null) return null

  const activeSlot = active === null ? null : (flatSlots.find((s) => s.key === active.key) ?? null)
  const prevOf = (id: number) => previousVitalOf(data.recent, id, data.day)

  const keypad =
    active !== null && activeSlot !== null ? (
      <section
        aria-label="テンキー"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border-strong bg-surface p-3 lg:sticky lg:top-20 lg:z-auto lg:w-80 lg:shrink-0 lg:rounded-lg lg:border"
      >
        <div className="mb-2" aria-live="polite">
          <p className="text-base text-ink">
            {nameOf(active.residentId)}・{DAYCARE_VITAL_LABEL[active.field]}
            {active.seq > 1 ? `（再測定 ${active.seq - 1}）` : ''}
          </p>
          <p className="font-num text-2xl font-bold text-ink">
            {buf === '' ? '—' : buf}
            <span className="ml-1 text-base font-normal text-ink2">{DAYCARE_VITAL_UNIT[active.field]}</span>
          </p>
          {kpError !== null ? (
            <p role="alert" className="mt-1 rounded border border-danger bg-danger-bg p-2 text-sm text-ink">
              <span aria-hidden="true">▲ </span>
              {kpError}
            </p>
          ) : (
            <p className="text-sm text-ink2">
              {(() => {
                const cur = valueOf(activeSlot, active.field).v
                const pv = prevOf(active.residentId)[active.field]
                const parts: string[] = []
                if (cur !== null) parts.push(`いまの値 ${fmtVal(active.field, cur)}`)
                if (pv !== undefined) parts.push(`前回 ${fmtVal(active.field, pv.value)}`)
                if (active.field === 'temp') parts.push('「365」で 36.5')
                return parts.join('・')
              })()}
            </p>
          )}
        </div>
        <div className="grid grid-cols-4 gap-gap">
          {[
            ['7', '7'], ['8', '8'], ['9', '9'], ['back', '⌫'],
            ['4', '4'], ['5', '5'], ['6', '6'], ['skip', '未測定'],
            ['1', '1'], ['2', '2'], ['3', '3'], ['next', '次へ'],
            ['0', '0'], ['.', '.'], ['close', '閉じる'],
          ].map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => press(k)}
              aria-label={k === 'back' ? '1文字消す' : k === 'skip' ? '未測定（空欄のまま次の欄へ）' : k === '.' ? '小数点' : undefined}
              disabled={k === '.' && active.field !== 'temp'}
              className={`min-h-14 rounded border text-xl ${
                k === 'next'
                  ? 'border-primary bg-primary font-bold text-primary-ink'
                  : k === 'close'
                    ? 'col-span-2 border-border-strong bg-surface text-base text-ink'
                    : k === 'skip'
                      ? 'border-border-strong bg-surface2 text-base text-ink'
                      : 'border-border-strong bg-surface2 font-num text-ink disabled:text-ink3'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
    ) : null

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
      {header}
      <div className="lg:flex lg:items-start lg:gap-4">
        <div className={`min-w-0 flex-1 space-y-3 ${active !== null ? 'pb-96 lg:pb-0' : ''}`}>
          {shownRows.length === 0 ? (
            <div className="rounded-lg border border-border bg-surface p-4">
              <p className="text-base text-ink">
                {filter === 'present' ? '到着した方がまだいません。' : 'この日の対象の方がいません。'}
              </p>
              <p className="mt-2 text-base text-ink2">「今日（到着・欠席）」で到着を記録すると、ここに並びます。</p>
            </div>
          ) : (
            <ul className="space-y-3" aria-label="バイタルの一覧">
              {shownRows.map((row) => {
                const slots = slotsOf(row.residentId)
                const prev = prevOf(row.residentId)
                const target = targets.get(row.residentId)
                return (
                  <li key={row.residentId} className="rounded-lg border border-border bg-surface p-3">
                    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-gap">
                      <p className="text-lg font-bold text-ink">{nameOf(row.residentId)}</p>
                      <p className="text-sm text-ink2">{target?.spo2_warn_below != null ? `個別: SpO2 ${target.spo2_warn_below}/${target.spo2_danger_below}` : '施設の基準'}</p>
                    </div>
                    {slots.map((slot, si) => {
                      const st = slotState.get(slot.key)
                      const pend = pendingRow('vitals', targetOf(slot))
                      const vals: Partial<Record<DaycareVitalField, number | null>> = {}
                      for (const f of DAYCARE_VITAL_FIELDS) vals[f] = valueOf(slot, f).v
                      const abnormal = vitalNeedsRecheck(vals, target)
                      const isLast = si === slots.length - 1
                      return (
                        <div key={slot.key} className={si > 0 ? 'mt-3 border-t border-border pt-3' : ''}>
                          <p className="mb-1 text-sm text-ink2">
                            {si === 0 ? '1回目' : `↳ 再測定 ${si}`}
                            {slot.vital?.measured_at ? `（${slot.vital.measured_at.slice(0, 5)}）` : ''}
                          </p>
                          <div className="grid grid-cols-5 gap-gap">
                            {DAYCARE_VITAL_FIELDS.map((f) => {
                              const { v, local } = valueOf(slot, f)
                              const lv = vitalLevel(f, v, target)
                              const isActive = active?.key === slot.key && active.field === f
                              const pv = prev[f]
                              const word = lv === null ? '' : LEVEL_WORD[lv]
                              return (
                                <button
                                  key={f}
                                  type="button"
                                  onClick={() => openCell(slot, f)}
                                  disabled={!canWrite}
                                  aria-label={`${nameOf(row.residentId)} ${DAYCARE_VITAL_LABEL[f]} ${v === null ? '未入力' : fmtVal(f, v)}${word ? ` ${word}` : ''}${pv ? `、前回 ${fmtVal(f, pv.value)}` : ''}${local ? '、未送信' : ''}`}
                                  className={`flex min-h-14 flex-col items-center justify-center rounded px-1 py-1 ${levelTone(lv)} ${
                                    isActive ? 'outline outline-4 outline-focus' : ''
                                  } disabled:opacity-100`}
                                >
                                  <span className="text-sm leading-tight text-ink2">{DAYCARE_VITAL_LABEL[f]}</span>
                                  <span className="font-num text-xl font-bold text-ink">
                                    {fmtVal(f, v)}
                                    {lv !== null ? <span aria-hidden="true">{LEVEL_MARK[lv]}</span> : null}
                                  </span>
                                  {lv !== null ? <span className="text-sm font-bold leading-tight text-ink">{word.split('・')[0]}</span> : null}
                                  <span className="text-sm leading-tight text-ink2">{pv ? `前回 ${fmtVal(f, pv.value)}` : '前回 —'}</span>
                                </button>
                              )
                            })}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-gap">
                            {abnormal && isLast ? (
                              <button
                                type="button"
                                onClick={() => addRecheck(row, slot)}
                                disabled={!canWrite}
                                className="min-h-tap rounded-full border-2 border-warn bg-warn-bg px-4 text-base font-bold text-ink disabled:opacity-60"
                              >
                                ＋再測定
                              </button>
                            ) : null}
                            <SlotStatus
                              st={
                                (st === undefined || st.kind === 'held') && pend !== null && pend.state === 'conflict' && pend.conflicts.length > 0
                                  ? { kind: 'conflict', conflicts: pend.conflicts }
                                  : st
                              }
                              pend={pend?.state ?? null}
                              onTake={(c) => void resolveTake(slot, c)}
                              onMine={(c) => void resolveMine(slot, c)}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {keypad}
      </div>
    </div>
  )
}

/** 1回の測定の保存の状態（記号＋文字） */
function SlotStatus({
  st,
  pend,
  onTake,
  onMine,
}: {
  st: SlotState | undefined
  pend: 'pending' | 'conflict' | 'rejected' | null
  onTake: (c: CellConflict[]) => void
  onMine: (c: CellConflict[]) => void
}) {
  if (st?.kind === 'conflict' && st.conflicts.length > 0) {
    return (
      <div role="alert" className="w-full rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
        <p>
          <span aria-hidden="true">▲ </span>他の端末が先に記録しました（測定済み）。
          {st.conflicts
            .map((c) => {
              const f = c.field as DaycareVitalField
              const label = DAYCARE_VITAL_LABEL[f] ?? c.field
              const sv = typeof c.server === 'number' ? fmtVal(f, c.server) : c.server == null ? '—' : String(c.server)
              const mv = typeof c.mine === 'number' ? fmtVal(f, c.mine) : c.mine == null ? '—' : String(c.mine)
              return `${label}: いまの値 ${sv}（あなた ${mv}）`
            })
            .join('・')}
        </p>
        <div className="mt-2 flex flex-wrap gap-gap">
          <button type="button" onClick={() => onTake(st.conflicts)} className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink">
            いまの値にする
          </button>
          <button type="button" onClick={() => onMine(st.conflicts)} className="min-h-tap rounded border border-primary bg-surface px-3 text-base text-primary">
            あなたの値で直す
          </button>
        </div>
      </div>
    )
  }
  if (st?.kind === 'error') {
    return (
      <p role="alert" className="rounded border border-danger bg-danger-bg p-2 text-sm text-ink">
        <span aria-hidden="true">▲ </span>
        {st.text}
      </p>
    )
  }
  if (st?.kind === 'saving') return <p className="text-sm text-ink2" role="status">↻ 送信中…</p>
  if (st?.kind === 'queued' || pend === 'pending') {
    const persisted = st?.kind === 'queued' ? st.persisted : true
    return (
      <p className="text-sm text-ink2" role="status">
        <span aria-hidden="true">⚠ </span>
        {persisted ? MSG_QUEUED : MSG_NOT_PERSISTED}
      </p>
    )
  }
  if (st?.kind === 'held' || pend === 'conflict') {
    return (
      <p className="text-sm text-ink" role="status">
        <span aria-hidden="true">▲ </span>他の端末の記録と食い違って止まっています。〔最新に更新〕で読み直し、もう一度入れてください。
      </p>
    )
  }
  if (pend === 'rejected') {
    return (
      <p className="text-sm text-ink" role="status">
        <span aria-hidden="true">▲ </span>サーバーに受け付けられなかった値があります。値を確かめて入れ直してください。
      </p>
    )
  }
  if (st?.kind === 'saved') return <p className="text-sm text-ok" role="status">✓ 保存済み</p>
  return null
}

export default DaycareVitalsPage
