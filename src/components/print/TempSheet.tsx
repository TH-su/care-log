// 温度板（A7・2026-10-16 本人回答）の紙。カルテの方ごとの画面の〔温度板を印刷〕から出す。A4 縦1枚・白地に黒。
//
// 使い方（KartePage）:
//   {sheetOpen ? (<TempSheetPrint model={…} … onDone={() => setSheetOpen(false)} />) : null}
//   ボタンを押した時だけ置く。置くと中身が描けたところで印刷し、印刷が終わったら（afterprint）onDone で外してもらう。
//   常に置かない理由: PrintArea は置いてある間の Ctrl+P / ⌘P も自分の印刷にする（beforeprint）ため、置きっぱなしにすると
//   今までのカルテの印刷（画面をそのまま刷る）ができなくなる。
//
// 組み方: 既存の PrintArea（A4・余白 8mm・1枚に収まる文字の大きさを探す）を orientation="portrait" で使うだけ。
//   PrintArea.tsx・print.css は変えない。この紙だけの組み方は tempSheet.css（.cl-print-area の中だけに効く）。
//   グラフは SVG（幅は紙いっぱい・座標は mm 相当の viewBox＝文字の大きさを縮めても形は変わらない）。日の列は下の表の列と
//   同じ位置（左の見出しの列 22・日の列 172÷14）。線と文字は currentColor（print.css が黒にする）。
//   半分以下の食事の斜線は SVG の線で描く（CSS の背景は、ブラウザの既定では紙に出ないため使わない）。
// 中身の数（1日1点・印・斜線・連続日数・目標比）は tempSheetModel.ts（純関数・試験あり）。ここは描くだけ。
// console に何も出さない。氏名は紙に出すだけで保存しない。

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { PrintArea } from './PrintArea'
import type { PrintAreaHandle } from './PrintArea'
import { axisRange, scaleY } from './tempSheetModel'
import type { TempSheetModel } from './tempSheetModel'
import { fmtMl, fmtUsualTemp } from '../../lib/vitalAlerts'
import { changedFromText } from '../../lib/vitalLimits'
import './tempSheet.css'

/** viewBox の幅（A4 縦の印刷できる幅 194mm と同じ数） */
const VB_W = 194
/** 左の見出しの列の幅（表の最初の列と同じ割合） */
const LABEL_W = 22
/** 表の最初の列の幅（%）。グラフの日の位置と表の列をそろえる */
const LABEL_PCT = `${((LABEL_W / VB_W) * 100).toFixed(4)}%`
const PLOT_TOP = 3
const PLOT_BOTTOM_PAD = 2.5
/** 軸の文字・点の値の文字の大きさ（viewBox の単位＝mm 相当） */
const FS_AXIS = 2.4
const FS_VALUE = 2.1
const FS_MARK = 2.1

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土']

function dayHead(iso: string): { md: string; wd: string } {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return { md: `${m}/${d}`, wd: `（${WEEKDAY[dt.getUTCDay()]}）` }
}

/** その日の点の横の位置 */
function xOf(i: number, n: number): number {
  const colW = (VB_W - LABEL_W) / n
  return LABEL_W + (i + 0.5) * colW
}

interface Series {
  values: (number | null)[]
  marks: (string | null)[]
  digits: number
  /** 破線（2本目の線） */
  dashed?: boolean
  /** 白抜きの点（2本目の点） */
  hollow?: boolean
  /** 値の文字を点の下に置く（2本目） */
  valueBelow?: boolean
}

interface ChartProps {
  title: string
  unit: string
  height: number
  range: [number, number]
  tickStep: number
  /** 基準の線（破線） */
  lines: { y: number }[]
  /** 平熱の線（点線・右端に文字） */
  usual?: { y: number; label: string } | null
  series: Series[]
  ariaLabel: string
}

