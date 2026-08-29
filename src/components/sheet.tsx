// スプシ模倣UIの共通部品（docs/design/sheet-contracts.md §4 の実装）。
//
// 規律（contracts.md §共通規律／sheet-contracts.md §8）:
// - Tailwind は角括弧の arbitrary value を書かない。色はトークン由来クラス、
//   シートの寸法は src/styles/sheet.css の CSS 変数（--sheet-font / --sheet-row-h / --w-* 等）を
//   inline style から var() 参照で使う（px の直書きをしない）
// - 色だけで意味を伝えない（しきい値は LEVEL_MARK の記号、行の色は名前を必ず併記）
// - 実名・記録本文をコード・コメント・placeholder に書かない（表示は実行時の props のみ）
// - console 出力を持たない
// - 編集可否は onCommit の有無で決まる。入力封鎖中（native_input_enabled=false）は
//   呼び出し側が onCommit を渡さない＝読み取り専用になる（理由文は各ページが出す）
// - 空の確定（値を消す操作）はそのまま onCommit('') として渡す。取り消し手段（Undo）は
//   呼び出し側が用意する（contracts.md「破壊的操作は確認 or Undo」）

import { Children, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
// DOM の KeyboardEvent（document のリスナー）と混ざらないよう React 側は別名で受ける
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { LEVEL_MARK, LS, NOTE_COLOR_LABEL, ZOOM_STEPS } from '../lib/types'
import type { Level, NoteColor, Zoom } from '../lib/types'

// ══════════════════════════════════════════════════════════════
// 表示倍率（LS.zoom ↔ documentElement の --sheet-zoom）
// ══════════════════════════════════════════════════════════════

/** 不正値・未保存のフォールバック先（スプシ完全一致＝13px 基準） */
const DEFAULT_ZOOM: Zoom = 100

/** 保存済みの倍率を既知値照合で読む（未知値・壊れた値・参照不能は 100% へ） */
function readZoom(): Zoom {
  try {
    const n = Number(window.localStorage.getItem(LS.zoom))
    return (ZOOM_STEPS as readonly number[]).includes(n) ? (n as Zoom) : DEFAULT_ZOOM
  } catch {
    return DEFAULT_ZOOM // プライベートモード等で参照できない場合も表示は続ける
  }
}

/** 端末ごとの表示設定として保存する（UI状態のみ・業務データは保存しない） */
function writeZoom(z: Zoom): void {
  try {
    window.localStorage.setItem(LS.zoom, String(z))
  } catch {
    // 保存できなくても当セッションの表示は成立させる（安全側フォールバック）
  }
}

/** sheet.css が calc で参照する倍率（1 / 1.25 / 1.5）を documentElement に反映する */
function applyZoom(z: Zoom): void {
  document.documentElement.style.setProperty('--sheet-zoom', String(z / 100))
}

// ══════════════════════════════════════════════════════════════
// 一覧の表示条件（日数・フロア）の保存 — 画面ごとに別の値を持つ
// ══════════════════════════════════════════════════════════════

/**
 * 表示条件を持つ一覧（契約 §6 バイタル＝4日/1階・§7 食事＝11日/全と既定が違う）。
 * daily は日報の表示単位（10日 / 1日・2026-08-28 の追加指示）。
 * 保存するのは**表示単位（UI状態）だけ**で、見ていた日付は保存しない
 * （日付は業務データに紐づく＝取り違えの危険があるため。dev-principles 原則11）。
 */
export type SheetScope = 'vitals' | 'meals' | 'daily'

const SCOPE_TAG: Record<SheetScope, string> = { vitals: 'v', meals: 'm', daily: 'd' }
/** 値に使えるのは日数（数字）とフロア（数字 / all / other）だけ。区切り文字は入らない */
const PREF_VALUE_RE = /^[0-9a-z]+$/

/**
 * 保存済みの値を画面別に取り出す。書式は 'v:<バイタル>|m:<食事>'。
 * 旧形式（素の値だけ）・壊れた値は「未保存」として扱う＝どちらの画面の値か分からないものを
 * 片方へ適用しない（既知値のホワイトリスト照合は呼び出し側が値そのものに対して行う）。
 */
function parsePrefs(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw === null) return out
  for (const part of raw.split('|')) {
    const i = part.indexOf(':')
    if (i <= 0) continue
    const value = part.slice(i + 1)
    if (PREF_VALUE_RE.test(value)) out[part.slice(0, i)] = value
  }
  return out
}

