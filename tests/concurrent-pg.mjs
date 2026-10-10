// 素の Postgres での同時実行の試験（設計 concurrent-entry.md §7・2026-10-10 監査 F13）。
// 2つの接続（端末A・端末B）から同じ行・同じ枠へ同時に書き、A が確定するまで B が行ロックで待たされること、
// 確定の後の B の判定が「どちらの値も黙って消えない」になることを確かめる。
//   ・2つの端末から同時に作る（同じ欄は競合・別の欄は書く／食事の主食と副食）
//   ・先に書かれた後の基準の食い違い
//   ・血圧の片側の食い違い（他の端末の上と自分の下の、誰も測っていない組を作らない）
//   ・冪等キーの二重送信（1行のまま）
//   ・取り消された行への編集（取り消しと同時。作り直さない）
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。行を確定させるので、
// 他の試験と DB を共有しない（tests/pg-run-all.mjs は実行器ごとに新しい DB を写して渡す）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/concurrent-pg.mjs
//
// 個人情報は置かない（利用者・職員は合成の名前と数値IDのみ）。

import pg from 'pg'

const url = process.env.CARELOG_PG_URL
if (!url || !/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('CARELOG_PG_URL に使い捨てのローカル DB（127.0.0.1）を指定してください。')
  process.exit(2)
}

const UID = '00000000-0000-0000-0000-000000000001'
const RES = 7
const DAY = '2026-11-02'

const connect = async () => {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  return c
}
const setup = await connect()
await setup.query(`insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02') on conflict (id) do nothing`)
await setup.query(
  `insert into residents (id, source_id, name, active) overriding system value values (${RES}, 'CR7', '利用者07', true) on conflict (id) do nothing`,
)

async function clean() {
  await setup.query(`delete from record_history where table_name in ('vitals', 'meals')`)
  await setup.query(`delete from vitals where resident_id = ${RES}`)
  await setup.query(`delete from meals where resident_id = ${RES}`)
}

/** トランザクションを張り、端末の職員として振る舞う（authenticated・ログイン中の uid・許可リストに入っている） */
async function begin(c) {
  await c.query('begin')
  await c.query('set local role authenticated')
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
  await c.query(`select set_config('test.member', 'true', true)`)
}

const applyCells = (c, table, key, edits, editor, ck = null) =>
  c
    .query(`select public.apply_cell_edits($1, $2::jsonb, $3::jsonb, '{}'::jsonb, $4, $5) as r`, [table, JSON.stringify(key), JSON.stringify(edits), editor, ck])
    .then((r) => r.rows[0].r, (e) => ({ error: e.code, msg: e.message }))

const deleteVital = (c, id, seen, editor) =>
  c
    .query(`select public.delete_vital($1, $2::jsonb, $3) as r`, [id, JSON.stringify(seen), editor])
    .then((r) => r.rows[0].r, (e) => ({ error: e.code, msg: e.message }))

/** pid の接続が行ロック待ちに入るまで待つ（入らずに終わった・5秒たったら false） */
async function waitsForLock(pid, done) {
  const until = Date.now() + 5000
  while (Date.now() < until) {
    if (done()) return false
    const r = await setup.query(`select wait_event_type from pg_stat_activity where pid = $1`, [pid])
    if (r.rows[0]?.wait_event_type === 'Lock') return true
    await new Promise((res) => setTimeout(res, 20))
  }
  return false
}

/**
 * A が書いて確定する前に B が同じ所へ書く。B が A のロックで待たされたかと、両方の返り値を返す。
 * a・b は (接続) => Promise<返り値>
 */
async function race(a, b) {
  const A = await connect()
  const B = await connect()
  try {
    const pidB = (await B.query('select pg_backend_pid() as p')).rows[0].p
    await begin(A)
    await begin(B)
    const ra = await a(A)
    let bDone = false
    const pb = b(B).then((x) => {
      bDone = true
      return x
    })
    const waited = await waitsForLock(pidB, () => bDone)
    await A.query(ra?.error ? 'rollback' : 'commit')
    const rb = await pb
    await B.query(rb?.error ? 'rollback' : 'commit')
    return { ra, rb, waited }
  } finally {
    await A.end()
    await B.end()
  }
}

