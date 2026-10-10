// 食い違いの解決画面（くらべて選ぶ）。5画面（バイタル一覧・バイタル一括・食事一覧・食事一括・
// 日報のバイタル欄）が共通で使う。各画面で重複実装しない。
// 申し送り（日報・タイムライン・送れていない申し送りの一覧）は下の NoteConflictResolver（2026-09-29）。
//
// 流れ:
// - 開いた時にサーバーの最新の1行を取り直す（db.ts の fetchLatestVital / fetchLatestMeal）
// - 食い違っている列ごとに「先に入っている値（記入者・時刻）」と「あなたの入力」を並べる
// - 3択: 先の値を残す／自分の値で直す／両方残す（各 44px 以上・文字ラベルつき）
// - 送信は送信待ち（db.ts の pending store）→ RPC apply_cell_edits の1本（2026-09-23 フェーズ2' 第2段）:
//     自分の値で直す … 取り直した最新の値を基準にして送り直す（rebase）。血圧は上下を組で送る（第3段 #3）
//     両方残す     … バイタルは再検（または同じ種別）の新しい行（冪等キー）、食事はメモの追記（基準は取り直したメモ）。
//                    元の行の「あなたの入力」は、新しい保存が書けた・送信待ちに確保できた後で外す（第3段 #8。
//                    拒否・競合の時は外さない＝元のまま）
//     先の値を残す … 元の行の「あなたの入力」を送信待ちから外す
//   外すのは、開いた時に見せた「あなたの入力」の版だけ（第3段 #9。見た後に打ち直した値は外さない）
// - 自分の値で直す・両方残す（食事）で再び競合したら、取り直して出し直す（自動再試行はしない）
// - 取り直しに失敗したら理由と〔もう一度〕を出す。閉じても入力は残る（競合状態のまま）
// - どれを選んだかは変更の記録（record_history）で追える
//
// 規律: トークン由来クラスのみ・色だけで意味を伝えない・実名や記録本文をコードに書かない・console 出力なし

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  DbError,
  deleteNote,
  discardPendingNote,
  discardPendingRow,
  fetchLatestMeal,
  fetchLatestNote,
  fetchLatestVital,
  fetchAllStaff,
  fetchStaff,
  insertNoteAsNew,
  newClientKey,
  noteAsNewKey,
  pendingNoteRow,
  pendingRow,
  resolveNoteMeta,
  saveMealEdits,
  saveNoteEdits,
  saveVitalEdits,
} from '../lib/db'
import type {
  CellEditInput,
  LatestRow,
  MealTarget,
  NoteEditField,
  NoteMeta,
  PendingNoteRow,
  VitalTarget,
} from '../lib/db'
import { fmtDayLabel } from '../lib/format'
import { recordTimeFor } from '../lib/nextMorning'
import { IMPORTANCE_LABEL, MEAL_SLOT_LABEL, NOTE_COLOR_LABEL, SHIFT_LABEL } from '../lib/types'
import type {
  Importance,
  Meal,
  MealSlot,
  MealStatus,
  Note,
  NoteColor,
  Shift,
  Staff,
  Vital,
  VitalKind,
} from '../lib/types'
import {
  MEAL_FIELDS,
  MEAL_FIELD_NAME,
  VITAL_FIELDS,
  VITAL_FIELD_NAME,
  appendAltMealNote,
  conflictColumns,
  describeMine,
  fmtMealValue,
  fmtStamp,
  fmtTimeValue,
  fmtVitalValue,
  patchForMine,
  recorderName,
  valuesForBoth,
  withBpPair,
} from '../lib/conflict'
import { seenVers } from '../lib/rowSync'
import type { MealField, VitalField } from '../lib/conflict'
import { ModalShell } from './ui'

/** くらべる対象の1行 */
export type ConflictTarget =
  | {
      table: 'vitals'
      residentId: number
      day: string
      kind: VitalKind
      /** 行の id（定時は利用者×日付で引くので null でもよい） */
      vitalId: number | null
    }
  | { table: 'meals'; residentId: number; day: string; slot: MealSlot }

/** 選んだ結果（画面はこれを受けてその行を描き直し、競合の表示を消す） */
export interface ConflictResolution {
  /** reload＝食い違いが無かった／先の記録が見つからなかったので、最新を読み込むだけ */
  choice: 'theirs' | 'mine' | 'both' | 'reload'
  /** 選んだ後のいまの行（送信待ちの時は送った内容を重ねた行・見つからない時は null） */
  latest: Vital | Meal | null
  /** 通信できず送信待ちにした（画面は送信待ちとして扱う） */
  queued: boolean
}

export interface ConflictResolverProps {
  /** null の間は閉じている */
  target: ConflictTarget | null
  residentName: string
  /** あなたが入力を始めた時に見ていた値（列 → 値）。新規なら空のまま */
  base: Record<string, unknown>
  /** あなたが変えた列だけ（列 → あなたの値） */
  mine: Record<string, unknown>
  /** この端末の操作者（両方残すの記入者） */
  actorId: number | null
  /** 名簿（持っていれば渡す。無ければ開いた時に取得する） */
  staff?: Staff[]
  /**
   * バイタルの〔両方残す〕で作る行の種別。既定は再検（'recheck'）。
   * 日報の発熱者・他症状者の欄は、その欄に並ぶよう同じ種別を渡す。
   */
  bothKind?: VitalKind
  /**
   * その行の順番待ち（構造規約 R-F）。渡すと〔自分の値で直す〕〔両方残す〕の送信を、画面の通常の保存と
   * 同じ行ごとの1本の順番待ちに通す（先に積まれた保存が終わってから送る）
   */
  serialize?: (job: () => Promise<void>) => Promise<void>
  onClose: () => void
  onResolved: (r: ConflictResolution) => void
}

const MSG_LOAD_FAILED =
  '最新の記録を読み込めませんでした。通信状況を確認して、「もう一度」を押してください。入力は消えていません。'
const MSG_AGAIN =
  'その間に、さらに別の端末で更新されました。最新の値でもう一度くらべてから選んでください。'
const MSG_NOT_FOUND =
  '先の記録が見つかりませんでした（取り消された可能性があります）。「最新を読み込む」で画面を最新にしてください。入力は消えていません。'
const MSG_NO_TARGET =
  'この行はまだ保存されていないため、ここでは直せません。「最新を読み込む」で画面を最新にしてください。入力は消えていません。'
