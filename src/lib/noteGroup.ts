// 日報の申し送りで「同じ日・同じ区分・同じ方」の記録を1つの行にまとめる（純関数・副作用なし。2026-10-15 本人回答・仕様 §4）。
// データは1件ずつのまま（同期・競合の仕組みは変えない）。まとめるのは表示（画面と印刷）だけ。
//
//   区分 … 日勤（day・16時前）／16時以降（day・after16）／デイ（daycare）／夜勤（night）
//   束ねる鍵 … 記録日（note_on）・区分・対象（resident_id）。対象なし（null）と「予定」の記録は束ねない（1件ずつの行・
//             「予定」は 2026-10-20 本人指示＝事務所の予定は1件ずつ見えるように）
//   並び … 日報と同じ（時刻 timeSortKey〔夜勤明けの「翌」は夜の後ろ〕→ id）。まとめた行は、日勤・16時以降・夜勤では
//          最後に書いた記録（id がいちばん大きい＝書いた順の最後）の位置に出す（2026-11-17 本人指示「最初に書いた欄に寄ると、読み返さない恐れがある」）。
//          デイは最初の記録の位置のまま（指示の外・仮置き）。まとめた行の中の並び（最初の本文が上）は変えない
//   内容 … 最初の本文、改行して2件目以降の本文。記入者の列がある区分では、記録ごとに記入者の枠を区切って出す
//          （2026-10-20 本人指示）。記入者の列が無い区分（夜勤）だけ、2件目以降の末尾に「（記入者の姓）」を付ける
//          （1つ前の記録と同じ記入者の時は紙に出さない・2026-11-07 本人指示）
//
// 拡張子付きで import する（tests から直接読めるようにするため）。個人情報は扱わない。

import type { Note, NoteCategory } from './types.ts'
import { noteIsNextMorning, timeSortKey } from './nextMorning.ts'
import { hasSchedule, unionCategories } from './noteCategory.ts'
import { normalizeReporterName, sameReporter } from './reporterName.ts'

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
  /** まとめた記録（1件以上・並び順）。notes[0] が最初の記録（記入者欄）。行の位置は groupAnchorLast の区分では最後の記録 */
  notes: Note[]
  /** まとめた記録の分類の和集合（NOTE_CATEGORIES の並び） */
  categories: NoteCategory[]
}

/**
 * まとめた行を最後の記録の位置に出す区分か（日勤・16時以降・夜勤。2026-11-17 本人指示）。デイは最初の記録の位置のまま（仮置き）
 */
export function groupAnchorLast(section: NoteSection): boolean {
  return section !== 'daycare'
}

/**
 * 申し送りを、同じ日・同じ区分・同じ対象（resident_id。null は対象外）ごとに1つの行へまとめる。
 * order を省くと日報の並び（sheetNoteOrder）で並べ替えてからまとめる（入力の配列は書き換えない）。
 * order に null を渡すと入力の並びをそのまま使う（呼び手が並べ済みの時）。
 * 行の並びは、日勤・16時以降・夜勤では「その行の最後の記録」の位置、デイは「その行の最初の記録」の位置（groupAnchorLast）。
 * まとめた行の中の並びは入力の並び（最初の記録が上）
 */
export function groupNotesByResident(
  notes: readonly Note[],
  order: ((a: Note, b: Note) => number) | null = sheetNoteOrder,
): NoteGroupRow[] {
  const list = order === null ? notes.slice() : notes.slice().sort(order)
  const rows: NoteGroupRow[] = []
  const byKey = new Map<string, NoteGroupRow>()
  // 行の位置（list の何番目の記録の位置に出すか）。まとめた行は区分で最初か最後の記録（2026-11-17 本人指示）
  const anchor = new Map<NoteGroupRow, number>()
  let idx = -1
  for (const n of list) {
    idx += 1
    const section = noteSectionOf(n)
    if (n.resident_id === null || hasSchedule(n.categories)) {
      // 対象なしの行と「予定」の記録は1件ずつの行（同じ方の記録でもまとめない）
      const single: NoteGroupRow = { key: `n:${n.id}`, note_on: n.note_on, section, resident_id: n.resident_id, notes: [n], categories: [] }
      anchor.set(single, idx)
      rows.push(single)
      continue
    }
    const key = `g:${n.note_on}|${section}|${n.resident_id}`
    const row = byKey.get(key)
    if (row !== undefined) {
      // 最後に書いた記録＝記録の番号（id・書いた順に増える）がいちばん大きい記録。時刻の並びの最後ではない
      // （過去の日の日勤は時刻が入らず並びの先頭に来るため・反証レビュー 2026-11-17）
      if (groupAnchorLast(section) && n.id > row.notes.reduce((m, x) => (x === n ? m : Math.max(m, x.id)), -Infinity)) anchor.set(row, idx)
      row.notes.push(n)
      continue
    }
    const created: NoteGroupRow = { key, note_on: n.note_on, section, resident_id: n.resident_id, notes: [n], categories: [] }
    byKey.set(key, created)
    anchor.set(created, idx)
    rows.push(created)
  }
  // 位置の並べ替え（Array.prototype.sort は安定。位置はどの行も別の番号なので同じ値は無い）
  rows.sort((a, b) => (anchor.get(a) ?? 0) - (anchor.get(b) ?? 0))
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
  /**
   * 1つ前の記録と同じ記入者（2026-11-07 本人指示「同じ人なら姓を出さないようにして」）。
   * true の時は紙に姓を出さない（画面は記入者を選び直すボタンとして薄い字で残す）
   */
  sameAsPrev: boolean
}

/**
 * まとめた行の内容欄（最初の本文、2件目以降の本文＋「（記入者の姓）」）。staffName は記入者 id → 職員名（引けなければ null）。
 * 1件だけの行は本文1行（suffix なし）
 */
export function noteGroupLines(row: Pick<NoteGroupRow, 'notes'>, staffName: (id: number) => string | null): NoteGroupLine[] {
  return row.notes.map((n, i) => {
    // 記入者は職員の名前、無ければ一覧に無い名前（0058・2026-11-07）
    const who = n.reporter_id !== null ? staffName(n.reporter_id) : normalizeReporterName(n.reporter_name)
    if (i === 0 || who === null) return { note: n, body: n.body, suffix: '', sameAsPrev: false }
    const s = surnameOf(who)
    return {
      note: n,
      body: n.body,
      suffix: s === '' ? '' : `（${s}）`,
      sameAsPrev: sameReporter(row.notes[i - 1], n),
    }
  })
}
