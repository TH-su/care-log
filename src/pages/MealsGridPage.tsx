// 食事・水分の一括入力（記録ハブ →「食事一括」= 2タップ）。
// 契約: docs/design/contracts.md ／ 詳細: docs/design/ui-design.md §6・§0.5、db-design.md §5
//
// この画面が守る規律:
// - 取得は日付レンジ指定の fetchTimelineChunk（当日1日分）と fetchResidents のみ。全件ロード経路を作らない
// - 保存は saveMealEdits（送信待ち → RPC apply_cell_edits の1本・2026-09-23 フェーズ2'）。送るのは編集した欄と
//   その基準だけで、書くかどうかはサーバーが欄ごとに決める（部分更新・空上書きをしない）
// - 競合（conflict）でも入力を消さない。表示中の値は残したまま「最新を読み込む」を促す
// - 送信できなかった分は db.ts の送信待ちに残り、この画面は「⚠未送信」と表示するだけ（消さない）。
//   送信待ち・止まっている行は pendingRow から読み、再読み込み・再マウントの後も同じ見え方にする
// - 入力解禁フラグ（native_input_enabled）はこの画面を開くたびに取り直す。取得できるまでは入力させない
// - 外出・外泊は「参考chip」の表示のみ。食事の状態（status）へ自動反映しない（ui-design §6【#6】）
// - 実名・記録本文をコード・コメント・localStorage・console に書かない（表示は実行時の props/取得値のみ）
// - Tailwind はトークン由来クラスのみ（色・px の直書き・arbitrary value を書かない）
// - 他の端末の記録（食事・水分・外出）は subscribeChanges で受け、当日の分の変更だけを合図に背景で取り直す（F17・
//   2026-10-10。入力中・未送信・競合の行の控えはそのまま）。復帰・電波の復帰・購読のつながり直しは db.ts が流す
//   RESYNC（行なし）で受ける（F14）。送信待ちが減った時も取り直す（裏で送れた分の「⚠ 未送信」を外す）
// - 表示中の日は開いた日。日付をまたいだら、入力中・未送信が無ければ今日へ切り替え、残っていれば帯で知らせる（F18）
// - 保存領域が一杯で送信待ちを端末に残せない時は、送信待ちとして案内せず入力を残す（F01）
// - 選んだ階は画面ごとの UI 状態として保存し、一覧にある階と照合して復元する（F68・原則11）

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FocusEvent as ReactFocusEvent } from 'react'
import {
  FORBIDDEN_REASON,
  DbError,
  discardPendingRow,
  fetchLatestMeal,
  fetchResidents,
  fetchTimelineChunk,
  getNativeInputGate,
  insertFluid,
  isQueuePersisted,
  isSelfWrite,
  pendingRow,
  queueSubscribe,
  saveMealEdits,
  softDeleteFluid,
  subscribeChanges,
} from '../lib/db'
import type { ChangeInfo, PendingCellRow } from '../lib/db'
import { getActorId, touchActivity } from '../lib/actor'
import { fmtDayLabel, toHalfWidth, todayIso } from '../lib/format'
import { recordTimeFor } from '../lib/nextMorning'
import { MEAL_SLOT_LABEL, MEAL_STATUS_LABEL, OUTING_KIND_LABEL } from '../lib/types'
import type { FluidIntake, Meal, MealSlot, MealStatus, Outing, Resident } from '../lib/types'
import {
  Chip,
  ConfirmDialog,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  SectionCard,
  SegmentPicker,
  useToast,
} from '../components/ui'
import { ConflictResolver, focusAfterResolve } from '../components/ConflictResolver'
import type { ConflictResolution, ConflictTarget } from '../components/ConflictResolver'
import {
  CELLS_PENDING_REASON,
  fmtMealValue,
  holdsNormalSave,
  MEAL_FIELD_NAME,
  MEAL_FIELDS,
  mealHeldText,
  missingRowText,
  valuesForBoth,
} from '../lib/conflict'
import {
  editBases,
  editValues,
  adoptPendingEdits,
  hasEdits,
  isOlderRow,
  judgeFields,
  reconcileOnLoad,
  recordFieldEdit,
  seenVers,
  settleSent,
} from '../lib/rowSync'
import type { Edits } from '../lib/rowSync'
import { LEAVE_TITLE, registerUnsaved } from '../lib/leaveGuard'
import type { MealField } from '../lib/conflict'
import { focusOf, useCellPresence } from '../hooks/useCellPresence'
import type { BusyText, CellTarget } from '../lib/presence'
import { BUSY_RING_OUTSIDE, BusyMark, PresenceSummary, RowBusyMark } from '../components/presence'
import type { LeaveCell } from '../hooks/useCellPresence'
import { RecorderBar } from '../components/RecorderBar'

// ── 定数 ─────────────────────────────────────────────────────

/** 主食・副食の摂取量（現行スプシと同じ 0〜10 の11段階）。各ボタンは 44×44・間隔8px */
const AMOUNTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const
/** 水分の加算チップ（ui-design §6） */
const FLUID_STEPS = [100, 150, 200] as const
/** 任意量入力で受け付ける水分量（ml）の上限。誤打（0の打ちすぎ）を止める歯止め */
const FLUID_MAX_ML = 2000
/** 食事枠の並び（DB の meal_slot と同じ語彙） */
const SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack']
/** 食事の状態4値（QA監査 low「4値セレクタへ」） */
const STATUSES: MealStatus[] = ['eaten', 'out', 'hospital', 'refused']

const SLOT_OPTIONS = SLOTS.map((s) => ({ value: s, label: MEAL_SLOT_LABEL[s] }))
const STATUS_OPTIONS = STATUSES.map((s) => ({ value: s, label: MEAL_STATUS_LABEL[s] }))
/** 居室が未設定の利用者を入れるフロア区分（誰も一覧から漏れないようにする） */
const FLOOR_OTHER = 'other'

/** 入力封鎖中の理由文（ui-design §0.5 の定型文。文言を変えない） */
const BLOCKED_TEXT =
  '現在はスプレッドシートで記録する期間です（アプリ入力の開始日は施設で決定します）'
const ERR_LOAD =
  '食事・水分の記録を読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'
const ERR_FLAG =
  'アプリで入力してよい期間かどうかを確認できませんでした。通信状況を確認して、「再試行する」を押してください。確認できるまで入力はできません。'
const ERR_CONFLICT =
  'ほかの端末で先に更新されました。入力は消えていません。「最新を読み込む」で最新の値を確認してから、もう一度入力してください。'
const ERR_SAVE =
  '保存できませんでした。入力は消えていません。通信状況を確認して、もう一度タップしてください。'
const MSG_QUEUED = '通信できないため送信待ちにしました。電波が戻ると自動で送信します。'
/**
 * 送信待ちにしたが、端末の保存領域が一杯で控えを残せなかった時（F01）。送信待ちはこのタブのメモリにだけあり、閉じる・
 * 再読み込み・iOS の自動終了で消える。「電波が戻ると自動で送信します」とは言わず、入力も控えに残す
 */
const MSG_NOT_PERSISTED =
  '送信待ちにしましたが、この端末に控えを残せませんでした（保存領域の空きが不足している可能性があります）。入力は消えていません。画面を閉じたり再読み込みしたりすると消えるので、この画面のまま電波の回復をお待ちください。'
/** 他端末の変更通知をまとめる待ち時間（ミリ秒）。連続して届いた通知は最後の1回だけ取り直す（食事一覧と同じ） */
const REALTIME_DEBOUNCE_MS = 1500
/**
 * 変更通知を受ける表と、その行の日付の列（当日の分だけを合図にする）。外出・外泊は期間で当たるので日付で絞らない
 * （帰着日を変えた・取り消した通知は、変更前の日付が届かないため）
 */
const WATCHED_DAY_COL: Record<string, string | null> = {
  meals: 'meal_on',
  fluid_intake: 'taken_on',
  outings: null,
}
/** 日付をまたいだかを見直す間隔（ミリ秒）。画面に戻った時・電波が戻った時にも見直す（F18） */
const DAY_CHECK_MS = 60_000
/**
 * 食事一括で選んでいる階（UI状態だけ・F68）。値は階の数字（'1' '2' …）か 'other'（居室未設定）。食事一覧の階
 * （cl_sheetFloor・「全」がある）とは選べる値が違うので別のキーにする。types.ts の LS は凍結契約のため、
 * 申し送りフォームの cl_notePhraseCat と同じく画面の中に置く
 */
export const MEALS_FLOOR_KEY = 'cl_mealsGridFloor'
const ERR_FLUID_UNDO =
  '水分の追加を取り消せませんでした。通信状況を確認して、もう一度お試しください。'
const ERR_FLUID_UNDO_CONFLICT =
  '水分の追加を取り消せませんでした（ほかの端末で更新されています）。「最新を読み込む」で最新の値を確認してください。'
/** 競合中の行に入力された時（くらべて選ぶまで保存しない＝5画面共通の規約） */
const ERR_CONFLICT_HOLD =
  'ほかの端末の値と食い違っているため、この入力はまだ保存していません。入力は消えていません。「くらべて選ぶ」でどちらを残すか選んでください。'
/** 最新を読み込んでも食い違いが残っている時（競合のまま） */
const ERR_CONFLICT_STILL =
  '最新を読み込みましたが、ほかの端末で先に入った値と食い違っています。入力は消えていません。「くらべて選ぶ」でどちらを残すか選んでください。'
/** 保存が、ほかの端末の値と食い違って止まっている行にまとめられた時（送らない。くらべて選ぶへ誘導する） */
const ERR_BLOCKED_WRITE =
  'ほかの端末の値と食い違って止まっている保存があります。いまの入力もそこにまとめました（まだ送っていません・入力は消えていません）。「くらべて選ぶ」でどちらを残すか選んでください。'
/** サーバーに受け付けられなかった保存（型・範囲の拒否）が送信待ちに残っている時 */
const ERR_REJECTED =
  'サーバーに受け付けられなかった保存があります（入力は消えていません）。値を確かめて、同じ値をもう一度押すと保存し直します。'
/** 読み直したら食い違いは無くなったが、まだ保存していない入力が残っている時 */
const MSG_UNSAVED_AFTER_RELOAD =
  'ほかの端末の更新を読み込みました（食い違いはありません）。表示中の値はまだ保存していません。同じ値をもう一度押すと保存します。'

// ── 純ロジック（副作用なし） ──────────────────────────────────

/** 編集の値を「主食 8割・副食 6割」の形に（取り消された行の控えの一言） */
function describeMealEdits(edits: Edits<MealField> | undefined): string {
  const mine = editValues(edits ?? {}) as Partial<Record<MealField, unknown>>
  return MEAL_FIELDS.filter((f) => f in mine)
    .map((f) => `${MEAL_FIELD_NAME[f]} ${fmtMealValue(f, mine[f])}`)
    .join('・')
}

/**
 * 送信待ちで止まっている行（競合・拒否）の値を、その行の「あなたの入力」として編集に取り込む（食事一覧と同じ）。
 * 画面に既に編集のある欄は画面の値を残す。基準は送信待ちの基準
 */
function adoptPending(edits: Edits<MealField>, p: PendingCellRow): Edits<MealField> {
  // 送信待ちにある全ての欄（〔両方残す〕のメモを含む）を取り込む（第3段 #4。画面の3欄に固定しない）
  return adoptPendingEdits(judgeFields(MEAL_FIELDS, p), edits as Edits<string>, p) as Edits<MealField>
}

/** 読み直しで突き合わせるいまの値（画面の3欄＋メモ。メモも送信待ちにあれば突き合わせる＝第3段 #4） */
function mealJudgeCells(m: Meal | null | undefined): Record<string, unknown> {
  return { ...mealCells(m), note: m?.note ?? null }
}

/** 受信データを信じない: 配列でなければ空配列に倒す */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

/** 居室文字列から階を取る（'102'→'1'）。数字が無い・未設定は FLOOR_OTHER */
function floorOf(room: string | null | undefined): string {
  if (!room) return FLOOR_OTHER
  const hit = /\d/.exec(room)
  return hit ? hit[0] : FLOOR_OTHER
}

/** 居室の数値部分（昇順並べ替え用）。数字が無ければ null（＝末尾へ） */
function roomNum(room: string | null | undefined): number | null {
  if (!room) return null
  const hit = /\d+/.exec(room)
  return hit ? Number(hit[0]) : null
}

/** 画面に出せるエラー文（db.ts の DbError は「何が起きた＋次にどうする」を持っている） */
function msgOf(e: unknown, fallback: string): string {
  return e instanceof DbError && e.message ? e.message : fallback
}

/**
 * 現在時刻から食事枠の初期値を決める（申し送りフォームの勤務帯自動初期値と同じ考え方）。
 * 10時台までは朝・15時前は昼・それ以降は夕。選択中の枠は画面上に✓付きで見えるので、
 * 違えばワンタップで切り替えられる。
 */
