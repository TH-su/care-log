// ひと目ボード（/glance/:id・2026-10-29 本人承認の ROOT）。1人分の直近の様子を1画面で見る（読み取りだけ・書かない）。
//
// 読み方（画面を開くたび・〔最新を読み込む〕で取り直す＝前提は毎回実測）:
//   ・名簿 fetchResidents（:id の方を探す）・記録 fetchKarte（直近14日＋基準28日が入る範囲＝glance.ts の glanceWindows('14') の
//     fetchFrom〜今日。期間を7日／14日で切り替えても読み直さない）・継続中の申し送り fetchResidentPinnedNotes（fetchKarte は
//     期間より前に始まった継続を含まないため）。この3つが読めない時だけエラー
//   ・基準値 loadVitalThresholds・平熱 fetchUsualTempDetails・個別の目標 fetchResidentTargets・与薬の「未」の表
//     （fetchMedSlots＋fetchMedFirstDay＋getKindInputGate）は、読めなくても画面を止めない（見守りボードと同じ作法）
//   ・排便記録（fetchExcretion）と体重（fetchWeights）は別に読み、待っている間は「読み込み中」、未接続・読めない時は「カルテで確認」
//   ・医療の欄（病歴・内服薬）は fetchResGlance を開いた時に1回だけ。source_id が空・needs_review の方は呼ばない。
//     期間の切り替えでは呼び直さない（サーバーが開いた記録を残すため、先読み・やり直しの自動化もしない）
// 計算は glance.ts の computeGlance（見守りボードと同じ規則・同じ関数）。端末に置くのは期間（GLANCE_RANGE_KEY の既知値）だけ（原則11）。
// 氏名・id・記録・医療の値は端末に置かない。console に出さない。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { fetchMyRole, fetchResGlance, fetchResidentPinnedNotes, fetchUsualTempDetails, getKindInputGate, loadVitalThresholds } from '../lib/db'
import type { MyRole } from '../lib/db'
import { fetchIncidents, fetchKarte, fetchMedDay, fetchMedFirstDay, fetchMedSlots, fetchResidents, fetchResidentTargets } from '../lib/cachedReads'
import { useVitalLimits } from '../hooks/useVitalLimits'
import { VitalLimitsFailedNote } from '../components/VitalLimitsFailedNote'
import { buildMedDayRows, medMissingAllowed } from '../lib/med'
import type { MedDayRow } from '../lib/med'
import { excretionFailMessage, fetchExcretion, MSG_EXCRETION_UNCONFIGURED } from '../lib/excretionClient'
import type { HbSnapshot } from '../lib/excretionClient'
import { fetchWeights, MSG_WEIGHT_UNCONFIGURED, weightFailMessage } from '../lib/weightClient'
import type { WeightEntry } from '../lib/weightClient'
import type { ResidentTargets } from '../lib/vitalAlerts'
import type { BathRecord, FluidIntake, Incident, Meal, MedAdmin, MedSlot, MedSlotsSetting, Note, Outing, Resident, Vital } from '../lib/types'
import { fmtDayLabel } from '../lib/format'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../components/ui'
import { addDaysIso, jstClock, mergeNotes } from './alertsModel'
import {
  classifyMedicalState,
  computeGlance,
  GLANCE_RANGE_KEY,
  GLANCE_RULES,
  glanceWindows,
  medicalLinkable,
  BOARD_UNAVAILABLE_TEXT,
  medicalStaleText,
  normalizeMedicalRow,
  parseGlanceRange,
  rangeDays,
} from '../lib/glance'
import type { GlanceAnchor, GlanceRange, MedicalState, ResGlanceResult } from '../lib/glance'
import { GlanceView } from '../components/glance/GlanceView'
import type { GlanceSourceState } from '../components/glance/VitalCards'

const ERR_LOAD = 'ひと目ボードの記録を読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'
const NOTE_TARGETS = '個別の目標を読み込めなかったため、水分の目標と SpO2 の下限は施設の基準で判定しています。'
const NOTE_MED_ROWS = '服薬の時間帯を読み込めなかったため、与薬は「拒否」だけを数えています（「未」は数えていません）。'
const NOTE_MEDS = `与薬の記録を読み込めなかったため、与薬の欄は「${BOARD_UNAVAILABLE_TEXT}」です。`
const NOTE_INCIDENTS = `事故・ヒヤリハットの記録を読み込めなかったため、事故の欄は「${BOARD_UNAVAILABLE_TEXT}」です。`

