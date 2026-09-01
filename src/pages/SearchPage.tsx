// インクリメンタル検索（docs/design/ui-design.md §4）。
// 対象は「利用者名／本文／記入者」の3種。利用者名は fetchResidents をメモリに保持して
// 端末内で即時に絞り込み（通信なし）、本文・記入者は db.ts の searchNotes を叩く。
//
// この画面の規律:
//   - 読み取り専用。書き込み経路を持たない（multi-device-sync 原則9「読み取りで書かない」。既読も付けない）
//   - 期間レンジ＋件数上限つきの検索のみ（全件ロード経路を作らない）
//   - 検索語・結果は localStorage に保存しない（dev-principles 原則11・§9「検索語は保存しない」）
//   - console 出力を持たない。氏名・記録本文はコード・コメントに書かない（表示は実行時の取得値のみ）
//   - Tailwind はトークン由来クラスのみ。色・px の直書きと arbitrary value は書かない
//   - 入力封鎖中（native_input_enabled=false）でも検索は全機能有効（閲覧・検証専用モードの対象外）

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CompositionEvent, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Chip, EmptyBlock, ErrorBlock, LoadingBlock, SegmentPicker } from '../components/ui'
import { DbError, fetchResidents, fetchStaff, searchNotes } from '../lib/db'
import { addDays, fmtDayLabel, fmtTimeHM, isoDate, todayIso } from '../lib/format'
import { IMPORTANCE_LABEL, noteDisplayName, SHIFT_LABEL } from '../lib/types'
import type { Importance, Note, Resident, Shift, Staff } from '../lib/types'

// ══════════════════════════════════════════════════════════════
// 定数
// ══════════════════════════════════════════════════════════════

/** 入力が止まってから検索するまでの待ち時間（ui-design.md §4「デバウンス 250ms」） */
const DEBOUNCE_MS = 250

/** 本文・記入者検索の最小文字数（§4「最低2文字」） */
const MIN_QUERY = 2
/** 利用者名は 33 名のメモリ内絞込のため1文字から効かせる（§4） */
const MIN_RESIDENT_QUERY = 1

/** 表示する最大件数。上限超過を検知するため、取得は +1 件して比較する */
const PAGE_SIZE = 50
const FETCH_LIMIT = PAGE_SIZE + 1

/** 「全期間」の下限日。記録開始より前の固定日で、レンジ条件を必ず1つ持たせる */
const ALL_FROM = '2000-01-01'

/** 強調の探索回数上限（病的な入力で無限ループさせないための歯止め） */
const MAX_HITS = 200

const TARGETS = ['resident', 'body', 'reporter'] as const
type Target = (typeof TARGETS)[number]

const TARGET_OPTIONS: { value: string; label: string }[] = [
  { value: 'resident', label: '利用者名' },
  { value: 'body', label: '本文' },
  { value: 'reporter', label: '記入者' },
]

const PERIODS = ['10d', '1m', '3m', '1y', 'all'] as const
type PeriodKey = (typeof PERIODS)[number]

const PERIOD_OPTIONS: { value: string; label: string }[] = [
  { value: '10d', label: '10日' },
  { value: '1m', label: '1か月' },
  { value: '3m', label: '3か月' },
  { value: '1y', label: '1年' },
  { value: 'all', label: '全期間' },
]

/** 既定は3か月（docs/PLAN.md §検索「既定90日」） */
const DEFAULT_PERIOD: PeriodKey = '3m'

const IMPORTANCE_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'normal', label: IMPORTANCE_LABEL.normal },
  { value: 'important', label: IMPORTANCE_LABEL.important },
  { value: 'critical', label: IMPORTANCE_LABEL.critical },
]

const SHIFT_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'day', label: SHIFT_LABEL.day },
  { value: 'daycare', label: SHIFT_LABEL.daycare },
  { value: 'night', label: SHIFT_LABEL.night },
]

