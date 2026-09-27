// 体重管理アプリ（weight-record.html／gas/weight-api.gs）の体重を、カルテに出すために読むだけのクライアント。
// 2026-09-27 追加（代表指示: 月1回の測定日に入力した体重を、カルテのその日付の位置に「今回（前回）」で出す）。
// 拡張子付きで import する（bath.ts と同じ。tests/weight.test.mjs から直接読めるようにするため）
//
// ── 守ること（レビューで機械確認される）──
//  1. 接続先は体重管理アプリが同じ端末（同じオリジン）の localStorage に置いた
//     `wtmgr_api_url`・`wtmgr_api_token` を**読むだけ**。書かない・消さない（体重管理アプリの設定を壊さない）。
//  2. GAS へ送るのは読み取りの getAll だけ（POST 本文。合言葉を URL に載せない）。書き込み action の経路を作らない。
//  3. 取得した体重は画面のメモリにだけ持つ。localStorage にも console にも残さない（この file は console を使わない）。
//  4. 照合は体重管理の residents.masterId ↔ care-log の residents.source_id だけ。照合できない記録は捨てる
//     （氏名で寄せない＝取り違えを作らない）。
//  5. 実名・合言葉・接続先の具体値をコードに書かない。

import { fmtDayLabel } from './format.ts'
import type { Resident } from './types.ts'

/** 体重管理アプリが localStorage に置く接続先のキー（weight-record.html の API_KEY / API_TOKEN_KEY と同じ） */
export const WEIGHT_LS_URL = 'wtmgr_api_url'
export const WEIGHT_LS_TOKEN = 'wtmgr_api_token'

/** GAS エンドポイントの許容形式（gasClient.ts と同じ基準。これ以外の宛先へ合言葉を送らない） */
const GAS_ENDPOINT_RE = /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/

/** getAll のタイムアウト（体重管理の全件を返すため、名簿同期より長めに待つ） */
export const WEIGHT_TIMEOUT_MS = 25000

/** 体重管理アプリの ?masterId= が受け付ける形（weight-record.html wrReadMasterIdParam と同じ） */
const MASTER_ID_RE = /^[0-9A-Za-z_-]{1,32}$/

/** 体重管理アプリを開くリンク（care-log と同じサイトの care-tools 配下。氏名は URL に載せない） */
const WEIGHT_APP_PATH = '../care-tools/weight-record.html'

/** 接続設定が無い端末に出す案内 */
export const MSG_WEIGHT_UNCONFIGURED =
  '体重管理アプリの接続設定がこの端末にありません（体重管理アプリを一度開いて接続すると表示されます）'

/** 1回の測定（1日1件に畳んだもの） */
export interface WeightEntry {
  /** 測定日 'YYYY-MM-DD' */
  date: string
  /** 体重（kg。車椅子で量った記録は車椅子の重さを引いた値＝体重管理アプリの weight） */
  weight: number
  /** 測定方法（車椅子に乗ったまま量った記録は 'chair'） */
  mode: 'chair' | 'normal'
}

export type WeightFailReason = 'url' | 'timeout' | 'network' | 'http' | 'refused' | 'format'

export type WeightFetchResult =
  | { ok: true; byResident: Map<number, WeightEntry[]> }
  | { ok: false; reason: WeightFailReason }

// ───────────────────────── 接続設定（読むだけ） ─────────────────────────

/**
 * 体重管理アプリの接続先を読む。URL が無ければ null（＝この端末は未接続）。
 * 形式が GAS でなければ 'invalid'（合言葉を知らない宛先へ送らない）。
 * 合言葉は無くてもよい（体重管理アプリも未設定なら送らない。サーバーが要求していれば失敗として出る）。
 */
export function readWeightConfig(): { url: string; token: string } | 'invalid' | null {
  let url = ''
  let token = ''
  try {
    if (typeof localStorage === 'undefined') return null
    url = (localStorage.getItem(WEIGHT_LS_URL) ?? '').trim()
    token = (localStorage.getItem(WEIGHT_LS_TOKEN) ?? '').trim()
  } catch {
    return null // localStorage が使えない環境＝未接続扱い（例外を外へ出さない）
  }
  if (!url) return null
  if (!GAS_ENDPOINT_RE.test(url)) return 'invalid'
  return { url, token }
}

