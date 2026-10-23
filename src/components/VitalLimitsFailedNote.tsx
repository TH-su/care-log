// 個人の閾値（段階2d-2）を読めなかった時の1行の知らせ。記録の画面で同じ形に出す（印刷には出さない＝紙の版面を変えない）。
// 〔個人の基準を読み直す〕で取り直す（反証 軽5: 画面を開き直さなくても立ち直れる・次にどうすればよいかを示す）
import { VITAL_LIMITS_FAILED_TEXT } from '../hooks/useVitalLimits'

export function VitalLimitsFailedNote({ onRetry, className = 'mt-3' }: { onRetry: () => void; className?: string }) {
  return (
    <div role="status" className={`${className} flex flex-wrap items-center gap-2 rounded border border-warn bg-warn-bg p-2 text-sm text-ink print:hidden`}>
      <p className="min-w-0 flex-1">
        <span aria-hidden="true">▲ </span>
        {VITAL_LIMITS_FAILED_TEXT}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-tap rounded border border-primary bg-surface px-3 text-base font-bold text-primary"
      >
        個人の基準を読み直す
      </button>
    </div>
  )
}
