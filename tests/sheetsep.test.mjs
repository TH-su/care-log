// 日報の申し送り：デイサービス欄と夜勤申し送り欄を、少し離して濃く太い罫線で区切る（2026-10-09 指示）の回帰テスト。
// 実行: node --experimental-strip-types --test tests/sheetsep.test.mjs（修正前の版は CL_SEP_SRC に src の場所を渡す）
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SRC = process.env.CL_SEP_SRC
  ? pathToFileURL(`${process.env.CL_SEP_SRC.replace(/\/$/, '')}/`).href
  : new URL('../src/', import.meta.url).href
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')

describe('デイサービス・夜勤の区切り', () => {
  it('デイサービス欄は画面だけ・上下 24px 離す・上下端と見出しの下を 3px の太線・直前の欄の下端も太線・影と overflow は付けない', () => {
    const css = read('styles/sheet.css')
    const m = css.match(/@media screen \{\s*\.dsheet-island \{([^}]*)\}([\s\S]*?)\n\}/)
    assert.ok(m, '.dsheet-island が @media screen の中に無い')
    assert.match(m[1], /margin:\s*var\(--sp-5\) calc\(var\(--sp-2\) \+ var\(--sheet-rule-bold\)\)/, '上下 24px・左右 8px（日の枠の線の内側）でない')
    assert.match(m[1], /border-top:\s*3px solid var\(--c-ink\)/, '上端の太線が無い')
    assert.match(m[1], /border-bottom:\s*3px solid var\(--c-ink\)/, '下端の太線が無い')
    assert.doesNotMatch(m[1], /overflow|box-shadow/, '影・overflow を付けない')
    assert.match(m[2], /\.dsheet-island \.dsheet-title-care \{\s*border-bottom:\s*3px solid var\(--c-ink\)/, '見出しの下の太線が無い')
    assert.match(m[2], /section:has\(\+ \.dsheet-island\) \{\s*border-bottom:\s*3px solid var\(--c-ink\)/, '直前の欄の下端の太線が無い')
  })
  it('デイサービス欄と夜勤申し送り欄に区切りの class が付いている', () => {
    const src = read('pages/DailySheetPage.tsx')
    assert.match(src, /className="dsheet-gap-block dsheet-island"\s*\n\s*title="デイサービス"/, 'デイサービス欄が浮島になっていない')
    assert.match(src, /className="dsheet-sep-block"\s*\n\s*title="夜勤申し送り"/, '夜勤申し送り欄に区切りが無い')
  })
  it('区切りは画面だけ（印刷は変えない）・日の切れ目より狭い余白・日の枠より太い罫線', () => {
    const css = read('styles/sheet.css')
    const m = css.match(/@media screen \{\s*\.dsheet-sep-block \{([^}]*)\}/)
    assert.ok(m, '.dsheet-sep-block が @media screen の中に無い')
    assert.match(m[1], /margin-top:\s*var\(--sp-4\)/, '余白が 16px（--sp-4）でない')
    assert.match(m[1], /border-top:\s*3px solid var\(--c-ink\)/, '罫線が 3px・濃い色でない')
  })
  it('16時以降・デイ・夜勤の欄が空きの部分で縦線につながらない（日の枠の左右の線を各欄へ移す・画面だけ）', () => {
    const css = read('styles/sheet.css')
    const m = css.match(/@media screen \{\s*\.dsheet-day \{([^}]*)\}([\s\S]*?)\n\}/)
    assert.ok(m, '日の枠の左右の線を外す指定が @media screen の中に無い')
    assert.match(m[1], /border-left:\s*none/)
    assert.match(m[1], /border-right:\s*none/)
    assert.match(m[2], /\.dsheet-frame-row,\s*\.dsheet-body > :not\(\.dsheet-island\) \{\s*border-left:\s*var\(--sheet-rule-bold\) solid var\(--c-ink2\);\s*border-right:\s*var\(--sheet-rule-bold\) solid var\(--c-ink2\)/, '各欄が左右の線を持っていない')
    const src = read('pages/DailySheetPage.tsx')
    assert.equal((src.match(/dsheet-frame-row/g) ?? []).length, 2, '見出しの2行に dsheet-frame-row が無い')
  })
})
