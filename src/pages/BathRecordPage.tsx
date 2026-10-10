// 入浴（デイ）の記録（記録ハブ →「入浴（デイ）」／ルート /record/bath）。2026-09-26 追加。
//
// 一覧＝その日の入浴予定者（週間計画の写し・RPC daycare_bath_plan）＋その日に記録がある人＋画面で足した予定外の人。
// 入院中の方は予定があっても「未記録」に数えず「入院」と出す（件数の「予定」からも除く・2026-09-26 チーフ裁定）。
// その人・その日に未送信の記録（この端末の送信待ち・送信中）がある行は、区分ボタンと取り消しを押せなくする
// （圏外で続けて押した2件目の追加が 23505 で止まるのを防ぐ。送信待ちそのものは書き換えない・2026-09-26 レビュー3巡目）。
// 送信待ちの件数が減ったら、その日の記録を読み直して行を記録済みに戻す（自分の書込の通知は isSelfWrite で無視されるため）。
// 並びは居室順。各行は［入浴した］［入浴していない］の2つだけ（2026-10-01 代表指示。区分・中止の理由は選ばない）。
// 押すと記録する（押し直すと修正、取り消しは確認つき）。「入浴した」は全身浴（full。デイの休業日は訪問介護で入浴＝visit）、
// 「入浴していない」は中止（理由なし）で保存する。
// 以前の記録（シャワー浴・部分浴・訪問介護で入浴）は「入浴した」、中止は「入浴していない」と出す（DB の値は書き換えない）。
// 12:30（bath.ts の BATH_AUTO_TIME）に DB 側（0015 の cron）が予定者を自動で記録する（2026-09-27 代表指示）。
// 自動で入った記録かどうかは画面に出さない（2026-10-01 代表指示）。入浴しなかった方は［入浴していない］を押す＝直すと手動の記録（記入者つき）。
// 12:30 より前の今日は従来どおり「未記録」。自動の記録は端末では作らない（この画面は表示と直すだけ）。
// デイの休業日（12/31〜1/3 など・0016）は、12:30 に予定者が「訪問介護で入浴」（visit）で自動記録される。画面では「入浴した」と出す。
// 多端末の運用（2026-10-10 監査の修正）:
//   ・開いたまま日付が変わったら、今日を見ていて 入力中（備考の書きかけ・予定外に足した人・小窓）・保存中・未送信・
//     止まった記録が無ければ今日へ切り替える。あれば切り替えずに「日付が変わりました〔今日を開く〕」の帯を出す（F18）
//   ・読み込み・読み直しには世代を付け、最新の世代 かつ 今の日付の応答だけを表へ入れる（F20。日付を変えた直後に前の日の
//     応答で上書きしない・保存の後に保存前の読み直しで自分の記録を消さない）。表示と書き込みの入口でも日付を確かめる
//   ・送れずに止まった記録・取り消し・修正は、その方の行に出し、設定タブへ案内する（F37）
//   ・App が配り直した職員名簿は名簿だけを差し替える（F47。名簿のたびに入力解禁を取り直して画面を「準備中」に戻さない）
//
// 規律:
// - 取得・保存は db.ts の関数のみ（supabase を直呼びしない）
// - 入力解禁は input_enabled_bath（getKindInputGate('bath')）。native_input_enabled とは別の旗
//   （封鎖中は隠さずにディセーブル＋理由文。書込関数の入口でも同じ旗で止まる＝二重ガード）
// - 修正は rev 照合。他の端末が先に書いていたら（conflict）入力を消さずに読み直しを促す
// - 通信できない時は送信待ち（'queued'）。端末に残せなかった時は入力を画面に残して知らせる
// - 予定（写し）が取れなくても記録は妨げない（予定外の追加から記録できる）
// - 日付は画面の中だけで持つ（業務データに紐づく状態は保存しない＝原則11の既定）。現在地は URL で復元
// - 氏名・記録を localStorage・console に出さない。色だけで意味を伝えない（✓・「未」・文字を併記）

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  FORBIDDEN_REASON,
  DbError,
  fetchAllResidents,
  fetchBathDay,
  fetchBathPlan,
  fetchStaff,
  getAppSetting,
  getKindInputGate,
  hasPendingBath,
  insertBath,
  isQueuePersisted,
  isSelfWrite,
  kindBlockedMessage,
  listStoppedOps,
  queueSubscribe,
  softDeleteBath,
  subscribeBathChanges,
  updateBath,
} from '../lib/db'
import type { BathPlanResult, StoppedOp } from '../lib/db'
import { resolveActor, touchActivity } from '../lib/actor'
import {
  BATH_AUTO_TIME,
  BATH_SHOWN,
  BATH_SHOWN_LABEL,
  bathShownOf,
  buildBathDayRows,
  countBathDay,
  DAYCARE_CLOSED_DEFAULT,
  fmtCopyStamp,
  isUnrecorded,
  keptCancelReason,
  resultForBathed,
  validateBathInput,
} from '../lib/bath'
import type { BathDayRow, BathShown } from '../lib/bath'
import { fmtDayLabel, fmtTimeHM, todayIso } from '../lib/format'
import type { BathCancelReason, BathRecord, BathResult, Resident, Staff } from '../lib/types'
import {
  ConfirmDialog,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  ResidentPickerModal,
  SectionCard,
  StaffPickerModal,
  useToast,
} from '../components/ui'

const ERR_LOAD =
  '入浴の記録を読み込めませんでした。通信状態を確認して、再試行してください。'
const ERR_GATE =
  '入浴の記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。記録の閲覧はこのままできます。'
