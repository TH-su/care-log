// ひと目ボードのバイタルの札（体温・血圧・脈・SpO2）と「体重減少の目安」。props だけで描く（DB を読まない）。
// ・各札: 最新（日・時刻）・直近の平均・基準（その前の28日）の平均・差と向き（↑／↓／→ の記号＋文字）・14日の小さい線
// ・平均は記録のある日だけで割る（glance.ts の computeGlance が数えた値をそのまま出す）。記録が無い所は「—」
// ・体重の見出しは「体重減少の目安」（低栄養の判定ではない）。基準の計測が無い期間は「—」
// 縦軸は chart.ts の chartDomain＋KARTE_AXES（カルテのグラフと同じ決め方）。色はトークンのクラスだけ。

import type { ReactNode } from 'react'
import { KARTE_AXES, chartDomain } from '../../lib/chart'
import type { Direction, Severity, VitalKey, VitalStat, WeightLoss } from '../../lib/glance'
import { DIRECTION_MARK, SEVERITY_LABEL, SEVERITY_SYMBOL } from '../../lib/glance'
import { GlanceSpark } from './GlanceSpark'

export type GlanceSourceState = { status: 'loading' } | { status: 'unconfigured'; message: string } | { status: 'error'; message: string } | { status: 'ready' }

export interface VitalCardsProps {
  vitals: Record<VitalKey, VitalStat>
  usualTemp: number | null
  /** 直近の日数（7 か 14） */
  recentDays: number
  weight: WeightLoss | null
  weightSource: GlanceSourceState
  /** 強調する（兆しから移ってきた時） */
  highlight?: boolean
  id: string
}

const DIR_TEXT: Readonly<Record<Direction, string>> = { up: '上がった', down: '下がった', flat: '横ばい' }

function fmt(n: number | null | undefined, digits: number): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '—'
}

function signed(n: number | null, digits: number): string {
  if (n === null || !Number.isFinite(n)) return '—'
  const s = Math.abs(n).toFixed(digits)
  // 丸めて0になる差は向きの記号を付けない（「−0」と出さない）
  if (Number(s) === 0) return `±${s}`
  return n > 0 ? `+${s}` : `−${s}`
}

