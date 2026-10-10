// タイムライン（スプシ風10日）の取得と無限スクロール状態。
// 契約: docs/design/contracts.md §src/hooks/useTimeline.ts ／ 詳細: docs/design/ui-design.md §3・db-design.md §2
// - 取得は fetchTimelineChunk のみ（RPC 1発）。初期10日・追加10日・日付境界 keyset（offset 不使用）
// - 受信チャンクを日単位に組み替えて DayData[] を返す（新しい日が先頭）
// - DOM 保持上限60日。超過分は「新しい側」を外し trimmed=true（resetToLatest で最新へ戻す）
// - Realtime は表示ウィンドウ内の日だけ取り直す（ウィンドウ外の日は取りに行かない＝全件ロード禁止）。
//   2026-10-10（F67）: この端末自身の書き込みと、窓の外の日の変更は取り直さない。日が分かる変更（バイタル・食事・水分・
//   継続でない申し送りとその既読）は、その日を含む10日のチャンクだけを取り直して差し替える。日が分からない通知（取り消し・
//   取り直しの合図 RESYNC）・継続の申し送り（ピン留めが各日に複製される）・外出（チャンクをまたぐ）は、今までどおり窓全体
// - 取得失敗時は表示中のデータを消さない（安全側フォールバック）。個人情報は console にも localStorage にも出さない

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchTimelineChunk, isSelfWrite, subscribeChanges } from '../lib/db'
import { addDays, isoDate, todayIso } from '../lib/format'
import type {
  DayData,
  FluidIntake,
  ImportDay,
  Meal,
  MealSlot,
  Note,
  Outing,
  TimelineChunk,
  Vital,
} from '../lib/types'

/** 1チャンク＝10日（初期・追加とも。db-design §2 で確定） */
const CHUNK_DAYS = 10
/** DOM 保持上限（ui-design §3） */
const MAX_DAYS = 60
/** Realtime の連続通知をまとめる待ち時間（ミリ秒） */
const REALTIME_DEBOUNCE_MS = 1500
/** 記録が1件も無いチャンクがこの回数続いたら「これより古い記録は無い」とみなす */
const EMPTY_CHUNK_LIMIT = 2
/**
 * タイムラインの表示に関わる表だけを再取得の対象にする。
 * 'import_days' は db.ts の REALTIME_TABLES（＝supabase_realtime に登録した表）に含まれないため、
 * 現状この通知は届かない（取込状態バッジは手動更新・次回取得で切り替わる）。配信対象に加えるかは
 * SQL側（0001_init.sql の Realtime 登録）を伴う変更なので裁定待ち＝積み残し。
 */
const WATCHED_TABLES = new Set([
  'notes',
  'note_reads',
  'vitals',
  'meals',
  'fluid_intake',
  'outings',
  'import_days',
])
/** 日付レンジ展開の安全上限（壊れた値で無限ループしないための歯止め） */
const RANGE_HARD_CAP = 400

const ERR_LOAD = 'タイムラインを読み込めませんでした。通信状況を確認して、「再読み込み」を押してください。'
const ERR_MORE = 'これより前の記録を読み込めませんでした。通信状況を確認して、もう一度お試しください。'

// ── 純ロジック（副作用なし） ──────────────────────────────────

/** 受信データを信じない: 配列でなければ空配列に倒す */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

/** ISO日付（YYYY-MM-DD）は辞書順＝時系列順 */
function maxIso(a: string, b: string): string {
  return a >= b ? a : b
}

/** [fromIso, toIso] の全日付を新しい順に並べる */
function dayRange(fromIso: string, toIso: string): string[] {
  if (!fromIso || !toIso || fromIso > toIso) return []
  const out: string[] = []
  let cur = toIso
  for (let i = 0; i < RANGE_HARD_CAP && cur >= fromIso; i++) {
    out.push(cur)
    cur = addDays(cur, -1)
  }
  return out
}

/** timestamptz → 端末ローカル日付。解釈できない値は null（＝継続中扱い＝表示を消さない側に倒す） */
function tsToDay(ts: string | null | undefined): string | null {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return isoDate(d)
}

