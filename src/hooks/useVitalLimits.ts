// 個人のバイタルの閾値（段階2d-2・0045）を記録の画面が引くための小さな部品。
//
//   const limits = useVitalLimits(tick)
//   limits.lookup(residentId, day)  … その方・その日の基準（個人の値が無い方・読めない時は施設の基準＝vitalThresholds() そのもの）
//   limits.failed                   … 読めなかった（施設の基準で判定している）。画面に1行の知らせ（〔読み直す〕つき）を出す
//   limits.refresh()                … 取り直す（〔読み直す〕・日報の読み込み）。戻り値は判定に使う行
//
// 行は読み込みの控え（cachedReads）を通す。reloadKey が変わるたびに取り直す（〔最新を読み込む〕・カードで足した後）。
// 画面が前に戻った時と、前に出ている間は10分ごとにも取り直す（開いたままの画面に事務所で足した基準を届ける・2026-10-23）。
// 取り直しに失敗しても、前に読めた行があればそれで判定を続ける（施設の基準へ戻すより正しい）。
// 施設の基準（vitalThresholds()）は app_settings を読んだ後に差し替わるので、lookup は引くたびにいまの基準を見て、
// 変わっていれば組み直す（反証 軽8: 描いた時の古い基準で判定し続けない＝2d-2 の前と同じく、いまの基準で判定する）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchResidentVitalLimits, peekResidentVitalLimits } from '../lib/cachedReads'
import { thresholdsLookup } from '../lib/vitalLimits'
import type { ResidentVitalLimit } from '../lib/vitalLimits'
import { vitalThresholds } from '../lib/vitalThresholds'
import type { VitalThresholds } from '../lib/vitalThresholds'

/** 開いたままの画面で個人の基準を取り直す間隔（前に出ている間だけ） */
export const VITAL_LIMITS_REFRESH_MS = 10 * 60 * 1000

/** 個人の基準を読めなかった時の知らせ（各画面で同じ文） */
export const VITAL_LIMITS_FAILED_TEXT = '個人の基準を読めませんでした（施設の基準で判定しています）。'

export interface VitalLimitsState {
  /** 行（null＝まだ読めていない・読めなかった） */
  rows: readonly ResidentVitalLimit[] | null
  /** 読めなかった（前に読めた行も無い）。施設の基準で判定している */
  failed: boolean
  /** その方・その日の基準 */
  lookup: (residentId: number, day: string) => VitalThresholds
  /** 取り直す。読めない時は前に読めた行（無ければ null）を返す。例外は投げない */
  refresh: () => Promise<readonly ResidentVitalLimit[] | null>
}

export function useVitalLimits(reloadKey: unknown = 0): VitalLimitsState {
  const [rows, setRows] = useState<readonly ResidentVitalLimit[] | null>(() => peekResidentVitalLimits()?.rows ?? null)
  const [failed, setFailed] = useState(false)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const aliveRef = useRef(true)
  const seqRef = useRef(0)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  const refresh = useCallback(async (): Promise<readonly ResidentVitalLimit[] | null> => {
    const my = ++seqRef.current
    try {
      const r = await fetchResidentVitalLimits()
      // 後から頼んだ取り直しが先に返っていれば、古い応答で上書きしない
      if (aliveRef.current && my === seqRef.current) {
        rowsRef.current = r.rows
        setRows(r.rows)
        setFailed(false)
      }
      return r.rows
    } catch {
      // 前に読めた行があればそれで続ける（知らせは出さない）
      const cur = rowsRef.current
      if (aliveRef.current && my === seqRef.current) setFailed(cur === null)
      return cur
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [reloadKey, refresh])
  // 開いたままの画面にも、事務所で足した個人の基準を届ける（2026-10-23・修正点 L2）。
  // 以前は画面を開いた時と〔最新を読み込む〕を押した時だけ取り直し、朝から開いたままのデイのバイタル一括などでは
  // 昼に足した基準が判定・〔＋再測定〕の出し分けに効かなかった。画面が前に戻った時と、前に出ている間は10分ごとに取り直す。
  // 取り直しに失敗しても前に読めた行で判定を続ける（refresh の作りのまま）。画面が隠れている間は取りに行かない。
  useEffect(() => {
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'
    const onVis = () => {
      if (visible()) void refresh()
    }
    const iv = setInterval(() => {
      if (visible()) void refresh()
    }, VITAL_LIMITS_REFRESH_MS)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(iv)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
    }
  }, [refresh])
  const lookup = useMemo(() => {
    let builtFor: VitalThresholds | null = null
    let inner: (residentId: number, day: string) => VitalThresholds = () => vitalThresholds()
    return (residentId: number, day: string): VitalThresholds => {
      const base = vitalThresholds()
      if (base !== builtFor) {
        inner = thresholdsLookup(rows, base)
        builtFor = base
      }
      return inner(residentId, day)
    }
  }, [rows])
  return { rows, failed, lookup, refresh }
}
