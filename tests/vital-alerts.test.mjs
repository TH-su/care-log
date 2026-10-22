// バイタル・食事・水分の見やすさ（A1・A2・A3・A5・A6・A8・A9。2026-10-16 本人回答）のサーバー・データ層の試験。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 基準値の正本（src/lib/vitalThresholds.ts）: 既定値が今までの数と同じ・app_settings の上書きの読み取り（壊れた値は全部既定へ）・
//    types.ts の tempLevel など（今までの判定）が「いまの基準値」を読む
// 2. 判定の純関数（src/lib/vitalAlerts.ts）: A1 平熱との差・A9 SpO2 の個別の下限・A3 水分の目標・A2 摂取低下と連続日数・
//    A6 濃淡の段階・A5 今日の要注意。境目（ちょうど・1つ手前・1つ先）を厚く
// 3. db.ts（偽の Supabase・通信しない）: 基準値の読み込み・平熱の控え・個別の目標の読み書き（役割で止まる・文言）
// 4. 配線の静的検査（KartePage の帯・types.ts・移行 0034）
// サーバー（RLS・RPC）の契約は tests/vital-targets-contract.mjs（素の Postgres で tests/vital-targets-pg.mjs が流す）。
// 個人情報は置かない（利用者・職員は数値IDと記号だけ）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const TS_UNSUPPORTED =
  'この Node では TypeScript を直接読み込めないため、基準値・判定の検証をスキップしました（Node 22.18 以降で実行してください）。'
const DB_UNSUPPORTED =
  'この Node では解決フック（module.registerHooks）が使えないため、基準値・個別の目標の db.ts の検証をスキップしました（Node 22.15 以降で実行してください）。'

let TH = null
let VA = null
let T = null
let loadError = null
try {
  TH = await import('../src/lib/vitalThresholds.ts')
  VA = await import('../src/lib/vitalAlerts.ts')
  T = await import('../src/lib/types.ts')
} catch (e) {
  TH = null
  loadError = e
}

// db.ts は拡張子の無い相対 import を使うので、'.ts' を補う解決フックを入れてから読む（tests/med.test.mjs と同じ）
const lsStore = new Map()
let DB = null
let dbLoadError = null
try {
  const { registerHooks } = await import('node:module')
  if (typeof registerHooks !== 'function') throw new Error('no registerHooks')
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
  globalThis.localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => {
      lsStore.set(k, String(v))
    },
    removeItem: (k) => {
      lsStore.delete(k)
    },
  }
  DB = await import('../src/lib/db.ts')
} catch (e) {
  DB = null
  dbLoadError = e
}

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

/** Meal の最小形 */
function meal(id, residentId, day, slot, main, side, status = 'eaten') {
  return { id, resident_id: residentId, meal_on: day, meal_slot: slot, main_amount: main, side_amount: side, status, note: null, recorded_by: null, rev: 1 }
}
/** Vital の最小形 */
function vital(id, residentId, day, over = {}) {
  return {
    id,
    resident_id: residentId,
    measured_on: day,
    kind: 'routine',
    measured_at: '10:00:00',
    temp: null,
    sys_bp: null,
    dia_bp: null,
    pulse: null,
    spo2: null,
    note: null,
    symptom: null,
    recorded_by: null,
    rev: 1,
    ...over,
  }
}
/** ResidentTargets の最小形 */
function target(residentId, over = {}) {
  return { id: residentId * 10, resident_id: residentId, fluid_target_ml: null, spo2_warn_below: null, spo2_danger_below: null, rev: 1, ...over }
}

// ══════════════════════════════════════════════════════════════
// 1. 基準値の正本
// ══════════════════════════════════════════════════════════════

