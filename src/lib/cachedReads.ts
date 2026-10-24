// 読み込みの控え（dataCache.ts）を db.ts の取得関数につなぐ層と、起動後の裏での先読み（2026-10-17 本人依頼
// 「アプリを開いた時点で裏で読み込みを続け、画面を開く時に待ち時間なくデータを見られるように」）。
//
// 画面の使い方（各画面の既存の約束を変えないため、取り直しはこれまでどおり毎回する）:
//   ・peekX(...)   … 古くなっていない控えがあれば即座に返す（無ければ undefined）。画面はこれで先に描く
//   ・fetchX(...)  … db の同じ名前の取得関数と同じ署名（画面は import の元を '../lib/cachedReads' に替えるだけ）。毎回取りに行き（同じキーの取得が走っていれば相乗り。
//                    先読みで取って2秒以内の古くない控えだけは通信せずに使う＝行に触れた直後に開いた時の二重取得を防ぐ）、結果を控える。
//                    中身が控えと同じなら控えの値（同じ参照）を返す＝画面の effect が読み直しを重ねない
//   入力解禁の旗・役割・min_client_build は控えない（前提情報は毎回取り直す）。画面は今までどおり db から直接取る。
//
// 控えを新しく保つ（startCacheSync・App 全体で1本ずつ）:
//   ・変更通知（subscribeChanges・入浴・与薬・事故）の行の日付で当たるキーに「古い」の印。行が分からない・取り直しの合図
//     （RESYNC）は全部を古いに。名簿が変わった合図（subscribeMastersChanged）は名簿のキーを古いに
//   ・この端末の書込（db.subscribeLocalWrites＝版が確定した・送信待ちに積んだ）でも当たるキーを古いに
//   ・体温の変更・取り直しの合図では平熱の控え（db.forgetUsualTemps）も捨てる（今までは起動中ずっと古いままだった）
//
// 先読み（startPrefetch）: 最初の画面が描けて落ち着いてから、名簿 → 今日の要注意 → 日報の今の区切り → バイタル・食事の
//   一覧の既定 → タイムラインの最初の10日・与薬・入浴・事故 → 外部の GAS（排泄・体重）の順に、同時に2本まで。
//   止める条件は dataCache.prefetchAllowed（画面が隠れている・オフライン・データ節約・送信待ちを送っている・ログインしていない・
//   人が画面を触っている〔userActivity・触るのをやめて少し経ったら再開〕）。
//   古いの印が付いたら、少し待ってから同じ順で取り直す（印の無い控えは通信しない）。
//
// 個人情報: 控えはメモリだけ（localStorage・IndexedDB に置かない）。console に出さない。

import * as db from './db'
import {
  forgetUsualTemps,
  isQueueFlushing,
  queueSubscribe,
  subscribeBathChanges,
  subscribeChanges,
  subscribeIncidentChanges,
  subscribeLocalWrites,
  subscribeMastersChanged,
  subscribeMedChanges,
} from './db'
import type { ChangeInfo, DailyReport, IncidentQuery } from './db'
import { changedRowDay, createPrefetchQueue, dataCache, prefetchAllowed } from './dataCache'
import type { CacheMeta, PrefetchTask } from './dataCache'
import { clearExcretionCache, fetchExcretion } from './excretionClient'
import { clearWeightCache, fetchWeights } from './weightClient'
import { addDays, todayIso } from './format'
import { installUserActivity, isUserBusy, onUserQuiet } from './userActivity'
import { defaultIncidentRange } from './incident'
import { LS, SHEET_DAYS } from './types'
// 今日の要注意と同じ日の数え方（日本時間の今日・UTC で数える日の足し引き）。純粋な部品
import { addDaysIso, jstClock } from '../pages/alertsModel'
import type { Resident } from './types'
import { clearDaycareDayMemo } from './daycareDayMemo'
import { clearDaycareHandoff } from './daycareHandoff'

// ── キーと当たり判定の情報 ─────────────────────────────────────────────────

