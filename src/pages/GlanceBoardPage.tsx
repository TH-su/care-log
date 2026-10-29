// 見守りボード（/glance・2026-10-29 本人承認の ROOT）。全員を居室の順に1行ずつ、直近の様子を列ごとのマスに記号＋短い値で出す。
//
// 読み方（画面を開くたび・〔最新を読み込む〕で取り直す＝前提は毎回実測。1人ずつの往復はしない）:
//   ・名簿 fetchResidents（返す順を居室の順の正とする）と、全員分の記録 fetchGlanceBoardRange（バイタル・食事・水分・外出外泊・
//     申し送りと継続中・与薬7日・事故14日。期間は glance.ts の glanceWindows の fetchFrom〜今日）。この2つが読めない時だけエラー
//   ・基準値 loadVitalThresholds・平熱 fetchUsualTempDetails（例外は来ない）・個別の目標 fetchResidentTargets（読めない時は施設の既定）・
//     与薬の「未」の表（fetchMedSlots＋fetchMedFirstDay＋getKindInputGate。読めない時は「拒否」だけを数える）は、読めなくても画面を止めない
//   ・排便記録（fetchExcretion）と体重（fetchWeights・全員分を一括）は別に読み、待っている間は「読み込み中」、未接続・読めない時は
//     「—（カルテで確認）」と一行の知らせ
// 計算は glance.ts の buildBoardRows / sortBoardRows（ひと目ボードと同じ規則・同じ関数）。入院中・外泊中の方は札を出し、印を数えない。
// 病歴・内服薬の欄は出さない（全員の画面のため）。年齢も出さない。
// 端末に置くのは並び（GLANCE_SORT_KEY の既知値）だけ（原則11）。氏名・id・記録は置かない。読み取りで書かない。console に出さない。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchGlanceBoardRange, fetchUsualTempDetails, getKindInputGate, loadVitalThresholds } from '../lib/db'
import type { GlanceBoardRange } from '../lib/db'
import { fetchMedFirstDay, fetchMedSlots, fetchResidents, fetchResidentTargets } from '../lib/cachedReads'
import { useVitalLimits } from '../hooks/useVitalLimits'
import { VitalLimitsFailedNote } from '../components/VitalLimitsFailedNote'
import { buildMedDayRows, medMissingAllowed } from '../lib/med'
import type { MedDayRow } from '../lib/med'
import { excretionFailMessage, fetchExcretion, MSG_EXCRETION_UNCONFIGURED } from '../lib/excretionClient'
import type { HbSnapshot } from '../lib/excretionClient'
import { fetchWeights, MSG_WEIGHT_UNCONFIGURED, weightFailMessage } from '../lib/weightClient'
import type { WeightEntry } from '../lib/weightClient'
import type { ResidentTargets } from '../lib/vitalAlerts'
import type { MedSlot, MedSlotsSetting, Resident } from '../lib/types'
import { fmtDayLabel } from '../lib/format'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../components/ui'
import { addDaysIso, jstClock, mergeNotes } from './alertsModel'
import {
  BOARD_UNAVAILABLE_TEXT,
  boardTempDomain,
  buildBoardRows,
  GLANCE_RULES,
  GLANCE_SORT_KEY,
  glanceWindows,
  parseGlanceSort,
  sortBoardRows,
} from '../lib/glance'
import type { BoardColumn, GlanceSort } from '../lib/glance'
import { BoardTable } from '../components/glance/boardTable'
import { BoardSortToggle } from '../components/glance/boardSortToggle'

const ERR_LOAD = '見守りボードの記録を読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'
const NOTE_TARGETS = '個別の目標を読み込めなかったため、水分の目標と SpO2 の下限は施設の基準で判定しています。'
const NOTE_MED_ROWS = '服薬の時間帯を読み込めなかったため、与薬は「拒否」だけを数えています（「未」は数えていません）。'
const NOTE_MEDS = '与薬の記録がまだ使えないため、与薬の列は出していません。'
const NOTE_INCIDENTS = '事故・ヒヤリハットの記録がまだ使えないため、事故の列は出していません。'

