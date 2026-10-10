// デイの入浴 月次表（ルート /bath/month・「その他」から）。2026-09-26 追加。
//
// 行＝在籍の入居者のうち、その月に入浴の予定か記録がある人（居室順）。退居された方も、その月に記録があれば行に出す
//   （加算の根拠を紙に残すため。行に「退居」と表示。予定だけで記録の無い退居者は出さない・2026-09-26 チーフ裁定）。列＝その月の1日〜月末。
// マス＝○（入浴した）／×（入浴していない）／未（予定があったのに記録なし）（2026-10-01 代表指示で2つに。
// DB の区分は全身浴・シャワー浴・部分浴・清拭・訪問介護で入浴が○、中止が×）。自動で入った記録かどうかは出さない（同日の代表指示）。
// 右端に月合計（入浴・入浴なし）。A4 横1枚で印刷できる（PrintArea）。
// 他の端末の変更・つながり直し（RESYNC）での取り直しは、表を出したまま差し替える。取り直しに失敗しても表示中の表を残し、
// 「読み込めませんでした」を添えるだけにする（表がエラーに置き換わってスクロール位置を失わない・2026-10-10 F14）。
//
// 規律:
// - 取得は db.ts の fetchAllResidents / fetchBathMonth / fetchBathPlan / fetchBathFirstDay のみ（月の範囲・1行でだけ引く）
// - 予定は週間計画の写しの「曜日」だけで決まる（毎週同じ）。過去の月にも現在の予定を当てはめるので、
//   「未」は目安であることを画面と紙の両方に書く。「未」は施設全体で記録を始めた日以降だけに付け（その月の記録が0件でも付ける）、
//   現在入院中の方の行には付けない（行に「（入院中）」。2026-09-26 レビュー M1・M2）
// - 表示中の月は保存しない（日付に紐づく状態は原則11の既定どおり保存しない。開いた時は常に今月・レビュー指摘）
// - 氏名・記録を localStorage・console に出さない。記号は文字（白黒でも区別できる）。色だけで意味を伝えない
// - Tailwind はトークン由来クラスのみ（arbitrary value なし）。印刷の見た目は src/components/print/print.css

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  DbError,
  fetchAllResidents,
  fetchBathFirstDay,
  fetchBathMonth,
  fetchBathPlan,
  subscribeBathChanges,
} from '../lib/db'
import {
  aggregateBathMonth,
  BATH_MONTH_MISSING_MARK,
  BATH_SHOWN_LABEL,
  BATH_SHOWN_MARK,
  bathShownOf,
  fmtCopyStamp,
  fmtMonthLabel,
  isoWeekdayIndex,
  monthDays,
  monthKeyOf,
  parseMonthKey,
  shiftMonth,
} from '../lib/bath'
import type { BathMonthMark, BathMonthTable } from '../lib/bath'
import { todayIso } from '../lib/format'
import type { BathRecord, Resident } from '../lib/types'
import { EmptyBlock, ErrorBlock, LoadingBlock, SectionCard } from '../components/ui'
import { PrintArea, PrintButton } from '../components/print/PrintArea'
import type { PrintAreaHandle } from '../components/print/PrintArea'

const WEEKDAY_CHAR = ['月', '火', '水', '木', '金', '土', '日']

const ERR_LOAD =
  '入浴の月次表を読み込めませんでした。通信状態を確認して、再試行してください。'

/** 「未」の注記（画面と紙で同じ文）。startDay＝記録を始めた日 */
function missingNote(startDay: string | null): string {
  const from = startDay === null ? '記録を始めた日' : `記録を始めた日（${Number(startDay.slice(5, 7))}/${Number(startDay.slice(8, 10))}）`
  return `「未」は${from}以降・予定は現在の週間計画を当てはめた目安（過去の予定の変更・入院期間は反映されません。今日より後の日と、現在入院中の方には付けません）。`
}
const NOTE_NO_PLAN =
  '入浴予定（週間計画の写し）を取得できないため、「未」は表示していません。記録（○・×）はそのまま正しく表示しています。'

/** その月の中で、曜日ごとに最初に来る日（予定は曜日ベースなので7回だけ問い合わせればよい） */
function firstDayPerWeekday(monthKey: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const d of monthDays(monthKey)) {
    const w = isoWeekdayIndex(d)
    if (w !== null && !out.has(w)) out.set(w, d)
  }
  return out
}