/** 時刻（HH:MM[:SS]）の昇順比較。null は末尾 */
function cmpTime(a: string | null, b: string | null): number {
  const x = a ?? '99:99:99'
  const y = b ?? '99:99:99'
  return x < y ? -1 : x > y ? 1 : 0
}

function slotOrder(s: MealSlot | null | undefined): number {
  switch (s) {
    case 'breakfast':
      return 0
    case 'lunch':
      return 1
    case 'dinner':
      return 2
    case 'snack':
      return 3
    default:
      return 9
  }
}

/** 取得したチャンクに記録が1件も無いか（無限スクロールの打ち切り判定に使う） */
function chunkIsEmpty(chunk: TimelineChunk | null): boolean {
  if (!chunk) return true
  return (
    asArray(chunk.notes).length === 0 &&
    asArray(chunk.vitals).length === 0 &&
    asArray(chunk.meals).length === 0 &&
    asArray(chunk.fluids).length === 0 &&
    asArray(chunk.outings).length === 0 &&
    asArray(chunk.pinned).length === 0
  )
}

/**
 * チャンクを日単位に組み替える（新しい日が先頭）。
 * 記録が無い日も1セクションとして返す（「未取込」「—未測定」を日付ヘッダで表現するため）。
 */
function assembleDays(fromIso: string, toIso: string, chunk: TimelineChunk | null): DayData[] {
  const byDay = new Map<string, DayData>()
  const days: DayData[] = dayRange(fromIso, toIso).map((day) => {
    const d: DayData = {
      day,
      notes: [],
      vitals: [],
      meals: [],
      fluids: [],
      outings: [],
      importDay: null,
      pinned: [],
    }
    byDay.set(day, d)
    return d
  })
  if (!chunk || days.length === 0) return days

  for (const n of asArray<Note>(chunk.notes)) {
    if (!n || typeof n.note_on !== 'string') continue
    byDay.get(n.note_on)?.notes.push(n)
  }
  for (const v of asArray<Vital>(chunk.vitals)) {
    if (!v || typeof v.measured_on !== 'string') continue
    byDay.get(v.measured_on)?.vitals.push(v)
  }
  for (const m of asArray<Meal>(chunk.meals)) {
    if (!m || typeof m.meal_on !== 'string') continue
    byDay.get(m.meal_on)?.meals.push(m)
  }
  for (const f of asArray<FluidIntake>(chunk.fluids)) {
    if (!f || typeof f.taken_on !== 'string') continue
    byDay.get(f.taken_on)?.fluids.push(f)
  }
  for (const o of asArray<Outing>(chunk.outings)) {
    if (!o || typeof o.start_on !== 'string') continue
    // 開始日が範囲外の外出（期間に重なる行）も落とさず、範囲の端の日に寄せる（無言消失を作らない）
    const key = o.start_on < fromIso ? fromIso : o.start_on > toIso ? toIso : o.start_on
    byDay.get(key)?.outings.push(o)
  }
  for (const i of asArray<ImportDay>(chunk.importDays)) {
    if (!i || typeof i.day !== 'string') continue
    const d = byDay.get(i.day)
    if (!d) continue
    // 同じ日に複数ソースがある場合は取込時刻が新しい方を代表にする
    if (!d.importDay || (i.imported_at ?? '') > (d.importDay.imported_at ?? '')) d.importDay = i
  }

  // ピン留め: 期間内に有効な ongoing を、有効な日すべてに複製して持たせる
  const pins = asArray<Note>(chunk.pinned).filter((n) => n && typeof n.note_on === 'string')
  if (pins.length > 0) {
    const endOf = new Map<number, string | null>()
    for (const p of pins) endOf.set(p.id, tsToDay(p.ended_at))
    for (const d of days) {
      d.pinned = pins.filter((p) => {
        if (p.note_on > d.day) return false
        const end = endOf.get(p.id) ?? null
        return end === null || d.day <= end
      })
      d.pinned.sort(
        (a, b) =>
          Number(b.importance === 'critical') - Number(a.importance === 'critical') ||
          (b.note_on < a.note_on ? -1 : b.note_on > a.note_on ? 1 : 0) ||
          b.id - a.id,
      )
    }
  }

  for (const d of days) {
    d.notes.sort((a, b) => cmpTime(a.occurred_at, b.occurred_at) || a.id - b.id)
    d.vitals.sort((a, b) => cmpTime(a.measured_at, b.measured_at) || a.id - b.id)
    d.meals.sort((a, b) => slotOrder(a.meal_slot) - slotOrder(b.meal_slot) || a.id - b.id)
    d.fluids.sort((a, b) => cmpTime(a.taken_at, b.taken_at) || a.id - b.id)
    d.outings.sort((a, b) => cmpTime(a.start_at, b.start_at) || a.id - b.id)
  }
  return days
}