const MSG_NO_DIFF =
  '食い違いはありません（ほかの項目の更新が原因だったか、既に同じ値が入っています）。「最新を読み込む」で画面を最新にしてください。'

type Phase = 'loading' | 'error' | 'ready' | 'busy'

type Field = VitalField | MealField | 'symptom' | 'measured_at' | 'note'

/**
 * 〔両方残す〕の冪等キーを、その競合1件（対象・見ていた値・あなたの入力）ごとに固定する。
 * 閉じて開き直して2回押しても同じキーで送るので、DB の unique 制約で1行に収まる。
 * 持つのは乱数のキーだけ（業務データは持たない）。この起動中だけの控え。
 */
const bothKeys = new Map<string, string>()

function bothKeyFor(sig: string): string {
  let key = bothKeys.get(sig)
  if (key === undefined) {
    key = newClientKey()
    bothKeys.set(sig, key)
  }
  return key
}

/**
 * 食い違いを解決した後、その行の見出し（氏名のセルなど）へフォーカスを移す。
 * 〔くらべて選ぶ〕のボタンは解決すると消えるので、戻し先が無いと body へ落ちる（読み上げが迷子になる）。
 * ダイアログが閉じてボタンが消えた後に動かすため、2フレーム待つ
 */
export function focusAfterResolve(id: string): void {
  if (typeof window === 'undefined') return
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const el = document.getElementById(id)
      if (el) el.focus()
    })
  })
}

function errText(e: unknown, fallback: string): string {
  return e instanceof DbError && e.message ? e.message : fallback
}

/** くらべる対象の送信先（定時は利用者×日付・それ以外は行 id。id の無い行は送れない＝null） */
function vitalTargetOf(t: Extract<ConflictTarget, { table: 'vitals' }>): VitalTarget | null {
  if (t.kind === 'routine') return { routine: true, residentId: t.residentId, day: t.day }
  return t.vitalId === null ? null : { routine: false, id: t.vitalId }
}

function mealTargetOf(t: Extract<ConflictTarget, { table: 'meals' }>): MealTarget {
  return { residentId: t.residentId, day: t.day, slot: t.slot }
}

/** その行の送信待ち（開いた時に見せた「あなたの入力」の版を控えるため） */
function pendingOf(t: ConflictTarget): ReturnType<typeof pendingRow> {
  if (t.table === 'meals') return pendingRow('meals', mealTargetOf(t))
  const vt = vitalTargetOf(t)
  return vt === null ? null : pendingRow('vitals', vt)
}

/**
 * 元の行の「あなたの入力」を送信待ちから外す（〔先の値を残す〕〔両方残す〕）。vers＝開いた時に見せた版
 * （その版のままの欄だけを外す＝第3段 #9。見た後に打ち直した値は外さない）
 */
async function discardMine(t: ConflictTarget, fields: string[], vers: Record<string, string>): Promise<void> {
  if (fields.length === 0) return
  if (t.table === 'meals') {
    await discardPendingRow('meals', mealTargetOf(t), fields, vers)
    return
  }
  const vt = vitalTargetOf(t)
  if (vt !== null) await discardPendingRow('vitals', vt, fields, vers)
}

/** vers のうち fields の欄だけ */
function pickVers(vers: Record<string, string>, fields: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) if (vers[f] !== undefined) out[f] = vers[f]
  return out
}

