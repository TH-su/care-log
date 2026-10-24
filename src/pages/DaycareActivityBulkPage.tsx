// デイ（せせらぎ）段階2b: 活動・レクをまとめて記録する画面（/record/daycare/bulk・?day= で業務日）。
// 2026-10-22 代表者承認・段階2の計画 v1 の 1.1（まとめて記録）／1.2（活動〔全員〕は2タップ）。
//
// ・今日のレク: 活動を1つ選ぶ（定型のチップか〔その他〕）→〔チェックした n人に入れる〕。相手は、一括の画面と同じ方（予定の方のうち
//   休み・入院中を除く全員と予定外で来た方＝activityTargets・2026-10-24 §9.4 の4。それまでは在席・帰宅だけ）で、
//   はじめは来た方（在席・帰宅）にだけチェックが付いている（まだ来ていない方は「（未到着）」の印・チェックなし＝親の検収 中2）。
//   入れる度合いは「参加」。変える時は1人の画面で
// ・画面の名前は「活動一括」（2026-10-24 §9.4。それまでは「活動をまとめて」。ルートと切り替えの key は変えない）
// ・保存は1人ずつ insertDaycareActivity（2台で同じレクを入れても、同じ度合いなら1行に合流・違えば「先に記録があります」）
// ・下に1人ずつの活動の一覧と、その方の1日の記録（前回コピーつき）への入口
// ・入力解禁は活動だけの旗 input_enabled_daycare_activity。表が無い DB は「設定待ち」
// ・端末に業務データを残さない（localStorage を使わない）。送り先（日）は押した時に固定する

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  DbError,
  FORBIDDEN_REASON,
  OUTDATED_REASON,
  fetchAllResidents,
  fetchDaycareActivities,
  fetchDaycareAttendance,
  fetchDaycareDay,
  fetchDaycarePlan,
  getKindInputGate,
  insertDaycareActivity,
  isActivityMissingError,
  isSelfWrite,
  kindBlockedMessage,
  pendingActivityOps,
  queuePending,
  queueSubscribe,
  subscribeDaycareActivityChanges,
  subscribeDaycareChanges,
} from '../lib/db'
import type { PendingActivityOp } from '../lib/db'
import { RecorderBar } from '../components/RecorderBar'
import { ErrorBlock, LoadingBlock } from '../components/ui'
import { writeDaycareHandoffFor } from '../lib/daycareHandoff'
import { buildDaycareBoard } from '../lib/daycare'
import {
  ACTIVITY_LABEL_MAX,
  DAYCARE_ACTIVITY_CHIPS,
  activitiesOf,
  activityLabelError,
  activityDefaultChecked,
  activityTargets,
  activityText,
  bulkResultText,
  normalizeActivityLabel,
} from '../lib/daycareActivity'
import type { ActivityAddOutcome, DaycareActivity } from '../lib/daycareActivity'
import { personPath, readPersonDay } from '../lib/daycarePerson'
import { addDays, fmtDayLabel, todayIso } from '../lib/format'
import type { DaycareAttendance, DaycareDay, DaycarePlanRow, DaycarePlanSource, Resident, Staff } from '../lib/types'
import { DaycareNav } from './DaycarePage'

const ERR_LOAD = 'デイの記録を読み込めませんでした。通信状態を確認して、再試行してください。'
const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから入れてください。'
const MSG_GATE_UNKNOWN =
  'デイの活動の記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。記録の閲覧はこのままできます。'
const MSG_MISSING = 'デイの活動の記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。'

/** まとめて記録の画面のルート（業務日は ?day= で持つ。今日は付けない） */
export function bulkPath(day: string, today: string): string {
  return `/record/daycare/bulk${day === today ? '' : `?day=${day}`}`
}

interface BulkData {
  day: string
  planRows: DaycarePlanRow[]
  planSource: DaycarePlanSource
  attendance: DaycareAttendance[]
  /** null＝読めない（表が無い・通信エラー） */
  activities: DaycareActivity[] | null
  activityMissing: boolean
}

export interface DaycareActivityBulkPageProps {
  staff?: Staff[] | null
  actorId?: number | null
}

