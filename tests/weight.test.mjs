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

  it('最新の1行は期間に関係なく全記録から（前回はその直前・1件だけなら前回なし・0件は null）', () => {
    const list = [
      { date: '2026-08-14', weight: 53.1, mode: 'normal' },
      { date: '2026-06-14', weight: 53.5, mode: 'normal' },
      { date: '2026-09-14', weight: 52.3, mode: 'chair' },
    ]
    const r = W.latestWeightRow(list)
    assert.deepEqual([r.entry.date, r.entry.weight, r.entry.mode, r.prev.date, r.diff], ['2026-09-14', 52.3, 'chair', '2026-08-14', -0.8])
    assert.equal(W.weightLineText(r), '9/14（月） 52.3kg（前回53.1kg・↓−0.8）')
    // 期間（9/15〜9/28）に測定が無くても最新は出せる＝期間内の一覧だけが空
    assert.deepEqual(W.weightRowsInRange(list, '2026-09-15', '2026-09-28'), [])
    assert.equal(W.latestWeightRow(list).entry.date, '2026-09-14')
    const one = W.latestWeightRow([{ date: '2026-09-14', weight: 50, mode: 'normal' }])
    assert.equal(one.prev, null)
    assert.equal(W.weightLineText(one), '9/14（月） 50.0kg（前回なし）')
    assert.equal(W.latestWeightRow([]), null)
  })

  it('文言の出し分け: 記録なし（照合できない）と期間内なし', () => {
    assert.equal(
      W.MSG_WEIGHT_NO_RECORDS,
      '体重管理アプリにこの方の記録が見つかりません（体重管理アプリ側の入居者の紐づけを確認してください）',
    )
    assert.equal(W.MSG_WEIGHT_NONE_IN_RANGE, '表示期間内の測定はありません（最新は上の1行）')
    // 照合できない（masterId が合わない）→ その方の列は無い＝記録なしの文になる
    const m = W.mapWeights(payload([{ residentId: 'w4', measuredOn: '2026-09-14', weight: 55 }]), CL)
    assert.equal(W.latestWeightRow(m.get(1) ?? []), null)
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
    W.clearWeightCache() // 試験ごとにメモリの体重を捨てる（前の試験の成功結果を持ち越さない）
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
    assert.equal(W.WEIGHT_TIMEOUT_MS, 45000)
    for (const r of ['url', 'timeout', 'network', 'http', 'refused', 'format']) {
      const msg = W.weightFailMessage(r)
      assert.equal(typeof msg, 'string')
      assert.equal(msg.includes(DUMMY_TOKEN), false)
    }
  })
})

