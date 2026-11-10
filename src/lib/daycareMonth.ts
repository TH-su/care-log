// デイ（せせらぎ）の「月の実績」（計画E・2026-11-10・読むだけの画面 /record/daycare/month）の純ロジック。副作用なし・DB/DOM に触れない。
//
//   日ごと … その日の予定の写し（daycare_days）と出欠（daycare_attendance）を、今日の画面と同じ buildDaycareBoard に通して数える
//            （予定＝入院中を除く・予定外・予定の誤りの扱いも同じ＝日の画面と月の画面の数が食い違わない）。buildDaycareMonth
//   方ごと … 数えた日の行を1人ずつ足す（未記録のある方を上に・同じ数なら五十音）
//   稼働率 … 延べ来所 ÷（定員 DAYCARE_CAPACITY × 営業日数）。予定に対する来所の割合 … 予定あり来所 ÷ 延べ予定。どちらも小数1桁の %
//
// 数えない日（2026-11-10 親の決め・仮置き）:
//   ・今日より後の日（今月は今日までを数える）
//   ・予定の写しが無い日・写しが「読めなかった」（unknown）日 … 今の曜日の型で作り直さない（過去を作り話にしない）。記録があれば数だけ見せる。
//     過去の日で、今の週間計画にその曜日の予定がある日は「記録の無い営業日かもしれない日」として目立たせる（反証 中1）。
//     今の週間計画は手がかりとしてだけ使い、延べ予定・未記録・稼働率には入れない（weekdayPlanned・planHint）
//   ・写しの無い休業日（app_settings の daycare_closed_dates）… 休業日として出す（上の「かもしれない日」にも入れない）。
//     写しのある休業日は今日の画面と同じく数え、「休業日の設定の日」と添えるだけ（反証 軽2・今日の画面と月の画面を食い違わせない）
// 営業日 ＝ 数える日のうち、予定（入院中を除く）が1人以上あった日（仮置き）。予定外の来所だけの日は営業日に入れず、来所は延べ来所に入れる
// 未記録 ＝ 過去の日（今日より前）に、予定があって来所も休みも無い方。今日のまだの方は「今日の未到着」で、未記録に入れない
// 恒等式（試験で固定）: 延べ予定 ＝ 予定あり来所 ＋ 予定あり休み ＋ 未記録 ＋ 今日の未到着。休みの理由の合計 ＝ 休み（予定あり＋予定外）
//
// 拡張子付きで import する（tests から node で直接読めるようにするため）。個人情報は扱わない（利用者は数値IDだけ・氏名は画面が引く）。

import { isDaycareClosedOn, isoWeekdayIndex, monthDays, shiftMonth } from './bath.ts'
import { buildDaycareBoard, kanaSortKey } from './daycare.ts'
import { readPersonDay } from './daycarePerson.ts'
import { daycarePlanWarning } from './daycareProgress.ts'
import { DAYCARE_ABSENT_REASON_VALUES } from './types.ts'
import type { DaycareAbsentReason, DaycareAttendance, DaycareDay, DaycarePlanRow, DaycarePlanSource, Resident } from './types.ts'

/**
 * デイ せせらぎの定員（稼働率の分母）。公開 LP の値。指定申請上の利用定員とは突き合わせていない。
 * 変わる時は PR で直す（app_settings には置かない＝2026-11-10 親の決め・仮置き）
 */
export const DAYCARE_CAPACITY = 27

/** 休みの理由の枠（体調不良・受診入院・本人の希望・ご家族の都合・その他・理由は後で・理由なし＝知らない値） */
export type DaycareMonthReason = DaycareAbsentReason | 'none'
/** 理由の並び（画面の順。「理由は後で」と「理由なし」は別枠で後ろ） */
export const DAYCARE_MONTH_REASONS: readonly DaycareMonthReason[] = [...DAYCARE_ABSENT_REASON_VALUES, 'none']
export type DaycareMonthReasonCounts = Record<DaycareMonthReason, number>

function zeroReasons(): DaycareMonthReasonCounts {
  return { condition: 0, hospital: 0, wish: 0, family: 0, other: 0, later: 0, none: 0 }
}

