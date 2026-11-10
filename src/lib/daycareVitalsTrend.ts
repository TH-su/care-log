// デイ（せせらぎ）計画F: 1人の画面のバイタルの推移（直近の回）の小さなグラフの判断（純関数・副作用なし・DB/DOM に触れない）。2026-11-10。
// tests/daycare-vitals-trend.test.mjs から node で直接読む（拡張子付きで import する）。
//
// ・回: その方のデイの測定（client_key 'dc:<日>:<利用者id>:<回>' の生きている行）のうち、5欄のどれかに値のある行を1回と数える
//   （今日の再測定の回も1回）。新しい方から TREND_ROUNDS 回。並びは 日 → 回の番号 → id の古い順（グラフは左が古い）。
//   表示中の日の回は1人の画面が読んだ行（上のバイタルの要約と同じ行）、それより前の日の回は fetchDaycareVitalsTrend の行を使う
// ・横軸は回の順に等間隔（日付の間が空いても詰める）。値の無い回は点を置かず線を切る（つながない）
// ・基準外は連絡帳と同じ判定（vitalLevel＝連絡帳の vitalNeedsRecheck の中身）。基準はその回の日のその方の基準（useVitalLimits の lookup を
//   画面から受ける）・SpO2 は個別の目標。新しい基準は作らない
// ・〔未測定〕の印（0062）は値の無い欄だけ「未測定」（値があれば値＝印は無視。連絡帳の紙面と同じ）。点は置かない。
//   印を読めなかった時は、値の無い欄を「読み込めませんでした」（「記録なし」と取り違えない）
// ・縦軸と目盛はカルテのグラフと同じ部品（chart.ts の KARTE_AXES・chartDomain・chartTicks）
// 個人情報は扱わない（数値と日付だけ）。

import { KARTE_AXES, chartDomain, chartTicks } from './chart.ts'
import type { AxisSpec } from './chart.ts'
import { DAYCARE_VITAL_FIELDS, LEVEL_WORD, parseDaycareVitalKey, vitalLevel } from './daycare.ts'
import type { DaycareVitalField, KeyedVital } from './daycare.ts'
import type { DaycareVitalUnmeasured } from './daycareProgress.ts'
import { UNMEASURED, UNREAD } from './daycareContact.ts'
import { LEVEL_MARK } from './types.ts'
import type { Level } from './types.ts'
import type { ResidentTargets } from './vitalAlerts.ts'
import type { VitalThresholds } from './vitalThresholds.ts'

/** グラフに出す回の数（直近の回）。iPad の2列（点の間 34px）・375px の1列（26px）で 10 回 */
export const TREND_ROUNDS = 10
/** 点の間の最小（px）。押した時に選ぶ幅（いちばん近い回）もこれ以上。狭い幅・大きな文字ではこれを保つように回を減らす */
export const TREND_MIN_GAP_PX = 20
/** 回を減らす時の下限 */
export const TREND_MIN_ROUNDS = 4

/**
 * グラフの描く幅（plotW＝最初の点から最後の点まで）に並べる回の数。点の間が minGap 以上になる数（TREND_MIN_ROUNDS〜TREND_ROUNDS）。
 * 例: iPad の2列・375px の1列は 10 回・375px で文字 200% は 4 回。表（〔数値で見る〕）も同じ回にする
 */
export function trendFitRounds(plotW: number, minGap: number = TREND_MIN_GAP_PX): number {
  if (!(plotW > 0) || !(minGap > 0)) return TREND_ROUNDS
  return Math.max(TREND_MIN_ROUNDS, Math.min(TREND_ROUNDS, Math.floor(plotW / minGap) + 1))
}

/** 値の無い欄（印なし）の表示 */
export const TREND_NONE = '—'

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土']

// ══════════════════════════════════════════════════════════════
// 回
// ══════════════════════════════════════════════════════════════

/** グラフ・表の1回 */
export interface TrendRound {
  /** 行の id */
  id: number
  /** 測った日（業務日） */
  day: string
  /** その日の回の番号（client_key の <回>） */
  seq: number
  /** 測った時刻（'9:30'。無ければ ''） */
  hm: string
  vals: Record<DaycareVitalField, number | null>
  /** 値の無い欄のうち〔未測定〕の印のある欄 */
  unmeasured: DaycareVitalField[]
}

type MarkLike = Pick<DaycareVitalUnmeasured, 'resident_id' | 'day' | 'seq' | 'field'>

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** '09:30:00' | '09:30' → '9:30'（無ければ ''） */
function hmOfTime(t: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? '')
  return m === null ? '' : `${Number(m[1])}:${m[2]}`
}

