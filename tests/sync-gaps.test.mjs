// 多端末の同期の検証の穴をふさぐ回帰テスト（2026-10-10 監査 F72・F73）。動きは今も正しいが、壊れても既存の試験が
// 気づけなかった経路を、偽のサーバーで実際に動かして押さえる。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// F73 組合せ3: 圏外で保存 → 他の端末が同じ欄を書く → 復帰して再送（バイタル・食事）。競合で止まり、他の端末の値を巻き戻さない
// F73 組合せ5: apply_cell_edits・apply_note_edits の応答が壊れている（サーバーを戻した・版が違う）。送信待ちを消さない
// F73 0020 が無い・通信できないサーバーでの保存済みの測定の取り消し（deleteVitalEntry を実際に呼ぶ）
// F72 ログインの期限切れ（401）→ 送信待ちに残る → 期限切れの知らせ → トークンの更新・再ログインで待ち時間を無視して送る
//
// window は定義しない＝起動時の自動読み込み・自動再送は動かない。通信はしない。
// 個人情報は置かない（利用者・職員は数値IDのみ。本文は記号だけ）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as CC from './cell-contract.mjs'
import * as NC from './note-contract.mjs'
import { registerLoadFailure } from './ts-load.mjs'

const UNSUPPORTED =
  'この Node では TypeScript・解決フックを使えないため、同期の検証の穴（F72・F73）の試験をスキップしました（Node 22.18 以降で実行してください）。'

const lsStore = new Map()
let DB = null
let loadError = null
try {
  const { registerHooks } = await import('node:module')
  if (typeof registerHooks !== 'function') throw new Error('no registerHooks')
  registerHooks({
    resolve(specifier, context, next) {
      // 拡張子の無い相対 import だけ '.ts' を補う（node: や依存パッケージには触らない）
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
      lsStore.set(k, String(v))
    },
    removeItem: (k) => {
      lsStore.delete(k)
    },
  }
  DB = await import('../src/lib/db.ts')
} catch (e) {
  DB = null
  loadError = e
}

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

// ── 偽の Supabase（通信しない） ─────────────────────────────────────────────

/** handler(q) が返す {data, error, status} をそのまま返す偽のクライアント。auth の購読は控えて、試験から起こせる */
function fakeSupabase(handler) {
  const calls = []
  const authCbs = []
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
      gte(k, v) {
        q.filters.push(['gte', k, v])
        return b
      },
      lte(k, v) {
        q.filters.push(['lte', k, v])
        return b
      },
      or(e) {
        q.filters.push(['or', e])
        return b
      },
      limit(n) {
        q.limit = n
        return b
      },
      order(c, o) {
        q.orders = [...(q.orders ?? []), [c, o?.ascending !== false]]
        return b
      },
      abortSignal() {
        return b
      },
      single: run,
      maybeSingle: run,
      then: (ok, ng) => run().then(ok, ng),
    }
    return b
  }
  const from = (table) => builder({ table, action: 'select', payload: undefined, filters: [] })
  const rpc = (fn, args) => builder({ table: null, action: 'rpc', fn, args, payload: undefined, filters: [] })
  const client = {
    from,
    rpc,
    channel: () => ({
      on() {
        return this
      },
      subscribe() {
        return this
      },
    }),
    removeChannel: () => Promise.resolve(),
    auth: {
      onAuthStateChange(cb) {
        authCbs.push(cb)
        return { data: { subscription: { unsubscribe() {} } } }
      },
      getSession: async () => ({ data: { session: { user: { id: 'u1' } } }, error: null }),
    },
  }
  return { client, calls, authCbs }
}

const eqOf = (q) => Object.fromEntries(q.filters.filter((f) => f[0] === 'eq').map((f) => [f[1], f[2]]))