/** 通信エラー時の定型文（§4「何が起きたか＋次にどうすればよいか」） */
const ERR_SEARCH =
  '検索できませんでした（通信エラー）。電波状態を確認して、再試行してください。'
const ERR_RESIDENTS =
  '利用者の一覧を読み込めませんでした（通信エラー）。電波状態を確認して、再試行してください。'

/** 検索語欄のプレースホルダ（実在の氏名・記録は書かない） */
const PLACEHOLDER: Record<Target, string> = {
  resident: '氏名・かな・居室の一部',
  body: '本文に含まれる語（2文字以上）',
  reporter: '記入者の氏名の一部（2文字以上）',
}

const HINT: Record<Target, string> = {
  resident: '利用者名を1文字以上入力すると、その場で絞り込みます。',
  body: '申し送りの本文を2文字以上入力すると検索します。',
  reporter: '記入者の氏名を2文字以上入力すると、その方が書いた申し送りを検索します。',
}

// ══════════════════════════════════════════════════════════════
// 純ロジック（副作用なし）
// ══════════════════════════════════════════════════════════════

/** 受信データを信じない: 配列でなければ空配列に倒す */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

/** 絞込用キー: カタカナ→ひらがな・英字は小文字・空白除去で部分一致させる */
function kanaKey(s: string): string {
  return s
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　]/g, '')
    .toLowerCase()
}

/** 月単位の加減算。月末日は移動先の月の末日に丸める（3/31 の1か月前は 2/28） */
function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso
  const first = new Date(y, m - 1 + n, 1)
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return isoDate(new Date(first.getFullYear(), first.getMonth(), Math.min(d, lastDay)))
}

/** 期間プリセット → 検索開始日（終了日は当日） */
export function periodFromIso(period: PeriodKey, toIso: string): string {
  switch (period) {
    case '10d':
      return addDays(toIso, -9) // 当日を含めて10日分
    case '1m':
      return addMonths(toIso, -1)
    case '3m':
      return addMonths(toIso, -3)
    case '1y':
      return addMonths(toIso, -12)
    case 'all':
    default:
      return ALL_FROM
  }
}

/** 文字数（サロゲートペアを1文字として数える） */
function charCount(s: string): number {
  return Array.from(s).length
}

export interface HighlightPart {
  text: string
  hit: boolean
}

/**
 * 一致語の位置を求めて「一致／不一致」の断片に割る（表示側で <mark> を当てる）。
 * 大小文字を無視して探すが、小文字化で長さが変わる文字が混ざる場合は
 * 位置がずれるため、そのまま（大小文字を区別する）比較に落とす。
 */
export function splitHighlight(text: string, q: string): HighlightPart[] {
  if (!text) return []
  const needleRaw = q.trim()
  if (needleRaw === '') return [{ text, hit: false }]

  const lowerText = text.toLowerCase()
  const lowerNeedle = needleRaw.toLowerCase()
  const safe = lowerText.length === text.length && lowerNeedle.length === needleRaw.length
  const haystack = safe ? lowerText : text
  const needle = safe ? lowerNeedle : needleRaw

  const parts: HighlightPart[] = []
  let pos = 0
  for (let hits = 0; hits < MAX_HITS; hits++) {
    const at = haystack.indexOf(needle, pos)
    if (at < 0) break
    if (at > pos) parts.push({ text: text.slice(pos, at), hit: false })
    parts.push({ text: text.slice(at, at + needle.length), hit: true })
    pos = at + needle.length
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), hit: false })
  return parts.length === 0 ? [{ text, hit: false }] : parts
}

// ══════════════════════════════════════════════════════════════
// 一致語の強調（色だけに頼らないよう下線を併用する・§4）
// ══════════════════════════════════════════════════════════════

