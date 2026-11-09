// デイ せせらぎ 計画B3（2026-11-09 代表者の指示「バイタル一括と食事一括画面は、それぞれだと余白が多く無駄で見づらいため、一つの画面に統合せよ」）:
// バイタル・食事の画面（DaycareVitalsMealsPage・/record/daycare/vitals-meals）の昼食と水分の列（主食｜副食｜水分（cc））。
// それまでの食事一括の画面（/record/daycare/meals）の読み込み・保存・知らせを、そのままフック useDaycareLunchColumns にした
// （処理は変えない。業務日・入力解禁・名簿・〔最新に更新〕は画面から受け取る。日付の切り替えと表の枠・見出しの段は画面が持つ）。
// 食事一括の画面の来歴: 今日の画面の改善 2回目。2026-10-24 代表承認（決定 6・親の回答 1〜2）。2026-10-28（代表者の依頼・親の回答 A1〜A9）に
// 「昼食だけの1行1人の表」にした。
//
// ・並べるのは、一括の画面と同じ方（予定の方のうち休み・入院中を除く全員と、予定外で来た方＝mealBulkRows）。到着の前でも入れられる
//   （2026-10-24 代表者の決定 §9.4 の4。それまでは在席・帰宅だけ）。今日の一覧の並び（五十音）のまま1人1行
// ・主食・副食は端末の選択肢（未・0〜10・拒食）で、選ぶとすぐ保存する。保存の印（✓ 保存済み・⚠ 未送信・▲ 要確認）は画面の「状態」の列に、
//   バイタルの印と合わせて出す（2026-11-09 計画B3）。空の選択肢（未入力）は注意の地＋太い点線で目立たせる（2026-11-09 計画B2）
// ・おやつ（meals の snack）は2026-10-28にこの画面から外した（記録・1人の画面・care-log のおやつはそのまま）
// ・決まりはデイの1人の画面（DaycarePersonPage）の昼食と同じ:
//   - 保存は既存の saveMealEdits（meals の lunch＝care-log の昼食と同じ行）。基準は読んだ時のサーバーの値。
//     送り先は押した時の人・日・枠で固定する（応答の前に日を切り替えても、次の日へ書かない）
//   - 状態は「食べた」「拒食」だけ（外出・入院はデイにいる方の記録なので出さない）。割合を選ぶと、拒食なら「食べた」に戻して送る
//   - 送信待ちの値は欄に重ねて出す。止まった値（食い違い）・拒まれた値は重ねず、サーバーの値を出して行の下で知らせる
//   - 〔元に戻す〕はオンラインで実際に書けた時だけ（送信待ちの時は出さない）
//   - 入力解禁は input_enabled_daycare（saveMealEdits の入口で native_input_enabled も効く）。過去の日は書ける・未来の日は書けない
// ・水分（2026-10-28）: その方・その日の fluid_intake の合計（1人の画面の分も含む）と、数を入れて足す欄。足すのは既存の insertFluid、
//   〔元に戻す〕は softDeleteFluid（1人の画面の水分と同じ記録・同じ決まり）。表示の単位はこの画面だけ「cc」（記録は ml の列・換算しない）。
//   消す・直すは1人の画面の一覧で行う（この画面には一覧を出さない）
// ・取り込みとの関係は既存のまま（画面で入れた行は edited_by が付き、取り込みが上書きしない）。取り込みの印は行の下に小さく出す
//   （2026-11-09 計画B3 の手直しで氏名の列から移した）
// ・端末に業務データを残さない（localStorage を使わない。日付は画面の URL の ?day= で、再読み込みでも同じ日に戻る）

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DbError,
  FORBIDDEN_REASON,
  OUTDATED_REASON,
  discardPendingRow,
  fetchDaycareIntake,
  insertFluid,
  isQueuePersisted,
  kindBlockedMessage,
  pendingRow,
  queuePending,
  saveMealEdits,
  softDeleteFluid,
} from '../lib/db'
import type { CellConflict, CellEditInput, DaycareMealRow, MealCellField, MealTarget } from '../lib/db'
import { useToast } from '../components/ui'
import { buildDaycareBoard, nowHm } from '../lib/daycare'
import { DAYCARE_BLANK_CELL_CLS, lunchBlankFields, lunchShownWith } from '../lib/daycareProgress'
import {
  LUNCH_SELECT_OPTIONS,
  createFluidInputs,
  lunchSelectKeyBlocked,
  fluidTotalOf,
  lunchSelectPatch,
  lunchSelectValue,
  mealBandMark,
  mealBulkRows,
  mealSourceLabel,
  settleQueuedFluid,
} from '../lib/daycarePerson'
import type { LunchAmountField, MealSaveKind } from '../lib/daycarePerson'
import { todayIso } from '../lib/format'
import type { DaycareAttendance, DaycarePlanRow, DaycarePlanSource, FluidIntake, Meal, Resident } from '../lib/types'

const ERR_LOAD = 'デイの記録を読み込めませんでした。通信状態を確認して、再試行してください。'
const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから入れてください。'
const MSG_QUEUED = '電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度押してください。'
const MSG_GATE_UNKNOWN =
  'デイの記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。記録の閲覧はこのままできます。'
const MSG_MISSING = 'デイの記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。'

