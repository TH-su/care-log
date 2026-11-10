// デイ（せせらぎ）の「月の実績」（ルート /record/daycare/month?m=YYYY-MM）。2026-11-10 計画E（改善計画 v1 §3 の E・段階5）。
//
// 読むだけの画面（書き込みなし）。その月の予定と実績の差・休みの数・稼働率を1画面で見る（すぐろくの「月の予定を実績に登録・稼働率の集計」、
// カイポケの不満「予定・実績を1人ずつ操作する」「入れたのに後で未入力になる」）。
// 上の帯＝数のタイル（延べ予定・予定あり来所・予定あり休み・予定外の来所・未記録・延べ来所・営業日・稼働率・予定に対する来所の割合）／
// 休みの理由別／日ごとの表（1行1日・その日の今日の画面へ）／方ごとの表（1行1人・未記録のある方を上に・1人の画面へ）。
// 数え方は src/lib/daycareMonth.ts（今日の画面と同じ buildDaycareBoard を日ごとに使う＝日の画面と月の画面の数が食い違わない）。
//
// 規律:
// - 取得は db.ts の fetchDaycareDaysMonth・fetchDaycareAttendanceMonth と、今ある名簿（cachedReads）・休業日の設定（getAppSetting）。
//   1回の読み込みは4本（名簿は控えに相乗り。出欠・写しは1000件ずつ＝ふつうは1本ずつ）。写しの無い過去の日（休業日でない）がある時だけ、
//   その曜日の今の週間計画を fetchDaycarePlan で読む（曜日ごとに1本・最大7本・2026-11-10 反証 中1）。購読は足さない（〔最新に更新〕で読み直す）。
//   2000件を超えたら数を出さない（db.ts が例外）
// - 予定の写しの無い過去の日は「予定の写しなし」と出し、数えない（今の曜日の型で作り直さない＝過去を作り話にしない）。今の週間計画に
//   その曜日の予定がある日は「▲ 記録の無い営業日かもしれない日」として目立たせる（手がかりだけ・数には入れない）
// - 今日は60秒ごと・画面に戻った時に取り直し、日付が変わったら今月を見ている時だけ読み直す（反証 軽4）
// - 現在地（月）は URL の ?m= で持つ（再読み込みで同じ月。不正値・先の月は今月）。端末には保存しない
// - 氏名・記録を localStorage・console に出さない。色だけで意味を伝えない（▲ と文字を併記）。押す所は 44px 以上・文字は 15px 以上
// - Tailwind はトークン由来のクラスのみ（新しい色は足さない）。表の枠は一括の画面と同じ .dc-table-fit・useTableFit（見出しの行を上に残す）

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { DbError, fetchDaycareAttendanceMonth, fetchDaycareDaysMonth, fetchDaycarePlan, getAppSetting } from '../lib/db'
import { fetchAllResidents } from '../lib/cachedReads'
import { fmtMonthLabel, isoWeekdayIndex, monthKeyOf, parseMonthKey, shiftMonth } from '../lib/bath'
import {
  DAYCARE_CAPACITY,
  DAYCARE_MONTH_REASONS,
  buildDaycareMonth,
  canGoNextMonth,
  daycareDayPath,
  daycareMonthHintDays,
  daycareMonthPath,
  fmtRate10,
  monthLoadDone,
  monthLoadFail,
  monthLoadStart,
  planHintCount,
  reasonsShort,
  shouldReloadOnDayChange,
} from '../lib/daycareMonth'
import type { DaycareMonthDay, DaycareMonthReason, DaycareMonthReport, MonthLoadState } from '../lib/daycareMonth'
import { personPath } from '../lib/daycarePerson'
import { daycareRowTone } from '../lib/daycareProgress'
import { useTableFit } from '../lib/useTableFit'
import { fmtDayLabel, todayIso } from '../lib/format'
import { DAYCARE_ABSENT_REASON_LABEL } from '../lib/types'
import type { Resident } from '../lib/types'
import { ErrorBlock, LoadingBlock } from '../components/ui'

const ERR_LOAD = 'デイの月の実績を読み込めませんでした。通信状態を確認して、再試行してください。'
const BTN = 'inline-flex min-h-tap items-center justify-center rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:border-border disabled:text-ink3'
/** 注意の印（▲＋太字＋枠。色だけに頼らない＝今日の画面の件数の帯と同じ形） */
const WARN_CHIP = 'inline-flex items-baseline gap-1 rounded border border-warn bg-warn-bg px-1 font-bold text-ink'