/**
 * 0011 の JS の写し（tests/cell-contract.mjs）で答える偽のサーバー。
 * opts.offline() が真なら通信できない（status 0）。opts.authOk() が偽なら 401（ログインの期限切れ）。
 * opts.broken(q, data) が値を返すと、書いた上でその data を返す（応答だけが壊れている）
 */
function cellServer(opts = {}) {
  const db = CC.createCellDb()
  const fluids = []
  const fake = fakeSupabase(async (q) => {
    if (opts.offline?.()) return { data: null, error: { message: 'offline' }, status: 0 }
    if (opts.authOk !== undefined && !opts.authOk()) {
      return { data: null, error: { code: opts.authCode ?? 'PGRST303', message: 'JWT expired' }, status: 401 }
    }
    if (q.action === 'rpc' && q.fn === 'apply_cell_edits') {
      try {
        const data = CC.fakeApplyCellEdits(db, q.args)
        if (opts.broken && q.args?.p_table !== 'probe') {
          const b = opts.broken(q, data)
          if (b !== undefined) return { data: b.data, error: null, status: 200 }
        }
        return { data, error: null, status: 200 }
      } catch (e) {
        if (!(e instanceof CC.PgError)) throw e
        return { data: null, error: { code: e.code, message: e.message }, status: e.code === '40001' ? 500 : 400 }
      }
    }
    if (q.action === 'rpc' && q.fn === 'delete_vital') {
      if (opts.deleteVital) return opts.deleteVital(q)
      return { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
    }
    if (q.action === 'insert' && q.table === 'fluid_intake') {
      const row = { id: 100 + fluids.length, rev: 1, ...q.payload }
      fluids.push(row)
      return { data: { ...row }, error: null, status: 201 }
    }
    if (q.action === 'select' && (q.table === 'meals' || q.table === 'vitals')) {
      const eq = eqOf(q)
      const r = db[q.table].find((x) => x.deleted_at === null && Object.entries(eq).every(([k, v]) => x[k] === v))
      return { data: r ? { ...r } : null, error: null, status: 200 }
    }
    if (q.action === 'select') return { data: null, error: null, status: 200 }
    return { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
  })
  const sends = () => fake.calls.filter((q) => q.action === 'rpc' && q.fn === 'apply_cell_edits' && q.args?.p_table !== 'probe')
  return { ...fake, db, fluids, sends }
}

/** 他の端末の書込（同じ 0011 を別の端末＝職員2から呼んだのと同じ） */
const otherDevice = (db, args) => CC.fakeApplyCellEdits(db, { p_fill: {}, p_editor: 2, p_client_key: null, ...args })

const ROUTINE = { routine: true, residentId: 1, day: '2026-09-01' }
const LUNCH = { residentId: 1, day: '2026-09-01', slot: 'lunch' }
const VKEY = { resident_id: 1, measured_on: '2026-09-01', kind: 'routine' }
const MKEY = { resident_id: 1, meal_on: '2026-09-01', meal_slot: 'lunch' }
const settle = () => new Promise((r) => setTimeout(r, 10))

/** 待ち時間のタイマーは張らせるが鳴らさない（試験が自分で送り直しを起こす） */
const quietTimer = { set: () => 'h', clear: () => {} }

async function drain() {
  await settle()
  lsStore.delete('cl_sendQueue')
  lsStore.delete('cl_sendQueue2')
  await DB.__testHooks.restartQueue()
  DB.__testHooks.setClient(null)
  DB.__testHooks.setTimer(null)
}

// ══════════════════════════════════════════════════════════════
// F73 組合せ3: 圏外で保存 → 他の端末が同じ欄を書く → 復帰して再送
// ══════════════════════════════════════════════════════════════

function registerCombo3() {
  describe('F73 組合せ3: 圏外で保存 → 他の端末が同じ欄を書く → 復帰して再送（バイタル・食事）', () => {
    afterEach(drain)

    it('バイタル定時: 36.5 を見て 37.2 に直す（圏外）→ 他の端末が 36.8 → 復帰 → 競合で止まり 36.8 が残る・2回目の再送でも巻き戻さない', async () => {
      let off = false
      const srv = cellServer({ offline: () => off })
      otherDevice(srv.db, { p_table: 'vitals', p_key: VKEY, p_edits: { temp: { value: 36.5, base: null } } })
      DB.__testHooks.setClient(srv.client)
      DB.__testHooks.setTimer(quietTimer)
      off = true
      assert.equal(await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.2, base: 36.5 } }), 'queued')
      const r2 = otherDevice(srv.db, { p_table: 'vitals', p_key: VKEY, p_edits: { temp: { value: 36.8, base: 36.5 } } })
      assert.equal(r2.status, 'applied')
      off = false
      await DB.flushQueue(true)
      await settle()
      assert.equal(srv.db.vitals[0].temp, 36.8, '他の端末の値を古い入力で巻き戻した')
      const p = DB.pendingRow('vitals', ROUTINE)
      assert.ok(p, '送信待ちが消えた（自分の入力が無言で消えた）')
      assert.equal(p.state, 'conflict')
      assert.deepEqual(p.values, { temp: 37.2 })
      assert.deepEqual(
        p.conflicts.map((c) => [c.field, c.reason, c.server, c.mine]),
        [['temp', 'changed', 36.8, 37.2]],
      )
      assert.equal(DB.queuePending(), 1)
      const last = srv.sends().at(-1)
      assert.deepEqual(last.args.p_edits.temp, { value: 37.2, base: 36.5 }, '再送の基準が画面で見た値ではない')
      // 電波の出入りが続いて、もう一度送り直しても、止まった行は送らず 36.8 のまま
      await DB.flushQueue(true)
      await settle()
      assert.equal(srv.db.vitals[0].temp, 36.8, '2回目の再送で他の端末の値を巻き戻した')
      assert.ok(DB.pendingRow('vitals', ROUTINE), '2回目の再送で自分の入力を捨てた')
    })

    it('食事: 主食 5 を見て 8 に直す（圏外）→ 開き直し → 他の端末が 7 → 復帰 → 競合で止まり 7 が残る', async () => {
      let off = false
      const srv = cellServer({ offline: () => off })
      otherDevice(srv.db, { p_table: 'meals', p_key: MKEY, p_edits: { main_amount: { value: 5, base: null } } })
      DB.__testHooks.setClient(srv.client)
      DB.__testHooks.setTimer(quietTimer)
      off = true
      assert.equal(await DB.saveMealEdits(LUNCH, { main_amount: { value: 8, base: 5 } }, { fill: { recorded_by: 1 } }), 'queued')
      // ホーム画面のアプリを閉じて開き直した（localStorage から読み直す。基準も控えから戻ること）
      await DB.__testHooks.restartQueue()
      DB.__testHooks.setClient(srv.client)
      DB.__testHooks.setTimer(quietTimer)
      otherDevice(srv.db, { p_table: 'meals', p_key: MKEY, p_edits: { main_amount: { value: 7, base: 5 } } })
      off = false
      await DB.flushQueue(true)
      await settle()
      assert.equal(srv.db.meals[0].main_amount, 7, '他の端末の値を古い入力で巻き戻した')
      const p = DB.pendingRow('meals', LUNCH)
      assert.ok(p, '送信待ちが消えた')
      assert.equal(p.state, 'conflict')
      assert.deepEqual(p.values, { main_amount: 8 })
      assert.equal(DB.queuePending(), 1)
      await DB.flushQueue(true)
      await settle()
      assert.equal(srv.db.meals[0].main_amount, 7, '2回目の再送で他の端末の値を巻き戻した')
    })

    it('他の端末が別の欄（脈拍）を書いた → 復帰後に自分の体温は書け、脈拍も残る（偽の競合にしない）', async () => {
      let off = false
      const srv = cellServer({ offline: () => off })
      otherDevice(srv.db, { p_table: 'vitals', p_key: VKEY, p_edits: { temp: { value: 36.5, base: null } } })
      DB.__testHooks.setClient(srv.client)
      DB.__testHooks.setTimer(quietTimer)
      off = true
      assert.equal(await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.2, base: 36.5 } }), 'queued')
      otherDevice(srv.db, { p_table: 'vitals', p_key: VKEY, p_edits: { pulse: { value: 70, base: null } } })
      off = false
      await DB.flushQueue(true)
      await settle()
      assert.equal(srv.db.vitals[0].temp, 37.2)
      assert.equal(srv.db.vitals[0].pulse, 70)
      assert.equal(DB.pendingRow('vitals', ROUTINE), null)
      assert.equal(DB.queuePending(), 0)
    })
  })
}

