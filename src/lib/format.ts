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

// ── 端末の時刻帯の確かめ（F36・2026-10-10 追加。上の既存の関数は変えない＝追加のみ） ──────────────
// 業務日付・時刻はすべて端末の時刻で決めている（isoDate・todayIso など＝端末＝JST 運用が前提）。端末の時刻帯が日本時間で
// ないと、バイタル・食事・申し送りが黙って前日の日付で保存され、与薬・入浴は日本時間の今日を選べなかった。
// 日付の計算を作り替えるのは影響が広いので、まず検出して画面に帯で知らせる（入力は止めない）。

/** 日本時間（UTC+9）の getTimezoneOffset（分）。日本に夏時間は無いので年中この値 */
const JST_OFFSET_MIN = -540

/**
 * 端末の時刻帯が日本時間か。時差（getTimezoneOffset）で判定する（時刻帯の名前は 'Japan' などの別名を返す環境があり、
 * 名前の照合では誤って警告するため使わない）。offsetMin を渡すとそれで判定する（試験・画面の復帰時の確かめ直し用）
 */
export function isJstDevice(offsetMin: number = new Date().getTimezoneOffset()): boolean {
  return offsetMin === JST_OFFSET_MIN
}

/** 端末の時刻帯の表示名（帯の文言に添える）。名前が取れなければ 'UTC+n' の形 */
export function deviceTimeZoneLabel(offsetMin: number = new Date().getTimezoneOffset()): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof tz === 'string' && tz !== '') return tz
  } catch {
    // 古い WebView など。時差から作る
  }
  const total = -offsetMin
  const sign = total < 0 ? '-' : '+'
  const h = Math.floor(Math.abs(total) / 60)
  const m = Math.abs(total) % 60
  return `UTC${sign}${h}${m === 0 ? '' : `:${String(m).padStart(2, '0')}`}`
}

/**
 * 端末の時刻帯が日本時間でない時の案内（日本時間なら null）。画面は入力を止めずに常時の帯で出す（印刷には出さない）。
 * 起動時と画面に戻った時に呼び直す（時刻帯を直したら帯を消す）
 */
export function deviceTimeZoneWarning(offsetMin: number = new Date().getTimezoneOffset(), label?: string): string | null {
  if (isJstDevice(offsetMin)) return null
  const name = label ?? deviceTimeZoneLabel(offsetMin)
  return `この端末の時刻帯が日本時間ではありません（現在: ${name}）。設定を直すまで、記録の日付と時刻がずれます。`
}
