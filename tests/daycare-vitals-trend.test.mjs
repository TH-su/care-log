// デイ（せせらぎ）計画F: 1人の画面のバイタルの推移（直近の回）の小さなグラフの回帰テスト（2026-11-10）。
// 正本: 改善計画 v1 §3 の F・親の指示（SQL・新しい表・RPC なし／二軸にしない／基準外は連絡帳と同じ判定／数値も出す／色だけに頼らない）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycareVitalsTrend.ts）: 回の並べ方（表示中の日の行＋前の日の行・再測定も1回・値の無い行を数えない・
//    直近10回）・〔未測定〕の印（値の無い欄だけ・読めない時は「読み込めませんでした」）・判定はその回の日の基準で連絡帳と同じ
//    （vitalNeedsRecheck と一致）・線を値の無い回で切る・ラベルの選び方（重ならない分だけ）・横軸の日付・表と押した時の言葉・
//    読み上げの要約・0回／1回の状態・縦軸はカルテのグラフと同じ chartDomain
// 2. db.ts を偽の Supabase で動かす（通信しない）: fetchDaycareVitalsTrend の2本の問い合わせ（絞り込み・並び・上限・読むだけ）・
//    印の表が無い DB は印なし・印を読めない時は null・測定を読めない時は例外
// 3. 静的検査: 1人の画面の置き場（バイタルの欄の入力の後）・基準は画面の lookup・部品は読むだけ・端末に残さない・色は既存の変数だけ・
//    SVG は role="img" と読み上げの要約・表は本物の table・動きを付けない
// 個人情報は置かない（利用者は数値IDだけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
/** 行コメントと複数行コメントを除いた本文 */
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const lsStore = new Map()
let T = null
let DC = null
let CT = null
let CH = null
let VT = null
let DB = null
let MEMO = null
let loadError = null
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
  T = await import('../src/lib/daycareVitalsTrend.ts')
  DC = await import('../src/lib/daycare.ts')
  CT = await import('../src/lib/daycareContact.ts')
  CH = await import('../src/lib/chart.ts')
  VT = await import('../src/lib/vitalThresholds.ts')
  DB = await import('../src/lib/db.ts?daycare-vitals-trend')
  MEMO = await import('../src/lib/daycareDayMemo.ts')
} catch (e) {
  loadError = e
  T = null
}

