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
 *   ④記録者の既定（設定タブから明示的に切り替える時だけ StaffPickerModal。起動時は出さない）
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
import {
  attachBeforeUnload,
  cancelBlocked,
  hasUnsavedInput,
  LEAVE_BODY,
  LEAVE_BODY_NOTES,
  LEAVE_TITLE,
  unsavedOnlyNotes,
  markAccepted,
  onBlockedNavigation,
  proceedBlocked,
  registerUnsaved,
} from './lib/leaveGuard'
// 版の印・部品の取得失敗の見分け（F28・F60）と端末の時刻帯の確かめ（F36）。どちらも supabase に依存しない純粋なモジュール
import {
  CLIENT_BUILD,
  fetchPublishedBuild,
  isChunkLoadError,
  isDevBuild,
  isOtherBuildPublished,
  notePreloadError,
} from './lib/appVersion'
import { deviceTimeZoneWarning } from './lib/format'

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
// デイの入浴記録（2026-09-26 追加）。記録は記録ハブから、月次表は「その他」から入る
const BathRecordPage = lazy(() => import('./pages/BathRecordPage').then((m) => ({ default: m.BathRecordPage })))
const BathMonthPage = lazy(() => import('./pages/BathMonthPage').then((m) => ({ default: m.BathMonthPage })))
// 与薬チェック（2026-09-26 追加）。記録は記録ハブから、服薬の時間帯・月次表は「その他」から入る
const MedRecordPage = lazy(() => import('./pages/MedRecordPage').then((m) => ({ default: m.MedRecordPage })))
const MedSlotsPage = lazy(() => import('./pages/MedSlotsPage').then((m) => ({ default: m.MedSlotsPage })))
const MedMonthPage = lazy(() => import('./pages/MedMonthPage').then((m) => ({ default: m.MedMonthPage })))
// 事故・ヒヤリハット（2026-09-26 追加）。一覧は「その他」と記録ハブから、月次集計は「その他」から入る
const IncidentListPage = lazy(() => import('./pages/IncidentListPage').then((m) => ({ default: m.IncidentListPage })))
const IncidentFormPage = lazy(() => import('./pages/IncidentFormPage').then((m) => ({ default: m.IncidentFormPage })))
const IncidentSummaryPage = lazy(() =>
  import('./pages/IncidentSummaryPage').then((m) => ({ default: m.IncidentSummaryPage })),
)
const KartePage = lazy(() => import('./pages/KartePage').then((m) => ({ default: m.KartePage })))
const SearchPage = lazy(() => import('./pages/SearchPage').then((m) => ({ default: m.SearchPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const LoginPage = lazy(() => import('./pages/AuthGates').then((m) => ({ default: m.LoginPage })))
const NotConfiguredPage = lazy(() =>
  import('./pages/AuthGates').then((m) => ({ default: m.NotConfiguredPage })),
)
// 名簿の自動同期（F50・2026-10-10）。部品が db を読むので、他の画面と同じく遅延読込にする
const MasterAutoSync = lazy(() => import('./components/MasterSync').then((m) => ({ default: m.MasterAutoSync })))

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
  'bathMonth',
  'medSlots',
  'medMonth',
  'incident',
  'incidentSummary',
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
  bathMonth: '/bath/month',
  medSlots: '/med/slots',
  medMonth: '/med/month',
  incident: '/incident',
  incidentSummary: '/incident/summary',
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
  if (pathname === '/bath/month') return 'bathMonth'
  if (pathname === '/med/slots') return 'medSlots'
  if (pathname === '/med/month') return 'medMonth'
  // 事故・ヒヤリハット: 月次集計だけ別の既知値。入力・編集（/incident/new・/incident/:id）は一覧の配下
  if (pathname === '/incident/summary') return 'incidentSummary'
  if (pathname === '/incident' || pathname.startsWith('/incident/')) return 'incident'
  return null
}

// ── 記録ハブの下の画面（F68・2026-10-10）─────────────────────────────────
// cl_view は /record/* をまとめて 'record' にするため、ホーム画面のアイコン（ハッシュの無いURL）から開くと、
// 直前にいたバイタル一括・食事一括ではなく記録ハブが開いた。設計（ui-design.md §9）で許可リストに載せてある
// cl_recordTab に「記録ハブの下のどの画面か」だけを持ち、cl_view が 'record' の時に2段目の行き先として使う。
// 値は画面の名前だけ（利用者・日付・入力値は保存しない＝原則11）。許可リスト外・不正値は記録ハブのまま
const RECORD_TABS = ['vitals', 'meals', 'note', 'outing'] as const
type RecordTab = (typeof RECORD_TABS)[number]

function readRecordTab(): RecordTab | null {
  try {
    const raw = window.localStorage.getItem(LS.recordTab)
    return RECORD_TABS.includes(raw as RecordTab) ? (raw as RecordTab) : null
  } catch {
    return null
  }
}

function writeRecordTab(tab: RecordTab | null): void {
  try {
    if (tab === null) window.localStorage.removeItem(LS.recordTab)
    else window.localStorage.setItem(LS.recordTab, tab)
  } catch {
    // 保存できなくても操作は続行する
  }
}

/**
 * 記録ハブの下のどの画面か。許可リストの画面ならその名前、記録ハブ・それ以外の /record/* は null（＝控えを消す）、
 * 記録ハブの外は undefined（控えに触れない）
 */
function recordTabOf(pathname: string): RecordTab | null | undefined {
  if (pathname === '/record') return null
  if (!pathname.startsWith('/record/')) return undefined
  const tab = pathname.slice('/record/'.length)
  return RECORD_TABS.includes(tab as RecordTab) ? (tab as RecordTab) : null
}

// HashRouter が hash を書き換える前に「ベースURL直開きか」を確定させる（module 評価時に採取）
const INITIAL_HASH = typeof window === 'undefined' ? '' : window.location.hash
const OPENED_BARE = INITIAL_HASH === '' || INITIAL_HASH === '#' || INITIAL_HASH === '#/'
// 起動時の cl_view も、以降の保存で上書きされる前にここで読み切る
const STORED_VIEW = typeof window === 'undefined' ? null : readView()
// 記録ハブの下の画面の控えも同じく読み切る（起動直後の '/' で保存の effect が先に走っても失わない）
const STORED_RECORD_TAB = typeof window === 'undefined' ? null : readRecordTab()

// ── 新しい版の確かめ（F28①・2026-10-10）。間隔は仮の合格ライン（起動直後の読み込みと重ねない・5分ごと）
/** 起動から最初に確かめるまで（名簿・記録の読み込みと重ねない） */
const VERSION_FIRST_CHECK_MS = 10_000
/** 開いたままの端末で確かめる間隔 */
const VERSION_CHECK_MS = 5 * 60_000
/** 帯を出している間、〔更新〕を押せるか（未保存の入力が無いか）を見直す間隔 */
const VERSION_GUARD_TICK_MS = 15_000

// 画面の部品の先読み（modulepreload・CSS）に失敗した合図（F28②）。その後に上がる例外を「部品の取得失敗」として
// 見分けるため、時刻だけを控える（既定の動き＝例外を投げる、はそのまま）
if (typeof window !== 'undefined') window.addEventListener('vite:preloadError', () => notePreloadError())

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
const MORE_VIEWS: View[] = [
  'more',
  'timeline',
  'record',
  'search',
  'settings',
  'bathMonth',
  'medSlots',
  'medMonth',
  'incident',
  'incidentSummary',
]

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
  // 月次表（ナビには出さないが、アイコンの表は全ての画面の分を持つ型のため置く）
  bathMonth: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="1.5" />
      <path d="M4 10h16M9 5v15M14 5v15" />
    </>
  ),
  // 服薬の時間帯・与薬の月次表（ナビには出さないが、アイコンの表は全ての画面の分を持つ型のため置く）
  medSlots: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  medMonth: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="1.5" />
      <path d="M4 10h16M4 15h16M10 5v15" />
    </>
  ),
  // 事故・ヒヤリハットの一覧・月次集計（ナビには出さないが、アイコンの表は全ての画面の分を持つ型のため置く）
  incident: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4.5M12 17.5v.01" />
    </>
  ),
  incidentSummary: (
    <>
      <path d="M5 20V10M10 20V5M15 20v-7M20 20v-4" />
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
  if (pathname === '/record/bath') return '入浴（デイ）'
  if (pathname === '/bath/month') return '入浴 月次表'
  if (pathname === '/record/med') return '与薬チェック'
  if (pathname === '/med/slots') return '服薬の時間帯'
  if (pathname === '/med/month') return '与薬 月次表'
  if (pathname === '/incident') return '事故・ヒヤリハット'
  if (pathname === '/incident/summary') return '事故・ヒヤリ 月次集計'
  if (pathname.startsWith('/incident/')) return '事故・ヒヤリハットの記録'
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
  // 事故・ヒヤリハットの入力・編集から一覧へ（月次集計は「その他」から入る画面なので戻り先を持たない）
  if (pathname.startsWith('/incident/') && pathname !== '/incident/summary') return '/incident'
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

/**
 * 古い版の受け皿（F28③）。app_settings の min_client_build より前の版では、記録の画面の代わりにこれを出す
 * （入力・送信を止める。ヘッダ・タブ・未送信の件数は外に残る）。〔更新〕で新しい版を読み込む（自動では読み込まない）。
 * 送信待ちは端末（localStorage）に残り、更新した版が送る。端末に残せていない送信待ちだけは更新で消えるので、そう書く
 */
function OutdatedPanel({ unpersisted, pending }: { unpersisted: boolean; pending: number }) {
  return (
    <div role="alert" className="rounded-lg border border-danger bg-surface p-4 print:hidden">
      <h2 className="text-xl font-heavy text-ink">新しい版に更新してください</h2>
      <p className="mt-2 text-base text-ink2">
        この端末のアプリは古い版のため、記録できません（記録の形が新しくなりました）。〔更新〕を押すと新しい版で開き直します。
      </p>
      {pending > 0 && (
        <p className="mt-2 text-base text-ink2">
          {unpersisted
            ? `送れていない記録が${pending}件あります。うち端末に残せていないものは、更新すると消えます。内容を確かめてから押してください。`
            : `送れていない記録が${pending}件あります。端末に残っていて、更新した後に新しい版が送ります。`}
        </p>
      )}
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-3 min-h-tap rounded-md border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
      >
        更新
      </button>
    </div>
  )
}

/**
 * 公開中の版がこの端末の版と違うか（画面の部品を取れなかった時の案内の出し分け・F28②）。
 * null＝確かめている最中・確かめられない
 */
function usePublishedBuildDiffers(): boolean | null {
  const [differs, setDiffers] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    if (isDevBuild(CLIENT_BUILD)) {
      setDiffers(false)
      return undefined
    }
    void fetchPublishedBuild().then((remote) => {
      if (alive) setDiffers(remote === null ? null : isOtherBuildPublished(CLIENT_BUILD, remote))
    })
    return () => {
      alive = false
    }
  }, [])
  return differs
}

