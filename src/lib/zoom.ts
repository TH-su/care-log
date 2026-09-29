// 表示倍率（日報・バイタル一覧・食事一覧の3画面で共通の --sheet-zoom）。2026-09-29 ピンチで変えられるようにした。
// - 値は 75〜200% の 5% 刻み。ボタンの既定値（ZOOM_STEPS＝100/125/150/200）の ±3% 以内は既定値に吸着する
// - 端末ごとの UI 状態として LS.zoom に保存する（原則11。業務データは持たない）
// - 小さな store（getZoom / subscribeZoom / setZoom）。ZoomBar は useSyncExternalStore で追従する
//   （ピンチで変わった値もボタンの選択表示に出る）
// - この部品は DOM の --sheet-zoom を書くだけ。React の再描画は起こさない（表の中身・打ちかけの入力を描き直さない）
import { LS, ZOOM_STEPS } from './types'

/** 範囲・刻み・吸着の幅（%） */
export const ZOOM_MIN = 75
export const ZOOM_MAX = 200
export const ZOOM_STEP = 5
export const ZOOM_SNAP = 3
/** 不正値・未保存のフォールバック先（スプシ完全一致＝13px 基準） */
export const DEFAULT_ZOOM = 100

/** 受け付けられる倍率か（範囲内の 5 の倍数） */
function isValidZoom(n: number): boolean {
  return Number.isFinite(n) && n >= ZOOM_MIN && n <= ZOOM_MAX && n % ZOOM_STEP === 0
}

/** ピンチなどで得た生の倍率を、範囲に収め、既定値へ吸着し、5% 刻みに丸める */
export function snapZoom(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_ZOOM
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw))
  for (const p of ZOOM_STEPS) if (Math.abs(clamped - p) <= ZOOM_SNAP) return p
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(clamped / ZOOM_STEP) * ZOOM_STEP))
}

/** 保存済みの倍率を照合して読む（範囲外・5 の倍数でない値・壊れた値・参照不能は 100% へ） */
export function readZoom(): number {
  try {
    const raw = window.localStorage.getItem(LS.zoom)
    if (raw === null || raw.trim() === '') return DEFAULT_ZOOM
    const n = Number(raw)
    return isValidZoom(n) ? n : DEFAULT_ZOOM
  } catch {
    return DEFAULT_ZOOM // プライベートモード等で参照できない場合も表示は続ける
  }
}

function writeZoom(z: number): void {
  try {
    window.localStorage.setItem(LS.zoom, String(z))
  } catch {
    // 保存できなくても当セッションの表示は成立させる（安全側フォールバック）
  }
}

/** sheet.css が calc で参照する倍率（0.75〜2）を documentElement に反映する */
export function applyZoom(z: number): void {
  document.documentElement.style.setProperty('--sheet-zoom', String(z / 100))
}

let current: number | null = null
const listeners = new Set<() => void>()

/** いまの倍率（初回は保存から読む） */
export function getZoom(): number {
  if (current === null) current = readZoom()
  return current
}

export function subscribeZoom(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 倍率を確定する（丸めて・保存し・画面に反映し・購読者へ知らせる）。確定した値を返す */
export function setZoom(z: number): number {
  const next = isValidZoom(z) ? z : snapZoom(z)
  applyZoom(next)
  if (next === getZoom()) return next
  current = next
  writeZoom(next)
  for (const fn of [...listeners]) fn()
  return next
}