/**
 * グラフの回（古い順・最大 n 回）。
 * dayRows＝表示中の日の行（1人の画面が読んだ行・ほかの方・ほかの日の行が混ざってもその方のその日の分だけ使う）。
 * pastRows＝表示中の日より前の日の行（fetchDaycareVitalsTrend）。同じ id は表示中の日の行を優先する。
 * marks＝〔未測定〕の印（null＝読めなかった。その時は印なしとして回を作り、表の文は trendCellText が「読み込めませんでした」にする）
 */
export function trendRounds(
  dayRows: readonly KeyedVital[],
  pastRows: readonly KeyedVital[],
  residentId: number,
  day: string,
  marks: readonly MarkLike[] | null,
  n: number = TREND_ROUNDS,
): TrendRound[] {
  const seen = new Set<number>()
  const picked: TrendRound[] = []
  const take = (v: KeyedVital) => {
    if (v.resident_id !== residentId || seen.has(v.id)) return
    const key = parseDaycareVitalKey(v.client_key)
    if (key === null) return
    const vals: Record<DaycareVitalField, number | null> = {
      temp: numOrNull(v.temp),
      sys_bp: numOrNull(v.sys_bp),
      dia_bp: numOrNull(v.dia_bp),
      pulse: numOrNull(v.pulse),
      spo2: numOrNull(v.spo2),
    }
    // 値の無い行（打ちかけを消した行など）は測った回に数えない
    if (!DAYCARE_VITAL_FIELDS.some((f) => vals[f] !== null)) return
    seen.add(v.id)
    picked.push({ id: v.id, day: v.measured_on, seq: key.seq, hm: hmOfTime(v.measured_at), vals, unmeasured: [] })
  }
  for (const v of dayRows) if (v.measured_on === day) take(v)
  for (const v of pastRows) if (v.measured_on < day) take(v)
  picked.sort((a, b) => (a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.seq - b.seq || a.id - b.id))
  const out = n > 0 ? picked.slice(-n) : []
  if (marks !== null) {
    for (const r of out) {
      const fs = new Set<DaycareVitalField>()
      for (const m of marks) {
        if (m.resident_id === residentId && m.day === r.day && m.seq === r.seq && r.vals[m.field] === null) fs.add(m.field)
      }
      r.unmeasured = DAYCARE_VITAL_FIELDS.filter((f) => fs.has(f))
    }
  }
  return out
}

// ══════════════════════════════════════════════════════════════
// 判定（連絡帳と同じ vitalLevel・その回の日の基準）
// ══════════════════════════════════════════════════════════════

/** その回のその欄の判定（基準はその回の日のその方の基準＝limitsOf(その回の日)。SpO2 は個別の目標） */
export function trendLevel(
  round: Pick<TrendRound, 'day' | 'vals'>,
  field: DaycareVitalField,
  target: ResidentTargets | null | undefined,
  limitsOf: (day: string) => VitalThresholds,
): Level {
  const v = round.vals[field]
  if (v === null) return null
  return vitalLevel(field, v, target ?? null, limitsOf(round.day))
}

/** 判定の記号と言葉（今の1人の画面のバイタルの要約と同じ「↑ 注意・高い」） */
export function levelText(lv: Level): string | null {
  return lv === null ? null : `${LEVEL_MARK[lv]} ${LEVEL_WORD[lv]}`
}

/** 高い側の判定か（グラフの印の向き・ラベルを点の上に置くか） */
export function levelIsHigh(lv: Level): boolean {
  return lv === 'warn-high' || lv === 'danger-high'
}

/** 危険の判定か（印の色を危険にするか。注意は注意の色） */
export function levelIsDanger(lv: Level): boolean {
  return lv === 'danger-high' || lv === 'danger-low'
}

// ══════════════════════════════════════════════════════════════
// 小さなグラフ（項目ごと。二つの目盛りは使わない）
// ══════════════════════════════════════════════════════════════

export type TrendPanelKey = 'bp' | 'pulse' | 'spo2' | 'temp'

export interface TrendPanelSpec {
  key: TrendPanelKey
  title: string
  unit: string
  /** グラフに描く欄（血圧は上・下の2本＝同じ mmHg の1つの目盛り） */
  fields: readonly DaycareVitalField[]
  axis: AxisSpec
}

