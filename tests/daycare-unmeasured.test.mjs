// デイ（せせらぎ）のバイタル・食事の〔未測定〕を入力済みに（2026-11-10 親の決定・案1＝別の表 daycare_vital_unmeasured・移行 0062）の試験。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycareProgress.ts・src/lib/daycareContact.ts）: 印のある欄は入力済みに数える・値のある欄の印は無視する（値が優先）・
//    回ごとの印・読み込みと行き違った端末の操作を重ねる・連絡帳の紙面は「未測定」と「記録なし」を分ける
// 2. db.ts を偽の Supabase で動かす（通信しない）: 読む（表が無い時は印なし）・付ける（同じ欄に印があれば足さない・23505 は読み直し）・
//    外す（論理削除・rev 照合・0行は読み直し）・送信待ちに積まない・通信できない時と守りで止まった時の文・未来の日と崩れた形は送らない
// 3. 静的検査: 移行 0062（足すだけ・RLS・守り・権限・最後の確かめ・戻し方）・画面（読み込みの回に1本・購読を足さない・「未測定」の字・
//    凡例・〔元に戻す〕の部品・今日の画面と連絡帳の読み込み）・vitals と保存の関数に触れない
// 4. 2026-11-10 反証の直し: 印だけの回も行に出す・次の〔＋再測定〕の回に印の回を使わない（中1）・数える回を両画面で同じ純関数で決める（軽2）・
//    印を読めなかった時の知らせと紙の「読み込めませんでした」（軽3）・値を保存できた欄の失敗の知らせを消す（軽4）・送信中の欄は進めない（軽5）・
//    凡例の4語を元に戻して3語を足し、1180px で2段のまま（軽6）・件数の帯「バイタル未」は5欄とも値か印なら済（軽7）
// 個人情報は置かない（利用者は数値IDと「利用者01」だけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
/** 行コメントと複数行コメントを除いた本文 */
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
/** SQL の行コメントを除いた本文 */
const sqlCode = (p) => read(p).replace(/--.*$/gm, '')

const lsStore = new Map()
let P = null
let C = null
let TH = null
let DB = null
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
  P = await import('../src/lib/daycareProgress.ts')
  C = await import('../src/lib/daycareContact.ts')
  TH = await import('../src/lib/vitalThresholds.ts')
  DB = await import('../src/lib/db.ts')
} catch (e) {
  loadError = e
  P = null
}

const DAY = '2026-11-02'
const T = 'daycare_vital_unmeasured'
/** 印の行 */
const mark = (over = {}) => ({ id: 1, resident_id: 1, day: DAY, seq: 1, field: 'temp', rev: 1, ...over })

