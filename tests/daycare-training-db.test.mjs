// デイ（せせらぎ）段階3a: db.ts の個別機能訓練・その日の配置の読み書きを、偽の Supabase で動かす（通信しない）。
// 段階3a の反証 中5（試験が文面の写しで、振る舞いを確かめていなかった）を受けて足した。活動の試験（daycare-activity.test.mjs）と同じ作り。
//
// ・insertTrainingSession: 保存・先に記録あり（taken・合流しない）・自分の送信の行き違い・送信待ち・未来の日／崩れた形は送らない
// ・送信待ちを送る時: 実施記録は他の端末の行と当たったら止める（stopped）→ 設定の〔いまの記録とくらべる〕の経路に載る・
//   〔自分の内容で直す〕で相手の行を直す（結果を替えても両向きの check に当たらない形）
// ・配置: 送信待ちを送る時に同じ鍵の行が先にあれば、届いたのと同じ（送信待ちから外れる・1行のまま）
// ・updateTrainingSession: 変えた列だけ送る。結果を替える時は時間・理由・一言を一緒に送る
// 個人情報は置かない（利用者・職員は数値IDだけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerLoadFailure } from './ts-load.mjs'

const lsStore = new Map()
let DB = null
let SO = null
let SYNC = null
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
      lsStore.set(k, String(v))
    },
    removeItem: (k) => {
      lsStore.delete(k)
    },
  }
  // 写しの手順（trainingDueSync.ts）が読む db.ts と同じ実体にする（クエリを付けると別の実体になり、偽の DB がつながらない）
  DB = await import('../src/lib/db.ts')
  SO = await import('../src/lib/stoppedOps.ts')
  SYNC = await import('../src/lib/trainingDueSync.ts')
} catch (e) {
  loadError = e
  DB = null
}

/** 偽の Supabase（実施記録・配置・app_settings だけ）。down=true の間は書き込みが 503 */
function fakeClient(state) {
  const builder = (table) => {
    const q = { table, filters: [], action: 'select', payload: null, single: false }
    const rows = () => state[table] ?? []
    const hit = (r) =>
      q.filters.every(([op, k, v]) =>
        op === 'eq' ? r[k] === v : op === 'is' ? (r[k] ?? null) === v : op === 'lt' ? r[k] < v : op === 'gte' ? r[k] >= v : op === 'neq' ? r[k] !== v : true,
      )
    const run = () => {
      state.calls.push({ table: q.table, action: q.action, payload: q.payload, filters: q.filters })
      if (q.table === 'app_settings') {
        const hits = (state.app_settings ?? []).filter(hit)
        return { data: q.single ? (hits[0] ?? null) : hits, error: null, status: 200 }
      }
      if (state.missingDue && q.table.startsWith('daycare_training_due')) {
        return { data: null, error: { message: "Could not find the table 'public.daycare_training_due'", code: 'PGRST205' }, status: 404 }
      }
      if (q.action === 'update') {
        if (state.down) return { data: null, error: { message: 'Service Unavailable', code: '' }, status: 503 }
        const r = rows().find(hit)
        if (!r) return { data: null, error: null, status: 200 }
        // DB の両向きの check の真似（実施記録）: 中止なら時間なし・理由あり、中止でなければ時間あり・理由なし
        const next = { ...r, ...q.payload }
        if (q.table === 'daycare_training_sessions') {
          const c = next.result === 'cancelled'
          if (c !== (next.duration_min === null) || c !== (next.cancel_reason !== null)) {
            return { data: null, error: { message: 'check', code: '23514' }, status: 400 }
          }
        }
        if (q.table === 'daycare_home_visits') {
          if (typeof state.beforeUpdate === 'function') state.beforeUpdate()
          const clash = rows().some((x) => x !== r && x.deleted_at === null && x.resident_id === next.resident_id && x.visited_on === next.visited_on && x.purpose === next.purpose)
          if (clash) return { data: null, error: { message: 'duplicate key value violates unique constraint "uq_daycare_home_visit"', code: '23505' }, status: 409 }
        }
        Object.assign(r, q.payload, { rev: r.rev + 1 })
        return { data: { ...r }, error: null, status: 200 }
      }
      if (q.action === 'insert') {
        if (state.down) return { data: null, error: { message: 'Service Unavailable', code: '' }, status: 503 }
        const p = q.payload
        const all = rows()
        const taken =
          all.some((r) => r.client_key === p.client_key) ||
          (q.table === 'daycare_training_sessions'
            ? all.some((r) => r.deleted_at === null && r.resident_id === p.resident_id && r.day === p.day)
            : q.table === 'daycare_home_visits'
              ? all.some((r) => r.deleted_at === null && r.resident_id === p.resident_id && r.visited_on === p.visited_on && r.purpose === p.purpose)
              : all.some((r) => r.deleted_at === null && r.day === p.day && r.staff_id === p.staff_id && r.role === p.role && (r.from_time ?? null) === (p.from_time ?? null)))
        if (taken) return { data: null, error: { message: 'duplicate key', code: '23505' }, status: 409 }
        const row = { id: state.nextId++, rev: 1, deleted_at: null, ...p }
        all.push(row)
        state[q.table] = all
        return { data: { ...row }, error: null, status: 201 }
      }
      if (state.selectFail && q.table === 'daycare_home_visits') return { data: null, error: { message: 'timeout', code: '' }, status: 0 }
      if (state.residentsFail && q.table === 'residents') return { data: null, error: { message: 'server error', code: 'XX000' }, status: 500 }
      const hits = rows().filter(hit)
      if (q.single) return { data: hits[0] ? { ...hits[0] } : null, error: null, status: 200 }
      return { data: hits.map((r) => ({ ...r })), error: null, status: 200 }
    }
    const b = {
      select: () => b,
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
      lt(k, v) {
        q.filters.push(['lt', k, v])
        return b
      },
      gte(k, v) {
        q.filters.push(['gte', k, v])
        return b
      },
      neq(k, v) {
        q.filters.push(['neq', k, v])
        return b
      },
      order: () => b,
      limit: () => b,
      maybeSingle() {
        q.single = true
        return Promise.resolve(run())
      },
      then(ok, ng) {
        return Promise.resolve(run()).then(ok, ng)
      },
    }
    return b
  }
  return {
    from: builder,
    rpc: (fn, args) => {
      state.calls.push({ table: null, action: 'rpc', fn, payload: args })
      if (fn === 'my_account') return Promise.resolve({ data: { role: state.role ?? 'office' }, error: null, status: 200 })
      if (fn === 'daycare_training_due_sync' && state.syncResult !== undefined) {
        if (state.syncResult === 'missing') return Promise.resolve({ data: null, error: { message: 'no', code: 'PGRST202' }, status: 404 })
        if (state.syncResult === 'forbidden') return Promise.resolve({ data: null, error: { message: 'training_due_office_only: x', code: '42501' }, status: 403 })
        return Promise.resolve({ data: state.syncResult, error: null, status: 200 })
      }
      return Promise.resolve({ data: null, error: { message: 'no', code: 'PGRST202' }, status: 404 })
    },
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: () => Promise.resolve(),
    auth: {
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } }
      },
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1' } } }, error: null }),
    },
  }
}