/**
 * 外出・外泊の置き場所を、組み上がった表示ウィンドウ全体で1か所に決め直す。
 * RPC は「期間に重なる」外出（開始が範囲より前・帰着未定を含む）を各チャンクに返すため、
 * 10日ずつ取得すると同じ1件がチャンクごとの端の日へ重ねて置かれる（開始していない日に
 * 開始時刻つきで出る・サマリチップの「外出 n名」も二重計上）。
 * 実際の開始日が窓の中にあればその日へ、窓より前に始まった行だけ窓の端（最も古い日）へ寄せる。
 */
function placeOutings(days: DayData[]): DayData[] {
  if (days.length === 0) return days
  const newest = days[0].day
  const oldest = days[days.length - 1].day
  const byId = new Map<number, Outing>()
  for (const d of days) {
    for (const o of d.outings) if (!byId.has(o.id)) byId.set(o.id, o)
  }
  const placed = new Map<string, Outing[]>()
  for (const o of byId.values()) {
    const key = o.start_on < oldest ? oldest : o.start_on > newest ? newest : o.start_on
    const arr = placed.get(key)
    if (arr) arr.push(o)
    else placed.set(key, [o])
  }
  return days.map((d) => {
    const list = placed.get(d.day) ?? []
    list.sort((a, b) => cmpTime(a.start_at, b.start_at) || a.id - b.id)
    // 変化が無い日はオブジェクトの同一性を保つ（DaySection の memo を無効にしない）
    const same = list.length === d.outings.length && list.every((o, i) => d.outings[i] === o)
    return same ? d : { ...d, outings: list }
  })
}

// ── Realtime の通知から取り直す範囲を決める（F67・純ロジック） ──────────────────

/** 画面に出している行の索引（通知の行が「いま出している行」かを引く） */
export interface TimelineIndex {
  /** 表ごとに、出している行の id → 出している日 */
  shown: Map<string, Map<number, string>>
  /** ピン留めに出している（継続の）申し送りの id。各日に複製されるので、変われば窓全体を取り直す */
  pinned: Set<number>
  /** 申し送りの欄に出している継続（ongoing）の申し送りの id（ピン留めにも複製されうる） */
  ongoing: Set<number>
}

/** 組み上がった日の並びから索引を作る */
export function buildTimelineIndex(days: readonly DayData[]): TimelineIndex {
  const shown = new Map<string, Map<number, string>>()
  const put = (table: string, id: unknown, day: string) => {
    if (typeof id !== 'number') return
    let m = shown.get(table)
    if (!m) {
      m = new Map()
      shown.set(table, m)
    }
    if (!m.has(id)) m.set(id, day)
  }
  const pinned = new Set<number>()
  const ongoing = new Set<number>()
  for (const d of days) {
    for (const n of d.notes) {
      put('notes', n.id, d.day)
      if (n.ongoing === true) ongoing.add(n.id)
    }
    for (const v of d.vitals) put('vitals', v.id, d.day)
    for (const m of d.meals) put('meals', m.id, d.day)
    for (const f of d.fluids) put('fluid_intake', f.id, d.day)
    for (const o of d.outings) put('outings', o.id, d.day)
    for (const p of d.pinned) pinned.add(p.id)
  }
  return { shown, pinned, ongoing }
}

