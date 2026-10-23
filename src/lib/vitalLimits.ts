// 個人のバイタルの閾値（段階2d・移行 0045 resident_vital_limits）の純ロジック（副作用なし・DB/DOM に触れない）。
// tests/vital-limits.test.mjs から node で直接読む（拡張子付きで import する）。
//
// 決まり（段階2の計画 v1 の 3.2・5章・代表者の承認 2026-10-22）:
// ・その方の、記録の日（measured_on）以前で一番新しい valid_from の行を使う（limitFor）。全部 null の行は
//   「この日から施設の基準に戻す」で、選ばれる（施設の基準で判定する）。先の日から効く行・取り消した行は使わない
// ・項目ごとに「個人の値 > 施設の設定（app_settings の vital_thresholds）> 既定値」で合成する（thresholdsFor）。
//   施設の設定と既定値の合成は vitalThresholds.ts（いまの基準 vitalThresholds()）が済ませているので、ここでは
//   「いまの施設の基準」の上に個人の値を重ねるだけ
// ・合成した後で、項目ごと（体温・血圧の上・血圧の下・脈）に段階の順を確かめ、崩れていればその項目は両方とも施設の基準に
//   戻し、fallback に入れる（画面は「個人の基準が施設の基準と合わないため、施設の基準で判定」と出す）。
//   受信した値が壊れている（数でない・範囲の外）時も同じ（multi-device-sync 原則10）
// ・判定そのものは既存の *LevelBy(値, 基準)（vitalThresholds.ts）を使う。types.ts の tempLevel などは
//   「施設の基準で判定する入口」として残す（凍結）
// ・SpO2 は個人の閾値の対象外（今の個別の下限 resident_targets のまま）
// 個人情報は扱わない（数値と日付だけ）。

import type { VitalThresholds } from './vitalThresholds.ts'

/** 個人の閾値の項目（施設の基準の一式と1対1の9項目） */
export const VITAL_LIMIT_FIELDS = [
  'temp_warn_high',
  'temp_danger_high',
  'temp_danger_low',
  'sys_bp_danger_high',
  'sys_bp_warn_low',
  'dia_bp_danger_high',
  'dia_bp_warn_low',
  'pulse_danger_high',
  'pulse_warn_low',
] as const
export type VitalLimitField = (typeof VITAL_LIMIT_FIELDS)[number]

/** 項目の呼び名（画面） */
export const VITAL_LIMIT_LABEL: Record<VitalLimitField, string> = {
  temp_warn_high: '体温 注意の高（℃以上）',
  temp_danger_high: '体温 危険の高（℃以上）',
  temp_danger_low: '体温 危険の低（℃以下）',
  sys_bp_danger_high: '血圧の上 危険の高（以上）',
  sys_bp_warn_low: '血圧の上 注意の低（未満）',
  dia_bp_danger_high: '血圧の下 危険の高（以上）',
  dia_bp_warn_low: '血圧の下 注意の低（未満）',
  pulse_danger_high: '脈 危険の高（以上）',
  pulse_warn_low: '脈 注意の低（未満）',
}

/** 値の範囲（両端を含む。DB の check 0045 と同じ。変える時は移行と同時に）と、小数を持つか */
export const VITAL_LIMIT_RANGES: Record<VitalLimitField, { min: number; max: number; decimal: boolean }> = {
  temp_warn_high: { min: 35.0, max: 41.0, decimal: true },
  temp_danger_high: { min: 35.0, max: 42.0, decimal: true },
  temp_danger_low: { min: 33.0, max: 37.0, decimal: true },
  sys_bp_danger_high: { min: 100, max: 250, decimal: false },
  sys_bp_warn_low: { min: 60, max: 140, decimal: false },
  dia_bp_danger_high: { min: 60, max: 150, decimal: false },
  dia_bp_warn_low: { min: 30, max: 90, decimal: false },
  pulse_danger_high: { min: 60, max: 200, decimal: false },
  pulse_warn_low: { min: 30, max: 80, decimal: false },
}

/** 根拠の長さの上限（DB の check と同じ） */
export const VITAL_LIMIT_BASIS_MAX = 200

/** 個人の閾値の1行（取り消した行は持たない） */
export interface ResidentVitalLimit {
  id: number
  resident_id: number
  /** この日（YYYY-MM-DD）の記録から効く */
  valid_from: string
  temp_warn_high: number | null
  temp_danger_high: number | null
  temp_danger_low: number | null
  sys_bp_danger_high: number | null
  sys_bp_warn_low: number | null
  dia_bp_danger_high: number | null
  dia_bp_warn_low: number | null
  pulse_danger_high: number | null
  pulse_warn_low: number | null
  basis: string
  set_by: number | null
  rev: number
  /** 足した時刻（ISO。取り消せるのは足した日の当日だけ） */
  created_at: string | null
}

