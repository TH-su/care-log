// 一覧の画面で、フック（useState・useEffect 等）を読み込み中・失敗の早期 return より後ろに置かない（2026-11-01）。
// 後ろに置くと、読み込み中の描画と読み終えた後の描画でフックの数が変わり、React が止まって「この画面で問題が起きました」になる
// （バイタル一覧で本番発生。仮画面は入居者を最初から渡していたので早期 return を通らず見逃した）。
// ソースを読んで、画面の関数の本体で最初の早期 return から最後の return までの間に、本体の深さのフック呼び出しが無いことを確かめる。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')

/** export function <name>( から、行頭の "}" までを本体として返す */
function body(src, name) {
  const i = src.indexOf(`export function ${name}(`)
  assert.ok(i >= 0, `${name} が無い`)
  const j = src.indexOf('\n}\n', i)
  return src.slice(i, j)
}

for (const [file, name] of [
  ['pages/VitalsSheetPage.tsx', 'VitalsSheetPage'],
  ['pages/MealsSheetPage.tsx', 'MealsSheetPage'],
]) {
  describe(`${name}: フックは早期 return より前`, () => {
    it('最初の早期 return の後ろに、本体の深さ（2字下げ）のフック呼び出しが無い', () => {
      const b = body(read(file), name)
      const early = b.search(/\n  if \([^\n]*\) (\{\n    return |return )/)
      if (early < 0) return // 早期 return が無ければ問題は起きない
      const rest = b.slice(early)
      const hooks = rest.match(/\n  (?:const [^\n=]+= )?use[A-Z]\w*(?:<[^\n]*?>)?\(/g) ?? []
      assert.deepEqual(hooks, [], `${name} の早期 return の後ろにフックがある`)
    })
  })
}
