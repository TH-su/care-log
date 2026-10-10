// 送信待ち（db.ts の送信キュー）と競合の扱いの回帰テスト（2026-10-10 多端末運用の監査 中核1: F01〜F07・F10〜F12・
// F27・F30・F31・F71）。直す前の版では赤、直した後で緑になる形。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 同じ端末の2つのタブは、db.ts を問い合わせ文字列を変えて2回読み込んで作る（localStorage と navigator.locks は共有）。
// window は定義しない＝起動時の自動読み込み・自動再送は動かない（restartQueue で起動を再現する）。通信はしない。
// 個人情報は置かない（利用者・職員は数値IDのみ。本文は記号だけ）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as CC from './cell-contract.mjs'
import * as NC from './note-contract.mjs'

const UNSUPPORTED = 'この Node では TypeScript・解決フックを使えないため、送信待ちの検証をスキップしました（Node 22.18 以降で実行してください）。'

const lsStore = new Map()
let A = null
let B = null
let RS = null
let CF = null
let ND = null
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
  globalThis.localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => {
      // 端末の保存領域が一杯の状態（同じオリジンの他のアプリと共有・F01）
      if (globalThis.__lsFull) {
        const e = new Error('The quota has been exceeded.')
        e.name = 'QuotaExceededError'
        throw e
      }
      lsStore.set(k, String(v))
    },
    removeItem: (k) => {
      lsStore.delete(k)
    },
  }
  A = await import('../src/lib/db.ts?tab=A')
  B = await import('../src/lib/db.ts?tab=B')
  RS = await import('../src/lib/rowSync.ts')
  CF = await import('../src/lib/conflict.ts')
  ND = await import('../src/lib/noteDrafts.ts')
} catch {
  A = null
}

// ── 偽の Supabase（通信しない。Realtime のチャンネルも手で通知を起こせる） ─────────────────

function fakeSupabase(handler) {
  const calls = []
  const channels = []
  const builder = (q) => {
    const run = () => {
      calls.push(q)
      return Promise.resolve(handler(q))
    }
    const b = {
      select(cols) {
        if (q.action === 'select' && q.cols === undefined) q.cols = cols
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
      in(k, v) {
        q.filters.push(['in', k, v])
        return b
      },
      order() {
        return b
      },
      limit(n) {
        q.limit = n
        return b
      },
      maybeSingle() {
        q.single = true
        return run()
      },
      then: (ok, ng) => run().then(ok, ng),
    }
    return b
  }
  const from = (table) => builder({ table, action: 'select', payload: undefined, filters: [] })
  const rpc = (fn, args) => builder({ table: null, action: 'rpc', fn, args, payload: undefined, filters: [] })
  const channel = () => {
    const ch = {
      handlers: [],
      on(_ev, filter, cb) {
        ch.handlers.push({ table: filter.table, cb })
        return ch
      },
      subscribe() {
        return ch
      },
    }
    channels.push(ch)
    return ch
  }
  /** Realtime の変更通知を起こす */
  const emit = (table, payload) => {
    for (const ch of channels) for (const h of ch.handlers) if (h.table === table) h.cb(payload)
  }
  return {
    client: { from, rpc, channel, removeChannel: () => Promise.resolve('ok'), auth: { onAuthStateChange() {} } },
    calls,
    emit,
  }
}

const offline = () => fakeSupabase(() => ({ data: null, error: { message: 'offline' }, status: 0 }))
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms))

/**
 * 退避 op の表（水分・外出・申し送り・入浴・利用者）を持つ偽のサーバー。insert は冪等キーの重複で 23505、update は
 * eq / is の条件に合う行だけに当て rev を進める（0001 の rev トリガと同じ）。外出の時刻は Postgres と同じく秒付きで持つ。
 * opts: offline(q)→通信断／lose(q)→載せたのに応答だけ失う／reject(q)→そのコードで拒否／hold(q)→応答を待たせる Promise
 */
function legacyServer(opts = {}) {
  const db = { fluid_intake: [], outings: [], notes: [], residents: [], bath_records: [] }
  let nextId = 900
  const match = (row, filters) =>
    filters.every(([op, k, v]) => (op === 'eq' ? row[k] === v : op === 'is' ? (row[k] ?? null) === v : op === 'in' ? v.includes(row[k]) : true))
  const fake = fakeSupabase(async (q) => {
    if (opts.offline?.(q)) return { data: null, error: { message: 'offline' }, status: 0 }
    if (opts.hold) await opts.hold(q)
    const code = opts.reject?.(q)
    if (code) return { data: null, error: { code, message: 'rejected' }, status: 400 }
    if (q.action === 'rpc') return { data: { version: 1, status: 'probe' }, error: null, status: 200 }
    const rows = db[q.table]
    if (rows === undefined) return { data: null, error: { code: 'X', message: `unexpected ${q.table}` }, status: 500 }
    let out
    if (q.action === 'insert') {
      const ck = q.payload.client_key
      if (ck && rows.some((r) => r.client_key === ck)) return { data: null, error: { code: '23505', message: 'dup' }, status: 409 }
      const row = { id: nextId++, rev: 1, deleted_at: null, edited_by: null, ...q.payload }
      rows.push(row)
      out = { data: { ...row }, error: null, status: 201 }
    } else if (q.action === 'update') {
      const hit = rows.find((r) => match(r, q.filters))
      if (!hit) out = { data: null, error: null, status: 200 }
      else {
        Object.assign(hit, q.payload)
        if (typeof hit.end_at === 'string' && /^\d{1,2}:\d{2}$/.test(hit.end_at)) hit.end_at = `${hit.end_at}:00`
        if (typeof hit.rev === 'number') hit.rev += 1
        out = { data: { ...hit }, error: null, status: 200 }
      }
    } else {
      const hits = rows.filter((r) => match(r, q.filters))
      out = q.single ? { data: hits[0] ? { ...hits[0] } : null, error: null, status: 200 } : { data: hits.map((r) => ({ ...r })), error: null, status: 200 }
    }
    if (opts.lose?.(q)) return { data: null, error: { message: 'Load failed' }, status: 0 }
    return out
  })
  return { ...fake, db, updates: () => fake.calls.filter((q) => q.action === 'update'), inserts: () => fake.calls.filter((q) => q.action === 'insert') }
}

