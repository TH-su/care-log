// デイ（せせらぎ）段階2a: 1人の1日記録の純ロジック（副作用なし・DB/DOM に触れない）。tests/daycare-person.test.mjs から node で直接読む。
//
// ・昼食・おやつは既存の meals（lunch・snack）、水分は既存の fluid_intake をそのまま使う（保存は既存の saveMealEdits・insertFluid）
// ・昼食の割合は既存の食事一括と同じ 0〜10 の11段階、状態は「食べた」「拒食」（外出・入院はデイにいる方の記録なので出さない）
// ・おやつは「全部・半分・食べない」＝主食の欄に 10／5／0（既存の「間食」の枠）
// ・排泄は排泄ケアアプリを読むだけ（excretionClient）。入口は体重管理アプリと同じ作りで ?masterId=<residents.source_id>
// 個人情報は扱わない（数値と記号だけ。氏名は画面が持つ）。

import { daycareBulkRows } from './daycare.ts'
import type { AttendanceState, DaycareBoardRow } from './daycare.ts'
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

/** 今日の画面のカードの昼食の短い一言（2026-10-24 §9.4 の1。'主6・副4'・拒食・外出・入院。記録が無ければ '—'） */
export function lunchShortLabel(meal: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null | undefined): string {
  if (meal === null || meal === undefined) return '—'
  if (meal.status === 'refused') return '拒食'
  if (meal.status === 'out') return '外出'
  if (meal.status === 'hospital') return '入院'
  const m = meal.main_amount
  const s = meal.side_amount
  if (m === null && s === null) return '—'
  return `主${m === null ? '—' : m}・副${s === null ? '—' : s}`
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

/**
 * ほかの量（テンキー）の検査。全角・前後の空白は受け付ける。範囲外・小数・空は理由の文。
 * unit は文に出す単位（食事一括は「cc」で出す＝2026-10-28。記録は ml の列のまま・1cc＝1ml で換算しない）
 */
export function fluidAmountError(text: string, unit: 'ml' | 'cc' = 'ml'): string | null {
  const t = text.normalize('NFKC').trim()
  if (t === '') return '量を入れてください。'
  if (!/^\d+$/.test(t)) return `量は整数の ${unit} で入れてください。`
  const n = Number(t)
  if (n < 1 || n > DAYCARE_FLUID_MAX_ML) return `量は 1〜${DAYCARE_FLUID_MAX_ML} ${unit} で入れてください。`
  return null
}

/** 排泄ケアアプリの ?masterId= が受け付ける形（体重管理アプリと同じ・haiben-record.html の hbReadMasterIdParam） */
const MASTER_ID_RE = /^[0-9A-Za-z_-]{1,32}$/
/** 排泄ケアアプリ（care-log と同じサイトの haiben-record 配下＝th-su.github.io/haiben-record/。care-tools には無い。氏名は URL に載せない） */
export const HAIBEN_APP_PATH = '../haiben-record/haiben-record.html'

/**
 * 排泄ケアアプリを開くリンク（デイの1人の画面から）。2026-10-25（§9.7・§9.8 の A4）からデイの表示（?view=daycare）で開き、
 * その方を入力で選ぶ（?masterId=）。source_id が受け付ける形でなければデイの表示だけを開く。押す前に受け渡しのキーを書く（画面側）
 */
export function haibenAppHref(sourceId: string | null | undefined): string {
  const id = typeof sourceId === 'string' ? sourceId.trim() : ''
  return MASTER_ID_RE.test(id) ? `${HAIBEN_APP_PATH}?view=daycare&masterId=${encodeURIComponent(id)}` : `${HAIBEN_APP_PATH}?view=daycare`
}

/**
 * 1人の画面の〔前の方〕〔次の方〕: デイの一覧の並び（五十音）で、一括の画面と同じ方（予定の方のうち休み・入院中を除く全員と
 * 予定外で来た方＝daycareBulkRows）を回る。2026-10-24（§9.4）に到着をこの画面で押すようにしたので、到着の前の方も回る
 * （それまでは在席・帰宅の方だけ）。休み・入院中の方を開いている時は端へ
 */
export function personNav(rows: readonly Pick<DaycareBoardRow, 'residentId' | 'state' | 'planned' | 'hospitalized'>[], residentId: number): { prev: number | null; next: number | null } {
  const here = daycareBulkRows(rows).map((r) => r.residentId)
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

/**
 * 送信待ちの水分の消し込み。held.base＝前に見たサーバーの合計（画面から外した行を除く）、held.ml＝まだ載っていない量、
 * now＝取り直したサーバーの合計（同じく外した行を除く）。増えた分だけ「載った」と見て減らし、残りが無ければ null。
 * 合計が減った時（この端末や他の端末の取り消し）は載った分を 0 と見て基準だけ下げる（送信待ちの量を増やさない＝2a の確認の反証 中1）
 */
export function settleQueuedFluid(held: { base: number; ml: number }, now: number): { base: number; ml: number } | null {
  const landed = Math.max(0, now - held.base)
  const remain = held.ml - landed
  return remain > 0 ? { base: now, ml: remain } : null
}

// ── 今日の画面の改善 2回目: デイの食事一括（/record/daycare/meals・2026-10-24 代表承認・決定 6／親の回答 1〜2） ──

/**
 * 食事一括に並べる方: 一括の画面と同じ（予定の方のうち休み・入院中を除く全員と、予定外で来た方＝daycareBulkRows）。今日の一覧の並びのまま。
 * 到着の前でも入れられる（2026-10-24 代表者の決定 §9.4 の4。それまでは在席・帰宅だけ）
 */
export function mealBulkRows<T extends Pick<DaycareBoardRow, 'residentId' | 'state' | 'planned' | 'hospitalized'>>(rows: readonly T[]): T[] {
  return daycareBulkRows(rows)
}

/** 食事一括の画面のルート（業務日は ?day= で持つ。今日は付けない） */
export function mealBulkPath(day: string, today: string): string {
  return `/record/daycare/meals${day === today ? '' : `?day=${day}`}`
}

/** 昼食・おやつの保存の状態の種類（画面の SaveState の kind と同じ名前） */
export type MealSaveKind = 'saving' | 'saved' | 'queued' | 'conflict' | 'held' | 'rejected' | 'error'

/**
 * 1人の帯の端に出す保存の印（昼食・おやつのうち、いちばん手当てが要る方を出す）。
 * 食い違い・止まり・拒否・失敗 → ▲ 要確認／送信中 → ↻／送信待ち → ⚠ 未送信／保存できた → ✓ 保存済み。何も無ければ null
 */
export function mealBandMark(kinds: readonly (MealSaveKind | undefined)[]): { mark: string; text: string; tone: 'ok' | 'info' | 'warn' } | null {
  const has = (k: MealSaveKind) => kinds.includes(k)
  if (has('conflict') || has('held') || has('rejected') || has('error')) return { mark: '▲', text: '要確認', tone: 'warn' }
  if (has('saving')) return { mark: '↻', text: '送信中', tone: 'info' }
  if (has('queued')) return { mark: '⚠', text: '未送信', tone: 'warn' }
  if (has('saved')) return { mark: '✓', text: '保存済み', tone: 'ok' }
  return null
}

// ── 2026-10-28 食事一括を「昼食だけの1行1人の表」にした（代表者の依頼・親の回答 A1〜A9） ──

/** 昼食の主食・副食の欄（食事一括の表の列） */
export type LunchAmountField = 'main_amount' | 'side_amount'

/** 主食・副食の選択肢（端末の選択肢）の並び。value は ''＝未入力・'0'〜'10'＝割合・'refused'＝拒食 */
export const LUNCH_SELECT_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: '—（未入力）' },
  ...DAYCARE_MEAL_AMOUNTS.map((n) => ({ value: String(n), label: String(n) })),
  { value: 'refused', label: '拒食' },
]

