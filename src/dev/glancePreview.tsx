// ひと目ボード・見守りボードの開発用の見本（glance-preview.html から開く。npx vite で開いて見るだけ・公開物に入らない）。
//
// ・架空データだけ（人名・病名・薬剤名は「架空」を名乗る）。db.ts・supabase・gasClient を import しない
// ・端末に置くのは本物の画面と同じ UI 状態の2つだけ（期間＝GLANCE_RANGE_KEY・並び＝GLANCE_SORT_KEY の既知値）。氏名・id・医療の値は置かない
// ・本物の画面と同じ部品（GlanceView・boardTable・boardSortToggle）と同じ計算（glance.ts）に、架空データを props で流す
// ・架空1名（架空太郎）に45日分のバイタル・食事・水分・排便・体重・与薬・申し送り・事故を置き、「平熱+1.0℃以上」
//   「水分8割未満」「体重1か月3%以上減」の3件を仕込む。見守りボードは架空16名（うち数名に兆し・1名は入院中）
// ・役割（field／office／admin）と医療の欄の状態（ok／no_function／no_shadow／not_linked）を切り替えて見る
// ・#board で見守りボードから始まる。行を押すと見本の中のひと目ボードへ
// ・確かめ（runCheck）の8段は画面の中と window.__glanceCheck に結果を出す（console に出さない）。?check=1 で開くと自動で走る
// ・?mode=dark で暗い配色を見る

import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import '../styles/tokens.css'
import '../index.css'
import {
  boardTempDomain,
  buildBoardRows,
  classifyMedicalState,
  computeGlance,
  GLANCE_RANGE_KEY,
  GLANCE_RULES,
  GLANCE_SORT_KEY,
  MEDICAL_STATE_MESSAGE,
  medicalStaleText,
  normalizeMedicalRow,
  parseGlanceRange,
  parseGlanceSort,
  rangeDays,
  sortBoardRows,
} from '../lib/glance'
import type { GlanceAnchor, GlanceExcretionInput, GlanceRange, GlanceSort, MedicalState, ResGlanceResult } from '../lib/glance'
import type { FluidIntake, Incident, Meal, MedAdmin, Note, Outing, Resident, Vital } from '../lib/types'
import type { WeightEntry } from '../lib/weightClient'
import { GlanceView } from '../components/glance/GlanceView'
import type { MedicalRole } from '../components/glance/MedicalPanel'
import { BoardTable } from '../components/glance/boardTable'
import { BoardSortToggle } from '../components/glance/boardSortToggle'
import { SegmentPicker } from '../components/ui'

// ══════════════════════════════════════════════════════════════
// 架空データ（日付は固定＝毎回同じ結果）
// ══════════════════════════════════════════════════════════════

const TODAY = '2026-10-29'
const NOW_MS = Date.parse('2026-10-29T10:00:00+09:00')
const DAYS = 45

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const NAMES = [
  '架空太郎',
  '架空花子',
  '架空次郎',
  '架空三郎',
  '架空四郎',
  '架空五郎',
  '架空六子',
  '架空七子',
  '架空八郎',
  '架空九子',
  '架空十郎',
  '架空十一子',
  '架空十二郎',
  '架空十三子',
  '架空十四郎',
  '架空十五子',
]

const RESIDENTS: Resident[] = NAMES.map((name, i) => ({
  id: i + 1,
  source_id: i === 1 ? '' : `KAKU-${String(i + 1).padStart(3, '0')}`,
  name,
  kana: null,
  room: String(101 + i),
  gender: null,
  care_level: `要介護${(i % 5) + 1}`,
  active: true,
  needs_review: false,
  note_alias: null,
}))

/** 決まった揺らぎ（乱数を使わない＝毎回同じ） */
const wobble = (rid: number, k: number, amp: number) => Math.round(Math.sin(rid * 7.3 + k * 1.7) * amp * 10) / 10

interface Fixture {
  vitals: Vital[]
  meals: Meal[]
  fluids: FluidIntake[]
  outings: Outing[]
  notes: Note[]
  meds: MedAdmin[]
  incidents: Incident[]
  weights: Map<number, WeightEntry[]>
  usual: Map<number, number | null>
  excretion: GlanceExcretionInput['snap']
}