// ══════════════════════════════════════════════════════════════
// F73 組合せ5: 応答が壊れている（サーバーを戻した・版が違う）
// ══════════════════════════════════════════════════════════════

/** 文字列・null は形の検査（asRecord）で、version:2・未知の status は版の検査（parseCellResult）で弾かれる。両方の分岐を通す */
const BROKEN = [
  ['文字列', () => ({ data: 'garbage' })],
  ['version:2（版違い）', (q, d) => ({ data: { ...d, version: 2 } })],
  ['未知の status', (q, d) => ({ data: { ...d, status: 'weird' } })],
  ['null', () => ({ data: null })],
]

function registerCombo5() {
  describe('F73 組合せ5: apply_cell_edits の応答が壊れている（サーバーを戻した・版違い）', () => {
    afterEach(drain)
    for (const [label, fn] of BROKEN) {
      it(`${label}: 送信待ちを消さず、送り直しの上限（10回）で rejected にしても残す（未送信に数え続ける）`, async () => {
        const srv = cellServer({ broken: fn })
        DB.__testHooks.setClient(srv.client)
        DB.__testHooks.setTimer(quietTimer)
        const res = await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.0, base: null } })
        assert.equal(res, 'queued', `壊れた応答で queued 以外を返した: ${JSON.stringify(res)}`)
        let p = DB.pendingRow('vitals', ROUTINE)
        assert.ok(p, '壊れた応答で送信待ちを消した')
        assert.equal(p.state, 'pending')
        assert.equal(DB.queuePending(), 1)
        // 送り直しの上限は db.ts の MAX_TRIES（10回）。値を変えたらここも見直す（上限の無い送り直しにしないため）
        for (let i = 0; i < 12; i++) {
          await DB.flushQueue(true)
          await settle()
        }
        p = DB.pendingRow('vitals', ROUTINE)
        assert.ok(p, '送り直しの途中で送信待ちを消した')
        assert.equal(p.state, 'rejected', `上限で止めていない: ${p.state}`)
        assert.equal(srv.sends().length, 10, `送った回数: ${srv.sends().length}`)
        assert.equal(DB.queuePending(), 1)
      })
    }

    it('書かずに文字列を返すサーバー（戻した先の同名の別関数）: 入力は送信待ちに残り、直した後の送り直しで載る', async () => {
      let rolledBack = true
      const db0 = CC.createCellDb()
      const fake = fakeSupabase(async (q) => {
        if (q.action === 'rpc' && q.fn === 'apply_cell_edits') {
          if (rolledBack && q.args?.p_table !== 'probe') return { data: 'ok', error: null, status: 200 } // 書かない
          return { data: CC.fakeApplyCellEdits(db0, q.args), error: null, status: 200 }
        }
        if (q.action === 'select') return { data: null, error: null, status: 200 }
        return { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
      })
      DB.__testHooks.setClient(fake.client)
      DB.__testHooks.setTimer(quietTimer)
      assert.equal(await DB.saveMealEdits(LUNCH, { main_amount: { value: 8, base: null } }), 'queued')
      assert.equal(db0.meals.length, 0)
      assert.ok(DB.pendingRow('meals', LUNCH), '書けていないのに送信待ちを消した（入力が無言で消えた）')
      rolledBack = false
      await DB.flushQueue(true)
      await settle()
      assert.equal(db0.meals[0]?.main_amount, 8, 'サーバーを直した後に送り直していない')
      assert.equal(DB.queuePending(), 0)
    })
  })

  describe('F73 組合せ5: apply_note_edits の応答が壊れている（申し送りも同じ応答の検査を通る）', () => {
    afterEach(drain)
    for (const [label, fn] of BROKEN) {
      it(`${label}: 申し送りの直しを送信待ちから消さない`, async () => {
        const nd = NC.createNoteDb()
        const fake = fakeSupabase(async (q) => {
          if (q.action === 'rpc' && q.fn === 'apply_note_edits') {
            const data = NC.fakeApplyNoteEdits(nd, q.args)
            const b = fn(q, data)
            return { data: b.data, error: null, status: 200 }
          }
          if (q.action === 'select') return { data: null, error: null, status: 200 }
          return { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
        })
        nd.notes.push({ ...NC.NOTE_BASE_ROW, id: 101, rev: 1, deleted_at: null, edited_by: null })
        DB.__testHooks.setClient(fake.client)
        DB.__testHooks.setTimer(quietTimer)
        const res = await DB.saveNoteEdits({ id: 101 }, { body: { value: '本文A', base: NC.NOTE_BASE_ROW.body } })
        assert.equal(res, 'queued', `壊れた応答で queued 以外を返した: ${JSON.stringify(res)}`)
        assert.equal(DB.queuePending(), 1, '壊れた応答で申し送りの送信待ちを消した')
      })
    }
  })
}

