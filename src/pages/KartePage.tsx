// 利用者一覧（/karte）と個人カルテ（/karte/:id）。
// 契約: docs/design/contracts.md（ルーティング・db.ts API・共通部品） ／ 詳細: docs/design/ui-design.md §5
//
// この画面は読み取り専用（書き込み経路を持たない＝multi-device-sync 原則9「読み取りで書かない」。
// 既読付与も行わない＝表示だけで note_reads を作らない）。
// - 取得は db.ts の fetchResidents / fetchStaff / fetchKarte のみ（supabase 直呼びなし・期間指定必須）
// - localStorage に保存するのは期間セグメント（cl_karteRange）だけ。氏名・記録本文は保存しない
// - Tailwind はトークン由来クラスのみ。色・px の直書きと arbitrary value は書かない
// - console 出力を持たない（個人情報の漏出経路を作らない）

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { fetchKarte, fetchResidents, fetchStaff } from '../lib/db'
import { addDays, fmtDayLabel, fmtTimeHM, isoDate, todayIso } from '../lib/format'
import {
  Chip,
  EmptyBlock,
  ErrorBlock,
  LevelCell,
  LoadingBlock,
  SectionCard,
  SegmentPicker,
} from '../components/ui'
import {
  IMPORTANCE_LABEL,
  LEVEL_MARK,
  LS,
  MEAL_STATUS_LABEL,
  OUTING_KIND_LABEL,
  SHIFT_LABEL,
  diaBpLevel,
  isLowIntake,
  pulseLevel,
  spo2Level,
  sysBpLevel,
  tempLevel,
} from '../lib/types'
import type {
  FluidIntake,
  Level,
  Meal,
  MealSlot,
  Note,
  Outing,
  Resident,
  Staff,
  Vital,
  VitalKind,
} from '../lib/types'

// ══════════════════════════════════════════════════════════════
// 定数
// ══════════════════════════════════════════════════════════════

/** 期間セグメント（ui-design.md §5・既定2週）。復元は既知値の完全一致照合のみ */
const RANGE_VALUES = ['14d', '1m', '3m', '6m', '1y'] as const
type RangeKey = (typeof RANGE_VALUES)[number]

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: '14d', label: '2週' },
  { value: '1m', label: '1か月' },
  { value: '3m', label: '3か月' },
  { value: '6m', label: '6か月' },
  { value: '1y', label: '1年' },
]

const RANGE_MONTHS: Record<Exclude<RangeKey, '14d'>, number> = {
  '1m': 1,
  '3m': 3,
  '6m': 6,
  '1y': 12,
}

const DEFAULT_RANGE: RangeKey = '14d'

/** 日付展開の安全上限（壊れた値で無限ループしないための歯止め。1年=366日を超える余裕を持たせる） */
const DAY_CAP = 400

// グラフの寸法（CSS px と 1:1 の viewBox で描くため、44px ヒット領域が実寸になる）
const CHART_H = 160
const PAD_L = 48
const PAD_R = 12
const PAD_T = 12
const PAD_B = 22
const CHART_MIN_W = 240
const CHART_DEFAULT_W = 640
const POINT_R = 3
const POINT_R_ALERT = 4.5
/** データ点のタップ判定の目安幅（HIG 44px）。点が密なときは縦いっぱい（グラフ高さ全体）で補う */
const HIT_MIN_W = 44
/** 記号（↑↑等）を点の脇に描く最小の点間隔。これ未満は密集して読めないため描かない（表で補う） */
const MARK_MIN_GAP = 14

const ERR_RESIDENTS =
  '利用者の一覧を読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'
const ERR_KARTE =
  'カルテを読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'

// ══════════════════════════════════════════════════════════════
// 純ロジック（副作用なし）
// ══════════════════════════════════════════════════════════════

/** 受信データを信じない: 配列でなければ空配列に倒す */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

/** 絞込用キー: カタカナ→ひらがな・英字は小文字・空白除去で部分一致させる */
function kanaKey(s: string): string {
  return s
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 月単位の加減算。月末日は移動先の月の末日に丸める（3/31 の1か月前は 2/28） */
function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso
  const first = new Date(y, m - 1 + n, 1)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return isoDate(new Date(first.getFullYear(), first.getMonth(), Math.min(d, last)))
}

/** 期間セグメントの開始日（終了日は当日） */
export function rangeFromIso(range: RangeKey, toIso: string): string {
  if (range === '14d') return addDays(toIso, -13)
  return addDays(addMonths(toIso, -RANGE_MONTHS[range]), 1)
}

/** [fromIso, toIso] の全日付（古い順） */
function daysAscending(fromIso: string, toIso: string): string[] {
  if (!fromIso || !toIso || fromIso > toIso) return []
  const out: string[] = []
  let cur = fromIso
  for (let i = 0; i < DAY_CAP && cur <= toIso; i++) {
    out.push(cur)
    cur = addDays(cur, 1)
  }
  return out
}

/** 居室から階を推定する（居室 '102' → 1階）。判定できなければ null＝表示しない */
function floorOf(room: string | null): number | null {
  if (!room) return null
  const m = /(\d)\d{2}/.exec(room)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= 9 ? n : null
}

/** 本人の記録だけを残す（fetchKarte は本人分を返す契約だが、取り違え防止に受信側でも照合する） */
function ownedBy<T extends { resident_id: number }>(rows: unknown, residentId: number): T[] {
  return asArray<T>(rows).filter((r) => r != null && r.resident_id === residentId)
}

const KIND_ORDER: Record<VitalKind, number> = { routine: 0, recheck: 1, observation: 2 }

/** 時刻（HH:MM[:SS]）の昇順比較。null は末尾 */
function cmpTime(a: string | null, b: string | null): number {
  const x = a ?? '99:99:99'
  const y = b ?? '99:99:99'
  return x < y ? -1 : x > y ? 1 : 0
}