const ROSTER_RES: CacheMeta = { tables: ['residents'] }
const ROSTER_STAFF: CacheMeta = { tables: ['staff'] }
const TIMELINE_TABLES = ['notes', 'vitals', 'meals', 'fluid_intake', 'outings', 'note_reads', 'import_days'] as const
const DAILY_TABLES = ['notes', 'outings', 'vitals', 'attendance', 'note_reads', 'import_days'] as const
const KARTE_TABLES = ['vitals', 'meals', 'fluid_intake', 'notes', 'outings', 'bath_records', 'med_admin', 'incidents'] as const

const idsKey = (rs: readonly Resident[] | undefined): string =>
  rs === undefined ? 'roster' : rs.filter((r) => r.active).map((r) => r.id).join('.')

export const cacheKeys = {
  residents: 'residents',
  allResidents: 'allResidents',
  staff: 'staff',
  allStaff: 'allStaff',
  targets: 'targets',
  /** 個人のバイタルの閾値（段階2d・0045） */
  vitalLimits: 'vitalLimits',
  timeline: (from: string, to: string, staffId: number | null) => `timeline|${from}|${to}|${staffId ?? '-'}`,
  daily: (actorId: number | null, day: string) => `daily|${actorId ?? '-'}|${day}`,
  vitalsSheet: (from: string, to: string) => `vitalsSheet|${from}|${to}`,
  mealsSheet: (from: string, to: string) => `mealsSheet|${from}|${to}`,
  medDay: (day: string) => `medDay|${day}`,
  medSlots: (rs: readonly Resident[] | undefined) => `medSlots|${idsKey(rs)}`,
  medFirstDay: 'medFirstDay',
  bathDay: (day: string) => `bathDay|${day}`,
  bathPlan: (day: string, rs: readonly Resident[] | undefined) => `bathPlan|${day}|${idsKey(rs)}`,
  incidents: (q: IncidentQuery) =>
    `incidents|${q.fromIso}|${q.toIso}|${q.kind ?? '-'}|${q.status ?? '-'}|${q.residentId ?? '-'}`,
  karte: (residentId: number, from: string, to: string) => `karte|${residentId}|${from}|${to}`,
} as const

// ── 名簿・設定 ───────────────────────────────────────────────────────────

export const peekResidents = (): Resident[] | undefined => dataCache.peek(cacheKeys.residents)
/** 在籍の利用者（db.fetchResidents と同じ）。ログインの控えが無い0人は例外（F58）＝控えない */
export const fetchResidents = () =>
  dataCache.fetch(cacheKeys.residents, db.fetchResidents, { meta: ROSTER_RES, storeEmpty: true })

export const peekAllResidents = (): Resident[] | undefined => dataCache.peek(cacheKeys.allResidents)
export const fetchAllResidents = () =>
  dataCache.fetch(cacheKeys.allResidents, db.fetchAllResidents, { meta: ROSTER_RES, storeEmpty: true })

export const peekStaff = () => dataCache.peek<Awaited<ReturnType<typeof db.fetchStaff>>>(cacheKeys.staff)
export const fetchStaff = () => dataCache.fetch(cacheKeys.staff, db.fetchStaff, { meta: ROSTER_STAFF, storeEmpty: true })

export const peekAllStaff = () => dataCache.peek<Awaited<ReturnType<typeof db.fetchAllStaff>>>(cacheKeys.allStaff)
export const fetchAllStaff = () =>
  dataCache.fetch(cacheKeys.allStaff, db.fetchAllStaff, { meta: ROSTER_STAFF, storeEmpty: true })

export const peekResidentTargets = () =>
  dataCache.peek<Awaited<ReturnType<typeof db.fetchResidentTargets>>>(cacheKeys.targets)
/** 個別の目標（表が無い DB・ログインの控えが無い時の空は控えない） */
export const fetchResidentTargets = () =>
  dataCache.fetch(cacheKeys.targets, db.fetchResidentTargets, { meta: { tables: ['resident_targets'] } })

export const peekResidentVitalLimits = () =>
  dataCache.peek<Awaited<ReturnType<typeof db.fetchResidentVitalLimits>>>(cacheKeys.vitalLimits)
