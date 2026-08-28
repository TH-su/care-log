// 食事一覧（現行スプシ「食事量」タブの再現）。横に複数日を並べ、右端に水分の日合計列を新設する。
// 契約: docs/design/sheet-contracts.md §7 ／ 既存契約 docs/design/contracts.md
//
// この画面が守る規律:
// - 取得は日付レンジ指定の fetchMealsSheet のみ（全件ロード経路を作らない）
// - 保存は upsert を使わない。既存行があれば updateMeal(id, rev)、無ければ insertMeal。
//   update ペイロードは編集した列だけ（部分更新・空上書きをしない）
// - 競合（conflict）でも入力を消さない。表示中の値は残したまま「最新を読み込む」を促す
// - 送信できなかった分は db.ts の永続キューに退避され、この画面は「⚠」と表示するだけ（消さない）
// - 入力解禁フラグ（native_input_enabled）はこの画面を開くたびに取り直す。取得できるまでは入力させない
// - 欠食（外出・入院・拒食）を選んでも主食・副食の記録値は消さない（表示だけ状態ラベルに切り替える）
// - 実名・記録本文をコード・コメント・localStorage・console に書かない（表示は実行時の取得値のみ）
// - Tailwind はトークン由来クラスのみ。シートの寸法は src/styles/sheet.css の CSS 変数を参照する
//   （arbitrary value・px 直書きを書かない）
// - localStorage に置くのは UI 状態のみ（表示日数・フロア）。日付は業務データに紐づくため保存しない

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from 'react'
import {
  DbError,
  fetchMealsSheet,
  fetchResidents,
  getNativeInputGate,
  insertFluid,
  insertMeal,
  softDeleteFluid,
  updateMeal,
} from '../lib/db'
import { getActorId, touchActivity } from '../lib/actor'
import { addDays, fmtDayLabel, fmtTimeHM, todayIso, toHalfWidth } from '../lib/format'
import { isLowIntake, LS, MEAL_SLOT_LABEL, MEAL_STATUS_LABEL, SHEET_DAYS } from '../lib/types'
import type { FluidIntake, Meal, MealSlot, MealStatus, Resident, SheetDays } from '../lib/types'
import {
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  SectionCard,
  SegmentPicker,
  useToast,
} from '../components/ui'
import { readSheetPref, SheetFrame, writeSheetPref, ZoomBar } from '../components/sheet'

// ── 定数 ─────────────────────────────────────────────────────

/** 1日分に並べる食事枠（スプシと同じ 朝・昼・夕。間食はこの表に出さない） */
const SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner']
/** 主食・副食の入力上限（現行スプシと同じ 0〜10） */
const AMOUNT_MAX = 10
/** 水分の加算チップ（ui-design §6・食事一括画面と同じ刻み） */
const FLUID_STEPS = [100, 150, 200] as const
/** 食事の状態4値（未選択＝喫食として扱う） */
const STATUSES: MealStatus[] = ['eaten', 'out', 'hospital', 'refused']
const STATUS_OPTIONS = STATUSES.map((s) => ({ value: s, label: MEAL_STATUS_LABEL[s] }))
const DAYS_OPTIONS = SHEET_DAYS.map((n) => ({ value: String(n), label: `${n}日` }))
/** 日数の既定（スプシ実測: 食事量タブは11日分が横に並ぶ） */
const DEFAULT_DAYS: SheetDays = 11
/** 居室が未設定の利用者を入れるフロア区分（誰も一覧から漏れないようにする） */
const FLOOR_OTHER = 'other'
/** フロア「全て」 */
const FLOOR_ALL = 'all'
/** 1日あたりの列数（朝主・朝副・昼主・昼副・夕主・夕副・水分） */
const COLS_PER_DAY = 7

/**
 * シートの寸法は sheet.css の CSS 変数を参照する（倍率 --sheet-zoom は変数側で解決済み）。
 * 水分列は現行スプシに無い新設列のため専用変数が無く、1食分（主＋副）と同じ幅で持つ。
 */
const W_ROOM = 'var(--w-room-m)'
const W_NAME = 'var(--w-name-m)'
const W_MEAL = 'var(--w-meal)'
const W_MEAL2 = 'calc(var(--w-meal) * 2)'
const W_FLUID = 'calc(var(--w-meal) * 2)'
const ROW_H = 'var(--sheet-row-h)'
const HEAD_H = 'var(--sheet-head-h)'
const HEAD_H2 = 'calc(var(--sheet-head-h) * 2)'
const SHEET_FONT = 'var(--sheet-font)'

/**
 * 自前で描くセルの基本クラス（SheetCell の td・VitalsSheetPage と同じ見た目に揃える）。
 * 表は border-collapse: separate（sheet.css の .sheet-table）なので、罫線は右・下だけに引く。
 * 全周に引くと隣のセルの罫線と並んで 2px になる。表の左端・上端は table 側の border で描く。
 */
const CELL_BASE = 'border-b border-r border-border p-0 align-middle'
/**
 * 日付ブロックの切れ目。**各日の「最後の列」（水分）の右罫線を濃くする**（sheet.css の .sheet-group-end）。
 * 最初の列に左罫線を足す方式は、左隣のセルの右罫線と並んで 2px になるため使わない
 * （色だけを当てる書き方は border-left-width が 0 のままで線にならない。VitalsSheetPage と同じ扱い）。
 */
const DAY_END = 'sheet-group-end'

/**
 * 食事枠ごとの文字色（朝＝赤・昼＝緑・夕＝黒。すべて太字）。
 * 色と太さの実体は sheet.css の .msheet-*（--msheet-c-* を参照＝ダークモード追従）。
 * 列見出し「朝・昼・夕」で区別が付くので色は補助（色だけで意味を伝えない）。
 */
const SLOT_TEXT: Record<MealSlot, string> = {
  breakfast: 'msheet-breakfast',
  lunch: 'msheet-lunch',
  dinner: 'msheet-dinner',
  snack: 'msheet-dinner',
}

/**
 * 日付見出しセルに当てる曜日の色（土＝濃い水色・日＝赤。sheet.css の .sheet-sat / .sheet-sun）。
 * 平日は空文字＝既定の見出し色のまま。曜日は日付文字「8/29（土）」にも出るので色は補助。
 * .sheet-sat / .sheet-sun は background と color を両方持つので、当てる側では
 * Tailwind の bg-surface2・text-ink を重ねない（同じ詳細度で打ち消し合わないようにする）。
 */
function weekdayToneClass(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dow = new Date(y, m - 1, d).getDay()
  if (dow === 6) return 'sheet-sat'
  if (dow === 0) return 'sheet-sun'
  return ''
}

/**
 * 1行おきの縞（白 ↔ 薄いグレー。sheet.css の .sheet-alt）。偶数行（2・4・6…行目）に付ける。
 * 縞は tr（行の器）に置く＝背景を持つセル（低摂取の bg-warn-bg・土日の見出し）は
 * 行より上に描かれるので、意味のある色が縞に負けない。
 * 左固定列（居室・入居者）は sticky で下の行が透けてはいけないため、セル自身にも当てる
 * （平日行の bg-surface とは排他。重ねると同じ詳細度で打ち消し合う）。
 */
function altClass(rowIndex: number): string {
  return rowIndex % 2 === 1 ? 'sheet-alt' : ''
}

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
  '保存できませんでした。入力は消えていません。通信状況を確認して、もう一度入力してください。'
const ERR_AMOUNT = `主食・副食は 0〜${AMOUNT_MAX} の数字で入力してください。入力はそのまま残しています。`
const MSG_QUEUED = '通信できないため送信待ちにしました。電波が戻ると自動で送信します。'
const ERR_FLUID_UNDO =
  '水分の追加を取り消せませんでした。通信状況を確認して、もう一度お試しください。'
const ERR_FLUID_UNDO_CONFLICT =
  '水分の追加を取り消せませんでした（ほかの端末で更新されています）。「最新を読み込む」で最新の値を確認してください。'
