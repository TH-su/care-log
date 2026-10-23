// 利用者一覧（/karte）と個人カルテ（/karte/:id）。
// 契約: docs/design/contracts.md（ルーティング・db.ts API・共通部品） ／ 詳細: docs/design/ui-design.md §5
//
// この画面は記録について読み取り専用（記録の書き込み経路を持たない＝multi-device-sync 原則9「読み取りで書かない」。
// 例外は事務・管理者が使う「個別の目標」の保存だけ＝下の 2026-10-16 の項。
// 既読付与も行わない＝表示だけで note_reads を作らない）。
// - 取得は db.ts の fetchResidents / fetchAllStaff / fetchKarte / fetchRecordHistory のみ
//   （記入者名は退職者も含む全員から引く＝F48・2026-10-10。退職者が書いた過去の記録の記入者を「—」にしない）
//   （supabase 直呼びなし・期間指定必須。変更の記録は14日ずつ遡る＝全件ロードしない）
// - localStorage に保存するのは期間セグメント（cl_karteRange）だけ。氏名・記録本文は保存しない
// - 体重（2026-09-27 追加）は weightClient.ts の fetchWeights で体重管理アプリの GAS から読むだけ。
//   体重管理アプリの接続設定（wtmgr_api_*）は weightClient が読むだけで、この画面は localStorage に触れない。
//   取得した体重は画面のメモリだけに持つ（期間切替では取り直さない。利用者・再試行・「体重を読み直す」で取り直す）
// - Tailwind はトークン由来クラスのみ。色・px の直書きと arbitrary value は書かない
// - console 出力を持たない（個人情報の漏出経路を作らない）
// - バイタル・食事・水分の見やすさ（2026-10-16 本人回答・A1〜A9）:
//   ・体温のグラフに平熱（fetchUsualTemps＝直近30日の定時の中央値）の点線と、平熱+1.0℃以上の印（A1）
//   ・SpO2 は個別の下限（A9）があればそれで判定し、下限の線を引く
//   ・食事の表のマスの地の濃淡（A6・tokens.css の --cl-shade-0〜4-bg/ink と .cl-shade-hatch。色だけに頼らず数字は残す）、
//     ▼摂取低下（A2）、水分の目標との比と横棒（A3）
//   ・「個別の目標」の欄（水分の目標・SpO2 の個別の下限）。**この画面で唯一の書き込み**（saveResidentTargets）。
//     書けるのは事務・管理者のログイン（canEditTargets）だけで、現場には入力欄を出さず値だけを見せる（サーバーの RLS でも止まる）
//   ・〔温度板を印刷〕（A7・A4 縦1枚）。押した時だけ印刷の部品を置く（Ctrl+P のカルテの印刷は今までどおり）
//   ・今日の要注意（/alerts）から ?sec=<欄の id> で開いた時は、その欄へ移る（id は KARTE_JUMPS の許可リストで照合）
//   ・基準値（app_settings の上書き・A8）は loadVitalThresholds をカルテの読み込みと一緒に待ってから描く
// - 排泄（2026-10-16 追加）は excretionClient.ts の fetchExcretion で排便記録アプリの GAS から読むだけ。
//   接続設定（hbcr_api_*）は excretionClient が読むだけで、この画面は localStorage に触れない。記録は画面のメモリだけ。
//   照合（氏名＋居室）・「最後の排便から◯日」の数え方（排便記録アプリの写し）は excretionClient.ts。照合できない時は理由を出す

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { flushSync } from 'react-dom'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  cachedMyRole,
  canEditTargets,
  DbError,
  diffHistoryRow,
  fetchAllStaff,
  fetchMyRole,
  fetchRecordHistory,
  fetchResidentTargets,
  fetchUsualTempDetails,
  loadVitalThresholds,
  saveResidentTargets,
  subscribeMyRole,
} from '../lib/db'
import type { MyRole, RecordHistoryEntry } from '../lib/db'
// 名簿とカルテ本体は読み込みの控え（裏での先読み・2026-10-17）を通す。一覧で方の行に指が触れた時にその方のカルテを
// 先読みし、開いた方のカルテは控えに残す（次に開いた時は控えを先に出し、裏で取り直す）
import { fetchKarte, fetchResidents, peekKarte, peekResidents, prefetchKarte } from '../lib/cachedReads'
import { useVitalLimits, VITAL_LIMITS_FAILED_TEXT } from '../hooks/useVitalLimits'
import {
  clampLines,
  fmtChangedAt,
  fmtHistoryValue,
  HISTORY_TABLE_LABEL,
  historyColumnLabel,
  incidentDetailChangeLabels,
} from '../lib/historyView'
import { addDays, fmtDayLabel, fmtTimeHM, isoDate, todayIso } from '../lib/format'
import { fmtRecordTime, noteIsNextMorning, timeSortKey, vitalIsNextMorning } from '../lib/nextMorning'
import { typesText } from '../lib/incident'
import { BATH_SHOWN_LABEL, bathShownOf } from '../lib/bath'
import {
  chartDomain,
  chartHeight,
  chartTicks,
  CHART_H_MIN,
  CHART_H_PRINT,
  fluidSeries,
  KARTE_AXES,
  layoutAxisLabels,
  mealDays,
  mealIntakeSeries,
  offRangeSpeech,
  offRangeText,
  splitThresholds,
} from '../lib/chart'
import type { AxisSpec } from '../lib/chart'
import { diaBpLevelBy, pulseLevelBy, sysBpLevelBy, vitalThresholds } from '../lib/vitalThresholds'
import type { VitalThresholds } from '../lib/vitalThresholds'
import { changedFromText, lastChangeDay, thresholdsLookup } from '../lib/vitalLimits'
import type { ResidentVitalLimit } from '../lib/vitalLimits'
// バイタル・食事・水分の見やすさ（A1・A2・A3・A6・A9・2026-10-16）の判定。数の決め方は vitalAlerts.ts（純関数・試験あり）
import {
  fluidProgress,
  fluidTargetOf,
  fmtMl,
  fmtUsualTemp,
  judgeTemp,
  mealLowLabel,
  mealLowStreaks,
  mealShade,
  spo2LevelFor,
  spo2Limits,
  validateResidentTargets,
} from '../lib/vitalAlerts'
import type { ResidentTargets, ResidentTargetsInput } from '../lib/vitalAlerts'
import { karteSecOf } from './alertsModel'
// 温度板（A7）。ボタンを押した時だけ置く（TempSheet.tsx の冒頭）
import { VitalLimitsCard } from '../components/VitalLimitsCard'
import { TempSheetPrint } from '../components/print/TempSheet'
import { buildTempSheet, sheetDays } from '../components/print/tempSheetModel'
import {
  fetchWeights,
  fmtKg,
  fmtWeightDiff,
  latestWeightRow,
  MSG_WEIGHT_NO_RECORDS,
  MSG_WEIGHT_UNLINKED,
  MSG_WEIGHT_NONE_IN_RANGE,
  MSG_WEIGHT_UNCONFIGURED,
  weightAppHref,
  weightFailMessage,
  weightRowsInRange,
} from '../lib/weightClient'
import type { WeightEntry, WeightRow } from '../lib/weightClient'
import {
  EXCRETION_LIST_DAYS,
  EXCRETION_TIMEOUT_MS,
  excretionFailMessage,
  excretionViewFor,
  fetchExcretion,
  isHospitalDay,
  MSG_EXCRETION_UNCONFIGURED,
  MSG_STOOL_HOSPITAL,
  stoolStatusText,
} from '../lib/excretionClient'
import type { ExcretionDay, ExcretionView, HbSnapshot } from '../lib/excretionClient'
import {
  Chip,
  EmptyBlock,
  ErrorBlock,
  LevelCell,
  LoadingBlock,
  SectionCard,
  SegmentPicker,
} from '../components/ui'
import {
  IMPORTANCE_LABEL,
  INCIDENT_KIND_LABEL,
  INCIDENT_STATUS_LABEL,
  LEVEL_MARK,
  LS,
  MEAL_STATUS_LABEL,
  MED_SLOT_LABEL,
  MED_STATUS_LABEL,
  OUTING_KIND_LABEL,
  SHIFT_LABEL,
  isLowIntake,
} from '../lib/types'
import type {
  BathRecord,
  FluidIntake,
  Incident,
  Level,
  Meal,
  MealSlot,
  MedAdmin,
  Note,
  Outing,
  Resident,
  Staff,
  Vital,
  VitalKind,
} from '../lib/types'

// ══════════════════════════════════════════════════════════════
// 定数
// ══════════════════════════════════════════════════════════════

/** 期間セグメント（ui-design.md §5・既定2週）。復元は既知値の完全一致照合のみ */
const RANGE_VALUES = ['14d', '1m', '3m', '6m', '1y'] as const
type RangeKey = (typeof RANGE_VALUES)[number]

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: '14d', label: '2週' },
  { value: '1m', label: '1か月' },
  { value: '3m', label: '3か月' },
  { value: '6m', label: '6か月' },
  { value: '1y', label: '1年' },
]

const RANGE_MONTHS: Record<Exclude<RangeKey, '14d'>, number> = {
  '1m': 1,
  '3m': 3,
  '6m': 6,
  '1y': 12,
}

const DEFAULT_RANGE: RangeKey = '14d'

/** 日付展開の安全上限（壊れた値で無限ループしないための歯止め。1年=366日を超える余裕を持たせる） */
const DAY_CAP = 400

// グラフの寸法（CSS px と 1:1 の viewBox で描くため、44px ヒット領域が実寸になる）
// 高さは画面の高さから決める（lib/chart.ts の chartHeight・200〜360px。印刷は今までと同じ 160px）。
// 左・上・下の余白は文字の大きさに合わせて広げる（文字200%でも目盛・しきい値の数字が切れない）。文字100%では今までと同じ値
const PAD_L_MIN = 48
const PAD_R = 12
const PAD_T_MIN = 12
const PAD_B_MIN = 22
/** 軸の文字（text-2xs）の大きさを測れない時の値（px） */
const AXIS_FS_DEFAULT = 13
/** 左の列の文字と縦軸の間（期間の最初の日の大きい点＝半径4.5px に文字が掛からない幅） */
const AXIS_LABEL_GAP = 6
/** 左の列でいちばん幅を取る文字（範囲外のしきい値「上151↑」）。この幅を実測して左の余白にする */
const AXIS_PROBE_TEXT = '上151↑'
/** 日付の文字でいちばん幅を取る形。期間の両端の日付が1行に並ぶかをこの幅で決める */
const DATE_PROBE_TEXT = '12/31（水）'
/** 曜日を省いた短い日付（幅の足りない時に使う）の最大幅の見本 */
const DATE_SHORT_PROBE_TEXT = '12/31'
/** 点の脇の記号の1文字の幅を測る見本（↑↓▲ は全角の幅で描かれる） */
const MARK_PROBE_TEXT = '↑↑'
/** 印刷の直前にグラフの幅を測り直させる合図（グラフの欄を今までの幅へ戻した後に出す） */
const KARTE_REMEASURE_EVENT = 'cl-karte-remeasure'
/** 文字の欄の幅（今までのカルテと同じ） */
const LANE = 'mx-auto w-full max-w-2xl px-4'
/** グラフの欄の幅（広い画面では画面幅まで広げる・最大 1152px。印刷は今までの幅） */
const LANE_WIDE = 'mx-auto w-full max-w-6xl px-4 print:max-w-2xl'
/** 広い画面（下のナビが消え、左の縦ナビになる幅）。グラフを1画面に2枚収める */
const WIDE_QUERY = '(min-width: 1024px)'
const CHART_MIN_W = 240
const CHART_DEFAULT_W = 640
const POINT_R = 3
const POINT_R_ALERT = 4.5
/** データ点のタップ判定の目安幅（HIG 44px）。点が密なときは縦いっぱい（グラフ高さ全体）で補う */
const HIT_MIN_W = 44
/** 記号（↑↑等）を点の脇に描く最小の点間隔。これ未満は密集して読めないため描かない（表で補う） */
const MARK_MIN_GAP = 14

const ERR_RESIDENTS =
  '利用者の一覧を読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'
const ERR_KARTE =
  'カルテを読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'

// ══════════════════════════════════════════════════════════════
// 純ロジック（副作用なし）
// ══════════════════════════════════════════════════════════════

/** 受信データを信じない: 配列でなければ空配列に倒す */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

/** 絞込用キー: カタカナ→ひらがな・英字は小文字・空白除去で部分一致させる */
function kanaKey(s: string): string {
  return s
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 月単位の加減算。月末日は移動先の月の末日に丸める（3/31 の1か月前は 2/28） */
function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso
  const first = new Date(y, m - 1 + n, 1)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return isoDate(new Date(first.getFullYear(), first.getMonth(), Math.min(d, last)))
}

/** 期間セグメントの開始日（終了日は当日） */
export function rangeFromIso(range: RangeKey, toIso: string): string {
  if (range === '14d') return addDays(toIso, -13)
  return addDays(addMonths(toIso, -RANGE_MONTHS[range]), 1)
}

/** [fromIso, toIso] の全日付（古い順） */
function daysAscending(fromIso: string, toIso: string): string[] {
  if (!fromIso || !toIso || fromIso > toIso) return []
  const out: string[] = []
  let cur = fromIso
  for (let i = 0; i < DAY_CAP && cur <= toIso; i++) {
    out.push(cur)
    cur = addDays(cur, 1)
  }
  return out
}

/** 居室から階を推定する（居室 '102' → 1階）。判定できなければ null＝表示しない */
function floorOf(room: string | null): number | null {
  if (!room) return null
  const m = /(\d)\d{2}/.exec(room)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= 9 ? n : null
}

/** 本人の記録だけを残す（fetchKarte は本人分を返す契約だが、取り違え防止に受信側でも照合する） */
function ownedBy<T extends { resident_id: number }>(rows: unknown, residentId: number): T[] {
  return asArray<T>(rows).filter((r) => r != null && r.resident_id === residentId)
}

const KIND_ORDER: Record<VitalKind, number> = { routine: 0, recheck: 1, observation: 2, symptom: 3 }

/** 時刻（HH:MM[:SS]）の昇順比較。null は末尾 */
function cmpTime(a: string | null, b: string | null): number {
  const x = a ?? '99:99:99'
  const y = b ?? '99:99:99'
  return x < y ? -1 : x > y ? 1 : 0
}

function cmpVitalAsc(a: Vital, b: Vital): number {
  return (
    (a.measured_on < b.measured_on ? -1 : a.measured_on > b.measured_on ? 1 : 0) ||
    (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
    // 夜勤明けに前日の列へ書いたバイタル（「翌」）は、その日の夜の記録の後ろ（F34）
    cmpTime(timeSortKey(a.measured_at, vitalIsNextMorning(a)), timeSortKey(b.measured_at, vitalIsNextMorning(b))) ||
    a.id - b.id
  )
}

type VitalField = 'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2'

/**
 * 1日1点の系列を作る（同じ日に複数回の記録がある場合は 定時→再検→経過観察 の順で最初の実測値を採る）。
 * 値が無い日はキーを作らない＝欠測として線を切るため。
 */
function dailySeries(sortedVitals: Vital[], field: VitalField): Map<string, number> {
  const out = new Map<string, number>()
  for (const v of sortedVitals) {
    if (out.has(v.measured_on)) continue
    const n = v[field]
    if (typeof n === 'number' && Number.isFinite(n)) out.set(v.measured_on, n)
  }
  return out
}

/** 欠測で切れた線分の配列（各線分は連続する日の点だけを持つ） */
function lineSegments(days: string[], values: Map<string, number>): { i: number; v: number }[][] {
  const out: { i: number; v: number }[][] = []
  let cur: { i: number; v: number }[] = []
  days.forEach((d, i) => {
    const v = values.get(d)
    if (v == null) {
      if (cur.length > 0) out.push(cur)
      cur = []
      return
    }
    cur.push({ i, v })
  })
  if (cur.length > 0) out.push(cur)
  return out
}

function fmtNum(v: number, digits: number): string {
  return v.toFixed(digits)
}

/** 曜日を省いた日付「9/25」（グラフの両端の日付が狭い画面で並ばない時だけ使う） */
function fmtDayShort(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${Number(m[1])}/${Number(m[2])}` : fmtDayLabel(iso)
}

/** 温度板の印刷の時刻 '2026/10/16 17:05'（端末の時刻） */
function fmtPrintedAt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${p(d.getMinutes())}`
}

/** 外出・外泊がその日にかかっているか（帰着未定＝end_on null は開始日以降ずっと継続中とみなす） */
function outingCoversDay(o: Outing, day: string): boolean {
  if (typeof o.start_on !== 'string' || o.start_on > day) return false
  if (o.end_on == null) return true
  return day <= o.end_on
}

// ══════════════════════════════════════════════════════════════
// localStorage（UI状態のみ・原則11）
// ══════════════════════════════════════════════════════════════

function readRange(): RangeKey {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_RANGE
    const v = localStorage.getItem(LS.karteRange)
    if (v != null && (RANGE_VALUES as readonly string[]).includes(v)) return v as RangeKey
  } catch {
    // 読めない環境（プライベートモード等）では既定へフォールバックする
  }
  return DEFAULT_RANGE
}