// ───────────────────────── 受信データの正規化（純関数） ─────────────────────────

function isRealIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1) return false
  return d <= new Date(y, mo, 0).getDate()
}

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 測定日を 'YYYY-MM-DD' に揃える（weight-record.html の _toIsoDate と同じ考え方）。
 * シートの日付セルは GAS 経由で "2026-04-14T15:00:00.000Z" のような UTC の時刻に化けるため、
 * 端末の現地時刻で日付に戻す（slice で切ると前日になる）。読めなければ null＝その記録は出さない。
 */
export function toIsoDay(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isRealIsoDate(s) ? s : null
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) || /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) return localIso(d)
  }
  return null
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function toKey(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function stampOf(v: unknown): number {
  if (typeof v !== 'string' && typeof v !== 'number') return -Infinity
  const t = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(t) ? t : -Infinity
}

/**
 * getAll の応答を resident_id（care-log）ごとの測定の列（日付の古い順）にする。
 * - 照合は 体重管理 residents.masterId ↔ care-log residents.source_id（文字列として完全一致）
 * - 照合できない入居者・記録、日付か体重が読めない記録（体重 0 以下も）は捨てる
 * - 同じ日に複数の記録がある時は updatedAt が最も新しい1件を採る（同時刻なら後の行）
 */
export function mapWeights(
  payload: unknown,
  residents: ReadonlyArray<Pick<Resident, 'id' | 'source_id'>>,
): Map<number, WeightEntry[]> {
  const out = new Map<number, WeightEntry[]>()
  if (!payload || typeof payload !== 'object') return out
  const p = payload as { residents?: unknown; records?: unknown }
  const wRes = Array.isArray(p.residents) ? p.residents : []
  const wRec = Array.isArray(p.records) ? p.records : []

  // care-log: source_id → resident_id
  const bySource = new Map<string, number>()
  for (const r of residents) {
    if (!r || typeof r.id !== 'number') continue
    const k = toKey(r.source_id)
    if (k !== null) bySource.set(k, r.id)
  }
  // 体重管理: 入居者 id → care-log resident_id
  const toCareLog = new Map<string, number>()
  for (const w of wRes) {
    if (!w || typeof w !== 'object') continue
    const o = w as { id?: unknown; masterId?: unknown }
    const wid = toKey(o.id)
    const mid = toKey(o.masterId)
    if (wid === null || mid === null) continue
    const rid = bySource.get(mid)
    if (rid !== undefined) toCareLog.set(wid, rid)
  }

  // resident_id → 日付 → 採用した1件
  const picked = new Map<number, Map<string, { e: WeightEntry; stamp: number }>>()
  for (const rec of wRec) {
    if (!rec || typeof rec !== 'object') continue
    const o = rec as Record<string, unknown>
    const wid = toKey(o.residentId)
    if (wid === null) continue
    const rid = toCareLog.get(wid)
    if (rid === undefined) continue
    const date = toIsoDay(o.measuredOn)
    const weight = toNum(o.weight)
    if (date === null || weight === null || weight <= 0) continue
    const chairKg = toNum(o.wheelchairKg)
    const mode: WeightEntry['mode'] =
      o.measureMode === 'chair' || (o.measureMode == null && chairKg !== null && chairKg > 0) ? 'chair' : 'normal'
    const stamp = stampOf(o.updatedAt)
    const days = picked.get(rid) ?? new Map<string, { e: WeightEntry; stamp: number }>()
    const cur = days.get(date)
    if (!cur || stamp >= cur.stamp) days.set(date, { e: { date, weight, mode }, stamp })
    picked.set(rid, days)
  }
  for (const [rid, days] of picked) {
    const list = Array.from(days.values(), (x) => x.e).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    out.set(rid, list)
  }
  return out
}

// ───────────────────────── 取得（読み取りのみ） ─────────────────────────

/**
 * 体重管理の GAS から getAll を取り、resident_id ごとの測定の列にする。
 * 接続設定が無い端末では null。失敗は { ok:false, reason }（例外を外へ出さない）。
 */
export async function fetchWeights(
  residents: ReadonlyArray<Pick<Resident, 'id' | 'source_id'>>,
): Promise<WeightFetchResult | null> {
  const cfg = readWeightConfig()
  if (cfg === null) return null
  if (cfg === 'invalid') return { ok: false, reason: 'url' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), WEIGHT_TIMEOUT_MS)
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      // 合言葉は本文だけに載せる。未設定なら送らない（体重管理アプリと同じ）
      body: JSON.stringify({ action: 'getAll', token: cfg.token || undefined }),
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl.signal,
    })
    if (!res.ok) return { ok: false, reason: 'http' }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return { ok: false, reason: 'format' }
    }
    if (!body || typeof body !== 'object') return { ok: false, reason: 'format' }
    if ((body as { ok?: unknown }).ok !== true) return { ok: false, reason: 'refused' }
    return { ok: true, byResident: mapWeights(body, residents) }
  } catch (e) {
    const aborted = e != null && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError'
    return { ok: false, reason: aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/** 失敗の理由を画面の文にする（応答の中身は出さない） */
export function weightFailMessage(reason: WeightFailReason): string {
  switch (reason) {
    case 'url':
      return '体重管理アプリの接続先の形式が正しくないため、体重を読み込めませんでした。体重管理アプリの設定をご確認ください。'
    case 'timeout':
      return '体重管理アプリからの応答が時間内にありませんでした。通信状況を確認して、「再試行する」を押してください。'
    case 'refused':
      return '体重管理アプリのサーバーが読み取りを受け付けませんでした（合言葉の不一致など）。体重管理アプリの接続設定をご確認ください。'
    default:
      return '体重を読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'
  }
}

// ───────────────────────── 表示の組み立て（純関数） ─────────────────────────

export interface WeightRow {
  entry: WeightEntry
  /** 直前の測定（期間外でもよい）。無ければ null */
  prev: WeightEntry | null
  /** 今回−前回（kg・小数1桁に丸め）。前回が無ければ null */
  diff: number | null
}

/** 期間 [fromIso, toIso] の測定を新しい順に。前回は列全体（期間外を含む）から取る */
export function weightRowsInRange(list: ReadonlyArray<WeightEntry>, fromIso: string, toIso: string): WeightRow[] {
  const sorted = list.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const rows: WeightRow[] = []
  sorted.forEach((e, i) => {
    if (e.date < fromIso || e.date > toIso) return
    const prev = i > 0 ? sorted[i - 1] : null
    const diff = prev ? Math.round((e.weight - prev.weight) * 10) / 10 : null
    rows.push({ entry: e, prev, diff })
  })
  return rows.reverse()
}

export function fmtKg(n: number): string {
  return n.toFixed(1)
}

/** 差の表示（↑↓ と ±値。色だけに頼らない）。0 は「±0.0」で矢印なし */
export function fmtWeightDiff(diff: number): { arrow: '↑' | '↓' | ''; text: string; dir: 'up' | 'down' | 'same' } {
  if (diff > 0) return { arrow: '↑', text: `+${fmtKg(diff)}`, dir: 'up' }
  if (diff < 0) return { arrow: '↓', text: `−${fmtKg(-diff)}`, dir: 'down' }
  return { arrow: '', text: '±0.0', dir: 'same' }
}

/** 1行の文（読み上げ・検証用）。例「9/14（日） 52.3kg（前回53.1kg・↓−0.8）」「…（前回なし）」 */
export function weightLineText(row: WeightRow): string {
  const head = `${fmtDayLabel(row.entry.date)} ${fmtKg(row.entry.weight)}kg`
  if (!row.prev || row.diff === null) return `${head}（前回なし）`
  const d = fmtWeightDiff(row.diff)
  return `${head}（前回${fmtKg(row.prev.weight)}kg・${d.arrow}${d.text}）`
}

/** 体重管理アプリを開くリンク。source_id が体重管理の受け付ける形でなければ一覧を開く */
export function weightAppHref(sourceId: string | null | undefined): string {
  const id = typeof sourceId === 'string' ? sourceId.trim() : ''
  return MASTER_ID_RE.test(id) ? `${WEIGHT_APP_PATH}?masterId=${encodeURIComponent(id)}` : WEIGHT_APP_PATH
}
