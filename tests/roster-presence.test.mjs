// 名簿・記録者・入力中表示の回帰テスト（2026-10-10 多端末運用の監査 中核3: F45・F49・F43・F51・F50・F47・F46・F38・
// F22・F23・F24・F26・F21・F52）。直す前の版では赤、直した後で緑になる形。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// - gasClient.ts は './supabase' を tests/supabase-stub.mjs に差し替えて読む（解決フック）。db.ts には同じ偽のクライアントを
//   __testHooks.setClient で差し込む。GAS への通信は globalThis.fetch を偽物にして、送った要求を控える（本番に接続しない）
// - window・document は定義しない（起動時の自動処理は動かない。画面の出来事は __testHooks.lifecycle で起こす）
// - 個人情報は置かない（利用者・職員は合成の「利用者01」「職員01」と数値IDだけ）

import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const UNSUPPORTED =
  'この Node では TypeScript・解決フックを使えないため、名簿・入力中表示の検証をスキップしました（Node 22.18 以降で実行してください）。'

const lsStore = new Map()
const STUB_URL = new URL('./supabase-stub.mjs', import.meta.url).href
let D = null
let G = null
let PR = null
let A = null
let W = null
try {
  const { registerHooks } = await import('node:module')
  if (typeof registerHooks !== 'function') throw new Error('no registerHooks')
  registerHooks({
    resolve(specifier, context, next) {
      // gasClient.ts の './supabase' だけ偽物へ（本物は読み込んだ時点で接続先を求める）
      if (specifier === './supabase' && String(context.parentURL ?? '').endsWith('/src/lib/gasClient.ts')) {
        return { url: STUB_URL, shortCircuit: true }
      }
      if (/^\.{1,2}\//.test(specifier) && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
        try {
          return next(`${specifier}.ts`, context)
        } catch {
          // .ts が無いものは元の指定へ戻す
        }
      }
      return next(specifier, context)
    },
  })
  globalThis.localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => {
      lsStore.set(k, String(v))
    },
    removeItem: (k) => {
      lsStore.delete(k)
    },
  }
  D = await import('../src/lib/db.ts')
  G = await import('../src/lib/gasClient.ts')
  PR = await import('../src/lib/presence.ts')
  A = await import('../src/lib/actor.ts')
  W = await import('../src/lib/weightClient.ts')
} catch (e) {
  D = null
  if (process.env.CL_TEST_DEBUG) console.error(e)
}
const skip = D === null || G === null ? UNSUPPORTED : false
const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

// ── 偽の Supabase（メモリの表。通信しない） ─────────────────────────────────

/**
 * 表ごとの行を持つ偽のクライアント。select・insert・update と eq の絞り込み、order・limit だけを受ける。
 * calls に発行した要求を控える（書き込みが0件かを確かめるため）。fail(q) が { error } を返せばそれを返す
 */
function memSupabase(tables = {}, fail = () => null) {
  const db = { residents: [], staff: [], master_sync_log: [], ...tables }
  const calls = []
  let nextId = 1000
  const match = (row, filters) => filters.every(([op, k, v]) => (op === 'eq' ? row[k] === v : true))
  const from = (table) => {
    const q = { table, action: 'select', cols: undefined, returning: undefined, payload: undefined, filters: [], order: [], limit: undefined }
    const run = () => {
      calls.push(q)
      const f = fail(q)
      if (f) return f
      const rows = db[table] ?? (db[table] = [])
      if (q.action === 'select') {
        let out = rows.filter((r) => match(r, q.filters))
        for (const [k, o] of [...q.order].reverse()) {
          const asc = o?.ascending !== false
          out = [...out].sort((a, b) => (a[k] < b[k] ? (asc ? -1 : 1) : a[k] > b[k] ? (asc ? 1 : -1) : 0))
        }
        if (q.limit !== undefined) out = out.slice(0, q.limit)
        return { data: out.map((r) => ({ ...r })), error: null, status: 200 }
      }
      if (q.action === 'insert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload]
        for (const p of list) {
          const row = { id: nextId++, ...p }
          if (table === 'master_sync_log') row.synced_at = new Date().toISOString()
          rows.push(row)
        }
        return { data: null, error: null, status: 201 }
      }
      if (q.action === 'update') {
        const hit = rows.filter((r) => match(r, q.filters))
        for (const r of hit) Object.assign(r, q.payload)
        return { data: q.returning !== undefined ? hit.map((r) => ({ id: r.id })) : null, error: null, status: 200 }
      }
      return { data: null, error: null, status: 200 }
    }
    const b = {
      select(cols) {
        if (q.action === 'select' && q.cols === undefined) q.cols = cols
        else q.returning = cols
        return b
      },
      insert(p) {
        q.action = 'insert'
        q.payload = p
        return b
      },
      update(p) {
        q.action = 'update'
        q.payload = p
        return b
      },
      eq(k, v) {
        q.filters.push(['eq', k, v])
        return b
      },
      is(k, v) {
        q.filters.push(['is', k, v])
        return b
      },
      order(k, o) {
        q.order.push([k, o])
        return b
      },
      limit(n) {
        q.limit = n
        return b
      },
      then(res, rej) {
        return Promise.resolve(run()).then(res, rej)
      },
    }
    return b
  }
  return { db, calls, from }
}

/** 偽のクライアントを gasClient（stub 経由）と db.ts（setClient）の両方に置く */
function useClient(sb) {
  globalThis.__clStubSupabase = sb
  D.__testHooks.setClient(sb)
}

