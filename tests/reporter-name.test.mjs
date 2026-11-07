// 申し送りの記入者に、職員の一覧に無い名前も書けるようにする（2026-11-07 本人指示・0058）の試験。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
// 個人情報は置かない（職員は数値IDと「職員01」、書いた名前は「応援 一」などの架空の名前だけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

let R = null
let G = null
let loadError = null
try {
  R = await import('../src/lib/reporterName.ts')
  G = await import('../src/lib/noteGroup.ts')
} catch (e) {
  loadError = e
}
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

describe('一覧に無い記入者の名前（reporterName.ts）', () => {
  if (R === null || G === null) {
    registerLoadFailure('一覧に無い記入者の名前', loadError, 'この Node では TypeScript を直接読み込めないため、記入者の名前の試験をスキップしました。')
    return
  }

  it('名前は前後の空白を除き、続く空白を1つにする。空・21字以上・文字でない時は null', () => {
    assert.equal(R.normalizeReporterName('  応援　 一 '), '応援 一')
    assert.equal(R.normalizeReporterName('一二三四五六七八九十一二三四五六七八九十'), '一二三四五六七八九十一二三四五六七八九十')
    assert.equal(R.normalizeReporterName('一二三四五六七八九十一二三四五六七八九十一'), null)
    assert.equal(R.normalizeReporterName('   '), null)
    assert.equal(R.normalizeReporterName(null), null)
    assert.equal(R.normalizeReporterName(3), null)
  })

  it('表示は職員の名前が先、無ければ書いた名前、どちらも無ければ空', () => {
    const name = (id) => ({ 1: '職員 01' })[id] ?? null
    assert.equal(R.reporterLabel({ reporter_id: 1, reporter_name: '応援 一' }, name), '職員 01')
    assert.equal(R.reporterLabel({ reporter_id: 9, reporter_name: null }, name), '職員ID 9')
    assert.equal(R.reporterLabel({ reporter_id: null, reporter_name: '応援 一' }, name), '応援 一')
    assert.equal(R.reporterLabel({ reporter_id: null }, name), '')
  })

  it('同じ記入者か: 職員は id、書いた名前は名前で比べる', () => {
    assert.equal(R.sameReporter({ reporter_id: 1 }, { reporter_id: 1, reporter_name: null }), true)
    assert.equal(R.sameReporter({ reporter_id: 1 }, { reporter_id: null, reporter_name: '職員 01' }), false)
    assert.equal(R.sameReporter({ reporter_id: null, reporter_name: '応援 一' }, { reporter_id: null, reporter_name: ' 応援 一' }), true)
    assert.equal(R.sameReporter({ reporter_id: null, reporter_name: null }, { reporter_id: null, reporter_name: null }), false)
  })

  it('日報の夜勤の欄でまとめた行: 書いた名前にも（姓）を付け、前と同じ名前なら紙に出さない印を付ける', () => {
    const note = (id, rid, rname) => ({
      id, note_on: '2026-11-01', shift: 'night', facility: null, category: null, resident_id: 1, role_tags: [], importance: 'normal',
      body: `本文${id}`, occurred_at: null, ongoing: false, ended_at: null, reporter_id: rid, reporter_name: rname, color: null, after16: false,
      categories: [], rev: 1,
    })
    const row = G.groupNotesByResident([note(1, 1, null), note(2, null, '応援 一'), note(3, null, '応援 一'), note(4, 1, null)])[0]
    const lines = G.noteGroupLines(row, (id) => ({ 1: '職員 01' })[id] ?? null)
    assert.deepEqual(lines.map((l) => [l.note.id, l.suffix, l.sameAsPrev]), [
      [1, '', false],
      [2, '（応援）', false],
      [3, '（応援）', true],
      [4, '（職員）', false],
    ])
  })

  it('書いた名前は端末の控えに残さない（日報の書きかけ・申し送りの入力の控え）', () => {
    const daily = read('src/pages/DailySheetPage.tsx')
    const dd = daily.slice(daily.indexOf('function draftData<'), daily.indexOf('function noteHasInput('))
    assert.match(dd, /if \(typeof r\.reporterName === 'string' && r\.reporterName !== ''\) r\.reporterNameLost = true\n\s*delete r\.reporterName/)
    // 戻した書きかけは、名前が消えた印があれば記入者を選び直すまで登録しない
    assert.match(daily, /if \(o\.reporterNameLost === true && reporterId === null\) out\.reporterNameLost = true/)
    assert.match(daily, /if \(cur0\.reporterNameLost === true && cur0\.reporterId === null && \(cur0\.reporterName \?\? null\) === null\) \{\n\s*patchNoteDraft\(key, \{ body \}\)\n\s*setRowStatus\(key, \{ tone: 'danger', text: MSG_REPORTER_NAME_LOST \}\)/)
    const form = read('src/pages/NoteFormPage.tsx')
    const sd = form.slice(form.indexOf('function saveDraft('), form.indexOf('function saveDraft(') + 400)
    assert.match(sd, /const \{ reporterName: _omit, \.\.\.f \} = f0/)
    assert.match(sd, /const json = JSON\.stringify\(f\)/)
  })

  it('選ぶ窓の「一覧に無い名前を書く」は申し送りの記入者を選ぶ時だけ出す（出勤者・施設長・ほかの画面には出さない）', () => {
    const daily = read('src/pages/DailySheetPage.tsx')
    assert.match(daily, /onFreeName=\{staffPick\?\.for === 'noteReporter' \? onFreeReporter : undefined\}/)
    for (const other of ['MedRecordPage', 'BathRecordPage', 'IncidentFormPage', 'MedSlotsPage']) {
      const o = read(`src/pages/${other}.tsx`)
      assert.doesNotMatch(o, /onFreeName=/, `${other} に一覧に無い名前を出している`)
    }
    const ui = read('src/components/ui.tsx')
    assert.match(ui, /\{onFreeName \? \(/)
    assert.match(ui, /一覧に無い名前を書く/)
    // 職員と同じ名前はその職員を選ぶ・日本語入力の確定の Enter では決めない
    assert.match(ui, /if \(same\.length === 1\) onPick\(same\[0\]\.id\)\n\s*else onFreeName\(freeName\)/)
    assert.match(ui, /e\.nativeEvent\.isComposing \|\| e\.keyCode === 229/)
  })

  it('送る時: 職員を選んだ行・夜勤は名前を送らない。保存済みの行で職員を選び直すと名前を空にする', () => {
    const form = read('src/pages/NoteFormPage.tsx')
    assert.match(form, /\.\.\.\(form\.shift !== 'night' && form\.reporterId === null && \(form\.reporterName \?\? null\) !== null/)
    const daily = read('src/pages/DailySheetPage.tsx')
    assert.match(daily, /\.\.\.\(draft\.reporterId === null && \(draft\.reporterName \?\? null\) !== null \? \{ reporter_name: draft\.reporterName \} : \{\}\)/)
    assert.match(daily, /updateNoteCell\(note, \{ reporter_id: id, reporter_name: null \}\)/)
    assert.match(daily, /updateNoteCell\(note, \{ reporter_id: null, reporter_name: name \}\)/)
  })

  it('移行 0058: 列・check・関数の2つ・戻す SQL がそろっている', () => {
    const m = read('supabase/migrations/0058_note_reporter_name.sql')
    assert.match(m, /alter table public\.notes add column if not exists reporter_name text;/)
    assert.match(m, /check \(reporter_name is null or char_length\(btrim\(reporter_name\)\) between 1 and 20\)/)
    assert.match(m, /'reporter_id', 'reporter_name',\n    'role_tags', 'categories', 'shift', 'ongoing', 'ended_at', 'ended_by', 'deleted_at'/)
    // 書いた後の行に職員がいる時はいつも名前を空にする・職員と名前は組（片方が競合なら相方も競合）
    assert.match(m, /reporter_name = case when \(case when 'reporter_id' = any \(v_write\) then nullif\(v_edits -> 'reporter_id' ->> 'value', ''\)::bigint\n\s*else reporter_id end\) is not null then null/)
    assert.match(m, /if v_edits \? 'reporter_id' and v_edits \? 'reporter_name' then/)
    assert.equal((m.match(/n\.color, n\.reporter_id, n\.reporter_name, n\.rev, n\.created_at,/g) ?? []).length, 2)
    const back = read('supabase/rollback/0058_back.sql')
    assert.match(back, /alter table public\.notes drop column if exists reporter_name;/)
    assert.doesNotMatch(back, /reporter_name = case/)
  })
})
