// 申し送りの記入者の名前（2026-11-07 本人指示「一覧に無い名前も自由に書ける」・0058 の notes.reporter_name）。
// ・記入者は職員（reporter_id）を選ぶのが基本。一覧に無い人（応援・実習生など）の時だけ名前の文字（reporter_name）を残す
// ・表示は「職員の名前 → 無ければ書いた名前」の順（両方ある時は職員が勝つ・データベースの申送ビューアの読む口と同じ）
// ・純関数（画面・通信に触れない）。名前は端末の控えに残さない（呼び出し側の決まり）
//
// 拡張子付きで import する（tests の node --experimental-strip-types から直接読めるようにするため）
import type { Note } from './types.ts'

/** 書いた名前の長さの上限（0058 の check と同じ） */
export const REPORTER_NAME_MAX = 20

/**
 * 書いた名前をそろえる（前後の空白を除き、続く空白は1つにする）。空・長すぎる・文字でない時は null
 */
export function normalizeReporterName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/[\s　]+/g, ' ').trim()
  if (s === '' || [...s].length > REPORTER_NAME_MAX) return null
  return s
}

/**
 * 記入者の表示名。職員の名前（引けない時は「職員ID n」）→ 書いた名前 → 空
 */
export function reporterLabel(
  n: Pick<Note, 'reporter_id'> & { reporter_name?: string | null },
  staffName: (id: number) => string | null | undefined,
): string {
  if (n.reporter_id !== null && n.reporter_id !== undefined) return staffName(n.reporter_id) ?? `職員ID ${n.reporter_id}`
  return normalizeReporterName(n.reporter_name) ?? ''
}

/** 同じ記入者か（職員は id、書いた名前は名前で比べる。どちらも無い時は「同じでない」） */
export function sameReporter(
  a: Pick<Note, 'reporter_id'> & { reporter_name?: string | null },
  b: Pick<Note, 'reporter_id'> & { reporter_name?: string | null },
): boolean {
  if (a.reporter_id !== null && a.reporter_id !== undefined) return a.reporter_id === b.reporter_id
  if (b.reporter_id !== null && b.reporter_id !== undefined) return false
  const x = normalizeReporterName(a.reporter_name)
  return x !== null && x === normalizeReporterName(b.reporter_name)
}
