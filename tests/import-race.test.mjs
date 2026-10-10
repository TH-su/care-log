// 取込（tools/import.mjs）と端末の競合の回帰テスト（F74・F75。2026-10-10 実測で判明）。
//   F74: 端末の RPC が行ロックを持つ間に取込の UPDATE・取り消しが始まると、ロック待ちの後の再判定で
//        record_history の exists が古いスナップショットのまま評価され、操作者未選択（p_editor=null）の
//        職員の訂正が移行元の値へ戻される／取り消される。→ 読んだ時の rev を条件にし、0行で終わった分は
//        「更新」「追従」に数えず保護の側に数える。
//   F75: 取込が取り消した行の枠を端末が使った後に移行元へ同じキーが戻ると、復活の UPDATE が
//        uq_vitals_routine_day / uq_meals_slot に当たって 23505 → 窓ごと毎時 rollback し続ける。
//        → 復活の前に枠が使われていないかを見て、使われていれば native_skip。
// DB は使わない。偽の db（query だけを持つ物）を __testHooks の applyCandidates・reconcileTombstones に渡し、
// 送られた SQL の条件と数え方を確かめる（実 DB での競走の再現は scratchpad の s1_race.mjs・s4_revive*.mjs）。
// 修正前の版で試す時は CL_IMPORT_SRC に import.mjs の場所を渡す（__testHooks の export を足した写し）。
// 実行: node --experimental-strip-types --test tests/import-race.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const SRC = process.env.CL_IMPORT_SRC
  ? pathToFileURL(process.env.CL_IMPORT_SRC).href
  : new URL('../tools/import.mjs', import.meta.url).href
const { __testHooks: H } = await import(SRC)

const DAY = '2026-06-01'
const KEY = `vt:${DAY}|利用者01`
const VIT_COMPARE = ['resident_id', 'measured_on', 'kind', 'temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2', 'raw_flags']
const VIT_INSERT = ['import_key', ...VIT_COMPARE]

/** 移行元から来た候補（体温だけ 36.5 → 36.8 に訂正された） */
function candidateRow(over = {}) {
  return { import_key: KEY, resident_id: 1, measured_on: DAY, kind: 'routine', temp: 36.8, sys_bp: 120, dia_bp: 70, pulse: 72, spo2: 97, raw_flags: null, ...over }
}
/** DB にある取込行（node-postgres と同じく id・numeric は文字列） */
function existingRow(over = {}) {
  return {
    import_key: KEY, id: '11', rev: 3, deleted_at: null, import_tombstoned_at: null,
    resident_id: '1', measured_on: DAY, kind: 'routine', temp: '36.5', sys_bp: 120, dia_bp: 70, pulse: 72, spo2: 97, raw_flags: null,
    ...over,
  }
}

/**
 * 偽の db。import.mjs が投げる SQL の形ごとに答える。update の rowCount は呼び手が決める
 * （0 = 読んだ後に端末が行を直した・消した、の再現）。送られた SQL は log に残す。
 */
function fakeDb({ existing = [], touched = [], reconcileRows = [], updateRowCount = 1 } = {}) {
  const log = []
  return {
    log,
    updates: () => log.filter((q) => /^update /.test(q.sql)),
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim()
      log.push({ sql, params })
      // edited_by 列あり（0010 適用済み）
      if (sql.includes('information_schema.columns')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
      // record_history をこの接続で読める（exists 条件が入る形）
      if (sql.includes('from pg_class c')) {
        return { rows: [{ rls: true, force_rls: false, owner: true, bypass: true, can_select: true }], rowCount: 1 }
      }
      if (/^select import_key, id,/.test(sql)) {
        const want = new Set(params[0])
        return { rows: existing.filter((r) => want.has(r.import_key)), rowCount: 0 }
      }
      if (/^select t\.id from /.test(sql)) {
        const want = new Set(params[0].map(String))
        return { rows: touched.filter((id) => want.has(String(id))).map((id) => ({ id })), rowCount: 0 }
      }
      // 追従の SELECT（修正前の版は rev を読まない形・修正後は読む形のどちらにも答える）
      if (/^select id, (rev, )?import_key from /.test(sql)) return { rows: reconcileRows, rowCount: reconcileRows.length }
      if (/^update /.test(sql)) return { rows: [], rowCount: updateRowCount }
      if (/^insert /.test(sql)) return { rows: [], rowCount: 1 }
      throw new Error(`偽の db が知らない SQL: ${sql.slice(0, 120)}`)
    },
  }
}