// ── 見本のデータ（氏名は持たない） ──
let vid = 1000
const vital = (residentId, day, seq, vals = {}, over = {}) => ({
  id: vid++,
  resident_id: residentId,
  measured_on: day,
  kind: 'routine',
  measured_at: '10:05:00',
  temp: null,
  sys_bp: null,
  dia_bp: null,
  pulse: null,
  spo2: null,
  note: null,
  symptom: null,
  recorded_by: 1,
  rev: 1,
  client_key: `dc:${day}:${residentId}:${seq}`,
  ...vals,
  ...over,
})
const mark = (residentId, day, seq, field, id = vid++) => ({ id, resident_id: residentId, day, seq, field, rev: 1 })
const days = (n, from = '2026-10-01') => {
  const out = []
  const d = new Date(`${from}T00:00:00Z`)
  for (let i = 0; i < n; i += 1) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

if (T === null) {
  registerLoadFailure('デイ 計画F（バイタルの推移）の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  const base = () => VT.DEFAULT_VITAL_THRESHOLDS
  const limitsOf = () => base()

  describe('回の並べ方（trendRounds）', () => {
    it('表示中の日の行（その方・その日の分だけ）＋前の日の行。並びは日 → 回の番号 → id の古い順・同じ id は表示中の日の行を使う', () => {
      const day = '2026-11-10'
      const today1 = vital(7, day, 1, { temp: 36.5 })
      const today2 = vital(7, day, 2, { temp: 37.8 })
      const other = vital(8, day, 1, { temp: 36.0 })
      const yesterday = vital(7, '2026-11-09', 1, { sys_bp: 120, dia_bp: 70 })
      const older = vital(7, '2026-11-01', 1, { pulse: 70 })
      // 前の日の読み込みに表示中の日の行が混ざっても数えない（表示中の日は画面の行だけ）
      const stalePast = { ...today1, temp: 40.1 }
      const r = T.trendRounds([today2, other, today1], [yesterday, stalePast, older], 7, day, [])
      assert.deepEqual(
        r.map((x) => [x.day, x.seq]),
        [
          ['2026-11-01', 1],
          ['2026-11-09', 1],
          ['2026-11-10', 1],
          ['2026-11-10', 2],
        ],
      )
      assert.equal(r[2].vals.temp, 36.5, '表示中の日は画面の行の値')
      assert.equal(r[3].hm, '10:05')
    })
    it('今日の再測定も1回と数え、直近10回だけ（古い側を落とす）。値の無い行・デイ以外の行・表示中の日より後の行は数えない', () => {
      const ds = days(12)
      const day = ds[11]
      const past = ds.slice(0, 11).map((d) => vital(7, d, 1, { pulse: 60 }))
      const blank = vital(7, ds[10], 2) // 値の無い行（打ちかけを消した行など）
      const notDc = vital(7, ds[10], 3, { pulse: 99 }, { client_key: 'routine-key' })
      const future = vital(7, '2026-12-31', 1, { pulse: 99 })
      const now = [vital(7, day, 1, { pulse: 70 }), vital(7, day, 2, { pulse: 72 })]
      const r = T.trendRounds(now, [...past, blank, notDc, future], 7, day, [])
      assert.equal(r.length, T.TREND_ROUNDS)
      assert.equal(T.TREND_ROUNDS, 10)
      assert.deepEqual(
        r.slice(-3).map((x) => [x.day, x.seq, x.vals.pulse]),
        [
          [ds[10], 1, 60],
          [day, 1, 70],
          [day, 2, 72],
        ],
      )
      assert.equal(r[0].day, ds[3], '古い側が落ちる')
      assert.ok(r.every((x) => x.vals.pulse !== 99))
    })
    it('〔未測定〕の印: 値の無い欄だけ（値があれば値）・同じ回（日と回の番号）の印だけ・行の無い回の印は回を作らない', () => {
      const day = '2026-11-10'
      const a = vital(7, '2026-11-09', 1, { sys_bp: 130, dia_bp: 80 }) // SpO2 は空
      const b = vital(7, day, 1, { temp: 36.4 })
      const marks = [
        mark(7, '2026-11-09', 1, 'spo2'),
        mark(7, '2026-11-09', 1, 'sys_bp'), // 値がある欄の印は無視
        mark(7, '2026-11-09', 2, 'pulse'), // 行の無い回
        mark(8, day, 1, 'pulse'), // ほかの方
        mark(7, day, 1, 'pulse'),
      ]
      const r = T.trendRounds([b], [a], 7, day, marks)
      assert.equal(r.length, 2)
      assert.deepEqual(r[0].unmeasured, ['spo2'])
      assert.deepEqual(r[1].unmeasured, ['pulse'])
      const bp = T.TREND_PANELS.find((p) => p.key === 'bp')
      const sp = T.TREND_PANELS.find((p) => p.key === 'spo2')
      const pu = T.TREND_PANELS.find((p) => p.key === 'pulse')
      const lv = () => null
      assert.equal(T.trendCell(sp, r[0], lv, false).text, CT.UNMEASURED)
      assert.equal(T.trendCell(bp, r[0], lv, false).text, '130/80')
      assert.equal(T.trendCell(pu, r[0], lv, false).text, T.TREND_NONE, '印の無い空の欄は —')
      assert.equal(T.trendCell(pu, r[1], lv, false).text, CT.UNMEASURED)
      // 印を読めなかった時: 値の無い欄は「読み込めませんでした」（記録なし・未測定と取り違えない）。値のある欄は値
      const r2 = T.trendRounds([b], [a], 7, day, null)
      assert.deepEqual(r2[0].unmeasured, [])
      assert.equal(T.trendCell(sp, r2[0], lv, true).text, CT.UNREAD)
      assert.equal(T.trendCell(bp, r2[0], lv, true).text, '130/80')
    })
  })

  describe('判定（連絡帳と同じ・その回の日の基準）', () => {
    it('vitalLevel を通す: 連絡帳の vitalNeedsRecheck（紙の看護職の欄を出すか）と同じ結果', () => {
      const day = '2026-11-10'
      const rows = [
        vital(7, '2026-11-05', 1, { temp: 37.6, sys_bp: 120, dia_bp: 70, pulse: 70, spo2: 97 }),
        vital(7, '2026-11-06', 1, { temp: 36.4, sys_bp: 160, dia_bp: 95, pulse: 38, spo2: 89 }),
        vital(7, '2026-11-07', 1, { temp: 36.4, sys_bp: 118, dia_bp: 72, pulse: 72, spo2: 96 }),
      ]
      const target = { id: 1, resident_id: 7, fluid_target_ml: null, spo2_warn_below: 95, spo2_danger_below: 90 }
      const r = T.trendRounds([], rows, 7, day, [])
      for (const round of r) {
        const any = DC.DAYCARE_VITAL_FIELDS.some((f) => T.trendLevel(round, f, target, limitsOf) !== null)
        assert.equal(any, DC.vitalNeedsRecheck(round.vals, target, base()), round.day)
        for (const f of DC.DAYCARE_VITAL_FIELDS) assert.equal(T.trendLevel(round, f, target, limitsOf), DC.vitalLevel(f, round.vals[f], target, base()))
      }
      assert.equal(T.trendLevel(r[0], 'temp', target, limitsOf), 'warn-high')
      assert.equal(T.trendLevel(r[1], 'sys_bp', target, limitsOf), 'danger-high')
      assert.equal(T.trendLevel(r[1], 'pulse', target, limitsOf), 'warn-low')
      assert.equal(T.trendLevel(r[1], 'spo2', target, limitsOf), 'danger-low')
      // SpO2 は個別の目標（95 未満で注意）。施設の基準（93）なら 94 は外れない
      const r94 = { day: '2026-11-07', vals: { ...r[2].vals, spo2: 94 } }
      assert.equal(T.trendLevel(r94, 'spo2', target, limitsOf), 'warn-low')
      assert.equal(T.trendLevel(r94, 'spo2', null, limitsOf), null)
      assert.equal(T.trendLevel({ day, vals: { ...r[2].vals, temp: null } }, 'temp', null, limitsOf), null, '値が無ければ判定しない')
    })
    it('基準はその回の日のその方の基準（個人の閾値が途中から変わっても、前の回は前の基準で判定する）', () => {
      const strict = { ...base(), temp: { ...base().temp, warnHigh: 37.0 } }
      const asked = []
      const byDay = (d) => {
        asked.push(d)
        return d >= '2026-11-08' ? strict : base()
      }
      const rows = [vital(7, '2026-11-07', 1, { temp: 37.2 }), vital(7, '2026-11-08', 1, { temp: 37.2 })]
      const r = T.trendRounds([], rows, 7, '2026-11-10', [])
      assert.equal(T.trendLevel(r[0], 'temp', null, byDay), null)
      assert.equal(T.trendLevel(r[1], 'temp', null, byDay), 'warn-high')
      assert.deepEqual(asked, ['2026-11-07', '2026-11-08'])
    })
    it('記号と言葉は今の1人の画面の要約と同じ（↑ 注意・高い など）。印の向きと色', () => {
      assert.equal(T.levelText('warn-high'), '↑ 注意・高い')
      assert.equal(T.levelText('danger-low'), '↓↓ 危険・低い')
      assert.equal(T.levelText(null), null)
      assert.equal(T.levelIsHigh('danger-high'), true)
      assert.equal(T.levelIsHigh('warn-low'), false)
      assert.equal(T.levelIsDanger('danger-low'), true)
      assert.equal(T.levelIsDanger('warn-high'), false)
    })
  })

  describe('グラフの形', () => {
    it('項目ごとの小さなグラフ（血圧は上・下の2本で1つの目盛り・脈・SpO2・体温）。縦軸はカルテのグラフと同じ chartDomain', () => {
      assert.deepEqual(
        T.TREND_PANELS.map((p) => [p.key, p.title, p.unit, [...p.fields]]),
        [
          ['bp', '血圧', 'mmHg', ['sys_bp', 'dia_bp']],
          ['pulse', '脈', '回/分', ['pulse']],
          ['spo2', 'SpO2', '%', ['spo2']],
          ['temp', '体温', '℃', ['temp']],
        ],
      )
      const rs = [{ vals: { sys_bp: 128, dia_bp: 76 } }, { vals: { sys_bp: 140, dia_bp: null } }]
      const bp = T.TREND_PANELS[0]
      assert.deepEqual(T.trendDomain(bp, rs), CH.chartDomain([128, 76, 140], CH.KARTE_AXES.bp))
      const tp = T.TREND_PANELS[3]
      assert.deepEqual(T.trendDomain(tp, [{ vals: { temp: 36.5 } }]), CH.chartDomain([36.5], CH.KARTE_AXES.temp))
      assert.deepEqual(T.trendTicks(tp, [35.75, 37.25], 84, 24), CH.chartTicks([35.75, 37.25], 0.5, 84, 24).values)
      assert.equal(T.fmtTick(tp, 36), '36.0')
      assert.equal(T.fmtTick(bp, 120), '120')
      assert.equal(T.fmtTrendValue('temp', 37), '37.0')
    })
    it('線は値の無い回で切る（つながない）。1回だけの区間は点だけ', () => {
      assert.deepEqual(T.trendSegments([1, 2, null, 4, null, null, 7, 8, 9]), [[0, 1], [3], [6, 7, 8]])
      assert.deepEqual(T.trendSegments([null, null]), [])
      assert.deepEqual(T.trendSegments([5]), [[0]])
      assert.equal(T.lastIndexWithValue([{ vals: { pulse: 1 } }, { vals: { pulse: null } }], 'pulse'), 0)
      assert.equal(T.lastIndexWithValue([{ vals: { pulse: null } }], 'pulse'), -1)
    })
    it('ラベルは全部の点に並べない: 先に最新、次に基準外の点（新しい順）。既に置いたラベル・ほかの点の印と重なる場所には置かず、次の案（反対の側）を試す', () => {
      const up = (x, y0) => ({ side: 'above', x, top: y0 - 30 })
      const dn = (x, y0) => ({ side: 'below', x, top: y0 + 10 })
      const c = (id, priority, spots) => ({ id, w: 40, h: 16, priority, spots })
      const shown = T.pickLabels(
        [c('old', 1.05, [up(120, 50)]), c('last', 0, [up(300, 50)]), c('near', 1.0, [up(280, 50)]), c('low', 1.01, [dn(290, 50)]), c('far', 1.02, [up(200, 50)])],
        6,
      )
      assert.deepEqual([...shown.keys()].sort(), ['far', 'last', 'low', 'old'])
      assert.equal(shown.get('low').side, 'below')
      // 重なる時は反対の側を試す（1本の項目）。反対の側も埋まっていれば出さない
      const alt = T.pickLabels([c('last', 0, [up(300, 50)]), c('prev', 1, [up(270, 50), dn(270, 50)]), c('prev2', 1.01, [up(280, 50), dn(280, 50)])], 6)
      assert.deepEqual(
        [...alt.entries()].map(([k, v]) => [k, v.side]),
        [
          ['last', 'above'],
          ['prev', 'below'],
        ],
      )
      // 高さが違えば同じ側でも重ならない（上下に離れた点）・違う側でも重なれば出さない（箱で見る）
      const far = T.pickLabels([c('a', 0, [up(100, 50)]), c('b', 1, [up(100, 200)])], 6)
      assert.equal(far.size, 2)
      const cross = T.pickLabels([c('a', 0, [up(100, 60)]), c('b', 1, [dn(100, 20)])], 6)
      assert.deepEqual([...cross.keys()], ['a'])
      // ほかの点の印に重ねない（自分の点の印は避けない）
      const obs = T.pickLabels([c('a', 0, [up(100, 50)])], 2, [
        { id: 'a', box: [92, 42, 108, 58] },
        { id: 'b', box: [110, 22, 126, 38] },
      ])
      assert.equal(obs.size, 0)
      const own = T.pickLabels([c('a', 0, [up(100, 50)])], 2, [{ id: 'a', box: [92, 22, 108, 38] }])
      assert.equal(own.size, 1)
      assert.equal(T.clampLabelX(300, 40, 0, 310), 290, '右端の最新のラベルは枠の内側へ寄せる')
      assert.equal(T.clampLabelX(5, 40, 30, 310), 50)
      assert.equal(T.clampLabelX(100, 400, 0, 300), 150, '入らない幅は真ん中')
      assert.equal(T.textWidth('128', 15, 9), 27)
      assert.equal(T.textWidth('上 128↑', 15, 9), 15 + 9 + 27 + 15)
    })
    it('横軸の日付は最新・最初から、重ならない分だけ出す', () => {
      const xs = Array.from({ length: 10 }, (_, i) => 40 + i * 25)
      const ws = xs.map(() => 40)
      const got = T.pickXLabels(xs, ws, 8)
      assert.equal(got[got.length - 1], 9)
      assert.equal(got[0], 0)
      for (let k = 1; k < got.length; k += 1) assert.ok(xs[got[k]] - xs[got[k - 1]] >= 48, '重ならない')
      assert.deepEqual(T.pickXLabels([100], [40], 8), [0])
      assert.deepEqual(T.pickXLabels([], [], 8), [])
      assert.equal(T.shortDay('2026-11-08'), '11/8')
    })
    it('回の数は点の間が 20px 以上になる数（10 回まで・4 回より減らさない）。幅が分からない間は 10 回', () => {
      assert.equal(T.TREND_MIN_GAP_PX, 20)
      assert.equal(T.trendFitRounds(263), 10, 'iPad の2列')
      assert.equal(T.trendFitRounds(199), 10, '375px の1列')
      assert.equal(T.trendFitRounds(100), 6)
      assert.equal(T.trendFitRounds(59), 4, '375px・文字 200%（下限）')
      assert.equal(T.trendFitRounds(0), 10)
      assert.equal(T.trendFitRounds(Number.NaN), 10)
      // 点の間は minGap 以上（下限に当たらない時）
      for (const w of [80, 120, 150, 179, 180, 181]) {
        const k = T.trendFitRounds(w)
        if (k > T.TREND_MIN_ROUNDS) assert.ok(w / (k - 1) >= 20, String(w))
      }
    })
    it('0回・1回・2回以上（空の状態の文）', () => {
      assert.deepEqual(T.trendView([]), { kind: 'none' })
      assert.deepEqual(T.trendView([1]), { kind: 'one' })
      assert.deepEqual(T.trendView([1, 2]), { kind: 'chart' })
      assert.match(T.TREND_EMPTY_TEXT, /まだありません/)
      assert.match(T.TREND_ONE_TEXT, /1回だけ/)
      assert.match(T.TREND_UNREAD_TEXT, /読み込めませんでした/)
    })
  })

  describe('言葉（表・押した時・読み上げ）', () => {
    const day = '2026-11-10'
    const rows = [
      vital(7, '2026-11-07', 1, { temp: 36.5, sys_bp: 128, dia_bp: 76, pulse: 72, spo2: 97 }),
      vital(7, '2026-11-08', 1, { temp: 36.6, sys_bp: 160, dia_bp: 45, pulse: 70, spo2: 96 }),
      vital(7, day, 1, { temp: 37.6, sys_bp: 150, dia_bp: null, pulse: null, spo2: 95 }, { measured_at: '09:40:00' }),
    ]
    const r = T.trendRounds([rows[2]], rows.slice(0, 2), 7, day, [mark(7, day, 1, 'pulse')])
    const lv = (x, f) => T.trendLevel(x, f, null, limitsOf)
    const bp = T.TREND_PANELS[0]
    it('表の欄: 血圧は上/下・片方だけの時は「上 150／下 —」・基準外は上・下を添えた記号と言葉', () => {
      assert.deepEqual(T.trendCell(bp, r[0], lv, false), { text: '128/76', flags: [] })
      assert.deepEqual(T.trendCell(bp, r[1], lv, false), { text: '160/45', flags: ['上 ↑↑ 危険・高い', '下 ↓ 注意・低い'] })
      assert.deepEqual(T.trendCell(bp, r[2], lv, false), { text: '上 150／下 —', flags: [] })
      assert.deepEqual(T.trendCell(T.TREND_PANELS[3], r[2], lv, false), { text: '37.6', flags: ['↑ 注意・高い'] })
      assert.deepEqual(T.trendCell(T.TREND_PANELS[1], r[2], lv, false), { text: '未測定', flags: [] })
    })
    it('押した時: その回の日時と全部の項目（単位・基準外の記号と言葉）', () => {
      assert.equal(T.roundWhen(r[2]), '11/10（火） 9:40')
      assert.equal(T.roundWhen({ day: '2026-11-08', hm: '' }), '11/8（日）')
      // 2026-11-10 反証の確認 軽7: 押した回の行と読み上げでは、値の無い欄は「記録なし」（表は「—」のまま＝上の試験）
      assert.equal(T.trendReadout(r[2], lv, false), '11/10（火） 9:40 の回: 血圧 上 150／下 記録なし mmHg・脈 未測定・SpO2 95%・体温 37.6℃（↑ 注意・高い）')
    })
    it('読み上げの要約（role="img" のグラフの名前）: 直近の回の数・期間・最新・基準外の回数・値の無い回', () => {
      assert.equal(T.trendSpeech(bp, r, lv), '血圧 直近3回（11/7〜11/10）。最新 上 150／下 — mmHg。基準外 1回。')
      assert.equal(T.trendSpeech(T.TREND_PANELS[1], r, lv), '脈 直近3回（11/7〜11/10）。最新 70 回/分。基準外 0回。値の無い回 1回。')
      assert.equal(T.trendSpeech(T.TREND_PANELS[3], r, lv), '体温 直近3回（11/7〜11/10）。最新 37.6℃。基準外 1回。')
      assert.equal(T.abnormalCount(bp, r, lv), 1)
      assert.equal(T.withUnit(T.TREND_PANELS[2], '97'), '97%')
      assert.equal(T.withUnit(T.TREND_PANELS[1], '72'), '72 回/分')
      const none = T.trendRounds([], [vital(7, '2026-11-01', 1, { temp: 36.5 }), vital(7, '2026-11-02', 1, { temp: 36.6 })], 7, day, [])
      assert.equal(T.trendSpeech(T.TREND_PANELS[1], none, lv), '脈 直近2回（11/1〜11/2）。この2回に脈の記録はありません。')
    })
  })

  describe('配置（trendLayout）・押した回・読み直しの判断（2026-11-10 反証 中1・軽2・軽3・軽9・軽10）', () => {
    const lim = () => base()
    const lvOf = (x, f) => T.trendLevel(x, f, null, lim)
    const bp = T.TREND_PANELS[0]
    /** 反証の再現: 9回目 上124以上・10回目 上120・下は 70〜76 のあと最後に 80 */
    const repro = (sys9) => {
      const ds = days(10, '2026-10-27')
      const sys = [118, 122, 120, 126, 119, 121, 123, 117, sys9, 120]
      const dia = [70, 72, 74, 76, 71, 73, 75, 70, 76, 80]
      return T.trendRounds([], ds.map((d, i) => vital(7, d, 1, { sys_bp: sys[i], dia_bp: dia[i] })), 7, '2026-11-10', [])
    }
    const boxOf = (l, fs, charW) => {
      const w = T.textWidth(l.text, fs, charW)
      const left = l.anchor === 'end' ? l.x - w : l.x - w / 2
      return [left, l.y - Math.round(fs * 0.85), left + w, l.y - Math.round(fs * 0.85) + Math.ceil(fs)]
    }
    const overlap = (a, b) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 0.5 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.5
    it('中1: 系列ごとの最新の値は必ずラベルに出す（反証の再現: 9回目 上124〜135・10回目 上120・下 80／幅 300〜400・文字 100%／200%）。枠からはみ出さず、ラベルどうしは重ならない', () => {
      for (const sys9 of [124, 126, 130, 135]) {
        const r = repro(sys9)
        for (const [fs, charW] of [
          [15, 9],
          [30, 18],
        ]) {
          for (let W = 300; W <= 400; W += 10) {
            const lay = T.trendLayout(bp, r, lvOf, { width: W, fs, charW })
            const ids = lay.labels.map((l) => l.id)
            assert.ok(ids.includes('sys_bp:9'), `上の最新 W=${W} fs=${fs} 9回目=${sys9}`)
            assert.ok(ids.includes('dia_bp:9'), `下の最新 W=${W} fs=${fs} 9回目=${sys9}`)
            const boxes = lay.labels.map((l) => boxOf(l, fs, charW))
            for (const b of boxes) assert.ok(b[0] >= -0.5 && b[2] <= W + 0.5 && b[1] >= -0.5 && b[3] <= lay.H + 0.5, `枠の内側 W=${W} fs=${fs}`)
            for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) assert.ok(!overlap(boxes[i], boxes[j]), `重ならない W=${W} fs=${fs} ${ids[i]}/${ids[j]}`)
          }
        }
      }
      // 印に重ならない場所があれば、そこを先に使う（点の上 → 左寄せ → 下の順に試す）。反証の再現では、上の最新のラベル「上 120」は
      // 点の上だと 9回目（上 126）の印に乗るので、ほかの場所へ移る（どこも空いていない時だけ印に重ねる＝下の最新など）
      for (let W = 300; W <= 400; W += 10) {
        const lay = T.trendLayout(bp, repro(126), lvOf, { width: W, fs: 15, charW: 9 })
        const l = lay.labels.find((x) => x.id === 'sys_bp:9')
        const m = lay.markers.find((x) => x.id === 'sys_bp:8')
        assert.ok(!overlap(boxOf(l, 15, 9), [m.x - 6, m.y - 6, m.x + 6, m.y + 6]), `W=${W} 上の最新のラベルが 9回目の印に重なる`)
      }
      // 名前つきで出す（入る幅では「上 120」「下 80」）
      const lay = T.trendLayout(bp, repro(126), lvOf, { width: 343, fs: 15, charW: 9 })
      assert.deepEqual(
        lay.labels.filter((l) => l.latest).map((l) => l.text),
        ['上 120', '下 80'],
      )
    })
    it('中1: 試験用の画面の値（上 182↑↑・最新 上 128）でも最新のラベルが出る。1本の項目（SpO2 89↓↓・体温 37.8↑）も最新が出る', () => {
      const ds = days(10, '2026-10-27')
      const sys = [132, 136, 129, 141, 182, 140, 135, 131, 134, 128]
      const dia = [80, 82, 78, 86, 96, 82, 80, 79, 81, null]
      const sp = [96, 95, 96, 94, 95, 89, 96, 97, 98, 97]
      const tp = [36.4, 36.6, 36.5, 37.8, 36.7, 36.5, 36.4, 36.6, 36.5, 36.5]
      const r = T.trendRounds([], ds.map((d, i) => vital(7, d, 1, { sys_bp: sys[i], dia_bp: dia[i], spo2: sp[i], temp: tp[i] })), 7, '2026-11-10', [])
      for (const W of [300, 343, 400, 642, 810]) {
        const ids = T.trendLayout(bp, r, lvOf, { width: W, fs: 15, charW: 9 }).labels.map((l) => l.id)
        assert.ok(ids.includes('sys_bp:9') && ids.includes('dia_bp:8'), `W=${W} ${ids}`)
        assert.ok(T.trendLayout(T.TREND_PANELS[2], r, lvOf, { width: W, fs: 15, charW: 9 }).labels.some((l) => l.id === 'spo2:9'))
        assert.ok(T.trendLayout(T.TREND_PANELS[3], r, lvOf, { width: W, fs: 15, charW: 9 }).labels.some((l) => l.id === 'temp:9'))
      }
      // 基準外のラベルは「上」「下」つき・記号つき
      const lay = T.trendLayout(bp, r, lvOf, { width: 343, fs: 15, charW: 9 })
      assert.ok(lay.labels.some((l) => l.text === '上 182↑↑'), JSON.stringify(lay.labels.map((l) => l.text)))
    })
    it('軽2・軽3: 点の印の形（ふつう＝丸・血圧の下＝四角／基準外は三角・血圧の下は四角のまま＋向き／注意と危険を形で分ける tone）', () => {
      const ds = days(4, '2026-11-01')
      const r = T.trendRounds([], [
        vital(7, ds[0], 1, { sys_bp: 120, dia_bp: 70 }),
        vital(7, ds[1], 1, { sys_bp: 160, dia_bp: 95 }),
        vital(7, ds[2], 1, { sys_bp: 85, dia_bp: 45 }),
        vital(7, ds[3], 1, { sys_bp: 125, dia_bp: 72 }),
      ], 7, '2026-11-10', [])
      const ms = T.trendLayout(bp, r, lvOf, { width: 343, fs: 15, charW: 9 }).markers
      const m = (id) => ms.find((x) => x.id === id)
      assert.deepEqual([m('sys_bp:0').kind, m('sys_bp:0').tone, m('sys_bp:0').dir], ['circle', 'series', null])
      assert.deepEqual([m('dia_bp:0').kind, m('dia_bp:0').tone], ['square', 'series'])
      assert.deepEqual([m('sys_bp:1').kind, m('sys_bp:1').tone, m('sys_bp:1').dir], ['triangle', 'danger', 'up'])
      assert.deepEqual([m('dia_bp:1').kind, m('dia_bp:1').tone, m('dia_bp:1').dir], ['square', 'danger', 'up'])
      assert.deepEqual([m('sys_bp:2').kind, m('sys_bp:2').tone, m('sys_bp:2').dir], ['triangle', 'warn', 'down'])
      assert.deepEqual([m('dia_bp:2').kind, m('dia_bp:2').tone, m('dia_bp:2').dir], ['square', 'warn', 'down'])
    })
    it('軽2: ラベルの順は 最新 → いちばん新しい基準外 → 危険 → 注意（置けない時は後の方から落ちる）', () => {
      // 脈: 注意（38↓）が新しく、危険（↑↑）が古い。狭い幅で全部は置けない時、最新・いちばん新しい基準外が先
      const ds = days(10, '2026-10-27')
      const pu = [70, 72, 105, 110, 108, 72, 38, 39, 37, 72]
      const r = T.trendRounds([], ds.map((d, i) => vital(7, d, 1, { pulse: pu[i] })), 7, '2026-11-10', [])
      const panel = T.TREND_PANELS[1]
      const lay = T.trendLayout(panel, r, lvOf, { width: 300, fs: 15, charW: 9 })
      const ids = lay.labels.map((l) => l.id)
      assert.ok(ids.includes('pulse:9'), '最新')
      assert.ok(ids.includes('pulse:8'), 'いちばん新しい基準外')
      // 置けた基準外のうち、危険（2〜4）が注意（6・7）より先に置かれる（同じ高さの近い点で注意が落ちても危険は残る）
      const dangerShown = ids.filter((id) => ['pulse:2', 'pulse:3', 'pulse:4'].includes(id)).length
      assert.ok(dangerShown >= 1, String(ids))
    })
    it('軽9: 横軸は日付・同じ日の2回目からは「再n」（日付のラベルが先・重なる時は出さない）', () => {
      assert.deepEqual(
        T.xLabelTexts([{ day: '2026-11-08' }, { day: '2026-11-10' }, { day: '2026-11-10' }, { day: '2026-11-10' }]),
        [
          { text: '11/8', secondary: false },
          { text: '11/10', secondary: false },
          { text: '再2', secondary: true },
          { text: '再3', secondary: true },
        ],
      )
      // 最後が「再2」でも、日付のラベル（同じ日の1回目）を先に置く
      const got = T.pickXLabels([40, 200, 230], [40, 45, 30], 8, [false, false, true])
      assert.deepEqual(got, [0, 1])
      const lay = T.trendLayout(T.TREND_PANELS[3], T.trendRounds([vital(7, '2026-11-10', 1, { temp: 37.6 }), vital(7, '2026-11-10', 2, { temp: 37.2 })], [vital(7, '2026-11-03', 1, { temp: 36.5 })], 7, '2026-11-10', []), lvOf, { width: 810, fs: 15, charW: 9 })
      assert.deepEqual(
        lay.xLabels.map((x) => x.text),
        ['11/3', '11/10', '再2'],
      )
    })
    it('軽4・軽5: 押した回の選び方（いちばん近い回）と〔‹ 前の回〕〔次の回 ›〕（何も選んでいない時は〔‹ 前の回〕で最新・端では押せない）', () => {
      const xs = [40, 70, 100, 130]
      assert.equal(T.nearestIndex(xs, 0), 0)
      assert.equal(T.nearestIndex(xs, 84), 1)
      assert.equal(T.nearestIndex(xs, 86), 2)
      assert.equal(T.nearestIndex(xs, 999), 3)
      assert.equal(T.nearestIndex([], 50), -1)
      assert.equal(T.stepIndex(4, null, -1), 3)
      assert.equal(T.stepIndex(4, null, 1), null)
      assert.equal(T.stepIndex(4, 3, -1), 2)
      assert.equal(T.stepIndex(4, 3, 1), null)
      assert.equal(T.stepIndex(4, 0, -1), null)
      assert.equal(T.stepIndex(4, 0, 1), 1)
      assert.equal(T.stepIndex(0, null, -1), null)
      assert.equal(T.stepIndex(4, 9, -1), 3, '範囲外は選んでいない扱い')
    })
    it('軽7: 読み直すのは、その方の表示中の日より前のデイの測定の変更・表示中の日以前の印・行の分からない取り直しの合図だけ', () => {
      const day = '2026-11-10'
      const row = (over) => ({ resident_id: 7, measured_on: '2026-11-08', client_key: 'dc:2026-11-08:7:1', ...over })
      assert.equal(T.trendChangeHits('vitals', { event: 'UPDATE', row: row() }, 7, day), true)
      // 反証の確認 軽3: 表示中の日の測定は数えない（画面が読み直して mineSig が変わる1回だけ＝二重に読まない）
      assert.equal(T.trendChangeHits('vitals', { event: 'INSERT', row: row({ measured_on: day, client_key: `dc:${day}:7:2` }) }, 7, day), false)
      assert.equal(T.trendChangeHits('vitals', { event: 'INSERT', row: row({ measured_on: '2026-11-11' }) }, 7, day), false, '後の日')
      assert.equal(T.trendChangeHits('vitals', { event: 'UPDATE', row: row({ resident_id: 8 }) }, 7, day), false, 'ほかの方')
      assert.equal(T.trendChangeHits('vitals', { event: 'UPDATE', row: row({ client_key: null }) }, 7, day), false, 'デイ以外の測定')
      assert.equal(T.trendChangeHits('vitals', { event: 'RESYNC', row: null }, 7, day), true, '分からない＝取り直す')
      assert.equal(T.trendChangeHits('vitals', undefined, 7, day), true)
      assert.equal(T.trendChangeHits('meals', { event: 'UPDATE', row: { resident_id: 7 } }, 7, day), false)
      assert.equal(T.trendChangeHits('meals', { event: 'RESYNC', row: null }, 7, day), false)
      assert.equal(T.trendChangeHits('daycare_vital_unmeasured', { event: 'INSERT', row: { resident_id: 7, day } }, 7, day), true)
      assert.equal(T.trendChangeHits('daycare_vital_unmeasured', { event: 'INSERT', row: { resident_id: 7, day: '2026-11-11' } }, 7, day), false)
      assert.equal(T.trendChangeHits('daycare_vital_unmeasured', { event: 'RESYNC', row: null }, 7, day), false)
    })
    it('軽10: 幅に合わせて回を減らす（描く幅 → 点を並べる幅 → 回の数）。375px で文字 200%（幅 197・文字 30px）は 5 回・iPad の2列は 10 回', () => {
      assert.equal(T.trendPadLeft(15, 9), 44)
      assert.equal(T.trendPlotWidth({ width: 343, fs: 15, charW: 9 }), 343 - 44 - 4 - 20)
      assert.equal(T.trendFitRounds(T.trendPlotWidth({ width: 343, fs: 15, charW: 9 })), 10)
      assert.equal(T.trendFitRounds(T.trendPlotWidth({ width: 285, fs: 15, charW: 9 })), 10)
      assert.equal(T.trendPlotWidth({ width: 197, fs: 30, charW: 18 }), 197 - 80 - 4 - 20)
      assert.equal(T.trendFitRounds(T.trendPlotWidth({ width: 197, fs: 30, charW: 18 })), 5)
      // 配置の点を並べる幅と同じ
      const r = repro(126)
      assert.equal(T.trendLayout(bp, r, lvOf, { width: 343, fs: 15, charW: 9 }).plotW, T.trendPlotWidth({ width: 343, fs: 15, charW: 9 }))
    })
    it('押した回の行と、今日の値を読めなかった時の言葉', () => {
      const r = repro(126)
      assert.equal(T.trendPanelReadout(bp, r[9], lvOf, false), '11/5（木） 10:05　120/80 mmHg')
      const hi = T.trendRounds([], [vital(7, '2026-11-08', 1, { sys_bp: 160, dia_bp: 45 })], 7, '2026-11-10', [])[0]
      assert.equal(T.trendPanelReadout(bp, hi, lvOf, false), '11/8（日） 10:05　160/45 mmHg（上 ↑↑ 危険・高い・下 ↓ 注意・低い）')
      assert.equal(T.trendDayUnreadText(true), '今日の値を読み込めませんでした（前の日の回だけを出しています）。')
      assert.equal(T.trendDayUnreadText(false), 'この日の値を読み込めませんでした（前の日の回だけを出しています）。')
    })
  })

  describe('反証の確認（2026-11-10）: 目盛りとの重なり・最新どうし・読み直し・回の窓・選んだ回・記録なし', () => {
    const lim = () => base()
    const lvOf = (x, f) => T.trendLevel(x, f, null, lim)
    const bp = T.TREND_PANELS[0]
    let id = 50000
    const rowsOf = (vals, from = '2026-11-03') => {
      const ds = days(vals.length, from)
      return vals.map((v, i) => vital(7, ds[i], 1, v))
    }
    const bpVals = (list) =>
      list.map((t) => {
        const [a, b] = t.split('/')
        return { sys_bp: a === '' ? null : Number(a), dia_bp: b === '' || b === undefined ? null : Number(b), pulse: 70 }
      })
    /** ラベル・目盛りの数字の箱（描く側と同じ寸法で検算する: 基準線から 0.85 字上・高さ 1 字・目盛りは padL - 6 に右寄せ） */
    const labelBoxes = (lay, fs, charW) =>
      lay.labels.map((l) => {
        const w = T.textWidth(l.text, fs, charW)
        const left = l.anchor === 'end' ? l.x - w : l.x - w / 2
        const top = l.y - Math.round(fs * 0.85)
        return [left, top, left + w, top + Math.ceil(fs)]
      })
    const tickBoxes = (lay, fs, charW) =>
      lay.ticks.map((t) => {
        const w = T.textWidth(t.text, fs, charW)
        const top = t.baseline - Math.round(fs * 0.85)
        return [lay.padL - 6 - w, top, lay.padL - 6, top + Math.ceil(fs)]
      })
    const ov = (a, b) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 0.5 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.5
    /** 1枚のグラフの検算: 最新のラベルがある・ラベルは描く枠の内側・ラベルどうし・ラベルと目盛りの数字が重ならない */
    const check = (panel, r, W, fs, charW, tag) => {
      const lay = T.trendLayout(panel, r, lvOf, { width: W, fs, charW })
      for (const f of panel.fields) {
        const li = T.lastIndexWithValue(r, f)
        if (li >= 0) assert.ok(lay.labels.some((l) => l.id === `${f}:${li}`), `${tag} 最新 ${f}`)
      }
      const ls = labelBoxes(lay, fs, charW)
      const ts = tickBoxes(lay, fs, charW)
      ls.forEach((b, i) => {
        assert.ok(b[0] >= lay.padL - 0.5 && b[2] <= W - lay.padR + 0.5 && b[1] >= -0.5, `${tag} 枠の内側 ${lay.labels[i].text}`)
        for (const t of ts) assert.ok(!ov(b, t), `${tag} 目盛りの数字に乗る ${lay.labels[i].text}`)
        for (let j = i + 1; j < ls.length; j += 1) assert.ok(!ov(b, ls[j]), `${tag} ラベルどうし ${lay.labels[i].text}/${lay.labels[j].text}`)
      })
      return lay
    }
    it('軽1: 375px・文字 200%（幅 197・文字 30px）でラベルが左の目盛りの数字に乗らない（反証の再現 144/74・132/71・153/60・152/68・130/100 ほか）。名前を外す判定は描ける幅で', () => {
      for (const list of [
        ['144/74', '132/71', '153/60', '152/68', '130/100'],
        ['143/82', '158/84', '133/83', '155/83', '143/103'],
        ['157/72', '122/67', '121/75', '132/60', '128/98'],
        ['176/81', '163/66', '162/84', '161/71', '151/76'],
      ]) {
        const r = T.trendRounds([], rowsOf(bpVals(list)), 7, '2026-11-20', [])
        const lay = check(bp, r, 197, 30, 18, list.join(' '))
        // 描ける幅（197 - padL 80 - padR 4 = 113）に「下 100↑↑」は入らないので名前を外す（記号まで入らない最新は値だけ）
        for (const l of lay.labels) assert.ok(T.textWidth(l.text, 30, 18) <= 197 - lay.padL - lay.padR, l.text)
      }
      // 置ける範囲（左に置く案を含む）も描く枠の内側・目盛りの数字の箱はどの段でも避ける
      const libSrc = code('../src/lib/daycareVitalsTrend.ts')
      assert.match(libSrc, /const bounds: LabelObstacle = \[padL, 0, W - padR, plotBottom\]/)
      assert.match(libSrc, /const picked = pickLabels\(cands, Math\.ceil\(fs \* 0\.25\), obstacles, 1, bounds, tickBoxes\)/)
    })
    it('軽2: 上と下の最新のラベルどうしが重ならない（反証の再現: 幅 520・文字 30px・152/73 … —/66、92/38 だけの2回）', () => {
      const r = T.trendRounds([], rowsOf(bpVals(['152/73', '128/', '74/39', '93/54', '131/99', '181/', '196/160', '71/36', '/66'])), 7, '2026-11-20', [])
      check(bp, r, 520, 30, 18, '152/73…/66')
      const r2 = T.trendRounds([], rowsOf([{ sys_bp: 92, dia_bp: 38, pulse: 70 }, { pulse: 72 }]), 7, '2026-11-20', [])
      const lay = check(bp, r2, 520, 30, 18, '92/38')
      assert.equal(lay.labels.find((l) => l.id === 'sys_bp:0').text, '上 92')
      // 最後の逃げ道で、2つ目の最新のラベルを1段ずらす（縦に積む）: 置いたラベルに重なる案しか無い時
      const c = (cid, spots) => ({ id: cid, w: 40, h: 16, priority: cid === 'a' ? 0 : 0.1, latest: true, spots })
      const got = T.pickLabels([c('a', [{ side: 'below', anchor: 'middle', x: 100, top: 50 }]), c('b', [{ side: 'below', anchor: 'middle', x: 105, top: 52 }])], 4, [], 0, [0, 0, 300, 200])
      assert.equal(got.get('a').top, 50)
      assert.equal(got.get('b').top, 52 + 16 + 4, '1段下へ')
    })
    it('乱数の検算（種 7・幅 197〜810・文字 100%／200%・4つのグラフ）: 最新のラベルは必ず出て、枠の内側で、ラベルどうし・目盛りの数字と重ならない', () => {
      let seed = 7
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
      }
      const ri = (a, b) => Math.floor(a + rnd() * (b - a + 1))
      let cases = 0
      for (let it = 0; it < 120; it += 1) {
        const vals = Array.from({ length: ri(2, 10) }, () => {
          const sys = rnd() < 0.1 ? null : ri(70, 200)
          const s0 = sys ?? 125
          return { sys_bp: sys, dia_bp: rnd() < 0.15 ? null : ri(Math.max(35, s0 - 80), Math.max(36, s0 - 25)), pulse: ri(35, 140), spo2: ri(85, 100), temp: Math.round((35 + rnd() * 4) * 10) / 10 }
        })
        const all = T.trendRounds([], rowsOf(vals, '2026-10-20'), 7, '2026-11-20', [])
        for (const [fs, charW] of [
          [15, 9],
          [30, 18],
        ]) {
          for (const W of [197, 285, 343, 520, 642, 810]) {
            const r = T.trendWindow(all, T.trendPlotWidth({ width: W, fs, charW }))
            for (const p of T.TREND_PANELS) {
              if (!r.some((x) => p.fields.some((f) => x.vals[f] !== null))) continue
              check(p, r, W, fs, charW, `it=${it} W=${W} fs=${fs} ${p.key}`)
              cases += 1
            }
          }
        }
      }
      assert.ok(cases > 2500, String(cases))
    })
    it('軽3: 二重に読み直さない（表示中の日の測定は知らせで数えず mineSig の1回・前の日は知らせの1回・400ms 以内の重なりは1回にまとめる・人・日が変わったら待っている読み直しを消す）', () => {
      const day = '2026-11-10'
      /** 部品の読み直しのまとめ（trendReloadStep と TREND_RELOAD_MS）を時刻つきで流し、読み直した回数を数える */
      const simulate = (events) => {
        let prev = { key: '7:' + day, mineSig: 'a', changeKey: 0 }
        let pendingAt = null
        const fires = []
        for (const e of events) {
          if (pendingAt !== null && pendingAt <= e.t) {
            fires.push(pendingAt)
            pendingAt = null
          }
          const next = { ...prev, ...e.change }
          const step = T.trendReloadStep(prev, next)
          prev = next
          if (step === 'cancel') pendingAt = null
          if (step === 'schedule') pendingAt = e.t + T.TREND_RELOAD_MS
        }
        if (pendingAt !== null) fires.push(pendingAt)
        return fires
      }
      assert.equal(T.TREND_RELOAD_MS, 400)
      // 表示中の日の測定の変更: 知らせ（trendChangeHits＝数えない）＋画面の読み直しで mineSig が1回変わる → 1回
      const todayRow = { resident_id: 7, measured_on: day, client_key: `dc:${day}:7:1` }
      const kick1 = T.trendChangeHits('vitals', { event: 'UPDATE', row: todayRow }, 7, day) ? 1 : 0
      assert.deepEqual(simulate([{ t: 0, change: { changeKey: kick1 } }, { t: 650, change: { mineSig: 'b' } }]), [1050])
      // 前の日の測定の変更（知らせ1回）→ 1回
      const pastRow = { resident_id: 7, measured_on: '2026-11-07', client_key: 'dc:2026-11-07:7:1' }
      assert.equal(T.trendChangeHits('vitals', { event: 'UPDATE', row: pastRow }, 7, day), true)
      assert.deepEqual(simulate([{ t: 0, change: { changeKey: 1 } }]), [400])
      // 取り直しの合図（知らせ）と、その読み直しで変わった mineSig が 400ms 以内に重なる → 待ち直して1回
      assert.deepEqual(simulate([{ t: 0, change: { changeKey: 1 } }, { t: 300, change: { mineSig: 'b' } }]), [700])
      // 待っている間に人・日が変わった → 消す（前の方の読み直しを後から走らせない）
      assert.deepEqual(simulate([{ t: 0, change: { changeKey: 1 } }, { t: 100, change: { key: '8:' + day, mineSig: '' } }]), [])
      assert.equal(T.trendReloadStep({ key: 'a', mineSig: 'x', changeKey: 1 }, { key: 'a', mineSig: 'x', changeKey: 1 }), 'none')
    })
    it('軽5: 回の窓（測った幅から回の数）と、選んだ回を行の id で持つ作り（回を減らして外れたら選んでいない扱い・残れば同じ回）', () => {
      const all = T.trendRounds([], rowsOf(Array.from({ length: 10 }, (_, i) => ({ pulse: 60 + i }))), 7, '2026-11-20', [])
      assert.equal(T.trendWindow(all, null).length, 10, 'まだ測っていない間は 10 回')
      assert.equal(T.trendWindow(all, T.trendPlotWidth({ width: 343, fs: 15, charW: 9 })).length, 10)
      const narrow = T.trendWindow(all, T.trendPlotWidth({ width: 197, fs: 30, charW: 18 }))
      assert.equal(narrow.length, 5)
      assert.deepEqual(
        narrow.map((r) => r.id),
        all.slice(-5).map((r) => r.id),
        '新しい方から',
      )
      const key = '7:2026-11-20'
      const oldest = { key, id: all[0].id }
      const latest = { key, id: all[9].id }
      assert.equal(T.selectedIndexOf(all, oldest, key), 0)
      assert.equal(T.selectedIndexOf(narrow, oldest, key), -1, '回を減らして外れた回は選んでいない扱い')
      assert.equal(T.stepIndex(narrow.length, null, -1), 4, '〔‹ 前の回〕で最新から選び直せる')
      assert.equal(T.selectedIndexOf(all, latest, key), 9)
      assert.equal(T.selectedIndexOf(narrow, latest, key), 4, '残った回は同じ回のまま')
      assert.equal(T.selectedIndexOf(all, latest, '8:2026-11-20'), -1, 'ほかの方・日の選択は使わない')
      assert.equal(T.selectedIndexOf(all, null, key), -1)
    })
    it('軽7: 値の無い回を選んだ時の行と読み上げは「記録なし」（表は「—」）', () => {
      const r = T.trendRounds([], rowsOf([{ sys_bp: 120, dia_bp: 70, pulse: 70 }, { pulse: 72 }]), 7, '2026-11-20', [])
      assert.equal(T.trendPanelReadout(bp, r[1], lvOf, false), '11/4（水） 10:05　記録なし')
      assert.match(T.trendReadout(r[1], lvOf, false), /血圧 記録なし・脈 72 回\/分・SpO2 記録なし・体温 記録なし$/)
      assert.equal(T.trendCell(bp, r[1], lvOf, false).text, '—')
      // 〔未測定〕の印・印を読めなかった時は今までどおり
      const m = T.trendRounds([], rowsOf([{ pulse: 70 }, { pulse: 72 }]), 7, '2026-11-20', [mark(7, '2026-11-04', 1, 'spo2')])
      assert.equal(T.trendPanelReadout(T.TREND_PANELS[2], m[1], lvOf, false), '11/4（水） 10:05　未測定')
      assert.equal(T.trendPanelReadout(T.TREND_PANELS[2], m[1], lvOf, true), '11/4（水） 10:05　読み込めませんでした')
    })
    it('軽4: 控えはバイタルを読めなかった一覧で、前に読めたバイタルを空にしない（1人の画面が vitalsOk を渡す）', () => {
      const memo = (vitals, vitalsOk) => ({ day: '2026-11-10', planRows: [], planSource: 'kv', snapshot: null, missing: false, attendance: [], baths: [], vitals, vitalsOk, meals: [], fluids: [], intakeOk: true, residents: [], savedAt: 1 })
      const good = memo([vital(7, '2026-11-10', 1, { temp: 36.5 })], true)
      const merged = MEMO.mergeDaycareMemo(good, memo([], false))
      assert.equal(merged.vitals.length, 1)
      assert.equal(MEMO.memoVitalsOk(merged), true)
    })
  })

  describe('db.ts を偽の Supabase で動かす（通信しない）', () => {
    const fake = (state) => {
      const builder = (table) => {
        const q = { table, cols: null, filters: [], limit: null, action: 'select', orders: [] }
        const hit = (r) =>
          q.filters.every(([op, k, v]) =>
            op === 'eq'
              ? r[k] === v
              : op === 'lt'
                ? r[k] < v
                : op === 'lte'
                  ? r[k] <= v
                  : op === 'is'
                    ? (r[k] ?? null) === v
                    : op === 'like'
                      ? typeof r[k] === 'string' && r[k].startsWith(String(v).replace(/%$/, ''))
                      : true,
          )
        const run = () => {
          state.calls.push(q)
          const err = state.errors?.[table]
          if (err === 'reject') return Promise.reject(new Error('net'))
          if (err !== undefined) return Promise.resolve({ data: null, error: err, status: 400 })
          const all = (state[table] ?? [])
            .filter(hit)
            .slice()
            .sort((a, b) => {
              for (const [k, asc] of q.orders) if (a[k] !== b[k]) return (a[k] < b[k] ? -1 : 1) * (asc ? 1 : -1)
              return 0
            })
          return Promise.resolve({ data: all.slice(0, q.limit ?? all.length).map((r) => ({ ...r })), error: null, status: 200 })
        }
        const b = {
          select(c) {
            q.cols = c
            return b
          },
          insert() {
            q.action = 'insert'
            return b
          },
          update() {
            q.action = 'update'
            return b
          },
          upsert() {
            q.action = 'upsert'
            return b
          },
          delete() {
            q.action = 'delete'
            return b
          },
          eq(k, v) {
            q.filters.push(['eq', k, v])
            return b
          },
          lt(k, v) {
            q.filters.push(['lt', k, v])
            return b
          },
          lte(k, v) {
            q.filters.push(['lte', k, v])
            return b
          },
          like(k, v) {
            q.filters.push(['like', k, v])
            return b
          },
          is(k, v) {
            q.filters.push(['is', k, v])
            return b
          },
          order(k, o) {
            q.orders.push([k, o?.ascending !== false])
            return b
          },
          limit(n) {
            q.limit = n
            return b
          },
          then(ok, ng) {
            return run().then(ok, ng)
          },
        }
        return b
      }
      return {
        from: builder,
        rpc: () => Promise.resolve({ data: null, error: { message: 'no', code: 'PGRST202' }, status: 404 }),
        channel: () => {
          const ch = { on: () => ch, subscribe: () => ch }
          return ch
        },
        removeChannel: () => Promise.resolve(),
        auth: {
          onAuthStateChange() {
            return { data: { subscription: { unsubscribe() {} } } }
          },
          getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1' } } }, error: null }),
        },
      }
    }
    const withDb = async (state, f) => {
      DB.__testHooks.setClient(fake(state))
      try {
        await f()
      } finally {
        DB.__testHooks.setClient(null)
      }
    }
    const live = (v) => ({ ...v, deleted_at: null, created_at: null })

    it('2本の問い合わせ（同時）: その方の表示中の日より前のデイの測定（生きている行・新しい日から30件）と、表示中の日までの〔未測定〕の印（200件）。読むだけ', async () => {
      const day = '2026-11-10'
      const state = {
        calls: [],
        vitals: [
          live(vital(7, '2026-11-09', 1, { pulse: 70 })),
          live(vital(7, day, 1, { pulse: 71 })), // 表示中の日（画面の行を使う）
          live(vital(8, '2026-11-09', 1, { pulse: 72 })), // ほかの方
          { ...live(vital(7, '2026-11-08', 1, { pulse: 73 })), deleted_at: '2026-11-08T03:00:00Z' }, // 取り消した行
          live(vital(7, '2026-11-07', 1, { pulse: 74 }, { client_key: 'other:1' })), // デイ以外
        ],
        daycare_vital_unmeasured: [
          { ...mark(7, day, 1, 'spo2'), deleted_at: null },
          { ...mark(7, '2026-11-11', 1, 'spo2'), deleted_at: null },
          { ...mark(7, '2026-11-09', 1, 'temp'), deleted_at: '2026-11-09T05:00:00Z' },
        ],
      }
      await withDb(state, async () => {
        const got = await DB.fetchDaycareVitalsTrend(7, day)
        assert.deepEqual(
          got.rows.map((r) => [r.measured_on, r.pulse]),
          [['2026-11-09', 70]],
        )
        assert.equal(got.rows[0].client_key, 'dc:2026-11-09:7:1')
        assert.deepEqual(
          got.unmeasured.map((m) => [m.day, m.field]),
          [[day, 'spo2']],
        )
        assert.equal(state.calls.length, 2, '問い合わせは2本')
        assert.ok(state.calls.every((c) => c.action === 'select'), '読むだけ')
        const v = state.calls.find((c) => c.table === 'vitals')
        assert.match(v.cols, /^id,resident_id,measured_on,kind,measured_at,temp,sys_bp,dia_bp,pulse,spo2,.*,client_key$/)
        assert.deepEqual(v.filters, [
          ['eq', 'resident_id', 7],
          ['lt', 'measured_on', day],
          ['like', 'client_key', 'dc:%'],
          ['is', 'deleted_at', null],
        ])
        assert.deepEqual(v.orders, [
          ['measured_on', false],
          ['id', false],
        ])
        assert.equal(v.limit, 30)
        const m = state.calls.find((c) => c.table === 'daycare_vital_unmeasured')
        assert.equal(m.cols, 'id,resident_id,day,seq,field,rev')
        assert.deepEqual(m.filters, [
          ['eq', 'resident_id', 7],
          ['lte', 'day', day],
          ['is', 'deleted_at', null],
        ])
        assert.deepEqual(m.orders, [
          ['day', false],
          ['id', false],
        ])
        assert.equal(m.limit, 200)
      })
    })
    it('印の表が無い DB（0062 未適用）は印なし（[]）・印を読めない時は null（測定は返す）・測定を読めない時は例外', async () => {
      const day = '2026-11-10'
      const rows = [live(vital(7, '2026-11-09', 1, { pulse: 70 }))]
      await withDb({ calls: [], vitals: rows, errors: { daycare_vital_unmeasured: { code: '42P01', message: 'relation "daycare_vital_unmeasured" does not exist' } } }, async () => {
        const got = await DB.fetchDaycareVitalsTrend(7, day)
        assert.deepEqual(got.unmeasured, [])
        assert.equal(got.rows.length, 1)
      })
      await withDb({ calls: [], vitals: rows, errors: { daycare_vital_unmeasured: { code: '57014', message: 'timeout' } } }, async () => {
        const got = await DB.fetchDaycareVitalsTrend(7, day)
        assert.equal(got.unmeasured, null)
        assert.equal(got.rows.length, 1)
      })
      await withDb({ calls: [], vitals: rows, errors: { daycare_vital_unmeasured: 'reject' } }, async () => {
        const got = await DB.fetchDaycareVitalsTrend(7, day)
        assert.equal(got.unmeasured, null)
      })
      await withDb({ calls: [], vitals: rows, errors: { vitals: { code: '57014', message: 'timeout' } } }, async () => {
        await assert.rejects(() => DB.fetchDaycareVitalsTrend(7, day))
      })
    })
    it('形の違う日・利用者は読まない', async () => {
      const state = { calls: [], vitals: [] }
      await withDb(state, async () => {
        await assert.rejects(() => DB.fetchDaycareVitalsTrend(7, '2026/11/10'))
        assert.deepEqual(await DB.fetchDaycareVitalsTrend(0, '2026-11-10'), { rows: [], unmeasured: [] })
        assert.equal(state.calls.length, 0)
      })
    })
  })
}