/**
 * 入力できない状態で Undo が押された時の案内。
 * 「何が起きたか」（前半）＋「次にどうすればよいか」（理由ごとの後半）で1文にする。
 * 理由の判定順は画面上部のバナーと同じ（読み込み中 → 期間の確認中 → 封鎖中 → 記録者未選択）。
 */
const ERR_UNDO_BLOCKED = '元に戻せませんでした。いまは入力できない状態です。'
const HINT_LOADING = '読み込みが終わるのを待ってから、もう一度お試しください。'
const HINT_FLAG_CHECKING =
  'アプリで入力してよい期間かの確認が終わるのを待ってから、もう一度お試しください。'
const HINT_BLOCKED = 'いまはスプレッドシートで記録する期間です（画面上部の案内をご確認ください）。'
const HINT_NO_ACTOR = '画面上部の職員チップから記録する職員を選んでから、もう一度お試しください。'
const HINT_OTHER = '画面上部の案内を確認してから、もう一度お試しください。'

// ── 型 ───────────────────────────────────────────────────────

type MealPatch = Partial<Pick<Meal, 'main_amount' | 'side_amount' | 'status'>>
type AmountField = 'main_amount' | 'side_amount'
type RowPhase = 'idle' | 'saving' | 'saved' | 'queued' | 'conflict' | 'error'

/** 保存先（利用者×日×食事枠）。Undo からも同じ経路で保存できるよう1つにまとめる */
interface SaveTarget {
  residentId: number
  day: string
  slot: MealSlot
}

/** 吹き出しを出す位置（画面座標。親セルの実測から毎回作り直す） */
interface AnchorPos {
  left: number
  top?: number
  bottom?: number
}

/** 保存できていない状態だけを記号で示す（色だけに頼らない。文言はトーストと通知バーが担う） */
const PHASE_MARK: Partial<Record<RowPhase, { mark: string; label: string; cls: string }>> = {
  queued: { mark: '⚠', label: '未送信', cls: 'text-warn' },
  conflict: { mark: '▲', label: '要再読込', cls: 'text-warn' },
  error: { mark: '▲', label: '未保存', cls: 'text-danger' },
}

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
 * 主食・副食の入力値の正規化。全角数字も受け、0〜AMOUNT_MAX の整数だけ通す。
 * 空文字は null（＝未入力に戻す）。解釈できない値・範囲外は 'invalid'。
 */
function parseAmount(raw: string): number | null | 'invalid' {
  const s = toHalfWidth(raw)
  if (s === '') return null
  if (!/^\d{1,2}$/.test(s)) return 'invalid'
  const n = Number(s)
  return n >= 0 && n <= AMOUNT_MAX ? n : 'invalid'
}

/** 'HH:MM'（端末ローカル時刻＝JST運用） */
function nowTimeHM(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function mealKey(residentId: number, day: string, slot: MealSlot): string {
  return `${residentId}|${day}|${slot}`
}

function fluidKey(residentId: number, day: string): string {
  return `${residentId}|${day}`
}

/** 表示用に「サーバー値＋未保存の控え」を重ねた1食分（判定は types.ts の isLowIntake に委ねる） */
function effectiveMeal(
  base: Meal | null,
  patch: MealPatch,
  residentId: number,
  day: string,
  slot: MealSlot,
): Meal {
  if (base) return { ...base, ...patch }
  return {
    id: 0,
    resident_id: residentId,
    meal_on: day,
    meal_slot: slot,
    main_amount: patch.main_amount ?? null,
    side_amount: patch.side_amount ?? null,
    status: patch.status ?? null,
    note: null,
    recorded_by: null,
    rev: 0,
  }
}

/**
 * 上書きされる列の「元の値」だけを取り出す（既にサーバーで観測できている値が対象）。
 * 新規入力（未入力→値）は取り消す対象にしない。
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
  if (before.main_amount != null) {
    parts.push(`主食を ${before.main_amount} から ${after.main_amount ?? '未入力'} に`)
  }
  if (before.side_amount != null) {
    parts.push(`副食を ${before.side_amount} から ${after.side_amount ?? '未入力'} に`)
  }
  if (before.status != null && after.status != null) {
    parts.push(
      `食事の状態を「${MEAL_STATUS_LABEL[before.status]}」から「${MEAL_STATUS_LABEL[after.status]}」に`,
    )
  }
  return `${parts.join('・')}変更しました。`
}

/** 1名1日分の水分合計（ml・サーバーで観測できた分だけ）。控えの消し込み判定に使う */
function serverFluidMl(rows: FluidIntake[], residentId: number, day: string): number {
  let sum = 0
  for (const f of rows) {
    if (f.resident_id !== residentId || f.taken_on !== day) continue
    if (Number.isFinite(f.amount_ml)) sum += f.amount_ml
  }
  return sum
}

// ── localStorage（UI状態のみ） ────────────────────────────────

/**
 * 既知値のホワイトリスト照合。壊れた値・未知値は既定へ倒す。
 * 保存はバイタル一覧と同じキーだが値は画面別に持つ（readSheetPref/writeSheetPref）。
 * 既定が違う（食事=11日/全・バイタル=4日/1階）ので、片方の変更をもう片方へ持ち込まない。
 */
function readDays(): SheetDays {
  const n = Number(readSheetPref(LS.sheetDays, 'meals'))
  if ((SHEET_DAYS as readonly number[]).includes(n)) return n as SheetDays
  return DEFAULT_DAYS
}

/**
 * 既定は「全」（食事量は全員分を一度に見る運用のため。バイタル一覧の既定＝1階とは意図的に違う）。
 * 選択肢の並び・ラベルは両画面で同じ（floorOptions を参照）。
 */
function readFloor(): string {
  const raw = readSheetPref(LS.sheetFloor, 'meals')
  // 実在するフロアかどうかは一覧を取得してから照合する（ここでは形だけ確かめる）
  if (raw && /^(\d|all|other)$/.test(raw)) return raw
  return FLOOR_ALL
}

function writeLs(key: string, value: string): void {
  writeSheetPref(key, 'meals', value)
}

// ── 吹き出し（セルに紐づく小さなパネル） ──────────────────────

/** パネルの幅。見た目は Tailwind の w-64（16rem）で与え、この数値は画面端の丸め計算にだけ使う */
const POPOVER_W = 256
/** 下に出すか上に出すかを決めるときの想定高さ */
const POPOVER_H = 220
/** セルとパネルの間隔（8px グリッド＝--sp-2 と同値） */
const POPOVER_GAP = 8

interface CellPopoverProps {
  label: string
  onClose: () => void
  children: ReactNode
}

/**
 * セルの直下に出す非モーダルの吹き出し。
 * - DOM 上はセル（td）の中に置くので、セル内の入力欄から Tab でそのまま中身へ入れる
 * - position: fixed で表の横スクロール枠に切り取られないようにし、位置は親セルの実測から出す
 *   （スクロール・リサイズでは閉じずに追従する。入力中に画面が動いても編集が中断しない）
 * - Esc と枠外タップで閉じる
 * - mousedown の既定動作を止めて、入力中のセルからフォーカスが外れないようにする
 */
function CellPopover({ label, onClose, children }: CellPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<AnchorPos | null>(null)

  // 親セルの現在位置から吹き出しの位置を出す（開いた時点の座標を持ち回らない＝ずれない）
  const place = useCallback(() => {
    const cell = ref.current?.parentElement
    if (!cell) return
    const r = cell.getBoundingClientRect()
    const maxLeft = Math.max(POPOVER_GAP, window.innerWidth - POPOVER_W - POPOVER_GAP)
    const left = Math.min(Math.max(POPOVER_GAP, r.left), maxLeft)
    // 画面下に入りきらない時はセルの上へ回す
    const openUp = r.bottom + POPOVER_H > window.innerHeight && r.top > POPOVER_H
    setPos(
      openUp
        ? { left, bottom: window.innerHeight - r.top + POPOVER_GAP }
        : { left, top: r.bottom + POPOVER_GAP },
    )
  }, [])

  useLayoutEffect(() => {
    place()
  }, [place])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onPointer = (e: PointerEvent) => {
      const el = ref.current
      if (!el) return
      const t = e.target
      // 吹き出しの中と、吹き出しを抱えているセルの中は「外側」とみなさない
      if (t instanceof Node && (el.contains(t) || el.parentElement?.contains(t))) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [onClose, place])

  // 位置が決まるまでは描画しない（一瞬だけ左上に出るのを防ぐ）
  const style: CSSProperties = pos
    ? { position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom }
    : { position: 'fixed', left: 0, top: 0, visibility: 'hidden' }

  return (
    <div
      ref={ref}
      data-cell-popover=""
      role="group"
      aria-label={label}
      style={style}
      onMouseDown={(e) => e.preventDefault()}
      className="z-40 w-64 rounded-lg border border-border-strong bg-surface p-3 text-base text-ink"
    >
      {children}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="min-h-tap rounded border border-border-strong px-4 text-base text-ink"
        >
          閉じる
        </button>
      </div>
    </div>
  )
}

// ── 主食・副食の半セル ───────────────────────────────────────

interface AmountHalfProps {
  width: string
  /** 主食側にだけ縦の区切り線を引く（1食＝2セルの見た目を保つ） */
  divider?: boolean
  value: number | null
  disabled: boolean
  toneClass: string
  editing: boolean
  editText: string
  editInvalid: boolean
  inputRef: RefObject<HTMLInputElement>
  /**
   * 非編集時のボタンを親へ預ける。
   * 編集を閉じると input は unmount されるので、確定・取消のあとに
   * このボタンへフォーカスを戻す（戻さないと毎回ドキュメント先頭からタブし直しになる）。
   */
  buttonRef: (el: HTMLButtonElement | null) => void
  /** 低摂取の記号を出す（背景色だけに頼らない） */
  lowMark?: boolean
  /** 保存できていない状態の記号 */
  phaseMark?: { mark: string; label: string; cls: string }
  ariaLabel: string
  onOpen: () => void
  onText: (v: string) => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void
  onBlur: (e: ReactFocusEvent<HTMLInputElement>) => void
}

/**
 * 1セル分の主食／副食。タップでその場が数値入力欄に変わる（キーパッドは出さない）。
 * 行の高さはスプシ実測 22px 固定のため 44px のタップ領域は確保できない。
 * 代わりにセル全面を当たり判定にし、拡大は操作バーの倍率切替（ZoomBar）で行う
 * （sheet-contracts §4 の但し書き。読み上げは aria-label で担保する）。
 */
function AmountHalf({
  width,
  divider = false,
  value,
  disabled,
  toneClass,
  editing,
  editText,
  editInvalid,
  inputRef,
  buttonRef,
  lowMark = false,
  phaseMark,
  ariaLabel,
  onOpen,
  onText,
  onKeyDown,
  onBlur,
}: AmountHalfProps) {
  const box = `${divider ? 'border-r border-border' : ''} h-full text-center`
  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={editText}
        aria-label={ariaLabel}
        aria-invalid={editInvalid}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        style={{ width, minWidth: width }}
        className={`${box} tabular bg-surface text-ink`}
      />
    )
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={onOpen}
      // minHeight は tokens.css の既定（44px）を打ち消すために必ず当てる。
      // 当てないと 22px 行が 44px に広がり、スプシの密度（--sheet-row-h）が再現できない
      // （当たり判定は ::before で下方向へ広げる。詰まった行で 44px に届かない分は表示倍率 200% で解決する）
      style={{ width, minWidth: width, minHeight: ROW_H }}
      className={`${box} tabular bg-transparent ${toneClass} disabled:opacity-60`}
    >
      {/* 記号は sheet-mark（数字用フォント＝半角幅・0.85em）で描く。
          和文フォントのままだと全角幅になり、30px の主食・副食列（--w-meal）から
          はみ出して折り返す＝22px 行の密度が崩れるため（SheetCell と同じ扱い） */}
      {phaseMark ? (
        <span className={`sheet-mark ${phaseMark.cls}`} aria-hidden="true">
          {phaseMark.mark}
        </span>
      ) : null}
      {value == null ? '' : value}
      {lowMark ? (
        <span className="sheet-mark text-warn" aria-hidden="true">
          ▲
        </span>
      ) : null}
    </button>
  )
}

