// tests/migrations-contract.mjs の表（移行 0021〜0030 の契約）を、素の Postgres で流す実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/migrations-pg.mjs
//
// 前提（vital-delete-pg.mjs と同じ）: Supabase の役割と auth 関数の真似（care-backend の supabase/tests/00_supabase_stub.sql）、
//   private.is_member()（試験では current_setting('test.member') を返す差し替え）、0012・0015・0016 が参照する kv_entries・
//   cron の真似、Realtime 認可の真似（tests/pg-realtime-stub.sql。本物の Supabase には最初からある）を当ててから、
//   supabase/migrations の 0001〜（最新）を順に当てた DB。
// 1件ずつトランザクションを張り、最後に必ず rollback する（表に何も残さない）。
// 個人情報は置かない（利用者・職員は合成の名前と数値IDのみ）。

import pg from 'pg'
import { MIGRATION_PG_CASES, SEED_SQL, checkMigrationCase } from './migrations-contract.mjs'

const url = process.env.CARELOG_PG_URL
if (!url || !/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('CARELOG_PG_URL に使い捨てのローカル DB（127.0.0.1）を指定してください。')
  process.exit(2)
}

const client = new pg.Client({ connectionString: url })
await client.connect()
const only = process.env.CARELOG_ONLY ? new Set(process.env.CARELOG_ONLY.split(',')) : null

const h = {
  async pg(text, params) {
    return (await client.query(text, params)).rows
  },
  /** 役割と member の有無を切り替えて fn を流す。例外は SQLSTATE で返す（savepoint まで巻き戻す） */
  async as(opts, fn) {
    const role = opts.role ?? 'authenticated'
    if (!['authenticated', 'anon'].includes(role)) throw new Error(`役割が違う: ${role}`)
    await client.query('savepoint as_user')
    await client.query(`set local role ${role}`)
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: '00000000-0000-0000-0000-000000000001', role }),
    ])
    await client.query(`select set_config('test.member', $1, true)`, [opts.member === false ? 'false' : 'true'])
    const q = async (text, params) => (await client.query(text, params)).rows
    try {
      const r = await fn(q)
      await client.query('reset role')
      await client.query('release savepoint as_user')
      return r
    } catch (e) {
      await client.query('rollback to savepoint as_user')
      await client.query('reset role')
      if (typeof e?.code !== 'string') throw e
      return { error: e.code, constraint: e.constraint ?? null }
    }
  },
}

let failed = 0
let ran = 0
for (const c of MIGRATION_PG_CASES) {
  if (only !== null && !only.has(c.finding)) continue
  ran += 1
  await client.query('begin')
  let observed
  try {
    for (const s of SEED_SQL) await client.query(s)
    observed = await c.run(h)
  } catch (e) {
    observed = { thrown: `${e?.code ?? ''} ${e?.message ?? e}` }
  } finally {
    await client.query('rollback')
  }
  const mism = checkMigrationCase(c, observed)
  if (mism.length > 0) {
    failed += 1
    console.log(`NG [${c.finding}] ${c.name}\n   ${mism.join('\n   ')}${observed?.thrown ? `\n   thrown: ${observed.thrown}` : ''}`)
  } else {
    console.log(`ok [${c.finding}] ${c.name}`)
  }
}
await client.end()
console.log(`\n${ran - failed}/${ran} 件が移行 0021〜0030 の契約と一致`)
process.exit(failed === 0 ? 0 : 1)
