// 申し送りの記入者を選ぶ窓に「この日の出勤者」を先に出す（2026-11-07 代表者の決定）の試験。架空データのみ（氏名は「職員01」など）。
//   ・日勤・デイ: その日の出勤者の欄に名前を入れた在籍の職員だけを、施設長 → 出勤者（欄の順）で出す
//   ・夜勤: 今までどおり全員（null）
//   ・出勤者が0人・取り消した行だけ・名簿に居ない職員だけの日: 全員（null）
//   ・ほかの日の行・退職者・重なりは出さない
//   ・画面: 記入者を選ぶ窓（StaffPickerModal）に primary を渡している（日報・申し送りの入力）。ほかの窓（出勤者・施設長・記録者）は変えない
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { attendanceStaff, reporterPrimary } from '../src/lib/reporterPick.ts'

const D = '2026-12-01'
const staff = [
  { id: 1, name: '職員01', active: true },
  { id: 2, name: '職員02', active: true },
  { id: 3, name: '職員03', active: true },
  { id: 4, name: '職員04', active: false },
  { id: 5, name: '職員05', active: true },
]
const att = [
  { day: D, staff_id: 3, role: 'staff', sort: 2 },
  { day: D, staff_id: 2, role: 'staff', sort: 1 },
  { day: D, staff_id: 5, role: 'manager', sort: 9 },
  { day: D, staff_id: 4, role: 'staff', sort: 0 }, // 退職者
  { day: D, staff_id: 1, role: 'staff', sort: -1 }, // 取り消した行
  { day: '2026-11-30', staff_id: 1, role: 'staff', sort: 0 }, // ほかの日
  { day: D, staff_id: 2, role: 'staff', sort: 3 }, // 重なり
  { day: D, staff_id: 99, role: 'staff', sort: 4 }, // 名簿に居ない
]
const ids = (l) => (l === null ? null : l.map((s) => s.id))

describe('この日の出勤者（attendanceStaff）', () => {
  it('施設長 → 出勤者（欄の順）。退職者・取り消し・ほかの日・重なり・名簿に居ない職員は出さない', () => {
    assert.deepEqual(ids(attendanceStaff(staff, att, D)), [5, 2, 3])
  })
  it('出勤者が居ない日は空', () => {
    assert.deepEqual(attendanceStaff(staff, att, '2026-12-02'), [])
  })
})

describe('記入者の窓に先に出す職員（reporterPrimary）', () => {
  it('日勤・デイはこの日の出勤者', () => {
    assert.deepEqual(ids(reporterPrimary('day', staff, att, D)), [5, 2, 3])
    assert.deepEqual(ids(reporterPrimary('daycare', staff, att, D)), [5, 2, 3])
  })
  it('夜勤は今までどおり全員（null）', () => {
    assert.equal(reporterPrimary('night', staff, att, D), null)
  })
  it('出勤者が0人の日・取り消しだけの日は全員（null）', () => {
    assert.equal(reporterPrimary('day', staff, att, '2026-12-02'), null)
    assert.equal(reporterPrimary('day', staff, [{ day: D, staff_id: 1, role: 'staff', sort: -1 }], D), null)
  })
  it('勤務帯が分からない時も出勤者を出す（夜勤と分かる時だけ外す）', () => {
    assert.deepEqual(ids(reporterPrimary(null, staff, att, D)), [5, 2, 3])
  })
})

describe('画面のつなぎ', () => {
  const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
  const ui = read('../src/components/ui.tsx')
  const sheet = read('../src/pages/DailySheetPage.tsx')
  const form = read('../src/pages/NoteFormPage.tsx')
  it('窓は先に出す職員が1人以上の時だけ絞り、「ほかの職員から選ぶ」で全員を出す。絞込語がある時は全員から探す', () => {
    assert.match(ui, /const primaryOnly = !showAll && kanaKey\(q\) === '' && Array\.isArray\(primary\) && primary\.length > 0/)
    assert.match(ui, /ほかの職員から選ぶ/)
    assert.match(ui, /setShowAll\(false\)/) // 閉じると戻る
  })
  it('日報: 記入者の窓だけに primary を渡す（出勤者・施設長の窓は null）', () => {
    assert.match(sheet, /staffPick\?\.for === 'noteReporter'\s*\?\s*reporterPrimary\(/)
    assert.match(sheet, /primary=\{reporterPick\}/)
  })
  it('申し送りの入力: 記録日の出勤者を読み、記録日が変わった時の古い分は使わない・夜勤は読まない', () => {
    assert.match(form, /pickAttendance\.day === form\.noteOn/)
    assert.match(form, /form\.shift === 'night'\) return/)
  })
})
