// デイ（せせらぎ）段階3c: 計画書アプリの索引を読むクライアント（src/lib/trainingPlanClient.ts）の回帰テスト（2026-10-23・段階3の計画 4章）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 索引のそろえ方: 写すのは6項目だけ（氏名・計画の id・数・職員の一覧は捨てる）。崩れた日付・知らない状態は null（積み残し 44）
// 2. 接続設定: tp_cfg を読むだけ（書かない・消さない）。GAS の形の宛先だけ
// 3. 取得: POST 本文・text/plain・get だけ。合言葉を URL に載せない。索引が無い応答は 'noindex'（写さない）
// 4. 写しの結果の文: 止めた時は「今の写しはそのまま」
// 接続先・合言葉・実名は架空の値だけ。本物の計画書の GAS へはつながない（fetch は差し替える）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

let C = null
let loadError = null
try {
  C = await import('../src/lib/trainingPlanClient.ts')
} catch (e) {
  loadError = e
}

const FAKE_URL = 'https://script.google.com/macros/s/FAKE-TEST/exec'
/** 読むだけの localStorage（書く・消すと試験が落ちる） */
const readOnlyStorage = (map) => ({
  getItem: (k) => (k in map ? map[k] : null),
  setItem: () => {
    throw new Error('setItem は呼ばない')
  },
  removeItem: () => {
    throw new Error('removeItem は呼ばない')
  },
})
const withStorage = async (map, fn) => {
  const prev = globalThis.localStorage
  globalThis.localStorage = readOnlyStorage(map)
  try {
    return await fn()
  } finally {
    globalThis.localStorage = prev
  }
}
const withFetch = async (impl, fn) => {
  const prev = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return impl(url, init)
  }
  try {
    return { result: await fn(), calls }
  } finally {
    globalThis.fetch = prev
  }
}
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const cfg = { tp_cfg: JSON.stringify({ url: FAKE_URL, token: 'fake-token' }) }

const INDEX = {
  v: 1,
  rows: {
    T001: { nameNorm: '見本花子', latestPlanId: 'p1', latestPlanDate: '2026-08-01', nextDue: '2026-11-01', status: 'signed', count: 3, aiDraftCount: 1, stop: null },
    T002: { nameNorm: '見本次郎', latestPlanDate: '2026-02-30', nextDue: 'x', status: 'unknown' },
    T003: { nameNorm: '見本一郎', latestPlanDate: '', nextDue: '', status: 'none', stop: { reason: 'stopped', from: '2026-10-01', note: '一言（見本）', by: '1' } },
    T004: { nameNorm: '見本三郎', latestPlanDate: '2026-09-01', nextDue: '2026-12-01', status: 'printed', stop: { reason: 'other', from: '2026-10-01' } },
    'bad id!': { nameNorm: '見本外', latestPlanDate: '2026-09-01' },
    T005: 'not an object',
  },
  settings: { dueRule: 'weekly', warnDays: -3, staff: [{ id: '1', name: '見本 職員一' }], defaults: { planner: '1' } },
  updatedAt: '2026-10-22T00:00:00Z',
}

