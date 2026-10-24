// デイ（せせらぎ）から排泄ケアアプリのデイの表示への受け渡し（2026-10-25・§9.7・§9.8）の試験。
// 実行: npm test
//
// 1. 純ロジック（src/lib/daycareHandoff.ts）: 今日の一覧の時だけ作る・過去の日と名簿が無い時は作らない・mids は一括の画面の対象と同じ・
//    書く・消す（偽の localStorage）
// 2. 排泄ケアアプリの読み方との一致: 写し元（haiben-record.html の受け渡しのキーの名前と hbDcParse）を一字一句そのまま
//    tests/fixtures/haiben-dc-parse.src.txt に置き、node:vm で評価して、care-log が書く値を読ませる（今日＝'ok'・前の日＝'stale'・mids が同じ）。
//    写し元（手元の haiben-record の origin/main）がある時は、写し元の同じ行・同じ関数が写しと一致するかも確かめる。
//    写し元が無い CI はスキップにせず記録だけ残す（CI はスキップが1件でもあると公開を止める＝excretion-parity と同じ作法）
// 3. 静的検査: 〔排泄〕の入口・押した直前に書く・ログアウトで消す・1人の画面の入口
// 個人情報は置かない（利用者は記号の source_id だけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
}

let H = null
let loadErr = null
try {
  H = await import('../src/lib/daycareHandoff.ts')
} catch (e) {
  loadErr = e
}
if (H === null) registerLoadFailure('デイから排泄ケアアプリへの受け渡し', loadErr, 'この Node は TypeScript を直接読み込めない（Node 22.18 以降で実行してください）')

const FIXTURE = new URL('./fixtures/haiben-dc-parse.src.txt', import.meta.url)
// 置き場所は HAIBEN_REPO で差し替えられる（CI と同じ「無い」場合を手元で確かめる時に使う）
const HAIBEN_REPO = process.env.HAIBEN_REPO ?? '/Users/Takeshi/Claude/Repos/haiben-record'
/**
 * 照合する写し元: HAIBEN_HTML（手で指定）→ 手元の haiben-record の origin/main（git show・最後に fetch した公開の版＝手元の作業ファイルが
 * 古くても比べられる。上流が変わったのに fetch していなければ気づけないので、写しを取り直す時は fetch してから流す）。
 * 手元に haiben-record が無い（CI）時は null。手元にあるのに読めない時は、原因を隠さず失敗にする（{ error }）
 */
function haibenSource() {
  if (process.env.HAIBEN_HTML) return { html: readFileSync(process.env.HAIBEN_HTML, 'utf8'), from: process.env.HAIBEN_HTML }
  if (!existsSync(`${HAIBEN_REPO}/.git`)) return null
  try {
    return { html: execFileSync('git', ['-C', HAIBEN_REPO, 'show', 'origin/main:haiben-record.html'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }), from: 'origin/main' }
  } catch (e) {
    return { error: `手元の haiben-record から origin/main:haiben-record.html を読めません（fetch していない・ref が違うなど）: ${String(e).slice(0, 200)}` }
  }
}

function fixtureCode() {
  const raw = readFileSync(FIXTURE, 'utf8')
  return raw.slice(raw.indexOf('//@----\n') + '//@----\n'.length)
}
/** 写し元の hbDcParse と DC_HANDOFF_KEY を評価する */
function haiben() {
  const ctx = { JSON, Array, String, Number }
  vm.createContext(ctx)
  vm.runInContext(`${fixtureCode()}\nthis.hbDcParse = hbDcParse; this.DC_HANDOFF_KEY = DC_HANDOFF_KEY;`, ctx)
  return ctx
}

const rows = [
  { residentId: 1, state: 'planned', planned: true, hospitalized: false },
  { residentId: 2, state: 'present', planned: true, hospitalized: false },
  { residentId: 3, state: 'absent', planned: true, hospitalized: false },
  { residentId: 4, state: 'planned', planned: true, hospitalized: true },
  { residentId: 5, state: 'left', planned: false, hospitalized: false },
  { residentId: 6, state: 'planned', planned: false, hospitalized: false },
]
const residents = [
  { id: 1, source_id: 'T001' },
  { id: 2, source_id: 'T002' },
  { id: 3, source_id: 'T003' },
  { id: 4, source_id: 'T004' },
  { id: 5, source_id: 'wm_5-a' },
  { id: 6, source_id: 'T006' },
]

