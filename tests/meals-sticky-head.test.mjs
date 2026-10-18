// 食事一覧の見出しの固定（2026-10-18 本人依頼「iPhone で食事一覧を指で動かすとカクつく」）。
// 見出しの3段は thead ごと上に固定し、セル1つずつは sticky にしない（固定の層を減らす）。左上の2つだけは横にも固定する
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/pages/MealsSheetPage.tsx', import.meta.url), 'utf8')
const head = src.slice(src.indexOf('<thead'), src.indexOf('</thead>'))

describe('★食事一覧 見出しの固定は thead ごと（iPhone のカクつき対策）', () => {
  it('thead が上に固定され、見出しのセルは上の位置を持たない', () => {
    assert.match(head, /<thead className="sticky top-0 z-20">/)
    assert.doesNotMatch(head, /top: (0|HEAD_H)/)
  })
  it('sticky のセルは左上の居室・入居者の2つだけ（横にも固定）', () => {
    assert.equal((head.match(/\$\{CELL_BASE\}[^`]*\bsticky\b/g) ?? []).length, 2)
    assert.match(head, /left: 0 \}\}/)
    assert.match(head, /left: W_ROOM \}\}/)
  })
})