function buildFixture(): Fixture {
  const f: Fixture = { vitals: [], meals: [], fluids: [], outings: [], notes: [], meds: [], incidents: [], weights: new Map(), usual: new Map(), excretion: { residents: [], recs: new Map(), cfg: { stoolWarnD: 2, stoolDangerD: 3 } } }
  let id = 1
  for (const r of RESIDENTS) {
    const rid = r.id
    f.usual.set(rid, 36.4)
    for (let k = DAYS - 1; k >= 0; k--) {
      const day = addDays(TODAY, -k)
      // 9番の方は直近3日の記録が無い（記録の欠け）
      if (rid === 9 && k < 3) continue
      let temp = 36.4 + wobble(rid, k, 0.2)
      let spo2 = 96 + Math.round(wobble(rid, k, 1))
      // 1番（架空太郎）: 今日 平熱+1.0℃
      if (rid === 1 && k === 0) temp = 37.4
      // 5番: 今日 発熱
      if (rid === 5 && k === 0) temp = 38.2
      // 7番: 直近7日の SpO2 が下がった
      if (rid === 7 && k < 7) spo2 = 92
      f.vitals.push({ id: id++, resident_id: rid, measured_on: day, kind: 'routine', measured_at: '09:00', temp: Math.round(temp * 10) / 10, sys_bp: 128 + Math.round(wobble(rid, k, 6)), dia_bp: 74 + Math.round(wobble(rid, k + 3, 4)), pulse: 72 + Math.round(wobble(rid, k + 5, 5)), spo2, note: null, symptom: null, recorded_by: null, rev: 1 })
      for (const slot of ['breakfast', 'lunch', 'dinner'] as const) {
        // 3番: 今日と昨日は入院中
        const hospital = rid === 3 && k < 2
        const amt = rid === 1 && k < 7 ? 7 : 8
        f.meals.push({ id: id++, resident_id: rid, meal_on: day, meal_slot: slot, main_amount: hospital ? null : amt, side_amount: hospital ? null : amt, status: hospital ? 'hospital' : 'eaten', note: null, recorded_by: null, rev: 1 })
      }
      // 1番: 直近3日（今日を除く）は 800ml（目標の8割未満）・それ以前は 1300ml
      const ml = rid === 1 && k >= 1 && k <= 3 ? 800 : 1300
      if (!(rid === 3 && k < 2)) f.fluids.push({ id: id++, resident_id: rid, taken_on: day, taken_at: '15:00', amount_ml: ml, kind: null, recorded_by: null, rev: 1 })
    }
    // 体重（1番は1か月で3%以上減）。12番以降は体重の記録なし（「—（カルテで確認）」）
    if (rid < 12) {
      const base = 50 + rid
      const ws: WeightEntry[] = [
        { date: addDays(TODAY, -200), weight: base + 0.6, mode: 'normal' },
        { date: addDays(TODAY, -100), weight: base + 0.4, mode: 'normal' },
        { date: addDays(TODAY, -35), weight: base, mode: 'normal' },
        { date: addDays(TODAY, -2), weight: rid === 1 ? Math.round((base * 0.965) * 10) / 10 : base, mode: 'normal' },
      ]
      f.weights.set(rid, ws)
    }
    // 排便記録（12番以降は排便記録に居ない＝照合できない）
    if (rid < 12) {
      const hbId = `hb-${rid}`
      f.excretion.residents.push({ id: hbId, key: r.name, room: r.room ?? '', roomLabel: r.room ?? '', active: true, hidden: false, cfg: {}, hospitalizations: [], dayOnly: false })
      const recs = []
      // 6番は4日前が最後（要注意）。ほかは2日おき
      const lastGap = rid === 6 ? 4 : 1
      for (let k = 30; k >= lastGap; k -= 2) {
        const day = addDays(TODAY, -k)
        const datetime = `${day}T08:00`
        recs.push({ id: `${hbId}-${k}`, residentId: hbId, type: 'stool' as const, date: day, time: '08:00', datetime, tsUTC: Date.parse(`${datetime}:00+09:00`), stoolAmt: '中等量', cons: '普通', medicine: '', tablets: '' })
      }
      f.excretion.recs.set(hbId, recs)
    }
  }
  // 1番: 与薬の拒否2回・申し送り・ヒヤリハット1件
  for (const k of [1, 4]) f.meds.push({ id: id++, resident_id: 1, admin_on: addDays(TODAY, -k), slot: 'morning', status: 'refused', given_at: null, prn_drug: null, prn_reason: null, prn_effect: null, note: null, recorded_by: null, rev: 1, created_at: null, auto: false })
  const note = (rid: number, k: number, body: string, extra: Partial<Note> = {}): Note => ({ id: id++, note_on: addDays(TODAY, -k), shift: 'day', facility: null, category: null, resident_id: rid, role_tags: [], importance: 'normal', body, occurred_at: null, ongoing: false, ended_at: null, reporter_id: null, color: null, after16: false, categories: ['体調'], rev: 1, ...extra })
  f.notes.push(note(1, 0, '架空の申し送り（見本）: 朝から微熱。水分をすすめる。', { importance: 'important' }))
  f.notes.push(note(1, 6, '架空の申し送り（見本）: 食事のペースがゆっくり。継続して見守る。', { ongoing: true }))
  f.notes.push(note(1, 12, '架空の申し送り（見本）: 体重の測定を月2回に。'))
  f.incidents.push({ id: id++, kind: 'nearmiss', resident_id: 1, occurred_on: addDays(TODAY, -5), occurred_at: `${addDays(TODAY, -5)}T14:00:00+09:00`, types: [], status: 'open' } as unknown as Incident)
  // 10番: 外泊中（3日前から帰着未定）
  f.outings.push({ id: id++, resident_id: 10, kind: 'overnight', start_on: addDays(TODAY, -3), start_at: null, end_on: null, end_at: null, companion: null, note: null, recorded_by: null, rev: 1 })
  return f
}

