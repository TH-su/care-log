// カルテ・今日の要注意の排便を、共通の DB の正本（care-backend 0094 の carelog_haiben_read）から読む道の試験（2026-11-15・M1 順4）。
// excretionClient.ts を単独で読み、DB の読み手（setExcretionDbReader）を偽物にして確かめる（通信しない）。
//   1. DB から読めた時は GAS へ送らない。DB の応答（0094 が返す項目だけ）での判定・一覧は、同じ記録を GAS の getAll で読んだ結果と同じ
//   2. DB が切り替えの印を文字で答え、live でない時（'shadow'）だけ GAS へ。接続設定も無ければ null（今までの「接続設定がありません」）
//   3. DB を読めない時（null・例外・形が違う）は、接続設定があっても GAS へ戻さず { ok:false, reason:'network' }
//   4. メモリの保持・取り直し（force）・同時の取得の相乗り・ログインし直した時に捨てる、は DB の道でも同じ
//   5. db.ts の読み手: mode が 'live' でない文字なら 'shadow'、印が無い・ok でない・配列でない・断られた時は null
// 個人情報は置かない（氏名の欄は「ダミー」。接続先・合言葉はダミー）。

import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const TS_UNSUPPORTED = 'この Node では TypeScript を直接読み込めないため、排便の DB の道の検証をスキップしました（Node 22.18 以降で実行してください）。'

let X = null
let loadError = null
try {
  X = await import('../src/lib/excretionClient.ts')
} catch (e) {
  X = null
  loadError = e
}
if (X === null) registerLoadFailure('排便の DB の道の検証', loadError, TS_UNSUPPORTED)

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

// 日付は日本時間の今日から数える（GAS も DB も日本時間の暦日）
const jstDay = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10)
const dayAgo = (n) => jstDay(Date.now() - n * 86400000)
const dt = (n, hm) => dayAgo(n) + 'T' + hm

