// 送れていない申し送りの一覧（2026-09-29・申し送りを消さない作り替え 段B-4・精査 H1・L2）。
// 日報（その日の上部）と設定画面に出す。送信待ち・止まった変更（cl_sendQueue2 の notes#<id>）と、
// 登録を待っている・拒否で止まった新規登録（cl_sendQueue の notes の insert。旧ビルドが積んだ分も含む）を本文つきで並べ、
// 各件〔くらべて選ぶ／新しい行として登録／取り下げ〕を出す。
//
// ・1件も無い時は何も出さない（画面の見た目は変えない）
// ・未送信件数の通知（queueSubscribe）を受けるたびに引き直す
// ・止まっている（競合・拒否）件があれば、画面を離れる時の確認（leaveGuard）に数える
// 規律: トークン由来クラスのみ・色だけで意味を伝えない（記号と文字）・console 出力なし・実名や本文をコードに書かない

import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  DbError,
  discardPendingNote,
  discardQueuedNoteInsert,
  hasUnpersistedNotes,
  dropRescuedNote,
  registerQueuedInsertAsNew,
  insertNoteAsNew,
  listUnsentNotes,
  noteAsNewKey,
  queueSubscribe,
  resendQueuedNoteInsert,
  resolveNoteMeta,
} from '../lib/db'
import type { UnsentNote } from '../lib/db'
import { registerUnsaved } from '../lib/leaveGuard'
import { fmtDayLabel } from '../lib/format'
import { SHIFT_LABEL } from '../lib/types'
import type { Staff } from '../lib/types'
import { NoteConflictResolver } from './ConflictResolver'
import type { NoteConflictResolution, NoteConflictTarget } from './ConflictResolver'
import { ConfirmDialog } from './ui'

export interface UnsentNotesProps {
  /** この日の分だけ出す（省略＝全件。設定画面） */
  day?: string
  /** この日の画面に出ている申し送りの id（日付の控えの無い旧形式の変更も、その日の画面で拾う） */
  noteIds?: ReadonlySet<number>
  actorId: number | null
  staff?: Staff[]
  /** 対象の表示名（null＝全体連絡） */
  residentName: (id: number | null) => string
  /** 一覧で何かを選び終えた（画面はその行を読み直す） */
  onChanged?: () => void
  /** 置く場所ごとの位置の指定（日報の表の中では、狭い画面でも左端に留めて画面の幅に収める） */
  style?: CSSProperties
}

function errText(e: unknown, fallback: string): string {
  return e instanceof DbError && e.message ? e.message : fallback
}

/** 止まっている（選び直しが要る）件か */
function isStopped(u: UnsentNote): boolean {
  if (u.kind === 'rescued') return true
  return (u.kind === 'edit' ? u.row.state : u.op.state) !== 'pending'
}

/** 状態の一言（記号と文字。色だけに頼らない） */
function stateText(u: UnsentNote): string {
  if (u.kind === 'rescued') {
    return '▲ 以前の版の画面で止まっていた入力です（同じ申し送りへの別の入力と食い違うため、両方を残しています）'
  }
  if (u.kind === 'insert') {
    if (u.op.state === 'rejected') return '▲ 登録できなかった申し送りです（サーバーに受け付けられませんでした）。「新しい行として登録」で登録し直せます'
    if (u.op.state === 'conflict') return '▲ 登録できずに止まっています'
    return '⚠ 登録の送信待ち（電波が戻ると自動で送信します）'
  }
  const deleting = Object.prototype.hasOwnProperty.call(u.row.values, 'deleted_at')
  // 送り先の登録が無くなった登録後の変更（登録を取り下げた・別の新しい行として登録した後に積まれた。第4巡 R4-2）
  if (u.row.ck !== undefined && u.row.state === 'rejected') {
    return '▲ 送り先の登録が無いため送れません（登録を取り下げたか、別の新しい行として登録した後の変更です）。「新しい行として登録」か「取り下げ」を選んでください'
  }
  if (u.row.fork !== undefined) return '▲ 別の画面（タブ）の入力と重なったため、分けて残しています（送ると食い違いとして止まります）'
  if (u.row.ck !== undefined) return '⚠ 登録の後に直した内容です（登録が届くのを待って送ります）'
  if (u.row.state === 'conflict') return '▲ 他の端末で先に変更されたため止まっています'
  if (u.row.state === 'rejected') return '▲ サーバーに受け付けられずに止まっています'
  return deleting ? '⚠ 削除の送信待ち（電波が戻ると自動で送信します）' : '⚠ 変更の送信待ち（電波が戻ると自動で送信します）'
}

function keyOf(u: UnsentNote): string {
  return u.kind === 'edit'
    ? `e${u.row.id}-${u.row.ck ?? ''}-${u.row.fork ?? ''}`
    : u.kind === 'rescued'
      ? `r${u.raw.length}-${u.row.id}-${u.row.vers.body ?? ''}`
      : `i${u.op.qid}`
}

