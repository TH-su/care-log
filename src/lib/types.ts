// 型・定数・しきい値の正本（凍結契約）。
// ビルダーはこのファイルを変更しない。変更が必要になったら実装せずチーフへ差し戻す。

// routine=定時1回/日 ・ recheck=再検枠 ・ observation=発熱者（経過観察） ・ symptom=他症状者
// （observation / symptom は現行スプシの申し送りシート上部2ブロックに対応。1人1日複数行を許す）
export type VitalKind = 'routine' | 'recheck' | 'observation' | 'symptom'
export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack'
export type MealStatus = 'eaten' | 'out' | 'hospital' | 'refused'
export type Shift = 'day' | 'daycare' | 'night'
export type Importance = 'normal' | 'important' | 'critical'
export type OutingKind = 'outing' | 'overnight'

export interface Resident {
  id: number
  source_id: string
  name: string
  kana: string | null
  room: string | null
  gender: string | null
  care_level: string | null
  active: boolean
  needs_review: boolean
  /**
   * 申し送りでの表示名（2026-09-01 指示）。同姓の入居者を見分けるための表示専用の別名。
   * 空（null）＝マスタの氏名（name）をそのまま出す。
   * ★申し送りを扱う画面**だけ**で使う。バイタル・食事・カルテ・外出外泊はマスタの氏名のまま。
   * ★マスタ同期（gasClient.applyResidents）はこの列に触れないので、同期で消えない。
   */
  note_alias: string | null
}

/** 申し送りでの表示名の最大文字数（長い別名は行の幅を壊すので上限を置く） */
export const NOTE_ALIAS_MAX = 30

/**
 * 氏名を突き合わせる時のキー。空白（半角・全角）を除いて比べる。
 * 姓と名の間が半角空白か全角空白か、という違いだけで別人と扱わないため。
 */
export function nameKey(s: string): string {
  return s.replace(/[\s\u3000]/g, '')
}

/**
 * 申し送りでの表示名。設定が無ければマスタの氏名を返す。
 * **申し送りを扱う画面だけがこれを呼ぶ**（呼ばない画面はマスタの氏名のまま）。
 */
export function noteDisplayName(r: Resident): string {
  const alias = r.note_alias === null ? '' : r.note_alias.trim()
  return alias === '' ? r.name : alias
}

/** 表示名を設定してあるか（マスタの氏名と違う名前で出している行か） */
export function hasNoteAlias(r: Resident): boolean {
  return noteDisplayName(r) !== r.name
}

export type NoteAliasCheck =
  | { ok: true; value: string | null }
  | { ok: false; message: string }

/**
 * 申し送りでの表示名の検証（保存前に必ず通す）。
 *
 * 空にした時は null を返す＝マスタの氏名に戻す（空文字を保存しない。null と空の区別・原則12）。
 *
 * ★**他の方のマスタ氏名・他の方の表示名と同じ名前は弾く。**
 *   取り違えを防ぐための機能なのに、別人と同じ表示にできてしまうと逆効果になるため。
 *   比較は nameKey（空白を除く）で行う。
 *
 * @param raw    入力された文字
 * @param selfId 設定しようとしている利用者のID（自分自身は突き合わせから外す）
 * @param others 突き合わせ相手（**退居された方も含めた全員**を渡す。過去の記録に残るため）
 */
export function validateNoteAlias(
  raw: string,
  selfId: number,
  others: Resident[],
): NoteAliasCheck {
  const value = raw.trim()
  if (value === '') return { ok: true, value: null }
  if (value.length > NOTE_ALIAS_MAX) {
    return { ok: false, message: `表示名は${NOTE_ALIAS_MAX}文字までにしてください。` }
  }
  const key = nameKey(value)
  if (key === '') return { ok: false, message: '空白だけの表示名は使えません。' }
  for (const o of others) {
    if (o.id === selfId) continue
    if (nameKey(o.name) === key) {
      return {
        ok: false,
        message: '別の利用者のお名前と同じ表示名は使えません（取り違えのもとになります）。',
      }
    }
    const alias = o.note_alias === null ? '' : o.note_alias.trim()
    if (alias !== '' && nameKey(alias) === key) {
      return {
        ok: false,
        message: '別の利用者の表示名と同じ表示名は使えません（取り違えのもとになります）。',
      }
    }
  }
  return { ok: true, value }
}

