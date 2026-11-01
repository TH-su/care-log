// タイムラインの見やすさ（2026-11-01・本人選択の案C）の回帰テスト。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 静的検査: 文字の大きさ・列の幅・カードの1行目へのまとめは画面だけ（@media screen）で、印刷と共通トークンを変えない。
// トークンは既存の --fs-* だけを使い、13px 未満の指定を足さない。カードの並び順（DOM）は時刻・氏名 → 本文 → 記入者・既読のまま。
// 個人情報は置かない。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const css = read('../src/index.css').replace(/\/\*[\s\S]*?\*\//g, '')
const page = read('../src/pages/TimelinePage.tsx')

/** `.tl-` を含む規則がすべて @media screen の中にあるか（波括弧の深さで判定） */
function tlRulesOutsideScreen(text) {
  const out = []
  const stack = []
  let buf = ''
  for (const ch of text) {
    if (ch === '{') {
      stack.push(buf.trim())
      buf = ''
    } else if (ch === '}') {
      stack.pop()
      buf = ''
    } else if (ch === ';') {
      buf = ''
    } else {
      buf += ch
    }
    if (ch === '{' && /\.tl-/.test(stack[stack.length - 1])) {
      if (!stack.slice(0, -1).some((s) => /^@media screen( and \([^()]*\))?$/.test(s))) out.push(stack[stack.length - 1])
    }
  }
  return out
}

describe('タイムラインの見やすさ（画面だけ）', () => {
  it('.tl-* の規則はすべて @media screen の中（印刷は変えない）', () => {
    assert.match(css, /\.tl-legible/)
    assert.deepEqual(tlRulesOutsideScreen(css), [])
  })

  it('文字の大きさは既存トークン（--fs-*）だけ・px の直書きをしない', () => {
    const blocks = css.match(/@media screen[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g) ?? []
    const tl = blocks.filter((b) => /\.tl-/.test(b)).join('\n')
    assert.ok(tl.length > 0)
    for (const m of tl.matchAll(/font-size:\s*([^;]+);/g)) assert.match(m[1].trim(), /^var\(--fs-(sm|base|lg|xl)\)$/)
  })

  it('列を広げる（max-w-3xl は印刷用に残し、画面だけ 72rem）', () => {
    assert.match(page, /className="tl-legible mx-auto w-full max-w-3xl px-3 pb-8"/)
    assert.match(css, /div\.tl-legible \{\s*max-width: 72rem;/)
  })

  it('1行目へまとめるのは幅 768px 以上だけ・並び順（DOM）は変えない', () => {
    assert.match(css, /@media screen and \(min-width: 768px\) \{[\s\S]*?\.tl-legible \.tl-card > \.tl-card-meta \{\s*grid-column: 2;\s*grid-row: 1;/)
    const head = page.indexOf('tl-card-head')
    const body = page.indexOf('tl-card-body')
    const meta = page.indexOf('tl-card-meta')
    assert.ok(head > 0 && head < body && body < meta)
  })
})
