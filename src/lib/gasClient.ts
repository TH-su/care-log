// 読み取り専用の GAS マスタ連携クライアント（利用者・職員スナップショットの同期）。
//
// ── 読み取り専用・PII 非残留規約（wsClient.ts と同型。レビューで機械確認される）──
//  1. GAS エンドポイント・合言葉（トークン）の具体値をコード/リポジトリに書かない（localStorage 手入力のみ）。
//  2. GAS へ送るのは読み取り action（getRoster / pull）だけ。書込 action（save/put/push 系）の
//     コードパスを作らない＝既存GAS・スプレッドシートへの書込は構造的に不可能。
//  3. GAS 応答・Supabase 応答の本文（氏名・かな・居室・介護度）を console / localStorage に一切残さない。
//     console に出すのはエラー種別だけ。
//  4. 取得は最小射影（利用者= id/name/kana/room/gender/careLevel、職員= name のみ）。
//     master.gs getRosterSafe が返す以上の項目は要求しない・保持しない。
//  5. 空応答・通信失敗では 1 行も更新しない（空上書き保護 = dev-principles 原則4）。
//     取得できなかったマスタは「変更しない」に倒し、退去扱い（active=false）を絶対に発生させない。
//  6. Supabase 側も upsert を使わず insert / update を明示分岐し、物理削除はしない（active=false のみ）。
//
// 契約: docs/design/contracts.md「src/lib/gasClient.ts」／設計: docs/design/db-design.md §6。
// 本ファイルは contracts.md の許可により supabase を直接呼ぶ（db.ts を経由しない唯一の例外）。

import { supabase } from './supabase'
import { fetchLastMasterSync, notifyMastersChanged } from './db'
import { LS } from './types'
import type { Resident, Staff } from './types'

/** GAS エンドポイントの許容形式（wsClient.ts と同一基準） */
const GAS_ENDPOINT_RE = /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/

/** GAS 呼び出しのタイムアウト（施設 iPad のモバイル回線を想定） */
const TIMEOUT_MS = 15000

/**
 * マスタ表の読み取り上限。全件ロード禁止規約の limit ガードを兼ねる。
 * 到達＝スナップショットが切れている可能性があるため、同期を中止する（退去判定の誤爆防止）。
 */
const MAX_MASTER_ROWS = 2000

/** GAS から受け取る利用者の最小射影（master.gs getRosterSafe と同じ項目だけ） */
export interface RosterEntry {
  id: string
  name: string
  kana?: string
  room?: string
  gender?: string
  careLevel?: string
  /**
   * 名簿上の在籍状態。false＝退去済み。
   * 退去された方も**行としては取り込む**（2026-08-29）。過去の記録の帰属先が無いと、
   * その方の申し送り・バイタルを一切移行できず、カルテが丸ごと欠けるため。
   * 一覧・入力欄・検索の既定には出ない（画面側が active で絞っている）。
   */
  active?: boolean
}

/**
 * GAS から受け取る職員の最小射影（氏名と在籍状態だけ。労務情報は保持しない）。
 * 退職者も行として取り込む（active=false）＝過去の申し送りの記入者を氏名で照合するため。
 */
export interface StaffEntry {
  name: string
  active: boolean
}

/** マスタ同期1系列分の増減計数（M-024: 増減を両方向とも数える） */
export interface SyncResult {
  before: number
  after: number
  added: number
  deactivated: number
  renamed: number
  needsReview: number
}

// ───────────────────────── 接続設定（localStorage 手入力のみ） ─────────────────────────

type GasConfig = { url: string; token: string }

/**
 * LS.gasUrl / LS.gasToken を読む。値はコードに持たず localStorage からのみ取得する。
 * 未入力（どちらか空）は 'unconfigured'、形式不一致は 'invalid'。localStorage 不可も 'unconfigured'。
 */
function readGasConfig(): GasConfig | 'unconfigured' | 'invalid' {
  let url = ''
  let token = ''
  try {
    url = (localStorage.getItem(LS.gasUrl) ?? '').trim()
    token = (localStorage.getItem(LS.gasToken) ?? '').trim()
  } catch {
    return 'unconfigured' // localStorage が使えない環境＝連携オフ扱い（例外を外へ出さない）
  }
  if (!url || !token) return 'unconfigured'
  if (!GAS_ENDPOINT_RE.test(url)) return 'invalid'
  return { url, token }
}

/**
 * 職員名簿の接続先を読む（2026-08-29 追加）。
 * 職員名簿はシフト連携GAS、利用者名簿は入居者マスタGASと**別のGAS**が持つ。
 * 未設定なら利用者名簿と同じ接続先を返す＝設定していない端末は従来どおりの動きになる。
 * 形式不一致は 'invalid'（黙って利用者側へ倒すと、間違いに気づけないため）。
 */
export function readStaffGasConfig(
  base: GasConfig | 'unconfigured' | 'invalid',
): GasConfig | 'unconfigured' | 'invalid' {
  let url = ''
  let token = ''
  try {
    url = (localStorage.getItem(LS.staffGasUrl) ?? '').trim()
    token = (localStorage.getItem(LS.staffGasToken) ?? '').trim()
  } catch {
    return base
  }
  if (!url && !token) return base // 未設定＝利用者名簿と同じ接続先（従来の挙動）
  if (!url || !token) return 'unconfigured'
  if (!GAS_ENDPOINT_RE.test(url)) return 'invalid'
  return { url, token }
}

// ───────────────────────── GAS 通信（読み取りのみ） ─────────────────────────

/**
 * 名簿の読み取りに失敗した理由（F45・2026-10-10）。画面の文言を原因ごとに分けるために使う
 * （合言葉の誤り・転送の揺れ・電波を1つの文にまとめると、原因でない確認へ誘導してしまうため）。
 * - auth     … 合言葉が違うと断られた（master.gs の「認証エラー」）
 * - postOnly … 本文の無い読み取りとして届いた（Google の転送の揺れで POST の本文が落ちた時・約8回に1回）
 * - refused  … それ以外の断り（不明な action・現場用の合言葉で読めない種類など）
 * - http / format / timeout / network … 通信・応答の形の問題
 */
