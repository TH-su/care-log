// 事故・ヒヤリハットの入力・編集（ルート /incident/new・/incident/:id）。2026-09-26 追加。
//
// 1ページのフォーム。節ごとに開閉できる（<details>）。熊本市の事故報告書（事業者→熊本市）の欄に合わせる。
//   ・先頭の節「第1報」に要る最小の項目（区分・発生日時・場所・種別・対象者・発生時状況・発生時の対応・記録者）だけで保存できる
//   ・残りの欄（1〜9）は後から追記する（rev 照合の update。変えた欄だけを送る）
//   ・ヒヤリハットでは 5・6 の受診・診断・家族への報告・関係機関の欄を隠す（値は消さない）
//   ・「市への報告が必要な可能性」の案内（判断は人。印は人が付ける）と「第1報は発生から5日以内が目安（国の通知）」の注記
//   ・確認者（既定は施設長 app_settings.manager_staff_id）＋「確認しました」。権限の強制はまだ無い
//   ・「完了にする」（原因分析・再発防止策が空なら確認）／「対応中に戻す」（確認つき・rev 照合・2026-09-26 チーフ追加）／
//     取り消し（論理削除・確認つき・記入者必須）
//   ・「事故報告書を印刷」: 報告区分・提出日を小窓で選び（保存する）、A4 縦で刷る（IncidentReportSheet）
//   ・与薬チェックからは /incident/new?resident=ID&date=YYYY-MM-DD&type=med_error で開く（区分は未選択のまま。URL に氏名を載せない）
// 未送信の変更がある記録は編集できない（入浴・与薬と同じ。送信待ちは書き換えない・読むだけ）。
// 他の端末が先に変えていた時（conflict）は、最新の内容に自分が変えた欄を重ねて表示し、確かめてから保存し直してもらう（入力を消さない）。
//
// 規律:
// - 取得・保存は db.ts の関数のみ。入力解禁は input_enabled_incident（封鎖中は隠さずにディセーブル＋理由文。書込関数の入口でも止まる）
// - 対象者の氏名は名簿の値だけを使い、画面では直せない（2026-09-26 チーフ裁定）。氏名は送らず、サーバーのトリガが名簿から写す
//   （記録時点の写しを残す＝送信待ちに氏名を置かない）
// - 入力中の値・日付は localStorage に保存しない（原則11: 現在地は URL で復元される）。未保存の入力がある時は画面を離れる前に確認する
// - 氏名・記録を console に出さない。色だけで意味を伝えない（文字・記号を併記）

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  DbError,
  fetchAllResidents,
  fetchIncident,
  fetchOfficeProfile,
  fetchStaff,
  getAppSetting,
  getKindInputGate,
  hasPendingIncident,
  insertIncident,
  isQueuePersisted,
  isSelfWrite,
  kindBlockedMessage,
  queueSubscribe,
  softDeleteIncident,
  subscribeIncidentChanges,
  updateIncident,
} from '../lib/db'
import type { IncidentPatch, OfficeProfile } from '../lib/db'
import { resolveActor, touchActivity } from '../lib/actor'
import { LEAVE_BODY, LEAVE_TITLE, registerUnsaved } from '../lib/leaveGuard'
import {
  careLevelKeyOf,
  CITY_REPORT_DEADLINE_NOTE,
  CITY_REPORT_HINT,
  cityReportHint,
  DEFAULT_INSURER,
  detailChanges,
  emptyIncidentDetail,
  genderKeyOf,
  missingForClose,
  parseIncidentPrefill,
  validateIncidentInput,
} from '../lib/incident'
import type { IncidentInput } from '../lib/incident'
import { clockInputValue, localDateTimeIso } from '../lib/med'
import { fmtDayLabel, todayIso } from '../lib/format'
import {
  INCIDENT_ADDRESS_KIND_LABEL,
  INCIDENT_ADDRESS_KINDS,
  INCIDENT_CARE_LEVEL_LABEL,
  INCIDENT_CARE_LEVELS,
  INCIDENT_DEMENTIA_LEVEL_LABEL,
  INCIDENT_DEMENTIA_LEVELS,
  INCIDENT_DIAGNOSIS_KIND_LABEL,
  INCIDENT_DIAGNOSIS_KINDS,
  INCIDENT_FAMILY_RELATION_LABEL,
  INCIDENT_FAMILY_RELATIONS,
  INCIDENT_GENDER_LABEL,
  INCIDENT_GENDERS,
  INCIDENT_KIND_LABEL,
  INCIDENT_KINDS,
  INCIDENT_OFFICE_LABEL,
  INCIDENT_OFFICES,
  INCIDENT_PLACE_LABEL,
  INCIDENT_PLACES,
  INCIDENT_REPORT_STAGE_LABEL,
  INCIDENT_REPORT_STAGES,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABEL,
  INCIDENT_STATUS_LABEL,
  INCIDENT_TYPE_LABEL,
  INCIDENT_TYPES,
  INCIDENT_VISIT_METHOD_LABEL,
  INCIDENT_VISIT_METHODS,
} from '../lib/types'
import type {
  Incident,
  IncidentDetail,
  IncidentKind,
  IncidentOffice,
  IncidentPlace,
  IncidentReportStage,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  Resident,
  Staff,
} from '../lib/types'
import {
  ConfirmDialog,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  ModalShell,
  ResidentPickerModal,
  StaffPickerModal,
  useToast,
} from '../components/ui'
import { PrintArea } from '../components/print/PrintArea'
import type { PrintAreaHandle } from '../components/print/PrintArea'
import { IncidentReportSheet } from './IncidentReportSheet'

const ERR_LOAD = '事故・ヒヤリハットの記録を読み込めませんでした。通信状態を確認して、再試行してください。'
const ERR_GATE =
  '事故・ヒヤリハットの記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。記録の閲覧はこのままできます。'
const ERR_NOT_FOUND = 'この記録は見つかりませんでした（取り消された可能性があります）。一覧から開き直してください。'
const MSG_CONFLICT =
  '他の端末が先にこの記録を変更しました。最新の内容に、あなたが変えた欄を重ねて表示しています。確かめてから、もう一度保存してください。'
const MSG_REMOTE =
  '他の端末がこの記録を変更しました。保存すると、最新の内容にあなたが変えた欄を重ねて確かめてもらいます（入力は消えません）。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度保存してください。'
const MSG_SAVE_FAILED = '保存できませんでした。通信状態を確認して、もう一度保存してください。'
const MSG_NO_OPERATOR = '記入者（この画面で保存する職員）が選ばれていません。上の「記入者」で選んでから保存してください。'
const MSG_QUEUED = '未送信です（電波が戻ると自動で送信します）。送信が終わるまで、この記録は直せません。'
const MSG_INSERT_QUEUED =
  '未送信です（電波が戻ると自動で送信します）。送信が終わると一覧に出ます。二重に記録しないよう、一覧の「未送信」を確かめてください。'
const MSG_PENDING = '未送信の変更があります。送信が終わってから直してください（閲覧・印刷はできます）。'
const MSG_DELETED_REMOTE = 'この記録は他の端末で取り消されました。一覧から開き直してください。'
const MSG_CONFIRM_NOTE = '確認者の権限の強制はまだありません（誰でも「確認しました」を押せます）。'

/** 画面の入力の形（保存する値 IncidentInput に組み直す前。時刻は 'HH:MM'、区分は未選択を持てる） */
interface FormState {
  kind: IncidentKind | null
  resident_id: number | null
  occurred_on: string
  time: string
  office: IncidentOffice | null
  place: IncidentPlace | null
  place_other: string | null
  types: IncidentType[]
  severity: IncidentSeverity | null
  status: IncidentStatus
  report_stage: IncidentReportStage | null
  report_no: number | null
  submitted_on: string | null
  city_report_needed: boolean
  city_reported_on: string | null
  reporter_id: number | null
  confirmer_id: number | null
  confirmed_at: string | null
  /** 完了にした日時（表示用。送る値は db.ts が状態の変更に合わせて決める） */
  closed_at: string | null
  detail: IncidentDetail
}

/** 列で持つ項目（detail 以外）の並び。差分を取る時に使う */
const COLUMN_KEYS = [
  'kind',
  'resident_id',
  'occurred_on',
  'occurred_at',
  'office',
  'place',
  'place_other',
  'types',
  'severity',
  'status',
  'report_stage',
  'report_no',
  'submitted_on',
  'city_report_needed',
  'city_reported_on',
  'reporter_id',
  'confirmer_id',
  'confirmed_at',
] as const

