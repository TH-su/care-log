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
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { registerLoadFailure } from './ts-load.mjs'

/** 画面のファイルから宣言を抜き出して型を剥がし、名前の付いたもの（function・const）を返す（vitals-display と同じ形） */
function evalDecls(src, heads, deps = {}) {
  const part = (head) => {
    const at = src.indexOf(`\n${head}`)
    assert.ok(at >= 0, `${head} が見つからない`)
    const re = /\n(?=(?:async function |function |const |let |interface |type |export |\/\*\*|\/\/))/g
    re.lastIndex = at + 1
    const m = re.exec(src)
    return src.slice(at + 1, m ? m.index : undefined)
  }
  const js = stripTypeScriptTypes(heads.map(part).join('\n'))
  const names = heads.map((h) => /^(?:function|const|let)\s+([A-Za-z0-9_]+)/.exec(h)?.[1]).filter((n) => n !== undefined)
  return new Function(...Object.keys(deps), `${js}\nreturn { ${names.join(', ')} }`)(...Object.values(deps))
}

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

  describe('反証の直し（グラフごとの注記・「（個人の基準）」の付け方）', () => {
    it('中2: 組ごと（体温・血圧・脈）に個人の値か・変わった日を見る。体温だけの行は血圧・脈に出ない', () => {
      const look = L.thresholdsLookup([lim({ valid_from: '2026-10-10', temp_warn_high: 37.2 })], BASE)
      const days = ['2026-10-09', '2026-10-10', '2026-10-11']
      const tOn = (d) => look(7, d)
      assert.equal(days.some((d) => L.groupIsIndividual('temp', tOn(d), BASE)), true)
      assert.equal(days.some((d) => L.groupIsIndividual('bp', tOn(d), BASE)), false)
      assert.equal(days.some((d) => L.groupIsIndividual('pulse', tOn(d), BASE)), false)
      assert.equal(L.lastChangeDay(days, tOn, (a, b) => L.sameGroupLimits('temp', a, b)), '2026-10-10')
      assert.equal(L.lastChangeDay(days, tOn, (a, b) => L.sameGroupLimits('bp', a, b)), null)
      assert.equal(L.lastChangeDay(days, tOn, (a, b) => L.sameGroupLimits('pulse', a, b)), null)
      // 血圧は上・下のどちらかが個人の値なら個人
      const t = L.thresholdsFor(lim({ dia_bp_warn_low: 55 }), BASE).t
      assert.equal(L.groupIsIndividual('bp', t, BASE), true)
      assert.equal(L.sameGroupLimits('bp', t, BASE), false)
      assert.equal(L.sameGroupLimits('temp', t, BASE), true)
    })
    it('軽3: ownLevel は個人の基準で印が決まった時だけ true（施設の基準でも同じ印・印なし・SpO2 は false）', () => {
      const t = L.thresholdsFor(lim({ temp_warn_high: 37.2, sys_bp_danger_high: 160 }), BASE).t
      assert.equal(L.ownLevel('temp', 37.3, t, BASE), true)
      assert.equal(L.ownLevel('temp', 35.0, t, BASE), false, '↓↓ は施設の基準でも同じ')
      assert.equal(L.ownLevel('temp', 38.5, t, BASE), false, '↑↑ は施設の基準でも同じ')
      assert.equal(L.ownLevel('temp', 36.5, t, BASE), false, '印なし')
      assert.equal(L.ownLevel('sys_bp', 85, t, BASE), false, '↓ は施設の 90 で付いた印')
      assert.equal(L.ownLevel('sys_bp', 155, t, BASE), false, '個人の 160 で印が消えた値には付けない（印が無い）')
      assert.equal(L.ownLevel('spo2', 80, t, BASE), false)
      assert.equal(L.ownLevel('temp', 37.3, BASE, BASE), false, '個人の値が無い方')
      assert.equal(L.ownLevel('temp', null, t, BASE), false)
    })
    it('軽3: 要注意の理由は、施設の基準でも同じ印の項目に「（個人の基準）」を付けない', () => {
      const day = '2026-10-16'
      const look = L.thresholdsLookup([lim({ temp_warn_high: 37.2, sys_bp_danger_high: 160 })], T.vitalThresholds())
      const out = VA.buildDayAlerts({
        day,
        today: day,
        nowMin: 600,
        residentIds: [7],
        vitals: [vital(7, day, { temp: 35.0 }), vital(7, day, { sys_bp: 85, dia_bp: 60, measured_at: '10:00:00' }), vital(7, day, { temp: 37.3, measured_at: '11:00:00' })],
        meals: [],
        fluidTotals: new Map(),
        notes: [],
        usualTemps: new Map(),
        targets: new Map(),
        thresholdsFor: (rid) => look(rid, day),
      })
      assert.deepEqual(out[0].reasons.map((r) => r.label), ['体温 35.0↓↓', '血圧 85↓/60', '体温 37.3↑（個人の基準）'])
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

  describe('タイムライン（TimelinePage の判定）', () => {
    const src = readFileSync(new URL('../src/pages/TimelinePage.tsx', import.meta.url), 'utf8')
    const { isFever, vitalAlertBy } = evalDecls(src, ['function isFever(', 'function vitalAlertBy('], { ...T, spo2LevelFor: VA.spo2LevelFor })
    const day = '2026-10-16'
    const noJudge = { tFor: () => T.vitalThresholds(), targetOf: () => undefined }
    it('個人の値も SpO2 の個別の下限も無い方は、施設の基準だけの判定（types.ts の vitalHasAlert）と同じ', () => {
      for (const v of [
        vital(8, day, { temp: 37.4, sys_bp: 150, dia_bp: 90, pulse: 100, spo2: 93 }),
        vital(8, day, { temp: 37.5 }),
        vital(8, day, { spo2: 92 }),
        vital(8, day, { pulse: 39 }),
      ]) {
        const facility = !!(T.tempLevelBy(v.temp, BASE) || T.sysBpLevelBy(v.sys_bp, BASE) || T.diaBpLevelBy(v.dia_bp, BASE) || T.pulseLevelBy(v.pulse, BASE) || T.spo2LevelBy(v.spo2, BASE))
        assert.equal(vitalAlertBy(v, noJudge), facility)
      }
      assert.equal(isFever(vital(8, day, { temp: 37.5 }), BASE), true)
      assert.equal(isFever(vital(8, day, { temp: 37.4 }), BASE), false)
    })
    it('A5（承認済みの変化）: SpO2 は個別の下限で判定する。下限 92/88 の方の 92 は施設の基準では ↓ だが、印なし', () => {
      const tg = { id: 1, resident_id: 8, fluid_target_ml: null, spo2_warn_below: 92, spo2_danger_below: 88, rev: 1 }
      const v = vital(8, day, { spo2: 92 })
      assert.equal(T.spo2LevelBy(92, BASE), 'warn-low')
      assert.equal(vitalAlertBy(v, { ...noJudge, targetOf: () => tg }), false)
      assert.equal(vitalAlertBy(vital(8, day, { spo2: 91 }), { ...noJudge, targetOf: () => tg }), true)
    })
    it('個人の閾値はその方のその日の基準で見る（発熱の件数・基準外の一覧）', () => {
      const look = L.thresholdsLookup([lim({ temp_warn_high: 37.2 })], T.vitalThresholds())
      const judge = { tFor: look, targetOf: () => undefined }
      assert.equal(vitalAlertBy(vital(7, day, { temp: 37.3 }), judge), true)
      assert.equal(vitalAlertBy(vital(7, '2026-10-09', { temp: 37.3 }), judge), false, '開始日より前は施設の基準')
      assert.equal(vitalAlertBy(vital(8, day, { temp: 37.3 }), judge), false, '他の方は施設の基準')
      assert.equal(isFever(vital(7, day, { temp: 37.3 }), look(7, day)), true)
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
