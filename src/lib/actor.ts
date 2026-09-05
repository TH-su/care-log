// 操作職員（記入者）の同定レイヤー。
// 「認証（Supabase Auth）＝端末が書き込めるか」と「操作者＝誰として記録・既読するか」を分ける（ui-design.md §0）。
// localStorage に置くのは staff_id の数値と最終操作時刻の数値だけで、氏名・かな・記録本文は一切保持しない。

// 拡張子付きで import する（tsconfig の allowImportingTsExtensions。
// tests/logic.test.mjs の node --experimental-strip-types から直接読めるようにするため）
import { LS } from './types.ts'
import type { Staff } from './types.ts'
import { isoDate, todayIso } from './format.ts'

/** 最終操作時刻（epoch ms・数値のみ）。UI状態キーと同じ cl_ プレフィクスで保持する */
const SEEN_AT_KEY = 'cl_actorSeenAt'

/** 再確認のしきい値: 最終操作から4時間（PLAN.md 操作者モデル・ui-design.md §0） */
const RECONFIRM_MS = 4 * 60 * 60 * 1000

// localStorage が使えない環境（プライベートモード・容量超過・非ブラウザ）でも起動不能にしないための
// 同一セッション内フォールバック。保持するのは上記2件の数値のみ。
const memory = new Map<string, string>()

function readRaw(key: string): string | null {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
    if (v != null) return v
  } catch {
    // 読めない環境ではメモリ側にフォールバックする
  }
  return memory.get(key) ?? null
}

function writeRaw(key: string, value: string): void {
  memory.set(key, value)
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // 保存できなくても処理は続行（メモリ側には残る）
  }
}

function removeRaw(key: string): void {
  memory.delete(key)
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
  } catch {
    // 消せなくても後続の照合で弾かれる
  }
}

/** 正の安全整数だけを受け入れる（'0'・'-1'・'12abc'・小数・空文字・巨大値は不正値として null） */
function parseNumericId(raw: string | null): number | null {
  if (raw == null) return null
  const s = raw.trim()
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** 保持中の操作者 staff_id。未設定・不正値は null（staff 一覧との突合は resolveActor が行う） */
export function getActorId(): number | null {
  return parseNumericId(readRaw(LS.staffId))
}

/** 操作者を確定する。確定はそれ自体が操作なので最終操作時刻も更新する（直後の再確認を防ぐ） */
export function setActorId(id: number): void {
  // 不正値で既存の保持値を壊さない（壊れた値で起動不能にしない）
  if (!Number.isSafeInteger(id) || id <= 0) return
  writeRaw(LS.staffId, String(id))
  touchActivity()
}

/** 操作者を解除する（明示切替・照合失敗時のフォールバック） */
export function clearActor(): void {
  removeRaw(LS.staffId)
  removeRaw(SEEN_AT_KEY)
}

/**
 * 保持中の staff_id を staff スナップショットと照合する。
 * 不在・退職（active=false）・不正値はすべて null ＝ 操作者ピッカーへフォールバックさせる。
 * 読み取り経路なので保持値の書き換え・消去は行わない。
 */
export function resolveActor(staff: Staff[]): Staff | null {
  const id = getActorId()
  if (id == null || !Array.isArray(staff)) return null
  const hit = staff.find((s) => s != null && s.id === id)
  return hit != null && hit.active === true ? hit : null
}

/**
 * 「（職員名）として記録します」の再確認が必要か。
 * 日付が変わった／最終操作から4時間経過／記録が無い・壊れている場合は true。
 * 判定不能は true（＝確認を出す）に倒す。誤帰属の記録・既読を作らないため。
 */
/**
 * ★2026-09-05 時点で呼び出し元は無い。
 *   起動時・復帰時に「記録する職員」を確認させるモーダルは廃止した（1台を複数人で使うため、
 *   端末に1人を紐づける前提が実務に合わず、選ぶまで閲覧すらできなかった）。
 *   記入者は記録ごとに選ぶ。判定そのものは残す（個人端末向けに戻す判断が出た時のため）。
 */
export function shouldReconfirm(): boolean {
  const seen = parseNumericId(readRaw(SEEN_AT_KEY))
  if (seen == null) return true
  const now = Date.now()
  if (seen > now) return true // 端末時計のずれ・不正値は安全側へ
  if (now - seen >= RECONFIRM_MS) return true
  return isoDate(new Date(seen)) !== todayIso()
}

/** 最終操作時刻を更新する。UI の明示操作を起点にのみ呼ぶ（一覧描画から呼ばない） */
export function touchActivity(): void {
  writeRaw(SEEN_AT_KEY, String(Date.now()))
}
