// 排便記録アプリ（haiben-record.html／gas/haiben-api.gs）の記録を、カルテの「排泄」欄と「今日の要注意」に出すために
// 読むだけのクライアント。2026-10-16 追加（本人の決定 2026-10-16）。weightClient.ts と同じ作法。
// 拡張子付きで import する（tests/excretion*.test.mjs から node で直接読めるようにするため）
//
// ── 守ること（試験で機械確認される）──
//  1. 接続先と合言葉は、排便記録アプリが同じ端末（同じオリジン）の localStorage に置いた
//     `hbcr_api_url`・`hbcr_api_token`（無ければ同じアプリの予備のキー `_bak`・`_bak2`）を**読むだけ**。書かない・消さない。
//     sessionStorage（タブごとで別のタブには届かない）・Cookie・IndexedDB は読まない（排便記録アプリは見つけた値を
//     localStorage の主キーへ書き戻すので、アプリを開いた端末なら主キーにある）。
//  2. GAS へ送るのは読み取りの getAll だけ（POST 本文・text/plain。合言葉を URL に載せない）。書き込みの action の経路を作らない。
//  3. 取得した記録は画面のメモリにだけ持つ（EXCRETION_CACHE_MS）。localStorage・IndexedDB にも console にも残さない。
//     メモリに持つのは照合に要る「空白を除いた氏名」と居室・判定に要る項目だけ。記録のメモ（notes）・記入者（staff）は捨てる。
//  4. 照合は「氏名（types.ts の nameKey と同じ＝空白の違いだけ吸収）＋居室」の両方が一致した方だけ。
//     同じ氏名がどちらかに2人以上・居室が食い違う・見つからない時は結ばない（違う方の記録を出さないことが最優先）。
//     退居された方（care-log の active=false）は照合の候補から外す。
//  5. 実名・合言葉・接続先の具体値をコードに書かない。
//
// ── 読み方（getAll の since を「今から16日前」にして送る・理由）──
//  gas/haiben-api.gs（2026-10-16 時点）の読み取りは3つ:
//   ・getAll（since なし）… 全期間の全件（約4.4MB・最大46秒と GAS のコメントにある）。重すぎる
//   ・getDays … 指定した日の記録。1回7日まで（GETDAYS_MAX）＝14日の一覧だけで2回、余白を足すと3回に分かれる
//   ・getAll（since あり・heal を付けない＝既定）… 「日付が直近14日（RECENT_DAYS・日本時間）」の記録は必ず返し、
//     それより前は「updatedAt（書いた時刻）が since 以降」の記録だけを返す
//  3つ目に since＝今から16日前を渡すと、1回の通信で「直近14日は漏れなく」＋「15〜16日前もほぼ（その頃に書いた分）」が届く。
//  14日の一覧はこれで満たし、「最後の排便から◯日」は、少量の数え方（48時間以内の3回目）が一覧の縁でずれないよう
//  2日の余白を付けた16日ぶんの記録で数える。直近14日に排便1回分が無い方は「14日以上」と下限で出す（それ以上は遡らない）。
//  受け取った記録のうち 16日より前の日付のもの（古い記録を最近書き直したもの）は捨てる（数える範囲を一定にする）。

import { nameKey } from './types.ts'
import type { Meal, Resident } from './types.ts'
import type { AlertReason } from './vitalAlerts.ts'

/** 排便記録アプリが localStorage に置く接続先のキー（haiben-record.html の API_KEY / API_KEY_BAK / API_KEY_BAK2 と同じ） */
export const HAIBEN_LS_URL_KEYS: readonly string[] = ['hbcr_api_url', 'hbcr_api_url_bak', 'hbcr_api_url_bak2']
/** 合言葉のキー（API_TOKEN_KEY / API_TOKEN_KEY_BAK と同じ） */
export const HAIBEN_LS_TOKEN_KEYS: readonly string[] = ['hbcr_api_token', 'hbcr_api_token_bak']

/** GAS エンドポイントの許容形式（weightClient.ts・gasClient.ts と同じ基準。これ以外の宛先へ合言葉を送らない） */
const GAS_ENDPOINT_RE = /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/

/**
 * 待ちの上限。排便記録アプリ自身が同じ読み方（since 付きの getAll）に30秒を使っている
 * （haiben-record.html apiGet: 差分でも約8秒かかる実測から 30 秒に緩和したとある）。それより短くすると、
 * 排便記録アプリでは読めるのに care-log だけ「応答なし」になるため同じ30秒にする。
 */
export const EXCRETION_TIMEOUT_MS = 30000

/** 一度読んだ記録を画面のメモリに持つ時間（5分）。カルテで入居者を切り替える・要注意と行き来するたびに取り直さない */
export const EXCRETION_CACHE_MS = 5 * 60 * 1000

/** カルテに出す一覧の日数（今日を含む） */
export const EXCRETION_LIST_DAYS = 14
/** サーバーが日付で必ず返す日数（gas/haiben-api.gs の RECENT_DAYS。今日−14日〜今日） */
export const HAIBEN_RECENT_DAYS = 14
/** since に使う日数（直近14日＋少量の数え方の余白2日） */
export const EXCRETION_FETCH_DAYS = 16

