// 認証まわりのゲート画面（ログイン／接続未設定の案内）。
//
// 正本: docs/design/contracts.md「App.tsx の責務」（①接続未設定ゲート ②認証ゲート）・
//       docs/design/qa-verification.md §M-038 対策（401 検知 → キューを保全したまま再ログイン →
//       ログイン成功で自動再送）・docs/PLAN.md §0（認証＝施設共有アカウント／操作者は別レイヤー）。
//       ログイン成功後の遷移は App.tsx が担当する（useAuth の session 更新 → Authenticated が
//       元の画面へ戻す）。本ファイルからは画面遷移を行わない。
//
// 【このファイル固有の最重要規律】supabase / db を static import しない
//   src/lib/supabase.ts は module scope で createClient() を実行するため、接続未設定だと
//   「読み込んだ瞬間に例外」になる（supabase-js v2 は supabaseUrl 空で throw）。
//   NotConfiguredPage は接続未設定のときに表示する画面なので、同じモジュールに supabase への
//   静的依存があると案内画面ごと道連れで落ちる。supabase / db は「押した時・表示した時」に
//   dynamic import する（凍結仕様の絶対条件1「env 未設定でも白画面にしない」の担保）。
//   → components/ui.tsx は lib/types.ts しか参照しないため静的 import して差し支えない。
//
// Google ログイン（2026-09-26 追加・統合 Phase 1）:
//   Google でのログインは care-tools の共通ログイン画面（/care-tools/login.html）で行い、終わったらここへ戻る。
//   同じ th-su.github.io の上なので、ログイン状態（localStorage の sb-<ref>-auth-token）はそのまま共有される。
//   src/lib/supabase.ts は凍結（detectSessionInUrl: false）なので、この画面で Google から戻る受け口は作らない。
//   誰が使えるかはデータベースの許可リスト（care-backend 0001/0002）が決める。
//   ID とパスワードの欄は 2026-09-26 に外した（施設の共用アカウントも Google 限定＝care-backend 0003）。
//
// 規律:
// - 実名・入力値（メールアドレス・パスワード）をコード/コメント/console/localStorage に書かない
// - タップ要素は min-h-tap（44px）＋隣接 gap-gap（8px）。色だけで意味を伝えない（記号・文字を併記）
// - エラー文は「何が起きたか＋次にどうすればよいか」。英語の生メッセージをそのまま出さない
// - Tailwind はトークン由来クラスのみ（arbitrary value・色/px 直書きなし）

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

// ── 接続設定の状態（値そのものは絶対に表示しない。設定の有無・形式だけを見る）──────

type ConfigState = 'missing' | 'malformed' | 'ok'

function readEnv(name: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY'): string {
  // 型は src/vite-env.d.ts で付くが、未設定でも落ちないようキャスト経由で読む（db.ts と同じ書き方）。
  // Vite がビルド時に実体へ置換する。未設定なら空オブジェクト → 空文字。
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  return (env?.[name] ?? '').trim()
}

/** URL は「入っているか」だけでなく http(s) 形式かも見る（createClient は形式不正でも throw する） */
function urlState(): ConfigState {
  const v = readEnv('VITE_SUPABASE_URL')
  if (v === '') return 'missing'
  return /^https?:\/\//i.test(v) ? 'ok' : 'malformed'
}

function keyState(): ConfigState {
  return readEnv('VITE_SUPABASE_ANON_KEY') === '' ? 'missing' : 'ok'
}

const CONFIG_LABEL: Record<ConfigState, { mark: string; text: string; tone: string }> = {
  ok: { mark: '✓', text: '設定されています', tone: 'text-ok' },
  missing: { mark: '✕', text: '設定されていません', tone: 'text-danger' },
  malformed: { mark: '▲', text: '形式が違います（https:// で始まる値を入れてください）', tone: 'text-warn' },
}

/** 接続設定の1項目（キー名と状態のみ。値は表示しない＝公開端末での覗き見・漏えい防止） */
function ConfigRow({ name, state }: { name: string; state: ConfigState }) {
  const label = CONFIG_LABEL[state]
  return (
    <li className="flex flex-wrap items-baseline gap-gap">
      <span className="font-num break-all text-sm text-ink">{name}</span>
      <span className={`text-sm font-bold ${label.tone}`}>
        <span aria-hidden="true">{label.mark} </span>
        {label.text}
      </span>
    </li>
  )
}

// ── 画面の外枠（ヘッダ・タブの外側で全画面に出す）────────────────────────────

function FullScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4 text-ink">
      <main className="w-full max-w-md">{children}</main>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 接続未設定の案内（管理者向け）
// ══════════════════════════════════════════════════════════════

/**
 * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が読み込まれていないときに App.tsx が出す画面。
 * HashRouter の外側で描画されるため、react-router のフック・コンポーネントを使わない。
 * 非同期処理を持たないため、3状態のうちローディング・空は該当しない（本画面自体が
 * 「開けない理由＋次にどうすればよいか」を示す状態）。
 */
