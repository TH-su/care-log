// デイの「今日」を開いた時の要求の数と順番待ちを減らす直しの回帰テスト（2026-10-29 本人指示）。
// 直す前: 写し（daycare_days）→ 出欠・入浴・バイタル（2本）・食事と水分 → 活動 の3段の順番待ちで、バイタルはこの画面で使わない
// 「その日のキーの全部」も読んでいた。入力解禁の旗の行が見えない時の「許可リスト外か」の確かめ（staff を1行）は、同時に旗を取った
// 画面と App の数だけ重ねて出ていた。
// 直した後:
//   - 写しと、写しを待たなくてよい5つ（出欠・入浴・バイタル・食事と水分・活動）を同時に出し、予定（daycare_plan）だけ写しの後に出す
//   - 結果の扱い（写しが設定待ちなら出欠を使わない・予定と出欠の失敗は投げる・ほかの失敗は空/null）は前と同じ
//   - 今日の画面のバイタルは生きている行だけを読む（fetchDaycareVitalsLive・問い合わせは fetchDaycareVitals の live と同じ形）
//   - 「許可リスト外か」の確かめは同じ瞬間の分を1本にまとめる（終わったら外す）
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
// 個人情報は置かない（架空の日付・番号だけ）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const UNSUPPORTED = 'この Node では TypeScript・解決フックを使えないため、デイの今日の読み込みの検証をスキップしました（Node 22.18 以降で実行してください）。'

let L = null
let DB = null
let loadError = null
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
  L = await import('../src/lib/daycareDayLoad.ts')
  DB = await import('../src/lib/db.ts?daycare-day-load')
} catch (e) {
  loadError = e
  L = null
  DB = null
}
if (L === null || DB === null) registerLoadFailure('デイの今日の読み込み（daycareDayLoad）', loadError, UNSUPPORTED, { hooks: true })

const T = '2026-01-15'

/** 外から解ける約束 */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, ng) => {
    resolve = ok
    reject = ng
  })
  return { promise, resolve, reject }
}

/**
 * 偽の読み取り。呼ばれた順を calls に積む。day は外から解く（写しを読んでいる間に何が出ているかを見る）。
 * over で個別に差し替える
 */
function readers(over = {}) {
  const calls = []
  const dayGate = deferred()
  const rec = (name, fn) => (d) => {
    calls.push(name)
    assert.equal(d, T)
    return fn()
  }
  const r = {
    day: rec('day', () => dayGate.promise),
    plan: rec('plan', async () => ({ source: 'kv', rows: [{ sched_id: 's1' }], rev: 1, updatedAt: null, missing: false })),
    attendance: rec('attendance', async () => [{ id: 1 }]),
    baths: rec('baths', async () => [{ id: 2 }]),
    vitals: rec('vitals', async () => [{ id: 3 }]),
    intake: rec('intake', async () => ({ meals: [], fluids: [{ id: 4 }] })),
    activities: rec('activities', async () => [{ id: 5 }]),
    isServerMissing: (e) => e instanceof Error && e.message === 'server-missing',
  }
  for (const [k, fn] of Object.entries(over)) r[k] = k === 'isServerMissing' ? fn : rec(k, fn)
  return { r, calls, dayGate }
}

/** 受け手の無い失敗（unhandledRejection）を数える */
function watchUnhandled() {
  const seen = []
  const on = (e) => seen.push(e)
  process.on('unhandledRejection', on)
  return {
    seen,
    async stop() {
      await new Promise((res) => setTimeout(res, 20))
      process.off('unhandledRejection', on)
    },
  }
}