async function apply({ existing, nativeTaken = [], touched = [], updateRowCount = 1, execute = true, row = candidateRow() }) {
  const db = fakeDb({ existing, touched, updateRowCount })
  const counts = await H.applyCandidates(db, {
    table: 'vitals',
    candidates: [{ row }],
    compareCols: VIT_COMPARE,
    insertCols: VIT_INSERT,
    execute,
    nativeCheck: async () => new Set(nativeTaken),
    frameOf: (r) => `${r.resident_id}|${r.measured_on}`,
  })
  return { counts, db }
}

/** 恒等式（1候補）: inserted + updated + skipped + native_skip = 候補数 */
function identityHolds(c, n) {
  return c.inserted + c.updated + c.unchanged + c.tomb_skip + c.dup_skip + c.native_skip === n
}

/** UPDATE 文の「id = $i and rev = $j」の位置から、渡した id と rev を取り出す */
function idRevOf(q) {
  const m = q.sql.match(/where id = \$(\d+) and rev = \$(\d+)/)
  if (!m) return null
  return { id: q.params[Number(m[1]) - 1], rev: q.params[Number(m[2]) - 1] }
}

describe('F74 取込の更新は読んだ時の rev のままの行だけに書く（端末の RPC と競っても職員の訂正を戻さない）', () => {
  it('既存行と一緒に rev を読み、UPDATE の条件に読んだ時の rev を入れる', async () => {
    const { db } = await apply({ existing: [existingRow()] })
    const sel = db.log.find((q) => /^select import_key, id,/.test(q.sql))
    assert.match(sel.sql, /^select import_key, id, rev,/, '既存行の SELECT が rev を読んでいない')
    const ups = db.updates()
    assert.equal(ups.length, 1)
    assert.deepEqual(idRevOf(ups[0]), { id: '11', rev: 3 }, `UPDATE が rev を照合していない: ${ups[0].sql}`)
  })

  it('UPDATE が0行で終わった（読んだ後に職員が直した）時は「更新」に数えず、アプリ入力保護（app_protected）に数える', async () => {
    const { counts } = await apply({ existing: [existingRow()], updateRowCount: 0 })
    assert.equal(counts.updated, 0, '戻していないのに「更新」に数えている')
    assert.equal(counts.native_skip, 1)
    assert.equal(counts.app_protected, 1)
    assert.ok(identityHolds(counts, 1), `恒等式が崩れた: ${JSON.stringify(counts)}`)
  })

  it('対照: UPDATE が1行書けた時は従来どおり「更新 1」', async () => {
    const { counts, db } = await apply({ existing: [existingRow()], updateRowCount: 1 })
    assert.equal(counts.updated, 1)
    assert.equal(counts.native_skip, 0)
    assert.equal(counts.app_protected, 0)
    assert.match(db.updates()[0].sql, /^update vitals set temp = \$1, edited_by = null where id = /)
    assert.equal(db.updates()[0].params[0], 36.8)
  })

  it('復活（取込が付けた墓標の行）の UPDATE も rev を照合し、0行なら「更新」「復活」から外して app_protected に数える', async () => {
    const ex = existingRow({ deleted_at: '2026-06-02T00:00:00Z', import_tombstoned_at: '2026-06-02T00:00:00Z' })
    const { counts, db } = await apply({ existing: [ex], updateRowCount: 0 })
    const ups = db.updates()
    assert.equal(ups.length, 1)
    assert.deepEqual(idRevOf(ups[0]), { id: '11', rev: 3 }, `復活の UPDATE が rev を照合していない: ${ups[0].sql}`)
    assert.equal(counts.updated, 0)
    assert.equal(counts.revived, 0)
    assert.equal(counts.native_skip, 1)
    assert.equal(counts.app_protected, 1)
    assert.ok(identityHolds(counts, 1), `恒等式が崩れた: ${JSON.stringify(counts)}`)
  })

  it('対照: ドライランは書かず、予定の件数（更新 1）を出す', async () => {
    const { counts, db } = await apply({ existing: [existingRow()], execute: false, updateRowCount: 0 })
    assert.equal(db.updates().length, 0)
    assert.equal(counts.updated, 1)
    assert.equal(counts.app_protected, 0)
  })
})

