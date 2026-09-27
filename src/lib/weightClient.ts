// 体重管理アプリ（weight-record.html／gas/weight-api.gs）の体重を、カルテに出すために読むだけのクライアント。
// 2026-09-27 追加（代表指示: 月1回の測定日に入力した体重を、カルテのその日付の位置に「今回（前回）」で出す）。
// 拡張子付きで import する（bath.ts と同じ。tests/weight.test.mjs から直接読めるようにするため）
//
// ── 守ること（レビューで機械確認される）──
//  1. 接続先は体重管理アプリが同じ端末（同じオリジン）の localStorage に置いた
//     `wtmgr_api_url`・`wtmgr_api_token` を**読むだけ**。書かない・消さない（体重管理アプリの設定を壊さない）。
//  2. GAS へ送るのは読み取りの getAll だけ（POST 本文。合言葉を URL に載せない）。書き込み action の経路を作らない。
//  3. 取得した体重は画面のメモリにだけ持つ。localStorage にも console にも残さない（この file は console を使わない）。
//  4. 照合は体重管理の入居者の masterId ↔ care-log の residents.source_id だけ。照合できない記録は捨てる
//     （氏名で寄せない＝取り違えを作らない）。
//     ★masterId は体重管理の GAS（シート）にはほぼ無い。体重管理アプリは masterId を端末の中だけに持つ
//       （weight-record.html の RES_CLIENT_ONLY）。そこで同じ端末の `wtmgr_v1` から「入居者 id → masterId」の
//       対応表だけを読み（書かない）、サーバーの記録に当てる。フェイスシート・入居者マスタと同じ読み方
//       （2026-09-27 本番で全員「記録なし」になった不具合の根治）。サーバーと端末で masterId が食い違う人は出さない。
//  5. 実名・合言葉・接続先の具体値をコードに書かない。

import { fmtDayLabel } from './format.ts'
import type { Resident } from './types.ts'

/** 体重管理アプリが localStorage に置く接続先のキー（weight-record.html の API_KEY / API_TOKEN_KEY と同じ） */
export const WEIGHT_LS_URL = 'wtmgr_api_url'
export const WEIGHT_LS_TOKEN = 'wtmgr_api_token'
/** 体重管理アプリの端末データ（入居者と記録の塊）。ここから入居者 id → masterId の対応表だけを読む */
export const WEIGHT_LS_DB = 'wtmgr_v1'

/** GAS エンドポイントの許容形式（gasClient.ts と同じ基準。これ以外の宛先へ合言葉を送らない） */
const GAS_ENDPOINT_RE = /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/

/**
 * getAll のタイムアウト（体重管理の全件を返すため、名簿同期より長めに待つ）。
 * 2026-09-27 に 25 秒→45 秒へ延ばした: 本番の GAS は、データを返さない疎通確認だけでも
 * 1.4〜15.4 秒かかる時間帯があり（実測）、全件の読み取りが 25 秒を超えて「応答なし」になったため。
 */
export const WEIGHT_TIMEOUT_MS = 45000

/**
 * 一度読んだ体重を画面のメモリに持つ時間（2026-09-27 追加）。getAll は全員分を返すので、
 * 入居者を切り替えるたびに取り直さず、この時間内は手元の結果を使う。「再試行する」は取り直す。
 * 持つのはメモリだけ（localStorage に置かない＝守ること 3）。持つのは番号と体重だけで氏名は持たない（WeightSnapshot）。
 */
export const WEIGHT_CACHE_MS = 10 * 60 * 1000

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
  | {
      ok: true
      byResident: Map<number, WeightEntry[]>
      /** この端末の体重管理アプリの対応表（入居者 id → masterId）の件数。0＝この端末では体重管理アプリの紐づけが無い */
      linked: number
    }
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
 * getAll の応答から、照合に要る番号と体重だけを取り出したもの（氏名・居室は持たない）。
 * メモリに持つのはこの形。care-log の誰に当たるかは、表示のたびに pickForResidents で決める
 * （以前の mapWeights と同じ手順で照合するため＝挙動を変えない）。
 */
