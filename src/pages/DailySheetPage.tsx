// 日報シート（現行スプレッドシート「申し送り」タブの再現・既定画面）。
// レイアウトの正本: docs/design/sheet-contracts.md §5 を上から順に実装する。
//   日付バー → ヘッダ（施設名・日勤/夜勤日報・日付）→ 出勤者 → 外出者 → 外泊者 →
//   発熱者 → 他症状者 → 日勤申し送り → 黒帯「↓16時以降の記録」→ デイサービス → 夜勤申し送り
//
// この画面の規律（contracts.md §共通規律 / sheet-contracts.md §8）:
//   - supabase へは触れず db.ts の関数だけを呼ぶ。個人情報を console・localStorage に出さない
//   - Tailwind は トークン由来クラスのみ。シートの寸法は sheet.css の CSS 変数を style で参照する
//   - 入力封鎖中（native_input_enabled=false）は編集不可＋理由文。閲覧・既読は可能
//   - 破壊的操作（行の削除・値の消去）は確認、出勤者の取り消しは Undo
//   - 3状態（ローディング／エラー／空）を持つ。読み取り経路から書き込まない（既読は明示操作のみ）
//   - 「＋追加」は空行を足すだけ。本文（申し送り）や値（発熱者・他症状者）が入るまで保存しない
//
// 部品の前提（src/components/sheet.tsx・sheet-contracts.md §4 の署名どおりに呼ぶ）:
//   SheetFrame({children, className?}) / ZoomBar() /
//   SheetCell({value, onCommit?, align?, width?, level?, tone?, placeholder?, multiline?, ariaLabel}) /
//   ColorPicker({value, onChange, ariaLabel}) /
//   CollapsibleBlock({title, count, children, onAdd, addLabel, defaultOpen?})
//   ※ SheetCell が描画する要素の種類（td/div）に依存しないよう、表は div の行で組み、
//     各セルは幅を持つ入れ物で包んでから SheetCell を置く。

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Chip,
  ConfirmDialog,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  ResidentPickerModal,
  SegmentPicker,
  StaffPickerModal,
  useToast,
} from '../components/ui'
// 行の色 → 背景色の対応は sheet.tsx の NOTE_COLOR_CLASS を唯一の正本として使う
// （見本＝ColorPicker の swatch と行の背景が食い違わないようにするため）
import {
  CollapsibleBlock,
  ColorPicker,
  NOTE_COLOR_CLASS,
  SheetCell,
  SheetFrame,
  ZoomBar,
} from '../components/sheet'
import {
  DbError,
  fetchDailyReport,
  fetchResidents,
  fetchStaff,
  getAppSetting,
  getNativeInputGate,
  insertNote,
  insertOuting,
  insertVitalKind,
  isQueuePersisted,
  markRead,
  saveAttendance,
  setOutingEnd,
  softDeleteNote,
  subscribeChanges,
  updateNoteFields,
  updateVital,
} from '../lib/db'
import { getActorId, touchActivity } from '../lib/actor'
import { addDays, fmtDayLabel, fmtTimeHM, normalizeVitalInput, todayIso, toHalfWidth } from '../lib/format'
import {
  IMPORTANCE_LABEL,
  NOTE_COLOR_LABEL,
  ROLE_TAGS,
  VITAL_RANGE,
  diaBpLevel,
  pulseLevel,
  spo2Level,
  sysBpLevel,
  tempLevel,
} from '../lib/types'
import type {
  Attendance,
  Importance,
  Level,
  Note,
  NoteColor,
  Outing,
  OutingKind,
  Resident,
  Shift,
  Staff,
  Vital,
} from '../lib/types'

// ══════════════════════════════════════════════════════════════
// 定数・文言
// ══════════════════════════════════════════════════════════════

/** 入力封鎖中（切替日D前）の理由文。ui-design.md §0.5 の定型文をそのまま使う */
const BLOCKED_REASON = '現在はスプレッドシートで記録する期間です（アプリ入力の開始日は施設で決定します）'
/**
 * 入力できるかどうかを**観測できなかった**時（getNativeInputGate が observed:false）の理由文。
 * db.ts が MSG.gateUnknown と DbError('gate-unknown') でこの状態を封鎖中と区別しているので、
 * 画面側も分ける。混同すると、実際には解禁済みかもしれない期間に
 * 「スプレッドシートで記録する期間です」という誤った運用事実を職員に伝えることになる。
 * 画面上部のバナーと行の一言はこの1か所から配る（同じ画面で2つの理由が食い違わないように）。
 */
const GATE_UNKNOWN_REASON =
  '入力できるかどうかを確認できませんでした（通信エラー）。安全のため入力は止めています。電波状態を確認してから「最新に更新」を押してください。'

/**
 * 「他の端末で記録が更新されました」を出す対象の表（この画面が描画するものだけ）。
 * db.ts の REALTIME_TABLES には日報が描画しない meals / fluid_intake も含まれるため、
 * 表名で絞らないと他端末の食事・水分の記録（1日に数百件入る）のたびに案内が出て、
 * 申し送り・出勤者が本当に変わった時の合図として機能しなくなる。
 * 同型の実装は useTimeline.ts の WATCHED_TABLES。
 */
const WATCHED_TABLES = new Set(['notes', 'outings', 'vitals', 'attendance', 'note_reads'])

const ERR_LOAD =
  '日報を読み込めませんでした（通信エラー）。電波状態を確認してから、再試行してください。記録は消えていません'
const ERR_SAVE =
  '保存できませんでした（通信エラー）。電波状態を確認して、もう一度お試しください。入力は消えていません'
/**
 * 出勤者の保存に失敗した時の定型文。
 * この操作だけは失敗すると画面を保存前へ戻す（チップの並びを推測で残さない）ので、
 * 「入力は消えていません」とは書かず、選び直す行動まで書く。
 */
const ERR_SAVE_ATTENDANCE =
  '出勤者を保存できませんでした（通信エラー）。画面は保存前の状態に戻しました。電波状態を確認してから、もう一度選び直してください'
const ERR_CONFLICT =
  '他の端末で先に更新されました。入力は消えていません。「最新に更新」を押して内容を確認してから、もう一度お試しください'
const ERR_EMPTY_BODY = '本文は空にできません。行ごと消す場合は「詳細」から削除してください'
const ERR_NO_ACTOR = '記録する職員が選ばれていません。画面上部の「記録者」から選んでください'
const MSG_QUEUED = '⚠ 未送信（電波が戻ると自動で送信します）'
const MSG_NOT_PERSISTED =
  '▲ 送信待ちにしましたが端末に控えを残せませんでした。この画面を閉じずに電波の回復をお待ちください'
const MSG_SAVED = '✓ 保存しました'
/** 応答を待つ間に日付を送った時。保存はできているが、今開いている日の記録ではない */
const MSG_SAVED_OTHER_DAY = '保存しました（表示中の日付が変わったため、この画面には出していません）'
/**
 * 応答待ちの行に、重ねて確定が来た時の案内。
 * 同じ行から2回 insert すると同じ内容の行が2本できるため受け付けないが、
 * 黙って捨てると「入力したのに消えた」になるので、必ず理由と次の行動を出す。
 */
const MSG_BUSY = '▲ 前の保存の応答を待っています。数秒後にもう一度お試しください（入力は消えていません）'
const MSG_BUSY_VITAL =
  '▲ 前の保存の応答を待っています。数秒待ってから、この欄をもう一度入力してください（先に確定した値は保存中です）'
/** 値が1つも無い行は作らない（空の観察・症状の行を記録に残さない） */
const MSG_EMPTY_VITAL =
  '▲ 値が入っていないため保存していません。時刻・体温・SpO2・血圧・脈・症状のいずれかを入力してください'
/**
 * 送信待ちに退避済み（locked）の行は取り消せない。
 * 画面から消しても退避した登録は残っていて、電波が戻ると同じ内容が登録される＝
 * 「取り消したのに後から出てくる」を作らないため（消去は保全ゲートの後ろ）。
 */
const MSG_LOCKED_DELETE = '送信待ちのため取り消せません。送信が終わってから、行の削除をしてください'
/**
 * ピッカーで選んだのに、その行が画面から無くなっていた時の案内。
 * 黙って捨てると「対象を選んだのに空欄のまま」になるため、理由と次の行動を必ず出す。
 */
const MSG_PICK_LOST =
  '▲ 保存が完了したため選択を反映できませんでした。行の対象／記入者をもう一度選んでください'

/** 3セット並べる発熱者ブロックの1行あたりの枠数（現行スプシの実測） */
const FEVER_SETS = 3

/**
 * 血圧セルの幅。この画面は上下を1つのセルに「151/91」とまとめて出すため、
 * バイタル一覧の血圧2列分（--w-sys ＋ --w-dia）を確保する。
 * 1列分（60px）ではしきい値の記号（↑↑ ↓↓）まで入らず truncate に食われる＝
 * 色だけで意味を伝えることになるため（sheet-contracts.md §8-8）。
 */
const W_BP = 'calc(var(--w-sys) + var(--w-dia))'

/** 発熱者の1セット（時 KT SpO2 BP P）の幅。時と脈は同じ --w-pulse を使う */
const W_FEVER_SET = `calc(var(--w-pulse) * 2 + var(--w-temp) + var(--w-spo2) + ${W_BP})`
/**
 * シート（器）の最小幅。いちばん列の多い発熱者ブロック（氏名＋3セット）の固定列の合計に、
 * ブロックの枠（CollapsibleBlock の枠線 1px×2 と内側の余白 --sp-2 ×2）を足した値。
 * **器の幅をこの確定値と画面幅だけで決める**ことで、幅の計算に中身の文字の長さが入らなくなる＝
 * 申し送りの長文でシート全体が横に伸びず、伸びるのは行の高さだけになる
 * （sheet-contracts.md §5「長文は行が伸びる（clamp しない）」）。
 */
const SHEET_MIN_W = `calc(var(--w-name) + ${W_FEVER_SET} * ${FEVER_SETS} + var(--sp-2) * 2 + var(--sheet-rule) * 2)`

const VITAL_FIELD_LABEL: Record<'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2', string> = {
  temp: '体温',
  sys_bp: '血圧（上）',
  dia_bp: '血圧（下）',
  pulse: '脈拍',
  spo2: 'SpO2',
}

/**
 * セル内ボタン（対象・記入者・詳細・登録）の当たり判定。
 * 拡張量の判断は sheet.css の .sheet-hit（--sheet-hit-pad）に預ける＝共通部品 SheetCell と同じ。
 * この画面の行は .sheet-dense の中にあるので**拡張量は常に 0px**になる：申し送りの行は縦に連続していて、
 * 上下へ広げると隣の行とヒットが重なり「1つ下の行の編集・詳細が開く」＝記録の取り違えになるため
 * （sheet.css 冒頭の裁定3）。押しやすさは ZoomBar（125/150%）と aria-label で担保する。
 */
const CELL_HIT = 'sheet-hit'

/**
 * 行の中に置くボタンの高さ。
 * tokens.css の `:where(button,…){min-height:44px}` をそのままにすると、
 * 23px の申し送り行がボタン1つで 45px に広がり、スプシの密度が再現できない
 * （当たり判定は行の見た目を変えずに ::before で下方向へ広げる。詰まった行で 44px に届かない分は
 *  表示倍率 200% を選べば行高 44px になる＝ZOOM_STEPS の注記のとおり）。
 */
const ROW_BTN_STYLE: CSSProperties = { minHeight: 'var(--sheet-row-h-note)' }

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 参照の同一性を保つための空配列 */
const NO_RESIDENTS: Resident[] = []
const NO_STAFF: Staff[] = []

