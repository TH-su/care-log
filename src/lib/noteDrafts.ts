// 書きかけ（日報 cl_dailyDraft:<日付>・申し送りフォーム cl_draftNote）を、同じ端末の別のタブで食い合わない形で持つ。
// 2026-09-29（本人承認・申し送りを消さない作り替え M3・L1）。純関数だけ（localStorage の読み書きは画面が行う）。
//
// 形（どちらのキーも同じ）:
//   { v: 1, savedAt, …旧版が読む中身（全タブの和集合）…, tabs: { <タブの印>: { at, rows: [行…] } }, gone: { <行の印>: 時刻 } }
//   ・行は { did（行の印）, at（最後に直した時刻）, kind, data（画面の書きかけそのもの） }
//   ・タブは自分の tabs[<自分の印>] だけを書き換える（他のタブの分は消さない＝削除は自分のタブの分だけ）
//   ・読む時は全タブの和集合（同じ行の印は新しい方）。登録できた・破棄した行は gone に印（その時刻までの版）を付け、
//     和集合から外す。別のタブの書きかけを引き継ぐ時は新しい印を振り、元の行を from でたどる（印を共有しない）
//   ・旧版が読むのは上の「…旧版が読む中身…」（v: 1 のまま）。旧版へ戻しても書きかけを「形が違う」で消さない
//   ・tabs の無い控え（旧版が書いた v1）は、中身から決まる行の印で読み替える（同じ控えを2つのタブが読み替えても同じ印）
//   ・24時間で黙って消すのはやめた（L1）。古い書きかけは「〇日前の書きかけ」と出して残し、利用者が破棄した時だけ消す
//
// 業務データ（本文など）を持つのは cl_dailyDraft・cl_draftNote の既存の契約キーだけ（新しいキーは作らない）。

/** 引き継いだ元の行の版（行の印と、その時の時刻） */
export interface DraftOrigin {
  did: string
  at: number
}

/** 書きかけの1行 */
export interface DraftRow<D> {
  did: string
  at: number
  kind: string
  data: D
  /**
   * 別のタブ（前の起動を含む）の書きかけを引き継いだ時の元の行（新しい順・最大 ORIGIN_MAX 件）。
   * 引き継いだ行は自分の新しい印で持つ（元の行の印を共有しない＝元のタブが後から直した入力を和集合から外さない・
   * 2026-09-29 修正依頼6）。元の行のその版は、引き継いだ行があるかぎり和集合に重ねて出さない
   */
  from?: DraftOrigin[]
}

/** 引き継ぎの元をたどる上限（再読み込みのたびに1段ずつ伸びる。古い元はその前に整理されている） */
const ORIGIN_MAX = 8

interface TabPart<D> {
  at: number
  rows: DraftRow<D>[]
}

/** 控えの中身（新しい形の部分） */
export interface DraftFile<D> {
  tabs: Record<string, TabPart<D>>
  gone: Record<string, number>
}

/** 登録・破棄の印を持つ期間（他のタブがまだ古い控えを持っていても復活させない猶予） */
const GONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** このタブ（この起動）の印。再読み込みすると新しい印になる（前の印の書きかけは和集合で引き継ぐ） */
export const DRAFT_TAB_ID: string = newId('dt')

/** 書きかけの行の印 */
export function newDraftId(): string {
  return newId('dr')
}