/**
 * 日の種類。counted＝数える日（写しが kv か none。休業日でも写しがあれば数える）／noSnapshot＝写しが無い・読めなかった／
 * closed＝写しの無い休業日／future＝今日より後
 */
export type DaycareMonthDayKind = 'counted' | 'noSnapshot' | 'closed' | 'future'

export interface DaycareMonthDay {
  day: string
  kind: DaycareMonthDayKind
  isToday: boolean
  /** noSnapshot の時: 'missing'＝写しが無い／'unknown'＝写しはあるが予定を読めなかった。ほかは null */
  noSnapshot: 'missing' | 'unknown' | null
  /** 休業日の設定の日（写しがあって数えた日にも付く＝「休業日の設定の日」と添える） */
  closedSetting: boolean
  /**
   * 過去の日で写しが無い（休業日でない）日の、今の週間計画のその曜日の予定の人数（入院中を除く）。手がかりだけで数には入れない。
   * 当てはまらない日・読めなかった曜日は null
   */
  planHint: number | null
  /** 過去の日で写しが無い（休業日でない）日のうち、今の週間計画のその曜日を読めなかった日 */
  planHintUnread: boolean
  /** 記録の無い営業日かもしれない日（過去・写しなし・休業日でない・今の週間計画にその曜日の予定がある） */
  maybeBusiness: boolean
  /** 営業日（数える日で、予定が1人以上） */
  business: boolean
  /** 延べ予定（入院中を除く＝今日の画面の「予定」と同じ） */
  planned: number
  plannedCame: number
  plannedAbsent: number
  extraCame: number
  extraAbsent: number
  /** 過去の日の未記録（予定があって来所も休みも無い） */
  unrecorded: number
  /** 今日のまだ来ていない方（未記録に入れない） */
  waitingToday: number
  /** 入院中で記録の無い方（予定に数えない＝今日の画面と同じ） */
  hospitalized: number
  /** 予定の誤り（週間計画に記録が2件・同じ日に予定が2件）の方 */
  planWarn: number
  /** 週間計画と照合できない予定の数（氏名の食い違いなど） */
  unconfirmed: number
  /** 名簿に無い方（外部利用者など）の予定の数（この画面では数えない） */
  notInRoster: number
  /** 数えない日に残っていた来所・休みの記録（写しなし・休業日・未来の日）。数には入れず、表に数だけ出す */
  uncountedCame: number
  uncountedAbsent: number
}

export interface DaycareMonthPerson {
  residentId: number
  planned: number
  plannedCame: number
  extraCame: number
  /** 休み（予定あり＋予定外） */
  absent: number
  reasons: DaycareMonthReasonCounts
  unrecorded: number
  /** 未記録の日（古い順） */
  unrecordedDays: string[]
  hospitalized: number
  waitingToday: number
  planWarn: number
  /** その方が出てきた最後の日（1人の画面を開く日。未記録があれば最後の未記録の日） */
  openDay: string
}

export interface DaycareMonthSummary {
  planned: number
  plannedCame: number
  plannedAbsent: number
  extraCame: number
  extraAbsent: number
  unrecorded: number
  waitingToday: number
  hospitalized: number
  planWarn: number
  unconfirmed: number
  notInRoster: number
  /** 延べ来所（予定あり＋予定外） */
  came: number
  /** 休み（予定あり＋予定外）＝理由の合計 */
  absent: number
  reasons: DaycareMonthReasonCounts
  businessDays: number
  countedDays: number
  noSnapshotDays: number
  closedDays: number
  futureDays: number
  /** 数えない日に記録が残っていた日の数 */
  uncountedRecordDays: number
  /** 記録の無い営業日かもしれない日の数（過去・写しなし・今の週間計画にその曜日の予定がある） */
  maybeBusinessDays: number
  /** 写しの無い過去の日のうち、今の週間計画を読めなかった日の数 */
  planHintUnreadDays: number
  /** 写しのある休業日（数えた日）の数 */
  closedCountedDays: number
  /** 稼働率（0.1% 単位の整数・営業日0なら null） */
  utilization10: number | null
  /** 予定に対する来所の割合（0.1% 単位の整数・延べ予定0なら null） */
  attendRate10: number | null
  capacity: number
}

