// デイ（せせらぎ）段階3c: 個別機能訓練計画書アプリ（training-plan.html／gas/training-plan-api.gs）の索引
// training_plan:index から、期限と状態だけを読むクライアント（2026-10-23 追加・代表承認・段階3の計画 4章）。
// 拡張子付きで import する（tests/training-plan-client.test.mjs から node で直接読めるようにするため）。
//
// ── 守ること（試験で機械確認される）──
//  1. 接続先と合言葉は、計画書アプリが同じ端末（同じオリジン）の localStorage に置いた `tp_cfg`（{url, token}）を**読むだけ**。
//     書かない・消さない。現場の端末に合言葉を置く経路を作らない（計画書アプリを使う事務所の PC にだけある）。
//  2. 計画書の GAS へ送るのは読み取りの get だけ（POST 本文・text/plain。合言葉を URL に載せない）。put・ai・ping の経路を作らない。
//     宛先は GAS の形（script.google.com/macros/s/…/exec）だけ。それ以外へは合言葉を送らない。
//  3. 索引の行から写すのは 利用者番号・最新の計画の作成日・次の期限・止めた指定（理由と日）・計画書の状態 だけ。設定から写すのは
//     期限の規則と間近の日数だけ。氏名（nameNorm）・計画の id・数・職員の一覧（settings.staff）などは、そろえる時に捨てる。
//     読んだ索引は関数の中のメモリにだけ置き、localStorage・IndexedDB・console に残さない。
//  4. 値は送る前にそろえる（1行の崩れた値で写し全体が止まらないように＝計画 3.3・積み残し 44）:
//     実在しない日付・空は null、知らない状態は null、止めた指定は理由が3つのどれかで日付が正しい時だけ、
//     規則は3つのほかは暦の月、間近の日数は 0〜365 の整数（ほかは 28）。
//  5. 実名・合言葉・接続先の具体値をコードに書かない。
//  役割（事務所・管理者だけ）の確かめは、このファイルを呼ぶ前に trainingDueSync.ts が行う（読む前に止める）。

import { isYmd, normalizeDueRule, normalizeWarnDays } from './trainingDue.ts'
import type { DueRule } from './trainingDue.ts'

/** 計画書アプリが接続設定を置く localStorage のキー（training-plan.html の CFG と同じ） */
export const TP_LS_CFG_KEY = 'tp_cfg'
/** 索引のキー（training-plan.html の IDX_KEY と同じ） */
export const TP_INDEX_KEY = 'training_plan:index'

/** GAS エンドポイントの許容形式（excretionClient.ts・gasClient.ts と同じ基準。これ以外の宛先へ合言葉を送らない） */
const GAS_ENDPOINT_RE = /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/

/** 待ちの上限（索引は数十人分で小さい。排便記録の読み口と同じ30秒にそろえる） */
export const TRAINING_PLAN_TIMEOUT_MS = 30000

/** 計画書の状態（training-plan.html の STATUSES と同じ） */
const PLAN_STATUSES: readonly string[] = ['none', 'draft_ai', 'reviewed', 'printed', 'signed']
/** 通知を止める理由（training-plan.html の STOP_REASONS と同じ） */
const STOP_REASONS: readonly string[] = ['discharge', 'stopped', 'notNeeded']
/** 利用者番号の形（training-plan.html の ID_RE と同じ。ほかの形のキーは写さない） */
const MASTER_ID_RE = /^[0-9A-Za-z_-]{1,32}$/

/** 写しの1行（0046 の写しの関数 daycare_training_due_sync の p_rows の1件と同じ形） */
export interface TrainingDueCopyInput {
  master_id: string
  latest_plan_date: string | null
  next_due: string | null
  stop_reason: string | null
  stop_from: string | null
  plan_status: string | null
}

/** 写しの設定（p_settings と同じ形） */
export interface TrainingDueSettingsInput {
  due_rule: DueRule
  warn_days: number
}

export type TrainingPlanFailReason = 'unconfigured' | 'url' | 'timeout' | 'network' | 'http' | 'auth' | 'refused' | 'format' | 'noindex'

// ───────────────────────── 接続設定（読むだけ） ─────────────────────────

