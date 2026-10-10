// 夜勤明けに前日の欄へ書き足した記録の時刻と「翌」（F34・2026-10-10 本人裁定）。
//
// 裁定: 記録の帰属日は暦の日付のまま。夜勤明け（0:00〜NIGHT_END_HOUR 時前）に前日の欄（日報の前日の夜勤欄・
// バイタル／食事の一覧と一括の前日の列）へ書き足した記録は、書いた時刻を入れ、画面では「翌2:00」と出し、
// その日の夜の記録の後ろに並べる。申し送り・バイタル・水分の3つを同じ規則にそろえる。
//
// 「翌」の判定（保存する時刻は HH:MM のまま。DB の time 型は 24 時以上を持てない）:
//   時刻が NIGHT_END_HOUR 時より前 かつ 行のサーバーの作成時刻（created_at・0001 からある列）が
//   「記録日の翌日の 0:00〜NIGHT_END_HOUR 時（＋届くまでの猶予 ARRIVAL_GRACE_MIN 分）」に入っている。
//   ・その日の早朝（暦どおりその日の 0〜9 時）に書いた記録は、作成時刻が記録日の当日なので「翌」にならない
//   ・翌日の昼に前日の行を作り、時刻を手で入れた記録（前日の朝の後入れ）も「翌」にならない
//   ・時刻を自動で入れるのは行を作る時だけ（バイタルの既にある行は 0011 の coalesce で時刻を上書きしない・
//     水分と申し送りは1回=1行）なので、行の作成時刻が時刻を入れた時刻になる
//   ・作成時刻が分からない行（送信待ちの重ね行・作成時刻を返さない経路）は「翌」なし＝従来の表示
// 作成時刻は db.ts の読み取り（normalize*）が rememberCreatedAt でここへ控える（行の型 types.ts は凍結契約のため、
// 行そのものには載せない。created_at は id ごとに変わらないので、id で引けば足りる）。
// 個人情報は扱わない（id と時刻だけ）。

import type { Shift } from './types'

/** 夜勤明けの時刻（この時刻より前は、前日の夜勤の続き）。申し送りフォームの勤務帯の既定（9時から日勤）と同じ */
export const NIGHT_END_HOUR = 9
/** 書いてからサーバーに届くまでの猶予（分）。8:59 に書いて 9:00 過ぎに届いた行を「翌」から外さない */
export const ARRIVAL_GRACE_MIN = 10

/** 作成時刻を控える表（created_at を持つ業務表のうち、時刻の欄を持つ3表） */
export type StampTable = 'notes' | 'vitals' | 'fluid_intake'

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 端末の現地時刻の YYYY-MM-DD（format.ts の todayIso と同じ基準） */
function localIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 'HH:MM'（端末の現地時刻） */
function localHM(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 'YYYY-MM-DD' の n 日後（端末の時差に依らない） */
function addDaysUtc(iso: string, n: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n))
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}

/** 'HH:MM[:SS]' → 0時からの分（読めなければ null） */
function minutesOf(time: string | null | undefined): number | null {
  if (typeof time !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})/.exec(time)
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h > 23 || mm > 59) return null
  return h * 60 + mm
}

// ── 書く時の時刻 ─────────────────────────────────────────────

/**
 * バイタル・水分の新しい記録に入れる時刻。
 * ・記録日が今日: 今の時刻
 * ・記録日が前日で、夜勤明け（NIGHT_END_HOUR）より前に書いた: 今の時刻（画面では「翌」を付けて出す）
 * ・それ以外の過去日: 空（さかのぼって書く時の端末の現在時刻は実際の時刻ではない＝従来どおり）
 */
export function recordTimeFor(day: string, now: Date = new Date()): string | null {
  if (day === localIso(now)) return localHM(now)
  const yesterday = localIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  if (day === yesterday && now.getHours() < NIGHT_END_HOUR) return localHM(now)
  return null
}

/**
 * 申し送りに入れる時刻。前日の欄で時刻を入れるのは夜勤の欄だけ（日勤・デイの前日の欄は従来どおり空）。
 * 日報（DailySheetPage）と申し送りフォーム（NoteFormPage）の登録が使う
 */