const DAY = '2026-10-21'
const visitFields = (over = {}) => ({
  visited_on: DAY,
  visitor_id: 3,
  purpose: 'periodic',
  life_status: '玄関の段差を確かめた（見本）',
  explained_to: null,
  explained_on: null,
  explanation: null,
  plan_revised: false,
  ...over,
})
const visitRow = (over = {}) => ({
  id: 70,
  resident_id: 1,
  ...visitFields({ visitor_id: 2, life_status: '先の記録（見本）' }),
  recorded_by: 2,
  rev: 1,
  client_key: 'other-hv',
  deleted_at: null,
  ...over,
})
const fields = (over = {}) => ({
  result: 'done',
  started_at: '10:00',
  duration_min: 20,
  program: '立ち上がり',
  instructor_id: 3,
  assisted_by: null,
  cancel_reason: null,
  cancel_note: null,
  note: null,
  ...over,
})
const sessionRow = (over = {}) => ({
  id: 7,
  resident_id: 1,
  day: DAY,
  started_at: '09:00:00',
  duration_min: 10,
  program: 'バランス',
  result: 'partial',
  cancel_reason: null,
  cancel_note: null,
  instructor_id: 2,
  assisted_by: null,
  note: null,
  recorded_by: 2,
  rev: 1,
  client_key: 'other',
  deleted_at: null,
  ...over,
})