/**
 * 計画書アプリの接続先と合言葉を読む。どちらかが無い・読めない時は null（この端末は計画書アプリを使っていない）。
 * 形式が GAS でなければ 'invalid'（合言葉を知らない宛先へ送らない）。書かない・消さない。
 */
export function readTrainingPlanConfig(): { url: string; token: string } | 'invalid' | null {
  let raw: string | null = null
  try {
    if (typeof localStorage === 'undefined') return null
    raw = localStorage.getItem(TP_LS_CFG_KEY)
  } catch {
    return null // localStorage が使えない環境＝未設定扱い（例外を外へ出さない）
  }
  if (raw === null || raw === '') return null
  let url = ''
  let token = ''
  try {
    const o: unknown = JSON.parse(raw)
    if (o === null || typeof o !== 'object') return null
    const r = o as { url?: unknown; token?: unknown }
    url = typeof r.url === 'string' ? r.url.trim() : ''
    token = typeof r.token === 'string' ? r.token.trim() : ''
  } catch {
    return null
  }
  if (url === '' || token === '') return null
  if (!GAS_ENDPOINT_RE.test(url)) return 'invalid'
  return { url, token }
}

// ───────────────────────── 索引のそろえ方（純関数） ─────────────────────────

const ymdOrNull = (v: unknown): string | null => (isYmd(v) ? v : null)

/**
 * 索引（training_plan:index の data）から、写す分だけを取り出す。氏名・計画の id・数・職員の一覧などは捨てる。
 * 行は利用者番号（rows のキー）の順。番号の形が違うキー・行がオブジェクトでないものは写さない
 */
export function normalizeTrainingPlanIndex(data: unknown): { rows: TrainingDueCopyInput[]; settings: TrainingDueSettingsInput } {
  const d = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
  const rowsObj = d.rows !== null && typeof d.rows === 'object' && !Array.isArray(d.rows) ? (d.rows as Record<string, unknown>) : {}
  const rows: TrainingDueCopyInput[] = []
  for (const id of Object.keys(rowsObj).sort()) {
    if (!MASTER_ID_RE.test(id)) continue
    const r = rowsObj[id]
    if (r === null || typeof r !== 'object' || Array.isArray(r)) continue
    const row = r as Record<string, unknown>
    const stop = row.stop !== null && typeof row.stop === 'object' && !Array.isArray(row.stop) ? (row.stop as Record<string, unknown>) : null
    const stopOk = stop !== null && typeof stop.reason === 'string' && STOP_REASONS.includes(stop.reason) && isYmd(stop.from)
    rows.push({
      master_id: id,
      latest_plan_date: ymdOrNull(row.latestPlanDate),
      next_due: ymdOrNull(row.nextDue),
      stop_reason: stopOk ? (stop.reason as string) : null,
      stop_from: stopOk ? (stop.from as string) : null,
      plan_status: typeof row.status === 'string' && PLAN_STATUSES.includes(row.status) ? row.status : null,
    })
  }
  const s = d.settings !== null && typeof d.settings === 'object' && !Array.isArray(d.settings) ? (d.settings as Record<string, unknown>) : {}
  return { rows, settings: { due_rule: normalizeDueRule(s.dueRule), warn_days: normalizeWarnDays(s.warnDays) } }
}

// ───────────────────────── 取得（読み取りのみ） ─────────────────────────

export type TrainingPlanIndexResult =
  | { ok: true; rows: TrainingDueCopyInput[]; settings: TrainingDueSettingsInput }
  | { ok: false; reason: TrainingPlanFailReason }

/**
 * 計画書の GAS から索引を1回読み、写す分だけにそろえて返す（失敗は例外にせず { ok:false, reason }）。
 * 索引のファイルが無い応答（{ok:true, rev:0, data:null}）は 'noindex'（写しには書かない＝「計画なし」に倒さない）。
 * 応答の本体はこの関数の中でだけ持ち、そろえた後は捨てる
 */
