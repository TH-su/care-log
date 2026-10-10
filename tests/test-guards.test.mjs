// 試験そのものの穴をふさぐ回帰テスト（2026-10-10 監査 F69・F13）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// F69: db.ts（など試験の対象）を Node で読み込めなくなった時に、同期の試験がまとめて「スキップ」になって npm test が
//      成功のまま公開されていた。読み込めない理由が古い Node でなければ失敗にすること（tests/ts-load.mjs）と、
//      公開の workflow がスキップを1件でも見たら止めることを確かめる。
// F13: 0011 などのサーバーの関数を素の Postgres で流す実行器（tests/*-pg.mjs）が npm test にも CI にも入っておらず、
//      移行か JS の写しの片方だけを直しても誰も気づけなかった。実行器が揃っていて、GitHub Actions が毎回
//      tests/pg-run-all.mjs で全部流すことを、DB なしで確かめる（DB を使う中身の確認は pg-contract の workflow）。
// 個人情報は扱わない。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { tsRuntimeReady, describeLoadError } from './ts-load.mjs'
import { PG_CRON_EXTENSION, PG_STUB_FILES, isLocalPgUrl, listMigrations, listPgRunners, migrationSqlForTest } from './pg-run-all.mjs'

const TESTS = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(TESTS, '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

/** 子の node を動かして、終了コードと出力を返す（CI の印は外す＝「この Node で読めるはず」の側を試す） */
function runNode(args, { timeout = 180_000 } = {}) {
  // NODE_TEST_CONTEXT を外す（node --test の子として動くと、結果を文字でなく親向けの形式で書くため）
  const childEnv = { ...process.env, CI: '' }
  delete childEnv.NODE_TEST_CONTEXT
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd: ROOT, env: childEnv, maxBuffer: 1 << 27, timeout },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}\n${stderr}` }),
    )
  })
}

// ══════════════════════════════════════════════════════════════
// F69 読み込めない時はスキップでなく失敗
// ══════════════════════════════════════════════════════════════

describe('F69 試験の対象を読み込めない時の扱い（tests/ts-load.mjs）', () => {
  it('例外の文言を結果に出す（原因を隠さない）', () => {
    assert.equal(describeLoadError(new SyntaxError('TypeScript enum is not supported in strip-only mode')), 'SyntaxError: TypeScript enum is not supported in strip-only mode')
    assert.match(describeLoadError(null), /原因不明/)
  })

  it('この Node で読めるはずなのに読めなかった時は、スキップでなく失敗で終わる（元の例外を出す）', { skip: tsRuntimeReady({ hooks: true }) ? false : 'この Node は型の除去か解決フックを持たない（古い Node）' }, async () => {
    const helper = pathToFileURL(path.join(TESTS, 'ts-load.mjs')).href
    const code = `import { registerLoadFailure } from ${JSON.stringify(helper)}\nregisterLoadFailure('F69の確かめ', new Error('F69-probe-cause'), '古い Node', { hooks: true })\n`
    const r = await runNode(['--no-warnings', '--input-type=module', '-e', code])
    assert.notEqual(r.code, 0, `失敗で終わっていない:\n${r.out}`)
    assert.match(r.out, /F69-probe-cause/)
    assert.doesNotMatch(r.out, /ℹ skipped [1-9]/)
  })

  // db.ts に Node の型除去では読めない書き方（enum）が入った状態を、読み込みのフックで作る（本体は書き換えない）
  const BREAK_DB = `import { registerHooks } from 'node:module'
