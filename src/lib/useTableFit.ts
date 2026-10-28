// デイの一括の表（バイタル一括・活動一括・機能訓練・食事一括）の枠に高さの上限を付けるための実測（2026-10-28 代表者の依頼）。
// 枠の中で縦にも送るので、見出しの行が枠の上に・氏名の列が左に残り、下の行だけが送られる。
// 上限は「画面の高さ − 上に貼り付く部品（アプリの見出し）− 下に貼り付く部品（下部タブ・バイタルのテンキー）」:
//   --dc-fit-top   … 上に貼り付く部品の高さ
//   --dc-fit-below … 下に貼り付く部品の高さ＋少しの余白
// を枠に書き戻し、index.css の .dc-table-fit が上限にする。ページを送って枠の上端がアプリの見出しの下に来た所で、
// 枠が画面の残りにちょうど収まる（枠の上に表の前の部品が多い画面でも、枠が小さくならない）。
// care-log のシートの枠（sheet.css の .sheet-frame-fit）は「ページの最上部から枠まで」を引くので、表の上に部品が多い
// デイの画面（機能訓練の配置・計画書、狭い画面の見出し）では枠が下限まで縮んだ（2026-10-28 試験用 DB の画面で実測）ため、使わない

import { useLayoutEffect } from 'react'

/** 枠の下と画面の下端の間に空ける余白（px） */
const FIT_GAP = 8
/** 枠の高さの下限（rem・index.css の .dc-table-fit の max(10rem, …) と同じ） */
const FIT_MIN_REM = 10

/** 上に貼り付く部品（sticky・fixed の header）の高さ */
function topCover(): number {
  let h = 0
  for (const el of document.querySelectorAll<HTMLElement>('header')) {
    const cs = window.getComputedStyle(el)
    if (cs.display === 'none' || (cs.position !== 'sticky' && cs.position !== 'fixed')) continue
    h = Math.max(h, el.getBoundingClientRect().height)
  }
  return h
}

/**
 * 枠より後ろの流れの高さ（px）。「枠の後ろに続く兄弟の高さ」＋「祖先の下余白・下罫線」を body まで足し上げる
 * （sheet.tsx の spaceBelow と同じ考え・枠自身の高さに左右されない）。バイタルのテンキーの分の空きの div もここに入る
 */
function flowAfter(el: HTMLElement): number {
  const num = (v: string): number => Number.parseFloat(v) || 0
  let total = 0
  let node: HTMLElement = el
  while (node.parentElement !== null) {
    total += num(window.getComputedStyle(node).marginBottom)
    for (let s = node.nextElementSibling; s !== null; s = s.nextElementSibling) {
      if (!(s instanceof HTMLElement)) continue
      const cs = window.getComputedStyle(s)
      if (cs.display === 'none' || cs.position === 'fixed' || cs.position === 'absolute') continue
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

/** 下に貼り付く部品（画面の下端に付いた fixed の nav＝狭い画面の下部タブ）の高さ */
function bottomCover(): number {
  let h = 0
  for (const el of document.querySelectorAll<HTMLElement>('nav')) {
    const cs = window.getComputedStyle(el)
    if (cs.display === 'none' || cs.position !== 'fixed') continue
    const r = el.getBoundingClientRect()
    if (r.height > 0 && r.bottom >= window.innerHeight - 1 && r.top > window.innerHeight / 2) h = Math.max(h, r.height)
  }
  return h
}

/**
 * 表の枠（.dc-table-fit を付けた要素）に、高さの上限の計算に使う実測値を書き戻す。el が無い間は何もしない。
 * extraBelow は画面が自分で置く、下に貼り付く部品の高さ（バイタル一括のテンキー）
 */
export function useTableFit(el: HTMLElement | null, extraBelow = 0): void {
  useLayoutEffect(() => {
    if (el === null) return
    let raf = 0
    const write = (name: string, px: number) => {
      const next = `${Math.round(Math.max(0, px))}px`
      // 同じ値なら書かない（再レイアウト → 再観測の往復を止める）
      if (el.style.getPropertyValue(name) !== next) el.style.setProperty(name, next)
    }
    const measure = () => {
      raf = 0
      // 枠の後ろの流れ（外枠・main の下の余白・テンキーの分の空き・後ろの区画）も引く。引かないと、ページを一番下まで送った時に
      // 枠の上端がアプリの見出しの下に入り、見出しの行が隠れる（2026-10-28 反証 重1）。ただし引くと枠が下限より小さくなる時
      // （後ろに大きな区画が続く画面）は引かない（その区画を見る時に表が上へ送られるのは普通のページ送り）。テンキーが開いている間
      // （extraBelow > 0）は枠が小さくなるのは避けられないので、いつも引く（下限は CSS の max(10rem, …) が守る）
      const top = topCover()
      const fixed = bottomCover() + extraBelow + FIT_GAP
      const want = Math.max(fixed, flowAfter(el) + FIT_GAP)
      const minFrame = FIT_MIN_REM * (Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16)
      write('--dc-fit-top', top)
      write('--dc-fit-below', extraBelow > 0 || window.innerHeight - top - want >= minFrame ? want : fixed)
    }
    const schedule = () => {
      if (raf === 0) raf = window.requestAnimationFrame(measure)
    }
    measure()
    // 見出し・下部タブは、文字の大きさ・画面の幅（下部タブは広い画面で消える）・回転で高さが変わる
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    ro?.observe(document.body)
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)
    return () => {
      if (raf !== 0) window.cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
      el.style.removeProperty('--dc-fit-top')
      el.style.removeProperty('--dc-fit-below')
    }
  }, [el, extraBelow])
}
