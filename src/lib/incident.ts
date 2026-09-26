// 事故・ヒヤリハットの純ロジック（副作用なし・DB/DOM に触れない）。2026-09-26 追加。
// 入力・編集（IncidentFormPage）・一覧（IncidentListPage）・月次集計（IncidentSummaryPage）・db.ts が共通で使う。
// 拡張子付きで import する（bath.ts・med.ts と同じ。tests/incident.test.mjs から直接読めるようにするため）
//
// 様式は熊本市の「事故報告書（事業者→熊本市）」。選択肢の並び・文言の正本は types.ts の INCIDENT_* 定数。
// 市への報告が要るかどうかの判断は人がする（cityReportHint は案内を出すかどうかだけ）。
// 個人情報: ここには氏名も記録本文も書かない（型と計算だけ）。集計の結果に氏名・対象者を入れない。

import {
  INCIDENT_ADDRESS_KINDS,
  INCIDENT_CARE_LEVELS,
  INCIDENT_DEMENTIA_LEVELS,
  INCIDENT_DIAGNOSIS_KINDS,
  INCIDENT_FAMILY_RELATIONS,
  INCIDENT_GENDERS,
  INCIDENT_KIND_LABEL,
  INCIDENT_KINDS,
  INCIDENT_OFFICES,
  INCIDENT_PLACE_LABEL,
  INCIDENT_PLACES,
  INCIDENT_REPORT_STAGES,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABEL,
  INCIDENT_STATUSES,
  INCIDENT_TYPE_LABEL,
  INCIDENT_TYPES,
  INCIDENT_VISIT_METHODS,
} from './types.ts'
import type {
  Incident,
  IncidentCareLevel,
  IncidentDetail,
  IncidentGender,
  IncidentKind,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
} from './types.ts'
import { localDayOf } from './med.ts'
import { monthDays } from './bath.ts'

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// ── 案内の文言（画面と紙で同じ） ────────────────────────────────────────────

/** 市への報告が必要な可能性がある時の案内（判断は人。チェックは人が付ける） */
export const CITY_REPORT_HINT =
  '市への報告が必要な可能性があります（事故で、程度が受診・入院・死亡のいずれか、または種別に誤嚥・窒息／誤薬、与薬もれ等を含む）。判断して「市への報告が必要」に印を付けてください。'
/** 第1報の期限の注記 */
export const CITY_REPORT_DEADLINE_NOTE = '第1報は発生から5日以内が目安（国の通知）'
/** 様式の注記（紙の上部にそのまま刷る） */
export const FORM_NOTE_FIRST =
  '※第１報（電話での第一報を除く）は、少なくとも1から6までについては可能な限り記載し、事故発生後速やかに、遅くとも５日以内を目安に提出すること'
export const FORM_NOTE_CHOICES = '※選択肢については該当する項目をチェックし、該当する項目が複数ある場合は全て選択すること'
/** 保険者の既定値 */
export const DEFAULT_INSURER = '熊本市'

// ── detail（様式の残りの欄） ───────────────────────────────────────────────

/** 空の detail（新しい記録の初期値・受信値が読めない時の既定値） */
export function emptyIncidentDetail(): IncidentDetail {
  return {
    severity_other: null,
    death_on: null,
    subject_name: null,
    subject_age: null,
    subject_gender: null,
    service_start_on: null,
    insurer: null,
    address_kind: null,
    address_other: null,
    care_level: null,
    dementia_level: null,
    type_other: null,
    situation: null,
    special_notes: null,
    response: null,
    visit_methods: [],
    visit_method_other: null,
    hospital_name: null,
    hospital_phone: null,
    diagnosis_name: null,
    diagnosis_kinds: [],
    fracture_site: null,
    diagnosis_other: null,
    treatment: null,
    after_status: null,
    family_relations: [],
    family_relation_other: null,
    family_reported_on: null,
    agency_municipality: false,
    agency_municipality_name: null,
    agency_police: false,
    agency_police_name: null,
    agency_other: false,
    agency_other_name: null,
    followup: null,
    cause: null,
    prevention: null,
    other_notes: null,
  }
}

