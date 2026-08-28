// スプシ風10日タイムライン（docs/design/ui-design.md §2/§3）。
// 日付逆順に「1日=1セクション」で並べ、sticky 日付ヘッダ・サマリチップ・ピン留め・申し送りカード・
// 外出ブロック・バイタル・食事の順に描画する。追加読み込みは IntersectionObserver（rootMargin 600px）。
//
// この画面の規律:
//   - 読み取り経路から書き込まない。既読付与は「本文を開く」「既読にする」の明示操作のみ（multi-device-sync 原則9）
//   - 覗き見配慮: 本文は2行clamp・バイタル/食事は既定で異常者のみ。全員表は明示操作で展開する
//   - 入力封鎖中（native_input_enabled=false）は入力導線を隠さずディセーブル＋理由文
//   - supabase へは触れず db.ts の関数だけを呼ぶ。個人情報を console・localStorage に出さない

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Chip,
  ConfirmDialog,
  LevelCell,
  SectionCard,
  LoadingBlock,
  ErrorBlock,
  EmptyBlock,
  useToast,
} from '../components/ui'
import { useTimeline } from '../hooks/useTimeline'
import {
  DbError,
  endOngoingNote,
  fetchNoteReaders,
  fetchResidents,
  fetchStaff,
  getNativeInputEnabled,
  markRead,
  setOutingEnd,
  softDeleteNote,
  updateNote,
} from '../lib/db'
import { getActorId, touchActivity } from '../lib/actor'
import { fmtDayLabel, fmtTimeHM } from '../lib/format'
import {
  IMPORTANCE_LABEL,
  MEAL_SLOT_LABEL,
  MEAL_STATUS_LABEL,
  OUTING_KIND_LABEL,
  SHIFT_LABEL,
  diaBpLevel,
  isLowIntake,
  pulseLevel,
  spo2Level,
  sysBpLevel,
  tempLevel,
  vitalHasAlert,
} from '../lib/types'
import type {
  DayData,
  Meal,
  MealSlot,
  Note,
  Outing,
  Resident,
  Shift,
  Staff,
  Vital,
  VitalKind,
} from '../lib/types'

// ── 定数 ──────────────────────────────────────────────

const SHIFT_ORDER: Shift[] = ['day', 'daycare', 'night']
const MEAL_ORDER: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack']
const VITAL_KIND_LABEL: Record<VitalKind, string> = {
  routine: '定時',
  recheck: '再検',
  observation: '経過観察',
  symptom: '他症状',
}

/** 入力封鎖中（切替日D前）の理由文。ui-design.md §0.5 の定型文をそのまま使う */
const BLOCKED_REASON = '現在はスプレッドシートで記録する期間です（アプリ入力の開始日は施設で決定します）'

/** 申し送りへの操作（継続終了・削除・本文の訂正）の結果 */
type NoteActionResult = { ok: true } | { ok: false; message: string }

const ERR_NOTE_CONFLICT =
  '他の端末で先に更新されました。入力は消えていません。画面を再読み込みして最新の内容を確認してから、もう一度お試しください'
const ERR_NOTE_ACTION =
  '操作できませんでした（通信エラー）。電波状態を確認して、もう一度お試しください。記録は変わっていません'
const ERR_NOTE_EMPTY = '本文が空です。内容を入力してから保存してください'
const NO_ACTOR_REASON = '記録する職員が選ばれていません。画面上部の「記録者」から選んでください'

/** 参照の同一性を保つための空配列（React.memo の無効化を防ぐ） */
const NO_RESIDENTS: Resident[] = []
const NO_STAFF: Staff[] = []

/**
 * 氏名リンク（カルテを開くボタン）の縦ヒット領域を 44px 以上にする追加クラス。
 * 行の見た目の高さは変えずに、擬似要素 ::before を上下 10px ずつはみ出させる
 * （Chip・KartePage・SearchPage と同じ手法。本文 text-base の行高は約25px なので 25+20=45px）。
 * 横方向は広げないので、gap-2（8px）で並べた隣の要素とヒットが重ならない。
 */
const NAME_HIT = 'relative before:absolute before:inset-x-0 before:-inset-y-2.5'

/**
 * 「✓既読 n」の縦ヒット拡張。text-sm（15px・行高1.55≒23px）なので上下 12px ずつで 47px。
 * 同じ行の「既読にする」ボタン（44px）と隣り合うが、拡張するのは縦だけなので
 * gap-gap（8px）の横の間隔は保たれる。
 */
const READ_HIT = 'relative before:absolute before:inset-x-0 before:-inset-y-3'

// ── 小さなヘルパ（純関数・この画面専用）────────────────────

/** 日内ブロックのアンカーid。日付とブロック名だけで構成し、氏名・記録本文を含めない */
function anchorId(day: string, block: string): string {
  return `cl-${day}-${block}`
}

