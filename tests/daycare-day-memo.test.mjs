// デイの「その日の一覧」の控え（画面のメモリだけ・2026-10-24 親の検収 中1）の回帰テスト。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycareDayMemo.ts）: 通信の失敗の時だけ・同じ日の控えだけを使う。サーバーの拒否・権限では使わない
// 2. 静的検査: 控えは端末の保存（localStorage など）に置かない。今日の画面と1人の画面が控えを書き、1人の画面は読み込みの失敗の時だけ使う
// 個人情報は置かない（利用者は数値IDだけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const M = await import('../src/lib/daycareDayMemo.ts')

const memoOf = (day, extra = {}) => ({
  day,
  planRows: [],
  planSource: 'kv',
  snapshot: null,
  missing: false,
  attendance: [{ id: 1, resident_id: 3, day, arrived_at: null, left_at: null, absent: false, absent_reason: null, note: null, recorded_by: null, rev: 1 }],
  baths: [],
  vitals: [],
  meals: [],
  fluids: [],
  residents: [{ id: 3, name: 'x', kana: null }],
  savedAt: 1,
  ...extra,
})

describe('純ロジック', () => {
  it('使うのは通信の失敗の時だけ・同じ日の控えだけ（別の日・サーバーの拒否・権限・設定待ちでは使わない）', () => {
    const m = memoOf('2026-10-24')
    const network = Object.assign(new Error('通信できません'), { kind: 'network' })
    assert.equal(M.memoForDay(m, '2026-10-24', network), m)
    assert.equal(M.memoForDay(m, '2026-10-24', new TypeError('Failed to fetch')), m, 'fetch の失敗も通信の失敗')
    assert.equal(M.memoForDay(m, '2026-10-23', network), null, '別の日の控えは使わない')
    for (const kind of ['server', 'auth', 'forbidden', 'blocked', 'unconfigured', 'gate-unknown'])
      assert.equal(M.memoForDay(m, '2026-10-24', Object.assign(new Error(kind), { kind })), null, kind)
    assert.equal(M.memoForDay(null, '2026-10-24', network), null)
    assert.equal(M.memoForDay(m, '2026-10-24', null), null)
  })
  it('控えは1日分だけ。名簿が空の時は前の控えの名簿を残す（1人の画面が名簿を読めないまま控えを書いても氏名を失わない）', () => {
    M.clearDaycareDayMemo()
    assert.equal(M.daycareDayMemo(), null)
    M.rememberDaycareDay(memoOf('2026-10-23'))
    M.rememberDaycareDay(memoOf('2026-10-24', { residents: [] }))
    const now = M.daycareDayMemo()
    assert.equal(now.day, '2026-10-24')
    assert.deepEqual(now.residents.map((r) => r.id), [3])
    M.clearDaycareDayMemo()
  })
})

describe('静的検査', () => {
  const memo = code('../src/lib/daycareDayMemo.ts')
  const today = code('../src/pages/DaycarePage.tsx')
  const person = code('../src/pages/DaycarePersonPage.tsx')
  it('控えは端末の保存に置かない（画面のメモリだけ）', () => {
    assert.doesNotMatch(memo, /localStorage|sessionStorage|indexedDB|IDBDatabase/)
    assert.match(memo, /^let memo: DaycareDayMemo \| null = null$/m)
  })
  it('今日の画面と1人の画面がサーバーから読めた一覧を控える。1人の画面は控えで開いた時・食事が読めない時は控えない', () => {
    assert.match(today, /rememberDaycareDay\(\{\s*day: data\.day,/)
    assert.match(person, /if \(data === null \|\| data\.memoAt !== null \|\| !data\.intakeOk \|\| data\.missing\) return\s*rememberDaycareDay\(/)
  })
  it('1人の画面は読み込みの失敗の時だけ、同じ日の控えで開く（静かな読み直しの失敗では今の内容を残す）・帯で知らせる・名簿も控えから', () => {
    assert.match(person, /const m = memoForDay\(daycareDayMemo\(\), target, e\)\s*if \(m !== null && target === dayRef\.current && !quiet\) \{/)
    assert.match(person, /memoAt: m\.savedAt,/)
    assert.match(person, /電波が無いため、今日の一覧で読んだ時点（/)
    assert.match(person, /押した記録は送信待ちに積みます/)
    assert.match(person, /const m = daycareDayMemo\(\)\s*if \(alive && m !== null && m\.residents\.length > 0\) setResidents/)
    // 1人の値はその方の residentId で選ぶ（控えは1日分の一覧。別の方の値を使わない）
    assert.match(person, /const row = board\?\.rows\.find\(\(r\) => r\.residentId === residentId\)/)
  })
  it('今日の画面は1人の画面の部品を先に読んでおく（電波がある時だけ）', () => {
    assert.match(today, /if \(typeof navigator !== 'undefined' && navigator\.onLine === false\) return\s*void import\('\.\/DaycarePersonPage'\)\.catch\(\(\) => undefined\)/)
  })
  it('食事・水分が読めない時はその欄だけ止める（出欠・入浴の操作は動かす＝親の検収 軽3）', () => {
    assert.match(person, /fetchDaycareIntake\(target\)\.catch\(\(\) => null\)/)
    assert.match(person, /intakeOk: intake !== null,/)
    assert.match(person, /const intakeWritable = canWrite && data\.intakeOk/)
    assert.match(person, /if \(data !== null && !data\.intakeOk\) return MSG_INTAKE_FAILED/)
    assert.doesNotMatch(person, /disabled=\{!canWrite\}/, '食事・水分の欄は intakeWritable で止める')
    // 出欠・入浴の操作は食事の読み込みに左右されない
    assert.match(person, /const opsDisabled = !canWrite \|\| ops\.busy\.has\(residentId\) \|\| attPending/)
  })
})