/**
 * 一覧の表示条件（LS.sheetDays / LS.sheetFloor）を画面別に読む。
 * types.ts は変更禁止でキーを増やせないため、1つのキーの中に画面別の値を並べて持つ。
 * 未保存・壊れた値は null（＝呼び出し側の既定へ倒す）。
 */
export function readSheetPref(key: string, scope: SheetScope): string | null {
  try {
    if (typeof window === 'undefined') return null
    return parsePrefs(window.localStorage.getItem(key))[SCOPE_TAG[scope]] ?? null
  } catch {
    return null // 参照できない環境（プライベートモード等）でも表示は続ける
  }
}

/** 同じキーに入っている「もう一方の画面の値」は書き換えない */
export function writeSheetPref(key: string, scope: SheetScope, value: string): void {
  if (!PREF_VALUE_RE.test(value)) return
  try {
    if (typeof window === 'undefined') return
    const cur = parsePrefs(window.localStorage.getItem(key))
    cur[SCOPE_TAG[scope]] = value
    const next = Object.values(SCOPE_TAG)
      .filter((tag) => cur[tag] !== undefined)
      .map((tag) => `${tag}:${cur[tag]}`)
      .join('|')
    window.localStorage.setItem(key, next)
  } catch {
    // 保存できなくても当セッションの表示は成立させる（安全側フォールバック）
  }
}

// ══════════════════════════════════════════════════════════════
// SheetFrame
// ══════════════════════════════════════════════════════════════

export interface SheetFrameProps {
  children: ReactNode
  className?: string
}

/** 高さ上限を使う枠の目印（sheet.css の .sheet-frame-fit）。この枠だけ実測して変数を書き戻す */
const FIT_CLASS = 'sheet-frame-fit'

/**
 * 枠より下に積まれている高さ（px）。
 * 「枠の後ろに続く兄弟の高さ」＋「祖先の下余白・下罫線」を body まで足し上げる。
 * **枠自身の高さに依存しない値**なので、上限を当てた後に測り直しても同じ値になる
 * （document の scrollHeight から引く出し方は、内容が短い時に上限が縮み続けるので使わない）。
 * fixed / absolute の要素（下部タブなど）は流れの高さを取らないので数えない
 * ＝下部タブぶんの逃げは、その上の要素が持つ下余白として数えられる。
 */
function spaceBelow(el: HTMLElement): number {
  /** 数値にならない値（auto 等）は 0 として扱う */
  const num = (v: string): number => Number.parseFloat(v) || 0
  let total = 0
  let node: HTMLElement = el
  while (node.parentElement !== null) {
    const ncs = window.getComputedStyle(node)
    total += num(ncs.marginBottom)
    for (let s = node.nextElementSibling; s !== null; s = s.nextElementSibling) {
      if (!(s instanceof HTMLElement)) continue
      const cs = window.getComputedStyle(s)
      if (cs.display === 'none' || cs.position === 'fixed' || cs.position === 'absolute') continue
      // 余白の相殺は数えきれないので外寸で概算する（多めに見る＝枠がはみ出す側へ倒さない）
      total += s.getBoundingClientRect().height + num(cs.marginTop) + num(cs.marginBottom)
    }
    const parent = node.parentElement
    const pcs = window.getComputedStyle(parent)
    total += num(pcs.paddingBottom) + num(pcs.borderBottomWidth)
    if (parent === document.body) break
    node = parent
  }
  return total
}

/**
 * 倍率つきのシート枠。子はテーブル。横スクロールはこのコンポーネントが持つ。
 * - 居室・氏名の左固定（position: sticky）はこの枠が横スクロールの器になることで効く
 * - 見出し行の上固定を効かせたい場合は、呼び出し側が className に `sheet-frame-fit` を渡す。
 *   与えない場合は縦はページ側がスクロールする
 * - 文字サイズは --sheet-font（sheet.css が --sheet-zoom を掛けて算出）を1か所で当て、
 *   セルは継承する＝倍率切替が表全体に一度に効く
 */
