// デイの入浴記録の純ロジック（src/lib/bath.ts）の回帰テスト。2026-09-26 追加。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 対象は DB・DOM に触れない関数だけ（曜日の計算・予定と記録の突き合わせ・件数・月次集計・入力の検証）。
// db.ts 経由の保存・送信待ち・種類ごとの封鎖は tests/logic.test.mjs の「入浴記録（db.ts）」にある。
// 個人情報は置かない（利用者・職員は数値IDのみ。氏名・記録本文を書かない）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const TS_UNSUPPORTED =
  'この Node では TypeScript を直接読み込めないため、入浴記録の純ロジックの検証をスキップしました（Node 22.18 以降で実行してください）。'

let B = null
try {
  B = await import('../src/lib/bath.ts')
} catch {
  B = null
}

/** BathRecord の最小形 */
function rec(id, residentId, day, result, over = {}) {
  return {
    id,
    resident_id: residentId,
    bath_on: day,
    result,
    cancel_reason: result === 'cancel' ? 'condition' : null,
    note: null,
    recorded_by: null,
    rev: 1,
    ...over,
  }
}

if (B === null) {
  it('入浴記録の純ロジック', { skip: TS_UNSUPPORTED }, () => {})
} else {
  describe('isoWeekdayIndex（週間計画の曜日番号 0=月 … 6=日・SQL の isodow-1 と同じ）', () => {
    it('月曜は0・日曜は6', () => {
      assert.equal(B.isoWeekdayIndex('2026-09-21'), 0) // 月
      assert.equal(B.isoWeekdayIndex('2026-09-23'), 2) // 水
      assert.equal(B.isoWeekdayIndex('2026-09-26'), 5) // 土
      assert.equal(B.isoWeekdayIndex('2026-09-27'), 6) // 日
    })
    it('年・月をまたいでも曜日がずれない（閏日を含む）', () => {
      assert.equal(B.isoWeekdayIndex('2024-02-29'), 3) // 木
      assert.equal(B.isoWeekdayIndex('2026-01-01'), 3) // 木
      assert.equal(B.isoWeekdayIndex('2025-12-31'), 2) // 水
    })
    it('形が不正・存在しない日付は null', () => {
      for (const bad of ['', '2026-9-1', '2026-02-30', '2026-13-01', 'x']) {
        assert.equal(B.isoWeekdayIndex(bad), null, bad)
      }
    })
  })

  describe('月の扱い（parseMonthKey・shiftMonth・monthDays）', () => {
    it('parseMonthKey は yyyy-MM で今月以前だけ受け入れる（原則11のホワイトリスト照合）', () => {
      assert.equal(B.parseMonthKey('2026-09', '2026-09'), '2026-09')
      assert.equal(B.parseMonthKey('2025-12', '2026-09'), '2025-12')
      assert.equal(B.parseMonthKey('2026-10', '2026-09'), null, '未来の月')
      for (const bad of ['2026-13', '2026-00', '2026-9', '2026-09-01', '', null, undefined, 202609, '{"x":1}']) {
        assert.equal(B.parseMonthKey(bad, '2026-09'), null, String(bad))
      }
    })
    it('shiftMonth は年をまたぐ', () => {
      assert.equal(B.shiftMonth('2026-01', -1), '2025-12')
      assert.equal(B.shiftMonth('2025-12', 1), '2026-01')
      assert.equal(B.shiftMonth('2026-09', -12), '2025-09')
    })
    it('monthDays は1日〜月末（閏年の2月を含む）', () => {
      assert.equal(B.monthDays('2026-09').length, 30)
      assert.equal(B.monthDays('2026-02').length, 28)
      assert.equal(B.monthDays('2024-02').length, 29)
      assert.equal(B.monthDays('2026-09')[0], '2026-09-01')
      assert.equal(B.monthDays('2026-09').at(-1), '2026-09-30')
      assert.deepEqual(B.monthDays('bad'), [])
      assert.deepEqual(B.monthRange('2026-12'), { from: '2026-12-01', to: '2026-12-31' })
      assert.equal(B.fmtMonthLabel('2026-09'), '2026年9月')
    })
    it('fmtCopyStamp は端末の時刻で M/D HH:MM（読めなければ空）', () => {
      const iso = new Date(2026, 8, 20, 9, 5).toISOString()
      assert.equal(B.fmtCopyStamp(iso), '9/20 09:05')
      assert.equal(B.fmtCopyStamp(null), '')
      assert.equal(B.fmtCopyStamp('x'), '')
    })
  })

  describe('validateBathInput（保存前の検証）', () => {
    const ok = (over = {}) => ({ bath_on: '2026-09-26', result: 'full', cancel_reason: null, note: null, ...over })
    it('全身浴・シャワー浴・部分浴は理由なしで通る', () => {
      for (const r of ['full', 'shower', 'partial']) assert.deepEqual(B.validateBathInput(ok({ result: r }), '2026-09-26'), { ok: true })
    })
    it('中止は理由が必須・「その他」は備考が必須（空白だけも不可）', () => {
      assert.equal(B.validateBathInput(ok({ result: 'cancel' }), '2026-09-26').ok, false)
      assert.equal(B.validateBathInput(ok({ result: 'cancel', cancel_reason: 'refusal' }), '2026-09-26').ok, true)
      assert.equal(B.validateBathInput(ok({ result: 'cancel', cancel_reason: 'other' }), '2026-09-26').ok, false)
      assert.equal(B.validateBathInput(ok({ result: 'cancel', cancel_reason: 'other', note: '　 ' }), '2026-09-26').ok, false)
      assert.equal(B.validateBathInput(ok({ result: 'cancel', cancel_reason: 'other', note: '内容' }), '2026-09-26').ok, true)
      assert.equal(B.validateBathInput(ok({ result: 'cancel', cancel_reason: 'x' }), '2026-09-26').ok, false)
    })
    it('中止以外に理由は付けられない', () => {
      assert.equal(B.validateBathInput(ok({ cancel_reason: 'condition' }), '2026-09-26').ok, false)
    })
    it('未来の日付・不正な区分・不正な日付は通らない', () => {
      assert.equal(B.validateBathInput(ok({ bath_on: '2026-09-27' }), '2026-09-26').ok, false)
      assert.equal(B.validateBathInput(ok({ result: 'x' }), '2026-09-26').ok, false)
      assert.equal(B.validateBathInput(ok({ bath_on: '2026/09/26' }), '2026-09-26').ok, false)
    })
  })

  describe('matchBathPlan（予定の source_id と名簿の突き合わせ）', () => {
    const roster = [
      { id: 1, source_id: 'M1' },
      { id: 2, source_id: 'M2' },
      { id: 3, source_id: '' },
    ]
    it('名簿に居る人だけを採り、居ない人は unmatched に数える（捨てて黙らない）', () => {
      const r = B.matchBathPlan(
        [
          { source_id: 'M2', start_time: '10:00', end_time: '15:00', hospitalized: true },
          { source_id: 'M9', start_time: '10:00', end_time: null, hospitalized: false },
          { source_id: 'M1', start_time: null, end_time: null, hospitalized: false },
          { source_id: 'M1', start_time: '09:00', end_time: null, hospitalized: false },
        ],
        roster,
      )
      assert.deepEqual(r.entries, [
        { residentId: 2, startTime: '10:00', endTime: '15:00', hospitalized: true },
        { residentId: 1, startTime: null, endTime: null, hospitalized: false },
      ])
      assert.equal(r.unmatched, 1)
    })
    it('source_id が null の行（写しはあるが予定なし）は数えない', () => {
      const r = B.matchBathPlan([{ source_id: null, start_time: null, end_time: null, hospitalized: false }], roster)
      assert.deepEqual(r, { entries: [], unmatched: 0 })
    })
  })

  describe('buildBathDayRows / countBathDay（予定と記録の突き合わせ・件数）', () => {
    // 居室順の名簿の並び: 3 → 1 → 2
    const order = [3, 1, 2]
    const plan = [
      { residentId: 1, startTime: '10:00', endTime: '15:00', hospitalized: false },
      { residentId: 2, startTime: '13:00', endTime: '15:00', hospitalized: true },
    ]
    it('予定 ∪ 記録 ∪ 予定外に足した人を、居室順に並べる（名簿に無い人は後ろ）', () => {
      const rows = B.buildBathDayRows(plan, [rec(10, 3, '2026-09-21', 'shower'), rec(11, 9, '2026-09-21', 'full')], [5], order)
      assert.deepEqual(
        rows.map((r) => r.residentId),
        [3, 1, 2, 5, 9],
      )
      const byId = Object.fromEntries(rows.map((r) => [r.residentId, r]))
      assert.equal(byId[3].planned, false, '予定外の記録')
      assert.equal(byId[3].record.result, 'shower')
      assert.equal(byId[1].planned, true)
      assert.equal(byId[1].record, null)
      assert.equal(byId[2].hospitalized, true)
      assert.equal(byId[5].planned, false)
      assert.equal(byId[5].record, null)
    })
    it('同じ人に記録が2件あれば新しい id の1件を出す', () => {
      const rows = B.buildBathDayRows([], [rec(12, 1, '2026-09-21', 'full'), rec(10, 1, '2026-09-21', 'cancel')], [], order)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].record.id, 12)
    })
    it('件数: 予定＝予定のある人（入院中を除く）／記録済み＝記録のある人（予定外も含む）／未記録＝予定があって記録が無い人（入院中を除く）', () => {
      // 利用者1（予定・記録なし）・利用者2（予定・入院中・記録なし）・利用者3（予定外・記録あり）・利用者4（予定外に足した）
      const rows = B.buildBathDayRows(plan, [rec(11, 3, '2026-09-21', 'partial')], [4], order)
      assert.deepEqual(B.countBathDay(rows), { planned: 1, recorded: 1, unrecorded: 1 })
      assert.deepEqual(B.countBathDay([]), { planned: 0, recorded: 0, unrecorded: 0 })
    })
    it('★入院中の方は予定があっても「未記録」に数えない（チーフ裁定 2026-09-26）。記録があれば記録済みに数える', () => {
      const rows = B.buildBathDayRows(plan, [], [], order)
      const byId = Object.fromEntries(rows.map((r) => [r.residentId, r]))
      assert.equal(B.isUnrecorded(byId[1]), true)
      assert.equal(B.isUnrecorded(byId[2]), false, '入院中を未記録にした')
      const withRec = B.buildBathDayRows(plan, [rec(12, 2, '2026-09-21', 'cancel')], [], order)
      assert.deepEqual(B.countBathDay(withRec), { planned: 1, recorded: 1, unrecorded: 1 })
    })
  })

  describe('aggregateBathMonth（月次集計）', () => {
    // 2026-09: 1日=火。月曜=7,14,21,28 ／ 水曜=2,9,16,23,30
    const planned = new Map([
      [0, new Set([1])], // 月曜に利用者1
      [2, new Set([2])], // 水曜に利用者2
    ])
    const base = { monthKey: '2026-09', order: [2, 1, 3], today: '2026-09-21', startDay: '2026-09-01' }

    it('マス: 記録は区分、予定の曜日で記録が無い日は今日まで「未」、今日より後は空', () => {
      const t = B.aggregateBathMonth({
        ...base,
        records: [rec(1, 1, '2026-09-07', 'full'), rec(2, 1, '2026-09-14', 'cancel')],
        plannedByWeekday: planned,
      })
      assert.equal(t.days.length, 30)
      const r1 = t.rows.find((r) => r.residentId === 1)
      assert.equal(r1.cells[6], 'full') // 7日
      assert.equal(r1.cells[13], 'cancel') // 14日
      assert.equal(r1.cells[20], 'missing') // 21日（今日・記録なし）
      assert.equal(r1.cells[27], null) // 28日（今日より後）
      assert.equal(r1.cells[0], null) // 1日（火・予定なし）
      assert.deepEqual(r1.totals, { billable: 1, partial: 0, cancel: 1, missing: 1 })
    })
    it('合計: 全＋シ（加算対象の見込み）・部・中を分けて数える', () => {
      const t = B.aggregateBathMonth({
        ...base,
        records: [
          rec(1, 2, '2026-09-02', 'full'),
          rec(2, 2, '2026-09-09', 'shower'),
          rec(3, 2, '2026-09-16', 'partial'),
          rec(4, 2, '2026-09-19', 'cancel'), // 予定外の日の記録も数える
        ],
        plannedByWeekday: planned,
      })
      const r2 = t.rows.find((r) => r.residentId === 2)
      assert.deepEqual(r2.totals, { billable: 2, partial: 1, cancel: 1, missing: 0 })
    })
    it('行は予定か記録がある人だけ・居室順（order の順）', () => {
      const t = B.aggregateBathMonth({ ...base, records: [rec(1, 3, '2026-09-05', 'full')], plannedByWeekday: planned })
      assert.deepEqual(
        t.rows.map((r) => r.residentId),
        [2, 1, 3],
      )
      const none = B.aggregateBathMonth({ ...base, records: [], plannedByWeekday: new Map() })
      assert.equal(none.rows.length, 0)
    })
    it('予定を取得できない（null）時は「未」を出さず、記録だけで行を作る', () => {
      const t = B.aggregateBathMonth({ ...base, records: [rec(1, 1, '2026-09-07', 'full')], plannedByWeekday: null })
      assert.deepEqual(
        t.rows.map((r) => r.residentId),
        [1],
      )
      assert.equal(t.rows[0].cells.includes('missing'), false)
    })
    it('★退居された方: その月に記録があれば行に出し（retired）、「未」は付けない。予定だけなら出さない（チーフ裁定 2026-09-26）', () => {
      const plannedWithRetired = new Map([
        [0, new Set([1, 3])], // 月曜に利用者1と、退居された利用者3（写しの遅れ等で予定に残っていても）
      ])
      const t = B.aggregateBathMonth({
        ...base,
        order: [2, 1, 3, 4],
        retiredIds: new Set([3, 4]),
        records: [rec(1, 3, '2026-09-07', 'shower')],
        plannedByWeekday: plannedWithRetired,
      })
      assert.deepEqual(
        t.rows.map((r) => [r.residentId, r.retired]),
        [
          [1, false],
          [3, true],
        ],
        '退居・記録なし（4）を出した、または退居・記録あり（3）を出していない',
      )
      const r3 = t.rows.find((r) => r.residentId === 3)
      assert.equal(r3.cells[6], 'shower')
      assert.equal(r3.cells.includes('missing'), false, '退居された方に「未」を付けた')
      assert.deepEqual(r3.totals, { billable: 1, partial: 0, cancel: 0, missing: 0 })
      assert.equal(t.hiddenRecords, 0)
    })
    it('★M2: 「未」は施設全体で記録を始めた日（startDay）以降だけ。その月の記録が0件でも予定日には付ける・startDay が無い時は付けない', () => {
      const recs = [rec(1, 1, '2026-09-14', 'full')]
      const t = B.aggregateBathMonth({ ...base, startDay: '2026-09-10', records: recs, plannedByWeekday: planned })
      const r1 = t.rows.find((r) => r.residentId === 1)
      assert.equal(r1.cells[6], null, '記録を始める前（7日）に「未」を付けた')
      assert.equal(r1.cells[13], 'full')
      assert.equal(r1.cells[20], 'missing', '記録を始めた後（21日）の「未」が無い')
      assert.equal(r1.totals.missing, 1)
      // その月の記録が0件でも、startDay 以降の予定日には「未」を付ける（記録の付け忘れの月を見逃さない）
      const empty = B.aggregateBathMonth({ ...base, records: [], plannedByWeekday: planned })
      const e1 = empty.rows.find((r) => r.residentId === 1)
      assert.equal(e1.cells[6], 'missing', '記録0件の月の予定日（7日）に「未」が無い')
      assert.equal(e1.cells[27], null, '今日より後（28日）に「未」を付けた')
      // 記録を始める前の月（startDay より前）には付けない
      const before = B.aggregateBathMonth({ ...base, monthKey: '2026-08', today: '2026-09-21', records: [], plannedByWeekday: planned })
      assert.equal(before.rows.flatMap((r) => r.cells).includes('missing'), false, '記録を始める前の月に「未」を付けた')
      const noStart = B.aggregateBathMonth({ ...base, startDay: null, records: recs, plannedByWeekday: planned })
      assert.equal(noStart.rows.flatMap((r) => r.cells).includes('missing'), false)
    })
    it('★M1: 現在入院中の方の行は「未」を付けず hospitalized=true（記録は出す）', () => {
      const t = B.aggregateBathMonth({
        ...base,
        hospitalizedIds: new Set([1]),
        records: [rec(1, 1, '2026-09-07', 'cancel')],
        plannedByWeekday: planned,
      })
      const r1 = t.rows.find((r) => r.residentId === 1)
      assert.equal(r1.hospitalized, true)
      assert.equal(r1.cells[6], 'cancel')
      assert.equal(r1.cells.includes('missing'), false, '入院中の方に「未」を付けた')
      assert.equal(t.rows.find((r) => r.residentId === 2).hospitalized, false)
    })
    it('名簿のどこにも居ない方の記録は行を作らず hiddenRecords に数える（無言で消さない）・月外の記録は数えない', () => {
      const t = B.aggregateBathMonth({
        ...base,
        records: [rec(1, 99, '2026-09-07', 'full'), rec(2, 1, '2026-08-31', 'full')],
        plannedByWeekday: null,
      })
      assert.equal(t.rows.length, 0)
      assert.equal(t.hiddenRecords, 1)
    })
  })

  describe('配線（静的検査）', () => {
    const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
    it('0012 に restrictive の member_only（care-backend と同じ形）があり、dayOfWeek は case で数にする', () => {
      const raw = read('../supabase/migrations/0012_bath_records.sql')
      assert.match(
        raw,
        /create policy member_only on public\.bath_records as restrictive for all to authenticated\s+using \(private\.is_member\(\)\) with check \(private\.is_member\(\)\);/,
      )
      assert.match(raw, /case when \(e\.v ->> 'dayOfWeek'\) ~ '\^\[0-6\]\$' then \(e\.v ->> 'dayOfWeek'\)::int end/)
      assert.match(raw, /bath_policies_4/)
    })
    it('移行ファイル 0012 は do $$ を使わず、Realtime は add table（set table ではない）', () => {
      // 注記（-- で始まる行の後ろ）は除いて、実際に流れる文だけを見る
      const sql = read('../supabase/migrations/0012_bath_records.sql')
        .split('\n')
        .map((l) => l.replace(/--.*$/, ''))
        .join('\n')
      assert.equal(/do\s+\$\$/i.test(sql), false)
      assert.match(sql, /alter publication supabase_realtime add table public\.bath_records;/)
      assert.equal(/alter publication supabase_realtime\s+set table/i.test(sql), false)
      assert.match(sql, /extract\(isodow from p_date\)::int - 1/)
      assert.match(sql, /revoke all on function public\.daycare_bath_plan\(date\) from public, anon;/)
    })
    it('App.tsx に /record/bath と /bath/month のルートと画面名がある', () => {
      const app = read('../src/App.tsx')
      assert.match(app, /path="\/record\/bath"/)
      assert.match(app, /path="\/bath\/month"/)
      assert.match(app, /'bathMonth'/)
      assert.match(app, /'入浴（デイ）'/)
    })
    it('記録ハブは入浴だけ input_enabled_bath で封鎖を判定する', () => {
      const hub = read('../src/pages/RecordHubPage.tsx')
      assert.match(hub, /getKindInputGate\('bath'\)/)
      // 2026-09-26 与薬チェックの追加で、与薬の旗（medLocked）が間に入った。入浴は bathLocked・その他は locked のまま
      assert.match(hub, /key === 'bath' \? bathLocked : key === 'med' \? medLocked : locked/)
    })
    it('月次表は表示中の月を保存しない（日付に紐づく状態＝原則11の既定。開くと常に今月）', () => {
      const page = read('../src/pages/BathMonthPage.tsx')
      assert.equal(/localStorage/.test(page.replace(/\/\/.*$/gm, '')), false)
      assert.match(page, /useState<string>\(current\)/)
      assert.equal(/cl_bathMonth/.test(read('../src/lib/types.ts')), false)
    })
  })
}