describe('F74 取込の取り消し（移行元から消えた行への追従）も id と rev を組で照合する', () => {
  const gone = [{ id: '21', rev: 5, import_key: KEY }]
  const run = (updateRowCount, execute = true) => {
    const db = fakeDb({ reconcileRows: gone, updateRowCount })
    return H.reconcileTombstones(db, 'vitals', 'measured_on', 'vt:', DAY, new Set(), execute, "and kind = 'routine'").then((rt) => ({ rt, db }))
  }

  it('追従の SELECT が rev を読み、取り消しの UPDATE は unnest(id[], rev[]) で読んだ時の rev と照合する', async () => {
    const { db } = await run(1)
    const sel = db.log.find((q) => /^select id, /.test(q.sql))
    assert.match(sel.sql, /^select id, rev, import_key from vitals /, '追従の SELECT が rev を読んでいない')
    const ups = db.updates()
    assert.equal(ups.length, 1)
    assert.match(ups[0].sql, /from unnest\(\$1::bigint\[\], \$2::int\[\]\) as x\(id, rev\)/, `取り消しが rev を照合していない: ${ups[0].sql}`)
    assert.match(ups[0].sql, /vitals\.id = x\.id and vitals\.rev = x\.rev and vitals\.deleted_at is null and not /)
    assert.deepEqual(ups[0].params, [['21'], [5]])
  })

  it('取り消しが0行で終わった（読んだ後に職員が直した）時は「追従で取り消した」に数えず、残した側（kept）に数える', async () => {
    const { rt } = await run(0)
    assert.deepEqual(rt, { tombstoned: 0, kept: 1 })
  })

  it('対照: 取り消せた時は従来どおり tombstoned 1・ドライランは予定の件数を出す', async () => {
    assert.deepEqual((await run(1)).rt, { tombstoned: 1, kept: 0 })
    const dry = await run(0, false)
    assert.deepEqual(dry.rt, { tombstoned: 1, kept: 0 })
    assert.equal(dry.db.updates().length, 0)
  })
})

describe('F75 取込が消した行の枠を端末が使った後に移行元へ同じキーが戻っても、復活させず窓を落とさない', () => {
  const tomb = () => existingRow({ deleted_at: '2026-06-02T00:00:00Z', import_tombstoned_at: '2026-06-02T00:00:00Z' })

  it('同じ枠をアプリ入力が使っていれば復活の UPDATE を送らず native_skip に数える（23505 で窓ごと rollback しない）', async () => {
    const { counts, db } = await apply({ existing: [tomb()], nativeTaken: [KEY] })
    assert.equal(db.updates().length, 0, `枠が使われているのに復活の UPDATE を送った: ${db.updates()[0]?.sql}`)
    assert.equal(counts.native_skip, 1)
    assert.equal(counts.updated, 0)
    assert.equal(counts.revived, 0)
    assert.ok(identityHolds(counts, 1), `恒等式が崩れた: ${JSON.stringify(counts)}`)
  })

  it('対照: 枠が空いていれば従来どおり復活させる（deleted_at・import_tombstoned_at を空に戻す）', async () => {
    const { counts, db } = await apply({ existing: [tomb()], nativeTaken: [] })
    const ups = db.updates()
    assert.equal(ups.length, 1)
    assert.match(ups[0].sql, /deleted_at = null, import_tombstoned_at = null/)
    assert.match(ups[0].sql, /and import_tombstoned_at is not null and not /)
    assert.equal(counts.updated, 1)
    assert.equal(counts.revived, 1)
    assert.equal(counts.native_skip, 0)
  })

  it('対照: 職員がアプリで消した行（取込の墓標でない）は従来どおり復活させない（tomb_skip）', async () => {
    const { counts, db } = await apply({ existing: [existingRow({ deleted_at: '2026-06-02T00:00:00Z' })], nativeTaken: [] })
    assert.equal(db.updates().length, 0)
    assert.equal(counts.tomb_skip, 1)
  })
})
