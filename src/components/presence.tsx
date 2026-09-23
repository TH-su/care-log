// 他の端末が入力中の欄・行の表示部品（Presence・欄単位）。
// 設計: docs/design/concurrent-entry.md §8 ／ 文字は src/lib/presence.ts が作る
//
// - 色だけで伝えない: 欄は色（--c-info）＋破線の枠＋「✎」印。誰が・どこをは表の上の一行（要約）に文字で出す
// - 読み上げ: 欄の入力要素から aria-describedby で「職員Bが入力中です」を指す（BusyMark の sr-only）。
//   行見出しの「✎」は aria-label「入力中: 職員B」、要約の行は全文を読ませる
// - 行の高さ・列の幅・既存の配置を変えない: 欄の「✎」は欄の中の角に絶対配置（欄の外へ出さない）、
//   行見出しの「✎」は氏名の文字の後ろ、要約の行は表示が無い時も1行の高さを取っておく（出た時に表を押し下げない）
// - 重ねた表示は pointer-events を持たない（下の欄はそのまま押せる）。印刷には出さない
// - 表示は補助であり、保存を妨げない（欄を押せなくしない・ロックしない）

import type { BusyText } from '../lib/presence'

/**
 * 他の端末が入力中の欄の枠。outline なので罫線・寸法に影響しない（内側へ 2px）。
 * 色は --c-info（ライト #0A4B5B／ダーク #7CC9DC。面の色・縞・しきい値の淡色のどれに対しても 3:1 以上）
 */
export const BUSY_RING = 'outline-dashed outline-2 -outline-offset-2 outline-info'
/** 枠をまとまりの外側に引く版（中身のボタンの縁に重ねない。食事一括の主食・副食・状態のまとまり） */
export const BUSY_RING_OUTSIDE = 'rounded outline-dashed outline-2 outline-offset-2 outline-info'

/**
 * 欄の中の上の角に置く「✎」印と、読み上げ用の文（id の要素・sr-only）。
 * 親（欄）は position を持つこと。印は欄の中に収まり、欄の外へはみ出さない。
 * corner は中身の文字と反対の角（左寄せの欄は右上、右寄せ・中央の欄は左上）＝値や見出しの先頭を覆わない。
 * id は入力要素の aria-describedby に渡す
 */
export function BusyMark({ busy, id, corner = 'left' }: { busy: BusyText; id: string; corner?: 'left' | 'right' }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute ${corner === 'left' ? 'left-0' : 'right-0'} top-0 z-10 overflow-hidden px-px text-2xs font-bold leading-none text-info print:hidden`}
      >
        ✎
      </span>
      <span id={id} className="sr-only">
        {busy.speech}
      </span>
    </>
  )
}

/**
 * 行見出し（氏名）の後ろに置く「✎」印。読み上げは「入力中: 職員B」。
 * 1文字だけなので氏名の並びを崩さない（名前は表の上の要約が文字で出す）
 */
export function RowBusyMark({ text }: { text: string }) {
  return (
    <span role="img" aria-label={text} className="ml-1 font-bold text-info print:hidden">
      ✎
    </span>
  )
}

/**
 * 表の上の一行の要約（例「✎ 入力中: 職員B（利用者01 体温）」）。
 * - 表示が無い時も1行の高さを取っておく（出た時に下の表を押し下げない＝押し間違いを誘わない）
 * - 1行に収め、はみ出す分は省略記号。読み上げは全文（切れて見えるのは見た目だけ）
 */
export function PresenceSummary({ text }: { text: string | null }) {
  return (
    <p
      // 高さは文字の大きさに合わせた1行ぶん（px を書かない）
      style={{ height: 'calc(var(--lh-base) * 1em)' }}
      className="truncate text-sm font-bold text-info print:hidden"
    >
      {text !== null ? (
        <>
          <span aria-hidden="true">✎ </span>
          {text}
        </>
      ) : null}
    </p>
  )
}