/** 主食・副食の選択肢のいまの値: 拒食なら主食・副食の両方の欄が 'refused'。そうでなければその欄の値（null は ''） */
export function lunchSelectValue(meal: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null | undefined, f: LunchAmountField): string {
  if (meal === null || meal === undefined) return ''
  if (meal.status === 'refused') return 'refused'
  const v = meal[f]
  return v === null || v === undefined ? '' : String(v)
}

/**
 * 主食・副食の選択肢で選んだ値から、送る値を作る（1人の画面の昼食と同じ決まり）。
 * ・「拒食」: { status: 'refused' }（主食・副食の値は変えない＝それまでの〔拒食〕ボタンと同じ）
 * ・数字: その欄の値。拒食など「食べた」以外なら「食べた」に戻して送る（withEaten と同じ）
 * ・「—」: その欄を未入力（null）に戻す。拒食だった時は「食べた」に戻す
 * 選択肢に無い値は null（送らない）
 */
export function lunchSelectPatch(
  f: LunchAmountField,
  value: string,
  status: string | null | undefined,
): Partial<Record<LunchAmountField | 'status', number | string | null>> | null {
  if (value === 'refused') return { status: 'refused' }
  let v: number | null
  if (value === '') v = null
  else if (LUNCH_SELECT_OPTIONS.some((o) => o.value === value && /^\d+$/.test(o.value))) v = Number(value)
  else return null
  const patch: Partial<Record<LunchAmountField | 'status', number | string | null>> = { [f]: v }
  return status === null || status === undefined || status === 'eaten' ? patch : { ...patch, status: 'eaten' }
}

/**
 * 食事一括の表の上の「未入力 ○名」（2026-10-28 親の回答 A8・A9）。
 * 数えるのは在席・帰宅の方（state が present・left）のうち、昼食が拒食でなく、主食か副食が未入力（null）の方（拒食は入力済み・
 * 水分は数えない）。昼食の値は画面に出している値（送信待ち・順番待ちを重ねた値）を渡す。在席・帰宅でない方（未到着）は数えず、別に数を返す
 */
export function lunchUnfilledCount(
  rows: readonly { state: AttendanceState; lunch: Pick<Meal, 'main_amount' | 'side_amount' | 'status'> | null | undefined }[],
): { unfilled: number; notArrived: number } {
  let unfilled = 0
  let notArrived = 0
  for (const r of rows) {
    if (r.state !== 'present' && r.state !== 'left') {
      notArrived += 1
      continue
    }
    const m = r.lunch
    if (m !== null && m !== undefined && m.status === 'refused') continue
    if (m === null || m === undefined || m.main_amount === null || m.side_amount === null) unfilled += 1
  }
  return { unfilled, notArrived }
}
