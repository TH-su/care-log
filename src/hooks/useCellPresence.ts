// 他の端末が今まさに入力している欄の表示（Presence・欄単位）。
// 設計: docs/design/concurrent-entry.md §8 ／ 純関数: src/lib/presence.ts ／ 通信: db.ts joinPresence
//
// - 5画面（バイタル一覧・バイタル一括・食事一覧・食事一括・日報のバイタル欄）が同じこのフックを使う
//   （画面ごとに作り分けない）。画面は「欄に入った／離れた」を知らせ、受け取った表示用の文字を描くだけ
// - 配るのは欄に入った時・離れた時（離れて PRESENCE_RELEASE_MS 後に取り消す＝欄の移動でちらつかせない）だけ。
//   打鍵ごとには配らない。入っている間の at の配り直しは db.ts が PRESENCE_HEARTBEAT_MS ごとに行う
// - 受け取り（参加）は全端末で行う。自分から配るのは、欄に入っている時と、日報で申し送りを書いている時（idle）だけ。
//   見ているだけの端末は配らない（相手の画面に「書いています」「入力中」を出し続けない）
// - 職員を選んでいない端末（actorId=null）も参加する（相手の画面には「別の端末」と出る）
// - 表示は補助であり、保存を妨げない。接続できない時は others が空のまま（何も出さない・例外を出さない）
// - 名前は受け取った側が職員名簿で引く（配られてくるのは職員IDだけ）。名簿を読めなければ「他の職員」
// - 配るのは操作している間だけ（F22・F21・2026-10-10 本人回答）。この画面での打鍵・タップ・入力・欄に入る操作から
//   PRESENCE_IDLE_MS（3分）操作が無ければ配るのをやめる（欄・idle は持ったまま＝次の操作で配り直す。キーパッドも入力の値も
//   そのまま）。開いた直後もまだ配らない＝控えから戻しただけの書きかけで「書いています」を出さない。
//   画面を隠した時の取り消しは db.ts の joinPresence が受け持つ（参加している全部に効く）
// - 受け手の記録者（actorId）と同じ職員の別の端末は「あなたの別の端末」と出す（F26）

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchStaff, joinPresence } from '../lib/db'
import {
  cellBusyText,
  createActivityGate,
  createFocusSlot,
  indexPresence,
  PRESENCE_IDLE_MS,
  PRESENCE_RELEASE_MS,
  PRESENCE_TOUCH_HOLD_MS,
  presenceForCell,
  presenceForRow,
  presenceSummaryText,
  rowBusyText,
} from '../lib/presence'
import type { BusyText, CellTarget, PresenceCell, PresenceHere, PresenceTable, SummaryEntry } from '../lib/presence'
import type { Staff, VitalKind } from '../lib/types'

/** 画面が「この欄に入った」と知らせる形 */
export interface CellFocus {
  day: string
  residentId: number
  cell: PresenceCell
}

/** 欄を離れた時に呼ぶ関数（入った時に受け取る。入った時に配った欄そのものを取り消す） */
export type LeaveCell = () => void

export interface CellPresence {
  /** 他の端末の居場所（自分の分・古い分は除いた後。申し送りの居場所も含む） */
  others: PresenceHere[]
  /** 欄の読み上げ文など（当たる端末が無ければ null）。複数の列を1つの欄に描く時は並べて渡す */
  cellBusy: (targets: CellTarget | CellTarget[]) => BusyText | null
  /**
   * 行見出しの読み上げ（例「入力中: 職員B」）。days は画面に出している日。
   * kinds を渡すと、その種別のバイタルだけを数える（その画面に出ている種別だけ）
   */
  rowBusy: (
    table: PresenceTable,
    days: string | string[],
    residentId: number,
    kinds?: readonly VitalKind[],
  ) => string | null
  /**
   * 表の上の一行の要約（例「入力中: 職員B（利用者01 体温）」）。
   * describe は欄を画面の言葉にする（その画面に出ていない欄は null を返して除く）
   */
  summary: (describe: (p: PresenceHere & { cell: PresenceCell; residentId: number }) => string | null) => string | null
  /**
   * 欄に入った（すぐ配る）。戻り値は離れた時に呼ぶ関数で、呼ぶと PRESENCE_RELEASE_MS 後に取り消す。
   * 取り消すのは「その時に配った欄」そのもの（途中で行 id が付いても外し損ねない）。
   * 既に別の欄へ移っていれば何もしない
   */
  enter: (f: CellFocus) => LeaveCell
  /**
   * 押すだけで終わる入力（量・状態のボタン）。配って、操作が無いまま holdMs 経つと取り消す。
   * 押すたびに呼び直すと延びる。戻り値は enter と同じ（blur で呼ぶと早い方で取り消す）
   */
  touch: (f: CellFocus, holdMs?: number) => LeaveCell
  /**
   * 操作したことを知らせる（F22）。この画面の打鍵・タップ・入力はフックが自分で拾うので、普通は呼ばなくてよい
   * （画面の外の部品＝別の窓の中の操作などを数えたい時だけ呼ぶ）。PRESENCE_IDLE_MS 操作が無いと配るのをやめ、
   * 次の操作で配り直す
   */
  activity: () => void
}

