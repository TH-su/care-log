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
import { NO_RECORD, UNMEASURED, UNREAD } from './daycareContact.ts'
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

/**
 * ラベルを置く場所の案。side＝点の上・下・左（左は文字の終わりを点の左に合わせる＝右端の最新の点で使う）。
 * anchor＝SVG の text-anchor（middle＝x が文字の中心・end＝x が文字の右端）・top＝文字の上端
 */
export interface LabelSpot {
  side: 'above' | 'below' | 'left'
  anchor: 'middle' | 'end'
  x: number
  top: number
}

/**
 * ラベルの候補（w・h＝文字の幅と高さ・spots＝置く場所の案を試す順に・priority＝小さいほど先に置く）。
 * latest＝その系列の最新の値（必ず出す。ほかの点の印に重なってもよい＝描く側が文字に面の色の縁を付ける）
 */
export interface LabelCandidate {
  id: string
  w: number
  h: number
  priority: number
  spots: readonly LabelSpot[]
  latest?: boolean
}

/** 四角（left・top・right・bottom） */
export type LabelObstacle = readonly [number, number, number, number]

/** ラベルの箱（anchor に合わせる） */
export function labelBox(c: Pick<LabelCandidate, 'w' | 'h'>, s: LabelSpot): LabelObstacle {
  const left = s.anchor === 'end' ? s.x - c.w : s.x - c.w / 2
  return [left, s.top, left + c.w, s.top + c.h]
}

/**
 * 出すラベルと置く場所を選ぶ（全部の点に数字を並べない）。priority の小さい順に置く。
 * fixed＝どの段でも避ける四角（左の目盛りの数字の箱。2026-11-10 反証の確認 軽1）。間は obstacleGap（目盛りの数字は枠の外にあり、
 * 枠の内側に寄せたラベルとの間は 6px なので、ラベルどうしの gap では測らない）
 * ・ふつうのラベル（基準外の点）: spots を順に試し、置ける範囲（bounds）の内側で、既に置いたラベルとも gap、避ける四角（点の印。id が同じ＝
 *   そのラベルの点の印は避けない）とも obstacleGap より近づかない最初の場所に置く。どこにも置けなければ出さない
 *   （印は残る。値は押した回の行と〔数値で見る〕の表に出る）
 * ・最新のラベル（latest）: 必ず出す。同じ順で、まず印も避ける場所 → 無ければ印に重なってもよい場所（ラベルどうしは重ねない）→
 *   それも無ければ案を1段ずつ縦にずらして（積む・3段まで）置いたラベルを避ける場所 → それも無ければ最初の案に置く
 *   （2026-11-10 反証 中1・反証の確認 軽2）
 * 画面は最新を先（priority 0〜）、次にいちばん新しい基準外、危険、注意の順に渡す（2026-11-10 反証 軽2）
 */
