// デイの連絡帳の「項目ごとの記載」を各画面から書く小窓と、行に置く入口のボタン（2026-11-18 本人指示・代表者の決定「4項目」）。
// 使う画面: バイタル・食事（vital_meal_note）／活動（activity_note と behavior_note）／機能訓練（training_note）。
// 連絡帳の画面（DaycareContactPage）の同じ欄と同じ行・同じ列を書く（写しを作らない）。どちらから直しても同じ文になる。
//
// ・開いた時に、その方のその日の行を読み直してから基準にする（useDaycareContactNotes の refetch）。読めない時は保存を押せない
// ・保存は saveDaycareContactField（変えた欄だけを送る・rev 照合）。他の端末が先にその欄を書き換えていた時は上書きせず、
//   連絡帳の画面と同じ文（conflictText）で今の文を見せ、入れた文は欄に残す。次の〔保存〕はその今の行を基準にする
// ・書ける条件は連絡帳の画面とそろえる: 入力解禁は連絡帳と同じ旗（getKindInputGate('daycare')・この画面の旗とは別に取る）／
//   記録者が無い時は保存しない／未来の日は書けない／過去の日は事務所・管理者のログインだけ（canEditPastDaycareTimes）／
//   4欄の列が無い DB（0064 未適用）は書けない。止める時は隠さずに押せなくして理由の文
// ・保存していない文があるまま閉じる時は確かめる。開いている間は離れる前の確かめ（registerUnsaved）を効かせる
// ・端末に何も残さない（localStorage を使わない）。氏名・記録を console に出さない。押す所は 44px 以上・画面の文字は 15px 以上
import { useEffect, useRef, useState } from 'react'
import {
  DbError,
  FORBIDDEN_REASON,
  OUTDATED_REASON,
  cachedMyRole,
  contactSectionsReady,
  fetchMyRole,
  getKindInputGate,
  kindBlockedMessage,
  saveDaycareContactField,
  subscribeMyRole,
} from '../lib/db'
import type { MyRole } from '../lib/db'
import { canEditPastDaycareTimes } from '../lib/daycare'
import {
  CONTACT_SECTION_LABEL,
  CONTACT_SECTION_MAX,
  conflictText,
  contactFieldValue,
  contactNoteOf,
  noteLength,
  normalizeNoteText,
} from '../lib/daycareContact'
import type { ContactSectionField, DaycareContactNote } from '../lib/daycareContact'
import { registerUnsaved } from '../lib/leaveGuard'
import { fmtDayLabel } from '../lib/format'
import { ModalShell } from './ui'
import type { DaycareContactNotesState } from '../hooks/useDaycareContactNotes'
import { MSG_CONTACT_ENTRY_SECTIONS } from '../hooks/useDaycareContactNotes'

// ── 文言（連絡帳の画面の言葉づかいに合わせる） ──
const MSG_LOADING = '連絡帳を読み込んでいます…'
const MSG_READ_FAILED = '連絡帳を読み込めませんでした。通信状態を確認して、〔もう一度読む〕を押してください（読めるまで保存できません）。'
const MSG_GATE_UNKNOWN = 'デイの記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、もう一度開いてください。'
const MSG_PAST_OFFICE = '過去の日の連絡帳は、事務所のログインでだけ書けます（現場の端末は当日だけ）。'
const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから保存してください。'
const MSG_FUTURE = '未来の日には書けません。'
const MSG_OFFLINE = '保存できませんでした。通信状態を確認して、もう一度押してください。'
const MSG_DISCARD_TITLE = '保存していない文があります'
const MSG_DISCARD_BODY = 'このまま閉じると、入れた文は連絡帳に残りません。閉じてよろしいですか。'

const BTN = 'inline-flex min-h-tap items-center justify-center rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:border-border disabled:text-ink3'
const BTN_PRIMARY =
  'inline-flex min-h-tap items-center justify-center rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border disabled:bg-surface disabled:text-ink3'

/** 欄の下の知らせ */
type FieldMsg = { tone: 'ok' | 'warn' | 'danger'; text: string }

export interface DaycareContactSectionDialogProps {
  /** 開いている方（null＝閉じている） */
  residentId: number | null
  /** 氏名（見出しと読み上げに出すだけ） */
  name: string
  /** 業務日 */
  day: string
  /** 今日（未来・過去の日の判定） */
  today: string
  /** この画面から書く欄（並びは画面の並び） */
  fields: readonly ContactSectionField[]
  /** 記録者（App.tsx の操作者） */
  actorId: number | null
  /** その日の連絡帳の行（useDaycareContactNotes） */
  contacts: Pick<DaycareContactNotesState, 'refetch' | 'put'>
  onClose: () => void
}