export function SheetFrame({ children, className = '' }: SheetFrameProps) {
  const ref = useRef<HTMLDivElement>(null)
  const fit = className.split(/\s+/).includes(FIT_CLASS)

  // ZoomBar を置かない画面でも保存済み倍率で表示されるようにする（冪等）
  useEffect(() => {
    applyZoom(readZoom())
  }, [])

  /**
   * 高さ上限（sheet.css の .sheet-frame-fit）に使う実測値を書き戻す。
   * 上に積まれる UI の高さは画面ごと・文字サイズごと・折り返しごとに違うため、
   * 定数（旧 --sheet-chrome: 12rem）では食事一覧のように操作バーが高い画面で
   * 枠が画面外へはみ出し、上固定の見出しごと流れてしまう。
   * 描画前に確定させたいので useLayoutEffect で測る。
   */
  useLayoutEffect(() => {
    const el = ref.current
    if (!fit || el === null) return
    let raf = 0

    const write = (name: string, px: number) => {
      const next = `${Math.round(Math.max(0, px))}px`
      // 同じ値なら書かない（再レイアウト → 再観測の往復を止める）
      if (el.style.getPropertyValue(name) !== next) el.style.setProperty(name, next)
    }
    const measure = () => {
      raf = 0
      // ページ最上部を基準にした枠の上端（今のスクロール量に左右されない）
      write('--sheet-frame-top', el.getBoundingClientRect().top + window.scrollY)
      write('--sheet-frame-below', spaceBelow(el))
    }
    const schedule = () => {
      if (raf === 0) raf = window.requestAnimationFrame(measure)
    }

    measure()
    // 上下に積まれる UI は、文字サイズ・折り返し・案内帯の出入りで高さが変わる。
    // ResizeObserver が無い環境でも表示は成立させる（初回の実測＋画面回転・リサイズだけで追う）
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    ro?.observe(document.body)
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)
    return () => {
      if (raf !== 0) window.cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
      // 変数を残さない（次に開く画面の暫定値を汚さない）
      el.style.removeProperty('--sheet-frame-top')
      el.style.removeProperty('--sheet-frame-below')
    }
  }, [fit])

  return (
    <div
      ref={ref}
      role="region"
      aria-label="シート表（横にスクロールできます）"
      tabIndex={0}
      className={`w-full overflow-auto overscroll-x-contain ${className}`}
      style={{ fontSize: 'var(--sheet-font)' }}
    >
      {children}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// ZoomBar
// ══════════════════════════════════════════════════════════════

/**
 * 表示倍率の切替（100/125/150%）。
 * 選択中は 枠色＋太字＋「✓」の3点で示す（色だけに頼らない・SegmentPicker と同じ作法）。
 * ヘッダの1要素として並ぶため、幅を伸ばさない（flex-1 にしない）。
 */
/**
 * compact=true で「倍率」の文字を省く（2026-08-29）。
 * 一覧の操作バーを1行に収めるため。ボタン自体が「100%」と書いてあるので意味は伝わり、
 * 読み上げには role=group の aria-label「表示倍率」が残る。
 */
export function ZoomBar({ compact = false }: { compact?: boolean } = {}) {
  const [zoom, setZoom] = useState<Zoom>(readZoom)

  useEffect(() => {
    applyZoom(zoom)
  }, [zoom])

  const pick = useCallback((z: Zoom) => {
    setZoom(z)
    writeZoom(z)
  }, [])

  return (
    <div role="group" aria-label="表示倍率" className="flex items-center gap-gap">
      {compact ? null : (
        <span aria-hidden="true" className="text-sm text-ink2">
          倍率
        </span>
      )}
      {ZOOM_STEPS.map((z) => {
        const selected = z === zoom
        // 200% は行の高さが 44px になり、詰まった行でも指で押し分けられる（介護現場要件）。
        // 読み上げと押した時の意味が分かるよう、倍率だけでなく用途もラベルに入れる
        const label = z === 200 ? `${z}%（手袋でも押しやすい大きさ）` : `${z}%`
        return (
          <button
            key={z}
            type="button"
            aria-pressed={selected}
            aria-label={`表示倍率 ${label}`}
            title={z === 200 ? '行が高くなり、手袋でも押し分けやすくなります' : undefined}
            onClick={() => pick(z)}
            className={
              selected
                ? 'tabular min-h-tap min-w-tap rounded border border-primary bg-primary px-2 text-sm font-bold text-primary-ink'
                : 'tabular min-h-tap min-w-tap rounded border border-border bg-surface px-2 text-sm text-ink'
            }
          >
            <span aria-hidden="true" className={selected ? '' : 'invisible'}>
              ✓
            </span>
            {z}%
          </button>
        )
      })}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// SheetCell
// ══════════════════════════════════════════════════════════════

export type SheetAlign = 'left' | 'center' | 'right'

/**
 * セルの調子。
 * - plain: 既定（面の色＝--c-surface を自分で持つ）
 * - row: 背景を持たない。**行の色（NoteColor）を敷いた行の中で使う**
 *   （plain のままだと不透明な bg-surface が行の色を塗り潰し、幅の広い本文セルだけ
 *    白く抜ける。sheet-contracts.md §5 の行の色の再現が成立しないため）
 * - head: 見出し帯（薄灰＋太字）
 * - morning / noon / evening: スプシの朝＝赤系・昼＝緑系・夕＝黒（色は補助。区別は列見出しが持つ）
 * - muted: 補助・参考値
 * - low: 低摂取（淡い背景＋「▲」を自動併記）
 */
export type SheetTone = 'plain' | 'row' | 'head' | 'morning' | 'noon' | 'evening' | 'muted' | 'low'

const TONE_CLASS: Record<SheetTone, string> = {
  plain: 'bg-surface text-ink',
  row: 'text-ink',
  head: 'bg-surface2 text-ink2 font-bold',
  morning: 'bg-surface text-danger',
  noon: 'bg-surface text-ok',
  evening: 'bg-surface text-ink',
  muted: 'bg-surface text-ink3',
  low: 'bg-warn-bg text-warn font-bold',
}

// しきい値の見た目（ui.tsx の LevelCell と同じ体系。ui.tsx は変更禁止のため文字列だけ揃える）
const LEVEL_CLASS: Record<Exclude<Level, null>, string> = {
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

const ALIGN_CLASS: Record<SheetAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
}

/**
 * 縦の当たり判定の拡張は sheet.css の .sheet-hit に一本化する（拡張量＝--sheet-hit-pad）。
 * 拡張は **下方向だけ**（行高 22px ＋ 拡張 22px ＝ 44px）。上へ広げると、
 * ツリー順で前に来る行のヒットを奪って「見えている行を押すと1つ上の行が反応する」ため
 * （sheet.css 冒頭の裁定3）。下方向だけなら、後に来る位置指定要素が必ず上に描かれる＝
 * 次の行のセルが自分の箱で拡張を上書きするので、押した行がそのまま反応する。
 * そのため **実効 44px になるのは下に操作対象が無い場所**（表・ブロックの最終行など）で、
 * 行が縦に詰まっている部分は行高のまま（22px ピッチの全行に 44px を配ると必ず隣から奪う）。
 * 詰まっている部分の操作しやすさは ZoomBar（125/150%）と aria-label で担保する
 * （sheet-contracts §4「行が詰まっていて広げられない場合」の分岐）。
 */
const CELL_HIT = 'sheet-hit'

export interface SheetCellProps {
  /** 表示する文字列。null / '' は未入力 */
  value: string | null
  /** 渡すと編集可能になる（省略＝読み取り専用。入力封鎖中は渡さない） */
  onCommit?: (value: string) => void
  align?: SheetAlign
  /** 列幅。sheet.css の変数を渡す（例: 'var(--w-room)'） */
  width?: string
  /** しきい値。渡すと LEVEL_MARK の記号と色を自動で併記する */
  level?: Level
  tone?: SheetTone
  /** 未入力時に薄く出す見本文字（実名・記録本文を書かない） */
  placeholder?: string
  /** 複数行。長文は行が伸びる（clamp しない） */
  multiline?: boolean
  /** 読み上げ用の名前（列名＋対象など。title 属性は使わない） */
  ariaLabel: string
  /** 置き場所。既定は表のセル。表以外（ブロック内の行）では 'div' を渡す */
  as?: 'td' | 'div'
  /**
   * 日付グループの最後の列に true を渡す。右罫線を濃い色（--c-border-strong）にして
   * 日の切れ目を1本の線で示す（sheet.css の .sheet-group-end）。
   * 最初の列に左罫線を足す方式は、左隣のセルの右罫線と並んで 2px になるため使わない。
   */
  groupEnd?: boolean
}

/**
 * スプシ風セル。
 * - セル自体がボタン（クリック / Enter・Space で編集開始）
 * - 編集中は input / textarea をその場に描画。Enter・Tab で確定、Esc で取消
 *   （multiline の改行は Shift+Enter。フォーカスが外れた時も確定＝入力を捨てない）
 * - 値が変わっていない時は onCommit を呼ばない（読み取り経路から書き込まない）
 */
export function SheetCell({
  value,
  onCommit,
  align = 'left',
  width,
  level = null,
  tone = 'plain',
  placeholder,
  multiline = false,
  ariaLabel,
  as = 'td',
  groupEnd = false,
}: SheetCellProps) {
  const text = value ?? ''
  const editable = typeof onCommit === 'function'
  const [editing, setEditing] = useState(false)
  const isEditing = editing && editable
  const [draft, setDraft] = useState('')
  const btnRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const refocusRef = useRef(false)
  const skipBlurRef = useRef(false)

  /** textarea を内容の高さに合わせる（長文は行が伸びる） */
  const autoGrow = useCallback(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  // 編集開始時にフォーカスし、カーソルは末尾へ置く（全選択にしない＝誤って全消しさせない）
  useLayoutEffect(() => {
    if (!isEditing) return
    const el = areaRef.current ?? inputRef.current
    if (!el) return
    el.focus()
    const n = el.value.length
    try {
      el.setSelectionRange(n, n)
    } catch {
      // 一部の入力型では選択範囲を扱えない。フォーカスだけで続行する
    }
    autoGrow()
  }, [isEditing, autoGrow])

  // 編集中に入力封鎖へ切り替わった（onCommit が外れた）場合は編集状態を残さない
  useEffect(() => {
    if (!editable) setEditing(false)
  }, [editable])

  // 確定・取消でセルへフォーカスを戻す（Tab で抜けた時は戻さない）
  useEffect(() => {
    if (isEditing) return
    if (!refocusRef.current) return
    refocusRef.current = false
    btnRef.current?.focus()
  }, [isEditing])

  const start = useCallback(() => {
    if (!editable) return
    skipBlurRef.current = false
    setDraft(text)
    setEditing(true)
  }, [editable, text])

  const finish = useCallback(
    (commit: boolean, refocus: boolean) => {
      skipBlurRef.current = true
      refocusRef.current = refocus
      setEditing(false)
      if (commit && draft !== text) onCommit?.(draft)
    },
    [draft, text, onCommit],
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(false, true)
        return
      }
      if (e.key === 'Enter') {
        if (multiline && e.shiftKey) return // 改行はそのまま通す
        e.preventDefault()
        finish(true, true)
      }
      // Tab は既定動作のまま通す。確定は onBlur が受け持つ（フォーカス移動を妨げない）
    },
    [finish, multiline],
  )

  const onBlur = useCallback(() => {
    if (skipBlurRef.current) {
      skipBlurRef.current = false
      return
    }
    finish(true, false)
  }, [finish])

  // 幅は列ごとに固定する（スプシと同じ＝内容で列が動かない）
  const wrapStyle: CSSProperties = width ? { width, minWidth: width, maxWidth: width } : {}
  const innerStyle: CSSProperties = {
    minHeight: multiline ? 'var(--sheet-row-h-note)' : 'var(--sheet-row-h)',
  }

  // 記号（色だけで意味を伝えない）。読み上げ用の語も同じ順で組み立てる
  const marks: string[] = []
  if (tone === 'low') marks.push('低摂取')
  if (level) marks.push(LEVEL_TEXT[level])
  const markWord = marks.length > 0 ? `（${marks.join('・')}）` : ''
  const label = text === '' ? `${ariaLabel}（未入力）` : `${ariaLabel}: ${text}${markWord}`

  const look = level ? LEVEL_CLASS[level] : TONE_CLASS[tone]
  const flow = multiline ? 'whitespace-pre-wrap break-words' : 'truncate'

  /**
   * 読み取り専用で空のセルに補う名前。
   * div の入れ物（role を持たない＝role=generic）には aria-label が効かないため、
   * div 経路では文字（sr-only）として持たせる。td 経路は role=cell が名前付けを受けるので
   * 入れ物側の aria-label（wrapLabel）に載せる。
   */
  const srName = !editable && text === '' ? label : null

  const content =
    text === '' ? (
      placeholder ? (
        <>
          <span className="text-ink3">{placeholder}</span>
          {as === 'div' && srName ? <span className="sr-only">{srName}</span> : null}
        </>
      ) : (
        <span className="sr-only">{as === 'div' && srName ? srName : '未入力'}</span>
      )
    ) : (
      <>
        {/* 記号は sheet-mark（数字用フォント＝矢印が半角幅・0.85em）で描く。
            和文フォントのままだと全角幅になり、狭い列（脈 50px・体温 60px）で
            truncate に食われて「色だけ」の表示になるため（sheet.css .sheet-mark の実測根拠） */}
        {tone === 'low' ? (
          <span aria-hidden="true" className="sheet-mark">
            ▲
          </span>
        ) : null}
        {text}
        {level ? (
          <span aria-hidden="true" className="sheet-mark">
            {LEVEL_MARK[level]}
          </span>
        ) : null}
        {markWord ? <span className="sr-only">{markWord}</span> : null}
      </>
    )

  const inner = isEditing ? (
    multiline ? (
      <textarea
        ref={areaRef}
        value={draft}
        aria-label={ariaLabel}
        rows={1}
        onChange={(e) => {
          setDraft(e.target.value)
          autoGrow()
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        style={innerStyle}
        className={`block w-full resize-none overflow-hidden bg-surface px-1 text-ink ${ALIGN_CLASS[align]}`}
      />
    ) : (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        aria-label={ariaLabel}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        style={innerStyle}
        className={`block w-full bg-surface px-1 text-ink ${ALIGN_CLASS[align]}`}
      />
    )
  ) : editable ? (
    <button
      ref={btnRef}
      type="button"
      aria-label={label}
      onClick={start}
      style={innerStyle}
      className={`${CELL_HIT} block w-full px-1 ${ALIGN_CLASS[align]}`}
    >
      {/* truncate（overflow: hidden）はボタン自身に当てない。当てると .sheet-hit の
          当たり判定（::before）がボタンの外へはみ出した分ごと切り取られて広がらないため、
          内側の span に移して切り詰めだけを担当させる（見た目は同じ） */}
      <span className={`${flow} block`}>{content}</span>
    </button>
  ) : (
    <span style={innerStyle} className={`${flow} block w-full px-1 ${ALIGN_CLASS[align]}`}>
      {content}
    </span>
  )

  // 表の中（td）は sheet.css の .sheet-table が border-collapse: separate なので、
  // 罫線は右・下だけに引く（全周に引くと隣のセルの罫線と並んで 2px になる）。
  // 表の外（div の行）は**入れ物側（呼び出し元の Cell と Row）が罫線を持つ**ので、
  // ここでは引かない。引くと入れ物の罫線と 1px ずつ二重になり、
  // §1「罫線は 1px」の密度が崩れる（縦線が 2本・横線が 2px に見える）。
  const edge = as === 'td' ? 'border-b border-r border-border' : ''
  // relative: 入れ物を位置指定要素にして「後に来たセルが必ず上に描かれる」を保証する。
  // これで、1つ上の行のセルが下へ伸ばした当たり判定（.sheet-hit::before）が
  // このセル（読み取り専用の span でも）を覆えない＝行の取り違えが起きない
  const wrapClass = `${edge} ${groupEnd ? 'sheet-group-end' : ''} relative p-0 align-top ${look}`
  // 読み取り専用で空のセルは、列見出しだけでは何の欄か分からないので名前を補う
  // （値がある時は付けない＝aria-label で本文を隠さない）。
  // div 経路は aria-label が無視されるため、上の srName を文字として出している
  const wrapLabel = as === 'td' && srName !== null ? srName : undefined

  if (as === 'div') {
    return (
      <div style={wrapStyle} className={wrapClass} aria-label={wrapLabel}>
        {inner}
      </div>
    )
  }
  return (
    <td style={wrapStyle} className={wrapClass} aria-label={wrapLabel}>
      {inner}
    </td>
  )
}

// ══════════════════════════════════════════════════════════════
// ColorPicker
// ══════════════════════════════════════════════════════════════

/**
 * 行の色 → 淡色トークン（ダークモードでも読める色へトークン側で解決される）。
 * **この表が行の色の唯一の対応表**。行の背景（DailySheetPage）も見本（SWATCH_CLASS）も
 * ここに合わせる（割り当ては sheet.css の --sheet-c-* と同じ）。
 */
export const NOTE_COLOR_CLASS: Record<NoteColor, string> = {
  pink: 'bg-danger-bg',
  yellow: 'bg-warn-bg',
  blue: 'bg-info-bg',
  green: 'bg-ok-bg',
  orange: 'bg-accent-bg',
}

const SWATCH_CLASS: Record<NoteColor, string> = {
  pink: 'bg-danger-bg border-danger text-danger',
  yellow: 'bg-warn-bg border-warn text-warn',
  blue: 'bg-info-bg border-info text-info',
  green: 'bg-ok-bg border-ok text-ok',
  orange: 'bg-accent-bg border-accent text-accent',
}

/** 候補の並び。予定（ピンク）・全体連絡（黄）を先頭に置く（sheet-contracts.md §5） */
const COLOR_ORDER: NoteColor[] = ['pink', 'yellow', 'blue', 'green', 'orange']

/** 色だけに頼らないための1文字（NOTE_COLOR_LABEL の頭文字＝予/全/医/完/要） */
function colorMark(c: NoteColor): string {
  return NOTE_COLOR_LABEL[c].slice(0, 1)
}

export interface ColorPickerProps {
  value: NoteColor | null
  onChange: (value: NoteColor | null) => void
  ariaLabel: string
  /**
   * 入力封鎖中（native_input_enabled=false）・送信待ちの行では true を渡す。
   * 押せなくする＝同じ行の他のセルが編集不可なのに色だけ変えられる状態を作らない。
   */
  disabled?: boolean
}

/**
 * 一覧の位置決めに使うおおよその大きさ（見た目の幅は w-max のまま。画面端の丸めにだけ使う）。
 * 高さは「5色＋色なし」の6行 × 44px ＋ 余白の実測見込み。
 */
const PICKER_W = 200
const PICKER_H = 280
/** セルと一覧のすき間（4px グリッド） */
const PICKER_GAP = 4

/** 一覧を出す位置（画面座標。開くたびにトリガの実測から作り直す） */
interface PickerPos {
  left: number
  top?: number
  bottom?: number
}

/**
 * 行の色を選ぶ小さなボタン（押すと NoteColor ＋「色なし」のボタン群が開く）。
 * 見た目は行の高さに収める（当たり判定の拡張は sheet.css の裁定に従う＝表の中では広げない）。
 * 色の意味は頭文字（予/全/医/完/要）と一覧の名前で必ず併記する。
 * 一覧は position: fixed で描く。SheetFrame（overflow: auto）の中に置かれるため、
 * absolute のままだと枠の外側にはみ出した分が切り取られて「押しても何も出ない」ように見える。
 */
export function ColorPicker({ value, onChange, ariaLabel, disabled = false }: ColorPickerProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<PickerPos | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }, [])

  // 開いている間に編集不可へ変わったら閉じる（封鎖中に開きっぱなしにしない）
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  /** トリガの現在位置から一覧の位置を出す（下に入りきらない時は上へ回す） */
  const place = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const maxLeft = Math.max(PICKER_GAP, window.innerWidth - PICKER_W - PICKER_GAP)
    const left = Math.min(Math.max(PICKER_GAP, r.left), maxLeft)
    const openUp = r.bottom + PICKER_H > window.innerHeight && r.top > PICKER_H
    setPos(
      openUp
        ? { left, bottom: window.innerHeight - r.top + PICKER_GAP }
        : { left, top: r.bottom + PICKER_GAP },
    )
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    place()
  }, [open, place])

  // 位置が決まった（＝visibility: hidden が外れた）後で先頭項目へフォーカスする。
  // 位置決めと同じ描画で focus すると、まだ visibility: hidden の一覧に対して呼ぶことになり
  // ブラウザ仕様上フォーカスできず、キーボード・読み上げ利用者が一覧の中へ入れない。
  // 依存は「位置が決まったか」の真偽だけにする（pos そのものを見ると、
  // スクロール追従で作り直すたびに先頭へフォーカスが戻り、選択操作を奪ってしまう）。
  const positioned = pos !== null
  useEffect(() => {
    if (!open || !positioned) return
    listRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [open, positioned])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close(true)
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    // スクロール・画面回転でも閉じずに追従する（選びかけの操作を中断させない）
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, close, place])

  const currentName = value ? NOTE_COLOR_LABEL[value] : '色なし'
  const listStyle: CSSProperties = pos
    ? { position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom }
    : // 位置が決まるまでは見せない（一瞬だけ左上に出るのを防ぐ）
      { position: 'fixed', left: 0, top: 0, visibility: 'hidden' }

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={
          disabled ? `${ariaLabel}: ${currentName}（今は変更できません）` : `${ariaLabel}: ${currentName}`
        }
        onClick={() => setOpen((v) => !v)}
        style={{ minHeight: 'var(--sheet-row-h)' }}
        className={`${CELL_HIT} flex w-tap items-center justify-center disabled:opacity-60`}
      >
        <span
          aria-hidden="true"
          className={`inline-flex items-center justify-center rounded-sm border px-1 ${
            value ? SWATCH_CLASS[value] : 'border-border-strong bg-surface text-ink3'
          }`}
        >
          {value ? colorMark(value) : '—'}
        </span>
      </button>

      {open ? (
        <div
          ref={listRef}
          role="group"
          aria-label={ariaLabel}
          style={listStyle}
          className="z-30 w-max rounded-md border border-border-strong bg-surface p-2"
        >
          {COLOR_ORDER.map((c) => {
            const selected = c === value
            return (
              <button
                key={c}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  onChange(c)
                  close(true)
                }}
                className="flex min-h-tap w-full items-center gap-gap rounded px-2 text-left text-base text-ink"
              >
                <span
                  aria-hidden="true"
                  className={`inline-flex items-center justify-center rounded-sm border px-1 text-sm ${SWATCH_CLASS[c]}`}
                >
                  {colorMark(c)}
                </span>
                <span className="flex-1">{NOTE_COLOR_LABEL[c]}</span>
                <span aria-hidden="true" className={selected ? '' : 'invisible'}>
                  ✓
                </span>
              </button>
            )
          })}
          <button
            type="button"
            aria-pressed={value == null}
            onClick={() => {
              onChange(null)
              close(true)
            }}
            className="flex min-h-tap w-full items-center gap-gap rounded px-2 text-left text-base text-ink"
          >
            <span
              aria-hidden="true"
              className="inline-flex items-center justify-center rounded-sm border border-border-strong bg-surface px-1 text-sm text-ink3"
            >
              —
            </span>
            <span className="flex-1">色なし</span>
            <span aria-hidden="true" className={value == null ? '' : 'invisible'}>
              ✓
            </span>
          </button>
        </div>
      ) : null}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// CollapsibleBlock