export interface Staff {
  id: number
  name: string
  active: boolean
}

export interface Vital {
  id: number
  resident_id: number
  measured_on: string
  kind: VitalKind
  measured_at: string | null
  temp: number | null
  sys_bp: number | null
  dia_bp: number | null
  pulse: number | null
  spo2: number | null
  note: string | null
  /** 他症状者ブロックの「症状」欄（kind='symptom' で使う） */
  symptom: string | null
  recorded_by: number | null
  rev: number
}

export interface Meal {
  id: number
  resident_id: number
  meal_on: string
  meal_slot: MealSlot
  main_amount: number | null
  side_amount: number | null
  status: MealStatus | null
  note: string | null
  recorded_by: number | null
  rev: number
}

export interface FluidIntake {
  id: number
  resident_id: number
  taken_on: string
  taken_at: string | null
  amount_ml: number
  kind: string | null
  recorded_by: number | null
  rev: number
}

export interface Note {
  id: number
  note_on: string
  shift: Shift
  facility: string | null
  category: string | null
  resident_id: number | null
  role_tags: string[]
  importance: Importance
  body: string
  occurred_at: string | null
  ongoing: boolean
  ended_at: string | null
  reporter_id: number | null
  /** 行の色。null=既定（白）。生の色コードでなくトークン名を持つ（ダークモードでも読める色へ解決する） */
  color: NoteColor | null
  /** 日勤の「↓16時以降の記録」より後に書かれた行（現行スプシの区切りを再現する） */
  after16: boolean
  rev: number
  read_count?: number
  my_read?: boolean
}

/** 申し送り行の色。既定は用途に紐づくが、記入者が後から変更できる（現行スプシの手動着色に相当） */
export type NoteColor = 'pink' | 'yellow' | 'blue' | 'green' | 'orange'

export const NOTE_COLOR_LABEL: Record<NoteColor, string> = {
  pink: '予定',
  yellow: '全体連絡',
  blue: '医療・受診',
  green: '完了・確認済み',
  orange: '要注意',
}

/** 出勤者（現行スプシ申し送りシート上部の「施設長／出勤者」欄） */
export interface Attendance {
  day: string
  staff_id: number
  role: 'manager' | 'staff'
  sort: number
}

export interface Outing {
  id: number
  resident_id: number
  kind: OutingKind
  start_on: string
  start_at: string | null
  end_on: string | null
  end_at: string | null
  companion: string | null
  note: string | null
  recorded_by: number | null
  rev: number
}

// ── デイの入浴記録（2026-09-26 追加・契約改訂は代表承認済み・0012_bath_records.sql） ──

/** 入浴の区分。full=全身浴 / shower=シャワー浴 / partial=部分浴・清拭 / cancel=中止 */
export type BathResult = 'full' | 'shower' | 'partial' | 'cancel'
/** 中止の理由。condition=体調不良 / refusal=本人の拒否 / facility=事業所の都合 / other=その他（備考必須） */
export type BathCancelReason = 'condition' | 'refusal' | 'facility' | 'other'

/** 入浴記録（1人1日1件。bath_on は JST の業務日付） */
export interface BathRecord {
  id: number
  resident_id: number
  bath_on: string
  result: BathResult
  /** result='cancel' の時だけ値を持つ（それ以外は null） */
  cancel_reason: BathCancelReason | null
  note: string | null
  recorded_by: number | null
  rev: number
}

