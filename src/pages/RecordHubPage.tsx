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
// 入浴（デイ）（2026-09-26 追加）:
// - 5つ目の項目。封鎖の判定だけが他と違い、app_settings の input_enabled_bath（getKindInputGate('bath')）で決める。
//   他の4つ（バイタル一括・食事一括・申し送り・外出・外泊）の封鎖判定は従来どおり native_input_enabled のまま
// - 入浴の旗を取得できない時は入浴のボタンだけを押せなくする（他の4つの表示・封鎖には影響させない）
//
// 与薬チェック（2026-09-26 追加）:
// - 6つ目の項目。封鎖は app_settings の input_enabled_med（getKindInputGate('med')）で決める（入浴と同じ作り）。
//   取得できない時は与薬のボタンだけを押せなくする（他の項目の表示・封鎖には影響させない）
//
// 事故・ヒヤリハット（2026-09-26 追加）:
// - 7つ目の項目。行き先は一覧（/incident）。封鎖は app_settings の input_enabled_incident（getKindInputGate('incident')）で決める
//   （入浴・与薬と同じ作り）。取得できない時はこのボタンだけを押せなくする（一覧は「その他」からも開ける）
//
// 寸法メモ（トークン外の値を直書きしないための読み替え）:
// - min-height 72px … 4px グリッドの利用可能値が 64px / 80px のため、下回らない側の min-h-20（80px）を使う
// - 17px 文字   … ops 系統のトークンは fs-base=16px / fs-lg=18px。下回らない側の text-lg（18px）を使う