function readSort(): GlanceSort {
  try {
    if (typeof localStorage === 'undefined') return parseGlanceSort(null)
    return parseGlanceSort(localStorage.getItem(GLANCE_SORT_KEY))
  } catch {
    return parseGlanceSort(null) // 読めない環境では既定（居室の順）
  }
}

function writeSort(v: GlanceSort): void {
  try {
    if (typeof localStorage !== 'undefined' && parseGlanceSort(v) === v) localStorage.setItem(GLANCE_SORT_KEY, v)
  } catch {
    // 保存できなくても表示は成立する（次に開いた時に既定へ戻るだけ）
  }
}

/** いまの日本時間（読めない時は 1970-01-01 0:00 として扱う＝記録が無い表示になる） */
function nowClock(): { day: string; nowMin: number } {
  return jstClock(Date.now()) ?? { day: '1970-01-01', nowMin: 0 }
}

const hm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`

interface MedTable {
  slots: MedSlotsSetting[]
  firstDay: string | null
  enabled: boolean
}

interface Loaded {
  day: string
  nowMin: number
  nowMs: number
  residents: Resident[]
  range: GlanceBoardRange
  usual: Map<number, number | null>
  /** null＝読めなかった（施設の既定で判定） */
  targets: Map<number, ResidentTargets> | null
  /** null＝読めなかった（「拒否」だけを数える） */
  medTable: MedTable | null
}

type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: Loaded }

type StoolState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snap: HbSnapshot }

type WeightState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'error'; message: string }
  | { status: 'ready'; byResident: Map<number, WeightEntry[]> }

export function GlanceBoardPage() {
  const navigate = useNavigate()
  const [sort, setSortState] = useState<GlanceSort>(readSort)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [stool, setStool] = useState<StoolState>({ status: 'loading' })
  const [weight, setWeight] = useState<WeightState>({ status: 'loading' })
  const [tick, setTick] = useState(0)
  // 個人の閾値。読めない時は施設の基準で判定し、その旨を出す
  const limits = useVitalLimits(tick)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 名簿と全員分の記録（開いた時・再試行・〔最新を読み込む〕）
  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    setStool({ status: 'loading' })
    setWeight({ status: 'loading' })
    const clock = nowClock()
    const nowMs = Date.now()
    const day = clock.day
    const w = glanceWindows(day, '7')
    const residentsP = fetchResidents().then((rs) => rs.filter((r) => r != null && r.active !== false))
    const loadMedTable = async (): Promise<MedTable> => {
      const rs = await residentsP
      const [slots, firstDay, gate] = await Promise.all([fetchMedSlots(rs), fetchMedFirstDay(), getKindInputGate('med')])
      return { slots, firstDay, enabled: gate.observed && gate.value === true }
    }
    Promise.all([
      residentsP,
      fetchGlanceBoardRange(w.fetchFrom, day),
      loadVitalThresholds(),
      fetchUsualTempDetails(day),
      fetchResidentTargets().catch(() => null),
      loadMedTable().catch(() => null),
    ])
      .then(([residents, range, , details, targets, medTable]) => {
        if (cancelled || !aliveRef.current) return
        const usual = new Map<number, number | null>()
        for (const [id, d] of details) usual.set(id, d.usual)
        setState({
          status: 'ready',
          data: { day, nowMin: clock.nowMin, nowMs, residents, range, usual, targets, medTable },
        })
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        setState({ status: 'error' })
      })
    // 排便記録（全員分の写しを1回。〔最新を読み込む〕では取り直す）
    fetchExcretion({ force: tick > 0 })
      .then((r) => {
        if (cancelled || !aliveRef.current) return
        if (r === null) setStool({ status: 'unconfigured' })
        else if (!r.ok) setStool({ status: 'error', message: excretionFailMessage(r.reason) })
        else setStool({ status: 'ready', snap: r.snap })
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        setStool({ status: 'error', message: excretionFailMessage('network') })
      })
    // 体重（全員分を一括。照合に名簿の source_id が要る）
    residentsP
      .then((rs) => fetchWeights(rs, { force: tick > 0 }))
      .then((r) => {
        if (cancelled || !aliveRef.current) return
        if (r === null) setWeight({ status: 'unconfigured' })
        else if (!r.ok) setWeight({ status: 'error', message: weightFailMessage(r.reason) })
        else setWeight({ status: 'ready', byResident: r.byResident })
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        setWeight({ status: 'error', message: weightFailMessage('network') })
      })
    return () => {
      cancelled = true
    }
  }, [tick])

  const reload = useCallback(() => setTick((n) => n + 1), [])

  const onSort = useCallback((v: GlanceSort) => {
    setSortState(v)
    writeSort(v)
  }, [])

  const onOpen = useCallback((id: number) => navigate(`/glance/${id}`), [navigate])

  const data = state.status === 'ready' ? state.data : null

  // 与薬の日ごとの表（直近 medDays 日・全員分）。読めない時は undefined（「拒否」だけを数える）
  const medRowsByDay = useMemo<Map<string, MedDayRow[]> | undefined>(() => {
    if (!data || data.medTable === null || data.range.meds === null) return undefined
    const slotsByResident = new Map<number, MedSlot[]>()
    for (const s of data.medTable.slots) slotsByResident.set(s.resident_id, s.slots)
    const order = data.residents.map((r) => r.id)
    const out = new Map<string, MedDayRow[]>()
    for (let i = 0; i < GLANCE_RULES.medDays; i++) {
      const d = addDaysIso(data.day, -i)
      out.set(
        d,
        buildMedDayRows({
          order,
          slotsByResident,
          records: (data.range.meds ?? []).filter((r) => r.admin_on === d),
          day: d,
          today: data.day,
          nowMin: data.nowMin,
          missingAllowed: medMissingAllowed(data.medTable.enabled, data.medTable.firstDay, d),
        }),
      )
    }
    return out
  }, [data])

  const rows = useMemo(() => {
    if (!data) return []
    return buildBoardRows({
      residents: data.residents,
      today: data.day,
      nowMs: data.nowMs,
      range: '7',
      vitals: data.range.vitals,
      meals: data.range.meals,
      fluids: data.range.fluids,
      outings: data.range.outings,
      notes: mergeNotes(data.range.notes, data.range.pinned),
      meds: data.range.meds ?? [],
      medRowsByDay,
      incidents: data.range.incidents ?? [],
      usualTemps: data.usual,
      targets: data.targets ?? new Map(),
      weights: weight.status === 'ready' ? weight.byResident : null,
      excretion: stool.status === 'ready' ? stool.snap : null,
      thresholdsFor: limits.lookup,
    })
  }, [data, medRowsByDay, weight, stool, limits.lookup])

  const sorted = useMemo(() => sortBoardRows(rows, sort), [rows, sort])
  const tempDomain = useMemo(() => boardTempDomain(rows), [rows])

  const pendingColumns = useMemo(() => {
    const cols: BoardColumn[] = []
    if (stool.status === 'loading') cols.push('stool')
    if (weight.status === 'loading') cols.push('weight')
    return cols
  }, [stool.status, weight.status])

  const marked = rows.filter((r) => r.away === null && r.signCount > 0).length
  const dangerCount = rows.filter((r) => r.away === null && r.topSeverity === 'danger').length
  const awayCount = rows.filter((r) => r.away !== null).length

  return (
    <div className="mx-auto w-full max-w-7xl p-4">
      <h1 className="text-xl font-heavy text-ink">見守りボード</h1>
      {data ? (
        <p className="tabular mt-1 text-sm text-ink2">
          {fmtDayLabel(data.day)} {hm(data.nowMin)} 時点（日本時間）
        </p>
      ) : null}
      <p className="mt-1 text-sm text-ink2">
        全員の直近7日の様子を、その前の28日とくらべて1行ずつ出します。行を押すとその方のひと目ボードへ移ります。
      </p>
      <p className="mt-1 text-sm text-ink2">
        <span className="font-bold text-danger">!!</span> 要注意・<span className="font-bold text-warn">!</span> 注意・
        <span aria-hidden="true">·</span> なし・{BOARD_UNAVAILABLE_TEXT}＝この端末では読めない（カルテで確かめてください）。
        排便は排便記録のアプリの直近14日、体重は体重管理アプリの記録です。入院中・外泊中の方は印を数えません。
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-gap">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm text-ink2">並び</h2>
          <div className="mt-1">
            <BoardSortToggle value={sort} onChange={onSort} />
          </div>
        </div>
        <button
          type="button"
          onClick={reload}
          disabled={state.status === 'loading'}
          className="inline-flex min-h-tap items-center rounded border border-border-strong bg-surface px-4 text-base text-ink disabled:text-ink3"
        >
          最新を読み込む
        </button>
      </div>

      <div className="mt-3">
        {state.status === 'loading' ? (
          <LoadingBlock label="見守りボードの記録を読み込み中です…" />
        ) : state.status === 'error' ? (
          <ErrorBlock message={ERR_LOAD} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyBlock message="在籍の方がいません。名簿（入居者マスタ）を確かめてください。" />
        ) : (
          <>
            {data?.targets === null ? <PartialNote text={NOTE_TARGETS} /> : null}
            {limits.failed ? <VitalLimitsFailedNote className="mb-2" onRetry={() => void limits.refresh()} /> : null}
            {data?.range.meds === null ? <PartialNote text={NOTE_MEDS} /> : data?.medTable === null ? <PartialNote text={NOTE_MED_ROWS} /> : null}
            {data?.range.incidents === null ? <PartialNote text={NOTE_INCIDENTS} /> : null}
            <SourceNote what="排便" state={stool} unconfigured={MSG_EXCRETION_UNCONFIGURED} />
            <SourceNote what="体重" state={weight} unconfigured={MSG_WEIGHT_UNCONFIGURED} />
            <p role="status" className="mb-2 text-base text-ink">
              印のある方 <span className="tabular font-bold">{marked}</span> 名
              {dangerCount > 0 ? (
                <>
                  （うち要注意 <span className="tabular font-bold">{dangerCount}</span> 名）
                </>
              ) : null}
              <span className="text-sm text-ink2">
                ・確認した方 <span className="tabular">{rows.length}</span> 名
                {awayCount > 0 ? (
                  <>
                    ・入院中・外泊中 <span className="tabular">{awayCount}</span> 名
                  </>
                ) : null}
              </span>
            </p>
            <BoardTable rows={sorted} tempDomain={tempDomain} pendingColumns={pendingColumns} onOpen={onOpen} />
          </>
        )}
      </div>
    </div>
  )
}

function PartialNote({ text }: { text: string }) {
  return (
    <p className="mb-2 text-sm text-warn">
      <span aria-hidden="true">▲ </span>
      {text}
    </p>
  )
}

/** 排便記録・体重の読み込みの一言（読めた時は何も出さない） */
function SourceNote({
  what,
  state,
  unconfigured,
}: {
  what: string
  state: { status: 'loading' } | { status: 'unconfigured' } | { status: 'error'; message: string } | { status: 'ready' }
  unconfigured: string
}) {
  if (state.status === 'loading') {
    return (
      <p role="status" className="mb-2 text-sm text-ink2">
        <span aria-hidden="true">ⓘ </span>
        {what}の記録を読み込み中です…（読み込み後に{what}の列を出します）
      </p>
    )
  }
  if (state.status === 'unconfigured') return <PartialNote text={`${unconfigured}。${what}の列は「${BOARD_UNAVAILABLE_TEXT}」です。`} />
  if (state.status === 'error') return <PartialNote text={`${state.message}（${what}の列は「${BOARD_UNAVAILABLE_TEXT}」です）`} />
  return null
}

export default GlanceBoardPage
