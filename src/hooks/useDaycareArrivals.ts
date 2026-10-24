// デイの到着の印（care-log の食事の画面・2026-10-24 今日の画面の改善 3回目）: 日の範囲の到着を1回の読み取りでまとめて読み、
// 変わったら読み直す。読み直すきっかけ（#46 の反証 重1）:
//   ・他の端末・定時の処理の到着・休み・取り消し（daycare_attendance の Realtime。続けて来ても1秒まとめて1回）
//   ・画面に戻った時・電波が戻った時・5分ごと（Realtime が届かなかった時の安全網）
//   ・画面の〔最新〕（refresh）
// 読めない時（通信・権限・表が無い）は印を出さないだけで、画面は止めない。ただし同じ範囲を読み直して失敗した時は、
// 前に読めた印を残す（電波の弱い所で印が点いたり消えたりしない）。範囲が変わった後に読めない時は空にする
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchDaycareArrivals, subscribeDaycareChanges } from '../lib/db'

/** Realtime が届かなかった時の読み直しの間隔（定時の処理は5分ごとに到着を入れる） */
const REFRESH_MS = 5 * 60_000
/** 続けて来た知らせをまとめる間 */
const DEBOUNCE_MS = 1000

export function useDaycareArrivals(fromIso: string, toIso: string): { arrivals: ReadonlySet<string>; refresh: () => void } {
  const [arrivals, setArrivals] = useState<ReadonlySet<string>>(() => new Set())
  const [tick, setTick] = useState(0)
  /** 最後に読めた範囲（同じ範囲の読み直しに失敗した時は、前の印を残す） */
  const okRangeRef = useRef<string | null>(null)
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    let alive = true
    const range = `${fromIso}|${toIso}`
    fetchDaycareArrivals(fromIso, toIso)
      .then((s) => {
        if (!alive) return
        okRangeRef.current = range
        setArrivals(s)
      })
      .catch(() => {
        if (!alive) return
        if (okRangeRef.current !== range) setArrivals(new Set())
      })
    return () => {
      alive = false
    }
  }, [fromIso, toIso, tick])

  const timerRef = useRef<number | null>(null)
  useEffect(() => {
    const later = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        setTick((n) => n + 1)
      }, DEBOUNCE_MS)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') later()
    }
    const off = subscribeDaycareChanges(() => later())
    window.addEventListener('online', later)
    document.addEventListener('visibilitychange', onVisible)
    const iv = window.setInterval(later, REFRESH_MS)
    return () => {
      off()
      window.removeEventListener('online', later)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(iv)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  return { arrivals, refresh }
}