// ══════════════════════════════════════════════════════════════

export interface CollapsibleBlockProps {
  title: string
  /**
   * 中身の件数。0 なら見出し1行に畳む（スペースを取らない）。
   * 「＋追加」で足した未保存の行も数に入れて渡す＝入力中のブロックが畳まれないようにする
   */
  count: number
  children: ReactNode
  /** 省略＝追加できない（入力封鎖中など） */
  onAdd?: () => void
  addLabel?: string
  defaultOpen?: boolean
}

/**
 * 0件のときは見出しだけの1行に畳むブロック。「＋追加」で行を増やす。
 * 見出し自体が開閉ボタン（aria-expanded）で、畳んだ状態でも件数が読める。
 * 件数が 0→1 に増えたら自動で開く（追加した行が隠れたままにならない）。
 */
export function CollapsibleBlock({
  title,
  count,
  children,
  onAdd,
  addLabel = '＋ 追加',
  defaultOpen,
}: CollapsibleBlockProps) {
  const [open, setOpen] = useState<boolean>(defaultOpen ?? count > 0)
  const bodyId = useId()
  // 見出しをブロックの名前にする（複数のブロックが並ぶので section 単体では区別できない）
  const titleId = `${bodyId}-title`
  const prevCount = useRef(count)

  useEffect(() => {
    // 増えた時だけ開く。0 に戻っても畳まない（記入途中に閉じないため）
    if (prevCount.current === 0 && count > 0) setOpen(true)
    prevCount.current = count
  }, [count])

  return (
    // relative: 直前のブロックの最終行が下へ伸ばした当たり判定（.sheet-hit::before）が
    // このブロックの見出しボタンに掛からないようにする（後に来た位置指定要素が上に描かれる）
    <section aria-labelledby={titleId} className="relative mb-2 rounded-md border border-border bg-surface">
      <div className={`flex flex-wrap items-center gap-gap px-2 ${open ? 'border-b border-border' : ''}`}>
        <button
          type="button"
          id={titleId}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-tap flex-1 items-center gap-gap text-left"
        >
          <span aria-hidden="true" className="text-ink2">
            {open ? '▾' : '▸'}
          </span>
          <span className="text-base font-bold text-ink">{title}</span>
          <span className="tabular text-sm text-ink2">{count}件</span>
        </button>
        {onAdd ? (
          <button
            type="button"
            // 見た目は「＋追加」のまま、読み上げ名にはブロック名を入れる
            // （同じ名前のボタンが画面に8つ並ぶと、どの行を足すボタンか区別できないため）
            aria-label={`${title}に1行追加`}
            onClick={() => {
              setOpen(true)
              onAdd()
            }}
            className="min-h-tap shrink-0 rounded border border-primary px-3 text-sm font-bold text-primary"
          >
            {addLabel}
          </button>
        ) : null}
      </div>
      <div id={bodyId} hidden={!open} className="p-2">
        {/* 空状態は「件数0かつ中身も無い」時だけ。中身がある（＋追加した未保存の行など）なら必ず出す
            ＝入力途中の行を空メッセージで隠さない */}
        {count === 0 && Children.count(children) === 0 ? (
          <p className="text-base text-ink2">
            {onAdd
              ? 'まだ登録がありません。「＋ 追加」を押すと行を足せます。'
              : 'まだ登録がありません。'}
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  )
}