/** マスの文字（○＝入浴した／×＝入浴していない／未） */
function markText(m: BathMonthMark): string {
  if (m === null) return ''
  if (m === 'missing') return BATH_MONTH_MISSING_MARK
  return BATH_SHOWN_MARK[bathShownOf(m)]
}

function markLabel(m: BathMonthMark): string {
  if (m === null) return '記録なし'
  if (m === 'missing') return '予定あり・記録なし'
  return BATH_SHOWN_LABEL[bathShownOf(m)]
}

/** 凡例（画面と紙で同じ文） */
const LEGEND = `${BATH_SHOWN_MARK.bathed}＝${BATH_SHOWN_LABEL.bathed}　${BATH_SHOWN_MARK.notBathed}＝${BATH_SHOWN_LABEL.notBathed}　未＝予定あり・記録なし`

interface Loaded {
  month: string
  residents: Resident[]
  records: BathRecord[]
  planned: Map<number, Set<number>> | null
  /** 現在入院中の方（週間計画の写しの入院中） */
  hospitalized: Set<number>
  /** 施設全体で最初の入浴記録の日（無ければ null） */
  startDay: string | null
  planUpdatedAt: string | null
  unmatched: number
}

export function BathMonthPage() {
  const current = monthKeyOf(todayIso())
  const [month, setMonth] = useState<string>(current)
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const printRef = useRef<PrintAreaHandle>(null)
  /**
   * 取り直しのきっかけ（'quiet'＝他の端末の変更・つながり直しの合図・F14）。quiet の取り直しが失敗した時は、
   * 表示中の表を残して refreshFailed を出す（エラーに置き換えない）
   */
  const refreshKindRef = useRef<'user' | 'quiet'>('user')
  const [refreshFailed, setRefreshFailed] = useState(false)
  const dataRef = useRef<Loaded | null>(null)
  dataRef.current = data

  /** 人が押した取り直し（失敗したらエラーを出す） */
  const retry = useCallback(() => {
    refreshKindRef.current = 'user'
    setTick((n) => n + 1)
  }, [])

  const changeMonth = useCallback(
    (next: string) => {
      setMonth(parseMonthKey(next, current) ?? current)
    },
    [current],
  )

  useEffect(() => {
    let alive = true
    const quiet = refreshKindRef.current === 'quiet'
    setError(null)
    setData((d) => (d !== null && d.month === month ? d : null))
    void (async () => {
      try {
        // 退居された方も含む全員（居室順）。予定の突き合わせは在籍の方だけで行う
        const residents = await fetchAllResidents()
        const active = residents.filter((r) => r.active)
        const perWeekday = firstDayPerWeekday(month)
        const [records, startDay, plans] = await Promise.all([
          fetchBathMonth(month),
          fetchBathFirstDay(),
          // 予定は取れなくても表は出す（「未」を出さないだけ）
          Promise.all(
            Array.from(perWeekday.entries()).map(async ([w, day]) => {
              try {
                return { w, plan: await fetchBathPlan(day, active) }
              } catch {
                return { w, plan: null }
              }
            }),
          ),
        ])
        if (!alive) return
        let planned: Map<number, Set<number>> | null = new Map()
        let planUpdatedAt: string | null = null
        let unmatched = 0
        const hospitalized = new Set<number>()
        for (const { w, plan } of plans) {
          if (plan === null || !plan.available) {
            planned = null
            break
          }
          planned.set(w, new Set(plan.entries.map((e) => e.residentId)))
          for (const e of plan.entries) if (e.hospitalized) hospitalized.add(e.residentId)
          planUpdatedAt = planUpdatedAt ?? plan.updatedAt
          unmatched = Math.max(unmatched, plan.unmatched)
        }
        setData({
          month,
          residents,
          records,
          planned,
          hospitalized: planned === null ? new Set() : hospitalized,
          startDay,
          planUpdatedAt: planned === null ? null : planUpdatedAt,
          unmatched,
        })
        setRefreshFailed(false)
      } catch (e) {
        if (!alive) return
        const d = dataRef.current
        if (quiet && d !== null && d.month === month) setRefreshFailed(true)
        else setError(e instanceof DbError && e.kind === 'server' ? e.message : ERR_LOAD)
      }
    })()
    return () => {
      alive = false
    }
  }, [month, tick])

  // 他の端末の記録を取り込む（表示中の月の行だけ。行を特定できない通知は取り直す側へ倒す）。
  // つながり直し・画面に戻った時の合図（RESYNC・F14）も行が無いので取り直す。表は出したまま差し替える（quiet）
  useEffect(() => {
    let timer: number | null = null
    const unsub = subscribeBathChanges((_table, info) => {
      const day = typeof info?.row?.bath_on === 'string' ? info.row.bath_on : null
      if (day !== null && monthKeyOf(day) !== month) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        refreshKindRef.current = 'quiet'
        setTick((n) => n + 1)
      }, 400)
    })
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsub()
    }
  }, [month])

  const table: BathMonthTable | null = useMemo(() => {
    if (data === null || data.month !== month) return null
    return aggregateBathMonth({
      monthKey: month,
      order: data.residents.map((r) => r.id),
      retiredIds: new Set(data.residents.filter((r) => !r.active).map((r) => r.id)),
      hospitalizedIds: data.hospitalized,
      startDay: data.startDay,
      records: data.records,
      plannedByWeekday: data.planned,
      today: todayIso(),
    })
  }, [data, month])

  const residentById = useMemo(() => {
    const m = new Map<number, Resident>()
    for (const r of data?.residents ?? []) m.set(r.id, r)
    return m
  }, [data])

  const monthLabel = fmtMonthLabel(month)
  const printedOn = (() => {
    const d = new Date()
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  })()

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 p-4">
      <SectionCard title={`デイ 入浴実施表 ${monthLabel}`}>
        {/* 月の切替・印刷（狭い画面・文字200%では折り返す） */}
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
          <span className="flex-1" />
          <PrintButton target={printRef} disabled={table === null} />
        </div>

        <p className="mt-2 text-sm text-ink2">
          {LEGEND}（未は今日まで）
        </p>
        <p className="mt-1 text-sm">
          <Link to="/record/bath" className="inline-flex min-h-tap items-center text-link">
            入浴の記録を開く<span aria-hidden="true"> ›</span>
          </Link>
        </p>
      </SectionCard>

      {error !== null ? (
        <ErrorBlock message={error} onRetry={retry} />
      ) : table === null || data === null ? (
        <LoadingBlock label="入浴の月次表を読み込み中です…" />
      ) : (
        <>
          <div className="space-y-1">
            {refreshFailed ? (
              <p role="status" className="text-sm text-warn print:hidden">
                <span aria-hidden="true">▲ </span>
                他の端末の変更を読み込めませんでした（表示は前に読んだ内容です）。{' '}
                <button type="button" onClick={retry} className="inline-flex min-h-tap items-center font-bold text-link">
                  読み込み直す
                </button>
              </p>
            ) : null}
            <p className="text-sm text-ink2">
              <span aria-hidden="true">ⓘ </span>
              {data.planned === null
                ? NOTE_NO_PLAN
                : `予定は週間計画の写しから${data.planUpdatedAt ? `（最終更新 ${fmtCopyStamp(data.planUpdatedAt)}）` : ''}。${missingNote(data.startDay)}`}
            </p>
            {data.unmatched > 0 ? (
              <p className="text-sm text-warn">
                <span aria-hidden="true">▲ </span>
                週間計画の予定のうち {data.unmatched}件は、利用者の名簿と突き合わせられませんでした（設定タブのマスタ同期をお試しください）。
              </p>
            ) : null}
            {table.hiddenRecords > 0 ? (
              <p className="text-sm text-warn">
                <span aria-hidden="true">▲ </span>
                利用者の名簿に居ない方の記録が {table.hiddenRecords}件あり、この表には出していません（管理者に連絡してください）。
              </p>
            ) : null}
          </div>

          {table.rows.length === 0 ? (
            <EmptyBlock message="この月の入浴の予定と記録はありません。月を切り替えてお試しください。" />
          ) : (
            // relative: 表の中の読み上げ用の文字（sr-only＝絶対配置）がこの枠の外へ出て、画面全体を横にはみ出させないように
            <div className="relative overflow-x-auto rounded-lg border border-border bg-surface">
              <MonthTable table={table} residentById={residentById} variant="screen" />
            </div>
          )}

          {/* 紙に出す中身（画面には出ない）。A4 横1枚に収まるよう文字の大きさは PrintArea が決める */}
          <PrintArea ref={printRef}>
            <h1 className="cl-print-title">デイ 入浴実施表 {monthLabel}</h1>
            <p className="cl-print-meta">
              印刷日 {printedOn}　{LEGEND}
              {data.planned === null ? '（予定を取得できないため「未」は表示していません）' : ''}
            </p>
            <p className="cl-print-meta">
              {data.planned === null ? '' : missingNote(data.startDay)}
            </p>
            {table.rows.length === 0 ? (
              <p className="cl-print-meta">この月の入浴の予定と記録はありません。</p>
            ) : (
              <MonthTable table={table} residentById={residentById} variant="print" />
            )}
          </PrintArea>
        </>
      )}
    </div>
  )
}

