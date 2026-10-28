// デイ（せせらぎ）のバイタル一括（ルート /record/daycare/vitals）。2026-10-22 デイ段階1・代表承認。
//
// 一覧＝その日のデイの方（既定は「予定の方」＝休み・入院中を除く予定の方と予定外で来た方。2026-10-24 §9.4 の4 で「到着した方」を外した。
// 絞り込みは端末の UI 状態 cl_dcVitalsFilter）。1人に1回目の行、
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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { ConfirmDialog, ErrorBlock, LoadingBlock } from '../components/ui'
import { registerUnsaved } from '../lib/leaveGuard'
import { useTableFit } from '../lib/useTableFit'
import { DaycareNav } from './DaycarePage'
import {
  DAYCARE_VITAL_FIELDS,
  DAYCARE_VITAL_HEAD,
  DAYCARE_VITAL_LABEL,
  DAYCARE_VITAL_UNIT,
  DC_VITALS_FILTERS,
  dcVitalSlotMark,
  LEVEL_WORD,
  bpPairError,
  buildDaycareBoard,
  daycareBulkRows,
  daycareVitalKey,
  daycareVitalSlots,
  editsHeldInQueue,
  firstAbnormalField,
  keypadAppend,
  keypadComplete,
  keypadValue,
  nextDaycareSeq,
  nowHm,
  overlayPendingMine,
  parseDaycareVitalKey,
  previousVitalOf,
  pruneReleaseIssues,
  readDcVitalsFilter,
  releaseEditsOf,
  releaseIssueLabel,
  vitalLevel,
  vitalNeedsRecheck,
  vitalRangeError,
} from '../lib/daycare'
import { writeDaycareHandoffFor } from '../lib/daycareHandoff'
import type { DaycareBoardRow, DaycareReleaseIssue, DaycareVitalField, DaycareVitalSlot, DcVitalsFilter, KeyedVital } from '../lib/daycare'
import { useVitalLimits } from '../hooks/useVitalLimits'
import { vitalThresholds } from '../lib/vitalThresholds'
import { VitalLimitsFailedNote } from '../components/VitalLimitsFailedNote'
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
  planned: '予定の方',
  all: '全員（休み・入院を含む）',
}

