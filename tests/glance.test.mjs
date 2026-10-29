// ひと目ボード・見守りボードの集計の純関数（src/lib/glance.ts）の試験（2026-10-29 本人承認の ROOT）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 試験 ID（ASCII・受入条件 A3 で照合する）:
//   avg-skip-missing / direction / weight-boundary-1m / weight-boundary-3m / weight-boundary-6m / fluid-80pct-boundary /
//   med-2-boundary / signs-order-max8 / hospital-outing-zero / medical-normalize / medical-state-3kinds /
//   range-sort-parse-unknown / board-sort-changes
// 境目は「ちょうど・1つ手前」を厚く。個人情報は置かない（利用者は数値ID・氏名は「架空」を名乗る作り物、病名・薬剤名も「架空」）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const TS_UNSUPPORTED =
  'この Node では TypeScript を直接読み込めないため、ひと目ボードの集計の検証をスキップしました（Node 22.18 以降で実行してください）。'

let G = null
let TH = null
let loadError = null
try {
  G = await import('../src/lib/glance.ts')
  TH = await import('../src/lib/vitalThresholds.ts')
} catch (e) {
  G = null
  loadError = e
}

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

// ── 作り物のデータ ─────────────────────────────────────────────

const TODAY = '2026-10-29'
const NOW = Date.parse('2026-10-29T12:00:00+09:00')
const RES = { id: 1, name: '架空太郎', room: '101', active: true, care_level: '要介護2', source_id: 'S-1', needs_review: false }

let seq = 1000
const nextId = () => ++seq

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function vital(day, v = {}, rid = 1, time = '09:00') {
  return {
    id: nextId(),
    resident_id: rid,
    measured_on: day,
    kind: 'routine',
    measured_at: time,
    temp: v.temp ?? null,
    sys_bp: v.sys ?? null,
    dia_bp: v.dia ?? null,
    pulse: v.pulse ?? null,
    spo2: v.spo2 ?? null,
    note: null,
    symptom: null,
    recorded_by: null,
    rev: 1,
  }
}

function meal(day, slot, main, side, status = 'eaten', rid = 1) {
  return { id: nextId(), resident_id: rid, meal_on: day, meal_slot: slot, main_amount: main, side_amount: side, status, note: null, recorded_by: null, rev: 1 }
}

function fluid(day, ml, rid = 1) {
  return { id: nextId(), resident_id: rid, taken_on: day, taken_at: null, amount_ml: ml, kind: null, recorded_by: null, rev: 1 }
}

function note(day, o = {}, rid = 1) {
  return {
    id: nextId(),
    note_on: day,
    shift: 'day',
    facility: null,
    category: null,
    resident_id: rid,
    role_tags: [],
    importance: o.importance ?? 'normal',
    body: '見本の申し送り',
    occurred_at: null,
    ongoing: o.ongoing ?? false,
    ended_at: null,
    reporter_id: null,
    color: null,
    after16: false,
    categories: o.categories ?? [],
    rev: 1,
  }
}

function medAdmin(day, slot, status, rid = 1) {
  return { id: nextId(), resident_id: rid, admin_on: day, slot, status, given_at: null, prn_drug: null, prn_reason: null, prn_effect: null, note: null, recorded_by: null, rev: 1, created_at: null, auto: false }
}

function incident(day, kind, rid = 1) {
  return { id: nextId(), kind, resident_id: rid, occurred_on: day, occurred_at: `${day}T10:00:00+09:00`, status: 'open', types: [], detail: {}, rev: 1 }
}

function outing(start, end, kind = 'overnight', rid = 1) {
  return { id: nextId(), resident_id: rid, kind, start_on: start, start_at: null, end_on: end, end_at: null, companion: null, note: null, recorded_by: null, rev: 1 }
}

/** 直近3日に毎日ふつうのバイタル（「記録の欠け」を出さないため） */
function dailyVitals(rid = 1) {
  return [0, 1, 2].map((i) => vital(addDays(TODAY, -i), { temp: 36.5, sys: 120, dia: 70, pulse: 70, spo2: 97 }, rid))
}

function input(o = {}) {
  return {
    resident: RES,
    today: TODAY,
    nowMs: NOW,
    range: '7',
    vitals: [],
    meals: [],
    fluids: [],
    outings: [],
    notes: [],
    meds: [],
    baths: [],
    incidents: [],
    usualTemp: null,
    target: null,
    weights: null,
    excretion: null,
    thresholds: TH.DEFAULT_VITAL_THRESHOLDS,
    ...o,
  }
}

const keys = (m) => m.signs.map((s) => s.key)