export interface WeightSnapshot {
  /** 体重管理の入居者 id → masterId の列（シートの行順。同じ id が重なれば複数） */
  widMids: Map<string, string[]>
  /** 読めた記録（日付・体重が読めない行、体重 0 以下は捨てたあと。シートの行順） */
  recs: Array<{ wid: string; e: WeightEntry; stamp: number }>
}

export function parseWeightPayload(payload: unknown): WeightSnapshot {
  const snap: WeightSnapshot = { widMids: new Map(), recs: [] }
  if (!payload || typeof payload !== 'object') return snap
  const p = payload as { residents?: unknown; records?: unknown }
  const wRes = Array.isArray(p.residents) ? p.residents : []
  const wRec = Array.isArray(p.records) ? p.records : []
  for (const w of wRes) {
    if (!w || typeof w !== 'object') continue
    const o = w as { id?: unknown; masterId?: unknown }
    const wid = toKey(o.id)
    const mid = toKey(o.masterId)
    if (wid === null || mid === null) continue
    const mids = snap.widMids.get(wid) ?? []
    mids.push(mid)
    snap.widMids.set(wid, mids)
  }
  for (const rec of wRec) {
    if (!rec || typeof rec !== 'object') continue
    const o = rec as Record<string, unknown>
    const wid = toKey(o.residentId)
    if (wid === null) continue
    const date = toIsoDay(o.measuredOn)
    const weight = toNum(o.weight)
    if (date === null || weight === null || weight <= 0) continue
    const chairKg = toNum(o.wheelchairKg)
    const mode: WeightEntry['mode'] =
      o.measureMode === 'chair' || (o.measureMode == null && chairKg !== null && chairKg > 0) ? 'chair' : 'normal'
    snap.recs.push({ wid, e: { date, weight, mode }, stamp: stampOf(o.updatedAt) })
  }
  return snap
}

/**
 * 直近に読んだ端末データの目印（長さ＋要約値）と対応表。同じなら JSON を読み直さない（体重の塊は MB 級になりうるため）。
 * 全文は持たない（氏名・記録を画面のメモリに残さない）
 */
let localMapKey: string | null = null
let localMapCache: Map<string, string> = new Map()

/** 文字列の要約値（FNV-1a 32bit。一致の目印にだけ使う） */
function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * 同じ端末の体重管理アプリのデータ（wtmgr_v1）から、入居者 id → masterId の対応表だけを作る。読むだけ。
 * 氏名・記録は取り出さない。無い・壊れている・読めない時は空（例外を外へ出さない）。
 */
export function readLocalMasterMap(): Map<string, string> {
  let raw: string | null = null
  try {
    if (typeof localStorage === 'undefined') return new Map()
    raw = localStorage.getItem(WEIGHT_LS_DB)
  } catch {
    return new Map()
  }
  if (!raw) return new Map()
  const key = `${raw.length}:${fnv1a(raw)}`
  if (key === localMapKey) return localMapCache
  const out = new Map<string, string>()
  try {
    const db = JSON.parse(raw) as { residents?: unknown }
    const list = db && Array.isArray(db.residents) ? db.residents : []
    for (const w of list) {
      if (!w || typeof w !== 'object') continue
      const o = w as { id?: unknown; masterId?: unknown }
      const wid = toKey(o.id)
      const mid = toKey(o.masterId)
      if (wid !== null && mid !== null) out.set(wid, mid)
    }
  } catch {
    return new Map()
  }
  localMapKey = key
  localMapCache = out
  return out
}

/**
 * サーバーと端末の対応表を合わせる（入居者 id → masterId の候補列）。
 * - サーバーに masterId が無い人は端末の値を使う
 * - サーバーにある人で端末にも値がある時: サーバーの候補に端末の値があればそれ1つに絞る。どれとも違えば
 *   どちらが正しいか分からないので外す＝その人の体重は出さない（別人の体重を出さない）
 * - サーバーにだけある人は従来どおりサーバーの値
 */