interface MonthTableProps {
  table: BathMonthTable
  residentById: Map<number, Resident>
  variant: 'screen' | 'print'
}

/** 月次表（画面と印刷で同じ中身。見た目だけ variant で切り替える） */
function MonthTable({ table, residentById, variant }: MonthTableProps) {
  const screen = variant === 'screen'
  const th = screen ? 'border border-border px-1 py-1 text-center text-xs font-bold text-ink2' : ''
  const td = screen ? 'tabular border border-border px-1 py-1 text-center text-sm text-ink' : ''
  const stickyTh = screen ? 'sticky left-0 z-10 bg-surface2' : 'cl-print-left'
  const stickyTd = screen ? 'sticky left-0 z-10 bg-surface' : 'cl-print-left'
  return (
    <table className={screen ? 'w-max border-collapse' : 'cl-print-table'}>
      <caption className="sr-only">入浴の実施（行＝利用者、列＝日付、右端＝月合計）</caption>
      <thead>
        <tr>
          <th scope="col" rowSpan={2} className={`${th} ${stickyTh} text-left`}>
            居室・氏名
          </th>
          {table.days.map((d) => (
            <th key={d} scope="col" className={`${th} tabular`}>
              {Number(d.slice(8, 10))}
            </th>
          ))}
          <th scope="col" rowSpan={2} className={`${th} ${screen ? '' : 'cl-print-strong'}`}>
            入浴
          </th>
          <th scope="col" rowSpan={2} className={th}>
            入浴なし
          </th>
        </tr>
        <tr>
          {table.days.map((d) => {
            const w = isoWeekdayIndex(d)
            return (
              <th key={d} scope="col" className={th}>
                {w === null ? '' : WEEKDAY_CHAR[w]}
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row) => {
          const r = residentById.get(row.residentId)
          const name = r?.name ?? `利用者番号 ${row.residentId}`
          return (
            <tr key={row.residentId}>
              <th scope="row" className={`${screen ? 'border border-border px-2 py-1 text-left text-sm font-normal text-ink' : ''} ${stickyTd}`}>
                <span className="tabular">{r?.room ?? '—'}</span>
                {'　'}
                <span className={screen ? 'font-bold' : ''}>{name}</span>
                {row.retired ? <span className={screen ? 'text-sm text-ink2' : ''}>（退居）</span> : null}
                {row.hospitalized ? <span className={screen ? 'text-sm text-ink2' : ''}>（入院中）</span> : null}
              </th>
              {row.cells.map((m, i) => (
                <td
                  key={table.days[i]}
                  className={`${td} ${screen && m === 'missing' ? 'bg-warn-bg font-bold text-warn' : ''}`}
                >
                  <span aria-hidden="true">{markText(m)}</span>
                  <span className="sr-only">{`${Number(table.days[i].slice(8, 10))}日 ${markLabel(m)}`}</span>
                </td>
              ))}
              <td className={`${td} ${screen ? 'font-bold' : 'cl-print-strong'}`}>
                {row.totals.billable + row.totals.partial + row.totals.visit}
              </td>
              <td className={td}>{row.totals.cancel}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export default BathMonthPage
