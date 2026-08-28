// その他メニュー（ルート /more・下部タブ「その他」の入口）。
//
// 正本: docs/design/sheet-contracts.md §2「`/more` = その他（MorePage・新規）: 検索・タイムライン・
//       記録（キーパッド式）・設定への入口」「<1024px 下部タブ5つ: 日報 / バイタル / 食事 / カルテ / その他」、
//       docs/design/ui-design.md §1（4大ボタン 2×2グリッド・min-height 72px・アイコン＋17px文字・gap 8px以上）・§0.5（入力解禁フラグ）、
//       docs/design/contracts.md（ルート定義・共通規律）。
//       見た目は RecordHubPage を踏襲する（同じ入口カードなので寸法・クラス・封鎖の見せ方を揃える）。
//
// 規律:
// - supabase を直呼びしない（データアクセスは db.ts の関数のみ）
// - 実名・記録本文をコード/コメント/console に書かない。localStorage へ何も書かない
//   （現在地は HashRouter の URL で復元＝contracts.md「HashRouter のURLが第一」・原則11。
//    タブ位置 cl_view の保存は App.tsx の責務なので本画面では触らない）
// - Tailwind はトークン由来クラスのみ（arbitrary value・色/px 直書きなし）
// - タップ要素は min-h-tap（44px）以上＋隣接 gap-gap（8px）。色だけで意味を伝えない（記号・文字を併記）
//
// 3状態（contracts.md §共通規律「全画面にローディング／エラー／空」）:
// - ローディング: 入力解禁フラグの取得中（この間「記録」だけディセーブル。閲覧系は待たせない）
// - エラー   : フラグを取得できなかった時（可否が不明なので「記録」へ進ませない・再試行ボタン付き）
// - 空     : この画面は項目が固定で0件にならないため、「いま使える入力が1つも無い」封鎖中の状態を
//            空相当の案内（理由文＋いま何ができるか）として出す（ui-design.md §0.5）
//
// 封鎖中でも「検索・タイムライン・設定」は使える（sheet-contracts.md §8-5「閲覧は可能」）。
// フラグを取得できなかった場合も同じ扱いにし、記録だけを安全側でディセーブルにする。
//
// 寸法メモ（トークン外の値を直書きしないための読み替え。RecordHubPage と同一）:
// - min-height 72px … 4px グリッドの利用可能値が 64px / 80px のため、下回らない側の min-h-20（80px）を使う
// - 17px 文字   … ops 系統のトークンは fs-base=16px / fs-lg=18px。下回らない側の text-lg（18px）を使う

