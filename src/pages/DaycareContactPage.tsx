// デイ（せせらぎ）段階4: 連絡帳の画面（/record/daycare/contact・業務日は ?day=）。2026-11-09 計画C。
// 入口は今日の画面の一番下の〔連絡帳〕だけ（上の切り替え DaycareNav には足さない＝iPad 横 1180px で1段に収めるため）。
//
// ・画面の上: 今日の画面への戻り・記録者／日付の段（今日の画面と同じ作り）／読めなかった項目の帯／全員共通の一文の欄（文字数・〔保存〕）／
//   〔全員を選ぶ〕〔来た方だけ〕〔選ぶのをやめる〕〔印刷する（n名）〕
// ・一覧: その日の方（今日の画面と同じ並び＝五十音・休み・入院中の方も出す）。印刷する方の既定は「来た方」（在席・帰宅）。
//   各方に〔印刷する〕の切り替え（44px）・紙面の見本（印刷と同じ部品を枠の幅に合わせて文字ごと縮める。送信待ちを重ねた方は
//   「送信待ちを含む」）・個別のひと言の欄・基準を外れたバイタルがある方だけ看護職のひと言の欄
// ・印刷の前の確かめの小窓（〔戻って書く〕〔このまま印刷する〕）に、選んだ方のうち次の方を並べる:
//   基準を外れたのに看護職のひと言が空の方（そのまま刷ると看護職の欄は載らない）・バイタルを読めず基準外かを確かめられない方・
//   読めなかった項目がある方（〔最新に更新〕をすすめる）・入浴が自動の記録のままの方・送信待ちの機能訓練がある方（紙は「記録なし」の
//   まま。送信が済んでから刷ると載る）・送れずに止まっているバイタルがある方（紙に載らない）・保存していない文がある方。
//   この端末に送信待ちがあれば件数も1行出す（入浴・水分の送信待ちは中身を重ねないので、届く前の記録は紙に載らないことがある）
//   紙に載るのは保存したひと言（見本も同じ）
// ・名簿が読めない（氏名を引けない方がいる）時は印刷を止めて理由を出す（「利用者ID 12 様」と刷らない）
// ・〔印刷する〕で印刷に送ったら、印刷した方の printed_at を書く（失敗しても印刷は止めない。Ctrl+P・⌘P では書かない）
// ・材料は今日の画面と同じ読み手（loadDaycareDayParts）＋機能訓練（fetchTrainingSessions）＋連絡帳の2表（0061）。新しい RPC は作らない。
//   2026-11-10 未測定: ＋〔未測定〕の印（0062・fetchDaycareVitalUnmeasured）。印のある値の無い欄は紙と見本に「未測定」（「記録なし」と分ける）
//   送信待ち（この端末で入れて、まだ届いていない記録）は今日の画面と同じ決まりで紙面に重ねる。
//   紙面の組み立ては src/lib/daycareContact.ts（純関数）・紙は src/components/print/DaycareContactSheet.tsx（A5・1人1枚）
//
// 規律:
// - 取得・保存は db.ts の関数のみ（supabase を直呼びしない）。書くのは連絡帳の2表の関数だけ（saveDaycareDayNote・
//   saveDaycareContactField・markDaycareContactPrinted）。変えた欄だけを送り、rev を照合する
// - 入れかけの文の保存の基準は、入れ始めた時の保存値（欄ごとに控える）。入れている間に他の端末がその欄を書き換えたら、
//   上書きせず欄の下に知らせる（〔最新に更新〕・送信待ちが届いた後の読み直し・印刷の後に行を差し替える時も同じ＝反証 中1）
// - 入力解禁は input_enabled_daycare（getKindInputGate('daycare')）。封鎖中は隠さずにディセーブル＋理由文（見本と印刷は使える）
// - 過去の日のひと言は事務所・管理者のログインだけ（現場は当日だけ＝0061 の守りと同じ条件。役割が分からない間は現場と同じ扱い）
// - 送信待ちは作らない（仮置き）。通信できない時は「保存できませんでした。…もう一度押してください。」と出し、入れた文は欄に残す
// - 日付は URL の ?day= で持つ（再読み込みでも同じ日に戻る＝原則11）。選んだ方・入れかけた文は端末に残さない（localStorage を使わない）
// - 氏名・記録を console に出さない。色だけで意味を伝えない（記号・文字を併記）。押す所は 44px 以上・間は 8px 以上。画面の文字は 15px 以上
//   （紙面の見本は紙の版面のとおり縮む）

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  DbError,
  FORBIDDEN_REASON,
  OUTDATED_REASON,
  cachedMyRole,
  fetchBathDay,
  fetchDaycareActivities,
  fetchDaycareAttendance,
  fetchDaycareContactNotes,
  fetchDaycareDay,
  fetchDaycareDayNote,
  fetchDaycareIntake,
  fetchDaycarePlan,
  fetchDaycareVitalUnmeasured,
  fetchDaycareVitalsLive,
  fetchMyRole,
  fetchResidentTargets,
  fetchTrainingSessions,
  getAppSetting,
  getKindInputGate,
  isContactMissingError,
  kindBlockedMessage,
  markDaycareContactPrinted,
  pendingActivityOps,
  pendingRow,
  pendingTrainingOps,
  queuePending,
  queueSubscribe,
  saveDaycareContactField,
  saveDaycareDayNote,
  subscribeMyRole,
} from '../lib/db'
import type { DaycareMealRow, MyRole } from '../lib/db'
import { fetchAllResidents } from '../lib/cachedReads'
import { loadDaycareDayParts } from '../lib/daycareDayLoad'
import type { DaycareDayReaders } from '../lib/daycareDayLoad'
import { buildDaycareBoard, canEditPastDaycareTimes } from '../lib/daycare'
import type { KeyedVital } from '../lib/daycare'
import type { DaycareActivity } from '../lib/daycareActivity'
import type { DaycareTrainingSession } from '../lib/daycareTraining'
import { daycareStateTone, unreadProgressLabels } from '../lib/daycareProgress'
import type { DaycareVitalUnmeasured } from '../lib/daycareProgress'
import { readPersonDay } from '../lib/daycarePerson'
import {
  CONTACT_BODY_MAX,
  CONTACT_NURSE_MAX,
  DAY_NOTE_MAX,
  autoBathPicked,
  buildContactSheet,
  contactNoteOf,
  contactPath,
  defaultPicked,
  draftAgainstSaved,
  noteLength,
  normalizeNoteText,
  nurseNoteMissing,
  trainingQueuedPicked,
  unreadPicked,
  vitalsStoppedPicked,
  vitalsUnreadPicked,
} from '../lib/daycareContact'
import type { ContactNoteField, ContactSheet, DaycareContactNote, DaycareDayNote } from '../lib/daycareContact'
import { useVitalLimits } from '../hooks/useVitalLimits'
import { VitalLimitsFailedNote } from '../components/VitalLimitsFailedNote'
import { RecorderBar } from '../components/RecorderBar'
import { ErrorBlock, LoadingBlock, ModalShell } from '../components/ui'
import { ContactSheetView, DaycareContactPrint } from '../components/print/DaycareContactSheet'
import type { DaycareContactPrintHandle } from '../components/print/DaycareContactSheet'
import { addDays, fmtDayLabel, todayIso } from '../lib/format'
import type { BathRecord, DaycareAttendance, DaycarePlanRow, DaycarePlanSource, FluidIntake, Resident, Staff } from '../lib/types'
import type { ResidentTargets } from '../lib/vitalAlerts'

