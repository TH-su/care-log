// ひと目ボードの食事・水分・排便の札。props だけで描く（DB を読まない）。
// ・食事: 1食の主食＋副食を10段階に直した平均（直近／基準・差と向き）、主食・副食、朝昼夕の別、摂取低下の連続日数
// ・水分: 1日平均（直近／基準・差と向き）と目標（個別の目標があればそれ。fluidTargetOf）に対する割合
// ・排便: 札に必ず「直近14日」と書く。最後の排便から◯日・14日の回数・平均の間隔。判定は排便記録アプリの写し（excretionClient）
//   端末が排便記録に未接続・照合できない時は「—（カルテで確認）」と理由
// 数は glance.ts の computeGlance が数えた値をそのまま出す。記号＋文字で示し色だけに頼らない。
// 幅 1024 以上（lg）は3つの札を縦に並べ、札の中は見出しと各行を続けて流し（入りきらない所で折り返す）、余白と文字を1段詰める
// （1366×768 で区画の中身を縦に動かさずに見せるため）

import type { ReactNode } from 'react'
import type { Direction, GlanceIntake } from '../../lib/glance'
import { DIRECTION_MARK, GLANCE_RULES } from '../../lib/glance'
import type { GlanceSourceState } from './VitalCards'

export interface IntakeCardsProps {
  intake: GlanceIntake
  recentDays: number
  excretionSource: GlanceSourceState
  highlight?: boolean
  id: string
}

const DIR_TEXT: Readonly<Record<Direction, string>> = { up: '上がった', down: '下がった', flat: '横ばい' }

const f1 = (n: number | null) => (n === null || !Number.isFinite(n) ? '—' : n.toFixed(1))
const f0 = (n: number | null) => (n === null || !Number.isFinite(n) ? '—' : String(Math.round(n)))

function Trend({ diff, dir, digits, unit = '' }: { diff: number | null; dir: Direction | null; digits: number; unit?: string }) {
  if (dir === null || diff === null) return <span className="text-ink3">差 —</span>
  const s = Math.abs(diff).toFixed(digits)
  return (
    <span className="tabular text-ink">
      <span aria-hidden="true">{DIRECTION_MARK[dir]} </span>
      <span className="sr-only">{DIR_TEXT[dir]} </span>
      {Number(s) === 0 ? `±${s}` : diff > 0 ? `+${s}` : `−${s}`}
      {unit}
    </span>
  )
}

function Card({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded border border-border bg-surface px-3 py-2 lg:flex lg:flex-wrap lg:items-baseline lg:gap-x-2 lg:px-2 lg:py-0.5">
      <h3 className="text-sm font-bold text-ink2 lg:text-xs">{title}</h3>
      {children}
    </div>
  )
}

function Mark({ level, text }: { level: 'danger' | 'warn'; text: string }) {
  return (
    <span className={`font-bold ${level === 'danger' ? 'text-danger' : 'text-warn'}`}>
      <span aria-hidden="true">{level === 'danger' ? '!!' : '!'} </span>
      {text}
    </span>
  )
}

