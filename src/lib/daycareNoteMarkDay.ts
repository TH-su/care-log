// デイ（せせらぎ）計画D（2026-11-10）: 一括の画面の申し送りの印の判断（純関数・副作用なし・DB/DOM に触れない）。
// 部品 DaycareNoteMarkDay.tsx とバイタル・食事の画面が使い、tests/daycare-note-mark-day.test.mjs から node で直接読んで動きで確かめる
// （反証の確認 1回目の「判断の所を純関数に出す」）。個人情報は扱わない（氏名は受け取らない）。

import { fixProposal, isStale, markFamilyPrefix } from './daycareNoteMark.ts'
import type { MarkKind, MarkRecord } from './daycareNoteMark.ts'
import { toHalfWidth } from './format.ts'

/** 読み込んだ印の行（判断に使う最小の形） */
export interface MarkRowLike {
  note: { id: number; body: string }
  clientKey: string
  deleted: boolean
}

/** 送信待ち・止まりの状態（db.ts の PendingNoteMark・PendingNoteRow の state と同じ値） */
export type MarkQueueState = 'pending' | 'conflict' | 'rejected'

/**
 * 新しく作ってよいか（1人1日1件の判断・反証 中3）。その記録の組（機能訓練は tr＊・ほかは記録ごと）に、生きている印か、この端末の送信待ちの
 * 印の登録があれば作らない。ほかの方・ほかの日・ほかの記録の印は数えない
 */
export function markTaken(rows: readonly MarkRowLike[], pendingKeys: readonly string[], day: string, residentId: number, rec: MarkRecord): boolean {
  const family = markFamilyPrefix(day, residentId, rec)
  return rows.some((r) => !r.deleted && r.clientKey.startsWith(family)) || pendingKeys.some((k) => k.startsWith(family))
}

/** 一括のワンタップでしか作らない記録（ひと言が付かない）。その日の活動・機能訓練 */
function oneTapOnly(kind: MarkKind): boolean {
  return kind === 'activityDay' || kind === 'training'
}

/**
 * 印の本文が、いまの記録の文と食い違うか。その日の活動・機能訓練は完全一致で比べる（文に「。」が入りうるので、前の切れ端を
 * 「ひと言」と取り違えない＝反証の確認 軽1）。ほかの記録（1人の画面でひと言を付けられる）は今の isStale のまま
 */
export function markDiffers(kind: MarkKind, body: string, text: string | null): boolean {
  if (oneTapOnly(kind)) return text === null || body !== text
  return isStale(body, text)
}

/**
 * 〔申し送りを直す〕の直した後の本文の案。その日の活動・機能訓練は、いまの文そのもの（ひと言が付かないので引き継ぐものが無い。前の記録の
 * 「。」の後ろを付けない＝反証の確認 中1）。ほかの記録は1人の画面と同じ fixProposal（ひと言を引き継ぐ）
 */
export function markFixProposal(kind: MarkKind, body: string, text: string): string {
  return oneTapOnly(kind) ? text : fixProposal(body, text)
}

/**
 * 行の小さな印の状態（反証の確認 軽3）。live＝付いている／pending＝この端末の送信待ち／stopped＝止まった（登録が止まった・付いている印への
 * 直す・外すが止まった）／null＝無い
 */
export function markStateOf(p: { live: boolean; liveChange: MarkQueueState | null; pend: MarkQueueState | null }): 'live' | 'pending' | 'stopped' | null {
  if (p.live) return p.liveChange !== null && p.liveChange !== 'pending' ? 'stopped' : 'live'
  if (p.pend === null) return null
  return p.pend === 'pending' ? 'pending' : 'stopped'
}

/** 書けた行の控え（gen＝控えた時の読み込みの番号。これ以前に始めた読み込みは、この書き込みを知らない） */
export interface KeptRow<T> {
  row: T
  gen: number
}

/**
 * 書けた行（送れた・外した・直した）を、読み込んだ行に重ねる（反証 軽1・反証の確認の「keepRow」）。控えより前に始めた読み込み
 * （loadGen <= gen）は書けた行を知らないので、書けた行で置き換える（送れた行を消さない・取り消した行を戻さない）。控えより後に始めた
 * 読み込み（loadGen > gen）はサーバーを正として控えを外す
 */
