// デイ（せせらぎ）段階2b: 活動・レクをまとめて記録する画面（/record/daycare/bulk・?day= で業務日）。
// 2026-10-22 代表者承認・段階2の計画 v1 の 1.1（まとめて記録）／1.2（活動〔全員〕は2タップ）。
//
// ・2026-10-26（2回目・§9.3・§9.4）: バイタル一括と同じ「1行1人の表」にした。それまでの上の区画（活動を1つ選ぶチップ・
//   入れる方のチェック・〔チェックした n人に入れる〕）と下の「1人ずつの活動」の一覧は、この表が同じ役をする
// ・行: 一括の画面と同じ方（予定の方のうち休み・入院中を除く全員と予定外で来た方＝activityTargets・2026-10-24 §9.4 の4）。並びは五十音のまま
// ・列: 氏名（左に残す）｜定型の7つ（DAYCARE_ACTIVITY_CHIPS の順）｜その他（自由入力の項目を小さなボタンで並べ、末尾に〔＋〕）
// ・枠を押すたびに 無し → 参加 → 一部 → 見学 → 不参加 → 消す（nextParticipation）。消した時は確かめを挟まず、トーストの〔元に戻す〕で
//   消す前の度合いに戻す（取り消しが送信待ちの時も出す。db.ts が取り消しの後に送る＝activityDeletePending）。
//   トーストが出ている間に続けて消した分は、1つのトーストでまとめて戻す（2件目を消しても1件目を戻せる＝反証 中1）
// ・まだ来ていない方（予定のまま）の枠を押した時は「まだ到着していません。記録しますか」を挟む（その方・その日につき、この画面を開いている間に1回）
// ・列の見出しを押すと、来た方（在席・帰宅）のうち、その項目の記録の無い方にまとめて「参加」で入れる（columnFillTargets・確かめの小窓つき）。
//   まだ来ていない方・もう記録がある方は変えない（親の検収 中2 の決まりを引き継ぐ）
// ・送信待ちの重ね方・合流・食い違い・知らせの文は1人の画面の活動の欄（DaycareActivitySection）と同じ。送信待ちの追加・修正・
//   取り消しの枠は届くまで押せない。保存中の枠も押せない（前の保存の結果＝新しい rev の行の上に次を送る）
// ・保存は1人ずつ insertDaycareActivity・updateDaycareActivity・softDeleteDaycareActivity（2台で同じレクを入れても、同じ度合いなら
//   1行に合流・違えば「先に記録があります」）
// ・画面の名前は「活動一括」（2026-10-24 §9.4。それまでは「活動をまとめて」。ルートと切り替えの key は変えない）
// ・入力解禁は活動だけの旗 input_enabled_daycare_activity。表が無い DB は「設定待ち」
// ・端末に業務データを残さない（localStorage を使わない）。送り先（人・日・項目）は押した時に固定する

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  DbError,
  FORBIDDEN_REASON,
  OUTDATED_REASON,
  fetchAllResidents,
  fetchDaycareActivities,
  fetchDaycareAttendance,
  fetchDaycareDay,
  fetchDaycarePlan,
  getKindInputGate,
  insertDaycareActivity,
  isActivityMissingError,
  isQueuePersisted,
  isSelfWrite,
  kindBlockedMessage,
  pendingActivityOps,
  queuePending,
  queueSubscribe,
  softDeleteDaycareActivity,
  subscribeDaycareActivityChanges,
  subscribeDaycareChanges,
  updateDaycareActivity,
} from '../lib/db'
import type { PendingActivityOp } from '../lib/db'
import { RecorderBar } from '../components/RecorderBar'
import { ConfirmDialog, ErrorBlock, LoadingBlock, ModalShell, useToast } from '../components/ui'
import { writeDaycareHandoffFor } from '../lib/daycareHandoff'
import { buildDaycareBoard } from '../lib/daycare'
import {
  ACTIVITY_LABEL_MAX,
  ACTIVITY_PARTICIPATION_LABEL,
  DAYCARE_ACTIVITY_CHIPS,
  activityDefaultChecked,
  activityLabelError,
  activityTargets,
  bulkResultText,
  columnFillTargets,
  nextParticipation,
  normalizeActivityLabel,
  otherActivitiesOf,
} from '../lib/daycareActivity'
import type { ActivityAddOutcome, ActivityParticipation, DaycareActivity } from '../lib/daycareActivity'
import { personPath, readPersonDay } from '../lib/daycarePerson'
import { addDays, fmtDayLabel, todayIso } from '../lib/format'
import type { DaycareAttendance, DaycareDay, DaycarePlanRow, DaycarePlanSource, Resident, Staff } from '../lib/types'
import { DaycareNav } from './DaycarePage'

const ERR_LOAD = 'デイの記録を読み込めませんでした。通信状態を確認して、再試行してください。'
const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから入れてください。'
const MSG_GATE_UNKNOWN =
  'デイの活動の記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。記録の閲覧はこのままできます。'
const MSG_MISSING = 'デイの活動の記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。'
// 送信待ちの文は1人の画面の活動の欄（DaycareActivitySection）と同じ
const MSG_QUEUED = '電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度押してください。'

/** まとめて記録の画面のルート（業務日は ?day= で持つ。今日は付けない） */
export function bulkPath(day: string, today: string): string {
  return `/record/daycare/bulk${day === today ? '' : `?day=${day}`}`
}

interface BulkData {
  day: string
  planRows: DaycarePlanRow[]
  planSource: DaycarePlanSource
  attendance: DaycareAttendance[]
  /** null＝読めない（表が無い・通信エラー） */
  activities: DaycareActivity[] | null
  activityMissing: boolean
}

/** 行の下の一言（key＝`${rid}:${day}`）。queued＝送信待ちにした旨（その方・その日の送信待ちが無くなったら外す） */
type Msg = { tone: 'info' | 'warn' | 'danger'; text: string; queued?: true }
type AddOp = Extract<PendingActivityOp, { kind: 'add' }>
type UpdOp = Extract<PendingActivityOp, { kind: 'update' }>

