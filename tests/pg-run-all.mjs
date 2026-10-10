// 素の Postgres でサーバーの契約を確かめる実行器を、DB の用意からまとめて流す（2026-10-10 監査 F13）。
// GitHub Actions（.github/workflows/pg-contract.yml）が毎回これを流す。手元でも同じ1本で流せる。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない＝127.0.0.1／localhost 以外は断る）。
//
//   CARELOG_PG_ADMIN_URL=postgres://postgres@127.0.0.1:<port>/postgres node tests/pg-run-all.mjs
//
// 流れ:
//   1. 試験用の DB（既定 carelog_pgtest_tpl）を作り直し、Supabase の真似（tests/pg-supabase-stub.sql）・care-backend の部品の真似
//      （tests/pg-backend-stub.sql）・Realtime 認可の真似（tests/pg-realtime-stub.sql）を当ててから、supabase/migrations の
//      0001〜最新を番号順に当てる（1つでも失敗したら止める）。時刻帯は本番の Supabase と同じ UTC にそろえる
//   2. 0021 以降（本人回答 4: 新しい移行は何度流しても同じ）をもう一度当て、2回目でも失敗しないことを確かめる
//   3. tests/*-pg.mjs（実行器）を1本ずつ、上の DB を写した新しい DB で流す（実行器どうしが残した行に左右されない）
// 終了コード: すべて成功で 0・どれか失敗で 1・接続先が使い捨てでない時は 2。
// 個人情報は扱わない（実行器は合成の 利用者01・職員01 と数値IDだけを使う）。

import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(TESTS_DIR, '..')
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations')

/** 当てる順の真似（本番の Supabase には最初からあるので流さない） */
export const PG_STUB_FILES = ['pg-supabase-stub.sql', 'pg-backend-stub.sql', 'pg-realtime-stub.sql']

/** 0021 以降は何度流しても同じ（冪等）であること。0001〜0020 は本番に当たった中身のまま書き換えないので対象外 */
export const IDEMPOTENT_FROM = 21

/** 使い捨てのローカル DB だけを受け付ける（本番の Supabase に向けない） */
export function isLocalPgUrl(url) {
  return typeof url === 'string' && /^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(url)
}

/** tests/ の実行器（*-pg.mjs）。名前の順。同時実行の試験（concurrent-pg）は行を確定させるので最後に回す */
export function listPgRunners(dir = TESTS_DIR) {
  const files = readdirSync(dir).filter((f) => /-pg\.mjs$/.test(f))
  return files.sort((a, b) => (a === 'concurrent-pg.mjs') - (b === 'concurrent-pg.mjs') || a.localeCompare(b))
}

/** supabase/migrations の移行（番号順） */
export function listMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
}

/** pg_cron の読み込み（0015）。素の Postgres には pg_cron が無いので、試験の DB に当てる時だけこの1文を外す（cron の真似を使う） */
export const PG_CRON_EXTENSION = 'create extension if not exists pg_cron with schema pg_catalog;'

/** 試験の DB に当てる移行の本文（0015 の pg_cron の1文だけ外す。外す文が見つからなければ例外＝気づかずに素通りさせない） */
export function migrationSqlForTest(file, text) {
  if (!file.startsWith('0015_')) return text
  const n = text.split(PG_CRON_EXTENSION).length - 1
  if (n !== 1) throw new Error(`${file}: 外す pg_cron の1文がちょうど1つ見つかりません（${n} 件）`)
  return text.replace(PG_CRON_EXTENSION, '-- （試験の DB では pg_cron の読み込みを外す。cron.schedule は tests/pg-backend-stub.sql の真似）')
}

/** 接続先の DB 名だけを差し替えた URL */
function withDatabase(url, db) {
  const u = new URL(url)
  u.pathname = `/${db}`
  return u.toString()
}

