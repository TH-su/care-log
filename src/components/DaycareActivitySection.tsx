// デイ（せせらぎ）段階2b: 1人の1日記録の「活動・レク」の欄（2026-10-22 代表者承認・段階2の計画 v1 の 1.1／3.1）。
//
// ・表は daycare_activity_log（移行 0044）。保存は db.ts の insertDaycareActivity・updateDaycareActivity・softDeleteDaycareActivity
// ・入力解禁は活動だけの旗 input_enabled_daycare_activity（デイの旗とは別。活動だけを止めて戻せる）。表が無い DB は「設定待ち」
// ・定型のチップ1タップで「参加」を記録。度合い（一部・見学・不参加）を変える時だけもう1タップ。〔その他〕は自由入力（40字まで）
// ・2台で同じチップ: 度合いが同じなら1行に合流（後の端末には〔元に戻す〕を出さない＝先の端末の記録を消さない）、
//   違えば「先に記録があります」と出して読み直す
// ・〔前回と同じにする〕: その方の前の日の活動（いちばん新しい日）を、まだ入っていない項目だけ足す（活動だけ前回コピー）
// ・送信待ちの追加・修正・取り消しは、この端末の送信待ち（pendingActivityOps）から重ねて出す（観測でなく送信待ちそのもの）
// ・端末に業務データを残さない（localStorage を使わない）。送り先（人・日）は押した時に固定する（2a の反証 中3 と同じ）

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DbError,
  FORBIDDEN_REASON,
  OUTDATED_REASON,
  fetchDaycareActivities,
  fetchPreviousActivities,
  getKindInputGate,
  insertDaycareActivity,
  isActivityMissingError,
  isQueuePersisted,
  isSelfWrite,
  kindBlockedMessage,
  pendingActivityOps,
  queuePending,
  queueSubscribe,
  softDeleteDaycareActivity,
  subscribeDaycareActivityChanges,
  updateDaycareActivity,
} from '../lib/db'
import type { PendingActivityOp } from '../lib/db'
import {
  ACTIVITY_LABEL_MAX,
  ACTIVITY_PARTICIPATIONS,
  ACTIVITY_PARTICIPATION_LABEL,
  DAYCARE_ACTIVITY_CHIPS,
  activitiesOf,
  activityLabelError,
  activityText,
  copyItems,
  normalizeActivityLabel,
  previousActivities,
} from '../lib/daycareActivity'
import type { ActivityParticipation, DaycareActivity } from '../lib/daycareActivity'
import { ConfirmDialog } from './ui'

const MSG_NO_RECORDER = '記録者が選ばれていません。上の「記録者」で選んでから入れてください。'
const MSG_QUEUED = '電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'
const MSG_NOT_PERSISTED =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。この画面を閉じずに、電波が戻ってからもう一度押してください。'
const MSG_GATE_UNKNOWN =
  'デイの活動の記録を使える期間かどうかを確認できませんでした（通信エラー）。電波状態を確認して、再試行してください。記録の閲覧はこのままできます。'
const MSG_LOAD = '活動の記録を読み込めませんでした。通信状態を確認して、〔読み直す〕を押してください。'
const MSG_FUTURE = '未来の日には記録できません。'

type Gate = { value: boolean; observed: boolean; forbidden?: true; outdated?: true }
/** queued＝送信待ちにした旨の一言（その方・その日の送信待ちが無くなったら外す＝届いた後に「自動で送信します」を残さない） */
type Msg = { key: string; tone: 'info' | 'warn' | 'danger'; text: string; queued?: true }

interface Props {
  residentId: number
  /** 氏名（トーストの文に使う。画面が名簿から渡す） */
  residentName: string
  day: string
  today: string
  actorId: number | null
  /** 画面のトースト（〔元に戻す〕つき） */
  show: (msg: string, undo?: () => void) => void
  /** 画面の〔最新に更新〕の回数（変わったら活動も読み直す） */
  refreshKey?: number
  /** 各行の下に置く物（段階2c の〔申し送りにする〕。この部品は申し送りへ書かない） */
  markSlot?: (a: DaycareActivity) => ReactNode
}

const toneCls: Record<Msg['tone'], string> = {
  info: 'border-primary bg-surface',
  warn: 'border-warn bg-warn-bg',
  danger: 'border-danger bg-danger-bg',
}

