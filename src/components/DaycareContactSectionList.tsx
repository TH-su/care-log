// デイの連絡帳の「項目ごとの記載」を、各画面（バイタル・食事／活動／機能訓練）の表のすぐ下に並べる一覧（2026-11-18 親の決定・仮置き）。
// 表の幅・列・固定の試験を変えずに、その日の方ごとに今の文と〔書く〕／〔直す〕を出す。押すと各画面の DaycareContactSectionDialog を開く
// （書くのは小窓だけ。この一覧は読むだけで、文は useDaycareContactNotes の行から出す＝小窓で保存するとすぐ変わる）。
// ・並び・人は、その画面の表と同じ（呼ぶ側が同じ並びの番号を渡す）
// ・文は札ごとに3行まで見せる（続きは小窓で読める）。空は「（記載なし）」
// ・幅 1024px 以上は2〜3列の格子、狭い幅は1列。押せない時は理由の帯（useDaycareContactNotes の文）と、押せないボタン（隠さない）
// ・端末に何も残さない。氏名・記録を console に出さない。押す所は 44px 以上・画面の文字は 15px 以上
import { CONTACT_SECTION_LABEL, contactFieldValue, normalizeNoteText } from '../lib/daycareContact'
import type { ContactSectionField } from '../lib/daycareContact'
import type { DaycareContactNotesState } from '../hooks/useDaycareContactNotes'

const NO_ENTRY = '（記載なし）'
const MSG_LOADING = '連絡帳を読み込んでいます…'

export interface DaycareContactSectionListProps {
  /** この画面の欄（並びは札の中の並び） */
  fields: readonly ContactSectionField[]
  /** その日の方（表と同じ並び） */
  residentIds: readonly number[]
  nameOf: (residentId: number) => string
  contacts: Pick<DaycareContactNotesState, 'noteOf' | 'loading' | 'blockedReason'>
  /** 〔書く〕／〔直す〕を押した（各画面の小窓を開く） */
  onOpen: (residentId: number) => void
}

export function DaycareContactSectionList({ fields, residentIds, nameOf, contacts, onOpen }: DaycareContactSectionListProps) {
  const label = fields.map((f) => CONTACT_SECTION_LABEL[f]).join('・')
  const disabled = contacts.loading || contacts.blockedReason !== null
  if (residentIds.length === 0) return null
  return (
    <section className="space-y-2 rounded-lg border border-border bg-surface p-3" aria-label={`連絡帳の記載（${label}）`}>
      <h2 className="text-base font-bold text-ink">連絡帳の記載（{label}）</h2>
      {contacts.blockedReason !== null ? (
        <p role="status" className="rounded-lg border border-warn bg-warn-bg px-3 py-1.5 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {contacts.blockedReason}
        </p>
      ) : contacts.loading ? (
        <p role="status" className="text-base text-ink2">
          {MSG_LOADING}
        </p>
      ) : null}
      <ul className="grid grid-cols-1 gap-gap lg:grid-cols-2 xl:grid-cols-3">
        {residentIds.map((rid) => {
          const name = nameOf(rid)
          const note = contacts.noteOf(rid)
          const texts = fields.map((f) => ({ f, t: normalizeNoteText(contactFieldValue(note, f)) }))
          const written = texts.some((x) => x.t !== null)
          return (
            <li key={rid} className="flex min-w-0 flex-col gap-1 rounded border border-border bg-surface2 p-2">
              <div className="flex items-center justify-between gap-gap">
                <p className="min-w-0 truncate text-base font-bold text-ink">{name}</p>
                <button
                  type="button"
                  onClick={() => onOpen(rid)}
                  disabled={disabled}
                  className="inline-flex min-h-tap min-w-tap shrink-0 items-center justify-center rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:border-border disabled:text-ink3"
                >
                  {written ? '直す' : '書く'}
                  <span className="sr-only">（{name}さんの連絡帳の{label}）</span>
                </button>
              </div>
              <dl className="m-0 space-y-1">
                {texts.map(({ f, t }) => (
                  <div key={f} className="min-w-0">
                    {fields.length > 1 ? <dt className="text-sm font-bold text-ink2">{CONTACT_SECTION_LABEL[f]}</dt> : <dt className="sr-only">{CONTACT_SECTION_LABEL[f]}</dt>}
                    <dd className={`m-0 line-clamp-3 whitespace-pre-wrap break-words text-base ${t === null ? 'text-ink2' : 'text-ink'}`}>{t ?? NO_ENTRY}</dd>
                  </div>
                ))}
              </dl>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
