// 段階2d-2: 個人のバイタルの閾値を記録の画面の判定に効かせる部品の回帰テスト（2026-10-23・段階2の計画 v1 の 3.2・5章・質問11）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. その方・その日の基準を引く口（vitalLimits.ts の thresholdsLookup）: 個人の値が無い方は施設の基準そのもの（同じ物）を返す
//    ＝今と同じ印になることの土台。期間の中で基準が変わった日（lastChangeDay）と知らせの文（changedFromText）
// 2. 温度板（tempSheetModel.ts）: 点の印はその日の基準・線と凡例は期間の最後の日の基準・変わった日。個人の値が無い方は今と同じ組み立て
// 3. 要注意（vitalAlerts.ts の buildDayAlerts）: その方の基準で判定し、個人の基準で当たった項目に「（個人の基準）」。無い方は今と同じ
// 4. デイ（daycare.ts）: vitalLevel・isFeverTemp・dailyFeverObservations・vitalNeedsRecheck・firstAbnormalField が基準を受ける
// 個人情報は置かない（利用者は数値IDだけ・値は試験用の架空の数）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerLoadFailure } from './ts-load.mjs'

let L = null
let T = null
let VA = null
let TS = null
let DC = null
let loadError = null
try {
  L = await import('../src/lib/vitalLimits.ts')
  T = await import('../src/lib/vitalThresholds.ts')
  VA = await import('../src/lib/vitalAlerts.ts')
  TS = await import('../src/components/print/tempSheetModel.ts')
  DC = await import('../src/lib/daycare.ts')
} catch (e) {
  loadError = e
  L = null
}

/** 個人の閾値の行（値は架空） */
const lim = (over = {}) => ({
  id: 1,
  resident_id: 7,
  valid_from: '2026-10-10',
  temp_warn_high: null,
  temp_danger_high: null,
  temp_danger_low: null,
  sys_bp_danger_high: null,
  sys_bp_warn_low: null,
  dia_bp_danger_high: null,
  dia_bp_warn_low: null,
  pulse_danger_high: null,
  pulse_warn_low: null,
  basis: '主治医の指示（試験）',
  set_by: 1,
  rev: 1,
  created_at: '2026-10-10T01:00:00Z',
  ...over,
})
let vid = 100
const vital = (rid, day, over = {}) => ({
  id: vid++,
  resident_id: rid,
  measured_on: day,
  kind: 'routine',
  measured_at: '09:00:00',
  temp: null,
  sys_bp: null,
  dia_bp: null,
  pulse: null,
  spo2: null,
  note: null,
  symptom: null,
  recorded_by: 1,
  rev: 1,
  ...over,
})