const MASTER_URL = 'https://script.google.com/macros/s/MASTER_DUMMY/exec'
const SHIFT_URL = 'https://script.google.com/macros/s/SHIFT_DUMMY/exec'
const POST_ONLY = 'この読み取りは POST でだけ受け付けます。もう一度お試しください（何度も出る時は画面を再読み込みしてください）'

/** 接続設定（合言葉は合成の値） */
function configure() {
  lsStore.set('cl_gasUrl', MASTER_URL)
  lsStore.set('cl_gasToken', 'tok-master')
  lsStore.set('cl_staffGasUrl', SHIFT_URL)
  lsStore.set('cl_staffGasToken', 'tok-shift')
}

/**
 * 偽の GAS（master.gs の規則を写したもの）。GET は stateRev 以外を断る。POST 本文の getRoster は合言葉が合えば名簿。
 * シフト連携の pull は ok:true つきで職員の名前を返す。requests に送った要求を控える
 */
function fakeGas({ roster = [], staff = [], rosterReplies = null } = {}) {
  const requests = []
  let rosterCalls = 0
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    requests.push({ url: String(url), method, body })
    const reply = (o) => ({ ok: true, status: 200, json: async () => o })
    if (String(url).startsWith(MASTER_URL)) {
      if (method === 'GET') return reply({ error: POST_ONLY })
      if (body?.action === 'getRoster') {
        rosterCalls += 1
        if (rosterReplies && rosterReplies[rosterCalls - 1] !== undefined) return reply(rosterReplies[rosterCalls - 1])
        if (body.token !== 'tok-master') return reply({ error: '認証エラー' })
        return reply({ roster, stateRev: 1, srev: 0 })
      }
      return reply({ error: '不明なaction' })
    }
    if (String(url).startsWith(SHIFT_URL)) {
      if (method === 'POST' && body?.action === 'pull' && body.token === 'tok-shift') {
        return reply({ ok: true, entries: { staff: { data: staff.map((n) => ({ name: n, active: true })) } } })
      }
      return reply({ ok: false })
    }
    throw new Error('想定外の宛先')
  }
  return { requests }
}

const realFetch = globalThis.fetch
const res = (id, sid, name, over = {}) => ({
  id,
  source_id: sid,
  name,
  kana: null,
  room: null,
  gender: null,
  care_level: null,
  active: true,
  needs_review: false,
  note_alias: null,
  ...over,
})
const two = (n) => String(n).padStart(2, '0')

afterEach(() => {
  globalThis.fetch = realFetch
  lsStore.clear()
  if (D) D.__testHooks.setClient(null)
  globalThis.__clStubSupabase = undefined
})

// ══════════════════════════════════════════════════════════════
// F45: 利用者名簿を POST 本文で読む（GET は 9/23 から必ず断られる）
// ══════════════════════════════════════════════════════════════
describe('F45 利用者マスタの名簿は POST 本文で読む', { skip }, () => {
  it('GET を送らず、合言葉を URL に載せず、POST 本文 {action:getRoster, token} で読んで反映する', async () => {
    configure()
    const sb = memSupabase({
      residents: [res(1, 'R001', '利用者01', { room: '101' }), res(2, 'R002', '利用者02', { room: '102' })],
      staff: [{ id: 1, name: '職員01', active: true, manual: false }],
    })
    useClient(sb)
    const gas = fakeGas({
      roster: [
        { id: 'R001', name: '利用者01', room: '101' },
        { id: 'R002', name: '利用者02', room: '205' },
      ],
      staff: ['職員01'],
    })
    const out = await G.syncMasters()
    assert.equal(typeof out, 'object')
    const toMaster = gas.requests.filter((r) => r.url.startsWith(MASTER_URL))
    assert.equal(toMaster.some((r) => r.method === 'GET'), false, 'GET を送っていない')
    assert.equal(toMaster.some((r) => r.url.includes('token')), false, '合言葉を URL に載せていない')
    assert.deepEqual(toMaster.map((r) => [r.method, r.body?.action, r.body?.token]), [['POST', 'getRoster', 'tok-master']])
    assert.equal(sb.db.residents.find((r) => r.id === 2).room, '205') // 部屋移動が届く
  })

  it('本文が落ちた読み取り（転送の揺れ）は1回だけ読み直して通す', async () => {
    configure()
    useClient(memSupabase({ residents: [res(1, 'R001', '利用者01')], staff: [{ id: 1, name: '職員01', active: true }] }))
    const gas = fakeGas({
      rosterReplies: [{ error: POST_ONLY }, { roster: [{ id: 'R001', name: '利用者01' }] }],
      staff: ['職員01'],
    })
    const out = await G.syncMasters()
    assert.equal(typeof out, 'object')
    assert.equal(gas.requests.filter((r) => r.body?.action === 'getRoster').length, 2)
  })

  it('合言葉の誤りは「合言葉」を案内し、電波・通信の確認へ誘導しない。利用者の一覧は変えない', async () => {
    configure()
    lsStore.set('cl_gasToken', 'wrong')
    const sb = memSupabase({ residents: [res(1, 'R001', '利用者01')], staff: [{ id: 1, name: '職員01', active: true }] })
    useClient(sb)
    fakeGas({ roster: [{ id: 'R001', name: '利用者01' }], staff: ['職員01'] })
    await assert.rejects(G.syncMasters(), (e) => {
      assert.match(e.message, /合言葉/)
      assert.doesNotMatch(e.message, /通信状態|電波/)
      assert.match(e.message, /利用者の一覧は変更していません/)
      return true
    })
    assert.equal(sb.calls.filter((q) => q.table === 'residents' && q.action !== 'select').length, 0)
  })

  it('静的: gasClient に GET の名簿取得が残っていない（method: GET・searchParams.set token が無い）', () => {
    const s = src('lib/gasClient.ts')
    assert.doesNotMatch(s, /method: 'GET'/)
    assert.doesNotMatch(s, /searchParams\.set/)
    assert.match(s, /gasPostRead<unknown>\(url, \{ action: 'getRoster' \}, token\)/)
  })
})