/** 画面のボタンの並び（左→右） */
export const BATH_RESULTS: readonly BathResult[] = ['full', 'shower', 'partial', 'cancel']
export const BATH_RESULT_LABEL: Record<BathResult, string> = {
  full: '全身浴',
  shower: 'シャワー浴',
  partial: '部分浴・清拭',
  cancel: '中止',
}
/** 月次表・印刷の1文字（白黒でも区別できるよう文字で持つ） */
export const BATH_RESULT_MARK: Record<BathResult, string> = {
  full: '全',
  shower: 'シ',
  partial: '部',
  cancel: '中',
}
export const BATH_CANCEL_REASONS: readonly BathCancelReason[] = ['condition', 'refusal', 'facility', 'other']
export const BATH_CANCEL_REASON_LABEL: Record<BathCancelReason, string> = {
  condition: '体調不良',
  refusal: '本人の拒否',
  facility: '事業所の都合',
  other: 'その他',
}

// ── 服薬介助の実施チェック（2026-09-26 追加・契約改訂は代表承認済み・0013_med_admin.sql） ──
// 薬の名前は持たない（処方の正本は入居者マスタで自由記述）。頓服だけ、使った薬を自由記述で残す。

/** 服薬の時間帯。morning=朝 / noon=昼 / evening=夕 / bedtime=眠前 */
export type MedSlot = 'morning' | 'noon' | 'evening' | 'bedtime'
/** 記録の時間帯（時間帯＋頓服 prn） */
export type MedAdminSlot = MedSlot | 'prn'
/**
 * 実施の状態。taken=服用済み / partial=一部残し / refused=拒否（再度の声かけ後も）/ absent=不在（外出・入院）/
 * stopped=医師指示で中止 / dropped=落薬 / wrong=誤薬。頓服は taken のみ
 */
export type MedStatus = 'taken' | 'partial' | 'refused' | 'absent' | 'stopped' | 'dropped' | 'wrong'

/** 入居者ごとの服薬の時間帯の設定（1人1件） */
export interface MedSlotsSetting {
  id: number
  resident_id: number
  /** 服薬のある時間帯（MED_SLOTS の順にそろえて持つ。空＝服薬なし） */
  slots: MedSlot[]
  note: string | null
  rev: number
}

/** 与薬の記録（1人1日1時間帯1件。頓服は何件でも。admin_on は JST の業務日付） */
export interface MedAdmin {
  id: number
  resident_id: number
  admin_on: string
  slot: MedAdminSlot
  status: MedStatus
  /** 頓服の使用時刻（ISO 8601）。頓服以外は null */
  given_at: string | null
  /** 頓服の薬（自由記述）・理由・効果（効果は後から追記）。頓服以外は null */
  prn_drug: string | null
  prn_reason: string | null
  prn_effect: string | null
  note: string | null
  recorded_by: number | null
  rev: number
  /** 記録した時刻（サーバーの created_at。時間帯の記録の「いつ記録したか」に使う） */
  created_at: string | null
}

/** 表の列の並び（左→右） */
export const MED_SLOTS: readonly MedSlot[] = ['morning', 'noon', 'evening', 'bedtime']
export const MED_ADMIN_SLOTS: readonly MedAdminSlot[] = ['morning', 'noon', 'evening', 'bedtime', 'prn']
export const MED_SLOT_LABEL: Record<MedAdminSlot, string> = {
  morning: '朝',
  noon: '昼',
  evening: '夕',
  bedtime: '眠前',
  prn: '頓服',
}
/** 状態の小窓の並び（上→下） */
export const MED_STATUSES: readonly MedStatus[] = ['taken', 'partial', 'refused', 'absent', 'stopped', 'dropped', 'wrong']
export const MED_STATUS_LABEL: Record<MedStatus, string> = {
  taken: '服用済み',
  partial: '一部残し',
  refused: '拒否（再度の声かけ後も）',
  absent: '不在（外出・入院）',
  stopped: '医師指示で中止',
  dropped: '落薬',
  wrong: '誤薬',
}
/** 表・月次表・印刷の1文字（白黒でも区別できるよう文字で持つ） */
export const MED_STATUS_MARK: Record<MedStatus, string> = {
  taken: '済',
  partial: '残',
  refused: '拒',
  absent: '不',
  stopped: '止',
  dropped: '落',
  wrong: '誤',
}