if (DB === null) {
  registerLoadFailure('段階3a（機能訓練の db.ts）の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  const fresh = async (init = {}) => {
    lsStore.clear()
    await DB.__testHooks.restartQueue()
    const state = { daycare_training_sessions: [], daycare_staffing: [], daycare_home_visits: [], calls: [], nextId: 100, down: false, ...init }
    DB.__testHooks.setClient(fakeClient(state))
    return state
  }
  const done = async () => {
    DB.__testHooks.setClient(null)
    lsStore.clear()
    await DB.__testHooks.restartQueue()
  }

  describe('insertTrainingSession（偽の Supabase・通信しない）', () => {
    it('足せた時は saved。冪等キーを付け、内容・結果・時間・指導員を送る', async () => {
      const st = await fresh()
      const r = await DB.insertTrainingSession({ resident_id: 1, day: DAY, recorded_by: 4, ...fields() })
      assert.equal(r.kind, 'saved')
      assert.equal(r.row.program, '立ち上がり')
      assert.equal(r.row.started_at, '10:00')
      const ins = st.calls.find((c) => c.action === 'insert')
      assert.match(ins.payload.client_key, /\S/)
      assert.equal(ins.payload.duration_min, 20)
      assert.equal(ins.payload.cancel_reason, null)
      await done()
    })
    it('2台目が同じ方・同じ日を記録した時は taken（合流しない・先の行を返す）', async () => {
      await fresh({ daycare_training_sessions: [sessionRow()] })
      const r = await DB.insertTrainingSession({ resident_id: 1, day: DAY, recorded_by: 4, ...fields() })
      assert.equal(r.kind, 'taken')
      assert.equal(r.row.id, 7)
      assert.equal(r.row.result, 'partial')
      await done()
    })
    it('通信できない時は送信待ち（queued）。この端末の送信待ちに追加として出る', async () => {
      const st = await fresh()
      st.down = true
      const r = await DB.insertTrainingSession({ resident_id: 2, day: DAY, recorded_by: 4, ...fields() })
      assert.equal(r.kind, 'queued')
      assert.deepEqual(
        DB.pendingTrainingOps().map((p) => [p.kind, p.table, p.residentId, p.day, p.stopped]),
        [['add', 'daycare_training_sessions', 2, DAY, false]],
      )
      await done()
    })
    it('未来の日・崩れた形（中止で時間あり・理由なし・内容が空・時間が範囲の外）は送らない（通信しない）', async () => {
      const st = await fresh()
      await assert.rejects(DB.insertTrainingSession({ resident_id: 1, day: '2999-01-01', recorded_by: 4, ...fields() }), /未来の日/)
      for (const bad of [
        fields({ result: 'cancelled', duration_min: 20, cancel_reason: 'condition' }),
        fields({ result: 'cancelled', duration_min: null }),
        fields({ program: '' }),
        fields({ duration_min: 241 }),
        fields({ cancel_reason: 'condition' }),
      ]) {
        await assert.rejects(DB.insertTrainingSession({ resident_id: 1, day: DAY, recorded_by: 4, ...bad }), /内容が足りません/)
      }
      assert.equal(st.calls.filter((c) => c.action === 'insert').length, 0)
      await done()
    })
  })

  describe('送信待ちを送る時（偽の Supabase）', () => {
    it('実施記録: 圏外の間に他の端末が同じ方を記録していたら止める（stopped）。設定の〔いまの記録とくらべる〕の経路に載る', async () => {
      const st = await fresh()
      st.down = true
      await DB.insertTrainingSession({ resident_id: 1, day: DAY, recorded_by: 4, ...fields({ result: 'cancelled', duration_min: null, cancel_reason: 'condition' }) })
      st.daycare_training_sessions.push(sessionRow())
      st.down = false
      await DB.flushQueue(true)
      const left = DB.pendingTrainingOps()
      assert.deepEqual(left.map((p) => [p.kind, p.table, p.stopped]), [['add', 'daycare_training_sessions', true]])
      assert.equal(st.daycare_training_sessions.filter((r) => r.resident_id === 1 && r.deleted_at === null).length, 1, '1件のまま')
      assert.equal(SO.stoppedOpNeedsCompare({ table: 'daycare_training_sessions', kind: 'insert', state: 'conflict' }), true)
      await done()
    })
    it('〔自分の内容で直す〕: 見せた相手の行（id・版）を、この端末の中身（中止）で直す。両向きの check に当たらない形で送る', async () => {
      const st = await fresh()
      st.down = true
      await DB.insertTrainingSession({ resident_id: 1, day: DAY, recorded_by: 4, ...fields({ result: 'cancelled', duration_min: null, cancel_reason: 'condition' }) })
      st.daycare_training_sessions.push(sessionRow())
      st.down = false
      await DB.flushQueue(true)
      const stopped = DB.listStoppedOps().find((o) => o.table === 'daycare_training_sessions')
      assert.ok(stopped, '設定の「送れていない記録」に出る')
      assert.equal(stopped.state, 'conflict')
      const target = await DB.fetchQueuedOpTarget(stopped.qid)
      assert.deepEqual([target?.id, target?.rev, target?.result], [7, 1, 'partial'], '並べて見せる相手の行')
      const qid = stopped.qid
      const r = await DB.resendQueuedOp(qid, { id: 7, rev: 1 })
      assert.equal(r, 'sent')
      const row = st.daycare_training_sessions.find((x) => x.id === 7)
      assert.deepEqual([row.result, row.duration_min, row.cancel_reason, row.rev], ['cancelled', null, 'condition', 2])
      // 指導員はこの端末の値に替わり、記入者は相手のまま（直した職員は edited_by に残る）。自然キー・冪等キーは送らない
      assert.deepEqual([row.instructor_id, row.recorded_by, row.edited_by, row.client_key], [3, 2, 4, 'other'])
      const up = st.calls.filter((c) => c.action === 'update').at(-1)
      for (const k of ['resident_id', 'day', 'client_key', 'recorded_by']) assert.equal(k in up.payload, false, `${k} は送らない`)
      assert.deepEqual(DB.pendingTrainingOps(), [])
      await done()
    })
    it('〔いまの記録とくらべる〕に指導員・補助・中止の一言を出す（直しの確認の反証 中2: 違いが見えないまま相手の指導員を書き換えない）', () => {
      const op = { table: 'daycare_training_sessions', kind: 'insert', payload: { resident_id: 1, day: DAY, recorded_by: 4, client_key: 'k', ...fields({ instructor_id: 3 }) } }
      const theirs = sessionRow({ instructor_id: 2, assisted_by: 5, result: 'done', duration_min: 20, program: '立ち上がり', started_at: '10:00:00' })
      const name = (id) => `見本 職員${id}`
      const mine = SO.stoppedOpLines(op, (id) => `利用者${id}`, undefined, name)
      const now = SO.stoppedOpLines(op, (id) => `利用者${id}`, theirs, name)
      const pick = (lines, label) => lines.find((l) => l.label === label)?.value
      assert.deepEqual([pick(mine, '指導員'), pick(now, '指導員')], ['見本 職員3', '見本 職員2'])
      assert.deepEqual([pick(mine, '補助'), pick(now, '補助')], ['なし', '見本 職員5'])
      assert.equal(pick(mine, '中止の一言'), '未入力')
      assert.equal(pick(mine, 'ほか'), undefined, '数だけの欄は残らない')
      // 氏名を引けない時は番号で出す（同じに見えない）
      assert.equal(pick(SO.stoppedOpLines(op, (id) => `利用者${id}`), '指導員'), '職員ID 3')
    })
    it('配置: 圏外の間に同じ日・同じ職員・同じ役割・同じ開始の時刻が入っていたら、届いたのと同じ（送信待ちから外れ・1行のまま）', async () => {
      const st = await fresh()
      st.down = true
      const r = await DB.insertStaffing({ day: DAY, staff_id: 3, role: 'trainer', from_time: null, to_time: null, recorded_by: 4 })
      assert.equal(r.kind, 'queued')
      st.daycare_staffing.push({ id: 9, day: DAY, staff_id: 3, role: 'trainer', from_time: null, to_time: null, note: null, rev: 1, client_key: 'o-9', deleted_at: null })
      st.down = false
      await DB.flushQueue(true)
      assert.deepEqual(DB.pendingTrainingOps(), [])
      assert.equal(st.daycare_staffing.filter((x) => x.deleted_at === null).length, 1)
      await done()
    })
    it('配置: 送信待ちの追加は時間帯を持つ（落とすと終日の指導員に見えて〔完了〕の指導員を取り違える＝直しの確認の反証 中1）', async () => {
      const st = await fresh()
      st.down = true
      await DB.insertStaffing({ day: DAY, staff_id: 11, role: 'trainer', from_time: '09:00', to_time: '12:00', recorded_by: 4 })
      assert.deepEqual(
        DB.pendingTrainingOps().map((p) => [p.kind, p.table, p.staffId, p.fromTime, p.toTime, p.stopped]),
        [['add', 'daycare_staffing', 11, '09:00', '12:00', false]],
      )
      await done()
    })
    it('配置: 開始が同じでも終わりの時刻が違えば「届いた」にせず止める。〔自分の内容で直す〕で相手の行の終わりの時刻を直す（直しの確認の反証 軽3）', async () => {
      const st = await fresh()
      st.down = true
      await DB.insertStaffing({ day: DAY, staff_id: 3, role: 'trainer', from_time: '09:00', to_time: '16:00', recorded_by: 4 })
      st.daycare_staffing.push({ id: 9, day: DAY, staff_id: 3, role: 'trainer', from_time: '09:00', to_time: '12:00', note: null, recorded_by: 2, rev: 1, client_key: 'o-9', deleted_at: null })
      st.down = false
      await DB.flushQueue(true)
      assert.deepEqual(DB.pendingTrainingOps().map((p) => [p.kind, p.table, p.stopped]), [['add', 'daycare_staffing', true]], '16:00 を黙って捨てない')
      const stopped = DB.listStoppedOps().find((o) => o.table === 'daycare_staffing')
      assert.equal(SO.stoppedOpNeedsCompare(stopped), true)
      const target = await DB.fetchQueuedOpTarget(stopped.qid)
      assert.deepEqual([target?.id, target?.rev, target?.to_time], [9, 1, '12:00'], '並べて見せる相手の行')
      assert.equal(await DB.resendQueuedOp(stopped.qid, { id: 9, rev: 1 }), 'sent')
      const live = st.daycare_staffing.filter((x) => x.deleted_at === null)
      assert.equal(live.length, 1)
      assert.deepEqual([live[0].id, live[0].to_time, live[0].from_time, live[0].recorded_by, live[0].rev], [9, '16:00', '09:00', 2, 2])
      assert.deepEqual(DB.pendingTrainingOps(), [])
      await done()
    })
  })

  describe('updateTrainingSession（偽の Supabase）', () => {
    it('変えた列だけ送る。結果を中止に替える時は、時間・理由・一言を一緒に送る', async () => {
      const cur = { ...sessionRow(), started_at: '09:00' }
      const st = await fresh({ daycare_training_sessions: [sessionRow()] })
      const r1 = await DB.updateTrainingSession(cur, { ...fields({ result: 'partial', started_at: '09:00', duration_min: 15, program: 'バランス', instructor_id: 2 }) }, { editedBy: 4 })
      assert.notEqual(r1, 'conflict')
      const up1 = st.calls.filter((c) => c.action === 'update').at(-1)
      assert.deepEqual(Object.keys(up1.payload).filter((k) => k !== 'edited_by').sort(), ['duration_min'])
      const now = st.daycare_training_sessions[0]
      const r2 = await DB.updateTrainingSession(
        { ...cur, duration_min: 15, rev: now.rev },
        fields({ result: 'cancelled', started_at: '09:00', duration_min: null, program: 'バランス', instructor_id: 2, cancel_reason: 'refused' }),
        { editedBy: 4 },
      )
      assert.notEqual(r2, 'conflict')
      const up2 = st.calls.filter((c) => c.action === 'update').at(-1)
      assert.deepEqual(
        Object.keys(up2.payload).filter((k) => k !== 'edited_by').sort(),
        ['cancel_note', 'cancel_reason', 'duration_min', 'result'],
      )
      assert.deepEqual([now.result, now.duration_min, now.cancel_reason], ['cancelled', null, 'refused'])
      await done()
    })
  })

  describe('居宅訪問（段階3b・偽の Supabase）', () => {
    it('足せた時は saved（冪等キーつき）。同じ方・同じ日で目的が違えば別の記録', async () => {
      const st = await fresh({ daycare_home_visits: [visitRow({ purpose: 'initial' })] })
      const r = await DB.insertHomeVisit({ resident_id: 1, recorded_by: 4, ...visitFields() })
      assert.equal(r.kind, 'saved')
      assert.equal(r.row.purpose, 'periodic')
      const ins = st.calls.find((c) => c.action === 'insert' && c.table === 'daycare_home_visits')
      assert.match(ins.payload.client_key, /\S/)
      assert.equal(st.daycare_home_visits.filter((x) => x.deleted_at === null).length, 2)
      await done()
    })
    it('2台目が同じ方・同じ日・同じ目的を記録した時は taken（合流しない・先の行を返す）', async () => {
      await fresh({ daycare_home_visits: [visitRow()] })
      const r = await DB.insertHomeVisit({ resident_id: 1, recorded_by: 4, ...visitFields() })
      assert.equal(r.kind, 'taken')
      assert.deepEqual([r.row.id, r.row.life_status], [70, '先の記録（見本）'])
      await done()
    })
    it('通信できない時は送信待ち（queued）。この端末の送信待ちに追加として出る', async () => {
      const st = await fresh()
      st.down = true
      assert.equal((await DB.insertHomeVisit({ resident_id: 2, recorded_by: 4, ...visitFields() })).kind, 'queued')
      assert.deepEqual(DB.pendingHomeVisitOps(), [{ kind: 'add', residentId: 2, visitedOn: DAY, purpose: 'periodic', stopped: false }])
      assert.deepEqual(DB.pendingTrainingOps(), [], '機能訓練・配置の一覧には混ぜない')
      await done()
    })
    it('未来の訪問日・説明の日、崩れた形（生活の状況が空・501字・知らない目的）は送らない（通信しない）', async () => {
      const st = await fresh()
      await assert.rejects(DB.insertHomeVisit({ resident_id: 1, recorded_by: 4, ...visitFields({ visited_on: '2999-01-01' }) }), /未来の日/)
      await assert.rejects(DB.insertHomeVisit({ resident_id: 1, recorded_by: 4, ...visitFields({ explained_to: 'user', explained_on: '2999-01-01' }) }), /未来の日/)
      for (const bad of [visitFields({ life_status: '  ' }), visitFields({ life_status: 'あ'.repeat(501) }), visitFields({ purpose: 'other' }), visitFields({ visitor_id: 0 })]) {
        await assert.rejects(DB.insertHomeVisit({ resident_id: 1, recorded_by: 4, ...bad }), /内容が足りません/)
      }
      assert.equal(st.calls.filter((c) => c.action === 'insert').length, 0)
      await done()
    })
    it('送信待ちが他の端末の同じ記録と当たったら止める。〔自分の内容で直す〕で相手の行を直す（記入者・自然キーは送らない）', async () => {
      const st = await fresh()
      st.down = true
      await DB.insertHomeVisit({ resident_id: 1, recorded_by: 4, ...visitFields({ explained_to: 'family', explained_on: DAY }) })
      st.daycare_home_visits.push(visitRow())
      st.down = false
      await DB.flushQueue(true)
      assert.deepEqual(DB.pendingHomeVisitOps().map((p) => [p.kind, p.stopped]), [['add', true]])
      const stopped = DB.listStoppedOps().find((o) => o.table === 'daycare_home_visits')
      assert.equal(SO.stoppedOpNeedsCompare(stopped), true)
      const target = await DB.fetchQueuedOpTarget(stopped.qid)
      assert.deepEqual([target?.id, target?.rev], [70, 1])
      // くらべる画面に訪問した職員・説明の相手と日が出る（違いが見える）
      const name = (id) => `見本 職員${id}`
      const pick = (lines, label) => lines.find((l) => l.label === label)?.value
      const mine = SO.stoppedOpLines(stopped, (id) => `利用者${id}`, undefined, name)
      const now = SO.stoppedOpLines(stopped, (id) => `利用者${id}`, target, name)
      assert.deepEqual([pick(mine, '訪問した職員'), pick(now, '訪問した職員')], ['見本 職員3', '見本 職員2'])
      assert.deepEqual([pick(mine, '説明した相手'), pick(now, '説明した相手')], ['家族', '未入力'])
      assert.equal(pick(mine, '日付'), '10/21')
      assert.equal(await DB.resendQueuedOp(stopped.qid, { id: 70, rev: 1 }), 'sent')
      const row = st.daycare_home_visits.find((x) => x.id === 70)
      assert.deepEqual([row.visitor_id, row.explained_to, row.recorded_by, row.edited_by, row.rev], [3, 'family', 2, 4, 2])
      const up = st.calls.filter((c) => c.action === 'update').at(-1)
      for (const k of ['resident_id', 'visited_on', 'purpose', 'client_key', 'recorded_by']) assert.equal(k in up.payload, false, `${k} は送らない`)
      assert.deepEqual(DB.pendingHomeVisitOps(), [])
      await done()
    })
    it('updateHomeVisit: 後日に説明を足す時は、説明の欄だけを送る', async () => {
      const st = await fresh({ daycare_home_visits: [visitRow()] })
      const cur = { ...visitRow(), explained_to: null, explained_on: null }
      const r = await DB.updateHomeVisit(cur, { ...visitFields({ visitor_id: 2, life_status: '先の記録（見本）' }), explained_to: 'both', explained_on: '2026-10-22', explanation: null }, { editedBy: 4 })
      assert.notEqual(r, 'conflict')
      const up = st.calls.filter((c) => c.action === 'update').at(-1)
      assert.deepEqual(Object.keys(up.payload).filter((k) => k !== 'edited_by').sort(), ['explained_on', 'explained_to'])
      await done()
    })
    it('updateHomeVisit: 訪問日・目的を同じ方の別の記録と同じにする時は送らずに止める（反証 中1）。空いている日なら送る', async () => {
      const other = visitRow({ id: 71, visited_on: '2026-10-20', client_key: 'other-71' })
      const st = await fresh({ daycare_home_visits: [visitRow(), other] })
      const cur = { ...visitRow() }
      await assert.rejects(
        DB.updateHomeVisit(cur, { ...visitFields({ visitor_id: 2, life_status: '先の記録（見本）' }), visited_on: '2026-10-20' }, { editedBy: 4 }),
        /同じ方・同じ日・同じ目的の居宅訪問の記録が、すでにあります/,
      )
      assert.equal(st.calls.filter((c) => c.action === 'update').length, 0)
      const r = await DB.updateHomeVisit(cur, { ...visitFields({ visitor_id: 2, life_status: '先の記録（見本）' }), visited_on: '2026-10-19' }, { editedBy: 4 })
      assert.notEqual(r, 'conflict')
      assert.equal(st.daycare_home_visits.find((x) => x.id === 70).visited_on, '2026-10-19')
      await done()
    })
    it('updateHomeVisit の重なりの確かめ（確認の反証 軽1・軽5）: 取り消し済みの行とは重ならない・目的だけ変えても重なれば止める', async () => {
      const gone = visitRow({ id: 72, visited_on: '2026-10-19', client_key: 'gone-72', deleted_at: '2026-10-22T00:00:00Z' })
      const initial = visitRow({ id: 73, purpose: 'initial', client_key: 'init-73' })
      const st = await fresh({ daycare_home_visits: [visitRow(), gone, initial] })
      const base = { ...visitFields({ visitor_id: 2, life_status: '先の記録（見本）' }) }
      // 取り消し済みの 10/19・定期とは重ならない（送る）
      await DB.updateHomeVisit({ ...visitRow() }, { ...base, visited_on: '2026-10-19' }, { editedBy: 4 })
      assert.equal(st.daycare_home_visits.find((x) => x.id === 70).visited_on, '2026-10-19')
      // 目的だけを初回に変えると、10/21・初回（73）と重なる→ 送らずに止める
      const cur = { ...st.daycare_home_visits.find((x) => x.id === 73), purpose: 'periodic', id: 74, rev: 1 }
      st.daycare_home_visits.push({ ...cur, client_key: 'p-74' })
      const before = st.calls.filter((c) => c.action === 'update').length
      await assert.rejects(DB.updateHomeVisit(cur, { ...base, purpose: 'initial' }, { editedBy: 4 }), /すでにあります/)
      assert.equal(st.calls.filter((c) => c.action === 'update').length, before)
      await done()
    })
    it('updateHomeVisit: 確かめを読めない時は止めずに送る。確かめの後に他の端末が同じ鍵で記録した時（23505）は重なりの知らせにする', async () => {
      const st = await fresh({ daycare_home_visits: [visitRow()] })
      const base = { ...visitFields({ visitor_id: 2, life_status: '先の記録（見本）' }) }
      st.selectFail = true
      const r = await DB.updateHomeVisit({ ...visitRow() }, { ...base, visited_on: '2026-10-18' }, { editedBy: 4 })
      assert.notEqual(r, 'conflict')
      assert.equal(st.daycare_home_visits.find((x) => x.id === 70).visited_on, '2026-10-18', '読めなくても送った')
      st.selectFail = false
      // 確かめの時は空いていたが、送るまでに他の端末が 10/17・定期を記録した
      st.beforeUpdate = () => {
        if (!st.daycare_home_visits.some((x) => x.id === 80)) st.daycare_home_visits.push(visitRow({ id: 80, visited_on: '2026-10-17', client_key: 'race-80' }))
      }
      const now = st.daycare_home_visits.find((x) => x.id === 70)
      await assert.rejects(DB.updateHomeVisit({ ...visitRow(), visited_on: now.visited_on, rev: now.rev }, { ...base, visited_on: '2026-10-17' }, { editedBy: 4 }), /すでにあります/)
      await done()
    })
    it('くらべる画面の日付: いまの記録を並べる時は、その行の訪問日を出す（反証 軽1）', () => {
      const op = { table: 'daycare_home_visits', kind: 'update', payload: { visited_on: '2026-10-21' } }
      const pick = (lines) => lines.find((l) => l.label === '日付')?.value
      assert.equal(pick(SO.stoppedOpLines(op, (id) => `利用者${id}`)), '10/21')
      assert.equal(pick(SO.stoppedOpLines(op, (id) => `利用者${id}`, { visited_on: '2026-10-20', resident_id: 1 })), '10/20')
    })
    it('fetchTrainingDueCopy: 写しの行は読むだけ。設定の行が無い時は null（暦の月・28日として数える）。表が無い時は「まだ使えません」', async () => {
      const st = await fresh({ daycare_training_due: [{ resident_id: 5, latest_plan_date: '2026-09-01', next_due: '2026-12-01', stop_reason: null, stop_from: null, plan_status: 'signed', synced_at: '2026-10-23T00:00:00Z', deleted_at: null }] })
      const r = await DB.fetchTrainingDueCopy()
      assert.deepEqual(r.rows, [{ resident_id: 5, latest_plan_date: '2026-09-01', next_due: '2026-12-01', stop_reason: null, stop_from: null }])
      assert.equal(r.settings, null)
      assert.equal(st.calls.filter((c) => c.action !== 'select').length, 0, '読むだけ')
      st.missingDue = true
      await assert.rejects(DB.fetchTrainingDueCopy(), (e) => DB.isTrainingMissingError(e))
      await done()
    })
  })

  describe('計画書の期限の写し（段階3c・偽の Supabase・偽の計画書アプリ）', () => {
    const FAKE_URL = 'https://script.google.com/macros/s/FAKE-TEST/exec'
    const resident = (id, sourceId) => ({ id, source_id: sourceId, name: `見本 利用者${id}`, kana: null, room: String(100 + id), gender: null, care_level: null, active: true, needs_review: false, note_alias: null })
    const INDEX = { v: 1, rows: { T001: { nameNorm: '見本花子', latestPlanDate: '2026-08-01', nextDue: '2026-11-01', status: 'signed' } }, settings: { dueRule: 'calendar', warnDays: 28, staff: [{ id: '1', name: '見本 職員一' }] } }
    /** 計画書アプリへの通信を数える偽の fetch（本物へはつながない） */
    const withFakePlanApp = async (fn) => {
      const prev = globalThis.fetch
      const seen = []
      globalThis.fetch = async (url, init) => {
        seen.push({ url, body: JSON.parse(init.body) })
        return new Response(JSON.stringify({ ok: true, rev: 3, data: INDEX }), { status: 200 })
      }
      try {
        return { out: await fn(), seen }
      } finally {
        globalThis.fetch = prev
      }
    }
    it('事務所: 索引を読み、写す分だけを関数に渡す（写した職員はいまの記録者）。結果をそのまま返す', async () => {
      const st = await fresh({ role: 'office', residents: [resident(1, 'T001')], syncResult: { ok: true, written: 1, unmatched: 0, cancelled: 0, synced_at: 'x' } })
      lsStore.set('tp_cfg', JSON.stringify({ url: FAKE_URL, token: 'fake-token' }))
      const { out, seen } = await withFakePlanApp(() => SYNC.syncTrainingPlanDue(4))
      assert.deepEqual(out, { kind: 'done', result: { ok: true, written: 1, unmatched: 0, cancelled: 0 } })
      assert.deepEqual(seen.map((x) => [x.url, x.body.action, x.body.key]), [[FAKE_URL, 'get', 'training_plan:index']])
      const call = st.calls.find((c) => c.fn === 'daycare_training_due_sync')
      assert.deepEqual(call.payload, {
        p_rows: [{ master_id: 'T001', latest_plan_date: '2026-08-01', next_due: '2026-11-01', stop_reason: null, stop_from: null, plan_status: 'signed' }],
        p_settings: { due_rule: 'calendar', warn_days: 28 },
        p_staff: 4,
      })
      assert.equal(JSON.stringify(call.payload).includes('見本'), false, '氏名・職員の一覧は送らない')
      assert.equal(lsStore.get('tp_cfg'), JSON.stringify({ url: FAKE_URL, token: 'fake-token' }), '接続設定は書き換えない')
      await done()
    })
    it('現場: 役割を先に見て止める。接続設定を読まず、計画書アプリへも DB の関数へも送らない', async () => {
      const st = await fresh({ role: 'field', syncResult: { ok: true, written: 1, unmatched: 0, cancelled: 0 } })
      lsStore.set('tp_cfg', JSON.stringify({ url: FAKE_URL, token: 'fake-token' }))
      const read = []
      const realGet = globalThis.localStorage.getItem
      globalThis.localStorage.getItem = (k) => {
        read.push(k)
        return realGet(k)
      }
      try {
        const { out, seen } = await withFakePlanApp(() => SYNC.syncTrainingPlanDue(4))
        assert.deepEqual(out, { kind: 'role' })
        assert.equal(seen.length, 0)
        assert.equal(read.includes('tp_cfg'), false)
        assert.equal(st.calls.some((c) => c.fn === 'daycare_training_due_sync'), false)
      } finally {
        globalThis.localStorage.getItem = realGet
      }
      await done()
    })
    it('送る前の突き合わせ（反証 中1）: care-log の利用者と1人も結べない索引は、写しの関数を呼ばずに止める。名簿を読めない時も写さない', async () => {
      const st = await fresh({ role: 'office', residents: [resident(1, 'X001'), resident(2, 'X002')], syncResult: { ok: true, written: 0, unmatched: 1, cancelled: 0 } })
      lsStore.set('tp_cfg', JSON.stringify({ url: FAKE_URL, token: 'fake-token' }))
      const { out } = await withFakePlanApp(() => SYNC.syncTrainingPlanDue(4))
      assert.equal(out.kind, 'fail')
      assert.match(out.text, /1人も結べなかったため、写しませんでした/)
      assert.equal(st.calls.some((c) => c.fn === 'daycare_training_due_sync'), false)
      st.residentsFail = true
      const again = await withFakePlanApp(() => SYNC.syncTrainingPlanDue(4))
      assert.equal(again.out.kind, 'fail')
      assert.match(again.out.text, /名簿を読めなかった/)
      assert.equal(st.calls.some((c) => c.fn === 'daycare_training_due_sync'), false)
      await done()
    })
    it('写せる行が1つも無い索引は、名簿も読まず写しの関数も呼ばずに止める（確認の反証 軽1）', async () => {
      const st = await fresh({ role: 'office', residents: [resident(1, 'T001')], syncResult: { ok: true, written: 0, unmatched: 0, cancelled: 0 } })
      lsStore.set('tp_cfg', JSON.stringify({ url: FAKE_URL, token: 'fake-token' }))
      const prev = globalThis.fetch
      globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, rev: 1, data: { v: 1, rows: {}, settings: {} } }), { status: 200 })
      try {
        const out = await SYNC.syncTrainingPlanDue(4)
        assert.equal(out.kind, 'fail')
        assert.match(out.text, /写せる利用者が1人もいなかったため、写しませんでした。何も書いていません/)
        assert.equal(st.calls.some((c) => c.fn === 'daycare_training_due_sync'), false)
        assert.equal(st.calls.some((c) => c.table === 'residents'), false)
      } finally {
        globalThis.fetch = prev
      }
      await done()
    })
    it('止めた時（空上書きの保護）は理由をそのまま返す。関数が無い DB は「まだ使えません」・現場の 42501 は権限の文', async () => {
      await fresh({ role: 'office', syncResult: { ok: false, reason: 'nomatch', existing: 8, incoming: 6 } })
      assert.deepEqual(await DB.syncTrainingDue([], { due_rule: 'calendar', warn_days: 28 }, 4), { ok: false, reason: 'nomatch', existing: 8, incoming: 6, cancel: null })
      await fresh({ role: 'office', syncResult: 'missing' })
      await assert.rejects(DB.syncTrainingDue([], { due_rule: 'calendar', warn_days: 28 }, 4), (e) => DB.isTrainingMissingError(e))
      await fresh({ role: 'office', syncResult: 'forbidden' })
      await assert.rejects(DB.syncTrainingDue([], { due_rule: 'calendar', warn_days: 28 }, 4), (e) => e instanceof DB.DbError && e.kind === 'forbidden')
      await done()
    })
    it('機能訓練の旗が閉じている間は写さない（関数を呼ばない）', async () => {
      lsStore.clear()
      await DB.__testHooks.restartQueue()
      const state = {
        daycare_training_sessions: [],
        daycare_staffing: [],
        daycare_home_visits: [],
        app_settings: [{ key: 'input_enabled_daycare_training', value: 'false' }],
        calls: [],
        nextId: 100,
        down: false,
        role: 'office',
        syncResult: { ok: true, written: 1, unmatched: 0, cancelled: 0 },
      }
      DB.__testHooks.setClient(fakeClient(state), { kinds: { daycare_training: false } })
      await assert.rejects(DB.syncTrainingDue([], { due_rule: 'calendar', warn_days: 28 }, 4), (e) => e instanceof DB.DbError && e.kind === 'blocked')
      assert.equal(state.calls.some((c) => c.fn === 'daycare_training_due_sync'), false)
      await done()
    })
  })
}
