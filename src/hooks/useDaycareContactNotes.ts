// デイの連絡帳の行（1人1日1行・0061／0064）を、各画面（バイタル・食事／活動／機能訓練）が持つための読み手（2026-11-18 本人指示）。
// 連絡帳の「項目ごとの記載」の小窓（DaycareContactSectionDialog）と行の入口のボタン（DaycareContactEntryButton）が使う。
// 連絡帳の画面（DaycareContactPage）は入れかけの文の仕組みごと自分で読むので、これは使わない。
//
// ・その日の行を1回読む（fetchDaycareContactNotes）。日を変えた時・画面の〔最新に更新〕（reloadKey）で読み直す
// ・読めない時は notes を null にする（ボタンは押せなくして理由の文＝blockedReason）。表が無い（0061 未適用）・4欄の列が無い（0064 未適用）も分ける
// ・小窓を開いた時は refetch でその日の行を読み直してから基準にする。保存の結果は put で差し替える（ボタンの「✓」がすぐ付く）
// ・取得は db.ts の関数だけ。端末に何も残さない（localStorage を使わない）。氏名・記録を console に出さない
import { useCallback, useEffect, useRef, useState } from 'react'
import { contactSectionsReady, fetchDaycareContactNotes, isContactMissingError } from '../lib/db'
import { contactNoteOf } from '../lib/daycareContact'
import type { DaycareContactNote } from '../lib/daycareContact'

/** 連絡帳の表が無い（0061 未適用） */
export const MSG_CONTACT_ENTRY_MISSING = '連絡帳はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。'
/** 4欄の列が無い（0064 未適用） */
export const MSG_CONTACT_ENTRY_SECTIONS = '連絡帳の項目ごとの記載はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。'
/** 読めない */
export const MSG_CONTACT_ENTRY_UNREAD = '連絡帳を読み込めませんでした。〔最新に更新〕を押してください（読めるまで、連絡帳のボタンは押せません）。'

export interface DaycareContactNotesState {
  /** その日の行（null＝まだ読めていない・読めない） */
  notes: DaycareContactNote[] | null
  /** 読み込み中（初めの1回・日を変えた後） */
  loading: boolean
  /** 連絡帳のボタンを押せない理由（押せる時・読み込み中は null） */
  blockedReason: string | null
  /** その方のその日の行（無ければ null・読めていない時も null） */
  noteOf: (residentId: number) => DaycareContactNote | null
  /** その日の行を読み直す（小窓を開いた時の基準）。読めない時は例外 */
  refetch: () => Promise<DaycareContactNote[]>
  /** 保存の結果で行を差し替える（同じ日の時だけ） */
  put: (row: DaycareContactNote) => void
}

export function useDaycareContactNotes(day: string, reloadKey: number): DaycareContactNotesState {
  const [state, setState] = useState<{ day: string; notes: DaycareContactNote[] | null; missing: boolean; sections: boolean; failed: boolean }>({
    day,
    notes: null,
    missing: false,
    sections: true,
    failed: false,
  })
  const genRef = useRef(0)
  const dayRef = useRef(day)
  dayRef.current = day

  const read = useCallback(async (target: string): Promise<DaycareContactNote[]> => {
    const gen = ++genRef.current
    try {
      const rows = await fetchDaycareContactNotes(target)
      // 4欄の列が無い DB だと分かるのは読んだ後（列が無い応答を受けた時だけ false になる旗）
      const sections = contactSectionsReady()
      if (gen === genRef.current && target === dayRef.current) setState({ day: target, notes: rows, missing: false, sections, failed: false })
      return rows
    } catch (e) {
      const missing = isContactMissingError(e)
      if (gen === genRef.current && target === dayRef.current) {
        // 同じ日の読み直しに失敗した時は、前に読めた行を残さない（古い行を基準にして書かない）
        setState({ day: target, notes: null, missing, sections: true, failed: true })
      }
      throw e
    }
  }, [])

  useEffect(() => {
    setState((prev) => (prev.day === day ? prev : { day, notes: null, missing: false, sections: true, failed: false }))
    read(day).catch(() => {})
  }, [day, reloadKey, read])

  const refetch = useCallback(() => read(dayRef.current), [read])

  const put = useCallback((row: DaycareContactNote) => {
    setState((prev) =>
      prev.day !== row.day || prev.notes === null
        ? prev
        : { ...prev, notes: [...prev.notes.filter((n) => n.id !== row.id && n.resident_id !== row.resident_id), row] },
    )
  }, [])

  const cur = state.day === day ? state : null
  const notes = cur?.notes ?? null
  const noteOf = useCallback((residentId: number) => (notes === null ? null : contactNoteOf(notes, residentId, day)), [notes, day])
  const loading = cur === null || (cur.notes === null && !cur.failed)
  const blockedReason =
    cur === null || loading
      ? null
      : cur.missing
        ? MSG_CONTACT_ENTRY_MISSING
        : cur.notes === null
          ? MSG_CONTACT_ENTRY_UNREAD
          : !cur.sections
            ? MSG_CONTACT_ENTRY_SECTIONS
            : null
  return { notes, loading, blockedReason, noteOf, refetch, put }
}
