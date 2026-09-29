// 画面上部の操作バーを畳む器（日報・バイタル一覧・食事一覧の共通・2026-09-29 本人指示「上部の操作を畳む作りも進めて」
// 「バイタル・食事一覧も畳む作りにして進めて」・チーフ裁定）。
// - 畳めるのは、狭い画面（480px 以下）か、操作が1行に収まらない時だけ。広い画面で1行に収まる時は今のまま全部を出し、
//   開閉のボタンも出さない（見た目を変えない）
// - 畳んだ形は各画面が決めた「いちばん使う操作」だけの1行＋開閉のボタン。それでも1行に収まらない時は、画面の短い形
//   （compact：文字を短く・余白を詰め・間隔は 4px（文字の大きさに付いて広げない）。押す大きさ 44px は保つ）に切り替える。開いた形は今の操作の並びのまま＋開閉のボタン
// - 1行に収まるかは、操作を1行に並べた見えない写しの幅で測る（開閉の状態に左右されない）
// - 開閉のボタンは畳んだ形・開いた形で同じ位置の同じボタン（押した後もフォーカスがそのボタンに残る）。
//   aria-expanded・aria-controls（開いた形の操作）で示し、文字と記号（▾ ▴）でも示す。高さ・幅は 44px 以上
// - 開閉の状態は画面ごとの localStorage のキーに '1'／'0' で持つ（原則11・端末ごとの UI 状態・既知値だけ読む）。
//   未設定・壊れた値は既定（狭い画面は畳む・広い画面は開く）
// - 印刷では畳まない（beforeprint で畳まない形に描き直す＝紙は今までと同じ）
// - persistent（保存状況など、データ保全に関わる表示）は畳んでも隠さない。畳めない時は今と同じく操作の行の中に置く
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { ReactNode } from 'react'

/** 開閉の保存を既知値で読む（'1'＝開いた形・'0'＝畳んだ形・それ以外と未設定は null） */
export function readBarOpen(key: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === '1' ? true : raw === '0' ? false : null
  } catch {
    return null
  }
}

function writeBarOpen(key: string, open: boolean): void {
  try {
    window.localStorage.setItem(key, open ? '1' : '0')
  } catch {
    // 保存できなくても当セッションの開閉は効く
  }
}

const NARROW_QUERY = '(max-width: 480px)'

export interface CollapsibleBarProps {
  /** 開閉を保存する localStorage のキー（画面ごとに別） */
  storageKey: string
  /** 開いた形＝今の操作の並び。extra は操作の行の末尾に入れてほしい表示（persistent・畳めない時だけ渡る） */
  full: (extra: ReactNode) => ReactNode
  /** 畳んだ形（1行）。compact=true は、それでも1行に収まらない時の短い形 */
  collapsed: (compact: boolean) => ReactNode
  /** 畳んでも隠さない表示（保存状況など）。畳めない時は full の extra として操作の行の中へ */
  persistent?: ReactNode
  /** 開閉のボタンの読み上げ（例「表示と倍率の操作を開く」「…を畳む」） */
  openLabel: string
  closeLabel: string
}

export function CollapsibleBar({ storageKey, full, collapsed, persistent, openLabel, closeLabel }: CollapsibleBarProps) {
  const uid = useId()
  const fullId = `${uid}-bar`
  const boxRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_QUERY).matches : false,
  )
  const [wraps, setWraps] = useState(false)
  const [compact, setCompact] = useState(false)
  const [stored, setStored] = useState<boolean | null>(() => readBarOpen(storageKey))
  /** 印刷中（印刷では畳まない＝今までと同じ紙にする） */
  const [printing, setPrinting] = useState(false)

  // 印刷の直前に畳まない形へ描き直す（印刷の割り付けより先に反映させるため同期で描く）
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true))
    const after = () => setPrinting(false)
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(NARROW_QUERY)
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  // 操作を1行に並べた時の幅が、置ける幅より広いか（文字の大きさ・画面の幅・表示中の値で変わる）。
  // 幅が変わった時は短い形をいったん解いて測り直す（広くなったら元の形へ戻す）
  useLayoutEffect(() => {
    const box = boxRef.current
    const m = measureRef.current
    if (box === null || m === null) return
    let lastBox = -1
    let lastMeasure = -1
    const measure = () => {
      setWraps(m.scrollWidth > box.clientWidth + 1)
      if (box.clientWidth !== lastBox || m.scrollWidth !== lastMeasure) {
        lastBox = box.clientWidth
        lastMeasure = m.scrollWidth
        setCompact(false)
      }
    }
    measure()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    ro?.observe(box)
    ro?.observe(m)
    return () => ro?.disconnect()
  }, [])

  const collapsible = !printing && (narrow || wraps)
  // 既定（利用者がまだ開閉していない時）は、狭い画面だけ畳んで始める。広い画面は操作が折り返していても開いて始める
  // （MacBook などで今の見た目を変えない・2026-09-29 チーフ裁定）。開閉した後は保存した状態を優先する
  const open = !collapsible ? true : stored === null ? !narrow : stored

  // 畳んだ形が1行に収まらない（開閉のボタンが次の行へ回った）時は、短い形にする
  useLayoutEffect(() => {
    if (!collapsible || open || compact) return
    const row = rowRef.current
    const t = toggleRef.current
    const first = row?.firstElementChild
    if (!row || !t || !(first instanceof HTMLElement) || first === t) return
    if (t.getBoundingClientRect().top >= first.getBoundingClientRect().bottom - 4) setCompact(true)
  })

  const toggle = useCallback(() => {
    const next = !open
    setStored(next)
    writeBarOpen(storageKey, next)
  }, [open, storageKey])

  return (
    <div ref={boxRef} className="relative">
      {collapsible ? (
        <>
          {/* 開閉のボタンは両方の形で同じ位置の同じボタン＝押した後もフォーカスが残る。収まらない時は次の行へ回る（重ねない） */}
          <div ref={rowRef} className={`flex flex-wrap items-start ${compact ? 'gap-[4px]' : 'gap-gap'}`}>
            {open ? null : (
              <div className={`flex min-w-0 flex-nowrap items-center ${compact ? 'gap-[4px]' : 'gap-gap'}`}>{collapsed(compact)}</div>
            )}
            <div id={fullId} hidden={!open} className={open ? 'min-w-0 flex-1' : undefined}>
              {/* 開いている時は、畳まない時と同じく操作の行の中に置く（今の見た目のまま） */}
              {full(open ? (persistent ?? null) : null)}
            </div>
            <button
              ref={toggleRef}
              type="button"
              aria-expanded={open}
              aria-controls={fullId}
              // 見える文字は短く、読み上げでは何を開閉するかまで伝える
              aria-label={open ? closeLabel : openLabel}
              onClick={toggle}
              className={`collapse-bar-toggle ml-auto min-h-tap min-w-tap shrink-0 rounded-md border border-border-strong bg-surface text-base text-ink ${compact && !open ? 'px-1' : 'px-3'}`}
            >
              {open ? (
                <>
                  畳む<span aria-hidden="true"> ▴</span>
                </>
              ) : (
                <>
                  表示<span aria-hidden="true"> ▾</span>
                </>
              )}
            </button>
          </div>
          {open ? null : (persistent ?? null)}
        </>
      ) : (
        <div id={fullId}>{full(persistent ?? null)}</div>
      )}
      {/* 1行に収まるかを測るための写し（見えない・読み上げない・押せない・高さを取らない） */}
      <div ref={measureRef} aria-hidden="true" className="collapse-bar-measure">
        {full(persistent ?? null)}
      </div>
    </div>
  )
}