/** 個人のバイタルの閾値（段階2d・0045。表が無い DB は missing＝全員が施設の基準。書いた後は notifyLocalWrite で古いにする） */
export const fetchResidentVitalLimits = () =>
  dataCache.fetch(cacheKeys.vitalLimits, db.fetchResidentVitalLimits, { meta: { tables: ['resident_vital_limits'] } })

// ── 記録 ─────────────────────────────────────────────────────────────────

const timelineOpts = (from: string, to: string) => ({
  meta: { tables: TIMELINE_TABLES, from, to, notesUpTo: true },
  storeEmpty: true, // timeline_chunk はログインの控えが無い空を例外にする（F58）
  isEmpty: () => false,
})
export const peekTimelineChunk = (from: string, to: string, staffId: number | null) =>
  dataCache.peek<Awaited<ReturnType<typeof db.fetchTimelineChunk>>>(cacheKeys.timeline(from, to, staffId))
export const fetchTimelineChunk = (from: string, to: string, staffId: number | null) =>
  dataCache.fetch(cacheKeys.timeline(from, to, staffId), () => db.fetchTimelineChunk(from, to, staffId), timelineOpts(from, to))

const dailyOpts = (day: string) => ({
  meta: { tables: DAILY_TABLES, from: day, to: day },
  storeEmpty: true, // db.fetchDailyReports はログインの控えが無い0件を例外にする（F58）
  isEmpty: () => false,
})
/** 日報の1日ぶんの控え（古くなっていない時だけ）。記録者ごとに別のキー（既読の見え方が違う） */
export const peekDailyReport = (actorId: number | null, day: string): DailyReport | undefined =>
  dataCache.peek(cacheKeys.daily(actorId, day))
/** 日報のまとめ取り（db.fetchDailyReports と同じ）。各日の結果を控える */
export async function fetchDailyReports(days: readonly string[], actorId: number | null): Promise<Map<string, DailyReport>> {
  const list = [...new Set(days)].sort()
  const keyOf = new Map(list.map((d) => [cacheKeys.daily(actorId, d), d]))
  const got = await dataCache.fetchGroup(
    `daily|${actorId ?? '-'}|${list.join(',')}`,
    [...keyOf.keys()],
    async () => {
      const m = await db.fetchDailyReports(list, actorId)
      const out = new Map<string, DailyReport>()
      for (const [d, r] of m) out.set(cacheKeys.daily(actorId, d), r)
      return out
    },
    (key) => dailyOpts(keyOf.get(key) ?? ''),
  )
  const out = new Map<string, DailyReport>()
  for (const [k, r] of got) {
    const d = keyOf.get(k)
    if (d !== undefined) out.set(d, r)
  }
  return out
}
/** 画面が自分の書込・変更通知で捨てた日（日報の取り置きと食い違わないように、控えにも古いの印を付ける） */
export function markDailyStale(day: string | null): void {
  dataCache.markStaleWhere((k) => k.startsWith('daily|') && (day === null || k.endsWith(`|${day}`)))
}

const vitalsOpts = (from: string, to: string) => ({ meta: { tables: ['vitals'], from, to }, storeEmpty: true })
export const peekVitalsSheet = (from: string, to: string) =>
  dataCache.peek<Awaited<ReturnType<typeof db.fetchVitalsSheet>>>(cacheKeys.vitalsSheet(from, to))
export const fetchVitalsSheet = (from: string, to: string) =>
  dataCache.fetch(cacheKeys.vitalsSheet(from, to), () => db.fetchVitalsSheet(from, to), vitalsOpts(from, to))

const mealsOpts = (from: string, to: string) => ({
  meta: { tables: ['meals', 'fluid_intake'], from, to },
  storeEmpty: true,
  isEmpty: () => false,
})
export const peekMealsSheet = (from: string, to: string) =>
  dataCache.peek<Awaited<ReturnType<typeof db.fetchMealsSheet>>>(cacheKeys.mealsSheet(from, to))
export const fetchMealsSheet = (from: string, to: string) =>
  dataCache.fetch(cacheKeys.mealsSheet(from, to), () => db.fetchMealsSheet(from, to), mealsOpts(from, to))

