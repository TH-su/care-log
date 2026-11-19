// 0065（日報の確認欄＝その日の日報を読んだ印・2026-11-19）を、素の Postgres（0001〜最新を適用済み）で確かめる実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/read-check-pg.mjs
//
// 施設 A（試験の土台の施設 aa）と施設 B（この試験で足す bb）で確かめる:
//   1. 形: 施設の印が必須・トリガ3本・守り5本・消す権限なし・anon なし・外部キーは（施設の印, 番号）の組4本と施設の表だけ
//   2. 足す・取り消す（論理削除）・1人1日1件（生きている行だけ）・施設ごと
//   3. 施設をまたがない・許可リスト・anon
//   4. 物理削除はできない・冪等
//   5. 書ける日の守り: 現場は今日から14日前まで・それより前は事務所だけ・未来は誰も書けない・職員と日は変えられない・取り消しは戻せない
// 1件ずつトランザクションを張り、最後に必ず rollback する（表に何も残さない）。個人情報は置かない（職員01 と数値IDだけ）。

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
const MIG = readFileSync(path.join(ROOT, 'supabase', 'migrations', '0065_daily_read_checks.sql'), 'utf8')
const MIG_BODY = MIG.replace(/^begin;$/m, '-- begin').replace(/^commit;$/m, '-- commit')
const BACK = readFileSync(path.join(ROOT, 'supabase', 'rollback', '0065_back.sql'), 'utf8')
const BACK_BODY = BACK.replace(/^begin;$/m, '-- begin').replace(/^commit;$/m, '-- commit')

const A = '00000000-0000-0000-0000-0000000000aa'
const B = '00000000-0000-0000-0000-0000000000bb'
const UID = '00000000-0000-0000-0000-000000000001'
const T = 'daily_read_checks'
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
  try {
    await fn()
  } catch (e) {
    failed++
    console.log(`  ✗ 例外: ${e?.code ?? ''} ${e?.message ?? e}`)
  } finally {
    await client.query('rollback')
  }
}

async function tryq(text, params) {
  await client.query('savepoint t')
  try {
    const res = await client.query(text, params)
    await client.query('release savepoint t')
    const r = Array.isArray(res) ? res[res.length - 1] : res
    return { code: null, rowCount: r.rowCount, rows: r.rows }
  } catch (e) {
    await client.query('rollback to savepoint t')
    return { code: e.code ?? 'x', constraint: e.constraint ?? null, message: e.message }
  }
}

async function asUser(tenant, fn, { member = true, role = 'authenticated' } = {}) {
  await client.query('savepoint as_user')
  await client.query(`set local role ${role}`)
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role })])
  await client.query(`select set_config('test.member', $1, true)`, [member ? 'true' : 'false'])
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
    return { error: e.code, constraint: e.constraint ?? null, message: e.message }
  }
}

async function asRole(tenant, role, fn) {
  await client.query(`select set_config('test.role', $1, true)`, [role])
  try {
    return await asUser(tenant, fn)
  } finally {
    await client.query(`select set_config('test.role', '', true)`)
  }
}

async function seedTwo() {
  await q(`insert into public.tenants (id, name) values ($1, '見本の施設B') on conflict (id) do nothing`, [B])
  await q(`insert into public.staff (id, name, tenant_id) overriding system value
           values (1201, '職員01', $1), (1202, '職員02', $1), (2201, '職員01', $2)`, [A, B])
}

/** JST の今日から n 日ずらした日（'YYYY-MM-DD'） */
async function jstDay(n) {
  return (await q(`select ((now() at time zone 'Asia/Tokyo')::date + $1::int)::text d`, [n]))[0].d
}

