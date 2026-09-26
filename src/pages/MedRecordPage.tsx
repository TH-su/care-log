// 与薬チェック（記録ハブ →「与薬チェック」／ルート /record/med）。2026-09-26 追加。
//
// 住宅型の服薬介助（一包化された袋を時間帯ごとに渡す）の実施チェック。薬の名前は持たない。
// 表: 行＝在籍の入居者（居室順・階で絞れる）、列＝朝・昼・夕・眠前。その人の服薬の時間帯（med_slots）に無い列は「—」（押せない）。
//   ・空いているマスを1回押すと「服用済み」で記録する（時刻はサーバーの記録時刻 created_at）
//   ・記録済みのマスを押すと状態の小窓（服用済み／一部残し／拒否／不在／医師指示で中止／落薬／誤薬・備考・取り消す）
//   ・落薬・誤薬を保存したら「事故・ヒヤリハットとして記録してください（今は紙の事故報告書へ）」を出す
//   ・締め時刻（med.ts の MED_DEADLINES）を過ぎた今日の未記録と、過去の日の未記録は「未」（赤枠＋文字）。
//     今日の締め前の未記録は空欄。今日を表示している間は 60 秒ごとに締めを判定し直す
//   ・入院中かどうかは care-log の名簿（residents）が持っていないので、入院中の方のマスも通常どおり（「不在」で記録する）
// 下に頓服の区画（その日の頓服の一覧・＋頓服を記録・効果は後から追記）。
// その人・その時間帯に未送信の記録（この端末の送信待ち・送信中）があるマスは押せない（入浴と同じ方式。送信待ちは書き換えない）。
// 頓服の未送信は送信待ち（pendingPrnOps）から組み立てて一覧に出す（再読み込み・日付の切り替えの後も消えない＝二重記録を防ぐ）。
// 「未」と「未記録 N」は、与薬の記録が解禁済み かつ 施設で記録を始めた日（fetchMedFirstDay）以降の日だけ（月次表とそろえる）。
//
// 規律:
// - 取得・保存は db.ts の関数のみ（supabase を直呼びしない）
// - 入力解禁は input_enabled_med（getKindInputGate('med')）。封鎖中は隠さずにディセーブル＋理由文。書込関数の入口でも同じ旗で止まる
// - 修正は rev 照合。他の端末が先に書いていたら（conflict）入力を消さずに読み直しを促す
// - 日付は画面の中だけで持つ（業務データに紐づく状態は保存しない＝原則11の既定）。保存する UI 状態は階（cl_medFloor）だけ
// - 氏名・記録・薬の情報を localStorage（送信待ちを除く）・console に出さない。色だけで意味を伝えない（文字・記号を併記）

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  DbError,
  fetchAllResidents,
  fetchMedDay,
  fetchMedFirstDay,
  fetchMedSlots,
  fetchStaff,
  getKindInputGate,
  hasPendingMed,
  insertMedAdmin,
  isQueuePersisted,
  isSelfWrite,
  kindBlockedMessage,
  pendingPrnOps,
  queueSubscribe,
  softDeleteMedAdmin,
  subscribeMedChanges,
  updateMedAdmin,
} from '../lib/db'
import { resolveActor, touchActivity } from '../lib/actor'
import {
  buildMedDayRows,
  clockInputValue,
  countMedDay,
  fmtClock,
  isIncidentStatus,
  localDateTimeIso,
  medMissingAllowed,
  MED_DEADLINES,
  MED_RECHECK_MS,
  minutesOfDay,
  tapActionOf,
  validateMedAdminInput,
} from '../lib/med'
import type { MedCell, MedDayRow } from '../lib/med'
import type { PendingPrn } from '../lib/db'
import { fmtDayLabel, todayIso } from '../lib/format'
import { LS, MED_SLOT_LABEL, MED_SLOTS, MED_STATUS_LABEL, MED_STATUS_MARK, MED_STATUSES } from '../lib/types'
import type { MedAdmin, MedSlot, MedSlotsSetting, MedStatus, Resident, Staff } from '../lib/types'
import {
  ConfirmDialog,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  ModalShell,
  ResidentPickerModal,
  SectionCard,
  SegmentPicker,
  StaffPickerModal,
  useToast,
} from '../components/ui'

const ERR_LOAD = '与薬の記録を読み込めませんでした。通信状態を確認して、再試行してください。'
const ERR_GATE =
  '与薬の記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。記録の閲覧はこのままできます。'
const MSG_CONFLICT =
  '他の端末が先にこの方のこの時間帯を記録・変更しました。最新の内容に読み直しました。確かめてから、もう一度押してください。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度押してください。'
const MSG_SAVE_FAILED = '保存できませんでした。通信状態を確認して、もう一度押してください。'
const MSG_NO_RECORDER = '記入者が選ばれていません。上の「記入者」で選んでから記録してください。'
const MSG_QUEUED = '未送信です（電波が戻ると自動で送信します）。送信が終わるまで、このマスは押せません。'
const MSG_PRN_QUEUED = '頓服の記録は未送信です（電波が戻ると自動で送信します）。'
const MSG_INCIDENT = '事故・ヒヤリハットとして記録してください（今は紙の事故報告書へ）'
const MSG_NO_SLOTS = '服薬の時間帯が未設定です（その他→服薬の時間帯）'

const FLOOR_ALL = 'all'
const FLOOR_OTHER = 'other'

/** 居室文字列から階を取る（'102'→'1'）。数字が無い・未設定は FLOOR_OTHER（バイタル一覧と同じ判定） */
function floorOf(room: string | null | undefined): string {
  if (!room) return FLOOR_OTHER
  const m = /\d/.exec(room)
  return m ? m[0] : FLOOR_OTHER
}

/** 階の UI 状態だけを読む（既知の形だけ。壊れた値・未知値は null＝既定の「全」へ） */
function readFloor(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const v = localStorage.getItem(LS.medFloor)
    return v !== null && /^([0-9]|other|all)$/.test(v) ? v : null
  } catch {
    return null
  }
}

function writeFloor(v: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS.medFloor, v)
  } catch {
    // 保存できなくても表示は成立する（次に開いた時に既定へ戻るだけ）
  }
}

type Msg = { tone: 'warn' | 'danger' | 'info'; text: string }

/** マスの鍵（利用者ID と時間帯） */
const cellKey = (residentId: number, slot: string): string => `${residentId}|${slot}`


export interface MedRecordPageProps {
  /** App.tsx が持っている職員名簿（未指定ならこの画面が取得する） */
  staff?: Staff[]
  /** App.tsx の操作者（記入者の既定値。resolveActor が名簿と照合する） */
  actorId?: number | null
}