/** 読んだ食事と水分（2026-11-09 計画B3 の手直し 軽4: その日の写し・予定・出欠は画面が読んだ materials を使う） */
export interface MealsData {
  day: string
  meals: DaycareMealRow[]
  /** その日の水分の記録（全員分・1人の画面の分も含む）。合計に使う */
  fluids: FluidIntake[]
}

type MealField = 'main_amount' | 'side_amount' | 'status'

/**
 * 昼食の保存の状態。人・日・枠ごとに持つ（保存の途中で日を切り替えても、前の日の結果を次の日の行に出さない）。
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

/**
 * 水分の知らせ（人・日ごと。行の下に出す）。queued: 〔元に戻す〕の取り消しを送信待ちにした（その行がサーバーから消えたら外す）。
 * input: 欄に入れた数の誤り（数を直したら外す）。足した分の送信待ちは queuedFluids から出す（届いたら外れる）
 */
type FluidNote = { tone: 'warn' | 'danger' | 'info'; text: string; queued?: { delId: number }; input?: true }

const mealKeyOf = (t: MealTarget) => `${t.residentId}:${t.day}:${t.slot}`
const personKeyOf = (residentId: number, day: string) => `${residentId}:${day}`
/** 水分の表示（この画面だけ cc。記録は ml の列のまま・1cc＝1ml で換算しない） */
const fmtCc = (n: number) => `${n.toLocaleString('ja-JP')}cc`
const AMOUNT_WORD: Record<LunchAmountField, string> = { main_amount: '主食', side_amount: '副食' }

/**
 * 画面が読んだその日の材料（写しか週間計画の予定・出欠・サーバーの設定待ちか）。それまでの食事一括の画面は自前で読んでいた
 * （2026-11-09 計画B3 の手直し 軽4: 同じ物を2回読まない・変更の購読も画面の1組だけ）。画面の読み込みの結果をそのまま渡す
 */
export interface DaycareLunchMaterials {
  day: string
  planRows: DaycarePlanRow[]
  planSource: DaycarePlanSource
  attendance: DaycareAttendance[]
  missing: boolean
}

/** 画面から受け取るもの（業務日・今日・記録者・名簿・入力解禁・〔最新に更新〕の回数）。それまでの食事一括の画面が自前で持っていたもの */
export interface DaycareLunchColumnsInput {
  /** 業務日（画面の URL の ?day=） */
  day: string
  today: string
  actorId: number | null
  residents: Resident[]
  /** 入力解禁（input_enabled_daycare）。画面が getKindInputGate('daycare') で読んだもの */
  gate: { value: boolean; observed: boolean; forbidden?: true; outdated?: true } | null
  /** 〔最新に更新〕で増える（読み直す） */
  reloadKey: number
  /** その日の材料（画面が読んだもの。読めていない間は null） */
  materials: DaycareLunchMaterials | null
  /** 送信待ちが増減した回数（画面の queueSubscribe の数。知らせの出し直しに使う） */
  queueTick: number
}

/** 画面に返すもの（行ごとの列・知らせ・空の欄の数と、読み込みの状態） */
export interface DaycareLunchColumns {
  data: MealsData | null
  loading: boolean
  error: string | null
  /** 1人の空の欄の数（主食・副食の2欄。拒食は入力済み・水分は数えない） */
  blankOf: (residentId: number) => number
  /** 状態の列に出す昼食の保存の印（無ければ null） */
  markOf: (residentId: number) => { mark: string; text: string; tone: 'ok' | 'info' | 'warn' } | null
  /** 主食｜副食｜水分（cc）の3つの欄（td） */
  cells: (residentId: number) => ReactNode
  /** 行の下の知らせ（昼食の外出・入院の記録と取り込みの印、昼食の送信待ち・失敗・止まり・食い違いと水分の知らせ）。無ければ null */
  notes: (residentId: number) => ReactNode
  /** 昼食の〔元に戻す〕・水分の〔元に戻す〕の知らせ（画面の最後に置く） */
  toast: ReactNode
  /**
   * 同じ知らせの部品に出す（2026-11-10 未測定: バイタルの〔未測定〕の〔元に戻す〕も同じ所に出す＝知らせを2つ重ねない）。
   * undo を渡すと〔元に戻す〕つき（8秒）
   */
  show: (msg: string, undo?: () => void) => void
  /** 静かに読み直す（画面の購読が食事・水分の変更と、送信待ちが送れて減った時に呼ぶ） */
  reload: () => void
}