// ══════════════════════════════════════════════════════════════
// F73 0020 が無い・通信できないサーバーでの取り消し（deleteVitalEntry）
// vitaldelete.test.mjs の静的検査（送信待ちに積まない・8欄すべてを p_seen で送る）はそのまま残し、ここでは動かして確かめる
// ══════════════════════════════════════════════════════════════

function registerVitalDelete() {
  describe('F73 0020 が無い／通信できないサーバーでの保存済みの測定の取り消し（deleteVitalEntry）', () => {
    afterEach(drain)
    const seen = { id: 1, rev: 1, measured_at: '10:00', temp: 38.2, sys_bp: null, dia_bp: null, pulse: null, spo2: null, note: null, symptom: null }
    const cases = [
      ['PGRST202（関数が無い）', { data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 }, 'server', 'MSG_VITAL_DELETE_PENDING'],
      ['42883（関数が無い）', { data: null, error: { code: '42883', message: 'undefined_function' }, status: 404 }, 'server', 'MSG_VITAL_DELETE_PENDING'],
      ['status 0（通信できない）', { data: null, error: { message: 'offline' }, status: 0 }, 'network', 'MSG_VITAL_DELETE_OFFLINE'],
    ]
    for (const [label, resp, kind, msgName] of cases) {
      it(`${label}: 消さずに事実の一言（${msgName}）・送信待ちに積まない・行へ直接書かない`, async () => {
        const srv = cellServer({ deleteVital: () => resp })
        const row = { id: 1, resident_id: 1, measured_on: '2026-09-01', kind: 'observation', client_key: 'ck1', ...seen, edited_by: null, recorded_by: 1, deleted_at: null }
        srv.db.vitals.push(row)
        DB.__testHooks.setClient(srv.client)
        DB.__testHooks.setTimer(quietTimer)
        await assert.rejects(
          () => DB.deleteVitalEntry(seen),
          (e) => e instanceof DB.DbError && e.kind === kind && e.message === DB[msgName],
        )
        assert.equal(row.deleted_at, null)
        assert.equal(DB.queuePending(), 0, '取り消しを送信待ちに積んだ')
        assert.equal(srv.calls.filter((q) => q.fn === 'delete_vital').length, 1)
        assert.equal(
          srv.calls.filter((q) => q.table === 'vitals' && (q.action === 'update' || q.action === 'insert')).length,
          0,
          '関数が無い時に vitals へ直接書いた',
        )
      })
    }

    it('応答の形が違う（版違い）: 消えたとは言わず DbError(server)', async () => {
      const srv = cellServer({ deleteVital: () => ({ data: { version: 2, ok: true }, error: null, status: 200 }) })
      DB.__testHooks.setClient(srv.client)
      DB.__testHooks.setTimer(quietTimer)
      await assert.rejects(() => DB.deleteVitalEntry(seen), (e) => e instanceof DB.DbError && e.kind === 'server')
    })
  })
}

