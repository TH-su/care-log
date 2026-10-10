import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// ── 版の印（F28・2026-10-10） ─────────────────────────────────────────────
// ビルドの時に、どの版かの印を画面へ焼き込み（define: __CL_BUILD__）、同じ中身を公開物の version.json にも出す。
// 開いたままの端末は version.json を取り直して焼き込んだ印と比べ、違えば「新しい版があります」と知らせる
// （src/lib/appVersion.ts）。GitHub Actions では CL_BUILD_ID（コミット）と CL_BUILD_SEQ（公開の通し番号）を渡す
// （.github/workflows/deploy.yml）。手元のビルドは 'dev'＝比べない。
// 業務データ・秘密の値は入れない（印は公開物にそのまま出る）

/** version.json と同じ形 */
export interface BuildStamp {
  id: string
  seq: number | null
  at: string | null
}

type Env = Record<string, string | undefined>

/** 環境変数から版の印を作る（node の process.env。型の定義は持たないので globalThis から読む） */
export function buildStamp(env: Env = (globalThis as { process?: { env?: Env } }).process?.env ?? {}, now: Date = new Date()): BuildStamp {
  const rawId = (env.CL_BUILD_ID ?? env.GITHUB_SHA ?? '').trim()
  const id = /^[0-9A-Za-z._-]+$/.test(rawId) ? rawId.slice(0, 12) : 'dev'
  const seqNum = Number(env.CL_BUILD_SEQ ?? env.GITHUB_RUN_NUMBER ?? '')
  // tsconfig.node.json は lib を指定していない（ES5 の型）ので Number.isSafeInteger を使わずに整数を確かめる
  const seq = isFinite(seqNum) && Math.floor(seqNum) === seqNum && seqNum > 0 && seqNum < 9007199254740992 ? seqNum : null
  return { id, seq, at: now.toISOString() }
}

/** 公開物に version.json を出す（ビルドの時だけ。開発サーバーでは出さない＝画面は比べない） */
export function versionJsonPlugin(stamp: BuildStamp): Plugin {
  return {
    name: 'cl-version-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify(stamp)}\n` })
    },
  }
}

const STAMP = buildStamp()

// base: './' → GitHub Pages のサブパス配信でも相対パスで動作する
export default defineConfig({
  plugins: [react(), versionJsonPlugin(STAMP)],
  base: './',
  define: {
    __CL_BUILD__: JSON.stringify(STAMP),
  },
})
