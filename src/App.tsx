/**
 * ケアログ シェル（ルーティング・3ゲート）。
 *
 * 責務（docs/design/contracts.md「App.tsx の責務」）:
 *   ①接続未設定ゲート（VITE_SUPABASE_URL / ANON_KEY が無くても白画面にしない）
 *   ②認証ゲート（useAuth: 未ready=ローディング／未ログイン=/login）
 *   ③入力解禁フラグ（getNativeInputEnabled を起動時と記録画面に入るたび取り直し、既知値として各画面へ渡す。
 *     封鎖中の理由文とディセーブル表示は各記録画面が自前で持つので、ここでは重ねない。
 *     ここで渡せるのは値だけで「観測できたか」は渡せない＝取得に失敗した時も false を渡す。
 *     そのため**セル直接編集を持つ一覧（日報・バイタル・食事）は自前で getNativeInputGate を呼び直し**、
 *     「封鎖」と「観測できなかった（通信エラー）」を自分で区別する。この prop は初期値として使う）
 *   ④操作者ゲート（resolveActor 失敗 or shouldReconfirm で StaffPickerModal）
 *   ⑤シェル（スティッキーヘッダ＝画面名・未送信n件・操作者チップ／
 *     タブ＝<1024px下部5つ・≥1024px左レール8つ。sheet-contracts.md §2）
 *     ※表示倍率（ZoomBar）は各シート画面の操作バーが1つだけ持つ（二重表示にしない）
 *
 * 読み込み方式について:
 *   src/lib/supabase.ts は createClient() を module scope で実行するため、接続未設定だと
 *   「読み込んだ瞬間に例外」になる（supabase-js の validateSupabaseUrl が空文字で throw）。
 *   そのため本ファイルは supabase に依存するモジュール（db / actor / ui / useAuth / 各ページ）を
 *   一切 static import せず、すべて動的 import（React.lazy）で遅延読込する。
 *   これで接続未設定でもバンドルの評価が通り、案内画面を描画できる。
 */
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
// スプシ模倣UIの寸法変数（--sheet-*）。本来は main.tsx / index.css で読むのが筋だが、
// main.tsx が変更禁止のため暫定でここから読み込む（index.css への移設は積み残し）。
import './styles/sheet.css'
import {
  HashRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import { LS } from './lib/types'
import type { Staff } from './lib/types'

// ── 接続設定（VITE_ 変数）──────────────────────────────────────────
// 型は src/vite-env.d.ts（vite/client）で付くが、未設定・非 Vite 実行でも落ちないようキャスト経由で読む。
// Vite が `import.meta.env` をビルド時に実体へ置換するので、この書き方でも値は焼き込まれる
// （未設定時は空オブジェクト → 空文字 → 接続未設定画面）。
type ViteEnv = { env?: Record<string, string | undefined> }
const VITE = (import.meta as unknown as ViteEnv).env ?? {}
const SUPABASE_URL = VITE.VITE_SUPABASE_URL ?? ''
const SUPABASE_KEY = VITE.VITE_SUPABASE_ANON_KEY ?? ''
// createClient は http(s) 以外の URL でも throw するため、形式まで見てから通す
const SUPABASE_CONFIGURED = /^https?:\/\//i.test(SUPABASE_URL.trim()) && SUPABASE_KEY.trim() !== ''

// ── 遅延読込するモジュール群（supabase 依存）────────────────────────
type Deps = {
  db: typeof import('./lib/db')
  actor: typeof import('./lib/actor')
  ui: typeof import('./components/ui')
  sheet: typeof import('./components/sheet')
  useAuth: (typeof import('./hooks/useAuth'))['useAuth']
}

// スプシ模倣の一覧（sheet-contracts.md §2）
const DailySheetPage = lazy(() =>
  import('./pages/DailySheetPage').then((m) => ({ default: m.DailySheetPage })),
)
const VitalsSheetPage = lazy(() =>
  import('./pages/VitalsSheetPage').then((m) => ({ default: m.VitalsSheetPage })),
)
const MealsSheetPage = lazy(() =>
  import('./pages/MealsSheetPage').then((m) => ({ default: m.MealsSheetPage })),
)
const MorePage = lazy(() => import('./pages/MorePage').then((m) => ({ default: m.MorePage })))

// 既存画面（1つも削除しない。TimelinePage は中身を変えずパスだけ /timeline へ移す）
const TimelinePage = lazy(() => import('./pages/TimelinePage').then((m) => ({ default: m.TimelinePage })))
const RecordHubPage = lazy(() => import('./pages/RecordHubPage').then((m) => ({ default: m.RecordHubPage })))
const VitalsGridPage = lazy(() => import('./pages/VitalsGridPage').then((m) => ({ default: m.VitalsGridPage })))
const MealsGridPage = lazy(() => import('./pages/MealsGridPage').then((m) => ({ default: m.MealsGridPage })))
const NoteFormPage = lazy(() => import('./pages/NoteFormPage').then((m) => ({ default: m.NoteFormPage })))
const OutingFormPage = lazy(() => import('./pages/OutingFormPage').then((m) => ({ default: m.OutingFormPage })))
const KartePage = lazy(() => import('./pages/KartePage').then((m) => ({ default: m.KartePage })))
const SearchPage = lazy(() => import('./pages/SearchPage').then((m) => ({ default: m.SearchPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const LoginPage = lazy(() => import('./pages/AuthGates').then((m) => ({ default: m.LoginPage })))
const NotConfiguredPage = lazy(() =>
  import('./pages/AuthGates').then((m) => ({ default: m.NotConfiguredPage })),
)

// ── UI状態の復元（dev-principles 原則11: 既知値のホワイトリスト照合）──
// 既定（不正値・未知値のフォールバック先）は日報シート。
// 'timeline' は既知値のまま残す＝この改修前に保存された値でも /timeline へ正しく復元される
const VIEWS = [
  'daily',
  'vitalsSheet',
  'mealsSheet',
  'more',
  'timeline',
  'record',
  'karte',
  'search',
  'settings',
] as const
type View = (typeof VIEWS)[number]
const DEFAULT_VIEW: View = 'daily'
const VIEW_PATH: Record<View, string> = {
  daily: '/',
  vitalsSheet: '/sheet/vitals',
  mealsSheet: '/sheet/meals',
  more: '/more',
  timeline: '/timeline',
  record: '/record',
  karte: '/karte',
  search: '/search',
  settings: '/settings',
}

function readView(): View | null {
  try {
    const raw = window.localStorage.getItem(LS.view)
    return VIEWS.includes(raw as View) ? (raw as View) : null
  } catch {
    return null // 参照できない環境（プライベートモード等）では既定へフォールバック
  }
}

function writeView(v: View): void {
  try {
    window.localStorage.setItem(LS.view, v)
  } catch {
    // 保存できなくても操作は続行する（壊れた値で起動不能にしない）
  }
}

/** URL のパスから「どのタブにいるか」を判定する。未知のパスは null */
function viewOf(pathname: string): View | null {
  if (pathname === '/') return 'daily'
  if (pathname === '/sheet/vitals') return 'vitalsSheet'
  if (pathname === '/sheet/meals') return 'mealsSheet'
  if (pathname === '/more') return 'more'
  if (pathname === '/timeline') return 'timeline'
  if (pathname === '/record' || pathname.startsWith('/record/')) return 'record'
  if (pathname === '/karte' || pathname.startsWith('/karte/')) return 'karte'
  if (pathname === '/search') return 'search'
  if (pathname === '/settings') return 'settings'
  return null
}

// HashRouter が hash を書き換える前に「ベースURL直開きか」を確定させる（module 評価時に採取）
const INITIAL_HASH = typeof window === 'undefined' ? '' : window.location.hash
const OPENED_BARE = INITIAL_HASH === '' || INITIAL_HASH === '#' || INITIAL_HASH === '#/'
// 起動時の cl_view も、以降の保存で上書きされる前にここで読み切る
const STORED_VIEW = typeof window === 'undefined' ? null : readView()

// 表示モード（cl_mode）の適用。初回描画前に当てて切替時のちらつきを防ぐ。
// 既知値が保存されている時だけ触り、未設定・不正値では index.html の指定をそのまま残す
function applyStoredMode(): void {
  try {
    const raw = window.localStorage.getItem(LS.mode)
    if (raw === 'light' || raw === 'dark') document.documentElement.setAttribute('data-mode', raw)
    else if (raw === 'auto') document.documentElement.removeAttribute('data-mode') // 明示的な OS 追従
  } catch {
    // 参照できない場合は index.html の指定のまま（OS 追従）
  }
}
if (typeof window !== 'undefined') applyStoredMode()

// ── ナビゲーション定義（sheet-contracts.md §2・位置は画面間で一貫）───
// <1024px: 下部タブ5つ。入りきらない画面は「その他」（MorePage）から入る
// ≥1024px: 左レール8つ。幅に余裕があるので全画面を直接出す
type IconName = View
type NavItem = { view: View; to: string; label: string }

const NAV_BOTTOM: NavItem[] = [
  { view: 'daily', to: '/', label: '日報' },
  { view: 'vitalsSheet', to: '/sheet/vitals', label: 'バイタル' },
  { view: 'mealsSheet', to: '/sheet/meals', label: '食事' },
  { view: 'karte', to: '/karte', label: 'カルテ' },
  { view: 'more', to: '/more', label: 'その他' },
]

const NAV_RAIL: NavItem[] = [
  { view: 'daily', to: '/', label: '日報' },
  { view: 'vitalsSheet', to: '/sheet/vitals', label: 'バイタル' },
  { view: 'mealsSheet', to: '/sheet/meals', label: '食事' },
  { view: 'karte', to: '/karte', label: 'カルテ' },
  { view: 'search', to: '/search', label: '検索' },
  { view: 'timeline', to: '/timeline', label: 'タイムライン' },
  { view: 'record', to: '/record', label: '記録' },
  { view: 'settings', to: '/settings', label: '設定' },
]

// 下部タブに枠が無い画面は「その他」の配下扱いにして、現在地の表示が消えないようにする
const MORE_VIEWS: View[] = ['more', 'timeline', 'record', 'search', 'settings']

const ICON_PATHS: Record<IconName, ReactNode> = {
  daily: (
    <>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M9 9h6M9 13h6M9 17h4" />
    </>
  ),
  vitalsSheet: (
    <>
      <path d="M3 12h3.5l2-5 3 10 2.5-6 1.5 3H21" />
    </>
  ),
  mealsSheet: (
    <>
      <path d="M3.5 11h17c0 4.4-3.8 8-8.5 8s-8.5-3.6-8.5-8z" />
      <path d="M8 7.5c0-1 1-1.5 1-2.5M12 7c0-1.2 1-1.8 1-3M16 7.5c0-1 1-1.5 1-2.5" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </>
  ),
  timeline: (
    <>
      <circle cx="5" cy="6" r="1.5" />
      <path d="M9.5 6H20" />
      <circle cx="5" cy="12" r="1.5" />
      <path d="M9.5 12H20" />
      <circle cx="5" cy="18" r="1.5" />
      <path d="M9.5 18H20" />
    </>
  ),
  record: (
    <>
      <path d="M4 20h4l9.5-9.5a2.47 2.47 0 0 0-3.5-3.5L4.5 16.5V20z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  karte: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.4-4.4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17.5 7H20M4 17h3.5M12 17h8" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9.5" cy="17" r="2.2" />
    </>
  ),
}

/** タブのアイコン（文字ラベルと必ず併記する。単独では意味を持たせない） */
function NavIcon({ name }: { name: IconName }) {
  return (
    <svg
      className="h-6 w-6"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}

/** スプシ模倣の一覧（セル直接編集を持つ＝入力解禁フラグを取り直す画面） */
const SHEET_PATHS = ['/', '/sheet/vitals', '/sheet/meals']
function isSheetPath(pathname: string): boolean {
  return SHEET_PATHS.includes(pathname)
}

/** ヘッダに出す画面名 */
function screenTitle(pathname: string): string {
  if (pathname === '/') return '日報'
  if (pathname === '/sheet/vitals') return 'バイタル一覧'
  if (pathname === '/sheet/meals') return '食事一覧'
  if (pathname === '/more') return 'その他'
  if (pathname === '/timeline') return 'タイムライン'
  if (pathname === '/record') return '記録'
  if (pathname === '/record/vitals') return 'バイタル一括'
  if (pathname === '/record/meals') return '食事・水分'
  if (pathname === '/record/note') return '申し送り'
  if (pathname === '/record/outing') return '外出・外泊'
  if (pathname === '/karte' || pathname.startsWith('/karte/')) return 'カルテ'
  if (pathname === '/search') return '検索'
  if (pathname === '/settings') return '設定'
  if (pathname === '/login') return 'ログイン'
  return 'ケアログ'
}

/** 一段深い画面からの戻り先（無ければ null） */
function backTarget(pathname: string): string | null {
  if (pathname.startsWith('/record/')) return '/record'
  if (pathname.startsWith('/karte/')) return '/karte'
  return null
}

// ── 起動時・失敗時の最小UI（supabase 非依存でも描ける素の要素だけで作る）──
function FullScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4 text-ink">
      <div className="w-full max-w-md">{children}</div>
    </div>
  )
}

function Booting() {
  return (
    <FullScreen>
      <p role="status" className="text-center text-base text-ink2">
        読み込み中…
      </p>
    </FullScreen>
  )
}

function ReloadButton() {
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="mt-4 inline-flex min-h-tap items-center justify-center rounded-md bg-primary px-4 text-base font-bold text-primary-ink"
    >
      再読み込み
    </button>
  )
}

/** 接続未設定の案内（AuthGates を読み込めなかった場合の最終フォールバック） */
function NotConfiguredInline() {
  return (
    <FullScreen>
      <div className="rounded-lg border border-border bg-surface p-4">
        <h1 className="text-xl font-heavy text-ink">接続先が設定されていません</h1>
        <p className="mt-2 text-base text-ink2">
          接続設定（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）が読み込まれていません。設定ファイルに値を入れてから、アプリを再読み込みしてください。
        </p>
        <ReloadButton />
      </div>
    </FullScreen>
  )
}

/** 起動そのものに失敗したとき（チャンク取得失敗など）の案内 */
function StartupError() {
  return (
    <FullScreen>
      <div className="rounded-lg border border-border bg-surface p-4">
        <h1 className="text-xl font-heavy text-ink">画面を読み込めませんでした</h1>
        <p className="mt-2 text-base text-ink2">
          通信が途切れた可能性があります。電波状態を確認してから、再読み込みしてください。
        </p>
        <ReloadButton />
      </div>
    </FullScreen>
  )
}

type BoundaryProps = { fallback: ReactNode; children: ReactNode }
type BoundaryState = { failed: boolean }

/** 例外で白画面にしないための境界。エラー内容は業務データを含み得るため表示・記録しない */
class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

// ── 認証ゲート ──────────────────────────────────────────────────
function Shell({ deps }: { deps: Deps }) {
  const { ui } = deps
  // useAuth は動的読込したモジュールの関数。呼び出し位置は固定なのでフックの規則は満たす
  const { ready, session } = deps.useAuth()
  const location = useLocation()
  const returnToRef = useRef<string>('/')

  useEffect(() => {
    if (location.pathname !== '/login') returnToRef.current = location.pathname
  }, [location.pathname])

  if (!ready) {
    return (
      <FullScreen>
        <ui.LoadingBlock label="読み込み中…" />
      </FullScreen>
    )
  }

  if (!session) {
    return (
      <Suspense fallback={<Booting />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
    )
  }

  return <Authenticated deps={deps} returnTo={returnToRef.current} />
}

// 401 ハンドラは購読解除の口が無い契約（onAuthExpired に解除の戻り値が無い）のため、
// 登録は module scope で1回に絞り、中身だけを最新のハンドラへ差し替える。
// 1回限りの登録で初回インスタンスの関数を掴み続けると、ログアウト→再ログイン後の 401 で
// アンマウント済みのコンポーネントを呼ぶだけになる（＝何も起きない）。
let authExpiredHooked = false
let authExpiredHandler: (() => void) | null = null

function hookAuthExpired(db: Deps['db']): void {
  if (authExpiredHooked) return
  authExpiredHooked = true
  db.onAuthExpired(() => authExpiredHandler?.())
}

type PickerMode = 'none' | 'required' | 'reconfirm' | 'switch'

// ── ログイン後のシェル（封鎖フラグ → 操作者ゲート → タブ／ルート）──
function Authenticated({ deps, returnTo }: { deps: Deps; returnTo: string }) {
  // sheet モジュールは deps で先読みするだけ（部品は各ページが直接 import する）
  const { db, actor, ui } = deps
  const location = useLocation()
  const navigate = useNavigate()

  const [staff, setStaff] = useState<Staff[] | null>(null)
  const [staffError, setStaffError] = useState(false)
  const [reload, setReload] = useState(0)
  const [actorId, setActorId] = useState<number | null>(null)
  const [picker, setPicker] = useState<PickerMode>('none')
  // 取得できるまでは安全側（封鎖）に倒す。並走期間に誤って入力させない
  const [inputEnabled, setInputEnabled] = useState(false)
  const [pending, setPending] = useState(0)
  const restoredRef = useRef(false)

  // 入力を受け付ける画面（＝入力解禁フラグを入るたび取り直す対象）。
  // 既存の /record 系に加え、セル直接編集を持つ一覧（日報・バイタル・食事）も含める
  const isEditScreen =
    location.pathname === '/record' ||
    location.pathname.startsWith('/record/') ||
    isSheetPath(location.pathname)

  // 未送信キュー件数（ヘッダの「⚠ 未送信n件」）
  useEffect(() => {
    setPending(db.queuePending())
    return db.queueSubscribe((n) => setPending(typeof n === 'number' && n > 0 ? n : 0))
  }, [db])

  // 401（セッション失効）→ キューは保全したままログイン画面へ。
  // ここで /login へ navigate しても、下のルート定義で '/' へ戻されるため画面は変わらない。
  // 失効した session を捨てて Shell の認証ゲート（useAuth）にログイン画面を出させる。
  const handleAuthExpired = useCallback(() => {
    // 既に無効なトークンなのでサーバーへは投げず、端末側の session だけを破棄する。
    // 未送信キューは db.ts が保持したまま（再ログイン時に自動再送される）
    void import('./lib/supabase')
      .then(({ supabase }) => supabase.auth.signOut({ scope: 'local' }))
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    authExpiredHandler = handleAuthExpired
    hookAuthExpired(db)
    return () => {
      if (authExpiredHandler === handleAuthExpired) authExpiredHandler = null
    }
  }, [db, handleAuthExpired])

  // ログイン済みで起動した時点で、退避済みの送信キューを再送する（成功観測後に db 側が消す）。
  // 直前の失敗で待ち時間が残っていても送る（force）＝起動しても送られない状態を作らない
  useEffect(() => {
    void db.flushQueue(true).catch(() => undefined)
  }, [db])

  // 職員名簿 → 操作者ゲート
  useEffect(() => {
    let alive = true
    setStaffError(false)
    void (async () => {
      try {
        const list = await db.fetchStaff()
        if (!alive) return
        const safe = Array.isArray(list) ? list.filter((s) => s && typeof s.id === 'number') : []
        setStaff(safe)
        const current = actor.resolveActor(safe)
        if (!current) {
          setActorId(null)
          setPicker('required') // 照合失敗（不在・退職・不正値）は選び直し
          return
        }
        setActorId(current.id)
        if (actor.shouldReconfirm()) setPicker('reconfirm')
        else actor.touchActivity()
      } catch {
        if (alive) setStaffError(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [db, actor, reload])

  // 入力解禁フラグ: 起動時と、入力画面に入るたびに取り直す（前提情報は毎回実測する）。
  // 取得できなかった時も false（封鎖側）を渡すため、この値だけでは
  // 「スプシ期間」と「通信エラー」を区別できない。区別が要る画面は自前で
  // getNativeInputGate を呼ぶ（日報・バイタル・食事の各一覧／記録ハブ／その他）
  const flagKey = isEditScreen ? location.pathname : 'view'
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const v = await db.getNativeInputEnabled()
        if (alive) setInputEnabled(v === true)
      } catch {
        if (alive) setInputEnabled(false) // 取得できない間は封鎖のまま（安全側）
      }
    })()
    return () => {
      alive = false
    }
  }, [db, flagKey, reload])

  // ベースURL直開きのときだけ cl_view から復元する（URL が第一）。
  // ログイン画面を挟んだ復帰（直開き→セッション失効→ログイン）では、この時点の pathname が
  // '/login' なので判定を保留する（保留しないと復元の機会を1回消費して既定画面へ落ちる）
  useEffect(() => {
    if (restoredRef.current) return
    if (location.pathname === '/login') return
    restoredRef.current = true
    if (!OPENED_BARE) return
    if (location.pathname !== '/') return
    // 未保存・不正値・既定（日報）はそのまま '/' ＝ DailySheetPage
    if (!STORED_VIEW || STORED_VIEW === DEFAULT_VIEW) return
    navigate(VIEW_PATH[STORED_VIEW], { replace: true })
  }, [location.pathname])

  // 現在のタブを保存（UI状態のみ。利用者・日付・検索語は保存しない）＋操作者の活動時刻更新
  useEffect(() => {
    const v = viewOf(location.pathname)
    if (v) writeView(v)
    actor.touchActivity()
  }, [location.pathname, actor])

  // 再ログイン後は元の画面へ戻す（401 からの復帰経路）
  useEffect(() => {
    if (location.pathname !== '/login') return
    navigate(returnTo && returnTo !== '/login' ? returnTo : '/', { replace: true })
  }, [location.pathname])

  // 共有端末で開きっぱなしの場合に備え、復帰時にも再確認条件を見る
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (actorId == null) return
      if (actor.shouldReconfirm()) setPicker((p) => (p === 'none' ? 'reconfirm' : p))
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [actor, actorId])

  const pickActor = useCallback(
    (id: number) => {
      actor.setActorId(id)
      actor.touchActivity()
      setActorId(id)
      setPicker('none')
    },
    [actor],
  )

  const closePicker = useCallback(() => {
    if (picker === 'reconfirm') actor.touchActivity() // 「このまま続ける」
    setPicker('none')
  }, [picker, actor])

  if (staffError) {
    return (
      <FullScreen>
        <ui.ErrorBlock
          message="職員名簿を読み込めませんでした（通信エラー）。電波状態を確認してから、再試行してください。"
          onRetry={() => setReload((n) => n + 1)}
        />
      </FullScreen>
    )
  }

  if (staff === null) {
    return (
      <FullScreen>
        <ui.LoadingBlock label="読み込み中…" />
      </FullScreen>
    )
  }

  const actorName = staff.find((s) => s.id === actorId)?.name ?? null
  const back = backTarget(location.pathname)
  const currentView = viewOf(location.pathname)
  const pickerTitle =
    picker === 'required'
      ? '記録する職員を選んでください'
      : picker === 'reconfirm'
        ? actorName
          ? `「${actorName}」として記録します。交代した場合は選び直してください`
          : '記録する職員を確認してください'
        : '記録する職員を切り替える'

  return (
    <div className="min-h-screen bg-bg text-ink lg:pl-24">
      <header className="sticky top-0 z-20 border-b border-border bg-surface">
        {/* 文字サイズ200%・狭幅でも画面名が消えないよう、収まらない要素は次の行へ折り返す */}
        <div className="flex min-h-tap flex-wrap items-center gap-gap px-4 py-2">
          {back && (
            <button
              type="button"
              onClick={() => navigate(back)}
              className="inline-flex min-h-tap min-w-tap items-center gap-1 rounded-md px-2 text-sm text-link"
            >
              <span aria-hidden="true">←</span>
              <span>戻る</span>
            </button>
          )}
          <h1 className="min-w-tap flex-1 truncate text-lg font-bold">{screenTitle(location.pathname)}</h1>
          {/* 表示倍率（100/125/150%）は各シート画面の操作バー側に1つだけ置く
              （契約 §5〜§7）。ヘッダにも出すと ZoomBar が同一画面に2つ並び、
              片方で切り替えても他方は選択表示が変わらず「現在の倍率」が食い違うため */}
          <span role="status">
            {pending > 0 && <ui.Chip tone="warn">{`⚠ 未送信 ${pending}件`}</ui.Chip>}
          </span>
          {/*
            記録者（操作者）の常時表示は 2026-08-28 の指示で廃止した。
            日報・バイタル・食事は行ごとに記入者を選ぶため、画面全体の記録者表示は場所を取るだけになる。
            操作者の仕組み自体は残す（各行の記入者の既定値・既読の主体）。
            切り替えの導線は設定タブ（記録する職員）へ移した。
            未選択のときだけは、記録できない理由が分かるよう案内を出す。
          */}
          {actorId == null && (
            <Link
              to="/settings"
              className="inline-flex min-h-tap items-center gap-1 rounded-md border border-warn bg-warn-bg px-3 text-sm text-ink"
            >
              <span aria-hidden="true">▲ </span>記録する職員が未選択
            </Link>
          )}
        </div>
      </header>

      <main className="px-4 pb-24 pt-4 lg:pb-8">
        {/*
          入力封鎖の見せ方（理由文＋ディセーブル）は各記録画面が自前で持つため、ここでは重ねない。
          シェルの担当は「起動時と記録画面に入るたびフラグを取り直し、既知値として渡す」ところまで。
        */}
        {/* 職員マスタが空＝操作者を選べない。モーダルで塞がず、案内バーで設定タブへ誘導する
            （picker が none でない＝名簿の取得は完了していて空、の状態だけで出す） */}
        {picker !== 'none' && staff.length === 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-gap rounded-md border border-info bg-info-bg p-3">
            <p className="flex-1 text-base text-ink">
              <span aria-hidden="true">ⓘ </span>
              職員の一覧がまだありません。設定タブで「マスタ同期」を実行すると記録者を選べるようになります（閲覧はこのまま可能です）。
            </p>
            <button
              type="button"
              onClick={() => navigate('/settings')}
              className="min-h-tap rounded-md border border-primary bg-surface px-4 text-base font-bold text-primary"
            >
              設定を開く
            </button>
          </div>
        )}
        <Suspense
          fallback={
            <div className="py-8">
              <ui.LoadingBlock label="画面を読み込んでいます…" />
            </div>
          }
        >
          <Routes>
            {/* スプシ模倣の一覧（既定は日報シート） */}
            <Route
              path="/"
              element={<DailySheetPage actorId={actorId} staff={staff} inputEnabled={inputEnabled} />}
            />
            <Route
              path="/sheet/vitals"
              element={<VitalsSheetPage actorId={actorId} inputEnabled={inputEnabled} />}
            />
            <Route
              path="/sheet/meals"
              element={<MealsSheetPage actorId={actorId} inputEnabled={inputEnabled} />}
            />
            <Route path="/more" element={<MorePage inputEnabled={inputEnabled} />} />
            {/* 既存タイムライン（中身は変更なし・パスのみ移設） */}
            <Route
              path="/timeline"
              element={<TimelinePage actorId={actorId} staff={staff} nativeInputEnabled={inputEnabled} />}
            />
            <Route path="/record" element={<RecordHubPage inputEnabled={inputEnabled} />} />
            <Route
              path="/record/vitals"
              element={<VitalsGridPage actorId={actorId} inputEnabled={inputEnabled} />}
            />
            <Route
              path="/record/meals"
              element={<MealsGridPage actorId={actorId} inputEnabled={inputEnabled} />}
            />
            <Route path="/record/note" element={<NoteFormPage />} />
            <Route
              path="/record/outing"
              element={<OutingFormPage actorId={actorId} inputEnabled={inputEnabled} />}
            />
            <Route path="/karte" element={<KartePage staff={staff} />} />
            <Route path="/karte/:id" element={<KartePage staff={staff} />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>

      {/* <1024px: 下部タブ5つ（親指圏） */}
      <nav
        aria-label="メインナビゲーション"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul className="grid grid-cols-5">
          {NAV_BOTTOM.map((item) => {
            // 下部タブに枠が無い画面（検索・タイムライン・記録・設定）にいる間は「その他」を現在地にする
            const active =
              item.view === currentView ||
              (item.view === 'more' && currentView != null && MORE_VIEWS.includes(currentView))
            return (
              <li key={item.view}>
                {/* NavLink ではなく Link ＋ 自前判定にしている。NavLink は自分の URL 一致でしか
                    aria-current を付けられず、「その他」配下（検索等）で読み上げと見た目がずれるため */}
                <Link
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={`flex h-14 min-h-tap flex-col items-center justify-center gap-1 border-t-2 ${
                    active ? 'border-primary font-bold text-primary' : 'border-transparent text-ink2'
                  }`}
                >
                  <NavIcon name={item.view} />
                  {/* 幅の狭い端末でも隣の項目に重ならないよう、はみ出す時だけ省略する */}
                  <span className="w-full truncate text-center text-2xs leading-tight">{item.label}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* ≥1024px: 左レール8つ（順序は下部タブと同じ並びで始める）。
          縦に入りきらない画面高でも全項目へ届くようスクロールさせる */}
      <nav
        aria-label="メインナビゲーション"
        className="fixed inset-y-0 left-0 z-30 hidden w-24 flex-col gap-gap overflow-y-auto border-r border-border bg-surface pt-4 lg:flex"
      >
        {NAV_RAIL.map((item) => (
          <Link
            key={item.view}
            to={item.to}
            aria-current={item.view === currentView ? 'page' : undefined}
            className={`flex h-14 min-h-tap shrink-0 flex-col items-center justify-center gap-1 border-l-2 ${
              item.view === currentView
                ? 'border-primary font-bold text-primary'
                : 'border-transparent text-ink2'
            }`}
          >
            <NavIcon name={item.view} />
            {/* 幅の狭い端末でも隣の項目に重ならないよう、はみ出す時だけ省略する */}
            <span className="w-full truncate text-center text-2xs leading-tight">{item.label}</span>
          </Link>
        ))}
      </nav>

      <ui.StaffPickerModal
        // 職員マスタが空のときはモーダルを出さない。出すと「設定タブで同期を」と案内しながら
        // 閉じられず設定タブへも行けない行き止まりになる（2026-08-28 実機で発生）。
        // 空の間は上部の案内バーが設定タブへ誘導し、記録系は操作者未選択ガードが止める
        open={picker !== 'none' && staff.length > 0}
        staff={staff}
        onPick={pickActor}
        // 初回選択（required）は閉じられない＝誤帰属を防ぐ
        onClose={picker === 'required' ? undefined : closePicker}
        title={pickerTitle}
      />
    </div>
  )
}

// supabase 依存モジュールをまとめて遅延読込し、解決後にシェルへ渡す
const AppRoot = lazy(async () => {
  const [db, actor, ui, sheet, auth] = await Promise.all([
    import('./lib/db'),
    import('./lib/actor'),
    import('./components/ui'),
    import('./components/sheet'),
    import('./hooks/useAuth'),
  ])
  const deps: Deps = { db, actor, ui, sheet, useAuth: auth.useAuth }
  return { default: () => <Shell deps={deps} /> }
})

export default function App() {
  // ①接続未設定ゲート: ここから先は supabase を一切読み込まない
  if (!SUPABASE_CONFIGURED) {
    return (
      <Boundary fallback={<NotConfiguredInline />}>
        <Suspense fallback={<Booting />}>
          <NotConfiguredPage />
        </Suspense>
      </Boundary>
    )
  }

  return (
    <Boundary fallback={<StartupError />}>
      <HashRouter>
        <Suspense fallback={<Booting />}>
          <AppRoot />
        </Suspense>
      </HashRouter>
    </Boundary>
  )
}