/** 排便記録アプリの既定のしきい値（haiben-record.html の D.cfg の初期値 stoolWarnD:2, stoolDangerD:3） */
export const HAIBEN_DEFAULT_STOOL = { stoolWarnD: 2, stoolDangerD: 3 } as const

/** 接続設定が無い端末に出す案内 */
export const MSG_EXCRETION_UNCONFIGURED =
  'この端末には排便記録の接続設定がありません（排便記録のアプリで設定した端末で見られます）'

export type ExcretionFailReason = 'url' | 'timeout' | 'network' | 'http' | 'auth' | 'refused' | 'format'

// ───────────────────────── 接続設定（読むだけ） ─────────────────────────

function firstLs(keys: readonly string[]): string {
  for (const k of keys) {
    const v = (localStorage.getItem(k) ?? '').trim()
    if (v !== '') return v
  }
  return ''
}

/**
 * 排便記録アプリの接続先と合言葉を読む。どちらかが無ければ null（＝この端末は未設定。サーバーは合言葉の無い要求を
 * 全部断るため、合言葉が無いまま送らない）。形式が GAS でなければ 'invalid'（合言葉を知らない宛先へ送らない）。
 */
export function readExcretionConfig(): { url: string; token: string } | 'invalid' | null {
  let url = ''
  let token = ''
  try {
    if (typeof localStorage === 'undefined') return null
    url = firstLs(HAIBEN_LS_URL_KEYS)
    token = firstLs(HAIBEN_LS_TOKEN_KEYS)
  } catch {
    return null // localStorage が使えない環境＝未設定扱い（例外を外へ出さない）
  }
  if (!url || !token) return null
  if (!GAS_ENDPOINT_RE.test(url)) return 'invalid'
  return { url, token }
}

// ───────────────────────── 受信データの正規化（純関数） ─────────────────────────

/** 排便記録の入居者（照合と判定に要る分だけ。表示用の氏名は持たない） */
export interface HbResident {
  /** 排便記録の入居者 id（数字は数字の文字列に揃える） */
  id: string
  /** 空白を除いた氏名（nameKey）。照合にだけ使う */
  key: string
  /** 居室（normRoom 済み。無ければ ''） */
  room: string
  /** 居室（表示用。排便記録の値の前後の空白を除いたもの） */
  roomLabel: string
  active: boolean
  hidden: boolean
  /** 入居者ごとのしきい値（有限の数だけ。無ければ undefined） */
  cfg: { stoolWarnD?: number; stoolDangerD?: number }
  /** 入院の履歴（サーバーは持たない＝通常は空。来た時だけ判定の凍結に使う） */
  hospitalizations: Array<{ admissionAt: string; dischargeAt: string | null }>
}

/** 排便記録の1件（判定と一覧に要る項目だけ。notes・staff は持たない） */
export interface HbRecord {
  id: string
  residentId: string
  type: 'urine' | 'stool' | 'both' | 'laxative'
  /** 'YYYY-MM-DD' */
  date: string
  /** 'HH:MM'（読めなければ ''） */
  time: string
  /** 'YYYY-MM-DDTHH:MM…'（端末の時刻として読む。読めなければ ''） */
  datetime: string
  /** 経過時間の基準（排便記録アプリの tsUTC と同じ決め方） */
  tsUTC?: number
  /** 量（'少量'・'中等量'・'多量'・空欄）。排便記録の値のまま */
  stoolAmt: string | null
  /** 性状の表示（排便記録の fmtCons と同じ） */
  cons: string
  /** 下剤（laxative の時だけ） */
  medicine: string
  tablets: string
}

export interface HbSnapshot {
  residents: HbResident[]
  /** 入居者 id → 記録（datetime の昇順＝排便記録の recsByRes と同じ並び） */
  recs: Map<string, HbRecord[]>
  /** 全体のしきい値（既定に、サーバーの Config の有限の数を重ねたもの） */
  cfg: { stoolWarnD: number; stoolDangerD: number }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

function toKey(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s === '') return null
  // 排便記録アプリは id を数に揃えて扱う（toNum）。'12' と 12 を同じ方にする
  return /^\d+$/.test(s) ? String(Number(s)) : s
}

function finiteNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** 居室の比べ方: 全角・半角の違い（NFKC）・空白・末尾の「号室」を吸収する */
export function normRoom(v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'number') return ''
  let s = String(v)
  try {
    s = s.normalize('NFKC')
  } catch {
    // normalize が無い環境はそのまま
  }
  return s.replace(/[\s　]/g, '').replace(/号室$/, '')
}

const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/

function localDt(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 日付を 'YYYY-MM-DD' に（GAS の出口で日本時間の日付に揃っている。ISO の時刻つきは端末の時刻で日付に戻す） */
function normDate(v: unknown): string {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) return localDt(d).slice(0, 10)
  }
  return ''
}

