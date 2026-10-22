// デイ（せせらぎ）の記録 段階1 の回帰テスト（2026-10-22・代表承認・検証計画 v2）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycare.ts）: デイの測定の冪等キー・次の回・到着と欠席の状態と検証・1日の一覧（予定の3値・重複・
//    名簿に無い方・照合できない予定・予定外・入院中）・テンキーの欄送り・範囲外と上下逆（保存しない）・判定・欠席の日の入浴の扱い・前回値
// 2. db.ts を偽の Supabase で動かす（通信しない）:
//    ・欠席の日の入浴（recordAbsentBath）: オンライン（先に欠席・後で欠席＝自動の行を直す・読んだ後に行ができた＝23505→読み直して更新・
//      人が記録した入浴は確認・予定なし・入浴の旗が封鎖）と圏外（送信待ち→再送の時に自動の行へ合流）＝反証レビュー 重大2
//    ・到着・欠席の追加と修正（23505 の自然キーは conflict・送るのは変えた列だけ）
//    ・予定（daycare_plan）の3値・関数が無い時
//    ・デイの測定は既存の apply_cell_edits に kind 'observation'・冪等キー 'dc:…' で届く
//    ・週間計画に書かない（D18: デイの全操作で kv_ で始まる関数・kv_entries への書込が0件）
// 3. 静的検査: 移行 0041（冪等・do $$ なし・vitals と 0011 に触れない）・types.ts の追加・ルートと記録ハブ・画面の規律
// 個人情報は置かない（利用者は数値IDと架空の「見本」姓だけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
/** 行コメントと複数行コメントを除いた本文（コメントの言葉に試験が反応しないように） */
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
/** SQL の行コメントを除いた本文 */
const sql = (p) =>
  read(p)
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')

const lsStore = new Map()
let DC = null
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
  DC = await import('../src/lib/daycare.ts')
  DB = await import('../src/lib/db.ts?daycare')
} catch (e) {
  loadError = e
  DC = null
}

/** 端末の今日（db.ts の localToday と同じ計算） */
function todayLocal() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const vital = (id, residentId, day, over = {}) => ({
  id,
  resident_id: residentId,
  measured_on: day,
  kind: 'observation',
  measured_at: '10:00',
  temp: null,
  sys_bp: null,
  dia_bp: null,
  pulse: null,
  spo2: null,
  note: null,
  symptom: null,
  recorded_by: null,
  rev: 1,
  client_key: null,
  ...over,
})
const planRow = (over = {}) => ({
  sched_id: 's1',
  event_id: 'e1',
  resident_id: 1,
  match: 'mid',
  dup: false,
  external: false,
  hospitalized: false,
  start_time: '9:30',
  end_time: '15:30',
  bathing: false,
  bath_resident_id: null,
  plan_rev: 3,
  updated_at: '2026-10-20T00:00:00Z',
  ...over,
})
const att = (id, residentId, over = {}) => ({
  id,
  resident_id: residentId,
  day: '2026-10-22',
  arrived_at: null,
  left_at: null,
  absent: false,
  absent_reason: null,
  note: null,
  recorded_by: 1,
  rev: 1,
  ...over,
})
const bath = (over = {}) => ({
  id: 9,
  resident_id: 1,
  bath_on: '2026-10-22',
  result: 'full',
  cancel_reason: null,
  note: null,
  recorded_by: null,
  rev: 1,
  auto: true,
  ...over,
})

