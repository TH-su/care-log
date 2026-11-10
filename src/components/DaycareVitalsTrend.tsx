// デイ（せせらぎ）計画F: 1人の画面のバイタルの推移（直近の回）の小さなグラフ（2026-11-10）。読むだけ。
// 画面の最後の独立した欄（見出し「バイタルの推移（直近 n 回）」はこの部品が出す・欄の枠は画面の section）。入力の欄を下げない（仮置き・親の決定）
//
// ・項目ごとの小さなグラフ（血圧＝上・下の2本・脈・SpO2・体温）。二つの目盛り（二軸）は使わない
// ・色はバイタルの分類色（--c-cat-vitals・暗は明るめの値）。血圧の2本はどちらも実線（破線は予測に見えるため使わない＝dataviz・親の決定）で、
//   点の形（上＝丸・下＝四角）・凡例・直接の名前「上」「下」で見分ける
// ・基準外の点だけ状態の色（注意・危険）にし、形でも見分ける（注意＝輪郭だけ・危険＝塗り＋外の輪。向きは三角の向き・血圧の下は四角＋向きの小さな印）。
//   値のラベルには記号（↑・↑↑）を添える。判定は連絡帳と同じ（daycareVitalsTrend.ts の trendLevel）
// ・数値も出す: 系列ごとの最新の値は必ずラベルで出す（ほかの点の印に重なる時は文字に面の色の縁）。基準外のラベルは置ける分だけ
//   （いちばん新しい基準外 → 危険 → 注意の順）。全部の値は〔数値で見る〕の表（本物の table）
// ・グラフを押すと、いちばん近い回をグラフのすぐ下の行に出す（4つのグラフで同じ回）。〔‹ 前の回〕〔次の回 ›〕で1つずつ動かせる（キーボードで届く）。
//   行の高さは、どの回を出しても動かない（全部の回の文を同じ場所に重ねて、出す回だけ見せる）
// ・判断（回の並べ方・目盛り・判定の呼び出し・ラベルの置き場・押した回の選び方・読み直しの判断・表の言葉）は src/lib/daycareVitalsTrend.ts
//   （純関数・試験あり）。ここは測って描くだけ
// ・表示中の日の回は1人の画面が読んだ行（上のバイタルの要約と同じ行）。前の日の回と〔未測定〕の印はこの部品が読む（fetchDaycareVitalsTrend）。
//   画面に届いたその方の測定の変更（changeKey）・表示中の日の行の変わり目は、まとめて 400ms 後に読み直す
// 端末に業務データを残さない（localStorage・console を使わない）。動きは付けない。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fetchDaycareVitalsTrend } from '../lib/db'
import type { DaycareVitalField, KeyedVital } from '../lib/daycare'
import type { DaycareVitalUnmeasured } from '../lib/daycareProgress'
import type { Level } from '../lib/types'
import type { ResidentTargets } from '../lib/vitalAlerts'
import type { VitalThresholds } from '../lib/vitalThresholds'
import {
  TREND_EMPTY_DAY_UNREAD_TEXT,
  TREND_EMPTY_TEXT,
  TREND_MARKS_UNREAD_TEXT,
  TREND_ONE_TEXT,
  TREND_PANELS,
  TREND_PICK_HINT,
  TREND_ROUNDS,
  TREND_UNREAD_TEXT,
  abnormalCount,
  nearestIndex,
  roundWhen,
  stepIndex,
  trendCell,
  trendDayUnreadText,
  trendFitRounds,
  trendLayout,
  trendLevel,
  trendPanelReadout,
  trendPlotWidth,
  trendReadout,
  trendRounds,
  trendSpeech,
  trendView,
} from '../lib/daycareVitalsTrend'
import type { TrendMarker, TrendPanelSpec, TrendRound } from '../lib/daycareVitalsTrend'

interface Props {
  /** 見出し（h3）の id（画面の section の aria-labelledby） */
  headingId: string
  residentId: number
  /** 表示中の日（この日までの直近の回） */
  day: string
  /** 表示中の日が今日か（読めなかった時の言葉） */
  isToday: boolean
  /** 表示中の日のデイの測定（1人の画面が読んだ行。ほかの方の行が混ざってもその方の分だけ使う） */
  dayRows: readonly KeyedVital[]
  /** 1人の画面が表示中の日の測定を読めたか（読めない時は前の日の回だけで描き、その旨を出す） */
  dayRowsOk: boolean
  /** 個別の目標（SpO2 の下限など） */
  target: ResidentTargets | null | undefined
  /** その方のその日の基準（画面の useVitalLimits の lookup をその方で引いたもの） */
  limitsOf: (day: string) => VitalThresholds
  /** 画面の〔最新に更新〕・再試行の回数（変わったらすぐ読み直す） */
  refreshKey?: number
  /** 画面に届いたその方の測定の変更の回数（trendChangeHits。変わったらまとめて 400ms 後に読み直す） */
  changeKey?: number
}