// ══════════════════════════════════════════════════════════════
// F49: 退去済みの行を氏名照合の候補にしない
// ══════════════════════════════════════════════════════════════
describe('F49 退去者と同じ氏名の新しい入居者', { skip }, () => {
  it('退去済み（active=false）の同名の行に保留を立てず、新しい方の行を作る', () => {
    const rows = [res(1, 'R001', '利用者 07', { active: false }), res(2, 'R002', '利用者02')]
    const plan = G.planResidentSync(rows, [
      { id: 'R002', name: '利用者02', active: true },
      { id: 'R050', name: '利用者　07', active: true },
    ])
    assert.deepEqual(plan.inserts.map((r) => r.source_id), ['R050'])
    assert.equal(plan.updates.some((u) => u.id === 1), false) // 退去行に needs_review を立てない
    assert.equal(plan.needsReview, 0)
  })

  it('在籍中の同名の行（ID 振り直しの疑い）は従来どおり保留にする', () => {
    const rows = [res(1, 'R001', '利用者07'), res(2, 'R002', '利用者02')]
    const plan = G.planResidentSync(rows, [
      { id: 'R002', name: '利用者02', active: true },
      { id: 'R050', name: '利用者07', active: true },
    ])
    assert.equal(plan.inserts.length, 0)
    assert.deepEqual(plan.updates, [{ id: 1, patch: { needs_review: true } }])
  })

  it('同期すると新しい方の行が在籍で作られる（現場用の合言葉の名簿＝退去者が載らない形）', async () => {
    configure()
    const sb = memSupabase({
      residents: [res(1, 'R001', '利用者 07', { active: false }), res(2, 'R002', '利用者02')],
      staff: [{ id: 1, name: '職員01', active: true }],
    })
    useClient(sb)
    fakeGas({ roster: [{ id: 'R002', name: '利用者02' }, { id: 'R050', name: '利用者　07' }], staff: ['職員01'] })
    const out = await G.syncMasters()
    assert.equal(out.residents.added, 1)
    const added = sb.db.residents.find((r) => r.source_id === 'R050')
    assert.equal(added?.active, true)
    assert.equal(sb.db.residents.find((r) => r.id === 1).needs_review, false)
  })
})

// ══════════════════════════════════════════════════════════════
// F51: 保留中でも部屋・介護度は名簿どおり。名簿の氏名を採用して保留を外す
// ══════════════════════════════════════════════════════════════
describe('F51 要確認（氏名の不一致）の方の部屋・介護度と、名簿の氏名の採用', { skip }, () => {
  it('氏名が食い違っても部屋・介護度は名簿どおりに直す。氏名・在籍状態は変えず保留にする', () => {
    const rows = [res(9, 'R009', '髙利用者09', { room: '102', care_level: '要介護1' })]
    const plan = G.planResidentSync(rows, [
      { id: 'R009', name: '高利用者09', room: '205', careLevel: '要介護3', active: false },
    ])
    assert.deepEqual(plan.updates, [{ id: 9, patch: { needs_review: true, room: '205', care_level: '要介護3' } }])
    assert.equal(plan.needsReview, 1)
    assert.equal(plan.retiredByRoster, 0) // 在籍状態は人が裁定するまで変えない
    assert.deepEqual(plan.reviews, [{ id: 9, current: '髙利用者09', roster: '高利用者09' }])
  })

  it('既に保留中でも、部屋が変われば部屋だけ直す（保留の印は書き直さない）', () => {
    const rows = [res(9, 'R009', '髙利用者09', { room: '102', needs_review: true })]
    const plan = G.planResidentSync(rows, [{ id: 'R009', name: '高利用者09', room: '205', active: true }])
    assert.deepEqual(plan.updates, [{ id: 9, patch: { room: '205' } }])
  })

  it('syncMasters は保留にした方を reviews で返す（名簿の氏名はメモリだけ）', async () => {
    configure()
    useClient(memSupabase({ residents: [res(9, 'R009', '髙利用者09')], staff: [{ id: 1, name: '職員01', active: true }] }))
    fakeGas({ roster: [{ id: 'R009', name: '高利用者09' }], staff: ['職員01'] })
    const out = await G.syncMasters()
    assert.deepEqual(out.reviews, [{ id: 9, current: '髙利用者09', roster: '高利用者09' }])
    assert.equal([...lsStore.values()].some((v) => v.includes('利用者09')), false)
  })

  it('adoptRosterName: 氏名と保留の解除を1回の update で、見ていた氏名のままの保留中の行だけに書く', async () => {
    const sb = memSupabase({ residents: [res(9, 'R009', '髙利用者09', { needs_review: true, note_alias: '表示名' })] })
    useClient(sb)
    assert.equal(await G.adoptRosterName(9, '髙利用者09', '高利用者09'), 'adopted')
    const ups = sb.calls.filter((q) => q.action === 'update')
    assert.equal(ups.length, 1)
    assert.deepEqual(Object.keys(ups[0].payload).sort(), ['name', 'needs_review', 'synced_at'])
    assert.deepEqual(ups[0].filters, [['eq', 'id', 9], ['eq', 'name', '髙利用者09'], ['eq', 'needs_review', true]])
    const row = sb.db.residents[0]
    assert.equal(row.name, '高利用者09')
    assert.equal(row.needs_review, false)
    assert.equal(row.note_alias, '表示名') // 表示名には触れない
    // 他の端末が先に直していた（氏名が変わった・保留が外れた）時は書かずに 'stale'
    assert.equal(await G.adoptRosterName(9, '髙利用者09', '高利用者09'), 'stale')
  })
})