function slotForHour(hour: number): MealSlot {
  if (hour < 11) return 'breakfast'
  if (hour < 15) return 'lunch'
  return 'dinner'
}

/**
 * 任意量入力（水分 ml）の正規化。全角数字も受け、1〜FLUID_MAX_ML の整数だけ通す。
 * 解釈できない値・範囲外は null（＝保存経路へ渡さない）。
 */
function parseFluidMl(raw: string): number | null {
  const s = toHalfWidth(raw)
  if (!/^\d{1,4}$/.test(s)) return null
  const n = Number(s)
  return n >= 1 && n <= FLUID_MAX_ML ? n : null
}

/** 1名分の水分合計（ml・サーバーで観測できた分だけ）。控えの消し込み判定に使う */
function serverFluidMl(rows: FluidIntake[], residentId: number): number {
  let sum = 0
  for (const f of rows) {
    if (f.resident_id === residentId && Number.isFinite(f.amount_ml)) sum += f.amount_ml
  }
  return sum
}

/**
 * 新しい水分の記録に入れる時刻（食事一覧・日報・申し送りと同じ規則＝F18・F34。規則は nextMorning.ts）。
 * ・表示中の日が今日: 今の時刻
 * ・前日の列に、夜勤明け（9時）より前に書いた: 今の時刻（2026-10-10 本人裁定。帰属は暦の日付のまま、画面では
 *   「翌」を付けてその日の夜の記録の後ろに並べる）
 * ・それ以外の過去日（前日の列に9時以降に書いた等）: 空（日付は昨日・時刻は今朝、という記録を作らない）
 */
export function takenAtFor(day: string): string | null {
  return recordTimeFor(day)
}

/** 選んでいた階を読む（UI状態だけ。壊れた値・未知の形は null＝既定へ。一覧にあるかの照合は画面側で行う） */
export function readMealsFloor(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const v = localStorage.getItem(MEALS_FLOOR_KEY)
    return v && /^[0-9a-z]{1,8}$/.test(v) ? v : null
  } catch {
    return null
  }
}

export function writeMealsFloor(v: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(MEALS_FLOOR_KEY, v)
  } catch {
    // 保存できなくても表示は成立する（次回起動時に既定へ戻るだけ）
  }
}

/**
 * 変更通知が表示中の日に関わるか。行が無い・日付を取り出せない（削除・つながり直し・復帰の RESYNC＝F14）・
 * 外出・外泊は「分からない」＝取り直す側へ倒す
 */
export function touchesDay(table: string, info: ChangeInfo | undefined, day: string): boolean {
  const col = WATCHED_DAY_COL[table]
  if (col === undefined) return false
  if (col === null) return true
  const raw = info?.row?.[col]
  if (typeof raw !== 'string' || raw === '') return true
  return raw.slice(0, 10) === day
}

/**
 * 日付をまたいだ時の動き（F18。バイタル一括と同じ規則）。表示中の日が今日なら何もしない。切り替えて失うもの・取り違える
 * もの（未保存・競合・未送信の食事と水分・保存中）が無ければ切り替え、あれば帯で知らせる（入力は止めない）
 */
export function dayRollover(shownDay: string, today: string, quiet: boolean): 'none' | 'switch' | 'notice' {
  if (shownDay === today) return 'none'
  return quiet ? 'switch' : 'notice'
}

function mealKey(residentId: number, slot: MealSlot): string {
  return `${residentId}:${slot}`
}

/**
 * 上書きされる列の「元の値」だけを取り出す（既にサーバーで観測できている値が対象）。
 * 新規入力（未入力→値）は取り消す対象にしない。ui-design §6「既存値の上書き＝保存トーストに Undo」。
 */
function overwrittenFrom(existing: Meal | null, patch: MealPatch): MealPatch {
  const out: MealPatch = {}
  if (!existing) return out
  if (
    patch.main_amount !== undefined &&
    existing.main_amount != null &&
    existing.main_amount !== patch.main_amount
  ) {
    out.main_amount = existing.main_amount
  }
  if (
    patch.side_amount !== undefined &&
    existing.side_amount != null &&
    existing.side_amount !== patch.side_amount
  ) {
    out.side_amount = existing.side_amount
  }
  if (patch.status !== undefined && existing.status != null && existing.status !== patch.status) {
    out.status = existing.status
  }
  return out
}

/** 「主食を 3 から 8 に変更しました。」（値は数値か状態ラベル。氏名は入れない） */
function overwriteText(before: MealPatch, after: MealPatch): string {
  const parts: string[] = []
  if (before.main_amount != null && after.main_amount != null) {
    parts.push(`主食を ${before.main_amount} から ${after.main_amount} に`)
  }
  if (before.side_amount != null && after.side_amount != null) {
    parts.push(`副食を ${before.side_amount} から ${after.side_amount} に`)
  }
  if (before.status != null && after.status != null) {
    parts.push(
      `食事の状態を「${MEAL_STATUS_LABEL[before.status]}」から「${MEAL_STATUS_LABEL[after.status]}」に`,
    )
  }
  return `${parts.join('・')}変更しました。`
}

/** その日に有効な外出・外泊（開始日 ≤ 当日 ≤ 帰着日。帰着未定は継続中とみなす） */
function outingOnDay(outings: Outing[], residentId: number, day: string): Outing | null {
  for (const o of outings) {
    if (!o || o.resident_id !== residentId) continue
    if (typeof o.start_on !== 'string' || o.start_on > day) continue
    if (o.end_on != null && o.end_on < day) continue
    return o
  }
  return null
}

// ── 行の保存状態（色だけでなく記号＋文字で示す） ────────────────

type RowPhase = 'idle' | 'saving' | 'saved' | 'queued' | 'conflict' | 'error'
/** 1食の値（競合の判定に使う3列。空は null） */
type MealCells = Record<MealField, unknown>

/** 1食の3列を取り出す（行が無ければ全部 空） */
function mealCells(m: Meal | null | undefined): MealCells {
  return {
    main_amount: m?.main_amount ?? null,
    side_amount: m?.side_amount ?? null,
    status: m?.status ?? null,
  }
}
type MealPatch = Partial<Pick<Meal, 'main_amount' | 'side_amount' | 'status'>>

const PHASE_VIEW: Record<Exclude<RowPhase, 'idle'>, { mark: string; label: string; cls: string }> =
  {
    saving: { mark: '↻', label: '保存中', cls: 'text-ink2' },
    saved: { mark: '✓', label: '保存済み', cls: 'text-ok' },
    queued: { mark: '⚠', label: '未送信', cls: 'text-warn' },
    conflict: { mark: '▲', label: '要再読込', cls: 'text-warn' },
    error: { mark: '▲', label: '未保存', cls: 'text-danger' },
  }

function PhaseBadge({ phase }: { phase: RowPhase }) {
  if (phase === 'idle') return null
  const v = PHASE_VIEW[phase]
  return (
    <span className={`shrink-0 text-sm ${v.cls}`}>
      <span aria-hidden="true">{v.mark} </span>
      {v.label}
    </span>
  )
}

/** 要約の行で欄を言う言葉（他の端末が入力中の欄。Presence） */
const MEAL_FIELD_WORD: Record<string, string> = {
  main_amount: '主食',
  side_amount: '副食',
  status: '状態',
  note: 'メモ',
}

// ── 摂取量（0〜10）の11セグメント ─────────────────────────────

interface AmountRowProps {
  label: string
  groupLabel: string
  value: number | null
  onPick: (value: number) => void
  /** 他の端末がこの欄を入力中（Presence）。枠と「職員B 入力中」を出す */
  busy?: BusyText | null
  /** 読み上げ文の id（aria-describedby） */
  busyId?: string
  /** この欄に入った・離れた・押しただけ（Presence へ伝える） */
  presence?: PresenceHandlers
}

/** まとまり（主食・副食・状態）に入った／離れたを Presence へ伝える受け口 */
interface PresenceHandlers {
  onFocus: () => void
  onClick: () => void
  onBlur: (e: ReactFocusEvent<HTMLElement>) => void
}

/**
 * 44×44 のボタン11個。選択中は「色＋太字」だけに頼らず、
 * ラベル横に選択値を文字で出す（未選択は「未入力」）＋ aria-pressed を付ける。
 */
