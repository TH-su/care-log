// 申し送り（notes）を同時に編集されても消さない作り（2026-09-29・段B）の回帰テスト。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 契約: 0017 apply_note_edits の JS の写し（tests/note-contract.mjs）が契約の表どおりに答えること
//    （同じ表を素の Postgres で流すのは tests/note-contract-pg.mjs）
// 2. 再現（修正前は赤・修正後は緑）: 精査 C1・C2・H1・H2・M1・M3（db.ts の偽クライアント・純関数）
//    修正前の版で流す時は CL_NOTES_SRC に修正前の src の場所を渡す（既定はこのリポジトリの src）
// 3. 送信待ちの規則（申し送り）: 旧形式の読み替え・止まった op の一覧・〔新しい行として…〕・取り下げ・画面の配線
// 個人情報は置かない（利用者・職員は数値IDのみ。本文は記号だけ）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import * as NC from './note-contract.mjs'
import { registerLoadFailure } from './ts-load.mjs'

const SRC = process.env.CL_NOTES_SRC ? pathToFileURL(`${process.env.CL_NOTES_SRC.replace(/\/$/, '')}/`).href : new URL('../src/', import.meta.url).href
const UNSUPPORTED = 'この Node では TypeScript・解決フックを使えないため、申し送りの検証をスキップしました（Node 22.18 以降で実行してください）。'

const lsStore = new Map()
let DB = null
let NE = null
let ND = null
let loadError = null
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
      // 端末の保存領域が一杯の状態を作る（L7-2）。書き込みは QuotaExceededError で失敗する
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
  DB = await import(new URL('lib/db.ts', SRC).href)
} catch (e) {
  DB = null
  loadError = e
}
try {
  NE = await import(new URL('lib/noteEdit.ts', SRC).href)
} catch {
  NE = null
}
try {
  ND = await import(new URL('lib/noteDrafts.ts', SRC).href)
} catch {
  ND = null
}

const read = (p) => readFileSync(new URL(p, SRC), 'utf8')

// ── 偽の Supabase（通信しない） ─────────────────────────────────────────────

function fakeSupabase(handler) {
  const calls = []
  const builder = (q) => {
    const run = async () => {
      calls.push(q)
      return handler(q)
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
      or(expr) {
        q.filters.push(['or', expr])
        return b
      },
      limit(n) {
        q.limit = n
        return b
      },
      order(col, opts) {
        q.orders = [...(q.orders ?? []), [col, opts?.ascending !== false]]
        return b
      },
      maybeSingle: run,
      then: (ok, ng) => run().then(ok, ng),
    }
    return b
  }
  const from = (table) => builder({ table, action: 'select', payload: undefined, filters: [] })
  const rpc = (fn, args) => builder({ table: null, action: 'rpc', fn, args, payload: undefined, filters: [] })
  return { client: { from, rpc, auth: { onAuthStateChange() {} } }, calls }
}

const eqOf = (q) => Object.fromEntries(q.filters.filter((f) => f[0] === 'eq').map((f) => [f[1], f[2]]))

/**
 * 申し送りの偽のサーバー。rpc('apply_note_edits') は 0017 の写し（fakeApplyNoteEdits）、from('notes') の
 * update は rev 照合（修正前の経路）、insert は client_key の冪等、select は行 id で読む。
 * opts.offline() が true の間は通信できない（status 0）
 */
