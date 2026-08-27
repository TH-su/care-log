import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!url || !anonKey) {
  // 開発中の設定漏れを早期に気づけるようにする
  console.warn('Supabase の環境変数 (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) が未設定です')
}

export const supabase = createClient(url, anonKey)
