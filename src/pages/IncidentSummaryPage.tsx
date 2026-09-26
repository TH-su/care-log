// 事故・ヒヤリハット 委員会用の月次集計（ルート /incident/summary・「その他」から）。2026-09-26 追加。
//
// 月を選び（保存しない）、その月（発生日）の記録を集計する:
//   事故・ヒヤリ別の件数／種別×件数／場所×件数／時間帯（0-6・6-9・9-12・12-15・15-18・18-21・21-24）×件数／程度別／
//   未完了の一覧（日付・区分・種別・状態）。**氏名は出さない**（名簿を読まない・集計の結果に対象者を持たない）。
//   未完了の一覧は、その月末までに発生して未完了のもの（前月以前からの持ち越しを含む・月末より後に発生したものは除く。
//   2026-09-26 チーフ裁定）。未完了かどうかは記録のいまの状態で見る（完了にした日を持たないため）。
// 印刷は既存の印刷部品（PrintArea）で A4 縦・1枚に収める。
//
// 規律:
// - 取得は db.ts の fetchIncidents（月の範囲だけ）と fetchOpenIncidentsUntil（月末までに発生して対応中のもの）。
//   集計は incident.ts の aggregateIncidentMonth（純関数）
// - 表示中の月は保存しない（日付に紐づく状態＝原則11の既定。開くと常に今月）
// - console に何も出さない。色だけで意味を伝えない

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { DbError, fetchIncidents, fetchOpenIncidentsUntil, subscribeIncidentChanges } from '../lib/db'
import { aggregateIncidentMonth, kindShortLabel, typesText } from '../lib/incident'
import type { IncidentCountRow, IncidentMonthSummary } from '../lib/incident'
import { fmtMonthLabel, monthKeyOf, monthRange, parseMonthKey, shiftMonth } from '../lib/bath'
import { fmtDayLabel, todayIso } from '../lib/format'
import { INCIDENT_STATUS_LABEL } from '../lib/types'
import type { Incident } from '../lib/types'
import { EmptyBlock, ErrorBlock, LoadingBlock, SectionCard } from '../components/ui'
import { PrintArea, PrintButton } from '../components/print/PrintArea'
import type { PrintAreaHandle } from '../components/print/PrintArea'

const ERR_LOAD = '事故・ヒヤリハットの月次集計を読み込めませんでした。通信状態を確認して、再試行してください。'
const TYPE_NOTE = '種別は1件に複数あれば、それぞれに数えます（種別の合計は件数より多くなることがあります）。'
const OPEN_NOTE =
  '未完了の一覧は、この月末までに発生して、いま対応中のものです（前月以前からの持ち越しを含みます。完了にした日は記録していないため、いまの状態で見ます）。'

