// 個人の閾値（段階2d-2）を読めなかった時の1行の知らせ。記録の画面で同じ形に出す（印刷には出さない＝紙の版面を変えない）
import { VITAL_LIMITS_FAILED_TEXT } from '../hooks/useVitalLimits'

export function VitalLimitsFailedNote({ className = 'mt-3' }: { className?: string }) {
  return (
    <p role="status" className={`${className} rounded border border-warn bg-warn-bg p-2 text-sm text-ink print:hidden`}>
      <span aria-hidden="true">▲ </span>
      {VITAL_LIMITS_FAILED_TEXT}
    </p>
  )
}