export function DaycareActivityBulkPage({ staff = undefined, actorId = null }: DaycareActivityBulkPageProps = {}) {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const [today, setToday] = useState(todayIso())
  const day = readPersonDay(search.get('day'), today)
  const [data, setData] = useState<BulkData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [residents, setResidents] = useState<Resident[]>([])
  const [gate, setGate] = useState<{ value: boolean; observed: boolean; forbidden?: true; outdated?: true } | null>(null)
  const [label, setLabel] = useState<string | null>(null)
  const [otherText, setOtherText] = useState('')
  /** 人が押して変えたチェック（rid → チェックの有無）。押していない方は activityDefaultChecked（来た方だけ最初からチェック） */
  const [picked, setPicked] = useState<Map<number, boolean>>(new Map())
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ day: string; tone: 'info' | 'warn'; text: string } | null>(null)
  const [, setQueueTick] = useState(0)
  const genRef = useRef(0)
  const dayRef = useRef(day)
  dayRef.current = day

  useEffect(() => {
    const t = window.setInterval(() => setToday(todayIso()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    let alive = true
    setGate(null)
    getKindInputGate('daycare_activity')
      .then((g) => alive && setGate(g))
      .catch(() => alive && setGate({ value: false, observed: false }))
    fetchAllResidents()
      .then((all) => alive && setResidents(all))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [reloadKey])

  const load = useCallback(async (target: string, quiet: boolean) => {
    const gen = ++genRef.current
    if (!quiet) {
      setLoading(true)
      setError(null)
    }
    try {
      let snapshot: DaycareDay | null = null
      let missing = false
      try {
        snapshot = await fetchDaycareDay(target)
      } catch (e) {
        if (e instanceof DbError && e.kind === 'server') missing = true
        else throw e
      }
      const usable = snapshot !== null && snapshot.plan_source !== 'unknown'
      let activityMissing = false
      const [plan, attendance, activities] = await Promise.all([
        usable ? Promise.resolve(null) : fetchDaycarePlan(target),
        missing ? Promise.resolve([] as DaycareAttendance[]) : fetchDaycareAttendance(target),
        fetchDaycareActivities(target).catch((e: unknown) => {
          if (isActivityMissingError(e)) activityMissing = true
          return null
        }),
      ])
      if (gen !== genRef.current || target !== dayRef.current) return
      setData({
        day: target,
        planRows: usable && snapshot !== null ? snapshot.plan_rows : (plan?.rows ?? []),
        planSource: usable && snapshot !== null ? snapshot.plan_source : (plan?.source ?? 'unknown'),
        attendance,
        activities,
        activityMissing,
      })
      setError(null)
    } catch {
      if (gen !== genRef.current) return
      if (!quiet) setError(ERR_LOAD)
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setResult(null)
    setPicked(new Map())
    void load(day, false)
  }, [day, reloadKey, load])

  const reloadTimer = useRef<number | null>(null)
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null
      void load(dayRef.current, true)
    }, 400)
  }, [load])
  useEffect(() => {
    const onChange = (table: string, info?: { event: string; row: Record<string, unknown> | null }) => {
      if (info?.row && isSelfWrite(table, info.row)) return
      scheduleReload()
    }
    const offA = subscribeDaycareChanges(onChange)
    const offB = subscribeDaycareActivityChanges(onChange)
    let last = queuePending()
    const offQ = queueSubscribe((n) => {
      setQueueTick((x) => x + 1)
      if (n < last) scheduleReload()
      last = n
    })
    return () => {
      offA()
      offB()
      offQ()
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    }
  }, [scheduleReload])

  const board = useMemo(
    () => (data === null ? null : buildDaycareBoard({ planRows: data.planRows, source: data.planSource, residents, attendance: data.attendance })),
    [data, residents],
  )
  const targets = board === null ? [] : activityTargets(board.rows)
  const nameOf = (id: number) => residents.find((r) => r.id === id)?.name ?? `利用者ID ${id}`
  const missing = data?.activityMissing ?? false
  const canWrite = gate !== null && gate.observed && gate.value === true && !missing && data !== null && data.activities !== null && day <= today
  const pendingAdds = pendingActivityOps().filter(
    (p): p is Extract<PendingActivityOp, { kind: 'add' }> => p.kind === 'add' && p.day === day,
  )
  const has = (rid: number, l: string) =>
    (data?.activities ?? []).some((a) => a.resident_id === rid && a.day === day && a.label === l) ||
    pendingAdds.some((p) => p.residentId === rid && p.label === l)

  const chosen = label === null ? null : label === '' ? normalizeActivityLabel(otherText) : label
  const chosenErr = label === '' ? (otherText === '' ? null : activityLabelError(otherText)) : null
  const chosenOk = chosen !== null && chosen !== '' && activityLabelError(chosen) === null
  const rowOf = (rid: number) => board?.rows.find((r) => r.residentId === rid)
  const isChecked = (rid: number) => picked.get(rid) ?? activityDefaultChecked(rowOf(rid))
  const sendTo = chosenOk ? targets.filter((rid) => isChecked(rid) && !has(rid, chosen)) : []

  const precheck = (): string | null => {
    if (missing) return MSG_MISSING
    if (!canWrite) {
      return gate?.forbidden
        ? FORBIDDEN_REASON
        : gate?.outdated
          ? OUTDATED_REASON
          : gate?.observed
            ? kindBlockedMessage('daycare_activity')
            : MSG_GATE_UNKNOWN
    }
    if (actorId === null) return MSG_NO_RECORDER
    return null
  }

  const runBulk = async () => {
    const d = day
    const why = precheck()
    if (why !== null) {
      setResult({ day: d, tone: 'warn', text: why })
      return
    }
    if (!chosenOk || chosen === null || sendTo.length === 0) return
    const l = chosen
    const ids = [...sendTo]
    setRunning(true)
    const outcomes: ActivityAddOutcome[] = []
    for (const rid of ids) {
      try {
        const r = await insertDaycareActivity({ resident_id: rid, day: d, label: l, recorded_by: actorId })
        outcomes.push(r.kind)
      } catch {
        outcomes.push('error')
      }
    }
    setRunning(false)
    const bad = outcomes.some((o) => o === 'taken' || o === 'error')
    setResult({ day: d, tone: bad ? 'warn' : 'info', text: bulkResultText(l, outcomes) })
    if (!bad) {
      setLabel(null)
      setOtherText('')
    }
    scheduleReload()
  }

  const goDay = (d: string) => navigate(bulkPath(d, today), { replace: true })
  const chipCls = (on: boolean) =>
    on
      ? 'min-h-tap min-w-tap rounded border-2 border-primary bg-primary px-3 text-lg font-bold text-primary-ink'
      : 'min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-lg text-ink disabled:text-ink3'

  const header = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <DaycareNav current="activity" handoff={() => writeDaycareHandoffFor({ rows: board?.rows ?? null, residents, day, today })} />
        <RecorderBar actorId={actorId} staff={staff ?? null} />
      </div>
      <div className="flex flex-wrap items-center gap-gap" role="group" aria-label="日付">
        <button
          type="button"
          onClick={() => goDay(addDays(day, -1))}
          className="min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-lg text-ink"
          aria-label="前の日へ"
        >
          <span aria-hidden="true">‹</span>
        </button>
        <span className="min-w-28 text-center text-lg font-bold text-ink" aria-live="polite">
          {fmtDayLabel(day)}
          {day === today ? <span className="ml-2 text-base text-ok">今日</span> : null}
        </span>
        <button
          type="button"
          onClick={() => goDay(addDays(day, 1) > today ? day : addDays(day, 1))}
          disabled={day >= today}
          className="min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-lg text-ink disabled:text-ink3"
          aria-label="次の日へ"
        >
          <span aria-hidden="true">›</span>
        </button>
        <button
          type="button"
          onClick={() => setReloadKey((n) => n + 1)}
          className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink"
        >
          最新に更新
        </button>
      </div>
      {missing ? (
        <p role="alert" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {MSG_MISSING}
        </p>
      ) : gate !== null && !(gate.observed && gate.value === true) ? (
        <p role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {gate.forbidden
            ? FORBIDDEN_REASON
            : gate.outdated
              ? OUTDATED_REASON
              : gate.observed
                ? `${kindBlockedMessage('daycare_activity')}。記録の閲覧はできます。`
                : MSG_GATE_UNKNOWN}
        </p>
      ) : null}
    </div>
  )

  if ((loading && data === null) || (data !== null && data.day !== day && error === null)) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        {header}
        <LoadingBlock label="その日の活動を読み込んでいます…" />
      </div>
    )
  }
  if (error !== null && (data === null || data.day !== day)) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        {header}
        <ErrorBlock message={error} onRetry={() => setReloadKey((n) => n + 1)} />
      </div>
    )
  }
  if (data === null) return null

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      {header}

      <section aria-labelledby="h-bulk" className="space-y-3 rounded-lg border border-border bg-surface p-3">
        <h2 id="h-bulk" className="text-xl font-bold text-ink">
          活動一括
        </h2>
        <p className="text-base text-ink2">活動を1つ選び、予定の方（休み・入院中を除く）と予定外で来た方にまとめて「参加」で入れます。度合いを変える時は、その方の記録の画面で直してください。</p>
        {data.activities === null && !missing ? (
          <div role="alert" className="space-y-2 rounded border border-danger bg-danger-bg p-2 text-base text-ink">
            <p>
              <span aria-hidden="true">▲ </span>活動の記録を読み込めませんでした。通信状態を確認して、〔最新に更新〕を押してください。
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-gap" role="group" aria-label="入れる活動を選ぶ">
          {DAYCARE_ACTIVITY_CHIPS.map((c) => (
            <button key={c} type="button" aria-pressed={label === c} disabled={!canWrite || running} onClick={() => setLabel(label === c ? null : c)} className={chipCls(label === c)}>
              {label === c ? <span aria-hidden="true">✓ </span> : null}
              {c}
            </button>
          ))}
          <button type="button" aria-pressed={label === ''} disabled={!canWrite || running} onClick={() => setLabel(label === '' ? null : '')} className={chipCls(label === '')}>
            {label === '' ? <span aria-hidden="true">✓ </span> : null}
            その他
          </button>
        </div>
        {label === '' ? (
          <label className="block text-sm text-ink2">
            ほかの活動（{ACTIVITY_LABEL_MAX}字まで）
            <input
              type="text"
              value={otherText}
              maxLength={ACTIVITY_LABEL_MAX * 2}
              onChange={(e) => setOtherText(e.target.value)}
              aria-invalid={chosenErr !== null}
              aria-describedby={chosenErr !== null ? 'bulk-other-err' : undefined}
              className="mt-1 block min-h-tap w-64 rounded border border-border-strong bg-surface px-2 text-lg text-ink"
            />
            {chosenErr !== null ? (
              <span id="bulk-other-err" className="mt-1 block text-sm text-danger">
                {chosenErr}
              </span>
            ) : null}
          </label>
        ) : null}

        {targets.length === 0 ? (
          <p className="text-base text-ink2">この日の予定の方がいません（休み・入院中の方は出しません）。予定外で来た方は、今日の画面の〔予定にない方を追加〕で足したカードを押し、〔予定外で到着〕を押すと、ここに出ます。</p>
        ) : (
          <fieldset className="space-y-1">
            <legend className="text-base font-bold text-ink">入れる方（{targets.length}人。来た方には最初からチェックが付いています。外したい方だけ外してください）</legend>
            <ul className="grid gap-1 sm:grid-cols-2">
              {targets.map((rid) => {
                const done = chosenOk && chosen !== null && has(rid, chosen)
                return (
                  <li key={rid}>
                    <label className="flex min-h-tap items-center gap-2 rounded border border-border px-2 text-base text-ink">
                      <input
                        type="checkbox"
                        className="h-6 w-6"
                        checked={isChecked(rid) && !done}
                        disabled={done || running}
                        onChange={(e) =>
                          setPicked((prev) => new Map(prev).set(rid, e.target.checked))
                        }
                      />
                      <span>{nameOf(rid)}</span>
                      {/* まだ来ていない方は最初のチェックを外し、印を出す（親の検収 中2） */}
                      {!done && !activityDefaultChecked(rowOf(rid)) ? <span className="text-sm text-ink2">（未到着）</span> : null}
                      {done ? <span className="text-sm text-ok">（記録済み）</span> : null}
                    </label>
                  </li>
                )
              })}
            </ul>
          </fieldset>
        )}

        <button
          type="button"
          disabled={!canWrite || running || !chosenOk || sendTo.length === 0}
          onClick={() => void runBulk()}
          className="min-h-tap rounded border-2 border-primary bg-primary px-4 text-lg font-bold text-primary-ink disabled:border-border-strong disabled:bg-surface disabled:text-ink3"
        >
          {running ? '入れています…' : chosenOk && chosen !== null ? `チェックした ${sendTo.length}人に「${chosen}」を入れる` : '活動を選んでください'}
        </button>
        {result !== null && result.day === day ? (
          <p role="status" className={`rounded border p-2 text-base text-ink ${result.tone === 'info' ? 'border-primary bg-surface' : 'border-warn bg-warn-bg'}`}>
            <span aria-hidden="true">{result.tone === 'info' ? 'ⓘ ' : '⚠ '}</span>
            {result.text}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="h-each" className="space-y-2 rounded-lg border border-border bg-surface p-3">
        <h2 id="h-each" className="text-xl font-bold text-ink">
          1人ずつの活動
        </h2>
        {targets.length === 0 ? (
          <p className="text-base text-ink2">この日の予定の方がいません。</p>
        ) : (
          <ul className="divide-y divide-border">
            {targets.map((rid) => {
              const list = data.activities === null ? null : activitiesOf(data.activities, rid, day)
              const waiting = pendingAdds.filter((p) => p.residentId === rid)
              return (
                <li key={rid} className="flex flex-wrap items-center justify-between gap-gap py-2">
                  <div className="min-w-0">
                    <p className="text-lg font-bold text-ink">{nameOf(rid)}</p>
                    <p className="text-base text-ink2">
                      {list === null
                        ? '（読み込めませんでした）'
                        : list.length === 0 && waiting.length === 0
                          ? '記録なし'
                          : [...list.map((a) => activityText(a)), ...waiting.map((p) => `${p.label}（送信待ち）`)].join('・')}
                    </p>
                  </div>
                  <Link
                    to={personPath(rid, day, today)}
                    aria-label={`${nameOf(rid)}さんの1日の記録を開く（活動の度合い・前回と同じ）`}
                    className="inline-flex min-h-tap items-center rounded border border-primary bg-surface px-4 text-base font-bold text-primary"
                  >
                    記録<span aria-hidden="true"> ›</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