const MSG_CONFLICT =
  '他の端末が先にこの方の記録を保存・変更しました。最新の内容に読み直しました。確かめてから、もう一度選んでください（入力した備考は残っています）。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度選んでください。'
const MSG_SAVE_FAILED = '保存できませんでした。通信状態を確認して、もう一度選んでください。'
const MSG_NO_RECORDER = '記入者が選ばれていません。上の「記入者」で選んでから記録・取り消しをしてください。'
const MSG_ROW_PENDING = '未送信の記録があります。送信が終わってから直してください'
/** 表示中の日付と違う日の記録を直そうとした（古い読み直しが残っていた時の歯止め・F20） */
const MSG_OTHER_DAY = '表示中の日付と違う日の記録でした。読み直したので、確かめてからもう一度選んでください。'
/** 送れずに止まった記録の案内（F37。どうするかは設定タブの「未送信データ」で選ぶ） */
const MSG_STOPPED_GUIDE = '自動では送りません。設定タブの「未送信データ」で、いまの記録とくらべてどうするか選んでください。'

type RowMsg = { tone: 'warn' | 'danger' | 'info'; text: string }

/** 送信待ちにした入力（画面の表示だけ。送れたら次の読み込みで記録に置き換わる） */
interface LocalPending {
  result: BathResult
  cancel_reason: BathCancelReason | null
}

// ── 多端末の運用の判定（純関数・tests/medbath-multidevice.test.mjs が確かめる） ──

/**
 * 開いたまま日付が変わった時の動き（F18・2026-10-10 本人回答。与薬チェックと同じ規則）。今日を見ていた時だけ追従し、
 * 入力中・保存中・未送信・止まった記録がある（holding）なら切り替えずに帯で知らせる。手で過去の日を選んでいた時は何もしない
 */
export function dayRolloverAction(p: { day: string; prevToday: string; today: string; holding: boolean }): 'none' | 'switch' | 'notice' {
  if (p.today === p.prevToday || p.day !== p.prevToday) return 'none'
  return p.holding ? 'notice' : 'switch'
}

/** 読み込み・読み直しの応答を表へ入れてよいか（F20。最新の世代 かつ 取りに行った日が今の日 かつ 画面が出ている時だけ） */
export function acceptDayLoad(p: { gen: number; latestGen: number; day: string; shownDay: string; alive: boolean }): boolean {
  return p.alive && p.gen === p.latestGen && p.day === p.shownDay
}

/**
 * 送れずに止まった入浴の記録を、表示中の日の利用者ごとに当てる（F37）。追加は bath_on と利用者 id で、
 * 修正・取り消しは表示中の日の記録の id で当てる
 */
export function stoppedBathByResident(ops: readonly StoppedOp[], day: string, records: readonly BathRecord[]): Map<number, StoppedOp[]> {
  const byId = new Map(records.filter((r) => r.bath_on === day).map((r) => [r.id, r.resident_id] as const))
  const out = new Map<number, StoppedOp[]>()
  for (const op of ops) {
    if (op.table !== 'bath_records') continue
    let rid: number | null = null
    if (op.kind === 'insert' && op.payload.bath_on === day && typeof op.payload.resident_id === 'number') rid = op.payload.resident_id
    else if (op.kind === 'update' && op.rowId !== null) rid = byId.get(op.rowId) ?? null
    if (rid === null) continue
    out.set(rid, [...(out.get(rid) ?? []), op])
  }
  return out
}

/** 止まった入浴の記録の中身と、止まった理由の1行（F37） */
export function stoppedBathText(op: StoppedOp): string {
  const p = op.payload
  const shown = (v: unknown): string | null =>
    typeof v === 'string' && v !== '' ? `「${BATH_SHOWN_LABEL[bathShownOf(v as BathResult)]}」` : null
  const note = typeof p.note === 'string' && p.note.trim() !== '' ? `（備考: ${p.note}）` : ''
  let what: string
  if (op.kind === 'insert') what = `${shown(p.result) ?? ''}${note}の記録`
  else if ('deleted_at' in p) what = '記録の取り消し'
  else if (shown(p.result) !== null) what = `${shown(p.result)}${note}への修正`
  else what = `備考の修正${note}`
  const why =
    op.state === 'rejected'
      ? 'サーバーに受け付けられませんでした'
      : op.kind === 'insert'
        ? '他の端末が先にこの方の記録を保存しました'
        : '他の端末が先にこの記録を変更しました'
  return `送れずに止まっている${what}があります（${why}）。`
}

export interface BathRecordPageProps {
  /** App.tsx が持っている職員名簿（未指定ならこの画面が取得する） */
  staff?: Staff[]
  /** App.tsx の操作者（記入者の既定値。resolveActor が名簿と照合する） */
  actorId?: number | null
}

