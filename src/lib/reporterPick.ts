// 申し送りの記入者を選ぶ窓の「この日の出勤者」（2026-11-07 代表者の決定）。
// ・日勤・デイの記録で記入者を選ぶ時は、その日の日報の出勤者の欄に名前を入れた職員だけを先に出し、1タップで選べるようにする
//   （窓の中身を絞るだけ。窓の「ほかの職員から選ぶ」で今までどおり全員も出せる）
// ・夜勤は今までどおり（記入者は空欄のまま・選ぶ窓も全員）。夜勤の職員は出勤者の欄に区別が無いため
// ・出勤者がまだ入っていない日は、今までどおり全職員から選ぶ（書くのを止めない）
// ・純関数（画面・通信に触れない）。氏名は渡された名簿から引くだけで、残さない
//
// 拡張子付きで import する（tests の node --experimental-strip-types から直接読めるようにするため）
import type { Attendance, Shift, Staff } from './types.ts'

/**
 * その日の出勤者の欄に名前を入れた職員（在籍の職員だけ）。並びは施設長 → 出勤者（欄の順）。
 * 取り消した行（sort < 0）・ほかの日の行・名簿に居ない職員・重なりは除く
 */
export function attendanceStaff(staff: readonly Staff[], attendance: readonly Attendance[], day: string): Staff[] {
  const byId = new Map<number, Staff>()
  for (const s of staff) if (s && s.active) byId.set(s.id, s)
  const rows = attendance
    .filter((a) => a && a.day === day && typeof a.sort === 'number' && a.sort >= 0)
    .slice()
    .sort((a, b) => {
      const ra = a.role === 'manager' ? 0 : 1
      const rb = b.role === 'manager' ? 0 : 1
      if (ra !== rb) return ra - rb
      if (a.sort !== b.sort) return a.sort - b.sort
      return a.staff_id - b.staff_id
    })
  const out: Staff[] = []
  const seen = new Set<number>()
  for (const a of rows) {
    const s = byId.get(a.staff_id)
    if (!s || seen.has(s.id)) continue
    seen.add(s.id)
    out.push(s)
  }
  return out
}

/**
 * 記入者を選ぶ窓に先に出す職員。夜勤は null（今までどおり全員を出す）。
 * 出勤者が0人の日も null（全職員から選ぶ）
 */
export function reporterPrimary(
  shift: Shift | null | undefined,
  staff: readonly Staff[],
  attendance: readonly Attendance[],
  day: string,
): Staff[] | null {
  if (shift === 'night') return null
  const list = attendanceStaff(staff, attendance, day)
  return list.length > 0 ? list : null
}