// ── 1. 形 ──
await inTx('形: 施設の印・トリガ・守り・権限・外部キー', async () => {
  const nn = await q(`select 1 from information_schema.columns
                       where table_schema = 'public' and column_name = 'tenant_id' and is_nullable = 'NO' and table_name = $1`, [T])
  ok('施設の印が必須', nn.length === 1, nn)
  const names = (await q(`select g.tgname from pg_trigger g join pg_class c on c.oid = g.tgrelid
                           where not g.tgisinternal and c.relname = $1 order by 1`, [T])).map((x) => x.tgname)
  ok('印・版・守りのトリガ（3本）', ['carelog_fill_tenant', `trg_updated_${T}`, `trg_${T}_guard`].every((n) => names.includes(n)) && names.length === 3, names)
  const p = await q(`select policyname, permissive, cmd, roles::text roles, qual, with_check from pg_policies
                      where schemaname = 'public' and tablename = $1 order by 1`, [T])
  ok('守りは5本', p.map((x) => x.policyname).sort().join(',') === 'insert_auth,member_only,read_auth,tenant_only,update_auth', p)
  const to = p.find((x) => x.policyname === 'tenant_only')
  ok('tenant_only は 0054 と同じ形', to?.permissive === 'RESTRICTIVE' && to.cmd === 'ALL' && to.roles === '{authenticated}' && to.qual === QUAL && to.with_check === QUAL, to)
  ok('member_only は restrictive', p.find((x) => x.policyname === 'member_only')?.permissive === 'RESTRICTIVE')
  ok('消す守りは無い', !p.some((x) => x.cmd === 'DELETE'))
  const grants = await q(`select grantee, privilege_type from information_schema.role_table_grants
                           where table_schema = 'public' and table_name = $1 and grantee in ('anon', 'authenticated')`, [T])
  ok('anon には何も無い', !grants.some((g) => g.grantee === 'anon'), grants)
  ok('authenticated に delete・truncate は無い', !grants.some((g) => g.grantee === 'authenticated' && ['DELETE', 'TRUNCATE'].includes(g.privilege_type)), grants)
  ok('authenticated は読む・足す・直すができる', ['SELECT', 'INSERT', 'UPDATE'].every((pv) => grants.some((g) => g.grantee === 'authenticated' && g.privilege_type === pv)), grants)
  const fks = await q(`select k.conname, pg_get_constraintdef(k.oid) as def from pg_constraint k
                        where k.contype = 'f' and k.conrelid = 'public.${T}'::regclass order by 1`)
  ok('外部キーは（施設の印, 番号）の組4本と施設の表だけ',
    fks.every((f) => /^FOREIGN KEY \(tenant_id, [a-z_]+\) REFERENCES staff\(tenant_id, id\)$/.test(f.def) || /^FOREIGN KEY \(tenant_id\) REFERENCES tenants\(id\)$/.test(f.def))
      && fks.filter((f) => /REFERENCES staff/.test(f.def)).map((f) => f.conname).sort().join(',')
        === [`${T}_deleted_by_fkey`, `${T}_edited_by_fkey`, `${T}_recorded_by_fkey`, `${T}_staff_id_fkey`].join(','), fks)
  const ix = (await q(`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'uq_daily_read_checks'`))[0]?.indexdef
  ok('一意は施設の印が先頭・生きている行だけ', ix === `CREATE UNIQUE INDEX uq_daily_read_checks ON public.${T} USING btree (tenant_id, day, staff_id) WHERE (deleted_at IS NULL)`, ix)
  const pub = await q(`select 1 from pg_publication_tables where tablename = $1`, [T])
  ok('Realtime には載せない', pub.length === 0, pub)
})

// ── 2. 足す・取り消す・一意 ──
await inTx('足す・取り消す・1人1日1件', async () => {
  await seedTwo()
  const today = await jstDay(0)
  const ins = await asUser(A, () => q(`insert into public.${T} (day, staff_id, recorded_by) values ($1, 1201, 1201) returning id, tenant_id, rev, deleted_at, checked_at`, [today]))
  ok('ログインした人が足すと、その人の施設の印が入る（rev 1・時刻つき）', !ins.error && ins[0]?.tenant_id === A && ins[0].rev === 1 && ins[0].deleted_at === null && ins[0].checked_at !== null, ins)
  const dup = await asUser(A, () => q(`insert into public.${T} (day, staff_id, recorded_by) values ($1, 1201, 1201)`, [today]))
  ok('同じ人・同じ日の2件目は 23505', dup.error === '23505' && dup.constraint === 'uq_daily_read_checks', dup)
  const other = await asUser(A, () => q(`insert into public.${T} (day, staff_id) values ($1, 1202) returning id`, [today]))
  ok('別の人は同じ日に足せる', Array.isArray(other) && other.length === 1, other)
  await q(`insert into public.${T} (day, staff_id, tenant_id) values ($1, 2201, $2)`, [today, B])
  ok('施設 B は同じ日に並べて足せる', true)
  const del = await asUser(A, () => q(`update public.${T} set deleted_at = now(), deleted_by = 1201, edited_by = 1201 where id = $1 and rev = 1 and deleted_at is null returning rev, deleted_at`, [ins[0].id]))
  ok('取り消し（論理削除）で rev が進む', !del.error && del[0]?.rev === 2 && del[0].deleted_at !== null, del)
  const again = await asUser(A, () => q(`insert into public.${T} (day, staff_id, recorded_by) values ($1, 1201, 1201) returning id`, [today]))
  ok('取り消した後はもう一度付けられる（新しい行）', Array.isArray(again) && again.length === 1 && again[0].id !== ins[0].id, again)
  const revive = await asUser(A, () => q(`update public.${T} set deleted_at = null where id = $1 returning id`, [ins[0].id]))
  ok('取り消した行は戻せない（22023・read_check_fixed）', revive.error === '22023' && /^read_check_fixed:/.test(revive.message ?? ''), revive)
  const move = await asUser(A, () => q(`update public.${T} set staff_id = 1202 where id = $1 returning id`, [again[0].id]))
  ok('職員を書き換えられない（22023）', move.error === '22023' && /^read_check_fixed:/.test(move.message ?? ''), move)
  const moveDay = await asUser(A, () => q(`update public.${T} set day = day - 1 where id = $1 returning id`, [again[0].id]))
  ok('日を書き換えられない（22023）', moveDay.error === '22023', moveDay)
})

