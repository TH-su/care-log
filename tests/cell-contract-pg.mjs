// tests/cell-contract.mjs の表を、素の Postgres の apply_cell_edits（0011。0019 の member_only の下）で流す実行器（2026-10-10 監査 F13）。
// 同じ表を偽物（fakeApplyCellEdits）でも流して並べ、0011・偽物・表の3つが食い違ったらここで落ちる（npm test は偽物だけを相手にする）。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/cell-contract-pg.mjs
//   （DB の用意から全部の実行器までまとめて流すのは tests/pg-run-all.mjs。GitHub Actions の pg-contract も同じ）
//
// 前提: Supabase の役割と auth 関数の真似（tests/pg-supabase-stub.sql）・care-backend の部品の真似（tests/pg-backend-stub.sql）・
//       supabase/migrations の 0001〜最新を当てた DB。
// 1件ずつトランザクションを張り、最後に必ず rollback する（表に何も残さない）。
// 呼び出しは authenticated に切り替えて行う（security invoker・RLS・member_only の下で動くことを確かめる）。
// 個人情報は置かない（利用者・職員は数値IDのみ。本文は記号だけ）。

import pg from 'pg'
import { CELL_CONTRACT_CASES, checkContract, runContractCaseOnFake } from './cell-contract.mjs'

const url = process.env.CARELOG_PG_URL
if (!url || !/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('CARELOG_PG_URL に使い捨てのローカル DB（127.0.0.1）を指定してください。')
  process.exit(2)
}

/** 試験のログイン中の uid（合成） */
const UID = '00000000-0000-0000-0000-000000000001'
const DAY = '2026-11-01'

const client = new pg.Client({ connectionString: url })
await client.connect()

/** 役割を authenticated に切り替え、ログイン中の uid と許可リストの有無（private.is_member の真似）を置く */
async function asUser(member = true) {
  await client.query(`set local role authenticated`)
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
  await client.query(`select set_config('test.member', $1, true)`, [member ? 'true' : 'false'])
}

async function seedBase() {
  await client.query(`insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02') on conflict (id) do nothing`)
  await client.query(
    `insert into residents (id, source_id, name, active) overriding system value values (1, 'CR1', '利用者01', true) on conflict (id) do nothing`,
  )
  await client.query(`delete from record_history where table_name in ('vitals', 'meals')`)
  await client.query(`delete from vitals`)
  await client.query(`delete from meals`)
}

