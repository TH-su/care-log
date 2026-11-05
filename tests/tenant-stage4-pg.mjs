// 0054（施設の印の段階4）を、素の Postgres（0001〜最新を適用済み）で確かめる実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/tenant-stage4-pg.mjs
//
// 施設 A（試験の土台の施設 aa）と施設 B（この試験で足す bb）で確かめる:
//   1. 形: 27表に守り tenant_only（restrictive・ログインした人の全部の操作・自分の施設の印だけ）が1本ずつ・今の守り102件はそのまま
//   2. 読む: 施設 A の人は施設 A の行だけ、施設 B の人は施設 B の行だけが見える（27表とも）。サーバーの接続は全部見える
//   3. 足す: 印を送らなければ自分の施設の印が入る。よその施設の印を送ると 42501 で止まる
//   4. 直す・消す: よその施設の行は直せない（0行）。自分の行をよその施設へ移すと 42501。消す守りは今までどおり無い・旗は職員が直せないまま
//   5. 履歴の記録（特別な権限のトリガ）はその行の施設の印で残り、よその施設の人には見えない
//   6. 施設が1つの時の動きは今と同じ（印を送らずに書く・読む）
//   7. 移行の先の確かめ（守りが無い表・member_only が無い表があると何も変えずに止まる）・冪等・戻す SQL で外れて、もう一度入る
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
const MIG = readFileSync(path.join(ROOT, 'supabase', 'migrations', '0054_tenant_stage4.sql'), 'utf8')
const BACK = readFileSync(path.join(ROOT, 'supabase', 'rollback', '0054_back.sql'), 'utf8')
// 0055（冪等キーの一意を施設ごと）は 0054 の上に入るので、0054 を戻す前に 0055 を戻す（0054_back.sql は 0055 があると止まる）
const BACK55 = readFileSync(path.join(ROOT, 'supabase', 'rollback', '0055_back.sql'), 'utf8')

const A = '00000000-0000-0000-0000-0000000000aa'
const B = '00000000-0000-0000-0000-0000000000bb'
const UID = '00000000-0000-0000-0000-000000000001'
const TABLES = ['residents', 'staff', 'vitals', 'meals', 'fluid_intake', 'notes', 'note_reads', 'outings', 'attendance',
  'app_settings', 'import_days', 'master_sync_log', 'record_history', 'bath_records', 'med_slots', 'med_admin', 'incidents',
  'resident_targets', 'resident_vital_limits', 'daycare_days', 'daycare_attendance', 'daycare_activity_log',
  'daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due', 'daycare_training_due_settings', 'daycare_staffing']
const QUAL = '(tenant_id = ( SELECT private.my_tenant() AS my_tenant))'
const CELL_SRC_SQL = `select prosrc as src from pg_proc where oid = 'public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure`
/** 0054 の前の欄ごとの保存の本文（2か所の衝突の先から施設の印を外した形）。今の本文から作る＝置き換えが2か所だけかを確かめる */
const cellUndo = (src) => src
  .replace("on conflict (tenant_id, resident_id, measured_on) where kind = 'routine'", "on conflict (resident_id, measured_on) where kind = 'routine'")
  .replace('on conflict (tenant_id, resident_id, meal_on, meal_slot) where', 'on conflict (resident_id, meal_on, meal_slot) where')
  .replace('on conflict (tenant_id, client_key) do nothing', 'on conflict (client_key) do nothing') // 0055 の分
let CELL_BEFORE = ''
const UQ_NAMES = ['uq_vitals_routine_day', 'uq_meals_slot', 'uq_bath_records_day', 'uq_med_admin_slot', 'uq_med_slots_resident',
  'uq_resident_targets_resident', 'uq_resident_vital_limits', 'uq_daycare_attendance_day', 'uq_daycare_activity',
  'uq_daycare_training_session', 'uq_daycare_home_visit', 'uq_daycare_training_due', 'uq_daycare_staffing', 'attendance_pkey', 'note_reads_pkey']