if (L === null) {
  registerLoadFailure('段階2d-2（個人の閾値を判定に効かせる）の試験', loadError, 'この Node では TypeScript を直接読み込めません（Node 22.18 以降で実行してください）')
} else {
  const BASE = T.DEFAULT_VITAL_THRESHOLDS

  describe('その方・その日の基準を引く口（thresholdsLookup）', () => {
    it('行が無い・null（読めない）時は、どの方・どの日も施設の基準そのもの（同じ物）', () => {
      for (const rows of [null, []]) {
        const look = L.thresholdsLookup(rows, BASE)
        assert.equal(look(1, '2026-10-01'), BASE)
        assert.equal(look(7, '2026-10-20'), BASE)
      }
    })
    it('行のある方でも、開始日より前の日・他の方は施設の基準そのもの。開始日から個人の値（同じ日は同じ物を返す）', () => {
      const look = L.thresholdsLookup([lim({ temp_warn_high: 37.2 })], BASE)
      assert.equal(look(7, '2026-10-09'), BASE)
      assert.equal(look(8, '2026-10-20'), BASE)
      const t = look(7, '2026-10-10')
      assert.notEqual(t, BASE)
      assert.equal(t.temp.warnHigh, 37.2)
      assert.equal(t.temp.dangerHigh, BASE.temp.dangerHigh)
      assert.equal(t.sysBp, BASE.sysBp, '施設の基準のままの組は同じ物')
      assert.equal(look(7, '2026-10-10'), t, '控え')
    })
    it('全部空欄の行（施設の基準に戻す）・崩れて施設の基準に戻した項目だけの行は、施設の基準そのもの', () => {
      const look = L.thresholdsLookup([lim(), lim({ id: 2, resident_id: 8, temp_warn_high: 38.5 })], BASE)
      assert.equal(look(7, '2026-10-20'), BASE)
      assert.equal(look(8, '2026-10-20'), BASE)
    })
    it('isIndividualField: 個人の値で作った組だけ true（SpO2 は個別の目標の側なので常に false）', () => {
      const t = L.thresholdsFor(lim({ pulse_danger_high: 90 }), BASE).t
      assert.equal(L.isIndividualField('pulse', t, BASE), true)
      assert.equal(L.isIndividualField('temp', t, BASE), false)
      assert.equal(L.isIndividualField('sys_bp', t, BASE), false)
      assert.equal(L.isIndividualField('spo2', t, BASE), false)
      assert.equal(L.isIndividualField('pulse', BASE, BASE), false)
    })
  })

  describe('期間の中で基準が変わった日（lastChangeDay・changedFromText）', () => {
    const days = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']
    it('変わらなければ null（個人の値が無い方・期間の前から同じ基準の方）', () => {
      assert.equal(L.lastChangeDay(days, () => BASE), null)
      const look = L.thresholdsLookup([lim({ valid_from: '2026-10-01', temp_warn_high: 37.2 })], BASE)
      assert.equal(L.lastChangeDay(days, (d) => look(7, d)), null)
    })
    it('期間の中で変わった一番新しい日。中身が同じ行に替わっただけの日は数えない', () => {
      const look = L.thresholdsLookup(
        [lim({ valid_from: '2026-10-09', temp_warn_high: 37.2 }), lim({ id: 2, valid_from: '2026-10-10', temp_warn_high: 37.2 }), lim({ id: 3, valid_from: '2026-10-11', pulse_danger_high: 95 })],
        BASE,
      )
      assert.equal(L.lastChangeDay(days, (d) => look(7, d)), '2026-10-11')
      assert.equal(L.lastChangeDay(days.slice(0, 3), (d) => look(7, d)), '2026-10-09')
    })
    it('知らせの文は承認の文言そのまま（「〇/〇から基準が変わりました」・0 を付けない）', () => {
      assert.equal(L.changedFromText('2026-10-09'), '10/9から基準が変わりました')
      assert.equal(L.changedFromText('2026-01-22'), '1/22から基準が変わりました')
    })
  })

  describe('温度板（tempSheetModel.ts）', () => {
    const today = '2026-10-16'
    const days = TS.sheetDays(today)
    const vitals = [
      vital(7, '2026-10-05', { temp: 37.3, sys_bp: 116, pulse: 92 }),
      vital(7, '2026-10-14', { temp: 37.3, sys_bp: 116, pulse: 92 }),
      vital(7, today, { temp: 37.6, sys_bp: 120, pulse: 70, spo2: 96 }),
    ]
    const input = { days, residentId: 7, vitals, meals: [], fluids: [], usual: null, target: null }
    it('個人の値が無い方は、基準の口を渡しても渡さなくても同じ組み立て（変わった日は null）', () => {
      const a = TS.buildTempSheet(input)
      const look = L.thresholdsLookup([lim({ resident_id: 8, temp_warn_high: 37.0 })], BASE)
      const b = TS.buildTempSheet({ ...input, thresholdsFor: (d) => look(7, d) })
      assert.deepEqual(b, a)
      assert.equal(a.changedFrom, null)
    })
    it('点の印はその日の基準・線と凡例は期間の最後の日の基準・変わった日を出す', () => {
      const look = L.thresholdsLookup([lim({ valid_from: '2026-10-12', temp_warn_high: 37.2, sys_bp_warn_low: 118, pulse_danger_high: 90 })], BASE)
      const m = TS.buildTempSheet({ ...input, thresholdsFor: (d) => look(7, d) })
      const i5 = days.indexOf('2026-10-05')
      const i14 = days.indexOf('2026-10-14')
      assert.equal(m.tempMarks[i5], null, '開始日より前は施設の基準（37.3 は印なし）')
      assert.equal(m.tempMarks[i14], '↑', '開始日から個人の基準（37.3↑）')
      assert.equal(m.sysMarks[i5], null)
      assert.equal(m.sysMarks[i14], '↓')
      assert.equal(m.pulseMarks[i5], null)
      assert.equal(m.pulseMarks[i14], '↑↑')
      assert.equal(m.thresholds.temp.warnHigh, 37.2, '線は最後の日の基準')
      assert.equal(m.thresholds.sysBp.warnLow, 118)
      assert.equal(m.changedFrom, '2026-10-12')
    })
    it('食事・水分の基準（▲・目標）は個人の閾値に左右されない', () => {
      const look = L.thresholdsLookup([lim({ valid_from: '2026-10-12', temp_warn_high: 37.2 })], BASE)
      const m = TS.buildTempSheet({ ...input, thresholdsFor: (d) => look(7, d) })
      const a = TS.buildTempSheet(input)
      assert.deepEqual(m.meals, a.meals)
      assert.deepEqual(m.fluid, a.fluid)
      assert.deepEqual(m.fluidTarget, a.fluidTarget)
    })
  })

  describe('要注意（buildDayAlerts）', () => {
    const day = '2026-10-16'
    const base = {
      day,
      today: day,
      nowMin: 10 * 60,
      residentIds: [7, 8],
      vitals: [vital(7, day, { temp: 37.3, sys_bp: 116, dia_bp: 70, pulse: 92 }), vital(8, day, { temp: 37.3, sys_bp: 116, dia_bp: 70, pulse: 92 })],
      meals: [],
      fluidTotals: new Map(),
      notes: [],
      usualTemps: new Map(),
      targets: new Map(),
    }
    it('個人の値が無い方は、基準の口を渡しても渡さなくても同じ結果', () => {
      const a = VA.buildDayAlerts(base)
      const b = VA.buildDayAlerts({ ...base, thresholdsFor: () => T.vitalThresholds() })
      assert.deepEqual(b, a)
      assert.deepEqual(a, [])
    })
    it('個人の基準で当たった項目に「（個人の基準）」。他の方・施設の基準のままの項目には付けない', () => {
      const look = L.thresholdsLookup([lim({ temp_warn_high: 37.2, pulse_danger_high: 90 })], T.vitalThresholds())
      const out = VA.buildDayAlerts({ ...base, thresholdsFor: (rid) => look(rid, day) })
      assert.equal(out.length, 1)
      assert.equal(out[0].residentId, 7)
      assert.deepEqual(
        out[0].reasons.map((r) => [r.severity, r.label]),
        [
          ['warn', '体温 37.3↑（個人の基準）'],
          ['danger', '脈拍 92↑↑（個人の基準）'],
        ],
      )
    })
    it('血圧は上下の重い方・どちらかが個人の基準で当たれば注記', () => {
      const look = L.thresholdsLookup([lim({ sys_bp_warn_low: 118 })], T.vitalThresholds())
      const out = VA.buildDayAlerts({ ...base, thresholdsFor: (rid) => look(rid, day) })
      assert.deepEqual(out[0].reasons.map((r) => r.label), ['血圧 116↓/70（個人の基準）'])
    })
  })

  describe('デイ（daycare.ts）', () => {
    const t = L.thresholdsFor(lim({ temp_warn_high: 37.2, sys_bp_warn_low: 118, pulse_danger_high: 90 }), BASE).t
    it('vitalLevel: 基準を省くと施設の基準（今と同じ）・渡すとその基準', () => {
      assert.equal(DC.vitalLevel('temp', 37.3), null)
      assert.equal(DC.vitalLevel('temp', 37.3, null, BASE), null)
      assert.equal(DC.vitalLevel('temp', 37.3, null, t), 'warn-high')
      assert.equal(DC.vitalLevel('sys_bp', 116, null, t), 'warn-low')
      assert.equal(DC.vitalLevel('pulse', 90, null, t), 'danger-high')
      assert.equal(DC.vitalLevel('spo2', 92, null, t), 'warn-low', 'SpO2 は施設の基準（個人の閾値に無い）')
    })
    it('isFeverTemp・vitalNeedsRecheck・firstAbnormalField も基準を受ける（省くと施設の基準）', () => {
      assert.equal(DC.isFeverTemp(37.3), false)
      assert.equal(DC.isFeverTemp(37.3, t), true)
      assert.equal(DC.vitalNeedsRecheck({ temp: 36.5, sys_bp: 116, pulse: 70 }), false)
      assert.equal(DC.vitalNeedsRecheck({ temp: 36.5, sys_bp: 116, pulse: 70 }, null, t), true)
      assert.equal(DC.firstAbnormalField({ temp: 36.5, sys_bp: 120, pulse: 95 }), 'temp')
      assert.equal(DC.firstAbnormalField({ temp: 36.5, sys_bp: 120, pulse: 95 }, null, t), 'pulse')
    })
    it('dailyFeverObservations: その方の基準で発熱を見る（個人の値が無い方は今と同じ選び方）', () => {
      const list = [
        { id: 1, resident_id: 7, temp: 37.3 },
        { id: 2, resident_id: 8, temp: 37.3 },
        { id: 3, resident_id: 9, temp: 37.6 },
      ]
      const ids = [1, 2, 3]
      assert.deepEqual(DC.dailyFeverObservations(list, ids).map((v) => v.id), [3])
      assert.deepEqual(DC.dailyFeverObservations(list, ids, undefined, () => BASE).map((v) => v.id), [3])
      assert.deepEqual(DC.dailyFeverObservations(list, ids, undefined, (rid) => (rid === 7 ? t : BASE)).map((v) => v.id), [1, 3])
    })
  })
}
