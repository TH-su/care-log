// 取込の道具が動き始めに自分を最新の版にする（tools/self-update.mjs・2026-11-05 本人指示「両方進めて」）の試験。
// git・npm は呼ばない（偽の run に差し替え、送られた命令と返す答えを確かめる）。
// 実行: node --test tests/import-self-update.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { selfUpdate } from '../tools/self-update.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
/** 偽の git・npm。answers は「命令の頭 → 答え（文字・例外）」 */
function fake({ branch = 'main', dirty = '', before = A, after = B, fetchFail = false, mergeFail = false, deps = '', npmFail = false } = {}) {
  const calls = []
  let head = before
  const run = (cmd, args) => {
    const c = [cmd, ...args.filter((x) => x !== '-C' && x !== '/repo')].join(' ')
    calls.push(c)
    if (cmd === 'npm') { if (npmFail) throw new Error('npm'); return '' }
    if (c === 'git rev-parse --abbrev-ref HEAD') return branch + '\n'
    if (c === 'git status --porcelain --untracked-files=no') return dirty
    if (c === 'git rev-parse HEAD') return head + '\n'
    if (c === 'git fetch -q origin main') { if (fetchFail) throw new Error('net'); return '' }
    if (c === 'git merge --ff-only -q origin/main') { if (mergeFail) throw new Error('ff'); head = after; return '' }
    if (c.startsWith('git diff --name-only')) return deps
    throw new Error('想定していない命令: ' + c)
  }
  return { run, calls }
}
const go = (f, o = {}) => selfUpdate({ execute: true, env: {}, run: f.run, dir: '/repo', log: () => {}, ...o })

describe('取込の道具を最新にする', () => {
  it('書き込まない実行・止めの指定・動かし直した側では何もしない（git を呼ばない）', () => {
    for (const [o, reason] of [[{ execute: false }, 'dry-run'], [{ env: { CARELOG_AUTO_UPDATE: '0' } }, 'off'], [{ env: { CARELOG_UPDATED: '1' } }, 'rerun']]) {
      const f = fake()
      const r = go(f, o)
      assert.equal(r.action, 'skip'); assert.equal(r.reason, reason); assert.equal(f.calls.length, 0)
    }
  })
  it('main 以外のブランチ・手で直したファイルがある時は合わせない（fetch もしない）', () => {
    const f1 = fake({ branch: 'work' })
    assert.equal(go(f1).reason, 'branch'); assert.ok(!f1.calls.some((c) => c.includes('fetch')))
    const f2 = fake({ dirty: ' M tools/import.mjs\n' })
    assert.equal(go(f2).reason, 'dirty'); assert.ok(!f2.calls.some((c) => c.includes('fetch')))
  })
  it('もう最新なら same（動かし直さない）', () => {
    const f = fake({ after: A })
    assert.equal(go(f).action, 'same')
  })
  it('新しい版に早送りで合わせ、部品が変わっていなければ npm を呼ばずに updated', () => {
    const f = fake()
    const r = go(f)
    assert.equal(r.action, 'updated'); assert.equal(r.before, A); assert.equal(r.after, B)
    assert.ok(f.calls.includes('git merge --ff-only -q origin/main'), '早送りだけ（履歴を書き換えない）')
    assert.ok(!f.calls.some((c) => c.startsWith('npm')))
    assert.ok(!f.calls.some((c) => /reset|rebase|--force|checkout|pull/.test(c)), '上書き・書き換えの命令は使わない')
  })
  it('部品（package.json・package-lock.json）が変わった時は npm ci で入れ直す・失敗したら止める', () => {
    const f = fake({ deps: 'package-lock.json\n' })
    assert.equal(go(f).action, 'updated'); assert.ok(f.calls.some((c) => c.startsWith('npm ci')))
    const g = fake({ deps: 'package.json\n', npmFail: true })
    assert.equal(go(g).action, 'broken')
  })
  it('ネットにつながらない・早送りできない時は failed（今の版のまま取り込む）', () => {
    assert.equal(go(fake({ fetchFail: true })).action, 'failed')
    assert.equal(go(fake({ mergeFail: true })).action, 'failed')
  })
  it('取込の道具は動き始めに最新にし、新しい版なら動かし直し、部品が壊れたら止める', () => {
    const src = readFileSync(new URL('../tools/import.mjs', import.meta.url), 'utf8')
    assert.match(src, /const up = selfUpdate\(\{ execute: args\.execute \}\)/)
    assert.match(src, /if \(up\.action === 'broken'\) process\.exit\(2\)/)
    assert.match(src, /if \(up\.action === 'updated'\) process\.exit\(rerun\(\)\)/)
    const iUp = src.indexOf('const up = selfUpdate(')
    assert.ok(iUp > 0 && iUp < src.indexOf('new Client({ connectionString: DB_URL'), 'データベースにつなぐ前に最新にする')
  })
})
