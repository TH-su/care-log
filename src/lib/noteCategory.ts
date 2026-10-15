// 申し送りの「分類」（notes.categories・0032）の純関数（副作用なし）。
// 値の正本は types.ts の NOTE_CATEGORIES（体調・食事・薬・支援調整・消耗品・家族）。サーバーの check と同じ6値。
// 並びはいつも NOTE_CATEGORIES の順・重複なしにそろえる（サーバーは集合として比べるが、送る値をそろえておくと
// 画面の比較・印刷の並びが端末ごとに揺れない）。
// 拡張子付きで import する（tests から直接読めるようにするため・historyView.ts と同じ）。
// 個人情報は扱わない。

import { NOTE_CATEGORIES } from './types.ts'
import type { NoteCategory } from './types.ts'

/** 6値のどれかか */
export function isNoteCategory(v: unknown): v is NoteCategory {
  return typeof v === 'string' && (NOTE_CATEGORIES as readonly string[]).includes(v)
}

/**
 * 受け取った値を分類の配列に整える（6値の並び・重複なし）。配列でない・6値以外の要素がある時は null
 * （読めない値を黙って捨てない＝呼び手が「分からない」として扱う）
 */
export function normalizeCategories(v: unknown): NoteCategory[] | null {
  if (!Array.isArray(v)) return null
  if (!v.every(isNoteCategory)) return null
  const have = new Set<string>(v as string[])
  return NOTE_CATEGORIES.filter((c) => have.has(c))
}

/** 1つの分類の印を付け外しした配列（6値の並び） */
export function toggleCategory(list: readonly NoteCategory[], c: NoteCategory): NoteCategory[] {
  const have = new Set<string>(list)
  if (have.has(c)) have.delete(c)
  else have.add(c)
  return NOTE_CATEGORIES.filter((x) => have.has(x))
}

/** 6つ全部に印が付いているか */
export function hasAllCategories(list: readonly NoteCategory[]): boolean {
  const have = new Set<string>(list)
  return NOTE_CATEGORIES.every((c) => have.has(c))
}

/** 〔全て〕: 6つ全部に印が付いていれば全部外す、そうでなければ全部に付ける */
export function toggleAllCategories(list: readonly NoteCategory[]): NoteCategory[] {
  return hasAllCategories(list) ? [] : [...NOTE_CATEGORIES]
}

/** 複数の記録の分類の和集合（まとめた行の分類欄に出す・6値の並び）。undefined（分からない）は空として足す */
export function unionCategories(lists: ReadonlyArray<readonly NoteCategory[] | undefined>): NoteCategory[] {
  const have = new Set<string>()
  for (const l of lists) for (const c of l ?? []) have.add(c)
  return NOTE_CATEGORIES.filter((c) => have.has(c))
}

/** 2つの分類が同じ集合か（並びの違いは同じとみなす） */
export function sameCategories(a: readonly NoteCategory[] | undefined, b: readonly NoteCategory[] | undefined): boolean {
  const x = new Set<string>(a ?? [])
  const y = new Set<string>(b ?? [])
  if (x.size !== y.size) return false
  for (const c of x) if (!y.has(c)) return false
  return true
}
