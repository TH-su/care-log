// デイ（せせらぎ）の到着・帰宅・休み・入浴の操作（今日の画面のカードと1人の画面で使う・2026-10-24 代表者の決定 §9.4 の1〜2）。
//
// 2026-10-24 までは今日の画面（DaycarePage）の1人1行の中にあった操作と小窓を、そのままここへ移した（書き写しを2つ持たない）。
// 今日の画面のカードは〔休み〕〔取消〕（と 0047 が無い DB の理由の小窓）だけを使い、到着・帰宅・時刻の直し・休みの理由・入浴は
// カードを押した1人の画面（DaycarePersonPage）で使う。動き・文言は移す前と同じ（案内の「どこで」だけを place で出し分ける）:
// ・到着の1タップで在席（今日）。過去の日は事務所のログインだけ時刻の小窓（0042 のトリガと同じ規則）。直後の〔元に戻す〕（8秒）
// ・〔休み〕の1タップは理由「後で」の休み。人が入れた時刻がある方だけ確かめを挟む。0047 が無い DB は理由の小窓。入浴は
//   recordAbsentBath で「中止（欠席）」に直し、直後の〔元に戻す〕は全部を元どおりにする（決定 4・回答 A5）
// ・入浴は既存の bath_records と insertBath／updateBath（〔予定どおり実施〕・区分・中止・休みの方に残った入浴を欠席に直す）
//
// 規律（今日の画面と同じ）:
// - 取得・保存は db.ts の関数のみ（supabase を直呼びしない）。修正は rev 照合・他の端末が先なら読み直して知らせる・通信できない時は送信待ち
// - 書き込みの下準備（入力の旗 input_enabled_daycare と input_enabled_bath の観測・役割・休業日・開所の写し）は使う画面が自分で用意する
//   （入口の画面に頼らない＝M-085）。ここは受け取った値と関数を使うだけ
// - 氏名・記録を localStorage・console に出さない。色だけで意味を伝えない（記号・文字を併記）。押す所は 44px 以上

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DbError,
  FORBIDDEN_REASON,
  OUTDATED_REASON,
  daycareAutoColumnsSeen,
  fetchDaycareAttendance,
  hasPendingBath,
  hasPendingDaycareAttendance,
  insertBath,
  insertDaycareAttendance,
  isQueuePersisted,
  kindBlockedMessage,
  recordAbsentBath,
  softDeleteBath,
  softDeleteDaycareAttendance,
  updateBath,
  updateDaycareAttendance,
} from '../lib/db'
import type { AbsentBathResult, MyRole } from '../lib/db'
import { ConfirmDialog, ModalShell } from './ui'
import {
  attendanceState,
  canChangeDaycareTimes,
  canEditPastDaycareTimes,
  daycareBathStatus,
  DAYCARE_AUTO_BATH_AT,
  hasManualTimes,
  hmOf,
  isAutoOnlyAttendance,
  nowHm,
  planHm,
  validateAttendance,
} from '../lib/daycare'
import type { DaycareBoardRow } from '../lib/daycare'
import { resultForBathed } from '../lib/bath'
import { fmtDayLabel, todayIso } from '../lib/format'
import { BATH_CANCEL_REASON_LABEL, BATH_RESULT_LABEL, DAYCARE_ABSENT_REASONS, DAYCARE_ABSENT_REASON_LABEL } from '../lib/types'
import type { BathCancelReason, BathRecord, BathResult, DaycareAbsentReason, DaycareAttendance } from '../lib/types'

// ── 文言（何が起きたか＋次にどうするか） ──
export const MSG_CONFLICT = '他の端末が先にこの方の記録を保存・変更しました。最新の内容に読み直しました。確かめてから、もう一度押してください。'
export const MSG_QUEUED = '電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'
export const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度押してください。'
const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから記録してください。'
const MSG_ROW_PENDING = '未送信の記録があります（送信が終わると押せるようになります）'
const MSG_FUTURE = '未来の日には記録できません。'
/** 過去の日の到着・帰宅の時刻は事務所のログインだけ（代表者の決定 2026-10-22・移行 0042 のトリガも同じ規則） */
export const MSG_PAST_TIME =
  '過去の日の到着・帰宅の時刻は、事務所のログインで入力・修正します（現場の端末は当日だけ）。休み・入浴は記録できます。時刻は事務所に伝えてください。'
/** 時刻の入った方の過去の日の休み・帰宅の取り消し（時刻を消すため事務所だけ） */
const MSG_PAST_TIME_CLEAR =
  '過去の日に、到着・帰宅の時刻が入っている方を休みにする・帰宅を取り消すのは、事務所のログインで行います（時刻を消すため）。'

/** 案内の「どこで」（今日の画面のカードからは1人の画面へ、1人の画面ではこの画面のボタンへ案内する） */
export type DaycareOpsPlace = 'board' | 'person'
const PLACE_TEXT: Record<DaycareOpsPlace, { reasonHint: string; bathRedo: string; bathCheck: string; arriveHint: string }> = {
  board: {
    reasonHint: '理由は、カードを押した1人の画面で選べます',
    bathRedo: 'カードを押して1人の画面の入浴',
    bathCheck: 'カードを押して1人の画面の入浴',
    arriveHint: 'カードを押して、1人の画面の〔到着〕を押してください',
  },
  person: {
    reasonHint: '理由は〔理由を選ぶ〕から選べます',
    bathRedo: 'この画面の入浴',
    bathCheck: 'この画面の入浴',
    arriveHint: '〔到着〕を押してください',
  },
}

