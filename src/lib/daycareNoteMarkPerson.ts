// デイ（せせらぎ）2026-11-10 1人の画面の印の守り: 1人の画面の申し送りの印（DaycareNoteMark.tsx の useDaycareNoteMarks）の読み込みの判断
// （純関数・副作用なし・DB/DOM に触れない）。tests/daycare-note-mark.test.mjs から node で直接読んで動きで確かめる。
// 一括の画面（DaycareNoteMarkDay.tsx の load・keepRow）と同じ守りを、日に加えて人でもそろえる:
// ・読み込みに番号を付け、その人・日で入れた読み込みより後に始めた読み込みの時だけ入れる（行き違った古い読み込みで新しい印を消さない）。
//   番号の比べは人・日ごと（別の方の読み込みの番号で、表示中の方の前に始めた読み込みを捨てない＝反証 軽3）
// ・結果を画面に入れる前に、読み込みを始めた時の人・日と、いま表示している人・日を照合する（送っている最中に人・日を替えても、前の方の
//   読み直しの結果を表示中の方の印として入れない・表示中の方の印を上書きして「読めていない」に見せない）
// ・書けた行（送れた・外した・直した）は人・日ごとに控え、その人・日の読み込みと、送る直前の読み直しが読めなかった時の代わりにだけ重ねる。
//   表示中でない方の書き込みも、その人・日の鍵で控える（別の方の表示中に届いても、戻った時に〔申し送りにする〕へ戻さない・取り消した印や
//   直す前の本文を出さない＝反証 中1・軽2）。読み直しの失敗・古い読み込みで消さない（mergeKeptRows）
// 個人情報は扱わない（利用者は数値IDだけ。氏名は受け取らない）。

import { mergeKeptRows } from './daycareNoteMarkDay.ts'
import type { KeptRow, MarkRowLike } from './daycareNoteMarkDay.ts'

/** 人・日の鍵（読めた印・読めなかった印・入れた読み込み・書けた行の控えに付ける） */
export function markPersonKey(residentId: number, day: string): string {
  return `${residentId}:${day}`
}

/** 読めた印（key＝読んだ人・日） */
export interface PersonMarks<T> {
  key: string
  rows: T[]
}

/** その人・日で入れた最後の読み込み（gen＝読み込みの番号・rows＝読んだ行。控えは重ねる前） */
export interface PersonRead<T> {
  gen: number
  rows: readonly T[]
}

/**
 * 部品のマウント中の、人・日ごとの読み込みと控え（端末には残さない）。reads＝人・日 → 入れた最後の読み込み／kept＝人・日 →（note の id →
 * 書けた行・控えた時の読み込みの番号）
 */
export interface PersonStore<T> {
  reads: ReadonlyMap<string, PersonRead<T>>
  kept: ReadonlyMap<string, ReadonlyMap<number, KeptRow<T>>>
}

/** 空の読み込みと控え（部品のマウントの時） */
export function emptyPersonStore<T>(): PersonStore<T> {
  return { reads: new Map(), kept: new Map() }
}

/** その人・日の読めた印（読めた印が違う人・日の分なら null＝まだ読めていない。違う方の印を使わない） */
export function marksFor<T>(marks: PersonMarks<T> | null, key: string): T[] | null {
  return marks !== null && marks.key === key ? marks.rows : null
}

/** 人・日の控えを差し替えた控えの全体（空になった人・日は消す） */
function keptWith<T>(
  kept: ReadonlyMap<string, ReadonlyMap<number, KeptRow<T>>>,
  key: string,
  rows: ReadonlyMap<number, KeptRow<T>>,
): Map<string, ReadonlyMap<number, KeptRow<T>>> {
  const next = new Map(kept)
  if (rows.size === 0) next.delete(key)
  else next.set(key, rows)
  return next
}

/**
 * 読み込みが届いた時の扱い。from＝読み込みを始めた時の人・日・shown＝いま表示している人・日。
 * ・その人・日の控えを重ねる（控えより前に始めた読み込みには重ね、後に始めた読み込みはサーバーを正として控えを外す）。rows＝重ねた行
 *   （呼んだ所へ返す＝送る直前の読み直しで世代を数えるのに使う）
 * ・その人・日で入れた読み込みより後に始めた時だけ、その人・日の最後の読み込みにする。さらに from と shown が同じ時だけ show（画面に入れる印）
 */
export function personLoaded<T extends MarkRowLike>(
  store: PersonStore<T>,
  p: { rows: readonly T[]; gen: number; from: string; shown: string },
): { store: PersonStore<T>; rows: T[]; show: PersonMarks<T> | null } {
  const merged = mergeKeptRows(p.rows, store.kept.get(p.from) ?? new Map<number, KeptRow<T>>(), p.gen)
  const kept = keptWith(store.kept, p.from, merged.kept)
  const last = store.reads.get(p.from)
  if (last !== undefined && p.gen <= last.gen) return { store: { reads: store.reads, kept }, rows: merged.rows, show: null }
  const reads = new Map(store.reads)
  reads.set(p.from, { gen: p.gen, rows: [...p.rows] })
  return { store: { reads, kept }, rows: merged.rows, show: p.from === p.shown ? { key: p.from, rows: merged.rows } : null }
}

/** 読み込みが失敗した時、「読めなかった」を画面に出してよいか（いま表示している人・日の、その人・日で入れた読み込みより後に始めた読み込みの時だけ） */
export function personLoadFailShown<T>(store: PersonStore<T>, p: { gen: number; from: string; shown: string }): boolean {
  return p.from === p.shown && p.gen > (store.reads.get(p.from)?.gen ?? 0)
}

/**
 * 書けた行を、その人・日の控えに入れる（from＝書いた人・日。表示中でない方の書き込みも控える＝反証 中1）。gen＝控えた時の読み込みの番号
 * （これ以前に始めた読み込みは、この書き込みを知らない）。ほかの人・日の控えは触らない
 */
export function personKeep<T extends MarkRowLike>(store: PersonStore<T>, p: { from: string; row: T; gen: number }): PersonStore<T> {
  const rows = new Map(store.kept.get(p.from) ?? new Map<number, KeptRow<T>>())
  rows.set(p.row.note.id, { row: p.row, gen: p.gen })
  return { reads: store.reads, kept: keptWith(store.kept, p.from, rows) }
}

/**
 * 送る直前の読み直しが読めなかった時の代わり（反証 中1）: その人・日で、このマウント中に入れた最後の読み込みに控えを重ねた行。
 * その人・日の読み込みが1回も入っていなければ null（控えだけでは、ほかの端末の印・世代が分からないので付けない）
 */
export function personKnown<T extends MarkRowLike>(store: PersonStore<T>, from: string): T[] | null {
  const last = store.reads.get(from)
  if (last === undefined) return null
  return mergeKeptRows(last.rows, store.kept.get(from) ?? new Map<number, KeptRow<T>>(), last.gen).rows
}

/** 書けた行を画面の印に重ねる（同じ人・日の印の時だけ。違う人・日の印・まだ読めていない時は変えない） */
export function marksWithRow<T extends MarkRowLike>(marks: PersonMarks<T> | null, key: string, row: T, gen: number): PersonMarks<T> | null {
  if (marks === null || marks.key !== key) return marks
  return { key, rows: mergeKeptRows(marks.rows, new Map([[row.note.id, { row, gen }]]), gen).rows }
}
