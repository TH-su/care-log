// 与薬チェック（記録ハブ →「与薬チェック」／ルート /record/med）。2026-09-26 追加。
//
// 住宅型の服薬介助（一包化された袋を時間帯ごとに渡す）の実施チェック。薬の名前は持たない。
// 表: 行＝在籍の入居者（居室順・階で絞れる）、列＝朝・昼・夕・眠前。その人の服薬の時間帯（med_slots）に無い列は「—」（押せない）。
//   ・空いているマスを1回押すと「服用済み」で記録する（時刻はサーバーの記録時刻 created_at）
//     ただし「未」のマスは即記録せず、状態の小窓を開いて選んでから記録する（外泊・入院などで自動にしなかった可能性があるため・チーフ承認）
//   ・記録済みのマスを押すと状態の小窓（服用済み／一部残し／拒否／不在／医師指示で中止／落薬／誤薬・備考・取り消す）
//   ・落薬・誤薬を保存したら「事故・ヒヤリハットを記録する」ボタンの小窓を出す（2026-09-26 事故・ヒヤリハットの追加で紙の案内から変更）。
//     押すと /incident/new?resident=ID&date=YYYY-MM-DD&type=med_error を開く（対象者・日付・種別「誤薬、与薬もれ等」を渡す。
//     区分は未選択のまま。URL に氏名は載せない＝利用者 id・日付・種別のキーだけ）。
//     事故・ヒヤリハットの入力（input_enabled_incident）が封鎖中・確かめられない時は、ボタンの代わりに
//     「事故報告書（紙）に記録してください」を出す（2026-09-26 チーフ裁定 M2）
//   ・締め時刻（med.ts の MED_DEADLINES）を過ぎた今日の未記録と、過去の日の未記録は「未」（赤枠＋文字）。
//     今日の締め前の未記録は空欄。今日を表示している間は 60 秒ごとに締めを判定し直す
//   ・朝・昼・夕・眠前は自動の時刻（med.ts の MED_AUTO_TIMES＝8:50・13:00・18:20・21:00）に DB 側（0015・0016 の cron）が「服用済み」で記録する
//     （2026-09-27 代表指示）。自動の記録も手で記録した「済」と同じ見た目で出す（「（自動）」は出さない・2026-10-01 代表指示）。
//     押すと状態の小窓で直せ、直すと手動の記録（記入者つき）になる。
//     自動の時間帯は、自動の時刻から15分過ぎても記録が無ければ「未」（入院・外泊などで自動にしなかった人・cron の失敗を
//     見落とさない・チーフ指摘1）。眠前も 0016 で自動（21:00・「未」は 21:15 以降）。自動の記録は端末では作らない（この画面は表示と直すだけ）
//   ・入院中かどうかは care-log の名簿（residents）が持っていないので、入院中の方のマスも通常どおり（「不在」で記録する）
// 下に頓服の区画（その日の頓服の一覧・＋頓服を記録・効果は後から追記）。
// その人・その時間帯に未送信の記録（この端末の送信待ち・送信中）があるマスは押せない（入浴と同じ方式。送信待ちは書き換えない）。
// 頓服の未送信は送信待ち（pendingPrnOps）から組み立てて一覧に出す（再読み込み・日付の切り替えの後も消えない＝二重記録を防ぐ）。
// 「未」と「未記録 N」は、与薬の記録が解禁済み かつ 施設で記録を始めた日（fetchMedFirstDay）以降の日だけ（月次表とそろえる）。
// 多端末の運用（2026-10-10 監査の修正）:
//   ・開いたまま日付が変わったら、今日を見ていて 入力中（小窓）・保存中・未送信・止まった記録が無ければ今日へ切り替える。
//     あれば切り替えずに「日付が変わりました〔今日を開く〕」の帯を出す（F18。手で過去の日を選んでいる時は追従しない）
//   ・読み込み・読み直しには世代を付け、最新の世代 かつ 今の日付の応答だけを表へ入れる（F20。日付を変えた直後に前の日の
//     応答で上書きしない・保存の後に保存前の読み直しで自分の記録を消さない）
//   ・頓服の小窓は開いた時だけ初期化する（F32。開いたまま0時を越えても入力を消さない）。記録する前に、その方のその日の頓服
//     （時刻・薬・記入者・この端末の未送信）をサーバーから取り直して出し、同じ薬が既にあれば確かめる（F55・保存は止めない）。
//     表示中の日が今日でなく、使用時刻が12時間以上前になる時は「今日の記録にする」を選べる確認を出す（F33）
//   ・送れずに止まった記録（他の端末が先に記録した・受け付けられなかった）は表の上に中身を出し、設定タブへ案内する（F37）
//   ・App が配り直した職員名簿は名簿だけを差し替える（F47。名簿のたびに入力解禁を取り直して画面を「準備中」に戻さない）。
//     記入者の名前は退職者も含む名簿で引く
//
// 規律:
// - 取得・保存は db.ts の関数のみ（supabase を直呼びしない）
// - 入力解禁は input_enabled_med（getKindInputGate('med')）。封鎖中は隠さずにディセーブル＋理由文。書込関数の入口でも同じ旗で止まる
// - 修正は rev 照合。他の端末が先に書いていたら（conflict）入力を消さずに読み直しを促す
// - 日付は画面の中だけで持つ（業務データに紐づく状態は保存しない＝原則11の既定）。保存する UI 状態は階（cl_medFloor）だけ
// - 氏名・記録・薬の情報を localStorage（送信待ちを除く）・console に出さない。色だけで意味を伝えない（文字・記号を併記）

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  FORBIDDEN_REASON,
  DbError,
  fetchAllResidents,
  fetchAllStaff,
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
  listStoppedOps,
  pendingPrnOps,
  queueSubscribe,
  softDeleteMedAdmin,
  subscribeMedChanges,
  updateMedAdmin,
} from '../lib/db'
import type { StoppedOp } from '../lib/db'
import { resolveActor, touchActivity } from '../lib/actor'
import {
  buildMedDayRows,
  clockInputValue,
  countMedDay,
  fmtClock,
  fmtMedAutoTimes,
  isIncidentStatus,
  localDateTimeIso,
  medMissingAllowed,
  MED_AUTO_GRACE_MIN,
  MED_AUTO_SLOTS,
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
const MSG_INCIDENT = '事故・ヒヤリハットとして記録してください（保存の後に案内が出ます）'
/** 保存した後の小窓の文（事故・ヒヤリハットの入力が解禁中＝ボタンで記録の画面へ進む） */
const MSG_INCIDENT_AFTER = '事故・ヒヤリハットとして記録してください。下のボタンで記録の画面を開きます（対象者・日付・種別を入れて開きます）。'
/** 保存した後の小窓の文（事故・ヒヤリハットの入力が封鎖中・確かめられない＝紙へ） */
const MSG_INCIDENT_PAPER = '事故報告書（紙）に記録してください'
const MSG_NO_SLOTS = '服薬の時間帯が未設定です（その他→服薬の時間帯）'
/** 表示中の日付と違う日の記録を直そうとした（古い読み直しが残っていた時の歯止め・F20） */
const MSG_OTHER_DAY = '表示中の日付と違う日の記録でした。読み直したので、確かめてからもう一度押してください。'
/** 送れずに止まった記録の案内（F37。どうするかは設定タブの「未送信データ」で選ぶ） */
const MSG_STOPPED_GUIDE =
  '自動では送りません。設定タブの「未送信データ」で、いまの記録とくらべてどうするか選んでください（同じ記録を押し直す前に確かめてください）。'

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

// ── 多端末の運用の判定（純関数・tests/medbath-multidevice.test.mjs が確かめる） ──

/**
 * 開いたまま日付が変わった時の動き（F18・2026-10-10 本人回答）。今日を見ていた（day＝変わる前の今日）時だけ追従する。
 * 入力中・保存中・未送信・止まった記録がある（holding）なら切り替えずに帯で知らせる（入力の送り先の日をずらさない）。
 * 手で過去の日を選んでいた時は何もしない（〔今日へ〕がある）
 */
export function dayRolloverAction(p: { day: string; prevToday: string; today: string; holding: boolean }): 'none' | 'switch' | 'notice' {
  if (p.today === p.prevToday || p.day !== p.prevToday) return 'none'
  return p.holding ? 'notice' : 'switch'
}

/**
 * 読み込み・読み直しの応答を表へ入れてよいか（F20）。最新の世代 かつ 取りに行った日が今の日 かつ 画面が出ている時だけ。
 * 日付を変えた直後に前の日の応答が後から返る・同じ日の読み直しが2回走って古い方が後から返る、を捨てる
 */
export function acceptDayLoad(p: { gen: number; latestGen: number; day: string; shownDay: string; alive: boolean }): boolean {
  return p.alive && p.gen === p.latestGen && p.day === p.shownDay
}

/** 頓服の小窓に出す、その方のその日の頓服の1件（サーバーの記録とこの端末の未送信。F55） */
export interface PrnSameDayItem {
  key: string
  givenAt: string | null
  drug: string | null
  /** 記入者の名前（未送信・分からない時は null） */
  recorder: string | null
  /** この端末の送信待ち（まだサーバーに無い） */
  unsent: boolean
}

/** その方・その日の頓服（記録＋この端末の未送信）を使用時刻の順に並べる（F55） */
export function prnSameDayItems(
  records: readonly MedAdmin[],
  pending: readonly PendingPrn[],
  residentId: number,
  day: string,
  nameOf: (id: number | null) => string | null,
): PrnSameDayItem[] {
  const out: PrnSameDayItem[] = []
  for (const r of records) {
    if (r.slot !== 'prn' || r.resident_id !== residentId || r.admin_on !== day) continue
    out.push({ key: `r${r.id}`, givenAt: r.given_at, drug: r.prn_drug, recorder: nameOf(r.recorded_by), unsent: false })
  }
  for (const p of pending) {
    if (p.residentId !== residentId) continue
    out.push({ key: p.qid, givenAt: p.givenAt, drug: p.drug, recorder: null, unsent: true })
  }
  return out.sort((a, b) => ((a.givenAt ?? '') < (b.givenAt ?? '') ? -1 : (a.givenAt ?? '') > (b.givenAt ?? '') ? 1 : 0))
}

/** 薬の名前の比べ方（自由記述なので、全角・半角と空白・大文字小文字だけをそろえる。F55） */
export function prnDrugKey(s: string | null): string {
  return (s ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

/** 表示中の日が今日でない時、使用時刻がこの時間以上前なら確かめる（F33。前日23時台の正当な記録は止めない） */
export const PRN_STALE_HOURS = 12

/**
 * 頓服を記録する前の確かめ（F33・F55）。どちらも保存は止めず、確認を出すだけ。
 *   staleDay … 記録する日が今日でなく、使用時刻が PRN_STALE_HOURS 時間以上前（開いたまま0時を越えた画面で、今朝の頓服が
 *              前日の同じ時刻＝24時間前として保存されるのを見落とさない）
 *   sameDrug … その日に同じ薬の頓服が既にある（他の端末・持ち替えでの二重の記録に気づく）。取り直せなかった時（null）は空
 */
export function prnCheck(p: {
  adminOn: string
  today: string
  givenAt: string | null
  nowMs: number
  drug: string
  sameDay: readonly PrnSameDayItem[] | null
}): { staleDay: boolean; hoursBefore: number; sameDrug: PrnSameDayItem[] } {
  const t = p.givenAt === null ? Number.NaN : Date.parse(p.givenAt)
  const hoursBefore = Number.isFinite(t) ? Math.floor((p.nowMs - t) / 3_600_000) : 0
  const staleDay = p.adminOn !== p.today && Number.isFinite(t) && p.nowMs - t >= PRN_STALE_HOURS * 3_600_000
  const key = prnDrugKey(p.drug)
  const sameDrug = key === '' || p.sameDay === null ? [] : p.sameDay.filter((x) => prnDrugKey(x.drug) === key)
  return { staleDay, hoursBefore, sameDrug }
}

/**
 * 送れずに止まった与薬の記録のうち、表示中の日に当たるもの（F37）。時間帯の追加は admin_on で、修正・取り消しは
 * 表示中の日の記録の id で当てる。頓服の追加は頓服の区画（pendingPrnOps）に出るので除く
 */
export function stoppedMedFor(ops: readonly StoppedOp[], day: string, records: readonly MedAdmin[]): StoppedOp[] {
  const ids = new Set(records.filter((r) => r.admin_on === day).map((r) => r.id))
  return ops.filter((op) => {
    if (op.table !== 'med_admin') return false
    if (op.kind === 'insert') return op.payload.admin_on === day && op.payload.slot !== 'prn'
    return op.kind === 'update' && op.rowId !== null && ids.has(op.rowId)
  })
}

/** 止まった与薬の記録の中身と、止まった理由の1行（F37。拒否などの観察を取り下げる前に必ず見せる） */
export function stoppedMedText(op: StoppedOp, rec: MedAdmin | null, residentName: string): string {
  const p = op.payload
  const slotRaw = op.kind === 'insert' ? p.slot : rec?.slot
  const slot = typeof slotRaw === 'string' && slotRaw in MED_SLOT_LABEL ? MED_SLOT_LABEL[slotRaw as MedSlot] : slotRaw === 'prn' ? '頓服' : ''
  const statusOf = (v: unknown): string | null =>
    typeof v === 'string' && v in MED_STATUS_LABEL ? `「${MED_STATUS_LABEL[v as MedStatus]}」` : null
  const note = typeof p.note === 'string' && p.note.trim() !== '' ? `（備考: ${p.note}）` : ''
  const head = `${residentName ? `${residentName}　` : ''}${slot}`
  let what: string
  if (op.kind === 'insert') what = `${head}${statusOf(p.status) ?? ''}${note}の記録`
  else if ('deleted_at' in p) what = `${head}の記録の取り消し`
  else if (statusOf(p.status) !== null) what = `${head}を${statusOf(p.status)}${note}にする修正`
  else if ('prn_effect' in p) what = `${head}の効果の記録`
  else what = `${head}の修正${note}`
  const why =
    op.state === 'rejected'
      ? 'サーバーに受け付けられませんでした'
      : op.kind === 'insert'
        ? '他の端末が先にこのマスを記録しました'
        : '他の端末が先にこの記録を変更しました'
  return `${what} — ${why}`
}


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

  /** 開いたまま日付が変わり、入力中・未送信があったので切り替えなかった時の、その時の表示日（帯を出す・F18） */
  const [rolloverDay, setRolloverDay] = useState<string | null>(null)

  const [residents, setResidents] = useState<Resident[] | null>(null)
  const [staff, setStaff] = useState<Staff[] | null>(staffProp ?? null)
  /** 記入者の名前を引く名簿（退職者も含む・F47。読めなければ null＝在籍の名簿で引く） */
  const [allStaff, setAllStaff] = useState<Staff[] | null>(null)
  const [gate, setGate] = useState<{ value: boolean; observed: boolean; forbidden?: true } | null>(null)
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
  /** 「未」のマスを押した時の新しい記録の小窓（利用者 id と時間帯。氏名は持たない） */
  const [newFor, setNewFor] = useState<{ residentId: number; slot: MedSlot } | null>(null)
  const [deleteFor, setDeleteFor] = useState<MedAdmin | null>(null)
  /** 落薬・誤薬を保存した後の小窓（事故・ヒヤリハットの記録へ渡す利用者 id と日付。氏名は持たない） */
  const [incidentFor, setIncidentFor] = useState<{ residentId: number; day: string } | null>(null)
  /** 事故・ヒヤリハットの入力が解禁中か（input_enabled_incident。取得中・確かめられない時は false＝紙の案内） */
  const [incidentEnabled, setIncidentEnabled] = useState(false)
  const navigate = useNavigate()
  const [prnOpen, setPrnOpen] = useState(false)
  const [effectFor, setEffectFor] = useState<MedAdmin | null>(null)
  const { toast, show } = useToast()
  const uid = useId()
  const aliveRef = useRef(true)
  // 読み込み・読み直しの世代と、表示中の日・記録の控え（F20。応答が返った時に「今も同じ日・最新の取得か」を確かめる）
  const genRef = useRef(0)
  const inFlightRef = useRef(0)
  const dayRef = useRef(day)
  dayRef.current = day
  const recordsRef = useRef<MedAdmin[] | null>(null)
  recordsRef.current = records

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 今日の「未」は締め時刻で決まるので、60 秒ごとに時刻を取り直す（表示し直すだけ。取得はしない）。
  // 画面に戻った時もすぐ取り直す（ロック中は時計が止まり、0時を越えても次の60秒まで前日のままだった・F18）
  useEffect(() => {
    const tick = () => setNowMin(minutesOfDay(new Date()))
    const t = window.setInterval(tick, MED_RECHECK_MS)
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
  // 取り直して画面が「準備しています」に戻り、開いている頓服の小窓の入力まで消えた）。取り直し（baseTick）では ref の最新を使う
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
    Promise.all([fetchAllResidents(), given !== undefined ? Promise.resolve(given) : fetchStaff(), getKindInputGate('med')])
      .then(([rs, st, g]) => {
        if (!alive) return
        setResidents(rs)
        setStaff(staffPropRef.current ?? st)
        setGate(g)
      })
      .catch(() => {
        if (alive) setBaseError(ERR_LOAD)
      })
    // 記入者の名前を引く名簿（退職者も含む）。読めなくても画面は止めない（在籍の名簿で引く）
    fetchAllStaff()
      .then((all) => {
        if (alive) setAllStaff(all)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [baseTick])

  // 事故・ヒヤリハットの入力の旗（落薬・誤薬の後の案内をボタンにするか紙にするか）。画面を開くたびに取り直す。
  // 取れなくても与薬チェックは妨げない（案内が紙になるだけ）
  useEffect(() => {
    let alive = true
    getKindInputGate('incident')
      .then((g) => {
        if (alive) setIncidentEnabled(g.observed && g.value === true)
      })
      .catch(() => {
        if (alive) setIncidentEnabled(false)
      })
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

  const loadRecords = useCallback(async (d: string) => {
    const rows = await fetchMedDay(d)
    return rows.filter((r) => r.admin_on === d)
  }, [])

  // その日の記録と、在籍の方の服薬の時間帯
  useEffect(() => {
    if (residents === null) return
    let alive = true
    // 世代を進める＝日付を変える前に投げた読み直しの応答を捨てる（F20）
    const gen = ++genRef.current
    setDayError(null)
    setRecords(null)
    setSlots(null)
    inFlightRef.current += 1
    Promise.all([loadRecords(day), fetchMedSlots(activeResidents), fetchMedFirstDay()])
      .then(([rs, ss, first]) => {
        if (!alive || !acceptDayLoad({ gen, latestGen: genRef.current, day, shownDay: dayRef.current, alive: aliveRef.current })) return
        setRecords(rs)
        setSlots(ss)
        setStartDay(first)
      })
      .catch((e: unknown) => {
        // 後から投げた読み直しに追い越された時は、そちらの結果に任せる（読み直しが失敗したら、そちらがエラーを出す）
        if (!alive || gen !== genRef.current) return
        setDayError(e instanceof DbError ? e.message : ERR_LOAD)
      })
      .finally(() => {
        inFlightRef.current -= 1
      })
    return () => {
      alive = false
    }
  }, [day, dayTick, residents, activeResidents, loadRecords])

  // 日付を変えたら、その日に紐づく画面の状態を持ち越さない（日付が変わった時の帯も外す）
  useEffect(() => {
    setPendingMarks(new Map())
    setMsg(null)
    setRolloverDay(null)
  }, [day])

  /**
   * 記録と時間帯を読み直す（保存の競合・他の端末の変更の後）。読めなければ表示中のまま。
   * 世代を付け、最新の世代 かつ 取りに行った日が今の日の時だけ表へ入れる（F20）。結果: true＝表へ入れた
   */
  const reloadDay = useCallback((): Promise<boolean> => {
    const d = day
    // 日付を変える前の描画から呼ばれた（保存の応答を待つ間に日付を変えた等）時は何もしない。世代だけ進めると、
    // 新しい日の読み込みの応答を捨て、この読み直しの応答も日付違いで捨てて「読み込み中」のまま残るため
    if (d !== dayRef.current) return Promise.resolve(false)
    const gen = ++genRef.current
    inFlightRef.current += 1
    return Promise.all([loadRecords(d), fetchMedSlots(activeResidents), fetchMedFirstDay()])
      .then(([rs, ss, first]) => {
        if (!acceptDayLoad({ gen, latestGen: genRef.current, day: d, shownDay: dayRef.current, alive: aliveRef.current })) return false
        setRecords(rs)
        setSlots(ss)
        setStartDay(first)
        return true
      })
      .catch(() => {
        // 読み直せなかっただけ。表示中の記録はそのまま残す（「最新を読み込む」で再試行できる）。
        // ただし日付の読み込みをこの読み直しが追い越していた時（まだ何も出ていない）は、「読み込み中」から抜けるようにエラーを出す
        if (aliveRef.current && gen === genRef.current && d === dayRef.current && recordsRef.current === null) setDayError(ERR_LOAD)
        return false
      })
      .finally(() => {
        inFlightRef.current -= 1
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

  // 他の端末の記録・時間帯の変更を取り込む（自分の書込の通知・別の日の通知は無視。行を特定できない通知は取り直す）。
  // つながり直した・画面に戻った・電波が戻った時の取り直しの合図（RESYNC・F14）も行が無いので、ここで読み直す
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
        // 表示中の日の頓服だけ（古い応答・別の日へ記録した行を混ぜない二重の歯止め・F20）
        .filter((r) => r.slot === 'prn' && r.admin_on === day)
        .sort((a, b) => ((a.given_at ?? '') < (b.given_at ?? '') ? -1 : (a.given_at ?? '') > (b.given_at ?? '') ? 1 : a.id - b.id)),
    [records, day],
  )

  // 送れずに止まった記録（F37）。止まっても件数は減らないので、送信待ちの通知のたびと記録を読み直した時に引き直す
  const stoppedAll = useMemo(() => listStoppedOps().filter((op) => op.table === 'med_admin'), [queueTick, records])
  const stoppedHere = useMemo(() => stoppedMedFor(stoppedAll, day, records ?? []), [stoppedAll, day, records])

  /** 記入者の名前（在籍の名簿 → 退職者も含む名簿の順に引く・F47） */
  const staffName = (id: number | null): string | null =>
    id === null ? null : ((staff ?? []).find((s) => s.id === id)?.name ?? (allStaff ?? []).find((s) => s.id === id)?.name ?? null)
  const staffNameRef = useRef(staffName)
  staffNameRef.current = staffName

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
    // 表示中の日の記録だけを表へ足す（別の日へ記録した頓服は、その日を開いた時に読む）。まだ何も読めていない時（null）は
    // 1件だけの表を作らない（読み込みの結果を待つ）
    if (saved.admin_on === dayRef.current) {
      setRecords((prev) => {
        if (prev === null) return prev
        const list = prev.filter(
          (r) => r.id !== saved.id && !(saved.slot !== 'prn' && r.resident_id === saved.resident_id && r.slot === saved.slot),
        )
        return [...list, saved]
      })
    }
    setPendingMarks((prev) => {
      const key = cellKey(saved.resident_id, saved.slot)
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
    supersedeInFlight()
  }

  /**
   * 保存・取り消しの前に投げた読み直しがまだ返っていなければ、もう一度読み直す（F20）。その古い応答は保存の前の状態なので、
   * 後から返ると自分の記録が消えて見える（自分の書込の通知は捨てるので戻らない）。読み直し直すと世代が進み、古い応答は捨てられる
   */
  function supersedeInFlight() {
    if (inFlightRef.current > 0) void reloadDay()
  }

  /** そのマスに未送信の記録（この端末の送信待ち・送信中、または画面の「送信待ちにした入力」の印）があるか */
  function cellPending(residentId: number, slot: MedSlot, cell: MedCell): boolean {
    const recId = cell.kind === 'record' ? cell.record.id : null
    return pendingMarks.has(cellKey(residentId, slot)) || hasPendingMed(residentId, day, slot, recId)
  }

  /**
   * 表示中の日付と違う日の記録なら書かずに読み直す（古い応答が表に残っていた時の、書き込みの側の歯止め・F20）。
   * 書かなかった時は true
   */
  function rejectOtherDay(rec: MedAdmin): boolean {
    if (rec.admin_on === dayRef.current) return false
    setMsg({ tone: 'warn', text: MSG_OTHER_DAY })
    void reloadDay()
    return true
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

  /** 空いているマスを押した（「服用済み」）・「未」のマスの小窓で状態を選んだ: その状態で記録する */
  async function recordNew(residentId: number, slot: MedSlot, status: MedStatus = 'taken', note = '') {
    const key = cellKey(residentId, slot)
    if (locked || busy.has(key)) return
    if (recorderId === null) {
      setMsg({ tone: 'warn', text: MSG_NO_RECORDER })
      return
    }
    const input = {
      admin_on: day,
      slot,
      status,
      given_at: null,
      prn_drug: null,
      prn_reason: null,
      prn_effect: null,
      note: note.trim() === '' ? null : note,
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
      const saved = handleResult(res, () => setPendingMarks((prev) => new Map(prev).set(key, status)))
      // 落薬・誤薬を選んだ時は、送れたか（送信待ちか）に関係なく事故報告の案内を出す（状態を直した時と同じ）
      if (isIncidentStatus(status) && (saved !== null || (res === 'queued' && isQueuePersisted()))) {
        setIncidentFor({ residentId, day })
      }
      if (saved === null) return
      applySaved(saved)
      const name = residentById.get(residentId)?.name ?? ''
      show(`${name ? `${name}　` : ''}${MED_SLOT_LABEL[slot]}を「${MED_STATUS_LABEL[saved.status]}」で記録しました。`)
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
    if (action === 'insert') void recordNew(row.residentId, slot)
    else if (action === 'choose') setNewFor({ residentId: row.residentId, slot })
    else if (action === 'dialog' && cell.kind === 'record') setStatusFor(cell.record)
  }

  /** 状態の小窓で保存（状態・備考が変わった時だけ送る） */
  async function saveStatus(rec: MedAdmin, status: MedStatus, note: string) {
    setStatusFor(null)
    const key = cellKey(rec.resident_id, rec.slot)
    if (locked || busy.has(key)) return
    if (rejectOtherDay(rec)) return
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
        setIncidentFor({ residentId: rec.resident_id, day: rec.admin_on })
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
    if (rejectOtherDay(rec)) return
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
      setRecords((prev) => (prev === null ? prev : prev.filter((r) => r.id !== rec.id)))
      supersedeInFlight()
      show('記録を取り消しました。')
    } catch (e) {
      if (!aliveRef.current) return
      setMsg({ tone: 'danger', text: e instanceof DbError ? e.message : MSG_SAVE_FAILED })
    } finally {
      if (aliveRef.current) setCellBusy(key, false)
    }
  }

  /**
   * 頓服の記録。記録する日（adminOn）は小窓が決める（ふだんは表示中の日。開いたまま0時を越えた時は、確かめた上で
   * 今日を選べる・F33）。使用時刻はその日の時刻として送る
   */
  async function savePrn(p: PrnInput): Promise<string | null> {
    if (locked) return kindBlockedMessage('med')
    if (recorderId === null) return MSG_NO_RECORDER
    const givenAt = localDateTimeIso(p.adminOn, p.hm)
    const input = {
      admin_on: p.adminOn,
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
      // 他の端末が同じ頃に記録した頓服も見えるように読み直す（自分の書込の通知は捨てるので、そのままでは相手の行が出ない・F55）
      if (res.admin_on === dayRef.current) void reloadDay()
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
    if (rejectOtherDay(rec)) return
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

  /** 頓服の小窓に出す、その方のその日の頓服（サーバーから取り直す＋この端末の未送信。読めなければ null・F55） */
  const loadPrnSameDay = useCallback(
    async (residentId: number, d: string): Promise<PrnSameDayItem[] | null> => {
      try {
        const rows = await loadRecords(d)
        return prnSameDayItems(rows, pendingPrnOps(d), residentId, d, (id) => staffNameRef.current(id))
      } catch {
        return null
      }
    },
    [loadRecords],
  )

  // ── 開いたまま日付が変わった時（F18） ──
  /** 入力中（小窓）・保存中・未送信・止まった記録があるか（あれば日付を勝手に切り替えない＝送り先の日をずらさない） */
  const holding =
    prnOpen ||
    statusFor !== null ||
    newFor !== null ||
    deleteFor !== null ||
    effectFor !== null ||
    incidentFor !== null ||
    staffPickerOpen ||
    busy.size > 0 ||
    pendingMarks.size > 0 ||
    pendingPrnOps(day).length > 0 ||
    stoppedHere.length > 0 ||
    allRows.some((row) => MED_SLOTS.some((s) => cellPending(row.residentId, s, row.cells[s])))
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
        <LoadingBlock label="与薬チェックの画面を準備しています…" />
      </div>
    )
  }

  const recorderName = staffName(recorderId)
  const isToday = day === today
  const statusName = statusFor === null ? '' : (residentById.get(statusFor.resident_id)?.name ?? '')
  const effectName = effectFor === null ? '' : (residentById.get(effectFor.resident_id)?.name ?? '')
  const showTable = slots !== null && (configuredCount > 0 || allCounts.recorded > 0)
  // 止まった記録のうち、表示中の日の表・頓服の区画のどちらにも出ない分（ほかの日の記録・表に無い記録）
  const stoppedElsewhere = stoppedAll.filter(
    (op) => !stoppedHere.includes(op) && !(op.kind === 'insert' && op.payload.slot === 'prn' && op.payload.admin_on === day),
  ).length
  const recordById = new Map((records ?? []).map((r) => [r.id, r] as const))

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
            {kindBlockedMessage('med')}
          </p>
          <p className="mt-2 text-base text-ink2">記録の閲覧はこのままできます。</p>
        </div>
      ) : null}

      {/* 開いたまま日付が変わり、入力中・未送信があったので切り替えなかった時の帯（F18） */}
      {rolloverDay !== null && rolloverDay === day && !isToday ? (
        <div role="status" className="rounded-lg border border-warn bg-warn-bg p-4 print:hidden">
          <p className="text-base text-ink">
            <span aria-hidden="true">▲ </span>
            日付が変わりました（表示中: {fmtDayLabel(day)}）。入力中・未送信の記録があったので、表示はそのままにしています。今日の記録は「今日を開く」から入れてください。
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
        <p className="mt-1 text-sm font-bold text-ink">
          <span aria-hidden="true">ⓘ </span>
          {fmtMedAutoTimes()} に自動で済みになります（例外は押して変更）。自動で入らなかった方（外泊・入院など）は『不在』等を押してください
        </p>
        <p className="mt-1 text-sm text-ink2">
          空いているマスを押すと「服用済み」で記録します。「未」のマスは押すと状態を選んで記録します。記録済みのマスを押すと状態を直せます。
          「未」は、{MED_AUTO_SLOTS.map((s) => MED_SLOT_LABEL[s]).join('・')}は自動の時刻から{MED_AUTO_GRACE_MIN}分
          {/* 自動でない時間帯（締め時刻で判定）がある時だけ締めを添える（眠前も自動になった 0016 以降は無い） */}
          {MED_SLOTS.filter((s) => !MED_AUTO_SLOTS.includes(s)).map((s) => `、${MED_SLOT_LABEL[s]}は締め（${MED_DEADLINES[s]}）`).join('')}を過ぎても記録が無いマスです。
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

          {stoppedHere.length > 0 || stoppedElsewhere > 0 ? (
            <div role="status" className="rounded-lg border border-danger bg-danger-bg p-3">
              <p className="text-base font-bold text-danger">
                <span aria-hidden="true">⚠ </span>送れずに止まっている記録があります
              </p>
              {stoppedHere.length > 0 ? (
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink">
                  {stoppedHere.map((op) => {
                    const rec = op.rowId === null ? null : (recordById.get(op.rowId) ?? null)
                    const rid = rec?.resident_id ?? (typeof op.payload.resident_id === 'number' ? op.payload.resident_id : null)
                    const name = rid === null ? '' : (residentById.get(rid)?.name ?? `利用者番号 ${rid}`)
                    return (
                      <li key={op.qid} className="break-words">
                        {stoppedMedText(op, rec, name)}
                      </li>
                    )
                  })}
                </ul>
              ) : null}
              {stoppedElsewhere > 0 ? (
                <p className="mt-1 text-sm text-ink">ほかの日の与薬の記録にも、止まっているものが {stoppedElsewhere}件あります。</p>
              ) : null}
              <p className="mt-1 text-sm text-ink">{MSG_STOPPED_GUIDE}</p>
              <Link to="/settings" className="inline-flex min-h-tap items-center text-sm font-bold text-link">
                設定タブを開く<span aria-hidden="true"> ›</span>
              </Link>
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
        open={newFor !== null}
        record={null}
        newSlot={newFor?.slot ?? null}
        name={newFor === null ? '' : (residentById.get(newFor.residentId)?.name ?? '')}
        locked={locked}
        onCancel={() => setNewFor(null)}
        onSave={(status, note) => {
          const target = newFor
          setNewFor(null)
          if (target !== null) void recordNew(target.residentId, target.slot, status, note)
        }}
        onDelete={() => setNewFor(null)}
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

      <IncidentDialog
        open={incidentFor !== null}
        enabled={incidentEnabled}
        onClose={() => setIncidentFor(null)}
        onRecord={() => {
          const target = incidentFor
          setIncidentFor(null)
          if (target === null) return
          // URL には利用者 id・日付・種別のキーだけを載せる（氏名は載せない）
          const q = new URLSearchParams({ resident: String(target.residentId), date: target.day, type: 'med_error' })
          navigate(`/incident/new?${q.toString()}`)
        }}
      />

      <PrnDialog
        open={prnOpen}
        day={day}
        today={today}
        isToday={isToday}
        residents={activeResidents}
        loadSameDay={loadPrnSameDay}
        refreshKey={records}
        onCancel={() => setPrnOpen(false)}
        onSave={async (p) => {
          const err = await savePrn(p)
          if (err === null && aliveRef.current) {
            setPrnOpen(false)
            // 今日の記録にした時（F33）は、表示も記録した日にする（記録した行・未送信の行がそこに出る）
            if (p.adminOn !== dayRef.current) {
              setDay(p.adminOn)
              setDayMsg(`頓服を ${fmtDayLabel(p.adminOn)} の記録にしました。表示も ${fmtDayLabel(p.adminOn)} にしました。`)
            }
          }
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
  // 自動で入った記録も手で記録したものと同じ見た目（「（自動）」・色の区別は出さない・2026-10-01 代表指示）
  const time = pendingStatus === null && cell.kind === 'record' ? fmtClock(cell.record.created_at) : ''
  const srText =
    status !== null
      ? `${name} ${label} ${MED_STATUS_LABEL[status]}${time ? ` ${time}` : ''}${pending ? '（未送信）' : ''}`
      : missing
        ? `${name} ${label} 未記録（時刻を過ぎています）。押すと状態を選んで記録`
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
                    ? 'この記録は自動では送れません。設定タブの「未送信データ」で、どうするか選んでください（同じ頓服を記録し直さないでください）。'
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
  /** 記録の無い「未」のマスから開いた時の時間帯（新しい記録の状態を選ぶ。取り消すは出さない・状態は選ぶまで未選択） */
  newSlot?: MedSlot | null
  name: string
  locked: boolean
  onCancel: () => void
  onSave: (status: MedStatus, note: string) => void
  onDelete: () => void
}

function StatusDialog({ open, record, newSlot = null, name, locked, onCancel, onSave, onDelete }: StatusDialogProps) {
  const [status, setStatus] = useState<MedStatus | null>('taken')
  const [note, setNote] = useState('')
  const uid = useId()
  const firstRef = useRef<HTMLButtonElement>(null)
  const isNew = record === null && newSlot !== null

  useEffect(() => {
    if (!open) return
    if (record !== null) {
      setStatus(record.status)
      setNote(record.note ?? '')
    } else {
      // 「未」のマスから開いた時は、服用済みを勝手に選ばない（渡せたか・不在かを職員が選ぶ）
      setStatus(null)
      setNote('')
    }
  }, [open, record])

  const title = record !== null ? `${MED_SLOT_LABEL[record.slot]}の状態` : newSlot !== null ? `${MED_SLOT_LABEL[newSlot]}の状態` : '状態'
  return (
    <ModalShell open={open} label={title} onClose={onCancel} initialFocus={firstRef} narrow>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <h2 className="text-lg font-bold text-ink">{title}</h2>
        {name ? <p className="mt-1 text-sm text-ink2">{name}</p> : null}
        {record !== null && record.created_at !== null ? (
          <p className="mt-1 text-sm text-ink2">記録した時刻 {fmtClock(record.created_at)}</p>
        ) : isNew ? (
          <p className="mt-1 text-sm text-warn">
            <span aria-hidden="true">▲ </span>
            記録がありません。状態を選んで保存してください（外泊・入院などは「不在」）。
          </p>
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
        {status !== null && isIncidentStatus(status) ? (
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
        {isNew ? null : (
          <button
            type="button"
            onClick={onDelete}
            disabled={locked}
            className="mr-auto min-h-tap rounded border border-danger px-4 text-base text-danger disabled:border-border disabled:text-ink3"
          >
            取り消す
          </button>
        )}
        <button type="button" onClick={onCancel} className="min-h-tap rounded border border-border-strong px-4 text-base text-ink">
          やめる
        </button>
        <button
          type="button"
          onClick={() => {
            if (status !== null) onSave(status, note)
          }}
          disabled={locked || status === null}
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

function IncidentDialog({
  open,
  enabled,
  onClose,
  onRecord,
}: {
  open: boolean
  /** 事故・ヒヤリハットの入力が解禁中（ボタン）か、封鎖中・確かめられない（紙の案内）か */
  enabled: boolean
  onClose: () => void
  onRecord: () => void
}) {
  const okRef = useRef<HTMLButtonElement>(null)
  if (!enabled) {
    return (
      <ModalShell open={open} label="事故・ヒヤリハットの記録" onClose={onClose} initialFocus={okRef} narrow>
        <div className="p-4" role="alert">
          <h2 className="text-lg font-bold text-danger">
            <span aria-hidden="true">▲ </span>落薬・誤薬を記録しました
          </h2>
          <p className="mt-2 text-base text-ink">{MSG_INCIDENT_PAPER}</p>
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
  return (
    <ModalShell open={open} label="事故・ヒヤリハットの記録" onClose={onClose} initialFocus={okRef} narrow>
      <div className="p-4" role="alert">
        <h2 className="text-lg font-bold text-danger">
          <span aria-hidden="true">▲ </span>落薬・誤薬を記録しました
        </h2>
        <p className="mt-2 text-base text-ink">{MSG_INCIDENT_AFTER}</p>
      </div>
      <div className="flex flex-wrap justify-end gap-gap border-t border-border p-4">
        <button
          type="button"
          onClick={onClose}
          className="min-h-tap rounded border border-border-strong px-4 text-base text-ink"
        >
          あとで
        </button>
        <button
          ref={okRef}
          type="button"
          onClick={onRecord}
          className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
        >
          事故・ヒヤリハットを記録する
        </button>
      </div>
    </ModalShell>
  )
}

// ══════════════════════════════════════════════════════════════
// 頓服の記録（小窓）
// ══════════════════════════════════════════════════════════════

/** 頓服の記録の入力（adminOn＝記録する日。ふだんは表示中の日） */
interface PrnInput {
  residentId: number
  hm: string
  drug: string
  reason: string
  note: string
  adminOn: string
}

interface PrnDialogProps {
  open: boolean
  day: string
  /** 今日（日付が変わったことの知らせと、「今日の記録にする」に使う） */
  today: string
  isToday: boolean
  residents: Resident[]
  /** その方のその日の頓服を取り直す（読めなければ null・F55） */
  loadSameDay: (residentId: number, day: string) => Promise<PrnSameDayItem[] | null>
  /** 画面の記録を読み直した合図（他の端末の頓服の通知など）。変わったら小窓の一覧も取り直す */
  refreshKey?: unknown
  onCancel: () => void
  /** 保存する。失敗した時は理由文を返す（小窓は閉じずに入力を残す） */
  onSave: (p: PrnInput) => Promise<string | null>
}

/** 記録する前の確かめ（F33・F55）。保存は止めず、押し直してもらうだけ */
interface PrnConfirm {
  adminOn: string
  staleDay: boolean
  hoursBefore: number
  sameDrug: PrnSameDayItem[]
}

function PrnDialog({ open, day, today, isToday, residents, loadSameDay, refreshKey, onCancel, onSave }: PrnDialogProps) {
  const [residentId, setResidentId] = useState<number | null>(null)
  const [hm, setHm] = useState('')
  const [drug, setDrug] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  /** 小窓を開いた時に今日を表示していたか（開いたまま0時を越えたことの知らせに使う） */
  const [openedToday, setOpenedToday] = useState(false)
  /** その方のその日の頓服（'loading'＝取り直し中／items=null＝読めなかった） */
  const [sameDay, setSameDay] = useState<{ residentId: number; items: PrnSameDayItem[] | null } | 'loading' | null>(null)
  const [confirm, setConfirm] = useState<PrnConfirm | null>(null)
  const sameDaySeq = useRef(0)
  const wasOpenRef = useRef(false)
  const uid = useId()
  const firstRef = useRef<HTMLButtonElement>(null)

  // 初期化は「開いた時」（open が false→true）だけ。isToday は依存に入れない（開いている間に0時を越えて isToday が
  // 変わるだけで、入居者・時刻・薬・理由・備考が全部消えていた・F32）。開いた時点の isToday で使用時刻の既定を決める
  useEffect(() => {
    const opening = open && !wasOpenRef.current
    wasOpenRef.current = open
    if (!opening) return
    setResidentId(null)
    // 使用時刻の既定は「今」（今日を表示している時だけ。過去の日は入れてもらう）
    setHm(isToday ? clockInputValue(new Date().toISOString()) : '')
    setDrug('')
    setReason('')
    setNote('')
    setError(null)
    setSaving(false)
    setOpenedToday(isToday)
    setSameDay(null)
    setConfirm(null)
  }, [open])

  // 入居者を選んだら、その方のその日の頓服をサーバーから取り直して出す（古い表示のまま二重に与薬しない・F55）。
  // 小窓を開いている間に画面の記録が読み直された（他の端末の頓服の通知など）時も取り直す（表示中の一覧は出したまま）
  useEffect(() => {
    if (!open || residentId === null) return
    const seq = ++sameDaySeq.current
    setSameDay((cur) => (cur !== null && cur !== 'loading' && cur.residentId === residentId ? cur : 'loading'))
    void loadSameDay(residentId, day).then((items) => {
      if (seq === sameDaySeq.current) setSameDay({ residentId, items })
    })
  }, [open, residentId, day, loadSameDay, refreshKey])

  const resident = residents.find((r) => r.id === residentId) ?? null
  /** 開いたまま0時を越えた（この小窓は開いた日＝表示中の日の分として記録する・F32） */
  const crossedMidnight = openedToday && !isToday

  /**
   * 記録する。acknowledged=false の時は先に確かめる（記録する日が今日でなく使用時刻が12時間以上前・同じ日に同じ薬）。
   * 確かめはサーバーから取り直した一覧で行う（読めなければ同じ薬の確かめは飛ばす＝保存は止めない）
   */
  async function submit(adminOn: string, acknowledged: boolean) {
    if (residentId === null) {
      setError('入居者を選んでください。')
      return
    }
    setSaving(true)
    setError(null)
    if (!acknowledged) {
      const givenAt = localDateTimeIso(adminOn, hm)
      const items = await loadSameDay(residentId, adminOn)
      if (adminOn === day) setSameDay({ residentId, items })
      const c = prnCheck({ adminOn, today: todayIso(), givenAt, nowMs: Date.now(), drug, sameDay: items })
      if (c.staleDay || c.sameDrug.length > 0) {
        setSaving(false)
        setConfirm({ adminOn, ...c })
        return
      }
    }
    setConfirm(null)
    const err = await onSave({ residentId, hm, drug, reason, note, adminOn })
    setSaving(false)
    setError(err)
  }

  /** 入力を変えたら、出していた確かめは外す（確かめた中身と違うまま記録しない） */
  function changed<T>(set: (v: T) => void): (v: T) => void {
    return (v: T) => {
      setConfirm(null)
      set(v)
    }
  }

  return (
    <>
      <ModalShell open={open && !pickerOpen} label="頓服を記録" onClose={onCancel} initialFocus={firstRef}>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <h2 className="text-lg font-bold text-ink">頓服を記録</h2>
          <p className="mt-1 text-sm text-ink2">{fmtDayLabel(day)}</p>
          {crossedMidnight ? (
            <p role="status" className="mt-2 rounded border border-warn bg-warn-bg px-2 py-1 text-sm text-ink">
              <span aria-hidden="true">▲ </span>
              日付が変わりました。この記録は {fmtDayLabel(day)} の分です（0時を過ぎてから使った頓服は、記録する時に今日の分を選べます）。入力はそのまま残っています。
            </p>
          ) : null}
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
          {resident !== null ? (
            <PrnSameDayList day={day} state={sameDay !== null && sameDay !== 'loading' && sameDay.residentId !== resident.id ? 'loading' : sameDay} />
          ) : null}
          <label htmlFor={`${uid}-time`} className="mt-3 block text-sm text-ink2">
            使用時刻（必須）
          </label>
          <input
            id={`${uid}-time`}
            type="time"
            value={hm}
            onChange={(e) => changed(setHm)(e.target.value)}
            className="tabular mt-1 min-h-tap rounded border border-border bg-surface px-3 text-base text-ink"
          />
          <label htmlFor={`${uid}-drug`} className="mt-3 block text-sm text-ink2">
            薬（必須）
          </label>
          <input
            id={`${uid}-drug`}
            type="text"
            value={drug}
            onChange={(e) => changed(setDrug)(e.target.value)}
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
        {/* 記録する前の確かめ（F33・F55）は、ボタンのすぐ上に出す（中身を下まで送らなくても読める） */}
        <div className="border-t border-border p-4">
          {confirm !== null ? (
            <div role="alert" className="mb-3 max-h-40 space-y-2 overflow-y-auto rounded border border-warn bg-warn-bg p-3 text-sm text-ink">
              {confirm.staleDay ? (
                <p>
                  <span aria-hidden="true">▲ </span>
                  表示中は {fmtDayLabel(confirm.adminOn)} です。使用時刻 {hm} は {fmtDayLabel(confirm.adminOn)} の {hm}（今から約{confirm.hoursBefore}時間前）として記録されます。
                  0時を過ぎてから使った頓服なら「今日（{fmtDayLabel(today)}）の記録にする」を押してください。
                </p>
              ) : null}
              {confirm.sameDrug.length > 0 ? (
                <p>
                  <span aria-hidden="true">▲ </span>
                  この方には {fmtDayLabel(confirm.adminOn)} に同じ薬の頓服があります（
                  {confirm.sameDrug.map((x) => `${fmtClock(x.givenAt) || '—'} ${x.drug ?? ''}${x.unsent ? '・この端末の未送信' : x.recorder ? `・記入 ${x.recorder}` : ''}`).join('、')}
                  ）。二重に記録していないか確かめてください。別の与薬なら「このまま記録する」を押してください。
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-gap">
            {confirm !== null ? (
              <>
                <button
                  type="button"
                  onClick={() => setConfirm(null)}
                  disabled={saving}
                  className="min-h-tap rounded border border-border-strong px-4 text-base text-ink"
                >
                  戻る
                </button>
                {confirm.staleDay && confirm.adminOn !== today ? (
                  <button
                    type="button"
                    onClick={() => void submit(today, false)}
                    disabled={saving}
                    className="min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary disabled:opacity-60"
                  >
                    今日（{fmtDayLabel(today)}）の記録にする
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void submit(confirm.adminOn, true)}
                  disabled={saving}
                  className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:opacity-60"
                >
                  {saving ? '保存しています…' : 'このまま記録する'}
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={onCancel} className="min-h-tap rounded border border-border-strong px-4 text-base text-ink">
                  やめる
                </button>
                <button
                  type="button"
                  onClick={() => void submit(day, false)}
                  disabled={saving}
                  className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:opacity-60"
                >
                  {saving ? '保存しています…' : '記録する'}
                </button>
              </>
            )}
          </div>
        </div>
      </ModalShell>
      <ResidentPickerModal
        open={open && pickerOpen}
        residents={residents}
        onPick={(id) => {
          setPickerOpen(false)
          if (id !== null) {
            setConfirm(null)
            setResidentId(id)
          }
        }}
        onClose={() => setPickerOpen(false)}
      />
    </>
  )
}

/** 小窓の中の「この方のこの日の頓服」（参考の表示。読めなくても記録は止めない・F55） */
function PrnSameDayList({ day, state }: { day: string; state: { items: PrnSameDayItem[] | null } | 'loading' | null }) {
  return (
    <div className="mt-2 rounded border border-border bg-surface2 p-2 text-sm text-ink" aria-live="polite">
      <p className="font-bold">この方の {fmtDayLabel(day)} の頓服</p>
      {state === null || state === 'loading' ? (
        <p className="text-ink2">確かめています…</p>
      ) : state.items === null ? (
        <p className="text-warn">
          <span aria-hidden="true">▲ </span>
          確かめられませんでした（記録はできます。電波が戻ったら、頓服の一覧で二重になっていないか確かめてください）。
        </p>
      ) : state.items.length === 0 ? (
        <p className="text-ink2">記録はありません。</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {state.items.map((x) => (
            <li key={x.key} className="break-words">
              <span className="tabular">{fmtClock(x.givenAt) || '—'}</span>　{x.drug ?? '—'}
              {x.unsent ? '　（この端末の未送信）' : `　記入 ${x.recorder ?? '—'}`}
            </li>
          ))}
        </ul>
      )}
    </div>
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
