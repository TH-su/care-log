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
    it('まとめて記録の相手は、その日に来た方（在席・帰宅）だけ。欠席・未到着・予定は入れない', () => {
      const rows = [
        { residentId: 1, state: 'present' },
        { residentId: 2, state: 'absent' },
        { residentId: 3, state: 'left' },
        { residentId: 4, state: 'planned' },
      ]
      assert.deepEqual(A.activityTargets(rows), [1, 3])
    })
    it('まとめて記録の結果の文は人数で出す（合流・送信待ち・先に違う度合い・失敗を分ける）', () => {
      assert.equal(A.bulkResultText('体操', ['saved', 'saved', 'merged']), '「体操」: 2人に入れました。1人は同じ記録が先にありました。')
      assert.match(A.bulkResultText('体操', ['queued', 'taken', 'error']), /1人はこの端末に保存しました.*1人は違う参加の度合いで先に記録がありました.*1人は保存できませんでした/)
      assert.equal(A.bulkResultText('体操', []), '「体操」: 対象の方がいません。')
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
      assert.match(t, /export type InputKind = 'bath' \| 'med' \| 'incident'\n {2}\| 'daycare' \/\/[^\n]*\n {2}\| 'daycare_activity' \/\/[^\n]*\nexport const INPUT_KINDS: readonly InputKind\[\] = \['bath', 'med', 'incident'\]/)
      assert.doesNotMatch(t, /DaycareActivity/)
    })
    it('db.ts の配線: 送信待ちの表・活動だけの旗・自然キー（利用者・日・項目）・合流・相手の行を直す中身・別のチャンネル', () => {
      const db = code('../src/lib/db.ts')
      assert.match(db, /type LegacyTable = [^\n]*'daycare_activity_log'/)
      assert.match(db, /'daycare_attendance',\n {2}'daycare_activity_log',\n\]/)
      assert.match(db, /if \(table === 'daycare_activity_log'\) return assertKindWritable\('daycare_activity'\)/)
      assert.match(db, /daycare_activity: 'デイの活動の記録はまだ使い始めていません（開始日に解禁します）'/)
      assert.match(db, /return day === null \|\| label === null \|\| label === '' \? null : \{ resident_id: residentId, day, label \}/)
      // 送信待ちの経路: 同じ度合いの行が先にあれば届いたのと同じ（合流）。その判定は止める判定より前
      const merge = db.indexOf("if (op.table === 'daycare_activity_log' && (await activitySameLanded(sb, op.payload))) return 'sent'")
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
      assert.match(so, /op\.table === 'daycare_activity_log'\)/)
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
    it('1人の記録の画面: 活動の欄は別の部品で、昼食・水分の書き込みの経路は変えない', () => {
      const p = code('../src/pages/DaycarePersonPage.tsx')
      assert.match(p, /<DaycareActivitySection residentId=\{residentId\} residentName=\{name\} day=\{data\.day\} today=\{today\} actorId=\{actorId\} show=\{show\} refreshKey=\{reloadKey\} \/>/)
      assert.doesNotMatch(p, /DaycareActivity\(|insertDaycareActivity/)
    })
    it('まとめて記録の画面: 書き込みは insertDaycareActivity だけ・相手は activityTargets（在席・帰宅）・端末に業務データを残さない', () => {
      const b = code('../src/pages/DaycareActivityBulkPage.tsx')
      const writes = b.match(/\b(save\w+|insert\w+|update\w+|delete\w+|softDelete\w+|upsert\w+|discard\w+)\(/g) ?? []
      assert.deepEqual([...new Set(writes.map((w) => w.slice(0, -1)))].sort(), ['insertDaycareActivity'])
      assert.match(b, /const targets = board === null \? \[\] : activityTargets\(board\.rows\)/)
      assert.match(b, /getKindInputGate\('daycare_activity'\)/)
      assert.doesNotMatch(b, /supabase|\.from\(|\.rpc\(|localStorage/)
    })
    it('デイの一覧: 活動を読めない時は印を出さない（「記録なし」に見せない）・切り替えに〔活動をまとめて〕・ルート', () => {
      const d = code('../src/pages/DaycarePage.tsx')
      assert.match(d, /const activities = await fetchDaycareActivities\(target\)\.catch\(\(\) => null\)/)
      assert.match(d, /\{activityCountOf\(row\.residentId\) !== null \? \(/)
      assert.match(d, /\{ key: 'activity', to: '\/record\/daycare\/bulk', label: '活動をまとめて' \}/)
      const app = code('../src/App.tsx')
      assert.match(app, /<Route path="\/record\/daycare\/bulk" element=\{<DaycareActivityBulkPage actorId=\{actorId\} staff=\{staff\} \/>\} \/>/)
      assert.match(app, /if \(pathname === '\/record\/daycare\/bulk'\) return 'デイ 活動をまとめて'/)
    })
    it('純ロジックは端末に何も残さない（localStorage を使わない）', () => {
      assert.doesNotMatch(code('../src/lib/daycareActivity.ts'), /localStorage|supabase/)
    })
  })
}