const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`

function Trend({ diff, dir, digits }: { diff: number | null; dir: Direction | null; digits: number }) {
  if (dir === null) return <span className="text-ink3">差 —</span>
  return (
    <span className="tabular text-ink">
      <span aria-hidden="true">{DIRECTION_MARK[dir]} </span>
      <span className="sr-only">{DIR_TEXT[dir]} </span>
      {signed(diff, digits)}
    </span>
  )
}

function Card({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded border border-border bg-surface px-3 py-2">
      <h3 className="text-sm font-bold text-ink2">{title}</h3>
      {children}
    </div>
  )
}

function StatCard({ title, unit, stat, digits, axis, recentDays }: { title: string; unit: string; stat: VitalStat; digits: number; axis: (typeof KARTE_AXES)[keyof typeof KARTE_AXES]; recentDays: number }) {
  const domain = chartDomain(stat.spark.filter((v): v is number => typeof v === 'number'), axis)
  return (
    <Card title={title}>
      <p className="flex items-baseline justify-between gap-2">
        <span className="tabular text-xl font-heavy text-ink">
          {stat.latest ? fmt(stat.latest.value, digits) : '—'}
          <span className="ml-1 text-sm font-normal text-ink2">{unit}</span>
        </span>
        <span className="tabular text-xs text-ink3">{stat.latest ? `${md(stat.latest.day)} ${stat.latest.time ?? ''}` : '記録なし'}</span>
      </p>
      <p className="tabular text-sm text-ink2">
        {recentDays}日 {fmt(stat.recentAvg, digits)}・基準 {fmt(stat.baseAvg, digits)}・<Trend diff={stat.diff} dir={stat.dir} digits={digits} />
      </p>
      <GlanceSpark values={stat.spark} domain={domain} label={`${title}の14日`} digits={digits} />
    </Card>
  )
}

function BpCard({ sys, dia, recentDays }: { sys: VitalStat; dia: VitalStat; recentDays: number }) {
  const vals = [...sys.spark, ...dia.spark].filter((v): v is number => typeof v === 'number')
  const domain = chartDomain(vals, KARTE_AXES.bp)
  return (
    <Card title="血圧">
      <p className="flex items-baseline justify-between gap-2">
        <span className="tabular text-xl font-heavy text-ink">
          {sys.latest || dia.latest ? `${fmt(sys.latest?.value, 0)}/${fmt(dia.latest?.value, 0)}` : '—'}
          <span className="ml-1 text-sm font-normal text-ink2">mmHg</span>
        </span>
        <span className="tabular text-xs text-ink3">{sys.latest ? `${md(sys.latest.day)} ${sys.latest.time ?? ''}` : '記録なし'}</span>
      </p>
      <p className="tabular text-sm text-ink2">
        {recentDays}日 {fmt(sys.recentAvg, 0)}/{fmt(dia.recentAvg, 0)}・基準 {fmt(sys.baseAvg, 0)}/{fmt(dia.baseAvg, 0)}
      </p>
      <p className="tabular text-sm text-ink2">
        上 <Trend diff={sys.diff} dir={sys.dir} digits={0} />・下 <Trend diff={dia.diff} dir={dia.dir} digits={0} />
      </p>
      <GlanceSpark values={sys.spark} domain={domain} label="血圧（上）の14日" />
    </Card>
  )
}

function SevMark({ level }: { level: Severity | null }) {
  if (level === null) return null
  return (
    <span className={`font-bold ${level === 'danger' ? 'text-danger' : 'text-warn'}`}>
      <span aria-hidden="true">{SEVERITY_SYMBOL[level]} </span>
      {SEVERITY_LABEL[level]}
    </span>
  )
}

function WeightCard({ weight, source }: { weight: WeightLoss | null; source: GlanceSourceState }) {
  let body: ReactNode
  if (source.status === 'loading') body = <p className="text-sm text-ink3">体重の記録を読み込み中です…</p>
  else if (source.status !== 'ready' || weight === null) {
    body = <p className="text-sm text-ink3">{source.status === 'ready' ? '—（カルテで確認）' : `${source.message}（カルテで確認）`}</p>
  } else if (weight.latest === null) body = <p className="text-sm text-ink3">体重の記録がまだありません。</p>
  else {
    body = (
      <>
        <p className="tabular text-sm text-ink">
          最新 <span className="text-lg font-heavy">{weight.latest.weight.toFixed(1)}</span> kg（{md(weight.latest.date)}）
        </p>
        <ul className="tabular text-sm text-ink2">
          {weight.periods.map((p) => (
            <li key={p.months}>
              {p.months}か月: {p.lossPct === null ? '—' : `${p.lossPct >= 0 ? '−' : '+'}${Math.abs(p.lossPct).toFixed(1)}%`}
              {p.base ? `（基準 ${md(p.base.date)} ${p.base.weight.toFixed(1)}kg）` : '（基準の計測なし）'} <SevMark level={p.level} />
            </li>
          ))}
        </ul>
      </>
    )
  }
  return <Card title="体重減少の目安">{body}</Card>
}

export function VitalCards({ vitals, usualTemp, recentDays, weight, weightSource, highlight = false, id }: VitalCardsProps) {
  return (
    <section id={id} tabIndex={-1} aria-labelledby={`${id}-h`} className={`rounded-lg border bg-surface2 p-2 ${highlight ? 'border-focus ring-2 ring-focus' : 'border-border'}`}>
      <h2 id={`${id}-h`} className="px-1 text-base font-bold text-ink">
        バイタル<span className="ml-2 text-sm font-normal text-ink2">直近{recentDays}日の平均と、その前の28日の平均（基準）</span>
      </h2>
      <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <StatCard title={`体温（平熱 ${usualTemp === null ? '—' : usualTemp.toFixed(1)}）`} unit="℃" stat={vitals.temp} digits={1} axis={KARTE_AXES.temp} recentDays={recentDays} />
        <BpCard sys={vitals.sysBp} dia={vitals.diaBp} recentDays={recentDays} />
        <StatCard title="脈拍" unit="回/分" stat={vitals.pulse} digits={0} axis={KARTE_AXES.pulse} recentDays={recentDays} />
        <StatCard title="SpO2" unit="%" stat={vitals.spo2} digits={0} axis={KARTE_AXES.spo2} recentDays={recentDays} />
      </div>
      <div className="mt-2">
        <WeightCard weight={weight} source={weightSource} />
      </div>
    </section>
  )
}

export default VitalCards
