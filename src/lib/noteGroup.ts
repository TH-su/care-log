// 日報の申し送りで「同じ日・同じ区分・同じ方」の記録を1つの行にまとめる（純関数・副作用なし。2026-10-15 本人回答・仕様 §4）。
// データは1件ずつのまま（同期・競合の仕組みは変えない）。まとめるのは表示（画面と印刷）だけ。
//
//   区分 … 日勤（day・16時前）／16時以降（day・after16）／デイ（daycare）／夜勤（night）
//   束ねる鍵 … 記録日（note_on）・区分・対象（resident_id）。対象なし（null）は束ねない（1件ずつの行）
//   並び … 日報と同じ（時刻 timeSortKey〔夜勤明けの「翌」は夜の後ろ〕→ id）。まとめた行は最初の記録の位置に出す
//   内容 … 最初の本文、改行して2件目以降の本文。2件目以降は末尾に「（記入者の姓）」（記入者が無ければ付けない）
//
// 拡張子付きで import する（tests から直接読めるようにするため）。個人情報は扱わない。

import type { Note, NoteCategory } from './types.ts'
import { noteIsNextMorning, timeSortKey } from './nextMorning.ts'
import { unionCategories } from './noteCategory.ts'

/** 日報の区分（表題帯の単位） */
export type NoteSection = 'day' | 'late' | 'daycare' | 'night'

/** その申し送りがどの区分に出るか（日報の dayNotes／lateNotes と同じ分け方） */
export function noteSectionOf(n: Pick<Note, 'shift' | 'after16'>): NoteSection {
  if (n.shift === 'night') return 'night'
  if (n.shift === 'daycare') return 'daycare'
  return n.after16 ? 'late' : 'day'
}

/**
 * 日報の並び（DailySheetPage の読み込みの並べ替えと同じ）: 時刻（「翌」は +24時）→ id。時刻なしは '' として先頭側
 */
export function sheetNoteOrder(a: Note, b: Note): number {
  return (
    (timeSortKey(a.occurred_at, noteIsNextMorning(a)) ?? '').localeCompare(timeSortKey(b.occurred_at, noteIsNextMorning(b)) ?? '') ||
    a.id - b.id
  )
}

/** まとめた行（1件だけの行も同じ形） */
export interface NoteGroupRow {
  /** 行の鍵。まとめた行は 'g:<日>|<区分>|<対象>'、対象なしの行は 'n:<id>'（React の key・スクロール先に使える） */
  key: string
  note_on: string
  section: NoteSection
  resident_id: number | null
  /** まとめた記録（1件以上・並び順）。notes[0] が最初の記録（記入者欄・行の位置） */
  notes: Note[]
  /** まとめた記録の分類の和集合（NOTE_CATEGORIES の並び） */
  categories: NoteCategory[]
}

/**
 * 申し送りを、同じ日・同じ区分・同じ対象（resident_id。null は対象外）ごとに1つの行へまとめる。
 * order を省くと日報の並び（sheetNoteOrder）で並べ替えてからまとめる（入力の配列は書き換えない）。
 * order に null を渡すと入力の並びをそのまま使う（呼び手が並べ済みの時）。
 * 行の並びは「その行の最初の記録」の位置。まとめた行の中の並びも同じ順
 */
export function groupNotesByResident(
  notes: readonly Note[],
  order: ((a: Note, b: Note) => number) | null = sheetNoteOrder,
): NoteGroupRow[] {
  const list = order === null ? notes.slice() : notes.slice().sort(order)
  const rows: NoteGroupRow[] = []
  const byKey = new Map<string, NoteGroupRow>()
  for (const n of list) {
    const section = noteSectionOf(n)
    if (n.resident_id === null) {
      rows.push({ key: `n:${n.id}`, note_on: n.note_on, section, resident_id: null, notes: [n], categories: [] })
      continue
    }
    const key = `g:${n.note_on}|${section}|${n.resident_id}`
    const row = byKey.get(key)
    if (row !== undefined) {
      row.notes.push(n)
      continue
    }
    const created: NoteGroupRow = { key, note_on: n.note_on, section, resident_id: n.resident_id, notes: [n], categories: [] }
    byKey.set(key, created)
    rows.push(created)
  }
  for (const r of rows) r.categories = unionCategories(r.notes.map((n) => n.categories))
  return rows
}

/**
 * 職員名の姓（最初の半角・全角の空白より前）。空白が無ければ名前全部。前後の空白は無視する。空・null は ''
 * 例: '職員 01' → '職員'、'職員01' → '職員01'
 */
export function surnameOf(name: string | null | undefined): string {
  if (typeof name !== 'string') return ''
  const t = name.replace(/^[\s　]+|[\s　]+$/g, '')
  if (t === '') return ''
  const i = t.search(/[\s　]/)
  return i < 0 ? t : t.slice(0, i)
}

/** まとめた行の内容欄の1行（どの記録の本文か・末尾に付ける記入者の姓） */
export interface NoteGroupLine {
  note: Note
  /** 本文（そのまま） */
  body: string
  /** 末尾に付ける「（姓）」。最初の記録・記入者なし・名前が引けない時は '' */
  suffix: string
}

/**
 * まとめた行の内容欄（最初の本文、2件目以降の本文＋「（記入者の姓）」）。staffName は記入者 id → 職員名（引けなければ null）。
 * 1件だけの行は本文1行（suffix なし）
 */
export function noteGroupLines(row: Pick<NoteGroupRow, 'notes'>, staffName: (id: number) => string | null): NoteGroupLine[] {
  return row.notes.map((n, i) => {
    if (i === 0 || n.reporter_id === null) return { note: n, body: n.body, suffix: '' }
    const s = surnameOf(staffName(n.reporter_id))
    return { note: n, body: n.body, suffix: s === '' ? '' : `（${s}）` }
  })
}
