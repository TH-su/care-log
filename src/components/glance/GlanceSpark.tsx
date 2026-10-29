// ひと目ボードの小さい線（14日の日ごとの平均）。props だけで描く（DB を読まない）。
// 記録の無い日は線を切る（補わない＝「記録なし」の誤読を防ぐ。見守りボードの小さい線と同じ作法）。孤立した1日は点で出す。
// 色はトークンのクラスだけ（stroke-ink2 など）。読み上げには日ごとの値を文字で渡す。

const W = 96
const H = 24
const PAD = 2

export interface GlanceSparkProps {
  /** 古い順の日ごとの値（無い日は null） */
  values: readonly (number | null)[]
  /** 縦軸（[下, 上]） */
  domain: [number, number]
  /** 読み上げの見出し（例: 体温の14日） */
  label: string
  /** 読み上げで値に付ける桁数 */
  digits?: number
}

export function GlanceSpark({ values, domain, label, digits = 0 }: GlanceSparkProps) {
  const n = values.length
  const [lo, hi] = domain
  const span = hi - lo
  const pts = values.map((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || !(span > 0)) return null
    const x = n <= 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (n - 1)
    const c = Math.min(hi, Math.max(lo, v))
    return { x, y: PAD + ((hi - c) * (H - PAD * 2)) / span }
  })
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
  const recorded = values.some((v) => typeof v === 'number' && Number.isFinite(v))
  const speech = recorded
    ? `${label} ${values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '記録なし')).join('、')}`
    : `${label} 記録なし`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-6 w-24 shrink-0" role="img" aria-label={speech} preserveAspectRatio="none">
      <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {d !== '' ? (
        <path d={d.trim()} className="fill-none stroke-ink2" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      ) : null}
      {dots.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={1.5} className="fill-ink2" />
      ))}
    </svg>
  )
}

export default GlanceSpark