/** 排便記録の fmtCons と同じ（性状が無ければブリストルのタイプ） */
const BRISTOL: Readonly<Record<string, string>> = { 1: '硬球状', 2: '硬塊状', 3: 'ひび割れ', 4: '普通便', 5: '軟便', 6: '泥状便', 7: '水様便' }
function consOf(o: Record<string, unknown>): string {
  if (typeof o.consistency === 'string' && o.consistency !== '') return o.consistency
  const b = o.bristol
  if ((typeof b === 'number' || typeof b === 'string') && String(b) !== '' && b !== 0) return `タイプ${b}(${BRISTOL[String(b)] ?? ''})`
  return ''
}

/** 排便記録の職員の控え・旧版の印（haiben-record.html isUserRec・_isStaffRes と同じ値） */
const SYS_STAFF_SNAPSHOT_ID = 'sys_staffs_snapshot_v1'
const SYS_STAFF_SNAPSHOT_MARKER = '_SYS_STAFFS_SNAPSHOT_'
const SYS_STAFF_ROOMS = ['STAFF', '_staff_']
const LEGACY_SYS_RID = '999999'
const LEGACY_SYS_NAME_PREFIX = '__sys_staffs__'

function parseRecord(raw: unknown): HbRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = toKey(o.id)
  const residentId = toKey(o.residentId)
  if (id === null || residentId === null) return null
  // isUserRec と同じ除外（職員の控え・旧版の遺留）
  if (o.type === '_sys_staffs_' || id === 'sys_staffs_v1' || id === SYS_STAFF_SNAPSHOT_ID) return null
  if (o.type === 'laxative' && o.medicine === SYS_STAFF_SNAPSHOT_MARKER) return null
  const type = o.type
  if (type !== 'urine' && type !== 'stool' && type !== 'both' && type !== 'laxative') return null
  const date = normDate(o.date)
  // 時刻・日時は排便記録アプリが受け取った記録に当てる正規化と同じ考え方（cleanData）:
  // TZ 付きの日時は端末の時刻へ書き換え、日時が無い・壊れている時は日付＋時刻から組み直す
  let datetime = ''
  if (typeof o.datetime === 'string' && DT_RE.test(o.datetime.trim())) {
    const s = o.datetime.trim()
    if (TZ_RE.test(s)) {
      const d = new Date(s)
      datetime = Number.isNaN(d.getTime()) ? '' : localDt(d)
    } else datetime = s
  }
  let time = ''
  if (typeof o.time === 'string') {
    const m = /^(\d{1,2}):(\d{2})/.exec(o.time.trim())
    if (m) time = `${pad2(Number(m[1]))}:${m[2]}`
  }
  if (!time && datetime) time = datetime.slice(11, 16)
  if (!datetime && date && time) datetime = `${date}T${time}`
  const day = date || (datetime ? datetime.slice(0, 10) : '')
  if (!day) return null // 日付の無い記録は一覧にも数えにも載せられない
  // tsUTC: 数で届いた時だけそのまま。それ以外は日時から（haiben-record.html cleanData と同じ）
  let tsUTC: number | undefined
  if (typeof o.tsUTC === 'number' && !Number.isNaN(o.tsUTC)) tsUTC = o.tsUTC
  else if (datetime) {
    const t = new Date(datetime).getTime()
    if (!Number.isNaN(t)) tsUTC = t
  }
  const tablets = typeof o.tablets === 'number' ? (Number.isFinite(o.tablets) ? String(o.tablets) : '') : typeof o.tablets === 'string' ? o.tablets.trim() : ''
  return {
    id,
    residentId,
    type,
    date: day,
    time,
    datetime,
    ...(tsUTC !== undefined ? { tsUTC } : {}),
    stoolAmt: typeof o.stoolAmt === 'string' ? o.stoolAmt : null,
    cons: consOf(o),
    medicine: type === 'laxative' && typeof o.medicine === 'string' ? o.medicine.trim() : '',
    tablets: type === 'laxative' ? tablets : '',
  }
}

