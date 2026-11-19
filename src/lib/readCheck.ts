// 日報の確認欄（その日の日報を読んだ ✔）と未読者欄を組み立てる純粋な部品（2026-11-19 本人指示）。
//
// 決まり（docs は ROOT.md・仮置きを含む）:
//   - 確認欄に並べる職員: ケアログの在籍の職員のうち、勤務表で日報の対象（施設・通所）の職員と、勤務表の名簿に名前が見つからない
//     職員（氏名の表記が違う・手で足した人。並べて「判定できない」に数える＝✔ を押せなくならない）。勤務表の名簿にいて日報の対象で
//     ない人（訪問だけの人）は並べない。勤務表が読めない時は、
//     勤務表の名簿から同期した職員（hire_order がある＝事務職員など手で足した人を除く）。どの職員にも hire_order が無い
//     （古いサーバー）時は在籍の職員全員。
//   - 未読者: その日に勤務表で勤務の職員のうち、その日の ✔ が無い人。休み・空欄の日は未読者に出さない
//     ＝休み明けの勤務の日に ✔ が無ければ未読者に出る。
//   - 勤務表が読めない・その月の勤務表が無い日は、その日の日報の出勤者の欄に入っている人を勤務とみなす（出勤者で判定）。
//     出勤者の欄も空なら判定しない（未読者を出さず、目立たせない）。
//   - 勤務表で読めない記号の人・勤務表に名前が見つからない人（確認欄には並ぶ）は「判定できない」に数え、未読者には出さない。
//   - まだ来ていない日・確認欄を始める前の日（READ_CHECK_FROM より前）は判定しない（✔ の行が1件も無いので全員が赤になるため）。
//   - 今日から14日より前の日は、現場の端末から ✔ を付けられない（0065 の守り）ので、未読者は出すが目立たせない（stale）。
// 個人情報: 職員の id と氏名だけを扱う（勤務記号は持たない）。

import type { DutyStatus, DutyTable, FacilityDutyTable } from './shiftDuty.ts'
import { nameKey } from './shiftDuty.ts'

export interface ReadCheckStaff {
  id: number
  name: string
  hire_order?: number | null
}

/** 判定のもと */
export type ReadCheckSource = 'shift' | 'attendance' | 'none' | 'future' | 'before'

/** 確認欄を始めた日（この日より前の日報は判定しない・2026-11-19 公開＝仮置き） */
export const READ_CHECK_FROM = '2026-11-19'
/** 現場の端末が ✔ を付けられる日数（今日から何日前まで・0065 の守りと同じ） */
export const READ_CHECK_FIELD_DAYS = 14

/** 'YYYY-MM-DD' に日数を足す（暦の日・時刻帯に依らない） */
export function shiftIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map((x) => parseInt(x, 10))
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}

export interface ReadCheckView {
  /** 確認欄に並べる職員（並びは渡された職員の並び） */
  members: { id: number; name: string; checked: boolean; duty: DutyStatus | 'attendance' | 'nomatch' | null }[]
  /** 未読者（勤務なのに ✔ が無い人） */
  unread: { id: number; name: string }[]
  /** 判定できない人（✔ が無く、勤務表の記号が読めない・名前が勤務表に無い） */
  undetermined: { id: number; name: string }[]
  source: ReadCheckSource
  /** 現場の端末からはもう ✔ を付けられない古い日（今日から14日より前）。未読者は出すが目立たせない */
  stale: boolean
}

/** 確認欄に並べる職員 */
export function readCheckMembers(
  staff: readonly ReadCheckStaff[],
  dailyKeys: ReadonlySet<string> | null,
  rosterKeys: ReadonlySet<string> | null = null,
): ReadCheckStaff[] {
  if (dailyKeys) {
    return staff.filter((s) => {
      const k = nameKey(s.name)
      if (dailyKeys.has(k)) return true
      // 勤務表の名簿に名前が無い人は並べる（判定できない）。名簿にいて対象でない人（訪問だけ）は並べない
      return rosterKeys !== null && !rosterKeys.has(k) && s.hire_order !== null && s.hire_order !== undefined
    })
  }
  const rostered = staff.filter((s) => s.hire_order !== null && s.hire_order !== undefined)
  return rostered.length > 0 ? rostered : [...staff]
}

