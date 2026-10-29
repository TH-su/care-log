// 見守りボード（/glance）の並びの切り替え（居室の順／変化の多い順）。props だけで描く。
// 保存（cl_glanceSort）は画面（GlanceBoardPage）が行う。ここは選ばれた値を返すだけ。
// 選択中は共通部品 SegmentPicker の「色＋太字＋✓」で示す（色だけに頼らない・44px）。

import { SegmentPicker } from '../ui'
import type { GlanceSort } from '../../lib/glance'
import { parseGlanceSort } from '../../lib/glance'

export interface BoardSortToggleProps {
  value: GlanceSort
  onChange: (v: GlanceSort) => void
}

const OPTIONS: { value: GlanceSort; label: string }[] = [
  { value: 'room', label: '居室の順' },
  { value: 'changes', label: '変化の多い順' },
]

export function BoardSortToggle({ value, onChange }: BoardSortToggleProps) {
  return (
    <SegmentPicker
      options={OPTIONS}
      value={value}
      // 既知値だけを返す（知らない値が来ても既定へ寄せる）
      onChange={(v) => onChange(parseGlanceSort(v))}
      ariaLabel="並び"
    />
  )
}

export default BoardSortToggle
