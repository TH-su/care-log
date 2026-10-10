// 送れていない申し送りの一覧（2026-09-29・申し送りを消さない作り替え 段B-4・精査 H1・L2）。
// 日報（その日の上部）と設定画面に出す。送信待ち・止まった変更（cl_sendQueue2 の notes#<id>）と、
// 登録を待っている・拒否で止まった新規登録（cl_sendQueue の notes の insert。旧ビルドが積んだ分も含む）を本文つきで並べ、
// 各件〔くらべて選ぶ／新しい行として登録／取り下げ〕を出す。
//
// ・1件も無い時は何も出さない（画面の見た目は変えない）
// ・未送信件数の通知（queueSubscribe）を受けるたびに引き直す
// ・止まっている（競合・拒否）件があれば、画面を離れる時の確認（leaveGuard）に数える
// ・各件に申し送りの記入者を出す（F41・2026-10-10。共用の端末で、他の職員の止まった本文を自分の分と思って
//   取り下げないように）。〔新しい行として登録〕でも記入者は元の人のまま（本人回答）
// ・取り下げは同じ端末のほかのタブにも効く（墓標・F05）。既に登録されていた時はその旨を出す
// 規律: トークン由来クラスのみ・色だけで意味を伝えない（記号と文字）・console 出力なし・実名や本文をコードに書かない

import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  DbError,
  discardPendingNote,
  discardQueuedOp,
  hasUnpersistedNotes,
  dropRescuedNote,
  fetchNoteRows,
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

/**
 * その件の申し送りの記入者（F41）。登録待ちは登録の記入者、変更は変更で選び直した記入者があればそれ、無ければ
 * 元の申し送りの記入者（読み直した値）。undefined＝分からない（読み直す前・読めなかった）／null＝記入者なし
 */
function reporterOf(u: UnsentNote, rowReporter: ReadonlyMap<number, number | null>): number | null | undefined {
  if (u.kind === 'insert') return u.op.reporter_id
  const v = u.row.values.reporter_id
  if (typeof v === 'number' || v === null) return v
  if (u.row.id > 0 && rowReporter.has(u.row.id)) return rowReporter.get(u.row.id) ?? null
  return undefined
}

/**
 * その件の本文（取り消しなら取り消し）を入力した職員（F41 手直し）。送信待ちが欄ごとに持つ入力者（F07 の by。旧版の控えは
 * 行の操作者）を使う。申し送りの記入者とは別（共用の端末で、職員A が打った変更を職員B が見ている時に「あなたの」と
 * 言い切らないため）。登録待ちは、登録後に本文を直した職員が分かる時だけ（登録の本文そのものは記入者の申し送り）。
 * undefined＝分からない（旧形式の読み替え・操作者が未選択だった）
 */
