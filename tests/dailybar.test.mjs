// 画面上部の操作（日報・バイタル一覧・食事一覧）を畳む作り（2026-09-29）の回帰テスト。
// 実行: node --experimental-strip-types --test tests/dailybar.test.mjs（修正前の版は CL_BAR_SRC に src の場所を渡す）
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SRC = process.env.CL_BAR_SRC
  ? pathToFileURL(`${process.env.CL_BAR_SRC.replace(/\/$/, '')}/`).href
  : new URL('../src/', import.meta.url).href
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')
const bar = () => {
  const u = new URL('components/CollapsibleBar.tsx', SRC)
  assert.ok(existsSync(u), '畳む器（components/CollapsibleBar.tsx）が無い')
  return readFileSync(u, 'utf8')
}

describe('画面上部の操作を畳む', () => {
  it('開閉の状態は画面ごとの UI 状態として localStorage に持つ（既知値 1／0 だけ読む）', () => {
    const types = read('lib/types.ts')
    assert.match(types, /dailyBarOpen: 'cl_dailyBarOpen'/)
    assert.match(types, /vitalsBarOpen: 'cl_vitalsBarOpen'/)
    assert.match(types, /mealsBarOpen: 'cl_mealsBarOpen'/)
    assert.match(bar(), /raw === '1' \? true : raw === '0' \? false : null/, '保存した値を既知値で照合していない')
  })

  it('開閉のボタンは aria-expanded・aria-controls・読み上げ名を持ち、見える文字は「表示 ▾」「畳む ▴」', () => {
    const src = bar()
    assert.match(src, /aria-expanded=\{open\}/)
    assert.match(src, /aria-controls=\{fullId\}/)
    assert.match(src, /aria-label=\{open \? closeLabel : openLabel\}/)
    assert.match(src, /表示<span aria-hidden="true"> ▾<\/span>/)
    assert.match(src, /畳む<span aria-hidden="true"> ▴<\/span>/)
    assert.match(read('pages/DailySheetPage.tsx'), /openLabel="表示と倍率の操作を開く"\n\s+closeLabel="表示と倍率の操作を畳む"/)
  })

  it('畳めるのは狭い画面（480px 以下）か、操作が1行に収まらない時だけ・開閉のボタンは 44px 以上', () => {
    const src = bar()
    assert.match(src, /'\(max-width: 480px\)'/)
    assert.match(src, /const collapsible = !printing && \(narrow \|\| wraps\)/, '印刷で畳んだ形が紙に出る')
    assert.match(src, /stored === null \? !narrow : stored/, '広い画面の既定が「畳む」になっている（今の見た目が変わる）')
    assert.match(src, /collapse-bar-toggle [^`"]*min-h-tap min-w-tap/)
  })

  it('3画面とも同じ器で畳む。畳んだ形に残すのは日報は前後日と日付、一覧は期間送り。バイタルの保存状況は畳んでも隠さない', () => {
    const daily = read('pages/DailySheetPage.tsx')
    assert.match(daily, /storageKey=\{LS\.dailyBarOpen\}/)
    assert.match(daily, /collapsed=\{\(compact\) => <CollapsedDateBar/)
    const vitals = read('pages/VitalsSheetPage.tsx')
    assert.match(vitals, /storageKey=\{LS\.vitalsBarOpen\}/)
    assert.match(vitals, /collapsed=\{\(compact\) => periodNav\(/)
    assert.match(vitals, /persistent=\{statusLine\}/, '保存状況を畳むと隠れる')
    const meals = read('pages/MealsSheetPage.tsx')
    assert.match(meals, /storageKey=\{LS\.mealsBarOpen\}/)
    assert.match(meals, /collapsed=\{\(compact\) => periodNav\(/)
  })
})
