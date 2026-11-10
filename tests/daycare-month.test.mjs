// デイ（せせらぎ）計画E: 月の実績の突き合わせ（予定と実績の差・休みの数・稼働率）の回帰テスト（2026-11-10）。
// 正本: 改善計画 v1 §3 の E・親の決め（定員 27・稼働率＝延べ来所 ÷（定員 × 営業日）・営業日＝予定のあった日・SQL なし）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycareMonth.ts）: 日ごとの数が今日の画面（buildDaycareBoard の counts）と同じ・恒等式
//    （延べ予定＝予定あり来所＋予定あり休み＋未記録＋今日の未到着／理由の合計＝休み）・営業日・稼働率と割合の丸め・
//    写しの無い日／読めなかった日／休業日／未来の日を数えない・入院中・予定外のみの日・予定0の日・予定の誤り・同じ方の2行・
//    月末（31日・うるう年の2月）・方ごとの並び（未記録の多い方が上・同じなら五十音）
// 2. db.ts を偽の Supabase で動かす（通信しない）: 月の出欠・予定の写しの絞り込み（月の範囲・取り消した行を除く）・上限に当たったら
//    数を出さない（例外）・読むだけ・月の形が違えば読まない
// 3. 静的検査: 月の画面は読むだけ（書き込み・購読・端末への保存・console なし）・読み込みは決めた4本・道・今日の画面の ?day=
// 個人情報は置かない（利用者は数値IDと「見本」のふりがなだけ）。

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
let M = null
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
  M = await import('../src/lib/daycareMonth.ts')
  DC = await import('../src/lib/daycare.ts')
  DB = await import('../src/lib/db.ts?daycare-month')
} catch (e) {
  loadError = e
  M = null
}

// ── 見本のデータ（氏名は持たない。ふりがなは並べ替えの見本） ──
const RES = [
  { id: 1, kana: 'あ見本' },
  { id: 2, kana: 'い見本' },
  { id: 3, kana: 'う見本' },
  { id: 4, kana: 'え見本' },
  { id: 5, kana: 'お見本' },
]
const planRow = (sched, residentId, over = {}) => ({
  sched_id: sched,
  event_id: `e-${sched}`,
  resident_id: residentId,
  match: 'mid',
  dup: false,
  external: false,
  hospitalized: false,
  start_time: '9:30',
  end_time: '15:30',
  bathing: false,
  bath_resident_id: null,
  plan_rev: 3,
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
})
let snapId = 1
const snap = (day, rows, source = rows.length > 0 ? 'kv' : 'none') => ({
  id: snapId++,
  day,
  plan_source: source,
  plan_rev: 3,
  plan_updated_at: null,
  plan_rows: rows,
  opened_by: null,
  created_at: null,
  rev: 1,
})
let attId = 100
const came = (day, residentId, over = {}) => ({
  id: attId++,
  resident_id: residentId,
  day,
  arrived_at: '09:30',
  left_at: '15:30',
  absent: false,
  absent_reason: null,
  note: null,
  recorded_by: 1,
  rev: 1,
  ...over,
})
const rest = (day, residentId, reason = 'condition', over = {}) =>
  came(day, residentId, { arrived_at: null, left_at: null, absent: true, absent_reason: reason, ...over })

/** 日ごとの数が今日の画面の counts（buildDaycareBoard）と同じか（数える日だけ） */
function assertSameAsDayScreen(report, snapshots, attendance) {
  for (const d of report.days) {
    if (d.kind !== 'counted') continue
    const s = snapshots.find((x) => x.day === d.day)
    const b = DC.buildDaycareBoard({ planRows: s.plan_rows, source: s.plan_source, residents: RES, attendance: attendance.filter((a) => a.day === d.day) })
    const c = b.counts
    assert.equal(d.planned, c.planned, `${d.day} 予定`)
    assert.equal(d.plannedCame + d.extraCame, c.present + c.left, `${d.day} 来所＝在席＋帰宅`)
    assert.equal(d.plannedAbsent + d.extraAbsent, c.absent, `${d.day} 休み`)
    assert.equal(d.unrecorded + d.waitingToday, c.waiting, `${d.day} 未記録＋未到着＝未到着`)
    assert.equal(d.hospitalized, c.hospitalized, `${d.day} 入院中`)
    assert.equal(d.unconfirmed, b.unconfirmed, `${d.day} 照合できない予定`)
    assert.equal(d.notInRoster, b.notInRoster, `${d.day} 名簿に無い方`)
  }
}

