// tests/vital-delete-contract.mjs の表を、素の Postgres（0001〜0011・0017・0019・0020 適用済み）で流す実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/vital-delete-pg.mjs
//
// 前提: Supabase の役割と auth 関数の真似（care-backend の supabase/tests/00_supabase_stub.sql）と、
//       0019 が使う private.is_member()（試験では current_setting('test.member') を返す差し替え）。
// 1件ずつトランザクションを張り、最後に必ず rollback する（表に何も残さない）。
// 呼び出しは authenticated に切り替えて行う（security invoker・RLS・member_only の下で動くことを確かめる）。
// 個人情報は置かない（利用者・職員は数値IDのみ。症状は記号だけ）。

import pg from 'pg'
import { VITAL_BASE_ROW, VITAL_DELETE_CASES, checkVitalDelete, seenForCase, seenOf } from './vital-delete-contract.mjs'

const url = process.env.CARELOG_PG_URL
if (!url || !/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('CARELOG_PG_URL に使い捨てのローカル DB（127.0.0.1）を指定してください。')
  process.exit(2)
}

const client = new pg.Client({ connectionString: url })
await client.connect()
let failed = 0
for (const c of VITAL_DELETE_CASES) {
  await client.query('begin')
  let result
  let after = {}
  try {
    await client.query(`insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02') on conflict (id) do nothing`)
    await client.query(
      `insert into residents (id, source_id, name, active) overriding system value
       values (1, 'CR1', '利用者01', true) on conflict (id) do nothing`,
    )
    await client.query(`delete from record_history where table_name = 'vitals' and row_id = 101`)
    await client.query(`delete from vitals where id = 101`)
    if (c.row !== null) {
      const r = { ...VITAL_BASE_ROW, ...c.row }
      await client.query(
        `insert into vitals (id, resident_id, measured_on, kind, measured_at, temp, sys_bp, dia_bp, pulse, spo2, note, symptom,
                             recorded_by, client_key, deleted_at)
         overriding system value
         values (101, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [r.resident_id, r.measured_on, r.kind, r.measured_at, r.temp, r.sys_bp, r.dia_bp, r.pulse, r.spo2, r.note, r.symptom,
          r.recorded_by, r.kind === 'routine' ? null : 'ck-pg-101', c.deleted ? '2026-11-01T00:00:00Z' : null],
      )
    }
    const hist0 = Number((await client.query(`select count(*)::int n from record_history where table_name = 'vitals' and row_id = 101`)).rows[0].n)
    const rev0 = c.row === null ? null : (await client.query(`select rev from vitals where id = 101`)).rows[0].rev
    await client.query(`set local role authenticated`)
    await client.query(`select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001"}', true)`)
    await client.query(`select set_config('test.member', $1, true)`, [c.member === false ? 'false' : 'true'])
    await client.query('savepoint call')
    try {
      const res = await client.query(`select public.delete_vital($1, $2::jsonb, $3) as r`, [
        c.id === undefined ? 101 : c.id,
        JSON.stringify(seenForCase(c)),
        c.editor ?? null,
      ])
      result = { ok: res.rows[0].r }
    } catch (e) {
      result = { error: e.code }
      await client.query('rollback to savepoint call')
    }
    await client.query(`reset role`)
    if (c.row !== null) {
      const n = (await client.query(`select rev, deleted_at, edited_by from vitals where id = 101`)).rows[0]
      const h = (await client.query(`select op from record_history where table_name = 'vitals' and row_id = 101 order by id`)).rows
      after = {
        deleted: n.deleted_at !== null,
        revDelta: n.rev - rev0,
        history: h.length - hist0,
        historyOp: h[hist0]?.op,
        editedBy: n.edited_by === null ? null : Number(n.edited_by),
      }
    } else {
      after = { history: 0 }
    }
  } finally {
    await client.query('rollback')
  }
  const mism = checkVitalDelete(c, result, after)
  if (mism.length > 0) {
    failed += 1
    console.log(`NG ${c.name}\n   ${mism.join('\n   ')}`)
  } else {
    console.log(`ok ${c.name}`)
  }
}

// 権限: anon は呼べない・authenticated は呼べる（0020 の revoke / grant）
const priv = (
  await client.query(
    `select has_function_privilege('anon', 'public.delete_vital(bigint,jsonb,bigint)', 'execute') as anon,
            has_function_privilege('authenticated', 'public.delete_vital(bigint,jsonb,bigint)', 'execute') as auth,
            (select prosecdef from pg_proc where proname = 'delete_vital') as definer`,
  )
).rows[0]
const privOk = priv.anon === false && priv.auth === true && priv.definer === false
if (!privOk) failed += 1
console.log(`${privOk ? 'ok' : 'NG'} 権限: anon=${priv.anon} authenticated=${priv.auth} security definer=${priv.definer}`)

// 取り消し → 復元（deleted_at を空に戻す）→ 読み直しの一巡（qa-verification.md §5・2026-10-10 監査 F13）。
// アプリに復元の道は無い。誤って取り消した時に管理者がダッシュボード（postgres の役割）から deleted_at を空に戻せば、
// 8欄がそのまま読めて、取り消しと復元の両方が変更の記録に残ることを確かめる
const restore = []
await client.query('begin')
try {
  await client.query(`insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02') on conflict (id) do nothing`)
  await client.query(
    `insert into residents (id, source_id, name, active) overriding system value
     values (1, 'CR1', '利用者01', true) on conflict (id) do nothing`,
  )
  await client.query(`delete from record_history where table_name = 'vitals' and row_id = 101`)
  await client.query(`delete from vitals where id = 101`)
  const r = VITAL_BASE_ROW
  await client.query(
    `insert into vitals (id, resident_id, measured_on, kind, measured_at, temp, sys_bp, dia_bp, pulse, spo2, note, symptom, recorded_by, client_key)
     overriding system value values (101, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ck-pg-101')`,
    [r.resident_id, r.measured_on, r.kind, r.measured_at, r.temp, r.sys_bp, r.dia_bp, r.pulse, r.spo2, r.note, r.symptom, r.recorded_by],
  )
  const rev0 = Number((await client.query(`select rev from vitals where id = 101`)).rows[0].rev)
  await client.query(`set local role authenticated`)
  await client.query(`select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001"}', true)`)
  await client.query(`select set_config('test.member', 'true', true)`)
  const del = (await client.query(`select public.delete_vital(101, $1::jsonb, 1) as r`, [JSON.stringify(seenOf(r))])).rows[0].r
  if (del?.status !== 'applied') restore.push(`取り消し: status ${del?.status} != applied`)
  const hidden = (await client.query(`select count(*)::int n from vitals where id = 101 and deleted_at is null`)).rows[0].n
  if (hidden !== 0) restore.push('取り消した行が生きている行として読める')
  await client.query(`reset role`)
  // 管理者の復元（ダッシュボードの SQL エディタと同じく postgres の役割で）
  await client.query(`update vitals set deleted_at = null where id = 101`)
  await client.query(`set local role authenticated`)
  const back = (
    await client.query(
      `select measured_at::text measured_at, temp::float8 temp, sys_bp, dia_bp, pulse, spo2, note, symptom, rev from vitals where id = 101 and deleted_at is null`,
    )
  ).rows
  await client.query(`reset role`)
  if (back.length !== 1) restore.push(`復元した行が読めない（${back.length} 行）`)
  else {
    const b = back[0]
    for (const f of ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2', 'note', 'symptom']) {
      if (JSON.stringify(b[f] === null ? null : f === 'note' || f === 'symptom' ? b[f] : Number(b[f])) !== JSON.stringify(r[f])) {
        restore.push(`復元後の ${f} ${JSON.stringify(b[f])} != ${JSON.stringify(r[f])}`)
      }
    }
    if (b.measured_at !== r.measured_at) restore.push(`復元後の measured_at ${b.measured_at} != ${r.measured_at}`)
    if (Number(b.rev) - rev0 !== 2) restore.push(`rev が ${Number(b.rev) - rev0} 進んだ（取り消しと復元で 2 のはず）`)
  }
  const ops = (await client.query(`select op from record_history where table_name = 'vitals' and row_id = 101 order by id`)).rows.map((x) => x.op)
  if (JSON.stringify(ops) !== JSON.stringify(['delete', 'update'])) restore.push(`変更の記録 ${JSON.stringify(ops)} != ["delete","update"]`)
} catch (e) {
  restore.push(`例外 ${e.code ?? ''} ${e.message}`)
} finally {
  await client.query('rollback')
}
if (restore.length > 0) failed += 1
console.log(`${restore.length === 0 ? 'ok' : 'NG'} 取り消し → 復元（deleted_at を空に戻す）→ 読み直し${restore.length > 0 ? `\n   ${restore.join('\n   ')}` : ''}`)

await client.end()
console.log(`\n${VITAL_DELETE_CASES.length + 2 - failed}/${VITAL_DELETE_CASES.length + 2} 件が 0020 と一致（権限・取り消し→復元の一巡を含む）`)
process.exit(failed === 0 ? 0 : 1)
