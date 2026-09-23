// 画面を離れる前の確認（競合・未保存で止まっている入力を黙って捨てない）。
//
// 競合で止まっている入力・読み直した後の未保存の入力は、画面の中（メモリ）にしか無い。
// 送信キュー（cl_sendQueue）・日報の書きかけ（cl_dailyDraft）と違って端末にも残らないので、
// 画面を離れる・再読み込みする・タブを閉じると消える。そこで各画面が「止まっている入力があるか」を
// ここへ登録し、
//   ・アプリ内の画面移動（メニュー・戻る 等）… App が確認ダイアログを出す
//   ・再読み込み・タブを閉じる … beforeunload でブラウザの警告を出す
// の2か所から参照する。確認の文言・ダイアログの形は日報の「未保存の入力があります」（askLeave）と同じ。
//
// 業務データは持たない（「あるか・ないか」を返す関数を持つだけ）。

type Source = () => boolean

const sources = new Map<number, Source>()
let seq = 0

/** 「止まっている入力があるか」を返す関数を登録する。戻り値で解除する（画面を閉じる時に必ず呼ぶ） */
export function registerUnsaved(fn: Source): () => void {
  seq += 1
  const id = seq
  sources.set(id, fn)
  return () => {
    sources.delete(id)
  }
}

/** いずれかの画面に、競合・未保存で止まっている入力があるか */
export function hasUnsavedInput(): boolean {
  for (const fn of sources.values()) {
    try {
      if (fn()) return true
    } catch {
      // 判定できない時は「ある」に倒す（黙って捨てるより、確認を1回多く出す側）
      return true
    }
  }
  return false
}

/**
 * 再読み込み・タブを閉じる時の警告（beforeunload）を取り付ける。戻り値で取り外す。
 * ブラウザは独自の文言しか出さない（文言は指定できない）。
 *
 * ★制限事項: iOS Safari（iPhone・iPad）は beforeunload を実行しないため、再読み込み・タブを閉じる
 *   操作ではこの警告が出ない。止まっている入力は業務データなので localStorage に逃がすことはしない
 *   （保存禁止）。iPad では「画面を閉じる前に止まっている入力を片付ける」運用で補う。
 */
export function attachBeforeUnload(): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (!hasUnsavedInput()) return
    e.preventDefault()
    // 古いブラウザ向け（returnValue に何か入れないと警告が出ない）
    e.returnValue = ''
  }
  window.addEventListener('beforeunload', onBeforeUnload)
  return () => window.removeEventListener('beforeunload', onBeforeUnload)
}

/** アプリ内の画面移動の確認ダイアログの文言（日報の askLeave と同じ形） */
export const LEAVE_TITLE = '未保存の入力があります'
export const LEAVE_BODY =
  '他の端末の値と食い違って止まっている入力、またはまだ保存していない入力があります。この画面を離れると、その入力は破棄されます。移動してよろしいですか。'

// ── ブラウザの戻る・進む・スワイプで戻る・アドレスの書き換え（HashRouter のまま止める） ─────
//
// react-router の HashRouter は window の popstate を聞いて画面を切り替える。止まっている入力がある時は、
// それより**先に**取り付けた聞き手で popstate を受け、stopImmediatePropagation で react-router へ渡さず、
// 元の URL を積み直してから確認ダイアログを出す（〔移動する〕を押したら App が改めてその画面へ移る）。
// 先に取り付ける必要があるので、このモジュールを読み込んだ時点（App が描かれる前）で取り付ける。
// hashchange も同じ判定で受ける（popstate を出さない環境の後詰め）。

/** 画面の移動が確定した URL と、その時の history.state（戻す先） */
let acceptedUrl: string | null = null
let acceptedState: unknown = null
let blockedCb: ((to: string) => void) | null = null
/** 止めた後に history.go で元の位置へ戻している最中（その popstate は react-router へ渡さない） */
let restoring = false
/** 〔移動する〕で止めた移動をやり直している最中（次に画面が確定するまで止めない） */
let passThrough = false
/** 止めた移動の向きと幅（history.go に渡す値。null＝位置が分からないので積み直した） */
let pendingDelta: number | null = null

/** 画面の移動が確定した（App が画面が変わるたびに呼ぶ）。止めた時に戻す先として控える */
export function markAccepted(): void {
  if (typeof window === 'undefined') return
  acceptedUrl = window.location.href
  acceptedState = window.history.state
  passThrough = false
}

/** 戻る・進む・アドレスの書き換えを止めた時の知らせ先（App が確認ダイアログを出す）。戻り値で解除する */
export function onBlockedNavigation(cb: (to: string) => void): () => void {
  blockedCb = cb
  return () => {
    if (blockedCb === cb) blockedCb = null
  }
}

/**
 * 止めた移動を〔移動する〕でやり直す。戻る・進むだった時は、同じ幅だけ history.go で動かす
 * （履歴を積み増さない）。位置が分からなかった時（アドレスの書き換え等）は fallback（画面の移動）を使う
 */
export function proceedBlocked(fallback: () => void): void {
  const delta = pendingDelta
  pendingDelta = null
  if (delta !== null && delta !== 0 && typeof window !== 'undefined') {
    passThrough = true
    window.history.go(delta)
    return
  }
  fallback()
}

/** 止めた移動を取りやめた（〔キャンセル〕） */
export function cancelBlocked(): void {
  pendingDelta = null
}

/** '#/record/vitals' → '/record/vitals'（空は '/'） */
export function hashToPath(hash: string): string {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  return h === '' ? '/' : h
}

/** react-router が history.state に持たせている履歴の位置（idx）。無ければ null */
export function historyIndex(state: unknown): number | null {
  if (typeof state !== 'object' || state === null) return null
  const idx = (state as { idx?: unknown }).idx
  return typeof idx === 'number' && Number.isInteger(idx) ? idx : null
}

function blockIfHeld(e: Event): void {
  if (restoring) {
    // 止めた後に元の位置へ戻した時の popstate。react-router へ渡さない
    if (e.type === 'popstate') restoring = false
    e.stopImmediatePropagation()
    return
  }
  if (passThrough) return
  if (blockedCb === null || acceptedUrl === null) return
  if (window.location.href === acceptedUrl) return
  if (!hasUnsavedInput()) return
  const to = hashToPath(window.location.hash)
  // react-router に渡さない（画面を切り替えさせない）
  e.stopImmediatePropagation()
  const popped = historyIndex(window.history.state)
  const accepted = historyIndex(acceptedState)
  if (e.type === 'popstate' && popped !== null && accepted !== null && popped !== accepted) {
    // 戻る・進む: 同じ幅だけ逆へ動かして元の位置へ戻す（履歴を A→B→A のように積み増さない＝再審 low-3）
    restoring = true
    pendingDelta = popped - accepted
    window.history.go(accepted - popped)
  } else {
    // 位置が分からない（アドレスの書き換え等）: 元の画面の URL を積み直す（state も元のまま）
    pendingDelta = null
    try {
      window.history.pushState(acceptedState, '', acceptedUrl)
    } catch {
      return
    }
  }
  blockedCb(to)
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('popstate', blockIfHeld)
  window.addEventListener('hashchange', blockIfHeld)
}
