// 0062（デイのバイタル・食事の画面の〔未測定〕の印・2026-11-10）を、素の Postgres（0001〜最新を適用済み）で確かめる実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/daycare-unmeasured-pg.mjs
//
// 施設 A（試験の土台の施設 aa）と施設 B（この試験で足す bb）で確かめる:
//   1. 形: 施設の印が必須・印を入れるトリガ・版・変更の記録・過去の日の守りのトリガ・守り5本（tenant_only・member_only は restrictive）・
//      消す守りと権限なし・anon の権限なし・外部キーは（施設の印, 番号）の組4本と施設の表だけ・欄と回の check
//   2. ログインした人が足すと、その人の施設の印が入る・取り消し（論理削除）で rev が進む・変更の記録に施設の印つきで残る
//   3. 1つの回の1つの欄に1行（生きている行だけ）は 23505・取り消した行の後には足せる・別の回・別の欄・施設 B には並べて足せる
//   4. 欄は5つだけ・回は 1〜9999（23514）
//   5. よその施設の利用者・職員を指す行は 23503・よその施設の行は見えない・書けない・許可リストに無い人は何も見えない・anon は読めない
//   6. 物理削除はできない（delete の権限なし）・冪等（もう一度流しても通り、最後の確かめが ok）・vitals には何も足さない
//   7. 過去の日の守り: 現場（field）のログインは今日だけ書ける・過去の日は 42501（daycare_unmeasured_past_office_only）・事務所と
//      役割の分からない接続は過去の日も書ける・未来の日は誰も書けない（22023・daycare_unmeasured_future）・トリガ関数は誰も実行できない
// 日付: 1〜6 は過去の決まった日（2026-11-01〜03）を使い、役割の分からない接続（test.role 未設定＝my_role() が null）で書く
//   （過去の日の守りは役割が null なら止めない＝どの日に流しても同じ結果）。7 の今日・未来の日は SQL の now() から作る
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
const MIG = readFileSync(path.join(ROOT, 'supabase', 'migrations', '0062_daycare_vital_unmeasured.sql'), 'utf8')
/** 試験の取引の中で流す本文（移行の begin … commit を外す＝試験の取引を閉じない） */
const MIG_BODY = MIG.replace(/^begin;$/m, '-- begin').replace(/^commit;$/m, '-- commit')

const A = '00000000-0000-0000-0000-0000000000aa'
const B = '00000000-0000-0000-0000-0000000000bb'
const UID = '00000000-0000-0000-0000-000000000001'
const T = 'daycare_vital_unmeasured'
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

/** ログインした人（authenticated）として fn を流す。例外は SQLSTATE と文で返す */
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

/** 施設 B と、両方の施設の利用者・職員を置く */
async function seedTwo() {
  await q(`insert into public.tenants (id, name) values ($1, '見本の施設B') on conflict (id) do nothing`, [B])
  await q(`insert into public.residents (id, source_id, name, active, tenant_id) overriding system value
           values (1101, 'S01', '利用者01', true, $1), (1102, 'S02', '利用者02', true, $1), (2101, 'S01', '利用者01', true, $2)`, [A, B])
  await q(`insert into public.staff (id, name, tenant_id) overriding system value values (1201, '職員01', $1), (2201, '職員01', $2)`, [A, B])
}