export function IncidentSummaryPage() {
  const current = monthKeyOf(todayIso())
  const [month, setMonth] = useState<string>(current)
  const [data, setData] = useState<{ month: string; list: Incident[]; open: Incident[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const printRef = useRef<PrintAreaHandle>(null)

  const changeMonth = useCallback(
    (next: string) => {
      setMonth(parseMonthKey(next, current) ?? current)
    },
    [current],
  )

  useEffect(() => {
    const range = monthRange(month)
    if (range === null) return
    let alive = true
    setError(null)
    setData((d) => (d !== null && d.month === month ? d : null))
    Promise.all([fetchIncidents({ fromIso: range.from, toIso: range.to }), fetchOpenIncidentsUntil(range.to)])
      .then(([list, open]) => {
        if (alive) setData({ month, list, open })
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof DbError && e.kind === 'server' ? e.message : ERR_LOAD)
      })
    return () => {
      alive = false
    }
  }, [month, tick])

  // 他の端末の追加・変更を取り込む（表示中の月の行だけ。行を特定できない通知は取り直す側へ倒す）
  useEffect(() => {
    let timer: number | null = null
    const unsub = subscribeIncidentChanges((_table, info) => {
      const row = info?.row ?? null
      // 月末より後に発生した記録だけは表示に関係しない（前月以前の記録も「未完了の一覧」に載りうる）
      const range = monthRange(month)
      if (row !== null && typeof row.occurred_on === 'string' && range !== null && row.occurred_on > range.to) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => setTick((n) => n + 1), 400)
    })
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsub()
    }
  }, [month])

  const summary: IncidentMonthSummary | null = useMemo(
    () => (data === null || data.month !== month ? null : aggregateIncidentMonth(data.list, month, data.open)),
    [data, month],
  )
  const monthLabel = fmtMonthLabel(month)
  const printedOn = (() => {
    const d = new Date()
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  })()

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      <SectionCard title={`事故・ヒヤリハット 月次集計 ${monthLabel}`}>
        <div className="flex flex-wrap items-center gap-gap">
          <button
            type="button"
            onClick={() => changeMonth(shiftMonth(month, -1))}
            className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink"
          >
            <span aria-hidden="true">‹ </span>前の月
          </button>
          <span className="tabular min-w-tap text-center text-lg font-bold text-ink" aria-live="polite">
            {monthLabel}
          </span>
          <button
            type="button"
            onClick={() => changeMonth(shiftMonth(month, 1))}
            disabled={month >= current}
            className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:text-ink3"
          >
            次の月<span aria-hidden="true"> ›</span>
          </button>
          {month !== current ? (
            <button
              type="button"
              onClick={() => changeMonth(current)}
              className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink"
            >
              今月へ
            </button>
          ) : null}
          <PrintButton target={printRef} label="印刷する" disabled={summary === null} />
        </div>
        <p className="mt-2 text-sm text-ink2">
          <span aria-hidden="true">ⓘ </span>
          委員会用の資料です。氏名は出しません。件数は発生日がこの月の記録を数えます。{TYPE_NOTE}
          {OPEN_NOTE}
        </p>
        <p className="mt-1 text-sm">
          <Link to="/incident" className="inline-flex min-h-tap items-center text-link">
            事故・ヒヤリハットの一覧<span aria-hidden="true"> ›</span>
          </Link>
        </p>
      </SectionCard>

      {error !== null ? (
        <ErrorBlock message={error} onRetry={() => setTick((n) => n + 1)} />
      ) : summary === null ? (
        <LoadingBlock label="月次集計を読み込み中です…" />
      ) : summary.total.total === 0 && summary.open.length === 0 ? (
        <EmptyBlock message="この月の事故・ヒヤリハットの記録と、月末までの未完了の記録はありません。" />
      ) : (
        <SummaryBody summary={summary} variant="screen" />
      )}

      {/* 紙に出す中身（画面には出ない）。A4 縦・1枚に収める。氏名は出さない */}
      <PrintArea ref={printRef} orientation="portrait">
        {summary !== null ? (
          <section>
            <h1 className="cl-print-title">事故・ヒヤリハット 月次集計 {monthLabel}</h1>
            <p className="cl-print-meta">
              印刷日 {printedOn}　件数は発生日がこの月の記録を数えます。{TYPE_NOTE}
            </p>
            <p className="cl-print-meta">{OPEN_NOTE}</p>
            <SummaryBody summary={summary} variant="print" />
          </section>
        ) : null}
      </PrintArea>
    </div>
  )
}

export default IncidentSummaryPage

/** 集計の表（画面と紙で同じ中身） */
function SummaryBody({ summary, variant }: { summary: IncidentMonthSummary; variant: 'screen' | 'print' }) {
  const screen = variant === 'screen'
  const t = summary.total
  return (
    <div className={screen ? 'space-y-4' : ''}>
      <p className={screen ? 'text-base text-ink' : 'cl-print-meta cl-print-strong'}>
        件数　事故 <span className="tabular font-bold">{t.accident}</span>　ヒヤリハット{' '}
        <span className="tabular font-bold">{t.nearmiss}</span>　計 <span className="tabular font-bold">{t.total}</span>
      </p>
      <CountTable title="種別" rows={summary.byType} screen={screen} />
      <CountTable title="場所" rows={summary.byPlace} screen={screen} />
      <CountTable title="時間帯" rows={summary.byBand} screen={screen} />
      <CountTable title="程度" rows={summary.bySeverity} screen={screen} />
      <OpenList summary={summary} screen={screen} />
    </div>
  )
}

