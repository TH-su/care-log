// 0061（デイの連絡帳の2表・2026-11-09 計画C）を、素の Postgres（0001〜最新を適用済み）で確かめる実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/daycare-contact-pg.mjs
//
// 施設 A（試験の土台の施設 aa）と施設 B（この試験で足す bb）で確かめる:
//   1. 形: 2表とも施設の印が必須・印を入れるトリガ・守り5本（tenant_only・member_only は restrictive）・消す守りと権限なし
//   2. ログインした人が足すと、その人の施設の印が入る・rev と updated_at が進む・変更の記録に施設の印つきで残る
//   3. 1日1行・1人1日1行（生きている行だけ）は 23505・取り消した行の後には足せる・施設 B には同じ日を並べて足せる
//   4. 長さの上限（共通 200字・個別 200字・看護職 150字）は 23514
//   5. よその施設の利用者・職員を指す行は 23503・よその施設の行は見えない・書けない・許可リストに無い人は何も見えない・anon は読めない
//   6. 物理削除はできない（delete の権限なし）・冪等（もう一度流しても通り、最後の確かめが ok）
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
const MIG = readFileSync(path.join(ROOT, 'supabase', 'migrations', '0061_daycare_contact.sql'), 'utf8')
/** 試験の取引の中で流す本文（移行の begin … commit を外す＝試験の取引を閉じない） */
const MIG_BODY = MIG.replace(/^begin;$/m, '-- begin').replace(/^commit;$/m, '-- commit')

const A = '00000000-0000-0000-0000-0000000000aa'
const B = '00000000-0000-0000-0000-0000000000bb'
const UID = '00000000-0000-0000-0000-000000000001'
const TABLES = ['daycare_day_notes', 'daycare_contact_notes']
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

/** 1文を流して、誤りの符号・制約の名前を返す（誤りが無ければ code は null）。前後の取引は保つ */
async function tryq(text, params) {
  await client.query('savepoint t')
  try {
    const res = await client.query(text, params)
    await client.query('release savepoint t')
    const r = Array.isArray(res) ? res[res.length - 1] : res // 何文も流した時は最後の文（確かめの行）
    return { code: null, rowCount: r.rowCount, rows: r.rows }
  } catch (e) {
    await client.query('rollback to savepoint t')
    return { code: e.code ?? 'x', constraint: e.constraint ?? null, message: e.message }
  }
}

/** ログインした人（authenticated）として fn を流す。例外は SQLSTATE で返す */
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
    return { error: e.code, constraint: e.constraint ?? null }
  }
}

/** 施設 B と、両方の施設の利用者・職員を置く */
async function seedTwo() {
  await q(`insert into public.tenants (id, name) values ($1, '見本の施設B') on conflict (id) do nothing`, [B])
  await q(`insert into public.residents (id, source_id, name, active, tenant_id) overriding system value
           values (1101, 'S01', '利用者01', true, $1), (1102, 'S02', '利用者02', true, $1), (2101, 'S01', '利用者01', true, $2)`, [A, B])
  await q(`insert into public.staff (id, name, tenant_id) overriding system value values (1201, '職員01', $1), (2201, '職員01', $2)`, [A, B])
}

