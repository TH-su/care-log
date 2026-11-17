// バイタル表の欄を押した時に数字のキーボードが開くことの見張り（2026-11-17 本人指示「食事量の画面と同様に数字のキーボード」）。
//   1. 共通のセル（src/components/sheet.tsx の SheetCell）が inputMode を受け取り、1行の入力欄へ渡す
//   2. バイタル表（src/pages/VitalsSheetPage.tsx）が体温は 'decimal'（小数点が要る）、ほかの欄は 'numeric' を渡す
// 実行: npm test。個人情報は置かない。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sheet = readFileSync(new URL('../src/components/sheet.tsx', import.meta.url), 'utf8')
const vitals = readFileSync(new URL('../src/pages/VitalsSheetPage.tsx', import.meta.url), 'utf8')

describe('バイタル表の数字のキーボード', () => {
  it('共通のセルは inputMode を受け取り、1行の入力欄に付ける', () => {
    assert.match(sheet, /inputMode\?: 'numeric' \| 'decimal'/)
    assert.match(sheet, /<input\s+ref=\{inputRef\}\s+type="text"\s+inputMode=\{inputMode\}/)
  })
  it('バイタル表は体温を decimal、ほかを numeric で開く', () => {
    assert.match(vitals, /inputMode=\{f === 'temp' \? 'decimal' : 'numeric'\}/)
  })
})