export function pickLabels(
  cands: readonly LabelCandidate[],
  gap: number,
  obstacles: readonly { id: string; box: LabelObstacle }[] = [],
  obstacleGap = 0,
  bounds: LabelObstacle = [-Infinity, -Infinity, Infinity, Infinity],
  fixed: readonly LabelObstacle[] = [],
): Map<string, LabelSpot> {
  const placed: LabelObstacle[] = []
  const out = new Map<string, LabelSpot>()
  const hits = (r: LabelObstacle, o: LabelObstacle, g: number) => r[0] < o[2] + g && o[0] < r[2] + g && r[1] < o[3] + g && o[1] < r[3] + g
  const inside = (r: LabelObstacle) => r[0] >= bounds[0] - 0.5 && r[1] >= bounds[1] - 0.5 && r[2] <= bounds[2] + 0.5 && r[3] <= bounds[3] + 0.5
  const order = [...cands].sort((a, b) => a.priority - b.priority)
  for (const c of order) {
    const free = (s: LabelSpot, withMarks: boolean) => {
      const r = labelBox(c, s)
      if (!inside(r) || placed.some((o) => hits(r, o, gap)) || fixed.some((o) => hits(r, o, obstacleGap))) return false
      return !withMarks || !obstacles.some((o) => o.id !== c.id && hits(r, o.box, obstacleGap))
    }
    let spot = c.spots.find((s) => free(s, true))
    if (spot === undefined && c.latest === true) {
      spot = c.spots.find((s) => free(s, false))
      // 最後の逃げ道でも、置いたラベルに重ねない: 上の案は上へ・下の案は下へ・左の案は下→上へ、1段（文字1行＋間）ずつずらす
      for (let k = 1; spot === undefined && k <= 3; k += 1) {
        for (const s of c.spots) {
          const dirs = s.side === 'above' ? [-1] : s.side === 'below' ? [1] : [1, -1]
          const hit = dirs.map((d) => ({ ...s, top: s.top + d * k * (c.h + gap) })).find((t) => free(t, false))
          if (hit !== undefined) {
            spot = hit
            break
          }
        }
      }
      spot ??= c.spots.find((s) => inside(labelBox(c, s))) ?? c.spots[0]
    }
    if (spot === undefined) continue
    placed.push(labelBox(c, spot))
    out.set(c.id, spot)
  }
  return out
}

/** ラベルの中心を描く範囲の内側へ寄せる（右端の最新の点のラベルが枠からはみ出さない） */
export function clampLabelX(x: number, w: number, left: number, right: number): number {
  if (right - left <= w) return (left + right) / 2
  return Math.min(right - w / 2, Math.max(left + w / 2, x))
}

/**
 * 横軸のラベルを出す回の添字（重ならない分だけ）。日付のラベル（最後 → 最初 → 新しい順）を先に、
 * 同じ日の2回目以降のラベル「再n」（secondary・新しい順）を後に置き、既に出したラベルと gap より近づかないものを出す
 */
export function pickXLabels(xs: readonly number[], widths: readonly number[], gap: number, secondary: readonly boolean[] = []): number[] {
  const n = xs.length
  if (n === 0) return []
  const base = [n - 1, ...(n > 1 ? [0] : []), ...Array.from({ length: Math.max(0, n - 2) }, (_, k) => n - 2 - k)]
  const order = [...base.filter((i) => secondary[i] !== true), ...base.filter((i) => secondary[i] === true)]
  const placed: number[] = []
  for (const i of order) {
    const ok = placed.every((j) => Math.abs(xs[i] - xs[j]) >= (widths[i] + widths[j]) / 2 + gap)
    if (ok) placed.push(i)
  }
  return placed.sort((a, b) => a - b)
}

/** 横軸の言葉: 日付（'11/8'）。同じ日の2回目以降は「再n」（n＝その日の何回目か・表示中の回の中で数える）。2026-11-10 反証 軽9（仮置き） */
export function xLabelTexts(rounds: readonly Pick<TrendRound, 'day'>[]): { text: string; secondary: boolean }[] {
  let k = 0
  return rounds.map((r, i) => {
    k = i > 0 && rounds[i - 1].day === r.day ? k + 1 : 1
    return k === 1 ? { text: shortDay(r.day), secondary: false } : { text: `再${k}`, secondary: true }
  })
}

// ══════════════════════════════════════════════════════════════
// 1項目のグラフの配置（寸法・目盛・点の印・線・ラベル・横軸）。描く側はこれをそのまま描く（2026-11-10 反証 軽10）
// ══════════════════════════════════════════════════════════════

/** 描く寸法（width＝SVG の幅・fs＝文字の大きさ・charW＝数字1字の幅。どれも画面で実測した値） */
export interface TrendGeom {
  width: number
  fs: number
  charW: number
}

