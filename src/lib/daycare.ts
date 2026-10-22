// デイ（せせらぎ）の記録 段階1 の純ロジック（2026-10-22 代表承認・0041_daycare_stage1.sql）。副作用なし・DB/DOM に触れない。
//
//   デイの測定の冪等キー … daycareVitalKey・parseDaycareVitalKey・nextDaycareSeq（'dc:<業務日>:<利用者id>:<回>'）
//     既存の vitals の kind 'observation' のまま、このキーでデイの測定と見分ける（0011・vitals の制約は変えない）。
//     2台が同じ人の同じ回を測ると同じキー＝同じ行に合流し、0011 の欄ごとの判定で後着が「競合」になる（中10）。
//     取り消した回のキーは使い直さない（0011 は取り消した行を作り直さない）＝次の回は「取り消した回も含めた最大＋1」。
//   到着・在席・帰宅・欠席 … attendanceState・validateAttendance（到着の1タップで在席）
//   1日の一覧 … buildDaycareBoard（予定の行＋記録のある人＋予定外に足した人。照合できない予定は数だけ）
//   テンキー … keypadAppend・keypadComplete・keypadValue（体温 365→36.5・血圧の上と脈は先頭が1か2なら3桁 など）
//   範囲・上下逆 … vitalRangeError・bpPairError（範囲外と上下逆は保存しない＝代表者の回答 5.2 の10）
//   判定 … vitalLevel（施設の基準。SpO2 は既存の個別の下限 spo2LevelFor を使う＝既存の画面と同じ印）
//   欠席の日の入浴 … absentBathAction（その日の行を読んだ結果から、追加・更新・そのままを決める）
//   前回値 … previousVitalOf
//
// 拡張子付きで import する（tests から node で直接読めるようにするため）。個人情報は扱わない（型と計算だけ）。

import {
  BATH_CANCEL_REASON_LABEL,
  BATH_RESULT_LABEL,
  DAYCARE_VITAL_KEY_PREFIX,
  VITAL_RANGE,
  diaBpLevel,
  pulseLevel,
  sysBpLevel,
  tempLevel,
} from './types.ts'
import type {
  BathRecord,
  DaycareAbsentReason,
  DaycareAttendance,
  DaycarePlanRow,
  DaycarePlanSource,
  Level,
  Resident,
  Vital,
} from './types.ts'
import { DAYCARE_ABSENT_REASONS } from './types.ts'
import { spo2LevelFor } from './vitalAlerts.ts'
import type { ResidentTargets } from './vitalAlerts.ts'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

// ══════════════════════════════════════════════════════════════
// デイの測定の冪等キー
// ══════════════════════════════════════════════════════════════

/** client_key を持つバイタル（デイの画面の読み取りだけが client_key を読む） */
export interface KeyedVital extends Vital {
  client_key: string | null
}

/** デイの測定の冪等キー（'dc:2026-10-22:12:1'） */
export function daycareVitalKey(day: string, residentId: number, seq: number): string {
  return `${DAYCARE_VITAL_KEY_PREFIX}${day}:${residentId}:${seq}`
}

const DC_KEY_RE = /^dc:(\d{4}-\d{2}-\d{2}):([1-9]\d{0,17}):([1-9]\d{0,3})$/

/** キーを読む。デイの測定のキーでなければ null */
export function parseDaycareVitalKey(ck: unknown): { day: string; residentId: number; seq: number } | null {
  if (typeof ck !== 'string') return null
  const m = DC_KEY_RE.exec(ck)
  if (m === null) return null
  const residentId = Number(m[2])
  const seq = Number(m[3])
  if (!Number.isSafeInteger(residentId) || !Number.isSafeInteger(seq)) return null
  return { day: m[1], residentId, seq }
}

export function isDaycareVitalKey(ck: unknown): boolean {
  return parseDaycareVitalKey(ck) !== null
}

/**
 * その人・その日の次の回（取り消した回も含めて使った最大＋1。無ければ1）。
 * keys には取り消した行のキーも渡す（取り消した回のキーを使い直すと、0011 が「行が無い」で止める）
 */
export function nextDaycareSeq(keys: readonly string[], day: string, residentId: number): number {
  let max = 0
  for (const k of keys) {
    const p = parseDaycareVitalKey(k)
    if (p !== null && p.day === day && p.residentId === residentId && p.seq > max) max = p.seq
  }
  return max + 1
}

