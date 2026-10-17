// 裏での先読み（2026-10-17 本人依頼「待ち時間なしで画面を開く」）の回帰テスト。直す前の版では赤（部品が無い）、直した後で緑。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 控えの層（src/lib/dataCache.ts・純粋）: 同時取得の1本化・古いの印（表と日付）・世代で古い応答を捨てる・全部捨てる・
//    同じ中身なら同じ参照・空の結果の扱い・まとめ取り・先読みの順番待ち（同時2本・止める条件・失敗しても次へ）
// 2. db につなぐ層（src/lib/cachedReads.ts）: 偽の Supabase で、取得が控えに入る・相乗り・変更通知と自分の書込で古くなる・
//    ログインの控えの無い0件を控えない（F58）・ログアウトで全部捨てる・先読みの順番の中身
// 3. 配線の静的な見張り: 各画面が控えを通して取る・入力解禁の旗/役割/版の確かめは控えない・App の先読み・
//    localStorage/IndexedDB に置かない
// 個人情報は置かない（利用者・職員は合成の「利用者01」「職員01」と数値IDだけ）。

import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const UNSUPPORTED = 'この Node では TypeScript・解決フックを使えないため、先読みの検証をスキップしました（Node 22.18 以降で実行してください）。'

let C = null // dataCache.ts
let R = null // cachedReads.ts
let DB = null
let cLoadError = null
let rLoadError = null
try {
  C = await import('../src/lib/dataCache.ts')
} catch (e) {
  cLoadError = e
}
if (C === null) registerLoadFailure('先読みの控えの層', cLoadError, UNSUPPORTED)