import { useCallback, useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { getKindInputGate, getNativeInputGate, kindBlockedMessage } from '../lib/db'
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

type HubKey = 'vitals' | 'meals' | 'note' | 'outing' | 'bath' | 'med' | 'incident'

/** 2×2 の並び順（左上→右上→左下→右下）。ルートは contracts.md のルーティング定義どおり */
const ITEMS: { key: HubKey; to: string; label: string }[] = [
  { key: 'vitals', to: '/record/vitals', label: 'バイタル一括' },
  { key: 'meals', to: '/record/meals', label: '食事一括' },
  { key: 'note', to: '/record/note', label: '申し送り' },
  { key: 'outing', to: '/record/outing', label: '外出・外泊' },
  // 封鎖は input_enabled_bath で判定する（下の bathLocked）
  { key: 'bath', to: '/record/bath', label: '入浴（デイ）' },
  // 封鎖は input_enabled_med で判定する（下の medLocked）
  { key: 'med', to: '/record/med', label: '与薬チェック' },
  // 封鎖は input_enabled_incident で判定する（下の incidentLocked）
  { key: 'incident', to: '/incident', label: '事故・ヒヤリハット' },
]

/** 入浴の旗を取得できなかった時の一言（入浴のボタンだけに付ける） */
const BATH_GATE_UNKNOWN =
  '入浴の記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、この画面を開き直してください。'

/** 与薬の旗を取得できなかった時の一言（与薬のボタンだけに付ける） */
const MED_GATE_UNKNOWN =
  '与薬の記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、この画面を開き直してください。'

/** 事故・ヒヤリハットの旗を取得できなかった時の一言（このボタンだけに付ける） */
const INCIDENT_GATE_UNKNOWN =
  '事故・ヒヤリハットの記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、この画面を開き直してください。'

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
  // 湯気と浴槽
  bath: (
    <>
      <path d="M3.5 12h17v2.5a5 5 0 0 1-5 5h-7a5 5 0 0 1-5-5V12z" />
      <path d="M8 9c0-1 1-1.5 1-2.5M12 9c0-1 1-1.5 1-2.5M16 9c0-1 1-1.5 1-2.5" />
    </>
  ),
  // カプセル（薬）
  med: (
    <>
      <rect x="3.5" y="8.5" width="17" height="7" rx="3.5" transform="rotate(-35 12 12)" />
      <path d="M9.6 8.6l4.8 6.8" />
    </>
  ),
  // 注意の三角（事故・ヒヤリハット）
  incident: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4.5M12 17.5v.01" />
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
  const bathReasonId = `${uid}-bath-locked`
  const medReasonId = `${uid}-med-locked`
  const incidentReasonId = `${uid}-incident-locked`

  const [fetchedEnabled, setFetchedEnabled] = useState<boolean | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  /** 入浴の旗（null＝取得中、observed=false＝取得できなかった） */
  const [bathGate, setBathGate] = useState<{ value: boolean; observed: boolean } | null>(null)
  /** 与薬の旗（null＝取得中、observed=false＝取得できなかった） */
  const [medGate, setMedGate] = useState<{ value: boolean; observed: boolean } | null>(null)
  /** 事故・ヒヤリハットの旗（null＝取得中、observed=false＝取得できなかった） */
  const [incidentGate, setIncidentGate] = useState<{ value: boolean; observed: boolean } | null>(null)

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

  // 入浴の旗（input_enabled_bath）も画面を開くたびに取り直す。取得できなくても他の4つには影響させない
  useEffect(() => {
    let alive = true
    setBathGate(null)
    getKindInputGate('bath')
      .then((g) => {
        if (alive) setBathGate(g)
      })
      .catch(() => {
        if (alive) setBathGate({ value: false, observed: false })
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  // 与薬の旗（input_enabled_med）も画面を開くたびに取り直す。取得できなくても他の項目には影響させない
  useEffect(() => {
    let alive = true
    setMedGate(null)
    getKindInputGate('med')
      .then((g) => {
        if (alive) setMedGate(g)
      })
      .catch(() => {
        if (alive) setMedGate({ value: false, observed: false })
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  // 事故・ヒヤリハットの旗（input_enabled_incident）も画面を開くたびに取り直す。取得できなくても他の項目には影響させない
  useEffect(() => {
    let alive = true
    setIncidentGate(null)
    getKindInputGate('incident')
      .then((g) => {
        if (alive) setIncidentGate(g)
      })
      .catch(() => {
        if (alive) setIncidentGate({ value: false, observed: false })
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  // 親が「封鎖」と言っている場合と、取り直した値が false の場合の両方で封鎖する（安全側）
  const locked = fetchedEnabled !== true || inputEnabledProp === false
  /** 入浴は自分の旗だけで決める（取得中・取得できない間は押せない＝安全側） */
  const bathLocked = bathGate === null || !bathGate.observed || bathGate.value !== true
  /** 与薬も自分の旗だけで決める（取得中・取得できない間は押せない＝安全側） */
  const medLocked = medGate === null || !medGate.observed || medGate.value !== true
  /** 事故・ヒヤリハットも自分の旗だけで決める（取得中・取得できない間は押せない＝安全側） */
  const incidentLocked = incidentGate === null || !incidentGate.observed || incidentGate.value !== true
  const lockedOf = (key: HubKey): boolean =>
    key === 'incident' ? incidentLocked : key === 'bath' ? bathLocked : key === 'med' ? medLocked : locked

  const open = useCallback(
    (to: string, itemLocked: boolean) => {
      if (itemLocked) return // UI のディセーブルに加えた二重ガード（ui-design.md §0.5）
      navigate(to)
    },
    [navigate],
  )

  // ── 3状態: エラー → ローディング → 本体（封鎖中は「空」相当の案内＋ディセーブル）──
  // native_input_enabled を取得できなかった時も、入浴のボタンは input_enabled_bath の値だけで判定する（レビュー L4）。
  // そのためエラーでもメニューは出し、他の4つは従来どおり押せない（locked＝取得できていない間は封鎖）
  if (loadError == null && fetchedEnabled == null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <LoadingBlock label="記録メニューを準備しています…" />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      {loadError ? (
        <div id={reasonId}>
          <ErrorBlock message={loadError} onRetry={() => setReloadKey((n) => n + 1)} />
        </div>
      ) : locked ? (
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
          {ITEMS.map((item) => {
            const itemLocked = lockedOf(item.key)
            const describedBy = !itemLocked
              ? undefined
              : item.key === 'bath'
                ? bathGate === null
                  ? undefined
                  : bathReasonId
                : item.key === 'med'
                  ? medGate === null
                    ? undefined
                    : medReasonId
                  : item.key === 'incident'
                    ? incidentGate === null
                      ? undefined
                      : incidentReasonId
                    : reasonId
            return (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => open(item.to, itemLocked)}
                  disabled={itemLocked}
                  aria-describedby={describedBy}
                  className="flex min-h-20 w-full flex-col items-center justify-center gap-1 rounded-lg border border-primary bg-surface px-3 py-3 text-lg font-bold text-primary disabled:border-border disabled:bg-surface2 disabled:text-ink2"
                >
                  <HubIcon name={item.key} />
                  <span className="text-center">{item.label}</span>
                  {itemLocked ? <span className="sr-only">（いまは入力できません）</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
        {/* 入浴の封鎖の理由（他の4つの理由文とは別。入浴だけ解禁・入浴だけ封鎖のどちらもあり得る） */}
        {bathGate !== null && bathLocked ? (
          <p id={bathReasonId} role="status" className="mt-3 text-sm text-ink2">
            <span aria-hidden="true">▲ </span>
            入浴（デイ）: {bathGate.observed ? kindBlockedMessage('bath') : BATH_GATE_UNKNOWN}
          </p>
        ) : null}
        {/* 与薬の封鎖の理由（入浴と同じく他の項目の理由文とは別） */}
        {medGate !== null && medLocked ? (
          <p id={medReasonId} role="status" className="mt-3 text-sm text-ink2">
            <span aria-hidden="true">▲ </span>
            与薬チェック: {medGate.observed ? kindBlockedMessage('med') : MED_GATE_UNKNOWN}
          </p>
        ) : null}
        {/* 事故・ヒヤリハットの封鎖の理由（一覧の閲覧は「その他」からできる） */}
        {incidentGate !== null && incidentLocked ? (
          <p id={incidentReasonId} role="status" className="mt-3 text-sm text-ink2">
            <span aria-hidden="true">▲ </span>
            事故・ヒヤリハット: {incidentGate.observed ? kindBlockedMessage('incident') : INCIDENT_GATE_UNKNOWN}
            （一覧の閲覧は「その他」→「事故・ヒヤリハット」からできます）
          </p>
        ) : null}
      </SectionCard>
    </div>
  )
}

export default RecordHubPage