/** detail の文字の欄（空は null にそろえる） */
const TEXT_KEYS = [
  'severity_other',
  'subject_name',
  'insurer',
  'address_other',
  'type_other',
  'situation',
  'special_notes',
  'response',
  'visit_method_other',
  'hospital_name',
  'hospital_phone',
  'diagnosis_name',
  'fracture_site',
  'diagnosis_other',
  'treatment',
  'after_status',
  'family_relation_other',
  'agency_municipality_name',
  'agency_police_name',
  'agency_other_name',
  'followup',
  'cause',
  'prevention',
  'other_notes',
] as const
/** detail の日付の欄（'YYYY-MM-DD' だけ） */
const DATE_KEYS = ['death_on', 'service_start_on', 'family_reported_on'] as const
const BOOL_KEYS = ['agency_municipality', 'agency_police', 'agency_other'] as const

function textOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function oneOfKeys<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null
}

/** 選択肢の配列（知らない値・重複・文字列以外は落とし、様式の並びにそろえる） */
export function normalizeChoices<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(v)) return []
  const set = new Set(v.filter((x): x is string => typeof x === 'string'))
  return allowed.filter((k) => set.has(k))
}

/**
 * 受信した detail（jsonb）を型にそろえる（受信値を信じない）。
 * 知らないキーは捨て、知らない選択肢は null／配列から外す。読めない時は空の detail
 */
export function normalizeIncidentDetail(raw: unknown): IncidentDetail {
  const out = emptyIncidentDetail()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const r = raw as Record<string, unknown>
  for (const k of TEXT_KEYS) out[k] = textOf(r[k])
  for (const k of DATE_KEYS) out[k] = typeof r[k] === 'string' && DAY_RE.test(r[k] as string) ? (r[k] as string) : null
  for (const k of BOOL_KEYS) out[k] = r[k] === true
  const age = typeof r.subject_age === 'number' ? r.subject_age : typeof r.subject_age === 'string' ? Number(r.subject_age) : NaN
  out.subject_age = Number.isInteger(age) && age >= 0 && age <= 130 ? age : null
  out.subject_gender = oneOfKeys(r.subject_gender, INCIDENT_GENDERS)
  out.address_kind = oneOfKeys(r.address_kind, INCIDENT_ADDRESS_KINDS)
  out.care_level = oneOfKeys(r.care_level, INCIDENT_CARE_LEVELS)
  out.dementia_level = oneOfKeys(r.dementia_level, INCIDENT_DEMENTIA_LEVELS)
  out.visit_methods = normalizeChoices(r.visit_methods, INCIDENT_VISIT_METHODS)
  out.diagnosis_kinds = normalizeChoices(r.diagnosis_kinds, INCIDENT_DIAGNOSIS_KINDS)
  out.family_relations = normalizeChoices(r.family_relations, INCIDENT_FAMILY_RELATIONS)
  return out
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** detail の変わった欄だけ（保存の差分・競合の重ね直しに使う） */
export function detailChanges(base: IncidentDetail, draft: IncidentDetail): Partial<IncidentDetail> {
  const out: Partial<IncidentDetail> = {}
  for (const k of Object.keys(draft) as (keyof IncidentDetail)[]) {
    if (!sameValue(base[k], draft[k])) (out as Record<string, unknown>)[k] = draft[k]
  }
  return out
}

// ── 名簿からの初期値 ──────────────────────────────────────────────────────

/** 全角数字を半角に（要介護度の「要介護３」等） */
function halfDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

/** 名簿の介護度（'要介護3' '要支援１' '自立' 等）→ 様式のキー。読めなければ null */
export function careLevelKeyOf(raw: string | null | undefined): IncidentCareLevel | null {
  if (typeof raw !== 'string') return null
  const s = halfDigits(raw).replace(/[\s　]/g, '')
  const m = /^要(支援|介護)([1-5])$/.exec(s)
  if (m !== null) {
    const n = Number(m[2])
    if (m[1] === '支援') return n === 1 ? 'support1' : n === 2 ? 'support2' : null
    return `care${n}` as IncidentCareLevel
  }
  if (s === '自立' || s === '非該当') return 'independent'
  return null
}

/** 名簿の性別（'男' '男性' '女' '女性' 等）→ 様式のキー。読めなければ null */
export function genderKeyOf(raw: string | null | undefined): IncidentGender | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (s === '男' || s === '男性') return 'male'
  if (s === '女' || s === '女性') return 'female'
  return null
}

