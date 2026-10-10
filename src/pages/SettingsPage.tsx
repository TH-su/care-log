// 設定画面（ルート /settings・5タブの5番目）。
//
// 正本: docs/design/qa-verification.md [low/ui]「設定タブに接続設定・同期状態・保留裁定の3画面を配置」／
//       docs/design/db-design.md §6（マスタ連携）・§7（import_days で『記録なし』と『未取込』を区別）／
//       docs/design/ui-design.md §9（cl_mode = light/dark/auto の復元）・§0.5（並走期間の封鎖は入力画面のみ）／
//       docs/design/contracts.md（db.ts API・共通規律）。
//
// 本画面の構成（上から）:
//   ①GAS接続設定（cl_gasUrl / cl_gasToken の手入力）②マスタ同期の実行と増減計数
//   ③要確認（needs_review）の一覧 ③-2 申し送りでの表示名（2026-09-01 指示）
//   ④取込状態（import_days の直近10日）⑤未送信データ（送信キュー）⑥表示モード ⑦ログアウト
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
import {
  discardQueuedOp,
  fetchAllResidents,
  fetchAllStaff,
  fetchQueuedOpTarget,
  fetchStaff,
  fetchTimelineChunk,
  flushQueue,
  hasUnpersistedQueue,
  isQueueBroken,
  listStoppedOps,
  listUnsentNotes,
  queueSubscribe,
  queueUnreadableCount,
  resendQueuedOp,
  setResidentNoteAlias,
  subscribeMastersChanged,
} from '../lib/db'
import type { StoppedOp } from '../lib/db'
import { getActorId, setActorId as persistActorId, subscribeActor, touchActivity } from '../lib/actor'
import { hasNoteAlias, LS, NOTE_ALIAS_MAX, noteDisplayName, validateNoteAlias } from '../lib/types'
import type { ImportDay, Resident, Staff } from '../lib/types'
import type { RosterReview, SyncResult } from '../lib/gasClient'
import { addDays, fmtDayLabel, todayIso } from '../lib/format'
import { buildLabel, CLIENT_BUILD } from '../lib/appVersion'
import {
  isStoppedDelete,
  stoppedOpLines,
  stoppedOpNeedsCompare,
  stoppedOpReason,
  stoppedOpTitle,
} from '../lib/stoppedOps'
import { UnsentNotes } from '../components/UnsentNotes'
import { MasterSyncStatus } from '../components/MasterSync'
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
  aliasSaveFailed:
    '表示名を保存できませんでした。電波状態を確認して、もう一度「保存」を押してください（入力した文字はそのまま残しています）。',
  aliasQueued: '通信できないため送信待ちにしました。電波が戻ると自動で送信します。',
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

// ── 送れていない記録（止まっている退避 op・F02・F37・2026-10-10） ────────────────────
// 競合（他の端末が先に記録・変更した）・拒否（サーバーが受け付けなかった）で自動では送らなくなった入浴・与薬・事故・
// 水分・外出などの記録は、以前は件数にだけ残り、中身を見る・送り直す・取り下げる手段が無かった。
// ここに1件ずつ中身を出し、記録した端末で次のどれかを選べるようにする（本人回答: 記録した端末で選ぶ）:
//   〔いまの記録とくらべる〕 … 送り先のいまの行を読み、この端末の中身と並べる（くらべた版の上にだけ書く）
//   〔この端末の内容で直す〕 … くらべた後にだけ出す。見せた版（rev・表示名）を渡して送り直す＝見せていない変更を上書きしない
//   〔もう一度送る〕         … 拒否で止まった件・送り先の行が無い件。1回だけ送り直す（また止まれば止まる）
//   〔取り下げ〕             … 確認の後。この端末（同じ端末のほかのタブを含む）から外す。見せた中身だけ
// 与薬の食い違い（拒否と服用済み等）は、人が選ぶまで送らない（自動では解かない）。
// 規律: 氏名は名簿から引くだけ（送信待ちには持たない）。中身は画面の state だけに持ち、localStorage・console に出さない

type StoppedMsg = { tone: 'ok' | 'warn' | 'danger'; text: string }