/** 保存した期間を読む（既知値だけ。読めない環境・未知値は既定の直近7日） */
function readRange(): GlanceRange {
  try {
    if (typeof localStorage === 'undefined') return parseGlanceRange(null)
    return parseGlanceRange(localStorage.getItem(GLANCE_RANGE_KEY))
  } catch {
    return parseGlanceRange(null)
  }
}

function writeRange(v: GlanceRange): void {
  try {
    if (typeof localStorage !== 'undefined' && parseGlanceRange(v) === v) localStorage.setItem(GLANCE_RANGE_KEY, v)
  } catch {
    // 保存できなくても表示は成立する（次に開いた時に既定へ戻るだけ）
  }
}

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
  resident: Resident
  residents: Resident[]
  karte: { vitals: Vital[]; meals: Meal[]; fluids: FluidIntake[]; notes: Note[]; outings: Outing[]; baths: BathRecord[]; meds: MedAdmin[]; incidents: Incident[] }
  usual: number | null
  target: ResidentTargets | null
  targetsFailed: boolean
  medTable: MedTable | null
  /** 与薬・事故の表が読めたか。fetchKarte は表が無い DB で空の配列を返すため、別に確かめる（読めない時は「なし」と出さない） */
  medsRead: boolean
  incidentsRead: boolean
}

type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'missing' } | { status: 'ready'; data: Loaded }

type StoolState = { status: 'loading' } | { status: 'unconfigured' } | { status: 'error'; message: string } | { status: 'ready'; snap: HbSnapshot }
type WeightState = { status: 'loading' } | { status: 'unconfigured' } | { status: 'error'; message: string } | { status: 'ready'; byResident: Map<number, WeightEntry[]> }
type MedicalLoad = { status: 'loading' } | { status: 'done'; result: ResGlanceResult | null }

export function GlancePage() {
  const params = useParams<{ id?: string }>()
  const raw = params.id ?? ''
  const residentId = /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null
  if (residentId === null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <Link to="/glance" className="inline-flex min-h-tap items-center text-base text-link">
          <span aria-hidden="true">‹ </span>見守りボードへ戻る
        </Link>
        <div className="mt-3">
          <ErrorBlock message="この方のひと目ボードを開けませんでした（アドレスが正しくありません）。見守りボードへ戻って選び直してください。" />
        </div>
      </div>
    )
  }
  return <GlanceDetail key={residentId} residentId={residentId} />
}

