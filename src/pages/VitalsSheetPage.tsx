// スプシ「バイタル1階/2階」タブの再現（横に複数日）。
// 契約: docs/design/sheet-contracts.md §6 ／ 既存契約: docs/design/contracts.md
//
// 実装方針（契約の要点をそのまま構造にする）:
// - 操作バー: フロア(1階/2階/全) | 日数(1/4/7/11・既定4) | ‹ 期間 › | ZoomBar
// - 表: 居室・入居者名の2列は sticky で左固定、見出し2行は sticky で上固定
// - 1日 = 体温 / 血圧(上) / 血圧(下) / 脈 / SpO2 の5列。**新しい日が左**
// - 再検枠（kind='recheck'）は**既定では出さない**（2026-08-28 追加指示1）。
//   氏名欄の右の「再検」ボタンを押すと、その入居者の直下に1本ずつ生える（画面内の状態・保存しない）。
//   **記録がある入居者・日は隠さない**＝保存済みの本数＋空行1本を必ず出し、
//   末尾の空行に入力されたら次の空行が生える（既存の挙動をそのまま維持する）。
//   押し間違いで出した枠は、その入居者の**一番下の空の枠**の右端の「✕」で消せる
//   （2026-08-28 追加指示。記録のある枠・途中の枠は消せない＝記録を隠さない・番号をずらさない。
//    消すのは画面の行だけで、サーバーの記録には一切触らない）
// - 日付見出しは土曜＝濃い水色（.sheet-sat）・日曜＝赤（.sheet-sun）。曜日は日付文字
//   （8/29（土））にも出るので色は補助（色だけで意味を伝えない）
// - 行は1行おきに薄いグレー（.sheet-alt）。縞は**行（tr）が持ち**、しきい値の色は
//   **セル（td）が持つ**ので、意味のある色が縞に負けない
// - セル直接編集。確定値は normalizeVitalInput（「365」→36.5・全角→半角）を通す
// - VITAL_RANGE 外はその日のインライン警告を出し、その項目は保存しない
// - **空欄と「数字として読めない入力」は別物として扱う**。空欄だけが「消す意思」で、
//   読めない入力（打ち間違い）はインライン警告を出して保存せず、打った文字はセルに残す
//   （normalizeVitalInput はどちらも null を返すので、空欄かどうかは buf の生値で判定する）
// - しきい値超過は SheetCell の level（背景色＋記号 ↑↑ ↑ ↓ ↓↓）で示す（色だけで意味を伝えない）
// - 保存は1名1日単位で saveVitalEdits（送信待ち → RPC apply_cell_edits の1本・2026-09-23 フェーズ2'）。
//   送るのは利用者が編集した欄と、その欄を直し始めた時に出ていた値（基準）だけ。書くかどうかは
//   サーバーが行ロックの下で欄ごとに決める（いまの値＝あなたの値なら済み／基準のままなら書く／それ以外は競合）。
//   rowSync の planEdits・reconcileOnLoad は画面の事前の見せ方（読み直しの裁き）にだけ使う
// - 送信待ち・止まっている行（競合・拒否）は db.ts の pendingRow から読み、再読み込み・再マウントの後も出す
// - 記録済みの値を空にする操作は確認ダイアログを挟む（空上書き保護・dev-principles 原則4）
// - 他の端末の変更は subscribeChanges で受け、表示中の期間に入る vitals の変更だけを合図に
//   既存の load() を呼び直す（＝入力中・未送信・競合・応答待ちのセルは load() の温存で守られる）。
//   自分の保存の直後は自分が出した通知なので取り直さない。応答待ちのセルが残っている間は
//   取り直しを先送りする（保存の応答と読み込みが交差して古い値で描き直すのを避ける）
// - 入力解禁フラグ（native_input_enabled）が false の間は編集不可＋理由文（閲覧は可能）
// - UI 状態（フロア・日数）だけを localStorage に保存する。氏名・記録値・日付は保存しない
// - 個人情報は console にも localStorage にも出さない

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DbError,
  discardPendingRow,
  fetchLatestVital,
  fetchResidents,
  fetchVitalsSheet,
  isSelfWrite,
  getNativeInputGate,
  newClientKey,
  pendingRow,
  queuePending,
  queueSubscribe,
  saveVitalEdits,
  subscribeChanges,
} from '../lib/db'
import type { CellSaveResult, PendingCellRow, VitalTarget } from '../lib/db'
import { addDays, fmtDayLabel, normalizeVitalInput, todayIso, toHalfWidth } from '../lib/format'
import {
  diaBpLevel,
  LS,
  pulseLevel,
  SHEET_DAYS,
  spo2Level,
  sysBpLevel,
  tempLevel,
  VITAL_RANGE,
} from '../lib/types'
import type { Level, Resident, SheetDays, Vital } from '../lib/types'
import { getActorId } from '../lib/actor'
import {
  ConfirmDialog,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  SegmentPicker,
} from '../components/ui'
import { readSheetPref, SheetCell, SheetFrame, writeSheetPref, ZoomBar } from '../components/sheet'
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
import { LEAVE_TITLE, registerUnsaved } from '../lib/leaveGuard'
import { focusOf, useCellPresence } from '../hooks/useCellPresence'
import type { CellPresence } from '../hooks/useCellPresence'
import type { CellTarget } from '../lib/presence'
import { PresenceSummary, RowBusyMark } from '../components/presence'
import '../styles/sheet.css'

// ── 定数 ─────────────────────────────────────────────────────

type Field = 'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2'

/** 1日ブロックの列の並び（契約 §6「体温 血圧(上) 血圧(下) 脈 SpO2」） */
const FIELDS: Field[] = ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2']

/**
 * 見出しの表記。列幅を「値＋記号が収まる最小」まで詰めるため、血圧は「上」「下」と短くする
 * （2026-08-28 指示「記入欄を狭くして1画面により多くの日を出す」）。
 * 血圧の列であることは日付ブロックの並び（体温→上→下→脈→SpO2）と、
 * 読み上げ用の正式名（FIELD_LABEL・sr-only）が担保する。
 */
const FIELD_HEAD: Record<Field, string> = {
  temp: '体温',
  sys_bp: '上',
  dia_bp: '下',
  pulse: '脈',
  spo2: 'SpO2',
}
const FIELD_LABEL: Record<Field, string> = {
  temp: '体温',
  sys_bp: '血圧（上）',
  dia_bp: '血圧（下）',
  pulse: '脈拍',
  spo2: 'SpO2',
}
/**
 * 寸法はすべて sheet.css の CSS 変数を参照する（px 直書き・Tailwind の arbitrary value を使わない）。
 * MealsSheetPage・SheetCell と同じ書き方に揃える。
 */
const FIELD_WIDTH: Record<Field, string> = {
  temp: 'var(--w-temp)',
  sys_bp: 'var(--w-sys)',
  dia_bp: 'var(--w-dia)',
  pulse: 'var(--w-pulse)',
  spo2: 'var(--w-spo2)',
}
const W_ROOM = 'var(--w-room)'
const W_NAME = 'var(--w-name)'
const ROW_H = 'var(--sheet-row-h)'
const HEAD_H = 'var(--sheet-head-h)'
const SHEET_FONT = 'var(--sheet-font)'

/**
 * 自前で描くセルの基本クラス（SheetCell の td と同じ見た目に揃える）。
 * 表は border-collapse: separate（sheet.css の .sheet-table）なので、罫線は右・下だけに引く。
 * 全周に引くと隣のセルの罫線と並んで 2px になる。表の左端・上端は table 側の border で描く。
 */
const CELL_BASE = 'border-b border-r border-border p-0 px-1 align-middle'
/**
 * 日付ブロックの切れ目。**各日の「最後の列」（SpO2）の右罫線を濃くする**（sheet.css の .sheet-group-end）。
 * 最初の列に左罫線を足す方式は、左隣のセルの右罫線と並んで 2px になるため使わない
 * （色だけを当てる書き方は border-left-width が 0 のままで線にならない）。
 */
const DAY_END = 'sheet-group-end'
/**
 * 1行おきの縞（sheet.css の .sheet-alt）。**行（tr）に当てる**。
 * セルが背景を持つと縞が隠れるので、日付のセルは SheetCell の tone='row'（背景なし）で描き、
 * 左固定の2列（居室・氏名）だけは縞と同じ不透明な背景を自分で持つ
 * （sticky で他の列の上に重なるため、透明だと下の列が透けて読めなくなる）。
 * しきい値の色は SheetCell が td 側に置くので、縞より上に来る＝意味のある色が負けない。
 */
const ROW_ALT = 'sheet-alt'
/** 縞なしの行の地色（従来どおり面の色）。alt 行と同じ要素に両方は当てない */
const ROW_PLAIN = 'bg-surface'
const FIELD_DIGITS: Record<Field, number> = { temp: 1, sys_bp: 0, dia_bp: 0, pulse: 0, spo2: 0 }
const LEVEL_FN: Record<Field, (v: number | null) => Level> = {
  temp: tempLevel,
  sys_bp: sysBpLevel,
  dia_bp: diaBpLevel,
  pulse: pulseLevel,
  spo2: spo2Level,
}

/** この画面が扱う行の種別（発熱者=observation・他症状者=symptom は日報シートの担当） */
type RowKind = 'routine' | 'recheck'
const KIND_LABEL: Record<RowKind, string> = { routine: '定時', recheck: '再検' }
/** この画面に出す種別（行見出しの「入力中」はこの種別の欄だけを数える） */
const SHEET_KINDS: readonly RowKind[] = ['routine', 'recheck']

/** フロア絞り込みの「全」 */
const FLOOR_ALL = 'all'
/** 居室が未設定の入居者を入れるフロア区分 */
const FLOOR_OTHER = 'other'

/** 横並びする日数の既定（契約 §6: バイタルは4日） */
const DEFAULT_DAYS: SheetDays = 4

/**
 * 他端末の変更通知をまとめる待ち時間（ミリ秒）。連続して届いた通知は最後の1回だけ取り直す
 * （1名ぶんの保存でも複数行の通知が来るため。同型の実装は useTimeline.ts の REALTIME_DEBOUNCE_MS）。
 */
const REALTIME_DEBOUNCE_MS = 1500
/**
 * 自分の保存で出た通知を無視する時間（ミリ秒）。自分の書き込みは画面へ反映済みなので、
 * 取り直すと保存直後に打った値を無駄に描き直す危険だけが残る（日報シートと同じ 3 秒）。
 */
/**
 * 画面を離れていた時間がこれを超えたら、戻った時に取り直す。
 * 短い切替（別アプリを一瞬見る）で毎回取りに行くと、軽さを損なうだけで得るものが無い。
 */
const AWAY_REFETCH_MS = 30_000
/** この画面が描画する表（食事・水分・申し送りの変更では取り直さない） */
const WATCHED_TABLE = 'vitals'
/** 変更通知の行が持つ日付の列（この画面が横に並べている日と突き合わせる） */
const WATCHED_DAY_COL = 'measured_on'

const ERR_LOAD =
  'バイタル一覧を読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'
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
  'この日には、他の端末の値と食い違って止まっている保存があります。いまの入力もそこにまとめました（まだ送っていません・入力は消えていません）。「くらべて選ぶ」でどちらを残すか選んでください。'
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
  return `この日の入力はまだ保存していません（入力は消えていません）。${detail}「くらべて選ぶ」でどちらを残すか選んでください。`
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

/**
 * 変更通知に添えられた行から日付（measured_on）を取る。
 * 受信データを信じない（型検査して読めない値は null＝「分からない」）。db.ts の契約では
 * `{ event: string; row: Record<string, unknown> | null }` が来るが、購読側は unknown として
 * 受け取り、形が変わっても画面が壊れないようにする（旧形式＝第2引数なしも通る）。
 */
function changedDay(info: unknown): string | null {
  if (typeof info !== 'object' || info === null) return null
  const row = (info as { row?: unknown }).row
  if (typeof row !== 'object' || row === null) return null
  const day = (row as Record<string, unknown>)[WATCHED_DAY_COL]
  return typeof day === 'string' && day !== '' ? day : null
}