if (G === null) {
  registerLoadFailure('ひと目ボードの集計（glance.ts）', loadError, TS_UNSUPPORTED)
} else {
  describe('ひと目ボードの集計（src/lib/glance.ts）', () => {
    it('avg-skip-missing', () => {
      // 窓の中で値のある日だけを分母にする（欠けた日を 0 として数えない）
      const byDay = new Map([
        ['2026-10-23', 36.0],
        ['2026-10-25', 36.4],
        ['2026-10-29', 36.8],
      ])
      const r = G.windowAverage(byDay, '2026-10-23', '2026-10-29')
      assert.equal(r.days, 3)
      assert.ok(Math.abs(r.avg - 36.4) < 1e-9)
      // 入院中/外泊中の日（skip）も分母に入れない
      const s = G.windowAverage(byDay, '2026-10-23', '2026-10-29', new Set(['2026-10-29']))
      assert.equal(s.days, 2)
      assert.ok(Math.abs(s.avg - 36.2) < 1e-9)
      // 値の無い窓は null
      assert.deepEqual(G.windowAverage(byDay, '2026-09-01', '2026-09-30'), { avg: null, days: 0 })

      // 1日に2回測った日は日ごとの平均を1つとして数える（直近7日の 3日分）
      const m = G.computeGlance(
        input({
          vitals: [
            vital('2026-10-23', { temp: 36.0 }),
            vital('2026-10-25', { temp: 36.2 }, 1, '09:00'),
            vital('2026-10-25', { temp: 36.6 }, 1, '15:00'),
            vital('2026-10-29', { temp: 36.8 }),
            // 基準の期間（9/25〜10/22）
            vital('2026-10-01', { temp: 36.0 }),
            vital('2026-10-10', { temp: 36.2 }),
          ],
        }),
      )
      assert.equal(m.vitals.temp.recentDays, 3)
      assert.ok(Math.abs(m.vitals.temp.recentAvg - 36.4) < 1e-9)
      assert.equal(m.vitals.temp.baseDays, 2)
      assert.ok(Math.abs(m.vitals.temp.baseAvg - 36.1) < 1e-9)
      assert.equal(m.vitals.temp.dir, 'up')
      assert.equal(m.vitals.temp.latest.value, 36.8)
      // 温度板の14日の線は、測った日だけ値を持つ
      assert.equal(m.vitals.temp.spark.length, 14)
      assert.equal(m.vitals.temp.spark[13], 36.8)
      assert.equal(m.vitals.temp.spark[12], null)
      assert.equal(m.board.length, 14)
      assert.equal(m.board[0].day, '2026-10-16')
      assert.equal(m.board[13].temp, 36.8)
      // 基準の期間に記録が無ければ差も向きも null
      const n = G.computeGlance(input({ vitals: [vital('2026-10-29', { pulse: 70 })] }))
      assert.equal(n.vitals.pulse.baseAvg, null)
      assert.equal(n.vitals.pulse.diff, null)
      assert.equal(n.vitals.pulse.dir, null)
    })

    it('direction', () => {
      assert.equal(G.compareAverages(36.5, 36.4, 0.1).dir, 'up') // ちょうど幅（0.1）は動いた
      assert.equal(G.compareAverages(36.3, 36.4, 0.1).dir, 'down')
      assert.equal(G.compareAverages(36.44, 36.4, 0.1).dir, 'flat') // 丸めて幅に届かない差は →（画面は ±0.0）
      assert.equal(G.compareAverages(36.46, 36.4, 0.1).dir, 'up') // 丸めて +0.1 と出る差は ↑（表示と向きを食い違わせない）
      assert.equal(G.compareAverages(36.34, 36.4, 0.1).dir, 'down')
      assert.equal(G.compareAverages(36.4, 36.4, 0.1).dir, 'flat')
      assert.deepEqual(G.compareAverages(null, 36.4, 0.1), { diff: null, dir: null })
      assert.deepEqual(G.compareAverages(36.4, null, 0.1), { diff: null, dir: null })
      assert.equal(G.compareAverages(121, 120, 1).dir, 'up')
      assert.equal(G.compareAverages(120.4, 120, 1).dir, 'flat') // 画面は ±0
      assert.equal(G.compareAverages(120.5, 120, 1).dir, 'up') // 画面は +1（表示の丸めと同じ）
      assert.equal(G.DIRECTION_MARK.up, '↑')
      assert.equal(G.DIRECTION_MARK.down, '↓')
      assert.equal(G.DIRECTION_MARK.flat, '→')
    })

    it('weight-boundary-1m', () => {
      // 1か月前の日＝2026-09-29。基準はそれ以前で最も近い測定（9/28）。9/30 の測定は基準にしない
      const at = (latest) => [
        { date: '2026-09-01', weight: 52.0, mode: 'normal' },
        { date: '2026-09-28', weight: 50.0, mode: 'normal' },
        { date: '2026-09-30', weight: 49.9, mode: 'normal' },
        { date: '2026-10-28', weight: latest, mode: 'normal' },
      ]
      const p1 = (latest) => G.classifyWeightLoss(at(latest), TODAY).periods.find((p) => p.months === 1)
      assert.equal(p1(48.5).base.date, '2026-09-28')
      assert.equal(p1(48.5).lossPct, 3)
      assert.equal(p1(48.5).level, 'warn') // ちょうど 3%
      assert.equal(p1(48.6).level, null) // 2.8%
      assert.equal(p1(47.5).level, 'danger') // ちょうど 5%
      assert.equal(p1(47.6).level, 'warn') // 4.8%
      // 3か月・6か月の基準（7/29・4/29 以前）が無い → null
      const all = G.classifyWeightLoss(at(48.5), TODAY)
      assert.equal(all.periods.find((p) => p.months === 3).lossPct, null)
      assert.equal(all.periods.find((p) => p.months === 3).base, null)
      assert.equal(all.periods.find((p) => p.months === 6).level, null)
      assert.equal(all.level, 'warn')
      assert.equal(all.worst.months, 1)
      // 兆しの文は「体重 1か月で−3.0%」
      const m = G.computeGlance(input({ vitals: dailyVitals(), weights: at(48.5) }))
      const s = m.signs.find((x) => x.key === 'weight')
      assert.equal(s.label, '体重 1か月で−3.0%')
      assert.equal(s.severity, 'warn')
      // 未接続（null）は体重の札も兆しも無し・記録0件は null の期間だけ
      assert.equal(G.computeGlance(input({ weights: null })).weight, null)
      assert.equal(G.classifyWeightLoss([], TODAY).level, null)
      assert.equal(G.addMonthsIso('2026-03-31', -1), '2026-02-28')
      assert.equal(G.addMonthsIso('2026-01-15', -3), '2025-10-15')
    })

    it('weight-boundary-3m', () => {
      // 3か月前の日＝2026-07-29（ちょうどその日の測定は基準に入る）。1か月の基準（9/29）は最新と同じ重さにして当たらないようにする
      const at = (w3, latest) => [
        { date: '2026-07-29', weight: w3, mode: 'normal' },
        { date: '2026-09-29', weight: latest, mode: 'normal' },
        { date: '2026-10-28', weight: latest, mode: 'normal' },
      ]
      const p3 = (w3, latest) => G.classifyWeightLoss(at(w3, latest), TODAY).periods.find((p) => p.months === 3)
      assert.equal(p3(40.0, 37.0).base.date, '2026-07-29')
      assert.equal(p3(40.0, 37.0).level, 'danger') // ちょうど 7.5%
      assert.equal(p3(40.0, 37.1).level, 'warn') // 7.25%
      assert.equal(p3(40.0, 38.8).level, 'warn') // ちょうど 3%
      assert.equal(p3(40.0, 38.9).level, null) // 2.75%
      const r = G.classifyWeightLoss(at(40.0, 37.0), TODAY)
      assert.equal(r.periods.find((p) => p.months === 1).level, null)
      assert.equal(r.periods.find((p) => p.months === 6).lossPct, null)
      assert.equal(r.worst.months, 3)
      assert.equal(r.level, 'danger')
    })

    it('weight-boundary-6m', () => {
      // 6か月前の日＝2026-04-29。3か月・1か月の基準は最新と同じ重さ
      const at = (w6, latest) => [
        { date: '2026-04-20', weight: w6, mode: 'normal' },
        { date: '2026-07-29', weight: latest, mode: 'normal' },
        { date: '2026-09-29', weight: latest, mode: 'normal' },
        { date: '2026-10-28', weight: latest, mode: 'normal' },
      ]
      const p6 = (w6, latest) => G.classifyWeightLoss(at(w6, latest), TODAY).periods.find((p) => p.months === 6)
      assert.equal(p6(50.0, 45.0).base.date, '2026-04-20')
      assert.equal(p6(50.0, 45.0).level, 'danger') // ちょうど 10%
      assert.equal(p6(50.0, 45.1).level, 'warn') // 9.8%
      assert.equal(p6(50.0, 48.5).level, 'warn') // ちょうど 3%
      assert.equal(p6(50.0, 48.6).level, null) // 2.8%
      // 増えた時は負の減少率で、印なし
      assert.equal(p6(50.0, 51.0).lossPct, -2)
      assert.equal(p6(50.0, 51.0).level, null)
      // 基準の測定が期間の始まりより後にしか無い → null
      const late = G.classifyWeightLoss([{ date: '2026-05-10', weight: 50, mode: 'normal' }, { date: '2026-10-28', weight: 40, mode: 'normal' }], TODAY)
      assert.equal(late.periods.find((p) => p.months === 6).lossPct, null)
      assert.equal(late.periods.find((p) => p.months === 3).level, 'danger') // 3か月の基準（7/29 以前）は 5/10
    })

    it('fluid-80pct-boundary', () => {
      // 直近3日（今日を除く 10/26〜10/28）の1日平均が目標（既定 1,200ml）の 8割未満で兆し。ちょうど 8割（960ml）は当たらない
      const days = ['2026-10-26', '2026-10-27', '2026-10-28']
      const run = (ml, o = {}) => G.computeGlance(input({ vitals: dailyVitals(), fluids: days.map((d) => fluid(d, ml)), ...o }))
      assert.ok(!keys(run(960)).includes('fluid'))
      const m = run(959)
      const s = m.signs.find((x) => x.key === 'fluid')
      assert.ok(s, '959ml で水分の兆しが無い')
      assert.equal(s.severity, 'warn')
      assert.equal(s.label, '水分 3日平均 959／1,200ml（80%）')
      assert.equal(m.intake.fluid.shortAvgMl, 959)
      // 今日の少ない量は数えない（記録途中）
      const today = G.computeGlance(input({ vitals: dailyVitals(), fluids: [...days.map((d) => fluid(d, 1000)), fluid(TODAY, 100)] }))
      assert.ok(!keys(today).includes('fluid'))
      // 個別の目標（1,000ml）: 800 は当たらない・799 は当たる
      const target = { id: 1, resident_id: 1, fluid_target_ml: 1000, spo2_warn_below: null, spo2_danger_below: null, rev: 1 }
      assert.ok(!keys(run(800, { target })).includes('fluid'))
      assert.ok(keys(run(799, { target })).includes('fluid'))
      // 記録の無い日は分母に入れない（2日だけ 1,000ml）
      const two = G.computeGlance(input({ vitals: dailyVitals(), fluids: [fluid('2026-10-27', 1000), fluid('2026-10-28', 1000)] }))
      assert.equal(two.intake.fluid.shortAvgMl, 1000)
      assert.ok(!keys(two).includes('fluid'))
    })

    it('med-2-boundary', () => {
      const missingRow = (rid = 1) => ({
        residentId: rid,
        configured: ['morning', 'evening'],
        cells: { morning: { kind: 'missing' }, noon: { kind: 'none' }, evening: { kind: 'open' }, bedtime: { kind: 'none' } },
      })
      // 拒否1回だけ → 兆しなし
      const one = G.computeGlance(input({ vitals: dailyVitals(), meds: [medAdmin('2026-10-27', 'noon', 'refused')] }))
      assert.ok(!keys(one).includes('med'))
      // 拒否1回＋「未」1回 → 2回で兆し
      const two = G.computeGlance(
        input({ vitals: dailyVitals(), meds: [medAdmin('2026-10-27', 'noon', 'refused')], medRows: [{ day: '2026-10-28', row: missingRow() }] }),
      )
      const s = two.signs.find((x) => x.key === 'med')
      assert.ok(s)
      assert.equal(s.label, '与薬 未・拒否 2回（7日）')
      // 7日より前（10/22）は数えない
      const old = G.computeGlance(input({ vitals: dailyVitals(), meds: [medAdmin('2026-10-22', 'noon', 'refused'), medAdmin('2026-10-27', 'noon', 'refused')] }))
      assert.ok(!keys(old).includes('med'))
      // 同じマスの「拒否」の記録と表の記録は1回に数える・頓服は数えない
      const rec = medAdmin('2026-10-27', 'morning', 'refused')
      const dup = G.computeGlance(
        input({
          vitals: dailyVitals(),
          meds: [rec, medAdmin('2026-10-27', 'prn', 'refused')],
          medRows: [{ day: '2026-10-27', row: { residentId: 1, configured: ['morning'], cells: { morning: { kind: 'record', record: rec }, noon: { kind: 'none' }, evening: { kind: 'none' }, bedtime: { kind: 'none' } } } }],
        }),
      )
      assert.ok(!keys(dup).includes('med'))
      // 服用済みは数えない
      const taken = G.computeGlance(input({ vitals: dailyVitals(), meds: [medAdmin('2026-10-27', 'noon', 'taken'), medAdmin('2026-10-28', 'noon', 'taken')] }))
      assert.ok(!keys(taken).includes('med'))
    })

    it('signs-order-max8', () => {
      const mk = (key, severity) => ({ key, severity, column: 'temp', symbol: severity === 'danger' ? '!!' : '!', label: key, short: key, anchor: 'glance-vitals', day: null })
      const raw = [
        mk('gap', 'warn'),
        mk('note', 'danger'),
        mk('fluid', 'warn'),
        mk('temp', 'warn'),
        mk('incident', 'danger'),
        mk('med', 'warn'),
        mk('mealLow', 'warn'),
        mk('weight', 'warn'),
        mk('stool', 'danger'),
        mk('spo2', 'warn'),
      ]
      const o = G.orderSigns(raw)
      assert.equal(o.length, 8)
      assert.deepEqual(
        o.map((s) => s.key),
        ['stool', 'incident', 'note', 'temp', 'spo2', 'fluid', 'mealLow', 'weight'],
      )
      assert.equal(G.GLANCE_RULES.signsMax, 8)

      // 実際の集計でも 8件で切る（並べる前の件数は signTotal）
      const days3 = ['2026-10-26', '2026-10-27', '2026-10-28']
      const m = G.computeGlance(
        input({
          vitals: [vital(TODAY, { temp: 38.5, sys: 160, dia: 80, pulse: 110, spo2: 88 })],
          fluids: days3.map((d) => fluid(d, 300)),
          meals: days3.flatMap((d) => [meal(d, 'breakfast', 2, 2), meal(d, 'lunch', 2, 2), meal(d, 'dinner', 2, 2)]),
          meds: [medAdmin('2026-10-27', 'noon', 'refused'), medAdmin('2026-10-28', 'noon', 'refused')],
          incidents: [incident('2026-10-20', 'accident')],
          notes: [note('2026-10-20', { importance: 'critical', ongoing: true })],
          weights: [
            { date: '2026-09-20', weight: 50, mode: 'normal' },
            { date: '2026-10-28', weight: 45, mode: 'normal' },
          ],
        }),
      )
      assert.ok(m.signTotal > 8, `signTotal=${m.signTotal}`)
      assert.equal(m.signs.length, 8)
      const sev = m.signs.map((s) => s.severity)
      assert.deepEqual(sev, [...sev].sort((a, b) => (a === b ? 0 : a === 'danger' ? -1 : 1)), '要注意が注意より前に無い')
      assert.equal(m.signs[0].key, 'temp')
      assert.equal(m.signs[0].symbol, '!!')
      assert.equal(m.signs[0].anchor, G.GLANCE_ANCHORS.vitals)
      // 見守りボードのマスは 8件で切る前の全件から作る（切られた列が「なし」にならない）
      assert.equal(m.allSigns.length, m.signTotal)
      const big = input({
        vitals: [vital(TODAY, { temp: 38.5, sys: 160, dia: 80, pulse: 110, spo2: 88 })],
        fluids: days3.map((d) => fluid(d, 300)),
        meals: days3.flatMap((d) => [meal(d, 'breakfast', 2, 2), meal(d, 'lunch', 2, 2), meal(d, 'dinner', 2, 2)]),
        meds: [medAdmin('2026-10-27', 'noon', 'refused'), medAdmin('2026-10-28', 'noon', 'refused')],
        incidents: [incident('2026-10-20', 'accident')],
        notes: [note('2026-10-20', { importance: 'critical', ongoing: true })],
      })
      const brow = G.buildBoardRows({
        ...big,
        residents: [RES],
        usualTemps: new Map(),
        targets: new Map(),
        weights: new Map([[RES.id, [
          { date: '2026-09-20', weight: 50, mode: 'normal' },
          { date: '2026-10-28', weight: 45, mode: 'normal' },
        ]]]),
      })[0]
      assert.ok(brow.signCount > 8, `signCount=${brow.signCount}`)
      for (const s of m.allSigns) {
        assert.ok(brow.cells[s.column].symbol !== '', `${s.column} の印が落ちている`)
      }
      // 0件の時は空
      const none = G.computeGlance(input({ vitals: dailyVitals() }))
      assert.deepEqual(none.signs, [])
    })

    it('hospital-outing-zero', () => {
      const abnormal = {
        vitals: [vital(TODAY, { temp: 38.5, spo2: 85 }), vital('2026-10-28', { temp: 38.9 })],
        fluids: [fluid('2026-10-26', 100), fluid('2026-10-27', 100), fluid('2026-10-28', 100)],
        meds: [medAdmin('2026-10-27', 'noon', 'refused'), medAdmin('2026-10-28', 'noon', 'refused')],
      }
      // 入院中（今日の食事の状態が「入院」）→ 兆しは数えない・札は入院中
      const hosp = G.computeGlance(input({ ...abnormal, meals: [meal(TODAY, 'breakfast', null, null, 'hospital')] }))
      assert.equal(hosp.away, 'hospital')
      assert.deepEqual(hosp.signs, [])
      assert.equal(hosp.signTotal, 0)
      // 今日の食事がまだ無く、昨日が入院 → 入院中
      const yday = G.computeGlance(input({ ...abnormal, meals: [meal('2026-10-28', 'dinner', null, null, 'hospital')] }))
      assert.equal(yday.away, 'hospital')
      assert.deepEqual(yday.signs, [])
      // 外泊中（外泊の期間に今日が入る）→ 兆しは数えない
      const over = G.computeGlance(input({ ...abnormal, outings: [outing('2026-10-27', null)] }))
      assert.equal(over.away, 'overnight')
      assert.deepEqual(over.signs, [])
      assert.equal(G.AWAY_LABEL.overnight, '外泊中')
      // 日帰りの外出は不在にしない（兆しを数える）
      const day = G.computeGlance(input({ ...abnormal, outings: [outing(TODAY, TODAY, 'outing')] }))
      assert.equal(day.away, null)
      assert.ok(keys(day).includes('temp'))
      // 過去の入院の日（10/27〜10/28）の熱・記録の欠けは数えない（今日は施設に居る）
      const past = G.computeGlance(
        input({
          vitals: [vital('2026-10-28', { temp: 38.9 }), vital(TODAY, { temp: 36.5 })],
          meals: [meal('2026-10-27', 'lunch', null, null, 'hospital'), meal('2026-10-28', 'lunch', null, null, 'hospital'), meal(TODAY, 'breakfast', 8, 8)],
        }),
      )
      assert.equal(past.away, null)
      assert.ok(!keys(past).includes('temp'))
      assert.ok(!keys(past).includes('gap'))
      assert.equal(past.board[12].away, 'hospital')
      // 見守りボードでも入院中の方は印を数えない
      const rows = G.buildBoardRows({
        residents: [RES],
        today: TODAY,
        nowMs: NOW,
        vitals: abnormal.vitals,
        meals: [meal(TODAY, 'breakfast', null, null, 'hospital')],
        fluids: abnormal.fluids,
        outings: [],
        notes: [],
        meds: abnormal.meds,
        incidents: [],
        usualTemps: new Map(),
        targets: new Map(),
        weights: null,
        excretion: null,
        thresholds: TH.DEFAULT_VITAL_THRESHOLDS,
      })
      assert.equal(rows[0].away, 'hospital')
      assert.equal(rows[0].signCount, 0)
      assert.equal(rows[0].topSeverity, null)
      assert.ok(Object.values(rows[0].cells).every((c) => c.symbol === ''))
    })

    it('medical-normalize', () => {
      const v = G.normalizeMedicalRow({
        age: '85',
        allergy: '架空アレルゲンA\n\n  \n架空アレルゲンB  ',
        allergenTags: ['架空タグA', '', '  ', 12, null, true, { x: 1 }],
        forbiddenTags: null,
        swallow: { broken: true },
        mealForm: 3.5,
        diseases: [{ name: '架空病A', onset: '2020年', hospital: '架空医院' }, { name: '' }, '架空病B', { onset: '2019年' }, null, 7],
        currentDiseases: '架空病C\r\n架空病D',
        medsRegular: '架空薬B錠 1錠 朝\n\n架空薬C錠 2錠 夕\n',
        medsPrn: ['架空薬D錠', ['架空薬F錠（入れ子は捨てる）']],
        highRiskMeds: undefined,
        doctor: '架空医師',
        visitDay: '架空曜日',
        unknownField: '捨てる',
      })
      assert.equal(v.age, 85)
      assert.deepEqual(v.allergy, ['架空アレルゲンA', '架空アレルゲンB'])
      assert.deepEqual(v.allergenTags, ['架空タグA', '12'])
      assert.deepEqual(v.forbiddenTags, [])
      assert.deepEqual(v.swallow, [])
      assert.deepEqual(v.mealForm, ['3.5'])
      assert.deepEqual(v.diseases, ['架空病A（2020年・架空医院）', '架空病B'])
      assert.deepEqual(v.currentDiseases, ['架空病C', '架空病D'])
      assert.deepEqual(v.medsRegular, ['架空薬B錠 1錠 朝', '架空薬C錠 2錠 夕'])
      assert.equal(v.medsRegularCount, 2)
      assert.deepEqual(v.medsPrn, ['架空薬D錠'])
      assert.deepEqual(v.highRiskMeds, [])
      assert.deepEqual(v.doctor, ['架空医師'])
      assert.ok(!('unknownField' in v))
      // 病名表が文字だけ
      assert.deepEqual(G.normalizeMedicalRow({ diseases: '架空病A\n架空病B' }).diseases, ['架空病A', '架空病B'])
      // 壊れた形（null・配列・文字・数）でも例外を投げず、全部空
      for (const raw of [null, undefined, [], 'x', 42]) {
        const e = G.normalizeMedicalRow(raw)
        assert.equal(e.age, null)
        assert.equal(e.medsRegularCount, 0)
        assert.deepEqual(e.diseases, [])
        for (const k of G.MEDICAL_TEXT_FIELDS) assert.deepEqual(e[k], [], k)
      }
      // 年齢は 0〜130 の整数だけ
      assert.equal(G.normalizeMedicalRow({ age: 'abc' }).age, null)
      assert.equal(G.normalizeMedicalRow({ age: 85.5 }).age, null)
      assert.equal(G.normalizeMedicalRow({ age: 200 }).age, null)
      assert.equal(G.normalizeMedicalRow({ age: 92 }).age, 92)
    })

    it('medical-state-3kinds', () => {
      const linked = { source_id: 'S-1', needs_review: false }
      // 3つの見分け: no_function（関数がまだ無い）・no_shadow（写しが無い）・not_linked（照合が済んでいない）
      assert.equal(G.classifyMedicalState(linked, { kind: 'no_function' }), 'no_function')
      assert.equal(G.classifyMedicalState(linked, { kind: 'no_shadow' }), 'no_shadow')
      assert.equal(G.classifyMedicalState(linked, { kind: 'no_shadow', syncedAt: null }), 'no_shadow')
      assert.equal(G.classifyMedicalState({ source_id: '', needs_review: false }, { kind: 'ok', row: {}, syncedAt: '2026-10-29T00:00:00Z' }), 'not_linked')
      assert.equal(G.classifyMedicalState({ source_id: '  ', needs_review: false }, null), 'not_linked')
      assert.equal(G.classifyMedicalState({ source_id: 'S-1', needs_review: true }, { kind: 'no_function' }), 'not_linked')
      assert.equal(G.classifyMedicalState(null, null), 'not_linked')
      assert.equal(G.classifyMedicalState(linked, { kind: 'ok', row: {}, syncedAt: '2026-10-29T00:00:00Z' }), 'ok')
      assert.equal(G.classifyMedicalState(linked, { kind: 'error' }), 'error')
      assert.equal(G.classifyMedicalState(linked, null), 'error')
      assert.equal(G.medicalLinkable(linked), true)
      assert.equal(G.medicalLinkable({ source_id: 'S-1', needs_review: true }), false)
      // 欄の文（ROOT どおり）
      assert.equal(G.MEDICAL_STATE_MESSAGE.no_function, '病歴・内服薬の読む口がまだ用意されていません（管理者が共通 DB に 0037 を適用すると出ます）')
      assert.equal(G.MEDICAL_STATE_MESSAGE.no_shadow, '入居者マスタの写しがまだありません（管理者が入居者マスタを開くと1日1回写ります）')
      assert.equal(G.MEDICAL_STATE_MESSAGE.not_linked, 'マスタとの照合が済んでいません')
      // 写しが3日より古ければ「◯月◯日時点の写し」（日本時間の日付）
      assert.equal(G.medicalStaleText('2026-10-26T12:00:00+09:00', NOW), null) // ちょうど3日
      assert.equal(G.medicalStaleText('2026-10-26T11:59:00+09:00', NOW), '10月26日時点の写し')
      assert.equal(G.medicalStaleText('2026-10-20T16:00:00Z', NOW), '10月21日時点の写し')
      assert.equal(G.medicalStaleText(null, NOW), null)
      assert.equal(G.medicalStaleText('壊れた値', NOW), null)
    })

    it('range-sort-parse-unknown', () => {
      assert.equal(G.GLANCE_RANGE_KEY, 'cl_glanceRange')
      assert.equal(G.GLANCE_SORT_KEY, 'cl_glanceSort')
      assert.equal(G.parseGlanceRange('7'), '7')
      assert.equal(G.parseGlanceRange('14'), '14')
      for (const bad of [null, undefined, '', '30', ' 14', '14日', 14, {}, '__proto__']) assert.equal(G.parseGlanceRange(bad), '7', String(bad))
      assert.equal(G.parseGlanceSort('room'), 'room')
      assert.equal(G.parseGlanceSort('changes'), 'changes')
      for (const bad of [null, undefined, '', 'CHANGES', 'name', 1, [], 'constructor']) assert.equal(G.parseGlanceSort(bad), 'room', String(bad))
      // 期間の境目: 7日＝10/23〜10/29 対 9/25〜10/22、14日＝10/16〜10/29 対 9/18〜10/15（基準は28日で固定）
      const w7 = G.glanceWindows(TODAY, '7')
      assert.deepEqual([w7.recentFrom, w7.recentTo, w7.baseFrom, w7.baseTo], ['2026-10-23', TODAY, '2026-09-25', '2026-10-22'])
      const w14 = G.glanceWindows(TODAY, '14')
      assert.deepEqual([w14.recentFrom, w14.baseFrom, w14.baseTo], ['2026-10-16', '2026-09-18', '2026-10-15'])
      assert.equal(G.daysBetween(w14.baseFrom, w14.baseTo).length, 28)
      assert.equal(w7.boardFrom, '2026-10-16')
      assert.equal(w7.fetchFrom, '2026-09-25')
      assert.equal(w14.fetchFrom, '2026-09-18')
      // 期間を変えると平均が変わる（10/20 の値は 14日にだけ入る）
      const vs = [vital('2026-10-20', { pulse: 100 }), vital(TODAY, { pulse: 60 })]
      assert.equal(G.computeGlance(input({ vitals: vs, range: '7' })).vitals.pulse.recentAvg, 60)
      assert.equal(G.computeGlance(input({ vitals: vs, range: '14' })).vitals.pulse.recentAvg, 80)
    })

    it('board-sort-changes', () => {
      const row = (id, order, signCount, topSeverity) => ({ residentId: id, name: `架空${id}`, room: null, order, away: null, signCount, topSeverity, signs: [], cells: {}, tempSpark: [] })
      const rows = [row(1, 0, 1, 'warn'), row(2, 1, 3, 'warn'), row(3, 2, 3, 'danger'), row(4, 3, 0, null), row(5, 4, 1, 'warn'), row(6, 5, 1, 'danger')]
      const ch = G.sortBoardRows(rows, 'changes')
      // 件数の多い順 → 同じ件数は重い印の順 → 同じなら居室の順
      assert.deepEqual(
        ch.map((r) => r.residentId),
        [3, 2, 6, 1, 5, 4],
      )
      assert.deepEqual(
        G.sortBoardRows(ch, 'room').map((r) => r.residentId),
        [1, 2, 3, 4, 5, 6],
      )
      // 元の配列は変えない
      assert.deepEqual(
        rows.map((r) => r.residentId),
        [1, 2, 3, 4, 5, 6],
      )

      // 全員分の行（居室の順のまま・同じ規則）。体重・排便が未接続ならマスは「—（カルテで確認）」
      const R2 = { ...RES, id: 2, name: '架空次郎', room: '102', source_id: 'S-2' }
      const R3 = { ...RES, id: 3, name: '架空三郎', room: '103', source_id: 'S-3' }
      const built = G.buildBoardRows({
        residents: [RES, R2, R3],
        today: TODAY,
        nowMs: NOW,
        vitals: [...dailyVitals(1), ...dailyVitals(2).map((v) => ({ ...v, temp: 38.4 })), ...dailyVitals(3)],
        meals: [],
        fluids: [],
        outings: [],
        notes: [note('2026-10-20', { ongoing: true }, 3)],
        meds: [],
        incidents: [],
        usualTemps: new Map(),
        targets: new Map(),
        weights: null,
        excretion: null,
        thresholds: TH.DEFAULT_VITAL_THRESHOLDS,
      })
      assert.deepEqual(
        built.map((r) => r.residentId),
        [1, 2, 3],
      )
      assert.equal(built[0].signCount, 0)
      assert.equal(built[1].cells.temp.symbol, '!!')
      assert.equal(built[1].cells.temp.text, '38.4↑↑')
      assert.equal(built[2].cells.note.symbol, '!')
      assert.equal(built[0].cells.weight.text, G.BOARD_UNAVAILABLE_TEXT)
      assert.equal(built[0].cells.weight.unavailable, true)
      assert.equal(built[0].cells.stool.text, '—（カルテで確認）')
      assert.equal(built[0].tempSpark.length, 7)
      assert.deepEqual(
        G.sortBoardRows(built, 'changes').map((r) => r.residentId),
        [2, 3, 1],
      )
      // 与薬・事故の表が読めた時、何も無ければ空欄（読めない扱いにしない）
      assert.equal(built[0].cells.med.text, '')
      assert.equal(built[0].cells.med.unavailable, false)
      assert.equal(built[0].cells.incident.unavailable, false)
      // 与薬・事故の表が無い（meds=null / incidents=null）→ マスは「—（カルテで確認）」で「なし」と見せない
      const noTables = G.buildBoardRows({
        residents: [RES],
        today: TODAY,
        nowMs: NOW,
        vitals: dailyVitals(1),
        meals: [],
        fluids: [],
        outings: [],
        notes: [],
        meds: null,
        incidents: null,
        usualTemps: new Map(),
        targets: new Map(),
        weights: null,
        excretion: null,
        thresholds: TH.DEFAULT_VITAL_THRESHOLDS,
      })[0]
      assert.equal(noTables.cells.med.text, G.BOARD_UNAVAILABLE_TEXT)
      assert.equal(noTables.cells.med.unavailable, true)
      assert.equal(noTables.cells.med.symbol, '')
      assert.equal(noTables.cells.incident.text, G.BOARD_UNAVAILABLE_TEXT)
      assert.equal(noTables.cells.incident.unavailable, true)
      assert.equal(noTables.signCount, 0)
      // 体温の線の縦軸は全員同じ（カルテの体温の軸）
      const [lo, hi] = G.boardTempDomain(built)
      assert.ok(lo <= 36.5 && hi >= 38.4)
      assert.deepEqual(G.BOARD_COLUMNS.length, 12)
    })

    it('recent-unavailable-tables（与薬・事故の表が読めない時、ひと目ボードの最新の体調変化を「なし」にしない）', () => {
      // 読めた（空の配列）→ 読めない扱いにしない
      const ok = G.computeGlance(input({ vitals: dailyVitals() }))
      assert.equal(ok.recentChanges.medsUnavailable, false)
      assert.equal(ok.recentChanges.incidentsUnavailable, false)
      // 読めない（null）→ 欄は「—（カルテで確認）」側。件数は0で、与薬・事故の兆しも出さない
      const na = G.computeGlance(
        input({
          vitals: dailyVitals(),
          meds: null,
          incidents: null,
          // 時間帯の表があっても、記録が読めない時は「未」を数えない（空の記録から「未」を作らない）
          medRows: [{ day: TODAY, row: { residentId: 1, cells: { morning: { kind: 'missing' }, noon: { kind: 'missing' } } } }],
        }),
      )
      assert.equal(na.recentChanges.medsUnavailable, true)
      assert.equal(na.recentChanges.incidentsUnavailable, true)
      assert.equal(na.recentChanges.medIssues.length, 0)
      assert.equal(na.recentChanges.incidents.length, 0)
      assert.ok(!keys(na).includes('med'))
      assert.ok(!na.allSigns.some((x) => x.column === 'med' || x.column === 'incident'))
      // 温度板の側でも、読めない日を「なし」（0件）と見せない印が全日に付く。読めた時は付かない
      assert.ok(na.board.length > 0)
      assert.ok(na.board.every((d) => d.medsUnavailable === true && d.incidentsUnavailable === true))
      assert.ok(ok.board.every((d) => d.medsUnavailable === false && d.incidentsUnavailable === false))
    })

    it('stool-window-14d（排便の間隔と最後の排便から◯日）', () => {
      const rec = (date, amt = '中等量') => ({
        id: `r${nextId()}`,
        residentId: '1',
        type: 'stool',
        date,
        time: '08:00',
        datetime: `${date}T08:00`,
        tsUTC: Date.parse(`${date}T08:00:00+09:00`),
        stoolAmt: amt,
        cons: '',
        medicine: '',
        tablets: '',
      })
      const snap = (recs, extra = {}) => ({
        residents: [{ id: '1', key: '架空太郎', room: '101', roomLabel: '101', active: true, hidden: false, cfg: {}, hospitalizations: [], dayOnly: false, ...extra }],
        recs: new Map([['1', recs]]),
        cfg: { ...G.GLANCE_RULES.stool },
      })
      // 14日の窓（10/16〜10/29）の外（10/10）は間隔に入れない
      const x = { snap: snap([rec('2026-10-10'), rec('2026-10-20'), rec('2026-10-24'), rec('2026-10-26')]), careLog: [RES] }
      const m = G.computeGlance(input({ vitals: dailyVitals(), excretion: x }))
      const ex = m.intake.excretion
      assert.equal(ex.state, 'linked')
      assert.equal(ex.count, 3)
      assert.equal(ex.avgIntervalDays, 3)
      assert.equal(ex.status.days, 3)
      const s = m.signs.find((k) => k.key === 'stool')
      assert.equal(s.severity, 'danger') // 3日で要注意（排便記録アプリの既定）
      assert.equal(s.label, '排便なし3日')
      assert.equal(m.board.find((d) => d.day === '2026-10-24').stools, 1)
      assert.equal(m.board.find((d) => d.day === '2026-10-25').stools, 0)
      // 2日で注意
      const warn = G.computeGlance(input({ vitals: dailyVitals(), excretion: { snap: snap([rec('2026-10-27')]), careLog: [RES] } }))
      assert.equal(warn.signs.find((k) => k.key === 'stool').severity, 'warn')
      assert.equal(warn.intake.excretion.avgIntervalDays, null)
      // デイだけの方は出さない・照合できない方は unlinked・未接続は unconnected（温度板は null）
      const day = G.computeGlance(input({ vitals: dailyVitals(), excretion: { snap: snap([rec('2026-10-20')], { dayOnly: true }), careLog: [RES] } }))
      assert.ok(!keys(day).includes('stool'))
      const un = G.computeGlance(input({ vitals: dailyVitals(), excretion: { snap: snap([], { room: '999' }), careLog: [RES] } }))
      assert.equal(un.intake.excretion.state, 'unlinked')
      const none = G.computeGlance(input({ vitals: dailyVitals() }))
      assert.equal(none.intake.excretion.state, 'unconnected')
      assert.equal(none.board[0].stools, null)
    })

    it('glance-pure-imports（副作用なし・db を読まない）', () => {
      const src = read('../src/lib/glance.ts')
      assert.doesNotMatch(src, /from '\.\/(db|supabase|gasClient|cachedReads|dataCache)(\.ts)?'/)
      assert.doesNotMatch(src, /localStorage|sessionStorage|console\.|fetch\(/)
      // 相対 import は全部拡張子付き（node から直接読む）
      for (const m of src.matchAll(/from '(\.[^']+)'/g)) assert.match(m[1], /\.ts$/, m[1])
    })
  })
}