export function DaycareActivitySection({ residentId, residentName, day, today, actorId, show, refreshKey = 0, markSlot }: Props) {
  const [gate, setGate] = useState<Gate | null>(null)
  const [rows, setRows] = useState<DaycareActivity[] | null>(null)
  const [rowsDay, setRowsDay] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 前回コピーの元（key＝読んだ時の人・日。いま開いている人・日と違えば使わない＝前の方の前回を次の方へ記録しない＝2b の反証 重大1） */
  const [prev, setPrev] = useState<{ key: string; rows: DaycareActivity[] } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [msg, setMsg] = useState<Msg | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherText, setOtherText] = useState('')
  const [delTarget, setDelTarget] = useState<DaycareActivity | null>(null)
  const [pending, setPending] = useState<PendingActivityOp[]>(() => pendingActivityOps())
  const genRef = useRef(0)
  const here = useRef({ residentId, day })
  here.current = { residentId, day }
  const personKey = `${residentId}:${day}`

  useEffect(() => {
    let alive = true
    setGate(null)
    getKindInputGate('daycare_activity')
      .then((g) => alive && setGate(g))
      .catch(() => alive && setGate({ value: false, observed: false }))
    return () => {
      alive = false
    }
  }, [reloadKey, refreshKey])

  const load = useCallback(async (target: string, rid: number, quiet: boolean) => {
    const gen = ++genRef.current
    if (!quiet) setLoadError(null)
    try {
      const [list, before] = await Promise.all([fetchDaycareActivities(target), fetchPreviousActivities(rid, target).catch(() => null)])
      if (gen !== genRef.current) return
      setRows(list)
      setRowsDay(target)
      const k = `${rid}:${target}`
      // 前回を読めなかった時は、同じ人・日の前の値だけ残す（別の方の前回は残さない）
      setPrev((old) => (before !== null ? { key: k, rows: before } : old !== null && old.key === k ? old : null))
      setMissing(false)
      setLoadError(null)
    } catch (e) {
      if (gen !== genRef.current) return
      if (isActivityMissingError(e)) {
        setMissing(true)
        setRows([])
        setRowsDay(target)
        return
      }
      if (!quiet) setLoadError(MSG_LOAD)
    }
  }, [])

  // 人・日の切り替えと〔読み直す〕: その場限りの一言は外して読み直す（送信待ちの重ね表示は送信待ちから出し直す）
  useEffect(() => {
    setMsg(null)
    setOtherOpen(false)
    setOtherText('')
    void load(day, residentId, false)
  }, [day, residentId, reloadKey, refreshKey, load])

  const reloadTimer = useRef<number | null>(null)
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null
      void load(here.current.day, here.current.residentId, true)
    }, 400)
  }, [load])
  useEffect(() => {
    const off = subscribeDaycareActivityChanges((table, info) => {
      if (info?.row && isSelfWrite(table, info.row)) return
      scheduleReload()
    })
    let last = queuePending()
    const offQ = queueSubscribe((n) => {
      setPending(pendingActivityOps())
      if (n < last) scheduleReload()
      last = n
    })
    return () => {
      off()
      offQ()
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    }
  }, [scheduleReload])

  const canWrite = gate !== null && gate.observed && gate.value === true && !missing && day <= today
  const precheck = (): string | null => {
    if (missing) return null
    if (day > today) return MSG_FUTURE
    if (!canWrite) {
      return gate?.forbidden
        ? FORBIDDEN_REASON
        : gate?.outdated
          ? OUTDATED_REASON
          : gate?.observed
            ? kindBlockedMessage('daycare_activity')
            : MSG_GATE_UNKNOWN
    }
    if (actorId === null) return MSG_NO_RECORDER
    return null
  }

  const mine = useMemo(
    () => (rows === null || rowsDay !== day ? [] : activitiesOf(rows, residentId, day)),
    [rows, rowsDay, residentId, day],
  )
  // 送信待ちの重ね表示: 取り消しを送信待ちにした行は外し、度合いの修正は送信待ちの値で出す。追加はまだ載っていない項目だけ
  const shown = useMemo(() => {
    const upd = new Map<number, Extract<PendingActivityOp, { kind: 'update' }>>()
    const stoppedUpd = new Map<number, Extract<PendingActivityOp, { kind: 'update' }>>()
    for (const p of pending) {
      if (p.kind !== 'update') continue
      if (p.stopped) stoppedUpd.set(p.rowId, p)
      else upd.set(p.rowId, p)
    }
    // 取り消しを送信待ちにした行は、届くまで「取り消しの送信待ち」として残し、同じ項目を入れられないようにする
    // （入れ直すと先の行に合流し、後から届いた取り消しで入れ直しまで消えるため＝2b の反証 中1）。
    // 止まった度合いの変更・取り消しは、その行の下で知らせる（サーバーの値に黙って戻さない＝2b の反証 中2）
    const list = mine.map((a) => {
      const p = upd.get(a.id)
      return {
        a,
        participation: p?.participation ?? a.participation,
        waiting: p !== undefined,
        deleting: p?.deleted === true,
        stopped: stoppedUpd.get(a.id) ?? null,
      }
    })
    const have = new Set(mine.map((a) => a.label))
    // 送信待ちの追加は、まだ載っていない項目だけ重ねる。止まった追加（他の端末の記録と度合いが食い違った）は、
    // 同じ項目の行がサーバーにあっても出す（押した人が食い違いに気づけるように）
    const adds = pending.filter(
      (p): p is Extract<PendingActivityOp, { kind: 'add' }> =>
        p.kind === 'add' && p.residentId === residentId && p.day === day && (p.stopped || !have.has(p.label)),
    )
    return { list, adds }
  }, [mine, pending, residentId, day])
  const labelsNow = new Set([...shown.list.map((x) => x.a.label), ...shown.adds.map((p) => p.label)])
  const deletingLabels = new Set(shown.list.filter((x) => x.deleting).map((x) => x.a.label))

  // 送信待ちにした旨の一言は、その方・その日の送信待ち（止まっていない分）が無くなったら外す
  useEffect(() => {
    setMsg((m) => {
      if (m === null || m.queued !== true) return m
      const [ridText, d] = m.key.split(':')
      const rid = Number(ridText)
      const ids = new Set((rows ?? []).filter((a) => a.resident_id === rid && a.day === d).map((a) => a.id))
      const still = pending.some((p) =>
        p.stopped ? false : p.kind === 'add' ? p.residentId === rid && p.day === d : ids.has(p.rowId),
      )
      return still ? m : null
    })
  }, [pending, rows])

  const say = (key: string, tone: Msg['tone'], text: string, queued = false) =>
    setMsg(queued ? { key, tone, text, queued: true } : { key, tone, text })
  const queuedText = () => (isQueuePersisted() ? MSG_QUEUED : MSG_NOT_PERSISTED)
  const errText = (e: unknown, fallback: string) => (e instanceof DbError ? e.message : fallback)
  const setBusyLabel = (label: string, on: boolean) =>
    setBusy((prevSet) => {
      const next = new Set(prevSet)
      if (on) next.add(label)
      else next.delete(label)
      return next
    })

  /** 1項目を足す（送り先は押した時の人・日に固定）。戻り値は成功したか（前回コピーで続けるかの判断に使う） */
  const add = async (rawLabel: string, participation: ActivityParticipation = 'full', quietUndo = false): Promise<boolean> => {
    const rid = residentId
    const d = day
    const key = `${rid}:${d}`
    const why = precheck()
    if (why !== null) {
      say(key, 'warn', why)
      return false
    }
    const label = normalizeActivityLabel(rawLabel)
    const bad = activityLabelError(label)
    if (bad !== null) {
      say(key, 'warn', bad)
      return false
    }
    // 取り消しの送信待ちの項目は、届くまで入れない（〔その他〕からも。DB 側も合流させない＝2b の直しの確認の反証 中2）
    if (deletingLabels.has(label)) {
      say(key, 'warn', `「${label}」は取り消しの送信待ちです。取り消しが届いてから入れ直してください。`)
      return false
    }
    setBusyLabel(label, true)
    try {
      const r = await insertDaycareActivity({ resident_id: rid, day: d, label, participation, recorded_by: actorId })
      if (r.kind === 'queued') {
        setPending(pendingActivityOps())
        say(key, isQueuePersisted() ? 'info' : 'danger', `「${label}」：${queuedText()}`, true)
        return true
      }
      if (r.kind === 'taken') {
        const was = r.row === null ? '' : `（${ACTIVITY_PARTICIPATION_LABEL[r.row.participation]}）`
        say(key, 'warn', `「${label}」は先に記録があります${was}。いまの内容に読み直しました。確かめてから、必要なら度合いを変えてください。`)
        scheduleReload()
        return false
      }
      const row = r.row
      setRows((prevRows) => (prevRows === null ? [row] : [...prevRows.filter((x) => x.id !== row.id), row]))
      if (r.kind === 'merged') {
        // 別の端末の記録に合流した: 〔元に戻す〕は出さない（消すと先の端末の記録が消える）
        say(key, 'info', `「${label}」は同じ記録が先にありました（1件にまとめました）。`)
        return true
      }
      setMsg((m) => (m !== null && m.key === key ? null : m))
      if (!quietUndo && here.current.residentId === rid && here.current.day === d) {
        show(`${residentName}さんの活動「${label}」を記録しました`, () => void remove(row, true))
      }
      return true
    } catch (e) {
      say(key, 'danger', errText(e, '保存できませんでした。通信状態を確認して、もう一度押してください。'))
      return false
    } finally {
      setBusyLabel(label, false)
    }
  }

  const setParticipation = async (a: DaycareActivity, p: ActivityParticipation) => {
    const key = `${a.resident_id}:${a.day}`
    const why = precheck()
    if (why !== null) {
      say(key, 'warn', why)
      return
    }
    setBusyLabel(a.label, true)
    try {
      const r = await updateDaycareActivity(a, { participation: p }, { editedBy: actorId })
      if (r === 'queued') {
        setPending(pendingActivityOps())
        say(key, isQueuePersisted() ? 'info' : 'danger', `「${a.label}」の度合い：${queuedText()}`, true)
      } else if (r === 'conflict') {
        say(key, 'warn', `「${a.label}」は他の端末が先に直していました。最新の内容に読み直しました。確かめてから、もう一度押してください。`)
        scheduleReload()
      } else {
        setRows((prevRows) => (prevRows === null ? prevRows : prevRows.map((x) => (x.id === r.id ? r : x))))
        setMsg((m) => (m !== null && m.key === key ? null : m))
      }
    } catch (e) {
      say(key, 'danger', errText(e, '保存できませんでした。通信状態を確認して、もう一度押してください。'))
    } finally {
      setBusyLabel(a.label, false)
    }
  }

  const remove = async (a: DaycareActivity, fromUndo = false) => {
    setDelTarget(null)
    const key = `${a.resident_id}:${a.day}`
    const why = precheck()
    if (why !== null) {
      say(key, 'warn', why)
      return
    }
    try {
      const r = await softDeleteDaycareActivity(a, { editedBy: actorId })
      if (r === 'queued') {
        setPending(pendingActivityOps())
        say(key, isQueuePersisted() ? 'info' : 'danger', `「${a.label}」の取り消し：${queuedText()}`, true)
      } else if (r === true) {
        setRows((prevRows) => (prevRows === null ? prevRows : prevRows.filter((x) => x.id !== a.id)))
        if (!fromUndo && here.current.residentId === a.resident_id && here.current.day === a.day) {
          show(`${residentName}さんの活動「${a.label}」を取り消しました`)
        }
      } else {
        say(key, 'warn', `「${a.label}」は他の端末が先に直していました。最新の内容に読み直しました。確かめてから、もう一度押してください。`)
        scheduleReload()
      }
    } catch (e) {
      say(key, 'danger', errText(e, '取り消せませんでした。通信状態を確認して、もう一度押してください。'))
    }
  }

  // 前回は、いま開いている人・日のために読んだ分の、この方の行だけから選ぶ（人を取り違えない）
  const prevPick =
    prev === null || prev.key !== personKey ? null : previousActivities(prev.rows.filter((r) => r.resident_id === residentId), day)
  const toCopy = prevPick === null ? [] : copyItems(prevPick.items, [...labelsNow].map((label) => ({ label })))
  const copyPrev = async () => {
    // 1件ずつ足す（失敗したらそこで止め、理由は欄の下に出る）。〔元に戻す〕のトーストは出さない（件数が多いため）
    let n = 0
    for (const it of toCopy) {
      const ok = await add(it.label, it.participation, true)
      if (!ok) break
      n += 1
    }
    if (n > 0 && here.current.residentId === residentId && here.current.day === day) {
      show(`${residentName}さんの活動を前回と同じにしました（${n}件）`)
    }
  }

  const otherErr = otherText === '' ? null : activityLabelError(otherText)
  const chipCls = (on: boolean) =>
    on
      ? 'min-h-tap min-w-tap rounded border-2 border-primary bg-primary px-3 text-lg font-bold text-primary-ink disabled:opacity-90'
      : 'min-h-tap min-w-tap rounded border border-border-strong bg-surface px-3 text-lg text-ink disabled:text-ink3'
  const smallCls = (on: boolean) =>
    on
      ? 'min-h-tap rounded border-2 border-primary bg-primary px-3 text-base font-bold text-primary-ink'
      : 'min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:text-ink3'
  const fmtMd = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`
  const notice =
    gate === null || missing
      ? null
      : !canWrite && day <= today
        ? gate.forbidden
          ? FORBIDDEN_REASON
          : gate.outdated
            ? OUTDATED_REASON
            : gate.observed
              ? `${kindBlockedMessage('daycare_activity')}。記録の閲覧はできます。`
              : MSG_GATE_UNKNOWN
        : null

  return (
    <section aria-labelledby="h-act" className="space-y-2 rounded-lg border border-border bg-surface p-3">
      <h3 id="h-act" className="text-lg font-bold text-ink">
        活動・レク
      </h3>
      {missing ? (
        <p role="alert" className="rounded border border-warn bg-warn-bg p-2 text-base text-ink">
          <span aria-hidden="true">▲ </span>デイの活動の記録はまだ使えません（サーバー側の設定待ち）。管理者に連絡してください。
        </p>
      ) : null}
      {notice !== null ? (
        <p role="status" className="rounded border border-warn bg-warn-bg p-2 text-base text-ink">
          <span aria-hidden="true">ⓘ </span>
          {notice}
        </p>
      ) : null}
      {loadError !== null ? (
        <div role="alert" className="space-y-2 rounded border border-danger bg-danger-bg p-2 text-base text-ink">
          <p>
            <span aria-hidden="true">▲ </span>
            {loadError}
          </p>
          <button type="button" onClick={() => setReloadKey((n) => n + 1)} className={smallCls(false)}>
            読み直す
          </button>
        </div>
      ) : null}

      {rows === null && loadError === null && !missing ? <p className="text-base text-ink2">読み込んでいます…</p> : null}

      {rows !== null && !missing ? (
        <>
          {shown.list.length === 0 && shown.adds.length === 0 ? (
            <p className="text-base text-ink2">この日の活動の記録はまだありません。</p>
          ) : (
            <ul className="space-y-2" aria-label="この日の活動">
              {shown.list.map(({ a, participation, waiting, deleting, stopped }) =>
                deleting ? (
                  <li key={a.id} className="rounded border border-warn bg-warn-bg p-2 text-base text-ink">
                    <span className="font-bold line-through">{activityText({ label: a.label, participation })}</span>
                    {' — 取り消しの送信待ち（電波が戻ると自動で送信します。届くまで同じ項目は入れられません）'}
                  </li>
                ) : (
                <li key={a.id} className="space-y-1 rounded border border-border p-2">
                  <div className="flex flex-wrap items-center justify-between gap-gap">
                    <span className="text-lg font-bold text-ink">
                      {a.label}
                      {waiting ? <span className="ml-2 text-sm font-normal text-ink2">（送信待ち）</span> : null}
                    </span>
                    <button
                      type="button"
                      disabled={!canWrite || busy.has(a.label) || waiting}
                      onClick={() => setDelTarget(a)}
                      aria-label={`活動「${a.label}」を取り消す`}
                      className={smallCls(false)}
                    >
                      取り消す
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-gap" role="group" aria-label={`「${a.label}」の参加の度合い`}>
                    {ACTIVITY_PARTICIPATIONS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        aria-pressed={participation === p}
                        disabled={!canWrite || busy.has(a.label) || waiting}
                        onClick={() => participation !== p && void setParticipation(a, p)}
                        className={smallCls(participation === p)}
                      >
                        {ACTIVITY_PARTICIPATION_LABEL[p]}
                      </button>
                    ))}
                  </div>
                  {stopped !== null ? (
                    <p role="alert" className="rounded border border-warn bg-warn-bg p-2 text-sm text-ink">
                      <span aria-hidden="true">▲ </span>
                      {stopped.deleted
                        ? 'この端末の取り消しは、他の端末の変更と食い違って止まっています（送っていません）。'
                        : `この端末で押した〔${stopped.participation === null ? '変更' : ACTIVITY_PARTICIPATION_LABEL[stopped.participation]}〕は、他の端末の変更と食い違って止まっています（送っていません）。`}
                      上の度合いはサーバーの値です。設定の「送れていない記録」で確かめてください。
                    </p>
                  ) : null}
                  {markSlot?.(a)}
                </li>
                ),
              )}
              {shown.adds.map((p) => (
                <li key={`q:${p.label}:${p.stopped ? 's' : 'p'}`} role={p.stopped ? 'alert' : undefined} className="rounded border border-warn bg-warn-bg p-2 text-base text-ink">
                  <span className="font-bold">{activityText(p)}</span>
                  {p.stopped
                    ? ` — 他の端末の記録と食い違って止まっています（この端末で押した度合い: ${ACTIVITY_PARTICIPATION_LABEL[p.participation]}）。設定の「送れていない記録」で確かめてください。`
                    : ' — 送信待ち（電波が戻ると自動で送信します）'}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-gap" role="group" aria-label="活動を足す（押すと「参加」で記録）">
            {DAYCARE_ACTIVITY_CHIPS.map((c) => {
              const on = labelsNow.has(c)
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  disabled={!canWrite || on || busy.has(c)}
                  onClick={() => void add(c)}
                  className={chipCls(on)}
                >
                  {on ? <span aria-hidden="true">✓ </span> : null}
                  {c}
                </button>
              )
            })}
            <button
              type="button"
              aria-expanded={otherOpen}
              aria-controls="act-other"
              disabled={!canWrite}
              onClick={() => setOtherOpen((v) => !v)}
              className={chipCls(false)}
            >
              その他
            </button>
          </div>
          {otherOpen ? (
            <div id="act-other" className="flex flex-wrap items-end gap-gap">
              <label className="text-sm text-ink2">
                ほかの活動（{ACTIVITY_LABEL_MAX}字まで）
                <input
                  type="text"
                  value={otherText}
                  maxLength={ACTIVITY_LABEL_MAX * 2}
                  onChange={(e) => setOtherText(e.target.value)}
                  aria-invalid={otherErr !== null}
                  aria-describedby={otherErr !== null ? 'act-other-err' : undefined}
                  className="mt-1 block min-h-tap w-56 rounded border border-border-strong bg-surface px-2 text-lg text-ink"
                />
              </label>
              <button
                type="button"
                disabled={!canWrite || otherText.trim() === '' || otherErr !== null || busy.has(normalizeActivityLabel(otherText))}
                onClick={() =>
                  void add(otherText).then((ok) => {
                    if (ok) setOtherText('')
                  })
                }
                className={smallCls(false)}
              >
                足す
              </button>
              {otherErr !== null ? (
                <p id="act-other-err" className="w-full text-sm text-danger">
                  {otherErr}
                </p>
              ) : null}
            </div>
          ) : null}

          {prevPick !== null ? (
            <div className="flex flex-wrap items-center gap-gap text-base text-ink2">
              <span>
                前回（{fmtMd(prevPick.day)}）: {prevPick.items.map((it) => activityText(it)).join('・')}
              </span>
              {toCopy.length > 0 ? (
                <button type="button" disabled={!canWrite || busy.size > 0} onClick={() => void copyPrev()} className={smallCls(false)}>
                  前回と同じにする（{toCopy.length}件）
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {msg !== null && msg.key === personKey ? (
        <p role="status" className={`rounded border p-2 text-base text-ink ${toneCls[msg.tone]}`}>
          <span aria-hidden="true">{msg.tone === 'info' ? 'ⓘ ' : '⚠ '}</span>
          {msg.text}
        </p>
      ) : null}

      <ConfirmDialog
        open={delTarget !== null}
        title="活動の記録を取り消しますか"
        body={delTarget === null ? '' : `「${activityText(delTarget)}」を取り消します。`}
        confirmLabel="取り消す"
        danger
        onConfirm={() => delTarget !== null && void remove(delTarget)}
        onCancel={() => setDelTarget(null)}
      />
    </section>
  )
}
