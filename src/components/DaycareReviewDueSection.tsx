// デイ（せせらぎ）段階3c: 機能訓練の画面の「計画の見直しの期限」の区画と〔計画書の期限を写す〕（2026-10-23・代表承認・段階3の計画 2.1・4章）。
//
// ・期限は計画書アプリの索引から写した写し（daycare_training_due）から出す。状態は保存せず、表示の時に
//   「終了 → 計画なし → 期限の状態」の順で出す（trainingDue.ts の reviewDueList）
// ・写した日時を必ず出す（古さを隠さない）。写しが今日のものでなければ、事務所の PC で写すよう知らせる
// ・数（期限切れ・間近・計画なし）を先に出し、一覧は〔一覧を開く〕で出す。開いているかだけを端末に残す（LS.dcTrainingReviewOpen）
// ・〔計画書の期限を写す〕は、事務所・管理者のログインで、この端末に計画書アプリの接続設定がある時だけ出す。
//   現場のログインでは接続設定を読まない（役割を先に見る）。押した時だけ写す（開いた時には書かない）
// ・写しを読めない時は「計画書の期限を確かめられません」と出し、「計画なし」「期限内」に倒さない

import { useState } from 'react'
import { DbError, canWriteMasters } from '../lib/db'
import type { MyRole } from '../lib/db'
import { REVIEW_STATE_LABEL, filterReviewScope, normalizeDueRule, normalizeWarnDays, reviewCopyState, reviewDueCounts, reviewDueList } from '../lib/trainingDue'
import type { DueCopyLoad, ReviewDueRow } from '../lib/trainingDue'
import { readTrainingPlanConfig, trainingDueSyncText } from '../lib/trainingPlanClient'
import { syncTrainingPlanDue } from '../lib/trainingDueSync'
import { fmtDayLabel, isoDate } from '../lib/format'
import { LS } from '../lib/types'
import type { Resident } from '../lib/types'

type Msg = { tone: 'info' | 'warn' | 'danger'; text: string }
const RULE_TEXT: Record<'calendar' | 'days90' | 'min', string> = {
  calendar: '暦の月で3か月（応当日が無い月は月末）',
  days90: '90日',
  min: '暦の月で3か月と90日の早い方',
}

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(LS.dcTrainingReviewOpen) === '1'
  } catch {
    return false
  }
}
function writeOpen(v: boolean): void {
  try {
    window.localStorage.setItem(LS.dcTrainingReviewOpen, v ? '1' : '0')
  } catch {
    // 保存できなくても操作は続ける
  }
}

const md = (ymd: string) => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd)
  return m ? `${Number(m[1])}/${Number(m[2])}` : ''
}

export interface DaycareReviewDueSectionProps {
  /** 日本時間の今日 */
  today: string
  residents: Resident[]
  /** 写し（null＝読み込み中・'missing'＝表が無い・'error'＝読めない） */
  copy: DueCopyLoad | 'missing' | null
  role: MyRole | null
  actorId: number | null
  /** 書けない理由（旗が閉じている・記録者が無い など）。null＝書ける */
  blockedReason: string | null
  /** 写した後（画面を読み直す） */
  onSynced: () => void
  /**
   * 一覧に出す方を絞る、その日にデイの予定がある方（盤の予定がある方・外部利用者は入らない）。null＝その日の予定を読めない（絞らない）。
   * 計画書に計画がある方は、予定が無くても出す（代表者の決定 2026-10-23・積み残し 51）
   */
  scopeIds: ReadonlySet<number> | null
  /** 絞りに使った予定の日（画面の日） */
  scopeDay: string
}