// ── 1. 形 ──
await inTx('形: 施設の印・トリガ・守り・権限', async () => {
  const nn = await q(`select table_name from information_schema.columns
                       where table_schema = 'public' and column_name = 'tenant_id' and is_nullable = 'NO' and table_name = any($1)`, [TABLES])
  ok('2表とも施設の印が必須', nn.length === 2, nn)
  const trg = await q(`select c.relname, g.tgname from pg_trigger g join pg_class c on c.oid = g.tgrelid
                        where not g.tgisinternal and c.relname = any($1) order by 1, 2`, [TABLES])
  for (const t of TABLES) {
    const names = trg.filter((x) => x.relname === t).map((x) => x.tgname)
    ok(`${t}: 印・版・変更の記録のトリガ`, ['carelog_fill_tenant', `trg_history_${t}`, `trg_updated_${t}`].every((n) => names.includes(n)) && names.length === 3, names)
  }
  const pol = await q(`select tablename, policyname, permissive, cmd, roles::text roles, qual, with_check from pg_policies
                        where schemaname = 'public' and tablename = any($1) order by 1, 2`, [TABLES])
  for (const t of TABLES) {
    const p = pol.filter((x) => x.tablename === t)
    ok(`${t}: 守りは5本（read_auth・insert_auth・update_auth・member_only・tenant_only）`,
      p.map((x) => x.policyname).sort().join(',') === 'insert_auth,member_only,read_auth,tenant_only,update_auth', p)
    const to = p.find((x) => x.policyname === 'tenant_only')
    ok(`${t}: tenant_only は 0054 と同じ形（restrictive・全部の操作・自分の施設だけ）`,
      to?.permissive === 'RESTRICTIVE' && to.cmd === 'ALL' && to.roles === '{authenticated}' && to.qual === QUAL && to.with_check === QUAL, to)
    ok(`${t}: member_only は restrictive`, p.find((x) => x.policyname === 'member_only')?.permissive === 'RESTRICTIVE')
    ok(`${t}: 消す守りは無い`, !p.some((x) => x.cmd === 'DELETE'))
  }
  const grants = await q(`select table_name, grantee, privilege_type from information_schema.role_table_grants
                           where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated')`, [TABLES])
  ok('anon には何も無い', !grants.some((g) => g.grantee === 'anon'), grants)
  ok('authenticated に delete・truncate は無い', !grants.some((g) => g.grantee === 'authenticated' && ['DELETE', 'TRUNCATE'].includes(g.privilege_type)), grants)
  ok('authenticated は読む・足す・直すができる', TABLES.every((t) => ['SELECT', 'INSERT', 'UPDATE'].every((pv) => grants.some((g) => g.table_name === t && g.grantee === 'authenticated' && g.privilege_type === pv))), grants)
  const fks = await q(`select k.conname, k.conrelid::regclass::text as child, pg_get_constraintdef(k.oid) as def from pg_constraint k
                        where k.contype = 'f' and k.conrelid::regclass::text = any($1) order by 1`, [TABLES])
  ok('外部キーは（施設の印, 番号）の組と施設の表（tenants）だけ',
    fks.every((f) => /^FOREIGN KEY \(tenant_id, [a-z_]+\) REFERENCES (residents|staff)\(tenant_id, id\)$/.test(f.def) || /^FOREIGN KEY \(tenant_id\) REFERENCES tenants\(id\)$/.test(f.def))
      && fks.filter((f) => /REFERENCES (residents|staff)/.test(f.def)).length === 7, fks)
})

// ── 2. 足す・直す・変更の記録 ──
await inTx('足す・直す: 施設の印が入る・rev と updated_at が進む・変更の記録', async () => {
  await seedTwo()
  const ins = await asUser(A, () => q(`insert into public.daycare_contact_notes (resident_id, day, body, recorded_by) values (1101, '2026-11-09', '笑顔で過ごされました', 1201) returning id, tenant_id, rev, updated_at`))
  ok('ログインした人が足すと、その人の施設の印が入る', !ins.error && ins[0]?.tenant_id === A && ins[0].rev === 1, ins)
  const up = await asUser(A, () => q(`update public.daycare_contact_notes set nurse_note = '様子を見ています', edited_by = 1201 where id = $1 and rev = 1 returning rev, body, nurse_note, updated_at`, [ins[0].id]))
  ok('1つの欄だけを直すと、もう片方の欄はそのまま・rev が進む', !up.error && up[0]?.rev === 2 && up[0].body === '笑顔で過ごされました' && up[0].nurse_note === '様子を見ています', up)
  const stale = await asUser(A, () => q(`update public.daycare_contact_notes set body = '別の文' where id = $1 and rev = 1 returning id`, [ins[0].id]))
  ok('古い rev での更新は0行（上書きしない）', Array.isArray(stale) && stale.length === 0, stale)
  const hist = await q(`select table_name, record_day::text d, op, tenant_id, changed_by_staff from public.record_history where table_name = 'daycare_contact_notes' and row_id = $1`, [ins[0].id])
  ok('変更の記録に施設の印・業務日・直した職員が残る', hist.length === 1 && hist[0].tenant_id === A && hist[0].d === '2026-11-09' && hist[0].op === 'update' && Number(hist[0].changed_by_staff) === 1201, hist)
  const dn = await asUser(A, () => q(`insert into public.daycare_day_notes (day, body) values ('2026-11-09', '秋の歌を歌いました') returning tenant_id`))
  ok('全員共通の一文も、その人の施設の印が入る', !dn.error && dn[0]?.tenant_id === A, dn)
})

