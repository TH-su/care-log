// 記録ハブ（ルート /record・ボトムタブ「記録」の入口）。
//
// 正本: docs/design/ui-design.md §1「記録ハブ画面:『バイタル一括』『食事一括』『申し送り』『外出・外泊』の
//       4大ボタン2×2グリッド（各 min-height 72px・アイコン＋17px文字・gap 8px以上）」・§0.5（入力解禁フラグ）、
//       docs/design/contracts.md（ルート定義・db.ts API・共通規律）。
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
// - ローディング: 入力解禁フラグの取得中
// - エラー   : フラグを取得できなかった時（＝可否が不明なので入力へ進ませない・再試行ボタン付き）
// - 空     : 封鎖中＝いま使える入力が1つも無い状態。ボタンは隠さずディセーブルにし、理由文と
//            「いま何ができるか」を併記する（ui-design.md §0.5）
//
// 寸法メモ（トークン外の値を直書きしないための読み替え）:
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

/**
 * 封鎖中に「次にどうすればよいか」を示す一文。
 * 導線は App.tsx のナビ定義に合わせる（<1024px の下部タブは 日報／バイタル／食事／カルテ／その他 の5つ。
 * タイムライン・検索・設定は「その他」の中）。実在しないタブへ案内しない
 */
const LOCKED_NEXT =
  '記録の閲覧・検索・カルテはこれまでどおり使えます。カルテは下のタブから、タイムライン・検索は下のタブ「その他」から開けます。'

// 封鎖中は App.tsx 側の <fieldset disabled> によりこの再試行ボタンも押せなくなるため、
// 代替の回復手順（タブを移動して記録画面を開き直す＝フラグを取り直す）まで書いておく
const LOAD_ERROR =
  'アプリで入力できる期間かどうかを確認できませんでした。通信状態を確認して［再試行する］を押してください。押せない場合は、下のタブで日報などほかの画面に移ってから、下のタブ「その他」→「記録」をもう一度開いてください。'

type HubKey = 'vitals' | 'meals' | 'note' | 'outing'

/** 2×2 の並び順（左上→右上→左下→右下）。ルートは contracts.md のルーティング定義どおり */
const ITEMS: { key: HubKey; to: string; label: string }[] = [
  { key: 'vitals', to: '/record/vitals', label: 'バイタル一括' },
  { key: 'meals', to: '/record/meals', label: '食事一括' },
  { key: 'note', to: '/record/note', label: '申し送り' },
  { key: 'outing', to: '/record/outing', label: '外出・外泊' },
]

/** アイコンは必ず文字ラベルと併記する（アイコン単独では意味を持たせない） */
const ICON_PATHS: Record<HubKey, ReactNode> = {
  // 脈波
  vitals: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
  // 器と箸
  meals: (
    <>
      <path d="M3.5 11h11a5.5 5.5 0 0 1-5.5 5.5H9A5.5 5.5 0 0 1 3.5 11z" />
      <path d="M5 19h8" />
      <path d="M18.5 4.5L17 12" />
      <path d="M21.5 5L20 12" />
    </>
  ),
  // 吹き出し
  note: (
    <>
      <path d="M4 5h16v11H9.5L4 20V5z" />
      <path d="M8 9h8M8 12.5h5" />
    </>
  ),
  // 出入口と矢印
  outing: (
    <>
      <path d="M13 4H5v16h8" />
      <path d="M10 12h10" />
      <path d="M17 9l3 3-3 3" />
    </>
  ),
}

function HubIcon({ name }: { name: HubKey }) {
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

export interface RecordHubPageProps {
  /** 入力解禁フラグの既知値。渡された場合も §0.5 に従い画面表示のたびに取り直す */
  inputEnabled?: boolean
}

export function RecordHubPage({ inputEnabled: inputEnabledProp }: RecordHubPageProps = {}) {
  const navigate = useNavigate()
  const uid = useId()
  const reasonId = `${uid}-locked`

  const [fetchedEnabled, setFetchedEnabled] = useState<boolean | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // 入力解禁フラグは「記録タブを表示するたびに毎回取り直す」（ui-design.md §0.5・前提情報は毎回取り直す規範）。
  // 取得できなければ入力へ進ませない（安全側フォールバック）。
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

  // 親が「封鎖」と言っている場合と、取り直した値が false の場合の両方で封鎖する（安全側）
  const locked = fetchedEnabled !== true || inputEnabledProp === false

  const open = useCallback(
    (to: string) => {
      if (locked) return // UI のディセーブルに加えた二重ガード（ui-design.md §0.5）
      navigate(to)
    },
    [locked, navigate],
  )

  // ── 3状態: エラー → ローディング → 本体（封鎖中は「空」相当の案内＋ディセーブル）──
  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <ErrorBlock message={loadError} onRetry={() => setReloadKey((n) => n + 1)} />
      </div>
    )
  }

  if (fetchedEnabled == null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <LoadingBlock label="記録メニューを準備しています…" />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      {locked ? (
        <div id={reasonId} role="status" className="rounded-lg border border-warn bg-warn-bg p-4">
          <p className="text-base text-ink">
            <span aria-hidden="true">▲ </span>
            <span className="sr-only">お知らせ: </span>
            {LOCKED_REASON}
          </p>
          <p className="mt-2 text-base text-ink2">{LOCKED_NEXT}</p>
        </div>
      ) : null}

      <SectionCard title="記録メニュー">
        <ul className="grid grid-cols-2 gap-gap">
          {ITEMS.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => open(item.to)}
                disabled={locked}
                aria-describedby={locked ? reasonId : undefined}
                className="flex min-h-20 w-full flex-col items-center justify-center gap-1 rounded-lg border border-primary bg-surface px-3 py-3 text-lg font-bold text-primary disabled:border-border disabled:bg-surface2 disabled:text-ink2"
              >
                <HubIcon name={item.key} />
                <span className="text-center">{item.label}</span>
                {locked ? <span className="sr-only">（いまは入力できません）</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  )
}

export default RecordHubPage
