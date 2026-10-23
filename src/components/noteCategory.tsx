// 日報の申し送りの「分類」・検索・分類で抽出の部品（2026-10-15 本人回答・仕様 §1・§3）。
// 画面の状態は持たない（呼び手 DailySheetPage が持つ）。DB・localStorage には触れない。個人情報は受け取った表示だけ。
//
//   CategoryChips      … 分類欄の札（分類ごとに鮮やかな色＋必ず文字。色は sheet.css の --dsheet-cat-* トークン）
//   CategoryToggles    … 分類窓の6つのボタン＋〔全て〕（押すと6つ全部に印・もう一度で全部外す）＋〔予定〕（2026-10-20。
//                        〔全て〕では付け外ししない。事務・管理者以外のログインでは押せない＝scheduleDisabled）
//   ImportanceToggles  … 分類窓の重要度（通常／▲重要／‼最重要。ロック中は押せない形にするため自前のボタン）
//   NoteSearchBar      … 日付バーの右端の検索欄（×で消去）と〔分類で抽出〕。画面のみ（print:hidden）
//   CategoryExtractDialog … 分類を選んで、表示中の範囲の該当する申し送りを一覧する窓（行を押すとその行へ移る）
//
// HIG: 押す所は 44px 以上（min-h-tap）・状態は ✓ と aria-pressed で伝える（色だけに頼らない）・読み上げ名を付ける。

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ModalShell } from './ui'
import { CONTENT_CATEGORIES, NOTE_CATEGORIES, IMPORTANCE_LABEL, SCHEDULE_CATEGORY } from '../lib/types'
import type { Importance, NoteCategory } from '../lib/types'
import { hasAllCategories, toggleAllCategories, toggleCategory } from '../lib/noteCategory'

/** 分類 → 札の色の番号（sheet.css の .dsheet-cat-1〜7。並びは NOTE_CATEGORIES と同じ。7＝予定） */
export function categoryClass(c: NoteCategory): string {
  return `dsheet-cat dsheet-cat-${NOTE_CATEGORIES.indexOf(c) + 1}`
}

/** 分類欄の札（無い時は何も出さない＝呼び手が空の表示を決める） */
export function CategoryChips({ categories }: { categories: readonly NoteCategory[] }) {
  if (categories.length === 0) return null
  return (
    <span className="dsheet-cat-list">
      {categories.map((c) => (
        <span key={c} className={categoryClass(c)}>
          {c}
        </span>
      ))}
    </span>
  )
}

/**
 * 分類の6つのボタン＋〔全て〕＋〔予定〕。value は今の分類（7値の並び）。onChange は新しい分類（7値の並び）
 * label は読み上げの頭（まとめた行で記録ごとに出す時に「2件目の」などを渡す）。
 * scheduleDisabled は〔予定〕だけを押せなくする（事務・管理者以外のログイン・2026-10-20 本人回答）
 */
export function CategoryToggles({
  value,
  disabled,
  onChange,
  label = '',
  scheduleDisabled = false,
}: {
  value: readonly NoteCategory[]
  disabled: boolean
  onChange: (next: NoteCategory[]) => void
  label?: string
  scheduleDisabled?: boolean
}) {
  const all = hasAllCategories(value)
  const toggleBtn = (c: NoteCategory, off: boolean) => {
    const on = value.includes(c)
    return (
      <button
        key={c}
        type="button"
        aria-pressed={on}
        disabled={off}
        onClick={() => onChange(toggleCategory(value, c))}
        // 印の付いた札は分類の色で塗る（文字と ✓ でも分かる）。付いていない札は白地に分類の色の枠
        className={`dsheet-cat-btn min-h-tap shrink-0 rounded px-3 text-base ${on ? `${categoryClass(c)} dsheet-cat-on` : `dsheet-cat-off dsheet-cat-off-${NOTE_CATEGORIES.indexOf(c) + 1}`} disabled:opacity-50`}
      >
        <span aria-hidden="true">{on ? '✓ ' : ''}</span>
        {c}
      </button>
    )
  }
  return (
    <div role="group" aria-label={`${label}分類`} className="flex flex-wrap items-center gap-gap">
      {CONTENT_CATEGORIES.map((c) => toggleBtn(c, disabled))}
      {/* 〔全て〕は別の見た目（四角・太字・濃い枠）。6つ全部に印が付いている時は押すと全部外す */}
      <button
        type="button"
        aria-pressed={all}
        disabled={disabled}
        onClick={() => onChange(toggleAllCategories(value))}
        aria-label={all ? `${label}分類を全部外す` : `${label}分類を全部付ける`}
        className={`min-h-tap shrink-0 rounded-md border-2 px-3 text-base font-bold ${
          all ? 'border-ink bg-ink text-bg' : 'border-ink bg-surface text-ink'
        } disabled:opacity-50`}
      >
        <span aria-hidden="true">{all ? '✓ ' : ''}</span>全て
      </button>
      {/* 〔予定〕（2026-10-20）。〔全て〕の外に置く＝〔全て〕では付け外ししない */}
      {toggleBtn(SCHEDULE_CATEGORY, disabled || scheduleDisabled)}
      {scheduleDisabled && !disabled ? (
        <span className="text-sm text-ink2">予定は事務・管理者のログインで付け外しできます</span>
      ) : null}
    </div>
  )
}

const IMPORTANCES: readonly Importance[] = ['normal', 'important', 'critical']

