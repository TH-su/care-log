// カルテの見やすさの改善（2026-11-01 本人裁定・案C）の回帰テスト。すべて画面だけで、印刷は変えない。
//   1. 規則は styles/karte.css だけに置き、すべて @media screen の中（印刷の規則を持たない）
//   2. 文字はカルテの枠の中だけ text-sm を本文の大きさへ（新しい値を作らずトークンを指す）。氏名と移動ボタンの帯は除く
//   3. 2列は幅 1024px 以上の画面だけ。グラフの2列は印刷・3か月以上の期間では使わない
//   4. 欄の並びと数（排泄・申し送り・入浴・与薬・事故）は今までどおり
// ソースを読んで正規表現で確かめる（画面の部品は描かない）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）。個人情報は置かない。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = new URL('../src/', import.meta.url).href
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')
const css = read('styles/karte.css')
const karte = read('pages/KartePage.tsx')

/** コメントを外す（コメントの中の語に引っかからないように） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** トップレベルの @media の塊を、波括弧の対応で切り出す（外側に置かれた規則も拾う） */
function topLevel(src) {
  const s = stripComments(src)
  const out = []
  let i = 0
  while (i < s.length) {
    const open = s.indexOf('{', i)
    if (open < 0) break
    const head = s.slice(i, open).trim()
    let depth = 0
    let j = open
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++
      else if (s[j] === '}' && --depth === 0) break
    }
    out.push({ head, body: s.slice(open + 1, j) })
    i = j + 1
  }
  return out
}

/** トップレベルの関数1つ分（function name( から次の行頭の function まで） */
function fnSrc(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} が見つからない`)
  const end = src.indexOf('\nfunction ', start + 1)
  return src.slice(start, end < 0 ? undefined : end)
}

describe('1. 規則は karte.css の @media screen の中だけ', () => {
  it('トップレベルの塊はすべて @media screen で始まる（印刷・素の規則を持たない）', () => {
    const blocks = topLevel(css)
    assert.ok(blocks.length >= 2, '塊が見つからない')
    for (const b of blocks) assert.match(b.head, /^@media screen\b/, `画面だけでない規則: ${b.head}`)
    assert.doesNotMatch(stripComments(css), /@media print|@page/, '印刷の規則がある')
  })
  it('カルテの画面がこの CSS を読み込み、外側の枠に印（cl-karte-legible）を付ける', () => {
    assert.match(karte, /import '\.\.\/styles\/karte\.css'/)
    assert.match(karte, /className="cl-karte-legible w-full py-4"/)
  })
  it('規則はカルテ専用の class（cl-karte-）の中だけ', () => {
    const sels = topLevel(css).flatMap((b) => (b.body.match(/^[^{}]+(?=\{)/gm) ?? []).map((x) => x.trim()))
    assert.ok(sels.length >= 5, `選択子が拾えていない: ${sels.length}`)
    for (const sel of sels) assert.match(sel, /^\.cl-karte-/, `カルテ専用でない選択子: ${sel}`)
  })
})

describe('2. 文字の大きさ', () => {
  it('text-sm（--fs-sm）を本文の大きさ（--fs-base）に差し替える。数値は書かない', () => {
    const rule = stripComments(css).match(/\.cl-karte-legible > :not\(\[data-karte-bar\]\) \{([^}]*)\}/)
    assert.ok(rule, '氏名の帯を除く差し替えが無い')
    assert.match(rule[1], /--fs-sm: var\(--fs-base\);/)
    assert.doesNotMatch(rule[1], /px|rem/, 'トークン以外の値を書いている')
  })
  it('13px 未満を作らない（--fs-2xs・--fs-xs を差し替えていない）', () => {
    assert.doesNotMatch(stripComments(css), /--fs-2xs|--fs-xs/)
  })
  it('氏名は削らない（truncate を付けない）', () => {
    assert.match(karte, /<h1 className="min-w-0 max-w-full break-words text-xl font-heavy text-ink">\{resident\.name\}<\/h1>/)
  })
})

describe('3. 2列は広い画面だけ', () => {
  it('2列・幅の広げ・期間の1行は min-width: 1024px の中だけ', () => {
    const wide = topLevel(css).find((b) => /min-width: 1024px/.test(b.head))
    assert.ok(wide, '1024px 以上の塊が無い')
    assert.match(wide.body, /\.cl-karte-pair \{[^}]*display: grid;/)
    assert.match(wide.body, /\.cl-karte-lane \{[^}]*max-width: 72rem;/)
    const narrow = topLevel(css).filter((b) => !/min-width: 1024px/.test(b.head))
    for (const b of narrow) assert.doesNotMatch(b.body, /display: grid|max-width/, `狭い画面にも効く: ${b.head}`)
  })
  it('グラフの2列は印刷・狭い画面・3か月以上では1列のまま（幅も元のまま）', () => {
    const f = fnSrc(karte, 'chartCols')
    assert.match(f, /if \(printing \|\| !wide \|\| dayCount > CHART_COLS_MAX_DAYS\) return \{ box, className: undefined \}/)
    assert.match(karte, /const CHART_COLS_MAX_DAYS = 62\n/)
    assert.match(f, /window\.matchMedia\(WIDE_QUERY\)/)
  })
  it('半分の幅で隣の日との間が MARK_MIN_GAP に届かない時は1列のまま（↑↓の印を消さない。padL は VitalChart と同じ式）', () => {
    const f = fnSrc(karte, 'chartCols')
    assert.match(f, /const padL = Math\.max\(PAD_L_MIN, box\.labelW \+ AXIS_LABEL_GAP \+ 2\)/)
    assert.match(fnSrc(karte, 'VitalChart'), /const padL = Math\.max\(PAD_L_MIN, labelW \+ AXIS_LABEL_GAP \+ 2\)/, 'VitalChart の padL の式が変わった（chartCols も合わせる）')
    assert.match(f, /if \(gap < MARK_MIN_GAP\) return \{ box, className: undefined \}/)
  })
  it('体重のグラフはバイタルが0件の期間でも出す（空の案内の分岐の外）', () => {
    const f = fnSrc(karte, 'VitalsSection')
    const empty = f.indexOf('この期間のバイタル記録はありません')
    const branchEnd = f.indexOf(') : null}', empty)
    const weight = f.indexOf('{weightPanel ? <VitalPanel panel={weightPanel}')
    assert.ok(empty > 0 && branchEnd > empty && weight > branchEnd, '体重のグラフが空の案内の分岐の中にある')
  })
  it('バイタルと食事・水分の両方が chartCols の幅でグラフを描く', () => {
    for (const name of ['VitalsSection', 'MealsSection']) {
      const f = fnSrc(karte, name)
      assert.match(f, /const cols = chartCols\(box, printing, days\.length\)/, `${name} が2列の判定を使っていない`)
      assert.doesNotMatch(f, /box=\{box\}/, `${name} に元の幅のまま描くグラフが残っている`)
    }
  })
})

describe('4. 欄の並びは今までどおり', () => {
  it('排泄→申し送り→入浴→与薬→事故の順に1回ずつ置く', () => {
    const order = ['<ExcretionSection ', '<NotesSection ', '<BathSection ', '<MedSection ', '<IncidentSection ']
    const at = order.map((t) => {
      assert.equal(karte.split(t).length - 1, 1, `${t} が1回でない`)
      return karte.indexOf(t)
    })
    assert.deepEqual([...at].sort((a, b) => a - b), at, '欄の順番が変わった')
  })
})