// ── 文言（何が起きたか＋次にどうするか） ──
const ERR_LOAD = 'デイの記録を読み込めませんでした。通信状態を確認して、再試行してください。'
const MSG_GATE_UNKNOWN =
  'デイの記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。見本の確認と印刷はこのままできます。'
const MSG_MISSING = 'デイの記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。'
const MSG_CONTACT_MISSING = '連絡帳のひと言はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。記録の見本の確認と印刷はできます。'
const MSG_NOTES_UNREAD = '連絡帳のひと言を読み込めませんでした。〔最新に更新〕を押してください（読めるまで、ひと言の欄は押せません）。'
const MSG_PAST_OFFICE = '過去の日の連絡帳のひと言は、事務所のログインでだけ書けます（現場の端末は当日だけ）。見本の確認と印刷はできます。'
const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから保存してください。'
const MSG_FUTURE = '未来の日には書けません。'
const MSG_ROSTER_LOADING = '利用者の名簿を読み込んでいます。読み込めるまで印刷はできません（氏名を刷るため）。'
const MSG_ROSTER_FAILED = '利用者の名簿を読み込めないため、印刷できません（氏名を刷れません）。通信状態を確認して、〔最新に更新〕を押してください。'

/** 1日の画面のデータ（読み込みの単位） */
interface ContactData {
  day: string
  planRows: DaycarePlanRow[]
  planSource: DaycarePlanSource
  missing: boolean
  attendance: DaycareAttendance[]
  baths: BathRecord[]
  vitals: KeyedVital[]
  bathsOk: boolean
  vitalsOk: boolean
  meals: DaycareMealRow[]
  fluids: FluidIntake[]
  intakeOk: boolean
  activities: DaycareActivity[] | null
  training: DaycareTrainingSession[] | null
  /** 連絡帳の2表（0061） */
  dayNote: DaycareDayNote | null
  contacts: DaycareContactNote[]
  /** ひと言を読めたか（読めない時は欄を押せなくする） */
  notesOk: boolean
  /** 連絡帳の表が無い（0061 未適用） */
  notesMissing: boolean
  /** その日の〔未測定〕の印（2026-11-10・0062。紙と見本に「未測定」と出す）。null＝読めない（印なし＝今までどおり「記録なし」） */
  unmeasured: DaycareVitalUnmeasured[] | null
}

/** 1日の読み込みに使う読み取り（今日の画面と同じ db.ts の関数） */
const DAY_READERS: DaycareDayReaders = {
  day: fetchDaycareDay,
  plan: fetchDaycarePlan,
  attendance: fetchDaycareAttendance,
  baths: fetchBathDay,
  vitals: fetchDaycareVitalsLive,
  intake: fetchDaycareIntake,
  activities: fetchDaycareActivities,
  isServerMissing: (e) => e instanceof DbError && e.kind === 'server',
}

/** 欄の鍵（全員共通の一文は 'day'・1人の欄は '<利用者id>:<欄>'） */
type FieldKey = string
const fieldKeyOf = (residentId: number, field: ContactNoteField): FieldKey => `${residentId}:${field}`
const DAY_KEY: FieldKey = 'day'

/** 欄の下の知らせ */
type FieldMsg = { tone: 'ok' | 'warn' | 'danger'; text: string }

/** 入れ始めた時の保存の行と、その欄の値（保存の基準。入れている間に他の端末が書き換えたかを見分ける） */
type DraftBase = { row: DaycareDayNote | DaycareContactNote | null; value: string | null }

/** 印刷の前の確かめ（選んだ方のうち、並べる方） */
interface PrintCheck {
  nurse: number[]
  vitalsUnread: number[]
  unread: { residentId: number; labels: string[] }[]
  autoBath: number[]
  trainingQueued: number[]
  /** バイタルの送信待ちが競合・拒否で止まっている方（その値は紙に載らない） */
  vitalsStopped: number[]
  /** この端末の送信待ちの件数（queuePending。入浴・水分は中身を重ねないので、0 でなければ1行で知らせる） */
  queued: number
  unsaved: number[]
  dayUnsaved: boolean
}

const BTN = 'inline-flex min-h-tap items-center justify-center rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:border-border disabled:text-ink3'
const BTN_PRIMARY =
  'inline-flex min-h-tap items-center justify-center rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border disabled:bg-surface disabled:text-ink3'

export interface DaycareContactPageProps {
  /** App.tsx が持っている職員名簿（記録者の表示に使う） */
  staff?: Staff[] | null
  /** App.tsx の操作者（記録者） */
  actorId?: number | null
}

