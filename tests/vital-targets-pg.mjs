// tests/vital-targets-contract.mjs の表（0034 の個別の目標の表 resident_targets・平熱の RPC vital_usual_temps）を、素の Postgres で流す実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/vital-targets-pg.mjs
//
// 前提（note-lock-pg.mjs と同じ）: tests/pg-supabase-stub.sql・pg-backend-stub.sql（private.my_role() は test.role を返す真似・
//   private.has_role() は本物と同じ本文）・pg-realtime-stub.sql を当ててから、supabase/migrations の 0001〜（最新）を順に当てた DB
//   （tests/pg-run-all.mjs が用意する）。
// 1件ずつトランザクションを張り、最後に必ず rollback する（表に何も残さない。名前を変えた has_role も戻る）。
// 個人情報は置かない（利用者・職員は合成の名前と数値IDのみ）。

import pg from 'pg'
import { TARGETS_CASES, TARGETS_SEED_SQL, checkTargetsCase } from './vital-targets-contract.mjs'

const url = process.env.CARELOG_PG_URL
if (!url || !/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('CARELOG_PG_URL に使い捨てのローカル DB（127.0.0.1）を指定してください。')
  process.exit(2)
}

const client = new pg.Client({ connectionString: url })
await client.connect()

/** 試験のログイン中の uid（合成） */
const UID = '00000000-0000-0000-0000-000000000001'

const h = {
  async pg(text, params) {
    return (await client.query(text, params)).rows
  },
  /**
   * opts.role（authenticated／anon）に切り替え、private.my_role() が opts.appRole（null・省略＝役割なし）を、
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
    const clear = async () => {
      await client.query('reset role')
      // 後に続く所有者の接続（取込の真似）へ役割・JWT を持ち越さない
      await client.query(`select set_config('test.role', '', true), set_config('request.jwt.claims', '', true), set_config('test.member', '', true)`)
    }
    try {
      const r = await fn(q)
      await clear()
      await client.query('release savepoint as_user')
      return r
    } catch (e) {
      await client.query('rollback to savepoint as_user')
      await clear()
      if (typeof e?.code !== 'string') throw e
      return { error: e.code, constraint: e.constraint ?? null }
    }
  },
}

let failed = 0
let ran = 0
for (const c of TARGETS_CASES) {
  ran += 1
  await client.query('begin')
  let observed
  try {
    for (const s of TARGETS_SEED_SQL) await client.query(s)
    observed = await c.run(h)
  } catch (e) {
    observed = { thrown: `${e?.code ?? ''} ${e?.message ?? e}` }
  } finally {
    await client.query('rollback')
  }
  const mism = checkTargetsCase(c, observed)
  if (mism.length > 0) {
    failed += 1
    console.log(`NG [${c.group}] ${c.name}\n   ${mism.join('\n   ')}${observed?.thrown ? `\n   thrown: ${observed.thrown}` : ''}`)
  } else {
    console.log(`ok [${c.group}] ${c.name}`)
  }
}

// 試験の後、has_role の名前の変更が残っていない（rollback で戻る）
ran += 1
const fn = (await client.query(`select to_regprocedure('private.has_role(text[])') is not null as ok`)).rows[0].ok
if (!fn) {
  failed += 1
  console.log('NG [shape] 試験の後、private.has_role が戻っていない')
} else {
  console.log('ok [shape] 試験の後、private.has_role はそのまま（名前の変更はトランザクションの中だけ）')
}

await client.end()
console.log(`\n${ran - failed}/${ran} 件が 0034（個別の目標・平熱）の契約と一致`)
process.exit(failed === 0 ? 0 : 1)