function noteServer(opts = {}) {
  const db = NC.createNoteDb()
  let nextId = 500
  const fake = fakeSupabase(async (q) => {
    if (opts.offline?.()) return { data: null, error: { message: 'offline' }, status: 0 }
    if (q.action === 'rpc' && q.fn === 'apply_note_edits') {
      if (typeof opts.missing === 'function' ? opts.missing() : opts.missing) {
        return { data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 }
      }
      try {
        return { data: NC.fakeApplyNoteEdits(db, q.args), error: null, status: 200 }
      } catch (e) {
        if (!(e instanceof NC.PgError)) throw e
        return { data: null, error: { code: e.code, message: e.message }, status: 400 }
      }
    }
    if (q.action === 'rpc') return { data: { version: 1, status: 'probe' }, error: null, status: 200 }
    if (q.table === 'notes' && q.action === 'update') {
      const eq = eqOf(q)
      const row = db.notes.find((r) => r.id === eq.id && r.rev === eq.rev && r.deleted_at === null)
      if (!row) return { data: null, error: null, status: 200 }
      Object.assign(row, q.payload, { rev: row.rev + 1 })
      return { data: { ...row }, error: null, status: 200 }
    }
    if (q.table === 'notes' && q.action === 'insert') {
      if (opts.hold) await opts.hold(q) // 送信中（応答を待たせる）
      if (opts.failInsertIf?.(q)) return { data: null, error: { code: 'X', message: 'server busy' }, status: 503 }
      const ck = q.payload.client_key
      if (ck && db.notes.some((r) => r.client_key === ck)) return { data: null, error: { code: '23505', message: 'dup' }, status: 409 }
      const row = { ...NC.NOTE_BASE_ROW, ...q.payload, id: nextId++, rev: 1, deleted_at: null, edited_by: null }
      db.notes.push(row)
      // 届いたが応答が失われた（サーバーには載ったのに、端末には通信断として返る）
      if (opts.lostResponse?.(q)) return { data: null, error: { message: 'Failed to fetch' }, status: 0 }
      return { data: { ...row }, error: null, status: 201 }
    }
    if (q.table === 'notes' && q.action === 'select' && opts.readError?.(q)) {
      return { data: null, error: { code: 'X', message: 'read failed' }, status: 0 }
    }
    if (q.table === 'notes' && q.action === 'select') {
      const eq = eqOf(q)
      const ins = q.filters.find((f) => f[0] === 'in')
      const live = q.filters.some((f) => f[0] === 'is' && f[1] === 'deleted_at')
      let rows = db.notes.filter((r) => (!live || r.deleted_at === null) && Object.entries(eq).every(([k, v]) => r[k] === v))
      if (ins) rows = rows.filter((r) => ins[2].includes(r.id))
      if (!ins && (q.limit === 1 || eq.id !== undefined)) return { data: rows[0] ? { ...rows[0], updated_at: '2026-09-01T00:00:00Z' } : null, error: null, status: 200 }
      return { data: rows.map((r) => ({ ...r })), error: null, status: 200 }
    }
    if (q.table === 'record_history') {
      const eq = eqOf(q)
      const rows = db.history
        .filter((h) => h.row_id === eq.row_id)
        .map((h, i) => ({ id: i + 1, table_name: 'notes', row_id: h.row_id, resident_id: h.new_row.resident_id ?? null, record_day: h.new_row.note_on, op: h.op, rev_before: h.old_row.rev, rev_after: h.new_row.rev, old_row: h.old_row, new_row: h.new_row, changed_at: '2026-09-01T00:00:00Z', changed_by_staff: h.new_row.edited_by ?? null }))
        .reverse()
      return { data: rows, error: null, status: 200 }
    }
    return { data: null, error: { code: 'X', message: `unexpected ${q.table} ${q.action}` }, status: 500 }
  })
  const seed = (over = {}) => {
    const row = { ...NC.NOTE_BASE_ROW, id: nextId++, rev: 1, edited_by: null, deleted_at: null, client_key: null, ...over }
    db.notes.push(row)
    return row
  }
  const rpcs = () => fake.calls.filter((q) => q.action === 'rpc' && q.fn === 'apply_note_edits' && q.args?.p_id !== null)
  return { ...fake, db, seed, rpcs }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

async function reset() {
  await settle()
  lsStore.delete('cl_sendQueue')
  lsStore.delete('cl_sendQueue2')
  await DB.__testHooks.restartQueue()
  DB.__testHooks.setClient(null)
  delete globalThis.navigator?.onLine
}

/** 送信待ち・退避のどこかに、その本文が残っているか（端末から取り戻せるか） */
function recoverable(body) {
  const raw = `${lsStore.get('cl_sendQueue') ?? ''}\n${lsStore.get('cl_sendQueue2') ?? ''}`
  return raw.includes(JSON.stringify(body).slice(1, -1))
}

/**
 * 画面が既にある申し送りの本文を保存する時の呼び方（修正前は updateNoteFields・updateNote の rev 照合、
 * 修正後は saveNoteEdits の欄ごとの判定）。base＝編集を始めた時の本文、rev＝保存を押した時に画面が持っていた rev
 */
async function saveBodyLikeScreen(id, rev, base, value) {
  if (typeof DB.saveNoteEdits === 'function') return DB.saveNoteEdits({ id }, { body: { value, base } })
  return DB.updateNoteFields(id, rev, { body: value })
}

// ══════════════════════════════════════════════════════════════

if (DB === null) {
  // 古い Node だけスキップ。それ以外（db.ts に Node で読めない書き方・読み込み時の例外）と CI では失敗にする（F69）
  registerLoadFailure('申し送りの検証', loadError, UNSUPPORTED, { hooks: true })
} else {
  describe('契約: apply_note_edits（JS の写しが契約の表どおり）', () => {
    for (const c of NC.NOTE_CONTRACT_CASES) {
      it(c.name, () => {
        const r = NC.runNoteContractCaseOnFake(c)
        assert.deepEqual(r.mismatches, [])
      })
    }
  })

  describe('★再現（精査 C1・C2・H1・H2・M1・M3）', () => {
    afterEach(reset)

    it('★C1: 日報で既存行を直した時に他の端末が先に直していても、打った本文は端末に残る（再読み込みしても）', async () => {
      const srv = noteServer()
      const row = srv.seed({ body: '本文O' })
      DB.__testHooks.setClient(srv.client)
      // 他の端末が先に直した（rev 2）。この端末の画面はまだ rev 1・本文O を見ている
      row.body = '本文X'
      row.rev = 2
      await saveBodyLikeScreen(row.id, 1, '本文O', '本文A')
      assert.equal(row.body, '本文X', '先の本文を上書きした')
      assert.ok(recoverable('本文A'), '打った本文（本文A）が端末のどこにも残っていない')
      await DB.__testHooks.restartQueue() // 再読み込み・アプリの終了
      assert.ok(recoverable('本文A'), '再読み込みで打った本文が消えた')
    })

    it('★C2: タイムラインで編集中に自動の取り直しで rev だけ新しくなっても、他の端末の本文を上書きしない', async () => {
      const srv = noteServer()
      const row = srv.seed({ body: '本文O' })
      DB.__testHooks.setClient(srv.client)
      // 編集を始めた時は 本文O・rev 1。その間に他の端末が 本文X（rev 2）にし、自動の取り直しで画面の rev が 2 になった
      row.body = '本文X'
      row.rev = 2
      await saveBodyLikeScreen(row.id, 2, '本文O', '本文A')
      assert.equal(row.body, '本文X', '他の端末の本文を黙って上書きした')
      assert.ok(recoverable('本文A'), '打った本文が残っていない')
    })

    it('★H1: 止まった・送信待ちの申し送り（旧ビルドが積んだ blocked を含む）を本文つきで一覧にできる', async () => {
      assert.equal(typeof DB.listUnsentNotes, 'function', '止まった op の中身を見る手段が無い')
      lsStore.set(
        'cl_sendQueue',
        JSON.stringify({
          ops: [
            { qid: 'u1', table: 'notes', kind: 'update', rowId: 30, rev: 1, payload: { body: '本文U' }, blocked: 'conflict', at: 1, tries: 1, nextAt: 0 },
            { qid: 'i1', table: 'notes', kind: 'insert', payload: { note_on: '2026-09-01', shift: 'day', body: '本文I', client_key: 'i1' }, blocked: 'rejected', at: 2, tries: 10, nextAt: 0 },
          ],
        }),
      )
      await DB.__testHooks.restartQueue()
      const list = DB.listUnsentNotes()
      const edit = list.find((x) => x.kind === 'edit')
      const ins = list.find((x) => x.kind === 'insert')
      assert.equal(edit?.row.id, 30)
      assert.equal(edit?.row.state, 'conflict')
      assert.equal(edit?.row.values.body, '本文U')
      assert.equal(ins?.op.state, 'rejected')
      assert.equal(ins?.op.body, '本文I')
    })

    it('★H2: 退避した変更が送れた後、同じ画面から続けて直しても競合にならず、入力も失わない', async () => {
      let off = true
      const srv = noteServer({ offline: () => off })
      const row = srv.seed({ body: '本文O' })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await saveBodyLikeScreen(row.id, 1, '本文O', '本文A'), 'queued')
      off = false
      await DB.flushQueue(true)
      assert.equal(row.body, '本文A', '（前提）退避した変更が送れていない')
      // 画面: 修正前は rev 1 のまま（楽観表示で本文A）。修正後は送れた行を読み直す（fetchNoteRows）
      const shown = typeof DB.fetchNoteRows === 'function' ? (await DB.fetchNoteRows([row.id]))[0] : { body: '本文A', rev: 1 }
      const res = await saveBodyLikeScreen(row.id, shown.rev, shown.body, '本文B')
      assert.notEqual(res, 'conflict', '送れた後の続けての変更が競合になった（入力が消える）')
      assert.equal(row.body, '本文B')
    })

    it('★M1: 登録の応答待ちの間に直した本文・対象・記入者・色を、応答の後に捨てない（登録できた行への変更にする）', () => {
      assert.ok(NE !== null && typeof NE.followUpEdits === 'function', '応答待ちの間の編集を送る仕組みが無い')
      const sent = { body: '本文A', residentId: 1, targetPicked: true, reporterId: 1, color: null }
      const now = { body: '本文A（追記）', residentId: 2, targetPicked: true, reporterId: 2, color: 'pink' }
      const inserted = { body: '本文A', resident_id: 1, reporter_id: 1, color: null }
      assert.deepEqual(NE.followUpEdits(sent, now, inserted), {
        body: { value: '本文A（追記）', base: '本文A' },
        resident_id: { value: 2, base: 1 },
        reporter_id: { value: 2, base: 1 },
        color: { value: 'pink', base: null },
      })
      assert.deepEqual(NE.followUpEdits(sent, { ...sent }, inserted), {}, '直していないのに送る')
      assert.deepEqual(NE.followUpEdits(sent, { ...sent, body: '  ' }, inserted), {}, '空の本文で上書きする')
    })

    it('★M3: 同じ日の書きかけを2つのタブで書いても食い合わない（読み込みは和集合・消すのは自分のタブの分だけ）', () => {
      assert.ok(ND !== null && typeof ND.writeTabRows === 'function', 'タブごとの書きかけの仕組みが無い')
      const rowA = { did: 'a1', at: 10, kind: 'note', data: { body: '本文A' } }
      const rowB = { did: 'b1', at: 11, kind: 'note', data: { body: '本文B' } }
      let file = ND.writeTabRows(null, 'tabA', [rowA], 10)
      file = ND.writeTabRows(file, 'tabB', [rowB], 11)
      assert.deepEqual(ND.unionDraftRows(file).map((r) => r.did), ['a1', 'b1'])
      // タブA が自分の書きかけを全部消しても、タブB の分は残る
      file = ND.writeTabRows(file, 'tabA', [], 12)
      assert.deepEqual(ND.unionDraftRows(file).map((r) => r.did), ['b1'])
    })
  })

  describe('申し送りの送信待ち（saveNoteEdits → apply_note_edits）', () => {
    afterEach(reset)

    it('色だけと本文だけを別々に直しても両方通る（欄ごとの判定）', async () => {
      const srv = noteServer()
      const row = srv.seed({ body: '本文O' })
      DB.__testHooks.setClient(srv.client)
      const a = await DB.saveNoteEdits({ id: row.id }, { color: { value: 'pink', base: null } })
      const b = await DB.saveNoteEdits({ id: row.id }, { body: { value: '本文A', base: '本文O' } })
      assert.equal(a.status, 'applied')
      assert.equal(b.status, 'applied')
      assert.equal(row.color, 'pink')
      assert.equal(row.body, '本文A')
      assert.equal(DB.pendingNoteRow(row.id), null)
    })

    it('競合した本文は送信待ちに「競合」で残り、止まっている間の保存は送らない（held）。〔自分の本文で直す〕で送る', async () => {
      const srv = noteServer()
      const row = srv.seed({ body: '本文X' })
      DB.__testHooks.setClient(srv.client)
      const r1 = await DB.saveNoteEdits({ id: row.id }, { body: { value: '本文A', base: '本文O' } }, { meta: { note_on: '2026-11-01', shift: 'day', resident_id: 1, after16: false } })
      assert.equal(r1.status, 'conflict')
      const p = DB.pendingNoteRow(row.id)
      assert.equal(p.state, 'conflict')
      assert.equal(p.values.body, '本文A')
      assert.deepEqual(p.meta, { note_on: '2026-11-01', shift: 'day', resident_id: 1, after16: false })
      const n = srv.rpcs().length
      const held = await DB.saveNoteEdits({ id: row.id }, { color: { value: 'blue', base: null } })
      assert.equal(held.held, true)
      assert.equal(srv.rpcs().length, n, '止まっている行を送った')
      const r2 = await DB.saveNoteEdits({ id: row.id }, { body: { value: '本文A', base: '本文X' } }, { rebase: true })
      assert.equal(r2.status, 'applied')
      assert.equal(row.body, '本文A')
      assert.equal(row.color, 'blue', '止まっている間に重ねた色も一緒に送る')
      assert.equal(DB.pendingNoteRow(row.id), null)
    })

    it('削除: 見た本文のままなら取り消す／他の端末が本文を直していたら取り消さず競合（本文は残る）', async () => {
      const srv = noteServer()
      const a = srv.seed({ body: '本文O' })
      const b = srv.seed({ body: '本文X' })
      DB.__testHooks.setClient(srv.client)
      const ra = await DB.deleteNote({ id: a.id }, '本文O')
      assert.ok(DB.noteDeleted(ra))
      assert.notEqual(a.deleted_at, null)
      const rb = await DB.deleteNote({ id: b.id }, '本文O')
      assert.equal(DB.noteDeleted(rb), false)
      assert.equal(b.deleted_at, null, '見ていない本文を消した')
      assert.equal(rb.conflicts[0].server, '本文X')
      assert.equal(DB.pendingNoteRow(b.id).state, 'conflict')
    })

    it('相手が削除していた（missing）→ 〔新しい行として保存〕で同じ日・区分・対象に自分を記入者として登録・冪等', async () => {
      const srv = noteServer()
      const row = srv.seed({ body: '本文O', resident_id: 2, shift: 'night', note_on: '2026-11-02', deleted_at: '2026-11-02T00:00:00Z' })
      DB.__testHooks.setClient(srv.client)
      const r = await DB.saveNoteEdits({ id: row.id }, { body: { value: '本文A', base: '本文O' } })
      assert.equal(r.conflicts[0].reason, 'missing')
      const meta = await DB.resolveNoteMeta(row.id)
      assert.equal(meta, null, '（前提）控えの無い行は、取り消された行を読まない（全読取は生きている行だけ）')
      const meta2 = { note_on: '2026-11-02', shift: 'night', resident_id: 2, after16: false }
      const key = DB.noteAsNewKey(row.id, DB.pendingNoteRow(row.id).vers.body)
      const n1 = await DB.insertNoteAsNew({ key, meta: meta2, body: '本文A', reporterId: 2 })
      const n2 = await DB.insertNoteAsNew({ key, meta: meta2, body: '本文A', reporterId: 2 })
      assert.equal(n1.id, n2.id, '押し直しで2行できた')
      assert.equal(n1.reporter_id, 2)
      assert.equal(n1.shift, 'night')
      assert.equal(srv.db.notes.filter((x) => x.deleted_at === null).length, 1)
    })

    it('旧ビルドが積んだ申し送りの変更（rev つき）は、送る前に1行読み、rev が同じなら基準を埋めて送る', async () => {
      const srv = noteServer()
      const row = srv.seed({ body: '本文O', importance: 'normal' })
      lsStore.set('cl_sendQueue', JSON.stringify({ ops: [{ qid: 'u2', table: 'notes', kind: 'update', rowId: row.id, rev: 1, payload: { body: '本文A', edited_by: 1 }, at: 1, tries: 0, nextAt: 0 }] }))
      await DB.__testHooks.restartQueue()
      assert.deepEqual(JSON.parse(lsStore.get('cl_sendQueue')).ops, [], '読み替えた op を cl_sendQueue に残した')
      assert.ok(JSON.parse(lsStore.get('cl_sendQueue2')).rows[`notes#${row.id}`], 'cl_sendQueue2 に移っていない')
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(row.body, '本文A')
      assert.equal(row.edited_by, 1)
      assert.equal(DB.pendingNoteRow(row.id), null)
    })

    it('旧ビルドが積んだ変更の rev が合わない（他の端末が直した）→ 本文を上書きせず競合として残る', async () => {
      const srv = noteServer()
      const row = srv.seed({ body: '本文X', rev: 3 })
      lsStore.set('cl_sendQueue', JSON.stringify({ ops: [{ qid: 'u3', table: 'notes', kind: 'update', rowId: row.id, rev: 1, payload: { body: '本文A' }, at: 1, tries: 0, nextAt: 0 }] }))
      await DB.__testHooks.restartQueue()
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(row.body, '本文X')
      assert.equal(DB.pendingNoteRow(row.id).state, 'conflict')
      assert.equal(DB.pendingNoteRow(row.id).values.body, '本文A')
    })

    it('cl_sendQueue2 に書けない時は、旧形式の op を cl_sendQueue から外さない（移す前に消さない）', async () => {
      const ops = [{ qid: 'u4', table: 'notes', kind: 'update', rowId: 9, rev: 1, payload: { body: '本文A' }, at: 1, tries: 0, nextAt: 0 }]
      lsStore.set('cl_sendQueue', JSON.stringify({ ops }))
      const realSet = globalThis.localStorage.setItem
      globalThis.localStorage.setItem = (k, v) => {
        if (k === 'cl_sendQueue2') throw new Error('quota')
        lsStore.set(k, String(v))
      }
      try {
        await DB.__testHooks.restartQueue()
      } finally {
        globalThis.localStorage.setItem = realSet
      }
      assert.equal(JSON.parse(lsStore.get('cl_sendQueue')).ops[0].qid, 'u4')
    })

    it('登録を待つ申し送りの取り下げ・送り直し（同じ冪等キー）', async () => {
      let off = true
      const srv = noteServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      const base = { note_on: '2026-11-01', shift: 'day', facility: null, category: null, resident_id: 1, role_tags: [], importance: 'normal', occurred_at: null, ongoing: false, ended_at: null, reporter_id: 1, color: null, after16: false }
      assert.equal(await DB.insertNote({ ...base, body: '本文P' }), 'queued')
      assert.equal(await DB.insertNote({ ...base, body: '本文Q' }), 'queued')
      const ins = DB.listUnsentNotes().filter((x) => x.kind === 'insert')
      assert.deepEqual(ins.map((x) => x.op.body), ['本文P', '本文Q'])
      await DB.discardQueuedNoteInsert(ins[0].op.qid)
      off = false
      assert.equal(await DB.resendQueuedNoteInsert(ins[1].op.qid), 'sent')
      assert.deepEqual(srv.db.notes.map((x) => x.body), ['本文Q'])
      assert.equal(DB.listUnsentNotes().length, 0)
    })

    it('0017 が無い DB でも rev 照合の旧経路へは落とさない（送信待ちに積む）', async () => {
      const srv = noteServer({ missing: true })
      srv.seed({ body: '本文O' })
      DB.__testHooks.setClient(srv.client, { noteRpc: null })
      assert.equal(await DB.saveNoteEdits({ id: 500 }, { body: { value: '本文A', base: '本文O' } }), 'queued')
      assert.equal(srv.calls.filter((q) => q.action === 'update').length, 0, 'rev 照合の旧経路で書いた')
      const g = await DB.getNativeInputGate()
      assert.equal(g.notes, 'missing')
    })

    it('変更の記録は行 id で引く（全体連絡も）', async () => {
      const srv = noteServer()
      const row = srv.seed({ body: '本文O', resident_id: null })
      DB.__testHooks.setClient(srv.client)
      await DB.saveNoteEdits({ id: row.id }, { body: { value: '本文A', base: '本文O' } })
      const h = await DB.fetchNoteHistory(row.id)
      assert.equal(h.available, true)
      assert.equal(h.entries.length, 1)
      assert.equal(h.entries[0].old_row.body, '本文O')
      const q = srv.calls.find((c) => c.table === 'record_history')
      assert.deepEqual(eqOf(q), { table_name: 'notes', row_id: row.id })
    })

    it('カルテの利用者別の変更の記録は old_row の resident_id でも引く（対象を付け替えた記録を元の側から辿る）', async () => {
      const srv = noteServer()
      DB.__testHooks.setClient(srv.client)
      await DB.fetchRecordHistory({ residentId: 3, fromIso: '2026-09-01', toIso: '2026-09-14' })
      const q = srv.calls.find((c) => c.table === 'record_history')
      assert.deepEqual(q.filters.find((f) => f[0] === 'or'), ['or', 'resident_id.eq.3,old_row->>resident_id.eq.3'])
    })
  })

  // ══════════════════════════════════════════════════════════════
  // 反証レビューの修正依頼（2026-09-29 第2巡）。修正前の版で赤・修正後で緑
  // ══════════════════════════════════════════════════════════════
  describe('★修正依頼（反証レビュー 1〜7・leaveGuard）', () => {
    afterEach(reset)

    /** 旧ビルド（HEAD）の cl_sendQueue2 の読み書きの写し: バイタル・食事以外の行は読めずに brokenRaw へ畳み、rows から外して書き戻す */
    function headRoundTripQueue2() {
      const box = JSON.parse(lsStore.get('cl_sendQueue2'))
      const rows = {}
      let broken = typeof box.brokenRaw === 'string' ? box.brokenRaw : null
      for (const [k, v] of Object.entries(box.rows ?? {})) {
        if (v && (v.table === 'vitals' || v.table === 'meals')) {
          rows[k] = v
          continue
        }
        const raw = JSON.stringify(v)
        broken = broken === null ? raw : broken.includes(raw) ? broken : `${broken}\n${raw}`
      }
      const out = { ver: 2, rows, done: box.done ?? [] }
      if (broken !== null) out.brokenRaw = broken
      lsStore.set('cl_sendQueue2', JSON.stringify(out))
    }
    /** 新しいビルドが cl_sendQueue2 に書く申し送りの送信待ち（止まった競合・本文つき） */
    const noteEntry = (id, body, ver) => ({
      table: 'notes',
      key: { id },
      edits: { body: { value: body, base: '本文O', at: 5, ver } },
      fill: {},
      editor: 2,
      meta: { note_on: '2026-11-01', shift: 'day', resident_id: 1, after16: false },
      state: 'conflict',
      conflicts: [{ field: 'body', server: '本文X', base: '本文O', mine: body, reason: 'changed' }],
      tries: 0,
      nextAt: 0,
      tab: 'tNEW',
      at: 5,
      bound: true,
    })

    it('★修正2: 0017 が無い DB でも保存済みの申し送りの変更を捨てずに送信待ちに積み、関数が入り次第送る', async () => {
      let missing = true
      const srv = noteServer({ missing: () => missing })
      const row = srv.seed({ body: '本文O' })
      DB.__testHooks.setClient(srv.client, { noteRpc: null })
      const res = await DB.saveNoteEdits({ id: row.id }, { body: { value: '本文A', base: '本文O' } })
      assert.equal(res, 'queued', '関数が無い間の入力を拒否した（打った本文が捨てられる）')
      assert.equal(DB.pendingNoteRow(row.id)?.values.body, '本文A', '送信待ちに残っていない')
      assert.equal(DB.isNoteRpcMissing(), true)
      await DB.__testHooks.restartQueue()
      assert.equal(DB.pendingNoteRow(row.id)?.values.body, '本文A', '再読み込みで消えた')
      DB.__testHooks.setClient(srv.client)
      missing = false
      await DB.flushQueue(true)
      assert.equal(row.body, '本文A', '関数が入った後に送られていない')
      assert.equal(DB.pendingNoteRow(row.id), null)
    })

    it('★修正3: 旧ビルドが申し送りの送信待ちを brokenRaw へ畳んでも、読み込み時に救い出して送信待ちへ戻す（書き戻して確かめてから外す）', async () => {
      lsStore.set('cl_sendQueue2', JSON.stringify({ ver: 2, rows: { 'notes#41': noteEntry(41, '本文B（旧ビルドの前に打った）', 'tNEW.1') }, done: [] }))
      headRoundTripQueue2() // 旧ビルドで開いて書き戻した
      assert.ok(!JSON.parse(lsStore.get('cl_sendQueue2')).rows['notes#41'], '（前提）旧ビルドは rows から外す')
      await DB.__testHooks.restartQueue()
      await DB.flushQueue() // 書き戻しの機会
      const box = JSON.parse(lsStore.get('cl_sendQueue2'))
      assert.equal(box.rows['notes#41']?.edits?.body?.value, '本文B（旧ビルドの前に打った）', '救い出されず rows に戻っていない（回収できない）')
      assert.ok(!(box.brokenRaw ?? '').includes('本文B'), '救い出した行が brokenRaw に残っている')
    })

    it('★修正3: 救い出した行を書き戻せない時は、保存先の brokenRaw をそのまま残す（外す前に確かめる）', async () => {
      lsStore.set('cl_sendQueue2', JSON.stringify({ ver: 2, rows: { 'notes#42': noteEntry(42, '本文C', 'tNEW.2') }, done: [] }))
      headRoundTripQueue2()
      const before = lsStore.get('cl_sendQueue2')
      const realSet = globalThis.localStorage.setItem
      globalThis.localStorage.setItem = (k, v) => {
        if (k === 'cl_sendQueue2') throw new Error('quota')
        lsStore.set(k, String(v))
      }
      try {
        await DB.__testHooks.restartQueue()
      } finally {
        globalThis.localStorage.setItem = realSet
      }
      assert.equal(lsStore.get('cl_sendQueue2'), before, '書けないのに保存先を書き換えた')
      assert.ok(before.includes('本文C'))
    })

    it('★修正3: 同じ申し送りに新しい入力がある時は、救い出した本文も別に残す（一覧で新しい行として登録できる）', async () => {
      lsStore.set('cl_sendQueue2', JSON.stringify({ ver: 2, rows: { 'notes#43': noteEntry(43, '本文D（旧ビルドの前）', 'tNEW.3') }, done: [] }))
      headRoundTripQueue2()
      const box = JSON.parse(lsStore.get('cl_sendQueue2'))
      box.rows['notes#43'] = noteEntry(43, '本文E（戻した後に打った）', 'tNEW.9')
      lsStore.set('cl_sendQueue2', JSON.stringify(box))
      await DB.__testHooks.restartQueue()
      assert.equal(DB.pendingNoteRow(43)?.values.body, '本文E（戻した後に打った）')
      const rescued = (DB.listUnsentNotes?.() ?? []).find((u) => u.kind === 'rescued')
      assert.equal(rescued?.row.values.body, '本文D（旧ビルドの前）', '救い出した本文が一覧に出ない（どちらかが消える）')
      const srv = noteServer()
      DB.__testHooks.setClient(srv.client)
      await DB.insertNoteAsNew({ key: DB.noteAsNewKey(43, rescued.row.vers.body), meta: rescued.row.meta, body: rescued.row.values.body, reporterId: 2 })
      await DB.dropRescuedNote(rescued.raw)
      assert.equal(srv.db.notes.filter((n) => n.body === '本文D（旧ビルドの前）').length, 1)
      assert.equal(DB.listUnsentNotes().filter((u) => u.kind === 'rescued').length, 0)
      assert.ok(!(JSON.parse(lsStore.get('cl_sendQueue2')).brokenRaw ?? '').includes('本文D'))
    })

    it('★修正5: 送信待ちの本文 P を出している時に元の本文 S へ打ち直したら送る（S で P を置き換える）', () => {
      assert.equal(typeof NE?.shouldSendBody, 'function', '表示中の本文と比べる仕組みが無い')
      assert.equal(NE.shouldSendBody('本文S', '本文S', { body: '本文P' }), true, '元の本文へ戻す編集を捨てた')
      assert.equal(NE.shouldSendBody('本文P', '本文S', { body: '本文P' }), false)
      assert.equal(NE.shouldSendBody('本文S', '本文S', null), false)
    })

    it('★修正6: 別のタブの書きかけを引き継いでも、元のタブが後から直した入力は和集合から外れない（重複は許す・消さない）', () => {
      assert.equal(typeof ND?.adoptDraftRows, 'function', '引き継ぐ時に新しい印を振る仕組みが無い')
      const a1 = { did: 'a1', at: 10, kind: 'form', data: { body: '元のタブ' } }
      let file = ND.writeTabRows(null, 'tabA', [a1], 10)
      const [copy] = ND.adoptDraftRows(ND.unionDraftRows(file))
      assert.notEqual(copy.did, 'a1', '同じ印を共有した')
      file = ND.writeTabRows(file, 'tabB', [copy], 11)
      assert.deepEqual(ND.unionDraftRows(file).map((r) => r.data.body), ['元のタブ'], '引き継いだ版を二重に出した')
      // 元のタブが後から直す
      file = ND.writeTabRows(file, 'tabA', [{ ...a1, at: 20, data: { body: '元のタブ（後から追記）' } }], 20)
      // 引き継いだタブが送信・破棄した
      file = ND.markDraftsGone(ND.writeTabRows(file, 'tabB', [], 21), ND.goneMarksFor([copy], 21), 21)
      assert.deepEqual(ND.unionDraftRows(file).map((r) => r.data.body), ['元のタブ（後から追記）'], '元のタブの後の入力が消えた')
    })

    it('★修正6: 印（登録済み・破棄済み）はその時刻までの版だけを外す（後から直された版は外さない）', () => {
      let file = ND.writeTabRows(null, 'tabA', [{ did: 'x', at: 10, kind: 'form', data: { body: '古い' } }], 10)
      file = ND.markDraftsGone(file, [{ did: 'x', at: 10 }], 15)
      assert.deepEqual(ND.unionDraftRows(file), [])
      file = ND.writeTabRows(file, 'tabA', [{ did: 'x', at: 20, kind: 'form', data: { body: '新しい' } }], 20)
      assert.deepEqual(ND.unionDraftRows(file).map((r) => r.data.body), ['新しい'], '後から直した版を外した')
    })

    it('leaveGuard: 止まっているのが送れていない申し送りだけなら、事実どおりの文言（端末に残る）を出す', async () => {
      const LG = await import(new URL('lib/leaveGuard.ts', SRC).href)
      assert.equal(typeof LG.unsavedOnlyNotes, 'function', '申し送りだけの時の出し分けが無い')
      const off1 = LG.registerUnsaved(() => true, 'notes')
      assert.equal(LG.unsavedOnlyNotes(), true)
      assert.match(LG.LEAVE_BODY_NOTES, /この端末に残ります/)
      assert.doesNotMatch(LG.LEAVE_BODY_NOTES, /破棄されます/)
      const off2 = LG.registerUnsaved(() => true)
      assert.equal(LG.unsavedOnlyNotes(), false, 'バイタル等の入力がある時は従来の文言')
      off1()
      off2()
      assert.match(LG.LEAVE_BODY, /破棄されます/, 'バイタル・食事の文言を変えた')
      assert.match(read('App.tsx'), /unsavedOnlyNotes\(\) \? LEAVE_BODY_NOTES : LEAVE_BODY/)
    })

    it('★L2: 冪等キーで探す時、読み取りの失敗を「無い」と取り違えない（届いたか分からない＝undefined）', async () => {
      const srv = noteServer({ readError: () => true })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.findNoteByClientKey('ck-l2'), undefined, '読めなかったのに「届いていない」とした（押し直しで別の行ができる）')
      const srv2 = noteServer()
      DB.__testHooks.setClient(srv2.client)
      assert.equal(await DB.findNoteByClientKey('ck-l2'), null)
    })

    it('★L1: 確定しないまま外れた打ちかけも、画面に出している本文（送信待ちを重ねた値）と比べて送るかを決める', () => {
      const src = read('pages/DailySheetPage.tsx')
      const fn = src.slice(src.indexOf('const abandonNoteBody = useCallback('), src.indexOf('/** 下書き行の保存（本文が入った時点で1回だけ insert する） */'))
      assert.doesNotMatch(fn, /text !== note\.body/, 'サーバーの本文と比べている（送信待ちの本文 P を出している時に元の本文 S へ戻す打ちかけを捨てる）')
      assert.equal((fn.match(/shouldSendBody\(value, note\.body, pendingNotesRef\.current\.get\(note\.id\)\?\.values\)/g) ?? []).length, 2)

    })

    const baseNote = { note_on: '2026-11-01', shift: 'day', facility: null, category: null, resident_id: 1, role_tags: [], importance: 'normal', occurred_at: null, ongoing: false, ended_at: null, reporter_id: 1, color: null, after16: false }

    // ── 第3巡（チーフ裁定）: 登録の op は書き換えず、登録後の変更は notes#ck:<client_key> に積む ──
    const regBase = { note_on: '2026-11-01', shift: 'day', facility: null, category: null, resident_id: 1, role_tags: [], importance: 'normal', occurred_at: null, ongoing: false, ended_at: null, reporter_id: 1, color: null, after16: false }
    /**
     * 登録を押した後の本文の変更（画面が行う操作の写し）。新しい版は notes#ck に積む（stageNoteEdits）。
     * 修正前の版は、画面の carryIntoInsert と同じ順で、送信待ちの登録の書き換え → 届いた行を探して変更 → 確かめ待ち
     */
    async function editAfterRegistration(ck, value, seen, payload, sentBody = '本文B1') {
      if (typeof DB.stageNoteEdits === 'function') return DB.stageNoteEdits({ clientKey: ck }, { body: { value, base: seen } })
      if (await DB.amendQueuedNoteInsert(ck, { body: value })) return true
      const found = await DB.findNoteByClientKey(ck)
      if (found) {
        // 修正前の画面（carryIntoInsert の届いていた分岐）は、基準を登録で送った値にしていた
        await DB.saveNoteEdits({ id: found.id }, { body: { value, base: sentBody } })
        return true
      }
      if (found === undefined && DB.verifyNoteRegistration) {
        await DB.verifyNoteRegistration(ck, { ...payload, body: value }, { body: seen })
        return true
      }
      return false // 修正前の画面は書きかけに戻す（送られない）
    }

    it('★C3-1(a): 登録 B1 の送信中に B2 へ直し、B1 が届いて応答だけ失われても、サーバーは B2 で1行', async () => {
      let release
      const held = new Promise((r) => (release = r))
      let lost = true
      const srv = noteServer({ hold: () => held, lostResponse: () => lost })
      DB.__testHooks.setClient(srv.client)
      const inflight = DB.insertNote({ ...regBase, body: '本文B1' }, { clientKey: 'ck-c31a' })
      await settle()
      await editAfterRegistration('ck-c31a', '本文B2', '本文B1', regBase) // 送信中に直す
      release()
      assert.equal(await inflight, 'queued') // 届いたが応答が失われた
      lost = false
      await DB.flushQueue(true)
      await DB.flushQueue(true)
      await settle()
      assert.deepEqual(srv.db.notes.map((n) => n.body), ['本文B2'], '直した本文が載っていない／行が2つある')
    })

    it('★C3-1(b): 送信待ちの登録 B1 の後に B2 へ直す → 再送 → サーバーは B2 で1行（B2 が消えない）', async () => {
      let off = true
      const srv = noteServer({ offline: () => off, failInsertIf: (q) => q.payload.body === '本文B2' })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.insertNote({ ...regBase, body: '本文B1' }, { clientKey: 'ck-c31b' }), 'queued')
      off = false
      // 直す（修正前の版は「確かめ待ち」の確かめ直しと同じ手順＝同じ冪等キーで B2 を直接登録しようとし、一時的な失敗で
      // 同じ qid の登録が2本並ぶ。新しい版は notes#ck に積む）
      if (typeof DB.stageNoteEdits === 'function') await DB.stageNoteEdits({ clientKey: 'ck-c31b' }, { body: { value: '本文B2', base: '本文B1' } })
      else await DB.verifyNoteRegistration('ck-c31b', { ...regBase, body: '本文B2' }, { body: '本文B1' })
      await DB.flushQueue(true)
      await DB.flushQueue(true)
      await settle()
      const rows = srv.db.notes.filter((n) => n.client_key === 'ck-c31b').map((n) => n.body)
      const kept = rows.includes('本文B2') || DB.listUnsentNotes().some((u) => (u.kind === 'insert' ? u.op.body : u.row.values.body) === '本文B2')
      assert.ok(kept, `B2 が消えた（サーバー: ${JSON.stringify(rows)}）`)
      assert.deepEqual(rows, ['本文B2'])
    })

    it('★C3-2: 登録後の変更は端末に積んでから書きかけを外す（積む途中で再読み込みしても B2 が端末に残る）', async () => {
      assert.equal(typeof DB.stageNoteEdits, 'function', '登録後の変更を積む仕組みが無い')
      DB.__testHooks.setClient(noteServer({ offline: () => true }).client)
      assert.equal(await DB.insertNote({ ...regBase, body: '本文B1' }, { clientKey: 'ck-c32' }), 'queued')
      assert.equal(await DB.stageNoteEdits({ clientKey: 'ck-c32' }, { body: { value: '本文B2', base: '本文B1' } }), true)
      await DB.__testHooks.restartQueue() // 再読み込み
      assert.equal(DB.pendingNoteRow({ clientKey: 'ck-c32' })?.values.body, '本文B2')
      const src = read('pages/DailySheetPage.tsx')
      const fn = src.slice(src.indexOf('const saveNoteDraft = useCallback('), src.indexOf('const commitNoteBody = useCallback('))
      assert.ok(fn.indexOf('await stageNoteEdits({ id: res.id }') < fn.indexOf('setNoteDrafts((prev) => prev.filter((d) => d.key !== key))'), '書きかけを外してから積んでいる')
      assert.doesNotMatch(src, /amendQueuedNoteInsert\(|verifyNoteRegistration\(|carryIntoInsert|verifyKey:/, '継ぎ当ての経路が残っている')
    })

    it('★C3-3: 応答だけ失われた登録を2回直す（B2→B3）→ サーバーは B3（自分どうしで競合しない）', async () => {
      let lost = true
      const srv = noteServer({ lostResponse: () => lost })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.insertNote({ ...regBase, body: '本文B1' }, { clientKey: 'ck-c33' }), 'queued')
      lost = false
      await DB.flushQueue(true) // 再送 → 既に届いている
      await editAfterRegistration('ck-c33', '本文B2', '本文B1', regBase)
      await DB.flushQueue(true)
      await settle()
      await editAfterRegistration('ck-c33', '本文B3', '本文B2', regBase)
      await DB.flushQueue(true)
      await DB.flushQueue(true)
      await settle()
      assert.deepEqual(srv.db.notes.map((n) => n.body), ['本文B3'], '2回目の変更が自分の1回目と競合して止まった')
      assert.equal(DB.listUnsentNotes().length, 0, '自分の入力どうしで競合として止まった')
    })

    it('★第3巡(5): 登録が恒久的に拒否された → 一覧に登録＋変更の本文で出て〔新しい行として登録〕で1行登録', async () => {
      assert.equal(typeof DB.registerQueuedInsertAsNew, 'function', '登録できなかった申し送りを新しい行として登録する仕組みが無い')
      lsStore.set('cl_sendQueue', JSON.stringify({ ops: [{ qid: 'ck-rej', table: 'notes', kind: 'insert', payload: { ...regBase, body: '本文R1', client_key: 'ck-rej' }, blocked: 'rejected', at: 1, tries: 10, nextAt: 0 }] }))
      await DB.__testHooks.restartQueue()
      DB.__testHooks.setClient(noteServer({ offline: () => true }).client)
      await DB.stageNoteEdits({ clientKey: 'ck-rej' }, { body: { value: '本文R2（登録後に直した）', base: '本文R1' } })
      const item = DB.listUnsentNotes().find((u) => u.kind === 'insert')
      assert.equal(item?.op.state, 'rejected')
      assert.equal(item?.op.body, '本文R2（登録後に直した）', '一覧に登録後の変更を重ねて出していない')
      assert.equal(DB.listUnsentNotes().length, 1, '変更が別の行として二重に出る')
      const srv = noteServer()
      DB.__testHooks.setClient(srv.client)
      await DB.registerQueuedInsertAsNew('ck-rej')
      await DB.registerQueuedInsertAsNew('ck-rej').catch(() => undefined) // 押し直し
      assert.deepEqual(srv.db.notes.map((n) => n.body), ['本文R2（登録後に直した）'])
      assert.equal(DB.listUnsentNotes().length, 0)
    })

    it('★第3巡(6): 別のタブ2つで同じ送信待ちの登録の行を直しても、両方の本文が消えない（片方は競合として残る）', async () => {
      assert.equal(typeof DB.stageNoteEdits, 'function', '登録後の変更を積む仕組みが無い')
      const srv = noteServer()
      srv.seed({ body: '本文B1', client_key: 'ck-tab' }) // 登録は届いている
      // 別のタブが先に B2 を積んだ（このタブはそれを見ていない）
      lsStore.set('cl_sendQueue2', JSON.stringify({ ver: 2, done: [], rows: { 'notes#ck:ck-tab': { table: 'notes', key: { client_key: 'ck-tab' }, edits: { body: { value: '本文B2（タブA）', base: '本文B1', at: 1, ver: 'tOTHER.1' } }, fill: {}, editor: 1, state: 'pending', tries: 0, nextAt: 0, tab: 'tOTHER', at: 1, bound: true } } }))
      await DB.__testHooks.restartQueue()
      DB.__testHooks.setClient(noteServer({ offline: () => true }).client)
      // このタブは B1 を見たまま B3 を打った
      await DB.stageNoteEdits({ clientKey: 'ck-tab' }, { body: { value: '本文B3（タブB）', base: '本文B1' } })
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      await DB.flushQueue(true)
      await settle()
      const server = srv.db.notes[0].body
      const kept = DB.listUnsentNotes().flatMap((u) => (u.kind === 'insert' ? [u.op.body] : [u.row.values.body]))
      const all = [server, ...kept]
      assert.ok(all.includes('本文B2（タブA）') && all.includes('本文B3（タブB）'), `片方の本文が消えた: ${JSON.stringify(all)}`)
      assert.ok(DB.listUnsentNotes().some((u) => u.kind === 'edit' && u.row.state === 'conflict'), '食い違いとして残っていない')
    })

    it('★第3巡: 旧ビルドへ戻して畳まれた登録後の変更（notes#ck:）も救い出す', async () => {
      lsStore.set('cl_sendQueue2', JSON.stringify({ ver: 2, done: [], rows: {}, brokenRaw: JSON.stringify({ table: 'notes', key: { client_key: 'ck-rb' }, edits: { body: { value: '本文K2', base: '本文K1', at: 1, ver: 'tX.1' } }, fill: {}, editor: 1, state: 'pending', tries: 0, nextAt: 0, tab: 'tX', at: 1, bound: true }) }))
      await DB.__testHooks.restartQueue()
      assert.equal(DB.pendingNoteRow?.({ clientKey: 'ck-rb' })?.values.body, '本文K2')
    })

    it('★第3巡: 前の版が書いた「確かめ待ち」の印つきの書きかけも、普通の書きかけとして読める（旧 v:1 の読み手も読める形）', () => {
      const src = read('pages/DailySheetPage.tsx')
      assert.match(src, /前の版が書いた「確かめ待ち」の印（verifyKey 等）は読まない＝普通の書きかけとして戻す/)
    })

    // ── 第4巡 R4-2: 送り先の登録が無くなった登録後の変更（notes#ck:・分けて持つ入力 !<印>） ──
    const ckEntry = (ck, fork, value, base, tab = 'tOTHER') => ({
      table: 'notes', key: fork ? { client_key: ck, fork } : { client_key: ck },
      edits: { body: { value, base, at: 1, ver: `${tab}.${fork ?? 'm'}` } }, fill: {}, editor: 1, state: 'pending', tries: 0, nextAt: 0, tab, at: 1, bound: true,
    })

    it('★R4-2(a): 〔新しい行として登録〕は分けて持つ入力（!<印>）も新しい行への変更として移す（食い違えば〔くらべて選ぶ〕に出る・消さない）', async () => {
      lsStore.set('cl_sendQueue', JSON.stringify({ ops: [{ qid: 'ck-f', table: 'notes', kind: 'insert', payload: { ...regBase, body: '本文F1', client_key: 'ck-f' }, blocked: 'rejected', at: 1, tries: 10, nextAt: 0 }] }))
      lsStore.set('cl_sendQueue2', JSON.stringify({ ver: 2, done: [], rows: {
        'notes#ck:ck-f': ckEntry('ck-f', undefined, '本文F2（本体）', '本文F1', 'tME'),
        'notes#ck:ck-f!x1': ckEntry('ck-f', 'x1', '本文F3（別のタブ）', '本文F1'),
      } }))
      await DB.__testHooks.restartQueue()
      const srv = noteServer()
      DB.__testHooks.setClient(srv.client)
      await DB.registerQueuedInsertAsNew('ck-f')
      await DB.flushQueue(true)
      await DB.flushQueue(true)
      await settle()
      assert.deepEqual(srv.db.notes.map((n) => n.body), ['本文F2（本体）'])
      const f3 = DB.listUnsentNotes().find((u) => u.kind === 'edit' && u.row.values.body === '本文F3（別のタブ）')
      assert.ok(f3, '別のタブの入力が消えた')
      assert.ok(f3.row.id > 0 && f3.row.state === 'conflict', `新しい行への変更として〔くらべて選ぶ〕に出ていない（id=${f3.row.id} state=${f3.row.state}）`)
    })

    it('★R4-2(b): 〔取り下げ〕は一覧で見せた版だけを外す（見せた後に積まれた本体の変更・分けて持つ入力は残り、止まっている件として出る）', async () => {
      lsStore.set('cl_sendQueue', JSON.stringify({ ops: [{ qid: 'ck-d', table: 'notes', kind: 'insert', payload: { ...regBase, body: '本文D1', client_key: 'ck-d' }, at: 1, tries: 0, nextAt: 0 }] }))
      lsStore.set('cl_sendQueue2', JSON.stringify({ ver: 2, done: [], rows: {
        'notes#ck:ck-d': ckEntry('ck-d', undefined, '本文D2', '本文D1', 'tME'),
        'notes#ck:ck-d!x2': ckEntry('ck-d', 'x2', '本文D3（別のタブ）', '本文D1'),
      } }))
      await DB.__testHooks.restartQueue()
      DB.__testHooks.setClient(noteServer({ offline: () => true }).client)
      const shown = DB.listUnsentNotes().find((u) => u.kind === 'insert')
      assert.equal(shown?.op.body, '本文D2')
      // 一覧を見た後に、別のタブが本体へ D2b を積んだ
      await DB.stageNoteEdits({ clientKey: 'ck-d' }, { body: { value: '本文D2b（見せた後）', base: '本文D1' } })
      await DB.discardQueuedNoteInsert('ck-d', shown.op.changes?.vers ?? {})
      const srv = noteServer()
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      await settle()
      const left = DB.listUnsentNotes()
      const bodies = left.flatMap((u) => (u.kind === 'insert' ? [u.op.body] : [u.row.values.body]))
      assert.ok(bodies.includes('本文D2b（見せた後）'), `見せていない本体の変更まで外した: ${JSON.stringify(bodies)}`)
      assert.ok(bodies.includes('本文D3（別のタブ）'), `分けて持つ入力を外した: ${JSON.stringify(bodies)}`)
      assert.ok(left.every((u) => u.kind === 'edit' && u.row.state !== 'pending'), `送り先の無い変更が「送信待ち」のまま: ${JSON.stringify(left.map((u) => u.kind === 'edit' ? u.row.state : u.kind))}`)
    })

    it('★R4-2(c): 送り先の登録が送信待ちにもサーバーにも無い notes#ck: は、止まっている件にして照会を止める（消さない）', async () => {
      lsStore.set('cl_sendQueue2', JSON.stringify({ ver: 2, done: [], rows: { 'notes#ck:ck-o': ckEntry('ck-o', undefined, '本文O2', '本文O1', 'tME') } }))
      await DB.__testHooks.restartQueue()
      let reads = 0
      const srv = noteServer({ readError: (q) => { if (q.filters.some((f) => f[1] === 'client_key')) reads += 1; return false } })
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      await settle()
      const first = reads
      await DB.flushQueue(true)
      await DB.flushQueue(true)
      await settle()
      const row = DB.pendingNoteRow({ clientKey: 'ck-o' })
      assert.equal(row?.values.body, '本文O2', '消えた')
      assert.equal(row?.state, 'rejected', `止まっている件になっていない（${row?.state}）`)
      assert.equal(reads, first, `照会が続いている（${first} → ${reads}）`)
      const persisted = JSON.parse(lsStore.get('cl_sendQueue2'))
      assert.equal(persisted.rows['notes#ck:ck-o']?.state, 'rejected', '止まった印が端末に残っていない（再読み込みで照会が再開する）')
    })

    it('★R4-2(d): 送り先の無い登録後の変更は、一覧で事実どおりの文言になる（「自動で送信」と言わない）', () => {
      const src = read('components/UnsentNotes.tsx')
      assert.match(src, /u\.row\.ck !== undefined && u\.row\.state === 'rejected'/)
    })

    it('★二重登録の余地: 本文の確定・対象/記入者の選択は、書きかけと行を控え（ref）から読み、書きかけを外す・直す時は控えも同時に直す', () => {
      const src = read('pages/DailySheetPage.tsx')
      const commit = src.slice(src.indexOf('const commitNoteBody = useCallback('), src.indexOf('const deleteNoteRow = useCallback('))
      assert.match(commit, /noteDraftsRef\.current\.find\(\(d\) => d\.key === key\)/)
      assert.match(commit, /notesRef\.current\.find\(/)
      assert.doesNotMatch(commit, /\bnoteDrafts\.find\(|\bnotes\.find\(/, '描画の時点の書きかけ・行を読んでいる')
      const picks = src.slice(src.indexOf('const onPickResident = useCallback('), src.indexOf('const onPickStaff = useCallback(') + 1500)
      assert.doesNotMatch(picks, /\bnoteDrafts\.find\(|\bnotes\.find\(/, 'ピッカーが描画の時点の書きかけ・行を読んでいる')
      const patch = src.slice(src.indexOf('const patchNoteDraft = useCallback('), src.indexOf('const patchNote = useCallback('))
      assert.match(patch, /noteDraftsRef\.current = noteDraftsRef\.current\.map\(/)
      assert.match(src, /noteDraftsRef\.current = noteDraftsRef\.current\.filter\(\(d\) => d\.key !== key\)\n\s+setNoteDrafts\(\(prev\) => prev\.filter\(\(d\) => d\.key !== key\)\)/)
    })

    it('★第5巡: 本文の確定・打ちかけの受け取りに「行が無ければ捨てる」分岐が無い（宛先へ積むか、書きかけの控えに残す）', () => {
      const src = read('pages/DailySheetPage.tsx')
      const commit = src.slice(src.indexOf('const commitNoteBody = useCallback('), src.indexOf('const deleteNoteRow = useCallback('))
      const abandon = src.slice(src.indexOf('const abandonNoteBody = useCallback('), src.indexOf('const patchDraftOrRegistration = useCallback('))
      assert.doesNotMatch(commit, /if \(!note\) return/, '行が見つからない時に捨てている')
      assert.match(commit, /keepNoteBody\(key, value, base \?\? saved\?\.body\)/)
      assert.ok((abandon.match(/keepNoteBody\(/g) ?? []).length >= 3, '打ちかけの行き先の無い分岐がある')
      assert.match(abandon, /keepNoteDraftRow\(day, \{ \.\.\.draft, body: value \}\)/, '画面が閉じる途中の書きかけを控えに残していない')
      const keep = src.slice(src.indexOf('const keepNoteBody = useCallback('), src.indexOf('const abandonNoteBody = useCallback('))
      for (const dest of [/stage\(\{ id: saved\.id \}/, /stage\(\{ clientKey: snap\.ck \}/, /keepNoteDraftRow\(day, draft\)/]) assert.match(keep, dest)
    })

    it('★R5-1/R5-2: 書きかけの打ちかけは応答待ちでなければ控えに残す（冪等キーつき）・積み切れない時は控えに残してから送信待ちの行にする・確定し直しは同じ冪等キー', () => {
      const src = read('pages/DailySheetPage.tsx')
      const abandon = src.slice(src.indexOf('const abandonNoteBody = useCallback('), src.indexOf('const patchDraftOrRegistration = useCallback('))
      assert.match(abandon, /if \(!savingRef\.current\.has\(key\)\) keepNoteDraftRow\(day, \{ \.\.\.draft, body: value \}\)/)
      const save = src.slice(src.indexOf('const saveNoteDraft = useCallback('), src.indexOf('const commitNoteBody = useCallback('))
      assert.match(save, /const ck = draft\.ck \?\? newClientKey\(\)/, '確定し直すたびに新しい冪等キーで登録している')
      assert.match(save, /if \(!ok\) \{[\s\S]*?keepNoteDraftRow\(day, \{ \.\.\.cur, ck(, did: newDraftId\(\))? \}\)[\s\S]*?\}\n\s+patchNoteDraft\(key, \{ locked: true, ck \}\)/, '積み切れない時に控えへ残さずに送信待ちの行にしている')
      assert.match(src, /if \(typeof o\.ck === 'string' && \/\^\[\\w\.:-\]\{1,100\}\$\/\.test\(o\.ck\)\) \{\n\s+out\.ck = o\.ck/)
    })

    it('★R6(A): 同じ冪等キーの登録が既に届いていた（23505）時、直した本文（B\'）は登録できた行への変更として残る（黙って既存の行を返さない）', async () => {
      const srv = noteServer()
      srv.seed({ ...regBase, body: '本文B（先に届いた）', client_key: 'ck-a' })
      DB.__testHooks.setClient(srv.client)
      await DB.insertNote({ ...regBase, body: '本文B\'（戻した書きかけを直した）' }, { clientKey: 'ck-a' }).catch(() => undefined)
      await DB.flushQueue(true)
      await settle()
      const server = srv.db.notes.filter((n) => n.client_key === 'ck-a').map((n) => n.body)
      const kept = DB.listUnsentNotes().flatMap((u) => (u.kind === 'insert' ? [u.op.body] : [u.row.values.body]))
      assert.equal(server.length, 1, '行が二重になった')
      assert.ok([...server, ...kept].includes('本文B\'（戻した書きかけを直した）'), `直した本文が消えた: server=${JSON.stringify(server)} 端末=${JSON.stringify(kept)}`)
    })

    it('★R6(B): 同じ冪等キーの登録が送信待ちに残っている時に確定し直しても、登録を二重に積まず、直した本文は消えない', async () => {
      let off = true
      const srv = noteServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.insertNote({ ...regBase, body: '本文B1' }, { clientKey: 'ck-b' }), 'queued')
      assert.equal(await DB.insertNote({ ...regBase, body: '本文B2（確定し直した）' }, { clientKey: 'ck-b' }), 'queued')
      const ops = JSON.parse(lsStore.get('cl_sendQueue')).ops.filter((o) => o.qid === 'ck-b')
      assert.equal(ops.length, 1, `同じ冪等キーの登録が ${ops.length} 本積まれた`)
      off = false
      await DB.flushQueue(true)
      await DB.flushQueue(true)
      await settle()
      assert.deepEqual(srv.db.notes.map((n) => n.body), ['本文B2（確定し直した）'])
    })

    it('★R6-1: 同じ冪等キーの書きかけを2つのタブで同時に確定しても、両方の本文がサーバーか〔くらべて選ぶ〕に残る', async () => {
      // 2つ目のタブ＝同じ db.ts を別の実体として読み込む（端末の保存先 localStorage と Web Locks は共有）
      const DB2 = await import(new URL('lib/db.ts?tab2=' + Date.now(), SRC).href)
      let off = true
      const srv = noteServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      DB2.__testHooks.setClient(srv.client)
      await DB2.__testHooks.restartQueue()
      const both = await Promise.all([
        DB.insertNote({ ...regBase, body: '本文X（タブ1）' }, { clientKey: 'ck-2t', firstSent: null }),
        DB2.insertNote({ ...regBase, body: '本文Y（タブ2）' }, { clientKey: 'ck-2t', firstSent: null }),
      ])
      assert.deepEqual(both, ['queued', 'queued'])
      off = false
      for (let i = 0; i < 3; i++) {
        await DB.flushQueue(true)
        await DB2.flushQueue(true)
        await settle()
      }
      const server = srv.db.notes.map((n) => n.body)
      const kept = [...DB.listUnsentNotes(), ...DB2.listUnsentNotes()].flatMap((u) => (u.kind === 'insert' ? [u.op.body] : [u.row.values.body]))
      assert.equal(server.length, 1, `行が ${server.length} 行`)
      const all = [...server, ...kept]
      assert.ok(all.includes('本文X（タブ1）') && all.includes('本文Y（タブ2）'), `片方の本文が消えた: server=${JSON.stringify(server)} 端末=${JSON.stringify(kept)}`)
      DB2.__testHooks.setClient(null)
    })

    it('★L7-2: 端末の保存領域が一杯でも、同じ冪等キーの書きかけを2つのタブで同時に確定した両方の本文が、サーバーか〔くらべて選ぶ〕に残る（黙って消えない）', async () => {
      const DB2 = await import(new URL('lib/db.ts?tab2full=' + Date.now(), SRC).href)
      let off = true
      const srv = noteServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      DB2.__testHooks.setClient(srv.client)
      await DB2.__testHooks.restartQueue()
      globalThis.__lsFull = true
      try {
        const both = await Promise.all([
          DB.insertNote({ ...regBase, body: '本文P（タブ1・満杯）' }, { clientKey: 'ck-full', firstSent: null }).catch((e) => `err:${e.message}`),
          DB2.insertNote({ ...regBase, body: '本文Q（タブ2・満杯）' }, { clientKey: 'ck-full', firstSent: null }).catch((e) => `err:${e.message}`),
        ])
        // 送る前: どちらのタブも、端末に残せていない申し送りがあると画面へ伝える（閉じると消えるため）
        assert.equal(DB.hasUnpersistedNotes?.() ?? null, true, '保存できていない申し送りがあることを画面へ伝えていない（タブ1）')
        assert.equal(DB2.hasUnpersistedNotes?.() ?? null, true, '保存できていない申し送りがあることを画面へ伝えていない（タブ2）')
        off = false
        for (let i = 0; i < 4; i++) {
          await DB.flushQueue(true)
          await DB2.flushQueue(true)
          await settle()
        }
        const server = srv.db.notes.filter((n) => n.client_key === 'ck-full' || n.body.startsWith('本文')).map((n) => n.body)
        const kept = [...DB.listUnsentNotes(), ...DB2.listUnsentNotes()].flatMap((u) => (u.kind === 'insert' ? [u.op.body] : [u.row.values.body]))
        const all = [...server, ...kept]
        assert.ok(all.includes('本文P（タブ1・満杯）') && all.includes('本文Q（タブ2・満杯）'), `片方の本文が消えた: 確定=${JSON.stringify(both)} server=${JSON.stringify(server)} 端末=${JSON.stringify(kept)}`)
        // 保存領域が空いたら、メモリにだけあった分が端末に残る（残せたら警告は消える）
        globalThis.__lsFull = false
        for (let i = 0; i < 2; i++) {
          await DB.flushQueue(true)
          await DB2.flushQueue(true)
          await settle()
        }
        const after = [...DB.listUnsentNotes(), ...DB2.listUnsentNotes()].flatMap((u) => (u.kind === 'insert' ? [u.op.body] : [u.row.values.body]))
        const all2 = [...srv.db.notes.map((n) => n.body), ...after]
        assert.ok(all2.includes('本文P（タブ1・満杯）') && all2.includes('本文Q（タブ2・満杯）'), `空いた後に片方が消えた: ${JSON.stringify(all2)}`)
        assert.equal(DB2.hasUnpersistedNotes(), false, '空いた後も残せていない')
      } finally {
        globalThis.__lsFull = false
        DB2.__testHooks.setClient(null)
      }
    })

    it('★R6-3: 戻した書きかけが「その冪等キーで最初に送った中身」を持っていれば、既に届いていた登録への変更は自分どうしで競合しない', async () => {
      const srv = noteServer()
      srv.seed({ ...regBase, body: '本文F（最初に送った）', client_key: 'ck-fs' })
      DB.__testHooks.setClient(srv.client)
      await DB.insertNote({ ...regBase, body: '本文F2（戻して直した）' }, { clientKey: 'ck-fs', firstSent: { body: '本文F（最初に送った）', resident_id: regBase.resident_id, reporter_id: regBase.reporter_id, color: regBase.color } })
      await DB.flushQueue(true)
      await settle()
      assert.deepEqual(srv.db.notes.map((n) => n.body), ['本文F2（戻して直した）'])
      assert.equal(DB.listUnsentNotes().length, 0, '自分どうしで競合して止まった')
    })

    it('★R6-2/R6-3: 積み切れない時に控えへ残す行は新しい印（did）で残す・書きかけは「最初に送った中身」を控えに持ち、読み戻す', () => {
      const src = read('pages/DailySheetPage.tsx')
      const save = src.slice(src.indexOf('const saveNoteDraft = useCallback('), src.indexOf('const commitNoteBody = useCallback('))
      assert.match(save, /keepNoteDraftRow\(day, \{ \.\.\.cur, ck, did: newDraftId\(\) \}\)/, '控えに残す行が元の印のまま（登録済みの印に覆われる）')
      assert.match(save, /firstSent: draft\.firstSent \?\? null/)
      assert.match(src, /out\.firstSent = /, '控えから「最初に送った中身」を読み戻していない')
    })

    it('★L7-1: 登録の応答が返らない時は上限で打ち切って送信待ちへ退避し、後から届いていても同じ冪等キーで1行・本文は消えない', async () => {
      let release = null
      const held = new Promise((r) => { release = r })
      let holding = true
      const srv = noteServer({ hold: async () => { if (holding) await held } })
      DB.__testHooks.setClient(srv.client)
      DB.__testHooks.setNoteInsertTimeout?.(150)
      const call = DB.insertNote({ ...regBase, body: '本文T（応答が返らない）' }, { clientKey: 'ck-to' })
      const res = await Promise.race([call, new Promise((r) => setTimeout(() => r('応答待ちのまま'), 1500))])
      assert.equal(res, 'queued', `上限で打ち切られていない（${res}）`)
      holding = false
      release() // 打ち切った後に、最初の登録が届く
      await settle()
      await DB.flushQueue(true)
      await settle()
      assert.deepEqual(srv.db.notes.map((n) => n.body), ['本文T（応答が返らない）'])
      assert.equal(DB.listUnsentNotes().length, 0)
    })

    it('日付を切り替える前の確認: 書きかけが申し送りだけの時は「この端末に残ります（戻ると表示されます）」の趣旨・それ以外は従来の文言', () => {
      const src = read('pages/DailySheetPage.tsx')
      assert.match(src, /書きかけの申し送りは、この端末に残ります（この日に戻ると表示されます）/)
      assert.match(src, /'保存していない行があります。表示を切り替えると、その入力は破棄されます。切り替えてよろしいですか。'/, '従来の文言を変えた')
      assert.match(src, /onDirty\(day, otherDirty \? 'input' : hasNoteDraftContent \? 'notes' : false\)/)
      assert.match(src, /const otherDirty = hasHeldVitals \|\| hasOtherDraftContent/)
    })

    it('記入者: 日報の空き行・新しい行は記入者を空欄で始める（どの帯も）・本文が空の控えの自動の記入者は読まない', () => {
      const src = read('pages/DailySheetPage.tsx')
      const calls = src.split('\n').filter((l) => l.includes('emptyNoteDraft(') && !l.includes('function emptyNoteDraft'))
      assert.ok(calls.length >= 3, `呼び出しが見つからない: ${JSON.stringify(calls)}`)
      for (const l of calls) assert.match(l, /emptyNoteDraft\(.*, null\)/, `記入者に既定値を入れている: ${l.trim()}`)
      assert.match(src, /const reporterId = body\.trim\(\) === '' && !reporterPicked \? null : readReporter/)
    })

    it('記入者: 〔記入者を消す〕は申し送りの記入者を選ぶ時だけ出し、書きかけは空に・保存済みは送信待ち経由で null を送る', () => {
      const ui = read('components/ui.tsx')
      const picker = ui.slice(ui.indexOf('export function StaffPickerModal('), ui.indexOf('export function StaffPickerModal(') + 3000)
      assert.match(picker, /\{onClear \? \(/, '外す操作のボタンを onClear の有無で出し分けていない')
      assert.match(picker, /className="mb-2 min-h-tap w-full/, 'タップ領域（min-h-tap）が無い')
      const src = read('pages/DailySheetPage.tsx')
      assert.match(src, /onClear=\{staffPick\?\.for === 'noteReporter' \? onClearReporter : undefined\}/)
      const clear = src.slice(src.indexOf('const onClearReporter = useCallback('), src.indexOf('const onClearReporter = useCallback(') + 900)
      assert.match(clear, /patchDraftOrRegistration\(target\.key, \{ reporterId: null, reporterPicked: false \}\)/)
      assert.match(clear, /updateNoteCell\(note, \{ reporter_id: null \}\)/)
      for (const other of ['MedRecordPage', 'BathRecordPage', 'IncidentFormPage', 'MedSlotsPage', 'NoteFormPage']) {
        const o = read(`pages/${other}.tsx`)
        assert.doesNotMatch(o.slice(o.indexOf('<StaffPickerModal'), o.indexOf('<StaffPickerModal') + 600), /onClear=/, `${other} の選択画面に外す操作を出している`)
      }
    })

    it('記入者: 保存済みの行の記入者を空にする変更（null）は、送信待ち → apply_note_edits でサーバーも null になる', async () => {
      const srv = noteServer()
      const row = srv.seed({ ...regBase, body: '記入者を消す行', reporter_id: 1 })
      DB.__testHooks.setClient(srv.client)
      await DB.saveNoteEdits({ id: row.id }, { reporter_id: { value: null, base: 1 } })
      await DB.flushQueue(true)
      await settle()
      assert.equal(srv.db.notes.find((n) => n.id === row.id).reporter_id, null)
      assert.equal(DB.listUnsentNotes().length, 0)
    })

    it('記入者: 申し送りフォームも記入者を空欄で始め、送った後・破棄の後も空に戻し、名簿に無い職員を操作者に置き換えない', () => {
      const src = read('pages/NoteFormPage.tsx')
      const calls = src.split('\n').filter((l) => l.includes('defaultForm(') && !l.includes('function defaultForm'))
      assert.ok(calls.length >= 3, JSON.stringify(calls))
      for (const l of calls) assert.match(l, /defaultForm\(null, /, `記入者に既定値を入れている: ${l.trim()}`)
      assert.match(src, /reporterId: reporterOk \? draft\.reporterId : null/)
      assert.match(src, /記入者が選ばれていません。記入者を選んでください。/, '必須の検査を外した')
    })

    it('iPhone の重さ（A・C・D・B1）: 空の一言は sticky にしない・wheel/touchmove を付けない・日付行は CSS の sticky・当たり判定の疑似要素を日報で出さない', () => {
      const src = read('pages/DailySheetPage.tsx')
      assert.match(src, /style=\{status \? NARROW_STICKY : undefined\}/, 'A: 空の一言まで sticky')
      assert.doesNotMatch(src, /addEventListener\('(wheel|touchmove)'/, 'C: wheel・touchmove の受け手が残っている')
      assert.match(src, /addEventListener\('scroll', onScroll, \{ passive: true, capture: true \}\)/)
      assert.doesNotMatch(src, /useDayBarPin|--day-bar-y/, 'B1: スクロールのたびに位置を計算する日付行の固定が残っている')
      assert.match(src, /<SheetFrame className="(dsheet-frame )?sheet-frame-fit print:!max-h-none">/)
      assert.match(src, /data-day-bar=""\n\s+className="(?:dsheet-frame-row )?sticky top-0 /)
      const css = read('styles/sheet.css')
      assert.match(css, /\.sheet-dense \.sheet-hit::before \{\n\s+content: none;/, 'D')
      assert.match(css, /body:has\(section\.dsheet-day\) nav\[aria-label='メインナビゲーション'\]/)
    })

    it('B1 の余白・E（案2）: 枠は画面下のナビの上まで・画面外の日の表の中身だけ描画を省き、窓・日付の行は入れ物の外（行の中の窓が開いている間は省略を外す）', () => {
      const src = read('pages/DailySheetPage.tsx')
      assert.match(src, /<SheetFrame className="dsheet-frame sheet-frame-fit print:!max-h-none">/)
      assert.match(src, /root\.style\.setProperty\('--dsheet-below', next\)/)
      const day = src.slice(src.indexOf('<div className="dsheet-body">'), src.indexOf('<ResidentPickerModal'))
      assert.ok(day.length > 0, '日の表の中身の入れ物が無い')
      for (const outside of ['<DayHeader', '<ResidentPickerModal', '<StaffPickerModal', '<ConfirmDialog', '<NoteConflictResolver', '<ConflictResolver', '<NoteHistoryDialog']) {
        assert.ok(!day.includes(outside), `${outside} が入れ物の中にある`)
      }
      const css = read('styles/sheet.css')
      assert.match(css, /\.dsheet-body \{\n\s+content-visibility: auto;\n\s+contain-intrinsic-size: auto 2000px;/)
      assert.match(css, /\.dsheet-body:has\(\[role='dialog'\]\),\n\.dsheet-body:has\(\[aria-expanded='true'\]\) \{\n\s+content-visibility: visible;/)
      assert.match(css, /@media print \{\n\s+\.dsheet-body \{\n\s+content-visibility: visible;/)
      assert.match(css, /main:has\(\.dsheet-frame\) \{\n\s+padding-bottom: var\(--dsheet-below, 6rem\);/)
    })

    it('F1: 送信待ちの登録の行は、画面の一言が無くても（再読み込みの後も）送信待ち・止まった印を出す', () => {
      const src = read('pages/DailySheetPage.tsx')
      assert.match(src, /<StatusText status=\{ctx\.status\[rowKey\] \?\? \(note \? undefined : registrationMark\(draft\)\)\} \/>/)
      assert.match(src, /regState: op\.state/)
    })

    it('修正7: 日報の申し送りの本文欄は、確定しないまま外れる打ちかけを受け取る（SheetCell の onAbandon）', () => {
      assert.match(read('components/sheet.tsx'), /onAbandon\?: \(value: string, meta: \{ base: string \}\) => void/)
      assert.match(read('pages/DailySheetPage.tsx'), /onAbandon=\{\(v, m\) => onAbandonBody\(rowKey, v, m\.base\)\}/)
    })
  })

  describe('カルテの変更の記録の後方互換', () => {
    afterEach(reset)
    it('old_row の条件を受け付けないサーバー（400）では、従来の条件で引き直す（欄を失敗させない）', async () => {
      const fake = fakeSupabase((q) =>
        q.filters.some((f) => f[0] === 'or')
          ? { data: null, error: { code: 'PGRST100', message: 'parse' }, status: 400 }
          : { data: [], error: null, status: 200 },
      )
      DB.__testHooks.setClient(fake.client)
      const r = await DB.fetchRecordHistory({ residentId: 3, fromIso: '2026-09-01', toIso: '2026-09-14' })
      assert.deepEqual(r, { available: true, entries: [] })
      assert.deepEqual(fake.calls[1].filters.find((f) => f[0] === 'eq'), ['eq', 'resident_id', 3])
    })
  })

  describe('書きかけ（タブごと・和集合・古い書きかけを黙って消さない）', () => {
    it('他のタブが同じ行をより新しく持っている時は、その分を消さない', () => {
      const old = { did: 'x', at: 10, kind: 'note', data: { body: '古い' } }
      const newer = { did: 'x', at: 20, kind: 'note', data: { body: '新しい' } }
      let file = ND.writeTabRows(null, 'tabB', [newer], 20)
      file = ND.writeTabRows(file, 'tabA', [old], 21)
      assert.equal(ND.unionDraftRows(file)[0].data.body, '新しい')
    })

    it('登録できた・破棄した行は印を付けて和集合から外す（他のタブの古い控えから復活しない）', () => {
      let file = ND.writeTabRows(null, 'tabA', [{ did: 'x', at: 1, kind: 'note', data: {} }], 1)
      file = ND.writeTabRows(file, 'tabB', [{ did: 'x', at: 1, kind: 'note', data: {} }], 2)
      file = ND.markDraftsGone(file, ['x'], 3)
      assert.deepEqual(ND.unionDraftRows(file), [])
    })

    it('旧版の控え（tabs の無い v1）は中身から決まる印で読み替える（消さない）', () => {
      const o = { v: 1, savedAt: 5, notes: [{ body: '本文L' }] }
      const legacy = (x) => x.notes.map((d, i) => ({ did: ND.legacyDraftId('note', i, d), at: x.savedAt, kind: 'note', data: d }))
      const f1 = ND.parseDraftFile(o, (_k, d) => d, legacy)
      const f2 = ND.parseDraftFile(o, (_k, d) => d, legacy)
      assert.equal(ND.unionDraftRows(f1)[0].data.body, '本文L')
      assert.equal(ND.unionDraftRows(f1)[0].did, ND.unionDraftRows(f2)[0].did)
    })

    it('〇日前の書きかけ（1日未満は出さない）', () => {
      const day = 24 * 60 * 60 * 1000
      assert.equal(ND.draftAgeLabel(0 + 3 * day + 5, 6 * day + 10), '3日前の書きかけ')
      assert.equal(ND.draftAgeLabel(10, 10 + day - 1), null)
    })
  })

  describe('送信待ちの値を行に重ねる（overlayNote）', () => {
    it('本文・色を重ね、取り消しは重ねない', () => {
      const note = { id: 1, body: '本文O', color: null, rev: 1 }
      assert.deepEqual(NE.overlayNote(note, { body: '本文A', color: 'pink', deleted_at: 'x' }), { id: 1, body: '本文A', color: 'pink', rev: 1 })
      assert.equal(NE.overlayNote(note, null), note)
    })
  })

  describe('画面の配線（静的検査）', () => {
    it('申し送りの既存行の変更は saveNoteEdits / deleteNote だけを使う（rev 照合の旧経路を呼ばない）', () => {
      for (const f of ['pages/DailySheetPage.tsx', 'pages/TimelinePage.tsx', 'pages/NoteFormPage.tsx']) {
        const src = read(f)
        assert.doesNotMatch(src, /\b(updateNoteFields|updateNote|softDeleteNote|endOngoingNote)\(/, `${f} が旧経路を呼んでいる`)
      }
      assert.match(read('pages/DailySheetPage.tsx'), /saveNoteEdits\(/)
      assert.match(read('pages/TimelinePage.tsx'), /saveNoteEdits\(/)
      assert.match(read('pages/NoteFormPage.tsx'), /deleteNote\(/)
    })

    it('タイムラインは編集を始めた時の本文を基準に持つ（自動の取り直しで基準を変えない）', () => {
      const src = read('pages/TimelinePage.tsx')
      assert.match(src, /editBaseRef/)
    })

    it('送れていない申し送りの一覧を日報と設定画面に出す', () => {
      assert.match(read('pages/DailySheetPage.tsx'), /<UnsentNotes\b/)
      assert.match(read('pages/SettingsPage.tsx'), /<UnsentNotes\b/)
    })

    it('競合で止まった申し送りは離れる時の確認に数える', () => {
      assert.match(read('components/UnsentNotes.tsx'), /registerUnsaved/)
    })

    it('書きかけを24時間で黙って消さない（期限で消す処理が無い）', () => {
      assert.doesNotMatch(read('pages/DailySheetPage.tsx'), /DAILY_DRAFT_TTL_MS/)
      assert.doesNotMatch(read('pages/NoteFormPage.tsx'), /DRAFT_TTL_MS/)
    })
  })

}
