// カルテの体重（体重管理アプリの記録を読むだけ）の回帰テスト。2026-09-27 追加。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/weightClient.ts）: 照合（masterId ↔ source_id）・日付の正規化・同日複数の畳み方・
//    前回値（期間外の前回・前回なし）・差の表示・リンク
// 2. 取得（偽の fetch・偽の localStorage。通信しない）: 接続設定なし・POST 本文に合言葉・URL に載せない・
//    失敗の種類・localStorage を書かない（書き込み回数0）
// 3. 配線の静的検査（KartePage が localStorage・console を使わない・既存4パネルの後ろに体重を足す）
// 個人情報は置かない（利用者は数値IDと記号だけ。接続先・合言葉はダミー）。

import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const TS_UNSUPPORTED =
  'この Node では TypeScript を直接読み込めないため、体重の検証をスキップしました（Node 22.18 以降で実行してください）。'

let W = null
try {
  W = await import('../src/lib/weightClient.ts')
} catch {
  W = null
}

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

// ── 偽の localStorage（書き込みを数える） ──
const store = new Map()
let writes = 0
const realLS = globalThis.localStorage
const realFetch = globalThis.fetch
function installLS(entries = {}) {
  store.clear()
  writes = 0
  for (const [k, v] of Object.entries(entries)) store.set(k, v)
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: () => {
      writes++
    },
    removeItem: () => {
      writes++
    },
    clear: () => {
      writes++
    },
    key: () => null,
    get length() {
      return store.size
    },
  }
}

const DUMMY_URL = 'https://script.google.com/macros/s/DUMMY-DEPLOYMENT/exec'
const DUMMY_TOKEN = 'dummy-token-for-test'

/** care-log の利用者（id と source_id だけ） */
const CL = [
  { id: 1, source_id: 'M001' },
  { id: 2, source_id: 'M002' },
  { id: 3, source_id: '17' },
]

function payload(records, residents = null) {
  return {
    ok: true,
    ver: 2,
    residents: residents ?? [
      { id: 'w1', masterId: 'M001' },
      { id: 'w2', masterId: 'M002' },
      { id: 9, masterId: 17 }, // シートで数値に化けた id・masterId
      { id: 'w4', masterId: 'M999' }, // care-log に居ない
      { id: 'w5', masterId: null }, // マスタ未連携
    ],
    records,
    thresholds: null,
  }
}