if (DC === null) {
  registerLoadFailure('デイ（せせらぎ）段階1の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  // ════════════════════════════════════════════════════════════
  // 1. 純ロジック
  // ════════════════════════════════════════════════════════════
  describe('デイの測定の冪等キー（中10・取り消した回は使い直さない）', () => {
    it('組み立てと読み取り', () => {
      assert.equal(DC.daycareVitalKey('2026-10-22', 12, 1), 'dc:2026-10-22:12:1')
      assert.deepEqual(DC.parseDaycareVitalKey('dc:2026-10-22:12:3'), { day: '2026-10-22', residentId: 12, seq: 3 })
      for (const bad of ['q123-abc', 'dc:2026-10-22:0:1', 'dc:2026-10-22:12:0', 'dc:2026/10/22:12:1', 'dc:2026-10-22:12', null, 5, 'xdc:2026-10-22:1:1']) {
        assert.equal(DC.parseDaycareVitalKey(bad), null, String(bad))
      }
      assert.equal(DC.isDaycareVitalKey('dc:2026-10-22:1:1'), true)
      assert.equal(DC.isDaycareVitalKey('q1700000000000-abcd12'), false, '既存の冪等キー（newQid の形）はデイの測定と見なさない')
    })
    it('2台が同じ人の1回目を測ると同じキー（DB の一意で同じ行に合流する）', () => {
      assert.equal(DC.daycareVitalKey('2026-10-22', 5, DC.nextDaycareSeq([], '2026-10-22', 5)), DC.daycareVitalKey('2026-10-22', 5, 1))
    })
    it('次の回は「取り消した回も含めて使った最大＋1」（他の人・他の日のキーは数えない）', () => {
      const keys = ['dc:2026-10-22:5:1', 'dc:2026-10-22:5:2', 'dc:2026-10-22:6:7', 'dc:2026-10-21:5:9', 'q1-x']
      assert.equal(DC.nextDaycareSeq(keys, '2026-10-22', 5), 3)
      assert.equal(DC.nextDaycareSeq(keys, '2026-10-22', 6), 8)
      assert.equal(DC.nextDaycareSeq(keys, '2026-10-22', 7), 1)
    })
    it('1人の測定の並び: 生きている行を回の順に・無ければ次の回の空の行・足した再測定', () => {
      const live = [
        vital(2, 5, '2026-10-22', { client_key: 'dc:2026-10-22:5:3', temp: 37.9 }),
        vital(1, 5, '2026-10-22', { client_key: 'dc:2026-10-22:5:1', temp: 36.5 }),
        vital(3, 6, '2026-10-22', { client_key: 'dc:2026-10-22:6:1' }),
      ]
      const keys = ['dc:2026-10-22:5:1', 'dc:2026-10-22:5:2', 'dc:2026-10-22:5:3', 'dc:2026-10-22:6:1']
      assert.deepEqual(DC.daycareVitalSlots(live, keys, 5, '2026-10-22').map((s) => [s.seq, s.vital?.id ?? null]), [[1, 1], [3, 2]])
      assert.deepEqual(DC.daycareVitalSlots(live, keys, 5, '2026-10-22', [4]).map((s) => [s.seq, s.vital?.id ?? null]), [[1, 1], [3, 2], [4, null]])
      // 取り消した回だけの人（キーは残っている）→ 次の回の空の行
      assert.deepEqual(DC.daycareVitalSlots([], ['dc:2026-10-22:7:1'], 7, '2026-10-22').map((s) => s.key), ['dc:2026-10-22:7:2'])
    })
  })

  describe('到着・在席・帰宅・欠席（到着の1タップで在席）', () => {
    it('状態は列から導く', () => {
      assert.equal(DC.attendanceState(null), 'planned')
      assert.equal(DC.attendanceState(att(1, 1)), 'planned')
      assert.equal(DC.attendanceState(att(1, 1, { arrived_at: '09:30' })), 'present')
      assert.equal(DC.attendanceState(att(1, 1, { arrived_at: '09:30', left_at: '15:00' })), 'left')
      assert.equal(DC.attendanceState(att(1, 1, { absent: true, absent_reason: 'wish' })), 'absent')
    })
    it('検証（DB の check 0041 と同じ）', () => {
      const ok = (v) => DC.validateAttendance({ absent: false, absent_reason: null, arrived_at: null, left_at: null, ...v }).ok
      assert.equal(ok({ arrived_at: '09:30' }), true)
      assert.equal(ok({ absent: true, absent_reason: 'condition' }), true)
      assert.equal(ok({ absent: true }), false, '理由なしの欠席')
      assert.equal(ok({ absent: true, absent_reason: 'facility' }), false, '知らない理由')
      assert.equal(ok({ absent: true, absent_reason: 'family', arrived_at: '09:30' }), false, '欠席なのに到着')
      assert.equal(ok({ absent_reason: 'other' }), false, '欠席でないのに理由')
      assert.equal(ok({ left_at: '15:00' }), false, '到着なしの帰宅')
      assert.equal(ok({ arrived_at: '10:00', left_at: '09:00' }), false, '到着より前の帰宅')
      assert.equal(ok({ arrived_at: '25:00' }), false, '時刻の形')
    })
    it('時刻は HH:MM にそろえる（Postgres の time は秒つき）', () => {
      assert.equal(DC.hmOf('09:30:00'), '09:30')
      assert.equal(DC.hmOf('09:30'), '09:30')
      assert.equal(DC.hmOf('9:30'), null)
      assert.equal(DC.hmOf(null), null)
      assert.equal(DC.nowHm(new Date(2026, 9, 22, 9, 5)), '09:05')
    })
  })

  describe('1日の一覧（予定の3値・重複・名簿に無い方・照合できない予定）', () => {
    const roster = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
    it('予定1件ごとの行を人ごとにまとめる（同じ人の2件は2つ並べる＝1枠に畳まない）・時間順', () => {
      const b = DC.buildDaycareBoard({
        planRows: [
          planRow({ sched_id: 'a', resident_id: 2, start_time: '13:00', end_time: '15:30' }),
          planRow({ sched_id: 'a', event_id: 'e2', resident_id: 2, start_time: '9:30', end_time: '12:00', bathing: true }),
          planRow({ sched_id: 'b', resident_id: 1, start_time: '09:00' }),
        ],
        source: 'kv',
        residents: roster,
        attendance: [],
      })
      assert.deepEqual(b.rows.map((r) => r.residentId), [1, 2])
      assert.equal(DC.fmtPlanTimes(b.rows[1].plans), '9:30〜12:00／13:00〜15:30')
      assert.equal(b.rows[1].bathingPlanned, true)
      assert.equal(b.counts.planned, 2)
      assert.equal(b.counts.waiting, 2)
    })
    it('名簿に無い方（外部・名簿の在籍者に居ない）と照合できない予定（氏名の食い違い・絞れない）は数だけ・一覧に出さない', () => {
      const b = DC.buildDaycareBoard({
        planRows: [
          planRow({ sched_id: 'x1', resident_id: null, match: 'external', external: true }),
          planRow({ sched_id: 'x2', resident_id: null, match: 'absent_roster' }),
          planRow({ sched_id: 'x2', event_id: 'e2', resident_id: null, match: 'absent_roster' }),
          planRow({ sched_id: 'm1', resident_id: null, match: 'mismatch' }),
          planRow({ sched_id: 'm2', resident_id: null, match: 'ambiguous' }),
          planRow({ sched_id: 'ok', resident_id: 3 }),
        ],
        source: 'kv',
        residents: roster,
        attendance: [],
      })
      assert.equal(b.notInRoster, 2, '予定の記録の数で数える（同じ記録の2件は1つ）')
      assert.equal(b.unconfirmed, 2)
      assert.deepEqual(b.rows.map((r) => r.residentId), [3])
    })
    it('重複（dup）は「予定 要確認」で落とさない（時間のある予定の後ろ）・入院中は未到着に数えない・予定外の記録と足した人は最後', () => {
      const b = DC.buildDaycareBoard({
        planRows: [planRow({ sched_id: 'd1', resident_id: 1, dup: true }), planRow({ sched_id: 'd2', resident_id: 1, dup: true }), planRow({ sched_id: 'h', resident_id: 2, hospitalized: true })],
        source: 'kv',
        residents: roster,
        attendance: [att(10, 3, { arrived_at: '10:00' })],
        extraIds: [4],
      })
      assert.deepEqual(b.rows.map((r) => [r.residentId, r.dup, r.extra]), [[2, false, false], [1, true, false], [3, false, true], [4, false, true]])
      assert.equal(b.counts.hospitalized, 1)
      assert.equal(b.counts.planned, 1)
      assert.equal(b.counts.present, 1)
      assert.equal(b.counts.waiting, 1)
    })
    it('反証レビュー重大1: 氏名が食い違う予定（cron は入浴の行を作る）の方を予定外で足すと、入浴の予定ありになる（欠席で入浴を中止・欠席にする）', () => {
      const b = DC.buildDaycareBoard({
        planRows: [planRow({ sched_id: 'm1', resident_id: null, match: 'mismatch', bathing: true, bath_resident_id: 3 })],
        source: 'kv',
        residents: roster,
        attendance: [],
        extraIds: [3],
      })
      assert.equal(b.unconfirmed, 1)
      assert.deepEqual(b.rows.map((r) => [r.residentId, r.extra, r.bathingPlanned]), [[3, true, true]])
      assert.deepEqual(DC.absentBathAction(null, b.rows[0].bathingPlanned), { kind: 'insert' })
    })
    it('unknown と none は行を作らない（画面は帯で出し分ける）', () => {
      assert.equal(DC.buildDaycareBoard({ planRows: [], source: 'unknown', residents: roster, attendance: [] }).rows.length, 0)
      assert.equal(DC.buildDaycareBoard({ planRows: [], source: 'none', residents: roster, attendance: [] }).source, 'none')
    })
  })

  describe('テンキー（欄送りは桁数で自動）', () => {
    const type = (field, keys) => {
      let b = ''
      for (const k of keys) b = DC.keypadAppend(field, b, k)
      return b
    }
    it('体温: 365 → 36.5（3桁で埋まる）・36.5 も可・小数第2位は足さない', () => {
      assert.equal(DC.keypadComplete('temp', '36'), false)
      assert.equal(DC.keypadComplete('temp', '365'), true)
      assert.equal(DC.keypadValue('temp', '365'), 36.5)
      assert.equal(type('temp', ['3', '6', '.', '5']), '36.5')
      assert.equal(DC.keypadComplete('temp', '36.5'), true)
      assert.equal(DC.keypadValue('temp', '36.5'), 36.5)
      assert.equal(type('temp', ['3', '6', '.', '5', '5']), '36.5', '小数第2位は足さない（黙って丸めない）')
      assert.equal(type('temp', ['.', '3']), '3', '先頭の小数点は足さない')
    })
    it('血圧の上・脈: 先頭が1か2なら3桁・それ以外は2桁', () => {
      for (const f of ['sys_bp', 'pulse']) {
        assert.equal(DC.keypadComplete(f, '12'), false)
        assert.equal(DC.keypadComplete(f, '128'), true)
        assert.equal(DC.keypadComplete(f, '98'), true)
        assert.equal(DC.keypadComplete(f, '9'), false)
        assert.equal(type(f, ['1', '2', '8', '9']), '128', '4桁目は足さない')
      }
      assert.equal(type('pulse', ['.']), '', '整数の欄に小数点は無い')
    })
    it('血圧の下・SpO2: 先頭が1なら3桁・それ以外は2桁', () => {
      for (const f of ['dia_bp', 'spo2']) {
        assert.equal(DC.keypadComplete(f, '74'), true)
        assert.equal(DC.keypadComplete(f, '10'), false)
        assert.equal(DC.keypadComplete(f, '100'), true)
      }
      assert.equal(DC.keypadValue('spo2', '97'), 97)
    })
    it('欄の順（体温 → 血圧の上 → 下 → 脈 → SpO2）', () => {
      assert.deepEqual([...DC.DAYCARE_VITAL_FIELDS], ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2'])
    })
  })

  describe('範囲外と上下逆は保存しない・閾値を超えた値は保存して再測定（代表者の回答 5.2 の10）', () => {
    it('範囲（DB の check と同じ VITAL_RANGE）の境界', async () => {
      const { VITAL_RANGE } = await import('../src/lib/types.ts')
      for (const [f, [lo, hi]] of Object.entries(VITAL_RANGE)) {
        const step = f === 'temp' ? 0.1 : 1
        const r = (x) => Math.round(x * 10) / 10
        assert.equal(DC.vitalRangeError(f, lo), null, `${f} 下限ちょうど`)
        assert.equal(DC.vitalRangeError(f, hi), null, `${f} 上限ちょうど`)
        assert.notEqual(DC.vitalRangeError(f, r(lo - step)), null, `${f} 下限の外`)
        assert.notEqual(DC.vitalRangeError(f, r(hi + step)), null, `${f} 上限の外`)
      }
      assert.match(DC.vitalRangeError('pulse', 251), /脈は 20〜250 で入れてください（入れた値: 251）/)
      assert.equal(DC.vitalRangeError('temp', null), null)
    })
    it('血圧の上下逆（上 ≦ 下）は止める・片方だけは見ない', () => {
      assert.notEqual(DC.bpPairError(80, 120), null)
      assert.notEqual(DC.bpPairError(100, 100), null, '上下が同じも逆転と同じ扱い')
      assert.equal(DC.bpPairError(120, 80), null)
      assert.equal(DC.bpPairError(120, null), null)
      assert.equal(DC.bpPairError(null, 80), null)
    })
    it('判定は既存の画面と同じ（施設の基準・SpO2 は個別の下限）・閾値超えは再測定', () => {
      assert.equal(DC.vitalLevel('temp', 38.1), 'danger-high')
      assert.equal(DC.vitalLevel('temp', 37.5), 'warn-high')
      assert.equal(DC.vitalLevel('temp', 36.5), null)
      assert.equal(DC.vitalLevel('sys_bp', 151), 'danger-high')
      assert.equal(DC.vitalLevel('spo2', 91), 'warn-low')
      assert.equal(DC.vitalLevel('spo2', 91, { id: 1, resident_id: 1, fluid_target_ml: null, spo2_warn_below: 90, spo2_danger_below: 88, rev: 1 }), null)
      assert.equal(DC.vitalNeedsRecheck({ temp: 36.5, sys_bp: 120, dia_bp: 70, pulse: 70, spo2: 97 }), false)
      assert.equal(DC.vitalNeedsRecheck({ temp: 37.8 }), true)
      assert.equal(DC.firstAbnormalField({ temp: 36.5, sys_bp: 160, spo2: 89 }), 'sys_bp')
      assert.equal(DC.LEVEL_WORD['danger-high'], '危険・高い')
    })
  })

  describe('欠席の日の入浴の扱い（読んだ行から決める）', () => {
    it('行なし: 入浴の予定があれば追加・無ければ何もしない', () => {
      assert.deepEqual(DC.absentBathAction(null, true), { kind: 'insert' })
      assert.deepEqual(DC.absentBathAction(null, false), { kind: 'none' })
    })
    it('自動の行（全身浴・休業日の訪問）は確認なしで直す・人の「入浴した」は確認を挟む', () => {
      assert.deepEqual(DC.absentBathAction(bath({ auto: true }), true).kind, 'update')
      assert.equal(DC.absentBathAction(bath({ auto: true }), true).confirm, false)
      assert.equal(DC.absentBathAction(bath({ auto: true, result: 'visit' }), false).confirm, false)
      assert.equal(DC.absentBathAction(bath({ auto: false, result: 'shower' }), true).confirm, true)
    })
    it('既に中止: 欠席なら何もしない・人の別の理由は残す', () => {
      assert.equal(DC.absentBathAction(bath({ auto: false, result: 'cancel', cancel_reason: 'absent' }), true).kind, 'already')
      assert.equal(DC.absentBathAction(bath({ auto: false, result: 'cancel', cancel_reason: 'condition' }), true).kind, 'keep')
      assert.equal(DC.absentBathAction(bath({ auto: false, result: 'cancel', cancel_reason: null }), true).kind, 'keep')
    })
  })

  describe('デイの画面の入浴の状態（自動の記録＝確かめていない予定値を見分ける）', () => {
    it('予定なし・未・自動（未確認）・人の記録・入浴していない', () => {
      assert.equal(DC.daycareBathStatus(null, false).kind, 'noPlan')
      assert.equal(DC.daycareBathStatus(null, true).kind, 'todo')
      assert.equal(DC.daycareBathStatus(bath({ auto: true }), true).kind, 'auto')
      assert.equal(DC.daycareBathStatus(bath({ auto: false, result: 'shower' }), true).kind, 'done')
      assert.equal(DC.daycareBathStatus(bath({ auto: false, result: 'cancel', cancel_reason: 'absent' }), true).kind, 'notBathed')
      assert.equal(DC.daycareBathLabel(DC.daycareBathStatus(bath({ auto: true }), true)), '▲ 未確認（自動の記録: 全身浴）')
      assert.equal(DC.daycareBathLabel(DC.daycareBathStatus(bath({ auto: false, result: 'partial' }), true)), '✓ 部分浴・清拭')
      assert.equal(DC.daycareBathLabel(DC.daycareBathStatus(bath({ auto: false, result: 'cancel', cancel_reason: 'absent' }), true)), '入浴していない（欠席）')
      assert.equal(DC.daycareBathLabel(DC.daycareBathStatus(bath({ auto: false, result: 'cancel', cancel_reason: null }), true)), '入浴していない（理由なし）')
    })
    it('確かめていない＝予定ありの未記録か自動の記録のまま', () => {
      assert.equal(DC.bathNeedsCheck(DC.daycareBathStatus(null, true)), true)
      assert.equal(DC.bathNeedsCheck(DC.daycareBathStatus(bath({ auto: true }), true)), true)
      assert.equal(DC.bathNeedsCheck(DC.daycareBathStatus(bath({ auto: false }), true)), false)
      assert.equal(DC.bathNeedsCheck(DC.daycareBathStatus(null, false)), false)
    })
  })

  describe('止まった欄の「あなたの値」（反証レビュー2巡目 中1）', () => {
    it('止まった後に打ち直した値（送信待ち）で置き換える・送信待ちに無い欄と送信待ちが無い時はそのまま', () => {
      const cs = [
        { field: 'sys_bp', server: 150, base: null, mine: 140, reason: 'changed' },
        { field: 'dia_bp', server: 90, base: null, mine: 80, reason: 'changed' },
      ]
      const out = DC.overlayPendingMine(cs, { sys_bp: 128, pulse: 70 })
      assert.equal(out[0].mine, 128, '打ち直した上の値')
      assert.equal(out[0].server, 150, 'いまの値は変えない')
      assert.equal(out[1].mine, 80, '送信待ちに無い欄はそのまま')
      assert.equal(cs[0].mine, 140, '元の配列は変えない')
      assert.deepEqual(DC.overlayPendingMine(cs, null), cs)
      assert.equal(DC.overlayPendingMine(cs, { sys_bp: null })[0].mine, null, '空にした（null）も打ち直しとして扱う')
    })
  })

  describe('日付の切り替え・読み直しの前の片づけ（反証レビュー3巡目）', () => {
    it('送る欄: 上・下・ほかの欄を全部送る・送っている最中の欄は除く・入力が無ければ空', () => {
      assert.deepEqual(DC.releaseEditsOf({ sys_bp: 140, dia_bp: 80, temp: 36.8 }, undefined), { temp: 36.8, sys_bp: 140, dia_bp: 80 })
      assert.deepEqual(DC.releaseEditsOf({ sys_bp: 140, temp: 36.8 }, new Set(['temp'])), { sys_bp: 140 })
      assert.deepEqual(DC.releaseEditsOf({ pulse: null }, new Set()), { pulse: null }, '空にした（null）も送る')
      assert.deepEqual(DC.releaseEditsOf(undefined, undefined), {})
      assert.deepEqual(DC.releaseEditsOf({ sys_bp: 140, note: 'x' }, undefined), { sys_bp: 140 }, '知らない欄は送らない')
    })
    it('拒まれて送信待ちに残った値は載ったとみなす（値が同じ欄が全部ある時だけ）', () => {
      assert.equal(DC.editsHeldInQueue({ sys_bp: 140, dia_bp: 80 }, { sys_bp: 140, dia_bp: 80, temp: 36.5 }), true)
      assert.equal(DC.editsHeldInQueue({ sys_bp: 140, dia_bp: 80 }, { sys_bp: 140 }), false, '下が控えに無い')
      assert.equal(DC.editsHeldInQueue({ sys_bp: 150 }, { sys_bp: 140 }), false, '控えの値が違う（打ち直した）')
      assert.equal(DC.editsHeldInQueue({ pulse: null }, { pulse: null }), true)
      assert.equal(DC.editsHeldInQueue({ sys_bp: 140 }, null), false, '控えが無い（送る前に止まった）')
      assert.equal(DC.editsHeldInQueue({}, { sys_bp: 140 }), false)
    })
    it('帯の項目: 入力が残る項目は入力が無くなったら外す・捨てた項目は残す', () => {
      const issues = [
        { key: 'dc:2026-10-22:3:1', kept: true, reason: 'a' },
        { key: 'dc:2026-10-22:5:2', kept: true, reason: 'b' },
        { key: 'dc:2026-10-22:6:1', kept: false, reason: 'c' },
      ]
      const out = DC.pruneReleaseIssues(issues, (k) => k === 'dc:2026-10-22:5:2')
      assert.deepEqual(out.map((i) => i.key), ['dc:2026-10-22:5:2', 'dc:2026-10-22:6:1'])
    })
    it('帯の見出し: 誰の何回目か（絞り込みで見えない方でも分かる）', () => {
      const nameOf = (id) => `見本 ${id}`
      assert.equal(DC.releaseIssueLabel('dc:2026-10-22:3:1', nameOf), '見本 3（1回目）')
      assert.equal(DC.releaseIssueLabel('dc:2026-10-22:3:3', nameOf), '見本 3（再測定 2）')
      assert.equal(DC.releaseIssueLabel('bad', nameOf), '（測定を特定できません）')
    })
  })

  describe('日報の発熱者に載せるデイの測定（代表者の決定 2026-10-22）', () => {
    it('発熱の判定はタイムラインの「▲発熱」と同じ（37.5℃以上＝注意の高値以上）', () => {
      assert.equal(DC.isFeverTemp(37.4), false)
      assert.equal(DC.isFeverTemp(37.5), true)
      assert.equal(DC.isFeverTemp(38.2), true)
      assert.equal(DC.isFeverTemp(35.0), false, '低い体温は発熱ではない')
      assert.equal(DC.isFeverTemp(null), false)
      assert.equal(DC.isFeverTemp(undefined), false)
    })
    it('1回でも発熱した方はその日のデイの測定を全部（再測定の経過）・発熱の無い方のデイの測定は載せない・日報で入れた発熱者はそのまま', () => {
      const list = [
        vital(1, 5, '2026-10-22', { temp: 37.8 }), // デイ・1回目 発熱
        vital(2, 5, '2026-10-22', { temp: 37.0 }), // デイ・再測定（下がった）
        vital(3, 6, '2026-10-22', { temp: 36.4 }), // デイ・発熱なし
        vital(4, 7, '2026-10-22', { temp: 36.8 }), // 日報で入れた発熱者（デイではない）
        vital(5, 6, '2026-10-22', { temp: null, pulse: 80 }), // デイ・体温なし
      ]
      assert.deepEqual(DC.dailyFeverObservations(list, [1, 2, 3, 5]).map((v) => v.id), [1, 2, 4])
      assert.deepEqual(DC.dailyFeverObservations(list, undefined).map((v) => v.id), [1, 2, 3, 4, 5], '分からない時は今までどおり全部')
      assert.deepEqual(DC.dailyFeverObservations(list, []).map((v) => v.id), [1, 2, 3, 4, 5], 'デイの測定が無い日はそのまま')
      // 日報で直している最中の行（止まった控え・送信待ち）がある方は、発熱が無くてもその日のデイの測定を載せ続ける（4巡目 F1・F9）
      assert.deepEqual(DC.dailyFeverObservations(list, [1, 2, 3, 5], new Set([3])).map((v) => v.id), [1, 2, 3, 4, 5])
      assert.deepEqual(DC.dailyFeverObservations(list, [1, 2, 3, 5], new Set([4])).map((v) => v.id), [1, 2, 4], 'デイ以外の行は印に関係なく今までどおり')
    })
  })

  describe('過去の日の到着・帰宅の時刻（代表者の決定 2026-10-22・0042）', () => {
    it('予定の時刻（1桁の時も）を小窓の初めの値に', () => {
      assert.equal(DC.planHm('9:30'), '09:30')
      assert.equal(DC.planHm('09:05'), '09:05')
      assert.equal(DC.planHm('15:30:00'), '15:30')
      assert.equal(DC.planHm('25:00'), null)
      assert.equal(DC.planHm(''), null)
      assert.equal(DC.planHm(null), null)
    })
    it('事務所・管理者だけ過去の日も・今日は誰でも・未来は誰も・役割が分からない時は現場と同じ', () => {
      assert.equal(DC.canEditPastDaycareTimes('office'), true)
      assert.equal(DC.canEditPastDaycareTimes('admin'), true)
      assert.equal(DC.canEditPastDaycareTimes('field'), false)
      assert.equal(DC.canEditPastDaycareTimes(null), false)
      assert.equal(DC.canEditPastDaycareTimes(undefined), false)
      assert.equal(DC.canChangeDaycareTimes('2026-10-22', '2026-10-22', 'field'), true)
      assert.equal(DC.canChangeDaycareTimes('2026-10-21', '2026-10-22', 'field'), false)
      assert.equal(DC.canChangeDaycareTimes('2026-10-21', '2026-10-22', 'office'), true)
      assert.equal(DC.canChangeDaycareTimes('2026-10-23', '2026-10-22', 'office'), false)
    })
  })

  describe('前回値・絞り込み', () => {
    it('前回値は欄ごとに直近（種類を問わない・その日のデイの測定を除く）', () => {
      const rows = [
        vital(1, 5, '2026-10-20', { temp: 36.4, sys_bp: 120, dia_bp: 70 }),
        vital(2, 5, '2026-10-21', { kind: 'routine', temp: 36.6 }),
        vital(3, 5, '2026-10-22', { client_key: 'dc:2026-10-22:5:1', temp: 38.0 }),
        vital(4, 5, '2026-10-22', { kind: 'routine', measured_at: '07:00', pulse: 66 }),
        vital(5, 6, '2026-10-21', { temp: 35.9 }),
      ]
      const p = DC.previousVitalOf(rows, 5, '2026-10-22')
      assert.deepEqual(p.temp, { value: 36.6, on: '2026-10-21' })
      assert.deepEqual(p.sys_bp, { value: 120, on: '2026-10-20' })
      assert.deepEqual(p.pulse, { value: 66, on: '2026-10-22' }, '今日のホームの定時は前回に数える')
      assert.equal(p.spo2, undefined)
    })
    it('絞り込みは既知値だけ（壊れた値・知らない値は既定）', () => {
      assert.equal(DC.readDcVitalsFilter('planned'), 'planned')
      for (const bad of [null, '', 'xxx', '__proto__', 'x'.repeat(10000), 5]) assert.equal(DC.readDcVitalsFilter(bad), 'present')
    })
  })

  // ════════════════════════════════════════════════════════════
  // 2. db.ts を偽の Supabase で動かす
  // ════════════════════════════════════════════════════════════

  function fakeServer(opts = {}) {
    const db = {
      bath_records: [],
      daycare_attendance: [],
      daycare_days: [],
      vitals: [],
      nextId: 100,
      settings: { native_input_enabled: 'true', input_enabled_bath: 'true', input_enabled_daycare: 'true' },
      rpcLog: [],
      writeLog: [],
      planRows: [],
      rpcMissing: new Set(),
      cellCalls: [],
      /** 次の select の後に1回だけ動く（「読んだ後に行ができた」の再現） */
      afterSelect: null,
    }
    const like = (v, pat) => typeof v === 'string' && v.startsWith(pat.replace(/%$/, ''))
    const match = (q, r) =>
      q.filters.every(([op, k, v]) => {
        if (op === 'eq') return r[k] === v
        if (op === 'is') return r[k] === v
        if (op === 'in') return v.includes(r[k])
        if (op === 'gte') return r[k] >= v
        if (op === 'lte') return r[k] <= v
        if (op === 'like') return like(r[k], v)
        return true
      })
    const natural = (table, p) =>
      table === 'bath_records'
        ? db.bath_records.some((r) => r.deleted_at === null && r.resident_id === p.resident_id && r.bath_on === p.bath_on)
        : table === 'daycare_attendance'
          ? db.daycare_attendance.some((r) => r.deleted_at === null && r.resident_id === p.resident_id && r.day === p.day)
          : false
    const handle = (q) => {
      if (opts.offline?.()) return { data: null, error: { message: 'offline' }, status: 0 }
      if (q.action === 'rpc') {
        db.rpcLog.push(q.fn)
        if (db.rpcMissing.has(q.fn)) return { data: null, error: { code: 'PGRST202', message: 'not found' }, status: 404 }
        if (q.fn === 'daycare_plan') return { data: db.planRows.map((r) => ({ ...r })), error: null, status: 200 }
        if (q.fn === 'daycare_open_day') {
          let d = db.daycare_days.find((x) => x.day === q.args.p_day)
          if (!d) {
            const real = db.planRows.filter((r) => r.sched_id !== null)
            d = { id: db.nextId++, day: q.args.p_day, plan_source: db.planRows.length === 0 ? 'unknown' : real.length === 0 ? 'none' : 'kv', plan_rev: 3, plan_updated_at: null, plan_rows: real, opened_by: q.args.p_staff, created_at: 'x', rev: 1 }
            db.daycare_days.push(d)
          }
          return { data: { ...d }, error: null, status: 200 }
        }
        if (q.fn === 'apply_cell_edits') {
          db.cellCalls.push(q.args)
          if (q.args.p_table === 'probe') return { data: { version: 1, status: 'probe' }, error: null, status: 200 }
          const key = q.args.p_key
          let row = db.vitals.find((v) => v.client_key === key.client_key)
          const fields = Object.keys(q.args.p_edits)
          if (!row) {
            row = { id: db.nextId++, resident_id: key.resident_id, measured_on: key.measured_on, kind: key.kind, client_key: key.client_key, measured_at: q.args.p_fill?.measured_at ?? null, temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null, note: null, symptom: null, recorded_by: q.args.p_fill?.recorded_by ?? null, rev: 1, deleted_at: null }
            db.vitals.push(row)
          }
          for (const f of fields) row[f] = q.args.p_edits[f].value
          const { client_key: _ck, deleted_at: _d, ...out } = row
          return { data: { version: 1, status: 'applied', row: out, applied: fields, settled: [], conflicts: [] }, error: null, status: 200 }
        }
        return { data: null, error: null, status: 200 }
      }
      if (q.table === 'app_settings') {
        const key = q.filters.find(([op, k]) => op === 'eq' && k === 'key')?.[2]
        return { data: key in db.settings ? { value: db.settings[key] } : null, error: null, status: 200 }
      }
      if (q.action === 'insert' || q.action === 'update') db.writeLog.push(q.table)
      const rows = db[q.table]
      if (!Array.isArray(rows)) return q.action === 'select' ? { data: [], error: null, status: 200 } : { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
      if (q.action === 'insert') {
        const p = q.payload
        if ((p.client_key && rows.some((r) => r.client_key === p.client_key)) || natural(q.table, p)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' }, status: 409 }
        }
        const row = { id: db.nextId++, rev: 1, deleted_at: null, edited_by: null, auto: false, created_at: 'x', ...p }
        rows.push(row)
        return { data: { ...row }, error: null, status: 201 }
      }
      if (q.action === 'update') {
        const r = rows.find((x) => match(q, x))
        if (!r) return { data: null, error: null, status: 200 }
        Object.assign(r, q.payload, { rev: r.rev + 1 })
        return { data: { ...r }, error: null, status: 200 }
      }
      const hits = rows.filter((x) => match(q, x))
      const out = q.limit === 1 ? { data: hits[0] ? { ...hits[0] } : null, error: null, status: 200 } : { data: hits.map((x) => ({ ...x })), error: null, status: 200 }
      if (db.afterSelect !== null && q.table === 'bath_records') {
        const f = db.afterSelect
        db.afterSelect = null
        f()
      }
      return out
    }
    const builder = (q) => {
      const run = () => Promise.resolve(handle(q))
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
        gte(k, v) {
          q.filters.push(['gte', k, v])
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
        or() {
          return b
        },
        limit(n) {
          q.limit = n
          return b
        },
        order() {
          return b
        },
        abortSignal() {
          return b
        },
        maybeSingle() {
          if (q.limit === undefined) q.limit = 1
          return run()
        },
        single: run,
        then: (ok, ng) => run().then(ok, ng),
      }
      return b
    }
    const channel = () => {
      const ch = { on: () => ch, subscribe: () => ch }
      return ch
    }
    const client = {
      from: (table) => builder({ table, action: 'select', payload: undefined, filters: [] }),
      rpc: (fn, args) => builder({ table: null, action: 'rpc', fn, args, payload: undefined, filters: [] }),
      channel,
      removeChannel: () => Promise.resolve(),
      auth: {
        onAuthStateChange() {
          return { data: { subscription: { unsubscribe() {} } } }
        },
        getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1' } } }, error: null }),
      },
    }
    return { client, db }
  }

  async function reset() {
    await new Promise((r) => setTimeout(r, 5))
    lsStore.clear()
    await DB.__testHooks.restartQueue()
    DB.__testHooks.setClient(null)
  }

  const T = todayLocal()

  describe('日報の取得: デイの測定の行 id を添える（行に client_key は載せない）', () => {
    it('fetchDailyReport・fetchDailyReports は観察（observation）のうち dc: の行の id を daycareVitalIds に入れる', async () => {
      const s = fakeServer()
      s.db.vitals.push(
        { ...vital(1, 5, T, { temp: 37.8, client_key: `dc:${T}:5:1` }), deleted_at: null },
        { ...vital(2, 5, T, { temp: 36.9 }), deleted_at: null },
        { ...vital(3, 6, T, { temp: 36.4, client_key: `dc:${T}:6:1` }), deleted_at: null },
        { ...vital(4, 6, T, { kind: 'symptom', client_key: 'other-key' }), deleted_at: null },
      )
      const cols = []
      const from0 = s.client.from
      s.client.from = (table) => {
        const b = from0(table)
        const sel = b.select
        b.select = (c) => {
          if (table === 'vitals') cols.push(c)
          return sel(c)
        }
        return b
      }
      DB.__testHooks.setClient(s.client)
      const one = await DB.fetchDailyReport(T, null)
      assert.deepEqual(one.observations.map((v) => v.id), [1, 2, 3])
      assert.deepEqual(one.daycareVitalIds, [1, 3])
      assert.equal(one.observations.some((v) => 'client_key' in v), false, '行には client_key を載せない（normalizeVital のまま）')
      const many = await DB.fetchDailyReports([T], null)
      assert.deepEqual(many.get(T).daycareVitalIds, [1, 3])
      assert.ok(cols.length >= 2 && cols.every((c) => /,client_key$/.test(c)), `vitals の select: ${cols.join(' | ')}`)
      await reset()
    })
  })

  describe('欠席の日の入浴 recordAbsentBath（反証レビュー 重大2・オンライン）', () => {
    it('先に欠席（行なし・入浴の予定あり）→「中止・欠席」を追加（12:30 の自動の行は作られなくなる）', async () => {
      const s = fakeServer()
      DB.__testHooks.setClient(s.client)
      const r = await DB.recordAbsentBath({ residentId: 1, day: T, bathingPlanned: true, recordedBy: 2 })
      assert.equal(r.status, 'done')
      assert.deepEqual(s.db.bath_records.map((b) => [b.result, b.cancel_reason, b.auto, b.recorded_by]), [['cancel', 'absent', false, 2]])
      await reset()
    })
    it('後で欠席（自動の「全身浴」がある）→ 同じ行を「中止・欠席」・auto=false・記入者つきに直す（23505 で止まらない）', async () => {
      const s = fakeServer()
      s.db.bath_records.push({ id: 50, resident_id: 1, bath_on: T, result: 'full', cancel_reason: null, note: null, recorded_by: null, rev: 1, auto: true, deleted_at: null })
      DB.__testHooks.setClient(s.client)
      const r = await DB.recordAbsentBath({ residentId: 1, day: T, bathingPlanned: true, recordedBy: 2 })
      assert.equal(r.status, 'done')
      assert.equal(s.db.bath_records.length, 1)
      const b = s.db.bath_records[0]
      assert.deepEqual([b.result, b.cancel_reason, b.auto, b.recorded_by, b.rev], ['cancel', 'absent', false, 2, 2])
      await reset()
    })
    it('読んだ時は無く、書く前に自動の行ができた（追加が 23505）→ 読み直して更新する', async () => {
      const s = fakeServer()
      s.db.afterSelect = () =>
        s.db.bath_records.push({ id: 51, resident_id: 1, bath_on: T, result: 'full', cancel_reason: null, note: null, recorded_by: null, rev: 1, auto: true, deleted_at: null })
      DB.__testHooks.setClient(s.client)
      const r = await DB.recordAbsentBath({ residentId: 1, day: T, bathingPlanned: true, recordedBy: 2 })
      assert.equal(r.status, 'done')
      assert.deepEqual(s.db.bath_records.map((b) => [b.id, b.result, b.cancel_reason, b.auto]), [[51, 'cancel', 'absent', false]])
      await reset()
    })
    it('人が記録した「入浴した」は確認が要る（確認すれば直す）', async () => {
      const s = fakeServer()
      s.db.bath_records.push({ id: 52, resident_id: 1, bath_on: T, result: 'full', cancel_reason: null, note: null, recorded_by: 3, rev: 4, auto: false, deleted_at: null })
      DB.__testHooks.setClient(s.client)
      const r1 = await DB.recordAbsentBath({ residentId: 1, day: T, bathingPlanned: true, recordedBy: 2 })
      assert.equal(r1.status, 'needsConfirm')
      assert.equal(s.db.bath_records[0].result, 'full', '確認の前は直さない')
      const r2 = await DB.recordAbsentBath({ residentId: 1, day: T, bathingPlanned: true, recordedBy: 2, confirmManual: true })
      assert.equal(r2.status, 'done')
      assert.deepEqual([s.db.bath_records[0].result, s.db.bath_records[0].cancel_reason], ['cancel', 'absent'])
      await reset()
    })
    it('入浴の予定も行も無い → 何も書かない・既に欠席 → already・人の中止（別の理由）→ そのまま', async () => {
      const s = fakeServer()
      DB.__testHooks.setClient(s.client)
      assert.equal((await DB.recordAbsentBath({ residentId: 1, day: T, bathingPlanned: false, recordedBy: 2 })).status, 'none')
      assert.equal(s.db.bath_records.length, 0)
      s.db.bath_records.push({ id: 53, resident_id: 2, bath_on: T, result: 'cancel', cancel_reason: 'absent', note: null, recorded_by: 2, rev: 1, auto: false, deleted_at: null })
      s.db.bath_records.push({ id: 54, resident_id: 3, bath_on: T, result: 'cancel', cancel_reason: 'condition', note: null, recorded_by: 2, rev: 1, auto: false, deleted_at: null })
      assert.equal((await DB.recordAbsentBath({ residentId: 2, day: T, bathingPlanned: true, recordedBy: 2 })).status, 'already')
      assert.equal((await DB.recordAbsentBath({ residentId: 3, day: T, bathingPlanned: true, recordedBy: 2 })).status, 'kept')
      assert.equal(s.db.bath_records.find((b) => b.id === 54).cancel_reason, 'condition')
      await reset()
    })
    it('入浴の旗が封鎖 → 入浴の行は書かずに blocked（理由つき）', async () => {
      const s = fakeServer()
      s.db.settings.input_enabled_bath = 'false'
      DB.__testHooks.setClient(s.client, { kinds: { bath: false } })
      const r = await DB.recordAbsentBath({ residentId: 1, day: T, bathingPlanned: true, recordedBy: 2 })
      assert.equal(r.status, 'blocked')
      assert.match(r.message, /入浴の記録はまだ使い始めていません/)
      assert.equal(s.db.bath_records.length, 0)
      await reset()
    })
  })

  describe('〔予定どおり実施〕: 自動の記録を同じ区分のまま人の記録にする（既存の updateBath・cron は変えない）', () => {
    it('自動の「全身浴」→ 区分はそのまま・auto=false・記入者つき・rev が進む（確かめた印）', async () => {
      const s = fakeServer()
      s.db.bath_records.push({ id: 70, resident_id: 1, bath_on: T, result: 'full', cancel_reason: null, note: null, recorded_by: null, rev: 1, auto: true, deleted_at: null })
      DB.__testHooks.setClient(s.client)
      const cur = (await DB.fetchBathDay(T)).find((b) => b.resident_id === 1)
      assert.equal(cur.auto, true)
      const r = await DB.updateBath(cur, { result: cur.result, cancel_reason: null }, { editedBy: 2 })
      assert.deepEqual([r.result, r.auto, r.recorded_by, r.rev], ['full', false, 2, 2])
      await reset()
    })
  })

  describe('欠席の日の入浴（圏外 → 電波が戻る）', () => {
    it('圏外で欠席 → 追加を送信待ちへ → その間に自動の行ができ → 再送で自動の行へ合流（1行・中止・欠席・auto=false）', async () => {
      let off = true
      const s = fakeServer({ offline: () => off })
      DB.__testHooks.setClient(s.client)
      const r = await DB.recordAbsentBath({ residentId: 1, day: T, bathingPlanned: true, recordedBy: 2 })
      assert.equal(r.status, 'queued')
      assert.equal(DB.queuePending() > 0, true)
      // 12:30 の自動の行（cron）
      s.db.bath_records.push({ id: 60, resident_id: 1, bath_on: T, result: 'full', cancel_reason: null, note: null, recorded_by: null, rev: 1, auto: true, deleted_at: null })
      off = false
      await DB.flushQueue(true)
      assert.equal(s.db.bath_records.length, 1, '重複0')
      const b = s.db.bath_records[0]
      assert.deepEqual([b.result, b.cancel_reason, b.auto, b.recorded_by], ['cancel', 'absent', false, 2])
      assert.equal(DB.queuePending(), 0, '欠落0（送信待ちが空になった）')
      await reset()
    })
    it('圏外で欠席・相手が人の記録 → 止まって listStoppedOps に出る（黙って上書きしない）', async () => {
      let off = true
      const s = fakeServer({ offline: () => off })
      DB.__testHooks.setClient(s.client)
      await DB.recordAbsentBath({ residentId: 1, day: T, bathingPlanned: true, recordedBy: 2 })
      s.db.bath_records.push({ id: 61, resident_id: 1, bath_on: T, result: 'full', cancel_reason: null, note: null, recorded_by: 3, rev: 1, auto: false, deleted_at: null })
      off = false
      await DB.flushQueue(true)
      assert.equal(s.db.bath_records[0].result, 'full')
      const stopped = DB.listStoppedOps().filter((o) => o.table === 'bath_records')
      assert.equal(stopped.length, 1)
      assert.equal(stopped[0].state, 'conflict')
      await reset()
    })
  })

  describe('到着・欠席の追加と修正（daycare_attendance）', () => {
    it('追加: 冪等キーつき・同じ人・同じ日に他の端末が先 → conflict（入力は消さず読み直し）', async () => {
      const s = fakeServer()
      DB.__testHooks.setClient(s.client)
      const r = await DB.insertDaycareAttendance({ resident_id: 1, day: T, arrived_at: '09:30', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: 2 })
      assert.equal(r.arrived_at, '09:30')
      assert.match(s.db.daycare_attendance[0].client_key, /^q\d+-/)
      const c = await DB.insertDaycareAttendance({ resident_id: 1, day: T, arrived_at: '09:40', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: 3 })
      assert.equal(c, 'conflict')
      assert.equal(s.db.daycare_attendance.length, 1)
      await reset()
    })
    it('修正: 送るのは変えた列だけ（帰宅だけ）・欠席の付け外しは理由・時刻をそろえて送る・rev 照合', async () => {
      const s = fakeServer()
      DB.__testHooks.setClient(s.client)
      const a = await DB.insertDaycareAttendance({ resident_id: 1, day: T, arrived_at: '09:30', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: 2 })
      const sent = []
      const orig = s.client.from
      s.client.from = (t) => {
        const b = orig(t)
        const up = b.update
        b.update = (p) => {
          sent.push(Object.keys(p).sort())
          return up(p)
        }
        return b
      }
      const left = await DB.updateDaycareAttendance(a, { left_at: '15:10' }, { editedBy: 2 })
      assert.equal(left.left_at, '15:10')
      const ab = await DB.updateDaycareAttendance(left, { absent: true, absent_reason: 'wish' }, { editedBy: 2 })
      assert.deepEqual([ab.absent, ab.absent_reason, ab.arrived_at, ab.left_at], [true, 'wish', null, null])
      assert.deepEqual(sent, [['edited_by', 'left_at'], ['absent', 'absent_reason', 'arrived_at', 'edited_by', 'left_at']])
      // 古い rev では書かない
      const stale = await DB.updateDaycareAttendance(a, { left_at: '15:20' }, { editedBy: 2 })
      assert.equal(stale, 'conflict')
      s.client.from = orig
      await reset()
    })
    it('検証: 未来の日・理由なしの欠席は送らずに止める', async () => {
      const s = fakeServer()
      DB.__testHooks.setClient(s.client)
      await assert.rejects(
        DB.insertDaycareAttendance({ resident_id: 1, day: '2999-01-01', arrived_at: '09:30', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: 2 }),
        /未来の日には記録できません/,
      )
      await assert.rejects(
        DB.insertDaycareAttendance({ resident_id: 1, day: T, arrived_at: null, left_at: null, absent: true, absent_reason: null, note: null, recorded_by: 2 }),
        /欠席の理由を選んでください/,
      )
      assert.equal(s.db.daycare_attendance.length, 0)
      await reset()
    })
    it('デイの旗が封鎖なら書かない（input_enabled_daycare）', async () => {
      const s = fakeServer()
      s.db.settings.input_enabled_daycare = 'false'
      DB.__testHooks.setClient(s.client, { kinds: { daycare: false } })
      await assert.rejects(
        DB.insertDaycareAttendance({ resident_id: 1, day: T, arrived_at: '09:30', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: 2 }),
        /デイの記録はまだ使い始めていません/,
      )
      assert.equal(s.db.daycare_attendance.length, 0)
      await reset()
    })
    it('圏外の追加は送信待ちへ（同じ表の経路）→ 戻れば送る', async () => {
      let off = true
      const s = fakeServer({ offline: () => off })
      DB.__testHooks.setClient(s.client)
      const r = await DB.insertDaycareAttendance({ resident_id: 1, day: T, arrived_at: '09:30', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: 2 })
      assert.equal(r, 'queued')
      assert.equal(DB.hasPendingDaycareAttendance(1, T, null), true)
      off = false
      await DB.flushQueue(true)
      assert.equal(s.db.daycare_attendance.length, 1)
      assert.equal(DB.hasPendingDaycareAttendance(1, T, null), false)
      await reset()
    })
  })

  describe('予定（daycare_plan）の3値', () => {
    it('0行＝unknown・予定なしの1行＝none・行あり＝kv・関数が無い＝unknown＋missing', async () => {
      const s = fakeServer()
      DB.__testHooks.setClient(s.client)
      assert.deepEqual(await DB.fetchDaycarePlan(T), { source: 'unknown', rows: [], rev: null, updatedAt: null, missing: false })
      s.db.planRows = [planRow({ sched_id: null, event_id: null, resident_id: null, match: null, plan_rev: 8 })]
      const none = await DB.fetchDaycarePlan(T)
      assert.deepEqual([none.source, none.rows.length, none.rev], ['none', 0, 8])
      s.db.planRows = [planRow(), planRow({ sched_id: 's2', resident_id: 2, match: 'nonsense' })]
      const kv = await DB.fetchDaycarePlan(T)
      assert.equal(kv.source, 'kv')
      assert.deepEqual(kv.rows.map((r) => [r.resident_id, r.match]), [[1, 'mid'], [2, null]], '知らない照合の値は null（受信値を信じない）')
      s.db.rpcMissing.add('daycare_plan')
      assert.deepEqual((await DB.fetchDaycarePlan(T)).missing, true)
      await reset()
    })
    it('開所の写しは今日だけ（昨日は呼ばずに止める）', async () => {
      const s = fakeServer()
      s.db.planRows = [planRow()]
      DB.__testHooks.setClient(s.client)
      const d = await DB.openDaycareDay(T, 2)
      assert.equal(d.plan_source, 'kv')
      await assert.rejects(DB.openDaycareDay('2026-01-01', 2), /今日の分だけ/)
      assert.equal(s.db.rpcLog.filter((f) => f === 'daycare_open_day').length, 1)
      await reset()
    })
  })

  describe('デイの測定は既存の apply_cell_edits（0011）へ kind=observation・冪等キー dc: で届く', () => {
    it('saveVitalEdits の p_key と p_client_key', async () => {
      const s = fakeServer()
      DB.__testHooks.setClient(s.client)
      const key = DC.daycareVitalKey(T, 1, 1)
      const r = await DB.saveVitalEdits(
        { routine: false, clientKey: key, residentId: 1, day: T, kind: 'observation' },
        { temp: { value: 36.8, base: null } },
        { fill: { measured_at: '10:05', recorded_by: 2 }, editedBy: 2 },
      )
      assert.equal(r.status, 'applied')
      const call = s.db.cellCalls.find((c) => c.p_table === 'vitals')
      assert.deepEqual(call.p_key, { client_key: key, resident_id: 1, measured_on: T, kind: 'observation' })
      assert.equal(call.p_client_key, key)
      const got = await DB.fetchDaycareVitals(T)
      assert.deepEqual(got.live.map((v) => [v.client_key, v.temp, v.kind]), [[key, 36.8, 'observation']])
      assert.deepEqual(got.keys, [key])
      await reset()
    })
  })

  describe('D18 週間計画に書かない（デイの全操作で kv_ の関数・kv_entries への書込が0件）', () => {
    it('開所・到着・帰宅・欠席・取り消し・入浴・バイタル・読み取りで呼んだ関数と書いた表の集合', async () => {
      const s = fakeServer()
      s.db.planRows = [planRow({ resident_id: 1, bathing: true }), planRow({ sched_id: 's2', resident_id: 2 })]
      DB.__testHooks.setClient(s.client)
      await DB.fetchDaycarePlan(T)
      await DB.fetchDaycareDay(T)
      await DB.openDaycareDay(T, 2)
      const a1 = await DB.insertDaycareAttendance({ resident_id: 1, day: T, arrived_at: '09:30', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: 2 })
      const a1b = await DB.updateDaycareAttendance(a1, { left_at: '15:00' }, { editedBy: 2 })
      await DB.updateDaycareAttendance(a1b, { left_at: null }, { editedBy: 2 })
      await DB.insertDaycareAttendance({ resident_id: 2, day: T, arrived_at: null, left_at: null, absent: true, absent_reason: 'condition', note: null, recorded_by: 2 })
      await DB.recordAbsentBath({ residentId: 2, day: T, bathingPlanned: true, recordedBy: 2 })
      await DB.insertBath({ resident_id: 1, bath_on: T, result: 'full', cancel_reason: null, note: null, recorded_by: 2 })
      await DB.saveVitalEdits({ routine: false, clientKey: DC.daycareVitalKey(T, 1, 1), residentId: 1, day: T, kind: 'observation' }, { temp: { value: 36.6, base: null } }, { editedBy: 2 })
      await DB.fetchDaycareAttendance(T)
      await DB.fetchDaycareVitals(T)
      await DB.fetchRecentVitals([1, 2], '2026-10-01', T)
      const rpcs = [...new Set(s.db.rpcLog)].sort()
      const writes = [...new Set(s.db.writeLog)].sort()
      assert.deepEqual(rpcs.filter((f) => /^kv_/.test(f)), [], 'kv_ で始まる関数を呼んだ')
      assert.equal(writes.includes('kv_entries'), false, 'kv_entries へ書いた')
      assert.deepEqual(rpcs, ['apply_cell_edits', 'daycare_open_day', 'daycare_plan'])
      assert.deepEqual(writes, ['bath_records', 'daycare_attendance'])
      await reset()
    })
    it('静的: デイの画面・純ロジックに kv_put・care_schedule_v2 への書込・supabase の直呼びが無い', () => {
      for (const f of ['../src/pages/DaycarePage.tsx', '../src/pages/DaycareVitalsPage.tsx', '../src/lib/daycare.ts']) {
        const c = code(f)
        assert.doesNotMatch(c, /kv_put|kv_entries|care_schedule_v2/, f)
        assert.doesNotMatch(c, /supabase\.(from|rpc)\(|from '\.\.\/lib\/supabase'/, f)
        assert.doesNotMatch(c, /console\./, `${f} が console に出している`)
      }
      const db = code('../src/lib/db.ts')
      const part = db.slice(db.indexOf('const DAYCARE_MSG = {'), db.indexOf('const MED_MSG') > 0 ? db.indexOf('const MED_MSG') : undefined)
      assert.doesNotMatch(part, /kv_put|from\('kv_entries'\)/)
    })
  })

  // ════════════════════════════════════════════════════════════
  // 3. 静的検査（移行・凍結ファイル・配線・画面の規律）
  // ════════════════════════════════════════════════════════════
  describe('移行 0041（追加だけ・冪等）', () => {
    const s = sql('../supabase/migrations/0041_daycare_stage1.sql')
    it('do $$ を使わない・Realtime は「載っていなければ足す」（2回目で止まらない）・set table を使わない', () => {
      assert.equal(/do\s+\$\$/i.test(s), false)
      assert.equal(/alter publication supabase_realtime\s+set table/i.test(s), false)
      assert.doesNotMatch(s, /^alter publication/m, '生の add table は2回目に 42710 で止まる')
      assert.match(s, /create or replace function pg_temp\.cl_realtime_add/)
      assert.match(s, /select pg_temp\.cl_realtime_add\('daycare_attendance'\);/)
    })
    it('vitals・0011・cron・週間計画に触れない（読むだけ）', () => {
      assert.doesNotMatch(s, /alter table (public\.)?vitals|apply_cell_edits|cron\.schedule|care_auto_/)
      assert.doesNotMatch(s, /(insert into|update|delete from)\s+public\.kv_entries/i)
      assert.match(s, /from public\.kv_entries k/)
    })
    it('入浴の理由の check は既存の4つ＋欠席・新しい表は restrictive の member_only・delete のポリシーなし・旗は false', () => {
      assert.match(s, /check \(cancel_reason is null or cancel_reason in \('condition', 'refusal', 'facility', 'other', 'absent'\)\)/)
      for (const t of ['daycare_days', 'daycare_attendance']) {
        assert.match(s, new RegExp(`create policy member_only on public\\.${t} as restrictive for all to authenticated\\s+using \\(private\\.is_member\\(\\)\\) with check \\(private\\.is_member\\(\\)\\);`))
      }
      assert.equal(/for delete/i.test(s), false)
      assert.match(s, /\('input_enabled_daycare', 'false'\)\s+on conflict \(key\) do nothing;/)
      assert.match(s, /revoke all on function public\.daycare_plan\(date\) from public, anon;/)
      assert.match(s, /revoke all on function public\.daycare_open_day\(date, bigint\) from public, anon;/)
    })
  })

  describe('凍結ファイル types.ts は追加だけ・既存の選択肢は変えない', () => {
    it('BathCancelReason・InputKind は既存の行の次に1行足す形・画面の選択肢 BATH_CANCEL_REASONS と INPUT_KINDS は元のまま', async () => {
      const t = read('../src/lib/types.ts')
      assert.match(t, /export type BathCancelReason = 'condition' \| 'refusal' \| 'facility' \| 'other'\n {2}\| 'absent'/)
      assert.match(t, /export type InputKind = 'bath' \| 'med' \| 'incident'\n {2}\| 'daycare'/)
      const T2 = await import('../src/lib/types.ts')
      assert.deepEqual([...T2.BATH_CANCEL_REASONS], ['condition', 'refusal', 'facility', 'other'])
      assert.deepEqual([...T2.BATH_CANCEL_REASONS_KNOWN], ['condition', 'refusal', 'facility', 'other', 'absent'])
      assert.deepEqual([...T2.INPUT_KINDS], ['bath', 'med', 'incident'])
      assert.equal(T2.BATH_CANCEL_REASON_LABEL.absent, '欠席')
      assert.deepEqual([...T2.DAYCARE_ABSENT_REASONS], ['condition', 'hospital', 'wish', 'family', 'other'])
      assert.equal(T2.LS.dcVitalsFilter, 'cl_dcVitalsFilter')
    })
    it('欠席の理由は入浴の検証・読み取りで通る（bath.ts・db.ts）', async () => {
      const B = await import('../src/lib/bath.ts')
      assert.deepEqual(B.validateBathInput({ bath_on: '2026-10-22', result: 'cancel', cancel_reason: 'absent', note: null }, '2026-10-22'), { ok: true })
      assert.equal(B.validateBathInput({ bath_on: '2026-10-22', result: 'cancel', cancel_reason: 'xyz', note: null }, '2026-10-22').ok, false)
    })
  })

  describe('配線（ルート・記録ハブ・旗）', () => {
    it('App.tsx に /record/daycare と /record/daycare/vitals・記録ハブの許可リスト cl_recordTab は元のまま', () => {
      const a = read('../src/App.tsx')
      assert.match(a, /<Route path="\/record\/daycare" element=\{<DaycarePage actorId=\{actorId\} staff=\{staff\} \/>\} \/>/)
      assert.match(a, /<Route path="\/record\/daycare\/vitals" element=\{<DaycareVitalsPage actorId=\{actorId\} staff=\{staff\} \/>\} \/>/)
      assert.match(a, /const RECORD_TABS = \['vitals', 'meals', 'note', 'outing'\] as const/)
    })
    it('記録ハブはデイだけ input_enabled_daycare で判定する（他の項目の判定は変えない）', () => {
      const h = read('../src/pages/RecordHubPage.tsx')
      assert.match(h, /\{ key: 'daycare', to: '\/record\/daycare', label: 'デイ（せせらぎ）' \}/)
      assert.match(h, /getKindInputGate\('daycare'\)/)
      assert.match(h, /key === 'daycare' \? daycareLocked : key === 'incident' \? incidentLocked : key === 'bath' \? bathLocked : key === 'med' \? medLocked : locked/)
    })
    it('db.ts: 到着・欠席は writeGate で input_enabled_daycare・Realtime は別のチャンネル', () => {
      const d = read('../src/lib/db.ts')
      assert.match(d, /if \(table === 'daycare_attendance'\) return assertKindWritable\('daycare'\)/)
      assert.match(d, /const REALTIME_DAYCARE_TABLES = \['daycare_attendance'\] as const/)
      assert.match(d, /sb\.channel\(`cl_daycare_/)
      assert.doesNotMatch(d.slice(d.indexOf('const REALTIME_TABLES = ['), d.indexOf('] as const', d.indexOf('const REALTIME_TABLES = ['))), /daycare/, '既存のチャンネルに混ぜない')
    })
    it('反証レビューの直し（静的）: 上下逆で止めた上は送らない・持っている上は離れる前に確かめる・過去の日の到着と帰宅は止める・写しが unknown の日は写し直す', () => {
      const v = code('../src/pages/DaycareVitalsPage.tsx')
      assert.match(v, /pairBlocked\.current\.add\(slot\.key\)/)
      assert.match(v, /if \(pairBlocked\.current\.has\(key\) && 'sys_bp' in edits\) \{[\s\S]*?setDraft\(key, 'sys_bp', undefined\)/)
      assert.match(v, /registerUnsaved\(\(\) => \[\.\.\.draftsRef\.current\.values\(\)\]\.some\(\(d\) => Object\.keys\(d\)\.length > 0\)\)/)
      assert.match(v, /fill: slotDay === todayIso\(\) \? \{ measured_at: nowHm\(\), recorded_by: actor \} : \{ recorded_by: actor \}/)
      assert.match(v, /const usable = snapshot !== null && snapshot\.plan_source !== 'unknown'/)
      const t = code('../src/pages/DaycarePage.tsx')
      assert.match(t, /const timesOk = canChangeDaycareTimes\(day, today, role\)\s*const stampDisabled = disabled \|\| !timesOk/)
      assert.match(t, /onClick=\{\(\) => void onArrive\(row\)\}\s*disabled=\{stampDisabled\}/)
      assert.match(t, /onClick=\{\(\) => void onLeave\(row\)\}\s*disabled=\{stampDisabled\}/)
      assert.match(t, /data\.snapshot !== null && data\.snapshot\.plan_source !== 'unknown'/)
      assert.match(t, /arrived_at: prev\?\.arrived_at \?\? null, left_at: prev\?\.left_at \?\? null/)
      const m = sql('../supabase/migrations/0041_daycare_stage1.sql')
      assert.match(m, /create function public\.daycare_open_day\(p_day date, p_staff bigint default null\)\s+returns jsonb\s+language plpgsql\s+volatile\s+security definer/)
      assert.doesNotMatch(m, /create policy "insert_auth" on public\.daycare_days/)
      assert.doesNotMatch(m, /create policy "update_auth" on public\.daycare_days/)
    })
    it('反証レビュー2巡目の直し（静的）: あなたの値はいまの送信待ちから・送れなかった上は消さずに移らない・過去の日の unknown の写しにも帯', () => {
      const v = code('../src/pages/DaycareVitalsPage.tsx')
      // 中1: 〔あなたの値で直す〕と表示は、止まった後に打ち直した値（送信待ちの values）を使う
      assert.match(v, /const withCurrentMine = \(slot: DaycareVitalSlot, cs: CellConflict\[\]\): CellConflict\[\] =>\s*overlayPendingMine\(cs, pendingRow\('vitals', targetOf\(slot\)\)\?\.values \?\? null\)/)
      assert.match(v, /const resolveMine = async \(slot: DaycareVitalSlot, conflicts0: CellConflict\[\]\) => \{\s*const conflicts = withCurrentMine\(slot, conflicts0\)/)
      assert.match(v, /conflicts: withCurrentMine\(slot, pend\.conflicts\)/)
      assert.match(v, /conflicts: withCurrentMine\(slot, st\.conflicts\)/)
      // 軽2: 送り先はキーから組み立てる（絞り込みで外れた方も）・送れなければ移らない
      assert.match(v, /const k = parseDaycareVitalKey\(key\)/)
      assert.doesNotMatch(v, /flatSlots\.find\(\(s\) => s\.key === key\)/)
      assert.match(v, /const releaseAllHeld = async \(\): Promise<DaycareReleaseIssue\[\]> => \{/)
      assert.match(v, /const issues = await releaseAllHeld\(\)\s*if \(issues\.length > 0\) \{\s*setPageMsg\(\{ issues, go \}\)\s*return\s*\}/)
      for (const re of [/afterRelease\(\(\) => setDay\(\(d\) => addDays\(d, -1\)\)\)/, /afterRelease\(\(\) => setDay\(today\)\)/, /afterRelease\(\(\) => setReloadKey\(\(n\) => n \+ 1\)\)/]) assert.match(v, re)
      assert.doesNotMatch(v, /releaseAllHeld\(\)\s*\n\s*set(Day|ReloadKey)\(/)
      // 記録者が未選択・送れない時は false（入力は消さない）
      assert.match(v, /if \(actorId === null\) \{\s*setState\(slot\.key, \{ kind: 'error', text: MSG_NO_RECORDER \}\)\s*return Promise\.resolve\(MSG_NO_RECORDER\)/)
      const t = code('../src/pages/DaycarePage.tsx')
      assert.match(t, /data\.day < today && !data\.missing && data\.planSource !== 'unknown' && \(data\.snapshot === null \|\| data\.snapshot\.plan_source === 'unknown'\)/)
    })
    it('反証レビュー3巡目の直し（静的）: 送り先の日はキーから・読み込み中は古い行を出さない・片づけ中は止める・打ち直した値は消さない・下も送る・帯に誰か出す', () => {
      const v = code('../src/pages/DaycareVitalsPage.tsx')
      // 中1: 送り先の日・測定時刻はキーの日付から。新しい日を読む間は前の日の行を出さない
      assert.match(v, /day: parseDaycareVitalKey\(slot\.key\)\?\.day \?\? dayRef\.current,/)
      assert.match(v, /const slotDay = parseDaycareVitalKey\(slot\.key\)\?\.day \?\? dayRef\.current/)
      assert.match(v, /if \(\(loading && data === null\) \|\| \(data !== null && data\.day !== day && error === null\)\) \{/)
      assert.match(v, /vital: cur !== null && cur\.day === k\.day \?/)
      // 軽1: 片づけの前にテンキーを閉じ、欄・再測定・日付を止める。送っている最中の保存を待つ。送った値と違う入力は残す
      assert.match(v, /releasingRef\.current = true\s*setReleasing\(true\)\s*setActive\(null\)/)
      assert.match(v, /if \(!canWrite \|\| releasingRef\.current\) return/)
      assert.match(v, /if \(!canWrite \|\| data === null \|\| releasingRef\.current\) return/)
      assert.match(v, /await Promise\.allSettled\(\[\.\.\.inflightSaves\.current\]\)/)
      assert.match(v, /if \(d !== undefined && fld in d && \(d\[fld\] \?\? null\) === \(v \?\? null\)\) setDraft\(key, fld, undefined\)/)
      assert.doesNotMatch(v, /for \(const f of Object\.keys\(edits\)\) setDraft\(slot\.key, f as DaycareVitalField, undefined\)/)
      for (const re of [/disabled=\{releasing\}/g]) assert.ok((v.match(re) ?? []).length >= 3, '前の日・今日を開く・最新に更新を片づけ中は押せない')
      assert.match(v, /disabled=\{day >= today \|\| releasing\}/)
      // 軽2: 送れない時の逃げ道（確認つきで捨てて移る）
      assert.match(v, /confirmLabel="保存せずに移る"\s*danger\s*onConfirm=\{discardAndGo\}/)
      // 軽3: 片づけは入力の全部の欄（下・ほかの欄も）を送る
      assert.match(v, /const edits = releaseEditsOf\(draftsRef\.current\.get\(key\), new Set\(inflightRef\.current\.get\(key\)\?\.keys\(\) \?\? \[\]\)\)/)
      // 軽4: 帯に誰の何回目かを出す・ほかの経路で送れたら外す
      assert.match(v, /releaseIssueLabel\(i\.key, nameOf\)/)
      assert.match(v, /pruneReleaseIssues\(m\.issues, \(key\) => drafts\.has\(key\)\)/)
      assert.match(v, /if \(!editsHeldInQueue\(edits, pendingRow\('vitals', targetOf\(slot\)\)\?\.values\)\) return \{ key, kept: true, reason: err \}/)
    })
    it('日報の発熱者（静的）: 読み込みで基準値を待ち、デイの測定は発熱のあった方だけ・温度板とタイムラインは変えない', () => {
      const d = code('../src/pages/DailySheetPage.tsx')
      assert.match(d, /const \[report\] = await Promise\.all\(\[\s*loadDay\(day\),\s*Promise\.race\(\[loadVitalThresholds\(\), new Promise\(\(r\) => setTimeout\(r, THRESHOLD_WAIT_MS\)\)\]\),\s*\]\)/)
      assert.match(d, /const obs = dailyFeverObservations\(obsAll, report\?\.daycareVitalIds, editing\)/)
      // 直している最中の行（止まった控え・送信待ち）は隠さない（4巡目 F1・F9）
      assert.match(d, /if \(vitalConflictsRef\.current\[v\.id\] !== undefined \|\| pendingRow\('vitals', vitalTargetOf\(v\.id\)\) !== null\) editing\.add\(v\.id\)/)
      const db = code('../src/lib/db.ts')
      assert.match(db, /\.select\(`\$\{VITAL_COLS\},client_key`\)\s*\.gte\('measured_on', from\)\s*\.lte\('measured_on', to\)\s*\.in\('kind', \['observation', 'symptom'\]\)/)
      assert.match(db, /\.select\(`\$\{VITAL_COLS\},client_key`\)\s*\.eq\('measured_on', dayIso\)\s*\.in\('kind', \['observation', 'symptom'\]\)/)
      assert.doesNotMatch(code('../src/pages/TimelinePage.tsx'), /dailyFeverObservations|daycareVitalIds/)
      assert.doesNotMatch(code('../src/components/print/tempSheetModel.ts'), /dailyFeverObservations|daycareVitalIds/)
    })
    it('過去の日の時刻（静的）: 0042 はトリガ1つと関数1つ・do $$ を使わない・ポリシーを変えない／画面は事務所だけ時刻の小窓・現場は取り消しと時刻の入った方の欠席を止める', () => {
      const m = sql('../supabase/migrations/0042_daycare_past_times_office.sql')
      assert.doesNotMatch(m, /do \$\$/)
      assert.doesNotMatch(m, /create policy|drop policy|alter table/i)
      assert.match(m, /create or replace trigger trg_daycare_attendance_past_guard\s+before insert or update on public\.daycare_attendance/)
      assert.match(m, /if v_role is distinct from 'field' then\s+return new;/)
      assert.match(m, /errcode = '42501'/)
      const t = code('../src/pages/DaycarePage.tsx')
      assert.match(t, /if \(canEditPastDaycareTimes\(role\)\) openTime\(row, 'arrive'\)/)
      assert.match(t, /if \(canEditPastDaycareTimes\(role\)\) openTime\(row, 'leave'\)/)
      assert.match(t, /onClick=\{\(\) => askCancelLeave\(row\)\}\s*disabled=\{disabled \|\| !timesOk\}/)
      assert.match(t, /disabled=\{disabled \|\| \(rowHasTimes && !timesOk\)\}/)
      assert.match(t, /if \(timesTouched && e instanceof DbError && e\.kind === 'forbidden' && dayRef\.current < todayIso\(\)\) return MSG_PAST_TIME/)
      assert.match(t, /text: errText\(e, touchesTimes\(patch, row\.attendance\)\)/)
      assert.match(t, /text: errText\(e, touchesTimes\(patch, row\)\)/)
      assert.match(t, /type="time"/)
    })
    it('反証レビュー4巡目の直し（静的）: 帯の後に入れた値も片づけてから移る・違う日の静かな読み直しは失敗を出す・拒まれた値は帯で知らせる・0042 は付け替えと復活も見る', () => {
      const v = code('../src/pages/DaycareVitalsPage.tsx')
      // F2: 捨てるのは入力を残した測定だけ・残りはもう一度片づけてから移る
      assert.match(v, /for \(const i of msg\.issues\) \{\s*if \(!i\.kept\) continue/)
      assert.match(v, /setPageMsg\(null\)\s*afterRelease\(msg\.go\)\s*\}/)
      // F3: 表示中と違う日を読む時は静かにしない
      assert.match(v, /const quiet = quiet0 && dataRef\.current !== null && dataRef\.current\.day === target/)
      // F4: 拒まれて送信待ちに残った値は kept=false の項目として帯に出す（黙って移らない）
      assert.match(v, /clearSentDraft\(key, edits\)\s*const where = 'サーバーに受け付けられませんでした。[^']*'\s*return \{ key, kept: false,/)
      const m = sql('../supabase/migrations/0042_daycare_past_times_office.sql')
      assert.match(m, /and \(new\.resident_id = old\.resident_id or \(old\.arrived_at is null and old\.left_at is null\)\)/)
      assert.match(m, /and not \(new\.deleted_at is null and old\.deleted_at is not null\s+and \(new\.arrived_at is not null or new\.left_at is not null\)\)/)
    })
    it('画面は端末に業務データを書かない（localStorage は絞り込みの既知値だけ）', () => {
      for (const f of ['../src/pages/DaycarePage.tsx', '../src/pages/DaycareVitalsPage.tsx']) {
        const c = code(f)
        const sets = c.match(/localStorage\.setItem\([^)]*\)/g) ?? []
        for (const x of sets) assert.match(x, /LS\.dcVitalsFilter/, `${f}: ${x}`)
      }
    })
  })
}