export function ConflictResolver({
  target,
  residentName,
  base,
  mine,
  actorId,
  staff,
  bothKind = 'recheck',
  serialize,
  onClose,
  onResolved,
}: ConflictResolverProps) {
  const open = target !== null
  const [phase, setPhase] = useState<Phase>('loading')
  const [latest, setLatest] = useState<LatestRow<Vital | Meal> | null>(null)
  const [staffList, setStaffList] = useState<Staff[] | null>(staff ?? null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const aliveRef = useRef(true)
  const genRef = useRef(0)
  /** 開いた時に見せた「あなたの入力」の版（送信待ちの版のうち、見せた値と同じ欄だけ） */
  const seenVersRef = useRef<Record<string, string>>({})
  /** 見せている「あなたの入力」（開いた時の版を控える時に使う） */
  const mineRef = useRef(mine)
  mineRef.current = mine
  const headingRef = useRef<HTMLHeadingElement>(null)
  const uid = useId()
  // 呼び出し側が毎描画で新しいオブジェクトを渡しても取り直しが繰り返されないよう、
  // 取得は ref から読み、取り直しの合図は対象の中身（文字列）で判定する
  const targetRef = useRef(target)
  const staffRef = useRef(staff)
  targetRef.current = target
  staffRef.current = staff
  const targetKey = target === null ? '' : JSON.stringify(target)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const target = targetRef.current
    const staff = staffRef.current
    if (target === null) return
    const gen = ++genRef.current
    setPhase('loading')
    setActionError(null)
    seenVersRef.current = seenVers(pendingOf(target), mineRef.current)
    try {
      const [row, names] = await Promise.all([
        target.table === 'vitals'
          ? fetchLatestVital(
              target.kind === 'routine' || target.vitalId === null
                ? { routine: true, residentId: target.residentId, day: target.day }
                : { routine: false, id: target.vitalId },
            )
          : fetchLatestMeal(target.residentId, target.day, target.slot),
        // 名簿は記入者名を出すためだけに使う。取れなくても比較そのものは出す。
        // 退職者も含む全員から引く（F48。在籍者だけだと、退職した職員が先に書いた値の記入者が「職員ID n」になる）。
        // 読めなければ渡された名簿（在籍者）で出す
        fetchAllStaff().catch(() => staff ?? fetchStaff().catch(() => null)),
      ])
      if (gen !== genRef.current || !aliveRef.current) return
      setLatest(row as LatestRow<Vital | Meal> | null)
      setStaffList(names)
      setPhase('ready')
    } catch {
      if (gen !== genRef.current || !aliveRef.current) return
      setPhase('error')
    }
  }, [])

  // 開くたび（対象が変わるたび）に取り直す
  useEffect(() => {
    if (targetKey === '') return
    setNotice(null)
    setLatest(null)
    void load()
  }, [targetKey, load])

  const fields: readonly Field[] = useMemo(() => {
    // 食事: 送信待ちにメモ（〔両方残す〕の追記）がある時は、メモも比べる（第3段 #4。相手と食い違うメモを見せる）
    if (target?.table === 'meals') {
      return Object.prototype.hasOwnProperty.call(mine, 'note') ? [...MEAL_FIELDS, 'note'] : MEAL_FIELDS
    }
    const out: Field[] = [...VITAL_FIELDS]
    // 時刻は利用者が編集した時だけ比べる（自動で入る時刻は食い違いにしない＝db.ts の fillGapsOnly と同じ考え方）
    if (Object.prototype.hasOwnProperty.call(mine, 'measured_at')) out.push('measured_at')
    if (target?.table === 'vitals' && (target.kind === 'symptom' || Object.prototype.hasOwnProperty.call(mine, 'symptom'))) {
      out.push('symptom')
    }
    return out
  }, [mine, target])

  const latestCells = useMemo(() => {
    const out: Record<string, unknown> = {}
    const row = latest?.row as unknown as Record<string, unknown> | undefined
    if (!row) return out
    for (const f of fields) out[f] = row[f] ?? null
    return out
  }, [fields, latest])

  const columns = useMemo(
    () => (latest ? conflictColumns(fields, base, mine, latestCells) : []),
    [base, fields, latest, latestCells, mine],
  )

  const nameOf = useCallback(
    (f: Field): string =>
      f === 'symptom'
        ? '症状'
        : f === 'measured_at'
          ? '測定時刻'
          : f === 'note'
            ? 'メモ'
            : target?.table === 'meals'
            ? MEAL_FIELD_NAME[f as MealField]
            : VITAL_FIELD_NAME[f as VitalField],
    [target],
  )
  const fmt = useCallback(
    (f: Field, v: unknown): string => {
      if (f === 'symptom' || f === 'note') return typeof v === 'string' && v.trim() !== '' ? v : '未入力'
      if (f === 'measured_at') return fmtTimeValue(v)
      return target?.table === 'meals'
        ? fmtMealValue(f as MealField, v)
        : fmtVitalValue(f as VitalField, v)
    },
    [target],
  )

  /** あなたの入力（変えた列すべて）の説明。「先の値を残す」で保存されなくなる中身 */
  const mineText = useMemo(
    () =>
      describeMine(
        fields
          .filter((f) => Object.prototype.hasOwnProperty.call(mine, f))
          .map((f) => ({ name: nameOf(f), value: fmt(f, mine[f]) })),
      ),
    [fields, fmt, mine, nameOf],
  )

  /** 比べる欄のうち、あなたの入力に無い血圧の相方（F12。〔自分の値で直す〕で見ていた値を書き戻す欄） */
  const pairBack = useMemo(
    () => columns.filter((c) => !Object.prototype.hasOwnProperty.call(mine, c.field)),
    [columns, mine],
  )

  /** 両方残すで残せる値があるか（空にする入力だけでは新しい記録にできない） */
  const hasMineValue = useMemo(
    () =>
      fields.some(
        (f) => Object.prototype.hasOwnProperty.call(mine, f) && mine[f] !== null && mine[f] !== '',
      ),
    [fields, mine],
  )

  const who =
    latest === null
      ? ''
      : recorderName(latest.editedBy, (latest.row as { recorded_by?: number | null }).recorded_by, staffList)
  const stamp = latest === null ? '' : fmtStamp(latest.updatedAt)

  const title =
    target === null
      ? ''
      : target.table === 'meals'
        ? `${residentName} ${fmtDayLabel(target.day)} ${MEAL_SLOT_LABEL[target.slot]}食`
        : `${residentName} ${fmtDayLabel(target.day)} バイタル`

  /** 再び競合した時: 取り直して出し直す（自動では選び直さない） */
  const again = useCallback(() => {
    setNotice(MSG_AGAIN)
    void load()
  }, [load])

  /** 送信をその行の順番待ちに通す（渡されていなければそのまま動かす） */
  const runSerial = useCallback(
    async (job: () => Promise<void>) => {
      if (serialize) await serialize(job)
      else await job()
    },
    [serialize],
  )

  const chooseTheirs = useCallback(async () => {
    if (target === null) return
    setPhase('busy')
    setActionError(null)
    await runSerial(async () => {
      try {
        // あなたの入力を送信待ちから外す（利用者の明示的な取り下げ。外した欄は他のタブ・次の起動で復活しない）。
        // 外すのは開いた時に見せた版だけ（見た後に打ち直した値は残る＝第3段 #9）
        await discardMine(target, Object.keys(mine), seenVersRef.current)
        if (!aliveRef.current) return
        onResolved({ choice: 'theirs', latest: latest?.row ?? null, queued: false })
      } catch (e) {
        if (!aliveRef.current) return
        setActionError(errText(e, '取り下げられませんでした。もう一度お試しください。'))
        setPhase('ready')
      }
    })
  }, [latest, mine, onResolved, runSerial, target])

  const chooseReload = useCallback(() => {
    onResolved({ choice: 'reload', latest: latest?.row ?? null, queued: false })
  }, [latest, onResolved])

  const chooseMine = useCallback(async () => {
    if (target === null || latest === null) return
    // 血圧は上下を組で送る（片方だけ違っていても、相方を「あなたの組」の値で加える＝第3段 #3）。基準は下で取り直した最新
    const patch = withBpPair(patchForMine(fields, mine, latestCells), mine, base)
    setPhase('busy')
    setActionError(null)
    await runSerial(async () => {
      try {
        if (Object.keys(patch).length === 0) {
          // もう同じ値が入っている: 送るものは無い。送信待ちに残っている同じ値（開いた時に見せた版）だけ外す
          await discardMine(target, Object.keys(mine), seenVersRef.current)
          if (!aliveRef.current) return
          onResolved({ choice: 'mine', latest: latest.row, queued: false })
          return
        }
        // 欄ごとの基準＝取り直した最新の値（くらべた時の先の値）。サーバーはその欄がいまもこの値の時だけ書く
        // （開いている間にさらに他の端末が書き換えていれば、書かずに競合を返す＝取り直して出し直す）
        const edits: CellEditInput<string> = {}
        const latestRow = latest.row as unknown as Record<string, unknown>
        for (const [k, v] of Object.entries(patch)) edits[k] = { value: v, base: latestCells[k] ?? latestRow[k] ?? null }
        let res
        if (target.table === 'vitals') {
          const vt = vitalTargetOf(target)
          if (vt === null) throw new DbError('server', MSG_NO_TARGET)
          res = await saveVitalEdits(vt, edits, { rebase: true })
        } else {
          res = await saveMealEdits(mealTargetOf(target), edits, { rebase: true })
        }
        if (!aliveRef.current) return
        if (res === 'queued') {
          onResolved({ choice: 'mine', latest: { ...latest.row, ...patch } as Vital | Meal, queued: true })
          return
        }
        // 開いている間にさらに別の端末で更新された（競合・止まっている行へまとめた）: 取り直して出し直す
        if (res.conflicts.length > 0 || res.held === true) {
          again()
          return
        }
        onResolved({ choice: 'mine', latest: (res.row as Vital | Meal | null) ?? latest.row, queued: false })
      } catch (e) {
        if (!aliveRef.current) return
        setActionError(errText(e, '保存できませんでした。入力は消えていません。もう一度お試しください。'))
        setPhase('ready')
      }
    })
  }, [again, base, fields, latest, latestCells, mine, onResolved, runSerial, target])

  const chooseBoth = useCallback(async () => {
    if (target === null || latest === null) return
    setPhase('busy')
    setActionError(null)
    await runSerial(async () => {
      /** バイタルの〔両方残す〕で作る新しい行の指し方（拒否された時に送信待ちから外すため） */
      let bothTarget: VitalTarget | null = null
      try {
        if (target.table === 'vitals') {
          // 新しい行に書くのは、あなたが実際に編集した列の値だけ（測っていない値・相手の値は書かない）
          const vals = valuesForBoth(fields, mine) as Record<string, unknown>
          const edits: CellEditInput<string> = {}
          for (const [k, v] of Object.entries(vals)) {
            if (k === 'symptom' && bothKind !== 'symptom') continue
            edits[k] = { value: v, base: null }
          }
          // 時刻は、利用者が入れた時刻があればそれを使う（欄として送る）。無ければ今日の分は今の時刻・前日の分は
          // 夜勤明けより前だけ今の時刻（「翌」・F34）・それ以外の過去日は空（一覧・一括と同じ規則＝nextMorning.ts）
          const fill = {
            measured_at: typeof vals.measured_at === 'string' ? null : recordTimeFor(target.day),
            recorded_by: actorId,
          }
          bothTarget = {
            routine: false,
            // 同じ競合で2回送っても1行に収まるよう、冪等キーを競合1件ごとに固定する
            clientKey: bothKeyFor(`${targetKey}|${JSON.stringify(base)}|${JSON.stringify(mine)}`),
            residentId: target.residentId,
            day: target.day,
            kind: bothKind === 'routine' ? 'recheck' : bothKind,
          }
          const res = await saveVitalEdits(bothTarget, edits, { fill })
          if (res !== 'queued' && (res.conflicts.length > 0 || res.held === true)) {
            // 新しい行が書けなかった（まれ）: 元の入力は外さない（元のまま）。取り直して出し直す
            if (aliveRef.current) again()
            return
          }
          // 新しい行が書けた・送信待ちに確保できた後で、元の行の「あなたの入力」（開いた時に見せた版）を外す（第3段 #8）
          await discardMine(target, Object.keys(mine), seenVersRef.current)
          if (!aliveRef.current) return
          // 先の値の行はそのまま。画面は最新を取り直して新しい行を出す
          onResolved({ choice: 'both', latest: latest.row, queued: res === 'queued' })
          return
        }
        const meal = latest.row as Meal
        const actorName = actorId === null ? null : (staffList?.find((s) => s.id === actorId)?.name ?? null)
        const note = appendAltMealNote(
          meal.note,
          {
            main_amount: typeof mine.main_amount === 'number' ? mine.main_amount : null,
            side_amount: typeof mine.side_amount === 'number' ? mine.side_amount : null,
            status: typeof mine.status === 'string' ? (mine.status as MealStatus) : null,
          },
          actorName,
        )
        if (note === null) {
          setPhase('ready')
          return
        }
        // 主食・副食・状態の「あなたの入力」はメモの追記へ置き換える（値はメモに残す）。メモの基準は取り直したメモ
        // （開いている間に他の端末がメモを書き換えていれば、書かずに出し直す）。置き換えは db.ts が1回の書き戻しで行い、
        // メモが書けなかった（拒否・競合）時は取り下げた入力を元に戻す（第3段 #8）
        const res = await saveMealEdits(
          mealTargetOf(target),
          { note: { value: note, base: meal.note ?? null } },
          { rebase: true, dropVers: pickVers(seenVersRef.current, Object.keys(mine).filter((f) => f !== 'note')) },
        )
        if (!aliveRef.current) return
        if (res === 'queued') {
          onResolved({ choice: 'both', latest: { ...meal, note }, queued: true })
          return
        }
        if (res.conflicts.length > 0 || res.held === true) {
          again()
          return
        }
        onResolved({ choice: 'both', latest: (res.row as Meal | null) ?? { ...meal, note }, queued: false })
      } catch (e) {
        // 拒否された（例外）: あなたの入力は画面の控えに残っている。まだ行の無い新しい行の送信待ちは、どの画面にも
        // 出せず「未送信」に数え続けるだけなので外す（同じ競合でもう一度押せば、同じ冪等キーで作り直す）
        if (bothTarget !== null) void discardPendingRow('vitals', bothTarget)
        if (!aliveRef.current) return
        // 食事は取り下げた入力が新しい版で元に戻っている。もう一度押した時に外せるよう、見せている版を取り直す
        if (target.table === 'meals') seenVersRef.current = seenVers(pendingOf(target), mineRef.current)
        setActionError(errText(e, '保存できませんでした。入力は消えていません。もう一度お試しください。'))
        setPhase('ready')
      }
    })
  }, [actorId, again, base, bothKind, fields, latest, mine, onResolved, runSerial, staffList, target, targetKey])

  const busy = phase === 'busy'
  const idTheirs = `${uid}-theirs`
  const idMine = `${uid}-mine`
  const idBoth = `${uid}-both`

  const bothText =
    target?.table === 'meals'
      ? '先の値はそのままにして、この食事のメモに「別の記入: …（記入者）」として書き足します。'
      : bothKind === 'recheck'
        ? 'あなたの値を「再検」の行として新しく残します（先の値の行はそのまま）。'
        : 'あなたの値を同じ欄に新しい行として残します（先の値の行はそのまま）。'

  return (
    // 保存中は閉じられないようにする（閉じて開き直すと、同じ操作を2回送れてしまうため）。
    // 表示領域（visualViewport）に合わせて置く＝文字を大きくした狭い画面でも右側が切れない
    <ModalShell
      open={open}
      label="食い違いをくらべて選ぶ"
      onClose={busy ? undefined : onClose}
      initialFocus={headingRef}
      fitVisualViewport
    >
      {/* 本文とフッタを1つのスクロールにまとめる（フッタを固定すると、文字を大きくした狭い画面で
          本文の見える高さが数十pxしか残らず、3択が見えなくなる＝画面検証 V1） */}
      <div className="overflow-y-auto">
      <div className="p-4">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-bold text-ink">
          食い違いをくらべて選ぶ
        </h2>
        <p className="mt-1 text-base text-ink2">{title}</p>

        <div role="status" aria-live="polite">
          {notice ? (
            <p className="mt-3 rounded border border-warn bg-warn-bg p-3 text-base text-ink">
              <span aria-hidden="true">▲ </span>
              {notice}
            </p>
          ) : null}
          {phase === 'loading' ? (
            <p className="mt-3 text-base text-ink2">最新の記録を読み込んでいます…</p>
          ) : null}
          {busy ? <p className="mt-3 text-base text-ink2">保存しています…</p> : null}
        </div>

        {phase === 'error' ? (
          <div role="alert" className="mt-3 rounded border border-danger bg-danger-bg p-3">
            <p className="text-base text-ink">
              <span aria-hidden="true">▲ </span>
              {MSG_LOAD_FAILED}
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-2 min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary"
            >
              もう一度
            </button>
          </div>
        ) : null}

        {actionError ? (
          <p role="alert" className="mt-3 rounded border border-danger bg-danger-bg p-3 text-base text-ink">
            <span aria-hidden="true">▲ </span>
            {actionError}
          </p>
        ) : null}

        {(phase === 'ready' || busy) && latest === null ? (
          <div className="mt-3">
            <p className="text-base text-ink">{MSG_NOT_FOUND}</p>
            <button
              type="button"
              disabled={busy}
              onClick={chooseReload}
              className="mt-3 min-h-tap w-full rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
            >
              最新を読み込む
            </button>
          </div>
        ) : null}

        {(phase === 'ready' || busy) && latest !== null && columns.length === 0 ? (
          <div className="mt-3">
            <p className="text-base text-ink">
              <span aria-hidden="true">✓ </span>
              {MSG_NO_DIFF}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={chooseReload}
              className="mt-3 min-h-tap w-full rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
            >
              最新を読み込む
            </button>
          </div>
        ) : null}

        {(phase === 'ready' || busy) && latest !== null && columns.length > 0 ? (
          <>
            <h3 className="mt-4 text-base font-bold text-ink">食い違っている項目</h3>
            <ul className="mt-2 space-y-2">
              {columns.map((c) => (
                <li key={c.field} className="rounded border border-border bg-surface2 p-3">
                  <p className="text-base font-bold text-ink">{nameOf(c.field)}</p>
                  <p className="mt-1 text-base text-ink">
                    先に入っている値：<span className="tabular font-bold">{fmt(c.field, c.theirs)}</span>
                    <span className="text-ink2">
                      （{who}
                      {stamp ? `・${stamp}` : ''}）
                    </span>
                  </p>
                  <p className="mt-1 text-base text-ink">
                    {/* あなたの入力に無い血圧の相方（F12）は「見ていた値」。〔自分の値で直す〕は組でこの値を書く */}
                    {Object.prototype.hasOwnProperty.call(mine, c.field) ? 'あなたの入力' : 'あなたの画面で見ていた値'}：
                    <span className="tabular font-bold">{fmt(c.field, c.mine)}</span>
                  </p>
                </li>
              ))}
            </ul>

            <h3 className="mt-4 text-base font-bold text-ink">どちらを残しますか</h3>
            <div className="mt-2 flex flex-col gap-gap">
              <div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void chooseTheirs()}
                  aria-describedby={idTheirs}
                  className="min-h-tap w-full rounded border border-border-strong bg-surface px-4 text-left text-base font-bold text-ink disabled:border-border disabled:text-ink3"
                >
                  先の値を残す
                </button>
                <p id={idTheirs} className="mt-1 text-sm text-ink2">
                  あなたの入力（{mineText}）は保存されません。
                </p>
              </div>
              <div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void chooseMine()}
                  aria-describedby={idMine}
                  className="min-h-tap w-full rounded border border-primary bg-surface px-4 text-left text-base font-bold text-primary disabled:border-border disabled:text-ink3"
                >
                  自分の値で直す
                </button>
                <p id={idMine} className="mt-1 text-sm text-ink2">
                  あなたの値で書き直します。前の値は変更の記録に残ります。
                  {/* 相方を見ていた値で組にして書く時は、それも書き戻すことを先に示す（F12: 見せないまま戻さない） */}
                  {pairBack.length > 0
                    ? `血圧は上下を組で書くため、${pairBack.map((c) => `${nameOf(c.field)}も見ていた値（${fmt(c.field, c.mine)}）`).join('・')}に戻します。`
                    : null}
                </p>
              </div>
              <div>
                <button
                  type="button"
                  disabled={busy || !hasMineValue}
                  onClick={() => void chooseBoth()}
                  aria-describedby={idBoth}
                  className="min-h-tap w-full rounded border border-border-strong bg-surface px-4 text-left text-base font-bold text-ink disabled:border-border disabled:text-ink3"
                >
                  両方残す
                </button>
                <p id={idBoth} className="mt-1 text-sm text-ink2">
                  {hasMineValue ? bothText : '空にする入力だけのため、両方残すことはできません。'}
                </p>
              </div>
            </div>
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap justify-between gap-gap border-t border-border p-4">
        {/* 変更の記録はこの方のカルテ（別の画面）にある。移ると、この画面でまだ保存していない入力は
            残らないので、その旨を先に書いておく（原則4: 入力を黙って消さない） */}
        <p id={`${uid}-karte`} className="w-full text-sm text-ink2">
          「変更の記録を見る」はこの方のカルテに移ります。まだ保存していない入力は、この画面を離れると残りません。
        </p>
        {target === null ? (
          <span />
        ) : busy ? (
          // 保存中は移れない（画面を離れると保存の結果を受け取れない＝画面検証 V2）。
          // 押せないことは色だけでなく文字でも示す
          <button
            type="button"
            disabled
            aria-describedby={`${uid}-karte`}
            className="inline-flex min-h-tap items-center rounded border border-border px-4 text-base text-ink3"
          >
            変更の記録を見る（保存中は押せません）
          </button>
        ) : (
          <Link
            to={`/karte/${target.residentId}`}
            aria-describedby={`${uid}-karte`}
            className="inline-flex min-h-tap items-center rounded border border-border-strong px-4 text-base text-link"
          >
            変更の記録を見る
          </Link>
        )}
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="min-h-tap rounded border border-border-strong px-4 text-base text-ink disabled:border-border disabled:text-ink3"
        >
          {busy ? '閉じる（保存中は押せません）' : '閉じる（入力は残します）'}
        </button>
      </div>
      </div>
    </ModalShell>
  )
}

