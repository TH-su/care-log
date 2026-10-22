// デイ（せせらぎ）段階2a: 1人の1日記録の純ロジック（副作用なし・DB/DOM に触れない）。tests/daycare-person.test.mjs から node で直接読む。
//
// ・昼食・おやつは既存の meals（lunch・snack）、水分は既存の fluid_intake をそのまま使う（保存は既存の saveMealEdits・insertFluid）
// ・昼食の割合は既存の食事一括と同じ 0〜10 の11段階、状態は「食べた」「拒食」（外出・入院はデイにいる方の記録なので出さない）
// ・おやつは「全部・半分・食べない」＝主食の欄に 10／5／0（既存の「間食」の枠）
// ・排泄は排泄ケアアプリを読むだけ（excretionClient）。入口は体重管理アプリと同じ作りで ?masterId=<residents.source_id>
// 個人情報は扱わない（数値と記号だけ。氏名は画面が持つ）。

import type { DaycareBoardRow } from './daycare.ts'
import type { FluidIntake, Meal } from './types.ts'

/** 昼食の主食・副食の割合（既存の食事一括と同じ 0〜10 の11段階） */
export const DAYCARE_MEAL_AMOUNTS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

/** おやつの3択（主食の欄に入れる値） */
export const DAYCARE_SNACK_CHOICES: readonly { label: string; value: number }[] = [
  { label: '全部', value: 10 },
  { label: '半分', value: 5 },
  { label: '食べない', value: 0 },
]

/** 水分の加算チップ（既存の食事・水分の一括入力と同じ） */
export const DAYCARE_FLUID_STEPS: readonly number[] = [100, 150, 200]
/** 1回の水分の上限（ml・DB の check と同じ・打ちすぎを止める） */
export const DAYCARE_FLUID_MAX_ML = 2000

/** 昼食の表示（拒食・外出・入院・割合・記録なし） */
export function lunchLabel(meal: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null | undefined): string {
  if (meal === null || meal === undefined) return '記録なし'
  if (meal.status === 'refused') return '拒食'
  if (meal.status === 'out') return '外出'
  if (meal.status === 'hospital') return '入院'
  const m = meal.main_amount
  const s = meal.side_amount
  if (m === null && s === null) return '記録なし'
  return `主食 ${m === null ? '—' : `${m}割`}・副食 ${s === null ? '—' : `${s}割`}`
}

/** おやつの表示（3択の名前・それ以外の値は割合のまま） */
export function snackLabel(meal: Pick<Meal, 'main_amount' | 'status'> | null | undefined): string {
  if (meal === null || meal === undefined) return '記録なし'
  if (meal.status === 'refused') return '食べない'
  const c = DAYCARE_SNACK_CHOICES.find((x) => x.value === meal.main_amount)
  if (c !== undefined) return c.label
  return meal.main_amount === null ? '記録なし' : `${meal.main_amount}割`
}

/** 取り込みの印（取り込んだまま／取り込んだ後に画面で直した／画面で入れた） */
export function mealSourceLabel(row: { imported: boolean; editedInApp: boolean } | null | undefined): string | null {
  if (row === null || row === undefined) return null
  if (row.imported && !row.editedInApp) return 'スプレッドシートから取り込み'
  if (row.imported && row.editedInApp) return '取り込み後に画面で直した'
  return '画面で入力'
}

/** その方・その日の水分の合計（ml） */
export function fluidTotalOf(fluids: readonly Pick<FluidIntake, 'resident_id' | 'taken_on' | 'amount_ml'>[], residentId: number, day: string): number {
  let sum = 0
  for (const f of fluids) if (f.resident_id === residentId && f.taken_on === day && Number.isFinite(f.amount_ml)) sum += f.amount_ml
  return sum
}

/** ほかの量（テンキー）の検査。全角・前後の空白は受け付ける。範囲外・小数・空は理由の文 */
export function fluidAmountError(text: string): string | null {
  const t = text.normalize('NFKC').trim()
  if (t === '') return '量を入れてください。'
  if (!/^\d+$/.test(t)) return '量は整数の ml で入れてください。'
  const n = Number(t)
  if (n < 1 || n > DAYCARE_FLUID_MAX_ML) return `量は 1〜${DAYCARE_FLUID_MAX_ML} ml で入れてください。`
  return null
}

/** 排泄ケアアプリの ?masterId= が受け付ける形（体重管理アプリと同じ・haiben-record.html の hbReadMasterIdParam） */
const MASTER_ID_RE = /^[0-9A-Za-z_-]{1,32}$/
/** 排泄ケアアプリ（care-log と同じサイトの care-tools 配下。氏名は URL に載せない） */
export const HAIBEN_APP_PATH = '../care-tools/haiben-record.html'

/** 排泄ケアアプリを開くリンク。source_id が受け付ける形でなければアプリの最初の画面を開く */
export function haibenAppHref(sourceId: string | null | undefined): string {
  const id = typeof sourceId === 'string' ? sourceId.trim() : ''
  return MASTER_ID_RE.test(id) ? `${HAIBEN_APP_PATH}?masterId=${encodeURIComponent(id)}` : HAIBEN_APP_PATH
}

/** 1人の画面の〔前の方〕〔次の方〕: デイの一覧の並びで、在席・帰宅の方だけを回る（欠席・未到着は飛ばす） */
export function personNav(rows: readonly Pick<DaycareBoardRow, 'residentId' | 'state'>[], residentId: number): { prev: number | null; next: number | null } {
  const here = rows.filter((r) => r.state === 'present' || r.state === 'left').map((r) => r.residentId)
  const i = here.indexOf(residentId)
  if (i < 0) return { prev: here.length > 0 ? here[here.length - 1] : null, next: here.length > 0 ? here[0] : null }
  return { prev: i > 0 ? here[i - 1] : null, next: i < here.length - 1 ? here[i + 1] : null }
}

/** 1人の画面のルート（業務日は ?day= で持つ。今日は付けない） */
export function personPath(residentId: number, day: string, today: string): string {
  return `/record/daycare/person/${residentId}${day === today ? '' : `?day=${day}`}`
}

/** URL の ?day= を読む（形が違う・未来の日は今日） */
export function readPersonDay(raw: string | null, today: string): string {
  if (raw === null || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return today
  const d = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return today
  return raw > today ? today : raw
}