// ── 3. 一意 ──
await inTx('一意: 1日1行・1人1日1行（生きている行だけ）・施設ごと', async () => {
  await seedTwo()
  await q(`insert into public.daycare_day_notes (day, body, tenant_id) values ('2026-11-09', '一文', $1)`, [A])
  const d2 = await tryq(`insert into public.daycare_day_notes (day, body, tenant_id) values ('2026-11-09', '二つ目', $1)`, [A])
  ok('同じ施設・同じ日の共通の一文の2行目は 23505', d2.code === '23505' && d2.constraint === 'uq_daycare_day_notes', d2)
  const dB = await tryq(`insert into public.daycare_day_notes (day, body, tenant_id) values ('2026-11-09', '施設Bの一文', $1)`, [B])
  ok('施設 B は同じ日に並べて足せる', dB.code === null, dB)
  await q(`insert into public.daycare_contact_notes (resident_id, day, body, tenant_id) values (1101, '2026-11-09', 'ひと言', $1)`, [A])
  const c2 = await tryq(`insert into public.daycare_contact_notes (resident_id, day, nurse_note, tenant_id) values (1101, '2026-11-09', '二つ目', $1)`, [A])
  ok('同じ方・同じ日のひと言の2行目は 23505', c2.code === '23505' && c2.constraint === 'uq_daycare_contact_notes', c2)
  await q(`update public.daycare_contact_notes set deleted_at = now() where resident_id = 1101 and day = '2026-11-09'`)
  const c3 = await tryq(`insert into public.daycare_contact_notes (resident_id, day, body, tenant_id) values (1101, '2026-11-09', '取り消した後', $1)`, [A])
  ok('取り消した行の後には足せる（生きている行だけで一意）', c3.code === null, c3)
})

// ── 4. 長さ ──
await inTx('長さの上限: 共通 200字・個別 200字・看護職 150字', async () => {
  await seedTwo()
  const okBody = await tryq(`insert into public.daycare_contact_notes (resident_id, day, body, nurse_note, tenant_id) values (1101, '2026-11-08', repeat('あ', 200), repeat('い', 150), $1)`, [A])
  ok('上限ちょうどは入る', okBody.code === null, okBody)
  const longBody = await tryq(`insert into public.daycare_contact_notes (resident_id, day, body, tenant_id) values (1102, '2026-11-08', repeat('あ', 201), $1)`, [A])
  ok('個別のひと言 201字は 23514', longBody.code === '23514' && longBody.constraint === 'daycare_contact_notes_body_check', longBody)
  const longNurse = await tryq(`insert into public.daycare_contact_notes (resident_id, day, nurse_note, tenant_id) values (1102, '2026-11-08', repeat('い', 151), $1)`, [A])
  ok('看護職のひと言 151字は 23514', longNurse.code === '23514' && longNurse.constraint === 'daycare_contact_notes_nurse_note_check', longNurse)
  const longDay = await tryq(`insert into public.daycare_day_notes (day, body, tenant_id) values ('2026-11-08', repeat('う', 201), $1)`, [A])
  ok('共通の一文 201字は 23514', longDay.code === '23514' && longDay.constraint === 'daycare_day_notes_body_check', longDay)
})

