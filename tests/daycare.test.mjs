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
    it('重複（dup）は「予定 要確認」で落とさない・入院中は未到着に数えない・予定外の記録と足した人も一覧に入る（並びは五十音＝名簿に名前が無ければ利用者ID）', () => {
      const b = DC.buildDaycareBoard({
        planRows: [planRow({ sched_id: 'd1', resident_id: 1, dup: true }), planRow({ sched_id: 'd2', resident_id: 1, dup: true }), planRow({ sched_id: 'h', resident_id: 2, hospitalized: true })],
        source: 'kv',
        residents: roster,
        attendance: [att(10, 3, { arrived_at: '10:00' })],
        extraIds: [4],
      })
      // 2026-10-24（§9.4 の3）: 予定外・予定 要確認も末尾に回さず五十音の位置（この名簿は名前が無いので利用者IDの順）
      assert.deepEqual(b.rows.map((r) => [r.residentId, r.dup, r.extra]), [[1, true, false], [2, false, false], [3, false, true], [4, false, true]])
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
    it('並びは五十音（ふりがな、無ければ氏名・NFKC とカタカナ→ひらがなでそろえる・同じなら利用者ID）。予定の時刻・予定外・予定 要確認・居室で分けない（2026-10-24 §9.4）', () => {
      const names = [
        { id: 1, name: '架空 ウメ', kana: 'カクウ ウメ' },
        { id: 2, name: '架空 イネ', kana: 'かくう いね' },
        { id: 3, name: '試験 アオ', kana: 'ｼｹﾝ ｱｵ' },
        { id: 4, name: 'あさひ', kana: null },
        { id: 5, name: '架空 イネ', kana: 'かくう いね' },
        { id: 6, name: '', kana: '' },
      ]
      const b = DC.buildDaycareBoard({
        planRows: [
          planRow({ sched_id: 'p1', resident_id: 1, start_time: '09:00' }),
          planRow({ sched_id: 'p2', resident_id: 2, start_time: '13:00' }),
          planRow({ sched_id: 'p3', resident_id: 3, dup: true }),
          planRow({ sched_id: 'p5', resident_id: 5, start_time: '08:30' }),
        ],
        source: 'kv',
        residents: names,
        attendance: [att(10, 4, { arrived_at: '10:00' })],
        extraIds: [6, 99],
      })
      // あさひ（ふりがな無し→氏名）→ かくう いね（2・5 は同じキー→ID）→ かくう うめ（全角カタカナ）→ しけん あお（半角カナ→NFKC）→ 名前の無い方・名簿に居ない方はID順で後ろ
      assert.deepEqual(b.rows.map((r) => r.residentId), [4, 2, 5, 1, 3, 6, 99])
      assert.equal(DC.kanaSortKey({ name: 'x', kana: 'ヴァ ｶﾞ' }), 'ゔぁ が')
      assert.equal(DC.kanaSortKey({ name: '氏名', kana: '  ' }), '氏名')
      assert.equal(DC.kanaSortKey(undefined), null)
    })
    it('一括の画面に出す方（daycareBulkRows）: 予定の方のうち休み・入院中を除く全員＋予定外で来た方（2026-10-24 §9.4 の4）', () => {
      const rows = [
        { residentId: 1, state: 'planned', planned: true, hospitalized: false },
        { residentId: 2, state: 'present', planned: true, hospitalized: false },
        { residentId: 3, state: 'left', planned: true, hospitalized: false },
        { residentId: 4, state: 'absent', planned: true, hospitalized: false },
        { residentId: 5, state: 'planned', planned: true, hospitalized: true },
        { residentId: 6, state: 'present', planned: true, hospitalized: true },
        { residentId: 7, state: 'present', planned: false, hospitalized: false },
        { residentId: 8, state: 'planned', planned: false, hospitalized: false },
        { residentId: 9, state: 'absent', planned: false, hospitalized: false },
      ]
      assert.deepEqual(DC.daycareBulkRows(rows).map((r) => r.residentId), [1, 2, 3, 6, 7])
      // 受け渡し（§9.7）のキーに使う source_id の配列（並びは一覧のまま・名簿に居ない方と空の source_id は除く・重複なし）
      const residents = [{ id: 1, source_id: 'T001' }, { id: 2, source_id: ' T002 ' }, { id: 3, source_id: '' }, { id: 6, source_id: 'T006' }, { id: 4, source_id: 'T004' }, { id: 7, source_id: 'T006' }]
      assert.deepEqual(DC.daycareBulkSourceIds(rows, residents), ['T001', 'T002', 'T006'])
      assert.deepEqual(DC.daycareBulkSourceIds([], residents), [])
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
      // 代表者の決定 2026-10-23 の 3: 自動の行は「済」とだけ出す（「自動」の文字は出さない）・行の無い予定は「予定」（固定し直し）
      assert.equal(DC.daycareBathLabel(DC.daycareBathStatus(bath({ auto: true }), true)), '済')
      assert.doesNotMatch(DC.daycareBathLabel(DC.daycareBathStatus(bath({ auto: true }), true)), /自動|未確認/)
      assert.equal(DC.daycareBathLabel(DC.daycareBathStatus(null, true)), '予定')
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
    it('「入浴 未確認」の数（代表者の決定 2026-10-23 の 3）: 自動の行は数えない・12:30 より前の予定は数えない・12:30 を過ぎて行が無い方と、休みの方に残った自動の行だけ', () => {
      const today = (nowHm) => ({ pastDay: false, nowHm })
      const todo = DC.daycareBathStatus(null, true)
      const auto = DC.daycareBathStatus(bath({ auto: true }), true)
      const done = DC.daycareBathStatus(bath({ auto: false }), true)
      assert.equal(DC.bathCountsUnchecked(auto, 'present', today('13:00')), false, '自動の行（済）は数えない')
      assert.equal(DC.bathCountsUnchecked(todo, 'present', today('12:29')), false, '12:30 より前は「予定」')
      assert.equal(DC.bathCountsUnchecked(todo, 'present', today('12:30')), true, '12:30 を過ぎても行が無い')
      assert.equal(DC.bathCountsUnchecked(todo, 'left', today('15:00')), true)
      assert.equal(DC.bathCountsUnchecked(todo, 'present', { pastDay: true, nowHm: '09:00' }), true, '過去の日は行が無ければ数える')
      assert.equal(DC.bathCountsUnchecked(done, 'present', today('13:00')), false)
      assert.equal(DC.bathCountsUnchecked(auto, 'absent', today('13:00')), true, '休みの方に自動の行が残っている')
      assert.equal(DC.bathCountsUnchecked(todo, 'absent', today('13:00')), false)
      assert.equal(DC.bathCountsUnchecked(todo, 'planned', today('13:00')), false, '予定（未到着）は数えない')
      assert.equal(DC.DAYCARE_AUTO_BATH_AT, '12:30')
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

  describe('日報の控えの行キーの付け直し（反証レビュー5巡目 中1）', () => {
    it('並びが変わった控えだけ新しいキーにし、一言を移す組を返す・一覧に無い控えと変わらない控えはそのまま', () => {
      const held = { 11: { rowKey: 'f9-1', mode: 'conflict' }, 12: { rowKey: 's12', mode: 'unsaved' }, 13: { rowKey: 'f7-0', mode: 'orphan' } }
      const keys = { 11: 'f9-0', 12: 's12' }
      const r = DC.rekeyHeld(held, (id) => keys[id] ?? null)
      assert.equal(r.next[11].rowKey, 'f9-0')
      assert.equal(r.next[11].mode, 'conflict', 'ほかの中身は変えない')
      assert.equal(r.next[12], held[12])
      assert.equal(r.next[13], held[13], '一覧に無い控え（行が無い控え）はそのまま')
      assert.deepEqual(r.moves, [['f9-1', 'f9-0']])
      assert.deepEqual(r.stay.sort(), ['f7-0', 's12'], '動かない控えの行キー（一言を動かさない）')
      assert.equal(held[11].rowKey, 'f9-1', '元の控えは変えない')
      const same = DC.rekeyHeld(held, (id) => held[id].rowKey)
      assert.equal(same.next, null)
      assert.deepEqual(same.moves, [])
    })
    it('一言の移し方（反証レビュー6巡目 軽1）: 連鎖（f9-0→f9-1・f9-1→f9-2）でも両方の一言が正しい行へ移る', () => {
      const out = DC.moveRowStatuses({ 'f9-0': 'A', 'f9-1': 'B' }, [['f9-0', 'f9-1'], ['f9-1', 'f9-2']], [])
      assert.deepEqual(out, { 'f9-1': 'A', 'f9-2': 'B' })
    })
    it('一言の移し方: 動かない控えが残る行の一言は、その控えのものなので動かさない', () => {
      // 同じ行 f9-0 に控え 101 と 102。102 だけ f9-1 へ動く → f9-0 の一言（101 のもの）は残す
      const out = DC.moveRowStatuses({ 'f9-0': 'M101' }, [['f9-0', 'f9-1']], ['f9-0'])
      assert.deepEqual(out, { 'f9-0': 'M101' })
    })
    it('一言の移し方: 移し先に既に一言がある時は上書きしない・移し元に一言が無い時は何もしない', () => {
      assert.deepEqual(DC.moveRowStatuses({ 'f9-0': 'A', 'f9-1': 'Q' }, [['f9-0', 'f9-1']], []), { 'f9-1': 'Q' })
      assert.deepEqual(DC.moveRowStatuses({ s5: 'S' }, [['f9-0', 'f9-1']], []), { s5: 'S' })
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
    it('絞り込みは既知値だけ（壊れた値・知らない値は既定）。2026-10-24 §9.4 の4: 「予定の方」（既定）と「全員」の2つ・端末に残る「到着した方」は新しい既定へ', () => {
      assert.deepEqual([...DC.DC_VITALS_FILTERS], ['planned', 'all'])
      assert.equal(DC.readDcVitalsFilter('planned'), 'planned')
      assert.equal(DC.readDcVitalsFilter('all'), 'all')
      assert.equal(DC.readDcVitalsFilter('present'), 'planned', '前の版で選んだ「到着した方」は新しい既定')
      for (const bad of [null, '', 'xxx', '__proto__', 'x'.repeat(10000), 5]) assert.equal(DC.readDcVitalsFilter(bad), 'planned')
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
      // 0047 を当てる前の DB の再現: 自動の印の列を求める読み取りは 42703（列が無い）
      if (opts.noAutoCols && q.action === 'select' && q.table === 'daycare_attendance' && typeof q.cols === 'string' && /arrived_auto/.test(q.cols)) {
        return { data: null, error: { code: '42703', message: 'column daycare_attendance.arrived_auto does not exist' }, status: 400 }
      }
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

  describe('今日の画面の改善 1回目（0047: 自動の到着・帰宅の印・休みの理由「後で」）', () => {
    const att = (over = {}) => ({ id: 1, resident_id: 1, day: T, arrived_at: '09:30', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: null, rev: 1, arrived_auto: true, left_auto: false, ...over })
    it('自動だけの行の見分け・人の時刻の有無（〔休み〕の確かめと、押した瞬間の自動の到着の扱い）', () => {
      assert.equal(DC.isAutoOnlyAttendance(att()), true)
      assert.equal(DC.isAutoOnlyAttendance(att({ left_at: '15:30', left_auto: true })), true)
      assert.equal(DC.isAutoOnlyAttendance(att({ left_at: '15:10', left_auto: false })), false, '人が押した帰宅')
      assert.equal(DC.isAutoOnlyAttendance(att({ arrived_auto: false })), false, '人が押した到着')
      assert.equal(DC.isAutoOnlyAttendance(att({ recorded_by: 2 })), false, '記入者がいる')
      assert.equal(DC.isAutoOnlyAttendance(att({ absent: true, arrived_at: null, absent_reason: 'later', arrived_auto: false })), false)
      assert.equal(DC.isAutoOnlyAttendance(null), false)
      assert.equal(DC.hasManualTimes(att()), false, '自動の到着だけなら確かめない')
      assert.equal(DC.hasManualTimes(att({ arrived_auto: false })), true)
      assert.equal(DC.hasManualTimes(att({ left_at: '15:10', left_auto: false })), true)
      assert.equal(DC.hasManualTimes(att({ arrived_at: null, arrived_auto: false })), false)
      assert.equal(DC.hasManualTimes(null), false)
    })
    it('「後で」の休みは検証を通る（選択肢の5つは変えない）', async () => {
      assert.deepEqual(DC.validateAttendance({ absent: true, absent_reason: 'later', arrived_at: null, left_at: null }), { ok: true })
      assert.equal(DC.validateAttendance({ absent: true, absent_reason: 'xyz', arrived_at: null, left_at: null }).ok, false)
      const T2 = await import('../src/lib/types.ts')
      assert.deepEqual([...T2.DAYCARE_ABSENT_REASONS], ['condition', 'hospital', 'wish', 'family', 'other'], '選択肢は5つのまま')
      assert.deepEqual([...T2.DAYCARE_ABSENT_REASON_VALUES], ['condition', 'hospital', 'wish', 'family', 'other', 'later'])
      assert.equal(T2.DAYCARE_ABSENT_REASON_LABEL.later, '理由は後で')
    })
    it('読み取り: 自動の印と「後で」を読む・時刻の無い側の印は持たない・列が無い DB では列を外して読み直し、印は無いとする', async () => {
      const s = fakeServer()
      DB.__testHooks.setClient(s.client)
      s.db.daycare_attendance.push(
        { id: 1, resident_id: 1, day: T, arrived_at: '09:30:00', left_at: '15:30:00', absent: false, absent_reason: null, note: null, recorded_by: null, rev: 1, arrived_auto: true, left_auto: true, deleted_at: null },
        { id: 2, resident_id: 2, day: T, arrived_at: null, left_at: null, absent: true, absent_reason: 'later', note: null, recorded_by: 2, rev: 1, arrived_auto: true, left_auto: false, deleted_at: null },
      )
      const rows = await DB.fetchDaycareAttendance(T)
      assert.deepEqual(rows.map((r) => [r.resident_id, r.arrived_auto, r.left_auto, r.absent_reason]), [[1, true, true, null], [2, false, false, 'later']])
      assert.equal(DB.daycareAutoColumnsSeen(), true)
      const old = fakeServer({ noAutoCols: true })
      DB.__testHooks.setClient(old.client)
      old.db.daycare_attendance.push({ id: 3, resident_id: 1, day: T, arrived_at: '09:30:00', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: 2, rev: 1, deleted_at: null })
      const r2 = await DB.fetchDaycareAttendance(T)
      assert.deepEqual(r2.map((r) => [r.resident_id, r.arrived_at, r.arrived_auto]), [[1, '09:30', false]])
      assert.equal(DB.daycareAutoColumnsSeen(), false, '0047 を当てる前の DB＝〔休み〕は理由を選ぶ小窓にする')
      await reset()
    })
    it('修正: 自動の印は〔元に戻す〕で時刻と一緒に戻す時だけ送る・外す方は送らない（トリガが外す）・時刻の無い側には付けない', async () => {
      const s = fakeServer()
      DB.__testHooks.setClient(s.client)
      s.db.daycare_attendance.push({ id: 5, resident_id: 1, day: T, arrived_at: null, left_at: null, absent: true, absent_reason: 'later', note: null, recorded_by: 2, rev: 2, arrived_auto: false, left_auto: false, deleted_at: null, edited_by: null })
      const sent = []
      const orig = s.client.from
      s.client.from = (t) => {
        const b = orig(t)
        const up = b.update
        b.update = (p) => {
          sent.push({ ...p })
          return up(p)
        }
        return b
      }
      const cur = (await DB.fetchDaycareAttendance(T))[0]
      const back = await DB.updateDaycareAttendance(cur, { absent: false, absent_reason: null, arrived_at: '09:30', left_at: null, arrived_auto: true, left_auto: true }, { editedBy: 2 })
      assert.equal(back.arrived_at, '09:30')
      assert.equal(sent[0].arrived_auto, true)
      assert.equal('left_auto' in sent[0], false, '帰宅の時刻が無いので帰宅の印は送らない')
      const fix = await DB.updateDaycareAttendance({ ...back, arrived_auto: true }, { arrived_at: '09:45', arrived_auto: false }, { editedBy: 2 })
      assert.equal(fix.arrived_at, '09:45')
      assert.equal('arrived_auto' in sent[1], false, 'false は送らない（DB のトリガが外す）')
      await reset()
    })
    it('反証 重1: 圏外で押した〔休み〕の追加が、後から載った自動の到着とぶつかったら、人の記録で上書きする（人の行には負けて止まる）', async () => {
      let off = true
      const s = fakeServer({ offline: () => off })
      DB.__testHooks.setClient(s.client)
      const q = await DB.insertDaycareAttendance({ resident_id: 1, day: T, arrived_at: null, left_at: null, absent: true, absent_reason: 'later', note: null, recorded_by: 2 })
      assert.equal(q, 'queued')
      // 9:30 の定時の処理の自動の到着（記入者なし・印つき）
      s.db.daycare_attendance.push({ id: 70, resident_id: 1, day: T, arrived_at: '09:30:00', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: null, rev: 1, arrived_auto: true, left_auto: false, deleted_at: null, client_key: 'auto:dcatt:x:1' })
      off = false
      await DB.flushQueue(true)
      assert.equal(s.db.daycare_attendance.length, 1, '重複0')
      const a = s.db.daycare_attendance[0]
      assert.deepEqual([a.absent, a.absent_reason, a.arrived_at, a.left_at, a.arrived_auto, a.left_auto, a.recorded_by], [true, 'later', null, null, false, false, 2])
      assert.equal(DB.queuePending(), 0)
      await reset()
      // 相手が人の記録なら止まる（黙って上書きしない）
      let off2 = true
      const s2 = fakeServer({ offline: () => off2 })
      DB.__testHooks.setClient(s2.client)
      await DB.insertDaycareAttendance({ resident_id: 1, day: T, arrived_at: null, left_at: null, absent: true, absent_reason: 'later', note: null, recorded_by: 2 })
      s2.db.daycare_attendance.push({ id: 71, resident_id: 1, day: T, arrived_at: '09:35:00', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: 3, rev: 1, arrived_auto: false, left_auto: false, deleted_at: null, client_key: 'c-x' })
      off2 = false
      await DB.flushQueue(true)
      assert.equal(s2.db.daycare_attendance[0].arrived_at, '09:35:00')
      assert.equal(DB.listStoppedOps().filter((o) => o.table === 'daycare_attendance').length, 1)
      await reset()
    })
    it('反証 中2: 圏外で押した〔帰宅〕の書き換えが、自動の帰宅で版が1つ進んだ行に届かない時は、いまの版に乗せ替えて送る（人が変えていれば止まる）', async () => {
      let off = false
      const s = fakeServer({ offline: () => off })
      DB.__testHooks.setClient(s.client)
      s.db.daycare_attendance.push({ id: 80, resident_id: 1, day: T, arrived_at: '09:30:00', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: 2, rev: 3, arrived_auto: false, left_auto: false, deleted_at: null, client_key: 'c-80' })
      const cur = (await DB.fetchDaycareAttendance(T))[0]
      off = true
      assert.equal(await DB.updateDaycareAttendance(cur, { left_at: '12:50' }, { editedBy: 2 }), 'queued')
      // 13:30 の定時の処理の自動の帰宅（版が1つ進む・0049 で edited_by を空にする）
      Object.assign(s.db.daycare_attendance[0], { left_at: '13:30:00', left_auto: true, rev: 4, edited_by: null })
      off = false
      await DB.flushQueue(true)
      assert.deepEqual([s.db.daycare_attendance[0].left_at, s.db.daycare_attendance[0].rev], ['12:50', 5])
      assert.equal(DB.queuePending(), 0)
      await reset()
      // 人が先に帰宅を入れていた（印なし）→ 止まる
      let off2 = false
      const s2 = fakeServer({ offline: () => off2 })
      DB.__testHooks.setClient(s2.client)
      s2.db.daycare_attendance.push({ id: 81, resident_id: 1, day: T, arrived_at: '09:30:00', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: 2, rev: 3, arrived_auto: false, left_auto: false, deleted_at: null, client_key: 'c-81' })
      const cur2 = (await DB.fetchDaycareAttendance(T))[0]
      off2 = true
      await DB.updateDaycareAttendance(cur2, { left_at: '12:50' }, { editedBy: 2 })
      Object.assign(s2.db.daycare_attendance[0], { left_at: '13:05:00', left_auto: false, rev: 4 })
      off2 = false
      await DB.flushQueue(true)
      assert.equal(s2.db.daycare_attendance[0].left_at, '13:05:00')
      assert.equal(DB.listStoppedOps().filter((o) => o.table === 'daycare_attendance').length, 1)
      await reset()
      // 確認の反証 軽1: 帰宅は自動の印のままでも、進んだ1歩が別の端末の人の直し（edited_by あり）なら乗せ替えずに止まる
      let off3 = false
      const s3 = fakeServer({ offline: () => off3 })
      DB.__testHooks.setClient(s3.client)
      s3.db.daycare_attendance.push({ id: 82, resident_id: 1, day: T, arrived_at: '09:30:00', left_at: '13:30:00', absent: false, absent_reason: null, note: null, recorded_by: null, rev: 5, arrived_auto: true, left_auto: true, deleted_at: null, edited_by: null, client_key: 'auto:dcatt:x:1' })
      const cur3 = (await DB.fetchDaycareAttendance(T))[0]
      off3 = true
      await DB.updateDaycareAttendance(cur3, { absent: true, absent_reason: 'later' }, { editedBy: 2 })
      // 別の端末（電波あり）が到着の時刻を直した: 帰宅の印は付いたまま・edited_by あり
      Object.assign(s3.db.daycare_attendance[0], { arrived_at: '09:50:00', arrived_auto: false, rev: 6, edited_by: 3 })
      off3 = false
      await DB.flushQueue(true)
      assert.deepEqual([s3.db.daycare_attendance[0].absent, s3.db.daycare_attendance[0].arrived_at], [false, '09:50:00'], '別の端末の人の直しを黙って上書きしない')
      assert.equal(DB.listStoppedOps().filter((o) => o.table === 'daycare_attendance').length, 1)
      await reset()
    })
    it('確認の反証 軽2: 送信待ちの手の〔到着〕が、自動の到着と自動の帰宅まで入った行に届いたら、自動の帰宅は残す（帰宅が到着より前なら外す）', async () => {
      let off = true
      const s = fakeServer({ offline: () => off })
      DB.__testHooks.setClient(s.client)
      await DB.insertDaycareAttendance({ resident_id: 1, day: T, arrived_at: '10:15', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: 2 })
      s.db.daycare_attendance.push({ id: 90, resident_id: 1, day: T, arrived_at: '09:30:00', left_at: '15:30:00', absent: false, absent_reason: null, note: null, recorded_by: null, rev: 2, arrived_auto: true, left_auto: true, deleted_at: null, client_key: 'auto:dcatt:x:1' })
      off = false
      await DB.flushQueue(true)
      const a = s.db.daycare_attendance[0]
      assert.deepEqual([a.arrived_at, a.arrived_auto, a.left_at, a.left_auto, a.recorded_by], ['10:15', false, '15:30:00', true, 2])
      await reset()
      // 手の到着が自動の帰宅より後（15:40 と 15:30）→ 帰宅を外す（帰宅は到着の後の check に当てない）
      let off2 = true
      const s2 = fakeServer({ offline: () => off2 })
      DB.__testHooks.setClient(s2.client)
      await DB.insertDaycareAttendance({ resident_id: 1, day: T, arrived_at: '15:40', left_at: null, absent: false, absent_reason: null, note: null, recorded_by: 2 })
      s2.db.daycare_attendance.push({ id: 91, resident_id: 1, day: T, arrived_at: '09:30:00', left_at: '15:30:00', absent: false, absent_reason: null, note: null, recorded_by: null, rev: 2, arrived_auto: true, left_auto: true, deleted_at: null, client_key: 'auto:dcatt:x:1' })
      off2 = false
      await DB.flushQueue(true)
      assert.deepEqual([s2.db.daycare_attendance[0].arrived_at, s2.db.daycare_attendance[0].left_at], ['15:40', null])
      await reset()
    })
    it('確認の反証 軽3: 欠席の日の入浴は、実際にした事を返す（自動の行を直した＝元の区分・行を新しく作った）', async () => {
      const s = fakeServer()
      DB.__testHooks.setClient(s.client)
      s.db.bath_records.push({ id: 95, resident_id: 1, bath_on: T, result: 'full', cancel_reason: null, note: null, recorded_by: null, rev: 1, auto: true, deleted_at: null })
      const fromAuto = await DB.recordAbsentBath({ residentId: 1, day: T, bathingPlanned: true, recordedBy: 2 })
      assert.deepEqual([fromAuto.status, fromAuto.autoResult, fromAuto.inserted], ['done', 'full', undefined])
      const created = await DB.recordAbsentBath({ residentId: 2, day: T, bathingPlanned: true, recordedBy: 2 })
      assert.deepEqual([created.status, created.autoResult, created.inserted], ['done', undefined, true])
      await reset()
    })
    it('反証 中4: 一覧の行は 12:30 の自動の入浴の相手かを持つ（〔元に戻す〕で入浴を戻してよいかの判定）', () => {
      const plan = (rid, bath) => ({ sched_id: `s${rid}`, event_id: 'e', resident_id: rid, match: 'mid', dup: false, external: false, hospitalized: false, start_time: '9:30', end_time: '15:30', bathing: true, bath_resident_id: bath, plan_rev: 1, updated_at: null })
      const b = DC.buildDaycareBoard({ planRows: [plan(1, 1), plan(2, null)], source: 'kv', residents: [{ id: 1, name: 'a', active: true }, { id: 2, name: 'b', active: true }], attendance: [] })
      assert.deepEqual(b.rows.map((r) => [r.residentId, r.autoBath, r.bathingPlanned]), [[1, true, true], [2, false, true]])
    })
    it('〔元に戻す〕の取り消し: 時刻の無い休みの行だけ消せる（時刻のある行は消さない）', async () => {
      const s = fakeServer()
      DB.__testHooks.setClient(s.client)
      const rest = await DB.insertDaycareAttendance({ resident_id: 1, day: T, arrived_at: null, left_at: null, absent: true, absent_reason: 'later', note: null, recorded_by: 2 })
      assert.equal(rest.absent_reason, 'later')
      assert.equal(await DB.softDeleteDaycareAttendance(rest, { editedBy: 2 }), true)
      assert.notEqual(s.db.daycare_attendance.find((r) => r.id === rest.id).deleted_at, null)
      await assert.rejects(() => DB.softDeleteDaycareAttendance(att({ id: 9 }), { editedBy: 2 }), /時刻のある記録は取り消せません/)
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

  describe('今日の画面の改善 1回目（静的・代表者の決定 2026-10-23 と親の回答 A1〜A5・B1〜B9）', () => {
    // 2026-10-24（代表者の決定 §9.4）: 一覧は1人1行の表からカードに、操作と小窓は今日の画面と1人の画面で同じ部品
    // （src/components/DaycareAttendanceOps.tsx）に移した。下の検査は場所を移しただけ（固定し直し・意図は同じ）
    const t = code('../src/pages/DaycarePage.tsx')
    const ops = code('../src/components/DaycareAttendanceOps.tsx')
    const person = code('../src/pages/DaycarePersonPage.tsx')
    const list = t.slice(t.indexOf('<ul className="dc-cards"'), t.indexOf('setPickerOpen(true)'))
    const att = person.slice(person.indexOf('<section aria-labelledby="h-att"'), person.indexOf('<section aria-labelledby="h-vital"'))
    it('画面には「自動」の文字を出さない（到着・帰宅・入浴とも時刻・状態だけ＝代表者の指示）。カードも1人の画面の到着・帰宅も', () => {
      assert.ok(list.length > 1000)
      assert.ok(att.length > 1000)
      for (const x of [list, att]) {
        assert.doesNotMatch(x.replace(/電波が戻ると自動で送信します/g, ''), /自動/)
        assert.doesNotMatch(x, /arrived_auto|left_auto/, '一覧は印を見て見た目を変えない')
      }
    })
    it('カード（§9.4 の1〜3）: 五十音の通し（見出しなし）・氏名とふりがな・予定・到着と帰宅・入浴と昼食とバイタルは文字だけ・ボタンは〔休み〕（休みの方は〔取消〕）だけ・リンクの外', () => {
      assert.match(list, /<Link to=\{personPath\(row\.residentId, day, today\)\} className="dc-card-link /)
      // 〔休み〕〔取消〕はリンクの外（リンクの閉じタグの後）・押せる範囲 44px
      const link = list.slice(list.indexOf('<Link to={personPath'), list.indexOf('</Link>'))
      assert.doesNotMatch(link, /<button/)
      assert.match(list, /<\/Link>[\s\S]*?onClick=\{\(\) => ops\.askCancelAbsent\(row\)\}[\s\S]*?className=\{`relative z-\[1\] shrink-0 \$\{DANGER_CELL_BTN\}`\}/)
      assert.match(list, /onClick=\{\(\) => ops\.onRest\(row\)\}\s*disabled=\{disabled \|\| \(rowHasTimes && !timesOk\)\}[\s\S]*?className=\{`relative z-\[1\] shrink-0 \$\{REST_BTN\}`\}/)
      assert.match(t, /const REST_BTN =\s*'inline-flex min-h-tap min-w-\[5rem\]/)
      assert.match(t, /const DANGER_CELL_BTN =\s*'inline-flex min-h-tap min-w-tap/)
      // カードに残すボタンは2つだけ（到着・帰宅・時刻・理由・入浴はカードに出さない）
      assert.equal((list.slice(0, list.indexOf('</ul>')).match(/<button/g) ?? []).length, 2)
      assert.doesNotMatch(list, /onArrive|onLeave|openTime|askAbsent|openBath|onBathAsPlanned/)
      // 入浴・昼食・バイタルは押せない文字だけ（▲ と枠で注意を示す＝色だけに頼らない）
      assert.match(list, /入浴 \{bathText\}/)
      assert.match(list, /昼食 \{attended \|\| lunch !== null \? lunchShortLabel\(lunch\) : '—'\}/)
      assert.match(list, /バイタル \{vAbn \? '▲ 要確認' : vDone \? '✓ 済' : attended \? '未' : '—'\}/)
      // 休みの方はその位置のまま薄く（地の色と文字の色。透明度は使わない）・「休み（理由）」
      assert.match(list, /absent \? 'border-border bg-surface2' : 'border-border-strong bg-surface'/)
      assert.doesNotMatch(list, /opacity-/)
      assert.match(list, /<span aria-hidden="true">✕ <\/span>\s*\{stateLabel\(row\)\.text\}/)
      // 角は 6px（rounded-full を使わない）・五十音の見出しは付けない
      assert.doesNotMatch(t, /rounded-full/)
      assert.doesNotMatch(list, /あ行|か行/)
      const css = read('../src/index.css')
      // 最小幅はふつうの文字で 205px（入居者マスタの .rlist と同じ）。rem なので文字を大きくすると列が減る
      assert.match(css, /\.dc-cards \{\s*display: grid;\s*grid-template-columns: repeat\(auto-fill, minmax\(min\(12\.8rem, 100%\), 1fr\)\);/)
      // 氏名・ふりがな・予定は切らずに折り返す（ふりがなは〔休み〕の横に置かない）
      assert.doesNotMatch(list.slice(0, list.indexOf('</ul>')), /\btruncate\b/)
      assert.match(css, /\.dc-card-link::after \{\s*content: '';\s*position: absolute;\s*inset: 0;/)
      assert.doesNotMatch(css, /\.dc-(row|row-head|cell-label|span2)\s*[,{]/, '1人1行の表は外した')
    })
    it('時刻の直しは1人の画面（今日は現場も・過去の日は事務所＝A4）。〔帰宅を取り消す〕は小窓の中', () => {
      assert.match(person, /const timesOk = canChangeDaycareTimes\(day, today, role\)/)
      assert.match(att, /\{hasTimes\(row\) && timesOk \? \(\s*<button\s+type="button"\s+onClick=\{\(\) => \{\s*if \(ops\.precheck\(row\)\) ops\.openTime\(row, 'fix'\)/)
      assert.match(ops, /\{timeFor\.mode === 'fix' && timeFor\.row\.attendance\?\.left_at \? \(/)
    })
    it('〔休み〕の1タップ: 0047 が無い DB では理由の小窓・人の時刻がある方だけ確かめ・押した瞬間の自動の到着は読み直して休みに直す', () => {
      const rest = ops.slice(ops.indexOf('const onRest = '), ops.indexOf('const restNow = '))
      assert.match(rest, /if \(daycareAutoColumnsSeen\(\) !== true\) \{\s*setAbsentFor\(row\)\s*return\s*\}/)
      assert.match(rest, /if \(a !== null && hasManualTimes\(a\)\) \{\s*setConfirm\(/)
      const now = ops.slice(ops.indexOf('const restNow = '), ops.indexOf('const undoRest = '))
      assert.match(now, /absent_reason: 'later' as const, arrived_at: null, left_at: null/)
      assert.match(now, /if \(r === 'conflict' && before === null\) \{[\s\S]*?isAutoOnlyAttendance\(now\)/)
      assert.match(now, /await recordAbsentBath\(\{ residentId: id, day, bathingPlanned: row\.bathingPlanned, recordedBy: actorId \}\)/)
    })
    it('直後の〔元に戻す〕: 時刻と印を戻す・押す前に行が無ければ行を取り消す・入浴は自動と同じ区分に戻す（印は付けない＝端末は自動の記録を作らない）', () => {
      const undo = ops.slice(ops.indexOf('const undoRest = '), ops.indexOf('const onReasonPick = '))
      assert.match(undo, /before === null\s*\? await softDeleteDaycareAttendance\(saved, \{ editedBy: actorId \}\)/)
      assert.match(undo, /arrived_auto: before\.arrived_auto === true,\s*left_auto: before\.left_auto === true,/)
      assert.match(undo, /resultForBathed\(day, closedDates\)/)
      assert.match(undo, /await updateBath\(bath\.record, \{ result: back, cancel_reason: null \}, \{ editedBy: actorId \}\)/)
      assert.doesNotMatch(undo, /auto: true/)
      // 反証 中4: 休みで作った行を自動と同じ区分にするのは、12:30 の自動の相手で今日の 12:30 より前の時だけ。それ以外は行を取り消す
      // 確認の反証 軽3: 押した時（restNow）に 12:30 の自動の相手で 12:30 より前だったかを控え、戻し方は recordAbsentBath の結果で決める
      const now = ops.slice(ops.indexOf('const restNow = '), ops.indexOf('const undoRest = '))
      assert.match(now, /const beforeAutoBath = row\.autoBath === true && day === todayIso\(\) && nowHm\(\) < DAYCARE_AUTO_BATH_AT/)
      assert.match(undo, /bath\.inserted === true && !beforeAutoBath\s*\? await softDeleteBath\(bath\.record\.id, bath\.record\.rev, \{ editedBy: actorId \}\)/)
      assert.match(undo, /bath\.autoResult === 'full' \|\| bath\.autoResult === 'visit' \? bath\.autoResult/)
      assert.doesNotMatch(undo, /prevBath/)
    })
    it('予定が2件の方は「予定 要確認」と出す（代表者の回答 A2・定時の処理も入れない）', () => {
      assert.match(list, /: row\.plans\.length > 1\s*\?[^']*'予定 要確認（週間計画にこの方の予定が同じ日に2件あります）'/)
    })
    it('休みの文言（ボタン・状態・件数の帯）。入浴の理由の「欠席」は変えない（B6）', () => {
      assert.match(t, /text: `休み（\$\{reason\}）`/)
      assert.match(t, /\{ label: '休み', value: c\.absent \}/)
      assert.match(t, /label: '今日（到着・休み）'/)
      assert.match(person, /return `休み（\$\{a\?\.absent_reason/)
      const T2 = read('../src/lib/types.ts')
      assert.match(T2, /absent: '欠席'/, '入浴の理由の表示は変えない')
    })
  })

  describe('今日のカードと1人の画面の操作（静的・2026-10-24 代表者の決定 §9.4）', () => {
    const t = code('../src/pages/DaycarePage.tsx')
    const ops = code('../src/components/DaycareAttendanceOps.tsx')
    const person = code('../src/pages/DaycarePersonPage.tsx')
    const att = person.slice(person.indexOf('<section aria-labelledby="h-att"'), person.indexOf('<section aria-labelledby="h-vital"'))
    const bathSec = person.slice(person.indexOf('<section aria-labelledby="h-bath"'), person.indexOf('<section aria-labelledby="h-lunch"'))
    it('操作の本体は1か所（DaycareAttendanceOps）。今日の画面と1人の画面が同じ部品を使い、書き写しを持たない', () => {
      assert.match(t, /const ops = useDaycareAttendanceOps\(\{\s*place: 'board',/)
      assert.match(person, /const ops = useDaycareAttendanceOps\(\{\s*place: 'person',/)
      for (const x of [t, person]) {
        assert.doesNotMatch(x, /const (onRest|restNow|undoRest|onArrive|onLeave|writeBath|onAbsentPick|saveTime) = /)
        assert.doesNotMatch(x, /recordAbsentBath|insertDaycareAttendance|updateDaycareAttendance|softDeleteDaycareAttendance|insertBath\(|updateBath\(/)
      }
      assert.match(t, /\{ops\.dialogs\}/)
      assert.match(person, /\{ops\.dialogs\}/)
    })
    it('1人の画面: 到着（今日は1タップ・過去の日は事務所の小窓）・帰宅・時刻の直し・〔休み〕・理由・休みの取り消し・入浴の操作がある', () => {
      assert.match(att, /onClick=\{\(\) => void ops\.onArrive\(row\)\}\s*disabled=\{opsDisabled \|\| !timesOk\}/)
      assert.match(att, /onClick=\{\(\) => void ops\.onLeave\(row\)\} disabled=\{opsDisabled \|\| !timesOk\}/)
      assert.match(att, /onClick=\{\(\) => ops\.onRest\(row\)\} disabled=\{opsDisabled \|\| \(hasTimes\(row\) && !timesOk\)\}/)
      assert.match(att, /onClick=\{\(\) => ops\.askAbsent\(row\)\} disabled=\{opsDisabled\}[^>]*>\s*理由を選ぶ/)
      assert.match(att, /onClick=\{\(\) => ops\.askCancelAbsent\(row\)\} disabled=\{opsDisabled\}[^>]*>\s*休みを取り消す/)
      assert.match(bathSec, /onClick=\{\(\) => ops\.onBathAsPlanned\(row\)\} disabled=\{opsDisabled\}/)
      assert.match(bathSec, /onClick=\{\(\) => ops\.openBath\(row\)\} disabled=\{opsDisabled\}/)
      assert.match(bathSec, /'入浴を「欠席」に直す' : '区分・中止を選ぶ'/)
      assert.doesNotMatch(bathSec, /今日の一覧で入浴を記録する/)
      // 過去の日の到着・帰宅は事務所の時刻の小窓（0042 と同じ規則）
      assert.match(ops, /if \(canEditPastDaycareTimes\(role\)\) openTime\(row, 'arrive'\)/)
      // 押せない間（未送信・送信中・旗が閉じている）は止める
      assert.match(person, /const opsDisabled = !canWrite \|\| ops\.busy\.has\(residentId\) \|\| attPending/)
    })
    it('1人の画面は書き込みの下準備を自分で取る（入浴の旗・役割・休業日・開所の写し＝M-085）', () => {
      assert.match(person, /useEffect\(\(\) => \{\n\s*void getKindInputGate\('bath'\)\.catch\(\(\) => undefined\)\n\s*\}, \[reloadKey\]\)/)
      assert.match(person, /const ask = \(\) => \{\s*void fetchMyRole\(\)\.then\(\(r\) => \{\s*if \(alive\) setRole\(r\)/)
      assert.match(person, /const off = subscribeMyRole\(ask\)/)
      assert.match(person, /getAppSetting\('daycare_closed_dates'\)\.catch\(\(\) => null\)/)
      assert.match(person, /const snap = await openDaycareDay\(day, actorId\)/)
      assert.match(person, /snapshot,\n\s*missing: missing \|\| plan\?\.missing === true,/)
    })
    it('1人の画面: 予定も記録も無い在籍中の方は「予定外」として足し、ボタンは〔予定外で到着〕と分ける（親の回答 A3）。入院の方には出さない', () => {
      assert.match(person, /const extraSelf = resident !== null && resident\.active/)
      assert.match(person, /extraIds: extraSelf \? \[residentId\] : \[\]/)
      assert.match(person, /const extraNoRecord = row !== undefined && row\.extra && !row\.planned && att === null/)
      assert.match(att, /\{extraNoRecord \? '予定外で到着' : '到着'\}/)
      // 入院中: 週間計画の入院中（hospitalizedPlanned）と、その日の食事の記録の「入院」には出さない
      assert.match(person, /const hospitalMeal = data\.meals\.some\(\(m\) => m\.meal\.resident_id === residentId && m\.meal\.status === 'hospital'\)/)
      assert.match(att, /\) : hospitalizedPlanned \|\| \(extraNoRecord && hospitalMeal\) \? null : \(/)
    })
    it('案内の「どこで」は画面ごと（カード＝1人の画面へ・1人の画面＝この画面のボタン）。行の欄を指す古い案内は残さない', () => {
      assert.match(ops, /arriveHint: 'カードを押して、1人の画面の〔到着〕を押してください'/)
      assert.match(ops, /reasonHint: '理由は、カードを押した1人の画面で選べます'/)
      for (const x of [ops, t, person]) assert.doesNotMatch(x, /行の入浴の欄|行の〔理由〕|行の〔休み〕|この行の入浴|行の時刻/)
      // 反証 軽1: 〔予定にない方を追加〕の後は「カードを押して〔予定外で到着〕」（追加しただけでは到着にならない）。過去の日の帯も操作の新しい場所を指す
      const pages = ['DaycarePage', 'DaycareVitalsPage', 'DaycareMealsPage', 'DaycareActivityBulkPage', 'DaycareTrainingPage'].map((f) => code(`../src/pages/${f}.tsx`))
      for (const x of pages) {
        assert.doesNotMatch(x, /〔予定にない方を追加〕から(到着を)?記録/)
        if (x.includes('〔予定にない方を追加〕')) assert.match(x, /〔予定外で到着〕/)
      }
      assert.match(t, /'過去の日を表示しています。到着・帰宅は、カードを押した1人の画面で時刻を入れて記録・修正します（事務所のログイン）。'/)
      assert.match(t, /休みはカードの〔休み〕、入浴はカードを押した1人の画面で記録できます/)
    })
    it('反証の直し: 食事一括で到着の前の方を「在席」と出さない（中1）・1人の画面は予定も記録も無い方に〔休み〕を出さない（軽2）・画面に戻った時に今日を取り直す（軽4）・ボタンは 44px（軽5）', () => {
      const meals = code('../src/pages/DaycareMealsPage.tsx')
      const ct = meals.slice(meals.indexOf('function cameText('), meals.indexOf('export interface DaycareMealsPageProps'))
      assert.match(ct, /if \(row\.state === 'present'\) return `在席/)
      assert.match(ct, /return `未到着（予定 \$\{fmtPlanTimes\(row\.plans\)\}）`/)
      assert.match(ct, /return '未到着'/)
      assert.match(att, /\{extraNoRecord \? null : \(\s*<button type="button" onClick=\{\(\) => ops\.onRest\(row\)\}/)
      assert.match(person, /const vis = \(\) => \{\s*if \(document\.visibilityState === 'visible'\) tick\(\)\s*\}\s*document\.addEventListener\('visibilitychange', vis\)/)
      for (const k of ['opBtn', 'opPrimary', 'opDanger', 'opRest']) assert.match(person, new RegExp(`const ${k} =\\s*'min-h-tap min-w-`))
    })
    it('0047 が無い DB の〔休み〕（理由の小窓）・8秒の〔元に戻す〕・入浴の「中止（欠席）」連動はカードの〔休み〕から今までどおり', () => {
      assert.match(ops, /`\$\{nameOf\(id\)\}さんを休みにしました（\$\{place\.reasonHint\}）`,\s*saved === null \? undefined : \(\) => void undoRest\(row, saved, before, beforeAutoBath, bath\),/)
      assert.match(ops, /<ModalShell open=\{absentFor !== null\} label="休みの理由"/)
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
      // 2026-10-24 表記を「デイ（せせらぎ）」から「デイ せせらぎ」に改めた（代表者の指示）
      assert.match(h, /\{ key: 'daycare', to: '\/record\/daycare', label: 'デイ せせらぎ' \}/)
      assert.match(h, /getKindInputGate\('daycare'\)/)
      // 2026-10-24 入浴（デイ）の項目を外したので、入浴の判定（bathLocked）が抜けた
      assert.match(h, /key === 'daycare' \? daycareLocked : key === 'incident' \? incidentLocked : key === 'med' \? medLocked : locked/)
    })
    it('デイの今日の画面は入浴の旗も自分で取る（2026-10-24 記録ハブが入浴の旗を取らなくなった後も、圏外の入浴の記録を送信待ちに積む・確認の反証 中1）', () => {
      const p = read('../src/pages/DaycarePage.tsx')
      assert.match(p, /useEffect\(\(\) => \{\n\s*void getKindInputGate\('bath'\)\.catch\(\(\) => undefined\)\n\s*\}, \[reloadKey\]\)/)
      // 入浴の書き込みは input_enabled_bath の控えを見る（控えが「開いている」なら圏外でも送信待ちに積む）
      const d = read('../src/lib/db.ts')
      assert.match(d, /if \(table === 'bath_records'\) return assertKindWritable\('bath'\)/)
    })
    it('記録ハブの並び（2026-10-24 入浴（デイ）を外した）と、画面に出る「デイ せせらぎ」の表記', () => {
      const h = read('../src/pages/RecordHubPage.tsx')
      const items = h.slice(h.indexOf('const ITEMS'), h.indexOf('const MED_GATE_UNKNOWN'))
      assert.deepEqual(
        [...items.matchAll(/key: '([a-zA-Z]+)'/g)].map((m) => m[1]),
        ['vitals', 'meals', 'note', 'outing', 'med', 'incident', 'daycare'],
      )
      assert.match(h, /デイ せせらぎ: \{daycareGate\.observed/)
      const app = read('../src/App.tsx')
      assert.match(app, /if \(pathname === '\/record\/daycare'\) return 'デイ せせらぎ'/)
      // 画面に出る文字（コメントを除く）に古い表記が残っていない
      for (const f of ['../src/App.tsx', '../src/pages/RecordHubPage.tsx', '../src/pages/DaycarePage.tsx', '../src/pages/DaycarePersonPage.tsx', '../src/pages/DaycareVitalsPage.tsx', '../src/pages/DaycareActivityBulkPage.tsx', '../src/pages/DaycareTrainingPage.tsx'])
        assert.equal(read(f).replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').includes('デイ（せせらぎ）'), false, f)
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
      // 2026-10-24（§9.4）: 到着・帰宅のボタンは1人の画面へ、操作の本体は DaycareAttendanceOps へ移した（固定し直し・意図は同じ）
      const person = code('../src/pages/DaycarePersonPage.tsx')
      const ops = code('../src/components/DaycareAttendanceOps.tsx')
      assert.match(person, /const timesOk = canChangeDaycareTimes\(day, today, role\)/)
      assert.match(person, /onClick=\{\(\) => void ops\.onArrive\(row\)\}\s*disabled=\{opsDisabled \|\| !timesOk\}/)
      assert.match(person, /onClick=\{\(\) => void ops\.onLeave\(row\)\} disabled=\{opsDisabled \|\| !timesOk\}/)
      assert.match(t, /data\.snapshot !== null && data\.snapshot\.plan_source !== 'unknown'/)
      assert.match(person, /data\.snapshot !== null && data\.snapshot\.plan_source !== 'unknown'/)
      assert.match(ops, /arrived_at: prev\?\.arrived_at \?\? null, left_at: prev\?\.left_at \?\? null/)
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
      // 段階2d-2: 個人の閾値も同じ上限まで待つ（固定し直し・意図は同じ＝発熱の判定に使う基準を待ってから選ぶ）
      // 反証 中1: 欄の印と同じ行（親の useVitalLimits の refresh）で選ぶ
      assert.match(d, /const limitsP = refreshLimits\(\)\.then\(\(rows\) => \{\s*loadedLimits = rows/)
      assert.match(d, /const thresholds = Promise\.all\(\[loadVitalThresholds\(\), limitsP\]\)\.then\(/)
      assert.match(d, /const \[report\] = await Promise\.all\(\[\s*loadDay\(day\),\s*Promise\.race\(\[thresholds, new Promise<void>\(\(r\) => \(waitTimer = setTimeout\(r, THRESHOLD_WAIT_MS\)\)\)\]\),\s*\]\)/)
      assert.match(d, /const look = thresholdsLookup\(rows, vitalThresholds\(\)\)\s*return dailyFeverObservations\(obsAll, report\?\.daycareVitalIds, editing, \(rid\) => look\(rid, day\)\)/)
      assert.match(d, /const obs = pickFever\(loadedLimits\)/)
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
      // 2026-10-24（§9.4）: 操作の本体は DaycareAttendanceOps、時刻の欄のボタンは1人の画面の〔時刻を直す〕へ移した（固定し直し・意図は同じ）
      const ops = code('../src/components/DaycareAttendanceOps.tsx')
      const person = code('../src/pages/DaycarePersonPage.tsx')
      assert.match(ops, /if \(canEditPastDaycareTimes\(role\)\) openTime\(row, 'arrive'\)/)
      assert.match(ops, /if \(canEditPastDaycareTimes\(role\)\) openTime\(row, 'leave'\)/)
      // 今日の画面の改善 1回目（代表者の回答 A4）: 時刻を直す小窓（今日は現場も・過去の日は事務所だけ＝canChangeDaycareTimes）。
      // 〔帰宅を取り消す〕は時刻を直す小窓の中（現場の過去の日は〔時刻を直す〕が出ない＝止める意図は同じ）
      assert.match(person, /const timesOk = canChangeDaycareTimes\(day, today, role\)/)
      assert.match(person, /\{hasTimes\(row\) && timesOk \? \(\s*<button/)
      assert.match(ops, /setTimeFor\(null\)\s*askCancelLeave\(r\)/)
      assert.match(ops, /if \(!canChangeDaycareTimes\(day, todayIso\(\), role\)\) \{\s*setMsg\(row\.residentId, \{ tone: 'warn', text: MSG_PAST_TIME_CLEAR \}\)/)
      assert.match(t, /disabled=\{disabled \|\| \(rowHasTimes && !timesOk\)\}/)
      assert.match(person, /disabled=\{opsDisabled \|\| \(hasTimes\(row\) && !timesOk\)\}/)
      assert.match(ops, /if \(timesTouched && e instanceof DbError && e\.kind === 'forbidden' && dayRef\.current < todayIso\(\)\) return MSG_PAST_TIME/)
      assert.match(ops, /text: errText\(e, touchesTimes\(patch, row\.attendance\)\)/)
      assert.match(ops, /text: errText\(e, touchesTimes\(patch, row\)\)/)
      assert.match(ops, /type="time"/)
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
      // F6: 0042 は main に入ったので書き換えず、0043 で関数を差し替える（表・ポリシー・トリガには触れない）
      const m = sql('../supabase/migrations/0043_daycare_past_guard_more.sql')
      assert.doesNotMatch(m, /do \$\$/)
      assert.doesNotMatch(m, /create policy|drop policy|alter table|create (or replace )?trigger/i)
      assert.match(m, /create or replace function public\.daycare_attendance_past_guard\(\)/)
      assert.match(m, /and \(new\.resident_id = old\.resident_id or \(old\.arrived_at is null and old\.left_at is null\)\)/)
      assert.match(m, /and not \(new\.deleted_at is null and old\.deleted_at is not null\s+and \(new\.arrived_at is not null or new\.left_at is not null\)\)/)
    })
    it('反証レビュー5巡目の直し（静的）: 控えの行キーを読み込みごとに付け直す・基準値が遅れて届いたら読み直す・片づけの最中は帯のボタンを止める', () => {
      const d = code('../src/pages/DailySheetPage.tsx')
      assert.match(d, /rekeyHeld\(vitalConflictsRef\.current, \(id\) => \{[\s\S]*?return v === undefined \? null : vitalRowKey\(v, obs\)/)
      assert.match(d, /if \(heldNext !== null\) writeHeld\(heldNext\)/)
      assert.match(d, /const prev = moveRowStatuses\(prev0, keyMoves, keyStay\)/)
      // 6巡目: 基準値が遅れて届いても自動では読み直さない（失敗の繰り返し・入力中の行のずれを防ぐ）。違う基準だった時だけ一言
      assert.doesNotMatch(d, /setThresholdsTick|thresholdsTick/)
      // 段階2d-2: 施設の基準値が違った時（今までどおり）と、個人の閾値で選んだ行が変わる時だけ一言（反証 軽7）。固定し直し・意図は同じ
      assert.match(d, /const usedThresholds = JSON\.stringify\(vitalThresholds\(\)\)/)
      assert.match(d, /if \(!thresholdsDone\) \{\s*void thresholds\.then\(\(\) => \{\s*if \(alive && aliveRef\.current && \(JSON\.stringify\(vitalThresholds\(\)\) !== usedThresholds \|\| pickFever\(loadedLimits\)\.map\(\(v\) => v\.id\)\.join\(','\) !== pickedIds\)\) setThresholdsLate\(true\)/)
      // 段階2d-2: refreshLimits は親の useCallback（変わらない）＝足しても読み込みは増えない
      assert.match(d, /\}, \[day, reload, reloadToken, loadDay, applyAttendance, onLoaded, restoreDrafts, writeHeld, refreshLimits\]\)/)
      assert.match(d, /thresholdsLate=\{thresholdsLate\}\s*onReselect=\{\(\) => setReload\(\(n\) => n \+ 1\)\}/)
      // 7巡目 中1: 一言が案内するボタンを一言の横に置く（他の帯が出ていない時でも押せる）
      assert.match(d, /onClick=\{onReselect\}[\s\S]{0,200}選び直す/)
      // 6巡目 軽3: 保存の応答の後・消す確認の後は、いまの行キーを引き直して一言を出す
      assert.match(d, /const key = currentRowKey\(id, c\.rowKey\)/)
      assert.match(d, /const key = currentRowKey\(v\.id, rowKey\)/)
      assert.match(d, /\[v\.id\]: \{ rowKey: key, mode, base: cur\?\.base \?\? v, edits: merged \}/)
      assert.match(d, /if \(waitTimer !== null\) clearTimeout\(waitTimer\)/)
      const v = code('../src/pages/DaycareVitalsPage.tsx')
      assert.match(v, /if \(msg === null \|\| releasingRef\.current\) return/)
      assert.ok((v.match(/disabled=\{releasing\}/g) ?? []).length >= 4, '日付の3つと帯のボタン')
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
