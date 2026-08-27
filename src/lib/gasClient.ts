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

// ───────────────────────── GAS 通信（読み取りのみ） ─────────────────────────

/**
 * GAS へ GET する（master.gs は doGet でしか名簿を返さないため、合言葉はクエリに載せる）。
 * 通信失敗・!res.ok・JSON 破損・GAS の {error:…} 応答はすべて null。
 * console にはエラー種別だけを出し、応答本文（氏名等）は一切出さない。
 */
async function gasGet<T>(url: string, params: Record<string, string>): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const u = new URL(url)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    const res = await fetch(u.toString(), { method: 'GET', redirect: 'follow', signal: ctrl.signal })
    if (!res.ok) {
      console.warn('[gasClient] GAS からの HTTP 応答が異常です（status:', res.status, '）')
      return null
    }
    const out = (await res.json()) as Record<string, unknown> | unknown[] | null
    if (!out || typeof out !== 'object') return null
    if (!Array.isArray(out) && typeof out.error !== 'undefined') {
      // 認証エラー・action 不一致など。GAS のメッセージ本文は出さない
      console.warn('[gasClient] GAS がエラー応答を返しました（合言葉または action の不一致）')
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
    if (rec.active === false) continue // 退去者は取り込まない（getRosterSafe も返さないが二重に防ぐ）
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
    })
  }
  return out
}

/** 統合GAS の staff 応答（配列 or `{staff:[…]}`）から氏名だけを射影する。労務情報は保持しない */
function projectStaffNames(raw: unknown): string[] | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { staff?: unknown }).staff)
      ? (raw as { staff: unknown[] }).staff
      : null
  if (!list) return null

  const seen = new Set<string>()
  const names: string[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (rec.active === false) continue // 在籍者のみ
    const name = pickText(rec.name)
    if (!name) continue
    const key = normName(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    names.push(name) // 氏名だけを射影（rules/empCode/employment/status 等は取り込まない）
  }
  return names
}

// ───────────────────────── pull（外部公開・読み取り専用） ─────────────────────────

/** 取得失敗（null）と「0件」を区別したい内部用。syncMasters はこちらを使う */
async function pullRosterOrNull(url: string, token: string): Promise<RosterEntry[] | null> {
  const out = await gasGet<Record<string, unknown>>(url, { action: 'getRoster', token })
  if (!out) return null
  return projectRoster(out)
}