describe('静的検査', () => {
  const page = code('../src/pages/DaycarePersonPage.tsx')
  const comp = code('../src/components/DaycareVitalsTrend.tsx')
  const lib = code('../src/lib/daycareVitalsTrend.ts')
  const db = code('../src/lib/db.ts')
  it('置き場: 1人の画面の最後（すべての入力の欄・申し送りの印の後）の独立した欄。バイタルの欄は計画F の前のまま（入力の欄を下げない＝仮置き・親の決定）。基準は画面の lookup をその方で渡す', () => {
    // バイタルの欄はグラフも推移へのリンクも持たない（要約・バイタル・食事への道・申し送りの印で終わる）
    const vital = page.slice(page.indexOf('<section aria-labelledby="h-vital"'), page.indexOf('<section aria-labelledby="h-bath"'))
    assert.doesNotMatch(vital, /DaycareVitalsTrend|推移|h-trend/)
    assert.match(vital, /\{ kind: 'vital' \},\s*vitalMarkText\([^\n]*\),\s*\)\}\s*<\/section>/)
    // 推移の欄は排泄の欄（最後の入力の欄）の後・画面の小窓の前
    const iEx = page.indexOf('<section aria-labelledby="h-ex"')
    const iTrend = page.indexOf('<section aria-labelledby="h-trend" className={sectionCls}>')
    const iDialogs = page.indexOf('{marks.dialogs}')
    assert.ok(iEx > 0 && iTrend > iEx && iDialogs > iTrend, '入力の欄が先・推移の欄は最後')
    for (const h of ['h-att', 'h-vital', 'h-bath', 'h-lunch', 'h-snack', 'h-fluid']) assert.ok(page.indexOf(`aria-labelledby="${h}"`) < iTrend, h)
    const sec = page.slice(iTrend, iDialogs)
    assert.match(
      sec,
      /<DaycareVitalsTrend\s+headingId="h-trend"\s+residentId=\{residentId\}\s+day=\{data\.day\}\s+isToday=\{data\.day === today\}\s+dayRows=\{data\.vitals\}\s+dayRowsOk=\{data\.vitalsOk\}\s+target=\{targets\.get\(residentId\)\}\s+limitsOf=\{\(d\) => limits\.lookup\(residentId, d\)\}\s+refreshKey=\{reloadKey\}\s+changeKey=\{trendChange\}\s+\/>\s*<\/section>/,
    )
    assert.equal((page.match(/<DaycareVitalsTrend\b/g) ?? []).length, 1)
    // 見出し（h3）は部品がどの状態でも出す（読み込み中・読めない・0回でも欄に名前がある）
    assert.equal((comp.match(/\{heading\(/g) ?? []).length, 3)
    assert.match(comp, /<h3 id=\{headingId\} className="text-lg font-bold text-ink">/)
    assert.match(comp, /`バイタルの推移（直近\$\{n\}回）`/)
    // 1人の画面の読み込み（load）は変えない（推移は部品が別に読む）
    assert.doesNotMatch(page, /fetchDaycareVitalsTrend/)
  })
  it('血圧の上・下はどちらも実線（破線は予測に見えるため使わない）。点の形（上＝丸・下＝四角）と凡例・直接の名前で見分ける', () => {
    assert.doesNotMatch(comp, /strokeDasharray/)
    // 点の形の決まりは trendLayout（下の純関数の試験で動きも確かめる）。描く側は四角を rect で描く
    assert.match(lib, /const kind: TrendMarker\['kind'\] = f === 'dia_bp' \? 'square' : lv === null \? 'circle' : 'triangle'/)
    assert.match(comp, /if \(m\.kind === 'square'\) return <rect /)
    assert.deepEqual(T === null ? { sys_bp: '上', dia_bp: '下' } : T.BP_SERIES_NAME, { sys_bp: '上', dia_bp: '下' })
  })
  it('部品は読むだけ（書き込み・送信待ち・購読なし）・端末に残さない・console なし・動きを付けない', () => {
    assert.match(comp, /import \{ fetchDaycareVitalsTrend \} from '\.\.\/lib\/db'/)
    assert.doesNotMatch(comp + lib, /localStorage|sessionStorage|indexedDB|console\./)
    assert.doesNotMatch(comp, /(?<!\.)\b(insert|update|upsert|save|mark|clear|enqueue|subscribe)[A-Z]\w*\(/)
    assert.doesNotMatch(comp, /animate-|transition|<animate/)
    assert.doesNotMatch(lib, /from '\.\/db/)
    // 判定は連絡帳と同じ vitalLevel（新しい基準を作らない）
    assert.match(lib, /return vitalLevel\(field, v, target \?\? null, limitsOf\(round\.day\)\)/)
    assert.doesNotMatch(lib, /dangerHigh|warnHigh|warnLow|warnBelow|dangerBelow/)
  })
  it('色は既存の変数だけ（バイタルの分類色・注意・危険・文字・面・線）。色の直書きなし・系列の色を文字に使わない', () => {
    assert.doesNotMatch(comp, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/)
    // tailwind.config.js の色の名前（tokens.css の変数）のうち、この部品が使ってよいもの
    const themeColors = [...read('../tailwind.config.js').matchAll(/^\s+'?([a-z][a-z0-9-]*)'?: 'var\(--c-[a-z0-9-]+\)'/gm)].map((m) => m[1])
    assert.ok(themeColors.includes('cat-vitals') && themeColors.includes('ink2'))
    const allowed = new Set(['cat-vitals', 'warn', 'danger', 'ink', 'ink2', 'ink3', 'surface', 'border', 'border-strong', 'link', 'warn-bg'])
    const used = [...comp.matchAll(/\b(?:fill|stroke|text|bg|border)-([a-z][a-z0-9-]*)/g)].map((m) => m[1]).filter((c) => themeColors.includes(c))
    assert.ok(used.includes('cat-vitals') && used.includes('warn') && used.includes('danger'))
    for (const c of used) assert.ok(allowed.has(c), `使っていない種類の色: ${c}`)
    assert.doesNotMatch(comp, /text-cat-vitals|fill-cat-vitals font|fill-cat-vitals text/)
    assert.doesNotMatch(comp, /(fill|stroke|text|bg|border)-\$\{/, '色のクラスを組み立てない（Tailwind が拾えない）')
  })
  it('押した回の行はグラフのすぐ下（全部の回の文を同じ場所に重ねて高さを動かさない）・〔‹ 前の回〕〔次の回 ›〕は 44px のボタン・読み上げは1か所', () => {
    const chart = comp.slice(comp.indexOf('function TrendChart('))
    const iSvg = chart.indexOf('<svg')
    const iRow = chart.indexOf('<div className="grid text-sm text-ink" aria-hidden="true">')
    const iBtn = chart.indexOf('前の回')
    assert.ok(iSvg > 0 && iRow > iSvg && iBtn > iRow, 'グラフ → 押した回の行 → ボタン')
    assert.match(chart, /\[grid-area:1\/1\] text-ink2 \$\{selIdx < 0 \? '' : 'invisible'\}/)
    assert.match(chart, /\{rounds\.map\(\(r, i\) => \(\s*<p key=\{r\.id\} className=\{`\[grid-area:1\/1\] \$\{i === selIdx \? '' : 'invisible'\}`\}>/)
    // 反証の確認 軽6: 端では disabled にせず aria-disabled（押しても動かない・フォーカスを失わない）。見た目は押せない時の決まり（ink3）
    assert.match(chart, /const btn = 'min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-base text-ink aria-disabled:text-ink3'/)
    assert.match(chart, /<button type="button" onClick=\{\(\) => prevIdx !== null && onStep\(-1\)\} aria-disabled=\{prevIdx === null\} className=\{btn\}>/)
    assert.match(chart, /<button type="button" onClick=\{\(\) => nextIdx !== null && onStep\(1\)\} aria-disabled=\{nextIdx === null\} className=\{btn\}>/)
    assert.doesNotMatch(chart, /(?<![-\w])disabled=\{/, "disabled は使わない（フォーカスを失うため）")
    assert.match(comp, /<p role="status" aria-live="polite" className="sr-only">/)
    // タップはいちばん近い回（nearestIndex）・ボタンは stepIndex（どちらも純関数）
    assert.match(chart, /const i = nearestIndex\(lay\.xs, /)
    assert.match(comp, /const step = \(dir: -1 \| 1\) => pickIdx\(stepIndex\(rounds\.length, selIdx < 0 \? null : selIdx, dir\), false\)/)
    // 選んだ回は行の id で持つ（selectedIndexOf）・出す回は測った幅から（trendWindow）
    assert.match(comp, /const rounds = useMemo\(\(\) => trendWindow\(all, plotW\), \[all, plotW\]\)/)
    assert.match(comp, /const selIdx = selectedIndexOf\(rounds, sel, key\)/)
  })
  it('読み直し: 画面の購読の知らせのうち、その方の表示中の日以前の測定（trendChangeHits）を数えて部品へ渡し、部品は 400ms でまとめて読み直す', () => {
    assert.match(page, /const offC = subscribeChanges\(\(table, info\) => \{\s*if \(trendChangeHits\(table, info, residentRef\.current, dayRef\.current\)\) setTrendChange\(\(n\) => n \+ 1\)\s*if \(table === 'vitals' \|\| table === 'meals' \|\| table === 'fluid_intake'\) onChange\(table, info\)/)
    // 判断は trendReloadStep（純関数）。人・日が変わったら待っている読み直しを消す（cancel）・schedule は TREND_RELOAD_MS 待って1回
    assert.match(comp, /const step = trendReloadStep\(seen\.current, next\)\s*seen\.current = next\s*if \(step === 'none'\) return\s*if \(timer\.current !== null\) window\.clearTimeout\(timer\.current\)\s*timer\.current = null\s*if \(step === 'cancel'\) return/)
    assert.match(comp, /\}, TREND_RELOAD_MS\)/)
    assert.match(comp, /\}, \[key, residentId, day, refreshKey, retry, tick\]\)/)
  })
  it('今日の値を読めなかった時: 画面の読み込みの失敗を部品に渡し（控えで開いた時は控えの値）、推移はその旨を出して「まだありません」と言い切らない', () => {
    assert.match(page, /fetchDaycareVitals\(target\)\.catch\(\(\) => null\),/)
    assert.match(page, /vitals: dv\?\.live \?\? \[\],\s*vitalsOk: dv !== null,/)
    assert.match(page, /vitals: m\.vitals,\s*vitalsOk: memoVitalsOk\(m\),/)
    // 反証の確認 軽4: 控えにも読めたかを渡す（読めなかった時に控えの読めたバイタルを空で上書きしない＝mergeDaycareMemo が前の値を残す）
    assert.match(page, /rememberDaycareDay\(\{[^}]*vitals: data\.vitals,[^}]*vitalsOk: data\.vitalsOk,[^}]*residents,\s*savedAt: data\.readAt,/)
    assert.match(comp, /\{dayRowsOk \? null : \(\s*<p role="status" className="rounded border border-warn bg-warn-bg p-2 text-sm text-ink">/)
    assert.match(comp, /\{dayRowsOk \? TREND_EMPTY_TEXT : TREND_EMPTY_DAY_UNREAD_TEXT\}/)
  })
  it('SVG は role="img" と読み上げの要約・表は本物の table（見出しの行と列）・〔数値で見る〕は 44px', () => {
    assert.match(comp, /role="img"\s+aria-label=\{speech\}/)
    assert.match(comp, /<table className="w-full border-collapse text-sm">\s*<caption className="sr-only">/)
    assert.match(comp, /<th scope="col"/)
    assert.match(comp, /<th scope="row"/)
    assert.match(comp, /<summary className="inline-flex min-h-tap /)
    assert.match(comp, /role="status" aria-live="polite"/)
  })
  it('db.ts: 推移の読み込みは1本の関数・2本の select だけ（書き込みなし）・〔未測定〕の節の外に置く', () => {
    const start = db.indexOf('export async function fetchDaycareVitalsTrend(')
    assert.ok(start > 0)
    const body = db.slice(start, db.indexOf('\n}\n', start))
    assert.equal((body.match(/\.from\(/g) ?? []).length, 2)
    assert.doesNotMatch(body, /\.(insert|update|upsert|delete|rpc)\(/)
    const sec = db.slice(db.indexOf('const UNMEASURED_MSG = {'), db.indexOf('const CONTACT_MSG = {'))
    assert.ok(!sec.includes('fetchDaycareVitalsTrend'))
  })
})
