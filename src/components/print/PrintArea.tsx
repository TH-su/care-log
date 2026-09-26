// 印刷の小さな部品（2026-09-26 追加。care-log に印刷の仕組みが無かったため、再利用できる形で作る）。
//
// 使い方:
//   const printRef = useRef<PrintAreaHandle>(null)
//   <PrintButton target={printRef} />                 … 画面の操作部に置くボタン（44px）
//   <PrintArea ref={printRef}>…紙に出す中身…</PrintArea> … 画面には出ない。印刷の時だけ紙に出る
//
// 印刷の流れ（ボタンでも Ctrl+P / ⌘P でも同じ）:
//   1. html に data-cl-print を付ける（print.css がこの間の印刷だけ中身以外を隠す＝画面の操作部を紙に出さない）
//   2. @page { size: A4 landscape; margin: 8mm } の <style> を差し込む（この印刷の間だけ）
//   3. 中身を印刷と同じ幅（281mm）で見えないように組み、1枚に収まる文字の大きさを探す（最大 maxFontPx → 最小 7px）
//   4. 印刷が終わったら（afterprint）1・2 を外す
// 用紙は A4。向きの既定は横（orientation="portrait" で縦・2026-09-26 与薬の月次表で追加）。
// paged を付けると、中身の .cl-print-page を1枚ずつ改ページして刷る（全員を1人1ページで刷る時用）。
// その時の文字の大きさは「どのページも1枚に収まる大きさ」を探す（既定の1枚に収める動きは変えない）。
//
// 規律: 中身はこの部品の外（呼ぶ画面）が決める。ここは組み方と用紙だけを持つ。console に何も出さない。

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import './print.css'

/** 1枚に収めるために縮める文字の下限（px）。これより小さくは縮めない（読めなくなるため） */
export const PRINT_MIN_FONT_PX = 7
/** 文字の大きさの既定の上限（px） */
const PRINT_MAX_FONT_PX = 12
/** 探す刻み（px） */
const FONT_STEP_PX = 0.5
/** 印刷できる範囲（A4 横 297×210mm から余白 8mm を上下左右に引いた大きさ）。縦はこの幅と高さを入れ替える */
const PRINTABLE_W_MM = 281
const PRINTABLE_H_MM = 194
/** 端数・ブラウザごとの丸めの差で2枚目に1行だけ溢れないよう、高さに少し余裕を見る */
const FIT_SAFETY = 0.97

const PAGE_STYLE_ID = 'cl-print-page'
const PRINT_ATTR = 'data-cl-print'
/** 用紙の向き。横＝既定（入浴の月次表）、縦＝与薬の月次表 */
export type PrintOrientation = 'landscape' | 'portrait'

function pageCss(orientation: PrintOrientation): string {
  return `@page { size: A4 ${orientation}; margin: 8mm; }`
}

export interface PrintAreaHandle {
  /** 用紙と文字の大きさを整えてから印刷する */
  print(): void
}

export interface PrintAreaProps {
  children: ReactNode
  /** 文字の大きさの上限（px）。既定 12 */
  maxFontPx?: number
  /** 文字の大きさの下限（px）。既定 7（これより小さくはしない） */
  minFontPx?: number
  /** 用紙の向き（既定 'landscape'＝横） */
  orientation?: PrintOrientation
  /** 中身の .cl-print-page を1ページずつ刷る（既定 false＝全体を1枚に収める） */
  paged?: boolean
}

/** 1mm が何 px か（画面の CSS px。印刷も CSS px で組むので同じ値になる） */
function pxPerMm(): number {
  const probe = document.createElement('div')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.width = '100mm'
  document.body.appendChild(probe)
  const w = probe.getBoundingClientRect().width
  probe.remove()
  return w > 0 ? w / 100 : 96 / 25.4
}

/**
 * 1枚に収まる文字の大きさを探し、--cl-print-font に書き込む。
 * paged の時は .cl-print-page のどれもが1枚に収まる大きさ（ページが無ければ全体で測る）
 */
