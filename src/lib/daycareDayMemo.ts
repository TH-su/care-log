// デイの「その日の一覧」の控え（画面のメモリだけ・2026-10-24 親の検収 中1）。
//
// 今日の画面（DaycarePage）と1人の画面（DaycarePersonPage）が読めたその日の一覧（予定の写し・出欠・入浴・バイタル・食事・水分・名簿）を
// ここに1日分だけ置く。電波の無い所でカードを押して1人の画面を開いた時、1人の画面は自分で読み、通信の失敗の時だけ同じ日の控えで開く
// （到着・休み・入浴の書き込みは今までどおり送信待ちに積める）。前の方・次の方も控えの一覧で回れる。
//
// 規律:
// - 端末の保存（localStorage・sessionStorage・IndexedDB）には置かない（氏名・記録を端末に残さない）。画面を閉じる・再読み込みで消える
// - 使うのは「通信の失敗」の時だけ（サーバーの拒否・権限・設定待ちの時は使わない＝今のエラーのまま）。違う日の控えは使わない
// - 業務の値の正本はサーバー。控えは「読んだ時点の内容」と帯で知らせて出す。控えで開いた画面から書く時は控えの rev で組むが、
//   書き込みは rev 照合なので、サーバーの rev と違えば食い違いで止まる（上書きしない）。送信待ちも送る時に同じ照合を受ける

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
  /** 食事・水分を読めたか（読めなかった時の空の一覧を「記録なし」として使わない＝確認の反証 中1） */
  intakeOk: boolean
  /** 名簿（退居された方も含む・氏名を引くため）。読めていない時は空 */
  residents: Resident[]
  /** サーバーから読めた時刻（Date.now()。帯の「読んだ時点」に出す＝控えに入れた時刻ではない） */
  savedAt: number
}

let memo: DaycareDayMemo | null = null

/**
 * その日の一覧を控える（前の控えは捨てる＝1日分だけ）。名簿が空の時は前の控えの名簿を残す。
 * 食事・水分を読めなかった一覧（intakeOk=false）の時は、同じ日の前の控えの食事・水分（読めた値）を残す（親の反証 軽3・2026-10-25）
 */
export function rememberDaycareDay(m: DaycareDayMemo): void {
  memo = mergeDaycareMemo(memo, m)
}

/** rememberDaycareDay の中身（純関数）: 前の控え prev に新しい一覧 next を重ねる */
export function mergeDaycareMemo(prev: DaycareDayMemo | null, next: DaycareDayMemo): DaycareDayMemo {
  const residents = next.residents.length === 0 && prev !== null ? prev.residents : next.residents
  const keepIntake = !next.intakeOk && prev !== null && prev.day === next.day && prev.intakeOk
  return keepIntake
    ? { ...next, residents, meals: prev.meals, fluids: prev.fluids, intakeOk: true }
    : { ...next, residents }
}

/** いまの控え（無ければ null） */
export function daycareDayMemo(): DaycareDayMemo | null {
  return memo
}

/**
 * 書けた記録を控えにも映す（今日の画面・1人の画面が画面の data を直す時に同じ形で直す＝親の確かめ 中2・2026-10-25）。
 * 控えの日と違う日の記録は触らない。控えから書き込みを組み立てない（画面に出す値を合わせるだけ）
 */
export function updateDaycareDayMemo(fn: (m: DaycareDayMemo) => DaycareDayMemo): void {
  if (memo !== null) memo = fn(memo)
}

/** 控えの出欠の行を、書けた行で置き換える（同じ行・同じ方の行を外して足す＝画面の putAttendance と同じ）。違う日は元のまま */
export function memoWithAttendance(m: DaycareDayMemo, r: DaycareAttendance): DaycareDayMemo {
  if (m.day !== r.day) return m
  return { ...m, attendance: [...m.attendance.filter((a) => a.id !== r.id && a.resident_id !== r.resident_id), r] }
}

/** 控えから取り消した出欠の行を外す（画面の dropAttendance と同じ）。違う日は元のまま */
export function memoWithoutAttendance(m: DaycareDayMemo, r: DaycareAttendance): DaycareDayMemo {
  if (m.day !== r.day) return m
  return { ...m, attendance: m.attendance.filter((a) => a.id !== r.id) }
}

/** 控えの入浴の行を、書けた行で置き換える（同じ方の行を外して足す＝画面の putBath と同じ）。違う日は元のまま */
export function memoWithBath(m: DaycareDayMemo, r: BathRecord): DaycareDayMemo {
  if (m.day !== r.bath_on) return m
  return { ...m, baths: [...m.baths.filter((b) => b.resident_id !== r.resident_id), r] }
}

/** 控えに書けた水分の行を足す（画面の insertFluid の後と同じ）。違う日・同じ行が既にある時は元のまま */
export function memoWithFluid(m: DaycareDayMemo, f: FluidIntake): DaycareDayMemo {
  if (m.day !== f.taken_on || m.fluids.some((x) => x.id === f.id)) return m
  return { ...m, fluids: [...m.fluids, f] }
}

/** 控えから取り消した水分の行を外す（画面の softDeleteFluid の後と同じ）。違う日は元のまま */
export function memoWithoutFluid(m: DaycareDayMemo, f: Pick<FluidIntake, 'id' | 'taken_on'>): DaycareDayMemo {
  if (m.day !== f.taken_on) return m
  return { ...m, fluids: m.fluids.filter((x) => x.id !== f.id) }
}

/** 控えの昼食・おやつの行を、書けた行で置き換える（画面の saveMealEdits の後と同じ。取り込み・画面の入力の印は渡された値）。違う日は元のまま */
export function memoWithMeal(m: DaycareDayMemo, row: DaycareMealRow): DaycareDayMemo {
  if (m.day !== row.meal.meal_on) return m
  return { ...m, meals: [...m.meals.filter((x) => x.meal.id !== row.meal.id), row] }
}

/** 控えを消す（ログアウト・ログインのし直し＝cachedReads の resetDataCache。次にログインした人へ前の人の控えを見せない） */
export function clearDaycareDayMemo(): void {
  memo = null
}

/**
 * 通信の失敗か（db.ts の DbError の kind 'network' だけ。fetch の失敗は db.ts が network に直す）。サーバーの拒否・権限・設定待ち・
 * コードの不具合（素の TypeError など）は false＝控えで隠さない（確認の反証 軽4）
 */
export function isNetworkReadError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { kind?: unknown }).kind === 'network'
}

/** 1人の画面の読み込みが失敗した時に使ってよい控え: 通信の失敗で、同じ日の控えがある時だけ（それ以外は null＝今のエラーのまま） */
export function memoForDay(m: DaycareDayMemo | null, day: string, err: unknown): DaycareDayMemo | null {
  if (m === null || m.day !== day) return null
  return isNetworkReadError(err) ? m : null
}