/** 止まっている記録の一覧（設定画面の「未送信データ」の中に出す） */
function StoppedOpsList({
  ops,
  residentName,
  onChanged,
  notify,
}: {
  ops: StoppedOp[]
  residentName: (id: number) => string
  /** 送り直し・取り下げの後（一覧と件数を取り直す） */
  onChanged: () => void
  /** 一覧から消える結果（送れた・取り下げた）の一言（画面下の通知で出す） */
  notify: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  /** くらべるために読んだ、いまの行（qid → 行。null＝送り先の行が無い） */
  const [targets, setTargets] = useState<Record<string, Record<string, unknown> | null>>({})
  const [msgs, setMsgs] = useState<Record<string, StoppedMsg>>({})
  const [askDrop, setAskDrop] = useState<StoppedOp | null>(null)

  const setMsg = (qid: string, m: StoppedMsg | null) =>
    setMsgs((cur) => {
      const next = { ...cur }
      if (m === null) delete next[qid]
      else next[qid] = m
      return next
    })

  /** 〔いまの記録とくらべる〕: 送り先のいまの行を読む（読めなければ何も変えずに知らせる） */
  const compare = async (op: StoppedOp) => {
    setBusy(op.qid)
    setMsg(op.qid, null)
    try {
      const row = await fetchQueuedOpTarget(op.qid)
      if (row === undefined) {
        setMsg(op.qid, { tone: 'danger', text: 'いまの記録を読めませんでした。電波状態を確認して、もう一度押してください。' })
        return
      }
      setTargets((cur) => ({ ...cur, [op.qid]: row }))
    } finally {
      setBusy(null)
    }
  }

  /** 〔この端末の内容で直す〕〔もう一度送る〕。seen＝見せた行（くらべた時だけ） */
  const resend = async (op: StoppedOp, seen: Record<string, unknown> | null | undefined) => {
    setBusy(op.qid)
    setMsg(op.qid, null)
    try {
      let arg: { rev?: number; alias?: string | null; id?: number } | undefined
      if (seen !== undefined && seen !== null) {
        if (op.kind === 'alias') arg = { alias: typeof seen.note_alias === 'string' ? seen.note_alias : null }
        else if (op.kind === 'insert') arg = { id: Number(seen.id), rev: Number(seen.rev) }
        else arg = { rev: Number(seen.rev) }
      }
      const r = await resendQueuedOp(op.qid, arg)
      // 送れた・送信待ちに戻った・ほかで済んだ件は一覧から消えるので、画面下の通知で知らせる
      if (r === 'sent') notify('送りました。')
      else if (r === 'queued') notify('まだ届いていません。送信待ちに戻しました（電波が戻ると自動で送ります）。')
      else if (r === 'missing') notify('ほかの画面で処理が済んでいます。')
      else if (r === 'conflict') {
        // くらべた後に、さらに他の端末で変わった（またはくらべる前に押せない種類だった）: 読み直して出し直す
        setTargets((cur) => {
          const next = { ...cur }
          delete next[op.qid]
          return next
        })
        setMsg(op.qid, { tone: 'warn', text: '▲ その間に、さらに他の端末で変わりました。〔いまの記録とくらべる〕からもう一度選んでください。' })
      } else setMsg(op.qid, { tone: 'danger', text: '▲ また受け付けられませんでした。中身を確かめて、取り下げるか管理者に連絡してください。' })
      onChanged()
    } catch (e) {
      setMsg(op.qid, { tone: 'danger', text: `▲ ${e instanceof Error && e.message !== '' ? e.message : '送れませんでした。'}` })
    } finally {
      setBusy(null)
    }
  }

  /** 〔取り下げ〕（確認の後） */
  const drop = async (op: StoppedOp) => {
    setAskDrop(null)
    setBusy(op.qid)
    try {
      const r = await discardQueuedOp(op.qid)
      if (r === 'sent') notify('既に送り終えていたため、取り下げられませんでした。記録の画面で内容を確かめてください。')
      else notify(r === 'dropped' ? '取り下げました。' : 'ほかの画面で処理が済んでいます。')
      onChanged()
    } catch {
      setMsg(op.qid, { tone: 'danger', text: '▲ 取り下げられませんでした。もう一度お試しください。' })
    } finally {
      setBusy(null)
    }
  }

  if (ops.length === 0) return null
  const btn = 'min-h-tap rounded border px-3 text-base disabled:border-border disabled:text-ink3'

  return (
    <section aria-label="送れていない記録" className="mt-3 rounded border border-warn bg-warn-bg px-3 py-2 text-ink print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <p className="text-base font-bold">
          <span aria-hidden="true">▲ </span>
          {`止まっている記録 ${ops.length}件（人の判断が要ります）`}
        </p>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`${btn} border-border-strong bg-surface text-ink`}
        >
          {open ? '一覧を閉じる' : '中身を見る'}
        </button>
      </div>
      {open ? (
        <ul className="mt-2 space-y-2">
          {ops.map((op) => {
            const isBusy = busy === op.qid
            const hasTarget = Object.prototype.hasOwnProperty.call(targets, op.qid)
            const target = hasTarget ? targets[op.qid] : undefined
            const needsCompare = stoppedOpNeedsCompare(op)
            // 取り消しを送ろうとした記録が、いまはもう取り消されている＝目的は果たされている
            const alreadyDeleted =
              isStoppedDelete(op) && target !== undefined && target !== null && typeof target.deleted_at === 'string' && target.deleted_at !== ''
            const msg = msgs[op.qid]
            return (
              <li key={op.qid} className="rounded border border-border bg-surface p-3">
                <p className="text-base font-bold text-ink">{stoppedOpTitle(op)}</p>
                <p className="mt-1 text-sm text-ink">{stoppedOpReason(op)}</p>
                <dl className="mt-2 grid grid-cols-1 gap-1 text-base sm:grid-cols-2">
                  <div className="rounded border border-primary p-2">
                    <dt className="text-sm font-bold text-ink">この端末の中身</dt>
                    {stoppedOpLines(op, residentName).map((l) => (
                      <dd key={`m-${l.label}`} className="text-base text-ink">
                        {l.label}：<span className="font-bold">{l.value}</span>
                      </dd>
                    ))}
                  </div>
                  {hasTarget ? (
                    <div className="rounded border border-border-strong bg-surface2 p-2">
                      <dt className="text-sm font-bold text-ink">いまの記録</dt>
                      {target === null || target === undefined ? (
                        <dd className="text-base text-ink">
                          {op.kind === 'insert'
                            ? '先の記録は見つかりません（取り消された可能性があります）。「もう一度送る」で、この端末の内容を新しく記録できます。'
                            : '記録が見つかりません（取り消された可能性があります）。この端末の内容は送れないので、中身を確かめてから取り下げてください。'}
                        </dd>
                      ) : (
                        stoppedOpLines(op, residentName, target).map((l) => (
                          <dd key={`t-${l.label}`} className="text-base text-ink">
                            {l.label}：<span className="font-bold">{l.value}</span>
                          </dd>
                        ))
                      )}
                    </div>
                  ) : null}
                </dl>
                <div className="mt-2 flex flex-wrap gap-gap">
                  {needsCompare && !hasTarget ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void compare(op)}
                      className={`${btn} border-primary font-bold text-primary`}
                    >
                      いまの記録とくらべる
                    </button>
                  ) : null}
                  {needsCompare && hasTarget && target !== null && target !== undefined && !alreadyDeleted ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void resend(op, target)}
                      className={`${btn} border-primary font-bold text-primary`}
                    >
                      この端末の内容で直す
                    </button>
                  ) : null}
                  {/* 送り直してよいのは、くらべる必要が無い件（拒否・自然キーの無い追加）と、自然キーで止まった追加の
                      相手が取り消されていた時だけ。修正・表示名で行が見つからない時は送れない（版を渡せない）ので取り下げだけ */}
                  {!needsCompare || (op.kind === 'insert' && hasTarget && (target === null || target === undefined)) ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void resend(op, undefined)}
                      className={`${btn} border-border-strong text-ink`}
                    >
                      もう一度送る
                    </button>
                  ) : null}
                  {alreadyDeleted ? (
                    // 取り消しはもう済んでいる（他の端末が先に取り消した）。外しても何も失わない
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void drop(op)}
                      className={`${btn} border-primary font-bold text-primary`}
                    >
                      取り消し済みなので外す
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => setAskDrop(op)}
                      className={`${btn} border-danger text-danger`}
                    >
                      取り下げ
                    </button>
                  )}
                </div>
                {msg ? (
                  <p
                    role="status"
                    className={`mt-1 text-sm ${msg.tone === 'danger' ? 'text-danger' : msg.tone === 'warn' ? 'text-warn' : 'text-ok'}`}
                  >
                    {msg.text}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      <ConfirmDialog
        open={askDrop !== null}
        title="この記録を取り下げますか"
        body={
          askDrop === null
            ? ''
            : `「${stoppedOpTitle(askDrop)}」（${stoppedOpLines(askDrop, residentName)
                .map((l) => `${l.label}：${l.value}`)
                .join('／')}）は送られず、この端末（同じ端末のほかのタブを含む）から外れます。元に戻せません。`
        }
        confirmLabel="取り下げる"
        danger
        onConfirm={() => {
          if (askDrop !== null) void drop(askDrop)
        }}
        onCancel={() => setAskDrop(null)}
      />
    </section>
  )
}

