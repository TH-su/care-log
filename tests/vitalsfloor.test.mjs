// バイタル一覧：「全」表示で1階・2階の境目に太線（食事一覧と同じ .msheet-floor-start・2026-10-09 指示）の回帰テスト。
// 実行: node --experimental-strip-types --test tests/vitalsfloor.test.mjs（修正前の版は CL_VF_SRC に src の場所を渡す）
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SRC = process.env.CL_VF_SRC
  ? pathToFileURL(`${process.env.CL_VF_SRC.replace(/\/$/, '')}/`).href
  : new URL('../src/', import.meta.url).href
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')

describe('バイタル一覧の階の境目', () => {
  it('階が変わる入居者の最初の行に msheet-floor-start を付け、読み上げ用に「ここから◯階」を添える', () => {
    const src = read('pages/VitalsSheetPage.tsx')
    assert.match(src, /const floorStartRows = useMemo\(/, '階の変わり目を求めていない')
    assert.match(src, /floorStart=\{floorStartRows\.get\(row\.rowId\) \?\? null\}/, '行へ渡していない')
    assert.match(src, /floorStart \? 'msheet-floor-start' : ''/, '行に太線の class を付けていない')
    assert.match(src, /<span className="sr-only">ここから\{floorStart\}<\/span>/, '読み上げ用の文字が無い')
  })
  it('太線の見た目は食事一覧と同じ規則（2px・濃い線）', () => {
    const css = read('styles/sheet.css')
    assert.match(css, /\.msheet-floor-start > th,\s*\.msheet-floor-start > td \{\s*border-top:\s*var\(--sheet-rule-bold\) solid var\(--c-ink2\);/)
  })
})
