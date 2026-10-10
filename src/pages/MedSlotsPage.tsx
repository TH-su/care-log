// 服薬の時間帯（ルート /med/slots・「その他」から）。2026-09-26 追加。
//
// 在籍の入居者ごとに、服薬のある時間帯（朝・昼・夕・眠前）と備考を設定する。与薬チェックの表はこの設定で
// 「押せるマス」と「—」を決める。薬の名前は持たない（処方の正本は入居者マスタ）。
// 変更は行ごとに保存する（無ければ追加・あれば rev 照合の更新。他の端末が先に変えていたら入力を残して読み直しを促す）。
// 書きかけ（下書き）は編集を始めた時の設定（基準: 時間帯・備考・版）を持ち、保存はその版で送る（2026-10-10 F54）。
// 他の端末の変更を読み直したら（競合の後・通知・「最新を読み込む」・送信待ちが届いた後）、自分が変えた時間帯だけを
// 最新の設定の上に当て直し、「他の端末の変更を取り込みました（眠前を追加）」と並べて見せる（下書きを丸ごと送って
// 他の端末が足した時間帯を黙って消し、その時間帯の与薬チェックと自動の記録が抜けたため）。備考が両方で食い違ったら選ばせる。
// 看護師・事務所が設定する画面（画面上部に注記。権限による制限はまだ無い）。
//
// 規律:
// - 取得・保存は db.ts の関数のみ。この画面の保存は input_enabled_med の封鎖の対象外（2026-09-26 チーフ裁定:
//   使い始める前に看護師が設定できるように）。与薬の記録（与薬チェック）は従来どおり input_enabled_med で止まる
// - その人に未送信の設定（この端末の送信待ち・送信中）がある行は保存できない（送信待ちは書き換えない）
// - 何も localStorage に保存しない（書きかけは画面の中だけ）。氏名・備考を console に出さない
// - 色だけで意味を伝えない（checkbox の ✓・文字を併記）

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  DbError,
  fetchAllResidents,
  fetchMedSlots,
  fetchStaff,
  hasPendingMedSlots,
  isQueuePersisted,
  isSelfWrite,
  listStoppedOps,
  queueSubscribe,
  setMedSlots,
  subscribeMedChanges,
} from '../lib/db'
import type { StoppedOp } from '../lib/db'
import { resolveActor, touchActivity } from '../lib/actor'
import { normalizeMedSlots, rebaseMedSlotsDraft, sameMedSlots } from '../lib/med'
import { MED_SLOT_LABEL, MED_SLOTS } from '../lib/types'
import type { MedSlot, MedSlotsSetting, Resident, Staff } from '../lib/types'
import { EmptyBlock, ErrorBlock, LoadingBlock, SectionCard, StaffPickerModal, useToast } from '../components/ui'

const ERR_LOAD = '服薬の時間帯を読み込めませんでした。通信状態を確認して、再試行してください。'
const MSG_CONFLICT =
  '他の端末が先にこの方の設定を保存・変更しました。最新の設定を読み直し、あなたの変更をその上に当て直します。下の表示を確かめてから保存し直してください。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度保存してください。'
const MSG_SAVE_FAILED = '保存できませんでした。通信状態を確認して、もう一度保存してください。入力は消えていません。'
const MSG_NO_RECORDER = '変更する人が選ばれていません。上の「変更する人」で選んでから保存してください。'
const MSG_ROW_PENDING = '未送信の設定があります。送信が終わってから直してください'
/** 送れずに止まった設定の変更（F37。自動では送らない＝人が選ぶまで残る） */
const MSG_ROW_STOPPED =
  'この方の設定の変更が、送れずに止まっています（他の端末が先に変更した・受け付けられなかった）。設定タブの「未送信データ」で、くらべてどうするか選んでください。'

type RowMsg = { tone: 'warn' | 'danger' | 'info'; text: string }

/** 他の端末の変更を下書きに当て直した時の知らせ（保存するまで行に出す・F54） */
export interface DraftMerge {
  /** 他の端末が足した・外した時間帯 */
  theirsAdded: MedSlot[]
  theirsRemoved: MedSlot[]
  /** 他の端末が備考を変えたか */
  theirNote: boolean
  /** 他の端末が保存した設定（並べて見せる） */
  latestSlots: MedSlot[]
  latestNote: string
  /** 備考を両方が別の値に変えた時の自分の備考（選ぶまで保存できない）。食い違いが無ければ null */
  myNote: string | null
}