/** 並びはバイタル一括の欄の順（血圧 → 脈 → SpO2 → 体温＝DC_BULK_VITAL_ORDER） */
export const TREND_PANELS: readonly TrendPanelSpec[] = [
  { key: 'bp', title: '血圧', unit: 'mmHg', fields: ['sys_bp', 'dia_bp'], axis: KARTE_AXES.bp },
  { key: 'pulse', title: '脈', unit: '回/分', fields: ['pulse'], axis: KARTE_AXES.pulse },
  { key: 'spo2', title: 'SpO2', unit: '%', fields: ['spo2'], axis: KARTE_AXES.spo2 },
  { key: 'temp', title: '体温', unit: '℃', fields: ['temp'], axis: KARTE_AXES.temp },
]

/** 血圧の2本の名前（凡例・直接のラベル。定時バイタルの表と同じ短い呼び名） */
export const BP_SERIES_NAME: Partial<Record<DaycareVitalField, string>> = { sys_bp: '上', dia_bp: '下' }

/** 値に単位を付ける（連絡帳の紙面と同じ: 「128/76 mmHg」「72 回/分」「97%」「36.5℃」） */
export function withUnit(panel: Pick<TrendPanelSpec, 'unit'>, text: string): string {
  return panel.unit === '%' || panel.unit === '℃' ? `${text}${panel.unit}` : `${text} ${panel.unit}`
}

/** 値の表示（体温は小数1桁） */
export function fmtTrendValue(field: DaycareVitalField, v: number): string {
  return field === 'temp' ? v.toFixed(1) : String(v)
}

/** 縦軸の範囲（記録の値に合わせる・カルテのグラフと同じ chartDomain。基準の値は範囲に含めない） */
export function trendDomain(panel: Pick<TrendPanelSpec, 'fields' | 'axis'>, rounds: readonly Pick<TrendRound, 'vals'>[]): [number, number] {
  const vals: number[] = []
  for (const r of rounds) for (const f of panel.fields) if (r.vals[f] !== null) vals.push(r.vals[f] as number)
  return chartDomain(vals, panel.axis)
}

/** 目盛（区切りのよい値。目盛の文字が minGapPx より近づく時は刻みを広げる＝chartTicks） */
export function trendTicks(panel: Pick<TrendPanelSpec, 'axis'>, domain: [number, number], plotH: number, minGapPx: number): number[] {
  return chartTicks(domain, panel.axis.step, plotH, minGapPx).values
}

/** 目盛の数字（体温は小数1桁・ほかは整数） */
export function fmtTick(panel: Pick<TrendPanelSpec, 'key'>, v: number): string {
  return panel.key === 'temp' ? v.toFixed(1) : String(Math.round(v))
}

/** 値のある回の続き（線を引く区間）。値の無い回で切る。1回だけの区間は点だけ（線は引かない） */
export function trendSegments(values: readonly (number | null)[]): number[][] {
  const out: number[][] = []
  let cur: number[] = []
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length > 0) out.push(cur)
      cur = []
    } else cur.push(i)
  })
  if (cur.length > 0) out.push(cur)
  return out
}

/** その欄の値のある一番新しい回の添字（無ければ -1） */
export function lastIndexWithValue(rounds: readonly Pick<TrendRound, 'vals'>[], field: DaycareVitalField): number {
  for (let i = rounds.length - 1; i >= 0; i -= 1) if (rounds[i].vals[field] !== null) return i
  return -1
}

/** 文字の幅の見積り（fs＝文字の大きさ px・charW＝半角1字の実測の幅。全角は1字＝fs） */
export function textWidth(text: string, fs: number, charW: number = fs * 0.6): number {
  let w = 0
  for (const ch of text) w += /[\x20-\x7e]/.test(ch) ? charW : fs
  return Math.ceil(w)
}

/** ラベルを置く場所の案（side＝点の上か下か・x＝文字の中心・top＝文字の上端） */
export interface LabelSpot {
  side: 'above' | 'below'
  x: number
  top: number
}

/** ラベルの候補（w・h＝文字の幅と高さ・spots＝置く場所の案を試す順に・priority＝小さいほど先に置く） */
export interface LabelCandidate {
  id: string
  w: number
  h: number
  priority: number
  spots: readonly LabelSpot[]
}

/** 四角（left・top・right・bottom） */
export type LabelObstacle = readonly [number, number, number, number]

/**
 * 出すラベルと置く場所を選ぶ（全部の点に数字を並べない）。priority の小さい順に、spots を順に試し、既に置いたラベルとも
 * 避ける四角（点の印。id が同じ＝そのラベルの点の印は避けない）と obstacleGap より近づかない最初の場所に置く。どこにも置けなければ出さない
 * （印は残る。値は押した時の表示と〔数値で見る〕の表に出る）。画面は「最新の値」を priority 0、「基準外の点」を新しい順に 1 から渡す
 */