// ══════════════════════════════════════════════════════════════
// F43: 名簿から一度に外れる人数が多ければ、書く前に止める
// ══════════════════════════════════════════════════════════════
describe('F43 名簿が一部しか返らない時の一斉の在籍解除を止める', { skip }, () => {
  const residents40 = () => Array.from({ length: 40 }, (_, i) => res(i + 1, `R${two(i + 1)}`, `利用者${two(i + 1)}`))
  const staff20 = () =>
    Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `職員${two(i + 1)}`, active: true, manual: i >= 18 }))
  const rosterOf = (n) => Array.from({ length: n }, (_, i) => ({ id: `R${two(i + 1)}`, name: `利用者${two(i + 1)}` }))
  const staffOf = (n) => Array.from({ length: n }, (_, i) => `職員${two(i + 1)}`)

  it('isMassDrop: 在籍の2割以上か5人以上で true。1〜2人の退去は通す', () => {
    assert.equal(G.isMassDrop(0, 40), false)
    assert.equal(G.isMassDrop(1, 40), false)
    assert.equal(G.isMassDrop(4, 40), false)
    assert.equal(G.isMassDrop(5, 40), true)
    assert.equal(G.isMassDrop(2, 10), true) // 2割
    assert.equal(G.isMassDrop(1, 10), false)
  })

  it('名簿が40人中3人しか返らない時は、どちらの表にも1行も書かずに MasterDropError（人数つき）で止める', async () => {
    configure()
    const sb = memSupabase({ residents: residents40(), staff: staff20() })
    useClient(sb)
    fakeGas({ roster: rosterOf(3), staff: staffOf(18) })
    await assert.rejects(G.syncMasters(), (e) => {
      assert.ok(e instanceof G.MasterDropError)
      assert.equal(e.residents, 37)
      assert.equal(e.staff, 0)
      assert.match(e.message, /利用者37人/)
      assert.match(e.message, /まだ何も変更していません/)
      return true
    })
    assert.equal(sb.calls.filter((q) => q.action !== 'select').length, 0)
    assert.equal(sb.db.residents.filter((r) => r.active).length, 40)
  })

  it('職員も数える（手で登録した職員は分子・分母から外す）', async () => {
    configure()
    const sb = memSupabase({ residents: residents40(), staff: staff20() })
    useClient(sb)
    fakeGas({ roster: rosterOf(40), staff: staffOf(3) })
    await assert.rejects(G.syncMasters(), (e) => e instanceof G.MasterDropError && e.staff === 15 && e.residents === 0)
    assert.equal(sb.calls.filter((q) => q.action !== 'select').length, 0)
  })

  it('人が確かめた人数（confirmedDrop）までは反映する。増えていればまた止める', async () => {
    configure()
    const sb = memSupabase({ residents: residents40(), staff: staff20() })
    useClient(sb)
    fakeGas({ roster: rosterOf(3), staff: staffOf(18) })
    await assert.rejects(G.syncMasters({ confirmedDrop: { residents: 30, staff: 0 } }), G.MasterDropError)
    const out = await G.syncMasters({ confirmedDrop: { residents: 37, staff: 0 } })
    assert.equal(out.residents.deactivated, 37)
    assert.equal(sb.db.residents.filter((r) => r.active).length, 3)
  })

  it('いつもの退去（1人が名簿から消えた）は止めずに反映する', async () => {
    configure()
    const sb = memSupabase({ residents: residents40(), staff: staff20() })
    useClient(sb)
    fakeGas({ roster: rosterOf(39), staff: staffOf(18) })
    const out = await G.syncMasters()
    assert.equal(out.residents.deactivated, 1)
  })
})