/** 居室文字列から階を取る（'102'→'1'）。数字が無い・未設定は FLOOR_OTHER */
function floorOf(room: string | null | undefined): string {
  if (!room) return FLOOR_OTHER
  const m = /\d/.exec(room)
  return m ? m[0] : FLOOR_OTHER
}

/**
 * 日付見出しのセルに当てる色。土曜＝濃い水色・日曜＝赤（sheet.css の .sheet-sat / .sheet-sun）。
 * 平日は従来どおり見出し帯の色。曜日は日付の文字（8/29（土））にも出ているので色は補助。
 * format.ts は凍結契約で曜日を返す関数が無いため、ここで日付から取る
 * （壊れた日付文字列では getDay() が NaN になり、どちらにも一致しない＝平日の見た目へ倒れる）。
 */
function dayHeadClass(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const w = new Date(y, m - 1, d).getDay()
  if (w === 6) return 'sheet-sat'
  if (w === 0) return 'sheet-sun'
  return 'bg-surface2 text-ink'
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

/**
 * 保存しなかった入力の案内文（「何が起きたか＋次にどうすればよいか」）。
 * unreadable＝数字として読めない入力（「3 6」「36.5.5」等の打ち間違い）、
 * outside＝数値にはなったが VITAL_RANGE の外。どちらも保存せず、打った文字はセルに残す。
 */
function invalidText(unreadable: Field[], outside: Field[]): string {
  const parts: string[] = []
  if (unreadable.length > 0) {
    parts.push(`${unreadable.map((f) => FIELD_LABEL[f]).join('・')}は数字で入力してください`)
  }
  if (outside.length > 0) {
    parts.push(`${outside.map(rangeText).join('・')}の範囲で入力してください`)
  }
  if (parts.length === 0) return ''
  return `${parts.join('。')}。この項目は保存していません（入力は消えていません）。入力し直してください。`
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

/**
 * 入力として読める列だけの値（空欄は null＝消す意思）。
 * 読めない入力・範囲外の入力は比べない（保存もしないので「あなたの値」に数えない）
 */
function inputCells(buf: Record<Field, string>): Partial<Record<Field, number | null>> {
  const out: Partial<Record<Field, number | null>> = {}
  for (const f of FIELDS) {
    const raw = toHalfWidth(buf[f])
    const p = normalizeVitalInput(buf[f], f)
    if (raw !== '' && p == null) continue
    if (p != null && outOfRange(f, p)) continue
    out[f] = p
  }
  return out
}

/** あなたの入力（実際に編集した欄の値）。くらべて選ぶ画面の「あなたの入力」 */
function mineOf(rec: Rec): Partial<Record<Field, number | null>> {
  return editValues(rec.edits ?? {}) as Partial<Record<Field, number | null>>
}

/**
 * いまのサーバーの値（saved）に対する食い違い（編集を始めた時の基準からサーバーの値が動いた欄）。
 * saved が古いかもしれない間（stale）は出さない（古い値を「先の値」として見せない＝指摘 U1）
 */
function knownColumns(rec: Rec): ConflictColumn<Field>[] {
  if (rec.stale === true) return []
  return planEdits(FIELDS, rec.edits ?? {}, rec.saved).conflicts
}

/** 読めない入力・範囲外の入力の列（保存しない。打った文字はセルに残す） */
function badCells(buf: Record<Field, string>): { unreadable: Field[]; outside: Field[] } {
  const readable = inputCells(buf)
  const bad = FIELDS.filter((f) => !(f in readable))
  return {
    unreadable: bad.filter((f) => normalizeVitalInput(buf[f], f) == null),
    outside: bad.filter((f) => normalizeVitalInput(buf[f], f) != null),
  }
}

/**
 * 画面を離れると消える入力が残っている行か（構造規約 R-G）。編集が1欄でも残る
 * （送信待ちの後に打った値・保存中に打った値を含む）・読めない入力がある（範囲外の警告中）・競合中。
 * 送信待ちの内容そのものは送信キュー（端末に残る）が持っているので数えない
 */
function holdsInput(r: Rec): boolean {
  const bad = badCells(r.buf)
  return hasEdits(r.edits) || bad.unreadable.length + bad.outside.length > 0 || r.state === 'conflict'
}

/** 読み込みで作り直さずに載せ替える行か（止まっている入力・送信待ち・競合がある） */
function isHeldRec(r: Rec): boolean {
  const bad = badCells(r.buf)
  return (
    hasEdits(r.edits) ||
    bad.unreadable.length + bad.outside.length > 0 ||
    r.state === 'conflict' ||
    r.state === 'queued'
  )
}

/**
 * 読み込んだサーバーの値（fresh）に行を載せ替える（構造規約 R-E・共通の仕組み）。
 * ・saved / rev / id は最新にする。edits（編集と基準）は書き換えない
 * ・セルは最新の値で描き直し、編集のある欄と読めない入力の欄だけ打った文字を残す
 *   （以前は止まった行の入力欄を丸ごと残し、次の確定で他端末の値を巻き戻した＝再審 指摘1・E）
 * ・状態は edits と最新の値の突き合わせで決め直す: 食い違い→競合／送る差分あり→未保存／何も無い→通常
 * fresh が無い（行が見当たらない）時は、先の値が無いもの（新しい行）として裁く
 */
function mergeOnLoad(cur: Rec, fresh: Rec | undefined): Rec {
  const latest: Rec = fresh ?? { ...cur, vitalId: null, rev: 0, saved: savedOf(null) }
  let edits = cur.edits ?? {}
  const buf = bufOf(latest.saved)
  const readable = inputCells(cur.buf)
  for (const f of FIELDS) {
    if (edits[f] !== undefined || !(f in readable)) buf[f] = cur.buf[f]
  }
  // 突き合わせは共通の裁き（rowSync.reconcileOnLoad）。行が見当たらない時は先の値が無いものとして扱う
  const r = reconcileOnLoad(FIELDS, edits, fresh ? latest.saved : null)
  edits = r.edits
  const next: Rec = {
    ...latest,
    buf,
    sent: undefined,
    edits,
    stale: undefined,
    missing: undefined,
    ...(latest.vitalId == null && cur.clientKey ? { clientKey: cur.clientKey } : {}),
  }
  if (r.status === 'conflict') return { ...next, state: 'conflict', message: conflictStillText(r.conflicts) }
  if (r.status === 'unsaved') return { ...next, state: 'error', message: unsavedText(r.unsaved) }
  const { unreadable, outside } = badCells(buf)
  if (unreadable.length + outside.length > 0) {
    return { ...next, state: 'invalid', message: invalidText(unreadable, outside) }
  }
  return { ...next, state: 'idle', message: '' }
}

/** その行の送り先（定時は利用者×日付・保存済みの再検は行 id・まだ行の無い再検はこの枠の冪等キー） */
function targetOf(rec: Rec): VitalTarget | null {
  if (rec.kind === 'routine') return { routine: true, residentId: rec.residentId, day: rec.day }
  if (rec.vitalId != null) return { routine: false, id: rec.vitalId }
  if (rec.clientKey) {
    return { routine: false, clientKey: rec.clientKey, residentId: rec.residentId, day: rec.day, kind: 'recheck' }
  }
  return null
}

/**
 * 送信待ちで止まっている行（競合・拒否）の値を、その行の「あなたの入力」として編集に取り込む。
 * 画面に既に編集のある欄は画面の値（止まった後に入れた、より新しい入力）を残す。基準は送信待ちの基準
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
 * 送信待ち（db.ts の pending store）を表示中の行へ重ねる。再マウント・再読み込みの後も同じ見え方にする。
 * ・送る状態（pending）… 値を「送信待ち」の印つきで重ねる（その欄をさらに直す時の比べる相手＝sent）
 * ・止まっている（conflict）… 値を「あなたの入力」として取り込み、最新の値と突き合わせて競合・未保存を出し直す。
 *   もう同じ値が載っていれば、送信待ちから外す（届いたのと同じ）
 * ・拒否された（rejected）… 値を取り込み、〔保存し直す〕を出す
 * 表示中の期間の外の行・まだ行の無い再検（冪等キーが分からない）は重ねない（設定画面の未送信件数には数え続ける）
 */
function adoptStoreRecs(next: Map<string, Rec>, residentIds: number[], days: string[]): void {
  const keys = new Set<string>()
  for (const rid of residentIds) for (const d of days) keys.add(recKey(rid, d, 'routine', 0))
  for (const [k, r] of next) if (r.kind === 'recheck' && days.includes(r.day)) keys.add(k)
  for (const k of keys) {
    const [ridRaw, day, kind, slotRaw] = k.split('|')
    const cur = next.get(k) ?? newRec(Number(ridRaw), day, kind as RowKind, Number(slotRaw))
    const target = targetOf(cur)
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
      next.set(k, {
        ...cur,
        buf,
        sent: { ...cur.saved, ...q } as Record<Field, number | null>,
        ...(quiet ? { state: 'queued' as const, message: cur.state === 'queued' && cur.message ? cur.message : MSG_QUEUED } : {}),
      })
      continue
    }
    const edits = adoptPending(cur.edits ?? {}, p)
    if (p.state === 'rejected') {
      next.set(k, { ...cur, edits, buf: bufWithEdits(cur.buf, edits), state: 'error', message: ERR_REJECTED })
      continue
    }
    // 止まっている行。行が無くなっていて理由が「取り消された」なら、行が無い控えとして出す
    const missing = cur.vitalId == null && p.conflicts.length > 0 && p.conflicts.every((c) => c.reason === 'missing')
    if (missing) {
      next.set(k, { ...cur, edits, buf: bufWithEdits(cur.buf, edits), state: 'conflict', missing: true, message: missingRowText(describeEdits(edits)) })
      continue
    }
    const r = reconcileOnLoad(FIELDS, edits, cur.vitalId != null ? cur.saved : null)
    if (r.status === 'clean') {
      // もう同じ値がサーバーに載っている（止まっていた分は届いたのと同じ）。送信待ちから外す
      // 突き合わせた欄の、見た版だけを外す（第3段 #9。画面に出していない欄・見た後の新しい版は外さない）
      void discardPendingRow('vitals', target, FIELDS.filter((f) => f in p.values), p.vers)
      next.set(k, { ...cur, edits: r.edits })
      continue
    }
    next.set(k, {
      ...cur,
      edits: r.edits,
      buf: bufWithEdits(cur.buf, r.edits),
      state: r.status === 'conflict' ? 'conflict' : 'error',
      message: r.status === 'conflict' ? conflictStillText(r.conflicts) : unsavedText(r.unsaved),
    })
  }
}

/** その行の送信待ちがまだ送る状態で残っているか（送信が済めば、サーバーの値で作り直してよい） */
function stillPending(rec: Rec): boolean {
  const target = targetOf(rec)
  return target !== null && pendingRow('vitals', target)?.state === 'pending'
}

/** 行の氏名のセルの id（食い違いを解決した後のフォーカスの戻り先） */
function nameCellId(rowId: string): string {
  return `vs-name-${rowId}`
}

/** 端末ローカルの現在時刻 HH:MM（measured_at 用） */
function nowHM(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * UI 状態だけを localStorage から読む（壊れた値・未知値は既定へ倒す）。
 * 保存は画面別（readSheetPref/writeSheetPref）。食事一覧と同じキーを共有しているが、
 * 既定が違う（バイタル=4日/1階・食事=11日/全）ので値は画面ごとに分けて持つ。
 */
function readFloor(): string | null {
  const v = readSheetPref(LS.sheetFloor, 'vitals')
  return v && /^([0-9]|all|other)$/.test(v) ? v : null
}

function writeFloor(v: string): void {
  writeSheetPref(LS.sheetFloor, 'vitals', v)
}

function readDays(): SheetDays | null {
  const n = Number(readSheetPref(LS.sheetDays, 'vitals'))
  return (SHEET_DAYS as readonly number[]).includes(n) ? (n as SheetDays) : null
}

function writeDays(v: SheetDays): void {
  writeSheetPref(LS.sheetDays, 'vitals', String(v))
}

// ── セル1組（1名 × 1日 × 1枠）の状態 ─────────────────────────

type RecState = 'idle' | 'saving' | 'saved' | 'queued' | 'conflict' | 'error' | 'invalid'

interface Rec {
  residentId: number
  day: string
  kind: RowKind
  /** 再検の何本目か（定時は 0） */
  slot: number
  vitalId: number | null
  rev: number
  /** 直近にサーバーで観測できた値（差分＝送る列の判定に使う） */
  saved: Record<Field, number | null>
  /** 送信キューへ渡した内容（未観測）。送信待ちの行で「そのあと入力された値」を見分ける */
  sent?: Record<Field, number | null>
  /** 入力バッファ（文字列のまま保持し、保存時に正規化する） */
  buf: Record<Field, string>
  state: RecState
  message: string
  /**
   * 利用者の編集（欄ごとの値と、編集を始めた時に画面に出ていた値＝基準）。構造規約 R-E〜R-G の共通の仕組み
   * （src/lib/rowSync.ts）で扱う。保存で送るのはこの欄だけで、入力欄と saved の差分は使わない。
   * 背景の読み込みはこれを書き換えない（基準が動かない）。保存に成功した欄だけ欄単位で消える
   */
  edits?: Edits<Field>
  /**
   * まだ行の無い再検の、この枠に固有の冪等キー（最初に送る時に決める）。送信待ちの間に続けて入力しても
   * 同じ送信待ちへまとまり、何度送っても1行に収まる。行ができた後は行 id で指す
   */
  clientKey?: string
  /** 競合の理由が「先の行が他の端末で取り消された」（〔新しい行として保存〕〔取り下げる〕を出す） */
  missing?: boolean
  /**
   * saved が古いかもしれない（保存が競合になったのに最新を取り直せなかった）。この間は「先の値」を出さない
   * （古い値を先の値として見せない＝指摘 U1）。次の読み込みで消える
   */
  stale?: boolean
}

function recKey(residentId: number, day: string, kind: RowKind, slot: number): string {
  return `${residentId}|${day}|${kind}|${slot}`
}

function newRec(residentId: number, day: string, kind: RowKind, slot: number): Rec {
  return {
    residentId,
    day,
    kind,
    slot,
    vitalId: null,
    rev: 0,
    saved: savedOf(null),
    buf: emptyBuf(),
    state: 'idle',
    message: '',
  }
}

function recFromVital(v: Vital, kind: RowKind, slot: number): Rec {
  const saved = savedOf(v)
  return {
    residentId: v.resident_id,
    day: v.measured_on,
    kind,
    slot,
    vitalId: v.id,
    rev: numOrNull(v.rev) ?? 1,
    saved,
    buf: bufOf(saved),
    state: 'idle',
    message: '',
  }
}

/** 画面に出す表の行（横方向に日が並ぶので、1行＝1名×1枠） */
interface TableRow {
  rowId: string
  residentId: number
  kind: RowKind
  slot: number
}

// ── ページ本体 ───────────────────────────────────────────────

export interface VitalsSheetPageProps {
  /** App.tsx が保持していれば渡す（省略時はこの画面で取得する） */
  residents?: Resident[]
  /** 操作者（記入者）の staff_id。省略時は cl_staffId から読む */
  actorId?: number | null
  /** 入力解禁フラグ。省略時はこの画面の表示ごとに取得する（前提情報は毎回取り直す） */
  inputEnabled?: boolean
}

export function VitalsSheetPage({
  residents: propResidents,
  actorId: propActorId,
  inputEnabled: propInputEnabled,
}: VitalsSheetPageProps = {}) {
  // 表示中の期間は業務データに紐づくため localStorage に保存しない（dev-principles 原則11）
  const [anchor, setAnchor] = useState(() => todayIso())
  const [days, setDays] = useState<SheetDays>(() => readDays() ?? DEFAULT_DAYS)
  const [floor, setFloor] = useState<string>(() => readFloor() ?? '1')

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [residents, setResidents] = useState<Resident[]>(propResidents ?? [])
  const [inputEnabled, setInputEnabled] = useState<boolean>(propInputEnabled ?? false)
  /** 入力できるかどうかを観測できなかった（通信エラー）。封鎖の理由文とは分けて案内する */
  const [gateUnknown, setGateUnknown] = useState(false)
  /** サーバーに欄ごとの保存の仕組み（0011）がまだ無い＝サーバー側の更新待ち（入力を止める） */
  const [cellsMissing, setCellsMissing] = useState(false)
  const [recs, setRecs] = useState<Map<string, Rec>>(() => new Map())
  /**
   * 入居者ごとに**画面に出している**再検の行数（0＝出さない）。
   * 記録がある人は「保存済みの本数＋空行1本」、記録が無い人は「再検」ボタンを押した本数。
   */
  const [recheckRows, setRecheckRows] = useState<Map<number, number>>(() => new Map())
  const [pending, setPending] = useState(0)
  const [clearAsk, setClearAsk] = useState<{ labels: string; day: string } | null>(null)
  /** くらべて選ぶ画面に渡す内容（開いた時点で固定する＝開いている間に入力が変わっても揺れない） */
  const [compare, setCompare] = useState<{
    key: string
    target: ConflictTarget
    name: string
    base: Record<string, unknown>
    mine: Record<string, unknown>
    /** 解決した後にフォーカスを移す先（その行の氏名のセル） */
    focusId: string
  } | null>(null)
  /** 期間を切り替えると外に出てしまう「止まっている入力」がある時の確認（はいで実行する処理） */
  const [leaveAsk, setLeaveAsk] = useState<(() => void) | null>(null)

  const aliveRef = useRef(true)
  const recsRef = useRef<Map<string, Rec>>(new Map())
  /** recheckRows の同期用の控え（recsRef と同じ作法。同じ描画の中で続けて増やしても取りこぼさない） */
  const recheckRowsRef = useRef<Map<number, number>>(new Map())
  /**
   * 「再検」ボタンで出した行数（入居者id → 出したい本数）。
   * 画面内の状態なので保存しないが、読み込み直し・期間送りで**押した行が消えないよう**控える
   * （入力途中の空行が黙って消えると、打とうとしていた値を落とす）。
   */
  const recheckOpenRef = useRef<Map<number, number>>(new Map())
  /** 保存の順番待ち・応答待ちがある行（背景の取り直しを先送りする判定に使う） */
  const savingRef = useRef(new Set<string>())
  /** 自分の書き込みで出た変更通知に反応しないための抑制窓（日報シートと同じ作法） */
  const selfWriteRef = useRef(0)
  /** 取得の世代。応答が返るまでに次の取得が始まっていたら、古い応答は捨てる */
  const genRef = useRef(0)
  const clearResolveRef = useRef<((ok: boolean) => void) | null>(null)

  const actorId = propActorId !== undefined ? propActorId : getActorId()
  // 他の端末が今まさに入力している欄（Presence・表示だけ。保存は妨げない）。
  // この画面は欄に入っている間だけ配り、それ以外は受け取るだけ
  const presence = useCellPresence({ actorId: actorId ?? null })
  const today = todayIso()

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /** 新しい日が左（契約 §6）。anchor が期間の右端＝最も新しい日 */
  const dayList = useMemo(() => {
    const out: string[] = []
    for (let i = 0; i < days; i++) out.push(addDays(anchor, -i))
    return out
  }, [anchor, days])

  const fromIso = useMemo(() => addDays(anchor, -(days - 1)), [anchor, days])

  const commitRecs = useCallback((next: Map<string, Rec>) => {
    recsRef.current = next
    setRecs(next)
  }, [])

  const commitRecheckRows = useCallback((next: Map<number, number>) => {
    recheckRowsRef.current = next
    setRecheckRows(next)
  }, [])

  const patchRec = useCallback(
    (key: string, patch: Partial<Rec>) => {
      const cur = recsRef.current.get(key)
      if (!cur) return
      const next = new Map(recsRef.current)
      next.set(key, { ...cur, ...patch })
      commitRecs(next)
    },
    [commitRecs],
  )

  // ── 読み込み ───────────────────────────────────────────────

  const load = useCallback(async (opts?: { background?: boolean }) => {
    // 期間送り・読み込み直しが重なった時、後から返った古い期間の応答で表を描き直さないための世代
    const gen = ++genRef.current
    // 保存が割り込んだかどうかを見分けるための開始時刻（selfWriteRef は保存のたびに進む）
    const startedAt = Date.now()
    // 背景の取り直し（他端末の変更を受けた自動更新）では「読み込み中」にしない。
    // loading を立てると editable が外れ、編集中のセルが確定を通らずに閉じる＝打った文字が消える
    // （利用者が押した読み込み直し・期間送りは従来どおり読み込み中にして誤入力を防ぐ）。
    // 控えの温存（KEEP）は背景でもそのまま効く
    const background = opts?.background === true
    if (!background) setLoading(true)
    setError(null)
    try {
      // 入力解禁フラグは「観測できた値」と「観測できなかった」を区別するため、
      // 親から既知値をもらっていても必ず自分で取り直す（前提情報は毎回取り直す規範）。
      // 親（App.tsx）は取得失敗時も false を渡してくるので、prop を観測済みとして扱うと
      // 通信障害を「スプレッドシートで記録する期間です」と誤って案内してしまう
      const [rs, gate, vitals] = await Promise.all([
        propResidents ? Promise.resolve(propResidents) : fetchResidents(),
        getNativeInputGate(),
        fetchVitalsSheet(fromIso, anchor),
      ])
      if (gen !== genRef.current || !aliveRef.current) return
      // 取得の途中で自分の保存が入った＝この応答は保存前のサーバー値。
      // そのまま描くと、保存できた値が旧値に戻り rev も古くなる（次の編集が競合になる）。
      // 背景の取り直しは捨ててやり直す（利用者が押した読み込み直しは待たせずそのまま反映する）
      if (background && selfWriteRef.current >= startedAt) {
        const retry = retryRef.current
        if (retry) retry()
        return
      }

      const list = (Array.isArray(rs) ? rs : []).filter((r) => r && r.active !== false)
      const sorted = list.slice().sort(cmpResident)
      const rows = Array.isArray(vitals) ? vitals.filter((v) => v != null) : []

      const next = new Map<string, Rec>()

      // 定時: 1名1日1行（部分unique索引が担保する）。万一重複が見えたら新しい id を採る
      for (const v of rows) {
        if (v.kind !== 'routine') continue
        const k = recKey(v.resident_id, v.measured_on, 'routine', 0)
        const cur = next.get(k)
        if (!cur || v.id > (cur.vitalId ?? 0)) next.set(k, recFromVital(v, 'routine', 0))
      }

      // 再検: 1名1日に複数ある。id 昇順で 0,1,2… の枠へ割り当てる
      const rechecks = new Map<string, Vital[]>()
      for (const v of rows) {
        if (v.kind !== 'recheck') continue
        const k = `${v.resident_id}|${v.measured_on}`
        const arr = rechecks.get(k)
        if (arr) arr.push(v)
        else rechecks.set(k, [v])
      }
      const counts = new Map<number, number>()
      for (const [, arr] of rechecks) {
        arr.sort((a, b) => a.id - b.id)
        arr.forEach((v, i) => {
          next.set(recKey(v.resident_id, v.measured_on, 'recheck', i), recFromVital(v, 'recheck', i))
        })
        const rid = arr[0].resident_id
        counts.set(rid, Math.max(counts.get(rid) ?? 0, arr.length))
      }

      // 未送信・競合・失敗・応答待ち・範囲外警告中のセルは入力の控えを引き継ぐ
      // （原則4: 入力を消さない。「読み込み直す」を押した時に打った値が黙って消えるのを防ぐ）。
      // サーバー側の値（id・rev・saved）は新しいものを採り、入力バッファだけ温存する
      for (const [k, cur] of recsRef.current) {
        // 表示中の期間の外（別の期間で入力したまま残っている控え）は持ち込まない
        // （期間を切り替える前に、止まっている入力があれば guardWindow で確認している）
        if (cur.day < fromIso || cur.day > anchor) continue
        const fresh = next.get(k)
        if (fresh && isOlderRow({ id: cur.vitalId, rev: cur.rev }, { id: fresh.vitalId, rev: fresh.rev })) {
          // 画面が持っている行より古い応答（くらべて選ぶ・保存の直後に、それより前に出た読み込みが返った）。
          // 古い値で描き直さず、画面の行をそのまま残す（指摘 L2・全画面共通の防御）
          next.set(k, cur)
        } else if (!isHeldRec(cur) && cur.state !== 'saving') {
          // 編集・読めない入力・送信待ち・応答待ち・競合のどれも無い行は、サーバーの値で作り直す
          continue
        } else if (cur.state === 'saving') {
          // 保存の応答待ち。応答で描き直すので、入力と編集をそのまま温存する（順番待ちが後で計算し直す）
          next.set(
            k,
            fresh
              ? { ...fresh, buf: cur.buf, state: cur.state, message: cur.message, sent: cur.sent, edits: cur.edits }
              : cur,
          )
        } else if (cur.state === 'queued' && stillPending(cur)) {
          // まだ送信キューにある間は、送信待ちのまま持ち続ける（送信待ちの後に打った値は edits に残る）
          next.set(
            k,
            fresh
              ? { ...fresh, buf: cur.buf, state: 'queued', message: cur.message, sent: cur.sent, edits: cur.edits }
              : cur,
          )
        } else {
          // 送信が済んだ送信待ち・競合・未保存・保存失敗・範囲外の警告中。edits（編集と基準）と
          // 読めない入力だけを残して最新の値に載せ替え、状態を決め直す（共通の仕組み mergeOnLoad）。
          // 送信待ちの間に打った値は edits に残っているので、案内なしに消えない（再審 指摘7）
          next.set(k, mergeOnLoad(cur, fresh))
        }
        // 控えのある再検枠が消えないよう、行数もその枠まで確保する
        if (cur.kind === 'recheck') {
          counts.set(cur.residentId, Math.max(counts.get(cur.residentId) ?? 0, cur.slot + 1))
        }
      }

      // 送信待ち・止まっている行を db.ts（pending store）から読んで重ねる（再マウント・再読み込みの後も同じ見え方）
      const shownDays: string[] = []
      for (let d = fromIso; d <= anchor; d = addDays(d, 1)) shownDays.push(d)
      adoptStoreRecs(
        next,
        sorted.map((r) => r.id),
        shownDays,
      )

      // 再検枠は「記録がある人だけ」出す（2026-08-28 追加指示1）。
      // ・保存済み（または送信待ちの控え）がある人 … その最大本数 ＋ 空行1本
      //   ＝記録があるのに隠さない／記録が入ったら次の空行が出る、を両方満たす
      // ・記録が無い人 … 0本。「再検」ボタンを押した人だけ、その本数を出す
      const rowCounts = new Map<number, number>()
      for (const r of sorted) {
        const saved = counts.get(r.id) ?? 0
        const opened = recheckOpenRef.current.get(r.id) ?? 0
        rowCounts.set(r.id, Math.max(saved > 0 ? saved + 1 : 0, opened))
      }

      setResidents(sorted)
      setInputEnabled(gate.value === true)
      setGateUnknown(!gate.observed)
      setCellsMissing(gate.cells === 'missing')
      commitRecs(next)
      commitRecheckRows(rowCounts)
      setError(null)
    } catch (e) {
      if (gen !== genRef.current || !aliveRef.current) return
      // 失敗時は既存の表示を消さない（安全側フォールバック）。
      // db.ts の DbError は「何が起きたか＋次にどうすればよいか」を持っている
      // （例: 日数が多すぎて読み切れなかった＝再試行では解決しない）ので、
      // 通信エラーの定型文で塗り潰さない
      setError(e instanceof DbError && e.message ? e.message : ERR_LOAD)
    } finally {
      // 最新の取得だけが「読み込み中」を降ろす（古い応答が先に降ろして表示がちらつかない）
      if (gen === genRef.current && aliveRef.current) setLoading(false)
    }
  }, [anchor, commitRecheckRows, commitRecs, fromIso, propResidents])

  useEffect(() => {
    void load()
  }, [load])

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
        if (aliveRef.current) setPending(typeof n === 'number' && n >= 0 ? n : 0)
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
  }, [])

  // ── 他端末の変更を自動で取り込む ───────────────────────────

  /**
   * 購読は画面にいる間ずっと1本にする（期間・日数を変えるたびに張り直さない）。
   * そのため「取り直す処理」と「表示中の期間」は ref から読む
   * （購読 effect の依存に入れると、期間を送るたびに解除→再購読が走って通知を取りこぼす）。
   */
  const loadRef = useRef(load)
  /** 背景の取り直しをやり直す（購読 effect の schedule を入れる。購読が無い時は null） */
  const retryRef = useRef<(() => void) | null>(null)
  const windowRef = useRef({ from: fromIso, to: anchor })
  useEffect(() => {
    loadRef.current = load
  }, [load])
  useEffect(() => {
    windowRef.current = { from: fromIso, to: anchor }
  }, [fromIso, anchor])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const schedule = () => {
      if (stopped) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (stopped || !aliveRef.current) return
        // 保存の応答を待っているセルがある間は取り直さない。
        // 取り直すと、応答が返る前のサーバー値でそのセルを描き直しかねない（＝入力を消す）
        const busy =
          savingRef.current.size > 0 ||
          Array.from(recsRef.current.values()).some((r) => r.state === 'saving')
        if (busy) {
          schedule()
          return
        }
        void loadRef.current({ background: true })
      }, REALTIME_DEBOUNCE_MS)
    }
    retryRef.current = schedule

    /**
     * 画面復帰・通信復帰で取り直す（2026-09-05 追加）。
     * Realtime は配信保証が無く、iPad を伏せている間などに通知が落ちる。
     * 落ちたことは検知できないので、戻ってきた時に1回取り直して埋める。
     * 短い離席で毎回取りに行かないよう、離れていた時間がしきい値を超えた時だけにする。
     */
    let hiddenAt = 0
    const onVisible = () => {
      if (typeof document === 'undefined') return
      if (document.visibilityState === 'hidden') {
        if (hiddenAt === 0) hiddenAt = Date.now()
        return
      }
      const away = hiddenAt === 0 ? 0 : Date.now() - hiddenAt
      hiddenAt = 0
      if (away >= AWAY_REFETCH_MS) schedule()
    }
    const onOnline = () => schedule() // 切れていた間の通知は必ず落ちている
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    if (typeof window !== 'undefined') window.addEventListener('online', onOnline)

    let unsub: (() => void) | null = null
    try {
      // info は db.ts の契約では `{ event, row }`。ここでは unknown として受け、
      // 第2引数を渡さない版でも渡す版でも同じコードで動くようにする（changedDay が型検査する）
      unsub = subscribeChanges((table, info?: unknown) => {
        if (!aliveRef.current) return
        // この画面が描画する表だけを合図にする
        if (typeof table !== 'string' || table !== WATCHED_TABLE) return
        // 自分の保存で出た通知（画面へ反映済み）は取り直さない。
        // ★行で見分ける（2026-09-05 修正）。以前は「自分の保存から3秒間の通知を捨てる」
        //   時刻だけの判定で、同じ3秒に届いた**他端末の変更まで捨てて**いた。
        //   捨てた通知は再生されないので、次の通知か手動更新まで無期限に古いままだった
        if (isSelfWrite(table, (info as { row?: unknown } | undefined)?.row)) return
        // 行が分かる時だけ期間で絞る。分からない時（旧形式・削除など）は取り直す＝安全側
        const day = changedDay(info)
        const w = windowRef.current
        if (day !== null && (day < w.from || day > w.to)) return
        schedule()
      })
    } catch {
      // 購読できない環境（接続未設定など）でも画面は成立させる（従来どおり手動の読み込み直しで足りる）
      unsub = null
    }
    return () => {
      stopped = true
      retryRef.current = null
      if (timer) clearTimeout(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
      if (unsub) {
        try {
          unsub()
        } catch {
          /* 解除失敗は表示に影響しないため無視する */
        }
      }
    }
  }, [])

  // ── フロア ─────────────────────────────────────────────────

  const floorOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of residents) set.add(floorOf(r.room))
    const opts = Array.from(set)
      .filter((f) => f !== FLOOR_OTHER)
      .sort()
      .map((f) => ({ value: f, label: `${f}階` }))
    if (set.has(FLOOR_OTHER)) opts.push({ value: FLOOR_OTHER, label: '居室未設定' })
    opts.push({ value: FLOOR_ALL, label: '全' })
    return opts
  }, [residents])

  // 復元値が現在の一覧に無い場合だけ既定（先頭）へ倒す。
  // 一覧を取得できるまでは照合しない（residents が空の初回描画で照合すると、
  // 候補が「全」1件しか無いため保存済みのフロアが毎回「全」で上書きされてしまう）
  useEffect(() => {
    if (residents.length === 0) return
    if (floorOptions.length === 0) return
    if (floorOptions.some((o) => o.value === floor)) return
    setFloor(floorOptions[0].value)
  }, [floorOptions, floor, residents.length])

  const visibleResidents = useMemo(
    () => (floor === FLOOR_ALL ? residents : residents.filter((r) => floorOf(r.room) === floor)),
    [residents, floor],
  )

  /**
   * 表の行（定時1行＋再検n行）を入居者ごとに並べる。
   * 再検は n=0 が既定＝行を出さない（記録がある人・「再検」を押した人だけ n≥1 になる）。
   */
  const tableRows = useMemo(() => {
    const out: TableRow[] = []
    for (const r of visibleResidents) {
      out.push({ rowId: `r${r.id}`, residentId: r.id, kind: 'routine', slot: 0 })
      const n = Math.max(0, recheckRows.get(r.id) ?? 0)
      for (let i = 0; i < n; i++) {
        out.push({ rowId: `c${r.id}-${i}`, residentId: r.id, kind: 'recheck', slot: i })
      }
    }
    return out
  }, [visibleResidents, recheckRows])

  /** 「再検」ボタン: その入居者の直下に再検欄を1本足す（画面内の状態・保存しない） */
  const addRecheckRow = useCallback(
    (residentId: number) => {
      const next = (recheckRowsRef.current.get(residentId) ?? 0) + 1
      recheckOpenRef.current.set(residentId, next)
      const out = new Map(recheckRowsRef.current)
      out.set(residentId, next)
      commitRecheckRows(out)
    },
    [commitRecheckRows],
  )

  /**
   * その再検行が「空」か（保存済みの記録も、入力中・送信待ちの控えも無い）。
   * 表示中の全ての日を見る＝1日でも値が入っていれば空ではない。
   */
  const isRecheckRowEmpty = useCallback(
    (residentId: number, slot: number): boolean => {
      for (const day of dayList) {
        const rec = recs.get(recKey(residentId, day, 'recheck', slot))
        if (!rec) continue
        if (rec.vitalId != null) return false
        if (FIELDS.some((f) => rec.buf[f].trim() !== '')) return false
        // 送信キューへ渡した控え（応答待ち）が残っている行も消さない
        if (rec.sent && FIELDS.some((f) => rec.sent?.[f] != null)) return false
      }
      return true
    },
    [dayList, recs],
  )

  /**
   * 「✕」ボタン: 押し間違いで出した再検欄を1本消す（画面内の状態・保存しない）。
   * **消せるのはその入居者の一番下の空の再検欄だけ**（呼ぶ側で isRecheckRowEmpty を確かめる）:
   * ・記録のある枠を消さない（原則4＝データを消さない。表示から隠すのも取り違えのもと）
   * ・途中の枠を抜くと下の枠の通し番号がずれ、別の記録が別の枠に見えてしまう
   * サーバーの行は一切触らない＝この操作でDBの記録が消えることはない。
   */
  const removeRecheckRow = useCallback(
    (residentId: number) => {
      const cur = recheckRowsRef.current.get(residentId) ?? 0
      if (cur <= 0) return
      const next = cur - 1
      // 「再検」ボタンで出した本数の控えも一緒に減らす（減らさないと読み込み直しで復活する）
      const opened = recheckOpenRef.current.get(residentId) ?? 0
      if (opened > next) recheckOpenRef.current.set(residentId, next)
      const out = new Map(recheckRowsRef.current)
      out.set(residentId, next)
      commitRecheckRows(out)
    },
    [commitRecheckRows],
  )

  // ── 保存 ───────────────────────────────────────────────────

  const askClear = useCallback((labels: string, day: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      // 未応答の確認が残っている状態で次の確認が来たら、先の待ちを「取りやめ」で解いてから
      // 差し替える。解かないとその保存が await のまま止まり、savingRef にキーが残って
      // 以後そのセル組の保存が（再読み込みまで）無言で全て弾かれる
      const prev = clearResolveRef.current
      clearResolveRef.current = resolve
      if (prev) prev(false)
      setClearAsk({ labels, day })
    })
  }, [])

  /**
   * 保存が競合になった行だけを取り直し、最新の値で状態と一言（先の値／あなたの入力）を出し直す（指摘 U1）。
   * 取り直せない時・まだ行の無い再検は、値を出さない固定の文言のまま（stale の印を残す＝古い値を先の値にしない）
   */
  const refreshAfterConflict = useCallback(
    async (key: string) => {
      const rec = recsRef.current.get(key)
      if (!rec || (rec.kind === 'recheck' && rec.vitalId == null)) return
      let latest: Vital | null
      try {
        const got = await fetchLatestVital(
          rec.kind === 'routine' || rec.vitalId == null
            ? { routine: true, residentId: rec.residentId, day: rec.day }
            : { routine: false, id: rec.vitalId },
        )
        latest = got?.row ?? null
      } catch {
        return
      }
      if (!aliveRef.current) return
      const cur = recsRef.current.get(key)
      if (!cur || cur.state !== 'conflict') return
      patchRec(key, mergeOnLoad(cur, latest ? recFromVital(latest, cur.kind, cur.slot) : undefined))
    },
    [patchRec],
  )

  /**
   * 保存が、他の端末の値と食い違って止まっている行にまとめられた（held＝送っていない）。その行を競合として見せる。
   * 止まっている値を「あなたの入力」として載せ、1行だけ取り直して先の値と並べる
   */
  const holdAsHeld = useCallback(
    async (key: string) => {
      const cur = recsRef.current.get(key)
      if (!cur) return
      const target = targetOf(cur)
      const p = target ? pendingRow('vitals', target) : null
      const edits = p ? adoptPending(cur.edits ?? {}, p) : (cur.edits ?? {})
      patchRec(key, { edits, buf: bufWithEdits(cur.buf, edits), state: 'conflict', message: MSG_BLOCKED_WRITE, stale: true })
      await refreshAfterConflict(key)
    },
    [patchRec, refreshAfterConflict],
  )

  /**
   * 保存の応答をその行へ当てる（通常の保存・〔新しい行として保存〕で共通）。
   * ・書けた欄・もう載っていた欄は、送った後に打ち直していなければ編集から消す（R-F）
   * ・書かなかった欄（競合）は編集に残し、先の値と並べる。行が取り消されていたら「行が無い控え」にする
   * ・触っていない欄はサーバーの値で描き直す（E）。編集が残る欄と読めない入力の欄だけ打った文字を残す
   */
  const applySaveResult = useCallback(
    (key: string, rec: Rec, sendEdits: Edits<Field>, res: CellSaveResult<Vital>) => {
      const cur = recsRef.current.get(key)
      const missing = res.conflicts.length > 0 && res.conflicts.every((c) => c.reason === 'missing')
      const saved = res.row ? savedOf(res.row) : missing ? savedOf(null) : (cur?.saved ?? rec.saved)
      const done = new Set<string>([...res.applied, ...res.settled])
      const doneEdits: Edits<Field> = {}
      for (const f of FIELDS) {
        const e = sendEdits[f]
        if (done.has(f) && e) doneEdits[f] = e
      }
      const remain = settleSent(cur?.edits ?? {}, doneEdits, saved)
      const bad = cur ? badCells(cur.buf) : { unreadable: [] as Field[], outside: [] as Field[] }
      const buf = bufOf(saved)
      if (cur) {
        for (const f of FIELDS) {
          if (remain[f] !== undefined || bad.unreadable.includes(f) || bad.outside.includes(f)) buf[f] = cur.buf[f]
        }
      }
      const common: Partial<Rec> = {
        vitalId: res.row?.id ?? (missing && rec.kind === 'routine' ? null : rec.vitalId),
        rev: numOrNull(res.row?.rev) ?? (missing && rec.kind === 'routine' ? 0 : rec.rev),
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
        patchRec(key, {
          ...common,
          state: 'conflict',
          missing: missing ? true : undefined,
          message: missing ? missingRowText(describeEdits(remain)) : conflictStillText(columns),
        })
        return
      }
      const nowBad = bad.unreadable.length + bad.outside.length > 0
      patchRec(key, {
        ...common,
        missing: undefined,
        ...(res.row ? { clientKey: undefined } : {}),
        state: hasEdits(remain) ? 'idle' : nowBad ? 'invalid' : 'saved',
        message: nowBad ? invalidText(bad.unreadable, bad.outside) : '',
      })
    },
    [patchRec],
  )

  /**
   * 1名1日分（＝vitals の1行）を保存する（構造規約 R-E〜R-F・共通の仕組み src/lib/rowSync.ts）。
   * 行ごとの順番待ち（enqueueSave）から呼ばれ、動き出した時点の最新の状態（edits・saved・rev）から計算し直す。
   * ・送るのは edits の欄と基準だけ。入力欄と saved の差分は使わない（止まった行でも通常の行でも同じ）
   * ・書くかどうかはサーバーが欄ごとに決める（基準からサーバーの値が動いていれば、書かずに競合を返す
   *   ＝編集中に背景の読み込みが走っても、相手の新しい値を黙って上書きしない＝再審 D）
   * ・成功したら送った欄だけを消し（送った後に打った欄は残す）、触っていない欄はサーバーの値で描き直す（E）
   */
  const saveOne = useCallback(
    async (key: string) => {
      const rec = recsRef.current.get(key)
      if (!rec) return
      // 競合中の行は、くらべて選ぶで選ぶまで保存しない（5画面共通の規約）。止めた旨と食い違いの併記を出す
      if (holdsNormalSave(rec.state)) {
        patchRec(key, { message: conflictHoldText(knownColumns(rec)) })
        return
      }
      const { unreadable, outside } = badCells(rec.buf)
      const invalidMessage = invalidText(unreadable, outside)
      const stillBad = unreadable.length + outside.length > 0
      // 送信待ちの行は、送信待ちの内容が載った後の値を表示の基準にする（空にする確認・描き直しに使う）
      const server = rec.state === 'queued' ? (rec.sent ?? rec.saved) : rec.saved
      let edits = rec.edits ?? {}
      const sendEdits: Edits<Field> = { ...edits }
      // 記録済みの値を空にする欄は確認を挟む（空上書き保護）。何の値を消すかを明記する。
      // 取りやめた欄は edits から外し、セルを表示中の値へ戻す（利用者の明示的な取り下げ）
      const cleared = (Object.keys(sendEdits) as Field[]).filter((f) => sendEdits[f]?.value === null && server[f] != null)
      if (cleared.length > 0) {
        const ok = await askClear(
          cleared.map((f) => `${FIELD_LABEL[f]}（${fmtVitalValue(f, server[f])}）`).join('・'),
          rec.day,
        )
        if (!aliveRef.current) return
        if (!ok) {
          const cur = recsRef.current.get(key)
          if (!cur) return
          const buf = { ...cur.buf }
          const shownNow = cur.state === 'queued' ? (cur.sent ?? cur.saved) : cur.saved
          for (const f of cleared) {
            const v = shownNow[f]
            buf[f] = v == null ? '' : fmtNum(f, v)
            delete sendEdits[f]
          }
          edits = withoutFields(cur.edits ?? {}, cleared)
          patchRec(key, { buf, edits })
        }
      }
      if (Object.keys(sendEdits).length === 0) {
        // 送るものが無い（R-C）。送信待ちの行は送信待ちのまま。読めない入力が残っていれば警告のまま、無ければ通常へ戻す
        patchRec(
          key,
          rec.state === 'queued'
            ? { edits }
            : stillBad
              ? { edits, state: 'invalid', message: invalidMessage }
              : { edits, state: rec.state === 'saved' ? 'saved' : 'idle', message: '' },
        )
        return
      }
      // 送り先。まだ行の無い再検は、この枠に固有の冪等キーで指す（送信待ちの間に続けて入力してもまとまる）
      const clientKey = rec.kind === 'recheck' && rec.vitalId == null ? (rec.clientKey ?? newClientKey()) : rec.clientKey
      const target = targetOf({ ...rec, clientKey })
      if (target === null) return
      // 送信待ちで止まっている行を、読み直しで食い違いが無くなったのを確かめてから送り直す時は、画面の基準で送る
      // （rebase。止まっていない行は、送信待ちの基準＝最初に直し始めた時の値のまま）
      const heldRow = pendingRow('vitals', target)
      const rebase = heldRow !== null && heldRow.state === 'conflict'
      const wasQueued = rec.state === 'queued'
      patchRec(key, { edits, clientKey, state: 'saving', message: stillBad ? invalidMessage : '' })
      // 送る前に印を付ける（変更通知が応答より先に届いても、自分の書き込みで取り直さない）
      selfWriteRef.current = Date.now()
      try {
        const res = await saveVitalEdits(target, sendEdits, {
          // 新しい行の測定時刻・記入者は「空いていれば埋める」（過去日をあとから埋める場合、端末の現在時刻は
          // 測定時刻ではないので入れない）。既にある行では何も埋めない
          ...(rec.vitalId == null
            ? { fill: { measured_at: rec.day === today ? nowHM() : null, recorded_by: actorId ?? null } }
            : {}),
          rebase,
        })
        if (!aliveRef.current) return
        const cur = recsRef.current.get(key)
        if (res === 'queued') {
          // 送信待ちへ渡し終えた欄だけ消す（R-D・欄単位）。送信待ちの値は重ねて表示し、その後に打つ値と見分ける
          const sentValues: Partial<Record<Field, number | null>> = {}
          for (const f of FIELDS) {
            const e = sendEdits[f]
            if (e) sentValues[f] = numOrNull(e.value)
          }
          const sent = { ...server, ...sentValues } as Record<Field, number | null>
          patchRec(key, {
            state: 'queued',
            message: wasQueued ? (cur?.message ?? MSG_QUEUED) : MSG_QUEUED,
            sent,
            edits: settleSent(cur?.edits ?? {}, sendEdits, sent),
          })
          return
        }
        // サーバーへ届いた＝この行の変更通知は自分が出したもの。取り直しの合図にしない
        selfWriteRef.current = Date.now()
        if (res.held === true) {
          // 他の端末の値と食い違って止まっている行へまとめた（送っていない）。競合として見せる
          await holdAsHeld(key)
          return
        }
        applySaveResult(key, rec, sendEdits, res)
      } catch (e) {
        if (!aliveRef.current) return
        // 保存失敗: edits は残す（R-D）。〔保存し直す〕で送り直せる。
        // db.ts の DbError は「何が起きたか＋次にどうすればよいか」を持っているので、そのまま出す
        patchRec(key, { state: 'error', message: e instanceof DbError && e.message ? e.message : ERR_SAVE })
      }
    },
    [actorId, applySaveResult, askClear, holdAsHeld, patchRec, today],
  )

  /** 行ごとの1本の順番待ち（構造規約 R-F）。通常の保存・保存し直し・くらべて選ぶの3択はすべてここを通す */
  const rowQueue = useMemo(() => createRowQueue(), [])
  /** 順番待ちに積まれている仕事の数（行ごと）。0 になるまで「保存の応答待ちがある」として扱う */
  const jobCountRef = useRef(new Map<string, number>())

  /**
   * 行の仕事を順番待ちに積む。積んでいる間は「保存の応答待ち」として数え（背景の取り直しを先送りする）、
   * 動き出す時と終わった時に自分の書込の印を付ける（その間に始まった読み込みの応答で描き直さない）。
   * 通常の保存も、くらべて選ぶの送信も、ここを通す（指摘 L2）
   */
  const runRowJob = useCallback(
    (key: string, job: () => Promise<void>): Promise<void> => {
      jobCountRef.current.set(key, (jobCountRef.current.get(key) ?? 0) + 1)
      savingRef.current.add(key)
      return rowQueue(key, async () => {
        selfWriteRef.current = Date.now()
        try {
          await job()
        } finally {
          selfWriteRef.current = Date.now()
        }
      }).finally(() => {
        const n = (jobCountRef.current.get(key) ?? 1) - 1
        if (n <= 0) {
          jobCountRef.current.delete(key)
          savingRef.current.delete(key)
        } else jobCountRef.current.set(key, n)
      })
    },
    [rowQueue],
  )

  /** 1行の保存を順番待ちに積む（積んだ時点の値は持ち越さず、動き出した時に最新から計算し直す） */
  const enqueueSave = useCallback(
    (key: string) => {
      void runRowJob(key, () => saveOne(key))
    },
    [runRowJob, saveOne],
  )

  /**
   * くらべて選ぶの送信（〔先の値を残す〕〔自分の値で直す〕〔両方残す〕）。通常の保存と同じ順番待ち・印・数えを通す
   * （指摘 L2）。送信待ちで止まっている値の取り下げ・送り直しは ConflictResolver が db.ts へ頼む
   */
  const runResolverJob = useCallback(
    (key: string, job: () => Promise<void>) => runRowJob(key, job),
    [runRowJob],
  )

  /**
   * 行が取り消されていた控えを、新しい行として保存する（〔新しい行として保存〕。行ごとの順番待ちを通す）。
   * 定時はその利用者・日の新しい定時の行、再検は新しい再検の行（冪等キー）。取り消された行の控えは外す
   */
  const saveAsNew = useCallback(
    (key: string) => {
      void runRowJob(key, async () => {
        const rec = recsRef.current.get(key)
        if (!rec || !rec.missing) return
        const vals = valuesForBoth(FIELDS, editValues(rec.edits ?? {})) as Partial<Record<Field, number>>
        const sendEdits: Edits<Field> = {}
        for (const f of Object.keys(vals) as Field[]) {
          const e = rec.edits?.[f]
          if (e) sendEdits[f] = { ...e, base: null }
        }
        if (Object.keys(sendEdits).length === 0) return
        const oldTarget = targetOf(rec)
        let target: VitalTarget
        let clientKey: string | undefined
        const newRow = rec.kind !== 'routine'
        // 取り消された行へ向けた送信待ち。定時以外は、新しい行が書けた・送信待ちに確保できた後で外す（F5）
        const oldPending = newRow && oldTarget ? pendingRow('vitals', oldTarget) : null
        if (!newRow) {
          target = { routine: true, residentId: rec.residentId, day: rec.day }
        } else {
          // その行の送信待ちにある値のある欄も、新しい行へ（基準 null＝F4）
          for (const f of FIELDS) {
            const v = oldPending?.values[f]
            if (sendEdits[f] === undefined && v !== null && v !== undefined) sendEdits[f] = { value: numOrNull(v), base: null, ver: 0 }
          }
          clientKey = newClientKey()
          target = { routine: false, clientKey, residentId: rec.residentId, day: rec.day, kind: 'recheck' }
        }
        patchRec(key, { state: 'saving', message: '', vitalId: rec.kind === 'routine' ? rec.vitalId : null, clientKey })
        selfWriteRef.current = Date.now()
        try {
          // 同じ行の送信待ちの全ての欄を「空欄を見て書いた」（基準 null）にそろえて送る（F4）
          const res = await saveVitalEdits(target, sendEdits, {
            rebase: true,
            asNew: true,
            fill: { measured_at: rec.day === today ? nowHM() : null, recorded_by: actorId ?? null },
          })
          if (newRow && oldTarget && (res === 'queued' || (res.conflicts.length === 0 && res.held !== true))) {
            // 新しい行が書けた・送信待ちに確保できた後で、元の送信待ち（新しい行へ移した値の版）を外す（F5）
            await discardPendingRow('vitals', oldTarget, undefined, seenVers(oldPending, editValues(sendEdits)))
          }
          if (!aliveRef.current) return
          if (res === 'queued') {
            patchRec(key, { state: 'queued', message: MSG_QUEUED, missing: undefined, edits: undefined })
            return
          }
          selfWriteRef.current = Date.now()
          applySaveResult(key, { ...rec, vitalId: null, clientKey }, sendEdits, res)
        } catch (e) {
          // 拒否（例外）: 元の送信待ちは残す（F5）。新しい行の送信待ちは外し、画面は元の行の控えのまま
          if (newRow) void discardPendingRow('vitals', target)
          if (!aliveRef.current) return
          patchRec(key, {
            state: 'conflict',
            message: e instanceof DbError && e.message ? e.message : ERR_SAVE,
            ...(newRow ? { vitalId: rec.vitalId, clientKey: rec.clientKey } : {}),
          })
        }
      })
    },
    [actorId, applySaveResult, patchRec, runRowJob, today],
  )

  /** 行が取り消されていた控えを取り下げる（〔取り下げる〕。送信待ちからも外す） */
  const dropMissing = useCallback(
    (key: string) => {
      void runRowJob(key, async () => {
        const rec = recsRef.current.get(key)
        if (!rec) return
        const target = targetOf(rec)
        // 画面が見せていた版だけ外す（第3段 #9。見た後に他のタブが入れた値は外さない）
        if (target) await discardPendingRow('vitals', target, undefined, seenVers(pendingRow('vitals', target), editValues(rec.edits ?? {})))
        if (!aliveRef.current) return
        patchRec(key, {
          edits: undefined,
          missing: undefined,
          clientKey: undefined,
          state: 'idle',
          message: '',
          buf: bufOf(rec.saved),
        })
      })
    },
    [patchRec, runRowJob],
  )

  // ── セル編集 ───────────────────────────────────────────────

  const onCommitCell = useCallback(
    (row: TableRow, day: string, field: Field, raw: string, meta?: { base: string }) => {
      const key = recKey(row.residentId, day, row.kind, row.slot)
      const cur = recsRef.current.get(key) ?? newRec(row.residentId, day, row.kind, row.slot)
      const buf = { ...cur.buf, [field]: raw }
      // 構造規約 R-E: この欄の基準は「編集を始めた時にセルに出ていた値」。読めない文字だった時は
      // サーバーの値を基準にする。既に編集のある欄は基準を変えない（recordFieldEdit）
      let edits = cur.edits ?? {}
      const after = inputCells(buf)
      if (field in after) {
        const startCells = meta ? inputCells({ ...cur.buf, [field]: meta.base }) : {}
        const shown = cur.state === 'queued' ? (cur.sent ?? cur.saved) : cur.saved
        const base = field in startCells ? (startCells[field] ?? null) : shown[field]
        // 血圧の上と下は1つの組（F4）: 片側を直したら、相方も「いまの値のまま」として一緒に送り、
        // サーバーに組で確かめさせる（相方を他の端末が変えていたら、組ごと書かない）
        const other = pairOf(field) as Field | null
        edits = recordFieldEdit(edits, field, after[field] ?? null, base, other ? { base: shown[other] } : undefined)
      } else {
        // 読めない・範囲外の入力に書き換えた。前の編集の値はもう利用者の意図ではないので外す（セルには文字を残す）
        edits = withoutFields(edits, [field])
      }
      const next = new Map(recsRef.current)
      next.set(key, {
        ...cur,
        buf,
        edits,
        // 値を触ったら「保存済み」表示は下ろす（未保存を保存済みに見せない）
        state: cur.state === 'saved' ? 'idle' : cur.state,
        message: cur.state === 'saved' ? '' : cur.message,
      })
      commitRecs(next)

      // 末尾の空行に入力されたら、次の空行を生やす（契約 §6・既存の挙動を維持）
      if (row.kind === 'recheck' && raw.trim() !== '') {
        const n = Math.max(recheckRowsRef.current.get(row.residentId) ?? 0, row.slot + 1)
        if (row.slot >= n - 1) {
          const out = new Map(recheckRowsRef.current)
          out.set(row.residentId, n + 1)
          commitRecheckRows(out)
        }
      }

      enqueueSave(key)
    },
    [commitRecheckRows, commitRecs, enqueueSave],
  )

  // ── 食い違いをくらべて選ぶ ─────────────────────────────────

  /** 競合中の1名1日を「くらべて選ぶ」画面で開く（開いた時点の入力で固定する） */
  const openCompare = useCallback(
    (row: TableRow, day: string, name: string) => {
      const key = recKey(row.residentId, day, row.kind, row.slot)
      const rec = recsRef.current.get(key)
      if (!rec || rec.state !== 'conflict') return
      setCompare({
        key,
        target: { table: 'vitals', residentId: row.residentId, day, kind: row.kind, vitalId: rec.vitalId },
        name,
        // 見ていた値＝欄ごとの基準（編集を始めた時の値）。編集の無い欄はサーバーの値
        base: { ...editBases(rec.edits ?? {}, rec.saved) },
        mine: { ...mineOf(rec) },
        focusId: nameCellId(row.rowId),
      })
    },
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
        // この経路でもフォーカスをその行の氏名のセルへ移す（2026-09-23 再審 指摘8）
        focusAfterResolve(cur.focusId)
        void load()
        return
      }
      const rec = recsRef.current.get(cur.key)
      if (!rec) return
      // 送信待ちで止まっていた値の取り下げ・送り直しは ConflictResolver が済ませている
      const v = r.latest as Vital | null
      const fresh = v ? recFromVital(v, rec.kind, rec.slot) : newRec(rec.residentId, rec.day, rec.kind, rec.slot)
      if (r.choice === 'mine' && r.queued) {
        // 自分の値で直す更新を送信待ちにした。送った内容を控え、送信の後に入れた値と見分ける
        patchRec(cur.key, {
          ...fresh,
          buf: bufOf(fresh.saved),
          state: 'queued',
          message: MSG_QUEUED,
          sent: fresh.saved,
          edits: undefined,
          stale: undefined,
          missing: undefined,
        })
        focusAfterResolve(cur.focusId)
        return
      }
      patchRec(cur.key, {
        ...fresh,
        state: r.choice === 'theirs' ? 'idle' : r.choice === 'both' && r.queued ? 'idle' : 'saved',
        message: r.choice === 'both' && r.queued ? MSG_BOTH_QUEUED : '',
        sent: undefined,
        edits: undefined,
        stale: undefined,
        missing: undefined,
      })
      // 〔くらべて選ぶ〕が消えるので、フォーカスをその行の氏名のセルへ移す（body へ落とさない）
      focusAfterResolve(cur.focusId)
      // 両方残す: 新しい再検の行を出すため取り直す（自分の書込なので変更通知では取り直されない）
      if (r.choice === 'both' && !r.queued) void load({ background: true })
    },
    [compare, load, patchRec],
  )

  // ── 止まっている入力を黙って捨てない（5画面共通） ──────────

  // アプリ内の画面移動・再読み込み・タブを閉じる時に確認を出すための登録（App・beforeunload が参照する）
  useEffect(
    () =>
      registerUnsaved(() => Array.from(recsRef.current.values()).some(holdsInput)),
    [],
  )

  /**
   * 表示する期間を切り替える前の確認。切り替えると期間の外になる行の控えは読み込みで捨てられるので、
   * 競合・未保存で止まっている入力がその中にあれば確かめてから切り替える（日報の askLeave と同じ形）
   */
  const guardWindow = useCallback((nextFrom: string, nextTo: string, apply: () => void) => {
    // 構造規約 R-G: 編集が1欄でも残る行（送信待ちの後・保存中に打った値、範囲外の警告中を含む）を数える
    const dropped = Array.from(recsRef.current.values()).some(
      (r) => holdsInput(r) && (r.day < nextFrom || r.day > nextTo),
    )
    if (!dropped) {
      apply()
      return
    }
    setLeaveAsk(() => apply)
  }, [])

  // ── 期間送り ───────────────────────────────────────────────

  const goOlder = useCallback(() => {
    const next = addDays(anchor, -days)
    guardWindow(addDays(next, -(days - 1)), next, () => setAnchor(next))
  }, [anchor, days, guardWindow])
  const goNewer = useCallback(() => {
    const raw = addDays(anchor, days)
    const next = raw > today ? today : raw
    guardWindow(addDays(next, -(days - 1)), next, () => setAnchor(next))
  }, [anchor, days, guardWindow, today])
  const atNewest = anchor >= today

  const periodLabel =
    days === 1 ? fmtDayLabel(anchor) : `${fmtDayLabel(fromIso)}〜${fmtDayLabel(anchor)}`

  // ── 表示用の集計 ───────────────────────────────────────────

  const recList = useMemo(() => Array.from(recs.values()), [recs])
  const savingCount = recList.filter((r) => r.state === 'saving').length
  const savedCount = recList.filter((r) => r.state === 'saved').length

  // 読み込み中は最優先で知らせる。期間を送ると表の中身は総入れ替えになり、
  // 取得が終わるまで全セルが空欄で描かれる＝「この期間は記録なし」と読み違えられるため
  const statusText = loading
    ? '↻ 読み込み中'
    : savingCount > 0
      ? `↻ 保存中 ${savingCount}件`
      : pending > 0
        ? `⚠ 未送信 ${pending}件`
        : savedCount > 0
          ? `✓ 保存済み ${savedCount}件`
          : '未保存の変更はありません'

  // 読み込み中は編集させない（空欄に見えているだけのセルへ上書き入力させない）
  const editable = inputEnabled && !gateUnknown && !cellsMissing && !loading

  // ── 描画 ───────────────────────────────────────────────────

  if (loading && recs.size === 0 && residents.length === 0) {
    return <LoadingBlock label="バイタル一覧を読み込んでいます…" />
  }

  if (error && residents.length === 0) {
    return <ErrorBlock message={error} onRetry={() => void load()} />
  }

  return (
    <div className="pb-4">
      {/* ── 操作バー ── */}
      {/* 見出しと状態は操作バーと同じ行に畳む（2026-08-29 指示）。
          上に積む高さが減ったぶん、表の高さ上限（.sheet-frame-fit）が自動で広がる */}
      <div className="border-b border-border bg-surface pb-2">

        {/* フロア・日数のボタンは文字ぶんの幅にする（sheet.css の .sheet-pickbar）。
            既定の flex:1 のままだと、同じ行にある期間送り・倍率と幅を取り合って
            「1階」が「1」「階」の2行に折れていた（2026-08-28 実機で確認）。
            食事一覧と同じ仕組み。高さ 44px は変えない＝押しやすさは落とさない。
            見出し（フロア／横に並べる日数）はこの行に入れると横幅が足りなくなるため付けない
            （ボタンの文字だけで何の切替か分かる。読み上げ名は ariaLabel が持つ） */}
        <div className="sheet-pickbar">
          {floorOptions.length > 1 ? (
            <div className="sheet-pickbar-group">
              <SegmentPicker
                options={floorOptions}
                value={floor}
                onChange={(v) => {
                  setFloor(v)
                  writeFloor(v)
                }}
                ariaLabel="フロアを選ぶ"
              />
            </div>
          ) : null}

          <div className="sheet-pickbar-group">
            <SegmentPicker
              options={SHEET_DAYS.map((d) => ({ value: String(d), label: `${d}日` }))}
              value={String(days)}
              onChange={(v) => {
                const n = Number(v)
                if (!(SHEET_DAYS as readonly number[]).includes(n)) return
                guardWindow(addDays(anchor, -(n - 1)), anchor, () => {
                  setDays(n as SheetDays)
                  writeDays(n as SheetDays)
                })
              }}
              ariaLabel="横に並べる日数を選ぶ"
            />
          </div>

          <div className="flex items-center gap-gap">
            {/* 読み込み中の連打は、表示が空欄のまま期間だけ進む＝取り違えのもとになるので止める */}
            <button
              type="button"
              onClick={goOlder}
              disabled={loading}
              aria-label="前の期間を表示する"
              className={`min-h-tap min-w-tap rounded border px-3 text-base ${
                loading
                  ? 'border-border bg-surface2 text-ink3'
                  : 'border-border-strong bg-surface text-ink'
              }`}
            >
              <span aria-hidden="true">‹</span>
              <span className="sr-only">前の期間</span>
            </button>
            <span className="tabular text-base text-ink" aria-live="polite">
              {periodLabel}
            </span>
            <button
              type="button"
              onClick={goNewer}
              disabled={atNewest || loading}
              aria-label="次の期間を表示する"
              className={`min-h-tap min-w-tap rounded border px-3 text-base ${
                atNewest || loading
                  ? 'border-border bg-surface2 text-ink3'
                  : 'border-border-strong bg-surface text-ink'
              }`}
            >
              <span aria-hidden="true">›</span>
              <span className="sr-only">次の期間</span>
            </button>
          </div>

          <ZoomBar compact />

          {/* 保存状況（未送信・保存中・保存済み）。同じ行の末尾に置く＝行を増やさない。
              画面が狭い時は折り返して2行目に来る（消さない＝保存できたかは必ず見せる） */}
          <p
            role="status"
            aria-live="polite"
            className={
              loading
                ? 'text-base text-ink2'
                : pending > 0
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
            <button
              type="button"
              onClick={() => void load()}
              className="ml-2 min-h-tap rounded border border-danger px-3 text-base font-bold text-danger"
            >
              読み込み直す
            </button>
          </p>
        ) : null}
      </div>

      {/* 他の端末が入力中の欄の要約（誰が・どこを）。無い時も1行の高さを取る＝出ても表を押し下げない */}
      <PresenceSummary
        text={presence.summary((p) => {
          if (p.cell.table !== 'vitals' || !dayList.includes(p.day)) return null
          const kind = p.cell.kind ?? 'routine'
          if (!(SHEET_KINDS as readonly string[]).includes(kind) || !(FIELDS as string[]).includes(p.cell.field)) return null
          const r = visibleResidents.find((x) => x.id === p.residentId)
          if (!r) return null
          const when = p.day === today ? '' : ` ${fmtDayLabel(p.day)}`
          return `${r.name}${when}${kind === 'recheck' ? ' 再検' : ''} ${FIELD_LABEL[p.cell.field as Field]}`
        })}
      />

      {/* ── 表（3状態: 空はここで出し分ける） ── */}
      {residents.length === 0 ? (
        <div className="pt-4">
          <EmptyBlock
            message="利用者の一覧がまだありません。設定タブでマスタ同期を実行してください。"
            actionLabel="読み込み直す"
            onAction={() => void load()}
          />
        </div>
      ) : visibleResidents.length === 0 ? (
        <div className="pt-4">
          <EmptyBlock message="このフロアに対象の利用者がいません。上のボタンでフロアを切り替えてください。" />
        </div>
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
              左端・上端の罫線は各セルが持たない（右・下だけ）ため table 側で引く */}
          <table
            className="tabular sheet-table border-l border-t border-border text-ink"
            style={{ fontSize: SHEET_FONT, borderSpacing: 0 }}
          >
            <caption className="sr-only">
              {periodLabel}のバイタル一覧（居室昇順・新しい日が左・1日あたり体温／血圧（上）／血圧（下）／脈拍／SpO2）
            </caption>
            {/* 列幅の正本。table-layout: fixed ではここ（と1行目）だけが幅を決めるので、
                値が長くなっても列が動かない＝スプシと同じ見え方になる */}
            <colgroup>
              <col style={{ width: W_ROOM }} />
              <col style={{ width: W_NAME }} />
              {dayList.map((d) => (
                <Fragment key={d}>
                  {FIELDS.map((f) => (
                    <col key={f} style={{ width: FIELD_WIDTH[f] }} />
                  ))}
                </Fragment>
              ))}
            </colgroup>
            <thead>
              <tr style={{ height: HEAD_H }}>
                <th
                  scope="col"
                  rowSpan={2}
                  style={{ width: W_ROOM, minWidth: W_ROOM, left: 0, top: 0 }}
                  className={`${CELL_BASE} sticky z-30 bg-surface2 font-bold text-ink2`}
                >
                  居室
                </th>
                <th
                  scope="col"
                  rowSpan={2}
                  style={{ width: W_NAME, minWidth: W_NAME, left: W_ROOM, top: 0 }}
                  className={`${CELL_BASE} sticky z-30 bg-surface2 text-left font-bold text-ink2`}
                >
                  入居者名
                </th>
                {dayList.map((d) => (
                  // 土日は日付欄のセル色を変える（土＝濃い水色・日＝赤）。
                  // 色と地色の指定は .sheet-sat / .sheet-sun が持つので、平日用の
                  // bg-surface2 は当てない（同じ要素に2つの背景色を当てて優先順位を作らない）
                  <th
                    key={d}
                    scope="colgroup"
                    colSpan={FIELDS.length}
                    style={{ top: 0 }}
                    className={`${CELL_BASE} ${DAY_END} ${dayHeadClass(d)} sticky z-20 font-bold`}
                  >
                    {fmtDayLabel(d)}
                    {d === today ? <span className="sr-only">（本日）</span> : null}
                  </th>
                ))}
              </tr>
              <tr style={{ height: HEAD_H }}>
                {dayList.map((d) => (
                  <Fragment key={d}>
                    {FIELDS.map((f, i) => (
                      <th
                        key={f}
                        scope="col"
                        style={{ top: HEAD_H, width: FIELD_WIDTH[f], minWidth: FIELD_WIDTH[f] }}
                        className={`${CELL_BASE} ${i === FIELDS.length - 1 ? DAY_END : ''} sticky z-20 bg-surface2 font-normal text-ink2`}
                      >
                        <span aria-hidden="true">{FIELD_HEAD[f]}</span>
                        <span className="sr-only">
                          {fmtDayLabel(d)} {FIELD_LABEL[f]}
                        </span>
                      </th>
                    ))}
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, i) => {
                const resident = visibleResidents.find((r) => r.id === row.residentId)
                const name = resident?.name ?? ''
                const room = resident?.room ?? null
                const isRoutine = row.kind === 'routine'
                // その行で警告・エラーが出ている日（日付とセットで出す）
                const notices = dayList
                  .map((d) => ({ day: d, rec: recs.get(recKey(row.residentId, d, row.kind, row.slot)) }))
                  .filter((x) => x.rec && x.rec.message !== '')
                // 「✕」を出すのは、その入居者の一番下の再検行で、かつ中身が空の時だけ
                // （記録のある枠・途中の枠は消せない＝記録を隠さない／通し番号をずらさない）
                const isLastRecheck =
                  !isRoutine && row.slot === (recheckRows.get(row.residentId) ?? 0) - 1
                const removable =
                  isLastRecheck && editable && isRecheckRowEmpty(row.residentId, row.slot)
                return (
                  <FragmentRow
                    key={row.rowId}
                    row={row}
                    name={name}
                    room={room}
                    isRoutine={isRoutine}
                    // 1行おきの縞（2行目・4行目…に付ける）。行を目で追いやすくする
                    alt={i % 2 === 1}
                    dayList={dayList}
                    recs={recs}
                    editable={editable}
                    removable={removable}
                    notices={notices}
                    onCommitCell={onCommitCell}
                    presence={presence}
                    onAddRecheck={addRecheckRow}
                    onRemoveRecheck={removeRecheckRow}
                    onReload={() => void load()}
                    onCompare={(day) => openCompare(row, day, name)}
                    onResave={(day) => enqueueSave(recKey(row.residentId, day, row.kind, row.slot))}
                    onSaveNew={(day) => saveAsNew(recKey(row.residentId, day, row.kind, row.slot))}
                    onDrop={(day) => dropMissing(recKey(row.residentId, day, row.kind, row.slot))}
                  />
                )
              })}
            </tbody>
          </table>
        </SheetFrame>
      )}

      <ConfirmDialog
        open={leaveAsk !== null}
        title={LEAVE_TITLE}
        body="食い違って止まっている入力、またはまだ保存していない入力が、切り替えた後の期間の外になります。切り替えると、その入力は破棄されます。切り替えてよろしいですか。"
        confirmLabel="切り替える"
        danger
        onConfirm={() => {
          const apply = leaveAsk
          setLeaveAsk(null)
          apply?.()
        }}
        onCancel={() => setLeaveAsk(null)}
      />

      <ConflictResolver
        target={compare?.target ?? null}
        residentName={compare?.name ?? ''}
        base={compare?.base ?? {}}
        mine={compare?.mine ?? {}}
        actorId={actorId ?? null}
        serialize={compare ? (job) => runResolverJob(compare.key, job) : undefined}
        onClose={() => setCompare(null)}
        onResolved={onResolved}
      />

      <ConfirmDialog
        open={clearAsk != null}
        title="記録済みの値を空にしますか"
        body={
          clearAsk
            ? `${fmtDayLabel(clearAsk.day)}の ${clearAsk.labels} を空（未測定）にして保存します。取りやめる場合は「キャンセル」を押してください（元の値に戻ります）。`
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

// ── 1行（＝1名×1枠。横に日が並ぶ）＋その行の警告行 ───────────

interface FragmentRowProps {
  row: TableRow
  name: string
  room: string | null
  isRoutine: boolean
  /** 1行おきの縞（薄いグレー）を敷く行 */
  alt: boolean
  dayList: string[]
  recs: Map<string, Rec>
  editable: boolean
  /** この再検行に「✕」を出すか（一番下の空の再検行だけ true） */
  removable?: boolean
  notices: { day: string; rec: Rec | undefined }[]
  onCommitCell: (row: TableRow, day: string, field: Field, raw: string, meta?: { base: string }) => void
  /** 他の端末が入力中の欄・行の表示と、この端末が欄に入った／離れたの通知（Presence） */
  presence: CellPresence
  onAddRecheck: (residentId: number) => void
  onRemoveRecheck: (residentId: number) => void
  onReload: () => void
  /** 競合中の日を「くらべて選ぶ」画面で開く */
  onCompare: (day: string) => void
  /** 未保存・保存失敗の日の編集を送り直す */
  onResave: (day: string) => void
  /** 行が取り消されていた控えを新しい行として保存する */
  onSaveNew: (day: string) => void
  /** 行が取り消されていた控えを取り下げる */
  onDrop: (day: string) => void
}

function FragmentRow({
  row,
  name,
  room,
  isRoutine,
  alt,
  dayList,
  recs,
  editable,
  removable = false,
  notices,
  onCommitCell,
  presence,
  onAddRecheck,
  onRemoveRecheck,
  onReload,
  onCompare,
  onResave,
  onSaveNew,
  onDrop,
}: FragmentRowProps) {
  // 縞は行が持つ。左固定の2列は他の列の上に重なるので、透けないよう同じ色を自分でも持つ
  const rowBg = alt ? ROW_ALT : ROW_PLAIN
  // 他の端末がこの入居者のどこかの欄を入力中（表示している日のどれか）。欄が画面外でも気づけるよう
  // 氏名の行（定時の行）に出す
  const rowBusy = isRoutine ? presence.rowBusy('vitals', dayList, row.residentId, SHEET_KINDS) : null
  return (
    <>
      <tr style={{ height: ROW_H }} className={rowBg}>
        <th
          scope="row"
          style={{ width: W_ROOM, minWidth: W_ROOM, left: 0 }}
          className={`${CELL_BASE} tabular sticky z-10 ${rowBg} text-center font-normal text-ink2`}
        >
          {isRoutine ? (room ?? '—') : ''}
        </th>
        <td
          // 食い違いを解決した後のフォーカスの戻り先（タブ順には入れない）
          id={nameCellId(row.rowId)}
          tabIndex={-1}
          style={{ width: W_NAME, minWidth: W_NAME, maxWidth: W_NAME, left: W_ROOM }}
          className={`${CELL_BASE} sticky z-10 ${rowBg} text-left text-ink`}
        >
          {isRoutine ? (
            // 氏名の右に「再検」ボタン。押すとこの入居者の直下に再検欄が1本増える。
            // 切り詰め（truncate）はセルではなく氏名の span に持たせる
            // ＝ボタンのフォーカスリングがセルに切り取られない
            <div className="flex items-center gap-1">
              {/* 他の端末が入力中の時は氏名の後ろに「✎」（読み上げは「入力中: 職員B」）。1文字なので並びは崩さない */}
              <span className="min-w-0 flex-1 truncate">
                {name}
                {rowBusy !== null ? <RowBusyMark text={rowBusy} /> : null}
              </span>
              <button
                type="button"
                disabled={!editable}
                onClick={() => onAddRecheck(row.residentId)}
                aria-label={
                  editable ? `${name} の再検欄を追加する` : `${name} の再検欄（今は追加できません）`
                }
                // 行の高さに収める（トークン既定の 44px のままだと1行だけ倍に広がる）。
                // 押しやすさは表示倍率（200% で行高 44px）と読み上げ名で担保する
                // ＝ sheet-contracts §4 の裁定（行が詰まっていて広げられない場合）に従う
                style={{ minHeight: ROW_H }}
                className="min-w-0 shrink-0 rounded border border-primary px-1 text-primary disabled:border-border disabled:text-ink3"
              >
                <span aria-hidden="true">再検</span>
              </button>
            </div>
          ) : (
            // 再検行。押し間違いで出した空の枠は右端の「✕」で消せる（2026-08-28 指示）。
            // ✕ が出るのは一番下の**空の**枠だけ＝記録のある枠は消せない（原則4）
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-ink2">
                <span aria-hidden="true">↳ 再検</span>
                <span className="sr-only">
                  {name} の再検 {row.slot + 1}本目
                </span>
              </span>
              {removable ? (
                <button
                  type="button"
                  onClick={() => onRemoveRecheck(row.residentId)}
                  aria-label={`${name} の再検欄（空）を消す`}
                  // 「再検」ボタンと同じ理由で行の高さに収める（押しやすさは倍率200%で担保）
                  style={{ minHeight: ROW_H }}
                  className="min-w-0 shrink-0 rounded border border-border-strong px-1 text-ink2"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              ) : null}
            </div>
          )}
        </td>
        {dayList.map((day) => (
          <Fragment key={day}>
            {FIELDS.map((f, i) => {
              const rec = recs.get(recKey(row.residentId, day, row.kind, row.slot))
              const raw = rec?.buf[f] ?? ''
              const parsed = normalizeVitalInput(raw, f)
              const bad = parsed != null && outOfRange(f, parsed)
              // 範囲外・未確定の入力にはしきい値の色を付けない（誤った意味づけを避ける）
              const level = parsed != null && !bad ? LEVEL_FN[f](parsed) : null
              // この欄（Presence の照合）。再検は行 id で指す（まだ行が無い枠は id なし）
              const target: CellTarget = {
                table: 'vitals',
                day,
                residentId: row.residentId,
                field: f,
                kind: row.kind,
                id: isRoutine ? null : (rec?.vitalId ?? null),
              }
              return (
                <SheetCell
                  key={f}
                  value={raw}
                  onCommit={
                    editable ? (v: string, meta: { base: string }) => onCommitCell(row, day, f, v, meta) : undefined
                  }
                  busy={presence.cellBusy(target)}
                  onEditStart={() => presence.enter(focusOf(target))}
                  align="center"
                  width={FIELD_WIDTH[f]}
                  level={level}
                  // 背景を持たないセル（tone='row'）にして、行の縞を透けさせる。
                  // しきい値の色がある時は SheetCell が level の色をセルに置く＝縞より上に来る
                  tone="row"
                  // 日の切れ目は各日の最後の列（SpO2）の右罫線で示す
                  groupEnd={i === FIELDS.length - 1}
                  ariaLabel={`${room ?? '居室未設定'} ${name} ${fmtDayLabel(day)} ${
                    KIND_LABEL[row.kind]
                  } ${FIELD_LABEL[f]}`}
                />
              )
            })}
          </Fragment>
        ))}
      </tr>
      {notices.length > 0 ? (
        // 警告行は同じ入居者・同じ枠の続きなので、縞も同じ色にする
        <tr className={rowBg}>
          <td
            colSpan={2 + dayList.length * FIELDS.length}
            className="border-b border-r border-border px-1 py-2"
          >
            {notices.map(({ day, rec }) =>
              rec ? (
                <p
                  key={day}
                  role="alert"
                  className={
                    rec.state === 'conflict' || rec.state === 'error'
                      ? 'text-base text-danger'
                      : 'text-base text-warn'
                  }
                >
                  <span aria-hidden="true">▲ </span>
                  <span className="tabular font-bold">{fmtDayLabel(day)}</span>
                  {'：'}
                  {rec.message}
                  {/* 送信待ちの MSG_QUEUED は自動送信を待つだけなので出さない */}
                  {rec.state === 'conflict' ? (
                    <button
                      type="button"
                      onClick={onReload}
                      className="ml-2 min-h-tap rounded border border-danger px-3 text-base font-bold text-danger"
                    >
                      読み込み直す
                    </button>
                  ) : null}
                  {/* 未保存・保存失敗の編集を送り直す（同じ値を確定し直しても送られないため、ボタンで送る） */}
                  {rec.state === 'error' && hasEdits(rec.edits) && editable ? (
                    <button
                      type="button"
                      onClick={() => onResave(day)}
                      aria-label={`${name} ${fmtDayLabel(day)} ${KIND_LABEL[row.kind]}のまだ保存していない入力を保存し直す`}
                      className="ml-2 min-h-tap rounded border border-primary px-3 text-base font-bold text-primary"
                    >
                      保存し直す
                    </button>
                  ) : null}
                  {/* 行が取り消されていた控え: 新しい行として保存するか、取り下げる（日報の「行が無い控え」と同じ） */}
                  {rec.state === 'conflict' && rec.missing ? (
                    <>
                      <button
                        type="button"
                        disabled={!editable}
                        onClick={() => onSaveNew(day)}
                        aria-label={`${name} ${fmtDayLabel(day)} ${KIND_LABEL[row.kind]}のまだ保存していない入力を新しい行として保存する`}
                        className="ml-2 min-h-tap rounded border border-primary px-3 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
                      >
                        新しい行として保存
                      </button>
                      <button
                        type="button"
                        onClick={() => onDrop(day)}
                        aria-label={`${name} ${fmtDayLabel(day)} ${KIND_LABEL[row.kind]}のまだ保存していない入力を取り下げる`}
                        className="ml-2 min-h-tap rounded border border-border-strong px-3 text-base text-ink"
                      >
                        取り下げる
                      </button>
                    </>
                  ) : null}
                  {/* 食い違いを並べて、どちらを残すか選ぶ（既存の「読み込み直す」はそのまま残す） */}
                  {rec.state === 'conflict' && !rec.missing ? (
                    <button
                      type="button"
                      onClick={() => onCompare(day)}
                      aria-label={`${name} ${fmtDayLabel(day)} ${KIND_LABEL[row.kind]}の食い違いをくらべて選ぶ`}
                      className="ml-2 min-h-tap rounded border border-primary px-3 text-base font-bold text-primary"
                    >
                      くらべて選ぶ
                    </button>
                  ) : null}
                </p>
              ) : null,
            )}
          </td>
        </tr>
      ) : null}
    </>
  )
}

export default VitalsSheetPage