export function pickLabels(
  cands: readonly LabelCandidate[],
  gap: number,
  obstacles: readonly { id: string; box: LabelObstacle }[] = [],
  obstacleGap = 0,
): Map<string, LabelSpot> {
  const placed: LabelObstacle[] = []
  const out = new Map<string, LabelSpot>()
  const hits = (r: LabelObstacle, o: LabelObstacle, g: number) => r[0] < o[2] + g && o[0] < r[2] + g && r[1] < o[3] + g && o[1] < r[3] + g
  const order = [...cands].sort((a, b) => a.priority - b.priority)
  for (const c of order) {
    for (const s of c.spots) {
      const r: LabelObstacle = [s.x - c.w / 2, s.top, s.x + c.w / 2, s.top + c.h]
      if (placed.some((o) => hits(r, o, gap)) || obstacles.some((o) => o.id !== c.id && hits(r, o.box, obstacleGap))) continue
      placed.push(r)
      out.set(c.id, s)
      break
    }
  }
  return out
}

/** ラベルの中心を描く範囲の内側へ寄せる（右端の最新の点のラベルが枠からはみ出さない） */
export function clampLabelX(x: number, w: number, left: number, right: number): number {
  if (right - left <= w) return (left + right) / 2
  return Math.min(right - w / 2, Math.max(left + w / 2, x))
}

/**
 * 横軸の日付のラベルを出す回の添字（重ならない分だけ）。最後（最新）→ 最初 → 新しい順に、既に出したラベルと gap より近づかないものを出す
 */
export function pickXLabels(xs: readonly number[], widths: readonly number[], gap: number): number[] {
  const n = xs.length
  if (n === 0) return []
  const order = [n - 1, ...(n > 1 ? [0] : []), ...Array.from({ length: Math.max(0, n - 2) }, (_, k) => n - 2 - k)]
  const placed: number[] = []
  for (const i of order) {
    const ok = placed.every((j) => Math.abs(xs[i] - xs[j]) >= (widths[i] + widths[j]) / 2 + gap)
    if (ok) placed.push(i)
  }
  return placed.sort((a, b) => a - b)
}

// ══════════════════════════════════════════════════════════════
// 言葉（横軸・表・押した時の表示・読み上げ）
// ══════════════════════════════════════════════════════════════

/** 横軸の短い日付 '2026-11-08' → '11/8' */
export function shortDay(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  return Number.isFinite(m) && Number.isFinite(d) ? `${m}/${d}` : iso
}

/** 表・押した時の日時 '11/8（土） 10:05'（時刻が無ければ日付だけ） */
export function roundWhen(r: Pick<TrendRound, 'day' | 'hm'>): string {
  const [y, m, d] = r.day.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const wd = Number.isNaN(dt.getTime()) ? '' : `（${WEEKDAY[dt.getUTCDay()]}）`
  return `${m}/${d}${wd}${r.hm === '' ? '' : ` ${r.hm}`}`
}

/** 値の無い欄の言葉（印を読めなかった＝読み込めませんでした／印あり＝未測定／印なし＝—） */
function noneText(r: Pick<TrendRound, 'unmeasured'>, f: DaycareVitalField, marksUnread: boolean): string {
  if (marksUnread) return UNREAD
  return r.unmeasured.includes(f) ? UNMEASURED : TREND_NONE
}

/** 表の1欄（text＝値か値の無い言葉・flags＝基準外の記号と言葉。血圧は「上 ↑ 注意・高い」のように上・下を添える） */
export interface TrendCell {
  text: string
  flags: string[]
}

/** その回のその項目の欄（表と押した時の表示で同じ言葉） */
export function trendCell(
  panel: Pick<TrendPanelSpec, 'key' | 'fields'>,
  r: TrendRound,
  levelOf: (r: TrendRound, f: DaycareVitalField) => Level,
  marksUnread: boolean,
): TrendCell {
  if (panel.key === 'bp') {
    const s = r.vals.sys_bp
    const d = r.vals.dia_bp
    const sText = s === null ? noneText(r, 'sys_bp', marksUnread) : String(s)
    const dText = d === null ? noneText(r, 'dia_bp', marksUnread) : String(d)
    const text = s !== null && d !== null ? `${s}/${d}` : s === null && d === null && sText === dText ? sText : `上 ${sText}／下 ${dText}`
    const flags: string[] = []
    for (const f of ['sys_bp', 'dia_bp'] as const) {
      const t = levelText(levelOf(r, f))
      if (t !== null) flags.push(`${BP_SERIES_NAME[f]} ${t}`)
    }
    return { text, flags }
  }
  const f = panel.fields[0]
  const v = r.vals[f]
  const t = levelText(levelOf(r, f))
  return { text: v === null ? noneText(r, f, marksUnread) : fmtTrendValue(f, v), flags: t === null ? [] : [t] }
}

