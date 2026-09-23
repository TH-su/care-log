// 定時バイタル一括グリッド（記録→バイタル）。
// 契約: docs/design/contracts.md ／ 詳細: docs/design/ui-design.md §6・db-design.md §5
//
// 実装方針（設計の要点をそのまま構造にする）:
// - フロアセグメント（cl_vitalsFloor に UI 状態のみ保存・既知値照合で復元。氏名や記録値は保存しない）
// - 居室昇順・1行=1測定。定時（routine）に加えて再検・経過観察の行も同じ日に並べる
// - セルをタップすると画面下部固定の自前数値キーパッド（キー 56×64px・間隔8px＝手袋対応）
// - 空セルには前回値をゴースト表示（--c-ink3）。確定で右隣→行末で次行の先頭へ自動送り
// - 入力は normalizeVitalInput で正規化（「365」→36.5）。VITAL_RANGE 外はインライン警告を出し
//   自動送りを止める（DB の check 制約と同じ範囲。範囲外のまま保存もしない）
// - 1名分ずつ自動保存（別の利用者のセルへ移った時・キーパッドを閉じた時）。
//   保存は saveVitalEdits（送信待ち → RPC apply_cell_edits の1本・2026-09-23 フェーズ2'）。送るのは編集した欄と
//   その基準だけで、書くかどうかはサーバーが欄ごとに決める。送信待ち・止まっている行は pendingRow から読む
// - 記録済みの値を空にする操作は確認ダイアログを挟む（空上書き保護・dev-principles 原則4）
// - 保存できなかった入力は画面から消さない（キュー退避・競合・範囲外のいずれも入力を保持）
// - 入力解禁フラグ（native_input_enabled）が false の間は全入力をディセーブル＋理由文
// - 個人情報は console にも localStorage にも出さない

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DbError,
  discardPendingRow,
  fetchLatestVital,
  fetchResidents,
  fetchTimelineChunk,
  getNativeInputGate,
  newClientKey,
  pendingRow,
  queuePending,
  queueSubscribe,
  saveVitalEdits,
} from '../lib/db'
import type { CellSaveResult, PendingCellRow, VitalTarget } from '../lib/db'
import { addDays, fmtDayLabel, normalizeVitalInput, todayIso } from '../lib/format'
import {
  diaBpLevel,
  LS,
  pulseLevel,
  spo2Level,
  sysBpLevel,
  tempLevel,
  VITAL_RANGE,
} from '../lib/types'
import type { Level, Resident, Vital, VitalKind } from '../lib/types'
import { getActorId } from '../lib/actor'
import {
  ConfirmDialog,
  EmptyBlock,
  ErrorBlock,
  LevelCell,
  LoadingBlock,
  SegmentPicker,
} from '../components/ui'
import { ConflictResolver, focusAfterResolve } from '../components/ConflictResolver'
import type { ConflictResolution, ConflictTarget } from '../components/ConflictResolver'
import {
  CELLS_PENDING_REASON,
  fmtVitalValue,
  holdsNormalSave,
  missingRowText,
  pairOf,
  valuesForBoth,
  vitalConflictDetail,
} from '../lib/conflict'
import {
  createRowQueue,
  editBases,
  reconcileOnLoad,
  editValues,
  adoptPendingEdits,
  hasEdits,
  isOlderRow,
  planEdits,
  recordFieldEdit,
  seenVers,
  settleSent,
  withoutFields,
} from '../lib/rowSync'
import type { Edits } from '../lib/rowSync'
import type { ConflictColumn } from '../lib/conflict'
import { registerUnsaved } from '../lib/leaveGuard'
import { focusOf, useCellPresence } from '../hooks/useCellPresence'
import type { CellPresence } from '../hooks/useCellPresence'
import { cellKey } from '../lib/presence'
import type { CellTarget } from '../lib/presence'
import { BUSY_RING, BusyMark, PresenceSummary, RowBusyMark } from '../components/presence'

// ── 定数 ─────────────────────────────────────────────────────

type Field = 'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2'

/** 列の並び（＝自動送りの順序）。ui-design §6「KT|上|下|P|SpO2」 */
const FIELDS: Field[] = ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2']

/** 表の見出し（短縮表記。読み上げ用の正式名は FIELD_LABEL） */
const FIELD_HEAD: Record<Field, string> = {
  temp: 'KT',
  sys_bp: '上',
  dia_bp: '下',
  pulse: 'P',
  spo2: 'SpO2',
}
const FIELD_LABEL: Record<Field, string> = {
  temp: '体温',
  sys_bp: '血圧（上）',
  dia_bp: '血圧（下）',
  pulse: '脈拍',
  spo2: 'SpO2',
}
const FIELD_UNIT: Record<Field, string> = {
  temp: '℃',
  sys_bp: 'mmHg',
  dia_bp: 'mmHg',
  pulse: '回/分',
  spo2: '%',
}
const FIELD_DIGITS: Record<Field, number> = { temp: 1, sys_bp: 0, dia_bp: 0, pulse: 0, spo2: 0 }
const LEVEL_FN: Record<Field, (v: number | null) => Level> = {
  temp: tempLevel,
  sys_bp: sysBpLevel,
  dia_bp: diaBpLevel,
  pulse: pulseLevel,
  spo2: spo2Level,
}

const KIND_LABEL: Record<VitalKind, string> = {
  routine: '定時',
  recheck: '再検',
  observation: '経過観察',
  symptom: '他症状',
}

/** 前回値ゴーストの遡り日数（この範囲に記録が無ければゴーストは出さない） */
const PREV_LOOKBACK_DAYS = 7

/** 居室が未設定の利用者を入れるフロア区分 */
const FLOOR_OTHER = 'other'

/** キーパッドの入力桁上限（誤打の暴走を止める歯止め） */
const MAX_INPUT_LEN = 6

const KEYPAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'] as const

const ERR_LOAD =
  'バイタルの一覧を読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'
const ERR_SAVE =
  '保存できませんでした。入力は消えていません。通信状況を確認して、もう一度入力を確定してください。'
const MSG_QUEUED = '通信できないため送信待ちにしました。電波が戻ると自動で送信します。'
/** サーバーに受け付けられなかった保存（型・範囲の拒否）が送信待ちに残っている時 */
const ERR_REJECTED =
  'サーバーに受け付けられなかった保存があります（入力は消えていません）。値を確かめて「保存し直す」を押してください。'
const MSG_BLOCKED =
  '現在はスプレッドシートで記録する期間です（アプリ入力の開始日は施設で決定します）'
const MSG_GATE_UNKNOWN =
  '入力できるかどうかを確認できませんでした（通信エラー）。電波状態を確認して、「もう一度確認する」を押してください。入力は消えていません。'
/** 保存が、他の端末の値と食い違って止まっている行にまとめられた時（送らない。くらべて選ぶへ誘導する） */
const MSG_BLOCKED_WRITE =
  'この方には、他の端末の値と食い違って止まっている保存があります。いまの入力もそこにまとめました（まだ送っていません・入力は消えていません）。「くらべて選ぶ」でどちらを残すか選んでください。'
/** 両方残すで作った再検の行が送信待ちになった時 */
const MSG_BOTH_QUEUED =
  'あなたの値を再検の行として送信待ちにしました。電波が戻ると自動で送信します。'

/**
 * 読み直しても食い違う列が残っている時（競合のまま）。セルにはあなたの入力が出ているので、
 * 先に入っている値をこの一言に併記する（どちらの値なのかを取り違えないように）
 */
function conflictStillText(columns: ConflictColumn<Field>[]): string {
  return `最新を読み込みましたが、${vitalConflictDetail(columns)}が食い違っています。まだ保存していません（入力は消えていません）。「くらべて選ぶ」でどちらを残すか選んでください。`
}

/**
 * 競合中の行に入力が確定された時（くらべて選ぶまで保存しない＝5画面共通の規約）。
 * 止めた旨と、分かっている食い違い（先の値／あなたの入力）を両方出す（併記を消さない）
 */
function conflictHoldText(columns: ConflictColumn<Field>[]): string {
  const detail =
    columns.length > 0
      ? `${vitalConflictDetail(columns)}が食い違っています。`
      : '他の端末の値と食い違っています。'
  return `この行の入力はまだ保存していません（入力は消えていません）。${detail}「くらべて選ぶ」でどちらを残すか選んでください。`
}

/** 読み直したら食い違いは無くなったが、まだ保存していない入力が残っている時 */
function unsavedText(fields: Field[]): string {
  return `他の端末の更新を読み込みました（食い違いはありません）。${fields.map((f) => FIELD_LABEL[f]).join('・')}の入力はまだ保存していません。「保存し直す」を押すと保存します。`
}

// ── 純ロジック（副作用なし） ─────────────────────────────────

/** 受信値を信じない（numeric が文字列で来ても数値へ。解釈不能は null） */
function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/** 居室文字列から階を取る（'102'→'1'）。数字が無い・未設定は FLOOR_OTHER */
function floorOf(room: string | null | undefined): string {
  if (!room) return FLOOR_OTHER
  const m = /\d/.exec(room)
  return m ? m[0] : FLOOR_OTHER
}

/** 居室の数値部分（昇順並べ替え用）。数字が無ければ null */
function roomNum(room: string | null | undefined): number | null {
  if (!room) return null
  const m = /\d+/.exec(room)
  return m ? Number(m[0]) : null
}

/** 居室昇順（数字優先・未設定は末尾）。同室は氏名で安定させる */
function cmpResident(a: Resident, b: Resident): number {
  const na = roomNum(a.room)
  const nb = roomNum(b.room)
  if (na != null && nb != null && na !== nb) return na - nb
  if (na != null && nb == null) return -1
  if (na == null && nb != null) return 1
  const ra = a.room ?? ''
  const rb = b.room ?? ''
  if (ra !== rb) return ra < rb ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id
}

function fmtNum(field: Field, v: number): string {
  return v.toFixed(FIELD_DIGITS[field])
}

/** 「体温は30.0〜45.0」のような範囲文（VITAL_RANGE＝DB の check 制約と同一） */
function rangeText(field: Field): string {
  const [lo, hi] = VITAL_RANGE[field]
  return `${FIELD_LABEL[field]}は${fmtNum(field, lo)}〜${fmtNum(field, hi)}`
}

function outOfRange(field: Field, v: number): boolean {
  const [lo, hi] = VITAL_RANGE[field]
  return v < lo || v > hi
}

