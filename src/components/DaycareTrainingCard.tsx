// デイ（せせらぎ）段階3a: 1人の1日記録の画面の「機能訓練」のカード（読むだけ）。
// その方・その日の個別機能訓練の実施記録を1行で出し、記録は機能訓練の画面（/record/daycare/training）で行う（入口を置く）。
// 表が無い DB（0046 未適用）は「まだ使えません」、旗が閉じている間は「まだ使い始めていません」と出し、入口を出さない
// （段階3a の反証 軽5: 試用中の画面に、押しても書けない入口を出さない）。書き込みはこの部品から行わない。
// 段階3b: その方の居宅訪問の期限を1行足す（直近の訪問日から数えた次の期限と状態・説明の記録の有無。規則は計画書の写しの設定）。
// 写しの設定を読めない時は期限を出さず「確かめられません」（既定の数え方に倒さない）。
// 端末に業務データを残さない（localStorage を使わない）。

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchHomeVisits, fetchTrainingDueCopy, fetchTrainingSessions, getKindInputGate, isTrainingMissingError, kindBlockedMessage } from '../lib/db'
import { sessionOf, sessionText } from '../lib/daycareTraining'
import type { DaycareTrainingSession } from '../lib/daycareTraining'
import { DUE_STATE_LABEL, dueState, hasExplanation, isEnded, latestVisit, nextDueOf } from '../lib/trainingDue'
import type { DaycareHomeVisit } from '../lib/daycareHomeVisit'
import type { DueCopyRow, DueCopySettings } from '../lib/trainingDue'
import { fmtDayLabel } from '../lib/format'

interface Props {
  residentId: number
  day: string
  today: string
  /** 画面の〔最新に更新〕の回数（変わったら読み直す） */
  refreshKey?: number
  /** 指導員の名前を引く（画面の職員名簿） */
  staffName: (id: number) => string
  /** その方が在籍か（名簿。在籍でない方は居宅訪問の期限を出さない）。分からなければ undefined */
  active?: boolean
}

type State = { status: 'loading' } | { status: 'missing' } | { status: 'error' } | { status: 'ready'; row: DaycareTrainingSession | null }
/** 居宅訪問の期限の1行（copy＝写しの行と設定。読めない時は 'error'） */
type VisitState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; visits: DaycareHomeVisit[]; copy: { rows: DueCopyRow[]; settings: DueCopySettings | null } | 'error' }
/** 旗: null＝まだ分からない／open＝解禁／closed＝封鎖（観測済み）／unknown＝確かめられない */
type Gate = 'open' | 'closed' | 'unknown' | null

export function DaycareTrainingCard({ residentId, day, today, refreshKey = 0, staffName, active = undefined }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [visit, setVisit] = useState<VisitState>({ status: 'loading' })
  const [gate, setGate] = useState<Gate>(null)
  useEffect(() => {
    let alive = true
    getKindInputGate('daycare_training')
      .then((g) => alive && setGate(g.observed ? (g.value === true ? 'open' : 'closed') : 'unknown'))
      .catch(() => alive && setGate('unknown'))
    return () => {
      alive = false
    }
  }, [refreshKey])
  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    fetchTrainingSessions(day)
      .then((list) => alive && setState({ status: 'ready', row: sessionOf(list, residentId, day) }))
      .catch((e: unknown) => alive && setState(isTrainingMissingError(e) ? { status: 'missing' } : { status: 'error' }))
    return () => {
      alive = false
    }
  }, [residentId, day, refreshKey])
  useEffect(() => {
    let alive = true
    setVisit({ status: 'loading' })
    Promise.all([fetchHomeVisits(residentId), fetchTrainingDueCopy().catch(() => 'error' as const)])
      .then(([visits, copy]) => alive && setVisit({ status: 'ready', visits, copy }))
      .catch(() => alive && setVisit({ status: 'error' }))
    return () => {
      alive = false
    }
  }, [residentId, refreshKey])

  /** 居宅訪問の期限の1行（表が無い・読めない・終了の方は出さない、または確かめられないと出す） */
  const visitLine = (): string | null => {
    if (state.status === 'missing' || visit.status === 'loading') return null
    if (visit.status === 'error') return '居宅訪問: 記録を読み込めませんでした（期限は確かめられません）'
    // 写しを読めない時は、既定の数え方（暦の月・28日）で仮に出し、そう書き添える（機能訓練の画面の区画と同じ扱い）
    const copy = visit.copy === 'error' ? null : visit.copy
    const copyRow = copy?.rows.find((r) => r.resident_id === residentId)
    if (isEnded(active === undefined ? undefined : { id: residentId, active }, copyRow, today)) return null
    const last = latestVisit(visit.visits, residentId)
    if (last === null) return '居宅訪問: 記録なし'
    const due = nextDueOf(last.visited_on, copy?.settings?.due_rule)
    const st = dueState(due, today, copy?.settings?.warn_days)
    const caveat = copy === null ? '（計画書の設定を読めないため、既定の数え方で仮に出しています）' : ''
    return `居宅訪問: 次の期限 ${fmtDayLabel(due)}（${DUE_STATE_LABEL[st]}）・前回 ${fmtDayLabel(last.visited_on)}${hasExplanation(last) ? '' : '・説明の記録なし'}${caveat}`
  }
  const vline = visitLine()

  const to = `/record/daycare/training${day === today ? '' : `?day=${day}`}`
  return (
    <section aria-labelledby="h-training" className="space-y-2 rounded-lg border border-border bg-surface p-3">
      <h3 id="h-training" className="text-lg font-bold text-ink">
        機能訓練
      </h3>
      <p className="text-base text-ink">
        {state.status === 'loading'
          ? '読み込んでいます…'
          : state.status === 'missing'
            ? 'デイの機能訓練の記録はまだ使えません（サーバー側の設定待ち）。'
            : gate === 'closed' && state.status === 'ready' && state.row === null
              ? `${kindBlockedMessage('daycare_training')}。`
            : state.status === 'error'
              ? '機能訓練の記録を読み込めませんでした。〔最新に更新〕を押してください。'
              : state.row === null
                ? '記録なし'
                : `${sessionText(state.row)}・指導員 ${staffName(state.row.instructor_id)}`}
      </p>
      {vline !== null ? <p className="text-base text-ink">{vline}</p> : null}
      {state.status !== 'missing' && gate !== 'closed' ? (
        <Link to={to} className="inline-flex min-h-tap items-center rounded-full border border-primary bg-surface px-4 text-base font-bold text-primary">
          機能訓練の画面で記録する<span aria-hidden="true"> ›</span>
        </Link>
      ) : null}
    </section>
  )
}