// ══════════════════════════════════════════════════════════════
// 申し送りのくらべて選ぶ（2026-09-29・申し送りを消さない作り替え 段B-3）
// ══════════════════════════════════════════════════════════════
//
// 日報・タイムライン・送れていない申し送りの一覧が共通で使う。
// 「あなたの本文」は送信待ち（db.ts の pendingNoteRow＝端末に保存済み。再読み込み・画面移動・アプリの終了でも消えない）
// から読み、「先の本文」は開いた時にサーバーの最新を取り直す（fetchLatestNote）。
//   〔自分の本文で直す〕       … 基準を取り直した最新の値にして送り直す（rebase）。前の本文は変更の記録に残る
//   〔新しい行として両方残す〕 … 同じ日・区分・対象に、自分を記入者として新しい行で登録（冪等キーを固定）。
//                                登録できた（送信待ちに確保できた）後で、元の行の「あなたの本文」を外す
//   〔先の本文を残す〕         … 「あなたの本文は保存されません」と示してから、あなたの入力を取り下げる
//   先の行が取り消されていた（missing）時は〔新しい行として保存〕〔取り下げる〕

const NOTE_FIELD_NAME: Record<string, string> = {
  body: '本文',
  resident_id: '対象',
  importance: '重要度',
  color: '色',
  after16: '16時以降',
  occurred_at: '時刻',
  reporter_id: '記入者',
  role_tags: '職種タグ',
  shift: '勤務帯',
  ongoing: '継続',
  ended_at: '継続の終了',
  ended_by: '継続を終了した職員',
}