/** 1人の、その日のデイの測定の行（1回目・再測定）。vital=null は「まだ測っていない（この回のキーで新しく作る）」 */
export interface DaycareVitalSlot {
  residentId: number
  seq: number
  key: string
  vital: KeyedVital | null
}

/**
 * 1人の、その日のデイの測定の並び（回の小さい順）。生きている行が無ければ、次の回のキーの空の行を1つ返す
 * （画面はそこへ入れる）。extraSeqs は画面で〔＋再測定〕を押して足した、まだ保存していない回
 */
export function daycareVitalSlots(
  live: readonly KeyedVital[],
  allKeys: readonly string[],
  residentId: number,
  day: string,
  extraSeqs: readonly number[] = [],
): DaycareVitalSlot[] {
  const out: DaycareVitalSlot[] = []
  const seen = new Set<number>()
  for (const v of live) {
    const p = parseDaycareVitalKey(v.client_key)
    if (p === null || p.residentId !== residentId || p.day !== day || v.resident_id !== residentId) continue
    if (seen.has(p.seq)) continue
    seen.add(p.seq)
    out.push({ residentId, seq: p.seq, key: v.client_key as string, vital: v })
  }
  for (const s of extraSeqs) {
    if (seen.has(s)) continue
    seen.add(s)
    out.push({ residentId, seq: s, key: daycareVitalKey(day, residentId, s), vital: null })
  }
  if (out.length === 0) {
    const seq = nextDaycareSeq(allKeys, day, residentId)
    out.push({ residentId, seq, key: daycareVitalKey(day, residentId, seq), vital: null })
  }
  return out.sort((a, b) => a.seq - b.seq)
}

// ══════════════════════════════════════════════════════════════
// 到着・在席・帰宅・欠席
// ══════════════════════════════════════════════════════════════

/** planned=予定（まだ来ていない）/ present=在席（到着の1タップで在席）/ left=帰宅 / absent=欠席 */
export type AttendanceState = 'planned' | 'present' | 'left' | 'absent'

export function attendanceState(a: Pick<DaycareAttendance, 'absent' | 'arrived_at' | 'left_at'> | null | undefined): AttendanceState {
  if (a === null || a === undefined) return 'planned'
  if (a.absent) return 'absent'
  if (a.left_at !== null) return 'left'
  if (a.arrived_at !== null) return 'present'
  return 'planned'
}

/** 端末の時刻（端末＝JST 運用）を 'HH:MM' に */
export function nowHm(d: Date = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 予定の時刻（'9:30' のような1桁の時も）を 'HH:MM' に。読めなければ null（時刻を入れる小窓の初めの値に使う） */
export function planHm(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(v)
  return m === null ? null : hmOf(`${m[1].padStart(2, '0')}:${m[2]}`)
}

/** 'HH:MM' か 'HH:MM:SS' を 'HH:MM' に。読めなければ null */
export function hmOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(v)
  if (m === null) return null
  const s = `${m[1]}:${m[2]}`
  return HM_RE.test(s) ? s : null
}

export interface AttendanceInput {
  absent: boolean
  absent_reason: DaycareAbsentReason | null
  arrived_at: string | null
  left_at: string | null
}

/** 保存前の検証（DB の check 0041 と同じ規則）。通らなければ理由の文 */
export function validateAttendance(v: AttendanceInput): { ok: true } | { ok: false; message: string } {
  if (v.absent) {
    if (v.absent_reason === null || !DAYCARE_ABSENT_REASONS.includes(v.absent_reason)) {
      return { ok: false, message: '欠席の理由を選んでください。' }
    }
    if (v.arrived_at !== null || v.left_at !== null) {
      return { ok: false, message: '欠席の日は到着・帰宅の時刻を持てません。到着の記録を取り消してから欠席にしてください。' }
    }
    return { ok: true }
  }
  if (v.absent_reason !== null) return { ok: false, message: '欠席でない日に欠席の理由は付けられません。' }
  if (v.arrived_at !== null && !HM_RE.test(v.arrived_at)) return { ok: false, message: '到着の時刻を読み取れませんでした。' }
  if (v.left_at !== null) {
    if (!HM_RE.test(v.left_at)) return { ok: false, message: '帰宅の時刻を読み取れませんでした。' }
    if (v.arrived_at === null) return { ok: false, message: '到着を記録してから帰宅を記録してください。' }
    if (v.left_at < v.arrived_at) return { ok: false, message: '帰宅の時刻が到着より前になっています。時刻を確かめてください。' }
  }
  return { ok: true }
}