/** 取り直す範囲。'none'＝取り直さない／'all'＝窓全体／日付の並び＝その日を含むチャンクだけ */
export type TimelineReloadScope = 'none' | 'all' | string[]

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
/** 表ごとの「その行が載る日」の列 */
const DAY_COLUMN: Record<string, string> = {
  vitals: 'measured_on',
  meals: 'meal_on',
  fluid_intake: 'taken_on',
  notes: 'note_on',
  import_days: 'day',
}

/**
 * Realtime の通知1件で、どこを取り直すか（F67）。win は表示中の窓（最新側は今日まで伸ばした端）。
 * - 行が分からない通知（物理削除・取り直しの合図 RESYNC・取り出せなかった）は窓全体（分からない＝取り直す側に倒す）
 * - 画面に出している行の変更は、日付に関係なく取り直す（日付を窓の外へ直した変更を取りこぼさない・F16 と同じ考え方）
 * - 外出は期間が窓に重なれば窓全体（チャンクをまたいで1か所に置き直すため）
 * - 継続の申し送り・ピン留めに出している申し送り（とその既読）は窓全体（各日に複製されている）
 * - 既読は、出している申し送りの既読だけ（既読の行には日付が無いので、申し送りの id から日を引く）
 * - それ以外は、行の日が窓の中ならその日（と、出していた日）
 * 自分の書き込み（isSelfWrite）は呼ぶ側で先に除く
 */
export function timelineReloadScope(
  table: string,
  row: Record<string, unknown> | null,
  win: { from: string; to: string } | null,
  idx: TimelineIndex,
): TimelineReloadScope {
  if (!WATCHED_TABLES.has(table)) return 'none'
  if (row === null || win === null) return 'all'
  const inWin = (day: string) => day >= win.from && day <= win.to
  const id = typeof row.id === 'number' ? row.id : Number.NaN
  const shownDay = idx.shown.get(table)?.get(id)
  if (table === 'note_reads') {
    const noteId = typeof row.note_id === 'number' ? row.note_id : Number.NaN
    if (idx.pinned.has(noteId) || idx.ongoing.has(noteId)) return 'all'
    const day = idx.shown.get('notes')?.get(noteId)
    return day === undefined ? 'none' : [day]
  }
  if (table === 'outings') {
    if (shownDay !== undefined) return 'all'
    const start = row.start_on
    const end = row.end_on
    if (typeof start !== 'string' || !DAY_RE.test(start)) return 'all'
    if (end !== null && end !== undefined && (typeof end !== 'string' || !DAY_RE.test(end))) return 'all'
    return start <= win.to && (end == null || end >= win.from) ? 'all' : 'none'
  }
  if (table === 'notes') {
    if (idx.pinned.has(id) || idx.ongoing.has(id) || row.ongoing !== false) {
      // 継続（または継続かどうか分からない）申し送りは、窓より前に始まった分もピン留めに載る
      const on = row.note_on
      if (shownDay !== undefined || idx.pinned.has(id)) return 'all'
      if (typeof on !== 'string' || !DAY_RE.test(on)) return 'all'
      // 窓が始まる前に終わった継続は、窓のどの日にも載らない
      const endDay = typeof row.ended_at === 'string' ? tsToDay(row.ended_at) : null
      if (endDay !== null && endDay < win.from) return 'none'
      return on <= win.to ? 'all' : 'none'
    }
  }
  const col = DAY_COLUMN[table]
  const day = col === undefined ? undefined : row[col]
  if (typeof day !== 'string' || !DAY_RE.test(day)) return 'all'
  const out: string[] = []
  if (inWin(day)) out.push(day)
  if (shownDay !== undefined && shownDay !== day) out.push(shownDay)
  return out.length === 0 ? 'none' : out
}

/** 'YYYY-MM-DD' → 通日（UTC の日数。差を取るためだけに使う） */
function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000)
}

/**
 * 窓 [from, to] を最新側から10日ずつ区切った時に、指定の日を含む区切り（重複なし・新しい順）。
 * loadWindow と同じ区切り方にそろえる（窓の外の日は無視する）
 */