/** 理由の呼び名（「理由なし」は DB の知らない値＝古い版の理由など） */
const REASON_LABEL: Record<DaycareMonthReason, string> = { ...DAYCARE_ABSENT_REASON_LABEL, none: '理由なし' }
/** 方ごとの表の短い呼び名（「理由は後で」→「後で」） */
const REASON_SHORT: Record<DaycareMonthReason, string> = { ...REASON_LABEL, later: '後で' }

interface Loaded {
  month: string
  today: string
  report: DaycareMonthReport
  residents: Resident[]
  /** 休業日の設定を読めなかった（休業日を分けずに数えた） */
  closedFailed: boolean
}

/** 表の枠（横・縦に送れる時だけキーボードで選べる。見出しの行は枠の上に残る＝一括の画面と同じ .dc-table-fit） */
function TableBox({ label, children }: { label: string; children: ReactNode }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [scrolls, setScrolls] = useState(false)
  const [scrollsY, setScrollsY] = useState(false)
  useEffect(() => {
    const el = box
    if (!el) return
    const check = () => {
      setScrolls(el.scrollWidth > el.clientWidth + 1)
      setScrollsY(el.scrollHeight > el.clientHeight + 1)
    }
    check()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', check)
      return () => window.removeEventListener('resize', check)
    }
    const ro = new ResizeObserver(check)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [box])
  useTableFit(box)
  return (
    <>
      {scrolls ? (
        <p className="text-sm text-ink2">
          <span aria-hidden="true">⇆ </span>
          表は横にスクロールできます（左の列は残ります）
        </p>
      ) : null}
      <div
        ref={setBox}
        role="region"
        aria-label={`${label}${scrolls ? '（横にスクロールできます）' : ''}`}
        tabIndex={scrolls || scrollsY ? 0 : undefined}
        className="dc-table-fit relative isolate overflow-auto rounded-lg border border-border"
      >
        {children}
      </div>
    </>
  )
}

/** 数のタイル。warn＝注意（▲＋枠）。value=null は「—」（数えられない） */
function Tile({ label, value, sub, warn = false, srNull }: { label: string; value: string | number | null; sub?: ReactNode; warn?: boolean; srNull?: string }) {
  return (
    <li className={`flex min-w-0 flex-col rounded-lg border px-3 py-2 ${warn ? 'border-warn bg-warn-bg' : 'border-border bg-surface'}`}>
      <span className="text-sm text-ink2">
        {warn ? <span aria-hidden="true">▲ </span> : null}
        {label}
      </span>
      <span className="font-num text-2xl font-bold text-ink">
        {value === null ? (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">{srNull ?? '数えられません'}</span>
          </>
        ) : (
          value
        )}
      </span>
      {sub !== undefined ? <span className="break-words text-sm text-ink2">{sub}</span> : null}
    </li>
  )
}

/**
 * 数えない日の行の文（写しなし・読めなかった・休業日。記録が残っていれば数だけ添える）。写しの無い過去の日は、今の週間計画の
 * その曜日の人数を手がかりとして添える（数には入れない＝反証 中1）
 */
function uncountedText(d: DaycareMonthDay): string {
  const hint = d.maybeBusiness
    ? `今の週間計画では ${d.planHint}名・数えていません`
    : d.planHintUnread
      ? '数えていません・今の週間計画を読めませんでした'
      : '数えていません'
  const why =
    d.kind === 'closed'
      ? '休業日'
      : d.isToday
        ? '今日の予定の写しはまだありません（今日の画面で最初の記録をすると作られます）'
        : d.noSnapshot === 'unknown'
          ? `予定の写しを読めなかった日（${hint}）`
          : `予定の写しなし（${hint}）`
  const rec = d.uncountedCame + d.uncountedAbsent
  return rec > 0 ? `${why}・記録あり（来所 ${d.uncountedCame}・休み ${d.uncountedAbsent}）は数に入れていません` : why
}

/** 今日を取り直す間隔（今日の画面と同じ 60秒） */
const TODAY_TICK_MS = 60_000