/** 中身から決まる短い指紋（旧版の控えの読み替えに使う。同じ中身＝同じ印） */
function hashOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** 旧版（tabs の無い控え）の行の印。種類・並び・中身から決める */
export function legacyDraftId(kind: string, index: number, data: unknown): string {
  return `L${kind}${index}-${hashOf(JSON.stringify(data) ?? '')}`
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * 控えの原文（JSON を解いた後）から新しい形の部分を読む。tabs の無い控え（旧版）は legacy で行へ読み替える。
 * readData は1行の中身の検査（読めない行は落とす＝その行だけ。残りは読む）
 */
export function parseDraftFile<D>(
  o: Record<string, unknown>,
  readData: (kind: string, x: unknown) => D | null,
  legacy: (o: Record<string, unknown>) => DraftRow<D>[],
): DraftFile<D> {
  const gone: Record<string, number> = {}
  if (isObj(o.gone)) {
    for (const [k, v] of Object.entries(o.gone)) {
      const t = finite(v)
      if (t !== null) gone[k] = t
    }
  }
  if (!isObj(o.tabs)) {
    const rows = legacy(o)
    return { tabs: rows.length > 0 ? { v1: { at: finite(o.savedAt) ?? 0, rows } } : {}, gone }
  }
  const tabs: Record<string, TabPart<D>> = {}
  for (const [tab, part] of Object.entries(o.tabs)) {
    if (!isObj(part) || !Array.isArray(part.rows)) continue
    const rows: DraftRow<D>[] = []
    for (const r of part.rows) {
      if (!isObj(r) || typeof r.did !== 'string' || r.did === '' || typeof r.kind !== 'string') continue
      const data = readData(r.kind, r.data)
      if (data === null) continue
      const row: DraftRow<D> = { did: r.did, at: finite(r.at) ?? 0, kind: r.kind, data }
      if (Array.isArray(r.from)) {
        const from: DraftOrigin[] = []
        for (const o of r.from) {
          if (isObj(o) && typeof o.did === 'string' && o.did !== '' && finite(o.at) !== null) from.push({ did: o.did, at: o.at as number })
        }
        if (from.length > 0) row.from = from.slice(0, ORIGIN_MAX)
      }
      rows.push(row)
    }
    tabs[tab] = { at: finite(part.at) ?? 0, rows }
  }
  return { tabs, gone }
}

/** その版に登録済み・破棄済みの印が付いているか（印の時刻より後に直された版は外さない） */
function isGone<D>(gone: Record<string, number>, r: DraftRow<D>): boolean {
  const t = gone[r.did]
  return t !== undefined && r.at <= t
}

/** 引き継いだ行が覆っている元の行の版（行の印 → 覆っている版の時刻の最大） */
function coverOf<D>(rows: DraftRow<D>[], gone: Record<string, number>): Map<string, number> {
  const cover = new Map<string, number>()
  for (const r of rows) {
    if (isGone(gone, r)) continue
    for (const o of r.from ?? []) cover.set(o.did, Math.max(cover.get(o.did) ?? 0, o.at))
  }
  return cover
}

/**
 * 全タブの和集合（同じ行の印は新しい方・登録済み／破棄済みの印の付いた版は外す・引き継がれた元の版は外す）。古い順。
 * 元のタブが引き継がれた後に直した版（時刻が新しい）は外さない（重ねて出る＝重複は許すが、消さない）
 */
export function unionDraftRows<D>(file: DraftFile<D>): DraftRow<D>[] {
  const all = Object.values(file.tabs).flatMap((p) => p.rows)
  const cover = coverOf(all, file.gone)
  const by = new Map<string, DraftRow<D>>()
  for (const r of all) {
    if (isGone(file.gone, r)) continue
    const c = cover.get(r.did)
    if (c !== undefined && r.at <= c) continue
    const cur = by.get(r.did)
    if (cur === undefined || r.at > cur.at) by.set(r.did, r)
  }
  return [...by.values()].sort((a, b) => a.at - b.at)
}

/**
 * 和集合から読んだ行を、このタブの行として引き継ぐ（新しい印を振り、元の行をたどれるようにする。時刻は元のまま＝
 * 「〇日前の書きかけ」を保つ）。元の行には印を付けない（元のタブが後から直した入力を消さない）
 */
export function adoptDraftRows<D>(rows: DraftRow<D>[]): DraftRow<D>[] {
  return rows.map((r) => ({
    ...r,
    did: newDraftId(),
    from: [{ did: r.did, at: r.at }, ...(r.from ?? [])].slice(0, ORIGIN_MAX),
  }))
}

/**
 * このタブから無くなった行（登録できた・破棄した）に付ける印。自分の行はいまの時刻、引き継いだ元の行は
 * 引き継いだ時の版だけ（元のタブがその後に直した版は外さない）
 */
export function goneMarksFor<D>(rows: DraftRow<D>[], now: number): DraftOrigin[] {
  const out: DraftOrigin[] = []
  for (const r of rows) {
    out.push({ did: r.did, at: now })
    for (const o of r.from ?? []) out.push(o)
  }
  return out
}

/**
 * 自分のタブの分だけを書き換えた控えを返す（他のタブの分は、自分が同じ行をより新しく持っている・登録済み／破棄済みの
 * 行だけになった時にだけ外す＝他のタブの新しい入力を消さない）。rows が空なら自分の分を外す
 */
export function writeTabRows<D>(file: DraftFile<D> | null, tab: string, rows: DraftRow<D>[], now: number): DraftFile<D> {
  const base: DraftFile<D> = file ?? { tabs: {}, gone: {} }
  const tabs: Record<string, TabPart<D>> = {}
  const mine = new Map(rows.map((r) => [r.did, r]))
  const cover = coverOf([...Object.entries(base.tabs).filter(([t]) => t !== tab).flatMap(([, p]) => p.rows), ...rows], base.gone)
  for (const [t, part] of Object.entries(base.tabs)) {
    if (t === tab) continue
    const alive = part.rows.filter((r) => {
      if (isGone(base.gone, r)) return false
      const c = cover.get(r.did)
      if (c !== undefined && r.at <= c) return false // 引き継がれた版（引き継いだ行が持っている）
      const m = mine.get(r.did)
      return m === undefined || m.at < r.at
    })
    if (alive.length > 0) tabs[t] = part // 残す時は元のまま（他のタブの分を書き換えない）
  }
  if (rows.length > 0) tabs[tab] = { at: now, rows }
  const gone: Record<string, number> = {}
  const present = new Set(Object.values(tabs).flatMap((p) => p.rows.map((r) => r.did)))
  for (const [k, t] of Object.entries(base.gone)) if (present.has(k) || now - t < GONE_KEEP_MS) gone[k] = t
  return { tabs, gone }
}

/**
 * 登録できた・破棄した行に印を付ける（和集合から外し、他のタブ・次の起動で復活させない）。
 * 文字列はその行の印（いまの時刻までの版）、{did, at} はその時刻までの版だけ（後から直された版は外さない）
 */
export function markDraftsGone<D>(
  file: DraftFile<D> | null,
  marks: readonly (string | DraftOrigin)[],
  now: number,
): DraftFile<D> {
  const base: DraftFile<D> = file ?? { tabs: {}, gone: {} }
  const gone = { ...base.gone }
  for (const m of marks) {
    const did = typeof m === 'string' ? m : m.did
    const at = typeof m === 'string' ? now : m.at
    if (did === '') continue
    gone[did] = Math.max(gone[did] ?? 0, at)
  }
  return { tabs: base.tabs, gone }
}

/** 何日前の書きかけか（1日未満は null＝印を出さない）。例: 「3日前の書きかけ」 */
export function draftAgeLabel(at: number, now: number): string | null {
  if (!(at > 0) || now - at < DAY_MS) return null
  return `${Math.floor((now - at) / DAY_MS)}日前の書きかけ`
}
