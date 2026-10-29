// デイの「今日」の画面（DaycarePage）の1日の読み込みの段取り（2026-10-29 本人指示「要求の数と順番待ちを減らす」）。
//
// 前は、その日の予定の写し（daycare_days）を読み終えてから出欠・入浴・バイタル・食事と水分を読み、それも読み終えてから
// 活動を読んでいた（3段の順番待ち）。写しの結果を本当に待つのは予定（RPC daycare_plan・写しが無い／読めなかった日だけ読む）だけで、
// 他は写しと関係なく読める。ここでは写しと他の5つを同時に出し、予定だけを写しの後に出す（写しのある日は1段・無い日は2段）。
//
// 読み取りの関数は画面から渡す（ここは db.ts を読み込まない＝試験で偽物を渡して、出す順番と結果の扱いを確かめられる）。
// 結果の扱いは前と同じ:
// - 写しの読み取りがサーバー側の設定待ち（0041 未適用）なら missing。出欠は使わない（前は読みに行かなかった。いまは同時に出すので
//   読みに行くが、結果も失敗も捨てる）。写しのそれ以外の失敗はそのまま投げる（画面の控え・エラーの扱いへ）
// - 予定・出欠の失敗はそのまま投げる。入浴・バイタル・食事と水分・活動は失敗しても止めない（空・null）
// - 画面の世代（genRef）・日付の確かめ・DayData の組み立て・控え（daycareDayMemo）の扱いは画面に残す

import type { DaycareMealRow, DaycarePlanResult } from './db'
import type { DaycareActivity } from './daycareActivity'
import type { KeyedVital } from './daycare'
import type { BathRecord, DaycareAttendance, DaycareDay, FluidIntake } from './types'

/** 1日の読み込みに使う読み取り（画面は db.ts の関数を渡す） */
export interface DaycareDayReaders {
  day: (d: string) => Promise<DaycareDay | null>
  plan: (d: string) => Promise<DaycarePlanResult>
  attendance: (d: string) => Promise<DaycareAttendance[]>
  baths: (d: string) => Promise<BathRecord[]>
  /** その日のデイの測定（生きている行だけ。次の回のキーはこの画面では使わない） */
  vitals: (d: string) => Promise<KeyedVital[]>
  intake: (d: string) => Promise<{ meals: DaycareMealRow[]; fluids: FluidIntake[] }>
  activities: (d: string) => Promise<DaycareActivity[]>
  /** 写しの読み取りの失敗が「サーバー側の設定待ち」か（db.ts の DbError の kind 'server'） */
  isServerMissing: (e: unknown) => boolean
}

/** 読めた部品（DayData の組み立ては画面） */
export interface DaycareDayParts {
  snapshot: DaycareDay | null
  /** 写しの表が無い（0041 未適用） */
  missing: boolean
  /** 予定（写しが使える日は読まない＝null） */
  plan: DaycarePlanResult | null
  attendance: DaycareAttendance[]
  baths: BathRecord[]
  vitals: KeyedVital[]
  /** 読めない時は null（空の一覧を「読めた」にしない） */
  intake: { meals: DaycareMealRow[]; fluids: FluidIntake[] } | null
  /** 読めない時は null（印を出さない） */
  activities: DaycareActivity[] | null
}

export async function loadDaycareDayParts(target: string, r: DaycareDayReaders): Promise<DaycareDayParts> {
  // 写しと関係なく読めるものは、写しと同時に出す
  const pAttendance = r.attendance(target)
  // 写しが設定待ちで出欠を捨てる時・写しの失敗で先に投げる時に、出欠の失敗を「受け手の無い失敗」にしない
  pAttendance.catch(() => undefined)
  const pBaths = r.baths(target).catch(() => [] as BathRecord[])
  const pVitals = r.vitals(target).catch(() => [] as KeyedVital[])
  const pIntake = r.intake(target).catch(() => null)
  const pActivities = r.activities(target).catch(() => null)

  let snapshot: DaycareDay | null = null
  let missing = false
  try {
    snapshot = await r.day(target)
  } catch (e) {
    if (r.isServerMissing(e)) missing = true
    else throw e
  }
  // 写しが「読めなかった」（unknown）の日は、いまの週間計画も読む（読めれば表示に使い、次のタップで写し直す＝反証レビュー中2）
  const usable = snapshot !== null && snapshot.plan_source !== 'unknown'
  const [plan, attendance, baths, vitals, intake, activities] = await Promise.all([
    usable ? Promise.resolve(null) : r.plan(target),
    missing ? Promise.resolve([] as DaycareAttendance[]) : pAttendance,
    pBaths,
    pVitals,
    pIntake,
    pActivities,
  ])
  return { snapshot, missing, plan, attendance, baths, vitals, intake, activities }
}