// ══════════════════════════════════════════════════════════════
// 小さなヘルパ（純関数）
// ══════════════════════════════════════════════════════════════

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 端末ローカルの現在時刻 HH:MM（既存の記録画面と同じ扱い） */
function nowHM(): string {
  const d = new Date()
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 利用者の表示名。マスタ未取得時も氏名を作らず ID 表記に落とす */
function residentName(r: Resident | undefined, id: number | null): string {
  if (r) return r.name
  return id == null ? '' : `利用者ID ${id}`
}

function staffName(s: Staff | undefined, id: number | null): string {
  if (s) return s.name
  return id == null ? '' : `職員ID ${id}`
}

/** 居室の数値順（数字が無い部屋は末尾）。VitalsGridPage と同じ並び方 */
function cmpResident(a: Resident, b: Resident): number {
  const na = Number((a.room ?? '').replace(/[^0-9]/g, ''))
  const nb = Number((b.room ?? '').replace(/[^0-9]/g, ''))
  const va = Number.isFinite(na) && (a.room ?? '') !== '' ? na : Number.MAX_SAFE_INTEGER
  const vb = Number.isFinite(nb) && (b.room ?? '') !== '' ? nb : Number.MAX_SAFE_INTEGER
  if (va !== vb) return va - vb
  return a.id - b.id
}

function outOfRange(field: keyof typeof VITAL_RANGE, v: number): boolean {
  const [lo, hi] = VITAL_RANGE[field]
  return v < lo || v > hi
}

/**
 * 書式・範囲のエラー文。**保存済みの行では打った文字が残らない**（セルはサーバーの値へ戻る）ので、
 * 「入力は消えていません」とは書かず、入れ直す行動まで書く（下書き行では入力は残る）。
 */
function rangeMsg(field: keyof typeof VITAL_RANGE): string {
  const [lo, hi] = VITAL_RANGE[field]
  return `▲ ${VITAL_FIELD_LABEL[field]}は ${lo}〜${hi} の範囲で入力してください（保存していません。もう一度入力してください）`
}

type NumResult = { ok: true; value: number | null } | { ok: false; message: string }

/** 数値セルの入力を正規化する。空文字は「消す」意思として null を返す */
function parseNum(raw: string, field: keyof typeof VITAL_RANGE): NumResult {
  const s = toHalfWidth(raw)
  if (s === '') return { ok: true, value: null }
  const v = normalizeVitalInput(s, field)
  if (v === null) {
    return {
      ok: false,
      message: `▲ ${VITAL_FIELD_LABEL[field]}は数字で入力してください（保存していません。もう一度入力してください）`,
    }
  }
  if (outOfRange(field, v)) return { ok: false, message: rangeMsg(field) }
  return { ok: true, value: v }
}

type BpResult = { ok: true; sys: number | null; dia: number | null } | { ok: false; message: string }

/** 「120/80」形式の血圧セル。片方だけの入力も受ける */
function parseBp(raw: string): BpResult {
  const s = toHalfWidth(raw).replace(/／/g, '/')
  if (s === '') return { ok: true, sys: null, dia: null }
  const parts = s.split('/')
  const sysRes = parseNum(parts[0] ?? '', 'sys_bp')
  if (!sysRes.ok) return { ok: false, message: sysRes.message }
  const diaRes = parseNum(parts[1] ?? '', 'dia_bp')
  if (!diaRes.ok) return { ok: false, message: diaRes.message }
  if (sysRes.value === null && diaRes.value === null) {
    return {
      ok: false,
      message: '▲ 血圧は「120/80」のように入力してください（保存していません。もう一度入力してください）',
    }
  }
  return { ok: true, sys: sysRes.value, dia: diaRes.value }
}

function fmtBp(sys: number | null, dia: number | null): string {
  if (sys == null && dia == null) return ''
  return `${sys ?? ''}/${dia ?? ''}`.replace(/\/$/, '')
}

type TimeResult = { ok: true; value: string | null } | { ok: false; message: string }

/** 「9:30」「0930」「9」→ 'HH:MM'。空文字は null（未記入） */
function parseHM(raw: string): TimeResult {
  const s = toHalfWidth(raw).replace(/[:：]/g, ':')
  if (s === '') return { ok: true, value: null }
  const m = /^(\d{1,2}):?(\d{2})?$/.exec(s)
  if (!m) {
    return {
      ok: false,
      message: '▲ 時刻は「9:30」のように入力してください（保存していません。もう一度入力してください）',
    }
  }
  const h = Number(m[1])
  const mi = m[2] === undefined ? 0 : Number(m[2])
  if (h > 23 || mi > 59) {
    return {
      ok: false,
      message: '▲ 時刻は 0:00〜23:59 で入力してください（保存していません。もう一度入力してください）',
    }
  }
  return { ok: true, value: `${pad2(h)}:${pad2(mi)}` }
}

type DayTimeResult = { ok: true; on: string | null; at: string | null } | { ok: false; message: string }

/** 「8/30 10:30」「10:30」→ 日付＋時刻。日付が無ければ基準日を使う */
function parseDayTime(raw: string, baseIso: string): DayTimeResult {
  const s = toHalfWidth(raw).replace(/[:：]/g, ':').replace(/\s+/g, ' ').trim()
  if (s === '') return { ok: true, on: null, at: null }
  const parts = s.split(' ')
  const first = parts[0] ?? ''
  if (first.includes('/')) {
    const md = /^(\d{1,2})\/(\d{1,2})$/.exec(first)
    if (!md) return { ok: false, message: '▲ 日時は「8/30 10:30」のように入力してください' }
    const year = Number(baseIso.slice(0, 4))
    const mm = Number(md[1])
    const dd = Number(md[2])
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
      return { ok: false, message: '▲ 日付が正しくありません。「8/30 10:30」のように入力してください' }
    }
    const time = parseHM(parts[1] ?? '')
    if (!time.ok) return { ok: false, message: time.message }
    return { ok: true, on: `${year}-${pad2(mm)}-${pad2(dd)}`, at: time.value }
  }
  const time = parseHM(first)
  if (!time.ok) return { ok: false, message: time.message }
  return { ok: true, on: baseIso, at: time.value }
}

/** 到着（日付＋時刻）の表示。基準日と同じ日なら時刻だけにする（スプシと同じ見せ方） */
function fmtDayTime(on: string | null, at: string | null, baseIso: string): string {
  if (on == null && at == null) return ''
  const time = fmtTimeHM(at)
  if (on == null || on === baseIso) return time
  const [, m, d] = on.split('-')
  return `${Number(m)}/${Number(d)} ${time}`.trim()
}

/** その月の日を並べる（日付リンク用）。壊れた値では空配列を返す */
function monthDays(iso: string): string[] {
  if (!ISO_DATE_RE.test(iso)) return []
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7))
  const last = new Date(y, m, 0).getDate()
  const out: string[] = []
  for (let d = 1; d <= last; d++) out.push(`${y}-${pad2(m)}-${pad2(d)}`)
  return out
}

function errText(err: unknown): string {
  if (err instanceof DbError) return err.message
  return ERR_SAVE
}

/** 血圧セルに出す記号は、上下のうち重い方を採る（記号は LEVEL_MARK 側で付く） */
function bpLevel(sys: number | null, dia: number | null): Level {
  const a = sysBpLevel(sys)
  const b = diaBpLevel(dia)
  const weight = (l: Level): number =>
    l === 'danger-high' || l === 'danger-low' ? 2 : l === 'warn-high' || l === 'warn-low' ? 1 : 0
  return weight(a) >= weight(b) ? a : b
}

// ══════════════════════════════════════════════════════════════
// 行モデル
// ══════════════════════════════════════════════════════════════

/** 行に添える一言（保存結果・入力エラー）。色だけでなく記号を必ず含める */
interface RowStatus {
  tone: 'ok' | 'warn' | 'danger'
  text: string
}

interface NoteDraft {
  key: string
  shift: Shift
  after16: boolean
  residentId: number | null
  /** 対象を一度でも選んだか（未選択と「全体」を区別する） */
  targetPicked: boolean
  body: string
  reporterId: number | null
  color: NoteColor | null
  /** 送信待ちに退避した行。同じ内容を二重に登録しないため編集を止める */
  locked: boolean
}

interface VitalSetInput {
  at: string
  temp: string
  spo2: string
  bp: string
  pulse: string
}

function emptySet(): VitalSetInput {
  return { at: '', temp: '', spo2: '', bp: '', pulse: '' }
}

/**
 * 下書きの1枠に入っている値を、そのまま保存できる形へ。
 * 読めない値・範囲外の値は落とす（その値を確定したときに行へエラーを出しているため、
 * ここで二重に知らせない。保存されるのは読めた値だけ）。
 */
function setToPatch(s: VitalSetInput): Partial<Omit<Vital, 'id' | 'rev'>> {
  const patch: Partial<Omit<Vital, 'id' | 'rev'>> = {}
  const at = parseHM(s.at)
  if (at.ok && at.value !== null) patch.measured_at = at.value
  const temp = parseNum(s.temp, 'temp')
  if (temp.ok && temp.value !== null) patch.temp = temp.value
  const spo2 = parseNum(s.spo2, 'spo2')
  if (spo2.ok && spo2.value !== null) patch.spo2 = spo2.value
  const pulse = parseNum(s.pulse, 'pulse')
  if (pulse.ok && pulse.value !== null) patch.pulse = pulse.value
  const bp = parseBp(s.bp)
  if (bp.ok) {
    if (bp.sys !== null) patch.sys_bp = bp.sys
    if (bp.dia !== null) patch.dia_bp = bp.dia
  }
  return patch
}

/**
 * 保存に足る値が1つでもあるか（空行を作らないための判定・sheet-contracts.md §5
 * 「空行は送信しない＝空データを作らない」）。
 * 空欄を確定した時の patch は「消す意思」の null だけになるので、
 * 件数（Object.keys）では空行かどうかを判定できない。
 */
function hasVitalValue(fields: Partial<Vital>): boolean {
  const keys = ['measured_at', 'temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2', 'symptom'] as const
  return keys.some((k) => fields[k] != null)
}

interface VitalDraft {
  key: string
  kind: 'observation' | 'symptom'
  residentId: number | null
  sets: VitalSetInput[]
  symptom: string
  locked: boolean
}

interface OutingDraft {
  key: string
  kind: OutingKind
  residentId: number | null
  place: string
  startAt: string
  endText: string
  companion: string
  locked: boolean
}

/** 発熱者ブロックの1行（同じ利用者の観察を最大3枠ずつまとめる） */
interface FeverRow {
  key: string
  residentId: number
  slots: (Vital | null)[]
}

