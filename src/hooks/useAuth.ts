import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

// Supabase Auth のセッション状態を購読する。
// editable = ログイン済み（RLS で書き込みが許可される authenticated 状態）。
//
// offline（F59・2026-10-10）: 圏外で起動すると、getSession が期限切れのトークンの更新を約25秒試して通信エラー
// （AuthRetryableFetchError）で終わり、session は null になる。以前は error を見ずにログイン画面を出していたが、
// 更新トークンは端末に残っていて、電波が戻れば自動の更新（TOKEN_REFRESHED）でそのまま戻れる。ログイン画面
// （別の部品＝圏外では開けない・押すと Safari のエラー画面へ移って自動で戻る機会も捨てる）は出さず、App が
// 「電波が戻ると自動で開きます」と出す。保存先にトークンが無い時は通信せずに null を返すので、この通信エラーは
// 「トークンはある」ことを意味する。
// - offline を解くのは session が入った時（TOKEN_REFRESHED・SIGNED_IN）と、本当にログアウトした時（SIGNED_OUT）だけ。
//   offline の間に届く null の通知（INITIAL_SESSION など）では解かない
// - 通信エラー以外の失敗（更新トークンが無効＝4xx）はこれまでどおりログイン画面
export function useAuth() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    let alive = true
    /** offline の間か（通知の受け口から同期的に見るため state とは別に持つ） */
    let offlineNow = false
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (!alive) return
      if (s) {
        offlineNow = false
        setOffline(false)
        setSession(s)
        setReady(true)
        return
      }
      if (event === 'SIGNED_OUT') {
        offlineNow = false
        setOffline(false)
        setSession(null)
        return
      }
      // 圏外の起動で session を確かめられなかった間は、null の通知でログイン画面へ落とさない
      if (offlineNow) return
      setSession(null)
    })
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!alive) return
        if (data.session) {
          offlineNow = false
          setOffline(false)
          setSession(data.session)
        } else if (error && isAuthRetryableFetchError(error)) {
          offlineNow = true
          setOffline(true)
          setSession(null)
        } else if (!offlineNow) {
          setSession(null)
        }
        setReady(true)
      })
      .catch(() => {
        // 想定外の例外: これまでどおり「ログインしていない」として画面を出す（読み込み中のまま止めない）
        if (alive) setReady(true)
      })
    return () => {
      alive = false
      sub.subscription.unsubscribe()
    }
  }, [])

  return { session, ready, offline, user: session?.user ?? null, editable: !!session }
}
