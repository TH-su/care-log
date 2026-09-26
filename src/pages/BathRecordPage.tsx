// 入浴（デイ）の記録（記録ハブ →「入浴（デイ）」／ルート /record/bath）。2026-09-26 追加。
//
// 一覧＝その日の入浴予定者（週間計画の写し・RPC daycare_bath_plan）＋その日に記録がある人＋画面で足した予定外の人。
// 入院中の方は予定があっても「未記録」に数えず「入院」と出す（件数の「予定」からも除く・2026-09-26 チーフ裁定）。
// 並びは居室順。各行で［全身浴］［シャワー浴］［部分浴・清拭］［中止］を押すと記録する（押し直すと修正、取り消しは確認つき）。
//
// 規律:
// - 取得・保存は db.ts の関数のみ（supabase を直呼びしない）
// - 入力解禁は input_enabled_bath（getKindInputGate('bath')）。native_input_enabled とは別の旗
//   （封鎖中は隠さずにディセーブル＋理由文。書込関数の入口でも同じ旗で止まる＝二重ガード）
// - 修正は rev 照合。他の端末が先に書いていたら（conflict）入力を消さずに読み直しを促す
// - 通信できない時は送信待ち（'queued'）。端末に残せなかった時は入力を画面に残して知らせる
// - 予定（写し）が取れなくても記録は妨げない（予定外の追加から記録できる）
// - 日付は画面の中だけで持つ（業務データに紐づく状態は保存しない＝原則11の既定）。現在地は URL で復元
// - 氏名・記録を localStorage・console に出さない。色だけで意味を伝えない（✓・「未」・文字を併記）

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  DbError,
  fetchAllResidents,
  fetchBathDay,
  fetchBathPlan,
  fetchStaff,
  getKindInputGate,
  insertBath,
  isQueuePersisted,
  isSelfWrite,
  kindBlockedMessage,
  softDeleteBath,
  subscribeBathChanges,
  updateBath,
} from '../lib/db'
import type { BathPlanResult } from '../lib/db'
import { resolveActor, touchActivity } from '../lib/actor'
import { buildBathDayRows, countBathDay, fmtCopyStamp, isUnrecorded, validateBathInput } from '../lib/bath'
import type { BathDayRow } from '../lib/bath'
import { fmtDayLabel, fmtTimeHM, todayIso } from '../lib/format'
import {
  BATH_CANCEL_REASON_LABEL,
  BATH_CANCEL_REASONS,
  BATH_RESULT_LABEL,
  BATH_RESULTS,
} from '../lib/types'
import type { BathCancelReason, BathRecord, BathResult, Resident, Staff } from '../lib/types'
import {
  ConfirmDialog,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  ModalShell,
  ResidentPickerModal,
  SectionCard,
  StaffPickerModal,
  useToast,
} from '../components/ui'

const ERR_LOAD =
  '入浴の記録を読み込めませんでした。通信状態を確認して、再試行してください。'
const ERR_GATE =
  '入浴の記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。記録の閲覧はこのままできます。'
const MSG_CONFLICT =
  '他の端末が先にこの方の記録を保存・変更しました。最新の内容に読み直しました。確かめてから、もう一度選んでください（入力した備考は残っています）。'
const MSG_QUEUED = '未送信（通信できないため端末に控えました。電波が戻ると自動で送信します）'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度選んでください。'
const MSG_SAVE_FAILED = '保存できませんでした。通信状態を確認して、もう一度選んでください。'
const MSG_NO_RECORDER = '記入者が選ばれていません。上の「記入者」で選んでから記録してください。'
const PARTIAL_NOTE = '部分浴・清拭は加算の対象外の可能性（要確認）'

type RowMsg = { tone: 'warn' | 'danger' | 'info'; text: string }

/** 送信待ちにした入力（画面の表示だけ。送れたら次の読み込みで記録に置き換わる） */
interface LocalPending {
  result: BathResult
  cancel_reason: BathCancelReason | null
}

