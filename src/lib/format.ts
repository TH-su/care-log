// 日付・入力正規化ヘルパの正本（凍結契約）。ビルダーは変更しない。

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土']

/** ローカル時刻（端末＝JST運用）の YYYY-MM-DD。toISOString は UTC ずれするので使わない */
export function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayIso(): string {
  return isoDate(new Date())
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d + n)
  return isoDate(dt)
}

/** '2026-08-27' → '8/27（木）' */
export function fmtDayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return `${m}/${d}（${WEEKDAY[dt.getDay()]}）`
}

/** '09:30:00' | '09:30' → '9:30'。null は '' */
export function fmtTimeHM(t: string | null | undefined): string {
  if (!t) return ''
  const [h, m] = t.split(':')
  return `${Number(h)}:${m}`
}

/** 全角数字・記号ゆれを半角に正規化 */
export function toHalfWidth(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[、，。]/g, '.')
    .replace(/．/g, '.')
    .replace(/[−ー－]/g, '-')
    .trim()
}

/**
 * バイタル入力の正規化。数値化できなければ null。
 * temp はドット無し3桁（365）を 36.5 に展開する。末尾ドット（36.7.）は除去。
 * 範囲判定は呼び出し側で VITAL_RANGE を使う（ここでは値をそのまま返す）。
 */
export function normalizeVitalInput(
  raw: string,
  field: 'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2',
): number | null {
  let s = toHalfWidth(raw).replace(/\.+$/, '')
  if (s === '') return null
  if (field === 'temp' && /^\d{3}$/.test(s)) {
    s = `${s.slice(0, 2)}.${s.slice(2)}`
  }
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return field === 'temp' ? Math.round(n * 10) / 10 : Math.round(n)
}
