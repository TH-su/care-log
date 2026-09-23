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

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  DbError,
  discardPendingRow,
  fetchLatestMeal,
  fetchResidents,
  fetchTimelineChunk,
  getNativeInputGate,
  insertFluid,
  pendingRow,
  saveMealEdits,
  softDeleteFluid,
} from '../lib/db'
import type { PendingCellRow } from '../lib/db'
import { getActorId, touchActivity } from '../lib/actor'
import { fmtDayLabel, toHalfWidth, todayIso } from '../lib/format'
import { MEAL_SLOT_LABEL, MEAL_STATUS_LABEL, OUTING_KIND_LABEL } from '../lib/types'
import type { FluidIntake, Meal, MealSlot, MealStatus, Outing, Resident } from '../lib/types'
import {
  Chip,
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
import { registerUnsaved } from '../lib/leaveGuard'
import type { MealField } from '../lib/conflict'

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

/** 'HH:MM'（端末ローカル時刻＝JST運用） */
function nowTimeHM(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
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

// ── 摂取量（0〜10）の11セグメント ─────────────────────────────

interface AmountRowProps {
  label: string
  groupLabel: string
  value: number | null
  onPick: (value: number) => void
}

/**
 * 44×44 のボタン11個。選択中は「色＋太字」だけに頼らず、
 * ラベル横に選択値を文字で出す（未選択は「未入力」）＋ aria-pressed を付ける。
 */
function AmountRow({ label, groupLabel, value, onPick }: AmountRowProps) {
  return (
    <div className="mt-3">
      <div className="flex items-baseline gap-gap">
        <span className="text-sm text-ink2">{label}</span>
        <span className="tabular text-base font-bold text-ink">
          {value == null ? '未入力' : value}
        </span>
      </div>
      <div role="group" aria-label={groupLabel} className="mt-1 flex flex-wrap gap-gap">
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
}: MealRowProps) {
  // 加算チップに無い量（80ml・500ml など）を1回で記録するための任意量入力（ui-design §6）
  const [extra, setExtra] = useState('')
  const [extraError, setExtraError] = useState(false)
  const uid = useId()
  const extraId = `${uid}-fluid`
  const extraErrId = `${uid}-fluid-err`

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
      />
      <AmountRow
        label="副食"
        groupLabel={`${resident.name} の副食の量（0〜10）`}
        value={side}
        onPick={(v) => onAmount(resident.id, 'side_amount', v, side)}
      />

      <div className="mt-3">
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
  // 対象日はこの画面を開いた日（当日）。日付切替UIは仕様に無いため設けない
  const [day] = useState(() => todayIso())
  const [slot, setSlot] = useState<MealSlot>(() => slotForHour(new Date().getHours()))
  // フロアは一覧から作る（居室未設定の利用者も FLOOR_OTHER で必ず表示できるようにする）。
  // 食事グリッド用の localStorage キーは types.ts の LS に無いため、選択は保存しない
  const [floor, setFloor] = useState<string>('1')

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
  /** サーバーに欄ごとの保存の仕組み（0011）がまだ無い＝サーバー側の更新待ち（入力を止める） */
  const [cellsMissing, setCellsMissing] = useState(false)

  const { toast, show } = useToast()

  const actorId = actorIdProp !== undefined ? actorIdProp : getActorId()
  /**
   * ★記録者（操作者）の選択は入力の条件にしない（2026-09-05 指示）。
   *   1台の端末を複数人が使うため、端末に1人を紐づける前提が実務に合わない。
   *   recorded_by は NULL 可の列で、未設定なら「誰が入れたか記録しない」だけになる。
   */
  const canInput = inputEnabled && flagChecked && !cellsMissing

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

  /** 同じ行への保存が交差しないよう、キーごとに直列化する（rev の追い越しを防ぐ） */
  const enqueue = useCallback((key: string, job: () => Promise<void>) => {
    const prev = chainRef.current.get(key) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(job).catch(() => undefined)
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
      // 取得できない間は入力させない（封鎖側に倒す）
      if (!gate.observed) setFlagError(ERR_FLAG)
    } catch {
      if (!aliveRef.current) return
      setInputEnabled(false)
      setFlagChecked(false)
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
  const load = useCallback(async () => {
    const gen = ++genRef.current
    setLoading(true)
    setError(null)
    try {
      const fromProps = residentsPropRef.current
      const [rs, chunk] = await Promise.all([
        fromProps ? Promise.resolve(fromProps) : fetchResidents(),
        fetchTimelineChunk(dayRef.current, dayRef.current, actorRef.current),
      ])
      if (gen !== genRef.current || !aliveRef.current) return

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
      commitUndo({})
      // 退避した水分がサーバーへ載ったかは、取り直した合計で1名ずつ確かめる（観測ベース）。
      // 「キュー全体が空か」で判断すると、無関係の未送信 op が残っている間ずっと概算が消えずに
      // 二重計上になり、逆に別要因でキューが空になった瞬間に未着の分が画面から消える。
      setQueuedFluids((prev) => {
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
      })
      setError(null)
    } catch {
      if (gen !== genRef.current || !aliveRef.current) return
      // 取得に失敗しても表示中のデータは消さない（安全側フォールバック）
      setError(ERR_LOAD)
    } finally {
      if (gen === genRef.current && aliveRef.current) setLoading(false)
    }
  }, [adoptStoreMeals, commitFluids, commitMeals, commitUndo, syncPendingAll])

  useEffect(() => {
    void load()
  }, [load])

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
      try {
        const res = await saveMealEdits(target, edits, {
          // 記入者は新しい行の時だけ「空いていれば埋める」（更新では編集列以外を送らない＝部分更新）
          ...(existing ? {} : { fill: { recorded_by: actorRef.current } }),
          rebase,
        })
        if (!aliveRef.current) return
        if (res === 'queued') {
          // 送信待ちにした値は、送信が済むまで表示に重ねて残す（指摘 M1）。送信待ちへ渡し終えた欄だけ
          // 編集から消す（R-D・欄単位）。送信待ちの後に押す値は送った内容が基準
          queuedRef.current[key] = { ...(queuedRef.current[key] ?? {}), ...send }
          writeEdits(key, settleSent(editsRef.current[key] ?? {}, edits, { ...shown, ...send }))
          setPhase(key, 'queued', MSG_QUEUED)
          return
        }
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

  /** 水分の加算（1タップ＝1件の記録）。取り消しはサーバー行を観測できた分だけ受け付ける */
  const onFluid = useCallback(
    (residentId: number, ml: number) => {
      if (!canInputRef.current) return
      touchActivity()
      enqueue(`fluid:${residentId}`, async () => {
        try {
          const res = await insertFluid({
            resident_id: residentId,
            taken_on: dayRef.current,
            taken_at: nowTimeHM(new Date()),
            amount_ml: ml,
            kind: null,
            recorded_by: actorRef.current,
          })
          if (!aliveRef.current) return
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
        try {
          const res = await softDeleteFluid(target.id, target.rev)
          if (!aliveRef.current) return
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
            showRef.current(`水分 ＋${target.ml}ml の取り消し：${MSG_QUEUED}`)
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
        try {
          const res = await saveMealEdits(
            { residentId, day: dayRef.current, slot: slotAt },
            edits,
            { rebase: true, asNew: true, fill: { recorded_by: actorRef.current } },
          )
          if (!aliveRef.current) return
          delete missingRef.current[key]
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
          Object.values(phasesRef.current).some((p) => p === 'conflict'),
      ),
    [],
  )

  /**
   * くらべて選ぶの送信（〔先の値を残す〕〔自分の値で直す〕〔両方残す〕）。通常の保存と同じ順番待ちに通す（指摘 L2）。
   * 送信待ちで止まっている値の取り下げ・送り直しは ConflictResolver が db.ts へ頼む
   */
  const runResolverJob = useCallback(
    (key: string, job: () => Promise<void>) =>
      new Promise<void>((resolve) => {
        enqueue(key, async () => {
          try {
            await job()
          } finally {
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
        <div className="flex flex-wrap items-center justify-between gap-gap">
          <h2 className="text-lg font-bold text-ink">{fmtDayLabel(day)} の食事・水分</h2>
          <button
            type="button"
            onClick={onReload}
            className="min-h-tap rounded border border-border-strong px-4 text-base text-ink"
          >
            最新を読み込む
          </button>
        </div>
        <div className="mt-3">
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
          <div className="mt-3">
            <span className="text-sm text-ink2">フロア</span>
            <div className="mt-1">
              <SegmentPicker
                options={floorOptions}
                value={floor}
                onChange={setFloor}
                ariaLabel="フロアを選ぶ"
              />
            </div>
          </div>
        ) : null}
      </SectionCard>

      {flagError ? <ErrorBlock message={flagError} onRetry={() => void loadFlag()} /> : null}

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
              return (
                <MealRow
                  key={r.id}
                  resident={r}
                  main={ov.main_amount !== undefined ? ov.main_amount : (row?.main_amount ?? null)}
                  side={ov.side_amount !== undefined ? ov.side_amount : (row?.side_amount ?? null)}
                  status={ov.status !== undefined ? ov.status : (row?.status ?? null)}
                  phase={phases[key] ?? 'idle'}
                  message={rowMsgs[key] ?? null}
                  fluidMl={fl?.ml ?? 0}
                  fluidCount={fl?.count ?? 0}
                  queuedMl={queuedFluids[r.id]?.ml ?? 0}
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

      {toast}
    </div>
  )
}
