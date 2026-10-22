// デイ（せせらぎ）段階2c: 1人の1日記録の〔申し送りにする〕（2026-10-22 代表者承認・段階2の計画 v1 の 2.2／8章 V10）。
//
// ・〔申し送りにする〕→ 小窓で文を確かめ、ひと言（任意）→〔送る〕の2タップで、区分「デイ」の申し送りを1件作る
// ・書き込みは既存の insertNote（冪等キー dcn:<日>:<利用者id>:<記録>:<世代>）・deleteNote（〔外す〕）・saveNoteEdits（〔申し送りを直す〕）だけ
// ・世代は送る直前に読み直して決める（取り消した申し送りも数える）。印の読み込みができていない人・日では付けない
//   （取り消した鍵に当たると、insertNote は取り消した行を「届いた」として返し、印が付かないため）
// ・元の記録を後から直した・取り消した時は、申し送りはその時点の文のまま残し、印の横に知らせる
// ・17時のロック（0033）: 現場のログインは記録日の 17:00 から付け外し・直しができない（事務所はできる。サーバーが正）
// ・送信待ち・止まった時は印の横に出す（止まった分は設定の「送れていない申し送り」で確かめる）。端末に業務データを残さない

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DbError,
  NOTE_LOCKED_MESSAGE,
  cachedMyRole,
  canUnlockNotes,
  deleteNote,
  fetchDaycareNoteMarks,
  fetchMyRole,
  insertNote,
  isNoteLockedError,
  isNoteRpcMissing,
  isQueuePersisted,
  noteDeleted,
  pendingDaycareNoteMarks,
  pendingNoteRow,
  queuePending,
  queueSubscribe,
  saveNoteEdits,
  subscribeChanges,
  subscribeMyRole,
} from '../lib/db'
import type { CellSaveResult, DaycareNoteMarkRow, MyRole, NoteMeta, Queued } from '../lib/db'
import {
  MARK_COMMENT_MAX,
  isStale,
  markBody,
  markCategories,
  markCommentError,
  markDayPrefix,
  markKey,
  markPrefix,
  nextGen,
  parseMarkKey,
} from '../lib/daycareNoteMark'
import type { MarkRecord } from '../lib/daycareNoteMark'
import { lockState } from '../lib/noteLock'
import { noteTimeFor } from '../lib/nextMorning'
import type { Note } from '../lib/types'
import { ConfirmDialog, ModalShell } from './ui'

const MSG_QUEUED = '電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'
const MSG_NOT_PERSISTED =
  '送信待ちにしましたが、端末に控えを残せませんでした（保存領域の空きが不足している可能性があります）。この画面を閉じずに電波の回復をお待ちください。'
const MSG_HELD = '他の端末で先に変更されていたため、止めました。設定の「送れていない申し送り」で確かめてください。'
const MSG_LOCKED_FIELD = '17:00 を過ぎたため、現場の端末ではこの日の申し送りの印を付け外しできません（事務所のログインでできます）。'
const MSG_NOT_READ = '申し送りの印を読み込めていないため、印を付けられません。電波の届く所で〔最新に更新〕を押してください。'
const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから入れてください。'

type Msg = { tone: 'info' | 'warn' | 'danger'; text: string }

interface Options {
  residentId: number
  day: string
  actorId: number | null
  /** デイの画面の入力が使えるか（旗・未来の日・設定待ち）。使えない時の理由 */
  canWrite: boolean
  blockedReason: string | null
  /** 画面の〔最新に更新〕の回数（変わったら印も読み直す） */
  refreshKey: number
  show: (msg: string) => void
}

function noteMetaOf(n: Note): NoteMeta {
  return { note_on: n.note_on, shift: n.shift, resident_id: n.resident_id, after16: n.after16 }
}
const queuedText = () =>
  isNoteRpcMissing()
    ? '申し送りの変更は、サーバー側の更新待ちのためこの端末に保存しました（送信待ち）。更新されると自動で送ります。'
    : isQueuePersisted()
      ? MSG_QUEUED
      : MSG_NOT_PERSISTED
const errText = (e: unknown, fallback: string) =>
  isNoteLockedError(e) ? NOTE_LOCKED_MESSAGE : e instanceof DbError ? e.message : fallback