// ── 1. 形 ──
await inTx('形: 施設の印・トリガ・守り・権限・外部キー・check', async () => {
  const nn = await q(`select 1 from information_schema.columns
                       where table_schema = 'public' and column_name = 'tenant_id' and is_nullable = 'NO' and table_name = $1`, [T])
  ok('施設の印が必須', nn.length === 1, nn)
  const names = (await q(`select g.tgname from pg_trigger g join pg_class c on c.oid = g.tgrelid
                           where not g.tgisinternal and c.relname = $1 order by 1`, [T])).map((x) => x.tgname)
  ok('印・版・変更の記録・過去の日の守りのトリガ（4本）',
    ['carelog_fill_tenant', `trg_history_${T}`, `trg_updated_${T}`, `trg_${T}_day_guard`].every((n) => names.includes(n)) && names.length === 4, names)
  const p = await q(`select policyname, permissive, cmd, roles::text roles, qual, with_check from pg_policies
                      where schemaname = 'public' and tablename = $1 order by 1`, [T])
  ok('守りは5本（read_auth・insert_auth・update_auth・member_only・tenant_only）',
    p.map((x) => x.policyname).sort().join(',') === 'insert_auth,member_only,read_auth,tenant_only,update_auth', p)
  const to = p.find((x) => x.policyname === 'tenant_only')
  ok('tenant_only は 0054 と同じ形（restrictive・全部の操作・自分の施設だけ）',
    to?.permissive === 'RESTRICTIVE' && to.cmd === 'ALL' && to.roles === '{authenticated}' && to.qual === QUAL && to.with_check === QUAL, to)
  ok('member_only は restrictive', p.find((x) => x.policyname === 'member_only')?.permissive === 'RESTRICTIVE')
  ok('消す守りは無い', !p.some((x) => x.cmd === 'DELETE'))
  const grants = await q(`select grantee, privilege_type from information_schema.role_table_grants
                           where table_schema = 'public' and table_name = $1 and grantee in ('anon', 'authenticated')`, [T])
  ok('anon には何も無い', !grants.some((g) => g.grantee === 'anon'), grants)
  ok('authenticated に delete・truncate は無い', !grants.some((g) => g.grantee === 'authenticated' && ['DELETE', 'TRUNCATE'].includes(g.privilege_type)), grants)
  ok('authenticated は読む・足す・直すができる', ['SELECT', 'INSERT', 'UPDATE'].every((pv) => grants.some((g) => g.grantee === 'authenticated' && g.privilege_type === pv)), grants)
  const fks = await q(`select k.conname, pg_get_constraintdef(k.oid) as def from pg_constraint k
                        where k.contype = 'f' and k.conrelid = 'public.${T}'::regclass order by 1`)
  ok('外部キーは（施設の印, 番号）の組4本（利用者・記録者・取り消した職員・最後に書き換えた職員）と施設の表（tenants）だけ',
    fks.every((f) => /^FOREIGN KEY \(tenant_id, [a-z_]+\) REFERENCES (residents|staff)\(tenant_id, id\)$/.test(f.def) || /^FOREIGN KEY \(tenant_id\) REFERENCES tenants\(id\)$/.test(f.def))
      && fks.filter((f) => /REFERENCES (residents|staff)/.test(f.def)).map((f) => f.conname).sort().join(',')
        === [`${T}_deleted_by_fkey`, `${T}_edited_by_fkey`, `${T}_recorded_by_fkey`, `${T}_resident_id_fkey`].join(','), fks)
  const ix = (await q(`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'uq_daycare_vital_unmeasured'`))[0]?.indexdef
  ok('一意は施設の印が先頭・生きている行だけ', ix === `CREATE UNIQUE INDEX uq_daycare_vital_unmeasured ON public.${T} USING btree (tenant_id, resident_id, day, seq, field) WHERE (deleted_at IS NULL)`, ix)
  const vcols = (await q(`select count(*)::int n from information_schema.columns where table_schema = 'public' and table_name = 'vitals'`))[0].n
  const vtrg = (await q(`select count(*)::int n from pg_trigger g join pg_class c on c.oid = g.tgrelid where not g.tgisinternal and c.relname = 'vitals'`))[0].n
  ok('（参考）vitals の列とトリガを数えて残す（下の流し直しで変わらないことを見る）', vcols > 0 && vtrg > 0, { vcols, vtrg })
})

