// デイ（せせらぎ）段階2b: 活動・レクの純ロジック（副作用なし・DB/DOM に触れない）。tests/daycare-activity.test.mjs から node で直接読む。
//
// ・表は daycare_activity_log（移行 0044）。1人1日1項目1行（部分 unique）。項目は定型のチップか自由入力（40字まで）
// ・参加の度合いは 参加（既定）・一部・見学・不参加。変える時だけもう1タップ
// ・2台で同じ方・同じ日・同じ項目を入れた時: 度合いが同じなら1行に合流（後の端末も成功）、違えば「先に記録があります」
// ・前回コピーは活動だけ（測った値＝食事量・水分はコピーしない＝Phase3 の 1章）
// 個人情報は扱わない（項目名・度合い・数値だけ。氏名は画面が持つ）。

import type { DaycareBoardRow } from './daycare.ts'

export type ActivityParticipation = 'full' | 'partial' | 'observed' | 'declined'
export const ACTIVITY_PARTICIPATIONS: readonly ActivityParticipation[] = ['full', 'partial', 'observed', 'declined']
export const ACTIVITY_PARTICIPATION_LABEL: Record<ActivityParticipation, string> = {
  full: '参加',
  partial: '一部',
  observed: '見学',
  declined: '不参加',
}

/** 定型のチップ（代表者の決定 2026-10-22・段階2の計画の質問1）。〔その他〕は自由入力 */
export const DAYCARE_ACTIVITY_CHIPS: readonly string[] = ['体操', '脳トレ', '歌', '創作', '園芸', '散歩', '休息']
/** 項目の長さの上限（DB の check と同じ） */
export const ACTIVITY_LABEL_MAX = 40

/** 活動・レクの1行（daycare_activity_log・削除済みは持たない） */
export interface DaycareActivity {
  id: number
  resident_id: number
  /** 業務日（JST・YYYY-MM-DD） */
  day: string
  label: string
  participation: ActivityParticipation
  note: string | null
  recorded_by: number | null
  rev: number
}

/** 項目を送る形にそろえる: 全角・半角をそろえ（NFKC）、空白の並びを1つにし、前後の空白を落とす（同じ項目が2行にならない） */
export function normalizeActivityLabel(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

/** 項目の検査（そろえた後の形で）。空・長すぎは理由の文 */
export function activityLabelError(text: string): string | null {
  const t = normalizeActivityLabel(text)
  if (t === '') return '項目を入れてください。'
  if ([...t].length > ACTIVITY_LABEL_MAX) return `項目は ${ACTIVITY_LABEL_MAX} 字までで入れてください。`
  return null
}

/** 受信した度合いの検査（4つ以外は null＝受信値を信じない） */
export function participationOf(v: unknown): ActivityParticipation | null {
  return typeof v === 'string' && (ACTIVITY_PARTICIPATIONS as readonly string[]).includes(v) ? (v as ActivityParticipation) : null
}

/** その方・その日の活動（定型のチップの順 → 自由入力は入れた順） */
export function activitiesOf(list: readonly DaycareActivity[], residentId: number, day: string): DaycareActivity[] {
  const rank = (a: DaycareActivity) => {
    const i = DAYCARE_ACTIVITY_CHIPS.indexOf(a.label)
    return i < 0 ? DAYCARE_ACTIVITY_CHIPS.length : i
  }
  return list
    .filter((a) => a.resident_id === residentId && a.day === day)
    .sort((a, b) => rank(a) - rank(b) || a.id - b.id)
}

/** 1つの活動の表示（参加は項目だけ・それ以外は度合いを添える） */
export function activityText(a: Pick<DaycareActivity, 'label' | 'participation'>): string {
  return a.participation === 'full' ? a.label : `${a.label}（${ACTIVITY_PARTICIPATION_LABEL[a.participation]}）`
}

/** デイの一覧の行の小さな印（記録なし／n件） */
export function activityChipText(count: number): string {
  return count <= 0 ? '記録なし' : `${count}件`
}

/**
 * 前回コピーの元: before より前の日のうち、いちばん新しい日の活動（項目・度合い）。無ければ null。
 * rows はその方の前の日の行（日の新しい順でなくてよい）
 */
export function previousActivities(
  rows: readonly Pick<DaycareActivity, 'day' | 'label' | 'participation'>[],
  before: string,
): { day: string; items: { label: string; participation: ActivityParticipation }[] } | null {
  let last: string | null = null
  for (const r of rows) if (r.day < before && (last === null || r.day > last)) last = r.day
  if (last === null) return null
  const seen = new Set<string>()
  const items: { label: string; participation: ActivityParticipation }[] = []
  for (const r of rows) {
    if (r.day !== last || seen.has(r.label)) continue
    seen.add(r.label)
    items.push({ label: r.label, participation: r.participation })
  }
  return { day: last, items }
}

/** 前回コピーで足す分（もう入っている項目は足さない） */
export function copyItems(
  prev: readonly { label: string; participation: ActivityParticipation }[],
  current: readonly Pick<DaycareActivity, 'label'>[],
): { label: string; participation: ActivityParticipation }[] {
  const have = new Set(current.map((c) => c.label))
  return prev.filter((p) => !have.has(p.label))
}

/** まとめて記録の相手: その日に来た方（在席・帰宅）。欠席・未到着は入れない（デイの一覧の並び） */
export function activityTargets(rows: readonly Pick<DaycareBoardRow, 'residentId' | 'state'>[]): number[] {
  return rows.filter((r) => r.state === 'present' || r.state === 'left').map((r) => r.residentId)
}

/** 追加の結果（1人分）。merged＝同じ項目・同じ度合いの行が先にあった（1行に合流）／taken＝違う度合いで先にあった */
export type ActivityAddOutcome = 'saved' | 'merged' | 'taken' | 'queued' | 'error'

/** まとめて記録の結果の文（人数を数えて出す） */
export function bulkResultText(label: string, outcomes: readonly ActivityAddOutcome[]): string {
  const n = (k: ActivityAddOutcome) => outcomes.filter((o) => o === k).length
  const parts: string[] = []
  if (n('saved') > 0) parts.push(`${n('saved')}人に入れました`)
  if (n('merged') > 0) parts.push(`${n('merged')}人は同じ記録が先にありました`)
  if (n('queued') > 0) parts.push(`${n('queued')}人はこの端末に保存しました（電波が戻ると自動で送信します）`)
  if (n('taken') > 0) parts.push(`${n('taken')}人は違う参加の度合いで先に記録がありました（その方の画面で確かめてください）`)
  if (n('error') > 0) parts.push(`${n('error')}人は保存できませんでした（もう一度押してください）`)
  return `「${label}」: ${parts.length === 0 ? '対象の方がいません' : parts.join('。')}。`
}
