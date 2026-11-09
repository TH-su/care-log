// デイの一括の4画面（バイタル・食事・活動・機能訓練）の上に出す「未入力」の数と、空の枠・空の欄がある行の印（2026-11-09 計画B・計画B2）。
// 計画B2（代表者の指示「全枠が埋まるまでは何かしらのアラートが出るように」）: 数える相手は画面に出ている予定の方で、到着の有無を問わない
// （daycareProgress.ts の bulkBlankSummary）。空の欄が1つでもあれば「▲ 未入力 n名（m欄）」（赤字）、全部埋まった時だけ「✓ 全員入力済み」。
// 「未到着 n名（数えていません）」は出さない（到着を問わず数えるため）。色だけに頼らず記号と文字を併記する。

/** 一括の画面の上の数（n＝空の欄がある方の数・m＝空の欄の合計） */
export function DaycareUnfilledCount({ counts }: { counts: { people: number; fields: number } }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-base">
      {counts.fields > 0 ? (
        <span className="font-bold text-danger">
          <span aria-hidden="true">▲ </span>未入力 <span className="font-num">{counts.people}</span>名（<span className="font-num">{counts.fields}</span>欄）
        </span>
      ) : (
        <span className="font-bold text-ok">
          <span aria-hidden="true">✓ </span>全員入力済み
        </span>
      )}
    </p>
  )
}

/**
 * 空の欄がある行の、氏名の横の小さな印（「▲未」・読み上げは「未入力あり」）。
 * sr=false: 読み上げの文を出さない（aria-label の付いたリンクの中に置く時は、中の文が読まれないので、リンクの外に DaycareRowBlankSr を置く）
 */
export function DaycareRowBlankMark({ sr = true }: { sr?: boolean }) {
  return (
    <span className="ml-1 whitespace-nowrap text-sm font-bold text-danger">
      <span aria-hidden="true">▲未</span>
      {sr ? <span className="sr-only">（未入力あり）</span> : null}
    </span>
  )
}

/** 行の印の読み上げだけ（aria-label の付いたリンクの外に置く。見た目は無い） */
export function DaycareRowBlankSr() {
  return <span className="sr-only">未入力あり</span>
}

/** 空の枠に添える「未」の字（色だけに頼らない。読み上げは枠の aria-label・見出しの文で伝えるので、ここは読まない） */
export function DaycareBlankTag() {
  return (
    <span aria-hidden="true" className="text-sm font-bold leading-tight text-warn">
      未
    </span>
  )
}
