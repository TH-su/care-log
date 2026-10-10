// 同期・認証・止まった送信待ちの回帰テスト（2026-10-10 多端末運用の監査 中核2: F14・F58・F37・F08・F66・F48・F56・
// F54・F61・F36）。直す前の版では赤、直した後で緑になる形。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// db.ts を解決フックで読み込み、偽の Supabase（通信しない）を __testHooks.setClient で差し込む。
// window は定義しない＝起動時の自動読み込み・自動再送は動かない（restartQueue で起動を再現する）。
// 個人情報は置かない（利用者・職員は数値IDのみ。本文は記号だけ）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as NC from './note-contract.mjs'

const UNSUPPORTED = 'この Node では TypeScript・解決フックを使えないため、同期の検証をスキップしました（Node 22.18 以降で実行してください）。'

const lsStore = new Map()
let D = null
let MED = null
let FMT = null
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
      lsStore.set(k, String(v))
    },
    removeItem: (k) => {
      lsStore.delete(k)
    },
  }
  D = await import('../src/lib/db.ts?core2')
  MED = await import('../src/lib/med.ts')
  FMT = await import('../src/lib/format.ts')
} catch {
  D = null
}

// ── 偽の Supabase（通信しない。チャンネルの状態の通知・ログインの控えも手で動かせる） ─────────────────

/**
 * handler(q) が応答を返す偽のクライアント。
 * auth.session: undefined＝getSession を持たない（既存の試験と同じ）／null＝ログインの控えが無い（トークン更新の失敗中）／
 * オブジェクト＝ログイン中。channels は作ったチャンネル（status(s) で購読の状態の通知を起こす）
 */
function fakeSupabase(handler, auth = {}) {
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
      ilike(k, v) {
        q.filters.push(['ilike', k, v])
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
  const channel = (name) => {
    const ch = {
      name,
      handlers: [],
      statusCb: null,
      removed: false,
      on(_ev, filter, cb) {
        ch.handlers.push({ table: filter.table, cb })
        return ch
      },
      subscribe(cb) {
        ch.statusCb = typeof cb === 'function' ? cb : null
        return ch
      },
      /** 購読の状態の通知を起こす（SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED） */
      status(s) {
        ch.statusCb?.(s)
      },
    }
    channels.push(ch)
    return ch
  }
  const client = {
    from,
    rpc,
    channel,
    removeChannel: (ch) => {
      ch.removed = true
      // realtime-js は外した時にも CLOSED を通知する
      ch.statusCb?.('CLOSED')
      return Promise.resolve('ok')
    },
    auth: { onAuthStateChange(cb) { auth.listener = cb } },
  }
  if (Object.prototype.hasOwnProperty.call(auth, 'session')) {
    client.auth.getSession = async () => ({ data: { session: auth.session }, error: null })
  }
  return { client, calls, channels, auth }
}

const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms))
const noTimer = { set: () => 1, clear: () => undefined }

const match = (row, filters) =>
  filters.every(([op, k, v]) =>
    op === 'eq' ? row[k] === v : op === 'is' ? (row[k] ?? null) === v : op === 'in' ? v.includes(row[k]) : op === 'gte' ? row[k] >= v : op === 'lte' ? row[k] <= v : true,
  )

/**
 * 業務表を持つ偽のサーバー。insert は冪等キーの重複で 23505、自然キー（入浴・与薬・時間帯）の重複でも 23505。
 * update は eq / is の条件に合う行だけに当て rev を進める（0001 の rev トリガと同じ）。
 * opts.anon()＝true の間は、Supabase の anon キーで出た要求と同じ答え（RLS で見えない＝select は0行・update は0行・
 * insert は 401 / 42501）を返す（F58）。opts.member=false は、許可リスト外の職員（RLS で0行・書込は 403 / 42501）
 */
function server(opts = {}) {
  const db = { fluid_intake: [], outings: [], notes: [], residents: [], bath_records: [], med_admin: [], med_slots: [], staff: [], app_settings: [], incidents: [], note_reads: [], attendance: [], import_days: [], vitals: [], meals: [] }
  let nextId = 900
  const fake = fakeSupabase(async (q) => {
    if (opts.offline?.(q)) return { data: null, error: { message: 'offline' }, status: 0 }
    const anon = opts.anon?.() === true
    const outsider = opts.member === false
    if (q.action === 'rpc') {
      if (anon) return { data: null, error: { code: '42501', message: 'permission denied' }, status: 401 }
      return { data: { version: 1, status: 'probe' }, error: null, status: 200 }
    }
    const rows = db[q.table]
    if (rows === undefined) return { data: null, error: { code: 'X', message: `unexpected ${q.table}` }, status: 500 }
    if (q.action === 'insert') {
      if (anon) return { data: null, error: { code: '42501', message: 'rls' }, status: 401 }
      if (outsider) return { data: null, error: { code: '42501', message: 'rls' }, status: 403 }
      const ck = q.payload.client_key
      if (ck && rows.some((r) => r.client_key === ck)) return { data: null, error: { code: '23505', message: 'dup' }, status: 409 }
      const nk = opts.naturalKey?.(q.table, q.payload)
      if (nk && rows.some((r) => r.deleted_at == null && nk(r))) return { data: null, error: { code: '23505', message: 'dup natural' }, status: 409 }
      const row = { id: nextId++, rev: 1, deleted_at: null, edited_by: null, ...q.payload }
      rows.push(row)
      return { data: { ...row }, error: null, status: 201 }
    }
    if (q.action === 'update') {
      if (anon || outsider) return { data: null, error: null, status: 200 }
      const hit = rows.find((r) => match(r, q.filters))
      if (!hit) return { data: null, error: null, status: 200 }
      Object.assign(hit, q.payload)
      if (typeof hit.rev === 'number') hit.rev += 1
      return { data: { ...hit }, error: null, status: 200 }
    }
    const hits = anon || outsider ? [] : rows.filter((r) => match(r, q.filters))
    const limited = q.limit !== undefined ? hits.slice(0, q.limit) : hits
    return q.single ? { data: limited[0] ? { ...limited[0] } : null, error: null, status: 200 } : { data: limited.map((r) => ({ ...r })), error: null, status: 200 }
  }, opts.auth ?? {})
  return { ...fake, db, updates: () => fake.calls.filter((q) => q.action === 'update'), inserts: () => fake.calls.filter((q) => q.action === 'insert') }
}