/**
 * 1日ぶんの確認欄と未読者を組み立てる。
 * 2026-11-19 から画面の未読（未読者欄と確認欄の赤い印）は下の buildUnreadSummary の数え方を使う。ここの unread は
 * 「その日に勤務の人」の数え方のまま残している（画面は members・source・stale だけを使う）。
 * @param day 日報の日（'YYYY-MM-DD'）
 * @param today JST の今日（'YYYY-MM-DD'）
 * @param staff 在籍の職員（確認欄の並び順）
 * @param duty 勤務表から作った表（読めない時は null）
 * @param dailyKeys 勤務表で日報の対象の職員の氏名の鍵（表示中のどの日かで対象の人。読めない時は null）
 * @param rosterKeys 勤務表の名簿の全員（在籍）の氏名の鍵（読めない時は null）
 * @param checkedIds その日に ✔ のある職員の id
 * @param attendanceIds その日の出勤者の欄の職員の id
 */
export function buildReadCheckView(args: {
  day: string
  today: string
  staff: readonly ReadCheckStaff[]
  duty: DutyTable | null
  dailyKeys: ReadonlySet<string> | null
  rosterKeys?: ReadonlySet<string> | null
  checkedIds: ReadonlySet<number>
  attendanceIds: ReadonlySet<number>
}): ReadCheckView {
  const { day, today, staff, duty, dailyKeys, checkedIds, attendanceIds } = args
  const row = duty?.get(day) ?? null
  const base = readCheckMembers(staff, dailyKeys, args.rosterKeys ?? null)
  // 確認欄には、✔ を付けた人と出勤者の欄の人も必ず並べる（並びの外の人が付けた ✔ を隠さない）
  const listedIds = new Set(base.map((s) => s.id))
  const members0 = staff.filter((s) => listedIds.has(s.id) || checkedIds.has(s.id) || attendanceIds.has(s.id))

  let source: ReadCheckSource
  if (day > today) source = 'future'
  else if (day < READ_CHECK_FROM) source = 'before'
  else if (row) source = 'shift'
  else if (attendanceIds.size > 0) source = 'attendance'
  else source = 'none'

  const members = members0.map((s) => {
    let d: DutyStatus | 'attendance' | 'nomatch' | null = null
    if (source === 'shift' && row) {
      const v = row.get(nameKey(s.name))
      d = v === undefined ? 'nomatch' : v
    } else if (source === 'attendance') {
      d = attendanceIds.has(s.id) ? 'attendance' : null
    }
    return { id: s.id, name: s.name, checked: checkedIds.has(s.id), duty: d }
  })

  const unread: { id: number; name: string }[] = []
  const undetermined: { id: number; name: string }[] = []
  for (const m of members) {
    if (m.checked) continue
    if (m.duty === 'duty' || m.duty === 'attendance') unread.push({ id: m.id, name: m.name })
    else if (source === 'shift' && (m.duty === 'unknown' || m.duty === 'nomatch')) undetermined.push({ id: m.id, name: m.name })
  }
  return { members, unread, undetermined, source, stale: day < shiftIso(today, -READ_CHECK_FIELD_DAYS) }
}

/** 誤りの文から、確認欄の書き込みの失敗の種類を決める（画面の案内の取り違えを防ぐ） */
export function readCheckErrorKind(err: unknown): 'missing' | 'past' | 'future' | 'dup' | 'other' {
  const e = err as { code?: unknown; message?: unknown } | null
  const code = typeof e?.code === 'string' ? e.code : ''
  const msg = typeof e?.message === 'string' ? e.message : ''
  if (code === '42P01' || code === 'PGRST205' || /daily_read_checks/.test(msg) && /does not exist|schema cache/i.test(msg)) return 'missing'
  if (code === '23505') return 'dup'
  if (/read_check_past_office_only:/.test(msg)) return 'past'
  if (/read_check_future:/.test(msg)) return 'future'
  return 'other'
}

// ── 未読者欄（ページの上に1つ・2026-11-19 代表者の指示）──────────────────────────────
// - 今日の日報は書いている途中なので数えない。数えるのは昨日まで（前日分から）。
// - 日報 R を読む人（時間差）: R の夜勤入りの人（夜勤は当日の日中の分から読む）と、R の翌日に日勤の人（日勤は前日の分を読む）。
//   どちらも施設の勤務だけ（shiftDuty.ts の buildFacilityDutyTable）。デイ職員（主の区分が通所）と、勤務表の名簿に居ない人（厨房など）は数えない。
// - 休みの日は読む日に数えない（休み明けの勤務の日に、その前日の分の ✔ が無ければ未読）＝仮置きのまま。
// - 数える日: 確認欄を始めた日（READ_CHECK_FROM）から、現場が ✔ を付けられる14日前まで。
// - R か R の翌日の勤務表（予定）が無い日・読めない記号の人がいる日は「判定できない」に数える（「未読者なし」と言い切らない）。
// - 勤務表が読めない時は判定しない（以前の「出勤者の欄で判定」は、前日分の数え方に合わないのでやめた＝仮置き）。

