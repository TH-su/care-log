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
  it('デイサービス欄の浮島は画面だけ・四辺を 3px で囲み・上下 24px 離す・overflow を付けない', () => {
    const css = read('styles/sheet.css')
    const m = css.match(/@media screen \{\s*\.dsheet-island \{([^}]*)\}/)
    assert.ok(m, '.dsheet-island が @media screen の中に無い')
    assert.match(m[1], /margin:\s*var\(--sp-5\) var\(--sp-2\)/, '上下 24px・左右 8px でない')
    assert.match(m[1], /border:\s*3px solid var\(--c-ink\)/, '四辺の罫線が 3px・濃い色でない')
    assert.doesNotMatch(m[1], /overflow/, 'overflow を付けると行の左固定が効かなくなる')
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
})