function parseResident(raw: unknown): HbResident | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = toKey(o.id)
  if (id === null || typeof o.name !== 'string') return null
  const roomRaw = typeof o.room === 'string' || typeof o.room === 'number' ? String(o.room).trim() : ''
  const yomi = typeof o.yomi === 'string' ? o.yomi : ''
  // 職員の控えの行・旧版の印（isUserRes）は入居者ではない
  if (SYS_STAFF_ROOMS.includes(roomRaw) || SYS_STAFF_ROOMS.includes(yomi)) return null
  if (id === LEGACY_SYS_RID || o.name.indexOf(LEGACY_SYS_NAME_PREFIX) === 0) return null
  const key = nameKey(o.name.trim())
  if (key === '') return null
  // 在籍: 排便記録アプリと同じ（未設定・true・'TRUE' は在籍）
  const a = o.active
  const active = a === undefined || a === null || a === true || a === 'TRUE'
  const h = o.hidden
  const hidden = h === true || (typeof h === 'string' && /^(TRUE|1|YES)$/i.test(h))
  let c: unknown = o.cfg
  if (typeof c === 'string' && c.trim().charAt(0) === '{') {
    try {
      c = JSON.parse(c)
    } catch {
      c = null
    }
  }
  const cfg: HbResident['cfg'] = {}
  if (c && typeof c === 'object') {
    const w = finiteNum((c as Record<string, unknown>).stoolWarnD)
    const d = finiteNum((c as Record<string, unknown>).stoolDangerD)
    if (w !== undefined) cfg.stoolWarnD = w
    if (d !== undefined) cfg.stoolDangerD = d
  }
  const hospitalizations: HbResident['hospitalizations'] = []
  if (Array.isArray(o.hospitalizations)) {
    for (const x of o.hospitalizations) {
      if (!x || typeof x !== 'object') continue
      const hx = x as Record<string, unknown>
      if (typeof hx.admissionAt !== 'string' || hx.admissionAt === '') continue
      hospitalizations.push({ admissionAt: hx.admissionAt, dischargeAt: typeof hx.dischargeAt === 'string' && hx.dischargeAt !== '' ? hx.dischargeAt : null })
    }
  }
  return { id, key, room: normRoom(roomRaw), roomLabel: roomRaw, active, hidden, cfg, hospitalizations }
}

/**
 * getAll の応答を、照合と判定に要る形にする。壊れた値は捨てる（例外を外へ出さない）。
 * keepFrom（'YYYY-MM-DD'）より前の日付の記録は捨てる（数える範囲を一定にする）。pads 列の有無には関係しない（読まない）。
 */
export function parseExcretionPayload(payload: unknown, keepFrom = ''): HbSnapshot {
  const snap: HbSnapshot = { residents: [], recs: new Map(), cfg: { ...HAIBEN_DEFAULT_STOOL } }
  if (!payload || typeof payload !== 'object') return snap
  const p = payload as { residents?: unknown; records?: unknown; cfg?: unknown }
  for (const r of Array.isArray(p.residents) ? p.residents : []) {
    const x = parseResident(r)
    if (x) snap.residents.push(x)
  }
  if (p.cfg && typeof p.cfg === 'object') {
    const w = finiteNum((p.cfg as Record<string, unknown>).stoolWarnD)
    const d = finiteNum((p.cfg as Record<string, unknown>).stoolDangerD)
    if (w !== undefined) snap.cfg.stoolWarnD = w
    if (d !== undefined) snap.cfg.stoolDangerD = d
  }
  const seen = new Set<string>()
  for (const r of Array.isArray(p.records) ? p.records : []) {
    const x = parseRecord(r)
    if (!x || (keepFrom && x.date < keepFrom)) continue
    // 同じ id の行が2つ届いた時は後の行（排便記録アプリのマージと同じく id で1件）
    const k = `${x.residentId}|${x.id}`
    if (seen.has(k)) {
      const list = snap.recs.get(x.residentId) ?? []
      const i = list.findIndex((y) => y.id === x.id)
      if (i >= 0) list[i] = x
      continue
    }
    seen.add(k)
    const list = snap.recs.get(x.residentId) ?? []
    list.push(x)
    snap.recs.set(x.residentId, list)
  }
  // 入居者ごとに datetime の昇順（recsByRes と同じ: 文字列の localeCompare・同じ値は届いた順＝安定な並べ替え）
  for (const list of snap.recs.values()) list.sort((a, b) => (a.datetime || '').localeCompare(b.datetime || ''))
  return snap
}

// ───────────────────────── 照合（純関数） ─────────────────────────

export type ExcretionMatchFail = 'inactive' | 'dupCareLog' | 'dupHaiben' | 'roomMismatch' | 'notFound'

export type ExcretionMatch =
  | { ok: true; hb: HbResident }
  | { ok: false; reason: ExcretionMatchFail; hbRoom?: string }

/** 排便記録の照合の候補（入居者で、在籍・非表示でない方） */
function hbCandidates(list: readonly HbResident[]): HbResident[] {
  return list.filter((r) => r.active && !r.hidden)
}

/**
 * care-log の方を排便記録の入居者に結ぶ（決定 2026-10-16）。
 * - 退居された方（active=false）は結ばない
 * - care-log の在籍の方に同じ氏名（nameKey）が2人以上 → 結ばない
 * - 排便記録の在籍の方に同じ氏名が2人以上 → 結ばない
 * - 1人ずつで居室（normRoom）が食い違う・どちらかの居室が空 → 結ばない
 * - 排便記録に同じ氏名が居ない → 結ばない
 */
