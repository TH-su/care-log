// 勤務表の1日分から出勤者と夜勤の施設職員を決める純関数（src/lib/shiftDay.ts）の試験（2026-11-07 代表者の決定）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
// 個人情報は置かない（職員は架空の氏名「職員A」〜・勤務表の id も架空）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerLoadFailure } from './ts-load.mjs'

let S = null
let loadError = null
try {
  S = await import('../src/lib/shiftDay.ts')
} catch (e) {
  S = null
  loadError = e
}

const care = [
  { id: 11, name: '職員 A', active: true },
  { id: 12, name: '職員B', active: true },
  { id: 13, name: '職員C', active: true },
  { id: 14, name: '職員D', active: true },
  { id: 15, name: '職員E', active: false }, // 退職
  { id: 16, name: '同名', active: true },
  { id: 17, name: '同名', active: true },
  { id: 18, name: '職員F', active: true },
  { id: 19, name: '職員G', active: true },
]
const roster = [
  { id: 's1', name: '職員A', mainDivision: '施設', group: 'visit', order: 3 },
  { id: 's2', name: '職員B', mainDivision: '訪問', group: 'visit', order: 1 },
  { id: 's3', name: '職員C', mainDivision: '施設', group: 'night', order: 9 },
  { id: 's4', name: '職員D', mainDivision: '施設', group: 'night', order: 8 },
  { id: 's5', name: '職員E', mainDivision: '施設', group: 'visit', order: 2 },
  { id: 's6', name: '同名', mainDivision: '施設', group: 'visit', order: 4 },
  { id: 's7', name: '職員F', mainDivision: '通所', group: 'day', order: 5 },
  { id: 's8', name: '職員G', group: 'visit', order: 6 }, // 所属が空＝施設
]
const symbols = [
  { code: '早', type: 'work' },
  { code: '遅', type: 'work' },
  { code: '日1', type: 'work' },
  { code: '休', type: 'off' },
  { code: '希', type: 'off' },
  { code: '明', type: 'off' },
  { code: '有', type: 'paidOff' },
  { code: '公', type: 'publicOff' },
  { code: '(21', type: 'nightIn' },
  { code: '(22', type: 'nightIn' },
  { code: '7)', type: 'nightOut' },
]
const plan = {
  cells: {
    s1: { 7: '早', 8: '休' },
    s2: { 7: '7-9 17-21', 8: '遅' }, // 訪問が主＝主の欄は施設の日報に入れない
    s3: { 7: '（21', 8: '7)' }, // 全角のかっこ
    s4: { 7: '7)', 8: '(21' }, // 7日は前の夜の明けだけ・8日は夜勤入り
    s5: { 7: '早' }, // 退職した職員（ケアログで在籍していない）
    s6: { 7: '日1' }, // 同じ氏名が2人＝結ばない
    s7: { 7: '有', 8: '9-15' }, // 通所が主
    s8: { 7: '日1' },
  },
  subCells: { s2: { 施設: { 8: '13-16' } }, s7: { 施設: { 7: '9-12' } } },
}

