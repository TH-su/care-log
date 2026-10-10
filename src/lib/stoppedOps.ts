// 止まっている送信待ち（競合・拒否で自動では送らない退避 op）を、設定画面の「送れていない記録」に出すための言葉
// （F02・F37・2026-10-10）。db.ts の listStoppedOps が返す中身（表・種類・中身の写し）を、何の記録の・誰の・
// どの日の・どんな値かの文へ直す。いまの行（fetchQueuedOpTarget）と並べて見せる時も同じ言葉で出す。
//
// 規律: 読むだけ（保存先・サーバーへ書かない）。氏名は送信待ちに持たない契約なので、呼び出し側が名簿から引いて渡す。
// 内部の列名・コードは画面に出さない（知らない列は「ほか n 項目」とだけ出す）。console に出さない

import {
  BATH_CANCEL_REASON_LABEL,
  BATH_RESULT_LABEL,
  INCIDENT_KIND_LABEL,
  INCIDENT_PLACE_LABEL,
  INCIDENT_SEVERITY_LABEL,
  INCIDENT_STATUS_LABEL,
  INCIDENT_TYPE_LABEL,
  MED_SLOT_LABEL,
  MED_STATUS_LABEL,
  OUTING_KIND_LABEL,
} from './types'

/** listStoppedOps の1件のうち、言葉にするのに使う分（db.ts の StoppedOp と同じ形） */
export interface StoppedOpLike {
  table: string
  kind: string
  state: 'conflict' | 'rejected'
  payload: Record<string, unknown>
  errCode: string | null
}

/** 表の呼び名 */
export const STOPPED_TABLE_LABEL: Record<string, string> = {
  fluid_intake: '水分',
  outings: '外出・外泊',
  bath_records: '入浴（デイ）',
  med_slots: '服薬の時間帯',
  med_admin: '与薬',
  incidents: '事故・ヒヤリハット',
  notes: '申し送り',
  note_reads: '申し送りの既読',
  attendance: '日報の出勤者',
  residents: '申し送りでの表示名',
}

/** 取り消し（deleted_at を付ける修正）か */
export function isStoppedDelete(op: Pick<StoppedOpLike, 'kind' | 'payload'>): boolean {
  return op.kind === 'update' && Object.prototype.hasOwnProperty.call(op.payload, 'deleted_at') && op.payload.deleted_at !== null
}

/** 「与薬の追加」「入浴（デイ）の取り消し」などの見出し */
export function stoppedOpTitle(op: Pick<StoppedOpLike, 'table' | 'kind' | 'payload'>): string {
  const t = STOPPED_TABLE_LABEL[op.table] ?? 'その他の記録'
  switch (op.kind) {
    case 'insert':
      return `${t}の追加`
    case 'update':
      return isStoppedDelete(op) ? `${t}の取り消し` : `${t}の修正`
    case 'read':
      return '申し送りの既読'
    case 'attendance':
      return '日報の出勤者'
    case 'alias':
      return '申し送りでの表示名の変更'
  }
  return t
}

/** 止まった理由（記号と文字。色だけに頼らない） */
export function stoppedOpReason(op: Pick<StoppedOpLike, 'state' | 'errCode'>): string {
  if (op.state === 'conflict') return '▲ 他の端末で先に記録・変更されたため止まっています'
  return `▲ サーバーに受け付けられずに止まっています${op.errCode ? `（${op.errCode}）` : ''}`
}

/** 記録の日付になる列（表ごとに1つ） */
const DAY_FIELDS: readonly string[] = ['bath_on', 'admin_on', 'taken_on', 'start_on', 'occurred_on', 'note_on', 'day']

/** 値の言葉（ラベル付きの欄） */
type FieldFmt = { label: string; fmt: (v: unknown) => string | null }

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const labelOf =
  (map: Record<string, string>) =>
  (v: unknown): string | null =>
    typeof v === 'string' ? (map[v] ?? null) : null