// ── 本体 ─────────────────────────────────────────────────────────────────────

type ConfirmKind = 'clearUrl' | 'clearToken' | 'logout' | 'massDrop'

export function SettingsPage() {
  const { toast, show } = useToast()

  // 接続設定（トークンは state にも保持したまま画面へ出さない＝入力欄は常に空から始める）
  const [urlInput, setUrlInput] = useState(() => lsGet(LS.gasUrl))
  const [tokenInput, setTokenInput] = useState('')
  const [tokenSaved, setTokenSaved] = useState(() => lsGet(LS.gasToken) !== '')
  const [connError, setConnError] = useState<string | null>(null)

  // 職員名簿の接続先（2026-08-29 追加）。利用者名簿とは別のGASが持つため独立して設定する。
  // 両方空なら利用者名簿と同じ接続先を使う（未設定の端末は従来どおりの動き）
  const [staffUrlInput, setStaffUrlInput] = useState(() => lsGet(LS.staffGasUrl))
  const [staffTokenInput, setStaffTokenInput] = useState('')
  const [staffTokenSaved, setStaffTokenSaved] = useState(() => lsGet(LS.staffGasToken) !== '')
  const [staffConnError, setStaffConnError] = useState<string | null>(null)

  // 記録する職員（操作者）。2026-08-28 の指示で画面ヘッダの常時表示をやめ、切替はここへ移した。
  // 保存するのは staff_id（数値）だけで、氏名は保存しない（dev-principles 原則11）
  const [staffList, setStaffList] = useState<Staff[] | null>(null)
  const [staffError, setStaffError] = useState(false)
  const [staffReload, setStaffReload] = useState(0)
  /** 退職者も含む全員（名前の引き当て用・F48） */
  const [allStaff, setAllStaff] = useState<Staff[] | null>(null)
  const [actorId, setActorIdState] = useState<number | null>(() => getActorId())
  const [staffFilter, setStaffFilter] = useState('')

  // マスタ同期
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ residents: SyncResult; staff: SyncResult } | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  /**
   * 名簿から一度に外れる人数が多くて止まった時の人数（F43）。確かめた後にこの人数を渡して続ける。
   * 画面の state だけに持つ（端末に保存しない）
   */
  const [massDrop, setMassDrop] = useState<{ residents: number; staff: number } | null>(null)
  /**
   * 直前の同期で分かった「名簿の氏名」（要確認の行ごと・F51）。氏名なので画面の state だけに持ち、
   * localStorage・console には出さない（再読み込み・画面を閉じると消える＝もう一度同期すると出る）
   */
  const [reviews, setReviews] = useState<RosterReview[]>([])
  /** 〔名簿の氏名を採用する〕の確認中の行 */
  const [adoptAsk, setAdoptAsk] = useState<RosterReview | null>(null)
  const [adopting, setAdopting] = useState(false)
  const [reviewMsg, setReviewMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)

  // 要確認（needs_review）
  const [residents, setResidents] = useState<Resident[] | null>(null)
  const [residentsError, setResidentsError] = useState<string | null>(null)
  const [residentsReload, setResidentsReload] = useState(0)
  const [reviewOpen, setReviewOpen] = useState(false) // 覗き見配慮: 氏名一覧は明示操作で開く

  // 申し送りでの表示名（2026-09-01 指示）。
  // 突き合わせ相手には**退居された方も含めた全員**が要る（過去の記録に氏名が残るため）
  const [aliasAll, setAliasAll] = useState<Resident[] | null>(null)
  const [aliasError, setAliasError] = useState<string | null>(null)
  const [aliasReload, setAliasReload] = useState(0)
  const [aliasOpen, setAliasOpen] = useState(false) // 覗き見配慮: 氏名一覧は明示操作で開く
  const [aliasFilter, setAliasFilter] = useState('')
  /** 入力中の文字（利用者ID → 文字）。保存するまでサーバーへは送らない */
  const [aliasDraft, setAliasDraft] = useState<Record<number, string>>({})
  const [aliasSaving, setAliasSaving] = useState<number | null>(null)
  /** 行ごとの結果（保存できた／送信待ちにした／弾いた理由）。行の中に出す＝どの行の話か迷わせない */
  const [aliasMsg, setAliasMsg] = useState<
    Record<number, { tone: 'ok' | 'warn' | 'danger'; text: string }>
  >({})
  /**
   * サーバーから読んだ表示名（利用者ID → 値。F71）。送信待ちにした時に画面の一覧（aliasAll）は自分の値で置き換えるので、
   * 「画面が見ていた変更前の表示名」はこちらから渡す（読み直した時と、サーバーが保存した値を返した時だけ更新する）
   */
  const [aliasServer, setAliasServer] = useState<Record<number, string | null>>({})

  // 取込状態（import_days）
  const [today] = useState(() => todayIso())
  const [importRows, setImportRows] = useState<ImportDay[] | null>(null)
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  // 未送信データ（送信キュー）
  const [pending, setPending] = useState(0)
  const [flushing, setFlushing] = useState(false)
  /** 止まっている（競合・拒否で自動では送らない）退避 op（F02・F37） */
  const [stoppedOps, setStoppedOps] = useState<StoppedOp[]>(() => listStoppedOps())
  /** 止まっている申し送り（一覧は UnsentNotes が出す。件数の内訳にだけ使う） */
  const [stoppedNotes, setStoppedNotes] = useState(0)
  /** この版で読めない未送信（別の版の画面のタブが書いた・F27） */
  const [unreadable, setUnreadable] = useState(() => queueUnreadableCount())
  const [unpersisted, setUnpersisted] = useState(false)

  // 表示モード
  const [mode, setMode] = useState<Mode>(() => readMode())

  // ログアウト
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  const [confirmKind, setConfirmKind] = useState<ConfirmKind | null>(null)

  // 未送信件数（登録直後に現在値が1回流れてくる契約）。止まっている件の一覧・この版で読めない件も同じ時に取り直す
  // （止まっても件数は減らないので、通知のたびに引き直す）
  const refreshQueueView = useCallback(() => {
    setStoppedOps(listStoppedOps())
    setStoppedNotes(
      listUnsentNotes().filter((u) => u.kind === 'rescued' || (u.kind === 'edit' ? u.row.state : u.op.state) !== 'pending')
        .length,
    )
    setUnreadable(queueUnreadableCount())
    setUnpersisted(hasUnpersistedQueue())
  }, [])
  useEffect(
    () =>
      queueSubscribe((n) => {
        setPending(typeof n === 'number' && n > 0 ? n : 0)
        refreshQueueView()
      }),
    [refreshQueueView],
  )

  // 名簿が変わった（この端末・自動の同期、名簿の氏名の採用）ら、利用者・職員の一覧を取り直す（F47・F51）
  useEffect(
    () =>
      subscribeMastersChanged(() => {
        setResidentsReload((n) => n + 1)
        setStaffReload((n) => n + 1)
      }),
    [],
  )

  // 記録する職員が他の所（バイタル・食事の「記録者」・別のタブ）で切り替わったら、ここの表示も合わせる（F46）
  useEffect(() => subscribeActor((id) => setActorIdState(id)), [])

  // 利用者スナップショット（要確認の抽出と、送れていない記録の対象名に使う。33名規模＝軽い読取なので画面表示時に取得する）。
  // 退去された方も含む全員を読む（F49: 退去済みの行に立った「要確認」も一覧に出す・過去の記録の対象名を引く）
  useEffect(() => {
    let alive = true
    setResidentsError(null)
    setResidents(null)
    fetchAllResidents()
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

  // 申し送りでの表示名の一覧（退居された方も含む全員）。
  // 編集できるのは在籍の方だけだが、重複判定には退居された方の氏名も要る
  useEffect(() => {
    let alive = true
    setAliasError(null)
    setAliasAll(null)
    fetchAllResidents()
      .then((rs) => {
        if (!alive) return
        setAliasAll(rs)
        // 入力欄の初期値はサーバーの値。ここで作り直すので、再取得すると書きかけは消える
        setAliasDraft(Object.fromEntries(rs.map((r) => [r.id, r.note_alias ?? ''])))
        setAliasServer(Object.fromEntries(rs.map((r) => [r.id, r.note_alias ?? null])))
        setAliasMsg({})
      })
      .catch(() => {
        if (alive) setAliasError(MSG.residentsFailed)
      })
    return () => {
      alive = false
    }
  }, [aliasReload])

  // 記録する職員の一覧（在籍のみ）。取得に失敗しても他の設定は使えるようにする。
  // マスタ同期の後にも取り直す（F47。以前は画面を開いた時の1回だけで、同期で増えた職員を選べなかった）
  useEffect(() => {
    let alive = true
    setStaffError(false)
    fetchStaff()
      .then((rows) => {
        if (alive) setStaffList(Array.isArray(rows) ? rows : [])
      })
      .catch(() => {
        if (alive) setStaffError(true)
      })
    return () => {
      alive = false
    }
  }, [staffReload])

  // 名前を引くための職員の一覧（退職者も含む全員・F48）。送れていない記録などの記入者名に使う。取れなくても画面は出す
  useEffect(() => {
    let alive = true
    fetchAllStaff()
      .then((rows) => {
        if (alive) setAllStaff(Array.isArray(rows) ? rows : null)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [staffReload])

  const pickActor = useCallback(
    (id: number, name: string) => {
      persistActorId(id)
      touchActivity()
      setActorIdState(id)
      show(`記録する職員を ${name} にしました`)
    },
    [show],
  )

  /** かなでも氏名でも絞れる（職員一覧は最大でも数十件なので端末内で絞る） */
  const staffMatches = useMemo(() => {
    const q = staffFilter.trim()
    const list = (staffList ?? []).filter((s) => s.active)
    if (q === '') return list
    return list.filter((s) => s.name.includes(q))
  }, [staffList, staffFilter])

  const actorName = useMemo(
    () => (staffList ?? []).find((s) => s.id === actorId)?.name ?? null,
    [staffList, actorId],
  )

  // 要確認の一覧（F49: 退去済みの行も出す。退去済みには印を付ける）
  const reviewList = useMemo(
    () => (residents ?? []).filter((r) => r.needs_review),
    [residents],
  )

  // ── 申し送りでの表示名 ────────────────────────────────────
  /** 編集できるのは在籍の方だけ（居室順は fetchAllResidents 側で付いている） */
  const aliasList = useMemo(() => {
    const list = (aliasAll ?? []).filter((r) => r.active)
    const q = aliasFilter.trim()
    if (q === '') return list
    return list.filter((r) => r.name.includes(q) || (r.note_alias ?? '').includes(q) || (r.room ?? '').includes(q))
  }, [aliasAll, aliasFilter])

  /** 表示名を設定してある人数（在籍・退居を問わず数える＝設定の総数） */
  const aliasCount = useMemo(() => (aliasAll ?? []).filter(hasNoteAlias).length, [aliasAll])

  const saveAlias = useCallback(
    async (r: Resident) => {
      const raw = aliasDraft[r.id] ?? ''
      // 保存の前に必ず検証する（別人と同じ表示名を作らせない＝取り違え防止の要）
      const check = validateNoteAlias(raw, r.id, aliasAll ?? [])
      if (!check.ok) {
        setAliasMsg((m) => ({ ...m, [r.id]: { tone: 'danger', text: check.message } }))
        return
      }
      setAliasSaving(r.id)
      setAliasMsg((m) => {
        const next = { ...m }
        delete next[r.id]
        return next
      })
      try {
        // 保存の直前に全員の表示名を読み直して確かめ直す（F71・2026-10-10。設定タブを開いたままの間に、他の端末が
        // 別の方へ同じ表示名を付けた・この方の表示名を直していた時に、古い一覧のまま上書き・重複させない）。
        // 読めない（圏外）時はそのまま進む＝送信待ちに積まれ、送る直前に db.ts が同じ確かめをする
        const fresh = await fetchAllResidents().catch(() => null)
        /** 送信待ちになった時の基準（読み直せた時は、いまのサーバーの値） */
        let baseForSave = Object.prototype.hasOwnProperty.call(aliasServer, r.id) ? aliasServer[r.id] : undefined
        if (fresh !== null) {
          const again = validateNoteAlias(raw, r.id, fresh)
          const now = fresh.find((x) => x.id === r.id)
          const seenNow = baseForSave
          const norm = (v: string | null | undefined) => (v ?? '').trim()
          // この端末が送信待ちにした値が、その後に届いていた時は「他の端末の変更」ではない（画面はその値を出している）
          const shownNow = (aliasAll ?? []).find((x) => x.id === r.id)?.note_alias
          const changedElsewhere =
            now !== undefined &&
            seenNow !== undefined &&
            norm(now.note_alias) !== norm(seenNow) &&
            norm(now.note_alias) !== norm(shownNow)
          if (now !== undefined) baseForSave = now.note_alias ?? null
          if (!again.ok || changedElsewhere) {
            // 一覧と「サーバーの値」は読み直した値へ。打った文字（下書き）は消さない
            setAliasAll(fresh)
            setAliasServer(Object.fromEntries(fresh.map((x) => [x.id, x.note_alias ?? null])))
            const text = !again.ok
              ? again.message
              : `ほかの端末で、この方の表示名が「${norm(now?.note_alias) === '' ? '（なし）' : norm(now?.note_alias)}」に変わっています。確かめてから、もう一度保存してください。`
            setAliasMsg((m) => ({ ...m, [r.id]: { tone: 'danger', text } }))
            return
          }
        }
        // 通信できないときは db.ts が送信待ちキューへ退避して 'queued' を返す（例外にしない）。
        // 3つ目の引数＝画面が見ていた変更前の表示名（サーバーから読んだ値・F71）。送信待ちの間に他の端末が
        // 付けた表示名を、後から届いたこの端末の値で黙って上書きしない（送り直す時に食い違えば止める）
        // 基準は、読み直せた時はいまのサーバーの値・読めなかった時は画面がサーバーから読んだ値（F71）
        const saved = await setResidentNoteAlias(r.id, check.value, baseForSave)
        if (saved === 'queued') {
          // 入力は消さず、この端末には反映しておく（電波が戻ればキューが同じ値を送る）。
          // サーバーの行はまだ書き換わっていないので、置き換えるのは note_alias だけにする
          setAliasAll((prev) =>
            (prev ?? []).map((x) => (x.id === r.id ? { ...x, note_alias: check.value } : x)),
          )
          setAliasDraft((d) => ({ ...d, [r.id]: check.value ?? '' }))
          setAliasMsg((m) => ({ ...m, [r.id]: { tone: 'warn', text: MSG.aliasQueued } }))
          return
        }
        // サーバーが返した行で置き換える（自分が送った値ではなく、保存された値を正とする）
        setAliasAll((prev) => (prev ?? []).map((x) => (x.id === saved.id ? saved : x)))
        setAliasDraft((d) => ({ ...d, [r.id]: saved.note_alias ?? '' }))
        setAliasServer((m) => ({ ...m, [saved.id]: saved.note_alias ?? null }))
        show(check.value === null ? '表示名を外しました' : '表示名を保存しました')
      } catch (err) {
        // 失敗しても入力は消さない（原則4。もう一度「保存」を押せばそのまま送れる）
        const text = err instanceof Error && err.message !== '' ? err.message : MSG.aliasSaveFailed
        setAliasMsg((m) => ({ ...m, [r.id]: { tone: 'danger', text } }))
      } finally {
        setAliasSaving(null)
      }
    },
    [aliasAll, aliasDraft, aliasServer, show],
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

  // ── 職員名簿の接続先 ───────────────────────────────────────────────────────
  // 利用者名簿と同じ作法（合言葉は入力があった時だけ書く＝空欄保存で消さない）

  function handleStaffConnSubmit(ev: FormEvent) {
    ev.preventDefault()
    setStaffConnError(null)
    const url = staffUrlInput.trim()
    const token = staffTokenInput.trim()
    if (url !== '' && !GAS_ENDPOINT_RE.test(url)) {
      setStaffConnError(MSG.urlFormat)
      return
    }
    let ok = true
    if (url === '') ok = lsRemove(LS.staffGasUrl) && ok
    else ok = lsSet(LS.staffGasUrl, url) && ok
    if (token !== '') {
      ok = lsSet(LS.staffGasToken, token) && ok
      if (ok) setStaffTokenSaved(true)
    }
    if (!ok) {
      setStaffConnError(MSG.lsWrite)
      return
    }
    setStaffTokenInput('')
    show(url === '' ? '職員名簿の接続先を消去しました。' : '職員名簿の接続先を保存しました。')
  }

  function clearStaffConn() {
    const ok = lsRemove(LS.staffGasUrl) && lsRemove(LS.staffGasToken)
    if (!ok) {
      setStaffConnError(MSG.lsWrite)
      return
    }
    setStaffUrlInput('')
    setStaffTokenInput('')
    setStaffTokenSaved(false)
    show('職員名簿の接続先を消去しました。利用者名簿と同じ接続先を使います。')
  }

  // ── マスタ同期 ─────────────────────────────────────────────────────────────

  /**
   * マスタ同期。confirmedDrop＝名簿から一度に外れる人数を人が確かめた後に続ける時の人数（F43。省略＝確かめる前）
   */
  async function handleSync(confirmedDrop?: { residents: number; staff: number }) {
    if (syncing) return
    setSyncing(true)
    setSyncError(null)
    setSyncResult(null)
    setMassDrop(null)
    setReviewMsg(null)
    try {
      // 動的 import: 接続未設定でもこの画面のモジュール評価が通るようにする
      const { syncMasters } = await import('../lib/gasClient')
      const res = await syncMasters(confirmedDrop === undefined ? undefined : { confirmedDrop })
      if (res === 'unconfigured') {
        setSyncError(MSG.unconfigured)
      } else {
        setSyncResult({ residents: res.residents, staff: res.staff })
        // 要確認の行の「名簿の氏名」（F51）。画面の state だけに持つ
        setReviews(Array.isArray(res.reviews) ? res.reviews : [])
        setResidentsReload((n) => n + 1) // 要確認の一覧を取り直す
        show('マスタを同期しました。')
      }
    } catch (e) {
      // 名簿から一度に外れる人数が多くて止めた（F43）: 何も書いていない。人数を確かめてもらってから続ける。
      // 再試行のボタンでは同じ守りに当たり続けるので、確認のダイアログを出す
      const drop = e instanceof Error && e.name === 'MasterDropError' ? (e as Error & { residents?: unknown; staff?: unknown }) : null
      if (drop !== null) {
        setMassDrop({
          residents: typeof drop.residents === 'number' ? drop.residents : 0,
          staff: typeof drop.staff === 'number' ? drop.staff : 0,
        })
        setSyncError(drop.message !== '' ? drop.message : MSG.syncFailed)
        setConfirmKind('massDrop')
        return
      }
      // gasClient は画面にそのまま出せる日本語メッセージで throw する契約。
      // 想定外の例外（メッセージ無し）は共通文へ倒す。応答本文は console に出さない
      const msg = e instanceof Error && e.message !== '' ? e.message : MSG.syncFailed
      setSyncError(msg)
    } finally {
      setSyncing(false)
    }
  }

  // ── 要確認の方に名簿の氏名を採用する（F51） ────────────────────────────────────

  async function adoptRoster(rv: RosterReview) {
    setAdoptAsk(null)
    setAdopting(true)
    setReviewMsg(null)
    try {
      const { adoptRosterName } = await import('../lib/gasClient')
      const r = await adoptRosterName(rv.id, rv.current, rv.roster)
      if (r === 'adopted') {
        setReviews((list) => list.filter((x) => x.id !== rv.id))
        setReviewMsg({ tone: 'ok', text: '名簿の氏名を採用して、保留を外しました。部屋・介護度は次の同期で名簿に合わせます。' })
      } else {
        setReviewMsg({ tone: 'danger', text: '他の端末が先に直しました。もう一度「マスタを同期する」を押してください。' })
      }
      setResidentsReload((n) => n + 1)
    } catch (e) {
      setReviewMsg({
        tone: 'danger',
        text: e instanceof Error && e.message !== '' ? e.message : '名簿の氏名を採用できませんでした。もう一度お試しください。',
      })
    } finally {
      setAdopting(false)
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
      // 「この端末だけ」ログアウトする（scope: 'local'）。既定の global だと、同じアカウントで入っている
      // 他のタブレット（施設の共用アカウント）まで次のトークン更新で締め出される（2026-09-26）
      const { error } = await supabase.auth.signOut({ scope: 'local' })
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
    if (confirmKind === 'massDrop') {
      const parts = [
        massDrop !== null && massDrop.residents > 0 ? `利用者${massDrop.residents}人` : '',
        massDrop !== null && massDrop.staff > 0 ? `職員${massDrop.staff}人` : '',
      ].filter((x) => x !== '')
      return {
        title: '名簿から一度に外れる人数を確かめてください',
        body: `名簿に載っていない${parts.join('・') || '方'}が、一覧から外れます（在籍解除）。名簿のシートに絞り込み・編集の途中が無いか確かめましたか。確かめた上で続けると同期します（外れた方の過去の記録は残ります）。`,
        confirmLabel: '確かめたので同期する',
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
  }, [confirmKind, massDrop, pending])

  function runConfirm() {
    const kind = confirmKind
    setConfirmKind(null)
    if (kind === 'clearUrl') saveConnection(true)
    else if (kind === 'clearToken') clearToken()
    else if (kind === 'logout') void handleLogout()
    else if (kind === 'massDrop' && massDrop !== null) void handleSync(massDrop)
  }

  const inputClass =
    'min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink disabled:bg-surface2 disabled:text-ink3'
  const labelClass = 'block text-sm text-ink2'
  const queueBroken = isQueueBroken()
  /** 止まっている（人の判断が要る）件数（退避 op＋申し送り）。件数（pending）より多くは数えない */
  const stoppedTotal = Math.min(pending, stoppedOps.length + stoppedNotes)

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      {/* ⓪ 記録する職員（操作者）。画面ヘッダの常時表示をやめた代わりの切替導線 */}
      <SectionCard title="記録する職員">
        <p className="text-base text-ink2">
          この端末で記録したときに、記入者としてはじめに入る職員です。各行では行ごとに選び直せます。
        </p>
        <p className="mt-2 text-base text-ink">
          いまの記録者:{' '}
          <span className="font-bold">{actorName ?? (actorId == null ? '未選択' : `ID ${actorId}`)}</span>
        </p>

        {staffError && (
          <div className="mt-3">
            <ErrorBlock
              message="職員の一覧を読み込めませんでした（通信エラー）。電波状態を確認して、画面を開き直してください。"
            />
          </div>
        )}
        {!staffError && staffList === null && (
          <div className="mt-3">
            <LoadingBlock label="職員の一覧を読み込んでいます…" />
          </div>
        )}
        {!staffError && staffList !== null && staffList.length === 0 && (
          <div className="mt-3">
            <EmptyBlock message="職員の一覧がまだありません。下の「マスタ同期」を実行してください。" />
          </div>
        )}
        {!staffError && staffList !== null && staffList.length > 0 && (
          <>
            <label className="mt-3 block text-base text-ink2" htmlFor="cl-staff-filter">
              絞り込み
            </label>
            <input
              id="cl-staff-filter"
              type="text"
              value={staffFilter}
              onChange={(e) => setStaffFilter(e.target.value)}
              placeholder="氏名の一部を入力"
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 text-base text-ink"
              style={{ minHeight: 'var(--tap-min)' }}
            />
            <ul className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border">
              {staffMatches.length === 0 && (
                <li className="p-3 text-base text-ink2">
                  該当する職員がいません。別の語をお試しください。
                </li>
              )}
              {staffMatches.map((s) => {
                const selected = s.id === actorId
                return (
                  <li key={s.id} className="border-b border-border last:border-b-0">
                    <button
                      type="button"
                      onClick={() => pickActor(s.id, s.name)}
                      aria-pressed={selected}
                      className={`flex min-h-tap w-full items-center gap-2 px-3 text-left text-base ${
                        selected ? 'bg-primary-bg font-bold text-ink' : 'text-ink'
                      }`}
                    >
                      <span aria-hidden="true" className={selected ? 'text-ok' : 'invisible'}>
                        ✓
                      </span>
                      {s.name}
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </SectionCard>

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

      {/* ①-2 職員名簿の接続先（2026-08-29 追加）。
          職員名簿は利用者名簿と別のGASが持つため、独立して設定できるようにした。
          空欄のままなら上の接続先を使う＝これまでどおりの動きになる。 */}
      <SectionCard title="職員名簿の接続先">
        <p className="text-base text-ink2">
          職員の名簿は、利用者の名簿とは別のシステムが持っていることがあります。その場合だけ、ここに入力してください。
          <strong className="font-bold text-ink">空欄のままなら、上の接続先をそのまま使います。</strong>
        </p>
        <form onSubmit={handleStaffConnSubmit} noValidate className="mt-3 space-y-4">
          <div>
            <label htmlFor="cl-staff-gas-url" className={labelClass}>
              接続先URL（職員名簿）
            </label>
            <input
              id="cl-staff-gas-url"
              type="url"
              inputMode="url"
              value={staffUrlInput}
              onChange={(e) => setStaffUrlInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://script.google.com/macros/s/.../exec"
              aria-describedby="cl-staff-gas-url-hint"
              className={`mt-1 ${inputClass}`}
            />
            <p id="cl-staff-gas-url-hint" className="mt-1 text-sm text-ink2">
              シフト連携のURLを貼り付けてください。空にすると上の接続先を使います。
            </p>
          </div>

          <div>
            <label htmlFor="cl-staff-gas-token" className={labelClass}>
              合言葉（職員名簿）
            </label>
            <p className="mt-1 text-base text-ink">
              {staffTokenSaved ? (
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
              id="cl-staff-gas-token"
              type="password"
              value={staffTokenInput}
              onChange={(e) => setStaffTokenInput(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={staffTokenSaved ? '変更する場合だけ入力' : '合言葉を入力'}
              aria-describedby="cl-staff-gas-token-hint"
              className={`mt-1 ${inputClass}`}
            />
            <p id="cl-staff-gas-token-hint" className="mt-1 text-sm text-ink2">
              入力せずに保存した場合、保存済みの合言葉はそのまま残ります。
            </p>
          </div>

          {staffConnError ? <ErrorBlock message={staffConnError} /> : null}

          <div className="flex flex-wrap justify-end gap-gap">
            {staffTokenSaved || staffUrlInput !== '' ? (
              <button
                type="button"
                onClick={clearStaffConn}
                className="min-h-tap rounded border border-danger px-4 text-base font-bold text-danger"
              >
                職員名簿の設定を消去
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
        {/* 最終同期（他の端末・自動の同期も含む。F50）。接続設定のある端末は起動時と60分ごとに自動で同期する */}
        <div className="mt-2">
          <MasterSyncStatus />
        </div>
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
              onRetry={
                syncError === MSG.unconfigured
                  ? undefined
                  : massDrop !== null
                    ? // 外れる人数で止めた（F43）: 同じ再試行では同じ守りに当たるので、人数の確認から続ける
                      () => setConfirmKind('massDrop')
                    : () => void handleSync()
              }
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
          名簿と一覧の照合で保留になった方です。氏名の書き換えは自動では行いません（部屋・介護度は名簿どおりに直します）。
        </p>
        {reviewMsg ? (
          <p role="status" className={`mt-2 text-base ${reviewMsg.tone === 'danger' ? 'text-danger' : 'text-ok'}`}>
            <span aria-hidden="true">{reviewMsg.tone === 'danger' ? '▲ ' : '✓ '}</span>
            {reviewMsg.text}
          </p>
        ) : null}
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
                  {reviewList.map((r) => {
                    // 直前の同期で分かった名簿の氏名（F51。画面の state だけにある）
                    const rv = reviews.find((x) => x.id === r.id && x.current === r.name) ?? null
                    return (
                      <li key={r.id} className="rounded border border-warn bg-warn-bg px-3 py-2">
                        <div className="flex min-h-tap flex-wrap items-center gap-gap">
                          <span className="tabular min-w-12 shrink-0 text-sm text-ink2">
                            {r.room ?? '—'}
                          </span>
                          <span className="flex-1 text-base font-bold text-ink">{r.name}</span>
                          {/* 退去済みの行に立った保留（F49）。色だけでなく文字で示す */}
                          {!r.active ? <Chip tone="plain">退去済み</Chip> : null}
                          <span className="shrink-0 text-sm text-warn">
                            <span aria-hidden="true">▲</span>
                            <span className="sr-only">要確認</span>
                          </span>
                        </div>
                        {rv !== null ? (
                          <div className="mt-1 flex flex-wrap items-center gap-gap">
                            <p className="min-w-0 flex-1 text-base text-ink">
                              名簿の氏名: <span className="font-bold">{rv.roster}</span>
                            </p>
                            <button
                              type="button"
                              disabled={adopting}
                              onClick={() => setAdoptAsk(rv)}
                              className="min-h-tap shrink-0 rounded border border-primary bg-surface px-4 text-base font-bold text-primary disabled:opacity-60"
                            >
                              名簿の氏名を採用する
                            </button>
                          </div>
                        ) : (
                          <p className="mt-1 text-sm text-ink2">
                            「マスタを同期する」を押すと、名簿の氏名がここに出ます（採用して保留を外せます）。
                          </p>
                        )}
                      </li>
                    )
                  })}
                </ul>
              ) : null}
              <p className="mt-2 text-sm text-ink2">
                名簿の氏名が正しい（異体字の訂正・改姓など）時は、一覧を開いて「名簿の氏名を採用する」で保留を外せます。
                別の方の記録と取り違えている時は、名簿側のIDまたは氏名を直してから、もう一度「マスタを同期する」を押してください。
              </p>
            </>
          )}
        </div>
      </SectionCard>

      {/* ③-2 申し送りでの表示名（2026-09-01 指示） */}
      <SectionCard title="申し送りでの表示名">
        <p className="text-base text-ink2">
          同じ姓の方などを申し送りで見分けるための表示名です。ここで入れた名前は
          <span className="font-bold text-ink">申し送りを扱う画面だけ</span>
          に出ます（バイタル・食事・カルテ・外出外泊はご本人のお名前のままです）。
          空にすると、お名前の表示に戻ります。
        </p>
        <p className="mt-1 text-sm text-ink2">
          <span aria-hidden="true">ⓘ </span>
          マスタ同期でこの表示名が消えることはありません。名簿側のお名前は書き換えません。
        </p>

        <div className="mt-3">
          {aliasError ? (
            <ErrorBlock message={aliasError} onRetry={() => setAliasReload((n) => n + 1)} />
          ) : aliasAll === null ? (
            <LoadingBlock label="利用者の一覧を読み込んでいます…" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-gap">
                <Chip tone={aliasCount > 0 ? 'accent' : 'plain'}>
                  {`表示名を設定 ${aliasCount}名`}
                </Chip>
                <button
                  type="button"
                  onClick={() => setAliasOpen((v) => !v)}
                  aria-expanded={aliasOpen}
                  aria-controls="cl-alias-list"
                  className="min-h-tap rounded border border-primary px-4 text-base font-bold text-primary"
                >
                  {aliasOpen ? '一覧を閉じる' : '一覧を開く'}
                </button>
              </div>

              {aliasOpen ? (
                <div id="cl-alias-list" className="mt-2">
                  <label htmlFor="cl-alias-filter" className="block text-sm text-ink2">
                    絞り込み
                  </label>
                  <input
                    id="cl-alias-filter"
                    type="text"
                    value={aliasFilter}
                    onChange={(e) => setAliasFilter(e.target.value)}
                    autoComplete="off"
                    placeholder="お名前・居室の一部"
                    className="mt-1 min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink"
                  />

                  {aliasList.length === 0 ? (
                    <div className="mt-2">
                      <EmptyBlock
                        message={
                          aliasFilter.trim() === ''
                            ? '在籍中の利用者がいません。設定タブでマスタ同期を実行してください。'
                            : '該当する利用者がいません。入力した文字を減らしてお試しください。'
                        }
                      />
                    </div>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {aliasList.map((r) => {
                        const draft = aliasDraft[r.id] ?? ''
                        const stored = r.note_alias ?? ''
                        const dirty = draft.trim() !== stored.trim()
                        const msg = aliasMsg[r.id]
                        return (
                          <li key={r.id} className="rounded border border-border bg-surface px-3 py-2">
                            <div className="flex flex-wrap items-center gap-gap">
                              <span className="tabular min-w-12 shrink-0 text-sm text-ink2">
                                {r.room ?? '—'}
                              </span>
                              {/* 左はいつでも「ご本人のお名前」。表示名を入れても消さない
                                  ＝どなたの設定を触っているか見失わないため */}
                              <span className="min-w-32 flex-1 text-base font-bold text-ink">
                                {r.name}
                              </span>
                              <input
                                type="text"
                                value={draft}
                                maxLength={NOTE_ALIAS_MAX}
                                onChange={(e) =>
                                  setAliasDraft((d) => ({ ...d, [r.id]: e.target.value }))
                                }
                                autoComplete="off"
                                aria-label={`${r.name} の申し送りでの表示名`}
                                className="min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink sm:w-56"
                              />
                              <button
                                type="button"
                                onClick={() => void saveAlias(r)}
                                disabled={aliasSaving === r.id || !dirty}
                                className="min-h-tap shrink-0 rounded border border-primary px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
                              >
                                {aliasSaving === r.id ? '保存中…' : '保存'}
                              </button>
                            </div>
                            {/* 書きかけのまま画面を離れると消えるので、その旨を出しておく */}
                            {dirty && !msg ? (
                              <p className="mt-1 text-sm text-warn">
                                <span aria-hidden="true">▲ </span>まだ保存していません
                              </p>
                            ) : null}
                            {msg ? (
                              <p
                                role="status"
                                className={`mt-1 text-sm ${
                                  msg.tone === 'danger'
                                    ? 'text-danger'
                                    : msg.tone === 'warn'
                                      ? 'text-warn'
                                      : 'text-ok'
                                }`}
                              >
                                <span aria-hidden="true">
                                  {msg.tone === 'danger' ? '▲ ' : msg.tone === 'warn' ? '⚠ ' : '✓ '}
                                </span>
                                {msg.text}
                              </p>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  )}

                  <p className="mt-2 text-sm text-ink2">
                    別の利用者のお名前・表示名と同じ表示名は保存できません（取り違えのもとになるため）。
                    {NOTE_ALIAS_MAX}文字までです。
                  </p>
                </div>
              ) : null}
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
              {`未送信 ${pending}件。`}
              {/* 内訳（F37）: 自動で送る送信待ちと、競合・拒否で止まっていて人の判断が要る件を分ける。
                  止まった件は電波が戻っても送られないので「自動で送信します」とは言わない */}
              {stoppedTotal > 0 ? (
                <span className="block text-base text-ink">
                  {`うち止まっている（人の判断が要る）記録 ${stoppedTotal}件`}
                  {pending - stoppedTotal > 0
                    ? `・送信待ち ${pending - stoppedTotal}件（電波が戻ると自動で送信します）`
                    : ''}
                </span>
              ) : (
                '電波が戻ると自動で送信します。'
              )}
              <span className="block text-base text-ink2">
                {stoppedTotal > 0
                  ? '止まっている記録は、下の一覧で中身を確かめて「いまの記録とくらべる」「もう一度送る」「取り下げ」から選んでください。バイタル・食事の食い違いは、それぞれの画面の「くらべて選ぶ」から選べます。記録は消えていません。'
                  : '「今すぐ再送する」を押しても件数が減らない場合は、バイタル・食事の画面に「くらべて選ぶ」が出ていないか確かめてください。記録は消えていません。'}
              </span>
            </>
          ) : (
            <>
              <span aria-hidden="true">✓ </span>
              未送信の記録はありません。
            </>
          )}
        </p>
        {/* 端末に残せていない送信待ち（保存領域が一杯・F01）。閉じる・再読み込みで消える */}
        {unpersisted ? (
          <p role="alert" className="mt-2 text-base font-bold text-danger">
            <span aria-hidden="true">▲ </span>
            端末の保存領域が一杯のため、送信待ちを端末に残せていません。この画面を閉じたり再読み込みしたりすると消えます。電波のある所で送り終えてください。
          </p>
        ) : null}
        {/* 止まっている記録（申し送り以外。F02・F37） */}
        <StoppedOpsList
          ops={stoppedOps}
          residentName={(id) => {
            const r = (residents ?? []).find((x) => x.id === id)
            return r ? `${r.room ? `${r.room} ` : ''}${r.name}` : `利用者ID ${id}`
          }}
          onChanged={refreshQueueView}
          notify={show}
        />
        {/* 送れていない申し送り（本文つきの一覧。1件も無い時は何も出さない・2026-09-29 H1） */}
        <UnsentNotes
          actorId={actorId}
          // 名前の引き当て用（退職者も含む全員・F48）。取れていなければ在籍者の一覧
          staff={allStaff ?? staffList ?? undefined}
          residentName={(id) => {
            if (id === null) return 'スタッフへ（全体）'
            const r = (residents ?? []).find((x) => x.id === id)
            return r ? noteDisplayName(r) : `利用者ID ${id}`
          }}
        />
        {queueBroken || unreadable > 0 ? (
          <div className="mt-3">
            {/* 別の版の画面のタブが書いた送信待ちは、この版では読めない（F27）。読み戻せる分は自動で戻すので、
                残っているのは別の版でしか送れない分。開いているタブを閉じて開き直すと、そろった版で送られる */}
            <ErrorBlock
              message={`未送信データの一部${unreadable > 0 ? `（${unreadable}件）` : ''}を、この版の画面では読み取れませんでした（別の版の画面のタブが書いた可能性があります）。内容は消していません。この端末で開いているケアログのタブ（画面）をすべて閉じてから、開き直してください。それでも残る場合は管理者に連絡してください。`}
            />
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

      {/* ⑤-2 アプリの版（F28④・2026-10-10）。新しい版を公開した後に、全端末が同じ版になったかを確かめる */}
      <SectionCard title="アプリの版">
        <p className="text-base text-ink">
          この端末の版: <span className="tabular font-bold">{buildLabel(CLIENT_BUILD)}</span>
        </p>
        <p className="mt-1 text-sm text-ink2">
          新しい版を公開した後は、各端末でこの表示がそろっているかを確かめてください。新しい版があると画面の上に「新しい版が公開されました」と出ます。
        </p>
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

      {/* 名簿の氏名の採用（F51）。いまの氏名と名簿の氏名を並べて確かめてから書く */}
      <ConfirmDialog
        open={adoptAsk !== null}
        title="名簿の氏名を採用しますか"
        body={
          adoptAsk === null
            ? ''
            : `いまの氏名「${adoptAsk.current}」を、名簿の氏名「${adoptAsk.roster}」に直して保留を外します。同じ方であること（異体字の訂正・改姓など）を確かめてから押してください。過去の記録はそのまま残ります。`
        }
        confirmLabel="採用する"
        onConfirm={() => {
          if (adoptAsk !== null) void adoptRoster(adoptAsk)
        }}
        onCancel={() => setAdoptAsk(null)}
      />

      {toast}
    </div>
  )
}

export default SettingsPage