async function main() {
  const admin = process.env.CARELOG_PG_ADMIN_URL ?? process.env.CARELOG_PG_URL
  if (!isLocalPgUrl(admin)) {
    console.error('CARELOG_PG_ADMIN_URL に使い捨てのローカル Postgres（127.0.0.1／localhost の管理用 DB。例 postgres://postgres@127.0.0.1:5432/postgres）を指定してください。')
    process.exit(2)
  }
  const tpl = process.env.CARELOG_PG_DB ?? 'carelog_pgtest_tpl'
  if (!/^carelog_pgtest[a-z0-9_]*$/.test(tpl)) {
    console.error('CARELOG_PG_DB は carelog_pgtest で始まる名前にしてください（試験用の DB だけを作り直すため）。')
    process.exit(2)
  }
  const { default: pg } = await import('pg')
  const connect = async (url) => {
    const c = new pg.Client({ connectionString: url })
    await c.connect()
    return c
  }

  // 1. 作り直して、真似と移行を当てる
  const a = await connect(admin)
  await a.query(`drop database if exists ${tpl} with (force)`)
  await a.query(`create database ${tpl} template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`)
  await a.query(`alter database ${tpl} set timezone to 'UTC'`)
  const tplUrl = withDatabase(admin, tpl)
  const db = await connect(tplUrl)
  const apply = async (label, sql) => {
    try {
      await db.query(sql)
    } catch (e) {
      throw new Error(`${label} を当てられませんでした: ${e.code ?? ''} ${e.message}${e.position ? `（位置 ${e.position}）` : ''}`)
    }
  }
  let failed = 0
  try {
    for (const f of PG_STUB_FILES) await apply(`tests/${f}`, readFileSync(path.join(TESTS_DIR, f), 'utf8'))
    const migrations = listMigrations()
    for (const f of migrations) await apply(`supabase/migrations/${f}`, migrationSqlForTest(f, readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')))
    console.log(`移行 ${migrations.length} 本を当てた（${migrations[0]} 〜 ${migrations.at(-1)}）`)

    // 2. 0021 以降の流し直し（冪等）
    for (const f of migrations.filter((m) => Number(m.slice(0, 4)) >= IDEMPOTENT_FROM)) {
      try {
        await db.query(migrationSqlForTest(f, readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')))
        console.log(`ok 流し直し（冪等）: ${f}`)
      } catch (e) {
        failed += 1
        console.log(`NG 流し直し（冪等）: ${f}\n   ${e.code ?? ''} ${e.message}`)
      }
    }
  } catch (e) {
    console.error(String(e.message ?? e))
    await db.end()
    await a.end()
    process.exit(1)
  }
  await db.end()

  // 3. 実行器を1本ずつ、写した DB で流す
  const runners = listPgRunners()
  const results = []
  for (const [i, r] of runners.entries()) {
    const name = `${tpl.replace(/_tpl$/, '')}_${i + 1}`
    await a.query(`drop database if exists ${name} with (force)`)
    await a.query(`create database ${name} template ${tpl}`)
    // 写した DB には DB ごとの設定（alter database … set）が写らないので、時刻帯をもう一度 UTC にそろえる
    await a.query(`alter database ${name} set timezone to 'UTC'`)
    console.log(`\n── ${r}（DB: ${name}）`)
    const out = spawnSync(process.execPath, [path.join(TESTS_DIR, r)], {
      env: { ...process.env, CARELOG_PG_URL: withDatabase(admin, name) },
      stdio: 'inherit',
      timeout: 5 * 60_000,
    })
    const code = out.status ?? 1
    results.push([r, code])
    await a.query(`drop database if exists ${name} with (force)`)
  }
  await a.end()

  console.log('\n── まとめ')
  for (const [r, code] of results) console.log(`${code === 0 ? 'ok' : 'NG'} ${r}（終了コード ${code}）`)
  const bad = results.filter(([, code]) => code !== 0).length + failed
  if (runners.length === 0) {
    console.log('NG 実行器（tests/*-pg.mjs）が1本も見つかりません')
    process.exit(1)
  }
  console.log(bad === 0 ? `\nすべて一致（実行器 ${runners.length} 本・流し直し含む）` : `\n食い違い・失敗が ${bad} 件`)
  process.exit(bad === 0 ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