export const peekMedDay = (day: string) => dataCache.peek<Awaited<ReturnType<typeof db.fetchMedDay>>>(cacheKeys.medDay(day))
export const fetchMedDay = (day: string) =>
  dataCache.fetch(cacheKeys.medDay(day), () => db.fetchMedDay(day), {
    meta: { tables: ['med_admin'], from: day, to: day },
    storeEmpty: true, // db.fetchMedDay はログインの控えが無い0件を例外にする（F58）
  })
export const peekMedSlots = (rs: readonly Resident[] | undefined) =>
  dataCache.peek<Awaited<ReturnType<typeof db.fetchMedSlots>>>(cacheKeys.medSlots(rs))
export const fetchMedSlots = (rs?: Resident[]) =>
  dataCache.fetch(cacheKeys.medSlots(rs), () => db.fetchMedSlots(rs), { meta: { tables: ['med_slots'] } })
export const peekMedFirstDay = (): string | null | undefined => dataCache.peek(cacheKeys.medFirstDay)
export const fetchMedFirstDay = () =>
  dataCache.fetch(cacheKeys.medFirstDay, db.fetchMedFirstDay, { meta: { tables: ['med_admin'] } })

export const peekBathDay = (day: string) => dataCache.peek<Awaited<ReturnType<typeof db.fetchBathDay>>>(cacheKeys.bathDay(day))
export const fetchBathDay = (day: string) =>
  dataCache.fetch(cacheKeys.bathDay(day), () => db.fetchBathDay(day), {
    meta: { tables: ['bath_records'], from: day, to: day },
    storeEmpty: true, // db.fetchBathDay はログインの控えが無い0件を例外にする（F58）
  })
export const peekBathPlan = (day: string, rs: readonly Resident[] | undefined) =>
  dataCache.peek<Awaited<ReturnType<typeof db.fetchBathPlan>>>(cacheKeys.bathPlan(day, rs))
/** 入浴の予定（写しが無い・読めない＝available が false の結果は控えない） */
export const fetchBathPlan = (day: string, rs?: Resident[]) =>
  dataCache.fetch(cacheKeys.bathPlan(day, rs), () => db.fetchBathPlan(day, rs), {
    meta: { tables: ['residents'] },
    isEmpty: (p) => p.available !== true,
  })

export const peekIncidents = (q: IncidentQuery) => dataCache.peek<Awaited<ReturnType<typeof db.fetchIncidents>>>(cacheKeys.incidents(q))
/** 事故・ヒヤリハットの一覧（空の一覧は控えない＝ログインの控えが無い0件を控えない・F58） */
export const fetchIncidents = (q: IncidentQuery) =>
  dataCache.fetch(cacheKeys.incidents(q), () => db.fetchIncidents(q), {
    // 発生日を期間の外へ直した変更でも当たるよう、期間を持たせない（事故の変更は事故の控え全部を古いに）
    meta: { tables: ['incidents'] },
  })

export const peekKarte = (residentId: number, from: string, to: string) =>
  dataCache.peek<Awaited<ReturnType<typeof db.fetchKarte>>>(cacheKeys.karte(residentId, from, to))
/** 1人のカルテ（全部の系列が空の結果は控えない＝ログインの控えが無い0件を控えない・F58） */
export const fetchKarte = (residentId: number, from: string, to: string) =>
  dataCache.fetch(cacheKeys.karte(residentId, from, to), () => db.fetchKarte(residentId, from, to), {
    meta: { tables: KARTE_TABLES, from, to },
    isEmpty: (k) => Object.values(k).every((v) => !Array.isArray(v) || v.length === 0),
  })

// ── 控えを新しく保つ ────────────────────────────────────────────────────

/** 日付で当てると取りこぼす表（日付の列を書き換えられる・期間で出る）。変更は控え全部を古いにする */
const DATE_MOVES = new Set(['outings', 'incidents'])