// ── 過去の日の到着・帰宅の時刻（代表者の決定 2026-10-22・移行 0042） ──────────

/** 過去の日の到着・帰宅の時刻を入力・修正できる役割か（事務所・管理者）。分からない（null・undefined）は現場と同じ＝false */
export function canEditPastDaycareTimes(role: string | null | undefined): boolean {
  return role === 'office' || role === 'admin'
}

/**
 * 到着・帰宅の時刻を変える操作をしてよいか（画面の出し分け。DB は 0042 のトリガで同じ規則を守る）。
 * 今日は誰でも（いまの時刻で押す）。過去の日は事務所・管理者だけ（時刻を入れる・直す・取り消す・時刻の入った方を欠席にする）
 */
export function canChangeDaycareTimes(day: string, today: string, role: string | null | undefined): boolean {
  if (day > today) return false
  if (day === today) return true
  return canEditPastDaycareTimes(role)
}

// ══════════════════════════════════════════════════════════════
// 1日の一覧（予定 ∪ 記録のある人 ∪ 予定外に足した人）
// ══════════════════════════════════════════════════════════════

export interface DaycarePlanEntry {
  start: string | null
  end: string | null
  bathing: boolean
}

export interface DaycareBoardRow {
  residentId: number
  /** その日の予定（時間順。同じ人の2件は2つ並べる＝1枠に畳まない） */
  plans: DaycarePlanEntry[]
  /** 予定がある（名簿と照合できた予定が1件以上） */
  planned: boolean
  /** 週間計画にこの方の記録が2つ以上ある（予定 要確認。時間は出さない） */
  dup: boolean
  /** 週間計画で入院中 */
  hospitalized: boolean
  /** 入浴の予定がある（12:30 の自動の入浴が行を作る相手を含む） */
  bathingPlanned: boolean
  attendance: DaycareAttendance | null
  state: AttendanceState
  /** 予定に無い（記録がある・画面で足した） */
  extra: boolean
}

export interface DaycareBoardCounts {
  /** 予定の方（入院中を除く） */
  planned: number
  present: number
  left: number
  absent: number
  /** 予定のうち、まだ到着も欠席も記録していない方 */
  waiting: number
  hospitalized: number
}

export interface DaycareBoard {
  source: DaycarePlanSource
  rows: DaycareBoardRow[]
  /** 名簿に無い方（外部利用者・名簿の在籍者に居ない利用者No）の数（予定の記録の数で数える） */
  notInRoster: number
  /** 週間計画と照合できない予定（氏名の食い違い・氏名で絞れない）の数 */
  unconfirmed: number
  counts: DaycareBoardCounts
}

/** 時刻の並べ替えのキー（'9:30'→'09:30'。読めなければ後ろ） */
function timeKey(t: string | null): string {
  if (t === null) return '99:99'
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  return m === null ? '99:99' : `${m[1].padStart(2, '0')}:${m[2]}`
}

/**
 * 1日の一覧を組む。並びは予定の開始時刻 → 名簿の並び（居室順）。予定に無い人（記録のある人・足した人）は後ろ。
 * 名簿（residents）は退居された方も含めて渡してよい（記録のある方の名前を引くため）。予定の照合はサーバー（daycare_plan）の結果をそのまま使う
 */
