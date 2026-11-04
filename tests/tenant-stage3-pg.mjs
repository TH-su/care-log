// 0053（施設の印の段階3）を、素の Postgres（0001〜最新を適用済み）で確かめる実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/tenant-stage3-pg.mjs
//
// 施設 A（試験の土台の施設 aa）と施設 B（この試験で足す bb）で確かめる:
//   1. 形: 27表の施設の印が必須・印を入れるトリガはそのまま・利用者／職員／申し送りを指す76本の外部キーが（施設の印, 番号）の組・
//      一意と主キーが施設ごと（名前は施設長の索引・主キー・その日の写しで同じ）
//   2. 同じ利用者No・職員の名前・旗の key・取込の日 (source, day)・その日の写し・計画書の規則の1行・施設長（同じ日）・取込の印が、
//      施設 A と施設 B に並んで入る。同じ施設の中では今までどおり 23505（計画書の規則の2行目は 23514）で止まる
//   3. よその施設の利用者・職員・申し送りを指す記録は 23503 で止まる（サーバーの接続でも、ログインした人でも）。番号が空の列は今までどおり通る
//   4. 印が決まらない書き込み（施設が2つ・ログインなし・施設を決めていない）は 23502 で止まる
//   5. デイの開所・計画書の期限の写し・取込の日の書き方（取込の道具と同じ文）が、両方の施設で書ける
//      （自動の記録の入口が両方の施設に書くことは tenant-stage2-pg.mjs の1が、段階③の本物の一意の上で確かめる）
//   6. 施設が1つの時の動きは今と同じ（止まる時の符号と施設長の索引の名前・衝突の先を名指さない書き込み）
//   7. 移行の先の確かめ: 印の無い行・よその施設を指す行・名前の違う外部キーがある時は、何も変えずに誤りで止まる
// 1件ずつトランザクションを張り、最後に必ず rollback する（表に何も残さない）。個人情報は置かない（利用者01・職員01 と数値IDだけ）。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pg from 'pg'