describe('weightClient 純ロジック', { skip: W === null ? TS_UNSUPPORTED : false }, () => {
  it('masterId ↔ source_id で照合し、照合できない記録は捨てる', () => {
    const m = W.mapWeights(
      payload([
        { id: 'a', residentId: 'w1', measuredOn: '2026-08-14', weight: 52.3 },
        { id: 'b', residentId: 'w2', measuredOn: '2026-08-15', weight: '48.0' },
        { id: 'c', residentId: '9', measuredOn: '2026-08-16', weight: 60 }, // 数値 id の入居者
        { id: 'd', residentId: 'w4', measuredOn: '2026-08-17', weight: 55 }, // care-log に居ない
        { id: 'e', residentId: 'w5', measuredOn: '2026-08-18', weight: 55 }, // masterId なし
        { id: 'f', residentId: 'zz', measuredOn: '2026-08-19', weight: 55 }, // 名簿に居ない
      ]),
      CL,
    )
    assert.deepEqual([...m.keys()].sort(), [1, 2, 3])
    assert.deepEqual(m.get(1), [{ date: '2026-08-14', weight: 52.3, mode: 'normal' }])
    assert.deepEqual(m.get(2), [{ date: '2026-08-15', weight: 48, mode: 'normal' }])
    assert.deepEqual(m.get(3), [{ date: '2026-08-16', weight: 60, mode: 'normal' }])
  })

  it('日付・体重が読めない記録（体重0・空・日付なし）は捨て、日付の古い順に並べる', () => {
    const m = W.mapWeights(
      payload([
        { residentId: 'w1', measuredOn: '2026-09-14', weight: 51.9 },
        { residentId: 'w1', measuredOn: '2026-07-14', weight: 53.0 },
        { residentId: 'w1', measuredOn: null, yearMonth: '2026-06', weight: 53.5 },
        { residentId: 'w1', measuredOn: '2026-06-14', weight: 0 },
        { residentId: 'w1', measuredOn: '2026-05-14', weight: '' },
        { residentId: 'w1', measuredOn: '2026-02-30', weight: 50 },
        { residentId: 'w1', measuredOn: '2026-08-14', weight: 52.3 },
      ]),
      CL,
    )
    assert.deepEqual(
      m.get(1).map((e) => e.date),
      ['2026-07-14', '2026-08-14', '2026-09-14'],
    )
  })

  it('シートの日付が UTC の時刻に化けていても、端末の現地の日付に戻す', () => {
    const d = new Date(2026, 3, 15, 0, 0, 0) // 現地 4/15 0:00
    assert.equal(W.toIsoDay(d.toISOString()), '2026-04-15')
    assert.equal(W.toIsoDay('2026-04-15'), '2026-04-15')
    assert.equal(W.toIsoDay('2026-13-01'), null)
    assert.equal(W.toIsoDay(''), null)
    assert.equal(W.toIsoDay(20260415), null)
  })

  it('同じ日に複数の記録がある時は updatedAt が最も新しい1件を採る', () => {
    const m = W.mapWeights(
      payload([
        { residentId: 'w1', measuredOn: '2026-09-14', weight: 50.1, updatedAt: '2026-09-14T09:00:00.000Z' },
        { residentId: 'w1', measuredOn: '2026-09-14', weight: 50.9, updatedAt: '2026-09-14T11:00:00.000Z' },
        { residentId: 'w1', measuredOn: '2026-09-14', weight: 50.5, updatedAt: '2026-09-14T10:00:00.000Z' },
        { residentId: 'w1', measuredOn: '2026-09-14', weight: 49.0 }, // updatedAt なし＝最も古い扱い
      ]),
      CL,
    )
    assert.deepEqual(m.get(1), [{ date: '2026-09-14', weight: 50.9, mode: 'normal' }])
  })

  it('車椅子で量った記録は mode=chair（measureMode 優先・無い古い記録は車椅子の重さで判定）', () => {
    const m = W.mapWeights(
      payload([
        { residentId: 'w1', measuredOn: '2026-07-14', weight: 45, measureMode: 'chair', rawWeight: 60, wheelchairKg: 15 },
        { residentId: 'w1', measuredOn: '2026-08-14', weight: 45, wheelchairKg: 15 },
        { residentId: 'w1', measuredOn: '2026-09-14', weight: 45, measureMode: 'normal', wheelchairKg: 15 },
      ]),
      CL,
    )
    assert.deepEqual(
      m.get(1).map((e) => e.mode),
      ['chair', 'chair', 'normal'],
    )
  })

  it('前回値: 期間外の前回を使う・最初の測定は前回なし・新しい順', () => {
    const list = [
      { date: '2026-06-14', weight: 53.5, mode: 'normal' },
      { date: '2026-07-14', weight: 53.1, mode: 'normal' },
      { date: '2026-08-14', weight: 52.3, mode: 'chair' },
      { date: '2026-09-14', weight: 52.8, mode: 'normal' },
    ]
    // 期間は 8/1〜9/27（6/14・7/14 は期間外）
    const rows = W.weightRowsInRange(list, '2026-08-01', '2026-09-27')
    assert.deepEqual(
      rows.map((r) => [r.entry.date, r.prev && r.prev.date, r.diff]),
      [
        ['2026-09-14', '2026-08-14', 0.5],
        ['2026-08-14', '2026-07-14', -0.8],
      ],
    )
    const all = W.weightRowsInRange(list, '2026-01-01', '2026-12-31')
    const first = all[all.length - 1]
    assert.equal(first.prev, null)
    assert.equal(first.diff, null)
    assert.deepEqual(W.weightRowsInRange(list, '2026-09-15', '2026-09-27'), [])
    // 並びが崩れた入力でも日付順に並べ直してから前回を取る
    const rev = W.weightRowsInRange(list.slice().reverse(), '2026-08-01', '2026-09-27')
    assert.equal(rev[0].prev.date, '2026-08-14')
  })

  it('差の表示: ↑↓ と ±値（色だけに頼らない）・前回なし', () => {
    assert.deepEqual(W.fmtWeightDiff(-0.8), { arrow: '↓', text: '−0.8', dir: 'down' })
    assert.deepEqual(W.fmtWeightDiff(1.2), { arrow: '↑', text: '+1.2', dir: 'up' })
    assert.deepEqual(W.fmtWeightDiff(0), { arrow: '', text: '±0.0', dir: 'same' })
    const e = (date, weight) => ({ date, weight, mode: 'normal' })
    assert.equal(
      W.weightLineText({ entry: e('2026-09-14', 52.3), prev: e('2026-08-14', 53.1), diff: -0.8 }),
      '9/14（月） 52.3kg（前回53.1kg・↓−0.8）',
    )
    assert.equal(W.weightLineText({ entry: e('2026-09-14', 52.3), prev: null, diff: null }), '9/14（月） 52.3kg（前回なし）')
  })

  it('体重管理アプリを開くリンク: masterId だけを載せる（形の合わない id は一覧を開く）', () => {
    assert.equal(W.weightAppHref('M001'), '../care-tools/weight-record.html?masterId=M001')
    assert.equal(W.weightAppHref(' 17 '), '../care-tools/weight-record.html?masterId=17')
    assert.equal(W.weightAppHref('a b'), '../care-tools/weight-record.html')
    assert.equal(W.weightAppHref(''), '../care-tools/weight-record.html')
    assert.equal(W.weightAppHref(null), '../care-tools/weight-record.html')
  })
})