/** 判定の項目のまとまり（段階の順を確かめる単位） */
export type VitalLimitGroup = 'temp' | 'sysBp' | 'diaBp' | 'pulse'
export const VITAL_LIMIT_GROUP_LABEL: Record<VitalLimitGroup, string> = { temp: '体温', sysBp: '血圧の上', diaBp: '血圧の下', pulse: '脈' }

/** 受信した値が、その項目の範囲の中の数か（外れたら null＝その項目は施設の基準） */
export function limitValueOf(field: VitalLimitField, v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return null
  const r = VITAL_LIMIT_RANGES[field]
  if (n < r.min || n > r.max) return null
  if (!r.decimal && !Number.isInteger(n)) return null
  return n
}

/**
 * その方の、その日（YYYY-MM-DD）に効く行: valid_from がその日以前で一番新しい行（全部 null の行も選ぶ）。無ければ null。
 * rows は全員分でよい（その方の行だけを見る）
 */
export function limitFor(rows: readonly ResidentVitalLimit[], residentId: number, day: string): ResidentVitalLimit | null {
  let best: ResidentVitalLimit | null = null
  for (const r of rows) {
    if (r.resident_id !== residentId || r.valid_from > day) continue
    if (best === null || r.valid_from > best.valid_from || (r.valid_from === best.valid_from && r.id > best.id)) best = r
  }
  return best
}

/** その方・その日の基準（判定の関数 *LevelBy にそのまま渡す）と、個人の値を使った項目・施設の基準に戻した項目 */
export interface ResidentThresholds {
  t: VitalThresholds
  /** 個人の値を使った項目（画面は「（個人の基準）」と出す） */
  individual: ReadonlySet<VitalLimitGroup>
  /** 個人の値が施設の基準と合わない（段階の順が崩れる・壊れた値）ため、施設の基準に戻した項目 */
  fallback: ReadonlySet<VitalLimitGroup>
}

/**
 * 施設の基準（いまの基準＝vitalThresholds()）の上に、その行の個人の値を項目ごとに重ねる。
 * 合成した後に項目ごとの段階の順を確かめ、崩れていればその項目は両方とも施設の基準に戻す
 */
export function thresholdsFor(limit: ResidentVitalLimit | null, base: VitalThresholds): ResidentThresholds {
  const individual = new Set<VitalLimitGroup>()
  const fallback = new Set<VitalLimitGroup>()
  if (limit === null) return { t: base, individual, fallback }
  const val = (f: VitalLimitField) => limitValueOf(f, (limit as unknown as Record<string, unknown>)[f])
  const raw = (f: VitalLimitField) => (limit as unknown as Record<string, unknown>)[f]
  /** 値があるのに範囲の外・数でない（壊れた値） */
  const broken = (f: VitalLimitField) => raw(f) !== null && raw(f) !== undefined && val(f) === null

  // 体温: 危険の低 < 注意の高 < 危険の高
  let temp = base.temp
  {
    const wh = val('temp_warn_high')
    const dh = val('temp_danger_high')
    const dl = val('temp_danger_low')
    const any = wh !== null || dh !== null || dl !== null
    const bad = broken('temp_warn_high') || broken('temp_danger_high') || broken('temp_danger_low')
    if (any || bad) {
      const cand = { warnHigh: wh ?? base.temp.warnHigh, dangerHigh: dh ?? base.temp.dangerHigh, dangerLow: dl ?? base.temp.dangerLow }
      if (!bad && cand.dangerLow < cand.warnHigh && cand.warnHigh < cand.dangerHigh) {
        temp = cand
        individual.add('temp')
      } else fallback.add('temp')
    }
  }
  // 血圧・脈: 注意の低 < 危険の高
  const pair = (
    group: Exclude<VitalLimitGroup, 'temp'>,
    hi: VitalLimitField,
    lo: VitalLimitField,
    b: { dangerHigh: number; warnLow: number },
  ): { dangerHigh: number; warnLow: number } => {
    const h = val(hi)
    const l = val(lo)
    const bad = broken(hi) || broken(lo)
    if (h === null && l === null && !bad) return b
    const cand = { dangerHigh: h ?? b.dangerHigh, warnLow: l ?? b.warnLow }
    if (!bad && cand.warnLow < cand.dangerHigh) {
      individual.add(group)
      return cand
    }
    fallback.add(group)
    return b
  }
  const sysBp = pair('sysBp', 'sys_bp_danger_high', 'sys_bp_warn_low', base.sysBp)
  const diaBp = pair('diaBp', 'dia_bp_danger_high', 'dia_bp_warn_low', base.diaBp)
  const pulse = pair('pulse', 'pulse_danger_high', 'pulse_warn_low', base.pulse)
  if (individual.size === 0) return { t: base, individual, fallback }
  return { t: { ...base, temp, sysBp, diaBp, pulse }, individual, fallback }
}

