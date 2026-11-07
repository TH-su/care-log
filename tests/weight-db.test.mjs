// カルテ・ひと目ボードの体重を、共通の DB の正本（care-backend 0077 の carelog_weight_read）から読む道の試験（2026-11-08）。
// weightClient.ts を単独で読み、DB の読み手（setWeightDbReader）を偽物にして確かめる（通信しない）。
//   1. DB から読めた時は GAS へ送らない。DB の応答（ケアログが使う6項目だけ）での結果は、同じ記録を GAS の getAll で読んだ結果と同じ
//   2. DB から読めない時（null・例外・形が違う）は今までどおり GAS へ戻る。接続設定も無ければ null（今までの「接続設定がありません」）
//   3. メモリの保持・取り直し（force）・同時の取得の相乗りは DB の道でも同じ
// 個人情報は置かない（利用者は記号と数値IDだけ。氏名の欄は「ダミー」。接続先・合言葉はダミー）。

import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerLoadFailure } from './ts-load.mjs'

const TS_UNSUPPORTED = 'この Node では TypeScript を直接読み込めないため、体重の DB の道の検証をスキップしました（Node 22.18 以降で実行してください）。'

let W = null
let loadError = null
try {
  W = await import('../src/lib/weightClient.ts')
} catch (e) {
  W = null
  loadError = e
}
if (W === null) registerLoadFailure('体重の DB の道の検証', loadError, TS_UNSUPPORTED)

const DUMMY_URL = 'https://script.google.com/macros/s/DUMMY-DEPLOYMENT/exec'
const DUMMY_TOKEN = 'dummy-token-for-test'
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

/** GAS の getAll の応答（架空・いろいろな崩れを混ぜる） */
const GAS_BODY = {
  ok: true,
  ver: 2,
  residents: [
    { id: 'w1', masterId: 'M001', name: 'ダミー甲', room: '901' },
    { id: 'w2', name: 'ダミー乙' }, // サーバーに masterId が無い（端末の対応表で当てる）
    { id: 9, masterId: 17, name: 'ダミー丙' }, // 数値に化けた id・masterId
    { id: 'w4', masterId: 'M999', name: 'ダミー丁' }, // care-log に居ない
    { id: 'wm_M005', name: 'ダミー戊' }, // 入居者マスタから作った id（推定で当てる）
  ],
  records: [
    { residentId: 'w1', measuredOn: '2026-08-14', weight: 53.1, recordedBy: 'ダミー記録者', updatedAt: '2026-08-14T01:00:00.000Z' },
    { residentId: 'w1', measuredOn: '2026-09-14T15:00:00.000Z', weight: '52.3', wheelchairKg: 15, updatedAt: '2026-09-14T16:00:00.000Z' },
    { residentId: 'w1', measuredOn: '2026-09-14T15:00:00.000Z', weight: 52.0, measureMode: 'normal', updatedAt: '2026-09-14T17:00:00.000Z', note: 'ダミーの一言' },
    { residentId: 'w2', measuredOn: '2026-09-01', weight: 61.2, measureMode: 'chair' },
    { residentId: 9, measuredOn: '2026/9/3', weight: 44 },
    { residentId: 'w4', measuredOn: '2026-09-14', weight: 70 },
    { residentId: 'wm_M005', measuredOn: '2026-09-20', weight: 48.5 },
    { residentId: 'w1', measuredOn: '2026-09-30', weight: 0 },
    { residentId: 'w1', measuredOn: '2026-02-30', weight: 50 },
    { residentId: 'w1', measuredOn: '', weight: 50 },
  ],
  thresholds: { warn: 2 },
}
/** care-backend 0077 が返す形（GAS の getAll の同じ名前の項目だけ・無い項目は null）＝ SQL の jsonb_build_object の写し */
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] === undefined ? null : o[k]]))
const DB_PAYLOAD = {
  residents: GAS_BODY.residents.map((r) => pick(r, ['id', 'masterId'])),
  records: GAS_BODY.records.map((r) => pick(r, ['residentId', 'measuredOn', 'weight', 'wheelchairKg', 'measureMode', 'updatedAt'])),
}
const CL = [
  { id: 1, source_id: 'M001' },
  { id: 2, source_id: 'M002' },
  { id: 3, source_id: '17' },
  { id: 5, source_id: 'M005' },
]
const LOCAL = JSON.stringify({ residents: [{ id: 'w2', masterId: 'M002', name: 'ダミー乙' }], records: [] })

