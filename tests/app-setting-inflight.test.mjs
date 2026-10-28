// 入力解禁フラグ（app_settings の native_input_enabled）の起動時の重なりを1本にする回帰テスト（2026-10-28 ケアログの読み込みの重なり W2・2秒の窓は仮置き）。
// 直す前はホームを開くと App の起動と画面が数十ms ずらして順に入力解禁を取りに行き、同じ値を2回引いていた。
// 直した後: getAppSetting は同じキーの同時要求を1本にまとめ、入力解禁はサーバーから観測した直後の短い窓の内だけその値を使う。
// 失敗・窓の外・別のキーは今までどおり改めて問い合わせる。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
// 個人情報は置かない（設定のキーと値だけ）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerLoadFailure } from './ts-load.mjs'

const UNSUPPORTED = 'この Node では TypeScript・解決フックを使えないため、入力解禁の重なりの検証をスキップしました（Node 22.18 以降で実行してください）。'

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
} catch (e) {
  loadError = e
  DB = null
}
if (DB === null) registerLoadFailure('入力解禁の重なり（getAppSetting）', loadError, UNSUPPORTED, { hooks: true })

/** 偽の Supabase（app_settings を読むだけ・問い合わせたキーを数える）。fail に入れたキーは1回だけ通信エラーにする */
function fakeSb({ settings = { native_input_enabled: 'true', other_key: 'x' }, delay = 5 } = {}) {
  const calls = []
  const fail = new Set()
  const run = (q) => {
    calls.push(q)
    if (q.rpc) return { data: [], error: null, status: 200 }
    if (q.table !== 'app_settings') return { data: q.single ? null : [], error: null, status: 200 }
    const key = (q.eq ?? []).find(([c]) => c === 'key')?.[1]
    if (fail.has(key)) {
      fail.delete(key)
      return { data: null, error: { code: '', message: 'network' }, status: 0 }
    }
    return { data: key in settings ? { value: settings[key] } : null, error: null, status: 200 }
  }
  const builder = (q) => {
    const exec = () => new Promise((res) => setTimeout(() => res(run(q)), delay))
    const b = {
      select: () => b,
      eq: (c, v) => {
        q.eq = [...(q.eq ?? []), [c, v]]
        return b
      },
      limit: () => b,
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
  const asked = (key) => calls.filter((q) => q.table === 'app_settings' && (q.eq ?? []).some(([c, v]) => c === 'key' && v === key)).length
  return { sb, calls, fail, settings, asked }
}

describe('getAppSetting: 同じキーの同時要求は1本にまとめる', { skip: DB === null }, () => {
  afterEach(() => {
    DB.__testHooks.setClient(null)
  })

  it('★同じキーを同時に2回呼ぶと問い合わせは1回・両方に同じ値が届く', async () => {
    const f = fakeSb()
    DB.__testHooks.setClient(f.sb)
    const [a, b] = await Promise.all([DB.getAppSetting('native_input_enabled'), DB.getAppSetting('native_input_enabled')])
    assert.equal(a, 'true')
    assert.equal(b, 'true')
    assert.equal(f.asked('native_input_enabled'), 1)
  })

  it('別のキーは相乗りしない', async () => {
    const f = fakeSb()
    DB.__testHooks.setClient(f.sb)
    const [a, b] = await Promise.all([DB.getAppSetting('native_input_enabled'), DB.getAppSetting('other_key')])
    assert.equal(a, 'true')
    assert.equal(b, 'x')
    assert.equal(f.asked('native_input_enabled'), 1)
    assert.equal(f.asked('other_key'), 1)
  })

  it('1回目が終わった後の呼び出しは改めて問い合わせる（時間の控えは持たない）', async () => {
    const f = fakeSb()
    DB.__testHooks.setClient(f.sb)
    assert.equal(await DB.getAppSetting('other_key'), 'x')
    f.settings.other_key = 'y'
    assert.equal(await DB.getAppSetting('other_key'), 'y')
    assert.equal(f.asked('other_key'), 2)
  })

  it('失敗した要求を共有したままにしない（次は改めて問い合わせる）', async () => {
    const f = fakeSb()
    DB.__testHooks.setClient(f.sb)
    f.fail.add('other_key')
    const both = await Promise.allSettled([DB.getAppSetting('other_key'), DB.getAppSetting('other_key')])
    assert.deepEqual(both.map((r) => r.status), ['rejected', 'rejected'])
    assert.equal(f.asked('other_key'), 1)
    assert.equal(await DB.getAppSetting('other_key'), 'x')
    assert.equal(f.asked('other_key'), 2)
  })
})

describe('入力解禁: 起動時に順に2回確かめても問い合わせは1回', { skip: DB === null }, () => {
  afterEach(() => {
    DB.__testHooks.setClient(null)
  })

  it('★1回目の確認が終わった直後に画面がもう一度確かめても、native_input_enabled の問い合わせは1回・両方観測済み', async () => {
    const f = fakeSb()
    DB.__testHooks.setClient(f.sb, { native: null }) // 起動直後＝未観測
    const first = await DB.getNativeInputGate() // App の起動
    const second = await DB.getNativeInputEnabled() // 数十ms 後の画面
    assert.equal(first.observed, true)
    assert.equal(first.value, true)
    assert.equal(second, true)
    assert.equal(f.asked('native_input_enabled'), 1)
  })

  it('封鎖（false）を観測した直後も同じ値を返す（観測できた／できなかったの区別は変えない）', async () => {
    const f = fakeSb({ settings: { native_input_enabled: 'false' } })
    DB.__testHooks.setClient(f.sb, { native: null })
    const a = await DB.getNativeInputGate()
    const b = await DB.getNativeInputGate()
    assert.deepEqual([a.value, a.observed, b.value, b.observed], [false, true, false, true])
    assert.equal(f.asked('native_input_enabled'), 1)
  })

  it('取得に失敗した時は窓に入れない（次は改めて問い合わせ、観測できれば observed:true）', async () => {
    const f = fakeSb()
    DB.__testHooks.setClient(f.sb, { native: null })
    f.fail.add('native_input_enabled')
    const a = await DB.getNativeInputGate()
    assert.equal(a.observed, false)
    const b = await DB.getNativeInputGate()
    assert.equal(b.observed, true)
    assert.equal(b.value, true)
    assert.equal(f.asked('native_input_enabled'), 2)
  })

  it('窓（2秒）を過ぎた後は取り直す', async (t) => {
    const f = fakeSb()
    DB.__testHooks.setClient(f.sb, { native: null })
    const realNow = Date.now
    let shift = 0
    t.after(() => {
      Date.now = realNow
    })
    Date.now = () => realNow() + shift
    assert.equal((await DB.getNativeInputGate()).value, true)
    f.settings.native_input_enabled = 'false'
    shift = 2_100
    const b = await DB.getNativeInputGate()
    assert.equal(b.value, false)
    assert.equal(f.asked('native_input_enabled'), 2)
  })

  it('試験の差し替え（setClient）の観測済みは窓に数えない（差し替え直後は今までどおり問い合わせる）', async () => {
    const f = fakeSb({ settings: { native_input_enabled: 'false' } })
    DB.__testHooks.setClient(f.sb) // native=true を観測済み扱い
    const g = await DB.getNativeInputGate()
    assert.equal(g.value, false)
    assert.equal(f.asked('native_input_enabled'), 1)
  })
})
