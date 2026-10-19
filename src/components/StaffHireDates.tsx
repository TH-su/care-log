// 設定画面の「職員の入職日（並び順）」（2026-10-19 本人指示）。
// 職員を選ぶ欄は入職日の順（職員マスタから名簿の同期で取り込む）。プログラムで結べない職員（姓だけで名簿に載り、
// 職員マスタに同じ姓の在籍の方が2人いる 等）は末尾に回るので、事務・管理者が入職日を手で入れて決められるようにする。
// 手で入れた入職日は名簿の同期で上書きしない（staff.hire_date_manual・0037）。〔職員マスタに戻す〕で自動に戻す。
// 同じ入職日の職員は「同じ入職日の中の順」（staff.master_no・0038）の小さい順。名簿の同期が職員マスタの職員No を入れ、
// 職員No の順が実際の入職の順と違う時は、ここで手で順を入れる（staff.master_no_manual・名簿の同期で上書きしない）。
// 現場のログインには入力欄を出さない（見るだけ）。氏名・日付は画面の state にだけ持ち、端末に保存しない。

import { useEffect, useState } from 'react'
import { canEditTargets, fetchMyRole, fetchStaff, saveStaffHireDate, saveStaffMasterNo, subscribeMastersChanged, subscribeMyRole } from '../lib/db'
import type { MyRole } from '../lib/db'
import type { Staff } from '../lib/types'
import { EmptyBlock, ErrorBlock, LoadingBlock, SectionCard } from './ui'

/** 出どころの表示（色だけに頼らず文字で出す） */
export function hireSourceLabel(s: Pick<Staff, 'hire_date' | 'hire_date_manual'>): string {
  if (s.hire_date_manual === true) return '手で入力'
  if (s.hire_date) return '職員マスタ'
  return 'なし（末尾に並ぶ）'
}

/** 同じ入職日の中の順の出どころ */
export function noSourceLabel(s: Pick<Staff, 'master_no' | 'master_no_manual'>): string {
  if (s.master_no_manual === true) return '手で入力'
  if (s.master_no != null) return '職員マスタの職員No'
  return 'なし（同じ入職日の中で末尾）'
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  const [y, m, dd] = d.split('-')
  return `${y}/${Number(m)}/${Number(dd)}`
}