/** 重要度（通常／▲重要／‼最重要）。SegmentPicker と同じ見た目で、ロック中は押せない形にする */
export function ImportanceToggles({
  value,
  disabled,
  onChange,
  label = '',
}: {
  value: Importance
  disabled: boolean
  onChange: (v: Importance) => void
  label?: string
}) {
  return (
    <div role="group" aria-label={`${label}重要度`} className="flex flex-wrap gap-gap">
      {IMPORTANCES.map((v) => {
        const selected = v === value
        return (
          <button
            key={v}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(v)}
            className={`${
              selected
                ? 'border-primary bg-primary font-bold text-primary-ink'
                : 'border-border bg-surface text-ink'
            } min-h-tap min-w-max flex-1 rounded border px-3 text-base disabled:opacity-50`}
          >
            <span aria-hidden="true" className={selected ? '' : 'invisible'}>
              ✓
            </span>
            <span>{IMPORTANCE_LABEL[v]}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * 日付バーの右端の検索欄と〔分類で抽出〕（画面のみ）。検索語は呼び手の state だけに持つ（localStorage に置かない）。
 * summary は「n件中m件」など、絞り込んだ結果の一言（読み上げにも出す）
 */
export function NoteSearchBar({
  value,
  onChange,
  onOpenExtract,
  summary,
}: {
  value: string
  onChange: (v: string) => void
  onOpenExtract: () => void
  summary: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="dsheet-search flex min-w-0 flex-wrap items-center gap-gap print:hidden">
      <div role="search" className="relative flex min-w-0 items-center">
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && value !== '') {
              e.preventDefault()
              onChange('')
            }
          }}
          placeholder="申し送りを検索"
          aria-label="申し送りを検索（本文・対象・記入者。空白で区切るとすべてを含む行）"
          autoComplete="off"
          enterKeyHint="search"
          className="dsheet-search-input min-h-tap w-56 min-w-0 rounded-md border border-border-strong bg-surface pl-2 pr-11 text-base text-ink"
        />
        {value !== '' ? (
          <button
            type="button"
            aria-label="検索の語を消す"
            onClick={() => {
              onChange('')
              inputRef.current?.focus()
            }}
            className="absolute right-0 top-0 min-h-tap min-w-tap rounded-md text-base text-ink2"
          >
            <span aria-hidden="true">×</span>
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onOpenExtract}
        aria-haspopup="dialog"
        className="min-h-tap shrink-0 rounded-md border border-primary bg-surface px-3 text-base font-bold text-primary"
      >
        分類で抽出
      </button>
      {/* 絞り込んだ結果（打鍵のたびに読み上げを重ねないよう polite） */}
      <span role="status" aria-live="polite" className="text-sm text-ink2">
        {summary}
      </span>
    </div>
  )
}

/** 分類で抽出の一覧の1件（呼び手が日付・区分・名前を整えて渡す） */
export interface ExtractItem {
  /** 一覧の鍵（日付と記録の id） */
  key: string
  day: string
  noteId: number
  dayLabel: string
  sectionLabel: string
  target: string
  categories: NoteCategory[]
  body: string
  reporter: string
}

/**
 * 分類で抽出（手前の窓）。分類を選ぶ（複数可・どれかを含む記録）と、表示中の範囲の該当する申し送りを一覧する。
 * 行を押すと onJump（呼び手が窓を閉じてその行へスクロールする）
 */
export function CategoryExtractDialog({
  open,
  onClose,
  items,
  onJump,
  rangeLabel,
}: {
  open: boolean
  onClose: () => void
  /** 表示中の範囲の申し送り（分類の無い記録も含む。絞るのはこの部品） */
  items: readonly ExtractItem[]
  onJump: (item: ExtractItem) => void
  /** 表示中の範囲（見出しに出す） */
  rangeLabel: string
}) {
  const [picked, setPicked] = useState<NoteCategory[]>([])
  const headId = useId()
  // 開くたびに選び直す（前の選択を残さない＝原則11の対象外の一時の状態）
  useEffect(() => {
    if (open) setPicked([])
  }, [open])
  const hits = useMemo(
    () => (picked.length === 0 ? [] : items.filter((it) => it.categories.some((c) => picked.includes(c)))),
    [items, picked],
  )
  return (
    <ModalShell open={open} onClose={onClose} label="分類で抽出">
      <div className="flex items-center justify-between gap-gap border-b border-border px-3 py-2">
        <h2 id={headId} className="min-w-0 flex-1 text-base font-bold text-ink">
          分類で抽出
          <span className="ml-2 text-sm font-normal text-ink2">{rangeLabel}</span>
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
      <div className="border-b border-border p-3">
        <p className="mb-2 text-sm text-ink2">分類を選ぶと、表示中の日の申し送りから選んだ分類のどれかを含むものを出します。</p>
        <CategoryToggles value={picked} disabled={false} onChange={setPicked} label="抽出する" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {picked.length === 0 ? (
          <p className="text-sm text-ink2">分類を選んでください。</p>
        ) : hits.length === 0 ? (
          <p className="text-sm text-ink2" role="status">
            該当する申し送りはありません。
          </p>
        ) : (
          <>
            <p className="mb-2 text-sm text-ink2" role="status">
              {hits.length}件
            </p>
            <ul className="space-y-2">
              {hits.map((it) => (
                <li key={it.key}>
                  <button
                    type="button"
                    onClick={() => onJump(it)}
                    className="block min-h-tap w-full rounded-md border border-border-strong bg-surface p-2 text-left text-ink"
                  >
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink2">
                      <span className="tabular">{it.dayLabel}</span>
                      <span>{it.sectionLabel}</span>
                      <span className="font-bold text-ink">{it.target}</span>
                      <CategoryChips categories={it.categories} />
                      {it.reporter !== '' ? <span>記入者 {it.reporter}</span> : null}
                    </span>
                    <span className="mt-1 block whitespace-pre-wrap break-words text-base">{it.body}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </ModalShell>
  )
}