/**
 * 種類ごとの入力解禁（2026-09-26 追加）。app_settings の input_enabled_<種類> を読む。
 * 既存の native_input_enabled（切替日D）とは別の旗で、種類ごとに開始日を決められる。
 */
export type InputKind = 'bath' | 'med' | 'incident'
export const INPUT_KINDS: readonly InputKind[] = ['bath', 'med', 'incident']

// ── 事故・ヒヤリハット（2026-09-26 追加・契約改訂は代表承認済み・0014_incidents.sql） ──
// 熊本市の「事故報告書（事業者→熊本市）」の欄と選択肢に合わせる（並び・文言は様式どおり。変える時は様式を確かめる）。
// 列で持つのは一覧・集計・絞り込みに使う項目だけ。様式の残りの欄は detail（jsonb・下の IncidentDetail）に持つ。
// 身体拘束の記録はここでは扱わない。

/** 区分。accident=事故 / nearmiss=ヒヤリハット */
export type IncidentKind = 'accident' | 'nearmiss'
export const INCIDENT_KINDS: readonly IncidentKind[] = ['accident', 'nearmiss']
export const INCIDENT_KIND_LABEL: Record<IncidentKind, string> = { accident: '事故', nearmiss: 'ヒヤリハット' }

/** 事業所（様式の「サービス種別」）。facility=入所（住宅型）/ visit=訪問 / daycare=通所 */
export type IncidentOffice = 'facility' | 'visit' | 'daycare'
export const INCIDENT_OFFICES: readonly IncidentOffice[] = ['facility', 'visit', 'daycare']
export const INCIDENT_OFFICE_LABEL: Record<IncidentOffice, string> = { facility: '入所', visit: '訪問', daycare: '通所' }

/** 発生場所（様式の並び） */
export type IncidentPlace =
  | 'room_private'
  | 'room_shared'
  | 'toilet'
  | 'hallway'
  | 'common'
  | 'bathroom'
  | 'training'
  | 'premises'
  | 'offsite'
  | 'other'
export const INCIDENT_PLACES: readonly IncidentPlace[] = [
  'room_private',
  'room_shared',
  'toilet',
  'hallway',
  'common',
  'bathroom',
  'training',
  'premises',
  'offsite',
  'other',
]
export const INCIDENT_PLACE_LABEL: Record<IncidentPlace, string> = {
  room_private: '居室（個室）',
  room_shared: '居室（多床室）',
  toilet: 'トイレ',
  hallway: '廊下',
  common: '食堂等共用部',
  bathroom: '浴室・脱衣室',
  training: '機能訓練室',
  premises: '施設敷地内の建物外',
  offsite: '敷地外',
  other: 'その他',
}

/** 事故の種別（様式の並び・複数選択可） */
export type IncidentType = 'fall' | 'fall_from' | 'aspiration' | 'pica' | 'med_error' | 'medical' | 'unknown' | 'other'
export const INCIDENT_TYPES: readonly IncidentType[] = [
  'fall',
  'fall_from',
  'aspiration',
  'pica',
  'med_error',
  'medical',
  'unknown',
  'other',
]
export const INCIDENT_TYPE_LABEL: Record<IncidentType, string> = {
  fall: '転倒',
  fall_from: '転落',
  aspiration: '誤嚥・窒息',
  pica: '異食',
  med_error: '誤薬、与薬もれ等',
  medical: '医療処置関連（チューブ抜去等）',
  unknown: '不明',
  other: 'その他',
}

/** 事故状況の程度 */
export type IncidentSeverity = 'treated' | 'hospitalized' | 'death' | 'other'
export const INCIDENT_SEVERITIES: readonly IncidentSeverity[] = ['treated', 'hospitalized', 'death', 'other']
export const INCIDENT_SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  treated: '受診(外来･往診)、自施設で応急処置',
  hospitalized: '入院',
  death: '死亡',
  other: 'その他',
}

