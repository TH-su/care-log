// バイタル一覧の見やすさの改善（2026-11-01 本人裁定・案C「日数を保つ」＋上部を詰める）の回帰テスト。すべて画面だけで、印刷は1pxも変えない。
//   1. バイタル一覧の枠（.vsheet-legible）の中だけ、文字 14px・行 23px・列幅を差し替える（@media screen の中だけ）
//   2. 氏名は画面だけ「…」で切らず折り返す（.vsheet-name）
//   3. 倍率は画面では選択欄1つ・紙は4ボタン。保存状況と記録者は画面では表題行へ（紙は操作バーの中）
// 印刷の規則（@media print）が変わっていないことは daily-legible.test.mjs の指紋（PRINT_HASH）が見る。
// ソースを読んで正規表現で確かめる（画面の部品は描かない）。個人情報は置かない。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = new URL('../src/', import.meta.url).href
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')
const css = read('styles/sheet.css')
const vitals = read('pages/VitalsSheetPage.tsx')
const app = read('App.tsx')

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** 指定した @media の塊（波括弧の対応で切り出す）を全部返す */
function mediaBlocks(src, query) {
  const s = stripComments(src)
  const out = []
  const head = `@media ${query} {`
  let i = s.indexOf(head)
  while (i !== -1) {
    let depth = 0
    let j = i + head.length - 1
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++
      else if (s[j] === '}' && --depth === 0) break
    }
    out.push(s.slice(i, j + 1))
    i = s.indexOf(head, j)
  }
  return out
}

describe('1. バイタル一覧の枠の中だけ、画面の文字と列幅を差し替える', () => {
  const block = mediaBlocks(css, 'screen').find((b) => /\.vsheet-legible \{/.test(b))

  it('差し替えは @media screen の中（紙は :root の 13px 基準のまま）', () => {
    assert.ok(block, '.vsheet-legible の差し替えが @media screen の中に無い')
    const plain = stripComments(css)
    // 画面の外に出るのは、契約名を算出し直す並び（:root, .sheet-frame, .dsheet-legible, .vsheet-legible）だけ
    const outside = (plain.split('.vsheet-legible {').length - 1) - (block.split('.vsheet-legible {').length - 1)
    assert.equal(outside, 1, '.vsheet-legible の差し替えが画面の外にある（外に出てよいのは契約名の算出の1か所だけ）')
    assert.match(plain, /:root,\s*\.sheet-frame,\s*\.dsheet-legible,\s*\.vsheet-legible \{\s*--sheet-font: calc\(var\(--sheet-font-base\) \* var\(--sheet-zoom, 1\)\);/)
  })

  it('文字 14px・行 23px と、14px で実測した列幅（体温 58・血圧上下・脈・SpO2 54・居室 62・氏名 140）', () => {
    const v = (name) => {
      const m = new RegExp(`--${name}: ([0-9.]+)rem;`).exec(block)
      assert.ok(m, `--${name} が無い`)
      return Number(m[1]) * 16
    }
    assert.equal(v('sheet-font-base'), 14)
    assert.equal(v('sheet-row-h-base'), 23)
    assert.equal(v('w-temp-base'), 58)
    for (const f of ['w-sys-base', 'w-dia-base', 'w-pulse-base', 'w-spo2-base']) assert.equal(v(f), 54, f)
    assert.equal(v('w-room-base'), 62)
    assert.equal(v('w-name-base'), 140)
    // 見出しの高さは変えない（24px のまま）
    assert.doesNotMatch(block.match(/\.vsheet-legible \{[^}]*\}/)[0], /--sheet-head-h-base/)
  })

  it('class を付けるのはバイタル一覧の枠だけ（食事一覧・日報には付けない）', () => {
    assert.match(vitals, /className="sheet-frame-fit vsheet-legible"/)
    for (const p of ['pages/MealsSheetPage.tsx', 'pages/DailySheetPage.tsx']) {
      assert.doesNotMatch(read(p), /vsheet-legible/, `${p} にバイタル一覧の差し替えが効いている`)
    }
  })
})

describe('2. 氏名を「…」で切らない（画面だけ）', () => {
  it('氏名の span に .vsheet-name・画面の規則で折り返す', () => {
    assert.match(vitals, /<span className="vsheet-name min-w-0 flex-1 truncate">\s*\{name\}/)
    const block = mediaBlocks(css, 'screen').find((b) => /\.vsheet-legible \.vsheet-name \{/.test(b))
    assert.ok(block, '氏名の折り返しが @media screen の中に無い')
    assert.match(block, /\.vsheet-legible \.vsheet-name \{\s*white-space: normal;\s*overflow: visible;\s*text-overflow: clip;\s*overflow-wrap: anywhere;/)
  })
})

describe('3. 上部を詰める（倍率は選択欄・保存状況と記録者は表題行へ）', () => {
  it('倍率: 画面は選択欄1つ・紙は従来の4ボタン', () => {
    assert.match(vitals, /\{printing \? \(\s*<ZoomBar compact \/>\s*\) : \(\s*<>\s*<div className="print:hidden">\s*<ZoomSelect \/>\s*<\/div>\s*<div className="hidden print:block">\s*<ZoomBar compact \/>\s*<\/div>/)
    assert.match(css, /@media \(max-width: 480px\) \{\s*\.sheet-pickbar button,[^{]*\.sheet-pickbar select,/)
  })

  it('印刷の直前は以前の並びへ同期で戻してから測り直す（紙の枠の高さ＝--sheet-frame-top を以前と同じにする）', () => {
    assert.match(vitals, /const before = \(\) => \{\s*flushSync\(\(\) => setPrinting\(true\)\)\s*window\.dispatchEvent\(new Event\(SHEET_REMEASURE_EVENT\)\)/)
    assert.match(vitals, /const toHeader = headerSlot !== null && !printing/)
  })

  it('保存状況と記録者: 表題行の置き場があればそこへ（画面だけ）・紙の分は操作バーに残す・置き場が無ければ従来どおり', () => {
    assert.match(app, /\{location\.pathname === '\/sheet\/vitals' && \(\s*<div id="cl-vitals-header-slot" className="flex min-w-0 flex-wrap items-center gap-gap print:hidden" \/>\s*\)\}/)
    assert.match(vitals, /setHeaderSlot\(document\.getElementById\('cl-vitals-header-slot'\)\)/)
    assert.match(vitals, /\{toHeader && headerSlot !== null \? createPortal\(statusLine, headerSlot\) : null\}/)
    assert.match(vitals, /persistent=\{toHeader \? <div className="hidden print:contents">\{statusLine\}<\/div> : statusLine\}/)
  })

  it('表題行の見出しはバイタル一覧だけ flex-auto（入らない時は見出しを潰さず保存状況を次の行へ）・他の画面は従来どおり', () => {
    assert.match(app, /: location\.pathname === '\/sheet\/vitals'[\s\S]*?'flex min-w-0 flex-auto flex-wrap items-baseline gap-2'\s*: 'flex min-w-0 flex-1 flex-wrap items-baseline gap-2'/)
  })
})
