// デイ（せせらぎ）段階3b: 個別機能訓練の居宅訪問と期限の区画の回帰テスト（2026-10-23・代表者承認・段階3の計画 2.2・3.2）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycareHomeVisit.ts）: 入力の検査（必須4項目・500字・未来の日）・説明の片方だけの知らせ・送る形・初めの値
// 2. 静的検査: db.ts の配線（送信待ちの表・機能訓練の旗・自然キー（利用者・訪問日・目的）・合流しない・写しは読むだけ）・
//    区画と小窓（書き込みは決まった関数だけ・端末に残すのは開閉だけ・写しの3つの状態）・カード（読むだけ）・47 のはみ出しの直し
// db.ts の振る舞い（保存・先に記録あり・送信待ち・止まった時）は tests/daycare-training-db.test.mjs。期限の計算は tests/training-due.test.mjs。
// 個人情報は置かない（利用者・職員は数値IDだけ・文は試験用の架空の文）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

let H = null
let loadError = null
try {
  H = await import('../src/lib/daycareHomeVisit.ts')
} catch (e) {
  loadError = e
}

const TODAY = '2026-10-23'
const input = (over = {}) => ({
  visited_on: '2026-10-20',
  visitor_id: 3,
  purpose: 'periodic',
  life_status: '玄関の段差を確かめた（見本）',
  explained_to: null,
  explained_on: '',
  explanation: '',
  plan_revised: false,
  ...over,
})