/** くらべる申し送り（行 id と、見出しに出す対象名） */
export interface NoteConflictTarget {
  id: number
  /** 別のタブの入力と分けて持った入力（送信待ちの notes#<id>!<fork>）を選ぶ時の印 */
  fork?: string
  /** 見出しに出す対象（利用者の表示名・「スタッフへ（全体）」） */
  label: string
}

export interface NoteConflictResolution {
  /** mine＝自分の本文で直した／both＝新しい行として残した／theirs＝取り下げた／reload＝食い違いが無かった */
  choice: 'mine' | 'both' | 'theirs' | 'reload'
  /** 選んだ後のいまの行（取り消された・送信待ちの時は null） */
  latest: Note | null
  queued: boolean
}

export interface NoteConflictResolverProps {
  target: NoteConflictTarget | null
  /** この端末の操作者（〔新しい行として…〕の記入者） */
  actorId: number | null
  staff?: Staff[]
  /** 利用者の表示名（対象の食い違いを出す時に使う。無ければ「利用者ID n」） */
  residentName?: (id: number | null) => string
  onClose: () => void
  onResolved: (r: NoteConflictResolution) => void
}

/** くらべる送信待ちの指し方（分けて持った入力なら fork つき） */
function noteTargetOf(t: NoteConflictTarget): { id: number; fork?: string } {
  return t.fork === undefined ? { id: t.id } : { id: t.id, fork: t.fork }
}