export function matchExcretionResident(
  target: Pick<Resident, 'id' | 'name' | 'room' | 'active'>,
  careLog: ReadonlyArray<Pick<Resident, 'id' | 'name' | 'room' | 'active'>>,
  hbResidents: readonly HbResident[],
): ExcretionMatch {
  if (target.active === false) return { ok: false, reason: 'inactive' }
  const key = nameKey(String(target.name ?? '').trim())
  if (key === '') return { ok: false, reason: 'notFound' }
  const same = careLog.filter((r) => r && r.active !== false && nameKey(String(r.name ?? '').trim()) === key)
  if (same.length > 1 || (same.length === 1 && same[0].id !== target.id)) return { ok: false, reason: 'dupCareLog' }
  const hb = hbCandidates(hbResidents).filter((r) => r.key === key)
  if (hb.length === 0) return { ok: false, reason: 'notFound' }
  if (hb.length > 1) return { ok: false, reason: 'dupHaiben' }
  const room = normRoom(target.room ?? '')
  if (room === '' || hb[0].room === '' || room !== hb[0].room) return { ok: false, reason: 'roomMismatch', hbRoom: hb[0].roomLabel }
  return { ok: true, hb: hb[0] }
}

/** 照合できない理由を画面の文にする（「排便記録と照合できません（理由）」） */
export function excretionMatchMessage(m: Extract<ExcretionMatch, { ok: false }>): string {
  const why: Record<ExcretionMatchFail, string> = {
    inactive: '退居された方は照合しません',
    dupCareLog: 'このアプリに同じお名前の方が2人以上います',
    dupHaiben: '排便記録に同じお名前の方が2人以上います',
    roomMismatch: m.hbRoom ? `居室が食い違っています。排便記録の居室は「${m.hbRoom}」です` : '居室が食い違っています（どちらかの居室が未登録です）',
    notFound: '排便記録に同じお名前の方が見つかりません',
  }
  return `排便記録と照合できません（${why[m.reason]}）`
}

// ══════════════════════════════════════════════════════════════
// 「排便なし◯日」の判定（排便記録アプリからの写し）
// 写し元: /Users/Takeshi/Claude/Repos/haiben-record/haiben-record.html
//   コミット ce3653404aac62e658be7b57404a4a9f7d52fea9（2026-10-16 23:59 時点の HEAD。4066ba6 から判定の範囲は同じで行だけ7行ずれた）
//   ・elH            4436〜4450 行（記録の tsUTC を優先・無ければ datetime を端末の時刻として読む）
//   ・_freezeIfHosp  4451〜4468 行（入院中は入院日時で時間を止める）
//   ・resCfg         4472〜4474 行（入居者ごとの cfg → 全体の cfg）
//   ・badgeCls       4475〜4477 行（排便は 日数 = 時間/24 を stoolDangerD・stoolWarnD と比べる）
//   ・STOOL_SMALL_N / STOOL_SMALL_WIN_H / stoolResetSeries  4478〜4504 行
//   ・lastR          4505〜4515 行（排便の記録＝stool と both を datetime の昇順で並べた最後のリセット点）
//   ・「便◯日」の日数 4826〜4828 行（renderResTiles 内）（入居者のタイル: Math.floor(時間/24)）
// 判定の中身は一字一句の意味を変えない（tests/excretion-parity.test.mjs が写し元の関数を切り出して同じ入力で比べる）。
// 写し元と違う所は入口だけ: しきい値の値は「有限の数」だけを受ける（parseExcretionPayload。写し元は空文字も
// 値として使い 0 日扱いになる）。入院の履歴はサーバーに無い（端末にだけある）ため、通常は凍結が効かない。
// ══════════════════════════════════════════════════════════════

export const STOOL_SMALL_N = 3
export const STOOL_SMALL_WIN_H = 48

/** stoolResetSeries の写し: 排便の記録（stool/both・datetime 昇順）から「排便1回分」とみなすリセット点の列 */
export function stoolResetSeries<T extends { stoolAmt: string | null; datetime: string }>(arr: readonly T[]): T[] {
  const out: T[] = []
  if (!arr || !arr.length) return out
  let chainStart: T | null = null
  let chainCount = 0
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i]
    if (r.stoolAmt === '少量') {
      if (!chainStart) {
        chainStart = r
        chainCount = 1
      } else {
        // 写し元: r.datetime ? (new Date(r.datetime) - new Date(chainStart.datetime)) / 3600000 : 0
        const dt = r.datetime ? (new Date(r.datetime).getTime() - new Date(chainStart.datetime).getTime()) / 3600000 : 0
        if (dt > STOOL_SMALL_WIN_H) {
          chainStart = r
          chainCount = 1
        } else {
          chainCount++
          if (chainCount >= STOOL_SMALL_N) {
            out.push(r)
            chainStart = null
            chainCount = 0
          }
        }
      }
    } else {
      out.push(r)
      chainStart = null
      chainCount = 0
    }
  }
  return out
}

/** lastR(rid,'s') の写し: その方の記録（datetime 昇順）から最後の排便1回分。無ければ null */
export function lastStoolReset(pool: readonly HbRecord[]): HbRecord | null {
  const arr: HbRecord[] = []
  for (const rr of pool) if (rr.type === 'stool' || rr.type === 'both') arr.push(rr)
  const ser = stoolResetSeries(arr)
  return ser.length ? ser[ser.length - 1] : null
}

