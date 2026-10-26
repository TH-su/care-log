// デイ（せせらぎ）段階2b: 活動・レクの回帰テスト（2026-10-22・代表者承認・段階2の計画 v1 の 3.1／8章 V8・V9）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycareActivity.ts）: 項目のそろえ方と検査・度合い・並び・前回コピー・まとめて記録の相手と結果の文
// 2. db.ts を偽の Supabase で動かす（通信しない）: insertDaycareActivity の合流（同じ度合い）・先に違う度合い・送信待ち・
//    自分の送信の行き違い・項目をそろえて送る・未来の日は送らない
// 3. 静的検査: 移行 0044 の形（追加のみ・冪等・do ブロックなし・delete の権限なし・Realtime の一時関数を作り直す）・
//    types.ts は1行の追加だけ・db.ts の配線（送信待ち・旗・自然キー・合流・別のチャンネル）・画面の書き込みの経路・端末に業務データを残さない
// DB の層（RLS・部分 unique・check・変更の記録）は tests/daycare-activity-contract.mjs（pg-run-all で流す）。
// 個人情報は置かない（利用者は数値IDだけ）。

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
let A = null
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
  A = await import('../src/lib/daycareActivity.ts')
  DB = await import('../src/lib/db.ts?daycare-activity')
} catch (e) {
  loadError = e
  A = null
}