/** 0011 apply_cell_edits の JS の写しで答える偽のサーバー（tests/cell-contract.mjs） */
function cellServer(opts = {}) {
  const db = CC.createCellDb()
  const fake = fakeSupabase(async (q) => {
    if (opts.offline?.(q)) return { data: null, error: { message: 'offline' }, status: 0 }
    if (q.action === 'rpc' && q.fn === 'apply_cell_edits') {
      if (opts.hold) await opts.hold(q)
      if (q.args.p_table === 'probe') return { data: { version: 1, status: 'probe' }, error: null, status: 200 }
      try {
        return { data: CC.fakeApplyCellEdits(db, q.args), error: null, status: 200 }
      } catch (e) {
        if (!(e instanceof CC.PgError)) throw e
        return { data: null, error: { code: e.code, message: e.message }, status: 400 }
      }
    }
    return { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
  })
  const sends = () => fake.calls.filter((q) => q.action === 'rpc' && q.args?.p_table !== 'probe')
  return { ...fake, db, sends }
}

/** 0017 apply_note_edits の JS の写し＋申し送りの insert / select に答える偽のサーバー（tests/note-contract.mjs） */
function noteServer(opts = {}) {
  const db = NC.createNoteDb()
  let nextId = 500
  const fake = fakeSupabase(async (q) => {
    if (opts.offline?.()) return { data: null, error: { message: 'offline' }, status: 0 }
    if (q.action === 'rpc' && q.fn === 'apply_note_edits') {
      try {
        return { data: NC.fakeApplyNoteEdits(db, q.args), error: null, status: 200 }
      } catch (e) {
        if (!(e instanceof NC.PgError)) throw e
        return { data: null, error: { code: e.code, message: e.message }, status: 400 }
      }
    }
    if (q.action === 'rpc') return { data: { version: 1, status: 'probe' }, error: null, status: 200 }
    if (q.table === 'notes' && q.action === 'insert') {
      const ck = q.payload.client_key
      if (ck && db.notes.some((r) => r.client_key === ck)) return { data: null, error: { code: '23505', message: 'dup' }, status: 409 }
      const row = { ...NC.NOTE_BASE_ROW, ...q.payload, id: nextId++, rev: 1, deleted_at: null, edited_by: null }
      db.notes.push(row)
      return { data: { ...row }, error: null, status: 201 }
    }
    if (q.table === 'notes' && q.action === 'select') {
      const eq = Object.fromEntries(q.filters.filter((f) => f[0] === 'eq').map((f) => [f[1], f[2]]))
      const rows = db.notes.filter((r) => Object.entries(eq).every(([k, v]) => r[k] === v))
      return { data: rows[0] ? { ...rows[0] } : null, error: null, status: 200 }
    }
    return { data: null, error: { code: 'X', message: `unexpected ${q.table} ${q.action}` }, status: 500 }
  })
  const seed = (over = {}) => {
    const row = { ...NC.NOTE_BASE_ROW, id: nextId++, rev: 1, edited_by: null, deleted_at: null, client_key: null, ...over }
    db.notes.push(row)
    return row
  }
  return { ...fake, db, seed }
}

const ROUTINE = { routine: true, residentId: 1, day: '2026-10-01' }
const ROUTINE2 = { routine: true, residentId: 2, day: '2026-10-01' }

function stored() {
  const box1 = lsStore.has('cl_sendQueue') ? JSON.parse(lsStore.get('cl_sendQueue')) : {}
  const box2 = lsStore.has('cl_sendQueue2') ? JSON.parse(lsStore.get('cl_sendQueue2')) : {}
  return { ops: box1.ops ?? [], brokenRaw: box1.brokenRaw ?? null, rows: box2.rows ?? {}, done: box2.done ?? [], brokenRaw2: box2.brokenRaw ?? null }
}

const noTimer = { set: () => 1, clear: () => undefined }

/** 2つのタブを「起動し直した」状態にし、保存先を空にする */
async function reset() {
  await settle()
  lsStore.clear()
  globalThis.__lsFull = false
  for (const T of [A, B]) {
    T.__testHooks.setClient(null)
    await T.__testHooks.restartQueue()
    T.__testHooks.setTimer(noTimer)
    T.setEditor(null)
  }
}

function outingRow(over = {}) {
  return { id: 40, resident_id: 1, kind: 'outing', start_on: '2026-10-01', start_at: '10:00', end_on: null, end_at: null, companion: null, note: null, recorded_by: 1, edited_by: null, rev: 1, deleted_at: null, client_key: null, ...over }
}

function fluidInput(over = {}) {
  return { resident_id: 1, taken_on: '2026-10-01', taken_at: '10:00', amount_ml: 150, kind: 'water', recorded_by: 1, ...over }
}

const noteBase = { note_on: '2026-10-01', shift: 'day', facility: null, category: null, resident_id: 1, role_tags: [], importance: 'normal', occurred_at: null, ongoing: false, ended_at: null, reporter_id: 1, color: null, after16: false }

if (A === null) {
  it('送信待ちの検証', { skip: UNSUPPORTED }, () => {})
} else {
  describe('★F01 保存領域が一杯で送信待ちを端末に残せない時', () => {
    afterEach(reset)

    it('バイタル・水分の送信待ちも「端末に残せていない」と分かる（hasUnpersistedQueue。申し送りだけを見る hasUnpersistedNotes では漏れる）', async () => {
      A.__testHooks.setClient(offline().client)
      globalThis.__lsFull = true
      try {
        assert.equal(await A.saveVitalEdits(ROUTINE, { temp: { value: 38.2, base: null } }), 'queued')
        assert.equal(A.isQueuePersisted(), false)
        assert.equal(A.hasUnpersistedNotes(), false, '申し送りだけを見る関数では知らせられない（従来の漏れ）')
        assert.equal(typeof A.hasUnpersistedQueue, 'function', 'hasUnpersistedQueue が無い')
        assert.equal(A.hasUnpersistedQueue(), true)
        assert.equal(await A.insertFluid(fluidInput()), 'queued')
        assert.equal(A.hasUnpersistedQueue(), true)
      } finally {
        globalThis.__lsFull = false
      }
      // 書けるようになったら書き戻して、端末に残せた状態に戻る
      await A.flushQueue()
      assert.equal(A.hasUnpersistedQueue(), false)
      assert.equal(A.isQueuePersisted(), true)
    })

    it('送信待ちが空なら false（残すものが無い）', () => {
      assert.equal(A.hasUnpersistedQueue(), false)
    })
  })

  describe('★F02 rev 照合の update が 0行の時は、読み直して自分の書込が届いていたかを確かめる', () => {
    afterEach(reset)

    it('応答だけ失われた外出の帰着: 再送が 0行でも、届いていた（時刻は秒付きで返る）と分かれば外す（未送信に永久に残らない）', async () => {
      let n = 0
      const srv = legacyServer({ lose: (q) => q.action === 'update' && n++ === 0 })
      srv.db.outings.push(outingRow())
      A.__testHooks.setClient(srv.client)
      A.setEditor(1)
      assert.equal(await A.setOutingEnd(40, 1, '2026-10-01', '13:10'), 'queued')
      assert.equal(srv.db.outings[0].rev, 2, 'サーバーには載っている')
      await A.flushQueue(true)
      assert.equal(A.queuePending(), 0, '自分の書込と競合して未送信に残った')
      assert.deepEqual(A.listStoppedOps(), [])
      assert.equal(stored().ops.length, 0)
    })

    it('応答だけ失われた水分の取り消し: 取り消されているかどうかで比べて外す（時刻の書き方の違いで競合にしない）', async () => {
      let n = 0
      const srv = legacyServer({ lose: (q) => q.action === 'update' && n++ === 0 })
      srv.db.fluid_intake.push({ id: 7, resident_id: 1, taken_on: '2026-10-01', taken_at: '10:00', amount_ml: 150, kind: 'water', recorded_by: 1, edited_by: null, rev: 1, deleted_at: null })
      A.__testHooks.setClient(srv.client)
      assert.equal(await A.softDeleteFluid(7, 1), 'queued')
      srv.db.fluid_intake[0].deleted_at = '2026-10-01T01:00:00+00:00'
      await A.flushQueue(true)
      assert.equal(A.queuePending(), 0)
    })

    it('他の端末が本当に変えていた時は従来どおり止め、止まった記録の一覧に中身を出す。〔もう一度送る〕は見せた版を渡した時だけ送る', async () => {
      let off = true
      const srv = legacyServer({ offline: () => off })
      srv.db.outings.push(outingRow())
      A.__testHooks.setClient(srv.client)
      A.setEditor(1)
      assert.equal(await A.setOutingEnd(40, 1, '2026-10-01', '13:10'), 'queued')
      // その間に他の端末が 15:00 で帰着を記入した
      Object.assign(srv.db.outings[0], { end_on: '2026-10-01', end_at: '15:00:00', rev: 2 })
      off = false
      await A.flushQueue(true)
      assert.equal(A.queuePending(), 1)
      const list = A.listStoppedOps()
      assert.equal(list.length, 1)
      assert.equal(list[0].state, 'conflict')
      assert.equal(list[0].table, 'outings')
      assert.equal(list[0].payload.end_at, '13:10')
      const cur = await A.fetchQueuedOpTarget(list[0].qid)
      assert.equal(cur.end_at, '15:00:00')
      const before = srv.updates().length
      assert.equal(await A.resendQueuedOp(list[0].qid), 'conflict', '見せた版を渡さずに古い rev のまま押し通した')
      assert.equal(srv.updates().length, before)
      assert.equal(await A.resendQueuedOp(list[0].qid, { rev: cur.rev }), 'sent')
      assert.equal(srv.db.outings[0].end_at, '13:10:00')
      assert.equal(A.queuePending(), 0)
    })

    it('止まった記録の〔取り下げ〕は墓標を残し、同じ端末の他のタブからも消える', async () => {
      let off = true
      const srv = legacyServer({ offline: () => off })
      srv.db.outings.push(outingRow())
      A.__testHooks.setClient(srv.client)
      assert.equal(await A.setOutingEnd(40, 1, '2026-10-01', '13:10'), 'queued')
      Object.assign(srv.db.outings[0], { end_at: '15:00:00', rev: 2 })
      off = false
      await A.flushQueue(true)
      const [st] = A.listStoppedOps()
      // B（同じ端末の別のタブ）は起動時に同じ op を読み込んでいる
      B.__testHooks.setClient(srv.client)
      await B.__testHooks.restartQueue()
      assert.equal(B.queuePending(), 1)
      assert.equal(await A.discardQueuedOp(st.qid), 'dropped')
      assert.equal(A.queuePending(), 0)
      await B.flushQueue(true)
      assert.equal(B.queuePending(), 0, '他のタブで取り下げた op が残った')
      assert.equal(stored().ops.length, 0)
    })
  })

  describe('★F03 同じ端末の別のタブが積んだ退避 op は、そのタブを閉じても残ったタブが送る', () => {
    afterEach(reset)

    it('タブ A が圏外で積んだ水分を、A を閉じた後にタブ B の送信で送る（再読み込みを待たない）', async () => {
      // B は先に開いていた（A の op を起動時には読んでいない）
      B.__testHooks.setClient(offline().client)
      await B.__testHooks.restartQueue()
      A.__testHooks.setClient(offline().client)
      assert.equal(await A.insertFluid(fluidInput()), 'queued')
      // A を閉じた（生存の Web Lock を手放す。A はもう何もしない）。B に電波が戻る
      A.__testHooks.closeTab()
      const srv = legacyServer()
      B.__testHooks.setClient(srv.client)
      assert.equal(B.queuePending(), 1)
      await B.flushQueue(true)
      assert.equal(srv.inserts().length, 1, '別のタブの op が送られなかった')
      assert.equal(srv.db.fluid_intake.length, 1)
      assert.equal(B.queuePending(), 0)
    })

    it('★手直し: 元のタブが開いている間は引き取らない（A が続けて直した値が自分の変更との競合で止まらない）', async () => {
      // 点検の s2_coalesce（new 1）と同じ形: A が圏外で外出の終了 13:10（rev 1）を積む → 電波が戻り B が先に送信ロックを取る
      // → A はまだ開いたまま、同じ行を 13:20 に直す（送信待ちへ）→ A が送る。直す前は B が 13:10 を送り（rev 2）、
      // A の 13:20@rev1 が 0行→「競合」で止まり、サーバーは 13:10 のまま残った
      B.__testHooks.setClient(offline().client)
      await B.__testHooks.restartQueue()
      let off = true
      const srv = legacyServer({ offline: () => off })
      srv.db.outings.push(outingRow())
      A.__testHooks.setClient(srv.client)
      assert.equal(await A.setOutingEnd(40, 1, '2026-10-01', '13:10'), 'queued')
      off = false
      B.__testHooks.setClient(srv.client)
      const before = srv.updates().length
      await B.flushQueue(true)
      assert.equal(srv.updates().length, before, 'B が生きている A の op を引き取って送った')
      assert.equal(srv.db.outings[0].rev, 1)
      off = true
      assert.equal(await A.setOutingEnd(40, 1, '2026-10-01', '13:20'), 'queued')
      off = false
      await A.flushQueue(true)
      assert.match(String(srv.db.outings[0].end_at), /^13:20/, 'A が続けて直した値が載らなかった')
      assert.equal(A.queuePending(), 0)
      assert.deepEqual(A.listStoppedOps(), [])
      await B.flushQueue(true)
      assert.equal(B.queuePending(), 0, '同じ端末なのに件数が食い違う')
    })

    it('★手直し: 持ち主の印の無い op（旧ビルドのタブが積んだ分）は引き取らない（旧タブが自分で送り直して止まらない）', async () => {
      B.__testHooks.setClient(offline().client)
      await B.__testHooks.restartQueue()
      // 旧ビルドの形（owner なし）の水分の op を、生きている旧タブが積んだとして保存先へ置く
      const op = { qid: 'ck-old-1', table: 'fluid_intake', kind: 'insert', payload: { ...fluidInput(), client_key: 'ck-old-1' }, at: Date.now(), tries: 0, nextAt: 0 }
      lsStore.set('cl_sendQueue', JSON.stringify({ ops: [op] }))
      const srv = legacyServer()
      B.__testHooks.setClient(srv.client)
      await B.flushQueue(true)
      assert.equal(srv.inserts().length, 0, '印の無い op を引き取って送った')
      assert.equal(B.queuePending(), 1, '数えるのは従来どおり')
    })

    it('引き取った op は持ち主をこのタブに書き換えて書き戻す（別のタブがさらに引き取らない）', async () => {
      B.__testHooks.setClient(offline().client)
      await B.__testHooks.restartQueue()
      A.__testHooks.setClient(offline().client)
      assert.equal(await A.insertFluid(fluidInput()), 'queued')
      const stored0 = JSON.parse(lsStore.get('cl_sendQueue')).ops
      assert.equal(stored0[0].owner, A.__testHooks.tabId(), '積んだタブの印が保存先に残っていない')
      A.__testHooks.closeTab()
      await B.flushQueue(true) // 圏外のまま＝引き取るが送れない
      const stored1 = JSON.parse(lsStore.get('cl_sendQueue')).ops
      assert.equal(stored1.length, 1)
      assert.equal(stored1[0].owner, B.__testHooks.tabId())
    })
  })

  describe('★F41 手直し 送れていない申し送りの変更は、欄ごとに「入力した職員」を持つ（記入者とは別）', () => {
    afterEach(reset)

    it('職員01 が本文を直して止まった変更を、記録者を職員02 に替えた後に見ても、本文の入力者は職員01', async () => {
      let off = true
      const srv = noteServer({ offline: () => off })
      const row = srv.seed({ reporter_id: null, body: '本文A' })
      A.__testHooks.setClient(srv.client)
      A.setEditor(1)
      const r = await A.saveNoteEdits({ id: row.id }, { body: { value: '本文B', base: '本文A' } }, { meta: { note_on: '2026-10-01', shift: 'day', resident_id: 1, after16: false } })
      assert.equal(r, 'queued')
      A.setEditor(2)
      const items = A.listUnsentNotes().filter((x) => x.kind === 'edit')
      assert.equal(items.length, 1)
      assert.equal(items[0].row.bys?.body, 1, '本文を入力した職員が分からない（確認文が「あなたの」になる）')
      off = false
    })
  })

  describe('★F04 応答の返らない送信が1件あっても、そのタブの送信・保存が止まり続けない', () => {
    afterEach(reset)

    it('最初の RPC が返らない: 保存は上限の後に送信待ちとして戻り、次の利用者の保存は送られる', async () => {
      let first = true
      const srv = cellServer({
        hold: () => {
          if (!first) return undefined
          first = false
          return new Promise(() => {}) // いつまでも返らない
        },
      })
      A.__testHooks.setClient(srv.client)
      A.__testHooks.setSendTimeout(60)
      const timeout = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('hung'), 3000))])
      const r1 = await timeout(A.saveVitalEdits(ROUTINE, { temp: { value: 37.9, base: null } }))
      assert.notEqual(r1, 'hung', '保存が「保存中」のまま戻らない')
      assert.equal(r1, 'queued')
      const r2 = await timeout(A.saveVitalEdits(ROUTINE2, { temp: { value: 36.5, base: null } }))
      assert.notEqual(r2, 'hung')
      assert.equal(r2.status, 'applied')
      // 返らなかった方も、次の送信で送られる（冪等）
      await timeout(A.flushQueue(true))
      assert.equal(A.queuePending(), 0)
      assert.equal(srv.db.vitals.find((v) => v.resident_id === 1)?.temp, 37.9)
    })

    it('退避 op の update が返らない: 上限の後に「通信できない」として次の機会へ回す（送信が詰まらない）', async () => {
      let hang = true
      const srv = legacyServer({ hold: (q) => (q.action === 'update' && hang ? new Promise(() => {}) : undefined), offline: () => false })
      srv.db.outings.push(outingRow())
      const off = offline()
      A.__testHooks.setClient(off.client)
      assert.equal(await A.setOutingEnd(40, 1, '2026-10-01', '13:10'), 'queued')
      A.__testHooks.setClient(srv.client)
      A.__testHooks.setSendTimeout(60)
      const done = await Promise.race([A.flushQueue(true).then(() => 'ok'), new Promise((r) => setTimeout(() => r('hung'), 3000))])
      assert.equal(done, 'ok', '送信が返らないまま止まった')
      assert.equal(A.queuePending(), 1)
      hang = false
      await A.flushQueue(true)
      assert.equal(A.queuePending(), 0)
    })
  })

  describe('★F05 別のタブで取り下げた申し送りの登録を、元のタブが送らない', () => {
    afterEach(reset)

    it('A が積んだ登録を B で〔取り下げ〕→ 電波が戻っても A は登録しない（墓標）', async () => {
      A.__testHooks.setClient(offline().client)
      assert.equal(await A.insertNote({ ...noteBase, body: '本文X' }), 'queued')
      B.__testHooks.setClient(offline().client)
      await B.__testHooks.restartQueue()
      const ins = B.listUnsentNotes().filter((x) => x.kind === 'insert')
      assert.equal(ins.length, 1)
      await B.discardQueuedNoteInsert(ins[0].op.qid)
      assert.equal(B.queuePending(), 0)
      // A が圏外のまま前面に戻っても、保存先へ復活させない
      await A.flushQueue()
      assert.equal(stored().ops.length, 0, '取り下げた op が保存先に戻った')
      const srv = noteServer()
      A.__testHooks.setClient(srv.client)
      await A.flushQueue(true)
      assert.equal(srv.db.notes.length, 0, '取り下げた申し送りが登録された')
      assert.equal(A.queuePending(), 0)
      assert.equal(A.listUnsentNotes().length, 0)
    })
  })

  describe('★F06 弱い電波で失敗が続いた後、つながったら前の送信待ちも待たずに送る', () => {
    afterEach(reset)

    it('利用者01 の送信が通信断で待ち時間に入った後、利用者02 の保存が届いた同じ回で 01 も送る', async () => {
      let off = true
      const srv = cellServer({ offline: () => off })
      A.__testHooks.setClient(srv.client)
      assert.equal(await A.saveVitalEdits(ROUTINE, { temp: { value: 37.9, base: null } }), 'queued')
      off = false
      const r = await A.saveVitalEdits(ROUTINE2, { temp: { value: 36.5, base: null } })
      assert.equal(r.status, 'applied')
      assert.equal(srv.db.vitals.find((v) => v.resident_id === 1)?.temp, 37.9, '前の送信待ちが待ち時間のまま残った')
      assert.equal(A.queuePending(), 0)
    })

    it('画面に戻った時は、通信断で待っていた送信待ちを待ち時間を置かずに送る（拒否で待っている op は早めない）', async () => {
      let off150 = true
      const srv = legacyServer({
        offline: (q) => off150 && q.action === 'insert' && q.payload.amount_ml === 150,
        reject: (q) => (q.action === 'insert' && q.payload.amount_ml === 999 ? '22023' : null),
      })
      const off = offline()
      A.__testHooks.setClient(off.client)
      assert.equal(await A.insertFluid(fluidInput({ amount_ml: 999 })), 'queued')
      assert.equal(await A.insertFluid(fluidInput({ amount_ml: 150 })), 'queued')
      A.__testHooks.setClient(srv.client)
      await A.flushQueue(true) // 999 は拒否（待ち時間）、150 は通信断（待ち時間）
      const rejectedTries = srv.inserts().filter((q) => q.payload.amount_ml === 999).length
      off150 = false
      assert.equal(typeof A.__testHooks.visibleFlush, 'function')
      await A.__testHooks.visibleFlush()
      assert.equal(srv.db.fluid_intake.filter((r) => r.amount_ml === 150).length, 1, '通信断で待っていた op を画面に戻っても送らなかった')
      assert.equal(srv.inserts().filter((q) => q.payload.amount_ml === 999).length, rejectedTries, '拒否で待っている op まで早めた')
    })
  })

  describe('★F07 送信待ちの間に別の職員が同じ行へ入力した時は、職員ごとに分けて送る', () => {
    afterEach(reset)

    it('バイタル: 職員01の体温と職員02の脈拍は別々の RPC（edited_by が職員ごと・記入者の埋めは最初だけ）', async () => {
      let off = true
      const srv = cellServer({ offline: () => off })
      A.__testHooks.setClient(srv.client)
      A.setEditor(1)
      assert.equal(await A.saveVitalEdits(ROUTINE, { temp: { value: 36.4, base: null } }, { fill: { recorded_by: 1 } }), 'queued')
      A.setEditor(2)
      assert.equal(await A.saveVitalEdits(ROUTINE, { pulse: { value: 72, base: null } }, { fill: { recorded_by: 2 } }), 'queued')
      off = false
      await A.flushQueue(true)
      const sends = srv.sends().filter((q) => !q.args.p_table || q.args.p_table === 'vitals').filter((q) => Object.keys(q.args.p_edits).length > 0)
      const ok = sends.slice(-2)
      assert.equal(ok.length, 2, `1回にまとめて送った: ${JSON.stringify(sends.map((q) => q.args))}`)
      assert.deepEqual(Object.keys(ok[0].args.p_edits), ['temp'])
      assert.equal(ok[0].args.p_editor, 1)
      assert.equal(ok[0].args.p_fill.recorded_by, 1)
      assert.deepEqual(Object.keys(ok[1].args.p_edits), ['pulse'])
      assert.equal(ok[1].args.p_editor, 2)
      assert.deepEqual(ok[1].args.p_fill, {})
      const row = srv.db.vitals.find((v) => v.resident_id === 1)
      assert.equal(row.temp, 36.4)
      assert.equal(row.pulse, 72)
      assert.equal(row.recorded_by, 1)
      assert.equal(A.queuePending(), 0)
    })

    it('★手直し: 先の職員の欄が他の端末と食い違っても、食い違っていない別の職員の欄は続けて送る', async () => {
      // 点検の f_conflict_theirs と同じ形: 圏外で職員01が体温・職員02が脈拍を入れ、その間に他の端末が体温だけを先に記入。
      // 直す前は体温の RPC が conflict で返った時点で抜け、脈拍は送られないまま行ごと「止まっている」に入り、
      // 〔先の値を残す〕で脈拍も一緒に捨てられた
      let off = true
      const srv = cellServer({ offline: () => off })
      A.__testHooks.setClient(srv.client)
      A.setEditor(1)
      assert.equal(await A.saveVitalEdits(ROUTINE, { temp: { value: 36.4, base: null } }, { fill: { recorded_by: 1 } }), 'queued')
      A.setEditor(2)
      assert.equal(await A.saveVitalEdits(ROUTINE, { pulse: { value: 72, base: null } }, { fill: { recorded_by: 2 } }), 'queued')
      off = false
      // 他の端末（保存先を共有しない別の端末）が体温だけを先に記入した（サーバーへ直接。p_key は A が送ろうとした行と同じ）
      const pKey = srv.sends()[0].args.p_key
      const r0 = CC.fakeApplyCellEdits(srv.db, { p_table: 'vitals', p_key: pKey, p_edits: { temp: { value: 36.9, base: null } }, p_fill: {}, p_editor: 1, p_client_key: null })
      assert.equal(r0.status, 'applied')
      await A.flushQueue(true)
      const row = srv.db.vitals.find((v) => v.resident_id === 1)
      assert.equal(row.temp, 36.9, '他の端末の体温が上書きされた')
      assert.equal(row.pulse, 72, '食い違っていない脈拍が送られなかった')
      const p = A.pendingRow('vitals', ROUTINE)
      assert.notEqual(p, null, JSON.stringify(srv.sends().map((q) => [q.args.p_edits, q.args.p_editor])))
      assert.equal(p.state, 'conflict', '体温の食い違いが消えて送る状態へ戻った')
      assert.deepEqual(Object.keys(p.values), ['temp'], '止まっている入力に、送れた脈拍が残った')
      assert.deepEqual(p.conflicts.map((c) => c.field), ['temp'])
    })

    it('★手直し2: 後の職員のまとまりを送っている間は、行を「止まっている」に見せない（送っていない脈拍を「あなたの入力」に入れない）', async () => {
      // 確認役の g_ui・h_midstate と同じ形。1つ目（体温）が conflict で返った時点で行を conflict にすると、2つ目（脈拍）の
      // 応答を待つ間に画面（VitalsSheetPage の adoptStoreRecs）が脈拍まで「あなたの入力」に取り込み、送れた後も
      // 「あなたの入力（体温・脈拍）は保存されません」と出した。2つ目の応答を試験の側で止めて、その間の見え方を確かめる
      let off = true
      let release
      const gate = new Promise((r) => (release = r))
      const srv = cellServer({ offline: () => off, hold: (q) => (q.args.p_editor === 2 ? gate : undefined) })
      A.__testHooks.setClient(srv.client)
      A.setEditor(1)
      assert.equal(await A.saveVitalEdits(ROUTINE, { temp: { value: 36.4, base: null } }, { fill: { recorded_by: 1 } }), 'queued')
      A.setEditor(2)
      assert.equal(await A.saveVitalEdits(ROUTINE, { pulse: { value: 72, base: null } }, { fill: { recorded_by: 2 } }), 'queued')
      off = false
      const pKey = srv.sends()[0].args.p_key
      CC.fakeApplyCellEdits(srv.db, { p_table: 'vitals', p_key: pKey, p_edits: { temp: { value: 36.9, base: null } }, p_fill: {}, p_editor: 1, p_client_key: null })
      const flushing = A.flushQueue(true)
      // 体温（職員01）の応答が返り、脈拍（職員02）の応答を待っている間
      for (let i = 0; i < 50 && !srv.sends().some((q) => q.args.p_editor === 2); i++) await settle()
      assert.ok(srv.sends().some((q) => q.args.p_editor === 2), '脈拍のまとまりを送らなかった')
      const mid = A.pendingRow('vitals', ROUTINE)
      assert.notEqual(mid, null)
      assert.equal(mid.state, 'pending', '脈拍を送っている途中で行を「止まっている」にした（画面が脈拍を「あなたの入力」に取り込む）')
      assert.deepEqual(mid.conflicts, [])
      // 同じ端末の別のタブ（保存先から読む）にも「止まっている」と見せない
      const midB = B.pendingRow('vitals', ROUTINE)
      assert.ok(midB === null || midB.state === 'pending', `別のタブに中途の状態を見せた: ${JSON.stringify(midB)}`)
      release()
      await flushing
      const p = A.pendingRow('vitals', ROUTINE)
      assert.notEqual(p, null)
      assert.equal(p.state, 'conflict', '体温の食い違いが最後に決まらなかった')
      assert.deepEqual(Object.keys(p.values), ['temp'])
      assert.deepEqual(p.conflicts.map((c) => c.field), ['temp'])
      const row = srv.db.vitals.find((v) => v.resident_id === 1)
      assert.equal(row.temp, 36.9)
      assert.equal(row.pulse, 72)
    })

    it('★手直し2: 後の職員のまとまりが通信断で送れなかった時は、行を送る状態のまま残し、次の送信で脈拍も送る', async () => {
      // 1回目の手直しでは、1つ目の食い違いで行が conflict になったまま抜け、脈拍は送られずに「止まっている」へ入った
      // （〔先の値を残す〕で脈拍も一緒に捨てられる窓）。送る状態に残せば、次の送信で体温は食い違いを取り直し、脈拍は届く
      let off = true
      let dropPulse = false
      const srv = cellServer({ offline: (q) => off || (dropPulse && q.action === 'rpc' && q.args?.p_editor === 2) })
      A.__testHooks.setClient(srv.client)
      A.setEditor(1)
      assert.equal(await A.saveVitalEdits(ROUTINE, { temp: { value: 36.4, base: null } }, { fill: { recorded_by: 1 } }), 'queued')
      A.setEditor(2)
      assert.equal(await A.saveVitalEdits(ROUTINE, { pulse: { value: 72, base: null } }, { fill: { recorded_by: 2 } }), 'queued')
      off = false
      dropPulse = true
      const pKey = srv.sends()[0].args.p_key
      CC.fakeApplyCellEdits(srv.db, { p_table: 'vitals', p_key: pKey, p_edits: { temp: { value: 36.9, base: null } }, p_fill: {}, p_editor: 1, p_client_key: null })
      await A.flushQueue(true)
      const mid = A.pendingRow('vitals', ROUTINE)
      assert.notEqual(mid, null)
      assert.equal(mid.state, 'pending', '脈拍が送れないまま行を「止まっている」にした（脈拍が〔先の値を残す〕で捨てられうる）')
      assert.deepEqual(Object.keys(mid.values).sort(), ['pulse', 'temp'])
      dropPulse = false
      await A.flushQueue(true)
      const p = A.pendingRow('vitals', ROUTINE)
      assert.notEqual(p, null)
      assert.equal(p.state, 'conflict')
      assert.deepEqual(Object.keys(p.values), ['temp'])
      const row = srv.db.vitals.find((v) => v.resident_id === 1)
      assert.equal(row.temp, 36.9, '他の端末の体温が上書きされた')
      assert.equal(row.pulse, 72, '脈拍が届かなかった')
      assert.equal(row.edited_by, 2)
    })

    it('血圧の上と下は組なので分けず、後に入力した職員の分として1回で送る', async () => {
      let off = true
      const srv = cellServer({ offline: () => off })
      A.__testHooks.setClient(srv.client)
      // 同じミリ秒に続けて入力しても「後に入力した方」を取り違えない（版の連番で決める）
      const realNow = Date.now
      const fixed = realNow()
      Date.now = () => fixed
      try {
        A.setEditor(1)
        await A.saveVitalEdits(ROUTINE, { sys_bp: { value: 120, base: null } })
        A.setEditor(2)
        await A.saveVitalEdits(ROUTINE, { dia_bp: { value: 80, base: null } })
      } finally {
        Date.now = realNow
      }
      off = false
      await A.flushQueue(true)
      const sends = srv.sends().filter((q) => q.args.p_edits && Object.keys(q.args.p_edits).length > 0)
      const last = sends[sends.length - 1]
      assert.deepEqual(Object.keys(last.args.p_edits).sort(), ['dia_bp', 'sys_bp'])
      assert.equal(last.args.p_editor, 2)
    })

    it('退避 op: 職員01の帰着と職員02の取り消しは1つにまとめず、後の op は先の op が載った版へ付け替えて送る', async () => {
      let off = true
      const srv = legacyServer({ offline: () => off })
      srv.db.outings.push(outingRow())
      A.__testHooks.setClient(srv.client)
      A.setEditor(1)
      assert.equal(await A.setOutingEnd(40, 1, '2026-10-01', '13:10'), 'queued')
      A.setEditor(2)
      assert.equal(await A.softDeleteOuting(40, 1), 'queued')
      assert.equal(stored().ops.length, 2, '職員の違う update を1つにまとめた')
      off = false
      await A.flushQueue(true)
      const ups = srv.updates()
      const landed = ups.filter((q) => q.filters.some((f) => f[1] === 'rev'))
      assert.equal(A.queuePending(), 0, `止まった: ${JSON.stringify(A.listStoppedOps())}`)
      assert.equal(landed[landed.length - 2].payload.edited_by, 1)
      assert.equal(landed[landed.length - 1].payload.edited_by, 2)
      assert.equal(srv.db.outings[0].rev, 3)
      assert.notEqual(srv.db.outings[0].deleted_at, null)
    })
  })

  describe('★F10 応答を待つ間に届いた他の端末の通知を、自分の書込として捨てない', () => {
    afterEach(reset)

    async function subscribe(T) {
      const got = []
      const stop = T.subscribeChanges((table, info) => got.push({ table, row: info?.row ?? null }))
      await settle()
      return { got, stop }
    }

    it('競り負け: 応答待ちの間に届いた他の端末の rev2 は、競合の応答の後に渡され、自分の書込とみなさない', async () => {
      let release
      const gate = new Promise((r) => (release = r))
      const srv = legacyServer({ hold: (q) => (q.action === 'update' ? gate : undefined) })
      srv.db.outings.push(outingRow())
      A.__testHooks.setClient(srv.client)
      const { got, stop } = await subscribe(A)
      const p = A.setOutingEnd(40, 1, '2026-10-01', '13:10')
      await settle()
      // 他の端末が先に同じ行を rev2 にした
      Object.assign(srv.db.outings[0], { end_at: '15:00:00', rev: 2 })
      srv.emit('outings', { eventType: 'UPDATE', new: { ...srv.db.outings[0] } })
      release()
      assert.equal(await p, 'conflict')
      await settle()
      assert.equal(got.filter((g) => g.table === 'outings').length, 1, '他の端末の通知が届かなかった')
      assert.equal(A.isSelfWrite('outings', { id: 40, rev: 2 }), false, '他の端末の rev2 を自分の書込とみなした')
      stop()
    })

    it('送信待ちへ退避した後に届いた他の端末の rev2 は、自分の書込とみなさない', async () => {
      const srv = legacyServer({ offline: () => true })
      A.__testHooks.setClient(srv.client)
      assert.equal(await A.softDeleteFluid(7, 1), 'queued')
      assert.equal(A.isSelfWrite('fluid_intake', { id: 7, rev: 2 }), false)
    })

    it('書けた時: 応答より先に届いた自分の通知も、応答の後に渡して自分の書込とみなす（他の端末の更新と取り違えない）', async () => {
      let release
      const gate = new Promise((r) => (release = r))
      const srv = legacyServer({ hold: (q) => (q.action === 'update' ? gate : undefined) })
      srv.db.outings.push(outingRow())
      A.__testHooks.setClient(srv.client)
      const { got, stop } = await subscribe(A)
      const p = A.setOutingEnd(40, 1, '2026-10-01', '13:10')
      await settle()
      srv.emit('outings', { eventType: 'UPDATE', new: { ...outingRow(), end_at: '13:10:00', rev: 2 } })
      assert.equal(got.length, 0, '応答の前に渡した')
      release()
      const row = await p
      assert.equal(row.rev, 2)
      await settle()
      assert.equal(got.length, 1)
      assert.equal(A.isSelfWrite('outings', got[0].row), true)
      stop()
    })
  })

  describe('★F11 申し送りを自分で削除しても、自分の端末に「他の端末で更新」を出さない', () => {
    afterEach(reset)

    it('取り消せた（0017 は行を返さない）後の取り消しの通知は、自分の書込とみなす', async () => {
      const srv = noteServer()
      const row = srv.seed({ body: '本文Q' })
      A.__testHooks.setClient(srv.client)
      const r = await A.deleteNote({ id: row.id }, '本文Q')
      assert.equal(A.noteDeleted(r), true)
      const now = srv.db.notes.find((x) => x.id === row.id)
      assert.notEqual(now.deleted_at, null)
      assert.equal(A.isSelfWrite('notes', { ...now }), true)
    })
  })

  describe('★F12 血圧の相方を、他の端末が変えたのに見せないまま古い値で上書きしない', () => {
    it('読み直しの判定: 上が競合している間は、もう同じ値の下も「済み」にせず edits に残す', () => {
      const edits = { sys_bp: { value: 130, base: 120, ver: 1 }, dia_bp: { value: 80, base: 80, ver: 2 } }
      const r = RS.reconcileOnLoad(['sys_bp', 'dia_bp'], edits, { sys_bp: 125, dia_bp: 80 })
      assert.equal(r.status, 'conflict')
      assert.deepEqual(Object.keys(r.edits).sort(), ['dia_bp', 'sys_bp'], '組の相方が読み直しで外れた')
    })

    it('くらべて選ぶ: あなたの入力に相方が無くても、他の端末が相方を変えていたら並べる（あなたの入力の欄は見ていた値）', () => {
      const cols = CF.conflictColumns(['sys_bp', 'dia_bp'], { sys_bp: 120, dia_bp: 80 }, { sys_bp: 130 }, { sys_bp: 125, dia_bp: 85 })
      assert.deepEqual(
        cols.map((c) => [c.field, c.theirs, c.mine]),
        [
          ['sys_bp', 125, 130],
          ['dia_bp', 85, 80],
        ],
      )
      // 相方を誰も触っていなければ並べない（従来どおり）
      const same = CF.conflictColumns(['sys_bp', 'dia_bp'], { sys_bp: 120, dia_bp: 80 }, { sys_bp: 130 }, { sys_bp: 125, dia_bp: 80 })
      assert.deepEqual(same.map((c) => c.field), ['sys_bp'])
    })
  })

  describe('★F27 旧ビルドのタブが畳んだ送信待ちを読み戻す・新しい版の送信待ちを畳まない', () => {
    afterEach(reset)

    /** a786fd6^（入浴を足す前）の受け付け集合で cl_sendQueue を読み書きする旧ビルドのタブの写し */
    function oldBuildRoundTrip() {
      const box = JSON.parse(lsStore.get('cl_sendQueue'))
      const ops = []
      let broken = typeof box.brokenRaw === 'string' ? box.brokenRaw : null
      for (const r of box.ops ?? []) {
        if (['fluid_intake', 'notes', 'outings', 'vitals', 'meals'].includes(r.table) || ['read', 'attendance', 'alias'].includes(r.kind)) ops.push(r)
        else broken = broken === null ? JSON.stringify(r) : `${broken}\n${JSON.stringify(r)}`
      }
      const out = { ops }
      if (broken !== null) out.brokenRaw = broken
      lsStore.set('cl_sendQueue', JSON.stringify(out))
    }

    it('旧ビルドが brokenRaw へ畳んだ入浴の op を読み戻し、数えて、送る。送れた後は「読み取れませんでした」も消える', async () => {
      A.__testHooks.setClient(offline().client)
      assert.equal(await A.insertBath({ resident_id: 1, bath_on: '2026-10-01', result: 'full', cancel_reason: null, note: null, recorded_by: 1 }), 'queued')
      oldBuildRoundTrip()
      assert.equal(stored().ops.length, 0)
      assert.match(stored().brokenRaw, /bath_records/)
      await A.__testHooks.restartQueue()
      assert.equal(A.queuePending(), 1, '畳まれた入浴を数えていない')
      const srv = legacyServer()
      A.__testHooks.setClient(srv.client)
      await A.flushQueue(true)
      assert.equal(srv.db.bath_records.length, 1, '畳まれた入浴を送らなかった')
      assert.equal(A.queuePending(), 0)
      assert.equal(stored().brokenRaw, null)
      assert.equal(A.isQueueBroken(), false)
    })

    it('この版が知らない表の op・知らない欄の行は brokenRaw へ畳まず原文のまま残し、未送信として数える（送らない）', async () => {
      const future = { qid: 'fx1', table: 'excretion', kind: 'insert', payload: { resident_id: 1, amount: 2 }, at: 1, tries: 0, nextAt: 0 }
      const row = { table: 'vitals', key: { resident_id: 3, measured_on: '2026-10-01' }, edits: { resp_rate: { value: 18, base: null, at: 1, ver: 'tNEW.1' } }, fill: {}, editor: null, state: 'pending', tries: 0, nextAt: 0, tab: 'tNEW', at: 1 }
      lsStore.set('cl_sendQueue', JSON.stringify({ ops: [future] }))
      lsStore.set('cl_sendQueue2', JSON.stringify({ ver: 2, rows: { 'vitals@3|2026-10-01|routine': row }, done: [] }))
      await A.__testHooks.restartQueue()
      A.__testHooks.setClient(offline().client)
      assert.equal(await A.insertFluid(fluidInput()), 'queued') // この版が書き戻す
      const st = stored()
      assert.ok(st.ops.some((o) => o.qid === 'fx1'), '知らない表の op を ops から外した')
      assert.equal(st.brokenRaw, null)
      assert.ok(st.rows['vitals@3|2026-10-01|routine'], '知らない欄の行を rows から外した')
      assert.equal(st.brokenRaw2, null)
      assert.equal(A.queuePending(), 3)
      assert.equal(A.queueUnreadableCount(), 2)
      const srv = legacyServer()
      A.__testHooks.setClient(srv.client)
      await A.flushQueue(true)
      assert.equal(srv.calls.filter((q) => q.table === 'excretion').length, 0, '知らない表へ送った')
      assert.ok(stored().ops.some((o) => o.qid === 'fx1'))
    })
  })

  describe('★F30 書きかけ: 他のタブの読めない行・整えた欄を、書き戻しで消さない', () => {
    const readData = (kind, x) => (kind === 'note' && x && typeof x.body === 'string' && ['pink', null].includes(x.color ?? null) ? { body: x.body, color: x.color ?? null } : null)

    it('新しい版のタブの「この版が読めない行」と、行に足された欄は原文のまま残る', () => {
      const raw = {
        v: 1,
        tabs: {
          dtNEW: {
            at: 5,
            rows: [
              { did: 'drA', at: 5, kind: 'note', data: { body: '本文A', color: 'pink', attachments: ['p1'] } },
              { did: 'drB', at: 5, kind: 'note', data: { body: '本文B', color: 'purple' } },
            ],
          },
          dtNEW2: { at: 6, rows: [{ did: 'drC', at: 6, kind: 'bath', data: { x: 1 } }] },
        },
        gone: {},
      }
      const file = ND.parseDraftFile(JSON.parse(JSON.stringify(raw)), readData, () => [])
      const next = ND.writeTabRows(file, 'dtMINE', [{ did: 'drM', at: 9, kind: 'note', data: { body: '本文M', color: null } }], 10)
      const out = JSON.parse(JSON.stringify({ tabs: next.tabs, gone: next.gone }))
      assert.deepEqual(out.tabs.dtNEW, raw.tabs.dtNEW, '他のタブの行が書き換わった（読めない行が消えた・欄が剥がれた）')
      assert.deepEqual(out.tabs.dtNEW2, raw.tabs.dtNEW2, '読めない行だけのタブが消えた')
      assert.deepEqual(out.tabs.dtMINE.rows.map((r) => r.did), ['drM'])
      // 和集合（画面に戻す行）は読める行だけ
      assert.deepEqual(ND.unionDraftRows(next).map((r) => r.did).sort(), ['drA', 'drM'])
    })

    it('読めない行も、登録済みの印（gone）が付いた版は残さない', () => {
      const raw = { v: 1, tabs: { dtNEW: { at: 5, rows: [{ did: 'drB', at: 5, kind: 'note', data: { body: '本文B', color: 'purple' } }] } }, gone: { drB: 7 } }
      const file = ND.parseDraftFile(raw, readData, () => [])
      const next = ND.writeTabRows(file, 'dtMINE', [], 10)
      assert.equal(next.tabs.dtNEW, undefined)
    })
  })

  describe('★F31 移行の当て忘れで拒否されて止まった送信待ちも、移行の後に自動で送られる', () => {
    afterEach(reset)

    it('通信断の失敗は拒否の回数に数えない（圏外が続いた op が1回の拒否で止まらない）', async () => {
      let off = true
      const srv = legacyServer({ offline: () => off, reject: (q) => (q.action === 'insert' ? '23514' : null) })
      A.__testHooks.setClient(offline().client)
      assert.equal(await A.insertBath({ resident_id: 1, bath_on: '2026-10-01', result: 'visit', cancel_reason: null, note: null, recorded_by: 1 }), 'queued')
      A.__testHooks.setClient(srv.client)
      for (let i = 0; i < 9; i++) await A.flushQueue(true)
      off = false
      await A.flushQueue(true)
      assert.equal(stored().ops[0]?.blocked, undefined, '通信断の回数で拒否の上限に達した（1回の拒否で止まった）')
    })

    it('DB の版の食い違い（23514）で10回拒否されて止まった op は、起動し直すと1回送り直し、移行の後なら届く', async () => {
      let fixed = false
      const srv = legacyServer({ reject: (q) => (!fixed && q.action === 'insert' ? '23514' : null) })
      A.__testHooks.setClient(offline().client)
      assert.equal(await A.insertBath({ resident_id: 1, bath_on: '2026-10-01', result: 'visit', cancel_reason: null, note: null, recorded_by: 1 }), 'queued')
      A.__testHooks.setClient(srv.client)
      for (let i = 0; i < 10; i++) await A.flushQueue(true)
      const [st] = A.listStoppedOps()
      assert.equal(st?.state, 'rejected')
      assert.equal(st?.errCode, '23514')
      fixed = true // 0016 を当てた
      await A.flushQueue(true)
      assert.equal(srv.db.bath_records.length, 0, '止まった op を勝手に送った（起動し直す前）')
      await A.__testHooks.restartQueue()
      A.__testHooks.setClient(srv.client)
      await A.flushQueue(true)
      assert.equal(srv.db.bath_records.length, 1)
      assert.equal(A.queuePending(), 0)
    })

    it('エラーコードの控えが無い（旧版で止まった）op は、起動し直しても勝手に送らない（一覧の〔もう一度送る〕で送る）', async () => {
      const op = { qid: 'b-old', table: 'bath_records', kind: 'insert', payload: { resident_id: 1, bath_on: '2026-10-01', result: 'visit', client_key: 'b-old' }, at: 1, tries: 10, nextAt: 0, blocked: 'rejected' }
      lsStore.set('cl_sendQueue', JSON.stringify({ ops: [op] }))
      await A.__testHooks.restartQueue()
      const srv = legacyServer()
      A.__testHooks.setClient(srv.client)
      await A.flushQueue(true)
      assert.equal(srv.db.bath_records.length, 0)
      assert.equal(await A.resendQueuedOp('b-old'), 'sent')
      assert.equal(srv.db.bath_records.length, 1)
    })
  })

  describe('★F71 申し送りでの表示名の送信待ちは、基準と重複を確かめてから送る', () => {
    afterEach(reset)

    function residents(srv) {
      srv.db.residents.push(
        { id: 1, source_id: 'S1', name: '利用者01', kana: null, room: null, gender: null, care_level: null, active: true, needs_review: false, note_alias: null },
        { id: 2, source_id: 'S2', name: '利用者02', kana: null, room: null, gender: null, care_level: null, active: true, needs_review: false, note_alias: null },
      )
    }

    it('圏外の間に他の端末が付けた表示名を、古い送信待ちで黙って上書きしない（止めて一覧に出す）', async () => {
      let off = true
      const srv = legacyServer({ offline: () => off })
      residents(srv)
      A.__testHooks.setClient(srv.client)
      assert.equal(await A.setResidentNoteAlias(1, '表示名A', null), 'queued')
      srv.db.residents[0].note_alias = '表示名B' // 他の端末
      off = false
      await A.flushQueue(true)
      assert.equal(srv.db.residents[0].note_alias, '表示名B', '他の端末の表示名を上書きした')
      const [st] = A.listStoppedOps()
      assert.equal(st?.kind, 'alias')
      assert.equal(st?.state, 'conflict')
      // 人が見て「この端末の値で上書き」を選んだ時だけ書く
      assert.equal(await A.resendQueuedOp(st.qid, { alias: '表示名B' }), 'sent')
      assert.equal(srv.db.residents[0].note_alias, '表示名A')
    })

    it('圏外の間に別の利用者へ同じ表示名が付いていたら送らない（同じ表示名が2人に付かない）', async () => {
      let off = true
      const srv = legacyServer({ offline: () => off })
      residents(srv)
      A.__testHooks.setClient(srv.client)
      assert.equal(await A.setResidentNoteAlias(1, '表示名X', null), 'queued')
      srv.db.residents[1].note_alias = '表示名X'
      off = false
      await A.flushQueue(true)
      assert.equal(srv.db.residents[0].note_alias, null)
      assert.equal(A.listStoppedOps()[0]?.state, 'conflict')
    })

    it('基準のままなら送る（2回目の退避でも基準は最初の値のまま）', async () => {
      let off = true
      const srv = legacyServer({ offline: () => off })
      residents(srv)
      A.__testHooks.setClient(srv.client)
      assert.equal(await A.setResidentNoteAlias(1, '表示名A', null), 'queued')
      assert.equal(await A.setResidentNoteAlias(1, '表示名C', '表示名A'), 'queued')
      assert.equal(stored().ops.length, 1)
      assert.equal(stored().ops[0].payload.base, null, '基準が自分の送信待ちの値に置き換わった')
      off = false
      await A.flushQueue(true)
      assert.equal(srv.db.residents[0].note_alias, '表示名C')
      assert.equal(A.queuePending(), 0)
    })
  })
}
