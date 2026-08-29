#!/usr/bin/env node
// =====================================================================
// importer の結合テスト（ローカル PostgreSQL＋偽GASサーバで通しの動作を検証する）
//
// 前提: ローカルに PostgreSQL が起動していること（既定 127.0.0.1:55432 / postgres）。
//   TEST_PG_URL_BASE で変えられる（例 postgresql://postgres@127.0.0.1:5432）。
//   anon / authenticated ロールが無いクラスタでは先に作ること（0001 が GRANT する）。
//
// npm test には含めない（DBが要るため）。手動で:  node tools/import-test.mjs
//
// 検証すること（移行計画 §3 の安全装置を1つずつ）:
//    1. ドライランは1行も書かない
//    2. 取込の中身（after16 の判定・空行の除外・flags の保存・食の展開）
//    3. 恒等式が import_days に記録される
//    4. 再実行で inserted=0（冪等）
//    5. アプリ入力の行を上書きしない（native_skip）
//    6. 照合できない氏名は取り込まず、名寄せ表を書けば再実行で入る
//    7. アプリ側で編集した列（color）を importer が触らない
//    8. 移行元の編集・削除・追加への追従（update / soft delete / insert）
//    9. after16 が後から取れた日の再判定（false 確定でない行だけが直る）
// =====================================================================

import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import pg from 'pg'
import { startFixture } from './import-fixture-server.mjs'

const { Client } = pg
pg.types.setTypeParser(1082, (v) => v)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.TEST_PG_URL_BASE ?? 'postgresql://postgres@127.0.0.1:55432'
const DBNAME = 'carelog_imp_test'
const DB_URL = `${BASE}/${DBNAME}`
const NAMEMAP = join(ROOT, 'tools', 'import-namemap.json')

let passed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
    process.exitCode = 1
    throw new Error(`検証失敗: ${name}`)
  }
}

function psql(dbUrlOrDb, sqlOrFile, isFile = false) {
  const args = ['-v', 'ON_ERROR_STOP=1', '-q', '-d', dbUrlOrDb]
  args.push(isFile ? '-f' : '-c', sqlOrFile)
  const r = spawnSync('psql', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`psql 失敗: ${r.stderr.slice(0, 500)}`)
  return r.stdout
}

/**
 * importer を子プロセスで実行する。
 * ★spawnSync は使わない: 親のイベントループごと止まり、親の中で動いている
 *   偽GASサーバが応答できなくなる（子は応答を待ち続ける＝デッドロック。実測で確認）。
 */