function Highlight({ text, q }: { text: string; q: string }) {
  const parts = useMemo(() => splitHighlight(text, q), [text, q])
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          // 断片は「同じ文字列の何番目か」で決まるため、位置（i）が安定した識別子になる
          <mark key={i} className="bg-accent-bg font-bold text-ink underline">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// 検索結果の状態（3状態＋待機）
// ══════════════════════════════════════════════════════════════

type NoteStatus = 'idle' | 'loading' | 'error' | 'done'

interface NoteResult {
  status: NoteStatus
  notes: Note[]
  /** 表示上限（50件）を超えて該当がある */
  truncated: boolean
  error: string | null
}

const IDLE_RESULT: NoteResult = { status: 'idle', notes: [], truncated: false, error: null }

// ══════════════════════════════════════════════════════════════
// 結果カード（タイムラインと同型。覗き見配慮で本文は既定2行clamp）
// ══════════════════════════════════════════════════════════════

interface NoteResultCardProps {
  note: Note
  resident: Resident | undefined
  reporterName: string | null
  /** 本文の強調語（本文検索のときだけ渡す） */
  bodyQuery: string
  /** 記入者名の強調語（記入者検索のときだけ渡す） */
  reporterQuery: string
}

function NoteResultCard({
  note,
  resident,
  reporterName,
  bodyQuery,
  reporterQuery,
}: NoteResultCardProps) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()

  return (
    <li className="rounded-md border border-border bg-surface p-3">
      {/* 1行目: 日付・時刻・勤務帯・対象・職種タグ・重要度 */}
      <div className="flex flex-wrap items-center gap-gap">
        <span className="tabular text-sm font-bold text-ink2">{fmtDayLabel(note.note_on)}</span>
        <span className="tabular text-sm text-ink2">{fmtTimeHM(note.occurred_at) || '—'}</span>
        <span className="text-sm text-ink2">{SHIFT_LABEL[note.shift] ?? ''}</span>
        {note.resident_id == null ? (
          <span className="text-base text-info">
            <span aria-hidden="true">ⓘ </span>スタッフへ
          </span>
        ) : resident ? (
          // 申し送りの結果なので「申し送りでの表示名」で出す（2026-09-01 指示。
          // 下の利用者一覧はカルテへの導線なのでマスタの氏名のまま）
          <span className="text-base font-bold text-ink">{noteDisplayName(resident)}</span>
        ) : (
          // 利用者マスタを取得できていない場合。IDは出さず「取れていない」ことだけを示す
          <span className="text-base text-ink3">利用者名 未取得</span>
        )}
        {asArray<string>(note.role_tags).map((t) => (
          <Chip key={t}>{t}</Chip>
        ))}
        {note.importance === 'important' && <Chip tone="warn">{IMPORTANCE_LABEL.important}</Chip>}
        {note.importance === 'critical' && <Chip tone="danger">{IMPORTANCE_LABEL.critical}</Chip>}
        {note.ongoing && <Chip tone="info">継続</Chip>}
      </div>

      {/* 2行目: 本文（既定2行clamp・タップで展開＝明示操作。展開状態は保存しない） */}
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((v) => !v)}
        className="mt-2 min-h-tap w-full text-left"
      >
        <span id={bodyId} className={`block text-lg text-ink ${expanded ? '' : 'clamp-2'}`}>
          <Highlight text={note.body} q={bodyQuery} />
        </span>
        <span className="mt-1 block text-sm text-link">
          {expanded ? '本文を閉じる' : '本文をすべて表示'}
        </span>
      </button>

      {/* 3行目: 記入者・既読数・カルテへの導線 */}
      <div className="mt-1 flex flex-wrap items-center gap-gap">
        <span className="text-sm text-ink2">
          記入者{' '}
          {reporterName === null ? '—' : <Highlight text={reporterName} q={reporterQuery} />}
        </span>
        {typeof note.read_count === 'number' ? (
          <span className="tabular text-sm text-ink2">
            <span aria-hidden="true">✓</span>
            <span className="sr-only">既読 </span>既読 {note.read_count}
          </span>
        ) : null}
        {note.resident_id != null ? (
          <Link
            to={`/karte/${note.resident_id}`}
            className="inline-flex min-h-tap items-center rounded border border-border-strong px-3 text-base text-link"
          >
            カルテを開く
            <span aria-hidden="true" className="ml-1">
              ›
            </span>
          </Link>
        ) : null}
      </div>
    </li>
  )
}