if (TH === null) {
  registerLoadFailure('基準値・判定の純関数', loadError, TS_UNSUPPORTED)
} else {
  describe('基準値の正本（vitalThresholds.ts・A8）', () => {
    afterEach(() => TH.applyVitalThresholds(null))

    it('既定値は今まで types.ts・KartePage にあった数と同じ（＋新しい A1〜A5 の初期値）', () => {
      assert.deepEqual(JSON.parse(JSON.stringify(TH.DEFAULT_VITAL_THRESHOLDS)), {
        temp: { dangerHigh: 38.1, warnHigh: 37.5, dangerLow: 35.5 },
        sysBp: { dangerHigh: 151, warnLow: 90 },
        diaBp: { dangerHigh: 91, warnLow: 50 },
        pulse: { dangerHigh: 101, warnLow: 40 },
        spo2: { warnBelow: 93, dangerBelow: 90 },
        lowIntakeMax: 6,
        usualTempRise: 1.0,
        mealHalf: { max: 10, minMeals: 2 },
        fluidTargetMl: 1200,
        fluidShort: { ratio: 0.6, fromHour: 16 },
      })
      assert.equal(TH.vitalThresholds(), TH.DEFAULT_VITAL_THRESHOLDS)
      assert.equal(TH.VITAL_THRESHOLDS_SETTING_KEY, 'vital_thresholds')
      assert.ok(Object.isFrozen(TH.DEFAULT_VITAL_THRESHOLDS) && Object.isFrozen(TH.DEFAULT_VITAL_THRESHOLDS.temp), '既定値を書き換えられる')
    })

    it('上書きなし（null・undefined・空・空白）は既定値・ok', () => {
      for (const raw of [null, undefined, '', '   ']) {
        const r = TH.parseVitalThresholds(raw)
        assert.equal(r.value, TH.DEFAULT_VITAL_THRESHOLDS)
        assert.equal(r.ok, true)
        assert.equal(r.reason, 'none')
      }
    })

    it('書いた項目だけが既定を上書きする（入れ子の一部だけでもよい）・知らない項目は捨てる', () => {
      const r = TH.parseVitalThresholds('{"temp":{"warnHigh":37.4},"fluidTargetMl":1300,"spo2":{"warnBelow":94,"dangerBelow":91},"unknown":1}')
      assert.equal(r.ok, true)
      assert.equal(r.reason, 'ok')
      assert.deepEqual(r.value.temp, { dangerHigh: 38.1, warnHigh: 37.4, dangerLow: 35.5 })
      assert.equal(r.value.fluidTargetMl, 1300)
      assert.deepEqual(r.value.spo2, { warnBelow: 94, dangerBelow: 91 })
      assert.equal(r.value.lowIntakeMax, 6)
      assert.equal('unknown' in r.value, false)
      // 既定値そのものは変わらない
      assert.equal(TH.DEFAULT_VITAL_THRESHOLDS.temp.warnHigh, 37.5)
    })

    it('JSON として読めない値は全部既定値（reason json）', () => {
      for (const raw of ['{', 'not json', '{"temp":}']) {
        const r = TH.parseVitalThresholds(raw)
        assert.equal(r.value, TH.DEFAULT_VITAL_THRESHOLDS)
        assert.deepEqual([r.ok, r.reason], [false, 'json'])
      }
    })

    it('形・型・範囲・順序が1つでも違えば全部既定値（一部だけ採らない）', () => {
      const bad = [
        '[1,2]', // 配列
        '42', // 数
        '"x"', // 文字
        'null',
        '{"temp":37.5}', // 入れ子のはずの所に数
        '{"temp":{"warnHigh":"37.5"}}', // 文字の数
        '{"temp":{"warnHigh":null}}',
        '{"temp":{"warnHigh":38.2}}', // 注意 > 危険（順序が逆）
        '{"temp":{"warnHigh":38.1}}', // 注意 = 危険
        '{"temp":{"dangerHigh":45.1}}', // DB の範囲の外
        '{"temp":{"dangerLow":37.5}}', // 低 ≥ 注意の高
        '{"sysBp":{"warnLow":151}}', // 注意の低 = 危険の高
        '{"diaBp":{"dangerHigh":201}}',
        '{"pulse":{"warnLow":19}}',
        '{"spo2":{"dangerBelow":94}}', // 危険 > 注意
        '{"spo2":{"warnBelow":101}}',
        '{"lowIntakeMax":6.5}', // 整数でない
        '{"lowIntakeMax":21}',
        '{"usualTempRise":0}',
        '{"usualTempRise":5.1}',
        '{"mealHalf":{"minMeals":0}}',
        '{"mealHalf":{"minMeals":4}}',
        '{"mealHalf":{"max":21}}',
        '{"fluidTargetMl":99}',
        '{"fluidTargetMl":5001}',
        '{"fluidTargetMl":1200.5}',
        '{"fluidShort":{"ratio":0}}',
        '{"fluidShort":{"ratio":1.01}}',
        '{"fluidShort":{"fromHour":24}}',
        '{"fluidTargetMl":1300,"temp":{"warnHigh":"x"}}', // 正しい項目が混ざっていても全部既定
      ]
      for (const raw of bad) {
        const r = TH.parseVitalThresholds(raw)
        assert.equal(r.value, TH.DEFAULT_VITAL_THRESHOLDS, raw)
        assert.equal(r.ok, false, raw)
      }
    })

    it('範囲の端は受け付ける（SpO2 の注意＝危険・水分 100 と 5000・割合 1・0 時と 23 時）', () => {
      for (const raw of [
        '{"spo2":{"warnBelow":90,"dangerBelow":90}}',
        '{"fluidTargetMl":100}',
        '{"fluidTargetMl":5000}',
        '{"fluidShort":{"ratio":1,"fromHour":0}}',
        '{"fluidShort":{"fromHour":23}}',
        '{"usualTempRise":0.1}',
        '{"lowIntakeMax":0}',
      ]) {
        assert.equal(TH.parseVitalThresholds(raw).ok, true, raw)
      }
    })

    it('JSON でなく物（object）を渡しても読める（ダッシュボードで jsonb にした時の保険）', () => {
      const r = TH.parseVitalThresholds({ lowIntakeMax: 5 })
      assert.equal(r.ok, true)
      assert.equal(r.value.lowIntakeMax, 5)
    })

    it('types.ts の判定（tempLevel・spo2Level・isLowIntake など）は「いまの基準値」を読む（差し替え→戻す）', () => {
      assert.equal(T.tempLevel(37.4), null)
      assert.equal(T.spo2Level(93), null)
      assert.equal(T.isLowIntake(meal(1, 1, '2026-11-01', 'lunch', 3, 3)), true)
      TH.applyVitalThresholds(TH.parseVitalThresholds('{"temp":{"warnHigh":37.4},"spo2":{"warnBelow":94,"dangerBelow":90},"lowIntakeMax":5}').value)
      assert.equal(T.tempLevel(37.4), 'warn-high')
      assert.equal(T.spo2Level(93), 'warn-low')
      assert.equal(T.isLowIntake(meal(1, 1, '2026-11-01', 'lunch', 3, 3)), false)
      TH.applyVitalThresholds(null)
      assert.equal(T.tempLevel(37.4), null)
      assert.equal(TH.vitalThresholds(), TH.DEFAULT_VITAL_THRESHOLDS)
    })

    it('判定の向きは今までと同じ（体温は以上／以下・血圧と脈は高い方が以上・低い方が未満・SpO2 は未満）', () => {
      const d = TH.DEFAULT_VITAL_THRESHOLDS
      assert.deepEqual([38.1, 38.0, 37.5, 37.4, 35.6, 35.5].map((v) => TH.tempLevelBy(v, d)), ['danger-high', 'warn-high', 'warn-high', null, null, 'danger-low'])
      assert.deepEqual([151, 150, 90, 89].map((v) => TH.sysBpLevelBy(v, d)), ['danger-high', null, null, 'warn-low'])
      assert.deepEqual([91, 90, 50, 49].map((v) => TH.diaBpLevelBy(v, d)), ['danger-high', null, null, 'warn-low'])
      assert.deepEqual([101, 100, 40, 39].map((v) => TH.pulseLevelBy(v, d)), ['danger-high', null, null, 'warn-low'])
      assert.deepEqual([93, 92, 90, 89].map((v) => TH.spo2LevelBy(v, d)), [null, 'warn-low', 'warn-low', 'danger-low'])
      assert.equal(TH.tempLevelBy(null, d), null)
    })
  })

  // ══════════════════════════════════════════════════════════════
  // 2. 判定の純関数
  // ══════════════════════════════════════════════════════════════

  describe('A1 平熱との差（judgeTemp）', () => {
    afterEach(() => TH.applyVitalThresholds(null))

    it('平熱+1.0℃ ちょうどで印（37.3−36.3 の浮動小数の誤差でも外れない）・0.9℃ では出さない', () => {
      const j = VA.judgeTemp(37.3, 36.3)
      assert.deepEqual(j, { level: null, overUsual: true, diff: 1, mark: '平熱+1.0↑', note: null })
      assert.equal(VA.judgeTemp(37.2, 36.3).overUsual, false)
      assert.equal(VA.judgeTemp(37.2, 36.3).mark, null)
      assert.equal(VA.judgeTemp(37.4, 36.3).mark, '平熱+1.1↑')
      // 37.6−36.6 も 1.0 として数える
      assert.equal(VA.judgeTemp(37.6, 36.6).overUsual, true)
    })

    it('今の印と両方当たる時は今の印（重い方）＋平熱差の注記', () => {
      assert.deepEqual(VA.judgeTemp(37.6, 36.6), { level: 'warn-high', overUsual: true, diff: 1, mark: '↑', note: '平熱+1.0' })
      assert.deepEqual(VA.judgeTemp(38.1, 36.0), { level: 'danger-high', overUsual: true, diff: 2.1, mark: '↑↑', note: '平熱+2.1' })
      // 今の印だけ（平熱との差が足りない）
      assert.deepEqual(VA.judgeTemp(37.5, 36.8), { level: 'warn-high', overUsual: false, diff: 0.7, mark: '↑', note: null })
      // 低い方
      assert.deepEqual(VA.judgeTemp(35.5, 36.5), { level: 'danger-low', overUsual: false, diff: -1, mark: '↓↓', note: null })
    })

    it('平熱なし（5回未満＝null・未取得＝undefined）・体温なしは A1 を出さない（今の印はそのまま）', () => {
      assert.deepEqual(VA.judgeTemp(37.3, null), { level: null, overUsual: false, diff: null, mark: null, note: null })
      assert.deepEqual(VA.judgeTemp(37.6, undefined), { level: 'warn-high', overUsual: false, diff: null, mark: '↑', note: null })
      assert.deepEqual(VA.judgeTemp(null, 36.5), { level: null, overUsual: false, diff: null, mark: null, note: null })
    })

    it('平熱との差の幅は基準値（usualTempRise）で変えられる', () => {
      const t = TH.parseVitalThresholds('{"usualTempRise":0.5}').value
      assert.equal(VA.judgeTemp(36.9, 36.4, t).overUsual, true)
      assert.equal(VA.judgeTemp(36.8, 36.4, t).overUsual, false)
    })

    it('平熱の表示は小数1桁', () => {
      assert.equal(VA.fmtUsualTemp(36.5), '36.5')
      assert.equal(VA.fmtUsualTemp(37), '37.0')
      assert.equal(VA.fmtUsualTemp(null), null)
      assert.equal(VA.fmtUsualTemp(undefined), null)
    })
  })

  describe('A9 SpO2 の個別の下限（spo2Limits・spo2LevelFor）', () => {
    it('個別の下限が無い方は 93 未満＝注意・90 未満＝危険（境目）', () => {
      assert.deepEqual([94, 93, 92, 90, 89, null].map((v) => VA.spo2LevelFor(v, null)), [null, null, 'warn-low', 'warn-low', 'danger-low', null])
      assert.deepEqual(VA.spo2Limits(undefined), { warnBelow: 93, dangerBelow: 90, individual: false })
    })

    it('個別の下限（注意 88・危険 85）のある方はその値で判定（境目）', () => {
      const tg = target(1, { spo2_warn_below: 88, spo2_danger_below: 85 })
      assert.deepEqual([92, 88, 87, 85, 84].map((v) => VA.spo2LevelFor(v, tg)), [null, null, 'warn-low', 'warn-low', 'danger-low'])
      assert.deepEqual(VA.spo2Limits(tg), { warnBelow: 88, dangerBelow: 85, individual: true })
    })

    it('片方だけ・逆順・範囲外の個別の下限は使わない（施設の基準に戻す）', () => {
      for (const over of [
        { spo2_warn_below: 88, spo2_danger_below: null },
        { spo2_warn_below: null, spo2_danger_below: 85 },
        { spo2_warn_below: 85, spo2_danger_below: 88 },
        { spo2_warn_below: 101, spo2_danger_below: 90 },
        { spo2_warn_below: 88, spo2_danger_below: 49 },
      ]) {
        assert.equal(VA.spo2Limits(target(1, over)).individual, false, JSON.stringify(over))
      }
      // 注意＝危険は使える（注意の帯なし）
      assert.equal(VA.spo2Limits(target(1, { spo2_warn_below: 88, spo2_danger_below: 88 })).individual, true)
    })
  })

  describe('A3 水分の目標（fluidTargetOf・fluidProgress・isFluidShort）', () => {
    it('既定 1,200ml で「800／1,200ml（67%）」・横棒は割合', () => {
      const p = VA.fluidProgress(800, null)
      assert.equal(p.label, '800／1,200ml（67%）')
      assert.deepEqual([p.total, p.target, p.percent, p.individual, p.recorded], [800, 1200, 67, false, true])
      assert.ok(Math.abs(p.bar - 800 / 1200) < 1e-12)
    })

    it('記録なし（null）は 0ml・目標を超えたら横棒は 1（百分率はそのまま）・3桁ごとのカンマ', () => {
      assert.deepEqual(
        (({ total, recorded, percent, bar, label }) => ({ total, recorded, percent, bar, label }))(VA.fluidProgress(null, null)),
        { total: 0, recorded: false, percent: 0, bar: 0, label: '0／1,200ml（0%）' },
      )
      const over = VA.fluidProgress(1350, null)
      assert.deepEqual([over.percent, over.bar, over.label], [113, 1, '1,350／1,200ml（113%）'])
      assert.equal(VA.fluidProgress(12345, target(1, { fluid_target_ml: 5000 })).label, '12,345／5,000ml（247%）')
    })

    it('個別の目標（制限のある方）はその値・範囲外の値は既定へ', () => {
      assert.deepEqual(VA.fluidTargetOf(target(1, { fluid_target_ml: 800 })), { ml: 800, individual: true })
      assert.equal(VA.fluidProgress(800, target(1, { fluid_target_ml: 800 })).label, '800／800ml（100%）')
      for (const bad of [99, 5001, 800.5]) assert.deepEqual(VA.fluidTargetOf(target(1, { fluid_target_ml: bad })), { ml: 1200, individual: false })
      assert.deepEqual(VA.fluidTargetOf(target(1, { fluid_target_ml: 100 })), { ml: 100, individual: true })
    })

    it('水分不足は目標の 60% 未満（ちょうど 60% は不足でない）', () => {
      assert.equal(VA.isFluidShort(719, null), true)
      assert.equal(VA.isFluidShort(720, null), false)
      assert.equal(VA.isFluidShort(null, null), true)
      const tg = target(1, { fluid_target_ml: 1000 })
      assert.equal(VA.isFluidShort(599, tg), true)
      assert.equal(VA.isFluidShort(600, tg), false)
    })

    it('百分率の四捨五入の境目（66.5% → 67・66.4% → 66）', () => {
      assert.equal(VA.fluidProgress(665, target(1, { fluid_target_ml: 1000 })).percent, 67)
      assert.equal(VA.fluidProgress(664, target(1, { fluid_target_ml: 1000 })).percent, 66)
    })
  })

  describe('A2 摂取低下（mealHalfOrLess・mealDayLow・mealLowStreaks・mealLowLabel）', () => {
    const D = '2026-11-10'
    it('1食の半分以下は主＋副が 10 以下（10 は該当・11 は非該当）・拒食は該当・外出／入院・未記入・間食は数えない', () => {
      assert.equal(VA.mealHalfOrLess(meal(1, 1, D, 'lunch', 5, 5)), true)
      assert.equal(VA.mealHalfOrLess(meal(1, 1, D, 'lunch', 6, 5)), false)
      assert.equal(VA.mealHalfOrLess(meal(1, 1, D, 'lunch', 10, null)), true)
      assert.equal(VA.mealHalfOrLess(meal(1, 1, D, 'lunch', null, null, null)), null)
      assert.equal(VA.mealHalfOrLess(meal(1, 1, D, 'lunch', 3, 3, null)), true, '状態が未設定でも量で数える')
      assert.equal(VA.mealHalfOrLess(meal(1, 1, D, 'lunch', null, null, 'refused')), true)
      assert.equal(VA.mealHalfOrLess(meal(1, 1, D, 'lunch', 0, 0, 'out')), null)
      assert.equal(VA.mealHalfOrLess(meal(1, 1, D, 'lunch', 0, 0, 'hospital')), null)
      assert.equal(VA.mealHalfOrLess(meal(1, 1, D, 'snack', 0, 0)), null)
      assert.equal(VA.mealHalfOrLess(undefined), null)
    })

    it('1日に2食以上が半分以下で ▼（1食だけは出さない）・拒食も数える・外出の食事は数えない', () => {
      assert.deepEqual(VA.mealDayLow([meal(1, 1, D, 'breakfast', 5, 5), meal(2, 1, D, 'lunch', 5, 5), meal(3, 1, D, 'dinner', 10, 10)]), { counted: 3, halfOrLess: 2, low: true })
      assert.deepEqual(VA.mealDayLow([meal(1, 1, D, 'breakfast', 5, 5), meal(2, 1, D, 'lunch', 6, 5), meal(3, 1, D, 'dinner', 10, 10)]), { counted: 3, halfOrLess: 1, low: false })
      assert.deepEqual(VA.mealDayLow([meal(1, 1, D, 'breakfast', null, null, 'refused'), meal(2, 1, D, 'lunch', 4, 4)]), { counted: 2, halfOrLess: 2, low: true })
      assert.deepEqual(VA.mealDayLow([meal(1, 1, D, 'breakfast', 0, 0, 'out'), meal(2, 1, D, 'lunch', 0, 0, 'out'), meal(3, 1, D, 'dinner', 2, 2)]), { counted: 1, halfOrLess: 1, low: false })
      // 間食は数えない
      assert.deepEqual(VA.mealDayLow([meal(1, 1, D, 'snack', 0, 0), meal(2, 1, D, 'lunch', 4, 4)]), { counted: 1, halfOrLess: 1, low: false })
    })

    it('同じ枠に複数の行があれば id の大きい方だけ数える（表と同じ）', () => {
      const r = VA.mealDayLow([meal(1, 1, D, 'breakfast', 2, 2), meal(9, 1, D, 'breakfast', 10, 10), meal(3, 1, D, 'lunch', 2, 2)])
      assert.deepEqual(r, { counted: 2, halfOrLess: 1, low: false })
    })

    it('基準値（mealHalf）で変えられる（3食とも・8以下）', () => {
      const t = TH.parseVitalThresholds('{"mealHalf":{"max":8,"minMeals":3}}').value
      const ms = [meal(1, 1, D, 'breakfast', 4, 4), meal(2, 1, D, 'lunch', 4, 4), meal(3, 1, D, 'dinner', 4, 5)]
      assert.equal(VA.mealDayLow(ms, t).low, false)
      assert.equal(VA.mealDayLow(ms.slice(0, 2).concat(meal(3, 1, D, 'dinner', 4, 4)), t).low, true)
    })

    it('連続日数: 続いた日は 2日目・3日目、途切れた日は 0、記録の無い日をはさむと 1 からやり直す・利用者ごと', () => {
      const low = (id, r, day) => [meal(id, r, day, 'breakfast', 3, 3), meal(id + 1, r, day, 'lunch', 3, 3)]
      const ok = (id, r, day) => [meal(id, r, day, 'breakfast', 10, 10), meal(id + 1, r, day, 'lunch', 10, 10)]
      const ms = [
        ...low(1, 1, '2026-11-01'),
        ...low(3, 1, '2026-11-02'),
        ...low(5, 1, '2026-11-03'),
        ...ok(7, 1, '2026-11-04'),
        ...low(9, 1, '2026-11-05'),
        // 11-06 は記録なし
        ...low(11, 1, '2026-11-07'),
        ...low(13, 2, '2026-10-31'), // 月をまたぐ
        ...low(15, 2, '2026-11-01'),
      ]
      const s = VA.mealLowStreaks(ms)
      const r1 = s.get(1)
      assert.deepEqual(
        ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-07'].map((d) => r1.get(d).streak),
        [1, 2, 3, 0, 1, 1],
      )
      assert.equal(r1.has('2026-11-06'), false)
      assert.deepEqual([s.get(2).get('2026-10-31').streak, s.get(2).get('2026-11-01').streak], [1, 2])
    })

    it('印の文字: 1日目は「▼摂取低下」・2日目から「▼摂取低下（N日目）」・0 は空', () => {
      assert.equal(VA.mealLowLabel(1), '▼摂取低下')
      assert.equal(VA.mealLowLabel(2), '▼摂取低下（2日目）')
      assert.equal(VA.mealLowLabel(10), '▼摂取低下（10日目）')
      assert.equal(VA.mealLowLabel(0), '')
      assert.equal(VA.mealLowLabel(Number.NaN), '')
    })
  })

  describe('A6 摂取量の濃淡（intakeShade・mealShade）', () => {
    it('主食・副食の1マス（0〜10）: 10＝4・8〜9＝3・6〜7＝2・3〜5＝1・0〜2＝0、5 以下は斜線', () => {
      const got = Array.from({ length: 11 }, (_, a) => VA.intakeShade(a))
      assert.deepEqual(
        got.map((s) => s.stage),
        [0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 4],
      )
      assert.deepEqual(
        got.map((s) => s.hatched),
        [true, true, true, true, true, true, false, false, false, false, false],
      )
      assert.equal(VA.INTAKE_SHADE_STAGES, 5)
    })

    it('値が無い・数でないは null（地を塗らない）・範囲外は端にそろえる', () => {
      assert.equal(VA.intakeShade(null), null)
      assert.equal(VA.intakeShade(undefined), null)
      assert.equal(VA.intakeShade(Number.NaN), null)
      assert.deepEqual(VA.intakeShade(12), { stage: 4, hatched: false })
      assert.deepEqual(VA.intakeShade(-1), { stage: 0, hatched: true })
    })

    it('1食（主＋副 0〜20）: 斜線は A2 と同じ 10 以下・拒食は 0（斜線）・外出と入院は null', () => {
      const D = '2026-11-10'
      assert.deepEqual(VA.mealShade(meal(1, 1, D, 'lunch', 5, 5)), { stage: 1, hatched: true })
      assert.deepEqual(VA.mealShade(meal(1, 1, D, 'lunch', 6, 5)), { stage: 2, hatched: false })
      assert.deepEqual(VA.mealShade(meal(1, 1, D, 'lunch', 8, 8)), { stage: 3, hatched: false })
      assert.deepEqual(VA.mealShade(meal(1, 1, D, 'lunch', 10, 10)), { stage: 4, hatched: false })
      assert.deepEqual(VA.mealShade(meal(1, 1, D, 'lunch', 2, 2)), { stage: 0, hatched: true })
      assert.deepEqual(VA.mealShade(meal(1, 1, D, 'lunch', null, null, 'refused')), { stage: 0, hatched: true })
      assert.equal(VA.mealShade(meal(1, 1, D, 'lunch', 0, 0, 'out')), null)
      assert.equal(VA.mealShade(meal(1, 1, D, 'lunch', null, null, 'hospital')), null)
      assert.equal(VA.mealShade(meal(1, 1, D, 'lunch', null, null)), null)
    })
  })

  describe('A5 今日の要注意（buildDayAlerts）', () => {
    const DAY = '2026-11-10'
    const base = (over = {}) => ({
      day: DAY,
      today: DAY,
      nowMin: 10 * 60,
      residentIds: [1, 2, 3],
      vitals: [],
      meals: [],
      fluidTotals: new Map(),
      notes: [],
      usualTemps: new Map(),
      targets: new Map(),
      ...over,
    })
    // 水分は全員十分（水分不足を出さない）
    const fullFluid = new Map([
      [1, 1500],
      [2, 1500],
      [3, 1500],
    ])

    it('基準外のバイタル（今の印・平熱との差・SpO2 の個別の下限）を測定の時刻順に・氏名や本文は入れない', () => {
      const out = VA.buildDayAlerts(
        base({
          fluidTotals: fullFluid,
          vitals: [
            vital(11, 1, DAY, { measured_at: '15:00:00', temp: 37.6 }), // 平熱 36.6 → ↑（平熱+1.0）
            vital(10, 1, DAY, { measured_at: '06:30:00', temp: 37.3, sys_bp: 152, dia_bp: 80 }), // 平熱+0.7 のみ（出さない）・血圧↑↑
            vital(12, 2, DAY, { temp: 37.3, spo2: 87 }), // 平熱 36.3 → 平熱+1.0↑・SpO2 個別 88/85 → ↓
            vital(13, 3, DAY, { temp: 36.5, pulse: 39, spo2: 92 }), // 脈 ↓・SpO2 既定 → ↓
            vital(14, 3, '2026-11-09', { temp: 39.0 }), // 前の日は見ない
          ],
          usualTemps: new Map([
            [1, 36.6],
            [2, 36.3],
            [3, null],
          ]),
          targets: new Map([[2, target(2, { spo2_warn_below: 88, spo2_danger_below: 85 })]]),
        }),
      )
      const flat = out.map((r) => [r.residentId, r.reasons.map((x) => [x.kind, x.section, x.severity, x.label, x.time, x.recordId])])
      assert.deepEqual(flat, [
        [
          1,
          [
            ['vital', 'vitals', 'danger', '血圧 152↑↑/80', '06:30', 10],
            ['vital', 'vitals', 'warn', '体温 37.6↑（平熱+1.0）', '15:00', 11],
          ],
        ],
        [
          2,
          [
            ['vital', 'vitals', 'warn', '体温 37.3（平熱+1.0↑）', '10:00', 12],
            ['vital', 'vitals', 'warn', 'SpO2 87%↓（個別の下限）', '10:00', 12],
          ],
        ],
        [
          3,
          [
            ['vital', 'vitals', 'warn', '脈拍 39↓', '10:00', 13],
            ['vital', 'vitals', 'warn', 'SpO2 92%↓', '10:00', 13],
          ],
        ],
      ])
    })

    it('水分不足: 今日は 16:00 から（15:59 は出さない）・過ぎた日はいつでも・先の日は出さない・終日外出／入院で記録なしは出さない', () => {
      const fl = new Map([[1, 700]])
      const ids = (o) => VA.buildDayAlerts(base({ residentIds: [1], fluidTotals: fl, ...o })).map((r) => r.reasons.map((x) => x.label))
      assert.deepEqual(ids({ nowMin: 15 * 60 + 59 }), [])
      assert.deepEqual(ids({ nowMin: 16 * 60 }), [['水分 700／1,200ml（58%）']])
      assert.deepEqual(ids({ today: '2026-11-11', nowMin: 0 }), [['水分 700／1,200ml（58%）']])
      assert.deepEqual(ids({ today: '2026-11-09', nowMin: 23 * 60 }), [])
      // 目標の 60% ちょうどは出さない
      assert.deepEqual(ids({ nowMin: 17 * 60, fluidTotals: new Map([[1, 720]]) }), [])
      // 個別の目標
      assert.deepEqual(ids({ nowMin: 17 * 60, targets: new Map([[1, target(1, { fluid_target_ml: 1000 })]]) }), [])
      // 終日外出（朝昼夕とも外出）で水分の記録なし → 出さない。記録が少しでもあれば量で見る
      const away = [meal(1, 1, DAY, 'breakfast', null, null, 'out'), meal(2, 1, DAY, 'lunch', null, null, 'out'), meal(3, 1, DAY, 'dinner', null, null, 'hospital')]
      assert.deepEqual(ids({ nowMin: 17 * 60, fluidTotals: new Map(), meals: away }), [])
      assert.deepEqual(ids({ nowMin: 17 * 60, fluidTotals: new Map([[1, 100]]), meals: away }), [['水分 100／1,200ml（8%）']])
    })

    it('摂取低下（前の日から続いていれば N日目）・最重要の申し送り（その日と続いている継続）・与薬の「未」の順', () => {
      const meals = [
        meal(1, 1, '2026-11-09', 'breakfast', 2, 2),
        meal(2, 1, '2026-11-09', 'lunch', 2, 2),
        meal(3, 1, DAY, 'breakfast', 2, 2),
        meal(4, 1, DAY, 'lunch', null, null, 'refused'),
        meal(5, 1, '2026-11-11', 'breakfast', 2, 2), // 先の日は数えない
      ]
      const note = (id, over) => ({
        id,
        note_on: DAY,
        shift: 'day',
        facility: null,
        category: null,
        resident_id: 1,
        role_tags: [],
        importance: 'critical',
        body: '記号',
        occurred_at: '09:15:00',
        ongoing: false,
        ended_at: null,
        reporter_id: null,
        color: null,
        after16: false,
        rev: 1,
        ...over,
      })
      const notes = [
        note(21, {}),
        note(22, { importance: 'important' }), // 最重要でない
        note(23, { note_on: '2026-11-05', ongoing: true }), // 続いている継続
        note(24, { note_on: '2026-11-05', ongoing: true, ended_at: '2026-11-06T00:00:00Z' }), // 終わった継続
        note(25, { note_on: '2026-11-11', ongoing: true }), // 先の日の継続
        note(26, { resident_id: null }), // 全体連絡
      ]
      const medRows = [
        {
          residentId: 1,
          configured: ['morning', 'noon'],
          cells: { morning: { kind: 'missing' }, noon: { kind: 'open' }, evening: { kind: 'none' }, bedtime: { kind: 'missing' } },
        },
        { residentId: 2, configured: ['morning'], cells: { morning: { kind: 'record', record: {} }, noon: { kind: 'none' }, evening: { kind: 'none' }, bedtime: { kind: 'none' } } },
      ]
      const out = VA.buildDayAlerts(base({ residentIds: [2, 1], meals, notes, medRows, fluidTotals: fullFluid }))
      assert.deepEqual(
        out.map((r) => [r.residentId, r.reasons.map((x) => [x.kind, x.section, x.severity, x.label, x.recordId])]),
        [
          [
            1,
            [
              ['mealLow', 'meals', 'warn', '▼摂取低下（2日目）', null],
              ['criticalNote', 'notes', 'danger', '最重要の申し送り', 21],
              ['criticalNote', 'notes', 'danger', '最重要の申し送り（継続）', 23],
              ['medMissing', 'meds', 'warn', '与薬 未（朝・眠前）', null],
            ],
          ],
        ],
      )
    })

    it('対象の方（階で絞った residentIds）に居ない方の理由は出さない・重複した ID は1回・理由の無い方は返さない', () => {
      const out = VA.buildDayAlerts(
        base({
          residentIds: [1, 1],
          fluidTotals: fullFluid,
          vitals: [vital(1, 1, DAY, { temp: 38.5 }), vital(2, 9, DAY, { temp: 39.0 })],
        }),
      )
      assert.deepEqual(out.map((r) => [r.residentId, r.reasons.length]), [[1, 1]])
      assert.deepEqual(VA.buildDayAlerts(base({ fluidTotals: fullFluid })), [])
    })

    it('fluidTotalsOf: その日の水分を利用者ごとに足す（数でない量は 0）', () => {
      const m = VA.fluidTotalsOf(
        [
          { resident_id: 1, taken_on: DAY, amount_ml: 200 },
          { resident_id: 1, taken_on: DAY, amount_ml: 150 },
          { resident_id: 1, taken_on: '2026-11-09', amount_ml: 999 },
          { resident_id: 2, taken_on: DAY, amount_ml: Number.NaN },
        ],
        DAY,
      )
      assert.deepEqual([...m], [
        [1, 350],
        [2, 0],
      ])
    })
  })

  describe('個別の目標の入力の検証（validateResidentTargets・サーバーの check 制約と同じ）', () => {
    const v = (f, w, d) => VA.validateResidentTargets({ fluid_target_ml: f, spo2_warn_below: w, spo2_danger_below: d })
    it('全部 null（個別の目標なし）・範囲の端は通る', () => {
      assert.deepEqual(v(null, null, null), { ok: true })
      assert.deepEqual(v(100, 100, 50), { ok: true })
      assert.deepEqual(v(5000, 90, 90), { ok: true })
    })
    it('水分 99・5001・小数、SpO2 の片方だけ・逆順・範囲外・小数は理由の文で止める', () => {
      assert.match(v(99, null, null).message, /水分の目標は 100〜5,000ml/)
      assert.equal(v(5001, null, null).ok, false)
      assert.equal(v(800.5, null, null).ok, false)
      assert.match(v(null, 92, null).message, /両方/)
      assert.match(v(null, null, 88).message, /両方/)
      assert.match(v(null, 88, 92).message, /同じかそれより低く/)
      assert.match(v(null, 101, 90).message, /50〜100%/)
      assert.equal(v(null, 92, 49).ok, false)
      assert.equal(v(null, 92.5, 88).ok, false)
    })
  })
}

