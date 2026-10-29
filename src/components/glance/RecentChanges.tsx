// ひと目ボードの「最新の体調変化」。props だけで描く（DB を読まない）。
// ・申し送り（最重要・継続中・体調の分類を優先、新しい順。件数は GLANCE_RULES.recentNotes）
// ・事故・ヒヤリハット（直近 recentIncidentDays 日）・与薬の「未」「拒否」（直近 recentMedDays 日）・入浴の中止（直近 recentBathDays 日）
// 並べ方と件数は glance.ts の computeGlance が決めたものをそのまま出す。記号＋文字で示し色だけに頼らない。

import type { ReactNode } from 'react'
import type { GlanceRecentChanges } from '../../lib/glance'
import { BOARD_UNAVAILABLE_TEXT, GLANCE_RULES } from '../../lib/glance'
import { BATH_CANCEL_REASON_LABEL, IMPORTANCE_LABEL, INCIDENT_KIND_LABEL, MED_SLOT_LABEL } from '../../lib/types'
import { typesText } from '../../lib/incident'

export interface RecentChangesProps {
  changes: GlanceRecentChanges
  highlight?: boolean
  id: string
}

const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`

// unavailable: 記録の表が読めなかった時は「なし」と出さず「—（カルテで確認）」にする
function Group({ title, empty, unavailable = false, children }: { title: string; empty: boolean; unavailable?: boolean; children: ReactNode }) {
  return (
    <div className="mt-1">
      <h3 className="text-sm font-bold text-ink2">{title}</h3>
      {unavailable ? <p className="text-sm text-ink3">{BOARD_UNAVAILABLE_TEXT}</p> : empty ? <p className="text-sm text-ink3">なし</p> : <ul className="text-sm text-ink">{children}</ul>}
    </div>
  )
}

export function RecentChanges({ changes, highlight = false, id }: RecentChangesProps) {
  const R = GLANCE_RULES
  return (
    <section id={id} tabIndex={-1} aria-labelledby={`${id}-h`} className={`min-w-0 rounded-lg border bg-surface p-2 ${highlight ? 'border-focus ring-2 ring-focus' : 'border-border'}`}>
      <h2 id={`${id}-h`} className="px-1 text-base font-bold text-ink">
        最新の体調変化
      </h2>
      <div className="px-1">
        <Group title={`申し送り（新しい順・最大${R.recentNotes}件）`} empty={changes.notes.length === 0}>
          {changes.notes.map((n) => (
            <li key={n.id} className="border-b border-border py-0.5">
              <span className="tabular text-ink2">{md(n.note_on)} </span>
              {n.importance !== 'normal' ? <span className={`font-bold ${n.importance === 'critical' ? 'text-danger' : 'text-warn'}`}>{IMPORTANCE_LABEL[n.importance]} </span> : null}
              {n.ongoing && n.ended_at == null ? <span className="font-bold text-info">[継続中] </span> : null}
              <span className="break-words">{n.body.length > 80 ? `${n.body.slice(0, 80)}…` : n.body}</span>
            </li>
          ))}
        </Group>
        <Group title={`事故・ヒヤリハット（${R.recentIncidentDays}日）`} empty={changes.incidents.length === 0} unavailable={changes.incidentsUnavailable}>
          {changes.incidents.map((i) => (
            <li key={i.id}>
              <span className="tabular text-ink2">{md(i.occurred_on)} </span>
              <span className={`font-bold ${i.kind === 'accident' ? 'text-danger' : 'text-warn'}`}>
                <span aria-hidden="true">{i.kind === 'accident' ? '!! ' : '! '}</span>
                {INCIDENT_KIND_LABEL[i.kind]}
              </span>{' '}
              {typesText(i.types)}
            </li>
          ))}
        </Group>
        <Group title={`与薬の未・拒否（${R.recentMedDays}日）`} empty={changes.medIssues.length === 0} unavailable={changes.medsUnavailable}>
          {changes.medIssues.map((x, k) => (
            <li key={`${x.day}-${x.slot}-${k}`} className="tabular">
              {md(x.day)} {MED_SLOT_LABEL[x.slot]} {x.kind === 'missing' ? '未' : '拒否'}
            </li>
          ))}
        </Group>
        <Group title={`入浴の中止（${R.recentBathDays}日）`} empty={changes.bathCancels.length === 0}>
          {changes.bathCancels.map((b) => (
            <li key={b.id} className="tabular">
              {md(b.bath_on)} 中止{b.cancel_reason ? `（${BATH_CANCEL_REASON_LABEL[b.cancel_reason]}）` : ''}
            </li>
          ))}
        </Group>
      </div>
    </section>
  )
}

export default RecentChanges