export function DaycareReviewDueSection({ today, residents, copy, role, actorId, blockedReason, onSynced, scopeIds, scopeDay }: DaycareReviewDueSectionProps) {
  const [open, setOpen] = useState<boolean>(readOpen)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)

  const nameOf = (id: number) => residents.find((r) => r.id === id)?.name ?? `利用者ID ${id}`
  const toggle = () =>
    setOpen((v) => {
      writeOpen(!v)
      return !v
    })
  // 〔写す〕は事務所・管理者で、この端末に計画書アプリの接続設定がある時だけ（役割を先に見る＝現場では接続設定を読まない）
  const canCopy = canWriteMasters(role) && readTrainingPlanConfig() !== null

  const loaded = copy !== null && copy !== 'missing' && copy !== 'error' ? copy : null
  const rows: ReviewDueRow[] =
    loaded === null
      ? []
      : filterReviewScope(
          reviewDueList({ copy: loaded.rows, settings: loaded.settings, people: residents.map((r) => ({ id: r.id, active: r.active })), today }),
          scopeIds,
        )
  const counts = reviewDueCounts(rows)
  const cstate = loaded === null ? null : reviewCopyState(loaded)
  const syncedAt = loaded?.settings?.synced_at ?? null
  const syncedDay = syncedAt === null || Number.isNaN(new Date(syncedAt).getTime()) ? null : isoDate(new Date(syncedAt))
  const rule = normalizeDueRule(loaded?.settings?.due_rule)
  const warn = normalizeWarnDays(loaded?.settings?.warn_days)

  const btn = 'min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:text-ink3'
  const primaryBtn =
    'min-h-tap rounded border-2 border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border-strong disabled:bg-surface disabled:text-ink3'
  const msgBox = (m: Msg) => (
    <p role="status" className={`rounded border p-2 text-base text-ink ${m.tone === 'info' ? 'border-primary bg-surface' : m.tone === 'warn' ? 'border-warn bg-warn-bg' : 'border-danger bg-danger-bg'}`}>
      <span aria-hidden="true">{m.tone === 'info' ? 'ⓘ ' : '▲ '}</span>
      {m.text}
    </p>
  )

  const doSync = async () => {
    setMsg(null)
    if (blockedReason !== null) {
      setMsg({ tone: 'warn', text: blockedReason })
      return
    }
    setBusy(true)
    try {
      const r = await syncTrainingPlanDue(actorId)
      if (r.kind === 'role') setMsg({ tone: 'warn', text: '計画書の期限の写しは、事務所のログインでだけ行えます。' })
      else if (r.kind === 'fail') setMsg({ tone: 'warn', text: r.text })
      else setMsg(trainingDueSyncText(r.result))
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof DbError ? e.message : '写せませんでした。通信状態を確かめて、もう一度押してください。' })
    } finally {
      setBusy(false)
      onSynced()
    }
  }

  const stateCls = (r: ReviewDueRow) =>
    r.state === 'overdue' ? 'font-bold text-danger' : r.state === 'warn' ? 'font-bold text-warn' : r.state === 'none' ? 'text-ink' : 'text-ink2'

  return (
    <section aria-labelledby="h-review-due" className="space-y-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <h2 id="h-review-due" className="text-xl font-bold text-ink">
          計画の見直しの期限
        </h2>
        {canCopy ? (
          <button type="button" disabled={busy || copy === 'missing'} onClick={() => void doSync()} className={primaryBtn}>
            {busy ? '写しています…' : '計画書の期限を写す'}
          </button>
        ) : null}
      </div>
      {copy === null ? (
        <p className="text-base text-ink2">読み込んでいます…</p>
      ) : copy === 'missing' ? (
        msgBox({ tone: 'warn', text: 'デイの機能訓練の記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。' })
      ) : copy === 'error' ? (
        <p role="alert" className="rounded border border-danger bg-danger-bg p-2 text-base text-ink">
          <span aria-hidden="true">▲ </span>計画書の期限を確かめられません（写しを読み込めませんでした）。通信状態を確かめて、〔最新に更新〕を押してください。
        </p>
      ) : cstate === 'never' ? (
        msgBox({
          tone: 'info',
          text: canCopy
            ? '計画書の期限はまだ写されていません。〔計画書の期限を写す〕を押してください。'
            : '計画書の期限はまだ写されていません。計画書アプリを使っている事務所の PC で〔計画書の期限を写す〕を押してください。',
        })
      ) : cstate === 'empty' ? (
        // 写したのに1人も載っていない（0/0/0 を出すと「期限切れなし」と読めるので出さない＝段階3c の反証 中1）
        msgBox({
          tone: 'warn',
          text: `計画書の写しに1人も載っていません${syncedDay === null ? '' : `（${fmtDayLabel(syncedDay)} に写したもの）`}。計画の見直しの期限は確かめられません。利用者番号が結べていない可能性があります。管理者に連絡してください。`,
        })
      ) : (
        <>
          <p className={`text-base ${syncedDay !== today ? 'text-ink' : 'text-ink2'}`}>
            {syncedDay === null ? '計画書の期限を写した日は分かりません。' : `計画書の期限は ${fmtDayLabel(syncedDay)} に写したものです。`}
            {syncedDay !== today ? (canCopy ? '今日の分ではありません。〔計画書の期限を写す〕を押してください。' : '今日の分ではありません。事務所の PC で写してください。') : ''}
          </p>
          <ul className="flex flex-wrap gap-gap" aria-label={`今日（${fmtDayLabel(today)}）の時点の数`}>
            <li className={`rounded border px-3 py-1 text-base ${counts.overdue > 0 ? 'border-danger bg-danger-bg font-bold text-ink' : 'border-border text-ink'}`}>
              <span aria-hidden="true">▲ </span>期限切れ {counts.overdue}人
            </li>
            <li className={`rounded border px-3 py-1 text-base ${counts.warn > 0 ? 'border-warn bg-warn-bg font-bold text-ink' : 'border-border text-ink'}`}>
              <span aria-hidden="true">△ </span>間近 {counts.warn}人
            </li>
            <li className="rounded border border-border px-3 py-1 text-base text-ink">計画なし {counts.none}人</li>
          </ul>
          <p className="text-sm text-ink2">
            期限は計画書アプリが計算した値をそのまま使い、期限の{warn}日前から「間近」と出します（計画書の設定: {RULE_TEXT[rule]}）。
            {scopeIds === null
              ? `${fmtDayLabel(scopeDay)}の予定を読めないため、計画のない方も含めて写しの全員を出しています。`
              : `計画書に計画がある方と、${fmtDayLabel(scopeDay)}にデイの予定がある方を出しています。`}
          </p>
          <button type="button" aria-expanded={open} aria-controls="review-due-list" onClick={toggle} className={btn}>
            {open ? '一覧を閉じる' : `一覧を開く（${rows.length}人）`}
          </button>
          {open ? (
            rows.length === 0 ? (
              <p id="review-due-list" className="text-base text-ink2">
                期限の一覧に出る方はいません。
              </p>
            ) : (
              <ul id="review-due-list" className="divide-y divide-border">
                {rows.map((r) => (
                  <li key={r.residentId} className="py-2">
                    <p className="text-lg font-bold text-ink">{nameOf(r.residentId)}</p>
                    <p className="text-base text-ink">
                      <span className={stateCls(r)}>{REVIEW_STATE_LABEL[r.state]}</span>
                      {r.planDate !== null ? `　次の期限 ${fmtDayLabel(r.due)}・作成 ${md(r.planDate)}` : '　計画書アプリに計画がありません'}
                    </p>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </>
      )}
      {msg !== null ? msgBox(msg) : null}
    </section>
  )
}