// ══════════════════════════════════════════════════════════════
// 3. db.ts（偽の Supabase・通信しない）
// ══════════════════════════════════════════════════════════════

/** 偽の Supabase クライアント（tests/med.test.mjs と同じ形）。応答は handler(要求) が返す */
function fakeSupabase(handler) {
  const calls = []
  const builder = (q) => {
    const run = () => {
      calls.push(q)
      return Promise.resolve(handler(q))
    }
    const b = {
      select(cols) {
        if (q.action === 'select' && q.cols === undefined) q.cols = cols
        return b
      },
      insert(p) {
        q.action = 'insert'
        q.payload = p
        return b
      },
      update(p) {
        q.action = 'update'
        q.payload = p
        return b
      },
      eq(k, v) {
        q.filters.push(['eq', k, v])
        return b
      },
      is(k, v) {
        q.filters.push(['is', k, v])
        return b
      },
      in(k, v) {
        q.filters.push(['in', k, v])
        return b
      },
      limit(n) {
        q.limit = n
        return b
      },
      order(col, opts) {
        q.orders = [...(q.orders ?? []), [col, opts?.ascending !== false]]
        return b
      },
      maybeSingle: run,
      then: (ok, ng) => run().then(ok, ng),
    }
    return b
  }
  const from = (table) => builder({ table, action: 'select', payload: undefined, filters: [] })
  const rpc = (fn, args) => builder({ table: null, action: 'rpc', fn, args, payload: undefined, filters: [] })
  const channel = () => {
    const ch = { on: () => ch, subscribe: () => ch }
    return ch
  }
  return { client: { from, rpc, channel, removeChannel: () => Promise.resolve(), auth: { onAuthStateChange() {} } }, calls }
}