export type RowMsg = { tone: 'warn' | 'danger' | 'info' | 'ok'; text: string }

/** 時刻の短い表示（'09:30:00'→'9:30'。読めなければ空） */
export function hmShort(t: string | null): string {
  if (t === null) return ''
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  return m === null ? '' : `${Number(m[1])}:${m[2]}`
}

/** 到着・帰宅の時刻が入っているか（欠席にする・取り消すと時刻を消す） */
export function hasTimes(row: DaycareBoardRow): boolean {
  return row.attendance !== null && (row.attendance.arrived_at !== null || row.attendance.left_at !== null)
}

export interface DaycareOpsOptions {
  place: DaycareOpsPlace
  /** 表示中の業務日と今日 */
  day: string
  today: string
  /** ログインの役割（事務所・管理者だけ過去の日の到着・帰宅の時刻を入れられる。分からない間は現場と同じ扱い） */
  role: MyRole | null | undefined
  /** デイの入力の旗（観測した値）。null＝まだ */
  gate: { value: boolean; observed: boolean; forbidden?: true; outdated?: true } | null
  /** 書いてよいか（旗が開いている・サーバーの設定が済んでいる） */
  canWrite: boolean
  actorId: number | null
  /** 休業日（app_settings の daycare_closed_dates。入浴の「全身浴」を休業日は訪問介護で入浴にする） */
  closedDates: string | null
  nameOf: (id: number) => string
  bathOf: (id: number) => BathRecord | null
  /** 書けた到着の行を画面のデータへ入れる（違う日の行は捨てる） */
  putAttendance: (r: DaycareAttendance) => void
  /** 取り消した到着の行を画面のデータから外す */
  dropAttendance: (r: DaycareAttendance) => void
  /** 書けた入浴の行を画面のデータへ入れる */
  putBath: (r: BathRecord) => void
  /** 静かな読み直し（他の端末の変更・競合の後） */
  scheduleReload: () => void
  /** 開所の最初のタップ（今日だけ）: その日の予定の写しを作る（作れなくても記録は止めない） */
  ensureOpened: () => Promise<void>
  show: (msg: string, undo?: () => void) => void
  /** 行の知らせを消す合図（日付の切り替え・〔最新に更新〕。今日の画面の読み込みと同じ時に消す） */
  resetKey: unknown
}