/** 点の印。kind＝丸（ふつう）・四角（血圧の下）・三角（基準外・血圧の下は四角のまま）。tone＝系列の色・注意・危険。dir＝基準外の向き */
export interface TrendMarker {
  id: string
  field: DaycareVitalField
  i: number
  x: number
  y: number
  kind: 'circle' | 'square' | 'triangle'
  tone: 'series' | 'warn' | 'danger'
  dir: 'up' | 'down' | null
}

/** 直接のラベル（y＝文字の基準線） */
export interface TrendLabel {
  id: string
  text: string
  x: number
  y: number
  anchor: 'middle' | 'end'
  latest: boolean
}

export interface TrendLayout {
  W: number
  H: number
  padL: number
  padR: number
  padT: number
  plotH: number
  /** 回の横の位置（左が古い） */
  xs: number[]
  /** 点を並べる幅（最初の点から最後の点まで。回の数を決める＝trendFitRounds） */
  plotW: number
  /** 目盛り（y＝線の高さ・baseline＝数字の基準線） */
  ticks: { v: number; y: number; baseline: number; text: string }[]
  /** 線（値の無い回で切る。1回だけの区間は線を引かない） */
  lines: { field: DaycareVitalField; points: [number, number][] }[]
  markers: TrendMarker[]
  labels: TrendLabel[]
  /** 横軸のラベル（重ならない分だけ） */
  xLabels: { i: number; x: number; text: string }[]
  /** ラベルの文字の大きさから決めた、文字の基準線から上端までの高さ */
  ascent: number
}

/** 左の目盛の数字の幅（4つのグラフで同じ＝4字「36.0」。横の位置を4つのグラフでそろえる） */
export function trendPadLeft(fs: number, charW: number): number {
  return textWidth('00.0', fs, charW) + 8
}

/** 点を並べる幅（SVG の幅から左の目盛・右の余白・両端の点の余白を引いた幅。回の数は trendFitRounds(これ)） */
export function trendPlotWidth(geom: TrendGeom): number {
  return Math.max(0, geom.width - trendPadLeft(geom.fs, geom.charW) - TREND_PAD_R - 20)
}

const TREND_PAD_R = 4

/** 印の大きさ（四角の当たり）。丸・四角は半径 4＋縁 2・三角は 7＋縁 2・危険は外の輪（半径 11） */
function markerHalf(m: Pick<TrendMarker, 'kind' | 'tone'>): number {
  if (m.tone === 'danger') return 12
  return m.kind === 'triangle' ? 9 : m.tone === 'warn' ? 10 : 6
}

/**
 * 1項目のグラフの配置。rounds＝出す回（古い順）・levelOf＝その回のその欄の判定（trendLevel）。
 * ・最新の値のラベル（血圧は「上」「下」つき）は必ず出す（点の上 → 左寄せ → 下の順に、印も避けられる所を先に探す）
 * ・基準外のラベル（血圧は「上」「下」つき）は、いちばん新しい基準外 → 危険 → 注意の順に、ほかのラベルと印を避けて置ける分だけ
 * ・ラベル・横軸の文字は SVG の幅の内側（はみ出さない）
 */