/** _freezeIfHosp の写し: 入院中なら入院日時、そうでなければ now */
export function freezeIfHosp(hosp: HbResident['hospitalizations'] | undefined, now: number): number {
  if (!Array.isArray(hosp)) return now
  for (const h of hosp) {
    if (!h || !h.admissionAt) continue
    const ad = new Date(h.admissionAt).getTime()
    if (Number.isNaN(ad) || now < ad) continue
    if (h.dischargeAt) {
      const dc = new Date(h.dischargeAt).getTime()
      if (!Number.isNaN(dc) && now >= dc) continue
    }
    return ad
  }
  return now
}

/** elH の写し（記録を渡す形だけ）: 経過時間（時間）。読めなければ null */
export function elapsedH(rec: HbRecord | null, now: number, hosp?: HbResident['hospitalizations']): number | null {
  if (!rec) return null
  if (typeof rec.tsUTC === 'number' && !Number.isNaN(rec.tsUTC)) return (freezeIfHosp(hosp, now) - rec.tsUTC) / 36e5
  const dt = rec.datetime || (rec.date && rec.time ? `${rec.date}T${rec.time}` : '')
  if (!dt) return null
  const t = new Date(dt).getTime()
  if (Number.isNaN(t)) return null
  return (freezeIfHosp(hosp, now) - t) / 36e5
}

/** resCfg の写し（排便の2つだけ） */
export function stoolCfgOf(
  res: Pick<HbResident, 'cfg'> | null,
  global: { stoolWarnD: number; stoolDangerD: number },
): { stoolWarnD: number; stoolDangerD: number } {
  const c = res && res.cfg ? res.cfg : {}
  return {
    stoolWarnD: c.stoolWarnD != null ? c.stoolWarnD : global.stoolWarnD,
    stoolDangerD: c.stoolDangerD != null ? c.stoolDangerD : global.stoolDangerD,
  }
}

export type StoolLevel = 'ok' | 'warn' | 'danger'

/** badgeCls(h,'s') の写し: eb-ok → 'ok'・eb-w → 'warn'・eb-ng → 'danger' */
export function stoolLevel(h: number | null, cfg: { stoolWarnD: number; stoolDangerD: number }): StoolLevel {
  if (h === null) return 'danger'
  const d = h / 24
  if (d >= cfg.stoolDangerD) return 'danger'
  if (d >= cfg.stoolWarnD) return 'warn'
  return 'ok'
}

// ───────────────────────── 画面に出す形（純関数） ─────────────────────────

export interface StoolStatus {
  level: StoolLevel
  /** 最後の排便1回分からの日数（Math.floor(時間/24)。日時が読めない時は null） */
  days: number | null
  /** 直近14日に排便1回分が無い（days は下限＝「◯日以上」） */
  atLeast: boolean
  /** 最後の排便1回分の日時（'YYYY-MM-DDTHH:MM'。無ければ null） */
  lastAt: string | null
  warnD: number
  dangerD: number
}