export function useDaycareLunchColumns({
  day,
  today,
  actorId,
  residents,
  gate,
  reloadKey,
  materials,
  queueTick,
}: DaycareLunchColumnsInput): DaycareLunchColumns {
  const [data, setData] = useState<MealsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [mealState, setMealState] = useState<Record<string, SaveState>>({})
  /** 順番待ちの保存（人・日・枠ごと・押した順）。送り終わるまで画面に重ねて出す */
  const [waiting, setWaiting] = useState<Record<string, { id: number; values: Partial<Record<MealField, number | string | null>> }[]>>({})
  const waitSeqRef = useRef(0)
  /** 人・日・枠ごとの順番待ちの末尾 */
  const chainRef = useRef(new Map<string, Promise<void>>())
  /** 水分の欄に入れている数（人ごと。日を切り替えたら空にする。端末には残さない）。読み書きは控え（fluidInputs）で行い、描画にはこの写しを使う */
  const [fluidText, setFluidText] = useState<Record<number, string>>({})
  /** 水分の欄の控え（描画を待たずに読み書きする。送る前に空にして、続けて届いた改行キーで同じ量を2回送らない＝2026-10-29 親の検収） */
  const [fluidInputs] = useState(() => createFluidInputs('cc'))
  /** 水分の知らせ（人・日ごと） */
  const [fluidNote, setFluidNote] = useState<Record<string, FluidNote>>({})
  /**
   * 送信待ちの水分（人・日ごと）。base＝退避した時のサーバーの合計、ml＝まだ載っていない量、lost＝端末に控えを残せなかった。
   * 合計に重ねて出し、取り直した合計で載った分だけ減らす（1人の画面の queuedFluids と同じ消し込み＝settleQueuedFluid）
   */
  const [queuedFluids, setQueuedFluids] = useState<Record<string, { base: number; ml: number; lost: boolean }>>({})
  /** 取り消し（〔元に戻す〕）を送信待ちにした水分の行（id → その行の日。その日の読み込みでサーバーから消えるまで合計から外す） */
  const [hiddenFluidIds, setHiddenFluidIds] = useState<Map<number, string>>(new Map())
  /** 書き込み中の水分（人・日ごと）。その方の欄と〔＋〕を押せなくする（二重に足さない）。ref は描画を待たずに止めるため */
  const [fluidBusy, setFluidBusy] = useState<ReadonlySet<string>>(new Set())
  const fluidBusyRef = useRef(new Set<string>())
  const { toast, show } = useToast()
  const genRef = useRef(0)
  const dayRef = useRef(day)
  dayRef.current = day
  /**
   * いちばん新しいデータの控え（読み込みと自分の保存の応答で、描画を待たずにすぐ入れ替える）。
   * 順番待ちの保存は、送る時にここから基準を取る（前の保存の応答が描画に出る前でも、最新の値を基準にする＝#45 の確認の反証 中）
   */
  const dataRef = useRef<MealsData | null>(null)
  /** 自分の保存の応答の時刻（行の id ごと）。その後に始まった読み込みには載っている */
  const savedAtRef = useRef(new Map<number, number>())
  /** 自分が足した水分・取り消した水分の応答の時刻（行の id ごと。読み込みの取り違えを防ぐのは昼食と同じ考え） */
  const fluidAddedAtRef = useRef(new Map<number, number>())
  const fluidGoneAtRef = useRef(new Map<number, number>())
  const commitData = useCallback((next: MealsData) => {
    dataRef.current = next
    setData(next)
  }, [])

  const load = useCallback(async (target: string, quiet: boolean) => {
    const gen = ++genRef.current
    const startedAt = Date.now()
    if (!quiet) {
      setLoading(true)
      setError(null)
    }
    try {
      // 2026-11-09 計画B3 の手直し（軽4）: その日の写し・予定・出欠は画面が読んだもの（materials）を使い、ここでは食事と水分だけを読む
      const intake = await fetchDaycareIntake(target)
      if (gen !== genRef.current || target !== dayRef.current) return
      // 読み込みを始めた後に自分の保存の応答で受け取った行は、読んだ行より新しいことがある（版 rev の大きい方を残す）
      const prev = dataRef.current
      const meals = intake.meals.map((m) => {
        const mine = prev !== null && prev.day === target ? prev.meals.find((x) => x.meal.id === m.meal.id) : undefined
        return mine !== undefined && (savedAtRef.current.get(m.meal.id) ?? 0) > startedAt && mine.meal.rev > m.meal.rev ? mine : m
      })
      if (prev !== null && prev.day === target)
        for (const mine of prev.meals)
          if ((savedAtRef.current.get(mine.meal.id) ?? 0) > startedAt && !meals.some((m) => m.meal.id === mine.meal.id)) meals.push(mine)
      // 水分も同じ: 読み込みを始めた後に自分が取り消した行は外し、自分が足した行は残す（合計が一時的に増減して見えない）
      const fluids = intake.fluids.filter((f) => (fluidGoneAtRef.current.get(f.id) ?? 0) <= startedAt)
      if (prev !== null && prev.day === target)
        for (const mine of prev.fluids)
          if ((fluidAddedAtRef.current.get(mine.id) ?? 0) > startedAt && !fluids.some((f) => f.id === mine.id)) fluids.push(mine)
      commitData({ day: target, meals, fluids })
      setError(null)
    } catch {
      if (gen !== genRef.current) return
      if (!quiet) setError(ERR_LOAD)
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [commitData])

  useEffect(() => {
    // 日の切り替えと〔最新に更新〕では、その場限りの知らせ（保存しました・保存できませんでした）を外す。
    // 送信待ち・食い違い・拒否の知らせは残し、届いた・解けたと分かった時に外す（下の出し直し）
    setMealState((prev) => {
      const next: Record<string, SaveState> = {}
      for (const [k, v] of Object.entries(prev)) if (v.kind !== 'saved' && v.kind !== 'error') next[k] = v
      return next
    })
    // 水分の欄に入れかけた数と、その場限りの知らせも外す（取り消しの送信待ちの知らせは残す）
    fluidInputs.clearAll()
    setFluidText(fluidInputs.all())
    setFluidNote((prev) => {
      const next: Record<string, FluidNote> = {}
      for (const [k, v] of Object.entries(prev)) if (v.queued !== undefined) next[k] = v
      return next
    })
    void load(day, false)
  }, [day, reloadKey, load])

  // 他の端末の変更（Realtime）と送信待ちの減り（送れた）で静かに読み直す。2026-11-09 計画B3 の手直し（軽4）: 購読は画面の1組
  // （subscribeChanges の meals・fluid_intake と queueSubscribe）で、画面がここの reload を呼ぶ（購読の数を増やさない）
  const reloadTimer = useRef<number | null>(null)
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null
      void load(dayRef.current, true)
    }, 400)
  }, [load])
  useEffect(
    () => () => {
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    },
    [],
  )

  // その日の材料は画面が読んだもの（同じ日の時だけ使う）
  const mat = materials !== null && materials.day === day ? materials : null
  const board = useMemo(
    () => (mat === null ? null : buildDaycareBoard({ planRows: mat.planRows, source: mat.planSource, residents, attendance: mat.attendance })),
    [mat, residents],
  )
  const came = useMemo(() => (board === null ? [] : mealBulkRows(board.rows)), [board])
  const cameKey = came.map((r) => r.residentId).join(',')
  const nameOf = (id: number) => residents.find((r) => r.id === id)?.name ?? `利用者ID ${id}`
  const missing = mat?.missing ?? false
  const canWrite = gate !== null && gate.observed && gate.value === true && !missing && day <= today
  /** 合計に入れる水分の記録（取り消しを送信待ちにした行を除く） */
  const visibleFluids = useMemo(() => (data === null ? [] : data.fluids.filter((f) => !hiddenFluidIds.has(f.id))), [data, hiddenFluidIds])

  // ── 昼食（1人の画面と同じ決まり） ──
  const targetOf = (residentId: number): MealTarget => ({ residentId, day, slot: 'lunch' })
  const mealRowFor = (t: MealTarget): DaycareMealRow | null => {
    const d = dataRef.current
    return d === null || d.day !== t.day ? null : (d.meals.find((m) => m.meal.resident_id === t.residentId && m.meal.meal_slot === t.slot) ?? null)
  }
  /**
   * 画面に出す値: 送信待ち（まだ送っていない・送っている途中）の値だけ重ねる。止まった値（食い違い）・拒まれた値は重ねず、
   * サーバーの値を出して行の下で知らせる（1人の画面・既存の食事一括と同じ）。順番待ちの値（後に押した方）→ 送信待ちの値 → サーバーの値。
   * 2026-11-09 計画B: 今日の画面の印と同じ純関数（daycareProgress.ts の lunchShownWith。中身は前と同じ）
   */
  const mealShownFor = (t: MealTarget): Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null =>
    lunchShownWith(mealRowFor(t)?.meal ?? null, pendingRow('meals', t), waiting[mealKeyOf(t)] ?? [])
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
   * 昼食の欄を保存する（既存の saveMealEdits。rebase は〔あなたの値で直す〕・〔元に戻す〕）。
   * 送り先（t）は押した時の人・日・枠で固定する（応答の前に日を切り替えても、次の日へ書かない）。
   * 同じ人・日・枠は順番待ちにして、前の保存の応答を待ってから次を送る（基準をいちばん新しいサーバーの値にする。
   * 続けて押した時に値が古い値へ戻って見える・自分の書き込みを「他の端末が先に記録しました」と出す、を防ぐ＝
   * care-log の食事一括の行ごとの順番待ちと同じ・#45 の確認の反証 中）。順番待ちの値は画面に重ねて出す
   */
  const saveMeal = (
    t: MealTarget,
    patch: Partial<Record<MealField, number | string | null>>,
    opts: { rebase?: Record<string, unknown>; undoable?: boolean } = {},
  ): Promise<void> => {
    const why = precheck()
    if (why !== null) {
      setMealFor(t, { kind: 'error', text: why })
      return Promise.resolve()
    }
    const k = mealKeyOf(t)
    const id = ++waitSeqRef.current
    setWaiting((prev) => ({ ...prev, [k]: [...(prev[k] ?? []), { id, values: patch }] }))
    const tail = (chainRef.current.get(k) ?? Promise.resolve())
      .then(() => sendMeal(t, patch, opts))
      .catch(() => {})
      .finally(() => {
        setWaiting((prev) => {
          const rest = (prev[k] ?? []).filter((w) => w.id !== id)
          const next = { ...prev }
          if (rest.length === 0) delete next[k]
          else next[k] = rest
          return next
        })
        if (chainRef.current.get(k) === tail) chainRef.current.delete(k)
      })
    chainRef.current.set(k, tail)
    return tail
  }

  /** 順番が来た保存を送る（基準・記入者・〔元に戻す〕の値は、送る時のいちばん新しい値から取る） */
  const sendMeal = async (
    t: MealTarget,
    patch: Partial<Record<MealField, number | string | null>>,
    opts: { rebase?: Record<string, unknown>; undoable?: boolean },
  ) => {
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
        const prev = dataRef.current
        // 日を移った後の応答は前の日の表に入れない
        if (prev !== null && prev.day === saved.meal_on) {
          const old = prev.meals.find((m) => m.meal.id === saved.id)
          const meals = [
            ...prev.meals.filter((m) => m.meal.id !== saved.id),
            // 画面の入力の印は、実際に書けた時だけ（同じ値＝何も書かなかった時は edited_by が付かない）
            { meal: saved, imported: old?.imported ?? false, editedInApp: (old?.editedInApp ?? false) || wrote },
          ]
          savedAtRef.current.set(saved.id, Date.now())
          commitData({ ...prev, meals })
        }
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
        const undoPatch: Partial<Record<MealField, number | string | null>> = {}
        for (const f of Object.keys(patch) as MealField[]) undoPatch[f] = before?.[f] ?? null
        show(`${nameOf(t.residentId)}さんの昼食を記録しました`, () => {
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

  // 読み込みの後と、送信待ちが動いた時（背景の再送で止まった・拒まれた・届いた）: 行の下の知らせを、送信待ちの今の状態に合わせて出し直す
  // （止まった値を保存済みのように見せない。画面を開いたまま背景で止まった時も切り替える＝1人の画面と同じ）
  useEffect(() => {
    if (data === null) return
    const ids = cameKey === '' ? [] : cameKey.split(',').map(Number)
    setMealState((prev) => {
      let next = prev
      for (const residentId of ids) {
        const t: MealTarget = { residentId, day: data.day, slot: 'lunch' }
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
        } else if (p !== null && p.state === 'pending' && (cur === undefined || cur.kind === 'saved')) {
          // まだ届いていない値（開き直した時・別のタブや1人の画面で入れた分・送り直しの待ち）: 値だけ押された状態に見せず、
          // 氏名の列と行の下に「未送信」を出す（care-log の食事一括と同じ＝#45 の反証 中2）
          st = { kind: 'queued', persisted: isQueuePersisted() }
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

  // ── 水分（1人の画面の addFluid・removeFluid・queuedFluids と同じ決まり） ──
  // 読み込みの後: 送信待ちの水分は、取り直した合計（取り消しを送信待ちにして外した行を除く）で載った分だけ減らす（観測ベース）。
  // 未送信が1件も無ければ、送信待ちの水分も残さない（届いた後に読み直している＝消し込みの取りこぼしの安全網）。
  // 取り消しを送った行は、その行の日の読み込みでサーバーから消えたら外す（別の日を読んだだけでは外さない）
  useEffect(() => {
    if (data === null) return
    const nothingQueued = queuePending() === 0
    setQueuedFluids((prev) => {
      let next = prev
      for (const [k, held] of Object.entries(prev)) {
        const [ridText, d] = k.split(':')
        if (d !== data.day && !nothingQueued) continue
        const r = nothingQueued ? null : settleQueuedFluid(held, fluidTotalOf(visibleFluids, Number(ridText), d))
        if (r !== null && r.base === held.base && r.ml === held.ml) continue
        if (next === prev) next = { ...prev }
        if (r === null) delete next[k]
        else next[k] = { ...held, ...r }
      }
      return next
    })
    setHiddenFluidIds((prev) => {
      const gone = [...prev].filter(([id, d]) => d === data.day && !data.fluids.some((f) => f.id === id))
      if (gone.length === 0) return prev
      const still = new Map(prev)
      for (const [id] of gone) still.delete(id)
      return still
    })
  }, [data, visibleFluids])
  // 取り消しを送信待ちにした旨の一言は、その行がサーバーから消えたと観測できたら外す
  useEffect(() => {
    if (data === null) return
    setFluidNote((prev) => {
      let next = prev
      for (const [k, n] of Object.entries(prev)) {
        if (n.queued === undefined || !k.endsWith(`:${data.day}`)) continue
        const delId = n.queued.delId
        if (data.fluids.some((f) => f.id === delId)) continue
        if (next === prev) next = { ...prev }
        delete next[k]
      }
      return next
    })
  }, [data])

  const noteFluid = (key: string, n: FluidNote | null) =>
    setFluidNote((prev) => {
      if (n === null && prev[key] === undefined) return prev
      const next = { ...prev }
      if (n === null) delete next[key]
      else next[key] = n
      return next
    })
  /** その場限りの知らせ（失敗・確かめ・数の誤り）を外す。取り消しの送信待ちの知らせは、サーバーから消えるまで残す */
  const clearPlainNote = (key: string) =>
    setFluidNote((prev) => {
      const cur = prev[key]
      if (cur === undefined || cur.queued !== undefined) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  const setBusyFor = (key: string, on: boolean) => {
    if (on) fluidBusyRef.current.add(key)
    else fluidBusyRef.current.delete(key)
    setFluidBusy(new Set(fluidBusyRef.current))
  }

  /**
   * 水分を足す（既存の insertFluid＝1人の画面の addFluid と同じ値）。送り先（人・日）は押した時に固定する。
   * 足せた（送信待ちにできた）時は true（欄を空にする）
   */
  const addFluid = async (rid: number, ml: number): Promise<boolean> => {
    const d = day
    const key = personKeyOf(rid, d)
    const why = precheck()
    if (why !== null) {
      noteFluid(key, { tone: 'warn', text: why })
      return false
    }
    if (fluidBusyRef.current.has(key)) return false
    setBusyFor(key, true)
    try {
      const r = await insertFluid({
        resident_id: rid,
        taken_on: d,
        // 今日だけいまの時刻（過去の日にいまの時刻を入れない＝1人の画面と同じ）
        taken_at: d === todayIso() ? nowHm() : null,
        amount_ml: ml,
        kind: null,
        recorded_by: actorId,
      })
      if (r === 'queued') {
        const persisted = isQueuePersisted()
        setQueuedFluids((prev) => {
          const held = prev[key]
          const cur = dataRef.current
          // base は最初に退避した時点のサーバーの合計を保つ（重ねて退避しても基準をずらさない）
          const base =
            held !== undefined
              ? held.base
              : cur === null || cur.day !== d
                ? 0
                : fluidTotalOf(
                    cur.fluids.filter((x) => !hiddenFluidIds.has(x.id)),
                    rid,
                    d,
                  )
          return { ...prev, [key]: { base, ml: (held?.ml ?? 0) + ml, lost: (held?.lost ?? false) || !persisted } }
        })
        clearPlainNote(key)
        return true
      }
      const saved = r
      const prev = dataRef.current
      // 日を移った後の応答は前の日の表に入れない
      if (prev !== null && prev.day === saved.taken_on) {
        fluidAddedAtRef.current.set(saved.id, Date.now())
        commitData({ ...prev, fluids: [...prev.fluids, saved] })
        // 送信待ちの水分がある時は、その基準もいま足した分だけ上げる（自分がいま足した分を「送信待ちが載った」と見て減らさない）
        setQueuedFluids((q) => {
          const held = q[key]
          return held === undefined ? q : { ...q, [key]: { ...held, base: held.base + saved.amount_ml } }
        })
      }
      clearPlainNote(key)
      if (dayRef.current === d) {
        show(`${nameOf(rid)}さんの水分 ＋${fmtCc(ml)} を記録しました`, () => void undoFluid(saved))
      }
      return true
    } catch (e) {
      noteFluid(key, { tone: 'danger', text: e instanceof DbError ? e.message : '保存できませんでした。通信状態を確認して、もう一度押してください。' })
      return false
    } finally {
      setBusyFor(key, false)
    }
  }
  /** 〔元に戻す〕: 足した水分を取り消す（既存の softDeleteFluid＝1人の画面の removeFluid(fromUndo) と同じ扱い。取り消せた時のトーストは出さない） */
  const undoFluid = async (f: FluidIntake) => {
    const key = personKeyOf(f.resident_id, f.taken_on)
    const why = precheck()
    if (why !== null) {
      noteFluid(key, { tone: 'warn', text: why })
      return
    }
    try {
      const r = await softDeleteFluid(f.id, f.rev, { editedBy: actorId })
      if (r === 'queued') {
        // 取り消しを送信待ちにした: 合計からは先に外す（同じ行の取り消しを二重に積まない）。控えを残せたかで文言を分ける
        setHiddenFluidIds((prev) => new Map([...prev, [f.id, f.taken_on]]))
        const persisted = isQueuePersisted()
        noteFluid(key, { tone: persisted ? 'info' : 'danger', text: `${fmtCc(f.amount_ml)} の取り消し：${persisted ? MSG_QUEUED : MSG_NOT_PERSISTED}`, queued: { delId: f.id } })
      } else if (r === true) {
        fluidGoneAtRef.current.set(f.id, Date.now())
        const prev = dataRef.current
        if (prev !== null) commitData({ ...prev, fluids: prev.fluids.filter((x) => x.id !== f.id) })
      } else {
        noteFluid(key, { tone: 'warn', text: '他の端末が先にこの記録を直していました。最新の内容に読み直しました。確かめてから、もう一度押してください。' })
        scheduleReload()
      }
    } catch (e) {
      noteFluid(key, { tone: 'danger', text: e instanceof DbError ? e.message : '取り消せませんでした。通信状態を確認して、もう一度押してください。' })
    }
  }
  /** 水分の欄の数を足す（改行キー＝form の submit・〔＋〕のどちらでも）。検査は fluidAmountError（1〜2000） */
  const submitFluid = (rid: number) => {
    const d = day
    const key = personKeyOf(rid, d)
    if (fluidBusyRef.current.has(key)) return
    // 送る前に欄を空にする（描き直しを待たずに控えも空にする。書き込みの後、欄が空になる描き直しの前に続けて届いた改行キーで、
    // 同じ量をもう1回送らない＝2026-10-29 親の検収）
    const t = fluidInputs.take(rid)
    if (t.kind === 'ignored') return
    if (t.kind === 'error') {
      noteFluid(key, { tone: 'danger', text: t.message, input: true })
      return
    }
    setFluidText(fluidInputs.all())
    void addFluid(rid, t.ml).then((ok) => {
      // 足せた: ここから少しの間だけ、空の改行キー（押しっぱなしの続き）を無視する（確認の反証 軽1）
      if (ok) fluidInputs.done(rid)
      // 足せなかった時は入れた数を欄に戻す（日を移った後・その間に欄へ入れ直した時は戻さない）
      else if (dayRef.current === d && fluidInputs.restore(rid, t.text)) setFluidText(fluidInputs.all())
    })
  }

  // ── 画面に返すもの（2026-11-09 計画B3: それまでの食事一括の画面の表の行の中身。見出しの段・表の枠・氏名の列は画面が持つ） ──
  // 未入力の数は画面に出している値（送信待ち・順番待ちを重ねた値）で数える。2026-11-09 計画B2: 到着を問わず、1人2欄（主食・副食。
  // 拒食はどちらも入力済み・水分は数えない）の空の欄を数える（画面がバイタルの5欄と合わせて bulkBlankSummary に渡す）
  const blankOf = (rid: number) => lunchBlankFields(mealShownFor(targetOf(rid)))
  // 左右の余白は 4px（2026-11-09 計画B3 の手直し: 行の高さを欄の 44px に保ったまま、iPad 横 1180px で横に送らずに収めるため 8px から詰めた）
  const selectCls = 'min-h-tap min-w-tap rounded border border-border-strong bg-surface px-1 text-lg text-ink disabled:text-ink3'
  // 空の選択肢（未入力）の見た目（2026-11-09 計画B2）。枠と地は selectCls と排他（重ねない）。「未」の字は選択肢の文字で出る
  // （バイタルの空の枠と同じ「未」・凡例の「未＝未入力」。読み上げは「いま: 未入力」）
  const selectBlankCls = `min-h-tap min-w-tap rounded ${DAYCARE_BLANK_CELL_CLS} px-1 text-lg text-ink disabled:text-ink3`
  // 順番待ちが残っている枠は「送信中」（前の応答の「保存済み」を出したままにしない）
  const kindOf = (t: MealTarget, st: SaveState | undefined): MealSaveKind | undefined =>
    (waiting[mealKeyOf(t)]?.length ?? 0) > 0 ? 'saving' : (st?.kind as MealSaveKind | undefined)
  const markOf = (rid: number) => {
    const lt = targetOf(rid)
    return mealBandMark([kindOf(lt, mealState[mealKeyOf(lt)])])
  }
  const cells = (rid: number): ReactNode => {
    const name = nameOf(rid)
    const lt = targetOf(rid)
    const lunch = mealShownFor(lt)
    const fkey = personKeyOf(rid, day)
    const busy = fluidBusy.has(fkey)
    const held = queuedFluids[fkey]
    const fn = fluidNote[fkey]
    const fluidSum = fluidTotalOf(visibleFluids, rid, data?.day ?? day)
    return (
      <>
        {(['main_amount', 'side_amount'] as const).map((f) => {
          const v = lunchSelectValue(lunch, f)
          const now = v === '' ? '未入力' : v === 'refused' ? '拒食' : v
          return (
            <td key={f} className="px-1 py-1">
              <select
                value={v}
                disabled={!canWrite}
                aria-label={`${AMOUNT_WORD[f]}：${name}さん（いま: ${now}）`}
                // テンキーの KT の次にフォーカスを移す先（主食だけ・2026-11-09 計画B3）
                data-dc-lunch-main={f === 'main_amount' ? rid : undefined}
                // 数字キー（0〜9・テンキーの数字・全角）は選択肢の頭文字選びに使わせない（KT の後に主食へ移った時、物理キーボードで打ち続けた
                // 数字で主食が書き換わってすぐ保存されるのを防ぐ＝2026-11-09 計画B3 の反証 中1）。矢印・Enter・Space・Tab の操作はそのまま
                onKeyDown={(e) => {
                  if (lunchSelectKeyBlocked(e.key)) e.preventDefault()
                }}
                onChange={(e) => {
                  const patch = lunchSelectPatch(f, e.target.value, lunch?.status)
                  if (patch !== null) void saveMeal(lt, patch)
                }}
                className={v === '' ? selectBlankCls : selectCls}
              >
                {LUNCH_SELECT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </td>
          )
        })}
        <td className="px-1 py-1">
          {/* 合計は入れる欄の横（2026-11-09 計画B3 の手直し: #104 の食事一括と同じ並び・行の高さを欄の 44px に保つ）。
              単位は見出しの「水分（cc）」で示し、欄には数だけを出す（iPad 横 1180px で横に送らずに収める幅）。合計の幅は 64px 以上で
              そろえる（「計 —」の行でも入れる欄の位置がそろう）。送信待ちの量は行の下の知らせ（水分 ＋n cc: …）で出す。
              入れる欄は 80px から 56px に詰めた（左右の余白 4px で、中は 4桁が入る 48px） */}
          <div className="flex items-center gap-x-1.5">
            <p className="min-w-16 whitespace-nowrap text-sm text-ink">
              計 <span className="font-num font-bold">{fluidSum > 0 ? fluidSum.toLocaleString('ja-JP') : '—'}</span>
              {held !== undefined ? <span className="sr-only">（＋{fmtCc(held.ml)} 送信待ち）</span> : null}
            </p>
            {/* 数を入れて改行キー（form の submit）か〔＋〕で足す。書き込み中は欄を書き換えられず〔＋〕も押せない（二重に足さない）。
                欄は disabled にせず readOnly にする（改行キーの後も欄に留まり、続けて入れられる） */}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                submitFluid(rid)
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={fluidText[rid] ?? ''}
                onChange={(e) => {
                  fluidInputs.set(rid, e.target.value)
                  setFluidText(fluidInputs.all())
                  if (fn?.input === true) noteFluid(fkey, null)
                }}
                readOnly={busy}
                disabled={!canWrite}
                aria-label={`水分（cc）：${name}さんに足す量`}
                aria-invalid={fn?.input === true ? true : undefined}
                aria-describedby={fn !== undefined ? `dc-fluid-note-${rid}` : undefined}
                className="block min-h-tap w-14 rounded border border-border-strong bg-surface px-1 text-lg text-ink disabled:text-ink3"
              />
              <button
                type="submit"
                disabled={!canWrite || busy}
                aria-label={`水分を足す（${name}さん）`}
                className="min-h-tap min-w-tap rounded border border-primary bg-surface px-2 text-lg font-bold text-primary disabled:border-border disabled:text-ink3"
              >
                ＋
              </button>
            </form>
          </div>
        </td>
      </>
    )
  }
  const notes = (rid: number): ReactNode => {
    const name = nameOf(rid)
    const lt = targetOf(rid)
    const stL = mealState[mealKeyOf(lt)]
    const fkey = personKeyOf(rid, day)
    const held = queuedFluids[fkey]
    const fn = fluidNote[fkey]
    const lunch = mealShownFor(lt)
    const source = mealSourceLabel(mealRowFor(lt))
    // 外出・入院（care-log の食事の画面で入れた状態）は選択肢に無いので、文字で出す（選ぶと「食べた」に戻して送る）。
    // 取り込みの印も同じ行に出す（2026-11-09 計画B3 の手直し: 氏名の列に積まず、行の下の知らせへ＝行の高さを 53px に保つ）
    const otherStatus = lunch?.status === 'out' ? '外出' : lunch?.status === 'hospital' ? '入院' : null
    const showSource = source !== null && source !== '画面で入力'
    const lunchNote = stL !== undefined && stL.kind !== 'saving' && stL.kind !== 'saved'
    const detail = lunchNote || held !== undefined || fn !== undefined || otherStatus !== null || showSource
    if (!detail) return null
    return (
      <>
        {otherStatus !== null || showSource ? (
          <p className="text-sm text-ink2">
            <span className="sr-only">{name}さん：</span>
            {otherStatus !== null ? `昼食の記録: ${otherStatus}` : ''}
            {otherStatus !== null && showSource ? '・' : ''}
            {showSource ? source : ''}
          </p>
        ) : null}
        <MealNote
          word="昼食"
          name={name}
          st={stL}
          onTake={(t, fields) => void resolveTake(t, fields)}
          onMine={(t, cs) => void resolveMine(t, cs)}
        />
        {held !== undefined ? (
          <p role="status" className={`text-sm ${held.lost ? 'text-danger' : 'text-ink2'}`}>
            <span aria-hidden="true">⚠ </span>
            <span className="sr-only">{name}さん：</span>水分 ＋{fmtCc(held.ml)}: {held.lost ? MSG_NOT_PERSISTED : MSG_QUEUED}
          </p>
        ) : null}
        {fn !== undefined ? (
          <p
            id={`dc-fluid-note-${rid}`}
            role={fn.tone === 'danger' ? 'alert' : 'status'}
            className={`text-sm ${fn.tone === 'danger' ? 'text-danger' : fn.tone === 'warn' ? 'text-warn' : 'text-ink2'}`}
          >
            <span aria-hidden="true">{fn.tone === 'info' ? '⚠ ' : '▲ '}</span>
            <span className="sr-only">{name}さん：</span>水分: {fn.text}
          </p>
        ) : null}
      </>
    )
  }

  return { data, loading, error, blankOf, markOf, cells, notes, toast, show, reload: scheduleReload }
}

/**
 * 行の下の昼食の知らせ（送信待ち・失敗・止まり・拒否・食い違い）。送信中・保存できた時は状態の列の印だけで、ここには出さない。
 * 文と解き方は1人の画面の昼食と同じ
 */
function MealNote({
  word,
  name,
  st,
  onTake,
  onMine,
}: {
  word: string
  name: string
  st: SaveState | undefined
  onTake: (t: MealTarget, fields?: readonly string[]) => void
  onMine: (t: MealTarget, cs: CellConflict[]) => void
}) {
  if (st === undefined || st.kind === 'saving' || st.kind === 'saved') return null
  const who = <span className="sr-only">{name}さん：</span>
  if (st.kind === 'queued')
    return (
      <p className="text-sm text-ink2">
        <span aria-hidden="true">⚠ </span>
        {who}
        {word}: {st.persisted ? MSG_QUEUED : MSG_NOT_PERSISTED}
      </p>
    )
  if (st.kind === 'error')
    return (
      <p className="text-sm text-danger" role="alert">
        <span aria-hidden="true">▲ </span>
        {who}
        {word}: {st.text}
      </p>
    )
  if (st.kind === 'held' || st.kind === 'rejected')
    return (
      <div role="alert" className="space-y-2 rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
        <p>
          <span aria-hidden="true">▲ </span>
          {who}
          {word}:{' '}
          {st.kind === 'held'
            ? '他の端末の記録と食い違って止まっている値があります（送っていません）。表の主食・副食はサーバーの値です。'
            : `${st.reason === undefined ? '' : `${st.reason} `}サーバーに受け付けられなかった値があります（送っていません）。表の主食・副食はサーバーの値です。`}
          〔取り下げる〕で送信待ちから外し、必要なら選び直してください。
        </p>
        <button type="button" onClick={() => onTake(st.target)} className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink">
          取り下げる
        </button>
      </div>
    )
  const words: Record<string, string> = { main_amount: '主食', side_amount: '副食', status: '状態' }
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
        {who}
        {word}: 他の端末が先に記録しました（表の主食・副食はサーバーの値です）。
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