const lsStore = new Map()
try {
  const { registerHooks } = await import('node:module')
  if (typeof registerHooks !== 'function') throw new Error('no registerHooks')
  registerHooks({
    resolve(specifier, context, next) {
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
  if (globalThis.localStorage === undefined) {
    globalThis.localStorage = {
      getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
      setItem: (k, v) => lsStore.set(k, String(v)),
      removeItem: (k) => lsStore.delete(k),
    }
  }
  DB = await import('../src/lib/db.ts')
  R = await import('../src/lib/cachedReads.ts')
} catch (e) {
  rLoadError = e
  R = null
}
if (R === null) registerLoadFailure('先読みの db につなぐ層', rLoadError, UNSUPPORTED, { hooks: true })

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
// コメント（行末の // と、ブロックのコメント）を外した本文
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const tick = () => new Promise((r) => setTimeout(r, 0))
/** 外から解決できる約束（応答の順番を試験が決める） */
function deferred() {
  let resolve
  let reject
  const p = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { p, resolve, reject }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 控えの層（純粋）
// ─────────────────────────────────────────────────────────────────────────────

describe('★先読み 控えの層（dataCache）', { skip: C === null }, () => {
  const meta = { tables: ['vitals'], from: '2026-10-13', to: '2026-10-16' }

  it('同じキーの同時取得は1本にまとめ、結果を控える（peek は控えを返す）', async () => {
    const c = C.createDataCache()
    let n = 0
    const d = deferred()
    const fn = () => {
      n += 1
      return d.p
    }
    const a = c.fetch('k', fn, { meta })
    const b = c.fetch('k', fn, { meta })
    assert.equal(n, 1)
    d.resolve([{ id: 1 }])
    assert.deepEqual(await a, [{ id: 1 }])
    assert.equal(await b, await a)
    assert.deepEqual(c.peek('k'), [{ id: 1 }])
  })

  it('先読みで取得して少しの間（REUSE_MS）の古くなっていない控えは通信せずに使う。過ぎた・古い・画面が取った控えは取りに行く', async () => {
    let t = 1_000_000
    const c = C.createDataCache(() => t)
    let n = 0
    const fn = async () => [++n]
    // 画面が自分で取った控えは使い回さない（〔最新を読み込む〕は必ず取りに行く）
    await c.fetch('s', fn, { meta })
    await c.fetch('s', fn, { meta })
    assert.equal(n, 2)
    n = 0
    await c.ensure('k', fn, { meta })
    t += C.REUSE_MS - 1
    assert.deepEqual(await c.fetch('k', fn, { meta }), [1])
    assert.equal(n, 1)
    t += 1
    assert.deepEqual(await c.fetch('k', fn, { meta }), [2])
    assert.equal(n, 2)
    c.markStale('vitals', null)
    assert.deepEqual(await c.fetch('k', fn, { meta }), [3])
    assert.equal(n, 3)
  })

  it('取り直した中身が同じなら控えの値（同じ参照）を返す。違えば新しい値', async () => {
    const c = C.createDataCache()
    const o = { meta, reuseMs: 0 } // 必ず取りに行く
    const first = await c.fetch('k', async () => [{ id: 1, v: 'a' }], o)
    const again = await c.fetch('k', async () => [{ id: 1, v: 'a' }], o)
    assert.equal(again, first)
    const changed = await c.fetch('k', async () => [{ id: 1, v: 'b' }], o)
    assert.notEqual(changed, first)
    assert.deepEqual(c.peek('k'), [{ id: 1, v: 'b' }])
    // Map も中身で比べる
    const m1 = await c.fetch('m', async () => new Map([[1, { x: 1 }]]), o)
    const m2 = await c.fetch('m', async () => new Map([[1, { x: 1 }]]), o)
    assert.equal(m2, m1)
  })

  it('変更通知の表と日付で当たる控えだけに古いの印（範囲外・別の表は当たらない）。印の付いた控えは peek が返さない', async () => {
    const c = C.createDataCache()
    await c.fetch('v', async () => [1], { meta })
    await c.fetch('m', async () => [2], { meta: { tables: ['meals'], from: '2026-10-13', to: '2026-10-16' } })
    assert.equal(c.markStale('vitals', '2026-10-12'), 0) // 範囲の前
    assert.equal(c.markStale('vitals', '2026-10-17'), 0) // 範囲の後
    assert.equal(c.markStale('notes', '2026-10-14'), 0) // 別の表
    assert.deepEqual(c.peek('v'), [1])
    assert.equal(c.markStale('vitals', '2026-10-14'), 1)
    assert.equal(c.peek('v'), undefined)
    assert.equal(c.entry('v').stale, true)
    assert.deepEqual(c.peek('m'), [2])
    // 行が分からない（null）はその表の控え全部
    assert.equal(c.markStale('meals', null), 1)
    assert.equal(c.peek('m'), undefined)
  })

  it('継続の申し送り（notesUpTo）を載せる控えは、範囲より前の日の申し送りの変更でも古くなる', () => {
    const tl = { tables: ['notes', 'vitals'], from: '2026-10-07', to: '2026-10-16', notesUpTo: true }
    assert.equal(C.metaHit(tl, 'notes', '2026-09-01'), true)
    assert.equal(C.metaHit(tl, 'vitals', '2026-09-01'), false)
    assert.equal(C.metaHit(tl, 'notes', '2026-10-17'), false)
    assert.equal(C.metaHit({ tables: ['notes'], from: '2026-10-07', to: '2026-10-16' }, 'notes', '2026-09-01'), false)
  })

  it('取りに行っている間に古くなった応答は控えに入れない（世代）。次の取得はその取得に相乗りしない', async () => {
    const c = C.createDataCache()
    const d1 = deferred()
    const p1 = c.fetch('v', () => d1.p, { meta })
    c.markStale('vitals', '2026-10-15') // 取得の途中で変更が届いた
    let n2 = 0
    const p2 = c.fetch('v', async () => {
      n2 += 1
      return ['new']
    }, { meta })
    assert.equal(n2, 1) // 古い世代の取得には相乗りしない
    d1.resolve(['old'])
    assert.deepEqual(await p1, ['old']) // 呼んだ画面には返す
    assert.deepEqual(await p2, ['new'])
    assert.deepEqual(c.peek('v'), ['new'])
    // 古い応答が後から返っても、新しい控えを上書きしない
    const c2 = C.createDataCache()
    const slow = deferred()
    const ps = c2.fetch('v', () => slow.p, { meta })
    c2.markStale('vitals', null)
    await c2.fetch('v', async () => ['fresh'], { meta })
    slow.resolve(['stale'])
    await ps
    assert.deepEqual(c2.peek('v'), ['fresh'])
  })

  it('全部捨てる（ログアウト・記録者の変更）と、走っていた取得の応答も控えに入れない', async () => {
    const c = C.createDataCache()
    await c.fetch('a', async () => [1], { meta })
    const d = deferred()
    const p = c.fetch('b', () => d.p, { meta })
    c.clearAll()
    assert.deepEqual(c.keys(), [])
    d.resolve([2])
    await p
    assert.equal(c.peek('b'), undefined)
    assert.equal(c.entry('b'), undefined)
  })

  it('空の結果は storeEmpty の時だけ控える（ログインの控えが無い0件を例外にしない取得は控えない・F58）', async () => {
    const c = C.createDataCache()
    await c.fetch('e1', async () => [], { meta })
    assert.equal(c.entry('e1'), undefined)
    await c.fetch('e2', async () => new Map(), { meta })
    assert.equal(c.entry('e2'), undefined)
    await c.fetch('e3', async () => null, { meta })
    assert.equal(c.entry('e3'), undefined)
    await c.fetch('e4', async () => [], { meta, storeEmpty: true })
    assert.deepEqual(c.peek('e4'), [])
    await c.fetch('e5', async () => ({ available: false }), { meta, isEmpty: (v) => v.available !== true })
    assert.equal(c.entry('e5'), undefined)
  })

  it('失敗した取得は控えない（前の控えは残す）。次の取得は新しく取りに行く', async () => {
    const c = C.createDataCache()
    await c.fetch('k', async () => [1], { meta })
    await assert.rejects(c.fetch('k', async () => {
      throw new Error('通信')
    }, { meta, reuseMs: 0 }))
    assert.deepEqual(c.peek('k'), [1])
  })

  it('ensure は古くなっていない控えがあれば通信しない。古い・無い時だけ取りに行く', async () => {
    const c = C.createDataCache()
    let n = 0
    const fn = async () => {
      n += 1
      return [n]
    }
    assert.equal(await c.ensure('k', fn, { meta }), true)
    assert.equal(await c.ensure('k', fn, { meta }), false)
    assert.equal(n, 1)
    c.markAllStale()
    assert.deepEqual(c.staleKeys(), ['k'])
    assert.equal(await c.ensure('k', fn, { meta }), true)
    assert.equal(n, 2)
    assert.deepEqual(c.peek('k'), [2])
  })

  it('まとめ取り（日報の10日）: 各日を控え、取りに行っている間に古くなった日だけ入れない。同じまとめ取りは1本', async () => {
    const c = C.createDataCache()
    const optsFor = (k) => ({ meta: { tables: ['notes'], from: k, to: k }, storeEmpty: true, isEmpty: () => false })
    const d = deferred()
    let n = 0
    const run = () => {
      n += 1
      return d.p
    }
    const p1 = c.fetchGroup('g', ['2026-10-01', '2026-10-02'], run, optsFor)
    const p2 = c.fetchGroup('g', ['2026-10-01', '2026-10-02'], run, optsFor)
    assert.equal(n, 1)
    c.markStale('notes', '2026-10-02')
    d.resolve(new Map([['2026-10-01', { a: 1 }], ['2026-10-02', { a: 2 }]]))
    const got = await p1
    assert.equal(await p2, got)
    assert.deepEqual(got.get('2026-10-02'), { a: 2 }) // 画面には返す
    assert.deepEqual(c.peek('2026-10-01'), { a: 1 })
    assert.equal(c.peek('2026-10-02'), undefined) // 控えには入れない
  })

  it('印が付いたら onStale の受け口を呼ぶ（先読みの取り直しを起こす）', async () => {
    const c = C.createDataCache()
    let n = 0
    const off = c.onStale(() => {
      n += 1
    })
    await c.fetch('k', async () => [1], { meta })
    c.markStale('vitals', '2026-10-14')
    assert.equal(n, 1)
    c.markStale('vitals', '2026-10-14') // もう古い＝数えない
    assert.equal(n, 1)
    off()
    c.clearAll()
    assert.equal(n, 1)
  })

  it('変更通知の行の日付の列（表ごと）。読めない・行が無い時は null', () => {
    assert.equal(C.changedRowDay('vitals', { measured_on: '2026-10-14' }), '2026-10-14')
    assert.equal(C.changedRowDay('meals', { meal_on: '2026-10-14' }), '2026-10-14')
    assert.equal(C.changedRowDay('fluid_intake', { taken_on: '2026-10-14' }), '2026-10-14')
    assert.equal(C.changedRowDay('notes', { note_on: '2026-10-14' }), '2026-10-14')
    assert.equal(C.changedRowDay('med_admin', { admin_on: '2026-10-14' }), '2026-10-14')
    assert.equal(C.changedRowDay('bath_records', { bath_on: '2026-10-14' }), '2026-10-14')
    assert.equal(C.changedRowDay('attendance', { day: '2026-10-14' }), '2026-10-14')
    assert.equal(C.changedRowDay('outings', { start_on: '2026-10-14' }), null)
    assert.equal(C.changedRowDay('note_reads', { note_id: 1 }), null)
    assert.equal(C.changedRowDay('vitals', null), null)
    assert.equal(C.changedRowDay('vitals', { measured_on: 'x' }), null)
  })
})

describe('★先読み 順番待ちと止める条件', { skip: C === null }, () => {
  it('同時に走らせるのは2本まで。終わったら次を始め、失敗しても黙って次へ進む', async () => {
    const q = C.createPrefetchQueue({ concurrency: 2, canRun: () => true })
    const ds = [deferred(), deferred(), deferred(), deferred()]
    const started = []
    q.push(ds.map((d, i) => ({ name: `t${i}`, run: () => (started.push(i), d.p) })))
    assert.deepEqual(started, [0, 1])
    ds[0].reject(new Error('先読みの失敗'))
    await tick()
    await tick()
    assert.deepEqual(started, [0, 1, 2])
    ds[1].resolve()
    ds[2].resolve()
    await tick()
    await tick()
    assert.deepEqual(started, [0, 1, 2, 3])
    ds[3].resolve()
    await tick()
    await tick()
    assert.deepEqual(q.stats(), { done: 3, failed: 1 })
  })

  it('止める条件の間は始めない。kick で見直して再開する。同じ名前の仕事は重ねて積まない', async () => {
    let ok = false
    const q = C.createPrefetchQueue({ concurrency: 2, canRun: () => ok })
    let n = 0
    q.push([{ name: 'a', run: async () => n++ }])
    q.push([{ name: 'a', run: async () => n++ }])
    assert.deepEqual(q.size(), { waiting: 1, running: 0 })
    assert.equal(n, 0)
    ok = true
    q.kick()
    await tick()
    assert.equal(n, 1)
  })

  it('先読みしてよい端末の状態（隠れている・オフライン・データ節約・送信待ちを送っている・ログインしていない間は止める）', () => {
    const base = { visible: true, online: true, saveData: false, sending: false, signedIn: true }
    assert.equal(C.prefetchAllowed(base), true)
    assert.equal(C.prefetchAllowed({ ...base, visible: false }), false)
    assert.equal(C.prefetchAllowed({ ...base, online: false }), false)
    assert.equal(C.prefetchAllowed({ ...base, saveData: true }), false)
    assert.equal(C.prefetchAllowed({ ...base, sending: true }), false)
    assert.equal(C.prefetchAllowed({ ...base, signedIn: false }), false)
    // 人が画面を触っている間も止める（2026-10-18 iPhone のカクつき対策）
    assert.equal(C.prefetchAllowed({ ...base, busy: true }), false)
    assert.equal(C.prefetchAllowed({ ...base, busy: false }), true)
  })

  it('中身の比べ方（sameValue）: たどって比べる。文字列で比べた時より緩くならない', () => {
    const S = C.sameValue
    assert.equal(S({ a: [1, { b: 'x' }], m: new Map([[1, new Set([2])]]) }, { a: [1, { b: 'x' }], m: new Map([[1, new Set([2])]]) }), true)
    assert.equal(S([1, 2], [1, 2, 3]), false)
    assert.equal(S({ a: 1 }, { a: '1' }), false)
    assert.equal(S({ a: null }, { a: undefined }), false)
    assert.equal(S({ a: 1, b: 2 }, { b: 2, a: 1 }), false) // 欄の並びが違えば違う（画面を描き直すだけ）
    assert.equal(S(new Map([[1, 'a'], [2, 'b']]), new Map([[2, 'b'], [1, 'a']])), false) // 入った順が違えば違う
    assert.equal(S(new Map([[1, 'a']]), { 1: 'a' }), false)
    assert.equal(S([1], { 0: 1 }), false)
    assert.equal(S(new Date(0), new Date(0)), true)
    assert.equal(S(new Date(0), new Date(1)), false)
    assert.equal(S(Number.NaN, Number.NaN), false)
    // 循環した値でも止まる（違うとみなす）
    const x = { n: null }
    x.n = x
    const y = { n: null }
    y.n = y
    assert.equal(S(x, y), false)
  })
})

describe('★人が画面を触っている間の先読みの停止（userActivity）', () => {
  it('最後に触ってから QUIET_MS の間は触っているとみなす', async () => {
    const U = await import('../src/lib/userActivity.ts')
    assert.equal(U.isBusyAt(10_000, null), false)
    assert.equal(U.isBusyAt(10_000, 10_000 - U.QUIET_MS + 1), true)
    assert.equal(U.isBusyAt(10_000, 10_000 - U.QUIET_MS), false)
    assert.equal(U.isUserBusy(), false) // 受け口を張っていない node では触っていない
    await U.waitUserQuiet() // 触っていなければすぐ返る
  })

  it('配線: 先読みの止める条件に触っているかを渡し、触るのをやめたら再開する。部品の先読みも触っている間は待つ', () => {
    const r = read('src/lib/cachedReads.ts')
    assert.match(r, /busy: isUserBusy\(\)/)
    assert.match(r, /onUserQuiet\(kick\)/)
    assert.match(r, /offQuiet\(\)/)
    const a = read('src/App.tsx')
    assert.match(a, /await waitUserQuiet\(\)\s*\n\s*await idleTurn\(\)/)
    const u = read('src/lib/userActivity.ts')
    assert.match(u, /passive: true/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. db につなぐ層（偽の Supabase・通信しない）
// ─────────────────────────────────────────────────────────────────────────────

const TODAY_ROWS = () => ({
  residents: [
    { id: 1, source_id: 's01', name: '利用者01', kana: null, room: '101', gender: null, care_level: null, active: true, needs_review: false, note_alias: null },
    { id: 2, source_id: 's02', name: '利用者02', kana: null, room: '102', gender: null, care_level: null, active: true, needs_review: false, note_alias: null },
  ],
  staff: [{ id: 1, name: '職員01', active: true }],
  vitals: [],
  meals: [],
})

/** 偽の Supabase（読むだけ・呼ばれた数を数える）。session=false はログインの控えが無い（anon で読んだ）状態 */
function fakeSb({ tables = TODAY_ROWS(), session = true, delay = 0 } = {}) {
  const calls = []
  const run = (q) => {
    calls.push(q)
    // 書込は通信断（status 0）を返す＝送信待ちへ退避させる
    if (q.write) return { data: null, error: { message: 'Failed to fetch' }, status: 0 }
    if (q.rpc) {
      if (q.rpc === 'timeline_chunk') return { data: { notes: [], vitals: [], meals: [], fluids: [], outings: [], import_days: [], pinned: [] }, error: null, status: 200 }
      return { data: [], error: null, status: 200 }
    }
    const rows = session ? (tables[q.table] ?? []) : []
    return { data: q.single ? (rows[0] ?? null) : rows.map((r) => ({ ...r })), error: null, status: 200 }
  }
  const builder = (q) => {
    const exec = () => new Promise((res) => setTimeout(() => res(run(q)), delay))
    const b = {
      insert: () => {
        q.write = true
        return b
      },
      select: () => b,
      eq: () => b,
      neq: () => b,
      is: () => b,
      in: () => b,
      gte: () => b,
      lte: () => b,
      gt: () => b,
      lt: () => b,
      or: () => b,
      not: () => b,
      order: () => b,
      limit: () => b,
      range: () => b,
      abortSignal: () => b,
      maybeSingle() {
        q.single = true
        return exec()
      },
      single() {
        q.single = true
        return exec()
      },
      then: (ok, ng) => exec().then(ok, ng),
    }
    return b
  }
  const sb = {
    from: (table) => builder({ table }),
    rpc: (fn, args) => builder({ rpc: fn, args }),
    auth: {
      getSession: async () => ({ data: { session: session ? { access_token: 'x', user: { id: 'u' } } : null }, error: null }),
    },
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: async () => 'ok',
  }
  return { sb, calls }
}

describe('★先読み db につなぐ層（cachedReads）', { skip: R === null }, () => {
  beforeEach(() => {
    R.resetDataCache()
  })
  afterEach(() => {
    R.resetDataCache()
    DB.__testHooks.setClient(null)
  })

  it('名簿の取得は控えに入り、同時の取得は1回にまとまる。取り直しは毎回する（同じ中身なら同じ参照）', async () => {
    const { sb, calls } = fakeSb({ delay: 5 })
    DB.__testHooks.setClient(sb)
    const [a, b] = await Promise.all([R.fetchResidents(), R.fetchResidents()])
    assert.equal(calls.filter((q) => q.table === 'residents').length, 1)
    assert.equal(a, b)
    assert.equal(R.peekResidents(), a)
    // 画面を開いた時は毎回取り直す。中身が同じなら同じ参照
    const again = await R.fetchResidents()
    assert.equal(calls.filter((q) => q.table === 'residents').length, 2)
    assert.equal(again, a)
  })

  it('ログインの控えが無い（anon で読んだ）0人は控えない（F58）', async () => {
    const { sb } = fakeSb({ session: false })
    DB.__testHooks.setClient(sb)
    await assert.rejects(R.fetchResidents())
    assert.equal(R.peekResidents(), undefined)
    // 個別の目標（F58 の確かめが無い取得）の空は控えない
    await R.fetchResidentTargets().catch(() => undefined)
    assert.equal(R.peekResidentTargets(), undefined)
  })

  it('変更通知: 表示範囲に当たる体温の変更でバイタル一覧の控えが古くなる（範囲外は当たらない）。取り直しの合図は全部', async () => {
    const { sb } = fakeSb()
    DB.__testHooks.setClient(sb)
    await R.fetchVitalsSheet('2026-10-13', '2026-10-16')
    await R.fetchResidents()
    assert.notEqual(R.peekVitalsSheet('2026-10-13', '2026-10-16'), undefined)
    R.applyChange('vitals', { event: 'INSERT', row: { measured_on: '2026-10-01', kind: 'routine' } })
    assert.notEqual(R.peekVitalsSheet('2026-10-13', '2026-10-16'), undefined)
    R.applyChange('vitals', { event: 'UPDATE', row: { measured_on: '2026-10-15', kind: 'routine' } })
    assert.equal(R.peekVitalsSheet('2026-10-13', '2026-10-16'), undefined)
    assert.notEqual(R.peekResidents(), undefined) // 名簿は当たらない
    R.applyChange('vitals', { event: 'RESYNC', row: null })
    assert.equal(R.peekResidents(), undefined)
  })

  it('この端末の書込（送信待ちに積んだ・版が確定した）でも当たる控えが古くなる（startCacheSync の受け口）', async () => {
    const { sb } = fakeSb()
    DB.__testHooks.setClient(sb)
    const stop = R.startCacheSync()
    try {
      await R.fetchMealsSheet('2026-10-06', '2026-10-16')
      assert.notEqual(R.peekMealsSheet('2026-10-06', '2026-10-16'), undefined)
      // 範囲の外の日の水分（送信待ちへ退避）では古くならない
      await DB.insertFluid({ resident_id: 1, taken_on: '2026-09-01', taken_at: '10:00:00', amount_ml: 200, kind: null, recorded_by: 1 })
      assert.notEqual(R.peekMealsSheet('2026-10-06', '2026-10-16'), undefined)
      // 範囲の日の水分を記録した（通信できず送信待ちへ退避＝db.ts の enqueue が知らせる）
      const r = await DB.insertFluid({ resident_id: 1, taken_on: '2026-10-16', taken_at: '10:00:00', amount_ml: 200, kind: null, recorded_by: 1 })
      assert.equal(r, 'queued')
      assert.equal(R.peekMealsSheet('2026-10-06', '2026-10-16'), undefined)
    } finally {
      stop()
      DB.__testHooks.setClient(null)
      lsStore.clear()
      await DB.__testHooks.restartQueue()
    }
  })

  it('定時・再検のバイタルの変更では日報の控えを古くしない（日報は発熱者・他症状者だけ）。発熱者の変更では古くする', async () => {
    const t = TODAY_ROWS()
    t.notes = [{ id: 1, note_on: '2026-10-11', shift: 'day', body: '昼食は全量摂取。', rev: 1, created_at: '2026-10-11T00:00:00Z', importance: 'normal', role_tags: [], categories: [] }]
    DB.__testHooks.setClient(fakeSb({ tables: t }).sb)
    await R.fetchDailyReports(['2026-10-11'], 1)
    await R.fetchVitalsSheet('2026-10-08', '2026-10-11')
    R.applyChange('vitals', { event: 'UPDATE', row: { measured_on: '2026-10-11', kind: 'routine' } })
    assert.notEqual(R.peekDailyReport(1, '2026-10-11'), undefined)
    assert.equal(R.peekVitalsSheet('2026-10-08', '2026-10-11'), undefined)
    R.applyChange('vitals', { event: 'INSERT', row: { measured_on: '2026-10-11', kind: 'observation' } })
    assert.equal(R.peekDailyReport(1, '2026-10-11'), undefined)
  })

  it('古くなった控えの取り直しは、印から少し待ち、前の取り直しから間隔の下限（60秒）を空ける', () => {
    assert.equal(R.nextRefreshAt(1_000, null), 4_000)
    assert.equal(R.nextRefreshAt(10_000, 0), R.REFRESH_MIN_INTERVAL_MS)
    assert.equal(R.nextRefreshAt(100_000, 0), 103_000)
  })

  it('送信待ちが残っていても、送っていない間は先読みを止めない（isQueueFlushing は送っている間だけ真）', async () => {
    const { sb } = fakeSb()
    DB.__testHooks.setClient(sb)
    try {
      // 通信できず送信待ちへ退避（送信待ちは1件残る＝止まっている送信待ちと同じく、送っていない）
      await DB.insertFluid({ resident_id: 1, taken_on: '2026-10-16', taken_at: '10:00:00', amount_ml: 200, kind: null, recorded_by: 1 })
      // 保存の直後の送信が済むのを待つ
      for (let i = 0; i < 50 && DB.isQueueFlushing(); i++) await new Promise((r) => setTimeout(r, 10))
      assert.ok(DB.queuePending() >= 1)
      assert.equal(DB.isQueueFlushing(), false)
      // 送り始めると真（送り終えると偽）
      const p = DB.flushQueue(true)
      assert.equal(DB.isQueueFlushing(), true)
      await p
      assert.equal(DB.isQueueFlushing(), false)
    } finally {
      DB.__testHooks.setClient(null)
      lsStore.clear()
      await DB.__testHooks.restartQueue()
    }
  })

  it('外出・事故は日付を書き換えられるので、変更は控え全部を古いにする', async () => {
    const { sb } = fakeSb()
    DB.__testHooks.setClient(sb)
    await R.fetchTimelineChunk('2026-10-07', '2026-10-16', 1)
    R.applyChange('outings', { event: 'UPDATE', row: { id: 3, start_on: '2026-01-01', end_on: '2026-01-02' } })
    assert.equal(R.peekTimelineChunk('2026-10-07', '2026-10-16', 1), undefined)
  })

  it('日報: まとめ取りの各日を記録者ごとのキーで控え、画面が日を捨てる（markDailyStale）と控えも古くなる', async () => {
    const { sb } = fakeSb()
    DB.__testHooks.setClient(sb)
    const days = ['2026-10-11', '2026-10-12']
    // 0件の日報は F58 の確かめで例外になるので、申し送りを1件置く
    const t = TODAY_ROWS()
    t.notes = [{ id: 1, note_on: '2026-10-11', shift: 'day', body: '昼食は全量摂取。', rev: 1, created_at: '2026-10-11T00:00:00Z', importance: 'normal', role_tags: [], categories: [] }]
    DB.__testHooks.setClient(fakeSb({ tables: t }).sb)
    const got = await R.fetchDailyReports(days, 1)
    assert.equal(got.size, 2)
    assert.notEqual(R.peekDailyReport(1, '2026-10-11'), undefined)
    assert.equal(R.peekDailyReport(2, '2026-10-11'), undefined) // 別の記録者のキーは別
    R.markDailyStale('2026-10-11')
    assert.equal(R.peekDailyReport(1, '2026-10-11'), undefined)
    assert.notEqual(R.peekDailyReport(1, '2026-10-12'), undefined)
  })

  it('ログアウト（resetDataCache）で控えを全部捨てる', async () => {
    const { sb } = fakeSb()
    DB.__testHooks.setClient(sb)
    await R.fetchResidents()
    await R.fetchStaff()
    R.resetDataCache()
    assert.equal(R.peekResidents(), undefined)
    assert.equal(R.peekStaff(), undefined)
  })

  it('先読みの順番: 名簿 → 要注意の材料 → 日報 → 一覧 → タイムライン・与薬・入浴・事故 → 外部 GAS の順に並ぶ', () => {
    const names = R.prefetchPlan({ actorId: 1 }).map((t) => t.name)
    const at = (n) => {
      const i = names.indexOf(n)
      assert.ok(i >= 0, `${n} が無い`)
      return i
    }
    assert.ok(at('residents') < at('alertsChunk'))
    assert.ok(at('targets') < at('alertsChunk'))
    assert.ok(at('alertsChunk') < at('daily'))
    assert.ok(at('daily') < at('vitalsSheet'))
    assert.ok(at('mealsPrior') < at('timeline'))
    assert.ok(at('incidents') < at('excretion'))
    assert.equal(names[names.length - 1], 'weights')
    assert.equal(names[names.length - 2], 'excretion')
  })

  it('先読みを一通り流すと、各画面の既定の範囲の控えがそろう（2回目は通信しない）', async () => {
    const t = TODAY_ROWS()
    const { sb, calls } = fakeSb({ tables: { ...t, vitals: [{ id: 1, resident_id: 1, measured_on: '2026-10-16', kind: 'routine', rev: 1 }], notes: [{ id: 1, note_on: '2026-10-16', shift: 'day', body: '夜間良眠。', rev: 1, created_at: '2026-10-16T00:00:00Z', importance: 'normal', role_tags: [], categories: [] }] } })
    DB.__testHooks.setClient(sb)
    for (const task of R.prefetchPlan({ actorId: 1 })) await task.run().catch(() => undefined)
    const keys = R.cacheKeys
    assert.notEqual(R.peekResidents(), undefined)
    assert.notEqual(R.peekStaff(), undefined)
    const n1 = calls.length
    for (const task of R.prefetchPlan({ actorId: 1 })) await task.run().catch(() => undefined)
    // 2回目に取りに行くのは、控えに入らない（空・別の部品が控える）ものだけ
    const again = calls.slice(n1).map((q) => q.table ?? q.rpc)
    assert.equal(again.includes('residents'), false)
    assert.equal(again.includes('staff'), false)
    assert.equal(again.includes('timeline_chunk'), false)
    assert.ok(keys.residents === 'residents')
  })

  it('日報の10日区切り（1〜10 / 11〜20 / 21〜月末）', () => {
    assert.equal(R.dailyBlockDays('2026-10-05')[0], '2026-10-01')
    assert.equal(R.dailyBlockDays('2026-10-05').length, 10)
    assert.equal(R.dailyBlockDays('2026-10-17')[0], '2026-10-11')
    assert.equal(R.dailyBlockDays('2026-10-25').length, 11) // 10月は31日まで
    assert.equal(R.dailyBlockDays('2026-02-25').length, 8)
    assert.deepEqual(R.dailyBlockDays('x'), ['x'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 配線の静的な見張り
// ─────────────────────────────────────────────────────────────────────────────

describe('★先読み 配線（静的）', () => {
  const fromCached = (src, names) => {
    const m = src.match(/import \{([^}]*)\} from '\.\.\/lib\/cachedReads'/)
    assert.ok(m, 'cachedReads から import していない')
    const got = m[1].split(',').map((x) => x.trim()).filter(Boolean)
    for (const n of names) assert.ok(got.includes(n), `${n} を cachedReads から取っていない`)
  }
  const notFromDb = (src, names) => {
    for (const m of src.matchAll(/import \{([^}]*)\} from '\.\.\/lib\/db'/g)) {
      const got = m[1].split(',').map((x) => x.trim())
      for (const n of names) assert.ok(!got.includes(n), `${n} を db から直接取っている（控えを通らない）`)
    }
  }

  it('各画面は記録・名簿を控えを通して取り、控えがあれば先に描く（peek）', () => {
    const cases = [
      ['src/pages/AlertsPage.tsx', ['fetchResidents', 'fetchTimelineChunk', 'fetchMedDay', 'fetchMedSlots', 'fetchMedFirstDay', 'fetchResidentTargets', 'peekTimelineChunk']],
      ['src/pages/VitalsSheetPage.tsx', ['fetchResidents', 'fetchVitalsSheet', 'fetchResidentTargets', 'peekVitalsSheet']],
      ['src/pages/MealsSheetPage.tsx', ['fetchResidents', 'fetchMealsSheet', 'fetchResidentTargets', 'peekMealsSheet']],
      ['src/pages/KartePage.tsx', ['fetchKarte', 'fetchResidents', 'peekKarte', 'prefetchKarte']],
      ['src/pages/IncidentListPage.tsx', ['fetchIncidents', 'fetchAllResidents', 'peekIncidents']],
      ['src/pages/MedRecordPage.tsx', ['fetchMedDay', 'fetchMedSlots', 'fetchMedFirstDay', 'fetchAllResidents', 'peekMedDay']],
      ['src/pages/BathRecordPage.tsx', ['fetchBathDay', 'fetchBathPlan', 'fetchAllResidents', 'peekBathDay']],
      ['src/pages/DailySheetPage.tsx', ['fetchDailyReports', 'peekDailyReport', 'markDailyStale']],
      ['src/pages/TimelinePage.tsx', ['fetchResidents', 'fetchAllResidents', 'fetchAllStaff']],
    ]
    for (const [file, names] of cases) {
      const src = read(file)
      fromCached(src, names)
      notFromDb(src, names.filter((n) => n.startsWith('fetch')))
    }
    const tl = read('src/hooks/useTimeline.ts')
    assert.match(tl, /import \{ fetchTimelineChunk, peekTimelineChunk \} from '\.\.\/lib\/cachedReads'/)
    assert.match(code('src/hooks/useTimeline.ts'), /const cached = peekTimelineChunk\(from, to, staffId\)/)
  })

  it('日報: 控えで先に出した区切りは裏で取り直し、違えば既存の帯（他の端末で記録が更新されました）で知らせる（表は差し替えない）', () => {
    const src = code('src/pages/DailySheetPage.tsx')
    const lb = src.slice(src.indexOf('const loadBlock = useCallback('), src.indexOf('const loadDay = useCallback('))
    assert.match(lb, /peekDailyReport\(actorId, d\)/)
    assert.match(lb, /hits\.size === missing\.length/)
    assert.match(lb, /if \(cacheGen\(d\) !== gens\.get\(d\)\) continue/)
    assert.match(lb, /!sameValue\(f, shown\)[\s\S]{0,40}setStale\(true\)/)
    // 取り置きを捨てる時は控えにも古いの印
    assert.match(src, /markDailyStale\(d\)/)
    assert.match(src, /markDailyStale\(null\)/)
  })

  it('カルテの一覧: 押し始め・フォーカスで先読みし、マウスは乗り続けた時だけ（通り過ぎただけでは取りに行かない）', () => {
    const src = code('src/pages/KartePage.tsx')
    assert.match(src, /onPointerDown=\{\(\) => warmKarte\(r\.id\)\}/)
    assert.match(src, /onFocus=\{\(\) => warmKarte\(r\.id\)\}/)
    assert.match(src, /onMouseEnter=\{\(\) => hoverStart\(r\.id\)\}/)
    assert.match(src, /onMouseLeave=\{hoverCancel\}/)
    assert.match(src, /const KARTE_HOVER_WARM_MS = 200/)
  })

  it('入力解禁の旗・役割・版の確かめは控えない（cachedReads は包まない・画面は db から毎回取る）', () => {
    const src = code('src/lib/cachedReads.ts')
    for (const n of ['getNativeInputGate', 'getNativeInputEnabled', 'getKindInputGate', 'fetchMyRole', 'checkClientBuild', 'getAppSetting']) {
      assert.doesNotMatch(src, new RegExp(`\\b${n}\\b`), `${n} を控えの層が扱っている`)
    }
    // 画面は旗を db から取り直す
    assert.match(code('src/pages/VitalsSheetPage.tsx'), /getNativeInputGate\(\)/)
    assert.match(code('src/pages/AlertsPage.tsx'), /getKindInputGate\('med'\)/)
    assert.match(code('src/pages/MedRecordPage.tsx'), /getKindInputGate\('med'\)/)
  })

  it('控えはメモリだけ（localStorage・sessionStorage・IndexedDB に書かない）。console に出さない', () => {
    for (const f of ['src/lib/dataCache.ts', 'src/lib/cachedReads.ts']) {
      const src = code(f)
      assert.doesNotMatch(src, /localStorage\.setItem|sessionStorage|indexedDB|console\./)
    }
  })

  it('App: 画面の部品は React.lazy と同じ import 関数で先読みし、版が違う・帯が出ている間は読まない。データの先読みは名簿を読めた後', () => {
    const app = code('src/App.tsx')
    assert.match(app, /const loadVitalsSheetPage = \(\) => import\('\.\/pages\/VitalsSheetPage'\)/)
    assert.match(app, /const VitalsSheetPage = lazy\(\(\) => loadVitalsSheetPage\(\)\.then/)
    const list = app.slice(app.indexOf('const PAGE_PRELOADS'), app.indexOf('const PREFETCH_START_MS'))
    for (const n of ['loadVitalsSheetPage', 'loadMealsSheetPage', 'loadKartePage', 'loadAlertsPage', 'loadTimelinePage']) {
      assert.match(list, new RegExp(`\\b${n}\\b`))
    }
    assert.match(app, /isOtherBuildPublished\(CLIENT_BUILD, remote\)\) return/)
    assert.match(app, /buildBlockedRef\.current = newBuild \|\| outdated/)
    assert.match(app, /import\('\.\/lib\/cachedReads'\)/)
    assert.match(app, /offSync = m\.startCacheSync\(\)/)
    // 部品の先読みの失敗は黙って次へ
    assert.match(app, /await load\(\)\s*\} catch \{\s*continue/)
    assert.match(app, /m\.startPrefetch\(\{ actorId \}\)/)
    // ログアウト（部品が外れる）・記録者の変更で全部捨てる
    assert.match(app, /cacheModRef\.current\?\.resetDataCache\(\)/)
    // 先読みの部品の失敗は画面の失敗の見分けに数えない（notePreloadError の受け口より先に止める）
    assert.ok(app.indexOf('e.stopImmediatePropagation()') < app.indexOf("window.addEventListener('vite:preloadError', () => notePreloadError())"))
  })

  it('db: この端末の書込を知らせる口（送信待ちに積んだ・版が確定した・個別の目標の保存）', () => {
    const db = code('src/lib/db.ts')
    assert.match(db, /export function subscribeLocalWrites\(/)
    assert.match(db, /export function isQueueFlushing\(\): boolean/)
    assert.match(db, /async function enqueue\(op: PendingOp\): Promise<Queued> \{\s*notifyLocalWrite\(op\.table, op\.payload\)/)
    assert.match(db, /function markSelfRow\([^)]*\): void \{\s*const rec = asRecord\(row\)\s*if \(rec === null\) return\s*notifyLocalWrite\(table, rec\)/)
    assert.equal((db.match(/notifyLocalWrite\('resident_targets', row\)/g) ?? []).length, 2)
  })
})

describe('★先読みの取り直しの間隔（RESYNC）', { skip: R === null }, () => {
  it('画面復帰・再接続で全部が古くなった時の取り直しは10分に1回まで（変更の通知は60秒）', () => {
    assert.equal(R.FULL_REFRESH_MIN_INTERVAL_MS, 600_000)
    const now = 1_000_000
    assert.equal(R.nextRefreshAt(now, now - 1_000, true), now - 1_000 + 600_000)
    assert.equal(R.nextRefreshAt(now, now - 1_000, false), now - 1_000 + 60_000)
    assert.equal(R.nextRefreshAt(now, null, true), now + 3_000)
  })
})