/** 日本時間の今日（'YYYY-MM-DD'） */
export function jstDay(ms: number): string {
  const d = new Date(ms + 9 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** 'YYYY-MM-DD' に n 日足す（UTC で数える＝端末の時刻帯に左右されない） */
export function addDaysIsoUtc(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return day
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * 「最後の排便から◯日」。記録（datetime 昇順）から排便記録アプリと同じ決まりで数える。
 * 直近14日（サーバーが必ず返す範囲）に排便1回分が無い時は、その範囲の始まり（日本時間の0時）からの時間を下限にして
 * 「◯日以上」と出す（判定も下限で行う＝実際はそれ以上に重い）。
 */
export function stoolStatusOf(
  pool: readonly HbRecord[],
  res: Pick<HbResident, 'cfg' | 'hospitalizations'> | null,
  globalCfg: { stoolWarnD: number; stoolDangerD: number },
  now: number,
): StoolStatus {
  const cfg = stoolCfgOf(res, globalCfg)
  const last = lastStoolReset(pool)
  if (last) {
    const h = elapsedH(last, now, res?.hospitalizations)
    return {
      level: stoolLevel(h, cfg),
      days: h === null ? null : Math.floor(h / 24),
      atLeast: false,
      lastAt: last.datetime || null,
      warnD: cfg.stoolWarnD,
      dangerD: cfg.stoolDangerD,
    }
  }
  const from = addDaysIsoUtc(jstDay(now), -HAIBEN_RECENT_DAYS)
  const start = Date.parse(`${from}T00:00:00+09:00`)
  const h = (freezeIfHosp(res?.hospitalizations, now) - start) / 36e5
  return { level: stoolLevel(h, cfg), days: Math.floor(h / 24), atLeast: true, lastAt: null, warnD: cfg.stoolWarnD, dangerD: cfg.stoolDangerD }
}

/** 一覧の1日 */
export interface ExcretionDay {
  day: string
  /** 排尿の回数（urine と both の件数） */
  urine: number
  stools: Array<{ time: string; amount: string; cons: string }>
  laxatives: Array<{ time: string; medicine: string; tablets: string }>
}

/** 直近 EXCRETION_LIST_DAYS 日（今日を含む・新しい日が上）の一覧 */
export function excretionDays(pool: readonly HbRecord[], now: number, n = EXCRETION_LIST_DAYS): ExcretionDay[] {
  const today = jstDay(now)
  const out: ExcretionDay[] = []
  const byDay = new Map<string, ExcretionDay>()
  for (let i = 0; i < n; i++) {
    const d: ExcretionDay = { day: addDaysIsoUtc(today, -i), urine: 0, stools: [], laxatives: [] }
    out.push(d)
    byDay.set(d.day, d)
  }
  for (const r of pool) {
    const d = byDay.get(r.date)
    if (!d) continue
    if (r.type === 'urine' || r.type === 'both') d.urine++
    if (r.type === 'stool' || r.type === 'both') d.stools.push({ time: r.time, amount: r.stoolAmt ?? '', cons: r.cons })
    if (r.type === 'laxative') d.laxatives.push({ time: r.time, medicine: r.medicine, tablets: r.tablets })
  }
  return out
}

/** 「最後の排便から◯日」の文（色に頼らない: 注意／危険を文字でも出す） */
export function stoolStatusText(s: StoolStatus): string {
  const lv = s.level === 'danger' ? '（危険）' : s.level === 'warn' ? '（注意）' : ''
  if (s.atLeast) return `直近${HAIBEN_RECENT_DAYS}日に排便の記録がありません（${s.days}日以上）${lv}`
  if (s.days === null) return `最後の排便の日時が読めません${lv}`
  return `最後の排便から${s.days}日${lv}`
}

/** 今日の要注意の短い文（「排便なし3日」「排便なし14日以上」） */
export function stoolAlertLabel(s: StoolStatus): string {
  if (s.days === null) return '排便なし（日時不明）'
  return `排便なし${s.days}日${s.atLeast ? '以上' : ''}`
}

// ───────────────────────── 入院中の扱い（本人回答 2026-10-17） ─────────────────────────
// 排便記録アプリの入院の時計止めは端末にしか無い（サーバーに入院の履歴が無い）ため、care-log の食事の記録で見分ける。
// その日の食事の記録のどれか1つでも状態が「入院」なら入院中とみなす。食事の記録が無い日は入院とみなさない。

/** その方のその日の食事の記録に、状態が「入院」のものが1つでもあるか */
export function isHospitalDay(
  meals: ReadonlyArray<Pick<Meal, 'resident_id' | 'meal_on' | 'status'>> | null | undefined,
  residentId: number,
  day: string,
): boolean {
  if (!Array.isArray(meals)) return false
  return meals.some((m) => m != null && m.resident_id === residentId && m.meal_on === day && m.status === 'hospital')
}

/** その日に入院中の方（利用者ID の集まり）。今日の要注意で使う */
export function hospitalIdsOn(meals: ReadonlyArray<Pick<Meal, 'resident_id' | 'meal_on' | 'status'>> | null | undefined, day: string): Set<number> {
  const out = new Set<number>()
  if (!Array.isArray(meals)) return out
  for (const m of meals) if (m != null && m.meal_on === day && m.status === 'hospital') out.add(m.resident_id)
  return out
}

/** 入院中の方の排泄欄に日数の代わりに出す文 */
export const MSG_STOOL_HOSPITAL = '入院中のため判定しません（食事の記録が入院）'

/** 今日の要注意の「照合できない方」に数える理由（排便記録に見つからない方は数えない・本人回答 2026-10-17） */
export function isCountedUnlinked(reason: ExcretionMatchFail): boolean {
  return reason === 'dupCareLog' || reason === 'dupHaiben' || reason === 'roomMismatch'
}

export type ExcretionView =
  | { linked: false; message: string; reason: ExcretionMatchFail }
  | { linked: true; status: StoolStatus; days: ExcretionDay[]; hospital: boolean }

/** care-log の1人について、照合→判定→一覧までをまとめる */
export function excretionViewFor(
  snap: HbSnapshot,
  target: Pick<Resident, 'id' | 'name' | 'room' | 'active'>,
  careLog: ReadonlyArray<Pick<Resident, 'id' | 'name' | 'room' | 'active'>>,
  now: number,
  hospital = false,
): ExcretionView {
  const m = matchExcretionResident(target, careLog, snap.residents)
  if (!m.ok) return { linked: false, message: excretionMatchMessage(m), reason: m.reason }
  const pool = snap.recs.get(m.hb.id) ?? []
  return { linked: true, status: stoolStatusOf(pool, m.hb, snap.cfg, now), days: excretionDays(pool, now), hospital }
}

/**
 * 今日の要注意（/alerts）に足す「排便なし◯日」（注意・危険の方だけ）。targets は画面に出している方（階で絞った在籍の方）、
 * careLog は同じ氏名の数を数えるための在籍の全員。hospital は今日の食事の記録が入院の方（理由を出さない）。
 * 照合できない方は理由を出さず、人数だけ返す（画面で一行知らせる）。人数に数えるのは同じ氏名・居室の食い違いだけで、
 * 排便記録に見つからない方は数えない（isCountedUnlinked）
 */
export function stoolAlertReasons(
  snap: HbSnapshot,
  targets: ReadonlyArray<Pick<Resident, 'id' | 'name' | 'room' | 'active'>>,
  careLog: ReadonlyArray<Pick<Resident, 'id' | 'name' | 'room' | 'active'>>,
  now: number,
  hospital: ReadonlySet<number> = new Set(),
): { reasons: Map<number, AlertReason[]>; unlinked: number } {
  const reasons = new Map<number, AlertReason[]>()
  let unlinked = 0
  for (const t of targets) {
    const m = matchExcretionResident(t, careLog, snap.residents)
    if (!m.ok) {
      if (isCountedUnlinked(m.reason)) unlinked++
      continue
    }
    if (hospital.has(t.id)) continue
    const st = stoolStatusOf(snap.recs.get(m.hb.id) ?? [], m.hb, snap.cfg, now)
    if (st.level === 'ok') continue
    reasons.set(t.id, [
      {
        kind: 'stoolNone',
        section: 'excretion',
        severity: st.level === 'danger' ? 'danger' : 'warn',
        label: stoolAlertLabel(st),
        time: null,
        recordId: null,
      },
    ])
  }
  return { reasons, unlinked }
}

// ───────────────────────── 取得（読み取りのみ） ─────────────────────────

export type ExcretionFetchResult = { ok: true; snap: HbSnapshot; at: number } | { ok: false; reason: ExcretionFailReason }

/** 画面のメモリにだけ持つ直近の成功結果（接続先ごと）と、送信中の取得（同時に何本も投げない） */
let cache: { url: string; at: number; snap: HbSnapshot } | null = null
let inflight: { url: string; p: Promise<ExcretionFetchResult> } | null = null

/** メモリの記録を捨てる（試験と、将来のログアウト処理用） */
export function clearExcretionCache(): void {
  cache = null
  inflight = null
}

async function requestWindow(url: string, token: string): Promise<ExcretionFetchResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), EXCRETION_TIMEOUT_MS)
  const now = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      // 合言葉は本文だけに載せる。since＝今から16日前（上の「読み方」）。heal は付けない（直近14日を必ず返してもらう）
      body: JSON.stringify({ action: 'getAll', since: now - EXCRETION_FETCH_DAYS * 86400000, token }),
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
    const b = body as { ok?: unknown; code?: unknown; residents?: unknown }
    if (b.ok !== true) return { ok: false, reason: b.code === 403 || b.code === '403' ? 'auth' : 'refused' }
    if (!Array.isArray(b.residents)) return { ok: false, reason: 'format' }
    const keepFrom = addDaysIsoUtc(jstDay(now), -EXCRETION_FETCH_DAYS)
    return { ok: true, snap: parseExcretionPayload(body, keepFrom), at: Date.now() }
  } catch (e) {
    const aborted = e != null && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError'
    return { ok: false, reason: aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 排便記録の GAS から直近の記録を読む。接続設定が無い端末では null。失敗は { ok:false, reason }（例外を外へ出さない）。
 * 直近 EXCRETION_CACHE_MS 以内に同じ接続先から取れていれば、通信せずその結果を使う。force の時は取り直す。
 */
export async function fetchExcretion(opts: { force?: boolean } = {}): Promise<ExcretionFetchResult | null> {
  const cfg = readExcretionConfig()
  if (cfg === null) return null
  if (cfg === 'invalid') return { ok: false, reason: 'url' }
  const now = Date.now()
  if (!opts.force && cache !== null && cache.url === cfg.url && now - cache.at >= 0 && now - cache.at < EXCRETION_CACHE_MS) {
    return { ok: true, snap: cache.snap, at: cache.at }
  }
  let p: Promise<ExcretionFetchResult>
  if (inflight !== null && inflight.url === cfg.url) {
    p = inflight.p
  } else {
    const url = cfg.url
    p = requestWindow(url, cfg.token).then((r) => {
      if (r.ok) cache = { url, at: r.at, snap: r.snap }
      return r
    })
    const mine = { url, p }
    inflight = mine
    void p.finally(() => {
      if (inflight === mine) inflight = null
    })
  }
  return p
}

/** 失敗の理由を画面の文にする（応答の中身は出さない） */
export function excretionFailMessage(reason: ExcretionFailReason): string {
  switch (reason) {
    case 'url':
      return '排便記録の接続先の形式が正しくないため、読み込めませんでした。排便記録のアプリの接続設定をご確認ください。'
    case 'auth':
      return '排便記録の合言葉が違います。排便記録のアプリの接続設定をご確認ください。'
    case 'timeout':
      return `排便記録のサーバーから${EXCRETION_TIMEOUT_MS / 1000}秒以内に応答がありませんでした。通信状況を確認して、「再試行する」を押してください。`
    case 'refused':
      return '排便記録のサーバーが読み取りを受け付けませんでした。時間をおいて「再試行する」を押してください。'
    default:
      return '排便記録を読み込めませんでした。通信状況を確認して、「再試行する」を押してください。'
  }
}
