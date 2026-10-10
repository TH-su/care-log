// 多端末の改修（2026-10-10）で足した画面の部品の見え方を見張る静的な試験。
// ヘッドレス Chrome での確認（文字200%・印刷）で見つかった2点が戻らないようにする。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('記録者の表示は文字200%でも名前を切らない（truncate で「記…」にしない・折り返す）', () => {
  const src = read('src/components/RecorderBar.tsx')
  assert.doesNotMatch(src, /<p className="[^"]*\btruncate\b[^"]*">\s*<span className="text-ink2">記録者: /)
  assert.match(src, /flex min-w-0 flex-wrap items-center gap-2 print:hidden/)
})

test('与薬の「日付が変わりました」の帯は印刷に出さない（日報の同じ帯とそろえる）', () => {
  const src = read('src/pages/MedRecordPage.tsx')
  const i = src.indexOf('日付が変わりました（表示中:')
  assert.ok(i > 0)
  const open = src.lastIndexOf('<div role="status"', i)
  assert.ok(open > 0 && i - open < 400)
  assert.match(src.slice(open, src.indexOf('>', open)), /print:hidden/)
})