function cmpVitalAsc(a: Vital, b: Vital): number {
  return (
    (a.measured_on < b.measured_on ? -1 : a.measured_on > b.measured_on ? 1 : 0) ||
    (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
    cmpTime(a.measured_at, b.measured_at) ||
    a.id - b.id
  )
}

type VitalField = 'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2'

/**
 * 1日1点の系列を作る（同じ日に複数回の記録がある場合は 定時→再検→経過観察 の順で最初の実測値を採る）。
 * 値が無い日はキーを作らない＝欠測として線を切るため。
 */
function dailySeries(sortedVitals: Vital[], field: VitalField): Map<string, number> {
  const out = new Map<string, number>()
  for (const v of sortedVitals) {
    if (out.has(v.measured_on)) continue
    const n = v[field]
    if (typeof n === 'number' && Number.isFinite(n)) out.set(v.measured_on, n)
  }
  return out
}

/** 欠測で切れた線分の配列（各線分は連続する日の点だけを持つ） */
function lineSegments(days: string[], values: Map<string, number>): { i: number; v: number }[][] {
  const out: { i: number; v: number }[][] = []
  let cur: { i: number; v: number }[] = []
  days.forEach((d, i) => {
    const v = values.get(d)
    if (v == null) {
      if (cur.length > 0) out.push(cur)
      cur = []
      return
    }
    cur.push({ i, v })
  })
  if (cur.length > 0) out.push(cur)
  return out
}

function fmtNum(v: number, digits: number): string {
  return v.toFixed(digits)
}

/** 外出・外泊がその日にかかっているか（帰着未定＝end_on null は開始日以降ずっと継続中とみなす） */
function outingCoversDay(o: Outing, day: string): boolean {
  if (typeof o.start_on !== 'string' || o.start_on > day) return false
  if (o.end_on == null) return true
  return day <= o.end_on
}

// ══════════════════════════════════════════════════════════════
// localStorage（UI状態のみ・原則11）
// ══════════════════════════════════════════════════════════════

function readRange(): RangeKey {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_RANGE
    const v = localStorage.getItem(LS.karteRange)
    if (v != null && (RANGE_VALUES as readonly string[]).includes(v)) return v as RangeKey
  } catch {
    // 読めない環境（プライベートモード等）では既定へフォールバックする
  }
  return DEFAULT_RANGE
}

function writeRange(v: RangeKey): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS.karteRange, v)
  } catch {
    // 保存できなくても表示は成立させる
  }
}

// ══════════════════════════════════════════════════════════════
// 利用者スナップショット（一覧・カルテ共通）
// ══════════════════════════════════════════════════════════════

interface ResidentsState {
  residents: Resident[]
  loading: boolean
  error: string | null
  reload(): void
}

