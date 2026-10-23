// デイ（せせらぎ）段階3b: 個別機能訓練の期限の計算（純ロジック・2026-10-23 追加・代表承認・段階3の計画 2章）。
// 計画書アプリ（training-plan.html の addMonthsClamp・addDays・nextDueOf・dueState・buildAlerts）と同じ答えを返す形で移した
// （計画書アプリの関数は変えない）。期待値は検証計画 v2 の 3.6 の表（試験で全行を固定）。
//
// ・居宅訪問の期限は、その方の直近の訪問日から毎回数える（前の期限に積み上げない＝計画 2.2・質問1）
// ・期限の状態は保存しない（日をまたぐと変わる）。表示の時に「終了 → 計画なし → dueState」の順で出す（計画 0章の4）
// ・「今日」は呼び出し側が日本時間の日付で渡す（この部品の中で時刻を読まない）
// 端末に何も残さない（localStorage を使わない）。

/** 期限の規則（計画書アプリの DUE_RULES と同じ）。calendar＝暦の月で3か月・応当日が無ければ月末／days90＝90日／min＝早い方 */
export type DueRule = 'calendar' | 'days90' | 'min'
export const DUE_RULES: readonly DueRule[] = ['calendar', 'days90', 'min']
/** 期限の状態。ok＝期限内／warn＝間近（期限の当日を含む）／overdue＝期限切れ（翌日から）／none＝計画なし／ended＝終了 */
export type DueState = 'ok' | 'warn' | 'overdue' | 'none' | 'ended'

