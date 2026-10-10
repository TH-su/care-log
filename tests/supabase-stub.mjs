// gasClient.ts が読む './supabase' の代わり（tests/roster-presence.test.mjs の解決フックだけが差し込む。通信しない）。
// 本物の src/lib/supabase.ts は読み込んだ時点で接続先の設定を求めるため、試験では使えない。
// 中身は試験が globalThis.__clStubSupabase に置いた偽のクライアントへそのまま渡す（db.ts の __testHooks.setClient と同じ物を置く）
export const supabase = new Proxy(
  {},
  {
    get(_t, k) {
      const c = globalThis.__clStubSupabase
      if (c === undefined || c === null) throw new Error('偽の Supabase が置かれていません')
      const v = c[k]
      return typeof v === 'function' ? v.bind(c) : v
    },
  },
)
