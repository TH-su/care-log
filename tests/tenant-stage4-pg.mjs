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

const A = '00000000-0000-0000-0000-0000000000aa'
const B = '00000000-0000-0000-0000-0000000000bb'
const UID = '00000000-0000-0000-0000-000000000001'
const TABLES = ['residents', 'staff', 'vitals', 'meals', 'fluid_intake', 'notes', 'note_reads', 'outings', 'attendance',
  'app_settings', 'import_days', 'master_sync_log', 'record_history', 'bath_records', 'med_slots', 'med_admin', 'incidents',
  'resident_targets', 'resident_vital_limits', 'daycare_days', 'daycare_attendance', 'daycare_activity_log',
  'daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due', 'daycare_training_due_settings', 'daycare_staffing']
const QUAL = '(tenant_id = ( SELECT private.my_tenant() AS my_tenant))'

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
await inTx('移行の先の確かめ・冪等・戻す SQL', async () => {
  ok('移行と戻す SQL は begin … commit で包んでいる', /^begin;$/m.test(MIG) && /^commit;$/m.test(MIG) && /^begin;$/m.test(BACK) && /^commit;$/m.test(BACK))
  ok('移行と戻す SQL は do $$ を使わない', !/^\s*do\s+\$\$/im.test(MIG) && !/^\s*do\s+\$\$/im.test(BACK))
  const again = await tryq(MIG_BODY)
  const n1 = (await q(`select count(*)::int n from pg_policies where schemaname = 'public' and policyname = 'tenant_only'`))[0].n
  ok('もう一度流しても通り、守りは27本のまま（冪等）', again.code === null && n1 === 27, { again, n1 })
  ok('最後の確かめの3行が全部 ok', again.rows?.length === 3 && again.rows.every((r) => r.result === 'ok'), again.rows)

  const back = await tryq(BACK_BODY)
  const n0 = (await q(`select count(*)::int n from pg_policies where schemaname = 'public' and policyname = 'tenant_only'`))[0].n
  const kept = (await q(`select count(*)::int n from pg_policies where schemaname = 'public' and tablename = any($1)`, [TABLES]))[0].n
  ok('戻す SQL で27本とも外れ、今の102件は残る', back.code === null && n0 === 0 && kept === 102, { back: back.code, n0, kept })
  ok('戻す SQL の確かめは ok と施設の数', back.rows?.[0]?.result === 'ok' && back.rows?.[1]?.result === '1', back.rows)
  const re = await tryq(MIG_BODY)
  ok('戻した後にもう一度入る', re.code === null && (await q(`select count(*)::int n from pg_policies where policyname = 'tenant_only'`))[0].n === 27, re)

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