export function useDaycareAttendanceOps(o: DaycareOpsOptions): {
  busy: Set<number>
  rowMsg: Map<number, RowMsg>
  setMsg: (id: number, m: RowMsg | null) => void
  precheck: (row: DaycareBoardRow) => boolean
  onArrive: (row: DaycareBoardRow) => Promise<void>
  onLeave: (row: DaycareBoardRow) => Promise<void>
  onRest: (row: DaycareBoardRow) => void
  askAbsent: (row: DaycareBoardRow) => void
  askCancelAbsent: (row: DaycareBoardRow) => void
  openTime: (row: DaycareBoardRow, mode: 'arrive' | 'leave' | 'fix') => void
  openBath: (row: DaycareBoardRow) => void
  onBathAsPlanned: (row: DaycareBoardRow) => void
  dialogs: ReactNode
} {
  const { place: placeKey, day, today, role, gate, canWrite, actorId, closedDates, nameOf, bathOf, putAttendance, dropAttendance, putBath, scheduleReload, ensureOpened, show, resetKey } = o
  const place = PLACE_TEXT[placeKey]
  const isFuture = day > today
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [rowMsg, setRowMsg] = useState<Map<number, RowMsg>>(new Map())
  const [absentFor, setAbsentFor] = useState<DaycareBoardRow | null>(null)
  /** 入浴の区分・中止を選ぶ小窓の対象 */
  const [bathFor, setBathFor] = useState<DaycareBoardRow | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; danger?: boolean; run: () => void } | null>(null)
  /** 時刻を入れる・直す小窓。arrive＝到着を記録・leave＝帰宅を記録・fix＝時刻を直す */
  const [timeFor, setTimeFor] = useState<{ row: DaycareBoardRow; mode: 'arrive' | 'leave' | 'fix' } | null>(null)
  const [timeArr, setTimeArr] = useState('')
  const [timeLeft, setTimeLeft] = useState('')
  const [timeErr, setTimeErr] = useState<string | null>(null)
  const dayRef = useRef(day)
  dayRef.current = day

  useEffect(() => {
    setRowMsg(new Map())
  }, [day, resetKey])

  const setMsg = (id: number, m: RowMsg | null) =>
    setRowMsg((prev) => {
      const next = new Map(prev)
      if (m === null) next.delete(id)
      else next.set(id, m)
      return next
    })
  const setRowBusy = (id: number, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  /** 書き込みの前の確かめ（記録者・旗・日付・未送信）。通らなければ理由を行に出して false */
  const precheck = (row: DaycareBoardRow): boolean => {
    if (!canWrite) {
      setMsg(row.residentId, { tone: 'warn', text: gate?.forbidden ? FORBIDDEN_REASON : gate?.outdated ? OUTDATED_REASON : kindBlockedMessage('daycare') })
      return false
    }
    if (isFuture) {
      setMsg(row.residentId, { tone: 'warn', text: MSG_FUTURE })
      return false
    }
    if (actorId === null) {
      setMsg(row.residentId, { tone: 'warn', text: MSG_NO_RECORDER })
      return false
    }
    if (hasPendingDaycareAttendance(row.residentId, day, row.attendance?.id ?? null)) {
      setMsg(row.residentId, { tone: 'info', text: MSG_ROW_PENDING })
      return false
    }
    return true
  }

  /** 保存の結果を行へ（読み直し・案内）。成功は true */
  const afterWrite = (id: number, r: DaycareAttendance | 'conflict' | 'queued'): boolean => {
    if (r === 'conflict') {
      setMsg(id, { tone: 'warn', text: MSG_CONFLICT })
      scheduleReload()
      return false
    }
    if (r === 'queued') {
      setMsg(id, { tone: 'info', text: isQueuePersisted() ? MSG_QUEUED : MSG_NOT_PERSISTED })
      return true
    }
    putAttendance(r)
    setMsg(id, null)
    return true
  }

  /**
   * 失敗の文言。timesTouched＝到着・帰宅の時刻を変える書き込み（到着・帰宅・時刻を消す欠席・取り消し）。過去の日のその書き込みが
   * DB（0042 のトリガ）で止まった時だけ「このアカウントでは使えません」ではなく「時刻は事務所で」と出す（入浴など時刻と関係ない
   * 書き込みの拒否は今までどおりの文言＝反証レビュー4巡目 F7）
   */
  const errText = (e: unknown, timesTouched = false) => {
    if (timesTouched && e instanceof DbError && e.kind === 'forbidden' && dayRef.current < todayIso()) return MSG_PAST_TIME
    return e instanceof DbError ? e.message : '保存できませんでした。通信状態を確認して、もう一度押してください。'
  }
  /** その書き込みで到着・帰宅の時刻が変わるか（いまの行と比べる。時刻の無い方の欠席は変わらない） */
  const touchesTimes = (patch: Partial<Pick<DaycareAttendance, 'arrived_at' | 'left_at'>>, cur: DaycareAttendance | null) =>
    (patch.arrived_at !== undefined && hmOf(patch.arrived_at) !== hmOf(cur?.arrived_at ?? null)) ||
    (patch.left_at !== undefined && hmOf(patch.left_at) !== hmOf(cur?.left_at ?? null))

  /** 到着の時刻・帰宅の時刻・欠席を書く（行が無ければ追加・あれば変えた列だけ）。戻り値は書いた後の行（送信待ち・競合は null） */
  const writeAttendance = async (
    row: DaycareBoardRow,
    patch: Partial<Pick<DaycareAttendance, 'arrived_at' | 'left_at' | 'absent' | 'absent_reason'>>,
  ): Promise<DaycareAttendance | null | 'failed'> => {
    const id = row.residentId
    try {
      await ensureOpened()
      const cur = row.attendance
      const r =
        cur === null
          ? await insertDaycareAttendance({
              resident_id: id,
              day,
              arrived_at: patch.arrived_at ?? null,
              left_at: patch.left_at ?? null,
              absent: patch.absent ?? false,
              absent_reason: patch.absent_reason ?? null,
              note: null,
              recorded_by: actorId,
            })
          : await updateDaycareAttendance(cur, patch, { editedBy: actorId })
      const ok = afterWrite(id, r)
      if (!ok) return 'failed'
      return r === 'queued' ? null : (r as DaycareAttendance)
    } catch (e) {
      setMsg(id, { tone: 'danger', text: errText(e, touchesTimes(patch, row.attendance)) })
      return 'failed'
    }
  }

  // ── 到着（＝在席） ──
  const onArrive = async (row: DaycareBoardRow) => {
    if (!precheck(row)) return
    if (day !== todayIso()) {
      // 過去の日: 事務所のログインは時刻を入れる小窓（予定の開始を初めの値に）。現場は止める
      if (canEditPastDaycareTimes(role)) openTime(row, 'arrive')
      else setMsg(row.residentId, { tone: 'warn', text: MSG_PAST_TIME })
      return
    }
    setRowBusy(row.residentId, true)
    const t = nowHm()
    const res = await writeAttendance(row, { arrived_at: t, left_at: null, absent: false, absent_reason: null })
    setRowBusy(row.residentId, false)
    if (res === 'failed') return
    show(`${nameOf(row.residentId)}さんの到着を記録しました（${hmShort(t)}・在席）`, res === null ? undefined : () => void undo(res, { arrived_at: null }))
  }

  // ── 帰宅 ──
  const onLeave = async (row: DaycareBoardRow) => {
    if (!precheck(row)) return
    if (day !== todayIso()) {
      if (canEditPastDaycareTimes(role)) openTime(row, 'leave')
      else setMsg(row.residentId, { tone: 'warn', text: MSG_PAST_TIME })
      return
    }
    setRowBusy(row.residentId, true)
    const t = nowHm()
    const res = await writeAttendance(row, { left_at: t })
    setRowBusy(row.residentId, false)
    if (res === 'failed') return
    show(`${nameOf(row.residentId)}さんの帰宅を記録しました（${hmShort(t)}）`, res === null ? undefined : () => void undo(res, { left_at: null }))
  }

  /** 元に戻す（トーストから・rev 照合。他の端末が先に変えていたら読み直して知らせる） */
  const undo = async (row: DaycareAttendance, patch: Partial<Pick<DaycareAttendance, 'arrived_at' | 'left_at' | 'absent' | 'absent_reason'>>) => {
    try {
      const r = await updateDaycareAttendance(row, patch, { editedBy: actorId })
      afterWrite(row.resident_id, r)
    } catch (e) {
      setMsg(row.resident_id, { tone: 'danger', text: errText(e, touchesTimes(patch, row)) })
    }
  }

  // ── 欠席（理由を選んだ時点で記録） ──
  const onAbsentPick = async (row: DaycareBoardRow, reason: DaycareAbsentReason) => {
    setAbsentFor(null)
    if (!precheck(row)) return
    setRowBusy(row.residentId, true)
    // 元に戻す時に到着・帰宅の時刻も戻す（欠席は時刻を消すため＝反証レビュー軽8）
    const prev = row.attendance
    const res = await writeAttendance(row, { absent: true, absent_reason: reason, arrived_at: null, left_at: null })
    if (res === 'failed') {
      setRowBusy(row.residentId, false)
      return
    }
    const bath = await recordAbsentBath({ residentId: row.residentId, day, bathingPlanned: row.bathingPlanned, recordedBy: actorId })
    setRowBusy(row.residentId, false)
    afterAbsentBath(row, bath)
    const bathTouched = bath.status === 'done' || bath.status === 'queued' || bath.status === 'already'
    show(
      `${nameOf(row.residentId)}さんを休みにしました（${DAYCARE_ABSENT_REASON_LABEL[reason]}）`,
      res === null ? undefined : () => void undoAbsent(res, prev, bathTouched),
    )
    scheduleReload()
  }

  const afterAbsentBath = (row: DaycareBoardRow, r: AbsentBathResult) => {
    const id = row.residentId
    if (r.status === 'needsConfirm') {
      setConfirm({
        title: '入浴の記録を直しますか',
        body: `${nameOf(id)}さんには「入浴した」の記録があります。休みにすると、入浴の記録を「入浴していない（欠席）」に直します。`,
        label: '入浴の記録を直す',
        run: () => {
          setConfirm(null)
          void (async () => {
            setRowBusy(id, true)
            const again = await recordAbsentBath({ residentId: id, day, bathingPlanned: row.bathingPlanned, recordedBy: actorId, confirmManual: true })
            setRowBusy(id, false)
            afterAbsentBath(row, again)
            scheduleReload()
          })()
        },
      })
      return
    }
    if (r.status === 'blocked') setMsg(id, { tone: 'warn', text: `休みは記録しました。入浴の記録は直していません（${r.message}）` })
    else if (r.status === 'conflict') setMsg(id, { tone: 'warn', text: `休みは記録しました。入浴の記録が他の端末で直されていたため、入浴の記録は直していません。${place.bathCheck}か、入浴の画面（「その他」→「入浴 月次表」→〔入浴の記録を直す ›〕）で確かめてください。` })
    else if (r.status === 'queued') setMsg(id, { tone: 'info', text: `休みは記録しました。入浴の「入浴していない（欠席）」は${MSG_QUEUED}` })
    else if (r.status === 'kept') setMsg(id, { tone: 'info', text: '休みは記録しました。入浴は「入浴していない」の記録があるので、そのままにしました。' })
  }

  const undoAbsent = async (row: DaycareAttendance, prev: DaycareAttendance | null, bathTouched: boolean) => {
    await undo(row, { absent: false, absent_reason: null, arrived_at: prev?.arrived_at ?? null, left_at: prev?.left_at ?? null })
    if (bathTouched) {
      setMsg(row.resident_id, {
        tone: 'info',
        text: `休みを取り消しました。入浴の記録は「入浴していない（欠席）」のままです。入浴した場合は、${place.bathRedo}から記録し直してください。`,
      })
    }
    scheduleReload()
  }

  /** 欠席を取り消した後: 入浴の「中止・欠席」は消さずに案内する */
  const noteBathAfterAbsentCancel = (id: number) => {
    const b = bathOf(id)
    if (b !== null && b.result === 'cancel' && b.cancel_reason === 'absent') {
      setMsg(id, { tone: 'info', text: `休みを取り消しました。入浴の記録は「入浴していない（欠席）」のままです。入浴した場合は、${place.bathRedo}から記録し直してください。` })
    }
  }

  /** 欠席の方に入浴の記録（自動・人の入浴）が残っている時、入浴を「中止・欠席」に直す（人の入浴は確認つき） */
  const onAbsentBathFix = async (row: DaycareBoardRow) => {
    if (!precheck(row)) return
    setRowBusy(row.residentId, true)
    const r = await recordAbsentBath({ residentId: row.residentId, day, bathingPlanned: true, recordedBy: actorId })
    setRowBusy(row.residentId, false)
    afterAbsentBath(row, r)
    scheduleReload()
  }

  const askAbsent = (row: DaycareBoardRow) => {
    if (!precheck(row)) return
    if (hasTimes(row) && !canChangeDaycareTimes(day, todayIso(), role)) {
      setMsg(row.residentId, { tone: 'warn', text: MSG_PAST_TIME_CLEAR })
      return
    }
    setAbsentFor(row)
  }

  // ── 休みの1タップ（代表者の決定 2026-10-23: 〔休み〕を押すだけで理由「後で」の休み。理由は行から後で選ぶ） ──
  // ・自動の到着・帰宅（0047）の後でも、時刻を消して休みにする（確かめは挟まない）。人が入れた時刻がある方だけ確かめを挟む
  // ・入浴は既存の recordAbsentBath で「中止（欠席）」に直す。直後の〔元に戻す〕は全部を元どおりにする（決定 4）
  // ・0047 を当てる前の DB（自動の印の列を読めない）は「後で」を受け付けないので、理由を選ぶ小窓にする（能力の観測）
  const onRest = (row: DaycareBoardRow) => {
    if (!precheck(row)) return
    if (hasTimes(row) && !canChangeDaycareTimes(day, todayIso(), role)) {
      setMsg(row.residentId, { tone: 'warn', text: MSG_PAST_TIME_CLEAR })
      return
    }
    if (daycareAutoColumnsSeen() !== true) {
      setAbsentFor(row)
      return
    }
    const a = row.attendance
    if (a !== null && hasManualTimes(a)) {
      setConfirm({
        title: '休みにしますか',
        body: `${nameOf(row.residentId)}さんの到着${a.left_at !== null ? '・帰宅' : ''}の記録（${hmShort(a.arrived_at)}${a.left_at !== null ? `〜${hmShort(a.left_at)}` : ''}）を取り消して休みにします。`,
        label: '休みにする',
        danger: true,
        run: () => {
          setConfirm(null)
          void restNow(row)
        },
      })
      return
    }
    void restNow(row)
  }

  const restNow = async (row: DaycareBoardRow) => {
    const id = row.residentId
    const patch = { absent: true, absent_reason: 'later' as const, arrived_at: null, left_at: null }
    // 押した時に、この後に 12:30 の自動の入浴が来るはずだったか（休みで作った入浴の行を〔元に戻す〕で自動と同じ区分にしてよいか）
    const beforeAutoBath = row.autoBath === true && day === todayIso() && nowHm() < DAYCARE_AUTO_BATH_AT
    setRowBusy(id, true)
    let before: DaycareAttendance | null = row.attendance
    let saved: DaycareAttendance | null
    try {
      await ensureOpened()
      let r =
        before === null
          ? await insertDaycareAttendance({ resident_id: id, day, ...patch, note: null, recorded_by: actorId })
          : await updateDaycareAttendance(before, patch, { editedBy: actorId })
      if (r === 'conflict' && before === null) {
        // 押した瞬間に定時の処理の自動の到着が先に入った: 読み直し、人が手を入れていない自動の行ならそのまま休みに直す
        const now = (await fetchDaycareAttendance(day)).find((x) => x.resident_id === id) ?? null
        if (now !== null && isAutoOnlyAttendance(now)) {
          before = now
          r = await updateDaycareAttendance(now, patch, { editedBy: actorId })
        }
      }
      if (!afterWrite(id, r)) {
        setRowBusy(id, false)
        return
      }
      saved = r === 'queued' ? null : (r as DaycareAttendance)
    } catch (e) {
      setMsg(id, { tone: 'danger', text: errText(e, touchesTimes(patch, before)) })
      setRowBusy(id, false)
      return
    }
    const bath = await recordAbsentBath({ residentId: id, day, bathingPlanned: row.bathingPlanned, recordedBy: actorId })
    setRowBusy(id, false)
    afterAbsentBath(row, bath)
    show(
      `${nameOf(id)}さんを休みにしました（${place.reasonHint}）`,
      saved === null ? undefined : () => void undoRest(row, saved, before, beforeAutoBath, bath),
    )
    scheduleReload()
  }

  /**
   * 休みの直後の〔元に戻す〕（決定 4: 全部を元どおり）。到着・帰宅の時刻と自動の印を戻す（もともと定時の処理が入れた行を元の形に
   * 戻すだけ）。押す前に行が無かった方は行を取り消して「行が無い」形に戻す（定時の処理がその後も到着を入れる）。
   * 入浴は（代表者の回答 A5）、休みで「中止（欠席）」にした行を 12:30 の自動と同じ区分に戻す: 自動の行を直していた時は元の区分、
   * 休みで新しく作った行は、12:30 の自動の相手（row.autoBath）で今日の 12:30 より前の時だけ、休業日なら訪問介護で入浴・それ以外は
   * 全身浴にする。自動の相手でない方・12:30 を過ぎた（自動が行を作らなかった）方は、休みで作った行を取り消して「行が無い」形に
   * 戻す（入浴したことにしない＝反証 中4）。自動の印は付けない（0015 からの決まり「端末は自動の記録を作らない」＝
   * tests/med.test.mjs を守る）ので、戻した区分は人の記録と同じ「✓ 全身浴」と出る。
   * 人が入れた入浴の行は休みで直していない（確認を挟む）ので触らない
   */
  const undoRest = async (row: DaycareBoardRow, saved: DaycareAttendance, before: DaycareAttendance | null, beforeAutoBath: boolean, bath: AbsentBathResult) => {
    const id = row.residentId
    try {
      const r =
        before === null
          ? await softDeleteDaycareAttendance(saved, { editedBy: actorId })
          : await updateDaycareAttendance(
              saved,
              {
                absent: before.absent,
                absent_reason: before.absent ? before.absent_reason : null,
                arrived_at: before.arrived_at,
                left_at: before.left_at,
                arrived_auto: before.arrived_auto === true,
                left_auto: before.left_auto === true,
              },
              { editedBy: actorId },
            )
      if (r === 'conflict') {
        setMsg(id, { tone: 'warn', text: MSG_CONFLICT })
        scheduleReload()
        return
      }
      if (r !== true) afterWrite(id, r)
      else dropAttendance(saved)
    } catch (e) {
      setMsg(id, { tone: 'danger', text: errText(e, true) })
      return
    }
    // 戻し方は、休みの処理が実際にした事（recordAbsentBath の結果）で決める（端末の一覧の値は古いことがある＝確認の反証 軽3）:
    // 自動の行を直した → 元の区分に戻す／行を新しく作った → 押した時に 12:30 の自動の相手で 12:30 より前なら自動と同じ区分、
    // それ以外は行を取り消す（入浴したことにしない）。人の入浴の行は確認を挟んで別に直すので、ここでは触らない
    const restored = bath.status === 'done' && bath.record.result === 'cancel' && bath.record.cancel_reason === 'absent' && (bath.autoResult !== undefined || bath.inserted === true)
    if (bath.status === 'done' && restored) {
      const back: 'full' | 'visit' =
        bath.autoResult === 'full' || bath.autoResult === 'visit' ? bath.autoResult : resultForBathed(day, closedDates) === 'visit' ? 'visit' : 'full'
      try {
        const b =
          bath.inserted === true && !beforeAutoBath
            ? await softDeleteBath(bath.record.id, bath.record.rev, { editedBy: actorId })
            : await updateBath(bath.record, { result: back, cancel_reason: null }, { editedBy: actorId })
        if (b === 'conflict') setMsg(id, { tone: 'warn', text: `休みは取り消しました。入浴の記録が他の端末で直されていたため、入浴は戻していません。${place.bathCheck}で確かめてください。` })
      } catch (e) {
        setMsg(id, { tone: 'warn', text: `休みは取り消しました。入浴の記録は「入浴していない（欠席）」のままです（${errText(e)}）。${place.bathRedo}から直してください。` })
      }
    }
    scheduleReload()
  }

  /** 休みの理由を後から選ぶ（「後で」の休みの行から）。休みのまま理由だけを変える */
  const onReasonPick = async (row: DaycareBoardRow, reason: DaycareAbsentReason) => {
    setAbsentFor(null)
    const a = row.attendance
    if (!precheck(row) || a === null || !a.absent) return
    setRowBusy(row.residentId, true)
    try {
      const r = await updateDaycareAttendance(a, { absent_reason: reason }, { editedBy: actorId })
      if (afterWrite(row.residentId, r) && r !== 'queued') {
        show(`${nameOf(row.residentId)}さんの休みの理由を記録しました（${DAYCARE_ABSENT_REASON_LABEL[reason]}）`)
      }
    } catch (e) {
      setMsg(row.residentId, { tone: 'danger', text: errText(e) })
    } finally {
      setRowBusy(row.residentId, false)
    }
  }

  // ── 時刻を入れる・直す（事務所のログイン・過去の日も） ──
  const openTime = (row: DaycareBoardRow, mode: 'arrive' | 'leave' | 'fix') => {
    const a = row.attendance
    const plan = row.plans[0] ?? null
    setTimeArr(hmOf(a?.arrived_at) ?? (mode === 'arrive' ? (planHm(plan?.start) ?? '') : ''))
    setTimeLeft(hmOf(a?.left_at) ?? (mode === 'leave' ? (planHm(row.plans[row.plans.length - 1]?.end) ?? '') : ''))
    setTimeErr(null)
    setTimeFor({ row, mode })
  }
  const saveTime = async () => {
    const t = timeFor
    if (t === null) return
    const arrived_at = timeArr === '' ? null : timeArr
    const left_at = timeLeft === '' ? null : timeLeft
    if (arrived_at === null) {
      setTimeErr('到着の時刻を入れてください。')
      return
    }
    const v = validateAttendance({ absent: false, absent_reason: null, arrived_at, left_at })
    if (!v.ok) {
      setTimeErr(v.message)
      return
    }
    if (!precheck(t.row)) {
      setTimeFor(null)
      return
    }
    setTimeFor(null)
    setRowBusy(t.row.residentId, true)
    const res = await writeAttendance(t.row, { arrived_at, left_at, absent: false, absent_reason: null })
    setRowBusy(t.row.residentId, false)
    if (res === 'failed') return
    const prev = t.row.attendance
    show(
      `${nameOf(t.row.residentId)}さんの時刻を記録しました（到着 ${hmShort(arrived_at)}${left_at !== null ? `・帰宅 ${hmShort(left_at)}` : ''}）`,
      res === null ? undefined : () => void undo(res, { arrived_at: prev?.arrived_at ?? null, left_at: prev?.left_at ?? null }),
    )
  }

  const askCancelAbsent = (row: DaycareBoardRow) => {
    if (!precheck(row) || row.attendance === null) return
    const a = row.attendance
    setConfirm({
      title: '休みを取り消しますか',
      body: `${nameOf(row.residentId)}さんの休みの記録を取り消して「予定」に戻します。到着は自動では戻りません（${place.arriveHint}）。入浴の記録は消しません。`,
      label: '休みを取り消す',
      danger: true,
      run: () => {
        setConfirm(null)
        void (async () => {
          setRowBusy(row.residentId, true)
          await undo(a, { absent: false, absent_reason: null })
          setRowBusy(row.residentId, false)
          noteBathAfterAbsentCancel(row.residentId)
        })()
      },
    })
  }

  const askCancelLeave = (row: DaycareBoardRow) => {
    if (!precheck(row) || row.attendance === null) return
    if (!canChangeDaycareTimes(day, todayIso(), role)) {
      setMsg(row.residentId, { tone: 'warn', text: MSG_PAST_TIME_CLEAR })
      return
    }
    const a = row.attendance
    setConfirm({
      title: '帰宅の記録を取り消しますか',
      body: `${nameOf(row.residentId)}さんの帰宅（${hmShort(a.left_at)}）を取り消して「在席」に戻します。`,
      label: '帰宅を取り消す',
      danger: true,
      run: () => {
        setConfirm(null)
        void (async () => {
          setRowBusy(row.residentId, true)
          await undo(a, { left_at: null })
          setRowBusy(row.residentId, false)
        })()
      },
    })
  }

  // ── 入浴（既存の入浴記録 bath_records と insertBath／updateBath をそのまま使う） ──
  // 〔予定どおり実施〕: 記録が無ければ「全身浴」（休業日は訪問介護で入浴）を追加、自動の記録（確かめていない予定値）なら
  //   同じ区分のまま人の記録にする（updateBath が auto=false と記入者を一緒に送る＝確かめた印）。
  // 〔区分・中止を選ぶ〕: 全身浴・シャワー浴・部分浴・清拭・入浴していない（理由）。押し直しで直せる（取り消しは入浴の画面）。
  // cron（private.care_auto_bath_on）と input_enabled_bath は変えない
  const writeBath = async (row: DaycareBoardRow, result: BathResult, reason: BathCancelReason | null, word: string) => {
    if (!precheck(row)) return
    const id = row.residentId
    const cur = bathOf(id)
    if (hasPendingBath(id, day, cur?.id ?? null)) {
      setMsg(id, { tone: 'info', text: MSG_ROW_PENDING })
      return
    }
    setRowBusy(id, true)
    try {
      await ensureOpened()
      const cancel_reason = result === 'cancel' ? reason : null
      const r =
        cur === null
          ? await insertBath({ resident_id: id, bath_on: day, result, cancel_reason, note: null, recorded_by: actorId })
          : await updateBath(cur, { result, cancel_reason }, { editedBy: actorId })
      if (r === 'conflict') {
        setMsg(id, { tone: 'warn', text: MSG_CONFLICT })
        scheduleReload()
      } else if (r === 'queued') {
        setMsg(id, { tone: 'info', text: isQueuePersisted() ? MSG_QUEUED : MSG_NOT_PERSISTED })
      } else {
        putBath(r)
        setMsg(id, null)
        show(`${nameOf(id)}さんの入浴を「${word}」で記録しました（直す時は入浴の〔区分・中止を選ぶ〕を押してください）`)
      }
    } catch (e) {
      setMsg(id, { tone: 'danger', text: errText(e) })
    } finally {
      setRowBusy(id, false)
    }
  }

  /** 〔予定どおり実施〕（1タップ）。自動の記録は区分をそのままに人の記録へ、記録が無ければ全身浴（休業日は訪問介護で入浴） */
  const onBathAsPlanned = (row: DaycareBoardRow) => {
    const cur = bathOf(row.residentId)
    const result: BathResult = cur !== null && cur.auto && cur.result !== 'cancel' ? cur.result : resultForBathed(day, closedDates)
    void writeBath(row, result, null, `予定どおり実施（${BATH_RESULT_LABEL[result]}）`)
  }

  const onBathPick = (row: DaycareBoardRow, result: BathResult, reason: BathCancelReason | null) => {
    setBathFor(null)
    const word = result === 'cancel' ? `入浴していない（${reason === null ? '理由なし' : BATH_CANCEL_REASON_LABEL[reason]}）` : BATH_RESULT_LABEL[result]
    void writeBath(row, result, reason, word)
  }

  /** 入浴の小窓を開く（書き込みの前の確かめが通った時だけ） */
  const openBath = (row: DaycareBoardRow) => {
    if (precheck(row)) setBathFor(row)
  }

  const dialogs = (
    <>

    <ModalShell open={absentFor !== null} label="休みの理由" onClose={() => setAbsentFor(null)}>
      {absentFor !== null ? (
        <div className="p-4">
          <h2 className="text-lg font-bold text-ink">休みの理由（{nameOf(absentFor.residentId)}さん）</h2>
          {attendanceState(absentFor.attendance) === 'present' ? (
            <p className="mt-2 text-base text-ink2">到着の記録（{hmShort(absentFor.attendance?.arrived_at ?? null)}）を取り消して休みにします。</p>
          ) : null}
          <p className="mt-2 text-sm text-ink2">
            {absentFor.attendance?.absent === true
              ? '理由を押すと、休みの理由を記録します。'
              : '理由を押すと休みを記録します（入浴の予定は「入浴していない（欠席）」になります）。'}
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-gap sm:grid-cols-2">
            {DAYCARE_ABSENT_REASONS.map((r) => (
              <li key={r}>
                <button
                  type="button"
                  onClick={() => void (absentFor.attendance?.absent === true ? onReasonPick(absentFor, r) : onAbsentPick(absentFor, r))}
                  className="min-h-14 w-full rounded border border-border-strong bg-surface px-4 text-lg text-ink"
                >
                  {DAYCARE_ABSENT_REASON_LABEL[r]}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end">
            <button type="button" onClick={() => setAbsentFor(null)} className="min-h-tap rounded border border-border-strong px-4 text-base text-ink">
              キャンセル
            </button>
          </div>
        </div>
      ) : null}
    </ModalShell>

    <ModalShell open={timeFor !== null} label="到着・帰宅の時刻" onClose={() => setTimeFor(null)}>
      {timeFor !== null ? (
        <div className="p-4">
          <h2 className="text-lg font-bold text-ink">
            {timeFor.mode === 'arrive' ? '到着を記録' : timeFor.mode === 'leave' ? '帰宅を記録' : '時刻を直す'}（{nameOf(timeFor.row.residentId)}さん・{fmtDayLabel(day)}）
          </h2>
          <p className="mt-2 text-sm text-ink2">
            {day === today
              ? '到着・帰宅の時刻を入れます（遅れて来た日・早く帰った日は実際の時刻に直してください）。帰宅は空のままにできます。'
              : '到着・帰宅の時刻を入れます（事務所のログイン）。帰宅は空のままにできます。'}
          </p>
          <div className="mt-3 grid grid-cols-1 gap-gap sm:grid-cols-2">
            <label className="block text-base text-ink">
              到着の時刻
              <input
                type="time"
                step={60}
                value={timeArr}
                onChange={(e) => {
                  setTimeArr(e.target.value)
                  setTimeErr(null)
                }}
                className="mt-1 block min-h-tap w-full rounded border border-border-strong bg-surface px-3 text-lg text-ink"
              />
            </label>
            <label className="block text-base text-ink">
              帰宅の時刻
              <input
                type="time"
                step={60}
                value={timeLeft}
                onChange={(e) => {
                  setTimeLeft(e.target.value)
                  setTimeErr(null)
                }}
                className="mt-1 block min-h-tap w-full rounded border border-border-strong bg-surface px-3 text-lg text-ink"
              />
            </label>
          </div>
          {timeErr !== null ? (
            <p role="alert" className="mt-3 rounded border border-danger bg-danger-bg p-2 text-base text-ink">
              <span aria-hidden="true">▲ </span>
              {timeErr}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-end gap-gap">
            {timeFor.mode === 'fix' && timeFor.row.attendance?.left_at ? (
              <button
                type="button"
                onClick={() => {
                  const r = timeFor.row
                  setTimeFor(null)
                  askCancelLeave(r)
                }}
                className="mr-auto min-h-tap rounded border border-danger px-4 text-base text-danger"
              >
                帰宅を取り消す
              </button>
            ) : null}
            <button type="button" onClick={() => setTimeFor(null)} className="min-h-tap rounded border border-border-strong px-4 text-base text-ink">
              キャンセル
            </button>
            <button
              type="button"
              onClick={() => void saveTime()}
              className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
            >
              記録する
            </button>
          </div>
        </div>
      ) : null}
    </ModalShell>

    <ModalShell open={bathFor !== null} label="入浴の区分・中止" onClose={() => setBathFor(null)}>
      {bathFor !== null ? (
        <div className="p-4">
          <h2 className="text-lg font-bold text-ink">入浴の記録（{nameOf(bathFor.residentId)}さん）</h2>
          {attendanceState(bathFor.attendance) === 'absent' ? (
            <>
              <p className="mt-2 text-base text-ink">休みの方に入浴の記録が残っています。「入浴していない（欠席）」に直します。</p>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => {
                    const r = bathFor
                    setBathFor(null)
                    void onAbsentBathFix(r)
                  }}
                  className="min-h-14 w-full rounded border border-primary bg-primary px-3 text-lg font-bold text-primary-ink"
                >
                  入浴を「入浴していない（欠席）」にする
                </button>
              </div>
            </>
          ) : (
            <>
          <p className="mt-2 text-sm text-ink2">押した区分で記録します（押し直すと直せます）。</p>
          {daycareBathStatus(bathOf(bathFor.residentId), bathFor.bathingPlanned).kind === 'todo' ? (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => {
                  const r = bathFor
                  setBathFor(null)
                  onBathAsPlanned(r)
                }}
                className="min-h-14 w-full rounded border border-primary bg-primary px-3 text-lg font-bold text-primary-ink"
              >
                予定どおり実施
              </button>
            </div>
          ) : null}
          <h3 className="mt-3 text-base font-bold text-ink">入浴した</h3>
          <ul className="mt-2 grid grid-cols-1 gap-gap sm:grid-cols-3">
            {(['full', 'shower', 'partial'] as const).map((res) => (
              <li key={res}>
                <button
                  type="button"
                  onClick={() => onBathPick(bathFor, res === 'full' ? resultForBathed(day, closedDates) : res, null)}
                  className="min-h-14 w-full rounded border border-primary bg-surface px-3 text-lg text-primary"
                >
                  {BATH_RESULT_LABEL[res]}
                </button>
              </li>
            ))}
          </ul>
          <h3 className="mt-4 text-base font-bold text-ink">入浴していない（中止の理由）</h3>
          <ul className="mt-2 grid grid-cols-1 gap-gap sm:grid-cols-2">
            {(['condition', 'refusal', 'facility', null] as const).map((rs) => (
              <li key={rs ?? 'none'}>
                <button
                  type="button"
                  onClick={() => onBathPick(bathFor, 'cancel', rs)}
                  className="min-h-14 w-full rounded border border-border-strong bg-surface px-3 text-lg text-ink"
                >
                  {rs === null ? '理由を選ばない' : BATH_CANCEL_REASON_LABEL[rs]}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-ink2">休みの時は、この小窓ではなく〔休み〕から記録してください（入浴も「入浴していない（欠席）」になります）。</p>
            </>
          )}
          <div className="mt-4 flex justify-end">
            <button type="button" onClick={() => setBathFor(null)} className="min-h-tap rounded border border-border-strong px-4 text-base text-ink">
              キャンセル
            </button>
          </div>
        </div>
      ) : null}
    </ModalShell>

    <ConfirmDialog
      open={confirm !== null}
      title={confirm?.title ?? ''}
      body={confirm?.body}
      confirmLabel={confirm?.label}
      danger={confirm?.danger}
      onConfirm={() => confirm?.run()}
      onCancel={() => setConfirm(null)}
    />
    </>
  )

  return {
    busy,
    rowMsg,
    setMsg,
    precheck,
    onArrive,
    onLeave,
    onRest,
    askAbsent,
    askCancelAbsent,
    openTime,
    openBath,
    onBathAsPlanned,
    dialogs,
  }
}