export type GasReadFail = 'auth' | 'postOnly' | 'refused' | 'http' | 'format' | 'timeout' | 'network'

/** master.gs の doGet が本文なしの読み取りを断る時の文言の頭。比べるだけで、画面にも console にも出さない */
const POST_ONLY_HEAD = 'この読み取りは POST でだけ受け付けます'

/**
 * GAS の読み取り action を POST 本文で送る（F45・2026-10-10）。
 * ★入居者マスタGAS（master.gs）は 2026-09-23 から、合言葉の要る読み取りを GET では受けない（POST 本文だけ）。
 *   以前ここは GET（合言葉を URL のクエリに載せる）で送っていたため、合言葉の正誤に関係なく必ず断られ、
 *   9/23 以降は利用者マスタの同期が一度も通らなかった。
 * - text/plain の本文 {…body, token}（プリフライトを起こさない）。合言葉を URL に載せない
 * - gasPost と違い ok:true を求めない（master.gs の getRoster の応答は {roster,…} で ok を持たない）。
 *   {error} があれば失敗として理由を返す。gasPost は職員名簿（統合GAS・ok:true の契約）用にそのまま残す
 * - console にはエラー種別だけを出し、応答本文（氏名等）・GAS のメッセージ本文は一切出さない
 */
async function gasPostRead<T>(
  url: string,
  body: object,
  token: string,
): Promise<{ ok: true; data: T } | { ok: false; reason: GasReadFail }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ ...body, token }),
      redirect: 'follow',
      signal: ctrl.signal,
    })
    if (!res.ok) {
      console.warn('[gasClient] GAS からの HTTP 応答が異常です（status:', res.status, '）')
      return { ok: false, reason: 'http' }
    }
    let out: unknown
    try {
      out = await res.json()
    } catch {
      console.warn('[gasClient] GAS 応答を読めませんでした（形式の不一致）')
      return { ok: false, reason: 'format' }
    }
    if (!out || typeof out !== 'object') return { ok: false, reason: 'format' }
    if (!Array.isArray(out) && typeof (out as { error?: unknown }).error !== 'undefined') {
      const msg = (out as { error?: unknown }).error
      const text = typeof msg === 'string' ? msg : ''
      if (text === '認証エラー') {
        console.warn('[gasClient] GAS が合言葉の不一致で断りました')
        return { ok: false, reason: 'auth' }
      }
      if (text.startsWith(POST_ONLY_HEAD)) {
        console.warn('[gasClient] GAS が本文なしの読み取りとして受け取りました（転送の揺れ）')
        return { ok: false, reason: 'postOnly' }
      }
      console.warn('[gasClient] GAS がエラー応答を返しました（action または合言葉の種類の不一致）')
      return { ok: false, reason: 'refused' }
    }
    return { ok: true, data: out as T }
  } catch (e) {
    const aborted = e != null && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError'
    console.warn('[gasClient] GAS 呼び出しに失敗しました:', aborted ? 'タイムアウト' : '通信エラー')
    return { ok: false, reason: aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * GAS へ POST する（統合GAS の pull は POST のみ。text/plain でプリフライトを避ける）。
 * body に載せるのは読み取り action と token だけ。書込 action を渡す経路は作らない。
 */
async function gasPost<T>(url: string, body: object, token: string): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ ...body, token }),
      redirect: 'follow',
      signal: ctrl.signal,
    })
    if (!res.ok) {
      console.warn('[gasClient] GAS からの HTTP 応答が異常です（status:', res.status, '）')
      return null
    }
    const out = (await res.json()) as { ok?: unknown } | null
    if (!out || typeof out !== 'object' || out.ok !== true) {
      console.warn('[gasClient] GAS 応答が ok ではありません')
      return null
    }
    return out as T
  } catch (e) {
    const kind = e instanceof DOMException && e.name === 'AbortError' ? 'タイムアウト' : '通信エラー'
    console.warn('[gasClient] GAS 呼び出しに失敗しました:', kind)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ───────────────────────── 受信データの正規化（原則10: 受信を信じない） ─────────────────────────

/** 文字列・数値だけを受け付けて trim する。空・型不一致は undefined */
function pickText(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s === '' ? undefined : s
}

/** 名簿にその項目が実際に載っているか（欠落・空文字は「値なし」＝更新の対象にしない） */
function hasText(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * 氏名の照合キー（M-034 二重照合の氏名側）。
 * NFKC で全角英数字・全角スペースを揃え、空白をすべて落として比較する。
 * 例）'山田 太郎'（半角空白）と '山田　太郎'（全角空白）は同一とみなす。
 */
function normName(s: string | null | undefined): string {
  if (!s) return ''
  return s.normalize('NFKC').replace(/\s+/g, '')
}

/**
 * GAS の名簿応答（`{roster:[…]}` または素の配列）を RosterEntry[] へ最小射影する。
 * id・name のどちらかが欠ける要素と active===false の要素は捨てる。
 * 同一 id が重複したら先勝ち（後続は捨てる）。
 */
function projectRoster(raw: unknown): RosterEntry[] | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { roster?: unknown }).roster)
      ? (raw as { roster: unknown[] }).roster
      : null
  if (!list) return null

  const seen = new Set<string>()
  const out: RosterEntry[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const id = pickText(rec.id)
    const name = pickText(rec.name)
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name,
      kana: pickText(rec.kana),
      room: pickText(rec.room),
      gender: pickText(rec.gender),
      careLevel: pickText(rec.careLevel),
      // ★退去者も落とさずに持ち帰る（在籍状態だけを写す）。
      //   落とすと過去の記録の帰属先が作れず、その方のカルテが移行できない。
      //   名簿が active を返さない場合は「在籍」とみなす（従来どおりの安全側）
      active: rec.active !== false,
    })
  }
  return out
}