/** 表の枠1つ（その方・その日・その項目）の様子 */
interface Cell {
  /** サーバーの行（生きている行）。無ければ null */
  row: DaycareActivity | null
  /** 枠に出す度合い（送信待ちの変更・追加を重ねた値）。null＝記録なし */
  shown: ActivityParticipation | null
  /** 送信待ち（追加・度合いの変更・取り消し）。届くまで押せない */
  waiting: boolean
  /** 取り消しの送信待ち（届くまで同じ項目は入れられない） */
  deleting: boolean
  /** 押せない（送信待ち・止まった追加だけで行が無い） */
  locked: boolean
  /** 止まった送信待ちの知らせ（▲。行の下に出す）。止まった変更と止まった追加が両方ある時は両方（1人の画面の活動の欄と同じ）。無ければ空 */
  stopped: string[]
}

/** 〔元に戻す〕で戻す1件（人・日・項目・消す前の度合いは消した時に固定する） */
interface UndoItem {
  rid: number
  day: string
  label: string
  before: ActivityParticipation
  name: string
  queued: boolean
}
/** 〔元に戻す〕のトーストが出ている長さ（ui.tsx の TOAST_UNDO_MS と同じ）。この間に続けて消した分は1つのトーストでまとめて戻す */
const UNDO_WINDOW_MS = 8000

const toneCls: Record<Msg['tone'], string> = {
  info: 'border-primary bg-surface',
  warn: 'border-warn bg-warn-bg',
  danger: 'border-danger bg-danger-bg',
}

export interface DaycareActivityBulkPageProps {
  staff?: Staff[] | null
  actorId?: number | null
}

