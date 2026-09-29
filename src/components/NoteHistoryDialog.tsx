// 申し送り1件の「変更の記録」（2026-09-29・申し送りを消さない作り替え 段B-5・精査 H4）。
// タイムラインのカードと日報の行（詳細の窓）から開く。record_history を table_name='notes' と行 id で引く
// （db.ts の fetchNoteHistory）。全体連絡（利用者なし）の申し送りも見られる。読むだけ（書かない）。
// 規律: トークン由来クラスのみ・色だけで意味を伝えない・console 出力なし

import { useEffect, useRef, useState } from 'react'
import { diffHistoryRow, fetchNoteHistory } from '../lib/db'
import type { RecordHistoryEntry } from '../lib/db'
import { clampLines, fmtChangedAt, fmtHistoryValue, historyColumnLabel } from '../lib/historyView'
import { ModalShell } from './ui'

export interface NoteHistoryDialogProps {
  /** null の間は閉じている */
  noteId: number | null
  /** 見出しに出す対象（利用者の表示名・「スタッフへ（全体）」） */
  label: string
  /** 職員 id → 氏名（引けなければ null） */
  staffName: (id: number) => string | null
  onClose: () => void
}

function Value({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const { head, truncated } = clampLines(text)
  return (
    <span className="whitespace-pre-wrap break-words">
      {open || !truncated ? text : head}
      {truncated ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ml-2 min-h-tap rounded border border-border-strong px-2 text-sm text-link"
        >
          {open ? '閉じる' : '全文'}
        </button>
      ) : null}
    </span>
  )
}

function Item({ entry, staffName }: { entry: RecordHistoryEntry; staffName: (id: number) => string | null }) {
  const changes = diffHistoryRow(entry.old_row, entry.new_row).filter((c) => {
    if (entry.op === 'delete' && (c.column === 'deleted_at' || c.column === 'deleted_by')) return false
    return historyColumnLabel('notes', c.column) !== null
  })
  const who = entry.changed_by_staff === null ? null : staffName(entry.changed_by_staff)
  return (
    <li className="rounded-md border border-border bg-surface p-3">
      <p className="flex flex-wrap items-center gap-gap text-sm text-ink2">
        <span className="tabular">{fmtChangedAt(entry.changed_at)}</span>
        {entry.op === 'delete' ? (
          <span className="font-bold text-danger">
            <span aria-hidden="true">▲ </span>削除
          </span>
        ) : null}
      </p>
      {changes.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {changes.map((c) => (
            <li key={c.column} className="text-base text-ink">
              <span className="font-bold">{historyColumnLabel('notes', c.column) ?? c.column}</span>：
              <Value text={fmtHistoryValue('notes', c.column, c.before, staffName)} />
              <span aria-hidden="true"> → </span>
              <span className="sr-only">から</span>
              <Value text={fmtHistoryValue('notes', c.column, c.after, staffName)} />
              <span className="sr-only">へ</span>
            </li>
          ))}
        </ul>
      ) : entry.op === 'delete' ? null : (
        <p className="mt-2 text-sm text-ink3">画面に出す項目の変更はありません。</p>
      )}
      <p className="mt-1 text-sm text-ink2">操作者 {who ?? '不明（取込・操作者の分からない変更）'}</p>
    </li>
  )
}

export function NoteHistoryDialog({ noteId, label, staffName, onClose }: NoteHistoryDialogProps) {
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'unavailable'>('loading')
  const [entries, setEntries] = useState<RecordHistoryEntry[]>([])
  const [tick, setTick] = useState(0)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (noteId === null) return
    let alive = true
    setState('loading')
    fetchNoteHistory(noteId)
      .then((res) => {
        if (!alive) return
        if (!res.available) {
          setState('unavailable')
          return
        }
        setEntries(res.entries)
        setState('ready')
      })
      .catch(() => {
        if (alive) setState('error')
      })
    return () => {
      alive = false
    }
  }, [noteId, tick])

  return (
    <ModalShell open={noteId !== null} label={`変更の記録（${label}）`} onClose={onClose} initialFocus={headingRef} fitVisualViewport>
      <div className="flex items-center justify-between gap-gap border-b border-border px-3 py-2">
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 text-base font-bold text-ink">
          <span className="block truncate">
            変更の記録
            <span className="ml-2 text-sm font-normal text-ink2">{label}</span>
          </span>
        </h2>
        <button
          type="button"
          aria-label="閉じる"
          onClick={onClose}
          className="min-h-tap min-w-tap shrink-0 rounded text-base text-ink2"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {state === 'loading' ? (
          <p className="text-base text-ink2">変更の記録を読み込み中です…</p>
        ) : state === 'error' ? (
          <div role="alert">
            <p className="text-base text-ink">
              <span aria-hidden="true">▲ </span>
              変更の記録を読み込めませんでした。通信状況を確認して、「再試行する」を押してください。
            </p>
            <button
              type="button"
              onClick={() => setTick((n) => n + 1)}
              className="mt-2 min-h-tap rounded border border-primary px-4 text-base font-bold text-primary"
            >
              再試行する
            </button>
          </div>
        ) : state === 'unavailable' ? (
          <p className="text-base text-ink2">
            <span aria-hidden="true">ⓘ </span>
            変更の記録はまだ使えません（サーバー側の設定待ち）。
          </p>
        ) : entries.length === 0 ? (
          <p className="text-base text-ink2">この申し送りは、登録の後に変更されていません。</p>
        ) : (
          <ul className="space-y-2">
            {entries.map((e) => (
              <Item key={e.id} entry={e} staffName={staffName} />
            ))}
          </ul>
        )}
      </div>
    </ModalShell>
  )
}
