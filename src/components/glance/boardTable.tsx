// 見守りボード（/glance）の表。全員を1行ずつ、列ごとのマスに記号＋短い値を出す。props だけで描く（DB を読まない）。
//
// ・列は glance.ts の BOARD_COLUMNS の順（体温・血圧・脈・SpO2・食事・水分・排便・体重・与薬・事故・申し送り・記録の欠け）
// ・体温の列には直近7日の小さい線（自前の SVG）を添える。縦軸は全員同じ（tempDomain＝glance.ts の boardTempDomain）。
//   記録の無い日は線を切る（補わない＝「記録なし」の誤読を防ぐ。カルテのグラフと同じ）
// ・入院中・外泊中の方は氏名の横に札を出す（印は glance.ts の側で数えていない）
// ・行を押すとその方のひと目ボード（/glance/:id）へ。氏名はリンク（キーボード・読み上げで届く・44px）
// ・年齢・医療の欄は出さない
// 色はトークンのクラスだけ。個人情報は持たない（受け取った値を描くだけ）。
// 幅 1366 で12列が横に動かさずに収まるよう、居室と氏名は1行に並べ（入院中などの札だけ次の行）、マスの左右の余白を詰め、
// 「—（カルテで確認）」のマスだけ折り返す

import type { MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import type { BoardColumn, BoardRow } from '../../lib/glance'
import { AWAY_LABEL, BOARD_COLUMNS, BOARD_COLUMN_LABEL, SEVERITY_LABEL, SEVERITY_SYMBOL } from '../../lib/glance'
import { Chip } from '../ui'
import { BoardCell } from './boardCell'

export interface BoardTableProps {
  rows: readonly BoardRow[]
  /** 体温の小さい線の縦軸（全員同じ） */
  tempDomain: [number, number]
  /** 読み込み中の列（排便・体重の読み込みを待っている間） */
  pendingColumns?: readonly BoardColumn[]
  /** 行を押した時（その方のひと目ボードへ） */
  onOpen: (residentId: number) => void
}

/** 小さい線の大きさ（viewBox の単位。表示の大きさはクラスで決める） */
const SPARK_W = 64
const SPARK_H = 20
const SPARK_PAD = 2

/** 体温の直近7日の小さい線（古い順・無い日は null） */
function TempSpark({ values, domain }: { values: readonly (number | null)[]; domain: [number, number] }) {
  const n = values.length
  const [lo, hi] = domain
  const span = hi - lo
  const pts = values.map((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || !(span > 0)) return null
    const x = n <= 1 ? SPARK_W / 2 : SPARK_PAD + (i * (SPARK_W - SPARK_PAD * 2)) / (n - 1)
    const clamped = Math.min(hi, Math.max(lo, v))
    const y = SPARK_PAD + ((hi - clamped) * (SPARK_H - SPARK_PAD * 2)) / span
    return { x, y }
  })
  // 記録のある日が続く所だけ線でつなぐ（欠けた日で切る）。孤立した1日は点で出す
  let d = ''
  const dots: { x: number; y: number }[] = []
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    if (!p) continue
    const prev = i > 0 ? pts[i - 1] : null
    const next = i < pts.length - 1 ? pts[i + 1] : null
    if (!prev && !next) dots.push(p)
    d += `${prev ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)} `
  }
  const recorded = values.filter((v) => typeof v === 'number' && Number.isFinite(v)) as number[]
  const speech =
    recorded.length === 0
      ? '体温の直近7日 記録なし'
      : `体温の直近7日 ${values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '記録なし')).join('、')}`
  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      className="block h-5 w-16 shrink-0"
      role="img"
      aria-label={speech}
      preserveAspectRatio="none"
    >
      <line x1={0} x2={SPARK_W} y1={SPARK_H - 0.5} y2={SPARK_H - 0.5} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {d !== '' ? (
        <path d={d.trim()} className="fill-none stroke-ink2" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      ) : null}
      {dots.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={1.5} className="fill-ink2" />
      ))}
    </svg>
  )
}

export function BoardTable({ rows, tempDomain, pendingColumns = [], onOpen }: BoardTableProps) {
  const pending = new Set<BoardColumn>(pendingColumns)
  // 行のどこを押しても開く。氏名のリンクを押した時はリンクに任せる（二重に移らない）
  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, id: number) => {
    const t = e.target
    if (t instanceof Element && t.closest('a') !== null) return
    onOpen(id)
  }
  return (
    // relative: マスの中の読み上げ用 sr-only（absolute）の基準をこの横に動く枠にし、枠の外（画面全体）を横に広げないように
    <div className="relative overflow-x-auto rounded-lg border border-border-strong bg-surface">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">見守りボード（全員の直近の様子。行を押すとその方のひと目ボードへ移ります）</caption>
        <thead>
          <tr className="border-b border-border-strong bg-surface2 text-left text-ink2">
            <th scope="col" className="sticky left-0 z-10 bg-surface2 px-1.5 py-2 font-bold">
              居室・氏名
            </th>
            <th scope="col" className="px-1 py-2 font-bold">
              印
            </th>
            {BOARD_COLUMNS.map((c) => (
              <th key={c} scope="col" className="whitespace-nowrap px-1 py-2 font-bold">
                {BOARD_COLUMN_LABEL[c]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.residentId}
              onClick={(e) => onRowClick(e, r.residentId)}
              className="cursor-pointer border-b border-border align-middle hover:bg-surface2"
            >
              <th scope="row" className="sticky left-0 z-10 bg-surface px-1.5 py-0.5 text-left font-normal">
                <span className="flex flex-wrap items-center gap-x-1.5">
                  <span className="tabular text-sm text-ink3">{r.room ?? '—'}</span>
                  <Link
                    to={`/glance/${r.residentId}`}
                    className="inline-flex min-h-tap items-center whitespace-nowrap text-base font-bold text-link"
                  >
                    {r.name}
                    <span aria-hidden="true"> ›</span>
                  </Link>
                  {r.away !== null ? (
                    <Chip tone="info" className="basis-full whitespace-nowrap">
                      <span aria-hidden="true">ⓘ</span>
                      {AWAY_LABEL[r.away]}
                    </Chip>
                  ) : null}
                </span>
              </th>
              <td className="whitespace-nowrap px-1 py-0.5">
                {r.away !== null ? (
                  <span className="text-sm text-ink3">数えない</span>
                ) : r.signCount > 0 && r.topSeverity !== null ? (
                  <span className={`text-sm font-bold ${r.topSeverity === 'danger' ? 'text-danger' : 'text-warn'}`}>
                    <span aria-hidden="true">{SEVERITY_SYMBOL[r.topSeverity]} </span>
                    <span className="tabular">{r.signCount}</span>
                    <span className="sr-only">件（最も重い印は{SEVERITY_LABEL[r.topSeverity]}）</span>
                  </span>
                ) : (
                  <span className="text-sm text-ink3">
                    <span aria-hidden="true">·</span>
                    <span className="sr-only">印なし</span>
                  </span>
                )}
              </td>
              {BOARD_COLUMNS.map((c) => (
                <td key={c} className={`px-1 py-0.5 ${r.cells[c].unavailable ? '' : 'whitespace-nowrap'}`}>
                  {c === 'temp' ? (
                    <span className="flex items-center gap-1">
                      <TempSpark values={r.tempSpark} domain={tempDomain} />
                      <BoardCell cell={r.cells.temp} label={BOARD_COLUMN_LABEL.temp} />
                    </span>
                  ) : (
                    <BoardCell cell={r.cells[c]} label={BOARD_COLUMN_LABEL[c]} pending={pending.has(c)} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default BoardTable
