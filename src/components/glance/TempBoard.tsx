// ひと目ボードの温度板（直近14日の行列）。props だけで描く（DB を読まない）。
// ・上に体温の日ごとの平均の線（chart.ts の chartDomain＋KARTE_AXES.temp・自前の SVG。外部のグラフ部品は使わない）
// ・下に日ごとの表: 体温・血圧・脈・SpO2・朝昼夕の食事（10段階）・水分（目標比 %）・排便の回数・与薬の未／拒否・入浴・申し送り・事故
// ・基準外の測定がある日は記号（!! 要注意・! 注意）を数字の前に付ける（色だけに頼らない）
// ・入院中／外泊中の日は列の見出しに「入院」「外泊」、日帰りの外出は「外出」と出す（その日の印は glance.ts が数えていない）
// ・記録の無い所は「·」（読み上げは「なし」）。横に入りきらない幅では表だけ横に動かす

import type { ReactNode } from 'react'
import { KARTE_AXES, chartDomain } from '../../lib/chart'
import type { TempBoardDay } from '../../lib/glance'
import { SEVERITY_SYMBOL } from '../../lib/glance'
import { BATH_RESULT_MARK } from '../../lib/types'
import { MEAL_FULL } from '../../lib/vitalThresholds'

export interface TempBoardProps {
  board: readonly TempBoardDay[]
  today: string
  highlight?: boolean
  id: string
}

const W = 280
const H = 56
const PAD = 4

const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`
const WEEK = ['日', '月', '火', '水', '木', '金', '土']
const wd = (iso: string) => WEEK[new Date(`${iso}T00:00:00Z`).getUTCDay()] ?? ''

function TempLine({ board }: { board: readonly TempBoardDay[] }) {
  const vals = board.map((d) => d.temp)
  const [lo, hi] = chartDomain(vals.filter((v): v is number => typeof v === 'number'), KARTE_AXES.temp)
  const n = vals.length
  const span = hi - lo
  const pts = vals.map((v, i) =>
    typeof v === 'number' && span > 0 ? { x: n <= 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (n - 1), y: PAD + ((hi - Math.min(hi, Math.max(lo, v))) * (H - PAD * 2)) / span } : null,
  )
  let d = ''
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    if (!p) continue
    d += `${i > 0 && pts[i - 1] ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)} `
  }
  const speech = `体温の14日 ${vals.map((v) => (typeof v === 'number' ? v.toFixed(1) : '記録なし')).join('、')}`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-14 w-full" role="img" aria-label={speech} preserveAspectRatio="none">
      <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {d !== '' ? <path d={d.trim()} className="fill-none stroke-ink2" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" /> : null}
      {pts.map((p, i) =>
        p ? <circle key={i} cx={p.x} cy={p.y} r={2} className={board[i].vitalSeverity === 'danger' ? 'fill-danger' : board[i].vitalSeverity === 'warn' ? 'fill-warn' : 'fill-ink2'} /> : null,
      )}
    </svg>
  )
}

function Empty() {
  return (
    <>
      <span aria-hidden="true" className="text-ink3">·</span>
      <span className="sr-only">なし</span>
    </>
  )
}

const n0 = (v: number | null) => (v === null ? null : String(Math.round(v)))
const n1 = (v: number | null) => (v === null ? null : v.toFixed(1))
const meal10 = (v: number | null) => (v === null ? null : String(Math.round((v * 10) / MEAL_FULL)))

interface RowDef {
  label: string
  cell: (d: TempBoardDay) => ReactNode | string | null
}

const ROWS: RowDef[] = [
  {
    label: '体温',
    cell: (d) =>
      d.temp === null ? null : (
        <>
          {d.vitalSeverity ? <span className={`font-bold ${d.vitalSeverity === 'danger' ? 'text-danger' : 'text-warn'}`}>{SEVERITY_SYMBOL[d.vitalSeverity]}</span> : null}
          {n1(d.temp)}
        </>
      ),
  },
  { label: '血圧', cell: (d) => (d.sysBp === null && d.diaBp === null ? null : `${n0(d.sysBp) ?? '—'}/${n0(d.diaBp) ?? '—'}`) },
  { label: '脈', cell: (d) => n0(d.pulse) },
  { label: 'SpO2', cell: (d) => n0(d.spo2) },
  { label: '朝', cell: (d) => meal10(d.meals.breakfast) },
  { label: '昼', cell: (d) => meal10(d.meals.lunch) },
  { label: '夕', cell: (d) => meal10(d.meals.dinner) },
  { label: '水分%', cell: (d) => (d.fluidPct === null ? null : String(d.fluidPct)) },
  { label: '排便', cell: (d) => (d.stools === null ? '—' : d.stools === 0 ? null : String(d.stools)) },
  {
    label: '与薬',
    cell: (d) => (d.medMissing + d.medRefused === 0 ? null : [d.medMissing > 0 ? `未${d.medMissing}` : '', d.medRefused > 0 ? `拒${d.medRefused}` : ''].filter((s) => s !== '').join(' ')),
  },
  { label: '入浴', cell: (d) => (d.bathCancelled ? '中止' : d.bath ? BATH_RESULT_MARK[d.bath] : null) },
  { label: '申送', cell: (d) => (d.notesCritical > 0 ? `最重${d.notesCritical}` : d.notesHealth > 0 ? `体調${d.notesHealth}` : null) },
  { label: '事故', cell: (d) => (d.incidents > 0 ? String(d.incidents) : null) },
]

export function TempBoard({ board, today, highlight = false, id }: TempBoardProps) {
  return (
    <section id={id} tabIndex={-1} aria-labelledby={`${id}-h`} className={`min-w-0 rounded-lg border bg-surface p-2 ${highlight ? 'border-focus ring-2 ring-focus' : 'border-border'}`}>
      <h2 id={`${id}-h`} className="px-1 text-base font-bold text-ink">
        温度板<span className="ml-2 text-sm font-normal text-ink2">直近14日（食事は10段階・水分は目標比）</span>
      </h2>
      <TempLine board={board} />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <caption className="sr-only">温度板（直近14日の日ごとの記録）</caption>
          <thead>
            <tr className="border-b border-border text-ink2">
              <th scope="col" className="px-1 py-0.5 text-left font-bold">
                日
              </th>
              {board.map((d) => (
                <th key={d.day} scope="col" className={`tabular px-0.5 py-0.5 text-center font-normal ${d.day === today ? 'font-bold text-ink' : ''}`}>
                  <span className="block">{md(d.day)}</span>
                  <span className="block">{wd(d.day)}</span>
                  {d.away === 'hospital' ? <span className="block text-info">入院</span> : d.away === 'overnight' ? <span className="block text-info">外泊</span> : d.outing ? <span className="block text-info">外出</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.label} className="border-b border-border">
                <th scope="row" className="whitespace-nowrap px-1 py-0.5 text-left font-bold text-ink2">
                  {r.label}
                </th>
                {board.map((d) => {
                  const v = r.cell(d)
                  return (
                    <td key={d.day} className="tabular whitespace-nowrap px-0.5 py-0.5 text-center text-ink">
                      {v === null || v === '' ? <Empty /> : v}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default TempBoard