function emptyBuf(): Record<Field, string> {
  return { temp: '', sys_bp: '', dia_bp: '', pulse: '', spo2: '' }
}

function savedOf(v: Vital | null): Record<Field, number | null> {
  return {
    temp: numOrNull(v?.temp),
    sys_bp: numOrNull(v?.sys_bp),
    dia_bp: numOrNull(v?.dia_bp),
    pulse: numOrNull(v?.pulse),
    spo2: numOrNull(v?.spo2),
  }
}

function bufOf(saved: Record<Field, number | null>): Record<Field, string> {
  const out = emptyBuf()
  for (const f of FIELDS) {
    const v = saved[f]
    if (v != null) out[f] = fmtNum(f, v)
  }
  return out
}

/** 端末ローカルの現在時刻 HH:MM（measured_at 用。業務日付と同じくクライアント明示指定） */
function nowHM(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** UI 状態だけを localStorage から読む（壊れた値・未知値は既定へ倒す） */
function readFloor(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const v = localStorage.getItem(LS.vitalsFloor)
    return v && /^[0-9a-z]{1,8}$/.test(v) ? v : null
  } catch {
    return null
  }
}

function writeFloor(v: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS.vitalsFloor, v)
  } catch {
    // 保存できなくても表示は成立する（次回起動時に既定へ戻るだけ）
  }
}

// ── 行モデル ─────────────────────────────────────────────────

type RowState = 'idle' | 'saving' | 'saved' | 'queued' | 'conflict' | 'error' | 'invalid'

interface GridRow {
  /** 画面内で一意（定時=r{residentId} / 既存行=v{vitalId} / 追加した再検=d{residentId}-{seq}） */
  rowId: string
  residentId: number
  kind: VitalKind
  vitalId: number | null
  rev: number
  /** 直近にサーバーで観測できた値（差分＝送る列の判定に使う） */
  saved: Record<Field, number | null>
  /** 送信待ちへ渡した内容（未観測）。送信待ちの行で「そのあと入力された値」を見分けるために持つ */
  sent?: Record<Field, number | null>
  /** 入力バッファ（文字列のまま保持し、保存時に正規化する） */
  buf: Record<Field, string>
  /** 空セルに出す前回値ゴースト */
  prev: Record<Field, number | null>
  state: RowState
  message: string
  /**
   * 利用者の編集（欄ごとの値と、キーパッドを出した時に画面に出ていた値＝基準）。構造規約 R-E〜R-G の
   * 共通の仕組み（src/lib/rowSync.ts）で扱う。保存で送るのはこの欄だけで、入力欄と saved の差分は使わない
   */
  edits?: Edits<Field>
  /**
   * まだ行の無い再検の、この行に固有の冪等キー（最初に送る時に決める）。送信待ちの間に続けて入力しても
   * 同じ送信待ちへまとまり、何度送っても1行に収まる。行ができた後は行 id で指す
   */
  clientKey?: string
  /** 競合の理由が「先の行が他の端末で取り消された」（〔新しい行として保存〕〔取り下げる〕を出す） */
  missing?: boolean
  /** saved が古いかもしれない（競合の後に最新を取り直せなかった）。この間は「先の値」を出さない（指摘 U1） */
  stale?: boolean
}

/** 行の氏名のセルの id（食い違いを解決した後のフォーカスの戻り先） */
function nameCellId(rowId: string): string {
  return `vg-name-${rowId}`
}

/** 入力として読める列だけの値（空欄は null＝消す意思）。範囲外の入力は比べない */
function inputCells(buf: Record<Field, string>): Partial<Record<Field, number | null>> {
  const out: Partial<Record<Field, number | null>> = {}
  for (const f of FIELDS) {
    const raw = buf[f].trim()
    const p = normalizeVitalInput(buf[f], f)
    if (raw !== '' && p == null) continue
    if (p != null && outOfRange(f, p)) continue
    out[f] = p
  }
  return out
}

/** あなたの入力（実際に編集した欄の値） */
function mineOf(row: GridRow): Partial<Record<Field, number | null>> {
  return editValues(row.edits ?? {}) as Partial<Record<Field, number | null>>
}

/**
 * いまのサーバーの値（saved）に対する食い違い（編集を始めた時の基準からサーバーの値が動いた欄）。
 * saved が古いかもしれない間（stale）は出さない（古い値を「先の値」として見せない＝指摘 U1）
 */
function knownColumns(row: GridRow): ConflictColumn<Field>[] {
  if (row.stale === true) return []
  return planEdits(FIELDS, row.edits ?? {}, row.saved).conflicts
}

/** 範囲外の入力の列（保存しない。打った文字はセルに残す） */
function badCells(buf: Record<Field, string>): Field[] {
  const readable = inputCells(buf)
  return FIELDS.filter((f) => !(f in readable))
}

function badText(bad: Field[]): string {
  return bad.length > 0
    ? `入力値を確認してください（${bad.map(rangeText).join('・')}）。範囲外の値は保存していません。`
    : ''
}

/** 画面を離れると消える入力が残っている行か（構造規約 R-G）。送信待ちの内容そのものは数えない */
function holdsInput(r: GridRow): boolean {
  return hasEdits(r.edits) || badCells(r.buf).length > 0 || r.state === 'conflict'
}

/** 読み込みで作り直さずに載せ替える行か（止まっている入力・送信待ち・競合がある） */
function isHeldRow(r: GridRow): boolean {
  return holdsInput(r) || r.state === 'queued'
}

/**
 * 読み込んだサーバーの値（fresh）に行を載せ替える（構造規約 R-E・VitalsSheetPage.mergeOnLoad と同じ裁き）。
 * saved / rev / id は最新に、edits（編集と基準）はそのまま。セルは最新の値で描き直し、編集のある欄と
 * 範囲外の入力の欄だけ打った文字を残す。状態は edits と最新の値の突き合わせで決め直す。
 * fresh=null は行が見当たらない（先の値が無いもの＝新しい行として裁く）
 */
function mergeOnLoad(cur: GridRow, fresh: GridRow | null): GridRow {
  const latest: GridRow = fresh ?? { ...cur, vitalId: null, rev: 0, saved: savedOf(null) }
  let edits = cur.edits ?? {}
  const buf = bufOf(latest.saved)
  const readable = inputCells(cur.buf)
  for (const f of FIELDS) {
    if (edits[f] !== undefined || !(f in readable)) buf[f] = cur.buf[f]
  }
  // 突き合わせは共通の裁き（rowSync.reconcileOnLoad）。行が見当たらない時は先の値が無いものとして扱う
  const r = reconcileOnLoad(FIELDS, edits, fresh ? latest.saved : null)
  edits = r.edits
  const next: GridRow = {
    ...latest,
    rowId: cur.rowId,
    buf,
    sent: undefined,
    edits,
    stale: undefined,
    missing: undefined,
    ...(latest.vitalId == null && cur.clientKey ? { clientKey: cur.clientKey } : {}),
  }
  if (r.status === 'conflict') return { ...next, state: 'conflict', message: conflictStillText(r.conflicts) }
  if (r.status === 'unsaved') return { ...next, state: 'error', message: unsavedText(r.unsaved) }
  const bad = badCells(buf)
  if (bad.length > 0) return { ...next, state: 'invalid', message: badText(bad) }
  return { ...next, state: 'idle', message: '' }
}

/** その行の送り先（定時は利用者×当日・保存済みの行は行 id・まだ行の無い再検はこの行の冪等キー） */
function targetOf(row: GridRow, day: string): VitalTarget | null {
  if (row.kind === 'routine') return { routine: true, residentId: row.residentId, day }
  if (row.vitalId != null) return { routine: false, id: row.vitalId }
  if (row.clientKey) {
    return { routine: false, clientKey: row.clientKey, residentId: row.residentId, day, kind: row.kind }
  }
  return null
}

/** その行の送信待ちがまだ送る状態で残っているか（送信が済めば、サーバーの値で作り直してよい） */
function stillPending(row: GridRow, day: string): boolean {
  const target = targetOf(row, day)
  return target !== null && pendingRow('vitals', target)?.state === 'pending'
}

/**
 * 送信待ちで止まっている行（競合・拒否）の値を、その行の「あなたの入力」として編集に取り込む
 * （VitalsSheetPage.adoptPending と同じ）。画面に既に編集のある欄は画面の値を残す。基準は送信待ちの基準
 */
function adoptPending(edits: Edits<Field>, p: PendingCellRow): Edits<Field> {
  // 血圧は組で取り込む（相方を「値＝基準」で送っていても落とさない＝第3段 #3）
  return adoptPendingEdits(FIELDS, edits, p, (_f, v) => numOrNull(v))
}

/** 編集の値を「体温 37.2℃・脈拍 70回/分」の形に（取り消された行の控えの一言） */
function describeEdits(edits: Edits<Field> | undefined): string {
  const mine = editValues(edits ?? {}) as Partial<Record<Field, number | null>>
  return FIELDS.filter((f) => f in mine)
    .map((f) => `${FIELD_LABEL[f]} ${fmtVitalValue(f, mine[f])}`)
    .join('・')
}

/** 編集の欄の文字を表示に出す（編集のある欄は編集の値・それ以外は元の文字） */
function bufWithEdits(buf: Record<Field, string>, edits: Edits<Field>): Record<Field, string> {
  const out = { ...buf }
  for (const f of FIELDS) {
    const e = edits[f]
    if (e) out[f] = typeof e.value === 'number' ? fmtNum(f, e.value) : ''
  }
  return out
}

/**
 * 送信待ち（db.ts の pending store）を一覧の行へ重ねる（VitalsSheetPage.adoptStoreRecs と同じ裁き）。
 * 送る状態は「送信待ち」の印つきで値を重ね、止まっている行は「あなたの入力」として取り込んで競合・未保存を
 * 出し直す（もう同じ値が載っていれば送信待ちから外す）。拒否された行は〔保存し直す〕を出す
 */