/** 変更通知・自分の書込を控えの印へ写す（試験から呼べるよう関数にしておく） */
export function applyChange(table: string, info: Pick<ChangeInfo, 'event' | 'row'> | undefined): void {
  if (info?.event === 'RESYNC') {
    dataCache.markAllStale()
    forgetUsualTemps()
    fullStalePending = true
    return
  }
  const row = info?.row ?? null
  const day = DATE_MOVES.has(table) ? null : changedRowDay(table, row)
  // 日報が載せるバイタルは発熱者・他症状者（observation・symptom）だけ。定時・再検の変更では日報の控えを古くしない
  const vitalOnlySheet = table === 'vitals' && (row?.kind === 'routine' || row?.kind === 'recheck')
  if (vitalOnlySheet) dataCache.markStale(table, day, (key) => key.startsWith('daily|'))
  else dataCache.markStale(table, day)
  // 体温（定時）の変更は平熱（30日の中央値）を変える。どの日の平熱に当たるかは数えず全部捨てる（次に読む時に1回取り直す）
  if (table === 'vitals' && (row === null || row.kind === 'routine' || row.kind === undefined)) forgetUsualTemps()
}

/**
 * App 全体で1本ずつ変更通知を受け、控えに印を付ける。戻り値で外す（ログアウト・画面を閉じる時）
 */
export function startCacheSync(): () => void {
  const onChange = (table: string, info?: ChangeInfo) => applyChange(table, info)
  const offs = [
    subscribeChanges(onChange),
    subscribeBathChanges(onChange),
    subscribeMedChanges(onChange),
    subscribeIncidentChanges(onChange),
    subscribeLocalWrites((table, row) => applyChange(table, { event: 'LOCAL', row })),
    subscribeMastersChanged(() => {
      dataCache.markStale('residents', null)
      dataCache.markStale('staff', null)
    }),
  ]
  return () => {
    for (const off of offs) {
      try {
        off()
      } catch {
        // 解除できなくても画面は止めない
      }
    }
  }
}

/** 控えを全部捨てる（ログアウト・記録者の変更・ログインのし直し）。外部 GAS の控えと平熱も捨てる */
export function resetDataCache(): void {
  dataCache.clearAll()
  clearDaycareDayMemo()
  // デイから排泄ケアアプリへの受け渡し（su_daycare_handoff_v1）も消す（次にログインした人へ前の一覧を渡さない＝§9.7）
  clearDaycareHandoff()
  forgetUsualTemps()
  clearExcretionCache()
  clearWeightCache()
}

// ── 先読み ──────────────────────────────────────────────────────────────

/** 日報の10日区切り（DailySheetPage の blockDays と同じ規則: 1〜10 / 11〜20 / 21〜月末） */
export function dailyBlockDays(iso: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return [iso]
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7))
  const d = Number(iso.slice(8, 10))
  const last = new Date(y, m, 0).getDate()
  if (!Number.isFinite(last) || last < 28) return [iso]
  const start = d <= 10 ? 1 : d <= 20 ? 11 : 21
  const end = start === 21 ? last : start + 9
  const out: string[] = []
  for (let i = start; i <= end; i++) out.push(`${y}-${String(m).padStart(2, '0')}-${String(i).padStart(2, '0')}`)
  return out
}

/** 一覧の表示の日数（components/sheet.tsx の readSheetPref と同じ形の値を読む。読めない・未知は既定） */
function readSheetDays(scope: 'v' | 'm' | 'd'): string | null {
  try {
    const raw = window.localStorage.getItem(LS.sheetDays)
    if (raw === null) return null
    for (const part of raw.split('|')) {
      const i = part.indexOf(':')
      if (i > 0 && part.slice(0, i) === scope) return part.slice(i + 1)
    }
    return null
  } catch {
    return null
  }
}
function sheetDaysOr(scope: 'v' | 'm', fallback: number): number {
  const n = Number(readSheetDays(scope))
  return (SHEET_DAYS as readonly number[]).includes(n) ? n : fallback
}

/** 日本時間の今日（今日の要注意と同じ数え方） */
function jstToday(now: number): string {
  return jstClock(now)?.day ?? todayIso()
}

