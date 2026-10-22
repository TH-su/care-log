// カルテの「個人の閾値」カード（段階2d・2026-10-22 代表者承認・段階2の計画 v1 の 3.2・A7）。
//
// ・その方の、今日に効く基準（個人の値 > 施設の基準。崩れた項目は施設の基準に戻して知らせる）・開始日・根拠と、行の一覧（予定を含む）を出す
// ・事務・管理者だけ足せる（9項目は空欄＝施設の基準・全部空欄＝この日から施設の基準に戻す。開始日は今日以降・根拠は必須）
// ・取り消しは足した日の当日だけ（DB のトリガが守る。画面も当日の行にだけ〔取り消す〕を出す）
// ・書き込みは db.ts の addResidentVitalLimit・cancelResidentVitalLimit だけ（送信待ちに載せない＝個別の目標と同じ）
// ・端末に業務データを残さない（localStorage を使わない）

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { DbError, addResidentVitalLimit, canEditTargets, cancelResidentVitalLimit } from '../lib/db'
import type { MyRole } from '../lib/db'
import { fetchResidentVitalLimits } from '../lib/cachedReads'
import {
  VITAL_LIMIT_FIELDS,
  VITAL_LIMIT_LABEL,
  VITAL_LIMIT_RANGES,
  baseGroupText,
  cancelableToday,
  fallbackNotice,
  inputFallback,
  limitFor,
  limitSummary,
  parseVitalLimitInput,
  thresholdsFor,
} from '../lib/vitalLimits'
import type { ResidentVitalLimit, VitalLimitGroup, VitalLimitInput } from '../lib/vitalLimits'
import { vitalThresholds } from '../lib/vitalThresholds'
import { todayIso } from '../lib/format'
import { ConfirmDialog } from './ui'

interface Props {
  residentId: number
  role: MyRole | null | undefined
}

type Msg = { tone: 'ok' | 'warn' | 'danger'; text: string }