registerHooks({ load(url, ctx, next) {
  const r = next(url, ctx)
  if (/\\/src\\/lib\\/db\\.ts(\\?|$)/.test(url)) return { ...r, source: String(r.source) + '\\nexport enum F69Probe { A }\\n' }
  return r
} })`
  const preload = `--import=data:text/javascript,${encodeURIComponent(BREAK_DB)}`
  const files = ['logic.test.mjs', 'notes.test.mjs', 'med.test.mjs', 'incident.test.mjs', 'sync-gaps.test.mjs']
  for (const f of files) {
    it(`db.ts を読み込めない時、${f} はスキップで成功せず、失敗で終わって本当の原因（enum）を出す`, { skip: tsRuntimeReady({ hooks: true }) ? false : '古い Node' }, async () => {
      const r = await runNode(['--experimental-strip-types', '--no-warnings', preload, path.join('tests', f)])
      assert.notEqual(r.code, 0, `${f} が成功で終わった（同期の試験が黙って消える）:\n${r.out.slice(-3000)}`)
      assert.match(r.out, /enum/i, `${f} の結果に本当の原因が出ていない:\n${r.out.slice(-3000)}`)
    })
  }

  it('公開の workflow は、試験のスキップが1件でもあれば止める（件数の行が読めない時も止める）', () => {
    const y = read('.github/workflows/deploy.yml')
    const test = y.slice(y.indexOf('- name: Test'), y.indexOf('- name: Build'))
    assert.match(test, /set -o pipefail/)
    assert.match(test, /npm test 2>&1 \| tee /)
    assert.match(test, /grep -Eq '\^\(ℹ\|#\) skipped 0\$'/)
    assert.match(test, /exit 1/)
    assert.ok(y.indexOf('- name: Test') < y.indexOf('- name: Build'), '試験より先にビルド・公開している')
  })
})

// ══════════════════════════════════════════════════════════════
// F13 素の Postgres の実行器を毎回流す
// ══════════════════════════════════════════════════════════════

describe('F13 素の Postgres の契約の実行器と GitHub Actions', () => {
  const runners = listPgRunners()

  it('実行器（tests/*-pg.mjs）が揃っている: 0011 の契約の表・同時実行・0017・0020・0021〜', () => {
    const onDisk = readdirSync(TESTS).filter((f) => /-pg\.mjs$/.test(f)).sort()
    assert.deepEqual([...runners].sort(), onDisk, 'pg-run-all が拾う実行器と tests/ の実行器が食い違う')
    for (const f of ['cell-contract-pg.mjs', 'concurrent-pg.mjs', 'note-contract-pg.mjs', 'vital-delete-pg.mjs', 'migrations-pg.mjs']) {
      assert.ok(runners.includes(f), `${f} が無い`)
    }
    assert.equal(runners.at(-1), 'concurrent-pg.mjs', '行を確定させる同時実行の試験は最後に流す')
  })

  it('どの実行器も本番に向かない（127.0.0.1／localhost 以外を断る）・食い違いを終了コードで返す', () => {
    for (const f of runners) {
      const s = readFileSync(path.join(TESTS, f), 'utf8')
      assert.ok(s.includes('(127\\.0\\.0\\.1|localhost)'), `${f} にローカル限定の確かめが無い`)
      assert.match(s, /process\.exit\(2\)/, `${f} が接続先の誤りで止まらない`)
      assert.match(s, /process\.exit\(failed === 0 \? 0 : 1\)/, `${f} が食い違いを終了コードで返さない`)
    }
    assert.equal(isLocalPgUrl('postgres://postgres@127.0.0.1:5432/postgres'), true)
    assert.equal(isLocalPgUrl('postgres://postgres@localhost/postgres'), true)
    assert.equal(isLocalPgUrl('postgres://postgres.abc@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres'), false)
    assert.equal(isLocalPgUrl(undefined), false)
  })

  it('ログイン中の uid は request.jwt.claims に置き（真似の auth.uid() が読む場所）、変更の記録の changed_by_uid も比べる', () => {
    for (const f of runners) {
      const s = readFileSync(path.join(TESTS, f), 'utf8')
      assert.doesNotMatch(s, /request\.jwt\.claim\.sub/, `${f} が古い置き場所（claim.sub）を使っている＝auth.uid() が null のまま通る`)
    }
    const stub = read('tests/pg-supabase-stub.sql')
    assert.match(stub, /current_setting\('request\.jwt\.claims', true\)/)
    for (const f of ['note-contract-pg.mjs', 'cell-contract-pg.mjs']) {
      assert.match(readFileSync(path.join(TESTS, f), 'utf8'), /changed_by_uid/, `${f} が changed_by_uid を比べていない`)
    }
  })

  it('0011 の実行器は契約の表を Postgres と偽物の両方で流す・同時実行は §7 の5種を流す', () => {
    const cell = read('tests/cell-contract-pg.mjs')
    assert.match(cell, /import \{[^}]*CELL_CONTRACT_CASES[^}]*runContractCaseOnFake[^}]*\} from '\.\/cell-contract\.mjs'/)
    assert.match(cell, /apply_cell_edits/)
    assert.match(cell, /test\.member/)
    const conc = read('tests/concurrent-pg.mjs')
    for (const k of ['同時に作る', '基準の食い違い', '血圧の片側', '冪等キーの二重送信', '取り消された行への編集']) assert.ok(conc.includes(k), `同時実行の場面が無い: ${k}`)
    assert.match(conc, /wait_event_type/, '行ロックで待たされたかを確かめていない')
    assert.match(read('tests/vital-delete-pg.mjs'), /取り消し → 復元/, '取り消し→復元の一巡が無い')
  })

  it('DB の用意に要る真似はリポジトリの中にある（care-backend やこの端末の場所を読まない）', () => {
    for (const f of PG_STUB_FILES) {
      const s = readFileSync(path.join(TESTS, f), 'utf8')
      assert.ok(s.length > 0, `${f} が空`)
    }
    const all = read('tests/pg-run-all.mjs')
    assert.doesNotMatch(all, /\/Users\/|care-backend\/supabase/, 'この端末の場所を読んでいる（CI では読めない）')
    const stub = read('tests/pg-supabase-stub.sql')
    for (const role of ['anon', 'authenticated', 'service_role']) assert.match(stub, new RegExp(`rolname = '${role}'`))
    const backend = read('tests/pg-backend-stub.sql')
    for (const k of ['private.is_member()', 'private.my_tenant()', 'public.kv_entries', 'cron.schedule']) assert.ok(backend.includes(k), `${k} の真似が無い`)
  })

  it('0015 の pg_cron の読み込みだけを外す（他の移行は一字も変えない・外す文が無ければ止まる）', () => {
    const migs = listMigrations()
    assert.ok(migs.length >= 30 && migs[0].startsWith('0001_'), `移行の一覧が読めない: ${migs.length}`)
    for (const f of migs) {
      const text = read(`supabase/migrations/${f}`)
      const out = migrationSqlForTest(f, text)
      if (f.startsWith('0015_')) {
        assert.ok(text.includes(PG_CRON_EXTENSION))
        assert.ok(!out.includes(PG_CRON_EXTENSION))
        assert.equal(out.replace(/-- （試験の DB では[^\n]*/, PG_CRON_EXTENSION), text)
      } else {
        assert.equal(out, text, `${f} を変えている`)
      }
    }
    assert.throws(() => migrationSqlForTest('0015_x.sql', 'select 1;'), /pg_cron/)
  })

  it('GitHub Actions が push のたびに postgres サービスで pg-run-all を流す（公開の workflow とは別）', () => {
    const y = read('.github/workflows/pg-contract.yml')
    assert.match(y, /^on:\n {2}push:/m)
    assert.match(y, /services:\n {6}postgres:\n {8}image: postgres:\d+/)
    assert.match(y, /--health-cmd "pg_isready/)
    assert.match(y, /run: npm ci/)
    assert.match(y, /run: node tests\/pg-run-all\.mjs/)
    assert.match(y, /CARELOG_PG_ADMIN_URL: postgres:\/\/postgres@127\.0\.0\.1:5432\/postgres/)
    assert.doesNotMatch(y, /secrets\./, '本番の接続情報を使っている')
    assert.doesNotMatch(read('.github/workflows/deploy.yml'), /pg-run-all/, '公開の workflow に DB の試験を混ぜている（DB の不調で公開が止まる）')
  })

  it('設計文書・試験の注記が「実行器がある・CI で毎回流す」になっている', () => {
    const ce = read('docs/design/concurrent-entry.md')
    const sec7 = ce.slice(ce.indexOf('## 7. 検証'), ce.indexOf('## 8.'))
    for (const k of ['tests/cell-contract-pg.mjs', 'tests/concurrent-pg.mjs', 'tests/pg-run-all.mjs', 'pg-contract']) assert.ok(sec7.includes(k), `§7 に ${k} が無い`)
    const qa = read('docs/design/qa-verification.md')
    assert.ok(qa.includes('tests/pg-run-all.mjs'), 'qa-verification.md に手順が無い')
    assert.match(read('tests/cell-contract.mjs').slice(0, 800), /tests\/cell-contract-pg\.mjs/)
  })
})