function CountTable({ title, rows, screen }: { title: string; rows: IncidentCountRow[]; screen: boolean }) {
  const th = screen ? 'border border-border bg-surface2 px-2 py-1 text-sm font-bold text-ink2' : ''
  const td = screen ? 'tabular border border-border px-2 py-1 text-center text-base text-ink' : 'tabular'
  const table = (
    <table className={screen ? 'w-full border-collapse' : 'cl-print-table'}>
      <caption className={screen ? 'mb-1 text-left text-base font-bold text-ink' : 'cl-print-left cl-print-strong'}>
        {title}×件数
      </caption>
      <thead>
        <tr>
          <th scope="col" className={`${th} ${screen ? 'text-left' : 'cl-print-left'}`}>
            {title}
          </th>
          <th scope="col" className={th}>
            事故
          </th>
          <th scope="col" className={th}>
            ヒヤリ
          </th>
          <th scope="col" className={th}>
            計
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row" className={screen ? 'border border-border px-2 py-1 text-left text-sm font-normal text-ink' : 'cl-print-left'}>
              {r.label}
            </th>
            <td className={td}>{r.accident}</td>
            <td className={td}>{r.nearmiss}</td>
            <td className={`${td} ${screen ? 'font-bold' : 'cl-print-strong'}`}>{r.total}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
  return screen ? <div className="relative overflow-x-auto rounded-lg border border-border bg-surface p-2">{table}</div> : table
}

/** 未完了の一覧の日付。表示中の月と年が違う時（前年からの持ち越し）は年も書く */
function openDayText(day: string, month: string): string {
  return day.slice(0, 4) === month.slice(0, 4) ? fmtDayLabel(day) : `${Number(day.slice(0, 4))}年${fmtDayLabel(day)}`
}

/** 未完了の一覧（日付・区分・種別・状態。氏名・対象者は持たない） */
function OpenList({ summary, screen }: { summary: IncidentMonthSummary; screen: boolean }) {
  if (summary.open.length === 0) {
    return <p className={screen ? 'text-base text-ink' : 'cl-print-meta'}>未完了: なし</p>
  }
  const th = screen ? 'border border-border bg-surface2 px-2 py-1 text-left text-sm font-bold text-ink2' : 'cl-print-left'
  const td = screen ? 'border border-border px-2 py-1 text-left text-base text-ink' : 'cl-print-left'
  const table = (
    <table className={screen ? 'w-full border-collapse' : 'cl-print-table'}>
      <caption className={screen ? 'mb-1 text-left text-base font-bold text-ink' : 'cl-print-left cl-print-strong'}>
        未完了の一覧（月末までに発生・{summary.open.length}件）
      </caption>
      <thead>
        <tr>
          <th scope="col" className={th}>
            日付
          </th>
          <th scope="col" className={th}>
            区分
          </th>
          <th scope="col" className={th}>
            種別
          </th>
          <th scope="col" className={th}>
            状態
          </th>
        </tr>
      </thead>
      <tbody>
        {summary.open.map((o) => (
          <tr key={o.id}>
            <td className={`${td} tabular`}>{openDayText(o.occurred_on, summary.month)}</td>
            <td className={td}>{kindShortLabel(o.kind)}</td>
            <td className={td}>{typesText(o.types)}</td>
            <td className={td}>{INCIDENT_STATUS_LABEL[o.status]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
  return screen ? <div className="relative overflow-x-auto rounded-lg border border-border bg-surface p-2">{table}</div> : table
}
