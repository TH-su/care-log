// デイ（せせらぎ）2026-11-10 1人の画面の印の守り: 1人の画面の申し送りの印（DaycareNoteMark.tsx の useDaycareNoteMarks）の読み込みの判断
// （純関数・副作用なし・DB/DOM に触れない）。tests/daycare-note-mark.test.mjs から node で直接読んで動きで確かめる。
// 一括の画面（DaycareNoteMarkDay.tsx の load・keepRow）と同じ守りを、日に加えて人でもそろえる:
// ・読み込みに番号を付け、画面に入れた読み込みより後に始めた読み込みの時だけ入れる（行き違った古い読み込みで新しい印を消さない）
// ・結果を入れる前に、読み込みを始めた時の人・日と、いま表示している人・日を照合する（送っている最中に人・日を替えても、前の方の
//   読み直しの結果を表示中の方の印として入れない・表示中の方の印を上書きして「読めていない」に見せない）
// ・書けた行（送れた・外した・直した）は控え、読み直しの失敗・古い読み込みで消さない（mergeKeptRows）。控えは控えた人・日の読み込みにだけ重ねる
// 個人情報は扱わない（利用者は数値IDだけ。氏名は受け取らない）。

import { mergeKeptRows } from './daycareNoteMarkDay.ts'
import type { KeptRow, MarkRowLike } from './daycareNoteMarkDay.ts'

/** 人・日の鍵（読めた印・読めなかった印・書けた行の控えに付ける） */
export function markPersonKey(residentId: number, day: string): string {
  return `${residentId}:${day}`
}

/** 読めた印（key＝読んだ人・日） */
export interface PersonMarks<T> {
  key: string
  rows: T[]
}

/** 書けた行の控え（key＝控えた人・日。rows＝note の id → 行・控えた時の読み込みの番号） */
export interface PersonKept<T> {
  key: string
  rows: ReadonlyMap<number, KeptRow<T>>
}

/** その人・日の読めた印（読めた印が違う人・日の分なら null＝まだ読めていない。違う方の印を使わない） */
export function marksFor<T>(marks: PersonMarks<T> | null, key: string): T[] | null {
  return marks !== null && marks.key === key ? marks.rows : null
}

/**
 * 読み込みが届いた時の扱い。from＝読み込みを始めた時の人・日・shown＝いま表示している人・日・applied＝画面に入れた読み込みの番号。
 * ・from と shown が違う: 画面には入れない・控えも番号も変えない（rows は読んだ行のまま返す＝送る直前の読み直しで世代を数えるのに使う）
 * ・同じ: 控え（同じ人・日の分だけ）を重ね、applied より後に始めた読み込みの時だけ画面に入れる（marks が null でない時に入れる）
 */
export function personLoaded<T extends MarkRowLike>(p: {
  rows: readonly T[]
  gen: number
  from: string
  shown: string
  applied: number
  kept: PersonKept<T>
}): { rows: T[]; marks: PersonMarks<T> | null; kept: PersonKept<T>; applied: number } {
  if (p.from !== p.shown) return { rows: [...p.rows], marks: null, kept: p.kept, applied: p.applied }
  // ほかの人・日の控えは重ねない・触らない（その方へ戻った時の読み込みで、サーバーを正として外れる）
  const mine = p.kept.key === p.from
  const merged = mine ? mergeKeptRows(p.rows, p.kept.rows, p.gen) : { rows: [...p.rows], kept: p.kept.rows }
  const kept: PersonKept<T> = mine ? { key: p.from, rows: merged.kept } : p.kept
  if (p.gen <= p.applied) return { rows: merged.rows, marks: null, kept, applied: p.applied }
  return { rows: merged.rows, marks: { key: p.from, rows: merged.rows }, kept, applied: p.gen }
}

/** 読み込みが失敗した時、「読めなかった」を画面に出してよいか（いま表示している人・日の、入れた読み込みより後に始めた読み込みの時だけ） */
export function personLoadFailShown(p: { gen: number; from: string; shown: string; applied: number }): boolean {
  return p.from === p.shown && p.gen > p.applied
}

/**
 * 書けた行を控えに入れる（from＝書いた人・日）。いま表示している人・日と違えば null（控えも画面も変えない＝一括の画面の keepRow と同じ）。
 * 控えが別の人・日の分なら捨てて、この人・日の控えにする。gen＝控えた時の読み込みの番号（これ以前に始めた読み込みは、この書き込みを知らない）
 */
export function personKeep<T extends MarkRowLike>(p: {
  kept: PersonKept<T>
  from: string
  shown: string
  row: T
  gen: number
}): PersonKept<T> | null {
  if (p.from !== p.shown) return null
  const rows = new Map<number, KeptRow<T>>(p.kept.key === p.from ? p.kept.rows : null)
  rows.set(p.row.note.id, { row: p.row, gen: p.gen })
  return { key: p.from, rows }
}

/** 書けた行を画面の印に重ねる（同じ人・日の印の時だけ。違う人・日の印・まだ読めていない時は変えない） */
export function marksWithRow<T extends MarkRowLike>(marks: PersonMarks<T> | null, key: string, row: T, gen: number): PersonMarks<T> | null {
  if (marks === null || marks.key !== key) return marks
  return { key, rows: mergeKeptRows(marks.rows, new Map([[row.note.id, { row, gen }]]), gen).rows }
}