const FX = buildFixture()

/** 架空の医療の写し（res_glance_get の row の形） */
const MEDICAL_ROW = {
  age: 88,
  diseases: [{ name: '架空病A', onset: '架空の年', hospital: '架空病院' }],
  currentDiseases: '架空病A',
  pastHistory: '架空病C（見本）',
  medsRegular: '架空薬B錠 1回1錠 朝食後\n架空薬E錠 1回1錠 夕食後',
  medsPrn: '架空頓用薬D（見本）',
  highRiskMeds: '',
  sideEffects: null,
  allergy: '架空アレルゲン（見本）',
  allergenTags: [],
  forbiddenTags: [],
  swallow: '見本: 刻み',
  mealForm: null,
  thickener: null,
  medicalCare: null,
  infections: null,
  medMgmt: '見本: 施設で管理',
  hospital: '架空クリニック',
  doctor: '架空医師',
  visitDay: '見本: 隔週',
}

type MedicalMode = 'ok' | 'no_function' | 'no_shadow' | 'not_linked'

/** 見本の「読む口」。モードに応じた結果を返す（照合前の方には呼ばない＝本物と同じ） */
function fakeResGlance(mode: MedicalMode): ResGlanceResult {
  if (mode === 'ok') return { kind: 'ok', row: MEDICAL_ROW, syncedAt: '2026-10-28T08:00:00+09:00' }
  if (mode === 'no_function') return { kind: 'no_function' }
  return { kind: 'no_shadow' }
}

// ══════════════════════════════════════════════════════════════
// 画面
// ══════════════════════════════════════════════════════════════

interface Controls {
  role: MedicalRole
  medical: MedicalMode
  range: GlanceRange
  sort: GlanceSort
}

const ROLE_OPTIONS = [
  { value: 'field', label: '現場' },
  { value: 'office', label: '事務所' },
  { value: 'admin', label: '管理者' },
]
const MEDICAL_OPTIONS = [
  { value: 'ok', label: '写しあり' },
  { value: 'no_function', label: '読む口なし' },
  { value: 'no_shadow', label: '写しなし' },
  { value: 'not_linked', label: '照合前' },
]

/** 医療の読む口を呼んだ回数（期間の切り替えで増えないことを確かめる） */
const medicalCalls = { n: 0 }