/** 1つのグラフ（日の列は表と同じ位置） */
function SheetChart({ title, unit, height, range, tickStep, lines, usual, series, ariaLabel }: ChartProps) {
  const n = series[0]?.values.length ?? 0
  const top = PLOT_TOP
  const bottom = height - PLOT_BOTTOM_PAD
  const y = (v: number) => scaleY(v, range, top, bottom)
  const ticks: number[] = []
  for (let v = range[0]; v <= range[1] + 1e-9; v += tickStep) ticks.push(Math.round(v * 100) / 100)
  const out: ReactNode[] = []

  // 目盛の線（薄く）と左の数字
  ticks.forEach((v) => {
    out.push(<line key={`g${v}`} x1={LABEL_W} x2={VB_W} y1={y(v)} y2={y(v)} stroke="currentColor" strokeWidth={0.12} strokeOpacity={0.35} />)
    out.push(
      <text key={`t${v}`} x={LABEL_W - 1} y={y(v) + FS_AXIS * 0.35} textAnchor="end" fontSize={FS_AXIS} fill="currentColor">
        {tickStep < 1 ? v.toFixed(1) : String(v)}
      </text>,
    )
  })
  // 日の区切り（表の縦線と同じ位置）
  for (let i = 0; i <= n; i++) {
    const x = LABEL_W + (i * (VB_W - LABEL_W)) / Math.max(1, n)
    out.push(<line key={`d${i}`} x1={x} x2={x} y1={top} y2={bottom} stroke="currentColor" strokeWidth={0.12} strokeOpacity={0.35} />)
  }
  // 基準の線（破線）
  lines.forEach((l, k) => {
    if (l.y < range[0] || l.y > range[1]) return
    out.push(<line key={`l${k}`} x1={LABEL_W} x2={VB_W} y1={y(l.y)} y2={y(l.y)} stroke="currentColor" strokeWidth={0.3} strokeDasharray="1.6 1" />)
  })
  // 平熱の線（点線）
  if (usual && usual.y >= range[0] && usual.y <= range[1]) {
    out.push(
      <line key="usual" x1={LABEL_W} x2={VB_W} y1={y(usual.y)} y2={y(usual.y)} stroke="currentColor" strokeWidth={0.35} strokeDasharray="0.3 0.9" strokeLinecap="round" />,
    )
    // 文字は枠の左下（点の値の文字と重ならない所）に置く
    out.push(
      <text key="usualT" x={LABEL_W + 0.8} y={bottom - 0.8} fontSize={FS_VALUE} fill="currentColor">
        {usual.label}
      </text>,
    )
  }
  // 折れ線（欠測の日で切る）と点・値・印
  series.forEach((s, si) => {
    let seg: string[] = []
    const flush = (k: number) => {
      if (seg.length > 1) {
        out.push(<polyline key={`p${si}-${k}`} points={seg.join(' ')} fill="none" stroke="currentColor" strokeWidth={0.4} strokeDasharray={s.dashed ? '1.2 0.8' : undefined} />)
      }
      seg = []
    }
    s.values.forEach((v, i) => {
      if (v == null) {
        flush(i)
        return
      }
      const cx = xOf(i, n)
      const cy = y(v)
      seg.push(`${cx.toFixed(2)},${cy.toFixed(2)}`)
      const big = s.marks[i] != null
      out.push(
        <circle key={`c${si}-${i}`} cx={cx} cy={cy} r={big ? 1.05 : 0.7} fill={s.hollow ? 'none' : 'currentColor'} stroke="currentColor" strokeWidth={0.3} />,
      )
      // 値（1本目は点の上・2本目は点の下。枠の外に出る時は反対側）
      let vy = s.valueBelow ? cy + 1.6 + FS_VALUE * 0.75 : cy - 1.6
      if (vy > bottom + 1.5) vy = cy - 1.6
      if (vy - FS_VALUE < 0) vy = cy + 1.6 + FS_VALUE * 0.75
      out.push(
        <text key={`v${si}-${i}`} x={cx} y={vy} textAnchor="middle" fontSize={FS_VALUE} fill="currentColor">
          {v.toFixed(s.digits)}
        </text>,
      )
      const mk = s.marks[i]
      if (mk) {
        const my = s.valueBelow ? vy + FS_MARK : Math.max(FS_MARK, vy - FS_VALUE)
        out.push(
          <text key={`m${si}-${i}`} x={cx} y={my} textAnchor="middle" fontSize={FS_MARK} fontWeight={700} fill="currentColor">
            {mk}
          </text>,
        )
      }
    })
    flush(s.values.length)
  })
  // 外枠
  out.push(<rect key="frame" x={LABEL_W} y={top} width={VB_W - LABEL_W} height={bottom - top} fill="none" stroke="currentColor" strokeWidth={0.25} />)
  // 左上の見出し
  out.push(
    <text key="title" x={0.5} y={top + FS_AXIS} fontSize={FS_AXIS * 1.15} fontWeight={700} fill="currentColor">
      {title}
    </text>,
  )
  if (unit) {
    out.push(
      <text key="unit" x={0.5} y={top + FS_AXIS * 2.3} fontSize={FS_AXIS * 0.9} fill="currentColor">
        {unit}
      </text>,
    )
  }
  return (
    <svg className="ts-chart" viewBox={`0 0 ${VB_W} ${height}`} role="img" aria-label={ariaLabel} preserveAspectRatio="xMidYMid meet">
      {out}
    </svg>
  )
}