/** 恒等式（月と日と方の全部で） */
function assertIdentities(report) {
  const s = report.summary
  assert.equal(s.planned, s.plannedCame + s.plannedAbsent + s.unrecorded + s.waitingToday, '延べ予定＝予定あり来所＋予定あり休み＋未記録＋今日の未到着')
  for (const d of report.days) assert.equal(d.planned, d.plannedCame + d.plannedAbsent + d.unrecorded + d.waitingToday, `${d.day} の恒等式`)
  const reasonSum = M.DAYCARE_MONTH_REASONS.reduce((n, k) => n + s.reasons[k], 0)
  assert.equal(reasonSum, s.absent, '理由の合計（後で・理由なしを含む）＝休み')
  assert.equal(s.absent, s.plannedAbsent + s.extraAbsent)
  assert.equal(s.came, s.plannedCame + s.extraCame, '延べ来所＝予定あり来所＋予定外の来所')
  assert.equal(s.businessDays, report.days.filter((d) => d.business).length, '営業日数＝日ごとの営業日の印の数')
  assert.equal(s.unrecorded, report.persons.reduce((n, x) => n + x.unrecorded, 0), '方ごとの未記録の合計＝月の未記録')
  assert.equal(s.planned, report.persons.reduce((n, x) => n + x.planned, 0), '方ごとの予定の合計＝延べ予定')
  assert.equal(s.absent, report.persons.reduce((n, x) => n + x.absent, 0), '方ごとの休みの合計＝休み')
  for (const x of report.persons) {
    const r = M.DAYCARE_MONTH_REASONS.reduce((n, k) => n + x.reasons[k], 0)
    assert.equal(r, x.absent, `利用者ID ${x.residentId} の理由の合計＝休み`)
    assert.equal(x.unrecordedDays.length, x.unrecorded)
  }
}