// ── 3. 施設をまたがない ──
await inTx('施設をまたがない・許可リスト・anon', async () => {
  await seedTwo()
  const today = await jstDay(0)
  const fk = await asUser(A, () => q(`insert into public.${T} (day, staff_id) values ($1, 2201)`, [today]))
  ok('よその施設の職員の印は 23503', fk.error === '23503', fk)
  await q(`insert into public.${T} (day, staff_id, tenant_id) values ($1, 2201, $2)`, [today, B])
  const seenA = await asUser(A, async () => (await q(`select count(*)::int n from public.${T}`))[0].n)
  ok('施設 A の人には施設 B の行が見えない', seenA === 0, seenA)
  const seenB = await asUser(B, async () => (await q(`select count(*)::int n from public.${T}`))[0].n)
  ok('施設 B の人には自分の行が見える', seenB === 1, seenB)
  const upB = await asUser(A, () => q(`update public.${T} set deleted_at = now() where staff_id = 2201 returning id`))
  ok('施設 A の人は施設 B の行を取り消せない（0行）', Array.isArray(upB) && upB.length === 0, upB)
  const moveT = await asUser(A, () => q(`insert into public.${T} (day, staff_id, tenant_id) values ($1, 1201, $2)`, [today, B]))
  ok('よその施設の印を付けて足すと 42501', moveT.error === '42501', moveT)
  const nonMember = await asUser(A, async () => (await q(`select count(*)::int n from public.${T}`))[0].n, { member: false })
  ok('許可リストに無い人は何も見えない', nonMember === 0, nonMember)
  const anon = await asUser(A, () => q(`select count(*) from public.${T}`), { role: 'anon' })
  ok('anon は読めない（42501）', anon.error === '42501', anon)
})

// ── 4. 物理削除・冪等・戻し ──
await inTx('物理削除はできない・冪等・戻す SQL', async () => {
  await seedTwo()
  const today = await jstDay(0)
  await q(`insert into public.${T} (day, staff_id, tenant_id) values ($1, 1201, $2)`, [today, A])
  const del = await asUser(A, () => q(`delete from public.${T}`))
  ok('ログインした人の delete は 42501', del.error === '42501', del)
  const trunc = await asUser(A, () => q(`truncate public.${T}`))
  ok('ログインした人の truncate は 42501', trunc.error === '42501', trunc)
  ok('移行は begin … commit で包んでいる・do $$ を使わない', /^begin;$/m.test(MIG) && /^commit;$/m.test(MIG) && !/^\s*do\s+\$\$/im.test(MIG))
  const again = await tryq(MIG_BODY)
  const last = Array.isArray(again.rows) ? again.rows : []
  ok('もう一度流しても通り、最後の確かめが ok', again.code === null && last.length === 1 && last[0].result === 'ok', again)
  const kept = (await q(`select count(*)::int n from public.${T}`))[0].n
  ok('流し直しても印は消えない', kept === 1, kept)
  const back = await tryq(BACK_BODY)
  const backLast = Array.isArray(back.rows) ? back.rows : []
  ok('戻す SQL が通り、最後の確かめが ok', back.code === null && backLast.length === 1 && backLast[0].result === 'ok', back)
  const re = await tryq(MIG_BODY)
  ok('戻した後にもう一度流せる', re.code === null && re.rows?.[0]?.result === 'ok', re)
})

