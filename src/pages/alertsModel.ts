// 今日の要注意（/alerts・A5）とカルテの欄への行き先の純関数（副作用なし・DB/DOM に触れない）。
// AlertsPage.tsx と KartePage.tsx が使う。tests/vital-display-screens.test.mjs から node で直接読む（型の import だけ）。
//
// ・今日と時刻は日本時間で決める（端末の時刻帯に左右されない＝jstClock）
// ・階の UI 状態は localStorage の ALERTS_FLOOR_KEY に既知の形（0〜9・other・all）だけを置き、読む時も同じ形だけ受ける
//   （原則11。LS の一覧は types.ts＝凍結契約のため、キーはここに置く。値は画面の選択だけ＝氏名・記録は置かない）
// ・理由を押した先はカルテのその欄（/karte/:id?sec=<欄の id>）。カルテは許可リストの id だけを受ける（karteSecOf）
// 個人情報は扱わない（数値ID・日付・時刻だけ）。

import type { AlertReason, AlertSection, ResidentAlerts } from '../lib/vitalAlerts'

/** 階の UI 状態の保存先（今日の要注意の画面だけが使う） */
export const ALERTS_FLOOR_KEY = 'cl_alertsFloor'

/** 階の選択の値（全員・居室の未設定） */
export const FLOOR_ALL = 'all'
export const FLOOR_OTHER = 'other'

/** 居室文字列から階（'102'→'1'）。数字が無い・未設定は FLOOR_OTHER（与薬チェック・バイタル一覧と同じ判定） */
export function floorOf(room: string | null | undefined): string {
  if (!room) return FLOOR_OTHER
  const m = /\d/.exec(room)
  return m ? m[0] : FLOOR_OTHER
}

/** 保存した階を読む（既知の形だけ。壊れた値・未知値は null＝既定の「全」） */
export function readAlertsFloor(raw: string | null | undefined): string | null {
  return typeof raw === 'string' && /^([0-9]|other|all)$/.test(raw) ? raw : null
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 日本時間の差（UTC+9・夏時間なし） */
const JST_OFFSET_MS = 9 * 3600 * 1000

/**
 * 日本時間の今日（'YYYY-MM-DD'）と 0 時からの分。ms は Date.now() の値。読めない値は null
 */
export function jstClock(ms: number): { day: string; nowMin: number } | null {
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms + JST_OFFSET_MS)
  if (Number.isNaN(d.getTime())) return null
  return {
    day: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    nowMin: d.getUTCHours() * 60 + d.getUTCMinutes(),
  }
}

/** 'YYYY-MM-DD' に n 日足す（端末の時刻帯に左右されないよう UTC で数える） */
export function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return day
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** 理由の欄 → カルテの欄の id（KartePage の KARTE_JUMPS と同じ id。与薬は karte-med） */
export const KARTE_SECTION_ID: Readonly<Record<AlertSection, string>> = {
  vitals: 'karte-vitals',
  meals: 'karte-meals',
  notes: 'karte-notes',
  meds: 'karte-med',
  excretion: 'karte-excretion',
}

/** 理由を押した時の行き先（カルテのその欄） */
export function alertHref(residentId: number, section: AlertSection): string {
  return `/karte/${residentId}?sec=${KARTE_SECTION_ID[section]}`
}

/** カルテの ?sec= の値を許可リスト（欄の id）と照合する。無い・知らない値は null（移らない） */
export function karteSecOf(raw: string | null | undefined, allowed: readonly string[]): string | null {
  return typeof raw === 'string' && allowed.includes(raw) ? raw : null
}

/** 申し送り（その日の分）と継続（pinned）を id で重ねずにまとめる（先に来た方を残す） */
export function mergeNotes<T extends { id: number }>(notes: readonly T[] | null | undefined, pinned: readonly T[] | null | undefined): T[] {
  const out: T[] = []
  const seen = new Set<number>()
  for (const n of [...(notes ?? []), ...(pinned ?? [])]) {
    if (!n || typeof n.id !== 'number' || seen.has(n.id)) continue
    seen.add(n.id)
    out.push(n)
  }
  return out
}

/**
 * buildDayAlerts の結果に、別に作った理由（排便なし◯日・2026-10-16）を方ごとに後ろへ足す。
 * 並びは residentIds の順（buildDayAlerts と同じ）。足す理由しか無い方も、その順の位置に入る。
 * residentIds に居ない方の理由は足さない。元の配列・理由は書き換えない（写しを返す）
 */
export function appendReasons(
  alerts: readonly ResidentAlerts[],
  residentIds: readonly number[],
  extra: ReadonlyMap<number, readonly AlertReason[]>,
): ResidentAlerts[] {
  const byId = new Map<number, AlertReason[]>()
  for (const a of alerts) byId.set(a.residentId, a.reasons.slice())
  for (const [rid, rs] of extra) {
    if (rs.length === 0) continue
    const cur = byId.get(rid) ?? []
    byId.set(rid, [...cur, ...rs])
  }
  const out: ResidentAlerts[] = []
  const seen = new Set<number>()
  for (const rid of residentIds) {
    if (seen.has(rid)) continue
    seen.add(rid)
    const rs = byId.get(rid)
    if (rs && rs.length > 0) out.push({ residentId: rid, reasons: rs })
  }
  return out
}
