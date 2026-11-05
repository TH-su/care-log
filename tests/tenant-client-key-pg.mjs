// 0055（冪等キーの一意を施設ごとにする）を、素の Postgres（0001〜最新を適用済み）で確かめる実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/tenant-client-key-pg.mjs
//
// 施設 A（試験の土台の施設 aa）と施設 B（この試験で足す bb）で確かめる:
//   1. 形: 15表の client_key の一意の頭が施設の印（名前は同じ・制約は制約のまま）・欄ごとの保存の衝突の先が施設の印つき
//   2. よその施設の自動の記録のキー（決まった形）を使って足しても 23505 にならない＝有る無しを当てられない・
//      先回りして入れても、よその施設の自動の記録（on conflict do nothing）は止まらない（2026-11-05 反証レビュー2巡目 中1）
//   3. 同じ施設の中では今までどおり同じキーは 23505・欄ごとの保存の冪等（同じキーの2回目は1行のまま）
//   4. 冪等・戻す SQL で 0054 の後の形へ戻り、もう一度入る・先の確かめで止まる
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
const MIG = readFileSync(path.join(ROOT, 'supabase', 'migrations', '0055_tenant_client_key.sql'), 'utf8')
const BACK = readFileSync(path.join(ROOT, 'supabase', 'rollback', '0055_back.sql'), 'utf8')

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

const CK = [['bath_records', 'bath_records_client_key_key'], ['daycare_activity_log', 'daycare_activity_log_client_key_key'],
  ['daycare_attendance', 'daycare_attendance_client_key_key'], ['daycare_home_visits', 'daycare_home_visits_client_key_key'],
  ['daycare_staffing', 'daycare_staffing_client_key_key'], ['daycare_training_sessions', 'daycare_training_sessions_client_key_key'],
  ['incidents', 'incidents_client_key_key'], ['med_admin', 'med_admin_client_key_key'], ['med_slots', 'med_slots_client_key_key'],
  ['resident_targets', 'resident_targets_client_key_key'], ['resident_vital_limits', 'resident_vital_limits_client_key_key'],
  ['fluid_intake', 'uq_fluid_client_key'], ['notes', 'uq_notes_client_key'], ['outings', 'uq_outings_client_key'], ['vitals', 'uq_vitals_client_key']]
const CK_SQL = `select i.relname as name, pg_get_indexdef(i.oid) as def,
                       exists (select 1 from pg_constraint k where k.conindid = i.oid and k.contype = 'u') as con
                  from pg_class i where i.relnamespace = 'public'::regnamespace and i.relkind = 'i'
                   and i.relname in (${CK.map(([, n]) => `'${n}'`).join(', ')}) order by 1`
const CELL_SQL = `select prosrc as src from pg_proc where oid = 'public.apply_cell_edits(text, jsonb, jsonb, jsonb, bigint, text)'::regprocedure`

// ── 1. 形 ──
await inTx('形: 冪等キーの一意15本の頭が施設の印・欄ごとの保存の衝突の先', async () => {
  const ck = await q(CK_SQL)
  ok('15本とも (tenant_id, client_key)・名前は同じ', ck.length === 15 && CK.every(([t, n]) => ck.find((r) => r.name === n)?.def === `CREATE UNIQUE INDEX ${n} ON public.${t} USING btree (tenant_id, client_key)`), ck)
  ok('一意の制約だった11本は制約のまま・索引だった4本は索引のまま', ck.filter((r) => r.con).length === 11 && ck.filter((r) => r.name.startsWith('uq_')).every((r) => !r.con), ck)
  const cell = (await q(CELL_SQL))[0].src
  ok('欄ごとの保存は on conflict (tenant_id, client_key) が1か所・施設の印の無い冪等キーの衝突の先は無い',
    (cell.match(/on conflict \(tenant_id, client_key\) do nothing/g) || []).length === 1 && !/on conflict \(client_key\)/.test(cell))
})

// ── 2. よその施設の自動の記録のキー ──
await inTx('よその施設の自動の記録のキー: 有る無しを当てられない・先回りしても止められない', async () => {
  await seedTwo()
  const kB = 'auto:med:2026-11-03:morning:2101'
  await q(`insert into public.med_admin (resident_id, admin_on, slot, status, auto, client_key, tenant_id) values (2101, '2026-11-03', 'morning', 'taken', true, $1, $2)`, [kB, B])
  const guess = await asUser(A, () => q(`insert into public.med_admin (resident_id, admin_on, slot, status, client_key) values (1101, '2026-11-03', 'morning', 'taken', $1) returning tenant_id::text t`, [kB]))
  ok('施設 A の人が施設 B の自動の記録のキーで自分の行を足しても 23505 にならない（有る無しが分からない）', Array.isArray(guess) && guess[0]?.t === A, guess)
  const kB2 = 'auto:med:2026-11-04:morning:2101'
  const pre = await asUser(A, () => q(`insert into public.med_admin (resident_id, admin_on, slot, status, client_key) values (1101, '2026-11-04', 'morning', 'taken', $1) returning 1`, [kB2]))
  ok('（前提）施設 A の人が施設 B の先の日のキーを先に入れておける', Array.isArray(pre) && pre.length === 1, pre)
  const auto = await tryq(`insert into public.med_admin (resident_id, admin_on, slot, status, auto, client_key, tenant_id) values (2101, '2026-11-04', 'morning', 'taken', true, $1, $2) on conflict do nothing`, [kB2, B])
  ok('施設 B の自動の記録（on conflict do nothing）は、先回りされても作られる', auto.code === null && auto.rowCount === 1, auto)
  const dup = await tryq(`insert into public.med_admin (resident_id, admin_on, slot, status, client_key, tenant_id) values (1101, '2026-11-05', 'noon', 'taken', $1, $2)`, [kB, A])
  ok('同じ施設の中では今までどおり同じキーは 23505（med_admin_client_key_key・名前は同じ）', dup.code === '23505' && /med_admin_client_key_key/.test(dup.message), dup)
  const v1 = await asUser(A, () => q(`insert into public.vitals (resident_id, measured_on, kind, temp, client_key) values (1101, '2026-11-03', 'observation', 36.5, 'q1-abc') returning 1`))
  const v2 = await asUser(B, () => q(`insert into public.vitals (resident_id, measured_on, kind, temp, client_key) values (2101, '2026-11-03', 'observation', 36.5, 'q1-abc') returning 1`))
  ok('端末のキーがたまたま同じでも、施設が違えば両方入る（索引だった4本も施設ごと）', Array.isArray(v1) && Array.isArray(v2), { v1, v2 })
})

