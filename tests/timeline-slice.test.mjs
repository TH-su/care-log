// 今日の要注意の7日を、タイムラインの10日（記録者つき）の控えから切り出す純関数（src/pages/alertsModel.ts の sliceTimelineChunk・
// 2026-10-29 本人指示「7日を別に取らない」）の回帰テスト。
// 本物の timeline_chunk と一致することは tests/timeline-slice-pg.mjs（素の Postgres・pg-run-all.mjs から）で確かめる。
// ここでは DB を使わず、SQL の各欄の条件の境界（日付の範囲・終わった日の日本時間・60日の遡り・既読・並び）を確かめる。
// 実行: npm test。個人情報は置かない（数値IDと架空の本文だけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerLoadFailure } from './ts-load.mjs'

let AM = null
let loadError = null
try {
  AM = await import('../src/pages/alertsModel.ts')
} catch (e) {
  loadError = e
}
if (AM === null) registerLoadFailure('要注意の7日の切り出し（alertsModel.ts）', loadError, 'この Node では TypeScript を直接読み込めません。')

const note = (id, note_on, extra = {}) => ({ id, note_on, shift: 'day', resident_id: 1, body: `本文${id}`, importance: 'normal', ongoing: false, ended_at: null, read_count: 0, my_read: false, ...extra })

/** 10日（10-20〜10-29・記録者つき）の結果の見本。並びは SQL と同じ（新しい日が先） */
const TEN = () => ({
  from: '2026-10-20',
  to: '2026-10-29',
  notes: [note(5, '2026-10-29', { my_read: true, read_count: 2 }), note(4, '2026-10-23'), note(3, '2026-10-22', { my_read: true }), note(2, '2026-10-20')],
  vitals: [{ id: 13, measured_on: '2026-10-29' }, { id: 12, measured_on: '2026-10-23' }, { id: 11, measured_on: '2026-10-21' }],
  meals: [{ id: 23, meal_on: '2026-10-29' }, { id: 22, meal_on: '2026-10-22' }],
  fluids: [{ id: 33, taken_on: '2026-10-23' }, { id: 32, taken_on: '2026-10-20' }],
  outings: [
    { id: 41, start_on: '2026-10-25', end_on: '2026-10-26' },
    { id: 42, start_on: '2026-10-21', end_on: '2026-10-22' }, // 帰着が7日の前
    { id: 43, start_on: '2026-10-21', end_on: null },
    { id: 44, start_on: '2026-08-24', end_on: '2026-10-23' }, // 7日の始まり−60日＝08-24（入る）
    { id: 45, start_on: '2026-08-22', end_on: null }, // 7日の遡りの外（10日の遡りの中）
  ],
  importDays: [{ source: 'events', day: '2026-10-23' }, { source: 'events', day: '2026-10-21' }],
  pinned: [
    note(101, '2026-08-01', { ongoing: true, importance: 'critical', my_read: true }),
    note(102, '2026-10-01', { ongoing: true, ended_at: '2026-10-21T03:00:00+00:00' }), // 10-21 に終わった
    note(103, '2026-10-01', { ongoing: true, ended_at: '2026-10-22T15:30:00+00:00' }), // 日本時間 10-23 0:30
    note(104, '2026-10-01', { ongoing: true, ended_at: '2026-10-22T14:30:00+00:00' }), // 日本時間 10-22 23:30
    note(105, '2026-08-24', { ongoing: true, ended_at: '2026-10-25T03:00:00+00:00' }), // 遡りの境目（入る）
    note(106, '2026-08-23', { ongoing: true, ended_at: '2026-10-25T03:00:00+00:00' }), // 遡りの外
  ],
})

describe('要注意の7日の切り出し（sliceTimelineChunk）', { skip: AM === null }, () => {
  it('日付の範囲の欄（申し送り・バイタル・食事・水分・取込台帳）は 7日の中だけ・並びはそのまま', () => {
    const c = AM.sliceTimelineChunk(TEN(), '2026-10-23', '2026-10-29')
    assert.equal(c.from, '2026-10-23')
    assert.equal(c.to, '2026-10-29')
    assert.deepEqual(c.notes.map((n) => n.id), [5, 4])
    assert.deepEqual(c.vitals.map((v) => v.id), [13, 12])
    assert.deepEqual(c.meals.map((m) => m.id), [23])
    assert.deepEqual(c.fluids.map((f) => f.id), [33])
    assert.deepEqual(c.importDays.map((d) => d.day), ['2026-10-23'])
  })

  it('既読: 記録者なしで取った時と同じく my_read は false（read_count はそのまま）。元の行は書き換えない', () => {
    const ten = TEN()
    const c = AM.sliceTimelineChunk(ten, '2026-10-23', '2026-10-29')
    assert.equal(c.notes[0].my_read, false)
    assert.equal(c.notes[0].read_count, 2)
    assert.equal(c.pinned.find((n) => n.id === 101).my_read, false)
    assert.equal(ten.notes[0].my_read, true)
  })

  it('継続: 終わっていない分・7日の始まり（日本時間）以降に終わった分・遡り60日の境目まで。日本時間で日をまたぐ境目も SQL と同じ', () => {
    const c = AM.sliceTimelineChunk(TEN(), '2026-10-23', '2026-10-29')
    assert.deepEqual(c.pinned.map((n) => n.id), [101, 103, 105])
  })

  it('外出: 始まりが7日の終わり以前・始まりが7日の始まり−60日以降・帰着が未定か7日の始まり以降', () => {
    const c = AM.sliceTimelineChunk(TEN(), '2026-10-23', '2026-10-29')
    assert.deepEqual(c.outings.map((o) => o.id), [41, 43, 44])
  })

  it('終わっていない継続は、始まりが to−60日以降か最重要だけ（0050・境目は帯と同じ）', () => {
    const ten = TEN()
    ten.pinned = [
      note(201, '2026-08-30', { ongoing: true, importance: 'normal' }), // to−60日＝08-30（入る）
      note(202, '2026-08-29', { ongoing: true, importance: 'normal' }), // 1日前（入らない）
      note(203, '2026-08-29', { ongoing: true, importance: 'important' }), // 重要でも入らない
      note(204, '2026-08-29', { ongoing: true, importance: 'critical' }), // 最重要は入る
      note(205, '2025-01-01', { ongoing: true, importance: 'critical' }), // 遠い過去の最重要も入る
    ]
    const c = AM.sliceTimelineChunk(ten, '2026-10-23', '2026-10-29')
    assert.deepEqual(c.pinned.map((n) => n.id), [201, 204, 205])
  })

  it('終わり（to）が元の終わりと違う時は null（元の結果に無い継続があり得る・0050）', () => {
    assert.equal(AM.sliceTimelineChunk(TEN(), '2026-10-22', '2026-10-28'), null)
  })

  it('元の期間に収まらない範囲は null（呼ぶ側が取りに行く）。同じ範囲なら同じ中身', () => {
    assert.equal(AM.sliceTimelineChunk(TEN(), '2026-10-19', '2026-10-29'), null)
    assert.equal(AM.sliceTimelineChunk(TEN(), '2026-10-23', '2026-10-30'), null)
    assert.equal(AM.sliceTimelineChunk(TEN(), '2026-10-25', '2026-10-24'), null)
    const same = AM.sliceTimelineChunk(TEN(), '2026-10-20', '2026-10-29')
    assert.deepEqual(same.vitals.map((v) => v.id), [13, 12, 11])
    assert.equal(AM.CHUNK_LOOKBACK_DAYS, 60)
  })
})