describe('デイの今日の1日の読み込み（loadDaycareDayParts）', { skip: L === null }, () => {
  it('★写しを読んでいる間に、写しを待たなくてよい5つを全部出している（予定はまだ出さない）', async () => {
    const { r, calls, dayGate } = readers()
    const p = L.loadDaycareDayParts(T, r)
    await Promise.resolve()
    assert.deepEqual([...calls].sort(), ['activities', 'attendance', 'baths', 'day', 'intake', 'vitals'])
    assert.equal(calls.includes('plan'), false)
    dayGate.resolve(null)
    const got = await p
    // 写しが無い日は、写しの後に予定を読む（2段目）
    assert.equal(calls.at(-1), 'plan')
    assert.equal(got.plan.source, 'kv')
    assert.deepEqual(got.attendance, [{ id: 1 }])
    assert.deepEqual(got.baths, [{ id: 2 }])
    assert.deepEqual(got.vitals, [{ id: 3 }])
    assert.deepEqual(got.intake, { meals: [], fluids: [{ id: 4 }] })
    assert.deepEqual(got.activities, [{ id: 5 }])
    assert.equal(got.missing, false)
    assert.equal(got.snapshot, null)
  })

  it('写しが使える日は予定を読まない（1段で終わる）', async () => {
    const { r, calls, dayGate } = readers()
    dayGate.resolve({ day: T, plan_source: 'kv', plan_rows: [] })
    const got = await L.loadDaycareDayParts(T, r)
    assert.equal(calls.includes('plan'), false)
    assert.equal(got.plan, null)
    assert.equal(got.snapshot.plan_source, 'kv')
  })

  it('写しが「読めなかった」（unknown）日は、いまの週間計画も読む（前と同じ）', async () => {
    const { r, calls, dayGate } = readers()
    dayGate.resolve({ day: T, plan_source: 'unknown', plan_rows: [] })
    const got = await L.loadDaycareDayParts(T, r)
    assert.equal(calls.filter((c) => c === 'plan').length, 1)
    assert.equal(got.plan.source, 'kv')
  })

  it('★写しが設定待ち（0041 未適用）なら missing・出欠は使わない。出欠の失敗を受け手の無い失敗にしない', async () => {
    const w = watchUnhandled()
    const { r, dayGate } = readers({ attendance: async () => Promise.reject(new Error('server-missing')) })
    dayGate.reject(new Error('server-missing'))
    const got = await L.loadDaycareDayParts(T, r)
    await w.stop()
    assert.equal(got.missing, true)
    assert.deepEqual(got.attendance, [])
    assert.equal(w.seen.length, 0)
  })

  it('★写しの読み取りの通信の失敗はそのまま投げる（画面の控え・エラーの扱いへ）。ほかの読み取りの失敗を受け手の無い失敗にしない', async () => {
    const w = watchUnhandled()
    const { r, dayGate } = readers({ attendance: async () => Promise.reject(new Error('net')) })
    dayGate.reject(new Error('net-day'))
    await assert.rejects(L.loadDaycareDayParts(T, r), /net-day/)
    await w.stop()
    assert.equal(w.seen.length, 0)
  })

  it('出欠・予定の失敗は前と同じく投げる', async () => {
    const a = readers({ attendance: async () => Promise.reject(new Error('att')) })
    a.dayGate.resolve({ day: T, plan_source: 'kv', plan_rows: [] })
    await assert.rejects(L.loadDaycareDayParts(T, a.r), /att/)
    const p = readers({ plan: async () => Promise.reject(new Error('plan')) })
    p.dayGate.resolve(null)
    await assert.rejects(L.loadDaycareDayParts(T, p.r), /plan/)
  })

  it('入浴・バイタル・食事と水分・活動の失敗は止めない（空・null＝前と同じ）', async () => {
    const boom = async () => Promise.reject(new Error('x'))
    const { r, dayGate } = readers({ baths: boom, vitals: boom, intake: boom, activities: boom })
    dayGate.resolve({ day: T, plan_source: 'kv', plan_rows: [] })
    const got = await L.loadDaycareDayParts(T, r)
    assert.deepEqual(got.baths, [])
    assert.deepEqual(got.vitals, [])
    assert.equal(got.intake, null)
    assert.equal(got.activities, null)
    assert.deepEqual(got.attendance, [{ id: 1 }])
  })
})

/** 問い合わせの形を全部書き留める偽の Supabase（vitals・app_settings・staff を読むだけ） */
function recordingSb({ settings = {}, staffRows = [{ id: 1 }] } = {}) {
  const queries = []
  const run = (q) => {
    if (q.table === 'app_settings') {
      const key = q.ops.find(([op, c]) => op === 'eq' && c === 'key')?.[2]
      return { data: key in settings ? { value: settings[key] } : null, error: null, status: 200 }
    }
    if (q.table === 'staff') return { data: staffRows, error: null, status: 200 }
    return { data: [], error: null, status: 200 }
  }
  const builder = (q) => {
    const exec = () => new Promise((res) => setTimeout(() => res(run(q)), 5))
    const op = (name) => (...args) => {
      q.ops.push([name, ...args])
      return b
    }
    const b = {
      select: op('select'),
      eq: op('eq'),
      like: op('like'),
      is: op('is'),
      in: op('in'),
      order: op('order'),
      limit: op('limit'),
      abortSignal: () => b,
      maybeSingle() {
        q.ops.push(['maybeSingle'])
        return exec()
      },
      then: (ok, ng) => exec().then(ok, ng),
    }
    return b
  }
  const sb = {
    from: (table) => {
      const q = { table, ops: [] }
      queries.push(q)
      return builder(q)
    },
    rpc: (fn) => {
      const q = { table: `rpc:${fn}`, ops: [] }
      queries.push(q)
      return builder(q)
    },
    auth: { getSession: async () => ({ data: { session: { access_token: 'x', user: { id: 'u' } } }, error: null }) },
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: async () => 'ok',
  }
  return { sb, queries }
}

