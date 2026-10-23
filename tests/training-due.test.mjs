// デイ（せせらぎ）段階3b: 個別機能訓練の期限の計算（src/lib/trainingDue.ts）の回帰テスト（2026-10-23・段階3の計画 2章）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 期待値は検証計画 v2 の 3.6 の表（計画書アプリ training-plan.html の nextDueOf・dueState を実行した値）をそのまま使う。
// 次の期限 11行×3つの規則・状態 8行・積み上げない（1/31 → 4/15 → 7/15）・状態の順（終了 → 計画なし → dueState）。
// 個人情報は置かない（利用者は数値IDだけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

let D = null
let loadError = null
try {
  D = await import('../src/lib/trainingDue.ts')
} catch (e) {
  loadError = e
}

/** 検証計画 v2 の 3.6「次の期限」（作成日 → 暦の月・90日・早い方） */
const NEXT_DUE = [
  ['2026-08-31', '2026-11-30', '2026-11-29', '2026-11-29'],
  ['2026-11-30', '2027-02-28', '2027-02-28', '2027-02-28'],
  ['2026-12-31', '2027-03-31', '2027-03-31', '2027-03-31'],
  ['2027-01-31', '2027-04-30', '2027-05-01', '2027-04-30'],
  ['2027-11-29', '2028-02-29', '2028-02-27', '2028-02-27'],
  ['2027-11-30', '2028-02-29', '2028-02-28', '2028-02-28'],
  ['2027-12-01', '2028-03-01', '2028-02-29', '2028-02-29'],
  ['2028-02-29', '2028-05-29', '2028-05-29', '2028-05-29'],
  ['2028-11-30', '2029-02-28', '2029-02-28', '2029-02-28'],
  ['2028-12-01', '2029-03-01', '2029-03-01', '2029-03-01'],
]

const visit = (over = {}) => ({ id: 1, resident_id: 1, visited_on: '2026-10-01', explained_to: 'family', explained_on: '2026-10-01', ...over })
const copyRow = (over = {}) => ({ resident_id: 1, latest_plan_date: '2026-09-01', next_due: '2026-12-01', stop_reason: null, stop_from: null, ...over })