function noteValueText(
  f: string,
  v: unknown,
  staff: Staff[] | null,
  residentName?: (id: number | null) => string,
): string {
  if (v === null || v === undefined || v === '') return '未入力'
  switch (f) {
    case 'body':
      return String(v)
    case 'resident_id':
      return residentName ? residentName(typeof v === 'number' ? v : null) : `利用者ID ${String(v)}`
    case 'reporter_id':
    case 'ended_by':
      return staff?.find((s) => s.id === v)?.name ?? `職員ID ${String(v)}`
    case 'importance':
      return IMPORTANCE_LABEL[v as Importance] ?? String(v)
    case 'color':
      return NOTE_COLOR_LABEL[v as NoteColor] ?? String(v)
    case 'shift':
      return SHIFT_LABEL[v as Shift] ?? String(v)
    case 'after16':
    case 'ongoing':
      return v === true ? 'はい' : 'いいえ'
    case 'role_tags':
      return Array.isArray(v) && v.length > 0 ? v.join('・') : 'なし'
    case 'occurred_at':
      return fmtTimeValue(v)
    case 'ended_at':
      return fmtStamp(String(v)) || String(v)
  }
  return String(v)
}

export function NoteConflictResolver({
  target,
  actorId,
  staff,
  residentName,
  onClose,
  onResolved,
}: NoteConflictResolverProps) {
  const open = target !== null
  const [phase, setPhase] = useState<Phase>('loading')
  const [latest, setLatest] = useState<LatestRow<Note> | null>(null)
  const [mine, setMine] = useState<PendingNoteRow | null>(null)
  const [meta, setMeta] = useState<NoteMeta | null>(null)
  const [staffList, setStaffList] = useState<Staff[] | null>(staff ?? null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /** 取り下げの確認中（「あなたの本文は保存されません」を出してから取り下げる） */
  const [askDrop, setAskDrop] = useState(false)
  const aliveRef = useRef(true)
  const genRef = useRef(0)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const uid = useId()
  const targetRef = useRef(target)
  targetRef.current = target
  const staffRef = useRef(staff)
  staffRef.current = staff
  const targetKey = target === null ? '' : `${target.id}!${target.fork ?? ''}`

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const t = targetRef.current
    if (t === null) return
    const gen = ++genRef.current
    setPhase('loading')
    setActionError(null)
    setAskDrop(false)
    setMine(pendingNoteRow(noteTargetOf(t)))
    try {
      const [row, names, m] = await Promise.all([
        fetchLatestNote(t.id),
        // 名前の引き当ては退職者も含む全員から（F48）。読めなければ渡された名簿
        fetchAllStaff().catch(() => staffRef.current ?? fetchStaff().catch(() => null)),
        resolveNoteMeta(t.id).catch(() => null),
      ])
      if (gen !== genRef.current || !aliveRef.current) return
      setLatest(row)
      setStaffList(names)
      setMeta(m)
      setMine(pendingNoteRow(noteTargetOf(t)))
      setPhase('ready')
    } catch {
      if (gen !== genRef.current || !aliveRef.current) return
      setPhase('error')
    }
  }, [])

  useEffect(() => {
    if (targetKey === '') return
    setNotice(null)
    setLatest(null)
    void load()
  }, [targetKey, load])

  const busy = phase === 'busy'
  const deleting = mine !== null && Object.prototype.hasOwnProperty.call(mine.values, 'deleted_at')
  const mineBody = mine !== null && typeof mine.values.body === 'string' ? mine.values.body : null
  const fields = mine === null ? [] : Object.keys(mine.values).filter((f) => f !== 'deleted_at')
  // 取り消しが「見た行」と食い違って止まった欄（F09・0027。本文は同じでも重要度・対象などが直されていた）
  const seenDiff = mine?.conflicts.find((c) => c.field === 'deleted_at')?.fields ?? []
  /** 先の内容に並べる欄（あなたの入力の欄＋取り消しが止まった理由の欄） */
  const shownFields = [...fields, ...seenDiff.filter((f) => f !== 'body' && !fields.includes(f))]
  const latestRow = latest?.row as unknown as Record<string, unknown> | undefined
  const who = latest === null ? '' : recorderName(latest.editedBy, latest.row.reporter_id, staffList)
  const stamp = latest === null ? '' : fmtStamp(latest.updatedAt)
  const fmtV = (f: string, v: unknown): string => noteValueText(f, v, staffList, residentName)

  const again = useCallback(() => {
    setNotice(MSG_AGAIN)
    void load()
  }, [load])

  /** 〔自分の本文で直す〕（取り消しの時は〔それでも削除する〕）。基準は取り直した最新の値 */
  const chooseMine = useCallback(async () => {
    if (target === null || latest === null || mine === null) return
    setPhase('busy')
    setActionError(null)
    try {
      const row = latest.row as unknown as Record<string, unknown>
      let res
      if (deleting) {
        // 見た行＝いま取り直した最新の行（F09。〔それでも削除する〕の後に、さらに直されていたら止める）
        res = await deleteNote(noteTargetOf(target), latest.row, { rebase: true })
      } else {
        const edits: CellEditInput<NoteEditField> = {}
        for (const f of fields) {
          // 基準＝取り直した最新の値。列を返さない経路で値が分からない欄（undefined）は基準を付けない
          // （F08: 継続を終了した職員 ended_by を null として送ると、サーバーの値が入っている時は何度押しても競合になった）
          const known = Object.prototype.hasOwnProperty.call(row, f) && row[f] !== undefined
          edits[f as NoteEditField] = known ? { value: mine.values[f], base: row[f] ?? null } : { value: mine.values[f] }
        }
        res = await saveNoteEdits(noteTargetOf(target), edits, { rebase: true })
      }
      if (!aliveRef.current) return
      if (res === 'queued') {
        onResolved({ choice: 'mine', latest: null, queued: true })
        return
      }
      if (res.conflicts.length > 0 || res.held === true) {
        again()
        return
      }
      onResolved({ choice: 'mine', latest: res.row, queued: false })
    } catch (e) {
      if (!aliveRef.current) return
      setActionError(errText(e, '保存できませんでした。入力は消えていません。もう一度お試しください。'))
      setPhase('ready')
    }
  }, [again, deleting, fields, latest, mine, onResolved, target])

  /** 〔新しい行として両方残す〕〔新しい行として保存〕 */
  const chooseBoth = useCallback(async () => {
    if (target === null || mine === null || mineBody === null) return
    const m = meta ?? (latest === null ? null : { note_on: latest.row.note_on, shift: latest.row.shift, resident_id: latest.row.resident_id, after16: latest.row.after16 })
    if (m === null) return
    setPhase('busy')
    setActionError(null)
    try {
      const key = noteAsNewKey(target.id, mine.vers.body ?? '')
      const res = await insertNoteAsNew({ key, meta: m, body: mineBody, reporterId: actorId })
      // 登録できた・送信待ちに確保できた後で、元の行の「あなたの本文」（開いた時に見せた版）を外す
      await discardPendingNote(noteTargetOf(target), ['body'], pickVers(mine.vers, ['body']))
      if (!aliveRef.current) return
      onResolved({ choice: 'both', latest: latest?.row ?? null, queued: res === 'queued' })
    } catch (e) {
      if (!aliveRef.current) return
      setActionError(errText(e, '登録できませんでした。入力は消えていません。もう一度お試しください。'))
      setPhase('ready')
    }
  }, [actorId, latest, meta, mine, mineBody, onResolved, target])

  /** 〔先の本文を残す〕〔取り下げる〕（確認の後） */
  const chooseDrop = useCallback(async () => {
    if (target === null || mine === null) return
    setPhase('busy')
    setActionError(null)
    try {
      await discardPendingNote(noteTargetOf(target), undefined, mine.vers)
      if (!aliveRef.current) return
      onResolved({ choice: 'theirs', latest: latest?.row ?? null, queued: false })
    } catch (e) {
      if (!aliveRef.current) return
      setActionError(errText(e, '取り下げられませんでした。もう一度お試しください。'))
      setPhase('ready')
    }
  }, [latest, mine, onResolved, target])

  const missing = latest === null
  const canNew = mineBody !== null && !deleting && (meta !== null || latest !== null)
  const idMine = `${uid}-nmine`
  const idBoth = `${uid}-nboth`
  const idDrop = `${uid}-ndrop`
  const btn =
    'min-h-tap w-full rounded border bg-surface px-4 text-left text-base font-bold disabled:border-border disabled:text-ink3'

  return (
    <ModalShell
      open={open}
      label="申し送りをくらべて選ぶ"
      onClose={busy ? undefined : onClose}
      initialFocus={headingRef}
      fitVisualViewport
    >
      <div className="overflow-y-auto">
        <div className="p-4">
          <h2 ref={headingRef} tabIndex={-1} className="text-lg font-bold text-ink">
            申し送りをくらべて選ぶ
          </h2>
          <p className="mt-1 text-base text-ink2">{target?.label ?? ''}</p>

          <div role="status" aria-live="polite">
            {notice ? (
              <p className="mt-3 rounded border border-warn bg-warn-bg p-3 text-base text-ink">
                <span aria-hidden="true">▲ </span>
                {notice}
              </p>
            ) : null}
            {phase === 'loading' ? <p className="mt-3 text-base text-ink2">最新の記録を読み込んでいます…</p> : null}
            {busy ? <p className="mt-3 text-base text-ink2">保存しています…</p> : null}
          </div>

          {phase === 'error' ? (
            <div role="alert" className="mt-3 rounded border border-danger bg-danger-bg p-3">
              <p className="text-base text-ink">
                <span aria-hidden="true">▲ </span>
                {MSG_LOAD_FAILED}
              </p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-2 min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary"
              >
                もう一度
              </button>
            </div>
          ) : null}

          {actionError ? (
            <p role="alert" className="mt-3 rounded border border-danger bg-danger-bg p-3 text-base text-ink">
              <span aria-hidden="true">▲ </span>
              {actionError}
            </p>
          ) : null}

          {(phase === 'ready' || busy) && mine === null ? (
            <div className="mt-3">
              <p className="text-base text-ink">
                <span aria-hidden="true">✓ </span>
                この申し送りに止まっている入力はありません（送り終えたか、取り下げられています）。
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => onResolved({ choice: 'reload', latest: latest?.row ?? null, queued: false })}
                className="mt-3 min-h-tap w-full rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
              >
                最新を読み込む
              </button>
            </div>
          ) : null}

          {(phase === 'ready' || busy) && mine !== null ? (
            <>
              <div className="mt-4 rounded border border-border bg-surface2 p-3">
                <p className="text-base font-bold text-ink">先の内容</p>
                {missing ? (
                  <p className="mt-1 text-base text-ink">
                    <span aria-hidden="true">▲ </span>
                    この申し送りは、ほかの端末で削除されています。
                  </p>
                ) : (
                  <>
                    <p className="mt-1 text-sm text-ink2">
                      {who}
                      {stamp ? `・${stamp}` : ''}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-base text-ink">{latest.row.body}</p>
                    {shownFields
                      .filter((f) => f !== 'body')
                      .map((f) => (
                        <p key={f} className="mt-1 text-base text-ink">
                          {NOTE_FIELD_NAME[f] ?? f}：
                          <span className="font-bold">
                            {/* 値を読めなかった欄（undefined）は「未入力」と言わない（F08） */}
                            {latestRow !== undefined && latestRow[f] === undefined ? '（確かめられません）' : fmtV(f, latestRow?.[f] ?? null)}
                          </span>
                        </p>
                      ))}
                  </>
                )}
              </div>
              <div className="mt-2 rounded border border-primary bg-surface p-3">
                <p className="text-base font-bold text-ink">あなたの入力（この端末に保存されています）</p>
                {deleting ? (
                  <p className="mt-1 text-base text-ink">
                    <span aria-hidden="true">▲ </span>
                    {seenDiff.length > 0
                      ? `この申し送りを削除しようとしました。削除する前に見ていた内容から、ほかの端末で${seenDiff
                          .map((f) => NOTE_FIELD_NAME[f] ?? f)
                          .join('・')}が直されています。`
                      : 'この申し送りを削除しようとしました。削除した後に、ほかの端末で本文が直されています。'}
                  </p>
                ) : null}
                {mineBody !== null ? (
                  <p className="mt-1 whitespace-pre-wrap break-words text-base text-ink">{mineBody}</p>
                ) : null}
                {fields
                  .filter((f) => f !== 'body')
                  .map((f) => (
                    <p key={f} className="mt-1 text-base text-ink">
                      {NOTE_FIELD_NAME[f] ?? f}：<span className="font-bold">{fmtV(f, mine.values[f])}</span>
                    </p>
                  ))}
              </div>

              {askDrop ? (
                <div role="alert" className="mt-4 rounded border border-danger bg-danger-bg p-3">
                  <p className="text-base font-bold text-ink">
                    <span aria-hidden="true">▲ </span>
                    あなたの{mineBody !== null ? '本文' : '入力'}は保存されません。取り下げてよろしいですか。
                  </p>
                  <div className="mt-2 flex flex-col gap-gap">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void chooseDrop()}
                      className={`${btn} border-danger text-danger`}
                    >
                      取り下げる（あなたの{mineBody !== null ? '本文' : '入力'}は保存されません）
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setAskDrop(false)}
                      className={`${btn} border-border-strong text-ink`}
                    >
                      やめる（入力は残します）
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <h3 className="mt-4 text-base font-bold text-ink">どうしますか</h3>
                  <div className="mt-2 flex flex-col gap-gap">
                    {!missing ? (
                      <div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void chooseMine()}
                          aria-describedby={idMine}
                          className={`${btn} border-primary text-primary`}
                        >
                          {deleting ? 'それでも削除する' : '自分の本文で直す'}
                        </button>
                        <p id={idMine} className="mt-1 text-sm text-ink2">
                          {deleting
                            ? '直された後の本文ごと削除します。削除した記録は変更の記録に残ります。'
                            : 'あなたの入力で書き直します。先の内容は変更の記録に残ります。'}
                        </p>
                      </div>
                    ) : null}
                    {!deleting ? (
                      <div>
                        <button
                          type="button"
                          disabled={busy || !canNew}
                          onClick={() => void chooseBoth()}
                          aria-describedby={idBoth}
                          className={`${btn} border-border-strong text-ink`}
                        >
                          {missing ? '新しい行として保存' : '新しい行として両方残す'}
                        </button>
                        <p id={idBoth} className="mt-1 text-sm text-ink2">
                          {canNew
                            ? '同じ日・同じ区分・同じ対象に、あなたを記入者として新しい行で登録します（先の内容はそのまま）。'
                            : mineBody === null
                              ? '本文の入力が無いため、新しい行にはできません。'
                              : 'どの日の申し送りかを確かめられないため、新しい行にできません。通信状況を確認して「もう一度」を押してください。'}
                        </p>
                      </div>
                    ) : null}
                    <div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setAskDrop(true)}
                        aria-describedby={idDrop}
                        className={`${btn} border-border-strong text-ink`}
                      >
                        {missing || deleting ? '取り下げる' : mineBody !== null ? '先の本文を残す' : '先の内容を残す'}
                      </button>
                      <p id={idDrop} className="mt-1 text-sm text-ink2">
                        あなたの{mineBody !== null ? '本文' : '入力'}は保存されません（押すと確認が出ます）。
                      </p>
                    </div>
                  </div>
                </>
              )}
            </>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-gap border-t border-border p-4">
          <p className="w-full text-sm text-ink2">
            閉じても、あなたの入力はこの端末に残ります（「送れていない申し送り」からいつでも選び直せます）。
          </p>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-tap rounded border border-border-strong px-4 text-base text-ink disabled:border-border disabled:text-ink3"
          >
            {busy ? '閉じる（保存中は押せません）' : '閉じる（入力は残します）'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

export default ConflictResolver
