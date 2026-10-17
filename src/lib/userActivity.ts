// 人が画面を触っているか（2026-10-18 本人依頼「iPhone で画面がカクつく・もっと軽い挙動に」）。
//
// 裏の先読み（画面の部品・データ）は、指でスクロールしている・押している・入力している間は始めない。
// iPhone では、部品を読み込んで組み立てる処理や届いたデータの処理が指の動きと重なると、その間の描画が止まって
// カクついて見える。触るのをやめて少し経ってから（QUIET_MS）始める。
//
// 受け口は passive で張る（スクロールを待たせない）。時刻を1つ覚えるだけで、画面の状態は持たない。

/** 最後に触ってからこの時間（ms）は「触っている」とみなす（スクロールの惰性が止まるまでを含む） */
export const QUIET_MS = 1_200

/** 触っている間かどうかの純関数（試験用）。一度も触っていなければ false */
export function isBusyAt(now: number, lastInputAt: number | null, quietMs: number = QUIET_MS): boolean {
  return lastInputAt !== null && now - lastInputAt < quietMs
}

let lastInputAt: number | null = null
let installed = false
const quietHooks = new Set<() => void>()
let quietTimer: ReturnType<typeof setTimeout> | null = null

const fireQuiet = (): void => {
  quietTimer = null
  const now = Date.now()
  // 待っている間にまた触られた＝残りの時間だけ待ち直す
  if (isBusyAt(now, lastInputAt)) {
    quietTimer = setTimeout(fireQuiet, QUIET_MS - (now - (lastInputAt ?? now)))
    return
  }
  for (const fn of [...quietHooks]) {
    try {
      fn()
    } catch {
      // 受け口の例外で他の受け口を止めない
    }
  }
}

const onInput = (): void => {
  lastInputAt = Date.now()
  if (quietHooks.size > 0 && quietTimer === null) quietTimer = setTimeout(fireQuiet, QUIET_MS)
}

/** 触ったことを覚える受け口を張る（何度呼んでも1回だけ） */
export function installUserActivity(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const opts: AddEventListenerOptions = { passive: true, capture: true }
  for (const type of ['pointerdown', 'touchstart', 'touchmove', 'wheel', 'scroll', 'keydown'] as const)
    window.addEventListener(type, onInput, opts)
}

/** いま人が画面を触っている（最後に触ってから QUIET_MS 以内）か */
export function isUserBusy(): boolean {
  return isBusyAt(Date.now(), lastInputAt)
}

/** 触るのをやめて QUIET_MS 経った時に呼ぶ（触っている間に止めた仕事を再開する）。戻り値で外す */
export function onUserQuiet(fn: () => void): () => void {
  quietHooks.add(fn)
  if (isUserBusy() && quietTimer === null) quietTimer = setTimeout(fireQuiet, QUIET_MS)
  return () => {
    quietHooks.delete(fn)
  }
}

/** 触っていない時まで待つ（触っていなければすぐ返る） */
export function waitUserQuiet(): Promise<void> {
  if (!isUserBusy()) return Promise.resolve()
  return new Promise((resolve) => {
    const off = onUserQuiet(() => {
      off()
      resolve()
    })
  })
}