export function trendLayout(
  panel: TrendPanelSpec,
  rounds: readonly TrendRound[],
  levelOf: (r: TrendRound, f: DaycareVitalField) => Level,
  geom: TrendGeom,
): TrendLayout {
  const { width: W, fs, charW } = geom
  const tw = (t: string) => textWidth(t, fs, charW)
  const n = rounds.length
  const lineH = Math.ceil(fs * 1.3)
  // グラフの高さは文字の大きさに合わせて少し伸ばす（文字 100%＝72px・200%＝108px）。目盛は chartTicks が間引く
  const plotH = Math.round(Math.max(64, 36 + fs * 2.4))
  const domain = trendDomain(panel, rounds)
  // 目盛の数字の間は文字1行分より少し広く（文字が重ならない）
  const tickVals = trendTicks(panel, domain, plotH, Math.ceil(fs * 1.25))
  const padL = trendPadLeft(fs, charW)
  const padR = TREND_PAD_R
  // 点の上・下に置くラベルの分（上は ▲ の印の上、下は ▼ の印の下）
  const padT = lineH + 6
  const belowRoom = Math.ceil(fs) + 14
  const xAxisH = lineH + 4
  const H = padT + plotH + belowRoom + xAxisH
  const x0 = padL + 10
  const x1 = Math.max(x0, W - padR - 10)
  const xs = rounds.map((_, i) => (n <= 1 ? (x0 + x1) / 2 : x0 + (i * (x1 - x0)) / (n - 1)))
  const span = domain[1] - domain[0] || 1
  const y = (v: number) => padT + (1 - (v - domain[0]) / span) * plotH
  const ascent = Math.round(fs * 0.85)
  const textH = Math.ceil(fs)

  // 目盛りの数字（右寄せで padL - 6 に終わる・基準線は線の高さ＋0.35 字）
  const ticks = tickVals.map((v) => ({ v, y: y(v), baseline: y(v) + Math.round(fs * 0.35), text: fmtTick(panel, v) }))
  const lines = panel.fields.flatMap((f) =>
    trendSegments(rounds.map((r) => r.vals[f]))
      .filter((seg) => seg.length >= 2)
      .map((seg) => ({ field: f, points: seg.map((i): [number, number] => [xs[i], y(rounds[i].vals[f] as number)]) })),
  )

  const markers: TrendMarker[] = []
  for (const f of panel.fields) {
    rounds.forEach((r, i) => {
      const v = r.vals[f]
      if (v === null) return
      const lv = levelOf(r, f)
      const dir = lv === null ? null : levelIsHigh(lv) ? 'up' : 'down'
      // 血圧の下は基準外でも四角のまま（色は状態の色＋向きの小さな印）。ほかは基準外を三角（向き）にする（2026-11-10 反証 軽3）
      const kind: TrendMarker['kind'] = f === 'dia_bp' ? 'square' : lv === null ? 'circle' : 'triangle'
      markers.push({ id: `${f}:${i}`, field: f, i, x: xs[i], y: y(v), kind, tone: lv === null ? 'series' : levelIsDanger(lv) ? 'danger' : 'warn', dir })
    })
  }

  // ── ラベル ──
  // ラベルは描く枠の内側 [padL, W - padR]（左の目盛りの数字に乗らない＝2026-11-10 反証の確認 軽1）
  const plotBottom = padT + plotH + belowRoom
  const room = Math.max(0, W - padR - padL)
  const bounds: LabelObstacle = [padL, 0, W - padR, plotBottom]
  const tickBoxes: LabelObstacle[] = ticks.map((t) => {
    const w = tw(t.text)
    return [padL - 6 - w, t.baseline - ascent, padL - 6, t.baseline - ascent + textH]
  })
  const spotsFor = (m: TrendMarker, w: number, order: readonly LabelSpot['side'][]): LabelSpot[] => {
    const off = markerHalf(m) + 3
    const cx = clampLabelX(m.x, w, padL, W - padR)
    return order.map((side) =>
      side === 'above'
        ? { side, anchor: 'middle' as const, x: cx, top: m.y - off - textH }
        : side === 'below'
          ? { side, anchor: 'middle' as const, x: cx, top: m.y + off }
          : { side, anchor: 'end' as const, x: m.x - off, top: m.y - textH / 2 },
    )
  }
  const bpName = (f: DaycareVitalField) => (panel.key === 'bp' ? BP_SERIES_NAME[f] : undefined)
  const cands: (LabelCandidate & { text: string })[] = []
  const lastOf = new Map(panel.fields.map((f) => [f, lastIndexWithValue(rounds, f)] as const))
  // 基準外の点（最新を除く）の並び: いちばん新しい基準外 → 危険（新しい順）→ 注意（新しい順）
  const abnormal = markers.filter((m) => m.tone !== 'series' && lastOf.get(m.field) !== m.i).sort((a, b) => b.i - a.i || panel.fields.indexOf(a.field) - panel.fields.indexOf(b.field))
  const newest = abnormal[0]
  for (const m of markers) {
    const isLatest = lastOf.get(m.field) === m.i
    if (!isLatest && m.tone === 'series') continue
    const v = rounds[m.i].vals[m.field] as number
    const lv = levelOf(rounds[m.i], m.field)
    const value = fmtTrendValue(m.field, v)
    const body = `${value}${lv === null ? '' : LEVEL_MARK[lv]}`
    const name = bpName(m.field)
    // 血圧は上・下の名前を付ける。描ける幅（W - padR - padL）に入らない時は名前を外し、最新の値はさらに記号も外す（値は必ず出す。
    // 向きと注意・危険は印の形で分かる）。基準外のラベルは記号まで入らなければ出さない
    const texts = [...(name === undefined ? [] : [`${name} ${body}`]), body, ...(isLatest && body !== value ? [value] : [])]
    const fitText = texts.find((t) => tw(t) <= room)
    if (fitText === undefined && !isLatest) continue
    const text = fitText ?? texts[texts.length - 1]
    const w = tw(text)
    // 置く側: 血圧の上は点の上・下は点の下を先に（2本の間は後回し）。1本の項目は高い値・ふつうの値は上、低い値は下を先に
    const first: 'above' | 'below' = panel.key === 'bp' ? (m.field === 'sys_bp' ? 'above' : 'below') : m.dir === 'down' ? 'below' : 'above'
    const other = first === 'above' ? 'below' : 'above'
    const fi = panel.fields.indexOf(m.field)
    const priority = isLatest
      ? fi * 0.1
      : m === newest
        ? 1
        : (m.tone === 'danger' ? 2 : 3) + (n - 1 - m.i) * 0.01 + fi * 0.001
    cands.push({
      id: m.id,
      w,
      h: textH,
      priority,
      latest: isLatest,
      spots: spotsFor(m, w, isLatest ? [first, 'left', other] : [first, other]),
      text,
    })
  }
  const obstacles = markers.map((m) => {
    const h = markerHalf(m)
    return { id: m.id, box: [m.x - h, m.y - h, m.x + h, m.y + h] as LabelObstacle }
  })
  const picked = pickLabels(cands, Math.ceil(fs * 0.25), obstacles, 1, bounds, tickBoxes)
  const labels: TrendLabel[] = cands.flatMap((c) => {
    const s = picked.get(c.id)
    return s === undefined ? [] : [{ id: c.id, text: c.text, x: s.x, y: s.top + ascent, anchor: s.anchor, latest: c.latest === true }]
  })

  // ── 横軸 ──
  const xt = xLabelTexts(rounds)
  const xWs = xt.map((t) => tw(t.text))
  // 端のラベルは枠の内側へ寄せた位置で重なりを見る（右端の最新のラベルが左へ寄る分）
  const xAt = rounds.map((_, i) => clampLabelX(xs[i], xWs[i], 0, W))
  const xIdx = pickXLabels(
    xAt,
    xWs,
    Math.ceil(fs * 0.6),
    xt.map((t) => t.secondary),
  )
  const xLabels = xIdx.map((i) => ({ i, x: xAt[i], text: xt[i].text }))

  return { W, H, padL, padR, padT, plotH, xs, plotW: Math.max(0, x1 - x0), ticks, lines, markers, labels, xLabels, ascent }
}