export function DaycareContactPage({ staff = undefined, actorId = null }: DaycareContactPageProps = {}) {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const [today, setToday] = useState(todayIso())
  const day = readPersonDay(search.get('day'), today)
  const [data, setData] = useState<ContactData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [residents, setResidents] = useState<Resident[]>([])
  /** 名簿の読み込み（読めない・読めていない間は印刷しない＝氏名の代わりに番号を刷らない） */
  const [roster, setRoster] = useState<'loading' | 'ok' | 'failed'>('loading')
  const [targets, setTargets] = useState<Map<number, ResidentTargets>>(new Map())
  const [officeName, setOfficeName] = useState('')
  // 個人のバイタルの閾値（基準を外れたかの判定はその方の基準が優先。読めない時は施設の基準・その旨を出す）
  const limits = useVitalLimits(reloadKey)
  const [gate, setGate] = useState<{ value: boolean; observed: boolean; forbidden?: true; outdated?: true } | null>(null)
  /** ログインの役割（過去の日のひと言は事務所・管理者だけ。分からない間は現場と同じ扱い） */
  const [role, setRole] = useState<MyRole | null | undefined>(cachedMyRole())
  /** 入れかけた文（欄ごと・画面のメモリだけ。日を切り替えたら空にする） */
  const [drafts, setDrafts] = useState<Record<FieldKey, string>>({})
  /** 入れ始めた時の保存値（欄ごと・保存の基準） */
  const [draftBase, setDraftBase] = useState<Record<FieldKey, DraftBase>>({})
  const [saving, setSaving] = useState<ReadonlySet<FieldKey>>(new Set())
  const [fieldMsg, setFieldMsg] = useState<Record<FieldKey, FieldMsg>>({})
  /** 印刷する方（null＝既定の「来た方」のまま） */
  const [picked, setPicked] = useState<ReadonlySet<number> | null>(null)
  const [confirm, setConfirm] = useState<PrintCheck | null>(null)
  const [printNote, setPrintNote] = useState<string | null>(null)
  /** 送信待ちの数が変わったら描き直す（紙面に重ねる送信待ちの値を取り直す） */
  const [queueTick, setQueueTick] = useState(0)
  const printRef = useRef<DaycareContactPrintHandle>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const genRef = useRef(0)
  const dayRef = useRef(day)
  dayRef.current = day

  // ── 時計（60秒ごと） ──
  useEffect(() => {
    const t = window.setInterval(() => setToday(todayIso()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  // ── ログインの役割（過去の日のひと言を書けるか） ──
  useEffect(() => {
    let alive = true
    const ask = () => {
      void fetchMyRole().then((r) => {
        if (alive) setRole(r)
      })
    }
    ask()
    const off = subscribeMyRole(ask)
    return () => {
      alive = false
      off()
    }
  }, [])

  // ── 入力解禁・名簿・個別の目標・事業所名（開くたび・〔最新に更新〕で取り直す） ──
  useEffect(() => {
    let alive = true
    setGate(null)
    getKindInputGate('daycare')
      .then((g) => alive && setGate(g))
      .catch(() => alive && setGate({ value: false, observed: false }))
    fetchAllResidents()
      .then((all) => {
        if (!alive) return
        setResidents(all)
        setRoster('ok')
      })
      .catch(() => {
        // 読めない時は印刷を止める（前に読めた名簿があればそれで続ける）
        if (alive) setRoster((prev) => (prev === 'ok' ? prev : 'failed'))
      })
    fetchResidentTargets()
      .then((tg) => alive && setTargets(tg))
      .catch(() => {})
    // 事業所名は施設情報（app_settings の office_name_daycare）から読む。画面に直書きしない（読めない・空は出さない）
    getAppSetting('office_name_daycare')
      .then((v) => alive && setOfficeName((v ?? '').trim()))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [reloadKey])

  // ── 1日の読み込み（世代つき。最新の世代 かつ 今の日付の応答だけを入れる） ──
  const load = useCallback(async (target: string, quiet: boolean) => {
    const gen = ++genRef.current
    if (!quiet) {
      setLoading(true)
      setError(null)
    }
    try {
      // 〔未測定〕の印（2026-11-10・0062）も同じ回で読む（1本）。読めない時は null（印なし）
      const [parts, training, notes, unmeasured] = await Promise.all([
        loadDaycareDayParts(target, DAY_READERS),
        fetchTrainingSessions(target).catch((): DaycareTrainingSession[] | null => null),
        Promise.all([fetchDaycareDayNote(target), fetchDaycareContactNotes(target)])
          .then(([dayNote, contacts]) => ({ dayNote, contacts, notesOk: true, notesMissing: false }))
          .catch((e: unknown) => ({ dayNote: null, contacts: [] as DaycareContactNote[], notesOk: false, notesMissing: isContactMissingError(e) })),
        fetchDaycareVitalUnmeasured(target)
          .then((r) => r.rows)
          .catch((): DaycareVitalUnmeasured[] | null => null),
      ])
      if (gen !== genRef.current || target !== dayRef.current) return
      const usable = parts.snapshot !== null && parts.snapshot.plan_source !== 'unknown'
      setData({
        day: target,
        planRows: usable && parts.snapshot !== null ? parts.snapshot.plan_rows : (parts.plan?.rows ?? []),
        planSource: usable && parts.snapshot !== null ? parts.snapshot.plan_source : (parts.plan?.source ?? 'unknown'),
        missing: parts.missing || parts.plan?.missing === true,
        attendance: parts.attendance,
        baths: parts.baths,
        vitals: parts.vitals,
        bathsOk: parts.bathsOk,
        vitalsOk: parts.vitalsOk,
        meals: parts.intake?.meals ?? [],
        fluids: parts.intake?.fluids ?? [],
        intakeOk: parts.intake !== null,
        activities: parts.activities,
        training,
        ...notes,
        unmeasured,
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
    // 日を切り替えたら、入れかけた文・知らせ・選んだ方を外す（ほかの日の文を次の日へ持ち越さない）
    setDrafts({})
    setDraftBase({})
    setFieldMsg({})
    setPicked(null)
    setPrintNote(null)
    void load(day, false)
  }, [day, load])
  // 〔最新に更新〕は入れかけた文を残したまま読み直す（その場限りの知らせだけ外す）
  useEffect(() => {
    if (reloadKey === 0) return
    setFieldMsg((prev) => Object.fromEntries(Object.entries(prev).filter(([, m]) => m.tone !== 'ok')))
    void load(dayRef.current, false)
  }, [reloadKey, load])

  // ── 送信待ち: 数が変われば紙面に重ねる値を取り直し、減った（届いた）時は静かに読み直す（今日の画面と同じ） ──
  const reloadTimer = useRef<number | null>(null)
  useEffect(() => {
    let last = queuePending()
    const off = queueSubscribe((n) => {
      setQueueTick((x) => x + 1)
      if (n < last) {
        if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
        reloadTimer.current = window.setTimeout(() => {
          reloadTimer.current = null
          void load(dayRef.current, true)
        }, 400)
      }
      last = n
    })
    return () => {
      off()
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    }
  }, [load])

  // ── 一覧と紙面 ──
  const board = useMemo(
    () =>
      data === null || data.day !== day
        ? null
        : buildDaycareBoard({ planRows: data.planRows, source: data.planSource, residents, attendance: data.attendance, extraIds: [] }),
    [data, day, residents],
  )
  const nameKnown = useCallback((id: number) => residents.some((r) => r.id === id), [residents])
  const nameOf = useCallback((id: number) => residents.find((r) => r.id === id)?.name ?? `利用者ID ${id}`, [residents])
  const sheets = useMemo<ContactSheet[]>(() => {
    if (data === null || board === null) return []
    // 送信待ち（この端末で入れて、まだ届いていない記録）を今日の画面と同じ決まりで重ねる（queueTick で取り直す）
    void queueTick
    const activityPending = data.activities === null ? [] : pendingActivityOps()
    const trainingPending = data.training === null ? [] : pendingTrainingOps()
    return board.rows.map((r) => {
      const id = r.residentId
      return buildContactSheet({
        residentId: id,
        day: data.day,
        name: nameOf(id),
        officeName,
        state: r.state,
        hospitalized: r.hospitalized,
        bathingPlanned: r.bathingPlanned,
        vitals: data.vitals,
        vitalsOk: data.vitalsOk,
        vitalPending: (key) => pendingRow('vitals', { routine: false, clientKey: key, residentId: id, day: data.day, kind: 'observation' }),
        target: targets.get(id) ?? null,
        thresholds: limits.lookup(id, data.day),
        bath: data.baths.find((b) => b.resident_id === id) ?? null,
        bathsOk: data.bathsOk,
        lunch: data.meals.find((m) => m.meal.resident_id === id && m.meal.meal_slot === 'lunch')?.meal ?? null,
        lunchPending: pendingRow('meals', { residentId: id, day: data.day, slot: 'lunch' }),
        fluids: data.fluids,
        intakeOk: data.intakeOk,
        activities: data.activities,
        activityPending,
        training: data.training,
        trainingPending,
        dayNote: data.dayNote?.body ?? null,
        note: contactNoteOf(data.contacts, id, data.day),
        notesOk: data.notesOk,
        unmeasured: data.unmeasured,
      })
    })
    // 基準の引き方（limits.lookup）は個人の基準の行が変わった時だけ作り直される
  }, [data, board, nameOf, officeName, targets, limits.lookup, queueTick])
  const pickedSet = useMemo<ReadonlySet<number>>(() => picked ?? (board === null ? new Set() : defaultPicked(board.rows)), [picked, board])
  const pickedSheets = useMemo(() => sheets.filter((s) => pickedSet.has(s.residentId)), [sheets, pickedSet])
  /** 印刷に送る紙面（氏名を引ける方だけ。名簿が読めない間は1枚も刷らない＝「利用者ID 12 様」と刷らない） */
  const printable = useMemo(() => (roster === 'ok' ? pickedSheets.filter((s) => nameKnown(s.residentId)) : []), [roster, pickedSheets, nameKnown])
  const unnamed = roster === 'ok' ? pickedSheets.filter((s) => !nameKnown(s.residentId)).map((s) => s.residentId) : []

  // ── 書き込みの可否 ──
  const missing = data?.missing ?? false
  const gateOpen = gate !== null && gate.observed && gate.value === true
  /** 過去の日のひと言は事務所・管理者のログインだけ（0061 の守りと同じ条件。未来の日は開かない） */
  const dayWritable = day === today || (day < today && canEditPastDaycareTimes(role))
  const notesWritable = gateOpen && !missing && data !== null && data.notesOk && day <= today && dayWritable

  // ── 欄の値（保存した行・保存した値・入れかけた値） ──
  const rowOf = (key: FieldKey, d: ContactData | null = data): DaycareDayNote | DaycareContactNote | null => {
    if (d === null) return null
    if (key === DAY_KEY) return d.dayNote
    return contactNoteOf(d.contacts, Number(key.split(':')[0]), d.day)
  }
  const savedOf = (key: FieldKey, d: ContactData | null = data): string => {
    const row = rowOf(key, d)
    if (row === null) return ''
    if (key === DAY_KEY) return (row as DaycareDayNote).body ?? ''
    const n = row as DaycareContactNote
    return (key.endsWith(':nurse_note') ? n.nurse_note : n.body) ?? ''
  }
  const draftOf = (key: FieldKey): string => drafts[key] ?? savedOf(key)
  const isDirty = (key: FieldKey): boolean => key in drafts && normalizeNoteText(drafts[key]) !== normalizeNoteText(savedOf(key))

  const setMsg = (key: FieldKey, m: FieldMsg | null) =>
    setFieldMsg((prev) => {
      const next = { ...prev }
      if (m === null) delete next[key]
      else next[key] = m
      return next
    })
  const setBusy = (key: FieldKey, on: boolean) =>
    setSaving((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  /** 入れかけの文とその基準を外す（保存できた・他の端末の文に置き換わった） */
  const dropDraft = (key: FieldKey) => {
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    setDraftBase((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  // ── 入れかけの間に他の端末がその欄を書き換えたか（読み直し・保存・印刷の後に行を差し替えるたびに見る＝反証 中1） ──
  // 変わっていない（keep）はそのまま。入れかけの文が入れ始めた時のまま・または新しい保存値と同じ（drop）なら、入れかけを外して
  // 新しい保存値を出す。違う文を入れている（changed）なら、欄の下に知らせを出し、保存の基準を新しい行にする（知らせを見て
  // もう一度〔保存〕を押した時だけ上書きする＝保存の時の食い違いの知らせと同じ考え）
  useEffect(() => {
    // ひと言の2表を読めなかった読み直し（notesOk が false）では比べない（保存値が空に見えるだけで、他の端末が空にしたのではない＝
    // 確認の反証 中1。入れかけの文と基準はそのまま残す）
    if (data === null || data.day !== day || !data.notesOk) return
    for (const [key, base] of Object.entries(draftBase)) {
      if (!(key in drafts)) continue
      const saved = normalizeNoteText(savedOf(key))
      const rel = draftAgainstSaved(drafts[key], base.value, saved)
      if (rel === 'keep') continue
      if (rel === 'drop') {
        dropDraft(key)
        continue
      }
      setDraftBase((prev) => ({ ...prev, [key]: { row: rowOf(key), value: saved } }))
      setMsg(key, { tone: 'warn', text: changedText(saved) })
    }
    // data（読み直し・保存・印刷の後の差し替え）が変わった時だけ見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  /** 保存の結果で画面の行を差し替える（同じ日の時だけ） */
  const putDayNote = (target: string, row: DaycareDayNote | null) =>
    setData((prev) => (prev === null || prev.day !== target ? prev : { ...prev, dayNote: row }))
  const putContact = (target: string, row: DaycareContactNote) =>
    setData((prev) =>
      prev === null || prev.day !== target
        ? prev
        : { ...prev, contacts: [...prev.contacts.filter((n) => n.id !== row.id && n.resident_id !== row.resident_id), row] },
    )

  const errorText = (e: unknown): string => (e instanceof DbError ? e.message : '保存できませんでした。通信状態を確認して、もう一度押してください。')

  /** 欄に入れる（入れ始めた時の保存値を、その欄の保存の基準として控える） */
  const onInput = (key: FieldKey, v: string) => {
    if (!(key in draftBase)) {
      const row = rowOf(key)
      const value = normalizeNoteText(savedOf(key))
      setDraftBase((prev) => (key in prev ? prev : { ...prev, [key]: { row, value } }))
    }
    setDrafts((prev) => ({ ...prev, [key]: v }))
    if (fieldMsg[key]?.tone === 'ok') setMsg(key, null)
  }

  /** 欄を保存する（変えた欄だけ）。送り先（日・人・欄）は押した時のもので固定する。基準は入れ始めた時の保存の行 */
  const save = async (key: FieldKey) => {
    if (data === null || saving.has(key)) return
    if (actorId === null) {
      setMsg(key, { tone: 'warn', text: MSG_NO_RECORDER })
      return
    }
    if (data.day > todayIso()) {
      setMsg(key, { tone: 'warn', text: MSG_FUTURE })
      return
    }
    const target = data.day
    const text = draftOf(key)
    const base = key in draftBase ? draftBase[key].row : rowOf(key)
    setBusy(key, true)
    setMsg(key, null)
    try {
      if (key === DAY_KEY) {
        const r = await saveDaycareDayNote({ day: target, text, base: base as DaycareDayNote | null, recordedBy: actorId, editedBy: actorId })
        if (dayRef.current !== target) return
        if (r.kind === 'saved') {
          dropDraft(key)
          putDayNote(target, r.row)
          setMsg(key, { tone: 'ok', text: '✓ 保存しました' })
        } else {
          // 上書きしていない。いまの行を次の保存の基準にし、入れた文は欄に残す
          const cur = r.row?.body ?? null
          setDraftBase((prev) => ({ ...prev, [key]: { row: r.row, value: normalizeNoteText(cur) } }))
          if (r.row !== null) putDayNote(target, r.row)
          setMsg(key, { tone: 'warn', text: conflictText(cur) })
        }
        return
      }
      const [rid, fieldRaw] = key.split(':')
      const residentId = Number(rid)
      const field: ContactNoteField = fieldRaw === 'nurse_note' ? 'nurse_note' : 'body'
      const r = await saveDaycareContactField({
        residentId,
        day: target,
        field,
        text,
        base: base as DaycareContactNote | null,
        recordedBy: actorId,
        editedBy: actorId,
      })
      if (dayRef.current !== target) return
      if (r.kind === 'saved') {
        dropDraft(key)
        if (r.row !== null) putContact(target, r.row)
        setMsg(key, { tone: 'ok', text: '✓ 保存しました' })
      } else {
        const cur = r.row === null ? null : field === 'body' ? r.row.body : r.row.nurse_note
        setDraftBase((prev) => ({ ...prev, [key]: { row: r.row, value: normalizeNoteText(cur) } }))
        if (r.row !== null) putContact(target, r.row)
        setMsg(key, { tone: 'warn', text: conflictText(cur) })
      }
    } catch (e) {
      // 通信できない・封鎖・長すぎる・過去の日の守り など: 入れた文は欄に残す（消さない）
      if (dayRef.current === target) setMsg(key, { tone: 'danger', text: errorText(e) })
    } finally {
      setBusy(key, false)
    }
  }

  // ── 印刷 ──
  const doPrint = () => {
    setConfirm(null)
    const ids = printable.map((s) => s.residentId)
    if (ids.length === 0 || data === null) return
    printRef.current?.print()
    setPrintNote(`${ids.length}名の連絡帳を印刷に送りました。`)
    // 〔印刷する〕で印刷に送った時刻を書く（失敗しても印刷は止めない・知らせない）
    const target = data.day
    void markDaycareContactPrinted({ day: target, residentIds: ids, current: data.contacts, recordedBy: actorId, editedBy: actorId }).then((rows) => {
      for (const row of rows) putContact(target, row)
    })
  }
  const onPrint = () => {
    if (printable.length === 0) return
    const set = new Set(printable.map((s) => s.residentId))
    const check: PrintCheck = {
      nurse: nurseNoteMissing(printable, set),
      vitalsUnread: vitalsUnreadPicked(printable, set),
      unread: unreadPicked(printable, set),
      autoBath: autoBathPicked(printable, set),
      trainingQueued: trainingQueuedPicked(printable, set),
      vitalsStopped: vitalsStoppedPicked(printable, set),
      queued: queuePending(),
      unsaved: printable
        .map((s) => s.residentId)
        .filter((id) => isDirty(fieldKeyOf(id, 'body')) || (sheets.find((s) => s.residentId === id)?.abnormal === true && isDirty(fieldKeyOf(id, 'nurse_note')))),
      dayUnsaved: isDirty(DAY_KEY),
    }
    const any =
      check.nurse.length > 0 ||
      check.vitalsUnread.length > 0 ||
      check.unread.length > 0 ||
      check.autoBath.length > 0 ||
      check.trainingQueued.length > 0 ||
      check.vitalsStopped.length > 0 ||
      check.queued > 0 ||
      check.unsaved.length > 0 ||
      check.dayUnsaved
    if (any) setConfirm(check)
    else doPrint()
  }

  const goDay = (d: string) => navigate(contactPath(d, today), { replace: true })

  // その日に読めなかった項目（一覧の上の帯）
  const unreadDay =
    data === null
      ? []
      : unreadProgressLabels({
          vitalsOk: data.vitalsOk,
          intakeOk: data.intakeOk,
          activitiesOk: data.activities !== null,
          trainingOk: data.training !== null,
          bathsOk: data.bathsOk,
        })

  // ── 描画 ──
  const header = (
    <div className="space-y-2 print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <Link to="/record/daycare" className={`${BTN} font-bold`}>
          <span aria-hidden="true">‹ </span>今日の画面へ
        </Link>
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
          <button type="button" onClick={() => goDay(today)} className="min-h-tap rounded border border-border-strong bg-surface px-3 text-sm text-ink">
            今日を開く
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setReloadKey((n) => n + 1)}
          className="min-h-tap rounded border border-border-strong bg-surface px-3 text-sm text-ink"
        >
          最新に更新
        </button>
      </div>
      {missing ? (
        <p role="alert" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {MSG_MISSING}
        </p>
      ) : gate !== null && !gateOpen ? (
        <p role="status" className="rounded-lg border border-warn bg-warn-bg px-3 py-1.5 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {gate.forbidden
            ? FORBIDDEN_REASON
            : gate.outdated
              ? OUTDATED_REASON
              : gate.observed
                ? `${kindBlockedMessage('daycare')}。見本の確認と印刷はできます。`
                : MSG_GATE_UNKNOWN}
        </p>
      ) : null}
      {day < today && !dayWritable ? (
        <p role="status" className="rounded-lg border border-border bg-surface2 px-3 py-1.5 text-base text-ink">
          {MSG_PAST_OFFICE}
        </p>
      ) : null}
      {data !== null && data.day === day && !data.notesOk ? (
        <p role="status" className="rounded-lg border border-warn bg-warn-bg px-3 py-1.5 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {data.notesMissing ? MSG_CONTACT_MISSING : MSG_NOTES_UNREAD}
        </p>
      ) : null}
    </div>
  )

  if ((loading && data === null) || (data !== null && data.day !== day && error === null)) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-2">
        {header}
        <LoadingBlock label="その日の記録と連絡帳を読み込んでいます…" />
      </div>
    )
  }
  if (error !== null && (data === null || data.day !== day)) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-2">
        {header}
        <ErrorBlock message={error} onRetry={() => setReloadKey((n) => n + 1)} />
      </div>
    )
  }
  if (data === null || board === null) return null

  /** 1つの欄（全員共通の一文・個別のひと言・看護職のひと言） */
  const noteField = (key: FieldKey, label: string, max: number, hint: string | null, labelledName: string | null) => {
    const value = draftOf(key)
    const count = noteLength(value)
    const busy = saving.has(key)
    const dirty = isDirty(key)
    const m = fieldMsg[key]
    const id = `dcc-${key.replace(':', '-')}`
    return (
      <div className="space-y-1">
        <label htmlFor={id} className="block text-base font-bold text-ink">
          {label}
          {labelledName !== null ? <span className="sr-only">（{labelledName}さん）</span> : null}
        </label>
        {hint !== null ? <p className="text-sm text-ink2">{hint}</p> : null}
        <textarea
          id={id}
          value={value}
          // 上限を超えて入れられない（maxLength は UTF-16 の数で数える＝字数より多くは入らない。送る前に字数でも確かめる）
          maxLength={max}
          rows={3}
          disabled={!notesWritable || busy}
          onChange={(e) => onInput(key, e.target.value)}
          className="block w-full rounded border border-border-strong bg-surface p-2 text-base text-ink disabled:bg-surface2 disabled:text-ink3"
          aria-describedby={`${id}-count`}
        />
        <div className="flex flex-wrap items-center gap-gap">
          <span id={`${id}-count`} className="text-sm text-ink2">
            {count}／{max}字
          </span>
          {dirty ? (
            <span className="text-sm font-bold text-ink">
              <span aria-hidden="true">✎ </span>未保存（紙には保存した文が載ります）
            </span>
          ) : null}
          <button type="button" onClick={() => void save(key)} disabled={!notesWritable || busy || !dirty} className={`ml-auto ${BTN_PRIMARY}`}>
            {busy ? '保存しています…' : '保存'}
            {labelledName !== null ? <span className="sr-only">（{labelledName}さんの{label}）</span> : null}
          </button>
        </div>
        {m !== undefined ? (
          <p
            role={m.tone === 'danger' ? 'alert' : 'status'}
            className={`rounded border p-2 text-sm text-ink ${
              m.tone === 'danger' ? 'border-danger bg-danger-bg' : m.tone === 'warn' ? 'border-warn bg-warn-bg' : 'border-border bg-surface2'
            }`}
          >
            {m.tone === 'danger' || m.tone === 'warn' ? <span aria-hidden="true">▲ </span> : null}
            {m.text}
          </p>
        ) : null}
      </div>
    )
  }

  const n = pickedSheets.length
  /** 印刷を止める理由（名簿が読めない・氏名を引けない方がいる） */
  const printBlocked =
    n === 0
      ? null
      : roster === 'loading'
        ? MSG_ROSTER_LOADING
        : roster === 'failed'
          ? MSG_ROSTER_FAILED
          : unnamed.length > 0
            ? `名簿に氏名が無い方がいるため、印刷できません（${unnamed.map((id) => `利用者ID ${id}`).join('・')}）。その方の〔印刷する〕を外すか、〔最新に更新〕を押してください。`
            : null
  return (
    <div className="mx-auto w-full max-w-6xl space-y-3">
      {header}
      {limits.failed ? <VitalLimitsFailedNote className="" onRetry={() => void limits.refresh()} /> : null}
      {/* その日に読めなかった項目（紙には「読み込めませんでした」と載る）。印刷の前に読み直しをすすめる（反証 中3） */}
      {unreadDay.length > 0 && board.rows.length > 0 ? (
        <p role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {unreadDay.join('・')}の記録を読み込めませんでした（紙には「読み込めませんでした」と載ります）。通信状態を確認して、〔最新に更新〕を押してから印刷してください。
        </p>
      ) : null}

      {/* 全員共通の一文（一度書けばその日の全員の「職員より」に入る） */}
      <section className="rounded-lg border border-border bg-surface p-3" aria-label="全員共通の一文">
        {noteField(DAY_KEY, '全員共通の一文', DAY_NOTE_MAX, 'その日の来た方全員の連絡帳の「職員より」に入ります（空なら紙に載りません）。', null)}
      </section>

      {/* 印刷する方を選ぶ・印刷する */}
      <div className="flex flex-wrap items-center gap-gap rounded-lg border border-border bg-surface p-3">
        <button type="button" onClick={() => setPicked(new Set(board.rows.map((r) => r.residentId)))} className={BTN} disabled={board.rows.length === 0}>
          全員を選ぶ
        </button>
        <button type="button" onClick={() => setPicked(defaultPicked(board.rows))} className={BTN} disabled={board.rows.length === 0}>
          来た方だけ
        </button>
        <button type="button" onClick={() => setPicked(new Set())} className={BTN} disabled={n === 0}>
          選ぶのをやめる
        </button>
        <button type="button" onClick={onPrint} disabled={n === 0 || printBlocked !== null} className={`ml-auto ${BTN_PRIMARY}`}>
          印刷する（{n}名）
        </button>
        <p className="w-full text-sm text-ink2">用紙は A5 縦・1人1枚です。紙に載るのは保存したひと言です（見本と同じ）。</p>
        {printBlocked !== null ? (
          <p role="alert" className="w-full rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
            <span aria-hidden="true">▲ </span>
            {printBlocked}
          </p>
        ) : null}
        {printNote !== null ? (
          <p role="status" className="w-full text-sm text-ink">
            <span aria-hidden="true">✓ </span>
            {printNote}
          </p>
        ) : null}
      </div>

      {board.rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-base text-ink">
            {data.planSource === 'unknown'
              ? '予定を確かめられないため、一覧を出せません（「利用者なし」ではありません）。今日の画面で確かめてください。'
              : 'この日の予定・記録はまだありません。'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3" aria-label="連絡帳の一覧">
          {board.rows.map((row) => {
            const id = row.residentId
            const sheet = sheets.find((s) => s.residentId === id)
            if (sheet === undefined) return null
            const name = nameOf(id)
            const tone = daycareStateTone(row)
            const on = pickedSet.has(id)
            const checkId = `dcc-pick-${id}`
            return (
              <li key={id} className="rounded-lg border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-gap">
                  <p className="text-base font-bold text-ink">
                    {name}
                    <span className="ml-2 text-sm font-normal text-ink2">
                      <span aria-hidden="true">{tone.mark} </span>
                      {tone.word}
                    </span>
                  </p>
                  <label
                    htmlFor={checkId}
                    className={`inline-flex min-h-tap min-w-tap cursor-pointer items-center gap-2 rounded border px-3 text-base ${
                      on ? 'border-primary font-bold text-ink' : 'border-border-strong text-ink'
                    }`}
                  >
                    <input
                      id={checkId}
                      type="checkbox"
                      checked={on}
                      onChange={(e) => {
                        const next = new Set(pickedSet)
                        if (e.target.checked) next.add(id)
                        else next.delete(id)
                        setPicked(next)
                      }}
                      className="h-6 w-6"
                    />
                    印刷する<span className="sr-only">（{name}さん）</span>
                  </label>
                </div>
                <div className="mt-2 flex flex-wrap items-start gap-4">
                  {/* 紙面の見本（印刷と同じ部品を枠の幅に合わせて縮める） */}
                  <div className="w-full max-w-[22rem] shrink-0 space-y-1">
                    <figure className="dcc-preview m-0" aria-label={`${name}さんの連絡帳の見本`}>
                      <ContactSheetView sheet={sheet} />
                    </figure>
                    {/* 送信待ちを重ねた方（紙には出さない。届いた後に読み直すと送信待ちの印が消える） */}
                    {sheet.pendingLabels.length > 0 ? (
                      <p className="text-sm text-ink2">
                        <span aria-hidden="true">↻ </span>送信待ちを含む（{sheet.pendingLabels.join('・')}）
                      </p>
                    ) : null}
                  </div>
                  <div className="min-w-[16rem] flex-1 space-y-3">
                    {noteField(fieldKeyOf(id, 'body'), '個別のひと言', CONTACT_BODY_MAX, null, name)}
                    {sheet.abnormal
                      ? noteField(
                          fieldKeyOf(id, 'nurse_note'),
                          '看護職のひと言',
                          CONTACT_NURSE_MAX,
                          '基準を外れたバイタルがあります（紙には値をそのまま載せます）。看護職からひと言を書いてください（空なら紙に「看護職より」は載りません）。',
                          name,
                        )
                      : null}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <DaycareContactPrint ref={printRef} sheets={printable} />

      {/* 印刷の前の確かめ（基準外なのに看護職のひと言が空・バイタルが読めない・読めない項目・入浴が自動のまま・送信待ちの機能訓練・
          送れずに止まっているバイタル・この端末の送信待ちの件数・保存していない文） */}
      <ModalShell open={confirm !== null} label="印刷の前に確かめてください" onClose={() => setConfirm(null)} initialFocus={backRef}>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto p-4">
          <h2 className="text-lg font-bold text-ink">印刷の前に確かめてください</h2>
          {confirm !== null && confirm.nurse.length > 0 ? (
            <div>
              <p className="text-base text-ink">
                <span aria-hidden="true">▲ </span>基準を外れたバイタルがあるのに、看護職のひと言が空の方（このまま印刷すると「看護職より」は載りません）:
              </p>
              <ul className="ml-5 list-disc text-base text-ink">
                {confirm.nurse.map((rid) => (
                  <li key={rid}>{nameOf(rid)} 様</li>
                ))}
              </ul>
            </div>
          ) : null}
          {confirm !== null && confirm.vitalsUnread.length > 0 ? (
            <div>
              <p className="text-base text-ink">
                <span aria-hidden="true">▲ </span>バイタルを読み込めないため、基準を外れたかを確かめられない方（看護職のひと言が要るか分かりません）:
              </p>
              <ul className="ml-5 list-disc text-base text-ink">
                {confirm.vitalsUnread.map((rid) => (
                  <li key={rid}>{nameOf(rid)} 様</li>
                ))}
              </ul>
            </div>
          ) : null}
          {confirm !== null && confirm.unread.length > 0 ? (
            <div>
              <p className="text-base text-ink">
                <span aria-hidden="true">▲ </span>読めなかった項目がある方（紙には「読み込めませんでした」と載ります。〔最新に更新〕で読み直してから印刷してください）:
              </p>
              <ul className="ml-5 list-disc text-base text-ink">
                {confirm.unread.map((u) => (
                  <li key={u.residentId}>
                    {nameOf(u.residentId)} 様（{u.labels.join('・')}）
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {confirm !== null && confirm.autoBath.length > 0 ? (
            <div>
              <p className="text-base text-ink">
                <span aria-hidden="true">▲ </span>入浴が自動の記録のままの方（12:30 の自動の記録で、まだ人が確かめていません。紙には「入浴しました」と載ります）:
              </p>
              <ul className="ml-5 list-disc text-base text-ink">
                {confirm.autoBath.map((rid) => (
                  <li key={rid}>{nameOf(rid)} 様</li>
                ))}
              </ul>
            </div>
          ) : null}
          {confirm !== null && confirm.trainingQueued.length > 0 ? (
            <div>
              <p className="text-base text-ink">
                <span aria-hidden="true">▲ </span>送信待ちの機能訓練がある方（送信が済んでから刷ると紙に載ります。いま刷ると「記録なし」と載ります）:
              </p>
              <ul className="ml-5 list-disc text-base text-ink">
                {confirm.trainingQueued.map((rid) => (
                  <li key={rid}>{nameOf(rid)} 様</li>
                ))}
              </ul>
            </div>
          ) : null}
          {confirm !== null && confirm.vitalsStopped.length > 0 ? (
            <div>
              <p className="text-base text-ink">
                <span aria-hidden="true">▲ </span>送れずに止まっているバイタルがある方（他の端末の値との食い違い・送れない状態。その値は紙に載りません。送信待ちの一覧で確かめてください）:
              </p>
              <ul className="ml-5 list-disc text-base text-ink">
                {confirm.vitalsStopped.map((rid) => (
                  <li key={rid}>{nameOf(rid)} 様</li>
                ))}
              </ul>
            </div>
          ) : null}
          {confirm !== null && confirm.queued > 0 ? (
            <p className="text-base text-ink">
              <span aria-hidden="true">▲ </span>この端末に送信待ちが {confirm.queued} 件あります（届く前の記録は紙に載らないことがあります）。
            </p>
          ) : null}
          {confirm !== null && (confirm.unsaved.length > 0 || confirm.dayUnsaved) ? (
            <div>
              <p className="text-base text-ink">
                <span aria-hidden="true">▲ </span>保存していない文があります（紙には保存した文が載ります）:
              </p>
              <ul className="ml-5 list-disc text-base text-ink">
                {confirm.dayUnsaved ? <li>全員共通の一文</li> : null}
                {confirm.unsaved.map((rid) => (
                  <li key={rid}>{nameOf(rid)} 様のひと言</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-gap border-t border-border p-4">
          <button type="button" ref={backRef} onClick={() => setConfirm(null)} className={BTN}>
            戻って書く
          </button>
          {confirm !== null && (confirm.unread.length > 0 || confirm.vitalsUnread.length > 0) ? (
            <button
              type="button"
              onClick={() => {
                setConfirm(null)
                setReloadKey((k) => k + 1)
              }}
              className={BTN}
            >
              最新に更新
            </button>
          ) : null}
          <button type="button" onClick={doPrint} className={BTN_PRIMARY}>
            このまま印刷する
          </button>
        </div>
      </ModalShell>
    </div>
  )
}

/** 保存の時に、他の端末が先に書き換えていた時の知らせ（上書きしていない・入れた文は欄に残している） */
function conflictText(current: string | null): string {
  const now = current === null || current.trim() === '' ? '（空）' : `「${current}」`
  return `他の端末が先にこの欄を書き換えていたため、上書きしていません。いま保存されている文は ${now} です。入れた文は欄に残しています。見比べて直し、もう一度〔保存〕を押してください。`
}

/** 入れている間に、他の端末がこの欄を書き換えた時の知らせ（読み直した時に見つけた。上書きはしていない） */
function changedText(current: string | null): string {
  const now = current === null || current.trim() === '' ? '（空）' : `「${current}」`
  return `入れている間に、他の端末がこの欄を書き換えました。いま保存されている文は ${now} です。入れた文は欄に残しています（まだ上書きしていません）。見比べて直し、〔保存〕を押してください。`
}

export default DaycareContactPage
