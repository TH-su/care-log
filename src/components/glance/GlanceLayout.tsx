// ひと目ボードの並べ方（区画の置き場所だけ。中身は持たない・props だけ）。
// ・幅 1024px 以上（lg）: 上に見出しの帯と変化の兆し、下を3列（左＝バイタルの札・中＝温度板と食事水分排便・右＝医療の欄と最新の体調変化）。
//   各列は列の中だけで縦に動かす（画面全体は 1366×768 で縦に動かさない＝ひと目で見渡す）。
//   列の中の区画（バイタル・温度板・食事水分排便・医療の欄・最新の体調変化）は lg で中身の量に応じて列の高さを分け合い、
//   区画の中だけで縦に動く（どの区画も見出しが画面の中に出る。区画の側の lg:flex-auto・lg:min-h-0・lg:overflow-y-auto）
// ・それより狭い幅（390px のスマホなど）: 上から順に縦に積む（列の中の縦の動きはしない）
// 寸法はトークンと Tailwind の既定の段だけ（角括弧の直書きはしない）。
// 根と各列に relative を付ける（読み上げ用の sr-only＝absolute が列の外へはみ出して画面全体を縦に伸ばさないように）。
// 根の高さ（lg）: 本番では App の殻（sticky の header と main の上下の余白・案内の帯）の中に置かれるため、
//   h-screen のままだと殻の分だけ画面全体が縦に動く。描いた後に「上に積まれた分」と「下に続く分」を測り、
//   残りの高さを根に与える（header は折り返しで高さが変わるので固定値で引かない）。h-screen は測る前の仮の値。

import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/** 列の中で縦に動かせる最低限の高さ（殻が極端に高い時でも区画が潰れないように） */
const MIN_LAYOUT_PX = 320

/** 幅 1024 以上（lg）の時、根の高さを「窓の高さ − 根より上 − 根より下」に合わせる */
function fitToViewport(el: HTMLElement) {
  if (window.innerWidth < 1024) {
    if (el.style.height !== '') el.style.height = ''
    return
  }
  const prev = el.style.height
  // いったん窓の高さにして、文書が窓より高い状態で根の下に続く分を測る（殻の min-h-screen に吸われないように）
  el.style.height = `${window.innerHeight}px`
  const se = document.scrollingElement ?? document.documentElement
  const top = el.getBoundingClientRect().top + window.scrollY
  const below = Math.max(0, se.scrollHeight - (top + el.offsetHeight))
  const next = `${Math.max(MIN_LAYOUT_PX, Math.floor(window.innerHeight - top - below))}px`
  el.style.height = next === prev ? prev : next
}

export interface GlanceLayoutProps {
  header: ReactNode
  signs: ReactNode
  left: ReactNode
  center: ReactNode
  right: ReactNode
  /** 帯の下に出す一言（読み込みの一部失敗など） */
  notes?: ReactNode
}

export function GlanceLayout({ header, signs, left, center, right, notes }: GlanceLayoutProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  // 描くたびに測り直す（兆し・帯の増減）。窓の大きさと殻の高さ（header の折り返し・案内の帯）の変化でも測り直す
  useLayoutEffect(() => {
    const el = rootRef.current
    if (el) fitToViewport(el)
  })
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    let frame = 0
    const refit = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => fitToViewport(el))
    }
    window.addEventListener('resize', refit)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refit)
    ro?.observe(document.body)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', refit)
      ro?.disconnect()
    }
  }, [])
  return (
    <div ref={rootRef} className="relative mx-auto flex w-full max-w-screen-2xl flex-col gap-2 p-2 lg:h-screen lg:overflow-hidden" data-glance-layout="">
      {header}
      {notes}
      {signs}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-12 lg:grid-rows-1">
        <div className="relative flex min-h-0 min-w-0 flex-col gap-2 lg:col-span-4 lg:overflow-y-auto">{left}</div>
        <div className="relative flex min-h-0 min-w-0 flex-col gap-2 lg:col-span-4 lg:overflow-y-auto">{center}</div>
        <div className="relative flex min-h-0 min-w-0 flex-col gap-2 lg:col-span-4 lg:overflow-y-auto">{right}</div>
      </div>
    </div>
  )
}

export default GlanceLayout