describe('weightClient メモリ保持と取り直し（2026-09-27）', { skip: W === null ? TS_UNSUPPORTED : false }, () => {
  let calls = []
  let respond = null
  beforeEach(() => {
    calls = []
    W.clearWeightCache()
    installLS({ wtmgr_api_url: DUMMY_URL, wtmgr_api_token: DUMMY_TOKEN })
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return respond(url, init)
    }
  })
  afterEach(() => {
    globalThis.localStorage = realLS
    globalThis.fetch = realFetch
    W.clearWeightCache()
  })
  const ok = (records) => ({ ok: true, status: 200, json: async () => payload(records) })
  const RECS = [
    { residentId: 'w1', measuredOn: '2026-08-14', weight: 53.1 },
    { residentId: 'w2', measuredOn: '2026-09-14', weight: 61.2 },
  ]

  it('成功後は入居者を切り替えても通信しない（全員分を1回で取る）。WEIGHT_CACHE_MS は 10 分', async () => {
    respond = () => ok(RECS)
    const a = await W.fetchWeights([{ id: 1, source_id: 'M001' }])
    const b = await W.fetchWeights([{ id: 2, source_id: 'M002' }])
    assert.equal(calls.length, 1)
    assert.deepEqual(a.byResident.get(1).map((e) => e.weight), [53.1])
    assert.deepEqual(b.byResident.get(2).map((e) => e.weight), [61.2])
    assert.equal(b.byResident.has(1), false) // 頼んだ人の分だけ返す
    assert.equal(W.WEIGHT_CACHE_MS, 600000)
    assert.equal(writes, 0) // メモリだけ（localStorage に書かない）
  })

  it('返した列を書き換えても、メモリの体重は変わらない', async () => {
    respond = () => ok(RECS)
    const a = await W.fetchWeights([{ id: 1, source_id: 'M001' }])
    a.byResident.get(1)[0].weight = 999
    const b = await W.fetchWeights([{ id: 1, source_id: 'M001' }])
    assert.equal(b.byResident.get(1)[0].weight, 53.1)
  })

  it('force（再試行する）はメモリを使わず取り直す', async () => {
    respond = () => ok(RECS)
    await W.fetchWeights([{ id: 1, source_id: 'M001' }])
    respond = () => ok([{ residentId: 'w1', measuredOn: '2026-09-20', weight: 52.0 }])
    const r = await W.fetchWeights([{ id: 1, source_id: 'M001' }], { force: true })
    assert.equal(calls.length, 2)
    assert.deepEqual(r.byResident.get(1).map((e) => e.weight), [52.0])
  })

  it('失敗は保持しない（次の表示で取り直す）', async () => {
    respond = () => ({ ok: false, status: 500, json: async () => ({}) })
    assert.deepEqual(await W.fetchWeights([{ id: 1, source_id: 'M001' }]), { ok: false, reason: 'http' })
    respond = () => ok(RECS)
    const r = await W.fetchWeights([{ id: 1, source_id: 'M001' }])
    assert.equal(r.ok, true)
    assert.equal(calls.length, 2)
  })

  it('取得中に別の入居者を開いても、GAS へは1本しか投げない', async () => {
    let release
    const gate = new Promise((res) => {
      release = res
    })
    respond = async () => {
      await gate
      return ok(RECS)
    }
    const pa = W.fetchWeights([{ id: 1, source_id: 'M001' }])
    const pb = W.fetchWeights([{ id: 2, source_id: 'M002' }])
    release()
    const [a, b] = await Promise.all([pa, pb])
    assert.equal(calls.length, 1)
    assert.deepEqual(a.byResident.get(1).map((e) => e.weight), [53.1])
    assert.deepEqual(b.byResident.get(2).map((e) => e.weight), [61.2])
  })

  it('接続先が変わったらメモリを使わない', async () => {
    respond = () => ok(RECS)
    await W.fetchWeights([{ id: 1, source_id: 'M001' }])
    installLS({ wtmgr_api_url: 'https://script.google.com/macros/s/OTHER/exec', wtmgr_api_token: DUMMY_TOKEN })
    await W.fetchWeights([{ id: 1, source_id: 'M001' }])
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, 'https://script.google.com/macros/s/OTHER/exec')
  })

  it('メモリに持つ形（parseWeightPayload）は番号と体重だけ（氏名・居室を持たない）', () => {
    const snap = W.parseWeightPayload({
      ok: true,
      residents: [{ id: 'w1', masterId: 'M001', name: 'ダミー', room: '101' }],
      records: [{ residentId: 'w1', measuredOn: '2026-09-14', weight: 52.3 }],
    })
    assert.deepEqual([...snap.widMids], [['w1', ['M001']]])
    assert.deepEqual(snap.recs.map((r) => ({ wid: r.wid, e: r.e })), [
      { wid: 'w1', e: { date: '2026-09-14', weight: 52.3, mode: 'normal' } },
    ])
    assert.equal(JSON.stringify(snap.recs).includes('ダミー'), false)
  })

  it('体重管理側で入居者 id が重なっても、一致した行で照合する（以前の mapWeights と同じ・レビュー指摘）', () => {
    const p = {
      ok: true,
      residents: [
        { id: 'w1', masterId: 'M001' },
        { id: 'w1', masterId: 'M999' }, // care-log に居ない masterId が後ろにある
      ],
      records: [{ residentId: 'w1', measuredOn: '2026-09-14', weight: 52.3 }],
    }
    const m = W.mapWeights(p, [{ id: 1, source_id: 'M001' }])
    assert.deepEqual(m.get(1).map((e) => e.weight), [52.3])
  })
})