if (M === null) {
  registerLoadFailure('デイ 計画E（月の実績）の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('純ロジック: 月の実績（2026-11-10 計画E）', () => {
    it('定員は 27（公開 LP の値）', () => {
      assert.equal(M.DAYCARE_CAPACITY, 27)
    })

    it('過去の月: 日ごとの数が今日の画面と同じ・予定あり／予定外・未記録・入院中・写しの無い日と読めなかった日は数えない', () => {
      const snapshots = [
        // 10/1（木）: 1・2・3 の予定。1 来所・2 休み（体調不良）・3 記録なし＝未記録。予定外の 4 が来所
        snap('2026-10-01', [planRow('a', 1), planRow('b', 2), planRow('c', 3)]),
        // 10/2: 1 は入院中（記録なし＝予定に数えない）・2 来所
        snap('2026-10-02', [planRow('a', 1, { hospitalized: true }), planRow('b', 2)]),
        // 10/4: 写しはあるが予定なし（none）。予定外の 5 だけ来所＝予定外のみの日
        snap('2026-10-04', []),
        // 10/5: 写しはあるが予定を読めなかった（unknown）。記録があっても数えない
        snap('2026-10-05', [], 'unknown'),
      ]
      const attendance = [
        came('2026-10-01', 1),
        rest('2026-10-01', 2, 'condition'),
        came('2026-10-01', 4),
        came('2026-10-02', 2),
        // 10/3: 写しが無い日の記録（数えずに数だけ見せる）
        came('2026-10-03', 1),
        rest('2026-10-03', 2, 'wish'),
        came('2026-10-04', 5),
        came('2026-10-05', 3),
      ]
      const r = M.buildDaycareMonth({ month: '2026-10', today: '2026-11-10', snapshots, attendance, residents: RES, closedDates: null })
      assert.equal(r.days.length, 31, '10月は31日')
      assert.equal(r.through, '2026-10-31', '過去の月は月末まで数える')
      assertSameAsDayScreen(r, snapshots, attendance)
      assertIdentities(r)
      const d = (day) => r.days.find((x) => x.day === day)
      assert.deepEqual(
        [d('2026-10-01').planned, d('2026-10-01').plannedCame, d('2026-10-01').plannedAbsent, d('2026-10-01').unrecorded, d('2026-10-01').extraCame],
        [3, 1, 1, 1, 1],
      )
      assert.equal(d('2026-10-01').business, true)
      // 入院中で記録の無い方は予定にも未記録にも入れない（今日の画面と同じ）
      assert.deepEqual([d('2026-10-02').planned, d('2026-10-02').hospitalized, d('2026-10-02').unrecorded], [1, 1, 0])
      // 写しの無い過去の日は数えない（今の曜日の型で作り直さない）。記録は数だけ見せる
      assert.equal(d('2026-10-03').kind, 'noSnapshot')
      assert.equal(d('2026-10-03').noSnapshot, 'missing')
      assert.deepEqual([d('2026-10-03').planned, d('2026-10-03').uncountedCame, d('2026-10-03').uncountedAbsent], [0, 1, 1])
      // 予定外のみの日は営業日ではないが、来所は延べ来所に入る
      assert.equal(d('2026-10-04').kind, 'counted')
      assert.deepEqual([d('2026-10-04').business, d('2026-10-04').extraCame], [false, 1])
      // 読めなかった写し（unknown）は写しなしと同じに数えない
      assert.equal(d('2026-10-05').kind, 'noSnapshot')
      assert.equal(d('2026-10-05').noSnapshot, 'unknown')
      assert.equal(d('2026-10-05').uncountedCame, 1)
      // 写しの無い日（10/3・10/5・10/6〜10/31）
      assert.equal(r.summary.noSnapshotDays, 28)
      assert.equal(r.summary.uncountedRecordDays, 2)
      const s = r.summary
      assert.deepEqual(
        [s.planned, s.plannedCame, s.plannedAbsent, s.extraCame, s.unrecorded, s.came, s.businessDays, s.hospitalized],
        [4, 2, 1, 2, 1, 4, 2, 1],
      )
      // 写しの無い日の休み（10/3 の本人の希望）は理由別に入らない
      assert.equal(s.reasons.wish, 0)
      assert.equal(s.reasons.condition, 1)
      // 稼働率＝延べ来所 4 ÷（27 × 営業日 2）＝ 7.4%（7.407…）・予定に対する来所の割合＝ 2 ÷ 4 ＝ 50.0%
      assert.equal(s.utilization10, 74)
      assert.equal(M.fmtRate10(s.utilization10), '7.4%')
      assert.equal(s.attendRate10, 500)
      assert.equal(M.fmtRate10(s.attendRate10), '50.0%')
    })

    it('今月: 今日までを数える（未来の日は写し・記録があっても数えない）。今日のまだの方は未記録でなく今日の未到着', () => {
      const snapshots = [
        snap('2026-11-09', [planRow('a', 1), planRow('b', 2)]),
        snap('2026-11-10', [planRow('a', 1), planRow('b', 2)]),
        // 未来の日の写し（作られない形だが、来ても数えない）
        snap('2026-11-11', [planRow('a', 1)]),
      ]
      const attendance = [came('2026-11-09', 1), came('2026-11-10', 1), came('2026-11-11', 2)]
      const r = M.buildDaycareMonth({ month: '2026-11', today: '2026-11-10', snapshots, attendance, residents: RES, closedDates: null })
      assert.equal(r.through, '2026-11-10')
      assert.equal(r.summary.futureDays, 20)
      assertSameAsDayScreen(r, snapshots, attendance)
      assertIdentities(r)
      const d10 = r.days.find((x) => x.day === '2026-11-10')
      assert.deepEqual([d10.isToday, d10.unrecorded, d10.waitingToday], [true, 0, 1])
      const d9 = r.days.find((x) => x.day === '2026-11-09')
      assert.equal(d9.unrecorded, 1, '昨日のまだの方は未記録')
      const d11 = r.days.find((x) => x.day === '2026-11-11')
      assert.deepEqual([d11.kind, d11.planned, d11.business], ['future', 0, false])
      assert.equal(d11.uncountedCame, 1)
      assert.deepEqual([r.summary.planned, r.summary.came, r.summary.businessDays, r.summary.unrecorded, r.summary.waitingToday], [4, 2, 2, 1, 1])
      // 今日のまだの方（2）は今日の未到着、昨日のまだの方（2）は未記録（同じ方）
      const p2 = r.persons.find((x) => x.residentId === 2)
      assert.deepEqual([p2.unrecorded, p2.waitingToday, p2.unrecordedDays], [1, 1, ['2026-11-09']])
      // 今日の写しがまだ無い日は「写しなし」（今日の画面は今の週間計画で出すが、月の画面は数えない）
      const r2 = M.buildDaycareMonth({ month: '2026-11', today: '2026-11-10', snapshots: snapshots.slice(0, 1), attendance: [], residents: RES, closedDates: null })
      const t = r2.days.find((x) => x.day === '2026-11-10')
      assert.deepEqual([t.kind, t.noSnapshot, t.isToday], ['noSnapshot', 'missing', true])
    })

    it('休業日: 写しがあっても数えない（予定を未記録にしない）。記録は数だけ見せる。写しの無い休業日は「写しなし」でなく休業日', () => {
      const snapshots = [snap('2026-12-30', [planRow('a', 1), planRow('b', 2)]), snap('2026-12-31', [planRow('a', 1), planRow('b', 2)])]
      const attendance = [came('2026-12-30', 1), came('2026-12-30', 2), came('2026-12-31', 1)]
      const r = M.buildDaycareMonth({ month: '2026-12', today: '2027-01-05', snapshots, attendance, residents: RES, closedDates: '12-31, 01-01,2026-12-29' })
      const d = (day) => r.days.find((x) => x.day === day)
      assert.equal(d('2026-12-31').kind, 'closed')
      assert.deepEqual([d('2026-12-31').planned, d('2026-12-31').unrecorded, d('2026-12-31').business, d('2026-12-31').uncountedCame], [0, 0, false, 1])
      // 'YYYY-MM-DD' の休業日も同じ（写しなしの日でも休業日として出す）
      assert.equal(d('2026-12-29').kind, 'closed')
      assert.equal(d('2026-12-29').noSnapshot, null)
      assert.equal(d('2026-12-30').kind, 'counted')
      assert.equal(r.summary.closedDays, 2)
      assert.deepEqual([r.summary.planned, r.summary.came, r.summary.businessDays, r.summary.unrecorded], [2, 2, 1, 0])
      assertIdentities(r)
      // 休業日の設定が無い（読めない）時は休業日を分けない（写しがあれば数える）
      const r2 = M.buildDaycareMonth({ month: '2026-12', today: '2027-01-05', snapshots, attendance, residents: RES, closedDates: null })
      assert.equal(r2.days.find((x) => x.day === '2026-12-31').kind, 'counted')
      assert.equal(r2.summary.unrecorded, 1)
    })

    it('休みの理由: 6つの理由と「理由は後で」「理由なし（知らない値）」の合計が休みの数と一致する。予定外の方の休みも入る', () => {
      const snapshots = [snap('2026-09-01', [planRow('a', 1), planRow('b', 2), planRow('c', 3), planRow('d', 4)])]
      const attendance = [
        rest('2026-09-01', 1, 'hospital'),
        rest('2026-09-01', 2, 'later'),
        rest('2026-09-01', 3, null),
        rest('2026-09-01', 4, 'family'),
        // 予定外の方を足して休みにした（今日の画面の counts.absent に入る）
        rest('2026-09-01', 5, 'other'),
      ]
      const r = M.buildDaycareMonth({ month: '2026-09', today: '2026-11-10', snapshots, attendance, residents: RES, closedDates: null })
      assertSameAsDayScreen(r, snapshots, attendance)
      assertIdentities(r)
      const s = r.summary
      assert.deepEqual(
        [s.reasons.condition, s.reasons.hospital, s.reasons.wish, s.reasons.family, s.reasons.other, s.reasons.later, s.reasons.none],
        [0, 1, 0, 1, 1, 1, 1],
      )
      assert.deepEqual([s.plannedAbsent, s.extraAbsent, s.absent], [4, 1, 5])
      // 来所が0・予定4 → 割合 0.0%・稼働率 0.0%（営業日1）
      assert.equal(M.fmtRate10(s.attendRate10), '0.0%')
      assert.equal(M.fmtRate10(s.utilization10), '0.0%')
      assert.equal(M.reasonsShort(r.persons.find((x) => x.residentId === 2).reasons, { condition: '体調', hospital: '受診', wish: '希望', family: '家族', other: '他', later: '後で', none: 'なし' }), '後で1')
    })

    it('予定の誤り（週間計画に2件・同じ日に予定が2件）は要確認に数え、予定は1人1回。照合できない予定・名簿に無い方は予定に入れない', () => {
      const snapshots = [
        snap('2026-08-03', [
          planRow('a', 1, { dup: true }),
          planRow('b', 2, { start_time: '9:30', end_time: '12:00' }),
          planRow('b', 2, { event_id: 'e-b2', start_time: '13:00', end_time: '15:30' }),
          planRow('m', null, { match: 'mismatch' }),
          planRow('x', null, { match: 'external', external: true }),
        ]),
      ]
      const attendance = [came('2026-08-03', 1)]
      const r = M.buildDaycareMonth({ month: '2026-08', today: '2026-11-10', snapshots, attendance, residents: RES, closedDates: null })
      assertSameAsDayScreen(r, snapshots, attendance)
      assertIdentities(r)
      const d = r.days.find((x) => x.day === '2026-08-03')
      assert.deepEqual([d.planned, d.planWarn, d.unconfirmed, d.notInRoster, d.plannedCame, d.unrecorded], [2, 2, 1, 1, 1, 1])
    })

    it('同じ方・同じ日の2行は今日の画面と同じく id の大きい方（取り消した行は DB で除いてから渡す）', () => {
      const snapshots = [snap('2026-07-01', [planRow('a', 1)])]
      const older = rest('2026-07-01', 1, 'condition', { id: 10 })
      const newer = came('2026-07-01', 1, { id: 11 })
      const r = M.buildDaycareMonth({ month: '2026-07', today: '2026-11-10', snapshots, attendance: [newer, older], residents: RES, closedDates: null })
      assert.deepEqual([r.summary.plannedCame, r.summary.plannedAbsent], [1, 0])
      // 時刻を消した行（到着の取り消し）は記録なし＝未記録。予定外で中身の無い行は数えない
      const cleared = came('2026-07-01', 1, { arrived_at: null, left_at: null })
      const emptyExtra = came('2026-07-01', 2, { arrived_at: null, left_at: null })
      const r2 = M.buildDaycareMonth({ month: '2026-07', today: '2026-11-10', snapshots, attendance: [cleared, emptyExtra], residents: RES, closedDates: null })
      assert.deepEqual([r2.summary.unrecorded, r2.summary.extraCame, r2.summary.extraAbsent, r2.persons.length], [1, 0, 0, 1])
      assertIdentities(r2)
    })

    it('予定0の日・営業日0の月: 稼働率も割合も出さない（0 で割らない＝null・「—」）', () => {
      const snapshots = [snap('2026-06-01', []), snap('2026-06-02', [planRow('a', 1, { hospitalized: true })])]
      const r = M.buildDaycareMonth({ month: '2026-06', today: '2026-11-10', snapshots, attendance: [], residents: RES, closedDates: null })
      assert.equal(r.summary.businessDays, 0, '入院中の方だけの日は予定0＝営業日でない')
      assert.equal(r.summary.utilization10, null)
      assert.equal(r.summary.attendRate10, null)
      assert.equal(M.fmtRate10(r.summary.utilization10), '—')
      assert.equal(r.persons.find((x) => x.residentId === 1).hospitalized, 1)
      assertIdentities(r)
    })

    it('月末: 31日の月・30日の月・うるう年の2月（29日）・平年の2月（28日）。先の月は数える日なし・形の違う月は null', () => {
      const len = (m) => M.buildDaycareMonth({ month: m, today: '2030-01-01', snapshots: [], attendance: [], residents: RES, closedDates: null }).days.length
      assert.deepEqual([len('2026-10'), len('2026-11'), len('2028-02'), len('2026-02'), len('2100-02')], [31, 30, 29, 28, 28])
      const leap = M.buildDaycareMonth({
        month: '2028-02',
        today: '2028-03-01',
        snapshots: [snap('2028-02-29', [planRow('a', 1)])],
        attendance: [came('2028-02-29', 1)],
        residents: RES,
        closedDates: null,
      })
      assert.equal(leap.through, '2028-02-29')
      assert.deepEqual([leap.summary.businessDays, leap.summary.came], [1, 1])
      // 他の月の行が混ざっても数えない
      const other = M.buildDaycareMonth({ month: '2028-02', today: '2028-03-01', snapshots: [snap('2028-03-01', [planRow('a', 1)])], attendance: [came('2028-03-01', 1)], residents: RES, closedDates: null })
      assert.deepEqual([other.summary.businessDays, other.summary.came], [0, 0])
      const fut = M.buildDaycareMonth({ month: '2026-12', today: '2026-11-10', snapshots: [], attendance: [], residents: RES, closedDates: null })
      assert.equal(fut.through, null)
      assert.equal(fut.summary.futureDays, 31)
      assert.equal(M.buildDaycareMonth({ month: '2026-13', today: '2026-11-10', snapshots: [], attendance: [], residents: RES, closedDates: null }), null)
      assert.equal(M.buildDaycareMonth({ month: '2026/11', today: '2026-11-10', snapshots: [], attendance: [], residents: RES, closedDates: null }), null)
    })

    it('方ごとの並び: 未記録の多い方が上・同じなら五十音（ふりがな）。開く日は最後の未記録の日（無ければ最後に出てきた日）', () => {
      const snapshots = [
        snap('2026-05-01', [planRow('a', 1), planRow('b', 2), planRow('c', 3), planRow('d', 4)]),
        snap('2026-05-02', [planRow('a', 1), planRow('b', 2), planRow('c', 3), planRow('d', 4)]),
      ]
      const attendance = [came('2026-05-01', 1), came('2026-05-02', 1), rest('2026-05-02', 3), came('2026-05-01', 4)]
      const r = M.buildDaycareMonth({ month: '2026-05', today: '2026-11-10', snapshots, attendance, residents: RES, closedDates: null })
      // 2: 未記録2・3: 未記録1・4: 未記録1・1: 未記録0（3 と 4 はふりがな順）
      assert.deepEqual(
        r.persons.map((x) => [x.residentId, x.unrecorded]),
        [
          [2, 2],
          [3, 1],
          [4, 1],
          [1, 0],
        ],
      )
      assert.deepEqual(r.persons[0].unrecordedDays, ['2026-05-01', '2026-05-02'])
      assert.equal(r.persons.find((x) => x.residentId === 3).openDay, '2026-05-01', '最後の未記録の日')
      assert.equal(r.persons.find((x) => x.residentId === 1).openDay, '2026-05-02', '最後に出てきた日')
      assertIdentities(r)
    })

    it('割合の丸め: 0.1% 単位で四捨五入（小数の掛け算の端数を作らない）・表示は小数1桁', () => {
      assert.equal(M.rate10(1, 8), 125)
      assert.equal(M.rate10(6545, 10000), 655, '65.45% は 65.5%')
      assert.equal(M.rate10(2, 3), 667)
      assert.equal(M.rate10(1, 2000), 1, '0.05% は 0.1%')
      assert.equal(M.rate10(1, 0), null)
      assert.equal(M.rate10(0, 0), null)
      assert.equal(M.fmtRate10(667), '66.7%')
      assert.equal(M.fmtRate10(5), '0.5%')
      assert.equal(M.fmtRate10(1000), '100.0%')
      assert.equal(M.fmtRate10(1234), '123.4%', '予定外の来所が多い月は 100% を超えうる（そのまま出す）')
      // 稼働率の式: 延べ来所 486 ÷（27 × 20）＝ 90.0%
      assert.equal(M.fmtRate10(M.rate10(486, 27 * 20)), '90.0%')
    })

    it('道: 月は ?m=（今月は付けない）・今日の画面のその日は ?day=（今日は付けない）', () => {
      assert.equal(M.daycareMonthPath('2026-11', '2026-11'), '/record/daycare/month')
      assert.equal(M.daycareMonthPath('2026-10', '2026-11'), '/record/daycare/month?m=2026-10')
      assert.equal(M.daycareDayPath('2026-11-10', '2026-11-10'), '/record/daycare')
      assert.equal(M.daycareDayPath('2026-11-03', '2026-11-10'), '/record/daycare?day=2026-11-03')
    })
  })

  // ════════════════════════════════════════════════════════════
  // 2. db.ts（偽の Supabase・通信しない）
  // ════════════════════════════════════════════════════════════
  describe('db.ts: 月の出欠・予定の写しの読み取り（読むだけ・取り消した行を除く・上限で数を出さない）', () => {
    const fake = (state) => {
      const builder = (table) => {
        const q = { table, cols: null, filters: [], limit: null, action: 'select', orders: [] }
        const hit = (r) =>
          q.filters.every(([op, k, v]) => (op === 'gte' ? r[k] >= v : op === 'lte' ? r[k] <= v : op === 'is' ? (r[k] ?? null) === v : op === 'eq' ? r[k] === v : true))
        const run = () => {
          state.calls.push(q)
          if (state.fail) return { data: null, error: { message: 'timeout', code: '' }, status: 0 }
          const rows = (state[table] ?? []).filter(hit).slice(0, q.limit ?? undefined)
          return { data: rows.map((r) => ({ ...r })), error: null, status: 200 }
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
          gte(k, v) {
            q.filters.push(['gte', k, v])
            return b
          },
          lte(k, v) {
            q.filters.push(['lte', k, v])
            return b
          },
          is(k, v) {
            q.filters.push(['is', k, v])
            return b
          },
          eq(k, v) {
            q.filters.push(['eq', k, v])
            return b
          },
          order(k) {
            q.orders.push(k)
            return b
          },
          limit(n) {
            q.limit = n
            return b
          },
          then(ok, ng) {
            return Promise.resolve(run()).then(ok, ng)
          },
        }
        return b
      }
      return {
        from: builder,
        rpc: () => {
          throw new Error('rpc を呼ばない')
        },
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
    const row = (id, day, over = {}) => ({ ...came(day, 1, { id }), deleted_at: null, client_key: `k${id}`, ...over })

    it('出欠: その月の範囲（うるう年の2月は 29日まで）・取り消した行を除く・0041 の列・上限 2000・読むだけ', async () => {
      const state = {
        calls: [],
        daycare_attendance: [
          row(1, '2028-01-31'),
          row(2, '2028-02-01'),
          row(3, '2028-02-29'),
          row(4, '2028-02-15', { deleted_at: '2028-02-15T03:00:00Z' }),
          row(5, '2028-03-01'),
        ],
      }
      await withDb(state, async () => {
        const rows = await DB.fetchDaycareAttendanceMonth('2028-02')
        assert.deepEqual(
          rows.map((r) => r.id),
          [2, 3],
        )
        assert.equal(state.calls.length, 1, '1回の読み取り')
        const q = state.calls[0]
        assert.equal(q.table, 'daycare_attendance')
        assert.equal(q.cols, 'id,resident_id,day,arrived_at,left_at,absent,absent_reason,note,recorded_by,rev')
        assert.deepEqual(q.filters, [
          ['gte', 'day', '2028-02-01'],
          ['lte', 'day', '2028-02-29'],
          ['is', 'deleted_at', null],
        ])
        assert.equal(q.limit, 2000)
        assert.ok(state.calls.every((c) => c.action === 'select'), '読むだけ')
        // 端末に持ち出さない列（client_key）は返さない
        assert.equal('client_key' in rows[0], false)
      })
    })

    it('予定の写し: その月の範囲・全列（予定の行を含む）・上限 2000', async () => {
      const state = {
        calls: [],
        daycare_days: [
          { ...snap('2026-10-31', [planRow('a', 1)]) },
          { ...snap('2026-11-01', [planRow('a', 1), planRow('b', 2)]) },
          { ...snap('2026-11-30', [], 'none') },
          { ...snap('2026-12-01', [planRow('a', 1)]) },
        ],
      }
      await withDb(state, async () => {
        const rows = await DB.fetchDaycareDaysMonth('2026-11')
        assert.deepEqual(
          rows.map((r) => [r.day, r.plan_source, r.plan_rows.length]),
          [
            ['2026-11-01', 'kv', 2],
            ['2026-11-30', 'none', 0],
          ],
        )
        const q = state.calls[0]
        assert.equal(q.table, 'daycare_days')
        assert.match(q.cols, /plan_source/)
        assert.match(q.cols, /plan_rows/)
        assert.deepEqual(q.filters, [
          ['gte', 'day', '2026-11-01'],
          ['lte', 'day', '2026-11-30'],
        ])
        assert.equal(q.limit, 2000)
      })
    })

    it('上限に当たった時: 読み切れていない＝「読み切れませんでした」で止める（数を出さない）。少なければ通す', async () => {
      const many = Array.from({ length: 2000 }, (_, i) => row(i + 1, '2026-10-15', { resident_id: i + 1 }))
      await withDb({ calls: [], daycare_attendance: many }, async () => {
        await assert.rejects(() => DB.fetchDaycareAttendanceMonth('2026-10'), (e) => e instanceof DB.DbError && /読み切れませんでした/.test(e.message))
      })
      await withDb({ calls: [], daycare_attendance: many.slice(0, 1999) }, async () => {
        assert.equal((await DB.fetchDaycareAttendanceMonth('2026-10')).length, 1999)
      })
      const days = Array.from({ length: 2000 }, (_, i) => ({ ...snap('2026-10-15', []), id: i + 1 }))
      await withDb({ calls: [], daycare_days: days }, async () => {
        await assert.rejects(() => DB.fetchDaycareDaysMonth('2026-10'), (e) => e instanceof DB.DbError && /読み切れませんでした/.test(e.message))
      })
    })

    it('月の形が違えば読まない・通信できない時は例外（画面は数を出さない）', async () => {
      const state = { calls: [], daycare_attendance: [] }
      await withDb(state, async () => {
        await assert.rejects(() => DB.fetchDaycareAttendanceMonth('2026-13'))
        await assert.rejects(() => DB.fetchDaycareDaysMonth('2026/11'))
        assert.equal(state.calls.length, 0)
      })
      await withDb({ calls: [], fail: true }, async () => {
        await assert.rejects(() => DB.fetchDaycareAttendanceMonth('2026-11'))
        await assert.rejects(() => DB.fetchDaycareDaysMonth('2026-11'))
      })
    })
  })

  // ════════════════════════════════════════════════════════════
  // 3. 静的検査（月の画面の規律・道・今日の画面の ?day=）
  // ════════════════════════════════════════════════════════════
  describe('静的検査（計画E の規律）', () => {
    const page = code('../src/pages/DaycareMonthPage.tsx')
    const app = code('../src/App.tsx')
    const today = code('../src/pages/DaycarePage.tsx')
    const lib = read('../src/lib/daycareMonth.ts')

    it('月の画面は読むだけ: 書き込み・購読・端末への保存・console・supabase の直呼びが無い', () => {
      assert.doesNotMatch(page, /\b(save|insert|update|delete|softDelete|upsert|discard|stage|queue|open)[A-Z]\w*\(/)
      assert.doesNotMatch(page, /subscribe\w*\(/)
      assert.doesNotMatch(page, /localStorage|sessionStorage|console\./)
      assert.doesNotMatch(page, /supabase\.(from|rpc)\(|from '\.\.\/lib\/supabase'/)
    })

    it('1回の読み込みは4本（名簿・休業日の設定・月の写し・月の出欠）。db.ts から読むのはこの3つと DbError だけ', () => {
      const m = /import \{([^}]*)\} from '\.\.\/lib\/db'/.exec(page)
      assert.ok(m !== null)
      assert.deepEqual(
        m[1]
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x !== '')
          .sort(),
        ['DbError', 'fetchDaycareAttendanceMonth', 'fetchDaycareDaysMonth', 'getAppSetting'],
      )
      const load = page.slice(page.indexOf('Promise.all(['), page.indexOf('.then(([residents, closed, snapshots, attendance])'))
      assert.deepEqual(load.match(/\b(fetch\w+|getAppSetting)\(/g), ['fetchAllResidents(', "getAppSetting(", 'fetchDaycareDaysMonth(', 'fetchDaycareAttendanceMonth('])
      assert.match(load, /getAppSetting\('daycare_closed_dates'\)/)
    })

    it('数え方は純関数（buildDaycareMonth）・現在地の月は URL の ?m=（parseMonthKey で不正値・先の月は今月）', () => {
      assert.match(page, /buildDaycareMonth\(\{ month, today, snapshots, attendance, residents, closedDates: closed\.v \}\)/)
      assert.match(page, /const month = parseMonthKey\(search\.get\('m'\), currentMonth\) \?\? currentMonth/)
      assert.match(lib, /export const DAYCARE_CAPACITY = 27/)
      assert.match(lib, /公開 LP の値。指定申請上の利用定員とは突き合わせていない。\s*\n\s*\* 変わる時は PR で直す/)
      // 稼働率の式を添える・未記録は ▲ と文字（色だけにしない）
      assert.match(page, /延べ来所 \$\{s\.came\} ÷（定員 \$\{s\.capacity\} × 営業日 \$\{s\.businessDays\}）/)
      assert.match(page, /<span aria-hidden="true">▲<\/span>未記録 /)
      // 上限に当たった時・読めない時は前の数も消す
      assert.match(page, /\.catch\(\(e: unknown\) => \{\s*if \(!alive\) return\s*setData\(null\)/)
    })

    it('道・画面名・遅延読込（App.tsx）', () => {
      assert.match(app, /const loadDaycareMonthPage = \(\) => import\('\.\/pages\/DaycareMonthPage'\)/)
      assert.match(app, /<Route path="\/record\/daycare\/month" element=\{<DaycareMonthPage \/>\} \/>/)
      assert.match(app, /if \(pathname === '\/record\/daycare\/month'\) return 'デイ 月の実績'/)
    })

    it('置き場: 今日の画面の一番下の〔連絡帳〕の隣（表示している日の月）。上の切り替え・日付の段・件数の帯には足さない（1180px で見出しの段が折れる＝実測）', () => {
      const add = today.indexOf('＋ 予定にない方を追加')
      const contact = today.indexOf('to={contactPath(day, today)}')
      const month = today.indexOf('to={daycareMonthPath(day.slice(0, 7), today.slice(0, 7))}')
      assert.ok(add > 0 && contact > add && month > contact, '〔月の実績〕は〔連絡帳〕の後')
      assert.match(today.slice(month, today.indexOf('</Link>', month)), /min-h-tap[\s\S]*>\s*月の実績\s*$/)
      const nav = today.slice(today.indexOf('export function DaycareNav'), today.indexOf('function PlanBanners'))
      assert.doesNotMatch(nav, /month|月の実績/)
      const header = today.slice(today.indexOf('const header = (counts'), today.indexOf('if (loading && data === null)'))
      assert.doesNotMatch(header, /月の実績|daycareMonthPath/)
    })

    it('今日の画面は ?day= を開いた時の1回だけ読む（readPersonDay）・URL から外す（日付の切り替えは URL に書かない）', () => {
      assert.match(today, /const \[day, setDay\] = useState\(\(\) => readPersonDay\(search\.get\('day'\), todayIso\(\)\)\)/)
      assert.match(today, /next\.delete\('day'\)/)
      assert.equal((today.match(/setSearch\(/g) ?? []).length, 1, 'URL を書くのは ?day= を外す1か所だけ')
    })
  })
}
