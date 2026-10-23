// デイ（せせらぎ）段階3b: 機能訓練の画面の「居宅訪問の期限」の区画と、居宅訪問の記録の小窓（2026-10-23・代表承認・段階3の計画 2.2・3.2）。
//
// ・期限は、その方の直近の居宅訪問の訪問日から毎回数える（trainingDue.ts の homeVisitDueList。規則と間近の日数は計画書の写しの設定）
// ・数（期限切れ・間近・記録なし・説明の記録なし）を先に出し、一覧は〔一覧を開く〕で出す（肩越しの覗き見を想定＝計画 1.1）。
//   開いているかだけを端末に残す（LS.dcTrainingDueOpen・'1'／'0' のホワイトリスト。利用者・期限・記録は残さない＝原則11）
// ・計画書の写しは読むだけ（書くのは 3c の事務所の PC）。写しの状態を3つに分けて出す: 表が無い＝まだ使えません／
//   読めない＝確かめられません／0件＝「訪問の記録が無い方は出ていません」（「期限切れなし」と読まれないように＝計画 2.2）
// ・居宅訪問は過去の日も現場が書ける（守りの対象にしない）。未来の日は送らない。2台で同じ方・同じ日・同じ目的は合流しない
// ・開いただけでは書かない（多端末同期の原則9）。書き込みは insertHomeVisit・updateHomeVisit・softDeleteHomeVisit だけ

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DbError,
  fetchHomeVisits,
  fetchTrainingDueCopy,
  insertHomeVisit,
  isQueuePersisted,
  isTrainingMissingError,
  pendingHomeVisitOps,
  softDeleteHomeVisit,
  updateHomeVisit,
} from '../lib/db'
import {
  EXPLAINED_TO_LABEL,
  EXPLAINED_TOS,
  HOME_VISIT_PURPOSE_LABEL,
  HOME_VISIT_PURPOSES,
  HOME_VISIT_TEXT_MAX,
  explanationHalf,
  freshHomeVisitInput,
  homeVisitInputErrors,
  homeVisitInputOf,
  homeVisitKeyTaken,
  homeVisitPayload,
} from '../lib/daycareHomeVisit'
import type { DaycareHomeVisit, HomeVisitInput } from '../lib/daycareHomeVisit'
import {
  DUE_STATE_LABEL,
  dueRuleSource,
  homeVisitCopyNotice,
  homeVisitDueCounts,
  homeVisitDueList,
  homeVisitNarrows,
  latestVisit,
  normalizeDueRule,
  normalizeWarnDays,
} from '../lib/trainingDue'
import type { DueCopyRow, DueCopySettings, HomeVisitDueRow, WeekScope } from '../lib/trainingDue'
import { fmtDayLabel, isoDate } from '../lib/format'
import { LS } from '../lib/types'
import type { Resident, Staff } from '../lib/types'
import { ConfirmDialog, ModalShell, useToast } from './ui'

const MSG_QUEUED = '電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度押してください。'
const MSG_TAKEN = '同じ方・同じ日・同じ目的の居宅訪問が、先に別の端末で記録されていました。その記録を開きました。確かめてください。'
/** 先の記録があったが読めなかった時（何も開いていないので「開きました」と言わない＝反証 軽2） */
const MSG_TAKEN_UNREAD =
  '同じ方・同じ日・同じ目的の居宅訪問が、先に別の端末で記録されています。読み込めなかったので、もう一度〔記録する〕を押すと、その記録を開きます（書いた内容は消えません）。'
/** 既存の記録の訪問日・目的を、同じ方の別の記録と同じにした時（DB の1人・1日・1目的に1件に当たる前に止める＝反証 中1） */
const MSG_DUP = '同じ方・同じ日・同じ目的の居宅訪問の記録が、すでにあります。訪問日か目的を確かめてください。'
const MSG_CONFLICT = '他の端末で先に直されていました。読み直しました。確かめてから、もう一度直してください。'
const MSG_STOPPED = '送れずに止まっている居宅訪問の記録があります。設定の「送れていない記録」で、いまの記録とくらべて選ぶか、取り下げてください。'
const MSG_HALF = '説明は「説明した相手」と「説明した日」をそろえて入れてください（片方だけの間は「説明の記録なし」と数えます）。'
const RULE_TEXT: Record<'calendar' | 'days90' | 'min', string> = {
  calendar: '暦の月で3か月（応当日が無い月は月末）',
  days90: '90日',
  min: '暦の月で3か月と90日の早い方',
}