export function BathRecordPage({ staff: staffProp, actorId }: BathRecordPageProps = {}) {
  // 時計の取り直し（60 秒ごと・画面に戻った時）で描き直し、今日を取り直す（開いたまま日付が変わったことに気づく・F18）
  const [, setClockTick] = useState(0)
  const today = todayIso()
  const [day, setDay] = useState(today)
  const [dayMsg, setDayMsg] = useState<string | null>(null)
  /** 開いたまま日付が変わり、入力中・未送信があったので切り替えなかった時の、その時の表示日（帯を出す・F18） */
  const [rolloverDay, setRolloverDay] = useState<string | null>(null)

  const [residents, setResidents] = useState<Resident[] | null>(null)
  const [staff, setStaff] = useState<Staff[] | null>(staffProp ?? null)
  const [gate, setGate] = useState<{ value: boolean; observed: boolean; forbidden?: true } | null>(null)
  const [baseError, setBaseError] = useState<string | null>(null)
  const [baseTick, setBaseTick] = useState(0)

  const [records, setRecords] = useState<BathRecord[] | null>(null)
  const [plan, setPlan] = useState<BathPlanResult | 'error' | null>(null)
  const [dayError, setDayError] = useState<string | null>(null)
  const [dayTick, setDayTick] = useState(0)

  const [extras, setExtras] = useState<number[]>([])
  const [recorderId, setRecorderId] = useState<number | null>(null)
  const [staffPickerOpen, setStaffPickerOpen] = useState(false)
  const [residentPickerOpen, setResidentPickerOpen] = useState(false)
  const [notes, setNotes] = useState<Map<number, string>>(new Map())
  const [msgs, setMsgs] = useState<Map<number, RowMsg>>(new Map())
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [pending, setPending] = useState<Map<number, LocalPending>>(new Map())
  const [deleteFor, setDeleteFor] = useState<BathRecord | null>(null)
  // デイの休業日（app_settings の daycare_closed_dates）。読めない時は 0016 の既定値（12/31〜1/3）で判定する
  const [closedDates, setClosedDates] = useState<string>(DAYCARE_CLOSED_DEFAULT)
  const { toast, show } = useToast()
  const uid = useId()
  const aliveRef = useRef(true)
  // 読み込み・読み直しの世代と、表示中の日・記録の控え（F20。応答が返った時に「今も同じ日・最新の取得か」を確かめる）
  const genRef = useRef(0)
  const inFlightRef = useRef(0)
  const dayRef = useRef(day)
  dayRef.current = day
  const recordsRef = useRef<BathRecord[] | null>(null)
  recordsRef.current = records

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    const tick = () => setClockTick((n) => n + 1)
    const t = window.setInterval(tick, 60_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // App が配り直した職員名簿（F47）。名簿だけを差し替える（下の取得の依存に入れると、名簿が変わるたびに入力解禁を
  // 取り直して画面が「準備しています」に戻っていた）。取り直し（baseTick）では ref の最新を使う
  const staffPropRef = useRef(staffProp)
  staffPropRef.current = staffProp
  useEffect(() => {
    if (staffProp !== undefined) setStaff(staffProp)
  }, [staffProp])

  // 名簿・職員・入力解禁（画面を開くたびに取り直す＝前提情報は毎回実測）
  useEffect(() => {
    let alive = true
    setBaseError(null)
    setGate(null)
    const given = staffPropRef.current
    Promise.all([fetchAllResidents(), given !== undefined ? Promise.resolve(given) : fetchStaff(), getKindInputGate('bath')])
      .then(([rs, st, g]) => {
        if (!alive) return
        setResidents(rs)
        setStaff(staffPropRef.current ?? st)
        setGate(g)
      })
      .catch(() => {
        if (alive) setBaseError(ERR_LOAD)
      })
    // 休業日の設定は読めなくても記録は止めない（既定値のまま）
    getAppSetting('daycare_closed_dates')
      .then((v) => {
        if (alive && v !== null) setClosedDates(v)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [baseTick])

  // 記入者の既定値（名簿と照合できた操作者。できなければ未選択＝記録前に選んでもらう）
  useEffect(() => {
    if (staff === null) return
    setRecorderId((cur) => {
      if (cur !== null && staff.some((s) => s.id === cur && s.active)) return cur
      const fromActor = resolveActor(staff)?.id ?? null
      if (fromActor !== null) return fromActor
      return actorId != null && staff.some((s) => s.id === actorId && s.active) ? actorId : null
    })
  }, [staff, actorId])

  const activeResidents = useMemo(() => (residents ?? []).filter((r) => r.active), [residents])

  // その日の記録と予定（予定は失敗しても記録は出す）
  const loadRecords = useCallback(async (d: string) => {
    const rows = await fetchBathDay(d)
    return rows.filter((r) => r.bath_on === d)
  }, [])

  useEffect(() => {
    if (residents === null) return
    let alive = true
    // 世代を進める＝日付を変える前に投げた読み直しの応答を捨てる（F20）
    const gen = ++genRef.current
    setDayError(null)
    setRecords(null)
    setPlan(null)
    inFlightRef.current += 1
    loadRecords(day)
      .then((rs) => {
        if (alive && acceptDayLoad({ gen, latestGen: genRef.current, day, shownDay: dayRef.current, alive: aliveRef.current })) setRecords(rs)
      })
      .catch((e: unknown) => {
        // 後から投げた読み直しに追い越された時は、そちらの結果に任せる
        if (!alive || gen !== genRef.current) return
        setDayError(e instanceof DbError ? e.message : ERR_LOAD)
      })
      .finally(() => {
        inFlightRef.current -= 1
      })
    fetchBathPlan(day, activeResidents)
      .then((p) => {
        if (alive) setPlan(p)
      })
      .catch(() => {
        if (alive) setPlan('error')
      })
    return () => {
      alive = false
    }
  }, [day, dayTick, residents, activeResidents, loadRecords])

  // 日付を変えたら、その日に紐づく画面の状態（予定外に足した人・備考の書きかけ・一言・日付が変わった時の帯）を持ち越さない
  useEffect(() => {
    setExtras([])
    setNotes(new Map())
    setMsgs(new Map())
    setPending(new Map())
    setRolloverDay(null)
  }, [day])

  /**
   * 記録だけを読み直す（保存の競合・他の端末の変更の後）。世代を付け、最新の世代 かつ 取りに行った日が今の日の時だけ
   * 表へ入れる（F20）
   */
  const reloadRecords = useCallback(() => {
    const d = day
    // 日付を変える前の描画から呼ばれた（保存の応答を待つ間に日付を変えた等）時は何もしない。世代だけ進めると、
    // 新しい日の読み込みの応答を捨て、この読み直しの応答も日付違いで捨てて「読み込み中」のまま残るため
    if (d !== dayRef.current) return
    const gen = ++genRef.current
    inFlightRef.current += 1
    loadRecords(d)
      .then((rs) => {
        if (acceptDayLoad({ gen, latestGen: genRef.current, day: d, shownDay: dayRef.current, alive: aliveRef.current })) setRecords(rs)
      })
      .catch(() => {
        // 読み直せなかっただけ。表示中の記録はそのまま残す（上の「最新を読み込む」で再試行できる）。
        // ただし日付の読み込みをこの読み直しが追い越していた時（まだ何も出ていない）は、「読み込み中」から抜けるようにエラーを出す
        if (aliveRef.current && gen === genRef.current && d === dayRef.current && recordsRef.current === null) setDayError(ERR_LOAD)
      })
      .finally(() => {
        inFlightRef.current -= 1
      })
  }, [day, loadRecords])

  /**
   * 保存・取り消しの前に投げた読み直しがまだ返っていなければ、もう一度読み直す（F20。その古い応答は保存の前の状態なので、
   * 後から返ると自分の記録が消えて見える。読み直し直すと世代が進み、古い応答は捨てられる）
   */
  function supersedeInFlight() {
    if (inFlightRef.current > 0) reloadRecords()
  }

  // 送信待ちの件数の変化を画面に映す（行のロックの判定を取り直す）。減った時は、その日の記録を読み直して
  // 行を記録済みに戻す（自分の書込の Realtime 通知は isSelfWrite で無視するので、ここで読み直す）
  const [queueTick, setQueueTick] = useState(0)
  useEffect(() => {
    let last = -1
    return queueSubscribe((n) => {
      const prev = last
      last = n
      setQueueTick((t) => t + 1)
      if (prev >= 0 && n < prev) reloadRecords()
    })
  }, [reloadRecords])

  // 送信待ちから消えた（送れた・止まった）行の「送信待ちにした入力」の印は外す（表示は読み直した記録に任せる）
  useEffect(() => {
    setPending((prev) => {
      if (prev.size === 0) return prev
      const next = new Map(prev)
      for (const id of prev.keys()) {
        const rec = (records ?? []).find((r) => r.resident_id === id) ?? null
        if (!hasPendingBath(id, day, rec?.id ?? null)) next.delete(id)
      }
      return next.size === prev.size ? prev : next
    })
  }, [queueTick, records, day])

  // 他の端末の記録を取り込む（自分の書込の通知・別の日の通知は無視。行を特定できない通知は取り直す）。
  // つながり直した・画面に戻った・電波が戻った時の取り直しの合図（RESYNC・F14）も行が無いので、ここで読み直す
  useEffect(() => {
    let timer: number | null = null
    const unsub = subscribeBathChanges((table, info) => {
      const row = info?.row ?? null
      if (row !== null && isSelfWrite(table, row)) return
      if (row !== null && typeof row.bath_on === 'string' && row.bath_on !== day) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(reloadRecords, 400)
    })
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsub()
    }
  }, [day, reloadRecords])

  const locked = gate === null || !gate.observed || gate.value !== true
  const gateUnknown = gate !== null && !gate.observed
  /**
   * このアカウントは記録アプリを使えない（許可リストに無い・無効。F61 手直し）。入力は止めたまま（locked）、案内だけを
   * 「通信エラー・再試行」ではなく、ログインし直す・管理者へ連絡する文にする（再試行では直らない）
   */
  const forbidden = gate?.forbidden === true
  const reasonId = `${uid}-locked`

  const residentById = useMemo(() => {
    const m = new Map<number, Resident>()
    for (const r of residents ?? []) m.set(r.id, r)
    return m
  }, [residents])

  const rows: BathDayRow[] = useMemo(
    () =>
      buildBathDayRows(
        plan !== null && plan !== 'error' && plan.available ? plan.entries : [],
        // 表示中の日の記録だけ（古い応答の行を混ぜない二重の歯止め・F20）
        (records ?? []).filter((r) => r.bath_on === day),
        extras,
        (residents ?? []).map((r) => r.id),
      ),
    [plan, records, extras, residents, day],
  )
  // 送れずに止まった記録（F37）。止まっても件数は減らないので、送信待ちの通知のたびと記録を読み直した時に引き直す
  const stoppedAll = useMemo(() => listStoppedOps().filter((op) => op.table === 'bath_records'), [queueTick, records])
  const stoppedByResident = useMemo(() => stoppedBathByResident(stoppedAll, day, records ?? []), [stoppedAll, day, records])
  const counts = countBathDay(rows)
  const staffName = (id: number | null): string | null =>
    id === null ? null : ((staff ?? []).find((s) => s.id === id)?.name ?? null)

  function setRowMsg(id: number, msg: RowMsg | null) {
    setMsgs((prev) => {
      const next = new Map(prev)
      if (msg === null) next.delete(id)
      else next.set(id, msg)
      return next
    })
  }

  function setRowBusy(id: number, on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  /** 行の備考（書きかけがあればそれ、無ければ保存済みの値） */
  function noteOf(row: BathDayRow): string {
    return notes.get(row.residentId) ?? row.record?.note ?? ''
  }

  function applySaved(saved: BathRecord) {
    // 表示中の日の記録だけを表へ足す。まだ何も読めていない時（null）は1件だけの表を作らない（読み込みの結果を待つ）
    if (saved.bath_on === dayRef.current) {
      setRecords((prev) => {
        if (prev === null) return prev
        const list = prev.filter((r) => r.id !== saved.id && r.resident_id !== saved.resident_id)
        return [...list, saved]
      })
    }
    supersedeInFlight()
    setNotes((prev) => {
      const next = new Map(prev)
      next.delete(saved.resident_id)
      return next
    })
    setPending((prev) => {
      const next = new Map(prev)
      next.delete(saved.resident_id)
      return next
    })
  }

  /** 1行の保存（新規は insert、記録済みは rev 照合の update） */
  async function save(row: BathDayRow, result: BathResult, cancelReason: BathCancelReason | null, note: string) {
    const id = row.residentId
    if (locked || busy.has(id) || rowPending(row)) return
    if (row.record !== null && rejectOtherDay(row.record)) return
    if (recorderId === null) {
      setRowMsg(id, { tone: 'warn', text: MSG_NO_RECORDER })
      return
    }
    const input = { bath_on: day, result, cancel_reason: result === 'cancel' ? cancelReason : null, note: note.trim() === '' ? null : note }
    const check = validateBathInput(input, todayIso())
    if (!check.ok) {
      setRowMsg(id, { tone: 'danger', text: check.message })
      return
    }
    setRowBusy(id, true)
    setRowMsg(id, null)
    try {
      const res =
        row.record === null
          ? await insertBath({ resident_id: id, ...input, recorded_by: recorderId })
          : await updateBath(row.record, { result, cancel_reason: input.cancel_reason, note: input.note }, { editedBy: recorderId })
      touchActivity()
      if (!aliveRef.current) return
      if (res === 'conflict') {
        setRowMsg(id, { tone: 'warn', text: MSG_CONFLICT })
        reloadRecords()
        return
      }
      if (res === 'queued') {
        if (!isQueuePersisted()) {
          setRowMsg(id, { tone: 'danger', text: MSG_NOT_PERSISTED })
          return
        }
        setPending((prev) => new Map(prev).set(id, { result, cancel_reason: input.cancel_reason }))
        return
      }
      applySaved(res)
      const name = residentById.get(id)?.name ?? ''
      show(`${name ? `${name}　` : ''}「${BATH_SHOWN_LABEL[bathShownOf(res.result)]}」を記録しました。`)
    } catch (e) {
      if (!aliveRef.current) return
      setRowMsg(id, { tone: 'danger', text: e instanceof DbError ? e.message : MSG_SAVE_FAILED })
    } finally {
      if (aliveRef.current) setRowBusy(id, false)
    }
  }

  function onShown(row: BathDayRow, shown: BathShown) {
    const rec = row.record
    // 同じ表示（入浴した／入浴していない）を押し直した時は、区分を変えない（以前のシャワー浴などを全身浴へ書き換えない）。
    // 備考が変わっていれば備考だけを直す（変わっていなければ何もしない）
    if (rec !== null && bathShownOf(rec.result) === shown) {
      if (noteOf(row) !== (rec.note ?? '')) void save(row, rec.result, keptCancelReason(rec, noteOf(row)), noteOf(row))
      return
    }
    if (shown === 'bathed') void save(row, resultForBathed(day, closedDates), null, noteOf(row))
    else void save(row, 'cancel', null, noteOf(row))
  }

  /**
   * 表示中の日付と違う日の記録なら書かずに読み直す（古い応答が表に残っていた時の、書き込みの側の歯止め・F20）。
   * 書かなかった時は true
   */
  function rejectOtherDay(rec: BathRecord): boolean {
    if (rec.bath_on === dayRef.current) return false
    setRowMsg(rec.resident_id, { tone: 'warn', text: MSG_OTHER_DAY })
    reloadRecords()
    return true
  }

  /** その行に未送信の記録（この端末の送信待ち・送信中、または画面の「送信待ちにした入力」の印）があるか */
  function rowPending(row: BathDayRow): boolean {
    return pending.has(row.residentId) || hasPendingBath(row.residentId, day, row.record?.id ?? null)
  }

  /** 取り消し（確認の後）。記入者の選択は保存と同じく必須（レビュー L3） */
  async function remove(rec: BathRecord) {
    const id = rec.resident_id
    setDeleteFor(null)
    const row = rows.find((r) => r.residentId === id)
    if (locked || busy.has(id) || (row !== undefined && rowPending(row))) return
    if (rejectOtherDay(rec)) return
    if (recorderId === null) {
      setRowMsg(id, { tone: 'warn', text: MSG_NO_RECORDER })
      return
    }
    setRowBusy(id, true)
    setRowMsg(id, null)
    try {
      const res = await softDeleteBath(rec.id, rec.rev, { editedBy: recorderId })
      touchActivity()
      if (!aliveRef.current) return
      if (res === 'conflict') {
        setRowMsg(id, { tone: 'warn', text: MSG_CONFLICT })
        reloadRecords()
        return
      }
      if (res === 'queued') {
        setRowMsg(id, { tone: 'warn', text: isQueuePersisted() ? '取り消しは未送信です（電波が戻ると自動で送信します）' : MSG_NOT_PERSISTED })
        return
      }
      setRecords((prev) => (prev === null ? prev : prev.filter((r) => r.id !== rec.id)))
      supersedeInFlight()
      show('記録を取り消しました。')
    } catch (e) {
      if (!aliveRef.current) return
      setRowMsg(id, { tone: 'danger', text: e instanceof DbError ? e.message : MSG_SAVE_FAILED })
    } finally {
      if (aliveRef.current) setRowBusy(id, false)
    }
  }

  // ── 開いたまま日付が変わった時（F18） ──
  /**
   * 入力中（備考の書きかけ・予定外に足した人・小窓）・保存中・未送信・止まった記録があるか
   * （あれば日付を勝手に切り替えない＝入力の送り先の日をずらさない・書きかけを消さない）
   */
  const holding =
    [...notes.entries()].some(([rid, v]) => v !== (rows.find((r) => r.residentId === rid)?.record?.note ?? '')) ||
    extras.length > 0 ||
    busy.size > 0 ||
    pending.size > 0 ||
    deleteFor !== null ||
    staffPickerOpen ||
    residentPickerOpen ||
    stoppedByResident.size > 0 ||
    rows.some((row) => rowPending(row))
  const prevTodayRef = useRef(today)
  useEffect(() => {
    const prev = prevTodayRef.current
    if (prev === today) return
    prevTodayRef.current = today
    const act = dayRolloverAction({ day, prevToday: prev, today, holding })
    if (act === 'switch') {
      setRolloverDay(null)
      setDay(today)
      setDayMsg(`日付が変わったので、今日（${fmtDayLabel(today)}）の表示に切り替えました。`)
    } else if (act === 'notice') {
      setRolloverDay(day)
    }
    // 判定は今日が変わった時だけ（表示中の日・入力中かは、その時の値を読む）
  }, [today])

  // ── 3状態: エラー → ローディング → 本体 ──
  if (baseError !== null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <ErrorBlock message={baseError} onRetry={() => setBaseTick((n) => n + 1)} />
      </div>
    )
  }
  if (residents === null || staff === null || gate === null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <LoadingBlock label="入浴の記録画面を準備しています…" />
      </div>
    )
  }

  const recorderName = staffName(recorderId)
  const pickable = activeResidents.filter((r) => !rows.some((row) => row.residentId === r.id))
  // 止まった記録のうち、表示中の行に出ない分（ほかの日の記録・表に無い方の記録）
  const stoppedShown = rows.reduce((n, row) => n + (stoppedByResident.get(row.residentId)?.length ?? 0), 0)
  const stoppedElsewhere = stoppedAll.length - stoppedShown

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      {forbidden ? (
        <ErrorBlock message={FORBIDDEN_REASON} />
      ) : gateUnknown ? (
        <ErrorBlock message={ERR_GATE} onRetry={() => setBaseTick((n) => n + 1)} />
      ) : locked ? (
        <div id={reasonId} role="status" className="rounded-lg border border-warn bg-warn-bg p-4">
          <p className="text-base text-ink">
            <span aria-hidden="true">▲ </span>
            <span className="sr-only">お知らせ: </span>
            {kindBlockedMessage('bath')}
          </p>
          <p className="mt-2 text-base text-ink2">予定と記録の閲覧はこのままできます。</p>
        </div>
      ) : null}

      {/* 開いたまま日付が変わり、入力中・未送信があったので切り替えなかった時の帯（F18） */}
      {rolloverDay !== null && rolloverDay === day && day !== today ? (
        <div role="status" className="rounded-lg border border-warn bg-warn-bg p-4">
          <p className="text-base text-ink">
            <span aria-hidden="true">▲ </span>
            日付が変わりました（表示中: {fmtDayLabel(day)}）。入力中・未送信の記録があったので、表示はそのままにしています。今日の記録は「今日を開く」から入れてください。
            {notes.size > 0 ? '（書きかけの備考は、先に「備考を保存」を押してください。今日を開くと消えます）' : ''}
          </p>
          <button
            type="button"
            onClick={() => {
              setDayMsg(null)
              setRolloverDay(null)
              setDay(todayIso())
            }}
            className="mt-2 min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
          >
            今日を開く
          </button>
        </div>
      ) : null}

      <SectionCard title="入浴（デイ）">
        <div className="flex flex-wrap items-end gap-gap">
          <div className="min-w-0">
            <label htmlFor={`${uid}-day`} className="block text-sm text-ink2">
              日付
            </label>
            <input
              id={`${uid}-day`}
              type="date"
              value={day}
              max={today}
              onChange={(e) => {
                const v = e.target.value
                if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return
                if (v > todayIso()) {
                  setDay(todayIso())
                  setDayMsg('未来の日付は選べません。今日にしました。')
                  return
                }
                setDayMsg(null)
                setDay(v)
              }}
              className="tabular mt-1 min-h-tap rounded border border-border bg-surface px-3 text-base text-ink"
            />
          </div>
          {day !== today ? (
            <button
              type="button"
              onClick={() => {
                setDayMsg(null)
                setDay(todayIso())
              }}
              className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink"
            >
              今日へ
            </button>
          ) : null}
          <div className="min-w-0">
            <span className="block text-sm text-ink2">記入者</span>
            <button
              type="button"
              onClick={() => setStaffPickerOpen(true)}
              className="mt-1 flex min-h-tap items-center gap-gap rounded border border-border bg-surface px-3 text-left text-base text-ink"
            >
              <span className={recorderName === null ? 'text-ink3' : 'font-bold'}>
                {recorderName ?? '選んでください'}
              </span>
              <span className="text-sm text-link">変更</span>
            </button>
          </div>
        </div>
        {dayMsg !== null ? (
          <p role="alert" className="mt-2 text-sm text-warn">
            <span aria-hidden="true">▲ </span>
            {dayMsg}
          </p>
        ) : null}

        <p className="mt-3 text-base text-ink" aria-live="polite">
          <span className="font-bold">{fmtDayLabel(day)}</span>
          {'　'}
          予定 <span className="tabular font-bold">{counts.planned}</span>人・記録済み{' '}
          <span className="tabular font-bold">{counts.recorded}</span>・未記録{' '}
          <span className={`tabular font-bold ${counts.unrecorded > 0 ? 'text-warn' : ''}`}>{counts.unrecorded}</span>
        </p>
        <p className="mt-1 text-sm text-ink2">
          <span aria-hidden="true">ⓘ </span>
          {plan === null
            ? '予定を読み込み中です…'
            : plan === 'error' || !plan.available
              ? '予定を取得できません。予定外の追加から記録できます。'
              : `予定は週間計画の写しから${plan.updatedAt ? `（最終更新 ${fmtCopyStamp(plan.updatedAt)}）` : ''}`}
        </p>
        {plan !== null && plan !== 'error' && plan.unmatched > 0 ? (
          <p className="mt-1 text-sm text-warn">
            <span aria-hidden="true">▲ </span>
            週間計画の予定のうち {plan.unmatched}件は、利用者の名簿と突き合わせられませんでした（設定タブのマスタ同期をお試しください）。
          </p>
        ) : null}
        <p className="mt-1 text-sm font-bold text-ink">
          <span aria-hidden="true">ⓘ </span>
          {BATH_AUTO_TIME} に予定者は「入浴した」になります。入浴しなかった方は「入浴していない」を押してください
        </p>
        <p className="mt-1 text-sm">
          <Link to="/bath/month" className="inline-flex min-h-tap items-center text-link">
            月次表を見る<span aria-hidden="true"> ›</span>
          </Link>
        </p>
      </SectionCard>

      {dayError !== null ? (
        <ErrorBlock message={dayError} onRetry={() => setDayTick((n) => n + 1)} />
      ) : records === null ? (
        <LoadingBlock label="この日の入浴の記録を読み込み中です…" />
      ) : (
        <>
          {stoppedElsewhere > 0 ? (
            <p role="status" className="rounded border border-danger bg-danger-bg px-3 py-2 text-sm text-ink">
              <span aria-hidden="true">⚠ </span>
              ほかの日の入浴の記録に、送れずに止まっているものが {stoppedElsewhere}件あります。{MSG_STOPPED_GUIDE}{' '}
              <Link to="/settings" className="inline-flex min-h-tap items-center font-bold text-link">
                設定タブを開く<span aria-hidden="true"> ›</span>
              </Link>
            </p>
          ) : null}
          {rows.length === 0 ? (
            <EmptyBlock message="この日の入浴の予定と記録はありません。予定外の方は下の「予定外の人を追加」から記録できます。" />
          ) : (
            <ul className="space-y-3">
              {rows.map((row) => (
                <BathRow
                  key={row.residentId}
                  row={row}
                  resident={residentById.get(row.residentId) ?? null}
                  note={noteOf(row)}
                  onNote={(v) => setNotes((prev) => new Map(prev).set(row.residentId, v))}
                  onShown={(v) => onShown(row, v)}
                  onSaveNote={() => {
                    if (row.record !== null) void save(row, row.record.result, keptCancelReason(row.record, noteOf(row)), noteOf(row))
                  }}
                  onDelete={() => setDeleteFor(row.record)}
                  locked={locked}
                  rowPending={rowPending(row)}
                  busy={busy.has(row.residentId)}
                  msg={msgs.get(row.residentId) ?? null}
                  pending={pending.get(row.residentId) ?? null}
                  stopped={stoppedByResident.get(row.residentId) ?? []}
                  reasonId={locked && !gateUnknown ? reasonId : undefined}
                />
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-gap">
            <button
              type="button"
              onClick={() => setResidentPickerOpen(true)}
              disabled={pickable.length === 0}
              className="min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
            >
              ＋予定外の人を追加
            </button>
            <button
              type="button"
              onClick={() => setDayTick((n) => n + 1)}
              className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink"
            >
              最新を読み込む
            </button>
          </div>
        </>
      )}

      <StaffPickerModal
        open={staffPickerOpen}
        staff={staff.filter((s) => s.active)}
        onPick={(id) => {
          setRecorderId(id)
          setStaffPickerOpen(false)
          touchActivity()
        }}
        onClose={() => setStaffPickerOpen(false)}
        title="記入者を選ぶ"
      />

      <ResidentPickerModal
        open={residentPickerOpen}
        residents={pickable}
        onPick={(id) => {
          setResidentPickerOpen(false)
          if (id !== null) setExtras((prev) => (prev.includes(id) ? prev : [...prev, id]))
        }}
        onClose={() => setResidentPickerOpen(false)}
      />


      <ConfirmDialog
        open={deleteFor !== null}
        title="この記録を取り消しますか"
        body={
          deleteFor === null
            ? undefined
            : `${residentById.get(deleteFor.resident_id)?.name ?? ''}　${fmtDayLabel(deleteFor.bath_on)}の「${BATH_SHOWN_LABEL[bathShownOf(deleteFor.result)]}」の記録を取り消します。取り消した記録は変更の記録に残ります。`
        }
        confirmLabel="取り消す"
        danger
        onConfirm={() => {
          if (deleteFor !== null) void remove(deleteFor)
        }}
        onCancel={() => setDeleteFor(null)}
      />

      {toast}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 1行（利用者1人）
// ══════════════════════════════════════════════════════════════

interface BathRowProps {
  row: BathDayRow
  resident: Resident | null
  note: string
  onNote: (v: string) => void
  onShown: (v: BathShown) => void
  onSaveNote: () => void
  onDelete: () => void
  locked: boolean
  /** 未送信の記録がある（区分ボタン・取り消しを押せない） */
  rowPending: boolean
  busy: boolean
  msg: RowMsg | null
  pending: LocalPending | null
  /** 送れずに止まっている、この方の記録・取り消し・修正（F37） */
  stopped: StoppedOp[]
  reasonId?: string
}

function BathRow({
  row,
  resident,
  note,
  onNote,
  onShown,
  onSaveNote,
  onDelete,
  locked,
  rowPending,
  busy,
  msg,
  pending,
  stopped,
  reasonId,
}: BathRowProps) {
  const uid = useId()
  const rec = row.record
  // 表示する区分: 送信待ちにした入力（未送信の選択） → 保存済み の順（圏外で直した時も、選んだ区分を見せる）
  const shownResult: BathResult | null = pending?.result ?? rec?.result ?? null
  const shown: BathShown | null = shownResult === null ? null : bathShownOf(shownResult)
  // 入院中の方は予定があっても「未」にしない（入浴できないため・「入院」と出す）
  const unrecorded = pending === null && isUnrecorded(row)
  const noteChanged = rec !== null && note !== (rec.note ?? '')
  // 未送信の記録がある行は区分ボタン・取り消しを押せない（備考の入力は残す）
  const disabled = locked || busy || rowPending
  const name = resident?.name ?? `利用者番号 ${row.residentId}`
  const time =
    row.startTime !== null || row.endTime !== null
      ? `${fmtTimeHM(row.startTime) || '—'}〜${fmtTimeHM(row.endTime) || '—'}`
      : ''

  return (
    <li
      className={`rounded-lg border p-3 ${unrecorded ? 'border-warn bg-surface' : 'border-border bg-surface'}`}
      aria-busy={busy || undefined}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="tabular text-sm text-ink3">{resident?.room ?? '—'}</span>
        <span className="text-lg font-bold text-ink">{name}</span>
        {row.planned ? (
          <span className="tabular text-sm text-ink2">予定 {time || '時刻なし'}</span>
        ) : (
          <span className="rounded-full border border-border px-2 text-sm text-ink2">予定外</span>
        )}
        {row.hospitalized ? (
          <span className="rounded-full border border-border-strong bg-surface2 px-2 text-sm font-bold text-ink">入院</span>
        ) : null}
        {unrecorded ? (
          <span className="rounded-full border border-warn bg-warn-bg px-2 text-sm font-bold text-warn">
            未<span className="sr-only">記録</span>
          </span>
        ) : rec !== null ? (
          <span className="text-sm font-bold text-ok">
            <span aria-hidden="true">✓ </span>記録済み
          </span>
        ) : null}
      </div>

      <div role="group" aria-label={`${name}の入浴`} className="mt-2 grid grid-cols-2 gap-gap">
        {BATH_SHOWN.map((r) => {
          const selected = shown === r
          return (
            <button
              key={r}
              type="button"
              aria-pressed={selected}
              aria-describedby={reasonId}
              disabled={disabled}
              onClick={() => onShown(r)}
              className={
                selected
                  ? 'min-h-tap rounded border-2 border-primary bg-primary px-2 text-base font-bold text-primary-ink disabled:opacity-60'
                  : 'min-h-tap rounded border border-border-strong bg-surface px-2 text-base text-ink disabled:border-border disabled:bg-surface2 disabled:text-ink3'
              }
            >
              {/* ✓ は選んだ時だけ出す（場所取りの見えない ✓ を置くと、文字200%・狭い幅で文字が1字ずつ折り返す） */}
              {selected ? <span aria-hidden="true">✓ </span> : null}
              {BATH_SHOWN_LABEL[r]}
            </button>
          )
        })}
      </div>


      <div className="mt-2 flex flex-wrap items-end gap-gap">
        <div className="min-w-0 flex-1">
          <label htmlFor={`${uid}-note`} className="block text-sm text-ink2">
            備考（任意）
          </label>
          <input
            id={`${uid}-note`}
            type="text"
            value={note}
            onChange={(e) => onNote(e.target.value)}
            disabled={locked}
            autoComplete="off"
            className="mt-1 min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink disabled:bg-surface2 disabled:text-ink3"
          />
        </div>
        {noteChanged ? (
          <button
            type="button"
            onClick={onSaveNote}
            disabled={disabled}
            className="min-h-tap rounded border border-primary bg-surface px-3 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
          >
            備考を保存
          </button>
        ) : null}
        {rec !== null ? (
          <button
            type="button"
            onClick={onDelete}
            disabled={disabled}
            className="min-h-tap rounded border border-danger bg-surface px-3 text-base text-danger disabled:border-border disabled:text-ink3"
          >
            取り消す
          </button>
        ) : null}
      </div>

      {rowPending ? (
        <p role="status" className="mt-2 rounded border border-warn bg-warn-bg px-2 py-1 text-sm font-bold text-warn">
          <span aria-hidden="true">⚠ </span>
          {MSG_ROW_PENDING}
        </p>
      ) : null}
      {stopped.length > 0 ? (
        <div role="status" className="mt-2 rounded border border-danger bg-danger-bg px-2 py-1 text-sm text-ink">
          {stopped.map((op) => (
            <p key={op.qid} className="break-words font-bold text-danger">
              <span aria-hidden="true">⚠ </span>
              {stoppedBathText(op)}
            </p>
          ))}
          <p className="mt-1">{MSG_STOPPED_GUIDE}</p>
          <Link to="/settings" className="inline-flex min-h-tap items-center font-bold text-link">
            設定タブを開く<span aria-hidden="true"> ›</span>
          </Link>
        </div>
      ) : null}
      {busy ? (
        <p role="status" className="mt-2 text-sm text-ink2">
          保存しています…
        </p>
      ) : null}
      {msg !== null ? (
        <p
          role={msg.tone === 'danger' ? 'alert' : 'status'}
          className={`mt-2 text-sm ${msg.tone === 'danger' ? 'text-danger' : msg.tone === 'warn' ? 'text-warn' : 'text-ink2'}`}
        >
          {msg.tone !== 'info' ? <span aria-hidden="true">▲ </span> : null}
          {msg.text}
        </p>
      ) : null}
    </li>
  )
}

export default BathRecordPage
