// 五十音の行（あ行・か行…）を決める純関数（2026-11-07 本人指示・カルテの利用者一覧の「五十音順」）。
// React に依存しない（tests/kana-row.test.mjs から node で直接読む）。個人情報は持たない。

/** 行の並び（「その他」は読みの無い方・かな以外で始まる方） */
export const KANA_ROWS = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ', 'その他'] as const
export type KanaRow = (typeof KANA_ROWS)[number]

/** 行ごとの頭の文字（濁点・半濁点・小さい字を含む） */
const ROW_CHARS: Record<Exclude<KanaRow, 'その他'>, string> = {
  あ: 'ぁあぃいぅうゔぇえぉお',
  か: 'かがきぎくぐけげこご',
  さ: 'さざしじすずせぜそぞ',
  た: 'ただちぢっつづてでとど',
  な: 'なにぬねの',
  は: 'はばぱひびぴふぶぷへべぺほぼぽ',
  ま: 'まみむめも',
  や: 'ゃやゅゆょよ',
  ら: 'らりるれろ',
  わ: 'ゎわゐゑをん',
}

/** 並べ替え・行分けのための読み（カタカナ→ひらがな・空白を除く）。読みが無い時は '' */
export function kanaReading(kana: string | null | undefined): string {
  if (typeof kana !== 'string') return ''
  return kana
    .normalize('NFKC')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　]+/g, '')
}

/** 読みの頭の文字から行を決める（読みが無い・かな以外は「その他」） */
export function kanaRowOf(kana: string | null | undefined): KanaRow {
  const head = kanaReading(kana).charAt(0)
  if (head === '') return 'その他'
  for (const row of KANA_ROWS) {
    if (row === 'その他') continue
    if (ROW_CHARS[row].includes(head)) return row
  }
  return 'その他'
}

/**
 * 五十音順に並べて行ごとに分ける。行の中は読みの順（同じ読みは氏名・id の順）。
 * 人のいない行は出さない。読みの無い方は最後の「その他」へ（氏名の順）
 */
export function groupByKanaRow<T extends { id: number; name: string; kana: string | null }>(
  people: readonly T[],
): { row: KanaRow; people: T[] }[] {
  const sorted = people.slice().sort((a, b) => {
    const ka = kanaReading(a.kana)
    const kb = kanaReading(b.kana)
    if (ka === '' && kb !== '') return 1
    if (ka !== '' && kb === '') return -1
    if (ka !== kb) return ka < kb ? -1 : 1
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    return a.id - b.id
  })
  const map = new Map<KanaRow, T[]>()
  for (const p of sorted) {
    const row = kanaRowOf(p.kana)
    const list = map.get(row)
    if (list) list.push(p)
    else map.set(row, [p])
  }
  return KANA_ROWS.filter((r) => map.has(r)).map((row) => ({ row, people: map.get(row) as T[] }))
}

/** 行の見出し（「あ行」・「その他」） */
export function kanaRowLabel(row: KanaRow): string {
  return row === 'その他' ? 'その他' : `${row}行`
}