/** 統合GAS の staff 応答（配列 or `{staff:[…]}`）から氏名だけを射影する。労務情報は保持しない */
function projectStaffNames(raw: unknown): StaffEntry[] | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { staff?: unknown }).staff)
      ? (raw as { staff: unknown[] }).staff
      : null
  if (!list) return null

  const seen = new Set<string>()
  const names: StaffEntry[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const name = pickText(rec.name)
    if (!name) continue
    const key = normName(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    /**
     * 在籍judgment: シフト連携GASは退職者にも active:true を付けたまま status:'退職' で
     * 区別している（2026-08-29 実データで確認。37名中5名が該当）。
     * active だけを見ると退職者が記録者の選択肢に出てしまうので status も見る。
     * ★退職者も**行としては取り込む**（active=false）。過去の申し送りの記入者を
     *   氏名で照合するため、名前が消えると誰が書いたか分からなくなる。
     */
    const retired = rec.active === false || pickText(rec.status) === '退職'
    // 氏名と在籍状態だけを射影（rules/empCode/employment/qualifications 等は取り込まない）
    names.push({ name, active: !retired })
  }
  return names
}

// ───────────────────────── pull（外部公開・読み取り専用） ─────────────────────────

/**
 * 利用者名簿を POST 本文で読む（F45）。取得失敗は理由つき、0件は空配列（呼び出し側が「取得できず」に倒す）。
 * 本文の落ちた読み取り（postOnly）は Google の転送の揺れなので、その時だけ1回だけ読み直す。
 * since は送らない＝全件を取る（退去の判定に全員が要る）
 */
async function pullRosterRead(
  url: string,
  token: string,
): Promise<{ ok: true; roster: RosterEntry[] } | { ok: false; reason: GasReadFail }> {
  let r = await gasPostRead<unknown>(url, { action: 'getRoster' }, token)
  if (!r.ok && r.reason === 'postOnly') r = await gasPostRead<unknown>(url, { action: 'getRoster' }, token)
  if (!r.ok) return r
  const roster = projectRoster(r.data)
  return roster === null ? { ok: false, reason: 'format' } : { ok: true, roster }
}

/** 取得失敗（null）と「0件」を区別したい内部用 */
async function pullRosterOrNull(url: string, token: string): Promise<RosterEntry[] | null> {
  const r = await pullRosterRead(url, token)
  return r.ok ? r.roster : null
}

/** 取得失敗（null）と「0件」を区別したい内部用。syncMasters はこちらを使う */
async function pullStaffNamesOrNull(url: string, token: string): Promise<StaffEntry[] | null> {
  const out = await gasPost<{ entries?: { staff?: { data?: unknown } } }>(
    url,
    { action: 'pull', keys: ['staff'] },
    token,
  )
  if (!out) return null
  return projectStaffNames(out.entries?.staff?.data)
}

/**
 * 利用者名簿を GAS から取得する（読み取り専用・最小射影）。
 * ★失敗・未接続も空配列を返す。呼び出し側は「0件＝取得できず」とみなし、
 *   マスタの上書き・退去判定に使わないこと（空上書き保護）。
 */
export async function pullRoster(url: string, token: string): Promise<RosterEntry[]> {
  return (await pullRosterOrNull(url, token)) ?? []
}

/**
 * 職員の氏名だけを GAS から取得する（読み取り専用・氏名以外は保持しない）。
 * ★失敗・未接続も空配列。扱いは pullRoster と同じ。
 */
export async function pullStaffNames(url: string, token: string): Promise<StaffEntry[]> {
  return (await pullStaffNamesOrNull(url, token)) ?? []
}

// ───────────────────────── Supabase スナップショットへの反映 ─────────────────────────

/** 同期中の Supabase 書込失敗はすべてこの文面（何が起きたか＋次にどうすればよいか）で外へ返す */
function dbError(what: string): Error {
  return new Error(`${what}。通信状態を確認して、設定画面からもう一度「マスタを同期」してください。`)
}

