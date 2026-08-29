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

/** 取得失敗（null）と「0件」を区別したい内部用。syncMasters はこちらを使う */
async function pullRosterOrNull(url: string, token: string): Promise<RosterEntry[] | null> {
  const out = await gasGet<Record<string, unknown>>(url, { action: 'getRoster', token })
  if (!out) return null
  return projectRoster(out)
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
 * 利用者スナップショットへ反映する（source_id + 氏名の二重照合・M-034）。
 * - source_id 一致 かつ 氏名正規化一致 → 差分のある列だけ update（表記ゆれの吸収は renamed 計数）
 * - source_id 一致 かつ 氏名が大幅不一致 → 別人の可能性。上書きせず needs_review=true で保留
 * - source_id 不一致 かつ 同名の既存行あり → ID振り直しの可能性。重複行を作らず needs_review=true で保留
 * - どちらでも当たらない → 新規 insert（upsert は使わない）
 * - 名簿に居ない在籍行 → active=false（物理削除しない。過去記録は不変）
 * - 任意項目（かな・居室・性別・介護度）は「名簿に値が載っている時だけ」更新する。
 *   欠落・空文字は「空にせよ」ではなく「変更なし」とみなし、既存値を温存する（原則4）。
 *   全エントリでその列が欠落している場合はその列を一切触らない（正本が返していないだけ）。
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
  const toInsert: Record<string, unknown>[] = []
  let renamed = 0
  let needsReview = 0
  let reactivated = 0
  /** 名簿に載ったまま「退去」に変わった人数（名簿から消えた人数とは別経路） */
  let retiredByRoster = 0

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
      // 名簿の在籍状態をそのまま入れる（退去者は active=false で行だけ作る）
      active: e.active !== false,
      needs_review: false,
    })
  }

  let added = 0
  if (toInsert.length > 0) {
    const { error: insErr } = await supabase.from('residents').insert(toInsert)
    if (insErr) throw dbError('利用者マスタに新しい方を追加できませんでした')
    // 計数は「在籍として増えた人数」。退去者の行追加は在籍数を動かさないので数えない
    added = toInsert.filter((r) => r.active === true).length
  }

  // 名簿から消えた在籍行を退去扱いにする。
  // ★名簿が退去者も返すようになったので、通常はここに落ちてこない（名簿側で active=false になる）。
  //   落ちてくるのは「名簿から行ごと消えた」場合＝従来どおりの安全網として残す。
  let deactivated = retiredByRoster
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
async function applyStaff(names: StaffEntry[]): Promise<SyncResult> {
  // manual=true は人が手で登録した職員（シフト名簿に載らない事務職員など）。
  // 名簿に居ないからといって退職扱いにしない（2026-08-29 追加）
  const { data, error } = await supabase
    .from('staff')
    .select('id, name, active, manual')
    .limit(MAX_MASTER_ROWS)
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
  /** 名簿に載ったまま「退職」に変わった人数（名簿から消えた人数とは別経路） */
  let retiredByRoster = 0

  for (const e of names) {
    const cur = byName.get(normName(e.name))
    if (cur) {
      matched.add(cur.id)
      if (!cur.active && e.active) {
        await updateStaffRow(cur.id, { active: true })
        reactivated++
      } else if (cur.active && !e.active) {
        await updateStaffRow(cur.id, { active: false }) // 退職。行は残す＝過去の記入者表示は不変
        retiredByRoster++
      }
      continue
    }
    toInsert.push({ name: e.name, active: e.active })
  }

  let added = 0
  if (toInsert.length > 0) {
    const { error: insErr } = await supabase.from('staff').insert(toInsert)
    if (insErr) throw dbError('職員マスタに新しい職員を追加できませんでした')
    // 計数は「在籍として増えた人数」。退職者の行追加は在籍数を動かさない
    added = toInsert.filter((r) => r.active === true).length
  }

  let deactivated = retiredByRoster
  for (const r of rows) {
    if (!r.active || matched.has(r.id)) continue
    // 手で登録した職員（事務職員など）はシフト名簿に載らないのが正常なので、
    // 「名簿に居ない」を退職の根拠にしない（2026-08-29）
    if ((r as Staff & { manual?: boolean }).manual === true) continue
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
  const roster = await pullRosterOrNull(cfg.url, cfg.token)
  const names = await pullStaffNamesOrNull(staffCfg.url, staffCfg.token)
  const rosterOk = roster !== null && roster.length > 0 // 0件＝取得できずと同義に扱う
  const staffOk = names !== null && names.length > 0

  const sameEndpoint = staffCfg.url === cfg.url && staffCfg.token === cfg.token
  if (!rosterOk && !staffOk) {
    throw new Error(
      'マスタを取得できませんでした。通信状態と、設定画面の接続先・合言葉を確認してからもう一度お試しください。安全のため、利用者・職員の一覧は変更していません。',
    )
  }

  const residents = rosterOk ? await applyResidents(roster as RosterEntry[]) : null
  if (residents) await logMasterSync('residents', residents)
  const staff = staffOk ? await applyStaff(names as StaffEntry[]) : null
  if (staff) await logMasterSync('staff', staff)

  if (!residents) {
    throw new Error(
      '利用者マスタを取得できませんでした（職員マスタは同期しました）。設定画面の接続先・合言葉と通信状態を確認して、もう一度お試しください。利用者の一覧は変更していません。',
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
  return { residents, staff }
}