export function resolveWidMids(
  server: ReadonlyMap<string, string[]>,
  local: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [wid, mids] of server) {
    const lm = local.get(wid)
    if (lm !== undefined && mids.length > 0) {
      if (mids.includes(lm)) out.set(wid, [lm])
      continue
    }
    out.set(wid, mids.slice())
  }
  for (const [wid, mid] of local) {
    if (!server.has(wid)) out.set(wid, [mid])
  }
  return out
}

/**
 * 取り出した記録を care-log の resident_id ごとの測定の列（日付の古い順）にする。
 * 照合の手順は 2026-09-27 までの mapWeights と同じ:
 * - care-log: source_id → resident_id（同じ source_id が重なれば後の人）
 * - 体重管理の入居者 id → resident_id は、masterId が care-log の誰かに一致した行だけで決める（一致した最後の行）
 * - 同じ日に複数の記録がある時は updatedAt が最も新しい1件を採る（同時刻なら後の行）
 */
function pickForResidents(
  snap: WeightSnapshot,
  residents: ReadonlyArray<Pick<Resident, 'id' | 'source_id'>>,
  widMids: ReadonlyMap<string, string[]> = snap.widMids,
): Map<number, WeightEntry[]> {
  const bySource = new Map<string, number>()
  for (const r of residents) {
    if (!r || typeof r.id !== 'number') continue
    const k = toKey(r.source_id)
    if (k !== null) bySource.set(k, r.id)
  }
  const toCareLog = new Map<string, number>()
  for (const [wid, mids] of widMids) {
    for (const mid of mids) {
      const rid = bySource.get(mid)
      if (rid !== undefined) toCareLog.set(wid, rid)
    }
  }
  const picked = new Map<number, Map<string, { e: WeightEntry; stamp: number }>>()
  for (const r of snap.recs) {
    const rid = toCareLog.get(r.wid)
    if (rid === undefined) continue
    const days = picked.get(rid) ?? new Map<string, { e: WeightEntry; stamp: number }>()
    const cur = days.get(r.e.date)
    if (!cur || r.stamp >= cur.stamp) days.set(r.e.date, { e: r.e, stamp: r.stamp })
    picked.set(rid, days)
  }
  const out = new Map<number, WeightEntry[]>()
  for (const [rid, days] of picked) {
    // 呼び出し側が書き換えてもメモリの記録が変わらないよう、写しを返す
    const list = Array.from(days.values(), (x) => ({ ...x.e })).sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    )
    out.set(rid, list)
  }
  return out
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
  return pickForResidents(parseWeightPayload(payload), residents)
}

// ───────────────────────── 取得（読み取りのみ） ─────────────────────────

type SnapFetchResult = { ok: true; snap: WeightSnapshot } | { ok: false; reason: WeightFailReason }

/** 画面のメモリにだけ持つ直近の成功結果（接続先ごと）と、送信中の取得（同時に何本も投げない） */
let weightCache: { url: string; at: number; snap: WeightSnapshot } | null = null
let weightInflight: { url: string; p: Promise<SnapFetchResult> } | null = null

/** メモリの体重を捨てる（テストと、将来のログアウト処理用） */
export function clearWeightCache(): void {
  weightCache = null
  weightInflight = null
  localMapKey = null
  localMapCache = new Map()
}

