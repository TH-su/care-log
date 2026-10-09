// バイタル一覧・食事一覧：1日ごとの区切りを太い罫線で囲う（2026-10-09 指示）の回帰テスト。
// 実行: node --experimental-strip-types --test tests/daygroup.test.mjs（修正前の版は CL_DG_SRC に src の場所を渡す）
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SRC = process.env.CL_DG_SRC
  ? pathToFileURL(`${process.env.CL_DG_SRC.replace(/\/$/, '')}/`).href
  : new URL('../src/', import.meta.url).href
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')

describe('日ごとの太い区切り', () => {
  it('日の最後の列と氏名列の右罫線を画面で太く濃くする（印刷は変えない）', () => {
    const css = read('styles/sheet.css')
    assert.match(css, /@media screen \{\s*\.sheet-table \.sheet-group-end,\s*\.sheet-table \.sheet-fix-end \{\s*border-right:\s*var\(--sheet-rule-bold\) solid var\(--c-ink2\);/)
  })
  it('両画面の氏名列（見出し・行）に sheet-fix-end を付ける', () => {
    for (const f of ['pages/VitalsSheetPage.tsx', 'pages/MealsSheetPage.tsx']) {
      assert.equal((read(f).match(/\$\{CELL_BASE\} sheet-fix-end sticky/g) ?? []).length, 2, `${f} の氏名列に sheet-fix-end が2か所無い`)
    }
  })
  it('食事一覧の3段目（夕の副食）には日の切れ目を付けない（水分の見出しが持つ）', () => {
    const src = read('pages/MealsSheetPage.tsx')
    assert.doesNotMatch(src, /i === SLOTS\.length - 1 \? DAY_END/)
  })
})