/** 契約の1件の前の行を置く（偽物の runContractCaseOnFake と同じ形）。置いた行の id（無ければ null） */
async function seedRow(c) {
  if (c.row === null) return null
  const deleted = c.deleted ? '2026-11-01T00:00:00Z' : null
  if (c.table === 'meals') {
    const r = { main_amount: null, side_amount: null, status: null, note: null, recorded_by: null, ...c.row }
    await client.query(
      `insert into meals (id, resident_id, meal_on, meal_slot, main_amount, side_amount, status, note, recorded_by, deleted_at)
       overriding system value values (101, 1, $1, 'lunch', $2, $3, $4, $5, $6, $7)`,
      [DAY, r.main_amount, r.side_amount, r.status, r.note, r.recorded_by, deleted],
    )
    return 101
  }
  const kind = c.key === 'routine' ? 'routine' : (c.kind ?? 'recheck')
  const r = { measured_at: null, temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null, note: null, symptom: null, recorded_by: null, ...c.row }
  await client.query(
    `insert into vitals (id, resident_id, measured_on, kind, client_key, measured_at, temp, sys_bp, dia_bp, pulse, spo2, note, symptom, recorded_by, deleted_at)
     overriding system value values (101, 1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [DAY, kind, c.key === 'client' ? 'cc-key' : null, r.measured_at, r.temp, r.sys_bp, r.dia_bp, r.pulse, r.spo2, r.note, r.symptom, r.recorded_by, deleted],
  )
  return 101
}

function keyOf(c, prevId) {
  if (c.key === 'routine') return { resident_id: 1, measured_on: DAY }
  if (c.key === 'client') return { client_key: 'cc-key', resident_id: 1, measured_on: DAY, kind: c.kind ?? 'recheck' }
  if (c.key === 'id') return { id: prevId ?? 999 }
  return { resident_id: 1, meal_on: DAY, meal_slot: 'lunch' }
}

async function callApply(c, key) {
  await client.query('savepoint call')
  try {
    const res = await client.query(`select public.apply_cell_edits($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6) as r`, [
      c.table,
      JSON.stringify(key),
      JSON.stringify(c.edits),
      JSON.stringify(c.fill ?? {}),
      c.editor ?? null,
      c.key === 'client' ? 'cc-key' : null,
    ])
    await client.query('release savepoint call')
    return { ok: res.rows[0].r }
  } catch (e) {
    await client.query('rollback to savepoint call')
    return { error: e.code, msg: e.message }
  }
}

let failed = 0
let total = 0
const report = (ok, name, lines = []) => {
  total += 1
  if (!ok) failed += 1
  console.log(`${ok ? 'ok' : 'NG'} ${name}${lines.length > 0 ? `\n   ${lines.join('\n   ')}` : ''}`)
}

for (const c of CELL_CONTRACT_CASES) {
  await client.query('begin')
  let result
  let after = {}
  let uidMismatch = []
  try {
    await seedBase()
    const prevId = await seedRow(c)
    const hist0 = Number((await client.query(`select count(*)::int n from record_history where table_name = $1`, [c.table])).rows[0].n)
    const rev0 = prevId === null ? null : (await client.query(`select rev from ${c.table} where id = 101`)).rows[0].rev
    await asUser(true)
    result = await callApply(c, keyOf(c, prevId))
    await client.query('reset role')
    const live = (await client.query(`select id, rev, edited_by from ${c.table} where deleted_at is null order by id`)).rows
    const hist = Number((await client.query(`select count(*)::int n from record_history where table_name = $1`, [c.table])).rows[0].n)
    const prevRow = prevId === null ? null : (await client.query(`select rev from ${c.table} where id = 101`)).rows[0]
    const latest = live[live.length - 1] ?? null
    after = {
      revDelta: prevRow === null ? undefined : prevRow.rev - rev0,
      history: hist - hist0,
      liveRows: live.length,
      editedBy: latest === null ? undefined : latest.edited_by === null ? null : Number(latest.edited_by),
    }
    // この呼び出しで足された変更の記録は、どれもログイン中の uid を持つ
    const uids = (
      await client.query(`select changed_by_uid::text u from record_history where table_name = $1 order by id offset $2`, [c.table, hist0])
    ).rows.map((x) => x.u)
    uidMismatch = uids.filter((u) => u !== UID)
  } finally {
    await client.query('rollback')
  }
  const mism = checkContract(c, result, after)
  if (uidMismatch.length > 0) mism.push(`record_history.changed_by_uid ${JSON.stringify(uidMismatch)} != ${UID}`)
  if (result?.msg && mism.length > 0) mism.push(`msg: ${result.msg}`)
  // 同じ表を偽物でも流す（偽物の側の食い違いもここで分かるように並べる）
  const fake = runContractCaseOnFake(c)
  if (fake.mismatches.length > 0) mism.push(`偽物（fakeApplyCellEdits）も表と食い違う: ${fake.mismatches.join(' / ')}`)
  report(mism.length === 0, c.name, mism)
}

// 許可リストに無い職員（member_only・0019）: 読めず書けない。行が見えないので missing にするか、書こうとして 42501 で止まるか。
// どちらでも何も書かない・変更の記録も残さないことを確かめる（形は結果に出す）
for (const [name, existing] of [
  ['許可リストに無い職員: 既にある定時バイタルへ基準つきで送っても書かない', true],
  ['許可リストに無い職員: 行の無い定時バイタルを作れない', false],
]) {
  await client.query('begin')
  let lines = []
  try {
    await seedBase()
    if (existing) await seedRow({ table: 'vitals', key: 'routine', row: { temp: 36.5 } })
    await asUser(false)
    const r = await callApply(
      { table: 'vitals', key: 'routine', edits: { temp: { value: 37.0, base: existing ? 36.5 : null } }, editor: 1 },
      { resident_id: 1, measured_on: DAY },
    )
    await client.query('reset role')
    const rows = (await client.query(`select temp::text t, rev from vitals where deleted_at is null`)).rows
    const hist = Number((await client.query(`select count(*)::int n from record_history where table_name = 'vitals'`)).rows[0].n)
    const wrote = existing ? rows.length !== 1 || rows[0].t !== '36.5' || Number(rows[0].rev) !== 1 : rows.length !== 0
    if (wrote) lines.push(`行が変わった: ${JSON.stringify(rows)}`)
    if (hist !== 0) lines.push(`変更の記録が ${hist} 件残った`)
    const safeShape = r.error === '42501' || (r.ok?.status === 'conflict' && (r.ok.applied ?? []).length === 0)
    if (!safeShape) lines.push(`返り方が想定外: ${JSON.stringify(r)}`)
    console.log(`   （返り方: ${r.error !== undefined ? `例外 ${r.error}` : `status=${r.ok?.status}`}）`)
  } finally {
    await client.query('rollback')
  }
  report(lines.length === 0, name, lines)
}

// 権限: anon は呼べない・authenticated は呼べる・security invoker（RLS の下で動く。0011 の grant / revoke）
const priv = (
  await client.query(
    `select has_function_privilege('anon', 'public.apply_cell_edits(text,jsonb,jsonb,jsonb,bigint,text)', 'execute') as anon,
            has_function_privilege('authenticated', 'public.apply_cell_edits(text,jsonb,jsonb,jsonb,bigint,text)', 'execute') as auth,
            (select bool_or(prosecdef) from pg_proc where proname = 'apply_cell_edits') as definer`,
  )
).rows[0]
report(priv.anon === false && priv.auth === true && priv.definer === false, '権限: apply_cell_edits は anon 不可・authenticated 可・security invoker', [
  `anon=${priv.anon} authenticated=${priv.auth} security definer=${priv.definer}`,
])

await client.end()
console.log(`\n${total - failed}/${total} 件が 0011（と偽物 fakeApplyCellEdits）と一致`)
process.exit(failed === 0 ? 0 : 1)
