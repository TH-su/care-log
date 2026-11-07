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
]
const roster = [
  { id: 's1', name: '職員A', mainDivision: '施設', group: 'visit', order: 3 },
  { id: 's2', name: '職員B', mainDivision: '訪問', group: 'visit', order: 1 },
  { id: 's3', name: '職員C', mainDivision: '施設', group: 'night', order: 9 },
  { id: 's4', name: '職員D', mainDivision: '施設', group: 'night', order: 8 },
  { id: 's5', name: '職員E', mainDivision: '施設', group: 'visit', order: 2 },
  { id: 's6', name: '同名', mainDivision: '通所', group: 'day', order: 4 },
  { id: 's7', name: '職員F', mainDivision: '通所', group: 'day', order: 5 },
]
const symbols = [
  { code: '早', type: 'work' },
  { code: '休', type: 'off' },
  { code: '希', type: 'off' },
  { code: '明', type: 'off' },
  { code: '有', type: 'paidOff' },
  { code: '公', type: 'publicOff' },
  { code: '(21', type: 'nightIn' },
  { code: '7)', type: 'nightOut' },
]
const plan = {
  cells: {
    s1: { 7: '早', 8: '休' },
    s2: { 7: '7-9 17-21', 8: '遅' },
    s3: { 7: '（21', 8: '7)' }, // 全角のかっこ
    s4: { 7: '7)', 8: '(21' }, // 前の夜の明け（7日）・8日は夜勤入り
    s5: { 7: '早' }, // 退職した職員（ケアログで在籍していない）
    s6: { 7: '日1' }, // 同じ氏名が2人＝結ばない
    s7: { 7: '有', 8: '9-15' },
  },
}

describe('勤務表の1日分（shiftDay）', () => {
  if (S === null) {
    registerLoadFailure('勤務表の1日分', loadError, 'この Node では TypeScript を直接読み込めないため、勤務表の1日分の試験をスキップしました。')
    return
  }

  it('予定から出勤者を勤務表の並びで出し、夜勤入りの施設職員を最後に足す', () => {
    const d = S.resolveShiftDay({ plan, staff: roster, symbols }, '2026-11-07', care)
    assert.equal(d.source, 'plan')
    // s2(order1)・s1(order3)。s4 は夜勤明けだけ・s5 は退職・s6 は同名・s7 は有休 → 入らない。s3 は夜勤入り → 最後
    assert.deepEqual(d.staffIds, [12, 11, 13])
    assert.equal(d.nightStaffId, 13)
  })

  it('連続の夜勤（7)(21）も夜勤入り。明けだけの日は出勤に数えない', () => {
    const p = { cells: { s3: { 9: '7)(21' }, s4: { 9: '7)' } } }
    const d = S.resolveShiftDay({ plan: p, staff: roster, symbols }, '2026-11-09', care)
    assert.deepEqual(d.staffIds, [13])
    assert.equal(d.nightStaffId, 13)
  })

  it('夜勤入りの施設職員が2人の日・結べない日は決めない', () => {
    const two = { cells: { s3: { 10: '(21' }, s4: { 10: '(22' } } }
    assert.equal(S.resolveShiftDay({ plan: two, staff: roster, symbols }, '2026-11-10', care).nightStaffId, null)
    const unmapped = { cells: { s5: { 10: '(21' } } }
    assert.equal(S.resolveShiftDay({ plan: unmapped, staff: roster, symbols }, '2026-11-10', care).nightStaffId, null)
    const unknown = { cells: { s3: { 10: '(21' }, zz: { 10: '(21' } } }
    assert.equal(S.resolveShiftDay({ plan: unknown, staff: roster, symbols }, '2026-11-10', care).nightStaffId, null)
  })

  it('施設以外の所属の夜勤入りは夜勤の記入者に数えない', () => {
    const p = { cells: { s3: { 11: '(21' }, s2: { 11: '(21' } } }
    assert.equal(S.resolveShiftDay({ plan: p, staff: roster, symbols }, '2026-11-11', care).nightStaffId, 13)
  })

  it('その日の記号がある表を 実績 → 確定 → 予定 の順に使う', () => {
    const actual = { cells: { s1: { 8: '早' } } }
    const official = { cells: { s2: { 8: '早' }, s1: { 7: '早' } } }
    const d8 = S.resolveShiftDay({ actual, official, plan, staff: roster, symbols }, '2026-11-08', care)
    assert.equal(d8.source, 'actual')
    assert.deepEqual(d8.staffIds, [11])
    const d7 = S.resolveShiftDay({ actual, official, plan, staff: roster, symbols }, '2026-11-07', care)
    assert.equal(d7.source, 'official')
    assert.deepEqual(d7.staffIds, [11])
    assert.equal(d7.nightStaffId, null)
  })

  it('記号の一覧が読めない時も既定の休みの記号で判定する・形の崩れた表は空', () => {
    const d = S.resolveShiftDay({ plan, staff: roster, symbols: 'x' }, '2026-11-08', care)
    assert.deepEqual(d.staffIds, [12, 18, 14]) // s1 は休・s7 は 9-15・s4 は夜勤入り
    assert.equal(d.nightStaffId, 14)
    assert.deepEqual(S.resolveShiftDay({ plan: { cells: 3 }, staff: roster }, '2026-11-08', care), S.EMPTY_SHIFT_DAY)
    assert.deepEqual(S.resolveShiftDay({ plan }, '2026-13-40', care), S.EMPTY_SHIFT_DAY)
    assert.deepEqual(S.resolveShiftDay({}, '2026-11-08', care), S.EMPTY_SHIFT_DAY)
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