export function DaycareActivityBulkPage({ staff = undefined, actorId = null }: DaycareActivityBulkPageProps = {}) {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const [today, setToday] = useState(todayIso())
  const day = readPersonDay(search.get('day'), today)
  const [data, setData] = useState<BulkData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [residents, setResidents] = useState<Resident[]>([])
  const [gate, setGate] = useState<{ value: boolean; observed: boolean; forbidden?: true; outdated?: true } | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ day: string; tone: 'info' | 'warn'; text: string } | null>(null)
  const [pending, setPending] = useState<PendingActivityOp[]>(() => pendingActivityOps())
  /** 保存中（応答待ち）の枠（`${day}:${rid}:${label}`）。その枠は押せない */
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [msgs, setMsgs] = useState<Map<string, Msg>>(new Map())
  /** 列の見出しの確かめの小窓（入れる項目） */
  const [fillAsk, setFillAsk] = useState<string | null>(null)
  /** まだ来ていない方の確かめの小窓（label=null は〔＋〕から） */
  const [lateAsk, setLateAsk] = useState<{ rid: number; day: string; label: string | null } | null>(null)
  /** ほかの活動を入れる小窓（rid=null は「その他」の見出しから＝まとめて入れる） */
  const [otherAsk, setOtherAsk] = useState<{ rid: number | null; day: string } | null>(null)
  const [otherText, setOtherText] = useState('')
  const otherInput = useRef<HTMLInputElement>(null)
  /** まだ来ていない方で、この画面を開いている間に記録を確かめた方（`${day}:${rid}`。画面のメモリだけ） */
  const lateOk = useRef<Set<string>>(new Set())
  /** 〔元に戻す〕のまとまり（トーストが出ている間に続けて消した分。2件目を消しても1件目を戻せるように＝反証 中1） */
  const undoBatch = useRef<{ at: number; items: UndoItem[] }>({ at: 0, items: [] })
  const { toast, show } = useToast()
  const genRef = useRef(0)
  /** いま走っている読み直しが静かな読み直し（他の端末の変更・送信待ちの減り）の時、その gen。書けた時に捨てるのに使う */
  const quietGen = useRef<number | null>(null)
  const dayRef = useRef(day)
  dayRef.current = day

  useEffect(() => {
    const t = window.setInterval(() => setToday(todayIso()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    let alive = true
    setGate(null)
    getKindInputGate('daycare_activity')
      .then((g) => alive && setGate(g))
      .catch(() => alive && setGate({ value: false, observed: false }))
    fetchAllResidents()
      .then((all) => alive && setResidents(all))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [reloadKey])

  const load = useCallback(async (target: string, quiet: boolean) => {
    const gen = ++genRef.current
    quietGen.current = quiet ? gen : null
    if (!quiet) {
      setLoading(true)
      setError(null)
    }
    try {
      let snapshot: DaycareDay | null = null
      let missing = false
      try {
        snapshot = await fetchDaycareDay(target)
      } catch (e) {
        if (e instanceof DbError && e.kind === 'server') missing = true
        else throw e
      }
      const usable = snapshot !== null && snapshot.plan_source !== 'unknown'
      let activityMissing = false
      const [plan, attendance, activities] = await Promise.all([
        usable ? Promise.resolve(null) : fetchDaycarePlan(target),
        missing ? Promise.resolve([] as DaycareAttendance[]) : fetchDaycareAttendance(target),
        fetchDaycareActivities(target).catch((e: unknown) => {
          if (isActivityMissingError(e)) activityMissing = true
          return null
        }),
      ])
      if (gen !== genRef.current || target !== dayRef.current) return
      setData({
        day: target,
        planRows: usable && snapshot !== null ? snapshot.plan_rows : (plan?.rows ?? []),
        planSource: usable && snapshot !== null ? snapshot.plan_source : (plan?.source ?? 'unknown'),
        attendance,
        activities,
        activityMissing,
      })
      setError(null)
    } catch {
      if (gen !== genRef.current) return
      if (!quiet) setError(ERR_LOAD)
    } finally {
      if (gen === genRef.current) {
        setLoading(false)
        quietGen.current = null
      }
    }
  }, [])

  // 日の切り替えと〔最新に更新〕: その場限りの一言・小窓は外して読み直す（送信待ちの重ね表示は送信待ちから出し直す）
  useEffect(() => {
    setResult(null)
    setMsgs(new Map())
    setFillAsk(null)
    setLateAsk(null)
    setOtherAsk(null)
    void load(day, false)
  }, [day, reloadKey, load])

  const reloadTimer = useRef<number | null>(null)
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null
      void load(dayRef.current, true)
    }, 400)
  }, [load])
  useEffect(() => {
    const onChange = (table: string, info?: { event: string; row: Record<string, unknown> | null }) => {
      if (info?.row && isSelfWrite(table, info.row)) return
      scheduleReload()
    }
    const offA = subscribeDaycareChanges(onChange)
    const offB = subscribeDaycareActivityChanges(onChange)
    let last = queuePending()
    const offQ = queueSubscribe((n) => {
      setPending(pendingActivityOps())
      if (n < last) scheduleReload()
      last = n
    })
    return () => {
      offA()
      offB()
      offQ()
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    }
  }, [scheduleReload])

  // 送信待ちにした旨の一言は、その方・その日の送信待ち（止まっていない分）が無くなったら外す（1人の画面の活動の欄と同じ）
  useEffect(() => {
    setMsgs((cur) => {
      let next: Map<string, Msg> | null = null
      for (const [k, m] of cur) {
        if (m.queued !== true) continue
        const [ridText, d] = k.split(':')
        const rid = Number(ridText)
        const ids = new Set((data?.activities ?? []).filter((a) => a.resident_id === rid && a.day === d).map((a) => a.id))
        const still = pending.some((p) => (p.stopped ? false : p.kind === 'add' ? p.residentId === rid && p.day === d : ids.has(p.rowId)))
        if (!still) {
          next = next ?? new Map(cur)
          next.delete(k)
        }
      }
      return next ?? cur
    })
  }, [pending, data])

  // ── 表の横スクロールの枠（バイタル一括と同じ）。表が枠より広い（横にスクロールできる）時だけ手がかりを出す ──
  const [tableBox, setTableBox] = useState<HTMLDivElement | null>(null)
  const [tableScrolls, setTableScrolls] = useState(false)
  /** 表の枠の幅（行の下の知らせを、この幅で折り返して左に残すため） */
  const [tableBoxWidth, setTableBoxWidth] = useState(0)
  useEffect(() => {
    const el = tableBox
    if (!el) return
    const check = () => {
      setTableScrolls(el.scrollWidth > el.clientWidth + 1)
      setTableBoxWidth(el.clientWidth)
    }
    check()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', check)
      return () => window.removeEventListener('resize', check)
    }
    // 枠（画面幅・文字の大きさ）と表（行の増減）の両方の大きさの変化で測り直す
    const ro = new ResizeObserver(check)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [tableBox])

  const board = useMemo(
    () => (data === null ? null : buildDaycareBoard({ planRows: data.planRows, source: data.planSource, residents, attendance: data.attendance })),
    [data, residents],
  )
  const targets = board === null ? [] : activityTargets(board.rows)
  const nameOf = (id: number) => residents.find((r) => r.id === id)?.name ?? `利用者ID ${id}`
  const missing = data?.activityMissing ?? false
  const canWrite = gate !== null && gate.observed && gate.value === true && !missing && data !== null && data.activities !== null && day <= today
  const rowOf = (rid: number) => board?.rows.find((r) => r.residentId === rid)

  // その日のサーバーの行（`${rid}\t${label}` → 行）と、この端末の送信待ちの重ね（1人の画面の活動の欄の shown を全員分に広げたもの）
  const rowsByKey = useMemo(() => {
    const m = new Map<string, DaycareActivity>()
    for (const a of data?.activities ?? []) if (a.day === day) m.set(`${a.resident_id}\t${a.label}`, a)
    return m
  }, [data, day])
  const overlay = useMemo(() => {
    const upd = new Map<number, UpdOp>()
    const stoppedUpd = new Map<number, UpdOp>()
    for (const p of pending) {
      if (p.kind !== 'update') continue
      if (p.stopped) stoppedUpd.set(p.rowId, p)
      else upd.set(p.rowId, p)
    }
    const adds = pending.filter((p): p is AddOp => p.kind === 'add' && p.day === day)
    return { upd, stoppedUpd, adds }
  }, [pending, day])

  const stoppedAddText = (label: string, p: AddOp) =>
    `「${label}」は、他の端末の記録と食い違って止まっています（この端末で押した度合い: ${ACTIVITY_PARTICIPATION_LABEL[p.participation]}）。設定の「送れていない記録」で確かめてください。`
  const stoppedUpdText = (label: string, p: UpdOp) =>
    `${
      p.deleted
        ? `「${label}」の、この端末の取り消しは、他の端末の変更と食い違って止まっています（送っていません）。`
        : `「${label}」で、この端末で押した〔${p.participation === null ? '変更' : ACTIVITY_PARTICIPATION_LABEL[p.participation]}〕は、他の端末の変更と食い違って止まっています（送っていません）。`
    }枠の度合いはサーバーの値です。設定の「送れていない記録」で確かめてください。`

  const cellOf = (rid: number, label: string): Cell => {
    const a = rowsByKey.get(`${rid}\t${label}`) ?? null
    const mine = overlay.adds.filter((p) => p.residentId === rid && p.label === label)
    const liveAdd = mine.find((p) => !p.stopped)
    const stoppedAdd = mine.find((p) => p.stopped)
    const addNote = stoppedAdd === undefined ? [] : [stoppedAddText(label, stoppedAdd)]
    if (a !== null) {
      const p = overlay.upd.get(a.id)
      const st = overlay.stoppedUpd.get(a.id)
      // 止まった度合いの変更・取り消しはサーバーの値で出して行の下で知らせる。止まった追加は、同じ項目の行がサーバーにあっても知らせる
      // （押した人が食い違いに気づけるように）。両方ある時は両方（1人の画面の活動の欄と同じ＝反証 軽8）
      const stopped = [...(st === undefined ? [] : [stoppedUpdText(label, st)]), ...addNote]
      const deleting = p?.deleted === true
      // 取り消しの送信待ちの後に〔元に戻す〕で入れ直した分は、届いた後の度合いで出す（db.ts が取り消しの後に送る）
      if (deleting && liveAdd !== undefined) return { row: a, shown: liveAdd.participation, waiting: true, deleting: false, locked: true, stopped }
      return { row: a, shown: p?.participation ?? a.participation, waiting: p !== undefined, deleting, locked: p !== undefined, stopped }
    }
    // 送信待ちの追加は、まだ載っていない項目だけ重ねる
    if (liveAdd !== undefined) {
      return { row: null, shown: liveAdd.participation, waiting: true, deleting: false, locked: true, stopped: addNote }
    }
    if (stoppedAdd !== undefined) {
      return { row: null, shown: stoppedAdd.participation, waiting: false, deleting: false, locked: true, stopped: addNote }
    }
    return { row: null, shown: null, waiting: false, deleting: false, locked: false, stopped: [] }
  }
  /** その項目の記録（送信待ちの追加・取り消しの送信待ち・保存中＝応答待ちを含む）があるか。列の見出しの一括の相手を選ぶのに使う
   *  （応答待ちの方へ一括で2回目を送らない＝反証 軽5） */
  const has = (rid: number, l: string) =>
    rowsByKey.has(`${rid}\t${l}`) || overlay.adds.some((p) => p.residentId === rid && p.label === l) || busy.has(`${day}:${rid}:${l}`)
  /** 「その他」の列に並べる項目（サーバーの行は入れた順 → まだ載っていない送信待ちの追加） */
  const otherLabelsOf = (rid: number): string[] => {
    const labels = otherActivitiesOf(data?.activities ?? [], rid, day).map((a) => a.label)
    for (const p of overlay.adds) {
      if (p.residentId === rid && !DAYCARE_ACTIVITY_CHIPS.includes(p.label) && !labels.includes(p.label)) labels.push(p.label)
    }
    return labels
  }
  const targetRows = targets.flatMap((rid) => {
    const r = rowOf(rid)
    return r === undefined ? [] : [r]
  })
  const fillTargets = (l: string) => columnFillTargets(targetRows, (rid) => has(rid, l))

  const precheck = (): string | null => {
    if (missing) return MSG_MISSING
    if (!canWrite) {
      return gate?.forbidden
        ? FORBIDDEN_REASON
        : gate?.outdated
          ? OUTDATED_REASON
          : gate?.observed
            ? kindBlockedMessage('daycare_activity')
            : MSG_GATE_UNKNOWN
    }
    if (actorId === null) return MSG_NO_RECORDER
    return null
  }

  const say = (key: string, tone: Msg['tone'], text: string, queued = false) =>
    setMsgs((cur) => new Map(cur).set(key, queued ? { tone, text, queued: true } : { tone, text }))
  const clearMsg = (key: string) =>
    setMsgs((cur) => {
      if (!cur.has(key)) return cur
      const next = new Map(cur)
      next.delete(key)
      return next
    })
  const queuedText = () => (isQueuePersisted() ? MSG_QUEUED : MSG_NOT_PERSISTED)
  const errText = (e: unknown, fallback: string) => (e instanceof DbError ? e.message : fallback)
  const setBusyKey = (k: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(k)
      else next.delete(k)
      return next
    })
  /** 書く前に始まった静かな読み直しは、書いた後に返ると書く前の行（古い rev）で上書きするので捨てて、読み直し直す（反証 軽11）。
   *  捨てるのは静かな読み直しだけ（日の切り替え・〔最新に更新〕の読み込みは捨てない） */
  const dropStaleReload = () => {
    if (quietGen.current !== null && quietGen.current === genRef.current) {
      genRef.current += 1
      quietGen.current = null
      scheduleReload()
    }
  }
  /** 書けた行を画面の行に映す（次に押した時は、この新しい rev の行の上に送る） */
  const putRow = (d: string, row: DaycareActivity) => {
    dropStaleReload()
    setData((cur) =>
      cur === null || cur.day !== d || cur.activities === null ? cur : { ...cur, activities: [...cur.activities.filter((x) => x.id !== row.id), row] },
    )
  }
  const dropRow = (d: string, id: number) => {
    dropStaleReload()
    setData((cur) => (cur === null || cur.day !== d || cur.activities === null ? cur : { ...cur, activities: cur.activities.filter((x) => x.id !== id) }))
  }

  /** 1項目を足す（送り先は押した時の人・日に固定）。fromUndo＝〔元に戻す〕（取り消しの送信待ちでも、消す前の度合いで入れ直す） */
  const add = async (rid: number, d: string, rawLabel: string, participation: ActivityParticipation, fromUndo = false): Promise<boolean> => {
    const key = `${rid}:${d}`
    const why = precheck()
    if (why !== null) {
      say(key, 'warn', why)
      return false
    }
    const label = normalizeActivityLabel(rawLabel)
    const bad = activityLabelError(label)
    if (bad !== null) {
      say(key, 'warn', bad)
      return false
    }
    // 取り消しの送信待ちの項目は、届くまで入れない（入れ直すと先の行に合流し、後から届いた取り消しで入れ直しまで消えるため＝2b の反証 中1）。
    // 〔元に戻す〕だけは入れ直す（db.ts は取り消しの送信待ちの行に合流させず、送信待ちに積んで取り消しの後に送る）
    const bk = `${d}:${rid}:${label}`
    if (!fromUndo) {
      const c = cellOf(rid, label)
      if (c.deleting) {
        say(key, 'warn', `「${label}」は取り消しの送信待ちです。取り消しが届いてから入れ直してください。`)
        return false
      }
      // 〔＋〕で、送信待ち（取り消しと〔元に戻す〕の入れ直しの両方を含む）・保存中の項目を入れると、同じ項目の追加が2つ積まれる（反証 軽7）
      if (c.locked || busy.has(bk)) {
        say(key, 'warn', `「${label}」は送信待ち・保存中です。届いてから押してください。`)
        return false
      }
    }
    setBusyKey(bk, true)
    try {
      const r = await insertDaycareActivity({ resident_id: rid, day: d, label, participation, recorded_by: actorId })
      if (r.kind === 'queued') {
        setPending(pendingActivityOps())
        say(key, isQueuePersisted() ? 'info' : 'danger', `「${label}」：${queuedText()}`, true)
        return true
      }
      if (r.kind === 'taken') {
        const was = r.row === null ? '' : `（${ACTIVITY_PARTICIPATION_LABEL[r.row.participation]}）`
        say(key, 'warn', `「${label}」は先に記録があります${was}。いまの内容に読み直しました。確かめてから、必要なら度合いを変えてください。`)
        scheduleReload()
        return false
      }
      putRow(d, r.row)
      if (r.kind === 'merged') {
        // 別の端末の記録に合流した: 〔元に戻す〕は出さない（消すと先の端末の記録が消える）
        say(key, 'info', `「${label}」は同じ記録が先にありました（1件にまとめました）。`)
        return true
      }
      clearMsg(key)
      return true
    } catch (e) {
      say(key, 'danger', errText(e, '保存できませんでした。通信状態を確認して、もう一度押してください。'))
      return false
    } finally {
      setBusyKey(bk, false)
    }
  }

  const setParticipation = async (a: DaycareActivity, p: ActivityParticipation) => {
    const key = `${a.resident_id}:${a.day}`
    const why = precheck()
    if (why !== null) {
      say(key, 'warn', why)
      return
    }
    const bk = `${a.day}:${a.resident_id}:${a.label}`
    setBusyKey(bk, true)
    try {
      const r = await updateDaycareActivity(a, { participation: p }, { editedBy: actorId })
      if (r === 'queued') {
        setPending(pendingActivityOps())
        say(key, isQueuePersisted() ? 'info' : 'danger', `「${a.label}」の度合い：${queuedText()}`, true)
      } else if (r === 'conflict') {
        say(key, 'warn', `「${a.label}」は他の端末が先に直していました。最新の内容に読み直しました。確かめてから、もう一度押してください。`)
        scheduleReload()
      } else {
        putRow(a.day, r)
        clearMsg(key)
      }
    } catch (e) {
      say(key, 'danger', errText(e, '保存できませんでした。通信状態を確認して、もう一度押してください。'))
    } finally {
      setBusyKey(bk, false)
    }
  }

  /** 〔元に戻す〕: まとめた分を消す前の度合いで入れ直す。違う日を開いている時・戻せなかった分がある時は、トーストで結果を返す
   *  （行の下の知らせは開いている日にしか見えないため＝反証 軽6） */
  const undoAll = async (items: UndoItem[]) => {
    const failed: UndoItem[] = []
    for (const it of items) {
      if (!(await add(it.rid, it.day, it.label, it.before, true))) failed.push(it)
    }
    const away = items.some((it) => it.day !== dayRef.current)
    if (failed.length > 0) {
      const f = failed[0]
      show(
        `${f.name}さんの「${f.label}」（${fmtDayLabel(f.day)}）${failed.length > 1 ? `ほか${failed.length - 1}件` : ''}を戻せませんでした。その日を開いて確かめ、もう一度入れてください。`,
      )
    } else if (away) {
      show(items.length === 1 ? `${items[0].name}さんの「${items[0].label}」（${fmtDayLabel(items[0].day)}）を戻しました` : `取り消した活動${items.length}件を戻しました`)
    }
  }
  /** 消した分を〔元に戻す〕のトーストに出す。トーストが出ている間に続けて消した分は、1つのトーストでまとめて戻す（反証 中1） */
  const offerUndo = (it: UndoItem) => {
    const now = Date.now()
    const b = undoBatch.current
    const items = now - b.at < UNDO_WINDOW_MS ? [...b.items.filter((x) => !(x.rid === it.rid && x.day === it.day && x.label === it.label)), it] : [it]
    undoBatch.current = { at: now, items }
    const waiting = items.some((x) => x.queued) ? '（送信待ちを含む）' : ''
    show(
      items.length === 1
        ? `${it.name}さんの活動「${it.label}」を取り消しました${it.queued ? '（送信待ち）' : ''}`
        : `活動を${items.length}件取り消しました${waiting}（いちばん新しい分: ${it.name}さんの「${it.label}」）。〔元に戻す〕で${items.length}件とも戻します`,
      () => {
        undoBatch.current = { at: 0, items: [] }
        void undoAll(items)
      },
    )
  }

  /** 不参加の次＝消す。確かめは挟まず、トーストの〔元に戻す〕で消す前の度合いに戻す（取り消しが送信待ちの時も出す＝親の補足 2026-10-26） */
  const remove = async (a: DaycareActivity, name: string) => {
    const key = `${a.resident_id}:${a.day}`
    const why = precheck()
    if (why !== null) {
      say(key, 'warn', why)
      return
    }
    // 戻す先（人・日・項目・度合い）は消す時に固定する
    const item = { rid: a.resident_id, day: a.day, label: a.label, before: a.participation, name }
    const bk = `${a.day}:${a.resident_id}:${a.label}`
    setBusyKey(bk, true)
    try {
      const r = await softDeleteDaycareActivity(a, { editedBy: actorId })
      if (r === 'queued') {
        // 行は落とさない（取り消しが届くまで、列の見出しの一括の相手から外すため＝取り消しの送信待ちは「記録あり」と数える）
        setPending(pendingActivityOps())
        say(key, isQueuePersisted() ? 'info' : 'danger', `「${a.label}」の取り消し：${queuedText()}`, true)
        offerUndo({ ...item, queued: true })
      } else if (r === true) {
        dropRow(a.day, a.id)
        clearMsg(key)
        offerUndo({ ...item, queued: false })
      } else {
        say(key, 'warn', `「${a.label}」は他の端末が先に直していました。最新の内容に読み直しました。確かめてから、もう一度押してください。`)
        scheduleReload()
      }
    } catch (e) {
      say(key, 'danger', errText(e, '取り消せませんでした。通信状態を確認して、もう一度押してください。'))
    } finally {
      setBusyKey(bk, false)
    }
  }

  /** まだ来ていない方（予定のまま）か、この画面を開いている間に確かめた方か */
  const arrivalOk = (rid: number, d: string) => activityDefaultChecked(rowOf(rid)) || lateOk.current.has(`${d}:${rid}`)

  /** 枠を押した: 無し → 参加 → 一部 → 見学 → 不参加 → 消す（送り先は押した時の人・日・項目に固定） */
  const cycle = async (rid: number, label: string) => {
    const d = day
    const why = precheck()
    if (why !== null) {
      say(`${rid}:${d}`, 'warn', why)
      return
    }
    if (!arrivalOk(rid, d)) {
      setLateAsk({ rid, day: d, label })
      return
    }
    const cell = cellOf(rid, label)
    if (cell.locked || busy.has(`${d}:${rid}:${label}`)) return
    const a = cell.row
    if (a === null) {
      await add(rid, d, label, 'full')
      return
    }
    const next = nextParticipation(a.participation)
    if (next === null) await remove(a, nameOf(rid))
    else await setParticipation(a, next)
  }

  const openOther = (rid: number | null) => {
    setOtherText('')
    setOtherAsk({ rid, day })
  }
  /** 〔＋〕: 書けない時は理由を出す。まだ来ていない方は先に確かめる */
  const plusFor = (rid: number) => {
    const why = precheck()
    if (why !== null) {
      say(`${rid}:${day}`, 'warn', why)
      return
    }
    if (!arrivalOk(rid, day)) {
      setLateAsk({ rid, day, label: null })
      return
    }
    openOther(rid)
  }

  /** 「その他」の見出し: 書けない時は理由を出す。書ける時は項目を入れる小窓（入れた後に askFill と同じ確かめ） */
  const askOther = () => {
    const why = precheck()
    if (why !== null) {
      setResult({ day, tone: 'warn', text: why })
      return
    }
    openOther(null)
  }

  /** 列の見出しを押した: 相手（来た方で記録の無い方）がいれば確かめの小窓を出す */
  const askFill = (l: string) => {
    const why = precheck()
    if (why !== null) {
      setResult({ day, tone: 'warn', text: why })
      return
    }
    if (fillTargets(l).length === 0) {
      setResult({ day, tone: 'info', text: bulkResultText(l, []) })
      return
    }
    setFillAsk(l)
  }

  const runBulk = async (l: string) => {
    setFillAsk(null)
    const d = day
    const why = precheck()
    if (why !== null) {
      setResult({ day: d, tone: 'warn', text: why })
      return
    }
    // 相手は押した時（〔入れる〕）の様子で選び直す（小窓を開いている間に入った記録は変えない）
    const ids = fillTargets(l)
    if (ids.length === 0) {
      setResult({ day: d, tone: 'info', text: bulkResultText(l, []) })
      return
    }
    setRunning(true)
    const outcomes: ActivityAddOutcome[] = []
    for (const rid of ids) {
      try {
        const r = await insertDaycareActivity({ resident_id: rid, day: d, label: l, recorded_by: actorId })
        outcomes.push(r.kind)
        if (r.kind === 'saved' || r.kind === 'merged') putRow(d, r.row)
      } catch {
        outcomes.push('error')
      }
    }
    setRunning(false)
    setPending(pendingActivityOps())
    const bad = outcomes.some((o) => o === 'taken' || o === 'error')
    setResult({ day: d, tone: bad ? 'warn' : 'info', text: bulkResultText(l, outcomes) })
    scheduleReload()
  }

  const otherErr = otherText === '' ? null : activityLabelError(otherText)
  const submitOther = () => {
    const ask = otherAsk
    if (ask === null || otherText.trim() === '' || otherErr !== null) return
    const l = normalizeActivityLabel(otherText)
    setOtherAsk(null)
    setOtherText('')
    if (ask.day !== day) return
    if (ask.rid === null) askFill(l)
    else void add(ask.rid, ask.day, l, 'full')
  }

  const goDay = (d: string) => navigate(bulkPath(d, today), { replace: true })

  const header = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <DaycareNav current="activity" handoff={() => writeDaycareHandoffFor({ rows: board?.rows ?? null, residents, boardDay: data?.day ?? null, today })} />
        <RecorderBar actorId={actorId} staff={staff ?? null} />
      </div>
      <div className="flex flex-wrap items-center gap-gap" role="group" aria-label="日付">
        <button
          type="button"
          onClick={() => goDay(addDays(day, -1))}
          className="min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-lg text-ink"
          aria-label="前の日へ"
        >
          <span aria-hidden="true">‹</span>
        </button>
        <span className="min-w-28 text-center text-lg font-bold text-ink" aria-live="polite">
          {fmtDayLabel(day)}
          {day === today ? <span className="ml-2 text-base text-ok">今日</span> : null}
        </span>
        <button
          type="button"
          onClick={() => goDay(addDays(day, 1) > today ? day : addDays(day, 1))}
          disabled={day >= today}
          className="min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-lg text-ink disabled:text-ink3"
          aria-label="次の日へ"
        >
          <span aria-hidden="true">›</span>
        </button>
        <button
          type="button"
          onClick={() => setReloadKey((n) => n + 1)}
          className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink"
        >
          最新に更新
        </button>
      </div>
      {missing ? (
        <p role="alert" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {MSG_MISSING}
        </p>
      ) : gate !== null && !(gate.observed && gate.value === true) ? (
        <p role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {gate.forbidden
            ? FORBIDDEN_REASON
            : gate.outdated
              ? OUTDATED_REASON
              : gate.observed
                ? `${kindBlockedMessage('daycare_activity')}。記録の閲覧はできます。`
                : MSG_GATE_UNKNOWN}
        </p>
      ) : null}
    </div>
  )

  if ((loading && data === null) || (data !== null && data.day !== day && error === null)) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
        {header}
        <LoadingBlock label="その日の活動を読み込んでいます…" />
      </div>
    )
  }
  if (error !== null && (data === null || data.day !== day)) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
        {header}
        <ErrorBlock message={error} onRetry={() => setReloadKey((n) => n + 1)} />
      </div>
    )
  }
  if (data === null) return null

  const readable = data.activities !== null
  /** 枠1つ（定型の列は大きな枠・「その他」の列は項目つきの小さなボタン） */
  const cellButton = (rid: number, name: string, label: string, small: boolean) => {
    const c = cellOf(rid, label)
    const saving = busy.has(`${day}:${rid}:${label}`)
    const word = !readable ? '？' : c.shown === null ? '—' : ACTIVITY_PARTICIPATION_LABEL[c.shown]
    const stopped = c.stopped.length > 0
    const mark = saving || c.waiting || c.deleting ? '↻' : stopped ? '▲' : ''
    const after = nextParticipation(c.row?.participation ?? null)
    const now = !readable ? '読み込めませんでした' : c.shown === null ? '記録なし' : ACTIVITY_PARTICIPATION_LABEL[c.shown]
    const status = saving ? '保存中' : c.deleting ? '取り消しの送信待ち' : c.waiting ? '送信待ち' : stopped ? '送れずに止まっています' : ''
    const head = `${name}さんの${label}（いま: ${now}${status !== '' ? `・${status}` : ''}）。`
    // 押せない時は「押すと…」と言わない（旗が閉じている・一括の最中も＝反証 軽3）
    const ariaLabel = !readable
      ? head
      : saving || c.locked
        ? `${head}届くまで押せません`
        : running
          ? `${head}まとめて入れている間は押せません`
          : !canWrite
            ? `${head}いまは押せません（画面の上の知らせを見てください）`
            : `${head}押すと${after === null ? '消します（〔元に戻す〕で戻せます）' : ACTIVITY_PARTICIPATION_LABEL[after]}`
    const tone =
      stopped
        ? 'border-2 border-warn bg-warn-bg'
        : c.shown !== null && readable
          ? 'border-2 border-primary bg-accent-bg'
          : 'border border-border-strong bg-surface'
    const text = (
      <span aria-hidden="true">
        <span className={`font-bold ${c.deleting ? 'line-through' : ''} ${c.shown === null ? 'text-ink2' : 'text-ink'}`}>{small ? `${label}：${word}` : word}</span>
        {mark !== '' ? <span className="ml-1 text-ink">{mark}</span> : null}
      </span>
    )
    return (
      <button
        key={label}
        type="button"
        onClick={() => void cycle(rid, label)}
        disabled={!canWrite || running || saving || c.locked}
        aria-label={ariaLabel}
        className={
          small
            ? `min-h-tap max-w-full rounded px-2 text-left text-base disabled:opacity-100 ${tone}`
            : `flex min-h-tap w-full min-w-tap items-center justify-center rounded px-2 text-center text-base disabled:opacity-100 ${tone}`
        }
      >
        {text}
      </button>
    )
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
      {header}

      <section aria-labelledby="h-bulk" className="min-w-0 space-y-3 rounded-lg border border-border bg-surface p-3">
        <h2 id="h-bulk" className="text-xl font-bold text-ink">
          活動一括
        </h2>
        <p className="text-base text-ink2">
          枠を押すたびに「参加 → 一部 → 見学 → 不参加 → 消す」と変わります（消した時は画面の下に出る〔元に戻す〕で戻せます）。列の見出しを押すと、来た方のうち記録の無い方にまとめて「参加」で入れます（まだ来ていない方・もう記録がある方は変えません）。
        </p>
        {data.activities === null && !missing ? (
          <div role="alert" className="space-y-2 rounded border border-danger bg-danger-bg p-2 text-base text-ink">
            <p>
              <span aria-hidden="true">▲ </span>活動の記録を読み込めませんでした（表の「？」は読めていない枠です）。通信状態を確認して、〔最新に更新〕を押してください。
            </p>
          </div>
        ) : null}
        {result !== null && result.day === day ? (
          <p role="status" className={`rounded border p-2 text-base text-ink ${result.tone === 'info' ? 'border-primary bg-surface' : 'border-warn bg-warn-bg'}`}>
            <span aria-hidden="true">{result.tone === 'info' ? 'ⓘ ' : '⚠ '}</span>
            {result.text}
          </p>
        ) : null}
        {running ? (
          <p role="status" className="text-base text-ink2">
            <span aria-hidden="true">↻ </span>入れています…
          </p>
        ) : null}

        {targets.length === 0 ? (
          <p className="text-base text-ink2">この日の予定の方がいません（休み・入院中の方は出しません）。予定外で来た方は、今日の画面の〔予定にない方を追加〕で足したカードを押し、〔予定外で到着〕を押すと、ここに出ます。</p>
        ) : (
          <>
            {/* 印の意味（色だけに頼らない）。表が画面より広い時だけ横スクロールの手がかりを出す（バイタル一括と同じ） */}
            <p className="text-sm text-ink2">
              <span aria-hidden="true">↻</span>＝送信待ち・保存中（届くまで押せません）　<span aria-hidden="true">▲</span>＝送れずに止まっています（行の下の文を見てください）　取り消し線＝取り消しの送信待ち
            </p>
            {tableScrolls ? (
              <p className="text-sm text-ink2">
                <span aria-hidden="true">⇆ </span>
                表は横にスクロールできます（氏名の列は左に残ります）
              </p>
            ) : null}
            {/* 2026-10-26（2回目）: バイタル一括と同じ1行1人の表。横スクロールはこの枠の中だけ（ページ全体を広げない）。
                relative は表の中の読み上げ用の文字の基準をこの枠にするため */}
            <div
              ref={setTableBox}
              role="region"
              aria-label={`${fmtDayLabel(day)}の活動一括の表${tableScrolls ? '（横にスクロールできます）' : ''}`}
              tabIndex={tableScrolls ? 0 : undefined}
              className="relative overflow-x-auto"
            >
              <table className="w-full min-w-max border-collapse text-base">
                <caption className="sr-only">{fmtDayLabel(day)}の活動一括の表（枠を押すと 参加・一部・見学・不参加・消す の順に変わります）</caption>
                <thead>
                  <tr className="border-b border-border-strong bg-surface2 text-left">
                    {/* 氏名の列は横スクロールしても左に残す（sticky）。背景は見出し行と同じ色 */}
                    <th scope="col" className="sticky left-0 z-20 bg-surface2 px-2 py-2 text-sm font-bold text-ink2">
                      <span className="dc-vital-name block">氏名</span>
                    </th>
                    {/* 列の見出しはボタン: 来た方のうち記録の無い方にまとめて「参加」（確かめの小窓つき） */}
                    {DAYCARE_ACTIVITY_CHIPS.map((c) => (
                      <th key={c} scope="col" className="px-1 py-1">
                        <button
                          type="button"
                          disabled={!canWrite || running}
                          onClick={() => askFill(c)}
                          aria-label={`「${c}」を、来た方のうち記録の無い方にまとめて「参加」で入れる`}
                          className="min-h-tap w-full min-w-tap rounded border border-border-strong bg-surface px-2 text-base font-bold text-ink disabled:text-ink3"
                        >
                          {c}
                        </button>
                      </th>
                    ))}
                    <th scope="col" className="px-1 py-1">
                      <button
                        type="button"
                        disabled={!canWrite || running}
                        onClick={askOther}
                        aria-label="その他：ほかの活動を、来た方のうち記録の無い方にまとめて「参加」で入れる（項目を入れてから確かめます）"
                        className="min-h-tap w-full min-w-tap rounded border border-border-strong bg-surface px-2 text-base font-bold text-ink disabled:text-ink3"
                      >
                        その他
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {targets.map((rid) => {
                    const name = nameOf(rid)
                    const late = !activityDefaultChecked(rowOf(rid))
                    const others = readable ? otherLabelsOf(rid) : []
                    const stoppedNotes = readable ? [...DAYCARE_ACTIVITY_CHIPS, ...others].flatMap((l) => cellOf(rid, l).stopped) : []
                    const m = msgs.get(`${rid}:${day}`)
                    const detail = stoppedNotes.length > 0 || m !== undefined
                    return (
                      <Fragment key={rid}>
                        <tr className={`align-middle ${detail ? '' : 'border-b border-border'}`}>
                          {/* 氏名の列は横スクロールしても左に残す（sticky）。背景はページの地の色（下を流れる欄を透かさない） */}
                          <th scope="row" className="sticky left-0 z-20 bg-bg px-2 py-1 text-left font-normal">
                            {/* 氏名の列の幅は dc-vital-name で決める（札が長くても列を広げず、中で折り返す） */}
                            <div className="dc-vital-name space-y-1">
                              <span className="block text-base font-bold text-ink">{name}</span>
                              {/* まだ来ていない方は印を出す（親の検収 中2）。枠を押すと確かめを挟む */}
                              {late ? <span className="block text-sm text-ink2">（未到着）</span> : null}
                              <Link
                                to={personPath(rid, day, today)}
                                aria-label={`${name}さんの1日の記録を開く（活動の度合い・前回と同じ）`}
                                className="inline-flex min-h-tap items-center rounded border border-primary bg-surface px-2 text-base font-bold text-primary"
                              >
                                記録<span aria-hidden="true"> ›</span>
                              </Link>
                            </div>
                          </th>
                          {DAYCARE_ACTIVITY_CHIPS.map((c) => (
                            <td key={c} className="px-1 py-1">
                              {cellButton(rid, name, c, false)}
                            </td>
                          ))}
                          <td className="px-1 py-1">
                            <div className="flex flex-wrap items-center gap-gap" role="group" aria-label={`${name}さんのほかの活動`}>
                              {others.map((l) => cellButton(rid, name, l, true))}
                              <button
                                type="button"
                                disabled={!canWrite || running}
                                onClick={() => plusFor(rid)}
                                aria-label={`${name}さんにほかの活動を足す`}
                                className="min-h-tap min-w-tap rounded border border-border-strong bg-surface px-2 text-lg font-bold text-ink disabled:text-ink3"
                              >
                                ＋
                              </button>
                            </div>
                          </td>
                        </tr>
                        {detail ? (
                          <tr className="border-b border-border">
                            {/* 知らせの行は表の幅を広げない（バイタル一括と同じ形）。幅0＋最小100% の箱で表の幅の計算から外し、
                                文は表の枠の幅で折り返して、横スクロールしても左に残す（sticky） */}
                            <td colSpan={DAYCARE_ACTIVITY_CHIPS.length + 2} className="p-0">
                              <div className="w-0 min-w-full">
                                <div className="sticky left-0 space-y-1 px-2 pb-2" style={{ maxWidth: tableBoxWidth > 0 ? tableBoxWidth : undefined }}>
                                  {stoppedNotes.map((t) => (
                                    <p key={t} role="alert" className="rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
                                      <span aria-hidden="true">▲ </span>
                                      <span className="sr-only">{name}さん：</span>
                                      {t}
                                    </p>
                                  ))}
                                  {m !== undefined ? (
                                    <p role="status" className={`rounded border p-2 text-base text-ink ${toneCls[m.tone]}`}>
                                      <span aria-hidden="true">{m.tone === 'info' ? 'ⓘ ' : '⚠ '}</span>
                                      <span className="sr-only">{name}さん：</span>
                                      {m.text}
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <ModalShell open={otherAsk !== null} label="ほかの活動" onClose={() => setOtherAsk(null)} initialFocus={otherInput} narrow>
        {otherAsk !== null ? (
          <>
            <div className="space-y-3 p-4">
              <h2 className="text-lg font-bold text-ink">
                {otherAsk.rid === null ? 'ほかの活動を一括で入れる' : `${nameOf(otherAsk.rid)}さんにほかの活動を足す`}
              </h2>
              <label className="block text-sm text-ink2">
                ほかの活動（{ACTIVITY_LABEL_MAX}字まで）
                <input
                  ref={otherInput}
                  type="text"
                  value={otherText}
                  maxLength={ACTIVITY_LABEL_MAX * 2}
                  onChange={(e) => setOtherText(e.target.value)}
                  aria-invalid={otherErr !== null}
                  aria-describedby={otherErr !== null ? 'bulk-other-err' : undefined}
                  className="mt-1 block min-h-tap w-full rounded border border-border-strong bg-surface px-2 text-lg text-ink"
                />
                {otherErr !== null ? (
                  <span id="bulk-other-err" className="mt-1 block text-sm text-danger">
                    {otherErr}
                  </span>
                ) : null}
              </label>
              {otherAsk.rid === null ? <p className="text-sm text-ink2">次の画面で、入れる人数を確かめてから入れます。</p> : null}
            </div>
            <div className="flex justify-end gap-gap border-t border-border p-4">
              <button type="button" onClick={() => setOtherAsk(null)} className="min-h-tap rounded border border-border-strong px-4 text-base text-ink">
                閉じる
              </button>
              <button
                type="button"
                disabled={!canWrite || otherText.trim() === '' || otherErr !== null}
                onClick={submitOther}
                className="min-h-tap rounded border-2 border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border-strong disabled:bg-surface disabled:text-ink3"
              >
                {otherAsk.rid === null ? '次へ' : '足す'}
              </button>
            </div>
          </>
        ) : null}
      </ModalShell>
      <ConfirmDialog
        open={fillAsk !== null}
        title={fillAsk === null ? '' : `「${fillAsk}」をまとめて入れますか`}
        body={fillAsk === null ? '' : `${fillAsk}を、来た方のうち記録の無い ${fillTargets(fillAsk).length}人に「参加」で入れます。まだ来ていない方・もう記録がある方は変えません。`}
        confirmLabel="入れる"
        onConfirm={() => fillAsk !== null && void runBulk(fillAsk)}
        onCancel={() => setFillAsk(null)}
      />
      <ConfirmDialog
        open={lateAsk !== null}
        title={lateAsk === null ? '' : `${nameOf(lateAsk.rid)}さんはまだ到着していません。記録しますか`}
        body="到着の記録がまだ無い方です（休みにしても活動の記録は残ります）。来ていることを確かめてから記録してください。この画面を開いている間、この方には2回目から確かめません。"
        confirmLabel="記録する"
        onConfirm={() => {
          const t = lateAsk
          setLateAsk(null)
          if (t === null || t.day !== day) return
          // その方・その日につき、この画面を開いている間に1回だけ確かめる（画面のメモリだけ・端末に残さない）
          lateOk.current.add(`${t.day}:${t.rid}`)
          if (t.label === null) openOther(t.rid)
          else void cycle(t.rid, t.label)
        }}
        onCancel={() => setLateAsk(null)}
      />
      {toast}
    </div>
  )
}