function buildFeverRows(list: Vital[], order: Map<number, number>): FeverRow[] {
  const byResident = new Map<number, Vital[]>()
  for (const v of list) {
    const arr = byResident.get(v.resident_id)
    if (arr) arr.push(v)
    else byResident.set(v.resident_id, [v])
  }
  const rows: FeverRow[] = []
  const ids = Array.from(byResident.keys()).sort(
    (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
  )
  for (const id of ids) {
    const arr = (byResident.get(id) ?? []).slice().sort((a, b) => a.id - b.id)
    for (let i = 0; i < arr.length; i += FEVER_SETS) {
      const slots: (Vital | null)[] = []
      for (let j = 0; j < FEVER_SETS; j++) slots.push(arr[i + j] ?? null)
      rows.push({ key: `f${id}-${i / FEVER_SETS}`, residentId: id, slots })
    }
  }
  return rows
}

/**
 * 追加した観察（発熱者）が入る行のキー。buildFeverRows と同じ規則で
 * 「同じ利用者の N 件目は N / FEVER_SETS 行目」に入る。
 * list は**この1件を足す前**の一覧（並びは id 昇順で、追加した行が最後に来る前提）。
 */
function feverRowKey(v: Vital, list: Vital[]): string {
  const before = list.filter((x) => x.resident_id === v.resident_id && x.id !== v.id).length
  return `f${v.resident_id}-${Math.floor(before / FEVER_SETS)}`
}

// ══════════════════════════════════════════════════════════════
// 共通の見た目（div で組む表。SheetCell の描画要素に依存しない）
// ══════════════════════════════════════════════════════════════

function Row({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex items-stretch border-b border-border ${className}`}
      style={{ minHeight: 'var(--sheet-row-h-note)' }}
    >
      {children}
    </div>
  )
}

function HeadRow({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-stretch border-b border-border-strong bg-surface2 font-bold text-ink2"
      style={{ minHeight: 'var(--sheet-head-h)' }}
    >
      {children}
    </div>
  )
}

/**
 * 幅を持つセルの入れ物。width は sheet.css の CSS 変数（または 'auto'）で渡す。
 * pad=false は「中身が自分で左右余白を持つ」時に使う（SheetCell・PickerCell・行内ボタンを入れる枠）。
 * **左右余白は入れ物か中身のどちらか一方だけが持つ**（どちらも 4px）。
 * 二重に取ると、その列だけ中身が 8px 右へずれて列見出し（HeadCell＝4px）と左端が食い違い、
 * 狭い列（血圧 60px・脈 50px）では末尾のしきい値記号（↑↑ ↓↓）が truncate に食われて
 * 色だけの表示になる＝色だけで意味を伝えることになるため。
 */
function Cell({
  width,
  grow = false,
  pad = true,
  children,
  className = '',
}: {
  width?: string
  grow?: boolean
  pad?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`min-w-0 border-r border-border ${pad ? 'px-1' : ''} ${grow ? 'flex-1' : 'shrink-0'} ${className}`}
      style={grow ? undefined : { width }}
    >
      {children}
    </div>
  )
}

function HeadCell({ width, grow = false, children }: { width?: string; grow?: boolean; children: ReactNode }) {
  return (
    <Cell width={width} grow={grow} className="flex items-center">
      <span className="truncate">{children}</span>
    </Cell>
  )
}

/**
 * 行に添える一言（保存結果・入力エラー・封鎖の理由）。
 * - ライブリージョンは常設し、中身だけ差し替える（ui.tsx の Toast と同じ作法。
 *   role="status" は要素ごと現れた時の読み上げが保証されないため）
 * - 折り返す（truncate しない）。競合・保存失敗の文は「次にどうすればよいか」まで
 *   書いてあり、1行に切り詰めると対処手順が画面から消える
 */
function StatusText({ status }: { status?: RowStatus }) {
  const cls = !status
    ? ''
    : status.tone === 'danger'
      ? 'text-danger'
      : status.tone === 'warn'
        ? 'text-warn'
        : 'text-ok'
  return (
    <span role="status" aria-live="polite" className={`block whitespace-normal break-words ${cls}`}>
      {status ? status.text : ''}
    </span>
  )
}

/** ピッカーを開くセル（対象・記入者・氏名）。読み上げのため aria-label を必ず付ける */
function PickerCell({
  width,
  grow = false,
  text,
  label,
  disabled,
  onClick,
}: {
  width?: string
  grow?: boolean
  text: string
  label: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    // 余白はこの中のボタン（px-1）だけが持つ。入れ物にも取ると中身が 8px ずれて
    // 列見出しと左端が合わなくなる（sheet-contracts.md §1「セルは 0 マージンで詰める」）
    <Cell width={width} grow={grow} pad={false} className="flex items-center">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        style={ROW_BTN_STYLE}
        className={`${CELL_HIT} w-full rounded-sm px-1 text-left ${
          disabled ? 'text-ink2' : 'text-link'
        }`}
      >
        {/* truncate（overflow:hidden）はボタン自身に付けない。付けると当たり判定を広げる
            ::before が切り取られて拡張が死ぬため、内側の span に持たせる */}
        <span className="block truncate">
          {text === '' ? <span aria-hidden="true">—</span> : text}
        </span>
      </button>
    </Cell>
  )
}

// ══════════════════════════════════════════════════════════════
// ページ本体
// ══════════════════════════════════════════════════════════════

export interface DailySheetPageProps {
  /** App.tsx が保持していれば渡す（省略時はこの画面で取得する） */
  residents?: Resident[]
  staff?: Staff[]
  /** 操作者（記入者）の staff_id。省略時は cl_staffId から読む */
  actorId?: number | null
  /** 入力解禁フラグ。省略時はこの画面の表示ごとに取得する（前提情報は毎回取り直す） */
  inputEnabled?: boolean
}

type Phase = 'loading' | 'ready' | 'error'

type PickTarget =
  | { for: 'noteTarget'; key: string }
  | { for: 'noteReporter'; key: string }
  | { for: 'vitalTarget'; key: string }
  | { for: 'outingTarget'; key: string }
  | { for: 'attendance'; role: 'manager' | 'staff' }

interface ConfirmState {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
}

export function DailySheetPage({
  residents: propResidents,
  staff: propStaff,
  actorId: propActorId,
  inputEnabled: propInputEnabled,
}: DailySheetPageProps = {}) {
  const [day, setDay] = useState(() => todayIso())
  const [phase, setPhase] = useState<Phase>('loading')
  const [reload, setReload] = useState(0)
  const [residents, setResidents] = useState<Resident[]>(propResidents ?? NO_RESIDENTS)
  const [staff, setStaff] = useState<Staff[]>(propStaff ?? NO_STAFF)
  const [facility, setFacility] = useState<string | null>(null)
  const [enabled, setEnabled] = useState<boolean>(propInputEnabled ?? false)
  /** 入力できるかどうかを観測できなかった（通信エラー）。封鎖の理由文とは分けて案内する */
  const [gateUnknown, setGateUnknown] = useState(false)

  const [notes, setNotes] = useState<Note[]>([])
  const [observations, setObservations] = useState<Vital[]>([])
  const [symptoms, setSymptoms] = useState<Vital[]>([])
  const [outings, setOutings] = useState<Outing[]>([])
  const [attendance, setAttendance] = useState<Attendance[]>([])

  const [noteDrafts, setNoteDrafts] = useState<NoteDraft[]>([])
  const [vitalDrafts, setVitalDrafts] = useState<VitalDraft[]>([])
  const [outingDrafts, setOutingDrafts] = useState<OutingDraft[]>([])

  const [status, setStatus] = useState<Record<string, RowStatus>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [residentPick, setResidentPick] = useState<PickTarget | null>(null)
  const [staffPick, setStaffPick] = useState<PickTarget | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  const { toast, show } = useToast()

  const aliveRef = useRef(true)
  const seqRef = useRef(0)
  /**
   * 現在表示している日。登録の応答が返るまでに日付を送られていないかを確かめる
   * （応答を無条件に今の state へ足すと、別の日の記録が今日のブロックに現れる）。
   */
  const dayRef = useRef(day)
  /** 自分の書き込みで出た変更通知に反応しないための抑制窓 */
  const selfWriteRef = useRef(0)
  /** 登録の応答待ちの行。二重に登録しないための鍵（同じ行から2回 insert しない） */
  const savingRef = useRef(new Set<string>())
  /**
   * 出勤者の最新の一覧。保存は応答が返ってから画面へ反映するので、
   * 連続操作（✕を続けて押す等）の2件目は state ではなくこの ref を基準に組み直す
   * （render 時の値を prev にすると、1件目の結果を知らないまま送って取り消しが巻き戻る）。
   */
  const attendanceRef = useRef<Attendance[]>([])
  /** 出勤者の保存を日付ごとに直列化する（MealsSheetPage の chainRef と同型） */
  const attendanceChainRef = useRef(new Map<string, Promise<void>>())
  /**
   * 発熱者の最新の一覧。保存直後に「保存済み行が使うキー」を組み立てるため、
   * setObservations の反映を待たずに「同じ人の何件目か」を数える。
   */
  const observationsRef = useRef<Vital[]>([])

  const actorId = propActorId !== undefined ? propActorId : getActorId()

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    dayRef.current = day
  }, [day])

  // 保存処理から読む最新値（setState の反映を待たずに使う）
  useEffect(() => {
    observationsRef.current = observations
  }, [observations])

  /**
   * 出勤者の一覧を差し替える。**ref と state を必ず同時に**書く
   * （直列化した次の保存は再描画を待たずに走るので、ref を後追いで同期すると古い値を基準にしてしまう）。
   */
  const applyAttendance = useCallback((rows: Attendance[]) => {
    attendanceRef.current = rows
    setAttendance(rows)
  }, [])

  /** 登録の応答を今の画面へ足してよいか（日付を送っていたら足さない＝取り違えを作らない） */
  const stillOnDay = useCallback((dayAtStart: string): boolean => dayRef.current === dayAtStart, [])

  const nextKey = useCallback((prefix: string) => {
    seqRef.current += 1
    return `${prefix}${seqRef.current}`
  }, [])

  const setRowStatus = useCallback((key: string, s: RowStatus | null) => {
    setStatus((prev) => {
      if (s === null) {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      }
      return { ...prev, [key]: s }
    })
  }, [])

  // ── 読み込み ───────────────────────────────────────────────

  useEffect(() => {
    let alive = true
    setPhase('loading')
    void (async () => {
      try {
        const [rs, st, gate, report, fac] = await Promise.all([
          propResidents ? Promise.resolve(propResidents) : fetchResidents(),
          propStaff ? Promise.resolve(propStaff) : fetchStaff(),
          // 入力解禁フラグは「観測できた値」と「観測できなかった」を区別するため、
          // 親から既知値をもらっていても必ず自分で取り直す（前提情報は毎回取り直す規範）。
          // 親（App.tsx）は取得失敗時も false を渡してくるので、prop を観測済みとして扱うと
          // 通信障害を「スプレッドシートで記録する期間です」と誤って案内してしまう
          getNativeInputGate(),
          fetchDailyReport(day, actorId),
          // 施設名は表示だけの補助情報。取れなくても日報は開けるようにする
          getAppSetting('facility_name').catch(() => null),
        ])
        if (!alive || !aliveRef.current) return

        const list = (Array.isArray(rs) ? rs : []).filter((r) => r != null && r.active !== false)
        setResidents(list.slice().sort(cmpResident))
        setStaff((Array.isArray(st) ? st : []).filter((s) => s != null))
        setEnabled(gate.value === true)
        setGateUnknown(!gate.observed)
        setFacility(typeof fac === 'string' && fac.trim() !== '' ? fac : null)

        const safeNotes = Array.isArray(report?.notes) ? report.notes.filter((n) => n != null) : []
        setNotes(
          safeNotes
            .slice()
            .sort((a, b) => (a.occurred_at ?? '').localeCompare(b.occurred_at ?? '') || a.id - b.id),
        )
        setObservations(
          Array.isArray(report?.observations) ? report.observations.filter((v) => v != null) : [],
        )
        setSymptoms(Array.isArray(report?.symptoms) ? report.symptoms.filter((v) => v != null) : [])
        setOutings(Array.isArray(report?.outings) ? report.outings.filter((o) => o != null) : [])
        applyAttendance(
          Array.isArray(report?.attendance) ? report.attendance.filter((a) => a != null) : [],
        )
        setStale(false)
        setPhase('ready')
      } catch {
        if (!alive || !aliveRef.current) return
        // 失敗しても入力中の下書きは消さない（安全側フォールバック）
        setPhase('error')
      }
    })()
    return () => {
      alive = false
    }
    // propInputEnabled は依存に入れない（初期 state 専用）。
    // 親（App.tsx）の入力解禁フラグは起動直後に false→true へ切り替わるので、依存に入れると
    // その一瞬で日報の再取得が走り、読み込み済みの画面が「読み込んでいます…」へ戻ってしまう。
    // この画面は封鎖フラグを自分で getNativeInputGate() から取り直しているため prop は不要
  }, [day, reload, actorId, propResidents, propStaff, applyAttendance])

  // 変更通知は自動で取り込まず「最新に更新」の案内だけ出す（編集中の入力を勝手に差し替えない）
  useEffect(() => {
    let unsub: (() => void) | null = null
    try {
      unsub = subscribeChanges((table) => {
        if (!aliveRef.current) return
        // この画面が描画する表の変更だけを合図にする（食事・水分の記録では出さない）
        if (typeof table !== 'string' || !WATCHED_TABLES.has(table)) return
        if (Date.now() - selfWriteRef.current < 3000) return
        setStale(true)
      })
    } catch {
      unsub = null
    }
    return () => {
      if (unsub) {
        try {
          unsub()
        } catch {
          // 解除できなくても表示に影響しない
        }
      }
    }
  }, [])

  const residentById = useMemo(() => {
    const m = new Map<number, Resident>()
    for (const r of residents) m.set(r.id, r)
    return m
  }, [residents])

  const staffById = useMemo(() => {
    const m = new Map<number, Staff>()
    for (const s of staff) m.set(s.id, s)
    return m
  }, [staff])

  const residentOrder = useMemo(() => {
    const m = new Map<number, number>()
    residents.forEach((r, i) => m.set(r.id, i))
    return m
  }, [residents])

  // ── 書き込みの共通処理 ─────────────────────────────────────

  const markSelfWrite = useCallback(() => {
    selfWriteRef.current = Date.now()
    touchActivity()
  }, [])

  /**
   * 入力できない理由。**観測できた false（＝スプシで記録する期間）と、
   * 観測できなかった（＝通信エラー）を分ける**。上部のバナーもこの値を出すので、
   * 同じ画面に食い違う2つの理由が並ばない。
   */
  const blockedReason = gateUnknown ? GATE_UNKNOWN_REASON : BLOCKED_REASON

  /** 編集の可否。封鎖中・読み込み中は書かせない（理由は行に出す） */
  const guard = useCallback(
    (key: string): boolean => {
      if (!enabled) {
        setRowStatus(key, { tone: 'warn', text: `▲ ${blockedReason}` })
        return false
      }
      return true
    },
    [blockedReason, enabled, setRowStatus],
  )

  const askConfirm = useCallback((s: ConfirmState) => setConfirm(s), [])

  // ── 日付の移動（未保存の下書きがあれば確認する）─────────────

  const hasDraftContent = useMemo(() => {
    const noteDirty = noteDrafts.some((d) => d.body.trim() !== '' || d.targetPicked)
    const vitalDirty = vitalDrafts.some(
      (d) =>
        d.residentId !== null ||
        d.symptom.trim() !== '' ||
        d.sets.some((s) => s.at || s.temp || s.spo2 || s.bp || s.pulse),
    )
    const outingDirty = outingDrafts.some(
      (d) =>
        d.residentId !== null ||
        d.place.trim() !== '' ||
        d.startAt !== '' ||
        d.endText !== '' ||
        d.companion.trim() !== '',
    )
    return noteDirty || vitalDirty || outingDirty
  }, [noteDrafts, vitalDrafts, outingDrafts])

  const applyDay = useCallback((next: string) => {
    setDay(next)
    setNoteDrafts([])
    setVitalDrafts([])
    setOutingDrafts([])
    setStatus({})
    setExpanded(null)
  }, [])

  const goDay = useCallback(
    (next: string) => {
      if (next === day) return
      if (hasDraftContent) {
        askConfirm({
          title: '未保存の入力があります',
          body: '保存していない行があります。日付を移動すると、その入力は破棄されます。移動してよろしいですか。',
          confirmLabel: '移動する',
          onConfirm: () => {
            setConfirm(null)
            applyDay(next)
          },
        })
        return
      }
      applyDay(next)
    },
    [day, hasDraftContent, askConfirm, applyDay],
  )

  // ── 出勤者 ─────────────────────────────────────────────────

  /**
   * 保存する一覧を「実行する時点の一覧（prev）」から組み立てる関数。
   * null を返すと何も送らない（すでに同じ状態＝送る必要が無い時）。
   */
  type AttendancePlan = { rows: Attendance[]; undoLabel: string | null } | null

  /** 直列化した保存の呼び出し口（Undo から呼ぶために ref で持つ。定義の循環を避ける） */
  const enqueueAttendanceRef = useRef<(dayIso: string, build: (prev: Attendance[]) => AttendancePlan) => void>(
    () => undefined,
  )

  const persistAttendance = useCallback(
    async (dayIso: string, rows: Attendance[], prev: Attendance[], undoLabel: string | null) => {
      setRowStatus('attendance', null)
      const next = rows.map((a, i) => ({ ...a, sort: i }))
      try {
        // 抑制の印は「送る前」に付ける（saveAttendance は内部で読み直し→追加→更新→非表示を
        // 順に実行するので、応答を待ってから付けると自分の書き込み由来の変更通知に反応して
        // 「他の端末で記録が更新されました」と誤って案内してしまう）
        markSelfWrite()
        await saveAttendance(
          dayIso,
          next.map((a) => ({ staff_id: a.staff_id, role: a.role, sort: a.sort })),
          // 取り消してよいのは「この端末が画面に持っていた人」だけ。
          // 読み込み後に他端末が足した出勤者は、この端末からは見えていないので触らせない
          { baseline: prev.map((a) => a.staff_id) },
        )
        // 応答を待つ間に日付を送られていたら、別の日の一覧を今の画面へ入れない
        if (!aliveRef.current || dayRef.current !== dayIso) return
        applyAttendance(next)
        if (undoLabel !== null) {
          show(undoLabel, () => {
            // 戻す操作も同じ列に並べる（戻した内容が、後から届いた保存で上書きされないように）。
            // baseline は戻す時点の一覧から組み直す＝直列化後の実際の前状態になる
            enqueueAttendanceRef.current(dayIso, () => ({ rows: prev, undoLabel: null }))
          })
        }
      } catch (err) {
        // 一部だけサーバーへ載った失敗は巻き戻さない（載った分を「保存されていない」と見せない）。
        // 巻き戻す時は「入力は消えていません」と書かない＝画面の実挙動と文言をそろえる
        const partial = err instanceof DbError && err.partial
        if (!aliveRef.current || dayRef.current !== dayIso) return
        if (!partial) applyAttendance(prev)
        const text = err instanceof DbError ? err.message : ERR_SAVE_ATTENDANCE
        setRowStatus('attendance', { tone: 'danger', text: `▲ ${text}` })
      }
    },
    [applyAttendance, markSelfWrite, setRowStatus, show],
  )

  /**
   * 出勤者の保存を日付ごとに直列化する（MealsSheetPage の enqueue と同型）。
   * 応答を待つ間に積まれた操作は、**前の応答の結果（attendanceRef）を基準に組み直す**。
   * 直列化しないと、例えば [A,B,C] から A の✕→（応答前に）B の✕ と押した時、
   * 2件目が古い一覧を送って A の取り消しが巻き戻る（sort が復活する）。
   */
  const enqueueAttendance = useCallback(
    (dayIso: string, build: (prev: Attendance[]) => AttendancePlan) => {
      const chain = attendanceChainRef.current
      const job = async () => {
        if (!aliveRef.current) return
        // 日付を送った後に前の操作が流れてきても、別の日の一覧を書き換えない
        if (dayRef.current !== dayIso) return
        const prev = attendanceRef.current
        const plan = build(prev)
        if (plan === null) return
        await persistAttendance(dayIso, plan.rows, prev, plan.undoLabel)
      }
      const prevChain = chain.get(dayIso) ?? Promise.resolve()
      const nextChain = prevChain
        .catch(() => undefined)
        .then(job)
        .catch(() => undefined)
      chain.set(dayIso, nextChain)
    },
    [persistAttendance],
  )

  useEffect(() => {
    enqueueAttendanceRef.current = enqueueAttendance
  }, [enqueueAttendance])

  const addAttendance = useCallback(
    (staffId: number, role: 'manager' | 'staff') => {
      enqueueAttendance(day, (prev) => {
        const replacing =
          role === 'manager' && prev.some((a) => a.role === 'manager' && a.staff_id !== staffId)
        const cleaned = prev.filter(
          (a) => a.staff_id !== staffId && !(role === 'manager' && a.role === 'manager'),
        )
        return {
          rows: [...cleaned, { day, staff_id: staffId, role, sort: cleaned.length }],
          // 施設長の入れ替えは既存の行を取り消す＝破壊的操作なので、
          // 「出勤者から外す」と同じ Undo の導線に乗せる（1タップで戻せないようにしない）
          undoLabel: replacing ? '施設長を入れ替えました' : null,
        }
      })
    },
    [day, enqueueAttendance],
  )

  const removeAttendance = useCallback(
    (staffId: number) => {
      enqueueAttendance(day, (prev) => {
        // すでに外れている（応答待ちの間に2回押した）時は送らない
        if (!prev.some((a) => a.staff_id === staffId)) return null
        return { rows: prev.filter((a) => a.staff_id !== staffId), undoLabel: '出勤者から外しました' }
      })
    },
    [day, enqueueAttendance],
  )

  // ── 申し送り ───────────────────────────────────────────────

  const addNoteDraft = useCallback(
    (shift: Shift, after16: boolean) => {
      // 封鎖中は書けない行を増やさない。理由だけを知らせる
      // （封鎖中と「確認できていない」を取り違えた案内をしない＝blockedReason が出し分ける）
      if (!enabled) {
        show(blockedReason)
        return
      }
      const key = nextKey('nd')
      setNoteDrafts((prev) => [
        ...prev,
        {
          key,
          shift,
          after16,
          residentId: null,
          targetPicked: false,
          body: '',
          reporterId: shift === 'night' ? null : actorId,
          color: null,
          locked: false,
        },
      ])
    },
    [actorId, blockedReason, enabled, nextKey, show],
  )

  const patchNoteDraft = useCallback((key: string, patch: Partial<NoteDraft>) => {
    setNoteDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  }, [])

  const patchNote = useCallback((id: number, patch: Partial<Note>) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)))
  }, [])

  /**
   * 下書き行が保存されて id が付いた時、開いたままのピッカーの行き先を新しいキーへ移す。
   * 張り替えないと、選んだ対象・記入者が消えた下書きのキー宛のまま届いて無言で捨てられる
   * （対象・記入者が未設定のまま記録が残ってしまう）。
   */
  const rebindPick = useCallback((fromKey: string, toKey: string) => {
    setResidentPick((cur) =>
      cur !== null && cur.for === 'noteTarget' && cur.key === fromKey ? { ...cur, key: toKey } : cur,
    )
    setStaffPick((cur) =>
      cur !== null && cur.for === 'noteReporter' && cur.key === fromKey
        ? { ...cur, key: toKey }
        : cur,
    )
  }, [])

  /** 保存済みの申し送りの部分更新（送った項目だけ書き、他は温存する） */
  const updateNoteCell = useCallback(
    async (note: Note, patch: Parameters<typeof updateNoteFields>[2], optimistic: Partial<Note>) => {
      const key = `n${note.id}`
      if (!guard(key)) return
      setRowStatus(key, null)
      try {
        // 抑制の印は送る前に付ける（応答後だと、自分の書き込み由来の変更通知に反応して
        // 「他の端末で記録が更新されました」と誤って案内してしまう）
        markSelfWrite()
        const res = await updateNoteFields(note.id, note.rev, patch)
        if (res === 'conflict') {
          setRowStatus(key, { tone: 'danger', text: `▲ ${ERR_CONFLICT}` })
          return
        }
        if (res === 'queued') {
          // 入力どおりに表示したまま送信待ちにする（値を巻き戻さない）
          patchNote(note.id, optimistic)
          setRowStatus(key, { tone: 'warn', text: MSG_QUEUED })
          return
        }
        patchNote(note.id, res)
        setRowStatus(key, { tone: 'ok', text: MSG_SAVED })
      } catch (err) {
        setRowStatus(key, { tone: 'danger', text: `▲ ${errText(err)}` })
      }
    },
    [guard, markSelfWrite, patchNote, setRowStatus],
  )

  /** 下書き行の保存（本文が入った時点で1回だけ insert する） */
  const saveNoteDraft = useCallback(
    async (draft: NoteDraft, body: string) => {
      const key = draft.key
      if (!guard(key)) return
      // 応答待ちの間に同じ行から2回目を送らない（同じ内容の行が2本できるのを防ぐ）。
      // 受け付けない時は理由を出す（入力は下書きに残っている）
      if (savingRef.current.has(key)) {
        patchNoteDraft(key, { body })
        setRowStatus(key, { tone: 'warn', text: MSG_BUSY })
        return
      }
      savingRef.current.add(key)
      setRowStatus(key, null)
      try {
        markSelfWrite() // 送る前に印を付ける（自分の書き込みで「他の端末で更新」を出さない）
        const res = await insertNote({
          note_on: day,
          shift: draft.shift,
          facility: null,
          category: null,
          resident_id: draft.residentId,
          role_tags: [],
          importance: 'normal',
          body: body.trim(),
          // 記録日が今日のときだけ現在時刻を入れる（過去日に誤った時刻を残さない）
          occurred_at: day === todayIso() ? nowHM() : null,
          ongoing: false,
          ended_at: null,
          reporter_id: draft.reporterId,
          color: draft.color,
          after16: draft.after16,
        })
        if (res === 'queued') {
          patchNoteDraft(key, { body: body.trim(), locked: true })
          setRowStatus(key, {
            tone: 'warn',
            text: isQueuePersisted() ? MSG_QUEUED : MSG_NOT_PERSISTED,
          })
          return
        }
        setNoteDrafts((prev) => prev.filter((d) => d.key !== key))
        if (!stillOnDay(day)) {
          // 応答を待つ間に日付を送られた。保存はできているので、今の画面には足さずに伝える
          show(MSG_SAVED_OTHER_DAY)
          return
        }
        // 同じ id が既に入っていれば入れ替える（再読込と行き違っても行が2つにならない）
        setNotes((prev) => [...prev.filter((n) => n.id !== res.id), res])
        // 保存中に開いたままのピッカーを、保存済みの行のキーへ移す（選択を取りこぼさない）
        rebindPick(key, `n${res.id}`)
        setRowStatus(`n${res.id}`, { tone: 'ok', text: MSG_SAVED })
      } catch (err) {
        patchNoteDraft(key, { body })
        setRowStatus(key, { tone: 'danger', text: `▲ ${errText(err)}` })
      } finally {
        savingRef.current.delete(key)
      }
    },
    [day, guard, markSelfWrite, patchNoteDraft, rebindPick, setRowStatus, show, stillOnDay],
  )

  const commitNoteBody = useCallback(
    (key: string, value: string) => {
      const draft = noteDrafts.find((d) => d.key === key)
      if (draft) {
        if (draft.locked) return
        if (value.trim() === '') {
          patchNoteDraft(key, { body: value })
          return
        }
        void saveNoteDraft(draft, value)
        return
      }
      const note = notes.find((n) => `n${n.id}` === key)
      if (!note) return
      if (value.trim() === '') {
        setRowStatus(key, { tone: 'danger', text: `▲ ${ERR_EMPTY_BODY}` })
        return
      }
      if (value.trim() === note.body) return
      void updateNoteCell(note, { body: value.trim() }, { body: value.trim() })
    },
    [noteDrafts, notes, patchNoteDraft, saveNoteDraft, setRowStatus, updateNoteCell],
  )

  const deleteNoteRow = useCallback(
    (key: string) => {
      const draft = noteDrafts.find((d) => d.key === key)
      if (draft) {
        // 送信待ちに退避済みの行は消さない（消しても後から登録されて復活するため）
        if (draft.locked) {
          setRowStatus(key, { tone: 'warn', text: `▲ ${MSG_LOCKED_DELETE}` })
          return
        }
        setNoteDrafts((prev) => prev.filter((d) => d.key !== key))
        setRowStatus(key, null)
        // 書きかけを取り消した時は戻せるようにする（1タップで入力を失わせない）
        if (draft.body.trim() !== '') {
          show('入力中の行を取り消しました', () => setNoteDrafts((prev) => [...prev, draft]))
        }
        return
      }
      const note = notes.find((n) => `n${n.id}` === key)
      if (!note) return
      if (!guard(key)) return
      askConfirm({
        title: 'この行を削除しますか',
        body: '削除すると一覧から消えます（記録は復元できません）。よろしければ「削除する」を押してください。',
        confirmLabel: '削除する',
        onConfirm: () => {
          setConfirm(null)
          void (async () => {
            try {
              markSelfWrite() // 送る前に印を付ける（自分の書き込みで「他の端末で更新」を出さない）
              const res = await softDeleteNote(note.id, note.rev)
              if (res === 'conflict') {
                setRowStatus(key, { tone: 'danger', text: `▲ ${ERR_CONFLICT}` })
                return
              }
              setNotes((prev) => prev.filter((n) => n.id !== note.id))
              setExpanded(null)
              show('削除しました')
            } catch (err) {
              setRowStatus(key, { tone: 'danger', text: `▲ ${errText(err)}` })
            }
          })()
        },
      })
    },
    [askConfirm, guard, markSelfWrite, noteDrafts, notes, setRowStatus, show],
  )

  const markNoteRead = useCallback(
    (note: Note) => {
      const key = `n${note.id}`
      if (actorId == null) {
        setRowStatus(key, { tone: 'warn', text: `▲ ${ERR_NO_ACTOR}` })
        return
      }
      void (async () => {
        try {
          await markRead(note.id, actorId)
          touchActivity()
          patchNote(note.id, { my_read: true, read_count: (note.read_count ?? 0) + 1 })
          setRowStatus(key, { tone: 'ok', text: '✓ 既読にしました' })
        } catch (err) {
          setRowStatus(key, { tone: 'danger', text: `▲ ${errText(err)}` })
        }
      })()
    },
    [actorId, patchNote, setRowStatus],
  )

  // ── 発熱者・他症状者 ───────────────────────────────────────

  const addVitalDraft = useCallback(
    (kind: 'observation' | 'symptom') => {
      // 封鎖中と「確認できていない」で理由文を出し分ける（blockedReason）
      if (!enabled) {
        show(blockedReason)
        return
      }
      const key = nextKey('vd')
      setVitalDrafts((prev) => [
        ...prev,
        {
          key,
          kind,
          residentId: null,
          sets: kind === 'observation' ? [emptySet(), emptySet(), emptySet()] : [emptySet()],
          symptom: '',
          locked: false,
        },
      ])
    },
    [blockedReason, enabled, nextKey, show],
  )

  const patchVitalDraft = useCallback((key: string, patch: Partial<VitalDraft>) => {
    setVitalDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  }, [])

  /** 追加した空行の取り消し。書きかけがある行は Undo を出す */
  const removeVitalDraft = useCallback(
    (key: string) => {
      const draft = vitalDrafts.find((d) => d.key === key)
      // 送信待ちに退避済みの行は消さない（消しても後から登録されて復活するため）
      if (draft?.locked) {
        setRowStatus(key, { tone: 'warn', text: `▲ ${MSG_LOCKED_DELETE}` })
        return
      }
      setVitalDrafts((prev) => prev.filter((d) => d.key !== key))
      setRowStatus(key, null)
      if (!draft) return
      const dirty =
        draft.symptom.trim() !== '' ||
        draft.sets.some((s) => s.at || s.temp || s.spo2 || s.bp || s.pulse)
      if (dirty) show('入力中の行を取り消しました', () => setVitalDrafts((prev) => [...prev, draft]))
    },
    [setRowStatus, show, vitalDrafts],
  )

  const replaceVital = useCallback((v: Vital) => {
    const put = (prev: Vital[]) => {
      const i = prev.findIndex((x) => x.id === v.id)
      if (i < 0) return [...prev, v]
      const next = prev.slice()
      next[i] = v
      return next
    }
    if (v.kind === 'symptom') setSymptoms(put)
    else setObservations(put)
  }, [])

  /** 保存済みバイタルの1セル更新。空文字での消去は確認を挟む */
  const updateVitalCell = useCallback(
    (v: Vital, patch: Partial<Omit<Vital, 'id' | 'rev'>>, rowKey: string, clearing: boolean, label: string) => {
      if (!guard(rowKey)) return
      const run = () => {
        setRowStatus(rowKey, null)
        void (async () => {
          try {
            markSelfWrite() // 送る前に印を付ける（自分の書き込みで「他の端末で更新」を出さない）
            const res = await updateVital(v.id, v.rev, patch)
            if (res === 'conflict') {
              setRowStatus(rowKey, { tone: 'danger', text: `▲ ${ERR_CONFLICT}` })
              return
            }
            if (res === 'queued') {
              replaceVital({ ...v, ...patch })
              setRowStatus(rowKey, { tone: 'warn', text: MSG_QUEUED })
              return
            }
            replaceVital(res)
            setRowStatus(rowKey, { tone: 'ok', text: MSG_SAVED })
          } catch (err) {
            setRowStatus(rowKey, { tone: 'danger', text: `▲ ${errText(err)}` })
          }
        })()
      }
      if (clearing) {
        askConfirm({
          title: `${label}を消しますか`,
          body: '保存済みの値を空にします。よろしければ「消す」を押してください。',
          confirmLabel: '消す',
          onConfirm: () => {
            setConfirm(null)
            run()
          },
        })
        return
      }
      run()
    },
    [askConfirm, guard, markSelfWrite, replaceVital, setRowStatus],
  )

  /** 新しいバイタル行（発熱者・他症状者）を1件登録する */
  const insertVitalRow = useCallback(
    async (
      rowKey: string,
      residentId: number,
      kind: 'observation' | 'symptom',
      fields: Partial<Omit<Vital, 'id' | 'rev' | 'resident_id' | 'measured_on' | 'kind'>>,
      draftKey: string | null,
    ) => {
      if (!guard(rowKey)) return
      // 値が1つも無い行は作らない（空欄の確定＝null だけの patch で空行ができるのを防ぐ）
      if (!hasVitalValue(fields)) {
        setRowStatus(rowKey, { tone: 'warn', text: MSG_EMPTY_VITAL })
        return
      }
      // 応答待ちの行に重ねて確定が来た場合。保存済みの枠は入力欄に値が残らないので、
      // 黙って捨てずに「もう一度入力してほしい」ことを伝える
      if (savingRef.current.has(rowKey)) {
        setRowStatus(rowKey, { tone: 'warn', text: MSG_BUSY_VITAL })
        return
      }
      savingRef.current.add(rowKey)
      setRowStatus(rowKey, null)
      try {
        markSelfWrite() // 送る前に印を付ける（自分の書き込みで「他の端末で更新」を出さない）
        const res = await insertVitalKind({
          resident_id: residentId,
          measured_on: day,
          kind,
          measured_at: fields.measured_at ?? null,
          temp: fields.temp ?? null,
          sys_bp: fields.sys_bp ?? null,
          dia_bp: fields.dia_bp ?? null,
          pulse: fields.pulse ?? null,
          spo2: fields.spo2 ?? null,
          note: null,
          symptom: fields.symptom ?? null,
          recorded_by: actorId,
        })
        if (res === 'queued') {
          if (draftKey !== null) patchVitalDraft(draftKey, { locked: true })
          setRowStatus(rowKey, { tone: 'warn', text: isQueuePersisted() ? MSG_QUEUED : MSG_NOT_PERSISTED })
          return
        }
        if (draftKey !== null) setVitalDrafts((prev) => prev.filter((d) => d.key !== draftKey))
        if (!stillOnDay(day)) {
          // 応答を待つ間に日付を送られた。保存はできているので、今の画面には足さずに伝える
          show(MSG_SAVED_OTHER_DAY)
          return
        }
        // 下書き行はいま消したので、保存済み行が使うキーへ付け替える。
        // rowKey（＝下書きのキー）のままだと「✓ 保存しました」を描画する行がもう無く、
        // 新規の発熱者・他症状者だけ保存の結果が一切出ない（申し送り・外出は付け替え済み）。
        // 数え直す一覧は replaceVital の反映前＝この1件を足す前のものを使う
        const savedKey =
          draftKey === null
            ? rowKey
            : kind === 'symptom'
              ? `s${res.id}`
              : feverRowKey(res, observationsRef.current)
        replaceVital(res)
        setRowStatus(savedKey, { tone: 'ok', text: MSG_SAVED })
      } catch (err) {
        setRowStatus(rowKey, { tone: 'danger', text: `▲ ${errText(err)}` })
      } finally {
        savingRef.current.delete(rowKey)
      }
    },
    [actorId, day, guard, markSelfWrite, patchVitalDraft, replaceVital, setRowStatus, show, stillOnDay],
  )

  // ── 外出・外泊 ─────────────────────────────────────────────

  const addOutingDraft = useCallback(
    (kind: OutingKind) => {
      // 封鎖中と「確認できていない」で理由文を出し分ける（blockedReason）
      if (!enabled) {
        show(blockedReason)
        return
      }
      const key = nextKey('od')
      setOutingDrafts((prev) => [
        ...prev,
        { key, kind, residentId: null, place: '', startAt: '', endText: '', companion: '', locked: false },
      ])
    },
    [blockedReason, enabled, nextKey, show],
  )

  const patchOutingDraft = useCallback((key: string, patch: Partial<OutingDraft>) => {
    setOutingDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  }, [])

  /** 追加した空行の取り消し。書きかけがある行は Undo を出す */
  const removeOutingDraft = useCallback(
    (key: string) => {
      const draft = outingDrafts.find((d) => d.key === key)
      // 送信待ちに退避済みの行は消さない（消しても後から登録されて復活するため）
      if (draft?.locked) {
        setRowStatus(key, { tone: 'warn', text: `▲ ${MSG_LOCKED_DELETE}` })
        return
      }
      setOutingDrafts((prev) => prev.filter((d) => d.key !== key))
      setRowStatus(key, null)
      if (!draft) return
      const dirty =
        draft.place.trim() !== '' ||
        draft.startAt !== '' ||
        draft.endText !== '' ||
        draft.companion.trim() !== ''
      if (dirty) show('入力中の行を取り消しました', () => setOutingDrafts((prev) => [...prev, draft]))
    },
    [outingDrafts, setRowStatus, show],
  )

  /** 下書きの外出・外泊を登録する（対象＋いずれかの記入がそろった時点） */
  const saveOutingDraft = useCallback(
    async (draft: OutingDraft) => {
      const key = draft.key
      if (draft.residentId == null) return
      if (!guard(key)) return
      // 応答待ちの間に「登録」を押し直された場合（入力は下書きに残っている）
      if (savingRef.current.has(key)) {
        setRowStatus(key, { tone: 'warn', text: MSG_BUSY })
        return
      }
      const start = parseHM(draft.startAt)
      if (!start.ok) {
        setRowStatus(key, { tone: 'danger', text: start.message })
        return
      }
      const end = parseDayTime(draft.endText, day)
      if (!end.ok) {
        setRowStatus(key, { tone: 'danger', text: end.message })
        return
      }
      savingRef.current.add(key)
      setRowStatus(key, null)
      try {
        markSelfWrite() // 送る前に印を付ける（自分の書き込みで「他の端末で更新」を出さない）
        const res = await insertOuting({
          resident_id: draft.residentId,
          kind: draft.kind,
          start_on: day,
          start_at: start.value,
          end_on: end.on,
          end_at: end.at,
          companion: draft.companion.trim() === '' ? null : draft.companion.trim(),
          // 外出先・宿泊先は行き先の自由記述として note 列へ入れる
          note: draft.place.trim() === '' ? null : draft.place.trim(),
          recorded_by: actorId,
        })
        if (res === 'queued') {
          patchOutingDraft(key, { locked: true })
          setRowStatus(key, { tone: 'warn', text: isQueuePersisted() ? MSG_QUEUED : MSG_NOT_PERSISTED })
          return
        }
        setOutingDrafts((prev) => prev.filter((d) => d.key !== key))
        if (!stillOnDay(day)) {
          // 応答を待つ間に日付を送られた。保存はできているので、今の画面には足さずに伝える
          show(MSG_SAVED_OTHER_DAY)
          return
        }
        // 同じ id が既に入っていれば入れ替える（再読込と行き違っても行が2つにならない）
        setOutings((prev) => [...prev.filter((o) => o.id !== res.id), res])
        setRowStatus(`o${res.id}`, { tone: 'ok', text: MSG_SAVED })
      } catch (err) {
        setRowStatus(key, { tone: 'danger', text: `▲ ${errText(err)}` })
      } finally {
        savingRef.current.delete(key)
      }
    },
    [actorId, day, guard, markSelfWrite, patchOutingDraft, setRowStatus, show, stillOnDay],
  )

  /** 帰着（到着日時）の後追い記入。end_on / end_at だけを送る */
  const commitOutingEnd = useCallback(
    (o: Outing, raw: string) => {
      const key = `o${o.id}`
      if (!guard(key)) return
      const parsed = parseDayTime(raw, day)
      if (!parsed.ok) {
        setRowStatus(key, { tone: 'danger', text: parsed.message })
        return
      }
      if (parsed.on === null) {
        setRowStatus(key, {
          tone: 'danger',
          text: '▲ 到着は空にできません。「10:30」または「8/30 10:30」のように入力してください',
        })
        return
      }
      const endOn = parsed.on
      const endAt = parsed.at
      setRowStatus(key, null)
      void (async () => {
        try {
          markSelfWrite() // 送る前に印を付ける（自分の書き込みで「他の端末で更新」を出さない）
          const res = await setOutingEnd(o.id, o.rev, endOn, endAt)
          if (res === 'conflict') {
            setRowStatus(key, { tone: 'danger', text: `▲ ${ERR_CONFLICT}` })
            return
          }
          setOutings((prev) => prev.map((x) => (x.id === o.id ? res : x)))
          setRowStatus(key, { tone: 'ok', text: MSG_SAVED })
        } catch (err) {
          setRowStatus(key, { tone: 'danger', text: `▲ ${errText(err)}` })
        }
      })()
    },
    [day, guard, markSelfWrite, setRowStatus],
  )

  // ── ピッカーの結果を配る ───────────────────────────────────

  const onPickResident = useCallback(
    (id: number | null) => {
      const target = residentPick
      setResidentPick(null)
      if (!target) return
      if (target.for === 'noteTarget') {
        const draft = noteDrafts.find((d) => d.key === target.key)
        if (draft) {
          patchNoteDraft(target.key, { residentId: id, targetPicked: true })
          return
        }
        const note = notes.find((n) => `n${n.id}` === target.key)
        if (note) void updateNoteCell(note, { resident_id: id }, { resident_id: id })
        // 行き先が見つからない（開いている間に行が保存・削除された）。黙って捨てない
        else show(MSG_PICK_LOST)
        return
      }
      if (id == null) return // 以下のブロックは「全体」を持たない
      if (target.for === 'vitalTarget') {
        patchVitalDraft(target.key, { residentId: id })
        return
      }
      if (target.for === 'outingTarget') {
        // 登録は行末の「登録」を押した時だけ（途中の記入を取りこぼさない）
        patchOutingDraft(target.key, { residentId: id })
      }
    },
    [
      noteDrafts,
      notes,
      patchNoteDraft,
      patchOutingDraft,
      patchVitalDraft,
      residentPick,
      show,
      updateNoteCell,
    ],
  )

  const onPickStaff = useCallback(
    (id: number) => {
      const target = staffPick
      setStaffPick(null)
      if (!target) return
      if (target.for === 'attendance') {
        addAttendance(id, target.role)
        return
      }
      if (target.for === 'noteReporter') {
        const draft = noteDrafts.find((d) => d.key === target.key)
        if (draft) {
          patchNoteDraft(target.key, { reporterId: id })
          return
        }
        const note = notes.find((n) => `n${n.id}` === target.key)
        if (note) void updateNoteCell(note, { reporter_id: id }, { reporter_id: id })
        // 行き先が見つからない（開いている間に行が保存・削除された）。黙って捨てない
        else show(MSG_PICK_LOST)
      }
    },
    [addAttendance, noteDrafts, notes, patchNoteDraft, show, staffPick, updateNoteCell],
  )

  // ── 表示用の仕分け ─────────────────────────────────────────

  const dayNotes = useMemo(() => notes.filter((n) => n.shift === 'day' && !n.after16), [notes])
  const lateNotes = useMemo(() => notes.filter((n) => n.shift === 'day' && n.after16), [notes])
  const careNotes = useMemo(() => notes.filter((n) => n.shift === 'daycare'), [notes])
  const nightNotes = useMemo(() => notes.filter((n) => n.shift === 'night'), [notes])

  const feverRows = useMemo(
    () => buildFeverRows(observations, residentOrder),
    [observations, residentOrder],
  )
  const symptomRows = useMemo(
    () =>
      symptoms
        .slice()
        .sort(
          (a, b) =>
            (residentOrder.get(a.resident_id) ?? Number.MAX_SAFE_INTEGER) -
              (residentOrder.get(b.resident_id) ?? Number.MAX_SAFE_INTEGER) || a.id - b.id,
        ),
    [symptoms, residentOrder],
  )
  const outRows = useMemo(() => outings.filter((o) => o.kind === 'outing'), [outings])
  const stayRows = useMemo(() => outings.filter((o) => o.kind === 'overnight'), [outings])

  const manager = attendance.find((a) => a.role === 'manager') ?? null
  const workers = attendance.filter((a) => a.role !== 'manager')

  const totalRows =
    notes.length +
    observations.length +
    symptoms.length +
    outings.length +
    attendance.length +
    noteDrafts.length +
    vitalDrafts.length +
    outingDrafts.length

  const ctx: SheetCtx = {
    day,
    residentById,
    staffById,
    disabled: !enabled,
    status,
    setStatus: setRowStatus,
    openResident: setResidentPick,
    openStaff: setStaffPick,
  }

  // ── 3状態 ─────────────────────────────────────────────────

  if (phase === 'loading') {
    return <LoadingBlock label="日報を読み込んでいます…" />
  }

  if (phase === 'error') {
    return (
      <ErrorBlock message={ERR_LOAD} onRetry={() => setReload((n) => n + 1)} />
    )
  }

  return (
    <div className="space-y-4">
      {/* 日付バー（前後日・当月の日・表示倍率） */}
      <DateBar day={day} onGo={goDay} />

      {gateUnknown && (
        <p className="rounded-md border border-info bg-info-bg p-3 text-base text-ink">
          <span aria-hidden="true">ⓘ </span>
          {/* 行に出す一言（blockedReason）と同じ文言を1か所から出す＝画面内で理由が食い違わない */}
          {GATE_UNKNOWN_REASON}
        </p>
      )}
      {!enabled && !gateUnknown && (
        <p className="rounded-md border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {BLOCKED_REASON}
        </p>
      )}
      {stale && (
        <div className="flex flex-wrap items-center gap-gap rounded-md border border-info bg-info-bg p-3">
          <p className="flex-1 text-base text-ink">
            <span aria-hidden="true">ⓘ </span>
            他の端末で記録が更新されました。最新の内容に切り替えられます（入力中の行は保存してから押してください）。
          </p>
          <button
            type="button"
            onClick={() => setReload((n) => n + 1)}
            className="min-h-tap rounded-md border border-primary bg-surface px-4 text-base font-bold text-primary"
          >
            最新に更新
          </button>
        </div>
      )}

      <SheetFrame>
        {/* 器の幅は「画面幅」か「固定列の合計（SHEET_MIN_W）」の広い方で決める。
            w-max（＝width: max-content）にすると器の幅が中身の最大コンテンツ幅になり、
            申し送りの長文1件でシート全体が横に伸びて本文が1行のまま折り返さなくなる
            （sheet-contracts.md §5「長文は行が伸びる（clamp しない）」が成立しない）。
            狭い画面では固定列の合計まで SheetFrame 側が横スクロールする。
            sheet-dense＝「行が縦に連続する場所」の印。sheet.css がこの中の
            当たり判定の拡張量（--sheet-hit-pad）を 0 にする＝隣接行の誤タップを防ぐ */}
        <div className="sheet-dense" style={{ minWidth: SHEET_MIN_W }}>
          <SheetHeader facility={facility} day={day} />

          <AttendanceBlock
            ctx={ctx}
            manager={manager}
            workers={workers}
            onAdd={(role) => {
              if (!enabled) {
                setRowStatus('attendance', { tone: 'warn', text: `▲ ${blockedReason}` })
                return
              }
              setStaffPick({ for: 'attendance', role })
            }}
            onRemove={(staffId) => {
              if (!enabled) {
                setRowStatus('attendance', { tone: 'warn', text: `▲ ${blockedReason}` })
                return
              }
              removeAttendance(staffId)
            }}
          />

          <OutingBlock
            ctx={ctx}
            kind="outing"
            rows={outRows}
            drafts={outingDrafts.filter((d) => d.kind === 'outing')}
            onAdd={() => addOutingDraft('outing')}
            onPatchDraft={patchOutingDraft}
            onRemoveDraft={removeOutingDraft}
            onSaveDraft={saveOutingDraft}
            onCommitEnd={commitOutingEnd}
          />

          <OutingBlock
            ctx={ctx}
            kind="overnight"
            rows={stayRows}
            drafts={outingDrafts.filter((d) => d.kind === 'overnight')}
            onAdd={() => addOutingDraft('overnight')}
            onPatchDraft={patchOutingDraft}
            onRemoveDraft={removeOutingDraft}
            onSaveDraft={saveOutingDraft}
            onCommitEnd={commitOutingEnd}
          />

          <FeverBlock
            ctx={ctx}
            rows={feverRows}
            drafts={vitalDrafts.filter((d) => d.kind === 'observation')}
            onAdd={() => addVitalDraft('observation')}
            onPatchDraft={patchVitalDraft}
            onRemoveDraft={removeVitalDraft}
            onInsert={insertVitalRow}
            onUpdate={updateVitalCell}
          />

          <SymptomBlock
            ctx={ctx}
            rows={symptomRows}
            drafts={vitalDrafts.filter((d) => d.kind === 'symptom')}
            onAdd={() => addVitalDraft('symptom')}
            onPatchDraft={patchVitalDraft}
            onRemoveDraft={removeVitalDraft}
            onInsert={insertVitalRow}
            onUpdate={updateVitalCell}
          />

          <NoteBlock
            ctx={ctx}
            title="日勤申し送り"
            rows={dayNotes}
            drafts={noteDrafts.filter((d) => d.shift === 'day' && !d.after16)}
            showReporter
            actorId={actorId}
            expanded={expanded}
            onToggleExpand={(k) => setExpanded((cur) => (cur === k ? null : k))}
            onAdd={() => addNoteDraft('day', false)}
            onCommitBody={commitNoteBody}
            onPatchDraft={patchNoteDraft}
            onUpdateNote={updateNoteCell}
            onDelete={deleteNoteRow}
            onMarkRead={markNoteRead}
          />

          {/* 現行スプシの黒帯。ここから下は after16=true の記録 */}
          <div
            className="flex items-center bg-ink px-2 font-bold text-bg"
            style={{ minHeight: 'var(--sheet-row-h-note)' }}
          >
            ↓16時以降の記録
          </div>

          <NoteBlock
            ctx={ctx}
            title="日勤申し送り（16時以降）"
            rows={lateNotes}
            drafts={noteDrafts.filter((d) => d.shift === 'day' && d.after16)}
            showReporter
            actorId={actorId}
            expanded={expanded}
            onToggleExpand={(k) => setExpanded((cur) => (cur === k ? null : k))}
            onAdd={() => addNoteDraft('day', true)}
            onCommitBody={commitNoteBody}
            onPatchDraft={patchNoteDraft}
            onUpdateNote={updateNoteCell}
            onDelete={deleteNoteRow}
            onMarkRead={markNoteRead}
          />

          <NoteBlock
            ctx={ctx}
            title="デイサービス"
            rows={careNotes}
            drafts={noteDrafts.filter((d) => d.shift === 'daycare')}
            showReporter
            actorId={actorId}
            expanded={expanded}
            onToggleExpand={(k) => setExpanded((cur) => (cur === k ? null : k))}
            onAdd={() => addNoteDraft('daycare', false)}
            onCommitBody={commitNoteBody}
            onPatchDraft={patchNoteDraft}
            onUpdateNote={updateNoteCell}
            onDelete={deleteNoteRow}
            onMarkRead={markNoteRead}
          />

          <NoteBlock
            ctx={ctx}
            title="夜勤申し送り"
            rows={nightNotes}
            drafts={noteDrafts.filter((d) => d.shift === 'night')}
            showReporter={false}
            actorId={actorId}
            expanded={expanded}
            onToggleExpand={(k) => setExpanded((cur) => (cur === k ? null : k))}
            onAdd={() => addNoteDraft('night', false)}
            onCommitBody={commitNoteBody}
            onPatchDraft={patchNoteDraft}
            onUpdateNote={updateNoteCell}
            onDelete={deleteNoteRow}
            onMarkRead={markNoteRead}
          />
        </div>
      </SheetFrame>

      {totalRows === 0 && (
        <EmptyBlock
          message="この日の記録はまだありません。各ブロックの「＋追加」から記入できます。"
          actionLabel={enabled ? '日勤申し送りに1行追加' : undefined}
          onAction={enabled ? () => addNoteDraft('day', false) : undefined}
        />
      )}

      <ResidentPickerModal
        open={residentPick !== null}
        residents={residents}
        onPick={onPickResident}
        onClose={() => setResidentPick(null)}
        allowAll={residentPick?.for === 'noteTarget'}
      />
      <StaffPickerModal
        open={staffPick !== null}
        staff={staff}
        onPick={onPickStaff}
        onClose={() => setStaffPick(null)}
        title={staffPick?.for === 'attendance' ? '出勤者を選ぶ' : '記入者を選ぶ'}
      />
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        body={confirm?.body}
        confirmLabel={confirm?.confirmLabel}
        danger
        onConfirm={() => confirm?.onConfirm()}
        onCancel={() => setConfirm(null)}
      />
      {toast}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// ブロック共通の受け渡し
// ══════════════════════════════════════════════════════════════

interface SheetCtx {
  day: string
  residentById: Map<number, Resident>
  staffById: Map<number, Staff>
  /** 入力封鎖中・観測できていない間は true（セルを読み取り専用にする） */
  disabled: boolean
  status: Record<string, RowStatus>
  setStatus: (key: string, s: RowStatus | null) => void
  openResident: (t: PickTarget) => void
  openStaff: (t: PickTarget) => void
}

// ══════════════════════════════════════════════════════════════
// 日付バー
// ══════════════════════════════════════════════════════════════

function DateBar({ day, onGo }: { day: string; onGo: (iso: string) => void }) {
  const days = useMemo(() => monthDays(day), [day])
  const today = todayIso()
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-gap">
        <button
          type="button"
          onClick={() => onGo(addDays(day, -1))}
          aria-label="前の日を見る"
          className="min-h-tap min-w-tap rounded-md border border-border-strong px-3 text-base text-ink"
        >
          <span aria-hidden="true">‹</span>
        </button>
        <span className="text-lg font-bold tabular">{fmtDayLabel(day)}</span>
        <button
          type="button"
          onClick={() => onGo(addDays(day, 1))}
          aria-label="次の日を見る"
          className="min-h-tap min-w-tap rounded-md border border-border-strong px-3 text-base text-ink"
        >
          <span aria-hidden="true">›</span>
        </button>
        {day !== today && (
          <button
            type="button"
            onClick={() => onGo(today)}
            className="min-h-tap rounded-md border border-primary px-3 text-base font-bold text-primary"
          >
            今日へ
          </button>
        )}
        <div className="ml-auto">
          <ZoomBar />
        </div>
      </div>
      {/* 現行スプシ左端の日付リンクの再現。当月の日を横に並べる */}
      <div className="overflow-x-auto">
        <ul className="flex gap-gap" aria-label="この月の日付">
          {days.map((iso) => {
            const selected = iso === day
            return (
              <li key={iso}>
                <button
                  type="button"
                  onClick={() => onGo(iso)}
                  aria-current={selected ? 'date' : undefined}
                  aria-label={`${fmtDayLabel(iso)}の日報を見る`}
                  className={`min-h-tap min-w-tap rounded-md border px-2 text-base tabular ${
                    selected
                      ? 'border-primary bg-primary font-bold text-primary-ink underline'
                      : 'border-border bg-surface text-ink'
                  }`}
                >
                  {Number(iso.slice(8, 10))}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// ヘッダ（施設名・日報タイトル・日付）
// ══════════════════════════════════════════════════════════════

function SheetHeader({ facility, day }: { facility: string | null; day: string }) {
  return (
    <div className="border-b border-border-strong bg-surface2 px-2 py-2 text-center">
      {facility && <p className="text-ink2">{facility}</p>}
      <h2 className="text-lg font-heavy text-ink">日勤・夜勤日報</h2>
      <p className="text-xl font-bold text-ink tabular">{fmtDayLabel(day)}</p>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 出勤者
// ══════════════════════════════════════════════════════════════

function AttendanceBlock({
  ctx,
  manager,
  workers,
  onAdd,
  onRemove,
}: {
  ctx: SheetCtx
  manager: Attendance | null
  workers: Attendance[]
  onAdd: (role: 'manager' | 'staff') => void
  onRemove: (staffId: number) => void
}) {
  const status = ctx.status.attendance
  return (
    <div className="border-b border-border-strong px-2 py-2">
      <div className="flex flex-wrap items-center gap-gap">
        <span className="font-bold text-ink2">施設長</span>
        {manager ? (
          <Chip tone="plain">
            <span>{staffName(ctx.staffById.get(manager.staff_id), manager.staff_id)}</span>
            <button
              type="button"
              onClick={() => onRemove(manager.staff_id)}
              disabled={ctx.disabled}
              aria-label={`施設長 ${staffName(ctx.staffById.get(manager.staff_id), manager.staff_id)} を取り消す`}
              className="min-h-tap min-w-tap text-ink2"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </Chip>
        ) : (
          <button
            type="button"
            onClick={() => onAdd('manager')}
            disabled={ctx.disabled}
            className="min-h-tap rounded-md border border-border-strong px-3 text-base text-link disabled:text-ink3"
          >
            ＋ 選ぶ
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-gap">
        <span className="font-bold text-ink2">出勤者</span>
        {workers.map((a) => (
          <Chip key={a.staff_id} tone="plain">
            <span>{staffName(ctx.staffById.get(a.staff_id), a.staff_id)}</span>
            <button
              type="button"
              onClick={() => onRemove(a.staff_id)}
              disabled={ctx.disabled}
              aria-label={`出勤者 ${staffName(ctx.staffById.get(a.staff_id), a.staff_id)} を取り消す`}
              className="min-h-tap min-w-tap text-ink2"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </Chip>
        ))}
        <button
          type="button"
          onClick={() => onAdd('staff')}
          disabled={ctx.disabled}
          className="min-h-tap rounded-md border border-border-strong px-3 text-base text-link disabled:text-ink3"
        >
          ＋ 追加
        </button>
      </div>
      <StatusText status={status} />
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 外出者・外泊者
// ══════════════════════════════════════════════════════════════

function OutingBlock({
  ctx,
  kind,
  rows,
  drafts,
  onAdd,
  onPatchDraft,
  onRemoveDraft,
  onSaveDraft,
  onCommitEnd,
}: {
  ctx: SheetCtx
  kind: OutingKind
  rows: Outing[]
  drafts: OutingDraft[]
  onAdd: () => void
  onPatchDraft: (key: string, patch: Partial<OutingDraft>) => void
  /** 追加した行の取り消し（未保存の行のみ） */
  onRemoveDraft: (key: string) => void
  onSaveDraft: (draft: OutingDraft) => Promise<void>
  onCommitEnd: (o: Outing, raw: string) => void
}) {
  const isStay = kind === 'overnight'
  const title = isStay ? '外泊者' : '外出者'
  const placeLabel = isStay ? '宿泊先' : '外出先'
  const startLabel = isStay ? '出発日時' : '出発時刻'
  const endLabel = isStay ? '到着日時' : '到着時刻'
  const count = rows.length + drafts.length

  // key は付けない。件数で key を変えるとブロックごと作り直され、押した「＋追加」ボタンが
  // DOM から消えてフォーカスが文書先頭へ落ちる（0→1・1→0 の両方）。
  // 0→1 で開く挙動は CollapsibleBlock 側の useEffect（sheet.tsx）が既に担っている
  return (
    <CollapsibleBlock
      title={title}
      count={count}
      onAdd={onAdd}
      addLabel="＋追加"
      defaultOpen={count > 0}
    >
      <HeadRow>
        <HeadCell width="var(--w-name)">氏名</HeadCell>
        <HeadCell grow>{placeLabel}</HeadCell>
        <HeadCell width="var(--w-datelink)">{startLabel}</HeadCell>
        <HeadCell width="var(--w-datelink)">{endLabel}</HeadCell>
        <HeadCell width="var(--w-target)">付添</HeadCell>
        <HeadCell width="var(--w-reporter)">登録</HeadCell>
      </HeadRow>

      {rows.map((o) => {
        const key = `o${o.id}`
        const name = residentName(ctx.residentById.get(o.resident_id), o.resident_id)
        return (
          <div key={key}>
            <Row>
              <Cell width="var(--w-name)" className="flex items-center">
                <span className="truncate font-bold">{name}</span>
              </Cell>
              <Cell grow className="flex items-center">
                <span className="truncate">{o.note ?? ''}</span>
              </Cell>
              <Cell width="var(--w-datelink)" className="flex items-center">
                <span className="tabular">
                  {o.start_on !== ctx.day
                    ? fmtDayTime(o.start_on, o.start_at, ctx.day)
                    : fmtTimeHM(o.start_at)}
                </span>
              </Cell>
              {/* 余白は SheetCell 側だけが持つ（入れ物にも取ると列見出しと左端がずれる） */}
              <Cell width="var(--w-datelink)" pad={false}>
                <SheetCell
                  value={fmtDayTime(o.end_on, o.end_at, ctx.day)}
                  onCommit={ctx.disabled ? undefined : (v) => onCommitEnd(o, v)}
                  width="100%"
                  align="left"
                  placeholder={isStay ? '例 8/30 10:30' : '例 10:30'}
                  ariaLabel={`${name} の${endLabel}`}
                  as="div"
                />
              </Cell>
              <Cell width="var(--w-target)" className="flex items-center">
                <span className="truncate">{o.companion ?? ''}</span>
              </Cell>
              <Cell width="var(--w-reporter)" className="flex items-center">
                <span className="text-ok">
                  <span aria-hidden="true">✓ </span>登録済
                </span>
              </Cell>
            </Row>
            {o.end_on == null && (
              <p className="px-2 text-warn">
                <span aria-hidden="true">▲ </span>帰着未定（{endLabel}を記入すると確定します）
              </p>
            )}
            <StatusText status={ctx.status[key]} />
          </div>
        )
      })}

      {drafts.map((d) => {
        const name = d.residentId == null ? '' : residentName(ctx.residentById.get(d.residentId), d.residentId)
        const disabled = ctx.disabled || d.locked
        // 記入は下書きに貯め、行末の「登録」で1件として保存する
        // （外出・外泊は保存後の項目更新APIが無いため、途中保存にすると直せなくなる）
        const trySave = (patch: Partial<OutingDraft>) => onPatchDraft(d.key, patch)
        const ready =
          d.residentId != null &&
          (d.place.trim() !== '' || d.startAt !== '' || d.endText !== '' || d.companion.trim() !== '')
        return (
          <div key={d.key}>
            <Row className="bg-surface2">
              <PickerCell
                width="var(--w-name)"
                text={name}
                label={name === '' ? '対象の利用者を選ぶ' : `対象 ${name}。押すと選び直します`}
                disabled={disabled}
                onClick={() => ctx.openResident({ for: 'outingTarget', key: d.key })}
              />
              <Cell grow pad={false}>
                <SheetCell
                  value={d.place}
                  onCommit={disabled ? undefined : (v) => trySave({ place: v })}
                  width="100%"
                  align="left"
                  placeholder={placeLabel}
                  ariaLabel={placeLabel}
                  as="div"
                />
              </Cell>
              <Cell width="var(--w-datelink)" pad={false}>
                <SheetCell
                  value={d.startAt}
                  onCommit={disabled ? undefined : (v) => trySave({ startAt: v })}
                  width="100%"
                  align="left"
                  placeholder="例 10:30"
                  ariaLabel={startLabel}
                  as="div"
                />
              </Cell>
              <Cell width="var(--w-datelink)" pad={false}>
                <SheetCell
                  value={d.endText}
                  onCommit={disabled ? undefined : (v) => trySave({ endText: v })}
                  width="100%"
                  align="left"
                  placeholder={isStay ? '例 8/30 10:30' : '例 10:30'}
                  ariaLabel={endLabel}
                  as="div"
                />
              </Cell>
              <Cell width="var(--w-target)" pad={false}>
                <SheetCell
                  value={d.companion}
                  onCommit={disabled ? undefined : (v) => trySave({ companion: v })}
                  width="100%"
                  align="left"
                  placeholder="付添"
                  ariaLabel="付添"
                  as="div"
                />
              </Cell>
              {/* 余白はボタン（px-1）だけが持つ */}
              <Cell width="var(--w-reporter)" pad={false} className="flex items-center">
                <button
                  type="button"
                  onClick={() => void onSaveDraft(d)}
                  disabled={disabled || !ready}
                  aria-label={`この${title}の行を登録する`}
                  style={ROW_BTN_STYLE}
                  className={`${CELL_HIT} w-full rounded-sm px-1 font-bold ${
                    disabled || !ready ? 'text-ink3' : 'text-link'
                  }`}
                >
                  登録
                </button>
              </Cell>
            </Row>
            <p className="flex flex-wrap items-center gap-gap px-2 text-ink2">
              {d.locked ? (
                <span className="flex-1 text-warn">
                  <span aria-hidden="true">▲ </span>
                  {MSG_LOCKED_DELETE}
                </span>
              ) : !ready ? (
                <span className="flex-1">
                  <span aria-hidden="true">ⓘ </span>
                  氏名と、行き先・時刻・付添のいずれかを記入すると「登録」を押せます（押すまで保存しません）
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => onRemoveDraft(d.key)}
                disabled={d.locked}
                className="min-h-tap rounded-md border border-border-strong px-3 text-link disabled:border-border disabled:text-ink3"
              >
                この行を取り消す
              </button>
            </p>
            <StatusText status={ctx.status[d.key]} />
          </div>
        )
      })}

      {count === 0 && (
        <p className="px-2 py-1 text-ink2">
          <span aria-hidden="true">— </span>この日の{title}はいません
        </p>
      )}
    </CollapsibleBlock>
  )
}

// ══════════════════════════════════════════════════════════════
// 発熱者（時 KT SpO2 BP P × 3セット）
// ══════════════════════════════════════════════════════════════

type InsertVitalFn = (
  rowKey: string,
  residentId: number,
  kind: 'observation' | 'symptom',
  fields: Partial<Omit<Vital, 'id' | 'rev' | 'resident_id' | 'measured_on' | 'kind'>>,
  draftKey: string | null,
) => Promise<void>

type UpdateVitalFn = (
  v: Vital,
  patch: Partial<Omit<Vital, 'id' | 'rev'>>,
  rowKey: string,
  clearing: boolean,
  label: string,
) => void

/** 1枠（時 KT SpO2 BP P）の描画。保存済みなら update、空き枠なら insert を呼ぶ */
function VitalSetCells({
  name,
  vital,
  input,
  disabled,
  onInput,
  onCommit,
  onError,
}: {
  name: string
  vital: Vital | null
  input: VitalSetInput | null
  disabled: boolean
  onInput?: (patch: Partial<VitalSetInput>) => void
  onCommit: (patch: Partial<Omit<Vital, 'id' | 'rev'>>, clearing: boolean, label: string) => void
  /** 入力の書式・範囲エラー（保存はしない） */
  onError: (message: string) => void
}) {
  const val = (f: keyof VitalSetInput): string => {
    if (input) return input[f]
    if (!vital) return ''
    if (f === 'at') return fmtTimeHM(vital.measured_at)
    if (f === 'temp') return vital.temp == null ? '' : vital.temp.toFixed(1)
    if (f === 'spo2') return vital.spo2 == null ? '' : String(vital.spo2)
    if (f === 'pulse') return vital.pulse == null ? '' : String(vital.pulse)
    return fmtBp(vital.sys_bp, vital.dia_bp)
  }

  const commit = (f: keyof VitalSetInput, raw: string) => {
    if (onInput) onInput({ [f]: raw } as Partial<VitalSetInput>)
    if (f === 'at') {
      const t = parseHM(raw)
      if (!t.ok) return onError(t.message)
      return onCommit({ measured_at: t.value }, t.value === null, '時刻')
    }
    if (f === 'bp') {
      const bp = parseBp(raw)
      if (!bp.ok) return onError(bp.message)
      // 「125」のように片側だけ入れると、もう片側は null＝消去になる。
      // 保存済みの値を消す側があれば確認を出す（空上書き保護。両方空の時だけでは足りない）
      const cleared: string[] = []
      if (bp.sys === null && vital?.sys_bp != null) cleared.push(VITAL_FIELD_LABEL.sys_bp)
      if (bp.dia === null && vital?.dia_bp != null) cleared.push(VITAL_FIELD_LABEL.dia_bp)
      return onCommit(
        { sys_bp: bp.sys, dia_bp: bp.dia },
        cleared.length > 0,
        cleared.length > 0 ? cleared.join('・') : VITAL_FIELD_LABEL.sys_bp,
      )
    }
    const field = f === 'temp' ? 'temp' : f === 'spo2' ? 'spo2' : 'pulse'
    const res = parseNum(raw, field)
    if (!res.ok) return onError(res.message)
    return onCommit({ [field]: res.value } as Partial<Vital>, res.value === null, VITAL_FIELD_LABEL[field])
  }

  const cell = (
    f: keyof VitalSetInput,
    width: string,
    label: string,
    level: Level,
  ) => (
    // 左右余白は SheetCell の中のボタンが持つ（ここで重ねると記号が入る幅が無くなる）
    <Cell width={width} pad={false}>
      <SheetCell
        value={val(f)}
        onCommit={disabled ? undefined : (v) => commit(f, v)}
        width="100%"
        align="right"
        level={level}
        ariaLabel={`${name} ${label}`}
        as="div"
      />
    </Cell>
  )

  return (
    <>
      {cell('at', 'var(--w-pulse)', '時刻', null)}
      {cell('temp', 'var(--w-temp)', VITAL_FIELD_LABEL.temp, vital ? tempLevel(vital.temp) : null)}
      {cell('spo2', 'var(--w-spo2)', VITAL_FIELD_LABEL.spo2, vital ? spo2Level(vital.spo2) : null)}
      {cell('bp', W_BP, '血圧', vital ? bpLevel(vital.sys_bp, vital.dia_bp) : null)}
      {cell('pulse', 'var(--w-pulse)', VITAL_FIELD_LABEL.pulse, vital ? pulseLevel(vital.pulse) : null)}
    </>
  )
}

function FeverBlock({
  ctx,
  rows,
  drafts,
  onAdd,
  onPatchDraft,
  onRemoveDraft,
  onInsert,
  onUpdate,
}: {
  ctx: SheetCtx
  rows: FeverRow[]
  drafts: VitalDraft[]
  onAdd: () => void
  onPatchDraft: (key: string, patch: Partial<VitalDraft>) => void
  /** 追加した行の取り消し（未保存の行のみ） */
  onRemoveDraft: (key: string) => void
  onInsert: InsertVitalFn
  onUpdate: UpdateVitalFn
}) {
  const count = rows.length + drafts.length
  return (
    // key は付けない（理由は OutingBlock と同じ＝再マウントでフォーカスを失わせない）
    <CollapsibleBlock
      title="発熱者"
      count={count}
      onAdd={onAdd}
      addLabel="＋追加"
      defaultOpen={count > 0}
    >
      <HeadRow>
        <HeadCell width="var(--w-name)">氏名</HeadCell>
        {Array.from({ length: FEVER_SETS }, (_, i) => (
          <Fragment key={i}>
            <HeadCell width="var(--w-pulse)">{`${i + 1}回目 時`}</HeadCell>
            <HeadCell width="var(--w-temp)">体温</HeadCell>
            <HeadCell width="var(--w-spo2)">SpO2</HeadCell>
            <HeadCell width={W_BP}>血圧</HeadCell>
            <HeadCell width="var(--w-pulse)">脈</HeadCell>
          </Fragment>
        ))}
      </HeadRow>

      {rows.map((row) => {
        const name = residentName(ctx.residentById.get(row.residentId), row.residentId)
        return (
          <div key={row.key}>
            <Row>
              <Cell width="var(--w-name)" className="flex items-center">
                <span className="truncate font-bold">{name}</span>
              </Cell>
              {row.slots.map((v, i) => (
                <VitalSetCells
                  key={i}
                  name={`${name} ${i + 1}回目`}
                  vital={v}
                  input={null}
                  disabled={ctx.disabled}
                  onError={(m) => ctx.setStatus(row.key, { tone: 'danger', text: m })}
                  onCommit={(patch, clearing, label) => {
                    if (v) onUpdate(v, patch, row.key, clearing, label)
                    // 空き枠は「値が入った時」だけ行を作る（空欄の確定で空行を作らない）
                    else if (hasVitalValue(patch))
                      void onInsert(row.key, row.residentId, 'observation', patch, null)
                  }}
                />
              ))}
            </Row>
            <StatusText status={ctx.status[row.key]} />
          </div>
        )
      })}

      {drafts.map((d) => {
        const name = d.residentId == null ? '' : residentName(ctx.residentById.get(d.residentId), d.residentId)
        const disabled = ctx.disabled || d.locked
        return (
          <div key={d.key}>
            <Row className="bg-surface2">
              <PickerCell
                width="var(--w-name)"
                text={name}
                label={name === '' ? '対象の利用者を選ぶ' : `対象 ${name}。押すと選び直します`}
                disabled={disabled}
                onClick={() => ctx.openResident({ for: 'vitalTarget', key: d.key })}
              />
              {d.sets.map((s, i) => (
                <VitalSetCells
                  key={i}
                  name={`${name === '' ? '未選択' : name} ${i + 1}回目`}
                  vital={null}
                  input={s}
                  // 2回目以降は1回目を保存してから記入する（保存前に消えてしまう入力を作らない）
                  disabled={disabled || i > 0}
                  onError={(m) => ctx.setStatus(d.key, { tone: 'danger', text: m })}
                  onInput={(patch) =>
                    onPatchDraft(d.key, {
                      sets: d.sets.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                    })
                  }
                  onCommit={(patch) => {
                    if (d.residentId == null) return
                    // 同じ枠に先に入れてある値も一緒に送る（1セルずつ消えないように）
                    const merged = { ...setToPatch(s), ...patch }
                    // 値が1つも無ければ保存しない（空欄の確定で空行を作らない）
                    if (!hasVitalValue(merged)) return
                    void onInsert(d.key, d.residentId, 'observation', merged, d.key)
                  }}
                />
              ))}
            </Row>
            <p className="flex flex-wrap items-center gap-gap px-2 text-ink2">
              {d.locked ? (
                <span className="flex-1 text-warn">
                  <span aria-hidden="true">▲ </span>
                  {MSG_LOCKED_DELETE}
                </span>
              ) : (
                <span className="flex-1">
                  <span aria-hidden="true">ⓘ </span>
                  {d.residentId == null
                    ? '氏名を選び、1回目の値を入れると保存します'
                    : '1回目の値を入れると保存します（2回目以降は保存後に記入できます）'}
                </span>
              )}
              <button
                type="button"
                onClick={() => onRemoveDraft(d.key)}
                disabled={d.locked}
                className="min-h-tap rounded-md border border-border-strong px-3 text-link disabled:border-border disabled:text-ink3"
              >
                この行を取り消す
              </button>
            </p>
            <StatusText status={ctx.status[d.key]} />
          </div>
        )
      })}

      {count === 0 && (
        <p className="px-2 py-1 text-ink2">
          <span aria-hidden="true">— </span>この日の発熱者はいません
        </p>
      )}
    </CollapsibleBlock>
  )
}

// ══════════════════════════════════════════════════════════════
// 他症状者（時 KT SpO2 BP P ＋ 症状）
// ══════════════════════════════════════════════════════════════

function SymptomBlock({
  ctx,
  rows,
  drafts,
  onAdd,
  onPatchDraft,
  onRemoveDraft,
  onInsert,
  onUpdate,
}: {
  ctx: SheetCtx
  rows: Vital[]
  drafts: VitalDraft[]
  onAdd: () => void
  onPatchDraft: (key: string, patch: Partial<VitalDraft>) => void
  /** 追加した行の取り消し（未保存の行のみ） */
  onRemoveDraft: (key: string) => void
  onInsert: InsertVitalFn
  onUpdate: UpdateVitalFn
}) {
  const count = rows.length + drafts.length
  return (
    // key は付けない（理由は OutingBlock と同じ＝再マウントでフォーカスを失わせない）
    <CollapsibleBlock
      title="他症状者"
      count={count}
      onAdd={onAdd}
      addLabel="＋追加"
      defaultOpen={count > 0}
    >
      <HeadRow>
        <HeadCell width="var(--w-name)">氏名</HeadCell>
        <HeadCell width="var(--w-pulse)">時</HeadCell>
        <HeadCell width="var(--w-temp)">体温</HeadCell>
        <HeadCell width="var(--w-spo2)">SpO2</HeadCell>
        <HeadCell width={W_BP}>血圧</HeadCell>
        <HeadCell width="var(--w-pulse)">脈</HeadCell>
        <HeadCell grow>症状</HeadCell>
      </HeadRow>

      {rows.map((v) => {
        const key = `s${v.id}`
        const name = residentName(ctx.residentById.get(v.resident_id), v.resident_id)
        return (
          <div key={key}>
            <Row>
              <Cell width="var(--w-name)" className="flex items-center">
                <span className="truncate font-bold">{name}</span>
              </Cell>
              <VitalSetCells
                name={name}
                vital={v}
                input={null}
                disabled={ctx.disabled}
                onError={(m) => ctx.setStatus(key, { tone: 'danger', text: m })}
                onCommit={(patch, clearing, label) => onUpdate(v, patch, key, clearing, label)}
              />
              <Cell grow pad={false}>
                <SheetCell
                  value={v.symptom ?? ''}
                  onCommit={
                    ctx.disabled
                      ? undefined
                      : (raw) =>
                          onUpdate(
                            v,
                            { symptom: raw.trim() === '' ? null : raw.trim() },
                            key,
                            raw.trim() === '' && (v.symptom ?? '') !== '',
                            '症状',
                          )
                  }
                  width="100%"
                  align="left"
                  multiline
                  placeholder="症状"
                  ariaLabel={`${name} の症状`}
                  as="div"
                />
              </Cell>
            </Row>
            <StatusText status={ctx.status[key]} />
          </div>
        )
      })}

      {drafts.map((d) => {
        const name = d.residentId == null ? '' : residentName(ctx.residentById.get(d.residentId), d.residentId)
        const disabled = ctx.disabled || d.locked
        const set = d.sets[0] ?? emptySet()
        return (
          <div key={d.key}>
            <Row className="bg-surface2">
              <PickerCell
                width="var(--w-name)"
                text={name}
                label={name === '' ? '対象の利用者を選ぶ' : `対象 ${name}。押すと選び直します`}
                disabled={disabled}
                onClick={() => ctx.openResident({ for: 'vitalTarget', key: d.key })}
              />
              <VitalSetCells
                name={name === '' ? '未選択' : name}
                vital={null}
                input={set}
                disabled={disabled}
                onError={(m) => ctx.setStatus(d.key, { tone: 'danger', text: m })}
                onInput={(patch) => onPatchDraft(d.key, { sets: [{ ...set, ...patch }] })}
                onCommit={(patch) => {
                  if (d.residentId == null) return
                  const merged = {
                    ...setToPatch(set),
                    ...patch,
                    symptom: d.symptom.trim() === '' ? null : d.symptom.trim(),
                  }
                  // 値も症状も無ければ保存しない（空欄の確定で空行を作らない）
                  if (!hasVitalValue(merged)) return
                  void onInsert(d.key, d.residentId, 'symptom', merged, d.key)
                }}
              />
              <Cell grow pad={false}>
                <SheetCell
                  value={d.symptom}
                  onCommit={
                    disabled
                      ? undefined
                      : (raw) => {
                          onPatchDraft(d.key, { symptom: raw })
                          if (d.residentId == null || raw.trim() === '') return
                          // 同じ行に入れてある測定値も一緒に送る
                          const merged = { ...setToPatch(set), symptom: raw.trim() }
                          void onInsert(d.key, d.residentId, 'symptom', merged, d.key)
                        }
                  }
                  width="100%"
                  align="left"
                  multiline
                  placeholder="症状"
                  ariaLabel="症状"
                  as="div"
                />
              </Cell>
            </Row>
            <p className="flex flex-wrap items-center gap-gap px-2 text-ink2">
              {d.locked ? (
                <span className="flex-1 text-warn">
                  <span aria-hidden="true">▲ </span>
                  {MSG_LOCKED_DELETE}
                </span>
              ) : d.residentId == null ? (
                <span className="flex-1">
                  <span aria-hidden="true">ⓘ </span>氏名を選び、症状か値を入れると保存します
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => onRemoveDraft(d.key)}
                disabled={d.locked}
                className="min-h-tap rounded-md border border-border-strong px-3 text-link disabled:border-border disabled:text-ink3"
              >
                この行を取り消す
              </button>
            </p>
            <StatusText status={ctx.status[d.key]} />
          </div>
        )
      })}

      {count === 0 && (
        <p className="px-2 py-1 text-ink2">
          <span aria-hidden="true">— </span>この日の他症状者はいません
        </p>
      )}
    </CollapsibleBlock>
  )
}

// ══════════════════════════════════════════════════════════════
// 申し送り（対象 | 本文 | 記入者）
// ══════════════════════════════════════════════════════════════

interface NoteBlockProps {
  ctx: SheetCtx
  title: string
  rows: Note[]
  drafts: NoteDraft[]
  showReporter: boolean
  actorId: number | null
  expanded: string | null
  onToggleExpand: (key: string) => void
  onAdd: () => void
  onCommitBody: (key: string, value: string) => void
  onPatchDraft: (key: string, patch: Partial<NoteDraft>) => void
  onUpdateNote: (
    note: Note,
    patch: Parameters<typeof updateNoteFields>[2],
    optimistic: Partial<Note>,
  ) => Promise<void>
  onDelete: (key: string) => void
  onMarkRead: (note: Note) => void
}

function NoteBlock({
  ctx,
  title,
  rows,
  drafts,
  showReporter,
  actorId,
  expanded,
  onToggleExpand,
  onAdd,
  onCommitBody,
  onPatchDraft,
  onUpdateNote,
  onDelete,
  onMarkRead,
}: NoteBlockProps) {
  const count = rows.length + drafts.length
  return (
    // key は付けない（理由は OutingBlock と同じ＝再マウントでフォーカスを失わせない）
    <CollapsibleBlock
      title={title}
      count={count}
      onAdd={onAdd}
      addLabel="＋追加"
      defaultOpen={count > 0}
    >
      <HeadRow>
        <HeadCell width="var(--w-reporter)">色</HeadCell>
        <HeadCell width="var(--w-target)">対象</HeadCell>
        <HeadCell grow>内容</HeadCell>
        {showReporter && <HeadCell width="var(--w-reporter)">記入者</HeadCell>}
        <HeadCell width="var(--w-reporter)">詳細</HeadCell>
      </HeadRow>

      {rows.map((note) => (
        <NoteRow
          key={`n${note.id}`}
          ctx={ctx}
          rowKey={`n${note.id}`}
          note={note}
          draft={null}
          showReporter={showReporter}
          actorId={actorId}
          expanded={expanded === `n${note.id}`}
          onToggleExpand={onToggleExpand}
          onCommitBody={onCommitBody}
          onPatchDraft={onPatchDraft}
          onUpdateNote={onUpdateNote}
          onDelete={onDelete}
          onMarkRead={onMarkRead}
        />
      ))}

      {drafts.map((d) => (
        <NoteRow
          key={d.key}
          ctx={ctx}
          rowKey={d.key}
          note={null}
          draft={d}
          showReporter={showReporter}
          actorId={actorId}
          expanded={expanded === d.key}
          onToggleExpand={onToggleExpand}
          onCommitBody={onCommitBody}
          onPatchDraft={onPatchDraft}
          onUpdateNote={onUpdateNote}
          onDelete={onDelete}
          onMarkRead={onMarkRead}
        />
      ))}

      {count === 0 && (
        <p className="px-2 py-1 text-ink2">
          <span aria-hidden="true">— </span>この日の{title}はまだありません
        </p>
      )}
    </CollapsibleBlock>
  )
}

interface NoteRowProps
  extends Omit<NoteBlockProps, 'title' | 'rows' | 'drafts' | 'onAdd' | 'expanded'> {
  rowKey: string
  note: Note | null
  draft: NoteDraft | null
  /** この行の詳細を開いているか（申し送りブロック内で1行だけ開く） */
  expanded: boolean
}

function NoteRow({
  ctx,
  rowKey,
  note,
  draft,
  showReporter,
  actorId,
  expanded,
  onToggleExpand,
  onCommitBody,
  onPatchDraft,
  onUpdateNote,
  onDelete,
  onMarkRead,
}: NoteRowProps) {
  const disabled = ctx.disabled || (draft?.locked ?? false)
  const color = note ? note.color : (draft?.color ?? null)
  const residentId = note ? note.resident_id : (draft?.residentId ?? null)
  const targetPicked = note !== null || (draft?.targetPicked ?? false)
  const reporterId = note ? note.reporter_id : (draft?.reporterId ?? null)
  const body = note ? note.body : (draft?.body ?? '')

  const targetText = !targetPicked
    ? ''
    : residentId === null
      ? 'スタッフへ（全体）'
      : residentName(ctx.residentById.get(residentId), residentId)
  const reporterText = reporterId === null ? '' : staffName(ctx.staffById.get(reporterId), reporterId)

  const setColor = (c: NoteColor | null) => {
    if (note) void onUpdateNote(note, { color: c }, { color: c })
    else if (draft) onPatchDraft(draft.key, { color: c })
  }

  const readCount = note?.read_count ?? 0
  const detailLabel = note
    ? `詳細を開く（${IMPORTANCE_LABEL[note.importance]}・既読 ${readCount}人）`
    : '詳細を開く'

  return (
    <div className={color ? NOTE_COLOR_CLASS[color] : undefined}>
      <Row>
        <Cell width="var(--w-reporter)" className="flex items-center">
          {/* 封鎖中・送信待ちの行は色も変えられない（同じ行の他のセルと可否をそろえる） */}
          <ColorPicker value={color} onChange={setColor} ariaLabel="この行の色" disabled={disabled} />
        </Cell>
        <PickerCell
          width="var(--w-target)"
          text={targetText}
          label={targetText === '' ? '対象を選ぶ' : `対象 ${targetText}。押すと選び直します`}
          disabled={disabled}
          onClick={() => ctx.openResident({ for: 'noteTarget', key: rowKey })}
        />
        {/* 余白は SheetCell 側だけが持つ（対象・記入者と本文の左端をそろえる） */}
        <Cell grow pad={false}>
          <SheetCell
            value={body}
            onCommit={disabled ? undefined : (v) => onCommitBody(rowKey, v)}
            width="100%"
            align="left"
            multiline
            placeholder="内容"
            ariaLabel="申し送りの内容"
            as="div"
            // 行の色は外側の div が敷く。既定の tone（不透明な bg-surface）だと
            // いちばん幅の広い本文セルだけ白く抜けて、行の色が伝わらなくなる
            tone="row"
          />
        </Cell>
        {showReporter && (
          <PickerCell
            width="var(--w-reporter)"
            text={reporterText}
            label={reporterText === '' ? '記入者を選ぶ' : `記入者 ${reporterText}。押すと選び直します`}
            disabled={disabled}
            onClick={() => ctx.openStaff({ for: 'noteReporter', key: rowKey })}
          />
        )}
        {/* 余白はボタン（px-1）だけが持つ */}
        <Cell width="var(--w-reporter)" pad={false} className="flex items-center">
          <button
            type="button"
            onClick={() => onToggleExpand(rowKey)}
            aria-expanded={expanded}
            aria-label={detailLabel}
            style={ROW_BTN_STYLE}
            className={`${CELL_HIT} w-full rounded-sm px-1 text-left text-link`}
          >
            {/* 記号と数字で状態が分かるようにする（色だけに頼らない） */}
            {note && note.importance !== 'normal' ? <span>{IMPORTANCE_LABEL[note.importance]}</span> : null}
            {note && readCount > 0 ? <span className="tabular"> ✓{readCount}</span> : null}
            {!note || (note.importance === 'normal' && readCount === 0) ? <span>…</span> : null}
          </button>
        </Cell>
      </Row>

      <StatusText status={ctx.status[rowKey]} />

      {expanded && (
        <div className="border-b border-border bg-surface2 px-2 py-2">
          {note ? (
            <div className="space-y-2">
              <div>
                <p className="text-ink2" id={`${rowKey}-imp`}>
                  重要度
                </p>
                <SegmentPicker
                  ariaLabel="重要度"
                  value={note.importance}
                  options={(['normal', 'important', 'critical'] as Importance[]).map((v) => ({
                    value: v,
                    label: IMPORTANCE_LABEL[v],
                  }))}
                  onChange={(v) => {
                    const imp = v as Importance
                    void onUpdateNote(note, { importance: imp }, { importance: imp })
                  }}
                />
              </div>
              <div>
                <p className="text-ink2">職種タグ</p>
                <div className="flex flex-wrap gap-gap">
                  {ROLE_TAGS.map((tag) => {
                    const on = note.role_tags.includes(tag)
                    return (
                      <button
                        key={tag}
                        type="button"
                        aria-pressed={on}
                        disabled={ctx.disabled}
                        onClick={() => {
                          const next = on
                            ? note.role_tags.filter((t) => t !== tag)
                            : [...note.role_tags, tag]
                          void onUpdateNote(note, { role_tags: next }, { role_tags: next })
                        }}
                        className={`min-h-tap rounded-full border px-3 text-base ${
                          on ? 'border-primary bg-primary text-primary-ink font-bold' : 'border-border text-ink'
                        }`}
                      >
                        <span aria-hidden="true">{on ? '✓ ' : ''}</span>
                        {tag}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-gap">
                <span className="text-ink2 tabular">既読 {readCount}人</span>
                {note.my_read ? (
                  <span className="text-ok">
                    <span aria-hidden="true">✓ </span>自分は既読
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onMarkRead(note)}
                    disabled={actorId == null}
                    className="min-h-tap rounded-md border border-primary px-3 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
                  >
                    既読にする
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onDelete(rowKey)}
                  disabled={ctx.disabled}
                  className="min-h-tap rounded-md border border-danger px-3 text-base font-bold text-danger disabled:border-border disabled:text-ink3"
                >
                  <span aria-hidden="true">▲ </span>この行を削除
                </button>
              </div>
              {note.color && <p className="text-ink2">この行の色: {NOTE_COLOR_LABEL[note.color]}</p>}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-gap">
              <p className="flex-1 text-ink2">
                <span aria-hidden="true">ⓘ </span>
                この行はまだ保存されていません。重要度・職種タグ・既読は保存後に設定できます。
              </p>
              {draft?.locked ? (
                <p className="flex-1 text-warn">
                  <span aria-hidden="true">▲ </span>
                  {MSG_LOCKED_DELETE}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => onDelete(rowKey)}
                disabled={draft?.locked ?? false}
                className="min-h-tap rounded-md border border-border-strong px-3 text-base text-ink disabled:border-border disabled:text-ink3"
              >
                この行を取り消す
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
