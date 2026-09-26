// 事故・ヒヤリハット 一覧（ルート /incident・「その他」と記録ハブから）。2026-09-26 追加。
//
// 期間（発生日・既定は直近3か月）・区分・状態で絞り込み、新しい順に並べる。
// 行: 発生日時・区分・対象者・種別・程度・状態（対応中／完了）・市への報告（要／報告済み 日付／—）。行を押すと入力・編集（/incident/:id）。
// 上部に件数（対応中 N・市へ報告が要で未報告 N）と「＋記録する」（/incident/new）。
// この端末の送信待ちにある追加（まだサーバーに無い記録）は送信待ちから読んで「未送信」として出す（押せない・二重に記録しない）。
//
// 規律:
// - 取得は db.ts の関数のみ（supabase を直呼びしない）。期間は必須（全件ロードしない）
// - 入力解禁は input_enabled_incident（getKindInputGate('incident')）。封鎖中は「＋記録する」を押せなくし理由を出す（一覧の閲覧はできる）
// - 期間・区分・状態は保存しない（日付に紐づく状態＝原則11の既定。開くと常に直近3か月・全て）。現在地は URL で復元される
// - 氏名・記録を localStorage・console に出さない。色だけで意味を伝えない（文字を併記）

import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  DbError,
  fetchAllResidents,
  fetchIncidents,
  getKindInputGate,
  kindBlockedMessage,
  pendingIncidentOps,
  queueSubscribe,
  subscribeIncidentChanges,
} from '../lib/db'
import { cityReportState, defaultIncidentRange, incidentCounts, typesText } from '../lib/incident'
import { fmtClock } from '../lib/med'
import { fmtDayLabel, todayIso } from '../lib/format'
import {
  INCIDENT_KIND_LABEL,
  INCIDENT_SEVERITY_LABEL,
  INCIDENT_STATUS_LABEL,
  INCIDENT_TYPES,
} from '../lib/types'
import type { Incident, IncidentKind, IncidentStatus, IncidentType, Resident } from '../lib/types'
import { EmptyBlock, ErrorBlock, LoadingBlock, SectionCard, SegmentPicker } from '../components/ui'

const ERR_LOAD = '事故・ヒヤリハットの一覧を読み込めませんでした。通信状態を確認して、再試行してください。'
const ERR_GATE =
  '事故・ヒヤリハットの記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。一覧の閲覧はこのままできます。'
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const KIND_OPTIONS = [
  { value: 'all', label: '全て' },
  { value: 'accident', label: INCIDENT_KIND_LABEL.accident },
  { value: 'nearmiss', label: INCIDENT_KIND_LABEL.nearmiss },
]
const STATUS_OPTIONS = [
  { value: 'all', label: '全て' },
  { value: 'open', label: INCIDENT_STATUS_LABEL.open },
  { value: 'closed', label: INCIDENT_STATUS_LABEL.closed },
]