/** 状態。open=対応中 / closed=完了 */
export type IncidentStatus = 'open' | 'closed'
export const INCIDENT_STATUSES: readonly IncidentStatus[] = ['open', 'closed']
export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = { open: '対応中', closed: '完了' }

/** 報告区分。first=第1報 / nth=第＿報（report_no に数） / final=最終報告 */
export type IncidentReportStage = 'first' | 'nth' | 'final'
export const INCIDENT_REPORT_STAGES: readonly IncidentReportStage[] = ['first', 'nth', 'final']
export const INCIDENT_REPORT_STAGE_LABEL: Record<IncidentReportStage, string> = {
  first: '第1報',
  nth: '第＿報',
  final: '最終報告',
}

/** 受診方法（複数選択可） */
export type IncidentVisitMethod = 'in_house' | 'outpatient' | 'ambulance' | 'other'
export const INCIDENT_VISIT_METHODS: readonly IncidentVisitMethod[] = ['in_house', 'outpatient', 'ambulance', 'other']
export const INCIDENT_VISIT_METHOD_LABEL: Record<IncidentVisitMethod, string> = {
  in_house: '施設内の医師(配置医含む)が対応',
  outpatient: '受診(外来･往診)',
  ambulance: '救急搬送',
  other: 'その他',
}

/** 診断内容（複数選択可。骨折は部位を添える） */
export type IncidentDiagnosisKind = 'cut' | 'bruise' | 'fracture' | 'other'
export const INCIDENT_DIAGNOSIS_KINDS: readonly IncidentDiagnosisKind[] = ['cut', 'bruise', 'fracture', 'other']
export const INCIDENT_DIAGNOSIS_KIND_LABEL: Record<IncidentDiagnosisKind, string> = {
  cut: '切傷・擦過傷',
  bruise: '打撲・捻挫・脱臼',
  fracture: '骨折',
  other: 'その他',
}

/** 報告した家族等の続柄（複数選択可） */
export type IncidentFamilyRelation = 'spouse' | 'child' | 'other'
export const INCIDENT_FAMILY_RELATIONS: readonly IncidentFamilyRelation[] = ['spouse', 'child', 'other']
export const INCIDENT_FAMILY_RELATION_LABEL: Record<IncidentFamilyRelation, string> = {
  spouse: '配偶者',
  child: '子、子の配偶者',
  other: 'その他',
}

/** 対象者の性別 */
export type IncidentGender = 'male' | 'female'
export const INCIDENT_GENDERS: readonly IncidentGender[] = ['male', 'female']
export const INCIDENT_GENDER_LABEL: Record<IncidentGender, string> = { male: '男性', female: '女性' }

/** 対象者の住所 */
export type IncidentAddressKind = 'office' | 'other'
export const INCIDENT_ADDRESS_KINDS: readonly IncidentAddressKind[] = ['office', 'other']
export const INCIDENT_ADDRESS_KIND_LABEL: Record<IncidentAddressKind, string> = { office: '事業所所在地', other: 'その他' }

/** 要介護度（様式の並び） */
export type IncidentCareLevel =
  | 'support1'
  | 'support2'
  | 'care1'
  | 'care2'
  | 'care3'
  | 'care4'
  | 'care5'
  | 'independent'
export const INCIDENT_CARE_LEVELS: readonly IncidentCareLevel[] = [
  'support1',
  'support2',
  'care1',
  'care2',
  'care3',
  'care4',
  'care5',
  'independent',
]
export const INCIDENT_CARE_LEVEL_LABEL: Record<IncidentCareLevel, string> = {
  support1: '要支援1',
  support2: '要支援2',
  care1: '要介護1',
  care2: '要介護2',
  care3: '要介護3',
  care4: '要介護4',
  care5: '要介護5',
  independent: '自立',
}

