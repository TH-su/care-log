// 日報の出勤者の欄の自動入力・苗字の表示・未読の人の赤い氏名枠を決める純粋な部品（2026-11-19 代表者の指示）。
//
// 代表者の指示: その日の出勤者は勤務表から出勤時刻の30分前に苗字が入るようにし、前日までの日報に ✔ を付けていない人は出勤時刻に
// 氏名枠を赤くする。赤い枠を押すと未読の日が出て、日を押すとその日へ移る。
// 決まりの変更: 2026-11-07 の決定「勤務表から日報の出勤者の欄への自動の書き写しはしない」を、この指示で置き換えた。
//   - 対象は今日の日報だけ。施設の勤務（shiftDuty.ts の buildFacilityDutyTable）で日勤の部分か夜勤入りがある職員。
//   - 出勤時刻（日勤は workStart・夜勤は nightStart・両方あれば早い方・分からない時は 0:00）の30分前を過ぎたら入れる。
//   - 足すだけ: その日・その職員の行が既にあれば（取り消し済み＝sort < 0 も含む）入れない＝人が外した人を戻さない。
// 個人情報: 職員の id と氏名だけを扱う（勤務記号は持たない）。console・localStorage に出さない。

import type { FacilityDuty } from './shiftDuty.ts'
import { nameKey } from './shiftDuty.ts'
import { READ_CHECK_LEAD_MIN } from './readCheck.ts'
import { surnameOf } from './noteGroup.ts'

/** 出勤者の行（attendance の使う項目だけ） */
export interface AttendRow {
  staff_id: number
  role: 'manager' | 'staff'
  sort: number
}

/**
 * その人の今日の出勤時刻（0時からの分）。日勤の部分と夜勤入りの早い方。時刻が分からない部分は 0:00 とみなす。
 * 施設の勤務が無い（休み・空欄・読めない）時は null。
 */
export function attendStartMin(f: FacilityDuty | undefined | null): number | null {
  if (!f) return null
  let out: number | null = null
  if (f.work) out = f.workStart ?? 0
  if (f.nightIn) {
    const n = f.nightStart ?? 0
    out = out === null ? n : Math.min(out, n)
  }
  return out
}

/** 在籍の職員の氏名の鍵 → 職員（同じ鍵の職員が2人以上いる鍵は入れない＝取り違えるので自動では入れない） */
function uniqueByKey<T extends { id: number; name: string }>(staff: readonly T[]): Map<string, T> {
  const seen = new Map<string, T | null>()
  for (const s of staff) {
    const k = nameKey(s.name)
    if (!k) continue
    seen.set(k, seen.has(k) ? null : s)
  }
  const out = new Map<string, T>()
  for (const [k, s] of seen) if (s !== null) out.set(k, s)
  return out
}

/**
 * 今日の日報の出勤者の欄へ自動で足す行を決める。
 * @param day 日報の日。today と違えば何も足さない
 * @param nowMin 今の時刻（今日の0時からの分）
 * @param staff ケアログの在籍の職員（氏名を勤務表の氏名と nameKey で突き合わせる。突き合わない人は入れない）
 * @param duty その日の施設の勤務（氏名の鍵 → 施設の勤務）。読めない時は null＝何も足さない
 * @param existing その日の出勤者の行（取り消し済み＝sort < 0 も渡してよい。ある人は足さない）
 * @param managerStaffId 設定の施設長（その日にまだ施設長の行が無ければ施設長として足す）
 * @param skip 足さない職員（この画面で一度送った人など）
 * @returns 足す行（出勤時刻の早い順・sort は既存の最大＋1 から）
 */
export function planAutoAttendance(args: {
  day: string
  today: string
  nowMin: number
  staff: readonly { id: number; name: string; active?: boolean }[]
  duty: ReadonlyMap<string, FacilityDuty> | null | undefined
  existing: readonly AttendRow[]
  managerStaffId: number | null
  skip?: ReadonlySet<number>
}): AttendRow[] {
  const { day, today, nowMin, duty, existing, managerStaffId } = args
  if (day !== today || !duty) return []
  const have = new Set(existing.map((a) => a.staff_id))
  const byKey = uniqueByKey(args.staff.filter((s) => s.active !== false))
  const due: { id: number; start: number; order: number }[] = []
  let order = 0
  for (const [k, s] of byKey) {
    order += 1
    if (have.has(s.id) || args.skip?.has(s.id)) continue
    const start = attendStartMin(duty.get(k))
    if (start === null) continue
    if (nowMin < start - READ_CHECK_LEAD_MIN) continue
    due.push({ id: s.id, start, order })
  }
  due.sort((a, b) => a.start - b.start || a.order - b.order)
  let sort = existing.reduce((m, a) => (Number.isInteger(a.sort) && a.sort > m ? a.sort : m), -1) + 1
  let managerFree = !existing.some((a) => a.role === 'manager' && a.sort >= 0)
  const out: AttendRow[] = []
  for (const d of due) {
    const asManager = managerFree && managerStaffId !== null && d.id === managerStaffId
    if (asManager) managerFree = false
    out.push({ staff_id: d.id, role: asManager ? 'manager' : 'staff', sort })
    sort += 1
  }
  return out
}

