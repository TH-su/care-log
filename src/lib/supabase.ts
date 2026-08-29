import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!url || !anonKey) {
  // 開発中の設定漏れを早期に気づけるようにする
  console.warn('Supabase の環境変数 (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) が未設定です')
}

/**
 * ログイン状態は端末に保持し、自動で更新する（2026-08-29 に明示）。
 * 値は既定と同じだが、現場は「一度ログインしたら使い続けられる」ことが前提なので、
 * 意図としてここへ固定する（将来ライブラリの既定が変わっても黙って挙動が変わらないように）。
 *
 * detectSessionInUrl は false。この画面は HashRouter で '#/settings' のようなハッシュを使うため、
 * Supabase がハッシュを認証トークンとして解釈しようとする経路を作らない。
 * メール確認・OAuth のリダイレクトは使っていない（IDと合言葉のみ）。
 */
export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
})