// ── 5. 施設をまたがない・許可リスト・anon ──
await inTx('施設をまたがない: よその施設の利用者・職員は 23503・よその施設の行は見えない・書けない', async () => {
  await seedTwo()
  const fkR = await asUser(A, () => q(`insert into public.daycare_contact_notes (resident_id, day, body) values (2101, '2026-11-09', 'ひと言')`))
  ok('よその施設の利用者を指すひと言は 23503', fkR.error === '23503', fkR)
  const fkS = await asUser(A, () => q(`insert into public.daycare_day_notes (day, body, recorded_by) values ('2026-11-09', '一文', 2201)`))
  ok('よその施設の職員を記録者にすると 23503', fkS.error === '23503', fkS)
  await q(`insert into public.daycare_contact_notes (resident_id, day, body, tenant_id) values (2101, '2026-11-09', '施設Bのひと言', $1)`, [B])
  await q(`insert into public.daycare_day_notes (day, body, tenant_id) values ('2026-11-09', '施設Bの一文', $1)`, [B])
  const seenA = await asUser(A, async () => ({
    c: (await q(`select count(*)::int n from public.daycare_contact_notes`))[0].n,
    d: (await q(`select count(*)::int n from public.daycare_day_notes`))[0].n,
  }))
  ok('施設 A の人には施設 B の行が見えない', seenA.c === 0 && seenA.d === 0, seenA)
  const seenB = await asUser(B, async () => (await q(`select count(*)::int n from public.daycare_contact_notes`))[0].n)
  ok('施設 B の人には自分の行が見える', seenB === 1, seenB)
  const upB = await asUser(A, () => q(`update public.daycare_contact_notes set body = '書き換え' where resident_id = 2101 returning id`))
  ok('施設 A の人は施設 B の行を書き換えられない（0行）', Array.isArray(upB) && upB.length === 0, upB)
  const move = await asUser(A, () => q(`insert into public.daycare_day_notes (day, body, tenant_id) values ('2026-11-10', '一文', $1)`, [B]))
  ok('よその施設の印を付けて足すと 42501', move.error === '42501', move)
  const nonMember = await asUser(A, async () => (await q(`select count(*)::int n from public.daycare_contact_notes`))[0].n, { member: false })
  ok('許可リストに無い人は何も見えない', nonMember === 0, nonMember)
  const anon = await asUser(A, () => q(`select count(*) from public.daycare_contact_notes`), { role: 'anon' })
  ok('anon は読めない（権限なし 42501）', anon.error === '42501', anon)
})

// ── 6. 物理削除・冪等 ──
await inTx('物理削除はできない・冪等', async () => {
  await seedTwo()
  await q(`insert into public.daycare_contact_notes (resident_id, day, body, tenant_id) values (1101, '2026-11-09', 'ひと言', $1)`, [A])
  const del = await asUser(A, () => q(`delete from public.daycare_contact_notes`))
  ok('ログインした人の delete は 42501（取り消しは deleted_at）', del.error === '42501', del)
  ok('移行は begin … commit で包んでいる', /^begin;$/m.test(MIG) && /^commit;$/m.test(MIG))
  const again = await tryq(MIG_BODY)
  const last = Array.isArray(again.rows) ? again.rows : []
  ok('もう一度流しても通り、最後の確かめが ok', again.code === null && last.length === 1 && last[0].result === 'ok', again)
  const kept = (await q(`select count(*)::int n from public.daycare_contact_notes where resident_id = 1101`))[0].n
  ok('流し直しても記録は消えない', kept === 1, kept)
})

await client.end()
console.log(failed ? `\n失敗 ${failed} 件` : '\nすべて成功')
process.exit(failed === 0 ? 0 : 1)