const OK = (data) => ({ data, error: null, status: 200 })
const ERR = (code, status = 400) => ({ data: null, error: { message: code, code }, status })

/** role＝my_account が返す役割。その他の応答は handler で */
function server(role, handler) {
  return fakeSupabase((q) => {
    if (q.action === 'rpc' && q.fn === 'my_account') return OK(role === null ? null : { role })
    return handler(q)
  })
}

async function reset() {
  await new Promise((r) => setTimeout(r, 5))
  DB.forgetMyRole()
  DB.__testHooks.setClient(null)
}

if (DB === null || TH === null) {
  registerLoadFailure('基準値・個別の目標の db.ts の検証', dbLoadError ?? loadError, DB_UNSUPPORTED, { hooks: true })
} else {
  describe('db.ts: 基準値の読み込み（loadVitalThresholds）', () => {
    afterEach(reset)

    it('app_settings の vital_thresholds を1回だけ読み、いまの基準値へ当てる（tempLevel が変わる）', async () => {
      const srv = server('field', (q) =>
        q.table === 'app_settings' ? OK({ value: '{"temp":{"warnHigh":37.3}}' }) : ERR('x'),
      )
      DB.__testHooks.setClient(srv.client)
      // setClient で既定値へ戻る（後から読み込んだ TH と db.ts が同じ部品を使っている）
      assert.equal(TH.vitalThresholds(), TH.DEFAULT_VITAL_THRESHOLDS)
      const t = await DB.loadVitalThresholds()
      assert.equal(t.temp.warnHigh, 37.3)
      assert.equal(TH.vitalThresholds().temp.warnHigh, 37.3)
      const { tempLevel } = await import('../src/lib/types.ts')
      assert.equal(tempLevel(37.3), 'warn-high')
      await DB.loadVitalThresholds()
      const reads = srv.calls.filter((q) => q.table === 'app_settings')
      assert.equal(reads.length, 1, '2回目も問い合わせた')
      assert.deepEqual(reads[0].filters, [['eq', 'key', 'vital_thresholds']])
    })

    it('壊れた値・未登録は既定値', async () => {
      for (const value of ['{"temp":{"warnHigh":"x"}}', null]) {
        DB.__testHooks.setClient(server('field', () => OK(value === null ? null : { value })).client)
        assert.equal(await DB.loadVitalThresholds(), TH.DEFAULT_VITAL_THRESHOLDS)
      }
    })

    it('読めない（通信）時は今の基準値のまま例外を投げず、次に呼ばれた時にもう一度読む', async () => {
      let fail = true
      const srv = server('field', () => (fail ? ERR('', 0) : OK({ value: '{"lowIntakeMax":5}' })))
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.loadVitalThresholds(), TH.DEFAULT_VITAL_THRESHOLDS)
      fail = false
      assert.equal((await DB.loadVitalThresholds()).lowIntakeMax, 5)
      assert.equal(srv.calls.filter((q) => q.table === 'app_settings').length, 2)
    })
  })

  describe('db.ts: 平熱（fetchUsualTemps）', () => {
    afterEach(reset)

    it('vital_usual_temps を日を渡して呼び、利用者ID → 平熱（5回未満は null）で返す・同じ日は1回だけ問い合わせる', async () => {
      const srv = server('field', (q) =>
        q.fn === 'vital_usual_temps'
          ? OK([
              { resident_id: 1, usual_temp: 36.5, samples: 30 },
              { resident_id: 2, usual_temp: null, samples: 4 },
              { resident_id: '3', usual_temp: '36.8', samples: 5 },
              { resident_id: 4, usual_temp: 52, samples: 9 }, // ありえない値は null
              { resident_id: 'x', usual_temp: 36.5, samples: 9 }, // 壊れた行は捨てる
            ])
          : ERR('x'),
      )
      DB.__testHooks.setClient(srv.client)
      const m = await DB.fetchUsualTemps('2026-11-10')
      assert.deepEqual([...m], [
        [1, 36.5],
        [2, null],
        [3, 36.8],
        [4, null],
      ])
      await DB.fetchUsualTemps('2026-11-10')
      await Promise.all([DB.fetchUsualTemps('2026-11-11'), DB.fetchUsualTemps('2026-11-11')])
      const rpcs = srv.calls.filter((q) => q.fn === 'vital_usual_temps')
      assert.deepEqual(rpcs.map((q) => q.args), [{ p_day: '2026-11-10' }, { p_day: '2026-11-11' }])
      DB.forgetUsualTemps('2026-11-10')
      await DB.fetchUsualTemps('2026-11-10')
      assert.equal(srv.calls.filter((q) => q.fn === 'vital_usual_temps').length, 3)
    })

    it('関数が無い DB（PGRST202）は空（＝平熱なし）を控える・通信できない時は空を返して控えない（例外は投げない）', async () => {
      const missing = server('field', () => ERR('PGRST202', 404))
      DB.__testHooks.setClient(missing.client)
      assert.equal((await DB.fetchUsualTemps('2026-11-10')).size, 0)
      await DB.fetchUsualTemps('2026-11-10')
      assert.equal(missing.calls.filter((q) => q.fn === 'vital_usual_temps').length, 1)

      let fail = true
      const flaky = server('field', () => (fail ? ERR('', 0) : OK([{ resident_id: 1, usual_temp: 36.4, samples: 6 }])))
      DB.__testHooks.setClient(flaky.client)
      assert.equal((await DB.fetchUsualTemps('2026-11-10')).size, 0)
      fail = false
      assert.deepEqual([...(await DB.fetchUsualTemps('2026-11-10'))], [[1, 36.4]])
    })
  })

  describe('db.ts: 個別の目標（fetchResidentTargets・saveResidentTargets）', () => {
    afterEach(reset)

    const row = (over = {}) => ({ id: 7, resident_id: 1, fluid_target_ml: 800, spo2_warn_below: null, spo2_danger_below: null, rev: 1, ...over })

    it('読む: 取り消していない行を利用者ID → 目標で返す（同じ方に2行あれば id の大きい方）・表が無い DB は空', async () => {
      const srv = server('field', (q) =>
        q.table === 'resident_targets' ? OK([row(), row({ id: 9, fluid_target_ml: 900 }), row({ id: 3, resident_id: 2, spo2_warn_below: 88, spo2_danger_below: 85 }), { id: 'x' }]) : ERR('x'),
      )
      DB.__testHooks.setClient(srv.client)
      const m = await DB.fetchResidentTargets()
      assert.deepEqual([...m.keys()], [1, 2])
      assert.equal(m.get(1).fluid_target_ml, 900)
      assert.deepEqual(m.get(2), { id: 3, resident_id: 2, fluid_target_ml: 800, spo2_warn_below: 88, spo2_danger_below: 85, rev: 1 })
      const q = srv.calls.find((c) => c.table === 'resident_targets')
      assert.deepEqual(q.filters, [['is', 'deleted_at', null]])
      DB.__testHooks.setClient(server('field', () => ERR('42P01')).client)
      assert.equal((await DB.fetchResidentTargets()).size, 0)
      DB.__testHooks.setClient(server('field', () => ERR('', 0)).client)
      await assert.rejects(() => DB.fetchResidentTargets(), (e) => e.kind === 'network')
    })

    it('現場（field）のログインは送らずに止める（文言は TARGETS_FORBIDDEN_MESSAGE）', async () => {
      const srv = server('field', () => OK(row()))
      DB.__testHooks.setClient(srv.client)
      await assert.rejects(
        () => DB.saveResidentTargets(1, { fluid_target_ml: 800, spo2_warn_below: null, spo2_danger_below: null }, null),
        (e) => e.kind === 'forbidden' && e.message === DB.TARGETS_FORBIDDEN_MESSAGE,
      )
      assert.equal(srv.calls.filter((q) => q.table === 'resident_targets').length, 0)
      assert.equal(DB.canEditTargets('field'), false)
      assert.equal(DB.canEditTargets(null), false)
      assert.equal(DB.canEditTargets('office'), true)
      assert.equal(DB.canEditTargets('admin'), true)
      assert.match(DB.TARGETS_FORBIDDEN_MESSAGE, /事務・管理者のログインだけ/)
    })

    it('事務（office）: 無ければ client_key・edited_by 付きで足す／あれば rev 照合で変える（値を全部 null にしても行は残す）', async () => {
      const srv = server('office', (q) => {
        if (q.table !== 'resident_targets') return ERR('x')
        if (q.action === 'insert') return OK({ ...row(), ...q.payload, id: 7, rev: 1 })
        if (q.action === 'update') return OK({ ...row(), ...q.payload, rev: 2 })
        return ERR('x')
      })
      DB.__testHooks.setClient(srv.client)
      DB.setEditor(5)
      const ins = await DB.saveResidentTargets(1, { fluid_target_ml: 800, spo2_warn_below: null, spo2_danger_below: null }, null)
      assert.deepEqual(ins, row())
      const iq = srv.calls.find((q) => q.action === 'insert')
      assert.equal(typeof iq.payload.client_key, 'string')
      assert.equal(iq.payload.edited_by, 5)
      assert.deepEqual(
        { r: iq.payload.resident_id, f: iq.payload.fluid_target_ml, w: iq.payload.spo2_warn_below, d: iq.payload.spo2_danger_below },
        { r: 1, f: 800, w: null, d: null },
      )
      const upd = await DB.saveResidentTargets(1, { fluid_target_ml: null, spo2_warn_below: null, spo2_danger_below: null }, ins)
      assert.deepEqual(upd, { ...row(), fluid_target_ml: null, rev: 2 })
      const uq = srv.calls.find((q) => q.action === 'update')
      assert.deepEqual(uq.filters, [
        ['eq', 'id', 7],
        ['eq', 'rev', 1],
        ['is', 'deleted_at', null],
      ])
      assert.deepEqual(uq.payload, { fluid_target_ml: null, spo2_warn_below: null, spo2_danger_below: null, edited_by: 5 })
      DB.setEditor(null)
    })

    it('他の端末が先に足した（23505）・先に変えた（0行）は conflict', async () => {
      DB.__testHooks.setClient(server('admin', (q) => (q.action === 'insert' ? ERR('23505', 409) : OK(null))).client)
      assert.equal(await DB.saveResidentTargets(1, { fluid_target_ml: 800, spo2_warn_below: null, spo2_danger_below: null }, null), 'conflict')
      assert.equal(await DB.saveResidentTargets(1, { fluid_target_ml: 900, spo2_warn_below: null, spo2_danger_below: null }, row()), 'conflict')
    })

    it('サーバーの RLS で止まった（42501）: 役割が分からなければ目標の文言・事務と分かっていれば許可リストの文言', async () => {
      DB.__testHooks.setClient(server(null, () => ERR('42501', 403)).client)
      await assert.rejects(
        () => DB.saveResidentTargets(1, { fluid_target_ml: 800, spo2_warn_below: null, spo2_danger_below: null }, null),
        (e) => e.kind === 'forbidden' && e.message === DB.TARGETS_FORBIDDEN_MESSAGE,
      )
      DB.forgetMyRole()
      DB.__testHooks.setClient(server('office', () => ERR('42501', 403)).client)
      await assert.rejects(
        () => DB.saveResidentTargets(1, { fluid_target_ml: 800, spo2_warn_below: null, spo2_danger_below: null }, row()),
        (e) => e.kind === 'forbidden' && e.message === DB.FORBIDDEN_REASON,
      )
    })

    it('表が無い DB・範囲外（23514）・通信できない・入力の誤り・別の方の current は、それぞれの文言で止める（書かない）', async () => {
      const input = { fluid_target_ml: 800, spo2_warn_below: null, spo2_danger_below: null }
      DB.__testHooks.setClient(server('office', () => ERR('42P01')).client)
      await assert.rejects(() => DB.saveResidentTargets(1, input, null), (e) => e.kind === 'server' && /サーバー側の設定待ち/.test(e.message))
      DB.__testHooks.setClient(server('office', () => ERR('23514')).client)
      await assert.rejects(() => DB.saveResidentTargets(1, input, null), (e) => e.kind === 'server' && /範囲/.test(e.message))
      DB.__testHooks.setClient(server('office', () => ERR('', 0)).client)
      await assert.rejects(() => DB.saveResidentTargets(1, input, null), (e) => e.kind === 'network')
      const srv = server('office', () => OK(row()))
      DB.__testHooks.setClient(srv.client)
      await assert.rejects(() => DB.saveResidentTargets(1, { fluid_target_ml: 50, spo2_warn_below: null, spo2_danger_below: null }, null), (e) => e.kind === 'server' && /100〜5,000ml/.test(e.message))
      await assert.rejects(() => DB.saveResidentTargets(2, input, row()), (e) => e.kind === 'server')
      assert.equal(srv.calls.filter((q) => q.table === 'resident_targets').length, 0)
    })
  })
}

