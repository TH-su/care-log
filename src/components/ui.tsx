// 共通UI部品（contracts.md「src/components/ui.tsx が export する共通部品」の実装）。
//
// 規律（docs/design/contracts.md §共通規律）:
// - Tailwind はトークン由来クラスのみ。角括弧で値を直書きする arbitrary value と色・px直書きは書かない
// - タップ要素は min-h-tap（44px）＋隣接 gap は gap-gap（8px）
// - 色だけで意味を伝えない（記号・文字を必ず併記）
// - 実名・記録本文をコード・コメント・placeholder に書かない（表示は実行時の props のみ）
// - console 出力を持たない

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { hasNoteAlias, LEVEL_MARK, noteDisplayName } from '../lib/types'
import type { Level, Resident, Staff } from '../lib/types'

// ══════════════════════════════════════════════════════════════
// Chip
// ══════════════════════════════════════════════════════════════

export type ChipTone = 'plain' | 'warn' | 'danger' | 'ok' | 'info' | 'accent'

const CHIP_TONE: Record<ChipTone, string> = {
  plain: 'bg-surface2 text-ink2 border-border',
  warn: 'bg-warn-bg text-warn border-warn',
  danger: 'bg-danger-bg text-danger border-danger',
  ok: 'bg-ok-bg text-ok border-ok',
  info: 'bg-info-bg text-info border-info',
  accent: 'bg-accent-bg text-accent border-accent',
}

export interface ChipProps {
  children: ReactNode
  tone?: ChipTone
  onClick?: () => void
  className?: string
}

/**
 * 見た目 min-height 32px（min-h-8）のチップ。
 * onClick 有り＝ボタンになり、擬似要素 ::before を上下 6px はみ出させて
 * 縦のヒット領域を 32+6+6=44px に拡張する（ui-design.md §2【#5】）。
 * 横方向は拡張しないため、隣接チップを gap-gap（8px）で並べればヒット重複は起きない。
 * ※チップを折り返して並べる側は行間も gap-gap 以上あけること（縦拡張どうしの重なり防止）。
 */
