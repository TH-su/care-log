// 今日の要注意（/alerts・A5・2026-10-16 本人回答）。下部タブ「その他」と左レールから入る。
//
// 階ごと（1階・2階・全）に、今日の利用者ごとの理由を1枚に出す（判定は vitalAlerts.ts の buildDayAlerts・純関数・試験あり）:
//   基準外のバイタル（A1 の平熱+1.0↑・A9 の個別の下限を含む）・摂取低下（A2）・水分不足（A3 の目標の60%未満・16時から）・
//   最重要の申し送り（その日の分と続いている継続）・与薬の「未」。理由を押すとカルテのその欄へ移る（/karte/:id?sec=…）。
//
// 読み方（画面を開くたび・〔最新を読み込む〕・日付が変わった時に取り直す＝前提は毎回実測）:
//   ・名簿 fetchResidents と記録 fetchTimelineChunk（今日を含む7日＝摂取低下の連続日数を数えるため。継続の申し送り pinned も来る）。
//     この2つが読めない時だけ画面をエラーにする
//   ・基準値 loadVitalThresholds・平熱 fetchUsualTemps（失敗しても例外は来ない＝平熱なし）・個別の目標 fetchResidentTargets
//     （読めない時は施設の既定）・与薬（fetchMedDay＋fetchMedSlots＋fetchMedFirstDay＋getKindInputGate。読めない時は与薬を出さない）
//     は読めなくても画面を止めない（何を出していないかを一行で知らせる）
// 今日と時刻は日本時間（alertsModel.ts の jstClock）。1分ごとに時刻を進め、水分不足（16時から）と与薬の「未」を描き直す。
// UI 状態は階だけを localStorage（ALERTS_FLOOR_KEY）に置く（既知の形だけ・原則11）。氏名・記録は置かない。console に出さない。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchMedDay,
  fetchMedFirstDay,
  fetchMedSlots,
  fetchResidents,
  fetchResidentTargets,
  fetchTimelineChunk,
  fetchUsualTemps,
  getKindInputGate,
  loadVitalThresholds,
} from '../lib/db'
import { buildMedDayRows, medMissingAllowed } from '../lib/med'
import type { MedDayRow } from '../lib/med'
import { buildDayAlerts, fluidTotalsOf } from '../lib/vitalAlerts'
import type { AlertReason, ResidentTargets } from '../lib/vitalAlerts'
import { vitalThresholds } from '../lib/vitalThresholds'
import { fmtDayLabel } from '../lib/format'
import type { FluidIntake, Meal, MedAdmin, MedSlot, MedSlotsSetting, Note, Resident, Vital } from '../lib/types'
import { EmptyBlock, ErrorBlock, LoadingBlock, SegmentPicker } from '../components/ui'
import {
  addDaysIso,
  ALERTS_FLOOR_KEY,
  alertHref,
  FLOOR_ALL,
  FLOOR_OTHER,
  floorOf,
  jstClock,
  mergeNotes,
  readAlertsFloor,
} from './alertsModel'

/** 摂取低下の連続日数を数えるために読む日数（今日を含む） */
const MEAL_DAYS = 7
/** 時刻を進める間隔（ms） */
const CLOCK_MS = 60_000

const ERR_LOAD = '今日の記録を読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'
const NOTE_TARGETS = '個別の目標を読み込めなかったため、水分の目標と SpO2 の下限は施設の基準で判定しています。'
const NOTE_MEDS = '与薬の記録を読み込めなかったため、与薬の「未」は出していません。'

function readFloor(): string {
  try {
    if (typeof localStorage === 'undefined') return FLOOR_ALL
    return readAlertsFloor(localStorage.getItem(ALERTS_FLOOR_KEY)) ?? FLOOR_ALL
  } catch {
    return FLOOR_ALL // 読めない環境では既定（全）
  }
}

function writeFloor(v: string): void {
  try {
    if (typeof localStorage !== 'undefined' && readAlertsFloor(v) !== null) localStorage.setItem(ALERTS_FLOOR_KEY, v)
  } catch {
    // 保存できなくても表示は成立する（次に開いた時に既定へ戻るだけ）
  }
}

/** いまの日本時間（読めない時は端末の 0 時扱いにはせず、最後に読めた値を使う側で持つ） */
function nowClock(): { day: string; nowMin: number } {
  return jstClock(Date.now()) ?? { day: '1970-01-01', nowMin: 0 }
}

interface MedRaw {
  records: MedAdmin[]
  slots: MedSlotsSetting[]
  firstDay: string | null
  enabled: boolean
}

interface Loaded {
  day: string
  residents: Resident[]
  vitals: Vital[]
  meals: Meal[]
  fluids: FluidIntake[]
  notes: Note[]
  usual: Map<number, number | null>
  /** null＝読めなかった（施設の既定で判定） */
  targets: Map<number, ResidentTargets> | null
  /** null＝読めなかった（与薬は出さない） */
  med: MedRaw | null
}

type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: Loaded }

