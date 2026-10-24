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
  intakeOk: true,
  residents: [{ id: 3, name: 'x', kana: null }],
  savedAt: 1,
  ...extra,
})

describe('純ロジック', () => {
  it('使うのは通信の失敗の時だけ・同じ日の控えだけ（別の日・サーバーの拒否・権限・設定待ちでは使わない）', () => {
    const m = memoOf('2026-10-24')
    const network = Object.assign(new Error('通信できません'), { kind: 'network' })
    assert.equal(M.memoForDay(m, '2026-10-24', network), m)
    // 確認の反証 軽4: 素の TypeError（コードの不具合）は控えで隠さない（fetch の失敗は db.ts が network に直す）
    assert.equal(M.memoForDay(m, '2026-10-24', new TypeError('x is not a function')), null)
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

describe('書けた記録を控えにも映す（親の確かめ 中2・2026-10-25）', () => {
  const att = (id, rid, day, extra = {}) => ({ id, resident_id: rid, day, arrived_at: null, left_at: null, absent: false, absent_reason: null, note: null, recorded_by: null, rev: 1, ...extra })
  it('A さんの到着 → 別の方を開く → A さんへ戻る: 控えに到着が残る（同じ方の古い行は置き換え・別の方の行は触らない）', () => {
    M.clearDaycareDayMemo()
    M.rememberDaycareDay(memoOf('2026-10-22', { attendance: [att(1, 3, '2026-10-22'), att(2, 4, '2026-10-22')] }))
    // A（3）の到着が書けた（行の id が同じ・rev が上がった）
    M.updateDaycareDayMemo((m) => M.memoWithAttendance(m, att(1, 3, '2026-10-22', { arrived_at: '09:30', rev: 2 })))
    // 別の方（4）の画面を控えで開いても、A の行はそのまま
    const now = M.daycareDayMemo()
    assert.deepEqual(now.attendance.map((a) => [a.resident_id, a.arrived_at, a.rev]).sort(), [[3, '09:30', 2], [4, null, 1]])
    // 行が無かった方の初めての行（id が新しい）も足す
    M.updateDaycareDayMemo((m) => M.memoWithAttendance(m, att(9, 5, '2026-10-22', { absent: true, absent_reason: 'later' })))
    assert.equal(M.daycareDayMemo().attendance.filter((a) => a.resident_id === 5).length, 1)
    // 取り消した行は外す
    M.updateDaycareDayMemo((m) => M.memoWithoutAttendance(m, att(9, 5, '2026-10-22')))
    assert.equal(M.daycareDayMemo().attendance.some((a) => a.resident_id === 5), false)
    M.clearDaycareDayMemo()
  })
  it('控えの日と違う日の記録は触らない・控えが無ければ何もしない', () => {
    const m = memoOf('2026-10-22')
    assert.equal(M.memoWithAttendance(m, att(7, 3, '2026-10-23', { arrived_at: '09:30' })), m)
    assert.equal(M.memoWithoutAttendance(m, att(1, 3, '2026-10-23')), m)
    const bath = { id: 5, resident_id: 3, bath_on: '2026-10-23', result: 'full', cancel_reason: null, auto: false, note: null, recorded_by: null, rev: 1 }
    assert.equal(M.memoWithBath(m, bath), m)
    const bath22 = { ...bath, bath_on: '2026-10-22' }
    assert.deepEqual(M.memoWithBath(m, bath22).baths, [bath22])
    M.clearDaycareDayMemo()
    M.updateDaycareDayMemo((x) => M.memoWithAttendance(x, att(1, 3, '2026-10-22')))
    assert.equal(M.daycareDayMemo(), null)
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
  it('今日の画面と1人の画面がサーバーから読めた一覧を控える。食事・水分が読めたかも控える（読めない空の一覧を「読めた」にしない＝確認の反証 中1）', () => {
    assert.match(today, /rememberDaycareDay\(\{\s*day: data\.day,/)
    assert.match(today, /fetchDaycareIntake\(target\)\.catch\(\(\) => null\)/)
    assert.match(today, /intakeOk: intake !== null,/)
    assert.match(today, /fluids: data\.fluids,\s*intakeOk: data\.intakeOk,/)
    assert.match(person, /if \(data === null \|\| data\.memoAt !== null \|\| !data\.intakeOk \|\| data\.missing\) return\s*rememberDaycareDay\(/)
    assert.match(person, /intakeOk: m\.intakeOk,\s*memoAt: m\.savedAt,/)
  })
  it('控えはログアウト・ログインのし直しで捨てる（次の人に前の人の控えを見せない＝確認の反証 軽2）', () => {
    const c = code('../src/lib/cachedReads.ts')
    assert.match(c, /export function resetDataCache\(\): void \{\s*dataCache\.clearAll\(\)\s*clearDaycareDayMemo\(\)/)
  })
  it('控えで開いている間は30秒ごとに静かに読み直す（電波が「切れた」と扱われないまま戻っても帯を消す＝確認の反証 軽3）', () => {
    assert.match(person, /if \(!onMemo\) return\s*const t = window\.setInterval\(\(\) => scheduleReload\(\), 30_000\)/)
  })
  it('静かな読み直しで食事・水分だけ読めない時は今の食事・水分を残し、消し込みは読めた時だけ（確認の反証 中2）', () => {
    assert.match(person, /const keep = intake === null && quiet && prev !== null && prev\.day === target && prev\.intakeOk/)
    assert.match(person, /fluids: intake\?\.fluids \?\? \(keep \? prev\.fluids : \[\]\),\s*intakeOk: intake !== null \|\| keep,/)
    assert.match(person, /if \(data === null \|\| !data\.intakeOk\) return\s*const visible = data\.fluids\.filter/)
    assert.match(person, /if \(data === null \|\| !data\.intakeOk \|\| !m\.key\.endsWith/)
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
  it('今日の画面も、読み込みの失敗の時だけ同じ日の控えで開き、同じ帯を出す・控えで開いた時は控えを書き直さない（親の確かめ 中1）', () => {
    assert.match(today, /const m = memoForDay\(daycareDayMemo\(\), target, e\)\s*if \(m !== null && target === dayRef\.current && !quiet\) \{/)
    assert.match(today, /activities: null,\s*intakeOk: m\.intakeOk,\s*memoAt: m\.savedAt,/)
    assert.match(today, /電波が無いため、今日の一覧で読んだ時点（/)
    assert.match(today, /if \(data === null \|\| data\.missing \|\| data\.memoAt !== null\) return\s*rememberDaycareDay\(/)
    assert.match(today, /if \(!onMemo\) return\s*const t = window\.setInterval\(\(\) => scheduleReload\(\), 30_000\)/)
  })
  it('今日の画面と1人の画面は、書けた記録を画面の data と控えの両方に映す（putAttendance・dropAttendance・putBath・親の確かめ 中2）', () => {
    for (const x of [today, person]) {
      assert.match(x, /putAttendance: \(r\) => \{\s*updateDaycareDayMemo\(\(m\) => memoWithAttendance\(m, r\)\)/)
      assert.match(x, /dropAttendance: \(saved\) => \{\s*updateDaycareDayMemo\(\(m\) => memoWithoutAttendance\(m, saved\)\)/)
      assert.match(x, /putBath: \(r\) => \{\s*updateDaycareDayMemo\(\(m\) => memoWithBath\(m, r\)\)/)
    }
  })
  it('送信待ちの到着がある方は、控えで戻っても〔到着〕を押せない（同じ方・同じ日の追加の送信待ちを見る＝2件目を積まない）', () => {
    const db = code('../src/lib/db.ts')
    assert.match(db, /if \(q\.kind === 'insert'\) \{\s*if \(idNum\(q\.payload\.resident_id\) === residentId && dateStr\(q\.payload\.day\) === day\) return true/)
    assert.match(person, /const attPending = row !== undefined && hasPendingDaycareAttendance\(residentId, day, att\?\.id \?\? null\)/)
    assert.match(person, /const opsDisabled = !canWrite \|\| ops\.busy\.has\(residentId\) \|\| attPending/)
  })
  it('1人の画面の部品は App の先読み（PAGE_PRELOADS）で読んでおく（先読みの失敗を部品の取得失敗と見分けない守りに乗る＝確認の反証 軽1）', () => {
    const app = code('../src/App.tsx')
    const list = app.slice(app.indexOf('const PAGE_PRELOADS'), app.indexOf('\n]', app.indexOf('const PAGE_PRELOADS')))
    assert.match(list, /loadDaycarePage,\s*loadDaycarePersonPage,/)
    assert.doesNotMatch(today, /import\('\.\/DaycarePersonPage'\)/, '画面の中で別に読まない')
  })
  it('食事・水分が読めない時はその欄だけ止める（出欠・入浴の操作は動かす＝親の検収 軽3）', () => {
    assert.match(person, /fetchDaycareIntake\(target\)\.catch\(\(\) => null\)/)
    assert.match(person, /intakeOk: intake !== null \|\| keep,/)
    assert.match(person, /const intakeWritable = canWrite && data\.intakeOk/)
    assert.match(person, /if \(data !== null && !data\.intakeOk\) return MSG_INTAKE_FAILED/)
    assert.doesNotMatch(person, /disabled=\{!canWrite\}/, '食事・水分の欄は intakeWritable で止める')
    // 確認の反証 軽5: 読めない時は「記録なし」「0 ml」に見せない
    assert.match(person, /\{data\.intakeOk \? lunchLabel\(lunch\) : '—（読めませんでした）'\}/)
    assert.match(person, /\{data\.intakeOk \? snackLabel\(snack\) : '—（読めませんでした）'\}/)
    assert.match(person, /\{data\.intakeOk \? fmtMl\(fluidTotal\) : '—（読めませんでした）'\}/)
    // 出欠・入浴の操作は食事の読み込みに左右されない
    assert.match(person, /const opsDisabled = !canWrite \|\| ops\.busy\.has\(residentId\) \|\| attPending/)
  })
})