const url = process.env.CARELOG_PG_URL
if (!url || !/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('CARELOG_PG_URL に使い捨てのローカル DB（127.0.0.1）を指定してください。')
  process.exit(2)
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIG = readFileSync(path.join(ROOT, 'supabase', 'migrations', '0053_tenant_stage3.sql'), 'utf8')
const IMPORT_TOOL = readFileSync(path.join(ROOT, 'tools', 'import.mjs'), 'utf8')

const A = '00000000-0000-0000-0000-0000000000aa'
const B = '00000000-0000-0000-0000-0000000000bb'
const UID = '00000000-0000-0000-0000-000000000001'
const TABLES = ['residents', 'staff', 'vitals', 'meals', 'fluid_intake', 'notes', 'note_reads', 'outings', 'attendance',
  'app_settings', 'import_days', 'master_sync_log', 'record_history', 'bath_records', 'med_slots', 'med_admin', 'incidents',
  'resident_targets', 'resident_vital_limits', 'daycare_days', 'daycare_attendance', 'daycare_activity_log',
  'daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due', 'daycare_training_due_settings', 'daycare_staffing']

const client = new pg.Client({ connectionString: url })
await client.connect()
pg.types.setTypeParser(1082, (v) => v)
const q = async (text, params) => (await client.query(text, params)).rows
let failed = 0
const ok = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`)
  else { failed++; console.log(`  ✗ ${label}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`) }
}

async function inTx(title, fn) {
  console.log(`── ${title}`)
  await client.query('begin')
  // 自動の記録・取込と同じ「ログインの無いサーバーの接続」（my_tenant() が null）で始める。ログインした人は asUser で真似る
  await client.query(`select set_config('test.tenant', 'none', true)`)
  try {
    await fn()
  } catch (e) {
    failed++
    console.log(`  ✗ 例外: ${e?.code ?? ''} ${e?.message ?? e}`)
  } finally {
    await client.query('rollback')
  }
}

/** 1文を流して、誤りの符号・制約の名前・文を返す（誤りが無ければ code は null）。前後の取引は保つ */
async function tryq(text, params) {
  await client.query('savepoint t')
  try {
    const r = await client.query(text, params)
    await client.query('release savepoint t')
    return { code: null, rowCount: r.rowCount, rows: r.rows }
  } catch (e) {
    await client.query('rollback to savepoint t')
    return { code: e.code ?? 'x', constraint: e.constraint ?? null, message: e.message }
  }
}

/** ログインした人（authenticated）として fn を流す。例外は SQLSTATE で返す */
async function asUser(tenant, role, fn) {
  await client.query('savepoint as_user')
  await client.query(`set local role authenticated`)
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
  await client.query(`select set_config('test.member', 'true', true)`)
  await client.query(`select set_config('test.role', $1, true)`, [role])
  await client.query(`select set_config('test.tenant', $1, true)`, [tenant])
  try {
    const r = await fn()
    await client.query('reset role')
    await client.query('release savepoint as_user')
    return r
  } catch (e) {
    await client.query('rollback to savepoint as_user')
    await client.query('reset role')
    if (typeof e?.code !== 'string') throw e
    return { error: e.code, constraint: e.constraint ?? null }
  }
}

/** 施設 B と、両方の施設の利用者・職員・申し送りを置く（同じ利用者No・同じ職員の名前） */
async function seedTwo() {
  await q(`insert into public.tenants (id, name) values ($1, '見本の施設B') on conflict (id) do nothing`, [B])
  await q(`insert into public.residents (id, source_id, name, active, tenant_id) overriding system value
           values (1101, 'S01', '利用者01', true, $1), (2101, 'S01', '利用者01', true, $2)`, [A, B])
  await q(`insert into public.staff (id, name, tenant_id) overriding system value values (1201, '職員01', $1), (2201, '職員01', $2)`, [A, B])
  await q(`insert into public.notes (id, note_on, shift, facility, category, body, resident_id, tenant_id) overriding system value
           values (1301, '2026-11-01', 'day', 'facility', 'notice', '見本の申し送り', 1101, $1),
                  (2301, '2026-11-01', 'day', 'facility', 'notice', '見本の申し送り', 2101, $2)`, [A, B])
}

// ── 1. 形 ──
await inTx('形: 印が必須・トリガ・76本の組の外部キー・施設ごとの一意', async () => {
  const nn = await q(`select table_name from information_schema.columns
                       where table_schema = 'public' and column_name = 'tenant_id' and is_nullable = 'NO'`)
  ok('27表すべてで施設の印が必須', TABLES.every((t) => nn.some((r) => r.table_name === t)), TABLES.filter((t) => !nn.some((r) => r.table_name === t)))
  const trg = (await q(`select count(*)::int n from pg_trigger where tgname = 'carelog_fill_tenant' and not tgisinternal`))[0].n
  ok('印を入れるトリガは27表のまま', trg === 27, trg)
  const fks = await q(`select k.conname, k.conrelid::regclass::text as child, pg_get_constraintdef(k.oid) as def,
                              k.confupdtype, k.confdeltype, k.confmatchtype, k.condeferrable
                         from pg_constraint k
                        where k.contype = 'f' and k.confrelid in ('public.residents'::regclass, 'public.staff'::regclass, 'public.notes'::regclass)`)
  ok('利用者・職員・申し送りを指す外部キーは76本', fks.length === 76, fks.length)
  ok('76本とも（施設の印, 番号）→（施設の印, id）の組', fks.every((f) => /^FOREIGN KEY \(tenant_id, [a-z_]+\) REFERENCES (residents|staff|notes)\(tenant_id, id\)$/.test(f.def)),
    fks.filter((f) => !/^FOREIGN KEY \(tenant_id, /.test(f.def)).map((f) => f.def))
  ok('消した時・番号を変えた時は NO ACTION・MATCH SIMPLE・遅らせない（前と同じ）',
    fks.every((f) => f.confupdtype === 'a' && f.confdeltype === 'a' && f.confmatchtype === 's' && f.condeferrable === false))
  ok('外部キーの名前は前と同じ（<表>_<列>_fkey）', fks.every((f) => f.conname === `${f.child}_${/\(tenant_id, ([a-z_]+)\)/.exec(f.def)[1]}_fkey`),
    fks.filter((f) => !f.conname.endsWith('_fkey')).map((f) => f.conname))
  const cons = await q(`select conname, pg_get_constraintdef(oid) as def from pg_constraint
                         where conrelid in ('public.residents'::regclass, 'public.staff'::regclass, 'public.vitals'::regclass, 'public.meals'::regclass,
                                            'public.notes'::regclass, 'public.app_settings'::regclass, 'public.import_days'::regclass,
                                            'public.daycare_training_due_settings'::regclass)
                           and contype in ('p', 'u') order by 1`)
  const def = Object.fromEntries(cons.map((c) => [c.conname, c.def]))
  ok('利用者No・職員の名前・取込の印は施設ごと', def.residents_tenant_id_source_id_key === 'UNIQUE (tenant_id, source_id)'
    && def.staff_tenant_id_name_key === 'UNIQUE (tenant_id, name)'
    && ['vitals', 'meals', 'notes'].every((t) => def[`${t}_tenant_id_import_key_key`] === 'UNIQUE (tenant_id, import_key)')
    && !('residents_source_id_key' in def) && !('staff_name_key' in def) && !('vitals_import_key_key' in def), def)
  ok('主キーは同じ名前で施設ごと（旗・取込の日・計画書の規則）', def.app_settings_pkey === 'PRIMARY KEY (tenant_id, key)'
    && def.import_days_pkey === 'PRIMARY KEY (tenant_id, source, day)' && def.daycare_training_due_settings_pkey === 'PRIMARY KEY (tenant_id, id)', def)
  ok('（施設の印, id）の一意（外部キーの先）', ['residents', 'staff', 'notes'].every((t) => def[`${t}_tenant_id_id_key`] === 'UNIQUE (tenant_id, id)'), def)
  const ix = Object.fromEntries((await q(`select indexname, indexdef from pg_indexes where schemaname = 'public'
                                           and indexname in ('uq_attendance_manager_day', 'uq_daycare_days_day')`)).map((r) => [r.indexname, r.indexdef]))
  ok('施設長は1日1人の索引は同じ名前・同じ条件で施設ごと（画面は名前で見分ける）',
    ix.uq_attendance_manager_day === "CREATE UNIQUE INDEX uq_attendance_manager_day ON public.attendance USING btree (tenant_id, day) WHERE ((role = 'manager'::text) AND (sort >= 0))", ix)
  ok('その日の写しは同じ名前で施設ごと', ix.uq_daycare_days_day === 'CREATE UNIQUE INDEX uq_daycare_days_day ON public.daycare_days USING btree (tenant_id, day)', ix)
  const cmt = (await q(`select obj_description('public.uq_attendance_manager_day'::regclass, 'pg_class') as c`))[0].c
  ok('施設長の索引の説明は残る', /日報の施設長は1日1人/.test(cmt ?? ''), cmt)
  const noIx = (await q(`select c.relname from pg_class c
                          where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname = any($1)
                            and not exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                                             where i.indrelid = c.oid and a.attname = 'tenant_id')`, [TABLES])).map((r) => r.relname)
  ok('27表すべてに施設の印で始まる索引がある（段階④の守りのため）', noIx.length === 0, noIx)
  ok('取込の道具は取込の日の衝突の先を主キーの名前で指す（0053 の前でも後でも同じ道具で動く）',
    /on conflict on constraint import_days_pkey do update/.test(IMPORT_TOOL) && !/on conflict \(source, day\)/.test(IMPORT_TOOL))
})

// ── 2. 施設をまたいで同じ値が並ぶ・同じ施設の中では今までどおり止まる ──
await inTx('同じ利用者No・職員の名前・旗・取込の日・写し・規則の1行・施設長・取込の印が、施設 A と B に並んで入る', async () => {
  await seedTwo()
  ok('同じ利用者No（S01）が A と B に1人ずつ', (await q(`select count(*)::int n from public.residents where source_id = 'S01'`))[0].n === 2)
  const r1 = await tryq(`insert into public.residents (source_id, name, active, tenant_id) values ('S01', '利用者02', true, $1)`, [A])
  ok('同じ施設の同じ利用者No は 23505', r1.code === '23505' && r1.constraint === 'residents_tenant_id_source_id_key', r1)
  ok('同じ職員の名前（職員01）が A と B に1人ずつ', (await q(`select count(*)::int n from public.staff where name = '職員01'`))[0].n === 2)
  const s1 = await tryq(`insert into public.staff (name, tenant_id) values ('職員01', $1)`, [B])
  ok('同じ施設の同じ職員の名前は 23505', s1.code === '23505' && s1.constraint === 'staff_tenant_id_name_key', s1)

  const keyA = (await q(`select count(*)::int n from public.app_settings where key = 'input_enabled_bath' and tenant_id = $1`, [A]))[0].n
  const f1 = await tryq(`insert into public.app_settings (key, value, tenant_id) values ('input_enabled_bath', 'true', $1)`, [B])
  ok('旗（input_enabled_bath）は A にあっても B に足せる', keyA === 1 && f1.code === null, { keyA, f1 })
  const f2 = await tryq(`insert into public.app_settings (key, value, tenant_id) values ('input_enabled_bath', 'true', $1)`, [B])
  ok('同じ施設の同じ旗は 23505（app_settings_pkey）', f2.code === '23505' && f2.constraint === 'app_settings_pkey', f2)

  await q(`insert into public.import_days (source, day, src_rows, tenant_id) values ('events', '2026-11-01', 1, $1), ('events', '2026-11-01', 2, $2)`, [A, B])
  const i2 = await tryq(`insert into public.import_days (source, day, src_rows, tenant_id) values ('events', '2026-11-01', 3, $1)`, [A])
  ok('取込の日 (events, 2026-11-01) が A と B に並ぶ・同じ施設の2行目は 23505', i2.code === '23505' && i2.constraint === 'import_days_pkey', i2)

  await q(`insert into public.daycare_days (day, plan_source, plan_rows, tenant_id) values ('2026-11-01', 'none', '[]', $1), ('2026-11-01', 'none', '[]', $2)`, [A, B])
  const d2 = await tryq(`insert into public.daycare_days (day, plan_source, plan_rows, tenant_id) values ('2026-11-01', 'none', '[]', $1)`, [B])
  ok('その日の写しが A と B に1行ずつ・同じ施設の2行目は 23505', d2.code === '23505' && d2.constraint === 'uq_daycare_days_day', d2)

  await q(`delete from public.daycare_training_due_settings`)
  await q(`insert into public.daycare_training_due_settings (id, due_rule, warn_days, tenant_id) values (1, 'calendar', 28, $1), (1, 'days90', 14, $2)`, [A, B])
  const t2 = await tryq(`insert into public.daycare_training_due_settings (id, tenant_id) values (1, $1)`, [A])
  const t3 = await tryq(`insert into public.daycare_training_due_settings (id, tenant_id) values (2, $1)`, [A])
  ok('計画書の規則の1行が A と B に1行ずつ・同じ施設の2行目は 23505・id は今までどおり 1 だけ（23514）',
    t2.code === '23505' && t3.code === '23514', { t2, t3 })

  await q(`insert into public.attendance (day, staff_id, role, sort, tenant_id) values ('2026-11-01', 1201, 'manager', 0, $1), ('2026-11-01', 2201, 'manager', 0, $2)`, [A, B])
  await q(`insert into public.staff (id, name, tenant_id) overriding system value values (1202, '職員02', $1)`, [A])
  const m2 = await tryq(`insert into public.attendance (day, staff_id, role, sort, tenant_id) values ('2026-11-01', 1202, 'manager', 0, $1)`, [A])
  ok('同じ日の施設長が A と B に1人ずつ・同じ施設の2人目は 23505（uq_attendance_manager_day・画面が見分ける名前）',
    m2.code === '23505' && m2.constraint === 'uq_attendance_manager_day', m2)

  for (const [t, cols, vals] of [
    ['vitals', 'resident_id, measured_on, kind, temp', `1101, '2026-11-01', 'recheck', 36.5`],
    ['meals', 'resident_id, meal_on, meal_slot, main_amount', `1101, '2026-11-01', 'breakfast', 10`],
    ['notes', 'note_on, shift, facility, category, body', `'2026-11-01', 'day', 'facility', 'notice', '見本'`],
  ]) {
    const valsB = vals.replace('1101', '2101')
    await q(`insert into public.${t} (${cols}, import_key, tenant_id) values (${vals}, 'syn:k1', $1)`, [A])
    const b1 = await tryq(`insert into public.${t} (${cols}, import_key, tenant_id) values (${valsB}, 'syn:k1', $1)`, [B])
    const a2 = await tryq(`insert into public.${t} (${cols}, import_key, tenant_id) values (${vals.replace("'breakfast'", "'lunch'").replace("'recheck'", "'observation'")}, 'syn:k1', $1)`, [A])
    ok(`取込の印（${t}）が A と B に並ぶ・同じ施設の同じ印は 23505`, b1.code === null && a2.code === '23505' && a2.constraint === `${t}_tenant_id_import_key_key`, { b1, a2 })
  }
})

// ── 3. よその施設を指す記録は止まる ──
await inTx('よその施設の利用者・職員・申し送りを指す記録は 23503 で止まる', async () => {
  await seedTwo()
  const v1 = await tryq(`insert into public.vitals (resident_id, measured_on, kind, temp, tenant_id) values (1101, '2026-11-02', 'recheck', 36.5, $1)`, [B])
  ok('施設 B の記録が施設 A の利用者を指すと 23503（vitals_resident_id_fkey）', v1.code === '23503' && v1.constraint === 'vitals_resident_id_fkey', v1)
  const v2 = await tryq(`insert into public.vitals (resident_id, measured_on, kind, temp, recorded_by, tenant_id) values (2101, '2026-11-02', 'recheck', 36.5, 1201, $1)`, [B])
  ok('施設 B の記録が施設 A の職員を記録者にすると 23503（vitals_recorded_by_fkey）', v2.code === '23503' && v2.constraint === 'vitals_recorded_by_fkey', v2)
  const v3 = await tryq(`insert into public.vitals (resident_id, measured_on, kind, temp, recorded_by, tenant_id) values (2101, '2026-11-02', 'recheck', 36.5, null, $1)`, [B])
  ok('番号が空の列（記録者なし）は今までどおり通る（MATCH SIMPLE）', v3.code === null, v3)
  const n1 = await tryq(`insert into public.note_reads (note_id, staff_id, tenant_id) values (1301, 2201, $1)`, [B])
  ok('施設 B の既読が施設 A の申し送りを指すと 23503（note_reads_note_id_fkey）', n1.code === '23503' && n1.constraint === 'note_reads_note_id_fkey', n1)
  const n2 = await tryq(`insert into public.note_reads (note_id, staff_id, tenant_id) values (2301, 2201, $1)`, [B])
  ok('同じ施設の既読は書ける', n2.code === null, n2)
  const a1 = await tryq(`insert into public.attendance (day, staff_id, role, sort, tenant_id) values ('2026-11-02', 1201, 'staff', 0, $1)`, [B])
  ok('施設 B の出勤者に施設 A の職員は入れられない（attendance_staff_id_fkey）', a1.code === '23503' && a1.constraint === 'attendance_staff_id_fkey', a1)
  const d1 = await tryq(`insert into public.daycare_days (day, plan_source, plan_rows, opened_by, tenant_id) values ('2026-11-02', 'none', '[]', 1201, $1)`, [B])
  ok('施設 B の写しの開所の職員に施設 A の職員は入れられない（daycare_days_opened_by_fkey）', d1.code === '23503' && d1.constraint === 'daycare_days_opened_by_fkey', d1)
  const u1 = await tryq(`update public.vitals set recorded_by = 1201 where resident_id = 2101`)
  ok('書き換えで施設 A の職員を入れても 23503', u1.code === '23503', u1)
  const u2 = await tryq(`update public.residents set tenant_id = $1, source_id = 'S99' where id = 2101`, [A])
  ok('記録のある利用者の施設の印を書き換えると 23503（NO ACTION・前と同じく記録を置き去りにしない）', u2.code === '23503', u2)
  // ログインした人（施設 B の職員）がトリガ任せで施設 A の利用者の記録を足しても止まる
  const viaUser = await asUser(B, 'office', async () =>
    q(`insert into public.vitals (resident_id, measured_on, kind, temp) values (1101, '2026-11-03', 'recheck', 36.5)`))
  ok('施設 B のログインで施設 A の利用者の記録を足すと 23503（印は B・利用者は A）', viaUser?.error === '23503' && viaUser.constraint === 'vitals_resident_id_fkey', viaUser)
  const viaUserOk = await asUser(B, 'office', async () =>
    q(`insert into public.vitals (resident_id, measured_on, kind, temp) values (2101, '2026-11-03', 'recheck', 36.5) returning tenant_id::text as t`))
  ok('施設 B のログインで施設 B の利用者の記録は書ける（印は B）', Array.isArray(viaUserOk) && viaUserOk[0]?.t === B, viaUserOk)
})

// ── 4. 印が決まらない書き込みは止まる ──
await inTx('印が決まらない書き込み（施設が2つ・ログインなし・施設を決めていない）は 23502 で止まる', async () => {
  await seedTwo()
  const e1 = await tryq(`insert into public.app_settings (key, value) values ('x_stage3', 'y')`)
  ok('旗の行は 23502（null のまま入らない）', e1.code === '23502', e1)
  const e2 = await tryq(`insert into public.vitals (resident_id, measured_on, kind, temp) values (1101, '2026-11-02', 'recheck', 36.5)`)
  ok('記録の行も 23502', e2.code === '23502', e2)
  const e3 = await tryq(`insert into public.app_settings (key, value, tenant_id) values ('x_stage3', 'y', null)`)
  ok('施設が2つの時に印を null と書いても 23502', e3.code === '23502', e3)
  await q(`select set_config('carelog.tenant', $1, true)`, [B])
  const e4 = await tryq(`insert into public.app_settings (key, value) values ('x_stage3', 'y') returning tenant_id::text as t`)
  ok('サーバーが施設を決めていれば（carelog.tenant）その施設の印で入る', e4.code === null && e4.rows[0].t === B, e4)
})

// ── 5. 自動の記録・開所・計画書の写し・取込の日が両方の施設で書ける ──
await inTx('計画書の期限の写し（daycare_training_due_sync）は、ログインした人の施設の行だけを読み書きする', async () => {
  await seedTwo()
  await q(`delete from public.daycare_training_due_settings`)
  const rows = JSON.stringify([{ master_id: 'S01', latest_plan_date: '2026-10-01', next_due: '2027-01-01', plan_status: 'reviewed' }])
  const ra = await asUser(A, 'office', async () => (await q(`select public.daycare_training_due_sync($1::jsonb, '{"due_rule":"days90","warn_days":14}'::jsonb, 1201) as r`, [rows]))[0].r)
  ok('施設 A の写しが書ける（1件）', ra?.ok === true && ra.written === 1 && ra.unmatched === 0, ra)
  const rb = await asUser(B, 'office', async () => (await q(`select public.daycare_training_due_sync($1::jsonb, '{"due_rule":"min","warn_days":7}'::jsonb, 2201) as r`, [rows]))[0].r)
  ok('施設 B の写しも書ける（同じ利用者No S01・1件・施設 A の行を取り消さない）', rb?.ok === true && rb.written === 1 && rb.cancelled === 0, rb)
  const due = await q(`select resident_id::int as rid, tenant_id::text as t, deleted_at from public.daycare_training_due order by 1`)
  ok('写しの行は施設ごとに、その施設の利用者で1行ずつ（どちらも生きている）',
    due.length === 2 && due[0].rid === 1101 && due[0].t === A && due[1].rid === 2101 && due[1].t === B && due.every((d) => d.deleted_at === null), due)
  const st = await q(`select tenant_id::text as t, due_rule, warn_days from public.daycare_training_due_settings order by tenant_id`)
  ok('規則の1行も施設ごと（A は days90・14日、B は min・7日）',
    st.length === 2 && st[0].t === A && st[0].due_rule === 'days90' && st[0].warn_days === 14 && st[1].t === B && st[1].due_rule === 'min', st)
  const empty = await asUser(B, 'office', async () => (await q(`select public.daycare_training_due_sync('[]'::jsonb, '{}'::jsonb, 2201) as r`))[0].r)
  ok('空の写しの保護は施設ごとに数える（B に1件あるので empty）', empty?.ok === false && empty.reason === 'empty' && empty.existing === 1, empty)
  const nb = await asUser('none', 'office', async () => (await q(`select public.daycare_training_due_sync($1::jsonb, '{}'::jsonb, null) as r`, [rows]))[0].r)
  ok('施設の分からないログインは 42501（何も読まない）', nb?.error === '42501', nb)
})

await inTx('デイの開所は、同じ日に両方の施設で写しを作る（自動の記録の入口が両方の施設に書くことは tenant-stage2-pg.mjs の1）', async () => {
  await seedTwo()
  const day = (await q(`select to_char((now() at time zone 'Asia/Tokyo')::date, 'YYYY-MM-DD') as d`))[0].d
  const ra = await asUser(A, 'field', async () => (await q(`select public.daycare_open_day($1::date, 1201) as r`, [day]))[0].r)
  const rb = await asUser(B, 'field', async () => (await q(`select public.daycare_open_day($1::date, 2201) as r`, [day]))[0].r)
  ok('施設 A・B とも開所できる（段階③の前は後の施設が 40001 で止まった）', typeof ra?.id === 'number' && typeof rb?.id === 'number' && ra.id !== rb.id, { ra, rb })
  const rx = await asUser(B, 'field', async () => (await q(`select public.daycare_open_day($1::date, 1201) as r`, [day]))[0].r)
  ok('開所の職員によその施設の職員を渡しても、もう写しがあれば今ある写しを返す（書き換えない）', rx?.id === rb.id, rx)
  const days = await q(`select tenant_id::text as t, opened_by::int as by from public.daycare_days where day = $1::date order by tenant_id`, [day])
  ok('写しは施設ごとに1行・開所の職員はその施設の職員', days.length === 2 && days[0].by === 1201 && days[1].by === 2201, days)
})

await inTx('取込の日の書き方（取込の道具と同じ文）は施設 A と B で同じ (source, day) を書ける', async () => {
  await seedTwo()
  const m = /`(insert into import_days[\s\S]*?where import_days\.tenant_id = excluded\.tenant_id)`/.exec(IMPORT_TOOL)
  ok('取込の道具から取込の日の文を読めた', m !== null)
  if (m === null) return
  const sql = m[1]
  const counts = [5, 1, 0, 4, 0, 0]
  const wa = await tryq(sql, ['events', '2026-11-01', ...counts, A])
  const wb = await tryq(sql, ['events', '2026-11-01', ...counts, B])
  const wa2 = await tryq(sql, ['events', '2026-11-01', 9, 0, 1, 8, 0, 0, A])
  ok('A・B とも1行ずつ書け、A の2回目は A の行を書き換える（どれも1行）', wa.rowCount === 1 && wb.rowCount === 1 && wa2.rowCount === 1, { wa, wb, wa2 })
  const rows = await q(`select tenant_id::text as t, src_rows from public.import_days where source = 'events' and day = '2026-11-01' order by tenant_id`)
  ok('A は 9 行・B は 5 行のまま', rows.length === 2 && rows[0].src_rows === 9 && rows[1].src_rows === 5, rows)
})

// ── 6. 施設が1つの時は今と同じ ──
await inTx('施設が1つの時: 止まる時の符号・名前と、衝突の先を名指さない書き込みは今と同じ', async () => {
  await q(`insert into public.residents (id, source_id, name, active) overriding system value values (1101, 'S01', '利用者01', true)`)
  await q(`insert into public.staff (id, name) overriding system value values (1201, '職員01'), (1202, '職員02')`)
  ok('印を付けずに足した行はその施設の印（トリガ）', (await q(`select tenant_id::text t from public.residents where id = 1101`))[0].t === A)
  const r1 = await tryq(`insert into public.residents (source_id, name, active) values ('S01', '利用者02', true)`)
  ok('同じ利用者No は 23505', r1.code === '23505', r1)
  const s1 = await tryq(`insert into public.staff (name) values ('職員01')`)
  ok('同じ職員の名前は 23505', s1.code === '23505', s1)
  const v1 = await tryq(`insert into public.vitals (resident_id, measured_on, kind, temp) values (999999, '2026-11-02', 'recheck', 36.5)`)
  ok('無い利用者を指すと 23503（vitals_resident_id_fkey・名前は前と同じ）', v1.code === '23503' && v1.constraint === 'vitals_resident_id_fkey', v1)
  await q(`insert into public.attendance (day, staff_id, role, sort) values ('2026-11-02', 1201, 'manager', 0)`)
  const m1 = await tryq(`insert into public.attendance (day, staff_id, role, sort) values ('2026-11-02', 1202, 'manager', 0)`)
  ok('同じ日の2人目の施設長は 23505（uq_attendance_manager_day）', m1.code === '23505' && m1.constraint === 'uq_attendance_manager_day', m1)
  const k1 = await tryq(`insert into public.app_settings (key, value) values ('input_enabled_bath', 'zz') on conflict do nothing`)
  ok('旗の on conflict do nothing（衝突の先を名指さない）は今と同じく何もしない', k1.code === null && k1.rowCount === 0, k1)
  const k2 = await tryq(`insert into public.app_settings (key, value) values ('input_enabled_bath', 'true') on conflict (tenant_id, key) do update set value = excluded.value`)
  ok('旗の書き換え（施設と key で衝突）', k2.code === null && k2.rowCount === 1, k2)
  const dd = await tryq(`insert into public.daycare_days (day, plan_source, plan_rows) values ('2026-11-02', 'none', '[]'), ('2026-11-02', 'none', '[]') on conflict do nothing`)
  ok('その日の写しの on conflict do nothing は1行だけ入る（0052 の文と同じ）', dd.code === null && dd.rowCount === 1, dd)
})

// ── 7. 移行の先の確かめ（何も変えずに止まる） ──
const MIG_BODY = MIG.replace(/^begin;$/m, '-- begin').replace(/^commit;$/m, '-- commit')
await inTx('移行の先の確かめ: 印の無い行・よその施設を指す行・名前の違う外部キーがあると、何も変えずに止まる', async () => {
  ok('移行は begin … commit で包んでいる', /^begin;$/m.test(MIG) && /^commit;$/m.test(MIG))
  const again = await tryq(MIG_BODY)
  ok('印の無い行が無い今の形では、もう一度流しても通る（冪等）', again.code === null, again)

  await q(`insert into public.tenants (id, name) values ($1, '見本の施設B')`, [B])
  await q(`alter table public.staff alter column tenant_id drop not null`)
  await q(`insert into public.staff (id, name, tenant_id) overriding system value values (1299, '職員99', null)`)
  const e1 = await tryq(MIG_BODY)
  ok('印の無い行があると表の名前と行数だけを出して止まる', e1.code === 'P0001' && /tenant_stage3: 表 staff に施設の印の無い行が 1 行あります/.test(e1.message), e1)
  ok('止まった時は何も変えない（staff の印は null 可のまま・行も残る）',
    (await q(`select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'staff' and column_name = 'tenant_id'`))[0].is_nullable === 'YES')
  await q(`delete from public.staff where id = 1299`)
  await q(`alter table public.staff alter column tenant_id set not null`)

  // よその施設を指す行（外部キーの確かめを外して作る＝本番に段階③の前から残っている形の真似）
  await q(`insert into public.residents (id, source_id, name, active, tenant_id) overriding system value values (1101, 'S01', '利用者01', true, $1)`, [A])
  await q(`set local session_replication_role = replica`)
  await q(`insert into public.vitals (resident_id, measured_on, kind, temp, tenant_id) values (1101, '2026-11-02', 'recheck', 36.5, $1)`, [B])
  await q(`set local session_replication_role = origin`)
  const e2 = await tryq(MIG_BODY)
  ok('よその施設の利用者を指す行があると止まる', e2.code === 'P0001' && /tenant_stage3: 表 vitals の resident_id が、よその施設の residents を指す行が 1 行あります/.test(e2.message), e2)
  await q(`delete from public.vitals where resident_id = 1101`)

  await q(`alter table public.vitals rename constraint vitals_edited_by_fkey to vitals_edited_by_fkey_x`)
  const e3 = await tryq(MIG_BODY)
  ok('外部キーの名前が違うと止まる（付け直しの対象から漏らさない）', e3.code === 'P0001' && /決まった76本と違います/.test(e3.message), e3)
})

await client.end()
console.log(failed ? `\n失敗 ${failed} 件` : '\nすべて成功')
process.exit(failed === 0 ? 0 : 1)
