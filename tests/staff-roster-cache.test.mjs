// 起動時の職員名簿（staff）を控え（src/lib/cachedReads.ts）を通して読む回帰テスト（2026-10-28 ケアログの読み込みの重なり W1）。
// 直す前は App の起動と同じ画面の在席表示（useCellPresence）が db から名簿を直接読み、先読み（startPrefetch の staff）が
// 同じ名簿をもう一度読んでいた。直した後は App・在席表示・先読みが同じ控えを使い、起動経路の staff の通信は1回。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
// 個人情報は置かない（職員は合成の「職員01」と数値IDだけ）。

import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const UNSUPPORTED = 'この Node では TypeScript・解決フックを使えないため、名簿の控えの検証をスキップしました（Node 22.18 以降で実行してください）。'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
// コメント（行末の // と、ブロックのコメント）を外した本文
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

let R = null // cachedReads.ts
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
  DB = await import('../src/lib/db.ts')
  R = await import('../src/lib/cachedReads.ts')
} catch (e) {
  loadError = e
  R = null
}
if (R === null) registerLoadFailure('名簿の控え（cachedReads）', loadError, UNSUPPORTED, { hooks: true })

/** 偽の Supabase（読むだけ・呼ばれた表を数える）。tests/prefetch.test.mjs の fakeSb と同じ形の最小版 */
function fakeSb({ delay = 0 } = {}) {
  const calls = []
  const tables = { staff: [{ id: 1, name: '職員01', active: true }] }
  const run = (q) => {
    calls.push(q)
    if (q.rpc) return { data: [], error: null, status: 200 }
    const rows = tables[q.table] ?? []
    return { data: q.single ? (rows[0] ?? null) : rows.map((r) => ({ ...r })), error: null, status: 200 }
  }
  const builder = (q) => {
    const exec = () => new Promise((res) => setTimeout(() => res(run(q)), delay))
    const b = {
      select: () => b,
      eq: () => b,
      neq: () => b,
      is: () => b,
      in: () => b,
      gte: () => b,
      lte: () => b,
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
      getSession: async () => ({ data: { session: { access_token: 'x', user: { id: 'u' } } }, error: null }),
    },
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: async () => 'ok',
  }
  return { sb, calls }
}

describe('★起動時の職員名簿は控えを通して読む（配線の見張り）', () => {
  it('App の起動の名簿は cachedReads の fetchStaff を通す（db を直接読むのは部品を読めない時だけ）', () => {
    const a = code('src/App.tsx')
    assert.doesNotMatch(a, /const list = await db\.fetchStaff\(\)/, 'App が起動時に db から名簿を直接読んでいる')
    assert.match(
      a,
      /const list = await import\('\.\/lib\/cachedReads'\)\.then\(\s*\(m\) => m\.fetchStaff\(\),\s*\(\) => db\.fetchStaff\(\),?\s*\)/,
    )
    // 静的 import にしない（最初に読む部品に db・控えを抱き込まない）
    assert.doesNotMatch(a, /^import [^\n]*from '\.\/lib\/cachedReads'/m)
  })

  it('在席表示（useCellPresence）の名前の引き当ては cachedReads の fetchStaff を使う（db から直接読まない）', () => {
    const s = code('src/hooks/useCellPresence.ts')
    assert.doesNotMatch(s, /import \{[^}]*\bfetchStaff\b[^}]*\} from '\.\.\/lib\/db'/, '在席表示が db から名簿を直接読んでいる')
    assert.match(s, /import \{ fetchStaff \} from '\.\.\/lib\/cachedReads'/)
    assert.match(s, /import \{ joinPresence \} from '\.\.\/lib\/db'/)
  })
})

describe('★起動経路の staff の通信は1回（偽の Supabase で数える）', { skip: R === null }, () => {
  beforeEach(() => {
    R.resetDataCache()
  })
  afterEach(() => {
    R.resetDataCache()
    DB.__testHooks.setClient(null)
  })

  const staffCalls = (calls) => calls.filter((q) => q.table === 'staff').length
  const runStaffPrefetch = async () => {
    const task = R.prefetchPlan({ actorId: 1 }).find((t) => t.name === 'staff')
    assert.ok(task, '先読みの順番に staff がある')
    return task.run()
  }

  it('App の起動（控えを通した名簿）→ 先読みの staff は通信しない＝起動経路で1回', async () => {
    const { sb, calls } = fakeSb()
    DB.__testHooks.setClient(sb)
    const list = await R.fetchStaff()
    assert.deepEqual(
      list.map((s) => s.id),
      [1],
    )
    assert.equal(await runStaffPrefetch(), false) // 控えがあるので取りに行かない
    assert.equal(staffCalls(calls), 1)
    assert.equal(R.peekStaff(), list)
  })

  it('App の起動と在席表示の名簿が重なっても1本にまとまり、先読みも足さない', async () => {
    const { sb, calls } = fakeSb({ delay: 5 })
    DB.__testHooks.setClient(sb)
    const [a, b] = await Promise.all([R.fetchStaff(), R.fetchStaff()])
    assert.equal(a, b)
    await runStaffPrefetch()
    assert.equal(staffCalls(calls), 1)
  })

  it('（比べ）db から直接読むと控えに入らず、先読みがもう一度読む＝2回（直す前の起動経路）', async () => {
    const { sb, calls } = fakeSb()
    DB.__testHooks.setClient(sb)
    await DB.fetchStaff()
    assert.equal(await runStaffPrefetch(), true)
    assert.equal(staffCalls(calls), 2)
  })
})
