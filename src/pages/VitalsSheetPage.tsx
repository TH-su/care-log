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
// - 保存は1名1日単位（id 無し=insertVital／id 有り=updateVital(id, rev, 変更列のみ)）。
//   upsert は使わず、23505 は db.ts 側の既存の作法（既存行を読み直して update）に吸収させる
// - 記録済みの値を空にする操作は確認ダイアログを挟む（空上書き保護・dev-principles 原則4）
// - 入力解禁フラグ（native_input_enabled）が false の間は編集不可＋理由文（閲覧は可能）
// - UI 状態（フロア・日数）だけを localStorage に保存する。氏名・記録値・日付は保存しない
// - 個人情報は console にも localStorage にも出さない

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DbError,
  fetchResidents,
  fetchVitalsSheet,
  getNativeInputGate,
  insertVital,
  queuePending,
  queueSubscribe,
  updateVital,
} from '../lib/db'
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

/** フロア絞り込みの「全」 */
const FLOOR_ALL = 'all'
/** 居室が未設定の入居者を入れるフロア区分 */
const FLOOR_OTHER = 'other'

/** 横並びする日数の既定（契約 §6: バイタルは4日） */
const DEFAULT_DAYS: SheetDays = 4

const ERR_LOAD =
  'バイタル一覧を読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'
const ERR_SAVE =
  '保存できませんでした。入力は消えていません。通信状況を確認して、もう一度入力を確定してください。'
const ERR_CONFLICT =
  '他の端末で先に更新されました。入力は消えていません。「読み込み直す」を押して最新の値を確認してください。'
const MSG_QUEUED = '通信できないため送信待ちにしました。電波が戻ると自動で送信します。'
const MSG_QUEUED_EDIT =
  'この日には送信待ちの保存があります。あとから入力した値はまだ保存されていません。電波が戻って送信が終わってから「読み込み直す」を押して、入力し直してください。'
const MSG_BLOCKED =
  '現在はスプレッドシートで記録する期間です（アプリ入力の開始日は施設で決定します）'
