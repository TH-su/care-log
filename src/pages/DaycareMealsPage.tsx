// デイ せせらぎ 今日の画面の改善 2回目: 昼食・おやつをまとめて入れる画面（/record/daycare/meals・業務日は ?day=）。
// 2026-10-24 代表承認（決定 6・親の回答 1〜2）。
//
// ・並べるのは、その日に来た方（在席・帰宅）だけ（休み・未到着・入院中は出さない）。今日の一覧の並びのまま1人1帯
// ・帯の中に、昼食の主食 0〜10・副食 0〜10・〔拒食〕・おやつ（全部・半分・食べない）のボタンを常に出す。押すとすぐ保存し、
//   帯の端に保存の印（✓ 保存済み・⚠ 未送信・▲ 要確認）を出す（care-log の食事一括と同じ操作感。MealsGridPage そのものは変えない）
// ・決まりはデイの1人の画面（DaycarePersonPage）の昼食・おやつと同じ:
//   - 保存は既存の saveMealEdits（meals の lunch・snack＝care-log の昼食と同じ行）。基準は読んだ時のサーバーの値。
//     送り先は押した時の人・日・枠で固定する（応答の前に日を切り替えても、次の日へ書かない）
//   - 状態は「食べた」「拒食」だけ（外出・入院はデイにいる方の記録なので出さない）。割合・おやつのボタンは、拒食なら「食べた」に戻して送る
//   - 送信待ちの値は欄に重ねて出す。止まった値（食い違い）・拒まれた値は重ねず、サーバーの値を出して帯の下で知らせる
//   - 〔元に戻す〕はオンラインで実際に書けた時だけ（送信待ちの時は出さない）
//   - 入力解禁は input_enabled_daycare（saveMealEdits の入口で native_input_enabled も効く）。過去の日は書ける・未来の日は書けない
// ・取り込みとの関係は既存のまま（画面で入れた行は edited_by が付き、取り込みが上書きしない）。取り込みの印は帯に小さく出す
// ・端末に業務データを残さない（localStorage を使わない。日付は URL の ?day= で、再読み込みでも同じ日に戻る）

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  DbError,
  FORBIDDEN_REASON,
  OUTDATED_REASON,
  discardPendingRow,
  fetchAllResidents,
  fetchDaycareAttendance,
  fetchDaycareDay,
  fetchDaycareIntake,
  fetchDaycarePlan,
  getKindInputGate,
  isQueuePersisted,
  isSelfWrite,
  kindBlockedMessage,
  pendingRow,
  queuePending,
  queueSubscribe,
  saveMealEdits,
  subscribeChanges,
  subscribeDaycareChanges,
} from '../lib/db'
import type { CellConflict, CellEditInput, DaycareMealRow, MealCellField, MealTarget } from '../lib/db'
import { RecorderBar } from '../components/RecorderBar'
import { ErrorBlock, LoadingBlock, useToast } from '../components/ui'
import { buildDaycareBoard } from '../lib/daycare'
import type { DaycareBoardRow } from '../lib/daycare'
import {
  DAYCARE_MEAL_AMOUNTS,
  DAYCARE_SNACK_CHOICES,
  lunchLabel,
  mealBandMark,
  mealBulkPath,
  mealBulkRows,
  mealSourceLabel,
  personPath,
  readPersonDay,
  snackLabel,
} from '../lib/daycarePerson'
import type { MealSaveKind } from '../lib/daycarePerson'
import { addDays, fmtDayLabel, todayIso } from '../lib/format'
import type { DaycareAttendance, DaycareDay, DaycarePlanRow, DaycarePlanSource, Meal, Resident, Staff } from '../lib/types'
import { DaycareNav } from './DaycarePage'

const ERR_LOAD = 'デイの記録を読み込めませんでした。通信状態を確認して、再試行してください。'
const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから入れてください。'
const MSG_QUEUED = '電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度押してください。'
const MSG_GATE_UNKNOWN =
  'デイの記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。記録の閲覧はこのままできます。'