type Msg = { tone: 'info' | 'warn' | 'danger'; text: string }
type Loaded =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error' }
  | { status: 'ready'; visits: DaycareHomeVisit[]; copy: { rows: DueCopyRow[]; settings: DueCopySettings | null } | 'error' }
/** 小窓（新しい記録は row=null。rid=null は方を選ぶ前） */
type Editor = { rid: number | null; row: DaycareHomeVisit | null; input: HomeVisitInput; note?: string; showErr?: true }

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(LS.dcTrainingDueOpen) === '1'
  } catch {
    return false
  }
}
function writeOpen(v: boolean): void {
  try {
    window.localStorage.setItem(LS.dcTrainingDueOpen, v ? '1' : '0')
  } catch {
    // 保存できなくても操作は続ける
  }
}

const md = (ymd: string) => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd)
  return m ? `${Number(m[1])}/${Number(m[2])}` : ''
}

export interface DaycareHomeVisitSectionProps {
  /** 日本時間の今日（期限の状態はこの日で数える） */
  today: string
  residents: Resident[]
  /** 画面の日に来た方（方を選ぶ欄で上に出す） */
  targets: number[]
  staff: Staff[] | null | undefined
  actorId: number | null
  /** 書けない理由（旗が閉じている・記録者が無い など）。null＝書ける */
  blockedReason: string | null
  /** 画面の読み直しの回数（Realtime・〔最新に更新〕で変わる） */
  refreshKey: number
  /**
   * 一覧に出す範囲（案A・積み残し 51・代表者の決定 2026-10-23）。計画書に計画がある方・週間計画でデイの予定がある方・
   * その日に来た方（targets）。undefined＝週間計画の読み込み中。ids が null なら週の分は絞らない（訪問の記録がある方も出す）
   */
  scope: WeekScope | undefined
}

