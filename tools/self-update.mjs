// self-update.mjs — 取込の道具（tools/import.mjs）が、動き始めに自分を最新の版にする（2026-11-05 本人指示「両方進めて」）
//
// なぜ: 2026-11-05 に、取込を動かしている機械の道具が古い版のままで、データベースの形が変わった後の毎時の取込が5時間止まった。
//   人が「git pull」をし忘れても止まらないよう、道具が毎回、公開されている main の最新に合わせてから取り込む。
// 何を（どれか1つでも当てはまらなければ何もせず、今の版のまま取り込む）:
//   ・書き込む実行（--execute）の時だけ。環境変数 CARELOG_AUTO_UPDATE=0 なら行わない（手で試す時など）
//   ・置き場所が git の取り出しで、今のブランチが main、手で直したファイルが無い（追跡しているファイルに変更が無い）時だけ
//   ・git fetch origin main → 早送りで合わせられる時だけ合わせる（git merge --ff-only。履歴の書き換え・上書きはしない）
//   ・合わせた後、package.json・package-lock.json が変わっていれば npm ci で部品を入れ直す
//   ・版が変わった時は、新しい版で同じ引数のまま動かし直す（動かし直した側では二度と行わない＝CARELOG_UPDATED=1）
// ★ネットにつながらない・git が無い・早送りできない時は、知らせを1行出して今の版のまま取り込む（取込そのものは止めない）。
// ★npm ci が失敗した時は止める（部品が壊れたまま書かない）。毎時の取込の見張りが「止まっている」と知らせる。
// ★出すのは版の短い番号だけ。合言葉・接続の文字列は扱わない。

import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function realRun(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 })
}

/**
 * 道具を最新にする。返すのは { action, before?, after?, reason? }。
 *   action: 'skip'（行わない）・'same'（もう最新）・'updated'（新しい版にした＝動かし直す）・'failed'（今の版のまま続ける）・'broken'（止める）
 * run(cmd, args, cwd) は試験で差し替える（既定は本物の git・npm を呼ぶ）
 */
export function selfUpdate({ execute, env = process.env, run = realRun, dir = REPO_DIR, log = console.log } = {}) {
  if (!execute) return { action: 'skip', reason: 'dry-run' }
  if (env.CARELOG_AUTO_UPDATE === '0') return { action: 'skip', reason: 'off' }
  if (env.CARELOG_UPDATED === '1') return { action: 'skip', reason: 'rerun' }
  const git = (...a) => String(run('git', ['-C', dir, ...a], dir) ?? '').trim()
  let before
  try {
    if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') return { action: 'skip', reason: 'branch' }
    if (git('status', '--porcelain', '--untracked-files=no') !== '') {
      log('取込の道具: 手で直したファイルがあるので、最新にせず今の版のまま取り込みます')
      return { action: 'skip', reason: 'dirty' }
    }
    before = git('rev-parse', 'HEAD')
    git('fetch', '-q', 'origin', 'main')
    git('merge', '--ff-only', '-q', 'origin/main')
  } catch (_e) {
    log('取込の道具: 最新にできませんでした（ネット・git の不調）。今の版のまま取り込みます')
    return { action: 'failed', reason: 'git' }
  }
  let after
  try { after = git('rev-parse', 'HEAD') } catch (_e) { return { action: 'failed', reason: 'git' } }
  if (after === before) return { action: 'same', before, after }
  let deps = ''
  try { deps = git('diff', '--name-only', before, after, '--', 'package.json', 'package-lock.json') } catch (_e) { deps = 'unknown' }
  if (deps !== '') {
    try { run('npm', ['ci', '--no-audit', '--no-fund'], dir) } catch (_e) {
      log(`取込の道具: 新しい版（${after.slice(0, 7)}）の部品を入れられませんでした。取り込まずに止めます`)
      return { action: 'broken', before, after, reason: 'npm' }
    }
  }
  log(`取込の道具: 新しい版にしました（${before.slice(0, 7)} → ${after.slice(0, 7)}）。新しい版で取り込みます`)
  return { action: 'updated', before, after }
}

/** 新しい版で同じ引数のまま動かし直し、その終了コードを返す（動かし直した側では最新にしない） */
export function rerun(argv = process.argv, env = process.env) {
  const r = spawnSync(process.execPath, argv.slice(1), { stdio: 'inherit', env: { ...env, CARELOG_UPDATED: '1' } })
  return typeof r.status === 'number' ? r.status : 1
}