/** 認知症高齢者の日常生活自立度（様式の並び） */
export type IncidentDementiaLevel = 'I' | 'IIa' | 'IIb' | 'IIIa' | 'IIIb' | 'IV' | 'M'
export const INCIDENT_DEMENTIA_LEVELS: readonly IncidentDementiaLevel[] = ['I', 'IIa', 'IIb', 'IIIa', 'IIIb', 'IV', 'M']
export const INCIDENT_DEMENTIA_LEVEL_LABEL: Record<IncidentDementiaLevel, string> = {
  I: 'Ⅰ',
  IIa: 'Ⅱa',
  IIb: 'Ⅱb',
  IIIa: 'Ⅲa',
  IIIb: 'Ⅲb',
  IV: 'Ⅳ',
  M: 'M',
}

/**
 * 様式の残りの欄（incidents.detail・jsonb）。キーは平らに持つ（入れ子にしない＝欄ごとに差分を取れる）。
 * 文字の欄は空＝null。選択肢の欄は上の定数のキーだけ（受信値は incident.ts の normalizeIncidentDetail で照合する）。
 * subject_name（氏名）は記録時点の写し。アプリは送らず（画面でも直せない・2026-09-26 チーフ裁定）、サーバーのトリガが
 * 名簿の氏名を入れる／前の写しを残す（氏名を送信待ち＝端末の保存領域に置かないため・0014）
 */
export interface IncidentDetail {
  // 1 事故状況
  severity_other: string | null
  death_on: string | null
  // 3 対象者
  subject_name: string | null
  subject_age: number | null
  subject_gender: IncidentGender | null
  service_start_on: string | null
  insurer: string | null
  address_kind: IncidentAddressKind | null
  address_other: string | null
  care_level: IncidentCareLevel | null
  dementia_level: IncidentDementiaLevel | null
  // 4 事故の概要
  type_other: string | null
  situation: string | null
  special_notes: string | null
  // 5 事故発生時の対応
  response: string | null
  visit_methods: IncidentVisitMethod[]
  visit_method_other: string | null
  hospital_name: string | null
  hospital_phone: string | null
  diagnosis_name: string | null
  diagnosis_kinds: IncidentDiagnosisKind[]
  fracture_site: string | null
  diagnosis_other: string | null
  treatment: string | null
  // 6 事故発生後の状況
  after_status: string | null
  family_relations: IncidentFamilyRelation[]
  family_relation_other: string | null
  family_reported_on: string | null
  agency_municipality: boolean
  agency_municipality_name: string | null
  agency_police: boolean
  agency_police_name: string | null
  agency_other: boolean
  agency_other_name: string | null
  followup: string | null
  // 7〜9
  cause: string | null
  prevention: string | null
  other_notes: string | null
}

/** 事故・ヒヤリハットの記録（1行＝1件。occurred_on は JST の発生日） */
export interface Incident {
  id: number
  kind: IncidentKind
  /** 対象者（ヒヤリハットでは null＝対象者なしも可） */
  resident_id: number | null
  occurred_on: string
  /** 発生日時（ISO 8601） */
  occurred_at: string
  office: IncidentOffice | null
  place: IncidentPlace | null
  place_other: string | null
  types: IncidentType[]
  severity: IncidentSeverity | null
  status: IncidentStatus
  /** 完了にした日時（ISO 8601）。完了の時だけ値を持ち、対応中に戻したら null（委員会集計の「月末時点で未完了」の判定に使う） */
  closed_at: string | null
  report_stage: IncidentReportStage | null
  report_no: number | null
  submitted_on: string | null
  /** 市への報告が必要（人が判断して付ける） */
  city_report_needed: boolean
  city_reported_on: string | null
  reporter_id: number | null
  confirmer_id: number | null
  confirmed_at: string | null
  /** 一覧の取得（detail を持ち出さない列）では空の既定値 */
  detail: IncidentDetail
  rev: number
}

export interface ImportDay {
  source: string
  day: string
  imported_at: string
  src_rows: number
  inserted: number
  updated: number
  skipped: number
  native_skip: number
  unmatched: number
}

