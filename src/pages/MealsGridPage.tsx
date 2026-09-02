// 食事・水分の一括入力（記録ハブ →「食事一括」= 2タップ）。
// 契約: docs/design/contracts.md ／ 詳細: docs/design/ui-design.md §6・§0.5、db-design.md §5
//
// この画面が守る規律:
// - 取得は日付レンジ指定の fetchTimelineChunk（当日1日分）と fetchResidents のみ。全件ロード経路を作らない
// - 保存は upsert を使わない。既存行を把握していれば updateMeal(id, rev)、無ければ insertMeal（23505 の
//   読み直しは db.ts 側の責務）。update ペイロードは編集した列だけ（部分更新・空上書きをしない）
// - 競合（conflict）でも入力を消さない。表示中の値は残したまま「最新を読み込む」を促す
// - 送信できなかった分は db.ts の永続キューに退避され、この画面は「⚠未送信」と表示するだけ（消さない）
// - 入力解禁フラグ（native_input_enabled）はこの画面を開くたびに取り直す。取得できるまでは入力させない
// - 外出・外泊は「参考chip」の表示のみ。食事の状態（status）へ自動反映しない（ui-design §6【#6】）
// - 実名・記録本文をコード・コメント・localStorage・console に書かない（表示は実行時の props/取得値のみ）
// - Tailwind はトークン由来クラスのみ（色・px の直書き・arbitrary value を書かない）

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  DbError,
  fetchResidents,
  fetchTimelineChunk,
  getNativeInputGate,
  insertFluid,
  insertMeal,
  softDeleteFluid,
  updateMeal,
} from '../lib/db'
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
const NO_ACTOR_TEXT =
  '記録する職員が選ばれていないため入力できません。画面上部の職員チップから記録する職員を選んでください。'
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