export interface DaycareMonthReport {
  month: string
  /** 数える日の最後（今月は今日・過去の月は月末・先の月は null） */
  through: string | null
  /** 日ごと（1日〜月末。未来の日も kind='future' で入る） */
  days: DaycareMonthDay[]
  /** 方ごと（未記録の多い方が上・同じなら五十音） */
  persons: DaycareMonthPerson[]
  summary: DaycareMonthSummary
}

/** 分子 ÷ 分母 を 0.1% 単位の整数に（四捨五入）。分母が0以下なら null（0 で割らない） */
export function rate10(numer: number, denom: number): number | null {
  if (!Number.isFinite(numer) || !Number.isFinite(denom) || denom <= 0 || numer < 0) return null
  // 整数どうしの割り算にしてから丸める（0.6545 × 1000 のような小数の掛け算の端数を作らない）
  return Math.round((numer * 1000) / denom)
}

/** 0.1% 単位の整数を '65.4%' に。null は '—' */
export function fmtRate10(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return '—'
  const v = Math.round(r)
  return `${Math.floor(v / 10)}.${v % 10}%`
}

const KANA = new Intl.Collator('ja')

/**
 * 1か月の実績を組む。snapshots・attendance はその月の分（取り消した出欠は DB で除いてから渡す＝db.ts の fetchDaycareAttendanceMonth）。
 * residents は退居された方も含めて渡す（今日の画面と同じ・五十音の並べ替えに使う）。month の形が違えば null
 */