if (D === null) {
  registerLoadFailure('段階3b（期限の計算）の試験', loadError, 'この Node では TypeScript を直接読み込めません（Node 22.18 以降で実行してください）')
} else {
  describe('次の期限（検証計画 v2 の 3.6・計画書アプリと同じ答え）', () => {
    for (const [base, cal, d90, min] of NEXT_DUE) {
      it(`${base} → 暦の月 ${cal}・90日 ${d90}・早い方 ${min}`, () => {
        assert.equal(D.nextDueOf(base, 'calendar'), cal)
        assert.equal(D.nextDueOf(base, 'days90'), d90)
        assert.equal(D.nextDueOf(base, 'min'), min)
      })
    }
    it('2026-02-30（存在しない日）は空（期限なし）。形の違う値・空も空', () => {
      assert.equal(D.nextDueOf('2026-02-30', 'calendar'), '')
      assert.equal(D.nextDueOf('2026/10/01', 'calendar'), '')
      assert.equal(D.nextDueOf('', 'calendar'), '')
      assert.equal(D.parseYmd('2026-02-30'), null)
    })
    it('知らない規則は暦の月', () => {
      assert.equal(D.nextDueOf('2027-01-31', 'weekly'), '2027-04-30')
      assert.equal(D.nextDueOf('2027-01-31', null), '2027-04-30')
    })
  })

  describe('期限の状態（期限 2026-11-30・間近は既定の28日前から）', () => {
    const DUE = '2026-11-30'
    const rows = [
      ['2026-12-01', 'overdue', '期限切れは翌日から'],
      ['2026-11-30', 'warn', '当日は期限切れではない'],
      ['2026-11-29', 'warn', '前日'],
      ['2026-11-02', 'warn', '間近の始まり（28日前を含む）'],
      ['2026-11-01', 'ok', '間近の外'],
    ]
    for (const [today, state, why] of rows) {
      it(`今日 ${today} → ${state}（${why}）`, () => assert.equal(D.dueState(DUE, today, 28), state))
    }
    it('期限が空 → none（計画なし）', () => assert.equal(D.dueState('', '2026-11-30', 28), 'none'))
    it('間近の日数が負の値・数でない → 28日として扱う。行が無い（null）も28日（計画書アプリの Number(null)＝0 とは違えて既定に倒す）', () => {
      assert.equal(D.dueState(DUE, '2026-11-02', -1), 'warn')
      assert.equal(D.dueState(DUE, '2026-11-01', -1), 'ok')
      assert.equal(D.dueState(DUE, '2026-11-02', 'abc'), 'warn')
      assert.equal(D.dueState(DUE, '2026-11-02', null), 'warn')
      assert.equal(D.dueState(DUE, '2026-11-02', undefined), 'warn')
      assert.equal(D.normalizeWarnDays(7.4), 7)
      assert.equal(D.normalizeWarnDays(366), 28)
      assert.equal(D.dueState(DUE, '2026-11-23', 7), 'warn', '7日前を含む')
      assert.equal(D.dueState(DUE, '2026-11-22', 7), 'ok', '8日前は期限内')
      assert.equal(D.dueState(DUE, '2026-11-23', 0), 'ok')
      assert.equal(D.dueState(DUE, '2026-11-30', 0), 'warn', '0日でも当日は間近')
    })
  })

  describe('居宅訪問の期限（計画 2.2・検証計画 v2 の 3.6 を訪問日に読み替える）', () => {
    const today = '2026-10-23'
    it('暦の月の列と同じ答え（訪問日 → 期限）', () => {
      for (const [base, cal] of NEXT_DUE) {
        const rows = D.homeVisitDueList({ visits: [visit({ visited_on: base })], copy: [], settings: null, people: [], today })
        assert.equal(rows[0].due, cal)
      }
    })
    it('積み上げない: 1/31 の訪問 → 次の訪問 4/15 → その次の期限は 7/15（積み上げると 7/30）', () => {
      const visits = [visit({ id: 1, visited_on: '2027-01-31' }), visit({ id: 2, visited_on: '2027-04-15' })]
      const rows = D.homeVisitDueList({ visits, copy: [], settings: null, people: [], today: '2027-05-01' })
      assert.equal(rows[0].due, '2027-07-15')
      assert.equal(rows[0].visit.id, 2)
    })
    it('規則と間近の日数は写しの設定から（無ければ暦の月・28日）', () => {
      const v = [visit({ visited_on: '2027-01-31' })]
      assert.equal(D.homeVisitDueList({ visits: v, copy: [], settings: { due_rule: 'days90', warn_days: 28, synced_at: null }, people: [], today })[0].due, '2027-05-01')
      assert.equal(D.homeVisitDueList({ visits: v, copy: [], settings: { due_rule: 'min', warn_days: 28, synced_at: null }, people: [], today })[0].due, '2027-04-30')
      const near = D.homeVisitDueList({ visits: v, copy: [], settings: { due_rule: 'calendar', warn_days: 7, synced_at: null }, people: [], today: '2027-04-20' })
      assert.equal(near[0].state, 'ok', '7日前より前は期限内')
    })
    it('状態の順: 在籍でない方・写しの通知を止めた日が今日以前の方は「終了」で出さない。止めた日が先なら出す', () => {
      const visits = [visit({ resident_id: 1, visited_on: '2026-01-01' }), visit({ resident_id: 2, visited_on: '2026-01-01' }), visit({ resident_id: 3, visited_on: '2026-01-01' })]
      const copy = [copyRow({ resident_id: 2, stop_reason: 'stopped', stop_from: '2026-10-23' }), copyRow({ resident_id: 3, stop_reason: 'discharge', stop_from: '2026-10-24' })]
      const people = [{ id: 1, active: false }, { id: 2, active: true }, { id: 3, active: true }]
      const rows = D.homeVisitDueList({ visits, copy, settings: null, people, today })
      assert.deepEqual(rows.map((r) => [r.residentId, r.state]), [[3, 'overdue']])
    })
    it('訪問の記録が無い方: 写しで計画がある方だけ「記録なし」。計画の無い写し・写しの無い方は出さない', () => {
      const copy = [copyRow({ resident_id: 5 }), copyRow({ resident_id: 6, latest_plan_date: null, next_due: null })]
      const rows = D.homeVisitDueList({ visits: [], copy, settings: null, people: [], today })
      assert.deepEqual(rows.map((r) => [r.residentId, r.state, r.due]), [[5, 'none', '']])
    })
    it('説明の記録なし: 相手と日の両方が無いと「なし」（片方だけも「なし」）。期限は訪問日から出る', () => {
      const visits = [
        visit({ id: 1, resident_id: 1, explained_to: null, explained_on: null }),
        visit({ id: 2, resident_id: 2, explained_to: 'user', explained_on: null }),
        visit({ id: 3, resident_id: 3, explained_to: null, explained_on: '2026-10-02' }),
        visit({ id: 4, resident_id: 4 }),
      ]
      const rows = D.homeVisitDueList({ visits, copy: [], settings: null, people: [], today })
      assert.deepEqual(rows.map((r) => [r.residentId, r.noExplanation, r.due]), [
        [1, true, '2027-01-01'],
        [2, true, '2027-01-01'],
        [3, true, '2027-01-01'],
        [4, false, '2027-01-01'],
      ])
      assert.deepEqual(D.homeVisitDueCounts(rows), { overdue: 0, warn: 0, none: 0, noExplanation: 3 })
    })
    it('並び: 期限切れ → 間近 → 記録なし → 期限内（同じ状態は期限の早い順）', () => {
      const visits = [
        visit({ id: 1, resident_id: 1, visited_on: '2026-09-01' }), // 期限 12/01 → 期限内
        visit({ id: 2, resident_id: 2, visited_on: '2026-07-01' }), // 期限 10/01 → 期限切れ
        visit({ id: 3, resident_id: 3, visited_on: '2026-08-01' }), // 期限 11/01 → 間近
        visit({ id: 4, resident_id: 4, visited_on: '2026-06-01' }), // 期限 09/01 → 期限切れ（早い）
      ]
      const rows = D.homeVisitDueList({ visits, copy: [copyRow({ resident_id: 9 })], settings: null, people: [], today })
      assert.deepEqual(rows.map((r) => [r.residentId, r.state]), [[4, 'overdue'], [2, 'overdue'], [3, 'warn'], [9, 'none'], [1, 'ok']])
      assert.deepEqual(D.homeVisitDueCounts(rows), { overdue: 2, warn: 1, none: 1, noExplanation: 0 })
    })
    it('直近の訪問: 訪問日の新しい方（同じ日は番号の大きい方）。不正な日付の行は使わない', () => {
      const visits = [visit({ id: 1, visited_on: '2026-09-01' }), visit({ id: 3, visited_on: '2026-09-01' }), visit({ id: 2, visited_on: '2026-02-30' })]
      assert.equal(D.latestVisit(visits, 1).id, 3)
    })
  })

  describe('静的検査', () => {
    it('純ロジックは時刻を読まない・端末に残さない（今日は呼び出し側が渡す）', () => {
      const src = readFileSync(new URL('../src/lib/trainingDue.ts', import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
      assert.doesNotMatch(src, /new Date\(\)|Date\.now\(\)|localStorage|supabase/)
    })
  })
}