function GlanceDetail({ residentId }: { residentId: number }) {
  const [range, setRangeState] = useState<GlanceRange>(readRange)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [stool, setStool] = useState<StoolState>({ status: 'loading' })
  const [weight, setWeight] = useState<WeightState>({ status: 'loading' })
  const [medical, setMedical] = useState<MedicalLoad>({ status: 'loading' })
  const [role, setRole] = useState<MyRole | null>(null)
  const [highlight, setHighlight] = useState<GlanceAnchor | null>(null)
  const [tick, setTick] = useState(0)
  const [medicalTick, setMedicalTick] = useState(0)
  const limits = useVitalLimits(tick)
  const aliveRef = useRef(true)
  // 医療の欄を読んだ回（同じ回で2度呼ばない＝開発時の二重実行でもサーバーへの問い合わせは1回）
  const medicalAskedRef = useRef<number | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (highlightTimer.current !== null) clearTimeout(highlightTimer.current)
    }
  }, [])

  // 記録（開いた時・再試行・〔最新を読み込む〕）
  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    setStool({ status: 'loading' })
    setWeight({ status: 'loading' })
    const clock = nowClock()
    const nowMs = Date.now()
    const day = clock.day
    const w = glanceWindows(day, '14')
    const residentsP = fetchResidents().then((rs) => rs.filter((r) => r != null && r.active !== false))
    const loadMedTable = async (): Promise<MedTable> => {
      const rs = await residentsP
      const [slots, firstDay, gate] = await Promise.all([fetchMedSlots(rs), fetchMedFirstDay(), getKindInputGate('med')])
      return { slots, firstDay, enabled: gate.observed && gate.value === true }
    }
    Promise.all([
      residentsP,
      fetchKarte(residentId, w.fetchFrom, day),
      fetchResidentPinnedNotes(residentId),
      loadVitalThresholds(),
      fetchUsualTempDetails(day),
      fetchResidentTargets().catch(() => null),
      loadMedTable().catch(() => null),
      // 表が読めるかだけを確かめる（どんな失敗も「読めない」側に倒す）
      fetchMedDay(day).then(
        () => true,
        () => false,
      ),
      fetchIncidents({ fromIso: day, toIso: day, residentId }).then(
        () => true,
        () => false,
      ),
    ])
      .then(([residents, karte, pinned, , details, targets, medTable, medsRead, incidentsRead]) => {
        if (cancelled || !aliveRef.current) return
        const resident = residents.find((r) => r.id === residentId) ?? null
        if (resident === null) {
          setState({ status: 'missing' })
          return
        }
        setState({
          status: 'ready',
          data: {
            day,
            nowMin: clock.nowMin,
            nowMs,
            resident,
            residents,
            karte: { ...karte, notes: mergeNotes(karte.notes, pinned) },
            usual: details.get(residentId)?.usual ?? null,
            target: targets === null ? null : (targets.get(residentId) ?? null),
            targetsFailed: targets === null,
            medTable,
            medsRead,
            incidentsRead,
          },
        })
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        setState({ status: 'error' })
      })
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
    fetchMyRole()
      .then((r) => {
        if (!cancelled && aliveRef.current) setRole(r)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [residentId, tick])

  const data = state.status === 'ready' ? state.data : null
  const loaded = data !== null
  const linkable = data ? medicalLinkable(data.resident) : false
  const sourceId = data ? data.resident.source_id : ''

  // 医療の欄（照合済みの方だけ・開いた時に1回。期間の切り替えでは呼ばない）
  useEffect(() => {
    if (!loaded || !linkable) return
    if (medicalAskedRef.current === medicalTick) return
    medicalAskedRef.current = medicalTick
    setMedical({ status: 'loading' })
    fetchResGlance(sourceId)
      .then((result) => {
        if (aliveRef.current) setMedical({ status: 'done', result })
      })
      .catch(() => {
        if (aliveRef.current) setMedical({ status: 'done', result: null })
      })
    // 記録の取り直し（〔最新を読み込む〕）・期間の切り替えでは呼び直さない。読み込みの済み・照合の可否・source_id・「もう一度読む」だけを見る
  }, [loaded, linkable, sourceId, medicalTick])

  const reload = useCallback(() => setTick((n) => n + 1), [])

  const onRange = useCallback((v: GlanceRange) => {
    setRangeState(v)
    writeRange(v)
  }, [])

  const onJump = useCallback((anchor: GlanceAnchor) => {
    const el = typeof document === 'undefined' ? null : document.getElementById(anchor)
    if (el) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      el.focus({ preventScroll: true })
    }
    setHighlight(anchor)
    if (highlightTimer.current !== null) clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => setHighlight(null), 2400)
  }, [])

  // 与薬の日ごとの表（直近 medDays 日・この方の分）。読めない時は undefined（「拒否」だけを数える）
  const medRows = useMemo<Array<{ day: string; row: MedDayRow }> | undefined>(() => {
    if (!data || data.medTable === null || !data.medsRead) return undefined
    const slotsByResident = new Map<number, MedSlot[]>()
    for (const s of data.medTable.slots) if (s.resident_id === residentId) slotsByResident.set(s.resident_id, s.slots)
    const out: Array<{ day: string; row: MedDayRow }> = []
    for (let i = 0; i < Math.max(GLANCE_RULES.medDays, GLANCE_RULES.boardDays); i++) {
      const d = addDaysIso(data.day, -i)
      const rows = buildMedDayRows({
        order: [residentId],
        slotsByResident,
        records: data.karte.meds.filter((r) => r.admin_on === d),
        day: d,
        today: data.day,
        nowMin: data.nowMin,
        missingAllowed: medMissingAllowed(data.medTable.enabled, data.medTable.firstDay, d),
      })
      for (const row of rows) out.push({ day: d, row })
    }
    return out
  }, [data, residentId])

  const model = useMemo(() => {
    if (!data) return null
    return computeGlance({
      resident: data.resident,
      today: data.day,
      nowMs: data.nowMs,
      range,
      vitals: data.karte.vitals,
      meals: data.karte.meals,
      fluids: data.karte.fluids,
      outings: data.karte.outings,
      notes: data.karte.notes,
      meds: data.medsRead ? data.karte.meds : null,
      medRows,
      baths: data.karte.baths,
      incidents: data.incidentsRead ? data.karte.incidents : null,
      usualTemp: data.usual,
      target: data.target,
      weights: weight.status === 'ready' ? (weight.byResident.get(residentId) ?? []) : null,
      excretion: stool.status === 'ready' ? { snap: stool.snap, careLog: data.residents } : null,
      thresholdsFor: limits.lookup,
    })
  }, [data, range, medRows, weight, stool, limits.lookup, residentId])

  const medicalState: MedicalState | 'loading' = !data ? 'loading' : !linkable ? 'not_linked' : medical.status === 'loading' ? 'loading' : classifyMedicalState(data.resident, medical.result)
  const medicalView = medical.status === 'done' && medical.result?.kind === 'ok' ? normalizeMedicalRow(medical.result.row) : null
  const staleText = medical.status === 'done' && medical.result?.kind === 'ok' ? medicalStaleText(medical.result.syncedAt, Date.now()) : null

  if (state.status === 'loading') {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <LoadingBlock label="ひと目ボードの記録を読み込み中です…" />
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <ErrorBlock message={ERR_LOAD} onRetry={reload} />
      </div>
    )
  }
  if (state.status === 'missing' || !data || !model) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <EmptyBlock message="この方は在籍の名簿に見つかりませんでした。見守りボードから選び直してください。" />
        <Link to="/glance" className="mt-3 inline-flex min-h-tap items-center text-base text-link">
          <span aria-hidden="true">‹ </span>見守りボードへ戻る
        </Link>
      </div>
    )
  }

  const toSource = (s: StoolState | WeightState, unconfigured: string): GlanceSourceState =>
    s.status === 'ready' ? { status: 'ready' } : s.status === 'loading' ? { status: 'loading' } : s.status === 'unconfigured' ? { status: 'unconfigured', message: unconfigured } : { status: 'error', message: s.message }

  const notes = (
    <>
      {data.targetsFailed ? <PartialNote text={NOTE_TARGETS} /> : null}
      {limits.failed ? <VitalLimitsFailedNote onRetry={() => void limits.refresh()} /> : null}
      {!data.medsRead ? <PartialNote text={NOTE_MEDS} /> : data.medTable === null ? <PartialNote text={NOTE_MED_ROWS} /> : null}
      {!data.incidentsRead ? <PartialNote text={NOTE_INCIDENTS} /> : null}
    </>
  )

  return (
    <GlanceView
      model={model}
      resident={data.resident}
      age={medicalView?.age ?? null}
      asOf={`${fmtDayLabel(data.day)} ${hm(data.nowMin)} 時点`}
      range={range}
      onRange={onRange}
      recentDays={rangeDays(range)}
      usualTemp={data.usual}
      weightSource={toSource(weight, MSG_WEIGHT_UNCONFIGURED)}
      excretionSource={toSource(stool, MSG_EXCRETION_UNCONFIGURED)}
      medicalState={medicalState}
      medicalView={medicalView}
      staleText={staleText}
      role={role}
      onMedicalRetry={() => setMedicalTick((n) => n + 1)}
      highlight={highlight}
      onJump={onJump}
      notes={notes}
      toolbar={
        <div className="flex flex-wrap items-center gap-gap">
          <Link to="/glance" className="inline-flex min-h-tap items-center text-base text-link">
            <span aria-hidden="true">‹ </span>見守りボード
          </Link>
          <Link to={`/karte/${data.resident.id}`} className="inline-flex min-h-tap items-center text-base text-link">
            カルテを開く<span aria-hidden="true"> ›</span>
          </Link>
          <button type="button" onClick={reload} className="inline-flex min-h-tap items-center rounded border border-border-strong bg-surface px-4 text-base text-ink">
            最新を読み込む
          </button>
        </div>
      }
    />
  )
}

function PartialNote({ text }: { text: string }) {
  return (
    <p className="text-sm text-warn">
      <span aria-hidden="true">▲ </span>
      {text}
    </p>
  )
}

export default GlancePage