let failed = 0
let total = 0
function check(name, problems) {
  total += 1
  if (problems.length > 0) failed += 1
  console.log(`${problems.length === 0 ? 'ok' : 'NG'} ${name}${problems.length > 0 ? `\n   ${problems.join('\n   ')}` : ''}`)
}
const conflictsOf = (r) => (r?.conflicts ?? []).map((x) => [x.field, x.reason, x.server]).sort((x, y) => x[0].localeCompare(y[0]))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function expectResult(p, label, r, want) {
  if (r?.error) {
    p.push(`${label}: 例外 ${r.error} ${r.msg}`)
    return
  }
  if (r?.status !== want.status) p.push(`${label}.status ${r?.status} != ${want.status}`)
  if (want.applied && !same([...(r?.applied ?? [])].sort(), [...want.applied].sort())) p.push(`${label}.applied ${JSON.stringify(r?.applied)} != ${JSON.stringify(want.applied)}`)
  if (want.settled && !same([...(r?.settled ?? [])].sort(), [...want.settled].sort())) p.push(`${label}.settled ${JSON.stringify(r?.settled)} != ${JSON.stringify(want.settled)}`)
  if (want.conflicts) {
    const got = conflictsOf(r).map(([f, reason, server]) => [f, reason, server === null ? null : Number(server)])
    const exp = [...want.conflicts].sort((x, y) => x[0].localeCompare(y[0]))
    if (!same(got, exp)) p.push(`${label}.conflicts ${JSON.stringify(got)} != ${JSON.stringify(exp)}`)
  }
}

const ROUTINE = { resident_id: RES, measured_on: DAY }
const LUNCH = { resident_id: RES, meal_on: DAY, meal_slot: 'lunch' }
const vitalsRows = async () =>
  (
    await setup.query(
      `select id, temp::float8 temp, sys_bp, dia_bp, pulse, client_key, deleted_at is not null deleted from vitals where resident_id = ${RES} order by id`,
    )
  ).rows

// 1. 2つの端末が同じ定時バイタルを同時に作る（A は体温・B は体温と脈拍）
{
  await clean()
  const { ra, rb, waited } = await race(
    (c) => applyCells(c, 'vitals', ROUTINE, { temp: { value: 36.5, base: null } }, 1),
    (c) => applyCells(c, 'vitals', ROUTINE, { temp: { value: 37.0, base: null }, pulse: { value: 70, base: null } }, 2),
  )
  const p = []
  if (!waited) p.push('B が A の確定を待たずに進んだ（同じ枠の二重作成を止めていない）')
  expectResult(p, 'A', ra, { status: 'applied', applied: ['temp'] })
  expectResult(p, 'B', rb, { status: 'partial', applied: ['pulse'], conflicts: [['temp', 'changed', 36.5]] })
  const rows = (await vitalsRows()).filter((r) => !r.deleted)
  if (rows.length !== 1 || rows[0].temp !== 36.5 || rows[0].pulse !== 70) p.push(`行: ${JSON.stringify(rows)}（1行・体温 36.5・脈拍 70 のはず）`)
  check('2つの端末が同じ定時バイタルを同時に作る → 1行・同じ欄は競合・別の欄は書く', p)
}

// 2. 食事: 主食と副食を同時に作る
{
  await clean()
  const { ra, rb, waited } = await race(
    (c) => applyCells(c, 'meals', LUNCH, { main_amount: { value: 8, base: null } }, 1),
    (c) => applyCells(c, 'meals', LUNCH, { side_amount: { value: 6, base: null } }, 2),
  )
  const p = []
  if (!waited) p.push('B が A の確定を待たずに進んだ')
  expectResult(p, 'A', ra, { status: 'applied', applied: ['main_amount'] })
  expectResult(p, 'B', rb, { status: 'applied', applied: ['side_amount'] })
  const rows = (await setup.query(`select main_amount, side_amount from meals where resident_id = ${RES} and deleted_at is null`)).rows
  if (rows.length !== 1 || Number(rows[0].main_amount) !== 8 || Number(rows[0].side_amount) !== 6) p.push(`行: ${JSON.stringify(rows)}（1行・主食 8・副食 6 のはず）`)
  check('食事の主食と副食を2つの端末が同時に作る → 1行に両方とも載る', p)
}

// 3. 先に書かれた後の基準の食い違い（どちらも 36.5 を見て直す）
{
  await clean()
  await setup.query(`insert into vitals (resident_id, measured_on, kind, temp) values (${RES}, '${DAY}', 'routine', 36.5)`)
  const { ra, rb, waited } = await race(
    (c) => applyCells(c, 'vitals', ROUTINE, { temp: { value: 37.0, base: 36.5 } }, 1),
    (c) => applyCells(c, 'vitals', ROUTINE, { temp: { value: 37.2, base: 36.5 } }, 2),
  )
  const p = []
  if (!waited) p.push('B が A の確定を待たずに進んだ')
  expectResult(p, 'A', ra, { status: 'applied', applied: ['temp'] })
  expectResult(p, 'B', rb, { status: 'conflict', applied: [], conflicts: [['temp', 'changed', 37.0]] })
  const rows = (await vitalsRows()).filter((r) => !r.deleted)
  if (rows.length !== 1 || rows[0].temp !== 37.0) p.push(`行: ${JSON.stringify(rows)}（体温 37.0 のまま＝後の端末が黙って上書きしない）`)
  check('先に書かれた後の基準の食い違い → 後の端末は競合で止まり、先の値が残る', p)
}

