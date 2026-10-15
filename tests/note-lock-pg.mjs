// tests/note-lock-contract.mjs の表（0033 の申し送りのロック・0032 の分類の列）を、素の Postgres で流す実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/note-lock-pg.mjs
//
// 前提（migrations-pg.mjs と同じ）: tests/pg-supabase-stub.sql・pg-backend-stub.sql（private.my_role() は test.role を返す真似）・
//   pg-realtime-stub.sql を当ててから、supabase/migrations の 0001〜（最新）を順に当てた DB（tests/pg-run-all.mjs が用意する）。
// 1件ずつトランザクションを張り、最後に必ず rollback する（表に何も残さない。差し替えた private.note_lock_now() も戻る）。
// 個人情報は置かない（利用者・職員は合成の名前と数値IDのみ。本文は記号だけ）。

import pg from 'pg'
import { LOCK_JUDGE_CASES, LOCK_SEED_SQL, LOCK_TRIGGER_CASES, checkLockCase } from './note-lock-contract.mjs'

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
  /** private.note_lock_now() を、このトランザクションの中だけ iso を返す関数に差し替える */
  async setNow(iso) {
    if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(iso)) throw new Error(`時刻の形が違う: ${iso}`)
    await client.query(
      `create or replace function private.note_lock_now() returns timestamptz language sql stable
       set search_path = public, pg_temp as $fn$ select '${iso}'::timestamptz $fn$`,
    )
  },
  /** authenticated に切り替え、private.my_role() が appRole（null＝役割なし）を返す状態で fn を流す。例外は SQLSTATE と文言で返す */
  async as(appRole, fn) {
    await client.query('savepoint as_user')
    await client.query(`set local role authenticated`)
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
    await client.query(`select set_config('test.member', 'true', true)`)
    await client.query(`select set_config('test.role', $1, true)`, [appRole ?? ''])
    const q = async (text, params) => (await client.query(text, params)).rows
    const clear = async () => {
      await client.query('reset role')
      // 後に続く所有者の接続（取込の真似）へ役割・JWT を持ち越さない
      await client.query(`select set_config('test.role', '', true), set_config('request.jwt.claims', '', true)`)
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
      return { error: e.code, message: e.message ?? null }
    }
  },
}

let failed = 0
let ran = 0

// 1. 判定の計算（private.note_lock_blocked）
for (const c of LOCK_JUDGE_CASES) {
  ran += 1
  const r = (
    await client.query(`select private.note_lock_blocked($1::date, $2, $3, $4::timestamptz, make_interval(mins => $5)) b`, [
      c.day,
      c.shift,
      c.after16,
      c.now,
      c.grace,
    ])
  ).rows[0].b
  if (r !== c.expect) {
    failed += 1
    console.log(`NG [judge] ${c.name}\n   ${r} != ${c.expect}`)
  } else {
    console.log(`ok [judge] ${c.name}`)
  }
}

// 2. トリガの結線
for (const c of LOCK_TRIGGER_CASES) {
  ran += 1
  await client.query('begin')
  let observed
  try {
    for (const s of LOCK_SEED_SQL) await client.query(s)
    observed = await c.run(h)
  } catch (e) {
    observed = { thrown: `${e?.code ?? ''} ${e?.message ?? e}` }
  } finally {
    await client.query('rollback')
  }
  const mism = checkLockCase(c, observed)
  if (mism.length > 0) {
    failed += 1
    console.log(`NG [${c.group}] ${c.name}\n   ${mism.join('\n   ')}${observed?.thrown ? `\n   thrown: ${observed.thrown}` : ''}`)
  } else {
    console.log(`ok [${c.group}] ${c.name}`)
  }
}

// 3. 差し替えが残っていない（rollback で本物の now() に戻る）
ran += 1
const live = (await client.query(`select abs(extract(epoch from private.note_lock_now() - now())) < 1 ok`)).rows[0].ok
if (!live) {
  failed += 1
  console.log('NG [shape] 試験の後、private.note_lock_now() が now() に戻っていない')
} else {
  console.log('ok [shape] 試験の後、private.note_lock_now() は now() のまま（差し替えはトランザクションの中だけ）')
}

await client.end()
console.log(`\n${ran - failed}/${ran} 件が 0033（申し送りのロック）・0032（分類の列）の契約と一致`)
process.exit(failed === 0 ? 0 : 1)