function fitToPage(area: HTMLElement, maxPx: number, minPx: number, orientation: PrintOrientation, paged: boolean): void {
  const mm = pxPerMm()
  const portrait = orientation === 'portrait'
  const availW = (portrait ? PRINTABLE_H_MM : PRINTABLE_W_MM) * mm
  const availH = (portrait ? PRINTABLE_W_MM : PRINTABLE_H_MM) * mm * FIT_SAFETY
  area.setAttribute('data-cl-measure', '')
  area.setAttribute('data-cl-orient', orientation)
  const fits = (): boolean => {
    const pages = paged ? Array.from(area.querySelectorAll<HTMLElement>('.cl-print-page')) : []
    if (pages.length === 0) return area.scrollWidth <= availW + 0.5 && area.scrollHeight <= availH
    return pages.every((pg) => pg.scrollWidth <= availW + 0.5 && pg.scrollHeight <= availH)
  }
  try {
    let size = maxPx
    for (; size > minPx; size -= FONT_STEP_PX) {
      area.style.setProperty('--cl-print-font', `${size}px`)
      if (fits()) break
    }
    area.style.setProperty('--cl-print-font', `${Math.max(size, minPx)}px`)
  } finally {
    area.removeAttribute('data-cl-measure')
  }
}

function injectPageStyle(orientation: PrintOrientation): void {
  // 向きの違う印刷が続いた時に前の向きが残らないよう、毎回差し替える
  document.getElementById(PAGE_STYLE_ID)?.remove()
  const style = document.createElement('style')
  style.id = PAGE_STYLE_ID
  style.textContent = pageCss(orientation)
  document.head.appendChild(style)
}

function cleanupPrint(): void {
  document.documentElement.removeAttribute(PRINT_ATTR)
  document.getElementById(PAGE_STYLE_ID)?.remove()
}

export const PrintArea = forwardRef<PrintAreaHandle, PrintAreaProps>(function PrintArea(
  { children, maxFontPx = PRINT_MAX_FONT_PX, minFontPx = PRINT_MIN_FONT_PX, orientation = 'landscape', paged = false },
  ref,
) {
  // 印刷する中身の置き場（body の直下）。画面の操作部とは別の木に置くので、印刷の時に中身以外を丸ごと隠せる
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const limits = useRef({ maxFontPx, minFontPx, orientation, paged })
  limits.current = { maxFontPx, minFontPx: Math.max(PRINT_MIN_FONT_PX, minFontPx), orientation, paged }

  useEffect(() => {
    const el = document.createElement('div')
    el.className = 'cl-print-area'
    document.body.appendChild(el)
    setHost(el)
    return () => {
      el.remove()
      cleanupPrint()
    }
  }, [])

  const prepare = useCallback(() => {
    if (host === null) return
    document.documentElement.setAttribute(PRINT_ATTR, '')
    const l = limits.current
    injectPageStyle(l.orientation)
    fitToPage(host, l.maxFontPx, l.minFontPx, l.orientation, l.paged)
  }, [host])

  // Ctrl+P / ⌘P で印刷した時も同じ用紙・文字の大きさにする。印刷が終わったら元に戻す
  useEffect(() => {
    if (host === null) return
    const before = () => prepare()
    const after = () => cleanupPrint()
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [host, prepare])

  useImperativeHandle(
    ref,
    () => ({
      print() {
        prepare()
        window.print()
      },
    }),
    [prepare],
  )

  return host === null ? null : createPortal(children, host)
})

export interface PrintButtonProps {
  target: RefObject<PrintAreaHandle>
  label?: string
  disabled?: boolean
}

/** 印刷ボタン（44px・文字併記）。押すと target の PrintArea を印刷する */
export function PrintButton({ target, label = '印刷する', disabled = false }: PrintButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => target.current?.print()}
      className="inline-flex min-h-tap items-center rounded border border-primary bg-surface px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
    >
      {label}
    </button>
  )
}