/**
 * 入れた値を施設の基準と合わせた時に、段階の順が崩れて効かない項目（足す前の確かめ＝2d-1 の反証 中2）。
 * 例: 施設の危険の高 38.1 の時に、体温の注意の高だけ 38.5 を入れた → 体温
 */
export function inputFallback(value: Record<VitalLimitField, number | null>, base: VitalThresholds): ReadonlySet<VitalLimitGroup> {
  const row = { id: 0, resident_id: 0, valid_from: '', basis: '', set_by: null, rev: 1, created_at: null, ...value } as ResidentVitalLimit
  return thresholdsFor(row, base).fallback
}

/** 施設の基準の一つの項目の言葉（足す前の確かめの文に使う） */
export function baseGroupText(g: VitalLimitGroup, base: VitalThresholds): string {
  if (g === 'temp') return `体温（注意 ${base.temp.warnHigh}・危険 ${base.temp.dangerHigh}・危険の低 ${base.temp.dangerLow}）`
  const p = g === 'sysBp' ? base.sysBp : g === 'diaBp' ? base.diaBp : base.pulse
  return `${VITAL_LIMIT_GROUP_LABEL[g]}（危険の高 ${p.dangerHigh}・注意の低 ${p.warnLow}）`
}

/**
 * その方・その日の基準を引く口（段階2d-2・各画面の判定に渡す）。行が無い（null・空）時は、どの方・どの日でも base そのもの
 * （同じ物を返す＝個人の値が無い方は今と同じ印になる）。行があっても、その方・その日に効く行が無い・全部空欄の行なら base。
 * 同じ方・同じ日は一度だけ合成する（控えを持つ）
 */
export function thresholdsLookup(rows: readonly ResidentVitalLimit[] | null, base: VitalThresholds): (residentId: number, day: string) => VitalThresholds {
  if (rows === null || rows.length === 0) return () => base
  const memo = new Map<string, VitalThresholds>()
  const residents = new Set(rows.map((r) => r.resident_id))
  return (residentId: number, day: string) => {
    if (!residents.has(residentId)) return base
    const k = `${residentId}|${day}`
    const hit = memo.get(k)
    if (hit !== undefined) return hit
    const t = thresholdsFor(limitFor(rows, residentId, day), base).t
    memo.set(k, t)
    return t
  }
}

/** 体温・血圧・脈の基準が同じか（個人の閾値が変える項目だけを比べる） */
export function sameVitalLimits(a: VitalThresholds, b: VitalThresholds): boolean {
  if (a === b) return true
  return (
    a.temp.warnHigh === b.temp.warnHigh &&
    a.temp.dangerHigh === b.temp.dangerHigh &&
    a.temp.dangerLow === b.temp.dangerLow &&
    a.sysBp.dangerHigh === b.sysBp.dangerHigh &&
    a.sysBp.warnLow === b.sysBp.warnLow &&
    a.diaBp.dangerHigh === b.diaBp.dangerHigh &&
    a.diaBp.warnLow === b.diaBp.warnLow &&
    a.pulse.dangerHigh === b.pulse.dangerHigh &&
    a.pulse.warnLow === b.pulse.warnLow
  )
}

/**
 * 期間（古い順の日）の中で、基準が前の日と変わった一番新しい日（線・凡例は期間の最後の日の基準で描くので、その基準がいつから
 * かを知らせる＝計画の質問11）。変わっていなければ null
 */
export function lastChangeDay(days: readonly string[], tFor: (day: string) => VitalThresholds): string | null {
  for (let i = days.length - 1; i > 0; i -= 1) {
    if (!sameVitalLimits(tFor(days[i]), tFor(days[i - 1]))) return days[i]
  }
  return null
}

/** 「〇/〇から基準が変わりました」（温度板の凡例の下・カルテのグラフの下に1行） */
export function changedFromText(day: string): string {
  return `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}から基準が変わりました`
}

/** 個人の基準で判定した項目に添える注記（段階2d-2。要注意の理由・読み上げに足す。施設の基準のままの項目には付けない） */
export const INDIVIDUAL_LIMIT_NOTE = '（個人の基準）'

/**
 * その項目（バイタルの列の名前）の基準が個人の値か。thresholdsFor は個人の値で作った組だけを新しい物にし、
 * 施設の基準のままの組は base の物をそのまま使うので、組が base と別の物なら個人の値（SpO2 は個別の目標＝A9 の側なので常に false）
 */
