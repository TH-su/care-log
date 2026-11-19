// 日報の確認欄（その日の日報を読んだ ✔）と未読者欄（2026-11-19 本人指示・0065）。
// どちらも画面だけ（print:hidden）＝紙の日報は1pxも変えない（dev-principles 原則2）。
//   UnreadSummaryBanner … 日報のページの上に1つ（2026-11-19 代表者の指示で、日ごとの見出しの下の欄から移した）。
//     昨日までの日報の未読者の人数。押すと氏名と未読の日（押すとその日の確認欄へ）
//   ReadCheckPanel  … 1日の枠の末尾。職員全員の名前の ✔ ボタン（1人1日1回）
// ✔ は「記録する職員（操作者）」として付ける（既読と同じ・ui-design.md §0 の誤帰属の防止）。
// 自分以外の名前を押した時は、その人に記録する職員を切り替えてから付ける（確認の窓で知らせる）。
// 判定の決まりは lib/readCheck.ts。

import { useState } from 'react'
import { ConfirmDialog } from './ui'
import { setActorId } from '../lib/actor'
import type { ReadCheckView, UnreadSummary } from '../lib/readCheck'
import type { ReadChecksState, UnreadSource } from '../hooks/useReadChecks'

const WEEK = ['日', '月', '火', '水', '木', '金', '土']
/** 'YYYY-MM-DD' → 'M/D(曜)' */
function fmtDay(iso: string): string {
  const [y, m, d] = iso.split('-').map((x) => parseInt(x, 10))
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return `${m}/${d}(${WEEK[w]})`
}

/**
 * 未読者欄（日報のページの上に1つ・2026-11-19 代表者の指示）。
 * 押すまで氏名を出さない（閉じている間は人数だけ＝氏名は画面にも読み上げにも出さない）。開くと、人ごとに未読の日を並べ、
 * 日を押すとその日の日報の確認欄へ飛ぶ。今日の分は数えない（昨日まで）。数え方は lib/readCheck.ts の buildUnreadSummary。
 */
export function UnreadSummaryBanner({
  summary,
  source,
  onPickDay,
}: {
  summary: UnreadSummary | null
  source: UnreadSource
  onPickDay: (day: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (!source.ready || source.missing) return null
  const box = 'print:hidden flex flex-wrap items-center gap-x-2 border px-2 py-1 text-sm'
  if (source.failed) {
    return (
      <div className={`${box} border-border text-ink2`} role="status">
        <span className="font-bold">未読者</span>
        <span>判定できません（勤務表か確認欄を読めませんでした。〔最新に更新〕で読み直してください）</span>
      </div>
    )
  }
  if (summary === null || summary.window.length === 0) return null
  const n = summary.people.length
  const und = summary.undeterminedDays.length
  const undNote = (
    <>
      {und > 0 && <span className="text-ink2">・判定できない日 {und}日（勤務表が無い・読めない記号）</span>}
      {summary.unmatched > 0 && <span className="text-ink2">・勤務表で名前が見つからない職員 {summary.unmatched}名（数えていません）</span>}
    </>
  )
  if (n === 0) {
    return (
      <div className={`${box} ${und > 0 ? 'border-border text-ink2' : 'border-ok bg-ok-bg text-ok'}`} role="status">
        <span className="font-bold">{und > 0 ? '未読者' : '✓ 未読者なし'}</span>
        <span className="text-ink2">（昨日までの日報・今日の分は明日から数えます）</span>
        {undNote}
      </div>
    )
  }
  return (
    <div className="print:hidden border-2 border-danger bg-danger-bg px-2 py-1.5 text-danger" data-readcheck-unread={n}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          className="min-h-tap rounded-sm bg-danger px-3 text-base font-bold text-surface"
          aria-expanded={open}
          aria-controls="unread-summary-list"
          onClick={() => setOpen((v) => !v)}
        >
          ⚠ 未読者 {n}名 {open ? '▲ 閉じる' : '▼ 押すと氏名を表示'}
        </button>
        <span className="text-sm text-ink2">昨日までの日報（日勤は前日の分・夜勤はその日の日中の分から）</span>
        {undNote}
      </div>
      {open && (
        <ul id="unread-summary-list" className="mt-1 space-y-1" role="list">
          {summary.people.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-[6rem] font-bold">{p.name}</span>
              {p.days.map((d) => (
                <button
                  key={d}
                  type="button"
                  className="min-h-tap rounded-sm border border-danger bg-surface px-2 text-sm font-bold text-danger underline"
                  aria-label={`${p.name}さんの未読 ${fmtDay(d)} の日報の確認欄へ`}
                  onClick={() => onPickDay(d)}
                >
                  {fmtDay(d)}
                </button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type Pending =
  | { kind: 'other'; id: number; name: string }
  | { kind: 'cancel'; id: number; name: string }

/** 確認欄（1日の枠の末尾） */
export function ReadCheckPanel({
  day,
  view,
  state,
  actorId,
  unreadIds,
}: {
  day: string
  view: ReadCheckView
  state: ReadChecksState
  actorId: number | null
  /** この日の未読の人（未読者欄と同じ数え方・今日と14日より前の日は空） */
  unreadIds: ReadonlySet<number>
}) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  if (view.source === 'future' || view.source === 'before') return null

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

  const onPress = (m: ReadCheckView['members'][number]) => {
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

  const checkedN = view.members.filter((m) => m.checked).length
  return (
    <section
      id={`readcheck-${day}`}
      className="print:hidden mt-3 border-2 border-border-strong bg-surface"
      aria-label="確認欄（この日の日報を読んだら自分の名前を押す）"
    >
      <div className="flex flex-wrap items-center gap-x-2 border-b border-border-strong bg-surface2 px-2 py-1 font-bold text-ink">
        <span>確認欄</span>
        <span className="text-sm font-normal text-ink2">
          この日の日報を読んだら、自分の名前を押して ✔ を付けてください（1日1回）。✔ {checkedN}／{view.members.length}名
        </span>
      </div>
      {state.missing && <p className="px-2 py-1 text-sm text-warn">確認欄はまだ使えません（サーバー側の設定待ち）。</p>}
      {state.loadFailed && !state.missing && (
        <p className="px-2 py-1 text-sm text-warn">確認欄を読み込めませんでした。〔最新に更新〕で読み直してください。</p>
      )}
      <ul className="flex flex-wrap gap-2 p-2" role="list">
        {view.members.map((m) => {
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
      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'cancel' ? `${pending.name}さんの確認を取り消しますか？` : `${pending?.name ?? ''}さんとして確認を付けますか？`}
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