// ── 3. 冪等・戻す・先の確かめ ──
const MIG_BODY = MIG.replace(/^begin;$/gm, '-- begin').replace(/^commit;$/gm, '-- commit')
const BACK_BODY = BACK.replace(/^begin;$/gm, '-- begin').replace(/^commit;$/gm, '-- commit')
await inTx('冪等・戻す SQL・先の確かめ', async () => {
  ok('移行と戻す SQL は begin … commit で包み、do $$ を使わない',
    /^begin;$/m.test(MIG) && /^commit;$/m.test(MIG) && /^begin;$/m.test(BACK) && /^commit;$/m.test(BACK) && !/^\s*do\s+\$\$/im.test(MIG + BACK))
  const first = JSON.stringify(await q(CK_SQL)) + (await q(CELL_SQL))[0].src
  const again = await tryq(MIG_BODY)
  ok('もう一度流しても通り、最後の確かめの3行が全部 ok', again.code === null && again.rows?.length === 3 && again.rows.every((r) => r.result === 'ok'), again)
  ok('もう一度流しても形は同じ', JSON.stringify(await q(CK_SQL)) + (await q(CELL_SQL))[0].src === first)
  const back = await tryq(BACK_BODY)
  const ckBack = await q(CK_SQL)
  ok('戻す SQL の確かめは2行とも ok・15本は施設の印の無い形（名前・制約か索引かは同じ）',
    back.code === null && back.rows?.every((r) => r.result === 'ok') && ckBack.every((r) => /USING btree \(client_key\)$/.test(r.def)) && ckBack.filter((r) => r.con).length === 11, { back, ckBack })
  ok('戻すと欄ごとの保存は on conflict (client_key)', /on conflict \(client_key\) do nothing/.test((await q(CELL_SQL))[0].src))
  const re = await tryq(MIG_BODY)
  ok('戻した後にもう一度入り、形は最初と一字一句同じ', re.code === null && JSON.stringify(await q(CK_SQL)) + (await q(CELL_SQL))[0].src === first, re)
  // 施設をまたいで同じキーがあると、戻す SQL は件数だけを出して何も変えずに止まる（キーの値を出さない・反証レビュー3巡目 中2）
  await seedTwo()
  await q(`insert into public.med_admin (resident_id, admin_on, slot, status, client_key, tenant_id) values (1101, '2026-11-06', 'noon', 'taken', 'auto:med:2026-11-06:noon:2101', $1)`, [A])
  await q(`insert into public.med_admin (resident_id, admin_on, slot, status, client_key, tenant_id) values (2101, '2026-11-06', 'noon', 'taken', 'auto:med:2026-11-06:noon:2101', $1)`, [B])
  const dupBack = await tryq(BACK_BODY)
  ok('施設をまたいで同じキーがあると、戻す SQL は組の数だけを出して止まる（キーの値・利用者の番号は出さない）',
    dupBack.code === 'P0001' && /同じ冪等キーの行が 1 組ある/.test(dupBack.message) && !/2101|2026-11-06/.test(dupBack.message), dupBack)
  ok('止まった時は何も変えていない（15本とも施設の印つき・欄ごとの保存も新しいまま）',
    (await q(CK_SQL)).every((r) => /\(tenant_id, client_key\)$/.test(r.def)) && /on conflict \(tenant_id, client_key\)/.test((await q(CELL_SQL))[0].src))
  await q(`delete from public.med_admin where admin_on = '2026-11-06'`)
  // 1段目だけ入った形（古い一意と新しい一意が両方ある）からも、全文を流し直せば入る
  const half = await tryq(BACK_BODY.split('-- ════ 2段目')[0])
  ok('（前提）戻す SQL の1段目だけを流す', half.code === null, half)
  const fromHalf = await tryq(MIG_BODY)
  ok('両方の一意がある形から 0055 を流し直すと入る（仮の名前の索引は残らない）', fromHalf.code === null && fromHalf.rows?.every((r) => r.result === 'ok')
    && (await q(`select count(*)::int n from pg_class where relname like '%client_key%\\_b' or relname like '%client_key%\\_t'`))[0].n === 0, fromHalf)
  await q(`alter table public.med_slots drop constraint med_slots_client_key_key`)
  await q(`create unique index med_slots_client_key_key on public.med_slots (client_key, resident_id)`)
  const e1 = await tryq(MIG_BODY)
  ok('一意の形が思っていたものと違うと、名前だけを出して何も変えずに止まる',
    e1.code === 'P0001' && /冪等キーの一意の形が思っていたものと違います.*med_slots_client_key_key/.test(e1.message), e1)
})

await client.end()
console.log(failed ? `\n失敗 ${failed} 件` : '\nすべて成功')
process.exit(failed === 0 ? 0 : 1)