// ── 純ロジック（副作用なし） ──────────────────────────────────

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
  onAmount: (residentId: number, field: 'main_amount' | 'side_amount', value: number) => void
  onStatus: (residentId: number, value: MealStatus) => void
  onFluid: (residentId: number, ml: number) => void
  onUndoFluid: (residentId: number) => void
  onReload: () => void
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
        <span className="min-w-0 flex-1 truncate text-base font-bold text-ink">
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
        onPick={(v) => onAmount(resident.id, 'main_amount', v)}
      />
      <AmountRow
        label="副食"
        groupLabel={`${resident.name} の副食の量（0〜10）`}
        value={side}
        onPick={(v) => onAmount(resident.id, 'side_amount', v)}
      />

      <div className="mt-3">
        <span className="text-sm text-ink2">食事の状態</span>
        <div className="mt-1">
          <SegmentPicker
            options={STATUS_OPTIONS}
            value={status ?? ''}
            onChange={(v) => onStatus(resident.id, v as MealStatus)}
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
            {phase === 'conflict' ? ERR_CONFLICT : (message ?? ERR_SAVE)}
          </p>
          {phase === 'conflict' ? (
            <button
              type="button"
              onClick={onReload}
              className="mt-2 min-h-tap rounded border border-primary px-4 text-base font-bold text-primary"
            >
              最新を読み込む
            </button>
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

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 入力解禁フラグは「確認できるまで false（封鎖側）」。安全側に倒す
  const [inputEnabled, setInputEnabled] = useState<boolean>(inputEnabledProp === true)
  const [flagChecked, setFlagChecked] = useState(false)
  const [flagError, setFlagError] = useState<string | null>(null)

  const { toast, show } = useToast()

  const actorId = actorIdProp !== undefined ? actorIdProp : getActorId()
  const canInput = inputEnabled && flagChecked && actorId != null

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
  // 親が毎レンダー新しい配列を渡しても取得が繰り返されないよう、取得処理からは ref 経由で読む
  const residentsPropRef = useRef<Resident[] | undefined>(residentsProp)
  const slotRef = useRef<MealSlot>(slot)
  const dayRef = useRef(day)
  const actorRef = useRef<number | null>(actorId)
  const canInputRef = useRef(canInput)
  const showRef = useRef(show)
  const saveMealRef = useRef<
    (residentId: number, patch: MealPatch, slotAt: MealSlot, isUndo?: boolean) => void
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
        nextMeals[mealKey(m.resident_id, m.meal_slot)] = m
      }
      commitMeals(nextMeals)
      const nextFluids = asArray<FluidIntake>(chunk?.fluids).filter(
        (f) => f != null && f.taken_on === dayRef.current && typeof f.amount_ml === 'number',
      )
      commitFluids(nextFluids)
      setOutings(asArray<Outing>(chunk?.outings).filter((o) => o != null))

      // 未送信・競合・失敗の行だけは控えを残す（原則4: 入力を消さない）。
      // 取り消し用の水分は、サーバーの最新を観測し直した時点で対象外にする。
      const keepPhases: Record<string, RowPhase> = {}
      const keepPending: Record<string, MealPatch> = {}
      const keepMsgs: Record<string, string> = {}
      for (const [k, p] of Object.entries(phasesRef.current)) {
        if (p !== 'conflict' && p !== 'error' && p !== 'queued') continue
        keepPhases[k] = p
        const ov = pendingRef.current[k]
        if (ov) keepPending[k] = ov
        const msg = msgsRef.current[k]
        if (msg) keepMsgs[k] = msg
      }
      phasesRef.current = keepPhases
      setPhases(keepPhases)
      msgsRef.current = keepMsgs
      setRowMsgs(keepMsgs)
      commitPending(keepPending)
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
  }, [commitFluids, commitMeals, commitPending, commitUndo])

  useEffect(() => {
    void load()
  }, [load])

  // App 側が利用者一覧を差し替えた場合は表示を合わせる
  useEffect(() => {
    if (!residentsProp) return
    setResidents(asArray<Resident>(residentsProp).filter((r) => r != null && r.active !== false))
  }, [residentsProp])

  /** 保存に成功した列だけ控えから外す（この間に指した別の値は残す） */
  const clearOverlay = useCallback(
    (key: string, written: MealPatch) => {
      const cur: MealPatch = { ...(pendingRef.current[key] ?? {}) }
      let changed = false
      for (const k of Object.keys(written) as (keyof MealPatch)[]) {
        if (k in cur && cur[k] === written[k]) {
          delete cur[k]
          changed = true
        }
      }
      if (!changed) return
      const next = { ...pendingRef.current }
      if (Object.keys(cur).length === 0) delete next[key]
      else next[key] = cur
      commitPending(next)
    },
    [commitPending],
  )

  /**
   * 食事1行の保存。既存行があれば部分更新、無ければ新規作成（upsert は使わない）。
   * 記録済みの値を上書きした時は Undo 付きトーストを出す（1タップ不可逆を作らない）。
   * slotAt は保存する食事枠。トーストの Undo を押すまでに枠を切り替えても、
   * 取り消しが別の枠へ当たらないよう呼び出し時点の枠を持ち回る。
   */
  const saveMeal = useCallback(
    (residentId: number, patch: MealPatch, slotAt: MealSlot, isUndo = false) => {
      if (!canInputRef.current) {
        if (isUndo) showRef.current('元に戻せませんでした。入力できない状態です。')
        return
      }
      touchActivity()
      const slotNow = slotAt
      const key = mealKey(residentId, slotNow)
      commitPending({ ...pendingRef.current, [key]: { ...(pendingRef.current[key] ?? {}), ...patch } })
      setPhase(key, 'saving')

      enqueue(key, async () => {
        const existing = mealsRef.current[key] ?? null
        // 新規作成のときだけ、控えに溜まっている他の列も一緒に書く
        const written: MealPatch = existing ? patch : { ...(pendingRef.current[key] ?? {}) }
        // 記録済みの値を消してしまう操作かどうか（＝Undo を出す対象か）を保存前に控える
        const before = overwrittenFrom(existing, patch)
        try {
          const res = existing
            ? await updateMeal(existing.id, existing.rev, patch)
            : await insertMeal({
                resident_id: residentId,
                meal_on: dayRef.current,
                meal_slot: slotNow,
                main_amount: written.main_amount ?? null,
                side_amount: written.side_amount ?? null,
                status: written.status ?? null,
                note: null,
                // 記入者は新規作成時のみ記録する（更新では編集列以外を送らない＝部分更新）
                recorded_by: actorRef.current,
              })
          if (!aliveRef.current) return
          if (res === 'conflict') {
            setPhase(key, 'conflict')
            return
          }
          if (res === 'queued') {
            setPhase(key, 'queued', MSG_QUEUED)
            return
          }
          commitMeals({ ...mealsRef.current, [key]: res })
          clearOverlay(key, written)
          setPhase(key, 'saved')
          if (isUndo) {
            showRef.current('元に戻しました。')
          } else if (Object.keys(before).length > 0) {
            // 元の値へ戻す保存を Undo に載せる（8秒）。取り消し自体は同じ保存経路を通す
            showRef.current(overwriteText(before, patch), () => {
              saveMealRef.current(residentId, before, slotNow, true)
            })
          }
        } catch (e) {
          if (!aliveRef.current) return
          setPhase(key, 'error', msgOf(e, ERR_SAVE))
        }
      })
    },
    [clearOverlay, commitMeals, commitPending, enqueue, setPhase],
  )

  // Undo から自分自身を呼ぶための参照（保存経路を1本に保つ）
  useEffect(() => {
    saveMealRef.current = saveMeal
  }, [saveMeal])

  const onAmount = useCallback(
    (residentId: number, field: 'main_amount' | 'side_amount', value: number) => {
      saveMeal(residentId, { [field]: value } as MealPatch, slotRef.current)
    },
    [saveMeal],
  )

  const onStatus = useCallback(
    (residentId: number, value: MealStatus) => {
      saveMeal(residentId, { status: value }, slotRef.current)
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
      ) : null}

      {!flagError && flagChecked && inputEnabled && actorId == null ? (
        <div role="status" className="rounded-lg border border-warn bg-warn-bg p-4">
          <p className="text-base text-ink">
            <span aria-hidden="true">▲ </span>
            {NO_ACTOR_TEXT}
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
                />
              )
            })}
          </ul>
        </fieldset>
      )}

      {toast}
    </div>
  )
}