async function requestAll(url: string, token: string): Promise<SnapFetchResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), WEIGHT_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      // 合言葉は本文だけに載せる。未設定なら送らない（体重管理アプリと同じ）
      body: JSON.stringify({ action: 'getAll', token: token || undefined }),
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
    return { ok: true, snap: parseWeightPayload(body) }
  } catch (e) {
    const aborted = e != null && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError'
    return { ok: false, reason: aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 体重管理の GAS から getAll を取り、resident_id ごとの測定の列にする。
 * 接続設定が無い端末では null。失敗は { ok:false, reason }（例外を外へ出さない）。
 * 直近 WEIGHT_CACHE_MS 以内に同じ接続先から取れていれば、通信せずその結果を使う。
 * force（「再試行する」）の時はメモリの結果を使わず取り直す。送信中の取得があればそれを待つ（二重に投げない）。
 */
export async function fetchWeights(
  residents: ReadonlyArray<Pick<Resident, 'id' | 'source_id'>>,
  opts: { force?: boolean } = {},
): Promise<WeightFetchResult | null> {
  const cfg = readWeightConfig()
  if (cfg === null) return null
  if (cfg === 'invalid') return { ok: false, reason: 'url' }
  const now = Date.now()
  if (
    !opts.force &&
    weightCache !== null &&
    weightCache.url === cfg.url &&
    now - weightCache.at >= 0 &&
    now - weightCache.at < WEIGHT_CACHE_MS
  ) {
    return pickWithLocal(weightCache.snap, residents)
  }
  let p: Promise<SnapFetchResult>
  if (weightInflight !== null && weightInflight.url === cfg.url) {
    p = weightInflight.p
  } else {
    const url = cfg.url
    p = requestAll(url, cfg.token).then((r) => {
      if (r.ok) weightCache = { url, at: Date.now(), snap: r.snap }
      return r
    })
    const mine = { url, p }
    weightInflight = mine
    void p.finally(() => {
      if (weightInflight === mine) weightInflight = null
    })
  }
  const r = await p
  if (!r.ok) return { ok: false, reason: r.reason }
  return pickWithLocal(r.snap, residents)
}

/** サーバーの記録に、端末の対応表を合わせて当てる（対応表は表示のたびに読む＝体重管理アプリで紐づけ直した分がすぐ効く） */
function pickWithLocal(
  snap: WeightSnapshot,
  residents: ReadonlyArray<Pick<Resident, 'id' | 'source_id'>>,
): WeightFetchResult {
  const local = readLocalMasterMap()
  const widMids = resolveWidMids(snap.widMids, local)
  return { ok: true, byResident: pickForResidents(snap, residents, widMids), linked: local.size }
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

/**
 * その人の全記録のうち最新の1件（期間に関係なく出す・2026-09-27 チーフ追加修正）。
 * 月1回の測定は既定の期間（2週）に入らないことが多く、期間内だけだと「測定なし」に見えるため。記録が無ければ null
 */
export function latestWeightRow(list: ReadonlyArray<WeightEntry>): WeightRow | null {
  if (list.length === 0) return null
  const sorted = list.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const entry = sorted[sorted.length - 1]
  const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null
  const diff = prev ? Math.round((entry.weight - prev.weight) * 10) / 10 : null
  return { entry, prev, diff }
}

/**
 * この端末では体重管理の入居者を誰も結びつけられない時の文（端末の体重管理アプリに入居者マスタとの紐づけが無い）。
 * 体重管理アプリを開くと入居者マスタの名簿と紐づく（mergeCommonWeight）ので、それを案内する
 */
export const MSG_WEIGHT_UNLINKED =
  'この端末では、体重管理アプリの入居者とカルテの入居者を結びつけられませんでした。この端末で体重管理アプリを一度開いてから、カルテを再読み込みしてください'

/** 体重管理アプリにこの方の記録が1件も無い（照合できない場合も含む）時の文 */
export const MSG_WEIGHT_NO_RECORDS =
  '体重管理アプリにこの方の記録が見つかりません（体重管理アプリ側の入居者の紐づけを確認してください）'

/** 記録はあるが表示期間内に無い時の文（最新の1行は別に出す） */
export const MSG_WEIGHT_NONE_IN_RANGE = '表示期間内の測定はありません（最新は上の1行）'

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
