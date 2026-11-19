// 日報の確認欄の読み込み（表示中の日の ✔ と勤務表）をまとめて持つ（2026-11-19・0065）。
// 日報の画面が1つだけ持ち、日ごとの枠へ配る（日ごとに読みに行かない＝10日表示でも問い合わせは ✔ 1回＋勤務表）。
// 読み込みは表示中の日が変わった時・〔最新に更新〕（reloadToken）・✔ を付けた／取り消した後。表示系から書き込まない。
// 勤務表は db.ts がメモリに5分控える（氏名・勤務の区分だけをここへ渡す）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addReadCheck, cancelReadCheck, fetchReadChecks, fetchShiftSource } from '../lib/db'
import { buildDutyTable } from '../lib/shiftDuty'
import type { DutyTable } from '../lib/shiftDuty'

export interface ReadChecksState {
  /** 日 → ✔ のある職員の id */
  checks: Map<string, Set<number>>
  /** 表が無い（0065 未適用） */
  missing: boolean
  /** ✔ を読めなかった（通信など） */
  loadFailed: boolean
  /** 読み込み済みか（最初の読み込みが終わるまで false） */
  loaded: boolean
  /** 勤務表から作った日ごとの区分（読めない時は null） */
  duty: DutyTable | null
  /** 勤務表で日報の対象の職員の氏名の鍵（読めない時は null） */
  dailyKeys: Set<string> | null
  /** 送っている最中の（日|職員） */
  busy: Set<string>
  add: (day: string, staffId: number, recordedBy: number | null) => Promise<void>
  cancel: (day: string, staffId: number, editedBy: number | null) => Promise<void>
}

export function useReadChecks(days: readonly string[], reloadToken: number): ReadChecksState {
  const key = days.join(',')
  const [checks, setChecks] = useState<Map<string, Set<number>>>(new Map())
  const [missing, setMissing] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [duty, setDuty] = useState<DutyTable | null>(null)
  const [dailyKeys, setDailyKeys] = useState<Set<string> | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [bump, setBump] = useState(0)
  const genRef = useRef(0)

  useEffect(() => {
    const my = ++genRef.current
    const list = key === '' ? [] : key.split(',')
    let alive = true
    void (async () => {
      try {
        const r = await fetchReadChecks(list)
        if (!alive || my !== genRef.current) return
        const m = new Map<string, Set<number>>()
        for (const d of list) m.set(d, new Set())
        for (const row of r.rows) m.get(row.day)?.add(row.staff_id)
        setChecks(m)
        setMissing(r.missing)
        setLoadFailed(false)
      } catch {
        if (!alive || my !== genRef.current) return
        setLoadFailed(true)
      } finally {
        if (alive && my === genRef.current) setLoaded(true)
      }
    })()
    void (async () => {
      const src = await fetchShiftSource(list)
      if (!alive || my !== genRef.current) return
      if (!src) {
        setDuty(null)
        setDailyKeys(null)
        return
      }
      const table = buildDutyTable(src, list)
      const keys = new Set<string>()
      for (const row of table.values()) for (const k of row.keys()) keys.add(k)
      setDuty(table.size > 0 ? table : null)
      setDailyKeys(table.size > 0 ? keys : null)
    })()
    return () => {
      alive = false
    }
  }, [key, reloadToken, bump])

  const mark = useCallback((k: string, on: boolean) => {
    setBusy((cur) => {
      const next = new Set(cur)
      if (on) next.add(k)
      else next.delete(k)
      return next
    })
  }, [])

  const add = useCallback(
    async (day: string, staffId: number, recordedBy: number | null) => {
      const k = `${day}|${staffId}`
      mark(k, true)
      try {
        await addReadCheck({ day, staffId, recordedBy })
        setChecks((cur) => {
          const next = new Map(cur)
          const s = new Set(next.get(day) ?? [])
          s.add(staffId)
          next.set(day, s)
          return next
        })
      } finally {
        mark(k, false)
        setBump((n) => n + 1) // ほかの端末の ✔ も読み直す
      }
    },
    [mark],
  )

  const cancel = useCallback(
    async (day: string, staffId: number, editedBy: number | null) => {
      const k = `${day}|${staffId}`
      mark(k, true)
      try {
        await cancelReadCheck({ day, staffId }, { editedBy })
        setChecks((cur) => {
          const next = new Map(cur)
          const s = new Set(next.get(day) ?? [])
          s.delete(staffId)
          next.set(day, s)
          return next
        })
      } finally {
        mark(k, false)
        setBump((n) => n + 1)
      }
    },
    [mark],
  )

  return useMemo(
    () => ({ checks, missing, loadFailed, loaded, duty, dailyKeys, busy, add, cancel }),
    [checks, missing, loadFailed, loaded, duty, dailyKeys, busy, add, cancel],
  )
}
