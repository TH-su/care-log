// デイ（せせらぎ）計画D（2026-11-10）: 一括の画面の行の「⚐ 申し送り」（ワンタップ）。改善計画 v1 §3 の D・DESIGN §4(9)。
//
// ・押すと1タップで、その行の記録から文を組み立てた区分「デイ」の申し送りを1件作る（小窓・ひと言なし＝文は markBody(記録の文, '')）。
//   送れたら「⚑ 申し送り」（注意の淡地＋塗りの旗＋文字）に変わり、〔元に戻す〕の知らせ（8秒・画面の useToast）。〔元に戻す〕は〔外す〕と同じ deleteNote
// ・「⚑ 申し送り」をもう一度押すと〔外す〕の確認（1人の画面と同じ確認の小窓）。ひと言を足す・直すのは1人の画面の〔申し送りを直す〕（今のまま）
// ・書き込みは既存の insertNote（冪等キー dcn:<日>:<利用者id>:<記録>:<世代>-<送るたびの印>・鍵の作りは daycareNoteMark.ts）と deleteNote だけ。
//   送る直前に読み直して世代を決め、生きている印があれば2件目を作らない（1人の画面の部品 DaycareNoteMark.tsx と同じ手順）
// ・17時のロック（0033）・送信待ち・止まった時・記録者の扱いは1人の画面と同じ（現場のログインは記録日の 17:00 から付け外しできない）
// ・印の読み込みは、その日の全員分を1本（fetchDaycareDayNotes）。Realtime の購読は足さない（他の端末の印は〔最新に更新〕・送信待ちが
//   送れて減った時・送る直前に読み直す）。端末に業務データを残さない
// 1人の画面の useDaycareNoteMarks は変えていない（1人・1日ごとの読み込みと2タップの小窓のまま）。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DbError,
  NOTE_LOCKED_MESSAGE,
  cachedMyRole,
  canUnlockNotes,
  deleteNote,
  fetchDaycareDayNotes,
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
  subscribeMyRole,
} from '../lib/db'
import type { DaycareNoteMarkRow, MyRole, NoteMeta } from '../lib/db'
import {
  MARK_KIND_LABEL,
  markBody,
  markCategories,
  markDayAllPrefix,
  markDayPrefix,
  markKey,
  markPrefix,
  markRecordOf,
  nextGen,
  parseMarkKey,
} from '../lib/daycareNoteMark'
import type { MarkKind, MarkRecord } from '../lib/daycareNoteMark'
import { lockState } from '../lib/noteLock'
import { noteTimeFor } from '../lib/nextMorning'
import type { Note } from '../lib/types'
import { ConfirmDialog } from './ui'

// 文は1人の画面の部品（DaycareNoteMark.tsx）と同じ
const MSG_QUEUED = '電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'
const MSG_NOT_PERSISTED =
  '送信待ちにしましたが、端末に控えを残せませんでした（保存領域の空きが不足している可能性があります）。この画面を閉じずに電波の回復をお待ちください。'
const MSG_HELD = '他の端末で先に変更されていたため、止めました。設定の「送れていない申し送り」で確かめてください。'
const MSG_LOCKED_FIELD = '17:00 を過ぎたため、現場の端末ではこの日の申し送りの印を付け外しできません（事務所のログインでできます）。'
const MSG_NOT_READ = '申し送りの印を読み込めていないため、印を付けられません。電波の届く所で〔最新に更新〕を押してください。'
const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから入れてください。'
const MSG_LOADING = '申し送りの印を読み込んでいます。'
const MSG_STOPPED_ADD = '申し送りが止まっています。設定の「送れていない申し送り」で確かめてください。'
const MSG_STOPPED_ADD_LOCKED = '申し送りは 17:00 のロックで止まっています。設定の「送れていない申し送り」で確かめてください。'
const MSG_STOPPED_EDIT = 'この申し送りへの変更が止まっています。設定の「送れていない申し送り」で確かめてください。'

/** 行の下に出す一言。queued＝送信待ちにした旨（その記録の送信待ちが無くなったら出さない） */
type Msg = { tone: 'info' | 'warn' | 'danger'; text: string; queued?: true }

interface Options {
  day: string
  actorId: number | null
  /** その画面の入力が使えるか（旗・設定待ち）。使えない時の理由 */
  canWrite: boolean
  blockedReason: string | null
  /** 画面の〔最新に更新〕の回数（変わったら印も読み直す） */
  refreshKey: number
  /** 画面の知らせ（undo を渡すと〔元に戻す〕つき・8秒） */
  show: (msg: string, undo?: () => void) => void
}