async function updateResidentRow(id: number, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from('residents')
    .update({ ...patch, synced_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw dbError('利用者マスタを更新できませんでした')
}

async function updateStaffRow(id: number, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from('staff')
    .update({ ...patch, synced_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw dbError('職員マスタを更新できませんでした')
}

/**
 * 氏名が名簿と食い違って保留（要確認）にした方（F51・2026-10-10）。
 * 名簿の氏名は画面のメモリにだけ渡す（localStorage・console に残さない＝規約3）。
 * 設定画面の「名簿の氏名を採用する」（adoptRosterName）に渡す材料
 */
export interface RosterReview {
  /** care-log の利用者 id */
  id: number
  /** いまの一覧の氏名 */
  current: string
  /** 名簿の氏名 */
  roster: string
}

/**
 * 利用者の反映の計画（読んだ行と名簿だけから作る純関数の結果。書き込みはまだしていない）。
 * 書く前に「名簿から一度に外れる人数」を確かめるために、計画と実行を分けている（F43）
 */
export interface ResidentSyncPlan {
  /** 差分のある行の更新（id と変える列だけ） */
  updates: { id: number; patch: Record<string, unknown> }[]
  /** 新しく作る行 */
  inserts: Record<string, unknown>[]
  /** 名簿から行ごと消えた在籍行（在籍解除にする id）。名簿が退去と明示した人（retiredByRoster）は含まない */
  vanished: number[]
  /** 同期前の在籍数 */
  before: number
  /** 在籍として増える人数（退去者の行追加は数えない） */
  added: number
  reactivated: number
  /** 名簿に載ったまま「退去」に変わった人数（名簿から消えた人数とは別経路） */
  retiredByRoster: number
  renamed: number
  needsReview: number
  /** 氏名の食い違いで保留にした方（名簿の氏名つき） */
  reviews: RosterReview[]
}

/**
 * 利用者スナップショットへの反映を計画する（source_id + 氏名の二重照合・M-034）。
 * - source_id 一致 かつ 氏名正規化一致 → 差分のある列だけ update（表記ゆれの吸収は renamed 計数）
 * - source_id 一致 かつ 氏名が大幅不一致 → 別人の可能性。氏名・在籍状態は上書きせず needs_review=true で保留。
 *   ★部屋・介護度だけは名簿どおりに直す（F51・2026-10-10 本人回答）。保留のままだと、部屋を移っても全端末で
 *   元の階の一覧に出続けるため。氏名・かな・性別・在籍状態は、人が裁定するまで変えない
 * - source_id 不一致 かつ 同名の**在籍中の**既存行あり → ID振り直しの可能性。重複行を作らず needs_review=true で保留。
 *   ★退去済み（active=false）の行は氏名照合の候補にしない（F49・2026-10-10）。退去した方と同じ氏名の方が
 *   新しく入居した時（再入居・同姓同名）に、退去行へ保留の印が立つだけで新しい方の行が作られず、
 *   現場用の合言葉の名簿（退去者を返さない）では誰も記録できなかった。過去の記録は source_id が違うので取り違えない
 * - どちらでも当たらない → 新規 insert（upsert は使わない）
 * - 名簿に居ない在籍行 → vanished（実行時に active=false。物理削除しない。過去記録は不変）
 * - 任意項目（かな・居室・性別・介護度）は「名簿に値が載っている時だけ」更新する。
 *   欠落・空文字は「空にせよ」ではなく「変更なし」とみなし、既存値を温存する（原則4）。
 *   全エントリでその列が欠落している場合はその列を一切触らない（正本が返していないだけ）。
 * needs_review は立てるだけで自動解除しない（人が設定画面で裁定する保留印のため）。
 */
export function planResidentSync(rows: Resident[], entries: RosterEntry[]): ResidentSyncPlan {
  // ★note_alias（申し送りでの表示名）は読むだけで**書かない**。
  //   下の patch には一切載せないこと＝マスタ同期で人が入れた表示名を消さない（2026-09-01 指示）
  const before = rows.filter((r) => r.active).length

  const bySource = new Map<string, Resident>()
  const byName = new Map<string, Resident[]>()
  for (const r of rows) {
    const sid = pickText(r.source_id)
    if (sid) bySource.set(sid, r)
    const key = normName(r.name)
    if (!key) continue
    const list = byName.get(key)
    if (list) list.push(r)
    else byName.set(key, [r])
  }

  const incomingIds = new Set(entries.map((e) => e.id))
  // 任意項目（かな・居室・性別・介護度）が「名簿に載っている列」かどうかを先に見る。
  // 全エントリで欠落＝正本がその列を返していないだけなので、その列は一切触らない。
  // 1件でも載っていれば、値のあるエントリだけ更新し、欠けているエントリでは既存値を温存する
  // （欠落を「空にせよ」と解釈して無言で消さない＝multi-device-sync 原則4）。
  const rosterHas = {
    kana: entries.some((e) => hasText(e.kana)),
    room: entries.some((e) => hasText(e.room)),
    gender: entries.some((e) => hasText(e.gender)),
    careLevel: entries.some((e) => hasText(e.careLevel)),
  }
  const matched = new Set<number>() // 今回の名簿に対応づいた既存行（退去判定から除外する）
  const updates: { id: number; patch: Record<string, unknown> }[] = []
  const inserts: Record<string, unknown>[] = []
  const reviews: RosterReview[] = []
  let renamed = 0
  let needsReview = 0
  let reactivated = 0
  let retiredByRoster = 0

  for (const e of entries) {
    const cur = bySource.get(e.id)
    if (cur) {
      matched.add(cur.id)
      if (normName(cur.name) !== normName(e.name)) {
        // 大幅不一致 → 氏名・在籍状態は書き換えず保留（取り違え防止）。部屋・介護度だけは名簿に合わせる（F51）
        needsReview++
        reviews.push({ id: cur.id, current: cur.name, roster: e.name })
        const patch: Record<string, unknown> = {}
        if (!cur.needs_review) patch.needs_review = true
        if (rosterHas.room && hasText(e.room) && cur.room !== e.room) patch.room = e.room
        if (rosterHas.careLevel && hasText(e.careLevel) && cur.care_level !== e.careLevel) {
          patch.care_level = e.careLevel
        }
        if (Object.keys(patch).length > 0) updates.push({ id: cur.id, patch })
        continue
      }
      const patch: Record<string, unknown> = {}
      if (cur.name !== e.name) {
        patch.name = e.name // 正規化後は同一＝空白幅などの表記ゆれ
        renamed++
      }
      // 値が載っている時だけ書く（欠落・空文字は「変更なし」＝サーバーの値を温存する）
      if (rosterHas.kana && hasText(e.kana) && cur.kana !== e.kana) patch.kana = e.kana
      if (rosterHas.room && hasText(e.room) && cur.room !== e.room) patch.room = e.room
      if (rosterHas.gender && hasText(e.gender) && cur.gender !== e.gender) patch.gender = e.gender
      if (rosterHas.careLevel && hasText(e.careLevel) && cur.care_level !== e.careLevel) {
        patch.care_level = e.careLevel
      }
      // 在籍状態は名簿に従う。名簿が退去者も返すようになったため、
      // 「名簿に載っている＝在籍」ではなく e.active で判断する（2026-08-29）
      const wantActive = e.active !== false
      if (!cur.active && wantActive) {
        patch.active = true // 名簿で在籍に戻った（復活は消失より安全側）
        reactivated++
      } else if (cur.active && !wantActive) {
        patch.active = false // 名簿で退去になった。行は残す＝過去の記録は不変
        retiredByRoster++
      }
      if (Object.keys(patch).length > 0) updates.push({ id: cur.id, patch })
      continue
    }

    // source_id では当たらない → 氏名側で二重照合。既に他エントリが押さえた行・今回の名簿に
    // source_id が載っている行は候補から外す（1行を2人に割り当てない）。
    // 退去済みの行も外す（F49。退去した方と同じ氏名の新しい方を、新しい行として作る）
    const cand = (byName.get(normName(e.name)) ?? []).find(
      (r) => r.active && !matched.has(r.id) && !incomingIds.has(pickText(r.source_id) ?? ''),
    )
    if (cand) {
      matched.add(cand.id)
      needsReview++
      if (!cand.needs_review) updates.push({ id: cand.id, patch: { needs_review: true } })
      continue
    }

    inserts.push({
      source_id: e.id,
      name: e.name,
      kana: e.kana ?? null,
      room: e.room ?? null,
      gender: e.gender ?? null,
      care_level: e.careLevel ?? null,
      // 名簿の在籍状態をそのまま入れる（退去者は active=false で行だけ作る）
      active: e.active !== false,
      needs_review: false,
    })
  }

  // 名簿から消えた在籍行（実行時に退去扱いにする）。
  // ★名簿が退去者も返す合言葉（事務所用）なら通常はここに落ちてこない（名簿側で active=false になる）。
  //   落ちてくるのは「名簿から行ごと消えた」場合と、退去者を返さない現場用の合言葉の名簿の退去者
  const vanished = rows.filter((r) => r.active && !matched.has(r.id)).map((r) => r.id)
  // 計数は「在籍として増えた人数」。退去者の行追加は在籍数を動かさないので数えない
  const added = inserts.filter((r) => r.active === true).length

  return { updates, inserts, vanished, before, added, reactivated, retiredByRoster, renamed, needsReview, reviews }
}

/** 利用者の表を読む（同期の計画の材料）。読み取り上限に達したら中止する */
async function readResidentRows(): Promise<Resident[]> {
  const { data, error } = await supabase
    .from('residents')
    .select('id, source_id, name, kana, room, gender, care_level, active, needs_review, note_alias')
    .limit(MAX_MASTER_ROWS)
  if (error) throw dbError('利用者マスタの現在値を読み取れませんでした')
  const rows = (data ?? []) as Resident[]
  if (rows.length >= MAX_MASTER_ROWS) {
    // 読み取り上限に達した＝スナップショットが不完全の可能性。退去判定を誤爆させないため中止する
    throw new Error(
      '利用者マスタの件数が想定を超えています。安全のため同期を中止しました。開発者に連絡してください（データは変更していません）。',
    )
  }
  return rows
}

/** 計画どおりに利用者スナップショットへ書く（更新 → 追加 → 名簿から消えた在籍行の在籍解除の順） */
async function executeResidentPlan(plan: ResidentSyncPlan): Promise<SyncResult> {
  for (const u of plan.updates) await updateResidentRow(u.id, u.patch)
  if (plan.inserts.length > 0) {
    const { error: insErr } = await supabase.from('residents').insert(plan.inserts)
    if (insErr) throw dbError('利用者マスタに新しい方を追加できませんでした')
  }
  for (const id of plan.vanished) await updateResidentRow(id, { active: false }) // 退去＝非在籍化のみ。行は残す
  const deactivated = plan.retiredByRoster + plan.vanished.length
  return {
    before: plan.before,
    after: plan.before + plan.added + plan.reactivated - deactivated,
    added: plan.added,
    deactivated,
    renamed: plan.renamed,
    needsReview: plan.needsReview,
  }
}

/** 職員の反映の計画（読んだ行と名簿だけから作る。書き込みはまだしていない） */
export interface StaffSyncPlan {
  updates: { id: number; patch: Record<string, unknown> }[]
  inserts: Record<string, unknown>[]
  /** 名簿から行ごと消えた在籍の職員（退職扱いにする id）。手で登録した職員（manual）と、名簿が退職と明示した人は含まない */
  vanished: number[]
  /** 同期前の在籍数 */
  before: number
  /** 「一度に外れる人数」の分母（在籍のうち、手で登録した職員を除いた人数） */
  base: number
  added: number
  reactivated: number
  retiredByRoster: number
}

/**
 * 職員スナップショットへの反映を計画する（氏名が実質キー）。
 * 氏名変更は「新氏名を新規 insert・旧氏名は名簿から消えて active=false」の形で表れるため、
 * renamed は常に 0、needsReview も常に 0（照合キーが1本しかなく保留概念が無い）。
 * manual=true は人が手で登録した職員（シフト名簿に載らない事務職員など）。
 * 名簿に居ないからといって退職扱いにしない（2026-08-29 追加）
 */
export function planStaffSync(rows: Array<Staff & { manual?: boolean }>, names: StaffEntry[]): StaffSyncPlan {
  const before = rows.filter((r) => r.active).length
  const base = rows.filter((r) => r.active && r.manual !== true).length

  const byName = new Map<string, Staff & { manual?: boolean }>()
  for (const r of rows) {
    const key = normName(r.name)
    if (key && !byName.has(key)) byName.set(key, r)
  }

  const matched = new Set<number>()
  const updates: { id: number; patch: Record<string, unknown> }[] = []
  const inserts: Record<string, unknown>[] = []
  let reactivated = 0
  /** 名簿に載ったまま「退職」に変わった人数（名簿から消えた人数とは別経路） */
  let retiredByRoster = 0

  for (const e of names) {
    const cur = byName.get(normName(e.name))
    if (cur) {
      matched.add(cur.id)
      if (!cur.active && e.active) {
        updates.push({ id: cur.id, patch: { active: true } })
        reactivated++
      } else if (cur.active && !e.active) {
        updates.push({ id: cur.id, patch: { active: false } }) // 退職。行は残す＝過去の記入者表示は不変
        retiredByRoster++
      }
      continue
    }
    inserts.push({ name: e.name, active: e.active })
  }

  // 手で登録した職員（事務職員など）はシフト名簿に載らないのが正常なので、
  // 「名簿に居ない」を退職の根拠にしない（2026-08-29）
  const vanished = rows.filter((r) => r.active && !matched.has(r.id) && r.manual !== true).map((r) => r.id)
  // 計数は「在籍として増えた人数」。退職者の行追加は在籍数を動かさない
  const added = inserts.filter((r) => r.active === true).length

  return { updates, inserts, vanished, before, base, added, reactivated, retiredByRoster }
}

/** 職員の表を読む（同期の計画の材料）。読み取り上限に達したら中止する */
async function readStaffRows(): Promise<Array<Staff & { manual?: boolean }>> {
  const { data, error } = await supabase
    .from('staff')
    .select('id, name, active, manual')
    .limit(MAX_MASTER_ROWS)
  if (error) throw dbError('職員マスタの現在値を読み取れませんでした')
  const rows = (data ?? []) as Array<Staff & { manual?: boolean }>
  if (rows.length >= MAX_MASTER_ROWS) {
    throw new Error(
      '職員マスタの件数が想定を超えています。安全のため同期を中止しました。開発者に連絡してください（データは変更していません）。',
    )
  }
  return rows
}

/** 計画どおりに職員スナップショットへ書く（更新 → 追加 → 名簿から消えた職員の退職扱いの順） */
async function executeStaffPlan(plan: StaffSyncPlan): Promise<SyncResult> {
  for (const u of plan.updates) await updateStaffRow(u.id, u.patch)
  if (plan.inserts.length > 0) {
    const { error: insErr } = await supabase.from('staff').insert(plan.inserts)
    if (insErr) throw dbError('職員マスタに新しい職員を追加できませんでした')
  }
  for (const id of plan.vanished) await updateStaffRow(id, { active: false }) // 退職＝非在籍化のみ。過去記録の記入者表示は変わらない
  const deactivated = plan.retiredByRoster + plan.vanished.length
  return {
    before: plan.before,
    after: plan.before + plan.added + plan.reactivated - deactivated,
    added: plan.added,
    deactivated,
    renamed: 0,
    needsReview: 0,
  }
}

/** 増減両方向を master_sync_log に残す（M-024）。記録の失敗で同期結果を失わせない */
async function logMasterSync(source: 'residents' | 'staff', r: SyncResult): Promise<void> {
  const { error } = await supabase.from('master_sync_log').insert({
    source,
    before_count: r.before,
    after_count: r.after,
    added: r.added,
    deactivated: r.deactivated,
    renamed: r.renamed,
  })
  if (error) console.warn('[gasClient] マスタ同期の記録（master_sync_log）に失敗しました')
}

// ───────────────────────── 名簿から一度に外れる人数の歯止め（F43） ─────────────────────────

/** 名簿から一度に外れる人数が、在籍のこの割合以上なら反映を止めて確認を取る（2026-10-10 本人回答: 2割） */
export const MASS_DROP_RATIO = 0.2
/** 名簿から一度に外れる人数が、この人数以上なら反映を止めて確認を取る（2026-10-10 本人回答: 5人） */
export const MASS_DROP_COUNT = 5

/**
 * 名簿から一度に外れる人数が多すぎるか（在籍の2割以上か5人以上）。
 * 名簿のシートが絞り込み・編集の途中で一部の人しか返らないと、残りの全員を一度に在籍解除にしてしまう（F43）。
 * 0件の応答は別の守り（取得できず扱い）が止める
 */
export function isMassDrop(dropped: number, base: number): boolean {
  if (!(dropped > 0)) return false
  return dropped >= MASS_DROP_COUNT || dropped >= base * MASS_DROP_RATIO
}

/**
 * 名簿から一度に外れる人数が多すぎるので、何も書かずに止めた（F43）。
 * residents・staff は名簿から行ごと消えて在籍解除になる人数（名簿が退去・退職と明示した人は数えない）。
 * 確かめた上で続ける時は、この人数を syncMasters({ confirmedDrop: { residents, staff } }) に渡す
 * （確認した人数より増えていれば、また止まる）。message は画面にそのまま出せる
 */
export class MasterDropError extends Error {
  readonly residents: number
  readonly staff: number
  constructor(residents: number, staff: number) {
    const parts = [residents > 0 ? `利用者${residents}人` : '', staff > 0 ? `職員${staff}人` : '']
      .filter((s) => s !== '')
      .join('・')
    super(
      `名簿に載っていない${parts}を、一度に一覧から外す（在籍解除にする）ところでした。名簿のシートが絞り込みや編集の途中だと、一部の人しか返らないことがあります。安全のため、まだ何も変更していません。名簿を確かめてから、もう一度お試しください。`,
    )
    this.name = 'MasterDropError'
    this.residents = residents
    this.staff = staff
  }
}

// ───────────────────────── 公開エントリポイント ─────────────────────────

/** 利用者名簿を取得できなかった時の「次にどうすればよいか」（F45: 原因ごとに分ける。GAS の文言そのものは出さない） */
function rosterFailHint(reason: GasReadFail | 'empty' | null): string {
  switch (reason) {
    case 'auth':
      return '入居者マスタのGASが合言葉の違いで断りました。設定画面の「GAS接続設定」の合言葉を確かめてから'
    case 'postOnly':
      return '入居者マスタのGASへの送信が途中で崩れました（まれに起きる通信の揺れです）。少し待ってから'
    case 'timeout':
    case 'network':
      return '通信できませんでした。電波状態を確かめてから'
    case 'empty':
      return '名簿が0件で返りました。名簿のシートに絞り込みや編集の途中が無いか確かめてから'
    default:
      return '入居者マスタのGASが読み取りに応じませんでした。設定画面の接続先が入居者マスタのURLか確かめてから'
  }
}

/** syncMasters の結果（F51: 氏名の食い違いで保留にした方の名簿の氏名を、画面のメモリにだけ渡す） */
export interface MasterSyncOutcome {
  residents: SyncResult
  staff: SyncResult
  /** 氏名が名簿と食い違って保留（要確認）にした方。localStorage・console には残さないこと */
  reviews: RosterReview[]
}

export interface SyncOptions {
  /**
   * 名簿から一度に外れる人数を人が確かめた（F43）。MasterDropError の residents・staff をそのまま渡す。
   * 実際に外れる人数がこれ以下なら止めずに反映する（増えていればまた止まる）
   */
  confirmedDrop?: { residents: number; staff: number }
}

/**
 * 利用者・職員マスタを GAS から取得して Supabase スナップショットへ反映する。
 *
 * 戻り値: 系列ごとの増減計数と、氏名の食い違いで保留にした方（reviews）。
 *   LS.gasUrl / LS.gasToken 未入力なら 'unconfigured'（エラーではない）。
 * 例外: 取得失敗・接続先URLの形式不正・Supabase 書込失敗は日本語のエラー文で throw する
 *       （contracts.md の戻り値型にエラー枠が無いため。呼び出し側＝設定画面は必ず try/catch し、
 *         e.message をそのまま画面に出せる。文面は「何が起きたか＋次にどうすればよいか」で統一）。
 *       名簿から一度に外れる人数が多すぎる時は、何も書かずに MasterDropError を throw する（F43）。
 *
 * 安全設計:
 *  - 取得できなかった系列は 1 行も触らない（空上書き保護）。0件応答も「取得できず」に倒す。
 *  - 両方の表を読んで反映の計画を立ててから書く。名簿から一度に外れる人数が在籍の2割以上か5人以上なら、
 *    どちらの表にも書かずに止める（opts.confirmedDrop で人が確かめた人数までは通す）。
 *  - 片方だけ取得できた場合は、取得できた側を反映してから失敗側のエラーを throw する
 *    （反映済みの計数は master_sync_log に残る）。
 *  - 冪等: 同じ名簿で何度実行しても差分が無ければ書込は発生しない。途中で失敗しても再実行で追いつく。
 *  - 反映した後は notifyMastersChanged で他の画面へ知らせる（App の職員名簿の取り直し・F47）。
 *  - 自動の同期（起動時＋60分間隔）は autoSyncMasters が受け持つ（F50）。本関数は呼ばれたら常に同期する。
 */
export async function syncMasters(opts: SyncOptions = {}): Promise<MasterSyncOutcome | 'unconfigured'> {
  const cfg = readGasConfig()
  if (cfg === 'unconfigured') return 'unconfigured'
  if (cfg === 'invalid') {
    throw new Error(
      'GASの接続先URLの形式が正しくありません。設定画面で https://script.google.com/macros/s/.../exec の形式のURLを入力し直してください。',
    )
  }

  // 職員名簿は別のGASが持つ。未設定なら利用者名簿と同じ接続先へ問い合わせる（従来の挙動）
  const staffCfg = readStaffGasConfig(cfg)
  if (staffCfg === 'invalid') {
    throw new Error(
      '職員名簿の接続先URLの形式が正しくありません。設定画面で https://script.google.com/macros/s/.../exec の形式のURLを入力し直してください。',
    )
  }
  if (staffCfg === 'unconfigured') {
    throw new Error(
      '職員名簿の接続先が途中までしか入っていません（URLと合言葉の両方が必要です）。設定画面で入力し直すか、両方を空にすると利用者名簿と同じ接続先を使います。',
    )
  }

  // 先に両方を取得する（DBに触れる前に失敗を確定させ、中途半端な反映を減らす）
  const rosterRead = await pullRosterRead(cfg.url, cfg.token)
  const names = await pullStaffNamesOrNull(staffCfg.url, staffCfg.token)
  const roster = rosterRead.ok ? rosterRead.roster : null
  const rosterOk = roster !== null && roster.length > 0 // 0件＝取得できずと同義に扱う
  const staffOk = names !== null && names.length > 0
  const rosterFail: GasReadFail | 'empty' | null = rosterOk ? null : rosterRead.ok ? 'empty' : rosterRead.reason

  const sameEndpoint = staffCfg.url === cfg.url && staffCfg.token === cfg.token
  if (!rosterOk && !staffOk) {
    throw new Error(
      rosterFail === 'auth' || rosterFail === 'postOnly' || rosterFail === 'empty'
        ? `マスタを取得できませんでした。${rosterFailHint(rosterFail)}、もう一度お試しください（職員名簿も取得できませんでした）。安全のため、利用者・職員の一覧は変更していません。`
        : 'マスタを取得できませんでした。通信状態と、設定画面の接続先・合言葉を確認してからもう一度お試しください。安全のため、利用者・職員の一覧は変更していません。',
    )
  }

  // 両方の表を読んで反映の計画を立てる（まだ書かない）。名簿から一度に外れる人数を、書く前に確かめるため（F43）
  const resPlan = rosterOk ? planResidentSync(await readResidentRows(), roster as RosterEntry[]) : null
  const staffPlan = staffOk ? planStaffSync(await readStaffRows(), names as StaffEntry[]) : null
  const resDrop = resPlan?.vanished.length ?? 0
  const staffDrop = staffPlan?.vanished.length ?? 0
  const ok = opts.confirmedDrop
  const resOver = resPlan !== null && isMassDrop(resDrop, resPlan.before) && !(ok && resDrop <= ok.residents)
  const staffOver = staffPlan !== null && isMassDrop(staffDrop, staffPlan.base) && !(ok && staffDrop <= ok.staff)
  if (resOver || staffOver) throw new MasterDropError(resDrop, staffDrop)

  const residents = resPlan ? await executeResidentPlan(resPlan) : null
  if (residents) await logMasterSync('residents', residents)
  const staff = staffPlan ? await executeStaffPlan(staffPlan) : null
  if (staff) await logMasterSync('staff', staff)
  // 反映した分を、開いている画面（App の職員名簿など）へ知らせる（F47）。知らせる先が無くても何も起きない
  if (residents || staff) notifyMastersChanged()

  if (!residents) {
    throw new Error(
      `利用者マスタを取得できませんでした（職員マスタは同期しました）。${rosterFailHint(rosterFail)}、もう一度お試しください。利用者の一覧は変更していません。`,
    )
  }
  if (!staff) {
    // 職員名簿の接続先を別に設定していない場合は、そこが原因である可能性が高いので明示する
    throw new Error(
      sameEndpoint
        ? '職員マスタを取得できませんでした（利用者マスタは同期しました）。職員名簿は利用者名簿とは別のGASが持っていることがあります。設定画面の「職員名簿の接続先」に、シフト連携のURLと合言葉を入れてからもう一度お試しください。職員の一覧は変更していません。'
        : '職員マスタを取得できませんでした（利用者マスタは同期しました）。設定画面の「職員名簿の接続先」と通信状態を確認して、もう一度お試しください。職員の一覧は変更していません。',
    )
  }
  return { residents, staff, reviews: resPlan?.reviews ?? [] }
}

/**
 * 保留（要確認）の方に、名簿の氏名を採用して保留を外す（F51・2026-10-10 本人回答「名簿の氏名を採用する」ボタン）。
 * - 書くのは name と needs_review だけで、1回の update にまとめる（別々に書くと、間で同期が走って保留が立ち直る）
 * - 画面が見ていた氏名（current）のままで、まだ保留中の行だけを書く。他の端末が先に直していれば書かずに 'stale'
 * - note_alias・部屋・在籍状態には触れない（部屋・介護度は同期が名簿に合わせる）
 * rosterName は syncMasters の戻り値 reviews（画面のメモリだけ）から渡す。書けたら他の画面へ名簿の変更を知らせる。
 * 呼ぶ前に確認ダイアログ（いまの氏名と名簿の氏名を並べる）を出すこと
 */
export async function adoptRosterName(id: number, current: string, rosterName: string): Promise<'adopted' | 'stale'> {
  const name = typeof rosterName === 'string' ? rosterName.trim() : ''
  if (!Number.isInteger(id) || id <= 0 || name === '' || typeof current !== 'string') {
    throw new Error(
      '名簿の氏名を採用できませんでした（対象を読み取れません）。もう一度「マスタを同期する」を押してから、やり直してください。',
    )
  }
  const { data, error } = await supabase
    .from('residents')
    .update({ name, needs_review: false, synced_at: new Date().toISOString() })
    .eq('id', id)
    .eq('name', current)
    .eq('needs_review', true)
    .select('id')
  if (error) throw dbError('名簿の氏名を採用できませんでした')
  if (!Array.isArray(data) || data.length === 0) return 'stale'
  notifyMastersChanged()
  return 'adopted'
}

// ───────────────────────── 自動の同期（F50） ─────────────────────────

/** 自動同期の間隔（起動時と60分ごと・2026-10-10 本人回答） */
export const AUTO_SYNC_INTERVAL_MS = 60 * 60_000
/** 自動同期に失敗した後、次に試すまでの待ち（画面の出入りのたびに GAS を叩き続けない） */
export const AUTO_SYNC_RETRY_MS = 10 * 60_000
/** この端末で最後に名簿が新しいと確かめた時刻・最後に自動同期を試みた時刻（epoch ms の数値だけ。氏名などは置かない） */
const AUTO_SYNC_OK_KEY = 'cl_masterSyncOkAt'
const AUTO_SYNC_TRY_KEY = 'cl_masterSyncTryAt'

function readStamp(key: string): number | null {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
    if (v === null || !/^\d+$/.test(v)) return null
    const n = Number(v)
    return Number.isSafeInteger(n) ? n : null
  } catch {
    return null
  }
}

function writeStamp(key: string, t: number): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, String(Math.floor(t)))
  } catch {
    // 書けなくても同期は続ける（次の判定で少し早く試すだけ）
  }
}

