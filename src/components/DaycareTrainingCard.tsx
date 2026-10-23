// デイ（せせらぎ）段階3a: 1人の1日記録の画面の「機能訓練」のカード（読むだけ）。
// その方・その日の個別機能訓練の実施記録を1行で出し、記録は機能訓練の画面（/record/daycare/training）で行う（入口を置く）。
// 表が無い DB（0046 未適用）・旗が閉じている間も、読めた分だけ出す（書き込みはこの部品から行わない）。
// 端末に業務データを残さない（localStorage を使わない）。

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchTrainingSessions, isTrainingMissingError } from '../lib/db'
import { sessionOf, sessionText } from '../lib/daycareTraining'
import type { DaycareTrainingSession } from '../lib/daycareTraining'

interface Props {
  residentId: number
  day: string
  today: string
  /** 画面の〔最新に更新〕の回数（変わったら読み直す） */
  refreshKey?: number
  /** 指導員の名前を引く（画面の職員名簿） */
  staffName: (id: number) => string
}

type State = { status: 'loading' } | { status: 'missing' } | { status: 'error' } | { status: 'ready'; row: DaycareTrainingSession | null }

export function DaycareTrainingCard({ residentId, day, today, refreshKey = 0, staffName }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' })
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
            : state.status === 'error'
              ? '機能訓練の記録を読み込めませんでした。〔最新に更新〕を押してください。'
              : state.row === null
                ? '記録なし'
                : `${sessionText(state.row)}・指導員 ${staffName(state.row.instructor_id)}`}
      </p>
      <Link to={to} className="inline-flex min-h-tap items-center rounded-full border border-primary bg-surface px-4 text-base font-bold text-primary">
        機能訓練の画面で記録する<span aria-hidden="true"> ›</span>
      </Link>
    </section>
  )
}