// ── 2. 足す・取り消す・変更の記録 ──
await inTx('足す・取り消す: 施設の印が入る・rev が進む・変更の記録', async () => {
  await seedTwo()
  const ins = await asUser(A, () => q(`insert into public.${T} (resident_id, day, seq, field, recorded_by) values (1101, '2026-11-02', 1, 'temp', 1201) returning id, tenant_id, rev, deleted_at`))
  ok('ログインした人が足すと、その人の施設の印が入る（rev 1・生きている）', !ins.error && ins[0]?.tenant_id === A && ins[0].rev === 1 && ins[0].deleted_at === null, ins)
  const del = await asUser(A, () => q(`update public.${T} set deleted_at = now(), deleted_by = 1201, edited_by = 1201 where id = $1 and rev = 1 and deleted_at is null returning rev, deleted_at`, [ins[0].id]))
  ok('取り消し（論理削除）で rev が進む', !del.error && del[0]?.rev === 2 && del[0].deleted_at !== null, del)
  const stale = await asUser(A, () => q(`update public.${T} set deleted_at = now() where id = $1 and rev = 1 and deleted_at is null returning id`, [ins[0].id]))
  ok('古い rev での取り消しは0行（二重に取り消さない）', Array.isArray(stale) && stale.length === 0, stale)
  const hist = await q(`select record_day::text d, op, tenant_id, resident_id, changed_by_staff from public.record_history where table_name = $1 and row_id = $2`, [T, ins[0].id])
  ok('変更の記録に施設の印・業務日・利用者・取り消した職員が残る',
    hist.length === 1 && hist[0].tenant_id === A && hist[0].d === '2026-11-02' && Number(hist[0].resident_id) === 1101 && Number(hist[0].changed_by_staff) === 1201, hist)
  const vitals = (await q(`select count(*)::int n from public.vitals`))[0].n
  ok('印を付けても vitals には何も足さない', vitals === 0, vitals)
})

// ── 3. 一意 ──
await inTx('一意: 1つの回の1つの欄に1行（生きている行だけ）・別の回・別の欄・施設ごと', async () => {
  await seedTwo()
  await q(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, '2026-11-02', 1, 'temp', $1)`, [A])
  const d2 = await tryq(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, '2026-11-02', 1, 'temp', $1)`, [A])
  ok('同じ方・同じ日・同じ回・同じ欄の2行目は 23505', d2.code === '23505' && d2.constraint === 'uq_daycare_vital_unmeasured', d2)
  const seq2 = await tryq(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, '2026-11-02', 2, 'temp', $1)`, [A])
  ok('再測定の回（seq 2）の同じ欄は足せる', seq2.code === null, seq2)
  const other = await tryq(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, '2026-11-02', 1, 'spo2', $1)`, [A])
  ok('同じ回の別の欄は足せる', other.code === null, other)
  const nextDay = await tryq(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, '2026-11-03', 1, 'temp', $1)`, [A])
  ok('別の日の同じ欄は足せる', nextDay.code === null, nextDay)
  await q(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (2101, '2026-11-02', 1, 'temp', $1)`, [B])
  ok('施設 B は同じ日・同じ回・同じ欄に並べて足せる', true)
  await q(`update public.${T} set deleted_at = now() where resident_id = 1101 and day = '2026-11-02' and seq = 1 and field = 'temp'`)
  const again = await tryq(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, '2026-11-02', 1, 'temp', $1)`, [A])
  ok('取り消した行の後には足せる（生きている行だけで一意）', again.code === null, again)
})

// ── 4. 欄と回 ──
await inTx('欄は5つだけ・回は 1〜9999', async () => {
  await seedTwo()
  for (const f of ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2']) {
    const r = await tryq(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, '2026-11-01', 1, $1, $2)`, [f, A])
    ok(`欄 ${f} は入る`, r.code === null, r)
  }
  const bad = await tryq(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, '2026-11-01', 1, 'weight', $1)`, [A])
  ok('ほかの欄（weight）は 23514', bad.code === '23514' && bad.constraint === 'daycare_vital_unmeasured_field_check', bad)
  const s0 = await tryq(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, '2026-11-01', 0, 'temp', $1)`, [A])
  const sBig = await tryq(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, '2026-11-01', 10000, 'temp', $1)`, [A])
  const sMax = await tryq(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, '2026-11-01', 9999, 'temp', $1)`, [A])
  ok('回 0・10000 は 23514・9999 は入る', s0.code === '23514' && s0.constraint === 'daycare_vital_unmeasured_seq_check' && sBig.code === '23514' && sMax.code === null, { s0, sBig, sMax })
})

