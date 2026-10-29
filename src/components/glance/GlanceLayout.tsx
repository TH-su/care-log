// ひと目ボードの並べ方（区画の置き場所だけ。中身は持たない・props だけ）。
// ・幅 1024px 以上（lg）: 上に見出しの帯と変化の兆し、下を3列（左＝バイタルの札・中＝温度板と食事水分排便・右＝医療の欄と最新の体調変化）。
//   各列は列の中だけで縦に動かす（画面全体は 1366×768 で縦に動かさない＝ひと目で見渡す）
// ・それより狭い幅（390px のスマホなど）: 上から順に縦に積む（列の中の縦の動きはしない）
// 寸法はトークンと Tailwind の既定の段だけ（角括弧の直書きはしない）。
// 根と各列に relative を付ける（読み上げ用の sr-only＝absolute が列の外へはみ出して画面全体を縦に伸ばさないように）。

import type { ReactNode } from 'react'

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
  return (
    <div className="relative mx-auto flex w-full max-w-screen-2xl flex-col gap-2 p-2 lg:h-screen lg:overflow-hidden" data-glance-layout="">
      {header}
      {notes}
      {signs}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-12 lg:grid-rows-1">
        <div className="relative flex min-h-0 flex-col gap-2 lg:col-span-4 lg:overflow-y-auto">{left}</div>
        <div className="relative flex min-h-0 flex-col gap-2 lg:col-span-4 lg:overflow-y-auto">{center}</div>
        <div className="relative flex min-h-0 flex-col gap-2 lg:col-span-4 lg:overflow-y-auto">{right}</div>
      </div>
    </div>
  )
}

export default GlanceLayout