/** 期限までの月数・日数（計画書アプリの PLAN_MONTHS・PLAN_DAYS） */
const PLAN_MONTHS = 3
const PLAN_DAYS = 90
/** 間近の既定（期限の28日前から） */
export const DEFAULT_WARN_DAYS = 28

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function daysInMonth(y: number, m: number): number {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const fmtYmd = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`

/** 'YYYY-MM-DD' → {y,m,d}。実在しない日付（2月30日など）・形の違う値は null */
export function parseYmd(v: unknown): { y: number; m: number; d: number } | null {
  if (typeof v !== 'string') return null
  const mt = YMD_RE.exec(v)
  if (!mt) return null
  const y = Number(mt[1])
  const m = Number(mt[2])
  const d = Number(mt[3])
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null
  return { y, m, d }
}

export const isYmd = (v: unknown): v is string => parseYmd(v) !== null

/** 暦の月の加算。応当日が無い月は月末へ丸める（1/31 の3か月後は 4/30、11/30 の3か月後は 2/28）。不正な日付は '' */
export function addMonthsClamp(ymd: string, months: number): string {
  const p = parseYmd(ymd)
  if (!p) return ''
  const total = p.y * 12 + (p.m - 1) + (Number(months) || 0)
  let y = Math.floor(total / 12)
  let m = (total % 12) + 1
  if (m <= 0) {
    m += 12
    y -= 1
  }
  return fmtYmd(y, m, Math.min(p.d, daysInMonth(y, m)))
}

/** 日の加算（UTC で数える＝端末の時間帯に左右されない）。不正な日付は '' */
export function addDays(ymd: string, days: number): string {
  const p = parseYmd(ymd)
  if (!p) return ''
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d) + (Number(days) || 0) * 86400000)
  return fmtYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/** a − b の日数。どちらかが不正なら null */
export function diffDays(a: string, b: string): number | null {
  const pa = parseYmd(a)
  const pb = parseYmd(b)
  if (!pa || !pb) return null
  return Math.round((Date.UTC(pa.y, pa.m - 1, pa.d) - Date.UTC(pb.y, pb.m - 1, pb.d)) / 86400000)
}

/** 規則をそろえる（知らない値は暦の月） */
export function normalizeDueRule(v: unknown): DueRule {
  return typeof v === 'string' && (DUE_RULES as readonly string[]).includes(v) ? (v as DueRule) : 'calendar'
}

/**
 * 間近の日数をそろえる（0〜365 の整数。負・範囲の外・数でない・null は 28）。
 * 計画書アプリは Number(null)＝0 になるが、写しの設定の行が無い時は既定の28日とする（計画 3.3「行が無い時は暦の月・28日」）
 */
export function normalizeWarnDays(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 365) return DEFAULT_WARN_DAYS
  return Math.round(v)
}

/** 次の期限（起算日から。規則は暦の月・90日・早い方）。起算日が不正なら '' */
export function nextDueOf(base: string, rule: unknown): string {
  if (!isYmd(base)) return ''
  const r = normalizeDueRule(rule)
  const cal = addMonthsClamp(base, PLAN_MONTHS)
  const d90 = addDays(base, PLAN_DAYS)
  if (r === 'days90') return d90
  if (r === 'min') return cal <= d90 ? cal : d90
  return cal
}

/** 期限の状態。warnDays 日前から warn（既定28日前）。期限の当日は warn（期限切れではない）。期限が不正・空なら none */
export function dueState(nextDue: string, today: string, warnDays: unknown): Exclude<DueState, 'ended'> {
  if (!isYmd(nextDue)) return 'none'
  const d = diffDays(nextDue, today)
  if (d === null) return 'none'
  const w = normalizeWarnDays(warnDays)
  if (d < 0) return 'overdue'
  if (d <= w) return 'warn'
  return 'ok'
}

// ── 居宅訪問の期限（段階3b・計画 2.2） ─────────────────────────────────────────

/** 期限の一覧に使う居宅訪問（db.ts の DaycareHomeVisit から必要な分だけ） */
export interface DueVisit {
  id: number
  resident_id: number
  visited_on: string
  explained_to: string | null
  explained_on: string | null
}

/** 計画書の期限の写し（1人1行。3b では読むだけ。書くのは 3c の事務所の PC） */
export interface DueCopyRow {
  resident_id: number
  latest_plan_date: string | null
  next_due: string | null
  stop_reason: string | null
  stop_from: string | null
}

/** 写しの設定（規則・間近の日数）。行が無い時は null（暦の月・28日として数える） */
export interface DueCopySettings {
  due_rule: string
  warn_days: number
  synced_at: string | null
}

/** 期限の一覧の対象の方（名簿から。在籍でない方は「終了」） */
export interface DuePerson {
  id: number
  active: boolean
}

/** 説明の記録があるか（相手と日の両方。片方だけは「説明の記録なし」＝計画 3.2） */
export const hasExplanation = (v: Pick<DueVisit, 'explained_to' | 'explained_on'>): boolean =>
  v.explained_to !== null && v.explained_to !== '' && isYmd(v.explained_on)

/** その方の直近の居宅訪問（訪問日の新しい順・同じ日は番号の大きい方） */
export function latestVisit<T extends DueVisit>(visits: readonly T[], residentId: number): T | null {
  let best: T | null = null
  for (const v of visits) {
    if (v.resident_id !== residentId || !isYmd(v.visited_on)) continue
    if (best === null || v.visited_on > best.visited_on || (v.visited_on === best.visited_on && v.id > best.id)) best = v
  }
  return best
}

/** 通知を止める理由（計画書アプリの normalizeStop と同じ3つ） */
const STOP_REASONS: readonly string[] = ['discharge', 'stopped', 'notNeeded']

/**
 * 終了か（在籍でない・写しの通知を止めた日が今日以前）。計画書アプリの buildAlerts と同じ（写しの行がある時だけ止めた日を見る）。
 * 止めた日は、理由が3つのどれかの時だけ見る（計画書アプリの normalizeStop・stopActiveOn と同じ。理由の無い止めた日で
 * 期限切れの方を一覧から隠さない＝段階3b の反証 軽4）
 */
export function isEnded(person: DuePerson | undefined, copy: DueCopyRow | undefined, today: string): boolean {
  if (person !== undefined && !person.active) return true
  return copy !== undefined && copy.stop_reason !== null && STOP_REASONS.includes(copy.stop_reason) && isYmd(copy.stop_from) && copy.stop_from <= today
}

/** 居宅訪問の期限の1行 */
export interface HomeVisitDueRow {
  residentId: number
  /** 直近の訪問（無ければ null＝「居宅訪問の記録なし」） */
  visit: DueVisit | null
  /** 次の期限（訪問が無ければ ''） */
  due: string
  /** 状態（訪問が無い方は none） */
  state: Exclude<DueState, 'ended'>
  /** 直近の訪問に説明の記録（相手と日）が無い */
  noExplanation: boolean
}

/**
 * 居宅訪問の期限の一覧（計画 2.2）。並びは 期限切れ → 間近 → 記録なし → 期限内（同じ状態の中は期限の早い順・番号順）。
 * ・訪問の記録がある方: 直近の訪問日から規則で数える（毎回その訪問日から＝積み上げない）
 * ・訪問の記録が無い方: 写しで計画がある（作成日がある）方だけ「記録なし」として出す。写しが無い方は出さない
 * ・終了の方（在籍でない・写しの通知を止めた日が今日以前）は出さない
 * people に無い方（名簿から外れた方）は在籍として扱う（名簿を読めなかった時に全員を消さない）
 */
export function homeVisitDueList(args: {
  visits: readonly DueVisit[]
  copy: readonly DueCopyRow[]
  settings: DueCopySettings | null
  people: readonly DuePerson[]
  today: string
}): HomeVisitDueRow[] {
  const { visits, copy, settings, people, today } = args
  const rule = normalizeDueRule(settings?.due_rule)
  const warn = normalizeWarnDays(settings?.warn_days)
  const personOf = new Map(people.map((p) => [p.id, p]))
  const copyOf = new Map(copy.map((c) => [c.resident_id, c]))
  const ids = new Set<number>()
  for (const v of visits) ids.add(v.resident_id)
  for (const c of copy) if (isYmd(c.latest_plan_date)) ids.add(c.resident_id)
  const out: HomeVisitDueRow[] = []
  for (const rid of ids) {
    if (isEnded(personOf.get(rid), copyOf.get(rid), today)) continue
    const v = latestVisit(visits, rid)
    if (v === null) {
      out.push({ residentId: rid, visit: null, due: '', state: 'none', noExplanation: false })
      continue
    }
    const due = nextDueOf(v.visited_on, rule)
    out.push({ residentId: rid, visit: v, due, state: dueState(due, today, warn), noExplanation: !hasExplanation(v) })
  }
  const rank: Record<HomeVisitDueRow['state'], number> = { overdue: 0, warn: 1, none: 2, ok: 3 }
  return out.sort((a, b) => rank[a.state] - rank[b.state] || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || a.residentId - b.residentId)
}

/** 一覧の数（期限切れ・間近・記録なし・説明の記録なし） */
export function homeVisitDueCounts(rows: readonly HomeVisitDueRow[]): { overdue: number; warn: number; none: number; noExplanation: number } {
  return {
    overdue: rows.filter((r) => r.state === 'overdue').length,
    warn: rows.filter((r) => r.state === 'warn').length,
    none: rows.filter((r) => r.state === 'none').length,
    noExplanation: rows.filter((r) => r.noExplanation).length,
  }
}

/** 状態の言葉（記号と文字。色だけに頼らない） */
export const DUE_STATE_LABEL: Record<Exclude<DueState, 'ended'>, string> = {
  overdue: '▲ 期限切れ',
  warn: '△ 間近',
  none: '居宅訪問の記録なし',
  ok: '期限内',
}

// ── 出し分けの判定（画面・カードが使う。段階3b の反証 軽10: 文言の有無でなく判定を試験で固定する） ─────────────

/** 写しの読み込みの結果（'error'＝読めなかった） */
export type DueCopyLoad = { rows: readonly DueCopyRow[]; settings: DueCopySettings | null } | 'error'

/**
 * 期限の区画の写しの知らせ。error＝読めない（終了と記録なしを確かめられない）／empty＝写しが0件（訪問の記録が無い方は出ていない）／
 * null＝知らせない
 */
export function homeVisitCopyNotice(copy: DueCopyLoad): 'error' | 'empty' | null {
  if (copy === 'error') return 'error'
  return copy.rows.length === 0 ? 'empty' : null
}

/** 数え方の出どころ。error＝写しを読めず既定で仮に出している／default＝設定の行が無く既定／copied＝写した設定 */
export function dueRuleSource(copy: DueCopyLoad): 'error' | 'default' | 'copied' {
  if (copy === 'error') return 'error'
  return copy.settings === null ? 'default' : 'copied'
}

/**
 * 1人の画面のカードの居宅訪問の1行の中身（文は画面が組む）。null＝出さない（終了の方）。
 * none＝記録なし／due＝次の期限と状態（ruleSource で数え方の出どころを添える）
 */
export function homeVisitCardLine(args: {
  visits: readonly DueVisit[]
  copy: DueCopyLoad
  residentId: number
  active: boolean | undefined
  today: string
}):
  | null
  | { kind: 'none' }
  | { kind: 'due'; due: string; state: Exclude<DueState, 'ended'>; last: DueVisit; noExplanation: boolean; ruleSource: 'error' | 'default' | 'copied' } {
  const { visits, copy, residentId, active, today } = args
  const c = copy === 'error' ? null : copy
  const copyRow = c?.rows.find((r) => r.resident_id === residentId)
  if (isEnded(active === undefined ? undefined : { id: residentId, active }, copyRow, today)) return null
  const last = latestVisit(visits, residentId)
  if (last === null) return { kind: 'none' }
  const due = nextDueOf(last.visited_on, c?.settings?.due_rule)
  return {
    kind: 'due',
    due,
    state: dueState(due, today, c?.settings?.warn_days),
    last,
    noExplanation: !hasExplanation(last),
    ruleSource: dueRuleSource(copy),
  }
}
