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
// 規律:
// - 実名・入力値（メールアドレス・パスワード）をコード/コメント/console/localStorage に書かない
// - タップ要素は min-h-tap（44px）＋隣接 gap-gap（8px）。色だけで意味を伝えない（記号・文字を併記）
// - エラー文は「何が起きたか＋次にどうすればよいか」。英語の生メッセージをそのまま出さない
// - Tailwind はトークン由来クラスのみ（arbitrary value・色/px 直書きなし）

import { useEffect, useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ErrorBlock } from '../components/ui'

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

const MSG = {
  emailRequired: 'メールアドレスを入力してください。',
  passwordRequired: 'パスワードを入力してください。',
  invalid: 'メールアドレスまたはパスワードが違います。入力内容を確認して、もう一度お試しください。',
  unconfirmed: 'このアカウントはまだ使える状態になっていません。管理者にご連絡ください。',
  rateLimit:
    '試行回数が多いため、一時的に受け付けられません。1分ほど待ってから、もう一度お試しください。',
  offline: '通信できませんでした。電波・ネットワークの状態を確認して、もう一度お試しください。',
  failed:
    'ログインできませんでした。少し時間をおいて、もう一度お試しください。解決しない場合は管理者にご連絡ください。',
} as const

interface AuthFailure {
  status?: number
  code?: string
  message?: string
}

/**
 * 認証エラーを日本語の「何が起きたか＋次にどうすればよいか」へ変換する。
 * サーバーの英語メッセージはそのまま出さない（利用者が読めず、内部情報も混ざり得るため）。
 */
function loginErrorMessage(e: AuthFailure): string {
  const code = (e.code ?? '').toLowerCase()
  const msg = (e.message ?? '').toLowerCase()
  if (code === 'invalid_credentials' || msg.includes('invalid login credentials')) return MSG.invalid
  if (code === 'email_not_confirmed' || msg.includes('not confirmed')) return MSG.unconfirmed
  if (e.status === 429 || code.includes('rate_limit') || msg.includes('too many')) return MSG.rateLimit
  if (msg.includes('fetch') || msg.includes('network')) return MSG.offline
  return MSG.failed
}

/**
 * 未ログイン時に全画面で出すログイン画面（ルート /login）。
 * 認証は施設共有アカウント。「誰として記録するか」は別レイヤー（App.tsx の操作者ピッカー）。
 *
 * 3状態: ローディング＝送信中（ボタン無効化＋状況テキスト）／エラー＝入力不備・認証失敗・通信失敗／
 *        空＝初期表示の未入力フォーム（何を入れるか・入れない場合の連絡先を明示）。
 */
export function LoginPage() {
  const emailId = useId()
  const passwordId = useId()
  const emailErrorId = `${emailId}-error`
  const passwordErrorId = `${passwordId}-error`

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [fieldError, setFieldError] = useState<{ email?: string; password?: string }>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return

    // 入力不備は通信前に日本語で指摘する（ブラウザ既定の英語バブルを出さないため form は noValidate）
    const trimmed = email.trim()
    const next: { email?: string; password?: string } = {}
    if (trimmed === '') next.email = MSG.emailRequired
    if (password === '') next.password = MSG.passwordRequired
    setFieldError(next)
    if (next.email || next.password) {
      setError(null)
      return
    }

    setBusy(true)
    setError(null)
    try {
      // 接続未設定でも本ファイルを読めるようにするため、ここで初めて supabase を読み込む
      const { supabase } = await import('../lib/supabase')
      const { error: err } = await supabase.auth.signInWithPassword({
        email: trimmed,
        password,
      })
      // 失敗しても入力は消さない（1文字直せば済むようにする。手袋・片手操作での打ち直しは負担が大きい）
      if (err) setError(loginErrorMessage(err as AuthFailure))
      // 成功時: useAuth（onAuthStateChange）が session を更新し、App.tsx が元の画面へ戻す。
      //         退避してある書込は db.ts の SIGNED_IN 監視が自動で再送する。
    } catch {
      // 通信断・モジュール取得失敗。例外の中身は個人情報を含み得るため表示・記録しない
      setError(MSG.offline)
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'mt-1 min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink'

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

      <form
        onSubmit={submit}
        noValidate
        className="space-y-4 rounded-lg border border-border bg-surface p-4"
      >
        <h2 className="text-lg font-bold text-ink">ログイン</h2>

        <div>
          <label htmlFor={emailId} className="block text-base text-ink">
            メールアドレス
          </label>
          <input
            id={emailId}
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            aria-invalid={fieldError.email ? true : undefined}
            aria-describedby={fieldError.email ? emailErrorId : undefined}
            className={inputClass}
          />
          {fieldError.email && (
            <p id={emailErrorId} role="alert" className="mt-1 text-sm font-bold text-danger">
              <span aria-hidden="true">▲ </span>
              {fieldError.email}
            </p>
          )}
        </div>

        <div>
          <label htmlFor={passwordId} className="block text-base text-ink">
            パスワード
          </label>
          <div className="flex items-start gap-gap">
            <input
              id={passwordId}
              type={revealed ? 'text' : 'password'}
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              aria-invalid={fieldError.password ? true : undefined}
              aria-describedby={fieldError.password ? passwordErrorId : undefined}
              className={`${inputClass} min-w-0 flex-1`}
            />
            {/* 手袋・片手操作での打ち間違いを確認できるようにする（表示は端末上のみ・保存しない） */}
            <button
              type="button"
              aria-pressed={revealed}
              onClick={() => setRevealed((v) => !v)}
              className="mt-1 min-h-tap shrink-0 rounded border border-border-strong px-3 text-base text-ink"
            >
              {revealed ? '隠す' : '表示'}
            </button>
          </div>
          {fieldError.password && (
            <p id={passwordErrorId} role="alert" className="mt-1 text-sm font-bold text-danger">
              <span aria-hidden="true">▲ </span>
              {fieldError.password}
            </p>
          )}
        </div>

        {error && <ErrorBlock message={error} />}

        <button
          type="submit"
          disabled={busy}
          aria-busy={busy}
          className="min-h-tap w-full rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border disabled:bg-surface2 disabled:text-ink3"
        >
          {busy ? 'ログインしています…' : 'ログイン'}
        </button>

        <p role="status" aria-live="polite" className="text-sm text-ink2">
          {busy ? 'ログインしています。しばらくお待ちください…' : ''}
        </p>

        <p className="text-sm text-ink2">
          アカウントは管理者が発行します。ログインできない場合は管理者にご連絡ください。
        </p>
      </form>
    </FullScreen>
  )
}