function readFilter(): DcVitalsFilter {
  try {
    return readDcVitalsFilter(window.localStorage.getItem(LS.dcVitalsFilter))
  } catch {
    return 'planned'
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

/**
 * テンキーの数字の並び（今日の画面の改善 2回目・2026-10-24）: 定時バイタルと同じ「数字3列（1 2 3 が上）＋右にボタン」。
 * 押した時の動き（press）と右のボタンの文言（次へ・未測定・閉じる）は変えない
 */
const DC_KEYPAD_KEYS: readonly (readonly [string, string])[] = [
  ['1', '1'], ['2', '2'], ['3', '3'],
  ['4', '4'], ['5', '5'], ['6', '6'],
  ['7', '7'], ['8', '8'], ['9', '9'],
  ['.', '.'], ['0', '0'], ['back', '⌫'],
]

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
  // 段階2d-2: 個人のバイタルの閾値（印・〔＋再測定〕をその方のその日の基準で出す。読めない時は施設の基準・その旨を出す）
  const limits = useVitalLimits(reloadKey)
  const [gate, setGate] = useState<{ value: boolean; observed: boolean; forbidden?: true; outdated?: true } | null>(null)
  const [filter, setFilterState] = useState<DcVitalsFilter>(readFilter)
  const [extraSeqs, setExtraSeqs] = useState<Map<number, number[]>>(new Map())
  /** 入れたが送っていない値（血圧の上を下と組で送るまで持つ・送信中の値） */
  const [drafts, setDrafts] = useState<Map<string, Partial<Record<DaycareVitalField, number | null>>>>(new Map())
  const [slotState, setSlotState] = useState<Map<string, SlotState>>(new Map())
  const [active, setActive] = useState<Active | null>(null)
  const [buf, setBuf] = useState('')
  const [kpError, setKpError] = useState<string | null>(null)
  /** 日付の切り替え・読み直しを止めた理由（送れなかった・捨てた測定と、押した操作） */
  const [pageMsg, setPageMsg] = useState<{ issues: DaycareReleaseIssue[]; go: () => void } | null>(null)
  /** 〔保存せずに移る〕の確認を開いているか */
  const [discardAsk, setDiscardAsk] = useState(false)
  /** 日付の切り替え・読み直しの前の片づけ中（欄と日付の操作を止める＝3巡目 軽1） */
  const [releasing, setReleasing] = useState(false)
  const releasingRef = useRef(false)
  const [queueTick, setQueueTick] = useState(0)
  /** 血圧の上下逆で止めた測定（その上は送らない＝打ち直してもらう・反証レビュー中4） */
  const pairBlocked = useRef(new Set<string>())
  /** 入れたが送っていない値の写し（離れる時の確認・片づけに使う）。書く時は writeDrafts で state と同時に更新する（await の後でも最新を読む） */
  const draftsRef = useRef(drafts)
  /** 送っている最中の欄（測定のキー → 欄 → 本数）と、送っている最中の保存（片づけの前に待つ） */
  const inflightRef = useRef(new Map<string, Map<string, number>>())
  const inflightSaves = useRef(new Set<Promise<unknown>>())
  const dataRef = useRef<VData | null>(null)
  const genRef = useRef(0)
  const dayRef = useRef(day)
  dayRef.current = day
  dataRef.current = data
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

  const load = useCallback(async (target: string, quiet0: boolean) => {
    const gen = ++genRef.current
    // 表示中と違う日を読む時は、静かな読み直しでも失敗を出す（新しい日の読み込みを追い越して失敗すると「読み込んでいます」の
    // まま止まるため＝反証レビュー4巡目 F3）
    const quiet = quiet0 && dataRef.current !== null && dataRef.current.day === target
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
    draftsRef.current = new Map()
    setDrafts(draftsRef.current)
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
    // 予定の方＝一括の4画面と同じ関数（daycareBulkRows・食事一括・活動一括・機能訓練とそろえる）
    return filter === 'all' ? board.rows : daycareBulkRows(board.rows)
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

  // 送り先の日はキーの日付から取る（表示中の日ではない＝読み込みの間に前の日の行を押しても別の日へ送らない・3巡目 中1）
  const targetOf = (slot: DaycareVitalSlot): VitalTarget => ({
    routine: false,
    clientKey: slot.key,
    residentId: slot.residentId,
    day: parseDaycareVitalKey(slot.key)?.day ?? dayRef.current,
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
  const writeDrafts = (next: Map<string, Partial<Record<DaycareVitalField, number | null>>>) => {
    draftsRef.current = next
    setDrafts(next)
  }
  const setDraft = (key: string, f: DaycareVitalField, v: number | null | undefined) => {
    const next = new Map(draftsRef.current)
    const cur = { ...(next.get(key) ?? {}) }
    if (v === undefined) delete cur[f]
    else cur[f] = v
    if (Object.keys(cur).length === 0) next.delete(key)
    else next.set(key, cur)
    writeDrafts(next)
  }
  /** 送れた欄の入力を外す。送っている間に打ち直した欄（値が違う）は残す（3巡目 軽1 b） */
  const clearSentDraft = (key: string, edits: Partial<Record<DaycareVitalField, number | null>>) => {
    for (const [f, v] of Object.entries(edits)) {
      const fld = f as DaycareVitalField
      const d = draftsRef.current.get(key)
      if (d !== undefined && fld in d && (d[fld] ?? null) === (v ?? null)) setDraft(key, fld, undefined)
    }
  }
  const markInflight = (key: string, fields: string[], delta: 1 | -1) => {
    const m = new Map(inflightRef.current.get(key) ?? [])
    for (const f of fields) {
      const n = (m.get(f) ?? 0) + delta
      if (n > 0) m.set(f, n)
      else m.delete(f)
    }
    if (m.size === 0) inflightRef.current.delete(key)
    else inflightRef.current.set(key, m)
  }

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

  /**
   * 1回の測定の欄を保存する（既存の saveVitalEdits＝0011 そのまま。基準は読んだ時のサーバーの値）。
   * 戻り値: null＝値はサーバーか送信待ちに載った（競合・止まった行を含む）／文字列＝載せられなかった理由（入力は画面に残す）
   */
  const saveSlot = (
    slot: DaycareVitalSlot,
    edits: Partial<Record<DaycareVitalField, number | null>>,
    rebase?: Record<string, unknown>,
  ): Promise<string | null> => {
    if (actorId === null) {
      setState(slot.key, { kind: 'error', text: MSG_NO_RECORDER })
      return Promise.resolve(MSG_NO_RECORDER)
    }
    const fields = Object.keys(edits)
    markInflight(slot.key, fields, 1)
    const run = sendSlot(slot, edits, actorId, rebase)
    inflightSaves.current.add(run)
    return run.finally(() => {
      inflightSaves.current.delete(run)
      markInflight(slot.key, fields, -1)
    })
  }
  const sendSlot = async (
    slot: DaycareVitalSlot,
    edits: Partial<Record<DaycareVitalField, number | null>>,
    actor: number,
    rebase?: Record<string, unknown>,
  ): Promise<string | null> => {
    const send: Record<string, { value: unknown; base?: unknown }> = {}
    for (const [f, v] of Object.entries(edits)) {
      const base = rebase !== undefined && f in rebase ? rebase[f] : (slot.vital?.[f as DaycareVitalField] ?? null)
      send[f] = { value: v, base }
    }
    setState(slot.key, { kind: 'saving' })
    void ensureOpened()
    try {
      const slotDay = parseDaycareVitalKey(slot.key)?.day ?? dayRef.current
      const r = await saveVitalEdits(targetOf(slot), send as CellEditInput<VitalCellField>, {
        // 測定時刻は今日の測定だけいまの時刻で埋める（過去の日にいまの時刻を入れない＝反証レビュー中7）
        fill: slotDay === todayIso() ? { measured_at: nowHm(), recorded_by: actor } : { recorded_by: actor },
        editedBy: actor,
        rebase: rebase !== undefined,
      })
      clearSentDraft(slot.key, edits)
      if (r === 'queued') {
        setState(slot.key, { kind: 'queued', persisted: isQueuePersisted() })
        return null
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
      return null
    } catch (e) {
      const text = e instanceof DbError ? e.message : '保存できませんでした。通信状態を確認して、もう一度入れてください。'
      setState(slot.key, { kind: 'error', text })
      return text
    }
  }

  /**
   * 競合の「あなたの値」を、いまの送信待ちの値（止まった後に打ち直した値）に置き換える。競合した時の値のままにすると、
   * 〔あなたの値で直す〕が打ち直す前の古い値を送るため（反証レビュー2巡目 中1・既存のバイタル一覧の mineOf と同じ考え方）
   */
  const withCurrentMine = (slot: DaycareVitalSlot, cs: CellConflict[]): CellConflict[] =>
    overlayPendingMine(cs, pendingRow('vitals', targetOf(slot))?.values ?? null)

  // ── テンキー ──
  const openCell = (slot: DaycareVitalSlot, field: DaycareVitalField) => {
    if (!canWrite || releasingRef.current) return
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
    void releaseHeldOf(cur.key)
  }

  /**
   * その測定の入れたが送っていない値を送る（上だけ・下と組・ほかの欄も。送っている最中の欄は除く）。
   * 上下逆で止めた後の上は送らずに捨てる。送り先はキーから組み立てる（絞り込みで外れた方・キーの日付で送る）。
   * 戻り値: null＝片づいた／項目＝送れなかった（kept＝入力を残した）・捨てた（kept=false）
   */
  const releaseHeldOf = async (key: string): Promise<DaycareReleaseIssue | null> => {
    const edits = releaseEditsOf(draftsRef.current.get(key), new Set(inflightRef.current.get(key)?.keys() ?? []))
    if (Object.keys(edits).length === 0) return null
    let dropped: string | null = null
    if (pairBlocked.current.has(key) && 'sys_bp' in edits) {
      pairBlocked.current.delete(key)
      setDraft(key, 'sys_bp', undefined)
      delete edits.sys_bp
      dropped = '血圧は上下逆のため保存していません。測り直して、上から入れ直してください。'
      setState(key, { kind: 'error', text: dropped })
    }
    if (Object.keys(edits).length === 0) return dropped === null ? null : { key, kept: false, reason: dropped }
    const k = parseDaycareVitalKey(key)
    if (k === null) return { key, kept: true, reason: '測定を特定できませんでした。' }
    const cur = dataRef.current
    const slot: DaycareVitalSlot = {
      residentId: k.residentId,
      seq: k.seq,
      key,
      vital: cur !== null && cur.day === k.day ? (cur.live.find((v) => v.client_key === key) ?? null) : null,
    }
    const err = await saveSlot(slot, edits)
    if (err !== null) {
      // 控えに無い（記録者が未選択・入力の封鎖などで送る前に止まった）時は、入力を残して止める
      if (!editsHeldInQueue(edits, pendingRow('vitals', targetOf(slot))?.values)) return { key, kept: true, reason: err }
      // サーバーに拒まれた値は送信待ちの控えに残る（消えない）。黙って移らず、どこで確かめるかを帯に出す（反証レビュー4巡目 F4）
      clearSentDraft(key, edits)
      const where = 'サーバーに受け付けられませんでした。値はこの端末の送信待ちに残っています（この日のデイのバイタル一括のその方の行で確かめ、入れ直してください）。'
      return { key, kept: false, reason: dropped === null ? where : `${dropped}${where}` }
    }
    return dropped === null ? null : { key, kept: false, reason: dropped }
  }

  /**
   * 日付の切り替え・読み直しの前: 送っている最中の保存を待ってから、入れたが送っていない値を全部送る（黙って消さない＝反証レビュー中3）。
   * 戻り値は送れなかった・捨てた測定の一覧（空なら移ってよい）
   */
  const releaseAllHeld = async (): Promise<DaycareReleaseIssue[]> => {
    await Promise.allSettled([...inflightSaves.current])
    const results = await Promise.all([...draftsRef.current.keys()].map((key) => releaseHeldOf(key)))
    return results.filter((x): x is DaycareReleaseIssue => x !== null)
  }
  /**
   * 日付の切り替え・読み直し（入れた値を片づけてから）。片づけの間はテンキーを閉じ、欄と日付の操作を止める（待つ間に入れた値が
   * 移った後に消えないように＝3巡目 軽1）。送れなかったら移らずに帯で理由と〔保存せずに移る〕を出す（3巡目 軽2・軽4）
   */
  const afterRelease = (go: () => void) => {
    if (releasingRef.current) return
    releasingRef.current = true
    setReleasing(true)
    setActive(null)
    setBuf('')
    setKpError(null)
    void (async () => {
      try {
        const issues = await releaseAllHeld()
        if (issues.length > 0) {
          setPageMsg({ issues, go })
          return
        }
        setPageMsg(null)
        go()
      } finally {
        releasingRef.current = false
        setReleasing(false)
      }
    })()
  }
  /** 〔保存せずに移る〕: 帯に出した測定の入力を捨てて、止めた操作をする */
  const discardAndGo = () => {
    const msg = pageMsg
    setDiscardAsk(false)
    // 片づけの最中は何もしない（帯を消してから片づけを呼ぶと、片づけ中で何もせずに戻り、止めていた操作が黙って消えるため
    // ＝反証レビュー5巡目 軽2）。帯のボタンも片づけの間は押せない
    if (msg === null || releasingRef.current) return
    // 捨てるのは帯に出した「入力を残した」測定だけ。捨てた（上下逆）・拒まれた測定の今の入力（帯が出た後に打ち直した値）は捨てない。
    // 残りの入力（帯が出た後に入れた値を含む）は、もう一度片づけてから移る（送れなければまた帯に出す＝反証レビュー4巡目 F2）
    const next = new Map(draftsRef.current)
    for (const i of msg.issues) {
      if (!i.kept) continue
      next.delete(i.key)
      pairBlocked.current.delete(i.key)
    }
    writeDrafts(next)
    setPageMsg(null)
    afterRelease(msg.go)
  }
  // 帯に出した測定の入力が、ほかの経路で送れて無くなったら、その項目を帯から外す（3巡目 軽4）
  useEffect(() => {
    setPageMsg((m) => {
      if (m === null) return m
      const issues = pruneReleaseIssues(m.issues, (key) => drafts.has(key))
      if (issues.length === m.issues.length) return m
      return issues.length === 0 ? null : { ...m, issues }
    })
  }, [drafts])

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

  // 入れたが送っていない値（血圧の上・送れなかった値）がある間は、画面を離れる・再読み込みの前に確かめる（既存の leaveGuard・反証レビュー中3）
  useEffect(() => registerUnsaved(() => [...draftsRef.current.values()].some((d) => Object.keys(d).length > 0)), [])

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
    if (!canWrite || data === null || releasingRef.current) return
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
    setActive({ residentId: row.residentId, seq, key: daycareVitalKey(data.day, row.residentId, seq), field: firstAbnormalField(vals, targets.get(row.residentId), limits.lookup(row.residentId, data.day)) })
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
  const resolveMine = async (slot: DaycareVitalSlot, conflicts0: CellConflict[]) => {
    const conflicts = withCurrentMine(slot, conflicts0)
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

  // ── 表の横スクロールの枠（今日の画面の改善 2回目・定時バイタルと同じ）。表が枠より広い（横にスクロールできる）時だけ手がかりを出す ──
  const [tableBox, setTableBox] = useState<HTMLDivElement | null>(null)
  const [tableScrolls, setTableScrolls] = useState(false)
  /** 表の枠の中で縦に送れるか（2026-10-28: 枠に高さの上限を付けた。送れる時は枠をキーボードで選べるようにする） */
  const [tableScrollsY, setTableScrollsY] = useState(false)
  /** 表の枠の幅（行の下の詳しい文を、この幅で折り返して左に残すため） */
  const [tableBoxWidth, setTableBoxWidth] = useState(0)
  useEffect(() => {
    const el = tableBox
    if (!el) return
    const check = () => {
      setTableScrolls(el.scrollWidth > el.clientWidth + 1)
      setTableScrollsY(el.scrollHeight > el.clientHeight + 1)
      setTableBoxWidth(el.clientWidth)
    }
    check()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', check)
      return () => window.removeEventListener('resize', check)
    }
    // 枠（画面幅・文字の大きさ）と表（行の増減）の両方の大きさの変化で測り直す
    const ro = new ResizeObserver(check)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [tableBox])

  // ── テンキーの高さ（今日の画面の改善 2回目）: 表の下に同じ高さの余白をとり、最後の行もテンキーの上へ送れるようにする（文字の大きさで変わるので測る） ──
  const [kpBox, setKpBox] = useState<HTMLElement | null>(null)
  const [kpHeight, setKpHeight] = useState(0)
  useEffect(() => {
    const el = kpBox
    if (!el) {
      setKpHeight(0)
      return
    }
    const check = () => setKpHeight(Math.ceil(el.getBoundingClientRect().height))
    check()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', check)
      return () => window.removeEventListener('resize', check)
    }
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [kpBox])
  // 枠の高さの上限（画面の高さ − アプリの見出し − 下部タブ − テンキー）を実測して書き戻す（見出しの行を枠の上に残す・2026-10-28）
  useTableFit(tableBox, active !== null ? kpHeight : 0)
  // 入れている欄を見せる（2026-10-28: 枠に高さの上限を付け、テンキーが開くと枠が縮むので、押した欄・〔次へ〕で移った欄がテンキーの下や
  // 枠の下に隠れないように）。先に枠の下端がテンキーの上に来るまでページを送り、次に枠の中で欄へ送る
  // （上の見出しと左の氏名の列の分は .dc-table-fit の scroll-padding で避ける）
  useEffect(() => {
    // テンキーの高さが測れるまでは送らない（測る前の高さで送ると、縮む前の枠で計算してページの一番下まで送ってしまう＝反証 重1）
    if (active === null || tableBox === null || kpHeight === 0) return
    const cell = tableBox.querySelector<HTMLElement>('[data-dc-active]')
    if (cell === null) return
    // テンキーの上端（狭い画面では下部タブの上に出る）より下に枠の下端があれば、その分だけページを送る
    const over = tableBox.getBoundingClientRect().bottom - (kpBox !== null ? kpBox.getBoundingClientRect().top : window.innerHeight)
    if (over > 0) window.scrollBy(0, over)
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active, tableBox, kpBox, kpHeight])

  // ── 描画 ──
  const header = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <DaycareNav current="vitals" handoff={() => writeDaycareHandoffFor({ rows: board?.rows ?? null, residents, boardDay: data?.day ?? null, today })} />
        <RecorderBar actorId={actorId} staff={staff ?? null} />
      </div>
      <div className="flex flex-wrap items-center gap-gap" role="group" aria-label="日付">
        <button
          type="button"
          onClick={() => afterRelease(() => setDay((d) => addDays(d, -1)))}
          disabled={releasing}
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
          onClick={() => afterRelease(() => setDay((d) => (addDays(d, 1) > today ? d : addDays(d, 1))))}
          disabled={day >= today || releasing}
          className="min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-lg text-ink disabled:text-ink3"
          aria-label="次の日へ"
        >
          <span aria-hidden="true">›</span>
        </button>
        {day !== today ? (
          <button
            type="button"
            onClick={() => afterRelease(() => setDay(today))}
            disabled={releasing}
            className="min-h-tap rounded border border-primary px-4 text-base font-bold text-primary"
          >
            今日を開く
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => afterRelease(() => setReloadKey((n) => n + 1))}
          disabled={releasing}
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
                ? 'min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink'
                : 'min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink'
            }
          >
            {filter === f ? <span aria-hidden="true">✓ </span> : null}
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>
      {releasing ? (
        <p role="status" className="text-base text-ink2">
          入れた値を保存しています…
        </p>
      ) : null}
      {pageMsg !== null ? (
        <div role="alert" className="space-y-2 rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <p>
            <span aria-hidden="true">▲ </span>
            {pageMsg.issues.some((i) => i.kept)
              ? 'まだ保存していない値があるため、移っていません。確かめてから、もう一度押してください。'
              : '保存しなかった値がありました。確かめてから移ってください。'}
          </p>
          <ul className="list-disc space-y-1 pl-6">
            {pageMsg.issues.map((i) => (
              <li key={i.key}>
                {releaseIssueLabel(i.key, nameOf)}: {i.reason}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => (pageMsg.issues.some((i) => i.kept) ? setDiscardAsk(true) : discardAndGo())}
            disabled={releasing}
            className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink disabled:text-ink3"
          >
            {pageMsg.issues.some((i) => i.kept) ? '保存せずに移る' : '移る'}
          </button>
        </div>
      ) : null}
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

  // 前の日の行を出したまま新しい日を読む間は、行を出さない（押せる古い行を残さない＝3巡目 中1）
  if ((loading && data === null) || (data !== null && data.day !== day && error === null)) {
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
      // 今日の画面の改善 2回目（2026-10-24）: どの幅でも画面の下に出す（定時バイタルと同じ置き場所と並び）。
      // 押した時の動き（桁がそろうと次へ・SpO2 の次は次の方の体温・血圧の上は下と組で送る）と文言は変えない
      <section ref={setKpBox} aria-label="テンキー" className="dc-keypad fixed inset-x-0 bottom-14 z-40 border-t border-border-strong bg-surface p-3 lg:bottom-0">
        <div className="mx-auto max-w-md">
          <div className="mb-2" aria-live="polite">
            <div className="flex flex-wrap items-baseline justify-between gap-gap">
              <p className="text-base text-ink">
                <span className="font-bold">{nameOf(active.residentId)}</span>
                <span className="ml-2">
                  {DAYCARE_VITAL_LABEL[active.field]}
                  {active.seq > 1 ? `（再測定 ${active.seq - 1}）` : ''}
                </span>
              </p>
              <p className="font-num text-2xl font-bold text-ink">
                {buf === '' ? '—' : buf}
                <span className="ml-1 text-base font-normal text-ink2">{DAYCARE_VITAL_UNIT[active.field]}</span>
              </p>
            </div>
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
          <div className="flex gap-gap">
            <div className="grid grid-cols-3 gap-gap">
              {DC_KEYPAD_KEYS.map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => press(k)}
                  aria-label={k === 'back' ? '1文字消す' : k === '.' ? '小数点' : undefined}
                  disabled={k === '.' && active.field !== 'temp'}
                  className="min-h-16 w-14 rounded border border-border-strong bg-surface2 font-num text-xl font-bold text-ink disabled:text-ink3"
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex flex-1 flex-col gap-gap">
              <button
                type="button"
                onClick={() => press('next')}
                className="min-h-16 rounded border border-primary bg-primary px-3 text-xl font-bold text-primary-ink"
              >
                次へ
              </button>
              <button
                type="button"
                onClick={() => press('skip')}
                aria-label="未測定（空欄のまま次の欄へ）"
                className="min-h-tap rounded border border-border-strong bg-surface2 px-3 text-base text-ink"
              >
                未測定
              </button>
              <button type="button" onClick={() => press('close')} className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink">
                閉じる
              </button>
            </div>
          </div>
        </div>
      </section>
    ) : null

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
      {header}
      {limits.failed ? <VitalLimitsFailedNote className="" onRetry={() => void limits.refresh()} /> : null}
      <div className="min-w-0 space-y-2">
        {shownRows.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="text-base text-ink">
              {filter === 'all' ? 'この日のデイの予定・記録はまだありません。' : 'この日の予定の方がいません（休み・入院中の方は「全員」で出せます）。'}
            </p>
            <p className="mt-2 text-base text-ink2">予定外で来た方は「今日（到着・休み）」の〔予定にない方を追加〕で足したカードを押し、〔予定外で到着〕を押すと、ここに並びます。</p>
          </div>
        ) : (
          <>
            {/* 表が画面より広い時だけ出す手がかり（広い画面では出ない＝定時バイタルと同じ） */}
            {tableScrolls ? (
              <p className="text-sm text-ink2">
                <span aria-hidden="true">⇆ </span>
                表は横にスクロールできます（氏名の列は左に残ります）
              </p>
            ) : null}
            {/* 今日の画面の改善 2回目（2026-10-24）: 定時バイタルと同じ1行1人の表。再測定はその方の行のすぐ下に「↳ 再測定 n」の行で足す。
                横スクロールはこの枠の中だけ（ページ全体を広げない）。relative は表の中の読み上げ用の文字の基準をこの枠にするため */}
            <div
              ref={setTableBox}
              role="region"
              aria-label={`${fmtDayLabel(day)}のデイのバイタル入力表${tableScrolls ? '（横にスクロールできます）' : ''}`}
              tabIndex={tableScrolls || tableScrollsY ? 0 : undefined}
              className="dc-table-fit relative isolate overflow-auto"
            >
              <table className="w-full min-w-max border-collapse text-base">
                <caption className="sr-only">{fmtDayLabel(day)}のデイのバイタル入力表</caption>
                <thead>
                  <tr className="border-b border-border-strong bg-surface2 text-left">
                    {/* 氏名の列は横スクロールしても左に残す（sticky）。背景は見出し行と同じ色 */}
                    <th scope="col" className="sticky left-0 top-0 z-30 bg-surface2 px-2 py-2 text-sm font-bold text-ink2">
                      <span className="dc-vital-name block">氏名</span>
                    </th>
                    {DAYCARE_VITAL_FIELDS.map((f) => (
                      <th key={f} scope="col" className="sticky top-0 z-20 w-24 bg-surface2 px-2 py-2 text-sm font-bold text-ink2">
                        <span aria-hidden="true">{DAYCARE_VITAL_HEAD[f]}</span>
                        <span className="sr-only">{DAYCARE_VITAL_LABEL[f]}</span>
                      </th>
                    ))}
                    <th scope="col" className="sticky top-0 z-20 w-28 bg-surface2 px-2 py-2 text-sm font-bold text-ink2">
                      再測定
                    </th>
                    <th scope="col" className="sticky top-0 z-20 w-28 bg-surface2 px-2 py-2 text-sm font-bold text-ink2">
                      状態
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shownRows.map((row) => {
                    const slots = slotsOf(row.residentId)
                    const prev = prevOf(row.residentId)
                    const target = targets.get(row.residentId)
                    const th = limits.lookup(row.residentId, data.day)
                    const own = th !== vitalThresholds()
                    const basis =
                      target?.spo2_warn_below != null
                        ? `個別: SpO2 ${target.spo2_warn_below}/${target.spo2_danger_below}${own ? '・個人の基準' : ''}`
                        : own
                          ? '個人の基準'
                          : '施設の基準'
                    return slots.map((slot, si) => {
                      const st = slotState.get(slot.key)
                      const pend = pendingRow('vitals', targetOf(slot))
                      const vals: Partial<Record<DaycareVitalField, number | null>> = {}
                      for (const f of DAYCARE_VITAL_FIELDS) vals[f] = valueOf(slot, f).v
                      const abnormal = vitalNeedsRecheck(vals, target, th)
                      const isLast = si === slots.length - 1
                      const shown: SlotState | undefined =
                        (st === undefined || st.kind === 'held') && pend !== null && pend.state === 'conflict' && pend.conflicts.length > 0
                          ? { kind: 'conflict', conflicts: withCurrentMine(slot, pend.conflicts) }
                          : st !== undefined && st.kind === 'conflict'
                            ? { kind: 'conflict', conflicts: withCurrentMine(slot, st.conflicts) }
                            : st
                      const mark = dcVitalSlotMark(shown?.kind, pend?.state ?? null)
                      // 詳しい文と解き方のボタンは、行の下の1行に出す（送信中は状態の列の印だけ）。保存済みでも送信待ちが動いていれば
                      // （同じ端末の別のタブなど）その文を出す（前の SlotStatus と同じ出し方＝#45 の反証 軽4）
                      const detail = shown?.kind === 'saving' ? false : (shown !== undefined && shown.kind !== 'saved') || pend !== null
                      const time = slot.vital?.measured_at ? slot.vital.measured_at.slice(0, 5) : null
                      return (
                        <Fragment key={slot.key}>
                          <tr className={`align-middle ${detail || !isLast ? '' : 'border-b border-border'}`}>
                            {/* 氏名の列は横スクロールしても左に残す（sticky）。背景はページの地の色（下を流れる欄を透かさない） */}
                            <th scope="row" className="sticky left-0 z-10 bg-bg px-2 py-1 text-left font-normal">
                              {/* 氏名の列の幅は dc-vital-name で決める（札が長くても列を広げず、中で折り返す＝確認の反証 重） */}
                              <div className="dc-vital-name">
                                {si === 0 ? (
                                  <>
                                    <span className="block text-base font-bold text-ink">{nameOf(row.residentId)}</span>
                                    <span className="block text-sm text-ink2">{basis}</span>
                                    {slots.length > 1 || time !== null ? (
                                      <span className="block text-sm text-ink2">1回目{time !== null ? `（${time}）` : ''}</span>
                                    ) : null}
                                  </>
                                ) : (
                                  <span className="block text-sm text-ink2">
                                    <span aria-hidden="true">↳ </span>
                                    再測定 {si}
                                    {time !== null ? `（${time}）` : ''}
                                    <span className="sr-only">：{nameOf(row.residentId)}</span>
                                  </span>
                                )}
                              </div>
                            </th>
                            {DAYCARE_VITAL_FIELDS.map((f) => {
                              const { v, local } = valueOf(slot, f)
                              const lv = vitalLevel(f, v, target, th)
                              const isActive = active?.key === slot.key && active.field === f
                              const pv = prev[f]
                              const word = lv === null ? '' : LEVEL_WORD[lv]
                              return (
                                <td key={f} className="px-1 py-1">
                                  <button
                                    type="button"
                                    onClick={() => openCell(slot, f)}
                                    disabled={!canWrite}
                                    data-dc-active={isActive ? '' : undefined}
                                    aria-label={`${nameOf(row.residentId)} ${DAYCARE_VITAL_LABEL[f]} ${v === null ? '未入力' : fmtVal(f, v)}${word ? ` ${word}` : ''}${pv ? `、前回 ${fmtVal(f, pv.value)}` : ''}${local ? '、未送信' : ''}`}
                                    className={`flex min-h-14 w-full flex-col items-center justify-center rounded px-1 text-center ${
                                      isActive ? 'border-2 border-primary bg-accent-bg' : levelTone(lv)
                                    } disabled:opacity-100`}
                                  >
                                    {v === null ? (
                                      // 空の欄だけ前回の値を薄く出す（定時バイタルと同じ・親の回答 4）
                                      <span className="font-num text-sm text-ink3" aria-hidden="true">
                                        {pv ? `前回${fmtVal(f, pv.value)}` : '—'}
                                      </span>
                                    ) : (
                                      <>
                                        <span className="font-num text-xl font-bold text-ink">
                                          {fmtVal(f, v)}
                                          {lv !== null ? <span aria-hidden="true">{LEVEL_MARK[lv]}</span> : null}
                                        </span>
                                        {lv !== null ? <span className="text-sm font-bold leading-tight text-ink">{word.split('・')[0]}</span> : null}
                                      </>
                                    )}
                                  </button>
                                </td>
                              )
                            })}
                            <td className="px-1 py-1">
                              {abnormal && isLast ? (
                                <button
                                  type="button"
                                  onClick={() => addRecheck(row, slot)}
                                  disabled={!canWrite}
                                  aria-label={`${nameOf(row.residentId)}さんの再測定を足す`}
                                  className="min-h-tap w-full rounded border-2 border-warn bg-warn-bg px-2 text-base font-bold text-ink disabled:opacity-60"
                                >
                                  ＋再測定
                                </button>
                              ) : null}
                            </td>
                            <td className="px-2 py-1">
                              {mark !== null ? (
                                // 送信中・保存済みも読み上げで知らせる（前の SlotStatus の role="status" と同じ＝#45 の反証 軽3）
                                <span role="status" className={`text-sm font-bold ${mark.tone === 'ok' ? 'text-ok' : mark.tone === 'warn' ? 'text-warn' : 'text-ink2'}`}>
                                  <span aria-hidden="true">{mark.mark} </span>
                                  {mark.text}
                                </span>
                              ) : null}
                            </td>
                          </tr>
                          {detail ? (
                            <tr className={isLast ? 'border-b border-border' : ''}>
                              {/* 詳しい文の行は表の幅を広げない（定時バイタルの F01 手直し 2026-10-10 と同じ形・#45 の反証 重1）。
                                  表は自動の幅（min-w-max）なので、長い文の1行ぶんの幅が氏名の列に配られて表が広がり、
                                  欄が sticky の氏名の列の下に隠れて押せなくなる。幅0＋最小100% の箱で表の幅の計算から外し、
                                  文は表の枠の幅で折り返して、横スクロールしても左に残す（sticky） */}
                              <td colSpan={DAYCARE_VITAL_FIELDS.length + 3} className="p-0">
                                <div className="w-0 min-w-full">
                                  <div className="sticky left-0 px-2 pb-2" style={{ maxWidth: tableBoxWidth > 0 ? tableBoxWidth : undefined }}>
                                    <SlotStatus st={shown} pend={pend?.state ?? null} onTake={(c) => void resolveTake(slot, c)} onMine={(c) => void resolveMine(slot, c)} />
                                  </div>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      )
                    })
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {/* テンキーを出している間は、テンキーと同じ高さの余白をとる（最後の行もテンキーに隠れない） */}
      {active !== null ? <div aria-hidden="true" style={{ height: kpHeight }} /> : null}
      {keypad}
      <ConfirmDialog
        open={discardAsk}
        title="保存せずに移りますか"
        body="帯に出した方の、まだ保存していない値を捨てて移ります。捨てた値は戻せません（ほかの方の入れた値は保存してから移ります）。"
        confirmLabel="保存せずに移る"
        danger
        onConfirm={discardAndGo}
        onCancel={() => setDiscardAsk(false)}
      />
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