export function Chip({ children, tone = 'plain', onClick, className = '' }: ChipProps) {
  const base = `inline-flex min-h-8 items-center gap-1 rounded-full border px-3 py-1 text-sm ${CHIP_TONE[tone]}`
  if (!onClick) {
    return <span className={`${base} ${className}`}>{children}</span>
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} relative before:absolute before:inset-x-0 before:-inset-y-1.5 ${className}`}
    >
      {children}
    </button>
  )
}

// ══════════════════════════════════════════════════════════════
// LevelCell
// ══════════════════════════════════════════════════════════════

// 記号体系（ui-design.md §2）: ↑↑赤=危険高値／↑黄=注意高値／↓黄=注意低値／↓↓青(info)=危険低値。
// 色だけに頼らないよう、可視の記号（LEVEL_MARK）＋スクリーンリーダー向けの語を併記する。
const LEVEL_STYLE: Record<Exclude<Level, null>, string> = {
  'danger-high': 'bg-danger-bg text-danger font-bold',
  'warn-high': 'bg-warn-bg text-warn font-bold',
  'warn-low': 'bg-warn-bg text-warn font-bold',
  'danger-low': 'bg-info-bg text-info font-bold',
}

const LEVEL_TEXT: Record<Exclude<Level, null>, string> = {
  'danger-high': '危険な高値',
  'warn-high': '注意が必要な高値',
  'warn-low': '注意が必要な低値',
  'danger-low': '危険な低値',
}

export interface LevelCellProps {
  value: number | null
  level: Level
  digits?: number
}

/** バイタル1値の表示。null は「—」＝未測定（未取込とは区別する）。 */
export function LevelCell({ value, level, digits = 0 }: LevelCellProps) {
  if (value == null) {
    return (
      <span className="tabular text-ink3">
        <span className="sr-only">未測定</span>
        <span aria-hidden="true">—</span>
      </span>
    )
  }
  return (
    <span
      className={`tabular inline-block rounded-sm px-1 ${level ? LEVEL_STYLE[level] : 'text-ink'}`}
    >
      {value.toFixed(digits)}
      {level ? (
        <>
          <span aria-hidden="true">{LEVEL_MARK[level]}</span>
          <span className="sr-only">（{LEVEL_TEXT[level]}）</span>
        </>
      ) : null}
    </span>
  )
}

// ══════════════════════════════════════════════════════════════
// SectionCard
// ══════════════════════════════════════════════════════════════

export interface SectionCardProps {
  title?: string
  children: ReactNode
  className?: string
}

export function SectionCard({ title, children, className = '' }: SectionCardProps) {
  return (
    <section className={`rounded-lg border border-border bg-surface p-4 ${className}`}>
      {title ? <h2 className="mb-2 text-lg font-bold text-ink">{title}</h2> : null}
      {children}
    </section>
  )
}

// ══════════════════════════════════════════════════════════════
// 3状態（ローディング／エラー／空）
// ══════════════════════════════════════════════════════════════

export interface LoadingBlockProps {
  label?: string
}

/** スケルトン3行＋状況テキスト。動きは付けない（reduced-motion 環境での高速点滅を避ける）。 */
export function LoadingBlock({ label = '読み込み中です…' }: LoadingBlockProps) {
  return (
    <div role="status" aria-live="polite" className="p-4">
      <p className="text-sm text-ink2">{label}</p>
      <div className="mt-3 space-y-2" aria-hidden="true">
        <div className="h-4 w-full rounded-sm bg-surface2" />
        <div className="h-4 w-3/4 rounded-sm bg-surface2" />
        <div className="h-4 w-1/2 rounded-sm bg-surface2" />
      </div>
    </div>
  )
}

export interface ErrorBlockProps {
  /** 「何が起きたか＋次にどうすればよいか」の順で書く（エラーコードだけにしない）。 */
  message: string
  onRetry?: () => void
}

export function ErrorBlock({ message, onRetry }: ErrorBlockProps) {
  return (
    <div role="alert" className="rounded-lg border border-danger bg-danger-bg p-4">
      <p className="text-base text-ink">
        <span aria-hidden="true">▲ </span>
        <span className="sr-only">エラー: </span>
        {message}
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary"
        >
          再試行する
        </button>
      ) : null}
    </div>
  )
}

export interface EmptyBlockProps {
  message: string
  actionLabel?: string
  onAction?: () => void
}

export function EmptyBlock({ message, actionLabel, onAction }: EmptyBlockProps) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 text-center">
      <p className="text-base text-ink2">{message}</p>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="mt-3 min-h-tap rounded border border-primary px-4 text-base font-bold text-primary"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// モーダル共通（fixed オーバーレイ＋role="dialog"＋aria-label）
// ══════════════════════════════════════════════════════════════

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * ダイアログの a11y 共通処理。
 * - 開いたら初期フォーカス（指定が無ければパネル自身）／閉じたら元の要素へ戻す
 * - Tab はパネル内で循環（背後のUIへ抜けない）
 * - Escape は onClose がある時だけ閉じる（必須選択のピッカーは閉じられない＝仕様どおり）
 * - 背面スクロールを止め、閉じたら元の値へ戻す
 */
function useDialog(open: boolean, onClose?: () => void, initialFocus?: RefObject<HTMLElement>) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<(() => void) | undefined>(onClose)
  const focusRef = useRef<RefObject<HTMLElement> | undefined>(initialFocus)

  // 毎レンダーで最新のハンドラを保持する（インライン関数で effect が再実行されるのを防ぐ）
  useEffect(() => {
    closeRef.current = onClose
    focusRef.current = initialFocus
  })

  useEffect(() => {
    if (!open) return
    const restore = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ;(focusRef.current?.current ?? panelRef.current)?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (closeRef.current) {
          e.preventDefault()
          closeRef.current()
        }
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
      restore?.focus?.()
    }
  }, [open])

  return panelRef
}

export interface ModalShellProps {
  open: boolean
  label: string
  onClose?: () => void
  initialFocus?: RefObject<HTMLElement>
  /** 幅を1段狭める（申し送りの詳細のように中身が短い窓。既定は max-w-md） */
  narrow?: boolean
  children: ReactNode
}

/**
 * 浮いた窓（フロートウィンドウ）の共通の器。
 * 背面を覆い、Esc で閉じ、Tab はこの窓の中で循環し、閉じたら元の要素へフォーカスが戻る。
 * この画面の外（日報の詳細など）からも使えるように公開している。
 */
export function ModalShell({ open, label, onClose, initialFocus, narrow = false, children }: ModalShellProps) {
  const panelRef = useDialog(open, onClose, initialFocus)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* 背景の覆い。トークン色に不透明度を掛けるため、独立要素に opacity を当てる。
          閉じられるダイアログでは覆い自体を native button にする（div+onClick を作らない）。
          tabIndex=-1 でタブ順には入れず、キーボードは Esc と各ボタンで閉じる。 */}
      {onClose ? (
        <button
          type="button"
          aria-label="閉じる"
          tabIndex={-1}
          onClick={onClose}
          className="absolute inset-0 cursor-default bg-ink opacity-60"
        />
      ) : (
        <div className="absolute inset-0 bg-ink opacity-60" aria-hidden="true" />
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`relative flex max-h-full w-full ${narrow ? 'max-w-sm' : 'max-w-md'} flex-col rounded-lg border border-border-strong bg-surface`}
      >
        {children}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// ConfirmDialog
// ══════════════════════════════════════════════════════════════

export interface ConfirmDialogProps {
  open: boolean
  title: string
  body?: string
  confirmLabel?: string
  /** 破壊的操作。塗りつぶしではなく枠線ボタンにする（デザインシステム規約） */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = '実行する',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // 初期フォーカスは「キャンセル」＝安全側に置く
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <ModalShell open={open} label={title} onClose={onCancel} initialFocus={cancelRef}>
      <div className="p-4">
        <h2 className="text-lg font-bold text-ink">{title}</h2>
        {body ? <p className="mt-2 text-base text-ink2">{body}</p> : null}
      </div>
      <div className="flex justify-end gap-gap border-t border-border p-4">
        <button
          type="button"
          ref={cancelRef}
          onClick={onCancel}
          className="min-h-tap rounded border border-border-strong px-4 text-base text-ink"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={
            danger
              ? 'min-h-tap rounded border border-danger px-4 text-base font-bold text-danger'
              : 'min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink'
          }
        >
          {danger ? <span aria-hidden="true">▲ </span> : null}
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  )
}

// ══════════════════════════════════════════════════════════════
// useToast
// ══════════════════════════════════════════════════════════════

/** Undo 付きトーストの表示時間（contracts.md「Undo は8秒」） */
const TOAST_UNDO_MS = 8000
/** Undo 無しトーストの表示時間（仮定値。契約に定めが無いため 4 秒） */
const TOAST_PLAIN_MS = 4000

interface ToastState {
  msg: string
  undo?: () => void
}

export function useToast(): { toast: ReactNode; show: (msg: string, undo?: () => void) => void } {
  const [state, setState] = useState<ToastState | null>(null)
  const timerRef = useRef<number | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => clearTimer, [clearTimer])

  const hide = useCallback(() => {
    clearTimer()
    setState(null)
  }, [clearTimer])

  const show = useCallback(
    (msg: string, undo?: () => void) => {
      clearTimer()
      setState({ msg, undo })
      timerRef.current = window.setTimeout(
        () => setState(null),
        undo ? TOAST_UNDO_MS : TOAST_PLAIN_MS,
      )
    },
    [clearTimer],
  )

  const toast = useMemo(
    () => (
      // ライブリージョンは常設し、中身だけ差し替える（読み上げの取りこぼし防止）。
      // bottom-20 は下タブ（56px）を避ける位置。pointer-events-none で背面操作を妨げない。
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center p-4">
        <div
          role="status"
          aria-live="polite"
          className={
            state
              ? 'pointer-events-auto flex w-full max-w-md items-center gap-gap rounded-lg border border-border-strong bg-surface p-3'
              : ''
          }
        >
          {state ? (
            <>
              <span className="flex-1 text-base text-ink">{state.msg}</span>
              {state.undo ? (
                <button
                  type="button"
                  onClick={() => {
                    const fn = state.undo
                    hide()
                    fn?.()
                  }}
                  className="min-h-tap shrink-0 rounded border border-primary px-3 text-base font-bold text-primary"
                >
                  元に戻す
                </button>
              ) : null}
              <button
                type="button"
                aria-label="通知を閉じる"
                onClick={hide}
                className="min-h-tap min-w-tap shrink-0 rounded text-base text-ink2"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </>
          ) : null}
        </div>
      </div>
    ),
    [state, hide],
  )

  return { toast, show }
}

// ══════════════════════════════════════════════════════════════
// SegmentPicker
// ══════════════════════════════════════════════════════════════

export interface SegmentOption {
  value: string
  label: string
}

export interface SegmentPickerProps {
  options: SegmentOption[]
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
}

/** 選択中は 色＋太字＋「✓」の3点で示す（色だけに頼らない）。 */
export function SegmentPicker({ options, value, onChange, ariaLabel }: SegmentPickerProps) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-gap">
      {options.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(o.value)}
            className={
              selected
                ? 'min-h-tap flex-1 rounded border border-primary bg-primary px-3 text-base font-bold text-primary-ink'
                : 'min-h-tap flex-1 rounded border border-border bg-surface px-3 text-base text-ink'
            }
          >
            <span aria-hidden="true" className={selected ? '' : 'invisible'}>
              ✓
            </span>
            <span>{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// ピッカーモーダル（職員・利用者）
// ══════════════════════════════════════════════════════════════

/** 絞込用キー: カタカナ→ひらがな・英字は小文字・空白を除去して部分一致させる */
function kanaKey(s: string): string {
  return s
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, '')
    .toLowerCase()
}

interface FilterFieldProps {
  id: string
  value: string
  onChange: (v: string) => void
}

function FilterField({ id, value, onChange }: FilterFieldProps) {
  return (
    <div className="border-b border-border p-3">
      <label htmlFor={id} className="block text-sm text-ink2">
        絞り込み
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        placeholder="氏名の一部を入力"
        className="mt-1 min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink"
      />
    </div>
  )
}

export interface StaffPickerModalProps {
  open: boolean
  staff: Staff[]
  onPick: (id: number) => void
  /** 省略時は閉じられない（起動時の必須選択に使う） */
  onClose?: () => void
  title?: string
}

export function StaffPickerModal({
  open,
  staff,
  onPick,
  onClose,
  title = '記録する職員を選ぶ',
}: StaffPickerModalProps) {
  const [q, setQ] = useState('')
  const fieldId = useId()

  // 閉じ直したとき絞込語が残らないようにする（前回の入力を持ち越さない）
  useEffect(() => {
    if (!open) setQ('')
  }, [open])

  const list = useMemo(() => {
    const key = kanaKey(q)
    if (!key) return staff
    return staff.filter((s) => kanaKey(s.name).includes(key))
  }, [staff, q])

  return (
    <ModalShell open={open} label={title} onClose={onClose}>
      <div className="flex items-center justify-between gap-gap border-b border-border p-3">
        <h2 className="text-lg font-bold text-ink">{title}</h2>
        {onClose ? (
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="min-h-tap min-w-tap shrink-0 rounded text-base text-ink2"
          >
            <span aria-hidden="true">✕</span>
          </button>
        ) : null}
      </div>
      <FilterField id={fieldId} value={q} onChange={setQ} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {staff.length === 0 ? (
          <EmptyBlock message="職員の一覧がまだありません。設定タブでマスタ同期を実行してください。" />
        ) : list.length === 0 ? (
          <EmptyBlock message="該当する職員がいません。入力した文字を減らしてお試しください。" />
        ) : (
          <ul className="space-y-2">
            {list.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onPick(s.id)}
                  className="min-h-tap w-full rounded border border-border bg-surface px-3 py-2 text-left text-base text-ink"
                >
                  {s.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ModalShell>
  )
}

export interface ResidentPickerModalProps {
  open: boolean
  residents: Resident[]
  /** allowAll で「スタッフへ（全体）」を選んだ場合は null が返る */
  onPick: (id: number | null) => void
  onClose: () => void
  allowAll?: boolean
  /**
   * 申し送りの対象を選ぶ時だけ true。
   * 「申し送りでの表示名」を大きく出し、マスタの氏名を小さく下に添える
   * （選ぶ瞬間に本名で確かめられるようにする＝取り違え防止。2026-09-01 指示）。
   * false の画面（バイタル・食事・外出外泊）は今までどおりマスタの氏名だけを出す。
   */
  useNoteAlias?: boolean
}

export function ResidentPickerModal({
  open,
  residents,
  onPick,
  onClose,
  allowAll = false,
  useNoteAlias = false,
}: ResidentPickerModalProps) {
  const [q, setQ] = useState('')
  const fieldId = useId()
  const title = '対象を選ぶ'

  useEffect(() => {
    if (!open) setQ('')
  }, [open])

  const list = useMemo(() => {
    const key = kanaKey(q)
    if (!key) return residents
    // 絞り込みは表示名でもマスタの氏名でも当たるようにする。
    // 表示名しか知らない人・本名しか知らない人のどちらでも探せるようにするため
    return residents.filter((r) =>
      [r.name, noteDisplayName(r), r.kana ?? '', r.room ?? ''].some((f) => kanaKey(f).includes(key)),
    )
  }, [residents, q])

  return (
    <ModalShell open={open} label={title} onClose={onClose}>
      <div className="flex items-center justify-between gap-gap border-b border-border p-3">
        <h2 className="text-lg font-bold text-ink">{title}</h2>
        <button
          type="button"
          aria-label="閉じる"
          onClick={onClose}
          className="min-h-tap min-w-tap shrink-0 rounded text-base text-ink2"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <FilterField id={fieldId} value={q} onChange={setQ} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {allowAll ? (
          <button
            type="button"
            onClick={() => onPick(null)}
            className="mb-2 min-h-tap w-full rounded border border-info bg-info-bg px-3 text-left text-base text-info"
          >
            <span aria-hidden="true">ⓘ </span>
            スタッフへ（全体）
          </button>
        ) : null}
        {residents.length === 0 ? (
          <EmptyBlock message="利用者の一覧がまだありません。設定タブでマスタ同期を実行してください。" />
        ) : list.length === 0 ? (
          <EmptyBlock message="該当する利用者がいません。入力した文字を減らしてお試しください。" />
        ) : (
          <ul className="space-y-2">
            {list.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onPick(r.id)}
                  className="flex min-h-tap w-full items-center gap-gap rounded border border-border bg-surface px-3 py-2 text-left text-base text-ink"
                >
                  {/* 200%文字でも欠けないよう固定幅ではなく最小幅で揃える */}
                  <span className="tabular min-w-12 shrink-0 text-sm text-ink3">
                    {r.room ?? '—'}
                  </span>
                  {/* 申し送りでは表示名を主に、マスタの氏名を小さく下に添える。
                      表示名を設定していない方は今までどおり氏名1行だけ */}
                  <span className="min-w-0 flex-1">
                    <span className="block font-bold">
                      {useNoteAlias ? noteDisplayName(r) : r.name}
                    </span>
                    {useNoteAlias && hasNoteAlias(r) ? (
                      <span className="block text-sm font-normal text-ink2">{r.name}</span>
                    ) : null}
                  </span>
                  {r.needs_review ? (
                    <span className="shrink-0 text-sm text-warn">
                      <span aria-hidden="true">▲</span>
                      <span className="sr-only">要確認</span>
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ModalShell>
  )
}