describe('weightClient 取得（偽の GAS）', { skip: W === null ? TS_UNSUPPORTED : false }, () => {
  let calls = []
  beforeEach(() => {
    calls = []
  })
  afterEach(() => {
    globalThis.localStorage = realLS
    globalThis.fetch = realFetch
  })

  function fakeFetch(respond) {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return respond(url, init)
    }
  }
  const jsonRes = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })

  it('接続設定が無い端末では null（通信しない・書き込み0）', async () => {
    installLS({})
    fakeFetch(() => jsonRes(payload([])))
    assert.equal(await W.fetchWeights(CL), null)
    assert.equal(calls.length, 0)
    assert.equal(writes, 0)
    assert.equal(W.readWeightConfig(), null)
    assert.match(W.MSG_WEIGHT_UNCONFIGURED, /体重管理アプリの接続設定がこの端末にありません/)
  })

  it('localStorage が使えない環境でも例外を出さず null', async () => {
    globalThis.localStorage = {
      getItem() {
        throw new Error('denied')
      },
    }
    assert.equal(await W.fetchWeights(CL), null)
  })

  it('getAll を POST 本文で送り（合言葉は本文だけ・URL に載せない）、照合して返す。書き込み0', async () => {
    installLS({ wtmgr_api_url: DUMMY_URL, wtmgr_api_token: DUMMY_TOKEN })
    fakeFetch(() =>
      jsonRes(
        payload([
          { residentId: 'w1', measuredOn: '2026-08-14', weight: 53.1 },
          { residentId: 'w1', measuredOn: '2026-09-14', weight: 52.3 },
          { residentId: 'w4', measuredOn: '2026-09-14', weight: 70 },
        ]),
      ),
    )
    const res = await W.fetchWeights(CL)
    assert.equal(res.ok, true)
    assert.deepEqual(res.byResident.get(1).map((e) => e.weight), [53.1, 52.3])
    assert.equal(res.byResident.has(2), false)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, DUMMY_URL)
    assert.equal(calls[0].url.includes(DUMMY_TOKEN), false)
    assert.equal(calls[0].init.method, 'POST')
    assert.match(calls[0].init.headers['Content-Type'], /^text\/plain/)
    assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'getAll', token: DUMMY_TOKEN })
    assert.ok(calls[0].init.signal)
    assert.equal(writes, 0)
    assert.equal(store.get('wtmgr_api_url'), DUMMY_URL)
    assert.equal(store.get('wtmgr_api_token'), DUMMY_TOKEN)
  })

  it('合言葉が無い端末は token を送らない（体重管理アプリと同じ）', async () => {
    installLS({ wtmgr_api_url: DUMMY_URL })
    fakeFetch(() => jsonRes(payload([])))
    const res = await W.fetchWeights(CL)
    assert.equal(res.ok, true)
    assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'getAll' })
  })

  it('GAS 以外の宛先には送らない（合言葉を漏らさない）', async () => {
    installLS({ wtmgr_api_url: 'https://example.com/exec', wtmgr_api_token: DUMMY_TOKEN })
    fakeFetch(() => jsonRes(payload([])))
    assert.deepEqual(await W.fetchWeights(CL), { ok: false, reason: 'url' })
    assert.equal(calls.length, 0)
  })

  it('失敗の種類: HTTP 異常・ok でない応答（合言葉不一致）・JSON 破損・通信エラー・タイムアウト', async () => {
    installLS({ wtmgr_api_url: DUMMY_URL, wtmgr_api_token: DUMMY_TOKEN })
    fakeFetch(() => jsonRes({}, 500))
    assert.deepEqual(await W.fetchWeights(CL), { ok: false, reason: 'http' })
    fakeFetch(() => jsonRes({ ok: false, error: 'Error: unauthorized' }))
    assert.deepEqual(await W.fetchWeights(CL), { ok: false, reason: 'refused' })
    fakeFetch(() => jsonRes({ error: 'この読み取りは POST でだけ受け付けます' }))
    assert.deepEqual(await W.fetchWeights(CL), { ok: false, reason: 'refused' })
    fakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad') } }))
    assert.deepEqual(await W.fetchWeights(CL), { ok: false, reason: 'format' })
    fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    assert.deepEqual(await W.fetchWeights(CL), { ok: false, reason: 'network' })
    fakeFetch(() => {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    })
    assert.deepEqual(await W.fetchWeights(CL), { ok: false, reason: 'timeout' })
    assert.equal(writes, 0)
    assert.equal(W.WEIGHT_TIMEOUT_MS, 25000)
    for (const r of ['url', 'timeout', 'network', 'http', 'refused', 'format']) {
      const msg = W.weightFailMessage(r)
      assert.equal(typeof msg, 'string')
      assert.equal(msg.includes(DUMMY_TOKEN), false)
    }
  })
})

