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