if (H !== null) {
  describe('純ロジック', () => {
    it('今日の一覧の時だけ作る。mids は一括の画面の対象（休み・入院中・予定外で来ていない方を除く）の source_id', () => {
      const h = H.buildDaycareHandoff({ day: '2026-10-25', today: '2026-10-25', rows, residents, now: 1761350400000 })
      assert.deepEqual(h, { v: 1, day: '2026-10-25', at: 1761350400000, mids: ['T001', 'T002', 'wm_5-a'] })
      assert.equal(H.buildDaycareHandoff({ day: '2026-10-24', today: '2026-10-25', rows, residents, now: 1 }), null, '過去の日は書かない')
      assert.equal(H.buildDaycareHandoff({ day: '2026-10-25', today: '2026-10-25', rows, residents: [], now: 1 }), null, '名簿が読めていない時は書かない')
      // 氏名・居室は入らない（キーは v・day・at・mids だけ）
      assert.deepEqual(Object.keys(h).sort(), ['at', 'day', 'mids', 'v'])
    })
    it('書く・消す（書けない端末では false で止めない）。一覧が無い画面は書かない', () => {
      store.clear()
      assert.equal(H.writeDaycareHandoffFor({ rows, residents, boardDay: '2026-10-25', today: '2026-10-25' }), true)
      const saved = JSON.parse(store.get('su_daycare_handoff_v1'))
      assert.deepEqual(saved.mids, ['T001', 'T002', 'wm_5-a'])
      assert.equal(typeof saved.at, 'number')
      assert.equal(H.writeDaycareHandoffFor({ rows: null, residents, boardDay: '2026-10-25', today: '2026-10-25' }), false)
      store.clear()
      assert.equal(H.writeDaycareHandoffFor({ rows, residents, boardDay: '2026-10-24', today: '2026-10-25' }), false, '過去の日の画面は書かない')
      // 反証 重1: 日付を今日へ切り替えた直後・日をまたいだ直後で、まだ前の日の一覧（boardDay＝前の日）しか無い時は書かない
      assert.equal(H.writeDaycareHandoffFor({ rows, residents, boardDay: '2026-10-24', today: '2026-10-25' }), false)
      assert.equal(H.writeDaycareHandoffFor({ rows, residents, boardDay: null, today: '2026-10-25' }), false, '一覧がまだ無い')
      assert.equal(store.has('su_daycare_handoff_v1'), false)
      store.set('su_daycare_handoff_v1', '{}')
      H.clearDaycareHandoff()
      assert.equal(store.has('su_daycare_handoff_v1'), false)
      const keep = globalThis.window.localStorage.setItem
      globalThis.window.localStorage.setItem = () => {
        throw new Error('QuotaExceededError')
      }
      assert.equal(H.writeDaycareHandoff({ v: 1, day: '2026-10-25', at: 1, mids: [] }), false)
      globalThis.window.localStorage.setItem = keep
    })
  })

  describe('排泄ケアアプリの読み方との一致（写し元 hbDcParse）', () => {
    it('care-log が書く値を、排泄ケアアプリが今日の一覧として読み、mids が同じ。前の日の一覧は stale', () => {
      const X = haiben()
      assert.equal(X.DC_HANDOFF_KEY, H.DAYCARE_HANDOFF_KEY, 'キーの名前が同じ')
      const h = H.buildDaycareHandoff({ day: '2026-10-25', today: '2026-10-25', rows, residents, now: Date.now() })
      const got = X.hbDcParse(JSON.stringify(h), '2026-10-25')
      assert.equal(got.st, 'ok')
      assert.equal(got.day, '2026-10-25')
      assert.deepEqual([...got.mids], h.mids)
      assert.equal(got.badN, 0, 'care-log の source_id はすべて排泄ケアアプリの masterId の形')
      assert.equal(X.hbDcParse(JSON.stringify(h), '2026-10-26').st, 'stale', '日付をまたいだら「今日のものではありません」')
      // 空の一覧（予定の方がいない日）も壊れた値ではない
      const empty = H.buildDaycareHandoff({ day: '2026-10-25', today: '2026-10-25', rows: [], residents, now: 1 })
      assert.equal(X.hbDcParse(JSON.stringify(empty), '2026-10-25').st, 'ok')
    })
    it('行き先は排泄ケアアプリのデイの表示（?view=daycare・同じサイトの haiben-record 配下）', () => {
      assert.equal(H.HAIBEN_DAYCARE_HREF, '../haiben-record/haiben-record.html?view=daycare')
      assert.match(fixtureCode(), /function hbDcParse\(raw,td\)\{/)
    })
    it('写し元（手元の haiben-record の origin/main）のキーの名前と hbDcParse が写しと一字一句同じ（違えば写しを見直す）', (t) => {
      const src = haibenSource()
      if (src === null) {
        // CI はスキップが1件でもあると公開を止めるので、スキップにせず記録だけ残す（写しどうしの照合は上の試験が行う＝excretion-parity と同じ作法）
        t.diagnostic('写し元の排泄ケアアプリ（haiben-record）がこの端末に無い（CI など）。写しだけで照合した')
        return
      }
      assert.ok(!('error' in src), src.error)
      const html = src.html
      // 写し元にキーの名前も hbDcParse も無い＝名前が変わった（v2 など）か、デイの表示より前の版。どちらも写しを見直す（飛ばさない＝反証 中2）
      assert.ok(
        html.includes('su_daycare_handoff_v1') || html.includes('hbDcParse'),
        `写し元（${src.from}）に受け渡しのキーの名前も hbDcParse も見つかりません。haiben-record を fetch するか、写しを取り直してください`,
      )
      const fx = fixtureCode()
      const [keyLine] = fx.split('\n')
      assert.ok(html.includes(keyLine), 'キーの名前の行が同じ')
      const i = html.indexOf('function hbDcParse(raw,td){')
      assert.ok(i >= 0, `写し元（${src.from}）の hbDcParse の形が変わった（写しを取り直して照合し直す）`)
      const fn = html.slice(i, html.indexOf('\n}\n', i) + 3)
      assert.equal(fx.slice(fx.indexOf('function hbDcParse(')), fn, 'hbDcParse が写しと同じ')
    })
  })
}

describe('静的検査', () => {
  const today = code('../src/pages/DaycarePage.tsx')
  const person = code('../src/pages/DaycarePersonPage.tsx')
  it('今日の画面は、今日の一覧を作るたびに書き直す（過去の日は作る関数が null）', () => {
    assert.match(today, /if \(board === null \|\| data === null \|\| data\.day !== day\) return\s*writeDaycareHandoffFor\(\{ rows: board\.rows, residents, boardDay: data\.day, today \}\)/)
    assert.match(today, /\}, \[board, data, residents, day, today\]\)/)
  })
  it('〔排泄〕を押した直前に書き直す（今日の画面・一括の4画面・1人の画面）。日は画面の日付でなく一覧を読んだ日（data.day＝反証 重1）', () => {
    assert.match(today, /<DaycareNav current="today" handoff=\{\(\) => writeDaycareHandoffFor\(\{ rows: board\?\.rows \?\? null, residents, boardDay: data\?\.day \?\? null, today \}\)\} \/>/)
    // 中クリック・長押しのメニューで新しいタブに開く時も書く（反証 軽4）・読み上げの名前は見えている文字から（反証 軽5）
    const nav = today.slice(today.indexOf('export function DaycareNav'), today.indexOf('/** 予定の帯'))
    assert.match(nav, /onClick=\{\(\) => handoff\?\.\(\)\}\s*onAuxClick=\{\(\) => handoff\?\.\(\)\}\s*onContextMenu=\{\(\) => handoff\?\.\(\)\}/)
    assert.doesNotMatch(nav, /aria-label="排泄/)
    assert.match(nav, /排泄<span className="ml-1 text-sm">（別アプリ）<\/span>\s*<span className="sr-only">：排泄ケアアプリのデイの表示へ移ります<\/span>/)
    for (const [f, cur] of [
      ['DaycareVitalsPage', 'vitals'],
      ['DaycareMealsPage', 'meals'],
      ['DaycareActivityBulkPage', 'activity'],
      ['DaycareTrainingPage', 'training'],
    ])
      assert.match(code(`../src/pages/${f}.tsx`), new RegExp(`<DaycareNav current="${cur}" handoff=\\{\\(\\) => writeDaycareHandoffFor\\(\\{ rows: board\\?\\.rows \\?\\? null, residents, boardDay: data\\?\\.day \\?\\? null, today \\}\\)\\} />`), f)
    assert.match(person, /href=\{haibenAppHref\(resident\?\.source_id\)\}\s*onClick=\{\(\) => writeDaycareHandoffFor\(\{ rows: board\?\.rows \?\? null, residents, boardDay: data\?\.day \?\? null, today \}\)\}/)
    // 確認の反証 軽1: 1人の画面のリンクも中クリック・長押しのメニューで書く
    const link = person.slice(person.indexOf('href={haibenAppHref('), person.indexOf('排泄ケアアプリで記録する'))
    assert.match(link, /onAuxClick=\{\(\) => writeDaycareHandoffFor\(/)
    assert.match(link, /onContextMenu=\{\(\) => writeDaycareHandoffFor\(/)
  })
  it('ログアウト（App の後片付け）で消す・記録者の切り替え（resetDataCache）では消さない（反証 軽3）・置き場は localStorage だけ（氏名・記録を入れない）', () => {
    const app = code('../src/App.tsx')
    assert.match(app, /offSync\?\.\(\)\s*clearDaycareHandoff\(\)\s*const m = cacheModRef\.current/)
    assert.doesNotMatch(code('../src/lib/cachedReads.ts'), /clearDaycareHandoff/)
    const h = code('../src/lib/daycareHandoff.ts')
    assert.doesNotMatch(h, /sessionStorage|indexedDB|\.name\b|kana|room/)
    assert.match(h, /return \{ v: 1, day: p\.day, at: p\.now, mids: daycareBulkSourceIds\(p\.rows, p\.residents\) \}/)
  })
})
