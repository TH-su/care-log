// バイタル・食事の画面に出す「今の記録者」と、その場での切り替え（F38・2026-10-10 本人回答）。
// 1台の端末を複数の職員で使うため、前の人が選んだ記録者のまま次の人がバイタル・食事を入れると、
// recorded_by・edited_by・既読が前の人の名前で付く。これらの画面には行ごとの記入者欄が無いので、
// 画面の上に「記録者: 職員01〔変更〕」を常に出して気づけるようにし、1タップで選び直せるようにする。
//
// ・本人回答は「常に表示して、すぐ切り替えられるようにするだけ」。既定を時間・日付で自動的に外すことはしない
// ・切り替えは記録者の既定（actor.setActorId）を変える＝設定タブの「記録する職員」と同じもの。
//   App は actor.subscribeActor で受けて actorId・edited_by（setEditor）を取り直し、この部品の actorId も新しくなる
// ・表示するのは渡された actorId（＝この画面が記録に使う記録者）。端末に保存された値ではなく、実際に記録に付く方を出す
// ・印刷には出さない（print:hidden）。高さは文字に合わせ、行の高さ・列の幅には関わらない（操作バーに置く）
// ・氏名は名簿から引くだけで、localStorage・console には出さない
// 規律: トークン由来クラスのみ・色だけで意味を伝えない（文字で「記録者」と出す）・押す所は min-h-tap

import { useEffect, useState } from 'react'
import { fetchStaff } from '../lib/db'
import { setActorId } from '../lib/actor'
import type { Staff } from '../lib/types'
import { StaffPickerModal } from './ui'

export interface RecorderBarProps {
  /** この画面が記録に使う記録者（App から渡っている actorId）。null＝未選択（記録者なしで保存される） */
  actorId: number | null
  /** 職員名簿（在籍のみ）。持っていない画面は省略（この部品が画面にいる間に1回だけ取りに行く） */
  staff?: Staff[] | null
  /** 選んだ後に呼ぶ（省略可）。記録者の既定の切り替え（actor.setActorId）はこの部品がする */
  onPick?: (id: number) => void
  /** 置く場所に合わせた余白など（操作バーの中なら省略） */
  className?: string
}

/** 記録者の表示と切り替え。バイタル一覧・食事一覧・バイタル一括・食事一括の操作バーに置く */
export function RecorderBar({ actorId, staff = null, onPick, className = '' }: RecorderBarProps) {
  const [open, setOpen] = useState(false)
  const [fetched, setFetched] = useState<Staff[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const roster = staff ?? fetched

  // 名簿を持っていない画面では、ここで1回だけ取る（取れなければ「職員ID n」で出し、押した時にもう一度取る）
  useEffect(() => {
    if (staff !== null) return
    let alive = true
    setFailed(false)
    fetchStaff()
      .then((list) => {
        if (alive) setFetched(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [staff, retry])

  const name = actorId === null ? null : (roster?.find((s) => s.id === actorId)?.name ?? null)
  const label =
    actorId === null ? '未選択' : name !== null ? name : roster === null && !failed ? '…' : `職員ID ${actorId}`
  const candidates = (roster ?? []).filter((s) => s.active)

  const openPicker = () => {
    if (roster === null && failed) setRetry((n) => n + 1) // 名簿を取れていなければ取り直してから開く
    setOpen(true)
  }

  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-2 print:hidden ${className}`}>
      <p className="min-w-0 break-words text-sm text-ink">
        <span className="text-ink2">記録者: </span>
        <span className="font-bold">{label}</span>
      </p>
      <button
        type="button"
        onClick={openPicker}
        aria-label={actorId === null ? '記録者を選ぶ（いまは未選択）' : `記録者を切り替える（いまは${label}）`}
        className="min-h-tap shrink-0 rounded border border-primary bg-surface px-3 text-sm font-bold text-primary"
      >
        {actorId === null ? '選ぶ' : '変更'}
      </button>
      <StaffPickerModal
        // 名簿を読めるまでは開かない（読み込み中に空の一覧を見せない）。読めた後は空でも開く＝閉じられるので行き止まりにならない
        open={open && roster !== null}
        staff={candidates}
        onPick={(id) => {
          setActorId(id)
          setOpen(false)
          onPick?.(id)
        }}
        onClose={() => setOpen(false)}
        title={name !== null ? `記録者を切り替える（いまは「${name}」）` : '記録者を選ぶ'}
      />
    </div>
  )
}