function StoolCard({ intake, source }: { intake: GlanceIntake; source: GlanceSourceState }) {
  const ex = intake.excretion
  let body: ReactNode
  if (source.status === 'loading') body = <p className="text-sm text-ink3 lg:text-xs">排便記録を読み込み中です…</p>
  else if (source.status !== 'ready') body = <p className="text-sm text-ink3 lg:text-xs">{source.message}（—（カルテで確認））</p>
  else if (ex.state === 'unconnected') body = <p className="text-sm text-ink3 lg:text-xs">—（カルテで確認）</p>
  else if (ex.state === 'unlinked') body = <p className="text-sm text-ink3 lg:text-xs">{ex.message}（—（カルテで確認））</p>
  else {
    const s = ex.status
    const daysText = s.days === null ? '日時不明' : `${s.days}日${s.atLeast ? '以上' : ''}`
    body = (
      <>
        <p className="tabular text-sm text-ink lg:text-xs">
          最後の排便から <span className="text-lg font-heavy lg:text-sm">{daysText}</span>
          {ex.hospital ? <span className="ml-1 text-ink2">（入院中のため判定しません）</span> : ex.dayOnly ? <span className="ml-1 text-ink2">（デイだけの方のため判定しません）</span> : s.level !== 'ok' ? <> <Mark level={s.level === 'danger' ? 'danger' : 'warn'} text={s.level === 'danger' ? '要注意' : '注意'} /></> : null}
        </p>
        <p className="tabular text-sm text-ink2 lg:text-xs">
          14日で {ex.count}回・平均の間隔 {ex.avgIntervalDays === null ? '—' : `${ex.avgIntervalDays.toFixed(1)}日`}
        </p>
      </>
    )
  }
  return <Card title={`排便（直近${GLANCE_RULES.stoolWindowDays}日）`}>{body}</Card>
}

export function IntakeCards({ intake, recentDays, excretionSource, highlight = false, id }: IntakeCardsProps) {
  const m = intake.meal
  const fl = intake.fluid
  return (
    <section id={id} tabIndex={-1} aria-labelledby={`${id}-h`} className={`relative rounded-lg border bg-surface2 p-2 lg:min-h-0 lg:flex-auto lg:overflow-y-auto lg:p-1.5 ${highlight ? 'border-focus ring-2 ring-focus' : 'border-border'}`}>
      <h2 id={`${id}-h`} className="px-1 text-base font-bold text-ink lg:text-sm">
        食事・水分・排便
      </h2>
      <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1 lg:gap-1">
        <Card title="食事（10段階）">
          <p className="tabular text-sm text-ink lg:text-xs">
            {recentDays}日 <span className="text-lg font-heavy lg:text-sm">{f1(m.recentAvg10)}</span>・基準 {f1(m.baseAvg10)}・<Trend diff={m.diff} dir={m.dir} digits={1} />
          </p>
          {/* lg は主食・副食と朝昼夕を1行に続ける（入りきらなければ折り返す） */}
          <div className="lg:flex lg:basis-full lg:flex-wrap lg:gap-x-2">
            <p className="tabular text-sm text-ink2 lg:text-2xs">
              主食 {f1(intake.main.recent)}（{f1(intake.main.base)}）・副食 {f1(intake.side.recent)}（{f1(intake.side.base)}）
            </p>
            <p className="tabular text-sm text-ink2 lg:text-2xs">
              朝 {f1(intake.bySlot.breakfast.recent)}・昼 {f1(intake.bySlot.lunch.recent)}・夕 {f1(intake.bySlot.dinner.recent)}
            </p>
          </div>
          {intake.lowStreak > 0 ? (
            <p className="text-sm lg:text-xs">
              <Mark level="warn" text={`摂取低下 ${intake.lowStreak}日目`} />
            </p>
          ) : null}
        </Card>
        <Card title={`水分（目標 ${f0(fl.targetMl)}ml${fl.individual ? '・個別' : ''}）`}>
          <p className="tabular text-sm text-ink lg:text-xs">
            {recentDays}日 <span className="text-lg font-heavy lg:text-sm">{f0(fl.recentAvgMl)}</span>ml（{fl.recentPct === null ? '—' : `${fl.recentPct}%`}）
          </p>
          <p className="tabular text-sm text-ink2 lg:text-xs">
            基準 {f0(fl.baseAvgMl)}ml・<Trend diff={fl.diff} dir={fl.dir} digits={0} unit="ml" />
          </p>
          <p className="tabular text-sm text-ink2 lg:text-xs">
            直近{GLANCE_RULES.fluidDays}日 {f0(fl.shortAvgMl)}ml（{fl.shortPct === null ? '—' : `${fl.shortPct}%`}）
          </p>
        </Card>
        <StoolCard intake={intake} source={excretionSource} />
      </div>
    </section>
  )
}

export default IntakeCards