// ══════════════════════════════════════════════════════════════
// F50: 接続設定のある端末で、起動時と60分ごとに自動で同期する。最終同期の時刻を読む
// ══════════════════════════════════════════════════════════════
describe('F50 名簿の自動同期と最終同期の時刻', { skip }, () => {
  const base = () =>
    memSupabase({ residents: [res(1, 'R001', '利用者01')], staff: [{ id: 1, name: '職員01', active: true }] })

  it('接続設定の無い端末（現場の iPhone）は何もしない', async () => {
    useClient(base())
    const gas = fakeGas({ roster: [{ id: 'R001', name: '利用者01' }], staff: ['職員01'] })
    assert.equal(await G.autoSyncMasters(), 'unconfigured')
    assert.equal(G.hasMasterConnection(), false)
    assert.equal(gas.requests.length, 0)
  })

  it('他の端末が60分以内に同期していれば同期しない。60分を過ぎていれば同期して、すぐ後は同期しない', async () => {
    configure()
    const sb = base()
    const recent = new Date(Date.now() - 10 * 60_000).toISOString()
    sb.db.master_sync_log.push({ id: 1, source: 'residents', synced_at: recent }, { id: 2, source: 'staff', synced_at: recent })
    useClient(sb)
    const gas = fakeGas({ roster: [{ id: 'R001', name: '利用者01' }], staff: ['職員01'] })
    assert.equal(await G.autoSyncMasters(), 'fresh')
    assert.equal(gas.requests.length, 0)

    lsStore.clear()
    configure()
    const old = new Date(Date.now() - 2 * 3600_000).toISOString()
    sb.db.master_sync_log.splice(0, 2, { id: 1, source: 'residents', synced_at: old }, { id: 2, source: 'staff', synced_at: old })
    const out = await G.autoSyncMasters()
    assert.equal(typeof out, 'object')
    assert.ok(gas.requests.some((r) => r.body?.action === 'getRoster'))
    const n = gas.requests.length
    assert.equal(await G.autoSyncMasters(), 'fresh')
    assert.equal(gas.requests.length, n)
  })

  it('失敗したら throw して、10分は試し直さない（画面の出入りのたびに叩き続けない）', async () => {
    configure()
    lsStore.set('cl_gasToken', 'wrong')
    useClient(base())
    const gas = fakeGas({ roster: [{ id: 'R001', name: '利用者01' }], staff: ['職員01'] })
    await assert.rejects(G.autoSyncMasters(), /合言葉/)
    const n = gas.requests.length
    assert.equal(await G.autoSyncMasters(), 'fresh')
    assert.equal(gas.requests.length, n)
  })

  it('fetchLastMasterSync: 利用者・職員それぞれの最新の時刻（記録が無ければ null）', async () => {
    const sb = base()
    sb.db.master_sync_log.push(
      { id: 1, source: 'residents', synced_at: '2026-10-07T00:12:00.000Z' },
      { id: 2, source: 'residents', synced_at: '2026-10-09T00:12:00.000Z' },
    )
    useClient(sb)
    assert.deepEqual(await D.fetchLastMasterSync(), { residents: '2026-10-09T00:12:00.000Z', staff: null })
  })

  it('静的: 自動同期の部品は接続設定の無い端末で何もせず、MasterDropError でも自動で続けない', () => {
    const s = src('components/MasterSync.tsx')
    assert.match(s, /autoSyncMasters\(\)/)
    assert.doesNotMatch(s, /confirmedDrop/)
    assert.match(s, /print:hidden/)
    assert.match(s, /subscribeMastersChanged/)
  })
})

// ══════════════════════════════════════════════════════════════
// F47: App の職員名簿の取り直し（名簿が変わった合図・画面に戻った・電波が戻った）
// ══════════════════════════════════════════════════════════════
describe('F47 職員名簿を新しく保つ（watchStaffRoster）', { skip }, () => {
  it('sameStaffRoster: id・氏名・在籍が同じなら同じ', () => {
    const a = [{ id: 1, name: '職員01', active: true }]
    assert.equal(D.sameStaffRoster(a, [{ id: 1, name: '職員01', active: true }]), true)
    assert.equal(D.sameStaffRoster(a, [{ id: 1, name: '職員01', active: false }]), false)
    assert.equal(D.sameStaffRoster(a, []), false)
    assert.equal(D.sameStaffRoster(null, a), false)
  })

  it('名簿が変わった合図で取り直し、変わった時だけ知らせる。失敗した時は今の名簿を残す（何も呼ばない）', async () => {
    const sb = memSupabase({ staff: [{ id: 1, name: '職員01', active: true }] })
    useClient(sb)
    const base = [{ id: 1, name: '職員01', active: true }]
    const got = []
    const off = D.watchStaffRoster(base, (next) => got.push(next.map((s) => s.id)))
    D.notifyMastersChanged()
    await flush()
    assert.deepEqual(got, []) // 同じ中身なら呼ばない
    sb.db.staff.push({ id: 3, name: '職員03', active: true })
    D.notifyMastersChanged()
    await flush()
    assert.deepEqual(got, [[1, 3]])
    // 電波が戻った時も取り直す
    sb.db.staff[0].active = false
    D.__testHooks.lifecycle('online')
    await flush()
    assert.deepEqual(got, [[1, 3], [3]])
    // 取り直しに失敗（通信エラー）→ 何も呼ばない
    D.__testHooks.setClient({ from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'x' }, status: 0 }) }) }) }) }) })
    D.notifyMastersChanged()
    await flush()
    assert.equal(got.length, 2)
    off()
    useClient(sb)
    D.notifyMastersChanged()
    await flush()
    assert.equal(got.length, 2) // 外した後は呼ばない
  })

  it('マスタ同期で職員が増えたら、開いている App の名簿へ届く（gasClient → notifyMastersChanged）', async () => {
    configure()
    const sb = memSupabase({ residents: [res(1, 'R001', '利用者01')], staff: [{ id: 1, name: '職員01', active: true }] })
    useClient(sb)
    fakeGas({ roster: [{ id: 'R001', name: '利用者01' }], staff: ['職員01', '職員03'] })
    const got = []
    const off = D.watchStaffRoster([{ id: 1, name: '職員01', active: true }], (next) => got.push(next.map((s) => s.name)))
    await G.syncMasters()
    await flush()
    off()
    assert.deepEqual(got, [['職員01', '職員03']])
  })
})

