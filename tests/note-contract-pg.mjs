// tests/note-contract.mjs の表を、素の Postgres（0001〜0011・0017・0027 適用済み）で流す実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/note-contract-pg.mjs
//
// 1件ずつトランザクションを張り、最後に必ず rollback する（表に何も残さない）。
// 呼び出しは authenticated に切り替えて行う（security invoker・RLS の下で動くことを確かめる）。
// ログイン中の uid は request.jwt.claims（今の PostgREST が置く場所・Supabase の真似 tests/pg-supabase-stub.sql の auth.uid()
// が読む場所）に置き、変更の記録（record_history.changed_by_uid）に入ることも確かめる（F13。以前の置き場所（jwt.claim.sub）は
// 真似の auth.uid() に読まれず、changed_by_uid が null のまま通っていた）。
// 使い捨ての DB の用意から全部の実行器までまとめて流すのは tests/pg-run-all.mjs（GitHub Actions の pg-contract も同じ）。
// 個人情報は置かない（利用者・職員は数値IDのみ。本文は記号だけ）。

import pg from 'pg'
import { NOTE_BASE_ROW, NOTE_CONTRACT_CASES, checkNoteContract } from './note-contract.mjs'

const url = process.env.CARELOG_PG_URL
if (!url || !/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('CARELOG_PG_URL に使い捨てのローカル DB（127.0.0.1）を指定してください。')
  process.exit(2)
}

/** 試験のログイン中の uid（合成） */
const UID = '00000000-0000-0000-0000-000000000001'

const client = new pg.Client({ connectionString: url })
await client.connect()
let failed = 0
for (const c of NOTE_CONTRACT_CASES) {
  await client.query('begin')
  let result
  let after = {}
  let uidMismatch = []
  try {
    await client.query(`insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02') on conflict (id) do nothing`)
    await client.query(
      `insert into residents (id, source_id, name, active) overriding system value
       values (1, 'CR1', '利用者01', true), (2, 'CR2', '利用者02', true) on conflict (id) do nothing`,
    )
    await client.query(`delete from notes where id = 101`)
    if (c.row !== null) {
      const r = { ...NOTE_BASE_ROW, ...c.row }
      await client.query(
        `insert into notes (id, note_on, shift, resident_id, body, importance, color, after16, occurred_at, reporter_id,
                            role_tags, ongoing, ended_at, ended_by, deleted_at)
         overriding system value
         values (101, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [r.note_on, r.shift, r.resident_id, r.body, r.importance, r.color, r.after16, r.occurred_at, r.reporter_id,
          r.role_tags, r.ongoing, r.ended_at, r.ended_by, c.deleted ? '2026-11-01T00:00:00Z' : null],
      )
    }
    const hist0 = Number((await client.query(`select count(*)::int n from record_history where table_name = 'notes' and row_id = 101`)).rows[0].n)
    const rev0 = c.row === null ? null : (await client.query(`select rev from notes where id = 101`)).rows[0].rev
    await client.query(`set local role authenticated`)
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
    await client.query('savepoint call')
    try {
      const res = await client.query(`select public.apply_note_edits(101, $1::jsonb, $2) as r`, [JSON.stringify(c.edits), c.editor ?? null])
      result = { ok: res.rows[0].r }
    } catch (e) {
      result = { error: e.code }
      await client.query('rollback to savepoint call')
    }
    await client.query(`reset role`)
    if (c.row !== null) {
      const n = (await client.query(`select rev, body, deleted_at, edited_by from notes where id = 101`)).rows[0]
      const hist = Number((await client.query(`select count(*)::int n from record_history where table_name = 'notes' and row_id = 101`)).rows[0].n)
      after = { revDelta: n.rev - rev0, history: hist - hist0, deleted: n.deleted_at !== null, editedBy: n.edited_by === null ? null : Number(n.edited_by), body: n.body }
      // この呼び出しで足された変更の記録は、どれもログイン中の uid を持つ（取込が「アプリで直した行」を見分ける前提・F13）
      const uids = (
        await client.query(
          `select changed_by_uid::text u from record_history where table_name = 'notes' and row_id = 101 order by id offset $1`,
          [hist0],
        )
      ).rows.map((x) => x.u)
      uidMismatch = uids.filter((u) => u !== UID)
    } else {
      after = { history: 0 }
    }
  } finally {
    await client.query('rollback')
  }
  const mism = checkNoteContract(c, result, after)
  if (uidMismatch.length > 0) mism.push(`record_history.changed_by_uid ${JSON.stringify(uidMismatch)} != ${UID}`)
  if (mism.length > 0) {
    failed += 1
    console.log(`NG ${c.name}\n   ${mism.join('\n   ')}`)
  } else {
    console.log(`ok ${c.name}`)
  }
}
await client.end()
console.log(`\n${NOTE_CONTRACT_CASES.length - failed}/${NOTE_CONTRACT_CASES.length} 件が 0017（0027 で改訂）と一致`)
process.exit(failed === 0 ? 0 : 1)