const UQ_DEFS_SQL = `select i.relname as name, pg_get_indexdef(i.oid) as def from pg_class i
                      where i.relnamespace = 'public'::regnamespace and i.relkind = 'i'
                        and i.relname in (${UQ_NAMES.map((n) => `'${n}'`).join(', ')}) order by 1`

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

/** 1文を流して、誤りの符号・文を返す（誤りが無ければ code は null）。前後の取引は保つ */
async function tryq(text, params) {
  await client.query('savepoint t')
  try {
    const res = await client.query(text, params)
    await client.query('release savepoint t')
    const r = Array.isArray(res) ? res[res.length - 1] : res // 何文も流した時は最後の文（確かめの行）
    return { code: null, rowCount: r.rowCount, rows: r.rows }
  } catch (e) {
    await client.query('rollback to savepoint t')
    return { code: e.code ?? 'x', message: e.message }
  }
}

/** ログインした人（authenticated）として fn を流す。例外は SQLSTATE で返す。終わったらサーバーの接続（施設なし）に戻す */
async function asUser(tenant, fn, role = 'office') {
  await client.query('savepoint as_user')
  await client.query(`set local role authenticated`)
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
  await client.query(`select set_config('test.member', 'true', true)`)
  await client.query(`select set_config('test.role', $1, true)`, [role])
  await client.query(`select set_config('test.tenant', $1, true)`, [tenant])
  const back = async () => {
    await client.query('reset role')
    await client.query(`select set_config('test.tenant', 'none', true)`)
  }
  try {
    const r = await fn()
    await back()
    await client.query('release savepoint as_user')
    return r
  } catch (e) {
    await client.query('rollback to savepoint as_user')
    await back()
    if (typeof e?.code !== 'string') throw e
    return { error: e.code }
  }
}

/** 施設 B と、両方の施設の利用者・職員・申し送り・バイタル・旗・その日の写しを置く（同じ利用者No・同じ職員の名前・同じ旗の key） */
async function seedTwo() {
  await q(`insert into public.tenants (id, name) values ($1, '見本の施設B') on conflict (id) do nothing`, [B])
  await q(`insert into public.residents (id, source_id, name, active, tenant_id) overriding system value
           values (1101, 'S01', '利用者01', true, $1), (2101, 'S01', '利用者01', true, $2)`, [A, B])
  await q(`insert into public.staff (id, name, tenant_id) overriding system value values (1201, '職員01', $1), (2201, '職員01', $2)`, [A, B])
  await q(`insert into public.notes (id, note_on, shift, facility, category, body, resident_id, tenant_id) overriding system value
           values (1301, '2026-11-01', 'day', 'facility', 'notice', '見本の申し送り', 1101, $1),
                  (2301, '2026-11-01', 'day', 'facility', 'notice', '見本の申し送り', 2101, $2)`, [A, B])
  await q(`insert into public.vitals (id, resident_id, measured_on, kind, temp, tenant_id) overriding system value
           values (1401, 1101, '2026-11-01', 'recheck', 36.5, $1), (2401, 2101, '2026-11-01', 'recheck', 36.6, $2)`, [A, B])
  await q(`insert into public.app_settings (key, value, tenant_id) values ('stage4_probe', 'a', $1), ('stage4_probe', 'b', $2)`, [A, B])
  await q(`insert into public.daycare_days (day, plan_source, plan_rows, tenant_id) values ('2026-11-01', 'none', '[]', $1), ('2026-11-01', 'none', '[]', $2)`, [A, B])
}

/** 27表それぞれで、見える行の施設の印の内訳（{表: {施設: 行数}}） */
async function visibleByTenant() {
  const out = {}
  for (const t of TABLES) {
    const rows = await q(`select tenant_id::text t, count(*)::int n from public.${t} group by 1`)
    out[t] = Object.fromEntries(rows.map((r) => [r.t, r.n]))
  }
  return out
}

