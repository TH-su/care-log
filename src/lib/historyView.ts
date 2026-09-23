// 変更の記録（record_history）の表示用の文字（純関数・副作用なし）。
// 列名は日本語に、値は既存の画面と同じ書き方（割・状態ラベル・単位・日付）にする。
// 拡張子付きで import する（actor.ts と同じ。tests/logic.test.mjs から直接読めるようにするため）

import {
  IMPORTANCE_LABEL,
  MEAL_SLOT_LABEL,
  MEAL_STATUS_LABEL,
  NOTE_COLOR_LABEL,
  OUTING_KIND_LABEL,
  SHIFT_LABEL,
} from './types.ts'
import type { Importance, MealSlot, MealStatus, NoteColor, OutingKind, Shift } from './types.ts'
import { fmtDayLabel, fmtTimeHM } from './format.ts'
import { fmtMealValue, fmtVitalValue } from './conflict.ts'

/** 記録の種類（表 → 画面の呼び名） */
export const HISTORY_TABLE_LABEL: Record<string, string> = {
  vitals: 'バイタル',
  meals: '食事',
  fluid_intake: '水分',
  notes: '申し送り',
  outings: '外出',
}

const VITAL_KIND_NAME: Record<string, string> = {
  routine: '定時',
  recheck: '再検',
  observation: '発熱者',
  symptom: '他症状者',
}

/** 5表に共通の列 */
const COMMON_LABEL: Record<string, string> = {
  resident_id: '利用者',
  recorded_by: '記入者',
  deleted_at: '取り消し',
  deleted_by: '取り消した職員',
  import_tombstoned_at: '取込による取り消し',
  raw_flags: '取込時の原文',
}

const TABLE_LABEL: Record<string, Record<string, string>> = {
  vitals: {
    measured_on: '測定日',
    kind: '種別',
    measured_at: '測定時刻',
    temp: '体温',
    sys_bp: '血圧（上）',
    dia_bp: '血圧（下）',
    pulse: '脈拍',
    spo2: 'SpO2',
    note: 'メモ',
    symptom: '症状',
  },
  meals: {
    meal_on: '日付',
    meal_slot: '食事の枠',
    main_amount: '主食',
    side_amount: '副食',
    status: '食事の状態',
    note: 'メモ',
  },
  fluid_intake: {
    taken_on: '日付',
    taken_at: '時刻',
    amount_ml: '水分量',
    kind: '種類',
  },
  notes: {
    note_on: '日付',
    shift: '勤務帯',
    facility: '施設',
    category: '分類',
    role_tags: '職種',
    importance: '重要度',
    body: '本文',
    occurred_at: '時刻',
    ongoing: '継続',
    ended_at: '継続の終了',
    ended_by: '継続を終えた職員',
    reporter_id: '記入者',
    color: '行の色',
    after16: '16時以降',
  },
  outings: {
    kind: '種別',
    start_on: '出発日',
    start_at: '出発時刻',
    end_on: '帰着日',
    end_at: '帰着時刻',
    companion: '付添',
    note: '行き先',
  },
}

/** 画面に出さない列（内部の鍵・作成時刻。変わっても職員が読む意味が無い） */
const HIDDEN_COLS = new Set(['id', 'created_at', 'client_key', 'import_key'])

/** 列の日本語名。出さない列は null */
export function historyColumnLabel(table: string, column: string): string | null {
  if (HIDDEN_COLS.has(column)) return null
  return TABLE_LABEL[table]?.[column] ?? COMMON_LABEL[column] ?? column
}

/** 職員の列（値は staff の id） */
const STAFF_COLS = new Set(['recorded_by', 'deleted_by', 'ended_by', 'reporter_id'])

function stampText(v: string): string {
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${fmtDayLabel(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 値の表示。空は「（空）」。職員の列は名簿の名前（引けなければ「職員番号 N」）。
 * バイタル・食事は既存の画面と同じ書き方（単位・割・状態ラベル）にそろえる。
 */
export function fmtHistoryValue(
  table: string,
  column: string,
  v: unknown,
  staffName: (id: number) => string | null,
): string {
  if (v === null || v === undefined || v === '') return '（空）'
  if (STAFF_COLS.has(column) && typeof v === 'number') return staffName(v) ?? `職員番号 ${v}`
  if (table === 'vitals' && ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2'].includes(column)) {
    return fmtVitalValue(column as 'temp', v)
  }
  if (table === 'vitals' && column === 'kind') return VITAL_KIND_NAME[String(v)] ?? String(v)
  if (table === 'meals' && (column === 'main_amount' || column === 'side_amount' || column === 'status')) {
    return fmtMealValue(column, v)
  }
  if (table === 'meals' && column === 'meal_slot') return MEAL_SLOT_LABEL[v as MealSlot] ?? String(v)
  if (table === 'fluid_intake' && column === 'amount_ml') return `${String(v)}ml`
  if (table === 'outings' && column === 'kind') return OUTING_KIND_LABEL[v as OutingKind] ?? String(v)
  if (table === 'notes' && column === 'shift') return SHIFT_LABEL[v as Shift] ?? String(v)
  if (table === 'notes' && column === 'importance') return IMPORTANCE_LABEL[v as Importance] ?? String(v)
  if (table === 'notes' && column === 'color') return NOTE_COLOR_LABEL[v as NoteColor] ?? String(v)
  if (column === 'status') return MEAL_STATUS_LABEL[v as MealStatus] ?? String(v)
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ'
  if (Array.isArray(v)) return v.length === 0 ? '（空）' : v.map((x) => String(x)).join('・')
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDayLabel(v)
    if (/^\d{2}:\d{2}(:\d{2})?$/.test(v)) return fmtTimeHM(v)
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return stampText(v)
    return v
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** 変更日時 '2026-09-01T01:05:00Z' → '9/1（火） 10:05'（端末の時刻で表示） */
export function fmtChangedAt(iso: string): string {
  return iso === '' ? '' : stampText(iso)
}

/**
 * 長い文を先頭 maxLines 行まで切り出す（申し送りの本文の差分用）。
 * 1行が長すぎる時も切る（画面を本文だけで埋めない）。truncated=true なら〔全文〕で展開する。
 */
export function clampLines(
  text: string,
  maxLines = 3,
  maxChars = 240,
): { head: string; truncated: boolean } {
  const lines = text.split('\n')
  let head = lines.slice(0, maxLines).join('\n')
  let truncated = lines.length > maxLines
  if (head.length > maxChars) {
    head = head.slice(0, maxChars)
    truncated = true
  }
  return { head: truncated ? `${head}…` : head, truncated }
}
