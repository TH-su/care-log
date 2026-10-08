// カルテのグラフ（縦軸の拡大・最小の幅・範囲外しきい値・目盛・高さ・食事の集計）の回帰テスト（2026-10-08）。
// 実行: node --experimental-strip-types --test tests/chart.test.mjs
// 修正前の版で流す時は CL_CHART_SRC に修正前の src の場所を渡す（既定はこのリポジトリの src）。
// 個人情報は置かない（値はすべて合成）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SRC = process.env.CL_CHART_SRC
  ? pathToFileURL(`${process.env.CL_CHART_SRC.replace(/\/$/, '')}/`).href
  : new URL('../src/', import.meta.url).href

let C = null
let loadError = null
try {
  const { registerHooks } = await import('node:module')
  registerHooks({
    resolve(specifier, context, next) {
      if (/^\.{1,2}\//.test(specifier) && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
        try {
          return next(`${specifier}.ts`, context)
        } catch {
          // .ts が無いものは元の指定へ戻す
        }
      }
      return next(specifier, context)
    },
  })
  C = await import(new URL('lib/chart.ts', SRC).href)
} catch (e) {
  loadError = e
}
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`)

describe('グラフの縦軸（記録の値に合わせて拡大）', () => {
  it('部品（lib/chart.ts）がある', () => {
    assert.equal(loadError, null, `読み込めない: ${loadError}`)
  })

  it('平熱だけの記録は 35.75〜37.25℃（しきい値 37.5・38.1・35.5 を範囲に入れない）', () => {
    assert.ok(C, '部品が無い')
    const [lo, hi] = C.chartDomain([36.2, 36.5, 36.8], C.KARTE_AXES.temp)
    near(lo, 35.75, '下端')
    near(hi, 37.25, '上端')
  })

  it('発熱の記録（39.2℃）は上端が 39.5 の倍数＋余白まで伸びる', () => {
    assert.ok(C, '部品が無い')
    const [lo, hi] = C.chartDomain([36.4, 37.0, 39.2], C.KARTE_AXES.temp)
    near(lo, 35.75, '下端')
    near(hi, 39.75, '上端')
  })

  it('記録の幅が狭い時は指標ごとの最小の幅まで広げる（ばらつきを急変に見せない）', () => {
    assert.ok(C, '部品が無い')
    const A = C.KARTE_AXES
    assert.equal(A.temp.minSpan, 1.0)
    assert.equal(A.bp.minSpan, 20)
    assert.equal(A.pulse.minSpan, 20)
    assert.equal(A.spo2.minSpan, 4)
    assert.equal(A.weight.minSpan, 2)
    const cases = [
      ['temp', [36.5]],
      ['bp', [120, 125]],
      ['pulse', [72, 74]],
      ['spo2', [97]],
      ['weight', [48.3, 48.6]],
      ['fluid', [1200]],
    ]
    for (const [k, vals] of cases) {
      const ax = A[k]
      const [lo, hi] = C.chartDomain(vals, ax)
      // 余白（刻みの半分×2）を除いた幅が最小の幅以上
      assert.ok(hi - lo - ax.step >= ax.minSpan - 1e-9, `${k}: 幅 ${hi - lo - ax.step} < ${ax.minSpan}`)
      for (const v of vals) assert.ok(v > lo && v < hi, `${k}: ${v} が範囲外`)
    }
    const [blo, bhi] = C.chartDomain([120, 125], A.bp)
    near(blo, 105, '血圧の下端')
    near(bhi, 145, '血圧の上端')
  })

  it('記録が無い時は今までの基準の範囲（base）を使う', () => {
    assert.ok(C, '部品が無い')
    const [lo, hi] = C.chartDomain([], C.KARTE_AXES.temp)
    near(lo, 34.75, '下端')
    near(hi, 39.25, '上端')
  })

  it('値としてありえない側へははみ出さない（SpO2 は 100 まで・水分は 0 から）', () => {
    assert.ok(C, '部品が無い')
    const [lo, hi] = C.chartDomain([99, 100], C.KARTE_AXES.spo2)
    near(lo, 95.5, 'SpO2 下端')
    near(hi, 100.5, 'SpO2 上端（余白だけ）')
    const [flo] = C.chartDomain([100, 150], C.KARTE_AXES.fluid)
    near(flo, -125, '水分の下端（0 に刻みの半分の余白）')
  })

  it('食事（主食＋副食）は記録に関係なく 0〜20 で固定（5% の余白）', () => {
    assert.ok(C, '部品が無い')
    for (const vals of [[], [3], [12, 18]]) {
      const [lo, hi] = C.chartDomain(vals, C.KARTE_AXES.meal)
      near(lo, -1, '下端')
      near(hi, 21, '上端')
    }
  })

  it('壊れた値（NaN・Infinity）は無視する', () => {
    assert.ok(C, '部品が無い')
    const [lo, hi] = C.chartDomain([NaN, 36.5, Infinity], C.KARTE_AXES.temp)
    near(lo, 35.75, '下端')
    near(hi, 37.25, '上端')
  })
})

describe('目盛', () => {
  it('体温は 0.5 刻み・血圧は 10 刻み（区切りのよい値）', () => {
    assert.ok(C, '部品が無い')
    const t = C.chartTicks([35.75, 37.25], 0.5, 300, 20)
    assert.equal(t.step, 0.5)
    assert.deepEqual(t.values, [36, 36.5, 37])
    const b = C.chartTicks([55, 145], 10, 300, 20)
    assert.equal(b.step, 10)
    assert.deepEqual(b.values, [60, 70, 80, 90, 100, 110, 120, 130, 140])
  })

  it('目盛の間隔が文字の高さより狭くなる時は刻みを 2・5・10 倍に広げる', () => {
    assert.ok(C, '部品が無い')
    const t = C.chartTicks([35.75, 39.75], 0.5, 150, 34)
    assert.equal(t.step, 1)
    assert.deepEqual(t.values, [36, 37, 38, 39])
    const b = C.chartTicks([55, 145], 10, 150, 34)
    assert.equal(b.step, 50)
  })
})

describe('範囲外のしきい値', () => {
  const tempMarks = [
    { value: 38.1, label: '38.1' },
    { value: 37.5, label: '37.5' },
    { value: 35.5, label: '35.5' },
  ]

  it('平熱の範囲では 38.1・37.5 は上、35.5 は下（遠い順）', () => {
    assert.ok(C, '部品が無い')
    const s = C.splitThresholds(tempMarks, [35.75, 37.25])
    assert.deepEqual(s.inside.map((m) => m.label), [])
    assert.deepEqual(s.above.map((m) => m.label), ['38.1', '37.5'])
    assert.deepEqual(s.below.map((m) => m.label), ['35.5'])
    assert.equal(C.offRangeText('38.1', 'above'), '38.1↑')
    assert.equal(C.offRangeText('35.5', 'below'), '35.5↓')
  })

  it('発熱の範囲では 38.1・37.5 は範囲内（帯の端に数値）、35.5 だけが下', () => {
    assert.ok(C, '部品が無い')
    const s = C.splitThresholds(tempMarks, [35.75, 39.75])
    assert.deepEqual(s.inside.map((m) => m.label).sort(), ['37.5', '38.1'])
    assert.deepEqual(s.above, [])
    assert.deepEqual(s.below.map((m) => m.label), ['35.5'])
  })

  it('読み上げ文に上・下のしきい値を言葉で入れる（色だけに頼らない）', () => {
    assert.ok(C, '部品が無い')
    const s = C.splitThresholds(tempMarks, [35.75, 37.25])
    const text = C.offRangeSpeech(s.above, s.below)
    assert.match(text, /38\.1・37\.5 は表示範囲より上/)
    assert.match(text, /35\.5 は表示範囲より下/)
    assert.equal(C.offRangeSpeech([], []), '')
  })
})

describe('左の列の文字の並べ方', () => {
  it('近いしきい値（下91・上90）は文字の高さ以上に離し、枠の内側に収める', () => {
    assert.ok(C, '部品が無い')
    const r = C.layoutAxisLabels([100, 101], [], 17, 20, 200)
    assert.ok(Math.abs(r.fixed[0] - r.fixed[1]) >= 17 - 1e-9)
    const e = C.layoutAxisLabels([198, 199, 200], [], 17, 20, 200)
    for (const y of e.fixed) assert.ok(y >= 20 && y <= 200, `枠外 ${y}`)
    const ys = [...e.fixed].sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 17 - 1e-9)
  })

  it('しきい値の文字に近い目盛の文字は出さない・目盛どうしも詰めない', () => {
    assert.ok(C, '部品が無い')
    const r = C.layoutAxisLabels([100], [30, 60, 95, 110, 130, 140, 250], 17, 20, 200)
    // 95・110 はしきい値 100 に近い／140 は 130 に近い／250 は枠外
    assert.deepEqual(r.ticks, [0, 1, 4])
  })
})

describe('グラフの高さ', () => {
  it('iPhone 縦（高さ 844）は 1 画面に 1 枚の大きさ・上限 360', () => {
    assert.ok(C, '部品が無い')
    const h = C.chartHeight({ viewportH: 844, topH: 120, bottomH: 57, overheadH: 150, perScreen: 1 })
    assert.equal(h, 360)
    const se = C.chartHeight({ viewportH: 667, topH: 120, bottomH: 57, overheadH: 150, perScreen: 1 })
    assert.equal(se, 340)
  })

  it('iPhone 横（高さ 375）は下限 200 に張り付く', () => {
    assert.ok(C, '部品が無い')
    assert.equal(C.chartHeight({ viewportH: 375, topH: 120, bottomH: 57, overheadH: 150, perScreen: 1 }), 200)
  })

  it('広い画面は 1 画面に 2 枚', () => {
    assert.ok(C, '部品が無い')
    assert.equal(C.chartHeight({ viewportH: 1000, topH: 110, bottomH: 0, overheadH: 150, perScreen: 2 }), 295)
    assert.equal(C.CHART_H_PRINT, 160)
  })

  it('壊れた値でも 200〜360 に収める', () => {
    assert.ok(C, '部品が無い')
    assert.equal(C.chartHeight({ viewportH: NaN, topH: 0, bottomH: 0, overheadH: 0, perScreen: 1 }), 200)
    assert.equal(C.chartHeight({ viewportH: 5000, topH: 0, bottomH: 0, overheadH: 0, perScreen: 0 }), 360)
  })
})

describe('食事・水分の集計（表とグラフで同じ）', () => {
  const meal = (id, day, slot, main, side, status = 'eaten') => ({
    id, resident_id: 1, meal_on: day, meal_slot: slot, main_amount: main, side_amount: side, status, note: null, recorded_by: null, rev: 1,
  })
  const fluid = (id, day, ml) => ({ id, resident_id: 1, taken_on: day, taken_at: null, amount_ml: ml, kind: null, recorded_by: null, rev: 1 })

  it('同じ枠は後から入った行（id が大きい）を採り、水分は日ごとに合計する', () => {
    assert.ok(C, '部品が無い')
    const byDay = C.mealDays(
      [meal(1, '2026-10-01', 'breakfast', 5, 5), meal(9, '2026-10-01', 'breakfast', 8, 7), meal(3, '2026-10-01', 'lunch', 10, 10)],
      [fluid(1, '2026-10-01', 200), fluid(2, '2026-10-01', 150), fluid(3, '2026-10-02', 300)],
    )
    assert.equal(byDay.get('2026-10-01').meals.get('breakfast').id, 9)
    assert.equal(byDay.get('2026-10-01').fluid, 350)
    assert.equal(byDay.get('2026-10-02').fluid, 300)
    assert.equal(byDay.get('2026-10-02').meals.size, 0)
  })

  it('1食の主食＋副食は 0〜20。外出・入院・拒食・未記入は数えない', () => {
    assert.ok(C, '部品が無い')
    assert.equal(C.mealIntake(meal(1, 'd', 'lunch', 3, 2)), 5)
    assert.equal(C.mealIntake(meal(1, 'd', 'lunch', null, 4)), 4)
    assert.equal(C.mealIntake(meal(1, 'd', 'lunch', 10, 10, null)), 20)
    assert.equal(C.mealIntake(meal(1, 'd', 'lunch', null, null)), null)
    assert.equal(C.mealIntake(meal(1, 'd', 'lunch', 0, 0, 'refused')), null)
    assert.equal(C.mealIntake(meal(1, 'd', 'lunch', 5, 5, 'out')), null)
    assert.equal(C.mealIntake(undefined), null)
  })

  it('日ごとの 1 食平均（小数1桁）。間食は入れない。数えられる食事が無い日は点を作らない', () => {
    assert.ok(C, '部品が無い')
    const byDay = C.mealDays(
      [
        meal(1, '2026-10-01', 'breakfast', 10, 10),
        meal(2, '2026-10-01', 'lunch', 2, 2),
        meal(3, '2026-10-01', 'dinner', 5, 0),
        meal(4, '2026-10-01', 'snack', 1, 1),
        meal(5, '2026-10-02', 'breakfast', 3, 3, 'hospital'),
        meal(6, '2026-10-03', 'lunch', 3, 3),
      ],
      [fluid(1, '2026-10-04', 500)],
    )
    const s = C.mealIntakeSeries(byDay)
    assert.equal(s.get('2026-10-01'), 9.7)
    assert.equal(s.has('2026-10-02'), false)
    assert.equal(s.get('2026-10-03'), 6)
    assert.equal(s.has('2026-10-04'), false)
    const f = C.fluidSeries(byDay)
    assert.deepEqual([...f.entries()], [['2026-10-04', 500]])
    assert.equal(C.LOW_INTAKE_MAX, 6)
  })
})

describe('カルテ画面への組み込み', () => {
  const src = read('pages/KartePage.tsx')

  it('グラフの高さは固定の 160 ではなく、height と viewBox に同じ値を渡す（CSS px と 1:1）', () => {
    assert.ok(!/const CHART_H = 160/.test(src), '固定の高さ 160 が残っている')
    assert.ok(/height=\{height\}/.test(src), '見つからない: /height=\{height\}/')
    assert.ok(/viewBox=\{`0 0 \$\{width\} \$\{height\}`\}/.test(src), '見つからない: /viewBox=\{`0 0 \$\{width\} \$\{height\}`\}/')
  })

  it('食事・水分の表とグラフは同じ集計（mealDays）を使い、表の上にグラフを置く', () => {
    assert.ok(/mealDays\(meals, fluids\)/.test(src), '見つからない: /mealDays\(meals, fluids\)/')
    const sec = src.slice(src.indexOf('function MealsSection'))
    assert.ok(sec.indexOf('<VitalPanel') > 0 && sec.indexOf('<VitalPanel') < sec.indexOf('<table'), 'グラフが表の上にない')
  })

  it('グラフの欄だけ広げ（max-w-6xl）、印刷は今までの幅（max-w-2xl）に戻す', () => {
    assert.ok(/max-w-6xl/.test(src), '見つからない: /max-w-6xl/')
    assert.ok(/print:max-w-2xl/.test(src), '見つからない: /print:max-w-2xl/')
  })
})
