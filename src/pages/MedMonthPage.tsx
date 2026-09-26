// 与薬 月次表（ルート /med/month・「その他」から）。2026-09-26 追加。
//
// 入居者を1人選んで、その月の与薬の実施を表にする（行＝日付、列＝朝・昼・夕・眠前・頓服）。
// マス＝済（服用済み）／残（一部残し）／拒（拒否）／不（不在）／止（医師指示で中止）／落（落薬）／誤（誤薬）、
// 締めを過ぎても記録の無いマスは「未」（その人の服薬の時間帯に設定がある列だけ・施設で記録を始めた日以降だけ）。頓服は回数。
// 月の合計（状態ごとの件数・列ごとの記録と「未」の数・頓服の回数）を下に出す。
// 印刷は既存の印刷部品（PrintArea）で A4 縦。「全員を印刷」は1人1ページ（改ページ）。
//
// 規律:
// - 取得は db.ts の fetchAllResidents / fetchMedSlots / fetchMedMonth / fetchMedFirstDay のみ（月の範囲でだけ引く）
// - 「未」は現在の服薬の時間帯を過去の日にも当てはめた目安（設定の変更の履歴は見ない）。画面と紙の両方に書く
// - 表示中の月・選んだ入居者は保存しない（日付・業務データに紐づく状態＝原則11の既定。開くと常に今月・未選択）
// - 氏名・記録を localStorage・console に出さない。記号は文字（白黒でも区別できる）。色だけで意味を伝えない
// - Tailwind はトークン由来クラスのみ（arbitrary value なし）。印刷の見た目は src/components/print/print.css

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { DbError, fetchAllResidents, fetchMedFirstDay, fetchMedMonth, fetchMedSlots, subscribeMedChanges } from '../lib/db'
import { fmtMonthLabel, isoWeekdayIndex, monthKeyOf, parseMonthKey, shiftMonth } from '../lib/bath'
import { aggregateMedMonth, MED_DEADLINES, MED_MONTH_MISSING_MARK, MED_RECHECK_MS, minutesOfDay } from '../lib/med'
import type { MedMonthMark, MedMonthTable } from '../lib/med'
import { todayIso } from '../lib/format'
import { MED_SLOT_LABEL, MED_SLOTS, MED_STATUS_LABEL, MED_STATUS_MARK, MED_STATUSES } from '../lib/types'
import type { MedAdmin, MedSlot, MedSlotsSetting, Resident } from '../lib/types'
import { EmptyBlock, ErrorBlock, LoadingBlock, ResidentPickerModal, SectionCard } from '../components/ui'
import { PrintArea } from '../components/print/PrintArea'
import type { PrintAreaHandle } from '../components/print/PrintArea'

const WEEKDAY_CHAR = ['月', '火', '水', '木', '金', '土', '日']

const ERR_LOAD = '与薬の月次表を読み込めませんでした。通信状態を確認して、再試行してください。'

const LEGEND = MED_STATUSES.map((s) => `${MED_STATUS_MARK[s]}＝${MED_STATUS_LABEL[s]}`).join('　')

/** 「未」の注記（画面と紙で同じ文）。startDay＝施設で記録を始めた日 */
function missingNote(startDay: string | null): string {
  const from =
    startDay === null ? '記録を始めた日' : `記録を始めた日（${Number(startDay.slice(5, 7))}/${Number(startDay.slice(8, 10))}）`
  const deadlines = MED_SLOTS.map((s) => `${MED_SLOT_LABEL[s]}${MED_DEADLINES[s]}`).join('・')
  return `「未」は${from}以降・現在の服薬の時間帯を当てはめた目安です（過去の設定の変更は反映されません）。今日は締め（${deadlines}）を過ぎた時間帯だけに付けます。`
}

function markText(m: MedMonthMark): string {
  if (m === null) return ''
  if (m === 'missing') return MED_MONTH_MISSING_MARK
  return MED_STATUS_MARK[m]
}