// ══════════════════════════════════════════════════════════════
// F46・F38: 記録者の切り替えを知らせる／バイタル・食事の画面の「記録者」表示
// ══════════════════════════════════════════════════════════════
describe('F46・F38 記録者の切り替え', { skip }, () => {
  it('subscribeActor: 設定タブなどで切り替えると、その場で知らせる（再読み込みを待たない）', () => {
    const got = []
    const off = A.subscribeActor((id) => got.push(id))
    A.setActorId(2)
    A.setActorId(5)
    A.clearActor()
    A.setActorId(0) // 不正値は保存もしないし知らせない
    off()
    A.setActorId(7)
    assert.deepEqual(got, [2, 5, null])
  })

  it('静的: 記録者の部品は常に「記録者: 名前」と〔変更〕を出し、actor.setActorId で切り替え、印刷に出さない', () => {
    const s = src('components/RecorderBar.tsx')
    assert.match(s, /export function RecorderBar\(/)
    assert.match(s, /記録者: /)
    assert.match(s, /'変更'/)
    assert.match(s, /setActorId\(id\)/)
    assert.match(s, /StaffPickerModal/)
    assert.match(s, /print:hidden/)
    assert.match(s, /min-h-tap/)
    // 自動で既定を外さない（本人回答）＝時刻で判定する処理を持たない
    assert.doesNotMatch(s, /shouldReconfirm|clearActor|Date\.now/)
  })
})

// ══════════════════════════════════════════════════════════════
// F22: 画面を隠したら「入力中」を取り消す・操作が無ければ配らない
// ══════════════════════════════════════════════════════════════
describe('F22 画面を隠した・操作が無い間は「入力中」を配らない', { skip }, () => {
  function presenceClient() {
    const log = []
    const ch = {
      topic: 'realtime:cl_note_presence',
      state: {},
      on() {
        return ch
      },
      subscribe(cb) {
        cb('SUBSCRIBED')
        return ch
      },
      track(m) {
        log.push(['track', m.cell?.field ?? null])
        return Promise.resolve('ok')
      },
      untrack() {
        log.push(['untrack'])
        return Promise.resolve('ok')
      },
      presenceState() {
        return ch.state
      },
    }
    const sb = { channel: () => ch, getChannels: () => [], removeChannel: () => Promise.resolve('ok'), from: () => { throw new Error('no table') } }
    return { sb, log }
  }
  const here = { staffId: 1, day: '2026-10-09', residentId: 1, cell: { table: 'vitals', field: 'temp' } }

  it('隠したら untrack し、隠れている間は心拍で配り直さない。見えたら同じ欄を配り直す。抜けた後は何もしない', async () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-09T01:00:00Z') })
    try {
      const { sb, log } = presenceClient()
      D.__testHooks.setClient(sb)
      const p = D.joinPresence(here, () => {})
      await flush()
      assert.deepEqual(log, [['track', 'temp']])
      D.__testHooks.lifecycle('hidden')
      assert.deepEqual(log.at(-1), ['untrack'])
      const n = log.length
      mock.timers.tick(5 * 60_000) // 心拍の刻みが何度来ても配らない
      assert.equal(log.length, n)
      D.__testHooks.lifecycle('visible')
      assert.deepEqual(log.at(-1), ['track', 'temp'])
      p.stop()
      const m = log.length
      D.__testHooks.lifecycle('hidden')
      D.__testHooks.lifecycle('visible')
      assert.equal(log.length, m)
    } finally {
      D.__testHooks.lifecycle('visible')
      mock.timers.reset()
    }
  })

  it('createActivityGate: 開いた直後は操作していない扱い。操作から3分で切れ、次の操作で「戻った」を返す', () => {
    const g = PR.createActivityGate()
    const t0 = 1_000_000
    assert.equal(g.active(t0), false) // 控えから戻しただけの書きかけを、開いただけで配らない
    assert.equal(g.dueAt(), null)
    assert.equal(g.touch(t0), true)
    assert.equal(g.active(t0 + PR.PRESENCE_IDLE_MS - 1), true)
    assert.equal(g.dueAt(), t0 + PR.PRESENCE_IDLE_MS)
    assert.equal(g.active(t0 + PR.PRESENCE_IDLE_MS), false)
    assert.equal(g.touch(t0 + 60_000), false) // 操作中の操作は「戻った」ではない
    assert.equal(g.touch(t0 + 60_000 + PR.PRESENCE_IDLE_MS + 1), true)
    assert.equal(PR.PRESENCE_IDLE_MS, 3 * 60_000)
  })

  it('静的: フックは操作が切れたら配らず（欄は持ったまま）、画面全体の打鍵・タップ・入力を操作として数える', () => {
    const s = src('hooks/useCellPresence.ts')
    assert.match(s, /if \(!gateRef\.current\.active\(Date\.now\(\)\)\) return null/)
    assert.match(s, /const ACTIVITY_EVENTS = \['keydown', 'pointerdown', 'input', 'compositionupdate'\]/)
    assert.match(s, /document\.addEventListener\(ev, onAct, opts\)/)
    assert.match(s, /document\.removeEventListener\(ev, onAct, opts\)/)
    // 取り消した時に欄（slot）を外さない＝タイマーは send() だけを呼ぶ
    assert.match(s, /idleTimerRef\.current = null\s*\n\s*send\(\)/)
  })
})

