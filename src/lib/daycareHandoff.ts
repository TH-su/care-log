// デイ（せせらぎ）から排泄ケアアプリ（haiben-record）のデイの表示への受け渡し（2026-10-24 代表者の決定 §9.7・§9.8）。
//
// 排泄ケアアプリにデイの表示を足し（haiben-record #2）、デイの排泄は排泄ケアアプリそのもので記録する。care-log はその日の方の一覧だけを
// 同じサイト（th-su.github.io）の localStorage で渡す。排泄ケアアプリはこのキーを読むだけ（hbDcParse・書かない・消さない）。
//
// 受け渡しの決まり（両方のアプリで同じ値を確かめる＝tests/daycare-handoff.test.mjs が排泄ケアアプリの hbDcParse で読む）:
// - キー: su_daycare_handoff_v1／中身: {"v":1,"day":"YYYY-MM-DD","at":<書いた時刻のミリ秒>,"mids":[<residents.source_id>…]}
// - mids は一括の画面に出す方（予定の方のうち休み・入院中を除く全員＋予定外で来た方＝daycareBulkSourceIds）。氏名・居室・記録は入れない
// - 書くのは今日の一覧の時だけ（過去の日を見ている時は書かない）。サーバーに届かず控えで開いた今日の一覧からは書いてよい
// - 書く時: 今日の画面がその日の一覧を作るたび（開いた時・休みとその取り消し・〔元に戻す〕の後）と、〔排泄〕を押した直前
// - ログアウトで消す（App の後片付け＝daycareHandoffKey.ts。次にログインした人へ前の一覧を渡さない）。記録者の切り替えでは消さない
// 規律: 置き場は localStorage だけ。書けない端末（保存が止められている）では黙って書かない（排泄ケアアプリが「キーが無い」と出す）

import { daycareBulkSourceIds } from './daycare.ts'
import type { DaycareBoardRow } from './daycare.ts'
import type { Resident } from './types.ts'
import { DAYCARE_HANDOFF_KEY } from './daycareHandoffKey.ts'

export { DAYCARE_HANDOFF_KEY, clearDaycareHandoff } from './daycareHandoffKey.ts'

/** 排泄ケアアプリのデイの表示（同じタブで開く。care-log と同じサイトの haiben-record 配下） */
export const HAIBEN_DAYCARE_HREF = '../haiben-record/haiben-record.html?view=daycare'

export interface DaycareHandoff {
  v: 1
  day: string
  at: number
  mids: string[]
}

/**
 * 受け渡しの中身を作る（純関数）。今日の一覧の時だけ作り、過去の日・名簿が読めていない時（source_id を引けない）は null＝書かない
 */
export function buildDaycareHandoff(p: {
  day: string
  today: string
  rows: readonly Pick<DaycareBoardRow, 'residentId' | 'state' | 'planned' | 'hospitalized'>[]
  residents: readonly Pick<Resident, 'id' | 'source_id'>[]
  now: number
}): DaycareHandoff | null {
  if (p.day !== p.today || !/^\d{4}-\d{2}-\d{2}$/.test(p.day)) return null
  if (p.residents.length === 0) return null
  return { v: 1, day: p.day, at: p.now, mids: daycareBulkSourceIds(p.rows, p.residents) }
}

/** 受け渡しのキーを書く（書けなければ false・画面は止めない） */
export function writeDaycareHandoff(h: DaycareHandoff | null): boolean {
  if (h === null) return false
  try {
    window.localStorage.setItem(DAYCARE_HANDOFF_KEY, JSON.stringify(h))
    return true
  } catch {
    return false
  }
}

/**
 * 画面の一覧から作って書く（〔排泄〕を押した直前・今日の画面の一覧が変わった時）。boardDay は「その一覧を読んだ日」
 * （画面の data.day）。画面の日付（URL・日付の切り替え）ではなく一覧の日で決める: 日付を切り替えた直後・日をまたいだ直後で、
 * 新しい日を読み終わる前（圏外で読めない間も）の前の日の一覧を「今日」として渡さない（反証 重1）。一覧がまだ無い・今日でない時は書かない
 */
export function writeDaycareHandoffFor(p: {
  rows: readonly Pick<DaycareBoardRow, 'residentId' | 'state' | 'planned' | 'hospitalized'>[] | null
  residents: readonly Pick<Resident, 'id' | 'source_id'>[]
  boardDay: string | null
  today: string
}): boolean {
  if (p.rows === null || p.boardDay === null) return false
  return writeDaycareHandoff(buildDaycareHandoff({ day: p.boardDay, today: p.today, rows: p.rows, residents: p.residents, now: Date.now() }))
}