function AmountRow({ label, groupLabel, value, onPick, busy = null, busyId, presence }: AmountRowProps) {
  return (
    // relative: 他の端末が入力中の「✎」をまとまりの角に置く（高さ・位置を変えない）
    <div className={`relative mt-3 ${busy ? BUSY_RING_OUTSIDE : ''}`} {...presence}>
      {busy && busyId ? <BusyMark busy={busy} id={busyId} corner="right" /> : null}
      <div className="flex items-baseline gap-gap">
        <span className="text-sm text-ink2">{label}</span>
        <span className="tabular text-base font-bold text-ink">
          {value == null ? '未入力' : value}
        </span>
      </div>
      <div
        role="group"
        aria-label={groupLabel}
        aria-describedby={busy ? busyId : undefined}
        className="mt-1 flex flex-wrap gap-gap"
      >
        {AMOUNTS.map((n) => {
          const on = value === n
          return (
            <button
              key={n}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(n)}
              className={
                on
                  ? 'tabular min-h-tap min-w-tap rounded border border-primary bg-primary text-base font-bold text-primary-ink disabled:opacity-60'
                  : 'tabular min-h-tap min-w-tap rounded border border-border bg-surface text-base text-ink disabled:opacity-60'
              }
            >
              {n}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── 利用者1名分の行 ──────────────────────────────────────────

interface MealRowProps {
  resident: Resident
  main: number | null
  side: number | null
  status: MealStatus | null
  phase: RowPhase
  /** 保存できなかった理由（db.ts の日本語メッセージ。無ければ既定文を出す） */
  message: string | null
  /** 当日の水分合計（サーバーに載っている分） */
  fluidMl: number
  /** 当日の水分の記録回数（サーバーに載っている分） */
  fluidCount: number
  /** 未送信のまま端末に退避している水分（合計 ml。0 なら表示しない） */
  queuedMl: number
  /**
   * 送信待ちにしたが端末に控えを残せなかった水分（合計 ml・F01。このタブのメモリにだけある）。0 なら表示しない。
   * 閉じると消えるので、送信待ちの概算（queuedMl）とは分けて危険の色で出す
   */
  lostMl: number
  /** 当日の外出・外泊があれば表示する参考ラベル（食事の状態には自動反映しない） */
  outingLabel: string | null
  canUndoFluid: boolean
  onAmount: (residentId: number, field: 'main_amount' | 'side_amount', value: number, shown: number | null) => void
  onStatus: (residentId: number, value: MealStatus, shown: MealStatus | null) => void
  onFluid: (residentId: number, ml: number) => void
  onUndoFluid: (residentId: number) => void
  onReload: () => void
  /** 競合中の行を「くらべて選ぶ」画面で開く */
  onCompare: (residentId: number) => void
  /** 止まっている行の「先の値／あなたの入力」（止まっている間もサーバーの最新値を見せる） */
  heldText: string
  /** 相手の行が他の端末で取り消されていた（〔新しい行として保存〕〔取り下げる〕を出す） */
  missing: boolean
  onSaveNew: (residentId: number) => void
  onDrop: (residentId: number) => void
  /** 他の端末が入力中の欄（Presence）。無ければ null */
  busyMain: BusyText | null
  busySide: BusyText | null
  busyStatus: BusyText | null
  /** 行見出しの「入力中: 職員B」。無ければ null */
  rowBusy: string | null
  /** この端末がまとまりに入った（'focus'）・離れた（'blur'）・押しただけ（'touch'）を Presence へ伝える */
  onPresence: (residentId: number, field: 'main_amount' | 'side_amount' | 'status') => LeaveCell | null
}

const MealRow = memo(function MealRow({
  resident,
  main,
  side,
  status,
  phase,
  message,
  fluidMl,
  fluidCount,
  queuedMl,
  lostMl,
  outingLabel,
  canUndoFluid,
  onAmount,
  onStatus,
  onFluid,
  onUndoFluid,
  onReload,
  onCompare,
  heldText,
  missing,
  onSaveNew,
  onDrop,
  busyMain,
  busySide,
  busyStatus,
  rowBusy,
  onPresence,
}: MealRowProps) {
  // 加算チップに無い量（80ml・500ml など）を1回で記録するための任意量入力（ui-design §6）
  const [extra, setExtra] = useState('')
  const [extraError, setExtraError] = useState(false)
  const uid = useId()
  const extraId = `${uid}-fluid`
  const extraErrId = `${uid}-fluid-err`

  /**
   * まとまりに入った／離れたを Presence へ伝える受け口。
   * - 配るのは押す操作が確定した時（click）とフォーカスした時。触れただけ（スクロールを始めた指）では配らない
   * - 押すたび・フォーカスするたびに「最後の操作から PRESENCE_TOUCH_HOLD_MS」の取り消しを延ばす
   *   （タッチ端末ではボタンに触れた後 blur が起きないことがあるため）
   * - まとまりの外へフォーカスが移ったら（blur）早めに取り消す。どちらか早い方
   */
  const leaveRef = useRef<LeaveCell | null>(null)
  const handlers = (field: 'main_amount' | 'side_amount' | 'status'): PresenceHandlers => {
    const touch = () => {
      leaveRef.current = onPresence(resident.id, field)
    }
    return {
      onFocus: touch,
      onClick: touch,
      onBlur: (e) => {
        const to = e.relatedTarget
        if (to instanceof Node && e.currentTarget.contains(to)) return
        leaveRef.current?.()
        leaveRef.current = null
      },
    }
  }

  const addExtra = () => {
    const ml = parseFluidMl(extra)
    if (ml == null) {
      setExtraError(true)
      return
    }
    setExtraError(false)
    setExtra('')
    onFluid(resident.id, ml)
  }

  return (
    <li className="rounded-md border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-gap">
        <span className="tabular w-14 shrink-0 text-sm text-ink3">{resident.room ?? '—'}</span>
        {/* 食い違いを解決した後のフォーカスの戻り先（タブ順には入れない） */}
        <span
          id={`mg-name-${resident.id}`}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate text-base font-bold text-ink"
        >
          {resident.name}
          {/* 他の端末がこの方の食事を入力中（「✎」・読み上げは「入力中: 職員B」） */}
          {rowBusy !== null ? <RowBusyMark text={rowBusy} /> : null}
        </span>
        {outingLabel ? (
          <Chip tone="info">
            <span aria-hidden="true">ⓘ </span>
            {outingLabel}（参考）
            <span className="sr-only">
              。外出・外泊の記録です。食事の状態には自動で反映されません
            </span>
          </Chip>
        ) : null}
        <PhaseBadge phase={phase} />
      </div>

      <AmountRow
        label="主食"
        groupLabel={`${resident.name} の主食の量（0〜10）`}
        value={main}
        onPick={(v) => onAmount(resident.id, 'main_amount', v, main)}
        busy={busyMain}
        busyId={`${uid}-busy-main`}
        presence={handlers('main_amount')}
      />
      <AmountRow
        label="副食"
        groupLabel={`${resident.name} の副食の量（0〜10）`}
        value={side}
        onPick={(v) => onAmount(resident.id, 'side_amount', v, side)}
        busy={busySide}
        busyId={`${uid}-busy-side`}
        presence={handlers('side_amount')}
      />

      <div
        className={`relative mt-3 ${busyStatus ? BUSY_RING_OUTSIDE : ''}`}
        {...handlers('status')}
        // 状態の選択肢（SegmentPicker・ui.tsx は変更しない）に説明を付けられないので、
        // 他の端末が入力中の間だけこのまとまりを group にして読み上げの説明を付ける
        role={busyStatus ? 'group' : undefined}
        aria-label={busyStatus ? '食事の状態' : undefined}
        aria-describedby={busyStatus ? `${uid}-busy-status` : undefined}
      >
        {busyStatus ? <BusyMark busy={busyStatus} id={`${uid}-busy-status`} corner="right" /> : null}
        <span className="text-sm text-ink2">食事の状態</span>
        <div className="mt-1">
          <SegmentPicker
            options={STATUS_OPTIONS}
            value={status ?? ''}
            onChange={(v) => onStatus(resident.id, v as MealStatus, status)}
            ariaLabel={`${resident.name} の食事の状態`}
          />
        </div>
      </div>

      <div className="mt-3 border-t border-border pt-3">
        <div className="flex flex-wrap items-baseline gap-gap">
          <span className="text-sm text-ink2">水分（この日の合計）</span>
          <span className="tabular text-base font-bold text-ink">
            {fluidMl}
            <span className="text-sm font-normal text-ink2">ml</span>
          </span>
          <span className="tabular text-sm text-ink3">{fluidCount}回</span>
          {queuedMl > 0 ? (
            <span className="tabular text-sm text-warn">
              <span aria-hidden="true">⚠ </span>
              未送信 {queuedMl}ml
            </span>
          ) : null}
        </div>
        {lostMl > 0 ? (
          // 送信待ちにしたが端末に控えを残せなかった水分（F01）。トーストだけで終わらせず、送れるまで行に残す
          <p role="alert" className="mt-1 text-sm text-danger">
            <span aria-hidden="true">▲ </span>
            水分 ＋{lostMl}ml：{MSG_NOT_PERSISTED}
          </p>
        ) : null}
        <div className="mt-1 flex flex-wrap gap-gap">
          {FLUID_STEPS.map((ml) => (
            <button
              key={ml}
              type="button"
              aria-label={`${resident.name} に水分 ${ml}ml を追加`}
              onClick={() => onFluid(resident.id, ml)}
              className="tabular min-h-tap rounded border border-border bg-surface px-3 text-base text-ink disabled:opacity-60"
            >
              ＋{ml}ml
            </button>
          ))}
          {canUndoFluid ? (
            <button
              type="button"
              aria-label={`${resident.name} の直前に追加した水分を取り消す`}
              onClick={() => onUndoFluid(resident.id)}
              className="min-h-tap rounded border border-danger px-3 text-base font-bold text-danger disabled:opacity-60"
            >
              直前の追加を取り消す
            </button>
          ) : null}
        </div>

        {/* チップに無い量を入れる欄（1〜2000ml）。追加は加算チップと同じ保存経路を通す */}
        <div className="mt-1 flex flex-wrap items-end gap-gap">
          <div>
            <label htmlFor={extraId} className="block text-sm text-ink2">
              その他の量（ml）
              <span className="sr-only">。{resident.name} に追加する水分の量です</span>
            </label>
            <input
              id={extraId}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={extra}
              onChange={(e) => {
                setExtra(e.target.value)
                if (extraError) setExtraError(false)
              }}
              aria-invalid={extraError}
              aria-describedby={extraError ? extraErrId : undefined}
              className="tabular mt-1 min-h-tap w-24 rounded border border-border bg-surface px-3 text-base text-ink disabled:opacity-60"
            />
          </div>
          <button
            type="button"
            aria-label={`${resident.name} に入力した量の水分を追加`}
            onClick={addExtra}
            className="min-h-tap rounded border border-border bg-surface px-3 text-base text-ink disabled:opacity-60"
          >
            ＋追加
          </button>
        </div>
        {extraError ? (
          <p id={extraErrId} role="alert" className="mt-1 text-sm text-danger">
            <span aria-hidden="true">▲ </span>
            水分の量を 1〜{FLUID_MAX_ML} の数字で入力してから「＋追加」を押してください。
          </p>
        ) : null}
      </div>

      {phase === 'conflict' || phase === 'error' || phase === 'queued' ? (
        <div
          role={phase === 'queued' ? 'status' : 'alert'}
          className={
            phase === 'error'
              ? 'mt-3 rounded border border-danger bg-danger-bg p-3'
              : 'mt-3 rounded border border-warn bg-warn-bg p-3'
          }
        >
          <p className="text-base text-ink">
            <span aria-hidden="true">{phase === 'queued' ? '⚠ ' : '▲ '}</span>
            {phase === 'conflict' ? (message ?? ERR_CONFLICT) : (message ?? ERR_SAVE)}
          </p>
          {heldText !== '' && phase !== 'queued' ? (
            <p className="mt-1 text-base text-ink">{heldText}</p>
          ) : null}
          {phase === 'conflict' && missing ? (
            // 相手の行が取り消されていた: 新しい行として保存するか、取り下げる（日報の「行が無い控え」と同じ）
            <div className="mt-2 flex flex-wrap gap-gap">
              <button
                type="button"
                onClick={() => onSaveNew(resident.id)}
                aria-label={`${resident.name} のまだ保存していない入力を新しい行として保存する`}
                className="min-h-tap rounded border border-primary px-4 text-base font-bold text-primary"
              >
                新しい行として保存
              </button>
              <button
                type="button"
                onClick={() => onDrop(resident.id)}
                aria-label={`${resident.name} のまだ保存していない入力を取り下げる`}
                className="min-h-tap rounded border border-border-strong px-4 text-base text-ink"
              >
                取り下げる
              </button>
            </div>
          ) : phase === 'conflict' ? (
            <div className="mt-2 flex flex-wrap gap-gap">
              <button
                type="button"
                onClick={onReload}
                className="min-h-tap rounded border border-primary px-4 text-base font-bold text-primary"
              >
                最新を読み込む
              </button>
              {/* 食い違いを並べて、どちらを残すか選ぶ（既存の「最新を読み込む」はそのまま残す） */}
              <button
                type="button"
                onClick={() => onCompare(resident.id)}
                aria-label={`${resident.name} の食い違いをくらべて選ぶ`}
                className="min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary"
              >
                くらべて選ぶ
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
})

// ── 画面本体 ─────────────────────────────────────────────────

export interface MealsGridPageProps {
  /** App.tsx が保持していれば渡す（未指定ならこの画面が fetchResidents で取得する） */
  residents?: Resident[]
  /** 操作者（記入者）の staff_id。未指定なら actor.ts の保持値を使う */
  actorId?: number | null
  /** 入力解禁フラグの初期値。渡されても記録画面を開くたびに取り直す（ui-design §0.5） */
  inputEnabled?: boolean
}

export function MealsGridPage({
  residents: residentsProp,
  actorId: actorIdProp,
  inputEnabled: inputEnabledProp,
}: MealsGridPageProps = {}) {
  // 対象日はこの画面を開いた日（当日）。日付を選ぶ UI は設けない。開いたまま日付をまたいだら、入力中・未送信が
  // 無ければ今日へ切り替え、残っていれば帯で知らせて〔今日にする〕を出す（F18・2026-10-10 本人回答）
  const [day, setDay] = useState(() => todayIso())
  /** いまの日付（端末の時計）。表示中の日と食い違ったら帯を出す（1分ごと・画面に戻った時に見直す） */
  const [nowDay, setNowDay] = useState(() => todayIso())
  /** 〔今日にする〕で、まだ保存していない入力が消える時の確認 */
  const [dayAsk, setDayAsk] = useState(false)
  /** 日を切り替えて、新しい日の記録を読み終えるまで（前の日の値を新しい日の値として押させない） */
  const [daySwitching, setDaySwitching] = useState(false)
  const [slot, setSlot] = useState<MealSlot>(() => slotForHour(new Date().getHours()))
  // フロアは一覧から作る（居室未設定の利用者も FLOOR_OTHER で必ず表示できるようにする）。
  // 選んだ階は UI 状態として保存し、復元した値が一覧に無ければ下の effect で先頭へ倒す（F68）
  const [floor, setFloor] = useState<string>(() => readMealsFloor() ?? '1')

  const [residents, setResidents] = useState<Resident[]>(() => asArray<Resident>(residentsProp))
  const [meals, setMeals] = useState<Record<string, Meal>>({})
  const [fluids, setFluids] = useState<FluidIntake[]>([])
  const [outings, setOutings] = useState<Outing[]>([])
  /** 保存前・保存中・未送信の値（サーバー観測値に優先して表示する。入力を消さないための控え） */
  const [pending, setPending] = useState<Record<string, MealPatch>>({})
  const [phases, setPhases] = useState<Record<string, RowPhase>>({})
  /** 保存できなかった行の理由文（db.ts の DbError メッセージをそのまま出す） */
  const [rowMsgs, setRowMsgs] = useState<Record<string, string>>({})
  /** 取り消せる直前の水分（このセッションで追加し、サーバー行を観測できたものだけ） */
  const [undoFluids, setUndoFluids] = useState<Record<number, { id: number; rev: number; ml: number }>>(
    {},
  )
  /**
   * 未送信のまま退避した水分（表示合計に反映するための概算。取り消しはできない）。
   * base = 退避した時点でサーバーに観測できていた合計。取り直した合計との差で「載った分」を
   * 1名ずつ消し込む（キュー全体の件数では判定しない＝観測ベース・multi-device-sync 原則6）。
   */
  const [queuedFluids, setQueuedFluids] = useState<Record<number, { base: number; ml: number }>>({})
  /**
   * 送信待ちにしたが端末に控えを残せなかった水分（F01）。queuedFluids と同じ形・同じ消し込み（取り直した合計との差）
   * だが、閉じると消えるので別に持ち、危険の色で出す（送信待ちの概算として案内しない）
   */
  const [lostFluids, setLostFluids] = useState<Record<number, { base: number; ml: number }>>({})
  /** くらべて選ぶ画面に渡す内容（開いた時点で固定する） */
  const [compare, setCompare] = useState<{
    key: string
    target: ConflictTarget
    name: string
    base: Record<string, unknown>
    mine: Record<string, unknown>
  } | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 入力解禁フラグは「確認できるまで false（封鎖側）」。安全側に倒す
  const [inputEnabled, setInputEnabled] = useState<boolean>(inputEnabledProp === true)
  const [flagChecked, setFlagChecked] = useState(false)
  const [flagError, setFlagError] = useState<string | null>(null)
  /**
   * このアカウントは記録アプリを使えない（許可リストに無い・無効。F61 手直し）。flagError に FORBIDDEN_REASON を入れ、
   * 再試行のボタンは出さない（何度押しても直らない。ログインし直す・管理者へ連絡する）
   */
  const [forbidden, setForbidden] = useState(false)
  /** サーバーに欄ごとの保存の仕組み（0011）がまだ無い＝サーバー側の更新待ち（入力を止める） */
  const [cellsMissing, setCellsMissing] = useState(false)

  const { toast, show } = useToast()

  const actorId = actorIdProp !== undefined ? actorIdProp : getActorId()
  // 他の端末が今まさに入力している欄（Presence・表示だけ。保存は妨げない）。
  // この画面は、主食・副食・状態のまとまりに入っている間だけ配る
  const presence = useCellPresence({ actorId: actorId ?? null })
  /**
   * ★記録者（操作者）の選択は入力の条件にしない（2026-09-05 指示）。
   *   1台の端末を複数人が使うため、端末に1人を紐づける前提が実務に合わない。
   *   recorded_by は NULL 可の列で、未設定なら「誰が入れたか記録しない」だけになる。
   */
  const canInput = inputEnabled && flagChecked && !cellsMissing && !daySwitching

  // 保存処理から読む最新値（setState の反映を待たずに直列処理で使う）
  const aliveRef = useRef(true)
  const genRef = useRef(0)
  const chainRef = useRef(new Map<string, Promise<void>>())
  const mealsRef = useRef<Record<string, Meal>>({})
  const pendingRef = useRef<Record<string, MealPatch>>({})
  const fluidsRef = useRef<FluidIntake[]>([])
  const undoRef = useRef<Record<number, { id: number; rev: number; ml: number }>>({})
  const phasesRef = useRef<Record<string, RowPhase>>({})
  const msgsRef = useRef<Record<string, string>>({})
  /** 競合した時に見ていたサーバーの値（キー → 3列）。読み直した後も持ち続けて食い違いを見分ける */
  /**
   * 利用者の編集（キー → 欄ごとの値と、押した時に画面に出ていた値＝基準）。構造規約 R-E〜R-G の
   * 共通の仕組み（src/lib/rowSync.ts）で扱う。画面の控え（pending）はこの値を映したもの
   */
  const editsRef = useRef<Record<string, Edits<MealField>>>({})
  /**
   * 送信待ちにした値（キー → 欄）。送信が済んだと読み込みで観測できるまで表示に重ね、その欄をさらに直す時の
   * 基準にする（指摘 M1。消すと、送信待ちの値が表示から消え、後の入力が自分の値と食い違う扱いになる）
   */
  const queuedRef = useRef<Record<string, MealPatch>>({})
  /** 相手の行が他の端末で取り消されていた行（〔新しい行として保存〕〔取り下げる〕を出す） */
  const missingRef = useRef<Record<string, true>>({})
  /**
   * 送信待ちにしたが端末に控えを残せなかった行（F01。このタブのメモリにだけある）。入力（edits）は残したまま
   * 「未保存」として出し、送信待ちが送れた・止まった後の読み込みで外す
   */
  const unpersistedRef = useRef<Record<string, true>>({})
  /** 未送信の水分（queuedFluids・lostFluids）の同期の控え（日の切替の判断に使う） */
  const fluidsHeldRef = useRef({ queued: 0, lost: 0 })
  /** 自分の書き込みで出た変更通知・取得の割り込みを見分ける印（保存の前後に進める。食事一覧と同じ作法） */
  const selfWriteRef = useRef(0)
  /** 順番待ちで動いている・待っている仕事の数（保存・水分・くらべて選ぶ。背景の取り直しと日の切替を後回しにする） */
  const jobsRef = useRef(0)
  /** 背景の取り直しを頼む（購読 effect の schedule を入れる。購読が無い時は null） */
  const retryRef = useRef<(() => void) | null>(null)
  /**
   * サーバーの値が古いかもしれない行（保存が競合したのに最新を取り直せなかった）。
   * この間は「先の値」を出さない（古い値を先の値として見せない＝指摘 U1c）。次の読み込みで外す
   */
  const staleRef = useRef<Record<string, true>>({})
  // 親が毎レンダー新しい配列を渡しても取得が繰り返されないよう、取得処理からは ref 経由で読む
  const residentsPropRef = useRef<Resident[] | undefined>(residentsProp)
  const slotRef = useRef<MealSlot>(slot)
  const dayRef = useRef(day)
  const actorRef = useRef<number | null>(actorId)
  const canInputRef = useRef(canInput)
  const showRef = useRef(show)
  const saveMealRef = useRef<
    (residentId: number, patch: MealPatch, slotAt: MealSlot, isUndo?: boolean, shownAt?: Partial<MealCells>) => void
  >(() => undefined)

  useEffect(() => {
    slotRef.current = slot
    dayRef.current = day
    actorRef.current = actorId
    canInputRef.current = canInput
    showRef.current = show
    residentsPropRef.current = residentsProp
    fluidsHeldRef.current = { queued: Object.keys(queuedFluids).length, lost: Object.keys(lostFluids).length }
  })

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const commitMeals = useCallback((next: Record<string, Meal>) => {
    mealsRef.current = next
    setMeals(next)
  }, [])
  const commitPending = useCallback((next: Record<string, MealPatch>) => {
    pendingRef.current = next
    setPending(next)
  }, [])
  /**
   * 画面に重ねる控え（pending）を作り直す（edits が正本。pending はその映し）。
   * 送信待ちにした値（queuedRef）も、送信が済むまで下に重ねる（指摘 M1）
   */
  const syncPendingAll = useCallback(() => {
    const next: Record<string, MealPatch> = {}
    for (const [k, q] of Object.entries(queuedRef.current)) next[k] = { ...q }
    for (const [k, e] of Object.entries(editsRef.current)) {
      if (hasEdits(e)) next[k] = { ...(next[k] ?? {}), ...(editValues(e) as MealPatch) }
    }
    commitPending(next)
  }, [commitPending])
  /** 1行の edits を書き換え、控えを映し直す（空になった行は控えから外す） */
  const writeEdits = useCallback(
    (key: string, edits: Edits<MealField>) => {
      if (hasEdits(edits)) editsRef.current[key] = edits
      else delete editsRef.current[key]
      syncPendingAll()
    },
    [syncPendingAll],
  )
  const commitFluids = useCallback((next: FluidIntake[]) => {
    fluidsRef.current = next
    setFluids(next)
  }, [])
  const commitUndo = useCallback((next: Record<number, { id: number; rev: number; ml: number }>) => {
    undoRef.current = next
    setUndoFluids(next)
  }, [])

  /** 行の状態と理由文をまとめて更新する（保存処理からは ref 側を読む） */
  const setPhase = useCallback((key: string, phase: RowPhase, message?: string) => {
    const nextPhases = { ...phasesRef.current, [key]: phase }
    phasesRef.current = nextPhases
    setPhases(nextPhases)
    const nextMsgs = { ...msgsRef.current }
    if (message === undefined) delete nextMsgs[key]
    else nextMsgs[key] = message
    msgsRef.current = nextMsgs
    setRowMsgs(nextMsgs)
  }, [])

  /**
   * 同じ行への保存が交差しないよう、キーごとに直列化する（rev の追い越しを防ぐ）。
   * 積んだ時から終わるまで数え、その間は背景の取り直しと日の切替を後回しにする（F17・F18）
   */
  const enqueue = useCallback((key: string, job: () => Promise<void>) => {
    jobsRef.current += 1
    const prev = chainRef.current.get(key) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined)
      .then(job)
      .catch(() => undefined)
      .finally(() => {
        jobsRef.current -= 1
      })
    chainRef.current.set(key, next)
  }, [])

  // ── 入力解禁フラグ（この画面を開くたびに取り直す） ──
  // 「false を観測した（＝スプシ期間）」と「観測できなかった（＝通信エラー）」は別物として扱う。
  // 後者は封鎖の理由文ではなく、再試行できるエラー表示にする。
  const loadFlag = useCallback(async () => {
    setFlagError(null)
    try {
      const gate = await getNativeInputGate()
      if (!aliveRef.current) return
      setInputEnabled(gate.value === true)
      setFlagChecked(gate.observed)
      setCellsMissing(gate.cells === 'missing')
      setForbidden(gate.forbidden === true)
      if (gate.forbidden === true) {
        setFlagError(FORBIDDEN_REASON)
        return
      }
      // 取得できない間は入力させない（封鎖側に倒す）
      if (!gate.observed) setFlagError(ERR_FLAG)
    } catch {
      if (!aliveRef.current) return
      setInputEnabled(false)
      setFlagChecked(false)
      setForbidden(false)
      setFlagError(ERR_FLAG)
    }
  }, [])

  useEffect(() => {
    void loadFlag()
  }, [loadFlag])

  /**
   * 送信待ち（db.ts の pending store）を当日の行へ重ねる（食事一覧の adoptStoreMeals と同じ裁き）。
   * 送る状態の値は「送信待ち」の重ね表示として返し、止まっている行は「あなたの入力」として取り込んで競合・未保存を
   * 出し直す（もう同じ値が載っていれば送信待ちから外す）。相手の行が取り消されていたら「行が無い控え」にする。
   * 拒否された行は値を取り込む。phases・msgs は書き換える
   */
  const adoptStoreMeals = useCallback(
    (
      nextMeals: Record<string, Meal>,
      phases: Record<string, RowPhase>,
      msgs: Record<string, string>,
      residentIds: number[],
    ): Record<string, MealPatch> => {
      const queued: Record<string, MealPatch> = {}
      const day = dayRef.current
      for (const rid of residentIds) {
        for (const slotAt of SLOTS) {
          const k = mealKey(rid, slotAt)
          if (phasesRef.current[k] === 'saving') continue
          const target = { residentId: rid, day, slot: slotAt }
          const p = pendingRow('meals', target)
          if (p === null) continue
          if (p.state === 'pending') {
            const vals: MealPatch = {}
            for (const f of MEAL_FIELDS) if (f in p.values) (vals as Record<string, unknown>)[f] = p.values[f]
            if (Object.keys(vals).length > 0) queued[k] = vals
            continue
          }
          const edits = adoptPending(editsRef.current[k] ?? {}, p)
          if (p.state === 'rejected') {
            editsRef.current[k] = edits
            phases[k] = 'error'
            msgs[k] = ERR_REJECTED
            continue
          }
          const fresh = nextMeals[k]
          if (!fresh && p.conflicts.length > 0 && p.conflicts.every((c) => c.reason === 'missing')) {
            editsRef.current[k] = edits
            missingRef.current[k] = true
            phases[k] = 'conflict'
            msgs[k] = missingRowText(describeMealEdits(edits))
            continue
          }
          const judged = judgeFields(MEAL_FIELDS, p)
          const r = reconcileOnLoad(judged, edits as Edits<string>, fresh ? mealJudgeCells(fresh) : null)
          if (r.status === 'clean') {
            // もう同じ値がサーバーに載っている（止まっていた分は届いたのと同じ）。突き合わせた欄の見た版だけ外す
            void discardPendingRow('meals', target, judged, p.vers)
            delete editsRef.current[k]
            continue
          }
          editsRef.current[k] = r.edits as Edits<MealField>
          phases[k] = r.status === 'conflict' ? 'conflict' : 'error'
          msgs[k] = r.status === 'conflict' ? ERR_CONFLICT_STILL : MSG_UNSAVED_AFTER_RELOAD
        }
      }
      return queued
    },
    [],
  )

  // ── 当日分の取得（利用者・食事・水分・外出） ──
  const load = useCallback(async (opts?: { background?: boolean }) => {
    const gen = ++genRef.current
    // 保存が割り込んだかどうかを見分けるための開始時刻（selfWriteRef は保存のたびに進む）
    const startedAt = Date.now()
    // 背景の取り直し（他端末の変更・復帰を受けた自動更新＝F17）では「読み込み中」にしない。
    // 〔元に戻す〕（直前の水分の取り消し）も、取り直した一覧に行が残っている分は持ち越す
    const background = opts?.background === true
    if (!background) setLoading(true)
    setError(null)
    try {
      const fromProps = residentsPropRef.current
      const [rs, chunk] = await Promise.all([
        fromProps ? Promise.resolve(fromProps) : fetchResidents(),
        fetchTimelineChunk(dayRef.current, dayRef.current, actorRef.current),
      ])
      if (gen !== genRef.current || !aliveRef.current) return
      // 取得の途中で自分の保存が入った＝この応答は保存前のサーバー値。背景の取り直しは捨ててやり直す
      if (background && selfWriteRef.current >= startedAt) {
        retryRef.current?.()
        return
      }

      setResidents(asArray<Resident>(rs).filter((r) => r != null && r.active !== false))

      const nextMeals: Record<string, Meal> = {}
      for (const m of asArray<Meal>(chunk?.meals)) {
        if (!m || typeof m.meal_on !== 'string' || m.meal_on !== dayRef.current) continue
        if (!SLOTS.includes(m.meal_slot)) continue
        const k = mealKey(m.resident_id, m.meal_slot)
        // 画面が持っている同じ行より古い応答では置き換えない（指摘 L2・全画面共通の防御）
        const shown = mealsRef.current[k]
        nextMeals[k] = shown && isOlderRow(shown, m) ? shown : m
      }
      commitMeals(nextMeals)
      const nextFluids = asArray<FluidIntake>(chunk?.fluids).filter(
        (f) => f != null && f.taken_on === dayRef.current && typeof f.amount_ml === 'number',
      )
      commitFluids(nextFluids)
      setOutings(asArray<Outing>(chunk?.outings).filter((o) => o != null))

      // 編集が残る行・送信待ち・応答待ちは控えを残す（原則4: 入力を消さない）。
      // 残っている編集は、最新の値と突き合わせて状態を決め直す（構造規約 R-E・共通の裁き reconcileOnLoad）。
      // 基準（押した時の値）は書き換えない。取り消し用の水分は、サーバーの最新を観測し直した時点で対象外にする
      const keepPhases: Record<string, RowPhase> = {}
      const keepMsgs: Record<string, string> = {}
      // 送信待ちの値は db.ts から読み直す（画面が持っていた分ではなく、送信待ちにある分が正）。
      // 止まっている・拒否された行は「あなたの入力」として取り込む（下の突き合わせより先に編集へ載せる）
      const fromStorePhases: Record<string, RowPhase> = {}
      const fromStoreMsgs: Record<string, string> = {}
      missingRef.current = {}
      const pendingNow = adoptStoreMeals(
        nextMeals,
        fromStorePhases,
        fromStoreMsgs,
        asArray<Resident>(rs)
          .filter((r) => r != null && r.active !== false)
          .map((r) => r.id),
      )
      const keys = new Set([...Object.keys(phasesRef.current), ...Object.keys(editsRef.current)])
      for (const k of keys) {
        const p = phasesRef.current[k]
        const edits = editsRef.current[k] ?? {}
        if (p === 'saving') {
          // 保存の応答待ち（食事一覧と同じ。順番待ちが応答の後に計算し直す）
          keepPhases[k] = p
          continue
        }
        const fresh = nextMeals[k]
        delete staleRef.current[k] // 最新を読み込んだ（先の値を出してよい）
        // 端末に控えを残せなかった送信待ち（F01）が送れた・止まった＝印を外して、下の突き合わせで片付ける
        if (unpersistedRef.current[k] === true && pendingNow[k] === undefined) delete unpersistedRef.current[k]
        if (unpersistedRef.current[k] === true) {
          // まだ送れていない。入力と「未保存」をそのまま持ち続ける（「食い違いはありません」に塗り替えない）
          keepPhases[k] = 'error'
          keepMsgs[k] = MSG_NOT_PERSISTED
          continue
        }
        if (fromStorePhases[k] !== undefined) continue // 止まっている・拒否された行（送信待ちから取り込んだ）
        if (p === 'queued' && pendingNow[k] !== undefined) {
          keepPhases[k] = 'queued'
          const msg = msgsRef.current[k]
          if (msg) keepMsgs[k] = msg
          continue
        }
        // 送信待ちでない（送信が済んだ＝送信待ちが解除されない不具合の修正）。送信待ちの後に入れた値が残っていれば下で裁く
        if (!hasEdits(edits)) continue
        // 控えにある全ての欄（メモを含む）で突き合わせる（第3段 #4）
        const r = reconcileOnLoad(judgeFields(MEAL_FIELDS, { values: edits }), edits as Edits<string>, fresh ? mealJudgeCells(fresh) : null)
        editsRef.current[k] = r.edits as Edits<MealField>
        if (r.status === 'conflict') {
          keepPhases[k] = 'conflict'
          keepMsgs[k] = ERR_CONFLICT_STILL
        } else if (r.status === 'unsaved') {
          keepPhases[k] = 'error'
          keepMsgs[k] = MSG_UNSAVED_AFTER_RELOAD
        } else {
          delete editsRef.current[k]
        }
      }
      // 送信待ちの重ね表示を db.ts の値で作り直し、送信待ちの行に「送信待ち」の印を付ける（I5。
      // 競合・未保存・応答待ちの行はそちらを優先）
      queuedRef.current = pendingNow
      for (const k of Object.keys(pendingNow)) {
        if (keepPhases[k] !== undefined) continue
        keepPhases[k] = 'queued'
        keepMsgs[k] = MSG_QUEUED
      }
      // 送信待ちで止まっている・拒否された行を重ねる（送信待ちが正）
      Object.assign(keepPhases, fromStorePhases)
      Object.assign(keepMsgs, fromStoreMsgs)
      phasesRef.current = keepPhases
      setPhases(keepPhases)
      msgsRef.current = keepMsgs
      setRowMsgs(keepMsgs)
      syncPendingAll()
      // Undo（直前の水分追加の取り消し）は利用者が押した読み込み直しでだけ捨てる。背景の取り直し（F17）で消すと、
      // 押し間違えた ＋ml を戻す唯一の手段が黙って消える。取り直した結果に行が残っているものだけ持ち越す（食事一覧と同じ）
      if (background) {
        const aliveRev = new Map(nextFluids.map((f) => [f.id, f.rev]))
        const keptUndo: Record<number, { id: number; rev: number; ml: number }> = {}
        for (const [k, u] of Object.entries(undoRef.current)) {
          const rev = aliveRev.get(u.id)
          // 取り直した rev で持ち越す（古い rev のままだと取り消しが競合で弾かれる）
          if (rev !== undefined) keptUndo[Number(k)] = { ...u, rev }
        }
        commitUndo(keptUndo)
      } else {
        commitUndo({})
      }
      // 退避した水分がサーバーへ載ったかは、取り直した合計で1名ずつ確かめる（観測ベース）。
      // 「キュー全体が空か」で判断すると、無関係の未送信 op が残っている間ずっと概算が消えずに
      // 二重計上になり、逆に別要因でキューが空になった瞬間に未着の分が画面から消える。
      // 端末に控えを残せなかった水分（F01）も同じ消し込み（載ったと観測できた分だけ減らす）
      const settleFluids = (prev: Record<number, { base: number; ml: number }>) => {
        const next: Record<number, { base: number; ml: number }> = {}
        for (const [key, held] of Object.entries(prev)) {
          const rid = Number(key)
          if (!Number.isFinite(rid)) continue
          const now = serverFluidMl(nextFluids, rid)
          // 載ったと観測できた分だけ減らす（まだ載っていない分は消さない）
          const remain = held.ml - (now - held.base)
          if (remain > 0) next[rid] = { base: now, ml: remain }
        }
        return next
      }
      setQueuedFluids(settleFluids)
      setLostFluids(settleFluids)
      setDaySwitching(false)
      setError(null)
    } catch {
      if (gen !== genRef.current || !aliveRef.current) return
      // 取得に失敗しても表示中のデータは消さない（安全側フォールバック）
      setError(ERR_LOAD)
      // 日を切り替えた後に読めなかった時も入力は止めない（電波の無い所でも記録できるように。送信待ちに積まれる）
      setDaySwitching(false)
    } finally {
      if (gen === genRef.current && aliveRef.current) setLoading(false)
    }
  }, [adoptStoreMeals, commitFluids, commitMeals, commitUndo, syncPendingAll])

  useEffect(() => {
    void load()
  }, [load])

  // ── 他端末の変更を自動で取り込む（F17・2026-10-10。食事一覧と同じ形） ──
  // 当日の食事・水分・外出の変更だけを合図にし、連続通知は最後の1回にまとめてから背景で取り直す（入力中・未送信・
  // 競合・応答待ちの控えは load が引き継ぐ）。購読は画面にいる間ずっと1本（日は dayRef から読む）。
  // 購読できない環境（接続未設定・通信不可）では何もしない＝「最新を読み込む」の手動更新で成立する
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const schedule = () => {
      if (stopped) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (stopped || !aliveRef.current) return
        // 保存の応答待ち・順番待ちの仕事（保存・水分・くらべて選ぶ）がある間は取り直さない（応答と取得が交差すると
        // 控えの消し込みが噛み合わず、保存できた値が一瞬もとの値に見える）。終わってから取り直す
        if (jobsRef.current > 0 || Object.values(phasesRef.current).some((p) => p === 'saving')) {
          schedule()
          return
        }
        void loadRef.current({ background: true })
      }, REALTIME_DEBOUNCE_MS)
    }
    retryRef.current = schedule

    let unsub: (() => void) | null = null
    try {
      unsub = subscribeChanges((table, info?: ChangeInfo) => {
        if (stopped || !aliveRef.current) return
        // 自分の保存で出た通知（画面へ反映済み）は取り直さない（行で見分ける）
        if (isSelfWrite(table, info?.row)) return
        // 当日の分だけ。行が分からない通知（削除・つながり直し・復帰・電波の復帰の RESYNC＝F14）は取り直す＝安全側
        if (!touchesDay(table, info, dayRef.current)) return
        schedule()
      })
    } catch {
      unsub = null
    }

    // 送信待ちが減った（裏で送れた・止まった）時も取り直す（F01・F17）。自分の送信の変更通知は isSelfWrite で
    // 捨てられるので、ここで取り直さないと「⚠ 未送信」や、端末に控えを残せなかった入力の「未保存」が、手で読み込み
    // 直すまで残る
    let last = -1
    let unsubQueue: (() => void) | null = null
    try {
      unsubQueue = queueSubscribe((n) => {
        if (stopped || !aliveRef.current) return
        const count = typeof n === 'number' && n >= 0 ? n : 0
        if (last >= 0 && count < last) schedule()
        last = count
      })
    } catch {
      unsubQueue = null
    }
    return () => {
      stopped = true
      retryRef.current = null
      if (timer) clearTimeout(timer)
      for (const off of [unsub, unsubQueue]) {
        if (!off) continue
        try {
          off()
        } catch {
          /* 解除失敗は表示に影響しないため無視する */
        }
      }
    }
  }, [])

  // App 側が利用者一覧を差し替えた場合は表示を合わせる
  useEffect(() => {
    if (!residentsProp) return
    setResidents(asArray<Resident>(residentsProp).filter((r) => r != null && r.active !== false))
  }, [residentsProp])

  /**
   * 保存が、ほかの端末の値と食い違って止まっている行にまとめられた（held＝送っていない）。その行を競合として見せる。
   * 止まっている値を「あなたの入力」として載せる（先の値は、続けて1行だけ取り直して並べる）
   */
  const holdAsHeld = useCallback(
    (residentId: number, slotAt: MealSlot) => {
      const key = mealKey(residentId, slotAt)
      const p = pendingRow('meals', { residentId, day: dayRef.current, slot: slotAt })
      writeEdits(key, p ? adoptPending(editsRef.current[key] ?? {}, p) : (editsRef.current[key] ?? {}))
      staleRef.current[key] = true
      setPhase(key, 'conflict', ERR_BLOCKED_WRITE)
    },
    [setPhase, writeEdits],
  )

  /**
   * 保存が競合になった行だけを取り直し、最新の値で状態と一言（先の値／あなたの入力）を出し直す（指摘 U1c）。
   * 取り直せない時は staleRef を残し、値を出さない固定の文言のまま（古い値を先の値として見せない）
   */
  const refreshAfterConflict = useCallback(
    async (residentId: number, slotAt: MealSlot) => {
      const key = mealKey(residentId, slotAt)
      let latest: Meal | null
      try {
        const got = await fetchLatestMeal(residentId, dayRef.current, slotAt)
        latest = got?.row ?? null
      } catch {
        return
      }
      if (!aliveRef.current || phasesRef.current[key] !== 'conflict') return
      const nextMeals = { ...mealsRef.current }
      if (latest) nextMeals[key] = latest
      else delete nextMeals[key]
      commitMeals(nextMeals)
      delete staleRef.current[key]
      const r = reconcileOnLoad(
        judgeFields(MEAL_FIELDS, { values: editsRef.current[key] ?? {} }),
        (editsRef.current[key] ?? {}) as Edits<string>,
        latest ? mealJudgeCells(latest) : null,
      )
      writeEdits(key, r.edits as Edits<MealField>)
      if (r.status === 'conflict') setPhase(key, 'conflict', ERR_CONFLICT_STILL)
      else if (r.status === 'unsaved') setPhase(key, 'error', MSG_UNSAVED_AFTER_RELOAD)
      else setPhase(key, 'idle')
    },
    [commitMeals, setPhase, writeEdits],
  )

  /**
   * 1行を保存する仕事（構造規約 R-E〜R-F・共通の仕組み。食事一覧の runSave と同じ手順）。
   * 行ごとの順番待ち（enqueue）で動き、動き出した時点の最新の状態から計算し直す。送るのは edits の欄だけ。
   * 成功したら送って成功した欄だけを消す（保存中に押した別の欄を落とさない＝再審 A）
   */
  const runSave = useCallback(
    async (residentId: number, slotAt: MealSlot, isUndo: boolean) => {
      const key = mealKey(residentId, slotAt)
      const phase = phasesRef.current[key]
      if (holdsNormalSave(phase)) {
        setPhase(key, 'conflict', ERR_CONFLICT_HOLD)
        return
      }
      const existing = mealsRef.current[key] ?? null
      const edits = editsRef.current[key] ?? {}
      if (!hasEdits(edits)) {
        // 送るものが無い（R-C）。送信待ちの行は送信待ちのまま
        if (phase !== 'queued') setPhase(key, 'idle')
        return
      }
      // 表示中の値（サーバーの値に送信待ちの値を重ねたもの＝指摘 M1）。送信待ちへ渡した後の表示に使う
      const shown = { ...mealCells(existing), ...(phase === 'queued' ? (queuedRef.current[key] ?? {}) : {}) } as MealCells
      const send = editValues(edits) as MealPatch
      const before = overwrittenFrom(existing, send)
      const target = { residentId, day: dayRef.current, slot: slotAt }
      // 送信待ちで止まっている行を、読み直しで食い違いが無くなったのを確かめてから送り直す時は画面の基準で送る（rebase）
      const heldRow = pendingRow('meals', target)
      const rebase = heldRow !== null && heldRow.state === 'conflict'
      // 送る前に印を付ける（変更通知が応答より先に届いても、自分の書き込みで取り直さない＝F17）
      selfWriteRef.current = Date.now()
      try {
        const res = await saveMealEdits(target, edits, {
          // 記入者は新しい行の時だけ「空いていれば埋める」（更新では編集列以外を送らない＝部分更新）
          ...(existing ? {} : { fill: { recorded_by: actorRef.current } }),
          rebase,
        })
        if (!aliveRef.current) return
        selfWriteRef.current = Date.now()
        if (res === 'queued' && !isQueuePersisted()) {
          // 送信待ちにしたが、端末に控えを残せなかった（F01）。送ったものとして扱わない: 入力（edits）は残し、
          // 送信待ちの重ね表示（queuedRef）にも積まず、「未保存」として理由を出す（離れる時の確認にも数える）。
          // 送信待ちはこのタブのメモリにはあるので、電波が戻れば送られ、その後の読み込みで片付く
          unpersistedRef.current[key] = true
          setPhase(key, 'error', MSG_NOT_PERSISTED)
          return
        }
        if (res === 'queued') {
          // 送信待ちにした値は、送信が済むまで表示に重ねて残す（指摘 M1）。送信待ちへ渡し終えた欄だけ
          // 編集から消す（R-D・欄単位）。送信待ちの後に押す値は送った内容が基準
          delete unpersistedRef.current[key]
          queuedRef.current[key] = { ...(queuedRef.current[key] ?? {}), ...send }
          writeEdits(key, settleSent(editsRef.current[key] ?? {}, edits, { ...shown, ...send }))
          setPhase(key, 'queued', MSG_QUEUED)
          return
        }
        // サーバーへ届いた。端末に控えを残せなかった送信待ち（F01）の分も、同じ送り先の送信待ちへまとまって届いた
        delete unpersistedRef.current[key]
        if (res.held === true) {
          // ほかの端末の値と食い違って止まっている行へまとめた（送っていない）。競合として見せる
          holdAsHeld(residentId, slotAt)
          await refreshAfterConflict(residentId, slotAt)
          return
        }
        const missing = res.conflicts.length > 0 && res.conflicts.every((c) => c.reason === 'missing')
        const nextMeals = { ...mealsRef.current }
        if (res.row) nextMeals[key] = res.row
        else if (missing) delete nextMeals[key]
        commitMeals(nextMeals)
        // 送信待ちにまだ残っている分だけ重ね表示を持ち続ける（送れた分は外す）
        const still = pendingRow('meals', target)
        if (still !== null && still.state === 'pending') {
          const vals: MealPatch = {}
          for (const f of MEAL_FIELDS) if (f in still.values) (vals as Record<string, unknown>)[f] = still.values[f]
          queuedRef.current[key] = vals
        } else delete queuedRef.current[key]
        // 書けた欄・もう載っていた欄だけ消す（R-F）。保存中に押した欄は残り、その時に積まれた仕事が続けて送る
        const done = new Set<string>([...res.applied, ...res.settled])
        const doneEdits: Edits<MealField> = {}
        for (const f of Object.keys(edits) as MealField[]) {
          const e = edits[f]
          if (done.has(f) && e) doneEdits[f] = e
        }
        const afterSave = res.row ? mealCells(res.row) : mealCells(null)
        // 控えにある全ての欄（〔両方残す〕のメモを含む＝第3段 #4）を、応答に載ったいまの値で消し込む
        const remain = settleSent(editsRef.current[key] ?? {}, doneEdits, mealJudgeCells(res.row) as MealCells)
        writeEdits(key, remain)
        delete staleRef.current[key] // 応答にいまの行が載っている（先の値を出してよい）
        if (res.conflicts.length > 0) {
          // 書かなかった欄がある: 編集は残す（R-D）。先の値（いまのサーバーの値）とあなたの入力を並べる
          if (missing) missingRef.current[key] = true
          else delete missingRef.current[key]
          setPhase(key, 'conflict', missing ? missingRowText(describeMealEdits(remain)) : ERR_CONFLICT_STILL)
          return
        }
        delete missingRef.current[key]
        setPhase(key, hasEdits(remain) ? 'saving' : 'saved')
        if (isUndo) {
          showRef.current('元に戻しました。')
        } else if (Object.keys(before).length > 0 && res.applied.length > 0) {
          // 元の値へ戻す保存を Undo に載せる（8秒）。取り消し自体は同じ保存経路を通す
          // 元に戻す時の基準は「自分が保存した後の値」。その間に他の端末が書き換えていれば競合にする
          // （他の端末の値を黙って上書きしない＝指摘 M2）
          showRef.current(overwriteText(before, send), () => {
            saveMealRef.current(residentId, before, slotAt, true, afterSave)
          })
        }
      } catch (e) {
        if (!aliveRef.current) return
        setPhase(key, 'error', msgOf(e, ERR_SAVE)) // 編集は残す（R-D）
      }
    },
    [commitMeals, holdAsHeld, refreshAfterConflict, setPhase, writeEdits],
  )

  /** 1行の保存を行ごとの順番待ちに積む（構造規約 R-F。積んだ時点の値は持ち越さない） */
  const enqueueSave = useCallback(
    (residentId: number, slotAt: MealSlot, isUndo = false) => {
      const key = mealKey(residentId, slotAt)
      const p = phasesRef.current[key]
      if (p !== 'conflict' && p !== 'queued') setPhase(key, 'saving')
      enqueue(key, () => runSave(residentId, slotAt, isUndo))
    },
    [enqueue, runSave, setPhase],
  )

  /**
   * 食事1行の入力を確定する。既存行があれば部分更新、無ければ新規作成（upsert は使わない）。
   * shownAt は押した時に画面に出ていた値（構造規約 R-E の基準）。記録済みの値を上書きした時は Undo を出す。
   * slotAt は保存する食事枠。トーストの Undo を押すまでに枠を切り替えても、取り消しが別の枠へ当たらない
   */
  const saveMeal = useCallback(
    (residentId: number, rawPatch: MealPatch, slotAt: MealSlot, isUndo = false, shownAt?: Partial<MealCells>) => {
      if (!canInputRef.current) {
        if (isUndo) showRef.current('元に戻せませんでした。入力できない状態です。')
        return
      }
      touchActivity()
      const key = mealKey(residentId, slotAt)
      const phaseNow = phasesRef.current[key]
      const cur = mealsRef.current[key] ?? null
      const ov = pendingRef.current[key] ?? {}
      const shown: MealCells = {
        main_amount: ov.main_amount !== undefined ? ov.main_amount : (cur?.main_amount ?? null),
        side_amount: ov.side_amount !== undefined ? ov.side_amount : (cur?.side_amount ?? null),
        status: ov.status !== undefined ? ov.status : (cur?.status ?? null),
      }
      const prev = editsRef.current[key] ?? {}
      let edits = prev
      for (const f of MEAL_FIELDS) {
        if (rawPatch[f] === undefined) continue
        const base = shownAt && shownAt[f] !== undefined ? shownAt[f] : shown[f]
        // 構造規約 R-E・R-B: 基準から実際に変わった時だけ記録。既に編集のある欄は基準を変えない
        edits = recordFieldEdit(edits, f, rawPatch[f], base)
      }
      if (edits === prev) {
        // 変わっていない（同じ量をもう一度押した）。未保存・保存失敗なら控えを送り直す
        if (holdsNormalSave(phaseNow)) setPhase(key, 'conflict', ERR_CONFLICT_HOLD)
        else if (phaseNow === 'error' && hasEdits(prev)) enqueueSave(residentId, slotAt, isUndo)
        return
      }
      writeEdits(key, edits)
      if (holdsNormalSave(phaseNow)) {
        setPhase(key, 'conflict', ERR_CONFLICT_HOLD)
        return
      }
      enqueueSave(residentId, slotAt, isUndo)
    },
    [enqueueSave, setPhase, writeEdits],
  )

  // Undo から自分自身を呼ぶための参照（保存経路を1本に保つ）
  useEffect(() => {
    saveMealRef.current = saveMeal
  }, [saveMeal])

  const onAmount = useCallback(
    (residentId: number, field: 'main_amount' | 'side_amount', value: number, shown: number | null) => {
      // 押した時に画面に出ていた値を、この欄の基準にする（構造規約 R-E）
      saveMeal(residentId, { [field]: value } as MealPatch, slotRef.current, false, { [field]: shown })
    },
    [saveMeal],
  )

  const onStatus = useCallback(
    (residentId: number, value: MealStatus, shown: MealStatus | null) => {
      saveMeal(residentId, { status: value }, slotRef.current, false, { status: shown })
    },
    [saveMeal],
  )

  /**
   * まとまりを操作した（押した・フォーカスした）ことを Presence へ伝える（今日・いま選んでいる食事の区分）。
   * 最後の操作から PRESENCE_TOUCH_HOLD_MS で取り消す。戻り値は blur で早めに取り消す関数
   */
  const { touch: presenceTouch } = presence
  const onPresence = useCallback(
    (residentId: number, field: 'main_amount' | 'side_amount' | 'status'): LeaveCell | null => {
      if (!canInputRef.current) return null
      return presenceTouch(focusOf({ table: 'meals', day: dayRef.current, residentId, field, slot: slotRef.current }))
    },
    [presenceTouch],
  )

  /** 水分の加算（1タップ＝1件の記録）。取り消しはサーバー行を観測できた分だけ受け付ける */
  const onFluid = useCallback(
    (residentId: number, ml: number) => {
      if (!canInputRef.current) return
      touchActivity()
      enqueue(`fluid:${residentId}`, async () => {
        // 送る前に印を付ける（応答より先に届く変更通知で取り直さない）
        selfWriteRef.current = Date.now()
        try {
          const res = await insertFluid({
            resident_id: residentId,
            taken_on: dayRef.current,
            // 時刻は表示中の日が今日の時だけ（日付をまたいで開いたままの前日に今朝の時刻を入れない＝F18）
            taken_at: takenAtFor(dayRef.current),
            amount_ml: ml,
            kind: null,
            recorded_by: actorRef.current,
          })
          if (!aliveRef.current) return
          selfWriteRef.current = Date.now()
          if (res === 'queued' && !isQueuePersisted()) {
            // 送信待ちにしたが、端末に控えを残せなかった（F01）。送信待ちの概算（queuedFluids）には積まず、
            // この方の水分の欄に危険の色で残す（トーストだけで終わらせない）。電波が戻れば送られ、合計に載ったら消える
            setLostFluids((prev) => {
              const held = prev[residentId]
              const base = held ? held.base : serverFluidMl(fluidsRef.current, residentId)
              return { ...prev, [residentId]: { base, ml: (held?.ml ?? 0) + ml } }
            })
            showRef.current(`水分 ＋${ml}ml：${MSG_NOT_PERSISTED}`)
            return
          }
          if (res === 'queued') {
            setQueuedFluids((prev) => {
              const held = prev[residentId]
              // base は最初に退避した時点のサーバー合計を保つ（重ねて退避しても基準をずらさない）
              const base = held ? held.base : serverFluidMl(fluidsRef.current, residentId)
              return { ...prev, [residentId]: { base, ml: (held?.ml ?? 0) + ml } }
            })
            showRef.current(`水分 ＋${ml}ml：${MSG_QUEUED}`)
            return
          }
          commitFluids([...fluidsRef.current, res])
          commitUndo({ ...undoRef.current, [residentId]: { id: res.id, rev: res.rev, ml } })
          showRef.current(`水分 ＋${ml}ml を記録しました。`)
        } catch (e) {
          if (!aliveRef.current) return
          showRef.current(msgOf(e, ERR_SAVE))
        }
      })
    },
    [commitFluids, commitUndo, enqueue],
  )

  /** 直前に追加した水分の取り消し（論理削除。物理削除はしない） */
  const onUndoFluid = useCallback(
    (residentId: number) => {
      const target = undoRef.current[residentId]
      if (!target) return
      touchActivity()
      enqueue(`fluid:${residentId}`, async () => {
        selfWriteRef.current = Date.now()
        try {
          const res = await softDeleteFluid(target.id, target.rev)
          if (!aliveRef.current) return
          selfWriteRef.current = Date.now()
          if (res === 'conflict') {
            showRef.current(ERR_FLUID_UNDO_CONFLICT)
            return
          }
          if (res === 'queued') {
            // 取り消しはキューへ退避済み（通信が戻れば自動で送られる）。
            // 画面は取り消した後の姿を先に見せる（同じ行の取り消しを二重に積まないよう控えも外す）。
            // まだサーバーには載っていないので、取り直すと合計にはこの分が戻る（消失より復活）
            commitFluids(fluidsRef.current.filter((f) => f.id !== target.id))
            const queuedUndo = { ...undoRef.current }
            delete queuedUndo[residentId]
            commitUndo(queuedUndo)
            // 端末に控えを残せなかった時（F01）は、送信待ちとして案内しない（閉じると取り消しが消え、記録が残る側に倒れる）
            showRef.current(`水分 ＋${target.ml}ml の取り消し：${isQueuePersisted() ? MSG_QUEUED : MSG_NOT_PERSISTED}`)
            return
          }
          commitFluids(fluidsRef.current.filter((f) => f.id !== target.id))
          const nextUndo = { ...undoRef.current }
          delete nextUndo[residentId]
          commitUndo(nextUndo)
          showRef.current(`水分 ＋${target.ml}ml の記録を取り消しました。`)
        } catch (e) {
          if (!aliveRef.current) return
          showRef.current(msgOf(e, ERR_FLUID_UNDO))
        }
      })
    },
    [commitFluids, commitUndo, enqueue],
  )

  const onReload = useCallback(() => {
    void load()
  }, [load])

  /**
   * 相手の行が取り消されていた行の控えを、新しい行として保存する（〔新しい行として保存〕。行ごとの順番待ちを通す）
   */
  const onSaveNew = useCallback(
    (residentId: number) => {
      const slotAt = slotRef.current
      const key = mealKey(residentId, slotAt)
      if (!missingRef.current[key]) return
      enqueue(key, async () => {
        const cur = editsRef.current[key] ?? {}
        // 控えにある全ての欄（メモを含む）の値を新しい行へ（基準 null）。送信待ちにしか無い欄も db.ts が基準 null にそろえる（F4）
        const vals = valuesForBoth(judgeFields(MEAL_FIELDS, { values: cur }), editValues(cur))
        const edits: Edits<MealField> = {}
        for (const f of Object.keys(vals) as MealField[]) {
          const e = cur[f]
          if (e) edits[f] = { ...e, base: null }
        }
        if (!hasEdits(edits)) return
        selfWriteRef.current = Date.now()
        try {
          const res = await saveMealEdits(
            { residentId, day: dayRef.current, slot: slotAt },
            edits,
            { rebase: true, asNew: true, fill: { recorded_by: actorRef.current } },
          )
          if (!aliveRef.current) return
          selfWriteRef.current = Date.now()
          delete missingRef.current[key]
          if (res === 'queued' && !isQueuePersisted()) {
            // 端末に控えを残せなかった（F01）。新しい行として送る入力（基準 null）を残し、「未保存」として出す
            unpersistedRef.current[key] = true
            writeEdits(key, edits)
            setPhase(key, 'error', MSG_NOT_PERSISTED)
            return
          }
          if (res === 'queued') {
            queuedRef.current[key] = { ...(queuedRef.current[key] ?? {}), ...(editValues(edits) as MealPatch) }
            writeEdits(key, {})
            setPhase(key, 'queued', MSG_QUEUED)
            return
          }
          if (res.row) commitMeals({ ...mealsRef.current, [key]: res.row })
          if (res.conflicts.length > 0) {
            setPhase(key, 'conflict', ERR_CONFLICT_STILL)
            return
          }
          writeEdits(key, {})
          setPhase(key, 'saved')
        } catch (e) {
          if (!aliveRef.current) return
          setPhase(key, 'conflict', msgOf(e, ERR_SAVE))
        }
      })
    },
    [commitMeals, enqueue, setPhase, writeEdits],
  )

  /** 相手の行が取り消されていた行の控えを取り下げる（〔取り下げる〕。送信待ちからも外す） */
  const onDrop = useCallback(
    (residentId: number) => {
      const slotAt = slotRef.current
      const key = mealKey(residentId, slotAt)
      enqueue(key, async () => {
        // 画面が見せていた版だけ外す（第3段 #9。見た後に他のタブが入れた値は外さない）
        const target = { residentId, day: dayRef.current, slot: slotAt }
        await discardPendingRow('meals', target, undefined, seenVers(pendingRow('meals', target), editValues(editsRef.current[key] ?? {})))
        if (!aliveRef.current) return
        delete missingRef.current[key]
        writeEdits(key, {})
        setPhase(key, 'idle')
      })
    },
    [enqueue, setPhase, writeEdits],
  )

  // ── 食い違いをくらべて選ぶ ──

  /** 競合中の行を「くらべて選ぶ」画面で開く（開いた時点の入力で固定する） */
  const onCompare = useCallback(
    (residentId: number) => {
      const slotNow = slotRef.current
      const key = mealKey(residentId, slotNow)
      if (phasesRef.current[key] !== 'conflict') return
      const r = residents.find((x) => x.id === residentId)
      const edits = editsRef.current[key] ?? {}
      setCompare({
        key,
        target: { table: 'meals', residentId, day: dayRef.current, slot: slotNow },
        name: r?.name ?? '',
        // 見ていた値＝欄ごとの基準（押した時の値）／あなたの入力＝実際に入れた欄の値
        base: { ...editBases(edits, mealCells(mealsRef.current[key])) },
        mine: { ...editValues(edits) },
      })
    },
    [residents],
  )

  // アプリ内の画面移動・再読み込み・タブを閉じる時に確認を出すための登録（App・beforeunload が参照する）
  useEffect(
    () =>
      // 構造規約 R-G: 編集が1欄でも残る行（送信待ちの後・保存中に押した値を含む）と競合中の行を数える
      registerUnsaved(
        () =>
          Object.values(editsRef.current).some((e) => hasEdits(e)) ||
          Object.values(phasesRef.current).some((p) => p === 'conflict') ||
          // 端末に控えを残せなかった送信待ち（食事・水分＝F01）は、画面を離れると消える
          Object.keys(unpersistedRef.current).length > 0 ||
          fluidsHeldRef.current.lost > 0,
      ),
    [],
  )

  // ── 日付をまたいだ時（F18・2026-10-10 本人回答: 入力中・未送信が無ければ今日へ自動で切り替える） ──
  // 開いたまま日付をまたぐと、前日の朝食の行・前日の水分合計へ今朝の記録を入れていた。1分ごと・画面に戻った時・電波が
  // 戻った時に今日と比べ、切り替えて失うものが無ければ黙って今日へ移る（食事の枠も今の時刻で選び直す）。
  // 未保存・競合・未送信・保存中がある時は切り替えず、帯で知らせて〔今日にする〕を出す

  /** 保存の応答待ち・順番待ちの仕事がある（日を切り替えると、その仕事が新しい日へ送られる） */
  const isBusy = useCallback(
    () => jobsRef.current > 0 || Object.values(phasesRef.current).some((p) => p === 'saving'),
    [],
  )
  /** 日を切り替えると画面から消える入力（未保存・競合・止まった送信・端末に残せなかった送信待ち）があるか */
  const holdsAnyInput = useCallback(
    () =>
      Object.values(editsRef.current).some((e) => hasEdits(e)) ||
      Object.values(phasesRef.current).some((p) => p === 'conflict' || p === 'error') ||
      Object.keys(unpersistedRef.current).length > 0 ||
      fluidsHeldRef.current.lost > 0,
    [],
  )

  /** 表示中の日を t へ切り替える（前の日の控えは片付ける。前の日の送信待ちは db.ts に残って前の日へ送られる） */
  const switchDay = useCallback(
    (t: string) => {
      dayRef.current = t // 先に書く: 前の日の取得の応答を新しい日へ当てない（load は dayRef を読む）
      genRef.current += 1
      editsRef.current = {}
      phasesRef.current = {}
      setPhases({})
      msgsRef.current = {}
      setRowMsgs({})
      queuedRef.current = {}
      missingRef.current = {}
      staleRef.current = {}
      unpersistedRef.current = {}
      commitMeals({})
      commitFluids([])
      setOutings([])
      commitUndo({})
      setQueuedFluids({})
      setLostFluids({})
      syncPendingAll()
      setCompare(null)
      setDayAsk(false)
      // 食事の枠は開いた時と同じく今の時刻で選び直す（前の日の夕食の枠のまま今朝の朝食を入れない）
      const nextSlot = slotForHour(new Date().getHours())
      slotRef.current = nextSlot
      setSlot(nextSlot)
      setDaySwitching(true) // 新しい日の記録を読み終えるまで押させない（load が下ろす）
      setNowDay(t)
      setDay(t)
      void load()
    },
    [commitFluids, commitMeals, commitUndo, load, syncPendingAll],
  )

  const switchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (switchTimerRef.current !== null) clearTimeout(switchTimerRef.current)
    },
    [],
  )

  /**
   * 今日へ切り替える（〔今日にする〕・確認の後）。保存の途中なら終わるのを待ってから切り替える。
   * まだ保存していない入力が残っていれば、確認（confirmed=false の時）を出す
   */
  const switchToToday = useCallback(
    (confirmed: boolean) => {
      if (switchTimerRef.current !== null) clearTimeout(switchTimerRef.current)
      switchTimerRef.current = null
      const step = () => {
        switchTimerRef.current = null
        if (!aliveRef.current) return
        const t = todayIso()
        if (dayRef.current === t) {
          setNowDay(t)
          return
        }
        if (isBusy()) {
          switchTimerRef.current = setTimeout(step, 300)
          return
        }
        if (!confirmed && holdsAnyInput()) {
          setDayAsk(true)
          return
        }
        switchDay(t)
      }
      step()
    },
    [holdsAnyInput, isBusy, switchDay],
  )

  useEffect(() => {
    const check = () => {
      if (!aliveRef.current) return
      const t = todayIso()
      setNowDay(t)
      if (dayRef.current === t) return
      // 切り替えて失うもの・取り違えるものが無い時だけ黙って切り替える（未送信の食事・水分も残っていないこと）。
      // 電波が無い間は切り替えない（新しい日を読めない。電波が戻った時に見直す）
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      const quiet =
        !offline &&
        !isBusy() &&
        !holdsAnyInput() &&
        !Object.values(phasesRef.current).some((p) => p === 'queued') &&
        fluidsHeldRef.current.queued === 0
      if (dayRollover(dayRef.current, t, quiet) === 'switch') switchDay(t)
    }
    const timer = setInterval(check, DAY_CHECK_MS)
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') check()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    if (typeof window !== 'undefined') window.addEventListener('online', check)
    return () => {
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
      if (typeof window !== 'undefined') window.removeEventListener('online', check)
    }
  }, [holdsAnyInput, isBusy, switchDay])

  /**
   * くらべて選ぶの送信（〔先の値を残す〕〔自分の値で直す〕〔両方残す〕）。通常の保存と同じ順番待ちに通す（指摘 L2）。
   * 送信待ちで止まっている値の取り下げ・送り直しは ConflictResolver が db.ts へ頼む
   */
  const runResolverJob = useCallback(
    (key: string, job: () => Promise<void>) =>
      new Promise<void>((resolve) => {
        enqueue(key, async () => {
          // 送る前と後に自分の書込の印を付ける（選び直した後の行を、その前に出た取り直しの古い値で描き直さない）
          selfWriteRef.current = Date.now()
          try {
            await job()
          } finally {
            selfWriteRef.current = Date.now()
            resolve()
          }
        })
      }),
    [enqueue],
  )

  /** 選んだ結果でその行を最新に描き直し、競合の表示を消す */
  const onResolved = useCallback(
    (r: ConflictResolution) => {
      const cur = compare
      setCompare(null)
      if (!cur) return
      // 〔くらべて選ぶ〕が消えるので、フォーカスをその方の氏名へ移す（body へ落とさない）
      focusAfterResolve(`mg-name-${cur.target.residentId}`)
      if (r.choice === 'reload') {
        // 食い違いが無かった／先の記録が見つからない: 最新を読み込む（競合の行は load が裁く）
        void load()
        return
      }
      const key = cur.key
      const latest = r.latest as Meal | null
      const nextMeals = { ...mealsRef.current }
      if (latest) nextMeals[key] = latest
      commitMeals(nextMeals)
      // 送信待ちで止まっていた値の取り下げ・送り直しは ConflictResolver が済ませている
      delete missingRef.current[key]
      delete staleRef.current[key]
      if (r.choice === 'mine' && r.queued && latest) {
        // 自分の値で直す更新を送信待ちにした。送信が済むまで、その値を表示に重ねて残す（指摘 M1）
        queuedRef.current[key] = { main_amount: latest.main_amount, side_amount: latest.side_amount, status: latest.status }
      } else {
        delete queuedRef.current[key]
      }
      // 3択のどれかを選んだ＝この行の編集は解決した（くらべて選ぶで送った・取り下げた）
      writeEdits(key, {})
      if (r.queued && (r.choice === 'mine' || r.choice === 'both') && !isQueuePersisted()) {
        // 選んだ内容を送信待ちにしたが、端末に控えを残せなかった（F01）。送信待ちとして案内せず、離れる時の確認に数える
        unpersistedRef.current[key] = true
        setPhase(key, 'error', MSG_NOT_PERSISTED)
        return
      }
      if (r.choice === 'mine' && r.queued) {
        setPhase(key, 'queued', MSG_QUEUED)
        return
      }
      if (r.queued) {
        // 両方残す（メモへの書き足し）を送信待ちにした
        setPhase(key, 'queued', MSG_QUEUED)
        return
      }
      setPhase(key, r.choice === 'theirs' ? 'idle' : 'saved')
    },
    [commitMeals, compare, load, setPhase, writeEdits],
  )

  // ── 表示用の組み立て ──

  /** 一覧に実在する階だけを選択肢にする（居室未設定の利用者も必ずどこかに出る） */
  const floorOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of residents) set.add(floorOf(r.room))
    const opts = Array.from(set)
      .filter((f) => f !== FLOOR_OTHER)
      .sort()
      .map((f) => ({ value: f, label: `${f}階` }))
    if (set.has(FLOOR_OTHER)) opts.push({ value: FLOOR_OTHER, label: '居室未設定' })
    return opts
  }, [residents])

  // 選択中の階が一覧に無くなった場合だけ先頭へ倒す（壊れた値で空表示にしない）
  useEffect(() => {
    if (floorOptions.length === 0) return
    if (floorOptions.some((o) => o.value === floor)) return
    setFloor(floorOptions[0].value)
  }, [floorOptions, floor])

  /** 表示対象（選択中の階・居室昇順） */
  const visible = useMemo(() => {
    return residents
      .filter((r) => floorOf(r.room) === floor)
      .slice()
      .sort((a, b) => {
        const na = roomNum(a.room)
        const nb = roomNum(b.room)
        if (na != null && nb != null && na !== nb) return na - nb
        if (na == null && nb != null) return 1
        if (na != null && nb == null) return -1
        return a.id - b.id
      })
  }, [residents, floor])

  const fluidByResident = useMemo(() => {
    const map = new Map<number, { ml: number; count: number }>()
    for (const f of fluids) {
      const cur = map.get(f.resident_id) ?? { ml: 0, count: 0 }
      cur.ml += Number.isFinite(f.amount_ml) ? f.amount_ml : 0
      cur.count += 1
      map.set(f.resident_id, cur)
    }
    return map
  }, [fluids])

  const showLoading = loading && residents.length === 0
  const showEmpty = !loading && residents.length === 0

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-gap p-4">
      <SectionCard>
        {/* bar-compact: スマホの幅では上部のボタンを小さく・間隔を詰める（sheet.css） */}
        <div className="bar-compact flex flex-wrap items-center justify-between gap-gap">
          <h2 className="text-lg font-bold text-ink">{fmtDayLabel(day)} の食事・水分</h2>
          <button
            type="button"
            onClick={onReload}
            className="min-h-tap rounded border border-border-strong px-4 text-base text-ink"
          >
            最新を読み込む
          </button>
        </div>
        {/* いまの記録者（新しい行の記入者・変更の記録に付く）を常に出し、その場で切り替えられるようにする（F38）。
            1台を複数の職員で使うため、前の人の記録者のまま入れるのを防ぐ。印刷には出さない（部品が print:hidden） */}
        <RecorderBar actorId={actorId ?? null} className="mt-2" />
        {day !== nowDay ? (
          // 日付をまたいだが、未保存・未送信などがあって自動では切り替えなかった（F18）。入力は止めない
          <div role="status" className="mt-3 rounded border border-warn bg-warn-bg p-3">
            <p className="text-base text-ink">
              <span aria-hidden="true">▲ </span>
              日付が変わりました（表示中: {fmtDayLabel(day)}）。入力中・未送信の記録があるか電波が無いため、自動では切り替えていません。
            </p>
            <button
              type="button"
              onClick={() => switchToToday(false)}
              className="mt-3 min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary"
            >
              今日（{fmtDayLabel(nowDay)}）にする
            </button>
          </div>
        ) : null}
        <div className="bar-compact mt-3">
          <span className="text-sm text-ink2">食事の枠</span>
          <div className="mt-1">
            <SegmentPicker
              options={SLOT_OPTIONS}
              value={slot}
              onChange={(v) => setSlot(v as MealSlot)}
              ariaLabel="食事の枠"
            />
          </div>
        </div>
        {floorOptions.length > 0 ? (
          <div className="bar-compact mt-3">
            <span className="text-sm text-ink2">フロア</span>
            <div className="mt-1">
              <SegmentPicker
                options={floorOptions}
                value={floor}
                onChange={(v) => {
                  setFloor(v)
                  // 選んだ階を UI 状態として残す（再読み込み・Safari の画面の破棄の後も同じ階で開く＝F68・原則11）
                  writeMealsFloor(v)
                }}
                ariaLabel="フロアを選ぶ"
              />
            </div>
          </div>
        ) : null}
      </SectionCard>

      {flagError ? <ErrorBlock message={flagError} onRetry={forbidden ? undefined : () => void loadFlag()} /> : null}

      {!flagError && !flagChecked ? (
        <div role="status" aria-live="polite" className="rounded-lg border border-border bg-surface p-4">
          <p className="text-base text-ink2">
            アプリで入力してよい期間かを確認しています…（確認できるまで入力はできません）
          </p>
        </div>
      ) : null}

      {!flagError && flagChecked && !inputEnabled ? (
        <div role="status" className="rounded-lg border border-info bg-info-bg p-4">
          <p className="text-base text-ink">
            <span aria-hidden="true">ⓘ </span>
            {BLOCKED_TEXT}
          </p>
        </div>
      ) : !flagError && flagChecked && cellsMissing ? (
        <div role="status" className="rounded-lg border border-info bg-info-bg p-4">
          <p className="text-base text-ink">
            <span aria-hidden="true">ⓘ </span>
            {CELLS_PENDING_REASON}
          </p>
        </div>
      ) : null}


      {error && residents.length > 0 ? <ErrorBlock message={error} onRetry={onReload} /> : null}

      {/* 他の端末が入力中の欄の要約（誰が・どこを）。無い時も1行の高さを取る＝出ても一覧を押し下げない */}
      <PresenceSummary
        text={presence.summary((p) => {
          if (p.cell.table !== 'meals' || p.day !== day || !p.cell.slot) return null
          const r = visible.find((x) => x.id === p.residentId)
          if (!r) return null
          return `${r.name} ${MEAL_SLOT_LABEL[p.cell.slot]} ${MEAL_FIELD_WORD[p.cell.field] ?? ''}`.trim()
        })}
      />

      {showLoading ? (
        <LoadingBlock label="食事・水分の記録を読み込んでいます…" />
      ) : error && residents.length === 0 ? (
        <ErrorBlock message={error} onRetry={onReload} />
      ) : showEmpty ? (
        <EmptyBlock message="利用者の一覧がまだありません。設定タブでマスタ同期を実行してください。" />
      ) : visible.length === 0 ? (
        <EmptyBlock message="このフロアに対象の利用者がいません。上のボタンでフロアを切り替えてください。" />
      ) : (
        <fieldset disabled={!canInput} className={canInput ? '' : 'opacity-60'}>
          <legend className="sr-only">
            {`${fmtDayLabel(day)} ${MEAL_SLOT_LABEL[slot]}の食事・水分の入力`}
          </legend>
          <ul className="flex flex-col gap-gap">
            {visible.map((r) => {
              const key = mealKey(r.id, slot)
              const row = meals[key] ?? null
              const ov = pending[key] ?? {}
              const fl = fluidByResident.get(r.id)
              const o = outingOnDay(outings, r.id, day)
              // 他の端末がこの方の、いま選んでいる食事を入力中か（Presence）
              const at = (field: MealField): CellTarget => ({ table: 'meals', day, residentId: r.id, field, slot })
              return (
                <MealRow
                  key={r.id}
                  resident={r}
                  busyMain={presence.cellBusy(at('main_amount'))}
                  busySide={presence.cellBusy(at('side_amount'))}
                  busyStatus={presence.cellBusy(at('status'))}
                  rowBusy={presence.rowBusy('meals', day, r.id)}
                  onPresence={onPresence}
                  main={ov.main_amount !== undefined ? ov.main_amount : (row?.main_amount ?? null)}
                  side={ov.side_amount !== undefined ? ov.side_amount : (row?.side_amount ?? null)}
                  status={ov.status !== undefined ? ov.status : (row?.status ?? null)}
                  phase={phases[key] ?? 'idle'}
                  message={rowMsgs[key] ?? null}
                  fluidMl={fl?.ml ?? 0}
                  fluidCount={fl?.count ?? 0}
                  queuedMl={queuedFluids[r.id]?.ml ?? 0}
                  lostMl={lostFluids[r.id]?.ml ?? 0}
                  outingLabel={o ? OUTING_KIND_LABEL[o.kind] : null}
                  canUndoFluid={undoFluids[r.id] != null}
                  onAmount={onAmount}
                  onStatus={onStatus}
                  onFluid={onFluid}
                  onUndoFluid={onUndoFluid}
                  onReload={onReload}
                  onCompare={onCompare}
                  missing={missingRef.current[key] === true}
                  onSaveNew={onSaveNew}
                  onDrop={onDrop}
                  heldText={
                    // 先の値が古いかもしれない間（保存が競合したのに最新を取り直せなかった）は値を出さない（指摘 U1c）
                    (phases[key] === 'conflict' || phases[key] === 'error') && staleRef.current[key] !== true && missingRef.current[key] !== true
                      ? mealHeldText(editValues(editsRef.current[key] ?? {}), mealCells(row))
                      : ''
                  }
                />
              )
            })}
          </ul>
        </fieldset>
      )}

      <ConflictResolver
        target={compare?.target ?? null}
        residentName={compare?.name ?? ''}
        base={compare?.base ?? {}}
        mine={compare?.mine ?? {}}
        actorId={actorId ?? null}
        // 〔自分の値で直す〕〔両方残す〕の送信も、この行の保存の順番待ちに通す（構造規約 R-F）
        serialize={compare ? (job) => runResolverJob(compare.key, job) : undefined}
        onClose={() => setCompare(null)}
        onResolved={onResolved}
      />

      <ConfirmDialog
        open={dayAsk}
        title={LEAVE_TITLE}
        body={`表示中の日（${fmtDayLabel(day)}）に、他の端末の値と食い違って止まっている入力、またはまだ保存していない入力があります。今日に切り替えると、その入力は破棄されます（送信待ちにした記録は ${fmtDayLabel(day)} の記録として送られます）。切り替えてよろしいですか。`}
        confirmLabel="今日に切り替える"
        danger
        onConfirm={() => {
          setDayAsk(false)
          switchToToday(true)
        }}
        onCancel={() => setDayAsk(false)}
      />

      {toast}
    </div>
  )
}
