// 設定画面（ルート /settings・5タブの5番目）。
//
// 正本: docs/design/qa-verification.md [low/ui]「設定タブに接続設定・同期状態・保留裁定の3画面を配置」／
//       docs/design/db-design.md §6（マスタ連携）・§7（import_days で『記録なし』と『未取込』を区別）／
//       docs/design/ui-design.md §9（cl_mode = light/dark/auto の復元）・§0.5（並走期間の封鎖は入力画面のみ）／
//       docs/design/contracts.md（db.ts API・共通規律）。
//
// 本画面の構成（上から）:
//   ①GAS接続設定（cl_gasUrl / cl_gasToken の手入力）②マスタ同期の実行と増減計数
//   ③要確認（needs_review）の一覧 ④取込状態（import_days の直近10日）
//   ⑤未送信データ（送信キュー）⑥表示モード ⑦ログアウト
//
// 規律:
// - supabase クライアントのテーブル参照・RPC を直呼びしない（データ取得は db.ts の関数のみ）。
//   マスタ同期は gasClient.syncMasters（contracts.md が認めた唯一の例外モジュール）を動的 import で呼ぶ。
//   ログアウトは auth のみを使う（from/rpc は使わない）。どちらも static import しないのは、
//   src/lib/supabase.ts が module scope で createClient する＝接続未設定だと読み込んだ瞬間に例外になるため。
// - 合言葉（トークン）は画面に平文表示しない。保存済みかどうかだけを示す。
// - 実名・記録本文・トークンを console / コード / placeholder に書かない（表示は実行時の props/state のみ）。
// - タップ要素は min-h-tap（44px）＋隣接 gap-gap（8px）。色だけで意味を伝えない（記号・文字を併記）。
// - ローディング／エラー／空の3状態を各セクションに実装。エラー文は「何が起きたか＋次にどうすればよいか」。
// - 破壊的操作（接続設定の消去・ログアウト）は確認ダイアログを挟み、枠線ボタンにする。

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { fetchResidents, fetchTimelineChunk, flushQueue, isQueueBroken, queueSubscribe } from '../lib/db'
import { LS } from '../lib/types'
import type { ImportDay, Resident } from '../lib/types'
import type { SyncResult } from '../lib/gasClient'
import { addDays, fmtDayLabel, todayIso } from '../lib/format'
import {
  Chip,
  ConfirmDialog,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  SectionCard,
  SegmentPicker,
  useToast,
} from '../components/ui'

/** GAS エンドポイントの許容形式（gasClient.ts と同一基準。ここでの検証は早期の入力ミス検出用） */
const GAS_ENDPOINT_RE = /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/

/** 取込状態を確認する日数（タイムラインのチャンク単位＝10日に合わせる） */
const IMPORT_DAYS_WINDOW = 10

const MSG = {
  lsWrite:
    'この端末には設定を保存できませんでした（ブラウザのプライベートモードなどで保存が制限されています）。ブラウザの設定を確認するか、別の端末でお試しください。',
  urlFormat:
    '接続先URLの形式が正しくありません。https://script.google.com/macros/s/（英数字）/exec の形式で入力してください。',
  unconfigured:
    '接続先URLと合言葉が未設定です。上の「GAS接続設定」を入力して保存してから、もう一度お試しください。',
  syncFailed:
    'マスタを同期できませんでした。通信状態と接続設定を確認して、もう一度お試しください。利用者・職員の一覧は変更していません。',
  residentsFailed:
    '利用者の一覧を読み込めませんでした（通信エラー）。電波状態を確認して、再試行してください。',
  importFailed:
    '取込状態を読み込めませんでした（通信エラー）。電波状態を確認して、再試行してください。',
  logoutFailed:
    'ログアウトできませんでした（通信エラー）。電波状態を確認して、もう一度お試しください。記録は消えていません。',
} as const

// ── localStorage（UI状態と接続設定のみ。氏名・記録本文は書かない）────────────

function lsGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return '' // 参照できない環境では「未設定」として扱う（起動不能にしない）
  }
}

