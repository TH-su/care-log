// 平熱の横に「n回」（数えた定時の体温の回数）を出すことを見張る静的な試験（2026-10-16）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('db は平熱の RPC の samples を捨てずに返す（fetchUsualTempDetails）。fetchUsualTemps は同じ控えから平熱だけを返す', () => {
  const src = read('src/lib/db.ts')
  assert.match(src, /export function fetchUsualTempDetails\(day: string\): Promise<Map<number, UsualTempDetail>>/)
  assert.match(src, /const n = num\(r\?\.samples\)/)
  assert.match(src, /export async function fetchUsualTemps\(day: string\)[\s\S]{0,200}fetchUsualTempDetails\(day\)/)
})

test('カルテは平熱の説明に回数を添える（グラフの注記と個別の目標の欄）', () => {
  const src = read('src/pages/KartePage.tsx')
  assert.match(src, /fetchUsualTempDetails\(toIso\)/)
  assert.match(src, /30日の定時の中央値\$\{usualSamples !== null \? `・\$\{usualSamples\}回` : ''\}/)
  assert.match(src, /直近30日の定時の体温の中央値\$\{usualSamples !== null \? `（\$\{usualSamples\}回）` : ''\}/)
})
