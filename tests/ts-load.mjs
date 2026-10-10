// 試験の対象（src の TypeScript）を読み込めなかった時の扱いをそろえる共通の部品（2026-10-10 監査 F69）。
//
// 以前は各試験が `try { await import(...) } catch { X = null }` で例外を捨て、「この Node では使えない」という理由で
// スキップを登録していた。そのため db.ts などに Node で読めない書き方（enum・引数のプロパティ・読み込み時の例外）が
// 入ると、同期の試験がまとめてスキップになり、npm test は成功のまま本番へ配備されていた。
//
// ここでは「この Node が型の除去・解決フックを持たない（古い Node）」時だけスキップを許し、それ以外の読み込みの失敗は
// 元の例外の文言を付けた失敗にする。CI（GitHub Actions は CI=true を立てる）は Node 24 に固定しているので、
// 古い Node を理由にしたスキップも失敗にする（スキップが出るのは何かが壊れた時だけのため）。
// 個人情報は扱わない。

import { it } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeModule from 'node:module'

/** CI の上で動いているか（GitHub Actions は CI=true） */
export function isCi() {
  const v = process.env.CI
  return typeof v === 'string' && v !== '' && v !== 'false' && v !== '0'
}

/**
 * この Node が src の TypeScript を読み込めるはずか。
 * hooks=true は、拡張子の無い相対 import を '.ts' へ補う解決フック（module.registerHooks）も要る試験（db.ts など）
 */
export function tsRuntimeReady({ hooks = false } = {}) {
  const strip = Boolean(process.features?.typescript)
  if (!hooks) return strip
  return strip && typeof nodeModule.registerHooks === 'function'
}

/** 例外を結果に出せる短い文言にする（元の原因を隠さない） */
export function describeLoadError(err) {
  if (err === null || err === undefined) return '原因不明（例外が残っていません）'
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

/**
 * 対象を読み込めなかった時の it を1つ登録する。
 * - この Node で読めるはずなのに読めなかった・CI の上 → 失敗（元の例外の文言を付ける）
 * - 古い Node（型の除去か解決フックが無い）→ スキップ（理由と元の例外を結果に残す）
 * @param {string} label 試験の名前（スキップの時と同じ名前）
 * @param {unknown} err 読み込みで捕まえた例外
 * @param {string} unsupportedReason 古い Node の時のスキップの理由
 * @param {{ hooks?: boolean }} [opts] 解決フックも要る試験か
 */
export function registerLoadFailure(label, err, unsupportedReason, opts = {}) {
  const detail = describeLoadError(err)
  if (tsRuntimeReady(opts) || isCi()) {
    it(`${label}（対象を読み込めません）`, () => {
      assert.fail(
        `${label}の対象を読み込めませんでした。本体に Node で読めない書き方（enum・namespace・引数のプロパティなど）か、` +
          `読み込んだ時点で投げる例外が入っていないか確かめてください。元の例外: ${detail}`,
      )
    })
    return
  }
  it(label, { skip: `${unsupportedReason}（${detail}）` }, () => {})
}
