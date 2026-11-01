// 食事一覧: マスを押して入力欄を開く・閉じるたびに表全体を描き直さない（2026-11-01 iPhone で重い）。
// 1名分の行を memo した部品（MealsRow）にし、開閉の state（edit・editText・editInvalid・fluidTarget）はその行の分だけ渡す。
// 行へ渡すコールバックは参照を変えない（変わると全行の memo が外れる）
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/pages/MealsSheetPage.tsx', import.meta.url), 'utf8')
const tbody = src.slice(src.indexOf('<tbody>'), src.indexOf('</tbody>'))
const rowDef = src.slice(src.indexOf('const MealsRow = memo(function MealsRow('), src.indexOf('// ── 画面本体'))

describe('食事一覧: 行は memo した部品で、開閉の state は全行に渡らない', () => {
  it('行は memo した部品（既定の浅い比較＝比べ漏れで古い表示を残さない）。部品の中に state・フックを持たない', () => {
    assert.ok(rowDef.length > 0, 'MealsRow が memo されていない')
    assert.match(rowDef, /\}: MealsRowProps\) \{\s*return \(\s*<tr/)
    // 独自の比較関数を渡さない（memo(fn) の1引数だけ）
    assert.match(rowDef, /\n\}\)\n/)
    assert.doesNotMatch(rowDef, /\buse[A-Z]\w*\(/)
  })
  it('表の本体は MealsRow を並べるだけで、開閉の state はその行の分だけ（他の行は null／空／false）', () => {
    assert.match(tbody, /<MealsRow\s/)
    assert.doesNotMatch(tbody, /<tr\b/)
    assert.match(tbody, /edit=\{edit != null && edit\.residentId === r\.id \? edit : null\}/)
    assert.match(tbody, /editText=\{edit != null && edit\.residentId === r\.id \? editText : ''\}/)
    assert.match(tbody, /editInvalid=\{edit != null && edit\.residentId === r\.id \? editInvalid : false\}/)
    assert.match(tbody, /fluidTarget=\{fluidTarget != null && fluidTarget\.residentId === r\.id \? fluidTarget : null\}/)
    for (const bad of [/edit=\{edit\}/, /editText=\{editText\}/, /editInvalid=\{editInvalid\}/, /fluidTarget=\{fluidTarget\}/]) {
      assert.doesNotMatch(tbody, bad)
    }
  })
  it('行へ渡す確定（commitAmount）は参照を変えない。中身は描いた直後に入れ替える（古い edit を読まない）', () => {
    assert.match(src, /const commitAmount = useCallback\(\(\): boolean => commitAmountRef\.current\(\), \[\]\)/)
    assert.match(src, /useLayoutEffect\(\(\) => \{\s*commitAmountRef\.current = commitAmountNow\s*\}, \[commitAmountNow\]\)/)
    assert.match(src, /const commitAndClose = useCallback\([\s\S]*?\[closeEdit, commitAmount\],\s*\)/)
    assert.match(src, /const onEditKeyDown = useCallback\([\s\S]*?\[closeEdit, commitAndClose\],\s*\)/)
    assert.match(src, /const onEditBlur = useCallback\([\s\S]*?\[commitAmount, commitAndClose\],\s*\)/)
    // 開閉の state（edit・editText・editInvalid・fluidTarget）に依る関数を行へ渡さない
    assert.doesNotMatch(tbody, /commitAmount=\{commitAmountNow\}/)
  })
})

describe('食事一覧: 行へ渡すものが描くたびに作り直されない（2026-11-01 反証レビュー）', () => {
  const rowUse = tbody.slice(tbody.indexOf('<MealsRow'), tbody.indexOf('/>', tbody.indexOf('<MealsRow')))
  it('行の props にその場で作る関数・オブジェクト・配列を渡さない（渡すと全行の memo が外れる）', () => {
    assert.ok(rowUse.length > 0)
    assert.doesNotMatch(rowUse, /=\{\s*\(/, 'その場で作る関数を渡している')
    assert.doesNotMatch(rowUse, /=\{\s*(?:async\s+)?\w+\s*=>/, 'その場で作る関数を渡している')
    assert.doesNotMatch(rowUse, /=\{\{/, 'その場で作るオブジェクトを渡している')
    assert.doesNotMatch(rowUse, /=\{\[/, 'その場で作る配列を渡している')
  })
  it('行へ渡すコールバックは useCallback で、依存に開閉の state（edit・editText・editInvalid・fluidTarget）を含まない', () => {
    const names = [...rowUse.matchAll(/\n\s+(\w+)=\{(\w+)\}/g)].filter(([, k, v]) => k === v && /^(on[A-Z]|open|close|add|undo|save|commit|btnRefFor)/.test(k)).map(([, k]) => k)
      // state の値（undoFluids など）は関数ではないので除く
      .filter((k) => !new RegExp(`const \\[${k},`).test(src))
    assert.ok(names.length >= 10, `コールバックの数が足りない: ${names}`)
    for (const n of names) {
      const i = src.indexOf(`const ${n} = useCallback(`)
      assert.ok(i >= 0, `${n} が useCallback ではない`)
      // useCallback 自身の依存（複数行の形「\n    [..],\n  )」か1行の形「}, [..])」の最初のもの）
      const m = src.slice(i).match(/\n    \[([^\[\]]*)\],?\n  \)|\}, \[([^\[\]]*)\]\)/)
      assert.ok(m, `${n} の依存が読めない`)
      const deps = m[1] ?? m[2]
      for (const bad of ['edit', 'editText', 'editInvalid', 'fluidTarget']) {
        assert.ok(!deps.split(',').map((x) => x.trim()).includes(bad), `${n} の依存に ${bad} がある（開閉のたびに全行を描き直す）`)
      }
    }
  })
})