export interface PrefetchContext {
  /** 記録者（日報・タイムラインの既読の見え方が変わる） */
  actorId: number | null
}

/** 先読みの仕事の並び（spec の順）。古くなっていない控えは ensure が通信しない */
export function prefetchPlan(ctx: PrefetchContext): PrefetchTask[] {
  const today = todayIso()
  const jToday = jstToday(Date.now())
  const tasks: PrefetchTask[] = []
  const add = (name: string, run: () => Promise<unknown>) => tasks.push({ name, run })
  const ensure = <T>(key: string, fn: () => Promise<T>, opts: Parameters<typeof dataCache.ensure<T>>[2]) => () =>
    dataCache.ensure(key, fn, opts)

  // 1. 名簿・基準値・個別の目標・平熱（今日）
  add('residents', ensure(cacheKeys.residents, db.fetchResidents, { meta: ROSTER_RES, storeEmpty: true }))
  add('staff', ensure(cacheKeys.staff, db.fetchStaff, { meta: ROSTER_STAFF, storeEmpty: true }))
  add('allResidents', ensure(cacheKeys.allResidents, db.fetchAllResidents, { meta: ROSTER_RES, storeEmpty: true }))
  add('allStaff', ensure(cacheKeys.allStaff, db.fetchAllStaff, { meta: ROSTER_STAFF, storeEmpty: true }))
  add('thresholds', () => db.loadVitalThresholds())
  add('targets', ensure(cacheKeys.targets, db.fetchResidentTargets, { meta: { tables: ['resident_targets'] } }))
  add('usual', () => db.fetchUsualTemps(jToday))
  if (jToday !== today) add('usualLocal', () => db.fetchUsualTemps(today))

  // 2. 今日の要注意の材料（7日の timeline_chunk・与薬の今日・時間帯・初日）
  const aFrom = addDaysIso(jToday, -6) // AlertsPage の MEAL_DAYS（7日）と同じ
  add('alertsChunk', ensure(cacheKeys.timeline(aFrom, jToday, null), () => db.fetchTimelineChunk(aFrom, jToday, null), timelineOpts(aFrom, jToday)))
  add('medDay', ensure(cacheKeys.medDay(jToday), () => db.fetchMedDay(jToday), {
    meta: { tables: ['med_admin'], from: jToday, to: jToday },
    storeEmpty: true,
  }))
  add('medSlots', async () => {
    const rs = dataCache.peek<Resident[]>(cacheKeys.residents)
    if (rs === undefined) return false
    return dataCache.ensure(cacheKeys.medSlots(rs), () => db.fetchMedSlots(rs), { meta: { tables: ['med_slots'] } })
  })
  add('medFirstDay', ensure(cacheKeys.medFirstDay, db.fetchMedFirstDay, { meta: { tables: ['med_admin'] } }))

  // 3. 日報の今の区切り（10日まとめ取り。記録者ごとのキー）。1日表示の端末は今日だけ
  const unit = readSheetDays('d') === '1' ? '1' : '10'
  const dDays = unit === '1' ? [today] : dailyBlockDays(today)
  add('daily', async () => {
    const want = dDays.filter((d) => peekDailyReport(ctx.actorId, d) === undefined)
    if (want.length === 0) return false
    await fetchDailyReports(want.length === dDays.length ? dDays : want, ctx.actorId)
    return true
  })

  // 4. バイタル一覧の既定（4日＋線の7日）・食事一覧の既定（11日＋前の7日）
  const vDays = sheetDaysOr('v', 4)
  const vFrom = addDays(today, -(vDays - 1))
  add('vitalsSheet', ensure(cacheKeys.vitalsSheet(vFrom, today), () => db.fetchVitalsSheet(vFrom, today), vitalsOpts(vFrom, today)))
  const sparkFrom = addDays(today, -6)
  if (sparkFrom < vFrom) {
    const sTo = addDays(vFrom, -1)
    add('vitalsSpark', ensure(cacheKeys.vitalsSheet(sparkFrom, sTo), () => db.fetchVitalsSheet(sparkFrom, sTo), vitalsOpts(sparkFrom, sTo)))
  }
  const mDays = sheetDaysOr('m', 11)
  const mFrom = addDays(today, -(mDays - 1))
  add('mealsSheet', ensure(cacheKeys.mealsSheet(mFrom, today), () => db.fetchMealsSheet(mFrom, today), mealsOpts(mFrom, today)))
  const pFrom = addDays(mFrom, -7)
  const pTo = addDays(mFrom, -1)
  add('mealsPrior', ensure(cacheKeys.mealsSheet(pFrom, pTo), () => db.fetchMealsSheet(pFrom, pTo), mealsOpts(pFrom, pTo)))

  // 5. タイムラインの最初の10日・与薬の今日・入浴の今日と予定・事故の一覧（既定の期間）
  const tFrom = addDays(today, -9)
  add('timeline', ensure(cacheKeys.timeline(tFrom, today, ctx.actorId), () => db.fetchTimelineChunk(tFrom, today, ctx.actorId), timelineOpts(tFrom, today)))
  if (today !== jToday) {
    add('medDayLocal', ensure(cacheKeys.medDay(today), () => db.fetchMedDay(today), {
      meta: { tables: ['med_admin'], from: today, to: today },
      storeEmpty: true,
    }))
  }
  add('medSlotsAll', async () => {
    const all = dataCache.peek<Resident[]>(cacheKeys.allResidents)
    if (all === undefined) return false
    const act = all.filter((r) => r.active)
    return dataCache.ensure(cacheKeys.medSlots(act), () => db.fetchMedSlots(act), { meta: { tables: ['med_slots'] } })
  })
  add('bathDay', ensure(cacheKeys.bathDay(today), () => db.fetchBathDay(today), {
    meta: { tables: ['bath_records'], from: today, to: today },
    storeEmpty: true,
  }))
  add('bathPlan', async () => {
    const all = dataCache.peek<Resident[]>(cacheKeys.allResidents)
    if (all === undefined) return false
    const act = all.filter((r) => r.active)
    return dataCache.ensure(cacheKeys.bathPlan(today, act), () => db.fetchBathPlan(today, act), {
      meta: { tables: ['residents'] },
      isEmpty: (p) => p.available !== true,
    })
  })
  const inc = defaultIncidentRange(today)
  const iq: IncidentQuery = { fromIso: inc.from, toIso: inc.to, kind: null, status: null }
  add('incidents', ensure(cacheKeys.incidents(iq), () => db.fetchIncidents(iq), { meta: { tables: ['incidents'] } }))

  // 6. 外部 GAS（排泄・体重）は最後（重い）。それぞれの部品がメモリに数分持つ（接続設定の無い端末は通信しない）
  add('excretion', () => fetchExcretion())
  add('weights', () => fetchWeights([]))
  return tasks
}