// ── 入力の検証（画面と db.ts の両方で通す） ────────────────────────────────

/** 保存する値（id・rev を除く記録の全部） */
export type IncidentInput = Omit<Incident, 'id' | 'rev'>

export type IncidentCheck = { ok: true } | { ok: false; message: string }

/** 発生時刻を少しだけ先の時刻まで許す（端末の時計のずれ） */
const FUTURE_GRACE_MS = 5 * 60_000

const blank = (s: string | null | undefined): boolean => s === null || s === undefined || s.trim() === ''

function validDay(s: string | null): boolean {
  if (s === null) return true
  const m = DAY_RE.exec(s)
  if (m === null) return false
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])
}

/**
 * 保存前の検証。today は端末の今日（JST）、now は端末の現在時刻。
 * 第1報に必要な最小項目（区分・発生日時・場所・種別・対象者（事故のみ）・発生時状況・発生時の対応・記録者）だけで通る。
 * 残りの欄は空でよいが、入れてあれば形を確かめる。「その他」を選んだ欄は、その内容の文字が必須
 */
export function validateIncidentInput(v: IncidentInput, today: string, now: Date = new Date()): IncidentCheck {
  const d = v.detail
  // ── 第1報に必要な項目 ──
  if (!(INCIDENT_KINDS as readonly string[]).includes(v.kind)) {
    return { ok: false, message: '区分（事故・ヒヤリハット）を選んでください。' }
  }
  if (!DAY_RE.test(v.occurred_on) || !validDay(v.occurred_on)) {
    return { ok: false, message: '発生日を入れてください。' }
  }
  if (DAY_RE.test(today) && v.occurred_on > today) {
    return { ok: false, message: '未来の日付には記録できません。発生日を今日以前にしてください。' }
  }
  const at = typeof v.occurred_at === 'string' ? localDayOf(v.occurred_at) : null
  if (at === null) return { ok: false, message: '発生時刻を入れてください（24時間表記）。' }
  if (at !== v.occurred_on) return { ok: false, message: '発生時刻は発生日の時刻にしてください。' }
  if (new Date(v.occurred_at).getTime() > now.getTime() + FUTURE_GRACE_MS) {
    return { ok: false, message: '発生時刻が今より先になっています。時刻を確かめてください。' }
  }
  if (v.place === null || !(INCIDENT_PLACES as readonly string[]).includes(v.place)) {
    return { ok: false, message: '発生場所を選んでください。' }
  }
  if (v.place === 'other' && blank(v.place_other)) {
    return { ok: false, message: '発生場所が「その他」の時は、場所を書いてください。' }
  }
  if (!Array.isArray(v.types) || v.types.length === 0) {
    return { ok: false, message: '事故の種別を1つ以上選んでください。' }
  }
  if (v.types.some((t) => !(INCIDENT_TYPES as readonly string[]).includes(t)) || new Set(v.types).size !== v.types.length) {
    return { ok: false, message: '事故の種別を読み取れませんでした。選び直してください。' }
  }
  if (v.types.includes('other') && blank(d.type_other)) {
    return { ok: false, message: '種別が「その他」の時は、内容を書いてください。' }
  }
  if (v.kind === 'accident' && v.resident_id === null) {
    return { ok: false, message: '事故の時は対象者を選んでください（対象者なしはヒヤリハットだけ）。' }
  }
  if (blank(d.situation)) return { ok: false, message: '発生時状況・事故内容の詳細を書いてください。' }
  if (blank(d.response)) return { ok: false, message: '発生時の対応を書いてください。' }
  if (v.reporter_id === null) return { ok: false, message: '記録者を選んでください。' }

  // ── 残りの欄（入れてあれば形を確かめる・「その他」は内容が必須） ──
  if (v.office !== null && !(INCIDENT_OFFICES as readonly string[]).includes(v.office)) {
    return { ok: false, message: 'サービス種別を読み取れませんでした。選び直してください。' }
  }
  if (v.severity !== null && !(INCIDENT_SEVERITIES as readonly string[]).includes(v.severity)) {
    return { ok: false, message: '事故状況の程度を読み取れませんでした。選び直してください。' }
  }
  if (v.severity === 'other' && blank(d.severity_other)) {
    return { ok: false, message: '程度が「その他」の時は、内容を書いてください。' }
  }
  if (!(INCIDENT_STATUSES as readonly string[]).includes(v.status)) {
    return { ok: false, message: '状態を読み取れませんでした。画面を読み直してください。' }
  }
  if (v.report_stage !== null && !(INCIDENT_REPORT_STAGES as readonly string[]).includes(v.report_stage)) {
    return { ok: false, message: '報告区分を読み取れませんでした。選び直してください。' }
  }
  if (v.report_stage === 'nth' && (v.report_no === null || !Number.isInteger(v.report_no) || v.report_no < 2 || v.report_no > 99)) {
    return { ok: false, message: '「第＿報」の時は、2 以上の数を入れてください。' }
  }
  for (const [label, day] of [
    ['提出日', v.submitted_on],
    ['市へ報告した日', v.city_reported_on],
    ['死亡年月日', d.death_on],
    ['サービス提供開始日', d.service_start_on],
    ['家族等への報告年月日', d.family_reported_on],
  ] as const) {
    if (!validDay(day)) return { ok: false, message: `${label}を読み取れませんでした。日付を選び直してください。` }
  }
  if (d.subject_age !== null && (!Number.isInteger(d.subject_age) || d.subject_age < 0 || d.subject_age > 130)) {
    return { ok: false, message: '年齢は 0〜130 の数で入れてください。' }
  }
  if (d.address_kind === 'other' && blank(d.address_other)) {
    return { ok: false, message: '住所が「その他」の時は、住所を書いてください。' }
  }
  if (d.visit_methods.includes('other') && blank(d.visit_method_other)) {
    return { ok: false, message: '受診方法が「その他」の時は、内容を書いてください。' }
  }
  if (d.diagnosis_kinds.includes('other') && blank(d.diagnosis_other)) {
    return { ok: false, message: '診断内容が「その他」の時は、内容を書いてください。' }
  }
  if (d.family_relations.includes('other') && blank(d.family_relation_other)) {
    return { ok: false, message: '報告した家族等の続柄が「その他」の時は、続柄を書いてください。' }
  }
  if (d.agency_other && blank(d.agency_other_name)) {
    return { ok: false, message: '連絡した関係機関が「その他」の時は、名称を書いてください。' }
  }
  return { ok: true }
}