export function mergeKeptRows<T extends MarkRowLike>(
  rows: readonly T[],
  kept: ReadonlyMap<number, KeptRow<T>>,
  loadGen: number,
): { rows: T[]; kept: Map<number, KeptRow<T>> } {
  const next = new Map<number, KeptRow<T>>()
  let out = [...rows]
  for (const [id, k] of kept) {
    if (loadGen > k.gen) continue
    next.set(id, k)
    out = [...out.filter((r) => r.note.id !== id), k.row]
  }
  return { rows: out, kept: next }
}

/**
 * 〔申し送りを直す〕を送ってよいか（反証の確認 軽6）。送る直前に読み直した行で、その申し送りが生きていて本文が見た時のままの時だけ
 */
export function fixTargetUnchanged(rows: readonly MarkRowLike[], noteId: number, seenBody: string): boolean {
  const r = rows.find((x) => x.note.id === noteId)
  return r !== undefined && !r.deleted && r.note.body === seenBody
}

/** 部品の知らせ1件（seq＝出した順。result＝操作の結果＝送れなかった・送信待ちにした。queued＝送信待ちにした旨） */
export interface MarkMsgLike {
  seq: number
  text: string
  result?: true
  queued?: true
}

/** テンキーの1行の「押せなかった理由」と「操作の結果」を出してよい場の鍵（欄・打ちかけの値・その方の印の状態のどれかが変われば違う鍵） */
export function keypadNoteKey(p: { key: string | null; field: string | null; buf: string; mark: string }): string {
  return JSON.stringify([p.key, p.field, p.buf, p.mark])
}
/** 操作の結果を出してよい場の鍵（欄を移るまで） */
export function keypadOpKey(p: { key: string | null; field: string | null }): string {
  return JSON.stringify([p.key, p.field])
}

/**
 * テンキーの1行に出す申し送りの知らせ（反証の確認 軽2）。null の時は画面の案内（いまの値・前回・未測定と記録済み・「365」）を出す。
 * 順: 押せなかった理由（その場の鍵が同じ間だけ）→ テンキーを開いている間にその方の印の操作で出た結果（送れなかった・送信待ちにした＝送信待ちが
 * 残る間・止まった。欄を移るまで）→ 無し。前に出た知らせ・「別の端末が先に…」（結果ではない）は出さない
 */
export function keypadMarkLine(p: {
  note: { text: string; at: string } | null
  op: { since: number; at: string } | null
  noteKey: string
  opKey: string
  msgs: readonly MarkMsgLike[]
  stillQueued: boolean
  stopped: string | null
}): string | null {
  if (p.note !== null && p.note.at === p.noteKey) return p.note.text
  if (p.op === null || p.op.at !== p.opKey) return null
  const since = p.op.since
  const mine = p.msgs.filter((m) => m.seq > since && m.result === true && (m.queued !== true || p.stillQueued)).sort((a, b) => b.seq - a.seq)
  if (mine.length > 0) return mine[0].text
  return p.stopped
}

/**
 * テンキーの物理キーの扱い（反証の確認: Enter・Esc を小窓に渡す判断をキーの処理の前に置く）。null＝テンキーは受け取らない（そのキーの
 * 普段の動きに任せる）。入れる欄（INPUT・TEXTAREA）・主食・副食の選択肢（SELECT）・確認の小窓の中で押したキーは受け取らない。
 * 受け取るのは 数字（全角も）・小数点・Backspace（1文字消す）・Enter（次へ）・Esc（閉じる）
 */
export function keypadKeyAction(key: string, ctx: { tag: string | null; inDialog: boolean }): string | null {
  if (ctx.inDialog) return null
  if (ctx.tag === 'INPUT' || ctx.tag === 'TEXTAREA' || ctx.tag === 'SELECT') return null
  const k = toHalfWidth(key)
  if (/^\d$/.test(k) || k === '.') return k
  if (key === 'Backspace') return 'back'
  if (key === 'Enter') return 'next'
  if (key === 'Escape') return 'close'
  return null
}