function runImporter(env, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['tools/import.mjs', ...extra], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

/** importer の合計行（events/measures）を stdout から数値で取り出す */
function parseTotals(stdout) {
  const out = {}
  const re = /(events|measures): 対象 (\d+) \/ 追加 (\d+) \/ 更新 (\d+) \/ 変更なし等 (\d+) \/ アプリ入力保護 (\d+) \/ 照合不能 (\d+)/g
  let m
  while ((m = re.exec(stdout)) !== null) {
    out[m[1]] = { src: +m[2], ins: +m[3], upd: +m[4], skip: +m[5], native: +m[6], unm: +m[7] }
  }
  return out
}

async function main() {
  if (existsSync(NAMEMAP)) {
    console.error(`tools/import-namemap.json が既に存在します。上書きしないため中止します。`)
    process.exit(1)
  }
  const reportDir = mkdtempSync(join(tmpdir(), 'care-log-import-test-'))

  console.log('── 準備: テストDBを作成してマイグレーションを適用 ──')
  psql(`${BASE}/postgres`, `drop database if exists ${DBNAME}`)
  psql(`${BASE}/postgres`, `create database ${DBNAME}`)
  psql(DB_URL, 'create schema if not exists extensions')
  psql(DB_URL, 'create extension if not exists pg_trgm with schema extensions')
  psql(DB_URL, 'create publication supabase_realtime') // 0001 が set table する前提
  for (const f of ['0001_init.sql', '0002_timeline_rpc.sql', '0003_sheet_ui.sql', '0004_vitals_client_key.sql', '0005_meals_sheet_fluids.sql']) {
    psql(DB_URL, join(ROOT, 'supabase', 'migrations', f), true)
  }

  const db = new Client({ connectionString: DB_URL })
  await db.connect()
  const one = async (sql, params) => (await db.query(sql, params)).rows[0]
  const num = async (sql, params) => Number((await one(sql, params)).n)

  // マスタ（合成のみ）。退居者も1名混ぜる＝過去記録の帰属が生きることの確認
  await db.query(`insert into residents (source_id, name, room, active) values
    ('R01','利用者01','101',true), ('R02','利用者02','102',true), ('R03','利用者03','103',true),
    ('R04','利用者04','104',true), ('R05','利用者05','105',false)`)
  await db.query(`insert into staff (name) values ('職員01'), ('職員02'), ('職員03')`)
  // アプリ入力の先住行（import_key なし）: 利用者02 の 6/2 定時
  await db.query(`insert into vitals (resident_id, measured_on, kind, temp)
    select id, '2026-06-02', 'routine', 37.5 from residents where source_id = 'R02'`)

  const fx = await startFixture()
  const env = {
    CARELOG_GAS_URL: fx.url,
    CARELOG_GAS_TOKEN: fx.token,
    SUPABASE_DB_URL: DB_URL,
  }
  const argsBase = ['--from', '2026-06-01', '--to', '2026-06-03', '--report-dir', reportDir]

  try {
    console.log('── 1. ドライラン ──')
    let r = await runImporter(env, [...argsBase])
    ok('ドライランが正常終了する', r.status === 0, r.stdout + r.stderr)
    ok('notes に1行も書いていない', (await num('select count(*)::int as n from notes')) === 0)
    ok('vitals はアプリ入力の1行だけ', (await num('select count(*)::int as n from vitals')) === 1)
    ok('import_days に1行も書いていない', (await num('select count(*)::int as n from import_days')) === 0)

    console.log('── 2. 取込（--execute）──')
    r = await runImporter(env, [...argsBase, '--execute'])
    ok('取込が正常終了する', r.status === 0, r.stdout + r.stderr)

    // notes: k1,k2,k3,k4,k5,k6（6/1）+ k8（6/2）＝7。k7 は照合不能で入らない
    ok('notes が7件', (await num('select count(*)::int as n from notes')) === 7)
    const k2 = await one(`select after16, occurred_at, reporter_id from notes where import_key = 'ev:k2'`)
    ok('区切り(40)より後の row 42 は after16=true', k2.after16 === true)
    ok('時刻 16:30 が入る', String(k2.occurred_at).startsWith('16:30'))
    ok('記入者（職員02）が紐づく', k2.reporter_id != null)
    const k1 = await one(`select after16, resident_id from notes where import_key = 'ev:k1'`)
    ok('区切りより前の row 31 は after16=false', k1.after16 === false)
    const k8 = await one(`select after16 from notes where import_key = 'ev:k8'`)
    ok('区切り不明の日（6/2）は after16=false のまま', k8.after16 === false)
    const k3 = await one(`select resident_id, category from notes where import_key = 'ev:k3'`)
    ok('notice 行は resident_id なしで入る', k3.resident_id == null && k3.category === 'notice')
    const k5 = await one(`select reporter_id from notes where import_key = 'ev:k5'`)
    ok('夜勤は記入者なしで入る', k5.reporter_id == null)

    // vitals: 6/1 = 利用者01・02・05(flagsのみ) ＋ 6/2 = 利用者01
    //         ＋ 6/3 = 利用者03（2タブ重複を1件に絞る）・利用者01（小数の丸め）＝ 6
    //         利用者04 は空行で入らない。利用者02 の 6/2 はアプリ入力があるので native_skip
    ok('vitals の取込行が6件', (await num(`select count(*)::int as n from vitals where import_key like 'vt:%'`)) === 6)
    const v05 = await one(`select temp, raw_flags from vitals v join residents r on r.id = v.resident_id where r.source_id = 'R05' and v.measured_on = '2026-06-01'`)
    ok('退居者の過去記録も入り flags が残る', v05 != null && v05.raw_flags?.flags === '数値読めず')
    const vNative = await one(`select temp, import_key from vitals v join residents r on r.id = v.resident_id where r.source_id = 'R02' and v.measured_on = '2026-06-02'`)
    ok('アプリ入力の行が守られる（37.5のまま・import_keyなし）', Number(vNative.temp) === 37.5 && vNative.import_key == null)

    // meals: 6/1 = 利用者01×2食 + 利用者02(flagsのみ朝) + 利用者03×1食、6/2 = 利用者01昼 ＝ 5
    ok('meals が5件', (await num('select count(*)::int as n from meals')) === 5)
    const mFlag = await one(`select main_amount, raw_flags from meals m join residents r on r.id = m.resident_id where r.source_id = 'R02' and m.meal_on = '2026-06-01'`)
    ok('全食空でも flags は朝の枠に残る', mFlag.main_amount == null && mFlag.raw_flags?.flags === '外泊')

    // import_days と恒等式
    const idRows = (await db.query(`select source, day::text, src_rows, inserted, updated, skipped, native_skip, unmatched from import_days order by source, day`)).rows
    ok('import_days が6行（events×3日 + measures×3日）', idRows.length === 6, JSON.stringify(idRows))
    for (const row of idRows) {
      ok(
        `恒等式が成立（${row.source} ${row.day}）`,
        row.src_rows === row.inserted + row.updated + row.skipped + row.native_skip + row.unmatched,
        JSON.stringify(row),
      )
    }
    const evD1 = idRows.find((x) => x.source === 'events' && x.day === '2026-06-01')
    ok('events 6/1: 対象7・追加6・照合不能1', evD1.src_rows === 7 && evD1.inserted === 6 && evD1.unmatched === 1)
    const evD3 = idRows.find((x) => x.source === 'events' && x.day === '2026-06-03')
    ok('記録が無い日も「取込済み・0件」で残る（未取込と区別できる）', evD3 != null && evD3.src_rows === 0)
    const msD2 = idRows.find((x) => x.source === 'measures' && x.day === '2026-06-02')
    ok('measures 6/2: native_skip=1', msD2.native_skip === 1, JSON.stringify(msD2))

    console.log('── 2b. レビューで見つかった欠陥の回帰チェック ──')
    // 同一枠に移行元の行が2つ（居室移動でタブ違い）→ 23505 で窓ごと落ちず、1件に絞られる
    ok(
      '同一枠の重複行が1件に絞られる（23505 で窓が落ちない）',
      (await num(`select count(*)::int as n from vitals v join residents r on r.id = v.resident_id
                   where r.source_id = 'R03' and v.measured_on = '2026-06-03' and v.deleted_at is null`)) === 1,
    )
    ok('重複を絞っても取込は成功している（6/3 の measures が台帳にある）',
      (await num(`select count(*)::int as n from import_days where source = 'measures' and day = '2026-06-03'`)) === 1)
    // DB の numeric(3,1) / smallint に合わせて丸めてから入れている
    const rounded = await one(`select temp, sys_bp from vitals v join residents r on r.id = v.resident_id
                                where r.source_id = 'R01' and v.measured_on = '2026-06-03'`)
    ok('小数は列の型に合わせて丸めて入る（36.55→36.6 / 120.4→120）',
      Number(rounded.temp) === 36.6 && Number(rounded.sys_bp) === 120, JSON.stringify(rounded))

    console.log('── 3. 再実行（冪等） ──')
    r = await runImporter(env, [...argsBase, '--execute'])
    ok('再実行が正常終了する', r.status === 0, r.stdout + r.stderr)
    {
      const t = parseTotals(r.stdout)
      ok('再実行で追加0・更新0（events）', t.events?.ins === 0 && t.events?.upd === 0, r.stdout)
      ok('再実行で追加0・更新0（measures）', t.measures?.ins === 0 && t.measures?.upd === 0, r.stdout)
    }
    ok('notes は7件のまま', (await num('select count(*)::int as n from notes')) === 7)

    console.log('── 4. 名寄せ表で照合不能が入る ──')
    writeFileSync(NAMEMAP, JSON.stringify({ residents: { 未知利用者99: 'R04' } }))
    r = await runImporter(env, [...argsBase, '--execute'])
    ok('名寄せ後の実行が正常終了する', r.status === 0, r.stdout + r.stderr)
    ok('k7 が利用者04 として入る', (await num(`select count(*)::int as n from notes n2 join residents r2 on r2.id = n2.resident_id where n2.import_key = 'ev:k7' and r2.source_id = 'R04'`)) === 1)
    ok('vitals の照合不能も入り7件になる', (await num(`select count(*)::int as n from vitals where import_key like 'vt:%'`)) === 7)

    console.log('── 5. アプリ側の編集を尊重する ──')
    await db.query(`update notes set color = 'pink' where import_key = 'ev:k2'`)
    r = await runImporter(env, [...argsBase, '--execute'])
    ok('実行後も color が残る', (await one(`select color from notes where import_key = 'ev:k2'`)).color === 'pink')

    console.log('── 6. 移行元の編集・削除・追加への追従（v2）──')
    await fetch(`${fx.url}?action=___state&v=2`)
    r = await runImporter(env, [...argsBase, '--execute'])
    ok('v2 の実行が正常終了する', r.status === 0, r.stdout + r.stderr)
    const k1v2 = await one(`select body, rev, deleted_at from notes where import_key = 'ev:k1'`)
    ok('編集が反映される（body 追記・rev が上がる）', k1v2.body.includes('追記あり') && k1v2.rev >= 2)
    const k5v2 = await one(`select deleted_at from notes where import_key = 'ev:k5'`)
    ok('移行元で消えた行に soft delete が付く', k5v2.deleted_at != null)
    ok('追加行 k9 が入る', (await num(`select count(*)::int as n from notes where import_key = 'ev:k9' and deleted_at is null`)) === 1)
    const k8v2 = await one(`select after16 from notes where import_key = 'ev:k8'`)
    ok('後から区切りが取れた日の after16 が true に直る', k8v2.after16 === true)
    ok('アプリ入力の行は追従の対象外（残っている）', (await num(`select count(*)::int as n from vitals where import_key is null and deleted_at is null`)) === 1)
    // 移行元で「昼の値だけ消した」時、行は生きているので消してはいけない（安全装置4）
    const lunchAfter = await one(`select deleted_at, main_amount, side_amount from meals m
                                    join residents r on r.id = m.resident_id
                                   where r.source_id = 'R01' and m.meal_on = '2026-06-01' and m.meal_slot = 'lunch'`)
    ok('値だけ消された食の行を soft delete しない', lunchAfter != null && lunchAfter.deleted_at == null, JSON.stringify(lunchAfter))
    ok('値だけ消されても既存の値を空で上書きしない', Number(lunchAfter.main_amount) === 8, JSON.stringify(lunchAfter))

    console.log('── 7. v2 後の再実行も冪等 ──')
    r = await runImporter(env, [...argsBase, '--execute'])
    {
      const t = parseTotals(r.stdout)
      ok('再実行で追加0・更新0', t.events?.ins === 0 && t.events?.upd === 0 && t.measures?.ins === 0 && t.measures?.upd === 0, r.stdout)
    }

    // 報告ファイルが書かれていること（氏名を含むのでリポジトリ外に置く仕様）
    const reports = readdirSync(reportDir).filter((f) => f.endsWith('.md'))
    ok('報告ファイルが生成される', reports.length >= 1)

    console.log('')
    console.log(`全 ${passed} 件 合格`)
  } finally {
    await db.end()
    await fx.close()
    if (existsSync(NAMEMAP)) rmSync(NAMEMAP)
    rmSync(reportDir, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(String(e.message ?? e))
  process.exit(1)
})