/** 半分以下のマスに重ねる斜線（SVG の線＝背景の印刷設定に左右されない） */
function Hatch() {
  return (
    <svg className="ts-hatch" viewBox="0 0 10 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path
        d="M-2 4 L4 -2 M-2 10 L10 -2 M4 12 L12 4"
        stroke="currentColor"
        strokeWidth={0.8}
        strokeOpacity={0.6}
        vectorEffect="non-scaling-stroke"
        fill="none"
      />
    </svg>
  )
}

export interface TempSheetProps {
  model: TempSheetModel
  /** 氏名（紙に出すだけ） */
  name: string
  /** 居室（無ければ null） */
  room: string | null
  /** 印刷した時刻の文字（'2026/10/16 17:05'） */
  printedAt: string
}

/** 温度板の中身（PrintArea の中に置く） */
export function TempSheet({ model, name, room, printedAt }: TempSheetProps) {
  const m = model
  const n = m.days.length
  const th = m.thresholds
  const usualText = fmtUsualTemp(m.usual)
  const heads = m.days.map(dayHead)
  const first = heads[0]
  const last = heads[n - 1]
  const lim = m.spo2Limits

  const tempRange = axisRange([...m.temp, m.usual], [35, 39], 0.5)
  const bpRange = axisRange([...m.sys, ...m.dia], [60, 180], 20)
  const pulseRange = axisRange(m.pulse, [40, 120], 20)
  const spo2Range = axisRange([...m.spo2, lim.dangerBelow], [85, 100], 5)

  const mealRows: { key: 'breakfast' | 'lunch' | 'dinner'; label: string }[] = [
    { key: 'breakfast', label: '朝 主/副' },
    { key: 'lunch', label: '昼 主/副' },
    { key: 'dinner', label: '夕 主/副' },
  ]

  return (
    <div className="ts-sheet" data-temp-sheet="">
      <p className="ts-title">
        温度板（2週間）　{name}
        {room ? `　${room}` : ''}
      </p>
      <p className="ts-meta">
        期間 {first ? `${first.md}${first.wd}` : ''}〜{last ? `${last.md}${last.wd}` : ''}　印刷 {printedAt}
      </p>
      <p className="ts-meta">
        平熱 {usualText !== null ? `${usualText}℃（直近30日の定時の中央値・点線）` : 'なし（直近30日の定時の測定が5回未満か、読み込めませんでした）'}　水分の目標{' '}
        {fmtMl(m.fluidTarget.ml)}ml/日（{m.fluidTarget.individual ? '個別の目標' : '施設の既定'}）　SpO2 {lim.warnBelow}%未満で注意・
        {lim.dangerBelow}%未満で危険（{lim.individual ? '個別の下限' : '施設の基準'}）
      </p>

      <p className="ts-legend">
        体温 破線＝{th.temp.warnHigh.toFixed(1)}↑・{th.temp.dangerHigh.toFixed(1)}↑↑・{th.temp.dangerLow.toFixed(1)}↓↓
        {usualText !== null ? `　平熱+${th.usualTempRise.toFixed(1)}↑＝平熱より${th.usualTempRise.toFixed(1)}℃以上高い` : ''}
      </p>
      {/* 段階2d-2（計画の質問11・承認済みの1点）: 期間の途中で個人の基準が変わった時だけ1行。線と凡例は期間の最後の日の基準 */}
      {m.changedFrom !== null ? <p className="ts-legend">{changedFromText(m.changedFrom)}</p> : null}
      <SheetChart
        title="体温"
        unit="℃"
        height={64}
        range={tempRange}
        tickStep={0.5}
        lines={[{ y: th.temp.warnHigh }, { y: th.temp.dangerHigh }, { y: th.temp.dangerLow }]}
        usual={m.usual !== null && usualText !== null ? { y: m.usual, label: `点線＝平熱 ${usualText}℃` } : null}
        series={[{ values: m.temp, marks: m.tempMarks, digits: 1 }]}
        ariaLabel="体温の推移（2週間）"
      />
      <p className="ts-legend">
        血圧 実線・黒丸＝上（収縮期）／破線・白丸＝下（拡張期）　破線＝上{th.sysBp.dangerHigh}↑↑・上{th.sysBp.warnLow}↓・下{th.diaBp.dangerHigh}↑↑・下
        {th.diaBp.warnLow}↓
      </p>
      <SheetChart
        title="血圧"
        unit="mmHg"
        height={50}
        range={bpRange}
        tickStep={20}
        lines={[{ y: th.sysBp.dangerHigh }, { y: th.sysBp.warnLow }, { y: th.diaBp.dangerHigh }, { y: th.diaBp.warnLow }]}
        series={[
          { values: m.sys, marks: m.sysMarks, digits: 0 },
          { values: m.dia, marks: m.diaMarks, digits: 0, dashed: true, hollow: true, valueBelow: true },
        ]}
        ariaLabel="血圧の推移（2週間）"
      />
      <p className="ts-legend">
        脈拍 破線＝{th.pulse.dangerHigh}↑↑・{th.pulse.warnLow}↓　　SpO2 破線＝{lim.warnBelow}↓・{lim.dangerBelow}↓↓
        {lim.individual ? '（個別の下限）' : ''}
      </p>
      <SheetChart
        title="脈拍"
        unit="回/分"
        height={38}
        range={pulseRange}
        tickStep={20}
        lines={[{ y: th.pulse.dangerHigh }, { y: th.pulse.warnLow }]}
        series={[{ values: m.pulse, marks: m.pulseMarks, digits: 0 }]}
        ariaLabel="脈拍の推移（2週間）"
      />
      <SheetChart
        title="SpO2"
        unit="%"
        height={38}
        range={spo2Range}
        tickStep={5}
        lines={[{ y: lim.warnBelow }, { y: lim.dangerBelow }]}
        series={[{ values: m.spo2, marks: m.spo2Marks, digits: 0 }]}
        ariaLabel="SpO2 の推移（2週間）"
      />

      <table className="ts-table">
        <colgroup>
          <col style={{ width: LABEL_PCT }} />
          {m.days.map((d) => (
            <col key={d} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="ts-label">日付</th>
            {heads.map((h, i) => (
              <th key={m.days[i]}>
                {h.md}
                <br />
                {h.wd}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {mealRows.map((row) => (
            <tr key={row.key}>
              <th className="ts-label">{row.label}</th>
              {m.meals[row.key].map((c, i) => (
                <td key={m.days[i]}>
                  {c.hatched ? <Hatch /> : null}
                  <span className="ts-cell-text">{c.text}</span>
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <th className="ts-label">摂取低下</th>
            {m.lowLabels.map((t, i) => (
              <td key={m.days[i]} className="ts-strong">
                {t}
              </td>
            ))}
          </tr>
          <tr>
            <th className="ts-label">水分 ml</th>
            {m.fluid.map((f, i) => (
              <td key={m.days[i]}>{f.total}</td>
            ))}
          </tr>
          <tr>
            <th className="ts-label">目標比</th>
            {m.fluid.map((f, i) => (
              <td key={m.days[i]}>{f.ratio}</td>
            ))}
          </tr>
        </tbody>
      </table>
      <p className="ts-legend">
        食事は主食/副食（0〜10）。▲＝1食の主＋副が{th.lowIntakeMax}以下　斜線＝半分以下（主＋副が{th.mealHalf.max}以下・拒食）　▼＝摂取低下（1日に
        {th.mealHalf.minMeals}食以上が半分以下・続いた日数）　拒＝拒食　外＝外出　入＝入院　目標比＝水分の目標（{fmtMl(m.fluidTarget.ml)}ml）との比
      </p>
    </div>
  )
}

export interface TempSheetPrintProps extends TempSheetProps {
  /** 印刷が終わった・準備できなかった時（呼んだ画面がこの部品を外す） */
  onDone(): void
}

/** 置くと印刷する（中身が描けるのを待ってから）。印刷が終わったら onDone */
export function TempSheetPrint({ onDone, ...sheet }: TempSheetPrintProps) {
  const printRef = useRef<PrintAreaHandle>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    const after = () => doneRef.current()
    window.addEventListener('afterprint', after)
    let cancelled = false
    let raf = 0
    let frames = 0
    // afterprint が来ない端末（印刷の画面を閉じても知らせない場合）への備え: 印刷を頼んだ後、画面に戻った（focus）時にも外す
    const back = () => doneRef.current()
    const tick = () => {
      if (cancelled) return
      // PrintArea は置き場（body の直下）を作ってから中身を描く。中身が描けてから印刷する
      if (printRef.current !== null && document.querySelector('.cl-print-area [data-temp-sheet]') !== null) {
        printRef.current.print()
        window.addEventListener('focus', back, { once: true })
        return
      }
      frames += 1
      if (frames > 120) {
        doneRef.current() // 2秒ほど待っても描けない（起きないはず）＝外して押し直してもらう
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      window.removeEventListener('afterprint', after)
      window.removeEventListener('focus', back)
    }
  }, [])

  return (
    <PrintArea ref={printRef} orientation="portrait">
      <TempSheet {...sheet} />
    </PrintArea>
  )
}