/** この端末に名簿の接続設定があるか（自動同期を走らせる端末か）。合言葉の中身は返さない */
export function hasMasterConnection(): boolean {
  return typeof readGasConfig() === 'object'
}

/** 前回から間隔が空いているか（未来の時刻＝時計のずれは「空いている」とみなす） */
function stampFresh(t: number | null, now: number, ms: number): boolean {
  return t !== null && t <= now && now - t < ms
}

export type AutoSyncOutcome = 'unconfigured' | 'fresh' | 'busy' | MasterSyncOutcome

/**
 * 名簿の自動同期（F50・2026-10-10 本人回答: 接続設定のある端末で起動時と60分ごと）。
 * - 接続設定の無い端末（現場の iPhone）は何もしない（'unconfigured'）。合言葉を配る運用にしない
 * - 前回の同期から60分たっていなければ何もしない（'fresh'）。他の端末が同期した記録（master_sync_log）も見る
 *   ＝同期は実質1台に寄る。失敗した後は10分あける
 * - 同じ端末の複数のタブで重ならないよう、navigator.locks があれば1本にまとめる（他のタブが同期中なら 'busy'）
 * - 名簿から一度に外れる人数が多い時は止まって MasterDropError を投げる（自動では続けない。人が設定画面で確かめる）
 * - 失敗は syncMasters と同じ日本語の文で throw する（画面は帯で知らせる）
 */