import { useCallback, useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { getNativeInputGate } from '../lib/db'
import { ErrorBlock, LoadingBlock, SectionCard } from '../components/ui'

/** 入力封鎖中の理由文（ui-design.md §0.5 の定型文。文言を変えない） */
const LOCKED_REASON =
  '現在はスプレッドシートで記録する期間です（アプリ入力の開始日は施設で決定します）'

/** 封鎖中に「次にどうすればよいか」を示す一文 */
const LOCKED_NEXT =
  'この画面の「検索」「タイムライン」「設定」は、これまでどおりお使いいただけます。'

const LOAD_ERROR =
  'アプリで入力できる期間かどうかを確認できませんでした。通信状態を確認して［再試行する］を押してください。確認できるまで「記録」は開けません（検索・タイムライン・設定はそのままお使いいただけます）。'

const LOADING_LABEL = '「記録」を開けるかどうか確認しています…'

type MoreKey = 'search' | 'timeline' | 'record' | 'settings'

/**
 * 2×2 の並び順（左上→右上→左下→右下）。ルートは sheet-contracts.md §2 のとおり。
 * needsInput=true の項目だけが入力解禁フラグの配下（＝封鎖中はディセーブル）。
 */
const ITEMS: { key: MoreKey; to: string; label: string; desc: string; needsInput: boolean }[] = [
  { key: 'search', to: '/search', label: '検索', desc: '申し送りを本文・記入者から探す', needsInput: false },
  {
    key: 'timeline',
    to: '/timeline',
    label: 'タイムライン',
    desc: '日ごとの記録をさかのぼって見る',
    needsInput: false,
  },
  {
    key: 'record',
    to: '/record',
    label: '記録',
    desc: 'バイタル・食事の一括入力（小さい画面向け）',
    needsInput: true,
  },
  { key: 'settings', to: '/settings', label: '設定', desc: 'マスタ同期・表示モード・ログアウト', needsInput: false },
]

/**
 * アイコンは必ず文字ラベルと併記する（アイコン単独では意味を持たせない）。
 * 同じ行き先を指すタブ（App.tsx のナビゲーション）と同じ形にして、見た目の一貫性を保つ。
 */
const ICON_PATHS: Record<MoreKey, ReactNode> = {
  // 虫めがね
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.4-4.4" />
    </>
  ),
  // 点と横線（時系列）
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
  // 鉛筆
  record: (
    <>
      <path d="M4 20h4l9.5-9.5a2.47 2.47 0 0 0-3.5-3.5L4.5 16.5V20z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  // スライダー
  settings: (
    <>
      <path d="M4 7h9M17.5 7H20M4 17h3.5M12 17h8" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9.5" cy="17" r="2.2" />
    </>
  ),
}

function MoreIcon({ name }: { name: MoreKey }) {
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

export interface MorePageProps {
  /** 入力解禁フラグの既知値。渡された場合も §0.5 に従い画面表示のたびに取り直す */
  inputEnabled?: boolean
}

export function MorePage({ inputEnabled: inputEnabledProp }: MorePageProps = {}) {
  const navigate = useNavigate()
  const uid = useId()
  const noticeId = `${uid}-notice`

  const [fetchedEnabled, setFetchedEnabled] = useState<boolean | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // 入力解禁フラグは「この画面を表示するたびに毎回取り直す」（ui-design.md §0.5・前提情報は毎回取り直す規範）。
  // 「false を観測した（＝スプシ期間）」と「観測できなかった（＝通信エラー）」は別物なので、
  // 後者は封鎖の理由文ではなくエラー＋再試行を出す（observed で区別する）。
  useEffect(() => {
    let alive = true
    setLoadError(null)
    setFetchedEnabled(null)
    getNativeInputGate()
      .then((gate) => {
        if (!alive) return
        if (!gate.observed) {
          setLoadError(LOAD_ERROR)
          return
        }
        setFetchedEnabled(gate.value === true)
      })
      .catch(() => {
        if (alive) setLoadError(LOAD_ERROR)
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  // 自分で取り直した観測値が正本。まだ取得できていない間（null）だけ、親の既知値か
  // 安全側（封鎖）に倒す。観測が成立したあとも親の値を混ぜると、App.tsx が起動直後に持っている
  // 古い false のせいで「解禁済みなのに封鎖表示のまま」になり、事実と違う案内が出てしまう
  // （/more は App.tsx の入力画面扱いではないため、親の値は自動では更新されない）
  const locked = fetchedEnabled == null ? inputEnabledProp !== true : fetchedEnabled !== true
  // 「自分で false を観測できた」状態だけ理由文を出す（未取得・エラーは別の案内を出す）
  const lockedObserved = loadError == null && fetchedEnabled === false

  const open = useCallback(
    (to: string, needsInput: boolean) => {
      if (needsInput && locked) return // UI のディセーブルに加えた二重ガード（ui-design.md §0.5）
      navigate(to)
    },
    [locked, navigate],
  )

  // 案内欄（エラー／ローディング／封鎖）。閲覧系のボタンは待たせずに出す＝行き止まりを作らない
  const notice = loadError ? (
    <ErrorBlock message={loadError} onRetry={() => setReloadKey((n) => n + 1)} />
  ) : fetchedEnabled == null ? (
    <LoadingBlock label={LOADING_LABEL} />
  ) : lockedObserved ? (
    <div role="status" className="rounded-lg border border-warn bg-warn-bg p-4">
      <p className="text-base text-ink">
        <span aria-hidden="true">▲ </span>
        <span className="sr-only">お知らせ: </span>
        {LOCKED_REASON}
      </p>
      <p className="mt-2 text-base text-ink2">{LOCKED_NEXT}</p>
    </div>
  ) : null

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      {notice ? <div id={noticeId}>{notice}</div> : null}

      <SectionCard title="その他のメニュー">
        <ul className="grid grid-cols-2 gap-gap">
          {ITEMS.map((item) => {
            const disabled = item.needsInput && locked
            return (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => open(item.to, item.needsInput)}
                  disabled={disabled}
                  aria-describedby={disabled && notice ? noticeId : undefined}
                  className="flex min-h-20 w-full flex-col items-center justify-center gap-1 rounded-lg border border-primary bg-surface px-3 py-3 text-lg font-bold text-primary disabled:border-border disabled:bg-surface2 disabled:text-ink2"
                >
                  <MoreIcon name={item.key} />
                  <span className="text-center">{item.label}</span>
                  <span className="text-center text-sm font-normal text-ink2">{item.desc}</span>
                  {disabled ? <span className="sr-only">（いまは入力できません）</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      </SectionCard>
    </div>
  )
}

export default MorePage