function adoptStoreRows(next: GridRow[], day: string): void {
  for (let i = 0; i < next.length; i++) {
    const cur = next[i]
    const target = targetOf(cur, day)
    if (target === null || cur.state === 'saving') continue
    const p = pendingRow('vitals', target)
    if (p === null) continue
    if (p.state === 'pending') {
      if (cur.state === 'conflict') continue
      const q: Partial<Record<Field, number | null>> = {}
      for (const f of FIELDS) if (f in p.values) q[f] = numOrNull(p.values[f])
      if (Object.keys(q).length === 0) continue
      const buf = { ...cur.buf }
      for (const f of Object.keys(q) as Field[]) {
        if (cur.edits?.[f] !== undefined) continue // 送信待ちの後に打った値はそのまま
        const v = q[f]
        buf[f] = v == null ? '' : fmtNum(f, v)
      }
      const quiet = cur.state === 'idle' || cur.state === 'saved' || cur.state === 'queued'
      next[i] = {
        ...cur,
        buf,
        sent: { ...cur.saved, ...q } as Record<Field, number | null>,
        ...(quiet ? { state: 'queued' as const, message: cur.state === 'queued' && cur.message ? cur.message : MSG_QUEUED } : {}),
      }
      continue
    }
    const edits = adoptPending(cur.edits ?? {}, p)
    if (p.state === 'rejected') {
      next[i] = { ...cur, edits, buf: bufWithEdits(cur.buf, edits), state: 'error', message: ERR_REJECTED }
      continue
    }
    const missing = cur.vitalId == null && p.conflicts.length > 0 && p.conflicts.every((c) => c.reason === 'missing')
    if (missing) {
      next[i] = { ...cur, edits, buf: bufWithEdits(cur.buf, edits), state: 'conflict', missing: true, message: missingRowText(describeEdits(edits)) }
      continue
    }
    const r = reconcileOnLoad(FIELDS, edits, cur.vitalId != null ? cur.saved : null)
    if (r.status === 'clean') {
      // もう同じ値がサーバーに載っている（止まっていた分は届いたのと同じ）。送信待ちから外す
      // 突き合わせた欄の、見た版だけを外す（第3段 #9。画面に出していない欄・見た後の新しい版は外さない）
      void discardPendingRow('vitals', target, FIELDS.filter((f) => f in p.values), p.vers)
      next[i] = { ...cur, edits: r.edits }
      continue
    }
    next[i] = {
      ...cur,
      edits: r.edits,
      buf: bufWithEdits(cur.buf, r.edits),
      state: r.status === 'conflict' ? 'conflict' : 'error',
      message: r.status === 'conflict' ? conflictStillText(r.conflicts) : unsavedText(r.unsaved),
    }
  }
}

function rowFromVital(v: Vital, prev: Record<Field, number | null>, rowId: string): GridRow {
  const saved = savedOf(v)
  return {
    rowId,
    residentId: v.resident_id,
    kind: v.kind,
    vitalId: v.id,
    rev: numOrNull(v.rev) ?? 1,
    saved,
    buf: bufOf(saved),
    prev,
    state: 'idle',
    message: '',
  }
}

function emptyRoutineRow(residentId: number, prev: Record<Field, number | null>): GridRow {
  return {
    rowId: `r${residentId}`,
    residentId,
    kind: 'routine',
    vitalId: null,
    rev: 0,
    saved: savedOf(null),
    buf: emptyBuf(),
    prev,
    state: 'idle',
    message: '',
  }
}

// ── ページ本体 ───────────────────────────────────────────────

export interface VitalsGridPageProps {
  /** App.tsx が保持していれば渡す（省略時はこの画面で取得する） */
  residents?: Resident[]
  /** 操作者（記入者）の staff_id。省略時は cl_staffId から読む */
  actorId?: number | null
  /** 入力解禁フラグ。省略時はこの画面の表示ごとに取得する（前提情報は毎回取り直す） */
  inputEnabled?: boolean
}

