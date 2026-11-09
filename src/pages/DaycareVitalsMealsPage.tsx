// デイ（せせらぎ）のバイタル・食事（ルート /record/daycare/vitals-meals・業務日は ?day=）。
// 2026-11-09 計画B3（代表者の指示「バイタル一括と食事一括画面は、それぞれだと余白が多く無駄で見づらいため、一つの画面に統合せよ」）:
// それまでのバイタル一括（/record/daycare/vitals・2026-10-22 デイ段階1・代表承認）と食事一括（/record/daycare/meals）を1つの表にした。
// 1行1人で、列は 氏名｜血圧（上 / 下）｜P｜SpO2｜KT｜状態（来た・まだ・〔＋再測定〕と保存の印）‖ 主食｜副食｜水分（cc）。バイタルと食事の境目は
// 見出しの行の色の帯（分類の色＝tokens.css の --c-cat-*）。昼食と水分の列の中身は DaycareLunchColumns.tsx（それまでの食事一括の処理のまま）。
// 古い2つの道は App.tsx でこの画面へ送る（?day= を引き継ぐ）。行の地は1人ずつ交互に変える（--c-row-alt）。
// 業務日は URL の ?day=（再読み込みでも同じ日に戻る＝原則11・端末に業務データを残さない。それまでのバイタル一括は画面の中だけで持っていた）。
// 以下はそれまでのバイタル一括の決まり（変えていない。KT の次の欄送りだけ、同じ方の主食へ＝計画B3）:
//
// 一覧＝その日のデイの方（既定は「予定の方」＝休み・入院中を除く予定の方と予定外で来た方。2026-10-24 §9.4 の4 で「到着した方」を外した。
// 絞り込みは端末の UI 状態 cl_dcVitalsFilter）。1人に1回目の行、
// 基準を外れた時は〔＋再測定〕で2回目以降の行を足す。欄を押すとテンキー（広い画面は右に常設・狭い画面は下から）。
// 欄送りは桁数で自動（体温 365→36.5・血圧の上と脈は先頭が1か2なら3桁・血圧の下と SpO2 は先頭が1なら3桁）。
// 列と欄送りの順は 血圧の上 → 下 → P → SpO2 → KT（2026-11-09 計画B2・DC_BULK_VITAL_ORDER）。KT が埋まるとテンキーを閉じて、
// 同じ方の主食の選択肢へフォーカスを移す（2026-11-09 計画B3。それまでは次の方の血圧の上へ）。
// 物理キーボード（数字・.・Backspace・Enter・Esc）も効く。
// 保存（代表者の回答 5.2 の10）: 範囲外（DB の check と同じ VITAL_RANGE）と血圧の上下逆（上 ≦ 下）は保存しない（欄に理由・欄は進まない）。
//   血圧は上と下を組で送る（下を入れるまで上だけを送らない＝逆転した組は1欄も載らない）。
//   閾値を超えた値は保存して「38.1↑↑ 危険」と出し、〔＋再測定〕を出す。
// 保存の経路は既存の saveVitalEdits（0011 apply_cell_edits）そのまま。種類は既存の 'observation'（経過観察）、冪等キーを
//   'dc:<日>:<利用者id>:<回>' にしてデイの測定と見分ける（daycare.ts）。2台で同じ人を測ると同じキーの行に合流し、
//   後着は「他の端末が先に記録しました」になる（反証レビュー 中10）。〔いまの値にする〕〔あなたの値で直す〕で選ぶ。
// 前回値: その方の直近の測定（種類を問わない・14日以内・その日のデイの測定を除く）。
// 〔未測定〕（2026-11-10 親の決定・0062）: テンキーの〔未測定〕は、値の無い欄に印（daycare_vital_unmeasured）を付けて次の欄へ。
//   印のある欄は入力済みに数え、「未測定」の字で出す（空の枠の注意の地は付けない）。印のある欄でもう一度押すと印を外す（欄は進まない）。
//   値を入れて保存できたら、その欄の印を外す（外せなくても値は止めない＝値のある欄の印は表示で無視する）。送信待ちには積まない
//   （通信できない時は理由を行の下に出し、欄は空のまま）。付けた時・外した時は〔元に戻す〕の知らせ（昼食と同じ部品）。
//
// 規律: 取得・保存は db.ts の関数のみ／入力解禁は input_enabled_daycare（＋既存のバイタルの旗 native_input_enabled が
//   saveVitalEdits の入口で効く）／氏名・値を localStorage・console に出さない（保存するのは絞り込みの既知値だけ）／
//   色だけに頼らない（記号＋言葉）／押す所は 44px 以上・テンキーは 56px

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  DbError,
  FORBIDDEN_REASON,
  OUTDATED_REASON,
  clearDaycareVitalUnmeasured,
  discardPendingRow,
  fetchAllResidents,
  fetchDaycareAttendance,
  fetchDaycareDay,
  fetchDaycarePlan,
  fetchDaycareVitalUnmeasured,
  fetchDaycareVitals,
  fetchRecentVitals,
  fetchResidentTargets,
  getKindInputGate,
  isQueuePersisted,
  isSelfWrite,
  kindBlockedMessage,
  markDaycareVitalUnmeasured,
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
import { DaycareBlankTag, DaycareRowBlankMark, DaycareUnfilledCount } from '../components/DaycareUnfilledCount'
import { ConfirmDialog, ErrorBlock, LoadingBlock } from '../components/ui'
import { registerUnsaved } from '../lib/leaveGuard'
import { useTableFit } from '../lib/useTableFit'
import { DaycareNav } from './DaycarePage'
import {
  DAYCARE_VITAL_FIELDS,
  DAYCARE_VITAL_HEAD,
  DAYCARE_VITAL_LABEL,
  DAYCARE_VITAL_UNIT,
  DC_BULK_VITAL_ORDER,
  DC_VITALS_FILTERS,
  dcVitalSlotMark,
  LEVEL_WORD,
  bpPairError,
  buildDaycareBoard,
  daycareBulkRows,
  daycareVitalKey,
  editsHeldInQueue,
  firstAbnormalField,
  keypadAppend,
  keypadComplete,
  keypadValue,
  nextBulkVitalField,
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
import {
  DAYCARE_BLANK_CELL_CLS,
  DAYCARE_CATEGORY_CLS,
  applyUnmeasuredOps,
  bulkBlankSummary,
  daycareCameShort,
  daycareCountSeq,
  daycareRowTone,
  daycareVitalSlotsWithPending,
  mergeSaveMarks,
  showsUnmeasured,
  unmeasuredFieldsOf,
  unmeasuredRowOf,
  unmeasuredSeqsOf,
  unmeasuredSlotSeqs,
  vitalBlankFields,
  vitalShownValue,
  vitalsMealsBlankFields,
} from '../lib/daycareProgress'
import type { DaycareVitalUnmeasured, UnmeasuredOp } from '../lib/daycareProgress'
import { personPath, readPersonDay } from '../lib/daycarePerson'
import { vitalsMealsPath } from '../lib/daycareRoutes'
import { useDaycareLunchColumns } from './DaycareLunchColumns'
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
/** 〔未測定〕を付けられなかった・外せなかった時（db.ts の文が無い時の控え） */
const MSG_UM_FAILED = '〔未測定〕を記録できませんでした。通信状態を確認して、もう一度押してください。'
/** 〔未測定〕の印を読めなかった時（2026-11-10 反証 軽3。前に読んだ印か、印なしで出している） */
const MSG_UM_UNREAD: Record<'prev' | 'none', string> = {
  prev: '〔未測定〕の記録を読み込めませんでした。前に読んだ記録で表示しています。通信状態を確認して、〔最新に更新〕を押してください。',
  none: '〔未測定〕の記録を読み込めませんでした。〔未測定〕は無いものとして表示・数えています。通信状態を確認して、〔最新に更新〕を押してください。',
}
/** 送っている最中の欄で〔未測定〕を押した時（2026-11-10 反証 軽5。欄は進めない） */
const MSG_UM_BUSY = '〔未測定〕を送信中です。終わるまでお待ちください。'
/** 昼食と水分だけ読めなかった時（2026-11-09 計画B3 の反証 軽3: 表全体は止めず、昼食の列だけ止める） */
const MSG_LUNCH_UNREAD = '昼食と水分を読み込めませんでした。通信状態を確認して、〔最新に更新〕を押してください（バイタルはこのまま入れられます）。'
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
  /** その日の〔未測定〕の印（2026-11-10・0062。読めない時は前に読んだ同じ日の印・無ければ空＝印なしで数える） */
  unmeasured: DaycareVitalUnmeasured[]
  /** 印を読めなかった（2026-11-10 反証 軽3）: 'prev'＝前に読んだ同じ日の印で出している・'none'＝印なしで出している・null＝読めた */
  unmeasuredUnread: 'prev' | 'none' | null
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

/**
 * 入れている（テンキーで押している）欄の見た目（2026-11-09 計画B2 の反証 重1）: 白い地＋primary の太い実線＋外側に primary の線 2px。
 * 空の枠（注意の地＋太い点線）と地の色・線の形・線の色の3つで見分ける。外側の線は outline（フォーカスの輪＝box-shadow と重ならない）
 */
const ACTIVE_CELL_CLS = 'border-2 border-primary bg-surface outline outline-2 outline-primary'

function levelTone(lv: Level): string {
  if (lv === 'danger-high' || lv === 'danger-low') return 'border-2 border-danger bg-danger-bg'
  if (lv !== null) return 'border-2 border-warn bg-warn-bg'
  return 'border border-border-strong bg-surface'
}

export interface DaycareVitalsMealsPageProps {
  staff?: Staff[] | null
  actorId?: number | null
}

export function DaycareVitalsMealsPage({ staff = undefined, actorId = null }: DaycareVitalsMealsPageProps = {}) {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const [today, setToday] = useState(todayIso())
  // 業務日は URL の ?day=（2026-11-09 計画B3: それまでの食事一括と同じ。形が違う・未来の日は今日）
  const day = readPersonDay(search.get('day'), today)
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
  /**
   * この端末で付けた・外した〔未測定〕の印（印の在りか → 操作。2026-11-10）。読み込みの始まりより後の操作は読んだ印に重ねる
   * （行き違った古い読み込みで、付けた印を消さない・外した印を戻さない）。読み込みの始まりより前の操作は、その読み込みに載っているので外す
   */
  const umOpsRef = useRef(new Map<string, UnmeasuredOp>())
  /** 送っている最中の〔未測定〕（測定のキー|欄）。同じ欄を2回続けて送らない。umBusy は描画用の写し（テンキーの案内に「送信中」） */
  const umBusyRef = useRef(new Set<string>())
  const [umBusy, setUmBusy] = useState<ReadonlySet<string>>(new Set())
  /** 〔未測定〕を付けられなかった・外せなかった理由（測定のキー|欄 → 文。行の下に出す。値を保存できた欄の文は消す＝反証 軽4） */
  const [umNotes, setUmNotes] = useState<Map<string, string>>(new Map())
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
    const startedAt = Date.now()
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
      // 〔未測定〕の印（2026-11-10・0062）も同じ回で並べて読む（1本）。読めない時（通信・表が無い）は表を止めず、前に読んだ同じ日の印
      // （無ければ印なし＝空の欄として数える安全側）
      const [plan, attendance, dv, um] = await Promise.all([
        usable ? Promise.resolve(null) : fetchDaycarePlan(target),
        missing ? Promise.resolve([] as DaycareAttendance[]) : fetchDaycareAttendance(target),
        fetchDaycareVitals(target),
        fetchDaycareVitalUnmeasured(target)
          .then((r) => r.rows)
          .catch((): DaycareVitalUnmeasured[] | null => null),
      ])
      const planRows = usable && snapshot !== null ? snapshot.plan_rows : (plan?.rows ?? [])
      const ids = new Set<number>()
      for (const r of planRows) if (r.resident_id !== null) ids.add(r.resident_id)
      for (const a of attendance) ids.add(a.resident_id)
      const recent = await fetchRecentVitals([...ids], addDays(target, -14), target).catch(() => [] as KeyedVital[])
      if (gen !== genRef.current || target !== dayRef.current) return
      const umPrev = dataRef.current !== null && dataRef.current.day === target ? dataRef.current.unmeasured : null
      const umRead = um ?? umPrev ?? []
      const unmeasured = applyUnmeasuredOps(umRead, umOpsRef.current.values(), startedAt)
      // 読んだ印に載っている操作（読み込みの始まりより前）は外す（読めなかった時は残す＝次の読み込みでも重ねる）
      if (um !== null) for (const [k, o] of umOpsRef.current) if (o.at < startedAt) umOpsRef.current.delete(k)
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
        unmeasured,
        unmeasuredUnread: um !== null ? null : umPrev !== null ? 'prev' : 'none',
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
    setUmNotes(new Map())
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
  /**
   * 昼食と水分の列の読み直し（2026-11-09 計画B3 の反証 軽4: 変更の購読はこの画面の1組だけにし、食事・水分の変更と送信待ちが送れて
   * 減った時に、ここから昼食の列も読み直す。それまでの食事一括が持っていた購読と同じ契機）。中身は昼食のフックの reload
   */
  const lunchReloadRef = useRef<() => void>(() => {})
  useEffect(() => {
    const onChange = (table: string, info?: { event: string; row: Record<string, unknown> | null }) => {
      if (info?.row && isSelfWrite(table, info.row)) return
      scheduleReload()
    }
    const offA = subscribeChanges((table, info) => {
      if (table === 'vitals') onChange(table, info)
      // 水分の合計は1人の画面・他の端末で足した分も含むので、水分の変更でも読み直す（2026-10-28・それまでの食事一括と同じ）
      else if (table === 'meals' || table === 'fluid_intake') {
        if (info?.row && isSelfWrite(table, info.row)) return
        lunchReloadRef.current()
      }
    })
    // 写し・出欠の変更はこの画面を読み直す（昼食の列は、その結果＝materials を受け取る）
    const offB = subscribeDaycareChanges(onChange)
    let last = queuePending()
    const offQ = queueSubscribe((n) => {
      setQueueTick((x) => x + 1)
      if (n < last) {
        scheduleReload()
        lunchReloadRef.current()
      }
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
  /** 日付の切り替え（URL の ?day= を置き換える。2026-11-09 計画B3。入れた値の片づけは押した所の afterRelease が先にする） */
  const goDay = (d: string) => navigate(vitalsMealsPath(d, today), { replace: true })

  // 昼食と水分の列（それまでの食事一括の処理のまま＝DaycareLunchColumns.tsx。業務日・入力解禁・名簿・〔最新に更新〕はこの画面のもの）。
  // その日の写し・予定・出欠（materials）と送信待ちの増減（queueTick）もこの画面が読んだものを渡す（同じ物を2回読まない＝反証 軽4）
  const lunch = useDaycareLunchColumns({ day, today, actorId, residents, gate, reloadKey, materials: data, queueTick })
  lunchReloadRef.current = lunch.reload

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
      // 2026-11-09 計画B: 今日の画面の印と同じ純関数（daycareProgress.ts の daycareVitalSlotsWithPending。中身は前と同じ）
      // 2026-11-10 反証 中1: 〔未測定〕の印だけがある回（〔＋再測定〕の回に印だけを残した時など）も行に出す（読み直しで行が消えて、
      // 次の〔＋再測定〕に前の「未測定」が出ないように）。ただし取り消した測定の行のキーの回は出さない（そのキーには値を入れられないため）
      const markSeqs = unmeasuredSlotSeqs(
        data.unmeasured,
        residentId,
        data.day,
        data.live.map((v) => v.client_key),
        data.keys,
      )
      return daycareVitalSlotsWithPending(
        data.live,
        data.keys,
        residentId,
        data.day,
        [...(extraSeqs.get(residentId) ?? []), ...markSeqs],
        (key) => pendingRow('vitals', { routine: false, clientKey: key, residentId, day: data.day, kind: 'observation' }) !== null,
      )
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
    // 送信待ち → サーバーの値（2026-11-09 計画B: 今日の画面の印と同じ純関数 vitalShownValue。中身は前と同じ）
    return vitalShownValue(pendingRow('vitals', targetOf(slot)), slot.vital, f)
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
      // 2026-11-10 未測定: 値を保存できた欄の〔未測定〕の印を外す（外せなくても値の保存は止めない＝値のある欄の印は表示で無視する）
      clearUnmeasuredOfSaved(slot, edits)
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

  // ── 〔未測定〕の印（2026-11-10 親の決定・0062）。印は応答が返ってから表示に入れる（欄送りはすぐ）。送信待ちには積まない ──
  /** その回のその欄の印（いちばん新しい読み込みの印。日は測定のキーから取る） */
  const umRowOf = (slot: DaycareVitalSlot, f: DaycareVitalField): DaycareVitalUnmeasured | null => {
    const k = parseDaycareVitalKey(slot.key)
    const cur = dataRef.current
    if (k === null || cur === null || cur.day !== k.day) return null
    return unmeasuredRowOf(cur.unmeasured, k.residentId, k.day, k.seq, f)
  }
  /** 印の知らせ・送信中の控えの鍵（測定のキー|欄） */
  const umKey = (slot: DaycareVitalSlot, f: DaycareVitalField) => `${slot.key}|${f}`
  const setUmBusyOf = (key: string, on: boolean) => {
    if (on) umBusyRef.current.add(key)
    else umBusyRef.current.delete(key)
    setUmBusy(new Set(umBusyRef.current))
  }
  const setUmNote = (key: string, text: string | null) =>
    setUmNotes((prev) => {
      if (text === null && !prev.has(key)) return prev
      const next = new Map(prev)
      if (text === null) next.delete(key)
      else next.set(key, text)
      return next
    })
  /** 付けた・外した印を表示に入れ、読み込みと行き違っても消さないよう控える */
  const applyUm = (op: Omit<UnmeasuredOp, 'at'>) => {
    const full: UnmeasuredOp = { ...op, at: Date.now() }
    umOpsRef.current.set(`${op.day}:${op.residentId}:${op.seq}:${op.field}`, full)
    setData((prev) => (prev === null || prev.day !== op.day ? prev : { ...prev, unmeasured: applyUnmeasuredOps(prev.unmeasured, [full], 0) }))
  }
  /**
   * その欄に今の値があるか（valueOf と同じ順＝端末の値 → 送信待ち → サーバーの値。いちばん新しい控えから引く）。
   * 〔元に戻す〕で後から付け直す時に、その間に値を入れた欄へ見えない印を作らない
   */
  const hasValueNow = (slot: DaycareVitalSlot, f: DaycareVitalField): boolean => {
    const d = draftsRef.current.get(slot.key)
    if (d !== undefined && f in d) return typeof d[f] === 'number'
    const k = parseDaycareVitalKey(slot.key)
    const cur = dataRef.current
    const vital = k !== null && cur !== null && cur.day === k.day ? (cur.live.find((v) => v.client_key === slot.key) ?? null) : null
    return vitalShownValue(pendingRow('vitals', targetOf(slot)), vital, f).v !== null
  }
  /** 印を付ける（undoable＝〔元に戻す〕の知らせを出す。〔元に戻す〕から呼ぶ時は出さない）。値のある欄には付けない（値が優先） */
  const markUnmeasured = async (slot: DaycareVitalSlot, field: DaycareVitalField, undoable: boolean) => {
    const k = parseDaycareVitalKey(slot.key)
    const busy = umKey(slot, field)
    if (k === null || umBusyRef.current.has(busy) || hasValueNow(slot, field)) return
    if (actorId === null) {
      setUmNote(busy, `${DAYCARE_VITAL_LABEL[field]}: ${MSG_NO_RECORDER}`)
      return
    }
    setUmBusyOf(busy, true)
    setUmNote(busy, null)
    try {
      const row = await markDaycareVitalUnmeasured({ residentId: k.residentId, day: k.day, seq: k.seq, field, recordedBy: actorId })
      applyUm({ residentId: k.residentId, day: k.day, seq: k.seq, field, row })
      if (undoable && k.day === dayRef.current) {
        lunch.show(`${nameOf(k.residentId)}さんの${DAYCARE_VITAL_LABEL[field]}を未測定にしました`, () => void clearUnmeasured(slot, field, row, false))
      }
    } catch (e) {
      setUmNote(busy, `${DAYCARE_VITAL_LABEL[field]}: ${e instanceof DbError ? e.message : MSG_UM_FAILED}`)
    } finally {
      setUmBusyOf(busy, false)
    }
  }
  /** 印を外す（quiet＝値を保存した後の片づけ。失敗を出さない） */
  const clearUnmeasured = async (slot: DaycareVitalSlot, field: DaycareVitalField, row: DaycareVitalUnmeasured, undoable: boolean, quiet = false) => {
    const busy = umKey(slot, field)
    if (umBusyRef.current.has(busy)) return
    setUmBusyOf(busy, true)
    if (!quiet) setUmNote(busy, null)
    try {
      await clearDaycareVitalUnmeasured(row, { editedBy: actorId })
      applyUm({ residentId: row.resident_id, day: row.day, seq: row.seq, field, row: null })
      if (undoable && row.day === dayRef.current) {
        lunch.show(`${nameOf(row.resident_id)}さんの${DAYCARE_VITAL_LABEL[field]}の未測定を取り消しました`, () => void markUnmeasured(slot, field, false))
      }
    } catch (e) {
      if (!quiet) setUmNote(busy, `${DAYCARE_VITAL_LABEL[field]}: ${e instanceof DbError ? e.message : MSG_UM_FAILED}`)
    } finally {
      setUmBusyOf(busy, false)
    }
  }
  /** 値を保存できた欄の印を外す（値が優先・失敗は出さない）。その欄の〔未測定〕の失敗の知らせも消す（反証 軽4） */
  const clearUnmeasuredOfSaved = (slot: DaycareVitalSlot, edits: Partial<Record<DaycareVitalField, number | null>>) => {
    for (const [f, v] of Object.entries(edits)) {
      if (typeof v !== 'number') continue
      setUmNote(umKey(slot, f as DaycareVitalField), null)
      const row = umRowOf(slot, f as DaycareVitalField)
      if (row !== null) void clearUnmeasured(slot, f as DaycareVitalField, row, false, true)
    }
  }
  /**
   * テンキーの〔未測定〕: 値の無い欄は印を付けて次の欄へ（false＝今の欄送り）。印のある欄は印を外してその欄に残る（true）。
   * 値のある欄は今までどおり何も記録せずに次の欄へ（false・いまの値は消さない）
   */
  const toggleUnmeasured = (cur: Active, slot: DaycareVitalSlot): boolean => {
    if (valueOf(slot, cur.field).v !== null) return false
    // 送っている最中の欄は、黙って捨てて進めない（その欄に残り、テンキーの案内に「送信中」＝反証 軽5）
    if (umBusyRef.current.has(umKey(slot, cur.field))) {
      setBuf('')
      setKpError(null)
      return true
    }
    const row = umRowOf(slot, cur.field)
    if (row === null) {
      void markUnmeasured(slot, cur.field, true)
      return false
    }
    void clearUnmeasured(slot, cur.field, row, true)
    setBuf('')
    setKpError(null)
    return true
  }

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
      const where = 'サーバーに受け付けられませんでした。値はこの端末の送信待ちに残っています（この日のデイのバイタル・食事の画面のその方の行で確かめ、入れ直してください）。'
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
  // 2026-11-10 確認の反証 軽2: 入れている欄の行が無くなったら（印だけの再測定の行で最後の印を取り消した・絞り込みで外れた など）テンキーを
  // 閉じる（テンキーは消えるのに選んでいる欄が残り、物理キーを横取りしたままにしない）。別の日を読んでいる間は見ない（日の切り替えで閉じる）
  useEffect(() => {
    if (active === null || data === null || data.day !== day) return
    if (!flatSlots.some((s) => s.key === active.key)) closeKeypad()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, data, day, flatSlots])

  /**
   * 次の欄（列の並び＝DC_BULK_VITAL_ORDER の次・2026-11-09 計画B2）。KT の次は、テンキーを閉じて同じ方の主食の選択肢へフォーカスを移す
   * （2026-11-09 計画B3。それまでは次の方の血圧の上。再測定の回の KT の後も、その方の主食＝1回目の行）。主食の欄が無い時（「全員」で出した
   * 休み・入院中の方）は閉じるだけ
   */
  const advance = (cur: Active) => {
    const nf = nextBulkVitalField(cur.field)
    if (nf !== null) {
      setActive({ ...cur, field: nf })
    } else {
      flushHeldSys(cur, null)
      setActive(null)
      focusLunchMain(cur.residentId)
    }
    setBuf('')
    setKpError(null)
  }
  /** その方の主食の選択肢へフォーカスを移す（テンキーが閉じて表の枠が伸びた後に。見えない時は枠の中で見える所へ送る） */
  const focusLunchMain = (residentId: number) => {
    window.requestAnimationFrame(() => {
      const el = tableBox?.querySelector<HTMLElement>(`[data-dc-lunch-main="${residentId}"]`) ?? null
      if (el === null) return
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }

  /** 欄を確定する（範囲外・上下逆は止める＝保存しない・欄は進まない） */
  const commit = (cur: Active, text: string, skip: boolean) => {
    const slot = flatSlots.find((s) => s.key === cur.key)
    if (slot === undefined) return
    // 「未測定」・空のまま次へ: 値は記録しない（いまの値は消さない）。〔未測定〕は値の無い欄に印を付ける・印を外す（2026-11-10）
    if (skip || text === '') {
      if (skip && toggleUnmeasured(cur, slot)) return
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
      // 主食・副食の選択肢（SELECT）で押したキーも横取りしない（2026-11-09 計画B3: 同じ表に昼食の選択肢と水分の欄がある）
      if (t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
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
    // 2026-11-10 反証 中1: 〔未測定〕の印のある回も使わない（前の回の「未測定」を新しい回に出さない）
    const marked = unmeasuredSeqsOf(data.unmeasured, row.residentId, data.day).map((s) => daycareVitalKey(data.day, row.residentId, s))
    let seq = nextDaycareSeq([...data.keys, ...local, ...marked, ...slotsOf(row.residentId).map((s) => s.key)], data.day, row.residentId)
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
    // 基準を外れた欄を列の並び（DC_BULK_VITAL_ORDER）で探す。無ければ血圧の上から（2026-11-09 計画B2）
    setActive({
      residentId: row.residentId,
      seq,
      key: daycareVitalKey(data.day, row.residentId, seq),
      field: firstAbnormalField(vals, targets.get(row.residentId), limits.lookup(row.residentId, data.day), DC_BULK_VITAL_ORDER),
    })
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
  // テンキーを開いている間の〔元に戻す〕の知らせの位置＝アプリの見出しの下（上に貼り付く sticky・fixed の header の下端を測る）。
  // 2026-11-09 計画B3 の反証 中2: 下の位置（fixed bottom-20 z-50）ではテンキー（z-40）のキー・〔閉じる〕の真上に重なった。
  // 確認の反証 軽1: テンキーの上に移すと、テンキーのすぐ上に送った入れている行に重なったので、画面の上の方へ出す。閉じたら元の位置
  const kpOpen = active !== null
  const [toastTop, setToastTop] = useState(0)
  useEffect(() => {
    if (!kpOpen) return
    const check = () => {
      let h = 0
      for (const el of document.querySelectorAll<HTMLElement>('header')) {
        const cs = window.getComputedStyle(el)
        if (cs.display === 'none' || (cs.position !== 'sticky' && cs.position !== 'fixed')) continue
        h = Math.max(h, el.getBoundingClientRect().bottom)
      }
      setToastTop(Math.max(0, Math.ceil(h)))
    }
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [kpOpen])
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
    // 物理キーボードで欄を送った時は、フォーカスも移った先の欄へ移す（フォーカスの輪が前の欄に残らない＝確認の反証 軽4）。
    // フォーカスが表の中の欄（data-dc-cell）にある時だけ。指で押した時（フォーカスが欄に無い・押した欄そのもの）とテンキーのボタンからの送りは変えない
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused !== cell && focused.hasAttribute('data-dc-cell') && tableBox.contains(focused)) cell.focus({ preventScroll: true })
  }, [active, tableBox, kpBox, kpHeight])

  // ── 描画 ──
  // 未入力の数（2026-11-09 計画B2・一括の4画面で同じ数え方）。数える方は「表示する方」によらず予定の方（daycareBulkRows＝休み・入院中を
  // 除く・予定外で来た方を含む）で、到着の有無を問わない。1人5欄＝その方の最初の回の 上・下・P・SpO2・KT（再測定の回は数えない）。
  // 値は画面に出している値（端末の値・送信待ち・サーバーの値）。空の枠の見た目と行の印も、ここで数えた方の最初の回だけに出す。
  // 2026-11-09 計画B3: 1人7欄＝バイタルの5欄＋昼食の主食・副食（拒食は入力済み・水分は数えない＝食事一括と同じ lunchBlankFields）。
  // 上の数（n名・m欄）を出すのは、バイタルと昼食の両方をその日で読めた時だけ。昼食だけ読めない時（反証 軽3）は表を止めず、
  // 行の印と空の枠はバイタルの5欄で出し、上の数は出さない（昼食の列は「読み込めません」）
  const lunchReady = lunch.data !== null && lunch.data.day === day
  const lunchFailed = !lunchReady && lunch.error !== null
  const countRows = board === null || data === null || data.day !== day ? [] : daycareBulkRows(board.rows)
  // 2026-11-10 反証 軽2: 数える回は今日の画面と同じ純関数（daycareCountSeq＝測定の行のある一番小さい回・無ければ印の一番小さい回）。
  // 確認の反証 軽1: 数える回は行に出している回から選ぶ（印の回が行に無い時は最初の行の回＝空の枠を光らせる回と数える回をそろえる）。
  // countSeqOfRow＝その方の数える回（空の枠を光らせる回）
  const countSeqOfRow = new Map<number, number | null>()
  const blankOf = new Map<number, number>(
    countRows.map((r) => {
      const slots = slotsOf(r.residentId)
      const cs = daycareCountSeq(
        slots.filter((s) => s.vital !== null || pendingRow('vitals', targetOf(s)) !== null).map((s) => s.seq),
        unmeasuredSeqsOf(data?.unmeasured, r.residentId, day),
        slots.map((s) => s.seq),
      )
      const first = slots.find((s) => s.seq === cs) ?? slots[0]
      countSeqOfRow.set(r.residentId, first?.seq ?? null)
      const vals: Partial<Record<DaycareVitalField, number | null>> = {}
      if (first !== undefined) for (const f of DAYCARE_VITAL_FIELDS) vals[f] = valueOf(first, f).v
      // 2026-11-10 未測定: 数える回の〔未測定〕の印のある欄は入力済み（昼食の拒食と同じ）
      const vitalBlank = vitalBlankFields(first === undefined ? null : vals, unmeasuredFieldsOf(data?.unmeasured, r.residentId, day, cs ?? first?.seq ?? 1))
      return [r.residentId, lunchReady ? (vitalsMealsBlankFields(vitalBlank, lunch.blankOf(r.residentId)) ?? 0) : vitalBlank]
    }),
  )
  const unfilled = bulkBlankSummary([...blankOf.values()])
  // 上の段は詰める（日付と「表示する方」を1段に・余白と文字を小さく＝2026-11-09 代表者の指示「一括入力の画面で、もっと多くの行が出るように」）
  const header = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <DaycareNav current="vitalsMeals" handoff={() => writeDaycareHandoffFor({ rows: board?.rows ?? null, residents, boardDay: data?.day ?? null, today })} />
        <RecorderBar actorId={actorId} staff={staff ?? null} />
      </div>
      {/* 段の間は 12px（2026-11-09 反証 軽1: 未入力の数を同じ段に入れるため 16px から詰めた。押す所どうしは 8px 以上のまま） */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-gap" role="group" aria-label="日付">
          <button
            type="button"
            onClick={() => afterRelease(() => goDay(addDays(day, -1)))}
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
            onClick={() => afterRelease(() => goDay(addDays(day, 1) > today ? day : addDays(day, 1)))}
            disabled={day >= today || releasing}
            className="min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-lg text-ink disabled:text-ink3"
            aria-label="次の日へ"
          >
            <span aria-hidden="true">›</span>
          </button>
          {day !== today ? (
            <button
              type="button"
              onClick={() => afterRelease(() => goDay(today))}
              disabled={releasing}
              className="min-h-tap rounded border border-primary px-3 text-sm font-bold text-primary"
            >
              今日を開く
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => afterRelease(() => setReloadKey((n) => n + 1))}
            disabled={releasing}
            className="min-h-tap rounded border border-border-strong bg-surface px-3 text-sm text-ink"
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
                  ? 'min-h-tap rounded border border-primary bg-primary px-3 text-sm font-bold text-primary-ink'
                  : 'min-h-tap rounded border border-border-strong bg-surface px-3 text-sm text-ink'
              }
            >
              {filter === f ? <span aria-hidden="true">✓ </span> : null}
              {FILTER_LABEL[f]}
            </button>
          ))}
        </div>
        {/* 未入力の数は日付と「表示する方」の段の右（新しい段を足さない）。1024px 以上は、残りの幅が 16rem 以上あれば同じ段に置く
            （反証 軽1・iPad 横 1180px で残りは約 340px）。入らない時だけ次の段へ回る。2026-11-09 計画B2: 「未到着 n名」は出さない
            （到着を問わず数えるため）ので、1024px 未満で隠す指定は外した */}
        {/* 2026-11-09 計画B3: それまでの食事一括の「予定の方 n人」も同じ所に並べる（入らない時は折り返す） */}
        {countRows.length > 0 ? (
          <div className="flex min-w-0 grow flex-wrap items-baseline gap-x-4 gap-y-1 lg:basis-64">
            {lunchReady ? <DaycareUnfilledCount counts={unfilled} /> : null}
            <p className="text-sm text-ink2">
              予定の方 <span className="font-num font-bold text-ink">{countRows.length}</span>人
            </p>
          </div>
        ) : null}
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
      {/* 2026-11-10 反証 軽6: 凡例の記号の4語は元のまま、「—＝記録なし（数えない回）」「未測定＝測らなかった記録」「未＝未入力」を足した。
          凡例だけで 1296px（15px・ヘッドレス Chrome）になり、iPad 横 1180px（枠 1052px）で今の2段（凡例・食事の説明）に収まらないので、
          食事の説明（2026-11-09 計画B3 のそれまでの食事一括の説明）を短くして同じ段落の続きに置いた（2段・2段目の余り約 54px） */}
      <p className="text-sm leading-tight text-ink2">
        記号: ↑↑ 危険（高い）・↑ 注意（高い）・↓ 注意（低い）・↓↓ 危険（低い）・—＝記録なし（数えない回）・未測定＝測らなかった記録・未＝未入力。範囲外と血圧の上下逆は保存しません。{' '}
        <span>主食・副食は選ぶとすぐ保存します。水分は数を入れて改行キーか〔＋〕で足します（1人の画面と同じ記録）。</span>
      </p>
      {gate !== null && !(gate.observed && gate.value === true) ? (
        <p role="status" className="rounded-lg border border-warn bg-warn-bg px-3 py-1.5 text-base text-ink">
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

  // 前の日の行を出したまま新しい日を読む間は、行を出さない（押せる古い行を残さない＝3巡目 中1）。
  // 2026-11-09 計画B3: 昼食と水分（それまでの食事一括の読み込み）も同じ。両方をその日で読めてから表を出す
  const lunchLoading = (lunch.loading && lunch.data === null) || (lunch.data !== null && lunch.data.day !== day && lunch.error === null)
  if ((loading && data === null) || (data !== null && data.day !== day && error === null) || lunchLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-2">
        {header}
        <LoadingBlock label="デイのバイタルと昼食を読み込んでいます…" />
      </div>
    )
  }
  if (error !== null && (data === null || data.day !== day)) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-2">
        {header}
        <ErrorBlock message={error} onRetry={() => setReloadKey((n) => n + 1)} />
      </div>
    )
  }
  if (data === null) return null

  const activeSlot = active === null ? null : (flatSlots.find((s) => s.key === active.key) ?? null)
  /** 入れている欄に〔未測定〕の印がある（値の無い欄だけ。値があれば印は無視する） */
  const activeMarked =
    active !== null && activeSlot !== null && showsUnmeasured(valueOf(activeSlot, active.field).v, umRowOf(activeSlot, active.field) !== null)
  const prevOf = (id: number) => previousVitalOf(data.recent, id, data.day)

  const keypad =
    active !== null && activeSlot !== null ? (
      // 今日の画面の改善 2回目（2026-10-24）: どの幅でも画面の下に出す（定時バイタルと同じ置き場所と並び）。
      // 押した時の動き（桁がそろうと次へ・KT の次はテンキーを閉じて同じ方の主食へ＝2026-11-09 計画B3・血圧の上は下と組で送る）と文言は変えない
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
                  // 2026-11-10 反証 軽5: 〔未測定〕を送っている最中の欄は「送信中」（その欄に残る）。確認の反証 軽3: 送信中はこの文だけの1行
                  // （前回・「365」の案内を並べると体温の欄で2行になり、テンキーと表の枠が動くため）
                  if (umBusy.has(umKey(activeSlot, active.field))) return MSG_UM_BUSY
                  const parts: string[] = []
                  if (cur !== null) parts.push(`いまの値 ${fmtVal(active.field, cur)}`)
                  else if (activeMarked) parts.push('未測定と記録済み')
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
              {/* 2026-11-10 未測定: 値の無い欄は印を付けて次の欄へ・印のある欄は押すと取り消し（押した状態＝✓ と太字と枠の色） */}
              <button
                type="button"
                onClick={() => press('skip')}
                aria-pressed={activeMarked}
                aria-label={activeMarked ? '未測定（記録済み・押すと取り消します）' : '未測定（測らなかったと記録して次の欄へ）'}
                className={
                  activeMarked
                    ? 'min-h-tap rounded border-2 border-primary bg-surface2 px-3 text-base font-bold text-ink'
                    : 'min-h-tap rounded border border-border-strong bg-surface2 px-3 text-base text-ink'
                }
              >
                {activeMarked ? <span aria-hidden="true">✓ </span> : null}未測定
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
    <div className="mx-auto w-full max-w-6xl space-y-2">
      {header}
      {limits.failed ? <VitalLimitsFailedNote className="" onRetry={() => void limits.refresh()} /> : null}
      <div className="min-w-0 space-y-2">
        {shownRows.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="text-base text-ink">
              {filter === 'all' ? 'この日のデイの予定・記録はまだありません。' : 'この日の予定の方がいません（休み・入院中の方は「全員」で出せます）。'}
            </p>
            {/* 2026-11-09 計画B3 の反証 軽7: それまでの食事一括の案内の文に戻した（「今日（到着・休み）」は狭い画面では「今日」と出るため） */}
            <p className="mt-2 text-base text-ink2">予定外で来た方は、今日の画面の〔予定にない方を追加〕で足したカードを押し、〔予定外で到着〕を押すと、ここに出ます。</p>
          </div>
        ) : (
          <>
            {lunchFailed ? (
              <div role="alert" className="flex flex-wrap items-center gap-gap rounded-lg border border-warn bg-warn-bg px-3 py-1.5 text-base text-ink">
                <p className="min-w-0 flex-1">
                  <span aria-hidden="true">▲ </span>
                  {MSG_LUNCH_UNREAD}
                </p>
                <button
                  type="button"
                  onClick={() => afterRelease(() => setReloadKey((n) => n + 1))}
                  disabled={releasing}
                  className="min-h-tap rounded border border-border-strong bg-surface px-3 text-sm text-ink"
                >
                  最新に更新
                </button>
              </div>
            ) : null}
            {/* 2026-11-10 反証 軽3: 〔未測定〕の印を読めなかった時（前に読んだ印か、印なしで出している）。表は止めない */}
            {data.unmeasuredUnread !== null ? (
              <div role="status" className="flex flex-wrap items-center gap-gap rounded-lg border border-warn bg-warn-bg px-3 py-1.5 text-base text-ink">
                <p className="min-w-0 flex-1">
                  <span aria-hidden="true">▲ </span>
                  {MSG_UM_UNREAD[data.unmeasuredUnread]}
                </p>
                <button
                  type="button"
                  onClick={() => afterRelease(() => setReloadKey((n) => n + 1))}
                  disabled={releasing}
                  className="min-h-tap rounded border border-border-strong bg-surface px-3 text-sm text-ink"
                >
                  最新に更新
                </button>
              </div>
            ) : null}
            {/* 表が画面より広い時だけ出す手がかり（広い画面では出ない＝定時バイタルと同じ） */}
            {tableScrolls ? (
              <p className="text-sm text-ink2">
                <span aria-hidden="true">⇆ </span>
                表は横にスクロールできます（氏名の列は左に残ります）
              </p>
            ) : null}
            {/* 今日の画面の改善 2回目（2026-10-24）: 定時バイタルと同じ1行1人の表。再測定はその方の行のすぐ下に「↳ 再測定 n」の行で足す。
                2026-11-09 計画B3: 右に昼食と水分の列（主食｜副食｜水分（cc）＝それまでの食事一括の表の列）を足した。
                横スクロールはこの枠の中だけ（ページ全体を広げない）。relative は表の中の読み上げ用の文字の基準をこの枠にするため */}
            <div
              ref={setTableBox}
              role="region"
              aria-label={`${fmtDayLabel(day)}のデイのバイタルと昼食の入力表${tableScrolls ? '（横にスクロールできます）' : ''}`}
              tabIndex={tableScrolls || tableScrollsY ? 0 : undefined}
              className="dc-table-fit relative isolate overflow-auto"
            >
              <table className="w-full min-w-max border-collapse text-base">
                <caption className="sr-only">{fmtDayLabel(day)}のデイのバイタルと昼食の入力表（主食・副食は選ぶとすぐ保存・水分は数を入れて足す）</caption>
                <thead>
                  <tr className="border-b border-border-strong bg-surface2 text-left">
                    {/* 氏名の列は横スクロールしても左に残す（sticky）。背景は見出し行と同じ色 */}
                    <th scope="col" className="sticky left-0 top-0 z-30 bg-surface2 px-2 py-2 text-sm font-bold text-ink2">
                      <span className="dc-vital-name block">氏名</span>
                    </th>
                    {/* 2026-11-09 計画B2（代表者の指示）: 列は 血圧（上 / 下）｜P｜SpO2｜KT。血圧は上と下の2列にまたがる見出し1つ
                        （「上」「下」の見出しは出さない。読み上げは各欄の「血圧の上」「血圧の下」）。
                        2026-11-09 計画B3: 見出しの帯は分類の色（バイタル＝ティール・食事＝イエロー＝tokens.css の --c-cat-*）。氏名と状態の列は
                        今の灰のまま（バイタルと食事の境目が帯の色の切れ目で分かる）。帯の上の文字は text-ink（ライト・ダークとも 10:1 以上） */}
                    <th scope="col" colSpan={2} className={`sticky top-0 z-20 ${DAYCARE_CATEGORY_CLS.vitals.band} px-2 py-2 text-sm font-bold text-ink`}>
                      血圧
                    </th>
                    {DC_BULK_VITAL_ORDER.filter((f) => f !== 'sys_bp' && f !== 'dia_bp').map((f) => (
                      <th key={f} scope="col" className={`sticky top-0 z-20 w-24 ${DAYCARE_CATEGORY_CLS.vitals.band} px-2 py-2 text-sm font-bold text-ink`}>
                        <span aria-hidden="true">{DAYCARE_VITAL_HEAD[f]}</span>
                        <span className="sr-only">{DAYCARE_VITAL_LABEL[f]}</span>
                      </th>
                    ))}
                    {/* 再測定と状態は1つの列に詰めた（2026-11-09 計画B3: iPad 横 1180px で横に送らずに全部の列が入るように。どちらも消さない）。
                        1段目は来た・まだ（短い形）か〔＋再測定〕、2段目は保存の印（1回目の行はバイタルと昼食のうち手当ての要る方＝mergeSaveMarks）。
                        列の幅は中身（〔＋再測定〕・「✓ 保存済み」を折り返さない幅＝約 88px）。2段で欄の 44px に収まる（行の高さ 53px） */}
                    <th scope="col" className="sticky top-0 z-20 bg-surface2 px-1 py-2 text-sm font-bold text-ink2">
                      状態<span className="sr-only">・再測定</span>
                    </th>
                    <th scope="col" className={`sticky top-0 z-20 ${DAYCARE_CATEGORY_CLS.meals.band} px-2 py-2 text-sm font-bold text-ink`}>
                      主食
                    </th>
                    <th scope="col" className={`sticky top-0 z-20 ${DAYCARE_CATEGORY_CLS.meals.band} px-2 py-2 text-sm font-bold text-ink`}>
                      副食
                    </th>
                    <th scope="col" className={`sticky top-0 z-20 ${DAYCARE_CATEGORY_CLS.meals.band} px-2 py-2 text-sm font-bold text-ink`}>
                      水分（cc）
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shownRows.map((row, pi) => {
                    // 行の地は1人ずつ交互（2026-11-09 計画B3・代表者の指示「１名ずつ行のバックの色を少し変えて」）。その方の再測定の行・知らせの行と、
                    // 左に残る氏名の列（sticky）も同じ地にそろえる
                    const rowBg = daycareRowTone(pi)
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
                    // 空の欄の数（数える方だけ・最初の回。「全員」で出した休み・入院中の方は数えないので undefined）
                    const blankCount = blankOf.get(row.residentId)
                    // 昼食と水分の欄を出すのは、それまでの食事一括に出ていた方（予定の方・来た方＝daycareBulkRows）だけ。
                    // 「全員」で出した休み・入院中の方は出さない（2026-11-09 計画B3）。昼食を読めない時は欄の代わりに「読み込めません」（反証 軽3）
                    const inBulk = blankCount !== undefined
                    const lunchHere = inBulk && lunchReady
                    // 来た・まだ（○ 来所前／● 在席／✓ 帰宅。それまでの食事一括の氏名の下の印）。2026-11-09 計画B3 の手直し: 氏名の列に積まず、
                    // 状態の列の1段目に短い形で出す（行の高さを欄の 44px に保つ）。休み・入院中の方（「全員」で出した方）には出さない
                    const cm = daycareCameShort(row)
                    return slots.map((slot, si) => {
                      const st = slotState.get(slot.key)
                      // 空の枠を目立たせるのは、数える方の最初の回だけ（数えた欄と光る欄をそろえる・2026-11-09 計画B2）
                      // 2026-11-10 反証 軽2: 数える回（上の countSeqOfRow・今日の画面と同じ決まり）。ふつうは最初の回
                      const countedSlot = slot.seq === countSeqOfRow.get(row.residentId) && blankCount !== undefined
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
                      const vitalMark = dcVitalSlotMark(shown?.kind, pend?.state ?? null)
                      // 状態の列の印: 1回目の行はバイタルと昼食のうち手当ての要る方（2026-11-09 計画B3）・再測定の行はその回のバイタルだけ
                      const lunchRow = si === 0 && lunchHere
                      const mark = lunchRow ? mergeSaveMarks(vitalMark, lunch.markOf(row.residentId)) : vitalMark
                      // 詳しい文と解き方のボタンは、行の下の1行に出す（送信中は状態の列の印だけ）。保存済みでも送信待ちが動いていれば
                      // （同じ端末の別のタブなど）その文を出す（前の SlotStatus と同じ出し方＝#45 の反証 軽4）
                      const detail = shown?.kind === 'saving' ? false : (shown !== undefined && shown.kind !== 'saved') || pend !== null
                      // 昼食と水分の知らせ（それまでの食事一括の行の下の知らせ）も、1回目の行の下の同じ行に出す
                      const lunchNotes = lunchRow ? lunch.notes(row.residentId) : null
                      // 〔未測定〕を付けられなかった・外せなかった理由（2026-11-10。欄は空のまま）
                      const umNote = DAYCARE_VITAL_FIELDS.flatMap((f) => umNotes.get(umKey(slot, f)) ?? []).join(' ') || null
                      const below = detail || lunchNotes !== null || umNote !== null
                      const time = slot.vital?.measured_at ? slot.vital.measured_at.slice(0, 5) : null
                      // 状態の列の2段目（2026-11-09 計画B3 の確認の反証 中1・軽2）: 急ぐ印（要確認・未送信・送信中）→ 測った時刻（再測定の回が
                      // 無い方の1回目）→ ✓ 保存済み の順に1つ。保存済みは時刻に譲る（時刻が無い時だけ出す）
                      const urgent = mark !== null && mark.tone !== 'ok' ? mark : null
                      const showTime = si === 0 && slots.length === 1 && time !== null
                      const line2 = urgent ?? (showTime ? null : mark)
                      return (
                        <Fragment key={slot.key}>
                          <tr className={`align-middle ${rowBg} ${below || !isLast ? '' : 'border-b border-border'}`}>
                            {/* 氏名の列は横スクロールしても左に残す（sticky）。背景は行と同じ地（下を流れる欄を透かさない） */}
                            <th scope="row" className={`sticky left-0 z-10 ${rowBg} px-2 py-1 text-left font-normal`}>
                              {/* 氏名の列の幅は dc-vital-name で決める（札が長くても列を広げず、中で折り返す＝確認の反証 重） */}
                              <div className="dc-vital-name">
                                {si === 0 ? (
                                  <>
                                    {/* 2026-11-09 計画B3 の手直し（行の高さを欄の 44px に保つ＝活動一括と同じ形）: 氏名は1人の画面へのリンク
                                        （押せる高さ 44px）。2段目は基準の札（施設の基準など）。空の欄がある行の印は札の行の頭（「▲未 施設の基準」。
                                        氏名の横に置くと iPad 縦（氏名の列 112px）で折り返して行が伸びるため＝2026-11-09 計画B2 の反証 中1。
                                        読み上げは「未入力あり」・昼食の主食・副食の空も含む） */}
                                    <Link to={personPath(row.residentId, day, today)} className="flex min-h-tap flex-col justify-center underline-offset-2 hover:underline">
                                      <span className="text-base font-bold leading-tight text-link">
                                        {nameOf(row.residentId)}
                                        <span className="sr-only">さんの1日の記録を開く</span>
                                      </span>
                                      <span className="text-sm leading-tight text-ink2">
                                        {(blankCount ?? 0) > 0 ? <DaycareRowBlankMark lead /> : null}
                                        {basis}
                                      </span>
                                    </Link>
                                    {/* 「1回目（時刻）」は再測定の回がある方だけ（再測定の行の「↳ 再測定 n（時刻）」と見比べるため） */}
                                    {slots.length > 1 ? (
                                      <span className="block text-sm leading-tight text-ink2">1回目{time !== null ? `（${time}）` : ''}</span>
                                    ) : null}
                                  </>
                                ) : (
                                  <span className="block text-sm leading-tight text-ink2">
                                    <span aria-hidden="true">↳ </span>
                                    再測定 {si}
                                    {time !== null ? `（${time}）` : ''}
                                    <span className="sr-only">：{nameOf(row.residentId)}</span>
                                  </span>
                                )}
                              </div>
                            </th>
                            {DC_BULK_VITAL_ORDER.map((f) => {
                              const { v, local } = valueOf(slot, f)
                              const lv = vitalLevel(f, v, target, th)
                              const isActive = active?.key === slot.key && active.field === f
                              const pv = prev[f]
                              const word = lv === null ? '' : LEVEL_WORD[lv]
                              // 〔未測定〕の印のある欄（2026-11-10・値の無い欄だけ＝値が優先）。入力済みなので空の枠にしない
                              const um = showsUnmeasured(v, unmeasuredRowOf(data.unmeasured, row.residentId, data.day, slot.seq, f) !== null)
                              // 入れている欄は空の枠にしない（「未」を出さない＝反証 重1）
                              const blank = countedSlot && v === null && !isActive && !um
                              // 欄の間（2026-11-09 計画B2）: 欄の幅はどれも 88px（列の幅 − 左右の余白）。ほかの欄の間は 8px（4px＋4px）、
                              // 血圧の上と下の間は 14px（6px＋8px・間に「/」）、血圧の下と P の間は 20px（16px＋4px）。
                              // 確認の反証 軽2: 12px では押している欄の外側の線（2px）が「/」に触れたので 14px にした。下の列の左の余白を広げると
                              // 欄の幅 88px を保つ列の幅（114px）が Tailwind の目盛りに無いので、上の列の右の余白を 6px に広げた（上の欄の幅は 88px のまま）
                              const tdCls = f === 'sys_bp' ? 'w-24 py-1 pl-0.5 pr-1.5' : f === 'dia_bp' ? 'relative w-28 py-1 pl-2 pr-4' : 'px-1 py-1'
                              return (
                                <td key={f} className={tdCls}>
                                  {f === 'dia_bp' ? (
                                    // 上の枠と下の枠の間の「/」（読み上げない・押すのを妨げない）。上と下の間 14px のまん中（下の列の左の端から 1px）
                                    <span aria-hidden="true" className="pointer-events-none absolute left-px top-1/2 -translate-x-1/2 -translate-y-1/2 text-lg font-bold text-ink2">
                                      /
                                    </span>
                                  ) : null}
                                  <button
                                    type="button"
                                    onClick={() => openCell(slot, f)}
                                    disabled={!canWrite}
                                    data-dc-cell=""
                                    data-dc-active={isActive ? '' : undefined}
                                    aria-label={`${nameOf(row.residentId)} ${DAYCARE_VITAL_LABEL[f]} ${v === null ? (um ? '未測定' : '未入力') : fmtVal(f, v)}${word ? ` ${word}` : ''}${pv ? `、前回 ${fmtVal(f, pv.value)}` : ''}${local ? '、未送信' : ''}`}
                                    // 欄の高さは押せる下限の 44px（2026-11-09 に 56px から詰めた。行の高さは欄＋上下 4px ずつ＝隣の行の欄と 8px あく）
                                    // 空の枠（数える方の最初の回で値が無い）は注意の地＋太い点線＋「未」（2026-11-09 計画B2）。入れている欄の見た目が先
                                    // （反証 重1: 入れている欄は「未」を出さず、白い地＋primary の実線＝ACTIVE_CELL_CLS）
                                    className={`flex min-h-tap w-full flex-col items-center justify-center rounded px-1 text-center ${
                                      isActive ? ACTIVE_CELL_CLS : blank ? DAYCARE_BLANK_CELL_CLS : levelTone(lv)
                                    } disabled:opacity-100`}
                                  >
                                    {um ? (
                                      // 〔未測定〕の印（2026-11-10）: 「未測定」の字（15px・ink2）。枠は今の細い実線・注意の地なし（levelTone(null)）
                                      <span className="whitespace-nowrap text-sm leading-tight text-ink2">未測定</span>
                                    ) : v === null ? (
                                      // 空の欄だけ前回の値を出す（定時バイタルと同じ・親の回答 4）。入れた値と見分けがつくよう小さく薄く、「前回」を付ける
                                      // （2026-11-09 計画B2: 14px・text-ink3）。空の枠には「未」の字を添える（前回が無い時は「未」だけ）。
                                      // 「未」と「前回…」は横に並べる（文字を大きくしても枠が高くならない＝反証 軽2）。左右の余白（px-1）の分だけ
                                      // 中身を広げる（-mx-1）: 体温の「未 前回36.4」も 88px の枠の線の内側に1行で収め、列の幅を広げない
                                      <span className="-mx-1 flex items-center gap-1 whitespace-nowrap">
                                        {blank ? <DaycareBlankTag /> : null}
                                        {pv || !blank ? (
                                          <span className="font-num text-xs leading-tight text-ink3" aria-hidden="true">
                                            {pv ? `前回${fmtVal(f, pv.value)}` : '—'}
                                          </span>
                                        ) : null}
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
                              {/* 1段目＝来た・まだ（いつも。〔＋再測定〕を出す行はボタン）・2段目＝急ぐ印か測った時刻か保存済み（line2）。
                                  どの行も2つまで＝ふつうの行 53px・〔＋再測定〕の行 76px（2026-11-09 計画B3 の確認の反証 中1・軽2） */}
                              <div className="flex flex-col items-stretch gap-1">
                                {abnormal && isLast ? (
                                  <button
                                    type="button"
                                    onClick={() => addRecheck(row, slot)}
                                    disabled={!canWrite}
                                    aria-label={`${nameOf(row.residentId)}さんの再測定を足す`}
                                    className="min-h-tap w-full whitespace-nowrap rounded border-2 border-warn bg-warn-bg px-1 text-base font-bold text-ink disabled:opacity-60"
                                  >
                                    ＋再測定
                                  </button>
                                ) : si === 0 && inBulk ? (
                                  // 来た・まだ（1回目の行はいつも出す。保存の印に置き換えない＝確認の反証 中1）
                                  <span className={`whitespace-nowrap text-sm leading-tight ${cm.textCls}`}>
                                    <span aria-hidden="true">{cm.mark} </span>
                                    {cm.word}
                                  </span>
                                ) : null}
                                {line2 !== null ? (
                                  // 送信中・保存済みも読み上げで知らせる（前の SlotStatus の role="status" と同じ＝#45 の反証 軽3）
                                  <span role="status" className={`whitespace-nowrap text-sm font-bold leading-tight ${line2.tone === 'ok' ? 'text-ok' : line2.tone === 'warn' ? 'text-warn' : 'text-ink2'}`}>
                                    <span aria-hidden="true">{line2.mark} </span>
                                    {line2.text}
                                  </span>
                                ) : showTime ? (
                                  // 測った時刻（2026-11-09 計画B3 の反証 中3・確認の反証 軽2: 〔＋再測定〕を出す行も出す）。再測定の回がある方は
                                  // 氏名の列の「1回目（時刻）」と「↳ 再測定 n（時刻）」で見る。保存済みは見た目では時刻に譲り、読み上げでは知らせる
                                  <span className="whitespace-nowrap text-sm leading-tight text-ink2">
                                    測定 <span className="font-num">{time}</span>
                                    {mark !== null ? (
                                      <span role="status" className="sr-only">
                                        ・{mark.text}
                                      </span>
                                    ) : null}
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            {lunchRow ? (
                              lunch.cells(row.residentId)
                            ) : si === 0 && inBulk && lunchFailed ? (
                              // 昼食を読めない時は、昼食の3列に「読み込めません」（押せない。理由と〔最新に更新〕は表の上＝反証 軽3）
                              <td colSpan={3} className="px-2 py-1 text-sm text-ink2">
                                <span aria-hidden="true">— </span>
                                読み込めません
                              </td>
                            ) : (
                              // 再測定の行と、昼食の欄を出さない方（「全員」で出した休み・入院中の方）の行は空の欄（列の数をそろえる）
                              <>
                                <td className="px-1 py-1">
                                  {si === 0 ? (
                                    <>
                                      <span aria-hidden="true" className="text-sm text-ink2">
                                        —
                                      </span>
                                      <span className="sr-only">昼食は対象外（休み・入院中）</span>
                                    </>
                                  ) : null}
                                </td>
                                <td className="px-1 py-1" />
                                <td className="px-1 py-1" />
                              </>
                            )}
                          </tr>
                          {below ? (
                            <tr className={`${rowBg} ${isLast ? 'border-b border-border' : ''}`}>
                              {/* 詳しい文の行は表の幅を広げない（定時バイタルの F01 手直し 2026-10-10 と同じ形・#45 の反証 重1）。
                                  表は自動の幅（min-w-max）なので、長い文の1行ぶんの幅が氏名の列に配られて表が広がり、
                                  欄が sticky の氏名の列の下に隠れて押せなくなる。幅0＋最小100% の箱で表の幅の計算から外し、
                                  文は表の枠の幅で折り返して、横スクロールしても左に残す（sticky） */}
                              <td colSpan={DAYCARE_VITAL_FIELDS.length + 5} className="p-0">
                                <div className="w-0 min-w-full">
                                  <div className="sticky left-0 space-y-1 px-2 pb-2" style={{ maxWidth: tableBoxWidth > 0 ? tableBoxWidth : undefined }}>
                                    {detail ? (
                                      <SlotStatus st={shown} pend={pend?.state ?? null} onTake={(c) => void resolveTake(slot, c)} onMine={(c) => void resolveMine(slot, c)} />
                                    ) : null}
                                    {umNote !== null ? (
                                      <p role="alert" className="rounded border border-danger bg-danger-bg p-2 text-sm text-ink">
                                        <span aria-hidden="true">▲ </span>
                                        <span className="sr-only">{nameOf(row.residentId)}さん：</span>
                                        {umNote}
                                      </p>
                                    ) : null}
                                    {lunchNotes}
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
      {/* 昼食・水分の〔元に戻す〕の知らせ（それまでの食事一括と同じ）。テンキーを開いている間は、アプリの見出しの下に出す（テンキーのキー・
          〔閉じる〕と、テンキーのすぐ上の入れている行に重ねない。知らせは消さない＝2026-11-09 計画B3 の反証 中2・確認の反証 軽1）。
          位置は ui.tsx の useToast が読む --toast-top・--toast-bottom（ほかの画面は付けない＝今までどおり下） */}
      <div className="contents" style={kpOpen ? ({ '--toast-top': `${toastTop}px`, '--toast-bottom': 'auto' } as CSSProperties) : undefined}>
        {lunch.toast}
      </div>
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

export default DaycareVitalsMealsPage
