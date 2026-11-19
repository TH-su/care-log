// 日報の確認欄（その日の日報を読んだ ✔）と未読者欄を組み立てる純粋な部品（2026-11-19 本人指示）。
//
// 決まり（docs は ROOT.md・仮置きを含む）:
//   - 確認欄に並べる職員: ケアログの在籍の職員のうち、勤務表で日報の対象（施設・通所）の職員。勤務表が読めない時は、
//     勤務表の名簿から同期した職員（hire_order がある＝事務職員など手で足した人を除く）。どの職員にも hire_order が無い
//     （古いサーバー）時は在籍の職員全員。
//   - 未読者: その日に勤務表で勤務の職員のうち、その日の ✔ が無い人。休み・空欄の日は未読者に出さない
//     ＝休み明けの勤務の日に ✔ が無ければ未読者に出る。
//   - 勤務表が読めない・その月の勤務表が無い日は、その日の日報の出勤者の欄に入っている人を勤務とみなす（出勤者で判定）。
//     出勤者の欄も空なら判定しない（未読者を出さず、目立たせない）。
//   - 勤務表で読めない記号の人・勤務表に名前が見つからない人（確認欄には並ぶ）は「判定できない」に数え、未読者には出さない。
//   - まだ来ていない日は判定しない。
// 個人情報: 職員の id と氏名だけを扱う（勤務記号は持たない）。

import type { DutyStatus, DutyTable } from './shiftDuty.ts'
import { nameKey } from './shiftDuty.ts'

export interface ReadCheckStaff {
  id: number
  name: string
  hire_order?: number | null
}

/** 判定のもと */
export type ReadCheckSource = 'shift' | 'attendance' | 'none' | 'future'

export interface ReadCheckView {
  /** 確認欄に並べる職員（並びは渡された職員の並び） */
  members: { id: number; name: string; checked: boolean; duty: DutyStatus | 'attendance' | 'nomatch' | null }[]
  /** 未読者（勤務なのに ✔ が無い人） */
  unread: { id: number; name: string }[]
  /** 判定できない人（✔ が無く、勤務表の記号が読めない・名前が勤務表に無い） */
  undetermined: { id: number; name: string }[]
  source: ReadCheckSource
}

/** 確認欄に並べる職員 */
export function readCheckMembers(staff: readonly ReadCheckStaff[], dailyKeys: ReadonlySet<string> | null): ReadCheckStaff[] {
  if (dailyKeys) return staff.filter((s) => dailyKeys.has(nameKey(s.name)))
  const rostered = staff.filter((s) => s.hire_order !== null && s.hire_order !== undefined)
  return rostered.length > 0 ? rostered : [...staff]
}

/**
 * 1日ぶんの確認欄と未読者を組み立てる。
 * @param day 日報の日（'YYYY-MM-DD'）
 * @param today JST の今日（'YYYY-MM-DD'）
 * @param staff 在籍の職員（確認欄の並び順）
 * @param duty 勤務表から作った表（読めない時は null）
 * @param dailyKeys 勤務表で日報の対象の職員の氏名の鍵（表示中のどの日かで対象の人。読めない時は null）
 * @param checkedIds その日に ✔ のある職員の id
 * @param attendanceIds その日の出勤者の欄の職員の id
 */
export function buildReadCheckView(args: {
  day: string
  today: string
  staff: readonly ReadCheckStaff[]
  duty: DutyTable | null
  dailyKeys: ReadonlySet<string> | null
  checkedIds: ReadonlySet<number>
  attendanceIds: ReadonlySet<number>
}): ReadCheckView {
  const { day, today, staff, duty, dailyKeys, checkedIds, attendanceIds } = args
  const row = duty?.get(day) ?? null
  const base = readCheckMembers(staff, dailyKeys)
  // 確認欄には、✔ を付けた人と出勤者の欄の人も必ず並べる（並びの外の人が付けた ✔ を隠さない）
  const listedIds = new Set(base.map((s) => s.id))
  const members0 = staff.filter((s) => listedIds.has(s.id) || checkedIds.has(s.id) || attendanceIds.has(s.id))

  let source: ReadCheckSource
  if (day > today) source = 'future'
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
  return { members, unread, undetermined, source }
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