export function noteTimeFor(day: string, shift: Shift, now: Date = new Date()): string | null {
  if (day === localIso(now)) return localHM(now)
  return shift === 'night' ? recordTimeFor(day, now) : null
}

// ── 「翌」の判定 ─────────────────────────────────────────────

/**
 * 記録日 day・時刻 time・作成時刻 createdAt（timestamptz の ISO 文字列）から「翌」かを決める（純関数）。
 * 作成時刻は日本時間（UTC+9 固定。業務日付と同じ）で読む
 */
export function isNextMorningAt(
  day: string,
  time: string | null | undefined,
  createdAt: string | null | undefined,
): boolean {
  const t = minutesOf(time)
  if (t === null || t >= NIGHT_END_HOUR * 60) return false
  if (typeof createdAt !== 'string' || createdAt === '') return false
  const ms = Date.parse(createdAt)
  if (!Number.isFinite(ms)) return false
  const jst = new Date(ms + 9 * 60 * 60 * 1000)
  const createdDay = `${jst.getUTCFullYear()}-${pad2(jst.getUTCMonth() + 1)}-${pad2(jst.getUTCDate())}`
  if (createdDay !== addDaysUtc(day, 1)) return false
  return jst.getUTCHours() * 60 + jst.getUTCMinutes() < NIGHT_END_HOUR * 60 + ARRIVAL_GRACE_MIN
}

/** 控える件数の上限（長く開いたままの端末でも膨らみ続けないように。超えたら古い順に捨てる＝「翌」なしへ倒れるだけ） */
const STAMP_CAP = 50_000
const stamps = new Map<string, string>()

/** 行の作成時刻を控える（db.ts の読み取りが呼ぶ。読めない値は控えない） */
export function rememberCreatedAt(table: StampTable, id: number, createdAt: unknown): void {
  if (typeof createdAt !== 'string' || createdAt === '' || !Number.isFinite(Date.parse(createdAt))) return
  const key = `${table}#${id}`
  if (stamps.get(key) === createdAt) return
  stamps.delete(key)
  stamps.set(key, createdAt)
  if (stamps.size > STAMP_CAP) {
    const oldest = stamps.keys().next().value
    if (oldest !== undefined) stamps.delete(oldest)
  }
}

/** 控えた作成時刻（無ければ null） */
export function createdAtOf(table: StampTable, id: number): string | null {
  return stamps.get(`${table}#${id}`) ?? null
}

/** 申し送りが「翌」か（夜勤の申し送りだけ。日勤・デイは前日の欄に時刻を入れないので対象外） */
export function noteIsNextMorning(n: { id: number; note_on: string; shift: Shift; occurred_at: string | null }): boolean {
  return n.shift === 'night' && isNextMorningAt(n.note_on, n.occurred_at, createdAtOf('notes', n.id))
}

/** バイタルが「翌」か */
export function vitalIsNextMorning(v: { id: number; measured_on: string; measured_at: string | null }): boolean {
  return isNextMorningAt(v.measured_on, v.measured_at, createdAtOf('vitals', v.id))
}

/** 水分が「翌」か */
export function fluidIsNextMorning(f: { id: number; taken_on: string; taken_at: string | null }): boolean {
  return isNextMorningAt(f.taken_on, f.taken_at, createdAtOf('fluid_intake', f.id))
}

// ── 表示と並び ───────────────────────────────────────────────

/** '02:00:00' → '2:00'、翌なら '翌2:00'。時刻なしは ''（format.ts の fmtTimeHM と同じ書き方） */
export function fmtRecordTime(time: string | null | undefined, nextMorning: boolean): string {
  if (!time) return ''
  const [h, m] = time.split(':')
  const hm = `${Number(h)}:${m}`
  return nextMorning ? `翌${hm}` : hm
}

/**
 * 並べ替えに使う時刻。翌は時に 24 を足す（'02:00:00' → '26:00:00'）＝その日の夜の記録の後ろに並ぶ。
 * 時刻なしは null のまま（時刻なしの置き場所は各画面の従来どおり）
 */
export function timeSortKey(time: string | null, nextMorning: boolean): string | null {
  if (time === null || !nextMorning) return time
  const m = /^(\d{1,2})(:.*)$/.exec(time)
  if (!m) return time
  return `${pad2(Number(m[1]) + 24)}${m[2]}`
}