/** 送信待ちを送っている間、先読みを始めてよいかを見直す間隔（ms） */
const SEND_RECHECK_MS = 2_000

/** 印が付いてから取り直しを始めるまでの待ち（続けて届く変更をまとめる） */
const REFRESH_DEBOUNCE_MS = 3_000
/**
 * 古くなった控えの取り直しの間隔の下限（ms）。記録が続けて入る時間帯（朝のバイタル等）に、変更のたびに7日・10日の
 * まとめ取りを取り直して通信量を増やさない（取り直す前に画面を開いた時は、画面が今までどおり自分で取る）
 */
export const REFRESH_MIN_INTERVAL_MS = 60_000
/**
 * 全部が古くなった時（RESYNC＝画面復帰・再接続・電波復帰）の取り直しの間隔の下限（ms）。iPhone は画面を開くたびに
 * 復帰の合図が出るので、そのたびに全部（約27要求・非圧縮で約2MB）を取り直さない。古い控えは画面を開いた時に
 * 画面が自分で取り直す（先に描いて裏で差し替える）ので、ここを長くしても古いまま見せ続けることはない
 */
export const FULL_REFRESH_MIN_INTERVAL_MS = 10 * 60_000
/** RESYNC で全部が古くなった後、まだ取り直していない */
let fullStalePending = false

