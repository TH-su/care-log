// 外出・外泊フォーム（記録ハブ →「外出・外泊」＝2タップ／ルート /record/outing）。
//
// 正本: docs/design/ui-design.md §6【#6新設】「利用者ピッカー（かな絞込・カルテと同一部品）／
//       区分（外出/外泊の2ボタン・文字併記）／開始時刻／終了時刻（『帰着未定』トグル= end null）／
//       付添（任意テキスト）」・§0.5（入力解禁フラグ）・contracts.md（db.ts API・共通規律）。
//       帰着の後追い記入はタイムラインの「帰着」ボタン（setOutingEnd の部分更新）が担当し、本画面は新規登録のみ。
//
// 規律:
// - supabase を直呼びしない（データアクセスは db.ts の関数のみ）
// - 実名・記録本文をコード/コメント/placeholder/console に書かない。localStorage へ何も書かない
//   （リロード時の現在地は HashRouter の URL で復元＝contracts.md「HashRouter のURLが第一」・原則11）
// - タップ要素は min-h-tap（44px）＋隣接 gap-gap（8px）。色だけで意味を伝えない（記号・文字を併記）
// - ローディング／エラー／空の3状態を実装。エラー文は「何が起きたか＋次にどうすればよいか」
// - outings と meals.status='out' を自動連動させない（db-design.md §7。本画面は食事に一切書かない）