if (H === null) {
  registerLoadFailure('段階3b（居宅訪問）の試験', loadError, 'この Node では TypeScript を直接読み込めません（Node 22.18 以降で実行してください）')
} else {
  describe('純ロジック（daycareHomeVisit.ts）', () => {
    it('必須は 訪問日・訪問した職員・目的・生活の状況（空白だけは不可）。そろえば誤りなし', () => {
      assert.deepEqual(H.homeVisitInputErrors(input(), TODAY), {})
      const e = H.homeVisitInputErrors(input({ visited_on: '', visitor_id: null, purpose: null, life_status: '　 ' }), TODAY)
      assert.deepEqual(Object.keys(e).sort(), ['life_status', 'purpose', 'visited_on', 'visitor_id'])
    })
    it('未来の訪問日・説明の日は止める（今日は通る）。実在しない日付も止める', () => {
      assert.match(H.homeVisitInputErrors(input({ visited_on: '2026-10-24' }), TODAY).visited_on ?? '', /未来/)
      assert.equal(H.homeVisitInputErrors(input({ visited_on: TODAY }), TODAY).visited_on, undefined)
      assert.match(H.homeVisitInputErrors(input({ explained_to: 'user', explained_on: '2026-10-24' }), TODAY).explained_on ?? '', /未来/)
      assert.ok(H.homeVisitInputErrors(input({ visited_on: '2026-02-30' }), TODAY).visited_on)
      assert.ok(H.homeVisitInputErrors(input({ explained_on: '2026-02-30' }), TODAY).explained_on)
    })
    it('生活の状況・説明の内容は 500 字まで（DB の check と同じ・文字で数える）', () => {
      assert.equal(H.homeVisitInputErrors(input({ life_status: 'あ'.repeat(500) }), TODAY).life_status, undefined)
      assert.ok(H.homeVisitInputErrors(input({ life_status: 'あ'.repeat(501) }), TODAY).life_status)
      assert.ok(H.homeVisitInputErrors(input({ explanation: 'あ'.repeat(501) }), TODAY).explanation)
      assert.equal(H.homeVisitInputErrors(input({ life_status: '𠮷'.repeat(500) }), TODAY).life_status, undefined, 'サロゲートペアは1字')
    })
    it('説明は相手と日の片方だけでも保存できる（後日に足せる）。片方だけの間は知らせる', () => {
      assert.deepEqual(H.homeVisitInputErrors(input({ explained_to: 'family' }), TODAY), {})
      assert.equal(H.explanationHalf(input({ explained_to: 'family' })), true)
      assert.equal(H.explanationHalf(input({ explained_on: '2026-10-21' })), true)
      assert.equal(H.explanationHalf(input({ explained_to: 'both', explained_on: '2026-10-21' })), false)
      assert.equal(H.explanationHalf(input()), false)
    })
    it('送る形: 空の欄は null・文は前後の空白を落とす', () => {
      assert.deepEqual(H.homeVisitPayload(input({ life_status: '  段差  ', explanation: '  ' })), {
        visited_on: '2026-10-20',
        visitor_id: 3,
        purpose: 'periodic',
        life_status: '段差',
        explained_to: null,
        explained_on: null,
        explanation: null,
        plan_revised: false,
      })
      assert.equal(H.homeVisitPayload(input({ explained_to: 'user', explained_on: '2026-10-21', explanation: '説明（見本）' })).explained_on, '2026-10-21')
    })
    it('既存の記録の訪問日・目的の重なり（反証 中1・確認の反証 軽4）: 同じ方の別の記録と同じ鍵なら true。自分・別の方・取り消し待ちは数えない', () => {
      const visits = [
        { id: 1, resident_id: 1, visited_on: '2026-10-20', purpose: 'periodic' },
        { id: 2, resident_id: 1, visited_on: '2026-10-21', purpose: 'initial' },
        { id: 3, resident_id: 2, visited_on: '2026-10-19', purpose: 'periodic' },
      ]
      const me = { id: 1, resident_id: 1 }
      assert.equal(H.homeVisitKeyTaken(visits, me, '2026-10-21', 'initial'), true, '日付と目的を両方変えて重なる')
      assert.equal(H.homeVisitKeyTaken(visits, { id: 2, resident_id: 1 }, '2026-10-20', 'periodic'), true, '日付と目的を変えて 1 と重なる')
      assert.equal(H.homeVisitKeyTaken(visits, me, '2026-10-21', 'periodic'), false, '目的が違えば重ならない')
      assert.equal(H.homeVisitKeyTaken(visits, me, '2026-10-20', 'periodic'), false, '自分とは重ならない')
      assert.equal(H.homeVisitKeyTaken(visits, me, '2026-10-19', 'periodic'), false, '別の方とは重ならない')
      assert.equal(H.homeVisitKeyTaken(visits, me, '2026-10-21', 'initial', new Set([2])), false, '取り消し待ちは数えない')
    })
    it('初めの値: 訪問日＝今日・訪問者＝記録者・目的＝前の訪問があれば定期／無ければ初回', () => {
      assert.deepEqual(
        [H.freshHomeVisitInput(TODAY, 4, true).visited_on, H.freshHomeVisitInput(TODAY, 4, true).visitor_id, H.freshHomeVisitInput(TODAY, 4, true).purpose],
        [TODAY, 4, 'periodic'],
      )
      assert.equal(H.freshHomeVisitInput(TODAY, null, false).purpose, 'initial')
    })
  })
}