// ══════════════════════════════════════════════════════════════
// 押した回（グラフのタップ・〔‹ 前の回〕〔次の回 ›〕。2026-11-10 反証 軽4・軽5）
// ══════════════════════════════════════════════════════════════

/** 押した位置にいちばん近い回の添字（回が無ければ -1） */
export function nearestIndex(xs: readonly number[], px: number): number {
  let best = -1
  for (let i = 0; i < xs.length; i += 1) if (best < 0 || Math.abs(xs[i] - px) < Math.abs(xs[best] - px)) best = i
  return best
}

/**
 * 〔‹ 前の回〕（dir＝-1）・〔次の回 ›〕（dir＝1）で動かした先の添字。何も選んでいない時は〔‹ 前の回〕で最新の回を選ぶ。
 * 端では動かない（null＝押せない）
 */
export function stepIndex(n: number, cur: number | null, dir: -1 | 1): number | null {
  if (n <= 0) return null
  if (cur === null || cur < 0 || cur >= n) return dir === -1 ? n - 1 : null
  const next = cur + dir
  return next < 0 || next >= n ? null : next
}

// ══════════════════════════════════════════════════════════════
// 回の窓・選んだ回・まとめた読み直し（2026-11-10 反証の確認 軽3・軽5）
// ══════════════════════════════════════════════════════════════

