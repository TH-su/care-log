// デイの連絡帳の紙（A5 縦・1人1枚・2026-11-09 計画C）。連絡帳の画面（DaycareContactPage）の見本と印刷で同じ部品を使う。
//
// 使い方（DaycareContactPage）:
//   <ContactSheetView sheet={…} />                          … 紙面（画面の見本は .dcc-preview の枠の中に置く）
//   <DaycareContactPrint ref={printRef} sheets={選んだ方} /> … 画面には出ない。印刷の時だけ紙に出る（1人1枚）
//   printRef.current?.print()                               … 用紙と文字の大きさを整えてから印刷する
//
// 印刷の流れ（ボタンでも Ctrl+P / ⌘P でも同じ・PrintArea と同じ作り。PrintArea は A4 だけなので使わず、変えない）:
//   1. html に data-dcc-print を付ける（daycareContact.css がこの間の印刷だけ中身以外を隠す＝画面の部品を紙に出さない）
//   2. @page { size: A5; margin: 8mm; } の <style> を差し込む（この印刷の間だけ。ほかの画面の印刷の用紙を変えない）
//   3. 紙面を印刷と同じ幅（132mm）で見えないように組み、1人ずつ1枚に収まる文字の大きさを探す（最大 15px＝約11pt → 最小 10px）。
//      zoom・transform で縮めない
//   4. 印刷が終わったら（afterprint）1・2 を外す
// 中身（言葉・記録なし・基準外の判定）は src/lib/daycareContact.ts（純関数・試験あり）。ここは描くだけ。写真の欄は持たない。
// console に何も出さない。氏名は紙に出すだけで保存しない。

import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react'
import { createPortal } from 'react-dom'
import { RECHECK_NOTE, UNREAD, nurseSectionShown, staffSectionShown } from '../../lib/daycareContact'
import type { ContactSheet } from '../../lib/daycareContact'
import './print.css'
import './daycareContact.css'

/** 用紙（A5 縦・余白 8mm）。印刷の直前だけ差し込む */
export const CONTACT_PAGE_CSS = '@page { size: A5; margin: 8mm; }'
/** 本文の文字の大きさの上限（px）＝0.9375rem（約11pt） */
export const CONTACT_FONT_MAX_PX = 15
/** 1枚に収めるために縮める下限（px）。ひと言を上限まで使っても、この大きさで1枚に収まる版面にしてある */
export const CONTACT_FONT_MIN_PX = 10
const FONT_STEP_PX = 0.5
/** 印刷できる高さ（A5 縦 210mm − 上下の余白 8mm×2） */
const PRINTABLE_H_MM = 194
/** 端数・ブラウザごとの丸めの差で2枚目に1行だけ溢れないよう、高さに少し余裕を見る（PrintArea と同じ） */
const FIT_SAFETY = 0.97
const PAGE_STYLE_ID = 'dcc-print-page'
const PRINT_ATTR = 'data-dcc-print'