/** timestamptz（継続の期限）→ 「8/31」。壊れた値は空文字（表示を落とすだけで画面は壊さない） */
function fmtStampDay(stamp: string | null): string {
  if (!stamp) return ''
  const d = new Date(stamp)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 利用者の表示名。マスタ未取得時も氏名を作らず ID 表記に落とす */
function residentName(r: Resident | undefined, id: number | null): string {
  if (r) return r.name
  return id == null ? '' : `利用者ID ${id}`
}

function roomText(r: Resident | undefined): string {
  return r?.room ?? '—'
}

/** 発熱（注意高値以上）の判定。色だけでなく件数の根拠を1か所に集約する */
function isFever(v: Vital): boolean {
  const lv = tempLevel(v.temp)
  return lv === 'warn-high' || lv === 'danger-high'
}

/** 欠食（喫食以外の状態＝外出・入院・拒食） */
function isAbsentMeal(m: Meal): boolean {
  return !!m.status && m.status !== 'eaten'
}

/**
 * 日付ヘッダを貼り付ける位置（ui-design.md §2「sticky top: ヘッダ高」）。
 * アプリ側シェルが CSS 変数 --cl-header-h を定義していればそれを使い、
 * 無ければスティッキーなシェルヘッダの実高さを測る（測れなければ 0＝画面最上部）。
 */
function measureStickyTop(): string {
  if (typeof document === 'undefined') return '0px'
  const declared = getComputedStyle(document.documentElement).getPropertyValue('--cl-header-h').trim()
  if (declared) return declared
  const el = findShellHeader()
  const h = el ? Math.round(el.getBoundingClientRect().height) : 0
  return `${h}px`
}

/** シェル側の固定ヘッダ要素。自分（日付ヘッダ）は除外する */
function findShellHeader(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  for (const el of Array.from(document.querySelectorAll('header'))) {
    if (el.closest('.day-section')) continue
    const pos = getComputedStyle(el).position
    if (pos === 'sticky' || pos === 'fixed') return el
  }
  return null
}

/** prefers-reduced-motion を尊重したスクロール移動＋フォーカス移動 */
function scrollToBlock(id: string): void {
  if (typeof document === 'undefined') return
  const el = document.getElementById(id)
  if (!el) return
  const reduce =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  el.focus({ preventScroll: true })
}

// ── ページ本体 ─────────────────────────────────────────

export interface TimelinePageProps {
  /** 操作者（記入者）の staff_id。未指定なら localStorage（actor.ts）から解決する */
  actorId?: number | null
  /** 利用者マスタ。未指定ならこの画面で取得する（居室・氏名の表示にのみ使う） */
  residents?: Resident[]
  /** 職員マスタ。未指定ならこの画面で取得する（記入者名の表示にのみ使う） */
  staff?: Staff[]
  /** 入力解禁フラグ。未指定ならこの画面で取得する（取得失敗は安全側＝封鎖） */
  nativeInputEnabled?: boolean
}

export function TimelinePage({
  actorId: actorIdProp,
  residents: residentsProp,
  staff: staffProp,
  nativeInputEnabled: inputEnabledProp,
}: TimelinePageProps = {}) {
  const navigate = useNavigate()
  const { toast, show } = useToast()

  // 操作者: 親から渡されればそれを使い、無ければ保持中の staff_id を読む
  const actorId = useMemo(
    () => (actorIdProp !== undefined ? actorIdProp : getActorId()),
    [actorIdProp],
  )

  const { days, loading, error, loadMore, hasMore, refresh, trimmed, resetToLatest } =
    useTimeline(actorId)

  // 利用者マスタ（氏名・居室の表示用）
  const [loadedResidents, setLoadedResidents] = useState<Resident[] | null>(null)
  const [residentsError, setResidentsError] = useState(false)
  const [residentsReload, setResidentsReload] = useState(0)

  useEffect(() => {
    if (residentsProp !== undefined) return
    let alive = true
    setResidentsError(false)
    fetchResidents()
      .then((rows) => {
        if (alive) setLoadedResidents(Array.isArray(rows) ? rows : [])
      })
      .catch(() => {
        // 失敗しても画面は成立させる（氏名・居室が出ない状態＋再試行導線）
        if (alive) setResidentsError(true)
      })
    return () => {
      alive = false
    }
  }, [residentsProp, residentsReload])

  const residents = residentsProp ?? loadedResidents ?? NO_RESIDENTS

  const residentById = useMemo(() => {
    const m = new Map<number, Resident>()
    for (const r of residents) m.set(r.id, r)
    return m
  }, [residents])

  // 職員マスタ（記入者名の表示用）。取れなくても「記入者ID n」に落として画面は成立させる
  const [loadedStaff, setLoadedStaff] = useState<Staff[] | null>(null)
  useEffect(() => {
    if (staffProp !== undefined) return
    let alive = true
    fetchStaff()
      .then((rows) => {
        if (alive) setLoadedStaff(Array.isArray(rows) ? rows : [])
      })
      .catch(() => {
        if (alive) setLoadedStaff([])
      })
    return () => {
      alive = false
    }
  }, [staffProp])

  const staffById = useMemo(() => {
    const m = new Map<number, string>()
    for (const s of staffProp ?? loadedStaff ?? NO_STAFF) m.set(s.id, s.name)
    return m
  }, [staffProp, loadedStaff])

  // 入力解禁フラグ（前提情報は毎回取り直す。取得できないときは封鎖側に倒す）
  const [loadedInputEnabled, setLoadedInputEnabled] = useState(false)
  useEffect(() => {
    if (inputEnabledProp !== undefined) return
    let alive = true
    getNativeInputEnabled()
      .then((v) => {
        if (alive) setLoadedInputEnabled(v === true)
      })
      .catch(() => {
        if (alive) setLoadedInputEnabled(false)
      })
    return () => {
      alive = false
    }
  }, [inputEnabledProp])

  const inputEnabled = inputEnabledProp ?? loadedInputEnabled

  // 日セクションへ渡すコールバックは同一性を保つ（60日ぶんの再描画を避けるため）。
  // toast の show・useTimeline の refresh を ref 経由で呼び、依存配列を空に保つ。
  const showRef = useRef(show)
  showRef.current = show
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  const notify = useCallback((message: string) => {
    showRef.current(message)
  }, [])

  const handleOpenKarte = useCallback(
    (residentId: number) => {
      navigate(`/karte/${residentId}`)
    },
    [navigate],
  )

  const handleNewNote = useCallback(() => {
    navigate('/record/note')
  }, [navigate])

  /** db.ts の例外を画面に出せる日本語へ（DbError は「何が起きた＋次にどうする」を持っている） */
  const failure = useCallback((e: unknown): NoteActionResult => {
    return { ok: false, message: e instanceof DbError && e.message ? e.message : ERR_NOTE_ACTION }
  }, [])

  /**
   * 継続申し送りの終了（ended_at だけを書く部分更新）。
   * これを実行するまで、期限を空にした継続はピン留めに再掲され続ける。
   */
  const handleEndOngoing = useCallback(
    async (note: Note): Promise<NoteActionResult> => {
      try {
        const res = await endOngoingNote(note.id, note.rev)
        if (res === 'conflict') return { ok: false, message: ERR_NOTE_CONFLICT }
        touchActivity()
        showRef.current('継続を終了しました。翌日からの再掲を止めます')
        refreshRef.current()
        return { ok: true }
      } catch (e) {
        return failure(e)
      }
    },
    [failure],
  )

  /** 申し送りの削除（論理削除。記録は消さずに非表示へ）。確認ダイアログの後ろでのみ呼ぶ */
  const handleDeleteNote = useCallback(
    async (note: Note): Promise<NoteActionResult> => {
      try {
        const res = await softDeleteNote(note.id, note.rev)
        if (res === 'conflict') return { ok: false, message: ERR_NOTE_CONFLICT }
        touchActivity()
        showRef.current('申し送りを削除しました')
        refreshRef.current()
        return { ok: true }
      } catch (e) {
        return failure(e)
      }
    },
    [failure],
  )

  /** 申し送り本文の訂正。body だけを送り、他の項目はサーバーの値を温存する（部分更新） */
  const handleUpdateNoteBody = useCallback(
    async (note: Note, body: string): Promise<NoteActionResult> => {
      if (body.trim() === '') return { ok: false, message: ERR_NOTE_EMPTY }
      try {
        const res = await updateNote(note.id, note.rev, { body })
        if (res === 'conflict') return { ok: false, message: ERR_NOTE_CONFLICT }
        if (res === 'queued') {
          showRef.current('通信できないため送信待ちにしました。電波が戻ると自動で送信します')
          return { ok: true }
        }
        touchActivity()
        showRef.current('本文を直しました')
        refreshRef.current()
        return { ok: true }
      } catch (e) {
        return failure(e)
      }
    },
    [failure],
  )

  /** 帰着の後追い記入。end 以外のフィールドを送らない（部分更新・multi-device-sync 原則3） */
  const handleSaveOutingEnd = useCallback(
    async (outing: Outing, endOn: string, endAt: string | null): Promise<'ok' | 'conflict' | 'error'> => {
      try {
        const res = await setOutingEnd(outing.id, outing.rev, endOn, endAt)
        if (res === 'conflict') return 'conflict'
        touchActivity()
        showRef.current('帰着を記録しました')
        refreshRef.current()
        return 'ok'
      } catch {
        return 'error'
      }
    },
    [],
  )

  // 日付ヘッダの貼り付け位置（シェルヘッダの高さぶん下げる）。
  // 画面幅・未送信件数などでヘッダ高が変わるため、リサイズと ResizeObserver で追従する。
  const [stickyTop, setStickyTop] = useState('0px')
  useEffect(() => {
    if (typeof window === 'undefined') return
    const apply = () => setStickyTop(measureStickyTop())
    apply()
    window.addEventListener('resize', apply)
    let ro: ResizeObserver | null = null
    const shell = findShellHeader()
    if (shell && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(apply)
      ro.observe(shell)
    }
    return () => {
      window.removeEventListener('resize', apply)
      ro?.disconnect()
    }
  }, [])

  // 追加読み込み（IntersectionObserver・rootMargin 600px）。
  // キーボード操作・非対応環境のために「さらに読み込む」ボタンも併置する。
  // 失敗したら自動での再試行はしない（error の間は監視を張らない）。張ったままだと
  // 検知点が画面内に残るかぎり失敗し続ける通信を繰り返し、電池と回線を空回りで消費する。
  // 再開は職員の明示操作（「再試行」「さらに10日分を読み込む」）だけにする。
  // どちらも useTimeline 側で error を消してから取得し直すため、この effect が張り直される。
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!hasMore || loading || error) return
    if (typeof IntersectionObserver === 'undefined') return
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore()
      },
      { rootMargin: '600px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loading, error, loadMore])

  const showInitialLoading = loading && days.length === 0
  const showInitialError = !!error && days.length === 0
  const showEmpty = !loading && !error && days.length === 0

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-8">
      {/* 入力封鎖中の理由（隠さずに理由を出す。閲覧・検索・カルテは全機能有効） */}
      {!inputEnabled && (
        <p
          id="cl-blocked-reason"
          className="mt-3 rounded-md border border-border bg-info-bg px-3 py-3 text-sm text-ink2"
        >
          <span aria-hidden="true">ⓘ </span>
          {BLOCKED_REASON}
        </p>
      )}

      {/* 利用者マスタが取れなかった場合（タイムライン自体は表示を続ける） */}
      {residentsError && (
        <div className="mt-3 rounded-md border border-warn bg-warn-bg px-3 py-3 text-sm text-ink">
          <p>
            <span aria-hidden="true">▲ </span>
            利用者名を読み込めませんでした（通信エラー）。氏名・居室が表示されない状態です。電波状態を確認して再試行してください。
          </p>
          <button
            type="button"
            className="mt-2 min-h-tap rounded-md border border-border-strong px-3 text-base text-ink"
            onClick={() => setResidentsReload((n) => n + 1)}
          >
            利用者名を再読み込み
          </button>
        </div>
      )}

      {/* DOM上限60日で新しい側を落としている状態からの復帰 */}
      {trimmed && (
        <button
          type="button"
          className="mt-3 w-full min-h-tap rounded-md border border-border-strong bg-surface px-3 text-base text-link"
          onClick={resetToLatest}
        >
          これより新しい日を再読み込み
        </button>
      )}

      {/* 既存の表示を保ったまま出す通信エラー（再取得の導線つき） */}
      {!!error && days.length > 0 && (
        <div className="mt-3 rounded-md border border-warn bg-warn-bg px-3 py-3 text-sm text-ink">
          <p>
            <span aria-hidden="true">▲ </span>
            最新の記録を取得できませんでした（通信エラー）。表示中の内容は取得済みの分です。電波状態を確認して再試行してください。
          </p>
          <button
            type="button"
            className="mt-2 min-h-tap rounded-md border border-border-strong px-3 text-base text-ink"
            onClick={refresh}
          >
            再試行
          </button>
        </div>
      )}

      {showInitialLoading && <LoadingBlock label="タイムラインを読み込んでいます…" />}

      {showInitialError && (
        <ErrorBlock
          message="タイムラインを表示できませんでした（通信エラー）。電波状態を確認して、再試行してください。"
          onRetry={refresh}
        />
      )}

      {showEmpty && (
        <EmptyBlock
          message="表示できる記録がありません。まだ取り込みが行われていないか、この期間に記録が無い可能性があります。"
          actionLabel="再読み込み"
          onAction={refresh}
        />
      )}

      {days.map((day) => (
        <DaySection
          key={day.day}
          day={day}
          residents={residents}
          residentById={residentById}
          staffById={staffById}
          actorId={actorId}
          inputEnabled={inputEnabled}
          stickyTop={stickyTop}
          onOpenKarte={handleOpenKarte}
          onNewNote={handleNewNote}
          onSaveOutingEnd={handleSaveOutingEnd}
          onEndOngoing={handleEndOngoing}
          onDeleteNote={handleDeleteNote}
          onUpdateNoteBody={handleUpdateNoteBody}
          onNotify={notify}
        />
      ))}

      {/* 追加読み込みの検知点＋手動フォールバック */}
      <div ref={sentinelRef} aria-hidden="true" className="h-1" />
      {hasMore && (
        <div className="mt-3">
          {loading && days.length > 0 ? (
            <LoadingBlock label="さらに読み込んでいます…" />
          ) : (
            <button
              type="button"
              className="w-full min-h-tap rounded-md border border-border-strong bg-surface px-3 text-base text-link"
              onClick={loadMore}
            >
              さらに10日分を読み込む
            </button>
          )}
        </div>
      )}
      {!hasMore && days.length > 0 && (
        <p className="mt-3 text-center text-sm text-ink3">これ以上さかのぼる記録はありません</p>
      )}

      {toast}
    </div>
  )
}