const MSG_GATE_UNKNOWN =
  '入力できるかどうかを確認できませんでした（通信エラー）。電波状態を確認して、「もう一度確認する」を押してください。入力は消えていません。'

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
  const [recs, setRecs] = useState<Map<string, Rec>>(() => new Map())
  /**
   * 入居者ごとに**画面に出している**再検の行数（0＝出さない）。
   * 記録がある人は「保存済みの本数＋空行1本」、記録が無い人は「再検」ボタンを押した本数。
   */
  const [recheckRows, setRecheckRows] = useState<Map<number, number>>(() => new Map())
  const [pending, setPending] = useState(0)
  const [clearAsk, setClearAsk] = useState<{ labels: string; day: string } | null>(null)

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
  const savingRef = useRef(new Set<string>())
  /** 保存の応答待ち中に重なった保存要求（先行保存の完了後にやり直す＝要求を黙って捨てない） */
  const resaveRef = useRef(new Set<string>())
  const clearResolveRef = useRef<((ok: boolean) => void) | null>(null)

  const actorId = propActorId !== undefined ? propActorId : getActorId()
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

  const load = useCallback(async () => {
    setLoading(true)
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
      if (!aliveRef.current) return

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
      const KEEP: RecState[] = ['queued', 'conflict', 'error', 'invalid', 'saving']
      for (const [k, cur] of recsRef.current) {
        if (!KEEP.includes(cur.state)) continue
        // 表示中の期間の外（別の期間で入力したまま残っている控え）は持ち込まない
        if (cur.day < fromIso || cur.day > anchor) continue
        const fresh = next.get(k)
        next.set(
          k,
          fresh
            ? { ...fresh, buf: cur.buf, state: cur.state, message: cur.message, sent: cur.sent }
            : cur,
        )
        // 控えのある再検枠が消えないよう、行数もその枠まで確保する
        if (cur.kind === 'recheck') {
          counts.set(cur.residentId, Math.max(counts.get(cur.residentId) ?? 0, cur.slot + 1))
        }
      }

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
      commitRecs(next)
      commitRecheckRows(rowCounts)
      setError(null)
    } catch (e) {
      if (!aliveRef.current) return
      // 失敗時は既存の表示を消さない（安全側フォールバック）。
      // db.ts の DbError は「何が起きたか＋次にどうすればよいか」を持っている
      // （例: 日数が多すぎて読み切れなかった＝再試行では解決しない）ので、
      // 通信エラーの定型文で塗り潰さない
      setError(e instanceof DbError && e.message ? e.message : ERR_LOAD)
    } finally {
      if (aliveRef.current) setLoading(false)
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

  /** 1名1日分（＝vitals の1行）を保存する。upsert は使わず insert / update(id, rev) に分岐する */
  const saveOne = useCallback(
    async (key: string) => {
      const rec = recsRef.current.get(key)
      if (!rec) return
      if (rec.state === 'saving') return

      // 差分の基準。送信待ちの行は「キューへ渡した内容」と比べる
      // （サーバー観測値と比べると、送信済みの値まで毎回「新しい入力」に見えてしまう）
      const baseline = rec.state === 'queued' && rec.sent ? rec.sent : rec.saved

      const changes: Partial<Record<Field, number | null>> = {}
      /** 数字として読めない入力（打ち間違い）。空欄＝消す意思とは別物として扱う */
      const unreadable: Field[] = []
      /** 数値にはなったが VITAL_RANGE の外 */
      const outside: Field[] = []
      const cleared: Field[] = []
      for (const f of FIELDS) {
        // 空欄かどうかは buf の生値で判定する。normalizeVitalInput は空欄でも解釈不能でも
        // null を返すため、戻り値だけで見ると打ち間違いを「消す意思」と取り違える
        // （空セルなら差分なしで黙って捨て、記録済みセルなら値を消してしまう）
        const raw = toHalfWidth(rec.buf[f])
        const p = normalizeVitalInput(rec.buf[f], f)
        if (raw !== '' && p == null) {
          unreadable.push(f)
          continue
        }
        if (p != null && outOfRange(f, p)) {
          outside.push(f)
          continue
        }
        if (p === baseline[f]) continue
        // ここへ来る p == null は「空欄を確定した」＝消す意思のときだけ
        if (p == null) cleared.push(f)
        else changes[f] = p
      }
      const invalid = [...unreadable, ...outside]

      // 送信待ちに退避済みの行は再送をキューに任せる（同じ内容の二重送信を作らない）。
      // そのあとに入力した値はまだ送られていないので、黙って捨てずに理由と次の行動を出す
      if (rec.state === 'queued') {
        if (Object.keys(changes).length > 0 || cleared.length > 0 || invalid.length > 0) {
          patchRec(key, { state: 'queued', message: MSG_QUEUED_EDIT })
        }
        return
      }

      // 読めない入力・範囲外のセルが混ざっていた時の警告。保存が成功しても消さずに残す
      // （「✓保存済」で覆い隠すと、保存していない値まで保存されたと誤解させるため）
      const invalidMessage = invalidText(unreadable, outside)
      if (invalid.length > 0) {
        patchRec(key, { state: 'invalid', message: invalidMessage })
      } else if (rec.state === 'invalid') {
        // 打ち直して警告が解消された時は、保存する差分が無くても古い警告を残さない
        patchRec(key, { state: 'idle', message: '' })
      }

      // 記録済みの値を空にするのは取り消しにくい操作なので確認を挟む（空上書き保護）
      if (cleared.length > 0) {
        const ok = await askClear(cleared.map((f) => FIELD_LABEL[f]).join('・'), rec.day)
        if (!aliveRef.current) return
        if (ok) {
          for (const f of cleared) changes[f] = null
        } else {
          // 取り消したら入力欄をサーバーの値へ戻す（画面と保存内容を一致させる）
          const cur = recsRef.current.get(key)
          if (cur) {
            const buf = { ...cur.buf }
            for (const f of cleared) {
              const v = cur.saved[f]
              buf[f] = v == null ? '' : fmtNum(f, v)
            }
            patchRec(key, { buf })
          }
        }
      }

      const fields = Object.keys(changes) as Field[]
      if (fields.length === 0) return

      // この保存でサーバーへ渡す内容（応答後に「新しい入力が乗ったか」を見分ける基準）
      const sentValues: Record<Field, number | null> = { ...baseline, ...changes }

      // 保存できた行の状態。保存しなかった入力（読めない入力・範囲外）が残っていれば警告のまま据え置く。
      // 応答を待つ間に入力された値が残っている行は「保存済」にしない（未送信を保存済みに見せない）。
      // 送った内容がそのまま残っている行は、保存された値で入力欄を描き直す
      // （短縮入力「365」→36.5・全角「３６．５」→36.5 を画面と記録で一致させる。
      //   範囲外・応答待ちの間に入力された値は書き換えない＝入力を消さない）
      const done = (res: Vital): Partial<Rec> => {
        const cur = recsRef.current.get(key)
        const stillDirty =
          cur != null && FIELDS.some((f) => normalizeVitalInput(cur.buf[f], f) !== sentValues[f])
        // 保存された値で描き直す時も、保存しなかったセル（読めない入力・範囲外）は打った文字を残す。
        // 警告文の「入力は消えていません」と画面を一致させるため（原則4: 入力を消さない）
        const redrawn = (): { buf: Record<Field, string> } => {
          const buf = bufOf(savedOf(res))
          if (cur) for (const f of invalid) buf[f] = cur.buf[f]
          return { buf }
        }
        const shown = stillDirty ? {} : redrawn()
        if (invalid.length > 0) return { state: 'invalid', message: invalidMessage, ...shown }
        return stillDirty ? { state: 'idle', message: '' } : { state: 'saved', message: '', ...shown }
      }

      patchRec(key, { state: 'saving', message: invalidMessage })
      try {
        if (rec.vitalId == null) {
          const payload = {
            resident_id: rec.residentId,
            measured_on: rec.day,
            kind: rec.kind,
            // 過去日をあとから埋める場合、端末の現在時刻は測定時刻ではないので入れない
            measured_at: rec.day === today ? nowHM() : null,
            temp: changes.temp ?? null,
            sys_bp: changes.sys_bp ?? null,
            dia_bp: changes.dia_bp ?? null,
            pulse: changes.pulse ?? null,
            spo2: changes.spo2 ?? null,
            note: null,
            symptom: null,
            recorded_by: actorId ?? null,
          }
          const res = await insertVital(payload)
          if (!aliveRef.current) return
          if (res === 'queued') {
            patchRec(key, { state: 'queued', message: MSG_QUEUED, sent: sentValues })
            return
          }
          patchRec(key, {
            vitalId: res.id,
            rev: numOrNull(res.rev) ?? 1,
            saved: savedOf(res),
            ...done(res),
          })
        } else {
          // 変更した列だけを送る（他端末が書いた列を巻き戻さない＝部分更新）
          const res = await updateVital(rec.vitalId, rec.rev, changes)
          if (!aliveRef.current) return
          if (res === 'queued') {
            patchRec(key, { state: 'queued', message: MSG_QUEUED, sent: sentValues })
            return
          }
          if (res === 'conflict') {
            patchRec(key, { state: 'conflict', message: ERR_CONFLICT })
            return
          }
          patchRec(key, {
            rev: numOrNull(res.rev) ?? rec.rev + 1,
            saved: savedOf(res),
            ...done(res),
          })
        }
      } catch (e) {
        if (!aliveRef.current) return
        // db.ts の DbError は「何が起きたか＋次にどうすればよいか」を持っているので、
        // 一律の定型文で上書きせずそのまま出す（VitalsGridPage と同型）
        patchRec(key, {
          state: 'error',
          message: e instanceof DbError && e.message ? e.message : ERR_SAVE,
        })
      }
    },
    [actorId, askClear, patchRec, today],
  )

  /**
   * 同じセル組（1名1日1枠）の保存を直列化する。
   * 再検には部分unique索引が無く、応答前に2回目の insert を出すと行が二重にできるため、
   * 先行保存の完了（vitalId 確定）まで待ってからやり直す。
   */
  const saveSerialized = useCallback(
    async (key: string) => {
      if (savingRef.current.has(key)) {
        resaveRef.current.add(key)
        return
      }
      savingRef.current.add(key)
      try {
        do {
          resaveRef.current.delete(key)
          await saveOne(key)
          if (!aliveRef.current) return
        } while (resaveRef.current.has(key) && aliveRef.current)
      } finally {
        savingRef.current.delete(key)
        resaveRef.current.delete(key)
      }
    },
    [saveOne],
  )

  // ── セル編集 ───────────────────────────────────────────────

  const onCommitCell = useCallback(
    (row: TableRow, day: string, field: Field, raw: string) => {
      const key = recKey(row.residentId, day, row.kind, row.slot)
      const cur = recsRef.current.get(key) ?? newRec(row.residentId, day, row.kind, row.slot)
      const next = new Map(recsRef.current)
      next.set(key, {
        ...cur,
        buf: { ...cur.buf, [field]: raw },
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

      void saveSerialized(key)
    },
    [commitRecheckRows, commitRecs, saveSerialized],
  )

  // ── 期間送り ───────────────────────────────────────────────

  const goOlder = useCallback(() => setAnchor((a) => addDays(a, -days)), [days])
  const goNewer = useCallback(() => {
    setAnchor((a) => {
      const next = addDays(a, days)
      return next > today ? today : next
    })
  }, [days, today])
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
  const editable = inputEnabled && !gateUnknown && !loading

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
      <div className="border-b border-border bg-surface pb-3">
        <div className="flex flex-wrap items-center justify-between gap-gap">
          <h1 className="text-xl font-bold text-ink">バイタル一覧</h1>
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

        <div className="mt-3 flex flex-wrap items-center gap-gap">
          {floorOptions.length > 1 ? (
            <SegmentPicker
              options={floorOptions}
              value={floor}
              onChange={(v) => {
                setFloor(v)
                writeFloor(v)
              }}
              ariaLabel="フロアを選ぶ"
            />
          ) : null}

          <SegmentPicker
            options={SHEET_DAYS.map((d) => ({ value: String(d), label: `${d}日` }))}
            value={String(days)}
            onChange={(v) => {
              const n = Number(v)
              if (!(SHEET_DAYS as readonly number[]).includes(n)) return
              setDays(n as SheetDays)
              writeDays(n as SheetDays)
            }}
            ariaLabel="横に並べる日数を選ぶ"
          />

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

          <ZoomBar />
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
                    onAddRecheck={addRecheckRow}
                    onRemoveRecheck={removeRecheckRow}
                    onReload={() => void load()}
                  />
                )
              })}
            </tbody>
          </table>
        </SheetFrame>
      )}

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
  onCommitCell: (row: TableRow, day: string, field: Field, raw: string) => void
  onAddRecheck: (residentId: number) => void
  onRemoveRecheck: (residentId: number) => void
  onReload: () => void
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
  onAddRecheck,
  onRemoveRecheck,
  onReload,
}: FragmentRowProps) {
  // 縞は行が持つ。左固定の2列は他の列の上に重なるので、透けないよう同じ色を自分でも持つ
  const rowBg = alt ? ROW_ALT : ROW_PLAIN
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
          style={{ width: W_NAME, minWidth: W_NAME, maxWidth: W_NAME, left: W_ROOM }}
          className={`${CELL_BASE} sticky z-10 ${rowBg} text-left text-ink`}
        >
          {isRoutine ? (
            // 氏名の右に「再検」ボタン。押すとこの入居者の直下に再検欄が1本増える。
            // 切り詰め（truncate）はセルではなく氏名の span に持たせる
            // ＝ボタンのフォーカスリングがセルに切り取られない
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate">{name}</span>
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
              return (
                <SheetCell
                  key={f}
                  value={raw}
                  onCommit={editable ? (v: string) => onCommitCell(row, day, f, v) : undefined}
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
                  {/* 送信待ちの行に追記した時（MSG_QUEUED_EDIT）も再読込の導線を出す。
                      退避直後の MSG_QUEUED は自動送信を待つだけなので出さない */}
                  {rec.state === 'conflict' || rec.message === MSG_QUEUED_EDIT ? (
                    <button
                      type="button"
                      onClick={onReload}
                      className="ml-2 min-h-tap rounded border border-danger px-3 text-base font-bold text-danger"
                    >
                      読み込み直す
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