type Load =
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; rows: KeyedVital[]; unmeasured: DaycareVitalUnmeasured[] | null }
  | { status: 'error'; key: string }

const EMPTY_ROWS: KeyedVital[] = []
const EMPTY_MARKS: DaycareVitalUnmeasured[] = []
/** 変更の知らせをまとめる時間（画面の読み直しと同じ） */
const RELOAD_DEBOUNCE_MS = 400

export function DaycareVitalsTrend({ headingId, residentId, day, isToday, dayRows, dayRowsOk, target, limitsOf, refreshKey = 0, changeKey = 0 }: Props) {
  const key = `${residentId}:${day}`
  const [load, setLoad] = useState<Load>({ status: 'loading', key })
  const [retry, setRetry] = useState(0)
  /** まとめた読み直しの回数（変更の知らせ・表示中の日の行の変わり目） */
  const [tick, setTick] = useState(0)
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

  // まとめた読み直し: 同じ人・同じ日のまま表示中の日の行が変わった時と、変更の知らせが届いた時（人・日の切り替えはすぐ読むので数えない）
  const seen = useRef({ key, mineSig, changeKey })
  const timer = useRef<number | null>(null)
  useEffect(() => {
    const prev = seen.current
    seen.current = { key, mineSig, changeKey }
    if (prev.key !== key || (prev.mineSig === mineSig && prev.changeKey === changeKey)) return
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      setTick((n) => n + 1)
    }, RELOAD_DEBOUNCE_MS)
  }, [key, mineSig, changeKey])
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
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
  }, [key, residentId, day, refreshKey, retry, tick])

  const ready = load.key === key && load.status === 'ready' ? load : null
  const pastRows = ready?.rows ?? EMPTY_ROWS
  const marks = ready === null ? EMPTY_MARKS : ready.unmeasured
  const all = useMemo(() => trendRounds(dayRows, pastRows, residentId, day, marks), [dayRows, pastRows, residentId, day, marks])
  // 点の間が狭くなりすぎる幅（375px で文字 200% など）では、新しい方から入る回だけ出す（表も同じ回）
  const fit = plotW === null ? TREND_ROUNDS : trendFitRounds(plotW)
  const rounds = useMemo(() => (all.length > fit ? all.slice(-fit) : all), [all, fit])
  const marksUnread = ready !== null && ready.unmeasured === null
  const levelOf = (r: TrendRound, f: DaycareVitalField): Level => trendLevel(r, f, target, limitsOf)
  const selIdx = sel !== null && sel.key === key ? rounds.findIndex((r) => r.id === sel.id) : -1
  const selected = selIdx >= 0 ? rounds[selIdx] : null
  const pickIdx = (i: number | null, toggle: boolean) => {
    if (i === null) return
    const r = rounds[i]
    if (r === undefined) return
    setSel((prev) => (toggle && prev !== null && prev.key === key && prev.id === r.id ? null : { key, id: r.id }))
  }
  const step = (dir: -1 | 1) => pickIdx(stepIndex(rounds.length, selIdx < 0 ? null : selIdx, dir), false)

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
      {dayRowsOk ? null : (
        <p role="status" className="rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
          <span aria-hidden="true">▲ </span>
          {trendDayUnreadText(isToday)}
        </p>
      )}
      {view.kind === 'chart' ? (
        <>
          <p className="text-sm text-ink2">
            横軸は測った回の順に等間隔（日付の間が空いても詰めています・同じ日の2回目からは「再」）
            {n < all.length && n < TREND_ROUNDS ? `。画面の幅に合わせて直近${n}回にしています` : ''}
          </p>
          <ShapeLegend />
        </>
      ) : null}
      {view.kind === 'none' ? <p className="text-base text-ink2">{dayRowsOk ? TREND_EMPTY_TEXT : TREND_EMPTY_DAY_UNREAD_TEXT}</p> : null}
      {view.kind === 'one' ? <p className="text-base text-ink2">{TREND_ONE_TEXT}</p> : null}
      {view.kind === 'chart' ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-x-6 gap-y-6">
            {TREND_PANELS.map((p) => (
              <TrendChart
                key={p.key}
                panel={p}
                rounds={rounds}
                levelOf={levelOf}
                marksUnread={marksUnread}
                selIdx={selIdx}
                onPick={(i) => pickIdx(i, true)}
                onStep={step}
                onPlotW={setPlotW}
              />
            ))}
          </div>
          {/* 読み上げ（押した回の全部の項目）。見た目の行はグラフごとの行（読み上げない） */}
          <p role="status" aria-live="polite" className="sr-only">
            {selected === null ? '' : trendReadout(selected, levelOf, marksUnread)}
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
// 印の形（グラフと凡例で同じ）
// ══════════════════════════════════════════════════════════════

/**
 * 点の印。ふつう＝系列の色の丸（血圧の下は四角）。基準外＝注意は輪郭だけ（中は面の色）・危険は塗り＋外の輪。
 * 向きは三角の向き（血圧の下は四角のまま、上か下に小さな三角）。どれも面の色の縁で線と分ける
 */
function MarkerShape({ m }: { m: Pick<TrendMarker, 'x' | 'y' | 'kind' | 'tone' | 'dir'> }) {
  const { x, y } = m
  if (m.tone === 'series') {
    if (m.kind === 'square') return <rect x={x - 4} y={y - 4} width={8} height={8} className="fill-cat-vitals stroke-surface" strokeWidth={2} />
    return <circle cx={x} cy={y} r={4} className="fill-cat-vitals stroke-surface" strokeWidth={2} />
  }
  const danger = m.tone === 'danger'
  // 注意＝輪郭だけ（中は面の色）・危険＝塗り（Tailwind が拾えるよう、色の名前は書き下す）
  const body = danger ? 'fill-danger stroke-surface' : 'fill-surface stroke-warn'
  const tone = danger ? 'fill-danger' : 'fill-warn'
  const ring = danger ? <circle cx={x} cy={y} r={11} className="fill-none stroke-danger" strokeWidth={1.5} /> : null
  if (m.kind === 'square') {
    // 血圧の下: 四角のまま＋向きの小さな三角（高い＝上・低い＝下）
    const ty = m.dir === 'up' ? y - 9 : y + 9
    const tri = m.dir === 'up' ? `${x},${ty - 4} ${x - 4},${ty + 2} ${x + 4},${ty + 2}` : `${x},${ty + 4} ${x - 4},${ty - 2} ${x + 4},${ty - 2}`
    return (
      <g>
        {ring}
        <rect x={x - 5} y={y - 5} width={10} height={10} className={body} strokeWidth={2} />
        {m.dir === null ? null : <polygon points={tri} className={tone} />}
      </g>
    )
  }
  const pts = m.dir === 'up' ? `${x},${y - 7} ${x - 7},${y + 5} ${x + 7},${y + 5}` : `${x},${y + 7} ${x - 7},${y - 5} ${x + 7},${y - 5}`
  return (
    <g>
      {ring}
      <polygon points={pts} className={body} strokeWidth={2} strokeLinejoin="round" />
    </g>
  )
}

/** 印の形の凡例（1行・グラフの上に1回） */
function ShapeLegend() {
  const key = (m: Pick<TrendMarker, 'kind' | 'tone' | 'dir'>) => (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" className="shrink-0">
      <MarkerShape m={{ ...m, x: 13, y: 13 }} />
    </svg>
  )
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink2">
      <span>基準外の印:</span>
      <span className="inline-flex items-center gap-1">
        {key({ kind: 'triangle', tone: 'warn', dir: 'up' })}
        注意
      </span>
      <span className="inline-flex items-center gap-1">
        {key({ kind: 'triangle', tone: 'danger', dir: 'up' })}
        危険
      </span>
      <span>（向き＝高い・低い。血圧の下は四角＋向き）</span>
    </p>
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
  marksUnread: boolean
  /** 押した回の添字（無ければ -1。4つのグラフで同じ） */
  selIdx: number
  /** グラフを押した（いちばん近い回の添字） */
  onPick: (i: number) => void
  /** 〔‹ 前の回〕（-1）・〔次の回 ›〕（1） */
  onStep: (dir: -1 | 1) => void
  /** 点を並べる幅を知らせる（回の数を決める） */
  onPlotW: (w: number) => void
}

function TrendChart({ panel, rounds, levelOf, marksUnread, selIdx, onPick, onStep, onPlotW }: ChartProps) {
  const { ref, probe, box } = useChartBox()
  const svgRef = useRef<SVGSVGElement>(null)
  const n = rounds.length
  const withVal = rounds.some((r) => panel.fields.some((f) => r.vals[f] !== null))
  const ab = abnormalCount(panel, rounds, levelOf)
  const speech = trendSpeech(panel, rounds, levelOf)
  const { width: W, fs } = box
  const lay = trendLayout(panel, rounds, levelOf, box)
  const plotW = trendPlotWidth(box)
  useEffect(() => {
    if (W > 0) onPlotW(plotW)
  }, [W, plotW, onPlotW])
  const prevIdx = stepIndex(n, selIdx < 0 ? null : selIdx, -1)
  const nextIdx = stepIndex(n, selIdx < 0 ? null : selIdx, 1)
  const btn = 'min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:text-ink3'

  return (
    // 枠で囲まない（欄のカードの中にカードを重ねない）。グラフどうしは間の余白で分ける
    <figure className="min-w-0">
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-base font-bold text-ink">
          {panel.title}
          <span className="ml-1 text-sm font-normal text-ink2">{panel.unit}</span>
        </span>
        {panel.key === 'bp' ? (
          // 凡例（2本の時はいつも出す）。線と点の形が線そのものと同じ
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
            基準外 <span className="font-num">{ab}</span>回
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
            height={lay.H}
            viewBox={`0 0 ${W} ${lay.H}`}
            className="block cursor-pointer select-none"
            onClick={(e) => {
              const svg = svgRef.current
              if (svg === null) return
              const rect = svg.getBoundingClientRect()
              const i = nearestIndex(lay.xs, ((e.clientX - rect.left) / (rect.width || 1)) * W)
              if (i >= 0) onPick(i)
            }}
          >
            {/* 目盛の線（区切りのよい値・細い実線） */}
            {lay.ticks.map((t) => (
              <line key={`g-${t.v}`} x1={lay.padL} x2={W - lay.padR} y1={t.y} y2={t.y} className="stroke-border" strokeWidth={1} />
            ))}
            {lay.ticks.map((t) => (
              <text key={`t-${t.v}`} x={lay.padL - 6} y={t.y + Math.round(fs * 0.35)} textAnchor="end" className="fill-ink2 font-num text-sm">
                {t.text}
              </text>
            ))}
            {/* 押した回（縦の細い線） */}
            {selIdx >= 0 && selIdx < n ? (
              <line x1={lay.xs[selIdx]} x2={lay.xs[selIdx]} y1={lay.padT - 4} y2={lay.padT + lay.plotH + 4} className="stroke-border-strong" strokeWidth={1} />
            ) : null}
            {/* 線（値の無い回で切る・2px の実線。血圧の上・下は点の形と名前で見分ける） */}
            {lay.lines.map((l) => (
              <polyline
                key={`l-${l.field}-${l.points[0][0]}`}
                points={l.points.map(([px, py]) => `${px},${py}`).join(' ')}
                className="fill-none stroke-cat-vitals"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {/* 点（8px・面の色の縁。基準外は注意＝輪郭・危険＝塗り＋輪と向き） */}
            {lay.markers.map((m) => (
              <MarkerShape key={`m-${m.id}`} m={m} />
            ))}
            {/* 直接のラベル（文字の色。系列の色は文字に使わない。印や線に重なっても読めるよう面の色の縁） */}
            {lay.labels.map((l) => (
              <text
                key={`v-${l.id}`}
                x={l.x}
                y={l.y}
                textAnchor={l.anchor}
                paintOrder="stroke"
                strokeWidth={4}
                strokeLinejoin="round"
                className={`fill-ink stroke-surface font-num text-sm${l.latest ? ' font-bold' : ''}`}
              >
                {l.text}
              </text>
            ))}
            {/* 横軸の日付（同じ日の2回目からは「再n」） */}
            {lay.xLabels.map((t) => (
              <text
                key={`x-${rounds[t.i].id}`}
                x={t.x}
                y={lay.H - Math.ceil(fs * 0.3)}
                textAnchor="middle"
                className={`font-num text-sm ${t.i === selIdx ? 'fill-ink font-bold' : 'fill-ink2'}`}
              >
                {t.text}
              </text>
            ))}
          </svg>
        )}
      </div>
      {withVal ? (
        <div className="mt-1 space-y-1">
          {/* 押した回の行（このグラフの項目）。全部の回の文を同じ場所に重ね、出す回だけ見せる＝どの回でも高さが動かない。読み上げは欄の下の1か所 */}
          <div className="grid text-sm text-ink" aria-hidden="true">
            <p className={`[grid-area:1/1] text-ink2 ${selIdx < 0 ? '' : 'invisible'}`}>{TREND_PICK_HINT}</p>
            {rounds.map((r, i) => (
              <p key={r.id} className={`[grid-area:1/1] ${i === selIdx ? '' : 'invisible'}`}>
                {trendPanelReadout(panel, r, levelOf, marksUnread)}
              </p>
            ))}
          </div>
          <div className="flex flex-wrap gap-gap" role="group" aria-label={`${panel.title}のグラフの回を動かす`}>
            <button type="button" onClick={() => onStep(-1)} disabled={prevIdx === null} className={btn}>
              <span aria-hidden="true">‹ </span>前の回
            </button>
            <button type="button" onClick={() => onStep(1)} disabled={nextIdx === null} className={btn}>
              次の回<span aria-hidden="true"> ›</span>
            </button>
          </div>
        </div>
      ) : null}
    </figure>
  )
}
