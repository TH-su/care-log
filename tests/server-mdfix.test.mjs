// サーバー移行（0021〜0030）と端末側の回帰試験（2026-10-10 多端末運用の監査 サーバー移行の担当:
// F09・F25・F28・F29・F39・F40・F44・F70・F71・F08 の続き）。直す前の版では赤、直した後で緑になる形。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// ・移行の文面は静的に確かめる（DB を使う契約は tests/migrations-pg.mjs・tests/note-contract-pg.mjs が使い捨ての Postgres で流す）
// ・端末側は db.ts を偽の Supabase で動かす（通信しない。window は定義しない）
// 個人情報は置かない（利用者・職員は数値IDと合成の名前だけ。本文は記号だけ）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as NC from './note-contract.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIG = join(ROOT, 'supabase', 'migrations')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const migFiles = () => readdirSync(MIG).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
const mig = (prefix) => {
  const f = migFiles().find((x) => x.startsWith(prefix))
  assert.ok(f, `移行 ${prefix} が無い`)
  return readFileSync(join(MIG, f), 'utf8')
}
/** SQL のコメント（-- から行末）を外す（文面の検査で注記の言葉に引っかからないように） */
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '')

const UNSUPPORTED = 'この Node では TypeScript・解決フックを使えないため、端末側の検証をスキップしました（Node 22.18 以降で実行してください）。'

const lsStore = new Map()
let DB = null
let V = null
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
    setItem: (k, v) => lsStore.set(k, String(v)),
    removeItem: (k) => lsStore.delete(k),
  }
  DB = await import('../src/lib/db.ts?server-mdfix')
  V = await import('../src/lib/appVersion.ts?server-mdfix')
} catch {
  DB = null
}
const need = () => {
  if (DB === null) assert.fail(UNSUPPORTED)
}

// ── 偽の Supabase（通信しない） ───────────────────────────────────────────────

function fakeSupabase(handler, extra = {}) {
  const calls = []
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
  return { client: { from, rpc, removeChannel: () => Promise.resolve('ok'), auth: { onAuthStateChange() {} }, ...extra }, calls }
}

const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms))

afterEach(async () => {
  if (DB === null) return
  DB.__testHooks.setClient(null)
  DB.__testHooks.setClientBuild(null)
  lsStore.clear()
  await DB.__testHooks.restartQueue()
})

// ─────────────────────────────────────────────────────────────────────────────
// 共通: 既存の移行は書き換えない・新しい移行の作法
// ─────────────────────────────────────────────────────────────────────────────

