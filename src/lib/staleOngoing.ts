// 60日より前に始まって終わっていない継続の申し送り（代表者の決定 2026-10-29 案A）。
// タイムラインの継続の枠の上に「60日より前に始まった継続が N件あります（終了してください）」の帯を出し、
// （最重要は数えない＝timeline_chunk が上限を掛けずにピン留めに出し続ける。境目は 0050 の SQL と同じ日本時間の今日−60日）
// 押した時だけ古い順の一覧を読む。件数は notes を直接数える軽い問い合わせ（timeline_chunk の遡りの上限に関係なく動く）。
// - 件数が0・読めない時は帯を出さない（画面は止めない）
// - 一覧は開いた時だけ読む。開いている間に取り直しの合図（reload）が来たら、件数と一緒に一覧も取り直す
// - 遅れて届いた応答は世代で捨てる
// node の試験（tests/stale-ongoing.test.mjs）から直接読む。個人情報は console・localStorage に出さない

import { addDaysIso, jstClock } from '../pages/alertsModel'
import { todayIso } from './format'
import type { Note } from './types'

/** 帯に出す境目の日数（timeline_chunk の c_lookback_days と同じ値） */
export const STALE_ONGOING_DAYS = 60

/** 境目の日（日本時間の今日−60日）。これより前（未満）に始まった継続を数える */
export function staleOngoingBefore(nowMs: number): string {
  const today = jstClock(nowMs)?.day ?? todayIso()
  return addDaysIso(today, -STALE_ONGOING_DAYS)
}

/** 帯の文言。件数が無い・0・読めない時は null（帯を出さない） */
export function staleOngoingBannerText(count: number | null): string | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null
  return `${STALE_ONGOING_DAYS}日より前に始まった継続が ${Math.floor(count)}件あります（終了してください）`
}

export interface StaleOngoingState {
  /** 件数。null＝まだ読んでいない・読めなかった（どちらも帯を出さない） */
  count: number | null
  /** 一覧を開いているか */
  open: boolean
  /** 一覧の行（古い順）。null＝まだ読んでいない */
  rows: Note[] | null
  listLoading: boolean
  listError: boolean
}

export const STALE_ONGOING_INITIAL: StaleOngoingState = {
  count: null,
  open: false,
  rows: null,
  listLoading: false,
  listError: false,
}

export interface StaleOngoingDeps {
  count(before: string): Promise<number>
  list(before: string): Promise<Note[]>
  now(): number
}

export interface StaleOngoingController {
  /** 件数を取り直す（一覧を開いていれば一覧も） */
  reload(): void
  /** 一覧を開いて読む */
  open(): void
  close(): void
  /** 一覧だけ読み直す（読めなかった時の再試行） */
  retryList(): void
  dispose(): void
}

/** 件数と一覧の読み込みを受け持つ（React に依存しない・試験から直接動かす） */
export function createStaleOngoing(
  deps: StaleOngoingDeps,
  onChange: (s: StaleOngoingState) => void,
): StaleOngoingController {
  let state: StaleOngoingState = STALE_ONGOING_INITIAL
  let alive = true
  let countGen = 0
  let listGen = 0
  const set = (patch: Partial<StaleOngoingState>) => {
    if (!alive) return
    state = { ...state, ...patch }
    onChange(state)
  }

  const loadList = () => {
    const gen = ++listGen
    const before = staleOngoingBefore(deps.now())
    set({ listLoading: true, listError: false })
    let p: Promise<Note[]>
    try {
      p = deps.list(before)
    } catch {
      p = Promise.reject(new Error('list'))
    }
    p.then(
      (rows) => {
        if (gen !== listGen || !state.open) return
        set({ rows: Array.isArray(rows) ? rows : [], listLoading: false, listError: false })
      },
      () => {
        if (gen !== listGen || !state.open) return
        // 読めなかった時は前に読めた行を残し、読めなかった旨と再試行を出す
        set({ listLoading: false, listError: true })
      },
    )
  }

  const reload = () => {
    const gen = ++countGen
    const before = staleOngoingBefore(deps.now())
    let p: Promise<number>
    try {
      p = deps.count(before)
    } catch {
      p = Promise.reject(new Error('count'))
    }
    p.then(
      (n) => {
        if (gen !== countGen) return
        const count = typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
        if (count === null || count === 0) {
          // 0件・読めない値は帯ごと出さない（開いていた一覧も閉じる）
          listGen++
          set({ count, open: false, rows: null, listLoading: false, listError: false })
          return
        }
        set({ count })
      },
      () => {
        if (gen !== countGen) return
        // 読めない時は帯を出さない（エラーで画面を止めない）
        listGen++
        set({ count: null, open: false, rows: null, listLoading: false, listError: false })
      },
    )
    if (state.open) loadList()
  }

  return {
    reload,
    open() {
      if (state.open) return
      set({ open: true })
      loadList()
    },
    close() {
      listGen++
      set({ open: false, rows: null, listLoading: false, listError: false })
    },
    retryList() {
      if (state.open) loadList()
    },
    dispose() {
      alive = false
      countGen++
      listGen++
    },
  }
}