describe('勤務表の1日分（shiftDay）', () => {
  if (S === null) {
    registerLoadFailure('勤務表の1日分', loadError, 'この Node では TypeScript を直接読み込めないため、勤務表の1日分の試験をスキップしました。')
    return
  }

  it('施設の日報の出勤者は、施設が主の職員の主の欄とほかの職員の施設の応援の欄。夜勤入りの施設職員を最後に足す', () => {
    const d = S.resolveShiftDay({ plan, staff: roster, symbols }, '2026-11-07', care)
    assert.equal(d.source, 'plan')
    // s1(3)・s7 の施設の応援(5)・s8 所属空(6)。s2 は訪問の主の欄・s4 は明けだけ・s5 退職・s6 同名・s7 主の欄は有休 → 入らない。s3 は夜勤入り → 最後
    assert.deepEqual(d.staffIds, [11, 18, 19, 13])
    assert.equal(d.nightStaffId, 13)
    const d8 = S.resolveShiftDay({ plan, staff: roster, symbols }, '2026-11-08', care)
    // s2 の施設の応援(1)。s4 夜勤入り。s7 の主の欄（通所）の 9-15 は入らない
    assert.deepEqual(d8.staffIds, [12, 14])
    assert.equal(d8.nightStaffId, 14)
  })

  it('記号はシフト作成アプリと同じ順に読む（別名・明け・代替記号・欠・読めない記号）', () => {
    const t = S.symbolTypes(symbols)
    const r = (c) => {
      const x = S.readShiftCell(c, t)
      return `${x.dayWork ? 'D' : '-'}${x.nightIn ? 'N' : '-'}`
    }
    for (const c of ['有休', '公休', '希休', '希望休', '有給', '欠', ')', ')(希', '7)(希', '(有', '7)', '明', '休', '早(1h)', '研修', '']) {
      assert.equal(r(c), '--', c)
    }
    for (const c of ['(21', '（22', '7)(21', '8)(22', ')(21']) assert.equal(r(c), '-N', c)
    for (const c of ['早', '日1', '9-15', '7:30-16:30', '7-9 17-21', '早/同', '１２－２１']) assert.equal(r(c), 'D-', c)
    assert.equal(r('7-9 (21'), 'DN')
    // 記号の一覧が読めない時は既定の一覧
    assert.equal(S.readShiftCell('明', S.symbolTypes('x')).dayWork, false)
    assert.equal(S.readShiftCell('遅', S.symbolTypes(null)).dayWork, true)
  })

  it('連続の夜勤（7)(21）も夜勤入り。明けだけの日は出勤に数えない', () => {
    const p = { cells: { s3: { 9: '7)(21' }, s4: { 9: '7)' } } }
    const d = S.resolveShiftDay({ plan: p, staff: roster, symbols }, '2026-11-09', care)
    assert.deepEqual(d.staffIds, [13])
    assert.equal(d.nightStaffId, 13)
  })

  it('夜勤入りの施設職員が2人の日・結べない人がいる日は決めない。施設以外が主の職員の主の欄の夜勤入りは数えない', () => {
    const two = { cells: { s3: { 10: '(21' }, s4: { 10: '(22' } } }
    assert.equal(S.resolveShiftDay({ plan: two, staff: roster, symbols }, '2026-11-10', care).nightStaffId, null)
    const unmapped = { cells: { s3: { 10: '(21' }, s5: { 10: '(21' } } }
    assert.equal(S.resolveShiftDay({ plan: unmapped, staff: roster, symbols }, '2026-11-10', care).nightStaffId, null)
    const other = { cells: { s3: { 11: '(21' }, s2: { 11: '(21' } } }
    assert.equal(S.resolveShiftDay({ plan: other, staff: roster, symbols }, '2026-11-11', care).nightStaffId, 13)
    const blank = { cells: { s8: { 11: '(21' } } }
    assert.equal(S.resolveShiftDay({ plan: blank, staff: roster, symbols }, '2026-11-11', care).nightStaffId, 19)
  })

  it('職員ごとに 実績 → 確定 → 予定 の順で記号を使う（実績に1人分だけあっても、ほかの人は予定から）', () => {
    const actual = { cells: { s1: { 8: '早' } } }
    const official = { cells: { s4: { 8: '休' } } }
    const d8 = S.resolveShiftDay({ actual, official, plan, staff: roster, symbols }, '2026-11-08', care)
    assert.equal(d8.source, 'actual')
    // s1 は実績の早（予定は休）・s4 は確定の休（予定は夜勤入り）・s2 の応援は予定から
    assert.deepEqual(d8.staffIds, [12, 11])
    assert.equal(d8.nightStaffId, null)
  })

  it('形の崩れた表・職員の一覧が無い・日付の形が違う時は空。勤務表で退職の職員は結ばない', () => {
    assert.deepEqual(S.resolveShiftDay({ plan: { cells: 3 }, staff: roster }, '2026-11-08', care), S.EMPTY_SHIFT_DAY)
    assert.deepEqual(S.resolveShiftDay({ plan }, '2026-11-08', care), S.EMPTY_SHIFT_DAY)
    assert.deepEqual(S.resolveShiftDay({ plan, staff: roster }, '2026-13-40', care), S.EMPTY_SHIFT_DAY)
    assert.deepEqual(S.resolveShiftDay({}, '2026-11-08', care), S.EMPTY_SHIFT_DAY)
    const gone = roster.map((r) => (r.id === 's1' ? { ...r, status: '退職' } : r))
    assert.ok(!S.resolveShiftDay({ plan, staff: gone, symbols }, '2026-11-07', care).staffIds.includes(11))
  })

  it('記入者の候補は出勤者の欄が正・空の日は勤務表・在籍だけ', () => {
    const shift = { source: 'plan', staffIds: [12, 11, 15], nightStaffId: null }
    assert.deepEqual(S.reporterCandidates([13, 11, 13], shift, care), [13, 11])
    assert.deepEqual(S.reporterCandidates([], shift, care), [12, 11])
    assert.deepEqual(S.reporterCandidates([], S.EMPTY_SHIFT_DAY, care), [])
  })

  it('出勤者の欄を自動で埋めるのは今日と昨日だけ・読むキーはその月の3つの表と2つの一覧', () => {
    assert.equal(S.canAutoFillAttendance('2026-11-07', '2026-11-07'), true)
    assert.equal(S.canAutoFillAttendance('2026-11-06', '2026-11-07'), true)
    assert.equal(S.canAutoFillAttendance('2026-11-05', '2026-11-07'), false)
    assert.equal(S.canAutoFillAttendance('2026-11-08', '2026-11-07'), false)
    assert.equal(S.canAutoFillAttendance('x', '2026-11-07'), false)
    assert.deepEqual(S.shiftKeysFor('2026-11-07'), [
      'sched:2026-11:actual',
      'sched:2026-11:official',
      'sched:2026-11:plan',
      'staff',
      'symbols',
    ])
  })
})