async function reset() {
  await settle()
  lsStore.clear()
  D.__testHooks.setClient(null)
  await D.__testHooks.restartQueue()
  D.__testHooks.setTimer(noTimer)
  D.setEditor(null)
}

function outingRow(over = {}) {
  return { id: 40, resident_id: 1, kind: 'outing', start_on: '2026-10-01', start_at: '10:00', end_on: null, end_at: null, companion: null, note: null, recorded_by: 1, edited_by: null, rev: 1, deleted_at: null, client_key: null, ...over }
}

if (D === null) {
  it('同期の検証', { skip: UNSUPPORTED }, () => {})
} else {
  describe('★F14 購読がつながり直した・画面に戻った・電波が戻った時に、表ごとに取り直しの合図（RESYNC）を流す', () => {
    afterEach(reset)

    const open = async (subscribe) => {
      const srv = server()
      D.__testHooks.setClient(srv.client)
      const got = []
      const stop = subscribe((table, info) => got.push({ table, info }))
      await settle()
      assert.equal(srv.channels.length, 1)
      return { srv, ch: srv.channels[0], got, stop }
    }

    it('与薬: 一度つながった後に切れて、またつながったら med_slots と med_admin に row=null の RESYNC を1回ずつ流す（最初の参加では流さない）', async () => {
      const { ch, got, stop } = await open(D.subscribeMedChanges)
      assert.equal(typeof ch.statusCb, 'function', '購読の状態を受け取っていない（ch.subscribe() に関数を渡していない）')
      ch.status('SUBSCRIBED')
      assert.deepEqual(got, [], '最初の参加で流した（開くたびに二重に読む）')
      ch.status('CHANNEL_ERROR')
      assert.deepEqual(got, [])
      ch.status('SUBSCRIBED')
      assert.deepEqual(
        got.map((g) => [g.table, g.info.event, g.info.row, g.info.resync]),
        [
          ['med_slots', 'RESYNC', null, 'reconnect'],
          ['med_admin', 'RESYNC', null, 'reconnect'],
        ],
      )
      // 時間切れ（TIMED_OUT）から戻った時も同じ
      ch.status('TIMED_OUT')
      ch.status('SUBSCRIBED')
      assert.equal(got.length, 4)
      stop()
    })

    it('入浴・事故・日報系（7表）の購読も同じく、つながり直した時に表ごとに流す', async () => {
      for (const [sub, tables] of [
        [D.subscribeBathChanges, ['bath_records']],
        [D.subscribeIncidentChanges, ['incidents']],
        [D.subscribeChanges, ['notes', 'vitals', 'meals', 'fluid_intake', 'outings', 'note_reads', 'attendance']],
      ]) {
        const { ch, got, stop } = await open(sub)
        ch.status('SUBSCRIBED')
        ch.status('CLOSED')
        ch.status('SUBSCRIBED')
        assert.deepEqual(got.map((g) => g.table), tables)
        assert.ok(got.every((g) => g.info.event === 'RESYNC' && g.info.row === null))
        stop()
        await reset()
      }
    })

    it('画面を閉じた後（removeChannel の CLOSED・画面復帰・電波復帰）は何も流さない', async () => {
      const { ch, got, stop } = await open(D.subscribeMedChanges)
      ch.status('SUBSCRIBED')
      stop()
      await settle()
      assert.equal(ch.removed, true)
      ch.status('SUBSCRIBED')
      D.__testHooks.lifecycle('online')
      D.__testHooks.lifecycle('hidden', 1_000)
      D.__testHooks.lifecycle('visible', 100_000)
      assert.deepEqual(got, [])
    })

    it('電波が戻った時・ページがキャッシュから戻った時は流す。画面に戻った時は30秒以上隠れていた時だけ流す', async () => {
      const { ch, got, stop } = await open(D.subscribeMedChanges)
      ch.status('SUBSCRIBED')
      D.__testHooks.lifecycle('online')
      assert.deepEqual(got.map((g) => [g.table, g.info.resync]), [['med_slots', 'online'], ['med_admin', 'online']])
      got.length = 0
      D.__testHooks.lifecycle('hidden', 1_000)
      D.__testHooks.lifecycle('visible', 21_000)
      assert.deepEqual(got, [], '20秒の切替で流した（短い切替で読み直し・案内を出し続ける）')
      D.__testHooks.lifecycle('hidden', 30_000)
      D.__testHooks.lifecycle('visible', 65_000)
      assert.deepEqual(got.map((g) => g.info.resync), ['resume', 'resume'])
      got.length = 0
      D.__testHooks.lifecycle('pageshow')
      assert.deepEqual(got.map((g) => g.info.resync), ['resume', 'resume'])
      stop()
    })

    it('参加する前に切れても（つながったことが無い）流さない', async () => {
      const { ch, got, stop } = await open(D.subscribeBathChanges)
      ch.status('CHANNEL_ERROR')
      ch.status('SUBSCRIBED')
      assert.deepEqual(got, [])
      stop()
    })
  })

  describe('★F58 トークン更新に失敗してログインの控えが無い間（anon キーで出る）の0行・空を、競合・空の名簿・未解禁と断定しない', () => {
    afterEach(reset)

    /** 圏外→anon の窓→回復、の3段を切り替えられるサーバー */
    const windowed = () => {
      const st = { offline: false, anon: false }
      const auth = { session: { access_token: 'x' } }
      const srv = server({ offline: () => st.offline, anon: () => st.anon, auth })
      const enterAnon = () => {
        st.offline = false
        st.anon = true
        auth.session = null
      }
      const recover = () => {
        st.anon = false
        auth.session = { access_token: 'y' }
      }
      return { srv, st, auth, enterAnon, recover }
    }

    it('送信待ちの外出の帰着・入浴の修正は、anon の窓で0行になっても「競合」で止めず、ログインが戻れば送れる', async () => {
      const { srv, st, enterAnon, recover } = windowed()
      srv.db.outings.push(outingRow())
      srv.db.bath_records.push({ id: 21, resident_id: 2, bath_on: '2026-10-01', result: 'full', cancel_reason: null, note: null, recorded_by: 1, rev: 1, auto: false, deleted_at: null, edited_by: null })
      D.__testHooks.setClient(srv.client)
      D.setEditor(1)
      st.offline = true
      assert.equal(await D.setOutingEnd(40, 1, '2026-10-01', '13:10'), 'queued')
      const bath = { id: 21, resident_id: 2, bath_on: '2026-10-01', result: 'full', cancel_reason: null, note: null, recorded_by: 1, rev: 1, auto: false }
      assert.equal(await D.updateBath(bath, { result: 'cancel', cancel_reason: 'condition' }), 'queued')
      enterAnon()
      await D.flushQueue(true)
      assert.deepEqual(D.listStoppedOps(), [], '偽の競合で止まった（二度と送られない）')
      assert.equal(D.queuePending(), 2)
      recover()
      await D.flushQueue(true)
      assert.equal(D.queuePending(), 0)
      assert.equal(srv.db.outings[0].end_at, '13:10')
      assert.equal(srv.db.bath_records[0].result, 'cancel')
    })

    it('直接の保存・取り消しも、anon の窓の0行は「他の端末が先に更新」ではなく送信待ちにする', async () => {
      const { srv, enterAnon, recover } = windowed()
      srv.db.outings.push(outingRow())
      srv.db.fluid_intake.push({ id: 7, resident_id: 1, taken_on: '2026-10-01', taken_at: '10:00', amount_ml: 150, kind: 'water', recorded_by: 1, edited_by: null, rev: 1, deleted_at: null })
      D.__testHooks.setClient(srv.client)
      enterAnon()
      assert.equal(await D.setOutingEnd(40, 1, '2026-10-01', '13:10'), 'queued')
      assert.equal(await D.softDeleteFluid(7, 1), 'queued')
      recover()
      await D.flushQueue(true)
      assert.equal(D.queuePending(), 0)
      assert.equal(srv.db.outings[0].end_at, '13:10')
      assert.notEqual(srv.db.fluid_intake[0].deleted_at, null)
    })

    it('入力解禁・名簿・一覧の読み取りは、anon で0行なら通信エラー（観測できなかった）にする（スプレッドシート期間・0人と断定しない）', async () => {
      const { srv, enterAnon } = windowed()
      srv.db.residents.push({ id: 1, source_id: 's1', name: '利用者01', kana: null, room: '101', gender: null, care_level: null, active: true, needs_review: false, note_alias: null })
      srv.db.app_settings.push({ key: 'native_input_enabled', value: 'true' })
      D.__testHooks.setClient(srv.client, { native: null })
      enterAnon()
      const gate = await D.getNativeInputGate()
      assert.equal(gate.observed, false, `封鎖を観測したと断定した: ${JSON.stringify(gate)}`)
      await assert.rejects(() => D.fetchResidents(), (e) => e instanceof D.DbError && e.kind === 'network')
      await assert.rejects(() => D.fetchVitalsSheet('2026-10-01', '2026-10-01'), (e) => e instanceof D.DbError && e.kind === 'network')
      await assert.rejects(() => D.getAppSetting('native_input_enabled'), (e) => e instanceof D.DbError && e.kind === 'network')
    })

    it('ログイン中に本当に0件なら、今までどおり空を返す（通信エラーにしない）', async () => {
      const { srv } = windowed()
      D.__testHooks.setClient(srv.client)
      assert.deepEqual(await D.fetchResidents(), [])
      assert.equal(await D.getAppSetting('native_input_enabled'), null)
    })

    it('申し送りでの表示名の送信待ちは、anon で利用者が見えなくても「居なくなった」として外さない', async () => {
      const { srv, st, enterAnon, recover } = windowed()
      srv.db.residents.push({ id: 1, source_id: 's1', name: '利用者01', kana: null, room: '101', gender: null, care_level: null, active: true, needs_review: false, note_alias: null })
      D.__testHooks.setClient(srv.client)
      st.offline = true
      assert.equal(await D.setResidentNoteAlias(1, '〇〇', null), 'queued')
      enterAnon()
      await D.flushQueue(true)
      assert.equal(D.queuePending(), 1, '表示名の送信待ちを黙って外した')
      recover()
      await D.flushQueue(true)
      assert.equal(D.queuePending(), 0)
      assert.equal(srv.db.residents[0].note_alias, '〇〇')
    })

    it('バイタルの送信待ちは、anon の窓で 403（42501）が返っても「拒否」で止めない', async () => {
      const auth = { session: null }
      let rejects = 0
      const fake = fakeSupabase((q) => {
        if (q.action === 'rpc' && q.args?.p_table === 'probe') return { data: { version: 1, status: 'probe' }, error: null, status: 200 }
        if (q.action === 'rpc') {
          rejects += 1
          return { data: null, error: { code: '42501', message: 'permission denied' }, status: 403 }
        }
        return { data: [], error: null, status: 200 }
      }, auth)
      D.__testHooks.setClient(fake.client)
      const r = await D.saveVitalEdits({ routine: true, residentId: 1, day: '2026-10-01' }, { temp: { value: 36.5, base: null } })
      assert.equal(r, 'queued')
      assert.ok(rejects >= 1)
      const row = D.pendingRow('vitals', { routine: true, residentId: 1, day: '2026-10-01' })
      assert.ok(row !== null, '送信待ちが消えた')
      assert.notEqual(row.state, 'rejected', '拒否で止めた（新しい入力が来るまで送られない）')
    })

    it('この修正の前の版で「競合」で止まった update は、行の版が見ていた版のまま（誰も変えていない）なら、外して送り直す', async () => {
      const srv = server({ auth: { session: { access_token: 'x' } } })
      srv.db.outings.push(outingRow({ rev: 3 }))
      srv.db.outings.push(outingRow({ id: 41, rev: 5 }))
      // 旧版が止めた op（偽の競合: 行は rev 3 のまま／本当の競合: 行は rev 5 へ進んでいる）
      lsStore.set(
        'cl_sendQueue',
        JSON.stringify({
          ops: [
            { qid: 'q-false', table: 'outings', kind: 'update', rowId: 40, rev: 3, payload: { end_on: '2026-10-01', end_at: '13:10', edited_by: 1 }, at: 1, tries: 1, nextAt: 0, blocked: 'conflict' },
            { qid: 'q-real', table: 'outings', kind: 'update', rowId: 41, rev: 4, payload: { end_on: '2026-10-01', end_at: '14:00', edited_by: 1 }, at: 1, tries: 1, nextAt: 0, blocked: 'conflict' },
          ],
        }),
      )
      await D.__testHooks.restartQueue()
      D.__testHooks.setClient(srv.client)
      await D.flushQueue(true)
      assert.equal(srv.db.outings[0].end_at, '13:10', '偽の競合で止まった帰着が送られない')
      assert.deepEqual(D.listStoppedOps().map((o) => o.qid), ['q-real'], '本当の競合まで外した／偽の競合を残した')
      assert.equal(srv.db.outings[1].end_at, null)
    })
  })


  describe('★F37 止まった与薬・入浴の追加を〔自分の内容で直す〕（相手の行を見せた版の上で直す）・拒否で止まった op はログインし直した時に1回だけ送り直す', () => {
    afterEach(reset)

    const medKey = (table, payload) =>
      table === 'med_admin' && payload.slot !== 'prn'
        ? (r) => r.resident_id === payload.resident_id && r.admin_on === payload.admin_on && r.slot === payload.slot
        : table === 'bath_records'
          ? (r) => r.resident_id === payload.resident_id && r.bath_on === payload.bath_on
          : null
    const medInput = (over = {}) => ({ resident_id: 1, admin_on: '2026-10-01', slot: 'morning', status: 'refused', given_at: null, prn_drug: null, prn_reason: null, prn_effect: null, note: '本人拒否', recorded_by: 11, ...over })

    it('与薬の「拒否」が他の端末の「服用済み」と自然キーでぶつかって止まった: 相手の行を引けて、見せた版の上でこの端末の内容に直せる', async () => {
      let off = true
      const srv = server({ offline: () => off, naturalKey: medKey })
      D.__testHooks.setClient(srv.client)
      D.setEditor(11)
      assert.equal(await D.insertMedAdmin(medInput()), 'queued')
      // 圏外の間に、他の端末が同じマスを「服用済み」で記録した
      srv.db.med_admin.push({ id: 70, resident_id: 1, admin_on: '2026-10-01', slot: 'morning', status: 'taken', given_at: null, prn_drug: null, prn_reason: null, prn_effect: null, note: null, recorded_by: 12, rev: 1, auto: false, deleted_at: null, edited_by: 12, created_at: null })
      off = false
      await D.flushQueue(true)
      const [st] = D.listStoppedOps()
      assert.ok(st !== undefined && st.state === 'conflict' && st.kind === 'insert')
      const target = await D.fetchQueuedOpTarget(st.qid)
      assert.ok(target !== null && target !== undefined, '止まった追加の相手の行を引けない（くらべて見せられない）')
      assert.equal(target.id, 70)
      assert.equal(target.status, 'taken')
      // 見せた行を渡さずに送ると、また止まる（相手の記録は変わらない）
      assert.equal(await D.resendQueuedOp(st.qid), 'conflict')
      assert.equal(srv.db.med_admin[0].status, 'taken')
      // 見せた行の id と版を渡すと、その上にこの端末の内容（拒否・備考・記入者）を書く
      assert.equal(await D.resendQueuedOp(st.qid, { id: target.id, rev: target.rev }), 'sent')
      const row = srv.db.med_admin[0]
      assert.equal(srv.db.med_admin.length, 1)
      assert.equal(row.status, 'refused')
      assert.equal(row.note, '本人拒否')
      assert.equal(row.recorded_by, 11)
      assert.equal(row.auto, false)
      assert.equal(row.slot, 'morning', '自然キーの列を書き換えた')
      assert.equal(D.queuePending(), 0)
    })

    it('見せた後に相手の行がまた変わっていれば、送らずに止める（見せていない変更を黙って上書きしない）', async () => {
      let off = true
      const srv = server({ offline: () => off, naturalKey: medKey })
      D.__testHooks.setClient(srv.client)
      assert.equal(await D.insertBath({ resident_id: 1, bath_on: '2026-10-01', result: 'cancel', cancel_reason: 'condition', note: '発熱', recorded_by: 11 }), 'queued')
      srv.db.bath_records.push({ id: 80, resident_id: 1, bath_on: '2026-10-01', result: 'full', cancel_reason: null, note: null, recorded_by: 12, rev: 1, auto: false, deleted_at: null, edited_by: 12 })
      off = false
      await D.flushQueue(true)
      const [st] = D.listStoppedOps()
      const target = await D.fetchQueuedOpTarget(st.qid)
      srv.db.bath_records[0].note = '別の端末の追記'
      srv.db.bath_records[0].rev = 2
      assert.equal(await D.resendQueuedOp(st.qid, { id: target.id, rev: target.rev }), 'conflict')
      assert.equal(srv.db.bath_records[0].result, 'full')
      assert.equal(D.listStoppedOps().length, 1, '止まった op を消した')
    })

    it('拒否で止まった op は、ログインし直した時（SIGNED_IN）に1回だけ送り直す。また拒否されれば止まり、次の SIGNED_IN では送らない', async () => {
      let deny = true
      let denied = 0
      const srv = server({})
      const base = srv.client.from
      srv.client.from = (table) => {
        const b = base(table)
        if (table !== 'outings' || !deny) return b
        b.insert = () => {
          denied += 1
          return { select: () => ({ maybeSingle: async () => ({ data: null, error: { code: '42501', message: 'denied' }, status: 403 }) }) }
        }
        return b
      }
      D.__testHooks.setClient(srv.client)
      const out = { resident_id: 1, kind: 'outing', start_on: '2026-10-01', start_at: '10:00', end_on: null, end_at: null, companion: null, note: null, recorded_by: 1 }
      // 直接の登録は拒否を例外で返すので、退避された op（旧版・圏外で積んだ分）を起動時に読ませて作る
      lsStore.set('cl_sendQueue', JSON.stringify({ ops: [{ qid: 'q-out', table: 'outings', kind: 'insert', payload: { ...out, client_key: 'q-out' }, at: 1, tries: 0, nextAt: 0 }] }))
      await D.__testHooks.restartQueue()
      D.__testHooks.setClient(srv.client)
      for (let i = 0; i < 12; i++) await D.flushQueue(true)
      assert.equal(D.listStoppedOps()[0]?.state, 'rejected')
      const tries = denied
      assert.ok(tries >= 1)
      // 権限が直らないまま TOKEN_REFRESHED: 送らない
      await D.__testHooks.authEvent('TOKEN_REFRESHED')
      assert.equal(denied, tries)
      // まだ直っていない SIGNED_IN: 1回だけ送って、また止まる
      await D.__testHooks.authEvent('SIGNED_IN')
      assert.equal(denied, tries + 1)
      assert.equal(D.listStoppedOps()[0]?.state, 'rejected')
      // 2回目の SIGNED_IN では送らない（恒久的な拒否で繰り返さない）
      await D.__testHooks.authEvent('SIGNED_IN')
      assert.equal(denied, tries + 1)
      // 権限が直った後の最初の SIGNED_IN なら届く（別の op で確かめる）
      deny = false
      lsStore.set('cl_sendQueue', JSON.stringify({ ops: [{ qid: 'q-out2', table: 'outings', kind: 'insert', payload: { ...out, client_key: 'q-out2' }, at: 1, tries: 10, nextAt: 0, blocked: 'rejected', rejects: 10, errCode: '42501' }] }))
      await D.__testHooks.restartQueue()
      D.__testHooks.setClient(srv.client)
      await D.__testHooks.authEvent('SIGNED_IN')
      assert.equal(D.queuePending(), 0)
      assert.equal(srv.db.outings.length, 1)
    })
  })


  describe('★F08 継続の終了が2台で重なった時、後の終了は「既に終了済み」として外す（最初の終了を正）・終了した職員を読む', () => {
    afterEach(reset)

    /** 0017 apply_note_edits の写し（tests/note-contract.mjs）＋申し送りの select に答える偽のサーバー */
    const noteServer = (opts = {}) => {
      const db = NC.createNoteDb()
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
        if (q.table === 'notes' && q.action === 'select') {
          const rows = db.notes.filter((r) => match(r, q.filters))
          return { data: rows[0] ? { ...rows[0] } : null, error: null, status: 200 }
        }
        return { data: null, error: { code: 'X', message: `unexpected ${q.table} ${q.action}` }, status: 500 }
      })
      const seed = (over = {}) => {
        const row = { ...NC.NOTE_BASE_ROW, id: 300, rev: 1, edited_by: null, deleted_at: null, client_key: null, ongoing: true, ended_at: null, ended_by: null, ...over }
        db.notes.push(row)
        return row
      }
      const rpcCalls = () => fake.calls.filter((q) => q.action === 'rpc' && q.fn === 'apply_note_edits' && q.args?.p_id !== null)
      return { ...fake, db, seed, rpcCalls }
    }

    it('圏外で押した終了が、他の端末（別の職員）の終了の後に届いた: 競合で止めずに外す。サーバーは先の終了（時刻・職員の組）のまま', async () => {
      let off = true
      const srv = noteServer({ offline: () => off })
      const row = srv.seed()
      D.__testHooks.setClient(srv.client)
      D.setEditor(1)
      const r = await D.saveNoteEdits({ id: 300 }, { ended_at: { value: '2026-10-01T01:00:00.000Z', base: null }, ended_by: { value: 1 } })
      assert.equal(r, 'queued')
      // 他の端末（職員2）が先に終了した
      Object.assign(row, { ended_at: '2026-10-01T01:05:00.000Z', ended_by: 2, rev: 2 })
      off = false
      await D.flushQueue(true)
      assert.equal(D.pendingNoteRow(300), null, '後の終了が送信待ちに止まり続けた（離れる時の確認が出続ける）')
      assert.equal(D.queuePending(), 0)
      assert.equal(row.ended_by, 2)
      assert.equal(row.ended_at, '2026-10-01T01:05:00.000Z', '後の終了で終了時刻だけを書き換えた（誰も操作していない組）')
    })

    it('★手直し: 0030 の行を読んだ画面の形（ended_by に基準 null）でも、後着の終了は外す（止まっています・離れる確認を出さない）', async () => {
      // タイムラインは 0030 で ended_by を読むので、未終了の行には基準 null を付けて送る（TimelinePage の〔継続を終了〕）。
      // 直す前は「基準の有無」で人の選択と見分けていたため、後着が外れずに送信待ちへ止まり、〔自分の内容で直す〕で先の終了を上書きできた
      let off = true
      const srv = noteServer({ offline: () => off })
      const row = srv.seed()
      D.__testHooks.setClient(srv.client)
      D.setEditor(1)
      const r = await D.saveNoteEdits({ id: 300 }, { ended_at: { value: '2026-10-01T01:00:00.000Z', base: null }, ended_by: { value: 1, base: null } })
      assert.equal(r, 'queued')
      Object.assign(row, { ended_at: '2026-10-01T01:05:00.000Z', ended_by: 2, rev: 2 })
      off = false
      await D.flushQueue(true)
      assert.equal(D.pendingNoteRow(300), null, '後の終了が送信待ちに止まり続けた')
      assert.equal(D.queuePending(), 0)
      assert.equal(row.ended_by, 2)
      assert.equal(row.ended_at, '2026-10-01T01:05:00.000Z')
    })

    it('★手直し: 〔くらべて選ぶ〕で先の終了を見てから選んだ値（ended_by の基準が先の終了者・rebase）は外さずに書く', async () => {
      const srv = noteServer()
      const row = srv.seed({ ended_at: '2026-10-01T01:05:00.000Z', ended_by: 2, rev: 2 })
      D.__testHooks.setClient(srv.client)
      const r = await D.saveNoteEdits(
        { id: 300 },
        { ended_at: { value: '2026-10-01T01:00:00.000Z', base: '2026-10-01T01:05:00.000Z' }, ended_by: { value: 1, base: 2 } },
        { rebase: true },
      )
      assert.notEqual(r, 'queued')
      assert.equal(r.status, 'applied', '人の選択を「既に終了済み」として捨てた')
      assert.equal(row.ended_by, 1)
    })

    it('画面がもう終了済みと見ている継続に〔継続を終了〕を重ねて押しても送らない（終了時刻だけが書き換わる組の崩れを作らない）', async () => {
      const srv = noteServer()
      const row = srv.seed({ ended_at: '2026-10-01T01:05:00.000Z', ended_by: 2, rev: 2 })
      D.__testHooks.setClient(srv.client)
      const r = await D.saveNoteEdits({ id: 300 }, { ended_at: { value: new Date().toISOString(), base: '2026-10-01T01:05:00.000Z' }, ended_by: { value: 1 } })
      assert.notEqual(r, 'queued')
      assert.deepEqual(r.conflicts, [])
      assert.equal(srv.rpcCalls().length, 0, '終了済みの継続へ終了を送った')
      assert.equal(row.ended_at, '2026-10-01T01:05:00.000Z')
      assert.equal(row.ended_by, 2)
    })

    it('予定の期限（これから先の終了時刻）が入った継続を前倒しで終了するのは、今までどおり書く', async () => {
      const srv = noteServer()
      const future = new Date(Date.now() + 3 * 86_400_000).toISOString()
      const row = srv.seed({ ended_at: future })
      D.__testHooks.setClient(srv.client)
      const now = new Date().toISOString()
      const r = await D.saveNoteEdits({ id: 300 }, { ended_at: { value: now, base: future }, ended_by: { value: 1 } })
      assert.notEqual(r, 'queued')
      assert.equal(r.status, 'applied')
      assert.equal(row.ended_by, 1)
      assert.equal(Date.parse(row.ended_at), Date.parse(now))
    })

    it('最新の行（〔くらべて選ぶ〕の基準）に終了した職員が入る。列を返さない応答では「分からない」（null と区別する）', async () => {
      const srv = noteServer()
      srv.seed({ ended_at: '2026-10-01T01:05:00.000Z', ended_by: 2 })
      D.__testHooks.setClient(srv.client)
      const latest = await D.fetchLatestNote(300)
      assert.ok(latest !== null)
      const r = latest.row ?? latest
      assert.equal(r.ended_by, 2, '終了した職員を読んでいない（〔くらべて選ぶ〕に「未入力」と出て、基準 null で送り続ける）')
    })
  })


  describe('★F66 日報の既読: 記録者の既定が無い端末でも人数を数え、10日まとめ取りでも全件に付け、取得上限に届いた分は断定しない', () => {
    afterEach(reset)

    const DAYS = Array.from({ length: 10 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`)
    const seed = (srv, readers) => {
      let id = 1
      for (const day of DAYS) {
        for (let k = 0; k < 34; k++) {
          const nid = id++
          srv.db.notes.push({ ...NC.NOTE_BASE_ROW, id: nid, note_on: day, deleted_at: null, ended_by: null })
          for (const st of readers) srv.db.note_reads.push({ note_id: nid, staff_id: st })
        }
      }
    }

    it('記録者の既定が無い（staffId=null）端末: 人数は数える（自分が読んだかは付けない）', async () => {
      const srv = server()
      seed(srv, [1, 2, 3, 4, 5])
      D.__testHooks.setClient(srv.client)
      const map = await D.fetchDailyReports(DAYS, null)
      const notes = [...map.values()].flatMap((r) => r.notes)
      assert.equal(notes.length, 340)
      assert.equal(notes.filter((n) => n.read_count !== 5).length, 0, '既読の人数を数えずに「既読 0人」の元を作った')
      assert.ok(notes.every((n) => n.my_read === undefined), '記録者が分からないのに「自分は既読/未読」を断定した')
    })

    it('10日まとめ取り（340件）: 新しい方まで全件に人数と自分の既読を付ける', async () => {
      const srv = server()
      seed(srv, [1, 2, 3, 4, 5])
      D.__testHooks.setClient(srv.client)
      const map = await D.fetchDailyReports(DAYS, 3)
      const notes = [...map.values()].flatMap((r) => r.notes)
      const missing = notes.filter((n) => n.read_count !== 5 || n.my_read !== true)
      assert.equal(missing.length, 0, `${missing.length} 件に既読が付いていない`)
      const reads = srv.calls.filter((q) => q.table === 'note_reads')
      assert.ok(reads.every((q) => q.filters.find((f) => f[0] === 'in')[2].length <= 200), 'URL 長の上限（200件）を超えて引いた')
    })

    it('既読の行が取得上限（2000行）に届いた時は、分けて引き直して正しい人数を出す（切れたまま少ない人数を出さない）', async () => {
      const srv = server()
      seed(srv, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) // 200件×11人＝2200行
      D.__testHooks.setClient(srv.client)
      const map = await D.fetchDailyReports(DAYS, 3)
      const notes = [...map.values()].flatMap((r) => r.notes)
      const wrong = notes.filter((n) => n.read_count !== undefined && n.read_count !== 11)
      assert.equal(wrong.length, 0, `実際と違う人数を出した: ${wrong.length} 件`)
      assert.equal(notes.filter((n) => n.read_count === 11).length, 340)
    })
  })


  describe('★F48 退職した職員の過去の記録: 名前の引き当て・記入者検索は在籍を問わない名簿で行う（選ぶ候補は在籍者のまま）', () => {
    afterEach(reset)

    const seedStaff = (srv) => {
      srv.db.staff.push({ id: 1, name: '職員01', active: true }, { id: 12, name: '職員05', active: false })
      srv.db.notes.push({ ...NC.NOTE_BASE_ROW, id: 501, note_on: '2026-09-15', reporter_id: 12, deleted_at: null, ended_by: null })
    }

    it('fetchAllStaff は退職者も返し、fetchStaff（選ぶ候補）は在籍者だけのまま', async () => {
      const srv = server()
      seedStaff(srv)
      D.__testHooks.setClient(srv.client)
      assert.equal(typeof D.fetchAllStaff, 'function', '在籍を問わない職員の取得が無い')
      assert.deepEqual((await D.fetchAllStaff()).map((x) => x.id).sort((a, b) => a - b), [1, 12])
      assert.deepEqual((await D.fetchStaff()).map((x) => x.id), [1])
    })

    it('記入者検索で退職した職員の氏名を入れると、その人の過去の申し送りが見つかる', async () => {
      const srv = server()
      seedStaff(srv)
      D.__testHooks.setClient(srv.client)
      const hits = await D.searchNotes({ q: '職員05', target: 'reporter', fromIso: '2026-09-01', toIso: '2026-09-30' })
      assert.deepEqual(hits.map((n) => n.id), [501], '退職者の記入者検索が0件になった')
    })
  })


  describe('★F56 事故・外出の新規登録で、同じ日・同じ方の既存の記録を引ける（参考表示の元。保存は止めない）', () => {
    afterEach(reset)

    it('fetchOutingsOn: その方のその日に在る外出・外泊を引く（対象者・開始日・帰着の条件を付けて引く）', async () => {
      const srv = server()
      srv.db.outings.push(outingRow({ id: 41, resident_id: 1, start_on: '2026-10-09', start_at: '10:00' }))
      srv.db.outings.push(outingRow({ id: 42, resident_id: 2, start_on: '2026-10-09' }))
      srv.db.outings.push(outingRow({ id: 43, resident_id: 1, start_on: '2026-10-11' }))
      D.__testHooks.setClient(srv.client)
      assert.equal(typeof D.fetchOutingsOn, 'function', '同じ日・同じ方の外出を引く関数が無い')
      const got = await D.fetchOutingsOn(1, '2026-10-09')
      assert.deepEqual(got.map((o) => o.id), [41])
      const q = srv.calls.find((c) => c.table === 'outings')
      assert.ok(q.filters.some((f) => f[0] === 'or' && f[1] === 'end_on.is.null,end_on.gte.2026-10-09'), '帰着前の外泊（開始が前日以前）を拾う条件が無い')
      await assert.rejects(() => D.fetchOutingsOn(1, '2026-10-9 or 1=1'))
    })

    it('fetchIncidents の対象者の絞り込み: 同じ日・同じ方の事故だけを返す（省けば従来どおり全員）', async () => {
      const srv = server()
      const inc = (over) => ({ id: 1, occurred_on: '2026-10-09', occurred_at: '10:00', kind: 'accident', status: 'open', resident_id: 1, deleted_at: null, rev: 1, ...over })
      srv.db.incidents.push(inc({ id: 1 }), inc({ id: 2, resident_id: 2 }))
      D.__testHooks.setClient(srv.client)
      const mine = await D.fetchIncidents({ fromIso: '2026-10-09', toIso: '2026-10-09', residentId: 1 })
      assert.deepEqual(mine.map((x) => x.id), [1])
      const all = await D.fetchIncidents({ fromIso: '2026-10-09', toIso: '2026-10-09' })
      assert.equal(all.length, 2)
    })
  })


  describe('★F54 服薬の時間帯の下書きを、他の端末の変更の上に当て直す（眠前を黙って消さない）', () => {
    it('A が昼を足している間に B が眠前を足した: 当て直すと［朝・昼・夕・眠前］（B の眠前を残す）', () => {
      assert.equal(typeof MED.rebaseMedSlotsDraft, 'function', '当て直しの部品が無い')
      const r = MED.rebaseMedSlotsDraft({
        base: { slots: ['morning', 'evening'], note: null },
        draft: { slots: ['morning', 'noon', 'evening'], note: null },
        latest: { slots: ['morning', 'evening', 'bedtime'], note: null },
      })
      assert.deepEqual(r.slots, ['morning', 'noon', 'evening', 'bedtime'])
      assert.deepEqual(r.theirsAdded, ['bedtime'])
      assert.deepEqual(r.theirsRemoved, [])
      assert.equal(r.changedByOthers, true)
      assert.equal(r.noteClash, false)
    })

    it('自分が外した時間帯は外したまま・他の端末が外した時間帯も外す・誰も触らない時間帯は最新のまま', () => {
      const r = MED.rebaseMedSlotsDraft({
        base: { slots: ['morning', 'noon', 'evening'], note: null },
        draft: { slots: ['morning', 'evening'], note: null },
        latest: { slots: ['noon', 'evening'], note: null },
      })
      assert.deepEqual(r.slots, ['evening'])
      assert.deepEqual(r.theirsRemoved, ['morning'])
    })

    it('他の端末が何も変えていなければ下書きのまま（changedByOthers=false）', () => {
      const r = MED.rebaseMedSlotsDraft({
        base: { slots: ['morning'], note: 'a' },
        draft: { slots: ['morning', 'bedtime'], note: 'b' },
        latest: { slots: ['morning'], note: 'a' },
      })
      assert.deepEqual(r.slots, ['morning', 'bedtime'])
      assert.equal(r.note, 'b')
      assert.equal(r.changedByOthers, false)
    })

    it('備考を両方が別の値に変えた時だけ食い違い（最新の値を残して人に選ばせる）。片方だけならその値', () => {
      const clash = MED.rebaseMedSlotsDraft({ base: { slots: [], note: '' }, draft: { slots: [], note: '自分' }, latest: { slots: [], note: '相手' } })
      assert.equal(clash.noteClash, true)
      assert.equal(clash.note, '相手')
      const theirs = MED.rebaseMedSlotsDraft({ base: { slots: [], note: null }, draft: { slots: [], note: null }, latest: { slots: [], note: '相手' } })
      assert.equal(theirs.note, '相手')
      assert.equal(theirs.noteClash, false)
      const same = MED.rebaseMedSlotsDraft({ base: { slots: [], note: null }, draft: { slots: [], note: '同じ' }, latest: { slots: [], note: '同じ ' } })
      assert.equal(same.noteClash, false)
    })
  })


  describe('★F61 許可リストから外れたアカウント: 「スプレッドシート期間」「サーバーエラー・しばらく待って」ではなく、ログインし直す・管理者に連絡の案内にする', () => {
    afterEach(reset)

    const fluid = { resident_id: 1, taken_on: '2026-10-01', taken_at: '10:00', amount_ml: 150, kind: 'water', recorded_by: 1 }

    it('開き直した端末（入力解禁を未観測）: 設定も名簿も見えない＝許可リスト外。入力解禁は forbidden（封鎖を観測したことにしない）・保存は forbidden', async () => {
      const srv = server({ member: false, auth: { session: { access_token: 'x' } } })
      srv.db.app_settings.push({ key: 'native_input_enabled', value: 'true' }, { key: 'input_enabled_bath', value: 'true' })
      srv.db.staff.push({ id: 1, name: '職員01', active: true })
      D.__testHooks.setClient(srv.client, { native: null, kinds: { bath: null, med: null, incident: null } })
      const gate = await D.getNativeInputGate()
      assert.equal(gate.forbidden, true, `許可リスト外と分からない: ${JSON.stringify(gate)}`)
      assert.equal(gate.observed, false, '封鎖（スプレッドシート期間）を観測したと断定した')
      const kg = await D.getKindInputGate('bath')
      assert.equal(kg.forbidden, true)
      await assert.rejects(() => D.insertFluid(fluid), (e) => e instanceof D.DbError && e.kind === 'forbidden' && e.message === D.FORBIDDEN_REASON)
      await assert.rejects(
        () => D.insertBath({ resident_id: 1, bath_on: '2026-10-01', result: 'full', cancel_reason: null, note: null, recorded_by: 1 }),
        (e) => e instanceof D.DbError && e.kind === 'forbidden',
      )
    })

    it('開いたままの端末（解禁を観測済み）で権限を失った: 403・42501 は「サーバーエラー・しばらく待って」ではなく forbidden（再ログインの導線は起動しない）', async () => {
      const srv = server({ member: false, auth: { session: { access_token: 'x' } } })
      D.__testHooks.setClient(srv.client)
      let expired = 0
      D.onAuthExpired(() => {
        expired += 1
      })
      await assert.rejects(() => D.insertFluid(fluid), (e) => e instanceof D.DbError && e.kind === 'forbidden' && !/しばらく待って/.test(e.message))
      assert.equal(expired, 0)
    })

    it('許可リストの職員で設定の行が本当に無い（名簿は見える）なら、今までどおり封鎖（false を観測）', async () => {
      const srv = server({ auth: { session: { access_token: 'x' } } })
      srv.db.staff.push({ id: 1, name: '職員01', active: true })
      D.__testHooks.setClient(srv.client, { native: null })
      const gate = await D.getNativeInputGate()
      assert.equal(gate.forbidden, undefined)
      assert.equal(gate.observed, true)
      assert.equal(gate.value, false)
      await assert.rejects(() => D.insertFluid(fluid), (e) => e instanceof D.DbError && e.kind === 'blocked')
    })
  })


  describe('★F36 端末の時刻帯が日本時間でない時に気づける（検出と案内の文言。入力は止めない）', () => {
    it('時差 -540 分（日本時間）なら案内なし。UTC・ロサンゼルス・シドニーは案内を出す（日付が合う地域でも時刻はずれる）', () => {
      assert.equal(typeof FMT.isJstDevice, 'function', '時刻帯の確かめが無い')
      assert.equal(FMT.isJstDevice(-540), true)
      assert.equal(FMT.deviceTimeZoneWarning(-540), null)
      for (const off of [0, 420, -600]) {
        assert.equal(FMT.isJstDevice(off), false)
        const w = FMT.deviceTimeZoneWarning(off, 'X/Y')
        assert.ok(w !== null && w.includes('日本時間ではありません') && w.includes('X/Y'))
      }
    })

    it('時刻帯の名前が取れない環境でも、時差から UTC+n の形で示す', () => {
      const orig = Intl.DateTimeFormat
      try {
        Intl.DateTimeFormat = function () {
          throw new Error('unsupported')
        }
        assert.equal(FMT.deviceTimeZoneLabel(0), 'UTC+0')
        assert.equal(FMT.deviceTimeZoneLabel(420), 'UTC-7')
        assert.equal(FMT.deviceTimeZoneLabel(-570), 'UTC+9:30')
      } finally {
        Intl.DateTimeFormat = orig
      }
    })

    it('既存の日付の関数（端末の時刻で決める）は変えていない', () => {
      assert.equal(FMT.isoDate(new Date(2026, 7, 28, 8, 30)), '2026-08-28')
      assert.equal(FMT.addDays('2026-08-31', 1), '2026-09-01')
    })
  })

}