export function buildDaycareBoard(p: {
  planRows: readonly DaycarePlanRow[]
  source: DaycarePlanSource
  residents: readonly Pick<Resident, 'id'>[]
  attendance: readonly DaycareAttendance[]
  extraIds?: readonly number[]
}): DaycareBoard {
  const order = new Map<number, number>()
  p.residents.forEach((r, i) => order.set(r.id, i))
  const byResident = new Map<number, DaycareBoardRow>()
  const notInRoster = new Set<string>()
  const unconfirmed = new Set<string>()
  const att = new Map<number, DaycareAttendance>()
  for (const a of p.attendance) {
    const cur = att.get(a.resident_id)
    if (cur === undefined || a.id > cur.id) att.set(a.resident_id, a)
  }
  const ensure = (residentId: number, extra: boolean): DaycareBoardRow => {
    let row = byResident.get(residentId)
    if (row === undefined) {
      const a = att.get(residentId) ?? null
      row = {
        residentId,
        plans: [],
        planned: false,
        dup: false,
        hospitalized: false,
        bathingPlanned: false,
        attendance: a,
        state: attendanceState(a),
        extra,
      }
      byResident.set(residentId, row)
    }
    return row
  }
  for (const r of p.planRows) {
    if (r.sched_id === null) continue
    if (r.match === 'external' || r.match === 'absent_roster') {
      notInRoster.add(r.sched_id)
      continue
    }
    if (r.match !== 'mid' && r.match !== 'name') {
      unconfirmed.add(r.sched_id)
      continue
    }
    if (r.resident_id === null) {
      unconfirmed.add(r.sched_id)
      continue
    }
    const row = ensure(r.resident_id, false)
    row.extra = false
    row.planned = true
    row.dup = row.dup || r.dup
    row.hospitalized = row.hospitalized || r.hospitalized
    row.bathingPlanned = row.bathingPlanned || r.bathing
    row.plans.push({ start: r.start_time, end: r.end_time, bathing: r.bathing })
  }
  for (const a of att.values()) ensure(a.resident_id, true)
  for (const id of p.extraIds ?? []) ensure(id, true)
  // 12:30 の自動の入浴が行を作る相手（cron と同じ規則・氏名を見ない）は、照合できない予定（氏名の食い違い）でも
  // 入浴の予定ありとする＝その方を予定外で足して欠席にした時も、入浴を「中止・欠席」にする（反証レビュー重大1）
  const autoBath = new Set<number>()
  for (const r of p.planRows) if (r.sched_id !== null && typeof r.bath_resident_id === 'number') autoBath.add(r.bath_resident_id)
  const rows = [...byResident.values()]
  for (const r of rows) if (autoBath.has(r.residentId)) r.bathingPlanned = true
  for (const r of rows) r.plans.sort((a, b) => timeKey(a.start).localeCompare(timeKey(b.start)))
  rows.sort((a, b) => {
    if (a.extra !== b.extra) return a.extra ? 1 : -1
    const ta = a.dup ? '99:98' : timeKey(a.plans[0]?.start ?? null)
    const tb = b.dup ? '99:98' : timeKey(b.plans[0]?.start ?? null)
    if (ta !== tb) return ta.localeCompare(tb)
    return (order.get(a.residentId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.residentId) ?? Number.MAX_SAFE_INTEGER) || a.residentId - b.residentId
  })
  const counts: DaycareBoardCounts = { planned: 0, present: 0, left: 0, absent: 0, waiting: 0, hospitalized: 0 }
  for (const r of rows) {
    if (r.hospitalized && r.state === 'planned') {
      counts.hospitalized += 1
      continue
    }
    if (r.planned) counts.planned += 1
    if (r.state === 'present') counts.present += 1
    else if (r.state === 'left') counts.left += 1
    else if (r.state === 'absent') counts.absent += 1
    else if (r.planned) counts.waiting += 1
  }
  return { source: p.source, rows, notInRoster: notInRoster.size, unconfirmed: unconfirmed.size, counts }
}

/** 予定の時間の表示（'9:30〜12:00／13:00〜15:30'）。時刻の無い予定は '時間未定' */
export function fmtPlanTimes(plans: readonly DaycarePlanEntry[]): string {
  const hm = (t: string | null) => {
    if (t === null) return null
    const m = /^(\d{1,2}):(\d{2})/.exec(t)
    return m === null ? null : `${Number(m[1])}:${m[2]}`
  }
  const parts = plans.map((x) => {
    const s = hm(x.start)
    const e = hm(x.end)
    if (s === null && e === null) return '時間未定'
    return `${s ?? '?'}〜${e ?? '?'}`
  })
  return parts.join('／')
}

// ══════════════════════════════════════════════════════════════
// テンキー（一括バイタル）
// ══════════════════════════════════════════════════════════════

export type DaycareVitalField = 'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2'
/** 欄送りの順（体温 → 血圧の上 → 下 → 脈 → SpO2） */
export const DAYCARE_VITAL_FIELDS: readonly DaycareVitalField[] = ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2']
export const DAYCARE_VITAL_LABEL: Record<DaycareVitalField, string> = {
  temp: '体温',
  sys_bp: '血圧の上',
  dia_bp: '血圧の下',
  pulse: '脈',
  spo2: 'SpO2',
}
export const DAYCARE_VITAL_UNIT: Record<DaycareVitalField, string> = {
  temp: '℃',
  sys_bp: 'mmHg',
  dia_bp: 'mmHg',
  pulse: '回/分',
  spo2: '%',
}