function formOf(i: Incident): FormState {
  return {
    kind: i.kind,
    resident_id: i.resident_id,
    occurred_on: i.occurred_on,
    time: clockInputValue(i.occurred_at),
    office: i.office,
    place: i.place,
    place_other: i.place_other,
    types: [...i.types],
    severity: i.severity,
    status: i.status,
    report_stage: i.report_stage,
    report_no: i.report_no,
    submitted_on: i.submitted_on,
    city_report_needed: i.city_report_needed,
    city_reported_on: i.city_reported_on,
    reporter_id: i.reporter_id,
    confirmer_id: i.confirmer_id,
    confirmed_at: i.confirmed_at,
    closed_at: i.closed_at,
    detail: { ...i.detail },
  }
}

/** 画面の入力 → 保存する値（区分が未選択・時刻が空なら検証で止まる形のまま渡す） */
function toInput(f: FormState): IncidentInput {
  return {
    kind: (f.kind ?? '') as IncidentKind,
    resident_id: f.resident_id,
    occurred_on: f.occurred_on,
    occurred_at: localDateTimeIso(f.occurred_on, f.time) ?? '',
    office: f.office,
    place: f.place,
    place_other: f.place_other === null || f.place_other.trim() === '' ? null : f.place_other,
    types: [...f.types],
    severity: f.severity,
    status: f.status,
    report_stage: f.report_stage,
    report_no: f.report_stage === 'nth' ? f.report_no : null,
    submitted_on: f.submitted_on,
    city_report_needed: f.city_report_needed,
    city_reported_on: f.city_reported_on,
    reporter_id: f.reporter_id,
    confirmer_id: f.confirmer_id,
    confirmed_at: f.confirmed_at,
    closed_at: f.closed_at,
    detail: { ...f.detail },
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * サーバーの記録と画面の入力の差（送る変更）。氏名の写しは入れない（画面では直せない・サーバーが写す・残す）
 */
function patchOf(server: Incident, f: FormState): IncidentPatch {
  const next = toInput(f)
  const p: Record<string, unknown> = {}
  for (const k of COLUMN_KEYS) {
    if (k === 'occurred_at') {
      if (new Date(next.occurred_at).getTime() !== new Date(server.occurred_at).getTime()) p.occurred_at = next.occurred_at
      continue
    }
    if (!same(server[k], next[k])) p[k] = next[k]
  }
  const dc = detailChanges(server.detail, next.detail)
  delete dc.subject_name
  if (Object.keys(dc).length > 0) p.detail = dc
  return p as IncidentPatch
}

/** 送った変更を最新の記録に重ねる（競合の後。自分が変えた欄だけを最新に上書きして見せる） */
function overlay(latest: Incident, p: IncidentPatch): FormState {
  const f = formOf(latest)
  const { detail, occurred_at, ...cols } = p
  const out = { ...f, ...cols } as FormState
  if (occurred_at !== undefined) out.time = clockInputValue(occurred_at) || f.time
  out.detail = { ...f.detail, ...(detail ?? {}) }
  return out
}

/**
 * 送信待ちになった保存の後に、手元の基準（サーバーの記録の代わり）として使う形。送った値を重ね、未保存の差分を無くす
 * （送れたら読み直して本物に戻す）。版（rev）は送る前のまま（送信待ちの間は直せないので使わない）。
 * 氏名の写しは、対象者が同じなら前の写しのまま（送っていない）
 */
function asQueued(server: Incident, f: FormState): Incident {
  const v = toInput(f)
  const closed_at =
    v.status !== 'closed' ? null : server.status === 'closed' && server.closed_at !== null ? server.closed_at : new Date().toISOString()
  return {
    ...server,
    ...v,
    closed_at,
    detail: {
      ...v.detail,
      subject_name: v.resident_id === server.resident_id ? server.detail.subject_name : v.detail.subject_name,
    },
    id: server.id,
    rev: server.rev,
  }
}

/** 新しい記録の初期値 */
function blankForm(day: string, reporterId: number | null): FormState {
  return {
    kind: null,
    resident_id: null,
    occurred_on: day,
    time: '',
    office: null,
    place: null,
    place_other: null,
    types: [],
    severity: null,
    status: 'open',
    report_stage: null,
    report_no: null,
    submitted_on: null,
    city_report_needed: false,
    city_reported_on: null,
    reporter_id: reporterId,
    confirmer_id: null,
    confirmed_at: null,
    closed_at: null,
    detail: { ...emptyIncidentDetail(), insurer: DEFAULT_INSURER },
  }
}

/** 対象者を選んだ時の初期値（氏名・性別・要介護度は名簿から。前の方の年齢・開始日・自立度は持ち越さない） */
function withResident(f: FormState, r: Resident | null): FormState {
  if (r === null) {
    return {
      ...f,
      resident_id: null,
      detail: { ...f.detail, subject_name: null, subject_gender: null, care_level: null, subject_age: null, service_start_on: null, dementia_level: null },
    }
  }
  if (f.resident_id === r.id) return f
  return {
    ...f,
    resident_id: r.id,
    detail: {
      ...f.detail,
      subject_name: r.name,
      subject_gender: genderKeyOf(r.gender),
      care_level: careLevelKeyOf(r.care_level),
      subject_age: null,
      service_start_on: null,
      dementia_level: null,
    },
  }
}

type Msg = { tone: 'warn' | 'danger' | 'info'; text: string }
type SaveOutcome = { status: 'saved' | 'queued'; form: FormState } | { status: 'failed' }

export interface IncidentFormPageProps {
  staff?: Staff[]
  actorId?: number | null
}

export function IncidentFormPage({ staff: staffProp, actorId }: IncidentFormPageProps = {}) {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const uid = useId()
  const idParam = params.id
  const isNew = idParam === undefined
  const recordId = !isNew && /^\d{1,12}$/.test(idParam) ? Number(idParam) : null

  const [residents, setResidents] = useState<Resident[] | null>(null)
  const [staff, setStaff] = useState<Staff[] | null>(staffProp ?? null)
  const [gate, setGate] = useState<{ value: boolean; observed: boolean } | null>(null)
  const [profile, setProfile] = useState<OfficeProfile | null>(null)
  const [profileError, setProfileError] = useState(false)
  const [managerId, setManagerId] = useState<number | null>(null)
  const [baseError, setBaseError] = useState<string | null>(null)
  const [baseTick, setBaseTick] = useState(0)

  const [server, setServer] = useState<Incident | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [form, setForm] = useState<FormState | null>(null)
  const [initialNew, setInitialNew] = useState<FormState | null>(null)
  const [operatorId, setOperatorId] = useState<number | null>(null)
  /** 確認者として選び直した職員（null＝選び直していない＝記録の確認者 → 施設長を既定にする） */
  const [confirmPick, setConfirmPick] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)
  const [remoteChanged, setRemoteChanged] = useState(false)
  const [queuedInsert, setQueuedInsert] = useState(false)
  const [queueTick, setQueueTick] = useState(0)
  const [staffPicker, setStaffPicker] = useState<'operator' | 'reporter' | 'confirmer' | null>(null)
  const [residentPickerOpen, setResidentPickerOpen] = useState(false)
  const [closeAsk, setCloseAsk] = useState<string[] | null>(null)
  const [reopenAsk, setReopenAsk] = useState(false)
  const [deleteAsk, setDeleteAsk] = useState(false)
  const [printOpen, setPrintOpen] = useState(false)
  const [printSource, setPrintSource] = useState<FormState | null>(null)
  const [printSeq, setPrintSeq] = useState(0)
  const [leaveAsk, setLeaveAsk] = useState(false)
  const printRef = useRef<PrintAreaHandle>(null)
  const { toast, show } = useToast()
  const aliveRef = useRef(true)
  const dirtyRef = useRef(false)
  const pendingRef = useRef(false)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 名簿・職員・入力解禁・施設長・事業所の情報（画面を開くたびに取り直す）
  useEffect(() => {
    let alive = true
    setBaseError(null)
    Promise.all([
      fetchAllResidents(),
      staffProp !== undefined ? Promise.resolve(staffProp) : fetchStaff(),
      getKindInputGate('incident'),
      getAppSetting('manager_staff_id').catch(() => null),
    ])
      .then(([rs, st, g, mgr]) => {
        if (!alive) return
        setResidents(rs)
        setStaff(st)
        setGate(g)
        const m = mgr !== null && /^\d{1,12}$/.test(mgr.trim()) ? Number(mgr.trim()) : null
        setManagerId(m !== null && st.some((s) => s.id === m && s.active) ? m : null)
      })
      .catch(() => {
        if (alive) setBaseError(ERR_LOAD)
      })
    // 事業所の情報は印刷にだけ使う。読めなくても入力は妨げない（印刷の時に空欄になる旨を出す）
    fetchOfficeProfile()
      .then((p) => {
        if (!alive) return
        setProfile(p)
        setProfileError(false)
      })
      .catch(() => {
        if (alive) setProfileError(true)
      })
    return () => {
      alive = false
    }
  }, [baseTick, staffProp])

  // 記入者の既定値（名簿と照合できた操作者。できなければ未選択＝保存の前に選んでもらう）
  useEffect(() => {
    if (staff === null) return
    setOperatorId((cur) => {
      if (cur !== null && staff.some((s) => s.id === cur && s.active)) return cur
      const fromActor = resolveActor(staff)?.id ?? null
      if (fromActor !== null) return fromActor
      return actorId != null && staff.some((s) => s.id === actorId && s.active) ? actorId : null
    })
  }, [staff, actorId])

  const residentById = useMemo(() => {
    const m = new Map<number, Resident>()
    for (const r of residents ?? []) m.set(r.id, r)
    return m
  }, [residents])
  const rosterName = useCallback(
    (id: number | null): string | null => (id === null ? null : (residentById.get(id)?.name ?? null)),
    [residentById],
  )

  // 新しい記録の初期値（与薬チェックからの受け渡しは既知の値だけ受ける）
  useEffect(() => {
    if (!isNew || residents === null || staff === null || form !== null) return
    const active = new Set(residents.filter((r) => r.active).map((r) => r.id))
    const pre = parseIncidentPrefill(location.search, active, todayIso())
    const reporter = resolveActor(staff)?.id ?? (actorId != null && staff.some((s) => s.id === actorId && s.active) ? actorId : null)
    let f = blankForm(pre.day ?? todayIso(), reporter)
    if (pre.residentId !== null) f = withResident(f, residentById.get(pre.residentId) ?? null)
    if (pre.type !== null) f = { ...f, types: [pre.type] }
    setForm(f)
    setInitialNew(f)
  }, [isNew, residents, staff, form, location.search, actorId, residentById])

  // 既存の記録を読む
  const loadRecord = useCallback(async (): Promise<Incident | null> => {
    if (recordId === null) return null
    return fetchIncident(recordId)
  }, [recordId])

  useEffect(() => {
    if (isNew) return
    let alive = true
    setNotFound(false)
    if (recordId === null) {
      setNotFound(true)
      return
    }
    loadRecord()
      .then((row) => {
        if (!alive) return
        if (row === null) {
          setNotFound(true)
          return
        }
        setServer(row)
        setForm(formOf(row))
        setConfirmPick(null)
        setRemoteChanged(false)
      })
      .catch((e: unknown) => {
        if (alive) setBaseError(e instanceof DbError && e.kind === 'server' ? e.message : ERR_LOAD)
      })
    return () => {
      alive = false
    }
  }, [isNew, recordId, loadRecord, baseTick])

  // 新しく保存して /incident/:id へ移った時の知らせ（履歴の state。業務データは載せない）。
  // 同じ画面の部品のまま URL だけが変わることもあるので、履歴の項目（location.key）ごとに見る
  useEffect(() => {
    const st = location.state as { saved?: string } | null
    if (st?.saved === 'created') show('第1報を保存しました。残りの欄は後から追記できます。')
    // 一度だけ出す（戻る・進むで出し直さない）
    if (st?.saved !== undefined) navigate(location.pathname, { replace: true, state: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key])

  /** いまの入力に未保存の変更があるか */
  const dirty = useMemo(() => {
    if (form === null) return false
    if (isNew) return !queuedInsert && initialNew !== null && !same(form, initialNew)
    if (server === null) return false
    return Object.keys(patchOf(server, form)).length > 0
  }, [form, isNew, initialNew, server, rosterName, queuedInsert])
  dirtyRef.current = dirty

  // 未保存の入力がある時は、画面を離れる・再読み込みする前に確認する（App の確認・beforeunload）
  useEffect(() => registerUnsaved(() => dirtyRef.current), [])

  /** 最新を読み直す（未保存の入力がある時は呼ばない） */
  const reload = useCallback(() => {
    loadRecord()
      .then((row) => {
        if (!aliveRef.current) return
        if (row === null) {
          setMsg({ tone: 'warn', text: MSG_DELETED_REMOTE })
          setNotFound(true)
          return
        }
        setServer(row)
        setForm(formOf(row))
        setRemoteChanged(false)
      })
      .catch(() => {
        // 読み直せなかっただけ。表示中の内容は残す
      })
  }, [loadRecord])

  // 送信待ちの件数の変化を画面に映す。減った時（送れた）は、この記録に未送信があった（その間は直せない）か、
  // 未保存の入力が無ければ読み直す（未送信の無い記録で入力中の時だけは、入力を消さないよう読み直さない）
  useEffect(() => {
    let last = -1
    return queueSubscribe((n) => {
      const prev = last
      last = n
      setQueueTick((t) => t + 1)
      if (prev >= 0 && n < prev && !isNew && (pendingRef.current || !dirtyRef.current)) reload()
    })
  }, [isNew, reload])

  // 他の端末の変更（この記録だけ）。未保存の入力が無ければ読み直し、あれば知らせるだけ（入力を消さない）
  useEffect(() => {
    if (isNew || recordId === null) return
    let timer: number | null = null
    const unsub = subscribeIncidentChanges((table, info) => {
      const row = info?.row ?? null
      if (row !== null && row.id !== recordId) return
      if (row !== null && isSelfWrite(table, row)) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (dirtyRef.current) setRemoteChanged(true)
        else reload()
      }, 400)
    })
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsub()
    }
  }, [isNew, recordId, reload])

  // 刷る中身を差し替えて描き終えてから刷る
  useEffect(() => {
    if (printSeq === 0) return
    const t = window.setTimeout(() => printRef.current?.print(), 0)
    return () => window.clearTimeout(t)
  }, [printSeq])

  const locked = gate === null || !gate.observed || gate.value !== true
  // queueTick は描き直しの合図（送信待ちは db.ts が持つ。読むだけ）
  const pendingNow = useMemo(() => {
    void queueTick
    return server !== null && hasPendingIncident(server.id)
  }, [server, queueTick])
  // 送れた時に読み直すかの判断に使う（この記録に未送信があったか）。送信待ちが減った時点で、まだ前の値を見られるよう描画の後に更新する
  useEffect(() => {
    pendingRef.current = pendingNow
  }, [pendingNow])
  const editable = !locked && !pendingNow && !queuedInsert && !busy && !notFound
  const reasonId = `${uid}-locked`

  const staffName = (id: number | null): string | null =>
    id === null ? null : ((staff ?? []).find((s) => s.id === id)?.name ?? null)

  const set = (patch: Partial<FormState>) => setForm((f) => (f === null ? f : { ...f, ...patch }))
  const setDetail = (patch: Partial<IncidentDetail>) =>
    setForm((f) => (f === null ? f : { ...f, detail: { ...f.detail, ...patch } }))

  /**
   * 保存する（extra は保存の時だけ重ねる値＝状態・確認・報告区分など）。
   * 新しい記録は追加、既存は変えた欄だけを rev 照合で送る。結果を画面に出し、保存した形を返す
   */
  async function save(extra: Partial<FormState> = {}, opts: { resyncName?: boolean } = {}): Promise<SaveOutcome> {
    if (form === null || !editable) return { status: 'failed' }
    if (operatorId === null) {
      setMsg({ tone: 'warn', text: MSG_NO_OPERATOR })
      return { status: 'failed' }
    }
    const next: FormState = { ...form, ...extra }
    const input = toInput(next)
    const check = validateIncidentInput(input, todayIso())
    if (!check.ok) {
      setMsg({ tone: 'danger', text: check.message })
      return { status: 'failed' }
    }
    setBusy(true)
    setMsg(null)
    try {
      if (isNew) {
        // 氏名は送らない（サーバーが名簿から写す＝送信待ちに氏名を置かない）
        const res = await insertIncident({ ...input, detail: { ...input.detail, subject_name: null } })
        touchActivity()
        if (!aliveRef.current) return { status: 'failed' }
        if (res === 'queued') {
          if (!isQueuePersisted()) {
            setMsg({ tone: 'danger', text: MSG_NOT_PERSISTED })
            return { status: 'failed' }
          }
          setForm(next)
          setQueuedInsert(true)
          setMsg({ tone: 'warn', text: MSG_INSERT_QUEUED })
          return { status: 'queued', form: next }
        }
        dirtyRef.current = false
        navigate(`/incident/${res.id}`, { replace: true, state: { saved: 'created' } })
        return { status: 'saved', form: formOf(res) }
      }
      if (server === null) return { status: 'failed' }
      const patch = patchOf(server, next)
      // 状態の変更（完了・対応中に戻す）は差分に頼らず必ず送る（手元の記録が古くても、押した操作をそのまま届ける）
      if (extra.status !== undefined) patch.status = extra.status
      // 「名簿の氏名に合わせる」: 氏名は送らず、写し直しの印だけを送る
      if (opts.resyncName === true) patch.resyncSubjectName = true
      if (Object.keys(patch).length === 0) return { status: 'saved', form: next }
      const res = await updateIncident(server, patch, { editedBy: operatorId })
      touchActivity()
      if (!aliveRef.current) return { status: 'failed' }
      if (res === 'conflict') {
        const latest = await loadRecord().catch(() => undefined)
        if (!aliveRef.current) return { status: 'failed' }
        if (latest === null) {
          setMsg({ tone: 'warn', text: MSG_DELETED_REMOTE })
          setNotFound(true)
        } else if (latest !== undefined) {
          setServer(latest)
          setForm(overlay(latest, patch))
          setRemoteChanged(false)
          setMsg({ tone: 'warn', text: MSG_CONFLICT })
        } else {
          setMsg({ tone: 'warn', text: MSG_CONFLICT })
        }
        return { status: 'failed' }
      }
      if (res === 'queued') {
        if (!isQueuePersisted()) {
          setMsg({ tone: 'danger', text: MSG_NOT_PERSISTED })
          return { status: 'failed' }
        }
        // 送った値を手元の基準にして未保存の差分を無くす（送れたら読み直す）
        const queuedBase = asQueued(server, next)
        pendingRef.current = true
        setServer(queuedBase)
        setForm(formOf(queuedBase))
        setQueueTick((t) => t + 1)
        setMsg({ tone: 'warn', text: MSG_QUEUED })
        return { status: 'queued', form: next }
      }
      setServer(res)
      const saved = formOf(res)
      setForm(saved)
      setRemoteChanged(false)
      show('保存しました。')
      return { status: 'saved', form: saved }
    } catch (e) {
      if (aliveRef.current) setMsg({ tone: 'danger', text: e instanceof DbError ? e.message : MSG_SAVE_FAILED })
      return { status: 'failed' }
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  async function remove() {
    setDeleteAsk(false)
    if (server === null || !editable) return
    if (operatorId === null) {
      setMsg({ tone: 'warn', text: MSG_NO_OPERATOR })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const res = await softDeleteIncident(server.id, server.rev, { editedBy: operatorId })
      touchActivity()
      if (!aliveRef.current) return
      if (res === 'conflict') {
        setMsg({ tone: 'warn', text: '他の端末が先にこの記録を変更しました。最新を確かめてから、もう一度取り消してください。' })
        if (!dirtyRef.current) reload()
        return
      }
      if (res === 'queued') {
        setMsg({
          tone: isQueuePersisted() ? 'warn' : 'danger',
          text: isQueuePersisted() ? '取り消しは未送信です（電波が戻ると自動で送信します）。' : MSG_NOT_PERSISTED,
        })
        setQueueTick((t) => t + 1)
        return
      }
      dirtyRef.current = false
      navigate('/incident', { replace: true })
    } catch (e) {
      if (aliveRef.current) setMsg({ tone: 'danger', text: e instanceof DbError ? e.message : MSG_SAVE_FAILED })
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  /** 印刷: 報告区分・提出日を保存してから刷る（直せない時は保存せずに刷る） */
  async function printWith(stage: IncidentReportStage, no: number | null, submitted: string | null) {
    setPrintOpen(false)
    if (form === null) return
    const extra: Partial<FormState> = { report_stage: stage, report_no: stage === 'nth' ? no : null, submitted_on: submitted }
    if (editable && server !== null) {
      const out = await save(extra)
      if (out.status === 'failed') return
      setPrintSource(out.form)
    } else {
      setPrintSource({ ...form, ...extra })
      setMsg({
        tone: 'info',
        text: '報告区分・提出日は保存せずに印刷しました（' + (locked ? 'まだ使い始めていないため' : '未送信の変更があるため') + '）。',
      })
    }
    setPrintSeq((n) => n + 1)
  }

  // ── 3状態: エラー → ローディング → 本体 ──
  if (baseError !== null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <ErrorBlock message={baseError} onRetry={() => setBaseTick((n) => n + 1)} />
      </div>
    )
  }
  if (notFound && server === null) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
        <EmptyBlock message={msg?.text ?? ERR_NOT_FOUND} />
        <Link to="/incident" className="inline-flex min-h-tap items-center text-link">
          事故・ヒヤリハットの一覧へ<span aria-hidden="true"> ›</span>
        </Link>
      </div>
    )
  }
  if (residents === null || staff === null || gate === null || form === null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <LoadingBlock label="事故・ヒヤリハットの画面を準備しています…" />
      </div>
    )
  }

  const f = form
  const d = f.detail
  const nearmiss = f.kind === 'nearmiss'
  const hint = cityReportHint(f.kind, f.severity, f.types)
  const resident = f.resident_id === null ? null : (residentById.get(f.resident_id) ?? null)
  const operatorName = staffName(operatorId)
  const pickerResidents = residents.filter((r) => r.active || r.id === f.resident_id)
  const open = isNew ? false : true
  /** 3 対象者の氏名の表示。記録と同じ対象者なら記録の写し、選び直した直後（保存前）・新しい記録は名簿の氏名 */
  const roster = rosterName(f.resident_id)
  const sameSubject = server !== null && f.resident_id === server.resident_id
  const snapshotName = sameSubject ? server.detail.subject_name : null
  const shownName =
    f.resident_id === null ? '（対象者なし）' : (snapshotName ?? roster ?? `利用者番号 ${f.resident_id}`)
  /** 名簿の氏名と写しが違う（名簿の氏名が変わった）時だけ「名簿の氏名に合わせる」を出す */
  const nameMismatch = sameSubject && snapshotName !== null && roster !== null && snapshotName !== roster
  /** 確認者（選び直した職員 → 記録の確認者 → 施設長 app_settings.manager_staff_id の順） */
  const confirmer = confirmPick ?? f.confirmer_id ?? managerId
  const subjectForPrint = printSource === null ? null : (printSource.detail.subject_name ?? rosterName(printSource.resident_id))

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      {!gate.observed ? (
        <ErrorBlock message={ERR_GATE} onRetry={() => setBaseTick((n) => n + 1)} />
      ) : locked ? (
        <div id={reasonId} role="status" className="rounded-lg border border-warn bg-warn-bg p-4">
          <p className="text-base text-ink">
            <span aria-hidden="true">▲ </span>
            <span className="sr-only">お知らせ: </span>
            {kindBlockedMessage('incident')}
          </p>
          <p className="mt-2 text-base text-ink2">記録の閲覧・印刷はこのままできます。</p>
        </div>
      ) : null}

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-lg font-bold text-ink">
          {isNew ? '事故・ヒヤリハットを記録する' : `${f.kind !== null ? INCIDENT_KIND_LABEL[f.kind] : ''}の記録`}
          {!isNew ? (
            <span className={`ml-2 text-base ${f.status === 'open' ? 'text-warn' : 'text-ink2'}`}>
              （{f.status === 'open' ? '▲ ' : '✓ '}
              {INCIDENT_STATUS_LABEL[f.status]}）
            </span>
          ) : null}
        </h2>
        <div className="mt-2 flex flex-wrap items-end gap-gap">
          <div className="min-w-0">
            <span className="block text-sm text-ink2">記入者（この画面で保存する職員）</span>
            <button
              type="button"
              onClick={() => setStaffPicker('operator')}
              className="mt-1 flex min-h-tap items-center gap-gap rounded border border-border bg-surface px-3 text-left text-base text-ink"
            >
              <span className={operatorName === null ? 'text-ink3' : 'font-bold'}>{operatorName ?? '選んでください'}</span>
              <span className="text-sm text-link">変更</span>
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              if (dirtyRef.current) setLeaveAsk(true)
              else navigate('/incident')
            }}
            className="inline-flex min-h-tap items-center text-link"
          >
            一覧へ<span aria-hidden="true"> ›</span>
          </button>
        </div>
        {pendingNow ? (
          <p role="status" className="mt-2 rounded border border-warn bg-warn-bg px-3 py-2 text-sm text-ink">
            <span aria-hidden="true">▲ </span>
            {MSG_PENDING}
          </p>
        ) : null}
        {remoteChanged ? (
          <p role="status" className="mt-2 rounded border border-warn bg-warn-bg px-3 py-2 text-sm text-ink">
            <span aria-hidden="true">▲ </span>
            {MSG_REMOTE}
          </p>
        ) : null}
      </section>

      <fieldset disabled={!editable} aria-describedby={locked && gate.observed ? reasonId : undefined} className="min-w-0 space-y-4">
        <legend className="sr-only">事故・ヒヤリハットの入力</legend>

        {/* ── 第1報（ここだけで保存できる） ── */}
        <Section title="第1報（ここだけで保存できます）" defaultOpen>
          <RadioGroup
            name={`${uid}-kind`}
            legend="区分"
            required
            options={INCIDENT_KINDS}
            labels={INCIDENT_KIND_LABEL}
            value={f.kind}
            onChange={(v) => set({ kind: v })}
          />
          <div className="flex flex-wrap items-end gap-gap">
            <DateField id={`${uid}-on`} label="発生日" required value={f.occurred_on} max={todayIso()} onChange={(v) => set({ occurred_on: v ?? f.occurred_on })} />
            <div className="min-w-0">
              <label htmlFor={`${uid}-time`} className="block text-sm text-ink2">
                発生時刻<span className="text-danger">（必須）</span>（24時間表記）
              </label>
              <input
                id={`${uid}-time`}
                type="time"
                step={60}
                value={f.time}
                onChange={(e) => set({ time: e.target.value })}
                className="tabular mt-1 min-h-tap rounded border border-border bg-surface px-3 text-base text-ink"
              />
            </div>
          </div>
          <RadioGroup
            name={`${uid}-place`}
            legend="発生場所"
            required
            options={INCIDENT_PLACES}
            labels={INCIDENT_PLACE_LABEL}
            value={f.place}
            onChange={(v) => set({ place: v })}
          />
          {f.place === 'other' ? (
            <TextField id={`${uid}-place-other`} label="発生場所（その他の内容）" required value={f.place_other} onChange={(v) => set({ place_other: v })} />
          ) : null}
          <CheckGroup
            legend="事故の種別（複数選択可）"
            required
            options={INCIDENT_TYPES}
            labels={INCIDENT_TYPE_LABEL}
            values={f.types}
            onChange={(v) => set({ types: v })}
          />
          {f.types.includes('other') ? (
            <TextField id={`${uid}-type-other`} label="種別（その他の内容）" required value={d.type_other} onChange={(v) => setDetail({ type_other: v })} />
          ) : null}
          <div>
            <span className="block text-sm text-ink2">
              対象者{f.kind === 'accident' ? <span className="text-danger">（事故は必須）</span> : '（ヒヤリハットは対象者なしも可）'}
            </span>
            <div className="mt-1 flex flex-wrap items-center gap-gap">
              <button
                type="button"
                onClick={() => setResidentPickerOpen(true)}
                className="flex min-h-tap items-center gap-gap rounded border border-border bg-surface px-3 text-left text-base text-ink"
              >
                <span className={resident === null ? 'text-ink3' : 'font-bold'}>
                  {resident === null
                    ? f.resident_id === null
                      ? '選んでください'
                      : `利用者番号 ${f.resident_id}`
                    : `${resident.room ?? '—'}　${resident.name}${resident.active ? '' : '（退居）'}`}
                </span>
                <span className="text-sm text-link">選ぶ</span>
              </button>
              {f.resident_id !== null && f.kind !== 'accident' ? (
                <button
                  type="button"
                  onClick={() => setForm((cur) => (cur === null ? cur : withResident(cur, null)))}
                  className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink"
                >
                  対象者なしにする
                </button>
              ) : null}
            </div>
          </div>
          <TextArea id={`${uid}-situation`} label="発生時状況、事故内容の詳細" required value={d.situation} onChange={(v) => setDetail({ situation: v })} rows={4} />
          <TextArea id={`${uid}-response`} label="発生時の対応" required value={d.response} onChange={(v) => setDetail({ response: v })} rows={3} />
          <div>
            <span className="block text-sm text-ink2">
              記録者<span className="text-danger">（必須）</span>
            </span>
            <button
              type="button"
              onClick={() => setStaffPicker('reporter')}
              className="mt-1 flex min-h-tap items-center gap-gap rounded border border-border bg-surface px-3 text-left text-base text-ink"
            >
              <span className={f.reporter_id === null ? 'text-ink3' : 'font-bold'}>{staffName(f.reporter_id) ?? '選んでください'}</span>
              <span className="text-sm text-link">変更</span>
            </button>
          </div>
        </Section>

        {/* ── 市への報告の案内 ── */}
        <div className="rounded-lg border border-border bg-surface p-4">
          {hint ? (
            <p role="status" className="rounded border border-danger bg-danger-bg px-3 py-2 text-base text-ink">
              <span aria-hidden="true">▲ </span>
              <span className="font-bold">市への報告が必要な可能性</span>
              <span className="mt-1 block text-sm">{CITY_REPORT_HINT}</span>
            </p>
          ) : null}
          <p className="mt-2 text-sm text-ink2">
            <span aria-hidden="true">ⓘ </span>
            {CITY_REPORT_DEADLINE_NOTE}
          </p>
          <label className="mt-2 flex min-h-tap items-center gap-2 text-base text-ink">
            <input
              type="checkbox"
              checked={f.city_report_needed}
              onChange={(e) => set({ city_report_needed: e.target.checked })}
              className="h-5 w-5 accent-primary"
            />
            市への報告が必要（判断して印を付ける）
          </label>
          {f.city_report_needed || f.city_reported_on !== null ? (
            <DateField id={`${uid}-city-on`} label="市へ報告した日" value={f.city_reported_on} max={todayIso()} onChange={(v) => set({ city_reported_on: v })} />
          ) : null}
        </div>

        {/* ── 1 事故状況 ── */}
        <Section title="1 事故状況" defaultOpen={open}>
          <RadioGroup
            name={`${uid}-severity`}
            legend="事故状況の程度"
            options={INCIDENT_SEVERITIES}
            labels={INCIDENT_SEVERITY_LABEL}
            value={f.severity}
            allowNone
            onChange={(v) => set({ severity: v })}
          />
          {f.severity === 'other' ? (
            <TextField id={`${uid}-sev-other`} label="程度（その他の内容）" required value={d.severity_other} onChange={(v) => setDetail({ severity_other: v })} />
          ) : null}
          <DateField id={`${uid}-death`} label="死亡に至った場合 死亡年月日" value={d.death_on} max={todayIso()} onChange={(v) => setDetail({ death_on: v })} />
        </Section>

        {/* ── 2 事業所の概要 ── */}
        <Section title="2 事業所の概要" defaultOpen={open}>
          <RadioGroup
            name={`${uid}-office`}
            legend="サービス種別"
            options={INCIDENT_OFFICES}
            labels={INCIDENT_OFFICE_LABEL}
            value={f.office}
            allowNone
            onChange={(v) => set({ office: v })}
          />
          <dl className="grid grid-cols-1 gap-1 text-sm text-ink">
            <ProfileItem label="法人名" value={profile?.corpName ?? null} />
            <ProfileItem label="事業所（施設）名" value={f.office !== null && profile !== null ? profile.officeName[f.office] : null} />
            <ProfileItem label="事業所番号" value={f.office !== null && profile !== null ? profile.officeNo[f.office] : null} />
            <ProfileItem label="所在地" value={profile?.address ?? null} />
          </dl>
          <p className="text-sm text-ink2">
            <span aria-hidden="true">ⓘ </span>
            {profileError
              ? '事業所の情報を読み込めませんでした（印刷ではこれらの欄が空欄になります）。'
              : '法人名・事業所名・事業所番号・所在地は設定の値を刷ります（未設定の欄は手書き用の空欄で刷ります）。'}
          </p>
        </Section>

        {/* ── 3 対象者 ── */}
        <Section title="3 対象者" defaultOpen={open}>
          {/* 氏名は名簿の値だけ（直せない）。保存するとサーバーが記録時点の氏名を写して残す。
              対象者を選び直した直後（保存前）は、選び直した方の名簿の氏名を出す */}
          <div>
            <span className="block text-sm text-ink2">氏名（記録した時点の名簿の氏名）</span>
            <p className="mt-1 min-h-tap rounded border border-border bg-surface2 px-3 py-2 text-base text-ink">{shownName}</p>
            <p className="mt-1 text-sm text-ink2">
              <span aria-hidden="true">ⓘ </span>
              ここでは書き換えられません。名簿の氏名が変わって写しと違う時だけ、「名簿の氏名に合わせる」で写し直せます。
            </p>
            {nameMismatch ? (
              <div className="mt-2 flex flex-wrap items-center gap-gap">
                <p className="text-sm text-warn">
                  <span aria-hidden="true">▲ </span>名簿の氏名（{roster}）と違います。
                </p>
                <button
                  type="button"
                  onClick={() => void save({}, { resyncName: true })}
                  className="min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
                >
                  名簿の氏名に合わせる
                </button>
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-end gap-gap">
            <div className="min-w-0">
              <label htmlFor={`${uid}-age`} className="block text-sm text-ink2">
                年齢（歳）
              </label>
              <input
                id={`${uid}-age`}
                type="number"
                inputMode="numeric"
                min={0}
                max={130}
                value={d.subject_age ?? ''}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  const n = v === '' ? null : Number(v)
                  setDetail({ subject_age: n === null || Number.isNaN(n) ? null : n })
                }}
                className="tabular mt-1 min-h-tap w-24 rounded border border-border bg-surface px-3 text-base text-ink"
              />
            </div>
            <DateField id={`${uid}-start`} label="サービス提供開始日" value={d.service_start_on} max={todayIso()} onChange={(v) => setDetail({ service_start_on: v })} />
          </div>
          <RadioGroup
            name={`${uid}-gender`}
            legend="性別"
            options={INCIDENT_GENDERS}
            labels={INCIDENT_GENDER_LABEL}
            value={d.subject_gender}
            allowNone
            onChange={(v) => setDetail({ subject_gender: v })}
          />
          <TextField id={`${uid}-insurer`} label="保険者" value={d.insurer} onChange={(v) => setDetail({ insurer: v })} />
          <RadioGroup
            name={`${uid}-address`}
            legend="住所"
            options={INCIDENT_ADDRESS_KINDS}
            labels={INCIDENT_ADDRESS_KIND_LABEL}
            value={d.address_kind}
            allowNone
            onChange={(v) => setDetail({ address_kind: v })}
          />
          {d.address_kind === 'other' ? (
            <TextField id={`${uid}-address-other`} label="住所（その他の内容）" required value={d.address_other} onChange={(v) => setDetail({ address_other: v })} />
          ) : null}
          <RadioGroup
            name={`${uid}-care`}
            legend="身体状況 要介護度"
            options={INCIDENT_CARE_LEVELS}
            labels={INCIDENT_CARE_LEVEL_LABEL}
            value={d.care_level}
            allowNone
            onChange={(v) => setDetail({ care_level: v })}
          />
          <RadioGroup
            name={`${uid}-dementia`}
            legend="認知症高齢者日常生活自立度"
            options={INCIDENT_DEMENTIA_LEVELS}
            labels={INCIDENT_DEMENTIA_LEVEL_LABEL}
            value={d.dementia_level}
            allowNone
            onChange={(v) => setDetail({ dementia_level: v })}
          />
        </Section>

        {/* ── 4 事故の概要（発生日時・場所・種別・発生時状況は第1報の節） ── */}
        <Section title="4 事故の概要" defaultOpen={open}>
          <p className="text-sm text-ink2">発生日時・発生場所・事故の種別・発生時状況は、上の「第1報」の節にあります。</p>
          <TextArea id={`${uid}-special`} label="その他特記すべき事項" value={d.special_notes} onChange={(v) => setDetail({ special_notes: v })} />
        </Section>

        {/* ── 5 事故発生時の対応（発生時の対応は第1報の節） ── */}
        <Section title="5 事故発生時の対応" defaultOpen={open}>
          <p className="text-sm text-ink2">発生時の対応は、上の「第1報」の節にあります。</p>
          {nearmiss ? (
            <p className="text-sm text-ink2">ヒヤリハットでは受診・診断の欄を隠しています（区分を事故にすると出ます）。</p>
          ) : (
            <>
              <CheckGroup
                legend="受診方法（複数選択可）"
                options={INCIDENT_VISIT_METHODS}
                labels={INCIDENT_VISIT_METHOD_LABEL}
                values={d.visit_methods}
                onChange={(v) => setDetail({ visit_methods: v })}
              />
              {d.visit_methods.includes('other') ? (
                <TextField id={`${uid}-visit-other`} label="受診方法（その他の内容）" required value={d.visit_method_other} onChange={(v) => setDetail({ visit_method_other: v })} />
              ) : null}
              <TextField id={`${uid}-hospital`} label="受診先 医療機関名" value={d.hospital_name} onChange={(v) => setDetail({ hospital_name: v })} />
              <TextField id={`${uid}-phone`} label="受診先 連絡先（電話番号）" value={d.hospital_phone} onChange={(v) => setDetail({ hospital_phone: v })} inputMode="tel" />
              <TextField id={`${uid}-diag`} label="診断名" value={d.diagnosis_name} onChange={(v) => setDetail({ diagnosis_name: v })} />
              <CheckGroup
                legend="診断内容（複数選択可）"
                options={INCIDENT_DIAGNOSIS_KINDS}
                labels={INCIDENT_DIAGNOSIS_KIND_LABEL}
                values={d.diagnosis_kinds}
                onChange={(v) => setDetail({ diagnosis_kinds: v })}
              />
              {d.diagnosis_kinds.includes('fracture') ? (
                <TextField id={`${uid}-fracture`} label="骨折の部位" value={d.fracture_site} onChange={(v) => setDetail({ fracture_site: v })} />
              ) : null}
              {d.diagnosis_kinds.includes('other') ? (
                <TextField id={`${uid}-diag-other`} label="診断内容（その他の内容）" required value={d.diagnosis_other} onChange={(v) => setDetail({ diagnosis_other: v })} />
              ) : null}
              <TextArea id={`${uid}-treat`} label="検査、処置等の概要" value={d.treatment} onChange={(v) => setDetail({ treatment: v })} />
            </>
          )}
        </Section>

        {/* ── 6 事故発生後の状況 ── */}
        <Section title="6 事故発生後の状況" defaultOpen={open}>
          <TextArea id={`${uid}-after`} label="利用者の状況" value={d.after_status} onChange={(v) => setDetail({ after_status: v })} />
          {nearmiss ? (
            <p className="text-sm text-ink2">ヒヤリハットでは家族等への報告・関係機関の欄を隠しています（区分を事故にすると出ます）。</p>
          ) : (
            <>
              <CheckGroup
                legend="家族等への報告 報告した家族等の続柄（複数選択可）"
                options={INCIDENT_FAMILY_RELATIONS}
                labels={INCIDENT_FAMILY_RELATION_LABEL}
                values={d.family_relations}
                onChange={(v) => setDetail({ family_relations: v })}
              />
              {d.family_relations.includes('other') ? (
                <TextField id={`${uid}-rel-other`} label="続柄（その他の内容）" required value={d.family_relation_other} onChange={(v) => setDetail({ family_relation_other: v })} />
              ) : null}
              <DateField id={`${uid}-fam-on`} label="家族等への報告年月日" value={d.family_reported_on} max={todayIso()} onChange={(v) => setDetail({ family_reported_on: v })} />
              <fieldset className="min-w-0">
                <legend className="text-sm text-ink2">連絡した関係機関（連絡した場合のみ）</legend>
                <div className="mt-1 space-y-2">
                  <AgencyRow
                    id={`${uid}-ag-city`}
                    label="他の自治体"
                    nameLabel="自治体名"
                    on={d.agency_municipality}
                    name={d.agency_municipality_name}
                    onToggle={(v) => setDetail({ agency_municipality: v })}
                    onName={(v) => setDetail({ agency_municipality_name: v })}
                  />
                  <AgencyRow
                    id={`${uid}-ag-police`}
                    label="警察"
                    nameLabel="警察署名"
                    on={d.agency_police}
                    name={d.agency_police_name}
                    onToggle={(v) => setDetail({ agency_police: v })}
                    onName={(v) => setDetail({ agency_police_name: v })}
                  />
                  <AgencyRow
                    id={`${uid}-ag-other`}
                    label="その他"
                    nameLabel="名称"
                    required
                    on={d.agency_other}
                    name={d.agency_other_name}
                    onToggle={(v) => setDetail({ agency_other: v })}
                    onName={(v) => setDetail({ agency_other_name: v })}
                  />
                </div>
              </fieldset>
            </>
          )}
          <TextArea id={`${uid}-followup`} label="本人、家族、関係先等への追加対応予定" value={d.followup} onChange={(v) => setDetail({ followup: v })} />
        </Section>

        {/* ── 7〜9 ── */}
        <Section title="7〜9 原因分析・再発防止策・その他" defaultOpen={open}>
          <TextArea id={`${uid}-cause`} label="7 事故の原因分析（本人要因、職員要因、環境要因の分析）" value={d.cause} onChange={(v) => setDetail({ cause: v })} rows={4} />
          <TextArea
            id={`${uid}-prev`}
            label="8 再発防止策（手順変更、環境変更、その他の対応、再発防止策の評価時期および結果等）"
            value={d.prevention}
            onChange={(v) => setDetail({ prevention: v })}
            rows={4}
          />
          <TextArea id={`${uid}-other`} label="9 その他特記すべき事項" value={d.other_notes} onChange={(v) => setDetail({ other_notes: v })} />
        </Section>

        {msg !== null ? <MessageLine msg={msg} /> : null}

        <div className="flex flex-wrap gap-gap">
          <button
            type="button"
            onClick={() => void save()}
            className="min-h-tap rounded border border-primary bg-primary px-6 text-base font-bold text-primary-ink disabled:opacity-60"
          >
            {busy ? '保存しています…' : isNew ? '保存する（第1報）' : '保存する'}
          </button>
          {!isNew && dirty ? <span className="self-center text-sm text-warn">▲ 未保存の変更があります</span> : null}
        </div>
      </fieldset>

      {/* 画面を直せない時（封鎖・未送信）でも、状態の案内と印刷は出す */}
      {!editable && msg !== null ? <MessageLine msg={msg} /> : null}
      {queuedInsert ? (
        <p className="text-sm">
          <Link to="/incident" className="inline-flex min-h-tap items-center font-bold text-link">
            事故・ヒヤリハットの一覧へ<span aria-hidden="true"> ›</span>
          </Link>
        </p>
      ) : null}

      {!isNew && server !== null ? (
        <section className="space-y-4 rounded-lg border border-border bg-surface p-4" aria-label="確認・状態・印刷">
          <div>
            <h3 className="text-base font-bold text-ink">確認者</h3>
            {f.confirmed_at !== null ? (
              <p className="mt-1 text-base text-ink">
                <span aria-hidden="true">✓ </span>確認済み: {staffName(f.confirmer_id) ?? '—'}　{fmtStamp(f.confirmed_at)}
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink2">まだ確認されていません。</p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-gap">
              <button
                type="button"
                disabled={!editable}
                onClick={() => setStaffPicker('confirmer')}
                className="flex min-h-tap items-center gap-gap rounded border border-border bg-surface px-3 text-left text-base text-ink disabled:text-ink3"
              >
                <span className={confirmer === null ? 'text-ink3' : 'font-bold'}>{staffName(confirmer) ?? '確認者を選ぶ'}</span>
                <span className="text-sm text-link">変更</span>
              </button>
              <button
                type="button"
                disabled={!editable || confirmer === null}
                onClick={() => void save({ confirmer_id: confirmer, confirmed_at: new Date().toISOString() })}
                className="min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
              >
                確認しました
              </button>
            </div>
            <p className="mt-1 text-sm text-ink2">
              <span aria-hidden="true">ⓘ </span>
              {MSG_CONFIRM_NOTE}
            </p>
          </div>

          <div>
            <h3 className="text-base font-bold text-ink">状態</h3>
            <p className="mt-1 text-base text-ink">
              {f.status === 'open' ? '▲ ' : '✓ '}
              {INCIDENT_STATUS_LABEL[f.status]}
              {f.status === 'closed' && f.closed_at !== null ? `（${fmtStamp(f.closed_at)} に完了）` : ''}
            </p>
            {f.status === 'open' ? (
              <button
                type="button"
                disabled={!editable}
                onClick={() => {
                  const missing = missingForClose(f.detail)
                  if (missing.length > 0) setCloseAsk(missing)
                  else void save({ status: 'closed' })
                }}
                className="mt-2 min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
              >
                完了にする
              </button>
            ) : (
              <button
                type="button"
                disabled={!editable}
                onClick={() => setReopenAsk(true)}
                className="mt-2 min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink disabled:border-border disabled:text-ink3"
              >
                対応中に戻す
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-gap">
            <button
              type="button"
              onClick={() => setPrintOpen(true)}
              disabled={busy}
              className="min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
            >
              事故報告書を印刷
            </button>
            <button
              type="button"
              disabled={!editable}
              onClick={() => setDeleteAsk(true)}
              className="min-h-tap rounded border border-danger bg-surface px-4 text-base text-danger disabled:border-border disabled:text-ink3"
            >
              <span aria-hidden="true">▲ </span>この記録を取り消す
            </button>
          </div>
        </section>
      ) : null}

      <StaffPickerModal
        open={staffPicker !== null}
        staff={staff.filter((s) => s.active)}
        title={staffPicker === 'operator' ? '記入者を選ぶ' : staffPicker === 'reporter' ? '記録者を選ぶ' : '確認者を選ぶ'}
        onPick={(id) => {
          if (staffPicker === 'operator') setOperatorId(id)
          else if (staffPicker === 'reporter') set({ reporter_id: id })
          else if (staffPicker === 'confirmer') setConfirmPick(id)
          setStaffPicker(null)
          touchActivity()
        }}
        onClose={() => setStaffPicker(null)}
      />

      <ResidentPickerModal
        open={residentPickerOpen}
        residents={pickerResidents}
        onPick={(id) => {
          setResidentPickerOpen(false)
          if (id !== null) setForm((cur) => (cur === null ? cur : withResident(cur, residentById.get(id) ?? null)))
        }}
        onClose={() => setResidentPickerOpen(false)}
      />

      <ConfirmDialog
        open={closeAsk !== null}
        title="完了にしますか"
        body={closeAsk === null ? undefined : `${closeAsk.join('・')}がまだ空です。このまま完了にしてよいですか（後から追記はできます）。`}
        confirmLabel="完了にする"
        onConfirm={() => {
          setCloseAsk(null)
          void save({ status: 'closed' })
        }}
        onCancel={() => setCloseAsk(null)}
      />

      <ConfirmDialog
        open={reopenAsk}
        title="対応中に戻しますか"
        body="この記録の状態を「完了」から「対応中」に戻します。一覧・委員会の集計で未完了として数えます。"
        confirmLabel="対応中に戻す"
        onConfirm={() => {
          setReopenAsk(false)
          void save({ status: 'open' })
        }}
        onCancel={() => setReopenAsk(false)}
      />

      <ConfirmDialog
        open={deleteAsk}
        title="この記録を取り消しますか"
        body={
          operatorName === null
            ? '先に上の「記入者」を選んでください（誰が取り消したかを残します）。'
            : `${fmtDayLabel(f.occurred_on)}の${f.kind !== null ? INCIDENT_KIND_LABEL[f.kind] : ''}の記録を取り消します（記入者: ${operatorName}）。取り消した記録は変更の記録に残ります。`
        }
        confirmLabel="取り消す"
        danger
        onConfirm={() => void remove()}
        onCancel={() => setDeleteAsk(false)}
      />

      <ConfirmDialog
        open={leaveAsk}
        title={LEAVE_TITLE}
        body={LEAVE_BODY}
        confirmLabel="移動する"
        danger
        onConfirm={() => {
          setLeaveAsk(false)
          dirtyRef.current = false
          navigate('/incident')
        }}
        onCancel={() => setLeaveAsk(false)}
      />

      <PrintDialog
        open={printOpen}
        stage={f.report_stage ?? 'first'}
        no={f.report_no}
        submitted={f.submitted_on ?? todayIso()}
        willSave={editable}
        onCancel={() => setPrintOpen(false)}
        onPrint={(stage, no, submitted) => void printWith(stage, no, submitted)}
      />

      {/* 紙に出す中身（画面には出ない）。A4 縦・1枚に収める（はみ出す時は2枚目へ・見出しを繰り返す） */}
      <PrintArea ref={printRef} orientation="portrait" maxFontPx={11} minFontPx={9}>
        {printSource !== null ? <IncidentReportSheet v={toInput(printSource)} subjectName={subjectForPrint} profile={profile} /> : null}
      </PrintArea>

      {toast}
    </div>
  )
}

export default IncidentFormPage

// ══════════════════════════════════════════════════════════════
// 部品
// ══════════════════════════════════════════════════════════════

/** '2026-09-20T01:30:00Z' → '9/20（日） 10:30'（端末の時刻） */
function fmtStamp(iso: string): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const day = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  return `${fmtDayLabel(day)} ${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`
}

function MessageLine({ msg }: { msg: Msg }) {
  return (
    <p
      role={msg.tone === 'danger' ? 'alert' : 'status'}
      className={`rounded border px-3 py-2 text-sm ${
        msg.tone === 'danger' ? 'border-danger bg-danger-bg text-danger' : msg.tone === 'warn' ? 'border-warn bg-warn-bg text-ink' : 'border-border text-ink2'
      }`}
    >
      {msg.tone !== 'info' ? <span aria-hidden="true">▲ </span> : <span aria-hidden="true">ⓘ </span>}
      {msg.text}
    </p>
  )
}

/** 開閉できる節（開いているかは保存しない） */
function Section({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="rounded-lg border border-border bg-surface">
      <summary className="flex min-h-tap cursor-pointer items-center px-4 text-lg font-bold text-ink">{title}</summary>
      <div className="space-y-4 border-t border-border p-4">{children}</div>
    </details>
  )
}

function RequiredMark() {
  return <span className="text-danger">（必須）</span>
}

function TextField({
  id,
  label,
  value,
  onChange,
  required = false,
  disabled = false,
  inputMode,
}: {
  id: string
  label: string
  value: string | null
  onChange: (v: string | null) => void
  required?: boolean
  disabled?: boolean
  inputMode?: 'tel' | 'text'
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm text-ink2">
        {label}
        {required ? <RequiredMark /> : null}
      </label>
      <input
        id={id}
        type="text"
        value={value ?? ''}
        disabled={disabled}
        inputMode={inputMode}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="mt-1 min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink disabled:bg-surface2 disabled:text-ink2"
      />
    </div>
  )
}

function TextArea({
  id,
  label,
  value,
  onChange,
  required = false,
  rows = 3,
}: {
  id: string
  label: string
  value: string | null
  onChange: (v: string | null) => void
  required?: boolean
  rows?: number
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm text-ink2">
        {label}
        {required ? <RequiredMark /> : null}
      </label>
      <textarea
        id={id}
        value={value ?? ''}
        rows={rows}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-base text-ink"
      />
    </div>
  )
}

function DateField({
  id,
  label,
  value,
  onChange,
  max,
  required = false,
}: {
  id: string
  label: string
  value: string | null
  onChange: (v: string | null) => void
  max?: string
  required?: boolean
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm text-ink2">
        {label}
        {required ? <RequiredMark /> : null}
      </label>
      <input
        id={id}
        type="date"
        value={value ?? ''}
        max={max}
        onChange={(e) => {
          const v = e.target.value
          onChange(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
        }}
        className="tabular mt-1 min-h-tap max-w-full rounded border border-border bg-surface px-3 text-base text-ink"
      />
    </div>
  )
}

/** 1つだけ選ぶ（allowNone で「未選択」に戻せる）。選んだものは枠＋太字＋✓（色だけに頼らない） */
function RadioGroup<T extends string>({
  name,
  legend,
  options,
  labels,
  value,
  onChange,
  allowNone = false,
  required = false,
}: {
  name: string
  legend: string
  options: readonly T[]
  labels: Record<T, string>
  value: T | null
  onChange: (v: T | null) => void
  allowNone?: boolean
  required?: boolean
}) {
  const item = (key: string, label: string, checked: boolean, pick: () => void) => (
    <label
      key={key}
      className={`flex min-h-tap items-center gap-2 rounded border px-3 text-base text-ink ${checked ? 'border-primary font-bold' : 'border-border'}`}
    >
      <input type="radio" name={name} checked={checked} onChange={pick} className="h-5 w-5 shrink-0 accent-primary" />
      {label}
    </label>
  )
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm text-ink2">
        {legend}
        {required ? <RequiredMark /> : null}
      </legend>
      <div className="mt-1 flex flex-wrap gap-gap">
        {options.map((o) => item(o, labels[o], value === o, () => onChange(o)))}
        {allowNone ? item('__none', '未選択', value === null, () => onChange(null)) : null}
      </div>
    </fieldset>
  )
}

/** 複数選ぶ（様式の並びにそろえて返す） */
function CheckGroup<T extends string>({
  legend,
  options,
  labels,
  values,
  onChange,
  required = false,
}: {
  legend: string
  options: readonly T[]
  labels: Record<T, string>
  values: readonly T[]
  onChange: (v: T[]) => void
  required?: boolean
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm text-ink2">
        {legend}
        {required ? <RequiredMark /> : null}
      </legend>
      <div className="mt-1 flex flex-wrap gap-gap">
        {options.map((o) => {
          const checked = values.includes(o)
          return (
            <label
              key={o}
              className={`flex min-h-tap items-center gap-2 rounded border px-3 text-base text-ink ${checked ? 'border-primary font-bold' : 'border-border'}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  const set = new Set<T>(values)
                  if (e.target.checked) set.add(o)
                  else set.delete(o)
                  onChange(options.filter((x) => set.has(x)))
                }}
                className="h-5 w-5 shrink-0 accent-primary"
              />
              {labels[o]}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

function AgencyRow({
  id,
  label,
  nameLabel,
  on,
  name,
  onToggle,
  onName,
  required = false,
}: {
  id: string
  label: string
  nameLabel: string
  on: boolean
  name: string | null
  onToggle: (v: boolean) => void
  onName: (v: string | null) => void
  required?: boolean
}) {
  return (
    <div className="flex flex-wrap items-end gap-gap">
      <label className={`flex min-h-tap items-center gap-2 rounded border px-3 text-base text-ink ${on ? 'border-primary font-bold' : 'border-border'}`}>
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} className="h-5 w-5 shrink-0 accent-primary" />
        {label}
      </label>
      {on ? (
        <div className="min-w-0 flex-1">
          <TextField id={id} label={nameLabel} required={required} value={name} onChange={onName} />
        </div>
      ) : null}
    </div>
  )
}

function ProfileItem({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-ink2">{label}:</dt>
      <dd className={value === null || value === '' ? 'text-ink3' : 'text-ink'}>{value === null || value === '' ? '（未設定・印刷は空欄）' : value}</dd>
    </div>
  )
}

/** 印刷の前に報告区分・提出日を選ぶ小窓 */
function PrintDialog({
  open,
  stage,
  no,
  submitted,
  willSave,
  onCancel,
  onPrint,
}: {
  open: boolean
  stage: IncidentReportStage
  no: number | null
  submitted: string
  willSave: boolean
  onCancel: () => void
  onPrint: (stage: IncidentReportStage, no: number | null, submitted: string | null) => void
}) {
  const uid = useId()
  const firstRef = useRef<HTMLInputElement>(null)
  const [st, setSt] = useState<IncidentReportStage>(stage)
  const [n, setN] = useState<string>(no === null ? '2' : String(no))
  const [day, setDay] = useState<string>(submitted)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSt(stage)
    setN(no === null ? '2' : String(no))
    setDay(submitted)
    setErr(null)
  }, [open, stage, no, submitted])

  return (
    <ModalShell open={open} label="事故報告書を印刷" onClose={onCancel} initialFocus={firstRef}>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <h2 className="text-lg font-bold text-ink">事故報告書を印刷</h2>
        <fieldset className="min-w-0">
          <legend className="text-sm text-ink2">報告区分</legend>
          <div className="mt-1 flex flex-wrap gap-gap">
            {INCIDENT_REPORT_STAGES.map((s, i) => (
              <label key={s} className={`flex min-h-tap items-center gap-2 rounded border px-3 text-base text-ink ${st === s ? 'border-primary font-bold' : 'border-border'}`}>
                <input
                  ref={i === 0 ? firstRef : undefined}
                  type="radio"
                  name={`${uid}-stage`}
                  checked={st === s}
                  onChange={() => setSt(s)}
                  className="h-5 w-5 shrink-0 accent-primary"
                />
                {INCIDENT_REPORT_STAGE_LABEL[s]}
              </label>
            ))}
          </div>
        </fieldset>
        {st === 'nth' ? (
          <div>
            <label htmlFor={`${uid}-no`} className="block text-sm text-ink2">
              第何報か（2 以上）
            </label>
            <input
              id={`${uid}-no`}
              type="number"
              inputMode="numeric"
              min={2}
              max={99}
              value={n}
              onChange={(e) => setN(e.target.value)}
              className="tabular mt-1 min-h-tap w-24 rounded border border-border bg-surface px-3 text-base text-ink"
            />
          </div>
        ) : null}
        <div>
          <label htmlFor={`${uid}-day`} className="block text-sm text-ink2">
            提出日
          </label>
          <input
            id={`${uid}-day`}
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="tabular mt-1 min-h-tap max-w-full rounded border border-border bg-surface px-3 text-base text-ink"
          />
        </div>
        <p className="text-sm text-ink2">
          <span aria-hidden="true">ⓘ </span>
          {willSave
            ? '報告区分・提出日を記録に保存してから印刷します（入力中の未保存の内容も一緒に保存します）。'
            : '報告区分・提出日は保存せずに印刷します。'}
          A4 縦で刷ります（はみ出す時は2枚目に続き、見出しを繰り返します）。
        </p>
        {err !== null ? (
          <p role="alert" className="text-sm text-danger">
            <span aria-hidden="true">▲ </span>
            {err}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-gap border-t border-border p-4">
        <button type="button" onClick={onCancel} className="min-h-tap rounded border border-border-strong px-4 text-base text-ink">
          キャンセル
        </button>
        <button
          type="button"
          onClick={() => {
            const num = st === 'nth' ? Number(n) : null
            if (st === 'nth' && (num === null || !Number.isInteger(num) || num < 2 || num > 99)) {
              setErr('「第＿報」の時は、2 以上の数を入れてください。')
              return
            }
            const sub = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
            onPrint(st, num, sub)
          }}
          className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
        >
          印刷する
        </button>
      </div>
    </ModalShell>
  )
}