import { useEffect, useId, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { fetchResidents, getNativeInputEnabled, insertOuting, isQueuePersisted } from '../lib/db'
import { getActorId, touchActivity } from '../lib/actor'
import { OUTING_KIND_LABEL } from '../lib/types'
import type { Outing, OutingKind, Resident } from '../lib/types'
import { todayIso } from '../lib/format'
import {
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  ResidentPickerModal,
  SectionCard,
  SegmentPicker,
  useToast,
} from '../components/ui'

/** 入力封鎖中の理由文（ui-design.md §0.5 の定型文。文言を変えない） */
const LOCKED_REASON =
  '現在はスプレッドシートで記録する期間です（アプリ入力の開始日は施設で決定します）'

const KIND_OPTIONS = [
  { value: 'outing', label: OUTING_KIND_LABEL.outing },
  { value: 'overnight', label: OUTING_KIND_LABEL.overnight },
]

const LOAD_ERROR =
  '利用者の一覧と入力設定を読み込めませんでした。通信状態を確認して、再試行してください。'

/** 送信待ちにしたのに端末へ残せなかった時の案内（入力欄は消さない・NoteFormPage と同型） */
const NOT_PERSISTED_REASON =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。入力はこの画面に残していますので、電波が戻るまでこの画面を閉じないでください。長引く場合は内容を控えてから管理者に連絡してください。'

interface FieldErrors {
  resident?: string
  kind?: string
  start?: string
  end?: string
}

export interface OutingFormPageProps {
  /** App.tsx が保持している利用者一覧。未指定ならこの画面が自前で取得する */
  residents?: Resident[]
  /** 操作者（記入者）の staff_id。未指定なら actor.ts の保持値を使う */
  actorId?: number | null
  /** 入力解禁フラグの既知値。渡された場合も §0.5 に従い表示のたびに取り直す */
  inputEnabled?: boolean
  /** 登録できたことを親へ通知する（タイムラインの再取得など。任意） */
  onSaved?: () => void
}

export function OutingFormPage({
  residents: residentsProp,
  actorId: actorIdProp,
  inputEnabled: inputEnabledProp,
  onSaved,
}: OutingFormPageProps = {}) {
  // 親から利用者一覧が渡らない場合だけ自前で取得する（渡る場合は配列の同一性に依存しない）
  const needResidentFetch = residentsProp === undefined
  const [fetchedResidents, setFetchedResidents] = useState<Resident[] | null>(null)
  const [fetchedEnabled, setFetchedEnabled] = useState<boolean | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const [residentId, setResidentId] = useState<number | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [kind, setKind] = useState<OutingKind | ''>('')
  const [startOn, setStartOn] = useState(() => todayIso())
  const [startAt, setStartAt] = useState('')
  const [endUnknown, setEndUnknown] = useState(false)
  const [endOn, setEndOn] = useState('')
  const [endAt, setEndAt] = useState('')
  const [companion, setCompanion] = useState('')

  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const { toast, show } = useToast()
  const uid = useId()
  const residentLabelId = `${uid}-resident`
  const residentErrId = `${uid}-resident-err`
  const kindErrId = `${uid}-kind-err`
  const startOnId = `${uid}-start-on`
  const startAtId = `${uid}-start-at`
  const startErrId = `${uid}-start-err`
  const endOnId = `${uid}-end-on`
  const endAtId = `${uid}-end-at`
  const endErrId = `${uid}-end-err`
  const endUnknownHintId = `${uid}-end-hint`
  const companionId = `${uid}-companion`

  // 記入者は「操作者」＝ actor レイヤー（ui-design.md §0）。props が無い場合だけ保持値を読む
  const actorId = useMemo(
    () => (actorIdProp !== undefined ? actorIdProp : getActorId()),
    [actorIdProp],
  )

  // 入力解禁フラグは「画面を開くたびに毎回取り直す」（ui-design.md §0.5・前提情報は毎回取り直す規範）。
  // 取得できなければ画面をエラー状態にして書込経路へ進ませない（安全側フォールバック）。
  useEffect(() => {
    let alive = true
    setLoadError(null)
    setFetchedEnabled(null)
    if (needResidentFetch) setFetchedResidents(null)
    Promise.all([
      needResidentFetch ? fetchResidents() : Promise.resolve(null),
      getNativeInputEnabled(),
    ])
      .then(([rs, enabled]) => {
        if (!alive) return
        if (rs) setFetchedResidents(rs)
        setFetchedEnabled(enabled)
      })
      .catch(() => {
        if (!alive) return
        setLoadError(LOAD_ERROR)
      })
    return () => {
      alive = false
    }
  }, [needResidentFetch, reloadKey])

  const errors = useMemo<FieldErrors>(() => {
    const e: FieldErrors = {}
    if (residentId == null) e.resident = '利用者を選んでください。'
    if (kind === '') e.kind = '区分（外出・外泊）を選んでください。'
    if (!startOn) e.start = '開始日を入力してください。'
    if (!endUnknown) {
      if (!endOn) {
        e.end =
          '帰着日を入力してください。まだ戻っていない場合は「帰着未定」を選んでください。'
      } else if (startOn && endOn < startOn) {
        e.end = '帰着日が開始日より前になっています。日付を確認してください。'
      } else if (startOn && endOn === startOn && startAt && endAt && endAt < startAt) {
        e.end = '帰着時刻が開始時刻より前になっています。時刻を確認してください。'
      }
    }
    return e
  }, [residentId, kind, startOn, startAt, endUnknown, endOn, endAt])

  const hasError = Object.keys(errors).length > 0

  const residents = residentsProp ?? fetchedResidents
  // 親が「封鎖」と言っている場合と、取り直した値が false の場合の両方で封鎖する（AND で安全側）
  const locked = fetchedEnabled !== true || inputEnabledProp === false

  function resetForm() {
    // 開始日は続けて入力する運用を考えて残し、個人に紐づく項目だけ消す
    setResidentId(null)
    setKind('')
    setStartAt('')
    setEndUnknown(false)
    setEndOn('')
    setEndAt('')
    setCompanion('')
    setShowErrors(false)
  }

  async function handleSubmit(ev: FormEvent) {
    ev.preventDefault()
    setSubmitError(null)
    if (locked || saving) return
    if (hasError || residentId == null || kind === '') {
      setShowErrors(true)
      return
    }
    // 「帰着未定」= end を null で明示（multi-device-sync 原則4: null と空を区別する）
    const payload: Omit<Outing, 'id' | 'rev'> = {
      resident_id: residentId,
      kind,
      start_on: startOn,
      start_at: startAt || null,
      end_on: endUnknown ? null : endOn,
      end_at: endUnknown ? null : endAt || null,
      companion: companion.trim() || null,
      note: null,
      recorded_by: actorId ?? null,
    }
    setSaving(true)
    try {
      const res = await insertOuting(payload)
      touchActivity()
      if (res === 'queued' && !isQueuePersisted()) {
        // 送信待ちにはなったが、端末に残せたことを観測できていない（保存領域の不足など）。
        // 入力はこの画面に残す（消去は保全ゲートの後ろ・multi-device-sync 原則8）
        setSubmitError(NOT_PERSISTED_REASON)
        return
      }
      if (res === 'queued') {
        show('通信できないため未送信として保存しました。電波が戻ると自動で送信します。')
      } else {
        show('外出・外泊を登録しました。')
      }
      resetForm()
      onSaved?.()
    } catch {
      setSubmitError(
        '登録できませんでした。通信状態を確認して、もう一度「登録する」を押してください。入力した内容はそのまま残っています。',
      )
    } finally {
      setSaving(false)
    }
  }

  // ── 3状態: エラー → ローディング → 空 → フォーム ──
  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <ErrorBlock message={loadError} onRetry={() => setReloadKey((n) => n + 1)} />
      </div>
    )
  }

  if (residents == null || fetchedEnabled == null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <LoadingBlock label="外出・外泊の入力画面を準備しています…" />
      </div>
    )
  }

  if (residents.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <EmptyBlock message="利用者の一覧がまだありません。設定タブでマスタ同期を実行してから、もう一度お試しください。" />
      </div>
    )
  }

  const selected = residents.find((r) => r.id === residentId) ?? null

  const inputClass =
    'min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink disabled:bg-surface2 disabled:text-ink3'
  const labelClass = 'block text-sm text-ink2'
  const errorClass = 'mt-1 text-sm text-danger'

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      {locked ? (
        <div role="status" className="rounded-lg border border-warn bg-warn-bg p-4">
          <p className="text-base text-ink">
            <span aria-hidden="true">▲ </span>
            <span className="sr-only">お知らせ: </span>
            {LOCKED_REASON}
          </p>
        </div>
      ) : null}

      {!locked && actorId == null ? (
        <div role="status" className="rounded-lg border border-warn bg-warn-bg p-4">
          <p className="text-base text-ink">
            <span aria-hidden="true">▲ </span>
            記録する職員が選ばれていないため登録できません。画面上部の職員名をタップして選び直してください。
          </p>
        </div>
      ) : null}

      <SectionCard title="外出・外泊の記録">
        <form onSubmit={handleSubmit} noValidate>
          <fieldset disabled={locked || saving} className="space-y-4">
            {/* 利用者 */}
            <div>
              <span id={residentLabelId} className={labelClass}>
                利用者
              </span>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                aria-labelledby={residentLabelId}
                aria-invalid={showErrors && !!errors.resident}
                aria-describedby={showErrors && errors.resident ? residentErrId : undefined}
                className="mt-1 flex min-h-tap w-full items-center gap-gap rounded border border-border bg-surface px-3 py-2 text-left text-base text-ink disabled:bg-surface2 disabled:text-ink3"
              >
                {selected ? (
                  <>
                    <span className="tabular min-w-12 shrink-0 text-sm text-ink3">
                      {selected.room ?? '—'}
                    </span>
                    <span className="flex-1 font-bold">{selected.name}</span>
                  </>
                ) : (
                  <span className="flex-1 text-ink2">タップして利用者を選ぶ</span>
                )}
                <span aria-hidden="true" className="shrink-0 text-ink3">
                  ▸
                </span>
              </button>
              {showErrors && errors.resident ? (
                <p id={residentErrId} role="alert" className={errorClass}>
                  <span aria-hidden="true">▲ </span>
                  {errors.resident}
                </p>
              ) : null}
            </div>

            {/* 区分（外出／外泊の2ボタン・文字併記） */}
            <div>
              <span className={labelClass}>区分</span>
              <div className="mt-1">
                <SegmentPicker
                  options={KIND_OPTIONS}
                  value={kind}
                  onChange={(v) => setKind(v as OutingKind)}
                  ariaLabel="区分（外出・外泊）"
                />
              </div>
              {showErrors && errors.kind ? (
                <p id={kindErrId} role="alert" className={errorClass}>
                  <span aria-hidden="true">▲ </span>
                  {errors.kind}
                </p>
              ) : null}
            </div>

            {/* 開始 */}
            <div className="flex flex-wrap gap-gap">
              <div className="min-w-0 flex-1">
                <label htmlFor={startOnId} className={labelClass}>
                  開始日
                </label>
                <input
                  id={startOnId}
                  type="date"
                  value={startOn}
                  onChange={(e) => setStartOn(e.target.value)}
                  aria-invalid={showErrors && !!errors.start}
                  aria-describedby={showErrors && errors.start ? startErrId : undefined}
                  className={`tabular mt-1 ${inputClass}`}
                />
              </div>
              <div className="min-w-0 flex-1">
                <label htmlFor={startAtId} className={labelClass}>
                  開始時刻（任意）
                </label>
                <input
                  id={startAtId}
                  type="time"
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                  className={`tabular mt-1 ${inputClass}`}
                />
              </div>
            </div>
            {showErrors && errors.start ? (
              <p id={startErrId} role="alert" className={errorClass}>
                <span aria-hidden="true">▲ </span>
                {errors.start}
              </p>
            ) : null}

            {/* 帰着未定トグル（end を null にする） */}
            <div>
              <label className="flex min-h-tap items-center gap-gap rounded border border-border bg-surface px-3 py-2 text-base text-ink">
                <input
                  type="checkbox"
                  checked={endUnknown}
                  onChange={(e) => setEndUnknown(e.target.checked)}
                  aria-describedby={endUnknownHintId}
                  className="h-6 w-6 shrink-0 accent-primary"
                />
                <span>帰着未定（まだ戻っていない）</span>
              </label>
              <p id={endUnknownHintId} className="mt-1 text-sm text-ink2">
                帰着日・帰着時刻を空のまま登録します。戻られたらタイムラインの「帰着」ボタンから記入できます。
              </p>
            </div>

            {/* 帰着（帰着未定のときは入力させない＝空と null を混同させない） */}
            <div className="flex flex-wrap gap-gap">
              <div className="min-w-0 flex-1">
                <label htmlFor={endOnId} className={labelClass}>
                  帰着日
                </label>
                <input
                  id={endOnId}
                  type="date"
                  value={endUnknown ? '' : endOn}
                  disabled={endUnknown}
                  onChange={(e) => setEndOn(e.target.value)}
                  aria-invalid={showErrors && !!errors.end}
                  aria-describedby={showErrors && errors.end ? endErrId : undefined}
                  className={`tabular mt-1 ${inputClass}`}
                />
              </div>
              <div className="min-w-0 flex-1">
                <label htmlFor={endAtId} className={labelClass}>
                  帰着時刻（任意）
                </label>
                <input
                  id={endAtId}
                  type="time"
                  value={endUnknown ? '' : endAt}
                  disabled={endUnknown}
                  onChange={(e) => setEndAt(e.target.value)}
                  className={`tabular mt-1 ${inputClass}`}
                />
              </div>
            </div>
            {showErrors && errors.end ? (
              <p id={endErrId} role="alert" className={errorClass}>
                <span aria-hidden="true">▲ </span>
                {errors.end}
              </p>
            ) : null}

            {/* 付添（任意） */}
            <div>
              <label htmlFor={companionId} className={labelClass}>
                付添（任意）
              </label>
              <input
                id={companionId}
                type="text"
                value={companion}
                onChange={(e) => setCompanion(e.target.value)}
                autoComplete="off"
                placeholder="例: ご家族"
                className={`mt-1 ${inputClass}`}
              />
            </div>

            {submitError ? <ErrorBlock message={submitError} /> : null}

            <div className="flex justify-end gap-gap">
              <button
                type="submit"
                disabled={locked || saving || actorId == null}
                className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:opacity-60"
              >
                {saving ? '登録中です…' : '登録する'}
              </button>
            </div>
          </fieldset>
        </form>
      </SectionCard>

      <ResidentPickerModal
        open={pickerOpen}
        residents={residents}
        onPick={(id) => {
          setResidentId(id)
          setPickerOpen(false)
        }}
        onClose={() => setPickerOpen(false)}
      />

      {toast}
    </div>
  )
}

export default OutingFormPage