/** その欄の桁数（入れた時点で決まる）。体温は小数点なしなら3桁 */
function digitsWanted(field: DaycareVitalField, first: string): number {
  if (field === 'temp') return 3
  if (field === 'sys_bp' || field === 'pulse') return first === '1' || first === '2' ? 3 : 2
  return first === '1' ? 3 : 2 // dia_bp・spo2
}

/**
 * テンキーの1キーを足した入力（数字・小数点）。足せないキーは今の入力のまま返す
 * （体温以外の小数点・2つ目の小数点・桁の上限を超える数字・小数第2位）
 */
export function keypadAppend(field: DaycareVitalField, buf: string, key: string): string {
  if (key === '.') {
    if (field !== 'temp' || buf.includes('.') || buf === '') return buf
    return `${buf}.`
  }
  if (!/^\d$/.test(key)) return buf
  if (field === 'temp' && buf.includes('.')) {
    const frac = buf.split('.')[1] ?? ''
    return frac.length >= 1 ? buf : buf + key
  }
  const digits = buf.replace('.', '')
  if (digits.length >= 3) return buf
  return buf + key
}

/** その欄が埋まった（次の欄へ自動で進む）か */
export function keypadComplete(field: DaycareVitalField, buf: string): boolean {
  if (buf === '') return false
  if (field === 'temp' && buf.includes('.')) return /^\d{2}\.\d$/.test(buf)
  const digits = buf.replace('.', '')
  return digits.length >= digitsWanted(field, digits[0])
}

/** 入力の文字を数にする（体温 '365'→36.5・'36.5'→36.5・'37'→37）。読めなければ null。範囲は見ない */
export function keypadValue(field: DaycareVitalField, buf: string): number | null {
  const s = buf.replace(/\.$/, '')
  if (s === '') return null
  if (field === 'temp') {
    if (/^\d{3}$/.test(s)) return Number(`${s.slice(0, 2)}.${s.slice(2)}`)
    if (/^\d{1,2}(\.\d)?$/.test(s)) return Number(s)
    return null
  }
  return /^\d{1,3}$/.test(s) ? Number(s) : null
}

/** 範囲外なら理由の文（保存しない）。範囲は DB の check と同じ VITAL_RANGE */
export function vitalRangeError(field: DaycareVitalField, v: number | null): string | null {
  if (v === null) return null
  const [lo, hi] = VITAL_RANGE[field]
  if (!Number.isFinite(v) || v < lo || v > hi) {
    const shown = field === 'temp' ? v.toFixed(1) : String(v)
    const range = field === 'temp' ? `${lo.toFixed(1)}〜${hi.toFixed(1)}` : `${lo}〜${hi}`
    return `${DAYCARE_VITAL_LABEL[field]}は ${range} で入れてください（入れた値: ${shown}）。`
  }
  return null
}

/** 血圧の上下が逆（上 ≦ 下）なら理由の文（保存しない）。片方が空なら見ない */
export function bpPairError(sys: number | null, dia: number | null): string | null {
  if (sys === null || dia === null) return null
  if (sys <= dia) return `血圧の上（${sys}）が下（${dia}）以下になっています。測り直して入れてください。`
  return null
}

/** 判定（施設の基準。SpO2 は既存の個別の下限＝resident_targets を使う。既存の画面と同じ印） */
export function vitalLevel(field: DaycareVitalField, v: number | null, target?: ResidentTargets | null): Level {
  if (v === null) return null
  if (field === 'temp') return tempLevel(v)
  if (field === 'sys_bp') return sysBpLevel(v)
  if (field === 'dia_bp') return diaBpLevel(v)
  if (field === 'pulse') return pulseLevel(v)
  return spo2LevelFor(v, target ?? null)
}

/** 判定の言葉（色だけに頼らない＝記号と並べて出す） */
export const LEVEL_WORD: Record<Exclude<Level, null>, string> = {
  'danger-high': '危険・高い',
  'warn-high': '注意・高い',
  'warn-low': '注意・低い',
  'danger-low': '危険・低い',
}