export async function autoSyncMasters(now: number = Date.now()): Promise<AutoSyncOutcome> {
  if (!hasMasterConnection()) return 'unconfigured'
  if (stampFresh(readStamp(AUTO_SYNC_OK_KEY), now, AUTO_SYNC_INTERVAL_MS)) return 'fresh'
  if (stampFresh(readStamp(AUTO_SYNC_TRY_KEY), now, AUTO_SYNC_RETRY_MS)) return 'fresh'
  // 他の端末が直前に同期していれば、その時刻を控えて待つ（読めなければこの端末の控えだけで決める）
  try {
    const last = await fetchLastMasterSync()
    const r = last.residents !== null ? Date.parse(last.residents) : NaN
    const s = last.staff !== null ? Date.parse(last.staff) : NaN
    if (Number.isFinite(r) && Number.isFinite(s)) {
      const t = Math.min(r, s, now)
      if (now - t < AUTO_SYNC_INTERVAL_MS) {
        writeStamp(AUTO_SYNC_OK_KEY, t)
        return 'fresh'
      }
    }
  } catch {
    // 同期の記録を読めない。この端末の控えだけで決める
  }
  const run = async (): Promise<AutoSyncOutcome> => {
    const t0 = Date.now()
    if (stampFresh(readStamp(AUTO_SYNC_OK_KEY), t0, AUTO_SYNC_INTERVAL_MS)) return 'fresh'
    if (stampFresh(readStamp(AUTO_SYNC_TRY_KEY), t0, AUTO_SYNC_RETRY_MS)) return 'fresh'
    writeStamp(AUTO_SYNC_TRY_KEY, t0)
    const res = await syncMasters()
    if (res === 'unconfigured') return 'unconfigured'
    writeStamp(AUTO_SYNC_OK_KEY, Date.now())
    return res
  }
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManager }).locks : undefined
  if (locks && typeof locks.request === 'function') {
    return (await locks.request('cl_masterSync', { ifAvailable: true }, async (lock) =>
      lock === null ? 'busy' : run(),
    )) as AutoSyncOutcome
  }
  return run()
}
