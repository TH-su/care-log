// デイ（せせらぎ）計画F: 1人の画面のバイタルの推移（直近の回）の小さなグラフ（2026-11-10）。読むだけ。
// 画面の最後の独立した欄（見出し「バイタルの推移（直近 n 回）」はこの部品が出す・欄の枠は画面の section）。入力の欄を下げない（仮置き・親の決定）
//
// ・項目ごとの小さなグラフ（血圧＝上・下の2本・脈・SpO2・体温）。二つの目盛り（二軸）は使わない
// ・色はバイタルの分類色（--c-cat-vitals・暗は明るめの値）。血圧の2本はどちらも実線（破線は予測に見えるため使わない＝dataviz・親の決定）で、
//   点の形（上＝丸・下＝四角）・凡例・直接の名前「上」「下」で見分ける
// ・基準外の点だけ状態の色（注意・危険）にし、形（▲高い・▼低い）と記号（↑・↑↑）を添える。判定は連絡帳と同じ（daycareVitalsTrend.ts の trendLevel）
// ・数値も出す: 最新の値と基準外の点は値を直接出す（重なる分は出さない）。全部の値は〔数値で見る〕の表（本物の table）
// ・グラフを押すと、いちばん近い回の日時と全部の項目の値を下の1行に出す（もう一度押すと消す）
// ・判断（回の並べ方・目盛り・判定の呼び出し・ラベルの選び方・表の言葉）は src/lib/daycareVitalsTrend.ts（純関数・試験あり）。ここは描くだけ
// ・表示中の日の回は1人の画面が読んだ行（上のバイタルの要約と同じ行）。前の日の回と〔未測定〕の印はこの部品が読む（fetchDaycareVitalsTrend）
// 端末に業務データを残さない（localStorage・console を使わない）。動きは付けない。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fetchDaycareVitalsTrend } from '../lib/db'
import type { DaycareVitalField, KeyedVital } from '../lib/daycare'
import type { DaycareVitalUnmeasured } from '../lib/daycareProgress'
import type { Level } from '../lib/types'
import { LEVEL_MARK } from '../lib/types'
import type { ResidentTargets } from '../lib/vitalAlerts'
import type { VitalThresholds } from '../lib/vitalThresholds'
import {
  BP_SERIES_NAME,
  TREND_EMPTY_TEXT,
  TREND_MARKS_UNREAD_TEXT,
  TREND_ONE_TEXT,
  TREND_PANELS,
  TREND_ROUNDS,
  TREND_UNREAD_TEXT,
  abnormalCount,
  clampLabelX,
  fmtTick,
  fmtTrendValue,
  lastIndexWithValue,
  levelIsDanger,
  levelIsHigh,
  pickLabels,
  pickXLabels,
  roundWhen,
  shortDay,
  textWidth,
  trendCell,
  trendDomain,
  trendFitRounds,
  trendLevel,
  trendReadout,
  trendRounds,
  trendSegments,
  trendSpeech,
  trendTicks,
  trendView,
} from '../lib/daycareVitalsTrend'
import type { LabelCandidate, LabelObstacle, LabelSpot, TrendPanelSpec, TrendRound } from '../lib/daycareVitalsTrend'

interface Props {
  /** 見出し（h3）の id（画面の section の aria-labelledby） */
  headingId: string
  residentId: number
  /** 表示中の日（この日までの直近の回） */
  day: string
  /** 表示中の日のデイの測定（1人の画面が読んだ行。ほかの方の行が混ざってもその方の分だけ使う） */
  dayRows: readonly KeyedVital[]
  /** 個別の目標（SpO2 の下限など） */
  target: ResidentTargets | null | undefined
  /** その方のその日の基準（画面の useVitalLimits の lookup をその方で引いたもの） */
  limitsOf: (day: string) => VitalThresholds
  /** 画面の〔最新に更新〕・再試行の回数（変わったら読み直す） */
  refreshKey?: number
}

type Load =
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; rows: KeyedVital[]; unmeasured: DaycareVitalUnmeasured[] | null }
  | { status: 'error'; key: string }

const EMPTY_ROWS: KeyedVital[] = []
const EMPTY_MARKS: DaycareVitalUnmeasured[] = []