/**
 * 出勤者・施設長の欄に出す名前（並びは渡した順）。苗字で出し、同じ苗字が2人以上いる時はその人たちだけ氏名のまま。
 * @param asIs 縮めずにそのまま出す名前（名簿に無い職員の「職員ID n」など。苗字の数にも入れない）
 */
export function attendDisplayNames(names: readonly string[], asIs?: readonly boolean[]): string[] {
  const keep = (i: number) => asIs?.[i] === true
  const sur = names.map((n, i) => (keep(i) ? n : surnameOf(n) || n))
  const count = new Map<string, number>()
  sur.forEach((s, i) => {
    if (!keep(i)) count.set(s, (count.get(s) ?? 0) + 1)
  })
  return names.map((n, i) => (keep(i) ? n : (count.get(sur[i]) ?? 0) > 1 ? n : sur[i]))
}

/**
 * 出勤者の〔元に戻す〕で送る一覧（2026-11-19 反証 medium1）。外す前の一覧をそのまま送ると、その後に自動入力・ほかの端末が足した人が
 * 外されて（sort < 0）二度と自動では入らない。そこで「今の一覧」から組み直し、この操作で変えた所だけを戻す:
 *   - この操作で外した人（before にいて after にいない）を元の役割で戻す（今の一覧に別の施設長がいれば職員として戻す）
 *   - この操作で足した人（after にいて before にいない＝施設長の入れ替えで選んだ人）を外す
 *   - この操作で役割を変えた人の役割を元に戻す
 *   - それ以外の今の一覧の人（自動で入った人・ほかの端末が足した人）はそのまま残す
 * @param before 操作の前の一覧
 * @param after 操作で送った一覧
 * @param current 戻す時点の一覧
 */
export function undoAttendanceRows<T extends AttendRow>(before: readonly T[], after: readonly T[], current: readonly T[]): T[] {
  const afterBy = new Map(after.map((a) => [a.staff_id, a]))
  const beforeBy = new Map(before.map((a) => [a.staff_id, a]))
  const out: T[] = []
  for (const c of current) {
    const b = beforeBy.get(c.staff_id)
    const a = afterBy.get(c.staff_id)
    if (b === undefined && a !== undefined) continue // この操作で足した人
    if (b !== undefined && a !== undefined && a.role !== b.role && c.role === a.role) out.push({ ...c, role: b.role })
    else out.push(c)
  }
  const have = new Set(out.map((a) => a.staff_id))
  before.forEach((b, i) => {
    if (afterBy.has(b.staff_id) || have.has(b.staff_id)) return
    const managerTaken = out.some((a) => a.role === 'manager')
    const row = b.role === 'manager' && managerTaken ? { ...b, role: 'staff' as const } : b
    out.splice(Math.min(i, out.length), 0, row)
    have.add(b.staff_id)
  })
  // 施設長は1人（役割を戻した結果2人になった時は、先の人を残す）
  let seen = false
  return out.map((a) => {
    if (a.role !== 'manager') return a
    if (!seen) {
      seen = true
      return a
    }
    return { ...a, role: 'staff' as const }
  })
}

/**
 * 出勤者・施設長の欄で赤くする人（id → 未読の日・古い順）。今日の日報だけ。
 * 未読者（buildUnreadSummary の people）のうち、前日までの日報に ✔ の無い日があり、今の時刻がその人の今日の出勤時刻
 * （30分前ではなく出勤時刻そのもの）以降の人。今日の勤務が勤務表に無い（手で足した）人は、出勤者の欄にいる＝来ているので赤くする（仮置き）。
 * @param ids 出勤者・施設長の欄の職員
 * @param duty 今日の施設の勤務（氏名の鍵 → 施設の勤務）。null＝読めない（時刻が分からないので出勤者の欄にいれば赤くする）
 */
export function attendRedDays(args: {
  day: string
  today: string
  nowMin: number
  ids: readonly number[]
  people: readonly { id: number; name: string; days: readonly string[] }[] | null | undefined
  duty: ReadonlyMap<string, FacilityDuty> | null | undefined
}): Map<number, string[]> {
  const out = new Map<number, string[]>()
  const { day, today, nowMin, people, duty } = args
  if (day !== today || !people) return out
  const onSheet = new Set(args.ids)
  for (const p of people) {
    if (!onSheet.has(p.id)) continue
    const days = p.days.filter((d) => d < today)
    if (days.length === 0) continue
    const start = attendStartMin(duty?.get(nameKey(p.name)))
    if (start !== null && nowMin < start) continue
    out.set(p.id, days)
  }
  return out
}