const MSG_MISSING = 'デイの記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。'

interface MealsData {
  day: string
  planRows: DaycarePlanRow[]
  planSource: DaycarePlanSource
  missing: boolean
  attendance: DaycareAttendance[]
  meals: DaycareMealRow[]
}

type MealSlot2 = 'lunch' | 'snack'
type MealField = 'main_amount' | 'side_amount' | 'status'
const SLOTS2: readonly MealSlot2[] = ['lunch', 'snack']

/**
 * 昼食・おやつの保存の状態。人・日・枠ごとに持つ（保存の途中で日を切り替えても、前の日の結果を次の日の帯に出さない）。
 * 食い違い・止まり・拒否は、その送り先（target）を持ち、解く操作はその送り先へ送る（1人の画面と同じ）
 */
type SaveState =
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'queued'; persisted: boolean }
  | { kind: 'conflict'; conflicts: CellConflict[]; target: MealTarget }
  | { kind: 'held'; target: MealTarget }
  | { kind: 'rejected'; target: MealTarget; reason?: string }
  | { kind: 'error'; text: string }

const mealKeyOf = (t: MealTarget) => `${t.residentId}:${t.day}:${t.slot}`

/** 帯の氏名の下の一言（在席 9:35／帰宅 15:30） */
function cameText(row: DaycareBoardRow): string {
  const a = row.attendance
  const hm = (t: string | null | undefined) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(t ?? '')
    return m === null ? '' : ` ${Number(m[1])}:${m[2]}`
  }
  return row.state === 'left' ? `帰宅${hm(a?.left_at)}` : `在席${hm(a?.arrived_at)}`
}

export interface DaycareMealsPageProps {
  staff?: Staff[] | null
  actorId?: number | null
}