const hm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`

export function AlertsPage() {
  const [clock, setClock] = useState(nowClock)
  const [floor, setFloorState] = useState<string>(readFloor)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [tick, setTick] = useState(0)
  const aliveRef = useRef(true)
  const day = clock.day

  useEffect(() => {
    aliveRef.current = true
    const id = window.setInterval(() => {
      const next = nowClock()
      setClock((cur) => (cur.day === next.day && cur.nowMin === next.nowMin ? cur : next))
    }, CLOCK_MS)
    return () => {
      aliveRef.current = false
      window.clearInterval(id)
    }
  }, [])

  // 今日の記録（画面を開いた時・再試行・日付が変わった時）
  useEffect(() => {
    let cancelled = false
    setState((cur) => (cur.status === 'ready' && cur.data.day === day ? cur : { status: 'loading' }))
    const from = addDaysIso(day, -(MEAL_DAYS - 1))
    const residentsP = fetchResidents()
    const coreP = Promise.all([residentsP, fetchTimelineChunk(from, day, null)])
    const loadMed = async (): Promise<MedRaw> => {
      const rs = await residentsP
      const [records, slots, firstDay, gate] = await Promise.all([
        fetchMedDay(day),
        fetchMedSlots(rs),
        fetchMedFirstDay(),
        getKindInputGate('med'),
      ])
      return {
        records: records.filter((r) => r.admin_on === day),
        slots,
        firstDay,
        enabled: gate.observed && gate.value === true,
      }
    }
    const medP: Promise<MedRaw | null> = loadMed().catch(() => null)
    const extrasP = Promise.all([
      loadVitalThresholds(),
      fetchUsualTemps(day),
      fetchResidentTargets().catch(() => null),
      medP,
    ])
    Promise.all([coreP, extrasP])
      .then(([[residents, chunk], [, usual, targets, med]]) => {
        if (cancelled || !aliveRef.current) return
        setState({
          status: 'ready',
          data: {
            day,
            residents: residents.filter((r) => r != null && r.active !== false),
            vitals: chunk.vitals.filter((v) => v.measured_on === day),
            meals: chunk.meals,
            fluids: chunk.fluids,
            notes: mergeNotes(chunk.notes, chunk.pinned),
            usual,
            targets,
            med,
          },
        })
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        setState({ status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [day, tick])

  const reload = useCallback(() => {
    setClock(nowClock())
    setTick((n) => n + 1)
  }, [])

  const onFloor = useCallback((v: string) => {
    if (readAlertsFloor(v) === null) return
    setFloorState(v)
    writeFloor(v)
  }, [])

  const data = state.status === 'ready' ? state.data : null

  const ordered = useMemo(() => {
    const list = (data?.residents ?? []).slice()
    list.sort((a, b) => {
      const ra = a.room ?? ''
      const rb = b.room ?? ''
      if (ra === rb) return a.id - b.id
      if (ra === '') return 1
      if (rb === '') return -1
      return ra < rb ? -1 : 1
    })
    return list
  }, [data])

  const floorOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of ordered) set.add(floorOf(r.room))
    const opts = Array.from(set)
      .filter((f) => f !== FLOOR_OTHER)
      .sort()
      .map((f) => ({ value: f, label: `${f}階` }))
    if (set.has(FLOOR_OTHER)) opts.push({ value: FLOOR_OTHER, label: '居室未設定' })
    opts.push({ value: FLOOR_ALL, label: '全' })
    return opts
  }, [ordered])

  // 復元した階が今の名簿に無い時だけ「全」へ戻す（名簿を読めるまでは照合しない）
  useEffect(() => {
    if (ordered.length === 0) return
    if (floorOptions.some((o) => o.value === floor)) return
    setFloorState(FLOOR_ALL)
  }, [floorOptions, floor, ordered.length])

  const shown = useMemo(() => (floor === FLOOR_ALL ? ordered : ordered.filter((r) => floorOf(r.room) === floor)), [ordered, floor])

  const medRows = useMemo<MedDayRow[] | undefined>(() => {
    if (!data || data.med === null) return undefined
    const slotsByResident = new Map<number, MedSlot[]>()
    for (const s of data.med.slots) slotsByResident.set(s.resident_id, s.slots)
    return buildMedDayRows({
      order: ordered.map((r) => r.id),
      slotsByResident,
      records: data.med.records,
      day: data.day,
      today: clock.day,
      nowMin: clock.nowMin,
      missingAllowed: medMissingAllowed(data.med.enabled, data.med.firstDay, data.day),
    })
  }, [data, ordered, clock])

  const alerts = useMemo(() => {
    if (!data) return []
    return buildDayAlerts({
      day: data.day,
      today: clock.day,
      nowMin: clock.nowMin,
      residentIds: shown.map((r) => r.id),
      vitals: data.vitals,
      meals: data.meals,
      fluidTotals: fluidTotalsOf(data.fluids, data.day),
      notes: data.notes,
      medRows,
      usualTemps: data.usual,
      targets: data.targets ?? new Map(),
    })
  }, [data, clock, shown, medRows])

  const byId = useMemo(() => {
    const m = new Map<number, Resident>()
    for (const r of ordered) m.set(r.id, r)
    return m
  }, [ordered])

  const fromHour = vitalThresholds().fluidShort.fromHour
  const dangerCount = alerts.filter((a) => a.reasons.some((x) => x.severity === 'danger')).length

  return (
    <div className="mx-auto w-full max-w-2xl p-4">
      <h1 className="text-xl font-heavy text-ink">今日の要注意</h1>
      <p className="tabular mt-1 text-sm text-ink2">
        {fmtDayLabel(day)} {hm(clock.nowMin)} 時点（日本時間）
      </p>
      <p className="mt-1 text-sm text-ink2">
        基準を外れたバイタル（平熱との差・個別の下限を含む）、摂取低下、水分不足（{fromHour}時から）、最重要の申し送り、与薬の「未」を出します。
        押すとカルテのその欄へ移ります。
      </p>

      <div className="mt-3">
        <h2 className="text-sm text-ink2">表示する階</h2>
        <div className="mt-1">
          <SegmentPicker options={floorOptions} value={floor} onChange={onFloor} ariaLabel="表示する階" />
        </div>
      </div>

      <button
        type="button"
        onClick={reload}
        disabled={state.status === 'loading'}
        className="mt-3 inline-flex min-h-tap items-center rounded border border-border-strong bg-surface px-4 text-base text-ink disabled:text-ink3"
      >
        最新を読み込む
      </button>

      <div className="mt-3">
        {state.status === 'loading' ? (
          <LoadingBlock label="今日の記録を読み込み中です…" />
        ) : state.status === 'error' ? (
          <ErrorBlock message={ERR_LOAD} onRetry={reload} />
        ) : (
          <>
            {data?.targets === null ? <PartialNote text={NOTE_TARGETS} /> : null}
            {data?.med === null ? <PartialNote text={NOTE_MEDS} /> : null}
            {day === clock.day && clock.nowMin < fromHour * 60 ? (
              <p className="mb-2 text-sm text-ink2">
                <span aria-hidden="true">ⓘ </span>水分不足は{fromHour}時から出します。
              </p>
            ) : null}
            <p role="status" className="mb-2 text-base text-ink">
              要注意 <span className="tabular font-bold">{alerts.length}</span> 名
              {dangerCount > 0 ? (
                <>
                  （うち危険 <span className="tabular font-bold">{dangerCount}</span> 名）
                </>
              ) : null}
              <span className="text-sm text-ink2">
                ・確認した方 <span className="tabular">{shown.length}</span> 名
              </span>
            </p>
            {alerts.length === 0 ? (
              <EmptyBlock message={shown.length === 0 ? 'この階の在籍の方がいません。' : '今日の要注意はありません。'} />
            ) : (
              <ul className="space-y-3">
                {alerts.map((a) => {
                  const r = byId.get(a.residentId)
                  const danger = a.reasons.some((x) => x.severity === 'danger')
                  return (
                    <li key={a.residentId} className={`rounded-lg border bg-surface p-3 ${danger ? 'border-danger' : 'border-border-strong'}`}>
                      <p className="flex flex-wrap items-baseline gap-x-3">
                        <span className="tabular text-sm text-ink3">{r?.room ?? '—'}</span>
                        <Link to={`/karte/${a.residentId}`} className="inline-flex min-h-tap items-center text-lg font-bold text-link">
                          {r?.name ?? '（名簿にない方）'}
                          <span aria-hidden="true"> ›</span>
                        </Link>
                      </p>
                      <ul className="mt-1 space-y-1">
                        {a.reasons.map((x, i) => (
                          <li key={`${x.kind}-${x.recordId ?? 'n'}-${i}`}>
                            <ReasonLink residentId={a.residentId} reason={x} />
                          </li>
                        ))}
                      </ul>
                    </li>
                  )
                })}
              </ul>
            )}
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

const SECTION_WORD: Record<AlertReason['section'], string> = {
  vitals: 'バイタル',
  meals: '食事・水分',
  notes: '申し送り',
  meds: '与薬',
}

/** 理由1つ（押すとカルテのその欄へ）。危険・注意は文字でも示す（色だけに頼らない） */
function ReasonLink({ residentId, reason }: { residentId: number; reason: AlertReason }) {
  const danger = reason.severity === 'danger'
  return (
    <Link
      to={alertHref(residentId, reason.section)}
      className="flex min-h-tap w-full flex-wrap items-center gap-x-2 rounded border border-border bg-surface2 px-3 py-1 text-base text-ink"
    >
      <span className={`shrink-0 text-sm font-bold ${danger ? 'text-danger' : 'text-warn'}`}>
        <span aria-hidden="true">{danger ? '▲▲ ' : '▲ '}</span>
        {danger ? '危険' : '注意'}
      </span>
      <span className="font-bold">{reason.label}</span>
      {reason.time ? <span className="tabular text-sm text-ink2">{reason.time.replace(/^0/, '')}</span> : null}
      <span className="ml-auto text-sm text-link">
        カルテの{SECTION_WORD[reason.section]}へ<span aria-hidden="true"> ›</span>
      </span>
    </Link>
  )
}

export default AlertsPage