export function buildDaycareMonth(p: {
  month: string
  today: string
  snapshots: readonly DaycareDay[]
  attendance: readonly DaycareAttendance[]
  residents: readonly (Pick<Resident, 'id'> & Partial<Pick<Resident, 'name' | 'kana'>>)[]
  closedDates: string | null
  capacity?: number
  /**
   * 今の週間計画の曜日ごとの予定の人数（曜日＝isoWeekdayIndex の 0〜6。値 null＝読めなかった・無い曜日は読んでいない）。
   * 写しの無い過去の日の手がかりだけに使う（daycareMonthHintDays で読む日を決め、planHintCount で数える）
   */
  weekdayPlanned?: ReadonlyMap<number, number | null>
}): DaycareMonthReport | null {
  const all = monthDays(p.month)
  if (all.length === 0) return null
  const capacity = p.capacity ?? DAYCARE_CAPACITY
  const snapOf = new Map<string, DaycareDay>()
  for (const s of p.snapshots) if (s.day.startsWith(`${p.month}-`)) snapOf.set(s.day, s)
  const attOf = new Map<string, DaycareAttendance[]>()
  for (const a of p.attendance) {
    if (!a.day.startsWith(`${p.month}-`)) continue
    const list = attOf.get(a.day)
    if (list === undefined) attOf.set(a.day, [a])
    else list.push(a)
  }
  const persons = new Map<number, DaycareMonthPerson>()
  const personOf = (id: number, day: string): DaycareMonthPerson => {
    let x = persons.get(id)
    if (x === undefined) {
      x = {
        residentId: id,
        planned: 0,
        plannedCame: 0,
        extraCame: 0,
        absent: 0,
        reasons: zeroReasons(),
        unrecorded: 0,
        unrecordedDays: [],
        hospitalized: 0,
        waitingToday: 0,
        planWarn: 0,
        openDay: day,
      }
      persons.set(id, x)
    }
    if (day > x.openDay) x.openDay = day
    return x
  }
  const sum = {
    reasons: zeroReasons(),
    businessDays: 0,
    countedDays: 0,
    noSnapshotDays: 0,
    closedDays: 0,
    futureDays: 0,
    uncountedRecordDays: 0,
    maybeBusinessDays: 0,
    planHintUnreadDays: 0,
    closedCountedDays: 0,
  }
  const days: DaycareMonthDay[] = []
  for (const day of all) {
    const att = attOf.get(day) ?? []
    const base: DaycareMonthDay = {
      day,
      kind: 'counted',
      isToday: day === p.today,
      noSnapshot: null,
      closedSetting: isDaycareClosedOn(day, p.closedDates),
      planHint: null,
      planHintUnread: false,
      maybeBusiness: false,
      business: false,
      planned: 0,
      plannedCame: 0,
      plannedAbsent: 0,
      extraCame: 0,
      extraAbsent: 0,
      unrecorded: 0,
      waitingToday: 0,
      hospitalized: 0,
      planWarn: 0,
      unconfirmed: 0,
      notInRoster: 0,
      uncountedCame: 0,
      uncountedAbsent: 0,
    }
    const snap = snapOf.get(day) ?? null
    const usable = snap !== null && snap.plan_source !== 'unknown'
    // 写しのある日は休業日の設定の日でも数える（今日の画面と同じ）。写しの無い休業日だけ休業日として数えない
    const kind: DaycareMonthDayKind = day > p.today ? 'future' : usable ? 'counted' : base.closedSetting ? 'closed' : 'noSnapshot'
    base.kind = kind
    if (kind !== 'counted') {
      if (kind === 'noSnapshot') {
        base.noSnapshot = snap === null ? 'missing' : 'unknown'
        // 過去の日だけ今の週間計画を手がかりに見る（今日はまだ途中＝写しが後で作られる）。数には入れない
        if (day < p.today) {
          const w = isoWeekdayIndex(day)
          const hint = w === null || p.weekdayPlanned === undefined || !p.weekdayPlanned.has(w) ? undefined : p.weekdayPlanned.get(w)
          if (hint === null) {
            base.planHintUnread = true
            sum.planHintUnreadDays += 1
          } else if (typeof hint === 'number') {
            base.planHint = hint
            base.maybeBusiness = hint > 0
            if (base.maybeBusiness) sum.maybeBusinessDays += 1
          }
        }
      }
      // 数えない日の記録は、今日の画面と同じ「1人1日1件（id の大きい方）」で数だけ出す
      const latest = new Map<number, DaycareAttendance>()
      for (const a of att) {
        const cur = latest.get(a.resident_id)
        if (cur === undefined || a.id > cur.id) latest.set(a.resident_id, a)
      }
      for (const a of latest.values()) {
        if (a.absent) base.uncountedAbsent += 1
        else if (a.arrived_at !== null) base.uncountedCame += 1
      }
      if (kind === 'future') sum.futureDays += 1
      else if (kind === 'closed') sum.closedDays += 1
      else sum.noSnapshotDays += 1
      if (base.uncountedCame + base.uncountedAbsent > 0) sum.uncountedRecordDays += 1
      days.push(base)
      continue
    }
    const s = snap as DaycareDay
    // 今日の画面と同じ関数で数える（予定外に画面で足しただけの方＝extraIds は記録が無いので数に入らない）
    const board = buildDaycareBoard({ planRows: s.plan_rows, source: s.plan_source, residents: p.residents, attendance: att })
    base.unconfirmed = board.unconfirmed
    base.notInRoster = board.notInRoster
    const past = day < p.today
    for (const r of board.rows) {
      const came = r.state === 'present' || r.state === 'left'
      const absent = r.state === 'absent'
      if (r.planned && daycarePlanWarning(r) !== null) {
        base.planWarn += 1
        personOf(r.residentId, day).planWarn += 1
      }
      // 入院中で記録の無い方は予定に数えない（buildDaycareBoard の counts と同じ）
      if (r.hospitalized && r.state === 'planned') {
        base.hospitalized += 1
        personOf(r.residentId, day).hospitalized += 1
        continue
      }
      if (!r.planned && !came && !absent) continue // 予定外で記録の中身が無い（時刻を消した）行は数えない
      const who = personOf(r.residentId, day)
      if (r.planned) {
        base.planned += 1
        who.planned += 1
        if (came) {
          base.plannedCame += 1
          who.plannedCame += 1
        } else if (absent) {
          base.plannedAbsent += 1
        } else if (past) {
          base.unrecorded += 1
          who.unrecorded += 1
          who.unrecordedDays.push(day)
        } else {
          base.waitingToday += 1
          who.waitingToday += 1
        }
      } else if (came) {
        base.extraCame += 1
        who.extraCame += 1
      } else {
        base.extraAbsent += 1
      }
      if (absent) {
        const reason: DaycareMonthReason = r.attendance?.absent_reason ?? 'none'
        who.absent += 1
        who.reasons[reason] += 1
        sum.reasons[reason] += 1
      }
    }
    base.business = base.planned > 0
    sum.countedDays += 1
    if (base.closedSetting) sum.closedCountedDays += 1
    if (base.business) sum.businessDays += 1
    days.push(base)
  }
  const add = (f: (d: DaycareMonthDay) => number) => days.reduce((n, d) => n + f(d), 0)
  const planned = add((d) => d.planned)
  const plannedCame = add((d) => d.plannedCame)
  const extraCame = add((d) => d.extraCame)
  const plannedAbsent = add((d) => d.plannedAbsent)
  const extraAbsent = add((d) => d.extraAbsent)
  const came = plannedCame + extraCame
  const summary: DaycareMonthSummary = {
    planned,
    plannedCame,
    plannedAbsent,
    extraCame,
    extraAbsent,
    unrecorded: add((d) => d.unrecorded),
    waitingToday: add((d) => d.waitingToday),
    hospitalized: add((d) => d.hospitalized),
    planWarn: add((d) => d.planWarn),
    unconfirmed: add((d) => d.unconfirmed),
    notInRoster: add((d) => d.notInRoster),
    came,
    absent: plannedAbsent + extraAbsent,
    reasons: sum.reasons,
    businessDays: sum.businessDays,
    countedDays: sum.countedDays,
    noSnapshotDays: sum.noSnapshotDays,
    closedDays: sum.closedDays,
    futureDays: sum.futureDays,
    uncountedRecordDays: sum.uncountedRecordDays,
    maybeBusinessDays: sum.maybeBusinessDays,
    planHintUnreadDays: sum.planHintUnreadDays,
    closedCountedDays: sum.closedCountedDays,
    utilization10: rate10(came, capacity * sum.businessDays),
    attendRate10: rate10(plannedCame, planned),
    capacity,
  }
  const sortKey = new Map<number, string | null>()
  for (const r of p.residents) sortKey.set(r.id, kanaSortKey(r))
  const list = [...persons.values()]
  for (const x of list) {
    x.unrecordedDays.sort()
    if (x.unrecordedDays.length > 0) x.openDay = x.unrecordedDays[x.unrecordedDays.length - 1]
  }
  list.sort((a, b) => {
    if (a.unrecorded !== b.unrecorded) return b.unrecorded - a.unrecorded
    const ka = sortKey.get(a.residentId) ?? null
    const kb = sortKey.get(b.residentId) ?? null
    if (ka !== kb) {
      if (ka === null) return 1
      if (kb === null) return -1
      const c = KANA.compare(ka, kb)
      if (c !== 0) return c
    }
    return a.residentId - b.residentId
  })
  const last = all[all.length - 1]
  const through = p.today < all[0] ? null : p.today < last ? p.today : last
  return { month: p.month, through, days, persons: list, summary }
}