// 4. 血圧の片側の食い違い（A は上だけ・B は下だけを直す。相方は「値＝基準」で送る＝F4）
{
  await clean()
  await setup.query(`insert into vitals (resident_id, measured_on, kind, sys_bp, dia_bp) values (${RES}, '${DAY}', 'routine', 120, 80)`)
  const { ra, rb, waited } = await race(
    (c) => applyCells(c, 'vitals', ROUTINE, { sys_bp: { value: 125, base: 120 }, dia_bp: { value: 80, base: 80 } }, 1),
    (c) => applyCells(c, 'vitals', ROUTINE, { dia_bp: { value: 85, base: 80 }, sys_bp: { value: 120, base: 120 } }, 2),
  )
  const p = []
  if (!waited) p.push('B が A の確定を待たずに進んだ')
  expectResult(p, 'A', ra, { status: 'applied', applied: ['sys_bp'], settled: ['dia_bp'] })
  expectResult(p, 'B', rb, { status: 'conflict', applied: [], conflicts: [['dia_bp', 'changed', 80], ['sys_bp', 'changed', 125]] })
  const rows = (await vitalsRows()).filter((r) => !r.deleted)
  if (rows.length !== 1 || rows[0].sys_bp !== 125 || rows[0].dia_bp !== 80) {
    p.push(`行: ${JSON.stringify(rows)}（上 125・下 80 のはず。上 125・下 85 は誰も測っていない組）`)
  }
  check('血圧の片側の食い違い → 組ごと競合（他の端末の上と自分の下を混ぜない）', p)
}

// 5. 冪等キーの二重送信（同じ入力を2つの接続から同時に）
{
  await clean()
  const key = { client_key: 'ck-dup', resident_id: RES, measured_on: DAY, kind: 'recheck' }
  const { ra, rb, waited } = await race(
    (c) => applyCells(c, 'vitals', key, { temp: { value: 38.0, base: null } }, 1, 'ck-dup'),
    (c) => applyCells(c, 'vitals', key, { temp: { value: 38.0, base: null } }, 1, 'ck-dup'),
  )
  const p = []
  if (!waited) p.push('B が A の確定を待たずに進んだ')
  expectResult(p, 'A', ra, { status: 'applied', applied: ['temp'] })
  expectResult(p, 'B', rb, { status: 'noop', applied: [], settled: ['temp'] })
  const rows = (await vitalsRows()).filter((r) => !r.deleted && r.client_key === 'ck-dup')
  if (rows.length !== 1) p.push(`冪等キーの行が ${rows.length} 行（1行のはず）`)
  check('冪等キーの二重送信 → 1行のまま・後は「済み」', p)
}

// 6. 取り消された行への編集（A が発熱者の測定を取り消すのと同時に、B がその行の脈拍を直す）
{
  await clean()
  await setup.query(
    `insert into vitals (id, resident_id, measured_on, kind, client_key, pulse) overriding system value
     values (9001, ${RES}, '${DAY}', 'observation', 'ck-obs-9001', 70)`,
  )
  const seen = { temp: null, sys_bp: null, dia_bp: null, pulse: 70, spo2: null, measured_at: null, note: null, symptom: null }
  const { ra, rb, waited } = await race(
    (c) => deleteVital(c, 9001, seen, 1),
    (c) => applyCells(c, 'vitals', { id: 9001 }, { pulse: { value: 88, base: 70 } }, 2),
  )
  const p = []
  if (!waited) p.push('B が A の確定を待たずに進んだ')
  if (ra?.status !== 'applied') p.push(`A（取り消し）.status ${ra?.status ?? JSON.stringify(ra)} != applied`)
  expectResult(p, 'B', rb, { status: 'conflict', applied: [], conflicts: [['pulse', 'missing', null]] })
  const rows = await vitalsRows()
  if (rows.length !== 1 || rows[0].deleted !== true || rows[0].pulse !== 70) p.push(`行: ${JSON.stringify(rows)}（取り消されたまま・脈拍 70 のはず＝作り直さない）`)
  check('取り消された行への編集（取り消しと同時）→ 作り直さず「行が無い」で止める', p)
}

await clean()
await setup.end()
console.log(`\n${total - failed}/${total} 場面が設計 §7 の同時実行の約束と一致`)
process.exit(failed === 0 ? 0 : 1)
