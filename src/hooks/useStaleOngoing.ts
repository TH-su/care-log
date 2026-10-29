// タイムラインの「60日より前に始まった継続」の帯（代表者の決定 2026-10-29 案A）。中身は src/lib/staleOngoing.ts。
// 取り直しの合図（tick）は useTimeline の窓全体の取り直し（自分の終了の後の refresh・継続の申し送りの変更通知・取り直しの合図）
// に乗せる。新しい購読は作らない。tick が 0 の間（タイムラインの最初の読み込みが済む前）は数えない

import { useCallback, useEffect, useRef, useState } from 'react'
import { countStaleOngoingNotes, fetchStaleOngoingNotes } from '../lib/db'
import { STALE_ONGOING_INITIAL, createStaleOngoing } from '../lib/staleOngoing'
import type { StaleOngoingController, StaleOngoingState } from '../lib/staleOngoing'

export interface UseStaleOngoingResult extends StaleOngoingState {
  openList(): void
  closeList(): void
  retryList(): void
}

export function useStaleOngoing(tick: number): UseStaleOngoingResult {
  const [state, setState] = useState<StaleOngoingState>(STALE_ONGOING_INITIAL)
  const ctlRef = useRef<StaleOngoingController | null>(null)

  useEffect(() => {
    const ctl = createStaleOngoing(
      { count: countStaleOngoingNotes, list: fetchStaleOngoingNotes, now: () => Date.now() },
      setState,
    )
    ctlRef.current = ctl
    return () => {
      ctl.dispose()
      if (ctlRef.current === ctl) ctlRef.current = null
    }
  }, [])

  useEffect(() => {
    if (tick <= 0) return
    ctlRef.current?.reload()
  }, [tick])

  const openList = useCallback(() => ctlRef.current?.open(), [])
  const closeList = useCallback(() => ctlRef.current?.close(), [])
  const retryList = useCallback(() => ctlRef.current?.retryList(), [])

  return { ...state, openList, closeList, retryList }
}