export function chunkRangesFor(from: string, to: string, days: readonly string[]): [string, string][] {
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) return []
  const ks = new Set<number>()
  for (const d of days) {
    if (!DAY_RE.test(d) || d < from || d > to) continue
    ks.add(Math.floor((dayNumber(to) - dayNumber(d)) / CHUNK_DAYS))
  }
  return [...ks]
    .sort((a, b) => a - b)
    .map((k) => {
      const ct = addDays(to, -CHUNK_DAYS * k)
      const cf = maxIso(addDays(ct, -(CHUNK_DAYS - 1)), from)
      return [cf, ct] as [string, string]
    })
}

/**
 * 取り直したチャンクの日（fresh）を窓へ差し替える。取り直していない日はオブジェクトをそのまま使う（DaySection の memo を
 * 効かせる）。取り直した日に載った外出は取り直した方を正とし、他の日の控えから外してから窓全体で置き直す（チャンクを
 * またぐ外出を二重に置かない・placeOutings）
 */
export function mergeChunkDays(days: readonly DayData[], fresh: ReadonlyMap<string, DayData>): DayData[] {
  const freshOutings = new Set<number>()
  for (const d of fresh.values()) for (const o of d.outings) freshOutings.add(o.id)
  const merged = days.map((d) => {
    const f = fresh.get(d.day)
    if (f) return f
    if (!d.outings.some((o) => freshOutings.has(o.id))) return d
    return { ...d, outings: d.outings.filter((o) => !freshOutings.has(o.id)) }
  })
  return placeOutings(merged)
}

// ── フック本体 ───────────────────────────────────────────────

export interface UseTimelineResult {
  days: DayData[]
  loading: boolean
  error: string | null
  loadMore(): void
  hasMore: boolean
  refresh(): void
  /** DOM上限60日で新しい側を外している状態（先頭に「新しい日を再読み込み」バーを出す合図） */
  trimmed: boolean
  resetToLatest(): void
}