export function NotConfiguredPage() {
  const url = urlState()
  const key = keyState()

  return (
    <FullScreen>
      <div className="rounded-lg border border-border bg-surface p-4">
        <h1 className="text-xl font-heavy text-ink">
          <span aria-hidden="true">▲ </span>
          接続先が設定されていないため開けません
        </h1>
        <p className="mt-2 text-base text-ink2">
          記録データベース（Supabase）への接続設定が読み込まれていません。記録の閲覧・入力はできません。
          設定は管理者が行います。下の手順で設定したうえで、この画面を再読み込みしてください。
        </p>

        <h2 className="mt-6 text-lg font-bold text-ink">いまの状態</h2>
        <ul className="mt-2 space-y-2">
          <ConfigRow name="VITE_SUPABASE_URL" state={url} />
          <ConfigRow name="VITE_SUPABASE_ANON_KEY" state={key} />
        </ul>

        <h2 className="mt-6 text-lg font-bold text-ink">管理者向け・設定の手順</h2>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-base text-ink2">
          <li>
            リポジトリ直下の <span className="font-num text-ink">.env.example</span> を複製し、
            <span className="font-num text-ink"> .env</span> という名前で保存する
          </li>
          <li>
            <span className="font-num text-ink">VITE_SUPABASE_URL</span> に Supabase プロジェクトの
            URL（<span className="font-num text-ink">https://</span> から始まる値）、
            <span className="font-num text-ink"> VITE_SUPABASE_ANON_KEY</span> に anon キーを入れる
          </li>
          <li>開発中は開発サーバーを一度止めて起動し直す（設定ファイルは起動時にだけ読み込まれる）</li>
          <li>
            公開版（GitHub Pages）は、GitHub リポジトリの Settings → Secrets and variables →
            Actions に同じ2つを登録し、デプロイし直す
          </li>
        </ol>

        <p className="mt-4 rounded-md border border-warn bg-warn-bg p-3 text-sm text-ink">
          <span aria-hidden="true" className="font-heavy">
            ▲{' '}
          </span>
          <span className="font-num">VITE_</span>
          で始まる値は公開ファイルに埋め込まれます。anon キー以外の秘密の鍵（管理者用の
          サーバー側キー）・施設名・氏名を書かないでください。
        </p>

        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 inline-flex min-h-tap items-center justify-center rounded-md border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
        >
          設定後に再読み込みする
        </button>
      </div>
    </FullScreen>
  )
}

/** 別名（担当割り当ての呼称にあわせた別名。実体は NotConfiguredPage と同一） */
export { NotConfiguredPage as UnconfiguredPage }

// ══════════════════════════════════════════════════════════════
// ログイン
// ══════════════════════════════════════════════════════════════

/** Google ログインの入口（care-tools の共通ログイン画面。?return=care-log でログイン後にここへ戻る） */
const GOOGLE_LOGIN_URL = '../care-tools/login.html?return=care-log'

/**
 * 未ログイン時に全画面で出すログイン画面（ルート /login）。
 * ログインは Google だけ（2026-09-26 に施設の共用アカウントも Google 限定にした＝care-backend 0003。
 * ID とパスワードでは、たとえ正しくてもデータベースが何も返さないので、入力欄も置かない）。
 * 「誰として記録するか」は別レイヤー（App.tsx の操作者ピッカー）。
 *
 * 3状態: ローディング＝なし（押すと別画面へ移るだけ）／エラー＝Google 側・許可リスト側の断りは
 *        共通ログイン画面が日本語で出す／空＝初期表示（何を押すか・入れない場合の連絡先を明示）。
 */
export function LoginPage() {
  const [pending, setPending] = useState(0)

  // 401（セッション失効）でこの画面に戻された場合に備え、未送信の記録が残っていることを伝える。
  // db.ts は supabase を静的 import しないので読み込み自体は安全だが、失敗しても画面は出す。
  useEffect(() => {
    let alive = true
    void import('../lib/db')
      .then((m) => {
        const n = m.queuePending()
        if (alive && typeof n === 'number' && n > 0) setPending(n)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  return (
    <FullScreen>
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-heavy text-primary">ケアログ</h1>
        <p className="mt-1 text-sm text-ink2">申し送り・バイタル記録</p>
      </div>

      {pending > 0 && (
        <p className="mb-4 rounded-md border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true" className="font-heavy">
            ⚠{' '}
          </span>
          未送信の記録が<span className="tabular font-bold">{pending}</span>
          件残っています。ログインすると自動で送信されます。入力は消えていません。
        </p>
      )}

      <section className="space-y-3 rounded-lg border border-border bg-surface p-4">
        <h2 className="text-lg font-bold text-ink">ログイン</h2>
        <p className="text-base text-ink2">
          登録された Google アカウントで入ります。施設のタブレットでは、施設の Google アカウントを選んでください。
        </p>
        <a
          href={GOOGLE_LOGIN_URL}
          className="flex min-h-tap w-full items-center justify-center rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
        >
          Google でログイン
        </a>
        <p className="text-sm text-ink2">
          使えるアカウントは管理者が登録します。ログインできない場合は管理者にご連絡ください。
        </p>
      </section>
    </FullScreen>
  )
}