export default TimelinePage

// ── 1日ぶんのセクション ────────────────────────────────

interface DaySectionProps {
  day: DayData
  residents: Resident[]
  residentById: Map<number, Resident>
  /** 記入者名の解決用（staff_id → 氏名） */
  staffById: Map<number, string>
  actorId: number | null
  inputEnabled: boolean
  /** 日付ヘッダを貼り付ける top 値（シェルヘッダの高さ） */
  stickyTop: string
  onOpenKarte: (residentId: number) => void
  onNewNote: () => void
  onSaveOutingEnd: (o: Outing, endOn: string, endAt: string | null) => Promise<'ok' | 'conflict' | 'error'>
  onEndOngoing: (note: Note) => Promise<NoteActionResult>
  onDeleteNote: (note: Note) => Promise<NoteActionResult>
  onUpdateNoteBody: (note: Note, body: string) => Promise<NoteActionResult>
  onNotify: (message: string) => void
}

// 展開・既読の状態は「その日」の中に閉じ込める。
// 1タップで60日ぶんが再描画されるのを避けるため、React.memo と併用する（描画目標 60fps）。
const DaySection = memo(function DaySection(props: DaySectionProps) {
  const {
    day,
    residents,
    residentById,
    staffById,
    actorId,
    inputEnabled,
    stickyTop,
    onOpenKarte,
    onNewNote,
    onSaveOutingEnd,
    onEndOngoing,
    onDeleteNote,
    onUpdateNoteBody,
    onNotify,
  } = props

  const iso = day.day
  const imported = day.importDay != null

  // 展開状態・既読の楽観反映（どちらも localStorage に保存しない）
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set<number>())
  // 展開状態は「現在値から次を作る」ため ref にも持つ（setState の updater を純粋関数に保つ）
  const expandedRef = useRef<ReadonlySet<number>>(expanded)
  const [readLocal, setReadLocal] = useState<ReadonlySet<number>>(() => new Set<number>())

  // 既読判定（サーバ値 or この画面で付けた既読）。操作者未確定なら未読表示を出さない
  const isRead = useCallback(
    (n: Note) => n.my_read === true || readLocal.has(n.id),
    [readLocal],
  )

  /** 既読付与。明示操作（本文を開く・既読にする）からのみ呼ぶ */
  const onMarkRead = useCallback(
    (note: Note) => {
      if (actorId == null) return
      if (note.my_read === true || readLocal.has(note.id)) return
      // 先に画面へ反映し、失敗したら戻す（誤既読を残さない）
      setReadLocal((prev) => new Set(prev).add(note.id))
      touchActivity()
      markRead(note.id, actorId).catch(() => {
        setReadLocal((prev) => {
          const next = new Set(prev)
          next.delete(note.id)
          return next
        })
        onNotify('既読にできませんでした（通信エラー）。電波状態を確認して、もう一度お試しください')
      })
    },
    [actorId, readLocal, onNotify],
  )

  const onToggleExpand = useCallback(
    (note: Note) => {
      // updater の中で外側の変数を書き換えない（updater は純粋関数であることが要求され、
      // 同期実行される保証が無い＝本文を開いても既読が付かない経路になり得る）。
      // 現在値（ref）から開閉を決め、ref と state を同時に進める
      const opening = !expandedRef.current.has(note.id)
      const next = new Set(expandedRef.current)
      if (opening) next.add(note.id)
      else next.delete(note.id)
      expandedRef.current = next
      setExpanded(next)
      // 本文を開く操作＝明示操作なので既読を付ける（閉じる操作では付けない）
      if (opening) onMarkRead(note)
    },
    [onMarkRead],
  )

  const summary = useMemo(() => {
    const unread = actorId == null ? 0 : day.notes.filter((n) => !(n.my_read === true || readLocal.has(n.id))).length
    const feverIds = new Set<number>()
    const measuredIds = new Set<number>()
    for (const v of day.vitals) {
      measuredIds.add(v.resident_id)
      if (isFever(v)) feverIds.add(v.resident_id)
    }
    const lowIds = new Set<number>()
    for (const m of day.meals) if (isLowIntake(m)) lowIds.add(m.resident_id)
    const outingIds = new Set<number>()
    for (const o of day.outings) outingIds.add(o.resident_id)
    const unmeasured = residents.length > 0 ? residents.filter((r) => !measuredIds.has(r.id)).length : null
    return {
      noteCount: day.notes.length,
      unread,
      fever: feverIds.size,
      low: lowIds.size,
      outing: outingIds.size,
      unmeasured,
    }
  }, [actorId, day.notes, day.vitals, day.meals, day.outings, readLocal, residents])

  // ピン留め枠に出す行: ①その日に有効な継続（day.pinned）②その日の最重要（‼）
  // ui-design.md §2「重要度=最重要 or 継続フラグ有効中のみ表示」／PLAN.md 設計2「‼最重要・継続」。
  // 最重要は通常リストにも出る（継続と同じく重複表示は意図どおり）。
  // 「継続を終了」は継続の行にだけ出す（最重要なだけの申し送りには終了する対象が無い）
  const pinnedRows = useMemo(() => {
    const ongoingIds = new Set(day.pinned.map((n) => n.id))
    const criticals = day.notes
      .filter((n) => n.importance === 'critical' && !ongoingIds.has(n.id))
      .sort((a, b) => (a.occurred_at ?? '').localeCompare(b.occurred_at ?? '') || a.id - b.id)
    return [
      ...day.pinned.map((note) => ({ note, ongoing: true })),
      ...criticals.map((note) => ({ note, ongoing: false })),
    ]
  }, [day.pinned, day.notes])

  // 勤務帯ごとの申し送り（時刻→id の安定順）
  const notesByShift = useMemo(() => {
    const sorted = day.notes.slice().sort((a, b) => {
      const t = (a.occurred_at ?? '').localeCompare(b.occurred_at ?? '')
      return t !== 0 ? t : a.id - b.id
    })
    return SHIFT_ORDER.map((shift) => ({
      shift,
      notes: sorted.filter((n) => n.shift === shift),
    })).filter((g) => g.notes.length > 0)
  }, [day.notes])

  return (
    <section
      className="day-section mt-4"
      aria-labelledby={`${anchorId(iso, 'head')}-title`}
    >
      {/* 日付ヘッダ（sticky）。シェルヘッダの高さぶん下げて貼り付ける（measureStickyTop） */}
      <header
        id={anchorId(iso, 'head')}
        className={`sticky z-10 border-b-2 border-border-strong px-3 py-2 ${
          imported ? 'bg-surface2' : 'bg-warn-bg'
        }`}
        style={{ top: stickyTop }}
      >
        <div className="flex flex-wrap items-center gap-gap">
          <h2
            id={`${anchorId(iso, 'head')}-title`}
            className="text-lg font-heavy text-ink tabular"
          >
            {fmtDayLabel(iso)}
          </h2>
          {imported ? (
            <Chip tone="ok">✓ 取込済</Chip>
          ) : (
            <Chip tone="warn">
              <span aria-hidden="true">▲ </span>未取込
              <span className="sr-only">（この日のデータはまだ取り込まれていません）</span>
            </Chip>
          )}
          <span className="grow" />
          <button
            type="button"
            className="min-h-tap rounded-md border border-border-strong bg-surface px-3 text-base text-link disabled:text-ink3"
            onClick={onNewNote}
            disabled={!inputEnabled}
            aria-describedby={inputEnabled ? undefined : 'cl-blocked-reason'}
            title={inputEnabled ? undefined : BLOCKED_REASON}
          >
            ＋申し送り
          </button>
        </div>

        {/* サマリチップ列（タップで該当ブロックへ移動） */}
        <div className="mt-2 flex flex-wrap items-center gap-gap">
          <Chip
            tone={summary.unread > 0 ? 'accent' : 'plain'}
            onClick={() => scrollToBlock(anchorId(iso, 'notes'))}
          >
            {`申し送り ${summary.noteCount}件`}
            {actorId != null && summary.unread > 0 ? `（未読${summary.unread}）` : ''}
          </Chip>
          {summary.fever > 0 && (
            <Chip tone="warn" onClick={() => scrollToBlock(anchorId(iso, 'vitals'))}>
              {`▲発熱 ${summary.fever}名`}
            </Chip>
          )}
          {summary.low > 0 && (
            <Chip tone="warn" onClick={() => scrollToBlock(anchorId(iso, 'meals'))}>
              {`▲低摂取 ${summary.low}名`}
            </Chip>
          )}
          {summary.outing > 0 && (
            <Chip tone="info" onClick={() => scrollToBlock(anchorId(iso, 'outings'))}>
              {`外出 ${summary.outing}名`}
            </Chip>
          )}
          {summary.unmeasured != null && summary.unmeasured > 0 && (
            <Chip tone="plain" onClick={() => scrollToBlock(anchorId(iso, 'vitals'))}>
              {`— 未測定 ${summary.unmeasured}名`}
            </Chip>
          )}
        </div>
      </header>

      {/* ピン留め（その日時点で有効だった継続・その日の最重要） */}
      {pinnedRows.length > 0 && (
        <div className="mt-2 rounded-md border-l-4 border-warn bg-warn-bg px-3 py-2">
          <h3 className="text-sm text-ink2">ピン留め（最重要・継続中の申し送り）</h3>
          <ul className="mt-1">
            {pinnedRows.map(({ note: n, ongoing }) => (
              <li key={n.id} className="flex flex-wrap items-center gap-gap py-1">
                <span className="text-base font-bold text-danger" aria-label="最重要または継続">
                  ‼
                </span>
                <span className="text-base font-bold text-ink">
                  {n.resident_id == null
                    ? 'スタッフへ'
                    : residentName(residentById.get(n.resident_id), n.resident_id)}
                </span>
                <span className="min-w-0 grow truncate text-base text-ink">{n.body}</span>
                <span className="text-sm text-ink2 tabular">
                  {ongoing
                    ? n.ended_at
                      ? `継続 〜${fmtStampDay(n.ended_at)}`
                      : '継続中'
                    : '最重要'}
                </span>
                {/* 期限を決めずに登録した継続は、この操作をするまで毎日再掲され続ける */}
                {ongoing && (
                  <EndOngoingButton
                    note={n}
                    inputEnabled={inputEnabled}
                    residentLabel={
                      n.resident_id == null
                        ? 'スタッフへ'
                        : residentName(residentById.get(n.resident_id), n.resident_id)
                    }
                    onEndOngoing={onEndOngoing}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 申し送り */}
      <div id={anchorId(iso, 'notes')} tabIndex={-1} className="mt-2">
        {notesByShift.length === 0 ? (
          <p className="rounded-md bg-surface px-3 py-3 text-base text-ink3">
            {imported ? 'この日の申し送りはありません' : 'この日はまだ取り込まれていません'}
          </p>
        ) : (
          notesByShift.map((group) => (
            <div key={group.shift} className="mt-2">
              <h3 className="px-1 text-sm text-ink3">{SHIFT_LABEL[group.shift]}</h3>
              <ul>
                {group.notes.map((n) => (
                  <li key={n.id} className="mt-2">
                    <NoteCard
                      note={n}
                      resident={n.resident_id == null ? undefined : residentById.get(n.resident_id)}
                      reporterName={
                        n.reporter_id == null ? null : (staffById.get(n.reporter_id) ?? null)
                      }
                      actorId={actorId}
                      inputEnabled={inputEnabled}
                      read={isRead(n)}
                      locallyRead={readLocal.has(n.id)}
                      expanded={expanded.has(n.id)}
                      onToggleExpand={onToggleExpand}
                      onMarkRead={onMarkRead}
                      onOpenKarte={onOpenKarte}
                      onDeleteNote={onDeleteNote}
                      onUpdateNoteBody={onUpdateNoteBody}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>

      {/* 外出・外泊 */}
      {day.outings.length > 0 && (
        <div id={anchorId(iso, 'outings')} tabIndex={-1} className="mt-3">
          <SectionCard title={`外出・外泊 ${summary.outing}名`}>
            <ul>
              {day.outings.map((o) => (
                <li key={o.id} className="border-b border-border last:border-b-0">
                  <OutingRow
                    outing={o}
                    dayIso={iso}
                    resident={residentById.get(o.resident_id)}
                    inputEnabled={inputEnabled}
                    onOpenKarte={onOpenKarte}
                    onSaveEnd={onSaveOutingEnd}
                  />
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      )}

      {/* バイタル */}
      <div id={anchorId(iso, 'vitals')} tabIndex={-1} className="mt-3">
        <VitalsBlock
          vitals={day.vitals}
          residents={residents}
          residentById={residentById}
          imported={imported}
          onOpenKarte={onOpenKarte}
        />
      </div>

      {/* 食事・水分 */}
      <div id={anchorId(iso, 'meals')} tabIndex={-1} className="mt-3">
        <MealsBlock
          day={day}
          residents={residents}
          residentById={residentById}
          imported={imported}
          onOpenKarte={onOpenKarte}
        />
      </div>
    </section>
  )
})

// ── 継続申し送りの終了（ピン留めの再掲を止める）─────────────

interface EndOngoingButtonProps {
  note: Note
  inputEnabled: boolean
  /** 確認ダイアログで「どれを終了するのか」を示すための対象名 */
  residentLabel: string
  onEndOngoing: (note: Note) => Promise<NoteActionResult>
}

function EndOngoingButton({ note, inputEnabled, residentLabel, onEndOngoing }: EndOngoingButtonProps) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setRowError(null)
    const res = await onEndOngoing(note)
    setBusy(false)
    if (!res.ok) setRowError(res.message)
  }

  return (
    <>
      <button
        type="button"
        className="min-h-tap shrink-0 rounded-md border border-danger bg-surface px-3 text-base font-bold text-danger disabled:border-border disabled:text-ink3"
        onClick={() => setAsking(true)}
        disabled={!inputEnabled || busy}
        aria-describedby={inputEnabled ? undefined : 'cl-blocked-reason'}
        title={inputEnabled ? undefined : BLOCKED_REASON}
      >
        {busy ? '終了しています…' : '継続を終了'}
      </button>
      {rowError && (
        <p role="alert" className="w-full text-sm text-danger">
          <span aria-hidden="true">▲ </span>
          {rowError}
        </p>
      )}
      <ConfirmDialog
        open={asking}
        title="この継続申し送りを終了しますか"
        body={`${residentLabel}の継続申し送りです。終了すると、明日からピン留めに再掲されなくなります。申し送りそのものは残ります（消えません）。`}
        confirmLabel="継続を終了する"
        danger
        onConfirm={() => {
          setAsking(false)
          void run()
        }}
        onCancel={() => setAsking(false)}
      />
    </>
  )
}

// ── 申し送りカード ─────────────────────────────────────

interface NoteCardProps {
  note: Note
  resident: Resident | undefined
  /** 記入者名。マスタ未取得・不在は null（「記入者ID n」に落とす） */
  reporterName: string | null
  actorId: number | null
  /** 入力解禁フラグ。false の間は訂正・削除をディセーブル＋理由文にする */
  inputEnabled: boolean
  read: boolean
  locallyRead: boolean
  expanded: boolean
  onToggleExpand: (note: Note) => void
  onMarkRead: (note: Note) => void
  onOpenKarte: (residentId: number) => void
  onDeleteNote: (note: Note) => Promise<NoteActionResult>
  onUpdateNoteBody: (note: Note, body: string) => Promise<NoteActionResult>
}

function NoteCard({
  note,
  resident,
  reporterName,
  actorId,
  inputEnabled,
  read,
  locallyRead,
  expanded,
  onToggleExpand,
  onMarkRead,
  onOpenKarte,
  onDeleteNote,
  onUpdateNoteBody,
}: NoteCardProps) {
  const unread = actorId != null && !read
  const readCount = (note.read_count ?? 0) + (locallyRead && note.my_read !== true ? 1 : 0)
  const bodyId = `cl-note-${note.id}-body`

  // 既読者一覧（開いた時にだけ取りに行く。閉じている間は通信しない）
  const [readersOpen, setReadersOpen] = useState(false)

  // 訂正・削除の状態（展開中だけ操作できる。入力封鎖中・操作者未選択はディセーブル）
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)
  const editId = `cl-note-${note.id}-edit`
  const canEdit = inputEnabled && actorId != null
  const disabledReason = !inputEnabled ? BLOCKED_REASON : actorId == null ? NO_ACTOR_REASON : undefined

  async function submitBody() {
    setBusy(true)
    setRowError(null)
    const res = await onUpdateNoteBody(note, draft)
    setBusy(false)
    if (res.ok) {
      setEditing(false)
      return
    }
    setRowError(res.message) // 入力は消さない（draft はそのまま残す）
  }

  async function submitDelete() {
    setBusy(true)
    setRowError(null)
    const res = await onDeleteNote(note)
    setBusy(false)
    if (!res.ok) setRowError(res.message)
  }

  return (
    <article
      className={`rounded-md bg-surface px-3 py-2 ${unread ? 'border-l-4 border-accent' : ''}`}
    >
      {/* 1行目: 時刻・対象・職種タグ・重要度 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink2 tabular">{fmtTimeHM(note.occurred_at) || '—'}</span>
        {note.resident_id == null ? (
          <span className="text-base text-info">
            <span aria-hidden="true">ⓘ </span>スタッフへ
          </span>
        ) : (
          <button
            type="button"
            className={`${NAME_HIT} rounded-md px-2 text-base font-bold text-link`}
            onClick={() => onOpenKarte(note.resident_id as number)}
            aria-label={`${residentName(resident, note.resident_id)}のカルテを開く`}
          >
            {residentName(resident, note.resident_id)}
          </button>
        )}
        {note.role_tags.map((tag) => (
          <Chip key={tag} tone="plain">
            {tag}
          </Chip>
        ))}
        {note.importance === 'important' && <Chip tone="warn">{IMPORTANCE_LABEL.important}</Chip>}
        {note.importance === 'critical' && <Chip tone="danger">{IMPORTANCE_LABEL.critical}</Chip>}
        {note.ongoing && <Chip tone="info">継続</Chip>}
        {unread && <Chip tone="accent">未読</Chip>}
      </div>

      {/* 2行目: 本文（既定2行clamp・タップで展開＝明示操作。展開状態は保存しない）。
          relative は「氏名リンクの縦ヒット拡張（NAME_HIT）が本文の上端に重ならない」ようにするため
          （位置指定要素どうしは後に書いたこちらが上になる＝本文タップが氏名リンクに吸われない） */}
      <button
        type="button"
        className="relative mt-1 block w-full text-left"
        onClick={() => onToggleExpand(note)}
        aria-expanded={expanded}
        aria-controls={bodyId}
      >
        <span id={bodyId} className={`block text-lg text-ink ${expanded ? '' : 'clamp-2'}`}>
          {note.body}
        </span>
        <span className="mt-1 block text-sm text-link">
          {expanded ? '本文を閉じる' : '本文をすべて表示'}
        </span>
      </button>

      {/* 3行目: 記入者・既読 */}
      <div className="mt-1 flex flex-wrap items-center gap-gap">
        <span className="text-sm text-ink2">
          記入者{' '}
          {note.reporter_id == null
            ? '未記入'
            : (reporterName ?? `ID ${note.reporter_id}`)}
        </span>
        {/* ui-design.md §0/§2「タップで既読者一覧を表示」。開いた時にだけ既読者を取りに行く */}
        <button
          type="button"
          className={`${READ_HIT} rounded-md text-sm text-link tabular`}
          onClick={() => setReadersOpen(true)}
          aria-haspopup="dialog"
          aria-label={`既読 ${readCount}名。既読にした職員の一覧を開く`}
        >
          <span aria-hidden="true">✓</span>既読 {readCount}
        </button>
        {actorId != null &&
          (read ? (
            <span className="text-sm text-ok">
              <span aria-hidden="true">✓ </span>既読済み
            </span>
          ) : (
            <button
              type="button"
              className="min-h-tap rounded-md border border-border-strong px-3 text-base text-ink"
              onClick={() => onMarkRead(note)}
            >
              既読にする
            </button>
          ))}
      </div>

      {/* 4行目: 訂正・削除（本文を開いている時だけ出す。どちらも1タップでは実行しない） */}
      {expanded && (
        <div className="mt-2 border-t border-border pt-2">
          {editing ? (
            <div>
              <label htmlFor={editId} className="block text-sm text-ink2">
                本文を直す
              </label>
              <textarea
                id={editId}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={4}
                className="mt-1 block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-lg text-ink"
              />
              <div className="mt-2 flex flex-wrap gap-gap">
                <button
                  type="button"
                  className="min-h-tap rounded-md bg-primary px-3 text-base font-bold text-primary-ink disabled:opacity-60"
                  onClick={() => void submitBody()}
                  disabled={busy}
                >
                  {busy ? '保存しています…' : '保存する'}
                </button>
                <button
                  type="button"
                  className="min-h-tap rounded-md border border-border-strong px-3 text-base text-ink"
                  onClick={() => {
                    setEditing(false)
                    setDraft(note.body)
                    setRowError(null)
                  }}
                  disabled={busy}
                >
                  やめる
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-gap">
              <button
                type="button"
                className="min-h-tap rounded-md border border-border-strong px-3 text-base text-link disabled:text-ink3"
                onClick={() => {
                  setDraft(note.body)
                  setEditing(true)
                  setRowError(null)
                }}
                disabled={!canEdit || busy}
                title={disabledReason}
              >
                本文を直す
              </button>
              {/* 破壊的操作は塗りつぶしにせず枠線ボタン＋確認ダイアログ */}
              <button
                type="button"
                className="min-h-tap rounded-md border border-danger px-3 text-base font-bold text-danger disabled:border-border disabled:text-ink3"
                onClick={() => setAsking(true)}
                disabled={!canEdit || busy}
                title={disabledReason}
              >
                削除
              </button>
            </div>
          )}
          {rowError && (
            <p role="alert" className="mt-2 text-sm text-danger">
              <span aria-hidden="true">▲ </span>
              {rowError}
            </p>
          )}
          {!canEdit && (
            <p className="mt-2 text-sm text-ink2">
              <span aria-hidden="true">ⓘ </span>
              {disabledReason}
            </p>
          )}
        </div>
      )}

      <ReadersDialog
        open={readersOpen}
        noteId={note.id}
        onClose={() => setReadersOpen(false)}
      />

      <ConfirmDialog
        open={asking}
        title="この申し送りを削除しますか"
        body="削除すると、タイムラインと検索に出なくなります。記録そのものは残しますが、アプリからは戻せません。内容を確認してから実行してください。"
        confirmLabel="削除する"
        danger
        onConfirm={() => {
          setAsking(false)
          void submitDelete()
        }}
        onCancel={() => setAsking(false)}
      />
    </article>
  )
}

// ── 既読者一覧（「✓既読 n」をタップして開く）─────────────────

interface ReadersDialogProps {
  open: boolean
  noteId: number
  onClose: () => void
}

const ERR_READERS =
  '既読の職員を読み込めませんでした（通信エラー）。電波状態を確認して、再試行してください。'

/**
 * 既読にした職員の一覧。開いた時だけ取得する（読み取りのみ・既読は付けない＝原則9）。
 * ローディング・エラー・0件の3状態を持ち、Esc と「閉じる」で閉じられる。
 * 申し送り本文・利用者名は載せない（肩越しの覗き見を想定し、必要最小限の表示にする）。
 */
function ReadersDialog({ open, noteId, onClose }: ReadersDialogProps) {
  const [phase, setPhase] = useState<'loading' | 'error' | 'ready'>('loading')
  const [readers, setReaders] = useState<Staff[]>([])
  const [reload, setReload] = useState(0)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    let alive = true
    setPhase('loading')
    fetchNoteReaders(noteId)
      .then((rows) => {
        if (!alive) return
        setReaders(Array.isArray(rows) ? rows : [])
        setPhase('ready')
      })
      .catch(() => {
        if (alive) setPhase('error')
      })
    return () => {
      alive = false
    }
  }, [open, noteId, reload])

  // 開いたら「閉じる」へフォーカスし、閉じたら元の要素へ戻す。Esc でも閉じる
  useEffect(() => {
    if (!open) return
    const restore = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
    closeRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      restore?.focus?.()
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* 背景の覆い。タブ順には入れず、タップで閉じられるようにする */}
      <button
        type="button"
        aria-label="閉じる"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink opacity-60"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="既読にした職員"
        className="relative flex max-h-full w-full max-w-md flex-col rounded-md border border-border-strong bg-surface"
      >
        <div className="flex items-center justify-between gap-gap border-b border-border p-3">
          <h2 className="text-lg font-bold text-ink">既読にした職員</h2>
          <button
            type="button"
            ref={closeRef}
            onClick={onClose}
            className="min-h-tap min-w-tap shrink-0 rounded-md border border-border-strong px-3 text-base text-ink"
          >
            閉じる
          </button>
        </div>
        <div className="overflow-y-auto p-3">
          {phase === 'loading' && <LoadingBlock label="既読の職員を読み込んでいます…" />}
          {phase === 'error' && (
            <ErrorBlock message={ERR_READERS} onRetry={() => setReload((n) => n + 1)} />
          )}
          {phase === 'ready' && readers.length === 0 && (
            <EmptyBlock message="まだ誰も既読にしていません。" />
          )}
          {phase === 'ready' && readers.length > 0 && (
            <ul>
              {readers.map((s) => (
                <li
                  key={s.id}
                  className="flex min-h-tap items-center border-b border-border px-1 text-base text-ink last:border-b-0"
                >
                  <span aria-hidden="true" className="mr-2 text-ok">
                    ✓
                  </span>
                  {s.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 外出・外泊の行（帰着の後追い記入つき）───────────────────

interface OutingRowProps {
  outing: Outing
  dayIso: string
  resident: Resident | undefined
  inputEnabled: boolean
  onOpenKarte: (residentId: number) => void
  onSaveEnd: (o: Outing, endOn: string, endAt: string | null) => Promise<'ok' | 'conflict' | 'error'>
}

function OutingRow({ outing, dayIso, resident, inputEnabled, onOpenKarte, onSaveEnd }: OutingRowProps) {
  const [open, setOpen] = useState(false)
  const [endOn, setEndOn] = useState(dayIso)
  const [endAt, setEndAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)

  const pending = outing.end_on == null
  const timeRange = `${fmtTimeHM(outing.start_at) || '—'} 〜 ${
    pending
      ? ''
      : `${outing.end_on !== dayIso ? `${fmtDayLabel(outing.end_on as string)} ` : ''}${
          fmtTimeHM(outing.end_at) || '—'
        }`
  }`

  async function submit() {
    if (!endOn) {
      setRowError('帰着日を入力してください')
      return
    }
    setSaving(true)
    setRowError(null)
    const res = await onSaveEnd(outing, endOn, endAt === '' ? null : endAt)
    setSaving(false)
    if (res === 'ok') {
      setOpen(false)
      return
    }
    setRowError(
      res === 'conflict'
        ? '他の端末で先に更新されました。入力は消えていません。画面を再読み込みして最新の内容を確認してから、もう一度記入してください'
        : '保存できませんでした（通信エラー）。電波状態を確認して、もう一度お試しください',
    )
  }

  return (
    <div className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink2 tabular">{roomText(resident)}</span>
        <button
          type="button"
          className={`${NAME_HIT} rounded-md px-2 text-base font-bold text-link`}
          onClick={() => onOpenKarte(outing.resident_id)}
          aria-label={`${residentName(resident, outing.resident_id)}のカルテを開く`}
        >
          {residentName(resident, outing.resident_id)}
        </button>
        <Chip tone="info">{OUTING_KIND_LABEL[outing.kind]}</Chip>
        <span className="text-base text-ink tabular">{timeRange}</span>
        {pending && <Chip tone="warn">帰着未定</Chip>}
        {outing.companion && <span className="text-sm text-ink2">付添 {outing.companion}</span>}
        {pending && (
          <button
            type="button"
            className="min-h-tap rounded-md border border-border-strong px-3 text-base text-link disabled:text-ink3"
            onClick={() => setOpen((v) => !v)}
            disabled={!inputEnabled}
            aria-expanded={open}
            aria-describedby={inputEnabled ? undefined : 'cl-blocked-reason'}
            title={inputEnabled ? undefined : BLOCKED_REASON}
          >
            帰着
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 rounded-md border border-border bg-surface2 px-3 py-2">
          <div className="flex flex-wrap items-end gap-gap">
            <label className="text-sm text-ink2">
              帰着日
              <input
                type="date"
                className="mt-1 block min-h-tap rounded-md border border-border-strong bg-surface px-2 text-base text-ink tabular"
                value={endOn}
                onChange={(e) => setEndOn(e.target.value)}
              />
            </label>
            <label className="text-sm text-ink2">
              帰着時刻（わからなければ空欄）
              <input
                type="time"
                className="mt-1 block min-h-tap rounded-md border border-border-strong bg-surface px-2 text-base text-ink tabular"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="min-h-tap rounded-md bg-primary px-3 text-base text-primary-ink"
              onClick={submit}
              disabled={saving}
            >
              {saving ? '保存中…' : '帰着を記録'}
            </button>
            <button
              type="button"
              className="min-h-tap rounded-md border border-border-strong px-3 text-base text-ink"
              onClick={() => {
                setOpen(false)
                setRowError(null)
              }}
              disabled={saving}
            >
              やめる
            </button>
          </div>
          {rowError && (
            <p role="alert" className="mt-2 text-sm text-danger">
              <span aria-hidden="true">▲ </span>
              {rowError}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── バイタルブロック ───────────────────────────────────

interface VitalsBlockProps {
  vitals: Vital[]
  residents: Resident[]
  residentById: Map<number, Resident>
  imported: boolean
  onOpenKarte: (residentId: number) => void
}

function VitalsBlock({ vitals, residents, residentById, imported, onOpenKarte }: VitalsBlockProps) {
  const [showAll, setShowAll] = useState(false)

  const { alerts, normalCount, unmeasured, primaryByResident } = useMemo(() => {
    const order = new Map<number, number>()
    residents.forEach((r, i) => order.set(r.id, i))
    const measured = new Set<number>()
    const alertIds = new Set<number>()
    const primary = new Map<number, Vital>()
    for (const v of vitals) {
      measured.add(v.resident_id)
      if (vitalHasAlert(v)) alertIds.add(v.resident_id)
      const cur = primary.get(v.resident_id)
      if (!cur || (cur.kind !== 'routine' && v.kind === 'routine')) primary.set(v.resident_id, v)
    }
    const rows = vitals
      .filter(vitalHasAlert)
      .slice()
      .sort((a, b) => {
        const oa = order.get(a.resident_id) ?? Number.MAX_SAFE_INTEGER
        const ob = order.get(b.resident_id) ?? Number.MAX_SAFE_INTEGER
        return oa !== ob ? oa - ob : a.id - b.id
      })
    return {
      alerts: rows,
      normalCount: measured.size - alertIds.size,
      unmeasured: residents.length > 0 ? residents.filter((r) => !measured.has(r.id)).length : null,
      primaryByResident: primary,
    }
  }, [vitals, residents])

  const title =
    `バイタル ▲異常${new Set(alerts.map((v) => v.resident_id)).size}名` +
    `・✓正常${normalCount}名` +
    (unmeasured == null ? '' : `・—未測定${unmeasured}名`)

  return (
    <SectionCard title={title}>
      {vitals.length === 0 ? (
        <p className="text-base text-ink3">
          {imported ? 'この日のバイタル記録はありません' : 'この日はまだ取り込まれていません'}
        </p>
      ) : alerts.length === 0 ? (
        <p className="text-base text-ink2">
          <span aria-hidden="true">✓ </span>しきい値を超えた記録はありません
        </p>
      ) : (
        // 表は横スクロール領域に閉じ込め、狭い画面でページ全体を横にはみ出させない
        <div className="overflow-x-auto">
          <VitalsTable rows={alerts} residentById={residentById} onOpenKarte={onOpenKarte} showKind />
        </div>
      )}

      {residents.length > 0 && (
        <>
          <button
            type="button"
            className="mt-2 min-h-tap rounded-md border border-border-strong px-3 text-base text-link"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
          >
            {showAll ? '全員の表を閉じる' : `全${residents.length}名の表を見る`}
          </button>
          {showAll && (
            <div className="mt-2 overflow-x-auto">
              <VitalsTable
                rows={residents.map((r) => primaryByResident.get(r.id) ?? r.id)}
                residentById={residentById}
                onOpenKarte={onOpenKarte}
                showKind={false}
              />
            </div>
          )}
        </>
      )}
    </SectionCard>
  )
}

/** 行は Vital（記録あり）か resident_id（記録なし＝全セル「—」） */
type VitalRow = Vital | number

interface VitalsTableProps {
  rows: VitalRow[]
  residentById: Map<number, Resident>
  onOpenKarte: (residentId: number) => void
  showKind: boolean
}

function VitalsTable({ rows, residentById, onOpenKarte, showKind }: VitalsTableProps) {
  return (
    <table className="w-full border-collapse text-left">
      <thead>
        <tr className="border-b border-border-strong">
          <th scope="col" className="whitespace-nowrap px-2 py-2 text-xs text-ink2">
            居室
          </th>
          <th scope="col" className="whitespace-nowrap px-2 py-2 text-xs text-ink2">
            氏名
          </th>
          <th scope="col" className="whitespace-nowrap px-2 py-2 text-xs text-ink2">
            体温
          </th>
          <th scope="col" className="whitespace-nowrap px-2 py-2 text-xs text-ink2">
            血圧 上/下
          </th>
          <th scope="col" className="whitespace-nowrap px-2 py-2 text-xs text-ink2">
            脈
          </th>
          <th scope="col" className="whitespace-nowrap px-2 py-2 text-xs text-ink2">
            SpO2
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const v = typeof row === 'number' ? null : row
          const residentId = typeof row === 'number' ? row : row.resident_id
          const r = residentById.get(residentId)
          return (
            <tr key={v ? `v${v.id}` : `r${residentId}`} className="border-b border-border">
              <td className="whitespace-nowrap px-2 py-3 text-sm text-ink2 tabular">{roomText(r)}</td>
              <td className="whitespace-nowrap px-2 py-3 text-base font-bold">
                <button
                  type="button"
                  className={`${NAME_HIT} rounded-md px-1 text-left text-base font-bold text-link`}
                  onClick={() => onOpenKarte(residentId)}
                  aria-label={`${residentName(r, residentId)}のカルテを開く`}
                >
                  {residentName(r, residentId)}
                </button>
                {showKind && v && v.kind !== 'routine' && (
                  <span className="ml-1 text-sm text-ink2">{VITAL_KIND_LABEL[v.kind]}</span>
                )}
              </td>
              <td className="whitespace-nowrap px-2 py-3">
                <LevelCell value={v ? v.temp : null} level={v ? tempLevel(v.temp) : null} digits={1} />
              </td>
              <td className="whitespace-nowrap px-2 py-3">
                <span className="inline-flex items-center gap-1">
                  <LevelCell value={v ? v.sys_bp : null} level={v ? sysBpLevel(v.sys_bp) : null} />
                  <span aria-hidden="true" className="text-sm text-ink3">
                    /
                  </span>
                  <LevelCell value={v ? v.dia_bp : null} level={v ? diaBpLevel(v.dia_bp) : null} />
                </span>
              </td>
              <td className="whitespace-nowrap px-2 py-3">
                <LevelCell value={v ? v.pulse : null} level={v ? pulseLevel(v.pulse) : null} />
              </td>
              <td className="whitespace-nowrap px-2 py-3">
                <LevelCell value={v ? v.spo2 : null} level={v ? spo2Level(v.spo2) : null} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ── 食事・水分ブロック ─────────────────────────────────

interface MealsBlockProps {
  day: DayData
  residents: Resident[]
  residentById: Map<number, Resident>
  imported: boolean
  onOpenKarte: (residentId: number) => void
}

function MealsBlock({ day, residents, residentById, imported, onOpenKarte }: MealsBlockProps) {
  const [showAll, setShowAll] = useState(false)

  const { flagged, lowCount, absentCount, mealIndex, waterByResident, slots } = useMemo(() => {
    const order = new Map<number, number>()
    residents.forEach((r, i) => order.set(r.id, i))
    const low = new Set<number>()
    const absent = new Set<number>()
    const index = new Map<string, Meal>()
    const usedSlots = new Set<MealSlot>()
    for (const m of day.meals) {
      if (isLowIntake(m)) low.add(m.resident_id)
      if (isAbsentMeal(m)) absent.add(m.resident_id)
      index.set(`${m.resident_id}:${m.meal_slot}`, m)
      usedSlots.add(m.meal_slot)
    }
    const water = new Map<number, number>()
    for (const f of day.fluids) {
      water.set(f.resident_id, (water.get(f.resident_id) ?? 0) + (f.amount_ml ?? 0))
    }
    const rows = day.meals
      .filter((m) => isLowIntake(m) || isAbsentMeal(m))
      .slice()
      .sort((a, b) => {
        const oa = order.get(a.resident_id) ?? Number.MAX_SAFE_INTEGER
        const ob = order.get(b.resident_id) ?? Number.MAX_SAFE_INTEGER
        if (oa !== ob) return oa - ob
        return MEAL_ORDER.indexOf(a.meal_slot) - MEAL_ORDER.indexOf(b.meal_slot)
      })
    // 朝昼夕は常に列を出し、間食は記録がある日だけ出す（記録を隠さない）
    const cols = MEAL_ORDER.filter((s) => s !== 'snack' || usedSlots.has('snack'))
    return {
      flagged: rows,
      lowCount: low.size,
      absentCount: absent.size,
      mealIndex: index,
      waterByResident: water,
      slots: cols,
    }
  }, [day.meals, day.fluids, residents])

  const title = `食事・水分 ▲低摂取${lowCount}名・—欠食${absentCount}名`

  return (
    <SectionCard title={title}>
      {day.meals.length === 0 ? (
        <p className="text-base text-ink3">
          {imported ? 'この日の食事記録はありません' : 'この日はまだ取り込まれていません'}
        </p>
      ) : flagged.length === 0 ? (
        <p className="text-base text-ink2">
          <span aria-hidden="true">✓ </span>低摂取・欠食の記録はありません
        </p>
      ) : (
        <ul>
          {flagged.map((m) => {
            const r = residentById.get(m.resident_id)
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-2 border-b border-border py-2 last:border-b-0">
                <span className="text-sm text-ink2 tabular">{roomText(r)}</span>
                <button
                  type="button"
                  className={`${NAME_HIT} rounded-md px-2 text-base font-bold text-link`}
                  onClick={() => onOpenKarte(m.resident_id)}
                  aria-label={`${residentName(r, m.resident_id)}のカルテを開く`}
                >
                  {residentName(r, m.resident_id)}
                </button>
                <span className="text-sm text-ink2">{MEAL_SLOT_LABEL[m.meal_slot]}</span>
                {isAbsentMeal(m) ? (
                  <Chip tone="info">{MEAL_STATUS_LABEL[m.status as 'out']}</Chip>
                ) : (
                  <span className="rounded-sm bg-warn-bg px-2 text-base text-warn tabular">
                    <span aria-hidden="true">▲ </span>
                    主{m.main_amount ?? '—'} / 副{m.side_amount ?? '—'}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {residents.length > 0 && (
        <>
          <button
            type="button"
            className="mt-2 min-h-tap rounded-md border border-border-strong px-3 text-base text-link"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
          >
            {showAll ? '全員の表を閉じる' : `全${residents.length}名の表を見る`}
          </button>
          {showAll && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-border-strong">
                    <th scope="col" className="whitespace-nowrap px-2 py-2 text-xs text-ink2">
                      居室
                    </th>
                    <th scope="col" className="whitespace-nowrap px-2 py-2 text-xs text-ink2">
                      氏名
                    </th>
                    {slots.map((s) => (
                      <th key={s} scope="col" className="whitespace-nowrap px-2 py-2 text-xs text-ink2">
                        {MEAL_SLOT_LABEL[s]} 主/副
                      </th>
                    ))}
                    <th scope="col" className="whitespace-nowrap px-2 py-2 text-xs text-ink2">
                      水分ml
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {residents.map((r) => (
                    <tr key={r.id} className="border-b border-border">
                      <td className="whitespace-nowrap px-2 py-3 text-sm text-ink2 tabular">{roomText(r)}</td>
                      <td className="whitespace-nowrap px-2 py-3">
                        <button
                          type="button"
                          className={`${NAME_HIT} rounded-md px-1 text-left text-base font-bold text-link`}
                          onClick={() => onOpenKarte(r.id)}
                          aria-label={`${r.name}のカルテを開く`}
                        >
                          {r.name}
                        </button>
                      </td>
                      {slots.map((s) => {
                        const m = mealIndex.get(`${r.id}:${s}`)
                        if (!m) {
                          return (
                            <td key={s} className="whitespace-nowrap px-2 py-3 text-base text-ink3">
                              —
                            </td>
                          )
                        }
                        if (isAbsentMeal(m)) {
                          return (
                            <td key={s} className="whitespace-nowrap px-2 py-3 text-base text-info">
                              {MEAL_STATUS_LABEL[m.status as 'out']}
                            </td>
                          )
                        }
                        const low = isLowIntake(m)
                        return (
                          <td key={s} className="whitespace-nowrap px-2 py-3">
                            <span
                              className={`rounded-sm px-1 text-base tabular ${
                                low ? 'bg-warn-bg text-warn' : 'text-ink'
                              }`}
                            >
                              {low && <span aria-hidden="true">▲</span>}
                              {m.main_amount ?? '—'}/{m.side_amount ?? '—'}
                            </span>
                          </td>
                        )
                      })}
                      <td className="whitespace-nowrap px-2 py-3 text-base text-ink tabular">
                        {waterByResident.has(r.id) ? waterByResident.get(r.id) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </SectionCard>
  )
}