/** 出す回: 測った幅（点を並べる幅・null＝まだ測っていない＝10 回）に入る分だけ、新しい方から（表も同じ回） */
export function trendWindow<T>(all: readonly T[], plotW: number | null): T[] {
  const k = plotW === null ? TREND_ROUNDS : trendFitRounds(plotW)
  return all.length > k ? all.slice(-k) : [...all]
}

/**
 * 選んだ回の添字。選んだ回は「人・日」と行の id で持つ（読み直しで並びが変わっても同じ回）。人・日が違う・出す回に入っていない
 * （幅に合わせて回を減らした時に外れた）時は -1（選んでいない扱い＝〔‹ 前の回〕で最新から選び直せる）
 */
export function selectedIndexOf(rounds: readonly Pick<TrendRound, 'id'>[], sel: { key: string; id: number } | null, key: string): number {
  if (sel === null || sel.key !== key) return -1
  return rounds.findIndex((r) => r.id === sel.id)
}

/** まとめた読み直しのきっかけ（人・日・表示中の日の行の印 mineSig・画面に届いた変更の回数 changeKey） */
export interface TrendReloadInputs {
  key: string
  mineSig: string
  changeKey: number
}

/**
 * 前と今のきっかけから、待っている読み直しをどうするか。
 * cancel＝人・日が変わった（待っている読み直しを消す。新しい人・日はすぐ読む）／schedule＝同じ人・日のまま mineSig か changeKey が
 * 変わった（RELOAD_MS 後に1回だけ読む。待っている間にまた変われば待ち直す＝まとめる）／none＝変わらない
 */
export function trendReloadStep(prev: TrendReloadInputs, next: TrendReloadInputs): 'cancel' | 'schedule' | 'none' {
  if (prev.key !== next.key) return 'cancel'
  return prev.mineSig !== next.mineSig || prev.changeKey !== next.changeKey ? 'schedule' : 'none'
}

/** まとめる時間（画面の読み直しと同じ 400ms） */
export const TREND_RELOAD_MS = 400


// ══════════════════════════════════════════════════════════════
// 読み直し（2026-11-10 反証 軽7）
// ══════════════════════════════════════════════════════════════

/**
 * 画面に届いた変更の知らせ（db.ts の subscribeChanges の表と行）で、推移を読み直すか。
 * ・vitals: その方の、表示中の日より前のデイの測定（client_key 'dc:'）の行（推移が自分で読むのは前の日の回と印だけ。表示中の日の行は
 *   画面が読み直し、その変わり目＝mineSig で1回だけ読み直す＝二重に読まない。2026-11-10 反証の確認 軽3）。行の分からない知らせ
 *   （取り直しの合図 RESYNC・行の無い DELETE）は読み直す（分からない＝取り直す側に倒す）
 * ・daycare_vital_unmeasured: その方の、表示中の日以前の印の行（今は購読の知らせが届かない表＝この判断は届いた時のため）
 * ・ほかの表・ほかの方・後の日は読み直さない
 */