/** 完了にする前に確かめる欄（原因分析と再発防止策が空なら確認を出す） */
export function missingForClose(d: IncidentDetail): string[] {
  const out: string[] = []
  if (blank(d.cause)) out.push('7 事故の原因分析')
  if (blank(d.prevention)) out.push('8 再発防止策')
  return out
}

// ── 市への報告の案内 ────────────────────────────────────────────────────────

/**
 * 「市への報告が必要な可能性」の案内を出すか（判断は人。city_report_needed は人が付ける）。
 * 区分が事故で、程度が受診・入院・死亡のいずれか、または種別に誤嚥・窒息／誤薬、与薬もれ等を含む時
 */
export function cityReportHint(kind: IncidentKind | null, severity: IncidentSeverity | null, types: readonly IncidentType[]): boolean {
  if (kind !== 'accident') return false
  if (severity === 'treated' || severity === 'hospitalized' || severity === 'death') return true
  return types.includes('aspiration') || types.includes('med_error')
}

/** 一覧の「市への報告」欄: 要（未報告）／報告済み（日付）／—（不要） */
export function cityReportState(i: Pick<Incident, 'city_report_needed' | 'city_reported_on'>): 'pending' | 'reported' | 'none' {
  if (i.city_reported_on !== null) return 'reported'
  return i.city_report_needed ? 'pending' : 'none'
}