if (C === null) {
  registerLoadFailure('段階3c（計画書アプリの読み口）の試験', loadError, 'この Node では TypeScript を直接読み込めません（Node 22.18 以降で実行してください）')
} else {
  describe('索引のそろえ方（normalizeTrainingPlanIndex）', () => {
    const out = C.normalizeTrainingPlanIndex(INDEX)
    it('写すのは6項目だけ。氏名・計画の id・数・止めた指定の一言・職員の一覧は持たない', () => {
      for (const r of out.rows) assert.deepEqual(Object.keys(r).sort(), ['latest_plan_date', 'master_id', 'next_due', 'plan_status', 'stop_from', 'stop_reason'])
      assert.deepEqual(Object.keys(out.settings).sort(), ['due_rule', 'warn_days'])
      const flat = JSON.stringify(out)
      for (const leak of ['見本', 'nameNorm', 'p1', 'staff', '一言']) assert.equal(flat.includes(leak), false, `${leak} を持たない`)
    })
    it('利用者番号の形が違うキー・行がオブジェクトでないものは写さない（番号の順）', () => {
      assert.deepEqual(out.rows.map((r) => r.master_id), ['T001', 'T002', 'T003', 'T004'])
    })
    it('崩れた日付・空は null、知らない状態は null、止めた指定は理由が3つのどれかで日付が正しい時だけ', () => {
      assert.deepEqual(out.rows[0], { master_id: 'T001', latest_plan_date: '2026-08-01', next_due: '2026-11-01', stop_reason: null, stop_from: null, plan_status: 'signed' })
      assert.deepEqual(out.rows[1], { master_id: 'T002', latest_plan_date: null, next_due: null, stop_reason: null, stop_from: null, plan_status: null })
      assert.deepEqual([out.rows[2].stop_reason, out.rows[2].stop_from, out.rows[2].latest_plan_date], ['stopped', '2026-10-01', null])
      assert.deepEqual([out.rows[3].stop_reason, out.rows[3].stop_from], [null, null], '知らない理由の止めた指定は写さない')
    })
    it('設定: 知らない規則は暦の月・範囲の外の間近の日数は 28', () => {
      assert.deepEqual(out.settings, { due_rule: 'calendar', warn_days: 28 })
      assert.deepEqual(C.normalizeTrainingPlanIndex({ rows: {}, settings: { dueRule: 'days90', warnDays: 14 } }).settings, { due_rule: 'days90', warn_days: 14 })
    })
    it('形の違う索引（null・配列・行の無い索引）でも落ちない', () => {
      assert.deepEqual(C.normalizeTrainingPlanIndex(null), { rows: [], settings: { due_rule: 'calendar', warn_days: 28 } })
      assert.deepEqual(C.normalizeTrainingPlanIndex([]).rows, [])
      assert.deepEqual(C.normalizeTrainingPlanIndex({ rows: [] }).rows, [])
    })
  })

  describe('接続設定（readTrainingPlanConfig・読むだけ）', () => {
    it('tp_cfg が無い・空・壊れている・片方だけ → null（この端末は計画書アプリを使っていない）', async () => {
      await withStorage({}, () => assert.equal(C.readTrainingPlanConfig(), null))
      await withStorage({ tp_cfg: '' }, () => assert.equal(C.readTrainingPlanConfig(), null))
      await withStorage({ tp_cfg: '{壊れた' }, () => assert.equal(C.readTrainingPlanConfig(), null))
      await withStorage({ tp_cfg: JSON.stringify({ url: FAKE_URL }) }, () => assert.equal(C.readTrainingPlanConfig(), null))
    })
    it('GAS の形でない宛先は invalid（合言葉を送らない）。GAS の形なら読める。書かない・消さない', async () => {
      await withStorage({ tp_cfg: JSON.stringify({ url: 'https://example.com/exec', token: 't' }) }, () => assert.equal(C.readTrainingPlanConfig(), 'invalid'))
      await withStorage(cfg, () => assert.deepEqual(C.readTrainingPlanConfig(), { url: FAKE_URL, token: 'fake-token' }))
    })
  })

  describe('取得（fetchTrainingPlanIndex・読み取りのみ）', () => {
    it('POST 本文・text/plain・action は get・キーは索引。合言葉は本文だけ（URL はそのまま）。写す分だけにそろえて返す', async () => {
      const { result, calls } = await withStorage(cfg, () => withFetch(() => jsonRes({ ok: true, rev: 3, data: INDEX }), () => C.fetchTrainingPlanIndex()))
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, FAKE_URL)
      assert.equal(calls[0].init.method, 'POST')
      assert.equal(calls[0].init.headers['Content-Type'], 'text/plain;charset=UTF-8')
      assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'get', key: 'training_plan:index', token: 'fake-token' })
      assert.equal(result.ok, true)
      assert.equal(result.rows.length, 4)
      assert.equal(JSON.stringify(result).includes('見本'), false)
    })
    it('接続設定が無い・形が違う時は送らない', async () => {
      const a = await withStorage({}, () => withFetch(() => jsonRes({}), () => C.fetchTrainingPlanIndex()))
      assert.deepEqual([a.result, a.calls.length], [{ ok: false, reason: 'unconfigured' }, 0])
      const b = await withStorage({ tp_cfg: JSON.stringify({ url: 'https://example.com/x', token: 't' }) }, () => withFetch(() => jsonRes({}), () => C.fetchTrainingPlanIndex()))
      assert.deepEqual([b.result, b.calls.length], [{ ok: false, reason: 'url' }, 0])
    })
    it('索引のファイルが無い応答（data:null）は noindex（写さない＝「計画なし」に倒さない）。断られた・崩れた・HTTP の失敗・通信の失敗', async () => {
      const run = (impl) => withStorage(cfg, () => withFetch(impl, () => C.fetchTrainingPlanIndex())).then((x) => x.result)
      assert.deepEqual(await run(() => jsonRes({ ok: true, rev: 0, data: null })), { ok: false, reason: 'noindex' })
      assert.deepEqual(await run(() => jsonRes({ ok: false, error: 'unauthorized' })), { ok: false, reason: 'auth' })
      assert.deepEqual(await run(() => jsonRes({ ok: false, error: 'badkey' })), { ok: false, reason: 'refused' })
      assert.deepEqual(await run(() => new Response('<html>', { status: 200 })), { ok: false, reason: 'format' })
      assert.deepEqual(await run(() => jsonRes({ ok: true, data: [] })), { ok: false, reason: 'format' })
      assert.deepEqual(await run(() => jsonRes({}, 500)), { ok: false, reason: 'http' })
      assert.deepEqual(await run(() => Promise.reject(new TypeError('Failed to fetch'))), { ok: false, reason: 'network' })
      const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
      assert.deepEqual(await run(() => Promise.reject(abort)), { ok: false, reason: 'timeout' })
    })
    it('失敗の文は接続先・合言葉を含まない', () => {
      for (const r of ['unconfigured', 'url', 'timeout', 'network', 'http', 'auth', 'refused', 'format', 'noindex']) {
        const t = C.trainingPlanFailText(r)
        assert.match(t, /\S/)
        assert.equal(t.includes('script.google.com') || t.includes('token'), false)
      }
    })
  })

  describe('反証の直し（段階3c）', () => {
    it('年が 1900〜2100 の外の日付は null（年 0000 で写し全体が止まらないように・軽2）', () => {
      const out = C.normalizeTrainingPlanIndex({ rows: { T001: { latestPlanDate: '0000-01-01', nextDue: '1899-12-31', stop: { reason: 'stopped', from: '0001-01-01' } }, T002: { latestPlanDate: '2100-12-31', nextDue: '1900-01-01' } } })
      assert.deepEqual([out.rows[0].latest_plan_date, out.rows[0].next_due, out.rows[0].stop_reason, out.rows[0].stop_from], [null, null, null, null])
      assert.deepEqual([out.rows[1].latest_plan_date, out.rows[1].next_due], ['2100-12-31', '1900-01-01'])
    })
    it('送る前の突き合わせ: care-log の利用者番号と結べる行の数。1人も結べない時の文は「何も書いていません」（中1）', () => {
      const rows = C.normalizeTrainingPlanIndex(INDEX).rows
      assert.equal(C.countMatchable(rows, new Set(['T001', 'T004', 'X'])), 2)
      assert.equal(C.countMatchable(rows, new Set(['X'])), 0)
      assert.match(C.trainingDueNoMatchText(4), /4件）が、care-log の利用者と1人も結べなかったため、写しませんでした.*何も書いていません/)
    })
    it('関数が ok で0人・結べない0件（写せる行が無かった）の時も「写しました」と言わず、番号の形のせいにしない（確認の反証 軽1）', () => {
      const t = C.trainingDueSyncText({ ok: true, written: 0, unmatched: 0, cancelled: 0 })
      assert.equal(t.tone, 'warn')
      assert.doesNotMatch(t.text, /写しました|利用者番号の形/)
      assert.match(t.text, /写せる利用者が1人もいなかった/)
    })
    it('関数が ok でも1人も写っていなければ「写しました（0人）」と言わない（中1）', () => {
      const t = C.trainingDueSyncText({ ok: true, written: 0, unmatched: 3, cancelled: 0 })
      assert.equal(t.tone, 'warn')
      assert.doesNotMatch(t.text, /写しました/)
      assert.match(t.text, /1人も載りませんでした/)
    })
  })

  describe('写しの結果の文（trainingDueSyncText）', () => {
    it('書いた時は人数。結べなかった番号・外した方があれば添える', () => {
      assert.deepEqual(C.trainingDueSyncText({ ok: true, written: 5, unmatched: 0, cancelled: 0 }), { tone: 'info', text: '計画書の期限を写しました（5人）。' })
      const t = C.trainingDueSyncText({ ok: true, written: 5, unmatched: 2, cancelled: 1 })
      assert.equal(t.tone, 'warn')
      assert.match(t.text, /2件は、care-log の利用者と結べませんでした/)
      assert.match(t.text, /1人を、写しから外しました/)
    })
    it('止めた時は理由を平易に言い、「今の写しはそのまま」を添える', () => {
      for (const r of [
        { ok: false, reason: 'empty', existing: 8, incoming: null, cancel: null },
        { ok: false, reason: 'nomatch', existing: 8, incoming: 6, cancel: null },
        { ok: false, reason: 'too_many', existing: 8, incoming: null, cancel: 5 },
      ]) {
        const t = C.trainingDueSyncText(r)
        assert.equal(t.tone, 'warn')
        assert.match(t.text, /写しませんでした/)
        assert.match(t.text, /今の写し.*そのまま/)
      }
      assert.match(C.trainingDueSyncText({ ok: false, reason: 'nomatch', existing: 8, incoming: 6, cancel: null }).text, /利用者番号の形の違い/)
      assert.match(C.trainingDueSyncText({ ok: false, reason: 'too_many', existing: 8, incoming: null, cancel: 5 }).text, /8人のうち 5人/)
    })
  })
}

