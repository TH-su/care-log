// 日報の確認欄の読み込み（表示中の日の ✔ と勤務表）をまとめて持つ（2026-11-19・0065）。
// 日報の画面が1つだけ持ち、日ごとの枠へ配る（日ごとに読みに行かない＝10日表示でも問い合わせは ✔ 1回＋勤務表）。
// 読み込みは表示中の日が変わった時・〔最新に更新〕（reloadToken）・✔ を付けた／取り消した後。表示系から書き込まない。
// 勤務表は db.ts がメモリに5分控える（氏名・勤務の区分だけをここへ渡す）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addReadCheck, cancelReadCheck, fetchReadChecks, fetchShiftSource } from '../lib/db'
import { buildDutyTable, buildFacilityDutyTable, nameKey, notFacilityStaff } from '../lib/shiftDuty'
import type { DutyTable, FacilityDutyTable } from '../lib/shiftDuty'
import { checkPanelDutyDays, unreadDutyDays, unreadWindow } from '../lib/readCheck'

export interface ReadChecksState {
  /** 日 → ✔ のある職員の id */
  checks: Map<string, Set<number>>
  /** 表が無い（0065 未適用） */
  missing: boolean
  /** ✔ を読めなかった（通信など） */
  loadFailed: boolean
  /** 表示中の日の ✔ を読み終えたか（日を替えると false に戻る＝前の日の ✔ で判定しない） */
  loaded: boolean
  /** 表示中の日の勤務表を読み終えたか（読めなかった時も true。読む前に出勤者の欄で判定して赤を出さない） */
  shiftLoaded: boolean
  /** 勤務表から作った日ごとの区分（読めない時は null） */
  duty: DutyTable | null
  /** 勤務表で日報の対象の職員の氏名の鍵（読めない時は null） */
  dailyKeys: Set<string> | null
  /** 勤務表の名簿の全員（在籍）の氏名の鍵（読めない時は null） */
  rosterKeys: Set<string> | null
  /** 表示中の日とその翌日の施設の勤務（確認欄に並べる人を決める・読めない時は null） */
  fac: FacilityDutyTable | null
  /** 主の区分が通所（デイ職員）の氏名の鍵（読めない時は null） */
  dayKeys: Set<string> | null
  /** 送っている最中の（日|職員） */
  busy: Set<string>
  /** ✔ を付けた・取り消した回数（未読者欄の読み直しの合図） */
  version: number
  add: (day: string, staffId: number, recordedBy: number | null) => Promise<void>
  cancel: (day: string, staffId: number, editedBy: number | null) => Promise<void>
}