/** 部品の取得失敗の時、公開中の版が違えば「新しい版」、同じ・確かめられなければ従来の通信の案内（F28②） */
function ChunkFailureText({ differs }: { differs: boolean | null }) {
  return differs === true ? (
    <>
      <h1 className="text-xl font-heavy text-ink">新しい版が公開されました</h1>
      <p className="mt-2 text-base text-ink2">
        この画面の部品が新しい版に置き換わったため、読み込めませんでした。再読み込みすると新しい版で開きます（通信の不具合ではありません）。
      </p>
    </>
  ) : (
    <>
      <h1 className="text-xl font-heavy text-ink">画面を読み込めませんでした</h1>
      <p className="mt-2 text-base text-ink2">
        通信が途切れた可能性があります。電波状態を確認してから、再読み込みしてください。
      </p>
    </>
  )
}

/** 起動そのものに失敗したとき（チャンク取得失敗など）の案内 */
function StartupError({ kind = 'chunk' }: { kind?: FailKind }) {
  const differs = usePublishedBuildDiffers()
  return (
    <FullScreen>
      <div className="rounded-lg border border-border bg-surface p-4">
        {kind === 'chunk' ? (
          <ChunkFailureText differs={differs} />
        ) : (
          // 描画の例外（F60）。通信の案内を出すと電波を疑って時間を失うので分ける
          <>
            <h1 className="text-xl font-heavy text-ink">画面の表示で問題が起きました</h1>
            <p className="mt-2 text-base text-ink2">
              再読み込みしてください。送信待ちの記録は端末に残っています。続く場合は管理者に連絡してください。
            </p>
          </>
        )}
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

/** 受けた例外の種類。chunk＝画面の部品（チャンク）を取れなかった／render＝画面の描画の例外 */
type FailKind = 'chunk' | 'render'

type KindBoundaryProps = {
  /** 受けた例外の種類ごとの代わりの表示 */
  fallback: (kind: FailKind) => ReactNode
  /** この値が変わったら受けた状態を解く（画面を移ったら、移った先の画面を描き直す） */
  resetKey?: string
  /** 例外を受けた時に呼ぶ（エラーの中身は渡さない＝業務データを含み得るため記録しない） */
  onCaught?: (kind: FailKind) => void
  children: ReactNode
}
type KindBoundaryState = { failed: FailKind | null }

/**
 * 例外の種類（部品の取得失敗か描画の例外か）を見分ける境界（F28②・F60・2026-10-10）。
 * 包み要素を作らず children をそのまま返す（印刷レイアウト・表の高さを変えない）。
 * resetKey が変わると受けた状態を解く＝画面ごとの受け皿として使うと、タブで他の画面へ移れば元に戻る
 * （包む部品を毎回作り直さないので、普段の画面移動の動きは変わらない）
 */
class KindBoundary extends Component<KindBoundaryProps, KindBoundaryState> {
  state: KindBoundaryState = { failed: null }

  static getDerivedStateFromError(e: unknown): KindBoundaryState {
    return { failed: isChunkLoadError(e) ? 'chunk' : 'render' }
  }

  componentDidCatch(e: unknown): void {
    this.props.onCaught?.(isChunkLoadError(e) ? 'chunk' : 'render')
  }

  componentDidUpdate(prev: KindBoundaryProps): void {
    if (this.state.failed !== null && prev.resetKey !== this.props.resetKey) this.setState({ failed: null })
  }

  render(): ReactNode {
    return this.state.failed !== null ? this.props.fallback(this.state.failed) : this.props.children
  }
}

/**
 * 画面ごとの受け皿の表示（F60・F28②）。ヘッダ・タブ・未送信の件数は受け皿の外に残るので、タブでほかの画面へ移れる。
 * 部品の取得失敗は再読み込みでしか直らない（React.lazy は失敗を覚えている）。端末に残せていない送信待ちがある間は、
 * 再読み込みで消えるので〔再読み込み〕を出さない
 */
function PageFailure({
  kind,
  pathname,
  unpersisted,
  isUnpersisted,
}: {
  kind: FailKind
  pathname: string
  unpersisted: boolean
  /** 押した時に確かめ直す（描いた後に端末へ残せなくなっていれば再読み込みしない＝保全の確認の後ろで消す） */
  isUnpersisted: () => boolean
}) {
  const differs = usePublishedBuildDiffers()
  const [blocked, setBlocked] = useState(false)
  return (
    <div role="alert" className="mx-auto w-full max-w-2xl rounded-lg border border-danger bg-surface p-4 print:hidden">
      {kind === 'chunk' ? (
        <ChunkFailureText differs={differs} />
      ) : (
        <>
          <h1 className="text-xl font-heavy text-ink">この画面で問題が起きました</h1>
          <p className="mt-2 text-base text-ink2">
            送信待ちの記録は消えていません。下のタブ（広い画面では左の列）から、ほかの画面へ移って使えます。
            再読み込みしても直らない場合は、管理者に連絡してください。
          </p>
        </>
      )}
      {unpersisted || blocked ? (
        <p className="mt-2 text-base font-bold text-danger">
          <span aria-hidden="true">▲ </span>
          端末に残せていない送信待ちがあります。再読み込みすると消えるので、電波のある所で送り終えるまで、ほかの画面をお使いください。
        </p>
      ) : (
        <button
          type="button"
          onClick={() => {
            if (isUnpersisted()) {
              setBlocked(true)
              return
            }
            window.location.reload()
          }}
          className="mt-4 inline-flex min-h-tap items-center justify-center rounded-md bg-primary px-4 text-base font-bold text-primary-ink"
        >
          再読み込み
        </button>
      )}
      {kind === 'render' ? (
        <p className="mt-3">
          {/* 壊れているのが日報（既定の画面）の時に「日報へ」は役に立たないので、その時は「その他」へ */}
          <Link
            to={pathname === '/' ? '/more' : '/'}
            className="inline-flex min-h-tap items-center rounded-md border border-border-strong px-4 text-base text-link"
          >
            {pathname === '/' ? '「その他」を開く' : '日報へ戻る'}
          </Link>
        </p>
      ) : null}
    </div>
  )
}

/**
 * 圏外で起動した時の案内（F59・2026-10-10）。ログインの確認（トークンの更新）が通信できずに失敗しただけで、
 * ログインは切れていない。電波が戻ると自動の更新で開くので、ログイン画面（別の部品＝圏外では読み込めない）は出さない
 */
function OfflineGate() {
  return (
    <FullScreen>
      <div role="status" className="rounded-lg border border-warn bg-warn-bg p-4">
        <h1 className="text-xl font-heavy text-ink">
          <span aria-hidden="true">▲ </span>
          通信できないため、ログインを確かめられません
        </h1>
        <p className="mt-2 text-base text-ink">
          ログインし直す必要はありません。電波が戻ってから1分ほどで自動で開きます。この画面は開いたままにしてください。
        </p>
        <p className="mt-2 text-base text-ink2">送信待ちの記録は端末に残っています。</p>
      </div>
    </FullScreen>
  )
}

// ── 認証ゲート ──────────────────────────────────────────────────
function Shell({ deps }: { deps: Deps }) {
  const { ui } = deps
  // useAuth は動的読込したモジュールの関数。呼び出し位置は固定なのでフックの規則は満たす
  const { ready, session, offline } = deps.useAuth()
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

  // 圏外で起動してログインの確認だけが通信できなかった（F59）: ログイン画面へ移さない（ログインは切れていない。
  // 電波が戻ると自動の更新で session が入り、そのままログイン後の画面になる）
  if (!session && offline) return <OfflineGate />

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

/**
 * 記録する職員の選択モード。
 * 2026-09-05 に 'required'（閉じられない初回選択）と 'reconfirm'（日をまたいだ再確認）を廃止した。
 * 1台の端末を複数人が使うため、端末に1人を紐づけて選ばせる前提が実務に合わず、
 * しかも選ぶまで閲覧すらできなかった。いまは設定タブから明示的に切り替える 'switch' だけ。
 */
type PickerMode = 'none' | 'switch'

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
  /** 施設名（日報の見出しの右に出す。2026-08-31 指示で日報の各日の左上から移した） */
  const [facility, setFacility] = useState<string | null>(null)
  const [pending, setPending] = useState(0)
  /** 端末に残せていない送信待ちがある（保存領域が一杯。閉じる・再読み込みで消える＝F01） */
  const [unpersisted, setUnpersisted] = useState(false)
  /** この版では送れない未送信（別の版の画面のタブが書いた・読めずに控えている＝F27③） */
  const [unreadable, setUnreadable] = useState(0)
  /** 端末の時刻帯が日本時間でない時の案内（F36）。null＝日本時間 */
  const [tzWarning, setTzWarning] = useState<string | null>(() => deviceTimeZoneWarning())
  /** 新しい版が公開された（F28①） */
  const [newBuild, setNewBuild] = useState(false)
  /** この版が古い（app_settings の min_client_build より前・F28③）。入力と送信を止め、画面を受け皿に置き換える */
  const [outdated, setOutdated] = useState<boolean>(() => db.isClientBuildOutdated())
  /** 〔更新〕を押せるかを取り直すための合図（未保存の入力は購読できないので、帯を出している間だけ時々見直す） */
  const [, setGuardTick] = useState(0)
  const restoredRef = useRef(false)

  // 入力を受け付ける画面（＝入力解禁フラグを入るたび取り直す対象）。
  // 既存の /record 系に加え、セル直接編集を持つ一覧（日報・バイタル・食事）も含める
  const isEditScreen =
    location.pathname === '/record' ||
    location.pathname.startsWith('/record/') ||
    isSheetPath(location.pathname)

  // 未送信キュー件数（ヘッダの「⚠ 未送信n件」）。送信待ちを書き戻すたびに通知が来るので、
  // 端末に残せているか（F01）・この版で読めない未送信があるか（F27③）も同じ時に取り直す
  useEffect(() => {
    const sync = (n: number) => {
      setPending(typeof n === 'number' && n > 0 ? n : 0)
      setUnpersisted(db.hasUnpersistedQueue())
      setUnreadable(db.queueUnreadableCount())
    }
    sync(db.queuePending())
    return db.queueSubscribe(sync)
  }, [db])

  // 端末に残せていない送信待ち（全ての表）は、閉じる・再読み込みで消える。画面を離れる前の確認に「消える入力」として
  // App 全体で1回だけ数える（F01。申し送りだけを数える UnsentNotes は日報と設定の画面にしか無い）
  useEffect(() => registerUnsaved(() => db.hasUnpersistedQueue(), 'input'), [db])

  // 端末の時刻帯（F36）: 起動時と、画面に戻った時に確かめ直す（設定を直したら帯を消す）
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') setTzWarning(deviceTimeZoneWarning())
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // 新しい版の公開（F28①）: 少し待ってから・画面に戻った時・5分ごとに version.json を取り直して比べる。
  // 自動では再読み込みしない（本人回答 2026-10-10）。開発中の版（'dev'）は比べない
  useEffect(() => {
    if (isDevBuild(CLIENT_BUILD)) return undefined
    let alive = true
    const check = async () => {
      const remote = await fetchPublishedBuild()
      if (alive && isOtherBuildPublished(CLIENT_BUILD, remote)) setNewBuild(true)
    }
    const first = window.setTimeout(() => void check(), VERSION_FIRST_CHECK_MS)
    const timer = window.setInterval(() => void check(), VERSION_CHECK_MS)
    const onVis = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      window.clearTimeout(first)
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])
  // 古い版の入力止め（F28③）: 起動時・画面に戻った時・5分ごとに min_client_build を確かめる（入力解禁の確認からも
  // 確かめる）。古いと分かったら受け皿を出す。開発中の版・未設定・読めない時は止めない（db.checkClientBuild）
  useEffect(() => {
    let alive = true
    const off = db.onClientBuildOutdated(() => {
      if (alive) setOutdated(true)
    })
    const check = () => {
      void db.checkClientBuild().then((v) => {
        if (alive && v) setOutdated(true)
      })
    }
    check()
    const timer = window.setInterval(check, VERSION_CHECK_MS)
    const onVis = () => {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      off()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [db])

  // 帯を出している間は、〔更新〕を押せるか（未保存の入力が無いか）を時々見直す
  useEffect(() => {
    if (!newBuild && !outdated) return undefined
    const t = window.setInterval(() => setGuardTick((n) => n + 1), VERSION_GUARD_TICK_MS)
    return () => window.clearInterval(t)
  }, [newBuild, outdated])

  // 401（セッション失効）→ キューは保全したままログイン画面へ。
  // ここで /login へ navigate しても、下のルート定義で '/' へ戻されるため画面は変わらない。
  // 失効した session を捨てて Shell の認証ゲート（useAuth）にログイン画面を出させる。
  const handleAuthExpired = useCallback(() => {
    // ★まず更新トークンで復帰を試みる（2026-08-29）。
    //   以前は 401 を受けた瞬間に session を捨てていたため、更新トークンが生きていても
    //   ログイン画面へ戻され、現場では「使うたびにログインし直す」状態になっていた。
    //   端末がスリープから復帰した直後など、自動更新が走る前に要求が出ると必ず起きる。
    //   復帰できた時は画面も未送信キューもそのまま（何も起きなかったように続く）。
    void import('./lib/supabase')
      .then(async ({ supabase }) => {
        try {
          const { data, error } = await supabase.auth.refreshSession()
          if (!error && data.session) return // 復帰できた＝ログイン画面へ戻さない
          // 更新の要求そのものが通信できなかった（圏外・サーバーの一時的な不調＝AuthRetryableFetchError）: ログインは
          // 切れていない。ここで端末の session を捨てると更新トークンまで消え、電波が戻っても自動で戻れなくなる（F59）。
          // 捨てずに待つ（電波が戻れば自動の更新が session を新しくし、退避した送信待ちも送られる）
          if (error && error.name === 'AuthRetryableFetchError') return
        } catch {
          // 通信不能・想定外の例外はここでは判断せず、下の破棄へ倒す
        }
        // 更新トークンも無効＝本当に切れている。端末側の session だけを破棄する。
        // 未送信キューは db.ts が保持したまま（再ログイン時に自動再送される）
        await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined)
      })
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
        // ★起動時に「記録する職員」を選ばせない（2026-09-05 指示）。
        //   以前は未選択・要再確認の時に**閉じられないモーダル**を出しており、
        //   選ぶまで日報すら見られなかった（iPhone で「名前を選ばないと何も見えない」）。
        //   記録は1台の端末を複数人が使うので、端末に1人を紐づける前提自体が実務に合わない。
        //   記入者は**記録ごとに選ぶ**（日報・バイタル・食事は行ごとの記入者欄、
        //   申し送りフォームは記入者の必須入力）ので、ここでの選択は既定値にすぎない。
        //   閲覧は誰であっても妨げない＝未選択のまま全画面を見られる。
        setActorId(current?.id ?? null)
        if (current) actor.touchActivity()
      } catch {
        if (alive) setStaffError(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [db, actor, reload])

  // 記録者の切り替え（F46・F38・2026-10-10）: 設定タブ・バイタル/食事の「記録者」・別のタブで切り替えたら、その場で
  // 取り直す（以前は localStorage に書くだけで、再読み込みするまで前の職員の名前で recorded_by・edited_by・既読が付いた）。
  // 名簿との照合（退職者を外す）はここで行う。名簿を読めるまで（staff が null の間）は何もしない
  useEffect(() => {
    if (staff === null) return undefined
    return actor.subscribeActor(() => setActorId(actor.resolveActor(staff)?.id ?? null))
  }, [actor, staff])

  // 職員名簿を新しく保つ（F47・2026-10-10）: マスタ同期・画面に戻った時・電波が戻った時に取り直し、中身が変わった時
  // だけ差し替える。失敗した時は今の名簿を残す（全画面のエラー・読み込み中には戻さない＝入力中の日報を消さない）。
  // 記録者の既定は、名簿から外れても黙って外さない（下の案内で選び直しを促す）
  useEffect(() => (staff === null ? undefined : db.watchStaffRoster(staff, setStaff)), [db, staff])

  // 更新・削除の「最後にこの行を書き換えた職員」（edited_by）として、名簿と照合済みの操作者を渡す。
  // 新規記録の記入者（recorded_by）と同じ操作者。未選択の間は null＝送らない
  useEffect(() => {
    db.setEditor(actorId)
  }, [db, actorId])

  // 施設名（表示だけの補助情報）。取れなくても画面は開ける＝失敗しても何も出さない
  useEffect(() => {
    let alive = true
    void db
      .getAppSetting('facility_name')
      .then((v) => {
        if (!alive) return
        setFacility(typeof v === 'string' && v.trim() !== '' ? v : null)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [db, reload])

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
    // 記録ハブの下の画面にいた（F68）: 許可リストの画面ならそこへ戻す（無ければ記録ハブ）
    if (STORED_VIEW === 'record' && STORED_RECORD_TAB !== null) {
      navigate(`/record/${STORED_RECORD_TAB}`, { replace: true })
      return
    }
    navigate(VIEW_PATH[STORED_VIEW], { replace: true })
  }, [location.pathname])

  // 現在のタブを保存（UI状態のみ。利用者・日付・検索語は保存しない）＋操作者の活動時刻更新
  useEffect(() => {
    const v = viewOf(location.pathname)
    if (v) writeView(v)
    // 記録ハブの下のどの画面か（F68）。記録ハブの外では触らない
    const rt = recordTabOf(location.pathname)
    if (rt !== undefined) writeRecordTab(rt)
    actor.touchActivity()
  }, [location.pathname, actor])

  // 再ログイン後は元の画面へ戻す（401 からの復帰経路）
  useEffect(() => {
    if (location.pathname !== '/login') return
    navigate(returnTo && returnTo !== '/login' ? returnTo : '/', { replace: true })
  }, [location.pathname])

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
    setPicker('none')
  }, [])

  // ── 止まっている入力を黙って捨てない（競合・未保存の入力がある時の画面移動の確認） ──
  // 各記録画面が leaveGuard に「止まっている入力があるか」を登録している。
  //   ・メニュー・リンクでの画面移動 … ここで止めて確認ダイアログを出す（日報の askLeave と同じ文言の形）
  //   ・再読み込み・タブを閉じる   … beforeunload でブラウザの警告を出す
  // くらべて選ぶ画面の中のリンク（変更の記録を見る）は、その画面に「離れると残らない」と書いてあるので止めない
  const [leaveTo, setLeaveTo] = useState<string | null>(null)
  /** 止めた移動が「戻る・進む・アドレスの書き換え」だったか（〔移動する〕のやり直し方が違う） */
  const leaveFromHistoryRef = useRef(false)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const target = e.target instanceof Element ? e.target : null
      const a = target?.closest('a[href]') ?? null
      if (a === null || a.closest('[role="dialog"]') !== null) return
      const href = a.getAttribute('href') ?? ''
      if (!href.startsWith('#/')) return
      const to = href.slice(1)
      if (to === window.location.hash.slice(1)) return
      if (!hasUnsavedInput()) return
      // リンクの既定の動き（画面移動）を止め、確認してから移る
      e.preventDefault()
      e.stopPropagation()
      leaveFromHistoryRef.current = false
      setLeaveTo(to)
    }
    window.addEventListener('click', onClick, true)
    const detach = attachBeforeUnload()
    return () => {
      window.removeEventListener('click', onClick, true)
      detach()
    }
  }, [])
  // ブラウザの戻る・進む・スワイプで戻る・アドレスの書き換えも、止まっている入力がある時は
  // leaveGuard が元の画面へ戻してから知らせてくる。同じ確認ダイアログを出す
  useEffect(
    () =>
      onBlockedNavigation((to) => {
        leaveFromHistoryRef.current = true
        setLeaveTo(to)
      }),
    [],
  )
  // 画面の移動が確定するたびに「止めた時に戻す先」を控える
  useEffect(() => {
    markAccepted()
  }, [location])
  /** ボタンからの画面移動（戻る・設定を開く）も同じ確認を通す */
  const guardedNavigate = useCallback(
    (to: string) => {
      if (hasUnsavedInput()) {
        leaveFromHistoryRef.current = false
        setLeaveTo(to)
      } else navigate(to)
    },
    [navigate],
  )

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
  // 記録者の既定が、取り直した名簿に無い（退職扱いになった等・F47）。黙って外さず、選び直しを促す
  const actorOffRoster = actorId !== null && staff.length > 0 && !staff.some((s) => s.id === actorId)
  const back = backTarget(location.pathname)
  const currentView = viewOf(location.pathname)
  const pickerTitle = actorName
    ? `記録者の既定を切り替える（いまは「${actorName}」）`
    : '記録者の既定を選ぶ'
  // 新しい版へ切り替えてよいか（F28・本人回答: 未保存・未送信が無い時だけ〔更新〕を出す。自動の再読み込みはしない）
  const canReloadForBuild = pending === 0 && !unpersisted && !hasUnsavedInput()
  // 古い版（F28③）: 入力中の内容がある間は画面を残す（受け皿に置き換えると打った文字が消える。保存は db が止める）
  const outdatedTyping = outdated && hasUnsavedInput()
  const reloadForBuild = () => {
    // 押した時にもう一度確かめる（帯を描いた後に入力・送信待ちができていれば押させない）
    if (db.queuePending() > 0 || db.hasUnpersistedQueue() || hasUnsavedInput()) {
      setGuardTick((n) => n + 1)
      return
    }
    window.location.reload()
  }

  return (
    <div className="min-h-screen bg-bg text-ink lg:pl-24">
      <header className="sticky top-0 z-20 border-b border-border bg-surface">
        {/* 文字サイズ200%・狭幅でも画面名が消えないよう、収まらない要素は次の行へ折り返す */}
        <div className="flex min-h-tap flex-wrap items-center gap-gap px-4 py-2">
          {back && (
            <button
              type="button"
              onClick={() => guardedNavigate(back)}
              className="inline-flex min-h-tap min-w-tap items-center gap-1 rounded-md px-2 text-sm text-link"
            >
              <span aria-hidden="true">←</span>
              <span>戻る</span>
            </button>
          )}
          {/* 施設名は日報の見出しの右に出す（2026-08-31 指示）。
              以前は日報の各日の左上に毎日繰り返し出ていたが、その位置は日付に譲った。
              日報以外の画面では出さない（見出しの横幅を取るだけになるため） */}
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
            <h1 className="min-w-tap truncate text-lg font-bold">{screenTitle(location.pathname)}</h1>
            {location.pathname === '/' && facility !== null && (
              <span className="truncate text-sm text-ink2">{facility}</span>
            )}
          </div>
          {/* 表示倍率（100/125/150%）は各シート画面の操作バー側に1つだけ置く
              （契約 §5〜§7）。ヘッダにも出すと ZoomBar が同一画面に2つ並び、
              片方で切り替えても他方は選択表示が変わらず「現在の倍率」が食い違うため */}
          <span role="status">
            {/* 端末に残せていない時（保存領域が一杯・F01）は、閉じる・再読み込みで消えることを件数に添える */}
            {pending > 0 &&
              (unpersisted ? (
                <ui.Chip tone="danger">{`▲ 未送信 ${pending}件・端末に残せていません`}</ui.Chip>
              ) : (
                <ui.Chip tone="warn">{`⚠ 未送信 ${pending}件`}</ui.Chip>
              ))}
          </span>
          {/*
            記録者（操作者）の常時表示は 2026-08-28 の指示で廃止した。
            日報・バイタル・食事は行ごとに記入者を選ぶため、画面全体の記録者表示は場所を取るだけになる。
            操作者の仕組み自体は残す（各行の記入者の既定値・既読の主体）。
            切り替えの導線は設定タブ（記録する職員）へ移した。
            2026-09-05: 未選択は**異常ではなく通常の状態**になった（1台を複数人で使うため）。
            警告色をやめ、既定値を決めたい人のための入口としてだけ残す。閲覧は妨げない。
          */}
          {actorId == null && (
            <Link
              to="/settings"
              className="inline-flex min-h-tap shrink-0 items-center gap-1 rounded-md px-2 text-sm text-link"
            >
              記録者の既定を設定
            </Link>
          )}
        </div>
      </header>

      <main className="px-4 pb-24 pt-4 lg:pb-8">
        {/*
          入力封鎖の見せ方（理由文＋ディセーブル）は各記録画面が自前で持つため、ここでは重ねない。
          シェルの担当は「起動時と記録画面に入るたびフラグを取り直し、既知値として渡す」ところまで。
        */}
        {/* 職員マスタが空＝どの記録にも記入者を付けられない。モーダルで塞がず案内バーで誘導する。
            staff が null の間（取得中）は出さない＝空だと確かめられた時だけ出す
            （2026-09-05: 起動時に選択モーダルを出さなくなったので picker には依存させない） */}
        {staff !== null && staff.length === 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-gap rounded-md border border-info bg-info-bg p-3">
            <p className="flex-1 text-base text-ink">
              <span aria-hidden="true">ⓘ </span>
              職員の一覧がまだありません。設定タブで「マスタ同期」を実行すると記録者を選べるようになります（閲覧はこのまま可能です）。
            </p>
            <button
              type="button"
              onClick={() => guardedNavigate('/settings')}
              className="min-h-tap rounded-md border border-primary bg-surface px-4 text-base font-bold text-primary"
            >
              設定を開く
            </button>
          </div>
        )}
        {/* 名簿の自動同期（F50）。接続設定のある端末だけが動き、失敗した時だけ帯を出す。
            部品を読めなくても画面は止めない（受け皿は何も出さない） */}
        <Boundary fallback={null}>
          <Suspense fallback={null}>
            <MasterAutoSync />
          </Suspense>
        </Boundary>
        {/*
          ここから下の帯は画面だけ（print:hidden）。表の上に積むので、表の枠は高さを測り直して画面に収める
          （sheet.tsx の SheetFrame が body の大きさの変化を見ている）
        */}
        {/* 端末の時刻帯が日本時間でない（F36）。入力は止めない・閉じる操作は設けない */}
        {tzWarning !== null && (
          <p role="status" className="mb-4 rounded-md border border-warn bg-warn-bg p-3 text-base text-ink print:hidden">
            <span aria-hidden="true">▲ </span>
            {tzWarning}
          </p>
        )}
        {/* この版では送れない未送信がある（F27③）＝別の版の画面のタブが開いている・書いた */}
        {unreadable > 0 && (
          <p role="status" className="mb-4 rounded-md border border-warn bg-warn-bg p-3 text-base text-ink print:hidden">
            <span aria-hidden="true">▲ </span>
            この端末に別の版の画面のタブが開いています。すべて閉じてから開き直してください（この版で読めない未送信
            {` ${unreadable}件`}は、消さずに残しています）。
          </p>
        )}
        {/* 記録者の既定が職員名簿に無い（F47） */}
        {actorOffRoster && (
          <div className="mb-4 flex flex-wrap items-center gap-gap rounded-md border border-warn bg-warn-bg p-3 print:hidden">
            <p className="min-w-0 flex-1 text-base text-ink">
              <span aria-hidden="true">▲ </span>
              記録者の既定（いまの記録者）が職員名簿にありません（退職扱いになった可能性があります）。設定タブの「記録する職員」で選び直してください。
            </p>
            <button
              type="button"
              onClick={() => guardedNavigate('/settings')}
              className="min-h-tap shrink-0 rounded-md border border-primary bg-surface px-4 text-base font-bold text-primary"
            >
              設定を開く
            </button>
          </div>
        )}
        {/* この版が古い（F28③・min_client_build）。入力中の内容がある間だけ画面を残し、この帯で知らせる。
            〔更新〕はいつでも押せる（この版では保存も送信もできないため。送信待ちは端末に残り、新しい版が送る） */}
        {outdatedTyping && (
          <div
            role="alert"
            className="mb-4 flex flex-wrap items-center gap-gap rounded-md border border-danger bg-danger-bg p-3 print:hidden"
          >
            <p className="min-w-0 flex-1 text-base text-ink">
              <span aria-hidden="true">▲ </span>
              この端末のアプリは古い版のため、記録できません。入力中の内容はこの版では保存できないので、必要なら書き写してから〔更新〕を押してください（更新すると画面の入力は消えます）。
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="min-h-tap shrink-0 rounded-md border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
            >
              更新
            </button>
          </div>
        )}
        {/* 新しい版が公開された（F28①）。〔更新〕は未保存・未送信が無い時だけ出す（自動では再読み込みしない） */}
        {/* 古い版の受け皿（OutdatedPanel）を出している間は重ねない */}
        {newBuild && (outdated ? null : (
          <div
            role="status"
            className="mb-4 flex flex-wrap items-center gap-gap rounded-md border border-info bg-info-bg p-3 print:hidden"
          >
            <p className="min-w-0 flex-1 text-base text-ink">
              <span aria-hidden="true">ⓘ </span>
              新しい版が公開されました。
              {canReloadForBuild
                ? '〔更新〕を押すと新しい版で開き直します。'
                : '未送信の記録・入力中の内容がなくなると〔更新〕を押せます（送り終える・保存してから）。'}
            </p>
            {canReloadForBuild && (
              <button
                type="button"
                onClick={reloadForBuild}
                className="min-h-tap shrink-0 rounded-md border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
              >
                更新
              </button>
            )}
          </div>
        ))}
        {/* 画面ごとの受け皿（F60・F28②）。ヘッダ・タブ・未送信の件数は外に残る。画面を移ると元に戻る。
            描画の例外を受けたら、ホーム画面から開いた時に壊れた画面へ戻らないよう、現在地の控えを既定へ戻す */}
        <KindBoundary
          resetKey={location.pathname}
          onCaught={(kind) => {
            if (kind === 'render') writeView(DEFAULT_VIEW)
          }}
          fallback={(kind) => (
            <PageFailure
              kind={kind}
              pathname={location.pathname}
              unpersisted={unpersisted}
              isUnpersisted={() => db.hasUnpersistedQueue()}
            />
          )}
        >
        {outdated && !outdatedTyping ? (
          <OutdatedPanel unpersisted={unpersisted} pending={pending} />
        ) : (
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
            {/* 入浴（デイ）。入力解禁は native_input_enabled ではなく input_enabled_bath（画面が自前で取り直す） */}
            <Route path="/record/bath" element={<BathRecordPage actorId={actorId} staff={staff} />} />
            <Route path="/bath/month" element={<BathMonthPage />} />
            {/* 与薬チェック。入力解禁は input_enabled_med（画面が自前で取り直す） */}
            <Route path="/record/med" element={<MedRecordPage actorId={actorId} staff={staff} />} />
            <Route path="/med/slots" element={<MedSlotsPage actorId={actorId} staff={staff} />} />
            <Route path="/med/month" element={<MedMonthPage />} />
            {/* 事故・ヒヤリハット。入力解禁は input_enabled_incident（画面が自前で取り直す） */}
            <Route path="/incident" element={<IncidentListPage />} />
            <Route path="/incident/summary" element={<IncidentSummaryPage />} />
            <Route path="/incident/new" element={<IncidentFormPage actorId={actorId} staff={staff} />} />
            <Route path="/incident/:id" element={<IncidentFormPage actorId={actorId} staff={staff} />} />
            <Route path="/karte" element={<KartePage staff={staff} />} />
            <Route path="/karte/:id" element={<KartePage staff={staff} />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        )}
        </KindBoundary>
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
        // 閉じられない選択は廃止した（閲覧を妨げない）
        onClose={closePicker}
        title={pickerTitle}
      />

      <ui.ConfirmDialog
        open={leaveTo !== null}
        title={LEAVE_TITLE}
        // 止まっているのが送れていない申し送りだけなら、事実どおり「端末に残る」と出す（2026-09-29）
        body={leaveTo !== null && unsavedOnlyNotes() ? LEAVE_BODY_NOTES : LEAVE_BODY}
        confirmLabel="移動する"
        danger
        onConfirm={() => {
          const to = leaveTo
          setLeaveTo(null)
          if (to === null) return
          // 戻る・進むを止めた時は同じ幅だけ動かし直す（履歴を積み増さない）。それ以外は画面を移す
          if (leaveFromHistoryRef.current) proceedBlocked(() => navigate(to))
          else navigate(to)
        }}
        onCancel={() => {
          if (leaveFromHistoryRef.current) cancelBlocked()
          setLeaveTo(null)
        }}
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

  // 一番外の受け皿。起動の部品（AppRoot）を取れなかった時と、画面の受け皿の外（ヘッダ・タブ）の例外を受ける。
  // 部品の取得失敗と描画の例外で案内を分ける（F28②・F60）
  return (
    <KindBoundary fallback={(kind) => <StartupError kind={kind} />}>
      <HashRouter>
        <Suspense fallback={<Booting />}>
          <AppRoot />
        </Suspense>
      </HashRouter>
    </KindBoundary>
  )
}