describe('静的検査（段階3c の規律）', () => {
  it('計画書アプリの読み口: tp_cfg は読むだけ（getItem 1か所・setItem/removeItem なし）・console に出さない・GAS へは get だけ', () => {
    const c = code('../src/lib/trainingPlanClient.ts')
    assert.equal((c.match(/localStorage\.getItem\(/g) ?? []).length, 1)
    assert.doesNotMatch(c, /setItem|removeItem|sessionStorage|indexedDB|console\./)
    assert.deepEqual([...new Set(c.match(/action: '[a-z]+'/g) ?? [])], ["action: 'get'"])
  })
  it('段階3c のファイルに、計画書の GAS へ書く・AI の経路が無い', () => {
    for (const f of ['../src/lib/trainingPlanClient.ts', '../src/lib/trainingDueSync.ts', '../src/components/DaycareReviewDueSection.tsx']) {
      assert.doesNotMatch(code(f), /'put'|"put"|'ai'|"ai"|'ping'|action: 'put'/, f)
    }
  })
  it('写しの手順: 役割を先に確かめてから接続設定を読む（現場では計画書の GAS へ送らない）・写した職員はいまの記録者', () => {
    const s = code('../src/lib/trainingDueSync.ts')
    const role = s.indexOf('canWriteMasters(await fetchMyRole())')
    const read = s.indexOf('fetchTrainingPlanIndex()')
    assert.ok(role > 0 && read > role)
    assert.match(s, /syncTrainingDue\(idx\.rows, idx\.settings, actorId\)/)
  })
  it('区画: 〔写す〕は事務所・管理者で接続設定がある時だけ（役割を先に見る）・押した時だけ写す・端末に残すのは開閉だけ', () => {
    const c = code('../src/components/DaycareReviewDueSection.tsx')
    assert.match(c, /const canCopy = canWriteMasters\(role\) && readTrainingPlanConfig\(\) !== null/)
    assert.equal((c.match(/syncTrainingPlanDue\(/g) ?? []).length, 1)
    assert.match(c, /onClick=\{\(\) => void doSync\(\)\}/)
    assert.equal((c.match(/localStorage\.(get|set)Item\(/g) ?? []).length, 2)
    assert.match(c, /window\.localStorage\.getItem\(LS\.dcTrainingReviewOpen\) === '1'/)
  })
  it('db.ts: 写しは 0046 の関数を1回呼ぶだけ・機能訓練の旗に従う・写した職員を渡す', () => {
    const db = code('../src/lib/db.ts')
    const f = db.slice(db.indexOf('export async function syncTrainingDue'), db.indexOf('// ── デイ（せせらぎ）の記録 段階2c'))
    assert.match(f, /await assertKindWritable\('daycare_training'\)/)
    assert.match(f, /sb\.rpc\('daycare_training_due_sync', \{ p_rows: rows, p_settings: settings, p_staff: idNum\(staffId\) \}\)/)
    assert.doesNotMatch(f, /from\('daycare_training_due/)
  })
  it('反証の直しの画面側の配線（確認の反証 軽2）: 区画は写しに1人も載っていない時に数を出さない・対象者の一覧は写しが0件の時も知らせる・カードは居宅訪問と写しを別々に読む', () => {
    const c = code('../src/components/DaycareReviewDueSection.tsx')
    const empty = c.slice(c.indexOf(") : cstate === 'empty' ? ("), c.indexOf('期限切れ {counts.overdue}人'))
    assert.ok(empty.length > 0)
    assert.match(empty, /計画書の写しに1人も載っていません/)
    assert.ok(c.indexOf(") : cstate === 'empty' ? (") < c.indexOf('期限切れ {counts.overdue}人'), '数は empty の分岐の後（ok の時だけ）')
    assert.match(c, /const cstate = loaded === null \? null : reviewCopyState\(loaded\)/)
    const p = code('../src/pages/DaycareTrainingPage.tsx')
    assert.match(p, /planOrder\?\.notice === 'empty' && targets\.length > 0 \? \(/)
    assert.match(p, /計画書の写しに載っている方がいないため、並びは到着の順のままです/)
    const card = code('../src/components/DaycareTrainingCard.tsx')
    assert.match(card, /fetchHomeVisits\(residentId\)\.catch\(\(\) => 'error' as const\), fetchTrainingDueCopy\(\)\.catch\(\(\) => 'error' as const\)/)
    const review = card.slice(card.indexOf('const reviewLine'), card.indexOf('const rline'))
    assert.doesNotMatch(review, /visits/, '見直しの行は居宅訪問の読み込みに左右されない')
  })
  it('見直しの一覧の絞り込みの配線（積み残し 51・親の訂正）: 画面は今日から7日分の予定で「週のどこかの曜日に予定がある方」を作って渡す。区画は読み込み中は数を出さず、一覧と件数の両方を絞った後で出す', () => {
    const p = code('../src/pages/DaycareTrainingPage.tsx')
    assert.match(p, /fetchDaycarePlanWeek\(todayIso\(\)\)\s*\.then\(\(plans\) => alive && setWeekIds\(weekScopeIds\(plans\)\)\)\s*\.catch\(\(\) => alive && setWeekIds\(null\)\)/)
    assert.match(p, /scopeIds=\{weekIds\}/)
    assert.doesNotMatch(p, /r\.planned\)\.map/, 'その日の盤では絞らない')
    const c = code('../src/components/DaycareReviewDueSection.tsx')
    assert.match(c, /filterReviewScope\(\s*reviewDueList\([\s\S]*?\),\s*scopeIds \?\? null,\s*\)/)
    assert.match(c, /const counts = reviewDueCounts\(rows\)/)
    assert.match(c, /\) : scopeIds === undefined \? \(/)
    const db = code('../src/lib/db.ts')
    assert.match(db, /Array\.from\(\{ length: 7 \}, \(_, i\) => fetchDaycarePlan\(addDaysIso\(baseIso, i\)\)\.catch\(\(\) => null\)\)/)
  })
  it('types.ts は LS に1行足すだけ（UI 状態のキー）', () => {
    assert.match(read('../src/lib/types.ts'), /dcTrainingReviewOpen: 'cl_dcTrainingReviewOpen',\n\} as const/)
  })
})
