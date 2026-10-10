// 名簿（入居者マスタ・職員名簿）の自動同期と、最終同期の表示（F50・2026-10-10 本人回答）。
// 設計では「起動時＋60分ごと」の同期だったが、実装は設定画面の手動ボタンだけで、誰かが押すまで入退所・部屋移動が
// どの端末にも届かず、同期が失敗し続けていても気づく機会が無かった。
//
// ・MasterAutoSync … App に1つ置く。接続設定（GAS の URL と合言葉）のある端末だけが、起動の少し後・画面に戻った時・
//   5分ごとに autoSyncMasters を呼ぶ（前回の同期から60分たっていなければ何もしない＝実際の同期は60分ごと）。
//   接続設定の無い端末（現場の iPhone）は何もしない。失敗した時だけ帯で知らせる（続けて失敗した回数も出す）。
//   名簿から一度に外れる人数が多くて止まった時（F43）も帯で知らせ、自動では続けない（設定画面で人が確かめる）
// ・MasterSyncStatus … 設定画面に置く。「最終同期: 利用者 3日前（10/7 9:12）・職員 今日 9:12」を出す
//   （master_sync_log の最新。他の端末の同期も含む）。名簿が変わった合図（subscribeMastersChanged）で読み直す
// ・gasClient は動的 import で読む（設定画面と同じ。名簿の同期を使わない端末で読み込まない）
// 規律: トークン由来クラスのみ・色だけで意味を伝えない（記号と文字）・印刷に出さない・応答本文を console に出さない

import { useEffect, useState } from 'react'
import { fetchLastMasterSync, subscribeMastersChanged } from '../lib/db'

/** 自動同期を確かめる間隔。実際に同期するかは autoSyncMasters が前回からの間隔（60分）で決める */
const AUTO_SYNC_CHECK_MS = 5 * 60_000
/** 起動直後の読み込み（名簿・記録）と重ねないための待ち */
const AUTO_SYNC_FIRST_DELAY_MS = 3_000

/** 名簿の自動同期（App に1つ置く）。失敗した時だけ帯を出す。それ以外は何も描かない */
export function MasterAutoSync() {
  const [error, setError] = useState<string | null>(null)
  const [fails, setFails] = useState(0)

  useEffect(() => {
    let alive = true
    let busy = false
    const run = async () => {
      if (busy || !alive) return
      busy = true
      try {
        const { autoSyncMasters } = await import('../lib/gasClient')
        const res = await autoSyncMasters()
        if (!alive) return
        if (typeof res === 'object') {
          // 同期できた＝前の失敗の帯は外す
          setError(null)
          setFails(0)
        }
      } catch (e) {
        if (!alive) return
        // gasClient は画面にそのまま出せる日本語の文で throw する契約。応答本文は console に出さない
        setError(
          e instanceof Error && e.message !== ''
            ? e.message
            : '名簿を同期できませんでした。設定画面で「マスタを同期する」を押してください。',
        )
        setFails((n) => n + 1)
      } finally {
        busy = false
      }
    }
    const first = setTimeout(() => void run(), AUTO_SYNC_FIRST_DELAY_MS)
    const timer = setInterval(() => void run(), AUTO_SYNC_CHECK_MS)
    const onVis = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void run()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      clearTimeout(first)
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  if (error === null) return null
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-gap rounded-md border border-warn bg-warn-bg p-3 print:hidden"
    >
      <p className="min-w-0 flex-1 text-base text-ink">
        <span aria-hidden="true">▲ </span>
        <span className="font-bold">
          {fails > 1 ? `名簿の自動同期が${fails}回続けてできませんでした。` : '名簿の自動同期ができませんでした。'}
        </span>
        {error}
      </p>
      <button
        type="button"
        onClick={() => setError(null)}
        className="min-h-tap shrink-0 rounded border border-border-strong bg-surface px-4 text-base text-ink"
      >
        閉じる
      </button>
    </div>
  )
}

/** 時刻を「今日 9:12」「昨日 9:12」「3日前（10/7 9:12）」にする（端末の暦日で数える） */
function syncAgo(iso: string | null, now: Date): string {
  if (iso === null) return '記録なし'
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return '記録なし'
  const hm = `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(t)) / 86_400_000)
  if (days <= 0) return `今日 ${hm}`
  if (days === 1) return `昨日 ${hm}`
  return `${days}日前（${t.getMonth() + 1}/${t.getDate()} ${hm}）`
}

/** 設定画面に置く「最終同期: 利用者 ◯日前・職員 ◯日前」。読めなければ何も出さない（同期の操作は妨げない） */
export function MasterSyncStatus() {
  const [last, setLast] = useState<{ residents: string | null; staff: string | null } | null>(null)
  const [reload, setReload] = useState(0)

  // 名簿が変わった（この端末で同期した・自動同期が走った）ら読み直す
  useEffect(() => subscribeMastersChanged(() => setReload((n) => n + 1)), [])

  useEffect(() => {
    let alive = true
    fetchLastMasterSync()
      .then((v) => {
        if (alive) setLast(v)
      })
      .catch(() => {
        if (alive) setLast(null)
      })
    return () => {
      alive = false
    }
  }, [reload])

  if (last === null) return null
  const now = new Date()
  return (
    <p className="text-sm text-ink2 print:hidden">
      {`最終同期: 利用者 ${syncAgo(last.residents, now)}・職員 ${syncAgo(last.staff, now)}`}
    </p>
  )
}