/** 1回の測定に基準を外れた欄があるか（〔＋再測定〕を出す） */
export function vitalNeedsRecheck(v: Partial<Record<DaycareVitalField, number | null>>, target?: ResidentTargets | null): boolean {
  return DAYCARE_VITAL_FIELDS.some((f) => vitalLevel(f, v[f] ?? null, target) !== null)
}

/** 最初に基準を外れた欄（再測定はそこから入れ始める）。無ければ体温 */
export function firstAbnormalField(v: Partial<Record<DaycareVitalField, number | null>>, target?: ResidentTargets | null): DaycareVitalField {
  return DAYCARE_VITAL_FIELDS.find((f) => vitalLevel(f, v[f] ?? null, target) !== null) ?? 'temp'
}

// ══════════════════════════════════════════════════════════════
// 欠席の日の入浴（その日の行を読む → あれば更新 → 無ければ追加 → 23505 なら読み直して更新）
// ══════════════════════════════════════════════════════════════

export type AbsentBathAction =
  /** 入浴の予定も行も無い（何もしない） */
  | { kind: 'none' }
  /** 行が無く入浴の予定がある → 「中止・欠席」を追加する（12:30 の自動の行を作らせない） */
  | { kind: 'insert' }
  /** 行がある → 「中止・欠席」に直す。confirm=true は人が記録した入浴（入浴した）を直す＝確認を挟む */
  | { kind: 'update'; record: BathRecord; confirm: boolean }
  /** 既に「中止」（欠席以外の理由・人の記録）→ 人の記録を残す（理由を上書きしない） */
  | { kind: 'keep'; record: BathRecord }
  /** 既に「中止・欠席」 */
  | { kind: 'already'; record: BathRecord }

export function absentBathAction(existing: BathRecord | null, bathingPlanned: boolean): AbsentBathAction {
  if (existing === null) return bathingPlanned ? { kind: 'insert' } : { kind: 'none' }
  if (existing.result === 'cancel') {
    if (existing.cancel_reason === 'absent') return { kind: 'already', record: existing }
    if (existing.auto) return { kind: 'update', record: existing, confirm: false }
    return { kind: 'keep', record: existing }
  }
  // 自動の行（全身浴・休業日の訪問）は確認なしで直す。人が記録した入浴は確認を挟む
  return { kind: 'update', record: existing, confirm: !existing.auto }
}

// ══════════════════════════════════════════════════════════════
// デイの画面の入浴の状態（2026-10-22 親セッション経由の本番の実測: 12:30 の自動の「全身浴」は誰も確かめないまま残っていた）
// 自動の記録（auto=true）は「確かめていない予定値」として見分け、〔予定どおり実施〕の1タップで人の記録にする。
// ※入浴の画面（既存 BathRecordPage）は 2026-10-01 代表指示どおり自動の印を出さないまま（この区別はデイの画面だけ）
// ══════════════════════════════════════════════════════════════

export type DaycareBathStatus =
  /** 入浴の予定も記録も無い */
  | { kind: 'noPlan' }
  /** 入浴の予定があり、まだ記録が無い（12:30 より前など） */
  | { kind: 'todo' }
  /** 自動の記録（cron が予定から作った・まだ誰も確かめていない） */
  | { kind: 'auto'; record: BathRecord }
  /** 人が記録した入浴（全身浴・シャワー浴・部分浴・清拭・訪問介護で入浴） */
  | { kind: 'done'; record: BathRecord }
  /** 人が記録した「入浴していない」（中止・欠席） */
  | { kind: 'notBathed'; record: BathRecord }

export function daycareBathStatus(record: BathRecord | null, bathingPlanned: boolean): DaycareBathStatus {
  if (record === null) return bathingPlanned ? { kind: 'todo' } : { kind: 'noPlan' }
  if (record.auto) return { kind: 'auto', record }
  if (record.result === 'cancel') return { kind: 'notBathed', record }
  return { kind: 'done', record }
}

/** 画面の一言（記号＋文字。色だけに頼らない） */
export function daycareBathLabel(st: DaycareBathStatus): string {
  if (st.kind === 'noPlan') return '予定なし'
  if (st.kind === 'todo') return '— 未'
  if (st.kind === 'auto') return `▲ 未確認（自動の記録: ${BATH_RESULT_LABEL[st.record.result]}）`
  if (st.kind === 'done') return `✓ ${BATH_RESULT_LABEL[st.record.result]}`
  const r = st.record.cancel_reason
  return `入浴していない（${r === null ? '理由なし' : BATH_CANCEL_REASON_LABEL[r]}）`
}

