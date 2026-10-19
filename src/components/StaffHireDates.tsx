// 設定画面の「職員の入職日（並び順）」（2026-10-19 本人指示）。
// 職員を選ぶ欄は入職日の順（職員マスタから名簿の同期で取り込む）。プログラムで結べない職員（姓だけで名簿に載り、
// 職員マスタに同じ姓の在籍の方が2人いる 等）は末尾に回るので、事務・管理者が入職日を手で入れて決められるようにする。
// 手で入れた入職日は名簿の同期で上書きしない（staff.hire_date_manual・0037）。〔職員マスタに戻す〕で自動に戻す。
// 現場のログインには入力欄を出さない（見るだけ）。氏名・日付は画面の state にだけ持ち、端末に保存しない。

import { useEffect, useState } from 'react'
import { canEditTargets, fetchMyRole, fetchStaff, saveStaffHireDate, subscribeMastersChanged, subscribeMyRole } from '../lib/db'
import type { MyRole } from '../lib/db'
import type { Staff } from '../lib/types'
import { EmptyBlock, ErrorBlock, LoadingBlock, SectionCard } from './ui'

/** 出どころの表示（色だけに頼らず文字で出す） */
export function hireSourceLabel(s: Pick<Staff, 'hire_date' | 'hire_date_manual'>): string {
  if (s.hire_date_manual === true) return '手で入力'
  if (s.hire_date) return '職員マスタ'
  return 'なし（末尾に並ぶ）'
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

  return (
    <SectionCard title="職員の入職日（並び順）">
      <p className="text-base text-ink2">
        職員を選ぶ欄は入職日の古い順に並びます。入職日は名簿の同期で職員マスタから取り込みます。
        職員マスタと結び付かなかった職員は末尾に並ぶので、ここで入職日を入れると正しい位置に並びます。
      </p>
      <p className="mt-1 text-sm text-ink2">
        <span aria-hidden="true">ⓘ </span>
        手で入れた入職日は、名簿の同期で上書きされません。〔職員マスタに戻す〕で自動の取り込みに戻せます。
        {canEdit ? '' : '入職日を変えられるのは、事務・管理者のログインだけです。'}
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
                return (
                  <li key={s.id} className="rounded border border-border bg-surface p-3">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="tabular text-sm text-ink2">{`${i + 1}.`}</span>
                      <span className="text-base font-bold text-ink">{s.name}</span>
                      <span className="tabular text-base text-ink">{fmtDate(s.hire_date)}</span>
                      <span className="text-sm text-ink2">{`（${hireSourceLabel(s)}）`}</span>
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