function useResidents(provided?: Resident[]): ResidentsState {
  const [residents, setResidents] = useState<Resident[]>(provided ?? [])
  const [loading, setLoading] = useState(!provided)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (provided) {
      setResidents(provided)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchResidents()
      .then((rows) => {
        if (cancelled || !aliveRef.current) return
        setResidents(asArray<Resident>(rows).filter((r) => r != null && typeof r.id === 'number'))
        setError(null)
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        // 失敗時は取得済みの表示を消さない（原則4: 安全側フォールバック）
        setError(ERR_RESIDENTS)
      })
      .finally(() => {
        if (cancelled || !aliveRef.current) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [provided, tick])

  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { residents, loading, error, reload }
}

// ══════════════════════════════════════════════════════════════
// 利用者一覧（/karte）
// ══════════════════════════════════════════════════════════════

interface ResidentListProps {
  state: ResidentsState
}

function ResidentList({ state }: ResidentListProps) {
  const { residents, loading, error, reload } = state
  const [q, setQ] = useState('')
  const fieldId = useId()

  // 居室昇順（fetchResidents の並びを尊重しつつ、欠損は末尾に寄せる）
  const ordered = useMemo(() => {
    return residents.slice().sort((a, b) => {
      const ra = a.room ?? ''
      const rb = b.room ?? ''
      if (ra === rb) return a.id - b.id
      if (ra === '') return 1
      if (rb === '') return -1
      return ra < rb ? -1 : 1
    })
  }, [residents])

  const list = useMemo(() => {
    const key = kanaKey(q)
    if (!key) return ordered
    return ordered.filter((r) =>
      [r.name, r.kana ?? '', r.room ?? ''].some((f) => kanaKey(f).includes(key)),
    )
  }, [ordered, q])

  return (
    <div className="mx-auto w-full max-w-2xl p-4">
      <h1 className="text-xl font-heavy text-ink">カルテ（利用者一覧）</h1>
      <p className="mt-1 text-sm text-ink2">
        利用者を選ぶと、その方のバイタル・食事水分・申し送りをまとめて表示します。
      </p>

      <div className="mt-3">
        <label htmlFor={fieldId} className="block text-sm text-ink2">
          絞り込み（氏名・かな・居室）
        </label>
        <input
          id={fieldId}
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
          placeholder="氏名の一部を入力"
          className="mt-1 min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink"
        />
      </div>

      <div className="mt-3">
        {loading && residents.length === 0 ? (
          <LoadingBlock label="利用者の一覧を読み込み中です…" />
        ) : error && residents.length === 0 ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : residents.length === 0 ? (
          <EmptyBlock message="利用者の一覧がまだありません。設定タブでマスタ同期を実行してください。" />
        ) : list.length === 0 ? (
          <EmptyBlock
            message="該当する利用者がいません。入力した文字を減らしてお試しください。"
            actionLabel="絞り込みを消す"
            onAction={() => setQ('')}
          />
        ) : (
          <>
            {error ? (
              <p className="mb-2 text-sm text-warn">
                <span aria-hidden="true">▲ </span>
                最新の一覧を取得できませんでした。表示は前回取得した内容です。
              </p>
            ) : null}
            <p className="mb-2 text-sm text-ink2">
              <span className="tabular">{list.length}</span> 名
            </p>
            <ul className="space-y-2">
              {list.map((r) => (
                <li key={r.id}>
                  <Link
                    to={`/karte/${r.id}`}
                    className="flex min-h-tap w-full items-center gap-gap rounded border border-border bg-surface px-3 py-2 text-base text-ink"
                  >
                    <span className="tabular w-14 shrink-0 text-sm text-ink3">{r.room ?? '—'}</span>
                    <span className="flex-1 truncate font-bold">{r.name}</span>
                    {r.needs_review ? (
                      <span className="shrink-0 text-sm text-warn">
                        <span aria-hidden="true">▲</span>
                        <span className="sr-only">要確認</span>
                      </span>
                    ) : null}
                    <span aria-hidden="true" className="shrink-0 text-ink3">
                      ›
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// バイタル折れ線（自前SVG・外部チャートライブラリ不使用）
// ══════════════════════════════════════════════════════════════

const LEVEL_POINT_FILL: Record<Exclude<Level, null>, string> = {
  'danger-high': 'fill-danger',
  'warn-high': 'fill-warn',
  'warn-low': 'fill-warn',
  'danger-low': 'fill-info',
}

interface SeriesSpec {
  label: string
  values: Map<string, number>
  /** 線・点の色 */
  strokeClass: string
  fillClass: string
  /** 2本目の系列は破線にして色以外でも区別できるようにする */
  dashed?: boolean
  level(v: number | null): Level
}

interface BandSpec {
  /** 帯の下端・上端（値） */
  lo: number
  hi: number
  className: string
  /** 帯端に置くしきい値の数値ラベル（色だけに頼らないための併記） */
  label: string
  labelAt: number
}

interface RefLineSpec {
  y: number
  label: string
  className: string
}

interface PanelSpec {
  key: string
  title: string
  unit: string
  digits: number
  /** 基準の表示範囲。実データがはみ出す場合は広げる */
  base: [number, number]
  series: SeriesSpec[]
  bands: BandSpec[]
  refs: RefLineSpec[]
  legend?: string
}

/** コンテナ幅を実測する（viewBox を CSS px と 1:1 にしてヒット領域を実寸にするため） */
function useElementWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(CHART_DEFAULT_W)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const w = Math.round(el.getBoundingClientRect().width)
      setWidth(Math.max(CHART_MIN_W, w || CHART_DEFAULT_W))
    }
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, width }
}

interface VitalChartProps {
  panel: PanelSpec
  days: string[]
  width: number
}

function VitalChart({ panel, days, width }: VitalChartProps) {
  const [selected, setSelected] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // 期間や指標が変わったら選択を解除する（別の日の値を指したままにしない）
  useEffect(() => {
    setSelected(null)
  }, [panel.key, days.length])

  const plotW = Math.max(1, width - PAD_L - PAD_R)
  const plotH = CHART_H - PAD_T - PAD_B
  const n = days.length

  const domain = useMemo<[number, number]>(() => {
    let lo = panel.base[0]
    let hi = panel.base[1]
    for (const s of panel.series) {
      for (const v of s.values.values()) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    for (const b of panel.bands) {
      if (b.labelAt < lo) lo = b.labelAt
      if (b.labelAt > hi) hi = b.labelAt
    }
    for (const r of panel.refs) {
      if (r.y < lo) lo = r.y
      if (r.y > hi) hi = r.y
    }
    const margin = (hi - lo) * 0.08 || 1
    return [lo - margin, hi + margin]
  }, [panel])

  const x = useCallback(
    (i: number) => (n <= 1 ? PAD_L + plotW / 2 : PAD_L + (i * plotW) / (n - 1)),
    [n, plotW],
  )
  const y = useCallback(
    (v: number) => {
      const span = domain[1] - domain[0] || 1
      const raw = PAD_T + (1 - (v - domain[0]) / span) * plotH
      return Math.min(PAD_T + plotH, Math.max(PAD_T, raw))
    },
    [domain, plotH],
  )

  /** 記録がある日（タップで選べる日＝pickNearest の候補） */
  const filledIdx = useMemo(() => {
    const out: number[] = []
    days.forEach((d, i) => {
      if (panel.series.some((s) => s.values.has(d))) out.push(i)
    })
    return out
  }, [days, panel])

  const gap = n <= 1 ? plotW : plotW / (n - 1)
  const showMarks = gap >= MARK_MIN_GAP

  /**
   * タップ位置にいちばん近いデータ点を選ぶ。
   * 判定域は「点から左右44px以内（HIG のタップ領域）かつ隣の点との中間まで」。
   * 点が密な期間（3か月以上）は点の間隔自体が44px未満になるため、隣の点との中間が上限になる
   * （近い方を必ず選ぶ＝取り違えを防ぐ。細かい値の読み取りは下の数値表で行う）。
   * どの点からも44pxより遠い位置のタップでは選択を変えない。
   */
  const pickNearest = useCallback(
    (clientX: number) => {
      const el = svgRef.current
      if (!el || filledIdx.length === 0) return
      const box = el.getBoundingClientRect()
      // ブラウザのズーム等で表示倍率が変わっても viewBox 座標に合わせ直す
      const scale = box.width > 0 ? width / box.width : 1
      const px = (clientX - box.left) * scale
      let best: number | null = null
      let bestDist = Infinity
      for (const i of filledIdx) {
        const d = Math.abs(x(i) - px)
        if (d < bestDist) {
          bestDist = d
          best = i
        }
      }
      if (best == null || bestDist > HIT_MIN_W) return
      setSelected((prev) => (prev === best ? null : best))
    },
    [filledIdx, width, x],
  )

  const readout = useMemo(() => {
    if (selected == null || days[selected] == null) {
      return 'グラフの点をタップすると、その日の値を表示します。'
    }
    const day = days[selected]
    const parts = panel.series.map((s) => {
      const v = s.values.get(day)
      if (v == null) return `${s.label} —（未測定）`
      const lv = s.level(v)
      return `${s.label} ${fmtNum(v, panel.digits)}${panel.unit}${lv ? ` ${LEVEL_MARK[lv]}` : ''}`
    })
    return `${fmtDayLabel(day)}　${parts.join('　')}`
  }, [selected, days, panel])

  const ariaLabel = useMemo(() => {
    const head = `${panel.title}の推移。${days.length > 0 ? `${fmtDayLabel(days[0])}から${fmtDayLabel(days[days.length - 1])}まで` : '期間なし'}。`
    const body = panel.series
      .map((s) => {
        const vals = Array.from(s.values.values())
        if (vals.length === 0) return `${s.label}は記録がありません。`
        const max = Math.max(...vals)
        const min = Math.min(...vals)
        const alerts = vals.filter((v) => s.level(v) != null).length
        return `${s.label}は記録${vals.length}件、最高${fmtNum(max, panel.digits)}${panel.unit}、最低${fmtNum(min, panel.digits)}${panel.unit}、しきい値を外れた記録${alerts}件。`
      })
      .join('')
    return `${head}${body}詳しい数値はこの下の「数値の表を開く」で確認できます。`
  }, [panel, days])

  return (
    <div>
      <svg
        ref={svgRef}
        role="img"
        aria-label={ariaLabel}
        width={width}
        height={CHART_H}
        viewBox={`0 0 ${width} ${CHART_H}`}
        className="block"
        onClick={(e) => pickNearest(e.clientX)}
      >
        {/* しきい値帯（半透明の面）＋帯端の数値ラベル */}
        {panel.bands.map((b) => {
          const yTop = y(Math.max(b.hi, b.lo))
          const yBottom = y(Math.min(b.hi, b.lo))
          const h = Math.max(0, yBottom - yTop)
          if (h <= 0) return null
          return (
            <g key={`band-${b.label}`}>
              <rect x={PAD_L} y={yTop} width={plotW} height={h} className={b.className} />
              <text
                x={PAD_L - 4}
                y={y(b.labelAt) + 4}
                textAnchor="end"
                className="text-2xs fill-ink2"
              >
                {b.label}
              </text>
            </g>
          )
        })}

        {/* しきい値の基準線（帯にすると別系列の正常値まで塗ってしまう指標に使う） */}
        {panel.refs.map((r) => (
          <g key={`ref-${r.label}`}>
            <line
              x1={PAD_L}
              x2={PAD_L + plotW}
              y1={y(r.y)}
              y2={y(r.y)}
              strokeDasharray="4 3"
              className={`stroke-1 ${r.className}`}
            />
            <text x={PAD_L - 4} y={y(r.y) + 4} textAnchor="end" className="text-2xs fill-ink2">
              {r.label}
            </text>
          </g>
        ))}

        {/* 外枠（下辺・左辺） */}
        <line
          x1={PAD_L}
          x2={PAD_L + plotW}
          y1={PAD_T + plotH}
          y2={PAD_T + plotH}
          className="stroke-1 stroke-border"
        />
        <line
          x1={PAD_L}
          x2={PAD_L}
          y1={PAD_T}
          y2={PAD_T + plotH}
          className="stroke-1 stroke-border"
        />

        {/* 選択中の日を示す縦線 */}
        {selected != null ? (
          <line
            x1={x(selected)}
            x2={x(selected)}
            y1={PAD_T}
            y2={PAD_T + plotH}
            className="stroke-1 stroke-border-strong"
          />
        ) : null}

        {/* 折れ線（欠測日で線を切る＝補間しない） */}
        {panel.series.map((s) =>
          lineSegments(days, s.values).map((seg, si) => (
            <polyline
              key={`${s.label}-seg-${si}`}
              points={seg.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')}
              fill="none"
              strokeDasharray={s.dashed ? '5 4' : undefined}
              className={`stroke-2 ${s.strokeClass}`}
            />
          )),
        )}

        {/* データ点（しきい値超過は大きめの点＋記号を併記＝色だけに頼らない） */}
        {panel.series.map((s) =>
          days.map((d, i) => {
            const v = s.values.get(d)
            if (v == null) return null
            const lv = s.level(v)
            return (
              <g key={`${s.label}-pt-${d}`}>
                <circle
                  cx={x(i)}
                  cy={y(v)}
                  r={lv || selected === i ? POINT_R_ALERT : POINT_R}
                  className={lv ? LEVEL_POINT_FILL[lv] : s.fillClass}
                />
                {lv && showMarks ? (
                  <text
                    x={x(i)}
                    y={y(v) - 7}
                    textAnchor="middle"
                    className={`text-2xs ${lv === 'danger-low' ? 'fill-info' : lv === 'danger-high' ? 'fill-danger' : 'fill-warn'}`}
                  >
                    {LEVEL_MARK[lv]}
                  </text>
                ) : null}
              </g>
            )
          }),
        )}

        {/* 期間の両端の日付 */}
        {days.length > 0 ? (
          <>
            <text x={PAD_L} y={CHART_H - 6} textAnchor="start" className="text-2xs fill-ink3">
              {fmtDayLabel(days[0])}
            </text>
            <text
              x={PAD_L + plotW}
              y={CHART_H - 6}
              textAnchor="end"
              className="text-2xs fill-ink3"
            >
              {fmtDayLabel(days[days.length - 1])}
            </text>
          </>
        ) : null}

        {/* タップ判定の受け皿（グラフ全面。押した位置から最も近いデータ点を選ぶ＝pickNearest）。
            日ごとに矩形を置くと期間が長いとき判定域が重なって隣の日を選んでしまうため、面で受ける */}
        <rect
          x={PAD_L}
          y={PAD_T}
          width={plotW}
          height={plotH}
          className="fill-transparent"
        />
      </svg>

      {/* タップした点の値（SVG 内の浮動ボックスにしないのは、文字サイズ200%でも崩れないようにするため） */}
      <p role="status" aria-live="polite" className="tabular mt-1 min-h-tap text-sm text-ink2">
        {readout}
      </p>
    </div>
  )
}

interface VitalPanelProps {
  panel: PanelSpec
  days: string[]
  width: number
}

/** 1指標のパネル（見出し＋グラフ＋数値表フォールバック） */
function VitalPanel({ panel, days, width }: VitalPanelProps) {
  // 表は開いたときに組み立てる（1年表示×4パネルで数千ノードになるのを避ける）
  const [tableOpen, setTableOpen] = useState(false)
  const rows = useMemo(
    () => days.filter((d) => panel.series.some((s) => s.values.has(d))).reverse(),
    [days, panel],
  )

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="flex flex-wrap items-baseline gap-gap">
        <h3 className="text-lg font-bold text-ink">{panel.title}</h3>
        <span className="text-sm text-ink2">単位 {panel.unit}</span>
        {panel.legend ? <span className="text-sm text-ink2">{panel.legend}</span> : null}
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-base text-ink2">
          <span aria-hidden="true">— </span>
          この期間の記録はありません。
        </p>
      ) : (
        <>
          <VitalChart panel={panel} days={days} width={width} />
          <details
            className="mt-2"
            onToggle={(e) => setTableOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="inline-flex min-h-tap items-center text-base text-link">
              数値の表を開く（<span className="tabular">{rows.length}</span>日分）
            </summary>
            <div className="mt-2 overflow-x-auto">
              {tableOpen ? (
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">
                    {panel.title}の記録（新しい日が上。同じ日に複数回の記録がある場合は定時測定を優先）
                  </caption>
                  <thead>
                    <tr className="border-b border-border-strong text-ink2">
                      <th scope="col" className="py-2 pr-2 text-left font-bold">
                        日付
                      </th>
                      {panel.series.map((s) => (
                        <th key={s.label} scope="col" className="py-2 pr-2 text-right font-bold">
                          {s.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((d) => (
                      <tr key={d} className="border-b border-border">
                        <th scope="row" className="py-2 pr-2 text-left font-normal text-ink">
                          {fmtDayLabel(d)}
                        </th>
                        {panel.series.map((s) => {
                          const v = s.values.get(d) ?? null
                          return (
                            <td key={s.label} className="py-2 pr-2 text-right">
                              <LevelCell value={v} level={s.level(v)} digits={panel.digits} />
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          </details>
        </>
      )}
    </div>
  )
}

interface VitalsSectionProps {
  vitals: Vital[]
  days: string[]
}

function VitalsSection({ vitals, days }: VitalsSectionProps) {
  const { ref, width } = useElementWidth()

  const panels = useMemo<PanelSpec[]>(() => {
    const sorted = vitals.slice().sort(cmpVitalAsc)
    const temp = dailySeries(sorted, 'temp')
    const sys = dailySeries(sorted, 'sys_bp')
    const dia = dailySeries(sorted, 'dia_bp')
    const pulse = dailySeries(sorted, 'pulse')
    const spo2 = dailySeries(sorted, 'spo2')
    return [
      {
        key: 'temp',
        title: '体温',
        unit: '℃',
        digits: 1,
        base: [35, 39],
        series: [
          {
            label: '体温',
            values: temp,
            strokeClass: 'stroke-primary',
            fillClass: 'fill-primary',
            level: tempLevel,
          },
        ],
        bands: [
          { lo: 38.1, hi: 45, className: 'fill-danger-bg', label: '38.1', labelAt: 38.1 },
          { lo: 37.5, hi: 38.1, className: 'fill-warn-bg', label: '37.5', labelAt: 37.5 },
          { lo: 30, hi: 35.5, className: 'fill-info-bg', label: '35.5', labelAt: 35.5 },
        ],
        refs: [],
      },
      {
        key: 'bp',
        title: '血圧',
        unit: 'mmHg',
        digits: 0,
        base: [40, 180],
        // 上下2線が同じ目盛りを共有するため、下の正常値まで塗ってしまう帯は使わず基準線にする。
        // 面で示すのは「上151以上＝どちらの系列でも危険高値」の領域だけ。
        series: [
          {
            label: '上（収縮期）',
            values: sys,
            strokeClass: 'stroke-primary',
            fillClass: 'fill-primary',
            level: sysBpLevel,
          },
          {
            label: '下（拡張期）',
            values: dia,
            strokeClass: 'stroke-link',
            fillClass: 'fill-link',
            dashed: true,
            level: diaBpLevel,
          },
        ],
        bands: [{ lo: 151, hi: 300, className: 'fill-danger-bg', label: '上151', labelAt: 151 }],
        refs: [
          { y: 91, label: '下91', className: 'stroke-danger' },
          { y: 90, label: '上90', className: 'stroke-warn' },
          { y: 50, label: '下50', className: 'stroke-warn' },
        ],
        legend: '実線=上（収縮期）／破線=下（拡張期）',
      },
      {
        key: 'pulse',
        title: '脈拍',
        unit: '回/分',
        digits: 0,
        base: [40, 120],
        series: [
          {
            label: '脈拍',
            values: pulse,
            strokeClass: 'stroke-primary',
            fillClass: 'fill-primary',
            level: pulseLevel,
          },
        ],
        bands: [
          { lo: 101, hi: 250, className: 'fill-danger-bg', label: '101', labelAt: 101 },
          { lo: 20, hi: 40, className: 'fill-warn-bg', label: '40', labelAt: 40 },
        ],
        refs: [],
      },
      {
        key: 'spo2',
        title: 'SpO2（経皮的動脈血酸素飽和度）',
        unit: '%',
        digits: 0,
        base: [88, 100],
        series: [
          {
            label: 'SpO2',
            values: spo2,
            strokeClass: 'stroke-primary',
            fillClass: 'fill-primary',
            level: spo2Level,
          },
        ],
        bands: [
          { lo: 50, hi: 90, className: 'fill-info-bg', label: '90', labelAt: 90 },
          { lo: 90, hi: 93, className: 'fill-warn-bg', label: '93', labelAt: 93 },
        ],
        refs: [],
      },
    ]
  }, [vitals])

  const hasAny = vitals.length > 0

  return (
    <SectionCard title="バイタルの推移" className="mt-4">
      <p className="text-sm text-ink2">
        しきい値の帯・基準線は数値を併記しています。記録がない日は線を切って表示します（間を結びません）。
        同じ日に複数回の記録がある場合は定時測定を優先して1日1点で表示します。
      </p>
      <div ref={ref}>
        {!hasAny ? (
          <div className="mt-3">
            <EmptyBlock message="この期間のバイタル記録はありません。期間を広げてお試しください。" />
          </div>
        ) : (
          panels.map((p) => <VitalPanel key={p.key} panel={p} days={days} width={width} />)
        )}
      </div>
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// 食事・水分の履歴表
// ══════════════════════════════════════════════════════════════

const TABLE_SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner']
const SLOT_HEAD: Record<MealSlot, string> = { breakfast: '朝', lunch: '昼', dinner: '夕', snack: '間食' }

interface MealCellProps {
  meal: Meal | undefined
}

function MealCell({ meal }: MealCellProps) {
  if (!meal) {
    return (
      <>
        <span className="sr-only">記録なし</span>
        <span aria-hidden="true" className="text-ink3">
          —
        </span>
      </>
    )
  }
  if (meal.status && meal.status !== 'eaten') {
    // 欠食（外出・入院・拒食）は文字で示す（色だけに頼らない）
    return <span className="text-ink2">{MEAL_STATUS_LABEL[meal.status]}</span>
  }
  const main = meal.main_amount
  const side = meal.side_amount
  if (main == null && side == null) {
    return (
      <>
        <span className="sr-only">記録なし</span>
        <span aria-hidden="true" className="text-ink3">
          —
        </span>
      </>
    )
  }
  const low = isLowIntake(meal)
  return (
    <span className={low ? 'tabular rounded-sm bg-warn-bg px-1 text-warn font-bold' : 'tabular'}>
      {low ? (
        <>
          <span aria-hidden="true">▲</span>
          <span className="sr-only">低摂取 </span>
        </>
      ) : null}
      {main ?? '—'}／{side ?? '—'}
    </span>
  )
}

interface MealsSectionProps {
  meals: Meal[]
  fluids: FluidIntake[]
  outings: Outing[]
  days: string[]
}

function MealsSection({ meals, fluids, outings, days }: MealsSectionProps) {
  const rows = useMemo(() => {
    const byDay = new Map<string, { meals: Map<MealSlot, Meal>; fluid: number | null }>()
    for (const m of meals) {
      if (typeof m.meal_on !== 'string') continue
      const cell = byDay.get(m.meal_on) ?? { meals: new Map<MealSlot, Meal>(), fluid: null }
      // 同じ枠に複数行がある場合は id の大きい（後から入った）行を採る
      const prev = cell.meals.get(m.meal_slot)
      if (!prev || m.id > prev.id) cell.meals.set(m.meal_slot, m)
      byDay.set(m.meal_on, cell)
    }
    for (const f of fluids) {
      if (typeof f.taken_on !== 'string') continue
      const cell = byDay.get(f.taken_on) ?? { meals: new Map<MealSlot, Meal>(), fluid: null }
      const add = typeof f.amount_ml === 'number' && Number.isFinite(f.amount_ml) ? f.amount_ml : 0
      cell.fluid = (cell.fluid ?? 0) + add
      byDay.set(f.taken_on, cell)
    }
    // 記録がある日だけを新しい順に並べる（記録が無い日は行を作らない）
    return days
      .filter((d) => byDay.has(d) || outings.some((o) => outingCoversDay(o, d)))
      .reverse()
      .map((d) => ({
        day: d,
        meals: byDay.get(d)?.meals ?? new Map<MealSlot, Meal>(),
        fluid: byDay.get(d)?.fluid ?? null,
        outings: outings.filter((o) => outingCoversDay(o, d)),
      }))
  }, [meals, fluids, outings, days])

  return (
    <SectionCard title="食事・水分" className="mt-4">
      <p className="text-sm text-ink2">
        主食／副食は 0〜10 の数値です。▲ は低摂取（主+副が6以下）、— は記録なしを表します。
      </p>
      {rows.length === 0 ? (
        <div className="mt-3">
          <EmptyBlock message="この期間の食事・水分の記録はありません。期間を広げてお試しください。" />
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              食事（主食／副食）と水分量の履歴。新しい日が上。
            </caption>
            <thead>
              <tr className="border-b border-border-strong text-ink2">
                <th scope="col" className="py-2 pr-2 text-left font-bold">
                  日付
                </th>
                {TABLE_SLOTS.map((s) => (
                  <th key={s} scope="col" className="py-2 pr-2 text-right font-bold">
                    {SLOT_HEAD[s]}
                  </th>
                ))}
                <th scope="col" className="py-2 pr-2 text-right font-bold">
                  水分(ml)
                </th>
                <th scope="col" className="py-2 text-left font-bold">
                  外出・外泊
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.day} className="border-b border-border">
                  <th scope="row" className="py-2 pr-2 text-left font-normal text-ink">
                    {fmtDayLabel(r.day)}
                  </th>
                  {TABLE_SLOTS.map((s) => (
                    <td key={s} className="py-2 pr-2 text-right">
                      <MealCell meal={r.meals.get(s)} />
                    </td>
                  ))}
                  <td className="tabular py-2 pr-2 text-right text-ink">
                    {r.fluid == null ? (
                      <>
                        <span className="sr-only">記録なし</span>
                        <span aria-hidden="true" className="text-ink3">
                          —
                        </span>
                      </>
                    ) : (
                      r.fluid
                    )}
                  </td>
                  <td className="py-2">
                    {r.outings.length === 0 ? (
                      <span aria-hidden="true" className="text-ink3">
                        —
                      </span>
                    ) : (
                      <span className="flex flex-wrap gap-gap">
                        {r.outings.map((o) => (
                          <Chip key={o.id} tone="info">
                            {OUTING_KIND_LABEL[o.kind] ?? '外出'}
                            {o.end_on == null ? '（帰着未定）' : ''}
                          </Chip>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// 本人分の申し送り
// ══════════════════════════════════════════════════════════════

interface NoteCardProps {
  note: Note
  reporterName: string | null
}

function NoteCard({ note, reporterName }: NoteCardProps) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const tone =
    note.importance === 'critical'
      ? 'border-danger bg-danger-bg'
      : note.importance === 'important'
        ? 'border-warn bg-warn-bg'
        : 'border-border bg-surface'

  return (
    <li className={`rounded-md border p-3 ${tone}`}>
      <div className="flex flex-wrap items-center gap-gap">
        <span className="tabular text-sm text-ink2">{fmtTimeHM(note.occurred_at) || '—'}</span>
        <span className="text-sm text-ink2">{SHIFT_LABEL[note.shift] ?? ''}</span>
        {note.importance !== 'normal' ? (
          <span
            className={`text-sm font-bold ${note.importance === 'critical' ? 'text-danger' : 'text-warn'}`}
          >
            {IMPORTANCE_LABEL[note.importance]}
          </span>
        ) : null}
        {note.ongoing ? <Chip tone="accent">継続中</Chip> : null}
        {asArray<string>(note.role_tags).map((t) => (
          <Chip key={t}>{t}</Chip>
        ))}
      </div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((v) => !v)}
        className="mt-2 min-h-tap w-full text-left"
      >
        <span id={bodyId} className={`block text-lg text-ink ${expanded ? '' : 'clamp-2'}`}>
          {note.body}
        </span>
        <span className="mt-1 block text-sm text-link">
          {expanded ? '本文を閉じる' : '本文をすべて表示'}
        </span>
      </button>
      <p className="mt-1 text-sm text-ink2">
        記入者 {reporterName ?? '—'}
        {typeof note.read_count === 'number' ? (
          <>
            {'　'}
            <span aria-hidden="true">✓</span>
            <span className="sr-only">既読 </span>
            既読 <span className="tabular">{note.read_count}</span>
          </>
        ) : null}
      </p>
    </li>
  )
}

interface NotesSectionProps {
  notes: Note[]
  staffById: Map<number, string>
}

function NotesSection({ notes, staffById }: NotesSectionProps) {
  const groups = useMemo(() => {
    // 新しい日・新しい時刻が先。時刻が無い記録（夜勤等）は同じ日の末尾に置く
    const sorted = notes.slice().sort((a, b) => {
      if (a.note_on !== b.note_on) return a.note_on < b.note_on ? 1 : -1
      const at = a.occurred_at
      const bt = b.occurred_at
      if (at == null && bt != null) return 1
      if (at != null && bt == null) return -1
      if (at != null && bt != null && at !== bt) return at < bt ? 1 : -1
      return b.id - a.id
    })
    const byDay = new Map<string, Note[]>()
    for (const n of sorted) {
      const list = byDay.get(n.note_on)
      if (list) list.push(n)
      else byDay.set(n.note_on, [n])
    }
    return Array.from(byDay.entries())
  }, [notes])

  return (
    <SectionCard title="この方の申し送り" className="mt-4">
      {groups.length === 0 ? (
        <div className="mt-2">
          <EmptyBlock message="この期間の申し送りはありません。期間を広げてお試しください。" />
        </div>
      ) : (
        <div className="mt-2 space-y-4">
          {groups.map(([day, list]) => (
            <div key={day}>
              <h3 className="text-sm font-bold text-ink2">
                {fmtDayLabel(day)}（<span className="tabular">{list.length}</span>件）
              </h3>
              <ul className="mt-2 space-y-2">
                {list.map((n) => (
                  <NoteCard
                    key={n.id}
                    note={n}
                    reporterName={n.reporter_id == null ? null : (staffById.get(n.reporter_id) ?? null)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// 個人カルテ（/karte/:id）
// ══════════════════════════════════════════════════════════════

interface KarteData {
  vitals: Vital[]
  meals: Meal[]
  fluids: FluidIntake[]
  notes: Note[]
  outings: Outing[]
}

const EMPTY_KARTE: KarteData = { vitals: [], meals: [], fluids: [], notes: [], outings: [] }

interface KarteDetailProps {
  residentId: number
  state: ResidentsState
  staff?: Staff[]
}

function KarteDetail({ residentId, state, staff }: KarteDetailProps) {
  const { residents, loading: residentsLoading, error: residentsError, reload } = state
  const [range, setRange] = useState<RangeKey>(readRange)
  const [data, setData] = useState<KarteData>(EMPTY_KARTE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [staffList, setStaffList] = useState<Staff[]>(staff ?? [])
  const aliveRef = useRef(true)

  const toIso = todayIso()
  const fromIso = rangeFromIso(range, toIso)
  const days = useMemo(() => daysAscending(fromIso, toIso), [fromIso, toIso])

  const resident = useMemo(
    () => residents.find((r) => r.id === residentId) ?? null,
    [residents, residentId],
  )

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 期間の変更を保存する（UI状態のみ）
  const onRangeChange = useCallback((v: string) => {
    if (!(RANGE_VALUES as readonly string[]).includes(v)) return
    const next = v as RangeKey
    setRange(next)
    writeRange(next)
  }, [])

  // カルテ本体（resident_id＋期間指定の取得。全件ロードの経路を作らない）
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchKarte(residentId, fromIso, toIso)
      .then((res) => {
        if (cancelled || !aliveRef.current) return
        setData({
          vitals: ownedBy<Vital>(res?.vitals, residentId),
          meals: ownedBy<Meal>(res?.meals, residentId),
          fluids: ownedBy<FluidIntake>(res?.fluids, residentId),
          // 本人分の申し送りだけを出す（「スタッフへ（全体）」は resident_id が null）
          notes: asArray<Note>(res?.notes).filter((n) => n != null && n.resident_id === residentId),
          outings: ownedBy<Outing>(res?.outings, residentId),
        })
        setError(null)
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        // 取得できなかった場合は前の表示を残さず空にする（別期間の値を混ぜて誤読させない）
        setData(EMPTY_KARTE)
        setError(ERR_KARTE)
      })
      .finally(() => {
        if (cancelled || !aliveRef.current) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [residentId, fromIso, toIso, tick])

  // 記入者名の対応表（職員マスタ。取得できなくてもカルテ本体は表示する）
  useEffect(() => {
    if (staff) {
      setStaffList(staff)
      return
    }
    let cancelled = false
    fetchStaff()
      .then((rows) => {
        if (cancelled || !aliveRef.current) return
        setStaffList(asArray<Staff>(rows).filter((s) => s != null && typeof s.id === 'number'))
      })
      .catch(() => {
        // 記入者名が出せないだけなので、カルテの表示は続ける
      })
    return () => {
      cancelled = true
    }
  }, [staff])

  const staffById = useMemo(() => {
    const m = new Map<number, string>()
    for (const s of staffList) m.set(s.id, s.name)
    return m
  }, [staffList])

  const floor = resident ? floorOf(resident.room) : null

  if (residentsLoading && residents.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <LoadingBlock label="利用者の情報を読み込み中です…" />
      </div>
    )
  }

  if (!resident) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <Link to="/karte" className="inline-flex min-h-tap items-center text-base text-link">
          <span aria-hidden="true">‹ </span>利用者一覧へ戻る
        </Link>
        <div className="mt-3">
          {residentsError ? (
            <ErrorBlock message={residentsError} onRetry={reload} />
          ) : (
            <ErrorBlock message="この利用者は現在の一覧にありません（退居・無効化の可能性があります）。一覧へ戻って選び直してください。" />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-4">
      <Link to="/karte" className="inline-flex min-h-tap items-center text-base text-link">
        <span aria-hidden="true">‹ </span>利用者一覧へ戻る
      </Link>

      <header className="mt-2">
        <h1 className="text-xl font-heavy text-ink">{resident.name}</h1>
        <p className="mt-1 text-sm text-ink2">
          {resident.kana ? <span>{resident.kana}　</span> : null}
          <span className="tabular">{resident.room ?? '居室未登録'}</span>
          {floor != null ? <span>　{floor}階</span> : null}
        </p>
        {resident.needs_review ? (
          <p className="mt-1 text-sm text-warn">
            <span aria-hidden="true">▲ </span>
            マスタ同期で確認待ちの利用者です。設定タブで内容をご確認ください。
          </p>
        ) : null}
      </header>

      <div className="mt-3">
        <h2 className="text-sm text-ink2">表示する期間</h2>
        <div className="mt-1">
          <SegmentPicker
            options={RANGE_OPTIONS}
            value={range}
            onChange={onRangeChange}
            ariaLabel="表示する期間"
          />
        </div>
        <p className="tabular mt-1 text-sm text-ink3">
          {fmtDayLabel(fromIso)} 〜 {fmtDayLabel(toIso)}
        </p>
      </div>

      {loading ? (
        <div className="mt-3">
          <LoadingBlock label="カルテを読み込み中です…" />
        </div>
      ) : error ? (
        <div className="mt-3">
          <ErrorBlock message={error} onRetry={() => setTick((n) => n + 1)} />
        </div>
      ) : (
        <>
          <VitalsSection vitals={data.vitals} days={days} />
          <MealsSection
            meals={data.meals}
            fluids={data.fluids}
            outings={data.outings}
            days={days}
          />
          <NotesSection notes={data.notes} staffById={staffById} />
        </>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// ルート（/karte と /karte/:id を1つの画面で受ける）
// ══════════════════════════════════════════════════════════════

export interface KartePageProps {
  /** App 側で取得済みなら渡せる（未指定ならこの画面が db.ts から取得する） */
  residents?: Resident[]
  staff?: Staff[]
}

export function KartePage({ residents, staff }: KartePageProps = {}) {
  const params = useParams<{ id?: string }>()
  const state = useResidents(residents)

  // URL の :id は正の整数だけを受け入れる（壊れた値で表示不能にしない）
  const raw = params.id ?? ''
  const residentId = /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null

  if (raw !== '' && residentId == null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <Link to="/karte" className="inline-flex min-h-tap items-center text-base text-link">
          <span aria-hidden="true">‹ </span>利用者一覧へ戻る
        </Link>
        <div className="mt-3">
          <ErrorBlock message="この利用者のカルテを開けませんでした（アドレスが正しくありません）。一覧へ戻って選び直してください。" />
        </div>
      </div>
    )
  }

  if (residentId == null) return <ResidentList state={state} />
  return <KarteDetail residentId={residentId} state={state} staff={staff} />
}

export default KartePage
