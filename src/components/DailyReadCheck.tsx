// 日報の確認欄（その日の日報を読んだ ✔）と未読者（2026-11-19 本人指示・0065・0066）。
// どちらも画面だけ（print:hidden）＝紙の日報は1pxも変えない（dev-principles 原則2）。
//   ReadCheckPanel … 1日の枠の末尾（夜勤申し送りの下・夜勤の枠より左右に細い）。その日報を読む人だけの名前の ✔ ボタン
//     （夜勤入りの人は当日の日報から・日勤の人は前日までの日報。決まりは lib/readCheck.ts の buildCheckPanel）。
//     下に〔未読者〕ボタン。押すまで氏名を出さず、押すと昨日までの未読の人と、その右に未読の日付。日付を押すとその日の申送へ飛ぶ
//     （2026-11-19 代表者の指示で、ページの上の未読者欄から確認欄の下へ移した）。
// ✔ は「記録する職員（操作者）」として付ける（既読と同じ・ui-design.md §0 の誤帰属の防止）。
// 自分以外の名前を押した時は、その人に記録する職員を切り替えてから付ける（確認の窓で知らせる）。

import { useState } from 'react'
import { ConfirmDialog } from './ui'
import { setActorId } from '../lib/actor'
import type { CheckPanel, CheckPanelMember, UnreadSummary, UnreadWho } from '../lib/readCheck'
import type { ReadChecksState, UnreadSource } from '../hooks/useReadChecks'

const WEEK = ['日', '月', '火', '水', '木', '金', '土']
/** 'YYYY-MM-DD' → 'M/D(曜)' */
function fmtDay(iso: string): string {
  const [y, m, d] = iso.split('-').map((x) => parseInt(x, 10))
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return `${m}/${d}(${WEEK[w]})`
}

/**
 * 確認欄の下の〔未読者〕（2026-11-19 代表者の指示）。押すまで氏名を出さない（閉じている間は人数だけ＝氏名は画面にも読み上げにも出さない）。
 * 開くと、昨日までの日報に ✔ を付けていない人と、その右に未読の日付。日付を押すとその日の申送の頭へ飛ぶ（すぐ読めるように）。
 * 名前が出るのは、その日報を読む番が来てから（夜勤入り・休み明けの出勤の日の出勤の時刻より後）。数え方は lib/readCheck.ts の buildUnreadSummary。
 */
