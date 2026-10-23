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

/**
 * 期限の一覧（見直し・居宅訪問）を出す範囲（積み残し 51・代表者の決定 2026-10-23）。計画書に計画がある方に加えて:
 * week＝週間計画で、週のどこかの曜日にデイの予定がある方（null＝読めない・照合できない予定がある・予定が1件も無い＝週の分は絞らない）
 * arrived＝その日に来た方（予定外で来た方を含む。計画書が無いまま来ている方を「計画なし」として目に入れるため）
 */
export interface DueScope {
  week: ReadonlySet<number> | null
  arrived: readonly number[]
  /**
   * 週の分で絞れない時（week＝null）も、名簿と照合できた予定の方。絞らないだけでなく「計画なし」「記録なし」に足す
   * （照合できない予定が別に1件ある・1日だけ読めない時に、週の予定がある方が消えない＝積み残し 51 の続きの反証 中1）
   */
  known?: ReadonlySet<number>
}

/** 範囲に入るか（週の分が null の時は絞らない＝誰でも入る） */
const inDueScope = (scope: DueScope, rid: number): boolean => scope.week === null || scope.week.has(rid) || scope.arrived.includes(rid)
/** 範囲の方（週の分が null の時は、照合できた予定の方とその日に来た方＝週の分は全部は数え上げられない） */
const dueScopePeople = (scope: DueScope): Set<number> => new Set<number>([...(scope.week ?? scope.known ?? []), ...scope.arrived])

/**
 * 居宅訪問の一覧で、訪問の記録だけがある方を外すか。範囲を渡し、週の分が読めていて、写しに行がある時だけ外す
 * （写しに行が無い時は、計画がある方を見分けられない＝外すと少なめに出す側になる）
 */
