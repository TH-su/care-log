// 申し送りの時間によるロックの判定（純関数・副作用なし。2026-10-15 本人回答・仕様 §2）。
// サーバーのトリガ（supabase/migrations/0033_note_lock.sql の private.note_lock_at）と同じ規則。ただし画面は猶予なし
// （サーバーだけ 30分の猶予＝圏外で書いて後から届く分のため）。
//
//   日勤（shift='day' かつ after16=false）・デイ（shift='daycare'）… 記録日の 17:00
//   16時以降（shift='day' かつ after16=true）                         … 記録日の 24:00（翌日の 0:00）
//   夜勤（shift='night'）                                              … 翌朝 8:00
//   ちょうどその時刻からロック（17:00:00 は書けない）。時刻は日本時間（端末の時刻帯には左右されない）。
//
// 拡張子付きで import する（tests から直接読めるようにするため）。個人情報は扱わない。

import type { Shift } from './types.ts'

/** 日本時間の UTC からのずれ（ms）。日本には夏時間が無いので固定 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** サーバーだけが足す猶予（分）。画面の判定には使わない（試験・説明用に公開） */
export const NOTE_LOCK_SERVER_GRACE_MIN = 30

export interface NoteLockState {
  /** いまロック中か（画面の判定＝猶予なし） */
  locked: boolean
  /** ロックの時刻（epoch ms）。記録日が読めない時は null（その時はロックしない＝サーバーの判定に任せる） */
  lockAt: number | null
  /** 表題帯に出す時刻の書き方（'17:00'・'24:00'・'翌8:00'）。記録日が読めない時は '' */
  label: string
}

/** 区分ごとのロックの時刻（記録日の 0:00 からの時間）と書き方 */
function lockOffset(shift: Shift, after16: boolean): { hours: number; label: string } {
  if (shift === 'night') return { hours: 24 + 8, label: '翌8:00' }
  if (shift === 'day' && after16) return { hours: 24, label: '24:00' }
  return { hours: 17, label: '17:00' }
}

/**
 * ロックの時刻（epoch ms）。day は 'YYYY-MM-DD'（記録日 note_on）。読めない日付は null。
 * 例: ('2026-10-15', 'day', false) → 2026-10-15 17:00 JST
 */
export function noteLockAt(day: string, shift: Shift, after16: boolean): number | null {
  const m = DAY_RE.exec(day)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const base = Date.UTC(y, mo - 1, d)
  // 存在しない日付（2026-02-30 など）は読めない日付として扱う
  const back = new Date(base)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return base - JST_OFFSET_MS + lockOffset(shift, after16).hours * 60 * 60 * 1000
}

/**
 * その欄（記録日・区分・16時以降）がいまロック中か。now は Date か epoch ms（既定はいま）。
 * 画面は猶予なしで判定する（サーバーは +30分）。未来の日はロックの時刻が来ていないので locked=false
 */
export function lockState(day: string, shift: Shift, after16: boolean, now: Date | number = Date.now()): NoteLockState {
  const at = noteLockAt(day, shift, after16)
  if (at === null) return { locked: false, lockAt: null, label: '' }
  const t = typeof now === 'number' ? now : now.getTime()
  return { locked: Number.isFinite(t) && t >= at, lockAt: at, label: lockOffset(shift, after16).label }
}

/**
 * 次にロックの表示が変わるまでの時間（ms）。まだロックしていない欄のうち一番早いロックの時刻まで。
 * 無ければ null（画面は1分ごとの見直しと visibilitychange に任せてよい）
 */
export function msUntilNextLock(
  sections: ReadonlyArray<{ day: string; shift: Shift; after16: boolean }>,
  now: Date | number = Date.now(),
): number | null {
  const t = typeof now === 'number' ? now : now.getTime()
  let best: number | null = null
  for (const s of sections) {
    const at = noteLockAt(s.day, s.shift, s.after16)
    if (at === null || at <= t) continue
    if (best === null || at - t < best) best = at - t
  }
  return best
}
