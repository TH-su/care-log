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

  describe('未読者欄の数え方（日勤は前日の分・夜勤はその日の日中の分から・施設だけ）', () => {
    const roster = [
      { id: 'a', name: '日勤01', mainDivision: '施設' },
      { id: 'b', name: '夜勤01', mainDivision: '施設' },
      { id: 'c', name: 'デイ01', mainDivision: '通所' },
      { id: 'd', name: '訪問01', mainDivision: '訪問' },
      { id: 'e', name: '休み01', mainDivision: '施設' },
    ]
    // 11月の予定: 日勤01 は 20日・21日・23日に日勤（22日 休み）、夜勤01 は 20日に夜勤入り・21日に明け、デイ01 は毎日日勤（施設の応援も）、
    // 訪問01 は主の欄で毎日勤務・21日だけ施設の応援、休み01 は20〜23日休み
    const plan = {
      cells: {
        a: { 20: '日1', 21: '早', 22: '休', 23: '遅' },
        b: { 20: '(22', 21: '8)', 22: '休', 23: '休' },
        c: { 20: '日1', 21: '日1', 22: '日1', 23: '日1' },
        d: { 20: '9-12', 21: '9-12', 22: '9-12', 23: '9-12' },
        e: { 20: '休', 21: '休', 22: '休', 23: '休' },
      },
      subCells: { c: { 施設: { 21: '9-12' } }, d: { 施設: { 21: '13-16' } } },
    }
    const src = { staff: roster, symbols: [], months: { '2026-11': { plan, actual: null } } }
    const staff = [
      { id: 1, name: '日勤01' },
      { id: 2, name: '夜勤01' },
      { id: 3, name: 'デイ01' },
      { id: 4, name: '訪問01' },
      { id: 5, name: '休み01' },
      { id: 6, name: '厨房01' },
    ]
    const today = '2026-11-23'
    const days = R.unreadDutyDays(today)
    const duty = D.buildFacilityDutyTable(src, days)
    const empty = new Map(R.unreadWindow(today).map((d) => [d, new Set()]))

    // 2026-11-19 代表者の指示（現場の端末で見た後）: 今日の日報も夜勤の人は入りの30分前から読む番＝今日まで数える。
    // 確認欄は始めた日の前日（11-18）から出す（始めた日の朝の日勤の人が読む前日の分）。前の「昨日まで・始めた日から」の検査は置き換えた
    it('数える日は確認欄を出し始めた日（始めた日の前日）から今日まで・14日前まで', () => {
      assert.deepEqual(R.unreadWindow('2026-11-17'), [])
      assert.deepEqual(R.unreadWindow('2026-11-19'), ['2026-11-18', '2026-11-19'])
      assert.deepEqual(R.unreadWindow(today), ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'])
      assert.deepEqual(days.at(-1), '2026-11-24', '勤務表は今日の翌日まで読む')
      const w = R.unreadWindow('2026-12-31')
      assert.equal(w.length, 15, '14日前から今日まで')
      assert.equal(w[0], '2026-12-17')
    })
    it('施設の勤務だけ・デイ職員（主の区分が通所）は施設の応援があっても入れない・日勤と夜勤入りを分けて持つ', () => {
      assert.equal(duty.get('2026-11-20').has('デイ01'), false)
      // 2026-11-19 確認欄の出し方（0066）: 出勤の時刻（workStart・nightStart）を持つようになった
      const F = (work, nightIn, workStart = null, nightStart = null) => ({ work, nightIn, unknown: false, workStart, nightStart })
      assert.deepEqual(duty.get('2026-11-20').get('夜勤01'), F(false, true, null, 22 * 60))
      assert.deepEqual(duty.get('2026-11-21').get('夜勤01'), F(false, false))
      // 2026-11-19 訂正（施設の勤務の数え方）: 住宅型のため、主の区分が訪問の人の主の欄にも施設の勤務が入る＝数える。
      // 前は「訪問の主の欄は数えない」を固定していた（その決まりのせいで施設長しか数えていなかった）。意図を変えたので期待値を書き換えた
      assert.deepEqual(duty.get('2026-11-20').get('訪問01'), F(true, false, 9 * 60), '主の区分が訪問の人の主の欄も数える')
      assert.deepEqual(duty.get('2026-11-21').get('訪問01'), F(true, false, 9 * 60), '主の欄（9-12）と施設の応援（13-16）の早い方')
      const st = { id: 'n', name: '夜勤02', mainDivision: '施設' }
      assert.equal(D.staffDayFacility(st, 1, { cells: { n: { 1: '（21' } } }, null, []).nightIn, true, '全角の括弧の夜勤入り（勤務表の実際の書き方）')
      assert.equal(D.staffDayFacility(st, 1, { cells: { n: { 1: '7)(21' } } }, null, []).nightIn, true)
      assert.equal(D.staffDayFacility(st, 1, { cells: { n: { 1: '7)' } } }, null, []).work, false, '明けだけは日勤でない')
    })
    it('日報 R を読む人＝R の夜勤入りの人と、R の翌日に日勤の人', () => {
      const s = R.buildUnreadSummary({ today, staff, duty, checks: empty })
      // 2026-11-19 訂正: 訪問01（主の区分が訪問・主の欄に毎日 9-12）も施設の勤務に数える（前は数えなかった＝意図を変えて書き換えた）
      // 19日の勤務表は無い（予定はあるが19日の欄が空）→ 19日は「20日に日勤の日勤01・訪問01」
      assert.deepEqual([...s.byDay.get('2026-11-19')].sort(), [1, 4])
      // 20日: 夜勤01（20日の夜勤入り）と日勤01（21日に早番）・訪問01（21日に日勤）
      assert.deepEqual([...s.byDay.get('2026-11-20')].sort(), [1, 2, 4])
      // 21日: 22日に日勤は訪問01 だけ（日勤01 は休み）・21日の夜勤入りはいない
      assert.deepEqual([...s.byDay.get('2026-11-21')], [4])
      // 22日: 23日に日勤の日勤01（休み明け）と訪問01
      assert.deepEqual([...s.byDay.get('2026-11-22')].sort(), [1, 4])
    })
    it('デイ職員・厨房の職員（勤務表の名簿に居ない）・休みの人は氏名が出ない', () => {
      const s = R.buildUnreadSummary({ today, staff, duty, checks: empty })
      const names = s.people.map((p) => p.name)
      assert.deepEqual(names, ['日勤01', '夜勤01', '訪問01'])
      assert.deepEqual(s.people[0].days, ['2026-11-19', '2026-11-20', '2026-11-22'])
    })
    it('✔ のある日は未読から外れる', () => {
      const checks = new Map(empty)
      checks.set('2026-11-20', new Set([1, 2]))
      const s = R.buildUnreadSummary({ today, staff, duty, checks })
      assert.deepEqual([...s.byDay.get('2026-11-20')], [4])
      assert.deepEqual(s.people.find((p) => p.id === 1).days, ['2026-11-19', '2026-11-22'])
      assert.equal(s.people.some((p) => p.id === 2), false)
    })
    it('翌日の勤務表が無い日・勤務表が読めない時は判定できない（未読者なしと言い切らない）', () => {
      const s = R.buildUnreadSummary({ today: '2026-12-01', staff, duty: D.buildFacilityDutyTable(src, R.unreadDutyDays('2026-12-01')), checks: new Map() })
      assert.ok(s.undeterminedDays.includes('2026-11-30'), '12月の勤務表が無い＝30日の翌日が読めない')
      const n = R.buildUnreadSummary({ today, staff, duty: null, checks: empty })
      assert.equal(n.people.length, 0)
      assert.deepEqual(n.undeterminedDays, R.unreadWindow(today))
    })
    it('勤務表で名前が見つからない職員（勤務表から同期した人）は数えず、人数だけ知らせる（厨房など hire_order の無い人は数えない）', () => {
      const st2 = [...staff.map((x) => ({ ...x, hire_order: x.id })), { id: 7, name: '表記違い01', hire_order: 7 }, { id: 8, name: '厨房02', hire_order: null }]
      const roster2 = new Set(roster.map((r) => r.name))
      const s = R.buildUnreadSummary({ today, staff: st2, duty, checks: empty, rosterKeys: roster2 })
      assert.equal(s.unmatched, 2, '表記違い01 と 厨房01（hire_order あり）')
      assert.equal(s.people.some((p) => p.id === 7 || p.id === 8), false)
      assert.equal(R.buildUnreadSummary({ today, staff: st2, duty, checks: empty }).unmatched, 0, '名簿が読めない時は数えない')
    })
    it('デイ職員と同じ氏名の施設の職員がいても、デイ職員の氏名は出さない（指示を先にする）', () => {
      const s = R.buildUnreadSummary({ today, staff, duty, checks: empty, dayKeys: new Set(['日勤01']) })
      assert.equal(s.people.some((p) => p.name === '日勤01'), false)
    })
    it('読めない記号の人がいる日は判定できない日に数える', () => {
      const p2 = { cells: { ...plan.cells, e: { ...plan.cells.e, 21: 'ABC' } }, subCells: plan.subCells }
      const t = D.buildFacilityDutyTable({ ...src, months: { '2026-11': { plan: p2, actual: null } } }, days)
      const s = R.buildUnreadSummary({ today, staff, duty: t, checks: empty })
      assert.ok(s.undeterminedDays.includes('2026-11-20'), '21日の日勤が読めない人＝20日を読むか分からない')
      assert.ok(s.undeterminedDays.includes('2026-11-21'), '21日の夜勤入りが読めない人')
    })
  })

  describe('確認欄に並ぶ人と、未読者に名前が出る時刻（2026-11-19 代表者の指示・0066）', () => {
    const SYM = [
      { code: '早', type: 'work', start: '07:00' },
      { code: '遅', type: 'work', start: '11:00' },
      { code: '日1', type: 'work' },
      { code: '(21', type: 'nightIn', start: '21:00' },
      { code: '7)', type: 'nightOut' },
      { code: '休', type: 'off' },
    ]
    it('出勤の時刻: 記号は記号マスタの start、時刻の範囲は始まり、夜勤入りは括弧の後ろ、分からなければ null', () => {
      assert.deepEqual(D.cellStarts('早', SYM), { work: 420, nightIn: null })
      assert.deepEqual(D.cellStarts('遅', SYM), { work: 660, nightIn: null })
      assert.deepEqual(D.cellStarts('日1', SYM), { work: null, nightIn: null }, 'start の無い記号')
      assert.deepEqual(D.cellStarts('8:30-16', SYM), { work: 510, nightIn: null })
      assert.deepEqual(D.cellStarts('(21', SYM), { work: null, nightIn: 1260 })
      assert.deepEqual(D.cellStarts('（22', SYM), { work: null, nightIn: 1320 }, '全角の括弧')
      assert.deepEqual(D.cellStarts('7)(21', SYM), { work: null, nightIn: 1260 })
      assert.deepEqual(D.cellStarts('7-9 17-21', SYM), { work: 420, nightIn: null }, '2つの勤務は早い方')
      assert.deepEqual(D.cellStarts('休', SYM), { work: null, nightIn: null })
      assert.deepEqual(D.projectShiftSymbols([{ code: '早', type: 'work', start: '07:00', color: '#fff' }]), [{ code: '早', type: 'work', disabled: undefined, start: '07:00' }])
    })
    const roster = [
      { id: 'a', name: '早番01', mainDivision: '施設' },
      { id: 'b', name: '遅番01', mainDivision: '施設' },
      { id: 'c', name: '夜勤01', mainDivision: '施設' },
      { id: 'd', name: 'デイ01', mainDivision: '通所' },
    ]
    // 20日: 早番01 早・遅番01 休・夜勤01 (21・デイ01 日1（施設の応援も）／21日: 早番01 早・遅番01 遅（休み明け）・夜勤01 7)・デイ01 日1
    const plan = {
      cells: { a: { 20: '早', 21: '早' }, b: { 20: '休', 21: '遅' }, c: { 20: '(21', 21: '7)' }, d: { 20: '日1', 21: '日1' } },
      subCells: { d: { 施設: { 20: '9-12' } } },
    }
    const src = { staff: roster, symbols: SYM, months: { '2026-11': { plan, actual: null } } }
    const staff = [
      { id: 1, name: '早番01', hire_order: 1 },
      { id: 2, name: '遅番01', hire_order: 2 },
      { id: 3, name: '夜勤01', hire_order: 3 },
      { id: 4, name: 'デイ01', hire_order: 4 },
    ]
    const fac = D.buildFacilityDutyTable(src, ['2026-11-20', '2026-11-21', '2026-11-22'])
    const dayKeys = new Set(['デイ01'])
    const rosterKeys = new Set(roster.map((r) => r.name))
    const panel = (day, today, checked = []) =>
      R.buildCheckPanel({ day, today, staff, duty: fac, checkedIds: new Set(checked), rosterKeys, dayKeys })
    it('今日の日報の確認欄は夜勤入りの人だけ（日勤の人は前日までの日報に並ぶ）', () => {
      const p = panel('2026-11-20', '2026-11-20')
      assert.equal(p.source, 'shift')
      assert.deepEqual(p.members.map((m) => [m.name, m.why]), [['夜勤01', 'night']])
      assert.equal(p.isToday, true)
    })
    it('前日の日報の確認欄は、その日の夜勤入りの人と翌日に日勤の人（早番・遅番を含む）・デイ職員は並ばない', () => {
      const p = panel('2026-11-20', '2026-11-21')
      assert.deepEqual(p.members.map((m) => [m.name, m.why]), [['早番01', 'day'], ['遅番01', 'day'], ['夜勤01', 'night']])
    })
    // 2026-11-19 代表者の指示（今日の確認欄に、読む番でないのに ✔ の付いた人が別に出ていた＝他者と同様に）で、
    // 前の決まり「✔ を付けた人は並びの外でも並ぶ」を改めた（意図を変えた書き換え）
    it('✔ を付けただけの人は、読む番でなければ並ばない（ほかの職員と同じ）', () => {
      const p = panel('2026-11-20', '2026-11-20', [1])
      assert.deepEqual(p.members.map((m) => [m.name, m.why, m.checked]), [['夜勤01', 'night', false]])
    })
    it('翌日の勤務表が無い・勤務表が読めない時は、デイ職員を除く名簿の全員を並べる', () => {
      const p = R.buildCheckPanel({ day: '2026-11-20', today: '2026-11-21', staff, duty: null, checkedIds: new Set(), rosterKeys, dayKeys })
      assert.equal(p.source, 'fallback')
      assert.deepEqual(p.members.map((m) => m.name), ['早番01', '遅番01', '夜勤01'])
    })
    it('勤務表の名簿に名前が無い職員（取り込んだ人）も確認欄に並ぶ（✔ を付けられなくならない）', () => {
      const st2 = [...staff, { id: 9, name: '表記違い01', hire_order: 9 }, { id: 10, name: '手で足した01', hire_order: null }]
      const p = R.buildCheckPanel({ day: '2026-11-20', today: '2026-11-20', staff: st2, duty: fac, checkedIds: new Set(), rosterKeys, dayKeys })
      assert.deepEqual(p.members.map((m) => [m.name, m.why]), [['夜勤01', 'night'], ['表記違い01', 'nomatch']])
    })
    it('翌日の勤務表がまだ無い日は、その日に施設で勤務の人を並べる（nonext）', () => {
      const f2 = D.buildFacilityDutyTable(src, ['2026-11-20'])
      const p = R.buildCheckPanel({ day: '2026-11-20', today: '2026-11-21', staff, duty: f2, checkedIds: new Set(), rosterKeys, dayKeys })
      assert.equal(p.source, 'nonext')
      assert.deepEqual(p.members.map((m) => [m.name, m.why]), [['早番01', 'sameday'], ['夜勤01', 'night']])
    })
    it('出勤の時刻より前でも、昨日のセルが読めない人がいる日は「判定できない日」に数える', () => {
      const p2 = { cells: { ...plan.cells, a: { 20: 'ABC', 21: '早' } }, subCells: plan.subCells }
      const f2 = D.buildFacilityDutyTable({ ...src, months: { '2026-11': { plan: p2, actual: null } } }, ['2026-11-20', '2026-11-21'])
      const s = R.buildUnreadSummary({ today: '2026-11-21', staff, duty: f2, checks: new Map([['2026-11-20', new Set([3])]]), rosterKeys, dayKeys, nowMin: 6 * 60 })
      assert.ok(s.undeterminedDays.includes('2026-11-20'))
    })
    it('まだ来ていない日・始める前の日は確認欄を出さない', () => {
      assert.equal(panel('2026-11-22', '2026-11-21').source, 'future')
      // 2026-11-19: 確認欄は始めた日の前日（11-18）から出すので、出さないのは 11-17 より前
      assert.equal(panel('2026-11-17', '2026-11-21').source, 'before')
    })
    it('休み明けの出勤の日の人は、出勤の時刻より後に未読者に名前が出る', () => {
      const empty = new Map([['2026-11-19', new Set()], ['2026-11-20', new Set()]])
      const at = (h) => R.buildUnreadSummary({ today: '2026-11-21', staff, duty: fac, checks: empty, rosterKeys, dayKeys, nowMin: h * 60 }).byDay.get('2026-11-20')
      assert.deepEqual([...at(6)].sort(), [3], '6時: 夜勤01 だけ（早番01 は7時から・遅番01 は11時から）')
      assert.deepEqual([...at(7)].sort(), [1, 3], '7時: 早番01 も')
      assert.deepEqual([...at(11)].sort(), [1, 2, 3], '11時: 休み明けの遅番01 も')
      assert.equal([...at(11)].includes(4), false, 'デイ職員は出ない')
    })
  })

  describe('出勤の30分前から名前を出す・前日の確認欄・施設長（2026-11-19 代表者の指示・現場の端末で見た後）', () => {
    const SYM = [
      { code: '早', type: 'work', start: '07:00' },
      { code: '遅', type: 'work', start: '11:00' },
      { code: '(21', type: 'nightIn', start: '21:00' },
      { code: '7)', type: 'nightOut' },
      { code: '休', type: 'off' },
    ]
    const roster = [
      { id: 'a', name: '早番01', mainDivision: '施設' },
      { id: 'b', name: '遅番01', mainDivision: '施設' },
      { id: 'c', name: '夜勤01', mainDivision: '施設' },
      { id: 'e', name: '休み01', mainDivision: '施設' },
      { id: 'm', name: '施設長01', mainDivision: '施設' },
    ]
    // 18日: 夜勤01 (21／19日: 早番01 早・遅番01 遅・夜勤01 7)・休み01 休・夜勤02 なし／19日夜: 早番01 は休み、遅番01 が (21
    const plan = {
      cells: {
        a: { 18: '早', 19: '早', 20: '休' },
        b: { 18: '休', 19: '遅', 20: '7)' },
        c: { 18: '(21', 19: '7)', 20: '休' },
        e: { 18: '休', 19: '休', 20: '早' },
        m: { 18: '休', 19: '休', 20: '休' },
      },
      subCells: { b: { 施設: { 19: '(21' } } },
    }
    const src = { staff: roster, symbols: SYM, months: { '2026-11': { plan, actual: null } } }
    const staff = [
      { id: 1, name: '早番01', hire_order: 1 },
      { id: 2, name: '遅番01', hire_order: 2 },
      { id: 3, name: '夜勤01', hire_order: 3 },
      { id: 5, name: '休み01', hire_order: 5 },
      { id: 9, name: '施設長01', hire_order: 9 },
    ]
    const fac = D.buildFacilityDutyTable(src, ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'])
    const rosterKeys = new Set(roster.map((r) => r.name))
    const panel = (day, h, extra = {}) =>
      R.buildCheckPanel({ day, today: '2026-11-19', staff, duty: fac, checkedIds: new Set(), rosterKeys, dayKeys: new Set(), nowMin: h * 60, ...extra })
    const names = (p) => p.members.map((m) => [m.name, m.why])
    it('不具合の再現: 始めた日（11-19）に前日（11-18）の確認欄が出ていなかった＝出す（前日の夜勤入りの人と、今日の出勤の30分前を過ぎた日勤の人）', () => {
      const p = panel('2026-11-18', 12)
      assert.equal(p.source, 'shift')
      assert.deepEqual(names(p), [['早番01', 'day'], ['遅番01', 'day'], ['夜勤01', 'night']])
    })
    it('日勤の人は翌日の出勤の30分前から前日の確認欄に並ぶ（早番 7:00 → 6:30・遅番 11:00 → 10:30）', () => {
      assert.deepEqual(names(panel('2026-11-18', 6)), [['夜勤01', 'night']])
      assert.deepEqual(names(panel('2026-11-18', 6.5)), [['早番01', 'day'], ['夜勤01', 'night']])
      assert.deepEqual(names(panel('2026-11-18', 10.5)), [['早番01', 'day'], ['遅番01', 'day'], ['夜勤01', 'night']])
    })
    it('夜勤の人は入りの30分前から当日の確認欄に並ぶ（21:00 → 20:30）', () => {
      assert.deepEqual(names(panel('2026-11-19', 20)), [])
      assert.deepEqual(names(panel('2026-11-19', 20.5)), [['遅番01', 'night']])
    })
    it('休みの人は、休み明けの出勤の30分前にその前日の確認欄に並ぶ', () => {
      const p = R.buildCheckPanel({ day: '2026-11-19', today: '2026-11-20', staff, duty: fac, checkedIds: new Set(), rosterKeys, dayKeys: new Set(), nowMin: 6 * 60 + 29 })
      assert.equal(p.members.some((m) => m.name === '休み01'), false, '6:29 はまだ')
      const q = R.buildCheckPanel({ day: '2026-11-19', today: '2026-11-20', staff, duty: fac, checkedIds: new Set(), rosterKeys, dayKeys: new Set(), nowMin: 6 * 60 + 30 })
      assert.ok(q.members.some((m) => m.name === '休み01' && m.why === 'day'), '6:30 から')
    })
    // 2026-11-19 代表者の指示（施設長をほかの職員と同じ扱いにする）で、施設長だけの特別扱い（いつも並べる・未読に数えない）をやめた。
    // 下の2つは前の決まり（PR #126）の試験を、新しい決まりに合わせて書き換えたもの（意図を変えた＝固定し直しではない）
    it('施設長もほかの職員と同じ: 勤務の無い日は確認欄に並ばない（managerId を渡しても特別扱いしない）', () => {
      assert.deepEqual(names(panel('2026-11-19', 8, { managerId: 9 })), [])
      assert.equal(names(panel('2026-11-18', 3, { managerId: 9 })).some(([n]) => n === '施設長01'), false)
    })
    it('施設長もほかの職員と同じ: 勤務表で日勤に入っていれば読む番から並び、✔ が無ければ未読に数える', () => {
      const st2 = [...staff, { id: 10, name: '早番02', hire_order: 10 }]
      const r2 = [...roster, { id: 'f', name: '早番02', mainDivision: '施設' }]
      const p2 = { cells: { ...plan.cells, f: { 18: '早', 19: '早' } }, subCells: plan.subCells }
      const f2 = D.buildFacilityDutyTable({ ...src, staff: r2, months: { '2026-11': { plan: p2, actual: null } } }, ['2026-11-18', '2026-11-19', '2026-11-20'])
      const s = R.buildUnreadSummary({ today: '2026-11-19', staff: st2, duty: f2, checks: new Map(), rosterKeys: new Set(r2.map((r) => r.name)), dayKeys: new Set(), nowMin: 10 * 60, managerId: 10 })
      assert.equal(s.byDay.get('2026-11-18').has(10), true)
      assert.ok(s.people.some((p) => p.id === 10))
      const p = R.buildCheckPanel({ day: '2026-11-18', today: '2026-11-19', staff: st2, duty: f2, checkedIds: new Set(), rosterKeys: new Set(r2.map((r) => r.name)), dayKeys: new Set(), nowMin: 10 * 60, managerId: 10 })
      assert.ok(p.members.some((m) => m.id === 10 && m.why === 'day'))
    })
    it('施設長の特別扱いの印（manager）は画面にも判定にも残っていない', () => {
      assert.doesNotMatch(read('../src/lib/readCheck.ts'), /managerId|'manager'/)
      assert.doesNotMatch(read('../src/pages/DailySheetPage.tsx'), /managerId: managerStaffId/)
    })
    it('今日の日報は日勤の番を数えない（23:30 以降でも、翌日 0 時台の出勤の人を今日の未読に出さない・確認欄とそろえる）', () => {
      const SYM0 = [...SYM, { code: '深', type: 'work', start: '00:00' }]
      const p3 = { cells: { ...plan.cells, a: { 18: '早', 19: '早', 20: '深' } }, subCells: plan.subCells }
      const f3 = D.buildFacilityDutyTable({ ...src, symbols: SYM0, months: { '2026-11': { plan: p3, actual: null } } }, ['2026-11-18', '2026-11-19', '2026-11-20'])
      const s = R.buildUnreadSummary({ today: '2026-11-19', staff, duty: f3, checks: new Map(), rosterKeys, dayKeys: new Set(), nowMin: 23 * 60 + 45 })
      assert.equal(s.byDay.get('2026-11-19').has(1), false)
      const p = R.buildCheckPanel({ day: '2026-11-19', today: '2026-11-19', staff, duty: f3, checkedIds: new Set(), rosterKeys, dayKeys: new Set(), nowMin: 23 * 60 + 45 })
      assert.equal(p.members.some((m) => m.id === 1), false)
    })
    // 2026-11-19 代表者の指示「夜勤者は当日日中の分から確認する。18日の分はすでに未読」で意図を変えた: 前日（11-18）の夜勤の分も数える
    // （以前はこの検査で「公開より前に番が来た前日の夜勤は数えない」を固定していた）
    it('未読者: 前日（11-18）の夜勤の人はその日の夜勤入りの30分前から数え、今日の朝の日勤の人・今夜の夜勤の人は番が来てから数える', () => {
      const at = (h) => R.buildUnreadSummary({ today: '2026-11-19', staff, duty: fac, checks: new Map(), rosterKeys, dayKeys: new Set(), nowMin: h * 60 })
      const s8 = at(8)
      assert.deepEqual([...s8.byDay.get('2026-11-18')].sort(), [1, 3], '8時: 早番01 と夜勤01（11-18 の 20:30 に番が来た＝夜勤は当日の分から）。遅番01 は 10:30 から')
      assert.deepEqual([...s8.byDay.get('2026-11-19')], [], '今日の日報は夜勤の番の前')
      const s21 = at(21)
      assert.deepEqual([...s21.byDay.get('2026-11-18')].sort(), [1, 2, 3])
      assert.deepEqual([...s21.byDay.get('2026-11-19')], [2], '21時: 今夜の夜勤（遅番01 の (21）は 20:30 から')
      assert.deepEqual(s21.undeterminedDays, [])
      const f2 = D.buildFacilityDutyTable(src, ['2026-11-18', '2026-11-19'])
      const s2 = R.buildUnreadSummary({ today: '2026-11-19', staff, duty: f2, checks: new Map(), rosterKeys, dayKeys: new Set(), nowMin: 21 * 60 })
      assert.equal(s2.undeterminedDays.includes('2026-11-19'), false, '今日の日報は翌日の勤務表が無くても数えられる')
    })
  })

  // 2026-11-19 訂正（代表者の指示「施設長だけが確認欄に表示されている」の原因）: 住宅型のため、施設で早番・遅番・日勤・夜勤に入る職員の
  // 多くは主の区分が訪問で、主の欄に施設の勤務が入っている。訪問の応援の欄にも夜勤入りがある。前は主の区分が施設の人の主の欄と
  // 施設の応援の欄しか見ていなかった。新しい決まり: 主の区分が通所でない人の主の欄と、通所以外の全区分の応援の欄
  describe('施設の勤務の数え方（主の区分が訪問の人も数える・2026-11-19 訂正）', () => {
    const roster = [
      { id: 'v', name: '職員01', mainDivision: '訪問' },
      { id: 'w', name: '職員02', mainDivision: '訪問' },
      { id: 'c', name: 'デイ01', mainDivision: '通所' },
      { id: 'm', name: '施設長01', mainDivision: '施設' },
      { id: 'x', name: '職員03', mainDivision: '施設' },
      { id: 'n', name: '職員04' },
    ]
    const plan = {
      cells: {
        v: { 1: '早', 2: '遅' },
        w: { 1: '', 2: '休' },
        c: { 1: '日1', 2: '日1' },
        m: { 1: '日1', 2: '休' },
        x: { 1: '休', 2: '' },
        n: { 1: '日2', 2: '' },
      },
      subCells: {
        w: { 訪問: { 1: '(22' } },
        c: { 施設: { 1: '(22' }, 通所: { 2: '9-12' } },
        x: { 通所: { 1: '9-12', 2: '13-16' } },
      },
    }
    const SYM = [
      { code: '早', type: 'work', start: '07:00' },
      { code: '遅', type: 'work', start: '11:00' },
      { code: '日1', type: 'work', start: '09:00' },
      { code: '日2', type: 'work', start: '08:30' },
      { code: '(22', type: 'nightIn', start: '22:00' },
      { code: '休', type: 'off' },
    ]
    const src = { staff: roster, symbols: SYM, months: { '2026-12': { plan, actual: null } } }
    const t = D.buildFacilityDutyTable(src, ['2026-12-01', '2026-12-02'])
    const d1 = t.get('2026-12-01')
    const d2 = t.get('2026-12-02')
    it('主の区分が訪問で主の欄に早番・遅番がある人を数える（時刻も持つ）', () => {
      assert.equal(d1.get('職員01').work, true)
      assert.equal(d1.get('職員01').workStart, 7 * 60)
      assert.equal(d2.get('職員01').work, true)
      assert.equal(d2.get('職員01').workStart, 11 * 60)
    })
    it('訪問の応援の欄（subCells 訪問）の夜勤入りを数える', () => {
      assert.equal(d1.get('職員02').nightIn, true)
      assert.equal(d1.get('職員02').nightStart, 22 * 60)
      assert.equal(d2.get('職員02').nightIn, false)
    })
    it('主の区分が通所の人は数えない（施設の応援の欄があっても）', () => {
      assert.equal(d1.has('デイ01'), false)
      assert.equal(d2.has('デイ01'), false)
    })
    it('通所の応援の欄（subCells 通所）は数えない', () => {
      assert.deepEqual([d1.get('職員03').work, d1.get('職員03').nightIn], [false, false], '1日は主の欄が休み・通所の応援だけ')
      assert.deepEqual([d2.get('職員03').work, d2.get('職員03').nightIn], [false, false])
    })
    it('主の区分が施設の人（施設長も）と、主の区分が無い人（施設とみなす）は今までどおり数える', () => {
      assert.equal(d1.get('施設長01').work, true)
      assert.equal(d2.get('施設長01').work, false)
      assert.equal(d1.get('職員04').work, true)
      assert.equal(d1.get('職員04').workStart, 8 * 60 + 30)
    })
    it('未読者・確認欄にも主の区分が訪問の人が並ぶ（施設長だけにならない）', () => {
      const staff = [
        { id: 1, name: '職員01', hire_order: 1 },
        { id: 2, name: '職員02', hire_order: 2 },
        { id: 9, name: '施設長01', hire_order: 9 },
      ]
      const p = R.buildCheckPanel({ day: '2026-12-01', today: '2026-12-02', staff, duty: t, checkedIds: new Set(), rosterKeys: new Set(roster.map((r) => r.name)), dayKeys: new Set(['デイ01']), nowMin: 12 * 60 })
      assert.deepEqual(p.members.map((m) => [m.name, m.why]), [['職員01', 'day'], ['職員02', 'night']])
    })
  })

  describe('静的検査', () => {
    it('未読の日へ移った後、目的の日の頭に合わせ続ける（上の日が描かれてずれても日の頭へ・2026-11-19 代表者の指示）', () => {
      const page = read('../src/pages/DailySheetPage.tsx')
      assert.match(page, /const JUMP_HOLD_MS = 2500/)
      assert.match(page, /jumpRef\.current = \{ day: next, until: Date\.now\(\) \+ JUMP_HOLD_MS \}/)
      assert.match(page, /window\.addEventListener\('pointerdown', stop, \{ passive: true \}\)/)
    })
    const comp = read('../src/components/DailyReadCheck.tsx')
    const page = read('../src/pages/DailySheetPage.tsx')
    const db = read('../src/lib/db.ts')
    // 2026-11-19 確認欄の出し方（0066）: 代表者の指示で、未読者をページの上から確認欄の下の〔未読者〕へ移し、
    // 日付を押した時の飛び先を確認欄から「その日の申送の頭」へ変えた。下の5つは移した後の形を確かめる（前の形の検査は置き換えた）
    it('確認欄は画面だけ（紙の日報を変えない）・夜勤の枠より左右に細い', () => {
      assert.match(comp, /<section\s+id=\{`readcheck-\$\{day\}`\}\s+className="dsheet-readcheck print:hidden/)
      const css = read('../src/styles/sheet.css')
      const sec = css.slice(css.indexOf('.dsheet-body > section.dsheet-readcheck'))
      assert.match(sec, /margin-left: calc\(var\(--sp-6\) \+ var\(--sheet-rule-bold\)\)/, '夜勤（--sp-4）より内側')
      assert.match(css.slice(0, css.indexOf('.dsheet-body > section.dsheet-readcheck')), /@media screen \{\s*$/, '画面だけ')
    })
    it('確認欄のボタンの赤は、未読者と同じ数え方（親から渡す日ごとの未読）で、✔ のある人には出さない', () => {
      assert.match(comp, /const unread = !m\.checked && unreadIds\.has\(m\.id\)/)
      assert.match(page, /unreadIds=\{unreadSummary\?\.byDay\.get\(d\) \?\? NO_UNREAD\}/)
    })
    it('〔未読者〕は確認欄の下にあり、押すまで氏名を出さない・氏名の右に未読の日付・日付を押すとその日へ', () => {
      const sec = comp.slice(comp.indexOf('function UnreadButton'), comp.indexOf('type Pending'))
      const closed = sec.slice(0, sec.indexOf('{open && n > 0 && ('))
      assert.doesNotMatch(closed, /\.name/, '開く前の部分に氏名を使っていない')
      assert.match(sec, /aria-expanded=\{open\}/)
      assert.match(sec, /\{p\.name\}<\/span>\s+\{\/\*[^*]*\*\/\}\s+<span className="flex flex-1 flex-wrap gap-1">\s+\{p\.days\.map/, '氏名の右に日付（右側の中で折り返す）')
      assert.match(sec, /onClick=\{\(\) => onPickDay\(d\)\}/)
      assert.match(sec, /useState\(false\)/, '開いた状態は覚えない（毎回閉じて始まる）')
      const panel = comp.slice(comp.indexOf('export function ReadCheckPanel'))
      assert.ok(panel.indexOf('<UnreadButton') > panel.indexOf('</ul>'), '名前の ✔ の下')
      assert.match(panel, /\{showUnread && <UnreadButton /, '10日表示でも1つだけ')
      assert.match(page, /showUnread=\{d === unreadHost\}/)
    })
    // 2026-11-19 代表者の指示「未読者の表示を直す」: この日の日報が読み込み中・失敗の間も〔未読者〕を出す
    it('日報の読み込み中・失敗の間も〔未読者〕だけは出す（確認欄は読み終えてから）', () => {
      const only = comp.slice(comp.indexOf('export function UnreadOnlyPanel'), comp.indexOf('type Pending'))
      assert.match(only, /if \(!unreadShown\(summary, unreadSource\)\) return null/, '出すものが無い時は空の枠を出さない')
      assert.match(only, /className="dsheet-readcheck print:hidden/, '画面だけ・確認欄と同じ細い枠')
      assert.match(only, /<UnreadButton summary=\{summary\} source=\{unreadSource\} onPickDay=\{onPickDay\} \/>/)
      const panelSec = comp.slice(comp.indexOf('export function ReadCheckPanel'))
      assert.match(
        panelSec,
        /if \(panel\.source === 'future' \|\| panel\.source === 'before'\)\s+return showUnread \? <UnreadOnlyPanel /,
        '確認欄を出さない日でも、読み終えた後に〔未読者〕が消えない',
      )
      assert.match(page, /\{phase !== 'ready' && showUnread && \(\s+<UnreadOnlyPanel summary=\{unreadSummary\} unreadSource=\{unreadSource\} onPickDay=\{onPickUnread\} \/>/)
    })
    it('未読の日付を押すと、その日の申送の頭へ移る（すぐ読めるように）', () => {
      const sec = page.slice(page.indexOf('const goUnreadDay'), page.indexOf('const goUnit = useCallback('))
      assert.match(sec, /scrollToDay\(next\)\s+\} else goDay\(next\)/)
      assert.doesNotMatch(page, /readCheckTargetRef|UnreadSummaryBanner/)
    })
    it('日報の枠の末尾に確認欄を置き、確認欄に並ぶ人は buildCheckPanel で決める', () => {
      assert.match(page, /<ReadCheckPanel\s+day=\{day\}\s+panel=\{checkPanel\}/)
      assert.match(page, /buildCheckPanel\(\{/)
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