export async function fetchTrainingPlanIndex(): Promise<TrainingPlanIndexResult> {
  const cfg = readTrainingPlanConfig()
  if (cfg === null) return { ok: false, reason: 'unconfigured' }
  if (cfg === 'invalid') return { ok: false, reason: 'url' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TRAINING_PLAN_TIMEOUT_MS)
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      // 合言葉は本文だけに載せる。読み取りの get だけ
      body: JSON.stringify({ action: 'get', key: TP_INDEX_KEY, token: cfg.token }),
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
    if (body === null || typeof body !== 'object') return { ok: false, reason: 'format' }
    const b = body as { ok?: unknown; error?: unknown; data?: unknown }
    if (b.ok !== true) return { ok: false, reason: b.error === 'unauthorized' ? 'auth' : 'refused' }
    if (b.data === null || b.data === undefined) return { ok: false, reason: 'noindex' }
    if (typeof b.data !== 'object' || Array.isArray(b.data)) return { ok: false, reason: 'format' }
    return { ok: true, ...normalizeTrainingPlanIndex(b.data) }
  } catch (e) {
    const aborted = e !== null && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError'
    return { ok: false, reason: aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/** 失敗の理由を画面の文にする（応答の中身・接続先は出さない） */
export function trainingPlanFailText(reason: TrainingPlanFailReason): string {
  switch (reason) {
    case 'unconfigured':
      return 'この端末には計画書アプリの接続設定がありません（計画書アプリを使っている事務所の PC で写してください）。'
    case 'url':
      return '計画書アプリの接続先の形が違います。計画書アプリの設定を確かめてください。'
    case 'timeout':
      return '計画書アプリから応答がありませんでした。時間をおいて、もう一度押してください。'
    case 'network':
      return '計画書アプリにつながりませんでした。通信状態を確かめて、もう一度押してください。'
    case 'auth':
      return '計画書アプリに断られました（合言葉が違う可能性があります）。計画書アプリの設定を確かめてください。'
    case 'noindex':
      return '計画書アプリの一覧（索引）がまだありません。計画書アプリで一覧を作ってから、もう一度押してください。'
    case 'http':
    case 'refused':
    case 'format':
      return '計画書アプリの一覧を読めませんでした。時間をおいて、もう一度押してください。'
  }
}

// ───────────────────────── 写しの結果の文（純関数） ─────────────────────────

/** 写しの結果（db.ts の syncTrainingDue の戻り値と同じ形） */
export type TrainingDueSyncResult =
  | { ok: true; written: number; unmatched: number; cancelled: number }
  | { ok: false; reason: 'empty' | 'nomatch' | 'too_many'; existing: number; incoming: number | null; cancel: number | null }

/**
 * 写しの結果を、事務所が次に何をすればよいか分かる文にする（計画 4章・止めた理由を平易に）。
 * 止めた時は「今の写しはそのまま」を必ず添える（何も書いていないことを伝える）
 */
export function trainingDueSyncText(r: TrainingDueSyncResult): { tone: 'info' | 'warn'; text: string } {
  if (r.ok) {
    const parts = [`計画書の期限を写しました（${r.written}人）。`]
    if (r.unmatched > 0)
      parts.push(
        `計画書アプリの利用者番号のうち ${r.unmatched}件は、care-log の利用者と結べませんでした（利用者番号の形が違うか、care-log の名簿にまだいない方の可能性があります）。`,
      )
    if (r.cancelled > 0) parts.push(`計画書アプリの一覧に無くなった ${r.cancelled}人を、写しから外しました。`)
    return { tone: r.unmatched > 0 ? 'warn' : 'info', text: parts.join('') }
  }
  if (r.reason === 'empty')
    return { tone: 'warn', text: `計画書アプリの一覧が空だったため、写しませんでした。今の写し（${r.existing}人）はそのままです。計画書アプリの一覧を確かめてください。` }
  if (r.reason === 'nomatch')
    return {
      tone: 'warn',
      text: `計画書アプリの利用者番号が、care-log の利用者と1人も結べなかったため、写しませんでした（接続先の取り違えか、利用者番号の形の違いの可能性があります）。今の写し（${r.existing}人）はそのままです。`,
    }
  return {
    tone: 'warn',
    text: `一覧から外れる方が多すぎる（今の写し ${r.existing}人のうち ${r.cancel ?? 0}人）ため、写しませんでした。計画書アプリの一覧を確かめてください。今の写しはそのままです。`,
  }
}
