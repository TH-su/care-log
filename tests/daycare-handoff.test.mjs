// デイ（せせらぎ）から排泄ケアアプリのデイの表示への受け渡し（2026-10-25・§9.7・§9.8）の試験。
// 実行: npm test
//
// 1. 純ロジック（src/lib/daycareHandoff.ts）: 今日の一覧の時だけ作る・過去の日と名簿が無い時は作らない・mids は一括の画面の対象と同じ・
//    書く・消す（偽の localStorage）
// 2. 排泄ケアアプリの読み方との一致: 写し元（haiben-record.html の受け渡しのキーの名前と hbDcParse）を一字一句そのまま
//    tests/fixtures/haiben-dc-parse.src.txt に置き、node:vm で評価して、care-log が書く値を読ませる（今日＝'ok'・前の日＝'stale'・mids が同じ）。
//    写し元が手元にある時は、写し元の同じ行・同じ関数が写しと一致するかも確かめる（無い時・古い時は飛ばす＝CI と同じ作法）
// 3. 静的検査: 〔排泄〕の入口・押した直前に書く・ログアウトで消す・1人の画面の入口
// 個人情報は置かない（利用者は記号の source_id だけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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
const HAIBEN_HTML = process.env.HAIBEN_HTML ?? '/Users/Takeshi/Claude/Repos/haiben-record/haiben-record.html'

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
      assert.equal(H.writeDaycareHandoffFor({ rows, residents, day: '2026-10-25', today: '2026-10-25' }), true)
      const saved = JSON.parse(store.get('su_daycare_handoff_v1'))
      assert.deepEqual(saved.mids, ['T001', 'T002', 'wm_5-a'])
      assert.equal(typeof saved.at, 'number')
      assert.equal(H.writeDaycareHandoffFor({ rows: null, residents, day: '2026-10-25', today: '2026-10-25' }), false)
      store.clear()
      assert.equal(H.writeDaycareHandoffFor({ rows, residents, day: '2026-10-24', today: '2026-10-25' }), false, '過去の日の画面は書かない')
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
    it('写し元が手元にあれば、写し元のキーの名前と hbDcParse が写しと一字一句同じ（無い・古い時は飛ばす）', (t) => {
      if (!existsSync(HAIBEN_HTML)) {
        t.skip('写し元（haiben-record.html）が手元に無いので飛ばしました（CI）')
        return
      }
      const html = readFileSync(HAIBEN_HTML, 'utf8')
      if (!html.includes('function hbDcParse(raw,td){')) {
        t.skip('手元の写し元がデイの表示（haiben-record #2）より古いので飛ばしました。git pull してから流してください')
        return
      }
      const fx = fixtureCode()
      const [keyLine] = fx.split('\n')
      assert.ok(html.includes(keyLine), 'キーの名前の行が同じ')
      const i = html.indexOf('function hbDcParse(raw,td){')
      const fn = html.slice(i, html.indexOf('\n}\n', i) + 3)
      assert.equal(fx.slice(fx.indexOf('function hbDcParse(')), fn, 'hbDcParse が写しと同じ')
    })
  })
}

describe('静的検査', () => {
  const today = code('../src/pages/DaycarePage.tsx')
  const person = code('../src/pages/DaycarePersonPage.tsx')
  it('今日の画面は、今日の一覧を作るたびに書き直す（過去の日は作る関数が null）', () => {
    assert.match(today, /if \(board === null \|\| data === null \|\| data\.day !== day\) return\s*writeDaycareHandoffFor\(\{ rows: board\.rows, residents, day, today \}\)/)
    assert.match(today, /\}, \[board, data, residents, day, today\]\)/)
  })
  it('〔排泄〕を押した直前に書き直す（今日の画面・一括の4画面・1人の画面）', () => {
    assert.match(today, /<DaycareNav current="today" handoff=\{\(\) => writeDaycareHandoffFor\(\{ rows: board\?\.rows \?\? null, residents, day, today \}\)\} \/>/)
    for (const [f, cur] of [
      ['DaycareVitalsPage', 'vitals'],
      ['DaycareMealsPage', 'meals'],
      ['DaycareActivityBulkPage', 'activity'],
      ['DaycareTrainingPage', 'training'],
    ])
      assert.match(code(`../src/pages/${f}.tsx`), new RegExp(`<DaycareNav current="${cur}" handoff=\\{\\(\\) => writeDaycareHandoffFor\\(\\{ rows: board\\?\\.rows \\?\\? null, residents, day, today \\}\\)\\} />`), f)
    assert.match(person, /href=\{haibenAppHref\(resident\?\.source_id\)\}\s*onClick=\{\(\) => writeDaycareHandoffFor\(\{ rows: board\?\.rows \?\? null, residents, day, today \}\)\}/)
  })
  it('ログアウト（resetDataCache）で消す・置き場は localStorage だけ（氏名・記録を入れない）', () => {
    assert.match(code('../src/lib/cachedReads.ts'), /clearDaycareDayMemo\(\)\s*clearDaycareHandoff\(\)/)
    const h = code('../src/lib/daycareHandoff.ts')
    assert.doesNotMatch(h, /sessionStorage|indexedDB|\.name\b|kana|room/)
    assert.match(h, /return \{ v: 1, day: p\.day, at: p\.now, mids: daycareBulkSourceIds\(p\.rows, p\.residents\) \}/)
  })
})