// ── 5. 施設をまたがない・許可リスト・anon ──
await inTx('施設をまたがない: よその施設の利用者・職員は 23503・よその施設の行は見えない・書けない', async () => {
  await seedTwo()
  const fkR = await asUser(A, () => q(`insert into public.${T} (resident_id, day, seq, field) values (2101, '2026-11-02', 1, 'temp')`))
  ok('よその施設の利用者を指す印は 23503', fkR.error === '23503', fkR)
  const fkS = await asUser(A, () => q(`insert into public.${T} (resident_id, day, seq, field, recorded_by) values (1101, '2026-11-02', 1, 'temp', 2201)`))
  ok('よその施設の職員を記録者にすると 23503', fkS.error === '23503', fkS)
  await q(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (2101, '2026-11-02', 1, 'temp', $1)`, [B])
  const seenA = await asUser(A, async () => (await q(`select count(*)::int n from public.${T}`))[0].n)
  ok('施設 A の人には施設 B の行が見えない', seenA === 0, seenA)
  const seenB = await asUser(B, async () => (await q(`select count(*)::int n from public.${T}`))[0].n)
  ok('施設 B の人には自分の行が見える', seenB === 1, seenB)
  const upB = await asUser(A, () => q(`update public.${T} set deleted_at = now() where resident_id = 2101 returning id`))
  ok('施設 A の人は施設 B の行を取り消せない（0行）', Array.isArray(upB) && upB.length === 0, upB)
  const move = await asUser(A, () => q(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, '2026-11-03', 1, 'temp', $1)`, [B]))
  ok('よその施設の印を付けて足すと 42501', move.error === '42501', move)
  const nonMember = await asUser(A, async () => (await q(`select count(*)::int n from public.${T}`))[0].n, { member: false })
  ok('許可リストに無い人は何も見えない', nonMember === 0, nonMember)
  const anon = await asUser(A, () => q(`select count(*) from public.${T}`), { role: 'anon' })
  ok('anon は読めない（権限なし 42501）', anon.error === '42501', anon)
})

