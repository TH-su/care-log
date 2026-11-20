// 日報の出勤者の欄の自動入力・苗字の表示・未読の人の赤い氏名枠（2026-11-19 代表者の指示）の試験。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 自動入力の対象と時刻（src/lib/attendanceAuto.ts の planAutoAttendance）: 今日の日報だけ・施設の勤務の日勤か夜勤入り・
//    出勤時刻の30分前から・時刻が分からない時は 0:00・足すだけ（既にある行は取り消し済みも除く）・施設長の役割・並び・突き合わない人は入れない
// 2. 苗字の表示（attendDisplayNames）: 苗字で出し、同じ苗字が2人以上の時はその人たちだけ氏名
// 3. 赤い氏名枠（attendRedDays）: 今日の日報だけ・前日までの未読の日がある・出勤時刻（30分前ではない）以降・出勤者の欄にいる人だけ
// 4. db.ts の autoAddAttendance を偽の Supabase で動かす（通信しない）: 主キーへの ON CONFLICT DO NOTHING・入った行だけ返す・
//    施設長の索引に当たったら職員として足し直す・送れない時は null（送信待ちに積まない）・封鎖中は送らない
// 5. 静的検査: 画面の配線（今日の日報だけ・手で足す保存と同じ列）・赤い枠と窓は画面だけ・読み上げは氏名・個人情報を出さない
// 個人情報は置かない（職員01 などの見本の名前と数値IDだけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
/** 行コメントと複数行コメントを除いた本文 */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const lsStore = new Map()
let A = null
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
  A = await import('../src/lib/attendanceAuto.ts')
  DB = await import('../src/lib/db.ts?attendance-auto')
} catch (e) {
  loadError = e
  A = null
}