/** 理由の内訳の短い文（'体調不良1・後で2'。0の理由は出さない。全部0なら ''） */
export function reasonsShort(r: DaycareMonthReasonCounts, label: Record<DaycareMonthReason, string>): string {
  return DAYCARE_MONTH_REASONS.filter((k) => r[k] > 0)
    .map((k) => `${label[k]}${r[k]}`)
    .join('・')
}

/** 月の実績の画面の道（今月は ?m= を付けない） */
export const DAYCARE_MONTH_PATH = '/record/daycare/month'
export function daycareMonthPath(month: string, currentMonth: string): string {
  return `${DAYCARE_MONTH_PATH}${month === currentMonth ? '' : `?m=${month}`}`
}

/** 今日の画面のその日（今日は ?day= を付けない） */
export function daycareDayPath(day: string, today: string): string {
  return `/record/daycare${day === today ? '' : `?day=${day}`}`
}

// ══════════════════════════════════════════════════════════════
// 写しの無い過去の日の手がかり（今の週間計画・数には入れない＝反証 中1）
// ══════════════════════════════════════════════════════════════

/**
 * 今の週間計画を読む日（曜日ごとに1日・その月の古い日）。過去の日（今日より前）で、写しが無いか読めなかった、休業日でない日の曜日だけ。
 * 当てはまる日が無ければ空（読みに行かない）。週間計画は曜日ごとなので、その日付で読めば今のその曜日の予定になる（RPC daycare_plan）
 */