export function UnsentNotes({ day, noteIds, actorId, staff, residentName, onChanged, style }: UnsentNotesProps) {
  const uid = useId()
  const [all, setAll] = useState<UnsentNote[]>(() => listUnsentNotes())
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ key: string; tone: 'ok' | 'danger' | 'warn'; text: string } | null>(null)
  const [resolve, setResolve] = useState<NoteConflictTarget | null>(null)
  const [askDrop, setAskDrop] = useState<UnsentNote | null>(null)

  const refresh = useCallback(() => setAll(listUnsentNotes()), [])
  useEffect(() => queueSubscribe(() => refresh()), [refresh])

  const items = useMemo(
    () =>
      day === undefined
        ? all
        : all.filter((u) =>
            u.kind === 'insert'
              ? u.op.note_on === day
              : u.row.meta?.note_on === day || (noteIds?.has(u.row.id) ?? false),
          ),
    [all, day, noteIds],
  )

  // 止まっている（競合・拒否）件は、画面を離れる時の確認に数える（端末には残るが、選び直しを忘れないように）
  useEffect(
    () =>
      registerUnsaved(() => listUnsentNotes().some(isStopped), 'notes'),
    [],
  )
  // 端末に残せていない申し送り（保存領域が一杯など）は、閉じると消える。「端末に残ります」とは言わない種類
  // （input＝従来の「破棄されます」の確認）で数える（L7-2）
  useEffect(() => registerUnsaved(() => hasUnpersistedNotes(), 'input'), [])

  const done = useCallback(() => {
    refresh()
    onChanged?.()
  }, [onChanged, refresh])

  const targetLabel = useCallback(
    (u: UnsentNote): string => {
      const rid = u.kind === 'insert' ? u.op.resident_id : (u.row.meta?.resident_id ?? null)
      const known = u.kind === 'insert' ? true : u.row.meta !== null
      const d = u.kind === 'insert' ? u.op.note_on : u.row.meta?.note_on
      const shift = u.kind === 'insert' ? u.op.shift : u.row.meta?.shift
      const parts = [
        d ? fmtDayLabel(d) : null,
        shift ? SHIFT_LABEL[shift] : null,
        known ? residentName(rid) : `申し送り #${u.kind === 'insert' ? '' : u.row.id}`,
      ].filter((x): x is string => x !== null && x !== '')
      return parts.join('・')
    },
    [residentName],
  )

  /** 〔新しい行として登録〕 */
  const registerNew = useCallback(
    async (u: UnsentNote) => {
      const k = keyOf(u)
      setBusy(k)
      setMessage(null)
      try {
        if (u.kind === 'insert' && u.op.state !== 'pending') {
          // 登録できなかった申し送り: 登録の中身＋登録後の変更を合わせた本文で、新しい行として登録する（第3巡）
          const r = await registerQueuedInsertAsNew(u.op.qid)
          setMessage({ key: k, tone: 'ok', text: r === 'queued' ? '⚠ 新しい行として送信待ちにしました' : '✓ 新しい行として登録しました' })
        } else if (u.kind === 'insert') {
          const r = await resendQueuedNoteInsert(u.op.qid)
          setMessage({
            key: k,
            tone: r === 'sent' ? 'ok' : 'warn',
            text: r === 'sent' ? '✓ 登録しました' : '⚠ まだ送れていません（送信待ちのまま残しています）',
          })
        } else {
          const body = typeof u.row.values.body === 'string' ? u.row.values.body : null
          if (body === null) return
          const meta = u.row.meta ?? (u.row.id > 0 ? await resolveNoteMeta(u.row.id) : null)
          if (meta === null) {
            setMessage({ key: k, tone: 'danger', text: '▲ どの日の申し送りかを確かめられないため、新しい行にできません。「くらべて選ぶ」から選んでください' })
            return
          }
          const newKey = `${noteAsNewKey(u.row.id, u.row.vers.body ?? '')}${u.row.ck ?? ''}${u.row.fork ?? ''}`
          const res = await insertNoteAsNew({ key: newKey, meta, body, reporterId: actorId })
          // 登録できた・送信待ちに確保できた後で、元の行の本文（見せた版）を外す
          if (u.kind === 'rescued') await dropRescuedNote(u.raw)
          else await discardPendingNote(u.row.target, ['body'], { body: u.row.vers.body })
          setMessage({ key: k, tone: 'ok', text: res === 'queued' ? '⚠ 新しい行として送信待ちにしました' : '✓ 新しい行として登録しました' })
        }
        done()
      } catch (e) {
        setMessage({ key: k, tone: 'danger', text: `▲ ${errText(e, '登録できませんでした。入力は消えていません')}` })
      } finally {
        setBusy(null)
      }
    },
    [actorId, done],
  )

  /** 〔取り下げ〕（確認の後） */
  const drop = useCallback(
    async (u: UnsentNote) => {
      setAskDrop(null)
      const k = keyOf(u)
      setBusy(k)
      try {
        if (u.kind === 'insert') await discardQueuedNoteInsert(u.op.qid, u.op.changes?.vers ?? {}) // 見せた版だけ外す（R4-2）
        else if (u.kind === 'rescued') await dropRescuedNote(u.raw)
        else await discardPendingNote(u.row.target, undefined, u.row.vers)
        done()
      } catch (e) {
        setMessage({ key: k, tone: 'danger', text: `▲ ${errText(e, '取り下げられませんでした')}` })
      } finally {
        setBusy(null)
      }
    },
    [done],
  )

  const onResolved = useCallback(
    (_r: NoteConflictResolution) => {
      setResolve(null)
      done()
    },
    [done],
  )

  const unpersisted = hasUnpersistedNotes()
  if (items.length === 0 && resolve === null && !unpersisted) return null
  const stopped = items.filter(isStopped).length
  const listId = `${uid}-list`
  const btn = 'min-h-tap rounded border px-3 text-base disabled:border-border disabled:text-ink3'

  return (
    <section
      aria-label="送れていない申し送り"
      className="my-2 rounded border border-warn bg-warn-bg px-3 py-2 text-ink print:hidden"
      style={style}
    >
      {unpersisted ? (
        // 保存領域が一杯などで、送れていない申し送りを端末に残せていない（このタブのメモリにだけある）。閉じると消える
        <p role="alert" className="mb-2 text-base font-bold text-danger">
          <span aria-hidden="true">▲ </span>
          端末の保存領域が一杯のため、送れていない申し送りを端末に残せていません。この画面を閉じたり再読み込みしたりすると消えます。電波がつながると自動で送ります。
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <p className="text-base font-bold">
          <span aria-hidden="true">▲ </span>
          送れていない申し送り {items.length}件
          {stopped > 0 ? <span className="font-normal">（うち止まっている {stopped}件）</span> : null}
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
          className={`${btn} border-border-strong bg-surface text-ink`}
        >
          {open ? '一覧を閉じる' : '本文を見る'}
        </button>
      </div>
      {open ? (
        <ul id={listId} className="mt-2 space-y-2">
          {items.map((u) => {
            const k = keyOf(u)
            const body = u.kind === 'insert' ? u.op.body : typeof u.row.values.body === 'string' ? u.row.values.body : null
            const other = u.kind !== 'insert' ? Object.keys(u.row.values).filter((f) => f !== 'body' && f !== 'deleted_at') : []
            const isBusy = busy === k
            return (
              <li key={k} className="rounded border border-border bg-surface p-3">
                <p className="text-sm text-ink2">{targetLabel(u)}</p>
                <p className="mt-1 text-sm font-bold text-ink">{stateText(u)}</p>
                {body !== null ? (
                  <p className="mt-1 whitespace-pre-wrap break-words text-base text-ink">{body}</p>
                ) : u.kind !== 'insert' && Object.prototype.hasOwnProperty.call(u.row.values, 'deleted_at') ? (
                  <p className="mt-1 text-base text-ink2">（この申し送りの削除）</p>
                ) : (
                  <p className="mt-1 text-base text-ink2">（本文以外の変更{other.length > 0 ? `: ${other.length}項目` : ''}）</p>
                )}
                <div className="mt-2 flex flex-wrap gap-gap">
                  {u.kind === 'edit' && u.row.id > 0 ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        setResolve({ id: u.row.id, label: targetLabel(u), ...(u.row.fork !== undefined ? { fork: u.row.fork } : {}) })
                      }
                      className={`${btn} border-primary font-bold text-primary`}
                    >
                      くらべて選ぶ
                    </button>
                  ) : null}
                  {body !== null && !(u.kind !== 'insert' && Object.prototype.hasOwnProperty.call(u.row.values, 'deleted_at')) ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void registerNew(u)}
                      className={`${btn} border-border-strong text-ink`}
                    >
                      新しい行として登録
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => setAskDrop(u)}
                    className={`${btn} border-danger text-danger`}
                  >
                    取り下げ
                  </button>
                </div>
                {message?.key === k ? (
                  <p role="status" className={`mt-1 text-sm ${message.tone === 'danger' ? 'text-danger' : message.tone === 'ok' ? 'text-ok' : 'text-ink'}`}>
                    {message.text}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      <NoteConflictResolver
        target={resolve}
        actorId={actorId}
        staff={staff}
        residentName={residentName}
        onClose={() => setResolve(null)}
        onResolved={onResolved}
      />
      <ConfirmDialog
        open={askDrop !== null}
        title="この申し送りを取り下げますか"
        body="あなたの本文は保存されません。取り下げると、この端末からも消えます。"
        confirmLabel="取り下げる"
        danger
        onConfirm={() => {
          if (askDrop !== null) void drop(askDrop)
        }}
        onCancel={() => setAskDrop(null)}
      />
    </section>
  )
}