/** 一覧の上部の件数（対応中の数・市へ報告が要で未報告の数） */
export function incidentCounts(list: readonly Pick<Incident, 'status' | 'city_report_needed' | 'city_reported_on'>[]): {
  open: number
  cityPending: number
} {
  let open = 0
  let cityPending = 0
  for (const i of list) {
    if (i.status === 'open') open += 1
    if (cityReportState(i) === 'pending') cityPending += 1
  }
  return { open, cityPending }
}

// ── 期間 ────────────────────────────────────────────────────────────────

/** 一覧の既定の期間（直近3か月＝今日の3か月前の同じ日から今日まで。月末は繰り上がる） */
export function defaultIncidentRange(today: string): { from: string; to: string } {
  const m = DAY_RE.exec(today)
  if (m === null) return { from: today, to: today }
  const d = new Date(Number(m[1]), Number(m[2]) - 1 - 3, Number(m[3]))
  const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from, to: today }
}

// ── 与薬チェックからの受け渡し（URL の値を照合する） ─────────────────────────

/**
 * /incident/new?resident=ID&date=YYYY-MM-DD&type=キー の値を照合する（原則11と同じく既知の値だけ受ける）。
 * resident は在籍の方の id だけ、date は今日以前の正しい日付だけ、type は種別のキーだけ。違えば null（入れない）。
 * URL に氏名は載せない（id・日付・種別のキーだけ）
 */
export function parseIncidentPrefill(
  search: string,
  activeResidentIds: ReadonlySet<number>,
  today: string,
): { residentId: number | null; day: string | null; type: IncidentType | null } {
  const p = new URLSearchParams(search)
  const rawId = p.get('resident')
  const id = rawId !== null && /^\d{1,12}$/.test(rawId) ? Number(rawId) : null
  const rawDay = p.get('date')
  const day = rawDay !== null && DAY_RE.test(rawDay) && validDay(rawDay) && rawDay <= today ? rawDay : null
  return {
    residentId: id !== null && activeResidentIds.has(id) ? id : null,
    day,
    type: oneOfKeys(p.get('type'), INCIDENT_TYPES),
  }
}

// ── 委員会用の月次集計 ─────────────────────────────────────────────────────

/** 時間帯の区切り（時）。0-6 / 6-9 / 9-12 / 12-15 / 15-18 / 18-21 / 21-24（始まりを含み終わりを含まない） */
export const INCIDENT_TIME_BANDS: readonly [number, number][] = [
  [0, 6],
  [6, 9],
  [9, 12],
  [12, 15],
  [15, 18],
  [18, 21],
  [21, 24],
]

/** 発生時刻（ISO）→ 時間帯の番号（端末の時刻）。読めなければ null */
export function timeBandOf(iso: string): number | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const h = d.getHours()
  const i = INCIDENT_TIME_BANDS.findIndex(([from, to]) => h >= from && h < to)
  return i < 0 ? null : i
}

export function timeBandLabel(i: number): string {
  const b = INCIDENT_TIME_BANDS[i]
  return b === undefined ? '' : `${b[0]}-${b[1]}時`
}

/** 集計表の1行（区分ごとの件数と計） */
export interface IncidentCountRow {
  key: string
  label: string
  accident: number
  nearmiss: number
  total: number
}

/** 未完了の1件（委員会の資料に出す。**氏名・対象者は持たない**） */
export interface IncidentOpenItem {
  id: number
  occurred_on: string
  kind: IncidentKind
  types: IncidentType[]
  status: IncidentStatus
}

export interface IncidentMonthSummary {
  month: string
  total: { accident: number; nearmiss: number; total: number }
  byType: IncidentCountRow[]
  byPlace: IncidentCountRow[]
  byBand: IncidentCountRow[]
  bySeverity: IncidentCountRow[]
  open: IncidentOpenItem[]
}