export function trendChangeHits(
  table: string,
  info: { event?: string; row: Record<string, unknown> | null } | undefined,
  residentId: number,
  day: string,
): boolean {
  if (table !== 'vitals' && table !== 'daycare_vital_unmeasured') return false
  const row = info?.row ?? null
  if (row === null) return table === 'vitals'
  if (row.resident_id !== residentId) return false
  if (table === 'vitals') {
    const on = row.measured_on
    const ck = row.client_key
    return typeof on === 'string' && on < day && typeof ck === 'string' && ck.startsWith('dc:')
  }
  return typeof row.day === 'string' && row.day <= day
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

/**
 * 値の無い欄の言葉（印を読めなかった＝読み込めませんでした／印あり＝未測定／印なし＝none）。
 * none は表では「—」、押した回の行と読み上げでは「記録なし」（2026-11-10 反証の確認 軽7）
 */
function noneText(r: Pick<TrendRound, 'unmeasured'>, f: DaycareVitalField, marksUnread: boolean, none: string): string {
  if (marksUnread) return UNREAD
  return r.unmeasured.includes(f) ? UNMEASURED : none
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
  none: string = TREND_NONE,
): TrendCell {
  if (panel.key === 'bp') {
    const s = r.vals.sys_bp
    const d = r.vals.dia_bp
    const sText = s === null ? noneText(r, 'sys_bp', marksUnread, none) : String(s)
    const dText = d === null ? noneText(r, 'dia_bp', marksUnread, none) : String(d)
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
  return { text: v === null ? noneText(r, f, marksUnread, none) : fmtTrendValue(f, v), flags: t === null ? [] : [t] }
}

/** 押した回の行（グラフのすぐ下・その項目だけ）: '11/5（木） 10:05　138/82 mmHg（上 ↑↑ 危険・高い）' */
export function trendPanelReadout(
  panel: Pick<TrendPanelSpec, 'key' | 'fields' | 'unit'>,
  r: TrendRound,
  levelOf: (r: TrendRound, f: DaycareVitalField) => Level,
  marksUnread: boolean,
): string {
  const c = trendCell(panel, r, levelOf, marksUnread, NO_RECORD)
  const hasVal = panel.fields.some((f) => r.vals[f] !== null)
  return `${roundWhen(r)}　${hasVal ? withUnit(panel, c.text) : c.text}${c.flags.length > 0 ? `（${c.flags.join('・')}）` : ''}`
}

/** 押した時の表示（その回の日時と全部の項目の値。基準外は記号と言葉） */
export function trendReadout(
  r: TrendRound,
  levelOf: (r: TrendRound, f: DaycareVitalField) => Level,
  marksUnread: boolean,
): string {
  const parts = TREND_PANELS.map((p) => {
    const c = trendCell(p, r, levelOf, marksUnread, NO_RECORD)
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
export const TREND_UNREAD_TEXT = '前の回のバイタルを読み込めませんでした。通信状態を確認して、〔再試行〕を押してください（バイタルの欄の値はこの日の記録です）。'
export const TREND_PICK_HINT = '押した回の値をここに出します。'
/** 表示中の日の測定を読めなかった時（1人の画面の読み込みの失敗。前の日の回だけで描く・「まだありません」と言い切らない＝2026-11-10 反証 軽8） */
export function trendDayUnreadText(isToday: boolean): string {
  return `${isToday ? '今日' : 'この日'}の値を読み込めませんでした（前の日の回だけを出しています）。`
}
export const TREND_EMPTY_DAY_UNREAD_TEXT = '前の日のデイで測ったバイタルの記録はありません。'
export const TREND_MARKS_UNREAD_TEXT = '〔未測定〕の印を読み込めませんでした（値の無い欄は「読み込めませんでした」と出しています）。'