/** 行の「⚐ 申し送り」1つ */
export interface DayMarkInput {
  residentId: number
  /** 氏名（読み上げ・知らせ・確認の文だけに使う。申し送りの文には入れない） */
  name: string
  /** 印を付ける記録（記録が無い時は null） */
  rec: MarkRecord | null
  /** いまの記録の文（サーバーの値から。null＝記録なし） */
  text: string | null
  /** 記録が無い・読めない時の理由（押せない。title と読み上げに出す） */
  why: string | null
  /** 付けた印の文字（既定は「申し送り」。バイタル・食事のテンキーは「申し送り済み」） */
  onLabel?: string
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
const genOf = (r: DaycareNoteMarkRow) => parseMarkKey(r.clientKey)?.gen ?? 0

/**
 * その日の全員の申し送りの印（一括の画面）。button(行) を各行に置き、note(行) を行の下の知らせの行に、dialogs を画面に1回置く
 */
export function useDaycareNoteMarksDay({ day, actorId, canWrite, blockedReason, refreshKey, show }: Options): {
  button: (m: DayMarkInput) => ReactNode
  note: (residentId: number, rec: MarkRecord | null, name: string) => ReactNode
  /** その方・その日の、その種類の生きている印の記録（元の記録が無くなった印を〔外す〕ため。無ければ null） */
  liveRecord: (residentId: number, kind: MarkKind) => MarkRecord | null
  /** その記録の印の様子（live＝付いている・pending＝この端末の送信待ち・止まり／null＝無い）。行の小さな印に使う */
  markState: (residentId: number, rec: MarkRecord) => 'live' | 'pending' | null
  dialogs: ReactNode
} {
  /** 読めた印（day＝読んだ日。違う日の分は使わない） */
  const [marks, setMarks] = useState<{ day: string; rows: DaycareNoteMarkRow[] } | null>(null)
  const marksRef = useRef(marks)
  marksRef.current = marks
  const [loadFailed, setLoadFailed] = useState(false)
  const [role, setRole] = useState<MyRole | null | undefined>(cachedMyRole())
  const [msgs, setMsgs] = useState<Record<string, Msg>>({})
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  /** 送っている最中の記録（描画を待たずに止める＝続けて2回押しても2件にしない） */
  const busyRef = useRef(new Set<string>())
  const [, setTick] = useState(0)
  const [now, setNow] = useState(Date.now())
  /** 〔外す〕の確認（rid・d＝押した時の人・日。日が替わったら閉じる） */
  const [delRow, setDelRow] = useState<{ rid: number; d: string; rec: MarkRecord; row: DaycareNoteMarkRow; name: string } | null>(null)
  const genRef = useRef(0)
  /** 画面に入れた読み込みの番号（これより古い読み込みは入れない） */
  const appliedRef = useRef(0)
  const dayRef = useRef(day)
  dayRef.current = day
  /** いまの記録者（〔元に戻す〕は送った時の関数で走るので、押した時の値を ref から読む） */
  const actorRef = useRef(actorId)
  actorRef.current = actorId

  /**
   * その日の印を読む（読めた行を返す。読めなければ null）。画面に入れるのは表示中の日の読み込みで、入れた読み込みより新しい時だけ
   * （行き違った古い読み込みで新しい印を消さない。日を替えた後に届いた前の日の送信の読み直しで、表示中の日の印を外さない）
   */
  const load = useCallback(async (d: string): Promise<DaycareNoteMarkRow[] | null> => {
    const gen = ++genRef.current
    try {
      const all = await fetchDaycareDayNotes(d)
      const head = markDayAllPrefix(d)
      const rows: DaycareNoteMarkRow[] = []
      for (const r of all) if (r.clientKey !== null && r.clientKey.startsWith(head)) rows.push({ note: r.note, clientKey: r.clientKey, deleted: r.deleted })
      if (d === dayRef.current && gen > appliedRef.current) {
        appliedRef.current = gen
        setMarks({ day: d, rows })
        setLoadFailed(false)
      }
      return rows
    } catch {
      if (d === dayRef.current && gen > appliedRef.current) setLoadFailed(true)
      return null
    }
  }, [])

  useEffect(() => {
    setMsgs({})
    setDelRow(null)
    void load(day)
  }, [day, refreshKey, load])

  // 送信待ちの減り（届いた）で読み直す（端末の中の知らせ・Realtime の購読ではない）。ロックの時刻の見直し（1分ごと）
  useEffect(() => {
    let timer: number | null = null
    let last = queuePending()
    const offQ = queueSubscribe((n) => {
      setTick((x) => x + 1)
      if (n < last) {
        if (timer !== null) window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          timer = null
          void load(dayRef.current)
        }, 400)
      }
      last = n
    })
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => {
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

  const rows = marks !== null && marks.day === day ? marks.rows : null
  // その日の全員の送信待ちの印の登録（描画ごとに1回だけ読む）
  const pendAll = pendingDaycareNoteMarks(markDayAllPrefix(day))
  const lockedForMe = lockState(day, 'daycare', false, now).locked && !canUnlockNotes(role)
  const keyOf = (rid: number, d: string, rec: MarkRecord) => `${rid}:${d}:${markPrefix(d, rid, rec)}`
  const say = (k: string, m: Msg | null) =>
    setMsgs((prev) => {
      const next = { ...prev }
      if (m === null) delete next[k]
      else next[k] = m
      return next
    })
  const setBusyKey = (k: string, on: boolean) => {
    if (on) busyRef.current.add(k)
    else busyRef.current.delete(k)
    setBusy(new Set(busyRef.current))
  }
  /** 付け外しの前の確かめ（理由の文。null＝できる） */
  const precheck = (): string | null => {
    if (!canWrite) return blockedReason ?? '入力できない状態です。'
    if (actorRef.current === null) return MSG_NO_RECORDER
    if (lockedForMe) return MSG_LOCKED_FIELD
    return null
  }

  /** その記録の生きている印（世代の新しい順・同じ世代は後に作った順）。2台で同時に付けた時は2件ありうる */
  const livesOf = (rid: number, rec: MarkRecord): DaycareNoteMarkRow[] => {
    if (rows === null) return []
    const prefix = markPrefix(day, rid, rec)
    return rows.filter((r) => !r.deleted && r.clientKey.startsWith(prefix)).sort((a, b) => genOf(b) - genOf(a) || b.note.id - a.note.id)
  }

  /** 〔外す〕・〔元に戻す〕: その申し送りを取り消す（見た行のままの時だけ・F09）。rid・d は押した時の人・日 */
  const sendRemove = async (rid: number, d: string, rec: MarkRecord, row: DaycareNoteMarkRow, name: string) => {
    setDelRow(null)
    const k = keyOf(rid, d, rec)
    const why = precheck()
    if (why !== null) {
      say(k, { tone: 'warn', text: why })
      return
    }
    if (busyRef.current.has(k)) return
    setBusyKey(k, true)
    try {
      const res = await deleteNote({ id: row.note.id }, row.note, { meta: noteMetaOf(row.note), editedBy: actorRef.current })
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
      await load(d)
      if (dayRef.current === d) show(`${name}さんの申し送りの印を外しました（申し送りを取り消しました）`)
    } catch (e) {
      say(k, { tone: 'danger', text: errText(e, '外せませんでした。通信状態を確認して、もう一度押してください。') })
    } finally {
      setBusyKey(k, false)
    }
  }

  /** 「⚐ 申し送り」: 送る直前に読み直して世代を決め、区分「デイ」の申し送りを1件作る（送り先は押した時の人・日） */
  const sendAdd = async (rid: number, d: string, rec: MarkRecord, text: string, name: string) => {
    const k = keyOf(rid, d, rec)
    const why = precheck()
    if (why !== null) {
      say(k, { tone: 'warn', text: why })
      return
    }
    if (busyRef.current.has(k)) return
    setBusyKey(k, true)
    try {
      const prefix = markPrefix(d, rid, rec)
      const fresh = await load(d)
      // 読み直せない時は、同じ日に前に読めた印があればそれで数える。一度も読めていなければ付けない
      const prev = marksRef.current
      const known = fresh ?? (prev !== null && prev.day === d ? prev.rows : null)
      if (known === null) {
        say(k, { tone: 'warn', text: MSG_NOT_READ })
        return
      }
      // 読み直したら、その記録にもう生きている印がある（別の端末が先に申し送りにした）: 2件目を作らない
      if (known.some((r) => !r.deleted && r.clientKey.startsWith(prefix))) {
        say(k, { tone: 'info', text: '別の端末が先に申し送りにしていました（申し送りは1件のままです）。' })
        return
      }
      const keys = [...known.map((r) => r.clientKey), ...pendingDaycareNoteMarks(markDayPrefix(d, rid)).map((p) => p.clientKey)]
      const gen = nextGen(prefix, keys)
      // 送るたびの印: 別の端末・取り消した申し送りの鍵に当たらない（当たると先の行が「届いた」として返り、黙って消える）
      const token = Math.random().toString(36).slice(2, 10) || '0'
      const body = markBody(text, '')
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
        reporter_id: actorRef.current,
        color: null,
        // 「16時以降」は日勤だけの区切り（NoteFormPage の noteAfter16）。デイの申し送りには付かない
        after16: false,
        ...(markCategories(rec.kind).length > 0 ? { categories: markCategories(rec.kind) } : {}),
      }
      const clientKey = markKey(d, rid, rec, gen, token)
      const res = await insertNote(payload, { clientKey })
      if (res === 'queued') {
        // 送信待ちの間は〔元に戻す〕を出さない（送れたら出す＝仕様）。印は「⚑ 申し送り ↻」（送信待ち）で出す
        setTick((x) => x + 1)
        say(k, { tone: isQueuePersisted() ? 'info' : 'danger', text: `申し送り：${queuedText()}`, queued: true })
        return
      }
      say(k, null)
      await load(d)
      if (dayRef.current === d) {
        const landed: DaycareNoteMarkRow = { note: res, clientKey, deleted: false }
        show(`${name}さんの${MARK_KIND_LABEL[rec.kind]}を申し送りにしました`, () => void sendRemove(rid, d, rec, landed, name))
      }
    } catch (e) {
      say(k, { tone: 'danger', text: errText(e, '申し送りにできませんでした。通信状態を確認して、もう一度押してください。') })
    } finally {
      setBusyKey(k, false)
    }
  }

  // 押す所は 44px・文字は 15px（text-sm）。旗の記号と文字で示す（色だけに頼らない）。付けた印は注意の淡地＋塗りの旗＋太字
  const offCls =
    'inline-flex min-h-tap items-center whitespace-nowrap rounded border border-border-strong bg-surface px-2 text-sm text-ink disabled:text-ink3'
  const onCls = 'inline-flex min-h-tap items-center whitespace-nowrap rounded border-2 border-warn bg-warn-bg px-2 text-sm font-bold text-ink'
  const toneCls: Record<Msg['tone'], string> = {
    info: 'border-primary bg-surface',
    warn: 'border-warn bg-warn-bg',
    danger: 'border-danger bg-danger-bg',
  }

  const button = ({ residentId: rid, name, rec, text, why, onLabel = '申し送り' }: DayMarkInput): ReactNode => {
    const what = rec === null ? '記録' : MARK_KIND_LABEL[rec.kind]
    const k = rec === null ? null : keyOf(rid, day, rec)
    const isBusy = k !== null && busy.has(k)
    const lives = rec === null ? [] : livesOf(rid, rec)
    const live = lives[0] ?? null
    const pend = rec === null ? null : (pendAll.find((p) => p.clientKey.startsWith(markPrefix(day, rid, rec))) ?? null)
    const pendDel = live === null ? null : pendingNoteRow({ id: live.note.id })
    const removing = pendDel !== null && Object.prototype.hasOwnProperty.call(pendDel.values, 'deleted_at')
    if (rec !== null && live !== null) {
      // 付けた印（もう一度押すと〔外す〕の確認）。外す操作が送信待ち・止まった時は押せない（行の下に知らせる）
      const stopped = pendDel !== null && pendDel.state !== 'pending'
      const label = `${name}さんの${what}は申し送り済み${lives.length > 1 ? `（${lives.length}件）` : ''}（「${live.note.body}」）。${
        removing ? (stopped ? '外す操作が止まっています' : '外す操作は送信待ちです') : isBusy ? '送信中です' : '押すと印を外します（確認があります）'
      }`
      return (
        <button
          type="button"
          aria-pressed="true"
          disabled={isBusy || removing}
          onClick={() => setDelRow({ rid, d: day, rec, row: live, name })}
          title={label}
          aria-label={label}
          className={onCls}
        >
          <span aria-hidden="true">⚑ </span>
          {onLabel}
          {lives.length > 1 ? <span className="font-num"> {lives.length}</span> : null}
          {removing || isBusy ? <span aria-hidden="true">{stopped ? ' ▲' : ' ↻'}</span> : null}
        </button>
      )
    }
    if (rec !== null && pend !== null) {
      // この端末の送信待ちの印（届くまで押せない。止まった時は行の下に知らせる）
      const label =
        pend.state === 'pending'
          ? `${name}さんの${what}の申し送りは送信待ちです（電波が戻ると自動で送信します）`
          : `${name}さんの${what}の申し送りは止まっています（行の下の文を見てください）`
      return (
        <button type="button" aria-pressed="true" disabled title={label} aria-label={label} className={`${onCls} disabled:opacity-100`}>
          <span aria-hidden="true">⚑ </span>
          {onLabel}
          <span aria-hidden="true">{pend.state === 'pending' ? ' ↻' : ' ▲'}</span>
        </button>
      )
    }
    // まだ印の無い記録: 記録が無い・読めない・印を読めていない時は押せない（理由を title と読み上げで）
    const off = why ?? (rec === null || text === null ? `${what}が無いため、申し送りにできません。` : rows === null ? (loadFailed ? MSG_NOT_READ : MSG_LOADING) : null)
    const label = off !== null ? `${name}さんの${what}を申し送りにできません。${off}` : `${name}さんの${what}を申し送りにする（「${text}」）`
    return (
      <button
        type="button"
        aria-pressed="false"
        disabled={off !== null || isBusy}
        onClick={() => {
          if (off === null && rec !== null && text !== null) void sendAdd(rid, day, rec, text, name)
        }}
        title={label}
        aria-label={isBusy ? `${name}さんの${what}を申し送りにしています（送信中）` : label}
        className={offCls}
      >
        <span aria-hidden="true">⚐ </span>申し送り
        {isBusy ? <span aria-hidden="true"> ↻</span> : null}
      </button>
    )
  }

  /** 行の下の知らせ（送れなかった理由・送信待ちにした旨・止まった印）。無ければ null */
  const note = (rid: number, rec: MarkRecord | null, name: string): ReactNode => {
    const items: { key: string; tone: Msg['tone'] | 'stop'; text: string }[] = []
    const prefix = rec === null ? null : markPrefix(day, rid, rec)
    const pend = prefix === null ? null : (pendAll.find((p) => p.clientKey.startsWith(prefix)) ?? null)
    const head = `${rid}:${day}:`
    for (const [k, m] of Object.entries(msgs)) {
      if (!k.startsWith(head)) continue
      // 送信待ちにした旨は、その記録の送信待ちが無くなったら（届いた・止まった）出さない
      if (m.queued === true && (pend === null || pend.state !== 'pending')) continue
      items.push({ key: k, tone: m.tone, text: m.text })
    }
    if (pend !== null && pend.state !== 'pending') items.push({ key: 'stop-add', tone: 'stop', text: pend.locked ? MSG_STOPPED_ADD_LOCKED : MSG_STOPPED_ADD })
    const live = rec === null ? null : (livesOf(rid, rec)[0] ?? null)
    const pendDel = live === null ? null : pendingNoteRow({ id: live.note.id })
    if (pendDel !== null && pendDel.state !== 'pending') items.push({ key: 'stop-edit', tone: 'stop', text: MSG_STOPPED_EDIT })
    if (items.length === 0) return null
    return (
      <>
        {items.map((it) =>
          it.tone === 'stop' ? (
            <p key={it.key} role="alert" className="rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
              <span aria-hidden="true">▲ </span>
              <span className="sr-only">{name}さん：</span>
              {it.text}
            </p>
          ) : (
            <p key={it.key} role="status" className={`rounded border p-2 text-sm text-ink ${toneCls[it.tone]}`}>
              <span aria-hidden="true">{it.tone === 'info' ? 'ⓘ ' : '⚠ '}</span>
              <span className="sr-only">{name}さん：</span>
              {it.text}
            </p>
          ),
        )}
      </>
    )
  }

  const liveRecord = (rid: number, kind: MarkKind): MarkRecord | null => {
    if (rows === null) return null
    const head = markDayPrefix(day, rid)
    const found = rows
      .filter((r) => !r.deleted && r.clientKey.startsWith(head))
      .sort((a, b) => genOf(b) - genOf(a) || b.note.id - a.note.id)
      .map((r) => {
        const p = parseMarkKey(r.clientKey)
        return p === null ? null : markRecordOf(p.what)
      })
      .find((r) => r !== null && r.kind === kind)
    return found ?? null
  }

  const markState = (rid: number, rec: MarkRecord): 'live' | 'pending' | null => {
    if (livesOf(rid, rec).length > 0) return 'live'
    const prefix = markPrefix(day, rid, rec)
    return pendAll.some((p) => p.clientKey.startsWith(prefix)) ? 'pending' : null
  }

  const dialogs = (
    <ConfirmDialog
      open={delRow !== null}
      title="申し送りの印を外しますか"
      body={delRow === null ? '' : `${delRow.name}さんの申し送り「${delRow.row.note.body}」を取り消します。`}
      confirmLabel="外す"
      danger
      onConfirm={() => delRow !== null && void sendRemove(delRow.rid, delRow.d, delRow.rec, delRow.row, delRow.name)}
      onCancel={() => setDelRow(null)}
    />
  )

  return { button, note, liveRecord, markState, dialogs }
}