describe('カルテ上部の移動ボタン（静的検査・2026-09-27）', () => {
  it('ボタンの飛び先はすべて画面の欄（SectionCard の id）と1対1・順番も画面と同じ', () => {
    const src = read('../src/pages/KartePage.tsx')
    const listSrc = src.slice(src.indexOf('export const KARTE_JUMPS'), src.indexOf('function findShellHeader'))
    const ids = [...listSrc.matchAll(/id: '([^']+)'/g)].map((m) => m[1])
    assert.equal(ids.length, 8)
    const cards = [...src.matchAll(/<SectionCard [^>]*id="([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(cards, ids)
  })

  it('ボタンの順番は、カルテが実際に欄を描く順（KarteDetail の JSX）と同じ', () => {
    const src = read('../src/pages/KartePage.tsx')
    const body = src.slice(src.indexOf('function KarteDetail('), src.indexOf('export function KartePage('))
    const comps = ['<VitalsSection', '<WeightSection', '<MealsSection', '<NotesSection', '<BathSection', '<MedSection', '<IncidentSection', '<HistorySection']
    const pos = comps.map((c) => body.indexOf(c))
    assert.ok(pos.every((i, n) => i > 0 && (n === 0 || i > pos[n - 1])), JSON.stringify(pos))
    // 各欄の関数が付けている id が、ボタンの並びと同じ順
    const idOf = (fn) => {
      const f = src.slice(src.indexOf(`function ${fn}(`))
      return /<SectionCard [^>]*id="([^"]+)"/.exec(f)[1]
    }
    const ids = ['VitalsSection', 'WeightSection', 'MealsSection', 'NotesSection', 'BathSection', 'MedSection', 'IncidentSection', 'HistorySection'].map(idOf)
    const listSrc = src.slice(src.indexOf('export const KARTE_JUMPS'), src.indexOf('function findShellHeader'))
    assert.deepEqual(ids, [...listSrc.matchAll(/id: '([^']+)'/g)].map((m) => m[1]))
  })

  it('「再試行する」（weightTick）の時だけ force で取り直す配線', () => {
    const src = read('../src/pages/KartePage.tsx')
    assert.match(src, /const force = weightTick !== forcedWeightTickRef\.current\n\s*forcedWeightTickRef\.current = weightTick/)
    assert.match(src, /fetchWeights\(\[\{ id: residentId, source_id: sourceId \}\], \{ force \}\)/)
    assert.match(src, /onReload=\{\(\) => setWeightTick\(\(n\) => n \+ 1\)\}/)
  })

  it('固定バーの氏名は1行に削らない（truncate を付けない）', () => {
    const src = read('../src/pages/KartePage.tsx')
    const h1 = /<h1 className="([^"]*)">\{resident\.name\}<\/h1>/.exec(src)
    assert.ok(h1)
    assert.equal(/\btruncate\b/.test(h1[1]), false)
    assert.match(h1[1], /break-words/)
  })

  it('氏名とボタンは sticky のバーに入り、印刷では固定しない', () => {
    const src = read('../src/pages/KartePage.tsx')
    const bar = src.slice(src.indexOf('ref={barRef}'), src.indexOf('<header className="mt-2">'))
    assert.match(bar, /className="sticky /)
    assert.match(bar, /print:static/)
    assert.match(bar, /<h1 [^>]*>\{resident\.name\}<\/h1>/)
    assert.match(bar, /<nav aria-label="カルテの欄へ移動"/)
    assert.match(bar, /min-h-tap/)
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

  it('体重区画: 最新の1行を先に出し、記録なし／期間内なしの文を出し分ける（旧「期間を広げて」の文は出さない）', () => {
    const src = read('../src/pages/KartePage.tsx')
    const sec = src.slice(src.indexOf('function WeightSection'), src.indexOf('// 食事・水分の履歴表'))
    assert.ok(sec.indexOf('latest === null ?') > 0)
    assert.ok(sec.indexOf('MSG_WEIGHT_NO_RECORDS') > 0)
    assert.ok(sec.indexOf('<WeightRowLine row={latest} />') < sec.indexOf('MSG_WEIGHT_NONE_IN_RANGE'))
    assert.ok(sec.indexOf('MSG_WEIGHT_NONE_IN_RANGE') < sec.indexOf('rows.map((r) =>'))
    assert.equal(sec.includes('この期間の体重の測定はありません'), false)
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