export function useTimeline(staffId: number | null): UseTimelineResult {
  const [days, setDays] = useState<DayData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [trimmed, setTrimmed] = useState(false)

  const aliveRef = useRef(true)
  const genRef = useRef(0) // 取得世代。古い応答は破棄する
  const busyRef = useRef(false) // 取得中フラグ（追加ロードの多重起動防止）
  const winRef = useRef<{ from: string; to: string } | null>(null) // 表示ウィンドウ
  const daysRef = useRef<DayData[]>([])
  const trimmedRef = useRef(false)
  const hasMoreRef = useRef(true)
  const emptyStreakRef = useRef(0)
  const staffIdRef = useRef<number | null>(staffId)
  const cacheRef = useRef(new Map<string, DayData>()) // 60日超で外した「新しい側」の控え

  const indexRef = useRef<TimelineIndex | null>(null) // 出している行の索引（通知の判定用・必要になった時に作る）

  const commitDays = useCallback((next: DayData[]) => {
    daysRef.current = next
    indexRef.current = null
    setDays(next)
  }, [])

  /** ウィンドウ末端（最新側）。最新に張り付いている間は日付が変わったら今日まで伸ばす */
  const windowTo = useCallback((w: { from: string; to: string }): string => {
    return trimmedRef.current ? w.to : maxIso(w.to, todayIso())
  }, [])

  /** 表示ウィンドウ [from, to] を10日ずつ取り直して総入れ替えする（初期・再読込・Realtime 共通） */
  const loadWindow = useCallback(
    async (from: string, to: string, silent = false) => {
      const gen = ++genRef.current // 後発が先発を無効化する
      busyRef.current = true
      if (!silent) {
        setLoading(true)
        setError(null)
      }
      const sid = staffIdRef.current
      try {
        const built: DayData[] = []
        let cursorTo = to
        // 新しい側から10日ずつ。ウィンドウ外の日は取りに行かない
        for (let i = 0; i < RANGE_HARD_CAP && cursorTo >= from; i++) {
          const cursorFrom = maxIso(addDays(cursorTo, -(CHUNK_DAYS - 1)), from)
          const chunk = await fetchTimelineChunk(cursorFrom, cursorTo, sid)
          if (gen !== genRef.current || !aliveRef.current) return
          built.push(...assembleDays(cursorFrom, cursorTo, chunk))
          cursorTo = addDays(cursorFrom, -1)
        }
        if (gen !== genRef.current || !aliveRef.current) return
        winRef.current = { from, to }
        // チャンクをまたいで重複した外出を、窓全体で1か所へ置き直してから確定する
        commitDays(placeOutings(built))
        setError(null)
      } catch {
        if (gen !== genRef.current || !aliveRef.current) return
        // 失敗しても取得済みの表示は消さない（原則4: 安全側フォールバック）
        if (!silent) setError(ERR_LOAD)
      } finally {
        if (gen === genRef.current) {
          busyRef.current = false
          // silent でも必ず下ろす。無効化した側（!silent で loading を立てた取得）は
          // gen が進んでいて finally を素通りするため、ここで下ろさないと
          // 「さらに読み込んでいます…」が出たまま追加読み込みが復旧しなくなる
          setLoading(false)
        }
      }
    },
    [commitDays],
  )

  /**
   * 指定の日を含むチャンクだけを取り直して、その日を差し替える（F67。他の日はそのまま）。
   * 日付が変わって窓の最新側の端が動いた時は区切りがずれるので、窓全体を取り直す。取り直せなくても表示は消さない
   */
  const loadDays = useCallback(
    async (dirty: readonly string[]) => {
      const w = winRef.current
      if (!w) return
      const to = windowTo(w)
      if (to !== w.to) {
        void loadWindow(w.from, to, true)
        return
      }
      const ranges = chunkRangesFor(w.from, w.to, dirty)
      if (ranges.length === 0) return
      const gen = ++genRef.current // 後から始めた取得（全体の取り直し・追加読み込み）が来たら、この結果は捨てる
      busyRef.current = true
      const sid = staffIdRef.current
      try {
        const fresh = new Map<string, DayData>()
        for (const [cf, ct] of ranges) {
          const chunk = await fetchTimelineChunk(cf, ct, sid)
          if (gen !== genRef.current || !aliveRef.current) return
          for (const d of assembleDays(cf, ct, chunk)) fresh.set(d.day, d)
        }
        if (gen !== genRef.current || !aliveRef.current) return
        commitDays(mergeChunkDays(daysRef.current, fresh))
      } catch {
        // 取り直せなかっただけ（原則4: 表示中のデータは消さない）。次の通知・再読み込みで取り直す
      } finally {
        if (gen === genRef.current) {
          busyRef.current = false
          setLoading(false)
        }
      }
    },
    [commitDays, loadWindow, windowTo],
  )

  /** 続きの10日（古い側）を追加する */
  const loadMore = useCallback(() => {
    const w = winRef.current
    if (!w || busyRef.current || !hasMoreRef.current) return
    const to = addDays(w.from, -1)
    const from = addDays(to, -(CHUNK_DAYS - 1))
    const gen = ++genRef.current
    busyRef.current = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const chunk = await fetchTimelineChunk(from, to, staffIdRef.current)
        if (gen !== genRef.current || !aliveRef.current) return
        if (chunkIsEmpty(chunk)) {
          emptyStreakRef.current += 1
          if (emptyStreakRef.current >= EMPTY_CHUNK_LIMIT) {
            hasMoreRef.current = false
            setHasMore(false)
          }
        } else {
          emptyStreakRef.current = 0
        }
        // 追記した10日を含めた窓全体で外出を置き直す（チャンク端に寄せた控えを残さない）
        let next = placeOutings(daysRef.current.concat(assembleDays(from, to, chunk)))
        if (next.length > MAX_DAYS) {
          // 上限超過分は新しい側を外す（外した日は控えに残し resetToLatest で戻せるようにする）
          const overflow = next.length - MAX_DAYS
          for (const d of next.slice(0, overflow)) cacheRef.current.set(d.day, d)
          if (cacheRef.current.size > MAX_DAYS) {
            const keys = Array.from(cacheRef.current.keys()).sort().reverse()
            for (const k of keys.slice(MAX_DAYS)) cacheRef.current.delete(k)
          }
          next = next.slice(overflow)
          trimmedRef.current = true
          setTrimmed(true)
        }
        winRef.current = { from, to: next[0]?.day ?? w.to }
        commitDays(next)
      } catch {
        if (gen !== genRef.current || !aliveRef.current) return
        setError(ERR_MORE)
      } finally {
        if (gen === genRef.current) {
          busyRef.current = false
          setLoading(false)
        }
      }
    })()
  }, [commitDays])

  /** 表示中のウィンドウを取り直す */
  const refresh = useCallback(() => {
    const w = winRef.current
    if (!w) {
      const to = todayIso()
      void loadWindow(addDays(to, -(CHUNK_DAYS - 1)), to)
      return
    }
    void loadWindow(w.from, windowTo(w))
  }, [loadWindow, windowTo])

  /** 最新10日へ戻す（控えがあれば即表示し、裏で取り直す） */
  const resetToLatest = useCallback(() => {
    const to = todayIso()
    const from = addDays(to, -(CHUNK_DAYS - 1))
    emptyStreakRef.current = 0
    hasMoreRef.current = true
    setHasMore(true)
    trimmedRef.current = false
    setTrimmed(false)
    const cached = dayRange(from, to).map((d) => cacheRef.current.get(d))
    const restored = cached.every((d): d is DayData => !!d) ? (cached as DayData[]) : null
    if (restored) {
      winRef.current = { from, to }
      commitDays(restored)
    }
    cacheRef.current.clear()
    void loadWindow(from, to, !!restored)
  }, [commitDays, loadWindow])

  // マウント状態（アンマウント後の setState を止める）
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 初回ロード＋操作職員の切替（my_read が変わるためウィンドウを取り直す。位置は保つ）
  useEffect(() => {
    staffIdRef.current = staffId
    const w = winRef.current
    if (w) {
      void loadWindow(w.from, windowTo(w), daysRef.current.length > 0)
    } else {
      const to = todayIso()
      void loadWindow(addDays(to, -(CHUNK_DAYS - 1)), to)
    }
  }, [staffId, loadWindow, windowTo])

  // Realtime: 表示ウィンドウ内の日だけ取り直す（連続通知はまとめる）。自分の書き込み・窓の外の変更は取り直さず、
  // 日が分かる変更はその日を含むチャンクだけを取り直す（F67）。行の分からない通知（RESYNC 等）は窓全体（F14）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    let wantAll = false
    const wantDays = new Set<string>()
    const schedule = () => {
      if (stopped) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (stopped || !aliveRef.current) return
        const w = winRef.current
        if (!w) return
        // 取得中は利用者操作を優先し、あとで取り直す（貯めた範囲はそのまま持ち越す）
        if (busyRef.current) {
          schedule()
          return
        }
        const all = wantAll
        const dirty = [...wantDays]
        wantAll = false
        wantDays.clear()
        if (all) void loadWindow(w.from, windowTo(w), true)
        else if (dirty.length > 0) void loadDays(dirty)
      }, REALTIME_DEBOUNCE_MS)
    }
    let unsub: (() => void) | null = null
    try {
      unsub = subscribeChanges((table, info) => {
        if (typeof table !== 'string' || !WATCHED_TABLES.has(table)) return
        const row = info?.row ?? null
        // この端末が書いて画面に反映済みの行（保存の後は画面が自分で取り直す）
        if (row !== null && isSelfWrite(table, row)) return
        const w = winRef.current
        if (indexRef.current === null) indexRef.current = buildTimelineIndex(daysRef.current)
        const scope = timelineReloadScope(table, row, w ? { from: w.from, to: windowTo(w) } : null, indexRef.current)
        if (scope === 'none') return
        if (scope === 'all') wantAll = true
        else for (const d of scope) wantDays.add(d)
        schedule()
      })
    } catch {
      // 購読できない環境（接続未設定など）でも画面は成立させる
      unsub = null
    }
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (unsub) {
        try {
          unsub()
        } catch {
          /* 解除失敗は表示に影響しないため無視する */
        }
      }
    }
  }, [loadWindow, loadDays, windowTo])

  return { days, loading, error, loadMore, hasMore, refresh, trimmed, resetToLatest }
}