// ── 1. 形 ──
await inTx('形: 27表に自分の施設の行だけの守りが1本ずつ・今の守りはそのまま', async () => {
  const pol = await q(`select tablename, permissive, cmd, roles::text roles, qual, with_check from pg_policies
                        where schemaname = 'public' and policyname = 'tenant_only' order by tablename`)
  ok('tenant_only は27表とも1本ずつ（ほかの表には無い）', pol.length === 27 && TABLES.every((t) => pol.some((p) => p.tablename === t)), pol.map((p) => p.tablename))
  ok('restrictive・全部の操作・ログインした人（authenticated）だけ',
    pol.every((p) => p.permissive === 'RESTRICTIVE' && p.cmd === 'ALL' && p.roles === '{authenticated}'), pol)
  ok('読む・書くとも「施設の印 = ログインした人の施設」（1回だけ調べる形）', pol.every((p) => p.qual === QUAL && p.with_check === QUAL), pol.map((p) => [p.qual, p.with_check]))
  const others = (await q(`select count(*)::int n from pg_policies where schemaname = 'public' and tablename = any($1) and policyname <> 'tenant_only'`, [TABLES]))[0].n
  ok('今の守り（tenant_only 以外）は102件のまま', others === 102, others)
  const del = (await q(`select count(*)::int n from pg_policies where schemaname = 'public' and tablename = any($1) and cmd = 'DELETE'`, [TABLES]))[0].n
  ok('消す守りは今までどおり無い（tenant_only は restrictive なので消す許しを足さない）', del === 0, del)
  const uq = await q(UQ_DEFS_SQL)
  ok('自然キーの一意13本と出勤者・既読の主キーは、名前と条件はそのまま頭に施設の印', uq.length === 15 && uq.every((r) => /USING btree \(tenant_id, /.test(r.def)), uq)
  ok('一意の条件（削除済みを除く・定時だけ・頓服を除く）は残っている',
    uq.find((r) => r.name === 'uq_vitals_routine_day')?.def.endsWith("WHERE ((kind = 'routine'::text) AND (deleted_at IS NULL))")
    && uq.find((r) => r.name === 'uq_med_admin_slot')?.def.endsWith("WHERE ((deleted_at IS NULL) AND (slot <> 'prn'::text))"), uq)
  const cell = (await q(CELL_SRC_SQL))[0].src
  CELL_BEFORE = cellUndo(cell)
  const n = (re) => (cell.match(re) || []).length
  ok('欄ごとの保存は、衝突の先2か所だけが施設の印つき（列で名指す衝突の先はほかに無い）',
    n(/on conflict \(tenant_id, resident_id, measured_on\) where kind = 'routine' and deleted_at is null do nothing/g) === 1
    && n(/on conflict \(tenant_id, resident_id, meal_on, meal_slot\) where deleted_at is null do nothing/g) === 1
    && n(/on conflict \(resident_id/g) === 0 && CELL_BEFORE !== cell)
  const left = await q(`select i.relname from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class c on c.oid = x.indrelid
                         where x.indisunique and c.relnamespace = 'public'::regnamespace and c.relname = any($1)
                           and pg_get_indexdef(i.oid) !~ '\\(tenant_id' and pg_get_indexdef(i.oid) !~ '\\((id|client_key)\\)'`, [TABLES])
  ok('施設の印の無い一意は、番号（id）と端末の冪等キー（client_key）だけ', left.length === 0, left)
})

// ── 1b. 誤りの種類で、よその施設の記録の有る無しを当てられない（2026-11-05 反証レビュー 中1）──
await inTx('誤りの種類: よその施設の利用者の番号で足すと、記録の有る無しに関係なく 23503', async () => {
  await seedTwo()
  await q(`insert into public.vitals (resident_id, measured_on, kind, temp, tenant_id) values (2101, '2026-11-03', 'routine', 36.6, $1)`, [B])
  await q(`insert into public.attendance (day, staff_id, role, sort, tenant_id) values ('2026-11-03', 2201, 'staff', 0, $1)`, [B])
  const has = await asUser(A, () => q(`insert into public.vitals (resident_id, measured_on, kind, temp) values (2101, '2026-11-03', 'routine', 36.4)`))
  const none = await asUser(A, () => q(`insert into public.vitals (resident_id, measured_on, kind, temp) values (2101, '2026-11-04', 'routine', 36.4)`))
  ok('施設 B にその日の定時のバイタルがあっても無くても、施設 A の人には同じ 23503', has.error === '23503' && none.error === '23503', { has, none })
  const att = await asUser(A, () => q(`insert into public.attendance (day, staff_id, role, sort) values ('2026-11-03', 2201, 'staff', 0)`))
  ok('施設 B の職員の出勤日でも 23503（出勤者の主キーで 23505 にならない）', att.error === '23503', att)
  await q(`insert into public.vitals (resident_id, measured_on, kind, temp, tenant_id) values (1101, '2026-11-03', 'routine', 36.6, $1)`, [A])
  const dupA = await asUser(A, () => q(`insert into public.vitals (resident_id, measured_on, kind, temp) values (1101, '2026-11-03', 'routine', 36.4)`))
  ok('自分の施設の中では今までどおり 23505（定時は1人1日1件）', dupA.error === '23505', dupA)
  const dupB = await tryq(`insert into public.note_reads (note_id, staff_id, tenant_id) values (2301, 2201, $1), (2301, 2201, $1)`, [B])
  ok('同じ既読の2回目は今までどおり 23505（既読の主キー）', dupB.code === '23505', dupB)
})

// ── 2. 読む ──
await inTx('読む: 自分の施設の行だけが見える（27表とも）・サーバーの接続は全部見える', async () => {
  await seedTwo()
  const va = await asUser(A, visibleByTenant)
  const vb = await asUser(B, visibleByTenant)
  ok('施設 A の人には、27表のどれにも施設 B の行が見えない', !va.error && TABLES.every((t) => !(B in va[t])), va)
  ok('施設 B の人には、27表のどれにも施設 A の行が見えない', !vb.error && TABLES.every((t) => !(A in vb[t])), vb)
  ok('施設 A の人には自分の行が見える（利用者・職員・申し送り・バイタル・旗・その日の写し）',
    ['residents', 'staff', 'notes', 'vitals', 'app_settings', 'daycare_days'].every((t) => va[t][A] >= 1), va)
  ok('施設 B の人にも自分の行が見える', ['residents', 'staff', 'notes', 'vitals', 'app_settings', 'daycare_days'].every((t) => vb[t][B] >= 1), vb)
  const flag = await asUser(A, () => q(`select value from public.app_settings where key = 'stage4_probe'`))
  ok('同じ key の旗を key だけで読んでも自分の施設の1行だけ（画面の .eq(key).limit(1) の形）', flag.length === 1 && flag[0].value === 'a', flag)
  const byId = await asUser(A, () => q(`select id from public.residents where id = 2101`))
  ok('よその施設の利用者を番号で指しても見えない', byId.length === 0, byId)
  const srv = await visibleByTenant()
  ok('サーバーの接続（自動の記録・取込）は両方の施設の行が見える（守りを通らない）', srv.residents[A] >= 1 && srv.residents[B] >= 1)
  const out = await asUser(A, async () => {
    await client.query(`select set_config('test.member', 'false', true)`)
    return q(`select count(*)::int n from public.residents`)
  })
  ok('許可リストに無い人は今までどおり何も見えない', out[0]?.n === 0, out)
  const none = await asUser('none', () => q(`select count(*)::int n from public.residents`))
  ok('施設の決まらないログインの人には何も見えない', none[0]?.n === 0, none)
})

// ── 3. 足す ──
await inTx('足す: 印を送らなければ自分の施設・よその施設の印は 42501', async () => {
  await seedTwo()
  const ins = await asUser(B, () => q(`insert into public.vitals (resident_id, measured_on, kind, temp) values (2101, '2026-11-02', 'recheck', 36.4) returning tenant_id::text t`))
  ok('施設 B の人が印を送らずに足すと、施設 B の印が入る', ins[0]?.t === B, ins)
  const cross = await asUser(A, () => q(`insert into public.vitals (resident_id, measured_on, kind, temp, tenant_id) values (2101, '2026-11-02', 'recheck', 36.4, '${B}')`))
  ok('施設 A の人がよその施設の印を送ると 42501', cross.error === '42501', cross)
  const own = await asUser(A, () => q(`insert into public.import_days (source, day) values ('stage4', '2026-11-02') returning tenant_id::text t`))
  ok('取込の日（外部キーの無い表・事務所が書ける）も、印を送らなければ自分の施設', own[0]?.t === A, own)
  const crossDay = await asUser(A, () => q(`insert into public.import_days (source, day, tenant_id) values ('stage4', '2026-11-03', '${B}')`))
  ok('取込の日でも、よその施設の印を送ると 42501', crossDay.error === '42501', crossDay)
  // 止まったのが段階4の守りのせいかを確かめる（その表の tenant_only を外すと同じ文が通る＝ほかの守りでは止まっていない）
  await q(`drop policy tenant_only on public.import_days`)
  const ctl = await asUser(A, () => q(`insert into public.import_days (source, day, tenant_id) values ('stage4', '2026-11-03', '${B}') returning 1`))
  ok('（対照）tenant_only を外すと同じ文が通る＝止めていたのは段階4の守り', Array.isArray(ctl) && ctl.length === 1, ctl)
  await q(`drop policy tenant_only on public.vitals`)
  const ctlV = await asUser(A, () => q(`insert into public.vitals (resident_id, measured_on, kind, temp, tenant_id) values (2101, '2026-11-02', 'recheck', 36.4, '${B}') returning 1`))
  ok('（対照）バイタルも tenant_only を外すと通る＝止めていたのは段階4の守り', Array.isArray(ctlV) && ctlV.length === 1, ctlV)
  const other = await asUser(A, () => q(`insert into public.vitals (resident_id, measured_on, kind, temp) values (2101, '2026-11-02', 'recheck', 36.4)`))
  ok('よその施設の利用者の番号で足すと止まる（自分の施設にその利用者はいない＝23503）', other.error === '23503', other)
})

// ── 4. 直す・消す ──
await inTx('直す・消す: よその施設の行は直せない・自分の行をよその施設へ移せない', async () => {
  await seedTwo()
  const upd = await asUser(A, async () => (await client.query(`update public.vitals set temp = 37.0 where id = 2401`)).rowCount)
  ok('施設 A の人が施設 B のバイタルを直すと0行', upd === 0, upd)
  ok('施設 B のバイタルは変わらない', (await q(`select temp::text t from public.vitals where id = 2401`))[0].t === '36.6')
  const both = await asUser(A, async () => (await client.query(`update public.vitals set temp = 36.9 where id in (1401, 2401)`)).rowCount)
  ok('両方の施設の番号を指して直しても、自分の施設の1行だけ', both === 1, both)
  ok('施設 B のバイタルは変わらない（2回目）', (await q(`select temp::text t from public.vitals where id = 2401`))[0].t === '36.6')
  const move = await asUser(A, () => q(`update public.vitals set tenant_id = '${B}', resident_id = 2101 where id = 1401`))
  ok('自分の行をよその施設の印へ移すと 42501', move.error === '42501', move)
  const flagUpd = await asUser(A, () => q(`update public.app_settings set value = 'zz' where key = 'stage4_probe'`))
  ok('旗は今までどおり職員の画面からは直せない（施設 B の旗も変わらない）',
    flagUpd.error === '42501' && (await q(`select value from public.app_settings where key = 'stage4_probe' and tenant_id = $1`, [B]))[0].value === 'b', flagUpd)
  const del = await asUser(A, async () => (await client.query(`delete from public.notes where id in (1301, 2301)`)).rowCount)
  ok('消す守りは無いので、自分の施設の行も消せない（今までどおり0行）', del === 0, del)
})

// ── 5. 履歴の記録 ──
await inTx('履歴の記録: その行の施設の印で残り、よその施設の人には見えない', async () => {
  await seedTwo()
  const upd = await asUser(B, async () => (await client.query(`update public.vitals set temp = 37.1 where id = 2401`)).rowCount)
  ok('施設 B の人が自分のバイタルを直せる', upd === 1, upd)
  const h = await q(`select tenant_id::text t from public.record_history where table_name = 'vitals' and row_id = 2401`)
  ok('直した履歴は施設 B の印で残る', h.length >= 1 && h.every((r) => r.t === B), h)
  const seeA = await asUser(A, () => q(`select count(*)::int n from public.record_history where row_id = 2401`))
  const seeB = await asUser(B, () => q(`select count(*)::int n from public.record_history where row_id = 2401`))
  ok('施設 A の人には施設 B の履歴が見えない・施設 B の人には見える', seeA[0]?.n === 0 && seeB[0]?.n >= 1, { seeA, seeB })
})

// ── 6. 施設が1つの時 ──
await inTx('施設が1つの時: 印を送らずに書く・読むのは今と同じ', async () => {
  await q(`insert into public.residents (id, source_id, name, active) overriding system value values (1101, 'S01', '利用者01', true)`)
  const r = await asUser(A, async () => {
    await client.query(`insert into public.vitals (resident_id, measured_on, kind, temp) values (1101, '2026-11-02', 'recheck', 36.5)`)
    const n = (await client.query(`update public.vitals set temp = 36.7 where resident_id = 1101`)).rowCount
    const rows = (await client.query(`select temp::text t, tenant_id::text tid from public.vitals where resident_id = 1101`)).rows
    return { n, rows }
  })
  ok('足す・直す・読むが通り、施設の印は自動で入る', r.n === 1 && r.rows.length === 1 && r.rows[0].t === '36.7' && r.rows[0].tid === A, r)
  const field = await asUser(A, () => q(`select count(*)::int n from public.residents`), 'field')
  ok('現場の役割の人も自分の施設の利用者が見える（役割で読む範囲は変えない）', field[0]?.n === 1, field)
})

// ── 7. 移行の先の確かめ・冪等・戻す ──
const MIG_BODY = MIG.replace(/^begin;$/m, '-- begin').replace(/^commit;$/m, '-- commit')
const BACK_BODY = BACK.replace(/^begin;$/m, '-- begin').replace(/^commit;$/m, '-- commit')
const BACK55_BODY = BACK55.replace(/^begin;$/gm, '-- begin').replace(/^commit;$/gm, '-- commit')
await inTx('移行の先の確かめ・冪等・戻す SQL', async () => {
  ok('移行と戻す SQL は begin … commit で包んでいる', /^begin;$/m.test(MIG) && /^commit;$/m.test(MIG) && /^begin;$/m.test(BACK) && /^commit;$/m.test(BACK))
  ok('移行と戻す SQL は do $$ を使わない', !/^\s*do\s+\$\$/im.test(MIG) && !/^\s*do\s+\$\$/im.test(BACK))
  const first = await q(UQ_DEFS_SQL)
  const again = await tryq(MIG_BODY)
  const n1 = (await q(`select count(*)::int n from pg_policies where schemaname = 'public' and policyname = 'tenant_only'`))[0].n
  ok('もう一度流しても通り、守りは27本のまま（冪等）', again.code === null && n1 === 27, { again, n1 })
  ok('最後の確かめの6行が全部 ok・7行目は知らせ（施設の数・利用者のいない施設の数＝許可リストの表の無い土台では -）',
    again.rows?.length === 7 && again.rows.slice(0, 6).every((r) => r.result === 'ok') && again.rows[6].result === '1・-', again.rows)

  const guard = await tryq(BACK_BODY)
  ok('0055 が入っている間は、0054 を戻す SQL は何も変えずに止まる（先に 0055 を戻す）',
    guard.code === 'P0001' && /0055 が入っています/.test(guard.message)
    && (await q(`select count(*)::int n from pg_policies where policyname = 'tenant_only'`))[0].n === 27, guard)
  const b55 = await tryq(BACK55_BODY)
  ok('（前提）0055 を戻す', b55.code === null && b55.rows?.every((r) => r.result === 'ok'), b55)
  const back = await tryq(BACK_BODY)
  const n0 = (await q(`select count(*)::int n from pg_policies where schemaname = 'public' and policyname = 'tenant_only'`))[0].n
  const kept = (await q(`select count(*)::int n from pg_policies where schemaname = 'public' and tablename = any($1)`, [TABLES]))[0].n
  ok('戻す SQL で27本とも外れ、今の102件は残る', back.code === null && n0 === 0 && kept === 102, { back: back.code, n0, kept })
  ok('戻す SQL の確かめは ok・ok・ok と施設の数', back.rows?.length === 4 && back.rows.slice(0, 3).every((r) => r.result === 'ok') && back.rows[3].result === '1', back.rows)
  const cellBack = (await q(CELL_SRC_SQL))[0].src
  ok('戻すと欄ごとの保存の本文は 0053 の後と一字一句同じ', cellBack === CELL_BEFORE, { len: cellBack.length })
  const after = await q(UQ_DEFS_SQL)
  ok('戻すと一意15本は 0053 の後の形（施設の印の無い形・名前と条件は同じ）', after.every((r) => !/USING btree \(tenant_id, /.test(r.def)) && after.length === 15, after)
  const re = await tryq(MIG_BODY)
  ok('もう一度入れた後の一意15本は、最初に入れた時と一字一句同じ', JSON.stringify(await q(UQ_DEFS_SQL)) === JSON.stringify(first), { first })
  ok('戻した後にもう一度入る', re.code === null && (await q(`select count(*)::int n from pg_policies where policyname = 'tenant_only'`))[0].n === 27, re)

  await q(`create policy stage4_extra on public.notes for select to authenticated using (true)`)
  const e0 = await tryq(MIG_BODY)
  ok('今の守りが102件でないと止まる（足された守りを先に確かめる）', e0.code === 'P0001' && /102件ではない/.test(e0.message), e0)
  await q(`drop policy stage4_extra on public.notes`)
  await q(`drop index public.uq_meals_slot`)
  await q(`create unique index uq_meals_slot on public.meals (resident_id, meal_on) where deleted_at is null`)
  const e00 = await tryq(MIG_BODY)
  ok('一意の形が思っていたものと違うと、名前だけを出して止まる', e00.code === 'P0001' && /一意 uq_meals_slot の形が思っていたものと違います/.test(e00.message), e00)
  await q(`drop index public.uq_meals_slot`)
  await q(`create unique index uq_meals_slot on public.meals (tenant_id, resident_id, meal_on, meal_slot) where deleted_at is null`)
  await q(`drop policy member_only on public.outings`)
  const e1 = await tryq(MIG_BODY)
  ok('許可リストの守りが無い表があると、表の名前だけを出して止まる', e1.code === 'P0001' && /tenant_stage4: .*outings（許可リストの守り member_only が無い）/.test(e1.message), e1)

  await q(`alter table public.meals disable row level security`)
  await q(`drop policy tenant_only on public.vitals`)
  const e2 = await tryq(MIG_BODY)
  ok('守りの入っていない表があると止まり、何も変えない（vitals の守りは外れたまま）',
    e2.code === 'P0001' && /meals（守りが入っていない）/.test(e2.message)
    && (await q(`select count(*)::int n from pg_policies where tablename = 'vitals' and policyname = 'tenant_only'`))[0].n === 0, e2)
})

await client.end()
console.log(failed ? `\n失敗 ${failed} 件` : '\nすべて成功')
process.exit(failed === 0 ? 0 : 1)