/** 1人の紙面（見本と印刷で同じ） */
export function ContactSheetView({ sheet }: { sheet: ContactSheet }) {
  return (
    <article className="dcc-sheet">
      <div className="dcc-head">
        {sheet.officeName !== '' ? <p className="dcc-office">{sheet.officeName}</p> : null}
        <p className="dcc-title">連絡帳</p>
        <p className="dcc-date">{sheet.dateLabel}</p>
      </div>
      <p className="dcc-name">{sheet.name} 様</p>

      {sheet.attended ? (
        <>
          <section className="dcc-sec">
            <p className="dcc-h">今日のご様子</p>
            {sheet.vitals === null || sheet.vitals.kind === 'unread' ? (
              <p className="dcc-text">バイタル: {UNREAD}</p>
            ) : (
              <>
                <table className="dcc-vitals">
                  <thead>
                    <tr>
                      {sheet.vitals.cells.map((c) => (
                        <th key={c.label} scope="col">
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      {sheet.vitals.cells.map((c) => (
                        <td key={c.label}>{c.value}</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
                {sheet.vitals.recheck ? <p className="dcc-small">{RECHECK_NOTE}</p> : null}
              </>
            )}
          </section>
          <section className="dcc-sec">
            <table className="dcc-items">
              <tbody>
                {sheet.items.map((it) => (
                  <tr key={it.label}>
                    <th scope="row">{it.label}</th>
                    <td>{it.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : (
        <section className="dcc-sec">
          <p className="dcc-text">{sheet.absentText}</p>
        </section>
      )}

      {/* ひと言の欄は空なら見出しごと出さない（「記録なし」と刷らない＝2026-11-09 親の決定）。来ていない方は共通の一文を載せない */}
      {staffSectionShown(sheet) ? (
        <section className="dcc-sec">
          <p className="dcc-h">職員より</p>
          {sheet.notesUnread ? (
            <p className="dcc-text">{UNREAD}</p>
          ) : (
            <>
              {sheet.staff.common !== null ? <p className="dcc-text">{sheet.staff.common}</p> : null}
              {sheet.staff.personal !== null ? <p className="dcc-text">{sheet.staff.personal}</p> : null}
            </>
          )}
        </section>
      ) : null}

      {/* 看護職より: 基準外の時だけ。看護職のひと言が空なら出さない（印刷の前に画面が注意を出す） */}
      {nurseSectionShown(sheet) ? (
        <section className="dcc-sec">
          <p className="dcc-h">看護職より</p>
          <p className="dcc-text">{sheet.notesUnread ? UNREAD : sheet.nurse}</p>
        </section>
      ) : null}

      <section className="dcc-sec">
        <p className="dcc-h">ご家族より</p>
        <span className="dcc-rule" aria-hidden="true" />
        <span className="dcc-rule" aria-hidden="true" />
        <span className="dcc-rule" aria-hidden="true" />
        <span className="dcc-rule" aria-hidden="true" />
      </section>

      <div className="dcc-foot">
        <p className="dcc-text">
          記入者 <span className="dcc-blank" aria-hidden="true">&nbsp;</span>
        </p>
        <p className="dcc-text">
          次回のご利用日 <span className="dcc-blank" aria-hidden="true">　　月　　日（　）</span>
        </p>
      </div>
    </article>
  )
}

/** 1mm が何 px か（画面の CSS px。印刷も CSS px で組むので同じ値になる・PrintArea と同じ） */
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

/** 1人ずつ、1枚（印刷できる高さ）に収まる文字の大きさを探して --dcc-font に書く（文字の大きさだけで収める） */
function fitSheets(host: HTMLElement): void {
  const availH = PRINTABLE_H_MM * pxPerMm() * FIT_SAFETY
  host.setAttribute('data-dcc-measure', '')
  try {
    for (const el of Array.from(host.querySelectorAll<HTMLElement>('.dcc-sheet'))) {
      let size = CONTACT_FONT_MAX_PX
      for (; size > CONTACT_FONT_MIN_PX; size -= FONT_STEP_PX) {
        el.style.setProperty('--dcc-font', `${size}px`)
        if (el.scrollHeight <= availH) break
      }
      el.style.setProperty('--dcc-font', `${Math.max(size, CONTACT_FONT_MIN_PX)}px`)
    }
  } finally {
    host.removeAttribute('data-dcc-measure')
  }
}

function injectPageStyle(): void {
  document.getElementById(PAGE_STYLE_ID)?.remove()
  const style = document.createElement('style')
  style.id = PAGE_STYLE_ID
  style.textContent = CONTACT_PAGE_CSS
  document.head.appendChild(style)
}

function cleanupPrint(): void {
  document.documentElement.removeAttribute(PRINT_ATTR)
  document.getElementById(PAGE_STYLE_ID)?.remove()
}

export interface DaycareContactPrintHandle {
  /** 用紙と文字の大きさを整えてから印刷する */
  print(): void
}

/** 印刷する紙面（選んだ方だけ・1人1枚）。画面には出さず、body の直下に置く */
export const DaycareContactPrint = forwardRef<DaycareContactPrintHandle, { sheets: readonly ContactSheet[] }>(function DaycareContactPrint(
  { sheets },
  ref,
) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = document.createElement('div')
    el.className = 'dcc-print-area'
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
    injectPageStyle()
    fitSheets(host)
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

  return host === null
    ? null
    : createPortal(
        <>
          {sheets.map((s) => (
            <ContactSheetView key={s.residentId} sheet={s} />
          ))}
        </>,
        host,
      )
})