export function VitalsGridPage({
  residents: propResidents,
  actorId: propActorId,
  inputEnabled: propInputEnabled,
}: VitalsGridPageProps = {}) {
  const [day] = useState(() => todayIso())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [residents, setResidents] = useState<Resident[]>(propResidents ?? [])
  const [inputEnabled, setInputEnabled] = useState<boolean>(propInputEnabled ?? false)
  /** 入力できるかどうかを観測できなかった（通信エラー）。封鎖の理由文とは分けて案内する */
  const [gateUnknown, setGateUnknown] = useState(false)
  /** サーバーに欄ごとの保存の仕組み（0011）がまだ無い＝サーバー側の更新待ち（入力を止める） */
  const [cellsMissing, setCellsMissing] = useState(false)
  const [rows, setRows] = useState<GridRow[]>([])
  const [floor, setFloor] = useState<string>(() => readFloor() ?? '1')
  const [sel, setSel] = useState<{ rowId: string; field: Field } | null>(null)
  const [edit, setEdit] = useState('')
  const [pending, setPending] = useState(0)
  const [draftSeq, setDraftSeq] = useState(0)
  const [clearAsk, setClearAsk] = useState<{ labels: string } | null>(null)
  /** くらべて選ぶ画面に渡す内容（開いた時点で固定する） */
  const [compare, setCompare] = useState<{
    rowId: string
    target: ConflictTarget
    name: string
    base: Record<string, unknown>
    mine: Record<string, unknown>
  } | null>(null)

  const aliveRef = useRef(true)
  const rowsRef = useRef<GridRow[]>([])
  const selRef = useRef<{ rowId: string; field: Field } | null>(null)
  /** キーパッドを出した時に画面に出ていた値（構造規約 R-E の基準） */
  const editBaseRef = useRef<{ rowId: string; field: Field; text: string } | null>(null)
  const clearResolveRef = useRef<((ok: boolean) => void) | null>(null)

  const actorId = propActorId !== undefined ? propActorId : getActorId()
  // 他の端末が今まさに入力している欄（Presence・表示だけ。保存は妨げない）。
  // この画面は、キーパッドを出している欄を配り、閉じたら少し待って取り消す
  const presence = useCellPresence({ actorId: actorId ?? null })

  const commitRows = useCallback((next: GridRow[]) => {
    rowsRef.current = next
    setRows(next)
  }, [])

  useEffect(() => {
    selRef.current = sel
  }, [sel])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // ── 読み込み ───────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const from = addDays(day, -PREV_LOOKBACK_DAYS)
      // 日付レンジ付きの1往復で「当日の測定」と「前回値ゴースト」の両方をまかなう。
      // 入力解禁フラグは「観測できた値」と「観測できなかった」を区別して受け取る
      // （親から渡された既知値は観測済みとして扱う）。サーバー側の更新待ち（0011 の有無）は毎回確かめる
      const [rs, gateNow, chunk] = await Promise.all([
        propResidents ? Promise.resolve(propResidents) : fetchResidents(),
        getNativeInputGate(),
        fetchTimelineChunk(from, day, null),
      ])
      const gate =
        propInputEnabled === undefined ? gateNow : { value: propInputEnabled, observed: true, cells: gateNow.cells }
      if (!aliveRef.current) return

      const list = (Array.isArray(rs) ? rs : []).filter((r) => r && r.active !== false)
      const sorted = list.slice().sort(cmpResident)
      const vitals = Array.isArray(chunk?.vitals) ? chunk.vitals.filter((v) => v != null) : []

      // 前回値: 当日より前の記録を新しい順に見て、項目ごとに最初の非 null を採る
      const older = vitals
        .filter((v) => typeof v.measured_on === 'string' && v.measured_on < day)
        .sort((a, b) => (a.measured_on < b.measured_on ? 1 : a.measured_on > b.measured_on ? -1 : 0))
      const prevMap = new Map<number, Record<Field, number | null>>()
      for (const v of older) {
        const cur = prevMap.get(v.resident_id) ?? savedOf(null)
        for (const f of FIELDS) {
          if (cur[f] == null) cur[f] = numOrNull(v[f])
        }
        prevMap.set(v.resident_id, cur)
      }

      const today = vitals.filter((v) => v.measured_on === day)
      const routineByResident = new Map<number, Vital>()
      const extras: Vital[] = []
      for (const v of today) {
        if (v.kind === 'routine') {
          const cur = routineByResident.get(v.resident_id)
          // 同一人の定時が複数見えた場合（他端末との競合直後など）は新しい id を採り、
          // 残りは行として残す（無言で消さない）
          if (!cur) routineByResident.set(v.resident_id, v)
          else if (v.id > cur.id) {
            routineByResident.set(v.resident_id, v)
            extras.push(cur)
          } else extras.push(v)
        } else {
          extras.push(v)
        }
      }
      extras.sort((a, b) => a.id - b.id)

      const next: GridRow[] = []
      for (const r of sorted) {
        const prev = prevMap.get(r.id) ?? savedOf(null)
        const routine = routineByResident.get(r.id)
        // 定時行の rowId は利用者ごとに1本（r{id}）。それ以外は行ごとに v{vitalId} で一意にする
        next.push(routine ? rowFromVital(routine, prev, `r${r.id}`) : emptyRoutineRow(r.id, prev))
        for (const ex of extras) {
          if (ex.resident_id === r.id) next.push(rowFromVital(ex, prev, `v${ex.id}`))
        }
      }

      // 未送信・競合・失敗・応答待ち・範囲外警告中の行は入力を引き継ぐ（原則4: 入力を消さない）。
      // 以前は読み込み直すたびに全行を作り直しており、「入力は消えていません」と案内した競合の行でも
      // 「読み込み直す」を押すと入力が消えていた（2026-09-23 レビュー指摘。VitalsSheetPage の KEEP と同じ作法）
      /** 送信待ちの追加行が「実は届いていた」と分かった一覧の行（同じ行を2つの追加行へ当てない） */
      const landedTaken = new Set<string>()
      /** 送った内容と一致する、まだ誰にも当てていない一覧の行（応答だけが失われて届いていた追加行） */
      const findLanded = (cur: GridRow): number =>
        next.findIndex(
          (r) =>
            r.residentId === cur.residentId &&
            r.kind === cur.kind &&
            r.vitalId != null &&
            !landedTaken.has(r.rowId) &&
            cur.sent !== undefined &&
            FIELDS.every((f) => r.saved[f] === cur.sent?.[f]),
        )
      for (const cur of rowsRef.current) {
        const i = next.findIndex((r) => r.rowId === cur.rowId)
        const fresh = i >= 0 ? next[i] : null
        if (fresh && isOlderRow({ id: cur.vitalId, rev: cur.rev }, { id: fresh.vitalId, rev: fresh.rev })) {
          // 画面が持っている行より古い応答（くらべて選ぶ・保存の直後に、それより前に出た読み込みが返った）。
          // 古い値で描き直さず、画面の行をそのまま残す（指摘 L2・全画面共通の防御）
          next[i] = { ...cur, prev: fresh.prev }
          continue
        }
        // 編集・範囲外の入力・送信待ち・応答待ち・競合のどれも無い行は、サーバーの値で作り直す
        if (!isHeldRow(cur) && cur.state !== 'saving') continue
        let kept: GridRow | null
        const pending = cur.state === 'queued' && stillPending(cur, day)
        if (cur.state === 'saving') {
          // 保存の応答待ち。入力と編集を温存する（順番待ちが応答の後に計算し直す）
          kept = fresh ? { ...fresh, buf: cur.buf, state: cur.state, message: cur.message, sent: cur.sent, edits: cur.edits } : cur
        } else if (pending) {
          if (fresh) {
            kept = { ...fresh, buf: cur.buf, state: 'queued', message: cur.message, sent: cur.sent, edits: cur.edits }
          } else {
            // まだ id の無い追加行（送信待ち）。応答だけが失われて実は届いていた場合、一覧にも同じ記録が
            // 出るので、送った内容と一致する行があれば届いたとみなして持ち込まない（同じ記録を2行に見せない・
            // 再審 指摘11。client_key は一覧に出していないので内容の一致で見分ける）
            const j = findLanded(cur)
            if (j >= 0) {
              landedTaken.add(next[j].rowId)
              if (hasEdits(cur.edits) || badCells(cur.buf).length > 0) next[j] = mergeOnLoad({ ...cur, rowId: next[j].rowId }, next[j])
              continue
            }
            kept = cur
          }
        } else {
          if (!fresh && cur.vitalId == null && cur.state === 'queued') {
            // 画面で足した行の送信が済んだ。一覧に別の行（v{id}）として出ているので、その行へ編集を載せ替える
            const j = findLanded(cur)
            if (j >= 0) {
              landedTaken.add(next[j].rowId)
              if (hasEdits(cur.edits) || badCells(cur.buf).length > 0) next[j] = mergeOnLoad({ ...cur, rowId: next[j].rowId }, next[j])
              continue
            }
          }
          if (cur.state === 'queued' && !hasEdits(cur.edits) && badCells(cur.buf).length === 0) {
            // 送信が済み、送信待ちの後に打った値も無い＝サーバーの値で作り直す（送信待ちが解除されない不具合の修正）
            if (fresh) continue
            if (cur.vitalId == null) continue
          }
          // 送信が済んだ送信待ち・競合・未保存・保存失敗・範囲外の警告中。edits（編集と基準）と範囲外の入力
          // だけを残して最新の値に載せ替え、状態を決め直す（共通の仕組み mergeOnLoad）
          kept = mergeOnLoad(cur, fresh)
        }
        if (i >= 0) {
          next[i] = kept
          continue
        }
        // 取り直した一覧に無い行（画面で足した再検の行・他端末で取り消された行など）は、その方の行の後ろへ
        let at = -1
        for (let j = next.length - 1; j >= 0; j--) {
          if (next[j].residentId === cur.residentId) {
            at = j + 1
            break
          }
        }
        if (at >= 0 && kept) next.splice(at, 0, kept) // 一覧に居ない利用者（退居など）の行は出さない
      }

      // 送信待ち・止まっている行を db.ts（pending store）から読んで重ねる（再マウント・再読み込みの後も同じ見え方）
      adoptStoreRows(next, day)

      setResidents(sorted)
      setInputEnabled(gate.value === true)
      setGateUnknown(!gate.observed)
      setCellsMissing(gate.cells === 'missing')
      commitRows(next)
      setSel(null)
      setEdit('')
      setError(null)
    } catch {
      if (!aliveRef.current) return
      // 失敗時は既存の表示を消さない（安全側フォールバック）
      setError(ERR_LOAD)
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [commitRows, day, propInputEnabled, propResidents])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 送信待ちの行の印を見直す（R6。未送信件数の通知を受けた時。読み込み直しはしない）。
   * 裏で送信が済んだ行（pendingRow が無い）は「⚠ 未送信」を外し、送った値をいまの値として出す（行 id・版は次の読み込みで
   * 取り直す）。送って止まった行（競合・拒否）は送信待ちの裁き（adoptStoreRows）で出し直す。まだ送信待ちの行はそのまま
   */
  const settleQueuedRows = useCallback(() => {
    const cur = rowsRef.current
    if (!cur.some((r) => r.state === 'queued')) return
    const next = cur.slice()
    let changed = false
    for (let i = 0; i < next.length; i++) {
      const row = next[i]
      if (row.state !== 'queued' || stillPending(row, day)) continue
      const target = targetOf(row, day)
      const p = target === null ? null : pendingRow('vitals', target)
      changed = true
      if (p !== null) {
        // 止まった（競合・拒否）: 送信待ちの裁きへ回す（下の adoptStoreRows）
        next[i] = { ...row, state: 'idle', message: '' }
        continue
      }
      const saved = { ...row.saved, ...(row.sent ?? {}) } as Record<Field, number | null>
      const buf = bufOf(saved)
      for (const f of FIELDS) if (row.edits?.[f] !== undefined) buf[f] = row.buf[f] // 送信待ちの後に打った値はそのまま
      next[i] = { ...row, saved, buf, sent: undefined, state: hasEdits(row.edits) ? 'idle' : 'saved', message: '' }
    }
    if (!changed) return
    adoptStoreRows(next, day)
    commitRows(next)
  }, [commitRows, day])

  // 未送信件数（送信失敗キュー）の可視化
  useEffect(() => {
    try {
      setPending(queuePending())
    } catch {
      setPending(0)
    }
    let unsub: (() => void) | null = null
    try {
      unsub = queueSubscribe((n) => {
        if (!aliveRef.current) return
        setPending(typeof n === 'number' && n >= 0 ? n : 0)
        // 裏で送信が済んだ・止まった行の「⚠ 未送信」を見直す（R6）
        settleQueuedRows()
      })
    } catch {
      unsub = null
    }
    return () => {
      if (unsub) {
        try {
          unsub()
        } catch {
          /* 解除失敗は表示に影響しないため無視する */
        }
      }
    }
  }, [settleQueuedRows])

  // ── フロア ─────────────────────────────────────────────────

  const floorOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of residents) set.add(floorOf(r.room))
    const nums = Array.from(set)
      .filter((f) => f !== FLOOR_OTHER)
      .sort()
      .map((f) => ({ value: f, label: `${f}階` }))
    if (set.has(FLOOR_OTHER)) nums.push({ value: FLOOR_OTHER, label: '居室未設定' })
    return nums
  }, [residents])

  // 復元値が現在の一覧に無い場合だけ既定（先頭）へ倒す
  useEffect(() => {
    if (floorOptions.length === 0) return
    if (floorOptions.some((o) => o.value === floor)) return
    setFloor(floorOptions[0].value)
  }, [floorOptions, floor])

  const residentById = useMemo(() => {
    const m = new Map<number, Resident>()
    for (const r of residents) m.set(r.id, r)
    return m
  }, [residents])

  const visibleRows = useMemo(
    () => rows.filter((row) => floorOf(residentById.get(row.residentId)?.room) === floor),
    [rows, residentById, floor],
  )

  // ── 保存 ───────────────────────────────────────────────────

  const askClear = useCallback((labels: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      // 未応答の確認が残っている状態で次の確認が来たら、先の待ちを「取りやめ」で解いてから
      // 差し替える。解かないとその保存が await のまま止まり、savingRef に利用者IDが残って
      // 以後その利用者の保存が（再読み込みまで）無言で全て弾かれる
      const prev = clearResolveRef.current
      clearResolveRef.current = resolve
      if (prev) prev(false)
      setClearAsk({ labels })
    })
  }, [])

  const patchRow = useCallback(
    (rowId: string, patch: Partial<GridRow>) => {
      commitRows(rowsRef.current.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)))
    },
    [commitRows],
  )

  /**
   * 保存が競合になった行だけを取り直し、最新の値で状態と一言（先の値／あなたの入力）を出し直す（指摘 U1）。
   * 取り直せない時・まだ行の無い再検は、値を出さない固定の文言のまま（stale の印を残す＝古い値を先の値にしない）
   */
  const refreshAfterConflict = useCallback(
    async (rowId: string) => {
      const row = rowsRef.current.find((r) => r.rowId === rowId)
      if (!row || (row.kind !== 'routine' && row.vitalId == null)) return
      let latest: Vital | null
      try {
        const got = await fetchLatestVital(
          row.kind === 'routine' || row.vitalId == null
            ? { routine: true, residentId: row.residentId, day }
            : { routine: false, id: row.vitalId },
        )
        latest = got?.row ?? null
      } catch {
        return
      }
      if (!aliveRef.current) return
      const cur = rowsRef.current.find((r) => r.rowId === rowId)
      if (!cur || cur.state !== 'conflict') return
      patchRow(rowId, mergeOnLoad(cur, latest ? rowFromVital(latest, cur.prev, cur.rowId) : null))
    },
    [day, patchRow],
  )

  /**
   * 保存が、他の端末の値と食い違って止まっている行にまとめられた（held＝送っていない）。その行を競合として見せる。
   * 止まっている値を「あなたの入力」として載せ、1行だけ取り直して先の値と並べる
   */
  const holdAsHeld = useCallback(
    async (rowId: string) => {
      const cur = rowsRef.current.find((r) => r.rowId === rowId)
      if (!cur) return
      const target = targetOf(cur, day)
      const p = target ? pendingRow('vitals', target) : null
      const edits = p ? adoptPending(cur.edits ?? {}, p) : (cur.edits ?? {})
      patchRow(rowId, { edits, buf: bufWithEdits(cur.buf, edits), state: 'conflict', message: MSG_BLOCKED_WRITE, stale: true })
      await refreshAfterConflict(rowId)
    },
    [day, patchRow, refreshAfterConflict],
  )

  /**
   * 保存の応答をその行へ当てる（通常の保存・〔新しい行として保存〕で共通。VitalsSheetPage.applySaveResult と同じ）。
   * 書けた欄・もう載っていた欄は、送った後に打ち直していなければ編集から消す。書かなかった欄は残して先の値と並べ、
   * 行が取り消されていたら「行が無い控え」にする。応答待ちの間に打った欄があれば続けて送る
   */
  const applySaveResult = useCallback(
    (rowId: string, row: GridRow, sendEdits: Edits<Field>, res: CellSaveResult<Vital>) => {
      const cur = rowsRef.current.find((r) => r.rowId === rowId)
      const missing = res.conflicts.length > 0 && res.conflicts.every((c) => c.reason === 'missing')
      const saved = res.row ? savedOf(res.row) : missing ? savedOf(null) : (cur?.saved ?? row.saved)
      const done = new Set<string>([...res.applied, ...res.settled])
      const doneEdits: Edits<Field> = {}
      for (const f of FIELDS) {
        const e = sendEdits[f]
        if (done.has(f) && e) doneEdits[f] = e
      }
      const remain = settleSent(cur?.edits ?? {}, doneEdits, saved)
      const nowBad = cur ? badCells(cur.buf) : []
      const buf = bufOf(saved)
      if (cur) for (const f of FIELDS) if (remain[f] !== undefined || nowBad.includes(f)) buf[f] = cur.buf[f]
      const common: Partial<GridRow> = {
        vitalId: res.row?.id ?? (missing && row.kind === 'routine' ? null : row.vitalId),
        rev: numOrNull(res.row?.rev) ?? (missing && row.kind === 'routine' ? 0 : row.rev),
        saved,
        buf,
        edits: remain,
        sent: undefined,
        stale: undefined,
      }
      if (res.conflicts.length > 0) {
        // 書かなかった欄がある。先の値（いまのサーバーの値）とあなたの入力を並べる（指摘 U1）
        const columns: ConflictColumn<Field>[] = res.conflicts
          .filter((c) => (FIELDS as string[]).includes(c.field))
          .map((c) => ({ field: c.field as Field, theirs: numOrNull(c.server), mine: numOrNull(c.mine) }))
        patchRow(rowId, {
          ...common,
          state: 'conflict',
          missing: missing ? true : undefined,
          message: missing ? missingRowText(describeEdits(remain)) : conflictStillText(columns),
        })
        return
      }
      patchRow(rowId, {
        ...common,
        missing: undefined,
        ...(res.row ? { clientKey: undefined } : {}),
        state: hasEdits(remain) ? 'idle' : nowBad.length > 0 ? 'invalid' : 'saved',
        message: badText(nowBad),
      })
      // 応答待ちの間に打った欄があれば続けて送る（積んでおく）
      if (hasEdits(remain)) enqueueSaveRef.current(rowId)
    },
    [patchRow],
  )

  /**
   * 1行を保存する（構造規約 R-E〜R-F・共通の仕組み src/lib/rowSync.ts。VitalsSheetPage.saveOne と同じ手順）。
   * 行ごとの順番待ちから呼ばれ、動き出した時点の最新の状態（edits・saved・rev）から計算し直す。
   * 送るのは edits の欄と基準だけ（入力欄と saved の差分は使わない）。書くかどうかはサーバーが欄ごとに決め、
   * 基準からサーバーの値が動いていれば書かずに競合を返す。成功したら送った欄だけを消し、触っていない欄は
   * サーバーの値で描き直す（空き欄を埋めた後も相手の体温が空欄に見えない・触っていない欄を「消す」と判定しない＝再審 E）
   */
  const saveRow = useCallback(
    async (rowId: string) => {
      const row = rowsRef.current.find((r) => r.rowId === rowId)
      if (!row) return
      // 競合中の行は、くらべて選ぶで選ぶまで保存しない（5画面共通の規約）。止めた旨と食い違いの併記を出す
      if (holdsNormalSave(row.state)) {
        patchRow(rowId, { message: conflictHoldText(knownColumns(row)) })
        return
      }
      const bad = badCells(row.buf)
      // 送信待ちの行は、送信待ちの内容が載った後の値を表示の基準にする（空にする確認・描き直しに使う）
      const server = row.state === 'queued' ? (row.sent ?? row.saved) : row.saved
      let edits = row.edits ?? {}
      const sendEdits: Edits<Field> = { ...edits }
      // 記録済みの値を空にする欄は確認を挟む（何の値を消すかを明記）。取りやめた欄は edits から外す
      const cleared = (Object.keys(sendEdits) as Field[]).filter((f) => sendEdits[f]?.value === null && server[f] != null)
      if (cleared.length > 0) {
        const ok = await askClear(cleared.map((f) => `${FIELD_LABEL[f]}（${fmtVitalValue(f, server[f])}）`).join('・'))
        if (!aliveRef.current) return
        if (!ok) {
          const cur = rowsRef.current.find((r) => r.rowId === rowId)
          if (!cur) return
          const buf = { ...cur.buf }
          const shownNow = cur.state === 'queued' ? (cur.sent ?? cur.saved) : cur.saved
          for (const f of cleared) {
            const v = shownNow[f]
            buf[f] = v == null ? '' : fmtNum(f, v)
            delete sendEdits[f]
          }
          edits = withoutFields(cur.edits ?? {}, cleared)
          patchRow(rowId, { buf, edits })
        }
      }
      if (Object.keys(sendEdits).length === 0) {
        // 送るものが無い（R-C）。送信待ちの行は送信待ちのまま。範囲外の入力が残っていれば警告のまま、無ければ通常へ戻す
        patchRow(
          rowId,
          row.state === 'queued'
            ? { edits }
            : bad.length > 0
              ? { edits, state: 'invalid', message: badText(bad) }
              : { edits, state: row.state === 'saved' ? 'saved' : 'idle', message: '' },
        )
        return
      }
      // 送り先。まだ行の無い再検は、この行に固有の冪等キーで指す（送信待ちの間に続けて入力してもまとまる）
      const clientKey = row.kind !== 'routine' && row.vitalId == null ? (row.clientKey ?? newClientKey()) : row.clientKey
      const target = targetOf({ ...row, clientKey }, day)
      if (target === null) return
      // 止まっている行を、読み直しで食い違いが無くなったのを確かめてから送り直す時は画面の基準で送る（rebase）
      const heldRow = pendingRow('vitals', target)
      const rebase = heldRow !== null && heldRow.state === 'conflict'
      const wasQueued = row.state === 'queued'
      patchRow(rowId, { edits, clientKey, state: 'saving', message: badText(bad) })
      try {
        const res = await saveVitalEdits(target, sendEdits, {
          // 新しい行の測定時刻・記入者は「空いていれば埋める」（既にある行では何も埋めない）
          ...(row.vitalId == null ? { fill: { measured_at: nowHM(), recorded_by: actorId ?? null } } : {}),
          rebase,
        })
        if (!aliveRef.current) return
        const cur = rowsRef.current.find((r) => r.rowId === rowId)
        if (res === 'queued') {
          // 送信待ちへ渡し終えた欄だけ消す。送信待ちの後に打つ値は、送った内容を基準に比べる（再審 low-2）
          const sentValues: Partial<Record<Field, number | null>> = {}
          for (const f of FIELDS) {
            const e = sendEdits[f]
            if (e) sentValues[f] = numOrNull(e.value)
          }
          const sent = { ...server, ...sentValues } as Record<Field, number | null>
          patchRow(rowId, {
            state: 'queued',
            message: wasQueued ? (cur?.message ?? MSG_QUEUED) : MSG_QUEUED,
            sent,
            edits: settleSent(cur?.edits ?? {}, sendEdits, sent),
          })
          return
        }
        if (res.held === true) {
          // 他の端末の値と食い違って止まっている行へまとめた（送っていない）。競合として見せる
          await holdAsHeld(rowId)
          return
        }
        applySaveResult(rowId, row, sendEdits, res)
      } catch (e) {
        if (!aliveRef.current) return
        // 保存失敗: edits は残す（R-D）。〔保存し直す〕で送り直せる
        patchRow(rowId, { state: 'error', message: e instanceof DbError && e.message ? e.message : ERR_SAVE })
      }
    },
    [actorId, applySaveResult, askClear, day, holdAsHeld, patchRow],
  )

  /** 行ごとの1本の順番待ち（構造規約 R-F）。保存・保存し直し・くらべて選ぶの3択はすべてここを通す */
  const rowQueue = useMemo(() => createRowQueue(), [])

  /**
   * くらべて選ぶの送信（〔先の値を残す〕〔自分の値で直す〕〔両方残す〕）。通常の保存と同じ順番待ちに通す。
   * 送信待ちで止まっている値の取り下げ・送り直しは ConflictResolver が db.ts へ頼む
   */
  const runResolverJob = useCallback(
    (rowId: string, job: () => Promise<void>) => rowQueue(rowId, job),
    [rowQueue],
  )
  /** 1行の保存を順番待ちに積む（積んだ時点の値は持ち越さず、動き出した時に最新から計算し直す） */
  const enqueueSave = useCallback(
    (rowId: string) => {
      void rowQueue(rowId, () => saveRow(rowId))
    },
    [rowQueue, saveRow],
  )
  const enqueueSaveRef = useRef<(rowId: string) => void>(() => undefined)
  useEffect(() => {
    enqueueSaveRef.current = enqueueSave
  }, [enqueueSave])

  /** 1名分（定時＋再検）をまとめて保存する（行ごとに順番待ちへ積む） */
  const saveResident = useCallback(
    (residentId: number) => {
      for (const r of rowsRef.current) if (r.residentId === residentId) enqueueSave(r.rowId)
    },
    [enqueueSave],
  )

  /**
   * 行が取り消されていた控えを、新しい行として保存する（〔新しい行として保存〕。行ごとの順番待ちを通す）。
   * 定時はその利用者・当日の新しい定時の行、それ以外は同じ種別の新しい行（冪等キー）。取り消された行の控えは外す
   */
  const saveAsNew = useCallback(
    (rowId: string) => {
      void rowQueue(rowId, async () => {
        const row = rowsRef.current.find((r) => r.rowId === rowId)
        if (!row || !row.missing) return
        const vals = valuesForBoth(FIELDS, editValues(row.edits ?? {}))
        const sendEdits: Edits<Field> = {}
        for (const f of Object.keys(vals) as Field[]) {
          const e = row.edits?.[f]
          if (e) sendEdits[f] = { ...e, base: null }
        }
        if (Object.keys(sendEdits).length === 0) return
        let target: VitalTarget
        let clientKey: string | undefined
        const newRow = row.kind !== 'routine'
        const old = newRow ? targetOf(row, day) : null
        // 取り消された行へ向けた送信待ち。定時以外は、新しい行が書けた・送信待ちに確保できた後で外す（F5）
        const oldPending = old ? pendingRow('vitals', old) : null
        if (!newRow) {
          target = { routine: true, residentId: row.residentId, day }
        } else {
          // その行の送信待ちにある値のある欄も、新しい行へ（基準 null＝F4）
          for (const f of FIELDS) {
            const v = oldPending?.values[f]
            if (sendEdits[f] === undefined && v !== null && v !== undefined) sendEdits[f] = { value: numOrNull(v), base: null, ver: 0 }
          }
          clientKey = newClientKey()
          target = { routine: false, clientKey, residentId: row.residentId, day, kind: row.kind as Exclude<VitalKind, 'routine'> }
        }
        patchRow(rowId, { state: 'saving', message: '', vitalId: row.kind === 'routine' ? row.vitalId : null, clientKey })
        try {
          // 同じ行の送信待ちの全ての欄を「空欄を見て書いた」（基準 null）にそろえて送る（F4）
          const res = await saveVitalEdits(target, sendEdits, {
            rebase: true,
            asNew: true,
            fill: { measured_at: nowHM(), recorded_by: actorId ?? null },
          })
          if (old && (res === 'queued' || (res.conflicts.length === 0 && res.held !== true))) {
            // 新しい行が書けた・送信待ちに確保できた後で、元の送信待ち（新しい行へ移した値の版）を外す（F5）
            await discardPendingRow('vitals', old, undefined, seenVers(oldPending, editValues(sendEdits)))
          }
          if (!aliveRef.current) return
          if (res === 'queued') {
            patchRow(rowId, { state: 'queued', message: MSG_QUEUED, missing: undefined, edits: undefined })
            return
          }
          applySaveResult(rowId, { ...row, vitalId: null, clientKey }, sendEdits, res)
        } catch (e) {
          // 拒否（例外）: 元の送信待ちは残す（F5）。新しい行の送信待ちは外し、画面は元の行の控えのまま
          if (newRow) void discardPendingRow('vitals', target)
          if (!aliveRef.current) return
          patchRow(rowId, {
            state: 'conflict',
            message: e instanceof DbError && e.message ? e.message : ERR_SAVE,
            ...(newRow ? { vitalId: row.vitalId, clientKey: row.clientKey } : {}),
          })
        }
      })
    },
    [actorId, applySaveResult, day, patchRow, rowQueue],
  )

  /** 行が取り消されていた控えを取り下げる（〔取り下げる〕。送信待ちからも外す） */
  const dropMissing = useCallback(
    (rowId: string) => {
      void rowQueue(rowId, async () => {
        const row = rowsRef.current.find((r) => r.rowId === rowId)
        if (!row) return
        const target = targetOf(row, day)
        // 画面が見せていた版だけ外す（第3段 #9。見た後に他のタブが入れた値は外さない）
        if (target) await discardPendingRow('vitals', target, undefined, seenVers(pendingRow('vitals', target), editValues(row.edits ?? {})))
        if (!aliveRef.current) return
        patchRow(rowId, { edits: undefined, missing: undefined, clientKey: undefined, state: 'idle', message: '', buf: bufOf(row.saved) })
      })
    },
    [day, patchRow, rowQueue],
  )

  // ── セル操作 ───────────────────────────────────────────────

  /** 入力中の値を行バッファへ書き戻す（次の操作へ移る前に必ず通す＝入力を落とさない） */
  const commitEditWith = useCallback(
    (value: string): GridRow[] => {
      const s = selRef.current
      const cur = rowsRef.current
      if (!s) return cur
      // 構造規約 R-E: この欄の基準は「キーパッドを出した時に画面に出ていた値」
      const startText = editBaseRef.current?.rowId === s.rowId && editBaseRef.current.field === s.field
        ? editBaseRef.current.text
        : null
      const next: GridRow[] = cur.map((r) => {
        if (r.rowId !== s.rowId) return r
        const buf = { ...r.buf, [s.field]: value }
        let edits = r.edits ?? {}
        const after = inputCells(buf)
        if (s.field in after) {
          const startCells = startText === null ? {} : inputCells({ ...r.buf, [s.field]: startText })
          const shown = r.state === 'queued' ? (r.sent ?? r.saved) : r.saved
          const base = s.field in startCells ? (startCells[s.field] ?? null) : shown[s.field]
          // 血圧の上と下は1つの組（F4）: 片側を直したら、相方も「いまの値のまま」として一緒に送る
          const other = pairOf(s.field) as Field | null
          edits = recordFieldEdit(edits, s.field, after[s.field] ?? null, base, other ? { base: shown[other] } : undefined)
        } else {
          edits = withoutFields(edits, [s.field]) // 範囲外に書き換えた＝前の編集はもう意図ではない
        }
        const touched = edits !== r.edits
        return {
          ...r,
          buf,
          edits,
          // 値を触ったら「保存済み」表示は下ろす（未保存を保存済みに見せない）
          state: touched && r.state === 'saved' ? 'idle' : r.state,
          message: touched && r.state === 'saved' ? '' : r.message,
        }
      })
      commitRows(next)
      return next
    },
    [commitRows],
  )

  const openCell = useCallback(
    (rowId: string, field: Field, value: string) => {
      const prev = selRef.current
      const next = commitEditWith(value)
      const prevResident = prev
        ? (next.find((r) => r.rowId === prev.rowId)?.residentId ?? null)
        : null
      const nextResident = next.find((r) => r.rowId === rowId)?.residentId ?? null
      if (prevResident != null && prevResident !== nextResident) {
        void saveResident(prevResident)
      }
      setSel({ rowId, field })
      selRef.current = { rowId, field }
      const shown = next.find((r) => r.rowId === rowId)?.buf[field] ?? ''
      // 編集を始めた時に画面に出ていた値を、この欄の基準として控える（構造規約 R-E）
      editBaseRef.current = { rowId, field, text: shown }
      setEdit(shown)
    },
    [commitEditWith, saveResident],
  )

  const closeKeypad = useCallback(
    (value: string) => {
      const s = selRef.current
      const next = commitEditWith(value)
      const residentId = s ? (next.find((r) => r.rowId === s.rowId)?.residentId ?? null) : null
      setSel(null)
      selRef.current = null
      setEdit('')
      if (residentId != null) void saveResident(residentId)
    },
    [commitEditWith, saveResident],
  )

  /** 確定して次のセルへ（右隣→行末なら次行の先頭）。次が無ければ閉じて保存する */
  const advanceWith = useCallback(
    (value: string) => {
      const s = selRef.current
      if (!s) return
      const idx = visibleRows.findIndex((r) => r.rowId === s.rowId)
      const fIdx = FIELDS.indexOf(s.field)
      if (idx < 0) {
        closeKeypad(value)
        return
      }
      if (fIdx + 1 < FIELDS.length) {
        openCell(s.rowId, FIELDS[fIdx + 1], value)
        return
      }
      const nextRow = visibleRows[idx + 1]
      if (!nextRow) {
        closeKeypad(value)
        return
      }
      openCell(nextRow.rowId, FIELDS[0], value)
    },
    [closeKeypad, openCell, visibleRows],
  )

  const onKey = useCallback((k: string) => {
    setEdit((cur) => {
      if (k === '⌫') return cur.slice(0, -1)
      if (k === '.' && cur.includes('.')) return cur
      if (cur.length >= MAX_INPUT_LEN) return cur
      return cur + k
    })
  }, [])

  /** 再検の行を1本足す（保存は他の行と同じ経路。id 無し＝insert される） */
  const addRecheck = useCallback(
    (residentId: number) => {
      const seq = draftSeq + 1
      setDraftSeq(seq)
      const prev = rowsRef.current.find((r) => r.residentId === residentId)?.prev ?? savedOf(null)
      const row: GridRow = {
        rowId: `d${residentId}-${seq}`,
        residentId,
        kind: 'recheck',
        vitalId: null,
        rev: 0,
        saved: savedOf(null),
        buf: emptyBuf(),
        prev,
        state: 'idle',
        message: '',
      }
      const cur = rowsRef.current
      // 同じ利用者の行の直後へ差し込む（居室順を崩さない）
      let at = cur.length
      for (let i = cur.length - 1; i >= 0; i--) {
        if (cur[i].residentId === residentId) {
          at = i + 1
          break
        }
      }
      commitRows([...cur.slice(0, at), row, ...cur.slice(at)])
    },
    [commitRows, draftSeq],
  )

  /** 未入力のまま増やした再検行だけを取り消す（保存済みの記録は消さない） */
  const removeDraftRow = useCallback(
    (rowId: string) => {
      if (selRef.current?.rowId === rowId) {
        setSel(null)
        selRef.current = null
        setEdit('')
      }
      commitRows(rowsRef.current.filter((r) => r.rowId !== rowId))
    },
    [commitRows],
  )

  // ── 食い違いをくらべて選ぶ ─────────────────────────────────

  /** 競合中の行を「くらべて選ぶ」画面で開く（開いた時点の入力で固定する） */
  const openCompare = useCallback(
    (rowId: string, name: string) => {
      const row = rowsRef.current.find((r) => r.rowId === rowId)
      if (!row || row.state !== 'conflict') return
      setCompare({
        rowId,
        target: {
          table: 'vitals',
          residentId: row.residentId,
          day,
          kind: row.kind,
          vitalId: row.vitalId,
        },
        name,
        // 見ていた値＝欄ごとの基準（キーパッドを出した時の値）。編集の無い欄はサーバーの値
        base: { ...editBases(row.edits ?? {}, row.saved) },
        mine: { ...mineOf(row) },
      })
    },
    [day],
  )

  // アプリ内の画面移動・再読み込み・タブを閉じる時に確認を出すための登録（App・beforeunload が参照する）
  useEffect(
    // 構造規約 R-G: 編集が1欄でも残る行（送信待ちの後・保存中に打った値、範囲外の警告中を含む）を数える
    () => registerUnsaved(() => rowsRef.current.some(holdsInput)),
    [],
  )

  /** 選んだ結果でその行を最新に描き直し、競合の表示を消す */
  const onResolved = useCallback(
    (r: ConflictResolution) => {
      const cur = compare
      setCompare(null)
      if (!cur) return
      if (r.choice === 'reload') {
        // 食い違いが無かった／先の記録が見つからない: 最新を読み込む（競合の行は mergeOnLoad が裁く）。
        // この経路でもフォーカスをその行の氏名のセルへ移す（再審 指摘8）
        focusAfterResolve(nameCellId(cur.rowId))
        void load()
        return
      }
      const row = rowsRef.current.find((x) => x.rowId === cur.rowId)
      if (!row) return
      // 送信待ちで止まっていた値の取り下げ・送り直しは ConflictResolver が済ませている
      const v = r.latest as Vital | null
      const saved = savedOf(v)
      const base: Partial<GridRow> = {
        vitalId: v ? v.id : row.vitalId,
        rev: v ? (numOrNull(v.rev) ?? row.rev) : row.rev,
        saved,
        buf: bufOf(saved),
        sent: undefined,
        edits: undefined,
        stale: undefined,
        missing: undefined,
      }
      if (r.choice === 'mine' && r.queued) {
        patchRow(cur.rowId, { ...base, state: 'queued', message: MSG_QUEUED, sent: saved })
        focusAfterResolve(nameCellId(cur.rowId))
        return
      }
      patchRow(cur.rowId, {
        ...base,
        state: r.choice === 'theirs' || (r.choice === 'both' && r.queued) ? 'idle' : 'saved',
        message: r.choice === 'both' && r.queued ? MSG_BOTH_QUEUED : '',
      })
      // 〔くらべて選ぶ〕が消えるので、フォーカスをその行の氏名のセルへ移す（body へ落とさない）
      focusAfterResolve(nameCellId(cur.rowId))
      // 両方残す: 新しい再検の行を出すため取り直す（未送信・失敗の行の入力は KEEP で引き継がれる）
      if (r.choice === 'both' && !r.queued) void load()
    },
    [compare, load, patchRow],
  )

  // ── 表示用の値 ─────────────────────────────────────────────

  /** 入力できるか（入力解禁・サーバー側の更新待ちでない） */
  const canInput = inputEnabled && !cellsMissing
  const selRow = sel ? rows.find((r) => r.rowId === sel.rowId) ?? null : null
  const selResident = selRow ? residentById.get(selRow.residentId) ?? null : null

  // キーパッドを出している欄を Presence へ伝える（欄が変わった時だけ。打鍵では配らない）
  const selTarget: CellTarget | null =
    sel && selRow && canInput ? vitalTarget(day, selRow, sel.field) : null
  const selTargetRef = useRef(selTarget)
  selTargetRef.current = selTarget
  const selTargetKey = selTarget ? cellKey(selTarget) : null
  const { enter: presenceEnter } = presence
  useEffect(() => {
    const t = selTargetRef.current
    if (!t) return
    // 欄が変わる・キーパッドを閉じる時に、入った時に配った欄そのものを取り消す
    return presenceEnter(focusOf(t))
  }, [selTargetKey, presenceEnter])
  const editParsed = sel ? normalizeVitalInput(edit, sel.field) : null
  const editInvalid = sel != null && editParsed != null && outOfRange(sel.field, editParsed)

  const savingCount = rows.filter((r) => r.state === 'saving').length
  const savedCount = rows.filter((r) => r.state === 'saved').length

  const statusText =
    savingCount > 0
      ? `↻ 保存中 ${savingCount}件`
      : pending > 0
        ? `⚠ 未送信 ${pending}件`
        : savedCount > 0
          ? `✓ 保存済み ${savedCount}件`
          : '未保存の変更はありません'

  // ── 描画 ───────────────────────────────────────────────────

  if (loading && rows.length === 0) {
    return <LoadingBlock label="バイタルの一覧を読み込んでいます…" />
  }

  if (error && rows.length === 0) {
    return <ErrorBlock message={error} onRetry={() => void load()} />
  }

  return (
    <div className={sel ? 'pb-80' : 'pb-4'}>
      <div className="border-b border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-gap">
          <h1 className="text-xl font-bold text-ink">
            バイタル一括入力
            <span className="tabular ml-2 text-base font-normal text-ink2">
              {fmtDayLabel(day)}
            </span>
          </h1>
          <p
            role="status"
            aria-live="polite"
            className={
              pending > 0
                ? 'text-base font-bold text-warn'
                : savingCount > 0
                  ? 'text-base text-ink2'
                  : 'text-base text-ok'
            }
          >
            {statusText}
          </p>
        </div>

        {gateUnknown ? (
          // 観測できていない＝「スプシ期間」と決めつけない。通信エラーとして再確認の導線を出す
          <div role="alert" className="mt-3 rounded border border-warn bg-warn-bg p-3">
            <p className="text-base text-ink">
              <span aria-hidden="true">▲ </span>
              {MSG_GATE_UNKNOWN}
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary"
            >
              もう一度確認する
            </button>
          </div>
        ) : !inputEnabled ? (
          <p
            role="status"
            className="mt-3 rounded border border-warn bg-warn-bg p-3 text-base text-ink"
          >
            <span aria-hidden="true">▲ </span>
            {MSG_BLOCKED}
          </p>
        ) : cellsMissing ? (
          <p
            role="status"
            className="mt-3 rounded border border-warn bg-warn-bg p-3 text-base text-ink"
          >
            <span aria-hidden="true">▲ </span>
            {CELLS_PENDING_REASON}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="mt-3 text-base text-danger">
            <span aria-hidden="true">▲ </span>
            {error}
          </p>
        ) : null}

        {floorOptions.length > 1 ? (
          <div className="mt-3">
            <SegmentPicker
              options={floorOptions}
              value={floor}
              onChange={(v) => {
                closeKeypad(edit)
                setFloor(v)
                writeFloor(v)
              }}
              ariaLabel="フロアを選ぶ"
            />
          </div>
        ) : null}
      </div>

      {/* 他の端末が入力中の欄の要約（誰が・どこを）。無い時も1行の高さを取る＝出ても表を押し下げない */}
      <div className="px-4 pt-1">
        <PresenceSummary
          text={presence.summary((p) => {
            if (p.cell.table !== 'vitals' || p.day !== day || !(FIELDS as string[]).includes(p.cell.field)) return null
            if (!visibleRows.some((r) => r.residentId === p.residentId)) return null
            const kind = p.cell.kind ?? 'routine'
            const name = residentById.get(p.residentId)?.name ?? ''
            return `${name}${kind === 'routine' ? '' : ` ${KIND_LABEL[kind]}`} ${FIELD_LABEL[p.cell.field as Field]}`
          })}
        />
      </div>

      {residents.length === 0 ? (
        <div className="p-4">
          <EmptyBlock
            message="利用者の一覧がまだありません。設定タブでマスタ同期を実行してください。"
            actionLabel="読み込み直す"
            onAction={() => void load()}
          />
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="p-4">
          <EmptyBlock message="このフロアに対象の利用者がいません。上のボタンでフロアを切り替えてください。" />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-base">
            <caption className="sr-only">
              {fmtDayLabel(day)}の定時バイタル入力表（居室昇順）
            </caption>
            <thead>
              <tr className="border-b border-border-strong bg-surface2 text-left">
                <th scope="col" className="w-14 px-2 py-2 text-sm font-bold text-ink2">
                  居室
                </th>
                <th scope="col" className="min-w-24 px-2 py-2 text-sm font-bold text-ink2">
                  氏名
                </th>
                {FIELDS.map((f) => (
                  <th key={f} scope="col" className="w-24 px-2 py-2 text-sm font-bold text-ink2">
                    <span aria-hidden="true">{FIELD_HEAD[f]}</span>
                    <span className="sr-only">{FIELD_LABEL[f]}</span>
                  </th>
                ))}
                <th scope="col" className="w-24 px-2 py-2 text-sm font-bold text-ink2">
                  再検
                </th>
                <th scope="col" className="w-24 px-2 py-2 text-sm font-bold text-ink2">
                  保存
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const resident = residentById.get(row.residentId)
                const isDraft = row.vitalId == null
                const isEmptyDraft =
                  isDraft && FIELDS.every((f) => row.buf[f] === '') && row.kind !== 'routine'
                return (
                  <FragmentRow
                    key={row.rowId}
                    row={row}
                    residentName={resident?.name ?? ''}
                    room={resident?.room ?? null}
                    inputEnabled={canInput}
                    sel={sel}
                    edit={edit}
                    day={day}
                    presence={presence}
                    onOpenCell={(field) => openCell(row.rowId, field, edit)}
                    onAddRecheck={() => addRecheck(row.residentId)}
                    onRemoveDraft={isEmptyDraft ? () => removeDraftRow(row.rowId) : null}
                    onReload={() => void load()}
                    onCompare={() => openCompare(row.rowId, resident?.name ?? '')}
                    onResave={() => enqueueSave(row.rowId)}
                    onSaveNew={() => saveAsNew(row.rowId)}
                    onDrop={() => dropMissing(row.rowId)}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {sel && selRow && canInput ? (
        <div className="fixed inset-x-0 bottom-14 z-40 border-t border-border-strong bg-surface p-3 lg:bottom-0">
          <div className="mx-auto max-w-md">
            <div className="mb-2 flex items-baseline justify-between gap-gap">
              <p className="text-base text-ink2">
                <span className="tabular">{selResident?.room ?? '—'}</span>
                <span className="ml-2 font-bold text-ink">{selResident?.name ?? ''}</span>
                {selRow.kind !== 'routine' ? (
                  <span className="ml-2 text-sm text-ink3">（{KIND_LABEL[selRow.kind]}）</span>
                ) : null}
                <span className="ml-2">{FIELD_LABEL[sel.field]}</span>
              </p>
              <p className="tabular text-xl font-bold text-ink" aria-live="polite">
                {edit === '' ? '—' : edit}
                <span className="ml-1 text-sm font-normal text-ink2">{FIELD_UNIT[sel.field]}</span>
              </p>
            </div>

            {editInvalid ? (
              <p
                role="alert"
                className="mb-2 rounded border border-warn bg-warn-bg p-2 text-base text-ink"
              >
                <span aria-hidden="true">▲ </span>
                入力値を確認してください（{rangeText(sel.field)}）。
              </p>
            ) : null}

            <div className="flex gap-gap">
              <div className="grid grid-cols-3 gap-gap">
                {KEYPAD_KEYS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => onKey(k)}
                    aria-label={k === '⌫' ? '1文字消す' : k === '.' ? '小数点' : k}
                    className="min-h-16 w-14 rounded border border-border-strong bg-surface2 text-xl font-bold text-ink"
                  >
                    {k}
                  </button>
                ))}
              </div>
              <div className="flex flex-1 flex-col gap-gap">
                <button
                  type="button"
                  onClick={() => {
                    if (!editInvalid) advanceWith(edit)
                  }}
                  aria-disabled={editInvalid}
                  className={
                    editInvalid
                      ? 'min-h-16 rounded border border-border bg-surface2 px-3 text-base text-ink3'
                      : 'min-h-16 rounded border border-primary bg-primary px-3 text-base font-bold text-primary-ink'
                  }
                >
                  <span aria-hidden="true">✓ </span>
                  確定して次へ
                </button>
                <button
                  type="button"
                  onClick={() => advanceWith('')}
                  className="min-h-tap rounded border border-border-strong px-3 text-base text-ink"
                >
                  <span aria-hidden="true">— </span>
                  未測定のまま次へ
                </button>
                <button
                  type="button"
                  onClick={() => closeKeypad(edit)}
                  className="min-h-tap rounded border border-border-strong px-3 text-base text-ink"
                >
                  閉じて保存する
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <ConflictResolver
        target={compare?.target ?? null}
        residentName={compare?.name ?? ''}
        base={compare?.base ?? {}}
        mine={compare?.mine ?? {}}
        actorId={actorId ?? null}
        serialize={compare ? (job) => runResolverJob(compare.rowId, job) : undefined}
        onClose={() => setCompare(null)}
        onResolved={onResolved}
      />

      <ConfirmDialog
        open={clearAsk != null}
        title="記録済みの値を空にしますか"
        body={
          clearAsk
            ? `${clearAsk.labels} を空（未測定）にして保存します。取りやめる場合は「キャンセル」を押してください（元の値に戻ります）。`
            : undefined
        }
        confirmLabel="空にして保存する"
        danger
        onConfirm={() => {
          setClearAsk(null)
          const resolve = clearResolveRef.current
          clearResolveRef.current = null
          resolve?.(true)
        }}
        onCancel={() => {
          setClearAsk(null)
          const resolve = clearResolveRef.current
          clearResolveRef.current = null
          resolve?.(false)
        }}
      />
    </div>
  )
}

// ── 1行（＋その行のメッセージ行） ─────────────────────────────

interface FragmentRowProps {
  row: GridRow
  residentName: string
  room: string | null
  inputEnabled: boolean
  sel: { rowId: string; field: Field } | null
  edit: string
  /** この画面の日（今日） */
  day: string
  /** 他の端末が入力中の欄・行の表示（Presence） */
  presence: CellPresence
  onOpenCell: (field: Field) => void
  onAddRecheck: () => void
  onRemoveDraft: (() => void) | null
  onReload: () => void
  /** 競合中の行を「くらべて選ぶ」画面で開く */
  onCompare: () => void
  /** 未保存・保存失敗の行の編集を送り直す */
  onResave: () => void
  /** 行が取り消されていた控えを新しい行として保存する */
  onSaveNew: () => void
  /** 行が取り消されていた控えを取り下げる */
  onDrop: () => void
}

/** Presence の照合に使う欄（定時は自然キー、定時以外は行 id。まだ行が無い枠は id なし） */
function vitalTarget(day: string, row: GridRow, field: Field): CellTarget {
  return {
    table: 'vitals',
    day,
    residentId: row.residentId,
    field,
    kind: row.kind,
    id: row.kind === 'routine' ? null : row.vitalId,
  }
}

const STATE_MARK: Record<RowState, string> = {
  idle: '',
  saving: '↻ 保存中',
  saved: '✓ 保存済',
  queued: '⚠ 未送信',
  conflict: '▲ 競合',
  error: '▲ 未保存',
  invalid: '▲ 要確認',
}

const STATE_STYLE: Record<RowState, string> = {
  idle: 'text-ink3',
  saving: 'text-ink2',
  saved: 'text-ok',
  queued: 'text-warn',
  conflict: 'text-danger',
  error: 'text-danger',
  invalid: 'text-warn',
}

function FragmentRow({
  row,
  residentName,
  room,
  inputEnabled,
  sel,
  edit,
  day,
  presence,
  onOpenCell,
  onAddRecheck,
  onRemoveDraft,
  onReload,
  onCompare,
  onResave,
  onSaveNew,
  onDrop,
}: FragmentRowProps) {
  const isRoutine = row.kind === 'routine'
  // 他の端末がこの利用者のどこかの欄を入力中（氏名の行に出す＝欄が画面外でも気づける）
  const rowBusy = isRoutine ? presence.rowBusy('vitals', day, row.residentId) : null
  return (
    <>
      <tr className="border-b border-border align-middle">
        <td className="tabular px-2 text-sm text-ink2">{isRoutine ? (room ?? '—') : ''}</td>
        {/* 食い違いを解決した後のフォーカスの戻り先（タブ順には入れない） */}
        <td className="px-2" id={nameCellId(row.rowId)} tabIndex={-1}>
          <span className="block truncate text-base font-bold text-ink">
            {isRoutine ? residentName : ''}
            {/* 他の端末がこの方の欄を入力中（「✎」・読み上げは「入力中: 職員B」） */}
            {rowBusy !== null ? <RowBusyMark text={rowBusy} /> : null}
          </span>
          {!isRoutine ? (
            <span className="text-sm text-ink2">
              <span aria-hidden="true">↳ </span>
              {KIND_LABEL[row.kind]}
              <span className="sr-only">：{residentName}</span>
            </span>
          ) : null}
        </td>
        {FIELDS.map((f) => {
          const selected = sel?.rowId === row.rowId && sel.field === f
          const raw = selected ? edit : row.buf[f]
          const parsed = normalizeVitalInput(raw, f)
          const bad = parsed != null && outOfRange(f, parsed)
          const prev = row.prev[f]
          // 他の端末がこの欄を入力中（枠＋文字。読み上げは aria-describedby）
          const busy = presence.cellBusy(vitalTarget(day, row, f))
          const busyId = `vg-busy-${row.rowId}-${f}`
          return (
            <td key={f} className="px-1 py-1">
              <button
                type="button"
                disabled={!inputEnabled}
                onClick={() => onOpenCell(f)}
                aria-label={`${room ?? '居室未設定'} ${residentName} ${KIND_LABEL[row.kind]} ${FIELD_LABEL[f]}${
                  raw === '' ? '　未入力' : `　${raw}`
                }`}
                aria-describedby={busy ? busyId : undefined}
                className={[
                  busy ? `relative ${BUSY_RING}` : '',
                  'min-h-14 w-full rounded px-1 text-center text-base',
                  selected
                    ? 'border-2 border-primary bg-accent-bg text-ink'
                    : bad
                      ? 'border border-warn bg-warn-bg text-ink'
                      : 'border border-border bg-surface text-ink',
                  inputEnabled ? '' : 'text-ink3',
                ].join(' ')}
              >
                {raw === '' ? (
                  prev != null ? (
                    <span className="tabular block text-sm text-ink3">
                      <span aria-hidden="true">前回{fmtNum(f, prev)}</span>
                      <span className="sr-only">未入力（前回の値 {fmtNum(f, prev)}）</span>
                    </span>
                  ) : (
                    <span className="tabular block text-ink3">
                      <span aria-hidden="true">—</span>
                      <span className="sr-only">未測定</span>
                    </span>
                  )
                ) : parsed == null || selected || bad ? (
                  <span className="tabular block font-bold">{raw}</span>
                ) : (
                  <LevelCell value={parsed} level={LEVEL_FN[f](parsed)} digits={FIELD_DIGITS[f]} />
                )}
                {busy ? <BusyMark busy={busy} id={busyId} /> : null}
              </button>
            </td>
          )
        })}
        <td className="px-1 py-1">
          {isRoutine ? (
            <button
              type="button"
              disabled={!inputEnabled}
              onClick={onAddRecheck}
              aria-label={`${room ?? '居室未設定'} ${residentName} の再検を追加する`}
              className="min-h-tap w-full rounded border border-border-strong px-2 text-base text-ink"
            >
              <span aria-hidden="true">＋</span>再検
            </button>
          ) : onRemoveDraft ? (
            <button
              type="button"
              onClick={onRemoveDraft}
              aria-label={`${residentName} の追加した再検の行を取り消す`}
              className="min-h-tap w-full rounded border border-border px-2 text-base text-ink2"
            >
              取消
            </button>
          ) : null}
        </td>
        <td className="px-1 py-1">
          <span className={`text-sm ${STATE_STYLE[row.state]}`}>{STATE_MARK[row.state]}</span>
        </td>
      </tr>
      {row.message ? (
        <tr className="border-b border-border">
          <td colSpan={FIELDS.length + 4} className="px-2 py-2">
            <p
              role="alert"
              className={
                row.state === 'conflict' || row.state === 'error'
                  ? 'text-base text-danger'
                  : 'text-base text-warn'
              }
            >
              <span aria-hidden="true">▲ </span>
              {row.message}
              {/* 送信待ちの MSG_QUEUED は自動送信を待つだけなので出さない */}
              {row.state === 'conflict' ? (
                <button
                  type="button"
                  onClick={onReload}
                  className="ml-2 min-h-tap rounded border border-danger px-3 text-base font-bold text-danger"
                >
                  読み込み直す
                </button>
              ) : null}
              {/* 未保存・保存失敗の編集を送り直す（同じ値を入れ直しても送られないため、ボタンで送る） */}
              {row.state === 'error' && hasEdits(row.edits) && inputEnabled ? (
                <button
                  type="button"
                  onClick={onResave}
                  aria-label={`${residentName} ${KIND_LABEL[row.kind]}のまだ保存していない入力を保存し直す`}
                  className="ml-2 min-h-tap rounded border border-primary px-3 text-base font-bold text-primary"
                >
                  保存し直す
                </button>
              ) : null}
              {/* 行が取り消されていた控え: 新しい行として保存するか、取り下げる（日報の「行が無い控え」と同じ） */}
              {row.state === 'conflict' && row.missing ? (
                <>
                  <button
                    type="button"
                    disabled={!inputEnabled}
                    onClick={onSaveNew}
                    aria-label={`${residentName} ${KIND_LABEL[row.kind]}のまだ保存していない入力を新しい行として保存する`}
                    className="ml-2 min-h-tap rounded border border-primary px-3 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
                  >
                    新しい行として保存
                  </button>
                  <button
                    type="button"
                    onClick={onDrop}
                    aria-label={`${residentName} ${KIND_LABEL[row.kind]}のまだ保存していない入力を取り下げる`}
                    className="ml-2 min-h-tap rounded border border-border-strong px-3 text-base text-ink"
                  >
                    取り下げる
                  </button>
                </>
              ) : null}
              {/* 食い違いを並べて、どちらを残すか選ぶ（既存の「読み込み直す」はそのまま残す） */}
              {row.state === 'conflict' && !row.missing ? (
                <button
                  type="button"
                  onClick={onCompare}
                  aria-label={`${residentName} ${KIND_LABEL[row.kind]}の食い違いをくらべて選ぶ`}
                  className="ml-2 min-h-tap rounded border border-primary px-3 text-base font-bold text-primary"
                >
                  くらべて選ぶ
                </button>
              ) : null}
            </p>
          </td>
        </tr>
      ) : null}
    </>
  )
}

export default VitalsGridPage