export interface UnreadPerson {
  id: number
  name: string
  /** 未読の日（古い順） */
  days: string[]
}

export interface UnreadSummary {
  /** 数えた日（古い順・昨日まで） */
  window: string[]
  /** 未読の人（staff の並び順） */
  people: UnreadPerson[]
  /** 日 → その日の未読の人の id */
  byDay: Map<string, Set<number>>
  /** 判定できない日（勤務表が無い・読めない記号の人がいる） */
  undeterminedDays: string[]
  /** 勤務表の名簿で名前が見つからない職員の人数（勤務表から同期した人＝hire_order がある人だけ。数えていないことを知らせる・氏名は出さない） */
  unmatched: number
}

/** 数える日（古い順）。今日の前日まで・始めた日から・14日前まで */
export function unreadWindow(today: string): string[] {
  const out: string[] = []
  const from = shiftIso(today, -READ_CHECK_FIELD_DAYS)
  const start = from > READ_CHECK_FROM ? from : READ_CHECK_FROM
  for (let d = start; d < today; d = shiftIso(d, 1)) out.push(d)
  return out
}

/** 勤務表を読むのに要る日（数える日と、その翌日＝最後は今日） */
export function unreadDutyDays(today: string): string[] {
  const w = unreadWindow(today)
  return w.length === 0 ? [] : [...w, today]
}

export function buildUnreadSummary(args: {
  today: string
  staff: readonly ReadCheckStaff[]
  duty: FacilityDutyTable | null
  checks: ReadonlyMap<string, ReadonlySet<number>>
  /** 勤務表の名簿の全員（在籍）の氏名の鍵（読めない時は null） */
  rosterKeys?: ReadonlySet<string> | null
  /** 主の区分が通所（デイ職員）の氏名の鍵。同じ氏名の施設の職員がいても数えない（代表者の指示「デイ職員は氏名を出さない」を先にする） */
  dayKeys?: ReadonlySet<string> | null
}): UnreadSummary {
  const { today, staff, duty, checks } = args
  const rosterKeys = args.rosterKeys ?? null
  const dayKeys = args.dayKeys ?? null
  const window = unreadWindow(today)
  const byDay = new Map<string, Set<number>>()
  const undeterminedDays: string[] = []
  const per = new Map<number, string[]>()
  for (const r of window) {
    const rowR = duty?.get(r) ?? null
    const rowN = duty?.get(shiftIso(r, 1)) ?? null
    if (!rowR || !rowN) {
      undeterminedDays.push(r)
      continue
    }
    const checked = checks.get(r) ?? new Set<number>()
    const ids = new Set<number>()
    let unknown = false
    for (const s of staff) {
      const k = nameKey(s.name)
      if (!k || dayKeys?.has(k)) continue
      const a = rowR.get(k)
      const b = rowN.get(k)
      if (a === undefined && b === undefined) continue // 勤務表の名簿に居ない・デイ職員
      const must = !!a?.nightIn || !!b?.work
      if (!must) {
        if (a?.unknown || b?.unknown) unknown = true
        continue
      }
      if (checked.has(s.id)) continue
      ids.add(s.id)
      const list = per.get(s.id) ?? []
      list.push(r)
      per.set(s.id, list)
    }
    byDay.set(r, ids)
    if (unknown) undeterminedDays.push(r)
  }
  const people: UnreadPerson[] = []
  const seen = new Set<number>()
  for (const s of staff) {
    const d = per.get(s.id)
    if (!d || seen.has(s.id)) continue
    seen.add(s.id)
    people.push({ id: s.id, name: s.name, days: d })
  }
  const unmatched =
    rosterKeys === null || window.length === 0
      ? 0
      : staff.filter((s) => s.hire_order !== null && s.hire_order !== undefined && !rosterKeys.has(nameKey(s.name))).length
  return { window, people, byDay, undeterminedDays: [...new Set(undeterminedDays)].sort(), unmatched }
}