const emptyInput = (today: string): VitalLimitInput => {
  const v = { valid_from: today, basis: '' } as VitalLimitInput
  for (const f of VITAL_LIMIT_FIELDS) v[f] = ''
  return v
}
const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`

export function VitalLimitsCard({ residentId, role }: Props) {
  const canEdit = canEditTargets(role)
  const uid = useId()
  const today = todayIso()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [rows, setRows] = useState<ResidentVitalLimit[]>([])
  const [missing, setMissing] = useState(false)
  const [tick, setTick] = useState(0)
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState<VitalLimitInput>(() => emptyInput(today))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)
  const [delRow, setDelRow] = useState<ResidentVitalLimit | null>(null)
  /**
   * 〔足す〕の初めの値を取った行（選んだ開始日の直前に効く行。無ければ null）と、そこから値を直したか（2d-1 の反証 中3）。
   * 開始日を変えた時、直していなければその日の直前に効く行の値を入れ直し、直していれば知らせて〔その行の値を入れる〕を出す
   */
  const [prefillFrom, setPrefillFrom] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)
  const ridRef = useRef(residentId)
  ridRef.current = residentId

  const load = useCallback(async () => {
    try {
      const r = await fetchResidentVitalLimits()
      setRows(r.rows)
      setMissing(r.missing)
      setState('ready')
    } catch {
      setState('error')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load, tick])
  // 利用者が変わったら入力・案内を持ち越さない
  useEffect(() => {
    setOpen(false)
    setMsg(null)
    setInput(emptyInput(todayIso()))
  }, [residentId])

  const mine = rows.filter((r) => r.resident_id === residentId).sort((a, b) => b.valid_from.localeCompare(a.valid_from) || b.id - a.id)
  const now = limitFor(rows, residentId, today)
  const eff = thresholdsFor(now, vitalThresholds())
  const upcoming = mine.filter((r) => r.valid_from > today).sort((a, b) => a.valid_from.localeCompare(b.valid_from))
  const fb = fallbackNotice(eff.fallback)
  const tag = (g: VitalLimitGroup) => (eff.individual.has(g) ? '（個人の基準）' : '（施設の基準）')

  const submit = async () => {
    const rid = residentId
    const p = parseVitalLimitInput(input, todayIso())
    if (!p.ok) {
      setMsg({ tone: 'warn', text: p.message })
      return
    }
    // 施設の基準と合わせて段階の順が崩れる項目は効かないので、足す前に止める（2d-1 の反証 中2。先の日の行は効く日まで気づけないため）
    const base = vitalThresholds()
    const fb = inputFallback(p.value, base)
    if (fb.size > 0) {
      const names = (['temp', 'sysBp', 'diaBp', 'pulse'] as const).filter((g) => fb.has(g))
      setMsg({
        tone: 'warn',
        text: `入れた値は施設の基準と合わせると段階の順が崩れるため、効きません: ${names.map((g) => baseGroupText(g, base)).join('・')}。この項目は値をそろえて入れるか、空欄にしてください（入力は消えていません）。`,
      })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const res = await addResidentVitalLimit(rid, p.value)
      if (ridRef.current !== rid) return
      if (res === 'conflict') {
        setMsg({ tone: 'warn', text: '同じ開始日の行が先にあります。読み直しました。確かめてください（入力は消えていません）。' })
        setTick((n) => n + 1)
        return
      }
      setOpen(false)
      setInput(emptyInput(todayIso()))
      setMsg({ tone: 'ok', text: `${md(res.valid_from)} から効く個人の閾値を足しました。` })
      setTick((n) => n + 1)
    } catch (e) {
      if (ridRef.current !== rid) return
      setMsg({ tone: 'danger', text: e instanceof DbError ? e.message : '保存できませんでした。通信状態を確認して、もう一度お試しください（入力は消えていません）。' })
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (row: ResidentVitalLimit) => {
    setDelRow(null)
    const rid = residentId
    setBusy(true)
    setMsg(null)
    try {
      const res = await cancelResidentVitalLimit(row)
      if (ridRef.current !== rid) return
      setMsg(res === true ? { tone: 'ok', text: '行を取り消しました。' } : { tone: 'warn', text: '他の端末が先に変えていました。読み直しました。' })
      setTick((n) => n + 1)
    } catch (e) {
      if (ridRef.current !== rid) return
      setMsg({ tone: 'danger', text: e instanceof DbError ? e.message : '取り消せませんでした。通信状態を確認して、もう一度お試しください。' })
    } finally {
      setBusy(false)
    }
  }

  /** その開始日の直前に効く行（その日ちょうどの行は除く＝同じ日には足せない）の値を入れる */
  const baseRowFor = (from: string): ResidentVitalLimit | null =>
    limitFor(
      rows.filter((r) => !(r.resident_id === residentId && r.valid_from === from)),
      residentId,
      from,
    )
  const fillFrom = (v: VitalLimitInput, from: string): VitalLimitInput => {
    const b = baseRowFor(from)
    const out = { ...v, valid_from: from }
    for (const f of VITAL_LIMIT_FIELDS) out[f] = b === null || b[f] === null || !Number.isFinite(b[f]) ? '' : String(b[f])
    setPrefillFrom(b?.id ?? null)
    return out
  }
  const fromRow = open ? baseRowFor(input.valid_from) : null
  const fromChanged = open && (fromRow?.id ?? null) !== prefillFrom
  const t = eff.t
  const msgCls = msg === null ? '' : msg.tone === 'ok' ? 'border-ok bg-ok-bg' : msg.tone === 'warn' ? 'border-warn bg-warn-bg' : 'border-danger bg-danger-bg'
  const btn = 'min-h-tap rounded border border-border-strong bg-surface px-3 text-base text-ink disabled:text-ink3'

  return (
    <section aria-labelledby={`${uid}-h`} className="mt-3 rounded-lg border border-border bg-surface p-3 text-base text-ink">
      <h2 id={`${uid}-h`} className="text-lg font-bold">
        個人の閾値（バイタルの印の基準）
      </h2>
      <p className="mt-1 text-sm text-ink2">
        主治医の指示などで、この方だけ基準を変える時に使います。空欄の項目は施設の基準です。足した行は書き換えられず、開始日より前の日の記録には効きません。
      </p>
      <p className="mt-1 rounded border border-warn bg-warn-bg p-2 text-sm">
        <span aria-hidden="true">ⓘ </span>いまは記録の画面の印にはまだ効いていません（段階2d の後半の更新で効かせます）。ここで足した値は残ります。
      </p>
      {state === 'loading' ? <p className="mt-2 text-sm text-ink2">読み込んでいます…</p> : null}
      {state === 'error' ? (
        <div role="alert" className="mt-2 space-y-2 rounded border border-danger bg-danger-bg p-2 text-sm">
          <p>
            <span aria-hidden="true">▲ </span>個人の閾値を読み込めませんでした（施設の基準で判定しています）。
          </p>
          <button type="button" onClick={() => setTick((n) => n + 1)} className={btn}>
            読み直す
          </button>
        </div>
      ) : null}
      {state === 'ready' && missing ? (
        <p role="status" className="mt-2 rounded border border-warn bg-warn-bg p-2 text-sm">
          <span aria-hidden="true">▲ </span>個人の閾値はまだ使えません（サーバー側の設定待ち）。全員が施設の基準で判定されます。
        </p>
      ) : null}
      {state === 'ready' && !missing ? (
        <>
          <dl className="mt-2 grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="font-bold">体温</dt>
            <dd>
              注意 {t.temp.warnHigh}℃以上・危険 {t.temp.dangerHigh}℃以上・危険の低 {t.temp.dangerLow}℃以下{tag('temp')}
            </dd>
            <dt className="font-bold">血圧の上</dt>
            <dd>
              危険 {t.sysBp.dangerHigh}以上・注意の低 {t.sysBp.warnLow}未満{tag('sysBp')}
            </dd>
            <dt className="font-bold">血圧の下</dt>
            <dd>
              危険 {t.diaBp.dangerHigh}以上・注意の低 {t.diaBp.warnLow}未満{tag('diaBp')}
            </dd>
            <dt className="font-bold">脈</dt>
            <dd>
              危険 {t.pulse.dangerHigh}以上・注意の低 {t.pulse.warnLow}未満{tag('pulse')}
            </dd>
          </dl>
          <p className="mt-1 text-sm text-ink2">
            {now === null ? '今日はすべて施設の基準です。' : `${md(now.valid_from)} から（根拠: ${now.basis}）`}
          </p>
          {fb !== null ? (
            <p role="status" className="mt-1 rounded border border-warn bg-warn-bg p-2 text-sm">
              <span aria-hidden="true">▲ </span>
              {fb}
            </p>
          ) : null}
          {upcoming.length > 0 ? (
            <div className="mt-1 space-y-1 text-sm">
              <p>
                <span aria-hidden="true">ⓘ </span>これから効く行: {upcoming.map((r) => `${md(r.valid_from)} から`).join('・')}
              </p>
              {upcoming.map((r) => {
                const n = fallbackNotice(thresholdsFor(r, vitalThresholds()).fallback)
                return n === null ? null : (
                  <p key={r.id} role="status" className="rounded border border-warn bg-warn-bg p-2">
                    <span aria-hidden="true">▲ </span>
                    {md(r.valid_from)} からの行: {n}
                  </p>
                )
              })}
            </div>
          ) : null}
          {mine.length > 0 ? (
            <details className="mt-2">
              <summary className="min-h-tap cursor-pointer py-2 text-sm font-bold">行の一覧（{mine.length}件）</summary>
              <ul className="space-y-2">
                {mine.map((r) => (
                  <li key={r.id} className="rounded border border-border p-2 text-sm">
                    <p className="font-bold">{md(r.valid_from)} から</p>
                    <p>{limitSummary(r)}</p>
                    <p className="text-ink2">根拠: {r.basis}</p>
                    {canEdit && cancelableToday(r, today) ? (
                      <button type="button" disabled={busy} onClick={() => setDelRow(r)} className={`${btn} mt-1`} aria-label={`${md(r.valid_from)} からの行を取り消す`}>
                        取り消す（足した当日だけ）
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {canEdit ? (
            open ? (
              <div className="mt-3 space-y-2 rounded border border-border p-2">
                <p className="text-sm text-ink2">
                  足す行は、開始日からの一式です。いま効いている個人の値を入れてあります。変えない項目もそのまま残してください（空欄にした項目は施設の基準に戻ります。全部空欄にすると「この日から施設の基準に戻す」行になります）。
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {VITAL_LIMIT_FIELDS.map((f) => (
                    <label key={f} className="block text-sm">
                      {VITAL_LIMIT_LABEL[f]}
                      <span className="ml-1 text-ink2">
                        （{VITAL_LIMIT_RANGES[f].min}〜{VITAL_LIMIT_RANGES[f].max}）
                      </span>
                      <input
                        type="text"
                        inputMode={VITAL_LIMIT_RANGES[f].decimal ? 'decimal' : 'numeric'}
                        value={input[f]}
                        onChange={(e) => {
                          setInput({ ...input, [f]: e.target.value })
                          setDirty(true)
                        }}
                        className="mt-1 block min-h-tap w-full rounded border border-border-strong bg-surface px-2 text-lg"
                      />
                    </label>
                  ))}
                </div>
                <label className="block text-sm">
                  開始日（今日以降。この日の記録から効きます）
                  <input
                    type="date"
                    min={today}
                    value={input.valid_from}
                    onChange={(e) => {
                      const from = e.target.value
                      // 値を直していなければ、新しい開始日の直前に効く行の値を入れ直す（直していれば下で知らせる）
                      setInput(dirty ? { ...input, valid_from: from } : fillFrom(input, from))
                    }}
                    className="mt-1 block min-h-tap rounded border border-border-strong bg-surface px-2 text-lg"
                  />
                </label>
                {fromChanged ? (
                  <div role="status" className="space-y-1 rounded border border-warn bg-warn-bg p-2 text-sm">
                    <p>
                      <span aria-hidden="true">▲ </span>
                      {fromRow === null
                        ? 'この開始日の前には個人の行がありません（いまの入力は、別の行の値から入れたものです）。'
                        : `この開始日の直前に効くのは ${md(fromRow.valid_from)} からの行（${limitSummary(fromRow)}）です。いまの入力は別の行の値から入れたものです。`}
                    </p>
                    <button type="button" onClick={() => { setInput(fillFrom(input, input.valid_from)); setDirty(false) }} className={btn}>
                      {fromRow === null ? '空欄にする（施設の基準）' : `${md(fromRow.valid_from)} からの行の値を入れる`}
                    </button>
                  </div>
                ) : null}
                <label className="block text-sm">
                  根拠（必須・200字まで。主治医の指示とその日付など）
                  <textarea
                    value={input.basis}
                    rows={2}
                    onChange={(e) => setInput({ ...input, basis: e.target.value })}
                    className="mt-1 block w-full rounded border border-border-strong bg-surface px-2 py-1 text-lg"
                  />
                </label>
                <div className="flex flex-wrap justify-end gap-gap">
                  <button type="button" disabled={busy} onClick={() => setOpen(false)} className={btn}>
                    やめる
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void submit()}
                    className="min-h-tap rounded border-2 border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border-strong disabled:bg-surface disabled:text-ink3"
                  >
                    {busy ? '保存しています…' : '足す'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  // 行は「その日からの一式」（空欄＝施設の基準）。開始日（初めは今日）の直前に効く個人の値を初めから入れておく
                  setInput(fillFrom(emptyInput(todayIso()), todayIso()))
                  setDirty(false)
                  setOpen(true)
                }}
                className={`${btn} mt-2`}
              >
                個人の閾値を足す
              </button>
            )
          ) : (
            <p className="mt-2 text-sm text-ink2">変えられるのは事務・管理者のログインだけです（現場のログインでは見るだけです）。</p>
          )}
        </>
      ) : null}
      {msg !== null ? (
        <p role={msg.tone === 'danger' ? 'alert' : 'status'} className={`mt-2 rounded border p-2 text-sm ${msgCls}`}>
          {msg.text}
        </p>
      ) : null}
      <ConfirmDialog
        open={delRow !== null}
        title="個人の閾値の行を取り消しますか"
        body={delRow === null ? '' : `${md(delRow.valid_from)} からの行（${limitSummary(delRow)}）を取り消します。取り消せるのは足した日の当日だけです。`}
        confirmLabel="取り消す"
        danger
        onConfirm={() => delRow !== null && void cancel(delRow)}
        onCancel={() => setDelRow(null)}
      />
    </section>
  )
}