export interface TimelineChunk {
  from: string
  to: string
  notes: Note[]
  vitals: Vital[]
  meals: Meal[]
  fluids: FluidIntake[]
  outings: Outing[]
  importDays: ImportDay[]
  pinned: Note[]
}

export interface DayData {
  day: string
  notes: Note[]
  vitals: Vital[]
  meals: Meal[]
  fluids: FluidIntake[]
  outings: Outing[]
  importDay: ImportDay | null
  pinned: Note[]
}

// ── しきい値（現行スプシの条件付き書式の凡例を定数化。値の変更は本人承認が必要） ──
export type Level = 'danger-high' | 'warn-high' | 'warn-low' | 'danger-low' | null

export function tempLevel(v: number | null): Level {
  if (v == null) return null
  if (v >= 38.1) return 'danger-high'
  if (v >= 37.5) return 'warn-high'
  if (v <= 35.5) return 'danger-low'
  return null
}
export function sysBpLevel(v: number | null): Level {
  if (v == null) return null
  if (v >= 151) return 'danger-high'
  if (v < 90) return 'warn-low'
  return null
}
export function diaBpLevel(v: number | null): Level {
  if (v == null) return null
  if (v >= 91) return 'danger-high'
  if (v < 50) return 'warn-low'
  return null
}
export function pulseLevel(v: number | null): Level {
  if (v == null) return null
  if (v >= 101) return 'danger-high'
  if (v < 40) return 'warn-low'
  return null
}
export function spo2Level(v: number | null): Level {
  if (v == null) return null
  if (v < 90) return 'danger-low'
  if (v < 93) return 'warn-low'
  return null
}

// 色だけに頼らない記号（↑↑=危険高値 ↑=注意高値 ↓=注意低値 ↓↓=危険低値）
export const LEVEL_MARK: Record<Exclude<Level, null>, string> = {
  'danger-high': '↑↑',
  'warn-high': '↑',
  'warn-low': '↓',
  'danger-low': '↓↓',
}

export function vitalHasAlert(v: Vital): boolean {
  return !!(
    tempLevel(v.temp) ||
    sysBpLevel(v.sys_bp) ||
    diaBpLevel(v.dia_bp) ||
    pulseLevel(v.pulse) ||
    spo2Level(v.spo2)
  )
}

// 食事の低摂取判定（仮置き: 主+副の合計が6以下。★本人確認事項）
export function isLowIntake(m: Meal): boolean {
  if (m.status && m.status !== 'eaten') return false
  if (m.main_amount == null && m.side_amount == null) return false
  return (m.main_amount ?? 0) + (m.side_amount ?? 0) <= 6
}

// バイタル入力の許容範囲（DB の check 制約と一致させる）
export const VITAL_RANGE: Record<'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2', [number, number]> = {
  temp: [30, 45],
  sys_bp: [40, 300],
  dia_bp: [20, 200],
  pulse: [20, 250],
  spo2: [50, 100],
}