/** 操作として数える出来事（この画面のどこで起きても数える。押すだけ・打つだけ・IME の変換中も） */
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'input', 'compositionupdate'] as const

export interface UseCellPresenceOptions {
  /** 記録する職員。null＝選んでいない（「別の端末」として参加する） */
  actorId: number | null
  /**
   * どの欄にも入っていない時に配る居場所（日報で申し送りを書いている時）。
   * 省略・null の間は、欄に入っていなければ配らない（受け取るだけ）
   */
  idle?: { day: string; residentId: number | null } | null
  /** 職員名簿（持っている画面は渡す。無ければ必要になった時に1回だけ取りに行く） */
  staff?: Staff[] | null
}

/** 画面の欄（照合に使う形）から「この欄に入った」の形を作る（空の区分・種別・行 id は載せない） */
export function focusOf(t: CellTarget): CellFocus {
  const cell: PresenceCell = { table: t.table, field: t.field }
  if (t.slot !== undefined) cell.slot = t.slot
  if (t.kind !== undefined) cell.kind = t.kind
  if (t.id != null) cell.id = t.id
  return { day: t.day, residentId: t.residentId, cell }
}

export function useCellPresence({ actorId, idle = null, staff = null }: UseCellPresenceOptions): CellPresence {
  const [others, setOthers] = useState<PresenceHere[]>([])
  const joinRef = useRef<ReturnType<typeof joinPresence> | null>(null)
  /** いま配っている欄と、それを配った時の印（離れる関数はこの印が同じ時だけ取り消す） */
  const slotRef = useRef(createFocusSlot<CellFocus>())
  const releaseRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const actorRef = useRef(actorId)
  actorRef.current = actorId
  const idleRef = useRef(idle)
  idleRef.current = idle
  /** 最後に配った中身（同じなら配り直さない＝打鍵や再描画で配らない） */
  const sentRef = useRef('')
  /** 最後に操作した時刻（F22。操作が無いまま PRESENCE_IDLE_MS 経ったら配らない） */
  const gateRef = useRef(createActivityGate(PRESENCE_IDLE_MS))
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * いま配るべき居場所。欄に入っていればその欄、無ければ idle、それも無ければ null（配らない）。
   * 操作が無いまま PRESENCE_IDLE_MS 経った（または開いてからまだ操作していない）間も null（F22・F21）
   */
  const metaNow = useCallback((): PresenceHere | null => {
    if (!gateRef.current.active(Date.now())) return null
    const cur = slotRef.current.current()
    const staffId = actorRef.current
    if (cur !== null) return { staffId, day: cur.day, residentId: cur.residentId, cell: { ...cur.cell } }
    const i = idleRef.current
    if (i) return { staffId, day: i.day, residentId: i.residentId }
    return null
  }, [])

  const send = useCallback(() => {
    const meta = metaNow()
    const sig = JSON.stringify(meta)
    if (sig === sentRef.current) return
    sentRef.current = sig
    joinRef.current?.update(meta)
  }, [metaNow])

  // 参加は画面にいる間ずっと1本（職員の選び直し・日の移動は update で伝える）
  useEffect(() => {
    const first = metaNow()
    sentRef.current = JSON.stringify(first)
    const p = joinPresence(first, setOthers)
    joinRef.current = p
    return () => {
      if (releaseRef.current !== null) clearTimeout(releaseRef.current)
      releaseRef.current = null
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
      slotRef.current.clear()
      gateRef.current.reset()
      joinRef.current = null
      setOthers([])
      p.stop()
    }
  }, [metaNow])

  /** 操作が切れる時刻に合わせて、配るのをやめるタイマーを張り直す（F22） */
  const armIdle = useCallback(() => {
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = null
    const due = gateRef.current.dueAt()
    if (due === null) return
    idleTimerRef.current = setTimeout(
      () => {
        idleTimerRef.current = null
        send() // 操作が切れた → 配っていれば取り消す（欄・idle は持ったまま）
      },
      Math.max(0, due - Date.now()) + 50,
    )
  }, [send])

  /** 操作を記録する。操作していない状態から戻った時は、持っている欄・idle を配り直す（F22） */
  const activity = useCallback(() => {
    const back = gateRef.current.touch(Date.now())
    armIdle()
    if (back) send()
  }, [armIdle, send])

  // この画面のどこでの打鍵・タップ・入力も「操作」として数える（キーパッドの打鍵も拾う＝画面ごとに配線しない）。
  // 画面に戻った（見えた）時も、開いたままの欄へ戻ってきたとみなして数える
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onAct = () => activity()
    const onVis = () => {
      if (document.visibilityState === 'visible') activity()
    }
    const opts: AddEventListenerOptions = { capture: true, passive: true }
    for (const ev of ACTIVITY_EVENTS) document.addEventListener(ev, onAct, opts)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      for (const ev of ACTIVITY_EVENTS) document.removeEventListener(ev, onAct, opts)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [activity])

  const idleDay = idle?.day ?? null
  const idleResident = idle?.residentId ?? null
  const idleOn = idle !== null
  useEffect(() => {
    send()
  }, [actorId, idleOn, idleDay, idleResident, send])

  /** 印 token の欄を delayMs 後に取り消す（その間に別の欄へ移っていれば何もしない） */
  const scheduleRelease = useCallback(
    (token: number, delayMs: number) => {
      if (!slotRef.current.isCurrent(token)) return
      if (releaseRef.current !== null) clearTimeout(releaseRef.current)
      releaseRef.current = setTimeout(() => {
        releaseRef.current = null
        if (slotRef.current.leave(token)) send()
      }, delayMs)
    },
    [send],
  )

  const enter = useCallback(
    (f: CellFocus): LeaveCell => {
      if (releaseRef.current !== null) clearTimeout(releaseRef.current)
      releaseRef.current = null
      const token = slotRef.current.enter(f)
      // 欄に入るのは操作そのもの（フォーカスの移動で入った時も数える）
      gateRef.current.touch(Date.now())
      armIdle()
      send()
      return () => scheduleRelease(token, PRESENCE_RELEASE_MS)
    },
    [armIdle, scheduleRelease, send],
  )

  const touch = useCallback(
    (f: CellFocus, holdMs = PRESENCE_TOUCH_HOLD_MS): LeaveCell => {
      if (releaseRef.current !== null) clearTimeout(releaseRef.current)
      releaseRef.current = null
      const token = slotRef.current.enter(f)
      gateRef.current.touch(Date.now())
      armIdle()
      send()
      scheduleRelease(token, holdMs)
      return () => scheduleRelease(token, PRESENCE_RELEASE_MS)
    },
    [armIdle, scheduleRelease, send],
  )

  // ── 名前の引き当て（配られてくるのは職員IDだけ） ──
  const [fetched, setFetched] = useState<Staff[] | null>(null)
  const askedRef = useRef(false)
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const needNames = staff === null && others.some((o) => o.staffId !== null)
  useEffect(() => {
    // 取りに行くのは画面にいる間1回だけ（相手が出入りするたびに名簿を読み直さない）
    if (!needNames || askedRef.current) return
    askedRef.current = true
    fetchStaff()
      .then((list) => {
        if (mountedRef.current) setFetched(list)
      })
      .catch(() => {
        // 名簿を読めない。名前の代わりに「他の職員」と出す
      })
  }, [needNames])

  const roster = staff ?? fetched
  const nameOf = useMemo(() => {
    const m = new Map<number, string>()
    for (const s of roster ?? []) m.set(s.id, s.name)
    return (id: number) => m.get(id) ?? null
  }, [roster])

  const index = useMemo(() => indexPresence(others), [others])

  // 受け手の記録者と同じ職員の別の端末は「あなたの別の端末」と出す（F26）
  const cellBusy = useCallback(
    (targets: CellTarget | CellTarget[]) =>
      cellBusyText(presenceForCell(index, Array.isArray(targets) ? targets : [targets]), nameOf, actorId),
    [index, nameOf, actorId],
  )

  const rowBusy = useCallback(
    (table: PresenceTable, days: string | string[], residentId: number, kinds?: readonly VitalKind[]) =>
      rowBusyText(
        presenceForRow(index, table, Array.isArray(days) ? days : [days], residentId, kinds),
        nameOf,
        actorId,
      ),
    [index, nameOf, actorId],
  )

  const summary = useCallback(
    (describe: (p: PresenceHere & { cell: PresenceCell; residentId: number }) => string | null) => {
      const entries: SummaryEntry[] = []
      for (const p of others) {
        if (!p.cell || p.residentId === null) continue
        const what = describe(p as PresenceHere & { cell: PresenceCell; residentId: number })
        if (what !== null) entries.push({ p, what })
      }
      return presenceSummaryText(entries, nameOf, undefined, actorId)
    },
    [others, nameOf, actorId],
  )

  return useMemo(
    () => ({ others, cellBusy, rowBusy, summary, enter, touch, activity }),
    [others, cellBusy, rowBusy, summary, enter, touch, activity],
  )
}