function markLabel(m: MedMonthMark): string {
  if (m === null) return '記録なし'
  if (m === 'missing') return '未記録'
  return MED_STATUS_LABEL[m]
}

/** 1人分の表と見出しに使う情報 */
interface PersonSheet {
  resident: Resident
  slots: MedSlot[]
  table: MedMonthTable
}

interface Loaded {
  month: string
  residentId: number
  records: MedAdmin[]
}

interface Base {
  residents: Resident[]
  settings: MedSlotsSetting[]
  startDay: string | null
}

export function MedMonthPage() {
  const current = monthKeyOf(todayIso())
  const [month, setMonth] = useState<string>(current)
  const [residentId, setResidentId] = useState<number | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [base, setBase] = useState<Base | null>(null)
  const [baseError, setBaseError] = useState<string | null>(null)
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [nowMin, setNowMin] = useState(() => minutesOfDay(new Date()))
  // 全員の印刷（押した時だけ全員分を引く。刷り終えたら1人の表示へ戻す）
  const [printAll, setPrintAll] = useState<{ month: string; records: MedAdmin[] } | null>(null)
  const [printAllBusy, setPrintAllBusy] = useState(false)
  const [printAllError, setPrintAllError] = useState<string | null>(null)
  /** 描き終えてから刷るための合図（1人・全員のどちらも、中身を差し替えた次の描画の後に刷る） */
  const [printSeq, setPrintSeq] = useState(0)
  const printRef = useRef<PrintAreaHandle>(null)

  useEffect(() => {
    const t = window.setInterval(() => setNowMin(minutesOfDay(new Date())), MED_RECHECK_MS)
    return () => window.clearInterval(t)
  }, [])

  const changeMonth = useCallback(
    (next: string) => {
      setMonth(parseMonthKey(next, current) ?? current)
    },
    [current],
  )

  // 名簿（退居された方も含む）・在籍の方の時間帯・記録を始めた日
  useEffect(() => {
    let alive = true
    setBaseError(null)
    void (async () => {
      try {
        const residents = await fetchAllResidents()
        const [settings, startDay] = await Promise.all([
          fetchMedSlots(residents.filter((r) => r.active)),
          fetchMedFirstDay(),
        ])
        if (alive) setBase({ residents, settings, startDay })
      } catch (e) {
        if (alive) setBaseError(e instanceof DbError && e.kind === 'server' ? e.message : ERR_LOAD)
      }
    })()
    return () => {
      alive = false
    }
  }, [tick])

  // 選んだ人のその月の記録
  useEffect(() => {
    if (residentId === null) return
    let alive = true
    setError(null)
    setData((d) => (d !== null && d.month === month && d.residentId === residentId ? d : null))
    fetchMedMonth(month, residentId)
      .then((records) => {
        if (alive) setData({ month, residentId, records })
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof DbError && e.kind === 'server' ? e.message : ERR_LOAD)
      })
    return () => {
      alive = false
    }
  }, [month, residentId, tick])

  // 他の端末の記録を取り込む（表示中の月・表示中の人の行だけ。行を特定できない通知は取り直す側へ倒す）
  useEffect(() => {
    let timer: number | null = null
    const unsub = subscribeMedChanges((table, info) => {
      const row = info?.row ?? null
      if (table === 'med_admin' && row !== null) {
        if (typeof row.admin_on === 'string' && monthKeyOf(row.admin_on) !== month) return
        if (typeof row.resident_id === 'number' && residentId !== null && row.resident_id !== residentId) return
      }
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => setTick((n) => n + 1), 400)
    })
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsub()
    }
  }, [month, residentId])

  const residentById = useMemo(() => {
    const m = new Map<number, Resident>()
    for (const r of base?.residents ?? []) m.set(r.id, r)
    return m
  }, [base])

  const slotsOf = useCallback(
    (id: number): MedSlot[] => base?.settings.find((s) => s.resident_id === id)?.slots ?? [],
    [base],
  )

  const today = todayIso()

  const sheetFor = useCallback(
    (resident: Resident, records: MedAdmin[], monthKey: string): PersonSheet => {
      const slots = resident.active ? slotsOf(resident.id) : []
      return {
        resident,
        slots,
        table: aggregateMedMonth({
          monthKey,
          residentId: resident.id,
          slots,
          records,
          startDay: base?.startDay ?? null,
          today,
          nowMin,
          retired: !resident.active,
        }),
      }
    },
    [slotsOf, base, today, nowMin],
  )

  const one: PersonSheet | null = useMemo(() => {
    if (data === null || data.month !== month || data.residentId !== residentId) return null
    const r = residentById.get(data.residentId)
    return r === undefined ? null : sheetFor(r, data.records, month)
  }, [data, month, residentId, residentById, sheetFor])

  /** 全員の印刷に載せる人: 在籍で時間帯の設定がある方と、その月に記録がある方（退居された方も）。居室順 */
  const allSheets: PersonSheet[] = useMemo(() => {
    if (printAll === null || base === null) return []
    const withRecords = new Set(printAll.records.map((r) => r.resident_id))
    return base.residents
      .filter((r) => (r.active && slotsOf(r.id).length > 0) || withRecords.has(r.id))
      .map((r) => sheetFor(r, printAll.records, printAll.month))
  }, [printAll, base, slotsOf, sheetFor])

  // 刷る中身（1人・全員）を差し替えて描き終えてから刷る。刷り終えたら（afterprint）1人の表示へ戻す
  useEffect(() => {
    if (printSeq === 0) return
    const t = window.setTimeout(() => printRef.current?.print(), 0)
    return () => window.clearTimeout(t)
  }, [printSeq])

  useEffect(() => {
    const after = () => setPrintAll(null)
    window.addEventListener('afterprint', after)
    return () => window.removeEventListener('afterprint', after)
  }, [])

  async function onPrintAll() {
    if (printAllBusy) return
    setPrintAllBusy(true)
    setPrintAllError(null)
    try {
      const records = await fetchMedMonth(month)
      setPrintAll({ month, records })
      setPrintSeq((n) => n + 1)
    } catch (e) {
      setPrintAllError(e instanceof DbError && e.kind === 'server' ? e.message : ERR_LOAD)
    } finally {
      setPrintAllBusy(false)
    }
  }

  /** この方だけを刷る（前に全員を刷った中身が残っていても、1人に戻してから刷る） */
  function onPrintOne() {
    if (one === null) return
    setPrintAll(null)
    setPrintSeq((n) => n + 1)
  }

  const monthLabel = fmtMonthLabel(month)
  const printedOn = (() => {
    const d = new Date()
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  })()
  const selected = residentId === null ? null : (residentById.get(residentId) ?? null)
  const pickerResidents = useMemo(() => {
    const rs = base?.residents ?? []
    return [...rs.filter((r) => r.active), ...rs.filter((r) => !r.active)]
  }, [base])
  const printSheets = printAll !== null ? allSheets : one !== null ? [one] : []

  if (baseError !== null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <ErrorBlock message={baseError} onRetry={() => setTick((n) => n + 1)} />
      </div>
    )
  }
  if (base === null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <LoadingBlock label="与薬の月次表を準備しています…" />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      <SectionCard title={`与薬 月次表 ${monthLabel}`}>
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
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-gap">
          <div className="min-w-0">
            <span className="block text-sm text-ink2">入居者</span>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="mt-1 flex min-h-tap items-center gap-gap rounded border border-border bg-surface px-3 text-left text-base text-ink"
            >
              <span className={selected === null ? 'text-ink3' : 'font-bold'}>
                {selected === null ? '選んでください' : `${selected.room ?? '—'}　${selected.name}${selected.active ? '' : '（退居）'}`}
              </span>
              <span className="text-sm text-link">選ぶ</span>
            </button>
          </div>
          <button
            type="button"
            onClick={onPrintOne}
            disabled={one === null}
            className="inline-flex min-h-tap items-center rounded border border-primary bg-surface px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
          >
            この方を印刷
          </button>
          <button
            type="button"
            onClick={() => void onPrintAll()}
            disabled={printAllBusy}
            className="inline-flex min-h-tap items-center rounded border border-primary bg-surface px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
          >
            {printAllBusy ? '全員分を準備しています…' : '全員を印刷'}
          </button>
        </div>
        {printAllError !== null ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            <span aria-hidden="true">▲ </span>
            {printAllError}
          </p>
        ) : null}

        <p className="mt-2 text-sm text-ink2">
          {LEGEND}　未＝締めを過ぎても記録なし　頓服＝その日の回数
        </p>
        <p className="mt-1 text-sm text-ink2">
          <span aria-hidden="true">ⓘ </span>
          {missingNote(base.startDay)}
        </p>
        <p className="mt-1 text-sm">
          <Link to="/record/med" className="inline-flex min-h-tap items-center text-link">
            与薬チェックを開く<span aria-hidden="true"> ›</span>
          </Link>
        </p>
      </SectionCard>

      {residentId === null ? (
        <EmptyBlock message="入居者を選ぶと、その方の月次表が出ます。全員分は「全員を印刷」から紙に出せます。" actionLabel="入居者を選ぶ" onAction={() => setPickerOpen(true)} />
      ) : error !== null ? (
        <ErrorBlock message={error} onRetry={() => setTick((n) => n + 1)} />
      ) : one === null ? (
        <LoadingBlock label="与薬の月次表を読み込み中です…" />
      ) : (
        <>
          <p className="text-sm text-ink2">
            服薬の時間帯: {one.slots.length === 0 ? (one.resident.active ? '未設定（「未」は付きません）' : '（退居）') : one.slots.map((s) => MED_SLOT_LABEL[s]).join('・')}
          </p>
          <div className="relative overflow-x-auto rounded-lg border border-border bg-surface">
            <MonthTable sheet={one} variant="screen" />
          </div>
          <Totals sheet={one} variant="screen" />
        </>
      )}

      {/* 紙に出す中身（画面には出ない）。A4 縦。全員の時は1人1ページ */}
      <PrintArea ref={printRef} orientation="portrait" paged>
        {printSheets.map((sheet) => (
          <section key={sheet.resident.id} className="cl-print-page">
            <h1 className="cl-print-title">
              与薬 実施表 {fmtMonthLabel(sheet.table.days[0]?.day.slice(0, 7) ?? month)}　{sheet.resident.room ?? ''}　{sheet.resident.name}
              {sheet.resident.active ? '' : '（退居）'}
            </h1>
            <p className="cl-print-meta">
              印刷日 {printedOn}　服薬の時間帯: {sheet.slots.length === 0 ? '未設定' : sheet.slots.map((s) => MED_SLOT_LABEL[s]).join('・')}
            </p>
            <p className="cl-print-meta">{LEGEND}　未＝締めを過ぎても記録なし　頓服＝回数</p>
            <p className="cl-print-meta">{missingNote(base.startDay)}</p>
            <MonthTable sheet={sheet} variant="print" />
            <Totals sheet={sheet} variant="print" />
          </section>
        ))}
      </PrintArea>

      <ResidentPickerModal
        open={pickerOpen}
        residents={pickerResidents}
        onPick={(id) => {
          setPickerOpen(false)
          if (id !== null) setResidentId(id)
        }}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  )
}