export function DaycareVitalsTrend({ headingId, residentId, day, dayRows, target, limitsOf, refreshKey = 0 }: Props) {
  const key = `${residentId}:${day}`
  const [load, setLoad] = useState<Load>({ status: 'loading', key })
  const [retry, setRetry] = useState(0)
  /** 押した回（人・日ごと。行の id で持つ＝読み直しで並びが変わっても同じ回） */
  const [sel, setSel] = useState<{ key: string; id: number } | null>(null)
  /** グラフの点を並べる幅（4つのグラフで同じ。グラフが測って知らせる・まだ測っていない間は null＝10 回） */
  const [plotW, setPlotW] = useState<number | null>(null)
  // その方の表示中の日の行が変わった（他の端末の入力・再測定）時は〔未測定〕の印も読み直す（前の日の行は変わらないが、印は同じ回に付く）
  const mineSig = useMemo(
    () =>
      dayRows
        .filter((v) => v.resident_id === residentId && v.measured_on === day)
        .map((v) => `${v.id}.${v.rev}`)
        .join(','),
    [dayRows, residentId, day],
  )

  useEffect(() => {
    let alive = true
    // 同じ人・同じ日の読み直しは、読めるまで前の描画を残す（枠を動かさない）。人・日が変わったら読み込み中にする
    setLoad((prev) => (prev.key === key && prev.status === 'ready' ? prev : { status: 'loading', key }))
    fetchDaycareVitalsTrend(residentId, day)
      .then((r) => {
        if (alive) setLoad({ status: 'ready', key, rows: r.rows, unmeasured: r.unmeasured })
      })
      .catch(() => {
        // 静かな読み直しの失敗では、いま出している内容を残す（前の日の行は読み直しで変わらない）
        if (alive) setLoad((prev) => (prev.key === key && prev.status === 'ready' ? prev : { status: 'error', key }))
      })
    return () => {
      alive = false
    }
  }, [key, residentId, day, refreshKey, mineSig, retry])

  const ready = load.key === key && load.status === 'ready' ? load : null
  const pastRows = ready?.rows ?? EMPTY_ROWS
  const marks = ready === null ? EMPTY_MARKS : ready.unmeasured
  const all = useMemo(() => trendRounds(dayRows, pastRows, residentId, day, marks), [dayRows, pastRows, residentId, day, marks])
  // 点の間が狭くなりすぎる幅（375px で文字 200% など）では、新しい方から入る回だけ出す（表も同じ回）
  const fit = plotW === null ? TREND_ROUNDS : trendFitRounds(plotW)
  const rounds = useMemo(() => (all.length > fit ? all.slice(-fit) : all), [all, fit])
  const marksUnread = ready !== null && ready.unmeasured === null
  const levelOf = (r: TrendRound, f: DaycareVitalField): Level => trendLevel(r, f, target, limitsOf)
  const selected = sel !== null && sel.key === key ? (rounds.find((r) => r.id === sel.id) ?? null) : null
  const pick = (i: number) => {
    const r = rounds[i]
    if (r === undefined) return
    setSel((prev) => (prev !== null && prev.key === key && prev.id === r.id ? null : { key, id: r.id }))
  }

  // 見出しはどの状態でも出す（画面の section の名前）。回の数は出せる時だけ
  const heading = (text: string) => (
    <h3 id={headingId} className="text-lg font-bold text-ink">
      {text}
    </h3>
  )
  if (load.key !== key || load.status === 'loading') {
    return (
      <>
        {heading('バイタルの推移')}
        <p role="status" className="text-sm text-ink2">
          推移を読み込んでいます…
        </p>
      </>
    )
  }
  if (load.status === 'error') {
    return (
      <>
        {heading('バイタルの推移')}
        <div role="alert" className="space-y-2 rounded border border-warn bg-warn-bg p-2 text-base text-ink">
          <p>
            <span aria-hidden="true">▲ </span>
            {TREND_UNREAD_TEXT}
          </p>
          <button type="button" onClick={() => setRetry((n) => n + 1)} className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink">
            再試行
          </button>
        </div>
      </>
    )
  }

  const view = trendView(all)
  const n = rounds.length
  return (
    <>
      {heading(view.kind === 'none' ? 'バイタルの推移' : `バイタルの推移（直近${n}回）`)}
      {view.kind === 'chart' ? (
        <p className="text-sm text-ink2">
          横軸は測った回の順に等間隔（日付の間が空いても詰めています）
          {n < all.length && n < TREND_ROUNDS ? `。画面の幅に合わせて直近${n}回にしています` : ''}
        </p>
      ) : null}
      {view.kind === 'none' ? <p className="text-base text-ink2">{TREND_EMPTY_TEXT}</p> : null}
      {view.kind === 'one' ? <p className="text-base text-ink2">{TREND_ONE_TEXT}</p> : null}
      {view.kind === 'chart' ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-x-6 gap-y-4">
            {TREND_PANELS.map((p) => (
              <TrendChart key={p.key} panel={p} rounds={rounds} levelOf={levelOf} selectedId={selected?.id ?? null} onPick={pick} onPlotW={setPlotW} />
            ))}
          </div>
          <p role="status" aria-live="polite" className="text-sm text-ink">
            {selected === null ? (
              <span className="text-ink2">グラフを押すと、いちばん近い回の日時と値をここに出します。</span>
            ) : (
              trendReadout(selected, levelOf, marksUnread)
            )}
          </p>
        </>
      ) : null}
      {marksUnread && view.kind !== 'none' ? (
        <p className="text-sm text-ink2">
          <span aria-hidden="true">ⓘ </span>
          {TREND_MARKS_UNREAD_TEXT}
        </p>
      ) : null}
      {view.kind === 'none' ? null : (
        <details>
          <summary className="inline-flex min-h-tap cursor-pointer items-center text-base text-link">
            数値で見る（<span className="font-num">{n}</span>回）
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">バイタルの推移（直近{n}回・新しい回が上）</caption>
              <thead>
                <tr className="border-b border-border-strong text-ink2">
                  <th scope="col" className="py-2 pr-2 text-left font-bold">
                    日時
                  </th>
                  {TREND_PANELS.map((p) => (
                    <th key={p.key} scope="col" className="py-2 pr-2 text-left font-bold">
                      {p.title}
                      <span className="block font-normal">{p.unit}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...rounds].reverse().map((r) => (
                  <tr key={r.id} className="border-b border-border align-top">
                    <th scope="row" className="py-2 pr-2 text-left font-normal text-ink">
                      {roundWhen(r)}
                    </th>
                    {TREND_PANELS.map((p) => {
                      const c = trendCell(p, r, levelOf, marksUnread)
                      return (
                        <td key={p.key} className="py-2 pr-2 text-ink">
                          <span className="font-num">{c.text}</span>
                          {c.flags.map((f) => (
                            <span key={f} className="block font-bold">
                              {f}
                            </span>
                          ))}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// 1項目の小さなグラフ
// ══════════════════════════════════════════════════════════════

interface Box {
  width: number
  /** SVG の文字の大きさ（text-sm の実測・文字を大きくすると大きくなる） */
  fs: number
  /** 数字1字の幅（font-num の実測） */
  charW: number
}

/** グラフの幅と文字の大きさを測る（幅・文字の大きさが変わったら測り直す） */
function useChartBox() {
  const ref = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const [box, setBox] = useState<Box>({ width: 0, fs: 15, charW: 9 })
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const update = () => {
      const w = Math.floor(el.getBoundingClientRect().width)
      const p = probe.current
      const fsRaw = p === null ? NaN : parseFloat(getComputedStyle(p).fontSize)
      const fs = Number.isFinite(fsRaw) && fsRaw > 0 ? fsRaw : 15
      const pw = p === null ? 0 : p.getBoundingClientRect().width
      const charW = pw > 0 ? pw / 10 : fs * 0.6
      setBox((prev) => (prev.width === w && prev.fs === fs && Math.abs(prev.charW - charW) < 0.05 ? prev : { width: w, fs, charW }))
    }
    update()
    // ResizeObserver が無い環境でも、初回の実測と画面の大きさの変化で追う
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    ro?.observe(el)
    if (probe.current !== null) ro?.observe(probe.current)
    window.addEventListener('resize', update)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])
  return { ref, probe, box }
}

interface ChartProps {
  panel: TrendPanelSpec
  rounds: readonly TrendRound[]
  levelOf: (r: TrendRound, f: DaycareVitalField) => Level
  selectedId: number | null
  onPick: (i: number) => void
  /** 点を並べる幅を知らせる（回の数を決める） */
  onPlotW: (w: number) => void
}

/** 点の形（血圧の下は四角・ほかは丸。基準外は高い＝▲・低い＝▼） */
function Marker({ x, y, lv, square }: { x: number; y: number; lv: Level; square: boolean }) {
  if (lv !== null) {
    const tone = levelIsDanger(lv) ? 'fill-danger' : 'fill-warn'
    const pts = levelIsHigh(lv) ? `${x},${y - 7} ${x - 7},${y + 5} ${x + 7},${y + 5}` : `${x},${y + 7} ${x - 7},${y - 5} ${x + 7},${y - 5}`
    return <polygon points={pts} className={`${tone} stroke-surface`} strokeWidth={2} strokeLinejoin="round" />
  }
  if (square) return <rect x={x - 4} y={y - 4} width={8} height={8} className="fill-cat-vitals stroke-surface" strokeWidth={2} />
  return <circle cx={x} cy={y} r={4} className="fill-cat-vitals stroke-surface" strokeWidth={2} />
}

function TrendChart({ panel, rounds, levelOf, selectedId, onPick, onPlotW }: ChartProps) {
  const { ref, probe, box } = useChartBox()
  const svgRef = useRef<SVGSVGElement>(null)
  const n = rounds.length
  const withVal = rounds.some((r) => panel.fields.some((f) => r.vals[f] !== null))
  const ab = abnormalCount(panel, rounds, levelOf)
  const speech = trendSpeech(panel, rounds, levelOf)

  const { width: W, fs, charW } = box
  const tw = (t: string) => textWidth(t, fs, charW)
  const lineH = Math.ceil(fs * 1.3)
  // グラフの高さは文字の大きさに合わせて少し伸ばす（文字 100%＝72px・200%＝108px）。目盛は chartTicks が間引く
  const plotH = Math.round(Math.max(64, 36 + fs * 2.4))
  const domain = trendDomain(panel, rounds)
  // 目盛の数字の間は文字1行分より少し広く（文字が重ならない）
  const ticks = trendTicks(panel, domain, plotH, Math.ceil(fs * 1.25))
  const tickTexts = ticks.map((v) => fmtTick(panel, v))
  // 左の目盛の数字の幅は4つのグラフで同じ（4字＝「36.0」）にして、横の位置を4つのグラフでそろえる
  const padL = tw('00.0') + 8
  const padR = 4
  // 点の上・下に置くラベルの分（上は ▲ の印の上・下は ▼ の印の下）
  const padT = lineH + 4
  const belowRoom = Math.ceil(fs) + 12
  const xAxisH = lineH + 4
  const H = padT + plotH + belowRoom + xAxisH
  const x0 = padL + 10
  const x1 = Math.max(x0, W - padR - 10)
  const span = x1 - x0
  useEffect(() => {
    if (W > 0) onPlotW(span)
  }, [W, span, onPlotW])
  const x = (i: number) => (n <= 1 ? (x0 + x1) / 2 : x0 + (i * (x1 - x0)) / (n - 1))
  const y = (v: number) => {
    const span = domain[1] - domain[0] || 1
    return padT + (1 - (v - domain[0]) / span) * plotH
  }
  const baseDy = Math.round(fs * 0.35)

  // 直接のラベル: 最新の値（血圧は「上」「下」の名前つき）と基準外の点（新しい順）。同じ側で重なるものは出さない
  // 文字の箱（上端は基準線から 0.85 字上・高さ 1 字）。点の上のラベルは ▲ の印の上、下のラベルは ▼ の印の下
  const textH = Math.ceil(fs)
  const spot = (side: 'above' | 'below', cx: number, v: number): LabelSpot => ({
    side,
    x: cx,
    top: side === 'above' ? y(v) - 11 - Math.round(fs * 0.85) : y(v) + 11 + Math.round(fs * 0.75) - Math.round(fs * 0.85),
  })
  const cands: (LabelCandidate & { text: string; bold: boolean })[] = []
  const markBoxes: { id: string; box: LabelObstacle }[] = []
  panel.fields.forEach((f, fi) => {
    const last = lastIndexWithValue(rounds, f)
    const bpName = panel.key === 'bp' ? BP_SERIES_NAME[f] : undefined
    rounds.forEach((r, i) => {
      const v = r.vals[f]
      if (v === null) return
      const lv = levelOf(r, f)
      // 印の大きさ（丸・四角は半径 4＋縁 2・▲▼ は 7＋縁 2）
      const m = lv === null ? 6 : 8
      markBoxes.push({ id: `${f}:${i}`, box: [x(i) - m, y(v) - m, x(i) + m, y(v) + m] })
      if (i !== last && lv === null) return
      // 描く幅に入らないラベルは切らずに出さない（血圧の最新は「上」「下」を外した形も試す。値は押した時の表示と表に出る）
      const body = `${fmtTrendValue(f, v)}${lv === null ? '' : LEVEL_MARK[lv]}`
      const room = W - padR - padL
      const text = [...(i === last && bpName !== undefined ? [`${bpName} ${body}`] : []), body].find((t) => tw(t) <= room)
      if (text === undefined) return
      // 血圧は上の線のラベルを点の上・下の線のラベルを点の下（2本の間に置かない）。1本の項目は高い値を上・低い値を下に置き、
      // 先に置いたラベル・ほかの点と重なる時は反対の側を試す
      const side: 'above' | 'below' = panel.key === 'bp' ? (f === 'sys_bp' ? 'above' : 'below') : lv !== null && !levelIsHigh(lv) ? 'below' : 'above'
      const w = tw(text)
      const cx = clampLabelX(x(i), w, padL, W - padR)
      cands.push({
        id: `${f}:${i}`,
        w,
        h: textH,
        priority: i === last ? fi * 0.1 : 1 + (n - 1 - i) * 0.01 + fi * 0.001,
        spots: panel.key === 'bp' ? [spot(side, cx, v)] : [spot(side, cx, v), spot(side === 'above' ? 'below' : 'above', cx, v)],
        text,
        bold: i === last,
      })
    })
  })
  // ほかの点の印に重ねない（自分の点の印は避けない＝上・下にずらしてあるため）
  const shown = pickLabels(cands, Math.ceil(fs * 0.25), markBoxes, 1)

  // 横軸の日付（重ならない分だけ。全部の日時は表と押した時の表示に出る）
  const xTexts = rounds.map((r) => shortDay(r.day))
  const xWs = xTexts.map(tw)
  // 端の日付は枠の内側へ寄せた位置で重なりを見る（右端の最新の日付が左へ寄る分）
  const xAt = rounds.map((_, i) => clampLabelX(x(i), xWs[i], 0, W))
  const xIdx = pickXLabels(xAt, xWs, Math.ceil(fs * 0.6))
  const selIdx = selectedId === null ? -1 : rounds.findIndex((r) => r.id === selectedId)

  const nearest = (clientX: number): number => {
    const svg = svgRef.current
    if (svg === null || n === 0) return -1
    const rect = svg.getBoundingClientRect()
    const px = ((clientX - rect.left) / (rect.width || 1)) * W
    let best = 0
    for (let i = 1; i < n; i += 1) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i
    return best
  }

  return (
    // 枠で囲まない（バイタルの欄のカードの中にカードを重ねない）。グラフどうしは間の余白で分ける
    <figure className="min-w-0">
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-base font-bold text-ink">
          {panel.title}
          <span className="ml-1 text-sm font-normal text-ink2">{panel.unit}</span>
        </span>
        {panel.key === 'bp' ? (
          // 凡例（2本の時はいつも出す）。線の形と点の形が線そのものと同じ
          <span className="inline-flex flex-wrap items-center gap-x-3 text-sm text-ink">
            <span className="inline-flex items-center gap-1">
              <svg width="28" height="12" aria-hidden="true" className="shrink-0">
                <line x1="2" x2="26" y1="6" y2="6" className="stroke-cat-vitals" strokeWidth={2} strokeLinecap="round" />
                <circle cx="14" cy="6" r="4" className="fill-cat-vitals stroke-surface" strokeWidth={2} />
              </svg>
              上
            </span>
            <span className="inline-flex items-center gap-1">
              <svg width="28" height="12" aria-hidden="true" className="shrink-0">
                <line x1="2" x2="26" y1="6" y2="6" className="stroke-cat-vitals" strokeWidth={2} strokeLinecap="round" />
                <rect x="10" y="2" width="8" height="8" className="fill-cat-vitals stroke-surface" strokeWidth={2} />
              </svg>
              下
            </span>
          </span>
        ) : null}
        {ab > 0 ? (
          <span className="text-sm text-ink">
            <span aria-hidden="true">▲▼ </span>基準外 <span className="font-num">{ab}</span>回
          </span>
        ) : null}
      </figcaption>
      <div ref={ref} className="relative mt-1 min-w-0">
        {/* 文字の大きさと数字の幅を測る（見えない・読み上げない） */}
        <span ref={probe} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap font-num text-sm">
          0000000000
        </span>
        {!withVal ? (
          <p className="py-2 text-sm text-ink2">
            この{n}回に{panel.title}の記録はありません。
          </p>
        ) : W <= 0 ? null : (
          <svg
            ref={svgRef}
            role="img"
            aria-label={speech}
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            className="block cursor-pointer select-none"
            onClick={(e) => {
              const i = nearest(e.clientX)
              if (i >= 0) onPick(i)
            }}
          >
            {/* 目盛の線（区切りのよい値・細い実線） */}
            {ticks.map((v) => (
              <line key={`g-${v}`} x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} />
            ))}
            {ticks.map((v, k) => (
              <text key={`t-${v}`} x={padL - 6} y={y(v) + baseDy} textAnchor="end" className="fill-ink2 font-num text-sm">
                {tickTexts[k]}
              </text>
            ))}
            {/* 押した回（縦の細い線） */}
            {selIdx >= 0 ? <line x1={x(selIdx)} x2={x(selIdx)} y1={padT - 4} y2={padT + plotH + 4} className="stroke-border-strong" strokeWidth={1} /> : null}
            {/* 線（値の無い回で切る・2px の実線。血圧の上・下は点の形と名前で見分ける） */}
            {panel.fields.map((f) =>
              trendSegments(rounds.map((r) => r.vals[f]))
                .filter((seg) => seg.length >= 2)
                .map((seg) => (
                  <polyline
                    key={`l-${f}-${seg[0]}`}
                    points={seg.map((i) => `${x(i)},${y(rounds[i].vals[f] as number)}`).join(' ')}
                    className="fill-none stroke-cat-vitals"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )),
            )}
            {/* 点（8px・面の色の縁。基準外は ▲▼ と注意・危険の色） */}
            {panel.fields.map((f) =>
              rounds.map((r, i) => {
                const v = r.vals[f]
                if (v === null) return null
                return <Marker key={`m-${f}-${r.id}`} x={x(i)} y={y(v)} lv={levelOf(r, f)} square={f === 'dia_bp'} />
              }),
            )}
            {/* 直接のラベル（文字の色。系列の色は文字に使わない） */}
            {cands.map((c) => {
              const at = shown.get(c.id)
              if (at === undefined) return null
              return (
                <text key={`v-${c.id}`} x={at.x} y={at.top + Math.round(fs * 0.85)} textAnchor="middle" className={`fill-ink font-num text-sm${c.bold ? ' font-bold' : ''}`}>
                  {c.text}
                </text>
              )
            })}
            {/* 横軸の日付 */}
            {xIdx.map((i) => (
              <text
                key={`x-${rounds[i].id}`}
                x={xAt[i]}
                y={H - Math.ceil(fs * 0.3)}
                textAnchor="middle"
                className={`font-num text-sm ${i === selIdx ? 'fill-ink font-bold' : 'fill-ink2'}`}
              >
                {xTexts[i]}
              </text>
            ))}
          </svg>
        )}
      </div>
    </figure>
  )
}