export function IncidentListPage() {
  const navigate = useNavigate()
  const uid = useId()
  const today = todayIso()
  const initial = defaultIncidentRange(today)
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [kind, setKind] = useState<'all' | IncidentKind>('all')
  const [status, setStatus] = useState<'all' | IncidentStatus>('all')
  const [rangeMsg, setRangeMsg] = useState<string | null>(null)

  const [residents, setResidents] = useState<Resident[] | null>(null)
  const [gate, setGate] = useState<{ value: boolean; observed: boolean } | null>(null)
  const [baseError, setBaseError] = useState<string | null>(null)
  const [baseTick, setBaseTick] = useState(0)
  const [list, setList] = useState<Incident[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [queueTick, setQueueTick] = useState(0)

  // 名簿（退居された方も含む）と入力解禁（画面を開くたびに取り直す）
  useEffect(() => {
    let alive = true
    setBaseError(null)
    Promise.all([fetchAllResidents(), getKindInputGate('incident')])
      .then(([rs, g]) => {
        if (!alive) return
        setResidents(rs)
        setGate(g)
      })
      .catch(() => {
        if (alive) setBaseError(ERR_LOAD)
      })
    return () => {
      alive = false
    }
  }, [baseTick])

  useEffect(() => {
    let alive = true
    setListError(null)
    setList(null)
    fetchIncidents({
      fromIso: from,
      toIso: to,
      kind: kind === 'all' ? null : kind,
      status: status === 'all' ? null : status,
    })
      .then((rows) => {
        if (alive) setList(rows)
      })
      .catch((e: unknown) => {
        if (alive) setListError(e instanceof DbError && e.kind === 'server' ? e.message : ERR_LOAD)
      })
    return () => {
      alive = false
    }
  }, [from, to, kind, status, tick])

  // 送信待ちの件数が変わったら「未送信」の行を描き直す。減った時（送れた）は一覧を読み直す
  useEffect(() => {
    let last = -1
    return queueSubscribe((n) => {
      const prev = last
      last = n
      setQueueTick((t) => t + 1)
      if (prev >= 0 && n < prev) setTick((t) => t + 1)
    })
  }, [])

  // 他の端末の追加・変更を取り込む（期間外の通知は無視。行を特定できない通知は読み直す側へ倒す）
  useEffect(() => {
    let timer: number | null = null
    const unsub = subscribeIncidentChanges((_table, info) => {
      const row = info?.row ?? null
      if (row !== null && typeof row.occurred_on === 'string' && (row.occurred_on < from || row.occurred_on > to)) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => setTick((n) => n + 1), 400)
    })
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsub()
    }
  }, [from, to])

  const residentById = useMemo(() => {
    const m = new Map<number, Resident>()
    for (const r of residents ?? []) m.set(r.id, r)
    return m
  }, [residents])

  // queueTick は描き直しの合図（送信待ちは db.ts が持つ。読むだけ）
  const pending = useMemo(() => {
    void queueTick
    return pendingIncidentOps()
  }, [queueTick])

  const onRange = useCallback(
    (which: 'from' | 'to', v: string) => {
      if (!DAY_RE.test(v)) return
      const nextFrom = which === 'from' ? v : from
      const nextTo = which === 'to' ? (v > todayIso() ? todayIso() : v) : to
      if (nextFrom > nextTo) {
        setRangeMsg('期間の始まりが終わりより後になっています。選び直してください。')
        return
      }
      setRangeMsg(null)
      setFrom(nextFrom)
      setTo(nextTo)
    },
    [from, to],
  )

  if (baseError !== null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <ErrorBlock message={baseError} onRetry={() => setBaseTick((n) => n + 1)} />
      </div>
    )
  }
  if (residents === null || gate === null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <LoadingBlock label="事故・ヒヤリハットの画面を準備しています…" />
      </div>
    )
  }

  const locked = !gate.observed || gate.value !== true
  const reasonId = `${uid}-locked`
  const counts = incidentCounts(list ?? [])
  const nameOf = (id: number | null): string => {
    if (id === null) return '対象者なし'
    const r = residentById.get(id)
    return r === undefined ? `利用者番号 ${id}` : `${r.name}${r.active ? '' : '（退居）'}`
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      {!gate.observed ? (
        <ErrorBlock message={ERR_GATE} onRetry={() => setBaseTick((n) => n + 1)} />
      ) : locked ? (
        <div id={reasonId} role="status" className="rounded-lg border border-warn bg-warn-bg p-4">
          <p className="text-base text-ink">
            <span aria-hidden="true">▲ </span>
            <span className="sr-only">お知らせ: </span>
            {kindBlockedMessage('incident')}
          </p>
          <p className="mt-2 text-base text-ink2">一覧の閲覧はこのままできます。</p>
        </div>
      ) : null}

      <SectionCard title="事故・ヒヤリハット">
        <div className="flex flex-wrap items-end gap-gap">
          <button
            type="button"
            onClick={() => {
              if (!locked) navigate('/incident/new')
            }}
            disabled={locked}
            aria-describedby={locked && gate.observed ? reasonId : undefined}
            className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border disabled:bg-surface2 disabled:text-ink2"
          >
            <span aria-hidden="true">＋ </span>記録する
          </button>
          <Link to="/incident/summary" className="inline-flex min-h-tap items-center text-link">
            委員会用の月次集計<span aria-hidden="true"> ›</span>
          </Link>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-gap">
          <div className="min-w-0">
            <label htmlFor={`${uid}-from`} className="block text-sm text-ink2">
              期間（発生日）の始まり
            </label>
            <input
              id={`${uid}-from`}
              type="date"
              value={from}
              max={to}
              onChange={(e) => onRange('from', e.target.value)}
              className="tabular mt-1 min-h-tap rounded border border-border bg-surface px-3 text-base text-ink"
            />
          </div>
          <div className="min-w-0">
            <label htmlFor={`${uid}-to`} className="block text-sm text-ink2">
              終わり
            </label>
            <input
              id={`${uid}-to`}
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(e) => onRange('to', e.target.value)}
              className="tabular mt-1 min-h-tap rounded border border-border bg-surface px-3 text-base text-ink"
            />
          </div>
          {from !== initial.from || to !== initial.to ? (
            <button
              type="button"
              onClick={() => {
                const r = defaultIncidentRange(todayIso())
                setRangeMsg(null)
                setFrom(r.from)
                setTo(r.to)
              }}
              className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink"
            >
              直近3か月へ
            </button>
          ) : null}
        </div>
        {rangeMsg !== null ? (
          <p role="alert" className="mt-2 text-sm text-warn">
            <span aria-hidden="true">▲ </span>
            {rangeMsg}
          </p>
        ) : null}
        <div className="mt-3 space-y-2">
          <SegmentPicker
            options={KIND_OPTIONS}
            value={kind}
            onChange={(v) => setKind(v === 'accident' || v === 'nearmiss' ? v : 'all')}
            ariaLabel="区分で絞り込む"
          />
          <SegmentPicker
            options={STATUS_OPTIONS}
            value={status}
            onChange={(v) => setStatus(v === 'open' || v === 'closed' ? v : 'all')}
            ariaLabel="状態で絞り込む"
          />
        </div>

        <p className="mt-3 text-base text-ink" aria-live="polite">
          対応中{' '}
          <span className={`tabular font-bold ${counts.open > 0 ? 'text-warn' : ''}`}>{counts.open}</span>
          {'　'}市へ報告が要で未報告{' '}
          <span className={`tabular font-bold ${counts.cityPending > 0 ? 'text-danger' : ''}`}>{counts.cityPending}</span>
          <span className="text-sm text-ink2">（表示中の期間・絞り込みの中で）</span>
        </p>
      </SectionCard>

      {pending.length > 0 ? (
        <section aria-label="未送信の記録" className="rounded-lg border border-warn bg-warn-bg p-3">
          <p className="text-base text-ink">
            <span aria-hidden="true">▲ </span>
            未送信の記録が {pending.length} 件あります（電波が戻ると自動で送信します）。送信が終わると一覧に出ます。
          </p>
          <ul className="mt-2 space-y-2">
            {pending.map((p) => (
              <li key={p.qid} className="rounded border border-border bg-surface p-3 text-base text-ink">
                <span className="font-bold">{p.state === 'blocked' ? '止まっている' : p.state === 'sending' ? '送信中' : '未送信'}</span>
                {'　'}
                {p.occurredOn !== null ? fmtDayLabel(p.occurredOn) : ''}
                {p.occurredAt !== null ? ` ${fmtClock(p.occurredAt)}` : ''}
                {'　'}
                {p.kind !== null ? INCIDENT_KIND_LABEL[p.kind] : ''}
                {'　'}
                {nameOf(p.residentId)}
                {'　'}
                {typesText(p.types.filter((t): t is IncidentType => (INCIDENT_TYPES as readonly string[]).includes(t)))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {listError !== null ? (
        <ErrorBlock message={listError} onRetry={() => setTick((n) => n + 1)} />
      ) : list === null ? (
        <LoadingBlock label="事故・ヒヤリハットを読み込み中です…" />
      ) : list.length === 0 ? (
        <EmptyBlock message="この期間・絞り込みの記録はありません。期間を広げるか、絞り込みを「全て」にしてください。" />
      ) : (
        <ul className="space-y-2" aria-label="事故・ヒヤリハットの一覧（新しい順）">
          {list.map((i) => {
            const city = cityReportState(i)
            return (
              <li key={i.id}>
                <Link
                  to={`/incident/${i.id}`}
                  className={`block min-h-tap rounded-lg border bg-surface p-3 text-base text-ink ${i.kind === 'accident' ? 'border-danger' : 'border-border'}`}
                >
                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="tabular text-sm text-ink2">
                      {fmtDayLabel(i.occurred_on)} {fmtClock(i.occurred_at)}
                    </span>
                    <span className={`font-bold ${i.kind === 'accident' ? 'text-danger' : ''}`}>
                      {i.kind === 'accident' ? <span aria-hidden="true">▲ </span> : null}
                      {INCIDENT_KIND_LABEL[i.kind]}
                    </span>
                    <span className="font-bold">{nameOf(i.resident_id)}</span>
                  </span>
                  <span className="mt-1 block text-sm text-ink">
                    種別: {typesText(i.types)}
                    {'　'}程度: {i.severity === null ? '—' : INCIDENT_SEVERITY_LABEL[i.severity]}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-x-3 text-sm">
                    <span className={i.status === 'open' ? 'font-bold text-warn' : 'text-ink2'}>
                      状態: {i.status === 'open' ? '▲ ' : '✓ '}
                      {INCIDENT_STATUS_LABEL[i.status]}
                    </span>
                    <span className={city === 'pending' ? 'font-bold text-danger' : 'text-ink2'}>
                      市への報告:{' '}
                      {city === 'pending'
                        ? '▲ 要（未報告）'
                        : city === 'reported' && i.city_reported_on !== null
                          ? `報告済み ${fmtDayLabel(i.city_reported_on)}`
                          : '—'}
                    </span>
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex flex-wrap gap-gap">
        <button
          type="button"
          onClick={() => setTick((n) => n + 1)}
          className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink"
        >
          最新を読み込む
        </button>
      </div>
    </div>
  )
}

export default IncidentListPage