interface SheetProps {
  sheet: PersonSheet
  variant: 'screen' | 'print'
}

/** 1人の月次表（画面と印刷で同じ中身。見た目だけ variant で切り替える） */
function MonthTable({ sheet, variant }: SheetProps) {
  const screen = variant === 'screen'
  const th = screen ? 'border border-border px-2 py-1 text-center text-sm font-bold text-ink2' : ''
  const td = screen ? 'tabular border border-border px-2 py-1 text-center text-base text-ink' : ''
  return (
    <table className={screen ? 'w-full border-collapse' : 'cl-print-table'}>
      <caption className="sr-only">与薬の実施（行＝日付、列＝時間帯と頓服の回数）</caption>
      <thead>
        <tr>
          <th scope="col" className={`${th} ${screen ? '' : 'cl-print-left'}`}>
            日
          </th>
          {MED_SLOTS.map((s) => (
            <th key={s} scope="col" className={th}>
              {MED_SLOT_LABEL[s]}
            </th>
          ))}
          <th scope="col" className={th}>
            頓服
          </th>
        </tr>
      </thead>
      <tbody>
        {sheet.table.days.map((d) => {
          const w = isoWeekdayIndex(d.day)
          const label = `${Number(d.day.slice(5, 7))}/${Number(d.day.slice(8, 10))}（${w === null ? '' : WEEKDAY_CHAR[w]}）`
          return (
            <tr key={d.day}>
              <th scope="row" className={`${screen ? 'border border-border px-2 py-1 text-left text-sm font-normal text-ink' : 'cl-print-left'} tabular`}>
                {label}
              </th>
              {MED_SLOTS.map((s) => {
                const m = d.cells[s]
                const incident = m === 'dropped' || m === 'wrong'
                return (
                  <td
                    key={s}
                    className={`${td} ${screen && (m === 'missing' || incident) ? 'bg-danger-bg font-bold text-danger' : ''} ${!screen && (m === 'missing' || incident) ? 'cl-print-strong' : ''}`}
                  >
                    <span aria-hidden="true">{markText(m)}</span>
                    <span className="sr-only">{`${label} ${MED_SLOT_LABEL[s]} ${markLabel(m)}`}</span>
                  </td>
                )
              })}
              <td className={td}>
                <span aria-hidden="true">{d.prn > 0 ? d.prn : ''}</span>
                <span className="sr-only">{`${label} 頓服 ${d.prn}回`}</span>
              </td>
            </tr>
          )
        })}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" className={`${screen ? 'border border-border px-2 py-1 text-left text-sm font-bold text-ink' : 'cl-print-left cl-print-strong'}`}>
            記録
          </th>
          {MED_SLOTS.map((s) => (
            <td key={s} className={`${td} ${screen ? 'font-bold' : 'cl-print-strong'}`}>
              {sheet.table.totals.bySlot[s].recorded}
            </td>
          ))}
          <td className={`${td} ${screen ? 'font-bold' : 'cl-print-strong'}`}>{sheet.table.totals.prn}</td>
        </tr>
        <tr>
          <th scope="row" className={`${screen ? 'border border-border px-2 py-1 text-left text-sm font-bold text-ink' : 'cl-print-left cl-print-strong'}`}>
            未
          </th>
          {MED_SLOTS.map((s) => (
            <td key={s} className={`${td} ${screen ? 'font-bold' : 'cl-print-strong'}`}>
              {sheet.table.totals.bySlot[s].missing}
            </td>
          ))}
          <td className={td}>—</td>
        </tr>
      </tfoot>
    </table>
  )
}

/** 月の合計（状態ごとの件数・「未」・頓服の回数） */
function Totals({ sheet, variant }: SheetProps) {
  const t = sheet.table.totals
  const text = `${MED_STATUSES.map((s) => `${MED_STATUS_MARK[s]} ${t.byStatus[s]}`).join('・')}・未 ${t.missing}・頓服 ${t.prn}回`
  if (variant === 'print') return <p className="cl-print-meta">月の合計: {text}</p>
  return (
    <p className="tabular text-base text-ink">
      <span className="font-bold">月の合計</span>　{text}
      {t.byStatus.dropped + t.byStatus.wrong > 0 ? (
        <span className="ml-2 font-bold text-danger">
          <span aria-hidden="true">▲ </span>落薬・誤薬 {t.byStatus.dropped + t.byStatus.wrong}件
        </span>
      ) : null}
    </p>
  )
}

export default MedMonthPage