function writeRange(v: RangeKey): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS.karteRange, v)
  } catch {
    // 保存できなくても表示は成立させる
  }
}

// ══════════════════════════════════════════════════════════════
// 利用者スナップショット（一覧・カルテ共通）
// ══════════════════════════════════════════════════════════════

interface ResidentsState {
  residents: Resident[]
  loading: boolean
  error: string | null
  reload(): void
}

function useResidents(provided?: Resident[]): ResidentsState {
  // 名簿の控え（裏での先読み）があれば最初の描画から出す（下で取り直す）
  const [residents, setResidents] = useState<Resident[]>(
    () => provided ?? asArray<Resident>(peekResidents()).filter((r) => r != null && typeof r.id === 'number'),
  )
  const [loading, setLoading] = useState(() => !provided && peekResidents() === undefined)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (provided) {
      setResidents(provided)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    // 控えで出せている時は「読み込み中」に戻さない（一覧は今のまま、裏で取り直す）
    setLoading(peekResidents() === undefined)
    setError(null)
    fetchResidents()
      .then((rows) => {
        if (cancelled || !aliveRef.current) return
        setResidents(asArray<Resident>(rows).filter((r) => r != null && typeof r.id === 'number'))
        setError(null)
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        // 失敗時は取得済みの表示を消さない（原則4: 安全側フォールバック）
        setError(ERR_RESIDENTS)
      })
      .finally(() => {
        if (cancelled || !aliveRef.current) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [provided, tick])

  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { residents, loading, error, reload }
}

// ══════════════════════════════════════════════════════════════
// 利用者一覧（/karte）
// ══════════════════════════════════════════════════════════════

/** マウスが行に乗り続けたら先読みするまでの時間（ms） */
const KARTE_HOVER_WARM_MS = 200

/** その方のカルテ（いま選んでいる期間）を裏で先読みする（同じ方を続けて触っても1回・失敗は黙る） */
function warmKarte(residentId: number): void {
  const toIso = todayIso()
  prefetchKarte(residentId, rangeFromIso(readRange(), toIso), toIso)
}

interface ResidentListProps {
  state: ResidentsState
}

function ResidentList({ state }: ResidentListProps) {
  const { residents, loading, error, reload } = state
  const [q, setQ] = useState('')
  const fieldId = useId()
  // マウスが行に乗り続けた時だけ先読みする（一覧の上を通り過ぎただけで全員分を取りに行かない）
  const hoverRef = useRef<number | null>(null)
  const hoverCancel = useCallback(() => {
    if (hoverRef.current !== null) window.clearTimeout(hoverRef.current)
    hoverRef.current = null
  }, [])
  const hoverStart = useCallback(
    (residentId: number) => {
      hoverCancel()
      hoverRef.current = window.setTimeout(() => {
        hoverRef.current = null
        warmKarte(residentId)
      }, KARTE_HOVER_WARM_MS)
    },
    [hoverCancel],
  )
  useEffect(() => hoverCancel, [hoverCancel])

  // 居室昇順（fetchResidents の並びを尊重しつつ、欠損は末尾に寄せる）
  const ordered = useMemo(() => {
    return residents.slice().sort((a, b) => {
      const ra = a.room ?? ''
      const rb = b.room ?? ''
      if (ra === rb) return a.id - b.id
      if (ra === '') return 1
      if (rb === '') return -1
      return ra < rb ? -1 : 1
    })
  }, [residents])

  const list = useMemo(() => {
    const key = kanaKey(q)
    if (!key) return ordered
    return ordered.filter((r) =>
      [r.name, r.kana ?? '', r.room ?? ''].some((f) => kanaKey(f).includes(key)),
    )
  }, [ordered, q])

  return (
    <div className="mx-auto w-full max-w-2xl p-4">
      <h1 className="text-xl font-heavy text-ink">カルテ（利用者一覧）</h1>
      <p className="mt-1 text-sm text-ink2">
        利用者を選ぶと、その方のバイタル・食事水分・申し送りをまとめて表示します。
      </p>

      <div className="mt-3">
        <label htmlFor={fieldId} className="block text-sm text-ink2">
          絞り込み（氏名・かな・居室）
        </label>
        <input
          id={fieldId}
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
          placeholder="氏名の一部を入力"
          className="mt-1 min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink"
        />
      </div>

      <div className="mt-3">
        {loading && residents.length === 0 ? (
          <LoadingBlock label="利用者の一覧を読み込み中です…" />
        ) : error && residents.length === 0 ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : residents.length === 0 ? (
          <EmptyBlock message="利用者の一覧がまだありません。設定タブでマスタ同期を実行してください。" />
        ) : list.length === 0 ? (
          <EmptyBlock
            message="該当する利用者がいません。入力した文字を減らしてお試しください。"
            actionLabel="絞り込みを消す"
            onAction={() => setQ('')}
          />
        ) : (
          <>
            {error ? (
              <p className="mb-2 text-sm text-warn">
                <span aria-hidden="true">▲ </span>
                最新の一覧を取得できませんでした。表示は前回取得した内容です。
              </p>
            ) : null}
            <p className="mb-2 text-sm text-ink2">
              <span className="tabular">{list.length}</span> 名
            </p>
            <ul className="space-y-2">
              {list.map((r) => (
                <li key={r.id}>
                  <Link
                    to={`/karte/${r.id}`}
                    // 行に指が触れた（押し始め・フォーカス・マウスが乗り続けた）時に、その方のカルテを裏で先読みする
                    onPointerDown={() => warmKarte(r.id)}
                    onFocus={() => warmKarte(r.id)}
                    onMouseEnter={() => hoverStart(r.id)}
                    onMouseLeave={hoverCancel}
                    className="flex min-h-tap w-full items-center gap-gap rounded border border-border bg-surface px-3 py-2 text-base text-ink"
                  >
                    <span className="tabular w-14 shrink-0 text-sm text-ink3">{r.room ?? '—'}</span>
                    <span className="flex-1 truncate font-bold">{r.name}</span>
                    {r.needs_review ? (
                      <span className="shrink-0 text-sm text-warn">
                        <span aria-hidden="true">▲</span>
                        <span className="sr-only">要確認</span>
                      </span>
                    ) : null}
                    <span aria-hidden="true" className="shrink-0 text-ink3">
                      ›
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// バイタル折れ線（自前SVG・外部チャートライブラリ不使用）
// ══════════════════════════════════════════════════════════════

const LEVEL_POINT_FILL: Record<Exclude<Level, null>, string> = {
  'danger-high': 'fill-danger',
  'warn-high': 'fill-warn',
  'warn-low': 'fill-warn',
  'danger-low': 'fill-info',
}

interface SeriesSpec {
  label: string
  values: Map<string, number>
  /** 線・点の色 */
  strokeClass: string
  fillClass: string
  /** 2本目の系列は破線にして色以外でも区別できるようにする */
  dashed?: boolean
  /** 点の段階。day＝その点の日（段階2d-2: 個人の閾値はその日の基準で判定する。日の無い系列は省いてよい） */
  level(v: number | null, day?: string): Level
  /** しきい値を外れた点の脇の記号（未指定は LEVEL_MARK の ↑↓。食事は表と同じ ▲） */
  levelMark?: string
  /** タップした値の表示で記号の代わりに出す言葉（未指定は levelMark／LEVEL_MARK） */
  levelLabel?: string
  /** 点ごとの記号（体温の「平熱+1.2↑」・A1）。返した文字が levelMark／LEVEL_MARK より優先。null は既定の記号 */
  markOf?(v: number, day?: string): string | null
  /** 点ごとの注記（体温の「平熱+1.2」）。タップした値の表示と数値の表に添える。null は添えない */
  noteOf?(v: number, day?: string): string | null
}

interface BandSpec {
  /** 帯の下端・上端（値） */
  lo: number
  hi: number
  className: string
  /** 帯端に置くしきい値の数値ラベル（色だけに頼らないための併記） */
  label: string
  labelAt: number
}

interface RefLineSpec {
  y: number
  label: string
  className: string
  /** 線の刻み（未指定は今までの '4 3'。平熱は点線 '1.5 3'） */
  dash?: string
  /** 文字を左の列ではなく線の右端の上に置く（平熱。左の列の幅を変えないため） */
  inline?: boolean
}

interface PanelSpec {
  key: string
  title: string
  unit: string
  digits: number
  /** 縦軸（記録の値に合わせて拡大する範囲・最小の幅・目盛の刻み。lib/chart.ts の KARTE_AXES） */
  axis: AxisSpec
  series: SeriesSpec[]
  bands: BandSpec[]
  refs: RefLineSpec[]
  legend?: string
  /** しきい値の無い指標（体重）。読み上げの「しきい値を外れた記録」を言わない */
  noLevels?: boolean
  /** 数値表の読み上げ用の説明（未指定はバイタルの既定文） */
  caption?: string
  /** 読み上げの「しきい値を外れた記録」の言い換え（食事は「低摂取（6以下）の日」） */
  alertWord?: string
  /** 読み上げに足す説明（平熱・個別の下限。グラフの中の線の文字は読み上げられないため言葉でも伝える） */
  speech?: string
  /** 段階2d-2: 個人の基準で判定している時の注記（題の横に1行。個人の基準が無い方は出さない） */
  note?: string
}

/** グラフを描く枠の実測値（幅・軸の文字の大きさ・左の列でいちばん長い文字の幅・画面の高さから決めたグラフの高さ） */
interface ChartBox {
  width: number
  fs: number
  labelW: number
  /** 日付1つの幅（DATE_PROBE_TEXT） */
  dateW: number
  /** 曜日を省いた日付1つの幅（DATE_SHORT_PROBE_TEXT） */
  dateShortW: number
  /** 点の脇の記号1文字の幅 */
  markCharW: number
  h: number
}

/**
 * コンテナ幅と軸の文字の大きさを実測する（viewBox を CSS px と 1:1 にしてヒット領域を実寸にするため）。
 * 文字の大きさは枠の中に置いた見えない見本（AXIS_PROBE_TEXT・text-2xs）で測る（端末の文字サイズ設定に追従する）。
 * グラフの高さも同じ時に測る（画面の回転・文字の大きさの変更で見本・枠・画面の大きさが変わった時）。
 * 印刷の直前は KARTE_REMEASURE_EVENT で同期して測り直す（印刷の割り付けより先に今までの幅へ戻すため）
 */
function useChartBox() {
  const ref = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLSpanElement>(null)
  const [box, setBox] = useState<ChartBox>({
    width: CHART_DEFAULT_W,
    fs: AXIS_FS_DEFAULT,
    labelW: 0,
    dateW: 0,
    dateShortW: 0,
    markCharW: AXIS_FS_DEFAULT,
    h: CHART_H_MIN,
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const w = Math.round(el.getBoundingClientRect().width)
      const probe = probeRef.current
      const fsRaw = probe ? parseFloat(getComputedStyle(probe).fontSize) : NaN
      const fs = Number.isFinite(fsRaw) && fsRaw > 0 ? fsRaw : AXIS_FS_DEFAULT
      const partW = (k: number) => {
        const part = probe?.children[k]
        return part ? Math.ceil(part.getBoundingClientRect().width) : 0
      }
      const next: ChartBox = {
        width: Math.max(CHART_MIN_W, w || CHART_DEFAULT_W),
        fs,
        labelW: partW(0),
        dateW: partW(1) || Math.ceil(fs * 5.5),
        dateShortW: partW(3) || Math.ceil(fs * 3),
        markCharW: partW(2) / 2 || fs,
        h: measureChartH(document.querySelector<HTMLElement>('[data-karte-bar]')),
      }
      setBox((prev) =>
        (Object.keys(next) as (keyof ChartBox)[]).every((k) => prev[k] === next[k]) ? prev : next,
      )
    }
    const updateNow = () => flushSync(update)
    update()
    window.addEventListener(KARTE_REMEASURE_EVENT, updateNow)
    window.addEventListener('resize', update)
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update)
      ro.observe(el)
      if (probeRef.current) ro.observe(probeRef.current)
      // 氏名バー・アプリのヘッダの高さが変わった時（文字の大きさ・幅で折り返す）も高さを測り直す
      const bar = document.querySelector<HTMLElement>('[data-karte-bar]')
      if (bar) ro.observe(bar)
      const shell = findShellHeader()
      if (shell) ro.observe(shell)
    }
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener(KARTE_REMEASURE_EVENT, updateNow)
    }
  }, [])
  return { ref, probeRef, box }
}

/** 軸の文字の大きさ・幅を測る見本（見えない・読み上げない・押せない）。並びは useChartBox の partW の番号と対応 */
function AxisProbe({ probeRef }: { probeRef: RefObject<HTMLSpanElement> }) {
  return (
    <span
      ref={probeRef}
      aria-hidden="true"
      className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap text-2xs"
    >
      <span className="font-bold">{AXIS_PROBE_TEXT}</span>
      <span>{DATE_PROBE_TEXT}</span>
      <span>{MARK_PROBE_TEXT}</span>
      <span>{DATE_SHORT_PROBE_TEXT}</span>
    </span>
  )
}

interface VitalChartProps {
  panel: PanelSpec
  days: string[]
  box: ChartBox
  /** グラフの高さ（px）。height と viewBox の両方に渡す */
  height: number
}

function VitalChart({ panel, days, box, height }: VitalChartProps) {
  const { width, fs, labelW, dateW, dateShortW, markCharW } = box
  const [selected, setSelected] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // 期間や指標が変わったら選択を解除する（別の日の値を指したままにしない）
  useEffect(() => {
    setSelected(null)
  }, [panel.key, days.length])

  // 余白は文字の大きさに合わせる（文字100%では今までの 48/12/22。左は「上151↑」の実測幅＋目盛との間隔）
  const padL = Math.max(PAD_L_MIN, labelW + AXIS_LABEL_GAP + 2)
  const padT = Math.max(PAD_T_MIN, Math.ceil(fs * 0.7) + 2)
  const padB = Math.max(PAD_B_MIN, Math.ceil(fs * 1.25) + 2)
  /** 左の列の文字1行ぶんの高さ（これより近い文字は並べない） */
  const lineH = Math.ceil(fs * 1.2)
  /** 文字の中心から並べる基準線までのずれ（text-2xs 13px で今までの +4） */
  const baselineDy = Math.round(fs * 0.3)
  const dateDy = Math.max(6, Math.ceil(fs * 0.35))
  // 期間の両端の日付が1行に並ばない幅（文字を大きくした狭い画面）では曜日を省き、それでも並ばなければ終わりの日付を2行目に回す
  const dateRoom = width - padL - PAD_R
  const datesShort = dateRoom < dateW * 2 + 8
  const datesTwoRows = datesShort && dateRoom < dateShortW * 2 + 8
  const dateText = (iso: string) => (datesShort ? fmtDayShort(iso) : fmtDayLabel(iso))
  const plotW = Math.max(1, width - padL - PAD_R)
  const plotH = Math.max(1, height - padT - padB - (datesTwoRows ? lineH : 0))
  const n = days.length

  // 縦軸は記録の値に合わせて拡大する（しきい値・帯は範囲に入れない。範囲外のしきい値は軸の端に「38.1↑」で示す）
  const domain = useMemo<[number, number]>(() => {
    const vals: number[] = []
    for (const s of panel.series) for (const v of s.values.values()) vals.push(v)
    return chartDomain(vals, panel.axis)
  }, [panel])

  const x = useCallback(
    (i: number) => (n <= 1 ? padL + plotW / 2 : padL + (i * plotW) / (n - 1)),
    [n, plotW, padL],
  )
  const y = useCallback(
    (v: number) => {
      const span = domain[1] - domain[0] || 1
      const raw = padT + (1 - (v - domain[0]) / span) * plotH
      return Math.min(padT + plotH, Math.max(padT, raw))
    },
    [domain, plotH, padT],
  )

  /** しきい値（帯の端・基準線）を範囲の内と外に分ける */
  const thresholds = useMemo(
    () =>
      splitThresholds(
        [
          ...panel.bands.map((b) => ({ value: b.labelAt, label: b.label })),
          ...panel.refs.filter((r) => !r.inline).map((r) => ({ value: r.y, label: r.label })),
        ],
        domain,
      ),
    [panel, domain],
  )

  /** 目盛（区切りのよい値。文字が重なる間隔なら刻みを広げる） */
  const ticks = useMemo(
    () => chartTicks(domain, panel.axis.step, plotH, Math.max(28, lineH * 1.6)),
    [domain, panel.axis.step, plotH, lineH],
  )
  const tickDigits = ticks.step < 1 ? 1 : 0

  /**
   * 左の列の文字の位置。しきい値の文字（範囲内は帯の端・基準線の高さ、範囲外は軸の上端・下端から内側へ積む）を
   * 優先して全部出し、それに近い目盛の数字は出さない（重なりを作らない）
   */
  const axisLabels = useMemo(() => {
    const fixed: { text: string; y: number }[] = []
    for (const m of thresholds.inside) fixed.push({ text: m.label, y: y(m.value) })
    thresholds.above.forEach((m, k) => fixed.push({ text: offRangeText(m.label, 'above'), y: padT + k * lineH }))
    thresholds.below.forEach((m, k) => fixed.push({ text: offRangeText(m.label, 'below'), y: padT + plotH - k * lineH }))
    const tickYs = ticks.values.map((v) => y(v))
    const placed = layoutAxisLabels(
      fixed.map((f) => f.y),
      tickYs,
      lineH,
      padT,
      padT + plotH,
    )
    return {
      fixed: fixed.map((f, i) => ({ text: f.text, y: placed.fixed[i] })),
      ticks: placed.ticks.map((i) => ({ text: fmtNum(ticks.values[i], tickDigits), y: tickYs[i] })),
    }
  }, [thresholds, ticks, tickDigits, y, padT, plotH, lineH])

  /** 記録がある日（タップで選べる日＝pickNearest の候補） */
  const filledIdx = useMemo(() => {
    const out: number[] = []
    days.forEach((d, i) => {
      if (panel.series.some((s) => s.values.has(d))) out.push(i)
    })
    return out
  }, [days, panel])

  const gap = n <= 1 ? plotW : plotW / (n - 1)
  const showMarks = gap >= MARK_MIN_GAP

  /**
   * 点の脇の記号（しきい値を外れた点）。隣の日の記号と重なるものは描かない（点の大きさ・色とタップした値・数値表で補う）。
   * 左右の端の点は記号を枠の内側へ寄せ、上端に近い点は記号を点の下に置く（切れないように）
   */
  const marks = useMemo(() => {
    const out: { key: string; x: number; y: number; text: string; cls: string }[] = []
    if (!showMarks) return out
    const boxes: [number, number, number, number][] = []
    for (const s of panel.series) {
      days.forEach((d, i) => {
        const v = s.values.get(d)
        if (v == null) return
        const lv = s.level(v, d)
        if (!lv) return
        const text = s.markOf?.(v, d) ?? s.levelMark ?? LEVEL_MARK[lv]
        const w = Math.ceil(text.length * markCharW) + 2
        const cx = Math.min(width - w / 2, Math.max(padL + w / 2, x(i)))
        let base = y(v) - 7
        if (base - fs < 0) base = y(v) + 7 + Math.ceil(fs * 0.8)
        const b: [number, number, number, number] = [cx - w / 2, cx + w / 2, base - fs, base + fs * 0.25]
        if (boxes.some((o) => o[0] < b[1] && b[0] < o[1] && o[2] < b[3] && b[2] < o[3])) return
        boxes.push(b)
        out.push({
          key: `${s.label}-mk-${d}`,
          x: cx,
          y: base,
          text,
          cls: lv === 'danger-low' ? 'fill-info' : lv === 'danger-high' ? 'fill-danger' : 'fill-warn',
        })
      })
    }
    return out
  }, [showMarks, panel, days, markCharW, width, padL, x, y, fs])

  /**
   * タップ位置にいちばん近いデータ点を選ぶ。
   * 判定域は「点から左右44px以内（HIG のタップ領域）かつ隣の点との中間まで」。
   * 点が密な期間（3か月以上）は点の間隔自体が44px未満になるため、隣の点との中間が上限になる
   * （近い方を必ず選ぶ＝取り違えを防ぐ。細かい値の読み取りは下の数値表で行う）。
   * どの点からも44pxより遠い位置のタップでは選択を変えない。
   */
  const pickNearest = useCallback(
    (clientX: number) => {
      const el = svgRef.current
      if (!el || filledIdx.length === 0) return
      const box = el.getBoundingClientRect()
      // ブラウザのズーム等で表示倍率が変わっても viewBox 座標に合わせ直す
      const scale = box.width > 0 ? width / box.width : 1
      const px = (clientX - box.left) * scale
      let best: number | null = null
      let bestDist = Infinity
      for (const i of filledIdx) {
        const d = Math.abs(x(i) - px)
        if (d < bestDist) {
          bestDist = d
          best = i
        }
      }
      if (best == null || bestDist > HIT_MIN_W) return
      setSelected((prev) => (prev === best ? null : best))
    },
    [filledIdx, width, x],
  )

  const readout = useMemo(() => {
    if (selected == null || days[selected] == null) {
      return 'グラフの点をタップすると、その日の値を表示します。'
    }
    const day = days[selected]
    const parts = panel.series.map((s) => {
      const v = s.values.get(day)
      if (v == null) return `${s.label} —（未測定）`
      const lv = s.level(v, day)
      const note = s.noteOf?.(v, day) ?? null
      return `${s.label} ${fmtNum(v, panel.digits)}${panel.unit}${lv ? ` ${s.levelLabel ?? s.levelMark ?? LEVEL_MARK[lv]}` : ''}${note ? `（${note}）` : ''}`
    })
    return `${fmtDayLabel(day)}　${parts.join('　')}`
  }, [selected, days, panel])

  const ariaLabel = useMemo(() => {
    const head = `${panel.title}の推移。${days.length > 0 ? `${fmtDayLabel(days[0])}から${fmtDayLabel(days[days.length - 1])}まで` : '期間なし'}。`
    const body = panel.series
      .map((s) => {
        const vals = Array.from(s.values.values())
        if (vals.length === 0) return `${s.label}は記録がありません。`
        const max = Math.max(...vals)
        const min = Math.min(...vals)
        const alerts = Array.from(s.values.entries()).filter(([d, v]) => s.level(v, d) != null).length
        const tail = panel.noLevels ? '' : `、${panel.alertWord ?? 'しきい値を外れた記録'}${alerts}件`
        return `${s.label}は記録${vals.length}件、最高${fmtNum(max, panel.digits)}${panel.unit}、最低${fmtNum(min, panel.digits)}${panel.unit}${tail}。`
      })
      .join('')
    // 範囲外のしきい値は SVG の中の文字（role=img のため読み上げられない）と同じことを言葉で伝える
    const off = offRangeSpeech(thresholds.above, thresholds.below)
    return `${head}${panel.speech ?? ''}${body}${off}詳しい数値はこの下の「数値の表を開く」で確認できます。`
  }, [panel, days, thresholds])

  return (
    <div>
      <svg
        ref={svgRef}
        role="img"
        aria-label={ariaLabel}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block"
        onClick={(e) => pickNearest(e.clientX)}
      >
        {/* しきい値帯（半透明の面）。表示範囲の外にはみ出す部分は切る（y が範囲の端で止まる） */}
        {panel.bands.map((b) => {
          const yTop = y(Math.max(b.hi, b.lo))
          const yBottom = y(Math.min(b.hi, b.lo))
          const h = Math.max(0, yBottom - yTop)
          if (h <= 0) return null
          return <rect key={`band-${b.label}`} x={padL} y={yTop} width={plotW} height={h} className={b.className} />
        })}

        {/* 目盛の線（区切りのよい値） */}
        {ticks.values.map((v) => (
          <line
            key={`grid-${v}`}
            x1={padL}
            x2={padL + plotW}
            y1={y(v)}
            y2={y(v)}
            className="stroke-1 stroke-border"
          />
        ))}

        {/* しきい値の基準線（帯にすると別系列の正常値まで塗ってしまう指標に使う）。範囲外の線は描かず軸の端に数値で示す */}
        {panel.refs
          .filter((r) => r.y >= domain[0] && r.y <= domain[1])
          .map((r) => (
            <line
              key={`ref-${r.label}`}
              x1={padL}
              x2={padL + plotW}
              y1={y(r.y)}
              y2={y(r.y)}
              strokeDasharray={r.dash ?? '4 3'}
              className={`stroke-1 ${r.className}`}
            />
          ))}
        {/* 線の右端の上に置く文字（平熱。左の列の幅を変えない） */}
        {panel.refs
          .filter((r) => r.inline && r.y >= domain[0] && r.y <= domain[1])
          .map((r) => (
            <text
              key={`refl-${r.label}`}
              x={padL + plotW - 2}
              y={Math.max(padT + fs, y(r.y) - 4)}
              textAnchor="end"
              className="text-2xs font-bold fill-ink2"
            >
              {r.label}
            </text>
          ))}

        {/* 左の列: しきい値の数値（範囲外は「38.1↑」「35.5↓」＝しきい値がその向きにある）と目盛の数値 */}
        {axisLabels.fixed.map((l) => (
          <text
            key={`th-${l.text}`}
            x={padL - AXIS_LABEL_GAP}
            y={l.y + baselineDy}
            textAnchor="end"
            className="text-2xs font-bold fill-ink2"
          >
            {l.text}
          </text>
        ))}
        {axisLabels.ticks.map((l) => (
          <text
            key={`tick-${l.text}`}
            x={padL - AXIS_LABEL_GAP}
            y={l.y + baselineDy}
            textAnchor="end"
            className="tabular text-2xs fill-ink2"
          >
            {l.text}
          </text>
        ))}

        {/* 外枠（下辺・左辺） */}
        <line
          x1={padL}
          x2={padL + plotW}
          y1={padT + plotH}
          y2={padT + plotH}
          className="stroke-1 stroke-border"
        />
        <line
          x1={padL}
          x2={padL}
          y1={padT}
          y2={padT + plotH}
          className="stroke-1 stroke-border"
        />

        {/* 選択中の日を示す縦線 */}
        {selected != null ? (
          <line
            x1={x(selected)}
            x2={x(selected)}
            y1={padT}
            y2={padT + plotH}
            className="stroke-1 stroke-border-strong"
          />
        ) : null}

        {/* 折れ線（欠測日で線を切る＝補間しない） */}
        {panel.series.map((s) =>
          lineSegments(days, s.values).map((seg, si) => (
            <polyline
              key={`${s.label}-seg-${si}`}
              points={seg.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')}
              fill="none"
              strokeDasharray={s.dashed ? '5 4' : undefined}
              className={`stroke-2 ${s.strokeClass}`}
            />
          )),
        )}

        {/* データ点（しきい値超過は大きめの点＋記号を併記＝色だけに頼らない） */}
        {panel.series.map((s) =>
          days.map((d, i) => {
            const v = s.values.get(d)
            if (v == null) return null
            const lv = s.level(v, d)
            return (
              <circle
                key={`${s.label}-pt-${d}`}
                cx={x(i)}
                cy={y(v)}
                r={lv || selected === i ? POINT_R_ALERT : POINT_R}
                className={lv ? LEVEL_POINT_FILL[lv] : s.fillClass}
              />
            )
          }),
        )}
        {marks.map((m) => (
          <text key={m.key} x={m.x} y={m.y} textAnchor="middle" className={`text-2xs ${m.cls}`}>
            {m.text}
          </text>
        ))}

        {/* 期間の両端の日付 */}
        {days.length > 0 ? (
          <>
            <text
              x={padL}
              y={height - dateDy - (datesTwoRows ? lineH : 0)}
              textAnchor="start"
              className="text-2xs fill-ink3"
            >
              {dateText(days[0])}
            </text>
            <text
              x={padL + plotW}
              y={height - dateDy}
              textAnchor="end"
              className="text-2xs fill-ink3"
            >
              {dateText(days[days.length - 1])}
            </text>
          </>
        ) : null}

        {/* タップ判定の受け皿（グラフ全面。押した位置から最も近いデータ点を選ぶ＝pickNearest）。
            日ごとに矩形を置くと期間が長いとき判定域が重なって隣の日を選んでしまうため、面で受ける */}
        <rect
          x={padL}
          y={padT}
          width={plotW}
          height={plotH}
          className="fill-transparent"
        />
      </svg>

      {/* タップした点の値（SVG 内の浮動ボックスにしないのは、文字サイズ200%でも崩れないようにするため） */}
      <p role="status" aria-live="polite" className="tabular mt-1 min-h-tap text-sm text-ink2">
        {readout}
      </p>
    </div>
  )
}

interface VitalPanelProps {
  panel: PanelSpec
  days: string[]
  box: ChartBox
  height: number
}

/** 1指標のパネル（見出し＋グラフ＋数値表フォールバック） */
function VitalPanel({ panel, days, box, height }: VitalPanelProps) {
  // 表は開いたときに組み立てる（1年表示×4パネルで数千ノードになるのを避ける）
  const [tableOpen, setTableOpen] = useState(false)
  const rows = useMemo(
    () => days.filter((d) => panel.series.some((s) => s.values.has(d))).reverse(),
    [days, panel],
  )

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="flex flex-wrap items-baseline gap-gap">
        <h3 className="text-lg font-bold text-ink">{panel.title}</h3>
        {panel.unit ? <span className="text-sm text-ink2">単位 {panel.unit}</span> : null}
        {panel.legend ? <span className="text-sm text-ink2">{panel.legend}</span> : null}
        {panel.note ? <span className="text-sm font-bold text-ink">{panel.note}</span> : null}
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-base text-ink2">
          <span aria-hidden="true">— </span>
          この期間の記録はありません。
        </p>
      ) : (
        <>
          <VitalChart panel={panel} days={days} box={box} height={height} />
          <details
            className="mt-2"
            onToggle={(e) => setTableOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="inline-flex min-h-tap items-center text-base text-link">
              数値の表を開く（<span className="tabular">{rows.length}</span>日分）
            </summary>
            <div className="mt-2 overflow-x-auto">
              {tableOpen ? (
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">
                    {panel.caption ??
                      `${panel.title}の記録（新しい日が上。同じ日に複数回の記録がある場合は定時測定を優先）`}
                  </caption>
                  <thead>
                    <tr className="border-b border-border-strong text-ink2">
                      <th scope="col" className="py-2 pr-2 text-left font-bold">
                        日付
                      </th>
                      {panel.series.map((s) => (
                        <th key={s.label} scope="col" className="py-2 pr-2 text-right font-bold">
                          {s.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((d) => (
                      <tr key={d} className="border-b border-border">
                        <th scope="row" className="py-2 pr-2 text-left font-normal text-ink">
                          {fmtDayLabel(d)}
                        </th>
                        {panel.series.map((s) => {
                          const v = s.values.get(d) ?? null
                          const note = v == null ? null : (s.noteOf?.(v, d) ?? null)
                          return (
                            <td key={s.label} className="py-2 pr-2 text-right">
                              <LevelCell value={v} level={s.level(v, d)} digits={panel.digits} />
                              {note ? <span className="ml-1 text-sm font-bold text-warn">{note}</span> : null}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          </details>
        </>
      )}
    </div>
  )
}

interface VitalsSectionProps {
  vitals: Vital[]
  days: string[]
  /** 体重のパネル（2026-09-27 追加）。既存4パネルの後ろに足すだけ。取得できていない時は null */
  weightPanel?: PanelSpec | null
  /** 印刷中（グラフは今までと同じ高さ 160px で描く） */
  printing: boolean
  /** 平熱（A1。5回未満・読めない時は null、読み込み中は undefined） */
  usual: number | null | undefined
  /** 平熱の行が無かった（定時の体温が無い・読めない）。null の理由の言い分けだけに使う */
  usualAbsent?: boolean
  /** 平熱を出すのに数えた定時の体温の回数（無ければ null） */
  usualSamples?: number | null
  /** 個別の目標（A9 の SpO2 の下限。無ければ undefined） */
  target: ResidentTargets | undefined
  /**
   * 段階2d-2: 個人の閾値の行（その方の分を含む全員分でよい）とその方の id。省く・行が null（読めない）なら全部の日が施設の基準。
   * 基準の口（thresholdsLookup）は組み立てる時に、その時の施設の基準で作る（施設の基準は読み込みの後に差し替わるため）
   */
  limits?: { rows: readonly ResidentVitalLimit[] | null; residentId: number }
}

function VitalsSection({ vitals, days, weightPanel, printing, usual, usualAbsent = false, usualSamples = null, target, limits }: VitalsSectionProps) {
  const { ref, probeRef, box } = useChartBox()
  const chartH = printing ? CHART_H_PRINT : box.h

  const panels = useMemo<PanelSpec[]>(() => {
    const sorted = vitals.slice().sort(cmpVitalAsc)
    const temp = dailySeries(sorted, 'temp')
    const sys = dailySeries(sorted, 'sys_bp')
    const dia = dailySeries(sorted, 'dia_bp')
    const pulse = dailySeries(sorted, 'pulse')
    const spo2 = dailySeries(sorted, 'spo2')
    // 帯・基準線の数値は vitalThresholds.ts の「いまの基準値」から（A8・2026-10-16。既定値なら今までと同じ数・同じ文字）。
    // 段階2d-2: 個人の閾値がある方は、点の印はその日の基準、帯と基準線は期間の最後の日の基準（計画の質問11）
    const base = vitalThresholds()
    const lookup = thresholdsLookup(limits?.rows ?? null, base)
    const tOn = (d: string): VitalThresholds => (limits === undefined ? base : lookup(limits.residentId, d))
    const lastDay = days[days.length - 1]
    const th = lastDay === undefined ? base : tOn(lastDay)
    const individual = days.some((d) => tOn(d) !== base)
    const changed = lastChangeDay(days, tOn)
    const limitNote = individual
      ? `個人の基準で判定（カルテの「個人の閾値」）${changed !== null ? `・${changedFromText(changed)}（帯は最後の日の基準）` : ''}`
      : undefined
    // A1: 平熱（直近30日の定時の中央値）の点線と、平熱+1.0℃以上の印。今の 37.5↑・38.1↑↑・35.5↓↓ の印はそのまま（重い方を出す）
    const usualText = fmtUsualTemp(usual)
    const rise = th.usualTempRise.toFixed(1)
    const tempLevelOf = (v: number | null, day?: string): Level => {
      const j = judgeTemp(v, usual, day === undefined ? th : tOn(day))
      return j.level ?? (j.overUsual ? 'warn-high' : null)
    }
    const tDay = (day?: string) => (day === undefined ? th : tOn(day))
    // A9: SpO2 の個別の下限（医師の指示がある方だけ）。無い方は施設の基準（帯）のまま
    const lim = spo2Limits(target, th)
    return [
      {
        key: 'temp',
        title: '体温',
        unit: '℃',
        digits: 1,
        axis: KARTE_AXES.temp,
        series: [
          {
            label: '体温',
            values: temp,
            strokeClass: 'stroke-primary',
            fillClass: 'fill-primary',
            level: tempLevelOf,
            markOf: (v, day) => judgeTemp(v, usual, tDay(day)).mark,
            noteOf: (v, day) => {
              const j = judgeTemp(v, usual, tDay(day))
              return j.overUsual && j.diff !== null ? `平熱+${j.diff.toFixed(1)}` : null
            },
          },
        ],
        bands: [
          { lo: th.temp.dangerHigh, hi: 45, className: 'fill-danger-bg', label: th.temp.dangerHigh.toFixed(1), labelAt: th.temp.dangerHigh },
          { lo: th.temp.warnHigh, hi: th.temp.dangerHigh, className: 'fill-warn-bg', label: th.temp.warnHigh.toFixed(1), labelAt: th.temp.warnHigh },
          { lo: 30, hi: th.temp.dangerLow, className: 'fill-info-bg', label: th.temp.dangerLow.toFixed(1), labelAt: th.temp.dangerLow },
        ],
        refs:
          usual != null && usualText !== null
            ? [{ y: usual, label: `平熱${usualText}`, className: 'stroke-ink2', dash: '1.5 3', inline: true }]
            : [],
        legend:
          usualText !== null
            ? `点線＝平熱 ${usualText}℃（30日の定時の中央値${usualSamples !== null ? `・${usualSamples}回` : ''}）。平熱+${rise}↑＝平熱より${rise}℃以上高い`
            : usual === null
              ? usualAbsent
                ? '平熱は出せません（直近30日の定時の体温が無いか、読み込めませんでした）'
                : '平熱はまだ出していません（直近30日の定時の測定が5回未満）'
              : undefined,
        speech: usualText !== null ? `平熱は${usualText}℃（直近30日の定時の中央値）で、点線で示しています。` : undefined,
        note: limitNote,
      },
      {
        key: 'bp',
        title: '血圧',
        unit: 'mmHg',
        digits: 0,
        axis: KARTE_AXES.bp,
        // 上下2線が同じ目盛りを共有するため、下の正常値まで塗ってしまう帯は使わず基準線にする。
        // 面で示すのは「上151以上＝どちらの系列でも危険高値」の領域だけ。
        series: [
          {
            label: '上（収縮期）',
            values: sys,
            strokeClass: 'stroke-primary',
            fillClass: 'fill-primary',
            level: (v, day) => sysBpLevelBy(v, tDay(day)),
          },
          {
            label: '下（拡張期）',
            values: dia,
            strokeClass: 'stroke-link',
            fillClass: 'fill-link',
            dashed: true,
            level: (v, day) => diaBpLevelBy(v, tDay(day)),
          },
        ],
        bands: [{ lo: th.sysBp.dangerHigh, hi: 300, className: 'fill-danger-bg', label: `上${th.sysBp.dangerHigh}`, labelAt: th.sysBp.dangerHigh }],
        refs: [
          { y: th.diaBp.dangerHigh, label: `下${th.diaBp.dangerHigh}`, className: 'stroke-danger' },
          { y: th.sysBp.warnLow, label: `上${th.sysBp.warnLow}`, className: 'stroke-warn' },
          { y: th.diaBp.warnLow, label: `下${th.diaBp.warnLow}`, className: 'stroke-warn' },
        ],
        legend: '実線=上（収縮期）／破線=下（拡張期）',
        note: limitNote,
      },
      {
        key: 'pulse',
        title: '脈拍',
        unit: '回/分',
        digits: 0,
        axis: KARTE_AXES.pulse,
        series: [
          {
            label: '脈拍',
            values: pulse,
            strokeClass: 'stroke-primary',
            fillClass: 'fill-primary',
            level: (v, day) => pulseLevelBy(v, tDay(day)),
          },
        ],
        note: limitNote,
        bands: [
          { lo: th.pulse.dangerHigh, hi: 250, className: 'fill-danger-bg', label: String(th.pulse.dangerHigh), labelAt: th.pulse.dangerHigh },
          { lo: 20, hi: th.pulse.warnLow, className: 'fill-warn-bg', label: String(th.pulse.warnLow), labelAt: th.pulse.warnLow },
        ],
        refs: [],
      },
      {
        key: 'spo2',
        title: 'SpO2（経皮的動脈血酸素飽和度）',
        unit: '%',
        digits: 0,
        axis: KARTE_AXES.spo2,
        series: [
          {
            label: 'SpO2',
            values: spo2,
            strokeClass: 'stroke-primary',
            fillClass: 'fill-primary',
            level: (v, day) => spo2LevelFor(v, target, tDay(day)),
          },
        ],
        // 個別の下限がある方は、施設の基準の帯の代わりに個別の下限の線（注意・危険）を引く
        bands: lim.individual
          ? []
          : [
              { lo: 50, hi: th.spo2.dangerBelow, className: 'fill-info-bg', label: String(th.spo2.dangerBelow), labelAt: th.spo2.dangerBelow },
              { lo: th.spo2.dangerBelow, hi: th.spo2.warnBelow, className: 'fill-warn-bg', label: String(th.spo2.warnBelow), labelAt: th.spo2.warnBelow },
            ],
        refs: lim.individual
          ? [
              { y: lim.warnBelow, label: `個別${lim.warnBelow}`, className: 'stroke-warn' },
              { y: lim.dangerBelow, label: `個別${lim.dangerBelow}`, className: 'stroke-info' },
            ]
          : [],
        legend: lim.individual ? `個別の下限（医師の指示）: ${lim.warnBelow}%未満で注意・${lim.dangerBelow}%未満で危険` : undefined,
        speech: lim.individual ? `この方は個別の下限があり、${lim.warnBelow}%未満で注意、${lim.dangerBelow}%未満で危険です。` : undefined,
      },
    ]
  }, [vitals, days, usual, usualAbsent, usualSamples, target, limits])

  const hasAny = vitals.length > 0

  return (
    <SectionCard title="バイタルの推移" className="mt-4" id="karte-vitals">
      <p className="text-sm text-ink2">
        しきい値の帯・基準線は数値を併記しています。記録がない日は線を切って表示します（間を結びません）。
        同じ日に複数回の記録がある場合は定時測定を優先して1日1点で表示します。
      </p>
      <div ref={ref} className="relative">
        <AxisProbe probeRef={probeRef} />
        {!hasAny ? (
          <div className="mt-3">
            <EmptyBlock message="この期間のバイタル記録はありません。期間を広げてお試しください。" />
          </div>
        ) : (
          panels.map((p) => <VitalPanel key={p.key} panel={p} days={days} box={box} height={chartH} />)
        )}
        {weightPanel ? <VitalPanel panel={weightPanel} days={days} box={box} height={chartH} /> : null}
      </div>
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// 体重（体重管理アプリの記録を読むだけ・2026-09-27 追加）
// ══════════════════════════════════════════════════════════════

type WeightState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'error'; message: string }
  | { status: 'ready'; list: WeightEntry[]; linked: number }

/** 体重のグラフ（バイタルと同じ日付軸。測定日にだけ点＝欠測日は線でつながない既存の作法のまま） */
function buildWeightPanel(list: WeightEntry[], fromIso: string, toIso: string): PanelSpec {
  const values = new Map<string, number>()
  for (const e of list) {
    if (e.date >= fromIso && e.date <= toIso) values.set(e.date, e.weight)
  }
  return {
    key: 'weight',
    title: '体重',
    unit: 'kg',
    digits: 1,
    axis: KARTE_AXES.weight,
    series: [
      {
        label: '体重',
        values,
        strokeClass: 'stroke-primary',
        fillClass: 'fill-primary',
        level: () => null,
      },
    ],
    bands: [],
    refs: [],
    legend: '体重管理アプリの測定日だけ点で表示',
    noLevels: true,
    caption: '体重の記録（新しい日が上。体重管理アプリの測定日だけ）',
  }
}

const WEIGHT_DIFF_CLASS: Record<'up' | 'down' | 'same', string> = {
  up: 'text-warn',
  down: 'text-info',
  same: 'text-ink2',
}
const WEIGHT_DIFF_SR: Record<'up' | 'down' | 'same', string> = {
  up: '増加 ',
  down: '減少 ',
  same: '変化なし ',
}

/** 測定1行「M/D（曜） 52.3kg［車椅子］（前回53.1kg・↓−0.8）」（最新の1行と期間内の一覧で共用） */
function WeightRowLine({ row: r }: { row: WeightRow }) {
  const d = r.diff === null ? null : fmtWeightDiff(r.diff)
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-ink">
      <span className="tabular text-sm text-ink2">{fmtDayLabel(r.entry.date)}</span>
      <span className="tabular font-bold">{fmtKg(r.entry.weight)}kg</span>
      {r.entry.mode === 'chair' ? (
        <span className="rounded-full border border-info bg-info-bg px-2 text-sm text-info">車椅子</span>
      ) : null}
      <span className="tabular text-sm text-ink2">
        {r.prev === null || d === null ? (
          '（前回なし）'
        ) : (
          <>
            （前回{fmtKg(r.prev.weight)}kg・
            <span className={`font-bold ${WEIGHT_DIFF_CLASS[d.dir]}`}>
              <span className="sr-only">{WEIGHT_DIFF_SR[d.dir]}</span>
              {d.arrow ? <span aria-hidden="true">{d.arrow}</span> : null}
              {d.text}
            </span>
            ）
          </>
        )}
      </span>
    </p>
  )
}

interface WeightSectionProps {
  state: WeightState
  fromIso: string
  toIso: string
  sourceId: string
  onReload(): void
}

/** 期間内の測定を新しい順に「M/D（曜） 52.3kg（前回53.1kg・↓−0.8）」。前回は期間外の測定でもよい */
function WeightSection({ state, fromIso, toIso, sourceId, onReload }: WeightSectionProps) {
  const rows = useMemo(
    () => (state.status === 'ready' ? weightRowsInRange(state.list, fromIso, toIso) : []),
    [state, fromIso, toIso],
  )
  // 最新の1行は期間に関係なく全記録から（月1回の測定は短い期間に入らないことが多いため）
  const latest = useMemo(() => (state.status === 'ready' ? latestWeightRow(state.list) : null), [state])
  return (
    <SectionCard title="体重" className="mt-4" id="karte-weight">
      <p className="text-sm text-ink2">
        体重管理アプリで入力した体重です（この画面では読むだけです）。前回は、その測定の直前の測定です（表示期間より前も含みます）。
      </p>
      <div className="mt-2">
        {state.status === 'loading' ? (
          <LoadingBlock label="体重を読み込み中です…（体重管理アプリのサーバーが混んでいる時は30秒ほどかかります）" />
        ) : state.status === 'error' ? (
          <ErrorBlock message={state.message} onRetry={onReload} />
        ) : state.status === 'unconfigured' ? (
          <p className="text-base text-ink2">
            <span aria-hidden="true">ⓘ </span>
            {MSG_WEIGHT_UNCONFIGURED}
          </p>
        ) : latest === null ? (
          <p className="text-base text-ink2">
            <span aria-hidden="true">ⓘ </span>
            {state.status === 'ready' && state.linked === 0 ? MSG_WEIGHT_UNLINKED : MSG_WEIGHT_NO_RECORDS}
          </p>
        ) : (
          <>
            <div className="rounded-md border border-border-strong bg-surface2 p-3">
              <h3 className="text-sm font-bold text-ink2">最新</h3>
              <WeightRowLine row={latest} />
            </div>
            {rows.length === 0 ? (
              <p className="mt-2 text-base text-ink2">{MSG_WEIGHT_NONE_IN_RANGE}</p>
            ) : (
              <>
                <h3 className="mt-3 text-sm font-bold text-ink2">表示期間内の測定</h3>
                <ul className="mt-2 space-y-2">
                  {rows.map((r) => (
                    <li key={r.entry.date} className="rounded-md border border-border bg-surface p-3">
                      <WeightRowLine row={r} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-gap">
        <a
          href={weightAppHref(sourceId)}
          className="inline-flex min-h-tap items-center rounded border border-border-strong px-4 text-base text-link"
        >
          体重管理アプリを開く<span aria-hidden="true"> ›</span>
        </a>
        {state.status === 'error' ? null : (
          <button
            type="button"
            onClick={onReload}
            disabled={state.status === 'loading'}
            className="min-h-tap rounded border border-border-strong px-4 text-base text-ink disabled:text-ink3"
          >
            体重を読み直す
          </button>
        )}
      </div>
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// 食事・水分の履歴表
// ══════════════════════════════════════════════════════════════

const TABLE_SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner']
const SLOT_HEAD: Record<MealSlot, string> = { breakfast: '朝', lunch: '昼', dinner: '夕', snack: '間食' }

interface MealCellProps {
  meal: Meal | undefined
  /** マスの地に濃淡を付けている（A6）。欠食の文字はマスの文字色（濃淡の色）のまま出す */
  shaded?: boolean
}

function MealCell({ meal, shaded = false }: MealCellProps) {
  if (!meal) {
    return (
      <>
        <span className="sr-only">記録なし</span>
        <span aria-hidden="true" className="text-ink3">
          —
        </span>
      </>
    )
  }
  if (meal.status && meal.status !== 'eaten') {
    // 欠食（外出・入院・拒食）は文字で示す（色だけに頼らない）
    return <span className={shaded ? '' : 'text-ink2'}>{MEAL_STATUS_LABEL[meal.status]}</span>
  }
  const main = meal.main_amount
  const side = meal.side_amount
  if (main == null && side == null) {
    return (
      <>
        <span className="sr-only">記録なし</span>
        <span aria-hidden="true" className="text-ink3">
          —
        </span>
      </>
    )
  }
  const low = isLowIntake(meal)
  return (
    <span className={low ? 'tabular rounded-sm bg-warn-bg px-1 text-warn font-bold' : 'tabular'}>
      {low ? (
        <>
          <span aria-hidden="true">▲</span>
          <span className="sr-only">低摂取 </span>
        </>
      ) : null}
      {main ?? '—'}／{side ?? '—'}
    </span>
  )
}

/** 水分の日合計と目標との比（A3）「800／1,200ml（67%）」と横棒（棒は飾り＝読み上げは文字で伝える） */
function FluidCell({ total, target }: { total: number; target: ResidentTargets | undefined }) {
  const fp = fluidProgress(total, target)
  // 文字は「800／1,200ml（67%）」。狭い画面では（67%）の前で折り返す（食事のマスを押しつぶさない）
  const cut = fp.label.indexOf('（')
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="flex flex-wrap justify-end">
        <span className="whitespace-nowrap">{cut > 0 ? fp.label.slice(0, cut) : fp.label}</span>
        {cut > 0 ? <span className="whitespace-nowrap">{fp.label.slice(cut)}</span> : null}
      </span>
      <span aria-hidden="true" data-fluid-bar="" className="block h-2 w-24 overflow-hidden rounded-full border border-border-strong bg-surface2">
        <span className="block h-full bg-primary" style={{ width: `${Math.round(fp.bar * 100)}%` }} />
      </span>
    </span>
  )
}

interface MealsSectionProps {
  meals: Meal[]
  fluids: FluidIntake[]
  outings: Outing[]
  days: string[]
  /** 印刷中（グラフは今までと同じ高さ 160px で描く） */
  printing: boolean
  /** 個別の目標（A3 の水分の目標。無ければ undefined＝施設の既定） */
  target: ResidentTargets | undefined
}

/**
 * 食事のマスの地の濃淡（A6）。地は sheet.css の .cl-shade-bg-N（= var(--cl-shade-N-bg)。食事一覧と同じクラス＝印刷の灰色の階調も
 * 同じ）、文字は var(--cl-shade-N-ink)。トークンが無い間は無効な値になり、素のまま（地なし・文字色そのまま）で出る
 */
function shadeClass(stage: number): string {
  return `cl-shade-bg-${stage}`
}
function shadeStyle(stage: number): { color: string } {
  return { color: `var(--cl-shade-${stage}-ink)` }
}

function MealsSection({ meals, fluids, outings, days, printing, target }: MealsSectionProps) {
  const { ref, probeRef, box } = useChartBox()
  const chartH = printing ? CHART_H_PRINT : box.h
  // 日ごとの食事（同じ枠に複数行がある場合は id の大きい＝後から入った行）と水分の合計。表とグラフで同じ集計を使う
  const byDay = useMemo(() => mealDays(meals, fluids), [meals, fluids])
  const rows = useMemo(() => {
    // 記録がある日だけを新しい順に並べる（記録が無い日は行を作らない）
    return days
      .filter((d) => byDay.has(d) || outings.some((o) => outingCoversDay(o, d)))
      .reverse()
      .map((d) => ({
        day: d,
        meals: byDay.get(d)?.meals ?? new Map<MealSlot, Meal>(),
        fluid: byDay.get(d)?.fluid ?? null,
        outings: outings.filter((o) => outingCoversDay(o, d)),
      }))
  }, [byDay, outings, days])

  // A2: 摂取低下の連続日数（日 → 何日目。カルテが読んだ期間の中で数える＝期間の最初の日は前の日を数えていない）
  const lowStreak = useMemo(() => {
    const out = new Map<string, number>()
    for (const byDay of mealLowStreaks(meals).values()) {
      for (const [d, x] of byDay) if (x.streak > 0) out.set(d, x.streak)
    }
    return out
  }, [meals])
  const fluidTarget = fluidTargetOf(target)

  // 食事・水分のグラフ（2026-10-08 追加。バイタルと同じ日付軸・同じ部品）。
  // 主食＋副食は朝・昼・夕の1食あたりの日平均（1本の線で長い期間の傾向を読む。1食ごとの ▲低摂取 は下の表で見る）
  // 低摂取の数は vitalThresholds.ts の「いまの基準値」（表の ▲＝isLowIntake と同じ値。A8・2026-10-16）
  const lowMax = vitalThresholds().lowIntakeMax
  const panels = useMemo<PanelSpec[]>(
    () => [
      {
        key: 'meal',
        title: '主食＋副食（1食あたりの日平均）',
        unit: '',
        digits: 1,
        axis: KARTE_AXES.meal,
        series: [
          {
            label: '主食＋副食',
            values: mealIntakeSeries(byDay),
            strokeClass: 'stroke-primary',
            fillClass: 'fill-primary',
            level: (v) => (v != null && v <= lowMax ? 'warn-low' : null),
            levelMark: '▲',
            levelLabel: '▲低摂取',
          },
        ],
        bands: [],
        refs: [{ y: lowMax, label: `低摂取${lowMax}`, className: 'stroke-warn' }],
        legend: '0〜20（主食0〜10＋副食0〜10）。拒食は0、外出・入院の食事は除く',
        alertWord: `低摂取（${lowMax}以下）の日`,
        caption: '主食＋副食の1食あたりの日平均（新しい日が上。拒食は0、外出・入院の食事は除く）',
      },
      {
        key: 'fluid',
        title: '水分量',
        unit: 'ml/日',
        digits: 0,
        axis: KARTE_AXES.fluid,
        series: [
          {
            label: '水分',
            values: fluidSeries(byDay),
            strokeClass: 'stroke-primary',
            fillClass: 'fill-primary',
            level: () => null,
          },
        ],
        bands: [],
        refs: [],
        legend: '1日の合計',
        noLevels: true,
        caption: '水分量の1日の合計（新しい日が上）',
      },
    ],
    [byDay, lowMax],
  )

  return (
    <SectionCard title="食事・水分" className="mt-4" id="karte-meals">
      <p className="text-sm text-ink2">
        主食／副食は 0〜10 の数値です。▲ は低摂取（主+副が6以下）、— は記録なしを表します。
      </p>
      <p className="mt-1 text-sm text-ink2">
        マスの地は食べた量（濃いほど多い）、斜線は半分以下（主+副が10以下・拒食）です。▼摂取低下は1日に2食以上が半分以下の日です。
        水分は1日の目標（<span className="tabular">{fmtMl(fluidTarget.ml)}</span>ml・{fluidTarget.individual ? '個別の目標' : '施設の既定'}
        ）との比です。
      </p>
      {rows.length === 0 ? (
        <div className="mt-3">
          <EmptyBlock message="この期間の食事・水分の記録はありません。期間を広げてお試しください。" />
        </div>
      ) : (
        <>
          <div ref={ref} className="relative">
            <AxisProbe probeRef={probeRef} />
            {panels.map((p) => (
              <VitalPanel key={p.key} panel={p} days={days} box={box} height={chartH} />
            ))}
          </div>
          {/* 表は今までの幅のまま（広い画面で列が間延びして行を追いにくくならないように） */}
          <h3 className="mt-4 border-t border-border pt-3 text-lg font-bold text-ink">日ごとの記録</h3>
          <div className="mt-2 max-w-2xl overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                食事（主食／副食）と水分量の履歴。新しい日が上。
              </caption>
              <thead>
                <tr className="border-b border-border-strong text-ink2">
                  <th scope="col" className="py-2 pr-2 text-left font-bold">
                    日付
                  </th>
                  {TABLE_SLOTS.map((s) => (
                    <th key={s} scope="col" className="py-2 pr-2 text-right font-bold">
                      {SLOT_HEAD[s]}
                    </th>
                  ))}
                  <th scope="col" className="py-2 pr-2 text-right font-bold">
                    水分(ml)
                  </th>
                  <th scope="col" className="py-2 text-left font-bold">
                    外出・外泊
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.day} className="border-b border-border">
                    <th scope="row" className="py-2 pr-2 text-left font-normal text-ink">
                      {fmtDayLabel(r.day)}
                      {lowStreak.has(r.day) ? (
                        <span className="block text-sm font-bold text-warn">{mealLowLabel(lowStreak.get(r.day) ?? 0)}</span>
                      ) : null}
                    </th>
                    {TABLE_SLOTS.map((s) => {
                      const meal = r.meals.get(s)
                      const shade = mealShade(meal)
                      return (
                        <td
                          key={s}
                          className={`whitespace-nowrap py-2 pr-2 text-right${shade ? ` ${shadeClass(shade.stage)}` : ''}${shade?.hatched ? ' cl-shade-hatch' : ''}`}
                          style={shade ? shadeStyle(shade.stage) : undefined}
                        >
                          <MealCell meal={meal} shaded={shade !== null} />
                          {shade?.hatched ? <span className="sr-only">（半分以下）</span> : null}
                        </td>
                      )
                    })}
                    <td className="tabular py-2 pr-2 text-right text-ink">
                      {r.fluid == null ? (
                        <>
                          <span className="sr-only">記録なし</span>
                          <span aria-hidden="true" className="text-ink3">
                            —
                          </span>
                        </>
                      ) : (
                        <FluidCell total={r.fluid} target={target} />
                      )}
                    </td>
                    <td className="py-2">
                      {r.outings.length === 0 ? (
                        <span aria-hidden="true" className="text-ink3">
                          —
                        </span>
                      ) : (
                        <span className="flex flex-wrap gap-gap">
                          {r.outings.map((o) => (
                            <Chip key={o.id} tone="info">
                              {OUTING_KIND_LABEL[o.kind] ?? '外出'}
                              {o.end_on == null ? '（帰着未定）' : ''}
                            </Chip>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// 本人分の申し送り
// ══════════════════════════════════════════════════════════════

interface NoteCardProps {
  note: Note
  reporterName: string | null
}

function NoteCard({ note, reporterName }: NoteCardProps) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const tone =
    note.importance === 'critical'
      ? 'border-danger bg-danger-bg'
      : note.importance === 'important'
        ? 'border-warn bg-warn-bg'
        : 'border-border bg-surface'

  return (
    <li className={`rounded-md border p-3 ${tone}`}>
      <div className="flex flex-wrap items-center gap-gap">
        <span className="tabular text-sm text-ink2">{fmtRecordTime(note.occurred_at, noteIsNextMorning(note)) || '—'}</span>
        <span className="text-sm text-ink2">{SHIFT_LABEL[note.shift] ?? ''}</span>
        {note.importance !== 'normal' ? (
          <span
            className={`text-sm font-bold ${note.importance === 'critical' ? 'text-danger' : 'text-warn'}`}
          >
            {IMPORTANCE_LABEL[note.importance]}
          </span>
        ) : null}
        {note.ongoing ? <Chip tone="accent">継続中</Chip> : null}
        {asArray<string>(note.role_tags).map((t) => (
          <Chip key={t}>{t}</Chip>
        ))}
      </div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((v) => !v)}
        className="mt-2 min-h-tap w-full text-left"
      >
        <span id={bodyId} className={`block text-lg text-ink ${expanded ? '' : 'clamp-2'}`}>
          {note.body}
        </span>
        <span className="mt-1 block text-sm text-link">
          {expanded ? '本文を閉じる' : '本文をすべて表示'}
        </span>
      </button>
      <p className="mt-1 text-sm text-ink2">
        記入者 {reporterName ?? '—'}
        {typeof note.read_count === 'number' ? (
          <>
            {'　'}
            <span aria-hidden="true">✓</span>
            <span className="sr-only">既読 </span>
            既読 <span className="tabular">{note.read_count}</span>
          </>
        ) : null}
      </p>
    </li>
  )
}

// ══════════════════════════════════════════════════════════════
// 排泄（排便記録アプリの記録を読むだけ・2026-10-16 追加）
// ══════════════════════════════════════════════════════════════

type ExcretionState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snap: HbSnapshot }

/** 'YYYY-MM-DDTHH:MM' → '10/16（金） 9:30' */
function fmtStoolAt(dt: string): string {
  const day = dt.slice(0, 10)
  const t = dt.slice(11, 16)
  return `${fmtDayLabel(day)}${/^\d{2}:\d{2}$/.test(t) ? ` ${fmtTimeHM(t)}` : ''}`
}

/** 一覧の1日「10/16（金） 排尿 6回」＋排便・下剤の行 */
function ExcretionDayItem({ d }: { d: ExcretionDay }) {
  const empty = d.stools.length === 0 && d.laxatives.length === 0
  return (
    <li className="rounded-md border border-border bg-surface p-3">
      <p className="flex flex-wrap items-baseline gap-x-3">
        <span className="tabular text-sm font-bold text-ink">{fmtDayLabel(d.day)}</span>
        <span className="text-sm text-ink2">
          排尿 <span className="tabular">{d.urine}</span>回
        </span>
      </p>
      {empty ? (
        <p className="mt-1 text-sm text-ink3">排便・下剤の記録なし</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {d.stools.map((x, i) => (
            <li key={`s${i}`} className="flex flex-wrap gap-x-2 text-base text-ink">
              <span className="tabular text-sm text-ink2">{x.time ? fmtTimeHM(x.time) : '時刻なし'}</span>
              <span className="font-bold">排便</span>
              <span>{x.amount || '量の記載なし'}</span>
              {x.cons ? <span className="text-ink2">{x.cons}</span> : null}
            </li>
          ))}
          {d.laxatives.map((x, i) => (
            <li key={`l${i}`} className="flex flex-wrap gap-x-2 text-base text-ink">
              <span className="tabular text-sm text-ink2">{x.time ? fmtTimeHM(x.time) : '時刻なし'}</span>
              <span className="font-bold">下剤</span>
              <span>{x.medicine || '薬名の記載なし'}</span>
              {x.tablets ? <span className="tabular">{x.tablets}錠</span> : null}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

const STOOL_BOX_CLASS: Record<'ok' | 'warn' | 'danger', string> = {
  ok: 'border-border-strong bg-surface2',
  warn: 'border-warn bg-warn-bg',
  danger: 'border-danger bg-danger-bg',
}

interface ExcretionSectionProps {
  state: ExcretionState
  view: ExcretionView | null
  onReload(): void
}

/** 最後の排便から◯日（注意・危険）と、直近14日の排便・下剤・排尿の回数 */
function ExcretionSection({ state, view, onReload }: ExcretionSectionProps) {
  return (
    <SectionCard title="排泄" className="mt-4" id="karte-excretion">
      <p className="text-sm text-ink2">
        排便記録のアプリの記録です（この画面では読むだけです）。少量は1回だけでは数えず、48時間以内に少量が3回続いたら3回目で排便1回とみなします（排便記録のアプリと同じ数え方）。
      </p>
      <div className="mt-2">
        {state.status === 'loading' ? (
          <LoadingBlock label={`排便記録を読み込み中です…（排便記録のサーバーが混んでいる時は${EXCRETION_TIMEOUT_MS / 1000}秒ほどかかります）`} />
        ) : state.status === 'error' ? (
          <ErrorBlock message={state.message} onRetry={onReload} />
        ) : state.status === 'unconfigured' ? (
          <p className="text-base text-ink2">
            <span aria-hidden="true">ⓘ </span>
            {MSG_EXCRETION_UNCONFIGURED}
          </p>
        ) : view === null ? null : !view.linked ? (
          <p className="text-base text-warn">
            <span aria-hidden="true">▲ </span>
            {view.message}
          </p>
        ) : (
          <>
            {view.hospital ? (
              <div className="rounded-md border border-border-strong bg-surface2 p-3">
                <p className="text-base font-bold text-ink">
                  <span aria-hidden="true">ⓘ </span>
                  {MSG_STOOL_HOSPITAL}
                </p>
              </div>
            ) : (
              <div className={`rounded-md border p-3 ${STOOL_BOX_CLASS[view.status.level]}`}>
                <p className="text-base font-bold text-ink">
                  {view.status.level === 'ok' ? null : (
                    <span className={view.status.level === 'danger' ? 'text-danger' : 'text-warn'} aria-hidden="true">
                      {view.status.level === 'danger' ? '▲▲ ' : '▲ '}
                    </span>
                  )}
                  {stoolStatusText(view.status)}
                </p>
                <p className="mt-1 text-sm text-ink2">
                  {view.status.lastAt ? <>最後の排便 {fmtStoolAt(view.status.lastAt)}・</> : null}
                  注意 <span className="tabular">{view.status.warnD}</span>日以上・危険 <span className="tabular">{view.status.dangerD}</span>
                  日以上（排便記録のアプリの設定）
                </p>
              </div>
            )}
            <h3 className="mt-3 text-sm font-bold text-ink2">直近{EXCRETION_LIST_DAYS}日（新しい日が上）</h3>
            <ul className="mt-2 space-y-2">
              {view.days.map((d) => (
                <ExcretionDayItem key={d.day} d={d} />
              ))}
            </ul>
          </>
        )}
      </div>
      {state.status === 'error' ? null : (
        <div className="mt-3 flex flex-wrap gap-gap print:hidden">
          <button
            type="button"
            onClick={onReload}
            disabled={state.status === 'loading'}
            className="min-h-tap rounded border border-border-strong px-4 text-base text-ink disabled:text-ink3"
          >
            排便記録を読み直す
          </button>
        </div>
      )}
    </SectionCard>
  )
}

interface NotesSectionProps {
  notes: Note[]
  staffById: Map<number, string>
}

function NotesSection({ notes, staffById }: NotesSectionProps) {
  const groups = useMemo(() => {
    // 新しい日・新しい時刻が先。時刻が無い記録（夜勤等）は同じ日の末尾に置く
    const sorted = notes.slice().sort((a, b) => {
      if (a.note_on !== b.note_on) return a.note_on < b.note_on ? 1 : -1
      // 夜勤明けに前日の夜勤の欄へ書いた申し送り（「翌」）は、その日の夜の記録より新しい側（F34）
      const at = timeSortKey(a.occurred_at, noteIsNextMorning(a))
      const bt = timeSortKey(b.occurred_at, noteIsNextMorning(b))
      if (at == null && bt != null) return 1
      if (at != null && bt == null) return -1
      if (at != null && bt != null && at !== bt) return at < bt ? 1 : -1
      return b.id - a.id
    })
    const byDay = new Map<string, Note[]>()
    for (const n of sorted) {
      const list = byDay.get(n.note_on)
      if (list) list.push(n)
      else byDay.set(n.note_on, [n])
    }
    return Array.from(byDay.entries())
  }, [notes])

  return (
    <SectionCard title="この方の申し送り" className="mt-4" id="karte-notes">
      {groups.length === 0 ? (
        <div className="mt-2">
          <EmptyBlock message="この期間の申し送りはありません。期間を広げてお試しください。" />
        </div>
      ) : (
        <div className="mt-2 space-y-4">
          {groups.map(([day, list]) => (
            <div key={day}>
              <h3 className="text-sm font-bold text-ink2">
                {fmtDayLabel(day)}（<span className="tabular">{list.length}</span>件）
              </h3>
              <ul className="mt-2 space-y-2">
                {list.map((n) => (
                  <NoteCard
                    key={n.id}
                    note={n}
                    reporterName={n.reporter_id == null ? null : (staffById.get(n.reporter_id) ?? null)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// 入浴（デイ）（bath_records・0012_bath_records.sql・2026-09-26 追加）
// ══════════════════════════════════════════════════════════════

interface BathSectionProps {
  baths: BathRecord[]
  staffById: Map<number, string>
}

/** 表示期間の入浴記録を日付の新しい順に（入浴した／入浴していない・備考・記入者。自動かどうかは出さない・2026-10-01 代表指示） */
function BathSection({ baths, staffById }: BathSectionProps) {
  const sorted = useMemo(
    () =>
      baths.slice().sort((a, b) => {
        if (a.bath_on !== b.bath_on) return a.bath_on < b.bath_on ? 1 : -1
        return b.id - a.id
      }),
    [baths],
  )
  return (
    <SectionCard title="入浴（デイ）" className="mt-4" id="karte-bath">
      {sorted.length === 0 ? (
        <div className="mt-2">
          <EmptyBlock message="この期間の入浴（デイ）の記録はありません。期間を広げてお試しください。" />
        </div>
      ) : (
        <ul className="mt-2 space-y-2">
          {sorted.map((b) => (
            <li key={b.id} className="rounded-md border border-border bg-surface p-3">
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-ink">
                <span className="tabular text-sm text-ink2">{fmtDayLabel(b.bath_on)}</span>
                <span className="font-bold">{BATH_SHOWN_LABEL[bathShownOf(b.result)]}</span>
              </p>
              {b.note !== null && b.note !== '' ? (
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{b.note}</p>
              ) : null}
              <p className="mt-1 text-sm text-ink2">
                記入者 {b.recorded_by === null ? '—' : (staffById.get(b.recorded_by) ?? '—')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// 与薬（med_admin・0013_med_admin.sql・2026-09-26 追加）
// ══════════════════════════════════════════════════════════════

/** 時間帯の並び（同じ日の中で朝→昼→夕→眠前→頓服の順に出す） */
const MED_SLOT_ORDER: Record<string, number> = { morning: 0, noon: 1, evening: 2, bedtime: 3, prn: 4 }

/** ISO の時刻 → 端末の時刻 'H:MM'（読めなければ ''） */
function clockOf(iso: string | null): string {
  if (iso === null) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

interface MedSectionProps {
  meds: MedAdmin[]
}

/** 表示期間の与薬の記録を新しい順に（日付・時間帯・状態。頓服は時刻・薬・理由・効果） */
function MedSection({ meds }: MedSectionProps) {
  const sorted = useMemo(
    () =>
      meds.slice().sort((a, b) => {
        if (a.admin_on !== b.admin_on) return a.admin_on < b.admin_on ? 1 : -1
        const so = (MED_SLOT_ORDER[a.slot] ?? 9) - (MED_SLOT_ORDER[b.slot] ?? 9)
        return so !== 0 ? so : a.id - b.id
      }),
    [meds],
  )
  return (
    <SectionCard title="与薬" className="mt-4" id="karte-med">
      {sorted.length === 0 ? (
        <div className="mt-2">
          <EmptyBlock message="この期間の与薬の記録はありません。期間を広げてお試しください。" />
        </div>
      ) : (
        <ul className="mt-2 space-y-2">
          {sorted.map((m) => {
            const incident = m.status === 'dropped' || m.status === 'wrong'
            return (
              <li key={m.id} className={`rounded-md border bg-surface p-3 ${incident ? 'border-danger' : 'border-border'}`}>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-ink">
                  <span className="tabular text-sm text-ink2">{fmtDayLabel(m.admin_on)}</span>
                  <span className="font-bold">{MED_SLOT_LABEL[m.slot]}</span>
                  {m.slot === 'prn' ? (
                    <span className="tabular text-sm text-ink2">{clockOf(m.given_at)}</span>
                  ) : (
                    <span className={incident ? 'font-bold text-danger' : ''}>
                      {incident ? <span aria-hidden="true">▲ </span> : null}
                      {MED_STATUS_LABEL[m.status]}
                    </span>
                  )}
                </p>
                {m.slot === 'prn' ? (
                  <p className="mt-1 break-words text-sm text-ink">
                    薬: {m.prn_drug ?? '—'}　理由: {m.prn_reason ?? '—'}
                    {m.prn_effect !== null ? `　効果: ${m.prn_effect}` : ''}
                  </p>
                ) : null}
                {m.note !== null && m.note !== '' ? (
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{m.note}</p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// 事故・ヒヤリ（incidents・0014_incidents.sql・2026-09-26 追加）
// ══════════════════════════════════════════════════════════════

interface IncidentSectionProps {
  incidents: Incident[]
}

/** 表示期間の事故・ヒヤリハットを新しい順に（日付・区分・種別・状態） */
function IncidentSection({ incidents }: IncidentSectionProps) {
  const sorted = useMemo(
    () =>
      incidents.slice().sort((a, b) => {
        if (a.occurred_on !== b.occurred_on) return a.occurred_on < b.occurred_on ? 1 : -1
        return b.id - a.id
      }),
    [incidents],
  )
  return (
    <SectionCard title="事故・ヒヤリ" className="mt-4" id="karte-incident">
      {sorted.length === 0 ? (
        <div className="mt-2">
          <EmptyBlock message="この期間の事故・ヒヤリハットの記録はありません。期間を広げてお試しください。" />
        </div>
      ) : (
        <ul className="mt-2 space-y-2">
          {sorted.map((i) => (
            <li key={i.id}>
              {/* 行を押すと記録の画面（/incident/:id）を開く（2026-09-26 チーフ追加。カルテからは書き込まない＝開くだけ） */}
              <Link
                to={`/incident/${i.id}`}
                className={`block min-h-tap rounded-md border bg-surface p-3 ${i.kind === 'accident' ? 'border-danger' : 'border-border'}`}
              >
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-ink">
                  <span className="tabular text-sm text-ink2">{fmtDayLabel(i.occurred_on)}</span>
                  <span className={`font-bold ${i.kind === 'accident' ? 'text-danger' : ''}`}>
                    {i.kind === 'accident' ? <span aria-hidden="true">▲ </span> : null}
                    {INCIDENT_KIND_LABEL[i.kind]}
                  </span>
                  <span className="text-sm text-ink2">状態: {INCIDENT_STATUS_LABEL[i.status]}</span>
                  <span className="ml-auto text-sm text-link">
                    記録を開く<span aria-hidden="true"> ›</span>
                  </span>
                </span>
                <span className="mt-1 block break-words text-sm text-ink">種別: {typesText(i.types)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// 変更の記録（record_history・0010_record_history.sql）
// ══════════════════════════════════════════════════════════════

/** 1回に遡る日数（既定は直近14日。〔さらに前の14日〕で同じ幅ずつ遡る） */
const HISTORY_SPAN_DAYS = 14
/** 1回の取得件数の上限（14日で超える運用は無い想定。超えた時は画面で知らせる） */
const HISTORY_LIMIT = 200

const MSG_HISTORY_UNAVAILABLE = '変更の記録はまだ使えません（サーバー側の設定待ち）。'
const ERR_HISTORY =
  '変更の記録を読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'

/** 長くなりうる値（申し送りの本文）を3行まで出し、〔全文〕で展開する */
function HistoryValue({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const { head, truncated } = clampLines(text)
  return (
    <span className="whitespace-pre-wrap break-words">
      {open || !truncated ? text : head}
      {truncated ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ml-2 min-h-tap rounded border border-border-strong px-2 text-sm text-link"
        >
          {open ? '閉じる' : '全文'}
        </button>
      ) : null}
    </span>
  )
}

function HistoryItem({ entry, staffById }: { entry: RecordHistoryEntry; staffById: Map<number, string> }) {
  const staffName = (id: number): string | null => staffById.get(id) ?? null
  const changes = diffHistoryRow(entry.old_row, entry.new_row).filter((c) => {
    // 取り消し（deleted_at が入った）は見出しの「取り消し」で示すので、列の差分には重ねない
    if (entry.op === 'delete' && (c.column === 'deleted_at' || c.column === 'deleted_by')) return false
    if (historyColumnLabel(entry.table_name, c.column) === null) return false
    // 表示が同じになる変更は出さない（入浴の区分は「入浴した／入浴していない」に丸めて出すため、全身浴→シャワー浴は同じ表示）
    return fmtHistoryValue(entry.table_name, c.column, c.before, staffName) !== fmtHistoryValue(entry.table_name, c.column, c.after, staffName)
  })
  const who =
    entry.changed_by_staff === null ? null : (staffById.get(entry.changed_by_staff) ?? null)
  return (
    <li className="rounded-md border border-border bg-surface p-3">
      <p className="flex flex-wrap items-center gap-gap text-sm text-ink2">
        <span className="tabular">{fmtChangedAt(entry.changed_at)}</span>
        <span className="font-bold text-ink">{HISTORY_TABLE_LABEL[entry.table_name] ?? entry.table_name}</span>
        {entry.record_day ? <span>対象日 {fmtDayLabel(entry.record_day)}</span> : null}
        {entry.op === 'delete' ? (
          <span className="font-bold text-danger">
            <span aria-hidden="true">▲ </span>取り消し
          </span>
        ) : null}
      </p>
      {changes.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {changes.map((c) => {
            const label = historyColumnLabel(entry.table_name, c.column) ?? c.column
            // 事故・ヒヤリハットの様式の欄は、JSON を出さず変わった欄の名前だけ（氏名の写しは名前を出さない）
            if (entry.table_name === 'incidents' && c.column === 'detail') {
              const names = incidentDetailChangeLabels(c.before, c.after)
              return (
                <li key={c.column} className="text-base text-ink">
                  <span className="font-bold">{label}</span>：{names.length > 0 ? names.join('・') : '（変更なし）'}
                </li>
              )
            }
            const before = fmtHistoryValue(entry.table_name, c.column, c.before, staffName)
            const after = fmtHistoryValue(entry.table_name, c.column, c.after, staffName)
            return (
              <li key={c.column} className="text-base text-ink">
                <span className="font-bold">{label}</span>：<HistoryValue text={before} />
                <span aria-hidden="true"> → </span>
                <span className="sr-only">から</span>
                <HistoryValue text={after} />
                <span className="sr-only">へ</span>
              </li>
            )
          })}
        </ul>
      ) : entry.op === 'delete' ? null : (
        <p className="mt-2 text-sm text-ink3">画面に出す項目の変更はありません。</p>
      )}
      <p className="mt-1 text-sm text-ink2">操作者 {who ?? '不明'}</p>
    </li>
  )
}

interface HistorySectionProps {
  residentId: number
  staffById: Map<number, string>
}

/**
 * 変更の記録（直近14日から、〔さらに前の14日〕で遡る）。
 * 表が無い（0010 未適用）時は「まだ使えません」とだけ出し、カルテの他の欄はそのまま動く。
 */
function HistorySection({ residentId, staffById }: HistorySectionProps) {
  const [entries, setEntries] = useState<RecordHistoryEntry[]>([])
  /** 読み込み済みの最も古い日（次に遡る時はこの前日から14日） */
  const [oldest, setOldest] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'unavailable'>('loading')
  const [more, setMore] = useState(false)
  const [capped, setCapped] = useState(false)
  const [tick, setTick] = useState(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 最初の14日（利用者・再試行が変わるたびに取り直す）
  useEffect(() => {
    let cancelled = false
    const toIso = todayIso()
    const fromIso = addDays(toIso, -(HISTORY_SPAN_DAYS - 1))
    setState('loading')
    setEntries([])
    setOldest(null)
    setCapped(false)
    fetchRecordHistory({ residentId, fromIso, toIso, limit: HISTORY_LIMIT })
      .then((res) => {
        if (cancelled || !aliveRef.current) return
        if (!res.available) {
          setState('unavailable')
          return
        }
        setEntries(res.entries)
        setOldest(fromIso)
        setCapped(res.entries.length >= HISTORY_LIMIT)
        setState('ready')
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [residentId, tick])

  const loadOlder = useCallback(() => {
    if (oldest === null || more) return
    const toIso = addDays(oldest, -1)
    const fromIso = addDays(toIso, -(HISTORY_SPAN_DAYS - 1))
    setMore(true)
    fetchRecordHistory({ residentId, fromIso, toIso, limit: HISTORY_LIMIT })
      .then((res) => {
        if (!aliveRef.current) return
        if (!res.available) {
          setState('unavailable')
          return
        }
        setEntries((prev) => [...prev, ...res.entries])
        setOldest(fromIso)
        if (res.entries.length >= HISTORY_LIMIT) setCapped(true)
      })
      .catch(() => {
        // 遡れなかっただけ。読めている分はそのまま出し、ボタンでもう一度押せる
      })
      .finally(() => {
        if (aliveRef.current) setMore(false)
      })
  }, [more, oldest, residentId])

  return (
    <SectionCard title="変更の記録" className="mt-4" id="karte-history">
      {state === 'loading' ? (
        <LoadingBlock label="変更の記録を読み込み中です…" />
      ) : state === 'error' ? (
        <ErrorBlock message={ERR_HISTORY} onRetry={() => setTick((n) => n + 1)} />
      ) : state === 'unavailable' ? (
        <p className="text-base text-ink2">
          <span aria-hidden="true">ⓘ </span>
          {MSG_HISTORY_UNAVAILABLE}
        </p>
      ) : (
        <>
          {oldest !== null ? (
            <p className="tabular text-sm text-ink3">
              {fmtDayLabel(oldest)} 〜 {fmtDayLabel(todayIso())} の記録の変更（{entries.length}件）
            </p>
          ) : null}
          {capped ? (
            <p className="mt-1 text-sm text-warn">
              <span aria-hidden="true">▲ </span>
              変更が多いため、14日ごとに新しい方から{HISTORY_LIMIT}件までを表示しています。
            </p>
          ) : null}
          {entries.length === 0 ? (
            <p className="mt-2 text-base text-ink2">この期間に変更された記録はありません。</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {entries.map((e) => (
                <HistoryItem key={e.id} entry={e} staffById={staffById} />
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={loadOlder}
            disabled={more || oldest === null}
            className="mt-3 min-h-tap rounded border border-border-strong px-4 text-base text-ink disabled:text-ink3"
          >
            {more ? '読み込み中…' : 'さらに前の14日'}
          </button>
        </>
      )}
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// 個別の目標（A3 の水分・A9 の SpO2。resident_targets・0034・2026-10-16）
// ══════════════════════════════════════════════════════════════
// 誰でも値を見られる。書けるのは事務・管理者のログイン（canEditTargets）だけで、現場には入力欄を出さない
// （サーバーの RLS でも止まる）。保存は saveResidentTargets（rev 照合）。他の端末が先に変えていた（'conflict'）時は
// 最新を読み直して見せ、「入力した値で保存し直す」か「最新の値に合わせる」かを選んでもらう。失敗の文言はそのまま出し、
// 入力は消さない。氏名・値は localStorage に置かない。

/** 入力欄の文字 → 値（空＝施設の既定に戻す null。数字以外は NaN＝検証で止める） */
function parseTargetField(raw: string): number | null {
  const t = raw.trim()
  if (t === '') return null
  return /^\d+$/.test(t) ? Number(t) : Number.NaN
}

const fieldOf = (v: number | null | undefined): string => (v == null ? '' : String(v))

const TARGETS_NOT_NUMBER = '数字（半角・整数）で入れてください。空にすると施設の既定に戻ります。入力は消えていません。'
const TARGETS_SAVE_FAILED = '個別の目標を保存できませんでした。通信状況を確認して、もう一度お試しください。入力は消えていません。'
const TARGETS_CONFLICT =
  '他の端末で先に個別の目標が変わりました。最新の値を下に出しています。入力した値で保存し直すか、最新の値に合わせるかを選んでください。'
const TARGETS_RELOAD_FAILED = '他の端末で先に変わったようですが、最新の値を読み込めませんでした。少し待ってから、もう一度保存してください。入力は消えていません。'

interface TargetsCardProps {
  residentId: number
  /** この方の目標（無い＝施設の既定。読み込み中・読めなかった時も undefined） */
  target: ResidentTargets | undefined
  /** 目標を読み込めたか（'loading'・'ready'・'error'） */
  state: 'loading' | 'ready' | 'error'
  onReload(): void
  /** 保存・読み直しで分かった最新の目標を親へ返す（null＝この方の目標の行が無い） */
  onLatest(t: ResidentTargets | null): void
  /** 平熱（null＝出せない・undefined＝読み込み中） */
  usual: number | null | undefined
  /** 平熱の行が無かった（定時の体温が無い・読めない） */
  usualAbsent: boolean
  /** 平熱を出すのに数えた定時の体温の回数（無ければ null） */
  usualSamples: number | null
  role: MyRole | null | undefined
}

function describeTargets(t: ResidentTargets | null | undefined): string {
  const f = fluidTargetOf(t)
  const lim = spo2Limits(t)
  return `水分 ${fmtMl(f.ml)}ml/日（${f.individual ? '個別' : '施設の既定'}）・SpO2 ${lim.warnBelow}%未満で注意／${lim.dangerBelow}%未満で危険（${lim.individual ? '個別' : '施設の基準'}）`
}

function TargetsCard({ residentId, target, state, onReload, onLatest, usual, usualAbsent, usualSamples, role }: TargetsCardProps) {
  const canEdit = canEditTargets(role)
  const uid = useId()
  const [open, setOpen] = useState(false)
  const [fluidIn, setFluidIn] = useState('')
  const [warnIn, setWarnIn] = useState('')
  const [dangerIn, setDangerIn] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null)
  /** 競合の後に読み直した最新（undefined＝競合していない・null＝最新は「目標なし」） */
  const [latest, setLatest] = useState<ResidentTargets | null | undefined>(undefined)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  // 利用者が変わったら入力・案内を持ち越さない
  useEffect(() => {
    setOpen(false)
    setMsg(null)
    setLatest(undefined)
  }, [residentId])

  const f = fluidTargetOf(target)
  const lim = spo2Limits(target)
  const usualText = fmtUsualTemp(usual)

  const startEdit = () => {
    setFluidIn(fieldOf(target?.fluid_target_ml))
    setWarnIn(fieldOf(target?.spo2_warn_below))
    setDangerIn(fieldOf(target?.spo2_danger_below))
    setMsg(null)
    setLatest(undefined)
    setOpen(true)
  }

  const save = async (current: ResidentTargets | null) => {
    if (busy) return
    const input: ResidentTargetsInput = {
      fluid_target_ml: parseTargetField(fluidIn),
      spo2_warn_below: parseTargetField(warnIn),
      spo2_danger_below: parseTargetField(dangerIn),
    }
    if ([input.fluid_target_ml, input.spo2_warn_below, input.spo2_danger_below].some((v) => v !== null && Number.isNaN(v))) {
      setMsg({ tone: 'danger', text: TARGETS_NOT_NUMBER })
      return
    }
    const check = validateResidentTargets(input)
    if (!check.ok) {
      setMsg({ tone: 'danger', text: `${check.message}入力は消えていません。` })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const res = await saveResidentTargets(residentId, input, current)
      if (!aliveRef.current) return
      if (res === 'conflict') {
        // 最新を読み直して見せる（入力はそのまま）
        try {
          const map = await fetchResidentTargets()
          if (!aliveRef.current) return
          const now = map.get(residentId) ?? null
          onLatest(now)
          setLatest(now)
          setMsg({ tone: 'warn', text: TARGETS_CONFLICT })
        } catch {
          if (aliveRef.current) setMsg({ tone: 'danger', text: TARGETS_RELOAD_FAILED })
        }
        return
      }
      onLatest(res)
      setLatest(undefined)
      setOpen(false)
      setMsg({ tone: 'ok', text: '個別の目標を保存しました。' })
    } catch (e) {
      if (aliveRef.current) setMsg({ tone: 'danger', text: e instanceof DbError ? e.message : TARGETS_SAVE_FAILED })
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  const useLatest = () => {
    setFluidIn(fieldOf(latest?.fluid_target_ml))
    setWarnIn(fieldOf(latest?.spo2_warn_below))
    setDangerIn(fieldOf(latest?.spo2_danger_below))
    setLatest(undefined)
    setMsg(null)
  }

  const inputCls = 'mt-1 min-h-tap w-32 rounded border border-border-strong bg-surface px-3 text-base text-ink tabular'
  const msgCls =
    msg?.tone === 'ok' ? 'border-ok bg-ok-bg text-ink' : msg?.tone === 'warn' ? 'border-warn bg-warn-bg text-ink' : 'border-danger bg-danger-bg text-ink'

  return (
    <SectionCard title="個別の目標" className="mt-4">
      {state === 'error' ? (
        <p className="mb-2 text-sm text-warn">
          <span aria-hidden="true">▲ </span>
          個別の目標を読み込めませんでした。施設の基準で表示しています。
          <button type="button" onClick={onReload} className="ml-2 min-h-tap rounded border border-border-strong px-3 text-sm text-link print:hidden">
            読み直す
          </button>
        </p>
      ) : null}
      <dl className="space-y-1 text-base text-ink">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-sm text-ink2">水分の目標</dt>
          <dd className="tabular font-bold">{state === 'loading' ? '読み込み中…' : `${fmtMl(f.ml)}ml/日`}</dd>
          {state === 'loading' ? null : <dd className="text-sm text-ink2">{f.individual ? '個別の目標' : '施設の既定'}</dd>}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-sm text-ink2">SpO2 の下限</dt>
          <dd className="tabular font-bold">
            {state === 'loading' ? '読み込み中…' : `${lim.warnBelow}%未満で注意・${lim.dangerBelow}%未満で危険`}
          </dd>
          {state === 'loading' ? null : (
            <dd className="text-sm text-ink2">{lim.individual ? '個別の下限（医師の指示）' : '施設の基準'}</dd>
          )}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-sm text-ink2">平熱</dt>
          <dd className="tabular font-bold">
            {usual === undefined ? '読み込み中…' : usualText !== null ? `${usualText}℃` : usualAbsent ? '出せません' : 'まだありません'}
          </dd>
          <dd className="text-sm text-ink2">
            {usual === undefined
              ? ''
              : usualText !== null
                ? `直近30日の定時の体温の中央値${usualSamples !== null ? `（${usualSamples}回）` : ''}`
                : usualAbsent
                  ? '直近30日の定時の体温が無いか、読み込めませんでした'
                  : '直近30日の定時の測定が5回未満'}
          </dd>
        </div>
      </dl>

      {msg ? (
        <p role={msg.tone === 'danger' ? 'alert' : 'status'} className={`mt-2 rounded border p-2 text-sm ${msgCls}`}>
          {msg.tone === 'danger' ? <span aria-hidden="true">▲ </span> : null}
          {msg.text}
        </p>
      ) : null}

      {role === undefined ? null : canEdit ? (
        open ? (
          <form
            className="mt-3 space-y-2 print:hidden"
            onSubmit={(e) => {
              e.preventDefault()
              void save(latest !== undefined ? latest : (target ?? null))
            }}
          >
            <div>
              <label htmlFor={`${uid}-fluid`} className="block text-sm text-ink2">
                水分の目標（ml/日・空にすると施設の既定）
              </label>
              <input
                id={`${uid}-fluid`}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={fluidIn}
                onChange={(e) => setFluidIn(e.target.value)}
                className={inputCls}
              />
            </div>
            <fieldset>
              <legend className="text-sm text-ink2">SpO2 の個別の下限（医師の指示がある方だけ・2つとも空にすると施設の基準）</legend>
              <div className="flex flex-wrap gap-x-4">
                <div>
                  <label htmlFor={`${uid}-warn`} className="block text-sm text-ink2">
                    注意（この値未満）%
                  </label>
                  <input
                    id={`${uid}-warn`}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    value={warnIn}
                    onChange={(e) => setWarnIn(e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label htmlFor={`${uid}-danger`} className="block text-sm text-ink2">
                    危険（この値未満）%
                  </label>
                  <input
                    id={`${uid}-danger`}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    value={dangerIn}
                    onChange={(e) => setDangerIn(e.target.value)}
                    className={inputCls}
                  />
                </div>
              </div>
            </fieldset>
            {latest !== undefined ? (
              <p className="text-sm text-ink">
                最新の値: <span className="font-bold">{describeTargets(latest)}</span>
              </p>
            ) : null}
            <div className="flex flex-wrap gap-gap">
              <button
                type="submit"
                disabled={busy}
                className="inline-flex min-h-tap items-center rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border disabled:bg-surface2 disabled:text-ink3"
              >
                {busy ? '保存中…' : latest !== undefined ? '入力した値で保存し直す' : '保存する'}
              </button>
              {latest !== undefined ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={useLatest}
                  className="inline-flex min-h-tap items-center rounded border border-border-strong bg-surface px-4 text-base text-ink disabled:text-ink3"
                >
                  最新の値に合わせる
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setOpen(false)
                  setLatest(undefined)
                  setMsg(null)
                }}
                className="inline-flex min-h-tap items-center rounded border border-border-strong bg-surface px-4 text-base text-ink disabled:text-ink3"
              >
                やめる
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={startEdit}
            disabled={state === 'loading'}
            className="mt-3 inline-flex min-h-tap items-center rounded border border-border-strong bg-surface px-4 text-base text-link disabled:text-ink3 print:hidden"
          >
            個別の目標を変える
          </button>
        )
      ) : (
        <p className="mt-2 text-sm text-ink2">個別の目標を変えられるのは事務・管理者のログインだけです（このログインでは見るだけです）。</p>
      )}
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// 個人カルテ（/karte/:id）
// ══════════════════════════════════════════════════════════════

interface KarteData {
  vitals: Vital[]
  meals: Meal[]
  fluids: FluidIntake[]
  notes: Note[]
  outings: Outing[]
  baths: BathRecord[]
  meds: MedAdmin[]
  incidents: Incident[]
}

const EMPTY_KARTE: KarteData = { vitals: [], meals: [], fluids: [], notes: [], outings: [], baths: [], meds: [], incidents: [] }

// ── 上部の固定バー（氏名＋各欄へ移動するボタン・2026-09-27 代表指示）──
// 氏名とボタンはスクロールしても画面上部に残る。ボタンを押すとその欄の見出しがバーのすぐ下に来る位置まで動く。
// 飛び先の id は各欄の SectionCard に付けてある（ここと1対1）。

/** 移動ボタン（表示順＝画面の欄の順） */
export const KARTE_JUMPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'karte-vitals', label: 'バイタル' },
  { id: 'karte-weight', label: '体重' },
  { id: 'karte-meals', label: '食事・水分' },
  { id: 'karte-excretion', label: '排泄' },
  { id: 'karte-notes', label: '申し送り' },
  { id: 'karte-bath', label: '入浴' },
  { id: 'karte-med', label: '与薬' },
  { id: 'karte-incident', label: '事故・ヒヤリ' },
  { id: 'karte-history', label: '変更の記録' },
]

/** アプリ全体の固定ヘッダ（sticky/fixed の header）。カルテの固定バーはその下に貼る。見つからなければ null */
function findShellHeader(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  for (const el of Array.from(document.querySelectorAll('header'))) {
    const pos = getComputedStyle(el).position
    if (pos === 'sticky' || pos === 'fixed') return el
  }
  return null
}

/** 固定ヘッダの高さ（px）。測れなければ 0＝画面の最上部 */
function measureShellHeaderH(): number {
  const el = findShellHeader()
  return el ? Math.round(el.getBoundingClientRect().height) : 0
}

/**
 * 画面下に固定されたナビ（狭い画面の下部タブ）の高さ（px）。無い・隠れている時は 0。
 * 広い画面の左の縦ナビ（上から下まで固定）は数えない（画面の下半分に横長で貼られたものだけ）
 */
function measureBottomNavH(): number {
  if (typeof document === 'undefined' || typeof window === 'undefined') return 0
  let h = 0
  for (const el of Array.from(document.querySelectorAll('nav'))) {
    if (getComputedStyle(el).position !== 'fixed') continue
    const r = el.getBoundingClientRect()
    if (r.height <= 0 || r.bottom < window.innerHeight - 1) continue
    if (r.top < window.innerHeight / 2 || r.width < window.innerWidth / 2) continue
    h = Math.max(h, Math.round(window.innerHeight - r.top))
  }
  return h
}

/**
 * グラフ1枚の高さ（画面の高さ − 上部の固定部分 − 下のナビ − グラフごとの見出しなど）。
 * iPhone などは1画面に1枚、広い画面は2枚が収まる大きさ（lib/chart.ts の chartHeight で 200〜360px に収める）
 */
function measureChartH(bar: HTMLElement | null): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return CHART_H_MIN
  const topH = measureShellHeaderH() + (bar ? Math.round(bar.getBoundingClientRect().height) : 0)
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  // 見出し（text-lg）＋区切りの余白・線（mt-4・pt-3）＋タップした値の行（min-h-tap）＋数値表の開閉（min-h-tap＋mt-2）
  const overheadH = Math.ceil(rem * 1.125 * 1.55 + 16 + 1 + 12 + 4 + 44 + 8 + 44)
  const wide = typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches
  // 画面の高さはツールバーが出ている時の高さ（100svh）で測る。iPhone の Safari はスクロールでツールバーが隠れるたびに
  // innerHeight が変わるため、それで測るとスクロール中にグラフが伸び縮みする
  const vhEl = document.querySelector<HTMLElement>('[data-karte-vh]')
  const svh = vhEl ? vhEl.getBoundingClientRect().height : 0
  return chartHeight({
    viewportH: svh > 0 ? svh : window.innerHeight,
    topH,
    bottomH: measureBottomNavH(),
    overheadH,
    perScreen: wide ? 2 : 1,
  })
}

/**
 * 欄へ移動する。固定ヘッダ＋固定バーの高さぶん上に余白を取り、見出しが隠れないようにする。
 * 動きを減らす設定の端末では一瞬で移動する。移動後はその欄へフォーカスを移す（読み上げで現在地が分かる）
 */
function jumpToSection(id: string, bar: HTMLElement | null): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const el = document.getElementById(id)
  if (!el) return
  const offset = measureShellHeaderH() + (bar ? bar.getBoundingClientRect().height : 0) + 8
  const top = Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY - offset))
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  window.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' })
  el.focus({ preventScroll: true })
}

interface KarteDetailProps {
  residentId: number
  state: ResidentsState
  staff?: Staff[]
}

function KarteDetail({ residentId, state, staff }: KarteDetailProps) {
  const { residents, loading: residentsLoading, error: residentsError, reload } = state
  const [range, setRange] = useState<RangeKey>(readRange)
  const [data, setData] = useState<KarteData>(EMPTY_KARTE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [staffList, setStaffList] = useState<Staff[]>(staff ?? [])
  const [weight, setWeight] = useState<WeightState>({ status: 'loading' })
  const [weightTick, setWeightTick] = useState(0)
  const [excretion, setExcretion] = useState<ExcretionState>({ status: 'loading' })
  const [excretionTick, setExcretionTick] = useState(0)
  // 「再試行する」「排便記録を読み直す」で増えた excretionTick を一度だけ「取り直し」として使うための控え
  const forcedExcretionTickRef = useRef(0)
  const aliveRef = useRef(true)
  // 「再試行する」で増えた weightTick を一度だけ「取り直し」として使うための控え
  const forcedWeightTickRef = useRef(0)
  const barRef = useRef<HTMLDivElement | null>(null)
  const [barTop, setBarTop] = useState(0)
  /** 印刷中（グラフは今までと同じ 160px・今までの幅で描く＝紙の大きさを変えない） */
  const [printing, setPrinting] = useState(false)
  /** 温度板（A7）の印刷の部品を置いているか（押した時だけ置き、印刷が終わったら外す） */
  const [sheetOpen, setSheetOpen] = useState(false)
  /** 個別の目標（全員分を1回で読む。この方の分だけ使う） */
  const [targets, setTargets] = useState<Map<number, ResidentTargets>>(new Map())
  const [targetsState, setTargetsState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [targetsTick, setTargetsTick] = useState(0)
  /** 段階2d-2: 個人の閾値（カードで足した・取り消した時に取り直す） */
  const [limitsTick, setLimitsTick] = useState(0)
  /** 平熱（A1。undefined＝読み込み中・null＝出せない） */
  const [usual, setUsual] = useState<number | null | undefined>(undefined)
  /** 平熱の応答にこの方の行が無かった（30日に定時の体温が1回も無い・関数が無い・読めない）。5回未満（行はあるが null）と言い分ける */
  const [usualAbsent, setUsualAbsent] = useState(false)
  /** 平熱を出すのに数えた定時の体温の回数（読み込み中・読めない時は null） */
  const [usualSamples, setUsualSamples] = useState<number | null>(null)
  /** ログインの役割（個別の目標の入力欄を出すか。undefined＝まだ分からない） */
  const [role, setRole] = useState<MyRole | null | undefined>(cachedMyRole())
  const [searchParams] = useSearchParams()

  const toIso = todayIso()
  const fromIso = rangeFromIso(range, toIso)
  const days = useMemo(() => daysAscending(fromIso, toIso), [fromIso, toIso])

  const resident = useMemo(
    () => residents.find((r) => r.id === residentId) ?? null,
    [residents, residentId],
  )

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 固定バーを貼る位置（アプリの固定ヘッダの下）。画面幅・文字サイズでヘッダの高さが変わるため追従する
  useEffect(() => {
    if (typeof window === 'undefined') return
    const apply = () => setBarTop(measureShellHeaderH())
    apply()
    window.addEventListener('resize', apply)
    let ro: ResizeObserver | null = null
    const shell = findShellHeader()
    if (shell && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(apply)
      ro.observe(shell)
    }
    return () => {
      window.removeEventListener('resize', apply)
      ro?.disconnect()
    }
  }, [])

  // 印刷の直前に、グラフの欄を今までの幅・高さへ戻して描き直す（印刷の割り付けより先に反映させるため同期で描き、
  // 幅を測り直させる）。紙のグラフは今までと同じ大きさ
  useEffect(() => {
    if (typeof window === 'undefined') return
    const before = () => {
      flushSync(() => setPrinting(true))
      window.dispatchEvent(new Event(KARTE_REMEASURE_EVENT))
    }
    const after = () => setPrinting(false)
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [])
  const wideLane = printing ? LANE : LANE_WIDE

  // 期間の変更を保存する（UI状態のみ）
  const onRangeChange = useCallback((v: string) => {
    if (!(RANGE_VALUES as readonly string[]).includes(v)) return
    const next = v as RangeKey
    setRange(next)
    writeRange(next)
  }, [])

  // カルテ本体（resident_id＋期間指定の取得。全件ロードの経路を作らない）
  useEffect(() => {
    let cancelled = false
    /** 取り直した結果を描いた（控えで先に描くのは、取り直しが返る前だけ） */
    let freshShown = false
    setLoading(true)
    setError(null)
    const toData = (res: Awaited<ReturnType<typeof fetchKarte>> | undefined): KarteData => ({
      vitals: ownedBy<Vital>(res?.vitals, residentId),
      meals: ownedBy<Meal>(res?.meals, residentId),
      fluids: ownedBy<FluidIntake>(res?.fluids, residentId),
      // 本人分の申し送りだけを出す（「スタッフへ（全体）」は resident_id が null）
      notes: asArray<Note>(res?.notes).filter((n) => n != null && n.resident_id === residentId),
      outings: ownedBy<Outing>(res?.outings, residentId),
      baths: ownedBy<BathRecord>(res?.baths, residentId),
      meds: ownedBy<MedAdmin>(res?.meds, residentId),
      // 本人分だけ（対象者なしのヒヤリハットは resident_id が null＝カルテには出ない）
      incidents: asArray<Incident>(res?.incidents).filter((i) => i != null && i.resident_id === residentId),
    })
    // その方のカルテの控え（行に触れた時の先読み・前に開いた時の結果）があれば、基準値を当ててから先に描く
    const cached = peekKarte(residentId, fromIso, toIso)
    if (cached !== undefined) {
      void loadVitalThresholds().then(() => {
        if (cancelled || freshShown || !aliveRef.current) return
        setData(toData(cached))
        setLoading(false)
      })
    }
    // 基準値（app_settings の上書き・A8）も一緒に待ってから描く（loadVitalThresholds は失敗しても既定値で返る）
    Promise.all([fetchKarte(residentId, fromIso, toIso), loadVitalThresholds()])
      .then(([res]) => {
        if (cancelled || !aliveRef.current) return
        freshShown = true
        setData(toData(res))
        setError(null)
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        freshShown = true
        // 取得できなかった場合は前の表示を残さず空にする（別期間の値を混ぜて誤読させない）
        setData(EMPTY_KARTE)
        setError(ERR_KARTE)
      })
      .finally(() => {
        if (cancelled || !aliveRef.current) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [residentId, fromIso, toIso, tick])

  // 体重（体重管理アプリの GAS から読むだけ）。期間では取り直さない＝fromIso/toIso を依存に入れない。
  // 利用者・カルテの再試行（tick）・「体重を読み直す」（weightTick）で取り直す
  const sourceId = resident ? resident.source_id : null
  useEffect(() => {
    if (sourceId === null) return
    let cancelled = false
    setWeight({ status: 'loading' })
    // 「再試行する」の時だけ、メモリに持っている体重を使わず取り直す
    const force = weightTick !== forcedWeightTickRef.current
    forcedWeightTickRef.current = weightTick
    fetchWeights([{ id: residentId, source_id: sourceId }], { force })
      .then((res) => {
        if (cancelled || !aliveRef.current) return
        if (res === null) setWeight({ status: 'unconfigured' })
        else if (!res.ok) setWeight({ status: 'error', message: weightFailMessage(res.reason) })
        else setWeight({ status: 'ready', list: res.byResident.get(residentId) ?? [], linked: res.linked })
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        setWeight({ status: 'error', message: weightFailMessage('network') })
      })
    return () => {
      cancelled = true
    }
  }, [residentId, sourceId, tick, weightTick])

  const weightPanel = useMemo(
    () => (weight.status === 'ready' ? buildWeightPanel(weight.list, fromIso, toIso) : null),
    [weight, fromIso, toIso],
  )

  // 排泄（排便記録アプリの GAS から読むだけ）。期間では取り直さない（直近14日に固定）。
  // カルテの再試行（tick）・「排便記録を読み直す」（excretionTick）で取り直す。利用者を替えた時はメモリの控えから照合し直す
  useEffect(() => {
    let cancelled = false
    setExcretion({ status: 'loading' })
    const force = excretionTick !== forcedExcretionTickRef.current
    forcedExcretionTickRef.current = excretionTick
    fetchExcretion({ force })
      .then((r) => {
        if (cancelled || !aliveRef.current) return
        if (r === null) setExcretion({ status: 'unconfigured' })
        else if (!r.ok) setExcretion({ status: 'error', message: excretionFailMessage(r.reason) })
        else setExcretion({ status: 'ready', snap: r.snap })
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        setExcretion({ status: 'error', message: excretionFailMessage('network') })
      })
    return () => {
      cancelled = true
    }
  }, [tick, excretionTick])

  const excretionView = useMemo(
    () =>
      excretion.status === 'ready' && resident
        ? // 表示の日（今日）の食事の記録が「入院」なら日数を出さない（本人回答 2026-10-17）
          excretionViewFor(excretion.snap, resident, residents, Date.now(), isHospitalDay(data.meals, residentId, toIso))
        : null,
    [excretion, resident, residents, data.meals, residentId, toIso],
  )

  // 個別の目標（A3・A9）。読めない時はカルテは施設の基準のまま出す（表が無い DB は空＝施設の既定）
  useEffect(() => {
    let cancelled = false
    setTargetsState('loading')
    fetchResidentTargets()
      .then((map) => {
        if (cancelled || !aliveRef.current) return
        setTargets(map)
        setTargetsState('ready')
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        setTargetsState('error')
      })
    return () => {
      cancelled = true
    }
  }, [tick, targetsTick])

  // 個人の閾値（段階2d-2・0045）。読めない時は施設の基準で判定し「個人の基準を読めませんでした」を出す（表が無い DB は空＝施設の基準）
  const limits = useVitalLimits(`${tick}|${targetsTick}|${limitsTick}`)
  const vitalLimits = useMemo(() => ({ rows: limits.rows, residentId }), [limits.rows, residentId])

  // 平熱（A1。今日を含む直近30日の定時の中央値。db.ts が日ごとに1回だけ問い合わせて控える。失敗しても例外は来ない）
  useEffect(() => {
    let cancelled = false
    fetchUsualTempDetails(toIso).then((m) => {
      if (cancelled || !aliveRef.current) return
      const d = m.get(residentId)
      setUsual(d !== undefined ? d.usual : null)
      setUsualAbsent(d === undefined)
      setUsualSamples(d !== undefined ? d.samples : null)
    })
    return () => {
      cancelled = true
    }
  }, [residentId, toIso, tick])

  // ログインの役割（ログインし直したら取り直す）
  useEffect(() => {
    let alive = true
    const load = () => {
      fetchMyRole().then((r) => {
        if (alive) setRole(r)
      })
    }
    load()
    const off = subscribeMyRole(load)
    return () => {
      alive = false
      off()
    }
  }, [])

  const target = targets.get(residentId)
  const onLatestTarget = useCallback(
    (t: ResidentTargets | null) => {
      setTargets((prev) => {
        const next = new Map(prev)
        if (t === null) next.delete(residentId)
        else next.set(residentId, t)
        return next
      })
    },
    [residentId],
  )

  // 今日の要注意（/alerts）から ?sec=<欄の id> で開いた時は、カルテを描いた後にその欄へ移る（利用者・欄ごとに1回）
  const secParam = karteSecOf(
    searchParams.get('sec'),
    KARTE_JUMPS.map((j) => j.id),
  )
  const jumpedRef = useRef<string | null>(null)
  useEffect(() => {
    if (loading || error || secParam === null) return
    const key = `${residentId}|${secParam}`
    if (jumpedRef.current === key) return
    jumpedRef.current = key
    // グラフの高さを測って描き直すのを待ってから移る（2フレーム後）
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => jumpToSection(secParam, barRef.current))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [loading, error, secParam, residentId])

  // 記入者名の対応表（退職者も含む全員・F48。App から渡る名簿は在籍者だけなので、渡されていても全員を読む。
  // 渡された名簿は読めるまでの間と、読めなかった時の控え。取得できなくてもカルテ本体は表示する）
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  useEffect(() => {
    if (staff) setStaffList(staff)
  }, [staff])
  useEffect(() => {
    let cancelled = false
    fetchAllStaff()
      .then((rows) => {
        if (cancelled || !aliveRef.current) return
        setAllStaff(asArray<Staff>(rows).filter((s) => s != null && typeof s.id === 'number'))
      })
      .catch(() => {
        // 退職者の記入者名が出せないだけなので、カルテの表示は続ける
      })
    return () => {
      cancelled = true
    }
  }, [])

  const staffById = useMemo(() => {
    const m = new Map<number, string>()
    for (const s of allStaff) m.set(s.id, s.name)
    for (const s of staffList) m.set(s.id, s.name)
    return m
  }, [staffList, allStaff])

  const floor = resident ? floorOf(resident.room) : null

  if (residentsLoading && residents.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <LoadingBlock label="利用者の情報を読み込み中です…" />
      </div>
    )
  }

  if (!resident) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <Link to="/karte" className="inline-flex min-h-tap items-center text-base text-link">
          <span aria-hidden="true">‹ </span>利用者一覧へ戻る
        </Link>
        <div className="mt-3">
          {residentsError ? (
            <ErrorBlock message={residentsError} onRetry={reload} />
          ) : (
            <ErrorBlock message="この利用者は現在の一覧にありません（退居・無効化の可能性があります）。一覧へ戻って選び直してください。" />
          )}
        </div>
      </div>
    )
  }

  // 欄ごとに幅を決める（2026-10-08）: 文字の欄は今までの幅（LANE）、グラフの欄（バイタル・体重のグラフ・食事）だけ
  // 広い画面で画面幅まで広げる（LANE_WIDE）。氏名バーは外側の枠いっぱいを親にして、ページの最後まで上部に残す
  return (
    <div className="w-full py-4">
      {/* グラフの高さを決めるための画面の高さの物差し（100svh・見えない・読み上げない・押せない） */}
      <div aria-hidden="true" data-karte-vh="" className="pointer-events-none invisible fixed left-0 top-0 h-svh w-0" />
      <div className={LANE}>
        <Link to="/karte" className="inline-flex min-h-tap items-center text-base text-link">
          <span aria-hidden="true">‹ </span>利用者一覧へ戻る
        </Link>
      </div>

      {/* 氏名と移動ボタン。スクロールしても上部に残る（アプリの固定ヘッダの下に貼る）。
          中身の位置と幅（下線を含む）は今までと同じ。背景だけ画面幅に敷き、広げたグラフの欄がバーの両脇から透けて見えないようにする */}
      <div
        ref={barRef}
        data-karte-bar=""
        className="sticky z-10 mt-2 bg-bg print:static"
        style={{ top: barTop }}
      >
        <div className="mx-auto max-w-2xl border-b border-border bg-bg px-4 py-1">
          {/* 氏名は削らない（取り違え防止）。幅が足りない時（文字を大きくした端末など）はボタンを次の行へ回す */}
          <div className="flex flex-wrap items-center gap-x-2">
            <h1 className="min-w-0 max-w-full break-words text-xl font-heavy text-ink">{resident.name}</h1>
            <nav aria-label="カルテの欄へ移動" className="min-w-0 flex-1 basis-32 overflow-x-auto print:hidden sm:overflow-visible">
              {/* スマホは横にスワイプ（バーを低く保つ）。PC 幅では折り返して全部見せる（マウスで横スクロールしにくいため）。
                  p-1.5 はフォーカス枠（外側に 5px）が横スクロールの枠で切れないための余白 */}
              <ul className="flex gap-2 p-1.5 sm:flex-wrap">
                {(loading || error ? KARTE_JUMPS.filter((j) => j.id === 'karte-history') : KARTE_JUMPS).map((j) => (
                  <li key={j.id} className="shrink-0">
                    <button
                      type="button"
                      onClick={() => jumpToSection(j.id, barRef.current)}
                      className="inline-flex min-h-tap items-center whitespace-nowrap rounded-full border border-border-strong bg-surface px-3 text-sm text-link"
                    >
                      {j.label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </div>
      </div>

      <div className={LANE}>
        <header className="mt-2">
          <p className="text-sm text-ink2">
            {resident.kana ? <span>{resident.kana}　</span> : null}
            <span className="tabular">{resident.room ?? '居室未登録'}</span>
            {floor != null ? <span>　{floor}階</span> : null}
          </p>
          {resident.needs_review ? (
            <p className="mt-1 text-sm text-warn">
              <span aria-hidden="true">▲ </span>
              マスタ同期で確認待ちの利用者です（名簿の氏名と食い違っています）。設定の「要確認の利用者」で内容を確かめてください。
            </p>
          ) : null}
        </header>

        <div className="mt-3">
          <h2 className="text-sm text-ink2">表示する期間</h2>
          <div className="mt-1">
            <SegmentPicker
              options={RANGE_OPTIONS}
              value={range}
              onChange={onRangeChange}
              ariaLabel="表示する期間"
            />
          </div>
          <p className="tabular mt-1 text-sm text-ink3">
            {fmtDayLabel(fromIso)} 〜 {fmtDayLabel(toIso)}
          </p>
          {/* 温度板（A7）: 今日までの2週間を A4 縦1枚に。表示中の期間に関係なく直近14日（期間は最短でも2週） */}
          <button
            type="button"
            disabled={loading || error !== null}
            onClick={() => {
              // 前の印刷の部品が残っていても（印刷の終わりを知らせない端末）、外してから置き直して押し直せるようにする
              if (sheetOpen) {
                setSheetOpen(false)
                requestAnimationFrame(() => setSheetOpen(true))
              } else setSheetOpen(true)
            }}
            className="mt-2 inline-flex min-h-tap items-center rounded border border-primary bg-surface px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3 print:hidden"
          >
            温度板を印刷
          </button>
          {sheetOpen ? (
            <TempSheetPrint
              model={buildTempSheet({
                days: sheetDays(toIso),
                residentId,
                vitals: data.vitals,
                meals: data.meals,
                fluids: data.fluids,
                usual: usual ?? null,
                target: target ?? null,
                // 段階2d-2: その日の基準（個人の閾値）。印刷する時の施設の基準で作る
                thresholdsFor: (d: string) => limits.lookup(residentId, d),
              })}
              name={resident.name}
              room={resident.room}
              printedAt={fmtPrintedAt(new Date())}
              onDone={() => setSheetOpen(false)}
            />
          ) : null}
        </div>

        <TargetsCard
          residentId={residentId}
          target={target}
          state={targetsState}
          onReload={() => setTargetsTick((n) => n + 1)}
          onLatest={onLatestTarget}
          usual={usual}
          usualAbsent={usualAbsent}
          usualSamples={usualSamples}
          role={role}
        />

        {/* 個人の閾値（段階2d・0045）。事務・管理者だけ足せる。足した・取り消した後は記録の印を取り直す（段階2d-2） */}
        <VitalLimitsCard residentId={residentId} role={role} onChanged={() => setLimitsTick((n) => n + 1)} />

        {loading ? (
          <div className="mt-3">
            <LoadingBlock label="カルテを読み込み中です…" />
          </div>
        ) : error ? (
          <div className="mt-3">
            <ErrorBlock message={error} onRetry={() => setTick((n) => n + 1)} />
          </div>
        ) : null}
      </div>

      {loading || error ? null : (
        <>
          <div className={wideLane}>
            <VitalsSection
              vitals={data.vitals}
              days={days}
              weightPanel={weightPanel}
              printing={printing}
              usual={usual}
              usualAbsent={usualAbsent}
          usualSamples={usualSamples}
              target={target}
              limits={vitalLimits}
            />
            {limits.failed ? (
              <p role="status" className="mt-2 rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
                <span aria-hidden="true">▲ </span>
                {VITAL_LIMITS_FAILED_TEXT}
              </p>
            ) : null}
          </div>
          <div className={LANE}>
            <WeightSection
              state={weight}
              fromIso={fromIso}
              toIso={toIso}
              sourceId={resident.source_id}
              onReload={() => setWeightTick((n) => n + 1)}
            />
          </div>
          <div className={wideLane}>
            <MealsSection
              meals={data.meals}
              fluids={data.fluids}
              outings={data.outings}
              days={days}
              printing={printing}
              target={target}
            />
          </div>
          <div className={LANE}>
            <ExcretionSection state={excretion} view={excretionView} onReload={() => setExcretionTick((n) => n + 1)} />
            <NotesSection notes={data.notes} staffById={staffById} />
            <BathSection baths={data.baths} staffById={staffById} />
            <MedSection meds={data.meds} />
            <IncidentSection incidents={data.incidents} />
          </div>
        </>
      )}

      {/* 変更の記録は別の取得。カルテ本体の読み込み・失敗に関係なく出す（表が無い時も他の欄は動く） */}
      <div className={LANE}>
        <HistorySection residentId={residentId} staffById={staffById} />
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// ルート（/karte と /karte/:id を1つの画面で受ける）
// ══════════════════════════════════════════════════════════════

export interface KartePageProps {
  /** App 側で取得済みなら渡せる（未指定ならこの画面が db.ts から取得する） */
  residents?: Resident[]
  staff?: Staff[]
}

export function KartePage({ residents, staff }: KartePageProps = {}) {
  const params = useParams<{ id?: string }>()
  const state = useResidents(residents)

  // URL の :id は正の整数だけを受け入れる（壊れた値で表示不能にしない）
  const raw = params.id ?? ''
  const residentId = /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null

  if (raw !== '' && residentId == null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <Link to="/karte" className="inline-flex min-h-tap items-center text-base text-link">
          <span aria-hidden="true">‹ </span>利用者一覧へ戻る
        </Link>
        <div className="mt-3">
          <ErrorBlock message="この利用者のカルテを開けませんでした（アドレスが正しくありません）。一覧へ戻って選び直してください。" />
        </div>
      </div>
    )
  }

  if (residentId == null) return <ResidentList state={state} />
  return <KarteDetail residentId={residentId} state={state} staff={staff} />
}

export default KartePage