/** 保存できたら true。false なら呼び出し側が理由文を出す（黙って失敗させない） */
function lsSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function lsRemove(key: string): boolean {
  try {
    localStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}

// ── 表示モード（ui-design.md §9: cl_mode は既知値のホワイトリスト照合）─────────

const MODES = ['light', 'dark', 'auto'] as const
type Mode = (typeof MODES)[number]

const MODE_OPTIONS = [
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
  { value: 'auto', label: 'OS設定' },
]

function readMode(): Mode {
  const raw = lsGet(LS.mode)
  return (MODES as readonly string[]).includes(raw) ? (raw as Mode) : 'auto' // 不正値は既定へ
}

/** data-mode 属性の付替え。auto（＝未指定）は属性を外して OS 設定に追従させる */
function applyMode(mode: Mode): void {
  const el = document.documentElement
  if (mode === 'light' || mode === 'dark') el.setAttribute('data-mode', mode)
  else el.removeAttribute('data-mode')
}

// ── 取込状態（import_days）の日別集計 ────────────────────────────────────────

interface DayImport {
  day: string
  sources: string[]
  srcRows: number
  inserted: number
  updated: number
  skipped: number
  nativeSkip: number
  unmatched: number
}

/** 同じ日に複数の取込元（events / measures 等）がある前提で、日単位に足し合わせる */
function groupImportDays(rows: ImportDay[]): Map<string, DayImport> {
  const map = new Map<string, DayImport>()
  for (const r of rows) {
    const cur = map.get(r.day) ?? {
      day: r.day,
      sources: [],
      srcRows: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      nativeSkip: 0,
      unmatched: 0,
    }
    if (r.source !== '' && !cur.sources.includes(r.source)) cur.sources.push(r.source)
    cur.srcRows += r.src_rows
    cur.inserted += r.inserted
    cur.updated += r.updated
    cur.skipped += r.skipped
    cur.nativeSkip += r.native_skip
    cur.unmatched += r.unmatched
    map.set(r.day, cur)
  }
  return map
}

// ── 同期結果の表示 ───────────────────────────────────────────────────────────

const SYNC_FIELDS: { key: keyof SyncResult; label: string }[] = [
  { key: 'before', label: '同期前' },
  { key: 'after', label: '同期後' },
  { key: 'added', label: '追加' },
  { key: 'deactivated', label: '在籍解除' },
  { key: 'renamed', label: '氏名更新' },
  { key: 'needsReview', label: '要確認' },
]

function SyncResultBlock({ title, result }: { title: string; result: SyncResult }) {
  return (
    <div className="rounded-md border border-border bg-surface2 p-3">
      <h4 className="text-base font-bold text-ink">{title}</h4>
      <dl className="mt-2 grid grid-cols-3 gap-2">
        {SYNC_FIELDS.map((f) => (
          <div key={f.key}>
            <dt className="text-sm text-ink2">{f.label}</dt>
            <dd className="tabular text-base font-bold text-ink">{result[f.key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

// ── 本体 ─────────────────────────────────────────────────────────────────────

type ConfirmKind = 'clearUrl' | 'clearToken' | 'logout'

export function SettingsPage() {
  const { toast, show } = useToast()

  // 接続設定（トークンは state にも保持したまま画面へ出さない＝入力欄は常に空から始める）
  const [urlInput, setUrlInput] = useState(() => lsGet(LS.gasUrl))
  const [tokenInput, setTokenInput] = useState('')
  const [tokenSaved, setTokenSaved] = useState(() => lsGet(LS.gasToken) !== '')
  const [connError, setConnError] = useState<string | null>(null)

  // マスタ同期
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ residents: SyncResult; staff: SyncResult } | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)

  // 要確認（needs_review）
  const [residents, setResidents] = useState<Resident[] | null>(null)
  const [residentsError, setResidentsError] = useState<string | null>(null)
  const [residentsReload, setResidentsReload] = useState(0)
  const [reviewOpen, setReviewOpen] = useState(false) // 覗き見配慮: 氏名一覧は明示操作で開く

  // 取込状態（import_days）
  const [today] = useState(() => todayIso())
  const [importRows, setImportRows] = useState<ImportDay[] | null>(null)
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  // 未送信データ（送信キュー）
  const [pending, setPending] = useState(0)
  const [flushing, setFlushing] = useState(false)

  // 表示モード
  const [mode, setMode] = useState<Mode>(() => readMode())

  // ログアウト
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  const [confirmKind, setConfirmKind] = useState<ConfirmKind | null>(null)

  // 未送信件数（登録直後に現在値が1回流れてくる契約）
  useEffect(() => queueSubscribe((n) => setPending(typeof n === 'number' && n > 0 ? n : 0)), [])

  // 利用者スナップショット（要確認の抽出に使う。33名規模＝軽い読取なので画面表示時に取得する）
  useEffect(() => {
    let alive = true
    setResidentsError(null)
    setResidents(null)
    fetchResidents()
      .then((rs) => {
        if (alive) setResidents(rs)
      })
      .catch(() => {
        if (alive) setResidentsError(MSG.residentsFailed)
      })
    return () => {
      alive = false
    }
  }, [residentsReload])

  const reviewList = useMemo(
    () => (residents ?? []).filter((r) => r.needs_review),
    [residents],
  )

  const days = useMemo(() => {
    const out: string[] = []
    for (let i = 0; i < IMPORT_DAYS_WINDOW; i++) out.push(addDays(today, -i))
    return out
  }, [today])

  const importByDay = useMemo(
    () => (importRows === null ? null : groupImportDays(importRows)),
    [importRows],
  )

  // 取込状態は明示操作で読み込む（直近10日のチャンク取得＝記録本文も含む通信のため、
  // 設定画面を開くたびに自動で流さない）
  const loadImportDays = useCallback(() => {
    setImportLoading(true)
    setImportError(null)
    fetchTimelineChunk(addDays(today, -(IMPORT_DAYS_WINDOW - 1)), today, null)
      .then((chunk) => setImportRows(chunk.importDays))
      .catch(() => setImportError(MSG.importFailed))
      .finally(() => setImportLoading(false))
  }, [today])

  // ── 接続設定 ───────────────────────────────────────────────────────────────

  function saveConnection(clearUrl: boolean) {
    setConnError(null)
    const url = urlInput.trim()
    const token = tokenInput.trim()
    let ok = true

    if (clearUrl) {
      ok = lsRemove(LS.gasUrl) && ok
    } else if (url !== '') {
      ok = lsSet(LS.gasUrl, url) && ok
    }
    // 合言葉は「入力があった時だけ」書く（空欄での保存で既存の値を消さない＝空上書き保護）
    if (token !== '') {
      ok = lsSet(LS.gasToken, token) && ok
      if (ok) setTokenSaved(true)
    }

    if (!ok) {
      setConnError(MSG.lsWrite)
      return
    }
    setTokenInput('')
    if (clearUrl) setUrlInput('')
    show(clearUrl ? '接続先URLを消去しました。' : '接続設定を保存しました。')
  }

  function handleConnSubmit(ev: FormEvent) {
    ev.preventDefault()
    setConnError(null)
    const url = urlInput.trim()
    if (url !== '' && !GAS_ENDPOINT_RE.test(url)) {
      setConnError(MSG.urlFormat)
      return
    }
    // 保存済みのURLを空欄で上書きしようとした時だけ確認を挟む（マスタ同期が止まるため）
    if (url === '' && lsGet(LS.gasUrl) !== '') {
      setConfirmKind('clearUrl')
      return
    }
    saveConnection(false)
  }

  function clearToken() {
    if (!lsRemove(LS.gasToken)) {
      setConnError(MSG.lsWrite)
      return
    }
    setTokenSaved(false)
    setTokenInput('')
    show('合言葉を消去しました。')
  }

  // ── マスタ同期 ─────────────────────────────────────────────────────────────

  async function handleSync() {
    if (syncing) return
    setSyncing(true)
    setSyncError(null)
    setSyncResult(null)
    try {
      // 動的 import: 接続未設定でもこの画面のモジュール評価が通るようにする
      const { syncMasters } = await import('../lib/gasClient')
      const res = await syncMasters()
      if (res === 'unconfigured') {
        setSyncError(MSG.unconfigured)
      } else {
        setSyncResult(res)
        setResidentsReload((n) => n + 1) // 要確認の一覧を取り直す
        show('マスタを同期しました。')
      }
    } catch (e) {
      // gasClient は画面にそのまま出せる日本語メッセージで throw する契約。
      // 想定外の例外（メッセージ無し）は共通文へ倒す。応答本文は console に出さない
      const msg = e instanceof Error && e.message !== '' ? e.message : MSG.syncFailed
      setSyncError(msg)
    } finally {
      setSyncing(false)
    }
  }

  // ── 未送信データ ───────────────────────────────────────────────────────────

  async function handleFlush() {
    if (flushing) return
    setFlushing(true)
    try {
      // 明示指示なので、直前の失敗で待ち時間が残っていても無視して送る（force）
      await flushQueue(true)
    } catch {
      // 送れなかった分はキューに残る（db.ts が保全する）。件数表示で結果を確認してもらう
    } finally {
      setFlushing(false)
    }
    show('再送を試みました。残った件数を確認してください。')
  }

  // ── 表示モード ─────────────────────────────────────────────────────────────

  function handleModeChange(value: string) {
    if (!(MODES as readonly string[]).includes(value)) return
    const next = value as Mode
    setMode(next)
    applyMode(next) // 保存できない端末でも、この画面を開いている間は切替が効く
    if (!lsSet(LS.mode, next)) show(MSG.lsWrite)
  }

  // ── ログアウト ─────────────────────────────────────────────────────────────

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    setLogoutError(null)
    try {
      const { supabase } = await import('../lib/supabase')
      const { error } = await supabase.auth.signOut()
      if (error) setLogoutError(MSG.logoutFailed)
      // 成功時は App.tsx の認証ゲートがログイン画面へ切り替える
    } catch {
      setLogoutError(MSG.logoutFailed)
    } finally {
      setLoggingOut(false)
    }
  }

  // ── 確認ダイアログ（消去・ログアウトの1タップ実行を作らない）────────────────

  const confirmProps = useMemo(() => {
    if (confirmKind === 'clearUrl') {
      return {
        title: '接続先URLを消去しますか',
        body: '消去するとマスタ同期ができなくなります。利用者・職員の一覧は消えません。',
        confirmLabel: '消去する',
      }
    }
    if (confirmKind === 'clearToken') {
      return {
        title: '合言葉を消去しますか',
        body: '消去するとマスタ同期ができなくなります。もう一度同期するには合言葉を入力し直してください。',
        confirmLabel: '消去する',
      }
    }
    return {
      title: 'ログアウトしますか',
      body:
        pending > 0
          ? `未送信の記録が ${pending}件 あります。ログアウトしても消えませんが、再びログインするまで送信できません。`
          : 'ログイン画面に戻ります。記録は消えません。',
      confirmLabel: 'ログアウトする',
    }
  }, [confirmKind, pending])

  function runConfirm() {
    const kind = confirmKind
    setConfirmKind(null)
    if (kind === 'clearUrl') saveConnection(true)
    else if (kind === 'clearToken') clearToken()
    else if (kind === 'logout') void handleLogout()
  }

  const inputClass =
    'min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink disabled:bg-surface2 disabled:text-ink3'
  const labelClass = 'block text-sm text-ink2'
  const queueBroken = isQueueBroken()

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      {/* ① GAS接続設定 */}
      <SectionCard title="GAS接続設定">
        <p className="text-base text-ink2">
          利用者・職員の名簿を読み取るための接続先です。読み取りのみで、既存のスプレッドシートには書き込みません。
        </p>
        <form onSubmit={handleConnSubmit} noValidate className="mt-3 space-y-4">
          <div>
            <label htmlFor="cl-gas-url" className={labelClass}>
              接続先URL
            </label>
            <input
              id="cl-gas-url"
              type="url"
              inputMode="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://script.google.com/macros/s/.../exec"
              aria-describedby="cl-gas-url-hint"
              className={`mt-1 ${inputClass}`}
            />
            <p id="cl-gas-url-hint" className="mt-1 text-sm text-ink2">
              管理者から渡されたURLを貼り付けてください。
            </p>
          </div>

          <div>
            <label htmlFor="cl-gas-token" className={labelClass}>
              合言葉
            </label>
            <p className="mt-1 text-base text-ink">
              {tokenSaved ? (
                <>
                  <span aria-hidden="true">✓ </span>
                  保存済み（安全のため画面には表示しません）
                </>
              ) : (
                <>
                  <span aria-hidden="true">— </span>
                  未設定
                </>
              )}
            </p>
            <input
              id="cl-gas-token"
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={tokenSaved ? '変更する場合だけ入力' : '合言葉を入力'}
              aria-describedby="cl-gas-token-hint"
              className={`mt-1 ${inputClass}`}
            />
            <p id="cl-gas-token-hint" className="mt-1 text-sm text-ink2">
              入力せずに保存した場合、保存済みの合言葉はそのまま残ります。
            </p>
          </div>

          {connError ? <ErrorBlock message={connError} /> : null}

          <div className="flex flex-wrap justify-end gap-gap">
            {tokenSaved ? (
              <button
                type="button"
                onClick={() => setConfirmKind('clearToken')}
                className="min-h-tap rounded border border-danger px-4 text-base font-bold text-danger"
              >
                合言葉を消去
              </button>
            ) : null}
            <button
              type="submit"
              className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
            >
              保存する
            </button>
          </div>
        </form>
      </SectionCard>

      {/* ② マスタ同期 */}
      <SectionCard title="マスタ同期">
        <p className="text-base text-ink2">
          名簿を読み取って、利用者・職員の一覧を最新にします。名簿から消えた方は一覧から外れますが、過去の記録は残ります。
        </p>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => void handleSync()}
            disabled={syncing}
            className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:opacity-60"
          >
            {syncing ? '同期中です…' : 'マスタを同期する'}
          </button>
        </div>

        {syncing ? <LoadingBlock label="名簿を読み取っています…" /> : null}
        {syncError ? (
          <div className="mt-3">
            {/* 未設定が理由の場合は再試行しても結果が変わらないため、再試行ボタンを出さない */}
            <ErrorBlock
              message={syncError}
              onRetry={syncError === MSG.unconfigured ? undefined : () => void handleSync()}
            />
          </div>
        ) : null}
        {syncResult ? (
          <div className="mt-3 space-y-2">
            <SyncResultBlock title="利用者" result={syncResult.residents} />
            <SyncResultBlock title="職員" result={syncResult.staff} />
            <p className="text-sm text-ink2">
              「要確認」は、名簿のIDと氏名が食い違っていて自動では反映できなかった件数です。下の「要確認の利用者」で内容を確認してください。
            </p>
          </div>
        ) : null}
      </SectionCard>

      {/* ③ 要確認（needs_review） */}
      <SectionCard title="要確認の利用者">
        <p className="text-base text-ink2">
          名簿と一覧の照合で保留になった方です。氏名の書き換えは自動では行いません。
        </p>
        <div className="mt-3">
          {residentsError ? (
            <ErrorBlock message={residentsError} onRetry={() => setResidentsReload((n) => n + 1)} />
          ) : residents === null ? (
            <LoadingBlock label="利用者の一覧を読み込んでいます…" />
          ) : reviewList.length === 0 ? (
            <EmptyBlock message="要確認の利用者はいません。" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-gap">
                <Chip tone="warn">
                  <span aria-hidden="true">▲</span>
                  <span>{`要確認 ${reviewList.length}名`}</span>
                </Chip>
                <button
                  type="button"
                  onClick={() => setReviewOpen((v) => !v)}
                  aria-expanded={reviewOpen}
                  aria-controls="cl-review-list"
                  className="min-h-tap rounded border border-primary px-4 text-base font-bold text-primary"
                >
                  {reviewOpen ? '一覧を閉じる' : '一覧を開く'}
                </button>
              </div>
              {reviewOpen ? (
                <ul id="cl-review-list" className="mt-2 space-y-2">
                  {reviewList.map((r) => (
                    <li
                      key={r.id}
                      className="flex min-h-tap items-center gap-gap rounded border border-warn bg-warn-bg px-3 py-2"
                    >
                      <span className="tabular min-w-12 shrink-0 text-sm text-ink2">
                        {r.room ?? '—'}
                      </span>
                      <span className="flex-1 text-base font-bold text-ink">{r.name}</span>
                      <span className="shrink-0 text-sm text-warn">
                        <span aria-hidden="true">▲</span>
                        <span className="sr-only">要確認</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-2 text-sm text-ink2">
                名簿側のIDまたは氏名を直してから、もう一度「マスタを同期する」を押してください。この画面から保留を解除することはできません。
              </p>
            </>
          )}
        </div>
      </SectionCard>

      {/* ④ 取込状態（import_days） */}
      <SectionCard title="取込状態（直近10日）">
        <p className="text-base text-ink2">
          スプレッドシートからの取り込みが済んだ日を確認できます。「未取込」はデータがまだ届いていない日で、記録が無い日とは異なります。
        </p>
        <div className="mt-3">
          {importError ? (
            <ErrorBlock message={importError} onRetry={loadImportDays} />
          ) : importLoading ? (
            <LoadingBlock label="取込状態を読み込んでいます…" />
          ) : importByDay === null ? (
            <EmptyBlock
              message="取込状態はまだ読み込んでいません。"
              actionLabel="取込状態を読み込む"
              onAction={loadImportDays}
            />
          ) : (
            <>
              <ul className="space-y-2">
                {days.map((day) => {
                  const d = importByDay.get(day) ?? null
                  return (
                    <li
                      key={day}
                      className={`rounded border border-border px-3 py-2 ${
                        d ? 'bg-surface' : 'bg-surface2'
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-gap">
                        <span className="tabular text-base font-bold text-ink">
                          {fmtDayLabel(day)}
                        </span>
                        {d ? (
                          <Chip tone="ok">
                            <span aria-hidden="true">✓</span>
                            <span>取込済</span>
                          </Chip>
                        ) : (
                          <Chip tone="plain">
                            <span aria-hidden="true">—</span>
                            <span>未取込</span>
                          </Chip>
                        )}
                        {d && d.unmatched > 0 ? (
                          <Chip tone="warn">
                            <span aria-hidden="true">▲</span>
                            <span>{`未照合 ${d.unmatched}件`}</span>
                          </Chip>
                        ) : null}
                      </div>
                      {d ? (
                        <p className="tabular mt-1 text-sm text-ink2">
                          {`源泉 ${d.srcRows}・登録 ${d.inserted}・更新 ${d.updated}・据置 ${d.skipped}・アプリ行維持 ${d.nativeSkip}・未照合 ${d.unmatched}`}
                        </p>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={loadImportDays}
                  className="min-h-tap rounded border border-primary px-4 text-base font-bold text-primary"
                >
                  取込状態を更新する
                </button>
              </div>
            </>
          )}
        </div>
      </SectionCard>

      {/* ⑤ 未送信データ */}
      <SectionCard title="未送信データ">
        <p className="text-base text-ink">
          {pending > 0 ? (
            <>
              <span aria-hidden="true">⚠ </span>
              {`未送信 ${pending}件。電波が戻ると自動で送信します。`}
              {/* 競合・サーバー拒否で自動再送を止めた分は件数が減らない。
                  その理由と次の行動を示す（件数の内訳表示は db.ts の契約追加が要るため積み残し） */}
              <span className="block text-base text-ink2">
                「今すぐ再送する」を押しても件数が減らない場合は、ほかの端末で同じ記録が先に更新された可能性があります。記録は消えていません。管理者に連絡してください。
              </span>
            </>
          ) : (
            <>
              <span aria-hidden="true">✓ </span>
              未送信の記録はありません。
            </>
          )}
        </p>
        {queueBroken ? (
          <div className="mt-3">
            <ErrorBlock message="未送信データの一部を読み取れませんでした。この端末で入力した記録が送信されていない可能性があります。内容は消していませんので、管理者に連絡してください。" />
          </div>
        ) : null}
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => void handleFlush()}
            disabled={pending === 0 || flushing}
            className="min-h-tap rounded border border-primary px-4 text-base font-bold text-primary disabled:opacity-60"
          >
            {flushing ? '再送しています…' : '今すぐ再送する'}
          </button>
        </div>
      </SectionCard>

      {/* ⑥ 表示モード */}
      <SectionCard title="表示モード">
        <p className="text-base text-ink2">
          画面の明るさの設定です。「OS設定」は端末の設定に合わせて自動で切り替わります。
        </p>
        <div className="mt-3">
          <SegmentPicker
            options={MODE_OPTIONS}
            value={mode}
            onChange={handleModeChange}
            ariaLabel="表示モード"
          />
        </div>
      </SectionCard>

      {/* ⑦ ログアウト */}
      <SectionCard title="ログアウト">
        <p className="text-base text-ink2">
          この端末をログイン画面に戻します。入力した記録は消えません。
        </p>
        {logoutError ? (
          <div className="mt-3">
            <ErrorBlock message={logoutError} />
          </div>
        ) : null}
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => setConfirmKind('logout')}
            disabled={loggingOut}
            className="min-h-tap rounded border border-danger px-4 text-base font-bold text-danger disabled:opacity-60"
          >
            {loggingOut ? 'ログアウトしています…' : 'ログアウトする'}
          </button>
        </div>
      </SectionCard>

      <ConfirmDialog
        open={confirmKind !== null}
        title={confirmProps.title}
        body={confirmProps.body}
        confirmLabel={confirmProps.confirmLabel}
        danger
        onConfirm={runConfirm}
        onCancel={() => setConfirmKind(null)}
      />

      {toast}
    </div>
  )
}

export default SettingsPage