function UnreadButton({
  summary,
  source,
  onPickDay,
}: {
  summary: UnreadSummary | null
  source: UnreadSource
  onPickDay: (day: string, who?: UnreadWho) => void
}) {
  const [open, setOpen] = useState(false)
  if (!source.ready || source.missing) return null
  const row = 'flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-2 py-2 text-sm'
  if (source.failed) {
    return (
      <div className={`${row} text-ink2`} role="status">
        <span className="font-bold">未読者</span>
        <span>判定できません（勤務表か確認欄を読めませんでした。〔最新に更新〕で読み直してください）</span>
      </div>
    )
  }
  if (summary === null || summary.window.length === 0) return null
  const n = summary.people.length
  const und = summary.undeterminedDays.length
  const notes = (
    <>
      {und > 0 && <span className="text-ink2">判定できない日 {und}日（勤務表が無い・読めない記号）</span>}
      {summary.unmatched > 0 && <span className="text-ink2">勤務表で名前が見つからない職員 {summary.unmatched}名（数えていません）</span>}
    </>
  )
  return (
    <div className={`${row} ${n > 0 ? 'bg-danger-bg text-danger' : 'text-ink2'}`} data-readcheck-unread={n}>
      <button
        type="button"
        className={`min-h-tap rounded-sm border-2 px-3 text-base font-bold ${n > 0 ? 'border-danger bg-danger text-surface' : 'border-border bg-surface text-ink2'}`}
        aria-expanded={open}
        disabled={n === 0}
        onClick={() => setOpen((v) => !v)}
      >
        {n > 0 ? `⚠ 未読者 ${n}名 ${open ? '▲' : '▼'}` : '未読者 0名'}
      </button>
      <span className="text-ink2">
        {n > 0 ? (open ? '日付を押すと、その日の申送へ移ります' : '押すと氏名と未読の日付が出ます') : '読む番が来た日報（出勤の30分前から）'}
      </span>
      {notes}
      {open && n > 0 && (
        <ul className="w-full space-y-1 pt-1" role="list">
          {summary.people.map((p) => (
            <li key={p.id} className="flex items-start gap-x-2">
              <span className="min-w-[6rem] shrink-0 pt-2 font-bold">{p.name}</span>
              {/* 日付は氏名の右側の中で折り返す（狭い画面でも氏名の下へ回さない） */}
              <span className="flex flex-1 flex-wrap gap-1">
                {p.days.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="min-h-tap rounded-sm border border-danger bg-surface px-2 text-sm font-bold text-danger underline"
                    aria-label={`${p.name}さんの未読 ${fmtDay(d)} の申送へ`}
                    onClick={() => onPickDay(d, { id: p.id, name: p.name })}
                  >
                    {fmtDay(d)}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 〔未読者〕が何かを出すか（UnreadButton が null を返す時は外枠も出さない） */
function unreadShown(summary: UnreadSummary | null, source: UnreadSource): boolean {
  if (!source.ready || source.missing) return false
  if (source.failed) return true
  return summary !== null && summary.window.length > 0
}

/**
 * 〔未読者〕だけの枠。この日の日報が読み込み中・読み込みに失敗した間も、ほかの日の未読へ移れるように出す
 * （2026-11-19 代表者の指示「未読者の表示を直す」。確認欄は日報を読み終えてから出す＝今のまま）
 */
export function UnreadOnlyPanel({
  summary,
  unreadSource,
  onPickDay,
}: {
  summary: UnreadSummary | null
  unreadSource: UnreadSource
  onPickDay: (day: string, who?: UnreadWho) => void
}) {
  if (!unreadShown(summary, unreadSource)) return null
  return (
    <section className="dsheet-readcheck print:hidden mt-3 border-2 border-border-strong bg-surface" aria-label="未読者">
      <UnreadButton summary={summary} source={unreadSource} onPickDay={onPickDay} />
    </section>
  )
}

type Pending =
  | { kind: 'other'; id: number; name: string }
  | { kind: 'cancel'; id: number; name: string }

/** 確認欄（1日の枠の末尾） */
export function ReadCheckPanel({
  day,
  panel,
  state,
  actorId,
  unreadIds,
  summary,
  unreadSource,
  onPickDay,
  showUnread,
}: {
  day: string
  panel: CheckPanel
  state: ReadChecksState
  actorId: number | null
  /** この日の未読の人（未読者と同じ数え方・今日と14日より前の日は空） */
  unreadIds: ReadonlySet<number>
  /** 昨日までの未読者（確認欄の下の〔未読者〕に出す） */
  summary: UnreadSummary | null
  unreadSource: UnreadSource
  /** 未読の日付を押した: その日の申送へ移る */
  onPickDay: (day: string, who?: UnreadWho) => void
  /** 〔未読者〕をこの確認欄の下に出すか（10日表示でも1つだけ＝表示中の日のうち今日に一番近い日） */
  showUnread: boolean
}) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // 確認欄を出さない日（始める前の日）でも、〔未読者〕の置き場の日なら〔未読者〕だけは出す（読み込み中と読み終えた後で見え方を変えない・反証レビュー medium）
  if (panel.source === 'future' || panel.source === 'before')
    return showUnread ? <UnreadOnlyPanel summary={summary} unreadSource={unreadSource} onPickDay={onPickDay} /> : null
  // 勤務表を読み終える前は並べない（読む前の仮の並びで押し間違えないように）
  const shiftReady = state.shiftLoaded

  // 赤い「未読」は未読者欄と同じ数え方（昨日まで・日勤は翌日の勤務・夜勤はその日の夜勤入り）。✔ はこの画面の最新で外す
  const disabled = !state.loaded || state.missing || state.loadFailed

  const doAdd = async (id: number) => {
    setMsg(null)
    try {
      await state.add(day, id, id)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '確認を付けられませんでした。もう一度押してください。')
    }
  }
  const doCancel = async (id: number) => {
    setMsg(null)
    try {
      await state.cancel(day, id, actorId)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '確認を取り消せませんでした。もう一度押してください。')
    }
  }

  const onPress = (m: CheckPanelMember) => {
    if (disabled) return
    if (state.busy.has(`${day}|${m.id}`)) return
    if (m.checked) {
      setPending({ kind: 'cancel', id: m.id, name: m.name })
      return
    }
    if (actorId === m.id) {
      void doAdd(m.id)
      return
    }
    setPending({ kind: 'other', id: m.id, name: m.name })
  }

  const members = shiftReady ? panel.members : []
  const checkedN = members.filter((m) => m.checked).length
  return (
    <section
      id={`readcheck-${day}`}
      className="dsheet-readcheck print:hidden mt-3 border-2 border-border-strong bg-surface"
      aria-label="確認欄（この日の日報を読んだら自分の名前を押す）"
    >
      <div className="flex flex-wrap items-center gap-x-2 border-b border-border-strong bg-surface2 px-2 py-1 font-bold text-ink">
        <span>確認欄</span>
        <span className="text-sm font-normal text-ink2">
          この日の日報を読んだら、自分の名前を押して ✔ を付けてください（1日1回）。✔ {checkedN}／{members.length}名
        </span>
      </div>
      {state.missing && <p className="px-2 py-1 text-sm text-warn">確認欄はまだ使えません（サーバー側の設定待ち）。</p>}
      {state.loadFailed && !state.missing && (
        <p className="px-2 py-1 text-sm text-warn">確認欄を読み込めませんでした。〔最新に更新〕で読み直してください。</p>
      )}
      {shiftReady && panel.source === 'fallback' && (
        <p className="px-2 pt-1 text-sm text-ink2">勤務表が読めないため、勤務表から取り込んだ職員を全員並べています（読む番の人だけには絞れていません）。</p>
      )}
      {shiftReady && panel.source === 'nonext' && (
        <p className="px-2 pt-1 text-sm text-ink2">翌日の勤務表がまだ無いため、この日に施設で勤務の人を並べています。</p>
      )}
      {shiftReady && panel.source === 'shift' && members.length === 0 && (
        <p className="px-2 pt-1 text-sm text-ink2">
          {panel.isToday
            ? '夜勤の人は入りの30分前から、日勤の人は明日の出勤の30分前から、ここに並びます。'
            : 'この日の日報を読む人は、出勤の30分前から並びます。'}
        </p>
      )}
      {shiftReady && panel.stale && (
        <p className="px-2 pt-1 text-sm text-ink2">14日より前の日のため、現場の端末からは ✔ を付けられません。</p>
      )}
      <ul className="flex flex-wrap gap-2 p-2" role="list">
        {members.map((m) => {
          const busy = state.busy.has(`${day}|${m.id}`)
          const unread = !m.checked && unreadIds.has(m.id)
          const tone = m.checked
            ? 'border-ok bg-ok-bg text-ok'
            : unread
              ? 'border-danger bg-danger-bg text-danger'
              : 'border-border bg-surface text-ink'
          return (
            <li key={m.id}>
              <button
                type="button"
                className={`min-h-tap min-w-[7rem] rounded-sm border-2 px-3 text-base ${tone} ${m.checked || unread ? 'font-bold' : ''} disabled:opacity-60`}
                aria-pressed={m.checked}
                aria-label={`${m.name}${m.checked ? '（確認済み・押すと取り消し）' : unread ? '（未読・押すと確認）' : '（押すと確認）'}`}
                disabled={disabled || busy}
                onClick={() => onPress(m)}
              >
                <span aria-hidden="true" className="mr-1 inline-block w-4">
                  {m.checked ? '✔' : '□'}
                </span>
                {m.name}
                {m.why === 'night' && <span className="ml-1 text-xs text-ink2">夜勤</span>}
                {unread && <span className="ml-1 text-xs">未読</span>}
              </button>
            </li>
          )
        })}
      </ul>
      {msg && (
        <p className="px-2 pb-2 text-sm text-danger" role="alert">
          ▲ {msg}
        </p>
      )}
      {showUnread && <UnreadButton summary={summary} source={unreadSource} onPickDay={onPickDay} />}
      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.kind === 'cancel' ? `${pending.name}さんの確認を取り消しますか？` : `${pending?.name ?? ''}さんとして確認を付けますか？`
        }
        body={
          pending?.kind === 'cancel'
            ? 'この日の ✔ が外れます。取り消した後に、もう一度付けることもできます。'
            : '記録する職員も、この人に切り替わります（このあとの記録・既読はこの人の名前で付きます）。'
        }
        confirmLabel={pending?.kind === 'cancel' ? '取り消す' : '確認を付ける'}
        danger={pending?.kind === 'cancel'}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const p = pending
          setPending(null)
          if (!p) return
          if (p.kind === 'cancel') void doCancel(p.id)
          else {
            setActorId(p.id)
            void doAdd(p.id)
          }
        }}
      />
    </section>
  )
}
