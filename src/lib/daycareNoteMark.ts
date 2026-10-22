// デイ（せせらぎ）段階2c: 申し送りの印の純ロジック（副作用なし・DB/DOM に触れない）。tests/daycare-note-mark.test.mjs から node で直接読む。
//
// 決まり（段階2の計画 v1 の 2.2・代表者の承認 2026-10-22）:
// ・〔申し送りにする〕で、記録から文を組み立てた申し送り（区分「デイ」shift='daycare'）を1件作る。notes の表は変えない
// ・分類は記録の種類から: 食事・水分 →「食事」、バイタル・排泄 →「体調」、活動 → 付けない
// ・冪等キー: dcn:<業務日>:<利用者id>:<記録>:<世代>-<送るたびの印>。記録は vital・lunch・snack・ex・fl<水分の id>・ac<活動の id>。
//   世代は「その記録の印をこれまで何回付けたか」（取り消した申し送りも数える・いちばん新しい印を選ぶのに使う）。
//   送るたびの印（短い乱数）で、別の端末・取り消した申し送りの鍵には決して当たらない（当たると insertNote は先の行を
//   「届いた」として返し、ひと言・記入者や印そのものが黙って消える＝2c の反証 重大2・中3・中4）。同じ送信の送り直しは
//   同じ鍵なので二重にならない。2台で同じ記録に同時に付けた時は2件になる（消えるより増える側＝多端末の規約の原則5）
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

/** 送るたびの印の形（英小文字と数字・1〜16字） */
const TOKEN_RE = /^[0-9a-z]{1,16}$/

/** 印の鍵（世代と送るたびの印つき）。token は送る操作ごとに作る（同じ送信の送り直しは同じ token） */
export function markKey(day: string, residentId: number, r: MarkRecord, gen: number, token: string): string {
  if (!TOKEN_RE.test(token)) throw new Error('印の鍵の token の形が違います')
  return `${markPrefix(day, residentId, r)}${gen}-${token}`
}

/** 鍵を読む（形が違えば null）。what は vital・lunch・snack・ex・fl<id>・ac<id>。token の無い鍵（#21 の版）も読む */
export function parseMarkKey(key: string | null | undefined): { day: string; residentId: number; what: string; gen: number } | null {
  if (typeof key !== 'string') return null
  const m = /^dcn:(\d{4}-\d{2}-\d{2}):(\d+):(vital|lunch|snack|ex|fl\d+|ac\d+):(\d+)(?:-[0-9a-z]{1,16})?$/.exec(key)
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

/**
 * 申し送りの本文: 記録の文 ＋（ひと言があれば）「。」でつなぐ。ひと言は入れたまま載せる（前後の空白だけ落とす。
 * 全角・半角や記号を書き換えない＝開発の大前提の原則6・2c の反証 軽10）
 */
export function markBody(text: string, comment: string): string {
  const c = comment.trim()
  return c === '' ? text : `${text}。${c}`
}

/**
 * 申し送りの文が、いまの記録の文と違うか（元の記録を後から直した・取り消した、または申し送りの記録の部分を直した）。
 * 本文がいまの文で始まり、その後ろが「。」・空白・終わりなら同じ（日報でひと言を足しただけの申し送りを「違う」にしない
 * ＝2c の反証 中5）。数字の続き（150 と 1500 など）は違う。current が null（記録が無くなった）なら違う
 */
export function isStale(body: string, current: string | null): boolean {
  if (current === null) return true
  if (body === current) return false
  if (!body.startsWith(current)) return true
  return !/^[。\s　]/.test(body.slice(current.length))
}

/**
 * 〔申し送りを直す〕の欄に初めに入れる「直した後の申し送り」の案。小窓は全文を見せて直させる（職員が確かめてから送る）。
 * 前の記録の文はどこにも残っていないので、ひと言を推測で切り出さない（切り出すと、前の記録の値の切れ端が黙って載る
 * ＝2c の直しの確認の反証 中1）。確かな時だけ「。」の後ろを引き継ぐ: いまの文に「。」が無く（自由入力の活動の項目には
 * 「。」が入りうる）、申し送りに「。」がある時（記録の文には「。」が入らないので、最初の「。」の後ろはひと言か足した文）
 */
export function fixProposal(body: string, current: string): string {
  if (current.includes('。')) return current
  const i = body.indexOf('。')
  if (i < 0) return current
  const tail = body.slice(i + 1).trim()
  return tail === '' ? current : `${current}。${tail}`
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