/** 偽の Supabase（〔未測定〕の印の表と app_settings だけ）。down＝書き込みが 503・missing＝表が無い・guard＝過去の日の守りで止める */
function fakeClient(state) {
  const builder = (table) => {
    const q = { table, filters: [], action: 'select', payload: null, single: false }
    const rows = () => state[table] ?? []
    const hit = (r) => q.filters.every(([op, k, v]) => (op === 'eq' ? r[k] === v : op === 'is' ? (r[k] ?? null) === v : true))
    const run = () => {
      state.calls.push({ table: q.table, action: q.action, payload: q.payload, filters: q.filters })
      if (q.table === 'app_settings') {
        const hits = (state.app_settings ?? []).filter(hit)
        return { data: q.single ? (hits[0] ?? null) : hits, error: null, status: 200 }
      }
      if (state.missing) return { data: null, error: { message: `Could not find the table 'public.${T}'`, code: 'PGRST205' }, status: 404 }
      if (q.action !== 'select' && state.down) return { data: null, error: { message: 'Service Unavailable', code: '' }, status: 503 }
      if (q.action !== 'select' && state.guard) {
        return { data: null, error: { message: 'daycare_unmeasured_past_office_only: 過去の日の〔未測定〕は…', code: '42501' }, status: 403 }
      }
      if (q.action === 'select' && state.readFail) return { data: null, error: { message: 'server error', code: 'XX000' }, status: 500 }
      if (q.action === 'update') {
        if (typeof state.beforeUpdate === 'function') state.beforeUpdate()
        const r = rows().find(hit)
        if (!r) return { data: null, error: null, status: 200 }
        Object.assign(r, q.payload, { rev: r.rev + 1 })
        return { data: { id: r.id }, error: null, status: 200 }
      }
      if (q.action === 'insert') {
        const p = q.payload
        const all = rows()
        if (all.some((r) => r.deleted_at === null && r.resident_id === p.resident_id && r.day === p.day && r.seq === p.seq && r.field === p.field)) {
          return { data: null, error: { message: 'duplicate key value violates unique constraint "uq_daycare_vital_unmeasured"', code: '23505' }, status: 409 }
        }
        const row = { id: state.nextId++, rev: 1, deleted_at: null, ...p }
        all.push(row)
        state[q.table] = all
        return { data: { ...row }, error: null, status: 201 }
      }
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
    rpc: () => Promise.resolve({ data: null, error: { message: 'no', code: 'PGRST202' }, status: 404 }),
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

if (P === null) {
  registerLoadFailure('〔未測定〕（0062）の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('〔未測定〕の数え方と表示（純ロジック・daycareProgress.ts）', () => {
    it('印のある欄は入力済みに数える（1人5欄のうち印の欄を除く）・印を渡さなければ今と同じ', () => {
      const vals = { temp: null, sys_bp: 120, dia_bp: 70, pulse: null, spo2: null }
      assert.equal(P.vitalBlankFields(vals), 3)
      assert.equal(P.vitalBlankFields(vals, new Set(['temp', 'spo2'])), 1)
      assert.equal(P.vitalBlankFields(null, new Set(['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2'])), 0)
      assert.equal(P.vitalBlankFields(null), 5)
      assert.equal(P.vitalBlankFields(null, null), 5)
      // 値のある欄に印があっても数は同じ（値が優先・二重に数えない）
      assert.equal(P.vitalBlankFields(vals, new Set(['sys_bp'])), 3)
    })
    it('バイタル・食事の1人7欄: 印の欄は入力済み・昼食の拒食と同じ考え（画面の上の数と切り替えの数の材料）', () => {
      const v = P.vitalBlankFields({ temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null }, new Set(['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2']))
      assert.equal(P.vitalsMealsBlankFields(v, P.lunchBlankFields({ main_amount: null, side_amount: null, status: 'refused' })), 0)
      assert.equal(P.bulkBlankSummary([v, 2]).people, 1)
    })
    it('印の欄は回ごと（seq を省くとどれかの回）・ほかの方・ほかの日の印は数えない', () => {
      const rows = [mark(), mark({ id: 2, seq: 2, field: 'spo2' }), mark({ id: 3, resident_id: 2, field: 'pulse' }), mark({ id: 4, day: '2026-11-01', field: 'sys_bp' })]
      assert.deepEqual([...P.unmeasuredFieldsOf(rows, 1, DAY, 1)].sort(), ['temp'])
      assert.deepEqual([...P.unmeasuredFieldsOf(rows, 1, DAY, 2)].sort(), ['spo2'])
      assert.deepEqual([...P.unmeasuredFieldsOf(rows, 1, DAY)].sort(), ['spo2', 'temp'])
      assert.deepEqual([...P.unmeasuredFieldsOf(null, 1, DAY)], [])
      assert.equal(P.unmeasuredRowOf(rows, 1, DAY, 2, 'spo2')?.id, 2)
      assert.equal(P.unmeasuredRowOf(rows, 1, DAY, 1, 'spo2'), null)
    })
    it('「未測定」と出すのは値の無い欄だけ（値があれば印は無視＝値が優先）', () => {
      assert.equal(P.showsUnmeasured(null, true), true)
      assert.equal(P.showsUnmeasured(undefined, true), true)
      assert.equal(P.showsUnmeasured(36.5, true), false)
      assert.equal(P.showsUnmeasured(0, true), false)
      assert.equal(P.showsUnmeasured(null, false), false)
    })
    it('読み込みと行き違った端末の操作を重ねる: 始まりより後の操作だけ・外した印は戻さない・同じ欄は後の操作', () => {
      const read0 = [mark({ id: 1 }), mark({ id: 2, field: 'spo2' })]
      const ops = [
        { at: 50, residentId: 1, day: DAY, seq: 1, field: 'pulse', row: mark({ id: 9, field: 'pulse' }) }, // 始まりより前（読んだ印に載っている）
        { at: 120, residentId: 1, day: DAY, seq: 1, field: 'temp', row: null }, // 外した（古い読み込みに残っていても戻さない）
        { at: 130, residentId: 1, day: DAY, seq: 1, field: 'sys_bp', row: mark({ id: 10, field: 'sys_bp' }) }, // 付けた
        { at: 140, residentId: 1, day: DAY, seq: 1, field: 'sys_bp', row: null }, // 同じ欄の後の操作
        { at: 150, residentId: 1, day: DAY, seq: 1, field: 'dia_bp', row: mark({ id: 11, field: 'dia_bp' }) },
      ]
      const out = P.applyUnmeasuredOps(read0, ops, 100)
      assert.deepEqual(out.map((r) => r.field).sort(), ['dia_bp', 'spo2'])
      assert.deepEqual(read0.map((r) => r.id), [1, 2], '読んだ一覧は書き換えない')
      assert.deepEqual(P.applyUnmeasuredOps(read0, [], 0).map((r) => r.id), [1, 2])
    })
  })

  describe('反証の直し（純ロジック・daycareProgress.ts）', () => {
    const D = '2026-11-02'
    const key = (seq, rid = 1) => `dc:${D}:${rid}:${seq}`
    const kv = (seq, over = {}) => ({ id: seq, resident_id: 1, measured_on: D, kind: 'observation', measured_at: null, temp: 36.5, sys_bp: null, dia_bp: null,
      pulse: null, spo2: null, note: null, symptom: null, recorded_by: null, rev: 1, client_key: key(seq), ...over })
    it('中1: 〔＋再測定〕の回に印だけを残した時も、読み直した後の行にその回が出る（取り消した測定の行のキーの回は出さない）', () => {
      const live = [kv(1)]
      const marks = [mark({ seq: 2, field: 'temp' }), mark({ id: 2, seq: 2, field: 'spo2' })]
      const extra = P.unmeasuredSlotSeqs(marks, 1, D, live.map((v) => v.client_key), [key(1)])
      assert.deepEqual(extra, [2])
      const slots = P.daycareVitalSlotsWithPending(live, [key(1)], 1, D, extra, () => false)
      assert.deepEqual(slots.map((x) => x.seq), [1, 2])
      // 取り消した行（seq 3）のキーの回の印は行に出さない（そのキーには値を入れられない）
      assert.deepEqual(P.unmeasuredSlotSeqs([mark({ seq: 3 })], 1, D, [key(1)], [key(1), key(3)]), [])
      // 生きている行の回の印はそのまま（行は1つ）
      assert.deepEqual(P.unmeasuredSlotSeqs([mark({ seq: 1 })], 1, D, [key(1)], [key(1)]), [1])
      assert.deepEqual(P.unmeasuredSeqsOf([mark({ seq: 3 }), mark({ id: 2, seq: 1 }), mark({ id: 3, seq: 3, field: 'spo2' }), mark({ id: 4, resident_id: 2, seq: 5 })], 1, D), [1, 3])
    })
    it('中1: 次の〔＋再測定〕の回の番号に、印の回も入れる（前の「未測定」を新しい回に出さない）', async () => {
      const Dc = await import('../src/lib/daycare.ts')
      const marked = P.unmeasuredSeqsOf([mark({ seq: 2 })], 1, D).map((x) => key(x))
      assert.equal(Dc.nextDaycareSeq([key(1)], D, 1), 2, '（前の形）印の回を入れないと 2 を使ってしまう')
      assert.equal(Dc.nextDaycareSeq([key(1), ...marked], D, 1), 3)
    })
    it('軽2: 数える回は、測定の行のある一番小さい回・無ければ印の一番小さい回・どちらも無ければ null', () => {
      assert.equal(P.daycareCountSeq([2, 1], [1]), 1)
      assert.equal(P.daycareCountSeq([3], [1, 2]), 3)
      assert.equal(P.daycareCountSeq([], [4, 2]), 2)
      assert.equal(P.daycareCountSeq([], []), null)
      assert.equal(P.daycareCountSeq([0, -1], [Number.NaN]), null)
    })
    it('軽2: 1回目の測定を取り消した方で、バイタル・食事の画面（取り消した行のキーも見る）と今日の画面（生きている行だけ）が同じ回の印を数える', () => {
      const marks = [mark({ seq: 2, field: 'temp' }), mark({ id: 2, seq: 2, field: 'sys_bp' }), mark({ id: 3, seq: 2, field: 'dia_bp' })]
      const countOf = (slots) => {
        const cs = P.daycareCountSeq(slots.filter((x) => x.vital !== null).map((x) => x.seq), P.unmeasuredSeqsOf(marks, 1, D))
        const first = cs === null ? slots[0] : slots.find((x) => x.seq === cs)
        return { cs, blank: P.vitalBlankFields(first === undefined || first.vital === null ? null : first.vital, P.unmeasuredFieldsOf(marks, 1, D, cs ?? first?.seq ?? 1)) }
      }
      // バイタル・食事の画面: 取り消した 1回目のキーを知っているので、行は 2回目（印の回）
      const bulk = P.daycareVitalSlotsWithPending([], [key(1)], 1, D, P.unmeasuredSlotSeqs(marks, 1, D, [], [key(1)]), () => false)
      // 今日の画面: 生きている行だけを読むので、行の並びは 1回目（空）
      const today = P.daycareVitalSlotsWithPending([], [], 1, D, [], () => false)
      assert.deepEqual(bulk.map((x) => x.seq), [2])
      assert.deepEqual(today.map((x) => x.seq), [1])
      assert.deepEqual(countOf(bulk), { cs: 2, blank: 2 })
      assert.deepEqual(countOf(today), { cs: 2, blank: 2 }, '両画面で同じ回・同じ数')
    })
    it('軽7: 件数の帯「バイタル未」の済＝どれかの値がある（今の決まり）か、数える回の5欄が値か印で全部埋まっている', () => {
      assert.equal(P.vitalsTileDone(true, 4), true)
      assert.equal(P.vitalsTileDone(false, 0), true, '5欄とも〔未測定〕')
      assert.equal(P.vitalsTileDone(false, 1), false)
      assert.equal(P.vitalsTileDone(false, P.vitalBlankFields(null, new Set(['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2']))), true)
      assert.equal(P.vitalsTileDone(false, P.vitalBlankFields(null, new Set(['temp']))), false)
    })
  })

  describe('連絡帳の紙面: 「未測定」と「記録なし」を分ける（daycareContact.ts）', () => {
    const vital = (over = {}) => ({
      id: 1, resident_id: 1, measured_on: DAY, kind: 'observation', measured_at: null,
      temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null, note: null, symptom: null, recorded_by: null, rev: 1,
      client_key: `dc:${DAY}:1:1`, ...over,
    })
    const input = (over = {}) => ({
      residentId: 1, day: DAY, name: '利用者01', officeName: '事業所01', state: 'present', hospitalized: false, bathingPlanned: true,
      vitals: [], vitalsOk: true, target: null, thresholds: TH.DEFAULT_VITAL_THRESHOLDS, bath: null, bathsOk: true, lunch: null,
      fluids: [], intakeOk: true, activities: [], training: [], dayNote: null, note: null, ...over,
    })
    const cells = (s) => Object.fromEntries(s.vitals.cells.map((c) => [c.label, c.value]))
    it('印のある値の無い欄は「未測定」・印の無い欄は「記録なし」・値のある欄は値（印は無視）', () => {
      const s = C.buildContactSheet(input({
        vitals: [vital({ pulse: 72 })],
        unmeasured: [mark({ field: 'temp' }), mark({ id: 2, field: 'pulse' }), mark({ id: 3, resident_id: 2, field: 'spo2' })],
      }))
      assert.deepEqual(cells(s), { 体温: '未測定', 血圧: '記録なし', 脈拍: '72 回/分', SpO2: '記録なし' })
      assert.equal(C.UNMEASURED, '未測定')
      assert.notEqual(C.UNMEASURED, C.NO_RECORD)
    })
    it('血圧: 上下とも印なら「未測定」・片方だけ印なら上下を分けて出す・値のある側は値', () => {
      const both = C.sheetVitalCells(null, new Set(['sys_bp', 'dia_bp']))
      assert.equal(both.find((c) => c.label === '血圧').value, '未測定')
      const one = C.sheetVitalCells(null, new Set(['sys_bp']))
      assert.equal(one.find((c) => c.label === '血圧').value, '上 未測定／下 記録なし')
      const half = C.sheetVitalCells({ temp: null, sys_bp: 130, dia_bp: null, pulse: null, spo2: null }, new Set(['dia_bp']))
      assert.equal(half.find((c) => c.label === '血圧').value, '上 130／下 未測定')
    })
    it('どの回の印でも載せる（再測定の回の印も）・印を渡さない時は今までどおり「記録なし」', () => {
      const s = C.buildContactSheet(input({ unmeasured: [mark({ seq: 2, field: 'spo2' })] }))
      assert.equal(cells(s).SpO2, '未測定')
      assert.deepEqual(Object.values(cells(C.buildContactSheet(input()))), ['記録なし', '記録なし', '記録なし', '記録なし'])
      assert.deepEqual(C.buildContactSheet(input()).unreadLabels, [])
    })
    it('反証 軽3: 印を読めなかった時（null）は値の無い欄を「読み込めませんでした」にし（「記録なし」と刷らない）、読めなかった項目に足す', () => {
      const s = C.buildContactSheet(input({ vitals: [vital({ temp: 36.5 })], unmeasured: null }))
      assert.deepEqual(cells(s), { 体温: '36.5℃', 血圧: '読み込めませんでした', 脈拍: '読み込めませんでした', SpO2: '読み込めませんでした' })
      assert.deepEqual(s.unreadLabels, ['バイタルの未測定'])
      assert.equal(C.UNMEASURED_UNREAD_LABEL, 'バイタルの未測定')
      assert.deepEqual(C.unreadPicked([s], new Set([1])), [{ residentId: 1, labels: ['バイタルの未測定'] }])
      // バイタルそのものを読めない時は「バイタル」だけ（重ねない）・来ていない方は足さない
      assert.deepEqual(C.buildContactSheet(input({ vitalsOk: false, unmeasured: null })).unreadLabels, ['バイタル'])
      assert.deepEqual(C.buildContactSheet(input({ state: 'absent', unmeasured: null })).unreadLabels, [])
    })
    it('来ていない方の紙は今のまま（記録の欄を出さない）・読めないバイタルは「読み込めませんでした」のまま', () => {
      const absent = C.buildContactSheet(input({ state: 'absent', unmeasured: [mark()] }))
      assert.equal(absent.vitals, null)
      const unread = C.buildContactSheet(input({ vitalsOk: false, unmeasured: [mark()] }))
      assert.deepEqual(unread.vitals, { kind: 'unread' })
    })
  })

  describe('db.ts の〔未測定〕の読み書き（偽の Supabase）', () => {
    const fresh = async (init = {}) => {
      lsStore.clear()
      await DB.__testHooks.restartQueue()
      const state = { [T]: [], calls: [], nextId: 100, down: false, ...init }
      DB.__testHooks.setClient(fakeClient(state))
      return state
    }
    const done = async () => {
      DB.__testHooks.setClient(null)
      lsStore.clear()
      await DB.__testHooks.restartQueue()
    }
    const writes = (state) => state.calls.filter((c) => c.table === T && c.action !== 'select')

    it('読む: その日の生きている印だけ・表が無い時は印なし（missing）・読めない時は例外', async () => {
      const state = await fresh({ [T]: [{ ...mark(), deleted_at: null }, { ...mark({ id: 2, field: 'spo2' }), deleted_at: '2026-11-02T01:00:00Z' }, { ...mark({ id: 3, day: '2026-11-01' }), deleted_at: null }] })
      try {
        const r = await DB.fetchDaycareVitalUnmeasured(DAY)
        assert.equal(r.missing, false)
        assert.deepEqual(r.rows, [mark()])
        state.missing = true
        assert.deepEqual(await DB.fetchDaycareVitalUnmeasured(DAY), { rows: [], missing: true })
        state.missing = false
        state.readFail = true
        await assert.rejects(DB.fetchDaycareVitalUnmeasured(DAY), (e) => e instanceof DB.DbError)
      } finally {
        await done()
      }
    })
    it('付ける: 利用者・日・回・欄・記録者だけを送る（施設の印は送らない）・付けた行を返す', async () => {
      const state = await fresh()
      try {
        const row = await DB.markDaycareVitalUnmeasured({ residentId: 1, day: DAY, seq: 2, field: 'spo2', recordedBy: 5 })
        assert.deepEqual(row, { id: 100, resident_id: 1, day: DAY, seq: 2, field: 'spo2', rev: 1 })
        const w = writes(state)
        assert.equal(w.length, 1)
        assert.equal(w[0].action, 'insert')
        assert.deepEqual(w[0].payload, { resident_id: 1, day: DAY, seq: 2, field: 'spo2', recorded_by: 5 })
      } finally {
        await done()
      }
    })
    it('付ける: 同じ欄に生きている印があれば足さない（23505 は読み直して今ある印を返す）', async () => {
      const state = await fresh({ [T]: [{ ...mark({ id: 7, rev: 3 }), deleted_at: null }] })
      try {
        const row = await DB.markDaycareVitalUnmeasured({ residentId: 1, day: DAY, seq: 1, field: 'temp', recordedBy: 5 })
        assert.equal(row.id, 7)
        assert.equal(row.rev, 3)
        assert.equal(state[T].length, 1, '行を増やさない')
      } finally {
        await done()
      }
    })
    it('付ける: 通信できない時は「〔未測定〕を記録できませんでした…」・送信待ちに積まない', async () => {
      const state = await fresh({ down: true })
      try {
        await assert.rejects(
          DB.markDaycareVitalUnmeasured({ residentId: 1, day: DAY, seq: 1, field: 'temp', recordedBy: 5 }),
          (e) => e instanceof DB.DbError && e.kind === 'network' && e.message === '〔未測定〕を記録できませんでした。通信状態を確認して、もう一度押してください。',
        )
        assert.equal(DB.queuePending(), 0)
        assert.equal(state[T].length, 0)
      } finally {
        await done()
      }
    })
    it('付ける: 過去の日の守り（現場）・表が無い時は理由の文。未来の日・崩れた形は送らない', async () => {
      const state = await fresh({ guard: true })
      try {
        await assert.rejects(
          DB.markDaycareVitalUnmeasured({ residentId: 1, day: DAY, seq: 1, field: 'temp', recordedBy: 5 }),
          (e) => e instanceof DB.DbError && /事務所のログインでだけ記録・取り消しできます（現場の端末は当日だけ）/.test(e.message),
        )
        state.guard = false
        state.missing = true
        await assert.rejects(
          DB.markDaycareVitalUnmeasured({ residentId: 1, day: DAY, seq: 1, field: 'temp', recordedBy: 5 }),
          (e) => e instanceof DB.DbError && /サーバー側の設定待ち/.test(e.message),
        )
        state.missing = false
        const n = state.calls.length
        await assert.rejects(DB.markDaycareVitalUnmeasured({ residentId: 1, day: '2999-01-01', seq: 1, field: 'temp', recordedBy: 5 }), (e) => e instanceof DB.DbError)
        await assert.rejects(DB.markDaycareVitalUnmeasured({ residentId: 1, day: DAY, seq: 1, field: 'weight', recordedBy: 5 }), (e) => e instanceof DB.DbError)
        await assert.rejects(DB.markDaycareVitalUnmeasured({ residentId: 1, day: DAY, seq: 0, field: 'temp', recordedBy: 5 }), (e) => e instanceof DB.DbError)
        await assert.rejects(DB.markDaycareVitalUnmeasured({ residentId: 1, day: DAY, seq: 10000, field: 'temp', recordedBy: 5 }), (e) => e instanceof DB.DbError)
        assert.equal(writes({ calls: state.calls.slice(n) }).length, 0, '送っていない')
      } finally {
        await done()
      }
    })
    it('外す: 論理削除（deleted_at・取り消した職員・rev 照合）・物理削除しない', async () => {
      const state = await fresh({ [T]: [{ ...mark({ id: 7 }), deleted_at: null }] })
      try {
        assert.equal(await DB.clearDaycareVitalUnmeasured(mark({ id: 7 }), { editedBy: 5 }), true)
        const w = writes(state)
        assert.equal(w.length, 1)
        assert.equal(w[0].action, 'update')
        assert.deepEqual(Object.keys(w[0].payload).sort(), ['deleted_at', 'deleted_by', 'edited_by'])
        assert.equal(w[0].payload.deleted_by, 5)
        assert.deepEqual(w[0].filters, [['eq', 'id', 7], ['eq', 'rev', 1], ['is', 'deleted_at', null]])
        assert.equal(state[T].length, 1)
        assert.notEqual(state[T][0].deleted_at, null)
      } finally {
        await done()
      }
    })
    it('外す: 0行（他の端末が先に外した）は外せた扱い・付け直されていたらその版でもう1回', async () => {
      const state = await fresh({ [T]: [{ ...mark({ id: 7, rev: 2 }), deleted_at: '2026-11-02T01:00:00Z' }] })
      try {
        assert.equal(await DB.clearDaycareVitalUnmeasured(mark({ id: 7, rev: 1 }), { editedBy: 5 }), true)
        state[T] = [{ ...mark({ id: 7, rev: 2 }), deleted_at: '2026-11-02T01:00:00Z' }, { ...mark({ id: 8, rev: 1 }), deleted_at: null }]
        state.calls = []
        assert.equal(await DB.clearDaycareVitalUnmeasured(mark({ id: 7, rev: 1 }), { editedBy: 5 }), true)
        const ups = writes(state)
        assert.equal(ups.length, 2)
        assert.deepEqual(ups[1].filters, [['eq', 'id', 8], ['eq', 'rev', 1], ['is', 'deleted_at', null]])
        assert.notEqual(state[T].find((r) => r.id === 8).deleted_at, null)
      } finally {
        await done()
      }
    })
    it('外す: 通信できない時は「〔未測定〕を取り消せませんでした…」・送信待ちに積まない', async () => {
      await fresh({ [T]: [{ ...mark({ id: 7 }), deleted_at: null }], down: true })
      try {
        await assert.rejects(
          DB.clearDaycareVitalUnmeasured(mark({ id: 7 }), { editedBy: 5 }),
          (e) => e instanceof DB.DbError && e.kind === 'network' && e.message === '〔未測定〕を取り消せませんでした。通信状態を確認して、もう一度押してください。',
        )
        assert.equal(DB.queuePending(), 0)
      } finally {
        await done()
      }
    })
  })
}

describe('移行 0062_daycare_vital_unmeasured.sql（静的検査）', () => {
  const raw = read('../supabase/migrations/0062_daycare_vital_unmeasured.sql')
  const m = sqlCode('../supabase/migrations/0062_daycare_vital_unmeasured.sql')
  it('頭のコメント: 足すだけ・既存を変えない・本番は代表者が SQL Editor で流す・0061 の後・戻し方（drop の SQL と順）', () => {
    assert.match(raw, /足すだけ・既存を変えない・本番は代表者が SQL Editor で流す/)
    assert.match(raw, /0061 の後に流す/)
    assert.match(raw, /--\s+drop table if exists public\.daycare_vital_unmeasured;\n--\s+drop function if exists public\.daycare_vital_unmeasured_day_guard\(\);/)
    assert.match(raw, /★戻す順: 新しい移行から順に戻す/)
  })
  it('begin … commit・lock_timeout・do $$ を使わない・冪等の書き方（if not exists・drop … if exists・or replace）', () => {
    assert.match(m, /^begin;$/m)
    assert.match(m, /^commit;$/m)
    assert.match(m, /set local lock_timeout = '5s';/)
    assert.doesNotMatch(m, /^\s*do\s+\$\$/im)
    assert.match(m, /create table if not exists public\.daycare_vital_unmeasured \(/)
    assert.match(m, /create unique index if not exists uq_daycare_vital_unmeasured\s+on public\.daycare_vital_unmeasured \(tenant_id, resident_id, day, seq, field\)\s+where deleted_at is null;/)
    assert.match(m, /create index if not exists ix_daycare_vital_unmeasured_day\s+on public\.daycare_vital_unmeasured \(tenant_id, day\)\s+where deleted_at is null;/)
  })
  it('共通の列・回（1〜9999）と欄（5つ）の check・外部キーは（施設の印, 番号）の組', () => {
    for (const col of ['tenant_id     uuid not null references public.tenants(id)', 'resident_id   bigint not null', 'day           date not null', 'seq           integer not null',
      'field         text not null', 'recorded_by   bigint', 'rev           integer not null default 1', 'created_at    timestamptz not null default now()',
      'updated_at    timestamptz not null default now()', 'deleted_at    timestamptz', 'deleted_by    bigint', 'edited_by     bigint']) {
      assert.ok(m.includes(col), col)
    }
    assert.match(m, /check \(seq between 1 and 9999\)/)
    assert.match(m, /check \(field in \('temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2'\)\)/)
    for (const [c, ref] of [['resident_id', 'residents'], ['recorded_by', 'staff'], ['deleted_by', 'staff'], ['edited_by', 'staff']]) {
      assert.match(m, new RegExp(`constraint daycare_vital_unmeasured_${c}_fkey\\s+foreign key \\(tenant_id, ${c}\\)\\s+references public\\.${ref} \\(tenant_id, id\\)`))
    }
  })
  it('施設の印のトリガ（関数は作らない）・rev と updated_at・変更の記録（day）・守り5本・delete の守りと権限なし', () => {
    assert.match(m, /create trigger carelog_fill_tenant before insert on public\.daycare_vital_unmeasured\s+for each row execute function private\.carelog_fill_tenant\(\);/)
    assert.doesNotMatch(m, /function private\.carelog_fill_tenant\(\)\s*returns/)
    assert.match(m, /execute function public\.set_updated_at_rev\(\);/)
    assert.match(m, /execute function public\.record_history_capture\('day'\);/)
    for (const p of ['"read_auth"   on public.daycare_vital_unmeasured for select to authenticated using (true)',
      '"insert_auth" on public.daycare_vital_unmeasured for insert to authenticated with check (true)',
      '"update_auth" on public.daycare_vital_unmeasured for update to authenticated using (true) with check (true)',
      'member_only on public.daycare_vital_unmeasured as restrictive for all to authenticated',
      'tenant_only on public.daycare_vital_unmeasured as restrictive for all to authenticated']) {
      assert.ok(m.includes(`create policy ${p}`), p)
    }
    assert.doesNotMatch(m, /for delete/)
    assert.match(m, /revoke all on public\.daycare_vital_unmeasured from anon;/)
    assert.match(m, /revoke delete, truncate on public\.daycare_vital_unmeasured from authenticated;/)
  })
  it('過去の日の守り: 新しいトリガ専用の関数（連絡帳と別の文の頭）・誰も実行できない・0061 と同じ作法', () => {
    assert.deepEqual(m.match(/create (or replace )?function [\w.]+/g), ['create or replace function public.daycare_vital_unmeasured_day_guard'])
    const fn = m.slice(m.indexOf('create or replace function public.daycare_vital_unmeasured_day_guard()'), m.indexOf('$fn$;') + 5)
    assert.match(fn, /security definer\s+set search_path = ''/)
    assert.match(fn, /raise exception 'daycare_unmeasured_future: [^']+'\s+using errcode = '22023';/)
    assert.match(fn, /raise exception 'daycare_unmeasured_past_office_only: [^']+'\s+using errcode = '42501'/)
    assert.match(fn, /if v_role is distinct from 'field' then\s+return new;/)
    assert.match(fn, /pg_catalog\.to_regprocedure\('private\.my_role\(\)'\) is null/)
    assert.doesNotMatch(fn, /daycare_contact_/)
    assert.match(m, /revoke all on function public\.daycare_vital_unmeasured_day_guard\(\) from public, anon, authenticated;/)
    assert.match(m, /create or replace trigger trg_daycare_vital_unmeasured_day_guard\s+before insert or update on public\.daycare_vital_unmeasured\s+for each row execute function public\.daycare_vital_unmeasured_day_guard\(\);/)
  })
  it('最後の確かめの1行（表・印・守りの本数・消す権限・anon・一意・守りのトリガ・関数の権限）で ok／NG', () => {
    const last = m.slice(m.indexOf("select '〔未測定〕の表"))
    assert.ok(last.length > 500 && m.indexOf('notify pgrst') < m.indexOf("select '〔未測定〕の表"))
    assert.match(last, /then 'ok' else 'NG' end as result;\s*$/)
    for (const k of ["= 5", "permissive = 'RESTRICTIVE') = 2", "cmd = 'DELETE') = 0", "privilege_type in ('DELETE', 'TRUNCATE')) = 0", "grantee = 'anon') = 0",
      "indexname = 'uq_daycare_vital_unmeasured'", "tgname = 'trg_daycare_vital_unmeasured_day_guard'",
      "has_function_privilege('authenticated', 'public.daycare_vital_unmeasured_day_guard()', 'execute')",
      "has_function_privilege('anon', 'public.daycare_vital_unmeasured_day_guard()', 'execute')"]) {
      assert.ok(last.includes(k), k)
    }
  })
  it('足すだけ: vitals・apply_cell_edits・既存の表と関数には触れない（alter・drop・create or replace は自分の表と守りだけ）', () => {
    assert.doesNotMatch(m, /public\.vitals\b|apply_cell_edits|record_history_capture\(\)\s*returns/)
    for (const x of m.matchAll(/\b(alter table|drop table|drop function|drop policy if exists \S+\s+on|drop trigger if exists \S+ on)\s+(if exists\s+)?(public\.\w+)?/g)) {
      if (x[3] !== undefined) assert.equal(x[3], 'public.daycare_vital_unmeasured', x[0])
    }
    assert.doesNotMatch(m, /drop table|drop function/)
    assert.doesNotMatch(m, /supabase_realtime|app_settings|on conflict/)
  })
  it('素の Postgres の契約: 0053 の流し直しの除外の理由に 0062・施設の印の試験の一覧に表・新しい実行器がある', () => {
    assert.match(read('./pg-run-all.mjs'), /0061・0062 が組の外部キーを足した/)
    for (const f of ['./tenant-stage1-pg.mjs', './tenant-stage3-pg.mjs', './tenant-stage4-pg.mjs']) assert.match(read(f), /'daycare_vital_unmeasured'\]/, f)
    assert.match(read('./tenant-stage3-pg.mjs'), /const LATER_FKS = 11/)
    assert.match(read('./daycare-unmeasured-pg.mjs'), /daycare_vital_unmeasured_day_guard/)
  })
})

describe('画面（静的検査）', () => {
  const screen = code('../src/pages/DaycareVitalsMealsPage.tsx')
  const today = code('../src/pages/DaycarePage.tsx')
  const contact = code('../src/pages/DaycareContactPage.tsx')
  const db = code('../src/lib/db.ts')
  const sec = db.slice(db.indexOf('const UNMEASURED_MSG = {'), db.indexOf('const CONTACT_MSG = {'))
  it('db.ts: 旗は input_enabled_daycare・送信待ちに積まない・upsert しない・vitals に書かない', () => {
    assert.ok(sec.length > 1000, '〔未測定〕の節が見つからない')
    assert.equal((sec.match(/await assertKindWritable\('daycare'\)/g) ?? []).length, 2)
    assert.doesNotMatch(sec, /enqueue\(|\.upsert\(|from\('vitals'\)|apply_cell_edits|\.delete\(/)
    assert.match(sec, /offline: '〔未測定〕を記録できませんでした。通信状態を確認して、もう一度押してください。'/)
    assert.match(sec, /message\.startsWith\('daycare_unmeasured_past_office_only:'\)/)
    assert.match(sec, /\.update\(x\)\s*\.eq\('id', target\.id\)\s*\.eq\('rev', target\.rev\)\s*\.is\('deleted_at', null\)/)
  })
  it('バイタル・食事の画面: 印は今の読み込みの回の中で1本・同じ回で並べて読む・購読は足さない', () => {
    const load = screen.slice(screen.indexOf('const load = useCallback(async (target'), screen.indexOf('}, [])', screen.indexOf('const load = useCallback(async (target')))
    assert.match(load, /const \[plan, attendance, dv, um\] = await Promise\.all\(\[[\s\S]*fetchDaycareVitals\(target\),\s*fetchDaycareVitalUnmeasured\(target\)/)
    assert.equal((screen.match(/fetchDaycareVitalUnmeasured\(/g) ?? []).length, 1)
    assert.equal((screen.match(/\b(subscribeChanges|subscribeDaycareChanges)\(/g) ?? []).length, 2)
  })
  it('テンキーの〔未測定〕: 値の無い欄は印を付けて次へ・印のある欄は印を外して欄に残る・値のある欄は今のまま次へ', () => {
    assert.match(screen, /if \(skip && toggleUnmeasured\(cur, slot\)\) return/)
    const t = screen.slice(screen.indexOf('const toggleUnmeasured = '), screen.indexOf('const toggleUnmeasured = ') + 600)
    assert.match(t, /if \(valueOf\(slot, cur\.field\)\.v !== null\) return false/)
    assert.match(t, /if \(row === null\) \{\s*void markUnmeasured\(slot, cur\.field, true\)\s*return false\s*\}/)
    assert.match(t, /void clearUnmeasured\(slot, cur\.field, row, true\)[\s\S]*return true/)
    // 〔元に戻す〕で後から付け直す時も、その間に値を入れた欄には印を作らない（端末の値 → 送信待ち → サーバーの値の順で見る）
    assert.match(screen, /if \(k === null \|\| umBusyRef\.current\.has\(busy\) \|\| hasValueNow\(slot, field\)\) return/)
    assert.match(screen, /return vitalShownValue\(pendingRow\('vitals', targetOf\(slot\)\), vital, f\)\.v !== null/)
  })
  it('付けた・外した時の知らせは昼食と同じ部品（〔元に戻す〕つき＝8秒）・取り消した時は「未測定を取り消しました」', () => {
    assert.match(screen, /lunch\.show\(`\$\{nameOf\(k\.residentId\)\}さんの\$\{DAYCARE_VITAL_LABEL\[field\]\}を未測定にしました`, \(\) => void clearUnmeasured\(slot, field, row, false\)\)/)
    assert.match(screen, /lunch\.show\(`\$\{nameOf\(row\.resident_id\)\}さんの\$\{DAYCARE_VITAL_LABEL\[field\]\}の未測定を取り消しました`, \(\) => void markUnmeasured\(slot, field, false\)\)/)
    assert.doesNotMatch(screen, /useToast\(/)
    assert.match(code('../src/pages/DaycareLunchColumns.tsx'), /return \{ data, loading, error, blankOf, markOf, cells, notes, toast, show, reload: scheduleReload \}/)
    assert.match(code('../src/components/ui.tsx'), /const TOAST_UNDO_MS = 8000/)
  })
  it('値を保存できたら、その欄の印を外す（送信待ちの時は外さない・失敗は出さない）', () => {
    assert.match(screen, /if \(r === 'queued'\) \{[\s\S]{0,200}return null\s*\}\s*clearUnmeasuredOfSaved\(slot, edits\)/)
    assert.match(screen, /if \(row !== null\) void clearUnmeasured\(slot, f as DaycareVitalField, row, false, true\)/)
  })
  it('欄の見た目: 「未測定」の字（15px・ink2）・注意の地と点線の枠は付けない・読み上げは「〜 未測定」', () => {
    assert.match(screen, /const um = showsUnmeasured\(v, unmeasuredRowOf\(data\.unmeasured, row\.residentId, data\.day, slot\.seq, f\) !== null\)/)
    assert.match(screen, /const blank = countedSlot && v === null && !isActive && !um/)
    assert.match(screen, /\{um \? \(\s*<span className="whitespace-nowrap text-sm leading-tight text-ink2">未測定<\/span>\s*\) : v === null \? \(/)
    assert.match(screen, /\$\{v === null \? \(um \? '未測定' : '未入力'\) : fmtVal\(f, v\)\}/)
    // 枠は今の細い実線（levelTone(null)＝border border-border-strong bg-surface）
    assert.match(screen, /return 'border border-border-strong bg-surface'/)
  })
  it('付けられなかった時の理由は行の下（欄は空のまま）・テンキーの〔未測定〕は押した状態を ✓ と aria-pressed で示す', () => {
    // 反証 軽4: 知らせは欄ごと（測定のキー|欄）。行の下にはその回の欄の知らせを並べる
    assert.match(screen, /const umNote = DAYCARE_VITAL_FIELDS\.flatMap\(\(f\) => umNotes\.get\(umKey\(slot, f\)\) \?\? \[\]\)\.join\(' '\) \|\| null/)
    assert.match(screen, /const below = detail \|\| lunchNotes !== null \|\| umNote !== null/)
    assert.match(screen, /aria-pressed=\{activeMarked\}/)
    assert.match(screen, /min-h-tap rounded border-2 border-primary bg-surface2 px-3 text-base font-bold text-ink/)
  })
  it('反証 軽6: 凡例の4語は元のまま・3語を足す・1180px で2段のまま（食事の説明を短くして同じ段落の続きに置く）', () => {
    assert.match(screen, /記号: ↑↑ 危険（高い）・↑ 注意（高い）・↓ 注意（低い）・↓↓ 危険（低い）・—＝記録なし（数えない回）・未測定＝測らなかった記録・未＝未入力。範囲外と血圧の上下逆は保存しません。/)
    assert.match(screen, /<span>主食・副食は選ぶとすぐ保存します。水分は数を入れて改行キーか〔＋〕で足します（1人の画面と同じ記録）。<\/span>\s*<\/p>/)
    // 凡例と食事の説明は1つの段落（2段に流れる。15px・ヘッドレス Chrome で凡例 1296px＋説明 750px＝2段・2段目の余り約 54px）
    assert.equal((screen.match(/<p className="text-sm leading-tight text-ink2">/g) ?? []).length, 1)
    assert.doesNotMatch(screen, /危険・↑ 注意（高い）|— 未測定・/)
  })
  it('反証 中1: 行の組み立てに印の回を足す・次の〔＋再測定〕の回の番号決めに印の回を入れる', () => {
    assert.match(screen, /const markSeqs = unmeasuredSlotSeqs\(\s*data\.unmeasured,\s*residentId,\s*data\.day,\s*data\.live\.map\(\(v\) => v\.client_key\),\s*data\.keys,\s*\)/)
    assert.match(screen, /\[\.\.\.\(extraSeqs\.get\(residentId\) \?\? \[\]\), \.\.\.markSeqs\]/)
    assert.match(screen, /const marked = unmeasuredSeqsOf\(data\.unmeasured, row\.residentId, data\.day\)\.map\(\(s\) => daycareVitalKey\(data\.day, row\.residentId, s\)\)/)
    assert.match(screen, /let seq = nextDaycareSeq\(\[\.\.\.data\.keys, \.\.\.local, \.\.\.marked, \.\.\.slotsOf\(row\.residentId\)\.map\(\(s\) => s\.key\)\], data\.day, row\.residentId\)/)
  })
  it('反証 軽2: 数える回は今日の画面と同じ純関数（daycareCountSeq）・空の枠を光らせるのもその回', () => {
    assert.match(screen, /const cs = daycareCountSeq\(\s*slots\.filter\(\(s\) => s\.vital !== null \|\| pendingRow\('vitals', targetOf\(s\)\) !== null\)\.map\(\(s\) => s\.seq\),\s*unmeasuredSeqsOf\(data\?\.unmeasured, r\.residentId, day\),\s*\)/)
    assert.match(screen, /const countedSlot = slot\.seq === countSeqOfRow\.get\(row\.residentId\) && blankCount !== undefined/)
    assert.match(today, /const cs = daycareCountSeq\(\s*shown\.filter\(\(s\) => live\.has\(keyOf\(s\.seq\)\) \|\| pendingRow\('vitals', vitalTarget\(id, keyOf\(s\.seq\)\)\) !== null\)\.map\(\(s\) => s\.seq\),\s*unmeasuredSeqsOf\(data\.unmeasured, id, data\.day\),\s*\)/)
  })
  it('反証 軽3: 印を読めなかった時、バイタル・食事の画面は表の上に1行（前に読んだ印か、印なし）・連絡帳は帯と印刷前の確かめに出す', () => {
    assert.match(screen, /unmeasuredUnread: um !== null \? null : umPrev !== null \? 'prev' : 'none'/)
    assert.match(screen, /\{data\.unmeasuredUnread !== null \? \(\s*<div role="status"[^>]*>\s*<p className="min-w-0 flex-1">\s*<span aria-hidden="true">▲ <\/span>\s*\{MSG_UM_UNREAD\[data\.unmeasuredUnread\]\}/)
    assert.match(screen, /前に読んだ記録で表示しています/)
    assert.match(contact, /\.\.\.\(data\.vitalsOk && data\.unmeasured === null \? \[UNMEASURED_UNREAD_LABEL\] : \[\]\)/)
  })
  it('反証 軽4・軽5: 値を保存できた欄の失敗の知らせを消す・送信中の欄は進めずに「送信中です」', () => {
    assert.match(screen, /setUmNote\(umKey\(slot, f as DaycareVitalField\), null\)/)
    assert.match(screen, /if \(umBusyRef\.current\.has\(umKey\(slot, cur\.field\)\)\) \{\s*setBuf\(''\)\s*setKpError\(null\)\s*return true\s*\}/)
    assert.match(screen, /if \(umBusy\.has\(umKey\(activeSlot, active\.field\)\)\) parts\.push\(MSG_UM_BUSY\)/)
    assert.match(screen, /const MSG_UM_BUSY = '〔未測定〕を送信中です。終わるまでお待ちください。'/)
  })
  it('今日の画面: 印を読み込みの回に1本足す（読めない時は null）・切り替えの数だけに使う・カードの VS の印は今のまま', () => {
    assert.equal((today.match(/fetchDaycareVitalUnmeasured\(/g) ?? []).length, 1)
    assert.match(today, /fetchDaycareVitalUnmeasured\(target\)\s*\.then\(\(r\) => r\.rows\)\s*\.catch\(\(\): DaycareVitalUnmeasured\[\] \| null => null\)/)
    assert.match(today, /const vitalsDone = \(id: number\) => vitalSlotsFilled\(\(vitalShown\.get\(id\) \?\? \[\]\)\.map\(\(s\) => DAYCARE_VITAL_FIELDS\.map\(\(f\) => s\.vals\[f\]\)\)\)/)
    assert.equal((today.match(/unmeasuredFieldsOf\(/g) ?? []).length, 1)
    // 反証 軽7: 件数の帯「バイタル未」は5欄とも値か印で埋まった方を済に（カードの VS は vitalsDone のまま）
    assert.match(today, /const vitalsWaiting = board\.rows\.filter\(\(r\) => r\.state === 'present' && !vitalsTileDone\(vitalsDone\(r\.residentId\), countBlankOf\(r\.residentId\)\)\)\.length/)
    assert.match(today, /vitals: data\.vitalsOk \? \{ done: vDone, abnormal: vDone && vitalsAbnormal\(id\) \} : null/)
  })
  it('連絡帳: 印を読み込みの回に1本足して紙面の材料に渡す（紙の部品は変えない）', () => {
    assert.equal((contact.match(/fetchDaycareVitalUnmeasured\(/g) ?? []).length, 1)
    assert.match(contact, /unmeasured: data\.unmeasured,/)
    assert.doesNotMatch(code('../src/components/print/DaycareContactSheet.tsx'), /unmeasured|未測定/)
  })
  it('端末に業務データを残さない（印を localStorage に書かない）・console に出さない', () => {
    for (const s of [screen, today, contact, sec]) {
      assert.doesNotMatch(s, /localStorage\.setItem\([^)]*unmeasured/i)
      assert.doesNotMatch(s, /console\./)
    }
  })
})
