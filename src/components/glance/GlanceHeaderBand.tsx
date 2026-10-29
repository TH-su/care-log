// ひと目ボード（/glance/:id）の見出しの帯。氏名・居室・年齢・介護度・入院中／外泊中の札・期間の切り替え。props だけで描く。
// ・年齢は医療の欄の写し（res_glance_get の row.age）だけから出す。取れなければ「—」（生年月日から計算しない）
// ・期間の保存（cl_glanceRange）は画面（GlancePage）が行う。ここは選ばれた値を返すだけ（既知値に寄せる）
// ・入院中／外泊中は札（記号ⓘ＋文字）で出す。色だけに頼らない。幅 1024 以上（lg）は帯のすぐ右の変化の兆しの欄に
//   「ⓘ 入院中のため、兆しは数えていません」が出るので、帯の札は畳む（帯が2段になって下の区画を押し出さないように）
// ・幅 1024 以上（lg）は段を詰める（1366×768 で下の区画の中身を画面に収めるため）。
//   帯は変化の兆しの左に置かれ幅が狭いので、氏名と期間の切り替えを1行目に、居室などの行を2行目（文字を1段詰める）に置き、
//   期間の見出しは読み上げだけにする（くらべ方はバイタルの区画の見出しに書いてある）

import { Chip, SegmentPicker } from '../ui'
import { AWAY_LABEL, parseGlanceRange } from '../../lib/glance'
import type { AwayKind, GlanceRange } from '../../lib/glance'

export interface GlanceHeaderBandProps {
  name: string
  room: string | null
  careLevel: string | null
  /** 満年齢（医療の欄の row.age。取れなければ null＝「—」） */
  age: number | null
  away: AwayKind | null
  /** 「10月29日（水） 9:30 時点」などの時点の文 */
  asOf: string
  range: GlanceRange
  onRange: (v: GlanceRange) => void
}

const RANGE_OPTIONS: { value: GlanceRange; label: string }[] = [
  { value: '7', label: '直近7日' },
  { value: '14', label: '直近14日' },
]

export function GlanceHeaderBand({ name, room, careLevel, age, away, asOf, range, onRange }: GlanceHeaderBandProps) {
  return (
    <header className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-lg border border-border-strong bg-surface px-4 py-2 lg:items-center lg:gap-y-0 lg:px-3 lg:py-1">
      <div className="min-w-0 flex-1 lg:contents">
        <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 lg:min-w-0 lg:flex-1">
          <span className="min-w-0 break-words text-xl font-heavy text-ink">{name}</span>
          <span className="text-sm font-normal text-ink2">ひと目ボード</span>
          {away !== null ? (
            <Chip tone="info" className="whitespace-nowrap lg:hidden">
              <span aria-hidden="true">ⓘ</span>
              {AWAY_LABEL[away]}（兆しは数えません）
            </Chip>
          ) : null}
        </h1>
        <p className="tabular mt-1 text-sm text-ink2 lg:order-last lg:mt-0 lg:basis-full lg:text-2xs">
          居室 {room ?? '—'}・年齢 {age === null ? '—' : `${age}歳`}・介護度 {careLevel ?? '—'}・{asOf}
        </p>
      </div>
      <div className="w-full sm:w-auto lg:flex lg:items-center lg:gap-2">
        <p className="text-sm text-ink2 lg:sr-only">期間（その前の28日とくらべる）</p>
        <div className="mt-1 whitespace-nowrap lg:mt-0">
          <SegmentPicker options={RANGE_OPTIONS} value={range} onChange={(v) => onRange(parseGlanceRange(v))} ariaLabel="期間" />
        </div>
      </div>
    </header>
  )
}

export default GlanceHeaderBand