/** まだ人が確かめていない（予定あり・未記録か、自動の記録のまま） */
export function bathNeedsCheck(st: DaycareBathStatus): boolean {
  return st.kind === 'todo' || st.kind === 'auto'
}

// ══════════════════════════════════════════════════════════════
// 前回値・絞り込み
// ══════════════════════════════════════════════════════════════

// ── 日報の「発熱者」に載せるデイの測定（代表者の決定 2026-10-22） ──────────

/** 発熱（注意の高値以上＝今の基準 37.5℃以上）か。タイムラインの「▲発熱」（TimelinePage の isFever）と同じ判定 */
export function isFeverTemp(temp: number | null | undefined): boolean {
  const lv = tempLevel(typeof temp === 'number' ? temp : null)
  return lv === 'warn-high' || lv === 'danger-high'
}

/**
 * 日報の発熱者（kind='observation'）に載せる行。デイの測定（冪等キー dc: の行＝daycareIds）は、その方のその日のデイの測定に
 * 1回でも発熱があれば全部載せ（再測定の経過が見える）、無ければ載せない。デイ以外の行（日報で入れた発熱者）は今までどおり全部。
 * daycareIds が分からない（undefined）時は今までどおり全部載せる（消すより載せる）
 */
export function dailyFeverObservations<T extends { id: number; resident_id: number; temp: number | null }>(
  list: readonly T[],
  daycareIds: readonly number[] | undefined,
): T[] {
  if (daycareIds === undefined) return [...list]
  const dc = new Set(daycareIds)
  const fever = new Set<number>()
  for (const v of list) if (dc.has(v.id) && isFeverTemp(v.temp)) fever.add(v.resident_id)
  return list.filter((v) => !dc.has(v.id) || fever.has(v.resident_id))
}

/**
 * 前回値: その方の直近の測定（種類を問わない・その日のデイの測定を除く）。並びは測定日 → 測定時刻 → id の新しい順。
 * 欄ごとに「値のある直近」を選ぶ（血圧だけ測った日の後でも体温の前回が出る）
 */
export function previousVitalOf(
  rows: readonly KeyedVital[],
  residentId: number,
  day: string,
): Partial<Record<DaycareVitalField, { value: number; on: string }>> {
  const mine = rows
    .filter((v) => v.resident_id === residentId && v.measured_on <= day)
    .filter((v) => !(v.measured_on === day && isDaycareVitalKey(v.client_key)))
    .slice()
    .sort((a, b) =>
      a.measured_on !== b.measured_on
        ? b.measured_on.localeCompare(a.measured_on)
        : (b.measured_at ?? '').localeCompare(a.measured_at ?? '') || b.id - a.id,
    )
  const out: Partial<Record<DaycareVitalField, { value: number; on: string }>> = {}
  for (const f of DAYCARE_VITAL_FIELDS) {
    const hit = mine.find((v) => v[f] !== null && v[f] !== undefined)
    if (hit !== undefined) out[f] = { value: hit[f] as number, on: hit.measured_on }
  }
  return out
}

/** バイタル一括の絞り込み（UI 状態・既知値だけ） */
export type DcVitalsFilter = 'present' | 'planned' | 'all'
export const DC_VITALS_FILTERS: readonly DcVitalsFilter[] = ['present', 'planned', 'all']
export function readDcVitalsFilter(raw: unknown): DcVitalsFilter {
  return typeof raw === 'string' && (DC_VITALS_FILTERS as readonly string[]).includes(raw) ? (raw as DcVitalsFilter) : 'present'
}

/** 'YYYY-MM-DD' の形か */
export function isDay(v: unknown): v is string {
  return typeof v === 'string' && DAY_RE.test(v)
}

/**
 * 止まった（競合した）欄の「あなたの値」を、いまの送信待ちの値に置き換える。止まった後に打ち直すと送信待ちの値だけが
 * 新しくなり、競合した時に控えた値は古いまま残るため（反証レビュー2巡目 中1）。送信待ちに無い欄はそのまま
 */
export function overlayPendingMine<T extends { field: string; mine: unknown }>(conflicts: T[], pendingValues: Record<string, unknown> | null): T[] {
  if (pendingValues === null) return conflicts
  return conflicts.map((c) => (Object.prototype.hasOwnProperty.call(pendingValues, c.field) ? { ...c, mine: pendingValues[c.field] } : c))
}