// ── 画面本体 ─────────────────────────────────────────────────

export interface MealsSheetPageProps {
  /** App.tsx が保持していれば渡す（未指定ならこの画面が fetchResidents で取得する） */
  residents?: Resident[]
  /** 操作者（記入者）の staff_id。未指定なら actor.ts の保持値を使う */
  actorId?: number | null
  /** 入力解禁フラグの初期値。渡されてもこの画面を開くたびに取り直す（ui-design §0.5） */
  inputEnabled?: boolean
}

interface EditTarget extends SaveTarget {
  key: string
  field: AmountField
}

interface FluidTarget {
  key: string
  residentId: number
  day: string
}

export function MealsSheetPage({
  residents: residentsProp,
  actorId: actorIdProp,
  inputEnabled: inputEnabledProp,
}: MealsSheetPageProps = {}) {
  // ── 表示条件（UI状態） ──
  const [days, setDays] = useState<SheetDays>(() => readDays())
  const [floor, setFloor] = useState<string>(() => readFloor())
  /** 表示期間の右端＝いちばん新しい日。日付は業務データに紐づくため保存しない（既定は当日） */
  const [endIso, setEndIso] = useState<string>(() => todayIso())

  const [residents, setResidents] = useState<Resident[]>(() => asArray<Resident>(residentsProp))
  const [meals, setMeals] = useState<Record<string, Meal>>({})
  const [fluids, setFluids] = useState<FluidIntake[]>([])
  /** 保存前・保存中・未送信の値（サーバー観測値に優先して表示する。入力を消さないための控え） */
  const [pending, setPending] = useState<Record<string, MealPatch>>({})
  const [phases, setPhases] = useState<Record<string, RowPhase>>({})
  /** 直近の保存失敗の理由（表の上に1本だけ出す。どのセルかは各セルの記号で示す） */
  const [saveError, setSaveError] = useState<string | null>(null)
  /** 取り消せる直前の水分（このセッションで追加し、サーバー行を観測できたものだけ） */
  const [undoFluids, setUndoFluids] = useState<
    Record<string, { id: number; rev: number; ml: number }>
  >({})
  /**
   * 未送信のまま退避した水分（表示合計に反映するための概算）。
   * base = 退避した時点でサーバーに観測できていた合計。取り直した合計との差で「載った分」を
   * 1名1日ずつ消し込む（キュー全体の件数では判定しない＝観測ベース・multi-device-sync 原則6）。
   */
  const [queuedFluids, setQueuedFluids] = useState<Record<string, { base: number; ml: number }>>({})

  const [edit, setEdit] = useState<EditTarget | null>(null)
  const [editText, setEditText] = useState('')
  const [editInvalid, setEditInvalid] = useState(false)
  const [fluidTarget, setFluidTarget] = useState<FluidTarget | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 入力解禁フラグは「確認できるまで false（封鎖側）」。安全側に倒す
  const [inputEnabled, setInputEnabled] = useState<boolean>(inputEnabledProp === true)
  const [flagChecked, setFlagChecked] = useState(false)
  const [flagError, setFlagError] = useState<string | null>(null)

  const { toast, show } = useToast()

  const actorId = actorIdProp !== undefined ? actorIdProp : getActorId()
  // 読み込み中は入力させない。期間を送ると表の中身は総入れ替えになり、取得が終わるまで
  // 全セルが空欄で描かれる＝「この期間は記録なし」と読み違えたうえでの再入力を招くため
  const canInput = inputEnabled && flagChecked && actorId != null && !loading

  const today = todayIso()
  /** 表示する日（新しい日が左。バイタル一覧と並びを揃える） */
  const dayList = useMemo(() => {
    const out: string[] = []
    for (let i = 0; i < days; i += 1) out.push(addDays(endIso, -i))
    return out
  }, [days, endIso])
  const fromIso = dayList.length > 0 ? dayList[dayList.length - 1] : endIso
  const toIso = endIso

  // 保存処理から読む最新値（setState の反映を待たずに直列処理で使う）
  const aliveRef = useRef(true)
  const genRef = useRef(0)
  const chainRef = useRef(new Map<string, Promise<void>>())
  const mealsRef = useRef<Record<string, Meal>>({})
  const pendingRef = useRef<Record<string, MealPatch>>({})
  const fluidsRef = useRef<FluidIntake[]>([])
  const undoRef = useRef<Record<string, { id: number; rev: number; ml: number }>>({})
  const phasesRef = useRef<Record<string, RowPhase>>({})
  const canInputRef = useRef(canInput)
  const actorRef = useRef<number | null>(actorId)
  const showRef = useRef(show)
  // 親が毎レンダー新しい配列を渡しても取得が繰り返されないよう、取得処理からは ref 経由で読む
  const residentsPropRef = useRef<Resident[] | undefined>(residentsProp)
  const saveMealRef = useRef<(t: SaveTarget, patch: MealPatch, isUndo?: boolean) => void>(
    () => undefined,
  )
  const editInputRef = useRef<HTMLInputElement>(null)
  /** セルのボタン（フォーカスを戻す先）。編集中は unmount されるので閉じてから戻す */
  const cellBtnRef = useRef(new Map<string, HTMLButtonElement>())
  /** セルごとの ref コールバック（毎レンダー作り直すと ref が付け外しされるため使い回す） */
  const btnRefCbRef = useRef(new Map<string, (el: HTMLButtonElement | null) => void>())
  /** 閉じたあとにフォーカスを戻す先。確定・取消のときだけ入れる（Tab で抜けた時は戻さない） */
  const refocusRef = useRef<string | null>(null)
  const editRef = useRef<EditTarget | null>(null)
  const fluidTargetRef = useRef<FluidTarget | null>(null)
  /** 入力できない理由に応じた「次にどうすればよいか」（保存処理から同期で読む） */
  const blockedHintRef = useRef<string>(HINT_OTHER)

  useEffect(() => {
    canInputRef.current = canInput
    actorRef.current = actorId
    showRef.current = show
    residentsPropRef.current = residentsProp
    editRef.current = edit
    fluidTargetRef.current = fluidTarget
    blockedHintRef.current = loading
      ? HINT_LOADING
      : !flagChecked
        ? HINT_FLAG_CHECKING
        : !inputEnabled
          ? HINT_BLOCKED
          : actorId == null
            ? HINT_NO_ACTOR
            : HINT_OTHER
  })

  /** キーごとに同じ関数を返す ref コールバック（SheetCell の btnRef と同じ役割） */
  const btnRefFor = useCallback((key: string) => {
    let fn = btnRefCbRef.current.get(key)
    if (!fn) {
      fn = (el: HTMLButtonElement | null) => {
        if (el) cellBtnRef.current.set(key, el)
        else cellBtnRef.current.delete(key)
      }
      btnRefCbRef.current.set(key, fn)
    }
    return fn
  }, [])

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
  const commitUndo = useCallback((next: Record<string, { id: number; rev: number; ml: number }>) => {
    undoRef.current = next
    setUndoFluids(next)
  }, [])

  const setPhase = useCallback((key: string, phase: RowPhase) => {
    const next = { ...phasesRef.current, [key]: phase }
    phasesRef.current = next
    setPhases(next)
  }, [])

  /**
   * 保存できていないセルが1つも残っていなければ、表の上の警告バーを下ろす。
   * 入力し直して保存できたのに「保存できませんでした」が出たままだと、
   * 直ったのかどうかが画面から判断できないため（記号▲/⚠ はセル単位で残る）。
   */
  const clearSaveErrorIfSettled = useCallback(() => {
    const stuck = Object.values(phasesRef.current).some(
      (p) => p === 'conflict' || p === 'error' || p === 'queued',
    )
    if (!stuck) setSaveError(null)
  }, [])

  /** 同じセルへの保存が交差しないよう、キーごとに直列化する（rev の追い越しを防ぐ） */
  const enqueue = useCallback((key: string, job: () => Promise<void>) => {
    const prev = chainRef.current.get(key) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined)
      .then(job)
      .catch(() => undefined)
    chainRef.current.set(key, next)
  }, [])

  // ── 入力解禁フラグ（この画面を開くたびに取り直す） ──
  // 「false を観測した（＝スプシ期間）」と「観測できなかった（＝通信エラー）」は別物として扱う。
  const loadFlag = useCallback(async () => {
    setFlagError(null)
    try {
      const gate = await getNativeInputGate()
      if (!aliveRef.current) return
      setInputEnabled(gate.value === true)
      setFlagChecked(gate.observed)
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

  // ── 期間分の取得（利用者・食事・水分） ──
  const load = useCallback(async () => {
    const gen = ++genRef.current
    setLoading(true)
    setError(null)
    try {
      const fromProps = residentsPropRef.current
      const [rs, sheet] = await Promise.all([
        fromProps ? Promise.resolve(fromProps) : fetchResidents(),
        fetchMealsSheet(fromIso, toIso),
      ])
      if (gen !== genRef.current || !aliveRef.current) return

      setResidents(asArray<Resident>(rs).filter((r) => r != null && r.active !== false))

      const nextMeals: Record<string, Meal> = {}
      for (const m of asArray<Meal>(sheet?.meals)) {
        if (!m || typeof m.meal_on !== 'string') continue
        if (!SLOTS.includes(m.meal_slot)) continue
        nextMeals[mealKey(m.resident_id, m.meal_on, m.meal_slot)] = m
      }
      commitMeals(nextMeals)

      const nextFluids = asArray<FluidIntake>(sheet?.fluids).filter(
        (f) => f != null && typeof f.taken_on === 'string' && typeof f.amount_ml === 'number',
      )
      commitFluids(nextFluids)

      // 未送信・競合・失敗・**保存の応答待ち**のセルは控えを残す（原則4: 入力を消さない）。
      // 応答待ちを外すと、読み込み直後に競合・失敗で返ってきた時に「入力は消えていません」と
      // 案内しているのに控えが無い＝実際には入力が消える。応答が返れば clearOverlay が消し込む
      const keepPhases: Record<string, RowPhase> = {}
      const keepPending: Record<string, MealPatch> = {}
      for (const [k, p] of Object.entries(phasesRef.current)) {
        if (p !== 'conflict' && p !== 'error' && p !== 'queued' && p !== 'saving') continue
        keepPhases[k] = p
        const ov = pendingRef.current[k]
        if (ov) keepPending[k] = ov
      }
      phasesRef.current = keepPhases
      setPhases(keepPhases)
      commitPending(keepPending)
      commitUndo({})
      if (Object.keys(keepPhases).length === 0) setSaveError(null)

      // 退避した水分がサーバーへ載ったかは、取り直した合計で1名1日ずつ確かめる（観測ベース）
      setQueuedFluids((prev) => {
        const next: Record<string, { base: number; ml: number }> = {}
        for (const [key, held] of Object.entries(prev)) {
          const [ridRaw, day] = key.split('|')
          const rid = Number(ridRaw)
          if (!Number.isFinite(rid) || !day) continue
          const now = serverFluidMl(nextFluids, rid, day)
          // 載ったと観測できた分だけ減らす（まだ載っていない分は消さない）
          const remain = held.ml - (now - held.base)
          if (remain > 0) next[key] = { base: now, ml: remain }
        }
        return next
      })
      setError(null)
    } catch (e) {
      if (gen !== genRef.current || !aliveRef.current) return
      // 取得に失敗しても表示中のデータは消さない（安全側フォールバック）。
      // db.ts の DbError は「何が起きたか＋次にどうすればよいか」を持っている
      // （例: 日数が多すぎて読み切れなかった＝再試行を繰り返しても成功しない）ので、
      // 通信エラーの定型文で塗り潰さない
      setError(msgOf(e, ERR_LOAD))
    } finally {
      if (gen === genRef.current && aliveRef.current) setLoading(false)
    }
  }, [commitFluids, commitMeals, commitPending, commitUndo, fromIso, toIso])

  useEffect(() => {
    void load()
  }, [load])

  // App 側が利用者一覧を差し替えた場合は表示を合わせる
  useEffect(() => {
    if (!residentsProp) return
    setResidents(asArray<Resident>(residentsProp).filter((r) => r != null && r.active !== false))
  }, [residentsProp])

  /** 保存に成功した列だけ控えから外す（この間に入れた別の値は残す） */
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
   * 1食分の保存。既存行があれば部分更新、無ければ新規作成（upsert は使わない）。
   * 記録済みの値を上書きした時は Undo 付きトーストを出す（1タップ不可逆を作らない）。
   */
  const saveMeal = useCallback(
    (t: SaveTarget, patch: MealPatch, isUndo = false) => {
      if (!canInputRef.current) {
        if (isUndo) showRef.current(`${ERR_UNDO_BLOCKED}${blockedHintRef.current}`)
        return
      }
      touchActivity()
      const key = mealKey(t.residentId, t.day, t.slot)
      commitPending({
        ...pendingRef.current,
        [key]: { ...(pendingRef.current[key] ?? {}), ...patch },
      })
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
                resident_id: t.residentId,
                meal_on: t.day,
                meal_slot: t.slot,
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
            setSaveError(ERR_CONFLICT)
            return
          }
          if (res === 'queued') {
            setPhase(key, 'queued')
            setSaveError(MSG_QUEUED)
            return
          }
          commitMeals({ ...mealsRef.current, [key]: res })
          clearOverlay(key, written)
          setPhase(key, 'saved')
          clearSaveErrorIfSettled()
          if (isUndo) {
            showRef.current('元に戻しました。')
          } else if (Object.keys(before).length > 0) {
            // 元の値へ戻す保存を Undo に載せる（8秒）。取り消し自体は同じ保存経路を通す
            showRef.current(overwriteText(before, patch), () => {
              saveMealRef.current(t, before, true)
            })
          }
        } catch (e) {
          if (!aliveRef.current) return
          setPhase(key, 'error')
          setSaveError(msgOf(e, ERR_SAVE))
        }
      })
    },
    [clearOverlay, clearSaveErrorIfSettled, commitMeals, commitPending, enqueue, setPhase],
  )

  // Undo から自分自身を呼ぶための参照（保存経路を1本に保つ）
  useEffect(() => {
    saveMealRef.current = saveMeal
  }, [saveMeal])

  /** 水分の加算（1タップ＝1件の記録）。取り消しはサーバー行を観測できた分だけ受け付ける */
  const addFluid = useCallback(
    (residentId: number, day: string, ml: number) => {
      if (!canInputRef.current) return
      touchActivity()
      const key = fluidKey(residentId, day)
      enqueue(`fluid:${key}`, async () => {
        try {
          const res = await insertFluid({
            resident_id: residentId,
            taken_on: day,
            // 過去日にさかのぼって記録する場合、端末の現在時刻は実際の時刻ではないので入れない
            taken_at: day === todayIso() ? nowTimeHM(new Date()) : null,
            amount_ml: ml,
            kind: null,
            recorded_by: actorRef.current,
          })
          if (!aliveRef.current) return
          if (res === 'queued') {
            setQueuedFluids((prev) => {
              const held = prev[key]
              // base は最初に退避した時点のサーバー合計を保つ（重ねて退避しても基準をずらさない）
              const base = held ? held.base : serverFluidMl(fluidsRef.current, residentId, day)
              return { ...prev, [key]: { base, ml: (held?.ml ?? 0) + ml } }
            })
            showRef.current(`水分 ＋${ml}ml：${MSG_QUEUED}`)
            return
          }
          commitFluids([...fluidsRef.current, res])
          commitUndo({ ...undoRef.current, [key]: { id: res.id, rev: res.rev, ml } })
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
  const undoFluid = useCallback(
    (residentId: number, day: string) => {
      const key = fluidKey(residentId, day)
      const target = undoRef.current[key]
      if (!target) return
      touchActivity()
      enqueue(`fluid:${key}`, async () => {
        try {
          const res = await softDeleteFluid(target.id, target.rev)
          if (!aliveRef.current) return
          if (res === 'conflict') {
            showRef.current(ERR_FLUID_UNDO_CONFLICT)
            return
          }
          commitFluids(fluidsRef.current.filter((f) => f.id !== target.id))
          const nextUndo = { ...undoRef.current }
          delete nextUndo[key]
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

  /**
   * セルの入力を閉じる。
   * refocus=true（確定・取消）のときは、閉じたあとに元のセルのボタンへフォーカスを戻す。
   * 戻さないとフォーカスが body へ落ち、キーボード・スクリーンリーダーでは
   * 1セル入力するたびに先頭からタブし直すことになる（SheetCell の refocusRef と同じ作法）。
   */
  const closeEdit = useCallback((refocus = false) => {
    const cur = editRef.current
    if (refocus && cur) refocusRef.current = `${cur.key}|${cur.field}`
    setEdit(null)
    setEditInvalid(false)
    setEditText('')
  }, [])

  /** 水分の吹き出しを閉じる（同じくフォーカスをセルへ戻す） */
  const closeFluid = useCallback((refocus = false) => {
    const cur = fluidTargetRef.current
    if (refocus && cur) refocusRef.current = `f|${cur.key}`
    setFluidTarget(null)
  }, [])

  const onReload = useCallback(() => {
    closeEdit()
    setFluidTarget(null)
    void load()
  }, [closeEdit, load])

  // ── 表示条件の操作 ──

  const onChangeDays = useCallback(
    (v: string) => {
      const n = Number(v)
      if (!(SHEET_DAYS as readonly number[]).includes(n)) return
      closeEdit()
      setFluidTarget(null)
      setDays(n as SheetDays)
      writeLs(LS.sheetDays, String(n))
    },
    [closeEdit],
  )

  const onChangeFloor = useCallback(
    (v: string) => {
      closeEdit()
      setFluidTarget(null)
      setFloor(v)
      writeLs(LS.sheetFloor, v)
    },
    [closeEdit],
  )

  const shiftPeriod = useCallback(
    (dir: -1 | 1) => {
      closeEdit()
      setFluidTarget(null)
      setEndIso((cur) => {
        const next = addDays(cur, dir * days)
        // 未来へは行かせない（当日より先の記録は作らない）
        return next > today ? today : next
      })
    },
    [closeEdit, days, today],
  )

  // ── 表示用の組み立て ──

  /**
   * 一覧に実在する階だけを選択肢にする（居室未設定の利用者も必ずどこかに出る）。
   * 並びとラベルは契約 §6 とバイタル一覧に合わせる（階の昇順 → 居室未設定 → 全）。
   * タブを行き来しても同じボタンが同じ位置にあるようにするため、ここだけ独自の並びにしない。
   */
  const floorOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of residents) set.add(floorOf(r.room))
    const opts = Array.from(set)
      .filter((v) => v !== FLOOR_OTHER)
      .sort()
      .map((f) => ({ value: f, label: `${f}階` }))
    if (set.has(FLOOR_OTHER)) opts.push({ value: FLOOR_OTHER, label: '居室未設定' })
    opts.push({ value: FLOOR_ALL, label: '全' })
    return opts
  }, [residents])

  // 保存されていた選択が一覧に無ければ「全て」へ倒す（壊れた値で空表示にしない）
  useEffect(() => {
    if (residents.length === 0) return
    if (floorOptions.some((o) => o.value === floor)) return
    setFloor(FLOOR_ALL)
  }, [floorOptions, floor, residents.length])

  /** 表示対象（選択中の階・居室昇順） */
  const visible = useMemo(() => {
    return residents
      .filter((r) => floor === FLOOR_ALL || floorOf(r.room) === floor)
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

  /** 1名1日ごとの水分（合計・内訳）。内訳は時刻昇順で並べる */
  const fluidMap = useMemo(() => {
    const map = new Map<string, { ml: number; rows: FluidIntake[] }>()
    for (const f of fluids) {
      const key = fluidKey(f.resident_id, f.taken_on)
      const cur = map.get(key) ?? { ml: 0, rows: [] }
      cur.ml += Number.isFinite(f.amount_ml) ? f.amount_ml : 0
      cur.rows.push(f)
      map.set(key, cur)
    }
    for (const v of map.values()) {
      v.rows.sort((a, b) => (a.taken_at ?? '').localeCompare(b.taken_at ?? '') || a.id - b.id)
    }
    return map
  }, [fluids])

  // ── セル操作 ──

  const openAmount = useCallback(
    (t: SaveTarget, field: AmountField, value: number | null) => {
      if (!canInput) return
      setFluidTarget(null)
      setEditInvalid(false)
      setEditText(value == null ? '' : String(value))
      setEdit({
        key: mealKey(t.residentId, t.day, t.slot),
        residentId: t.residentId,
        day: t.day,
        slot: t.slot,
        field,
      })
    },
    [canInput],
  )

  /** 入力中の数値を確定する。解釈できない値はセルを開いたまま案内する（入力を捨てない） */
  const commitAmount = useCallback((): boolean => {
    if (!edit) return true
    const parsed = parseAmount(editText)
    if (parsed === 'invalid') {
      setEditInvalid(true)
      showRef.current(ERR_AMOUNT)
      return false
    }
    const cur = mealsRef.current[edit.key] ?? null
    const ov = pendingRef.current[edit.key] ?? {}
    const phase = phasesRef.current[edit.key] ?? 'idle'
    // 保存が終わっていないセル（競合・失敗）は、同じ値を入れ直した時も必ず保存し直す。
    // 画面に出ている値は「まだ保存できていない控え」なので、これを比較の相手にすると
    // 案内どおり入力し直しても「変化なし」と見なされ、保存が呼ばれないまま無言で残る
    // （VitalsSheetPage.saveOne が差分の基準をサーバー観測値 rec.saved に取り直しているのと同じ考え方）。
    // 送信待ち（queued）はキューが自動で送るため対象外（同じ内容の二重送信を作らない）
    const retry = phase === 'conflict' || phase === 'error'
    const shown = ov[edit.field] !== undefined ? ov[edit.field] : (cur?.[edit.field] ?? null)
    if (retry || shown !== parsed) {
      saveMeal(
        { residentId: edit.residentId, day: edit.day, slot: edit.slot },
        { [edit.field]: parsed } as MealPatch,
      )
    }
    return true
  }, [edit, editText, saveMeal])

  /** 確定してから閉じる（枠外タップ・フォーカス移動の共通処理） */
  const commitAndClose = useCallback(
    (refocus = false) => {
      if (commitAmount()) closeEdit(refocus)
    },
    [closeEdit, commitAmount],
  )

  const onEditKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        // 確定はセルへフォーカスを戻す（続けて隣のセルへタブで移れるようにする）
        commitAndClose(true)
        return
      }
      if (e.key === 'Escape') {
        // Esc は取り消し。吹き出し側の Esc 処理（＝確定して閉じる）へ流さない
        e.preventDefault()
        e.stopPropagation()
        closeEdit(true)
      }
    },
    [closeEdit, commitAndClose],
  )

  /** フォーカスが吹き出しの中へ移った時は、値だけ確定して吹き出しは開いたままにする */
  const onEditBlur = useCallback(
    (e: ReactFocusEvent<HTMLInputElement>) => {
      const to = e.relatedTarget
      if (to instanceof HTMLElement && to.closest('[data-cell-popover]')) {
        commitAmount()
        return
      }
      commitAndClose()
    },
    [commitAmount, commitAndClose],
  )

  const openFluid = useCallback(
    (residentId: number, day: string) => {
      closeEdit()
      setFluidTarget({ key: fluidKey(residentId, day), residentId, day })
    },
    [closeEdit],
  )

  // 入力欄が開いたらフォーカスを移す（タップした位置でそのまま打てるようにする）。
  // 閉じた時は、確定・取消のときだけ元のセルのボタンへ戻す（Tab で抜けた時は戻さない）
  useEffect(() => {
    if (edit) {
      editInputRef.current?.focus()
      return
    }
    const back = refocusRef.current
    if (back === null) return
    refocusRef.current = null
    cellBtnRef.current.get(back)?.focus()
  }, [edit, fluidTarget])

  const showLoading = loading && residents.length === 0
  const showEmpty = !loading && residents.length === 0

  // ── 描画 ──

  return (
    <div className="flex flex-col gap-gap p-4">
      <SectionCard>
        <div className="flex flex-wrap items-center justify-between gap-gap">
          <h2 className="text-lg font-bold text-ink">食事量（一覧）</h2>
          <button
            type="button"
            onClick={onReload}
            className="min-h-tap rounded border border-border-strong px-4 text-base text-ink"
          >
            最新を読み込む
          </button>
        </div>

        {/* 読み込み中の常設案内（表は残したまま知らせる）。
            期間を送ると取得が終わるまで全セルが空欄になるので、
            「記録なし」と読み違えないよう理由と状態を出す（この間は入力できない） */}
        <p role="status" aria-live="polite" className="mt-1 text-base text-ink2">
          {loading ? '↻ 読み込み中です。表示がそろうまでお待ちください（この間は入力できません）' : ''}
        </p>

        <div className="mt-3">
          <span className="text-sm text-ink2">フロア</span>
          <div className="mt-1">
            <SegmentPicker
              options={floorOptions}
              value={floor}
              onChange={onChangeFloor}
              ariaLabel="フロアを選ぶ"
            />
          </div>
        </div>

        <div className="mt-3">
          <span className="text-sm text-ink2">横に並べる日数</span>
          <div className="mt-1">
            <SegmentPicker
              options={DAYS_OPTIONS}
              value={String(days)}
              onChange={onChangeDays}
              ariaLabel="横に並べる日数を選ぶ"
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-gap">
          {/* 読み込み中の連打は、空欄のまま期間だけ進む＝取り違えのもとになるので止める */}
          <button
            type="button"
            aria-label={`前の${days}日分を表示`}
            disabled={loading}
            onClick={() => shiftPeriod(-1)}
            className="min-h-tap min-w-tap rounded border border-border-strong text-base text-ink disabled:opacity-60"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <span className="tabular text-base text-ink">
            {fmtDayLabel(fromIso)} 〜 {fmtDayLabel(toIso)}
          </span>
          <button
            type="button"
            aria-label={`次の${days}日分を表示`}
            disabled={toIso >= today || loading}
            onClick={() => shiftPeriod(1)}
            className="min-h-tap min-w-tap rounded border border-border-strong text-base text-ink disabled:opacity-60"
          >
            <span aria-hidden="true">›</span>
          </button>
          <ZoomBar />
        </div>
      </SectionCard>

      {flagError ? <ErrorBlock message={flagError} onRetry={() => void loadFlag()} /> : null}

      {!flagError && !flagChecked ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-border bg-surface p-4"
        >
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

      {saveError ? (
        <div role="alert" className="rounded-lg border border-warn bg-warn-bg p-4">
          <p className="text-base text-ink">
            <span aria-hidden="true">▲ </span>
            {saveError}
          </p>
          <button
            type="button"
            onClick={onReload}
            className="mt-2 min-h-tap rounded border border-primary px-4 text-base font-bold text-primary"
          >
            最新を読み込む
          </button>
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
        <SheetFrame
          // 枠の高さ上限は sheet.css の .sheet-frame-fit（画面の高さ − 上に積まれた UI）。
          // 100vh のままだと枠が画面より下へはみ出し、ページを送ると上固定の見出しごと
          // 画面外へ出てしまう（見出しは「枠の上端」に貼り付くため）
          className="sheet-frame-fit"
        >
          {/* sheet-table: 列幅を値で動かさない（table-layout: fixed）＋
              sticky セルの罫線が消えない（border-collapse: separate）＋
              当たり判定は ::before で下方向へ広げる（--sheet-hit-pad）。行が詰まって 44px に届かない場合は倍率 200% で行高 44px にできる。
              左端・上端の罫線は各セルが持たない（右・下だけ）ため table 側で引く。
              左固定列（居室・入居者）の位置は各セルの inline style（left）で与える */}
          <table
            className="tabular sheet-table border-l border-t border-border text-ink"
            style={{ fontSize: SHEET_FONT, borderSpacing: 0 }}
          >
            <caption className="sr-only">
              {`${fmtDayLabel(fromIso)} から ${fmtDayLabel(toIso)} までの食事量と水分の一覧。新しい日が左です。主食・副食は 0〜${AMOUNT_MAX} の11段階、水分は1日の合計（ml）です。`}
            </caption>
            {/* 列幅の正本。table-layout: fixed ではここ（と1行目）だけが幅を決めるので、
                値が長くなっても列が動かない＝スプシと同じ見え方になる。
                1日 = 主・副 × 朝昼夕（6列）＋ 水分（1列） */}
            <colgroup>
              <col style={{ width: W_ROOM }} />
              <col style={{ width: W_NAME }} />
              {dayList.map((d) => (
                <Fragment key={d}>
                  {SLOTS.map((s) => (
                    <Fragment key={s}>
                      <col style={{ width: W_MEAL }} />
                      <col style={{ width: W_MEAL }} />
                    </Fragment>
                  ))}
                  <col style={{ width: W_FLUID }} />
                </Fragment>
              ))}
            </colgroup>
            <thead>
              <tr style={{ height: HEAD_H }}>
                <th
                  scope="col"
                  rowSpan={3}
                  style={{ width: W_ROOM, minWidth: W_ROOM, left: 0, top: 0 }}
                  className={`${CELL_BASE} sticky z-30 bg-surface2 font-bold text-ink2`}
                >
                  居室
                </th>
                <th
                  scope="col"
                  rowSpan={3}
                  style={{ width: W_NAME, minWidth: W_NAME, left: W_ROOM, top: 0 }}
                  className={`${CELL_BASE} sticky z-30 bg-surface2 text-left font-bold text-ink2`}
                >
                  入居者
                </th>
                {dayList.map((d) => {
                  // 土日は日付見出しセルだけ色を変える（.sheet-sat / .sheet-sun は
                  // 背景と文字色を両方持つので、平日用の bg-surface2 / text-ink とは排他で当てる）。
                  // sticky セルなので背景は透けない色であること（.sheet-* 側は不透明）
                  const tone = weekdayToneClass(d)
                  return (
                    <th
                      key={d}
                      scope="colgroup"
                      colSpan={COLS_PER_DAY}
                      style={{ top: 0 }}
                      className={`${CELL_BASE} ${DAY_END} sticky z-20 font-bold ${tone === '' ? 'bg-surface2 text-ink' : tone}`}
                    >
                      {fmtDayLabel(d)}
                      {d === today ? <span className="sr-only">（本日）</span> : null}
                    </th>
                  )
                })}
              </tr>
              <tr style={{ height: HEAD_H }}>
                {dayList.map((d) => (
                  <Fragment key={d}>
                    {SLOTS.map((s) => (
                      <th
                        key={s}
                        scope="col"
                        colSpan={2}
                        style={{ width: W_MEAL2, minWidth: W_MEAL2, top: HEAD_H }}
                        className={`${CELL_BASE} sticky z-20 bg-surface2 font-bold ${SLOT_TEXT[s]}`}
                      >
                        <span aria-hidden="true">{MEAL_SLOT_LABEL[s]}</span>
                        <span className="sr-only">
                          {fmtDayLabel(d)} {MEAL_SLOT_LABEL[s]}
                        </span>
                      </th>
                    ))}
                    <th
                      scope="col"
                      rowSpan={2}
                      style={{ width: W_FLUID, minWidth: W_FLUID, top: HEAD_H }}
                      className={`${CELL_BASE} ${DAY_END} sticky z-20 bg-surface2 font-bold text-ink`}
                    >
                      <span aria-hidden="true">水分</span>
                      <span className="sr-only">{fmtDayLabel(d)} 水分の1日合計（ml）</span>
                    </th>
                  </Fragment>
                ))}
              </tr>
              <tr style={{ height: HEAD_H }}>
                {dayList.map((d) => (
                  <Fragment key={d}>
                    {SLOTS.map((s, i) => (
                      <Fragment key={s}>
                        <th
                          scope="col"
                          style={{ width: W_MEAL, minWidth: W_MEAL, top: HEAD_H2 }}
                          className={`${CELL_BASE} sticky z-20 bg-surface2 font-normal text-ink2`}
                        >
                          <span aria-hidden="true">主</span>
                          <span className="sr-only">
                            {fmtDayLabel(d)} {MEAL_SLOT_LABEL[s]} 主食
                          </span>
                        </th>
                        <th
                          scope="col"
                          style={{ width: W_MEAL, minWidth: W_MEAL, top: HEAD_H2 }}
                          // 3段目に水分列は無い（上の段が rowSpan で覆う）ので、
                          // この段の日の切れ目は「夕の副食」＝各日の最後の列に付ける
                          className={`${CELL_BASE} ${i === SLOTS.length - 1 ? DAY_END : ''} sticky z-20 bg-surface2 font-normal text-ink2`}
                        >
                          <span aria-hidden="true">副</span>
                          <span className="sr-only">
                            {fmtDayLabel(d)} {MEAL_SLOT_LABEL[s]} 副食
                          </span>
                        </th>
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r, rowIndex) => (
                <tr key={r.id} style={{ height: ROW_H }} className={altClass(rowIndex)}>
                  <th
                    scope="row"
                    style={{ width: W_ROOM, minWidth: W_ROOM, left: 0 }}
                    className={`${CELL_BASE} sticky z-10 ${altClass(rowIndex) || 'bg-surface'} text-center font-normal text-ink2`}
                  >
                    {r.room ?? '—'}
                  </th>
                  <td
                    style={{ width: W_NAME, minWidth: W_NAME, maxWidth: W_NAME, left: W_ROOM }}
                    className={`${CELL_BASE} sticky z-10 truncate ${altClass(rowIndex) || 'bg-surface'} px-1 text-ink`}
                  >
                    {r.name}
                  </td>

                  {dayList.map((d) => {
                    const dayLabel = fmtDayLabel(d)
                    const fkey = fluidKey(r.id, d)
                    const fl = fluidMap.get(fkey)
                    const queuedMl = queuedFluids[fkey]?.ml ?? 0
                    const totalMl = (fl?.ml ?? 0) + queuedMl
                    const fluidOpen = fluidTarget != null && fluidTarget.key === fkey

                    return (
                      <Fragment key={d}>
                        {SLOTS.map((slot) => {
                          const key = mealKey(r.id, d, slot)
                          const base = meals[key] ?? null
                          const patch = pending[key] ?? {}
                          const eff = effectiveMeal(base, patch, r.id, d, slot)
                          const mark = PHASE_MARK[phases[key] ?? 'idle']
                          const low = isLowIntake(eff)
                          // 低摂取は淡い背景＋記号「▲」（SheetCell の tone='low' と同じ見た目）
                          const toneClass = low ? 'text-warn font-bold' : SLOT_TEXT[slot]
                          const absentStatus =
                            eff.status != null && eff.status !== 'eaten' ? eff.status : null
                          const slotLabel = MEAL_SLOT_LABEL[slot]
                          const target: SaveTarget = { residentId: r.id, day: d, slot }
                          const editing = edit != null && edit.key === key ? edit : null

                          return (
                            <td
                              key={slot}
                              colSpan={2}
                              style={{ width: W_MEAL2, minWidth: W_MEAL2, height: ROW_H }}
                              className={`${CELL_BASE} relative ${low ? 'bg-warn-bg' : ''}`}
                            >
                              {absentStatus ? (
                                // 欠食は主食・副食の2セルにまたがって状態を表示する（スプシと同じ見せ方）
                                <button
                                  ref={btnRefFor(`${key}|main_amount`)}
                                  type="button"
                                  disabled={!canInput}
                                  aria-label={`${r.name} ${dayLabel} ${slotLabel} ${MEAL_STATUS_LABEL[absentStatus]}。食事の状態を変える`}
                                  onClick={() => openAmount(target, 'main_amount', eff.main_amount)}
                                  // tokens.css の 44px 下限を打ち消す（22px 行の密度を保つ）
                                  style={{ minHeight: ROW_H }}
                                  className="block h-full w-full bg-transparent text-center text-ink2 disabled:opacity-60"
                                >
                                  {mark ? (
                                    <span className={mark.cls} aria-hidden="true">
                                      {mark.mark}
                                    </span>
                                  ) : null}
                                  {MEAL_STATUS_LABEL[absentStatus]}
                                </button>
                              ) : (
                                <div className="flex h-full w-full">
                                  <AmountHalf
                                    width={W_MEAL}
                                    divider
                                    value={eff.main_amount}
                                    disabled={!canInput}
                                    toneClass={toneClass}
                                    editing={editing?.field === 'main_amount'}
                                    editText={editText}
                                    editInvalid={editInvalid}
                                    inputRef={editInputRef}
                                    buttonRef={btnRefFor(`${key}|main_amount`)}
                                    ariaLabel={`${r.name} ${dayLabel} ${slotLabel} 主食 ${eff.main_amount ?? '未入力'}${low ? '。低摂取' : ''}`}
                                    onOpen={() => openAmount(target, 'main_amount', eff.main_amount)}
                                    onText={setEditText}
                                    onKeyDown={onEditKeyDown}
                                    onBlur={onEditBlur}
                                  />
                                  <AmountHalf
                                    width={W_MEAL}
                                    value={eff.side_amount}
                                    disabled={!canInput}
                                    toneClass={toneClass}
                                    editing={editing?.field === 'side_amount'}
                                    editText={editText}
                                    editInvalid={editInvalid}
                                    inputRef={editInputRef}
                                    buttonRef={btnRefFor(`${key}|side_amount`)}
                                    lowMark={low}
                                    phaseMark={mark}
                                    ariaLabel={`${r.name} ${dayLabel} ${slotLabel} 副食 ${eff.side_amount ?? '未入力'}${low ? '。低摂取' : ''}${mark ? `。${mark.label}` : ''}`}
                                    onOpen={() => openAmount(target, 'side_amount', eff.side_amount)}
                                    onText={setEditText}
                                    onKeyDown={onEditKeyDown}
                                    onBlur={onEditBlur}
                                  />
                                </div>
                              )}

                              {editing ? (
                                <CellPopover
                                  label={`${r.name} ${dayLabel} ${slotLabel} の入力`}
                                  onClose={() => commitAndClose(true)}
                                >
                                  <p className="text-base font-bold text-ink">{`${dayLabel} ${slotLabel}`}</p>
                                  <p className="mt-1 text-sm text-ink2">
                                    {`主食・副食はセルに 0〜${AMOUNT_MAX} の数字を入れます（Enter で確定・Esc で取り消し）。`}
                                  </p>
                                  <p className="mt-3 text-sm text-ink2">食事の状態</p>
                                  <div className="mt-1">
                                    <SegmentPicker
                                      options={STATUS_OPTIONS}
                                      value={eff.status ?? ''}
                                      onChange={(v) => {
                                        // 入力途中の数値を先に確定してから状態を書く。
                                        // 順を逆にすると、打った数値が保存も警告もされずに消える
                                        // （吹き出しは onMouseDown を止めていて onBlur が走らないため）。
                                        // 解釈できない値のときは閉じずに ERR_AMOUNT を出す
                                        if (!commitAmount()) return
                                        saveMeal(target, { status: v as MealStatus })
                                        closeEdit(true)
                                      }}
                                      ariaLabel="食事の状態を選ぶ"
                                    />
                                  </div>
                                  <p className="mt-1 text-sm text-ink2">
                                    外出・入院・拒食を選ぶと、主食・副食の欄にその状態を表示します（入力済みの数値は消しません）。
                                  </p>
                                </CellPopover>
                              ) : null}
                            </td>
                          )
                        })}

                        <td
                          // 水分は各日の最後の列。ここの右罫線で日の切れ目を示す
                          style={{ width: W_FLUID, minWidth: W_FLUID, height: ROW_H }}
                          className={`${CELL_BASE} ${DAY_END} relative`}
                        >
                          <button
                            ref={btnRefFor(`f|${fkey}`)}
                            type="button"
                            aria-label={`${r.name} ${dayLabel} 水分 合計${totalMl}ml${queuedMl > 0 ? '。未送信を含む' : ''}。内訳と追加を開く`}
                            aria-expanded={fluidOpen}
                            onClick={() => openFluid(r.id, d)}
                            // tokens.css の 44px 下限を打ち消す（22px 行の密度を保つ）
                            style={{ minHeight: ROW_H }}
                            className="block h-full w-full bg-transparent text-center text-ink"
                          >
                            {queuedMl > 0 ? (
                              <span className="text-warn" aria-hidden="true">
                                ⚠
                              </span>
                            ) : null}
                            {totalMl > 0 ? totalMl : ''}
                          </button>

                          {fluidOpen && fluidTarget ? (
                            <CellPopover
                              label={`${r.name} ${dayLabel} の水分`}
                              onClose={() => closeFluid(true)}
                            >
                              <p className="text-base font-bold text-ink">{`${dayLabel} 水分 合計 ${totalMl}ml`}</p>
                              {queuedMl > 0 ? (
                                <p className="mt-1 text-sm text-warn">
                                  <span aria-hidden="true">⚠ </span>
                                  {`未送信 ${queuedMl}ml を含みます`}
                                </p>
                              ) : null}

                              <p className="mt-3 text-sm text-ink2">内訳</p>
                              {fl && fl.rows.length > 0 ? (
                                <ul className="mt-1 flex flex-col">
                                  {fl.rows.map((f) => (
                                    <li key={f.id} className="tabular text-base text-ink">
                                      {f.taken_at ? fmtTimeHM(f.taken_at) : '時刻なし'}
                                      {'　'}
                                      {f.amount_ml}ml
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="mt-1 text-base text-ink2">
                                  この日の水分はまだ記録されていません。
                                </p>
                              )}

                              <p className="mt-3 text-sm text-ink2">追加する</p>
                              <div className="mt-1 flex flex-wrap gap-gap">
                                {FLUID_STEPS.map((ml) => (
                                  <button
                                    key={ml}
                                    type="button"
                                    disabled={!canInput}
                                    aria-label={`水分 ${ml}ml を追加`}
                                    onClick={() => addFluid(r.id, d, ml)}
                                    className="tabular min-h-tap rounded border border-border bg-surface px-3 text-base text-ink disabled:opacity-60"
                                  >
                                    ＋{ml}ml
                                  </button>
                                ))}
                              </div>
                              {undoFluids[fkey] ? (
                                <div className="mt-2">
                                  <button
                                    type="button"
                                    disabled={!canInput}
                                    onClick={() => undoFluid(r.id, d)}
                                    className="min-h-tap rounded border border-danger px-3 text-base font-bold text-danger disabled:opacity-60"
                                  >
                                    直前の追加を取り消す
                                  </button>
                                </div>
                              ) : null}
                            </CellPopover>
                          ) : null}
                        </td>
                      </Fragment>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </SheetFrame>
      )}

      {/* 凡例（色だけで意味を伝えないための文字説明） */}
      <p className="text-sm text-ink2">
        朝は赤系・昼は緑系・夕は通常色の文字です。<span aria-hidden="true">▲</span>
        は低摂取、<span aria-hidden="true">⚠</span>は未送信を表します。文字を大きくするときは上の倍率で切り替えてください。
      </p>

      {toast}
    </div>
  )
}