export function DaycareMealsPage({ staff = undefined, actorId = null }: DaycareMealsPageProps = {}) {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const [today, setToday] = useState(todayIso())
  const day = readPersonDay(search.get('day'), today)
  const [data, setData] = useState<MealsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [residents, setResidents] = useState<Resident[]>([])
  const [gate, setGate] = useState<{ value: boolean; observed: boolean; forbidden?: true; outdated?: true } | null>(null)
  const [mealState, setMealState] = useState<Record<string, SaveState>>({})
  const [queueTick, setQueueTick] = useState(0)
  const { toast, show } = useToast()
  const genRef = useRef(0)
  const dayRef = useRef(day)
  dayRef.current = day

  useEffect(() => {
    const t = window.setInterval(() => setToday(todayIso()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    let alive = true
    setGate(null)
    getKindInputGate('daycare')
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
      const [plan, attendance, intake] = await Promise.all([
        usable ? Promise.resolve(null) : fetchDaycarePlan(target),
        missing ? Promise.resolve([] as DaycareAttendance[]) : fetchDaycareAttendance(target),
        fetchDaycareIntake(target),
      ])
      if (gen !== genRef.current || target !== dayRef.current) return
      setData({
        day: target,
        planRows: usable && snapshot !== null ? snapshot.plan_rows : (plan?.rows ?? []),
        planSource: usable && snapshot !== null ? snapshot.plan_source : (plan?.source ?? 'unknown'),
        missing: missing || plan?.missing === true,
        attendance,
        meals: intake.meals,
      })
      setError(null)
    } catch {
      if (gen !== genRef.current) return
      if (!quiet) setError(ERR_LOAD)
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // 日の切り替えと〔最新に更新〕では、その場限りの知らせ（保存しました・保存できませんでした）を外す。
    // 送信待ち・食い違い・拒否の知らせは残し、届いた・解けたと分かった時に外す（下の出し直し）
    setMealState((prev) => {
      const next: Record<string, SaveState> = {}
      for (const [k, v] of Object.entries(prev)) if (v.kind !== 'saved' && v.kind !== 'error') next[k] = v
      return next
    })
    void load(day, false)
  }, [day, reloadKey, load])

  // 他の端末の変更（Realtime）と送信待ちの減り（送れた）で静かに読み直す
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
    const offB = subscribeChanges((table, info) => {
      if (table === 'meals') onChange(table, info)
    })
    let last = queuePending()
    const offQ = queueSubscribe((n) => {
      setQueueTick((x) => x + 1)
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

  const board = useMemo(
    () => (data === null ? null : buildDaycareBoard({ planRows: data.planRows, source: data.planSource, residents, attendance: data.attendance })),
    [data, residents],
  )
  const came = useMemo(() => (board === null ? [] : mealBulkRows(board.rows)), [board])
  const cameKey = came.map((r) => r.residentId).join(',')
  const nameOf = (id: number) => residents.find((r) => r.id === id)?.name ?? `利用者ID ${id}`
  const missing = data?.missing ?? false
  const canWrite = gate !== null && gate.observed && gate.value === true && !missing && day <= today

  // ── 昼食・おやつ（1人の画面と同じ決まり） ──
  const targetOf = (residentId: number, slot: MealSlot2): MealTarget => ({ residentId, day, slot })
  const mealRowFor = (t: MealTarget): DaycareMealRow | null =>
    data === null || data.day !== t.day
      ? null
      : (data.meals.find((m) => m.meal.resident_id === t.residentId && m.meal.meal_slot === t.slot) ?? null)
  /**
   * 画面に出す値: 送信待ち（まだ送っていない・送っている途中）の値だけ重ねる。止まった値（食い違い）・拒まれた値は重ねず、
   * サーバーの値を出して帯の下で知らせる（1人の画面・既存の食事一括と同じ）
   */
  const mealShownFor = (t: MealTarget): Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null => {
    const cur = mealRowFor(t)?.meal ?? null
    const p = pendingRow('meals', t)
    if (p === null || p.state !== 'pending') return cur
    const pick = <K extends MealField>(f: K): Meal[K] | null =>
      (f in p.values ? (p.values[f] as Meal[K] | null) : (cur?.[f] ?? null)) as Meal[K] | null
    return { main_amount: pick('main_amount'), side_amount: pick('side_amount'), status: pick('status') }
  }
  const setMealFor = (t: MealTarget, st: SaveState | null) =>
    setMealState((prev) => {
      const next = { ...prev }
      const k = mealKeyOf(t)
      if (st === null) delete next[k]
      else next[k] = st
      return next
    })

  const precheck = (): string | null => {
    if (missing) return MSG_MISSING
    if (!canWrite) {
      return gate?.forbidden ? FORBIDDEN_REASON : gate?.outdated ? OUTDATED_REASON : gate?.observed ? kindBlockedMessage('daycare') : MSG_GATE_UNKNOWN
    }
    if (actorId === null) return MSG_NO_RECORDER
    return null
  }

  /**
   * 昼食・おやつの欄を保存する（既存の saveMealEdits。基準は読んだ時のサーバーの値。rebase は〔あなたの値で直す〕・〔元に戻す〕）。
   * 送り先（t）は押した時の人・日・枠で固定する（応答の前に日を切り替えても、次の日へ書かない）
   */
  const saveMeal = async (
    t: MealTarget,
    patch: Partial<Record<MealField, number | string | null>>,
    opts: { rebase?: Record<string, unknown>; undoable?: boolean } = {},
  ) => {
    const why = precheck()
    if (why !== null) {
      setMealFor(t, { kind: 'error', text: why })
      return
    }
    const before = mealShownFor(t)
    const cur = mealRowFor(t)?.meal ?? null
    const send: Record<string, { value: unknown; base: unknown }> = {}
    for (const [f, v] of Object.entries(patch)) {
      const base = opts.rebase !== undefined && f in opts.rebase ? opts.rebase[f] : (cur?.[f as MealField] ?? null)
      send[f] = { value: v, base }
    }
    setMealFor(t, { kind: 'saving' })
    const here = () => dayRef.current === t.day
    try {
      const r = await saveMealEdits(t, send as CellEditInput<MealCellField>, {
        // 記入者は新しい行の時だけ（更新では編集した欄だけ＝部分更新）。edited_by は既定の操作者＝取り込みの上書きを止める印
        ...(cur === null ? { fill: { recorded_by: actorId } } : {}),
        editedBy: actorId,
        rebase: opts.rebase !== undefined,
      })
      if (r === 'queued') {
        // 送信待ちにした: 〔元に戻す〕は出さない（送る前の値を基準にした取り消しが、送った時に偽の食い違いになるため）
        setMealFor(t, { kind: 'queued', persisted: isQueuePersisted() })
        return
      }
      if (r.row !== null) {
        const saved = r.row
        const wrote = r.applied.length > 0
        setData((prev) => {
          if (prev === null || prev.day !== saved.meal_on) return prev
          const old = prev.meals.find((m) => m.meal.id === saved.id)
          const meals = [
            ...prev.meals.filter((m) => m.meal.id !== saved.id),
            // 画面の入力の印は、実際に書けた時だけ（同じ値＝何も書かなかった時は edited_by が付かない）
            { meal: saved, imported: old?.imported ?? false, editedInApp: (old?.editedInApp ?? false) || wrote },
          ]
          return { ...prev, meals }
        })
      }
      if (r.held === true) {
        const p = pendingRow('meals', t)
        setMealFor(t, p !== null && p.conflicts.length > 0 ? { kind: 'conflict', conflicts: p.conflicts, target: t } : { kind: 'held', target: t })
        return
      }
      if (r.conflicts.length > 0) {
        setMealFor(t, { kind: 'conflict', conflicts: r.conflicts, target: t })
        return
      }
      setMealFor(t, { kind: 'saved' })
      // 〔元に戻す〕はオンラインで実際に書けた時だけ。日を移った後は出さない
      if (opts.undoable !== false && r.applied.length > 0 && here()) {
        const word = t.slot === 'lunch' ? '昼食' : 'おやつ'
        const undoPatch: Partial<Record<MealField, number | string | null>> = {}
        for (const f of Object.keys(patch) as MealField[]) undoPatch[f] = before?.[f] ?? null
        show(`${nameOf(t.residentId)}さんの${word}を記録しました`, () => {
          const base: Record<string, unknown> = {}
          for (const f of Object.keys(patch)) base[f] = patch[f as MealField] ?? null
          void saveMeal(t, undoPatch, { rebase: base, undoable: false })
        })
      }
    } catch (e) {
      const text = e instanceof DbError ? e.message : '保存できませんでした。通信状態を確認して、もう一度押してください。'
      // 拒まれた値が送信待ちに残った時は、押した直後から〔取り下げる〕を出す（読み直すまで外す手段が無いままにしない）
      const p = pendingRow('meals', t)
      setMealFor(t, p !== null && p.state === 'rejected' ? { kind: 'rejected', target: t, reason: text } : { kind: 'error', text })
    }
  }

  /** 食い違い・止まり・拒否を解く（送り先は状態が持つ target） */
  const resolveTake = async (t: MealTarget, fields?: readonly string[]) => {
    const p = pendingRow('meals', t)
    await discardPendingRow('meals', t, fields ?? (p === null ? [] : Object.keys(p.values)), p?.vers)
    setMealFor(t, null)
    scheduleReload()
  }
  const resolveMine = async (t: MealTarget, conflicts: CellConflict[]) => {
    const p = pendingRow('meals', t)
    const patch: Partial<Record<MealField, number | string | null>> = {}
    const base: Record<string, unknown> = {}
    for (const c of conflicts) {
      const mine = p !== null && Object.prototype.hasOwnProperty.call(p.values, c.field) ? p.values[c.field] : c.mine
      patch[c.field as MealField] = (mine ?? null) as number | string | null
      base[c.field] = c.server
    }
    await saveMeal(t, patch, { rebase: base, undoable: false })
  }

  // 読み込みの後と、送信待ちが動いた時（背景の再送で止まった・拒まれた・届いた）: 帯の下の知らせを、送信待ちの今の状態に合わせて出し直す
  // （止まった値を保存済みのように見せない。画面を開いたまま背景で止まった時も切り替える＝1人の画面と同じ）
  useEffect(() => {
    if (data === null) return
    const ids = cameKey === '' ? [] : cameKey.split(',').map(Number)
    setMealState((prev) => {
      let next = prev
      for (const residentId of ids)
        for (const slot of SLOTS2) {
          const t: MealTarget = { residentId, day: data.day, slot }
          const k = mealKeyOf(t)
          const cur = prev[k]
          if (cur !== undefined && cur.kind === 'saving') continue
          const p = pendingRow('meals', t)
          let st: SaveState | undefined = cur
          if (p !== null && p.state !== 'pending') {
            if (p.state === 'rejected') st = cur !== undefined && cur.kind === 'rejected' ? cur : { kind: 'rejected', target: t }
            else if (p.conflicts.length > 0)
              st =
                cur !== undefined && cur.kind === 'conflict' && JSON.stringify(cur.conflicts) === JSON.stringify(p.conflicts)
                  ? cur
                  : { kind: 'conflict', conflicts: p.conflicts, target: t }
            else st = cur !== undefined && cur.kind === 'held' ? cur : { kind: 'held', target: t }
          } else if (cur !== undefined && (cur.kind === 'conflict' || cur.kind === 'held' || cur.kind === 'rejected' || (cur.kind === 'queued' && p === null))) {
            // 届いた（送信待ちから消えた）・別のタブで解かれた: 送信待ち・食い違い・拒否の知らせを外す
            st = undefined
          }
          if (st === cur) continue
          if (next === prev) next = { ...prev }
          if (st === undefined) delete next[k]
          else next[k] = st
        }
      return next
    })
  }, [data, cameKey, queueTick])

  /** 割合・おやつのボタン: 状態が「食べた」以外（拒食など）なら「食べた」に戻して送る（1人の画面と同じ） */
  const withEaten = (status: string | null | undefined, patch: Partial<Record<MealField, number | string | null>>) =>
    status === null || status === undefined || status === 'eaten' ? patch : { ...patch, status: 'eaten' }

  const goDay = (d: string) => navigate(mealBulkPath(d, today), { replace: true })
  const chipCls = (on: boolean) =>
    on
      ? 'min-h-tap min-w-tap rounded border-2 border-primary bg-primary px-2 text-lg font-bold text-primary-ink'
      : 'min-h-tap min-w-tap rounded border border-border-strong bg-surface px-2 text-lg text-ink disabled:text-ink3'

  const header = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <DaycareNav current="meals" />
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
        {day !== today ? (
          <button type="button" onClick={() => goDay(today)} className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink">
            今日を開く
          </button>
        ) : null}
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
                ? `${kindBlockedMessage('daycare')}。記録の閲覧はできます。`
                : MSG_GATE_UNKNOWN}
        </p>
      ) : null}
    </div>
  )

  if ((loading && data === null) || (data !== null && data.day !== day && error === null)) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
        {header}
        <LoadingBlock label="その日の昼食・おやつを読み込んでいます…" />
      </div>
    )
  }
  if (error !== null && (data === null || data.day !== day)) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
        {header}
        <ErrorBlock message={error} onRetry={() => setReloadKey((n) => n + 1)} />
      </div>
    )
  }
  if (data === null) return null

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
      {header}

      <section aria-labelledby="h-meals" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-gap">
          <h2 id="h-meals" className="text-xl font-bold text-ink">
            昼食・おやつ
          </h2>
          <p className="text-base text-ink2">
            その日に来た方 <span className="font-num font-bold text-ink">{came.length}</span>人
          </p>
        </div>
        <p className="text-base text-ink2">押すとすぐ保存します。昼食は care-log の食事の昼食と同じ記録です。</p>

        {came.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-3 text-base text-ink2">
            この日に来た方（在席・帰宅）はまだいません。今日の画面で到着を記録すると、ここに出ます。
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {came.map((row) => {
              const rid = row.residentId
              const name = nameOf(rid)
              const lt = targetOf(rid, 'lunch')
              const stg = targetOf(rid, 'snack')
              const lunch = mealShownFor(lt)
              const snack = mealShownFor(stg)
              const lunchEaten = (lunch?.status ?? 'eaten') === 'eaten'
              const snackEaten = (snack?.status ?? 'eaten') === 'eaten'
              const source = mealSourceLabel(mealRowFor(lt))
              const stL = mealState[mealKeyOf(lt)]
              const stS = mealState[mealKeyOf(stg)]
              const mark = mealBandMark([stL?.kind as MealSaveKind | undefined, stS?.kind as MealSaveKind | undefined])
              return (
                <li key={rid} className="dc-meal-row p-3">
                  <div className="min-w-0 space-y-1">
                    <Link
                      to={personPath(rid, day, today)}
                      className="inline-flex min-h-tap items-center text-lg font-bold text-link underline-offset-2 hover:underline"
                    >
                      {name}
                      <span className="sr-only">さんの1日の記録を開く</span>
                    </Link>
                    <p className="text-sm text-ink2">{cameText(row)}</p>
                    <p className="text-sm text-ink">
                      昼食 <span className="font-bold">{lunchLabel(lunch)}</span>
                      <br />
                      おやつ <span className="font-bold">{snackLabel(snack)}</span>
                    </p>
                    {source !== null && source !== '画面で入力' ? <p className="text-sm text-ink2">{source}</p> : null}
                    {mark !== null ? (
                      <p role="status" className={`text-sm font-bold ${mark.tone === 'ok' ? 'text-ok' : mark.tone === 'warn' ? 'text-warn' : 'text-ink2'}`}>
                        <span aria-hidden="true">{mark.mark} </span>
                        {mark.text}
                      </p>
                    ) : null}
                  </div>
                  <div className="min-w-0 space-y-2">
                    {(['main_amount', 'side_amount'] as const).map((f) => (
                      <div key={f} role="group" aria-label={`${name}さんの昼食 ${f === 'main_amount' ? '主食' : '副食'}の割合`} className="flex flex-wrap items-center gap-2">
                        <span className="w-10 shrink-0 text-sm text-ink2" aria-hidden="true">
                          {f === 'main_amount' ? '主食' : '副食'}
                        </span>
                        {DAYCARE_MEAL_AMOUNTS.map((n) => {
                          const on = lunch?.[f] === n && lunchEaten
                          return (
                            <button
                              key={n}
                              type="button"
                              aria-pressed={on}
                              aria-label={`${f === 'main_amount' ? '主食' : '副食'} ${n}割`}
                              disabled={!canWrite}
                              onClick={() => void saveMeal(lt, withEaten(lunch?.status, { [f]: n }))}
                              className={chipCls(on)}
                            >
                              {n}
                            </button>
                          )
                        })}
                      </div>
                    ))}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <button
                        type="button"
                        aria-pressed={lunch?.status === 'refused'}
                        aria-label={lunch?.status === 'refused' ? `${name}さんの昼食の拒食を取り消す` : `${name}さんの昼食を拒食にする`}
                        disabled={!canWrite}
                        onClick={() => void saveMeal(lt, { status: lunch?.status === 'refused' ? 'eaten' : 'refused' })}
                        className={chipCls(lunch?.status === 'refused')}
                      >
                        {lunch?.status === 'refused' ? '拒食を取り消す' : '拒食'}
                      </button>
                      <div role="group" aria-label={`${name}さんのおやつ`} className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-ink2" aria-hidden="true">
                          おやつ
                        </span>
                        {DAYCARE_SNACK_CHOICES.map((c) => {
                          const on = snack?.main_amount === c.value && snackEaten
                          return (
                            <button
                              key={c.value}
                              type="button"
                              aria-pressed={on}
                              disabled={!canWrite}
                              onClick={() => void saveMeal(stg, withEaten(snack?.status, { main_amount: c.value }))}
                              className={chipCls(on)}
                            >
                              {c.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                    <MealNote word="昼食" st={stL} onTake={(t, fields) => void resolveTake(t, fields)} onMine={(t, cs) => void resolveMine(t, cs)} />
                    <MealNote word="おやつ" st={stS} onTake={(t, fields) => void resolveTake(t, fields)} onMine={(t, cs) => void resolveMine(t, cs)} />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      {toast}
    </div>
  )
}

/**
 * 帯の下の知らせ（送信待ち・失敗・止まり・拒否・食い違い）。送信中・保存できた時は帯の端の印だけで、ここには出さない。
 * 文と解き方は1人の画面の昼食・おやつと同じ
 */
function MealNote({
  word,
  st,
  onTake,
  onMine,
}: {
  word: string
  st: SaveState | undefined
  onTake: (t: MealTarget, fields?: readonly string[]) => void
  onMine: (t: MealTarget, cs: CellConflict[]) => void
}) {
  if (st === undefined || st.kind === 'saving' || st.kind === 'saved') return null
  if (st.kind === 'queued')
    return (
      <p className="text-sm text-ink2">
        <span aria-hidden="true">⚠ </span>
        {word}: {st.persisted ? MSG_QUEUED : MSG_NOT_PERSISTED}
      </p>
    )
  if (st.kind === 'error')
    return (
      <p className="text-sm text-danger" role="alert">
        <span aria-hidden="true">▲ </span>
        {word}: {st.text}
      </p>
    )
  if (st.kind === 'held' || st.kind === 'rejected')
    return (
      <div role="alert" className="space-y-2 rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
        <p>
          <span aria-hidden="true">▲ </span>
          {word}:{' '}
          {st.kind === 'held'
            ? '他の端末の記録と食い違って止まっている値があります（送っていません）。氏名の下の値はサーバーの値です。'
            : `${st.reason === undefined ? '' : `${st.reason} `}サーバーに受け付けられなかった値があります（送っていません）。氏名の下の値はサーバーの値です。`}
          〔取り下げる〕で送信待ちから外し、必要なら押し直してください。
        </p>
        <button type="button" onClick={() => onTake(st.target)} className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink">
          取り下げる
        </button>
      </div>
    )
  const words: Record<string, string> = { main_amount: word === 'おやつ' ? 'おやつ' : '主食', side_amount: '副食', status: '状態' }
  const val = (v: unknown) =>
    v === null || v === undefined
      ? '—'
      : v === 'refused'
        ? '拒食'
        : v === 'eaten'
          ? '食べた'
          : v === 'out'
            ? '外出'
            : v === 'hospital'
              ? '入院'
              : String(v)
  return (
    <div role="alert" className="space-y-2 rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
      <p>
        <span aria-hidden="true">▲ </span>
        {word}: 他の端末が先に記録しました（氏名の下の値はサーバーの値です）。
        {st.conflicts.map((c) => `${words[c.field] ?? c.field}: いまの値 ${val(c.server)}（あなた ${val(c.mine)}）`).join('・')}
      </p>
      <div className="flex flex-wrap gap-gap">
        <button
          type="button"
          onClick={() => onTake(st.target, st.conflicts.map((c) => c.field))}
          className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink"
        >
          いまの値にする
        </button>
        <button type="button" onClick={() => onMine(st.target, st.conflicts)} className="min-h-tap rounded border border-primary bg-surface px-3 text-base text-primary">
          あなたの値で直す
        </button>
      </div>
    </div>
  )
}

export default DaycareMealsPage