// ══════════════════════════════════════════════════════════════
// 画面本体
// ══════════════════════════════════════════════════════════════

export interface SearchPageProps {
  /** 利用者マスタ。未指定ならこの画面で取得してメモリに保持する */
  residents?: Resident[]
}

export function SearchPage({ residents: residentsProp }: SearchPageProps = {}) {
  const fieldId = useId()

  // ── 入力（生の値）と、デバウンス後の検索語 ──
  const [text, setText] = useState('')
  const [composing, setComposing] = useState(false)
  const [query, setQuery] = useState('')

  // ── 絞り込み ──
  const [target, setTarget] = useState<Target>('body')
  const [period, setPeriod] = useState<PeriodKey>(DEFAULT_PERIOD)
  const [importance, setImportance] = useState<string>('all')
  const [shift, setShift] = useState<string>('all')

  // ── 利用者マスタ（メモリ保持・即時絞込用）──
  const [loadedResidents, setLoadedResidents] = useState<Resident[] | null>(
    residentsProp ? residentsProp : null,
  )
  const [residentsError, setResidentsError] = useState<string | null>(null)
  const [residentsReload, setResidentsReload] = useState(0)

  // ── 職員名（記入者の表示・強調用。取得できなくても検索自体は成立する）──
  const [staff, setStaff] = useState<Staff[]>([])
  const [staffError, setStaffError] = useState(false)

  const [result, setResult] = useState<NoteResult>(IDLE_RESULT)
  const [retryTick, setRetryTick] = useState(0)
  const seqRef = useRef(0)

  // 利用者マスタを一度だけ取得して保持する（以降の絞込は端末内で完結＝通信ゼロ）
  useEffect(() => {
    if (residentsProp) {
      setLoadedResidents(residentsProp)
      setResidentsError(null)
      return
    }
    let cancelled = false
    setResidentsError(null)
    fetchResidents()
      .then((rows) => {
        if (cancelled) return
        setLoadedResidents(asArray<Resident>(rows).filter((r) => r != null && typeof r.id === 'number'))
      })
      .catch(() => {
        // 取得済みの表示は消さない（原則4: 安全側フォールバック）
        if (!cancelled) setResidentsError(ERR_RESIDENTS)
      })
    return () => {
      cancelled = true
    }
  }, [residentsProp, residentsReload])

  useEffect(() => {
    let cancelled = false
    fetchStaff()
      .then((rows) => {
        if (cancelled) return
        setStaff(asArray<Staff>(rows).filter((s) => s != null && typeof s.id === 'number'))
        setStaffError(false)
      })
      .catch(() => {
        // 記入者名は「—」表示に落として画面は成立させる（検索自体は db.ts 側の名簿で行う）
        if (!cancelled) setStaffError(true)
      })
    return () => {
      cancelled = true
    }
  }, [residentsReload])

  const residents = loadedResidents ?? []

  const residentById = useMemo(() => {
    const m = new Map<number, Resident>()
    for (const r of residents) m.set(r.id, r)
    return m
  }, [residents])

  const staffById = useMemo(() => {
    const m = new Map<number, string>()
    for (const s of staff) m.set(s.id, s.name)
    return m
  }, [staff])

  // ── デバウンス（IME変換中は起動しない＝compositionend を待つ）──
  useEffect(() => {
    if (composing) return // 変換確定まで検索語を更新しない
    const next = text.trim()
    const timer = window.setTimeout(() => setQuery(next), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [text, composing])

  // 対象を切り替えたら前の結果を残さない（本文の結果を記入者の結果と誤読させない）
  useEffect(() => {
    setResult(IDLE_RESULT)
  }, [target])

  // ── 本文・記入者の検索（利用者名は通信しない）──
  useEffect(() => {
    if (target === 'resident') return
    const q = query.trim()
    if (charCount(q) < MIN_QUERY) {
      setResult(IDLE_RESULT)
      return
    }

    const seq = ++seqRef.current
    setResult((prev) => ({ ...prev, status: 'loading', error: null }))

    const toIso = todayIso()
    searchNotes({
      q,
      target,
      fromIso: periodFromIso(period, toIso),
      toIso,
      importance: importance === 'all' ? undefined : (importance as Importance),
      shift: shift === 'all' ? undefined : (shift as Shift),
      limit: FETCH_LIMIT,
    })
      .then((rows) => {
        if (seq !== seqRef.current) return // 古い応答は捨てる（入力中の取り違え防止）
        const list = asArray<Note>(rows).filter((n) => n != null && typeof n.id === 'number')
        setResult({
          status: 'done',
          notes: list.slice(0, PAGE_SIZE),
          truncated: list.length > PAGE_SIZE,
          error: null,
        })
      })
      .catch((e: unknown) => {
        if (seq !== seqRef.current) return
        const msg = e instanceof DbError && e.message ? e.message : ERR_SEARCH
        setResult({ status: 'error', notes: [], truncated: false, error: msg })
      })
  }, [target, query, period, importance, shift, retryTick])

  // ── 利用者名の絞込（メモリ内・即時）──
  // 変換中は確定済みの語で絞る（未確定のローマ字で結果が踊らないようにする）
  const residentQuery = composing ? query : text.trim()
  const residentMatches = useMemo(() => {
    if (target !== 'resident') return []
    const key = kanaKey(residentQuery)
    if (key.length < MIN_RESIDENT_QUERY) return []
    return residents.filter((r) =>
      [r.name, r.kana ?? '', r.room ?? ''].some((f) => kanaKey(f).includes(key)),
    )
  }, [target, residentQuery, residents])

  const onCompositionStart = useCallback(() => setComposing(true), [])
  const onCompositionEnd = useCallback((e: CompositionEvent<HTMLInputElement>) => {
    // 変換確定。ブラウザによって change の到達順が前後するため、ここでも確定値を取り込む
    setText(e.currentTarget.value)
    setComposing(false)
  }, [])

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      setQuery(text.trim()) // 待ち時間を飛ばして即座に検索する
    },
    [text],
  )

  const clearText = useCallback(() => {
    setText('')
    setQuery('')
    setResult(IDLE_RESULT)
  }, [])

  const showFilters = target !== 'resident'
  const minLen = target === 'resident' ? MIN_RESIDENT_QUERY : MIN_QUERY
  const typed = target === 'resident' ? residentQuery : query
  const tooShort = charCount(typed) < minLen

  return (
    <div className="mx-auto w-full max-w-2xl pb-8">
      <h1 className="text-xl font-heavy text-ink">検索</h1>
      <p className="mt-1 text-sm text-ink2">{HINT[target]}</p>

      {/* ── 検索語 ───────────────────────────────── */}
      <form onSubmit={onSubmit} role="search" className="mt-3">
        <label htmlFor={fieldId} className="block text-sm text-ink2">
          検索語
        </label>
        <div className="mt-1 flex items-start gap-gap">
          <input
            id={fieldId}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            autoComplete="off"
            enterKeyHint="search"
            placeholder={PLACEHOLDER[target]}
            className="min-h-tap min-w-0 flex-1 rounded border border-border bg-surface px-3 text-base text-ink"
          />
          <button
            type="button"
            onClick={clearText}
            disabled={text === ''}
            className="min-h-tap shrink-0 rounded border border-border-strong px-3 text-base text-ink disabled:text-ink3"
          >
            消す
          </button>
        </div>
      </form>

      {/* ── 対象・絞り込み ─────────────────────────── */}
      <div className="mt-3 space-y-3">
        <div>
          <span className="block text-sm text-ink2">探す場所</span>
          <div className="mt-1">
            <SegmentPicker
              options={TARGET_OPTIONS}
              value={target}
              onChange={(v) => {
                if ((TARGETS as readonly string[]).includes(v)) setTarget(v as Target)
              }}
              ariaLabel="探す場所"
            />
          </div>
        </div>

        {showFilters && (
          <>
            <div>
              <span className="block text-sm text-ink2">期間</span>
              <div className="mt-1">
                <SegmentPicker
                  options={PERIOD_OPTIONS}
                  value={period}
                  onChange={(v) => {
                    if ((PERIODS as readonly string[]).includes(v)) setPeriod(v as PeriodKey)
                  }}
                  ariaLabel="期間"
                />
              </div>
            </div>
            <div>
              <span className="block text-sm text-ink2">重要度</span>
              <div className="mt-1">
                <SegmentPicker
                  options={IMPORTANCE_OPTIONS}
                  value={importance}
                  onChange={setImportance}
                  ariaLabel="重要度"
                />
              </div>
            </div>
            <div>
              <span className="block text-sm text-ink2">勤務帯</span>
              <div className="mt-1">
                <SegmentPicker
                  options={SHIFT_OPTIONS}
                  value={shift}
                  onChange={setShift}
                  ariaLabel="勤務帯"
                />
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── 結果 ───────────────────────────────── */}
      <div className="mt-4">
        {target === 'resident' ? (
          <ResidentResults
            query={residentQuery}
            matches={residentMatches}
            residentsLoaded={loadedResidents !== null}
            error={residentsError}
            onRetry={() => setResidentsReload((n) => n + 1)}
            onClear={clearText}
            tooShort={tooShort}
          />
        ) : (
          <>
            {/* 利用者名だけが取れなかった場合（検索結果そのものは表示を続ける） */}
            {residentsError !== null && (
              <div className="mb-2 rounded-md border border-warn bg-warn-bg px-3 py-3 text-sm text-ink">
                <p>
                  <span aria-hidden="true">▲ </span>
                  利用者の氏名を読み込めませんでした（通信エラー）。対象者名が「未取得」と表示されます。電波状態を確認して再読み込みしてください。
                </p>
                <button
                  type="button"
                  onClick={() => setResidentsReload((n) => n + 1)}
                  className="mt-2 min-h-tap rounded-md border border-border-strong px-3 text-base text-ink"
                >
                  利用者名を再読み込み
                </button>
              </div>
            )}
            {/* 記入者名だけが取れなかった場合（検索結果そのものは表示を続ける） */}
            {staffError && (
              <div className="mb-2 rounded-md border border-warn bg-warn-bg px-3 py-3 text-sm text-ink">
                <p>
                  <span aria-hidden="true">▲ </span>
                  記入者の氏名を読み込めませんでした（通信エラー）。記入者は「—」と表示されます。電波状態を確認して再読み込みしてください。
                </p>
                <button
                  type="button"
                  onClick={() => setResidentsReload((n) => n + 1)}
                  className="mt-2 min-h-tap rounded-md border border-border-strong px-3 text-base text-ink"
                >
                  記入者名を再読み込み
                </button>
              </div>
            )}
            <NoteResults
              result={result}
              query={query}
              target={target}
              tooShort={tooShort}
              period={period}
              residentById={residentById}
              staffById={staffById}
              onWidenPeriod={() => setPeriod('all')}
              onRetry={() => setRetryTick((n) => n + 1)}
            />
          </>
        )}
      </div>
    </div>
  )
}

export default SearchPage

// ══════════════════════════════════════════════════════════════
// 利用者名の結果（メモリ内絞込・3状態）
// ══════════════════════════════════════════════════════════════

interface ResidentResultsProps {
  query: string
  matches: Resident[]
  residentsLoaded: boolean
  error: string | null
  onRetry: () => void
  onClear: () => void
  tooShort: boolean
}

function ResidentResults({
  query,
  matches,
  residentsLoaded,
  error,
  onRetry,
  onClear,
  tooShort,
}: ResidentResultsProps) {
  if (error && !residentsLoaded) return <ErrorBlock message={error} onRetry={onRetry} />
  if (!residentsLoaded) return <LoadingBlock label="利用者の一覧を読み込んでいます…" />
  if (tooShort) {
    return (
      <p className="text-base text-ink2">
        利用者名を{MIN_RESIDENT_QUERY}文字以上入力してください（氏名・かな・居室で探せます）。
      </p>
    )
  }
  if (matches.length === 0) {
    return (
      <EmptyBlock
        message="該当する利用者がいません。入力した文字を減らすか、別の読み方でお試しください。"
        actionLabel="検索語を消す"
        onAction={onClear}
      />
    )
  }

  return (
    <>
      {error ? (
        <p className="mb-2 text-sm text-warn">
          <span aria-hidden="true">▲ </span>
          最新の一覧を取得できませんでした。表示は前回取得した内容です。
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="mb-2 text-base text-ink2">
        <span className="tabular font-bold text-ink">{matches.length}</span> 名
      </p>
      <ul className="space-y-2">
        {matches.map((r) => (
          <li key={r.id}>
            <Link
              to={`/karte/${r.id}`}
              className="flex min-h-tap w-full items-center gap-gap rounded border border-border bg-surface px-3 py-2 text-base text-ink"
            >
              <span className="tabular w-14 shrink-0 text-sm text-ink3">
                <Highlight text={r.room ?? '—'} q={query} />
              </span>
              <span className="flex-1 truncate font-bold">
                <Highlight text={r.name} q={query} />
              </span>
              {r.kana ? (
                <span className="shrink-0 text-sm text-ink3">
                  <Highlight text={r.kana} q={query} />
                </span>
              ) : null}
              <span aria-hidden="true" className="shrink-0 text-ink3">
                ›
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// 本文・記入者の結果（3状態）
// ══════════════════════════════════════════════════════════════

interface NoteResultsProps {
  result: NoteResult
  query: string
  target: Target
  tooShort: boolean
  period: PeriodKey
  residentById: Map<number, Resident>
  staffById: Map<number, string>
  onWidenPeriod: () => void
  onRetry: () => void
}

function NoteResults({
  result,
  query,
  target,
  tooShort,
  period,
  residentById,
  staffById,
  onWidenPeriod,
  onRetry,
}: NoteResultsProps) {
  if (tooShort) {
    return <p className="text-base text-ink2">{HINT[target]}</p>
  }
  if (result.status === 'loading') return <LoadingBlock label="検索中です…" />
  if (result.status === 'error') {
    return <ErrorBlock message={result.error ?? ERR_SEARCH} onRetry={onRetry} />
  }
  if (result.status === 'idle') {
    return <p className="text-base text-ink2">{HINT[target]}</p>
  }
  if (result.notes.length === 0) {
    // すでに全期間なら「広げる」導線は出さない（押せない案内を作らない）
    return period === 'all' ? (
      <EmptyBlock message="該当する記録がありません。別の語や言い回しでお試しください。" />
    ) : (
      <EmptyBlock
        message="該当する記録がありません。期間を広げるか、別の語をお試しください。"
        actionLabel="期間を全期間に広げる"
        onAction={onWidenPeriod}
      />
    )
  }

  return (
    <>
      <p role="status" aria-live="polite" className="mb-2 text-base text-ink2">
        <span className="tabular font-bold text-ink">{result.notes.length}</span> 件
        {result.truncated ? '以上（新しい順に50件まで表示しています。期間や語を絞ってください）' : ''}
      </p>
      <ul className="space-y-2">
        {result.notes.map((n) => (
          <NoteResultCard
            key={n.id}
            note={n}
            resident={n.resident_id == null ? undefined : residentById.get(n.resident_id)}
            reporterName={n.reporter_id == null ? null : (staffById.get(n.reporter_id) ?? null)}
            bodyQuery={target === 'body' ? query : ''}
            reporterQuery={target === 'reporter' ? query : ''}
          />
        ))}
      </ul>
    </>
  )
}
