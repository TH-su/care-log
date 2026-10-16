// バイタル・食事・水分の見やすさ（A1・A2・A3・A5・A6・A7・A9。2026-10-16 本人回答）の画面側の試験。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 今日の要注意（/alerts）の純関数（src/pages/alertsModel.ts）: 日本時間の今日・階の UI 状態の復元（既知値だけ）・
//    カルテの欄への行き先（?sec= の許可リスト）・申し送りの重複の除き方
// 2. 温度板（A7）の組み立て（src/components/print/tempSheetModel.ts）: 14日の並び・1日1点の選び方・食事のマスの文字と斜線・
//    摂取低下の印・水分の目標比・縦軸
// 3. 配線の静的検査: カルテ（平熱の点線・A1/A9 の印・A2/A6/A3・個別の目標の欄・温度板の印刷）・App.tsx（ルートと入口）・
//    MorePage（入口）・印刷の既存の部品（PrintArea・print.css）を変えていないこと
// サーバー・判定の純関数（vitalAlerts.ts）の試験は tests/vital-alerts.test.mjs。
// 個人情報は置かない（利用者・職員は数値IDだけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const exists = (p) => existsSync(new URL(p, import.meta.url))
// 行コメントと複数行コメントを除いた本文（コメントの言葉に試験が反応しないように）
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