function PreviewGlance({ c, set, checkLine }: { c: Controls; set: (p: Partial<Controls>) => void; checkLine: ReactNode }) {
  const params = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const rid = Number(params.id ?? '1')
  const base = RESIDENTS.find((r) => r.id === rid) ?? RESIDENTS[0]
  const resident = c.medical === 'not_linked' ? { ...base, needs_review: true } : base
  const linkable = c.medical !== 'not_linked' && resident.source_id !== ''
  const [result, setResult] = useState<ResGlanceResult | null>(null)
  const [highlight, setHighlight] = useState<GlanceAnchor | null>(null)
  // 開いた時（方・モードが変わった時）に1回だけ読む。期間では読まない
  useEffect(() => {
    if (!linkable) {
      setResult(null)
      return
    }
    medicalCalls.n += 1
    setResult(fakeResGlance(c.medical))
  }, [rid, c.medical, linkable])
  const model = useMemo(
    () =>
      computeGlance({
        resident,
        today: TODAY,
        nowMs: NOW_MS,
        range: c.range,
        vitals: FX.vitals,
        meals: FX.meals,
        fluids: FX.fluids,
        outings: FX.outings,
        notes: FX.notes,
        meds: FX.meds,
        baths: [],
        incidents: FX.incidents,
        usualTemp: FX.usual.get(resident.id) ?? null,
        target: null,
        weights: FX.weights.get(resident.id) ?? null,
        excretion: { snap: FX.excretion, careLog: RESIDENTS },
      }),
    [resident, c.range],
  )
  const state: MedicalState = classifyMedicalState(resident, linkable ? result : null)
  const view = state === 'ok' && result?.kind === 'ok' ? normalizeMedicalRow(result.row) : null
  const onJump = useCallback((a: GlanceAnchor) => {
    document.getElementById(a)?.scrollIntoView({ block: 'start' })
    setHighlight(a)
  }, [])
  return (
    <GlanceView
      model={model}
      resident={resident}
      age={view?.age ?? null}
      asOf="10月29日（水） 10:00 時点（見本）"
      range={c.range}
      onRange={(v) => set({ range: v })}
      recentDays={rangeDays(c.range)}
      usualTemp={FX.usual.get(resident.id) ?? null}
      weightSource={FX.weights.has(resident.id) ? { status: 'ready' } : { status: 'unconfigured', message: '見本: 体重の記録なし' }}
      excretionSource={{ status: 'ready' }}
      medicalState={linkable && result === null ? 'loading' : state}
      medicalView={view}
      staleText={result?.kind === 'ok' ? medicalStaleText(result.syncedAt, NOW_MS) : null}
      role={c.role}
      highlight={highlight}
      onJump={onJump}
      toolbar={
        // 確かめの行も同じ段に置く（別の段にすると 1366×768 で下の区画が画面の外へ押し出される）
        <div className="flex flex-wrap items-end gap-gap lg:whitespace-nowrap">
          <button type="button" onClick={() => navigate('/glance')} className="inline-flex min-h-tap items-center text-base text-link">
            <span aria-hidden="true">‹ </span>見守りボード（見本）
          </button>
          <PreviewControls c={c} set={set} />
          {checkLine}
        </div>
      }
    />
  )
}

function PreviewControls({ c, set }: { c: Controls; set: (p: Partial<Controls>) => void }) {
  return (
    <>
      <div>
        <p className="text-xs text-ink2">役割（見本）</p>
        <SegmentPicker options={ROLE_OPTIONS} value={c.role} onChange={(v) => set({ role: v === 'admin' || v === 'office' ? v : 'field' })} ariaLabel="役割" />
      </div>
      <div>
        <p className="text-xs text-ink2">医療の欄（見本）</p>
        <SegmentPicker
          options={MEDICAL_OPTIONS}
          value={c.medical}
          onChange={(v) => set({ medical: v === 'no_function' || v === 'no_shadow' || v === 'not_linked' ? v : 'ok' })}
          ariaLabel="医療の欄の状態"
        />
      </div>
    </>
  )
}

