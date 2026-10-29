// 見守りボード（/glance）の1マス。props だけで描く（DB を読まない・端末に何も書かない）。
//
// ・マスの中身は glance.ts の buildBoardRows が決めた {severity, symbol, text, unavailable} をそのまま描く
// ・色だけに頼らない: 要注意＝「!!」・注意＝「!」の記号と、読み上げ用の「要注意」「注意」の文字を必ず併記する
// ・排便・体重が端末に未接続・照合できない時は「—（カルテで確認）」（unavailable）を控えめな色で出す
// ・読み込み中の列（排便記録・体重の読み込みを待っている間）は「読み込み中」と出す（未接続と取り違えない）
// 個人情報は持たない（受け取った値を描くだけ）。

import type { BoardCell as BoardCellData } from '../../lib/glance'
import { SEVERITY_LABEL } from '../../lib/glance'

export interface BoardCellProps {
  cell: BoardCellData
  /** 列の名前（読み上げに使う。例: 体温） */
  label: string
  /** この列はまだ読み込み中（排便・体重） */
  pending?: boolean
}

const TONE = {
  danger: 'bg-danger-bg text-danger',
  warn: 'bg-warn-bg text-warn',
} as const

export function BoardCell({ cell, label, pending = false }: BoardCellProps) {
  if (pending) {
    return <span className="text-sm text-ink3">読み込み中</span>
  }
  if (cell.severity !== null) {
    return (
      <span className={`inline-flex items-baseline gap-1 rounded px-1 text-sm font-bold ${TONE[cell.severity]}`}>
        <span aria-hidden="true">{cell.symbol}</span>
        <span className="sr-only">
          {label} {SEVERITY_LABEL[cell.severity]}
        </span>
        <span className="tabular">{cell.text}</span>
      </span>
    )
  }
  if (cell.unavailable) {
    return <span className="text-sm text-ink3">{cell.text}</span>
  }
  if (cell.text === '') {
    return (
      <span className="text-sm text-ink3">
        <span aria-hidden="true">·</span>
        <span className="sr-only">{label} なし</span>
      </span>
    )
  }
  return <span className="tabular text-sm text-ink">{cell.text}</span>
}

export default BoardCell