export function isIndividualField(field: 'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2', t: VitalThresholds, base: VitalThresholds): boolean {
  if (field === 'temp') return t.temp !== base.temp
  if (field === 'sys_bp') return t.sysBp !== base.sysBp
  if (field === 'dia_bp') return t.diaBp !== base.diaBp
  if (field === 'pulse') return t.pulse !== base.pulse
  return false
}

/** 施設の基準に戻した項目の知らせ（無ければ null） */
export function fallbackNotice(fallback: ReadonlySet<VitalLimitGroup>): string | null {
  if (fallback.size === 0) return null
  const names = (['temp', 'sysBp', 'diaBp', 'pulse'] as const).filter((g) => fallback.has(g)).map((g) => VITAL_LIMIT_GROUP_LABEL[g])
  return `${names.join('・')}は、個人の基準が施設の基準と合わないため、施設の基準で判定しています。`
}

/** 画面の入力（文字のまま）。空欄＝その項目は施設の基準 */
export type VitalLimitInput = Record<VitalLimitField, string> & { valid_from: string; basis: string }

/**
 * 画面の入力を検査し、送る値にする。範囲の外・小数の誤り・段階の順の崩れ（入れた値どうし）・根拠なし・開始日が今日より前は
 * 理由の文。today は日本時間の今日（YYYY-MM-DD）
 */
export function parseVitalLimitInput(
  input: VitalLimitInput,
  today: string,
): { ok: true; value: Record<VitalLimitField, number | null> & { valid_from: string; basis: string } } | { ok: false; message: string } {
  const value = {} as Record<VitalLimitField, number | null>
  for (const f of VITAL_LIMIT_FIELDS) {
    const t = (input[f] ?? '').normalize('NFKC').trim()
    if (t === '') {
      value[f] = null
      continue
    }
    const r = VITAL_LIMIT_RANGES[f]
    if (!(r.decimal ? /^\d+(\.\d)?$/ : /^\d+$/).test(t)) {
      return { ok: false, message: `${VITAL_LIMIT_LABEL[f]}は${r.decimal ? '小数1桁までの数' : '整数'}で入れてください。` }
    }
    const n = Number(t)
    if (n < r.min || n > r.max) return { ok: false, message: `${VITAL_LIMIT_LABEL[f]}は ${r.min}〜${r.max} で入れてください。` }
    value[f] = n
  }
  const lt = (a: number | null, b: number | null) => a === null || b === null || a < b
  if (!lt(value.temp_warn_high, value.temp_danger_high) || !lt(value.temp_danger_low, value.temp_warn_high) || !lt(value.temp_danger_low, value.temp_danger_high)) {
    return { ok: false, message: '体温は「危険の低 ＜ 注意の高 ＜ 危険の高」になるように入れてください。' }
  }
  if (!lt(value.sys_bp_warn_low, value.sys_bp_danger_high)) return { ok: false, message: '血圧の上は「注意の低 ＜ 危険の高」になるように入れてください。' }
  if (!lt(value.dia_bp_warn_low, value.dia_bp_danger_high)) return { ok: false, message: '血圧の下は「注意の低 ＜ 危険の高」になるように入れてください。' }
  if (!lt(value.pulse_warn_low, value.pulse_danger_high)) return { ok: false, message: '脈は「注意の低 ＜ 危険の高」になるように入れてください。' }
  const basis = input.basis.trim()
  if (basis === '') return { ok: false, message: '根拠（主治医の指示とその日付など）を入れてください。' }
  if ([...basis].length > VITAL_LIMIT_BASIS_MAX) return { ok: false, message: `根拠は ${VITAL_LIMIT_BASIS_MAX} 字までで入れてください。` }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.valid_from)) return { ok: false, message: '開始日を入れてください。' }
  if (input.valid_from < today) return { ok: false, message: '開始日は今日以降にしてください（前の日から効かせることはできません。主治医の指示の日は根拠に書いてください）。' }
  return { ok: true, value: { ...value, valid_from: input.valid_from, basis } }
}

/** その行が、足した日（日本時間）の当日か（取り消せるのは当日だけ）。created_at が読めなければ false */
export function cancelableToday(row: Pick<ResidentVitalLimit, 'created_at'>, today: string): boolean {
  if (row.created_at === null) return false
  const t = Date.parse(row.created_at)
  if (!Number.isFinite(t)) return false
  const jst = new Date(t + 9 * 3600_000).toISOString().slice(0, 10)
  return jst === today
}

/** 1行の値の要約（画面・履歴）。全部 null は「施設の基準に戻す」 */
export function limitSummary(row: ResidentVitalLimit): string {
  const parts: string[] = []
  for (const f of VITAL_LIMIT_FIELDS) {
    const v = row[f]
    if (v !== null) parts.push(`${VITAL_LIMIT_LABEL[f]} ${v}`)
  }
  return parts.length === 0 ? '施設の基準に戻す' : parts.join('・')
}