export function MedRecordPage({ staff: staffProp, actorId }: MedRecordPageProps = {}) {
  const [nowMin, setNowMin] = useState(() => minutesOfDay(new Date()))
  const today = todayIso()
  const [day, setDay] = useState(today)
  const [dayMsg, setDayMsg] = useState<string | null>(null)

  const [residents, setResidents] = useState<Resident[] | null>(null)
  const [staff, setStaff] = useState<Staff[] | null>(staffProp ?? null)
  const [gate, setGate] = useState<{ value: boolean; observed: boolean } | null>(null)
  const [baseError, setBaseError] = useState<string | null>(null)
  const [baseTick, setBaseTick] = useState(0)

  const [slots, setSlots] = useState<MedSlotsSetting[] | null>(null)
  const [records, setRecords] = useState<MedAdmin[] | null>(null)
  const [dayError, setDayError] = useState<string | null>(null)
  const [dayTick, setDayTick] = useState(0)

  const [floor, setFloor] = useState<string>(() => readFloor() ?? FLOOR_ALL)
  const [recorderId, setRecorderId] = useState<number | null>(null)
  const [staffPickerOpen, setStaffPickerOpen] = useState(false)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [pendingMarks, setPendingMarks] = useState<Map<string, MedStatus>>(new Map())
  /** 施設で与薬の記録を始めた日（null＝まだ1件も無い・読めていない）。「未」を付け始める日 */
  const [startDay, setStartDay] = useState<string | null>(null)
  const [msg, setMsg] = useState<Msg | null>(null)
  const [statusFor, setStatusFor] = useState<MedAdmin | null>(null)
  const [deleteFor, setDeleteFor] = useState<MedAdmin | null>(null)
  const [incidentOpen, setIncidentOpen] = useState(false)
  const [prnOpen, setPrnOpen] = useState(false)
  const [effectFor, setEffectFor] = useState<MedAdmin | null>(null)
  const { toast, show } = useToast()
  const uid = useId()
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 今日の「未」は締め時刻で決まるので、60 秒ごとに時刻を取り直す（表示し直すだけ。取得はしない）
  useEffect(() => {
    const t = window.setInterval(() => setNowMin(minutesOfDay(new Date())), MED_RECHECK_MS)
    return () => window.clearInterval(t)
  }, [])

  // 名簿・職員・入力解禁（画面を開くたびに取り直す＝前提情報は毎回実測）
  useEffect(() => {
    let alive = true
    setBaseError(null)
    setGate(null)
    Promise.all([
      fetchAllResidents(),
      staffProp !== undefined ? Promise.resolve(staffProp) : fetchStaff(),
      getKindInputGate('med'),
    ])
      .then(([rs, st, g]) => {
        if (!alive) return
        setResidents(rs)
        setStaff(st)
        setGate(g)
      })
      .catch(() => {
        if (alive) setBaseError(ERR_LOAD)
      })
    return () => {
      alive = false
    }
  }, [baseTick, staffProp])

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

  const loadRecords = useCallback(async (d: string) => {
    const rows = await fetchMedDay(d)
    return rows.filter((r) => r.admin_on === d)
  }, [])

  // その日の記録と、在籍の方の服薬の時間帯
  useEffect(() => {
    if (residents === null) return
    let alive = true
    setDayError(null)
    setRecords(null)
    setSlots(null)
    Promise.all([loadRecords(day), fetchMedSlots(activeResidents), fetchMedFirstDay()])
      .then(([rs, ss, first]) => {
        if (!alive) return
        setRecords(rs)
        setSlots(ss)
        setStartDay(first)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setDayError(e instanceof DbError ? e.message : ERR_LOAD)
      })
    return () => {
      alive = false
    }
  }, [day, dayTick, residents, activeResidents, loadRecords])

  // 日付を変えたら、その日に紐づく画面の状態を持ち越さない
  useEffect(() => {
    setPendingMarks(new Map())
    setMsg(null)
  }, [day])

  /** 記録と時間帯を読み直す（保存の競合・他の端末の変更の後）。読めなければ表示中のまま */
  const reloadDay = useCallback(() => {
    Promise.all([loadRecords(day), fetchMedSlots(activeResidents), fetchMedFirstDay()])
      .then(([rs, ss, first]) => {
        if (!aliveRef.current) return
        setRecords(rs)
        setSlots(ss)
        setStartDay(first)
      })
      .catch(() => {
        // 読み直せなかっただけ。表示中の記録はそのまま残す（「最新を読み込む」で再試行できる）
      })
  }, [day, loadRecords, activeResidents])

  // 送信待ちの件数の変化を画面に映す（マスのロックの判定を取り直す）。減った時は読み直して記録済みに戻す
  const [queueTick, setQueueTick] = useState(0)
  useEffect(() => {
    let last = -1
    return queueSubscribe((n) => {
      const prev = last
      last = n
      setQueueTick((t) => t + 1)
      if (prev >= 0 && n < prev) reloadDay()
    })
  }, [reloadDay])

  // 送信待ちから消えたマス・頓服の「送信待ちにした入力」の印は外す（表示は読み直した記録に任せる）
  useEffect(() => {
    setPendingMarks((prev) => {
      if (prev.size === 0) return prev
      const next = new Map(prev)
      for (const key of prev.keys()) {
        const [rid, slot] = key.split('|')
        const rec = (records ?? []).find((r) => r.resident_id === Number(rid) && r.slot === slot) ?? null
        if (!hasPendingMed(Number(rid), day, slot as MedSlot, rec?.id ?? null)) next.delete(key)
      }
      return next.size === prev.size ? prev : next
    })
  }, [queueTick, records, day])

  // 他の端末の記録・時間帯の変更を取り込む（自分の書込の通知・別の日の通知は無視。行を特定できない通知は取り直す）
  useEffect(() => {
    let timer: number | null = null
    const unsub = subscribeMedChanges((table, info) => {
      const row = info?.row ?? null
      if (row !== null && isSelfWrite(table, row)) return
      if (table === 'med_admin' && row !== null && typeof row.admin_on === 'string' && row.admin_on !== day) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(reloadDay, 400)
    })
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsub()
    }
  }, [day, reloadDay])

  const locked = gate === null || !gate.observed || gate.value !== true
  /** 「未」を付けてよいか（解禁済み かつ 記録を始めた日以降。封鎖中・開始前は締めを過ぎても空欄） */
  const missingAllowed = medMissingAllowed(gate !== null && gate.observed && gate.value === true, startDay, day)
  const gateUnknown = gate !== null && !gate.observed
  const reasonId = `${uid}-locked`

  const residentById = useMemo(() => {
    const m = new Map<number, Resident>()
    for (const r of residents ?? []) m.set(r.id, r)
    return m
  }, [residents])

  const slotsByResident = useMemo(() => {
    const m = new Map<number, MedSlot[]>()
    for (const s of slots ?? []) m.set(s.resident_id, s.slots)
    return m
  }, [slots])

  const configuredCount = useMemo(
    () => activeResidents.filter((r) => (slotsByResident.get(r.id) ?? []).length > 0).length,
    [activeResidents, slotsByResident],
  )

  const allRows: MedDayRow[] = useMemo(
    () =>
      buildMedDayRows({
        order: activeResidents.map((r) => r.id),
        slotsByResident,
        records: records ?? [],
        day,
        today,
        nowMin,
        missingAllowed,
      }),
    [activeResidents, slotsByResident, records, day, today, nowMin, missingAllowed],
  )

  const floorOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of activeResidents) set.add(floorOf(r.room))
    const opts = Array.from(set)
      .filter((f) => f !== FLOOR_OTHER)
      .sort()
      .map((f) => ({ value: f, label: `${f}階` }))
    if (set.has(FLOOR_OTHER)) opts.push({ value: FLOOR_OTHER, label: '居室未設定' })
    opts.push({ value: FLOOR_ALL, label: '全' })
    return opts
  }, [activeResidents])

  // 復元した階が今の名簿に無い時だけ「全」へ戻す（名簿を取れるまでは照合しない）
  useEffect(() => {
    if (activeResidents.length === 0) return
    if (floorOptions.some((o) => o.value === floor)) return
    setFloor(FLOOR_ALL)
  }, [floorOptions, floor, activeResidents.length])

  const rows = useMemo(
    () => (floor === FLOOR_ALL ? allRows : allRows.filter((r) => floorOf(residentById.get(r.residentId)?.room) === floor)),
    [allRows, floor, residentById],
  )
  const counts = countMedDay(rows)
  const allCounts = countMedDay(allRows)

  const prnRecords = useMemo(
    () =>
      (records ?? [])
        .filter((r) => r.slot === 'prn')
        .sort((a, b) => ((a.given_at ?? '') < (b.given_at ?? '') ? -1 : (a.given_at ?? '') > (b.given_at ?? '') ? 1 : a.id - b.id)),
    [records],
  )

  const staffName = (id: number | null): string | null =>
    id === null ? null : ((staff ?? []).find((s) => s.id === id)?.name ?? null)

  function setCellBusy(key: string, on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  function applySaved(saved: MedAdmin) {
    // 施設で最初の記録なら、その日から「未」を付け始める（読み直しを待たない）
    setStartDay((cur) => (cur === null || saved.admin_on < cur ? saved.admin_on : cur))
    setRecords((prev) => {
      const list = (prev ?? []).filter(
        (r) => r.id !== saved.id && !(saved.slot !== 'prn' && r.resident_id === saved.resident_id && r.slot === saved.slot),
      )
      return [...list, saved]
    })
    setPendingMarks((prev) => {
      const key = cellKey(saved.resident_id, saved.slot)
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  }

  /** そのマスに未送信の記録（この端末の送信待ち・送信中、または画面の「送信待ちにした入力」の印）があるか */
  function cellPending(residentId: number, slot: MedSlot, cell: MedCell): boolean {
    const recId = cell.kind === 'record' ? cell.record.id : null
    return pendingMarks.has(cellKey(residentId, slot)) || hasPendingMed(residentId, day, slot, recId)
  }

  /** 保存の結果を画面へ（conflict・queued・例外の案内をそろえる）。保存できた行を返す */
  function handleResult<T>(res: T | 'conflict' | 'queued', onQueued?: () => void): T | null {
    if (res === 'conflict') {
      setMsg({ tone: 'warn', text: MSG_CONFLICT })
      reloadDay()
      return null
    }
    if (res === 'queued') {
      if (!isQueuePersisted()) {
        setMsg({ tone: 'danger', text: MSG_NOT_PERSISTED })
        return null
      }
      onQueued?.()
      setMsg({ tone: 'warn', text: MSG_QUEUED })
      return null
    }
    return res
  }

  /** 空いているマスを押した: 「服用済み」で記録する */
  async function recordTaken(residentId: number, slot: MedSlot) {
    const key = cellKey(residentId, slot)
    if (locked || busy.has(key)) return
    if (recorderId === null) {
      setMsg({ tone: 'warn', text: MSG_NO_RECORDER })
      return
    }
    const input = {
      admin_on: day,
      slot,
      status: 'taken' as MedStatus,
      given_at: null,
      prn_drug: null,
      prn_reason: null,
      prn_effect: null,
      note: null,
    }
    const check = validateMedAdminInput(input, todayIso())
    if (!check.ok) {
      setMsg({ tone: 'danger', text: check.message })
      return
    }
    setCellBusy(key, true)
    setMsg(null)
    try {
      const res = await insertMedAdmin({ resident_id: residentId, ...input, recorded_by: recorderId })
      touchActivity()
      if (!aliveRef.current) return
      const saved = handleResult(res, () => setPendingMarks((prev) => new Map(prev).set(key, 'taken')))
      if (saved === null) return
      applySaved(saved)
      const name = residentById.get(residentId)?.name ?? ''
      show(`${name ? `${name}　` : ''}${MED_SLOT_LABEL[slot]}を「服用済み」で記録しました。`)
    } catch (e) {
      if (!aliveRef.current) return
      setMsg({ tone: 'danger', text: e instanceof DbError ? e.message : MSG_SAVE_FAILED })
    } finally {
      if (aliveRef.current) setCellBusy(key, false)
    }
  }

  function onCell(row: MedDayRow, slot: MedSlot) {
    const cell = row.cells[slot]
    const blocked = locked || busy.has(cellKey(row.residentId, slot)) || cellPending(row.residentId, slot, cell)
    const action = tapActionOf(cell, blocked)
    if (action === 'insert') void recordTaken(row.residentId, slot)
    else if (action === 'dialog' && cell.kind === 'record') setStatusFor(cell.record)
  }

  /** 状態の小窓で保存（状態・備考が変わった時だけ送る） */
  async function saveStatus(rec: MedAdmin, status: MedStatus, note: string) {
    setStatusFor(null)
    const key = cellKey(rec.resident_id, rec.slot)
    if (locked || busy.has(key)) return
    if (recorderId === null) {
      setMsg({ tone: 'warn', text: MSG_NO_RECORDER })
      return
    }
    const cleanNote = note.trim() === '' ? null : note
    const patch: { status?: MedStatus; note?: string | null } = {}
    if (status !== rec.status) patch.status = status
    if (cleanNote !== (rec.note ?? null)) patch.note = cleanNote
    if (patch.status === undefined && patch.note === undefined) return
    setCellBusy(key, true)
    setMsg(null)
    try {
      const res = await updateMedAdmin(rec, patch, { editedBy: recorderId })
      touchActivity()
      if (!aliveRef.current) return
      const saved = handleResult(res, () => setPendingMarks((prev) => new Map(prev).set(key, status)))
      // 落薬・誤薬を選んだ時は、送れたか（送信待ちか）に関係なく事故報告の案内を出す
      if (patch.status !== undefined && isIncidentStatus(status) && (saved !== null || (res === 'queued' && isQueuePersisted()))) {
        setIncidentOpen(true)
      }
      if (saved === null) return
      applySaved(saved)
      show(`${MED_SLOT_LABEL[rec.slot]}を「${MED_STATUS_LABEL[saved.status]}」にしました。`)
    } catch (e) {
      if (!aliveRef.current) return
      setMsg({ tone: 'danger', text: e instanceof DbError ? e.message : MSG_SAVE_FAILED })
    } finally {
      if (aliveRef.current) setCellBusy(key, false)
    }
  }

  /** 取り消し（確認の後）。記入者の選択は保存と同じく必須 */
  async function remove(rec: MedAdmin) {
    setDeleteFor(null)
    const key = rec.slot === 'prn' ? `prn:${rec.id}` : cellKey(rec.resident_id, rec.slot)
    if (locked || busy.has(key) || hasPendingMed(rec.resident_id, rec.admin_on, rec.slot, rec.id)) return
    if (recorderId === null) {
      setMsg({ tone: 'warn', text: MSG_NO_RECORDER })
      return
    }
    setCellBusy(key, true)
    setMsg(null)
    try {
      const res = await softDeleteMedAdmin(rec.id, rec.rev, { editedBy: recorderId })
      touchActivity()
      if (!aliveRef.current) return
      if (res === 'conflict') {
        setMsg({ tone: 'warn', text: MSG_CONFLICT })
        reloadDay()
        return
      }
      if (res === 'queued') {
        setMsg({
          tone: 'warn',
          text: isQueuePersisted() ? '取り消しは未送信です（電波が戻ると自動で送信します）' : MSG_NOT_PERSISTED,
        })
        return
      }
      setRecords((prev) => (prev ?? []).filter((r) => r.id !== rec.id))
      show('記録を取り消しました。')
    } catch (e) {
      if (!aliveRef.current) return
      setMsg({ tone: 'danger', text: e instanceof DbError ? e.message : MSG_SAVE_FAILED })
    } finally {
      if (aliveRef.current) setCellBusy(key, false)
    }
  }

  /** 頓服の記録 */
  async function savePrn(p: { residentId: number; hm: string; drug: string; reason: string; note: string }): Promise<string | null> {
    if (locked) return kindBlockedMessage('med')
    if (recorderId === null) return MSG_NO_RECORDER
    const givenAt = localDateTimeIso(day, p.hm)
    const input = {
      admin_on: day,
      slot: 'prn' as const,
      status: 'taken' as MedStatus,
      given_at: givenAt,
      prn_drug: p.drug.trim() === '' ? null : p.drug,
      prn_reason: p.reason.trim() === '' ? null : p.reason,
      prn_effect: null,
      note: p.note.trim() === '' ? null : p.note,
    }
    const check = validateMedAdminInput(input, todayIso())
    if (!check.ok) return check.message
    try {
      const res = await insertMedAdmin({ resident_id: p.residentId, ...input, recorded_by: recorderId })
      touchActivity()
      if (!aliveRef.current) return null
      if (res === 'conflict') {
        // 頓服は自然キーを持たないので通常は起きない。起きた時は読み直して知らせる
        reloadDay()
        return MSG_CONFLICT
      }
      if (res === 'queued') {
        // 端末に残せなかった時は小窓を閉じずに入力を残す
        // 一覧の「未送信」の行は送信待ちから組み立てる（画面の state には持たない）
        if (!isQueuePersisted()) return MSG_NOT_PERSISTED
        setQueueTick((t) => t + 1)
        setMsg({ tone: 'warn', text: MSG_PRN_QUEUED })
        return null
      }
      applySaved(res)
      show('頓服を記録しました。')
      return null
    } catch (e) {
      return e instanceof DbError ? e.message : MSG_SAVE_FAILED
    }
  }

  /** 頓服の効果の追記・修正 */
  async function saveEffect(rec: MedAdmin, effect: string) {
    setEffectFor(null)
    const key = `prn:${rec.id}`
    if (locked || busy.has(key)) return
    if (recorderId === null) {
      setMsg({ tone: 'warn', text: MSG_NO_RECORDER })
      return
    }
    const clean = effect.trim() === '' ? null : effect
    if (clean === (rec.prn_effect ?? null)) return
    setCellBusy(key, true)
    setMsg(null)
    try {
      const res = await updateMedAdmin(rec, { prn_effect: clean }, { editedBy: recorderId })
      touchActivity()
      if (!aliveRef.current) return
      const saved = handleResult(res)
      if (saved === null) return
      applySaved(saved)
      show('頓服の効果を保存しました。')
    } catch (e) {
      if (!aliveRef.current) return
      setMsg({ tone: 'danger', text: e instanceof DbError ? e.message : MSG_SAVE_FAILED })
    } finally {
      if (aliveRef.current) setCellBusy(key, false)
    }
  }

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
        <LoadingBlock label="与薬チェックの画面を準備しています…" />
      </div>
    )
  }

  const recorderName = staffName(recorderId)
  const isToday = day === today
  const statusName = statusFor === null ? '' : (residentById.get(statusFor.resident_id)?.name ?? '')
  const effectName = effectFor === null ? '' : (residentById.get(effectFor.resident_id)?.name ?? '')
  const showTable = slots !== null && (configuredCount > 0 || allCounts.recorded > 0)

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      {gateUnknown ? (
        <ErrorBlock message={ERR_GATE} onRetry={() => setBaseTick((n) => n + 1)} />
      ) : locked ? (
        <div id={reasonId} role="status" className="rounded-lg border border-warn bg-warn-bg p-4">
          <p className="text-base text-ink">
            <span aria-hidden="true">▲ </span>
            <span className="sr-only">お知らせ: </span>
            {kindBlockedMessage('med')}
          </p>
          <p className="mt-2 text-base text-ink2">記録の閲覧はこのままできます。</p>
        </div>
      ) : null}

      <SectionCard title="与薬チェック">
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
          {!isToday ? (
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
              <span className={recorderName === null ? 'text-ink3' : 'font-bold'}>{recorderName ?? '選んでください'}</span>
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

        {floorOptions.length > 1 ? (
          <div className="mt-3">
            <SegmentPicker
              options={floorOptions}
              value={floor}
              onChange={(v) => {
                setFloor(v)
                writeFloor(v)
              }}
              ariaLabel="階を選ぶ"
            />
          </div>
        ) : null}

        <p className="mt-3 text-base text-ink" aria-live="polite">
          <span className="font-bold">{fmtDayLabel(day)}</span>
          {'　'}未記録{' '}
          <span className={`tabular font-bold ${counts.missing > 0 ? 'text-danger' : ''}`}>{counts.missing}</span>
          {'　'}落薬・誤薬{' '}
          <span className={`tabular font-bold ${counts.incident > 0 ? 'text-danger' : ''}`}>{counts.incident}</span>
          {floor !== FLOOR_ALL && (allCounts.missing !== counts.missing || allCounts.incident !== counts.incident) ? (
            <span className="text-sm text-ink2">
              {'　'}（全階では 未記録 {allCounts.missing}・落薬・誤薬 {allCounts.incident}）
            </span>
          ) : null}
        </p>
        <p className="mt-1 text-sm text-ink2">
          <span aria-hidden="true">ⓘ </span>
          空いているマスを押すと「服用済み」で記録します。記録済みのマスを押すと状態を直せます。
          「未」は締め（{MED_SLOTS.map((s) => `${MED_SLOT_LABEL[s]}${MED_DEADLINES[s]}`).join('・')}）を過ぎても記録が無いマスです。
        </p>
        <p className="mt-1 text-sm">
          <Link to="/med/month" className="inline-flex min-h-tap items-center text-link">
            月次表を見る<span aria-hidden="true"> ›</span>
          </Link>
          {'　'}
          <Link to="/med/slots" className="inline-flex min-h-tap items-center text-link">
            服薬の時間帯<span aria-hidden="true"> ›</span>
          </Link>
        </p>
      </SectionCard>

      {msg !== null ? (
        <p
          role={msg.tone === 'danger' ? 'alert' : 'status'}
          className={`rounded border px-3 py-2 text-sm ${
            msg.tone === 'danger' ? 'border-danger bg-danger-bg text-danger' : msg.tone === 'warn' ? 'border-warn bg-warn-bg text-ink' : 'border-border text-ink2'
          }`}
        >
          {msg.tone !== 'info' ? <span aria-hidden="true">▲ </span> : null}
          {msg.text}
        </p>
      ) : null}

      {dayError !== null ? (
        <ErrorBlock message={dayError} onRetry={() => setDayTick((n) => n + 1)} />
      ) : records === null || slots === null ? (
        <LoadingBlock label="この日の与薬の記録を読み込み中です…" />
      ) : (
        <>
          {configuredCount === 0 ? (
            <div className="rounded-lg border border-warn bg-warn-bg p-4" role="status">
              <p className="text-base text-ink">
                <span aria-hidden="true">▲ </span>
                {MSG_NO_SLOTS}
              </p>
              <p className="mt-2 text-sm">
                <Link to="/med/slots" className="inline-flex min-h-tap items-center font-bold text-link">
                  服薬の時間帯を設定する<span aria-hidden="true"> ›</span>
                </Link>
              </p>
            </div>
          ) : null}

          {showTable ? (
            rows.length === 0 ? (
              <EmptyBlock message="この階に在籍の方はいません。上の階の切り替えで「全」を選んでください。" />
            ) : (
              // relative: 表の中の読み上げ用の文字（sr-only）がこの枠の外へ出て、画面全体を横にはみ出させないように
              <div className="relative overflow-x-auto rounded-lg border border-border bg-surface">
                <table className="w-full border-collapse">
                  <caption className="sr-only">
                    与薬の実施（行＝入居者、列＝時間帯。— は服薬の設定なし、未は締めを過ぎても記録なし）
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" className="sticky left-0 z-10 whitespace-nowrap border-b border-border bg-surface2 px-2 py-1 text-left text-sm font-bold text-ink2">
                        居室・氏名
                      </th>
                      {MED_SLOTS.map((s) => (
                        <th key={s} scope="col" className="border-b border-border bg-surface2 px-1 py-1 text-center text-sm font-bold text-ink2">
                          {MED_SLOT_LABEL[s]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const r = residentById.get(row.residentId)
                      const name = r?.name ?? `利用者番号 ${row.residentId}`
                      return (
                        <tr key={row.residentId}>
                          <th scope="row" className="sticky left-0 z-10 border-b border-border bg-surface px-2 py-1 text-left align-middle text-base font-normal text-ink">
                            <span className="tabular block text-sm text-ink3">{r?.room ?? '—'}</span>
                            {/* 文字200%・狭い幅でも氏名を1字ずつ折り返さない（はみ出す分は表の枠の中で横に送る） */}
                            <span className="block whitespace-nowrap font-bold">{name}</span>
                            {r !== undefined && !r.active ? <span className="block text-sm text-ink2">（退居）</span> : null}
                          </th>
                          {MED_SLOTS.map((slot) => (
                            <td key={slot} className="border-b border-border p-1 text-center align-middle">
                              <MedCellButton
                                name={name}
                                slot={slot}
                                cell={row.cells[slot]}
                                pendingStatus={pendingMarks.get(cellKey(row.residentId, slot)) ?? null}
                                pending={cellPending(row.residentId, slot, row.cells[slot])}
                                busy={busy.has(cellKey(row.residentId, slot))}
                                locked={locked}
                                reasonId={locked && !gateUnknown ? reasonId : undefined}
                                onPress={() => onCell(row, slot)}
                              />
                            </td>
                          ))}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          ) : null}

          <PrnSection
            records={prnRecords}
            pending={pendingPrnOps(day)}
            residentById={residentById}
            staffName={staffName}
            locked={locked}
            busy={busy}
            reasonId={locked && !gateUnknown ? reasonId : undefined}
            onAdd={() => setPrnOpen(true)}
            onEffect={(rec) => setEffectFor(rec)}
            onDelete={(rec) => setDeleteFor(rec)}
            isPending={(rec) => hasPendingMed(rec.resident_id, rec.admin_on, 'prn', rec.id)}
          />

          <div className="flex flex-wrap gap-gap">
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

      <StatusDialog
        open={statusFor !== null}
        record={statusFor}
        name={statusName}
        locked={locked}
        onCancel={() => setStatusFor(null)}
        onSave={(status, note) => {
          if (statusFor !== null) void saveStatus(statusFor, status, note)
        }}
        onDelete={() => {
          const rec = statusFor
          setStatusFor(null)
          if (rec !== null) setDeleteFor(rec)
        }}
      />

      <ConfirmDialog
        open={deleteFor !== null}
        title="この記録を取り消しますか"
        body={
          deleteFor === null
            ? undefined
            : `${residentById.get(deleteFor.resident_id)?.name ?? ''}　${fmtDayLabel(deleteFor.admin_on)}の${MED_SLOT_LABEL[deleteFor.slot]}「${MED_STATUS_LABEL[deleteFor.status]}」の記録を取り消します。取り消した記録は変更の記録に残ります。`
        }
        confirmLabel="取り消す"
        danger
        onConfirm={() => {
          if (deleteFor !== null) void remove(deleteFor)
        }}
        onCancel={() => setDeleteFor(null)}
      />

      <IncidentDialog open={incidentOpen} onClose={() => setIncidentOpen(false)} />

      <PrnDialog
        open={prnOpen}
        day={day}
        isToday={isToday}
        residents={activeResidents}
        onCancel={() => setPrnOpen(false)}
        onSave={async (p) => {
          const err = await savePrn(p)
          if (err === null && aliveRef.current) setPrnOpen(false)
          return err
        }}
      />

      <EffectDialog
        open={effectFor !== null}
        name={effectName}
        record={effectFor}
        onCancel={() => setEffectFor(null)}
        onSave={(effect) => {
          if (effectFor !== null) void saveEffect(effectFor, effect)
        }}
      />

      {toast}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 1マス
// ══════════════════════════════════════════════════════════════

interface MedCellButtonProps {
  name: string
  slot: MedSlot
  cell: MedCell
  /** 送信待ちにした入力（未送信の間は選んだ状態を見せる） */
  pendingStatus: MedStatus | null
  /** 未送信の記録がある（押せない） */
  pending: boolean
  busy: boolean
  locked: boolean
  reasonId?: string
  onPress: () => void
}

function MedCellButton({ name, slot, cell, pendingStatus, pending, busy, locked, reasonId, onPress }: MedCellButtonProps) {
  const label = MED_SLOT_LABEL[slot]
  if (cell.kind === 'none' && pendingStatus === null) {
    return (
      <span className="inline-flex min-h-tap min-w-tap items-center justify-center text-base text-ink3">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{`${name} ${label} 服薬の設定なし`}</span>
      </span>
    )
  }
  const status: MedStatus | null = pendingStatus ?? (cell.kind === 'record' ? cell.record.status : null)
  const disabled = locked || busy || pending
  const incident = status !== null && isIncidentStatus(status)
  const missing = status === null && cell.kind === 'missing'
  const time = pendingStatus === null && cell.kind === 'record' ? fmtClock(cell.record.created_at) : ''
  const srText =
    status !== null
      ? `${name} ${label} ${MED_STATUS_LABEL[status]}${time ? ` ${time}` : ''}${pending ? '（未送信）' : ''}`
      : missing
        ? `${name} ${label} 未記録（締めを過ぎています）。押すと服用済みで記録`
        : `${name} ${label} 未記録。押すと服用済みで記録`
  const tone = incident
    ? 'border-2 border-danger bg-danger-bg text-danger font-bold'
    : missing
      ? 'border-2 border-danger bg-surface text-danger font-bold'
      : status === 'taken'
        ? 'border border-ok bg-ok-bg text-ink font-bold'
        : status !== null
          ? 'border border-warn bg-warn-bg text-ink font-bold'
          : 'border border-border-strong bg-surface text-ink'
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-describedby={reasonId}
      aria-busy={busy || undefined}
      className={`inline-flex min-h-tap w-full min-w-tap flex-col items-center justify-center rounded px-1 text-base disabled:opacity-60 ${tone}`}
    >
      <span aria-hidden="true">{status !== null ? MED_STATUS_MARK[status] : missing ? '未' : ''}</span>
      {time ? (
        <span aria-hidden="true" className="tabular text-xs font-normal text-ink2">
          {time}
        </span>
      ) : null}
      {pending ? (
        <span aria-hidden="true" className="text-xs font-normal text-warn">
          未送信
        </span>
      ) : null}
      <span className="sr-only">{srText}</span>
    </button>
  )
}

// ══════════════════════════════════════════════════════════════
// 頓服の区画
// ══════════════════════════════════════════════════════════════

interface PrnSectionProps {
  records: MedAdmin[]
  /** 送信待ちにある、その日の頓服の追加（pendingPrnOps。読むだけ） */
  pending: PendingPrn[]
  residentById: Map<number, Resident>
  staffName: (id: number | null) => string | null
  locked: boolean
  busy: Set<string>
  reasonId?: string
  onAdd: () => void
  onEffect: (rec: MedAdmin) => void
  onDelete: (rec: MedAdmin) => void
  isPending: (rec: MedAdmin) => boolean
}

function PrnSection({ records, pending, residentById, staffName, locked, busy, reasonId, onAdd, onEffect, onDelete, isPending }: PrnSectionProps) {
  return (
    <SectionCard title="頓服">
      {records.length === 0 && pending.length === 0 ? (
        <p className="mt-2 text-base text-ink2">この日の頓服の記録はありません。</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {records.map((rec) => {
            const r = residentById.get(rec.resident_id)
            const rowPending = isPending(rec)
            const disabled = locked || busy.has(`prn:${rec.id}`) || rowPending
            return (
              <li key={rec.id} className="rounded-md border border-border bg-surface p-3">
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-ink">
                  <span className="tabular text-sm text-ink3">{r?.room ?? '—'}</span>
                  <span className="font-bold">{r?.name ?? `利用者番号 ${rec.resident_id}`}</span>
                  <span className="tabular text-sm text-ink2">{fmtClock(rec.given_at) || '—'}</span>
                </p>
                <dl className="mt-1 grid grid-cols-1 gap-y-1 text-sm text-ink">
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-ink2">薬</dt>
                    <dd className="min-w-0 break-words">{rec.prn_drug ?? '—'}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-ink2">理由</dt>
                    <dd className="min-w-0 break-words">{rec.prn_reason ?? '—'}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-ink2">効果</dt>
                    <dd className={`min-w-0 break-words ${rec.prn_effect === null ? 'text-warn' : ''}`}>
                      {rec.prn_effect ?? '未記入'}
                    </dd>
                  </div>
                  {rec.note !== null ? (
                    <div className="flex flex-wrap gap-x-2">
                      <dt className="text-ink2">備考</dt>
                      <dd className="min-w-0 break-words">{rec.note}</dd>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-ink2">記入者</dt>
                    <dd>{staffName(rec.recorded_by) ?? '—'}</dd>
                  </div>
                </dl>
                <div className="mt-2 flex flex-wrap gap-gap">
                  <button
                    type="button"
                    onClick={() => onEffect(rec)}
                    disabled={disabled}
                    aria-describedby={reasonId}
                    className="min-h-tap rounded border border-primary bg-surface px-3 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
                  >
                    {rec.prn_effect === null ? '効果を記録' : '効果を直す'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(rec)}
                    disabled={disabled}
                    aria-describedby={reasonId}
                    className="min-h-tap rounded border border-danger bg-surface px-3 text-base text-danger disabled:border-border disabled:text-ink3"
                  >
                    取り消す
                  </button>
                </div>
                {rowPending ? (
                  <p role="status" className="mt-2 rounded border border-warn bg-warn-bg px-2 py-1 text-sm font-bold text-warn">
                    <span aria-hidden="true">⚠ </span>未送信の変更があります。送信が終わってから直してください
                  </p>
                ) : null}
              </li>
            )
          })}
          {pending.map((p) => {
            const r = residentById.get(p.residentId)
            const blocked = p.state === 'blocked'
            return (
              <li key={p.qid} className={`rounded-md border p-3 ${blocked ? 'border-danger bg-danger-bg' : 'border-warn bg-warn-bg'}`}>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-ink">
                  <span className="tabular text-sm text-ink3">{r?.room ?? '—'}</span>
                  <span className="font-bold">{r?.name ?? `利用者番号 ${p.residentId}`}</span>
                  <span className="tabular text-sm text-ink2">{fmtClock(p.givenAt) || '—'}</span>
                  <span className={`text-sm font-bold ${blocked ? 'text-danger' : 'text-warn'}`}>
                    <span aria-hidden="true">⚠ </span>
                    {blocked ? '止まっている（送信できませんでした）' : p.state === 'sending' ? '送信中' : '未送信'}
                  </span>
                </p>
                <p className="mt-1 break-words text-sm text-ink">
                  薬 {p.drug ?? '—'}　理由 {p.reason ?? '—'}
                  {p.note !== null ? `　備考 ${p.note}` : ''}
                </p>
                <p className="mt-1 text-sm text-ink2">
                  {blocked
                    ? 'この記録は自動では送れません。管理者に連絡してください（同じ頓服を記録し直さないでください）。'
                    : '電波が戻ると自動で送信します。同じ頓服を記録し直さないでください。'}
                </p>
              </li>
            )
          })}
        </ul>
      )}
      <div className="mt-3">
        <button
          type="button"
          onClick={onAdd}
          disabled={locked}
          aria-describedby={reasonId}
          className="min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
        >
          ＋頓服を記録
        </button>
      </div>
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// 状態の小窓
// ══════════════════════════════════════════════════════════════

interface StatusDialogProps {
  open: boolean
  record: MedAdmin | null
  name: string
  locked: boolean
  onCancel: () => void
  onSave: (status: MedStatus, note: string) => void
  onDelete: () => void
}

function StatusDialog({ open, record, name, locked, onCancel, onSave, onDelete }: StatusDialogProps) {
  const [status, setStatus] = useState<MedStatus>('taken')
  const [note, setNote] = useState('')
  const uid = useId()
  const firstRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open || record === null) return
    setStatus(record.status)
    setNote(record.note ?? '')
  }, [open, record])

  const title = record === null ? '状態' : `${MED_SLOT_LABEL[record.slot]}の状態`
  return (
    <ModalShell open={open} label={title} onClose={onCancel} initialFocus={firstRef} narrow>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <h2 className="text-lg font-bold text-ink">{title}</h2>
        {name ? <p className="mt-1 text-sm text-ink2">{name}</p> : null}
        {record !== null && record.created_at !== null ? (
          <p className="mt-1 text-sm text-ink2">記録した時刻 {fmtClock(record.created_at)}</p>
        ) : null}
        <div role="group" aria-label="状態" className="mt-3 grid grid-cols-1 gap-gap">
          {MED_STATUSES.map((s, i) => {
            const selected = status === s
            const incident = isIncidentStatus(s)
            return (
              <button
                key={s}
                ref={i === 0 ? firstRef : undefined}
                type="button"
                aria-pressed={selected}
                onClick={() => setStatus(s)}
                className={
                  selected
                    ? 'min-h-tap rounded border-2 border-primary bg-primary px-3 text-left text-base font-bold text-primary-ink'
                    : `min-h-tap rounded border bg-surface px-3 text-left text-base ${incident ? 'border-danger text-danger' : 'border-border-strong text-ink'}`
                }
              >
                {selected ? <span aria-hidden="true">✓ </span> : null}
                <span aria-hidden="true">{MED_STATUS_MARK[s]}　</span>
                {MED_STATUS_LABEL[s]}
              </button>
            )
          })}
        </div>
        {isIncidentStatus(status) ? (
          <p className="mt-2 text-sm font-bold text-danger">
            <span aria-hidden="true">▲ </span>
            {MSG_INCIDENT}
          </p>
        ) : null}
        <label htmlFor={`${uid}-note`} className="mt-3 block text-sm text-ink2">
          備考（任意）
        </label>
        <textarea
          id={`${uid}-note`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-base text-ink"
        />
      </div>
      <div className="flex flex-wrap justify-end gap-gap border-t border-border p-4">
        <button
          type="button"
          onClick={onDelete}
          disabled={locked}
          className="mr-auto min-h-tap rounded border border-danger px-4 text-base text-danger disabled:border-border disabled:text-ink3"
        >
          取り消す
        </button>
        <button type="button" onClick={onCancel} className="min-h-tap rounded border border-border-strong px-4 text-base text-ink">
          やめる
        </button>
        <button
          type="button"
          onClick={() => onSave(status, note)}
          disabled={locked}
          className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:opacity-60"
        >
          保存する
        </button>
      </div>
    </ModalShell>
  )
}

// ══════════════════════════════════════════════════════════════
// 落薬・誤薬の案内
// ══════════════════════════════════════════════════════════════

function IncidentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const okRef = useRef<HTMLButtonElement>(null)
  return (
    <ModalShell open={open} label="事故・ヒヤリハットの記録" onClose={onClose} initialFocus={okRef} narrow>
      <div className="p-4" role="alert">
        <h2 className="text-lg font-bold text-danger">
          <span aria-hidden="true">▲ </span>落薬・誤薬を記録しました
        </h2>
        <p className="mt-2 text-base text-ink">{MSG_INCIDENT}</p>
      </div>
      <div className="flex justify-end border-t border-border p-4">
        <button
          ref={okRef}
          type="button"
          onClick={onClose}
          className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
        >
          わかりました
        </button>
      </div>
    </ModalShell>
  )
}

// ══════════════════════════════════════════════════════════════
// 頓服の記録（小窓）
// ══════════════════════════════════════════════════════════════

interface PrnDialogProps {
  open: boolean
  day: string
  isToday: boolean
  residents: Resident[]
  onCancel: () => void
  /** 保存する。失敗した時は理由文を返す（小窓は閉じずに入力を残す） */
  onSave: (p: { residentId: number; hm: string; drug: string; reason: string; note: string }) => Promise<string | null>
}

function PrnDialog({ open, day, isToday, residents, onCancel, onSave }: PrnDialogProps) {
  const [residentId, setResidentId] = useState<number | null>(null)
  const [hm, setHm] = useState('')
  const [drug, setDrug] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const uid = useId()
  const firstRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    setResidentId(null)
    // 使用時刻の既定は「今」（今日を表示している時だけ。過去の日は入れてもらう）
    setHm(isToday ? clockInputValue(new Date().toISOString()) : '')
    setDrug('')
    setReason('')
    setNote('')
    setError(null)
    setSaving(false)
  }, [open, isToday])

  const resident = residents.find((r) => r.id === residentId) ?? null

  async function submit() {
    if (residentId === null) {
      setError('入居者を選んでください。')
      return
    }
    setSaving(true)
    const err = await onSave({ residentId, hm, drug, reason, note })
    setSaving(false)
    setError(err)
  }

  return (
    <>
      <ModalShell open={open && !pickerOpen} label="頓服を記録" onClose={onCancel} initialFocus={firstRef}>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <h2 className="text-lg font-bold text-ink">頓服を記録</h2>
          <p className="mt-1 text-sm text-ink2">{fmtDayLabel(day)}</p>
          <span className="mt-3 block text-sm text-ink2">入居者（必須）</span>
          <button
            ref={firstRef}
            type="button"
            onClick={() => setPickerOpen(true)}
            className="mt-1 flex min-h-tap w-full items-center gap-gap rounded border border-border bg-surface px-3 text-left text-base text-ink"
          >
            <span className={resident === null ? 'text-ink3' : 'font-bold'}>
              {resident === null ? '選んでください' : `${resident.room ?? '—'}　${resident.name}`}
            </span>
            <span className="ml-auto text-sm text-link">選ぶ</span>
          </button>
          <label htmlFor={`${uid}-time`} className="mt-3 block text-sm text-ink2">
            使用時刻（必須）
          </label>
          <input
            id={`${uid}-time`}
            type="time"
            value={hm}
            onChange={(e) => setHm(e.target.value)}
            className="tabular mt-1 min-h-tap rounded border border-border bg-surface px-3 text-base text-ink"
          />
          <label htmlFor={`${uid}-drug`} className="mt-3 block text-sm text-ink2">
            薬（必須）
          </label>
          <input
            id={`${uid}-drug`}
            type="text"
            value={drug}
            onChange={(e) => setDrug(e.target.value)}
            autoComplete="off"
            className="mt-1 min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink"
          />
          <label htmlFor={`${uid}-reason`} className="mt-3 block text-sm text-ink2">
            理由（必須）
          </label>
          <input
            id={`${uid}-reason`}
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoComplete="off"
            className="mt-1 min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink"
          />
          <label htmlFor={`${uid}-note`} className="mt-3 block text-sm text-ink2">
            備考（任意）
          </label>
          <input
            id={`${uid}-note`}
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoComplete="off"
            className="mt-1 min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink"
          />
          <p className="mt-2 text-sm text-ink2">効果は、あとから一覧の「効果を記録」で追記できます。</p>
          {error !== null ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              <span aria-hidden="true">▲ </span>
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-gap border-t border-border p-4">
          <button type="button" onClick={onCancel} className="min-h-tap rounded border border-border-strong px-4 text-base text-ink">
            やめる
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving}
            className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:opacity-60"
          >
            {saving ? '保存しています…' : '記録する'}
          </button>
        </div>
      </ModalShell>
      <ResidentPickerModal
        open={open && pickerOpen}
        residents={residents}
        onPick={(id) => {
          setPickerOpen(false)
          if (id !== null) setResidentId(id)
        }}
        onClose={() => setPickerOpen(false)}
      />
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// 頓服の効果（小窓）
// ══════════════════════════════════════════════════════════════

interface EffectDialogProps {
  open: boolean
  name: string
  record: MedAdmin | null
  onCancel: () => void
  onSave: (effect: string) => void
}

function EffectDialog({ open, name, record, onCancel, onSave }: EffectDialogProps) {
  const [effect, setEffect] = useState('')
  const uid = useId()
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open || record === null) return
    setEffect(record.prn_effect ?? '')
  }, [open, record])

  return (
    <ModalShell open={open} label="頓服の効果" onClose={onCancel} initialFocus={fieldRef} narrow>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <h2 className="text-lg font-bold text-ink">頓服の効果</h2>
        {name ? <p className="mt-1 text-sm text-ink2">{name}</p> : null}
        {record !== null ? (
          <p className="mt-1 break-words text-sm text-ink2">
            {fmtClock(record.given_at)}　{record.prn_drug ?? ''}
          </p>
        ) : null}
        <label htmlFor={`${uid}-effect`} className="mt-3 block text-sm text-ink2">
          効果
        </label>
        <textarea
          id={`${uid}-effect`}
          ref={fieldRef}
          value={effect}
          onChange={(e) => setEffect(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-base text-ink"
        />
      </div>
      <div className="flex flex-wrap justify-end gap-gap border-t border-border p-4">
        <button type="button" onClick={onCancel} className="min-h-tap rounded border border-border-strong px-4 text-base text-ink">
          やめる
        </button>
        <button
          type="button"
          onClick={() => onSave(effect)}
          className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
        >
          保存する
        </button>
      </div>
    </ModalShell>
  )
}

export default MedRecordPage
