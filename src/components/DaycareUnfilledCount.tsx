// デイの一括の4画面（バイタル・食事・活動・機能訓練）の上に出す「未入力 n名」（2026-11-09 計画B。食事一括の今までの表示と同じ見た目）。
// 数えるのは在席・帰宅の方だけ（attendedUnfilledCount）。まだ来ていない方は灰色で別に出す。色だけに頼らず記号と文字を併記する
export function DaycareUnfilledCount({ counts }: { counts: { unfilled: number; notArrived: number } }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-base">
      {counts.unfilled > 0 ? (
        <span className="font-bold text-danger">
          <span aria-hidden="true">▲ </span>未入力 <span className="font-num">{counts.unfilled}</span>名
        </span>
      ) : (
        <span className="font-bold text-ok">
          <span aria-hidden="true">✓ </span>未入力なし
        </span>
      )}
      {counts.notArrived > 0 ? (
        <span className="text-ink2">
          未到着 <span className="font-num">{counts.notArrived}</span>名（数えていません）
        </span>
      ) : null}
    </p>
  )
}
