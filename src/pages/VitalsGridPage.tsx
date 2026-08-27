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
//   upsert は使わず「id 無し=insertVital／id 有り=updateVital(id, rev, 変更列のみ)」（db-design §5）
// - 記録済みの値を空にする操作は確認ダイアログを挟む（空上書き保護・dev-principles 原則4）
// - 保存できなかった入力は画面から消さない（キュー退避・競合・範囲外のいずれも入力を保持）
// - 入力解禁フラグ（native_input_enabled）が false の間は全入力をディセーブル＋理由文
// - 個人情報は console にも localStorage にも出さない

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchResidents,
  fetchTimelineChunk,
  getNativeInputEnabled,
  insertVital,
  queuePending,
  queueSubscribe,
  updateVital,
} from '../lib/db'
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
const ERR_CONFLICT =
  '他の端末で先に更新されました。入力は消えていません。「読み込み直す」を押して最新の値を確認してください。'
const MSG_QUEUED = '通信できないため送信待ちにしました。電波が戻ると自動で送信します。'
const MSG_QUEUED_EDIT =
  'この行には送信待ちの保存があります。あとから入力した値はまだ保存されていません。電波が戻って送信が終わってから「読み込み直す」を押して、入力し直してください。'
const MSG_BLOCKED =
  '現在はスプレッドシートで記録する期間です（アプリ入力の開始日は施設で決定します）'

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
  /** 送信キューへ渡した内容（未観測）。送信待ちの行で「そのあと入力された値」を見分けるために持つ */
  sent?: Record<Field, number | null>
  /** 入力バッファ（文字列のまま保持し、保存時に正規化する） */
  buf: Record<Field, string>
  /** 空セルに出す前回値ゴースト */
  prev: Record<Field, number | null>
  state: RowState
  message: string
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
  const [rows, setRows] = useState<GridRow[]>([])
  const [floor, setFloor] = useState<string>(() => readFloor() ?? '1')
  const [sel, setSel] = useState<{ rowId: string; field: Field } | null>(null)
  const [edit, setEdit] = useState('')
  const [pending, setPending] = useState(0)
  const [draftSeq, setDraftSeq] = useState(0)
  const [clearAsk, setClearAsk] = useState<{ labels: string } | null>(null)

  const aliveRef = useRef(true)
  const rowsRef = useRef<GridRow[]>([])
  const selRef = useRef<{ rowId: string; field: Field } | null>(null)
  const savingRef = useRef(new Set<number>())
  /** 保存の応答待ち中に重なった保存要求（先行保存の完了後にやり直す＝要求を黙って捨てない） */
  const resaveRef = useRef(new Set<number>())
  const clearResolveRef = useRef<((ok: boolean) => void) | null>(null)

  const actorId = propActorId !== undefined ? propActorId : getActorId()

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
      // 日付レンジ付きの1往復で「当日の測定」と「前回値ゴースト」の両方をまかなう
      const [rs, enabled, chunk] = await Promise.all([
        propResidents ? Promise.resolve(propResidents) : fetchResidents(),
        propInputEnabled === undefined
          ? getNativeInputEnabled()
          : Promise.resolve(propInputEnabled),
        fetchTimelineChunk(from, day, null),
      ])
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

      setResidents(sorted)
      setInputEnabled(enabled === true)
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

  /** 1行を保存する。upsert は使わず insert / update(id, rev) に分岐する（db-design §5） */
  const saveRow = useCallback(
    async (rowId: string) => {
      const row = rowsRef.current.find((r) => r.rowId === rowId)
      if (!row) return
      if (row.state === 'saving') return

      // 差分の基準。送信待ちの行は「キューへ渡した内容」と比べる
      // （サーバー観測値と比べると、送信済みの値まで毎回「新しい入力」に見えてしまう）
      const baseline = row.state === 'queued' && row.sent ? row.sent : row.saved

      const changes: Partial<Record<Field, number | null>> = {}
      const invalid: Field[] = []
      const cleared: Field[] = []
      for (const f of FIELDS) {
        const p = normalizeVitalInput(row.buf[f], f)
        if (p != null && outOfRange(f, p)) {
          invalid.push(f)
          continue
        }
        if (p === baseline[f]) continue
        if (p == null) cleared.push(f)
        else changes[f] = p
      }

      // 送信待ちに退避済みの行は再送をキューに任せる（同じ内容の二重送信を作らない）。
      // そのあとに入力した値はまだ送られていないので、黙って捨てずに理由と次の行動を出す
      if (row.state === 'queued') {
        if (Object.keys(changes).length > 0 || cleared.length > 0 || invalid.length > 0) {
          patchRow(rowId, { state: 'queued', message: MSG_QUEUED_EDIT })
        }
        return
      }

      // 範囲外のセルが混ざっていた時の警告。保存が成功しても消さずに残す
      // （「✓保存済」で覆い隠すと、範囲外の値まで保存されたと誤解させるため）
      const invalidMessage =
        invalid.length > 0
          ? `入力値を確認してください（${invalid.map(rangeText).join('・')}）。範囲外の値は保存していません。`
          : ''
      if (invalid.length > 0) {
        patchRow(rowId, { state: 'invalid', message: invalidMessage })
      }

      // 記録済みの値を空にするのは取り消しにくい操作なので確認を挟む（空上書き保護）
      if (cleared.length > 0) {
        const ok = await askClear(cleared.map((f) => FIELD_LABEL[f]).join('・'))
        if (!aliveRef.current) return
        if (ok) {
          for (const f of cleared) changes[f] = null
        } else {
          // 取り消したら入力欄をサーバーの値へ戻す（入力は失わせない＝画面と保存内容を一致させる）
          const cur = rowsRef.current.find((r) => r.rowId === rowId)
          if (cur) {
            const buf = { ...cur.buf }
            for (const f of cleared) {
              const v = cur.saved[f]
              buf[f] = v == null ? '' : fmtNum(f, v)
            }
            patchRow(rowId, { buf })
          }
        }
      }

      const fields = Object.keys(changes) as Field[]
      if (fields.length === 0) return

      // この保存でサーバーへ渡す内容（応答後に「新しい入力が乗ったか」を見分ける基準）
      const sentValues: Record<Field, number | null> = { ...baseline, ...changes }

      // 保存できた行の状態。範囲外の入力が残っていれば警告のまま据え置く。
      // 応答を待つ間に入力された値が残っている行は「✓保存済」にしない（未送信を保存済みに見せない）。
      // 残った入力は saveResident のやり直しで次に送られる
      const done = (): Partial<GridRow> => {
        if (invalid.length > 0) return { state: 'invalid', message: invalidMessage }
        const cur = rowsRef.current.find((r) => r.rowId === rowId)
        const stillDirty =
          cur != null && FIELDS.some((f) => normalizeVitalInput(cur.buf[f], f) !== sentValues[f])
        return stillDirty ? { state: 'idle', message: '' } : { state: 'saved', message: '' }
      }

      patchRow(rowId, { state: 'saving', message: invalidMessage })
      try {
        if (row.vitalId == null) {
          const rec = {
            resident_id: row.residentId,
            measured_on: day,
            kind: row.kind,
            measured_at: nowHM(),
            temp: changes.temp ?? null,
            sys_bp: changes.sys_bp ?? null,
            dia_bp: changes.dia_bp ?? null,
            pulse: changes.pulse ?? null,
            spo2: changes.spo2 ?? null,
            note: null,
            recorded_by: actorId ?? null,
          }
          const res = await insertVital(rec)
          if (!aliveRef.current) return
          if (res === 'queued') {
            patchRow(rowId, {
              state: 'queued',
              message: MSG_QUEUED,
              sent: sentValues,
            })
            return
          }
          patchRow(rowId, {
            vitalId: res.id,
            rev: numOrNull(res.rev) ?? 1,
            saved: savedOf(res),
            ...done(),
          })
        } else {
          // 変更した列だけを送る（他端末が書いた列を巻き戻さない＝部分更新）
          const res = await updateVital(row.vitalId, row.rev, changes)
          if (!aliveRef.current) return
          if (res === 'queued') {
            patchRow(rowId, {
              state: 'queued',
              message: MSG_QUEUED,
              sent: sentValues,
            })
            return
          }
          if (res === 'conflict') {
            patchRow(rowId, { state: 'conflict', message: ERR_CONFLICT })
            return
          }
          patchRow(rowId, {
            rev: numOrNull(res.rev) ?? row.rev + 1,
            saved: savedOf(res),
            ...done(),
          })
        }
      } catch {
        if (!aliveRef.current) return
        patchRow(rowId, { state: 'error', message: ERR_SAVE })
      }
    },
    [actorId, askClear, day, patchRow],
  )

  /** 1名分（定時＋再検）をまとめて保存する */
  const saveResident = useCallback(
    async (residentId: number) => {
      if (savingRef.current.has(residentId)) {
        // 先行保存の応答待ち。この要求を捨てると、待っている間に入力した値が保存されないまま
        // 再送の合図も無くなる（silent fail）。印を残し、先行保存の完了後にやり直す
        resaveRef.current.add(residentId)
        return
      }
      savingRef.current.add(residentId)
      try {
        do {
          // やり直しの印はここで下ろす（この周回の保存に、それまでの入力が含まれる）
          resaveRef.current.delete(residentId)
          const ids = rowsRef.current
            .filter((r) => r.residentId === residentId)
            .map((r) => r.rowId)
          for (const id of ids) {
            await saveRow(id)
            if (!aliveRef.current) return
          }
        } while (resaveRef.current.has(residentId) && aliveRef.current)
      } finally {
        savingRef.current.delete(residentId)
        resaveRef.current.delete(residentId)
      }
    },
    [saveRow],
  )

  // ── セル操作 ───────────────────────────────────────────────

  /** 入力中の値を行バッファへ書き戻す（次の操作へ移る前に必ず通す＝入力を落とさない） */
  const commitEditWith = useCallback(
    (value: string): GridRow[] => {
      const s = selRef.current
      const cur = rowsRef.current
      if (!s) return cur
      const next: GridRow[] = cur.map((r) =>
        r.rowId === s.rowId
          ? {
              ...r,
              buf: { ...r.buf, [s.field]: value },
              // 値を触ったら「保存済み」表示は下ろす（未保存を保存済みに見せない）
              state: r.state === 'saved' ? 'idle' : r.state,
              message: r.state === 'saved' ? '' : r.message,
            }
          : r,
      )
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
      setEdit(next.find((r) => r.rowId === rowId)?.buf[field] ?? '')
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

  // ── 表示用の値 ─────────────────────────────────────────────

  const selRow = sel ? rows.find((r) => r.rowId === sel.rowId) ?? null : null
  const selResident = selRow ? residentById.get(selRow.residentId) ?? null : null
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

        {!inputEnabled ? (
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
                    inputEnabled={inputEnabled}
                    sel={sel}
                    edit={edit}
                    onOpenCell={(field) => openCell(row.rowId, field, edit)}
                    onAddRecheck={() => addRecheck(row.residentId)}
                    onRemoveDraft={isEmptyDraft ? () => removeDraftRow(row.rowId) : null}
                    onReload={() => void load()}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {sel && selRow && inputEnabled ? (
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
  onOpenCell: (field: Field) => void
  onAddRecheck: () => void
  onRemoveDraft: (() => void) | null
  onReload: () => void
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
  onOpenCell,
  onAddRecheck,
  onRemoveDraft,
  onReload,
}: FragmentRowProps) {
  const isRoutine = row.kind === 'routine'
  return (
    <>
      <tr className="border-b border-border align-middle">
        <td className="tabular px-2 text-sm text-ink2">{isRoutine ? (room ?? '—') : ''}</td>
        <td className="px-2">
          <span className="block truncate text-base font-bold text-ink">
            {isRoutine ? residentName : ''}
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
          return (
            <td key={f} className="px-1 py-1">
              <button
                type="button"
                disabled={!inputEnabled}
                onClick={() => onOpenCell(f)}
                aria-label={`${room ?? '居室未設定'} ${residentName} ${KIND_LABEL[row.kind]} ${FIELD_LABEL[f]}${
                  raw === '' ? '　未入力' : `　${raw}`
                }`}
                className={[
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
              {/* 送信待ちの行に追記した時（MSG_QUEUED_EDIT）も再読込の導線を出す。
                  退避直後の MSG_QUEUED は自動送信を待つだけなので出さない */}
              {row.state === 'conflict' || row.message === MSG_QUEUED_EDIT ? (
                <button
                  type="button"
                  onClick={onReload}
                  className="ml-2 min-h-tap rounded border border-danger px-3 text-base font-bold text-danger"
                >
                  読み込み直す
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
