// 食事一覧の見やすさの改善（2026-11-01 本人裁定・案C）の回帰テスト。すべて画面だけで、印刷 A3 は1pxも変えない。
//   1. 食事の枠（.msheet-legible）の中だけ、文字 16px・行 26px・列幅を差し替える（@media screen の中だけ）
//   2. 主食・副食の列は 30px のまま。印（デ・▼・⚠・▲）は画面だけマスの角へ
//   3. 水分の列は画面だけ --msheet-w-fluid（紙は1食分の幅のまま）
//   4. 上部の操作を表題行へ（cl-sheet-header-slot に portal）・紙には従来の操作バー
//   5. 記号の説明は画面だけ畳む（開閉は UI 状態だけ・既知値 '1' だけ開く）・紙は常に全文
// ソースを読んで正規表現で確かめる（画面の部品は描かない）。個人情報は置かない。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = new URL('../src/', import.meta.url).href
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')
const css = read('styles/sheet.css')
const meals = read('pages/MealsSheetPage.tsx')
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
      else if (s[j] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    out.push(s.slice(i, j + 1))
    i = s.indexOf(head, j)
  }
  return out
}

/** @media の塊を除いた残り（どこにも包まれていない規則） */
function outsideMedia(src) {
  let s = stripComments(src)
  for (;;) {
    const i = s.indexOf('@media')
    if (i === -1) return s
    let depth = 0
    let j = s.indexOf('{', i)
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++
      else if (s[j] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    s = s.slice(0, i) + s.slice(j + 1)
  }
}

describe('1. 食事の枠の文字と列幅（画面だけ）', () => {
  const block = mediaBlocks(css, 'screen').find((b) => /\.msheet-legible \{\s*--sheet-font-base/.test(b))

  it('16px・行と見出し 26px・居室 44・氏名 128・水分 50 を .msheet-legible の中で差し替える', () => {
    assert.ok(block, '画面だけの .msheet-legible の差し替えが無い')
    assert.match(block, /--sheet-font-base: 1rem;/)
    assert.match(block, /--sheet-row-h-base: 1\.625rem;/)
    assert.match(block, /--sheet-head-h-base: 1\.625rem;/)
    assert.match(block, /--w-room-m-base: 2\.75rem;/)
    assert.match(block, /--w-name-m-base: 8rem;/)
    assert.match(block, /--msheet-w-fluid: calc\(3\.125rem \* var\(--sheet-zoom, 1\)\);/)
  })

  it('主食・副食の列（--w-meal-base）は差し替えない', () => {
    assert.doesNotMatch(block, /--w-meal-base:/)
  })

  it('契約名・別名・当たり判定の拡張量を同じ要素で算出し直す（倍率が掛かる・共有の規則の列には足さない）', () => {
    for (const re of [
      /--sheet-font: calc\(var\(--sheet-font-base\) \* var\(--sheet-zoom, 1\)\);/,
      /--sheet-row-h: calc\(var\(--sheet-row-h-base\) \* var\(--sheet-zoom, 1\)\);/,
      /--w-room-m: calc\(var\(--w-room-m-base\) \* var\(--sheet-zoom, 1\)\);/,
      /--w-name-m: calc\(var\(--w-name-m-base\) \* var\(--sheet-zoom, 1\)\);/,
      /--sheet-row: var\(--sheet-row-h\);/,
      /--sheet-hit-pad: max\(0px, calc\(var\(--tap-min\) - var\(--sheet-row\)\)\);/,
    ]) {
      assert.match(block, re)
    }
    // 共有の算出の規則（:root, .sheet-frame, .dsheet-legible …）に .msheet-legible を足していない（バイタル一覧の改善と同じ行を触らない）
    assert.doesNotMatch(stripComments(css), /:root,[^{]*\.msheet-legible[^{]*\{/)
  })

  it('msheet の新しい規則は印刷にも @media の外にも無い（紙は 13px 基準のまま）', () => {
    const out = outsideMedia(css)
    for (const cls of ['msheet-legible', 'msheet-name', 'msheet-mark-phase', 'msheet-mark-low', 'msheet-w-fluid']) {
      assert.doesNotMatch(out, new RegExp(cls), `${cls} が @media の外にある`)
      for (const b of mediaBlocks(css, 'print')) assert.doesNotMatch(b, new RegExp(cls), `${cls} が印刷の規則にある`)
    }
  })

  it('枠に msheet-legible、氏名の欄に msheet-name（日の太い区切りの sheet-fix-end はそのまま）', () => {
    assert.match(meals, /className="sheet-frame-fit msheet-legible"/)
    assert.match(meals, /\$\{CELL_BASE\} sheet-fix-end sticky z-10 msheet-name truncate/)
    const scr = mediaBlocks(css, 'screen').join('\n')
    assert.match(scr, /\.msheet-legible td\.msheet-name,\s*\.msheet-legible td\.msheet-name \.truncate \{\s*white-space: normal;/)
  })
})

describe('2. 印をマスの角へ（画面だけ）', () => {
  it('低摂取・状態・未送信の印に専用の class を付ける', () => {
    assert.match(meals, /className=\{`sheet-mark msheet-mark-phase \$\{phaseMark\.cls\}`\}/)
    assert.match(meals, /className="sheet-mark msheet-mark-low text-warn"/)
    assert.match(meals, /className="msheet-mark-phase text-warn"/)
  })
  it('角へ置く規則は枠の中のボタンの直下の印だけ（氏名の右の「▼」は動かさない）', () => {
    const scr = mediaBlocks(css, 'screen').join('\n')
    assert.match(scr, /\.msheet-legible tbody td button > \.msheet-lowday/)
    assert.match(scr, /\.msheet-legible tbody td button > \.msheet-mark-low \{\s*bottom: 1px;\s*right: 2px;/)
    // 位置の基準は印を持つボタンだけ（全部のマスに relative を付けない）
    assert.match(scr, /\.msheet-legible tbody td button:has\(/)
    assert.doesNotMatch(scr, /\.msheet-legible tbody td button \{\s*position: relative;/)
    assert.doesNotMatch(scr, /\.msheet-legible \.msheet-lowday/)
  })
})

describe('3. 水分の列', () => {
  it('W_FLUID は画面の変数が無い時（紙）は1食分の幅に戻る', () => {
    assert.match(meals, /const W_FLUID = 'var\(--msheet-w-fluid, calc\(var\(--w-meal\) \* 2\)\)'/)
  })
})

describe('4. 上部の操作を表題行へ', () => {
  it('App は食事一覧の時だけ置き場を出し、紙には出さない', () => {
    assert.match(app, /const SHEET_HEADER_SLOT_PATHS = \['\/sheet\/meals'\]/)
    assert.match(app, /\{sheetHeaderSlot && \(\s*<div id="cl-sheet-header-slot" className="min-w-0 flex-1 basis-full sm:basis-auto print:hidden" \/>/)
  })
  it('表題行の器は同じ開閉の保存・狭い時は畳む・フロアと日数は選択欄・倍率は ZoomSelect', () => {
    assert.match(app, /<MealsSheetPage actorId=\{actorId\} inputEnabled=\{inputEnabled\} headerSlotId="cl-sheet-header-slot" \/>/)
    const portal = meals.slice(meals.indexOf('<HeaderSlotPortal id={headerSlotId}'), meals.indexOf('</HeaderSlotPortal>'))
    assert.ok(portal.length > 0, '表題行への portal が無い')
    assert.match(portal, /storageKey=\{LS\.mealsBarOpen\}/)
    assert.match(portal, /narrowWidth=\{HEADER_BAR_NARROW_PX\}/)
    assert.match(portal, /<PrefSelect options=\{floorOptions\} value=\{floor\} onChange=\{onChangeFloor\}/)
    assert.match(portal, /options=\{DAYS_OPTIONS\}/)
    assert.match(portal, /<ZoomSelect \/>/)
    assert.match(portal, /persistent=\{<RecorderBar actorId=\{actorId \?\? null\} \/>\}/)
  })
  it('開く時に表全体を2回描かない: 置き場を探すのは小さな器（HeaderSlotPortal）で、画面全体の state に置き場の要素を持たない（2026-11-01 iPhone で重い）', () => {
    assert.doesNotMatch(meals, /setHeaderSlot/)
    const portal = meals.slice(meals.indexOf('function HeaderSlotPortal('), meals.indexOf('function PrefSelect('))
    assert.match(portal, /const found = document\.getElementById\(id\)\s*if \(found\) setEl\(found\)\s*else onMissing\(\)/)
    // 置き場が見つからない時は画面の中の操作バーへ戻す（操作が消えない）
    assert.match(meals, /const headerSlot = headerSlotId !== undefined && !slotMissing/)
  })
  it('紙用の操作バー（4ボタンの倍率）は残し、表題行がある時は画面でだけ隠す', () => {
    assert.match(meals, /<SectionCard className=\{headerSlot \? 'hidden print:block' : ''\}>/)
    assert.match(meals, /<ZoomBar compact \/>/)
  })
})

describe('5. 記号の説明を画面だけ畳む', () => {
  it('開閉は UI 状態だけ・既知値 1 だけ開く・読めない時は畳む', () => {
    assert.match(read('lib/types.ts'), /mealsLegendOpen: 'cl_mealsLegendOpen'/)
    assert.match(meals, /return window\.localStorage\.getItem\(LS\.mealsLegendOpen\) === '1'/)
  })
  it('ボタンは紙に出さず aria-expanded を持つ・説明は畳んでも紙には出す', () => {
    assert.match(meals, /aria-expanded=\{legendOpen\}\s*aria-controls="msheet-legend"/)
    assert.match(meals, /className="min-h-tap self-start rounded px-2 text-sm text-link print:hidden"/)
    assert.match(meals, /<p id="msheet-legend" className=\{`text-sm text-ink2 \$\{legendOpen \? '' : 'hidden print:block'\}`\}>/)
  })
})

describe('6. 入力欄で打つたびに表全体を描き直さない（2026-11-01 iPhone で入力がカクつく）', () => {
  it('打った文字は入力欄の部品（AmountInput）が持ち、画面へは控え（ref）として渡すだけ。確定はその控えを読む', () => {
    const input = meals.slice(meals.indexOf('function AmountInput('), meals.indexOf('// ── 表題行の操作の部品'))
    assert.match(input, /const \[text, setText\] = useState\(initialText\)/)
    assert.match(input, /setText\(e\.target\.value\)\s*onText\(e\.target\.value\)/)
    assert.match(meals, /const onEditText = useCallback\(\(v: string\) => \{\s*editTextRef\.current = v\s*\}, \[\]\)/)
    assert.match(meals, /const parsed = parseAmount\(editTextRef\.current\)/)
    // 表の中のマスへ state の setter をそのまま渡さない（渡すと打つたびに表全体を描き直す）
    assert.doesNotMatch(meals, /onText=\{setEditText\}/)
  })
})
