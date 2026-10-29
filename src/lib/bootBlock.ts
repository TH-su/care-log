/**
 * 日報の起動の早取り（2026-10-29 本人指示「起動の待ち時間を減らす」）の順番を決める部品。純粋（画面・通信を持たない）。
 *
 * 日報を開くと、画面のマスタ（在籍者・職員・入力解禁・施設長）をそろえてから各日の枠が日報を取りに行く。日報の取得は
 * マスタの値を使わないので、マスタと並べて先に取りに行ける。ただし、この画面の変更通知のチャンネルが参加する（SUBSCRIBED）
 * 前に読むと、読まれた時点から参加までに他の端末が書いた行を通知で受け取れない（最初の参加では取り直しの合図も来ない）。
 * そこで:
 *   ・参加した時に1回だけ start を呼ぶ（参加の前には呼ばない）
 *   ・参加より先にマスタがそろった・待ち時間（waitMs）が過ぎた・止めた時は、もう呼ばない
 *     ＝今までどおり、マスタがそろった後に各日の枠が取りに行く（見落としの窓を今までより広げない）
 *   ・start を呼んでからマスタがそろうまでに帯（他の端末で記録が更新されました）が出たら、マスタがそろった時に drop を呼ぶ
 *     （マスタの読み込みは帯を消すので、先に読んだ分を捨てて各日の枠に取り直させる＝今までと同じ新しい内容が出る）
 */

/** 参加を待つ上限（ミリ秒）。過ぎたら早取りをやめて今までの流れに任せる */
export const BOOT_JOIN_WAIT_MS = 2000

export type BootBlockState = 'waiting' | 'started' | 'done'

export interface BootBlockTimer {
  set: (fn: () => void, ms: number) => unknown
  clear: (id: unknown) => void
}

export interface BootBlockOptions {
  /** 早取りを始める。始めなかった（控えに全部ある等）時は false を返す。例外は外へ出さない */
  start: () => boolean
  /** 帯を出した回数（その場で数えた値） */
  staleMark: () => number
  /** 先に読んだ分を捨てる（〔最新に更新〕と同じ捨て方） */
  drop: () => void
  waitMs?: number
  timer?: BootBlockTimer
}

export interface BootBlock {
  /** この画面の変更通知のチャンネルが参加した */
  joined: () => void
  /** マスタがそろった（帯を消す直前に呼ぶ）。先に読んだ分を捨てた時は true */
  masterReady: () => boolean
  /** 画面を閉じた */
  stop: () => void
  state: () => BootBlockState
}

const defaultTimer: BootBlockTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}

export function createBootBlock(opts: BootBlockOptions): BootBlock {
  const timer = opts.timer ?? defaultTimer
  let state: BootBlockState = 'waiting'
  let mark0 = 0
  let handle: unknown = timer.set(() => {
    handle = null
    if (state === 'waiting') state = 'done'
  }, opts.waitMs ?? BOOT_JOIN_WAIT_MS)
  const clearWait = () => {
    if (handle !== null) timer.clear(handle)
    handle = null
  }
  return {
    joined() {
      if (state !== 'waiting') return
      clearWait()
      mark0 = opts.staleMark()
      let started = false
      try {
        started = opts.start()
      } catch {
        started = false
      }
      state = started ? 'started' : 'done'
    },
    masterReady() {
      clearWait()
      const was = state
      state = 'done'
      if (was !== 'started' || opts.staleMark() === mark0) return false
      opts.drop()
      return true
    },
    stop() {
      clearWait()
      state = 'done'
    },
    state: () => state,
  }
}