// ══════════════════════════════════════════════════════════════
// F23・F24: 同じ鍵に meta が複数ある時は新しい方・古さは受け手の時計で測る
// ══════════════════════════════════════════════════════════════
describe('F23・F24 受け取った居場所の読み方', { skip }, () => {
  const NOW = Date.parse('2026-10-09T03:00:00.000Z')
  const iso = (msAgo) => new Date(NOW - msAgo).toISOString()
  const D9 = '2026-10-09'
  const m = (resident, field, at, ref) => ({
    staffId: 1,
    day: D9,
    residentId: resident,
    cell: { table: 'vitals', field },
    ...(at !== undefined ? { at } : {}),
    ...(ref !== undefined ? { presence_ref: ref } : {}),
  })
  const pick = (out) => out.map((p) => `${p.residentId}:${p.cell?.field}`)

  it('F23: [古い欄, 新しい欄] でも [新しい欄, 古い欄] でも新しい欄を採る（1つの鍵からは1件だけ）', () => {
    const a = PR.othersFromState({ k: [m(1, 'temp', iso(50_000)), m(2, 'pulse', iso(5_000))] }, 'me', NOW)
    const b = PR.othersFromState({ k: [m(2, 'pulse', iso(5_000)), m(1, 'temp', iso(50_000))] }, 'me', NOW)
    assert.deepEqual(pick(a), ['2:pulse'])
    assert.deepEqual(pick(b), ['2:pulse'])
  })

  it('F23: [4分前, 5秒前] は鍵ごと消さず新しい方を出す。at の無い旧版の要素は at のある要素に負ける', () => {
    assert.deepEqual(pick(PR.othersFromState({ k: [m(1, 'temp', iso(4 * 60_000)), m(2, 'pulse', iso(5_000))] }, 'me', NOW)), ['2:pulse'])
    assert.deepEqual(pick(PR.othersFromState({ k: [m(1, 'temp'), m(2, 'pulse', iso(5_000))] }, 'me', NOW)), ['2:pulse'])
    assert.deepEqual(pick(PR.othersFromState({ k: [m(1, 'temp')] }, 'me', NOW)), ['1:temp']) // 旧版だけなら従来どおり
  })

  it('F24: 送り手の時計が4分遅れていても、受け手が初めて見てから3分は出す（送り手の時計で捨てない）', () => {
    const seen = new Map()
    const state = { k: [m(1, 'temp', iso(4 * 60_000), 'r1')] }
    assert.deepEqual(pick(PR.othersFromState(state, 'me', NOW)), []) // 控え無し（従来の読み方）は捨てる
    assert.deepEqual(pick(PR.othersFromState(state, 'me', NOW, seen)), ['1:temp'])
    assert.deepEqual(pick(PR.othersFromState(state, 'me', NOW + 2 * 60_000, seen)), ['1:temp'])
    // 配り直しが来ないまま（切断を検知できなかった）受け手の時計で3分を超えたら捨てる
    assert.deepEqual(pick(PR.othersFromState(state, 'me', NOW + 3 * 60_000 + 1, seen)), [])
    // 配り直し（at が変わる）が届けば、また初めて見た要素として出す
    const again = { k: [m(1, 'temp', iso(3 * 60_000), 'r2')] }
    assert.deepEqual(pick(PR.othersFromState(again, 'me', NOW + 4 * 60_000, seen)), ['1:temp'])
  })

  it('F24: 時計が1日進んだ端末の残骸も、受け手の時計で3分たてば捨てる。消えた要素の控えは残さない', () => {
    const seen = new Map()
    const state = { k: [m(1, 'temp', new Date(NOW + 86_400_000).toISOString(), 'r1')] }
    assert.equal(PR.othersFromState(state, 'me', NOW, seen).length, 1)
    assert.equal(PR.othersFromState(state, 'me', NOW + 3 * 60_000 + 1, seen).length, 0)
    PR.othersFromState({}, 'me', NOW + 4 * 60_000, seen)
    assert.equal(seen.size, 0)
  })

  it('静的: joinPresence は参加ごとの控えを othersFromState に渡し、抜ける時に捨てる', () => {
    const s = src('lib/db.ts')
    assert.match(s, /othersFromState\(ch\.presenceState\(\), key, Date\.now\(\), seen\)/)
    assert.match(s, /seen\.clear\(\)/)
  })
})

// ══════════════════════════════════════════════════════════════
// F26: 同じ職員の別の端末は「あなたの別の端末」
// ══════════════════════════════════════════════════════════════
describe('F26 同じ職員の別の端末の出し分け', { skip }, () => {
  const names = new Map([
    [1, '職員01'],
    [2, '職員02'],
  ])
  const nameOf = (id) => names.get(id) ?? null
  const p = (staffId) => ({ staffId, day: '2026-10-09', residentId: 1, cell: { table: 'vitals', field: 'temp', kind: 'routine' } })

  it('欄・行見出し: 受け手の記録者と同じ職員は「あなたの別の端末で入力中」。他の職員と並ぶ時も見分けられる', () => {
    assert.deepEqual(PR.cellBusyText([p(1)], nameOf, 1), { label: 'あなたの別の端末で入力中', speech: 'あなたの別の端末で入力中です' })
    assert.equal(PR.cellBusyText([p(2), p(1)], nameOf, 1).label, '職員02・あなたの別の端末 入力中')
    assert.equal(PR.rowBusyText([p(1)], nameOf, 1), '入力中: あなたの別の端末')
    // 記録者を選んでいない（null）・省略は従来どおり名前で出す
    assert.deepEqual(PR.cellBusyText([p(1)], nameOf, null), { label: '職員01 入力中', speech: '職員01が入力中です' })
    assert.deepEqual(PR.cellBusyText([p(1)], nameOf), { label: '職員01 入力中', speech: '職員01が入力中です' })
  })

  it('要約・名前の並び: 自分の別の端末は名前の代わりに出し、2台以上なら台数を添える', () => {
    const e = (staffId, what) => ({ p: { staffId, day: '2026-10-09', residentId: 1 }, what })
    assert.equal(
      PR.presenceSummaryText([e(1, '利用者01 体温'), e(2, '利用者02 脈拍')], nameOf, 3, 1),
      '入力中: あなたの別の端末（利用者01 体温）・職員02（利用者02 脈拍）',
    )
    assert.equal(
      PR.presenceSummaryText([e(1, '利用者01 体温'), e(1, '利用者03 体温')], nameOf, 3, 1),
      '入力中: あなたの別の端末（2台・利用者01 体温、利用者03 体温）',
    )
    assert.deepEqual(PR.presenceWhoNames([p(1), p(2)], nameOf, undefined, 1), ['あなたの別の端末', '職員02'])
    assert.deepEqual(PR.presenceWhoNames([p(1), p(2)], nameOf), ['職員01', '職員02'])
  })

  it('静的: フックは記録者（actorId）を受け手として渡す', () => {
    const s = src('hooks/useCellPresence.ts')
    assert.match(s, /cellBusyText\(presenceForCell\(index, Array\.isArray\(targets\) \? targets : \[targets\]\), nameOf, actorId\)/)
    assert.match(s, /presenceSummaryText\(entries, nameOf, undefined, actorId\)/)
  })
})

