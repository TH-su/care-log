// 0051（施設の印の段階1）を、素の Postgres（0001〜最新を適用済み）で確かめる実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/tenant-stage1-pg.mjs
//
// 確かめること:
//   1. 27表すべてに tenant_id の列と、印を入れるトリガ（carelog_fill_tenant）がある。27表以外の public の表は試験の真似だけ
//   2. ログインした人（authenticated）が印を付けずに足すと、その人の施設（my_tenant()）の印が入る
//   3. サーバーの接続（自動の記録・取込）が印を付けずに足すと、施設がちょうど1つの時はその施設の印が入る
//   4. 施設が2つになると、サーバーの接続の行には印を勝手に付けない（null のまま＝どの施設か分からない行を作らない）
//   5. 印を付けて足した時は、その印のまま（書き換えない）
// 1件ずつトランザクションを張り、最後に必ず rollback する（表に何も残さない）。個人情報は置かない（数値IDと「職員01」だけ）。

import pg from 'pg'

const url = process.env.CARELOG_PG_URL
if (!url || !/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('CARELOG_PG_URL に使い捨てのローカル DB（127.0.0.1）を指定してください。')
  process.exit(2)
}

export const TENANT_TABLES = ['residents', 'staff', 'vitals', 'meals', 'fluid_intake', 'notes', 'note_reads', 'outings', 'attendance',
  'app_settings', 'import_days', 'master_sync_log', 'record_history', 'bath_records', 'med_slots', 'med_admin', 'incidents',
  'resident_targets', 'resident_vital_limits', 'daycare_days', 'daycare_attendance', 'daycare_activity_log',
  'daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due', 'daycare_training_due_settings', 'daycare_staffing']
/** 試験の真似（care-backend の表の代わり）。本番では care-backend の表で、施設の列を元から持つ */
const STUB_TABLES = ['kv_entries', 'master_residents', 'tenants']
const A = '00000000-0000-0000-0000-0000000000aa'
const B = '00000000-0000-0000-0000-0000000000bb'

const client = new pg.Client({ connectionString: url })
await client.connect()
let failed = 0
const ok = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`)
  else { failed++; console.log(`  ✗ ${label}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`) }
}

// 1. 列とトリガ
{
  const cols = (await client.query(
    `select table_name from information_schema.columns where table_schema = 'public' and column_name = 'tenant_id' order by 1`)).rows.map((r) => r.table_name)
  const missing = TENANT_TABLES.filter((t) => !cols.includes(t))
  ok('27表すべてに施設の列がある', missing.length === 0, missing)
  const trg = (await client.query(
    `select c.relname from pg_trigger g join pg_class c on c.oid = g.tgrelid where g.tgname = 'carelog_fill_tenant' and not g.tgisinternal order by 1`)).rows.map((r) => r.relname)
  ok('27表すべてに印を入れるトリガがある', TENANT_TABLES.every((t) => trg.includes(t)) && trg.length === 27, trg)
  const all = (await client.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`)).rows.map((r) => r.relname)
  const other = all.filter((t) => !TENANT_TABLES.includes(t) && !STUB_TABLES.includes(t))
  ok('public の表は27表と試験の真似だけ（表を足したら TENANT_TABLES と 0051 に足す）', other.length === 0, other)
}

async function inTx(fn) {
  await client.query('begin')
  try { await fn() } finally { await client.query('rollback') }
}
const tenantOfStaff = async (id) => (await client.query(`select tenant_id from staff where id = $1`, [id])).rows[0]?.tenant_id ?? null

// 2. ログインした人
await inTx(async () => {
  await client.query(`set local role authenticated`)
  await client.query(`select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001"}', true)`)
  await client.query(`select set_config('test.role', 'office', true)`)
  await client.query(`reset role`)
  // staff は事務所の書き込みの決まりがあるので、印の入り方だけを見るためサーバーの接続で my_tenant() を返す形で足す
  await client.query(`insert into staff (id, name) overriding system value values (9001, '職員01')`)
  ok('印を付けずに足すと my_tenant() の施設の印が入る', (await tenantOfStaff(9001)) === A, await tenantOfStaff(9001))
})

// 3〜5. サーバーの接続（my_tenant() が null の時）
await inTx(async () => {
  await client.query(`create or replace function private.my_tenant() returns uuid language sql stable as $$ select null::uuid $$`)
  await client.query(`insert into staff (id, name) overriding system value values (9002, '職員02')`)
  ok('サーバーの接続（ログインの印なし）でも、施設が1つなら施設の印が入る', (await tenantOfStaff(9002)) === A, await tenantOfStaff(9002))
  await client.query(`insert into tenants (id, name) values ($1, '見本の施設B')`, [B])
  await client.query(`insert into staff (id, name) overriding system value values (9003, '職員03')`)
  ok('施設が2つになると、サーバーの接続の行に印を勝手に付けない（null のまま）', (await tenantOfStaff(9003)) === null, await tenantOfStaff(9003))
  await client.query(`insert into staff (id, name, tenant_id) overriding system value values (9004, '職員04', $1)`, [B])
  ok('印を付けて足した時は、その印のまま', (await tenantOfStaff(9004)) === B, await tenantOfStaff(9004))
})

await client.end()
console.log(failed ? `\n失敗 ${failed} 件` : '\nすべて成功')
process.exit(failed === 0 ? 0 : 1)
