// 0057（取込の道具の版を記録する）を、素の Postgres（0001〜最新を適用済み）で確かめる実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/import-tool-ver-pg.mjs
//
// 1. 取込の日に道具の版の列（空でよい）があり、古い版の道具の書き方（列を書かない）でも今までどおり書ける
// 2. データベースが求める版は 57・ログインした人（anon・authenticated）は呼べない
// 3. 取込の道具の版（TOOL_VER）はデータベースが求める版以上・道具はこの回に書いた取込の日にだけ版を残す
// 4. 冪等・戻す SQL で外れ、もう一度入る
// 1件ずつトランザクションを張り、最後に必ず rollback する（表に何も残さない）。個人情報は置かない。

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
const MIG = readFileSync(path.join(ROOT, 'supabase', 'migrations', '0057_import_tool_ver.sql'), 'utf8')
const BACK = readFileSync(path.join(ROOT, 'supabase', 'rollback', '0057_back.sql'), 'utf8')
const TOOL = readFileSync(path.join(ROOT, 'tools', 'import.mjs'), 'utf8')
const A = '00000000-0000-0000-0000-0000000000aa'
const client = new pg.Client({ connectionString: url })
await client.connect()
const q = async (text, params) => (await client.query(text, params)).rows
let failed = 0
const ok = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`)
  else { failed++; console.log(`  ✗ ${label}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`) }
}
async function inTx(title, fn) {
  console.log(`── ${title}`)
  await client.query('begin')
  try { await fn() } catch (e) { failed++; console.log(`  ✗ 例外: ${e?.code ?? ''} ${e?.message ?? e}`) } finally { await client.query('rollback') }
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
    return { code: e.code ?? 'x', message: e.message }
  }
}

await inTx('取込の日の道具の版の列', async () => {
  const col = await q(`select attnotnull from pg_attribute where attrelid = 'public.import_days'::regclass and attname = 'tool_ver' and not attisdropped`)
  ok('列 tool_ver があり、空でよい', col.length === 1 && col[0].attnotnull === false, col)
  const m = /`(insert into import_days[\s\S]*?where import_days\.tenant_id = excluded\.tenant_id)`/.exec(TOOL)
  ok('取込の道具の取込の日の文は変えていない（版は別の文で残す）', m !== null && !/tool_ver/.test(m[1]))
  const w = await tryq(m[1], ['events', '2026-11-01', 5, 1, 0, 4, 0, 0, A])
  ok('古い版の道具と同じ書き方（列を書かない）で書ける・版は空', w.code === null && w.rowCount === 1, w)
  const v = await q(`select tool_ver from public.import_days where tenant_id = $1 and source = 'events' and day = '2026-11-01'`, [A])
  ok('版を書かない道具の行は空のまま', v.length === 1 && v[0].tool_ver === null, v)
})

await inTx('データベースが求める版', async () => {
  const need = (await q(`select private.carelog_import_min_ver() as v`))[0].v
  ok('求める版は 57', need === 57, need)
  const tv = Number(/export const TOOL_VER = (\d+)/.exec(TOOL)?.[1])
  ok('取込の道具の版は求める版以上（古い版と判定されて止まらない）', tv >= need, { tv, need })
  for (const role of ['anon', 'authenticated']) {
    const r = await q(`select has_function_privilege($1, 'private.carelog_import_min_ver()', 'execute') as x`, [role])
    ok(`${role} は呼べない`, r[0].x === false, r)
  }
  ok('取込の道具は求める版より古ければ何も書かずに止まる（終了コード 2）',
    /if \(TOOL_VER < need\) \{[\s\S]{0,300}process\.exit\(2\)/.test(TOOL))
})

await inTx('道具はこの回に書いた取込の日にだけ版を残す', async () => {
  const m = /db\.query\('(update public\.import_days set tool_ver = \$1 where tenant_id = \$2 and imported_at >= \$3::timestamptz)'/.exec(TOOL)
  ok('版を残す文を読めた', m !== null)
  if (!m) return
  await q(`insert into public.import_days (source, day, src_rows, tenant_id, imported_at) values ('events', '2026-10-30', 1, $1, now() - interval '2 hours')`, [A])
  const start = (await q(`select now() - interval '1 minute' as t`))[0].t
  await q(`insert into public.import_days (source, day, src_rows, tenant_id) values ('events', '2026-10-31', 1, $1)`, [A])
  await q(m[1], [57, A, start])
  const rows = await q(`select day::text as d, tool_ver from public.import_days where tenant_id = $1 and day in ('2026-10-30', '2026-10-31') order by day`, [A])
  ok('この回に書いた日だけ 57・前の回の日は空のまま', rows.length === 2 && rows[0].tool_ver === null && rows[1].tool_ver === 57, rows)
})

const MIG_BODY = MIG.replace(/^begin;$/gm, '-- begin').replace(/^commit;$/gm, '-- commit')
const BACK_BODY = BACK.replace(/^begin;$/gm, '-- begin').replace(/^commit;$/gm, '-- commit')
await inTx('冪等・戻す SQL', async () => {
  ok('移行と戻す SQL は begin … commit で包み、do $$ を使わない',
    /^begin;$/m.test(MIG) && /^commit;$/m.test(MIG) && /^begin;$/m.test(BACK) && !/^\s*do\s+\$\$/im.test(MIG + BACK))
  const again = await tryq(MIG_BODY)
  ok('もう一度流しても通り、確かめが ok', again.code === null && again.rows?.[0]?.result === 'ok', again)
  const back = await tryq(BACK_BODY)
  ok('戻す SQL の確かめが ok', back.code === null && back.rows?.[0]?.result === 'ok', back)
  const re = await tryq(MIG_BODY)
  ok('戻した後にもう一度入る', re.code === null && re.rows?.[0]?.result === 'ok', re)
})

await client.end()
console.log(failed ? `\n失敗 ${failed} 件` : '\nすべて成功')
process.exit(failed === 0 ? 0 : 1)