describe('移行の作法（決定事項4）', () => {
  it('0001〜0020 は本番に当たった中身のまま（書き換えない）', () => {
    const want = {
      '0001_init.sql': '7ff656d3373d412e',
      '0002_timeline_rpc.sql': '40cadf3e72fc13c3',
      '0003_sheet_ui.sql': '9e2777f2d43fa3fa',
      '0004_vitals_client_key.sql': '251a10e11c0fcaa0',
      '0005_meals_sheet_fluids.sql': 'ba33c85f29f2f79b',
      '0006_staff_manual.sql': 'f1331b389a6e1b44',
      '0007_resident_note_alias.sql': 'de03ecdcd046d749',
      '0008_import_tombstone_mark.sql': '4f09cf5d073c8b95',
      '0009_manager_staff_id.sql': '2ea53e23165c85c4',
      '0010_record_history.sql': '83295c109ccf07d6',
      '0011_apply_cell_edits.sql': 'b6e741457487a249',
      '0012_bath_records.sql': '890d770ee30c371b',
      '0013_med_admin.sql': 'fc53aab534c99bc0',
      '0014_incidents.sql': '06edf600ad8aae90',
      '0015_auto_check.sql': '7e5eab9d80ece89f',
      '0016_auto_check2.sql': 'a84b35f4531522c8',
      '0017_apply_note_edits.sql': '6b187e75f50ef149',
      '0018_bath_cancel_reason_optional.sql': '880a45d3121f618b',
      '0019_member_only_old_tables.sql': 'c924ee80148c7878',
      '0020_delete_vital.sql': '6debf62c9f0c2532',
    }
    for (const [f, h] of Object.entries(want)) {
      const got = createHash('sha256').update(readFileSync(join(MIG, f))).digest('hex').slice(0, 16)
      assert.equal(got, h, `${f} が書き換わっている`)
    }
  })

  it('0021 以降は1つずつ番号を持ち、旧クライアント×新サーバーの挙動を書き、do ブロックを使わない', () => {
    const newer = migFiles().filter((f) => Number(f.slice(0, 4)) >= 21)
    assert.ok(newer.length >= 10, `0021〜0030 が足りない: ${newer.join(',')}`)
    const nums = newer.map((f) => f.slice(0, 4))
    assert.equal(new Set(nums).size, nums.length, '同じ番号の移行がある')
    for (const f of newer) {
      const s = readFileSync(join(MIG, f), 'utf8')
      assert.match(s, /旧クライアント×新サーバー/, `${f} に旧クライアント×新サーバーの説明が無い`)
      assert.match(s, /冪等/, `${f} に冪等の説明が無い`)
      assert.doesNotMatch(stripComments(s), /\bdo \$\$/, `${f} が do ブロックを使っている`)
      assert.doesNotMatch(s, /[一-龥]{1,3}[ 　]?[一-龥]{1,3}様/, `${f} に実名らしい表記がある`)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F39: 変更の記録のトリガ関数の search_path
// ─────────────────────────────────────────────────────────────────────────────

describe('★F39 record_history_capture の search_path に pg_temp を末尾で明示する（0021）', () => {
  it('最後に作り直す移行が public, pg_temp を指定し、本文は 0010 と同じ', () => {
    const defs = migFiles().filter((f) => /create or replace function (public\.)?record_history_capture\(\)/.test(readFileSync(join(MIG, f), 'utf8')))
    const last = readFileSync(join(MIG, defs[defs.length - 1]), 'utf8')
    assert.ok(Number(defs[defs.length - 1].slice(0, 4)) >= 21, '0010 のまま（作り直していない）')
    assert.match(last, /security definer\s+(--[^\n]*\n\s*)*set search_path = public, pg_temp/)
    const body = (s) => {
      const i = s.indexOf('declare\n  o       jsonb;')
      const j = s.indexOf('$$;', i)
      return s.slice(i, j).replace(/\s+/g, ' ')
    }
    assert.equal(body(last), body(mig('0010')), '本文が 0010 と違う（取込の判定が変わる）')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F40: app_settings の書き込み・出勤者と表示名の変更の記録
// ─────────────────────────────────────────────────────────────────────────────

describe('★F40 app_settings は authenticated から書けない・出勤者と表示名の変更を記録に残す（0022・0024・0025）', () => {
  it('0022: insert_auth・update_auth を外し、表の権限も外す（読む許可は残す）', () => {
    const s = stripComments(mig('0022'))
    assert.match(s, /drop policy if exists "insert_auth" on public\.app_settings;/)
    assert.match(s, /drop policy if exists "update_auth" on public\.app_settings;/)
    assert.match(s, /revoke insert, update, delete, truncate on public\.app_settings from anon, authenticated;/)
    assert.doesNotMatch(s, /read_auth/)
    assert.doesNotMatch(s, /member_only/)
  })

  it('アプリは app_settings を読むだけ（書く経路が無い）', () => {
    const src = ['src/lib/db.ts', 'src/lib/gasClient.ts'].map(read).join('\n')
    assert.doesNotMatch(src, /from\('app_settings'\)\s*\.\s*(insert|update|upsert|delete)/)
  })

  it('0024: 出勤者専用の記録のトリガ（row_id＝職員ID・外すは delete・中身が同じなら残さない）', () => {
    const s = stripComments(mig('0024'))
    assert.match(s, /create or replace function public\.attendance_history_capture\(\)/)
    assert.match(s, /security definer\s+set search_path = public, pg_temp/)
    assert.match(s, /if o = n then\s+return null;/)
    assert.match(s, /case when old\.sort >= 0 and new\.sort < 0 then 'delete' else 'update' end/)
    assert.match(s, /create or replace trigger trg_history_attendance\s+after update on public\.attendance/)
  })

  it('0025: 表示名が変わった更新だけを記録し、氏名などは写さない', () => {
    const s = stripComments(mig('0025'))
    assert.match(s, /after update of note_alias on public\.residents\s+for each row\s+when \(old\.note_alias is distinct from new\.note_alias\)/)
    assert.match(s, /jsonb_build_object\('id', old\.id, 'note_alias', old\.note_alias\)/)
    assert.doesNotMatch(s, /to_jsonb\(old\)|to_jsonb\(new\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F44: 0019 のコメントの誤り（DB には触れず、文書で正す）
// ─────────────────────────────────────────────────────────────────────────────

describe('★F44 0019 の「definer なので影響なし」の誤りを文書で正す（0019 は書き換えない）', () => {
  it('db-design.md に、RPC は security invoker で member_only が中でも掛かること・非会員の症状を書く', () => {
    const d = read('docs/design/db-design.md')
    assert.match(d, /0019 のコメントの訂正/)
    assert.match(d, /timeline_chunk・apply_cell_edits・apply_note_edits・delete_vital・meals_sheet_fluids は security invoker/)
    assert.match(d, /record_history_capture/)
    assert.match(d, /0件|空の結果/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F70: 施設長は1日1人
// ─────────────────────────────────────────────────────────────────────────────

describe('★F70 施設長は1日1人（0026）と、出勤者の保存の順番・案内・見ていた役割', () => {
  it('0026: 表示中の施設長だけを日ごとに1行にする部分一意索引（自動で直す文は書かない）', () => {
    const s = stripComments(mig('0026'))
    assert.match(s, /create unique index if not exists uq_attendance_manager_day\s+on public\.attendance \(day\)\s+where role = 'manager' and sort >= 0;/)
    assert.doesNotMatch(s, /update public\.attendance|update attendance/)
    assert.match(mig('0026'), /アプリの配信が先、この移行が後/)
  })

  /** 0026 の索引と主キーを持つ出勤者の偽のサーバー */
  function attendanceServer() {
    const rows = []
    const conflictOf = (cand, self) => {
      if (cand.role === 'manager' && cand.sort >= 0) {
        const other = rows.find((r) => r !== self && r.day === cand.day && r.role === 'manager' && r.sort >= 0 && r.staff_id !== cand.staff_id)
        if (other) return { code: '23505', message: 'duplicate key value violates unique constraint "uq_attendance_manager_day"', details: `Key (day)=(${cand.day}) already exists.` }
      }
      return null
    }
    const match = (r, filters) => filters.every(([op, k, v]) => (op === 'eq' ? r[k] === v : op === 'in' ? v.includes(r[k]) : true))
    const fake = fakeSupabase((q) => {
      if (q.table === 'app_settings') return { data: null, error: null, status: 200 }
      if (q.table !== 'attendance') return { data: null, error: { code: 'X', message: `unexpected ${q.table}` }, status: 500 }
      if (q.action === 'select') return { data: rows.filter((r) => match(r, q.filters)).map((r) => ({ ...r })), error: null, status: 200 }
      if (q.action === 'insert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload]
        for (const p of list) {
          if (rows.some((r) => r.day === p.day && r.staff_id === p.staff_id)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "attendance_pkey"' }, status: 409 }
          const c = conflictOf(p, null)
          if (c) return { data: null, error: c, status: 409 }
        }
        for (const p of list) rows.push({ ...p })
        return { data: list.map((p) => ({ staff_id: p.staff_id })), error: null, status: 201 }
      }
      if (q.action === 'update') {
        const hits = rows.filter((r) => match(r, q.filters))
        for (const h of hits) {
          const c = conflictOf({ ...h, ...q.payload }, h)
          if (c) return { data: null, error: c, status: 409 }
        }
        for (const h of hits) Object.assign(h, q.payload)
        return { data: q.single ? (hits[0] ? { staff_id: hits[0].staff_id } : null) : hits.map((h) => ({ staff_id: h.staff_id })), error: null, status: 200 }
      }
      return { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
    })
    return { ...fake, rows }
  }
  const DAY = '2026-11-01'

  it('施設長の入れ替えは「前の施設長を外す→新しい施設長を入れる」の順に書く（索引の下でも通る）', async () => {
    need()
    const srv = attendanceServer()
    srv.rows.push({ day: DAY, staff_id: 1, role: 'manager', sort: 0 }, { day: DAY, staff_id: 2, role: 'staff', sort: 1 })
    DB.__testHooks.setClient(srv.client)
    const prev = [{ staff_id: 1, role: 'manager' }, { staff_id: 2, role: 'staff' }]
    // 日報の addAttendance（施設長の入れ替え）と同じ一覧: 前の施設長を除き、新しい施設長を後ろへ
    await DB.saveAttendance(DAY, [{ staff_id: 2, role: 'staff', sort: 0 }, { staff_id: 3, role: 'manager', sort: 1 }], {
      baseline: [1, 2],
      roles: Object.fromEntries(prev.map((a) => [a.staff_id, a.role])),
    })
    const byId = Object.fromEntries(srv.rows.map((r) => [r.staff_id, `${r.role}:${r.sort}`]))
    assert.deepEqual(byId, { 1: 'manager:-1', 2: 'staff:0', 3: 'manager:1' })
    const writes = srv.calls.filter((q) => q.action !== 'select').map((q) => `${q.action}:${q.action === 'insert' ? q.payload.map((p) => p.staff_id).join() : JSON.stringify(q.payload)}`)
    assert.equal(writes[0], 'update:{"sort":-1}', `前の施設長を先に外していない: ${writes.join(' / ')}`)
  })

  it('古い画面のまま別の施設長を選ぶと、施設長の案内で止まる（他の端末の施設長は残る・2人にならない）', async () => {
    need()
    const srv = attendanceServer()
    srv.rows.push({ day: DAY, staff_id: 1, role: 'manager', sort: 0 }, { day: DAY, staff_id: 2, role: 'staff', sort: 1 })
    DB.__testHooks.setClient(srv.client)
    // B の画面は [職員02] だけ（A が職員01 を施設長に選んだ後を見ていない）
    await assert.rejects(
      DB.saveAttendance(DAY, [{ staff_id: 2, role: 'staff', sort: 0 }, { staff_id: 4, role: 'manager', sort: 1 }], {
        baseline: [2],
        roles: { 2: 'staff' },
      }),
      (e) => e instanceof DB.DbError && /ほかの端末で別の職員が選ばれています/.test(e.message),
    )
    assert.equal(srv.rows.filter((r) => r.role === 'manager' && r.sort >= 0).length, 1)
    assert.equal(srv.rows.find((r) => r.staff_id === 1)?.role, 'manager')
  })

  it('送信待ちの再送で施設長が他の端末と食い違ったら、捨てずに止める（止まっている送信待ちに出る）', async () => {
    need()
    const srv = attendanceServer()
    srv.rows.push({ day: DAY, staff_id: 2, role: 'staff', sort: 0 })
    let down = true
    const off = fakeSupabase((q) => (down ? { data: null, error: { message: 'offline' }, status: 0 } : null))
    DB.__testHooks.setClient(off.client)
    const r = await DB.saveAttendance(DAY, [{ staff_id: 2, role: 'staff', sort: 0 }, { staff_id: 4, role: 'manager', sort: 1 }], {
      baseline: [2],
      roles: { 2: 'staff' },
    })
    assert.equal(r, 'queued')
    // その間に他の端末が職員01 を施設長に選んだ
    srv.rows.push({ day: DAY, staff_id: 1, role: 'manager', sort: 1 })
    down = false
    DB.__testHooks.setClient(srv.client)
    await DB.__testHooks.restartQueue()
    await DB.flushQueue(true)
    await settle()
    const stopped = DB.listStoppedOps().filter((o) => o.table === 'attendance')
    assert.equal(stopped.length, 1, '止まらずに捨てられた')
    assert.equal(stopped[0].state, 'conflict')
    assert.equal(srv.rows.filter((x) => x.role === 'manager' && x.sort >= 0).length, 1)
  })

  it('古い一覧の保存で、他の端末が選んだ施設長を職員へ戻さない（この端末が変えていない役割は書き戻さない）', async () => {
    need()
    const srv = attendanceServer()
    // A の画面: [職員01, 職員02]（どちらも職員）。その後 B が職員02 を施設長にした
    srv.rows.push({ day: DAY, staff_id: 1, role: 'staff', sort: 0 }, { day: DAY, staff_id: 2, role: 'manager', sort: 1 })
    DB.__testHooks.setClient(srv.client)
    await DB.saveAttendance(
      DAY,
      [{ staff_id: 1, role: 'staff', sort: 0 }, { staff_id: 2, role: 'staff', sort: 1 }, { staff_id: 3, role: 'staff', sort: 2 }],
      { baseline: [1, 2], roles: { 1: 'staff', 2: 'staff' } },
    )
    assert.equal(srv.rows.find((r) => r.staff_id === 2)?.role, 'manager', '他の端末の施設長が巻き戻った')
    assert.equal(srv.rows.find((r) => r.staff_id === 3)?.role, 'staff')
  })

  it('★手直し ①-c2: 画面に出ていなかった職員を出勤者に足しても、他の端末が選んだ施設長を職員へ下げない', async () => {
    need()
    const srv = attendanceServer()
    // A が職員01 を施設長に選んだ後。B の画面は [職員02] だけ（職員01 は見ていない）
    srv.rows.push({ day: DAY, staff_id: 1, role: 'manager', sort: 1 }, { day: DAY, staff_id: 2, role: 'staff', sort: 0 })
    DB.__testHooks.setClient(srv.client)
    // B が出勤者のピッカーから職員01 を足す（役割は職員）
    await DB.saveAttendance(DAY, [{ staff_id: 2, role: 'staff', sort: 0 }, { staff_id: 1, role: 'staff', sort: 1 }], {
      baseline: [2],
      roles: { 2: 'staff' },
    })
    assert.equal(srv.rows.find((r) => r.staff_id === 1)?.role, 'manager', '施設長が職員へ下がり、施設長の欄が空になった')
    assert.equal(srv.rows.filter((r) => r.role === 'manager' && r.sort >= 0).length, 1)
  })

  it('★手直し ①-c3: 圏外で積んだ「職員01 を足す」の再送でも、その間に選ばれた施設長を職員へ下げない', async () => {
    need()
    const srv = attendanceServer()
    srv.rows.push({ day: DAY, staff_id: 2, role: 'staff', sort: 0 })
    let down = true
    const off = fakeSupabase((q) => (down ? { data: null, error: { message: 'offline' }, status: 0 } : null))
    DB.__testHooks.setClient(off.client)
    const r = await DB.saveAttendance(DAY, [{ staff_id: 2, role: 'staff', sort: 0 }, { staff_id: 1, role: 'staff', sort: 1 }], {
      baseline: [2],
      roles: { 2: 'staff' },
    })
    assert.equal(r, 'queued')
    // その間に他の端末が職員01 を施設長に選んだ
    srv.rows.push({ day: DAY, staff_id: 1, role: 'manager', sort: 1 })
    down = false
    DB.__testHooks.setClient(srv.client)
    await DB.__testHooks.restartQueue()
    await DB.flushQueue(true)
    await settle()
    assert.equal(srv.rows.find((x) => x.staff_id === 1)?.role, 'manager', '再送で施設長が職員へ下がった')
    assert.equal(DB.listStoppedOps().filter((o) => o.table === 'attendance').length, 0)
  })

  it('手直しの範囲: 画面に出ていなかった職員を施設長として選ぶのは今までどおり書く（下げる時だけ残す）', async () => {
    need()
    const srv = attendanceServer()
    srv.rows.push({ day: DAY, staff_id: 1, role: 'staff', sort: 1 }, { day: DAY, staff_id: 2, role: 'staff', sort: 0 })
    DB.__testHooks.setClient(srv.client)
    await DB.saveAttendance(DAY, [{ staff_id: 2, role: 'staff', sort: 0 }, { staff_id: 1, role: 'manager', sort: 1 }], {
      baseline: [2],
      roles: { 2: 'staff' },
    })
    assert.equal(srv.rows.find((r) => r.staff_id === 1)?.role, 'manager')
  })

  it('見ていた役割を持たない旧い送信待ち（旧版の形）は、従来どおり役割を書く', async () => {
    need()
    const srv = attendanceServer()
    srv.rows.push({ day: DAY, staff_id: 1, role: 'manager', sort: 0 })
    DB.__testHooks.setClient(srv.client)
    await DB.saveAttendance(DAY, [{ staff_id: 1, role: 'staff', sort: 0 }], { baseline: [1] })
    assert.equal(srv.rows[0].role, 'staff')
  })

  it('日報は見ていた役割を渡し、施設長の案内（managerTaken）は db.ts が出す', () => {
    const daily = read('src/pages/DailySheetPage.tsx')
    assert.match(daily, /roles: Object\.fromEntries\(prev\.map\(\(a\) => \[a\.staff_id, a\.role\]\)\)/)
    const db = read('src/lib/db.ts')
    assert.match(db, /text\.includes\('uq_attendance_manager_day'\)/)
    assert.match(db, /if \(e instanceof DbError && e\.message === SHEET_MSG\.managerTaken\) return 'conflict'/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F09・F08: 申し送りの取り消しは見た行と照らす・継続の終了の組（0027）
// ─────────────────────────────────────────────────────────────────────────────

describe('★F09 申し送りの取り消しは「見た行」と照らす（0027・端末は seen を送る）', () => {
  function noteServer() {
    const db = NC.createNoteDb()
    const fake = fakeSupabase((q) => {
      if (q.action === 'rpc' && q.fn === 'apply_note_edits') {
        try {
          return { data: NC.fakeApplyNoteEdits(db, q.args), error: null, status: 200 }
        } catch (e) {
          if (!(e instanceof NC.PgError)) throw e
          return { data: null, error: { code: e.code, message: e.message }, status: 400 }
        }
      }
      return { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
    })
    return { ...fake, db }
  }
  const ROW = { ...NC.NOTE_BASE_ROW, id: 101, rev: 1, edited_by: null, deleted_at: null }

  it('他の端末が重要度を上げた後の古い表示からの削除は止まり、食い違った欄（重要度）が返る', async () => {
    need()
    const srv = noteServer()
    srv.db.notes.push({ ...ROW, importance: 'critical' })
    DB.__testHooks.setClient(srv.client)
    const seen = { ...ROW } // 画面は重要度 normal のまま
    const res = await DB.deleteNote({ id: 101 }, seen)
    assert.notEqual(res, 'queued')
    assert.equal(DB.noteDeleted(res), false)
    assert.equal(srv.db.notes[0].deleted_at, null, '他の端末が直した申し送りが消えた')
    const c = res.conflicts.find((x) => x.field === 'deleted_at')
    assert.deepEqual(c?.fields, ['importance'])
    const sent = srv.calls.find((q) => q.fn === 'apply_note_edits')?.args.p_edits.deleted_at
    assert.equal(sent.base, '本文O')
    assert.deepEqual(Object.keys(sent.seen).sort(), ['body', 'color', 'ended_at', 'importance', 'ongoing', 'resident_id'])
    // 止まった削除は送信待ちに残り、〔くらべて選ぶ〕が食い違った欄を出せる
    const pending = DB.pendingNoteRows().get(101)
    assert.deepEqual(pending?.conflicts.find((x) => x.field === 'deleted_at')?.fields, ['importance'])
  })

  it('見た行のままなら取り消す・本文だけを渡す従来の呼び方は本文だけで判定する', async () => {
    need()
    const srv = noteServer()
    srv.db.notes.push({ ...ROW }, { ...ROW, id: 102, importance: 'critical' })
    DB.__testHooks.setClient(srv.client)
    const a = await DB.deleteNote({ id: 101 }, { ...ROW })
    assert.equal(DB.noteDeleted(a), true)
    const b = await DB.deleteNote({ id: 102 }, '本文O')
    assert.equal(DB.noteDeleted(b), true)
    assert.equal(srv.calls.filter((q) => q.fn === 'apply_note_edits')[1].args.p_edits.deleted_at.seen, undefined)
  })

  it('圏外で積んだ取り消しは、見た行を端末に残して（読み直しても）送る', async () => {
    need()
    const off = fakeSupabase(() => ({ data: null, error: { message: 'offline' }, status: 0 }))
    DB.__testHooks.setClient(off.client)
    const r = await DB.deleteNote({ id: 101 }, { ...ROW })
    assert.equal(r, 'queued')
    const srv = noteServer()
    srv.db.notes.push({ ...ROW, resident_id: 2 }) // その間に他の端末が対象を付け替えた
    DB.__testHooks.setClient(srv.client)
    await DB.__testHooks.restartQueue()
    await DB.flushQueue(true)
    await settle()
    assert.equal(srv.db.notes[0].deleted_at, null, '付け替えられた申し送りが消えた')
    const sent = srv.calls.find((q) => q.fn === 'apply_note_edits')?.args.p_edits.deleted_at
    assert.equal(sent.seen.resident_id, 1)
  })

  it('画面の4か所は行（見た行）を渡す', () => {
    assert.match(read('src/pages/DailySheetPage.tsx'), /await deleteNote\(\{ id: note\.id \}, raw, \{ meta: noteMetaOf\(raw\) \}\)/)
    const tl = read('src/pages/TimelinePage.tsx')
    assert.match(tl, /await deleteNote\(\{ id: note\.id \}, seen, \{ meta: noteMetaOf\(note\) \}\)/)
    assert.match(tl, /const deleteBaseRef = useRef<Note>\(note\)/)
    assert.match(tl, /deleteBaseRef\.current = note\n/)
    assert.match(read('src/pages/NoteFormPage.tsx'), /await deleteNote\(\{ id: note\.id \}, note, \{/)
    assert.match(read('src/components/ConflictResolver.tsx'), /await deleteNote\(noteTargetOf\(target\), latest\.row, \{ rebase: true \}\)/)
  })

  it('0027 は 0017 を同じ形で作り直す（drop しない・seen は任意・ended_by を row に足す・組の規則）', () => {
    const s = stripComments(mig('0027'))
    assert.doesNotMatch(s, /drop function/)
    assert.match(s, /create or replace function public\.apply_note_edits\(/)
    assert.match(s, /if e \? 'seen' then/)
    assert.match(s, /'ended_by', v_row\.ended_by/)
    assert.match(s, /if v_edits \? 'ended_at' and v_edits \? 'ended_by' then/)
    assert.match(s, /security invoker/)
    assert.match(s, /set search_path = public, pg_temp/)
  })

  it('★F08 タイムラインの RPC の申し送りに ended_by（0030）', () => {
    const s = stripComments(mig('0030'))
    assert.equal((s.match(/n\.ongoing, n\.ended_at, n\.ended_by, n\.color, n\.reporter_id, n\.rev,/g) ?? []).length, 2)
    assert.doesNotMatch(s, /drop function/)
  })

  it('★F09 手直し: 削除の「見た行」に送る欄（NOTE_SEEN_SENT）は、タイムラインの RPC（0030）の notes・pinned が全部返す', () => {
    // 返さない欄は端末の正規化で null になり、0027 が「いまの値と違う」と見て、誰も触っていない色付きの申し送りの削除を
    // 毎回止めた（直す前は color が無かった）
    const db = readFileSync(new URL('../src/lib/db.ts', import.meta.url), 'utf8')
    const m = db.match(/const NOTE_SEEN_SENT: readonly string\[\] = \[([^\]]*)\]/)
    assert.ok(m, 'NOTE_SEEN_SENT が見つからない')
    const fields = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
    assert.ok(fields.includes('color'))
    const s = stripComments(mig('0030'))
    const lists = [...s.matchAll(/select n\.id,([\s\S]*?)from notes n/g)].map((x) => x[1])
    assert.equal(lists.length, 2, 'notes・pinned の列の並びが見つからない')
    for (const cols of lists) {
      for (const f of fields) assert.match(cols, new RegExp(`\\bn\\.${f}\\b`), `0030 の notes・pinned が ${f} を返さない`)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F29: 事故の detail は変えたキーだけ・服薬の時間帯は変えた列だけ
// ─────────────────────────────────────────────────────────────────────────────

describe('★F29 事故の detail はサーバーで重ね（0028）、端末は変えたキーだけを送る', () => {
  it('0028: 前の値に送られたキーを重ねる BEFORE トリガ（氏名の写しより先に動く名前）と、確かめの関数', () => {
    const s = stripComments(mig('0028'))
    assert.match(s, /new\.detail := base \|\| new\.detail;/)
    assert.match(s, /if old\.resident_id is distinct from new\.resident_id then\s+base := base - 'subject_name';/)
    assert.match(s, /create or replace trigger trg_incidents_detail_merge\s+before update on public\.incidents/)
    assert.ok('trg_incidents_detail_merge' < 'trg_incidents_subject_snapshot', '名前の順で氏名の写しより後に動く')
    assert.match(s, /create or replace function public\.incidents_detail_merge_ready\(\) returns boolean/)
    assert.match(s, /revoke execute on function public\.incidents_detail_merge_ready\(\) from anon;/)
  })

  const INCIDENT = {
    id: 7,
    rev: 2,
    kind: 'nearmiss',
    resident_id: 1,
    occurred_on: '2026-10-01',
    occurred_at: '2026-10-01T05:00:00.000Z',
    office: 'facility',
    place: 'hallway',
    place_other: null,
    types: ['fall'],
    severity: null,
    status: 'open',
    report_stage: null,
    report_no: null,
    submitted_on: null,
    city_report_needed: false,
    city_reported_on: null,
    reporter_id: 1,
    confirmer_id: null,
    confirmed_at: null,
    closed_at: null,
  }
  async function sentDetail(mergeReady) {
    const fake = fakeSupabase((q) => {
      if (q.action === 'rpc' && q.fn === 'incidents_detail_merge_ready') {
        return mergeReady ? { data: true, error: null, status: 200 } : { data: null, error: { code: 'PGRST202', message: 'not found' }, status: 404 }
      }
      return { data: null, error: null, status: 200 } // 0行＝競合（送った中身だけを見る）
    })
    DB.__testHooks.setClient(fake.client)
    const current = await (async () => {
      const raw = { ...INCIDENT, detail: { situation: '状況A', response: '対応A', subject_name: '利用者01' } }
      return { ...raw, detail: { ...raw.detail } }
    })()
    // 画面の detail は正規化した形（知らないキーは無い）。ここでは response だけを追記する
    const full = await import('../src/lib/incident.ts?server-mdfix')
    current.detail = full.normalizeIncidentDetail(current.detail)
    await DB.updateIncident(current, { detail: { response: '対応A＋追記' } })
    return fake.calls.find((q) => q.action === 'update' && q.table === 'incidents')?.payload.detail
  }

  it('サーバーが重ねる（0028 あり）時は、変えたキーだけを送る（新しい版が足した欄を古い版が消さない）', async () => {
    need()
    const d = await sentDetail(true)
    assert.deepEqual(d, { response: '対応A＋追記' })
  })

  it('0028 が無い・確かめられない DB には、従来どおり丸ごと送る（他の欄を消さない）', async () => {
    need()
    const d = await sentDetail(false)
    assert.equal(d.response, '対応A＋追記')
    assert.equal(d.situation, '状況A')
    assert.ok(Object.keys(d).length > 10)
    assert.equal(d.subject_name, undefined, '氏名を送っている')
  })

  it('服薬の時間帯: 備考だけを直した時は slots を送らない（新しい版が足した時間帯を消さない）', async () => {
    need()
    const fake = fakeSupabase(() => ({ data: null, error: null, status: 200 }))
    DB.__testHooks.setClient(fake.client)
    const cur = { id: 3, resident_id: 1, slots: ['morning', 'bedtime'], note: null, rev: 1 }
    await DB.setMedSlots(1, ['morning', 'bedtime'], '備考（合成）', cur)
    const p1 = fake.calls.find((q) => q.action === 'update')?.payload
    assert.equal(Object.prototype.hasOwnProperty.call(p1, 'slots'), false)
    assert.equal(p1.note, '備考（合成）')
    await DB.setMedSlots(1, ['morning', 'noon', 'bedtime'], null, cur)
    const p2 = fake.calls.filter((q) => q.action === 'update')[1]?.payload
    assert.deepEqual(p2.slots, ['morning', 'noon', 'bedtime'])
    assert.equal(Object.prototype.hasOwnProperty.call(p2, 'note'), false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F25: Presence の private チャンネル
// ─────────────────────────────────────────────────────────────────────────────

describe('★F25 Presence は private チャンネル（0029）・使えない時も保存と画面を止めない', () => {
  it('0029: realtime.messages に受け取る（select）と配る（insert）の2本。presence・cl_note_presence・許可リストの職員だけ', () => {
    const s = stripComments(mig('0029'))
    for (const [name, cmd, clause] of [
      ['cl_presence_read', 'select', 'using'],
      ['cl_presence_write', 'insert', 'with check'],
    ]) {
      const re = new RegExp(
        `create policy "${name}" on realtime\\.messages\\s+for ${cmd} to authenticated\\s+${clause} \\(\\s+realtime\\.messages\\.extension = 'presence'\\s+and \\(select realtime\\.topic\\(\\)\\) = 'cl_note_presence'\\s+and \\(select private\\.is_member\\(\\)\\)`,
      )
      assert.match(s, re, name)
    }
    assert.doesNotMatch(s, /to anon/)
  })

  it('端末は private: true で参加し、断られても例外にせず（console に1回だけ残し）、居場所の更新・停止も止まらない', async () => {
    need()
    const made = []
    const fake = fakeSupabase(() => ({ data: null, error: null, status: 200 }), {
      getChannels: () => [],
      channel(topic, opts) {
        const ch = {
          topic: `realtime:${topic}`,
          opts,
          on() {
            return ch
          },
          subscribe(cb) {
            setTimeout(() => cb('CHANNEL_ERROR'), 0)
            return ch
          },
          track: () => Promise.resolve('ok'),
          untrack: () => Promise.resolve('ok'),
          presenceState: () => ({}),
        }
        made.push(ch)
        return ch
      },
    })
    DB.__testHooks.setClient(fake.client)
    const warns = []
    const orig = console.warn
    console.warn = (m) => warns.push(String(m))
    try {
      const p1 = DB.joinPresence({ staffId: 1, day: '2026-11-01', residentId: 1, cell: null }, () => {})
      const p2 = DB.joinPresence(null, () => {})
      await settle(30)
      p1.update(null)
      p1.stop()
      p2.stop()
    } finally {
      console.warn = orig
    }
    assert.ok(made.length >= 1)
    for (const ch of made) {
      assert.equal(ch.opts?.config?.private, true, 'private で参加していない')
      assert.equal(ch.topic, 'realtime:cl_note_presence')
    }
    assert.ok(warns.length <= 1, `何度も残した: ${warns.length}`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F28: 古い版の入力止め（min_client_build）
// ─────────────────────────────────────────────────────────────────────────────

describe('★F28 古い版の入力止め（app_settings の min_client_build・0023）', () => {
  it('0023: 行を1つ足すだけ（値は空＝制限なし・既にあれば触らない）', () => {
    const s = stripComments(mig('0023'))
    assert.match(s, /insert into public\.app_settings \(key, value\)\s+values \('min_client_build', ''\)\s+on conflict \(key\) do nothing;/)
  })

  it('clientBuildAllowed: 通し番号で比べる。空・数字でない・開発中の版・通し番号の無い版は止めない', () => {
    need()
    const b = (seq) => ({ id: 'abc1234', seq, at: null })
    assert.equal(V.clientBuildAllowed('120', b(119)), false)
    assert.equal(V.clientBuildAllowed('120', b(120)), true)
    assert.equal(V.clientBuildAllowed(' 120 ', b(121)), true)
    assert.equal(V.clientBuildAllowed('', b(1)), true)
    assert.equal(V.clientBuildAllowed(null, b(1)), true)
    assert.equal(V.clientBuildAllowed('abc', b(1)), true)
    assert.equal(V.clientBuildAllowed('0', b(1)), true)
    assert.equal(V.clientBuildAllowed('120', { id: 'dev', seq: null, at: null }), true)
    assert.equal(V.clientBuildAllowed('120', b(null)), true)
  })

  function settingsServer(min) {
    return fakeSupabase((q) => {
      if (q.table === 'app_settings') {
        const key = q.filters.find(([op, k]) => op === 'eq' && k === 'key')?.[2]
        const value = key === 'min_client_build' ? min : key === 'native_input_enabled' ? 'true' : null
        return { data: value === null ? null : { value }, error: null, status: 200 }
      }
      if (q.action === 'rpc') return { data: { version: 1, status: 'probe' }, error: null, status: 200 }
      return { data: null, error: { message: 'offline' }, status: 0 }
    })
  }

  it('この版が min_client_build より古ければ、入力解禁の確認は outdated で止め、書込も止め、送信待ちを送らない', async () => {
    need()
    const srv = settingsServer('120')
    DB.__testHooks.setClient(srv.client, { buildChecked: false })
    DB.__testHooks.setClientBuild({ id: 'abc1234', seq: 119, at: null })
    const g = await DB.getNativeInputGate()
    assert.equal(g.value, false)
    assert.equal(g.outdated, true)
    assert.equal(DB.isClientBuildOutdated(), true)
    const k = await DB.getKindInputGate('med')
    assert.equal(k.outdated, true)
    await assert.rejects(
      DB.saveAttendance('2026-11-01', [{ staff_id: 1, role: 'staff', sort: 0 }], { baseline: [] }),
      (e) => e instanceof DB.DbError && e.message === DB.OUTDATED_REASON,
    )
    // 送信待ちを送らない（古い版の書き方でサーバーへ書かない）
    const before = srv.calls.length
    await DB.flushQueue(true)
    assert.equal(srv.calls.length, before)
  })

  it('同じ・新しい版、開発中の版、未設定（空）なら止めない', async () => {
    need()
    for (const [min, build] of [
      ['120', { id: 'abc1234', seq: 120, at: null }],
      ['120', { id: 'dev', seq: null, at: null }],
      ['', { id: 'abc1234', seq: 1, at: null }],
    ]) {
      DB.__testHooks.setClient(settingsServer(min).client, { buildChecked: false })
      DB.__testHooks.setClientBuild(build)
      const g = await DB.getNativeInputGate()
      assert.equal(g.outdated, undefined, `${min} / ${build.id}`)
      assert.equal(g.value, true)
      assert.equal(DB.isClientBuildOutdated(), false)
    }
  })

  it('min_client_build を読めない時は止めない（観測できていないことを断定しない）', async () => {
    need()
    const fake = fakeSupabase((q) => {
      if (q.table === 'app_settings') {
        const key = q.filters.find(([op, k]) => op === 'eq' && k === 'key')?.[2]
        if (key === 'min_client_build') return { data: null, error: { message: 'offline' }, status: 0 }
        return { data: { value: 'true' }, error: null, status: 200 }
      }
      return { data: { version: 1, status: 'probe' }, error: null, status: 200 }
    })
    DB.__testHooks.setClient(fake.client, { buildChecked: false })
    DB.__testHooks.setClientBuild({ id: 'abc1234', seq: 1, at: null })
    const g = await DB.getNativeInputGate()
    assert.equal(g.outdated, undefined)
    assert.equal(g.value, true)
  })

  it('App: 古い版と分かったら受け皿（〔更新〕）を出し、入力中の内容がある間は画面を残して帯で知らせる（印刷に出さない）', () => {
    const app = read('src/App.tsx')
    assert.match(app, /db\.onClientBuildOutdated\(/)
    assert.match(app, /void db\.checkClientBuild\(\)/)
    assert.match(app, /const outdatedTyping = outdated && hasUnsavedInput\(\)/)
    assert.match(app, /\{outdated && !outdatedTyping \? \(\s*<OutdatedPanel/)
    const panel = app.slice(app.indexOf('function OutdatedPanel('), app.indexOf('function OutdatedPanel(') + 1600)
    assert.match(panel, /print:hidden/)
    assert.match(panel, /新しい版に更新してください/)
    assert.match(panel, /window\.location\.reload\(\)/)
    // 版を確かめる処理の中では再読み込みしない（自動の再読み込みはしない＝本人回答）
    const eff = app.slice(app.indexOf('const off = db.onClientBuildOutdated('), app.indexOf('const off = db.onClientBuildOutdated(') + 700)
    assert.doesNotMatch(eff, /location\.reload/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F71: 表示名の保存の直前に読み直して確かめ直す（移行は要らない）
// ─────────────────────────────────────────────────────────────────────────────

describe('★F71 設定タブの表示名は、保存の直前に全員を読み直して重複と他の端末の変更を確かめる（移行なし）', () => {
  it('fetchAllResidents で読み直し、validateNoteAlias をもう一度通し、見ていた値と違えば保存しない', () => {
    const s = read('src/pages/SettingsPage.tsx')
    const i = s.indexOf('const saveAlias = useCallback(')
    const body = s.slice(i, s.indexOf('const days = useMemo(', i))
    const fresh = body.indexOf('const fresh = await fetchAllResidents().catch(() => null)')
    const save = body.indexOf('await setResidentNoteAlias(')
    assert.ok(fresh > 0 && fresh < save, '保存の前に読み直していない')
    assert.match(body, /const again = validateNoteAlias\(raw, r\.id, fresh\)/)
    assert.match(body, /if \(!again\.ok \|\| changedElsewhere\) \{/)
    // 自分が送信待ちにした値が届いた後は「他の端末の変更」としない
    assert.match(body, /norm\(now\.note_alias\) !== norm\(shownNow\)/)
  })
})
