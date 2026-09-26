// 服薬の時間帯（ルート /med/slots・「その他」から）。2026-09-26 追加。
//
// 在籍の入居者ごとに、服薬のある時間帯（朝・昼・夕・眠前）と備考を設定する。与薬チェックの表はこの設定で
// 「押せるマス」と「—」を決める。薬の名前は持たない（処方の正本は入居者マスタ）。
// 変更は行ごとに保存する（無ければ追加・あれば rev 照合の更新。他の端末が先に変えていたら入力を残して読み直しを促す）。
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
  queueSubscribe,
  setMedSlots,
  subscribeMedChanges,
} from '../lib/db'
import { resolveActor, touchActivity } from '../lib/actor'
import { normalizeMedSlots, sameMedSlots } from '../lib/med'
import { MED_SLOT_LABEL, MED_SLOTS } from '../lib/types'
import type { MedSlot, MedSlotsSetting, Resident, Staff } from '../lib/types'
import { EmptyBlock, ErrorBlock, LoadingBlock, SectionCard, StaffPickerModal, useToast } from '../components/ui'

const ERR_LOAD = '服薬の時間帯を読み込めませんでした。通信状態を確認して、再試行してください。'
const MSG_CONFLICT =
  '他の端末が先にこの方の設定を保存・変更しました。最新の設定を読み直しました。入力はそのまま残っているので、確かめてから保存し直してください。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度保存してください。'
const MSG_SAVE_FAILED = '保存できませんでした。通信状態を確認して、もう一度保存してください。入力は消えていません。'
const MSG_NO_RECORDER = '変更する人が選ばれていません。上の「変更する人」で選んでから保存してください。'
const MSG_ROW_PENDING = '未送信の設定があります。送信が終わってから直してください'

type RowMsg = { tone: 'warn' | 'danger' | 'info'; text: string }

/** 画面の中だけの書きかけ（保存したら消す） */
interface Draft {
  slots: MedSlot[]
  note: string
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

  // 名簿・職員・入力解禁・設定（画面を開くたびに取り直す）
  useEffect(() => {
    let alive = true
    setError(null)
    void (async () => {
      try {
        const [rs, st] = await Promise.all([
          fetchAllResidents(),
          staffProp !== undefined ? Promise.resolve(staffProp) : fetchStaff(),
        ])
        const ss = await fetchMedSlots(rs.filter((r) => r.active))
        if (!alive) return
        setResidents(rs)
        setStaff(st)
        setSettings(ss)
      } catch (e) {
        if (alive) setError(e instanceof DbError && e.kind === 'server' ? e.message : ERR_LOAD)
      }
    })()
    return () => {
      alive = false
    }
  }, [tick, staffProp])

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

  const byResident = useMemo(() => {
    const m = new Map<number, MedSlotsSetting>()
    for (const s of settings ?? []) m.set(s.resident_id, s)
    return m
  }, [settings])

  const configured = active.filter((r) => (byResident.get(r.id)?.slots.length ?? 0) > 0).length
  const recorderName = recorderId === null ? null : ((staff ?? []).find((s) => s.id === recorderId)?.name ?? null)
  void queueTick // 送信待ちの変化で描き直す（行の「未送信」の判定を取り直す）

  function setRowMsg(id: number, m: RowMsg | null) {
    setMsgs((prev) => {
      const next = new Map(prev)
      if (m === null) next.delete(id)
      else next.set(id, m)
      return next
    })
  }

  function draftOf(r: Resident): Draft {
    const cur = byResident.get(r.id)
    return drafts.get(r.id) ?? { slots: cur?.slots ?? [], note: cur?.note ?? '' }
  }

  function changed(r: Resident): boolean {
    const d = drafts.get(r.id)
    if (d === undefined) return false
    const cur = byResident.get(r.id)
    return !sameMedSlots(d.slots, cur?.slots ?? []) || d.note.trim() !== (cur?.note ?? '').trim()
  }

  function edit(r: Resident, next: Draft) {
    setDrafts((prev) => new Map(prev).set(r.id, { slots: normalizeMedSlots(next.slots), note: next.note }))
    setRowMsg(r.id, null)
  }

  async function save(r: Resident) {
    const id = r.id
    const cur = byResident.get(id) ?? null
    if (busy.has(id) || hasPendingMedSlots(id, cur?.id ?? null)) return
    if (recorderId === null) {
      setRowMsg(id, { tone: 'warn', text: MSG_NO_RECORDER })
      return
    }
    const d = draftOf(r)
    setBusy((prev) => new Set(prev).add(id))
    setRowMsg(id, null)
    try {
      const res = await setMedSlots(id, d.slots, d.note, cur, { editedBy: recorderId })
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
                      disabled={!dirty}
                      className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border disabled:bg-surface2 disabled:text-ink3"
                    >
                      保存
                    </button>
                  </div>
                </fieldset>
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
