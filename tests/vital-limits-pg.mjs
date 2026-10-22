// tests/vital-limits-contract.mjs の表（移行 0045・個人のバイタルの閾値）を、素の Postgres で流す実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/vital-limits-pg.mjs
//
// 前提（vital-targets-pg.mjs と同じ）: tests/pg-supabase-stub.sql・pg-backend-stub.sql（private.my_role() は test.role を返す真似・
//   kv_entries・master_residents・cron の真似）・pg-realtime-stub.sql を当ててから、supabase/migrations の 0001〜（最新）を
//   順に当てた DB（tests/pg-run-all.mjs が用意する）。
// 1件ずつトランザクションを張り、最後に必ず rollback する（表に何も残さない）。
// 個人情報は置かない（利用者は架空の「見本」姓・職員は合成の名前と数値IDのみ）。

import pg from 'pg'
import { LIMIT_CASES, LIMIT_SEED_SQL, checkLimitCase } from './vital-limits-contract.mjs'

const url = process.env.CARELOG_PG_URL
if (!url || !/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('CARELOG_PG_URL に使い捨てのローカル DB（127.0.0.1）を指定してください。')
  process.exit(2)
}

const client = new pg.Client({ connectionString: url })
await client.connect()
const only = process.env.CARELOG_ONLY ? new Set(process.env.CARELOG_ONLY.split(',')) : null

/** 試験のログイン中の uid（合成） */
const UID = '00000000-0000-0000-0000-000000000001'

const h = {
  async pg(text, params) {
    return (await client.query(text, params)).rows
  },
  /**
   * opts.role（authenticated／anon）に切り替え、private.my_role() が opts.appRole（省略＝役割なし）を、
   * private.is_member() が opts.member（既定 true）を返す状態で fn を流す。例外は SQLSTATE で返す（savepoint まで巻き戻す）
   */
  async as(opts, fn) {
    const role = opts.role ?? 'authenticated'
    if (!['authenticated', 'anon'].includes(role)) throw new Error(`役割が違う: ${role}`)
    await client.query('savepoint as_user')
    await client.query(`set local role ${role}`)
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role })])
    await client.query(`select set_config('test.member', $1, true)`, [opts.member === false ? 'false' : 'true'])
    await client.query(`select set_config('test.role', $1, true)`, [opts.appRole ?? ''])
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
      // P0001（トリガが止めた）は文の頭（vital_limits_…:）も返す（端末はこの頭で案内を出し分ける）
      const head = e.code === 'P0001' ? (/^([a-z_]+):/.exec(String(e.message ?? ''))?.[1] ?? null) : null
      return { error: e.code, constraint: e.constraint ?? null, ...(head !== null ? { msg: head } : {}) }
    }
  },
}

let failed = 0
let ran = 0
for (const c of LIMIT_CASES) {
  if (only !== null && !only.has(c.id)) continue
  ran += 1
  await client.query('begin')
  let observed
  try {
    for (const s of LIMIT_SEED_SQL) await client.query(s)
    observed = await c.run(h)
  } catch (e) {
    observed = { thrown: `${e?.code ?? ''} ${e?.message ?? e}` }
  } finally {
    await client.query('rollback')
  }
  const mism = checkLimitCase(c, observed)
  if (mism.length > 0) {
    failed += 1
    console.log(`NG [${c.id}] ${c.name}\n   ${mism.join('\n   ')}${observed?.thrown ? `\n   thrown: ${observed.thrown}` : ''}`)
  } else {
    console.log(`ok [${c.id}] ${c.name}`)
  }
}
await client.end()
console.log(`\n${ran - failed}/${ran} 件が移行 0045（個人のバイタルの閾値）の契約と一致`)
process.exit(failed === 0 ? 0 : 1)