// ══════════════════════════════════════════════════════════════
// F21: 「書いています」は操作している時だけ（戻しただけ・送信待ちの行は数えない）
// ══════════════════════════════════════════════════════════════
describe('F21 「書いています」の判定（liveComposing・latestComposing）', { skip }, () => {
  const T = 5_000_000
  const row = (key, over = {}) => ({ key, residentId: 3, targetPicked: true, body: '', locked: false, ...over })

  it('控えから戻しただけの行（手を入れていない）は数えない。手を入れた行だけ、最後の操作から3分以内', () => {
    const rows = [row('a')]
    assert.equal(PR.liveComposing(rows, new Map(), T), null)
    const touched = new Map([['a', T]])
    assert.deepEqual(PR.liveComposing(rows, touched, T + 60_000), { residentId: 3, at: T })
    assert.equal(PR.liveComposing(rows, touched, T + PR.PRESENCE_IDLE_MS), null)
  })

  it('送信待ち・止まった登録（locked）と中身の無い行は数えない。対象を選んでいなければ residentId=null', () => {
    const touched = new Map([['a', T], ['b', T], ['c', T]])
    assert.equal(PR.liveComposing([row('a', { locked: true })], touched, T), null)
    assert.equal(PR.liveComposing([row('b', { targetPicked: false })], touched, T), null)
    assert.deepEqual(PR.liveComposing([row('c', { targetPicked: false, body: 'メモ' })], touched, T), { residentId: null, at: T })
  })

  it('latestComposing: 区切りの中の過去の日より、最後に手を入れた日を配る', () => {
    const byDay = new Map([
      ['2026-10-06', { residentId: 2, at: T }],
      ['2026-10-09', { residentId: 3, at: T + 1000 }],
    ])
    assert.deepEqual(PR.latestComposing(byDay), { day: '2026-10-09', residentId: 3 })
    assert.equal(PR.latestComposing(new Map()), null)
  })
})

// ══════════════════════════════════════════════════════════════
// F52: 体重管理アプリを開いたことの無い端末でも、'wm_'＋masterId の入居者は当てる
// ══════════════════════════════════════════════════════════════
describe('F52 カルテの体重の端末差（wm_ の id から当てる）', { skip: W === null ? UNSUPPORTED : false }, () => {
  const WURL = 'https://script.google.com/macros/s/WEIGHT_DUMMY/exec'
  beforeEach(() => W.clearWeightCache())
  afterEach(() => W.clearWeightCache())
  function server(body) {
    lsStore.set('wtmgr_api_url', WURL)
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body })
  }

  it('wtmgr_v1 の無い端末でも、サーバーの wm_M001（masterId なし）の記録を source_id M001 の方に出す', async () => {
    server({
      ok: true,
      residents: [{ id: 'wm_M001', name: 'ダミー' }],
      records: [{ residentId: 'wm_M001', measuredOn: '2026-10-01', weight: 52.3 }],
    })
    const r = await W.fetchWeights([{ id: 1, source_id: 'M001' }, { id: 2, source_id: 'M002' }])
    assert.deepEqual(r.byResident.get(1)?.map((e) => e.weight), [52.3])
    assert.equal(r.byResident.has(2), false)
    assert.equal(r.linked, 0) // 端末の対応表の件数は従来どおり（案内の出し分けは変えない）
  })

  it('id の規則は体重管理アプリ（wrMasterResId）と同じ（英数字・_・- 以外は _＋16進・0埋めしない）', () => {
    assert.equal(W.weightMasterResId('M001'), 'wm_M001')
    assert.equal(W.weightMasterResId('A.1/2'), 'wm_A_2e1_2f2')
    assert.equal(W.weightMasterResId('x y'), 'wm_x_20y')
  })

  it('端末かサーバーがその id に別の masterId を持つ時は、id から推定しない（食い違いを上書きしない）', async () => {
    server({
      ok: true,
      residents: [{ id: 'wm_M001', name: 'ダミー' }],
      records: [{ residentId: 'wm_M001', measuredOn: '2026-10-01', weight: 52.3 }],
    })
    lsStore.set('wtmgr_v1', JSON.stringify({ residents: [{ id: 'wm_M001', masterId: 'M009' }], records: [] }))
    const r = await W.fetchWeights([{ id: 1, source_id: 'M001' }])
    assert.equal(r.byResident.has(1), false)
    W.clearWeightCache()
    lsStore.delete('wtmgr_v1')
    server({
      ok: true,
      residents: [{ id: 'wm_M001', masterId: 'M009' }],
      records: [{ residentId: 'wm_M001', measuredOn: '2026-10-01', weight: 52.3 }],
    })
    const s = await W.fetchWeights([{ id: 1, source_id: 'M001' }])
    assert.equal(s.byResident.has(1), false)
  })
})
