// 日報の確認欄（2026-11-19・0065）の試験。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 記号の読み方（src/lib/shiftDuty.ts の parseCellKinds）が、シフト作成アプリ（care-tools の shift-symbols.js の parseCell）と同じ
//    （下の PARITY は 2026-11-19 に shift-symbols.js の parseCell(c, DEFAULT_SYMBOLS) の parts[].kind と error の有無を写した見本）
// 2. 勤務の区分（cellDuty・staffDayDuty）: 勤務・夜勤入り＝勤務／休み系・夜勤上がりだけ＝休み／空欄／読めない＝判定できない・
//    実績が先・予定が次・主の区分が訪問の主の欄は使わない・施設と通所の応援の欄は使う・退職・休職は外す
// 3. 確認欄と未読者（src/lib/readCheck.ts の buildReadCheckView）: 勤務で ✔ の無い人だけ未読・休みの日は出さない＝休み明けの日に出る・
//    勤務表が無い時は出勤者の欄・両方無ければ判定しない・名前が勤務表に無い人は判定できない・未来の日は判定しない
// 4. 静的検査: 確認欄と未読者欄は画面だけ（print:hidden）・日報の枠に置いてある・個人情報を console・localStorage に出さない
// 個人情報は置かない（職員01 などの見本の名前と数値IDだけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
/** 行コメントと複数行コメントを除いた本文 */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

let D = null
let R = null
let loadError = null
try {
  D = await import('../src/lib/shiftDuty.ts')
  R = await import('../src/lib/readCheck.ts')
} catch (e) {
  loadError = e
  D = null
}

const PARITY = {
  '': { parts: [], error: false },
  早: { parts: ['work'], error: false },
  日1: { parts: ['work'], error: false },
  遅: { parts: ['work'], error: false },
  '(21': { parts: ['nightIn'], error: false },
  '(22': { parts: ['nightIn'], error: false },
  '7)': { parts: ['nightOut'], error: false },
  '8)': { parts: ['nightOut'], error: false },
  '8)(22': { parts: ['nightOut', 'nightIn'], error: false },
  '7)(21': { parts: ['nightOut', 'nightIn'], error: false },
  ')': { parts: ['nightOut'], error: false },
  ')(希': { parts: ['nightOut', 'off'], error: false },
  休: { parts: ['off'], error: false },
  希: { parts: ['off'], error: false },
  公: { parts: ['publicOff'], error: false },
  有: { parts: ['paidOff'], error: false },
  明: { parts: ['off'], error: false },
  希休: { parts: ['off'], error: false },
  有休: { parts: ['paidOff'], error: false },
  公休: { parts: ['publicOff'], error: false },
  '9-12': { parts: ['work'], error: false },
  '８：３０－１６': { parts: ['work'], error: false },
  '7-9 17-21': { parts: ['work', 'work'], error: false },
  '早/同': { parts: ['work'], error: false },
  '(有': { parts: ['paidOff'], error: false },
  欠: { parts: [], error: true },
  ABC: { parts: [], error: true },
  '22-8': { parts: [], error: true },
  '7)(有': { parts: ['nightOut', 'paidOff'], error: false },
  日１: { parts: ['work'], error: false },
  ' 休 ': { parts: ['off'], error: false },
  '(21 7)': { parts: ['nightIn', 'nightOut'], error: false },
}