export function homeVisitNarrows(scope: DueScope | undefined, copy: readonly unknown[]): boolean {
  return scope !== undefined && scope.week !== null && copy.length > 0
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
  /**
   * 出す範囲（案A・代表者の決定 2026-10-23）。渡した時は、計画がある方・週間計画に予定がある方・その日に来た方だけを出し、
   * 訪問の記録だけがある方は出さない（週の分が null の時と、写しに行が1件も無い＝読めない・まだ写していない時は、
   * 計画がある方を見分けられないので、訪問の記録がある方も出す＝多めに出す側）。渡さない時は 3b の決まりのまま
   */
  scope?: DueScope
}): HomeVisitDueRow[] {
  const { visits, copy, settings, people, today, scope } = args
  const rule = normalizeDueRule(settings?.due_rule)
  const warn = normalizeWarnDays(settings?.warn_days)
  const personOf = new Map(people.map((p) => [p.id, p]))
  const copyOf = new Map(copy.map((c) => [c.resident_id, c]))
  const ids = new Set<number>()
  if (!homeVisitNarrows(scope, copy)) for (const v of visits) ids.add(v.resident_id)
  // 週の分で絞れない時は、見直しの一覧（写しの全員）と同じく、写しに行がある方を全員出す（計画なしの方も「記録なし」で＝反証 軽1）
  const allCopy = scope !== undefined && scope.week === null
  for (const c of copy) if (allCopy || isYmd(c.latest_plan_date)) ids.add(c.resident_id)
  if (scope !== undefined) for (const rid of dueScopePeople(scope)) ids.add(rid)
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

// ── 計画の見直しの期限（段階3c・計画 2.1）と今日の対象者の並び（計画 6章） ─────────────────────────

/** 計画の見直しの期限の1行 */
export interface ReviewDueRow {
  residentId: number
  /** 次の期限（写しの next_due。空なら作成日と規則から計算し直す。計画が無ければ ''） */
  due: string
  /** 最新の計画の作成日（無ければ null＝計画なし） */
  planDate: string | null
  state: Exclude<DueState, 'ended'>
  /** 範囲に入るのに、計画書の写しに行が無い方（「計画なし」に数える＝多めに出す側・積み残し 51） */
  noCopy?: true
}

/**
 * 計画の見直しの期限の一覧（計画 2.1）。計画書アプリの一覧（buildAlerts）と同じ順で判定する:
 * 終了（在籍でない・通知を止めた日が今日以前）は出さない → 作成日が無ければ none（計画なし）→ dueState。
 * 期限は写しの next_due をそのまま使い、空なら作成日と規則から計算し直す（計画書アプリの 1135 行と同じ）。
 * 並びは 期限切れ → 間近 → 計画なし → 期限内（同じ状態の中は期限の早い順・番号順）
 */
export function reviewDueList(args: { copy: readonly DueCopyRow[]; settings: DueCopySettings | null; people: readonly DuePerson[]; today: string }): ReviewDueRow[] {
  const { copy, settings, people, today } = args
  const rule = normalizeDueRule(settings?.due_rule)
  const warn = normalizeWarnDays(settings?.warn_days)
  const personOf = new Map(people.map((p) => [p.id, p]))
  const out: ReviewDueRow[] = []
  for (const c of copy) {
    if (isEnded(personOf.get(c.resident_id), c, today)) continue
    if (!isYmd(c.latest_plan_date)) {
      out.push({ residentId: c.resident_id, due: '', planDate: null, state: 'none' })
      continue
    }
    const due = isYmd(c.next_due) ? c.next_due : nextDueOf(c.latest_plan_date, rule)
    out.push({ residentId: c.resident_id, due, planDate: c.latest_plan_date, state: dueState(due, today, warn) })
  }
  const rank: Record<ReviewDueRow['state'], number> = { overdue: 0, warn: 1, none: 2, ok: 3 }
  return out.sort((a, b) => rank[a.state] - rank[b.state] || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || a.residentId - b.residentId)
}

/**
 * 見直しの一覧を出す方を絞る（代表者の決定 2026-10-23・積み残し 51・親の訂正 同日）。次のどちらかに当たる方だけを残す:
 * 1. 週間計画（care_schedule_v2）で、週のどこかの曜日にデイの予定がある方（daycareIds。今日来ない方も外さない。
 *    daycare_plan と同じ見方で、外部利用者は入らない）
 * 2. 写しに計画の行がある方（最新の計画の作成日がある方）
 * daycareIds が null（週間計画を読めない）の時は絞らない（多めに出す側に倒す。画面はその旨を書き添える）
 */
export function filterReviewScope(rows: readonly ReviewDueRow[], daycareIds: ReadonlySet<number> | null): ReviewDueRow[] {
  if (daycareIds === null) return [...rows]
  return rows.filter((r) => r.planDate !== null || daycareIds.has(r.residentId))
}

/** 週間計画から作った「予定がある方」（ids が null＝絞らない。reason＝絞らない理由・unmatched＝照合できない予定の件数） */
export interface WeekScope {
  ids: Set<number> | null
  reason: 'unread' | 'unmatched' | 'noplan' | null
  unmatched: number
  /** 理由を問わず、読めた日の予定で名簿と照合できた方（ids が null の時も一覧に足す＝反証 中1。ids がある時は ids と同じ） */
  known: Set<number>
}

/**
 * 範囲で絞った見直しの一覧（積み残し 51・代表者の決定 2026-10-23・案A と同じ範囲）。
 * ・写しの行は、計画がある方か、範囲に入る方だけを残す（週の分が null の時は絞らない）
 * ・範囲に入るのに写しに行が無い方は、「計画なし」（noCopy）として足す（多めに出す側。在籍でない方は足さない・名簿に無い方は在籍として扱う）
 */
export function scopedReviewDueList(args: {
  copy: readonly DueCopyRow[]
  settings: DueCopySettings | null
  people: readonly DuePerson[]
  today: string
  scope: DueScope
}): ReviewDueRow[] {
  const { copy, settings, people, today, scope } = args
  const kept = reviewDueList({ copy, settings, people, today }).filter((r) => r.planDate !== null || inDueScope(scope, r.residentId))
  const copyIds = new Set(copy.map((c) => c.resident_id))
  const personOf = new Map(people.map((p) => [p.id, p]))
  const extra: ReviewDueRow[] = []
  for (const rid of dueScopePeople(scope)) {
    if (copyIds.has(rid)) continue
    // 名簿に無い方は在籍として扱う（名簿を読めない・届く前に、来た方を黙って消さない＝isEnded・居宅訪問の一覧と同じ向き・反証 中2）
    const p = personOf.get(rid)
    if (p !== undefined && !p.active) continue
    extra.push({ residentId: rid, due: '', planDate: null, state: 'none', noCopy: true })
  }
  const rank: Record<ReviewDueRow['state'], number> = { overdue: 0, warn: 1, none: 2, ok: 3 }
  return [...kept, ...extra].sort(
    (a, b) => rank[a.state] - rank[b.state] || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || a.residentId - b.residentId,
  )
}

/**
 * 続いた7日分の予定（daycare_plan の結果。週間計画は曜日ごとなので、7日で全部の曜日になる）から、
 * どこかの曜日にデイの予定がある方（名簿と照合できた方）を集める。
 * ・1日でも読めない（null・unknown）・7日に足りない時は ids＝null（reason 'unread'・絞らない）
 * ・週に1件も予定が無い時も ids＝null（reason 'noplan'・絞らない。週間計画が使われていない状態と見分けがつかないため）
 * ・名簿と照合できない予定（mismatch・ambiguous＝在籍の方の予定かもしれない）が1件でもある時も ids＝null
 *   （reason 'unmatched'・絞らない。予定のある方を知らせなしに一覧から外さない＝積み残し 51 の反証 中1）。
 *   外部利用者（external）と名簿の在籍者に居ない予定（absent_roster）は数えない（care-log の在籍の方ではない）
 */
export function weekScope(
  plans: ReadonlyArray<{ source: string; rows: ReadonlyArray<{ resident_id: number | null; match: string | null; external: boolean }> } | null>,
): WeekScope {
  // 読めない日があっても、読めた日の照合できた方は known に集める（絞らない時も一覧に足す＝反証 中1）
  const known = new Set<number>()
  let unread = plans.length < 7
  let unmatched = 0
  for (const p of plans) {
    if (p === null || p.source === 'unknown') {
      unread = true
      continue
    }
    for (const r of p.rows) {
      if (r.resident_id !== null) known.add(r.resident_id)
      else if (!r.external && (r.match === 'mismatch' || r.match === 'ambiguous')) unmatched += 1
    }
  }
  if (unread) return { ids: null, reason: 'unread', unmatched: 0, known }
  if (unmatched > 0) return { ids: null, reason: 'unmatched', unmatched, known }
  // 週に1件も予定が無い（在籍の方に結べた予定が無い）時も絞らない。週間計画がデイに使われていない・拾えていない状態と
  // 見分けがつかないので、「計画なし 0人」に倒さず多めに出す（積み残し 51 の直しの確認 軽1）
  if (known.size === 0) return { ids: null, reason: 'noplan', unmatched: 0, known }
  return { ids: new Set(known), reason: null, unmatched: 0, known }
}

/** 見直しの一覧の数（期限切れ・間近・計画なし） */
export function reviewDueCounts(rows: readonly ReviewDueRow[]): { overdue: number; warn: number; none: number } {
  return {
    overdue: rows.filter((r) => r.state === 'overdue').length,
    warn: rows.filter((r) => r.state === 'warn').length,
    none: rows.filter((r) => r.state === 'none').length,
  }
}

/** 見直しの状態の言葉（記号と文字。色だけに頼らない） */
export const REVIEW_STATE_LABEL: Record<Exclude<DueState, 'ended'>, string> = {
  overdue: '▲ 期限切れ',
  warn: '△ 間近',
  none: '計画なし',
  ok: '期限内',
}

/**
 * 対象者の行に添える、下に回した理由（nocopy＝写しに行が無い／noplan＝計画書に計画なし／ended＝計画書の通知を止めている／
 * inactive＝在籍でない方。過去の日を開くと、その後に在籍でなくなった方も到着の記録から対象者に出る＝段階3c の反証 軽3）
 */
export type TargetNoPlanReason = 'nocopy' | 'noplan' | 'ended' | 'inactive'
export const TARGET_NO_PLAN_LABEL: Record<TargetNoPlanReason, string> = {
  nocopy: '計画書の写しなし',
  noplan: '計画書に計画なし',
  ended: '計画書の通知を止めています',
  inactive: '在籍でない方',
}

/**
 * 今日の対象者の並び（計画 6章）。写しを読めた時は「計画がある・終了でない方」を上に、それ以外を下に（それぞれの中は元の並び）。
 * notice: error＝写しを読めない（並びは元のまま・「計画書の期限を確かめられません」）／empty＝写しが0件（並びは元のまま）／null。
 * noPlan＝下に回した方と、その理由（行に添える。notice がある時は空）
 */
export function orderTargetsByPlan(args: {
  targets: readonly number[]
  copy: DueCopyLoad
  people: readonly DuePerson[]
  today: string
}): { order: number[]; noPlan: Map<number, TargetNoPlanReason>; notice: 'error' | 'empty' | null } {
  const { targets, copy, people, today } = args
  if (copy === 'error') return { order: [...targets], noPlan: new Map(), notice: 'error' }
  if (copy.rows.length === 0) return { order: [...targets], noPlan: new Map(), notice: 'empty' }
  const personOf = new Map(people.map((p) => [p.id, p]))
  const copyOf = new Map(copy.rows.map((c) => [c.resident_id, c]))
  const reasonOf = (rid: number): TargetNoPlanReason | null => {
    if (personOf.get(rid)?.active === false) return 'inactive'
    const c = copyOf.get(rid)
    if (c === undefined) return 'nocopy'
    if (isEnded(personOf.get(rid), c, today)) return 'ended'
    return isYmd(c.latest_plan_date) ? null : 'noplan'
  }
  const top: number[] = []
  const rest: number[] = []
  const noPlan = new Map<number, TargetNoPlanReason>()
  for (const rid of targets) {
    const why = reasonOf(rid)
    if (why === null) top.push(rid)
    else {
      rest.push(rid)
      noPlan.set(rid, why)
    }
  }
  return { order: [...top, ...rest], noPlan, notice: null }
}

/**
 * 1人の画面のカードの見直しの1行の中身（文は画面が組む）。null＝出さない（終了の方）。
 * error＝写しを読めない／nocopy＝写しにその方の行が無い（写しが0件の時も）／none＝計画なし／due＝次の期限と状態
 */
export function reviewCardLine(args: { copy: DueCopyLoad; residentId: number; active: boolean | undefined; today: string }):
  | null
  | { kind: 'error' }
  | { kind: 'nocopy' }
  | { kind: 'none' }
  | { kind: 'due'; due: string; state: Exclude<DueState, 'ended'> } {
  const { copy, residentId, active, today } = args
  if (copy === 'error') return { kind: 'error' }
  const c = copy.rows.find((r) => r.resident_id === residentId)
  if (isEnded(active === undefined ? undefined : { id: residentId, active }, c, today)) return null
  if (c === undefined) return { kind: 'nocopy' }
  const row = reviewDueList({ copy: [c], settings: copy.settings, people: [], today })[0]
  if (row === undefined || row.state === 'none') return { kind: 'none' }
  return { kind: 'due', due: row.due, state: row.state }
}

/**
 * 見直しの期限の区画の写しの状態（段階3c の反証 中1）。never＝まだ一度も写していない（設定の行も写しの行も無い）／
 * empty＝写したが写しに1人も載っていない（0/0/0 を出すと「期限切れなし」と読めるので、別の知らせにする）／ok
 */
export function reviewCopyState(copy: { rows: readonly DueCopyRow[]; settings: DueCopySettings | null }): 'never' | 'empty' | 'ok' {
  if (copy.rows.length > 0) return 'ok'
  return copy.settings === null ? 'never' : 'empty'
}