/**
 * その人・その日の申し送りの印。button(記録, いまの文, 分かるか) を各記録の横に置き、dialogs を画面に1回置く。
 * いまの文が null の記録（まだ記録が無い）は、印が無ければ何も出さない。known=false（排泄ケアアプリの記録を読めていない等）
 * の時は、いまの中身が分からないので「元の記録が変わりました」を出さない
 */
export function useDaycareNoteMarks({ residentId, day, actorId, canWrite, blockedReason, refreshKey, show }: Options): {
  button: (rec: MarkRecord, text: string | null, known?: boolean) => ReactNode
  dialogs: ReactNode
} {
  const personKey = `${residentId}:${day}`
  /** 読めた印（key＝読んだ人・日。違う人・日の分は使わない） */
  const [marks, setMarks] = useState<{ key: string; rows: DaycareNoteMarkRow[] } | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [role, setRole] = useState<MyRole | null | undefined>(cachedMyRole())
  const [msgs, setMsgs] = useState<Record<string, Msg>>({})
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [, setTick] = useState(0)
  const [now, setNow] = useState(Date.now())
  /** 小窓: add＝申し送りにする／fix＝申し送りを直す */
  const [dlg, setDlg] = useState<{ mode: 'add' | 'fix'; rec: MarkRecord; text: string; comment: string; row: DaycareNoteMarkRow | null } | null>(null)
  const [delRow, setDelRow] = useState<{ rec: MarkRecord; row: DaycareNoteMarkRow } | null>(null)
  const genRef = useRef(0)
  const here = useRef({ residentId, day })
  here.current = { residentId, day }

  const load = useCallback(async (d: string, rid: number): Promise<DaycareNoteMarkRow[] | null> => {
    const gen = ++genRef.current
    try {
      const rows = await fetchDaycareNoteMarks(d, rid)
      if (gen === genRef.current) {
        setMarks({ key: `${rid}:${d}`, rows })
        setLoadFailed(false)
      }
      return rows
    } catch {
      if (gen === genRef.current) setLoadFailed(true)
      return null
    }
  }, [])

  useEffect(() => {
    setMsgs({})
    void load(day, residentId)
  }, [day, residentId, refreshKey, load])

  // 他の端末の申し送りの変更・送信待ちの減り（届いた）で読み直す。ロックの時刻の見直し（1分ごと）
  useEffect(() => {
    let timer: number | null = null
    const later = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        void load(here.current.day, here.current.residentId)
      }, 400)
    }
    const off = subscribeChanges((table) => {
      if (table === 'notes') later()
    })
    let last = queuePending()
    const offQ = queueSubscribe((n) => {
      setTick((x) => x + 1)
      if (n < last) later()
      last = n
    })
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      off()
      offQ()
      window.clearInterval(t)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [load])

  useEffect(() => {
    let alive = true
    fetchMyRole()
      .then((r) => alive && setRole(r))
      .catch(() => {})
    const off = subscribeMyRole(() => setRole(cachedMyRole()))
    return () => {
      alive = false
      off()
    }
  }, [])

  const rows = marks !== null && marks.key === personKey ? marks.rows : null
  // この方・この日の送信待ちの印の登録（描画ごとに1回だけ読む）
  const pendAll = pendingDaycareNoteMarks(markDayPrefix(day, residentId))
  const lockedForMe = lockState(day, 'daycare', false, now).locked && !canUnlockNotes(role)
  const msgKey = (rec: MarkRecord) => `${personKey}:${markPrefix(day, residentId, rec)}`
  const say = (k: string, m: Msg | null) =>
    setMsgs((prev) => {
      const next = { ...prev }
      if (m === null) delete next[k]
      else next[k] = m
      return next
    })
  const setBusyKey = (k: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(k)
      else next.delete(k)
      return next
    })
  /** 付け外し・直しの前の確かめ（理由の文。null＝できる） */
  const precheck = (): string | null => {
    if (!canWrite) return blockedReason ?? '入力できない状態です。'
    if (actorId === null) return MSG_NO_RECORDER
    if (lockedForMe) return MSG_LOCKED_FIELD
    return null
  }

  /** その記録のいまの印（生きている申し送りのうち世代のいちばん新しいもの） */
  const liveOf = (rec: MarkRecord): DaycareNoteMarkRow | null => {
    if (rows === null) return null
    const prefix = markPrefix(day, residentId, rec)
    let best: DaycareNoteMarkRow | null = null
    for (const r of rows) {
      if (r.deleted || !r.clientKey.startsWith(prefix)) continue
      if (best === null || (parseMarkKey(r.clientKey)?.gen ?? 0) > (parseMarkKey(best.clientKey)?.gen ?? 0)) best = r
    }
    return best
  }

  /** 〔送る〕: 送る直前に読み直して世代を決め、区分「デイ」の申し送りを1件作る（送り先は押した時の人・日） */
  const sendAdd = async (rec: MarkRecord, text: string, comment: string) => {
    const rid = residentId
    const d = day
    const k = `${rid}:${d}:${markPrefix(d, rid, rec)}`
    const why = precheck()
    if (why !== null) {
      say(k, { tone: 'warn', text: why })
      return
    }
    setBusyKey(k, true)
    try {
      const prefix = markPrefix(d, rid, rec)
      const fresh = await load(d, rid)
      // 読み直せない時は、同じ人・日で前に読めた印があればそれで数える。一度も読めていなければ付けない
      const known = fresh ?? (marks !== null && marks.key === `${rid}:${d}` ? marks.rows : null)
      if (known === null) {
        say(k, { tone: 'warn', text: MSG_NOT_READ })
        return
      }
      // 読み直したら、その記録にもう生きている印がある（別の端末が先に申し送りにした）: 2件目を作らない
      if (known.some((r) => !r.deleted && r.clientKey.startsWith(prefix))) {
        say(k, { tone: 'info', text: '別の端末が先に申し送りにしていました（申し送りは1件のままです）。' })
        return
      }
      const deletedIds = new Set(known.filter((r) => r.deleted).map((r) => r.note.id))
      const keys = [...known.map((r) => r.clientKey), ...pendingDaycareNoteMarks(markDayPrefix(d, rid)).map((p) => p.clientKey)]
      let gen = nextGen(prefix, keys)
      const body = markBody(text, comment)
      const payload = {
        note_on: d,
        shift: 'daycare' as const,
        facility: null,
        category: null,
        resident_id: rid,
        role_tags: [],
        importance: 'normal' as const,
        body,
        // 記録日が今日の時だけ今の時刻（過去の日に誤った時刻を残さない・F34 と同じ関数）
        occurred_at: noteTimeFor(d, 'daycare', new Date()),
        ongoing: false,
        ended_at: null,
        reporter_id: actorId,
        color: null,
        // 「16時以降」は日勤だけの区切り（NoteFormPage の noteAfter16）。デイの申し送りには付かない
        after16: false,
        ...(markCategories(rec.kind).length > 0 ? { categories: markCategories(rec.kind) } : {}),
      }
      let res = await insertNote(payload, { clientKey: markKey(d, rid, rec, gen) })
      // 返った行が取り消し済み（読み直しの後に別の端末が同じ世代を付けて外した）: 世代を進めて1回だけ送り直す
      if (res !== 'queued') {
        const id = res.id
        const after = deletedIds.has(id) ? null : await load(d, rid)
        if (deletedIds.has(id) || (after !== null && after.some((r) => r.note.id === id && r.deleted))) {
          gen = nextGen(prefix, [...keys, markKey(d, rid, rec, gen), ...(after ?? []).map((r) => r.clientKey)])
          res = await insertNote(payload, { clientKey: markKey(d, rid, rec, gen) })
        }
      }
      if (res === 'queued') {
        setTick((x) => x + 1)
        say(k, { tone: isQueuePersisted() ? 'info' : 'danger', text: `申し送り：${queuedText()}` })
        return
      }
      say(k, null)
      await load(d, rid)
      if (here.current.residentId === rid && here.current.day === d) show('申し送りにしました')
    } catch (e) {
      say(k, { tone: 'danger', text: errText(e, '申し送りにできませんでした。通信状態を確認して、もう一度押してください。') })
    } finally {
      setBusyKey(k, false)
    }
  }

  /** 〔外す〕: その申し送りを取り消す（見た行のままの時だけ・F09） */
  const sendRemove = async (rec: MarkRecord, row: DaycareNoteMarkRow) => {
    setDelRow(null)
    const rid = residentId
    const d = day
    const k = `${rid}:${d}:${markPrefix(d, rid, rec)}`
    const why = precheck()
    if (why !== null) {
      say(k, { tone: 'warn', text: why })
      return
    }
    setBusyKey(k, true)
    try {
      const res = await deleteNote({ id: row.note.id }, row.note, { meta: noteMetaOf(row.note), editedBy: actorId })
      if (res === 'queued') {
        setTick((x) => x + 1)
        say(k, { tone: isQueuePersisted() ? 'info' : 'danger', text: `印を外す：${queuedText()}` })
        return
      }
      if (!noteDeleted(res)) {
        say(k, { tone: 'warn', text: MSG_HELD })
        return
      }
      say(k, null)
      await load(d, rid)
      if (here.current.residentId === rid && here.current.day === d) show('申し送りの印を外しました（申し送りを取り消しました）')
    } catch (e) {
      say(k, { tone: 'danger', text: errText(e, '外せませんでした。通信状態を確認して、もう一度押してください。') })
    } finally {
      setBusyKey(k, false)
    }
  }

  /** 〔申し送りを直す〕: いまの記録の文で本文を直す（基準は見た本文） */
  const sendFix = async (rec: MarkRecord, row: DaycareNoteMarkRow, text: string, comment: string) => {
    const rid = residentId
    const d = day
    const k = `${rid}:${d}:${markPrefix(d, rid, rec)}`
    const why = precheck()
    if (why !== null) {
      say(k, { tone: 'warn', text: why })
      return
    }
    setBusyKey(k, true)
    try {
      const res: CellSaveResult<Note> | Queued = await saveNoteEdits(
        { id: row.note.id },
        { body: { value: markBody(text, comment), base: row.note.body } },
        { meta: noteMetaOf(row.note), editedBy: actorId },
      )
      if (res === 'queued') {
        setTick((x) => x + 1)
        say(k, { tone: isQueuePersisted() ? 'info' : 'danger', text: `申し送りを直す：${queuedText()}` })
        return
      }
      if (res.conflicts.length > 0 || res.held === true) {
        say(k, { tone: 'warn', text: MSG_HELD })
        return
      }
      say(k, null)
      await load(d, rid)
      if (here.current.residentId === rid && here.current.day === d) show('申し送りを直しました')
    } catch (e) {
      say(k, { tone: 'danger', text: errText(e, '直せませんでした。通信状態を確認して、もう一度押してください。') })
    } finally {
      setBusyKey(k, false)
    }
  }

  const smallCls = 'min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:text-ink3'
  const toneCls: Record<Msg['tone'], string> = {
    info: 'border-primary bg-surface',
    warn: 'border-warn bg-warn-bg',
    danger: 'border-danger bg-danger-bg',
  }

  const button = (rec: MarkRecord, text: string | null, known = true): ReactNode => {
    const k = msgKey(rec)
    const prefix = markPrefix(day, residentId, rec)
    const live = liveOf(rec)
    const pend = pendAll.find((p) => p.clientKey.startsWith(prefix)) ?? null
    const pendDel = live === null ? null : pendingNoteRow({ id: live.note.id })
    const msg = msgs[k] ?? null
    const isBusy = busy.has(k)
    const blocked = precheck()
    let body: ReactNode = null
    if (live !== null) {
      const stale = known && isStale(live.note.body, text)
      const removing = pendDel !== null && Object.prototype.hasOwnProperty.call(pendDel.values, 'deleted_at')
      body = (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-gap">
            <span className="inline-flex min-h-tap items-center rounded-full border border-ok bg-ok-bg px-3 text-sm text-ink">
              <span aria-hidden="true">✉ </span>申し送り済み{removing ? '（外す操作は送信待ち）' : ''}
            </span>
            <button type="button" disabled={blocked !== null || isBusy || removing} onClick={() => setDelRow({ rec, row: live })} className={smallCls}>
              外す
            </button>
          </div>
          {pendDel !== null && pendDel.state !== 'pending' ? (
            <p role="alert" className="rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
              <span aria-hidden="true">▲ </span>この申し送りへの変更が止まっています。設定の「送れていない申し送り」で確かめてください。
            </p>
          ) : null}
          {stale ? (
            <div role="status" className="flex flex-wrap items-center gap-gap rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
              <span>
                <span aria-hidden="true">ⓘ </span>元の記録が変わりました（申し送りは前の内容のまま）。
              </span>
              {text !== null ? (
                <button
                  type="button"
                  disabled={blocked !== null || isBusy || removing}
                  onClick={() => setDlg({ mode: 'fix', rec, text, comment: '', row: live })}
                  className={smallCls}
                >
                  申し送りを直す
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )
    } else if (pend !== null) {
      body = (
        <p role={pend.state === 'pending' ? 'status' : 'alert'} className="rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
          <span aria-hidden="true">{pend.state === 'pending' ? '⚠ ' : '▲ '}</span>
          {pend.state === 'pending'
            ? '申し送り（送信待ち。電波が戻ると自動で送信します）'
            : pend.locked
              ? '申し送りは 17:00 のロックで止まっています。設定の「送れていない申し送り」で確かめてください。'
              : '申し送りが止まっています。設定の「送れていない申し送り」で確かめてください。'}
        </p>
      )
    } else if (text !== null) {
      body = (
        <button
          type="button"
          disabled={isBusy || (rows === null && loadFailed)}
          onClick={() => {
            const why = precheck() ?? (rows === null ? MSG_NOT_READ : null)
            if (why !== null) say(k, { tone: 'warn', text: why })
            else setDlg({ mode: 'add', rec, text, comment: '', row: null })
          }}
          className={smallCls}
          aria-label={`「${text}」を申し送りにする`}
        >
          申し送りにする
        </button>
      )
    }
    if (body === null && msg === null) return null
    return (
      <div className="space-y-1">
        {body}
        {msg !== null ? (
          <p role="status" className={`rounded border p-2 text-sm text-ink ${toneCls[msg.tone]}`}>
            <span aria-hidden="true">{msg.tone === 'info' ? 'ⓘ ' : '⚠ '}</span>
            {msg.text}
          </p>
        ) : null}
      </div>
    )
  }

  const commentErr = dlg === null ? null : markCommentError(dlg.comment)
  const dialogs = (
    <>
      <ModalShell open={dlg !== null} label={dlg?.mode === 'fix' ? '申し送りを直す' : '申し送りにする'} onClose={() => setDlg(null)} narrow>
        {dlg !== null ? (
          <div className="space-y-3 p-4">
            <h2 className="text-lg font-bold text-ink">{dlg.mode === 'fix' ? '申し送りを直す' : '申し送りにする'}</h2>
            <p className="text-sm text-ink2">区分「デイ」の申し送りとして送ります。</p>
            {dlg.mode === 'fix' && dlg.row !== null ? (
              <p className="text-sm text-ink2">いまの申し送り: {dlg.row.note.body}</p>
            ) : null}
            <p className="rounded border border-border bg-surface2 p-2 text-base text-ink">{dlg.text}</p>
            <label className="block text-sm text-ink2">
              ひと言（任意・{MARK_COMMENT_MAX}字まで）
              <input
                type="text"
                value={dlg.comment}
                maxLength={MARK_COMMENT_MAX * 2}
                onChange={(e) => setDlg({ ...dlg, comment: e.target.value })}
                aria-invalid={commentErr !== null}
                aria-describedby={commentErr !== null ? 'mark-comment-err' : undefined}
                className="mt-1 block min-h-tap w-full rounded border border-border-strong bg-surface px-2 text-lg text-ink"
              />
            </label>
            {commentErr !== null ? (
              <p id="mark-comment-err" className="text-sm text-danger">
                {commentErr}
              </p>
            ) : null}
            <div className="flex justify-end gap-gap">
              <button type="button" onClick={() => setDlg(null)} className={smallCls}>
                キャンセル
              </button>
              <button
                type="button"
                disabled={commentErr !== null}
                onClick={() => {
                  const cur = dlg
                  setDlg(null)
                  if (cur.mode === 'fix' && cur.row !== null) void sendFix(cur.rec, cur.row, cur.text, cur.comment)
                  else void sendAdd(cur.rec, cur.text, cur.comment)
                }}
                className="min-h-tap rounded border-2 border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border-strong disabled:bg-surface disabled:text-ink3"
              >
                {dlg.mode === 'fix' ? '直す' : '送る'}
              </button>
            </div>
          </div>
        ) : null}
      </ModalShell>
      <ConfirmDialog
        open={delRow !== null}
        title="申し送りの印を外しますか"
        body={delRow === null ? '' : `申し送り「${delRow.row.note.body}」を取り消します。`}
        confirmLabel="外す"
        danger
        onConfirm={() => delRow !== null && void sendRemove(delRow.rec, delRow.row)}
        onCancel={() => setDelRow(null)}
      />
    </>
  )

  return { button, dialogs }
}