/** 取得失敗（null）と「0件」を区別したい内部用。syncMasters はこちらを使う */
async function pullStaffNamesOrNull(url: string, token: string): Promise<string[] | null> {
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
export async function pullStaffNames(url: string, token: string): Promise<string[]> {
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
 * 利用者スナップショットへ反映する（source_id + 氏名の二重照合・M-034）。
 * - source_id 一致 かつ 氏名正規化一致 → 差分のある列だけ update（表記ゆれの吸収は renamed 計数）
 * - source_id 一致 かつ 氏名が大幅不一致 → 別人の可能性。上書きせず needs_review=true で保留
 * - source_id 不一致 かつ 同名の既存行あり → ID振り直しの可能性。重複行を作らず needs_review=true で保留
 * - どちらでも当たらない → 新規 insert（upsert は使わない）
 * - 名簿に居ない在籍行 → active=false（物理削除しない。過去記録は不変）
 * needs_review は立てるだけで自動解除しない（人が設定画面で裁定する保留印のため）。
 */
async function applyResidents(entries: RosterEntry[]): Promise<SyncResult> {
  const { data, error } = await supabase
    .from('residents')
    .select('id, source_id, name, kana, room, gender, care_level, active, needs_review')
    .limit(MAX_MASTER_ROWS)
  if (error) throw dbError('利用者マスタの現在値を読み取れませんでした')
  const rows = (data ?? []) as Resident[]
  if (rows.length >= MAX_MASTER_ROWS) {
    // 読み取り上限に達した＝スナップショットが不完全の可能性。退去判定を誤爆させないため中止する
    throw new Error(
      '利用者マスタの件数が想定を超えています。安全のため同期を中止しました。開発者に連絡してください（データは変更していません）。',
    )
  }

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
  const matched = new Set<number>() // 今回の名簿に対応づいた既存行（退去判定から除外する）
  const toInsert: Record<string, unknown>[] = []
  let renamed = 0
  let needsReview = 0
  let reactivated = 0

  for (const e of entries) {
    const cur = bySource.get(e.id)
    if (cur) {
      matched.add(cur.id)
      if (normName(cur.name) !== normName(e.name)) {
        // 大幅不一致 → 氏名・属性は一切書き換えず保留（取り違え防止）
        needsReview++
        if (!cur.needs_review) await updateResidentRow(cur.id, { needs_review: true })
        continue
      }
      const patch: Record<string, unknown> = {}
      if (cur.name !== e.name) {
        patch.name = e.name // 正規化後は同一＝空白幅などの表記ゆれ
        renamed++
      }
      if ((cur.kana ?? null) !== (e.kana ?? null)) patch.kana = e.kana ?? null
      if ((cur.room ?? null) !== (e.room ?? null)) patch.room = e.room ?? null
      if ((cur.gender ?? null) !== (e.gender ?? null)) patch.gender = e.gender ?? null
      if ((cur.care_level ?? null) !== (e.careLevel ?? null)) patch.care_level = e.careLevel ?? null
      if (!cur.active) {
        patch.active = true // 名簿に戻った＝在籍（復活は消失より安全側）
        reactivated++
      }
      if (Object.keys(patch).length > 0) await updateResidentRow(cur.id, patch)
      continue
    }

    // source_id では当たらない → 氏名側で二重照合。既に他エントリが押さえた行・今回の名簿に
    // source_id が載っている行は候補から外す（1行を2人に割り当てない）
    const cand = (byName.get(normName(e.name)) ?? []).find(
      (r) => !matched.has(r.id) && !incomingIds.has(pickText(r.source_id) ?? ''),
    )
    if (cand) {
      matched.add(cand.id)
      needsReview++
      if (!cand.needs_review) await updateResidentRow(cand.id, { needs_review: true })
      continue
    }

    toInsert.push({
      source_id: e.id,
      name: e.name,
      kana: e.kana ?? null,
      room: e.room ?? null,
      gender: e.gender ?? null,
      care_level: e.careLevel ?? null,
      active: true,
      needs_review: false,
    })
  }

  let added = 0
  if (toInsert.length > 0) {
    const { error: insErr } = await supabase.from('residents').insert(toInsert)
    if (insErr) throw dbError('利用者マスタに新しい方を追加できませんでした')
    added = toInsert.length
  }

  let deactivated = 0
  for (const r of rows) {
    if (!r.active || matched.has(r.id)) continue
    await updateResidentRow(r.id, { active: false }) // 退去＝非在籍化のみ。行は残す
    deactivated++
  }

  return { before, after: before + added + reactivated - deactivated, added, deactivated, renamed, needsReview }
}

/**
 * 職員スナップショットへ反映する（氏名が実質キー）。
 * 氏名変更は「新氏名を新規 insert・旧氏名は名簿から消えて active=false」の形で表れるため、
 * renamed は常に 0、needsReview も常に 0（照合キーが1本しかなく保留概念が無い）。
 */
async function applyStaff(names: string[]): Promise<SyncResult> {
  const { data, error } = await supabase.from('staff').select('id, name, active').limit(MAX_MASTER_ROWS)
  if (error) throw dbError('職員マスタの現在値を読み取れませんでした')
  const rows = (data ?? []) as Staff[]
  if (rows.length >= MAX_MASTER_ROWS) {
    throw new Error(
      '職員マスタの件数が想定を超えています。安全のため同期を中止しました。開発者に連絡してください（データは変更していません）。',
    )
  }

  const before = rows.filter((r) => r.active).length

  const byName = new Map<string, Staff>()
  for (const r of rows) {
    const key = normName(r.name)
    if (key && !byName.has(key)) byName.set(key, r)
  }

  const matched = new Set<number>()
  const toInsert: Record<string, unknown>[] = []
  let reactivated = 0

  for (const name of names) {
    const cur = byName.get(normName(name))
    if (cur) {
      matched.add(cur.id)
      if (!cur.active) {
        await updateStaffRow(cur.id, { active: true })
        reactivated++
      }
      continue
    }
    toInsert.push({ name, active: true })
  }

  let added = 0
  if (toInsert.length > 0) {
    const { error: insErr } = await supabase.from('staff').insert(toInsert)
    if (insErr) throw dbError('職員マスタに新しい職員を追加できませんでした')
    added = toInsert.length
  }

  let deactivated = 0
  for (const r of rows) {
    if (!r.active || matched.has(r.id)) continue
    await updateStaffRow(r.id, { active: false }) // 退職＝非在籍化のみ。過去記録の記入者表示は変わらない
    deactivated++
  }

  return {
    before,
    after: before + added + reactivated - deactivated,
    added,
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

// ───────────────────────── 公開エントリポイント ─────────────────────────

/**
 * 利用者・職員マスタを GAS から取得して Supabase スナップショットへ反映する。
 *
 * 戻り値: 系列ごとの増減計数。LS.gasUrl / LS.gasToken 未入力なら 'unconfigured'（エラーではない）。
 * 例外: 取得失敗・接続先URLの形式不正・Supabase 書込失敗は日本語のエラー文で throw する
 *       （contracts.md の戻り値型にエラー枠が無いため。呼び出し側＝設定画面は必ず try/catch し、
 *         e.message をそのまま画面に出せる。文面は「何が起きたか＋次にどうすればよいか」で統一）。
 *
 * 安全設計:
 *  - 取得できなかった系列は 1 行も触らない（空上書き保護）。0件応答も「取得できず」に倒す。
 *  - 片方だけ取得できた場合は、取得できた側を反映してから失敗側のエラーを throw する
 *    （反映済みの計数は master_sync_log に残る）。
 *  - 冪等: 同じ名簿で何度実行しても差分が無ければ書込は発生しない。途中で失敗しても再実行で追いつく。
 *  - TTL（起動時＋60分間隔）の判定は呼び出し側の責務。本関数は呼ばれたら常に同期する。
 */
export async function syncMasters(): Promise<{ residents: SyncResult; staff: SyncResult } | 'unconfigured'> {
  const cfg = readGasConfig()
  if (cfg === 'unconfigured') return 'unconfigured'
  if (cfg === 'invalid') {
    throw new Error(
      'GASの接続先URLの形式が正しくありません。設定画面で https://script.google.com/macros/s/.../exec の形式のURLを入力し直してください。',
    )
  }

  // 先に両方を取得する（DBに触れる前に失敗を確定させ、中途半端な反映を減らす）
  const roster = await pullRosterOrNull(cfg.url, cfg.token)
  const names = await pullStaffNamesOrNull(cfg.url, cfg.token)
  const rosterOk = roster !== null && roster.length > 0 // 0件＝取得できずと同義に扱う
  const staffOk = names !== null && names.length > 0

  if (!rosterOk && !staffOk) {
    throw new Error(
      'マスタを取得できませんでした。通信状態と、設定画面の接続先・合言葉を確認してからもう一度お試しください。安全のため、利用者・職員の一覧は変更していません。',
    )
  }

  const residents = rosterOk ? await applyResidents(roster as RosterEntry[]) : null
  if (residents) await logMasterSync('residents', residents)
  const staff = staffOk ? await applyStaff(names as string[]) : null
  if (staff) await logMasterSync('staff', staff)

  if (!residents) {
    throw new Error(
      '利用者マスタを取得できませんでした（職員マスタは同期しました）。設定画面の接続先・合言葉と通信状態を確認して、もう一度お試しください。利用者の一覧は変更していません。',
    )
  }
  if (!staff) {
    throw new Error(
      '職員マスタを取得できませんでした（利用者マスタは同期しました）。設定画面の接続先・合言葉と通信状態を確認して、もう一度お試しください。職員の一覧は変更していません。',
    )
  }
  return { residents, staff }
}
