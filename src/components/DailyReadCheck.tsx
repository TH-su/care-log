// 日報の確認欄（その日の日報を読んだ ✔）と未読者欄（2026-11-19 本人指示・0065）。
// どちらも画面だけ（print:hidden）＝紙の日報は1pxも変えない（dev-principles 原則2）。
//   ReadCheckBanner … 日付の見出しのすぐ下。未読者がいれば赤系の地・太字で「未読者 n名：氏名…」、いなければ落ち着いた色で「未読者なし」
//   ReadCheckPanel  … 1日の枠の末尾。職員全員の名前の ✔ ボタン（1人1日1回）
// ✔ は「記録する職員（操作者）」として付ける（既読と同じ・ui-design.md §0 の誤帰属の防止）。
// 自分以外の名前を押した時は、その人に記録する職員を切り替えてから付ける（確認の窓で知らせる）。
// 判定の決まりは lib/readCheck.ts。

import { useState } from 'react'
import { ConfirmDialog } from './ui'
import { setActorId } from '../lib/actor'
import type { ReadCheckView } from '../lib/readCheck'
import type { ReadChecksState } from '../hooks/useReadChecks'

const WHY_ATTENDANCE = '勤務表が読めないため、出勤者の欄で判定しています'

/** 未読者欄（日付の見出しの下） */
export function ReadCheckBanner({ day, view, state }: { day: string; view: ReadCheckView; state: ReadChecksState }) {
  if (view.source === 'future' || !state.loaded || state.missing || state.loadFailed) return null
  const jump = () => {
    const el = typeof document !== 'undefined' ? document.getElementById(`readcheck-${day}`) : null
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  if (view.source === 'none') {
    return (
      <div className="print:hidden flex flex-wrap items-center gap-x-2 border-b border-border px-2 py-1 text-sm text-ink2" role="status">
        <span className="font-bold">未読者</span>
        <span>判定できません（勤務表が読めず、出勤者の欄も空です）</span>
      </div>
    )
  }
  const n = view.unread.length
  if (n === 0) {
    return (
      <div className="print:hidden flex flex-wrap items-center gap-x-2 border-b border-border bg-ok-bg px-2 py-1 text-sm text-ok" role="status">
        <span className="font-bold">✓ 未読者なし</span>
        {view.source === 'attendance' && <span className="text-ink2">（{WHY_ATTENDANCE}）</span>}
        {view.undetermined.length > 0 && <span className="text-ink2">・判定できない {view.undetermined.length}名</span>}
      </div>
    )
  }
  return (
    <div
      className="print:hidden flex flex-wrap items-center gap-x-3 gap-y-1 border-2 border-danger bg-danger-bg px-2 py-1.5 text-base text-danger"
      role="alert"
      data-readcheck-unread={n}
    >
      <span className="rounded-sm bg-danger px-2 py-0.5 font-bold text-surface">⚠ 未読者 {n}名</span>
      <span className="font-bold">{view.unread.map((u) => u.name).join('、')}</span>
      {view.source === 'attendance' && <span className="text-sm text-ink2">（{WHY_ATTENDANCE}）</span>}
      {view.undetermined.length > 0 && <span className="text-sm text-ink2">・判定できない {view.undetermined.length}名</span>}
      <button type="button" className="ml-auto min-h-tap rounded-sm border border-danger px-3 text-sm font-bold text-danger" onClick={jump}>
        確認欄へ
      </button>
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
}: {
  day: string
  view: ReadCheckView
  state: ReadChecksState
  actorId: number | null
}) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  if (view.source === 'future') return null

  const unreadIds = new Set(view.unread.map((u) => u.id))
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
          const unread = unreadIds.has(m.id)
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