function typistOf(u: UnsentNote): number | null | undefined {
  const bys = u.kind === 'insert' ? u.op.changes?.bys : u.row.bys
  if (bys === undefined) return undefined
  const f = Object.prototype.hasOwnProperty.call(bys, 'body')
    ? 'body'
    : Object.prototype.hasOwnProperty.call(bys, 'deleted_at')
      ? 'deleted_at'
      : u.kind === 'insert'
        ? null
        : (Object.keys(bys)[0] ?? null)
  if (f === null) return undefined
  const v = bys[f]
  return typeof v === 'number' ? v : undefined
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
  /** 一覧から消えた件についての知らせ（取り下げようとしたら既に登録されていた・F05） */
  const [notice, setNotice] = useState<string | null>(null)
  /** 変更の送信待ちの元の申し送りの記入者（行 id → 記入者。一覧を開いた時に読み直す・画面のメモリだけ） */
  const [rowReporter, setRowReporter] = useState<ReadonlyMap<number, number | null>>(new Map())

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

  // 一覧を開いたら、変更の送信待ちの元の申し送りの記入者を読む（F41。読めなければ「確かめられません」のまま）
  const editIdsKey = items
    .filter((u) => u.kind !== 'insert' && u.row.id > 0 && !Object.prototype.hasOwnProperty.call(u.row.values, 'reporter_id'))
    .map((u) => (u.kind === 'insert' ? 0 : u.row.id))
    .sort((a, b) => a - b)
    .join(',')
  useEffect(() => {
    if (!open || editIdsKey === '') return undefined
    let alive = true
    const ids = editIdsKey.split(',').map(Number)
    fetchNoteRows(ids)
      .then((rows) => {
        if (!alive) return
        const next = new Map<number, number | null>()
        for (const r of rows) next.set(r.id, r.reporter_id)
        setRowReporter(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [open, editIdsKey])

  /** 記入者の名前（名簿に無ければ「職員ID n」） */
  const staffName = useCallback(
    (id: number): string => staff?.find((s) => s.id === id)?.name ?? `職員ID ${id}`,
    [staff],
  )

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
          // 記入者は元の人のまま（F41・本人回答。押した人＝この端末の操作者の名義にしない）。
          // 元の申し送りの記入者を読めない（行 id のある変更で、電波が無い等）時は登録しない＝別人の名義を作らない。
          // 登録が取り下げられた後の変更（行 id の無い ck）は元の記入者が端末に残っていないので、記入者なしで登録する
          let reporterId = reporterOf(u, rowReporter)
          if (reporterId === undefined && u.row.id > 0) {
            const rows = await fetchNoteRows([u.row.id]).catch(() => null)
            // 読めた（rows がある）のに見つからない＝元の申し送りは取り消されている。元の記入者は分からないので記入者なし
            // （別人の名義にはしない）。読めなかった（通信）時は undefined のまま＝下で止める
            if (rows !== null) reporterId = rows.find((r) => r.id === u.row.id)?.reporter_id ?? null
          }
          if (reporterId === undefined && u.row.id > 0) {
            setMessage({ key: k, tone: 'danger', text: '▲ 元の申し送りの記入者を確かめられないため、新しい行にできません。電波状態を確認して、もう一度押してください' })
            return
          }
          const newKey = `${noteAsNewKey(u.row.id, u.row.vers.body ?? '')}${u.row.ck ?? ''}${u.row.fork ?? ''}`
          const res = await insertNoteAsNew({ key: newKey, meta, body, reporterId: reporterId ?? null })
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
    [done, rowReporter],
  )

  /** 〔取り下げ〕（確認の後） */
  const drop = useCallback(
    async (u: UnsentNote) => {
      setAskDrop(null)
      const k = keyOf(u)
      setBusy(k)
      try {
        if (u.kind === 'insert') {
          // 登録の取り下げ（F05）: 墓標を付けて、同じ端末のほかのタブ・次の起動からも外す。ほかのタブが送っている最中なら、
          // 送り終わるのを待ってから取り下げる。既に送り終えていた（登録された）時は取り下げられないので知らせる
          const r = await discardQueuedOp(u.op.qid)
          // 登録の後の変更は、登録を取り下げられた時だけ、見せた版だけ外す（R4-2。見せた後に積まれた変更は残る）。
          // 既に登録されていた（sent）時は、その変更は登録された行への普通の修正として送るべきものなので外さない
          // （登録は残るのに、直した本文だけを黙って捨てない）
          const vers = u.op.changes?.vers ?? {}
          if (r === 'dropped' && Object.keys(vers).length > 0) await discardPendingNote({ clientKey: u.op.qid }, undefined, vers)
          if (r === 'sent') {
            // 一覧からは消えるので、一覧の上に残す（閉じるまで出す）
            setNotice('⚠ 取り下げようとした申し送りは、既に登録されていました（取り下げられませんでした）。不要なら、日報・タイムラインの申し送りから削除してください。')
          }
        } else if (u.kind === 'rescued') await dropRescuedNote(u.raw)
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

  /** 記入者の表示（F41） */
  function reporterText(u: UnsentNote): string {
    const r = reporterOf(u, rowReporter)
    if (r === undefined) return open ? '確かめられません' : '…'
    if (r === null) return '記入者なし'
    return r === actorId ? `${staffName(r)}（いまの記録者）` : staffName(r)
  }

  /** 入力した職員の表示（F41 手直し。変更・取り消しの件だけ） */
  function typistText(u: UnsentNote): string {
    const t = typistOf(u)
    if (t === undefined || t === null) return '確かめられません'
    return t === actorId ? `${staffName(t)}（いまの記録者）` : staffName(t)
  }

  /**
   * 取り下げの確認文（F41・F05）。「あなたの」と言うのは、本文を入力した職員がいまの記録者だと分かる時だけ（手直し・
   * 2026-10-10）。直す前は申し送りの記入者だけで分けていたため、記入者なし・記入者がいまの記録者の申し送りでは、別の職員が
   * 打った変更でも「あなたの変更の本文」と言い切った。登録待ちは記入者で分ける（登録の本文は記入者の申し送り）
   */
  function dropBody(u: UnsentNote): string {
    const what = u.kind === 'insert' ? '申し送り' : '変更'
    const t = typistOf(u)
    let whose: string
    if (typeof t === 'number') {
      whose = t === actorId ? 'あなたの' : `「${staffName(t)}」が入力した`
    } else if (u.kind === 'insert') {
      const r = reporterOf(u, rowReporter)
      whose =
        typeof r === 'number'
          ? r === actorId
            ? 'あなたの'
            : `記入者「${staffName(r)}」の`
          : 'この端末に残っている（入力した職員を確かめられない）'
    } else {
      whose = 'この端末に残っている（入力した職員を確かめられない）'
    }
    return `${whose}${what}の本文は保存されません。取り下げると、この端末（同じ端末のほかのタブを含む）の送信待ちから外れます。既に登録されていた時はお知らせします。`
  }

  const unpersisted = hasUnpersistedNotes()
  if (items.length === 0 && resolve === null && !unpersisted && notice === null) return null
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
      {notice !== null ? (
        <div className="mb-2 flex flex-wrap items-center gap-gap">
          <p role="status" className="min-w-0 flex-1 text-base text-ink">
            {notice}
          </p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className={`${btn} shrink-0 border-border-strong bg-surface text-ink`}
          >
            閉じる
          </button>
        </div>
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
                {/* 記入者（F41）。共用の端末で、誰の申し送りかを見てから選べるようにする */}
                <p className="text-sm text-ink2">
                  {u.kind === 'insert' ? '記入者' : '申し送りの記入者'}：
                  <span className="font-bold text-ink">{reporterText(u)}</span>
                </p>
                {/* この変更を打った職員（手直し）。申し送りの記入者と違うことがある（共用の端末で別の職員が直した） */}
                {u.kind !== 'insert' ? (
                  <p className="text-sm text-ink2">
                    この変更を入力した職員：<span className="font-bold text-ink">{typistText(u)}</span>
                  </p>
                ) : null}
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
        body={askDrop === null ? '' : dropBody(askDrop)}
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