// ── 5. 書ける日の守り ──
await inTx('書ける日の守り: 現場は今日から14日前まで・それより前は事務所・未来は誰も書けない', async () => {
  await seedTwo()
  const today = await jstDay(0)
  const d14 = await jstDay(-14)
  const d15 = await jstDay(-15)
  const tomorrow = await jstDay(1)
  const fToday = await asRole(A, 'field', () => q(`insert into public.${T} (day, staff_id) values ($1, 1201) returning id, rev`, [today]))
  ok('現場は今日の ✔ を付けられる', Array.isArray(fToday) && fToday.length === 1, fToday)
  const fUndo = await asRole(A, 'field', () => q(`update public.${T} set deleted_at = now(), deleted_by = 1201 where id = $1 returning id`, [fToday[0].id]))
  ok('現場は今日の ✔ を取り消せる', Array.isArray(fUndo) && fUndo.length === 1, fUndo)
  const f14 = await asRole(A, 'field', () => q(`insert into public.${T} (day, staff_id) values ($1, 1201) returning id`, [d14]))
  ok('現場は14日前の ✔ を付けられる（休み明けに読み返す）', Array.isArray(f14) && f14.length === 1, f14)
  const f15 = await asRole(A, 'field', () => q(`insert into public.${T} (day, staff_id) values ($1, 1201)`, [d15]))
  ok('現場は15日前の ✔ を付けられない（42501・read_check_past_office_only）', f15.error === '42501' && /^read_check_past_office_only:/.test(f15.message ?? ''), f15)
  const o15 = await asRole(A, 'office', () => q(`insert into public.${T} (day, staff_id) values ($1, 1201) returning id`, [d15]))
  ok('事務所は15日前の ✔ を付けられる', Array.isArray(o15) && o15.length === 1, o15)
  const f15Undo = await asRole(A, 'field', () => q(`update public.${T} set deleted_at = now() where id = $1 returning id`, [o15[0].id]))
  ok('現場は15日前の ✔ を取り消せない（42501）', f15Undo.error === '42501', f15Undo)
  const fut = await asRole(A, 'office', () => q(`insert into public.${T} (day, staff_id) values ($1, 1201)`, [tomorrow]))
  ok('未来の日は事務所でも付けられない（22023・read_check_future）', fut.error === '22023' && /^read_check_future:/.test(fut.message ?? ''), fut)
  const futServer = await tryq(`insert into public.${T} (day, staff_id, tenant_id) values ($1, 1201, $2)`, [tomorrow, A])
  ok('未来の日はサーバーの接続でも付けられない（22023）', futServer.code === '22023', futServer)
  const fn = (await q(`select p.prosecdef, p.proconfig from pg_proc p where p.oid = 'public.daily_read_check_guard()'::regprocedure`))[0]
  ok('守りの関数は security definer・search_path を空に固定', fn?.prosecdef === true && JSON.stringify(fn.proconfig) === JSON.stringify(['search_path=""']), fn)
  const exec = (await q(`select has_function_privilege('authenticated', 'public.daily_read_check_guard()', 'execute') a,
                                has_function_privilege('anon', 'public.daily_read_check_guard()', 'execute') b`))[0]
  ok('守りの関数は authenticated・anon が実行できない', exec.a === false && exec.b === false, exec)
})