export function DaycareMonthPage() {
  const navigate = useNavigate()
  const [search] = useSearchParams()
  // 今日（60秒ごと・画面に戻った時に取り直す＝今日の画面と同じ・反証 軽4）
  const [today, setToday] = useState(todayIso())
  const currentMonth = monthKeyOf(today)
  // 現在地（月）は URL の ?m=（再読み込みで同じ月・不正値と先の月は今月＝parseMonthKey）
  const month = parseMonthKey(search.get('m'), currentMonth) ?? currentMonth
  // 読み込みの状態（純関数 monthLoadStart・Done・Fail＝別の月の遅れた応答・古い世代を捨てる・失敗と月の変更で前の数を消す）
  const [load, setLoad] = useState<MonthLoadState<Loaded>>({ month, gen: 0, data: null, error: null, loading: true })
  const genRef = useRef(0)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const tick = () => setToday(todayIso())
    const t = window.setInterval(tick, TODAY_TICK_MS)
    const vis = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', vis)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', vis)
    }
  }, [])

  useEffect(() => {
    const gen = ++genRef.current
    setLoad((prev) => monthLoadStart(prev, month, gen))
    const at = todayIso()
    void (async () => {
      try {
        // 1回の読み込み: 名簿（控えに相乗り）・休業日の設定・その月の予定の写し・その月の出欠の4本
        const [residents, closed, snapshots, attendance] = await Promise.all([
          fetchAllResidents(),
          getAppSetting('daycare_closed_dates')
            .then((v) => ({ v, failed: false }))
            .catch(() => ({ v: null as string | null, failed: true })),
          fetchDaycareDaysMonth(month),
          fetchDaycareAttendanceMonth(month),
        ])
        // 写しの無い過去の日（休業日でない）がある時だけ、その曜日の今の週間計画を読む（曜日ごとに1本・手がかりだけ・数には入れない）。
        // 読めない曜日は null（「今の週間計画を読めませんでした」と出すだけで、画面は止めない）
        const hintDays = daycareMonthHintDays({ month, today: at, snapshots, closedDates: closed.v })
        const hints = await Promise.all(
          hintDays.map(async (d) => {
            try {
              const r = await fetchDaycarePlan(d)
              return [isoWeekdayIndex(d), r.missing ? null : planHintCount(r.rows, r.source, residents)] as const
            } catch {
              return [isoWeekdayIndex(d), null] as const
            }
          }),
        )
        const weekdayPlanned = new Map<number, number | null>()
        for (const [w, n] of hints) if (w !== null) weekdayPlanned.set(w, n)
        const report = buildDaycareMonth({ month, today: at, snapshots, attendance, residents, closedDates: closed.v, weekdayPlanned })
        if (report === null) {
          setLoad((prev) => monthLoadFail(prev, month, gen, ERR_LOAD))
          return
        }
        setLoad((prev) => monthLoadDone(prev, month, gen, { month, today: at, report, residents, closedFailed: closed.failed }))
      } catch (e) {
        // 読み切れない（上限）・読めない時は数を出さない（前に出していた数も消す＝欠けた数を見せない）
        setLoad((prev) => monthLoadFail(prev, month, gen, e instanceof DbError && e.kind === 'server' ? e.message : ERR_LOAD))
      }
    })()
  }, [month, reloadKey])

  const data = load.month === month ? load.data : null
  const error = load.month === month ? load.error : null
  const loading = load.loading || load.month !== month

  // 日付が変わったら、今月を見ている時だけ読み直す（昨日の「今日の未到着」を未記録に・今日を数える日にする＝反証 軽4）
  const loadedRef = useRef<{ month: string; today: string } | null>(null)
  loadedRef.current = data === null ? null : { month: data.month, today: data.today }
  useEffect(() => {
    if (shouldReloadOnDayChange(loadedRef.current, today)) setReloadKey((n) => n + 1)
  }, [today])

  const goMonth = (m: string) => navigate(daycareMonthPath(parseMonthKey(m, currentMonth) ?? currentMonth, currentMonth), { replace: true })
  const monthLabel = fmtMonthLabel(month)

  const header = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-gap">
        <Link to="/record/daycare" className={`${BTN} font-bold`}>
          <span aria-hidden="true">‹ </span>今日の画面へ
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-gap" role="group" aria-label="月">
        <button type="button" onClick={() => goMonth(shiftMonth(month, -1))} className={BTN} aria-label="前の月へ">
          <span aria-hidden="true">‹</span>
          <span className="ml-1 text-sm">前の月</span>
        </button>
        <span className="min-w-28 text-center text-lg font-bold text-ink" aria-live="polite">
          {monthLabel}
          {month === currentMonth ? <span className="ml-2 text-base text-ok">今月</span> : null}
        </span>
        <button type="button" onClick={() => goMonth(shiftMonth(month, 1))} disabled={!canGoNextMonth(month, currentMonth)} className={BTN} aria-label="次の月へ">
          <span className="mr-1 text-sm">次の月</span>
          <span aria-hidden="true">›</span>
        </button>
        {month !== currentMonth ? (
          <button type="button" onClick={() => goMonth(currentMonth)} className="min-h-tap rounded border border-primary px-3 text-sm font-bold text-primary">
            今月
          </button>
        ) : null}
        <button type="button" onClick={() => setReloadKey((n) => n + 1)} disabled={loading} className={`${BTN} text-sm`}>
          最新に更新
        </button>
        {loading && data !== null ? (
          <span role="status" className="text-sm text-ink2">
            読み直しています…
          </span>
        ) : null}
      </div>
    </div>
  )

  if (data === null) {
    return (
      <div className="w-full space-y-3">
        {header}
        {error !== null ? <ErrorBlock message={error} onRetry={() => setReloadKey((n) => n + 1)} /> : <LoadingBlock label="デイの月の予定と記録を読み込んでいます…" />}
      </div>
    )
  }

  const { report } = data
  const s = report.summary
  const nameOf = (id: number) => data.residents.find((r) => r.id === id)?.name ?? `利用者ID ${id}`
  const retiredOf = (id: number) => data.residents.find((r) => r.id === id)?.active === false
  const shown = report.days.filter((d) => d.kind !== 'future')
  const future = report.days.filter((d) => d.kind === 'future')
  const fromLabel = report.days.length > 0 ? fmtDayLabel(report.days[0].day) : ''
  const throughLabel = report.through === null ? '' : fmtDayLabel(report.through)
  const laterN = s.reasons.later
  const reasonTotal = DAYCARE_MONTH_REASONS.reduce((n, k) => n + s.reasons[k], 0)

  return (
    <div className="w-full space-y-3">
      {header}
      {error !== null ? <ErrorBlock message={error} onRetry={() => setReloadKey((n) => n + 1)} /> : null}

      <p className="text-base text-ink">
        {report.through === null ? (
          'この月はまだ始まっていません。'
        ) : (
          <>
            {fromLabel}〜{throughLabel}
            {report.through === today ? '（今日）' : ''}を数えています。
            {future.length > 0 ? `今日より後の ${future.length}日は数えていません。` : ''}
          </>
        )}
      </p>

      {/* 上の帯（数のタイル）。列の数は幅で自動（今日のカードと同じ .dc-cards・文字を大きくすると列が減る） */}
      <ul className="dc-cards" aria-label={`${monthLabel}の数`}>
        <Tile label="延べ予定" value={s.planned} sub={s.hospitalized > 0 ? `入院中 延べ${s.hospitalized}名は除く` : undefined} />
        <Tile label="予定あり来所" value={s.plannedCame} />
        <Tile label="予定あり休み" value={s.plannedAbsent} sub={s.extraAbsent > 0 ? `ほかに予定外の休み ${s.extraAbsent}` : undefined} />
        <Tile label="予定外の来所" value={s.extraCame} />
        <Tile
          label="未記録"
          value={s.unrecorded}
          warn={s.unrecorded > 0}
          sub={
            // 数えた日のことだけを言う（写しの無い日は数えていない＝言い切らない・反証 中1）
            `${s.unrecorded > 0 ? '過去の日に来所も休みも無い予定（下の表の ▲）' : `数えた日（${s.countedDays}日）の予定は記録済み`}${
              s.noSnapshotDays > 0 ? `。写しの無い日 ${s.noSnapshotDays}日は数えていません` : ''
            }`
          }
        />
        {s.waitingToday > 0 ? <Tile label="今日の未到着" value={s.waitingToday} sub="未記録には入れていません" /> : null}
        <Tile label="延べ来所数" value={s.came} sub="予定あり＋予定外" />
        <Tile label="営業日数" value={s.businessDays} sub="予定のあった日" />
        <Tile
          label="稼働率"
          value={s.utilization10 === null ? null : fmtRate10(s.utilization10)}
          srNull="営業日がないため出せません"
          sub={`延べ来所 ${s.came} ÷（定員 ${s.capacity} × 営業日 ${s.businessDays}）`}
        />
        <Tile
          label="予定に対する来所の割合"
          value={s.attendRate10 === null ? null : fmtRate10(s.attendRate10)}
          srNull="予定がないため出せません"
          sub={`予定あり来所 ${s.plannedCame} ÷ 延べ予定 ${s.planned}`}
        />
      </ul>

      {/* 数えていない日・数に入らない予定の知らせ（文字で。注意は ▲） */}
      <div className="space-y-2">
        {s.maybeBusinessDays > 0 ? (
          <p role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
            <span aria-hidden="true">▲ </span>
            記録の無い営業日かもしれない日 {s.maybeBusinessDays}日（予定の写しが無く、今の週間計画ではその曜日に予定があります）。日ごとの表の ▲ の日を開いて確かめてください。今の週間計画は数に入れていません。
          </p>
        ) : null}
        {s.uncountedRecordDays > 0 ? (
          <p role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
            <span aria-hidden="true">▲ </span>
            数えていない日に、来所・休みの記録がある日が {s.uncountedRecordDays}日あります（日ごとの表の ▲）。その記録は上の数に入れていません。
          </p>
        ) : null}
        {s.noSnapshotDays > 0 ? (
          <p role="status" className="rounded-lg border border-border bg-surface2 p-3 text-sm text-ink2">
            予定の写しの無い日 {s.noSnapshotDays}日は数えていません（今の週間計画で過去の予定を作り直しません）。
            {s.planHintUnreadDays > 0 ? `うち ${s.planHintUnreadDays}日は、今の週間計画も読めず、予定のある曜日か確かめられませんでした。` : ''}
          </p>
        ) : null}
        {s.closedCountedDays > 0 ? (
          <p role="status" className="rounded-lg border border-border bg-surface2 p-3 text-sm text-ink2">
            休業日の設定の日に予定の写しがある日 {s.closedCountedDays}日は、今日の画面と同じく数えています（日ごとの表に「休業日の設定の日」）。
          </p>
        ) : null}
        {s.unconfirmed > 0 || s.planWarn > 0 ? (
          <p role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
            <span aria-hidden="true">▲ </span>
            予定 要確認: {s.planWarn > 0 ? `予定の誤り（記録が2件など）延べ ${s.planWarn}件` : ''}
            {s.planWarn > 0 && s.unconfirmed > 0 ? '・' : ''}
            {s.unconfirmed > 0 ? `週間計画と照合できない予定 延べ ${s.unconfirmed}件（数に入れていません）` : ''}。事務所で週間計画を確かめてください。
          </p>
        ) : null}
        {s.notInRoster > 0 ? (
          <p role="status" className="rounded-lg border border-border bg-surface2 p-3 text-sm text-ink2">
            <span aria-hidden="true">ⓘ </span>名簿に無い方（外部利用者など）の予定 延べ {s.notInRoster}件は数えていません（稼働率にも入りません）。
          </p>
        ) : null}
        {data.closedFailed ? (
          <p role="status" className="rounded-lg border border-border bg-surface2 p-3 text-sm text-ink2">
            休業日の設定を読めませんでした。休業日を分けずに数えています。
          </p>
        ) : null}
      </div>

      {/* 休みの理由別（合計は休みの数＝予定あり休み＋予定外の休み と一致。「理由は後で」は別枠） */}
      <section aria-labelledby="dc-month-reasons" className="space-y-2">
        <h2 id="dc-month-reasons" className="text-lg font-bold text-ink">
          休みの理由別（合計 {reasonTotal}）
        </h2>
        <ul className="flex flex-wrap gap-gap" aria-label="休みの理由別">
          {DAYCARE_MONTH_REASONS.filter((k) => k !== 'later' && (k !== 'none' || s.reasons.none > 0)).map((k) => (
            <li key={k} className="inline-flex min-h-tap items-center gap-2 rounded border border-border bg-surface px-3 text-base text-ink">
              <span>{REASON_LABEL[k]}</span>
              <span className="font-num text-lg font-bold">{s.reasons[k]}</span>
            </li>
          ))}
          <li className={`inline-flex min-h-tap items-center gap-2 rounded border px-3 text-base text-ink ${laterN > 0 ? 'border-warn bg-warn-bg font-bold' : 'border-dashed border-border-strong bg-surface'}`}>
            {laterN > 0 ? <span aria-hidden="true">▲</span> : null}
            <span>{REASON_LABEL.later}</span>
            <span className="font-num text-lg font-bold">{laterN}</span>
          </li>
        </ul>
        <p className="text-sm text-ink2">
          合計 {reasonTotal} ＝ 予定あり休み {s.plannedAbsent}
          {s.extraAbsent > 0 ? ` ＋ 予定外の休み ${s.extraAbsent}` : ''}。「理由は後で」は、その日の1人の画面で理由を選び直せます。
        </p>
      </section>

      {/* 日ごとの表（1行1日）。日付を押すとその日の今日の画面へ */}
      <section aria-labelledby="dc-month-days" className="space-y-2">
        <h2 id="dc-month-days" className="text-lg font-bold text-ink">
          日ごと
        </h2>
        {shown.length === 0 ? (
          <p className="text-base text-ink2">数える日はまだありません。</p>
        ) : (
          <TableBox label={`${monthLabel}の日ごとの表`}>
            <table className="w-full min-w-max border-collapse text-base">
              <caption className="sr-only">
                {monthLabel}の日ごとの表（予定は入院中を除く。来所は予定のあった方、予定外は予定に無かった方の来所。日付を押すとその日の今日の画面を開きます）
              </caption>
              <thead>
                <tr className="border-b border-border-strong bg-surface2 text-left">
                  <th scope="col" className="sticky left-0 top-0 z-30 bg-surface2 px-2 py-2 text-sm font-bold text-ink2">
                    日付
                  </th>
                  {['予定', '来所', '予定外', '休み', '未記録', '要確認', '営業日'].map((h) => (
                    <th key={h} scope="col" className="sticky top-0 z-20 bg-surface2 px-2 py-2 text-right text-sm font-bold text-ink2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((d, i) => {
                  const rowBg = daycareRowTone(i)
                  const counted = d.kind === 'counted'
                  const warnUncounted = !counted && (d.uncountedCame + d.uncountedAbsent > 0 || d.maybeBusiness)
                  const review = d.planWarn + d.unconfirmed
                  return (
                    <tr key={d.day} className={`border-b border-border align-middle ${rowBg}`}>
                      <th scope="row" className={`sticky left-0 z-10 ${rowBg} px-2 py-1 text-left font-normal`}>
                        <Link
                          to={daycareDayPath(d.day, today)}
                          aria-label={`${fmtDayLabel(d.day)}${d.isToday ? '（今日）' : ''}の今日の画面を開く`}
                          className="flex min-h-tap items-center whitespace-nowrap rounded font-bold text-link underline-offset-2 hover:underline"
                        >
                          {fmtDayLabel(d.day)}
                          {d.isToday ? <span className="ml-1 text-sm text-ok">今日</span> : null}
                          <span aria-hidden="true"> ›</span>
                        </Link>
                        {d.closedSetting && counted ? <span className="block text-sm text-ink2">休業日の設定の日</span> : null}
                      </th>
                      {counted ? (
                        <>
                          <td className="px-2 py-1 text-right font-num">{d.planned}</td>
                          <td className="px-2 py-1 text-right font-num">{d.plannedCame}</td>
                          <td className="px-2 py-1 text-right font-num">{d.extraCame}</td>
                          <td className="px-2 py-1 text-right font-num">
                            {d.plannedAbsent}
                            {d.extraAbsent > 0 ? <span className="ml-1 text-sm text-ink2">（ほか予定外 {d.extraAbsent}）</span> : null}
                          </td>
                          <td className="px-2 py-1 text-right">
                            {d.unrecorded > 0 ? (
                              <span className={WARN_CHIP}>
                                <span aria-hidden="true">▲</span>未記録 <span className="font-num">{d.unrecorded}</span>
                              </span>
                            ) : d.waitingToday > 0 ? (
                              <span className="text-sm text-ink2">今日 未到着 {d.waitingToday}</span>
                            ) : (
                              <span className="font-num">0</span>
                            )}
                          </td>
                          <td className="px-2 py-1 text-right">
                            {review > 0 ? (
                              <span className={WARN_CHIP}>
                                <span aria-hidden="true">▲</span>
                                {[d.planWarn > 0 ? `予定の誤り ${d.planWarn}` : '', d.unconfirmed > 0 ? `照合できない ${d.unconfirmed}` : ''].filter((t) => t !== '').join('・')}
                              </span>
                            ) : (
                              <span className="font-num">0</span>
                            )}
                          </td>
                          <td className="px-2 py-1 text-right text-sm">
                            {d.business ? (
                              '営業'
                            ) : (
                              <span className="text-ink2">{d.planned === 0 && d.extraCame > 0 ? '予定なし（予定外の来所のみ）' : '予定なし'}</span>
                            )}
                          </td>
                        </>
                      ) : (
                        <td colSpan={7} className="px-2 py-1 text-sm">
                          {warnUncounted ? (
                            <span className={WARN_CHIP}>
                              <span aria-hidden="true">▲</span>
                              {uncountedText(d)}
                            </span>
                          ) : (
                            <span className="text-ink2">{uncountedText(d)}</span>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableBox>
        )}
      </section>

      {/* 方ごとの表（1行1人）。未記録のある方を上に（「入れたのに後で未入力」を見つけやすく）。氏名を押すと1人の画面へ */}
      <section aria-labelledby="dc-month-persons" className="space-y-2">
        <h2 id="dc-month-persons" className="text-lg font-bold text-ink">
          方ごと（未記録のある方が上）
        </h2>
        {report.persons.length === 0 ? (
          <p className="text-base text-ink2">この月に数えた予定・記録はありません。</p>
        ) : (
          <TableBox label={`${monthLabel}の方ごとの表`}>
            <table className="w-full min-w-max border-collapse text-base">
              <caption className="sr-only">
                {monthLabel}の方ごとの表（未記録のある方が上。氏名を押すと1人の画面を開きます。未記録のある方は最後の未記録の日、ほかはその月の最後の日）
              </caption>
              <thead>
                <tr className="border-b border-border-strong bg-surface2 text-left">
                  <th scope="col" className="sticky left-0 top-0 z-30 bg-surface2 px-2 py-2 text-sm font-bold text-ink2">
                    <span className="dc-vital-name block">氏名</span>
                  </th>
                  {['予定', '来所', '休み', '予定外', '未記録'].map((h) => (
                    <th key={h} scope="col" className="sticky top-0 z-20 bg-surface2 px-2 py-2 text-right text-sm font-bold text-ink2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.persons.map((x, i) => {
                  const rowBg = daycareRowTone(i)
                  const name = nameOf(x.residentId)
                  const reasons = reasonsShort(x.reasons, REASON_SHORT)
                  return (
                    <tr key={x.residentId} className={`border-b border-border align-middle ${rowBg}`}>
                      <th scope="row" className={`sticky left-0 z-10 ${rowBg} px-2 py-1 text-left font-normal`}>
                        <div className="dc-vital-name">
                          <Link
                            to={personPath(x.residentId, x.openDay, today)}
                            aria-label={`${name}さんの${fmtDayLabel(x.openDay)}の1日の記録を開く`}
                            className="flex min-h-tap flex-col justify-center rounded underline-offset-2 hover:underline"
                          >
                            <span className="text-base font-bold leading-tight text-link">
                              {name}
                              <span aria-hidden="true"> ›</span>
                            </span>
                            {retiredOf(x.residentId) ? <span className="text-sm leading-tight text-ink2">退居</span> : null}
                          </Link>
                        </div>
                      </th>
                      <td className="px-2 py-1 text-right font-num">
                        {x.planned}
                        {x.hospitalized > 0 ? <span className="block text-sm text-ink2">入院中 {x.hospitalized}日は除く</span> : null}
                      </td>
                      <td className="px-2 py-1 text-right font-num">{x.plannedCame}</td>
                      <td className="px-2 py-1 text-right">
                        <span className="font-num">{x.absent}</span>
                        {reasons !== '' ? <span className="ml-1 text-sm text-ink2">（{reasons}）</span> : null}
                      </td>
                      <td className="px-2 py-1 text-right font-num">{x.extraCame}</td>
                      <td className="px-2 py-1 text-right">
                        {x.unrecorded > 0 ? (
                          <span className={WARN_CHIP}>
                            <span aria-hidden="true">▲</span>未記録 <span className="font-num">{x.unrecorded}</span>
                            <span className="text-sm font-normal">（{x.unrecordedDays.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`).join('・')}）</span>
                          </span>
                        ) : (
                          <span className="font-num">0</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableBox>
        )}
      </section>

      <p className="text-sm text-ink2">
        数え方は今日の画面と同じです（予定は入院中を除く・予定外は予定に無かった方の来所）。稼働率は定員 {DAYCARE_CAPACITY}名で数えています。読むだけの画面です（直す時は日付・氏名を押してその日の画面で）。
      </p>
    </div>
  )
}

export default DaycareMonthPage
