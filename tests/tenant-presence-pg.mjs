// 0056（居場所を施設ごとのチャンネルに分ける）を、素の Postgres（0001〜最新を適用済み）で確かめる実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/tenant-stage4-pg.mjs
//
// 施設 A（試験の土台の施設 aa）と施設 B（この試験で足す bb）で確かめる:
//   1. ログインした人は自分の施設のトピック名を聞ける（許可リストに無い人・施設の決まらない人は null・未ログインは呼べない）
//   2. 自分の施設のトピックには配れて受け取れる。よその施設のトピックには配れず、受け取れない
//   3. 古い1本のトピック（cl_note_presence）は施設が1つの間だけ使える。2つ目の施設を足すと配れず、受け取れない
//   4. 冪等・戻す SQL で 0029 の形に戻り、もう一度入る
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
const MIG = readFileSync(path.join(ROOT, 'supabase', 'migrations', '0056_presence_tenant.sql'), 'utf8')
const BACK = readFileSync(path.join(ROOT, 'supabase', 'rollback', '0056_back.sql'), 'utf8')
// 0055（冪等キーの一意を施設ごと）は 0054 の上に入るので、0054 を戻す前に 0055 を戻す（0054_back.sql は 0055 があると止まる）
const BACK55 = readFileSync(path.join(ROOT, 'supabase', 'rollback', '0055_back.sql'), 'utf8')

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


const TOP = (t) => `cl_note_presence:${t}`
/** ログインした人として、トピックを決めて居場所を1件配り、見えた居場所の数を返す（配れなければ誤りの番号） */
async function tryTopic(tenant, topic, member = true) {
  return asUser(tenant, async () => {
    await client.query(`select set_config('test.member', $1, true)`, [member ? 'true' : 'false'])
    await client.query(`select set_config('realtime.topic', $1, true)`, [topic])
    await client.query(`insert into realtime.messages (topic, extension, payload, private) values ($1, 'presence', '{}', true)`, [topic])
    return (await q(`select count(*)::int n from realtime.messages where extension = 'presence' and topic = $1`, [topic]))[0].n
  })
}
async function seeTopic(tenant, topic) {
  return asUser(tenant, async () => {
    await client.query(`select set_config('realtime.topic', $1, true)`, [topic])
    return (await q(`select count(*)::int n from realtime.messages where extension = 'presence'`))[0].n
  })
}

await inTx('トピック名: 自分の施設のトピック名を聞ける', async () => {
  await q(`insert into public.tenants (id, name) values ($1, '見本の施設B') on conflict (id) do nothing`, [B])
  const a = await asUser(A, () => q(`select public.carelog_presence_topic() t`))
  const b = await asUser(B, () => q(`select public.carelog_presence_topic() t`))
  ok('施設 A の人は施設 A のトピック名・施設 B の人は施設 B のトピック名', a[0]?.t === TOP(A) && b[0]?.t === TOP(B), { a, b })
  const out = await asUser(A, async () => { await client.query(`select set_config('test.member', 'false', true)`); return q(`select public.carelog_presence_topic() t`) })
  ok('許可リストに無い人には null', out[0]?.t === null, out)
  const none = await asUser('none', () => q(`select public.carelog_presence_topic() t`))
  ok('施設の決まらない人には null', none[0]?.t === null, none)
  ok('未ログイン（anon）は呼べない', !(await q(`select has_function_privilege('anon', 'public.carelog_presence_topic()', 'execute') x`))[0].x)
})

await inTx('自分の施設のトピックだけ: 配れて受け取れる・よその施設は配れず受け取れない', async () => {
  await q(`insert into public.tenants (id, name) values ($1, '見本の施設B') on conflict (id) do nothing`, [B])
  const own = await tryTopic(A, TOP(A))
  ok('施設 A の人は施設 A のトピックに配れて、その居場所が見える', own === 1, own)
  const cross = await tryTopic(A, TOP(B))
  ok('施設 A の人は施設 B のトピックに配れない（42501）', cross?.error === '42501', cross)
  await q(`insert into realtime.messages (topic, extension, payload, private) values ($1, 'presence', '{}', true)`, [TOP(B)])
  const peek = await seeTopic(A, TOP(B))
  ok('施設 A の人は施設 B のトピックの居場所を受け取れない', peek === 0, peek)
  const outsider = await tryTopic(A, TOP(A), false)
  ok('許可リストに無い人は自分の施設のトピックにも配れない', outsider?.error === '42501', outsider)
})

await inTx('古い1本のトピック: 施設が1つの間だけ使える', async () => {
  const one = await tryTopic(A, 'cl_note_presence')
  ok('施設が1つの間は古いトピックに配れて受け取れる（古い版の画面が今までどおり動く）', one === 1, one)
  await q(`insert into public.tenants (id, name) values ($1, '見本の施設B')`, [B])
  const two = await tryTopic(A, 'cl_note_presence')
  ok('2つ目の施設を足すと古いトピックに配れない（42501）', two?.error === '42501', two)
  const seen = await seeTopic(A, 'cl_note_presence')
  ok('2つ目の施設を足すと古いトピックの居場所を受け取れない', seen === 0, seen)
})

const MIG_BODY = MIG.replace(/^begin;$/gm, '-- begin').replace(/^commit;$/gm, '-- commit')
const BACK_BODY = BACK.replace(/^begin;$/gm, '-- begin').replace(/^commit;$/gm, '-- commit')
await inTx('冪等・戻す SQL', async () => {
  ok('移行と戻す SQL は begin … commit で包み、do $$ を使わない',
    /^begin;$/m.test(MIG) && /^commit;$/m.test(MIG) && /^begin;$/m.test(BACK) && !/^\s*do\s+\$\$/im.test(MIG + BACK))
  const again = await tryq(MIG_BODY)
  ok('もう一度流しても通り、確かめの2行が ok', again.code === null && again.rows?.length === 2 && again.rows.every((r) => r.result === 'ok'), again)
  const back = await tryq(BACK_BODY)
  ok('戻す SQL の確かめが ok', back.code === null && back.rows?.[0]?.result === 'ok', back)
  const old = await tryTopic(A, 'cl_note_presence')
  ok('戻すと古いトピックで配れる（0029 の形）', old === 1, old)
  const re = await tryq(MIG_BODY)
  ok('戻した後にもう一度入る', re.code === null && re.rows?.every((r) => r.result === 'ok'), re)
})

await client.end()
console.log(failed ? `\n失敗 ${failed} 件` : '\nすべて成功')
process.exit(failed === 0 ? 0 : 1)
