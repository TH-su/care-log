// デイの「その日の一覧」の控え（画面のメモリだけ・2026-10-24 親の検収 中1）。
//
// 今日の画面（DaycarePage）と1人の画面（DaycarePersonPage）が読めたその日の一覧（予定の写し・出欠・入浴・バイタル・食事・水分・名簿）を
// ここに1日分だけ置く。電波の無い所でカードを押して1人の画面を開いた時、1人の画面は自分で読み、通信の失敗の時だけ同じ日の控えで開く
// （到着・休み・入浴の書き込みは今までどおり送信待ちに積める）。前の方・次の方も控えの一覧で回れる。
//
// 規律:
// - 端末の保存（localStorage・sessionStorage・IndexedDB）には置かない（氏名・記録を端末に残さない）。画面を閉じる・再読み込みで消える
// - 使うのは「通信の失敗」の時だけ（サーバーの拒否・権限・設定待ちの時は使わない＝今のエラーのまま）。違う日の控えは使わない
// - 業務の値の正本はサーバー。控えは「読んだ時点の内容」と帯で知らせて出すだけで、控えから書き込みを組み立てない

import type { DaycareMealRow } from './db'
import type { KeyedVital } from './daycare'
import type { BathRecord, DaycareAttendance, DaycareDay, DaycarePlanRow, DaycarePlanSource, FluidIntake, Resident } from './types'

export interface DaycareDayMemo {
  day: string
  planRows: DaycarePlanRow[]
  planSource: DaycarePlanSource
  snapshot: DaycareDay | null
  missing: boolean
  attendance: DaycareAttendance[]
  baths: BathRecord[]
  vitals: KeyedVital[]
  meals: DaycareMealRow[]
  fluids: FluidIntake[]
  /** 名簿（退居された方も含む・氏名を引くため）。読めていない時は空 */
  residents: Resident[]
  /** 控えた時刻（Date.now()） */
  savedAt: number
}

let memo: DaycareDayMemo | null = null

/** その日の一覧を控える（前の控えは捨てる＝1日分だけ）。名簿が空の時は前の控えの名簿を残す */
export function rememberDaycareDay(m: DaycareDayMemo): void {
  const residents = m.residents.length === 0 && memo !== null ? memo.residents : m.residents
  memo = { ...m, residents }
}

/** いまの控え（無ければ null） */
export function daycareDayMemo(): DaycareDayMemo | null {
  return memo
}

/** 試験用: 控えを消す */
export function clearDaycareDayMemo(): void {
  memo = null
}

/** 通信の失敗か（DbError の network・fetch の TypeError）。サーバーの拒否・権限・設定待ちは false */
export function isNetworkReadError(e: unknown): boolean {
  if (e instanceof TypeError) return true
  return typeof e === 'object' && e !== null && (e as { kind?: unknown }).kind === 'network'
}

/** 1人の画面の読み込みが失敗した時に使ってよい控え: 通信の失敗で、同じ日の控えがある時だけ（それ以外は null＝今のエラーのまま） */
export function memoForDay(m: DaycareDayMemo | null, day: string, err: unknown): DaycareDayMemo | null {
  if (m === null || m.day !== day) return null
  return isNetworkReadError(err) ? m : null
}