export interface BathRecordPageProps {
  /** App.tsx が持っている職員名簿（未指定ならこの画面が取得する） */
  staff?: Staff[]
  /** App.tsx の操作者（記入者の既定値。resolveActor が名簿と照合する） */
  actorId?: number | null
}

export function BathRecordPage({ staff: staffProp, actorId }: BathRecordPageProps = {}) {
  const today = todayIso()
  const [day, setDay] = useState(today)
  const [dayMsg, setDayMsg] = useState<string | null>(null)

  const [residents, setResidents] = useState<Resident[] | null>(null)
  const [staff, setStaff] = useState<Staff[] | null>(staffProp ?? null)
  const [gate, setGate] = useState<{ value: boolean; observed: boolean } | null>(null)
  const [baseError, setBaseError] = useState<string | null>(null)
  const [baseTick, setBaseTick] = useState(0)

  const [records, setRecords] = useState<BathRecord[] | null>(null)
  const [plan, setPlan] = useState<BathPlanResult | 'error' | null>(null)
  const [dayError, setDayError] = useState<string | null>(null)
  const [dayTick, setDayTick] = useState(0)

  const [extras, setExtras] = useState<number[]>([])
  const [recorderId, setRecorderId] = useState<number | null>(null)
  const [staffPickerOpen, setStaffPickerOpen] = useState(false)
  const [residentPickerOpen, setResidentPickerOpen] = useState(false)
  const [notes, setNotes] = useState<Map<number, string>>(new Map())
  const [msgs, setMsgs] = useState<Map<number, RowMsg>>(new Map())
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [pending, setPending] = useState<Map<number, LocalPending>>(new Map())
  const [cancelFor, setCancelFor] = useState<number | null>(null)
  const [deleteFor, setDeleteFor] = useState<BathRecord | null>(null)
  const { toast, show } = useToast()
  const uid = useId()
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 名簿・職員・入力解禁（画面を開くたびに取り直す＝前提情報は毎回実測）
  useEffect(() => {
    let alive = true
    setBaseError(null)
    setGate(null)
    Promise.all([
      fetchAllResidents(),
      staffProp !== undefined ? Promise.resolve(staffProp) : fetchStaff(),
      getKindInputGate('bath'),
    ])
      .then(([rs, st, g]) => {
        if (!alive) return
        setResidents(rs)
        setStaff(st)
        setGate(g)
      })
      .catch(() => {
        if (alive) setBaseError(ERR_LOAD)
      })
    return () => {
      alive = false
    }
  }, [baseTick, staffProp])

  // 記入者の既定値（名簿と照合できた操作者。できなければ未選択＝記録前に選んでもらう）
  useEffect(() => {
    if (staff === null) return
    setRecorderId((cur) => {
      if (cur !== null && staff.some((s) => s.id === cur && s.active)) return cur
      const fromActor = resolveActor(staff)?.id ?? null
      if (fromActor !== null) return fromActor
      return actorId != null && staff.some((s) => s.id === actorId && s.active) ? actorId : null
    })
  }, [staff, actorId])

  const activeResidents = useMemo(() => (residents ?? []).filter((r) => r.active), [residents])

  // その日の記録と予定（予定は失敗しても記録は出す）
  const loadRecords = useCallback(async (d: string) => {
    const rows = await fetchBathDay(d)
    return rows.filter((r) => r.bath_on === d)
  }, [])

  useEffect(() => {
    if (residents === null) return
    let alive = true
    setDayError(null)
    setRecords(null)
    setPlan(null)
    loadRecords(day)
      .then((rs) => {
        if (alive) setRecords(rs)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setDayError(e instanceof DbError ? e.message : ERR_LOAD)
      })
    fetchBathPlan(day, activeResidents)
      .then((p) => {
        if (alive) setPlan(p)
      })
      .catch(() => {
        if (alive) setPlan('error')
      })
    return () => {
      alive = false
    }
  }, [day, dayTick, residents, activeResidents, loadRecords])

  // 日付を変えたら、その日に紐づく画面の状態（予定外に足した人・備考の書きかけ・一言）を持ち越さない
  useEffect(() => {
    setExtras([])
    setNotes(new Map())
    setMsgs(new Map())
    setPending(new Map())
  }, [day])

  /** 記録だけを読み直す（保存の競合・他の端末の変更の後） */
  const reloadRecords = useCallback(() => {
    loadRecords(day)
      .then((rs) => {
        if (aliveRef.current) setRecords(rs)
      })
      .catch(() => {
        // 読み直せなかっただけ。表示中の記録はそのまま残す（上の「最新を読み込む」で再試行できる）
      })
  }, [day, loadRecords])

  // 他の端末の記録を取り込む（自分の書込の通知・別の日の通知は無視。行を特定できない通知は取り直す）
  useEffect(() => {
    let timer: number | null = null
    const unsub = subscribeBathChanges((table, info) => {
      const row = info?.row ?? null
      if (row !== null && isSelfWrite(table, row)) return
      if (row !== null && typeof row.bath_on === 'string' && row.bath_on !== day) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(reloadRecords, 400)
    })
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsub()
    }
  }, [day, reloadRecords])

  const locked = gate === null || !gate.observed || gate.value !== true
  const gateUnknown = gate !== null && !gate.observed
  const reasonId = `${uid}-locked`

  const residentById = useMemo(() => {
    const m = new Map<number, Resident>()
    for (const r of residents ?? []) m.set(r.id, r)
    return m
  }, [residents])

  const rows: BathDayRow[] = useMemo(
    () =>
      buildBathDayRows(
        plan !== null && plan !== 'error' && plan.available ? plan.entries : [],
        records ?? [],
        extras,
        (residents ?? []).map((r) => r.id),
      ),
    [plan, records, extras, residents],
  )
  const counts = countBathDay(rows)
  const staffName = (id: number | null): string | null =>
    id === null ? null : ((staff ?? []).find((s) => s.id === id)?.name ?? null)

  function setRowMsg(id: number, msg: RowMsg | null) {
    setMsgs((prev) => {
      const next = new Map(prev)
      if (msg === null) next.delete(id)
      else next.set(id, msg)
      return next
    })
  }

  function setRowBusy(id: number, on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  /** 行の備考（書きかけがあればそれ、無ければ保存済みの値） */
  function noteOf(row: BathDayRow): string {
    return notes.get(row.residentId) ?? row.record?.note ?? ''
  }

  function applySaved(saved: BathRecord) {
    setRecords((prev) => {
      const list = (prev ?? []).filter((r) => r.id !== saved.id && r.resident_id !== saved.resident_id)
      return [...list, saved]
    })
    setNotes((prev) => {
      const next = new Map(prev)
      next.delete(saved.resident_id)
      return next
    })
    setPending((prev) => {
      const next = new Map(prev)
      next.delete(saved.resident_id)
      return next
    })
  }

  /** 1行の保存（新規は insert、記録済みは rev 照合の update） */
  async function save(row: BathDayRow, result: BathResult, cancelReason: BathCancelReason | null, note: string) {
    const id = row.residentId
    if (locked || busy.has(id)) return
    if (recorderId === null) {
      setRowMsg(id, { tone: 'warn', text: MSG_NO_RECORDER })
      return
    }
    const input = { bath_on: day, result, cancel_reason: result === 'cancel' ? cancelReason : null, note: note.trim() === '' ? null : note }
    const check = validateBathInput(input, todayIso())
    if (!check.ok) {
      setRowMsg(id, { tone: 'danger', text: check.message })
      return
    }
    setRowBusy(id, true)
    setRowMsg(id, null)
    try {
      const res =
        row.record === null
          ? await insertBath({ resident_id: id, ...input, recorded_by: recorderId })
          : await updateBath(row.record, { result, cancel_reason: input.cancel_reason, note: input.note }, { editedBy: recorderId })
      touchActivity()
      if (!aliveRef.current) return
      if (res === 'conflict') {
        setRowMsg(id, { tone: 'warn', text: MSG_CONFLICT })
        reloadRecords()
        return
      }
      if (res === 'queued') {
        if (!isQueuePersisted()) {
          setRowMsg(id, { tone: 'danger', text: MSG_NOT_PERSISTED })
          return
        }
        setPending((prev) => new Map(prev).set(id, { result, cancel_reason: input.cancel_reason }))
        setRowMsg(id, { tone: 'warn', text: MSG_QUEUED })
        return
      }
      applySaved(res)
      const name = residentById.get(id)?.name ?? ''
      show(`${name ? `${name}　` : ''}${BATH_RESULT_LABEL[res.result]}を記録しました。`)
    } catch (e) {
      if (!aliveRef.current) return
      setRowMsg(id, { tone: 'danger', text: e instanceof DbError ? e.message : MSG_SAVE_FAILED })
    } finally {
      if (aliveRef.current) setRowBusy(id, false)
    }
  }

  function onResult(row: BathDayRow, result: BathResult) {
    if (result === 'cancel') {
      setCancelFor(row.residentId)
      return
    }
    // 同じ区分を押し直した時は、備考が変わっていれば備考だけを直す（変わっていなければ何もしない）
    if (row.record !== null && row.record.result === result && noteOf(row) === (row.record.note ?? '')) return
    void save(row, result, null, noteOf(row))
  }

  async function remove(rec: BathRecord) {
    const id = rec.resident_id
    setDeleteFor(null)
    if (locked || busy.has(id)) return
    setRowBusy(id, true)
    setRowMsg(id, null)
    try {
      const res = await softDeleteBath(rec.id, rec.rev, { editedBy: recorderId })
      touchActivity()
      if (!aliveRef.current) return
      if (res === 'conflict') {
        setRowMsg(id, { tone: 'warn', text: MSG_CONFLICT })
        reloadRecords()
        return
      }
      if (res === 'queued') {
        setRowMsg(id, { tone: 'warn', text: isQueuePersisted() ? '取り消しは未送信です（電波が戻ると自動で送信します）' : MSG_NOT_PERSISTED })
        return
      }
      setRecords((prev) => (prev ?? []).filter((r) => r.id !== rec.id))
      show('記録を取り消しました。')
    } catch (e) {
      if (!aliveRef.current) return
      setRowMsg(id, { tone: 'danger', text: e instanceof DbError ? e.message : MSG_SAVE_FAILED })
    } finally {
      if (aliveRef.current) setRowBusy(id, false)
    }
  }

  // ── 3状態: エラー → ローディング → 本体 ──
  if (baseError !== null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <ErrorBlock message={baseError} onRetry={() => setBaseTick((n) => n + 1)} />
      </div>
    )
  }
  if (residents === null || staff === null || gate === null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <LoadingBlock label="入浴の記録画面を準備しています…" />
      </div>
    )
  }

  const recorderName = staffName(recorderId)
  const cancelRow = cancelFor === null ? null : (rows.find((r) => r.residentId === cancelFor) ?? null)
  const pickable = activeResidents.filter((r) => !rows.some((row) => row.residentId === r.id))

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      {gateUnknown ? (
        <ErrorBlock message={ERR_GATE} onRetry={() => setBaseTick((n) => n + 1)} />
      ) : locked ? (
        <div id={reasonId} role="status" className="rounded-lg border border-warn bg-warn-bg p-4">
          <p className="text-base text-ink">
            <span aria-hidden="true">▲ </span>
            <span className="sr-only">お知らせ: </span>
            {kindBlockedMessage('bath')}
          </p>
          <p className="mt-2 text-base text-ink2">予定と記録の閲覧はこのままできます。</p>
        </div>
      ) : null}

      <SectionCard title="入浴（デイ）">
        <div className="flex flex-wrap items-end gap-gap">
          <div className="min-w-0">
            <label htmlFor={`${uid}-day`} className="block text-sm text-ink2">
              日付
            </label>
            <input
              id={`${uid}-day`}
              type="date"
              value={day}
              max={today}
              onChange={(e) => {
                const v = e.target.value
                if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return
                if (v > todayIso()) {
                  setDay(todayIso())
                  setDayMsg('未来の日付は選べません。今日にしました。')
                  return
                }
                setDayMsg(null)
                setDay(v)
              }}
              className="tabular mt-1 min-h-tap rounded border border-border bg-surface px-3 text-base text-ink"
            />
          </div>
          {day !== today ? (
            <button
              type="button"
              onClick={() => {
                setDayMsg(null)
                setDay(todayIso())
              }}
              className="min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink"
            >
              今日へ
            </button>
          ) : null}
          <div className="min-w-0">
            <span className="block text-sm text-ink2">記入者</span>
            <button
              type="button"
              onClick={() => setStaffPickerOpen(true)}
              className="mt-1 flex min-h-tap items-center gap-gap rounded border border-border bg-surface px-3 text-left text-base text-ink"
            >
              <span className={recorderName === null ? 'text-ink3' : 'font-bold'}>
                {recorderName ?? '選んでください'}
              </span>
              <span className="text-sm text-link">変更</span>
            </button>
          </div>
        </div>
        {dayMsg !== null ? (
          <p role="alert" className="mt-2 text-sm text-warn">
            <span aria-hidden="true">▲ </span>
            {dayMsg}
          </p>
        ) : null}

        <p className="mt-3 text-base text-ink" aria-live="polite">
          <span className="font-bold">{fmtDayLabel(day)}</span>
          {'　'}
          予定 <span className="tabular font-bold">{counts.planned}</span>人・記録済み{' '}
          <span className="tabular font-bold">{counts.recorded}</span>・未記録{' '}
          <span className={`tabular font-bold ${counts.unrecorded > 0 ? 'text-warn' : ''}`}>{counts.unrecorded}</span>
        </p>
        <p className="mt-1 text-sm text-ink2">
          <span aria-hidden="true">ⓘ </span>
          {plan === null
            ? '予定を読み込み中です…'
            : plan === 'error' || !plan.available
              ? '予定を取得できません。予定外の追加から記録できます。'
              : `予定は週間計画の写しから${plan.updatedAt ? `（最終更新 ${fmtCopyStamp(plan.updatedAt)}）` : ''}`}
        </p>
        {plan !== null && plan !== 'error' && plan.unmatched > 0 ? (
          <p className="mt-1 text-sm text-warn">
            <span aria-hidden="true">▲ </span>
            週間計画の予定のうち {plan.unmatched}件は、利用者の名簿と突き合わせられませんでした（設定タブのマスタ同期をお試しください）。
          </p>
        ) : null}
        <p className="mt-1 text-sm text-ink2">※{PARTIAL_NOTE}</p>
        <p className="mt-1 text-sm">
          <Link to="/bath/month" className="inline-flex min-h-tap items-center text-link">
            月次表を見る<span aria-hidden="true"> ›</span>
          </Link>
        </p>
      </SectionCard>

      {dayError !== null ? (
        <ErrorBlock message={dayError} onRetry={() => setDayTick((n) => n + 1)} />
      ) : records === null ? (
        <LoadingBlock label="この日の入浴の記録を読み込み中です…" />
      ) : (
        <>
          {rows.length === 0 ? (
            <EmptyBlock message="この日の入浴の予定と記録はありません。予定外の方は下の「予定外の人を追加」から記録できます。" />
          ) : (
            <ul className="space-y-3">
              {rows.map((row) => (
                <BathRow
                  key={row.residentId}
                  row={row}
                  resident={residentById.get(row.residentId) ?? null}
                  note={noteOf(row)}
                  onNote={(v) => setNotes((prev) => new Map(prev).set(row.residentId, v))}
                  onResult={(r) => onResult(row, r)}
                  onSaveNote={() => {
                    if (row.record !== null) void save(row, row.record.result, row.record.cancel_reason, noteOf(row))
                  }}
                  onDelete={() => setDeleteFor(row.record)}
                  locked={locked}
                  busy={busy.has(row.residentId)}
                  msg={msgs.get(row.residentId) ?? null}
                  pending={pending.get(row.residentId) ?? null}
                  reasonId={locked && !gateUnknown ? reasonId : undefined}
                />
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-gap">
            <button
              type="button"
              onClick={() => setResidentPickerOpen(true)}
              disabled={pickable.length === 0}
              className="min-h-tap rounded border border-primary bg-surface px-4 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
            >
              ＋予定外の人を追加
            </button>
            <button
              type="button"
              onClick={() => setDayTick((n) => n + 1)}
              className="min-h-tap rounded border border-border-strong bg-surface px-4 text-base text-ink"
            >
              最新を読み込む
            </button>
          </div>
        </>
      )}

      <StaffPickerModal
        open={staffPickerOpen}
        staff={staff.filter((s) => s.active)}
        onPick={(id) => {
          setRecorderId(id)
          setStaffPickerOpen(false)
          touchActivity()
        }}
        onClose={() => setStaffPickerOpen(false)}
        title="記入者を選ぶ"
      />

      <ResidentPickerModal
        open={residentPickerOpen}
        residents={pickable}
        onPick={(id) => {
          setResidentPickerOpen(false)
          if (id !== null) setExtras((prev) => (prev.includes(id) ? prev : [...prev, id]))
        }}
        onClose={() => setResidentPickerOpen(false)}
      />

      <CancelDialog
        open={cancelRow !== null}
        name={cancelRow === null ? '' : (residentById.get(cancelRow.residentId)?.name ?? '')}
        initialReason={cancelRow?.record?.result === 'cancel' ? cancelRow.record.cancel_reason : null}
        initialNote={cancelRow === null ? '' : noteOf(cancelRow)}
        onCancel={() => setCancelFor(null)}
        onSave={(reason, note) => {
          const row = cancelRow
          setCancelFor(null)
          if (row === null) return
          setNotes((prev) => new Map(prev).set(row.residentId, note))
          void save(row, 'cancel', reason, note)
        }}
      />

      <ConfirmDialog
        open={deleteFor !== null}
        title="この記録を取り消しますか"
        body={
          deleteFor === null
            ? undefined
            : `${residentById.get(deleteFor.resident_id)?.name ?? ''}　${fmtDayLabel(deleteFor.bath_on)}の「${BATH_RESULT_LABEL[deleteFor.result]}」の記録を取り消します。取り消した記録は変更の記録に残ります。`
        }
        confirmLabel="取り消す"
        danger
        onConfirm={() => {
          if (deleteFor !== null) void remove(deleteFor)
        }}
        onCancel={() => setDeleteFor(null)}
      />

      {toast}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 1行（利用者1人）
// ══════════════════════════════════════════════════════════════

interface BathRowProps {
  row: BathDayRow
  resident: Resident | null
  note: string
  onNote: (v: string) => void
  onResult: (r: BathResult) => void
  onSaveNote: () => void
  onDelete: () => void
  locked: boolean
  busy: boolean
  msg: RowMsg | null
  pending: LocalPending | null
  reasonId?: string
}

function BathRow({
  row,
  resident,
  note,
  onNote,
  onResult,
  onSaveNote,
  onDelete,
  locked,
  busy,
  msg,
  pending,
  reasonId,
}: BathRowProps) {
  const uid = useId()
  const rec = row.record
  // 表示する区分: 保存済み → 送信待ちにした入力 の順
  const shown: BathResult | null = rec?.result ?? pending?.result ?? null
  const shownReason = rec?.result === 'cancel' ? rec.cancel_reason : pending?.result === 'cancel' ? pending.cancel_reason : null
  // 入院中の方は予定があっても「未」にしない（入浴できないため・「入院」と出す）
  const unrecorded = pending === null && isUnrecorded(row)
  const noteChanged = rec !== null && note !== (rec.note ?? '')
  const disabled = locked || busy
  const name = resident?.name ?? `利用者番号 ${row.residentId}`
  const time =
    row.startTime !== null || row.endTime !== null
      ? `${fmtTimeHM(row.startTime) || '—'}〜${fmtTimeHM(row.endTime) || '—'}`
      : ''

  return (
    <li
      className={`rounded-lg border p-3 ${unrecorded ? 'border-warn bg-surface' : 'border-border bg-surface'}`}
      aria-busy={busy || undefined}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="tabular text-sm text-ink3">{resident?.room ?? '—'}</span>
        <span className="text-lg font-bold text-ink">{name}</span>
        {row.planned ? (
          <span className="tabular text-sm text-ink2">予定 {time || '時刻なし'}</span>
        ) : (
          <span className="rounded-full border border-border px-2 text-sm text-ink2">予定外</span>
        )}
        {row.hospitalized ? (
          <span className="rounded-full border border-border-strong bg-surface2 px-2 text-sm font-bold text-ink">入院</span>
        ) : null}
        {unrecorded ? (
          <span className="rounded-full border border-warn bg-warn-bg px-2 text-sm font-bold text-warn">
            未<span className="sr-only">記録</span>
          </span>
        ) : rec !== null ? (
          <span className="text-sm font-bold text-ok">
            <span aria-hidden="true">✓ </span>記録済み
          </span>
        ) : null}
      </div>

      <div role="group" aria-label={`${name}の入浴の区分`} className="mt-2 grid grid-cols-2 gap-gap sm:grid-cols-4">
        {BATH_RESULTS.map((r) => {
          const selected = shown === r
          return (
            <button
              key={r}
              type="button"
              aria-pressed={selected}
              aria-describedby={reasonId}
              disabled={disabled}
              onClick={() => onResult(r)}
              className={
                selected
                  ? 'min-h-tap rounded border-2 border-primary bg-primary px-2 text-base font-bold text-primary-ink disabled:opacity-60'
                  : 'min-h-tap rounded border border-border-strong bg-surface px-2 text-base text-ink disabled:border-border disabled:bg-surface2 disabled:text-ink3'
              }
            >
              {/* ✓ は選んだ時だけ出す（場所取りの見えない ✓ を置くと、文字200%・狭い幅で文字が1字ずつ折り返す） */}
              {selected ? <span aria-hidden="true">✓ </span> : null}
              {BATH_RESULT_LABEL[r]}
            </button>
          )
        })}
      </div>

      {shown === 'cancel' && shownReason !== null ? (
        <p className="mt-2 text-sm text-ink">
          中止の理由: <span className="font-bold">{BATH_CANCEL_REASON_LABEL[shownReason]}</span>
        </p>
      ) : null}
      {shown === 'partial' ? (
        <p className="mt-2 text-sm text-warn">
          <span aria-hidden="true">▲ </span>
          {PARTIAL_NOTE}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-end gap-gap">
        <div className="min-w-0 flex-1">
          <label htmlFor={`${uid}-note`} className="block text-sm text-ink2">
            備考（任意）
          </label>
          <input
            id={`${uid}-note`}
            type="text"
            value={note}
            onChange={(e) => onNote(e.target.value)}
            disabled={locked}
            autoComplete="off"
            className="mt-1 min-h-tap w-full rounded border border-border bg-surface px-3 text-base text-ink disabled:bg-surface2 disabled:text-ink3"
          />
        </div>
        {noteChanged ? (
          <button
            type="button"
            onClick={onSaveNote}
            disabled={disabled}
            className="min-h-tap rounded border border-primary bg-surface px-3 text-base font-bold text-primary disabled:border-border disabled:text-ink3"
          >
            備考を保存
          </button>
        ) : null}
        {rec !== null ? (
          <button
            type="button"
            onClick={onDelete}
            disabled={disabled}
            className="min-h-tap rounded border border-danger bg-surface px-3 text-base text-danger disabled:border-border disabled:text-ink3"
          >
            取り消す
          </button>
        ) : null}
      </div>

      {busy ? (
        <p role="status" className="mt-2 text-sm text-ink2">
          保存しています…
        </p>
      ) : null}
      {msg !== null ? (
        <p
          role={msg.tone === 'danger' ? 'alert' : 'status'}
          className={`mt-2 text-sm ${msg.tone === 'danger' ? 'text-danger' : msg.tone === 'warn' ? 'text-warn' : 'text-ink2'}`}
        >
          {msg.tone !== 'info' ? <span aria-hidden="true">▲ </span> : null}
          {msg.text}
        </p>
      ) : null}
    </li>
  )
}

// ══════════════════════════════════════════════════════════════
// 中止の理由（小窓）
// ══════════════════════════════════════════════════════════════

interface CancelDialogProps {
  open: boolean
  name: string
  initialReason: BathCancelReason | null
  initialNote: string
  onCancel: () => void
  onSave: (reason: BathCancelReason, note: string) => void
}

function CancelDialog({ open, name, initialReason, initialNote, onCancel, onSave }: CancelDialogProps) {
  const [reason, setReason] = useState<BathCancelReason | null>(initialReason)
  const [note, setNote] = useState(initialNote)
  const [showError, setShowError] = useState(false)
  const uid = useId()
  const firstRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    setReason(initialReason)
    setNote(initialNote)
    setShowError(false)
  }, [open, initialReason, initialNote])

  const error =
    reason === null
      ? '中止の理由を選んでください。'
      : reason === 'other' && note.trim() === ''
        ? '理由が「その他」の時は、備考に内容を書いてください。'
        : null

  return (
    <ModalShell open={open} label="中止の理由" onClose={onCancel} initialFocus={firstRef} narrow>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <h2 className="text-lg font-bold text-ink">中止の理由</h2>
        {name ? <p className="mt-1 text-sm text-ink2">{name}</p> : null}
        <div role="group" aria-label="中止の理由" className="mt-3 grid grid-cols-1 gap-gap">
          {BATH_CANCEL_REASONS.map((r, i) => {
            const selected = reason === r
            return (
              <button
                key={r}
                ref={i === 0 ? firstRef : undefined}
                type="button"
                aria-pressed={selected}
                onClick={() => setReason(r)}
                className={
                  selected
                    ? 'min-h-tap rounded border-2 border-primary bg-primary px-3 text-left text-base font-bold text-primary-ink'
                    : 'min-h-tap rounded border border-border-strong bg-surface px-3 text-left text-base text-ink'
                }
              >
                {selected ? <span aria-hidden="true">✓ </span> : null}
                {BATH_CANCEL_REASON_LABEL[r]}
              </button>
            )
          })}
        </div>
        <label htmlFor={`${uid}-note`} className="mt-3 block text-sm text-ink2">
          備考{reason === 'other' ? '（必須）' : '（任意）'}
        </label>
        <textarea
          id={`${uid}-note`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          aria-invalid={showError && error !== null ? true : undefined}
          aria-describedby={showError && error !== null ? `${uid}-err` : undefined}
          className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-base text-ink"
        />
        {showError && error !== null ? (
          <p id={`${uid}-err`} role="alert" className="mt-1 text-sm text-danger">
            <span aria-hidden="true">▲ </span>
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-gap border-t border-border p-4">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-tap rounded border border-border-strong px-4 text-base text-ink"
        >
          やめる
        </button>
        <button
          type="button"
          onClick={() => {
            if (error !== null || reason === null) {
              setShowError(true)
              return
            }
            onSave(reason, note)
          }}
          className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink"
        >
          中止として記録する
        </button>
      </div>
    </ModalShell>
  )
}

export default BathRecordPage