function PreviewBoard({ c, set, checkLine }: { c: Controls; set: (p: Partial<Controls>) => void; checkLine: ReactNode }) {
  const navigate = useNavigate()
  const rows = useMemo(
    () =>
      buildBoardRows({
        residents: RESIDENTS,
        today: TODAY,
        nowMs: NOW_MS,
        vitals: FX.vitals,
        meals: FX.meals,
        fluids: FX.fluids,
        outings: FX.outings,
        notes: FX.notes,
        meds: FX.meds,
        incidents: FX.incidents,
        usualTemps: FX.usual,
        targets: new Map(),
        weights: FX.weights,
        excretion: FX.excretion,
      }),
    [],
  )
  const sorted = useMemo(() => sortBoardRows(rows, c.sort), [rows, c.sort])
  return (
    <div className="mx-auto w-full max-w-7xl p-4" data-preview-board="">
      <h1 className="text-xl font-heavy text-ink">見守りボード（見本・架空データ）</h1>
      {checkLine}
      <div className="mt-2 flex flex-wrap items-end gap-gap">
        <div>
          <p className="text-sm text-ink2">並び</p>
          <BoardSortToggle value={c.sort} onChange={(v) => set({ sort: v })} />
        </div>
      </div>
      <div className="mt-3">
        <BoardTable rows={sorted} tempDomain={boardTempDomain(rows)} onOpen={(id) => navigate(`/glance/${id}`)} />
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 確かめ（runCheck の8段・仮の合格ライン）
// ══════════════════════════════════════════════════════════════

interface CheckStep {
  n: number
  title: string
  ok: boolean
  detail: string
}

declare global {
  interface Window {
    __glanceCheck?: { done: boolean; ok: boolean; steps: CheckStep[] }
  }
}

const wait = () => new Promise<void>((r) => setTimeout(r, 30))
const q = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel))
/** 画面を移った後、その画面の目印が描かれるまで待つ（最大2秒。移る処理が後回しにされても先へ進まない） */
const waitFor = async (sel: string) => {
  for (let i = 0; i < 60 && q(sel).length === 0; i++) await wait()
}

/** 期間・並びを端末から読む（本物の GlancePage・GlanceBoardPage と同じ既知値照合。未知・読めない時は既定） */
function readStored(): Pick<Controls, 'range' | 'sort'> {
  try {
    return { range: parseGlanceRange(localStorage.getItem(GLANCE_RANGE_KEY)), sort: parseGlanceSort(localStorage.getItem(GLANCE_SORT_KEY)) }
  } catch {
    return { range: parseGlanceRange(null), sort: parseGlanceSort(null) }
  }
}

/** 期間・並びだけを端末に置く（既知値だけ。ほかの切り替え＝役割・医療の欄の状態は置かない） */
function storeControls(p: Partial<Controls>) {
  try {
    if (p.range !== undefined && parseGlanceRange(p.range) === p.range) localStorage.setItem(GLANCE_RANGE_KEY, p.range)
    if (p.sort !== undefined && parseGlanceSort(p.sort) === p.sort) localStorage.setItem(GLANCE_SORT_KEY, p.sort)
  } catch {
    // 置けなくても画面はそのまま動く（既定に戻るだけ）
  }
}