export function useReadChecks(days: readonly string[], reloadToken: number): ReadChecksState {
  const key = days.join(',')
  const [checks, setChecks] = useState<Map<string, Set<number>>>(new Map())
  const [missing, setMissing] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [shiftLoaded, setShiftLoaded] = useState(false)
  /** どの日の組を読み終えたか（日を替えた直後は前の組の結果を使わない） */
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [shiftKey, setShiftKey] = useState<string | null>(null)
  const [duty, setDuty] = useState<DutyTable | null>(null)
  const [dailyKeys, setDailyKeys] = useState<Set<string> | null>(null)
  const [rosterKeys, setRosterKeys] = useState<Set<string> | null>(null)
  const [fac, setFac] = useState<FacilityDutyTable | null>(null)
  const [dayKeys, setDayKeys] = useState<Set<string> | null>(null)
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
        if (alive && my === genRef.current) {
          setLoaded(true)
          setLoadedKey(key)
        }
      }
    })()
    void (async () => {
      // 確認欄は日報 R に「R の翌日に日勤の人」も並べるので、表示中の日の翌日の勤務表も読む
      const dutyDays = checkPanelDutyDays(list)
      const src = await fetchShiftSource(dutyDays)
      if (!alive || my !== genRef.current) return
      setShiftLoaded(true)
      setShiftKey(key)
      if (!src) {
        setDuty(null)
        setDailyKeys(null)
        setRosterKeys(null)
        setFac(null)
        setDayKeys(null)
        return
      }
      const ft = buildFacilityDutyTable(src, dutyDays)
      const dk = new Set<string>()
      for (const st of src.staff) {
        if (st.active === false || st.status === '退職') continue
        const k = nameKey(st.name)
        if (k && notFacilityStaff(st)) dk.add(k)
      }
      setFac(ft.size > 0 ? ft : null)
      setDayKeys(dk)
      const table = buildDutyTable(src, list)
      const keys = new Set<string>()
      for (const row of table.values()) for (const k of row.keys()) keys.add(k)
      const roster = new Set<string>()
      for (const st of src.staff) {
        if (st.active === false || st.status === '退職') continue
        const k = nameKey(st.name)
        if (k) roster.add(k)
      }
      setDuty(table.size > 0 ? table : null)
      setDailyKeys(table.size > 0 ? keys : null)
      setRosterKeys(table.size > 0 ? roster : null)
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

  // 日を替えた直後（読み終える前）は「まだ」とみなす＝前の日の組の ✔・勤務表で判定して赤を出さない
  const loadedNow = loaded && loadedKey === key
  const shiftNow = shiftLoaded && shiftKey === key
  return useMemo(
    () => ({ checks, missing, loadFailed, loaded: loadedNow, shiftLoaded: shiftNow, duty, dailyKeys, rosterKeys, fac, dayKeys, busy, version: bump, add, cancel }),
    [checks, missing, loadFailed, loadedNow, shiftNow, duty, dailyKeys, rosterKeys, fac, dayKeys, busy, bump, add, cancel],
  )
}

/** 未読者欄の材料（昨日までの数える日の ✔ と、その翌日までの施設の勤務） */
export interface UnreadSource {
  /** 読み終えた（✔ と勤務表の両方。どちらかが読めなかった時は failed） */
  ready: boolean
  failed: boolean
  missing: boolean
  /** 読み終えた時の今日（日を替えた直後は前の今日の結果で判定しない） */
  today: string | null
  checks: Map<string, Set<number>>
  duty: FacilityDutyTable | null
  /** 勤務表の名簿の全員（在籍）の氏名の鍵・主の区分が通所の人の氏名の鍵（読めない時は null） */
  roster: Set<string> | null
  dayKeys: Set<string> | null
}

/**
 * 未読者欄のための読み込み（2026-11-19 代表者の指示）。表示中の日とは別に、昨日までの数える日（最大15日）の ✔ と勤務表を読む。
 * 読み直し: 今日が変わった時・〔最新に更新〕（reloadToken）・確認欄で ✔ を付けた／取り消した後（version）。表示系から書き込まない。
 */
export function useUnreadSource(today: string, reloadToken: number, version: number): UnreadSource {
  const [st, setSt] = useState<UnreadSource>({ ready: false, failed: false, missing: false, today: null, checks: new Map(), duty: null, roster: null, dayKeys: null })
  const genRef = useRef(0)
  useEffect(() => {
    const my = ++genRef.current
    let alive = true
    const window = unreadWindow(today)
    if (window.length === 0) {
      setSt({ ready: true, failed: false, missing: false, today, checks: new Map(), duty: null, roster: null, dayKeys: null })
      return
    }
    void (async () => {
      let checks = new Map<string, Set<number>>()
      let failed = false
      let missing = false
      let duty: FacilityDutyTable | null = null
      let roster: Set<string> | null = null
      let dayKeys: Set<string> | null = null
      try {
        const r = await fetchReadChecks(window)
        missing = r.missing
        checks = new Map(window.map((d) => [d, new Set<number>()]))
        for (const row of r.rows) checks.get(row.day)?.add(row.staff_id)
      } catch {
        failed = true
      }
      const days = unreadDutyDays(today)
      const src = await fetchShiftSource(days)
      if (src) {
        const t = buildFacilityDutyTable(src, days)
        duty = t.size > 0 ? t : null
        roster = new Set()
        dayKeys = new Set()
        for (const s of src.staff) {
          if (s.active === false || s.status === '退職') continue
          const k = nameKey(s.name)
          if (!k) continue
          roster.add(k)
          if (notFacilityStaff(s)) dayKeys.add(k)
        }
      } else failed = true
      if (!alive || my !== genRef.current) return
      setSt({ ready: true, failed, missing, today, checks, duty, roster, dayKeys })
    })()
    return () => {
      alive = false
    }
  }, [today, reloadToken, version])
  return st
}