let AM = null
let amError = null
try {
  AM = await import('../src/pages/alertsModel.ts')
} catch (e) {
  amError = e
}
let TS = null
let tsError = null
try {
  TS = await import('../src/components/print/tempSheetModel.ts')
} catch (e) {
  tsError = e
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
/** Meal の最小形 */
function meal(id, residentId, day, slot, main, side, status = 'eaten') {
  return { id, resident_id: residentId, meal_on: day, meal_slot: slot, main_amount: main, side_amount: side, status, note: null, recorded_by: null, rev: 1 }
}
function fluid(id, residentId, day, ml) {
  return { id, resident_id: residentId, taken_on: day, taken_at: '10:00:00', amount_ml: ml, kind: null, recorded_by: null, rev: 1 }
}

// ══════════════════════════════════════════════════════════════
// 1. 今日の要注意の純関数
// ══════════════════════════════════════════════════════════════

if (AM === null) {
  registerLoadFailure('今日の要注意の純関数（alertsModel.ts）', amError, 'この Node では TypeScript を直接読み込めません。')
} else {
  describe('今日の要注意（alertsModel.ts）', () => {
    it('今日と時刻は日本時間で決める（端末の時刻帯に左右されない）', () => {
      // 2026-10-16 15:30 UTC = 2026-10-17 0:30 JST
      assert.deepEqual(AM.jstClock(Date.UTC(2026, 9, 16, 15, 30)), { day: '2026-10-17', nowMin: 30 })
      // 2026-10-16 7:59 UTC = 16:59 JST（夕方の水分不足の境目の1分前）
      assert.deepEqual(AM.jstClock(Date.UTC(2026, 9, 16, 7, 59)), { day: '2026-10-16', nowMin: 16 * 60 + 59 })
      // 年をまたぐ
      assert.deepEqual(AM.jstClock(Date.UTC(2026, 11, 31, 15, 0)), { day: '2027-01-01', nowMin: 0 })
      // 壊れた時刻でも落ちない（null）
      assert.equal(AM.jstClock(Number.NaN), null)
    })

    it('階の UI 状態は既知の形だけを復元する（壊れた値・未知値は null＝既定の「全」）', () => {
      assert.equal(AM.ALERTS_FLOOR_KEY, 'cl_alertsFloor')
      for (const ok of ['1', '2', '9', 'all', 'other']) assert.equal(AM.readAlertsFloor(ok), ok)
      for (const ng of [null, '', '12', 'x', 'ALL', ' 1', '1 ', '<script>', '{"a":1}']) assert.equal(AM.readAlertsFloor(ng), null)
    })

    it('居室から階（数字が無い・空は other）', () => {
      assert.equal(AM.floorOf('102'), '1')
      assert.equal(AM.floorOf('215'), '2')
      assert.equal(AM.floorOf(null), 'other')
      assert.equal(AM.floorOf(''), 'other')
      assert.equal(AM.floorOf('別館'), 'other')
    })

    it('理由を押した先はカルテのその欄（?sec= に欄の id。与薬は karte-med）', () => {
      assert.equal(AM.alertHref(12, 'vitals'), '/karte/12?sec=karte-vitals')
      assert.equal(AM.alertHref(12, 'meals'), '/karte/12?sec=karte-meals')
      assert.equal(AM.alertHref(12, 'notes'), '/karte/12?sec=karte-notes')
      assert.equal(AM.alertHref(12, 'meds'), '/karte/12?sec=karte-med')
    })

    it('カルテの ?sec= は許可リストの欄だけを受ける（未知・壊れた値は null）', () => {
      const allowed = ['karte-vitals', 'karte-meals', 'karte-notes', 'karte-med']
      assert.equal(AM.karteSecOf('karte-meals', allowed), 'karte-meals')
      for (const ng of [null, '', 'karte-x', 'KARTE-MEALS', 'karte-meals#', '../x']) assert.equal(AM.karteSecOf(ng, allowed), null)
    })

    it('申し送りと継続（pinned）を id で重ねない', () => {
      const a = { id: 1, note_on: '2026-10-16' }
      const b = { id: 2, note_on: '2026-10-10' }
      const out = AM.mergeNotes([a], [b, { ...a }])
      assert.deepEqual(out.map((n) => n.id), [1, 2])
      assert.deepEqual(AM.mergeNotes(null, undefined), [])
    })

    it('日付の足し引き（月・年をまたぐ）', () => {
      assert.equal(AM.addDaysIso('2026-10-01', -1), '2026-09-30')
      assert.equal(AM.addDaysIso('2026-12-31', 1), '2027-01-01')
    })
  })
}

// ══════════════════════════════════════════════════════════════
// 2. 温度板の組み立て
// ══════════════════════════════════════════════════════════════

if (TS === null) {
  registerLoadFailure('温度板の組み立て（tempSheetModel.ts）', tsError, 'この Node では TypeScript を直接読み込めません。')
} else {
  describe('温度板（tempSheetModel.ts・A7）', () => {
    const today = '2026-10-16'

    it('今日を含む14日を古い順に並べる', () => {
      const days = TS.sheetDays(today)
      assert.equal(days.length, 14)
      assert.equal(days[0], '2026-10-03')
      assert.equal(days[13], today)
      assert.equal(TS.TEMP_SHEET_DAYS, 14)
    })

    it('1日1点（定時を優先・同じ区分は時刻の早い方）。範囲の外の日・他の方の記録は使わない', () => {
      const days = TS.sheetDays(today)
      const m = TS.buildTempSheet({
        days,
        residentId: 5,
        vitals: [
          vital(1, 5, today, { kind: 'observation', measured_at: '08:00:00', temp: 38.4 }),
          vital(2, 5, today, { kind: 'routine', measured_at: '10:00:00', temp: 36.6, sys_bp: 120, dia_bp: 70, pulse: 72, spo2: 97 }),
          vital(3, 5, '2026-10-02', { temp: 39 }),
          vital(4, 6, today, { temp: 39 }),
        ],
        meals: [],
        fluids: [],
        usual: 36.2,
        target: null,
      })
      assert.equal(m.temp[13], 36.6)
      assert.equal(m.sys[13], 120)
      assert.equal(m.dia[13], 70)
      assert.equal(m.pulse[13], 72)
      assert.equal(m.spo2[13], 97)
      assert.equal(m.temp[0], null)
      assert.equal(m.temp.length, 14)
    })

    it('体温の印は今の基準（↑・↑↑）を優先し、平熱+1.0℃以上だけの時は「平熱+…↑」', () => {
      const days = TS.sheetDays(today)
      const m = TS.buildTempSheet({
        days,
        residentId: 5,
        vitals: [vital(1, 5, days[12], { temp: 37.2 }), vital(2, 5, days[13], { temp: 37.6 }), vital(3, 5, days[11], { temp: 36.9 })],
        meals: [],
        fluids: [],
        usual: 36.2,
        target: null,
      })
      assert.equal(m.tempMarks[12], '平熱+1.0↑')
      assert.equal(m.tempMarks[13], '↑')
      assert.equal(m.tempMarks[11], null)
    })

    it('平熱が無い（5回未満）時は平熱の線も A1 の印も出さない', () => {
      const days = TS.sheetDays(today)
      const m = TS.buildTempSheet({ days, residentId: 5, vitals: [vital(1, 5, days[13], { temp: 37.3 })], meals: [], fluids: [], usual: null, target: null })
      assert.equal(m.usual, null)
      assert.equal(m.tempMarks[13], null)
    })

    it('SpO2 は個別の下限があればそれで判定し、線もその値', () => {
      const days = TS.sheetDays(today)
      const target = { id: 1, resident_id: 5, fluid_target_ml: 800, spo2_warn_below: 90, spo2_danger_below: 85, rev: 1 }
      const m = TS.buildTempSheet({ days, residentId: 5, vitals: [vital(1, 5, days[13], { spo2: 91 }), vital(2, 5, days[12], { spo2: 89 })], meals: [], fluids: [], usual: null, target })
      assert.deepEqual(m.spo2Limits, { warnBelow: 90, dangerBelow: 85, individual: true })
      assert.equal(m.spo2Marks[13], null)
      assert.equal(m.spo2Marks[12], '↓')
    })

    it('食事のマス: 主／副の数・拒食・外出・入院の文字、半分以下（主＋副10以下・拒食）は斜線、6以下は ▲', () => {
      const days = TS.sheetDays(today)
      const d = days[13]
      const m = TS.buildTempSheet({
        days,
        residentId: 5,
        vitals: [],
        meals: [
          meal(1, 5, d, 'breakfast', 8, 7),
          meal(2, 5, d, 'lunch', 5, 5),
          meal(3, 5, d, 'dinner', 3, 2),
          meal(4, 5, days[12], 'breakfast', null, null, 'refused'),
          meal(5, 5, days[12], 'lunch', null, null, 'out'),
          meal(6, 5, days[12], 'dinner', null, null, 'hospital'),
          // 同じ枠に2行ある時は id の大きい方（表と同じ）
          meal(8, 5, days[11], 'breakfast', 10, 10),
          meal(7, 5, days[11], 'breakfast', 1, 1),
        ],
        fluids: [],
        usual: null,
        target: null,
      })
      assert.deepEqual(m.meals.breakfast[13], { text: '8/7', hatched: false })
      assert.deepEqual(m.meals.lunch[13], { text: '5/5', hatched: true })
      assert.deepEqual(m.meals.dinner[13], { text: '▲3/2', hatched: true })
      assert.deepEqual(m.meals.breakfast[12], { text: '拒', hatched: true })
      assert.deepEqual(m.meals.lunch[12], { text: '外', hatched: false })
      assert.deepEqual(m.meals.dinner[12], { text: '入', hatched: false })
      assert.deepEqual(m.meals.breakfast[11], { text: '10/10', hatched: false })
      assert.deepEqual(m.meals.breakfast[0], { text: '', hatched: false })
    })

    it('摂取低下（A2）の印: 1日目は ▼・続けば ▼2日目（表示の外の前の日も数える）', () => {
      const days = TS.sheetDays(today)
      const lowDay = (id, day) => [meal(id, 5, day, 'breakfast', 3, 3), meal(id + 1, 5, day, 'lunch', 4, 4), meal(id + 2, 5, day, 'dinner', 9, 9)]
      const m = TS.buildTempSheet({
        days,
        residentId: 5,
        vitals: [],
        meals: [...lowDay(10, '2026-10-02'), ...lowDay(20, days[0]), ...lowDay(30, days[12]), ...lowDay(40, days[13])],
        fluids: [],
        usual: null,
        target: null,
      })
      assert.equal(m.lowLabels[0], '▼2日目')
      assert.equal(m.lowLabels[1], '')
      assert.equal(m.lowLabels[12], '▼')
      assert.equal(m.lowLabels[13], '▼2日目')
    })

    it('水分（A3）: 日合計と目標比（記録なしは空）。個別の目標があればそれ', () => {
      const days = TS.sheetDays(today)
      const m = TS.buildTempSheet({
        days,
        residentId: 5,
        vitals: [],
        meals: [],
        fluids: [fluid(1, 5, days[13], 500), fluid(2, 5, days[13], 300), fluid(3, 5, days[12], 1300), fluid(4, 6, days[13], 999)],
        usual: null,
        target: { id: 1, resident_id: 5, fluid_target_ml: 1000, spo2_warn_below: null, spo2_danger_below: null, rev: 1 },
      })
      assert.deepEqual(m.fluidTarget, { ml: 1000, individual: true })
      assert.deepEqual(m.fluid[13], { total: '800', ratio: '80%' })
      assert.deepEqual(m.fluid[12], { total: '1300', ratio: '130%' })
      assert.deepEqual(m.fluid[0], { total: '', ratio: '' })
    })

    it('縦軸: 既定の範囲に値がはみ出したら刻みの単位で広げる', () => {
      assert.deepEqual(TS.axisRange([], [35, 39], 0.5), [35, 39])
      assert.deepEqual(TS.axisRange([36.5, 37.0], [35, 39], 0.5), [35, 39])
      assert.deepEqual(TS.axisRange([39.6], [35, 39], 0.5), [35, 40])
      assert.deepEqual(TS.axisRange([34.2], [35, 39], 0.5), [34, 39])
      assert.deepEqual(TS.axisRange([null, Number.NaN], [80, 100], 5), [80, 100])
    })

    it('縦の位置: 範囲の上端が上・下端が下・外は端に止める', () => {
      assert.equal(TS.scaleY(39, [35, 39], 10, 50), 10)
      assert.equal(TS.scaleY(35, [35, 39], 10, 50), 50)
      assert.equal(TS.scaleY(37, [35, 39], 10, 50), 30)
      assert.equal(TS.scaleY(45, [35, 39], 10, 50), 10)
    })
  })
}

// ══════════════════════════════════════════════════════════════
// 3. 配線の静的検査
// ══════════════════════════════════════════════════════════════

describe('カルテの配線（A1・A2・A3・A6・A7・A9・個別の目標）', () => {
  const src = () => code('../src/pages/KartePage.tsx')

  it('平熱は fetchUsualTemps、個別の目標は fetchResidentTargets、基準値は loadVitalThresholds を待ってから描く', () => {
    const s = src()
    assert.match(s, /fetchUsualTemp(s|Details)\(/)
    assert.match(s, /fetchResidentTargets\(/)
    assert.match(s, /loadVitalThresholds\(/)
  })

  it('体温のグラフ: 平熱の点線（inline のラベル）と A1 の印（judgeTemp）', () => {
    const s = src()
    assert.match(s, /judgeTemp\(/)
    assert.match(s, /dash: '1\.5 3'/)
    assert.match(s, /平熱 \$\{/)
    assert.match(s, /30日の定時の中央値/)
    assert.match(s, /markOf\?\(v: number\): string \| null/)
  })

  it('SpO2: 個別の下限（spo2LevelFor・spo2Limits）で判定し、個別の下限の線を引く', () => {
    const s = src()
    assert.match(s, /spo2LevelFor\(/)
    assert.match(s, /spo2Limits\(/)
    assert.match(s, /個別の下限/)
  })

  it('食事の表: A6 の濃淡（地は .cl-shade-bg-N＝--cl-shade-N-bg・文字は --cl-shade-N-ink・斜線は cl-shade-hatch）・A2 の ▼摂取低下・▲低摂取は残す', () => {
    const s = src()
    assert.match(s, /`cl-shade-bg-\$\{stage\}`/)
    assert.match(s, /var\(--cl-shade-\$\{[^}]+\}-ink\)/)
    assert.match(s, /cl-shade-hatch/)
    assert.match(s, /mealShade\(/)
    assert.match(s, /mealLowStreaks\(/)
    assert.match(s, /mealLowLabel\(/)
    assert.match(s, /isLowIntake\(meal\)/)
    assert.match(s, /<span className="sr-only">低摂取 <\/span>/)
  })

  it('水分: 目標との比（fluidProgress）と横棒', () => {
    const s = src()
    assert.match(s, /fluidProgress\(/)
    assert.match(s, /role="presentation"|aria-hidden="true" data-fluid-bar/)
  })

  it('個別の目標: 書けるのは canEditTargets の時だけ。保存は saveResidentTargets・競合は読み直して選ぶ・文言はそのまま', () => {
    const s = src()
    assert.match(s, /canEditTargets\(role\)/)
    assert.match(s, /fetchMyRole\(/)
    assert.match(s, /subscribeMyRole\(/)
    assert.match(s, /saveResidentTargets\(/)
    assert.match(s, /validateResidentTargets\(/)
    assert.match(s, /=== 'conflict'/)
    assert.match(s, /e instanceof DbError \? e\.message/)
    // 入力欄は書ける時だけ描く（役割が分かるまでは何も出さない）
    assert.match(s, /\{role === undefined \? null : canEdit \? \(/)
  })

  it('個別の目標の欄は移動ボタンの欄（SectionCard の id）を増やさない（2026-10-16 に排泄を足して9つ。個別の目標は無いまま）', () => {
    const s = read('../src/pages/KartePage.tsx')
    const listSrc = s.slice(s.indexOf('export const KARTE_JUMPS'), s.indexOf('function findShellHeader'))
    assert.equal([...listSrc.matchAll(/id: '([^']+)'/g)].length, 9)
    assert.equal(/目標/.test(listSrc), false)
  })

  it('?sec= で欄へ移る（許可リストは KARTE_JUMPS の id）', () => {
    const s = src()
    assert.match(s, /useSearchParams\(/)
    assert.match(s, /karteSecOf\(/)
    assert.match(s, /KARTE_JUMPS\.map\(\(j\) => j\.id\)/)
  })

  it('温度板: ボタンを押した時だけ印刷部品を置く（Ctrl+P のカルテの印刷は今までどおり）', () => {
    const s = src()
    assert.match(s, /温度板を印刷/)
    assert.match(s, /\{sheetOpen \? \(\s*<TempSheetPrint/)
    assert.match(s, /buildTempSheet\(/)
  })

  it('カルテは localStorage を使わない（期間 cl_karteRange の読み書きは LS 経由のまま）', () => {
    const s = src()
    const uses = [...s.matchAll(/localStorage\.(getItem|setItem|removeItem)\(([^)]*)\)/g)].map((m) => m[2].split(',')[0].trim())
    assert.deepEqual([...new Set(uses)], ['LS.karteRange'])
  })
})

describe('温度板の印刷部品（src/components/print/）', () => {
  it('既存の PrintArea を A4 縦で使う・既存の print.css と PrintArea.tsx は温度板の都合で書き換えない', () => {
    assert.ok(exists('../src/components/print/TempSheet.tsx'))
    const t = code('../src/components/print/TempSheet.tsx')
    assert.match(t, /<PrintArea ref=\{printRef\} orientation="portrait"/)
    assert.match(t, /import '\.\/tempSheet\.css'/)
    assert.doesNotMatch(read('../src/components/print/print.css'), /\.ts-|temp-sheet|tempSheet/)
    assert.doesNotMatch(read('../src/components/print/PrintArea.tsx'), /TempSheet|tempSheet/)
  })

  it('斜線は SVG の線で描く（CSS の背景は紙に出ないため使わない）・白地に黒（currentColor）', () => {
    const t = code('../src/components/print/TempSheet.tsx')
    assert.match(t, /className="ts-hatch"/)
    assert.match(t, /stroke="currentColor"/)
    const css = read('../src/components/print/tempSheet.css')
    assert.doesNotMatch(css, /background(-image)?:\s*(repeating-)?linear-gradient/)
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}\b/)
  })

  it('印刷が終わったら（afterprint）部品を外す', () => {
    const t = code('../src/components/print/TempSheet.tsx')
    assert.match(t, /addEventListener\('afterprint'/)
    assert.match(t, /removeEventListener\('afterprint'/)
  })
})

describe('今日の要注意の画面と入口（App.tsx・MorePage）', () => {
  it('画面がある（buildDayAlerts・日本時間・階の保存は既知値だけ・console を使わない）', () => {
    assert.ok(exists('../src/pages/AlertsPage.tsx'))
    const s = code('../src/pages/AlertsPage.tsx')
    assert.match(s, /buildDayAlerts\(/)
    assert.match(s, /jstClock\(/)
    assert.match(s, /readAlertsFloor\(/)
    assert.match(s, /localStorage\.setItem\(ALERTS_FLOOR_KEY/)
    assert.doesNotMatch(s, /console\./)
    // 読み込みに失敗しても落ちない（目標・平熱・与薬は失敗しても続ける）
    assert.match(s, /fetchResidentTargets\(\)\.catch\(/)
    assert.match(s, /alertHref\(/)
  })

  it('App.tsx: /alerts のルート・既知値 alerts・左レール・「その他」の配下・画面名', () => {
    const s = code('../src/App.tsx')
    assert.match(s, /<Route path="\/alerts" element=\{<AlertsPage/)
    assert.match(s, /'alerts',/)
    assert.match(s, /alerts: '\/alerts'/)
    assert.match(s, /if \(pathname === '\/alerts'\) return 'alerts'/)
    assert.match(s, /\{ view: 'alerts', to: '\/alerts', label: '要注意' \}/)
    assert.match(s, /if \(pathname === '\/alerts'\) return '今日の要注意'/)
    const more = s.slice(s.indexOf('const MORE_VIEWS'), s.indexOf('const ICON_PATHS'))
    assert.match(more, /'alerts'/)
    // 下部タブは5つのまま（その他から入る）
    const bottom = s.slice(s.indexOf('const NAV_BOTTOM'), s.indexOf('const NAV_RAIL'))
    assert.equal([...bottom.matchAll(/view: '/g)].length, 5)
  })

  it('MorePage: 「今日の要注意」の入口（既存の項目の並びは変えず末尾に足す）', () => {
    const s = code('../src/pages/MorePage.tsx')
    assert.match(s, /to: '\/alerts'/)
    const keys = [...s.slice(s.indexOf('const ITEMS'), s.indexOf('const ICON_PATHS')).matchAll(/key: '([a-zA-Z]+)'/g)].map((m) => m[1])
    assert.deepEqual(keys, ['search', 'timeline', 'record', 'settings', 'bathMonth', 'medSlots', 'medMonth', 'incident', 'incidentSummary', 'alerts'])
  })
})
