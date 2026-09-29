// 表示倍率（ピンチで変えられる 75〜200%・5% 刻み・既定値への吸着・読み出しの照合）の回帰テスト。
// 実行: node --experimental-strip-types --test tests/zoom.test.mjs
// 修正前の版で流す時は CL_ZOOM_SRC に修正前の src の場所を渡す（既定はこのリポジトリの src）。
// 個人情報は置かない。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SRC = process.env.CL_ZOOM_SRC
  ? pathToFileURL(`${process.env.CL_ZOOM_SRC.replace(/\/$/, '')}/`).href
  : new URL('../src/', import.meta.url).href

const store = new Map()
let Z = null
let loadError = null
try {
  const { registerHooks } = await import('node:module')
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
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  globalThis.window = globalThis
  globalThis.document = { documentElement: { style: { setProperty: (k, v) => store.set(`css:${k}`, v) } } }
  Z = await import(new URL('lib/zoom.ts', SRC).href)
} catch (e) {
  loadError = e
}
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')

describe('表示倍率（ピンチ）', () => {
  afterEach(() => store.clear())

  it('倍率の部品（lib/zoom.ts）がある', () => {
    assert.equal(loadError, null, `読み込めない: ${loadError}`)
  })

  it('読み出しは 75〜200% の5の倍数だけを受け付け、範囲外・壊れた値は 100 に戻す', () => {
    assert.ok(Z, '部品が無い')
    const cases = [['100', 100], ['135', 135], ['75', 75], ['200', 200], ['125', 125], ['137', 100], ['70', 100], ['205', 100], ['abc', 100], ['', 100], [null, 100], ['1e2', 100], ['150.0', 150], ['-100', 100]]
    for (const [raw, want] of cases) {
      if (raw === null) store.delete('cl_zoom')
      else store.set('cl_zoom', raw)
      assert.equal(Z.readZoom(), want, `読み出し ${JSON.stringify(raw)} → ${want}`)
    }
  })

  it('ピンチの倍率は 5% 刻みに丸め、範囲に収め、既定値（100/125/150/200）の ±3% 以内は既定値に吸着する', () => {
    assert.ok(Z, '部品が無い')
    const cases = [[123, 125], [127.9, 125], [121, 120], [131, 130], [147.5, 150], [97.2, 100], [103, 100], [104, 105], [72, 75], [40, 75], [260, 200], [197, 200], [196.9, 195], [178, 180], [112.4, 110], [112.6, 115]]
    for (const [raw, want] of cases) assert.equal(Z.snapZoom(raw), want, `${raw} → ${want}`)
  })

  it('確定すると端末に保存し、画面の --sheet-zoom に反映し、購読者へ知らせる（同じ値なら知らせない）', () => {
    assert.ok(Z, '部品が無い')
    let calls = 0
    const off = Z.subscribeZoom(() => { calls += 1 })
    Z.setZoom(135)
    assert.equal(store.get('cl_zoom'), '135')
    assert.equal(store.get('css:--sheet-zoom'), '1.35')
    assert.equal(Z.getZoom(), 135)
    Z.setZoom(135)
    assert.equal(calls, 1)
    Z.setZoom(137) // 不正値は丸めて受ける（5% 刻み）
    assert.equal(Z.getZoom(), 135)
    off()
  })

  it('倍率の表示: 今の値がボタンの値と同じ時だけ選択中・違う時は今の倍率を文字で出す（読み上げにも出す）', () => {
    const src = read('components/sheet.tsx')
    assert.match(src, /useSyncExternalStore\(subscribeZoom, getZoom/, 'ピンチで変わった値にボタンが追従しない')
    assert.match(src, /現在の表示倍率 \$\{zoom\}%/, 'ボタン以外の倍率を文字で出していない')
  })

  it('ピンチの受け方: 枠はページ全体の拡大を起こさない・常時の touchmove を付けない・ctrl でない wheel はすぐ返す', () => {
    const src = read('components/sheet.tsx')
    assert.match(src, /touchAction: 'pan-x pan-y'/)
    assert.match(src, /addEventListener\('touchstart', onTouchStart, \{ passive: true \}\)/)
    // touchmove を付けるのは「指が2本になった時」の中だけ（常時の touchmove を戻さない）
    const moves = [...src.matchAll(/addEventListener\('touchmove'/g)].map((m) => m.index)
    assert.equal(moves.length, 1, `touchmove を付ける所が ${moves.length} か所`)
    const start = src.indexOf('const onTouchStart = ')
    const startEnd = src.indexOf('\n    }\n', start)
    assert.ok(moves[0] > start && moves[0] < startEnd, 'touchmove を指が2本になった時以外に付けている')
    assert.match(src.slice(start, startEnd), /if \(e\.touches\.length !== 2 \|\| session !== null\) return/)
    assert.match(src, /if \(!e\.ctrlKey\) return/)
    assert.match(src, /addEventListener\('gesturestart'/)
  })
})