export function daycareMonthHintDays(p: { month: string; today: string; snapshots: readonly DaycareDay[]; closedDates: string | null }): string[] {
  const usable = new Set(p.snapshots.filter((s) => s.plan_source !== 'unknown').map((s) => s.day))
  const byWeekday = new Map<number, string>()
  for (const day of monthDays(p.month)) {
    if (day >= p.today || usable.has(day) || isDaycareClosedOn(day, p.closedDates)) continue
    const w = isoWeekdayIndex(day)
    if (w !== null && !byWeekday.has(w)) byWeekday.set(w, day)
  }
  return [...byWeekday.values()].sort()
}

/** 今の週間計画のその日の予定の人数（入院中を除く＝今日の画面の「予定」と同じ数え方）。読めない（unknown）は null */
export function planHintCount(
  planRows: readonly DaycarePlanRow[],
  source: DaycarePlanSource,
  residents: readonly (Pick<Resident, 'id'> & Partial<Pick<Resident, 'name' | 'kana'>>)[],
): number | null {
  if (source === 'unknown') return null
  return buildDaycareBoard({ planRows, source, residents, attendance: [] }).counts.planned
}

// ══════════════════════════════════════════════════════════════
// 画面の判断（月の読み込みの状態・月の切り替え・日をまたぐ・今日の画面の ?day=）
// ══════════════════════════════════════════════════════════════

/** 月の読み込みの状態。gen は読み込みの世代（新しく読み始めるたびに増やす） */
export interface MonthLoadState<T> {
  month: string
  gen: number
  data: T | null
  error: string | null
  loading: boolean
}

/** 読み始め: 同じ月の読み直しの間は今の数を出したまま、別の月へ移った時は前の数を消す */
export function monthLoadStart<T>(prev: MonthLoadState<T>, month: string, gen: number): MonthLoadState<T> {
  return { month, gen, data: prev.month === month ? prev.data : null, error: null, loading: true }
}

/** 読めた: 今の世代・今の月の応答だけ入れる（別の月の遅れた応答・古い世代の応答は捨てる） */
export function monthLoadDone<T>(prev: MonthLoadState<T>, month: string, gen: number, data: T): MonthLoadState<T> {
  if (gen !== prev.gen || month !== prev.month) return prev
  return { ...prev, data, error: null, loading: false }
}

/** 読めなかった（上限に当たった・通信できない）: 今の世代の時だけ、前の数も消して知らせる（欠けた数を見せない） */
export function monthLoadFail<T>(prev: MonthLoadState<T>, month: string, gen: number, error: string): MonthLoadState<T> {
  if (gen !== prev.gen || month !== prev.month) return prev
  return { ...prev, data: null, error, loading: false }
}

/** 〔次の月〕を押せるか（先の月へは進めない） */
export function canGoNextMonth(month: string, currentMonth: string): boolean {
  return shiftMonth(month, 1) <= currentMonth
}

/**
 * 今日を取り直して日付が変わった時に読み直すか。読み込んだ月が、読み込んだ時の今月だった時だけ（今日までを数えているので、
 * 昨日の「今日の未到着」を未記録に・今日を数える日にする）。過去の月は日付が変わっても数が変わらないので読み直さない
 */
export function shouldReloadOnDayChange(loaded: { month: string; today: string } | null, nowToday: string): boolean {
  if (loaded === null || nowToday === loaded.today) return false
  return loaded.month === loaded.today.slice(0, 7)
}

/**
 * 今日の画面を開いた時の日（月の実績の日ごとの表・1人の画面の〔デイの一覧へ〕から来た ?day=）。日は readPersonDay で読み
 * （形が違う・未来の日は今日）、?day= があれば URL から外す（strip。再読み込みは今までどおり今日を開く）
 */
export function initialDayFromUrl(raw: string | null, today: string): { day: string; strip: boolean } {
  return { day: readPersonDay(raw, today), strip: raw !== null }
}