describe('今日の画面のバイタルは生きている行だけを読む（fetchDaycareVitalsLive）', { skip: DB === null }, () => {
  afterEach(() => DB.__testHooks.setClient(null))

  it('★問い合わせは1本で、fetchDaycareVitals の live と同じ形（キーの全部は読まない）', async () => {
    const a = recordingSb()
    DB.__testHooks.setClient(a.sb)
    await DB.fetchDaycareVitalsLive(T)
    assert.equal(a.queries.length, 1)
    const b = recordingSb()
    DB.__testHooks.setClient(b.sb)
    await DB.fetchDaycareVitals(T)
    assert.equal(b.queries.length, 2)
    const live = b.queries.find((q) => q.ops.some(([op]) => op === 'is'))
    assert.deepEqual(a.queries[0], live)
  })
})

describe('「許可リスト外か」の確かめは同じ瞬間の分を1本にまとめる', { skip: DB === null }, () => {
  afterEach(() => DB.__testHooks.setClient(null))

  it('★旗の行が見えない時に2種類の旗を同時に取っても、staff を読むのは1回・終わった後は改めて読む', async () => {
    const f = recordingSb({ settings: { min_client_build: '' } })
    DB.__testHooks.setClient(f.sb)
    const staffReads = () => f.queries.filter((q) => q.table === 'staff').length
    const [a, b] = await Promise.all([DB.getKindInputGate('daycare'), DB.getKindInputGate('bath')])
    // 名簿が見える＝許可リスト外ではない（未登録＝封鎖を観測・前と同じ）
    assert.deepEqual(a, { value: false, observed: true })
    assert.deepEqual(b, { value: false, observed: true })
    assert.equal(staffReads(), 1)
    await DB.getKindInputGate('daycare')
    assert.equal(staffReads(), 2)
  })

  it('名簿が見えない時は両方とも「許可リスト外」になる（相乗りしても同じ答え）', async () => {
    const f = recordingSb({ staffRows: [] })
    DB.__testHooks.setClient(f.sb)
    const [a, b] = await Promise.all([DB.getKindInputGate('daycare'), DB.getKindInputGate('bath')])
    assert.equal(a.forbidden, true)
    assert.equal(b.forbidden, true)
    assert.equal(f.queries.filter((q) => q.table === 'staff').length, 1)
  })

  it('★ログインし直した・抜けた時は走っている確かめを外す（前のアカウントの答えに相乗りしない）・新しい確かめを古い方の終わりで外さない', () => {
    const src = read('../src/lib/db.ts')
    assert.match(src, /forgetMyRole\(\)\n[^\n]*\n    deniedProbeInFlight = null\n  \}/)
    assert.match(src, /if \(deniedProbeInFlight === run\) deniedProbeInFlight = null/)
  })
})

describe('今日の画面の読み込みの配線', () => {
  const t = read('../src/pages/DaycarePage.tsx')
  it('1日の読み込みは loadDaycareDayParts を通し、バイタルは生きている行だけを読む', () => {
    assert.match(t, /await loadDaycareDayParts\(target, DAY_READERS\)/)
    assert.match(t, /vitals: fetchDaycareVitalsLive,/)
    assert.doesNotMatch(t, /fetchDaycareVitals\(/)
    // 活動を出欠などの後に別に待たない
    assert.doesNotMatch(t, /await fetchDaycareActivities\(/)
  })
  it('世代と日付の確かめは画面に残す', () => {
    assert.match(t, /if \(gen !== genRef\.current \|\| target !== dayRef\.current\) return/)
  })
})