describe('体重の配線（静的検査）', () => {
  const strip = (src) => src.replace(/\/\/.*$/gm, '')
  it('weightClient は localStorage を読むだけ（setItem/removeItem/clear を書かない）・console を使わない', () => {
    const src = strip(read('../src/lib/weightClient.ts'))
    assert.equal(/localStorage\.(setItem|removeItem|clear)/.test(src), false)
    assert.equal(/console\./.test(src), false)
    // 書き込み action の経路を作らない（送る action は getAll だけ）
    const actions = [...src.matchAll(/action:\s*'([^']+)'/g)].map((m) => m[1])
    assert.deepEqual(actions, ['getAll'])
  })

  it('カルテは localStorage を期間（cl_karteRange）にしか使わず、console を使わない', () => {
    const src = strip(read('../src/pages/KartePage.tsx'))
    const keys = [...src.matchAll(/localStorage\.(?:get|set)Item\(([^,)]+)/g)].map((m) => m[1].trim())
    assert.deepEqual([...new Set(keys)], ['LS.karteRange'])
    assert.equal(/wtmgr_/.test(src), false)
    assert.equal(/console\./.test(src), false)
  })

  it('体重のパネルは既存4パネル（体温・血圧・脈拍・SpO2）の後ろに足す。期間では取り直さない', () => {
    const src = read('../src/pages/KartePage.tsx')
    const order = ["key: 'temp'", "key: 'bp'", "key: 'pulse'", "key: 'spo2'"].map((k) => src.indexOf(k))
    assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])))
    const panels = src.indexOf('panels.map((p) => <VitalPanel')
    const weight = src.indexOf('{weightPanel ? <VitalPanel panel={weightPanel}')
    assert.ok(panels > 0 && weight > panels)
    // 体重の取得の依存に期間（fromIso/toIso）を入れない
    assert.match(src, /\}, \[residentId, sourceId, tick, weightTick\]\)/)
  })
})