/** 取り直しを始める時刻（純関数・試験用）。最後に取り直した時刻から間隔の下限を空け、印から少し待つ */
export function nextRefreshAt(now: number, lastRefreshAt: number | null, full = false): number {
  const debounced = now + REFRESH_DEBOUNCE_MS
  if (lastRefreshAt === null) return debounced
  return Math.max(debounced, lastRefreshAt + (full ? FULL_REFRESH_MIN_INTERVAL_MS : REFRESH_MIN_INTERVAL_MS))
}

export interface PrefetchController {
  stop(): void
  /** 先読みが終わった仕事・失敗の数（計測用） */
  stats(): { done: number; failed: number; waiting: number; running: number }
}

/**
 * 裏での先読みを始める（App が最初の画面を描いて落ち着いた後に呼ぶ）。
 * 戻り値の stop で止める（ログアウト・記録者が変わった時は止めて、控えを捨ててから始め直す）
 */
export function startPrefetch(ctx: PrefetchContext): PrefetchController {
  let alive = true
  /** 送信待ちを送り終えるのを待って見直す時計（送信の終わりは合図が無いので、送っている間だけ少しずつ見直す） */
  let sendWait: ReturnType<typeof setTimeout> | null = null
  const canRun = (): boolean => {
    if (!alive) return false
    const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { connection?: { saveData?: boolean } })
    let sending = false
    try {
      sending = isQueueFlushing()
    } catch {
      sending = false
    }
    if (sending && sendWait === null) {
      sendWait = setTimeout(() => {
        sendWait = null
        if (alive) queue.kick()
      }, SEND_RECHECK_MS)
    }
    return prefetchAllowed({
      visible: typeof document === 'undefined' || document.visibilityState === 'visible',
      online: nav === null || nav.onLine !== false,
      saveData: nav?.connection?.saveData === true,
      sending,
      signedIn: true, // App はログインしている間だけ呼ぶ（ログアウトで stop）
      busy: isUserBusy(),
    })
  }
  installUserActivity()
  const queue = createPrefetchQueue({ concurrency: 2, canRun })
  queue.push(prefetchPlan(ctx))

  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  /** 最後に取り直しを積んだ時刻（起動時の先読みも数える） */
  let lastRefreshAt: number | null = Date.now()
  const offStale = dataCache.onStale(() => {
    if (!alive) return
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    const now = Date.now()
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (!alive) return
      lastRefreshAt = Date.now()
      fullStalePending = false
      queue.push(prefetchPlan(ctx))
    }, Math.max(0, nextRefreshAt(now, lastRefreshAt, fullStalePending) - now))
  })
  const kick = (): void => queue.kick()
  const onVis = (): void => {
    if (document.visibilityState === 'visible') kick()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
  if (typeof window !== 'undefined') window.addEventListener('online', kick)
  // 送信待ちの数が変わった（送れた・積んだ）時に見直す（送っている間は止めている＝再送を邪魔しない）
  const offQueue = queueSubscribe(() => kick())
  // 触るのをやめたら、触っている間に止めた先読みを再開する
  const offQuiet = onUserQuiet(kick)

  return {
    stop() {
      alive = false
      queue.clear()
      offStale()
      offQueue()
      offQuiet()
      if (refreshTimer !== null) clearTimeout(refreshTimer)
      if (sendWait !== null) clearTimeout(sendWait)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
      if (typeof window !== 'undefined') window.removeEventListener('online', kick)
    },
    stats() {
      return { ...queue.stats(), ...queue.size() }
    },
  }
}

/** カルテの一覧で行に指が触れた時の先読み（その方のカルテ。同じ方を続けて触っても1回） */
export function prefetchKarte(residentId: number, from: string, to: string): void {
  void dataCache
    .ensure(cacheKeys.karte(residentId, from, to), () => db.fetchKarte(residentId, from, to), {
      meta: { tables: KARTE_TABLES, from, to },
      isEmpty: (k) => Object.values(k).every((v) => !Array.isArray(v) || v.length === 0),
    })
    .catch(() => undefined)
}