export function StaffHireDates() {
  const [rows, setRows] = useState<Staff[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [open, setOpen] = useState(false)
  const [role, setRole] = useState<MyRole | null | undefined>(undefined)
  const [draft, setDraft] = useState<Record<number, string>>({})
  const [draftNo, setDraftNo] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ id: number; text: string; tone: 'ok' | 'err' } | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => {
      fetchMyRole().then((r) => {
        if (alive) setRole(r)
      })
    }
    load()
    const off = subscribeMyRole(load)
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    let alive = true
    setError(null)
    fetchStaff()
      .then((list) => {
        if (alive) setRows(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (alive) setError('職員の一覧を読み込めませんでした。通信状態を確認して、もう一度お試しください。')
      })
    return () => {
      alive = false
    }
  }, [reload])

  // 名簿の同期・ほかの所での変更の後に読み直す
  useEffect(() => subscribeMastersChanged(() => setReload((n) => n + 1)), [])

  const canEdit = canEditTargets(role)

  async function save(s: Staff, date: string | null) {
    setBusy(s.id)
    setMsg(null)
    try {
      await saveStaffHireDate(s.id, date)
      setDraft((d) => {
        const n = { ...d }
        delete n[s.id]
        return n
      })
      setMsg({ id: s.id, tone: 'ok', text: date === null ? '職員マスタに戻しました（次の名簿の同期で入職日が入ります）。' : '入職日を保存しました。' })
      setReload((n) => n + 1)
    } catch (e) {
      setMsg({ id: s.id, tone: 'err', text: e instanceof Error && e.message ? e.message : '保存できませんでした。' })
    } finally {
      setBusy(null)
    }
  }

  async function saveNo(s: Staff, no: number | null) {
    setBusy(s.id)
    setMsg(null)
    try {
      await saveStaffMasterNo(s.id, no)
      setDraftNo((d) => {
        const n = { ...d }
        delete n[s.id]
        return n
      })
      setMsg({ id: s.id, tone: 'ok', text: no === null ? '順を職員マスタに戻しました（次の名簿の同期で職員No が入ります）。' : '同じ入職日の中の順を保存しました。' })
      setReload((n) => n + 1)
    } catch (e) {
      setMsg({ id: s.id, tone: 'err', text: e instanceof Error && e.message ? e.message : '保存できませんでした。' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <SectionCard title="職員の入職日（並び順）">
      <p className="text-base text-ink2">
        職員を選ぶ欄は入職日の古い順に並びます。入職日は名簿の同期で職員マスタから取り込みます。
        職員マスタと結び付かなかった職員は末尾に並ぶので、ここで入職日を入れると正しい位置に並びます。
        同じ入職日の職員は「同じ入職日の中の順」の小さい順に並びます（名簿の同期で職員マスタの職員No が入ります。違う時はここで直せます）。
      </p>
      <p className="mt-1 text-sm text-ink2">
        <span aria-hidden="true">ⓘ </span>
        手で入れた入職日・順は、名簿の同期で上書きされません。〔職員マスタに戻す〕で自動の取り込みに戻せます。
        {canEdit ? '' : '入職日・順を変えられるのは、事務・管理者のログインだけです。'}
      </p>
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="cl-hire-list"
          className="min-h-tap rounded border border-primary px-4 text-base font-bold text-primary"
        >
          {open ? '一覧を閉じる' : '一覧を開く'}
        </button>
      </div>
      {open ? (
        <div id="cl-hire-list" className="mt-3">
          {error ? (
            <ErrorBlock message={error} onRetry={() => setReload((n) => n + 1)} />
          ) : rows === null ? (
            <LoadingBlock label="職員の一覧を読み込んでいます…" />
          ) : rows.length === 0 ? (
            <EmptyBlock message="在籍中の職員がいません。マスタ同期を実行してください。" />
          ) : (
            <ol className="space-y-2">
              {rows.map((s, i) => {
                const value = draft[s.id] ?? s.hire_date ?? ''
                const dirty = (draft[s.id] ?? null) !== null && draft[s.id] !== (s.hire_date ?? '')
                const inputId = `cl-hire-${s.id}`
                const noValue = draftNo[s.id] ?? (s.master_no != null ? String(s.master_no) : '')
                const noDirty = (draftNo[s.id] ?? null) !== null && draftNo[s.id] !== (s.master_no != null ? String(s.master_no) : '')
                const noValid = /^\d{1,9}$/.test(noValue.normalize('NFKC').trim())
                const noInputId = `cl-hire-no-${s.id}`
                return (
                  <li key={s.id} className="rounded border border-border bg-surface p-3">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="tabular text-sm text-ink2">{`${i + 1}.`}</span>
                      <span className="text-base font-bold text-ink">{s.name}</span>
                      <span className="tabular text-base text-ink">{fmtDate(s.hire_date)}</span>
                      <span className="text-sm text-ink2">{`（${hireSourceLabel(s)}）`}</span>
                    </div>
                    <div className="mt-1 text-sm text-ink2">
                      <span className="tabular">{`同じ入職日の中の順：${s.master_no != null ? s.master_no : '—'}`}</span>
                      {`（${noSourceLabel(s)}）`}
                    </div>
                    {canEdit ? (
                      <div className="mt-2 flex flex-wrap items-center gap-gap">
                        <label htmlFor={inputId} className="sr-only">{`${s.name}の入職日`}</label>
                        <input
                          id={inputId}
                          type="date"
                          value={value}
                          onChange={(e) => setDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                          className="min-h-tap rounded border border-border bg-surface px-3 text-base text-ink"
                        />
                        <button
                          type="button"
                          disabled={!dirty || busy !== null || !/^\d{4}-\d{2}-\d{2}$/.test(value)}
                          onClick={() => void save(s, value)}
                          className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:opacity-50"
                        >
                          {busy === s.id ? '保存中…' : '保存する'}
                        </button>
                        {s.hire_date_manual === true ? (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void save(s, null)}
                            className="min-h-tap rounded border border-border px-4 text-base text-ink disabled:opacity-50"
                          >
                            職員マスタに戻す
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {canEdit ? (
                      <div className="mt-2 flex flex-wrap items-center gap-gap">
                        <label htmlFor={noInputId} className="text-sm text-ink2">同じ入職日の中の順</label>
                        <input
                          id={noInputId}
                          type="text"
                          inputMode="numeric"
                          value={noValue}
                          onChange={(e) => setDraftNo((d) => ({ ...d, [s.id]: e.target.value }))}
                          className="tabular min-h-tap w-24 rounded border border-border bg-surface px-3 text-base text-ink"
                        />
                        <button
                          type="button"
                          disabled={!noDirty || busy !== null || !noValid}
                          onClick={() => void saveNo(s, Number(noValue.normalize('NFKC').trim()))}
                          className="min-h-tap rounded border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:opacity-50"
                        >
                          {busy === s.id ? '保存中…' : '順を保存する'}
                        </button>
                        {s.master_no_manual === true ? (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void saveNo(s, null)}
                            className="min-h-tap rounded border border-border px-4 text-base text-ink disabled:opacity-50"
                          >
                            順を職員マスタに戻す
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {msg && msg.id === s.id ? (
                      <p role={msg.tone === 'err' ? 'alert' : 'status'} className={`mt-1 text-sm ${msg.tone === 'err' ? 'text-danger' : 'text-ink2'}`}>
                        {msg.tone === 'err' ? <span aria-hidden="true">▲ </span> : null}
                        {msg.text}
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      ) : null}
    </SectionCard>
  )
}