/**
 * 画面の中だけの書きかけ（保存したら消す。端末の保存領域には置かない）。
 * base* は編集を始めた時（または最後に当て直した時）の設定。保存はこの版（baseRev）で送る（F54）
 */
export interface Draft {
  slots: MedSlot[]
  note: string
  /** 基準の設定の id と版（設定が無かった時は null＝追加で送る） */
  baseId: number | null
  baseRev: number | null
  baseSlots: MedSlot[]
  baseNote: string
  merged: DraftMerge | null
}

/** 編集を始めた時の下書き（基準は今の設定） */
export function draftFromSetting(cur: MedSlotsSetting | null, next: { slots: readonly MedSlot[]; note: string }): Draft {
  return {
    slots: normalizeMedSlots(next.slots),
    note: next.note,
    baseId: cur?.id ?? null,
    baseRev: cur?.rev ?? null,
    baseSlots: cur?.slots ?? [],
    baseNote: cur?.note ?? '',
    merged: null,
  }
}

/**
 * 読み直した最新の設定（latest）に、下書きを当て直す（F54・2026-10-10）。基準の版のままの下書きは触らない。
 * 版が変わった下書きは、自分が変えた時間帯・備考だけを最新の上に当て直し、基準を最新の版へ置き直す。
 * 当て直した結果が最新と同じ（自分の送信待ちが届いた・同じ変更だった）なら下書きを消す（保存する物が無い。
 * 自分の変更を「他の端末の変更」と知らせない）。変わった下書きが無ければ null（state を作り直さない）
 */
export function rebaseSlotDrafts(drafts: ReadonlyMap<number, Draft>, latest: readonly MedSlotsSetting[]): Map<number, Draft> | null {
  let out: Map<number, Draft> | null = null
  for (const [residentId, d] of drafts) {
    const cur = latest.find((s) => s.resident_id === residentId) ?? null
    if ((cur?.rev ?? null) === d.baseRev && (cur?.id ?? null) === d.baseId) continue
    const latestSlots = cur?.slots ?? []
    const latestNote = cur?.note ?? ''
    const r = rebaseMedSlotsDraft({
      base: { slots: d.baseSlots, note: d.baseNote },
      draft: { slots: d.slots, note: d.note },
      latest: { slots: latestSlots, note: latestNote },
    })
    const note = r.note ?? ''
    // 食い違いの選択が済んでいないまま、もう一度当て直した時は、前の自分の備考を残す（選ぶまで消さない）
    const myNote = r.noteClash ? d.note : (d.merged?.myNote ?? null)
    out ??= new Map(drafts)
    if (myNote === null && sameMedSlots(r.slots, latestSlots) && note.trim() === latestNote.trim()) {
      out.delete(residentId)
      continue
    }
    out.set(residentId, {
      slots: r.slots,
      note,
      baseId: cur?.id ?? null,
      baseRev: cur?.rev ?? null,
      baseSlots: latestSlots,
      baseNote: latestNote,
      merged: r.changedByOthers
        ? {
            theirsAdded: r.theirsAdded,
            theirsRemoved: r.theirsRemoved,
            theirNote: latestNote.trim() !== d.baseNote.trim(),
            latestSlots,
            latestNote,
            myNote,
          }
        : d.merged === null
          ? null
          : { ...d.merged, myNote },
    })
  }
  return out
}

/** 保存で送る「見ていた設定」（基準の版）。設定が無かった下書きは null（追加で送る＝1人1件の一意で競合になる） */
export function baseSettingOf(residentId: number, d: Draft): MedSlotsSetting | null {
  if (d.baseId === null || d.baseRev === null) return null
  return { id: d.baseId, resident_id: residentId, slots: d.baseSlots, note: d.baseNote === '' ? null : d.baseNote, rev: d.baseRev }
}

/** 当て直しの知らせの要約（例: 「眠前を追加・昼を外す」）。色だけに頼らず文字で出す */
export function mergeSummary(m: DraftMerge): string {
  const parts: string[] = []
  if (m.theirsAdded.length > 0) parts.push(`${m.theirsAdded.map((s) => MED_SLOT_LABEL[s]).join('・')}を追加`)
  if (m.theirsRemoved.length > 0) parts.push(`${m.theirsRemoved.map((s) => MED_SLOT_LABEL[s]).join('・')}を外す`)
  if (m.theirNote) parts.push('備考を変更')
  return parts.join('・')
}