function countRow(key: string, label: string): IncidentCountRow {
  return { key, label, accident: 0, nearmiss: 0, total: 0 }
}

function bump(row: IncidentCountRow, kind: IncidentKind): void {
  if (kind === 'accident') row.accident += 1
  else row.nearmiss += 1
  row.total += 1
}

const UNSET_KEY = 'unset'
const UNSET_LABEL = '未入力'

/**
 * その月（'yyyy-MM'）の集計。発生日（occurred_on）がその月の記録だけを数える。
 * 種別は1件に複数あれば、それぞれに数える（種別の行の合計は件数より多くなることがある）。
 * 場所・程度が空の記録は「未入力」に数える。未完了の一覧は発生日の古い順で、**氏名・対象者を出さない**
 */
export function aggregateIncidentMonth(list: readonly Incident[], month: string): IncidentMonthSummary {
  const days = monthDays(month)
  const from = days[0] ?? ''
  const to = days[days.length - 1] ?? ''
  const inMonth = days.length === 0 ? [] : list.filter((i) => i.occurred_on >= from && i.occurred_on <= to)
  const total = { accident: 0, nearmiss: 0, total: 0 }
  const byType = INCIDENT_TYPES.map((t) => countRow(t, INCIDENT_TYPE_LABEL[t]))
  const byPlace = [...INCIDENT_PLACES.map((p) => countRow(p, INCIDENT_PLACE_LABEL[p])), countRow(UNSET_KEY, UNSET_LABEL)]
  const byBand = INCIDENT_TIME_BANDS.map((_, i) => countRow(String(i), timeBandLabel(i)))
  const bySeverity = [
    ...INCIDENT_SEVERITIES.map((s) => countRow(s, INCIDENT_SEVERITY_LABEL[s])),
    countRow(UNSET_KEY, UNSET_LABEL),
  ]
  const open: IncidentOpenItem[] = []
  for (const i of inMonth) {
    if (!(INCIDENT_KINDS as readonly string[]).includes(i.kind)) continue
    if (i.kind === 'accident') total.accident += 1
    else total.nearmiss += 1
    total.total += 1
    for (const t of i.types) {
      const row = byType.find((r) => r.key === t)
      if (row !== undefined) bump(row, i.kind)
    }
    bump(byPlace.find((r) => r.key === (i.place ?? UNSET_KEY)) ?? byPlace[byPlace.length - 1], i.kind)
    const band = timeBandOf(i.occurred_at)
    if (band !== null) bump(byBand[band], i.kind)
    bump(bySeverity.find((r) => r.key === (i.severity ?? UNSET_KEY)) ?? bySeverity[bySeverity.length - 1], i.kind)
    if (i.status !== 'closed') {
      // 氏名・対象者・本文はここへ写さない（委員会の資料に出すため）
      open.push({ id: i.id, occurred_on: i.occurred_on, kind: i.kind, types: [...i.types], status: i.status })
    }
  }
  open.sort((a, b) => (a.occurred_on === b.occurred_on ? a.id - b.id : a.occurred_on < b.occurred_on ? -1 : 1))
  return { month, total, byType, byPlace, byBand, bySeverity, open }
}

// ── 表示の小物 ──────────────────────────────────────────────────────────────

/** 印刷の選択肢の印（選んだもの＝■／選んでいない＝□。白黒でも読める文字で持つ） */
export function checkMark(on: boolean): string {
  return on ? '■' : '□'
}

/** 種別の並びを文字に（'転倒・誤薬、与薬もれ等'） */
export function typesText(types: readonly IncidentType[]): string {
  return types.map((t) => INCIDENT_TYPE_LABEL[t] ?? t).join('・')
}

/** 区分の短い表示（一覧・集計） */
export function kindShortLabel(kind: IncidentKind): string {
  return kind === 'accident' ? INCIDENT_KIND_LABEL.accident : 'ヒヤリ'
}