/** 1人分の、指定した欄だけを書く小窓 */
export function DaycareContactSectionDialog(props: DaycareContactSectionDialogProps) {
  // 開くたびに中身を作り直す（前の方の入れかけ・知らせを次の方へ持ち越さない）
  if (props.residentId === null) return null
  return <SectionDialogBody key={`${props.residentId}:${props.day}`} {...props} residentId={props.residentId} />
}

function SectionDialogBody({ residentId, name, day, today, fields, actorId, contacts, onClose }: DaycareContactSectionDialogProps & { residentId: number }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  /** 欄ごとの保存の基準（開いた時に読んだ行・競合の時は今の行） */
  const [base, setBase] = useState<Partial<Record<ContactSectionField, DaycareContactNote | null>>>({})
  /** 入れかけた文（欄ごと・画面のメモリだけ） */
  const [drafts, setDrafts] = useState<Partial<Record<ContactSectionField, string>>>({})
  const [msgs, setMsgs] = useState<Partial<Record<ContactSectionField, FieldMsg>>>({})
  const [saving, setSaving] = useState(false)
  const [askClose, setAskClose] = useState(false)
  const [gate, setGate] = useState<{ value: boolean; observed: boolean; forbidden?: true; outdated?: true } | null>(null)
  const [role, setRole] = useState<MyRole | null | undefined>(cachedMyRole())
  const [readTick, setReadTick] = useState(0)
  const firstRef = useRef<HTMLTextAreaElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const dirtyRef = useRef(false)

  // ── 開いた時: その方のその日の行を読み直す（基準）・入力解禁（連絡帳と同じ旗）・ログインの役割 ──
  useEffect(() => {
    let alive = true
    setPhase('loading')
    contacts
      .refetch()
      .then((rows) => {
        if (!alive) return
        const row = contactNoteOf(rows, residentId, day)
        setBase(Object.fromEntries(fields.map((f) => [f, row])) as Partial<Record<ContactSectionField, DaycareContactNote | null>>)
        setPhase('ready')
      })
      .catch(() => alive && setPhase('failed'))
    return () => {
      alive = false
    }
    // 開いた時と〔もう一度読む〕の時だけ読む
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readTick])
  useEffect(() => {
    let alive = true
    getKindInputGate('daycare')
      .then((g) => alive && setGate(g))
      .catch(() => alive && setGate({ value: false, observed: false }))
    const ask = () => {
      void fetchMyRole().then((r) => {
        if (alive) setRole(r)
      })
    }
    ask()
    const off = subscribeMyRole(ask)
    return () => {
      alive = false
      off()
    }
  }, [])

  const savedOf = (f: ContactSectionField): string | null => normalizeNoteText(contactFieldValue(base[f] ?? null, f))
  const draftOf = (f: ContactSectionField): string => drafts[f] ?? savedOf(f) ?? ''
  const isDirty = (f: ContactSectionField): boolean => f in drafts && normalizeNoteText(drafts[f]) !== savedOf(f)
  const dirtyFields = fields.filter(isDirty)
  dirtyRef.current = dirtyFields.length > 0

  // 開いている間は、保存していない文があれば離れる前に確かめる（App の確認と再読み込みの警告）
  useEffect(() => registerUnsaved(() => dirtyRef.current), [])
  // 閉じる前の確かめに切り替えた時は〔戻って書く〕へ（入力の欄が消えて、どこにも当たっていない状態にしない）
  useEffect(() => {
    if (askClose) backRef.current?.focus()
  }, [askClose])

  // ── 書けるか（止める理由。null＝書ける） ──
  const gateOpen = gate !== null && gate.observed && gate.value === true
  const blocked: string | null =
    day > today
      ? MSG_FUTURE
      : day < today && !canEditPastDaycareTimes(role)
        ? MSG_PAST_OFFICE
        : !contactSectionsReady()
          ? MSG_CONTACT_ENTRY_SECTIONS
          : gate === null
            ? null
            : !gateOpen
              ? gate.forbidden
                ? FORBIDDEN_REASON
                : gate.outdated
                  ? OUTDATED_REASON
                  : gate.observed
                    ? `${kindBlockedMessage('daycare')}。`
                    : MSG_GATE_UNKNOWN
              : null
  const inputsOn = phase === 'ready' && blocked === null && gate !== null && !saving
  const canSave = inputsOn && actorId !== null && dirtyFields.length > 0

  const setMsg = (f: ContactSectionField, m: FieldMsg | null) =>
    setMsgs((prev) => {
      const next = { ...prev }
      if (m === null) delete next[f]
      else next[f] = m
      return next
    })

  const onInput = (f: ContactSectionField, v: string) => {
    setDrafts((prev) => ({ ...prev, [f]: v }))
    if (msgs[f]?.tone === 'ok') setMsg(f, null)
  }

  /** 変えた欄だけを1つずつ送る（送り先＝人・日は開いた時のもので固定） */
  const save = async () => {
    if (!canSave || actorId === null) return
    setSaving(true)
    /** この回の保存で返ってきた最後の行（行の無い方に2欄を書く時、2欄目を足し直さずにこの行を直す） */
    let latest: DaycareContactNote | null = null
    try {
      for (const f of dirtyFields) {
        setMsg(f, null)
        try {
          const r = await saveDaycareContactField({
            residentId,
            day,
            field: f,
            text: drafts[f] ?? '',
            // その欄の値が開いた時と同じなら、直前に返った行を基準にする（読み直しの往復を減らす。値が違えば開いた時の行のまま＝競合で止める）
            base:
              latest !== null && normalizeNoteText(contactFieldValue(latest, f)) === normalizeNoteText(contactFieldValue(base[f] ?? null, f))
                ? latest
                : (base[f] ?? null),
            recordedBy: actorId,
            editedBy: actorId,
          })
          if (r.kind === 'saved') {
            setDrafts((prev) => {
              const next = { ...prev }
              delete next[f]
              return next
            })
            if (r.row !== null) {
              latest = r.row
              contacts.put(r.row)
              // ほかの欄の基準も、その欄の値が同じなら新しい行にする（次の保存で読み直しを1回減らす）
              const row = r.row
              setBase((prev) => {
                const next = { ...prev, [f]: row }
                for (const g of fields) {
                  if (g !== f && normalizeNoteText(contactFieldValue(prev[g] ?? null, g)) === normalizeNoteText(contactFieldValue(row, g))) next[g] = row
                }
                return next
              })
            }
            setMsg(f, { tone: 'ok', text: '✓ 保存しました' })
          } else {
            // 上書きしていない。いまの行を次の保存の基準にし、入れた文は欄に残す
            const cur = r.row === null ? null : contactFieldValue(r.row, f)
            setBase((prev) => ({ ...prev, [f]: r.row }))
            if (r.row !== null) contacts.put(r.row)
            setMsg(f, { tone: 'warn', text: conflictText(cur) })
          }
        } catch (e) {
          // 通信できない・封鎖・長すぎる・過去の日の守り など: 入れた文は欄に残す（消さない）
          setMsg(f, { tone: 'danger', text: e instanceof DbError ? e.message : MSG_OFFLINE })
        }
      }
    } finally {
      setSaving(false)
    }
  }

  const tryClose = () => {
    if (saving) return
    if (dirtyRef.current) setAskClose(true)
    else onClose()
  }

  const label = fields.map((f) => CONTACT_SECTION_LABEL[f]).join('・')
  return (
    <ModalShell open label={`${name}さんの連絡帳（${label}）`} onClose={tryClose} initialFocus={firstRef} fitVisualViewport>
      {askClose ? (
        <>
          <div className="space-y-2 p-4">
            <h2 className="text-lg font-bold text-ink">{MSG_DISCARD_TITLE}</h2>
            <p className="text-base text-ink">{MSG_DISCARD_BODY}</p>
          </div>
          <div className="flex flex-wrap justify-end gap-gap border-t border-border p-4">
            <button type="button" ref={backRef} onClick={() => setAskClose(false)} className={BTN}>
              戻って書く
            </button>
            <button type="button" onClick={onClose} className={BTN}>
              保存せずに閉じる
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto p-4">
            <div>
              <h2 className="text-lg font-bold text-ink">連絡帳に書く</h2>
              <p className="text-base text-ink">
                {name} 様<span className="ml-2 text-ink2">{fmtDayLabel(day)}</span>
              </p>
              <p className="text-sm text-ink2">連絡帳の画面の同じ欄と同じ文です（どちらから直しても同じになります）。紙には保存した文が載ります。</p>
            </div>
            {phase === 'loading' ? (
              <p role="status" className="text-base text-ink2">
                {MSG_LOADING}
              </p>
            ) : null}
            {phase === 'failed' ? (
              <div role="alert" className="space-y-2 rounded border border-warn bg-warn-bg p-2 text-base text-ink">
                <p>
                  <span aria-hidden="true">▲ </span>
                  {MSG_READ_FAILED}
                </p>
                <button type="button" onClick={() => setReadTick((n) => n + 1)} className={BTN}>
                  もう一度読む
                </button>
              </div>
            ) : null}
            {blocked !== null ? (
              <p role="status" className="rounded border border-warn bg-warn-bg p-2 text-base text-ink">
                <span aria-hidden="true">▲ </span>
                {blocked}
              </p>
            ) : null}
            {fields.map((f, i) => {
              const id = `dcs-${residentId}-${f}`
              const value = draftOf(f)
              const m = msgs[f]
              return (
                <div key={f} className="space-y-1">
                  <label htmlFor={id} className="block text-base font-bold text-ink">
                    {CONTACT_SECTION_LABEL[f]}
                  </label>
                  <textarea
                    id={id}
                    ref={i === 0 ? firstRef : undefined}
                    value={value}
                    // 上限を超えて入れられない（maxLength は UTF-16 の数で数える＝字数より多くは入らない。送る前に字数でも確かめる）
                    maxLength={CONTACT_SECTION_MAX}
                    rows={3}
                    disabled={!inputsOn}
                    onChange={(e) => onInput(f, e.target.value)}
                    className="block w-full rounded border border-border-strong bg-surface p-2 text-base text-ink disabled:bg-surface2 disabled:text-ink3"
                    aria-describedby={`${id}-count`}
                  />
                  <div className="flex flex-wrap items-center gap-gap">
                    <span id={`${id}-count`} className="text-sm text-ink2">
                      {noteLength(value)}／{CONTACT_SECTION_MAX}字
                    </span>
                    {isDirty(f) ? (
                      <span className="text-sm font-bold text-ink">
                        <span aria-hidden="true">✎ </span>未保存
                      </span>
                    ) : null}
                  </div>
                  {m !== undefined ? (
                    <p
                      role={m.tone === 'danger' ? 'alert' : 'status'}
                      className={`rounded border p-2 text-sm text-ink ${
                        m.tone === 'danger' ? 'border-danger bg-danger-bg' : m.tone === 'warn' ? 'border-warn bg-warn-bg' : 'border-border bg-surface2'
                      }`}
                    >
                      {m.tone === 'danger' || m.tone === 'warn' ? <span aria-hidden="true">▲ </span> : null}
                      {m.text}
                    </p>
                  ) : null}
                </div>
              )
            })}
            {phase === 'ready' && blocked === null && actorId === null ? (
              <p role="status" className="rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
                <span aria-hidden="true">▲ </span>
                {MSG_NO_RECORDER}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap justify-end gap-gap border-t border-border p-4">
            <button type="button" onClick={tryClose} disabled={saving} className={BTN}>
              閉じる
            </button>
            <button type="button" onClick={() => void save()} disabled={!canSave} className={BTN_PRIMARY}>
              {saving ? '保存しています…' : '保存'}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  )
}

/**
 * 行に置く連絡帳の入口（44px）。書いてある時は「✓ 連絡帳」、まだの時は「連絡帳 ✎」（色だけで分けない）。
 * 幅は2つの形のどちらでも同じ（状態が変わっても列・段の幅が動かない）
 */
export function DaycareContactEntryButton({
  name,
  written,
  disabled,
  onClick,
  sectionLabel,
  widthCls = 'w-28',
}: {
  name: string
  /** この画面の欄のどれかが書いてある */
  written: boolean
  disabled: boolean
  onClick: () => void
  /** 読み上げに添える欄の名前（例「活動・行動・ご様子」） */
  sectionLabel: string
  /** 幅（既定は2つの形のどちらも入る 112px。置き場所に合わせて広げる時だけ渡す） */
  widthCls?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-tap ${widthCls} shrink-0 items-center justify-center whitespace-nowrap rounded border border-border-strong bg-surface px-1 text-base text-ink disabled:border-border disabled:text-ink3`}
    >
      {written ? (
        <>
          <span aria-hidden="true">✓ </span>連絡帳
        </>
      ) : (
        <>
          連絡帳<span aria-hidden="true"> ✎</span>
        </>
      )}
      <span className="sr-only">
        （{name}さんの{sectionLabel}{written ? '・書いてあります' : '・まだ書いていません'}）
      </span>
    </button>
  )
}