function App() {
  const [c, setC] = useState<Controls>(() => ({ role: 'field', medical: 'ok', ...readStored() }))
  const [steps, setSteps] = useState<CheckStep[] | null>(null)
  const navRef = useRef<((to: string) => void) | null>(null)
  const set = useCallback((p: Partial<Controls>) => {
    storeControls(p)
    setC((prev) => ({ ...prev, ...p }))
  }, [])
  const apply = (p: Partial<Controls>) => {
    storeControls(p)
    flushSync(() => setC((prev) => ({ ...prev, ...p })))
  }
  const go = (to: string) => flushSync(() => navRef.current?.(to))

  const runCheck = useCallback(async () => {
    const out: CheckStep[] = []
    const push = (title: string, ok: boolean, detail: string) => out.push({ n: out.length + 1, title, ok, detail })
    go('/glance/1')
    apply({ role: 'field', medical: 'ok', range: '7' })
    await waitFor('[data-glance-layout]')
    await wait()
    const keys = q('[data-sign-key]').map((e) => e.dataset.signKey ?? '')
    const tempLabel = q('[data-sign-key="temp"]')[0]?.textContent ?? ''
    push('兆しに「平熱+1.0℃以上」がある', keys.includes('temp') && tempLabel.includes('平熱+1.0'), tempLabel)
    const fluidLabel = q('[data-sign-key="fluid"]')[0]?.textContent ?? ''
    push(`兆しに「水分${Math.round(GLANCE_RULES.fluidRatio * 10)}割未満」がある`, keys.includes('fluid'), fluidLabel)
    const weightLabel = q('[data-sign-key="weight"]')[0]?.textContent ?? ''
    push('兆しに「体重1か月3%以上減」がある', keys.includes('weight') && weightLabel.includes('1か月'), weightLabel)
    const sev = q('[data-sign-key]').map((e) => (e.dataset.signSeverity === 'danger' ? 2 : 1))
    const ordered = sev.every((s, i) => i === 0 || sev[i - 1] >= s)
    push(`兆しは重い順・最大${GLANCE_RULES.signsMax}件`, sev.length > 0 && sev.length <= GLANCE_RULES.signsMax && ordered, `${sev.length}件`)
    // 医療の欄: 3つの役割で同じ中身・4つの状態の文言
    const seen: string[] = []
    let medOk = true
    for (const role of ['field', 'office', 'admin'] as const) {
      apply({ role, medical: 'ok' })
      await wait()
      const panel = q('[data-medical-state]')[0]
      const ok = panel?.dataset.medicalState === 'ok' && (panel.textContent ?? '').includes('架空病A') && (panel.textContent ?? '').includes('架空薬B錠')
      if (!ok) medOk = false
      seen.push(`${role}:${ok ? 'ok' : 'NG'}`)
    }
    for (const m of ['no_function', 'no_shadow', 'not_linked'] as const) {
      apply({ medical: m })
      await wait()
      const panel = q('[data-medical-state]')[0]
      const ok = panel?.dataset.medicalState === m && (panel.textContent ?? '').includes(MEDICAL_STATE_MESSAGE[m])
      if (!ok) medOk = false
      seen.push(`${m}:${ok ? 'ok' : `NG(${panel?.dataset.medicalState ?? '?'})`}`)
    }
    push('医療の欄: どの役割にも出る・4つの状態の文言', medOk, seen.join(' '))
    apply({ medical: 'ok', range: '7' })
    await wait()
    const before = medicalCalls.n
    apply({ range: '14' })
    await wait()
    const head14 = (document.getElementById('glance-vitals')?.textContent ?? '').includes('直近14日')
    apply({ range: '7' })
    await wait()
    push('期間の切り替えで医療の欄を読み直さない', medicalCalls.n === before && head14, `読んだ回数 ${before}→${medicalCalls.n}`)
    // 見守りボード
    go('/glance')
    apply({ sort: 'room' })
    await waitFor('[data-preview-board] tbody tr')
    await wait()
    const trs = q('[data-preview-board] tbody tr')
    const roomsOf = () => q('[data-preview-board] tbody tr th > span > span:first-child').map((e) => e.textContent ?? '')
    const roomOrder = roomsOf()
    const awayRow = trs.find((tr) => (tr.textContent ?? '').includes('入院中'))
    const unavailable = trs.filter((tr) => (tr.textContent ?? '').includes('—（カルテで確認）')).length
    apply({ sort: 'changes' })
    await wait()
    const changedOrder = roomsOf()
    apply({ sort: 'room' })
    await wait()
    push(
      '見守りボード: 16名・入院中は数えない・未接続は「—（カルテで確認）」・変化の多い順',
      trs.length === RESIDENTS.length && !!awayRow && (awayRow.textContent ?? '').includes('数えない') && unavailable >= 1 && changedOrder.join() !== roomOrder.join(),
      `${trs.length}行・未接続 ${unavailable}行・変化の多い順の先頭 ${changedOrder.slice(0, 3).join('・')}`,
    )
    // 1366×768 で縦に動かない（ひと目ボード）
    go('/glance/1')
    await waitFor('[data-glance-layout]')
    await wait()
    const se = document.scrollingElement ?? document.documentElement
    // 画面全体が縦に動かず、どの区画も見出しまで画面の中に出ている（列の外へ押し出された区画が無い）
    const sectionIds = ['glance-signs-h', 'glance-vitals', 'glance-board', 'glance-intake', 'glance-medical', 'glance-changes']
    const shown = sectionIds.map((sid) => {
      const el = document.getElementById(sid)
      const h = el?.querySelector('h2') ?? el
      const r = h?.getBoundingClientRect()
      return { sid, ok: !!r && r.top >= 0 && r.bottom <= window.innerHeight }
    })
    const fits = window.innerWidth < 1024 || (se.scrollHeight <= window.innerHeight + 1 && shown.every((x) => x.ok))
    const layoutH = q('[data-glance-layout]')[0]?.offsetHeight ?? 0
    const hidden = shown.filter((x) => !x.ok).map((x) => x.sid)
    push(
      'ひと目ボードは画面全体が縦に動かず、どの区画も見出しが画面の中に出る（幅1024以上）',
      fits,
      `${window.innerWidth}×${window.innerHeight}・全体の高さ ${se.scrollHeight}・ボード ${layoutH}・画面の外 ${hidden.length === 0 ? 'なし' : hidden.join('・')}`,
    )
    const all = out.every((s) => s.ok)
    window.__glanceCheck = { done: true, ok: all, steps: out }
    setSteps(out)
  }, [])

  // 自動の確かめは1回だけ（開発時の二重実行で2本が並んで走り、互いの切り替えを踏まないように）
  const autoRan = useRef(false)
  useEffect(() => {
    if (autoRan.current) return
    if (new URLSearchParams(window.location.search).get('check') !== '1') return
    // 描画の途中（effect の中）で flushSync を呼ばないよう、次の順番に回してから走らせる。
    // 開発時の二重実行で片付けられた方は走らないので、走った時に印を付ける
    const t = setTimeout(() => {
      if (autoRan.current) return
      autoRan.current = true
      void runCheck()
    }, 0)
    return () => clearTimeout(t)
  }, [runCheck])

  const checkLine = (
    <div className="flex flex-wrap items-center gap-gap text-sm" data-check-all={steps === null ? '' : steps.every((s) => s.ok) ? 'ok' : 'ng'}>
      <button type="button" onClick={() => void runCheck()} className="inline-flex min-h-tap items-center rounded border border-border-strong bg-surface px-3 text-sm text-ink">
        確かめる（8段）
      </button>
      {steps === null ? null : (
        <ol className="flex flex-wrap gap-x-3" aria-label="確かめの結果">
          {steps.map((s) => (
            <li key={s.n} data-check-step={s.n} data-check-ok={s.ok ? 'ok' : 'ng'} title={`${s.title}（${s.detail}）`} className={s.ok ? 'text-ok' : 'font-bold text-danger'}>
              {s.n}
              {s.ok ? '✓' : '✗'}
              <span className="sr-only">
                {s.title} {s.detail}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )

  const initial = window.location.hash === '#board' ? '/glance' : '/glance/1'
  return (
    <MemoryRouter initialEntries={[initial]}>
      <NavBridge navRef={navRef} />
      <PreviewShell>
        <Routes>
          <Route path="/glance" element={<PreviewBoard c={c} set={set} checkLine={checkLine} />} />
          <Route path="/glance/:id" element={<PreviewGlance c={c} set={set} checkLine={checkLine} />} />
        </Routes>
      </PreviewShell>
    </MemoryRouter>
  )
}

/** 本番の App の殻（src/App.tsx の sticky の header と main の余白）を同じ class で模した囲い。
 *  8段目「画面全体が縦に動かない」を本番と同じ上下の余白の中で測るため */
function PreviewShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-ink lg:pl-24">
      <header className="sticky top-0 z-20 border-b border-border bg-surface">
        <div className="flex min-h-tap flex-wrap items-center gap-gap px-4 py-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
            <h1 className="min-w-tap truncate text-lg font-bold">見本（App の殻を模した見出し）</h1>
          </div>
        </div>
      </header>
      <main className="px-4 pb-24 pt-4 lg:pb-8">{children}</main>
    </div>
  )
}

/** 確かめの段から見本の中の画面を移るための橋（ルーターの外から navigate を呼ぶ） */
function NavBridge({ navRef }: { navRef: { current: ((to: string) => void) | null } }) {
  const navigate = useNavigate()
  navRef.current = (to: string) => navigate(to)
  return null
}

// ?mode=dark／?mode=light で配色を切り替えて見る（html の data-mode。端末には保存しない）
const modeParam = new URLSearchParams(window.location.search).get('mode')
if (modeParam === 'dark' || modeParam === 'light') document.documentElement.dataset.mode = modeParam

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
