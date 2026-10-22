// デイ（せせらぎ）段階2c: 申し送りの印の純ロジック（副作用なし・DB/DOM に触れない）。tests/daycare-note-mark.test.mjs から node で直接読む。
//
// 決まり（段階2の計画 v1 の 2.2・代表者の承認 2026-10-22）:
// ・〔申し送りにする〕で、記録から文を組み立てた申し送り（区分「デイ」shift='daycare'）を1件作る。notes の表は変えない
// ・分類は記録の種類から: 食事・水分 →「食事」、バイタル・排泄 →「体調」、活動 → 付けない
// ・冪等キー: dcn:<業務日>:<利用者id>:<記録>:<世代>。記録は vital・lunch・snack・ex・fl<水分の id>・ac<活動の id>。
//   世代は「その記録の印をこれまで何回付けたか」（取り消した申し送りも数える）。notes の client_key は取り消した行も
//   押さえたまま全体で一意なので、世代を進めることで外した後に付け直せる。同じ記録に2台で同時に印を付けると同じ鍵になり、
//   申し送りは1件にまとまる（重複させない）
// ・元の記録を後から直した・取り消した時: 申し送りはその時点の文のまま残し、印の横に知らせる（isStale）
// 個人情報は扱わない（氏名は文に入れない。申し送りは利用者の欄 resident_id で結ぶ）。

import type { NoteCategory } from './types.ts'

/** 印を付けられる記録の種類 */
export type MarkKind = 'vital' | 'lunch' | 'snack' | 'ex' | 'fluid' | 'activity'

/** 印を付ける記録（kind と、水分・活動はその行の id） */
export type MarkRecord =
  | { kind: 'vital' | 'lunch' | 'snack' | 'ex' }
  | { kind: 'fluid'; id: number }
  | { kind: 'activity'; id: number }

/** 鍵の中の記録の部分（vital・lunch・snack・ex・fl<id>・ac<id>） */
export function markWhat(r: MarkRecord): string {
  if (r.kind === 'fluid') return `fl${r.id}`
  if (r.kind === 'activity') return `ac${r.id}`
  return r.kind
}

/** その記録の印の鍵の頭（世代の前まで）。dcn:<日>:<利用者id>:<記録>: */
export function markPrefix(day: string, residentId: number, r: MarkRecord): string {
  return `dcn:${day}:${residentId}:${markWhat(r)}:`
}

/** その日・その方の印の鍵の頭（読み込みの絞り込みに使う） */
export function markDayPrefix(day: string, residentId: number): string {
  return `dcn:${day}:${residentId}:`
}

/** 印の鍵（世代つき） */
export function markKey(day: string, residentId: number, r: MarkRecord, gen: number): string {
  return `${markPrefix(day, residentId, r)}${gen}`
}

/** 鍵を読む（形が違えば null）。what は vital・lunch・snack・ex・fl<id>・ac<id> */
export function parseMarkKey(key: string | null | undefined): { day: string; residentId: number; what: string; gen: number } | null {
  if (typeof key !== 'string') return null
  const m = /^dcn:(\d{4}-\d{2}-\d{2}):(\d+):(vital|lunch|snack|ex|fl\d+|ac\d+):(\d+)$/.exec(key)
  if (m === null) return null
  const residentId = Number(m[2])
  const gen = Number(m[4])
  if (!Number.isSafeInteger(residentId) || residentId <= 0 || !Number.isSafeInteger(gen) || gen <= 0) return null
  return { day: m[1], residentId, what: m[3], gen }
}

/**
 * 次の世代: その記録の鍵のうち、サーバーの行（取り消した行も含む）と送信待ちの登録の世代の最大＋1。
 * keys には、その日・その方の全部の鍵を渡してよい（頭の合わないものは数えない）
 */
export function nextGen(prefix: string, keys: readonly string[]): number {
  let max = 0
  for (const k of keys) {
    if (!k.startsWith(prefix)) continue
    const p = parseMarkKey(k)
    if (p !== null && p.gen > max) max = p.gen
  }
  return max + 1
}

/** 記録の種類から付ける分類（食事・水分→食事／バイタル・排泄→体調／活動→付けない） */
export function markCategories(kind: MarkKind): NoteCategory[] {
  if (kind === 'lunch' || kind === 'snack' || kind === 'fluid') return ['食事']
  if (kind === 'vital' || kind === 'ex') return ['体調']
  return []
}

/** ひと言の上限（申し送りの本文として長すぎないように） */
export const MARK_COMMENT_MAX = 100

/** 申し送りの本文: 記録の文 ＋（ひと言があれば）「。」でつなぐ。ひと言の前後の空白は落とす */
export function markBody(text: string, comment: string): string {
  const c = comment.normalize('NFKC').replace(/\s+/g, ' ').trim()
  return c === '' ? text : `${text}。${c}`
}

/**
 * 申し送りの文が、いまの記録の文と違うか（元の記録を後から直した・取り消した）。
 * 本文が「いまの文」そのもの、または「いまの文。ひと言」なら同じ。current が null（記録が無くなった）なら違う
 */
export function isStale(body: string, current: string | null): boolean {
  if (current === null) return true
  return !(body === current || body.startsWith(`${current}。`))
}

/** ひと言の検査（長すぎは理由の文） */
export function markCommentError(comment: string): string | null {
  return [...comment.trim()].length > MARK_COMMENT_MAX ? `ひと言は ${MARK_COMMENT_MAX} 字までで入れてください。` : null
}

// ── 記録の文（画面に出している要約と同じ言葉。氏名は入れない） ──

/** バイタルの文（その日のいちばん新しい値。無い項目は書かない）。どれも無ければ null */
export function vitalMarkText(v: { temp: number | null; sys_bp: number | null; dia_bp: number | null; pulse: number | null; spo2: number | null }): string | null {
  const parts: string[] = []
  if (v.temp !== null) parts.push(`体温 ${v.temp.toFixed(1)}℃`)
  if (v.sys_bp !== null || v.dia_bp !== null) parts.push(`血圧 ${v.sys_bp ?? '—'}/${v.dia_bp ?? '—'}`)
  if (v.pulse !== null) parts.push(`脈 ${v.pulse}`)
  if (v.spo2 !== null) parts.push(`SpO2 ${v.spo2}%`)
  return parts.length === 0 ? null : `バイタル ${parts.join('・')}`
}

/** 昼食・おやつの文（表示の言葉＝lunchLabel・snackLabel をそのまま渡す）。記録なしは null */
export function mealMarkText(slot: 'lunch' | 'snack', label: string): string | null {
  if (label === '記録なし') return null
  return `${slot === 'lunch' ? '昼食' : 'おやつ'} ${label}`
}

/** 水分の1回の文 */
export function fluidMarkText(f: { taken_at: string | null; amount_ml: number }): string {
  return `水分 ${f.taken_at === null ? '' : `${f.taken_at.slice(0, 5)} `}${f.amount_ml} ml`
}

/** 活動の文（activityText の言葉をそのまま渡す） */
export function activityMarkText(text: string): string {
  return `活動 ${text}`
}

/** 排泄の文（その日の回数）。排泄ケアアプリの記録を読めていない時は null */
export function excretionMarkText(d: { urine: number; stools: readonly unknown[]; laxatives: readonly unknown[] } | null): string | null {
  if (d === null) return null
  return `排泄 排尿 ${d.urine}回・排便 ${d.stools.length}回${d.laxatives.length > 0 ? `・下剤 ${d.laxatives.length}回` : ''}`
}