/** GAS の getAll の応答（架空・判定の場面を一通り混ぜる） */
function gasBody() {
  return {
    ok: true,
    residents: [
      { id: 1, name: 'ダミー 甲', yomi: 'だみー', room: '101', gender: '男', active: true, hidden: false, laxNote: 'ダミーのメモ', cfg: '{"stoolWarnD":3,"stoolDangerD":5}', schedule: [], padSet: '' },
      { id: '2', name: 'ダミー乙', yomi: '', room: 202, active: 'TRUE', hidden: false, cfg: { dayOnly: true } },
      { id: 3, name: 'ダミー丙', room: '103', active: true, hidden: false, cfg: '{壊れた' },
      { id: 4, name: 'ダミー職員', room: 'STAFF', active: true, cfg: '' },
    ],
    records: [
      { id: 'r1', residentId: 1, type: 'stool', date: dayAgo(4), time: '09:00', datetime: dt(4, '09:00'), stoolAmt: '中等量', consistency: '普通便', notes: 'ダミー', staff: 'ダミー記入者', urineAmt: '多', medicine: '', tablets: '' },
      { id: 'r2', residentId: 1, type: 'laxative', date: dayAgo(1), time: '20:00', datetime: dt(1, '20:00'), stoolAmt: '', consistency: '', medicine: 'ダミー下剤', tablets: 2 },
      { id: 'r3', residentId: 1, type: 'urine', date: dayAgo(0), time: '06:00', datetime: '', stoolAmt: '', consistency: '' },
      { id: 'r4', residentId: '2', type: 'both', date: dayAgo(2), time: '10:00', datetime: dt(2, '10:00'), stoolAmt: '少量', consistency: '', bristol: 6 },
      { id: 'r5', residentId: 3, type: 'stool', date: dayAgo(15), time: '07:30', datetime: dt(15, '07:30'), stoolAmt: '多量', consistency: '軟便' },
      { id: 'r6', residentId: 3, type: 'stool', date: dayAgo(16), time: '07:30', datetime: dt(16, '07:30'), stoolAmt: '多量', consistency: '軟便' },
      { id: 'sys_staffs_snapshot_v1', residentId: 4, type: 'laxative', medicine: '_SYS_STAFFS_SNAPSHOT_' },
    ],
    cfg: { stoolWarnD: 2, stoolDangerD: 4, other: 'x' },
    delta: true,
  }
}
/** care-backend 0094 が返す形の写し（決まった項目だけ・無い項目は落とす・職員の控えと sys_ は返さない・薬は下剤の時だけ） */
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null))
function pickCfg(c) {
  let v = c
  if (typeof c === 'string' && c.trim().startsWith('{')) {
    try {
      v = JSON.parse(c)
    } catch {
      return undefined
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  return Object.fromEntries(Object.entries(v).filter(([k]) => ['stoolWarnD', 'stoolDangerD', 'dayOnly'].includes(k)))
}
const STAFF_MARKS = ['STAFF', '_staff_']
function dbPayload() {
  const g = gasBody()
  return {
    residents: g.residents
      .filter((r) => !STAFF_MARKS.includes(String(r.room ?? '').trim()) && !STAFF_MARKS.includes(r.yomi ?? ''))
      .map((r) => strip({ id: r.id, name: r.name, room: r.room, active: r.active, hidden: r.hidden, cfg: pickCfg(r.cfg) })),
    records: g.records
      .filter((r) => !String(r.id).startsWith('sys_'))
      .map((r) =>
        strip({
          id: r.id,
          residentId: r.residentId,
          type: r.type,
          date: r.date,
          time: r.time,
          datetime: r.datetime,
          tsUTC: typeof r.tsUTC === 'number' ? r.tsUTC : undefined,
          stoolAmt: r.stoolAmt,
          consistency: r.consistency,
          bristol: r.bristol,
          medicine: r.type === 'laxative' ? r.medicine : undefined,
          tablets: r.type === 'laxative' ? r.tablets : undefined,
        }),
      ),
    cfg: { stoolWarnD: 2, stoolDangerD: 4 },
  }
}
const CL = [
  { id: 11, name: 'ダミー　甲', room: '101号室', active: true },
  { id: 12, name: 'ダミー乙', room: '２０２', active: true },
  { id: 13, name: 'ダミー丙', room: '103', active: true },
]
const views = (snap, now) => CL.map((t) => X.excretionViewFor(snap, t, CL, now))

describe('排便を共通の DB から読む道（偽の読み手・偽の GAS）', { skip: X === null ? TS_UNSUPPORTED : false }, () => {
  let calls = []
  let body = null
  beforeEach(() => {
    calls = []
    body = gasBody()
    X.setExcretionDbReader(null)
    X.clearExcretionCache()
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return { ok: true, status: 200, json: async () => body }
    }
  })
  afterEach(() => {
    X.setExcretionDbReader(null)
    X.clearExcretionCache()
    globalThis.localStorage = realLS
    globalThis.fetch = realFetch
  })

  it('DB から読めた時の判定と一覧は、同じ記録を GAS の getAll で読んだ結果と同じ（照合・しきい値・デイだけ・職員の控えの除外）', async () => {
    installLS({ hbcr_api_url: DUMMY_URL, hbcr_api_token: DUMMY_TOKEN })
    const viaGas = await X.fetchExcretion()
    assert.equal(viaGas.ok, true)
    assert.equal(calls.length, 1)
    const now = Date.now()
    const vg = views(viaGas.snap, now)
    assert.ok(vg.every((v) => v.linked), '材料の3人とも照合できる')
    assert.equal(vg[1].dayOnly, true)
    X.clearExcretionCache()
    let dbCalls = 0
    X.setExcretionDbReader(async () => {
      dbCalls++
      return structuredClone(dbPayload())
    })
    const viaDb = await X.fetchExcretion()
    assert.equal(dbCalls, 1)
    assert.equal(calls.length, 1, 'DB から読めた時は GAS へ送らない')
    assert.equal(viaDb.ok, true)
    assert.deepEqual(views(viaDb.snap, now), vg)
    assert.deepEqual(viaDb.snap.cfg, viaGas.snap.cfg)
    assert.deepEqual(
      viaDb.snap.residents.map((r) => r.id),
      viaGas.snap.residents.map((r) => r.id),
    )
    assert.deepEqual(X.stoolAlertReasons(viaDb.snap, CL, CL, now).reasons, X.stoolAlertReasons(viaGas.snap, CL, CL, now).reasons)
    assert.equal(writes, 0, '端末に書かない')
  })

  it('接続設定が無い端末（現場の iPhone など）でも、DB から読めれば排便を出す（GAS へは送らない）', async () => {
    installLS({})
    X.setExcretionDbReader(async () => structuredClone(dbPayload()))
    const r = await X.fetchExcretion()
    assert.equal(r.ok, true)
    assert.equal(views(r.snap, Date.now())[0].linked, true)
    assert.equal(calls.length, 0)
  })

  it('DB が切り替え前（shadow）と答えた時だけ今までどおり GAS の getAll へ。接続設定も無ければ null・形の違う接続先へは送らない', async () => {
    installLS({ hbcr_api_url: DUMMY_URL, hbcr_api_token: DUMMY_TOKEN })
    X.setExcretionDbReader(async () => 'shadow')
    const r = await X.fetchExcretion()
    assert.equal(r.ok, true)
    assert.deepEqual(
      calls.map((c) => [c.url, c.body.action]),
      [[DUMMY_URL, 'getAll']],
    )
    X.clearExcretionCache()
    installLS({})
    assert.equal(await X.fetchExcretion(), null)
    installLS({ hbcr_api_url: 'https://example.com/x', hbcr_api_token: DUMMY_TOKEN })
    assert.deepEqual(await X.fetchExcretion(), { ok: false, reason: 'url' })
    assert.equal(calls.length, 1)
  })

  const broken = [
    ['null（関数が無い・断られた・通信の失敗・印の無い応答）', async () => null],
    [
      '例外',
      async () => {
        throw new Error('boom')
      },
    ],
    ['形が違う（records が配列でない）', async () => ({ residents: [], records: {} })],
  ]
  for (const [label, reader] of broken) {
    it('DB の読み手が ' + label + " の時は GAS へ戻さず { ok:false, reason:'network' }（接続設定の有無によらない）", async () => {
      installLS({ hbcr_api_url: DUMMY_URL, hbcr_api_token: DUMMY_TOKEN })
      X.setExcretionDbReader(reader)
      assert.deepEqual(await X.fetchExcretion(), { ok: false, reason: 'network' })
      assert.equal(calls.length, 0, 'GAS へ送らない')
      X.clearExcretionCache()
      installLS({})
      assert.deepEqual(await X.fetchExcretion(), { ok: false, reason: 'network' })
      assert.equal(calls.length, 0)
    })
  }

  it('DB の結果もメモリに5分持つ・「再試行する」（force）は読み直す・同時の取得は1本', async () => {
    installLS({})
    let dbCalls = 0
    X.setExcretionDbReader(async () => {
      dbCalls++
      return structuredClone(dbPayload())
    })
    await X.fetchExcretion()
    await X.fetchExcretion()
    assert.equal(dbCalls, 1)
    await X.fetchExcretion({ force: true })
    assert.equal(dbCalls, 2)
    X.clearExcretionCache()
    const [a, b] = await Promise.all([X.fetchExcretion(), X.fetchExcretion()])
    assert.equal(dbCalls, 3)
    assert.equal(a.ok && b.ok, true)
  })

  it('読んでいる間にメモリを捨てた（ログインし直した）時は、届いた結果をメモリに控えない', async () => {
    installLS({})
    let dbCalls = 0
    let release = null
    X.setExcretionDbReader(() => {
      dbCalls++
      // 1回目だけ止めておき、2回目からはすぐ返す（2回目が走ったら＝前の結果を使い回していない）
      if (dbCalls > 1) return Promise.resolve(structuredClone(dbPayload()))
      return new Promise((res) => {
        release = () => res(structuredClone(dbPayload()))
      })
    })
    const p = X.fetchExcretion()
    await new Promise((r) => setTimeout(r, 0))
    X.clearExcretionCache()
    release()
    assert.equal((await p).ok, true)
    await X.fetchExcretion()
    assert.equal(dbCalls, 2, '捨てた後は読み直す（前の結果を使い回さない）')
  })
})

describe('db.ts の排便の読み手（readExcretionFromDb）の判定', () => {
  const src = readFileSync(new URL('../src/lib/db.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export async function readExcretionFromDb'), src.indexOf('setExcretionDbReader(readExcretionFromDb)'))
  it('carelog_haiben_read を db.ts の1か所だけで呼び、読み口へ置く・ログインし直した時に捨てる', () => {
    assert.equal(src.split("rpc('carelog_haiben_read'").length - 1, 1)
    assert.match(src, /\nsetExcretionDbReader\(readExcretionFromDb\)\n/)
    assert.match(src, /clearExcretionCache\(\) \/\/ 排便の記録も同じ（0094）/)
  })
  it('印が文字で live でない時だけ shadow・印が無い／ok でない／配列でない／断られた時は null', () => {
    assert.match(fn, /if \(res\.error !== null\) return null/)
    assert.match(fn, /if \(r === null \|\| typeof r\.mode !== 'string'\) return null/)
    assert.match(fn, /if \(r\.mode !== 'live'\) return 'shadow'/)
    assert.match(fn, /if \(r\.ok !== true \|\| !Array\.isArray\(r\.residents\) \|\| !Array\.isArray\(r\.records\)\) return null/)
    assert.match(fn, /catch \{\n    return null/)
  })
})