/** 時間帯の並び（空は「なし」） */
function slotsText(slots: readonly MedSlot[]): string {
  return slots.length === 0 ? 'なし' : normalizeMedSlots(slots).map((s) => MED_SLOT_LABEL[s]).join('・')
}

/** その方の設定の、止まっている変更（追加は利用者 id、修正は設定の id で当てる・F37） */
export function stoppedSlotsOpsFor(ops: readonly StoppedOp[], residentId: number, settingId: number | null): StoppedOp[] {
  return ops.filter(
    (op) =>
      op.table === 'med_slots' &&
      ((op.kind === 'insert' && op.payload.resident_id === residentId) ||
        (op.kind === 'update' && settingId !== null && op.rowId === settingId)),
  )
}

export interface MedSlotsPageProps {
  staff?: Staff[]
  actorId?: number | null
}

export function MedSlotsPage({ staff: staffProp, actorId }: MedSlotsPageProps = {}) {
  const [residents, setResidents] = useState<Resident[] | null>(null)
  const [staff, setStaff] = useState<Staff[] | null>(staffProp ?? null)
  const [settings, setSettings] = useState<MedSlotsSetting[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [drafts, setDrafts] = useState<Map<number, Draft>>(new Map())
  const [msgs, setMsgs] = useState<Map<number, RowMsg>>(new Map())
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [recorderId, setRecorderId] = useState<number | null>(null)
  const [staffPickerOpen, setStaffPickerOpen] = useState(false)
  const { toast, show } = useToast()
  const uid = useId()
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // App が配り直した職員名簿（F47）。名簿だけを差し替え、利用者・設定は取り直さない（下の取得の依存に入れると、
  // 名簿が変わるたびに設定まで読み直していた）。最新の名簿は ref でも持ち、取り直し（tick）の時に使う
  const staffPropRef = useRef(staffProp)
  staffPropRef.current = staffProp
  useEffect(() => {
    if (staffProp !== undefined) setStaff(staffProp)
  }, [staffProp])

  // 名簿・職員・入力解禁・設定（画面を開くたびに取り直す）
  useEffect(() => {
    let alive = true
    setError(null)
    void (async () => {
      try {
        const given = staffPropRef.current
        const [rs, st] = await Promise.all([fetchAllResidents(), given !== undefined ? Promise.resolve(given) : fetchStaff()])
        const ss = await fetchMedSlots(rs.filter((r) => r.active))
        if (!alive) return
        setResidents(rs)
        setStaff(staffPropRef.current ?? st)
        setSettings(ss)
      } catch (e) {
        if (alive) setError(e instanceof DbError && e.kind === 'server' ? e.message : ERR_LOAD)
      }
    })()
    return () => {
      alive = false
    }
  }, [tick])

  useEffect(() => {
    if (staff === null) return
    setRecorderId((cur) => {
      if (cur !== null && staff.some((s) => s.id === cur && s.active)) return cur
      const fromActor = resolveActor(staff)?.id ?? null
      if (fromActor !== null) return fromActor
      return actorId != null && staff.some((s) => s.id === actorId && s.active) ? actorId : null
    })
  }, [staff, actorId])

  const active = useMemo(() => (residents ?? []).filter((r) => r.active), [residents])

  /** 設定だけを読み直す（競合・他の端末の変更・送信待ちが送れた後）。書きかけは消さない */
  const reloadSettings = useCallback(() => {
    fetchMedSlots(active)
      .then((ss) => {
        if (aliveRef.current) setSettings(ss)
      })
      .catch(() => {
        // 読み直せなかっただけ。表示中の設定はそのまま残す
      })
  }, [active])

  const [queueTick, setQueueTick] = useState(0)
  useEffect(() => {
    let last = -1
    return queueSubscribe((n) => {
      const prev = last
      last = n
      setQueueTick((t) => t + 1)
      if (prev >= 0 && n < prev) reloadSettings()
    })
  }, [reloadSettings])

  useEffect(() => {
    let timer: number | null = null
    const unsub = subscribeMedChanges((table, info) => {
      if (table !== 'med_slots') return
      const row = info?.row ?? null
      if (row !== null && isSelfWrite(table, row)) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(reloadSettings, 400)
    })
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsub()
    }
  }, [reloadSettings])

  // 設定を読み直したら（競合の後・通知・「最新を読み込む」・送信待ちが届いた後のどれでも）、版の変わった下書きを
  // 最新の設定の上に当て直す（F54。下書きを丸ごと残すと、保存し直した時に他の端末の変更を黙って消す）
  useEffect(() => {
    if (settings === null) return
    setDrafts((prev) => rebaseSlotDrafts(prev, settings) ?? prev)
  }, [settings])

  const byResident = useMemo(() => {
    const m = new Map<number, MedSlotsSetting>()
    for (const s of settings ?? []) m.set(s.resident_id, s)
    return m
  }, [settings])

  const configured = active.filter((r) => (byResident.get(r.id)?.slots.length ?? 0) > 0).length
  const recorderName = recorderId === null ? null : ((staff ?? []).find((s) => s.id === recorderId)?.name ?? null)
  void queueTick // 送信待ちの変化で描き直す（行の「未送信」の判定を取り直す）
  // 送れずに止まった設定の変更（F37。止まっても件数は減らないので、送信待ちの通知のたびに引き直す）
  const stoppedOps = useMemo(() => listStoppedOps(), [queueTick])

  function setRowMsg(id: number, m: RowMsg | null) {
    setMsgs((prev) => {
      const next = new Map(prev)
      if (m === null) next.delete(id)
      else next.set(id, m)
      return next
    })
  }

  /** 画面に出す値（下書きがあればそれ、無ければ保存済みの設定） */
  function draftOf(r: Resident): { slots: MedSlot[]; note: string } {
    const cur = byResident.get(r.id)
    const d = drafts.get(r.id)
    return d !== undefined ? { slots: d.slots, note: d.note } : { slots: cur?.slots ?? [], note: cur?.note ?? '' }
  }

  function changed(r: Resident): boolean {
    const d = drafts.get(r.id)
    if (d === undefined) return false
    const cur = byResident.get(r.id)
    return !sameMedSlots(d.slots, cur?.slots ?? []) || d.note.trim() !== (cur?.note ?? '').trim()
  }

  /** 書きかけを直す。最初の編集の時だけ、今の設定を基準（版）として控える（F54） */
  function edit(r: Resident, next: { slots: MedSlot[]; note: string }) {
    setDrafts((prev) => {
      const d = prev.get(r.id)
      if (d === undefined) return new Map(prev).set(r.id, draftFromSetting(byResident.get(r.id) ?? null, next))
      // 備考の食い違いの最中に備考を自分で打ち直したら、それを選んだものとして扱う
      const merged = d.merged !== null && d.merged.myNote !== null && next.note !== d.note ? { ...d.merged, myNote: null } : d.merged
      return new Map(prev).set(r.id, { ...d, slots: normalizeMedSlots(next.slots), note: next.note, merged })
    })
    setRowMsg(r.id, null)
  }

  /** 備考の食い違いで、どちらかを選んだ（F54。選ぶまで保存できない） */
  function pickNote(r: Resident, note: string) {
    setDrafts((prev) => {
      const d = prev.get(r.id)
      if (d === undefined || d.merged === null) return prev
      return new Map(prev).set(r.id, { ...d, note, merged: { ...d.merged, myNote: null } })
    })
  }

  async function save(r: Resident) {
    const id = r.id
    const cur = byResident.get(id) ?? null
    if (busy.has(id) || hasPendingMedSlots(id, cur?.id ?? null)) return
    const d = drafts.get(id)
    if (d === undefined || d.merged?.myNote != null) return
    if (recorderId === null) {
      setRowMsg(id, { tone: 'warn', text: MSG_NO_RECORDER })
      return
    }
    setBusy((prev) => new Set(prev).add(id))
    setRowMsg(id, null)
    try {
      // 見ていた設定の版（編集を始めた時・最後に当て直した時）で送る。保存した時点の設定（cur）の版で送ると、
      // 通知で読み直した後の保存が競合にならず、他の端末の変更を黙って上書きした（F54 経路 b）
      const res = await setMedSlots(id, d.slots, d.note, baseSettingOf(id, d), { editedBy: recorderId })
      touchActivity()
      if (!aliveRef.current) return
      if (res === 'conflict') {
        setRowMsg(id, { tone: 'warn', text: MSG_CONFLICT })
        reloadSettings()
        return
      }
      if (res === 'queued') {
        setRowMsg(id, {
          tone: isQueuePersisted() ? 'warn' : 'danger',
          text: isQueuePersisted() ? '設定は未送信です（電波が戻ると自動で送信します）' : MSG_NOT_PERSISTED,
        })
        return
      }
      setSettings((prev) => [...(prev ?? []).filter((s) => s.resident_id !== id), res])
      setDrafts((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
      show(`${r.name}　の服薬の時間帯を保存しました。`)
    } catch (e) {
      if (!aliveRef.current) return
      setRowMsg(id, { tone: 'danger', text: e instanceof DbError ? e.message : MSG_SAVE_FAILED })
    } finally {
      if (aliveRef.current) {
        setBusy((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    }
  }

  if (error !== null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <ErrorBlock message={error} onRetry={() => setTick((n) => n + 1)} />
      </div>
    )
  }
  if (residents === null || staff === null || settings === null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <LoadingBlock label="服薬の時間帯を読み込み中です…" />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      <p role="note" className="rounded-lg border border-info bg-info-bg p-3 text-base text-ink">
        <span aria-hidden="true">ⓘ </span>
        看護師・事務所が設定する画面です（与薬の記録を使い始める前から設定できます）
      </p>

      <SectionCard title="服薬の時間帯">
        <p className="text-base text-ink">
          在籍 <span className="tabular font-bold">{active.length}</span>人のうち設定済み{' '}
          <span className="tabular font-bold">{configured}</span>人
        </p>
        <p className="mt-1 text-sm text-ink2">
          服薬のある時間帯に ✓ を付けて、行ごとに「保存」を押してください。与薬チェックでは、✓ の無い時間帯は「—」になり押せません。
          薬の名前は書かないでください（処方の正本は入居者マスタです）。
        </p>
        <div className="mt-2 min-w-0">
          <span className="block text-sm text-ink2">変更する人</span>
          <button
            type="button"
            onClick={() => setStaffPickerOpen(true)}
            className="mt-1 flex min-h-tap items-center gap-gap rounded border border-border bg-surface px-3 text-left text-base text-ink"
          >
            <span className={recorderName === null ? 'text-ink3' : 'font-bold'}>{recorderName ?? '選んでください'}</span>
            <span className="text-sm text-link">変更</span>
          </button>
        </div>
        <p className="mt-1 text-sm">
          <Link to="/record/med" className="inline-flex min-h-tap items-center text-link">
            与薬チェックを開く<span aria-hidden="true"> ›</span>
          </Link>
        </p>
      </SectionCard>

      {active.length === 0 ? (
        <EmptyBlock message="在籍の入居者がいません。設定タブでマスタ同期を実行してください。" />
      ) : (
        <ul className="space-y-3">
          {active.map((r) => {
            const d = draftOf(r)
            const cur = byResident.get(r.id) ?? null
            const pending = hasPendingMedSlots(r.id, cur?.id ?? null)
            const isBusy = busy.has(r.id)
            const dirty = changed(r)
            const m = msgs.get(r.id) ?? null
            const disabledInput = isBusy || pending
            const merged = drafts.get(r.id)?.merged ?? null
            const clash = merged !== null && merged.myNote !== null
            const stopped = stoppedSlotsOpsFor(stoppedOps, r.id, cur?.id ?? null).length > 0
            return (
              <li key={r.id} className={`rounded-lg border bg-surface p-3 ${dirty ? 'border-primary' : 'border-border'}`}>
                <fieldset disabled={disabledInput}>
                  <legend className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="tabular text-sm text-ink3">{r.room ?? '—'}</span>
                    <span className="text-lg font-bold text-ink">{r.name}</span>
                    {cur === null || cur.slots.length === 0 ? (
                      <span className="rounded-full border border-border px-2 text-sm text-ink2">未設定</span>
                    ) : null}
                    {dirty ? <span className="text-sm font-bold text-primary">変更あり（未保存）</span> : null}
                  </legend>
                  <div className="mt-2 grid grid-cols-4 gap-gap">
                    {MED_SLOTS.map((s) => {
                      const on = d.slots.includes(s)
                      return (
                        <label
                          key={s}
                          className={`flex min-h-tap cursor-pointer flex-wrap items-center justify-center gap-1 rounded px-1 text-base text-ink ${
                            on ? 'border-2 border-primary bg-surface font-bold' : 'border border-border-strong bg-surface'
                          }`}
                        >
                          {/* 既存の画面（外出・外泊の「帰着未定」）と同じ見える checkbox。✓ は checkbox 自身が示す */}
                          <input
                            type="checkbox"
                            className="h-6 w-6 shrink-0 accent-primary"
                            checked={on}
                            onChange={() =>
                              edit(r, { ...d, slots: on ? d.slots.filter((x) => x !== s) : [...d.slots, s] })
                            }
                          />
                          <span>{MED_SLOT_LABEL[s]}</span>
                        </label>
                      )
                    })}
                  </div>
                  <div className="mt-2 flex flex-wrap items-end gap-gap">
                    <div className="min-w-0 flex-1">
                      <label htmlFor={`${uid}-${r.id}-note`} className="block text-sm text-ink2">
                        備考（任意）
                      </label>
                      <input
                        id={`${uid}-${r.id}-note`}
                        type="text"
                        value={d.note}
                        onChange={(e) => edit(r, { ...d, note: e.target.value })}
                        autoComplete="off"
                        className="mt-1 min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink disabled:bg-surface2 disabled:text-ink3"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void save(r)}
                      disabled={!dirty || clash}
                      className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border disabled:bg-surface2 disabled:text-ink3"
                    >
                      保存
                    </button>
                  </div>
                  {/* 他の端末の変更を当て直した知らせ（F54）。最新の設定と、保存した時の結果を並べて文字で見せる */}
                  {merged !== null && (dirty || clash) && mergeSummary(merged) !== '' ? (
                    <div role="status" className="mt-2 rounded border border-info bg-info-bg px-2 py-1 text-sm text-ink">
                      <p>
                        <span aria-hidden="true">ⓘ </span>
                        他の端末の変更を取り込みました（{mergeSummary(merged)}）。
                      </p>
                      <p className="mt-1">
                        他の端末の設定: {slotsText(merged.latestSlots)}
                        <span aria-hidden="true">　→　</span>
                        <span className="sr-only">。</span>保存すると: <span className="font-bold">{slotsText(d.slots)}</span>
                      </p>
                    </div>
                  ) : null}
                  {clash && merged !== null && merged.myNote !== null ? (
                    <div role="alert" className="mt-2 rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
                      <p>
                        <span aria-hidden="true">▲ </span>
                        備考を他の端末でも変えています。どちらにするか選んでください（選ぶまで保存できません）。
                      </p>
                      <div className="mt-2 flex flex-wrap gap-gap">
                        <button
                          type="button"
                          onClick={() => pickNote(r, merged.latestNote)}
                          className="min-h-tap rounded border border-border-strong bg-surface px-3 text-left text-base text-ink"
                        >
                          他の端末の備考「{merged.latestNote || '（空）'}」にする
                        </button>
                        <button
                          type="button"
                          onClick={() => pickNote(r, merged.myNote ?? '')}
                          className="min-h-tap rounded border border-border-strong bg-surface px-3 text-left text-base text-ink"
                        >
                          自分の備考「{merged.myNote || '（空）'}」にする
                        </button>
                      </div>
                    </div>
                  ) : null}
                </fieldset>
                {stopped ? (
                  <p role="status" className="mt-2 rounded border border-danger bg-danger-bg px-2 py-1 text-sm font-bold text-danger">
                    <span aria-hidden="true">⚠ </span>
                    {MSG_ROW_STOPPED}{' '}
                    <Link to="/settings" className="inline-flex min-h-tap items-center text-link">
                      設定タブを開く<span aria-hidden="true"> ›</span>
                    </Link>
                  </p>
                ) : null}
                {pending ? (
                  <p role="status" className="mt-2 rounded border border-warn bg-warn-bg px-2 py-1 text-sm font-bold text-warn">
                    <span aria-hidden="true">⚠ </span>
                    {MSG_ROW_PENDING}
                  </p>
                ) : null}
                {isBusy ? (
                  <p role="status" className="mt-2 text-sm text-ink2">
                    保存しています…
                  </p>
                ) : null}
                {m !== null ? (
                  <p
                    role={m.tone === 'danger' ? 'alert' : 'status'}
                    className={`mt-2 text-sm ${m.tone === 'danger' ? 'text-danger' : m.tone === 'warn' ? 'text-warn' : 'text-ink2'}`}
                  >
                    {m.tone !== 'info' ? <span aria-hidden="true">▲ </span> : null}
                    {m.text}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex flex-wrap gap-gap">
        <button
          type="button"
          onClick={() => setTick((n) => n + 1)}
          className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink"
        >
          最新を読み込む
        </button>
      </div>

      <StaffPickerModal
        open={staffPickerOpen}
        staff={staff.filter((s) => s.active)}
        onPick={(id) => {
          setRecorderId(id)
          setStaffPickerOpen(false)
          touchActivity()
        }}
        onClose={() => setStaffPickerOpen(false)}
        title="変更する人を選ぶ"
      />

      {toast}
    </div>
  )
}

export default MedSlotsPage