describe('体重を共通の DB から読む道（偽の読み手・偽の GAS）', { skip: W === null ? TS_UNSUPPORTED : false }, () => {
  let calls = []
  let gasBody = GAS_BODY
  beforeEach(() => {
    calls = []
    gasBody = GAS_BODY
    W.setWeightDbReader(null)
    W.clearWeightCache()
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return { ok: true, status: 200, json: async () => gasBody }
    }
  })
  afterEach(() => {
    W.setWeightDbReader(null)
    W.clearWeightCache()
    globalThis.localStorage = realLS
    globalThis.fetch = realFetch
  })

  it('DB から読めた時の結果は、同じ記録を GAS の getAll で読んだ結果と同じ（照合・日付・同じ日の畳み方・推定・linked）', async () => {
    installLS({ wtmgr_api_url: DUMMY_URL, wtmgr_api_token: DUMMY_TOKEN, wtmgr_v1: LOCAL })
    const viaGas = await W.fetchWeights(CL)
    assert.equal(calls.length, 1)
    assert.equal(viaGas.ok, true)
    assert.ok(viaGas.byResident.size >= 4, '材料が照合の場面を一通り通っている')
    W.clearWeightCache()
    let dbCalls = 0
    W.setWeightDbReader(async () => {
      dbCalls++
      return structuredClone(DB_PAYLOAD)
    })
    const viaDb = await W.fetchWeights(CL)
    assert.equal(dbCalls, 1)
    assert.equal(calls.length, 1, 'DB から読めた時は GAS へ送らない')
    assert.deepEqual([...viaDb.byResident].sort((a, b) => a[0] - b[0]), [...viaGas.byResident].sort((a, b) => a[0] - b[0]))
    assert.equal(viaDb.linked, viaGas.linked)
    assert.equal(writes, 0, '端末に書かない')
  })

  it('接続設定が無い端末（現場の iPhone など）でも、DB から読めれば体重を出す（GAS へは送らない）', async () => {
    installLS({})
    W.setWeightDbReader(async () => structuredClone(DB_PAYLOAD))
    const r = await W.fetchWeights(CL)
    assert.equal(r.ok, true)
    // 同じ日の2件は直した時刻の新しい方（52.0）。日付は端末の時間帯で決まるので、ここでは体重と量り方だけを見る
    assert.deepEqual(r.byResident.get(1).map((e) => [e.weight, e.mode]), [[53.1, 'normal'], [52.0, 'normal']])
    assert.deepEqual(r.byResident.get(5).map((e) => e.weight), [48.5])
    assert.equal(calls.length, 0)
  })

  for (const [label, reader] of [
    ['null（関数が無い・切り替え前・断られた）', async () => null],
    ['例外', async () => {
      throw new Error('boom')
    }],
    ['形が違う（residents が配列でない）', async () => ({ residents: {}, records: [] })],
  ]) {
    it(`DB の読み手が ${label} の時は今までどおり GAS へ戻る。接続設定も無ければ null`, async () => {
      installLS({ wtmgr_api_url: DUMMY_URL, wtmgr_api_token: DUMMY_TOKEN, wtmgr_v1: LOCAL })
      W.setWeightDbReader(reader)
      const r = await W.fetchWeights(CL)
      assert.equal(r.ok, true)
      assert.deepEqual(calls.map((c) => [c.url, c.body.action]), [[DUMMY_URL, 'getAll']])
      W.clearWeightCache()
      installLS({})
      assert.equal(await W.fetchWeights(CL), null)
      assert.equal(calls.length, 1)
      installLS({ wtmgr_api_url: 'https://example.com/x' })
      assert.deepEqual(await W.fetchWeights(CL), { ok: false, reason: 'url' }, 'GAS の形でない接続先へは送らない')
      assert.equal(calls.length, 1)
    })
  }

  it('DB の結果もメモリに10分持つ（入居者を替えても読み直さない）・「再試行する」（force）は読み直す・同時の取得は1本', async () => {
    installLS({})
    let dbCalls = 0
    W.setWeightDbReader(async () => {
      dbCalls++
      return structuredClone(DB_PAYLOAD)
    })
    await W.fetchWeights([{ id: 1, source_id: 'M001' }])
    await W.fetchWeights([{ id: 3, source_id: '17' }])
    assert.equal(dbCalls, 1)
    await W.fetchWeights([{ id: 1, source_id: 'M001' }], { force: true })
    assert.equal(dbCalls, 2)
    W.clearWeightCache()
    const [a, b] = await Promise.all([W.fetchWeights([{ id: 1, source_id: 'M001' }]), W.fetchWeights([{ id: 3, source_id: '17' }])])
    assert.equal(dbCalls, 3)
    assert.deepEqual(a.byResident.get(1).map((e) => e.weight), [53.1, 52.0])
    assert.deepEqual(b.byResident.get(3).map((e) => e.weight), [44])
  })

  it('読んでいる間にメモリを捨てた（ログインし直した）時は、届いた結果をメモリに控えない（前のアカウントの体重を使い回さない）', async () => {
    installLS({})
    let dbCalls = 0
    let release = null
    W.setWeightDbReader(() => {
      dbCalls++
      return new Promise((res) => {
        release = () => res(structuredClone(DB_PAYLOAD))
      })
    })
    const p = W.fetchWeights(CL)
    await new Promise((r) => setTimeout(r, 0))
    W.clearWeightCache()
    release()
    await p
    const q = W.fetchWeights(CL)
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(dbCalls, 2, '捨てた後は読み直す（捨てる前の結果を控えていない）')
    release()
    assert.equal((await q).ok, true)
  })

  it('DB から読めず GAS から読んだ結果は、接続先ごとにメモリに持つ（接続先を変えたら読み直す）', async () => {
    installLS({ wtmgr_api_url: DUMMY_URL, wtmgr_api_token: DUMMY_TOKEN })
    let dbCalls = 0
    W.setWeightDbReader(async () => {
      dbCalls++
      return null
    })
    await W.fetchWeights(CL)
    await W.fetchWeights(CL)
    assert.equal(calls.length, 1)
    assert.equal(dbCalls, 1)
    store.set('wtmgr_api_url', 'https://script.google.com/macros/s/DUMMY-OTHER/exec')
    await W.fetchWeights(CL)
    assert.equal(calls.length, 2)
  })
})