/** 偽の Supabase（活動の表と app_settings だけ）。down=true の間は書き込みが 503 */
function fakeClient(state) {
  const rows = state.rows
  const builder = (table) => {
    const q = { table, filters: [], action: 'select', payload: null, single: false }
    const run = () => {
      state.calls.push({ table: q.table, action: q.action, payload: q.payload, filters: q.filters })
      if (q.table === 'app_settings') return { data: q.single ? null : [], error: null, status: 200 }
      if (q.action === 'update') {
        if (state.down) return { data: null, error: { message: 'Service Unavailable', code: '' }, status: 503 }
        const hit = rows.find((r) => q.filters.every(([op, k, v]) => (op === 'eq' ? r[k] === v : op === 'is' ? (r[k] ?? null) === v : true)))
        if (!hit) return { data: null, error: null, status: 200 }
        Object.assign(hit, q.payload, { rev: hit.rev + 1 })
        return { data: { ...hit }, error: null, status: 200 }
      }
      if (q.action === 'insert') {
        if (state.down) return { data: null, error: { message: 'Service Unavailable', code: '' }, status: 503 }
        const p = q.payload
        const taken =
          rows.some((r) => r.client_key === p.client_key) ||
          rows.some((r) => r.deleted_at === null && r.resident_id === p.resident_id && r.day === p.day && r.label === p.label)
        if (taken) return { data: null, error: { message: 'duplicate key', code: '23505' }, status: 409 }
        const row = { id: state.nextId++, rev: 1, deleted_at: null, note: null, ...p }
        rows.push(row)
        return { data: { ...row }, error: null, status: 201 }
      }
      let hits = rows.filter((r) =>
        q.filters.every(([op, k, v]) => (op === 'eq' ? r[k] === v : op === 'is' ? (r[k] ?? null) === v : op === 'lt' ? r[k] < v : true)),
      )
      if (q.single) return { data: hits[0] ? { ...hits[0] } : null, error: null, status: 200 }
      return { data: hits.map((r) => ({ ...r })), error: null, status: 200 }
    }
    const b = {
      select() {
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
      lt(k, v) {
        q.filters.push(['lt', k, v])
        return b
      },
      order() {
        return b
      },
      limit() {
        return b
      },
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

if (A === null) {
  registerLoadFailure('デイ 段階2b（活動・レク）の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('純ロジック（daycareActivity.ts）', () => {
    it('定型のチップは代表者の決定の7つ・度合いは4つ（既定は参加）', () => {
      assert.deepEqual([...A.DAYCARE_ACTIVITY_CHIPS], ['体操', '脳トレ', '歌', '創作', '園芸', '散歩', '休息'])
      assert.deepEqual([...A.ACTIVITY_PARTICIPATIONS], ['full', 'partial', 'observed', 'declined'])
      assert.deepEqual(A.ACTIVITY_PARTICIPATION_LABEL, { full: '参加', partial: '一部', observed: '見学', declined: '不参加' })
      assert.equal(A.ACTIVITY_LABEL_MAX, 40)
    })
    it('項目は NFKC にそろえ、空白の並びを1つにして前後を落とす（DB の check と同じ形で送る）', () => {
      assert.equal(A.normalizeActivityLabel('　体操　'), '体操')
      assert.equal(A.normalizeActivityLabel(' 手先の   体操 '), '手先の 体操')
      assert.equal(A.normalizeActivityLabel('ＡＢＣ体操'), 'ABC体操')
      assert.equal(A.activityLabelError('   '), '項目を入れてください。')
      assert.equal(A.activityLabelError('あ'.repeat(40)), null)
      assert.match(A.activityLabelError('あ'.repeat(41)), /40 字まで/)
      assert.equal(A.activityLabelError(` ${'あ'.repeat(40)} `), null, '前後の空白は数えない')
    })
    it('受信した度合いを信じない（4つ以外は null）', () => {
      assert.equal(A.participationOf('observed'), 'observed')
      assert.equal(A.participationOf('yes'), null)
      assert.equal(A.participationOf(null), null)
    })
    it('その方・その日の活動はチップの順 → 自由入力は入れた順', () => {
      const r = (id, label, rid = 1, day = '2026-10-22') => ({ id, resident_id: rid, day, label, participation: 'full', note: null, recorded_by: 1, rev: 1 })
      const list = [r(5, '手作業'), r(2, '歌'), r(3, '体操'), r(9, '書道'), r(4, '体操', 2), r(6, '散歩', 1, '2026-10-21')]
      assert.deepEqual(
        A.activitiesOf(list, 1, '2026-10-22').map((a) => a.label),
        ['体操', '歌', '手作業', '書道'],
      )
    })
    it('表示: 参加は項目だけ・それ以外は度合いを添える。一覧の印は「記録なし／n件」', () => {
      assert.equal(A.activityText({ label: '歌', participation: 'full' }), '歌')
      assert.equal(A.activityText({ label: '歌', participation: 'observed' }), '歌（見学）')
      assert.equal(A.activityChipText(0), '記録なし')
      assert.equal(A.activityChipText(3), '3件')
    })
    it('前回コピー: before より前のいちばん新しい日の項目と度合い。もう入っている項目は足さない', () => {
      const rows = [
        { day: '2026-10-19', label: '園芸', participation: 'full' },
        { day: '2026-10-21', label: '体操', participation: 'full' },
        { day: '2026-10-21', label: '歌', participation: 'observed' },
        { day: '2026-10-22', label: '散歩', participation: 'full' },
      ]
      const p = A.previousActivities(rows, '2026-10-22')
      assert.deepEqual(p, {
        day: '2026-10-21',
        items: [
          { label: '体操', participation: 'full' },
          { label: '歌', participation: 'observed' },
        ],
      })
      assert.equal(A.previousActivities(rows, '2026-10-19'), null)
      assert.deepEqual(A.copyItems(p.items, [{ label: '体操' }]), [{ label: '歌', participation: 'observed' }])
    })
    it('活動一括の相手は一括の画面と同じ（予定の方のうち休み・入院中を除く全員＋予定外で来た方・2026-10-24 §9.4 の4）', () => {
      const rows = [
        { residentId: 1, state: 'present', planned: true, hospitalized: false },
        { residentId: 2, state: 'absent', planned: true, hospitalized: false },
        { residentId: 3, state: 'left', planned: false, hospitalized: false },
        { residentId: 4, state: 'planned', planned: true, hospitalized: false },
        { residentId: 5, state: 'planned', planned: true, hospitalized: true },
        { residentId: 6, state: 'planned', planned: false, hospitalized: false },
      ]
      assert.deepEqual(A.activityTargets(rows), [1, 3, 4])
      // 親の検収 中2: 最初からチェックを付けるのは来た方（在席・帰宅）だけ。まだ来ていない方は一覧に出すがチェックを外す
      assert.deepEqual(rows.map((r) => A.activityDefaultChecked(r)), [true, false, true, false, false, false])
      assert.equal(A.activityDefaultChecked(undefined), false)
      // 2026-10-26 表にした（固定し直し・意図は同じ）: チェックの代わりに、列の見出しの一括で入れる相手を来た方のうち記録の無い方だけにする
      // （columnFillTargets＝activityDefaultChecked）。まだ来ていない方は表に出すが「（未到着）」の札を出す
      const b = read('../src/pages/DaycareActivityBulkPage.tsx')
      assert.match(b, /const fillTargets = \(l: string\) => columnFillTargets\(targetRows, \(rid\) => has\(rid, l\)\)/)
      assert.match(b, /const late = !activityDefaultChecked\(rowOf\(rid\)\)/)
      assert.match(b, /\{late \? <span className="block text-sm text-ink2">（未到着）<\/span> : null\}/)
    })
    it('まとめて記録の結果の文は人数で出す（合流・送信待ち・先に違う度合い・失敗を分ける）', () => {
      assert.equal(A.bulkResultText('体操', ['saved', 'saved', 'merged']), '「体操」: 2人に入れました。1人は同じ記録が先にありました。')
      assert.match(A.bulkResultText('体操', ['queued', 'taken', 'error']), /1人はこの端末に保存しました.*1人は違う参加の度合いで先に記録がありました.*1人は保存できませんでした/)
      assert.equal(A.bulkResultText('体操', []), '「体操」: 対象の方がいません。')
    })
    it('活動一括の表（2026-10-26）: 枠を押すたびの度合いは 無し → 参加 → 一部 → 見学 → 不参加 → 消す（null）', () => {
      const seen = []
      let cur = null
      for (let i = 0; i < 6; i += 1) {
        cur = A.nextParticipation(cur)
        seen.push(cur)
      }
      assert.deepEqual(seen, ['full', 'partial', 'observed', 'declined', null, 'full'], '消した後にもう1度押すと参加に戻る')
      assert.equal(A.nextParticipation('yes'), null, '4つ以外の度合いは消す側へ（受信値を信じない）')
    })
    it('活動一括の表: 「その他」の列は定型のチップでない項目だけ・入れた順（その方・その日だけ）', () => {
      const r = (id, label, rid = 1, day = '2026-10-26') => ({ id, resident_id: rid, day, label, participation: 'full', note: null, recorded_by: 1, rev: 1 })
      const list = [r(9, '書道'), r(3, '体操'), r(5, '手作業'), r(7, '歌'), r(4, '囲碁', 2), r(6, '将棋', 1, '2026-10-25')]
      assert.deepEqual(A.otherActivitiesOf(list, 1, '2026-10-26').map((a) => a.label), ['手作業', '書道'])
      assert.deepEqual(A.otherActivitiesOf(list, 2, '2026-10-26').map((a) => a.label), ['囲碁'])
      assert.deepEqual(A.otherActivitiesOf([], 1, '2026-10-26'), [])
    })
    it('活動一括の表: 列の見出しで「参加」を入れる相手は来た方（在席・帰宅）で記録の無い方だけ（未到着・記録のある方は除く・並びはそのまま）', () => {
      const rows = [
        { residentId: 11, state: 'present' },
        { residentId: 12, state: 'planned' },
        { residentId: 13, state: 'left' },
        { residentId: 14, state: 'present' },
        { residentId: 15, state: 'absent' },
        { residentId: 16, state: 'left' },
      ]
      // 14 は記録がある（一部など）、16 は取り消しの送信待ち・送信待ちの追加がある＝どちらも記録ありとして渡される
      const has = new Set([14, 16])
      assert.deepEqual(A.columnFillTargets(rows, (rid) => has.has(rid)), [11, 13])
      assert.deepEqual(A.columnFillTargets(rows, () => true), [])
      assert.deepEqual(A.columnFillTargets([], () => false), [])
    })
  })

  describe('insertDaycareActivity（偽の Supabase・通信しない）', () => {
    const fresh = async (rows = []) => {
      lsStore.clear()
      await DB.__testHooks.restartQueue()
      const state = { rows, calls: [], nextId: 100, down: false }
      DB.__testHooks.setClient(fakeClient(state))
      return state
    }
    const done = async () => {
      DB.__testHooks.setClient(null)
      lsStore.clear()
      await DB.__testHooks.restartQueue()
    }
    it('足せた時は saved。項目はそろえて送り、冪等キーを付ける・既定の度合いは参加', async () => {
      const st = await fresh()
      const r = await DB.insertDaycareActivity({ resident_id: 1, day: '2026-10-21', label: '　体操 ', recorded_by: 4 })
      assert.equal(r.kind, 'saved')
      assert.equal(r.row.label, '体操')
      const ins = st.calls.find((c) => c.action === 'insert')
      assert.equal(ins.payload.label, '体操')
      assert.equal(ins.payload.participation, 'full')
      assert.match(ins.payload.client_key, /\S/)
      await done()
    })
    it('2台目で同じ項目・同じ度合いなら合流（merged・先の行を返す）、違う度合いなら taken（先の行の度合いを返す）', async () => {
      const other = { id: 7, resident_id: 1, day: '2026-10-21', label: '体操', participation: 'full', note: null, recorded_by: 3, rev: 1, client_key: 'other', deleted_at: null }
      const other2 = { ...other, id: 8, label: '歌', participation: 'observed', client_key: 'other2' }
      await fresh([other, other2])
      const m = await DB.insertDaycareActivity({ resident_id: 1, day: '2026-10-21', label: '体操', recorded_by: 4 })
      assert.equal(m.kind, 'merged')
      assert.equal(m.row.id, 7)
      const t = await DB.insertDaycareActivity({ resident_id: 1, day: '2026-10-21', label: '歌', recorded_by: 4 })
      assert.equal(t.kind, 'taken')
      assert.equal(t.row.participation, 'observed')
      await done()
    })
    it('通信できない時は送信待ち（queued）。この端末の送信待ちに追加として出る', async () => {
      const st = await fresh()
      st.down = true
      const r = await DB.insertDaycareActivity({ resident_id: 2, day: '2026-10-21', label: '散歩', participation: 'partial', recorded_by: 4 })
      assert.equal(r.kind, 'queued')
      const p = DB.pendingActivityOps().filter((x) => x.kind === 'add')
      assert.deepEqual(
        p.map((x) => [x.residentId, x.day, x.label, x.participation]),
        [[2, '2026-10-21', '散歩', 'partial']],
      )
      await done()
    })
    it('送信待ちを送る時: 他の端末が同じ項目を同じ度合いで先に入れていれば合流（止めない・1行のまま）、違う度合いなら止める', async () => {
      const st = await fresh()
      st.down = true
      await DB.insertDaycareActivity({ resident_id: 3, day: '2026-10-21', label: '園芸', recorded_by: 4 })
      await DB.insertDaycareActivity({ resident_id: 3, day: '2026-10-21', label: '歌', recorded_by: 4 })
      assert.equal(DB.pendingActivityOps().length, 2)
      // 圏外の間に、別の端末が同じ方の「園芸・参加」と「歌・見学」を入れた
      const base = { resident_id: 3, day: '2026-10-21', note: null, recorded_by: 3, rev: 1, deleted_at: null }
      st.rows.push({ ...base, id: 50, label: '園芸', participation: 'full', client_key: 'o-50' })
      st.rows.push({ ...base, id: 51, label: '歌', participation: 'observed', client_key: 'o-51' })
      st.down = false
      await DB.flushQueue(true)
      const left = DB.pendingActivityOps()
      assert.deepEqual(
        left.map((x) => [x.kind, x.label, x.stopped]),
        [['add', '歌', true]],
        '園芸は合流して送信待ちから外れ、歌は止まる（設定の「送れていない記録」で確かめる）',
      )
      assert.equal(st.rows.filter((r) => r.resident_id === 3 && r.label === '園芸').length, 1, '園芸は1行のまま')
      await done()
    })
    it('この端末の取り消しがまだ届いていない行には合流しない: 入れ直しは送信待ちにし、取り消しの後に新しい行として届く', async () => {
      const x = { id: 60, resident_id: 4, day: '2026-10-21', label: '書道', participation: 'full', note: null, recorded_by: 1, rev: 1, client_key: 'x-60', deleted_at: null }
      const st = await fresh([x])
      st.down = true
      const del = await DB.softDeleteDaycareActivity({ ...x }, { editedBy: 4 })
      assert.equal(del, 'queued')
      st.down = false
      // 電波が戻った直後（取り消しはまだ送信待ち）に〔その他〕から同じ項目を入れ直す
      const r = await DB.insertDaycareActivity({ resident_id: 4, day: '2026-10-21', label: '書道', recorded_by: 4 })
      assert.equal(r.kind, 'queued', '先の行（取り消し待ち）に合流しない')
      await DB.flushQueue(true)
      const shodo = st.rows.filter((row) => row.resident_id === 4 && row.label === '書道')
      assert.deepEqual(
        shodo.map((row) => [row.id === 60 ? 'old' : 'new', row.deleted_at === null ? 'live' : 'deleted']),
        [
          ['old', 'deleted'],
          ['new', 'live'],
        ],
        '取り消しが届いた後に、入れ直しが新しい行として残る',
      )
      assert.deepEqual(DB.pendingActivityOps(), [])
      await done()
    })
    it('活動一括の表の〔元に戻す〕（親の補足 2026-10-26）: 圏外で消す → 圏外のまま〔元に戻す〕 → 電波が戻って送ると、元の度合いの1行だけが残る', async () => {
      const x = { id: 70, resident_id: 5, day: '2026-10-21', label: '体操', participation: 'declined', note: null, recorded_by: 1, rev: 3, client_key: 'x-70', deleted_at: null }
      const st = await fresh([x])
      st.down = true
      // 不参加の次＝消す（画面は確かめを挟まず、トーストの〔元に戻す〕で戻す）
      assert.equal(await DB.softDeleteDaycareActivity({ ...x }, { editedBy: 4 }), 'queued')
      // 〔元に戻す〕＝消す前の度合いで入れ直す（画面の add(…, before, true)）。まだ圏外なので送信待ちに積む
      const r = await DB.insertDaycareActivity({ resident_id: 5, day: '2026-10-21', label: '体操', participation: 'declined', recorded_by: 4 })
      assert.equal(r.kind, 'queued')
      assert.deepEqual(
        DB.pendingActivityOps().map((p) => [p.kind, p.kind === 'update' ? p.deleted : p.participation]),
        [
          ['update', true],
          ['add', 'declined'],
        ],
        '取り消し → 入れ直しの順に積む',
      )
      st.down = false
      await DB.flushQueue(true)
      const live = st.rows.filter((row) => row.resident_id === 5 && row.day === '2026-10-21' && row.label === '体操' && row.deleted_at === null)
      assert.equal(live.length, 1, '生きている行は1行だけ')
      assert.equal(live[0].participation, 'declined', '元の度合い（不参加）に戻る')
      assert.notEqual(live[0].id, 70, '取り消しが届いた後に、入れ直しが新しい行として届く')
      assert.ok(st.rows.find((row) => row.id === 70).deleted_at !== null)
      assert.deepEqual(DB.pendingActivityOps(), [])
      await done()
    })
    it('活動一括の表の〔元に戻す〕: 取り消しがまだ送信待ちのうちに電波が戻ってから押しても、先の行に合流せず、元の度合いの1行だけが残る', async () => {
      const x = { id: 71, resident_id: 6, day: '2026-10-21', label: '歌', participation: 'observed', note: null, recorded_by: 1, rev: 2, client_key: 'x-71', deleted_at: null }
      const st = await fresh([x])
      st.down = true
      assert.equal(await DB.softDeleteDaycareActivity({ ...x }, { editedBy: 4 }), 'queued')
      st.down = false
      // 電波は戻ったが、取り消しはまだ届いていない（先の行は生きている）。〔元に戻す〕は合流させず送信待ちに積む
      const r = await DB.insertDaycareActivity({ resident_id: 6, day: '2026-10-21', label: '歌', participation: 'observed', recorded_by: 4 })
      assert.equal(r.kind, 'queued', '取り消し待ちの行に合流しない（後から届く取り消しで戻した記録まで消えない）')
      await DB.flushQueue(true)
      const live = st.rows.filter((row) => row.resident_id === 6 && row.label === '歌' && row.deleted_at === null)
      assert.deepEqual(live.map((row) => [row.id === 71 ? 'old' : 'new', row.participation]), [['new', 'observed']])
      assert.deepEqual(DB.pendingActivityOps(), [])
      await done()
    })
    it('未来の日・空の項目は送らない（DbError・通信しない）', async () => {
      const st = await fresh()
      await assert.rejects(DB.insertDaycareActivity({ resident_id: 1, day: '2999-01-01', label: '体操', recorded_by: 4 }), /未来の日/)
      await assert.rejects(DB.insertDaycareActivity({ resident_id: 1, day: '2026-10-21', label: '  ', recorded_by: 4 }), /項目を入れて/)
      assert.equal(st.calls.filter((c) => c.action === 'insert').length, 0)
      await done()
    })
    it('前回コピーの元は、その方の before より前の日だけを読む', async () => {
      const st = await fresh([
        { id: 1, resident_id: 1, day: '2026-10-20', label: '体操', participation: 'full', note: null, recorded_by: 1, rev: 1, deleted_at: null },
        { id: 2, resident_id: 1, day: '2026-10-22', label: '歌', participation: 'full', note: null, recorded_by: 1, rev: 1, deleted_at: null },
        { id: 3, resident_id: 2, day: '2026-10-20', label: '散歩', participation: 'full', note: null, recorded_by: 1, rev: 1, deleted_at: null },
      ])
      const prev = await DB.fetchPreviousActivities(1, '2026-10-22')
      assert.deepEqual(prev.map((a) => a.id), [1])
      const q = st.calls.find((c) => c.table === 'daycare_activity_log')
      assert.ok(q.filters.some(([op, k, v]) => op === 'lt' && k === 'day' && v === '2026-10-22'))
      assert.ok(q.filters.some(([op, k, v]) => op === 'eq' && k === 'resident_id' && v === 1))
      await done()
    })
  })

  describe('静的検査（段階2b の規律）', () => {
    const mig = read('../supabase/migrations/0044_daycare_activity.sql')
    const migCode = sqlCode('../supabase/migrations/0044_daycare_activity.sql')
    it('移行 0044: 追加のみ・冪等・旧クライアント×新サーバーを書く・do ブロックを使わない', () => {
      assert.match(mig, /旧クライアント×新サーバー/)
      assert.match(mig, /冪等/)
      assert.doesNotMatch(migCode, /do \$\$/i)
      assert.doesNotMatch(migCode, /\bdrop table\b|\bdelete from\b|\btruncate (table )?public\.|\balter table public\.(daycare_attendance|daycare_days|meals|fluid_intake|notes)\b/i)
      assert.match(migCode, /insert into public\.app_settings \(key, value\)\s+values \('input_enabled_daycare_activity', 'false'\)\s+on conflict \(key\) do nothing;/)
      assert.match(migCode, /create table if not exists public\.daycare_activity_log/)
      assert.match(migCode, /create unique index if not exists uq_daycare_activity\s+on public\.daycare_activity_log \(resident_id, day, label\)\s+where deleted_at is null;/)
    })
    it('移行 0044: 物理削除の権限なし（delete のポリシーを作らない・delete と truncate を外す）・RLS は 0041 と同じ形', () => {
      assert.doesNotMatch(migCode, /for delete/i)
      assert.match(migCode, /revoke delete, truncate on public\.daycare_activity_log from authenticated;/)
      assert.match(migCode, /create policy member_only on public\.daycare_activity_log as restrictive for all to authenticated\s+using \(private\.is_member\(\)\) with check \(private\.is_member\(\)\);/)
      assert.match(migCode, /record_history_capture\('day'\)/)
      assert.match(migCode, /check \(label = pg_catalog\.btrim\(label\) and pg_catalog\.char_length\(label\) between 1 and 40\)/)
    })
    it('移行 0044: Realtime の一時関数は、この中で作り直してから呼ぶ（pg_temp は接続ごと）', () => {
      const def = migCode.indexOf('create or replace function pg_temp.cl_realtime_add')
      const call = migCode.indexOf("select pg_temp.cl_realtime_add('daycare_activity_log')")
      assert.ok(def >= 0 && call > def)
      assert.match(migCode, /notify pgrst, 'reload schema';/)
    })
    it('types.ts は InputKind に1行足すだけ（INPUT_KINDS・ほかの型は元のまま）', () => {
      const t = read('../src/lib/types.ts')
      // 段階3a（2026-10-23）で機能訓練の1行が続けて足された（固定し直し・意図は同じ＝1行ずつ足す・INPUT_KINDS は元のまま）
      assert.match(t, /export type InputKind = 'bath' \| 'med' \| 'incident'\n {2}\| 'daycare' \/\/[^\n]*\n {2}\| 'daycare_activity' \/\/[^\n]*\n {2}\| 'daycare_training' \/\/[^\n]*\nexport const INPUT_KINDS: readonly InputKind\[\] = \['bath', 'med', 'incident'\]/)
      assert.doesNotMatch(t, /DaycareActivity/)
    })
    it('db.ts の配線: 送信待ちの表・活動だけの旗・自然キー（利用者・日・項目）・合流・相手の行を直す中身・別のチャンネル', () => {
      const db = code('../src/lib/db.ts')
      assert.match(db, /type LegacyTable = [^\n]*'daycare_activity_log'/)
      // 段階3a（2026-10-23）の機能訓練の2表が後ろに続く（固定し直し・意図は同じ＝活動は送信待ちの表に入っている）
      // 段階3b で末尾に居宅訪問（daycare_home_visits）が足された（活動の位置は変わらない）
      assert.match(db, /'daycare_attendance',\n {2}'daycare_activity_log',\n {2}'daycare_training_sessions',\n {2}'daycare_staffing',\n {2}'daycare_home_visits',\n\]/)
      assert.match(db, /if \(table === 'daycare_activity_log'\) return assertKindWritable\('daycare_activity'\)/)
      assert.match(db, /daycare_activity: 'デイの活動の記録はまだ使い始めていません（開始日に解禁します）'/)
      assert.match(db, /return day === null \|\| label === null \|\| label === '' \? null : \{ resident_id: residentId, day, label \}/)
      // 送信待ちの経路: 同じ度合いの行が先にあれば届いたのと同じ（合流）。その判定は止める判定より前
      const merge = db.indexOf("if (st === 'same') return 'sent'")
      const stop = db.indexOf("if (await naturalKeyTaken(sb, op.table, op.payload)) return 'conflict'")
      assert.ok(merge > 0 && stop > merge, '合流の判定は止める判定の直前')
      // 〔自分の内容で直す〕の中身は度合い・備考だけ（自然キー・冪等キー・記入者は送らない）
      assert.match(db, /omitKeys\(payload, \['client_key', 'resident_id', 'day', 'label', 'id', 'rev', 'deleted_at', 'recorded_by'\]\)/)
      // 段階1のデイのチャンネルには混ぜない（0044 を当てる前の DB で到着・欠席の購読を止めない）
      assert.match(db, /const REALTIME_DAYCARE_TABLES = \['daycare_attendance'\] as const/)
      assert.match(db, /const REALTIME_DAYCARE_ACTIVITY_TABLES = \['daycare_activity_log'\] as const/)
      assert.match(db, /sb\.channel\(`cl_dcact_/)
      // 読み取りは日か利用者で絞り、上限を付け、削除済みを除く
      const f = db.slice(db.indexOf('export async function fetchDaycareActivities'), db.indexOf('export type DaycareActivityAdd'))
      assert.equal((f.match(/\.is\('deleted_at', null\)/g) ?? []).length, 2)
      assert.equal((f.match(/\.limit\(/g) ?? []).length, 2)
    })
    it('止まった送信待ち・変更の記録の呼び名（設定の「送れていない記録」・履歴）', () => {
      const so = code('../src/lib/stoppedOps.ts')
      assert.match(so, /daycare_activity_log: 'デイの活動'/)
      assert.match(so, /participation: \{ label: '参加', fmt: labelOf\(ACTIVITY_PARTICIPATION_LABEL\) \}/)
      // 〔いまの記録とくらべる〕の対象に活動が入っている（段階3a で機能訓練が後ろに並んだので、閉じ括弧か「||」のどちらか）
      assert.match(so, /op\.table === 'daycare_activity_log'(\)| \|\|)/)
      assert.match(code('../src/lib/historyView.ts'), /daycare_activity_log: 'デイの活動'/)
    })
    it('活動の欄（部品）: 書き込みは活動の3つの関数だけ・活動だけの旗・合流には〔元に戻す〕を出さない・取り消しは確認つき', () => {
      const s = code('../src/components/DaycareActivitySection.tsx')
      const writes = s.match(/\b(save\w+|insert\w+|update\w+|delete\w+|softDelete\w+|upsert\w+|discard\w+)\(/g) ?? []
      assert.deepEqual([...new Set(writes.map((w) => w.slice(0, -1)))].sort(), ['insertDaycareActivity', 'softDeleteDaycareActivity', 'updateDaycareActivity'])
      assert.doesNotMatch(s, /supabase|\.from\(|\.rpc\(|localStorage/)
      assert.match(s, /getKindInputGate\('daycare_activity'\)/)
      const merged = s.slice(s.indexOf("if (r.kind === 'merged') {"), s.indexOf("setMsg((m) => (m !== null && m.key === key ? null : m))"))
      assert.ok(merged.length > 0)
      assert.doesNotMatch(merged, /show\(/, '合流した時はトースト（〔元に戻す〕）を出さない')
      assert.match(s, /onClick=\{\(\) => setDelTarget\(a\)\}/)
      assert.match(s, /<ConfirmDialog\s+open=\{delTarget !== null\}/)
      // 止まった追加は、同じ項目の行がサーバーにあっても出す（試験用 Supabase の U3 で見つけた）
      assert.match(s, /p\.kind === 'add' && p\.residentId === residentId && p\.day === day && \(p\.stopped \|\| !have\.has\(p\.label\)\)/)
      // 送り先（人・日）は押した時に固定する
      assert.match(s, /const rid = residentId\s+const d = day\s+const key = `\$\{rid\}:\$\{d\}`/)
    })
    it('2b の反証の直し（重大1・中1・中2）', () => {
      const s = code('../src/components/DaycareActivitySection.tsx')
      // 重大1: 前回は「読んだ時の人・日」の印を持ち、いま開いている人・日と違えば使わない。この方の行だけから選ぶ
      //   （部品を key で作り直す直しは、確認の反証で「圏外で人を切り替えると活動の欄が使えない」退行が出たのでやめた）
      assert.doesNotMatch(code('../src/pages/DaycarePersonPage.tsx'), /<DaycareActivitySection key=/)
      assert.match(s, /prev === null \|\| prev\.key !== personKey \? null : previousActivities\(prev\.rows\.filter\(\(r\) => r\.resident_id === residentId\), day\)/)
      assert.match(s, /setPrev\(\(old\) => \(before !== null \? \{ key: k, rows: before \} : old !== null && old\.key === k \? old : null\)\)/)
      // 中1: 取り消しの送信待ちの行は外さず「取り消しの送信待ち」で残し、同じ項目のチップを押せなくする
      assert.doesNotMatch(s, /\.filter\(\(a\) => upd\.get\(a\.id\)\?\.deleted !== true\)/)
      assert.match(s, /deleting: p\?\.deleted === true,/)
      assert.match(s, /取り消しの送信待ち（電波が戻ると自動で送信します。届くまで同じ項目は入れられません）/)
      assert.match(s, /const labelsNow = new Set\(\[\.\.\.shown\.list\.map\(\(x\) => x\.a\.label\)/)
      // 確認の反証 中2: 〔その他〕からも取り消しの送信待ちの項目は入れない。DB 側も、取り消し待ちの行には合流しない
      assert.match(s, /if \(deletingLabels\.has\(label\)\) \{/)
      const db = code('../src/lib/db.ts')
      assert.match(db, /if \(st === 'deleting'\) return 'retry'/)
      assert.match(db, /if \(row !== null && activityDeletePending\(row\.id\)\) return queued\(\)/)
      // 中2: 止まった度合いの変更・取り消しはその行の下で知らせる
      assert.match(s, /if \(p\.stopped\) stoppedUpd\.set\(p\.rowId, p\)/)
      assert.match(s, /stopped: stoppedUpd\.get\(a\.id\) \?\? null,/)
      assert.match(s, /は、他の端末の変更と食い違って止まっています（送っていません）。/)
    })
    it('1人の記録の画面: 活動の欄は別の部品で、昼食・水分の書き込みの経路は変えない', () => {
      const p = code('../src/pages/DaycarePersonPage.tsx')
      assert.match(p, /<DaycareActivitySection\s+residentId=\{residentId\}\s+residentName=\{name\}\s+day=\{data\.day\}\s+today=\{today\}\s+actorId=\{actorId\}\s+show=\{show\}\s+refreshKey=\{reloadKey\}\s+markSlot=\{\(a\) => marks\.button\(\{ kind: 'activity', id: a\.id \}, activityMarkText\(activityText\(a\)\)\)\}\s+\/>/)
      assert.doesNotMatch(p, /DaycareActivity\(|insertDaycareActivity/)
    })
    it('活動一括の画面: 書き込みは活動の3つの関数だけ・相手は activityTargets（一括の画面と同じ方）・端末に業務データを残さない', () => {
      const b = code('../src/pages/DaycareActivityBulkPage.tsx')
      const writes = b.match(/\b(save\w+|insert\w+|update\w+|delete\w+|softDelete\w+|upsert\w+|discard\w+)\(/g) ?? []
      // 2026-10-26 表にした（固定し直し・意図は同じ）: 枠を押すと度合いが変わり、不参加の次は消すので、1人の画面の活動の欄と同じ3つになった。
      // 書き込みの経路はこの3つより増やさない（DB・旗・db.ts の関数は変えない）
      assert.deepEqual([...new Set(writes.map((w) => w.slice(0, -1)))].sort(), ['insertDaycareActivity', 'softDeleteDaycareActivity', 'updateDaycareActivity'])
      assert.match(b, /const targets = board === null \? \[\] : activityTargets\(board\.rows\)/)
      assert.match(b, /getKindInputGate\('daycare_activity'\)/)
      assert.doesNotMatch(b, /supabase|\.from\(|\.rpc\(|localStorage/)
    })
    it('活動一括の表（2026-10-26）: 列の並び（氏名｜定型の7つ｜その他）・氏名の列は左に残す・バイタル一括と同じ枠・知らせの行は表の幅を広げない', () => {
      const b = code('../src/pages/DaycareActivityBulkPage.tsx')
      const head = b.slice(b.indexOf('<thead>'), b.indexOf('</thead>'))
      const iName = head.indexOf('<span className="dc-vital-name block">氏名</span>')
      const iChips = head.indexOf('{DAYCARE_ACTIVITY_CHIPS.map((c) => (')
      const iOther = head.indexOf('その他')
      assert.ok(iName > 0 && iName < iChips && iChips < iOther, '氏名 → 定型の7つ（DAYCARE_ACTIVITY_CHIPS の順） → その他')
      assert.match(head, /<th scope="col" className="sticky left-0 z-20 bg-surface2 px-2 py-2 text-sm font-bold text-ink2">/)
      assert.match(b, /<th scope="row" className="sticky left-0 z-20 bg-bg px-2 py-1 text-left font-normal">\s*(\{\}\s*)?<div className="dc-vital-name space-y-1">/)
      assert.match(b, /role="region"\s+aria-label=\{`\$\{fmtDayLabel\(day\)\}の活動一括の表\$\{tableScrolls \? '（横にスクロールできます）' : ''\}`\}\s+tabIndex=\{tableScrolls \? 0 : undefined\}\s+className="relative overflow-x-auto"/)
      assert.match(b, /<table className="w-full min-w-max border-collapse text-base">\s*<caption className="sr-only">/)
      // 行の列は見出しと同じ並び（定型の7つの枠 → その他の枠）
      const body = b.slice(b.indexOf('<tbody>'), b.indexOf('</tbody>'))
      assert.ok(body.indexOf('{DAYCARE_ACTIVITY_CHIPS.map((c) => (') < body.indexOf('{others.map((l) => cellButton(rid, name, l, true))}'))
      assert.match(body, /<td colSpan=\{DAYCARE_ACTIVITY_CHIPS\.length \+ 2\} className="p-0">\s*<div className="w-0 min-w-full">\s*<div className="sticky left-0 space-y-1 px-2 pb-2" style=\{\{ maxWidth: tableBoxWidth > 0 \? tableBoxWidth : undefined \}\}>/)
      // 表の枠の幅は ResizeObserver で測る（バイタル一括と同じ）
      assert.match(b, /const ro = new ResizeObserver\(check\)\s+ro\.observe\(el\)\s+if \(el\.firstElementChild\) ro\.observe\(el\.firstElementChild\)/)
      // 氏名の列: 1人の画面への入口（44px）
      assert.match(body, /<Link\s+to=\{personPath\(rid, day, today\)\}[^>]*className="inline-flex min-h-tap /)
      // 前の上の区画（チップで選ぶ・チェック）と下の「1人ずつの活動」の一覧は外した
      assert.doesNotMatch(b, /type="checkbox"|picked|チェックした|h-each|1人ずつの活動/)
    })
    it('活動一括の表: 枠を押すと nextParticipation で進み、不参加の次は確かめを挟まず消して〔元に戻す〕（取り消しが送信待ちでも出す）・合流には出さない', () => {
      const b = code('../src/pages/DaycareActivityBulkPage.tsx')
      const cyc = b.slice(b.indexOf('const cycle = async'), b.indexOf('const openOther ='))
      assert.match(cyc, /if \(a === null\) \{\s*await add\(rid, d, label, 'full'\)/)
      assert.match(cyc, /const next = nextParticipation\(a\.participation\)\s+if \(next === null\) await remove\(a, nameOf\(rid\)\)\s+else await setParticipation\(a, next\)/)
      const rm = b.slice(b.indexOf('const remove = async'), b.indexOf('const arrivalOk ='))
      // 戻す先（人・日・項目・消す前の度合い）は消す時に固定し、db.ts の取り消し待ちの決まりに任せて入れ直す
      // 2026-10-26 反証の直し（固定し直し・意図は同じ）: 戻す先は item に固定し、トーストは offerUndo から出す
      assert.match(rm, /const item = \{ rid: a\.resident_id, day: a\.day, label: a\.label, before: a\.participation, name \}/)
      assert.match(rm, /if \(r === 'queued'\) \{[\s\S]*?offerUndo\(\{ \.\.\.item, queued: true \}\)/)
      assert.match(rm, /\} else if \(r === true\) \{\s*dropRow\(a\.day, a\.id\)\s*clearMsg\(key\)\s*offerUndo\(\{ \.\.\.item, queued: false \}\)/)
      // 取り消しの送信待ちでは行を落とさない（届くまで列の見出しの一括の相手から外す＝「記録あり」と数える・反証の試験の穴）
      const queuedBranch = rm.slice(rm.indexOf("if (r === 'queued') {"), rm.indexOf('} else if (r === true) {'))
      assert.ok(queuedBranch.length > 0)
      assert.doesNotMatch(queuedBranch, /dropRow\(/, '取り消しの送信待ちの時は dropRow しない')
      // 〔元に戻す〕は db.ts の取り消し待ちの決まりに任せて、消す前の度合いで入れ直す（fromUndo）
      const ua = b.slice(b.indexOf('const undoAll = async'), b.indexOf('const offerUndo ='))
      assert.match(ua, /await add\(it\.rid, it\.day, it\.label, it\.before, true\)/)
      // 違う日を開いている時・戻せなかった分がある時は、トーストで結果を返す（反証 軽6）
      assert.match(ua, /const away = items\.some\(\(it\) => it\.day !== dayRef\.current\)/)
      assert.match(ua, /を戻せませんでした。その日を開いて確かめ、もう一度入れてください。/)
      // 戻している間に新しい〔元に戻す〕のトーストが出ていたら、結果のトーストで置き換えない（確認の反証 軽1）
      assert.match(ua, /if \(undoBatch\.current\.items\.length > 0 && Date\.now\(\) - undoBatch\.current\.at < UNDO_WINDOW_MS\) return\s+if \(failed\.length > 0\)/)
      // 入れ直しの記録者は押した時の値（ref）から読む（消した時の画面の値を使わない＝確認の反証 軽3）
      assert.match(b, /recorded_by: actorRef\.current \}\)/)
      assert.match(b, /if \(actorRef\.current === null\) return MSG_NO_RECORDER/)
      // 止まった送信待ちには「届いてから」と言わない（確認の反証 軽2）
      assert.match(b, /送れずに止まっています。設定の「送れていない記録」で確かめてください。/)
      assert.match(b, /押せません。設定の「送れていない記録」で確かめてください/)
      // トーストが出ている間に続けて消した分は、1つのトーストでまとめて戻す（2件目を消しても1件目を戻せる＝反証 中1）
      const ou = b.slice(b.indexOf('const offerUndo ='), b.indexOf('const remove = async'))
      assert.match(b, /const UNDO_WINDOW_MS = 8000/)
      assert.match(code('../src/components/ui.tsx'), /const TOAST_UNDO_MS = 8000/, 'トーストの長さと同じ')
      assert.match(ou, /const items = now - b\.at < UNDO_WINDOW_MS \? \[\.\.\.b\.items\.filter\(/)
      assert.match(ou, /undoBatch\.current = \{ at: 0, items: \[\] \}\s+void undoAll\(items\)/)
      assert.doesNotMatch(b, /<ConfirmDialog\s+open=\{delTarget/, '消す時は確かめの小窓を出さない')
      // 〔元に戻す〕だけは取り消しの送信待ちでも入れ直す（ふつうに押した時は、届くまで入れない＝2b の反証 中1）
      assert.match(b, /if \(!fromUndo\) \{\s*const c = cellOf\(rid, label\)\s*if \(c\.deleting\) \{\s*say\(key, 'warn', `「\$\{label\}」は取り消しの送信待ちです。取り消しが届いてから入れ直してください。`\)/)
      // 〔＋〕で、送信待ち（取り消しと入れ直しの両方を含む）・保存中の項目は入れない（同じ項目の追加を2つ積まない＝反証 軽7）
      assert.match(b, /if \(c\.locked \|\| busy\.has\(bk\)\) \{[\s\S]*?: `「\$\{label\}」は送信待ち・保存中です。届いてから押してください。`,\s*\)\s*return false/)
      const merged = b.slice(b.indexOf("if (r.kind === 'merged') {"), b.indexOf('clearMsg(key)\n      return true'))
      assert.ok(merged.length > 0)
      assert.doesNotMatch(merged, /show\(/, '合流した時はトースト（〔元に戻す〕）を出さない')
      // 合流・食い違い・他の端末が先に直した・送信待ちの文は1人の画面の活動の欄と同じ
      const sec = code('../src/components/DaycareActivitySection.tsx')
      for (const t of [
        'は同じ記録が先にありました（1件にまとめました）。',
        'いまの内容に読み直しました。確かめてから、必要なら度合いを変えてください。',
        'は他の端末が先に直していました。最新の内容に読み直しました。確かめてから、もう一度押してください。',
        '電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。',
      ]) {
        assert.ok(sec.includes(t), t)
        assert.ok(b.includes(t), t)
      }
    })
    it('活動一括の表: 保存中の枠・送信待ちの枠・取り消しの送信待ちの枠は押せない（前の保存の結果＝新しい rev の行の上に次を送る）', () => {
      const b = code('../src/pages/DaycareActivityBulkPage.tsx')
      assert.match(b, /const saving = busy\.has\(`\$\{day\}:\$\{rid\}:\$\{label\}`\)/)
      assert.match(b, /disabled=\{!canWrite \|\| running \|\| saving \|\| c\.locked\}/)
      // 3つの書き込みは、どれも応答を待つ間その枠を保存中にする
      assert.equal((b.match(/setBusyKey\(bk, true\)/g) ?? []).length, 3)
      assert.equal((b.match(/\} finally \{\s*setBusyKey\(bk, false\)/g) ?? []).length, 3)
      // 書けた行（新しい rev）を画面の行に映す（古い rev で次を送らない）
      assert.match(b, /putRow\(a\.day, r\)/)
      assert.match(b, /putRow\(d, r\.row\)/)
      // 書く前に始まった静かな読み直しは、書けた時に捨てて読み直し直す（返った古い行で新しい rev を上書きしない＝反証 軽11）
      assert.match(b, /quietGen\.current = quiet \? gen : null/)
      assert.match(b, /const dropStaleReload = \(\) => \{\s*if \(quietGen\.current !== null && quietGen\.current === genRef\.current\) \{\s*genRef\.current \+= 1\s*quietGen\.current = null\s*scheduleReload\(\)/)
      assert.match(b, /const putRow = \(d: string, row: DaycareActivity\) => \{\s*dropStaleReload\(\)/)
      assert.match(b, /const dropRow = \(d: string, id: number\) => \{\s*dropStaleReload\(\)/)
      // 押せない時は「押すと…」と読み上げない（旗が閉じている・一括の最中も＝反証 軽3）
      assert.match(b, /: running\s+\? `\$\{head\}まとめて入れている間は押せません`\s+: !canWrite\s+\? `\$\{head\}いまは押せません（画面の上の知らせを見てください）`\s+: `\$\{head\}押すと/)
      // 送信待ちの度合いの変更は重ねて出して押せない・取り消しの送信待ちも押せない・まだ載っていない送信待ちの追加も押せない
      assert.match(b, /return \{ row: a, shown: p\?\.participation \?\? a\.participation, waiting: p !== undefined, deleting, locked: p !== undefined, stopped \}/)
      // 止まった変更と止まった追加が両方ある時は両方知らせる（1人の画面の活動の欄と同じ＝反証 軽8）
      assert.match(b, /const stopped = \[\.\.\.\(st === undefined \? \[\] : \[stoppedUpdText\(label, st\)\]\), \.\.\.addNote\]/)
      assert.match(b, /if \(liveAdd !== undefined\) \{\s*return \{ row: null, shown: liveAdd\.participation, waiting: true, deleting: false, locked: true,/)
      assert.match(b, /if \(cell\.locked \|\| busy\.has\(`\$\{d\}:\$\{rid\}:\$\{label\}`\)\) return/)
      // 送信待ちの重ねは、この端末の送信待ちそのもの（pendingActivityOps）から出す
      assert.match(b, /setPending\(pendingActivityOps\(\)\)/)
    })
    it('活動一括の表: 未到着の方の枠は確かめを挟む（その方・その日につき画面を開いている間に1回・端末に残さない）・列の見出しは確かめの小窓から一括', () => {
      const b = code('../src/pages/DaycareActivityBulkPage.tsx')
      assert.match(b, /const arrivalOk = \(rid: number, d: string\) => activityDefaultChecked\(rowOf\(rid\)\) \|\| lateOk\.current\.has\(`\$\{d\}:\$\{rid\}`\)/)
      assert.match(b, /if \(!arrivalOk\(rid, d\)\) \{\s*setLateAsk\(\{ rid, day: d, label \}\)\s*return/)
      assert.match(b, /<ConfirmDialog\s+open=\{lateAsk !== null\}\s+title=\{lateAsk === null \? '' : `\$\{nameOf\(lateAsk\.rid\)\}さんはまだ到着していません。記録しますか`\}/)
      assert.match(b, /lateOk\.current\.add\(`\$\{t\.day\}:\$\{t\.rid\}`\)/)
      assert.match(b, /const lateOk = useRef<Set<string>>\(new Set\(\)\)/)
      // 〔＋〕も未到着の方は先に確かめる
      assert.match(b, /if \(!arrivalOk\(rid, day\)\) \{\s*setLateAsk\(\{ rid, day, label: null \}\)/)
      // 列の見出し → 確かめの小窓 → 〔入れる〕で runBulk（1人ずつ insertDaycareActivity・結果は bulkResultText）
      assert.match(b, /onClick=\{\(\) => askFill\(c\)\}/)
      assert.match(b, /<ConfirmDialog\s+open=\{fillAsk !== null\}/)
      assert.match(b, /`\$\{fillAsk\}を、来た方のうち記録の無い \$\{fillTargets\(fillAsk\)\.length\}人に「参加」で入れます。/)
      assert.match(b, /confirmLabel="入れる"\s+onConfirm=\{\(\) => fillAsk !== null && void runBulk\(fillAsk\)\}/)
      const run = b.slice(b.indexOf('const runBulk = async'), b.indexOf('const otherErr ='))
      assert.match(run, /const ids = fillTargets\(l\)/)
      assert.match(run, /const r = await insertDaycareActivity\(\{ resident_id: rid, day: d, label: l, recorded_by: actorId \}\)/)
      assert.match(run, /setResult\(\{ day: d, tone: bad \? 'warn' : 'info', text: bulkResultText\(l, outcomes\) \}\)/)
      // 一括の相手の「記録あり」は、サーバーの行（取り消しの送信待ちの行も残っている）と送信待ちの追加
      // 2026-10-26 反証 軽5 で保存中（応答待ち）も足した（応答待ちの方へ一括で2回目を送らない）
      assert.match(b, /const has = \(rid: number, l: string\) =>\s+rowsByKey\.has\(`\$\{rid\}\\t\$\{l\}`\) \|\| overlay\.adds\.some\(\(p\) => p\.residentId === rid && p\.label === l\) \|\| busy\.has\(`\$\{day\}:\$\{rid\}:\$\{l\}`\)/)
      // 「その他」の見出しの読み上げは見えている「その他」で始める（label-in-name・反証 軽4）
      assert.match(b, /aria-label="その他：ほかの活動を、/)
      // 「その他」の見出し・〔＋〕は項目を入れる小窓（40字・そろえた形で検査）
      assert.match(b, /onClick=\{askOther\}/)
      assert.match(b, /const otherErr = otherText === '' \? null : activityLabelError\(otherText\)/)
      assert.match(b, /const l = normalizeActivityLabel\(otherText\)/)
      assert.match(b, /if \(ask\.rid === null\) askFill\(l\)\s+else void add\(ask\.rid, ask\.day, l, 'full'\)/)
    })
    it('デイの一覧: 活動を読めない時は印を出さない（「記録なし」に見せない）・切り替えに〔活動一括〕・ルート', () => {
      const d = code('../src/pages/DaycarePage.tsx')
      assert.match(d, /const activities = await fetchDaycareActivities\(target\)\.catch\(\(\) => null\)/)
      // 今日の画面の改善 1回目（代表者の回答 A3・2026-10-23）で、活動・水分の札は一覧から外し、1人の記録の画面で見る（固定し直し）。
      // 一覧に活動の件数を出さない＝読めない時に「記録なし」に見せる筋も無い
      assert.doesNotMatch(d, /activityCountOf|activityChipText|fluidOf\(/)
      const person = code('../src/pages/DaycarePersonPage.tsx')
      assert.match(person, /import \{ activityText \} from '\.\.\/lib\/daycareActivity'/)
      assert.match(person, /fluidTotalOf\(/)
      // 2026-10-24（§9.4）: 「活動をまとめて」→「活動一括」。ルートと key は変えない（固定し直し）
      assert.match(d, /\{ key: 'activity', to: '\/record\/daycare\/bulk', label: '活動一括' \}/)
      const app = code('../src/App.tsx')
      assert.match(app, /<Route path="\/record\/daycare\/bulk" element=\{<DaycareActivityBulkPage actorId=\{actorId\} staff=\{staff\} \/>\} \/>/)
      assert.match(app, /if \(pathname === '\/record\/daycare\/bulk'\) return 'デイ 活動一括'/)
      const b = code('../src/pages/DaycareActivityBulkPage.tsx')
      assert.match(b, /<h2 id="h-bulk" className="text-xl font-bold text-ink">\s*活動一括\s*<\/h2>/)
      for (const f of ['../src/App.tsx', '../src/pages/DaycarePage.tsx', '../src/pages/DaycareActivityBulkPage.tsx'])
        assert.equal(code(f).includes('活動をまとめて'), false, f)
    })
    it('純ロジックは端末に何も残さない（localStorage を使わない）', () => {
      assert.doesNotMatch(code('../src/lib/daycareActivity.ts'), /localStorage|supabase/)
    })
  })
}