const hm = (v: unknown): string | null => {
  if (typeof v !== 'string' || v === '') return null
  const m = /^(\d{1,2}):(\d{2})/.exec(v)
  if (m) return `${Number(m[1])}:${m[2]}`
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 表ごとに見せる欄（ここに無い列は「ほか n 項目」とだけ数える） */
const FIELDS: Record<string, Record<string, FieldFmt>> = {
  fluid_intake: {
    amount_ml: { label: '量', fmt: (v) => (typeof v === 'number' ? `${v}ml` : null) },
    taken_at: { label: '時刻', fmt: hm },
    kind: { label: '種類', fmt: text },
  },
  outings: {
    kind: { label: '区分', fmt: labelOf(OUTING_KIND_LABEL) },
    start_at: { label: '出発', fmt: hm },
    end_on: { label: '帰着日', fmt: text },
    end_at: { label: '帰着時刻', fmt: hm },
    companion: { label: '同行', fmt: text },
    note: { label: '備考', fmt: text },
  },
  bath_records: {
    result: { label: '入浴', fmt: labelOf(BATH_RESULT_LABEL) },
    cancel_reason: { label: '中止の理由', fmt: labelOf(BATH_CANCEL_REASON_LABEL) },
    note: { label: '備考', fmt: text },
  },
  med_admin: {
    slot: { label: '時間帯', fmt: labelOf(MED_SLOT_LABEL) },
    status: { label: '状態', fmt: labelOf(MED_STATUS_LABEL) },
    prn_drug: { label: '頓服の薬', fmt: text },
    prn_reason: { label: '頓服の理由', fmt: text },
    prn_effect: { label: '頓服の効果', fmt: text },
    note: { label: '備考', fmt: text },
  },
  med_slots: {
    slots: {
      label: '時間帯',
      fmt: (v) =>
        Array.isArray(v) ? (v.length === 0 ? '服薬なし' : v.map((s) => MED_SLOT_LABEL[s as keyof typeof MED_SLOT_LABEL] ?? '?').join('・')) : null,
    },
    note: { label: '備考', fmt: text },
  },
  incidents: {
    kind: { label: '区分', fmt: labelOf(INCIDENT_KIND_LABEL) },
    occurred_at: { label: '発生', fmt: hm },
    place: { label: '場所', fmt: labelOf(INCIDENT_PLACE_LABEL) },
    types: {
      label: '種別',
      fmt: (v) =>
        Array.isArray(v) ? (v.length === 0 ? 'なし' : v.map((t) => INCIDENT_TYPE_LABEL[t as keyof typeof INCIDENT_TYPE_LABEL] ?? '?').join('・')) : null,
    },
    severity: { label: '程度', fmt: labelOf(INCIDENT_SEVERITY_LABEL) },
    status: { label: '対応', fmt: labelOf(INCIDENT_STATUS_LABEL) },
  },
  residents: {
    note_alias: { label: '表示名', fmt: (v) => text(v) ?? '（外す）' },
  },
}

/**
 * 事故の詳細（detail）のうち、取り下げる前に中身を見せる文の欄（F37: 事故の追記＝原因・再発防止策などが見えないまま
 * 取り下げさせない）。対象者の氏名の写し（subject_name）は出さない（送信待ちに氏名を持たない契約の側の値）
 */
const INCIDENT_DETAIL_TEXT: ReadonlyArray<[string, string]> = [
  ['situation', '発生時の状況'],
  ['response', '発生時の対応'],
  ['treatment', '処置'],
  ['after_status', '発生後の状況'],
  ['followup', 'その後の対応'],
  ['cause', '原因'],
  ['prevention', '再発防止策'],
  ['special_notes', '特記事項'],
  ['other_notes', 'その他'],
]

/** 言葉にしない列（行の印・記入者・版など） */
const HIDDEN = new Set([
  'id',
  'rev',
  'client_key',
  'resident_id',
  'recorded_by',
  'edited_by',
  'reporter_id',
  'confirmer_id',
  'auto',
  'deleted_at',
  'base',
  'created_at',
  'updated_at',
  ...DAY_FIELDS,
])

export interface StoppedOpLine {
  label: string
  value: string
}

/**
 * 中身の要約（対象・日付・値）。residentName は利用者の表示名（分からなければ「利用者ID n」などを返す関数）。
 * row を渡すと、その行（いまの記録）の同じ欄を同じ言葉で出す（くらべて見せる時）
 */
export function stoppedOpLines(
  op: Pick<StoppedOpLike, 'table' | 'kind' | 'payload'>,
  residentName: (id: number) => string,
  row?: Record<string, unknown> | null,
): StoppedOpLine[] {
  const src = row ?? op.payload
  const out: StoppedOpLine[] = []
  const rid = typeof op.payload.resident_id === 'number' ? op.payload.resident_id : typeof src.resident_id === 'number' ? src.resident_id : null
  if (rid !== null) out.push({ label: '対象', value: residentName(rid) })
  else if (op.table === 'residents' && typeof op.payload.id === 'number') out.push({ label: '対象', value: residentName(op.payload.id) })
  for (const f of DAY_FIELDS) {
    const d = op.payload[f] ?? src[f]
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const [, m, dd] = d.split('-')
      out.push({ label: '日付', value: `${Number(m)}/${Number(dd)}` })
      break
    }
  }
  if (row === undefined && isStoppedDelete(op)) out.push({ label: '操作', value: 'この記録を取り消す' })
  if (row !== undefined && row !== null && typeof row.deleted_at === 'string' && row.deleted_at !== '') {
    out.push({ label: '状態', value: '取り消されています' })
  }
  const fields = FIELDS[op.table] ?? {}
  let hidden = 0
  // 並べる欄は「この端末が送ろうとした欄」にそろえる（いまの記録も同じ欄だけ出す＝くらべやすくする）
  for (const k of Object.keys(op.payload)) {
    if (HIDDEN.has(k)) continue
    if (op.table === 'incidents' && k === 'detail') {
      // 事故の詳細: この端末が送ろうとした文の欄を、同じ欄の値で出す（いまの記録も同じ欄）。それ以外の欄は数だけ
      const mineD = op.payload.detail !== null && typeof op.payload.detail === 'object' ? (op.payload.detail as Record<string, unknown>) : {}
      const srcD = src.detail !== null && typeof src.detail === 'object' ? (src.detail as Record<string, unknown>) : {}
      const shown = new Set<string>()
      for (const [dk, label] of INCIDENT_DETAIL_TEXT) {
        if (!Object.prototype.hasOwnProperty.call(mineD, dk)) continue
        shown.add(dk)
        out.push({ label, value: text(srcD[dk]) ?? '未入力' })
      }
      hidden += Object.keys(mineD).filter((dk) => !shown.has(dk) && dk !== 'subject_name').length
      continue
    }
    const ff = fields[k]
    if (ff === undefined) {
      hidden += 1
      continue
    }
    const v = ff.fmt(src[k] ?? null)
    out.push({ label: ff.label, value: v ?? '未入力' })
  }
  if (op.table === 'residents' && row === undefined && Object.prototype.hasOwnProperty.call(op.payload, 'base')) {
    out.push({ label: '変更前（この端末が見ていた値）', value: text(op.payload.base) ?? '（なし）' })
  }
  if (hidden > 0) out.push({ label: 'ほか', value: `${hidden}項目` })
  return out
}

/**
 * いまの行と並べてから送り直す（くらべて選ぶ）種類か。update（取り消しを含む）・表示名・自然キーで止まった追加
 * （入浴・与薬・服薬の時間帯）の conflict は、見せた版を resendQueuedOp に渡さないと送られない
 */
export function stoppedOpNeedsCompare(op: Pick<StoppedOpLike, 'table' | 'kind' | 'state'>): boolean {
  if (op.state !== 'conflict') return false
  if (op.kind === 'update' || op.kind === 'alias') return true
  return op.kind === 'insert' && (op.table === 'bath_records' || op.table === 'med_admin' || op.table === 'med_slots')
}