// ══════════════════════════════════════════════════════════════
// F72 ログインの期限切れ（401）→ 送信待ちに残る → 期限切れの知らせ → トークンの更新・再ログインで送る
//
// 画面を離れずに戻る経路は refreshSession() の成功 → TOKEN_REFRESHED。Google での再ログインは画面ごと読み込み直し、
// App.tsx の起動時の flushQueue(true) が送る（SIGNED_IN の分岐とは別）。どちらも待ち時間を無視して送ること（force）を守る。
// 本物のクライアントの onAuthStateChange は getClient の本番側の分岐でしか付かないので、配線は本文の照合で押さえる。
// ══════════════════════════════════════════════════════════════

function registerAuthResend() {
  describe('F72 401 → 送信待ち → 期限切れの知らせ → トークンの更新で待ち時間を無視して送る', () => {
    afterEach(drain)
    let expired = 0
    DB.onAuthExpired(() => {
      expired += 1
    })

    it('バイタル（PGRST303）: queued・rejected にしない・知らせる → 待ち時間の中は送らない → TOKEN_REFRESHED で送って消える', async () => {
      let ok = false
      const srv = cellServer({ authOk: () => ok })
      DB.__testHooks.setClient(srv.client)
      DB.__testHooks.setTimer(quietTimer)
      const before = expired
      const res = await DB.saveVitalEdits(ROUTINE, { temp: { value: 36.5, base: null } }, { fill: { measured_at: '9:00', recorded_by: 1 } })
      assert.equal(res, 'queued')
      assert.equal(expired - before, 1, '401 で期限切れの知らせ（onAuthExpired）が1回だけ呼ばれていない')
      assert.equal(DB.pendingRow('vitals', ROUTINE)?.state, 'pending', '401 を拒否（rejected）として止めた')
      assert.equal(DB.queuePending(), 1)
      ok = true
      await DB.flushQueue() // force なし: 401 の待ち時間が残っているので送らない（前提の確認）
      assert.equal(DB.queuePending(), 1, '待ち時間の中なのに送った（試験の前提が崩れた）')
      await DB.__testHooks.authEvent('TOKEN_REFRESHED')
      await settle()
      assert.equal(DB.queuePending(), 0, 'TOKEN_REFRESHED で送信待ちを送り直していない')
      assert.equal(srv.db.vitals[0]?.temp, 36.5)
    })

    it('食事（PGRST301）: 知らせる → SIGNED_IN でも送る', async () => {
      let ok = false
      const srv = cellServer({ authOk: () => ok, authCode: 'PGRST301' })
      DB.__testHooks.setClient(srv.client)
      DB.__testHooks.setTimer(quietTimer)
      const before = expired
      assert.equal(await DB.saveMealEdits(LUNCH, { main_amount: { value: 8, base: null } }, { fill: { recorded_by: 1 } }), 'queued')
      assert.equal(expired - before, 1, '401 で期限切れの知らせが呼ばれていない')
      ok = true
      await DB.flushQueue()
      assert.equal(DB.queuePending(), 1)
      await DB.__testHooks.authEvent('SIGNED_IN')
      await settle()
      assert.equal(DB.queuePending(), 0, 'SIGNED_IN で送信待ちを送り直していない')
      assert.equal(srv.db.meals[0]?.main_amount, 8)
    })

    it('送信キューの op（水分の登録）: 401 → queued・止めない（blocked にしない）→ TOKEN_REFRESHED で送る', async () => {
      let ok = false
      const srv = cellServer({ authOk: () => ok })
      DB.__testHooks.setClient(srv.client)
      DB.__testHooks.setTimer(quietTimer)
      const before = expired
      const r = await DB.insertFluid({ resident_id: 1, taken_on: '2026-09-01', taken_at: '10:00', amount_ml: 150, kind: null, recorded_by: 1 })
      assert.equal(r, 'queued')
      assert.ok(expired > before, '401 で期限切れの知らせが呼ばれていない（insert）')
      await DB.flushQueue(true) // まだ 401 → 待ち時間が伸びる
      assert.equal(DB.queuePending(), 1, '401 の op を送信待ちから外した')
      ok = true
      await DB.flushQueue()
      assert.equal(DB.queuePending(), 1, '待ち時間の中なのに送った（試験の前提が崩れた）')
      await DB.__testHooks.authEvent('TOKEN_REFRESHED')
      await settle()
      assert.equal(DB.queuePending(), 0, 'TOKEN_REFRESHED で送信キューの op を送り直していない')
      assert.equal(srv.fluids.length, 1)
    })
  })

  describe('F72 配線: 本物のクライアントのログインの出来事が送り直しにつながっている（本文の照合）', () => {
    const db = read('../src/lib/db.ts')
    const fnBody = (name) => {
      const start = db.indexOf(`function ${name}(`)
      assert.ok(start >= 0, `${name} が見つからない`)
      const next = db.indexOf('\nfunction ', start + 1)
      const nextAsync = db.indexOf('\nasync function ', start + 1)
      const nextExport = db.indexOf('\nexport ', start + 1)
      const ends = [next, nextAsync, nextExport].filter((i) => i > start)
      return db.slice(start, Math.min(...ends))
    }

    it('getClient が本物のクライアントを作った時に attachAuthWatch(sb) を付ける', () => {
      assert.match(fnBody('getClient'), /attachAuthWatch\(sb\)/)
    })

    it('attachAuthWatch は onAuthStateChange の出来事を onAuthEvent へ渡す（中身を空にしない）', () => {
      const body = fnBody('attachAuthWatch')
      assert.match(body, /sb\.auth\.onAuthStateChange\(\s*\(event\)\s*=>\s*\{[\s\S]*onAuthEvent\(event\)/)
    })

    it('onAuthEvent は SIGNED_IN・TOKEN_REFRESHED の両方で待ち時間を無視して送る（flushQueue(true)）', () => {
      const body = fnBody('onAuthEvent')
      assert.match(body, /'SIGNED_IN'/)
      assert.match(body, /'TOKEN_REFRESHED'/)
      assert.match(body, /await flushQueue\(true\)/)
    })

    it('401・PGRST301〜303 を期限切れと判定する（isAuthFail）', () => {
      const body = fnBody('isAuthFail')
      for (const c of ['401', "'PGRST301'", "'PGRST302'", "'PGRST303'"]) assert.ok(body.includes(c), `${c} が無い`)
    })

    it('Google での再ログインの戻り（画面の読み込み直し）でも、起動時に待ち時間を無視して送る（App.tsx）', () => {
      const app = read('../src/App.tsx')
      assert.match(app, /db\.flushQueue\(true\)/)
    })
  })
}

// ── 登録（表の定数を宣言した後で呼ぶ） ──
if (DB === null) {
  registerLoadFailure('同期の検証の穴（F72・F73）の試験', loadError, UNSUPPORTED, { hooks: true })
} else {
  registerCombo3()
  registerCombo5()
  registerVitalDelete()
  registerAuthResend()
}