// ── 6. 勤務表の読み口（carelog_shift_duty） ──
await inTx('勤務表の読み口: 要る項目だけ・自分の施設だけ・live でなければ印だけ・許可リストの人だけ', async () => {
  await seedTwo()
  const staffData = JSON.stringify([
    { id: 's1', name: '職員01', mainDivision: '施設', empCode: 'E1', rules: { x: 1 }, qualifications: ['q'], employment: '常勤', active: true },
    { id: 's2', name: '職員02', mainDivision: '訪問', status: '退職', retireMonth: '2026-10' },
    'こわれた要素',
  ])
  const symData = JSON.stringify([{ code: '早', type: 'work', label: 'L', color: '#fff', start: '07:00', end: '16:00' }, { code: '研', type: 'work', disabled: true }])
  const plan = JSON.stringify({ cells: { s1: { 1: '早' } }, subCells: { s2: { 施設: { 2: '遅' } } }, colors: { a: 1 }, notes: 'メモ', dailyNeeds: {} })
  await q(`insert into public.kv_entries (tenant_id, key, data, mode) values
           ($1, 'staff', $2::jsonb, 'live'), ($1, 'symbols', $3::jsonb, 'live'), ($1, 'sched:2026-11:plan', $4::jsonb, 'live'),
           ($5, 'staff', '[{"id":"b1","name":"よその職員"}]'::jsonb, 'live')`, [A, staffData, symData, plan, B])
  const r = await asUser(A, async () => (await q(`select public.carelog_shift_duty(array['2026-11','2026-12']) as r`))[0].r)
  ok('live の時は mode・staff・symbols・months を返す', r?.mode === 'live' && Array.isArray(r.staff) && Array.isArray(r.symbols) && r.months, r)
  ok('職員は id・氏名・主の区分・在籍の印だけ（労務の項目は返さない）',
    r.staff.length === 2 && r.staff[0].id === 's1' && r.staff[0].name === '職員01' && r.staff[0].mainDivision === '施設' && r.staff[0].active === true
      && r.staff[1].status === '退職' && r.staff[1].retireMonth === '2026-10'
      && r.staff.every((s) => Object.keys(s).every((k) => ['id', 'name', 'mainDivision', 'active', 'status', 'retireMonth'].includes(k))), r.staff)
  ok('職員の項目に労務の項目が無い', !JSON.stringify(r.staff).match(/empCode|rules|qualifications|employment|E1|常勤/), r.staff)
  // 2026-11-19 0066: 記号の開始時刻（start）も返す（未読者に名前を出すのを出勤の時刻より後にするため）。終わり・色・名前は返さない
  ok('記号は code・type・disabled・start だけ', JSON.stringify(r.symbols) === JSON.stringify([{ code: '早', type: 'work', start: '07:00' }, { code: '研', type: 'work', disabled: true }]), r.symbols)
  ok('月は cells・subCells だけ（色・メモ・必要数は返さない）・無い月・無い実績は null',
    JSON.stringify(r.months['2026-11'].plan) === JSON.stringify({ cells: { s1: { 1: '早' } }, subCells: { s2: { 施設: { 2: '遅' } } } })
      && r.months['2026-11'].actual === null && r.months['2026-12'].plan === null, r.months)
  ok('よその施設の勤務表は返さない', !JSON.stringify(r).includes('よその職員'), r)
  await q(`update public.kv_entries set mode = 'shadow' where tenant_id = $1 and key = 'staff'`, [A])
  const sh = await asUser(A, async () => (await q(`select public.carelog_shift_duty(array['2026-11']) as r`))[0].r)
  ok('切り替え前（shadow）は印だけを返す', JSON.stringify(sh) === JSON.stringify({ mode: 'shadow' }), sh)
  const nm = await asUser(A, () => q(`select public.carelog_shift_duty(array['2026-11'])`), { member: false })
  ok('許可リストに無い人は 42501', nm.error === '42501', nm)
  const bad = await asUser(A, () => q(`select public.carelog_shift_duty(array['2026-13'])`))
  ok('月の形が違えば 22023', bad.error === '22023', bad)
  const many = await asUser(A, () => q(`select public.carelog_shift_duty(array['2026-01','2026-02','2026-03','2026-04'])`))
  ok('月が4つ以上なら 22023', many.error === '22023', many)
  const exec = (await q(`select has_function_privilege('authenticated', 'public.carelog_shift_duty(text[])', 'execute') a,
                                has_function_privilege('anon', 'public.carelog_shift_duty(text[])', 'execute') b`))[0]
  ok('authenticated は呼べる・anon は呼べない', exec.a === true && exec.b === false, exec)
  const fn = (await q(`select p.prosecdef, p.proconfig, p.provolatile from pg_proc p where p.oid = 'public.carelog_shift_duty(text[])'::regprocedure`))[0]
  ok('security definer・search_path を空に固定・stable', fn?.prosecdef === true && JSON.stringify(fn.proconfig) === JSON.stringify(['search_path=""']) && fn.provolatile === 's', fn)
})

await client.end()
console.log(failed ? `\n失敗 ${failed} 件` : '\nすべて成功')
process.exit(failed === 0 ? 0 : 1)