export function DaycareHomeVisitSection({ today, residents, targets, staff, actorId, blockedReason, refreshKey, scope }: DaycareHomeVisitSectionProps) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [open, setOpen] = useState<boolean>(readOpen)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [del, setDel] = useState<DaycareHomeVisit | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)
  const [tick, setTick] = useState(0)
  const { toast, show } = useToast()

  const genRef = useRef(0)
  const load = useCallback(async () => {
    // 読み直しが重なった時に、古い応答で新しい結果を上書きしない（反証 軽9）
    const gen = ++genRef.current
    try {
      const [visits, copy] = await Promise.all([
        fetchHomeVisits(),
        fetchTrainingDueCopy().catch((e: unknown) => {
          if (isTrainingMissingError(e)) throw e
          return 'error' as const
        }),
      ])
      if (gen !== genRef.current) return
      setLoaded({ status: 'ready', visits, copy })
    } catch (e) {
      if (gen !== genRef.current) return
      setLoaded(isTrainingMissingError(e) ? { status: 'missing' } : { status: 'error' })
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load, refreshKey, tick])

  const nameOf = (id: number) => residents.find((r) => r.id === id)?.name ?? `利用者ID ${id}`
  const staffList = (staff ?? []).filter((s) => s.active !== false)
  const staffNameOf = (id: number) => (staff ?? []).find((s) => s.id === id)?.name ?? `職員ID ${id}`
  const pending = pendingHomeVisitOps()
  const stopped = pending.some((p) => p.stopped)
  /** その方の送信待ちの追加（届くまで一覧は前の訪問のまま数えるので、行に添える＝反証 軽7） */
  const pendingAddsOf = (rid: number) => pending.flatMap((p) => (p.kind === 'add' && p.residentId === rid ? [p] : []))
  const toggle = () => {
    setOpen((v) => {
      writeOpen(!v)
      return !v
    })
  }

  const ready = loaded.status === 'ready' ? loaded : null
  const copy = ready !== null && ready.copy !== 'error' ? ready.copy : null
  const dueScope = scope === undefined ? undefined : { week: scope.ids, arrived: targets }
  const rows: HomeVisitDueRow[] =
    ready === null
      ? []
      : homeVisitDueList({
          visits: ready.visits,
          copy: copy?.rows ?? [],
          settings: copy?.settings ?? null,
          people: residents.map((r) => ({ id: r.id, active: r.active })),
          today,
          scope: dueScope,
        })
  /** 訪問の記録だけがある方を外しているか（写しが読めない・まだ写していない時は外さない＝多めに出す側） */
  const narrows = homeVisitNarrows(dueScope, copy?.rows ?? [])
  const counts = homeVisitDueCounts(rows)
  /** その方が計画書の写しで計画を持つか（記録なしの行の添え書き） */
  const hasPlan = (rid: number) => (copy?.rows ?? []).some((c) => c.resident_id === rid && c.latest_plan_date !== null)
  const copyNotice = ready === null ? null : homeVisitCopyNotice(ready.copy)
  const ruleSource = ready === null ? 'default' : dueRuleSource(ready.copy)
  // 写した日時は日本時間の日付で出す（UTC の日付を切り出すと、0〜9時に写した分が前の日になる＝反証 軽6）
  const syncedAt = copy?.settings?.synced_at ?? null
  const syncedDay = syncedAt === null || Number.isNaN(new Date(syncedAt).getTime()) ? null : isoDate(new Date(syncedAt))
  const rule = normalizeDueRule(copy?.settings?.due_rule)
  const warn = normalizeWarnDays(copy?.settings?.warn_days)

  const btn = 'min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:text-ink3'
  const primaryBtn =
    'min-h-tap rounded border-2 border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border-strong disabled:bg-surface disabled:text-ink3'
  const chipCls = (on: boolean) =>
    on
      ? 'min-h-tap min-w-tap max-w-full rounded border-2 border-primary bg-primary px-3 text-base font-bold text-primary-ink'
      : 'min-h-tap min-w-tap max-w-full rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:text-ink3'
  const msgBox = (m: Msg) => (
    <p role="status" className={`rounded border p-2 text-base text-ink ${m.tone === 'info' ? 'border-primary bg-surface' : m.tone === 'warn' ? 'border-warn bg-warn-bg' : 'border-danger bg-danger-bg'}`}>
      <span aria-hidden="true">{m.tone === 'info' ? 'ⓘ ' : '▲ '}</span>
      {m.text}
    </p>
  )
  const queuedMsg = (): Msg => (isQueuePersisted() ? { tone: 'info', text: MSG_QUEUED } : { tone: 'danger', text: MSG_NOT_PERSISTED })
  const errText = (e: unknown) => (e instanceof DbError ? e.message : '保存できませんでした。通信状態を確認して、もう一度お試しください。')

  const visitsOf = (rid: number) => (ready === null ? [] : ready.visits.filter((v) => v.resident_id === rid))
  const openNew = (rid: number | null) => {
    setMsg(null)
    if (blockedReason !== null) {
      setMsg({ tone: 'warn', text: blockedReason })
      return
    }
    setEditor({ rid, row: null, input: freshHomeVisitInput(today, actorId, rid !== null && visitsOf(rid).length > 0) })
  }
  const openRow = (row: DaycareHomeVisit, note?: string) => {
    setMsg(null)
    setEditor({ rid: row.resident_id, row, input: homeVisitInputOf(row), note })
  }
  // 直前の値から足す（続けて押した時に、前の変更を古い値で上書きしない＝3a の E3 で見つけた形）
  const setInput = (patch: Partial<HomeVisitInput>) => setEditor((cur) => (cur === null ? cur : { ...cur, input: { ...cur.input, ...patch } }))
  const pickPerson = (rid: number | null) =>
    setEditor((cur) =>
      cur === null || cur.row !== null
        ? cur
        : { ...cur, rid, input: { ...cur.input, purpose: rid !== null && visitsOf(rid).length > 0 ? 'periodic' : 'initial' } },
    )

  const save = async () => {
    const ed = editor
    if (ed === null) return
    const errs = homeVisitInputErrors(ed.input, today)
    if (ed.rid === null || Object.keys(errs).length > 0) {
      setEditor({ ...ed, showErr: true })
      return
    }
    if (blockedReason !== null) {
      setEditor({ ...ed, note: blockedReason })
      return
    }
    const rid = ed.rid
    // 既存の記録の訪問日・目的を、同じ方の別の記録と同じにした時は送らずに知らせる（反証 中1）
    const editingRow = ed.row
    // この端末で取り消しを送信待ちにしている記録は、届けば消えるので重なりとみなさない（確認の反証 軽4）
    const removedIds = new Set(pending.flatMap((p) => (p.kind === 'update' && p.deleted && !p.stopped ? [p.rowId] : [])))
    if (editingRow !== null && homeVisitKeyTaken(visitsOf(rid), editingRow, ed.input.visited_on, ed.input.purpose, removedIds)) {
      setEditor({ ...ed, note: MSG_DUP })
      return
    }
    setBusy(true)
    try {
      if (ed.row === null) {
        const r = await insertHomeVisit({ resident_id: rid, recorded_by: actorId, ...homeVisitPayload(ed.input) })
        if (r.kind === 'queued') {
          setEditor(null)
          setMsg(queuedMsg())
        } else if (r.kind === 'taken') {
          // 先の記録を開く。この端末で書いた文は、知らせの中に残す（打ち直さずに写せるように＝反証 軽3。端末には保存しない）
          const typed = [
            ed.input.life_status.trim() !== '' ? `生活の状況「${ed.input.life_status.trim()}」` : '',
            ed.input.explanation.trim() !== '' ? `説明の内容「${ed.input.explanation.trim()}」` : '',
          ]
            .filter((x) => x !== '')
            .join('・')
          const keep = typed === '' ? '' : `この端末で書いた内容（保存されていません）: ${typed}`
          if (r.row !== null) openRow(r.row, keep === '' ? MSG_TAKEN : `${MSG_TAKEN} ${keep}`)
          else setEditor({ ...ed, note: keep === '' ? MSG_TAKEN_UNREAD : `${MSG_TAKEN_UNREAD} ${keep}` })
        } else {
          setEditor(null)
          show(`${nameOf(rid)}さんの居宅訪問（${md(r.row.visited_on)}）を記録しました`)
        }
      } else {
        const r = await updateHomeVisit(ed.row, homeVisitPayload(ed.input), { editedBy: actorId })
        setEditor(null)
        if (r === 'queued') setMsg(queuedMsg())
        else if (r === 'conflict') setMsg({ tone: 'warn', text: MSG_CONFLICT })
        else setMsg({ tone: 'info', text: `${nameOf(rid)}さんの居宅訪問（${md(ed.row.visited_on)}）を直しました。` })
      }
    } catch (e) {
      // 小窓は閉じない（拒否された時に入れた内容を失わない）
      const text = errText(e)
      setEditor((cur) => (cur === null ? cur : { ...cur, note: text }))
    } finally {
      setBusy(false)
      setTick((n) => n + 1)
    }
  }

  const removeVisit = async () => {
    const t = del
    setDel(null)
    if (t === null) return
    if (blockedReason !== null) {
      setMsg({ tone: 'warn', text: blockedReason })
      return
    }
    setBusy(true)
    try {
      const r = await softDeleteHomeVisit(t, { editedBy: actorId })
      if (r === 'queued') setMsg(queuedMsg())
      else if (r === 'conflict') setMsg({ tone: 'warn', text: `取り消せませんでした。${MSG_CONFLICT}` })
      else setMsg({ tone: 'info', text: `${nameOf(t.resident_id)}さんの居宅訪問（${md(t.visited_on)}）の記録を取り消しました。` })
    } catch (e) {
      setMsg({ tone: 'danger', text: `取り消せませんでした。${errText(e)}` })
    } finally {
      setBusy(false)
      setTick((n) => n + 1)
    }
  }

  const ed = editor
  const edErr = ed === null ? {} : homeVisitInputErrors(ed.input, today)
  const errLine = (id: string, text: string | undefined) =>
    text === undefined || ed?.showErr !== true ? null : (
      <span id={id} className="mt-1 block text-sm text-danger">
        {text}
      </span>
    )
  const errProps = (key: keyof typeof edErr, id: string) => ({
    'aria-invalid': ed?.showErr === true && edErr[key] !== undefined,
    'aria-describedby': ed?.showErr === true && edErr[key] !== undefined ? id : undefined,
  })
  // 方を選ぶ欄: 画面の日に来た方を上に、ほかの在籍の方を下に（在籍でない方は出さない）
  const active = residents.filter((r) => r.active)
  const todayPeople = active.filter((r) => targets.includes(r.id))
  const others = active.filter((r) => !targets.includes(r.id))
  const prev = ed !== null && ed.rid !== null && ed.row === null ? latestVisit(visitsOf(ed.rid), ed.rid) : null
  const writable = blockedReason === null

  const stateText = (r: HomeVisitDueRow) => DUE_STATE_LABEL[r.state]
  const stateCls = (r: HomeVisitDueRow) =>
    r.state === 'overdue' ? 'font-bold text-danger' : r.state === 'warn' ? 'font-bold text-warn' : r.state === 'none' ? 'text-ink' : 'text-ink2'

  return (
    <section aria-labelledby="h-home-visit" className="space-y-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <h2 id="h-home-visit" className="text-xl font-bold text-ink">
          居宅訪問の期限
        </h2>
        <button type="button" disabled={busy || loaded.status !== 'ready' || !writable} onClick={() => openNew(null)} className={primaryBtn}>
          居宅訪問を記録
        </button>
      </div>
      {loaded.status === 'loading' ? (
        <p className="text-base text-ink2">読み込んでいます…</p>
      ) : loaded.status === 'missing' ? (
        msgBox({ tone: 'warn', text: 'デイの居宅訪問の記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。' })
      ) : loaded.status === 'error' ? (
        <p role="alert" className="rounded border border-danger bg-danger-bg p-2 text-base text-ink">
          <span aria-hidden="true">▲ </span>居宅訪問の記録を読み込めませんでした。期限は確かめられません。通信状態を確認して、〔最新に更新〕を押してください。
        </p>
      ) : scope === undefined ? (
        // 週間計画（一覧の範囲）の読み込み中は、数と一覧を出さない（読み込みの前後で数が変わって見えないように）
        <p className="text-base text-ink2">週間計画を読み込んでいます…</p>
      ) : (
        <>
          <ul className="flex flex-wrap gap-gap" aria-label={`今日（${fmtDayLabel(today)}）の時点の数`}>
            <li className={`rounded border px-3 py-1 text-base ${counts.overdue > 0 ? 'border-danger bg-danger-bg font-bold text-ink' : 'border-border text-ink'}`}>
              <span aria-hidden="true">▲ </span>期限切れ {counts.overdue}人
            </li>
            <li className={`rounded border px-3 py-1 text-base ${counts.warn > 0 ? 'border-warn bg-warn-bg font-bold text-ink' : 'border-border text-ink'}`}>
              <span aria-hidden="true">△ </span>間近 {counts.warn}人
            </li>
            <li className="rounded border border-border px-3 py-1 text-base text-ink">記録なし {counts.none}人</li>
            <li className={`rounded border px-3 py-1 text-base ${counts.noExplanation > 0 ? 'border-warn bg-warn-bg text-ink' : 'border-border text-ink'}`}>
              説明の記録なし {counts.noExplanation}人
            </li>
          </ul>
          <p className="text-sm text-ink2">
            直近の訪問日から{RULE_TEXT[rule]}で数え、期限の{warn}日前から「間近」と出します（
            {ruleSource === 'error'
              ? '計画書の設定を読めないため、既定の数え方で仮に出しています'
              : ruleSource === 'copied'
                ? `計画書の設定・${syncedDay === null ? '写した日は不明' : `${fmtDayLabel(syncedDay)}に写したもの`}`
                : '計画書の設定がまだ写されていないので既定の数え方'}
            ）。
          </p>
          <p className="text-sm text-ink2">
            {scope.ids === null
              ? `${scope.reason === 'unmatched' ? `週間計画に名簿と照合できない予定が ${scope.unmatched}件ある` : scope.reason === 'noplan' ? '週間計画にデイの予定が1件も見つからない' : '週間計画を読めない'}ため、居宅訪問の記録がある方・計画書に計画がある方と、その日に来た方を出しています。`
              : !narrows
                ? `計画書の写しが${copy === null ? '読めない' : '無い'}ため、居宅訪問の記録がある方、週間計画でデイの予定がある方（曜日を問わず）、その日に来た方を出しています（訪問の記録が無い方は「記録なし」）。`
                : '計画書に計画がある方、週間計画でデイの予定がある方（曜日を問わず）、その日に来た方を出しています（訪問の記録が無い方は「記録なし」）。'}
          </p>
          {copyNotice === 'error' ? (
            msgBox({ tone: 'warn', text: '計画書の期限の写しを読み込めませんでした。計画がある方と、終了した方を確かめられません。' })
          ) : copyNotice === 'empty' && scope.ids === null ? (
            msgBox({ tone: 'info', text: '計画書の写しが無く、週間計画でも絞れないため、訪問の記録が無い方は、その日に来た方だけを出しています。' })
          ) : null}
          <button type="button" aria-expanded={open} aria-controls="home-visit-list" onClick={toggle} className={btn}>
            {open ? '一覧を閉じる' : `一覧を開く（${rows.length}人）`}
          </button>
          {open ? (
            rows.length === 0 ? (
              <p id="home-visit-list" className="text-base text-ink2">
                期限の一覧に出る方はいません。
              </p>
            ) : (
              <ul id="home-visit-list" className="divide-y divide-border">
                {rows.map((r) => (
                  <li key={r.residentId} className="flex flex-wrap items-center justify-between gap-gap py-2">
                    <div className="min-w-0">
                      <p className="text-lg font-bold text-ink">{nameOf(r.residentId)}</p>
                      <p className="text-base text-ink">
                        <span className={stateCls(r)}>{stateText(r)}</span>
                        {r.visit !== null ? `　次の期限 ${fmtDayLabel(r.due)}・前回 ${md(r.visit.visited_on)}` : hasPlan(r.residentId) ? '　計画書の写しに計画があります' : ''}
                      </p>
                      {pendingAddsOf(r.residentId).length > 0 ? (
                        <p className="text-sm text-ink">
                          <span aria-hidden="true">ⓘ </span>
                          送信待ちの訪問 {pendingAddsOf(r.residentId).map((p) => md(p.visitedOn)).join('・')}
                          {pendingAddsOf(r.residentId).some((p) => p.stopped) ? '（止まっています）' : '（電波が戻ると送ります）'}
                        </p>
                      ) : null}
                      {r.noExplanation ? (
                        <p className="text-sm text-warn">
                          <span aria-hidden="true">▲ </span>前回の訪問に説明の記録（相手と日）がありません
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-gap">
                      {r.visit !== null ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            const v = ready?.visits.find((x) => x.id === r.visit?.id)
                            if (v !== undefined) openRow(v)
                          }}
                          className={btn}
                          aria-label={`${nameOf(r.residentId)}さんの前回の居宅訪問の記録を開く`}
                        >
                          前回の記録を開く
                        </button>
                      ) : null}
                      <button type="button" disabled={busy || !writable} onClick={() => openNew(r.residentId)} className={btn} aria-label={`${nameOf(r.residentId)}さんの居宅訪問を記録する`}>
                        訪問を記録
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </>
      )}
      {pending.length > 0 ? msgBox(stopped ? { tone: 'warn', text: MSG_STOPPED } : { tone: 'info', text: `送信待ちの居宅訪問の記録が ${pending.length}件あります（電波が戻ると自動で送信します）。` }) : null}
      {msg !== null ? msgBox(msg) : null}

      <ModalShell open={ed !== null} label={ed?.row === null ? '居宅訪問を記録する' : '居宅訪問の記録'} onClose={() => setEditor(null)}>
        {ed !== null ? (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              <h2 className="text-lg font-bold text-ink">{ed.rid === null ? '居宅訪問を記録する' : `${nameOf(ed.rid)}さんの居宅訪問`}</h2>
              {ed.note !== undefined ? msgBox({ tone: 'warn', text: ed.note }) : null}
              <fieldset disabled={!writable || busy} className="min-w-0 space-y-3">
                {ed.row === null ? (
                  <label className="block text-sm text-ink2">
                    訪問した方
                    <select
                      value={ed.rid === null ? '' : String(ed.rid)}
                      onChange={(e) => pickPerson(e.target.value === '' ? null : Number(e.target.value))}
                      aria-invalid={ed.showErr === true && ed.rid === null}
                      aria-describedby={ed.showErr === true && ed.rid === null ? 'hv-who-err' : undefined}
                      className="mt-1 block min-h-tap w-full max-w-full rounded border border-border-strong bg-surface px-2 text-lg text-ink"
                    >
                      <option value="">選んでください</option>
                      {todayPeople.length > 0 ? (
                        <optgroup label="この日に来た方">
                          {todayPeople.map((r) => (
                            <option key={r.id} value={String(r.id)}>
                              {r.name}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      <optgroup label={todayPeople.length > 0 ? 'ほかの方' : '在籍の方'}>
                        {others.map((r) => (
                          <option key={r.id} value={String(r.id)}>
                            {r.name}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    {ed.showErr === true && ed.rid === null ? (
                      <span id="hv-who-err" className="mt-1 block text-sm text-danger">
                        訪問した方を選んでください。
                      </span>
                    ) : null}
                  </label>
                ) : null}
                {prev !== null ? (
                  <p className="text-sm text-ink2">
                    前回の訪問: {fmtDayLabel(prev.visited_on)}（{HOME_VISIT_PURPOSE_LABEL[prev.purpose]}）
                  </p>
                ) : null}
                <div className="flex flex-wrap items-end gap-gap">
                  <label className="min-w-0 max-w-full text-sm text-ink2">
                    訪問日
                    <input
                      type="date"
                      value={ed.input.visited_on}
                      max={today}
                      onChange={(e) => setInput({ visited_on: e.target.value })}
                      {...errProps('visited_on', 'hv-day-err')}
                      className="mt-1 block min-h-tap w-full max-w-full rounded border border-border-strong bg-surface px-2 text-lg text-ink"
                    />
                    {errLine('hv-day-err', edErr.visited_on)}
                  </label>
                  <label className="min-w-0 max-w-full text-sm text-ink2">
                    訪問した職員
                    <select
                      value={ed.input.visitor_id === null ? '' : String(ed.input.visitor_id)}
                      onChange={(e) => setInput({ visitor_id: e.target.value === '' ? null : Number(e.target.value) })}
                      {...errProps('visitor_id', 'hv-visitor-err')}
                      className="mt-1 block min-h-tap w-full max-w-full rounded border border-border-strong bg-surface px-2 text-lg text-ink"
                    >
                      <option value="">選んでください</option>
                      {staffList.map((s) => (
                        <option key={s.id} value={String(s.id)}>
                          {s.name}
                        </option>
                      ))}
                      {/* 在籍でなくなった職員が訪問した記録も、空に見せずに氏名で出す（反証 軽8） */}
                      {ed.input.visitor_id !== null && !staffList.some((s) => s.id === ed.input.visitor_id) ? (
                        <option value={String(ed.input.visitor_id)}>
                          {staffNameOf(ed.input.visitor_id)}
                          {/* 名簿を読めていない時は在籍かどうか分からないので言い切らない（確認の反証 軽3） */}
                          {staff !== null && staff !== undefined ? '（在籍でない）' : ''}
                        </option>
                      ) : null}
                    </select>
                    {errLine('hv-visitor-err', edErr.visitor_id)}
                  </label>
                </div>
                <div className="space-y-1">
                  <div className="flex flex-wrap gap-gap" role="group" aria-label="目的" aria-describedby={ed.showErr === true && edErr.purpose !== undefined ? 'hv-purpose-err' : undefined}>
                    {HOME_VISIT_PURPOSES.map((p) => (
                      <button key={p} type="button" aria-pressed={ed.input.purpose === p} onClick={() => setInput({ purpose: p })} className={chipCls(ed.input.purpose === p)}>
                        {ed.input.purpose === p ? <span aria-hidden="true">✓ </span> : null}
                        {HOME_VISIT_PURPOSE_LABEL[p]}
                      </button>
                    ))}
                  </div>
                  {errLine('hv-purpose-err', edErr.purpose)}
                </div>
                <label className="block text-sm text-ink2">
                  確かめた生活の状況（{HOME_VISIT_TEXT_MAX}字まで）
                  <textarea
                    value={ed.input.life_status}
                    rows={4}
                    maxLength={HOME_VISIT_TEXT_MAX * 2}
                    onChange={(e) => setInput({ life_status: e.target.value })}
                    {...errProps('life_status', 'hv-life-err')}
                    className="mt-1 block w-full rounded border border-border-strong bg-surface p-2 text-lg text-ink"
                  />
                  {errLine('hv-life-err', edErr.life_status)}
                </label>
                <div className="space-y-2 rounded border border-border p-2">
                  <p className="text-base font-bold text-ink">説明（後日に足せます）</p>
                  <div className="flex flex-wrap gap-gap" role="group" aria-label="説明した相手">
                    {EXPLAINED_TOS.map((t) => (
                      <button
                        key={t}
                        type="button"
                        aria-pressed={ed.input.explained_to === t}
                        onClick={() => setInput({ explained_to: ed.input.explained_to === t ? null : t })}
                        className={chipCls(ed.input.explained_to === t)}
                      >
                        {ed.input.explained_to === t ? <span aria-hidden="true">✓ </span> : null}
                        {EXPLAINED_TO_LABEL[t]}
                      </button>
                    ))}
                  </div>
                  <label className="block text-sm text-ink2">
                    説明した日
                    <input
                      type="date"
                      value={ed.input.explained_on}
                      max={today}
                      onChange={(e) => setInput({ explained_on: e.target.value })}
                      {...errProps('explained_on', 'hv-exday-err')}
                      className="mt-1 block min-h-tap w-full max-w-full rounded border border-border-strong bg-surface px-2 text-lg text-ink"
                    />
                    {errLine('hv-exday-err', edErr.explained_on)}
                  </label>
                  {explanationHalf(ed.input) ? (
                    <p role="status" className="text-sm text-warn">
                      <span aria-hidden="true">▲ </span>
                      {MSG_HALF}
                    </p>
                  ) : null}
                  <label className="block text-sm text-ink2">
                    説明の内容（任意・{HOME_VISIT_TEXT_MAX}字まで）
                    <textarea
                      value={ed.input.explanation}
                      rows={3}
                      maxLength={HOME_VISIT_TEXT_MAX * 2}
                      onChange={(e) => setInput({ explanation: e.target.value })}
                      {...errProps('explanation', 'hv-exp-err')}
                      className="mt-1 block w-full rounded border border-border-strong bg-surface p-2 text-lg text-ink"
                    />
                    {errLine('hv-exp-err', edErr.explanation)}
                  </label>
                </div>
                <label className="flex min-h-tap items-center gap-2 text-base text-ink">
                  <input
                    type="checkbox"
                    checked={ed.input.plan_revised}
                    onChange={(e) => setInput({ plan_revised: e.target.checked })}
                    className="h-6 w-6"
                  />
                  この訪問で計画を見直した
                </label>
              </fieldset>
            </div>
            <div className="flex flex-wrap justify-between gap-gap border-t border-border p-4">
              {ed.row !== null ? (
                <button
                  type="button"
                  disabled={!writable || busy}
                  onClick={() => {
                    const row = ed.row
                    setEditor(null)
                    if (row !== null) setDel(row)
                  }}
                  className="min-h-tap rounded border border-danger px-4 text-base font-bold text-danger disabled:border-border disabled:text-ink3"
                >
                  <span aria-hidden="true">▲ </span>記録を取り消す
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-gap">
                <button type="button" onClick={() => setEditor(null)} className={btn}>
                  閉じる
                </button>
                <button type="button" disabled={!writable || busy} onClick={() => void save()} className={primaryBtn}>
                  {ed.row === null ? '記録する' : '直す'}
                </button>
              </div>
            </div>
          </>
        ) : null}
      </ModalShell>
      <ConfirmDialog
        open={del !== null}
        title="居宅訪問の記録を取り消しますか"
        body={del === null ? '' : `${nameOf(del.resident_id)}さんの ${fmtDayLabel(del.visited_on)} の居宅訪問の記録を取り消します。変更の記録には残ります。`}
        confirmLabel="取り消す"
        danger
        onConfirm={() => void removeVisit()}
        onCancel={() => setDel(null)}
      />
      {toast}
    </section>
  )
}