if (D === null) {
  registerLoadFailure('日報の確認欄の試験', loadError, 'この Node は型の除去を持たない（古い Node）')
} else {
  describe('記号の読み方はシフト作成アプリと同じ', () => {
    for (const [cell, want] of Object.entries(PARITY)) {
      it(`「${cell}」`, () => {
        assert.deepEqual(D.parseCellKinds(cell), want)
      })
    }
  })

  describe('勤務の区分', () => {
    it('セル1つ: 勤務・夜勤入り・複合は勤務、休み・夜勤上がりだけは休み、空欄、読めない', () => {
      for (const c of ['早', '(21', '8)(22', '9-12', '7-9 17-21']) assert.equal(D.cellDuty(c), 'duty', c)
      for (const c of ['休', '希', '公', '有', '明', '7)', ')', ')(希', '有休']) assert.equal(D.cellDuty(c), 'off', c)
      assert.equal(D.cellDuty(''), 'blank')
      assert.equal(D.cellDuty(null), 'blank')
      for (const c of ['欠', 'ABC', '22-8']) assert.equal(D.cellDuty(c), 'unknown', c)
    })
    it('記号マスタで足した勤務の記号と、止めた記号', () => {
      const syms = [...D.DEFAULT_SHIFT_SYMBOLS, { code: '研', type: 'work' }, { code: '早', type: 'work', disabled: true }]
      assert.equal(D.cellDuty('研', syms), 'duty')
      assert.equal(D.cellDuty('研'), 'unknown')
    })
    const st = (over = {}) => ({ id: 's1', name: '職員01', mainDivision: '施設', ...over })
    it('実績にその人・その日の欄があれば実績、無ければ予定', () => {
      const plan = { cells: { s1: { 3: '早', 4: '休' } } }
      const actual = { cells: { s1: { 3: '有' } } }
      assert.equal(D.staffDayDuty(st(), 3, plan, actual, D.DEFAULT_SHIFT_SYMBOLS), 'off')
      assert.equal(D.staffDayDuty(st(), 4, plan, actual, D.DEFAULT_SHIFT_SYMBOLS), 'off')
      assert.equal(D.staffDayDuty(st(), 3, plan, null, D.DEFAULT_SHIFT_SYMBOLS), 'duty')
      assert.equal(D.staffDayDuty(st(), 5, plan, actual, D.DEFAULT_SHIFT_SYMBOLS), 'blank')
    })
    it('日の鍵は 1 でも 01 でも読む', () => {
      assert.equal(D.staffDayDuty(st(), 1, { cells: { s1: { '01': '遅' } } }, null, D.DEFAULT_SHIFT_SYMBOLS), 'duty')
    })
    it('主の区分が訪問の人の主の欄は使わず、施設・通所の応援の欄は使う', () => {
      const plan = { cells: { s1: { 2: '日1', 3: '日1' } }, subCells: { s1: { 施設: { 3: '遅' }, 訪問: { 2: '早' } } } }
      const v = st({ mainDivision: '訪問' })
      assert.equal(D.staffDayDuty(v, 2, plan, null, D.DEFAULT_SHIFT_SYMBOLS), 'blank')
      assert.equal(D.staffDayDuty(v, 3, plan, null, D.DEFAULT_SHIFT_SYMBOLS), 'duty')
      assert.equal(D.staffInDaily(v, [plan]), true)
      assert.equal(D.staffInDaily(v, [{ cells: plan.cells }]), false)
      assert.equal(D.staffDayDuty(st({ mainDivision: '通所' }), 2, plan, null, D.DEFAULT_SHIFT_SYMBOLS), 'duty')
      assert.equal(D.staffDayDuty(st({ mainDivision: undefined }), 2, plan, null, D.DEFAULT_SHIFT_SYMBOLS), 'duty')
    })
    it('勤務の欄と休みの欄が両方ある日は勤務（応援の日）', () => {
      const plan = { cells: { s1: { 2: '休' } }, subCells: { s1: { 通所: { 2: '9-12' } } } }
      assert.equal(D.staffDayDuty(st(), 2, plan, null, D.DEFAULT_SHIFT_SYMBOLS), 'duty')
    })
    it('退職・休職・非表示・退職月を過ぎた人は外す', () => {
      assert.equal(D.shiftStaffVisible(st(), '2026-11'), true)
      for (const status of ['退職', '休職', '非表示']) assert.equal(D.shiftStaffVisible(st({ status }), '2026-11'), false, status)
      assert.equal(D.shiftStaffVisible(st({ active: false }), '2026-11'), false)
      assert.equal(D.shiftStaffVisible(st({ retireMonth: '2026-10' }), '2026-11'), false)
      assert.equal(D.shiftStaffVisible(st({ retireMonth: '2026-11' }), '2026-11'), true)
      assert.equal(D.shiftStaffVisible(st({ id: 'a b' }), '2026-11'), false)
    })
    it('日ごとの表: 勤務表の無い月の日は入れない・名前は空白を除いて突き合わせる・同じ名前は勤務を先に', () => {
      const src = {
        staff: [st({ name: '職員 01' }), st({ id: 's2', name: '職員01' }), st({ id: 's3', name: '職員03', mainDivision: '訪問' })],
        symbols: [],
        months: { '2026-11': { plan: { cells: { s1: { 18: '休' }, s2: { 18: '早' }, s3: { 18: '早' } } }, actual: null } },
      }
      const t = D.buildDutyTable(src, ['2026-11-18', '2026-12-01'])
      assert.equal(t.has('2026-12-01'), false)
      const row = t.get('2026-11-18')
      assert.equal(row.get('職員01'), 'duty')
      assert.equal(row.has('職員03'), false) // 訪問だけの人は日報の対象でない
    })
    it('勤務表の応答から使う項目だけを取り出す（労務の項目は捨てる）', () => {
      const s = D.projectShiftStaff([{ id: 's1', name: '職員01', mainDivision: '施設', empCode: 'X', rules: {}, qualifications: [] }, { id: 2, name: 'x' }, null])
      assert.deepEqual(s, [{ id: 's1', name: '職員01', mainDivision: '施設', active: undefined, status: undefined, retireMonth: undefined }])
      assert.equal(D.projectShiftStaff({}), null)
      assert.deepEqual(D.projectShiftMonth({ cells: { s1: { 1: '早' } }, notes: 'x', colors: {} }), { cells: { s1: { 1: '早' } }, subCells: {} })
      assert.equal(D.projectShiftMonth(null), null)
    })
  })

  describe('確認欄と未読者', () => {
    const staff = [
      { id: 1, name: '職員01', hire_order: 1 },
      { id: 2, name: '職員02', hire_order: 2 },
      { id: 3, name: '職員03', hire_order: 3 },
      { id: 9, name: '事務01', hire_order: null },
    ]
    const day = '2026-11-21'
    const today = '2026-11-22'
    const duty = new Map([[day, new Map([['職員01', 'duty'], ['職員02', 'off'], ['職員03', 'unknown']])]])
    const keys = new Set(['職員01', '職員02', '職員03'])
    const base = { day, today, staff, duty, dailyKeys: keys, checkedIds: new Set(), attendanceIds: new Set() }

    it('勤務で ✔ の無い人だけが未読・休みの人は出さない・読めない記号の人は判定できない', () => {
      const v = R.buildReadCheckView(base)
      assert.equal(v.source, 'shift')
      assert.deepEqual(v.unread.map((u) => u.id), [1])
      assert.deepEqual(v.undetermined.map((u) => u.id), [3])
      assert.deepEqual(v.members.map((m) => m.id), [1, 2, 3]) // 勤務表の対象でない事務職員は並べない
    })
    it('✔ を付けると未読から外れる', () => {
      const v = R.buildReadCheckView({ ...base, checkedIds: new Set([1]) })
      assert.deepEqual(v.unread, [])
      assert.equal(v.members.find((m) => m.id === 1).checked, true)
    })
    it('休み明け: 休みの日は出ず、勤務に戻った日に ✔ が無ければ出る', () => {
      const dutyTable = new Map([
        ['2026-11-19', new Map([['職員02', 'off']])],
        ['2026-11-20', new Map([['職員02', 'off']])],
        ['2026-11-21', new Map([['職員02', 'duty']])],
      ])
      const at = (d) => R.buildReadCheckView({ ...base, day: d, duty: dutyTable }).unread.map((u) => u.id)
      assert.deepEqual(at('2026-11-19'), [])
      assert.deepEqual(at('2026-11-20'), [])
      assert.deepEqual(at('2026-11-21'), [2])
    })
    it('勤務表で名前が見つからない人は判定できない（未読には出さない）', () => {
      const v = R.buildReadCheckView({ ...base, duty: new Map([[day, new Map([['職員01', 'duty']])]]) })
      assert.deepEqual(v.unread.map((u) => u.id), [1])
      assert.deepEqual(v.undetermined.map((u) => u.id).sort(), [2, 3])
    })
    it('氏名の表記が勤務表と違う職員も確認欄から消えない（判定できないに数える）・名簿にいて対象でない人（訪問だけ）は並べない', () => {
      const s2 = [...staff, { id: 4, name: '旧姓04', hire_order: 4 }, { id: 5, name: '訪問05', hire_order: 5 }]
      const roster = new Set(['職員01', '職員02', '職員03', '訪問05'])
      const v = R.buildReadCheckView({ ...base, staff: s2, rosterKeys: roster })
      assert.ok(v.members.some((m) => m.id === 4 && m.duty === 'nomatch'))
      assert.ok(!v.members.some((m) => m.id === 5))
      assert.ok(v.undetermined.some((u) => u.id === 4))
      assert.ok(!v.members.some((m) => m.id === 9)) // 手で足した事務職員（hire_order なし）は並べない
    })
    it('確認欄を始める前の日は判定しない（✔ の行が無いので全員が赤になるのを防ぐ）', () => {
      const v = R.buildReadCheckView({ ...base, day: '2026-11-18', duty: new Map([['2026-11-18', new Map([['職員01', 'duty']])]]) })
      assert.equal(v.source, 'before')
      assert.deepEqual(v.unread, [])
      assert.equal(R.READ_CHECK_FROM, '2026-11-19')
    })
    it('今日から14日より前の日は stale（現場の端末から付けられないので目立たせない）', () => {
      const d = new Map([['2026-12-01', new Map([['職員01', 'duty']])], ['2026-12-02', new Map([['職員01', 'duty']])]])
      const old = R.buildReadCheckView({ ...base, day: '2026-12-01', today: '2026-12-16', duty: d })
      const edge = R.buildReadCheckView({ ...base, day: '2026-12-02', today: '2026-12-16', duty: d })
      assert.equal(old.stale, true)
      assert.deepEqual(old.unread.map((u) => u.id), [1])
      assert.equal(edge.stale, false)
    })
    it('勤務表が読めない・その月が無い時は出勤者の欄で判定する', () => {
      const v = R.buildReadCheckView({ ...base, duty: null, dailyKeys: null, attendanceIds: new Set([2]) })
      assert.equal(v.source, 'attendance')
      assert.deepEqual(v.unread.map((u) => u.id), [2])
      assert.deepEqual(v.members.map((m) => m.id), [1, 2, 3]) // 勤務表の名簿から同期した人（hire_order あり）
    })
    it('勤務表も出勤者の欄も無い時は判定しない（未読者を出さない）', () => {
      const v = R.buildReadCheckView({ ...base, duty: null, dailyKeys: null })
      assert.equal(v.source, 'none')
      assert.deepEqual(v.unread, [])
    })
    it('どの職員にも hire_order が無い（古いサーバー）時は在籍の職員全員を並べる', () => {
      const s2 = staff.map((s) => ({ ...s, hire_order: null }))
      const v = R.buildReadCheckView({ ...base, staff: s2, duty: null, dailyKeys: null })
      assert.equal(v.members.length, 4)
    })
    it('並びの外の人が付けた ✔ と、出勤者の欄の人は確認欄に並べる', () => {
      const v = R.buildReadCheckView({ ...base, checkedIds: new Set([9]) })
      assert.ok(v.members.some((m) => m.id === 9 && m.checked))
    })
    it('まだ来ていない日は判定しない', () => {
      const v = R.buildReadCheckView({ ...base, day: '2026-11-23', duty: new Map([['2026-11-23', new Map([['職員01', 'duty']])]]) })
      assert.equal(v.source, 'future')
      assert.deepEqual(v.unread, [])
    })
    it('書き込みの誤りの種類', () => {
      assert.equal(R.readCheckErrorKind({ code: '42P01' }), 'missing')
      assert.equal(R.readCheckErrorKind({ code: '23505' }), 'dup')
      assert.equal(R.readCheckErrorKind({ code: '42501', message: 'read_check_past_office_only: x' }), 'past')
      assert.equal(R.readCheckErrorKind({ code: '22023', message: 'read_check_future: x' }), 'future')
      assert.equal(R.readCheckErrorKind(null), 'other')
    })
  })

  describe('静的検査', () => {
    const comp = read('../src/components/DailyReadCheck.tsx')
    const page = read('../src/pages/DailySheetPage.tsx')
    const db = read('../src/lib/db.ts')
    it('確認欄と未読者欄は画面だけ（紙の日報を変えない）', () => {
      const roots = comp.match(/<(div|section)\s[^>]*className="[^"]*"/g) ?? []
      const top = roots.filter((r) => /print:hidden/.test(r))
      assert.ok(top.length >= 5, '未読者欄の4つの形と確認欄の外枠に print:hidden')
      assert.match(comp, /<section\s+id=\{`readcheck-\$\{day\}`\}\s+className="print:hidden/)
    })
    it('確認欄のボタンの赤は、読み終えた時だけ・古い日は出さない（未読者欄とそろえる）', () => {
      assert.match(comp, /const showUnread = state\.loaded && state\.shiftLoaded && !view\.stale/)
      assert.match(comp, /const unreadIds = new Set\(showUnread \? view\.unread\.map\(\(u\) => u\.id\) : \[\]\)/)
      assert.match(comp, /if \(!state\.loaded \|\| !state\.shiftLoaded \|\| state\.missing \|\| state\.loadFailed\) return null/)
    })
    it('日報の枠に置いてある（日付の見出しの下と枠の末尾）', () => {
      assert.match(page, /<ReadCheckBanner day=\{day\} view=\{readCheckView\} state=\{readChecks\} \/>/)
      assert.match(page, /<ReadCheckPanel day=\{day\} view=\{readCheckView\} state=\{readChecks\} actorId=\{actorId\} \/>/)
      assert.match(page, /const readChecks = useReadChecks\(visibleDays, reload\)/)
    })
    it('勤務表は判定に要る項目だけの読み口（carelog_shift_duty）で読み、kv_get で職員の全項目を受け取らない・console・localStorage に出さない', () => {
      const sec = strip(db.slice(db.indexOf('// ── 日報の確認欄')))
      assert.ok(sec.length > 0)
      assert.doesNotMatch(sec, /kv_put|kv_set|kv_get/)
      assert.doesNotMatch(sec, /console\.|localStorage/)
      assert.match(sec, /sb\.rpc\('carelog_shift_duty', \{ p_months: yms \}\)/)
      const lib = strip(read('../src/lib/shiftDuty.ts') + read('../src/lib/readCheck.ts') + read('../src/hooks/useReadChecks.ts') + comp)
      assert.doesNotMatch(lib, /console\.|localStorage|sessionStorage/)
    })
  })
}