describe('静的検査（段階3b の規律）', () => {
  it('db.ts の配線: 送信待ちの表・機能訓練の旗・自然キー（利用者・訪問日・目的）・合流しない・〔自分の内容で直す〕の中身・写しは読むだけ', () => {
    const db = code('../src/lib/db.ts')
    assert.match(db, /type LegacyTable = [^\n]*'daycare_staffing' \| 'daycare_home_visits'/)
    assert.match(db, /if \(table === 'daycare_home_visits'\) \{\s*const day = dateStr\(payload\.visited_on\)/)
    assert.match(db, /\{ resident_id: residentId, visited_on: day, purpose \}/)
    assert.match(db, /omitKeys\(payload, \['client_key', 'resident_id', 'visited_on', 'purpose', 'id', 'rev', 'deleted_at', 'recorded_by'\]\)/)
    const ins = db.slice(db.indexOf('export async function insertHomeVisit'), db.indexOf('export async function updateHomeVisit'))
    assert.match(ins, /return \{ kind: 'taken', row: other === null \? null : normalizeHomeVisit\(other\.row\) \}/)
    assert.doesNotMatch(ins, /merged/)
    // 期限切れの古い訪問も見つけるため、日数で絞らない（上限は付ける）
    const fetchV = db.slice(db.indexOf('export async function fetchHomeVisits'), db.indexOf('export async function fetchTrainingDueCopy'))
    assert.doesNotMatch(fetchV, /\.gte\(|\.lt\(/)
    assert.match(fetchV, /\.limit\(DAYCARE_HOME_VISIT_ROWS\)/)
    // 写しの表・設定の表へは直接書かない。写しの関数を呼ぶのは 3c の syncTrainingDue の1か所だけ（3b の読み取りからは呼ばない）
    assert.doesNotMatch(db, /from\('daycare_training_due(_settings)?'\)\.(insert|update|upsert|delete)/)
    assert.equal((db.match(/rpc\('daycare_training_due_sync'/g) ?? []).length, 1)
    const syncFn = db.slice(db.indexOf('export async function syncTrainingDue'), db.indexOf('// ── デイ（せせらぎ）の記録 段階2c'))
    assert.match(syncFn, /rpc\('daycare_training_due_sync'/)
    assert.doesNotMatch(db.slice(db.indexOf('export async function fetchTrainingDueCopy'), db.indexOf('export type HomeVisitAdd')), /rpc\(|\.insert\(|\.update\(/)
    // 未来の日は送らない
    assert.match(db, /if \(f\.visited_on > today \|\| \(f\.explained_on !== null && f\.explained_on > today\)\) throw new DbError\('server', HOME_VISIT_MSG\.future\)/)
  })
  it('止まった送信待ち: 居宅訪問の呼び名・欄・〔いまの記録とくらべる〕の対象・訪問した職員の氏名', () => {
    const so = code('../src/lib/stoppedOps.ts')
    assert.match(so, /daycare_home_visits: 'デイの居宅訪問'/)
    assert.match(so, /daycare_home_visits: \{ visitor_id: '訪問した職員' \}/)
    assert.match(so, /op\.table === 'daycare_home_visits'\)/)
    assert.match(so, /'day', 'visited_on'\]/)
  })
  it('区画と小窓: 書き込みは決まった関数だけ・端末に残すのは開閉だけ・写しの3つの状態を分けて出す・開いただけでは書かない', () => {
    const c = code('../src/components/DaycareHomeVisitSection.tsx')
    const writes = c.match(/\b(save\w*|insert\w+|update\w+|delete\w+|softDelete\w+|upsert\w+)\(/g) ?? []
    assert.deepEqual(
      [...new Set(writes.map((w) => w.slice(0, -1)))].filter((w) => w !== 'save').sort(),
      ['insertHomeVisit', 'softDeleteHomeVisit', 'updateHomeVisit'],
    )
    assert.doesNotMatch(c, /sessionStorage|indexedDB|supabase|\.rpc\(/)
    assert.equal((c.match(/localStorage\.(get|set)Item\(/g) ?? []).length, 2)
    assert.match(c, /window\.localStorage\.getItem\(LS\.dcTrainingDueOpen\) === '1'/)
    assert.match(c, /window\.localStorage\.setItem\(LS\.dcTrainingDueOpen, v \? '1' : '0'\)/)
    // 写しの3つの状態: 表が無い／読めない／0件
    assert.match(c, /デイの居宅訪問の記録はまだ使えません/)
    assert.match(c, /計画書の期限の写しを読み込めませんでした/)
    // 積み残し 51（案A）で、写しが0件の時の知らせは「週間計画でも絞れない時」だけになった（固定し直し・意図は同じ＝0件を「期限切れなし」と読ませない）
    assert.match(c, /計画書の写しが無く、週間計画でも絞れないため、訪問の記録が無い方は、その日に来た方だけを出しています/)
    // 取り消しは確認つき
    assert.match(c, /<ConfirmDialog\s+open=\{del !== null\}/)
    // 読み込みの useEffect の中で書かない（開いただけで書かない）
    const loader = c.slice(c.indexOf('const load = useCallback'), c.indexOf('const nameOf'))
    assert.doesNotMatch(loader, /insert|update|softDelete/)
  })
  it('反証の直し: 重なる訪問日・目的は送る前に止める・先の記録を読めない時の文・書いた文を残す・古い応答を捨てる・在籍でない訪問者も氏名で出す・送信待ちを行に添える', () => {
    const c = code('../src/components/DaycareHomeVisitSection.tsx')
    assert.match(c, /homeVisitKeyTaken\(visitsOf\(rid\), editingRow, ed\.input\.visited_on, ed\.input\.purpose, removedIds\)/)
    assert.match(c, /p\.kind === 'update' && p\.deleted && !p\.stopped \? \[p\.rowId\]/)
    assert.match(c, /\{staff !== null && staff !== undefined \? '（在籍でない）' : ''\}/)
    assert.match(c, /else setEditor\(\{ \.\.\.ed, note: keep === '' \? MSG_TAKEN_UNREAD/)
    assert.match(c, /この端末で書いた内容（保存されていません）/)
    assert.match(c, /if \(gen !== genRef\.current\) return\s+setLoaded\(\{ status: 'ready'/)
    assert.match(c, /（在籍でない）/)
    assert.match(c, /送信待ちの訪問 \{pendingAddsOf\(r\.residentId\)/)
    assert.match(c, /isoDate\(new Date\(syncedAt\)\)/)
    assert.match(c, /homeVisitCopyNotice\(ready\.copy\)/)
    assert.match(code('../src/components/DaycareTrainingCard.tsx'), /homeVisitCardLine\(\{ visits: visit\.visits, copy: visit\.copy, residentId, active, today \}\)/)
  })
  it('types.ts は LS に1行足すだけ（UI 状態のキー）', () => {
    // 段階3c で後ろに dcTrainingReviewOpen が続く（固定し直し・意図は同じ＝UI 状態のキーを1つ足しただけ）
    assert.match(read('../src/lib/types.ts'), /\n {2}dcTrainingDueOpen: 'cl_dcTrainingDueOpen',\n/)
  })
  it('機能訓練の画面: 区画を配置と対象者のあいだに置く・居宅訪問は過去の日の守りを受けない（旗と記録者だけ）', () => {
    const p = code('../src/pages/DaycareTrainingPage.tsx')
    const a = p.indexOf('aria-labelledby="h-staffing"')
    const b = p.indexOf('<DaycareHomeVisitSection')
    const t = p.indexOf('aria-labelledby="h-targets"')
    assert.ok(a > 0 && a < b && b < t)
    const blocked = p.slice(p.indexOf('const homeVisitBlocked'), p.indexOf('const errText'))
    assert.doesNotMatch(blocked, /pastLocked|MSG_PAST\b/)
    assert.match(p, /blockedReason=\{homeVisitBlocked\(\)\}/)
  })
  it('1人の画面のカード: 読むだけ・写しを読めない時は既定の数え方で仮に出すと書き添える', () => {
    const card = code('../src/components/DaycareTrainingCard.tsx')
    assert.doesNotMatch(card, /\b(insert\w+|update\w+|softDelete\w+)\(/)
    assert.match(card, /fetchHomeVisits\(residentId\)/)
    assert.match(card, /計画書の設定を読めないため、既定の数え方で仮に出しています/)
  })
  it('47 の直し: 配置の「配置に入れる」の枠・機能訓練と居宅訪問の小窓の選択欄が、狭い幅・文字200%で横にはみ出さない', () => {
    const p = code('../src/pages/DaycareTrainingPage.tsx')
    assert.match(p, /<fieldset className="min-w-0 space-y-2" disabled=\{!canWrite \|\| busy\}>/)
    assert.match(p, /<label className="min-w-0 max-w-full text-sm text-ink2">\s*職員\s*<select value=\{addStaffId\} onChange=\{\(e\) => setAddStaffId\(e\.target\.value\)\} className="mt-1 block min-h-tap max-w-full /)
    assert.match(p, /<fieldset disabled=\{!canWrite \|\| busy\} className="min-w-0 space-y-3">/)
    const c = code('../src/components/DaycareHomeVisitSection.tsx')
    assert.match(c, /<fieldset disabled=\{!writable \|\| busy\} className="min-w-0 space-y-3">/)
  })
  it('段階1・2の画面のファイルは、カードに在籍の旗を渡す1行のほかは変えない', () => {
    const person = read('../src/pages/DaycarePersonPage.tsx')
    assert.match(person, /active=\{resident\?\.active\}/)
  })
})
