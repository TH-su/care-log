// 日報の表題行の検索欄（端末内の絞り込み）の純関数（副作用なし。2026-10-15 本人回答・仕様 §1）。
// 対象は本文・対象者の表示名と氏名・記入者名。空白（半角・全角）区切りの語はすべて含む時だけ合う（AND）。
// 大文字小文字・全角半角（NFKC）・カタカナとひらがなの違いは吸収し、空白は除いて比べる（types.ts の nameKey と同じ考え方＝
// 姓と名の間の空白の違いで外れない）。サーバーへは問い合わせない。検索語は保存しない（呼び手も localStorage に置かない）。
//
// 軽さ: 1件ごとの比べる文字（haystack）は noteSearchText で一度だけ作り、語を変えるたびに作り直さない（呼び手が
// useMemo で記録ごとに控える）。語の正規化も parseSearchQuery で1回だけ。
//
// 拡張子付きで import する（tests から直接読めるようにするため）。個人情報は扱わない。

/** カタカナ（ァ〜ヶ）をひらがなへ。ヴ・ヵ・ヶ も対応するひらがな（ゔ・ゕ・ゖ）へ */
function kataToHira(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
}

/** 比べるための文字に整える（NFKC → 小文字 → カタカナをひらがな → 空白を除く） */
export function normalizeSearchText(s: string): string {
  return kataToHira(s.normalize('NFKC').toLowerCase()).replace(/[\s　]+/g, '')
}

/** 検索語を語の配列に（空白区切り・正規化済み・空の語は捨てる）。空の検索語は [] */
export function parseSearchQuery(q: string): string[] {
  const out: string[] = []
  for (const w of q.split(/[\s　]+/)) {
    const t = normalizeSearchText(w)
    if (t !== '' && !out.includes(t)) out.push(t)
  }
  return out
}

/**
 * 1件の比べる文字（本文・対象者の名前・記入者名を区切り文字でつないで正規化したもの）。null・空は飛ばす。
 * 区切りは '\u0000'（正規化で消えない字。本文の終わりと名前の始まりをまたいで合わせない）
 */
export function noteSearchText(parts: ReadonlyArray<string | null | undefined>): string {
  const out: string[] = []
  for (const p of parts) {
    if (typeof p !== 'string' || p === '') continue
    const t = normalizeSearchText(p)
    if (t !== '') out.push(t)
  }
  return out.join('\u0000')
}

/** 語（parseSearchQuery の結果）がすべて haystack（noteSearchText の結果）に含まれるか。語が無ければ true（絞り込まない） */
export function matchSearch(haystack: string, terms: readonly string[]): boolean {
  for (const t of terms) if (!haystack.includes(t)) return false
  return true
}

/**
 * 1件の申し送りが検索語に合うか（簡便形。多数を絞る時は noteSearchText を控えて matchSearch を使う）。
 * residentNames は対象者の表示名と氏名（両方渡す）。reporterName は記入者名
 */
export function noteMatchesQuery(
  q: string | readonly string[],
  fields: { body: string; residentNames?: ReadonlyArray<string | null | undefined>; reporterName?: string | null },
): boolean {
  const terms = typeof q === 'string' ? parseSearchQuery(q) : q
  if (terms.length === 0) return true
  return matchSearch(noteSearchText([fields.body, ...(fields.residentNames ?? []), fields.reporterName]), terms)
}