if (A === null) {
  registerLoadFailure('出勤者の自動入力と赤い氏名枠の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  const F = (o) => ({ work: false, nightIn: false, unknown: false, workStart: null, nightStart: null, ...o })
  const today = '2026-12-01'
  const staff = [
    { id: 1, name: '早番 見本01', active: true },
    { id: 2, name: '遅番 見本02', active: true },
    { id: 3, name: '夜勤 見本03', active: true },
    { id: 4, name: '休み 見本04', active: true },
    { id: 5, name: '施設長 見本05', active: true },
    { id: 6, name: '時刻なし 見本06', active: true },
    { id: 7, name: '退職 見本07', active: false },
    { id: 8, name: '名簿外 見本08', active: true },
  ]
  // 勤務表の氏名の鍵（nameKey＝空白を除く）→ 施設の勤務
  const duty = new Map([
    ['早番見本01', F({ work: true, workStart: 7 * 60 })],
    ['遅番見本02', F({ work: true, workStart: 11 * 60 })],
    ['夜勤見本03', F({ nightIn: true, nightStart: 21 * 60 })],
    ['休み見本04', F({})],
    ['施設長見本05', F({ work: true, workStart: 9 * 60 })],
    ['時刻なし見本06', F({ work: true })],
    ['退職見本07', F({ work: true, workStart: 7 * 60 })],
  ])
  const plan = (nowMin, extra = {}) =>
    A.planAutoAttendance({ day: today, today, nowMin, staff, duty, existing: [], managerStaffId: 5, ...extra })
  const ids = (rows) => rows.map((r) => r.staff_id)

  describe('出勤者の欄の自動入力（今日の日報だけ・出勤時刻の30分前から）', () => {
    it('出勤時刻: 日勤は workStart・夜勤は nightStart・両方あれば早い方・分からない時は 0:00・勤務が無ければ null', () => {
      assert.equal(A.attendStartMin(F({ work: true, workStart: 420 })), 420)
      assert.equal(A.attendStartMin(F({ nightIn: true, nightStart: 1260 })), 1260)
      assert.equal(A.attendStartMin(F({ work: true, workStart: 600, nightIn: true, nightStart: 1320 })), 600)
      assert.equal(A.attendStartMin(F({ work: true, nightIn: true, nightStart: 1320 })), 0, '日勤の時刻が分からない＋夜勤 22:00 は 0:00（早い方）')
      assert.equal(A.attendStartMin(F({ work: true })), 0)
      assert.equal(A.attendStartMin(F({})), null)
      assert.equal(A.attendStartMin(undefined), null)
    })
    it('対象は施設の勤務で日勤の部分か夜勤入りがある人だけ・30分前を過ぎた人から（早番 7:00 → 6:30・遅番 11:00 → 10:30・夜勤 21:00 → 20:30）', () => {
      assert.deepEqual(ids(plan(0)), [6], '0時: 時刻が分からない人は今日の0時から')
      assert.deepEqual(ids(plan(6 * 60 + 29)), [6])
      assert.deepEqual(ids(plan(6 * 60 + 30)), [6, 1])
      assert.deepEqual(ids(plan(10 * 60 + 29)), [6, 1, 5])
      assert.deepEqual(ids(plan(10 * 60 + 30)), [6, 1, 5, 2])
      assert.deepEqual(ids(plan(20 * 60 + 29)), [6, 1, 5, 2])
      assert.deepEqual(ids(plan(20 * 60 + 30)), [6, 1, 5, 2, 3])
      assert.equal(ids(plan(23 * 60)).includes(4), false, '休みの人は入れない')
    })
    it('今日でない日・勤務表が読めない時は何も足さない', () => {
      assert.deepEqual(A.planAutoAttendance({ day: '2026-11-30', today, nowMin: 1439, staff, duty, existing: [], managerStaffId: 5 }), [])
      assert.deepEqual(A.planAutoAttendance({ day: '2026-12-02', today, nowMin: 1439, staff, duty, existing: [], managerStaffId: 5 }), [])
      assert.deepEqual(A.planAutoAttendance({ day: today, today, nowMin: 1439, staff, duty: null, existing: [], managerStaffId: 5 }), [])
    })
    it('名簿の突き合わせ: 勤務表に名前が無い人・在籍でない人・同じ氏名の職員が2人いる人は入れない', () => {
      const all = ids(plan(1439))
      assert.equal(all.includes(8), false, '勤務表に名前が無い')
      assert.equal(all.includes(7), false, '在籍でない')
      const dup = [...staff, { id: 9, name: '早番　見本01', active: true }]
      assert.equal(ids(plan(1439, { staff: dup })).some((id) => id === 1 || id === 9), false, '同じ氏名の鍵が2人＝取り違えるので入れない')
    })
    it('足すだけ: その日・その職員の行が既にあれば入れない（取り消し済み＝sort < 0 の行も含む＝人が外した人を戻さない）。人が足した人はそのまま', () => {
      const existing = [
        { staff_id: 1, role: 'staff', sort: -1 },
        { staff_id: 8, role: 'staff', sort: 0 },
        { staff_id: 2, role: 'staff', sort: 1 },
      ]
      const rows = plan(1439, { existing })
      assert.deepEqual(ids(rows), [6, 5, 3])
      assert.equal(rows.some((r) => r.staff_id === 8), false)
    })
    it('この画面で一度送った人（skip）は送り直さない', () => {
      assert.deepEqual(ids(plan(1439, { skip: new Set([6, 3]) })), [1, 5, 2])
    })
    it('並び: 既存の sort の最大＋1 から、出勤時刻の早い順', () => {
      const rows = plan(1439, { existing: [{ staff_id: 8, role: 'staff', sort: 4 }, { staff_id: 4, role: 'staff', sort: -1 }] })
      assert.deepEqual(rows.map((r) => [r.staff_id, r.sort]), [[6, 5], [1, 6], [5, 7], [2, 8], [3, 9]])
      assert.deepEqual(plan(1439).map((r) => r.sort), [0, 1, 2, 3, 4], '行が無い日は 0 から')
      assert.deepEqual(plan(1439, { existing: [{ staff_id: 4, role: 'staff', sort: -1 }] }).map((r) => r.sort)[0], 0, '取り消した行だけの日も 0 から')
    })
    it('施設長の役割: 設定の施設長で、その日にまだ施設長の行（manager・sort >= 0）が無ければ manager・それ以外は staff', () => {
      const roleOf = (rows, id) => rows.find((r) => r.staff_id === id)?.role
      assert.equal(roleOf(plan(1439), 5), 'manager')
      assert.equal(roleOf(plan(1439), 1), 'staff')
      assert.equal(roleOf(plan(1439, { existing: [{ staff_id: 8, role: 'manager', sort: 0 }] }), 5), 'staff', 'もう施設長がいる日')
      assert.equal(roleOf(plan(1439, { existing: [{ staff_id: 8, role: 'manager', sort: -1 }] }), 5), 'manager', '取り消した施設長の行は数えない')
      assert.equal(plan(1439, { managerStaffId: null }).every((r) => r.role === 'staff'), true, '施設長の設定が無い')
    })
  })

  describe('出勤者・施設長の欄は苗字で出す', () => {
    it('苗字（surnameOf）で出し、同じ苗字が2人以上の時はその人たちだけ氏名のまま', () => {
      assert.deepEqual(A.attendDisplayNames(['施設長 見本05', '早番 見本01', '遅番 見本02']), ['施設長', '早番', '遅番'])
      assert.deepEqual(A.attendDisplayNames(['施設長 見本05', '職員 見本01', '職員　見本02', '遅番 見本02']), ['施設長', '職員 見本01', '職員　見本02', '遅番'])
      assert.deepEqual(A.attendDisplayNames(['空白なし']), ['空白なし'], '苗字と名前の区切りが無い氏名はそのまま')
      assert.deepEqual(A.attendDisplayNames([]), [])
    })
    it('名簿に無い職員（「職員ID n」）は縮めず、今までどおり「職員ID n」で出す・苗字の数にも入れない（反証 low3）', () => {
      assert.deepEqual(A.attendDisplayNames(['職員ID 12', '早番 見本01', '職員ID 15'], [true, false, true]), ['職員ID 12', '早番', '職員ID 15'])
      assert.deepEqual(A.attendDisplayNames(['職員ID 12', '職員 見本01'], [true, false]), ['職員ID 12', '職員'], '名簿に無い人と苗字が同じに見えても氏名にしない')
    })
  })

  describe('〔元に戻す〕は今の一覧から組み直す（反証 medium1: 自動で入った人・ほかの端末が足した人を外さない）', () => {
    const R = (id, role = 'staff', sort = 0) => ({ day: today, staff_id: id, role, sort })
    const pairs = (rows) => rows.map((r) => [r.staff_id, r.role])
    it('8:29 に A を外し、8:30 に自動入力が B を足した後で戻す: A が戻り、B は残る', () => {
      assert.deepEqual(pairs(A.undoAttendanceRows([R(1), R(3)], [R(3)], [R(3), R(2)])), [[1, 'staff'], [3, 'staff'], [2, 'staff']])
    })
    it('施設長の入れ替えの戻し: 前の施設長を施設長に戻し、入れ替えで選んだ人を外す。その間に入った人は残す', () => {
      const got = A.undoAttendanceRows([R(5, 'manager'), R(3)], [R(3), R(9, 'manager')], [R(3), R(9, 'manager'), R(2)])
      assert.deepEqual(pairs(got), [[5, 'manager'], [3, 'staff'], [2, 'staff']])
    })
    it('出勤者だった人を施設長にした入れ替えの戻し: その人は職員に戻り、前の施設長が施設長に戻る', () => {
      const got = A.undoAttendanceRows([R(5, 'manager'), R(9)], [R(9, 'manager')], [R(9, 'manager'), R(2)])
      assert.deepEqual(pairs(got), [[5, 'manager'], [9, 'staff'], [2, 'staff']])
    })
    it('戻す時点でほかの端末が別の施設長を選んでいたら、前の施設長は職員として戻す（施設長は1人）', () => {
      const got = A.undoAttendanceRows([R(5, 'manager'), R(3)], [R(3)], [R(3), R(7, 'manager')])
      assert.deepEqual(pairs(got), [[5, 'staff'], [3, 'staff'], [7, 'manager']])
    })
    it('今の一覧で既に戻っている人は二重にしない', () => {
      assert.deepEqual(pairs(A.undoAttendanceRows([R(1), R(3)], [R(3)], [R(3), R(1)])), [[3, 'staff'], [1, 'staff']])
    })
  })

  describe('未読の人の赤い氏名枠（今日の日報・出勤時刻から）', () => {
    const people = [
      { id: 1, name: '早番 見本01', days: ['2026-11-29', '2026-11-30'] },
      { id: 3, name: '夜勤 見本03', days: ['2026-11-30'] },
      { id: 6, name: '時刻なし 見本06', days: ['2026-11-30'] },
      { id: 2, name: '遅番 見本02', days: ['2026-12-01'] },
      { id: 8, name: '名簿外 見本08', days: ['2026-11-28'] },
      { id: 4, name: '休み 見本04', days: ['2026-11-30'] },
    ]
    const red = (nowMin, extra = {}) =>
      A.attendRedDays({ day: today, today, nowMin, ids: [1, 2, 3, 6, 8], people, duty, ...extra })
    it('出勤時刻の前は赤くない（30分前の入った時刻でもまだ）・出勤時刻から赤い', () => {
      assert.equal(red(6 * 60 + 30).has(1), false, '6:30（早番の30分前）は入るがまだ赤くない')
      assert.equal(red(6 * 60 + 59).has(1), false)
      assert.deepEqual(red(7 * 60).get(1), ['2026-11-29', '2026-11-30'], '7:00 から赤い・押すと出る日')
      assert.equal(red(20 * 60 + 59).has(3), false, '夜勤は夜勤入りの時刻から')
      assert.equal(red(21 * 60).has(3), true)
      assert.equal(red(0).has(6), true, '時刻が分からない人は 0:00 から')
    })
    it('前日までの未読の日がある人だけ（今日の日報の分だけの人は赤くない）・日は前日までだけ出す', () => {
      assert.equal(red(1439).has(2), false)
    })
    it('出勤者・施設長の欄にいる人だけ・今日の日報だけ', () => {
      assert.equal(red(1439).has(4), false, '欄にいない')
      assert.equal(A.attendRedDays({ day: '2026-11-30', today, nowMin: 1439, ids: [1], people, duty }).size, 0)
      assert.equal(A.attendRedDays({ day: today, today, nowMin: 1439, ids: [1], people: null, duty }).size, 0, '未読者を数えられない時')
    })
    it('今日の勤務が勤務表に無い（手で足した）人は、欄にいる＝来ているので赤くする（仮置き）', () => {
      assert.deepEqual(red(0).get(8), ['2026-11-28'])
    })
  })

  describe('autoAddAttendance（偽の Supabase・通信しない）', () => {
    const fake = (responses) => {
      const calls = []
      const builder = (table) => {
        const q = { table, action: 'select', rows: null, opts: null, cols: null }
        const b = {
          select(c) {
            q.cols = c
            return b
          },
          upsert(rows, opts) {
            q.action = 'upsert'
            q.rows = rows
            q.opts = opts
            return b
          },
          insert(rows) {
            q.action = 'insert'
            q.rows = rows
            return b
          },
          update() {
            q.action = 'update'
            return b
          },
          eq() {
            return b
          },
          in() {
            return b
          },
          gte() {
            return b
          },
          order() {
            return b
          },
          limit() {
            return b
          },
          maybeSingle() {
            return b
          },
          then(ok, ng) {
            calls.push(q)
            const r = q.table === 'attendance' ? responses.shift() ?? { data: [], error: null } : { data: null, error: { message: 'no', code: 'x' } }
            return Promise.resolve({ status: r.error ? 400 : 201, ...r }).then(ok, ng)
          },
        }
        return b
      }
      const sb = {
        from: builder,
        rpc: () => Promise.resolve({ data: null, error: { message: 'no' } }),
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
      return { sb, calls }
    }
    const rows = [
      { staff_id: 5, role: 'manager', sort: 2 },
      { staff_id: 1, role: 'staff', sort: 3 },
    ]
    it('主キー（tenant_id, day, staff_id）への ON CONFLICT DO NOTHING で1文だけ送り、入った行の職員だけ返す', async () => {
      const { sb, calls } = fake([{ data: [{ staff_id: 1 }], error: null }])
      DB.__testHooks.setClient(sb)
      const got = await DB.autoAddAttendance(today, rows)
      assert.deepEqual(got, [1], '施設長01 は既に行があって飛ばした')
      const ups = calls.filter((c) => c.table === 'attendance')
      assert.equal(ups.length, 1)
      assert.equal(ups[0].action, 'upsert')
      assert.deepEqual(ups[0].opts, { onConflict: 'tenant_id,day,staff_id', ignoreDuplicates: true })
      assert.deepEqual(ups[0].rows, [
        { day: today, staff_id: 5, role: 'manager', sort: 2 },
        { day: today, staff_id: 1, role: 'staff', sort: 3 },
      ])
      DB.__testHooks.setClient(null)
    })
    it('施設長は1日1人の索引に当たったら（ほかの端末が別の施設長を選んだ）、職員として足し直す', async () => {
      const { sb, calls } = fake([
        { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_attendance_manager_day"', details: '' } },
        { data: [{ staff_id: 5 }, { staff_id: 1 }], error: null },
      ])
      DB.__testHooks.setClient(sb)
      const got = await DB.autoAddAttendance(today, rows)
      assert.deepEqual(got, [5, 1])
      const ups = calls.filter((c) => c.table === 'attendance')
      assert.equal(ups.length, 2)
      assert.equal(ups[1].rows.every((r) => r.role === 'staff'), true)
      DB.__testHooks.setClient(null)
    })
    it('送れない時（通信・そのほかの誤り）は null を返すだけ（例外を出さない・送信待ちに積まない）', async () => {
      const { sb, calls } = fake([{ data: null, error: { code: 'PGRST000', message: 'fetch failed' } }])
      DB.__testHooks.setClient(sb)
      const before = lsStore.get('cl_sendQueue2') ?? null
      assert.equal(await DB.autoAddAttendance(today, rows), null)
      assert.equal(calls.filter((c) => c.table === 'attendance').length, 1)
      assert.equal(lsStore.get('cl_sendQueue2') ?? null, before, '送信待ちは変わらない')
      DB.__testHooks.setClient(null)
    })
    it('入力封鎖中は送らない（null）・日の形が違えば送らない・足す人がいなければ何もしない', async () => {
      const { sb, calls } = fake([])
      DB.__testHooks.setClient(sb, { native: false })
      assert.equal(await DB.autoAddAttendance(today, rows), null)
      assert.equal(calls.filter((c) => c.table === 'attendance').length, 0)
      DB.__testHooks.setClient(sb)
      assert.equal(await DB.autoAddAttendance('2026/12/01', rows), null)
      assert.deepEqual(await DB.autoAddAttendance(today, []), [])
      assert.equal(calls.filter((c) => c.table === 'attendance').length, 0)
      DB.__testHooks.setClient(null)
    })
    it('hasPendingAttendance: 圏外で手で足した出勤者が送信待ちに積まれた日だけ true（反証 low2・自動入力はその間に読み直さない）', async () => {
      const { sb } = fake([{ data: null, error: { message: 'fetch failed' }, status: 0 }])
      DB.__testHooks.setClient(sb)
      assert.equal(DB.hasPendingAttendance(today), false)
      const res = await DB.saveAttendance(today, [{ staff_id: 1, role: 'staff', sort: 0 }], { baseline: [] })
      assert.equal(res, 'queued', '送信待ちに積まれた')
      assert.equal(DB.hasPendingAttendance(today), true)
      assert.equal(DB.hasPendingAttendance('2026-11-30'), false, '別の日は数えない')
      DB.__testHooks.setClient(null)
    })
    it('hasPendingAttendance: 止まった送信待ち（blocked）は数えない（数えるとその日の自動入力が一日中止まる・再レビュー medium）', () => {
      const db = read('../src/lib/db.ts')
      const f = db.slice(db.indexOf('export function hasPendingAttendance'), db.indexOf('export async function autoAddAttendance'))
      assert.match(f, /if \(op\.blocked !== undefined\) continue/)
    })
  })

  describe('静的検査', () => {
    const page = read('../src/pages/DailySheetPage.tsx')
    const css = read('../src/styles/sheet.css')
    const db = read('../src/lib/db.ts')
    const lib = read('../src/lib/attendanceAuto.ts')
    it('自動入力は今日の日報で、読み込み後・入力できる時・勤務表を読めた時だけ動き、手で足す・外す保存と同じ列に並ぶ', () => {
      const sec = page.slice(page.indexOf('const autoTriedRef'), page.indexOf('// ── 申し送り ──'))
      assert.ok(sec.length > 0)
      assert.match(sec, /if \(day !== today \|\| phase !== 'ready' \|\| !enabled \|\| todayFac === null/)
      assert.match(sec, /attendanceChainRef\.current/)
      assert.match(sec, /existing: attendanceRef\.current/)
      assert.match(sec, /await autoAddAttendance\(day, rows\)/)
      assert.match(sec, /fetchAttendanceForDay\(day\)/, '書いた後はその日の出勤者を読み直す')
      assert.doesNotMatch(sec, /landed\.length === 0/, '読み直しを入った件数で絞らない（ほかの端末が先に足した時も欄に出す）')
      assert.match(sec, /\[day, today, nowMin, phase, enabled, todayFac,/, '1分ごとの見直し（nowMin）と読み込みのたび')
      assert.doesNotMatch(sec, /saveAttendance\(/, '取り消した行を戻す saveAttendance を使わない')
      assert.ok((sec.match(/hasPendingAttendance\(day\)/g) ?? []).length >= 3, '送信待ちがある間は書き込みも読み直しもしない（反証 low2）')
      // 2026-11-20 固定し直し・意図は同じ（送信待ちが無い時だけ取り直した欄を当てる）: 当てる時に書き換えの回数も数える
      // （中身を出したまま読み直す間に足した人を、古い読み込みの結果で消さないため）
      assert.match(sec, /dayRef\.current === day && !hasPendingAttendance\(day\)\) \{\s*savedSeqRef\.current \+= 1\s*applyAttendance\(fresh\)/)
    })
    it('〔元に戻す〕は外す前の一覧をそのまま送らず、今の一覧から undoAttendanceRows で組み直す（反証 medium1）', () => {
      const sec = page.slice(page.indexOf('const persistAttendance = useCallback('), page.indexOf('const enqueueAttendance = useCallback('))
      assert.ok(sec.length > 0)
      assert.match(sec, /enqueueAttendanceRef\.current\(dayIso, \(cur\) => \(\{ rows: undoAttendanceRows\(prev, next, cur\), undoLabel: null \}\)\)/)
      assert.doesNotMatch(sec, /\(\) => \(\{ rows: prev, undoLabel: null \}\)/)
    })
    it('DayHeader は名簿に無い職員を縮めない（staffById に無い人をそのまま出す・反証 low3）', () => {
      const sec = page.slice(page.indexOf('function DayHeader('), page.indexOf('<StatusText status={ctx.status.attendance} />'))
      assert.match(sec, /shownIds\.map\(\(id\) => !ctx\.staffById\.has\(id\)\)/)
    })
    it('autoAddAttendance は送信待ちに積まない・取り消した行を更新しない（insert の ON CONFLICT DO NOTHING だけ）', () => {
      const sec = strip(db.slice(db.indexOf('export async function autoAddAttendance'), db.indexOf('// ── 食い違いの解決画面')))
      assert.ok(sec.length > 0)
      assert.doesNotMatch(sec, /enqueue\(|\.update\(|\.delete\(|console\.|localStorage/)
      assert.match(sec, /ignoreDuplicates: true/)
      assert.match(sec, /await assertWritable\(\)/)
    })
    it('欄の名前は苗字（attendDisplayNames）・読み上げのラベルは氏名のまま', () => {
      const sec = page.slice(page.indexOf('function DayHeader('), page.indexOf('<StatusText status={ctx.status.attendance} />'))
      assert.match(sec, /attendDisplayNames\(/)
      assert.match(sec, /name=\{managerShown\}/)
      assert.match(sec, /name=\{workerShown\[i\] \?\? full\}/)
      assert.match(sec, /label=\{red \? `出勤者 \$\{full\}/)
      assert.match(sec, /`施設長 \$\{managerName\} を取り消す`/)
    })
    it('赤い枠と未読の日の窓は画面だけ（色は @media screen・印と窓は print:hidden）・欄の幅は変えない', () => {
      const at = css.indexOf('.dsheet-attend-unread.dsheet-attend-unread')
      assert.ok(at > 0)
      assert.match(css.slice(0, at), /@media screen \{\s*$/)
      const rule = css.slice(at, css.indexOf('}', at))
      assert.match(rule, /background: var\(--c-danger-bg\)/)
      assert.match(rule, /box-shadow: inset 0 0 0 2px var\(--c-danger\)/)
      assert.match(rule, /font-weight: var\(--fw-bold\)/)
      assert.doesNotMatch(rule, /width|height|border:|padding|margin/)
      const cell = page.slice(page.indexOf('function AttendCell('), page.indexOf('function DayHeader('))
      assert.match(cell, /className="flex min-w-0 items-center gap-px print:hidden"/)
      assert.match(cell, /className="hidden truncate print:block"/, '紙は今までと同じ形')
      const head = page.slice(page.indexOf('function DayHeader('), page.indexOf('<StatusText status={ctx.status.attendance} />'))
      assert.match(head, /<div className="print:hidden">\s*<ModalShell/)
      // 2026-11-20 固定し直し・意図は同じ: 日付と一緒に誰の未読かも渡す（他の未読日を続けて読む窓のため）
      assert.match(head, /onPickUnread\(d, \{ id: unreadOpen\.id, name: unreadOpen\.name \}\)/, '日付を押すとその日へ（goUnreadDay）')
      assert.match(head, /onRemoveAttendance\(id\)/, '窓の〔出勤者から外す〕は今までの取り消し')
      assert.match(head, /red \? setUnreadOpen\(\{ id: a\.staff_id, name: full \}\) : onRemoveAttendance\(a\.staff_id\)/, '赤くない枠は今までどおり取り消し')
      assert.match(page, /onPickUnread=\{onPickUnread\}/)
    })
    it('部品は個人情報を console・localStorage に出さない', () => {
      assert.doesNotMatch(strip(lib), /console\.|localStorage|sessionStorage/)
    })
  })
}
