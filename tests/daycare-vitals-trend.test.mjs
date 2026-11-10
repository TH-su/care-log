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
      assert.equal(T.trendReadout(r[2], lv, false), '11/10（火） 9:40 の回: 血圧 上 150／下 — mmHg・脈 未測定・SpO2 95%・体温 37.6℃（↑ 注意・高い）')
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
  it('置き場: 1人の画面のバイタルの欄の中で、入力（バイタル・食事への道・申し送りの印）の後。基準は画面の lookup をその方で渡す', () => {
    const vital = page.slice(page.indexOf('<section aria-labelledby="h-vital"'), page.indexOf('<section aria-labelledby="h-bath"'))
    const iLink = vital.indexOf('<Link to={DAYCARE_VITALS_MEALS_PATH}')
    const iMark = vital.indexOf("{ kind: 'vital' }")
    const iTrend = vital.indexOf('<DaycareVitalsTrend')
    assert.ok(iLink >= 0 && iMark > iLink && iTrend > iMark, '入力が先・グラフは後')
    assert.match(
      vital,
      /<DaycareVitalsTrend\s+residentId=\{residentId\}\s+day=\{data\.day\}\s+dayRows=\{data\.vitals\}\s+target=\{targets\.get\(residentId\)\}\s+limitsOf=\{\(d\) => limits\.lookup\(residentId, d\)\}\s+refreshKey=\{reloadKey\}\s+\/>/,
    )
    // 1人の画面の読み込み（load）は変えない（推移は部品が別に読む）
    assert.doesNotMatch(page, /fetchDaycareVitalsTrend/)
  })
  it('部品は読むだけ（書き込み・送信待ち・購読なし）・端末に残さない・console なし・動きを付けない', () => {
    assert.match(comp, /import \{ fetchDaycareVitalsTrend \} from '\.\.\/lib\/db'/)
    assert.doesNotMatch(comp + lib, /localStorage|sessionStorage|indexedDB|console\./)
    assert.doesNotMatch(comp, /\b(insert|update|upsert|save|mark|clear|enqueue|subscribe)[A-Z]\w*\(/)
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
    const allowed = new Set(['cat-vitals', 'warn', 'danger', 'ink', 'ink2', 'surface', 'border', 'border-strong', 'link', 'warn-bg'])
    const used = [...comp.matchAll(/\b(?:fill|stroke|text|bg|border)-([a-z][a-z0-9-]*)/g)].map((m) => m[1]).filter((c) => themeColors.includes(c))
    assert.ok(used.includes('cat-vitals') && used.includes('warn') && used.includes('danger'))
    for (const c of used) assert.ok(allowed.has(c), `使っていない種類の色: ${c}`)
    assert.doesNotMatch(comp, /text-cat-vitals|fill-cat-vitals font|fill-cat-vitals text/)
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
