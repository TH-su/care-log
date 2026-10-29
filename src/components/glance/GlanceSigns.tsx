// ひと目ボードの「変化の兆し」。重い順・最大 GLANCE_RULES.signsMax 件（並べるのは glance.ts の orderSigns）。props だけで描く。
// ・1件ずつボタン。押すと根拠の区画（sign.anchor の id）へ移って強調する（移すのは画面＝onJump）
// ・記号（!! 要注意・! 注意）と文字を必ず併記する（色だけに頼らない）・44px
// ・入院中／外泊中の日は兆しを数えない（今日がそうなら兆しは空で、その旨を出す）

import type { AwayKind, GlanceAnchor, GlanceSign } from '../../lib/glance'
import { AWAY_LABEL, GLANCE_RULES, SEVERITY_LABEL } from '../../lib/glance'

export interface GlanceSignsProps {
  signs: readonly GlanceSign[]
  /** 最大件数で切る前の件数 */
  total: number
  away: AwayKind | null
  onJump: (anchor: GlanceAnchor) => void
}

const TONE = {
  danger: 'border-danger bg-danger-bg text-danger',
  warn: 'border-warn bg-warn-bg text-warn',
} as const

export function GlanceSigns({ signs, total, away, onJump }: GlanceSignsProps) {
  return (
    <section aria-labelledby="glance-signs-h" className="rounded-lg border border-border bg-surface px-4 py-2">
      <h2 id="glance-signs-h" className="text-base font-bold text-ink">
        変化の兆し
        <span className="ml-2 text-sm font-normal text-ink2">
          重い順・最大{GLANCE_RULES.signsMax}件{total > signs.length ? `（ほか${total - signs.length}件）` : ''}。押すと根拠の欄へ移ります
        </span>
      </h2>
      {away !== null ? (
        <p className="mt-1 text-sm text-ink2">
          <span aria-hidden="true">ⓘ </span>
          {AWAY_LABEL[away]}のため、兆しは数えていません。
        </p>
      ) : signs.length === 0 ? (
        <p className="mt-1 text-sm text-ink2">
          <span aria-hidden="true">· </span>
          いま拾える兆しはありません（記録のある範囲で判定しています）。
        </p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-gap" data-glance-signs="">
          {signs.map((s, i) => (
            <li key={`${s.key}-${i}`}>
              <button
                type="button"
                onClick={() => onJump(s.anchor)}
                data-sign-key={s.key}
                data-sign-severity={s.severity}
                className={`inline-flex min-h-tap items-center gap-1 rounded border px-3 text-sm font-bold ${TONE[s.severity]}`}
              >
                <span aria-hidden="true">{s.symbol}</span>
                <span className="sr-only">{SEVERITY_LABEL[s.severity]}: </span>
                <span>{s.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default GlanceSigns