// ── 6. 物理削除・冪等 ──
await inTx('物理削除はできない・冪等', async () => {
  await seedTwo()
  await q(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, '2026-11-02', 1, 'temp', $1)`, [A])
  const del = await asUser(A, () => q(`delete from public.${T}`))
  ok('ログインした人の delete は 42501（取り消しは deleted_at）', del.error === '42501', del)
  const trunc = await asUser(A, () => q(`truncate public.${T}`))
  ok('ログインした人の truncate は 42501', trunc.error === '42501', trunc)
  ok('移行は begin … commit で包んでいる・do $$ を使わない', /^begin;$/m.test(MIG) && /^commit;$/m.test(MIG) && !/^\s*do\s+\$\$/im.test(MIG))
  const vBefore = await q(`select (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'vitals') c,
                                  (select count(*)::int from pg_trigger g join pg_class k on k.oid = g.tgrelid where not g.tgisinternal and k.relname = 'vitals') t`)
  const again = await tryq(MIG_BODY)
  const last = Array.isArray(again.rows) ? again.rows : []
  ok('もう一度流しても通り、最後の確かめが ok', again.code === null && last.length === 1 && last[0].result === 'ok', again)
  const kept = (await q(`select count(*)::int n from public.${T} where resident_id = 1101`))[0].n
  ok('流し直しても印は消えない', kept === 1, kept)
  const vAfter = await q(`select (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'vitals') c,
                                 (select count(*)::int from pg_trigger g join pg_class k on k.oid = g.tgrelid where not g.tgisinternal and k.relname = 'vitals') t`)
  ok('vitals の列とトリガは変えない', JSON.stringify(vBefore) === JSON.stringify(vAfter), { vBefore, vAfter })
})

// ── 7. 過去の日の守り ──
/** 役割を決めてログインした人として fn を流す（test.role＝'field'・'office'・'admin'） */
async function asRole(tenant, role, fn) {
  await client.query(`select set_config('test.role', $1, true)`, [role])
  try {
    return await asUser(tenant, fn)
  } finally {
    await client.query(`select set_config('test.role', '', true)`)
  }
}
await inTx('過去の日の守り: 現場は今日だけ・過去の日は事務所・未来の日は誰も書けない', async () => {
  await seedTwo()
  const today = (await q(`select ((now() at time zone 'Asia/Tokyo')::date)::text d`))[0].d
  const tomorrow = (await q(`select ((now() at time zone 'Asia/Tokyo')::date + 1)::text d`))[0].d
  const past = '2026-11-02'
  const fToday = await asRole(A, 'field', () => q(`insert into public.${T} (resident_id, day, seq, field) values (1101, $1, 1, 'temp') returning id, rev`, [today]))
  ok('現場のログインは今日の印を付けられる', Array.isArray(fToday) && fToday.length === 1, fToday)
  const fTodayDel = await asRole(A, 'field', () => q(`update public.${T} set deleted_at = now(), deleted_by = 1201 where id = $1 and rev = $2 returning id`, [fToday[0].id, fToday[0].rev]))
  ok('現場のログインは今日の印を取り消せる', Array.isArray(fTodayDel) && fTodayDel.length === 1, fTodayDel)
  const fPast = await asRole(A, 'field', () => q(`insert into public.${T} (resident_id, day, seq, field) values (1102, $1, 1, 'temp')`, [past]))
  ok('現場のログインは過去の日の印を付けられない（42501・daycare_unmeasured_past_office_only）',
    fPast.error === '42501' && /^daycare_unmeasured_past_office_only:/.test(fPast.message ?? ''), fPast)
  const oPast = await asRole(A, 'office', () => q(`insert into public.${T} (resident_id, day, seq, field) values (1102, $1, 1, 'temp') returning id, rev`, [past]))
  ok('事務所のログインは過去の日の印を付けられる', Array.isArray(oPast) && oPast.length === 1, oPast)
  const fDel = await asRole(A, 'field', () => q(`update public.${T} set deleted_at = now() where id = $1 returning id`, [oPast[0].id]))
  ok('現場のログインは過去の日の印を取り消せない（42501）', fDel.error === '42501', fDel)
  const aDel = await asRole(A, 'admin', () => q(`update public.${T} set deleted_at = now() where id = $1 returning id`, [oPast[0].id]))
  ok('管理者のログインは過去の日の印を取り消せる', Array.isArray(aDel) && aDel.length === 1, aDel)
  const fMove = await asRole(A, 'field', () => q(`insert into public.${T} (resident_id, day, seq, field) values (1101, $1, 1, 'spo2') returning id`, [today]))
  const fMoved = await asRole(A, 'field', () => q(`update public.${T} set day = $2 where id = $1 returning id`, [fMove[0].id, past]))
  ok('現場のログインは今日の印を過去の日へ移せない（42501）', fMoved.error === '42501', fMoved)
  const futOffice = await asRole(A, 'office', () => q(`insert into public.${T} (resident_id, day, seq, field) values (1101, $1, 1, 'temp')`, [tomorrow]))
  ok('未来の日は事務所でも付けられない（22023）', futOffice.error === '22023', futOffice)
  const futServer = await tryq(`insert into public.${T} (resident_id, day, seq, field, tenant_id) values (1101, $1, 1, 'temp', $2)`, [tomorrow, A])
  ok('未来の日はサーバーの接続でも付けられない（22023・daycare_unmeasured_future）', futServer.code === '22023' && /^daycare_unmeasured_future:/.test(futServer.message), futServer)
  const fn = (await q(`select p.prosecdef, p.proconfig from pg_proc p where p.oid = 'public.daycare_vital_unmeasured_day_guard()'::regprocedure`))[0]
  ok('守りの関数は security definer・search_path を空に固定', fn?.prosecdef === true && JSON.stringify(fn.proconfig) === JSON.stringify(['search_path=""']), fn)
  const exec = (await q(`select has_function_privilege('authenticated', 'public.daycare_vital_unmeasured_day_guard()', 'execute') a,
                                has_function_privilege('anon', 'public.daycare_vital_unmeasured_day_guard()', 'execute') b`))[0]
  ok('守りの関数は authenticated・anon が実行できない（0059・0060 と同じ）', exec.a === false && exec.b === false, exec)
  // 連絡帳（0061）の守りの文とは分ける（画面が案内を取り違えない）
  ok('誤りの文の頭は連絡帳と別（daycare_contact_ で始めない）', !/daycare_contact_/.test(fPast.message ?? '') && !/daycare_contact_/.test(futServer.message ?? ''))
})

await client.end()
console.log(failed ? `\n失敗 ${failed} 件` : '\nすべて成功')
process.exit(failed === 0 ? 0 : 1)
