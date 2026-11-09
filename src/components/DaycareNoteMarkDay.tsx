// デイ（せせらぎ）計画D（2026-11-10）: 一括の画面の行の「⚐ 申し送り」（ワンタップ）。改善計画 v1 §3 の D・DESIGN §4(9)。
//
// ・押すと1タップで、その行の記録から文を組み立てた区分「デイ」の申し送りを1件作る（小窓・ひと言なし＝文は markBody(記録の文, '')）。
//   送れたら「⚑ 申し送り」（注意の淡地＋塗りの旗＋文字）に変わり、〔元に戻す〕の知らせ（8秒・画面の useToast）。〔元に戻す〕は〔外す〕と同じ deleteNote
// ・「⚑ 申し送り」をもう一度押すと〔外す〕の確認（1人の画面と同じ確認の小窓）
// ・付いている印の本文が、いまの記録の文（同じ組み立て）と違う時は「⚑ 申し送り ⓘ」（1人の画面の「記録と違う」と同じ記号・isStale）。行の下の
//   知らせに〔申し送りを直す〕（確認の小窓のあと saveNoteEdits で本文をいまの文に直す。ひと言は1人の画面と同じ fixProposal で引き継ぐ）。
//   ひと言を足す・全文を手で直すのは1人の画面の〔申し送りを直す〕（今のまま）
// ・書き込みは既存の insertNote（冪等キー dcn:<日>:<利用者id>:<記録>:<世代>-<送るたびの印>・鍵の作りは daycareNoteMark.ts）・deleteNote・
//   saveNoteEdits だけ。送る直前に読み直して世代を決め、生きている印があれば2件目を作らない（1人の画面の部品 DaycareNoteMark.tsx と同じ手順）。
//   機能訓練は1人1日1件として扱う（markFamilyPrefix: 記録を入れ直して id が替わっても、生きている tr＊ の印があれば作らない＝反証 中3）
// ・17時のロック（0033）・送信待ち・止まった時・記録者の扱いは1人の画面と同じ（現場のログインは記録日の 17:00 から付け外し・直しができない）
// ・送れた・外した・直した行は、読み直しが失敗しても画面の印に持つ（⚐ に戻して2件目を作れる状態にしない＝反証 軽1）
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
  saveNoteEdits,
  subscribeMyRole,
} from '../lib/db'
import type { CellSaveResult, DaycareNoteMarkRow, MyRole, NoteMeta, Queued } from '../lib/db'
import {
  MARK_KIND_LABEL,
  fixProposal,
  isStale,
  markBody,
  markCategories,
  markDayAllPrefix,
  markDayPrefix,
  markFamilyPrefix,
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
/** 1人の画面の「記録と違う」と同じ文（読み上げも同じ） */
const MSG_STALE = '申し送りの文が、いまの記録と違います（申し送りは前の内容のまま。元の記録か申し送りが直されました）。'
const MSG_STALE_GONE = '申し送りの文が、いまの記録と違います（元の記録が無くなりました。申し送りは前の内容のまま）。'

/** 行の下に出す一言。queued＝送信待ちにした旨（その記録の送信待ちが無くなったら出さない） */
type Msg = { tone: 'info' | 'warn' | 'danger'; text: string; queued?: true }
/** 知らせの1件（stop＝止まった印・stale＝記録と違う） */
type Item = { key: string; tone: Msg['tone'] | 'stop' | 'stale'; text: string }

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
  /** 記録が無い・読めない・送っていない変更がある時の理由（押せない。title と読み上げに出す） */
  why: string | null
  /** いまの記録の中身が分かるか（読めていない時は false＝「記録と違う」を出さない）。既定は true */
  known?: boolean
  /** 付けた印の文字（既定は「申し送り」。バイタル・食事のテンキーは「申し送り済み」） */
  onLabel?: string
  /**
   * 渡すと、押せない時も disabled にせず aria-disabled にし、押した時に理由をこの関数へ渡す（バイタル・食事のテンキー＝テンキーの1行に出す・反証 軽5）
   */
  onBlocked?: (reason: string) => void
  /** ボタンの幅（状態が変わっても幅を変えない時。例: テンキーの見出しの段） */
  widthCls?: string
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
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/**
 * その日の全員の申し送りの印（一括の画面）。button(行) を各行に置き、note(行) を行の下の知らせの行に、dialogs を画面に1回置く
 */
export function useDaycareNoteMarksDay({ day, actorId, canWrite, blockedReason, refreshKey, show }: Options): {
  button: (m: DayMarkInput) => ReactNode
  /** 行の下の知らせ（送れなかった理由・送信待ちにした旨・止まった印・記録と違う＋〔申し送りを直す〕）。無ければ null */
  note: (residentId: number, rec: MarkRecord | null, name: string, text: string | null, known?: boolean) => ReactNode
  /** テンキーの1行に出す知らせ（送れなかった理由・送信待ちにした旨・止まった印。記録と違うは出さない）。無ければ null */
  messageOf: (residentId: number, rec: MarkRecord) => string | null
  /** その方・その日の、その種類の印（生きている印か、この端末の送信待ちの印）の記録（元の記録が無くなった・入れ直した印を出すため。無ければ null） */
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
  /** 〔申し送りを直す〕の確認（full＝直した後の本文） */
  const [fixRow, setFixRow] = useState<{ rid: number; d: string; rec: MarkRecord; row: DaycareNoteMarkRow; name: string; full: string } | null>(null)
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

  /**
   * 書けた行を画面の印に入れる（読み直しが失敗しても持つ＝反証 軽1）。それより前に始めた読み込みは入れない（書けた行を古い読み込みで消さない）
   */
  const keepRow = (d: string, row: DaycareNoteMarkRow) => {
    appliedRef.current = genRef.current
    setMarks((prev) => (prev !== null && prev.day === d ? { day: d, rows: [...prev.rows.filter((r) => r.note.id !== row.note.id), row] } : prev))
  }

  useEffect(() => {
    setMsgs({})
    setDelRow(null)
    setFixRow(null)
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
  /** 付け外し・直しの前の確かめ（理由の文。null＝できる） */
  const precheck = (): string | null => {
    if (!canWrite) return blockedReason ?? '入力できない状態です。'
    if (actorRef.current === null) return MSG_NO_RECORDER
    if (lockedForMe) return MSG_LOCKED_FIELD
    return null
  }

  /** その記録の生きている印（世代の新しい順・同じ世代は後に作った順）。2台で同時に付けた時は2件ありうる。機能訓練は tr＊ をまとめて見る */
  const livesOf = (rid: number, rec: MarkRecord): DaycareNoteMarkRow[] => {
    if (rows === null) return []
    const prefix = markFamilyPrefix(day, rid, rec)
    return rows.filter((r) => !r.deleted && r.clientKey.startsWith(prefix)).sort((a, b) => genOf(b) - genOf(a) || b.note.id - a.note.id)
  }
  /** その記録のこの端末の送信待ちの印の登録（機能訓練は tr＊ をまとめて見る） */
  const pendOf = (rid: number, rec: MarkRecord) => pendAll.find((p) => p.clientKey.startsWith(markFamilyPrefix(day, rid, rec))) ?? null

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
        // 届いたら出さない（反証 軽3）
        say(k, { tone: isQueuePersisted() ? 'info' : 'danger', text: `印を外す：${queuedText()}`, queued: true })
        return
      }
      if (!noteDeleted(res)) {
        say(k, { tone: 'warn', text: MSG_HELD })
        return
      }
      say(k, null)
      keepRow(d, { ...row, deleted: true })
      await load(d)
      if (dayRef.current === d) show(`${name}さんの申し送りの印を外しました（申し送りを取り消しました）`)
    } catch (e) {
      say(k, { tone: 'danger', text: errText(e, '外せませんでした。通信状態を確認して、もう一度押してください。') })
    } finally {
      setBusyKey(k, false)
    }
  }

  /** 〔申し送りを直す〕: 確認した全文で本文を直す（基準は見た本文＝1人の画面と同じ書き方）。rid・d は押した時の人・日 */
  const sendFix = async (rid: number, d: string, rec: MarkRecord, row: DaycareNoteMarkRow, full: string, name: string) => {
    setFixRow(null)
    const k = keyOf(rid, d, rec)
    const why = precheck()
    if (why !== null) {
      say(k, { tone: 'warn', text: why })
      return
    }
    if (busyRef.current.has(k)) return
    setBusyKey(k, true)
    try {
      const res: CellSaveResult<Note> | Queued = await saveNoteEdits(
        { id: row.note.id },
        { body: { value: full.trim(), base: row.note.body } },
        { meta: noteMetaOf(row.note), editedBy: actorRef.current },
      )
      if (res === 'queued') {
        setTick((x) => x + 1)
        say(k, { tone: isQueuePersisted() ? 'info' : 'danger', text: `申し送りを直す：${queuedText()}`, queued: true })
        return
      }
      if (res.conflicts.length > 0 || res.held === true) {
        say(k, { tone: 'warn', text: MSG_HELD })
        return
      }
      say(k, null)
      keepRow(d, { ...row, note: res.row ?? { ...row.note, body: full.trim() } })
      await load(d)
      if (dayRef.current === d) show(`${name}さんの申し送りを直しました`)
    } catch (e) {
      say(k, { tone: 'danger', text: errText(e, '直せませんでした。通信状態を確認して、もう一度押してください。') })
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
      const family = markFamilyPrefix(d, rid, rec)
      const fresh = await load(d)
      // 読み直せない時は、同じ日に前に読めた印があればそれで数える。一度も読めていなければ付けない
      const prev = marksRef.current
      const known = fresh ?? (prev !== null && prev.day === d ? prev.rows : null)
      if (known === null) {
        say(k, { tone: 'warn', text: MSG_NOT_READ })
        return
      }
      // 読み直したら、その記録にもう生きている印・送信待ちの印がある（別の端末が先に申し送りにした・機能訓練は入れ直した記録の印）: 2件目を作らない
      if (known.some((r) => !r.deleted && r.clientKey.startsWith(family)) || pendingDaycareNoteMarks(family).length > 0) {
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
      const landed: DaycareNoteMarkRow = { note: res, clientKey, deleted: false }
      // 送れた行は読み直しが失敗しても印として持つ（⚐ に戻して2件目を作れる状態にしない＝反証 軽1）
      keepRow(d, landed)
      await load(d)
      if (dayRef.current === d) {
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
    'inline-flex min-h-tap items-center whitespace-nowrap rounded border border-border-strong bg-surface px-2 text-sm text-ink disabled:text-ink3 aria-disabled:text-ink3'
  const onCls = 'inline-flex min-h-tap items-center whitespace-nowrap rounded border-2 border-warn bg-warn-bg px-2 text-sm font-bold text-ink'
  const toneCls: Record<Msg['tone'], string> = {
    info: 'border-primary bg-surface',
    warn: 'border-warn bg-warn-bg',
    danger: 'border-danger bg-danger-bg',
  }

  /**
   * 押せない時の出し方。onBlocked が無い時は disabled（理由は title と読み上げ）。ある時は disabled にせず aria-disabled にし、押すと理由を渡す
   */
  const blockProps = (reason: string | null, onBlocked: ((r: string) => void) | undefined, onPress: () => void) =>
    reason === null
      ? { onClick: onPress }
      : onBlocked === undefined
        ? { disabled: true }
        : { 'aria-disabled': true as const, onClick: () => onBlocked(reason) }

  const button = ({ residentId: rid, name, rec, text, why, known = true, onLabel = '申し送り', onBlocked, widthCls = '' }: DayMarkInput): ReactNode => {
    const what = rec === null ? '記録' : MARK_KIND_LABEL[rec.kind]
    const k = rec === null ? null : keyOf(rid, day, rec)
    const isBusy = k !== null && busy.has(k)
    const lives = rec === null ? [] : livesOf(rid, rec)
    const live = lives[0] ?? null
    const pend = rec === null ? null : pendOf(rid, rec)
    const pendDel = live === null ? null : pendingNoteRow({ id: live.note.id })
    const removing = pendDel !== null && hasOwn(pendDel.values, 'deleted_at')
    const w = widthCls === '' ? '' : ` ${widthCls}`
    if (rec !== null && live !== null) {
      // 付けた印（もう一度押すと〔外す〕の確認）。外す操作が送信待ち・止まった時・付け外しできない時（17時のロック・記録者なし 等）は押せない（反証 軽2）
      const stopped = pendDel !== null && pendDel.state !== 'pending'
      const stale = known && isStale(live.note.body, text)
      const blocked = precheck()
      const reason = removing ? (stopped ? '外す操作が止まっています（行の下の文を見てください）。' : '外す操作は送信待ちです。') : isBusy ? '送信中です。' : blocked
      const label = `${name}さんの${what}は申し送り済み${lives.length > 1 ? `（${lives.length}件）` : ''}（「${live.note.body}」）。${stale ? `${text === null ? MSG_STALE_GONE : MSG_STALE}` : ''}${
        reason !== null ? `押せません。${reason}` : '押すと印を外します（確認があります）'
      }`
      return (
        <button
          type="button"
          aria-pressed="true"
          {...blockProps(reason, onBlocked, () => setDelRow({ rid, d: day, rec, row: live, name }))}
          title={label}
          aria-label={label}
          className={`${onCls}${w}`}
        >
          <span aria-hidden="true">⚑ </span>
          {onLabel}
          {lives.length > 1 ? <span className="font-num"> {lives.length}</span> : null}
          {stale ? <span aria-hidden="true"> ⓘ</span> : null}
          {removing || isBusy ? <span aria-hidden="true">{stopped ? ' ▲' : ' ↻'}</span> : null}
        </button>
      )
    }
    if (rec !== null && pend !== null) {
      // この端末の送信待ちの印（届くまで押せない。止まった時は行の下に知らせる）
      const reason =
        pend.state === 'pending'
          ? `${what}の申し送りは送信待ちです（電波が戻ると自動で送信します）。`
          : `${what}の申し送りは止まっています（行の下の文を見てください）。`
      const label = `${name}さんの${reason}`
      return (
        <button
          type="button"
          aria-pressed="true"
          {...blockProps(reason, onBlocked, () => {})}
          title={label}
          aria-label={label}
          className={`${onCls} disabled:opacity-100${w}`}
        >
          <span aria-hidden="true">⚑ </span>
          {onLabel}
          <span aria-hidden="true">{pend.state === 'pending' ? ' ↻' : ' ▲'}</span>
        </button>
      )
    }
    // まだ印の無い記録: 記録が無い・読めない・送っていない変更がある・印を読めていない時は押せない（理由を title と読み上げで）
    const off =
      why ??
      (rec === null || text === null ? `${what}が無いため、申し送りにできません。` : rows === null ? (loadFailed ? MSG_NOT_READ : MSG_LOADING) : isBusy ? '送信中です。' : null)
    const label = off !== null ? `${name}さんの${what}を申し送りにできません。${off}` : `${name}さんの${what}を申し送りにする（「${text}」）`
    return (
      <button
        type="button"
        aria-pressed="false"
        {...blockProps(off, onBlocked, () => {
          if (rec !== null && text !== null) void sendAdd(rid, day, rec, text, name)
        })}
        title={label}
        aria-label={isBusy ? `${name}さんの${what}を申し送りにしています（送信中）` : label}
        className={`${offCls}${w}`}
      >
        <span aria-hidden="true">⚐ </span>申し送り
        {isBusy ? <span aria-hidden="true"> ↻</span> : null}
      </button>
    )
  }

  /** その記録の知らせ（送れなかった理由・送信待ちにした旨・止まった印・記録と違う） */
  const itemsOf = (rid: number, rec: MarkRecord | null, text: string | null, known: boolean): { items: Item[]; live: DaycareNoteMarkRow | null } => {
    const items: Item[] = []
    const pend = rec === null ? null : pendOf(rid, rec)
    const live = rec === null ? null : (livesOf(rid, rec)[0] ?? null)
    const pendDel = live === null ? null : pendingNoteRow({ id: live.note.id })
    // 送信待ちにした旨は、その記録の送信待ち（登録・外す・直す）が無くなったら（届いた・止まった）出さない（反証 軽3）
    const stillQueued = (pend !== null && pend.state === 'pending') || (pendDel !== null && pendDel.state === 'pending')
    const head = `${rid}:${day}:`
    for (const [k, m] of Object.entries(msgs)) {
      if (!k.startsWith(head)) continue
      if (m.queued === true && !stillQueued) continue
      items.push({ key: k, tone: m.tone, text: m.text })
    }
    if (pend !== null && pend.state !== 'pending') items.push({ key: 'stop-add', tone: 'stop', text: pend.locked ? MSG_STOPPED_ADD_LOCKED : MSG_STOPPED_ADD })
    if (pendDel !== null && pendDel.state !== 'pending') items.push({ key: 'stop-edit', tone: 'stop', text: MSG_STOPPED_EDIT })
    if (live !== null && known && isStale(live.note.body, text)) items.push({ key: 'stale', tone: 'stale', text: text === null ? MSG_STALE_GONE : MSG_STALE })
    return { items, live }
  }

  const note = (rid: number, rec: MarkRecord | null, name: string, text: string | null, known = true): ReactNode => {
    const { items, live } = itemsOf(rid, rec, text, known)
    if (items.length === 0) return null
    const k = rec === null ? null : keyOf(rid, day, rec)
    const removing = live !== null && (() => {
      const p = pendingNoteRow({ id: live.note.id })
      return p !== null && hasOwn(p.values, 'deleted_at')
    })()
    const blocked = precheck()
    return (
      <>
        {items.map((it) =>
          it.tone === 'stale' ? (
            // 記録と違う（1人の画面と同じ文・記号）。いまの文がある時だけ〔申し送りを直す〕（確認の小窓のあと、いまの文に直す）
            <div key={it.key} role="status" className="flex flex-wrap items-center gap-gap rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
              <span>
                <span aria-hidden="true">ⓘ </span>
                <span className="sr-only">{name}さん：</span>
                {it.text}
              </span>
              {text !== null && live !== null && rec !== null ? (
                <button
                  type="button"
                  disabled={blocked !== null || removing || (k !== null && busy.has(k))}
                  title={blocked ?? undefined}
                  onClick={() => setFixRow({ rid, d: day, rec, row: live, name, full: fixProposal(live.note.body, text) })}
                  aria-label={`${name}さんの申し送りを直す（いまの記録の文にします）`}
                  className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:text-ink3"
                >
                  申し送りを直す
                </button>
              ) : null}
            </div>
          ) : it.tone === 'stop' ? (
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

  const messageOf = (rid: number, rec: MarkRecord): string | null => {
    const it = itemsOf(rid, rec, null, false).items.find((x) => x.tone !== 'stale')
    return it === undefined ? null : it.text
  }

  const liveRecord = (rid: number, kind: MarkKind): MarkRecord | null => {
    const head = markDayPrefix(day, rid)
    const recOf = (key: string) => {
      const p = parseMarkKey(key)
      const r = p === null ? null : markRecordOf(p.what)
      return r !== null && r.kind === kind ? r : null
    }
    const live = (rows ?? [])
      .filter((r) => !r.deleted && r.clientKey.startsWith(head))
      .sort((a, b) => genOf(b) - genOf(a) || b.note.id - a.note.id)
      .map((r) => recOf(r.clientKey))
      .find((r) => r !== null)
    if (live !== undefined && live !== null) return live
    // 送信待ちの印（届く前に記録を入れ直した時も、作った印で出す）
    const pend = pendAll.filter((p) => p.clientKey.startsWith(head)).map((p) => recOf(p.clientKey)).find((r) => r !== null)
    return pend ?? null
  }

  const markState = (rid: number, rec: MarkRecord): 'live' | 'pending' | null => {
    if (livesOf(rid, rec).length > 0) return 'live'
    return pendOf(rid, rec) !== null ? 'pending' : null
  }

  const dialogs = (
    <>
      <ConfirmDialog
        open={delRow !== null}
        title="申し送りの印を外しますか"
        body={delRow === null ? '' : `${delRow.name}さんの申し送り「${delRow.row.note.body}」を取り消します。`}
        confirmLabel="外す"
        danger
        onConfirm={() => delRow !== null && void sendRemove(delRow.rid, delRow.d, delRow.rec, delRow.row, delRow.name)}
        onCancel={() => setDelRow(null)}
      />
      <ConfirmDialog
        open={fixRow !== null}
        title="申し送りを直しますか"
        body={fixRow === null ? '' : `${fixRow.name}さんの申し送り「${fixRow.row.note.body}」を「${fixRow.full}」に直します（いまの記録の文）。`}
        confirmLabel="直す"
        onConfirm={() => fixRow !== null && void sendFix(fixRow.rid, fixRow.d, fixRow.rec, fixRow.row, fixRow.full, fixRow.name)}
        onCancel={() => setFixRow(null)}
      />
    </>
  )

  return { button, note, messageOf, liveRecord, markState, dialogs }
}