// ══════════════════════════════════════════════════════════════
// 4. 配線の静的検査
// ══════════════════════════════════════════════════════════════

describe('配線: 基準値は1か所（types.ts・KartePage・chart.ts）・移行 0034', () => {
  it('types.ts の判定は数を持たず vitalThresholds.ts を拡張子付きで読む（node から直接読める）', () => {
    const s = read('../src/lib/types.ts')
    assert.match(s, /from '\.\/vitalThresholds\.ts'/)
    const body = s.slice(s.indexOf('export function tempLevel'), s.indexOf('// 色だけに頼らない記号'))
    assert.doesNotMatch(body, /38\.1|37\.5|35\.5|151|\b93\b|\b101\b/, '判定に数が残っている')
    assert.doesNotMatch(s.slice(s.indexOf('export function isLowIntake')), /<= 6\b/)
  })

  it('KartePage の帯・基準線・低摂取の線は基準値から作る（数の書き込みが無い）', () => {
    const s = read('../src/pages/KartePage.tsx')
    // 段階2d-2: 点の判定（sysBpLevelBy など）も同じ vitalThresholds.ts から読む（固定し直し・意図は同じ＝基準値は1か所）
    assert.match(s, /import \{[^}]*\bvitalThresholds\b[^}]*\} from '\.\.\/lib\/vitalThresholds'/)
    for (const lit of ["label: '38.1'", "label: '37.5'", "label: '35.5'", "label: '上151'", "label: '下91'", "label: '上90'", "label: '下50'", "label: '101'", "label: '40'", "label: '90'", "label: '93'"]) {
      assert.ok(!s.includes(lit), `KartePage に ${lit} が残っている`)
    }
    assert.doesNotMatch(s, /LOW_INTAKE_MAX/)
  })

  it('chart.ts の LOW_INTAKE_MAX は既定値の写し（6）', async () => {
    const C = await import('../src/lib/chart.ts')
    assert.equal(C.LOW_INTAKE_MAX, 6)
    assert.match(read('../src/lib/chart.ts'), /LOW_INTAKE_MAX: number = DEFAULT_VITAL_THRESHOLDS\.lowIntakeMax/)
  })

  it('0034: 表・RLS（書くのは office と admin・has_role が無ければ false）・平熱の RPC（invoker・anon 不可）・Realtime に載せない', () => {
    const s = read('../supabase/migrations/0034_resident_targets_usual_temp.sql')
    const code = s.replace(/--[^\n]*/g, '')
    assert.match(code, /create table if not exists public\.resident_targets/)
    assert.match(code, /create unique index if not exists uq_resident_targets_resident\s+on public\.resident_targets \(resident_id\)\s+where deleted_at is null/)
    assert.match(code, /to_regprocedure\('private\.has_role\(text\[\]\)'\) is null then\s+return false/)
    assert.match(code, /variadic array\[''office'', ''admin''\]/)
    assert.match(code, /for insert to authenticated\s+with check \(private\.resident_targets_writable\(\)\)/)
    assert.match(code, /for update to authenticated\s+using \(true\) with check \(private\.resident_targets_writable\(\)\)/)
    assert.doesNotMatch(code, /for delete/)
    assert.match(code, /revoke all on public\.resident_targets from anon/)
    assert.match(code, /create or replace function public\.vital_usual_temps\(p_day date default null\)[\s\S]*?security invoker\s+set search_path = public, pg_temp/)
    assert.match(code, /v\.kind = 'routine'/)
    assert.match(code, /count\(\*\) >= 5/)
    assert.match(code, /between d\.day - 29 and d\.day/)
    assert.match(code, /revoke execute on function public\.vital_usual_temps\(date\) from anon/)
    assert.doesNotMatch(code, /alter publication/)
    assert.match(code, /record_history_capture\('updated_at'\)/)
  })

  it('値の範囲は画面とサーバーで同じ（水分 100〜5000・SpO2 50〜100）', async () => {
    const TH2 = await import('../src/lib/vitalThresholds.ts')
    const s = read('../supabase/migrations/0034_resident_targets_usual_temp.sql')
    assert.deepEqual([...TH2.FLUID_TARGET_RANGE], [100, 5000])
    assert.deepEqual([...TH2.SPO2_LIMIT_RANGE], [50, 100])
    assert.match(s, /fluid_target_ml between 100 and 5000/)
    assert.match(s, /spo2_warn_below between 50 and 100/)
    assert.match(s, /spo2_danger_below between 50 and 100/)
  })

  it('PG の契約試験の実行器がある（pg-run-all が拾う形）', () => {
    const s = read('./vital-targets-pg.mjs')
    assert.match(s, /from '\.\/vital-targets-contract\.mjs'/)
    assert.match(s, /test\.role/)
  })
})

describe('変更の記録の表示: 個別の目標（0034 の record_history）を日本語の名前で出す', () => {
  it('表の呼び名と3つの列の名前がある（生の表名・列名を画面に出さない）', async () => {
    const HV = await import('../src/lib/historyView.ts')
    assert.equal(HV.HISTORY_TABLE_LABEL.resident_targets, '個別の目標')
    assert.equal(HV.historyColumnLabel('resident_targets', 'fluid_target_ml'), '水分の目標（ml）')
    assert.equal(HV.historyColumnLabel('resident_targets', 'spo2_warn_below'), 'SpO2 の注意の下限')
    assert.equal(HV.historyColumnLabel('resident_targets', 'spo2_danger_below'), 'SpO2 の危険の下限')
    assert.equal(HV.historyColumnLabel('resident_targets', 'deleted_at'), '取り消し')
    assert.equal(HV.historyColumnLabel('resident_targets', 'client_key'), null)
  })
})