/** 押した時の表示（その回の日時と全部の項目の値。基準外は記号と言葉） */
export function trendReadout(
  r: TrendRound,
  levelOf: (r: TrendRound, f: DaycareVitalField) => Level,
  marksUnread: boolean,
): string {
  const parts = TREND_PANELS.map((p) => {
    const c = trendCell(p, r, levelOf, marksUnread)
    const hasVal = p.fields.some((f) => r.vals[f] !== null)
    return `${p.title} ${hasVal ? withUnit(p, c.text) : c.text}${c.flags.length > 0 ? `（${c.flags.join('・')}）` : ''}`
  })
  return `${roundWhen(r)} の回: ${parts.join('・')}`
}

/** その項目に基準外の欄がある回の数 */
export function abnormalCount(
  panel: Pick<TrendPanelSpec, 'fields'>,
  rounds: readonly TrendRound[],
  levelOf: (r: TrendRound, f: DaycareVitalField) => Level,
): number {
  return rounds.filter((r) => panel.fields.some((f) => levelOf(r, f) !== null)).length
}

/**
 * グラフの読み上げの要約（role="img" の SVG の中の文字は読み上げられないため）。
 * 例「血圧 直近10回（10/28〜11/10）。最新 128/76 mmHg。基準外 2回。」
 */
export function trendSpeech(
  panel: TrendPanelSpec,
  rounds: readonly TrendRound[],
  levelOf: (r: TrendRound, f: DaycareVitalField) => Level,
): string {
  const n = rounds.length
  if (n === 0) return `${panel.title} 記録なし。`
  const range = n === 1 ? shortDay(rounds[0].day) : `${shortDay(rounds[0].day)}〜${shortDay(rounds[n - 1].day)}`
  const withVal = rounds.filter((r) => panel.fields.some((f) => r.vals[f] !== null)).length
  const head = `${panel.title} 直近${n}回（${range}）。`
  if (withVal === 0) return `${head}この${n}回に${panel.title}の記録はありません。`
  let latest: string
  if (panel.key === 'bp') {
    const i = Math.max(lastIndexWithValue(rounds, 'sys_bp'), lastIndexWithValue(rounds, 'dia_bp'))
    const r = rounds[i]
    latest =
      r.vals.sys_bp !== null && r.vals.dia_bp !== null
        ? `${r.vals.sys_bp}/${r.vals.dia_bp}`
        : `上 ${r.vals.sys_bp ?? TREND_NONE}／下 ${r.vals.dia_bp ?? TREND_NONE}`
  } else {
    const f = panel.fields[0]
    latest = fmtTrendValue(f, rounds[lastIndexWithValue(rounds, f)].vals[f] as number)
  }
  const ab = abnormalCount(panel, rounds, levelOf)
  const gaps = n - withVal
  return `${head}最新 ${withUnit(panel, latest)}。基準外 ${ab}回。${gaps > 0 ? `値の無い回 ${gaps}回。` : ''}`
}

/** グラフの状態（0回・1回・2回以上） */
export type TrendView = { kind: 'none' } | { kind: 'one' } | { kind: 'chart' }

export function trendView(rounds: readonly unknown[]): TrendView {
  if (rounds.length === 0) return { kind: 'none' }
  if (rounds.length === 1) return { kind: 'one' }
  return { kind: 'chart' }
}

/** 空の状態・1回だけの時の文 */
export const TREND_EMPTY_TEXT = 'デイで測ったバイタルの記録は、この日まではまだありません。'
export const TREND_ONE_TEXT = '記録が1回だけのため、推移のグラフはまだ出せません（2回目の記録から出します）。値は下の〔数値で見る〕で確かめられます。'
export const TREND_UNREAD_TEXT = '前の回のバイタルを読み込めませんでした。通信状態を確認して、〔再試行〕を押してください（上の値はこの日の記録です）。'
export const TREND_MARKS_UNREAD_TEXT = '〔未測定〕の印を読み込めませんでした（値の無い欄は「読み込めませんでした」と出しています）。'
