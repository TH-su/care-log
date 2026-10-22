// 個人のバイタルの閾値（段階2d-2・0045）を記録の画面が引くための小さな部品。
//
//   const limits = useVitalLimits(tick)
//   limits.lookup(residentId, day)  … その方・その日の基準（個人の値が無い方・読めない時は施設の基準＝vitalThresholds() そのもの）
//   limits.failed                   … 読めなかった（施設の基準で判定している）。画面に1行の知らせを出す
//
// 行は読み込みの控え（cachedReads）を通す。reloadKey が変わるたびに取り直す（〔最新を読み込む〕・カードで足した後）。
// 取り直しに失敗しても、前に読めた行があればそれで判定を続ける（施設の基準へ戻すより正しい）。
// 施設の基準（vitalThresholds()）は app_settings を読んだ後に差し替わるので、描くたびにいまの基準で引き直す。
import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchResidentVitalLimits, peekResidentVitalLimits } from '../lib/cachedReads'
import { thresholdsLookup } from '../lib/vitalLimits'
import type { ResidentVitalLimit } from '../lib/vitalLimits'
import { vitalThresholds } from '../lib/vitalThresholds'
import type { VitalThresholds } from '../lib/vitalThresholds'

/** 個人の基準を読めなかった時の知らせ（各画面で同じ文） */
export const VITAL_LIMITS_FAILED_TEXT = '個人の基準を読めませんでした（施設の基準で判定しています）。'

export interface VitalLimitsState {
  /** 行（null＝まだ読めていない・読めなかった） */
  rows: readonly ResidentVitalLimit[] | null
  /** 読めなかった（前に読めた行も無い）。施設の基準で判定している */
  failed: boolean
  /** その方・その日の基準 */
  lookup: (residentId: number, day: string) => VitalThresholds
}

export function useVitalLimits(reloadKey: unknown = 0): VitalLimitsState {
  const [rows, setRows] = useState<readonly ResidentVitalLimit[] | null>(() => peekResidentVitalLimits()?.rows ?? null)
  const [failed, setFailed] = useState(false)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  useEffect(() => {
    let cancelled = false
    fetchResidentVitalLimits()
      .then((r) => {
        if (cancelled) return
        setRows(r.rows)
        setFailed(false)
      })
      .catch(() => {
        if (cancelled) return
        // 前に読めた行があればそれで続ける（知らせは出さない）
        setFailed(rowsRef.current === null)
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])
  const base = vitalThresholds()
  const lookup = useMemo(() => thresholdsLookup(rows, base), [rows, base])
  return { rows, failed, lookup }
}
