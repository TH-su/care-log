// デイ（せせらぎ）段階3b: 個別機能訓練の居宅訪問の純ロジック（副作用なし・DB/DOM に触れない）。
// tests/daycare-home-visit.test.mjs から node で直接読む（拡張子付きで import する）。
//
// ・表は daycare_home_visits（移行 0046・1人・1日・1目的に1件）。2026-10-23 代表者承認・段階3の計画 v1 の 2.2・3.2・質問10
// ・必須は 訪問日・訪問者・目的（初回／定期）・確かめた生活の状況（500字まで）
// ・説明した相手・日・内容は後日に足せる（片方ずつでもよい）。相手と日の両方がそろうまでは「説明の記録なし」と数える
// ・未来の訪問日・説明の日は送らない（DB のトリガも 22023 で止める）。過去の日は現場も書ける（守りの対象にしない＝質問9）
// 個人情報の値は持たない（生活の状況・説明の内容は画面と DB の間を通すだけ。端末に残さない）。

export type HomeVisitPurpose = 'initial' | 'periodic'
export const HOME_VISIT_PURPOSES: readonly HomeVisitPurpose[] = ['initial', 'periodic']
export const HOME_VISIT_PURPOSE_LABEL: Record<HomeVisitPurpose, string> = { initial: '初回（計画を作る前）', periodic: '定期（3か月ごと）' }

export type ExplainedTo = 'user' | 'family' | 'both'
export const EXPLAINED_TOS: readonly ExplainedTo[] = ['user', 'family', 'both']
export const EXPLAINED_TO_LABEL: Record<ExplainedTo, string> = { user: '本人', family: '家族', both: '本人と家族' }

/** 生活の状況・説明の内容の長さの上限（DB の check と同じ） */
export const HOME_VISIT_TEXT_MAX = 500

/** 居宅訪問の1行（daycare_home_visits・削除済みは持たない） */
export interface DaycareHomeVisit {
  id: number
  resident_id: number
  /** 訪問日（JST・YYYY-MM-DD） */
  visited_on: string
  visitor_id: number
  purpose: HomeVisitPurpose
  life_status: string
  explained_to: ExplainedTo | null
  /** 説明した日（訪問と別の日でもよい） */
  explained_on: string | null
  explanation: string | null
  plan_revised: boolean
  recorded_by: number | null
  rev: number
}

/** 小窓の入力（文字のまま持つ） */
export interface HomeVisitInput {
  visited_on: string
  visitor_id: number | null
  purpose: HomeVisitPurpose | null
  life_status: string
  explained_to: ExplainedTo | null
  explained_on: string
  explanation: string
  plan_revised: boolean
}

export type HomeVisitInputErrors = Partial<Record<'visited_on' | 'visitor_id' | 'purpose' | 'life_status' | 'explained_on' | 'explanation', string>>

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
/** 実在する日付か（2月30日などは不可） */
export function validYmd(v: string): boolean {
  if (!YMD_RE.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

/** 文字数（サロゲートペアを1字と数える＝DB の char_length と同じ） */
const len = (s: string) => [...s].length

/** 入力の検査（DB の check・トリガと同じ決まり）。today は日本時間の今日（未来の日を止める） */
export function homeVisitInputErrors(v: HomeVisitInput, today: string): HomeVisitInputErrors {
  const out: HomeVisitInputErrors = {}
  if (!validYmd(v.visited_on)) out.visited_on = '訪問日を入れてください。'
  else if (v.visited_on > today) out.visited_on = '未来の日は入れられません。'
  if (v.visitor_id === null) out.visitor_id = '訪問した職員を選んでください。'
  if (v.purpose === null) out.purpose = '目的（初回・定期）を選んでください。'
  const life = v.life_status.trim()
  if (life === '') out.life_status = '確かめた生活の状況を書いてください。'
  else if (len(life) > HOME_VISIT_TEXT_MAX) out.life_status = `生活の状況は ${HOME_VISIT_TEXT_MAX} 字までで書いてください。`
  if (v.explained_on !== '') {
    if (!validYmd(v.explained_on)) out.explained_on = '説明した日を確かめてください。'
    else if (v.explained_on > today) out.explained_on = '未来の日は入れられません。'
  }
  if (len(v.explanation.trim()) > HOME_VISIT_TEXT_MAX) out.explanation = `説明の内容は ${HOME_VISIT_TEXT_MAX} 字までで書いてください。`
  return out
}

/** 相手と日の片方だけが入っているか（保存はできる。画面で「相手と日をそろえて入れてください」と促す＝計画 3.2） */
export function explanationHalf(v: Pick<HomeVisitInput, 'explained_to' | 'explained_on'>): boolean {
  return (v.explained_to === null) !== (v.explained_on === '')
}

/** 送る形（検査を通った入力だけを渡す）。空の欄は null、文は前後の空白を落とす */
export function homeVisitPayload(v: HomeVisitInput): {
  visited_on: string
  visitor_id: number
  purpose: HomeVisitPurpose
  life_status: string
  explained_to: ExplainedTo | null
  explained_on: string | null
  explanation: string | null
  plan_revised: boolean
} {
  const explanation = v.explanation.trim()
  return {
    visited_on: v.visited_on,
    visitor_id: v.visitor_id ?? 0,
    purpose: v.purpose ?? 'periodic',
    life_status: v.life_status.trim(),
    explained_to: v.explained_to,
    explained_on: v.explained_on === '' ? null : v.explained_on,
    explanation: explanation === '' ? null : explanation,
    plan_revised: v.plan_revised,
  }
}

/** 新しい記録の小窓の初めの値。訪問者＝いまの記録者、目的＝その方に前の訪問があれば定期・無ければ初回、訪問日＝今日 */
export function freshHomeVisitInput(today: string, actorId: number | null, hasPrevious: boolean): HomeVisitInput {
  return {
    visited_on: today,
    visitor_id: actorId,
    purpose: hasPrevious ? 'periodic' : 'initial',
    life_status: '',
    explained_to: null,
    explained_on: '',
    explanation: '',
    plan_revised: false,
  }
}

/** 既存の記録を小窓の入力にする */
export function homeVisitInputOf(row: DaycareHomeVisit): HomeVisitInput {
  return {
    visited_on: row.visited_on,
    visitor_id: row.visitor_id,
    purpose: row.purpose,
    life_status: row.life_status,
    explained_to: row.explained_to,
    explained_on: row.explained_on ?? '',
    explanation: row.explanation ?? '',
    plan_revised: row.plan_revised,
  }
}

/**
 * 既存の記録（editing）の訪問日・目的を変えた時、同じ方の別の記録と同じ鍵（利用者・訪問日・目的）になるか（段階3b の反証 中1）。
 * removedIds＝この端末で取り消しを送信待ちにしている記録（届けば消えるので重なりとみなさない＝確認の反証 軽4）
 */
export function homeVisitKeyTaken(
  visits: readonly Pick<DaycareHomeVisit, 'id' | 'resident_id' | 'visited_on' | 'purpose'>[],
  editing: Pick<DaycareHomeVisit, 'id' | 'resident_id'>,
  visitedOn: string,
  purpose: HomeVisitPurpose | null,
  removedIds: ReadonlySet<number> = new Set(),
): boolean {
  return visits.some(
    (v) => v.id !== editing.id && v.resident_id === editing.resident_id && !removedIds.has(v.id) && v.visited_on === visitedOn && v.purpose === purpose,
  )
}