// ── localStorage キー（dev-principles 原則11: UI状態のみ。氏名・記録本文を保存しない。
//    例外は sendQueue / sendQueue2 / draftNote（データ保護レイヤー・保持規則は docs/design/ui-design.md §6.5）と
//    staffId（数値のみ・staff スナップショットと照合して復元） ──
export const LS = {
  view: 'cl_view',
  recordTab: 'cl_recordTab',
  vitalsFloor: 'cl_vitalsFloor',
  karteRange: 'cl_karteRange',
  mode: 'cl_mode',
  staffId: 'cl_staffId',
  sendQueue: 'cl_sendQueue',
  /**
   * バイタル・食事の送信待ち（2026-09-23 フェーズ2' 第3段 #1）。cl_sendQueue は HEAD の形（{ ops }）のまま退避 op だけを持ち、
   * バイタル・食事はこちらへ分ける（旧ビルドへ戻しても、旧ビルドはこのキーに触れないので消えない）
   */
  sendQueue2: 'cl_sendQueue2',
  draftNote: 'cl_draftNote',
  gasUrl: 'cl_gasUrl',
  gasToken: 'cl_gasToken',
  /**
   * 職員名簿の接続先（2026-08-29 追加）。
   * 利用者名簿は入居者マスタGAS、職員名簿はシフト連携GASと**別のGAS**が持っているため、
   * 1つのURLに両方を問い合わせても職員名簿は永久に取得できなかった。
   * 未設定なら利用者名簿と同じ接続先へ問い合わせる（従来の挙動のまま＝既存端末を壊さない）。
   */
  staffGasUrl: 'cl_staffGasUrl',
  staffGasToken: 'cl_staffGasToken',
  /** 表示倍率（100/125/150）。スプシと同じ文字サイズを既定にしつつ、端末ごとに拡大できる */
  zoom: 'cl_zoom',
  /** 一覧に横並びする日数（1/4/7/11） */
  sheetDays: 'cl_sheetDays',
  /** 一覧で表示中のフロア（1/2/all） */
  sheetFloor: 'cl_sheetFloor',
  /**
   * 日報のインライン下書き（2026-09-02 追加。データ保護レイヤー＝draftNote と同じ例外扱い）。
   * 実際のキーは `${dailyDraft}:${YYYY-MM-DD}`（日ごと）。
   * 保持するのは 利用者ID（数値）・記入者ID・色・未送信の文字だけで、**氏名は持たない**。
   * 24時間で失効し、保存済み・送信待ちに退避した行は持たない（二重登録を作らない）。
   * 以前は React state だけだったため、対象・記入者・色を選んで本文を打つ前に
   * リロードすると跡形もなく消えていた（保存経路の監査で判明）。
   */
  dailyDraft: 'cl_dailyDraft',
  /**
   * 与薬チェックで表示中の階（2026-09-26 追加・UI状態のみ）。値は階の数字（'1' '2' …）・'other'（居室未設定）・'all'（全）。
   * 他の一覧の階（cl_vitalsFloor・cl_sheetFloor）とは既定と選べる値が違うため、別のキーにする（既存の画面の値を書き換えない）
   */
  medFloor: 'cl_medFloor',
} as const

/**
 * 表示倍率の選択肢（%）。スプシ実測が 10〜11pt ≒ 13px なので 100% = 13px 基準。
 *
 * 200% を置いてあるのは文字を大きくするためだけではない。行高が 22px×2 = 44px になり、
 * 連続した行でもタップ領域が 44px 以上になる（介護現場要件）。
 * 22px ピッチのまま全行に 44px を配ることは幾何学的に不可能（隣の行から奪うことになる）なので、
 * 「スプシと同じ密度（100%）」と「手袋でも押せる密度（200%）」を職員が選べる形にした。
 */
export const ZOOM_STEPS = [100, 125, 150, 200] as const
export type Zoom = (typeof ZOOM_STEPS)[number]

/** 一覧の横並び日数（スプシ実測: バイタル4日・食事11日） */
export const SHEET_DAYS = [1, 4, 7, 11] as const
export type SheetDays = (typeof SHEET_DAYS)[number]

// ── 表示ラベル ──
export const SHIFT_LABEL: Record<Shift, string> = { day: '日勤', daycare: 'デイ', night: '夜勤' }
export const IMPORTANCE_LABEL: Record<Importance, string> = {
  normal: '通常',
  important: '▲ 重要',
  critical: '‼ 最重要',
}
export const MEAL_SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: '朝',
  lunch: '昼',
  dinner: '夕',
  snack: '間食',
}
export const MEAL_STATUS_LABEL: Record<MealStatus, string> = {
  eaten: '喫食',
  out: '外出',
  hospital: '入院',
  refused: '拒食',
}
export const OUTING_KIND_LABEL: Record<OutingKind, string> = { outing: '外出', overnight: '外泊' }

// 職種タグの語彙（初期値。★運用開始時に本人確認）
export const ROLE_TAGS = ['介護', '看護', 'デイ', '厨房', 'ケアマネ', '事務'] as const
