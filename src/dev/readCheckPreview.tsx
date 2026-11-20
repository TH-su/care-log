// 日報の確認欄と〔未読者〕の開発用の見本（read-check-preview.html から開く。npx vite で開いて見るだけ・公開物に入らない）。
// ・架空データだけ（職員は「架空職員」を名乗る）。db.ts・supabase を import しない（✔ の付け外しはこの画面のメモリだけ）
// ・本物の画面と同じ部品（ReadCheckPanel）と同じ決まり（readCheck.ts・shiftDuty.ts）に、架空の勤務表を流す
// ・今日は 2026-11-21 の 10:00 とみなす。架空職員07 は主の区分が通所（デイ職員＝並ばない・未読者に出ない）
// ・?mode=dark で暗い配色を見る

import { StrictMode, useMemo, useState } from 'react'
import type { UnreadWho } from '../lib/readCheck'
import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'
import '../index.css'
import '../styles/sheet.css'
import { ReadCheckPanel, UnreadTrailBar } from '../components/DailyReadCheck'
import { buildCheckPanel, buildUnreadSummary } from '../lib/readCheck'
import { buildFacilityDutyTable } from '../lib/shiftDuty'
import type { ReadChecksState, UnreadSource } from '../hooks/useReadChecks'

const staff = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `架空職員${String(i + 1).padStart(2, '0')}`, hire_order: i + 1, active: true }))
const days = ['2026-11-19', '2026-11-20', '2026-11-21']
const TODAY = '2026-11-21'
const NOW_MIN = 10 * 60
// 1・2: 毎日 早番（7:00）、3: 夜勤（19日・21日入り）、4: 20日休み→21日 遅番（11:00＝今はまだ出勤前）、5: 日勤 9-18、6: 21日休み、7: デイ職員、8: 20日夜勤入り
const cells: Record<string, Record<string, string>> = {
  s1: { 19: '早', 20: '早', 21: '早', 22: '早' },
  s2: { 19: '早', 20: '早', 21: '早', 22: '早' },
  s3: { 19: '(21', 20: '7)', 21: '(21', 22: '7)' },
  s4: { 19: '早', 20: '休', 21: '遅', 22: '遅' },
  s5: { 19: '9-18', 20: '9-18', 21: '9-18', 22: '9-18' },
  s6: { 19: '早', 20: '早', 21: '休', 22: '早' },
  s7: { 19: '日1', 20: '日1', 21: '日1', 22: '日1' },
  s8: { 19: '休', 20: '（22', 21: '8)', 22: '休' },
}
const src = {
  staff: staff.map((s) => ({ id: `s${s.id}`, name: s.name, mainDivision: s.id === 7 ? '通所' : '施設' })),
  symbols: [
    { code: '早', type: 'work', start: '07:00' },
    { code: '遅', type: 'work', start: '11:00' },
    { code: '日1', type: 'work', start: '09:00' },
    { code: '(21', type: 'nightIn', start: '21:00' },
    { code: '7)', type: 'nightOut' },
    { code: '8)', type: 'nightOut' },
    { code: '休', type: 'off' },
  ],
  months: { '2026-11': { plan: { cells }, actual: null } },
}
const dutyDays = ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']
const dayKeys = new Set(['架空職員07'])
const roster = new Set(staff.map((s) => s.name))

function Preview() {
  const fac = useMemo(() => buildFacilityDutyTable(src, dutyDays), [])
  const [checks, setChecks] = useState(() => new Map(days.map((d, i) => [d, new Set(i === 0 ? [1, 2, 3] : i === 1 ? [1, 8] : [])])))
  const [actorId, setActor] = useState<number | null>(1)
  const state: ReadChecksState = {
    checks,
    missing: new URLSearchParams(location.search).get('missing') === '1',
    loadFailed: false,
    loaded: true,
    shiftLoaded: true,
    rosterKeys: roster,
    duty: null,
    dailyKeys: null,
    fac,
    dayKeys,
    busy: new Set(),
    version: 0,
    add: async (day, id) => {
      setActor(id)
      setChecks((cur) => new Map(cur).set(day, new Set([...(cur.get(day) ?? []), id])))
    },
    cancel: async (day, id) => {
      setChecks((cur) => {
        const s = new Set(cur.get(day) ?? [])
        s.delete(id)
        return new Map(cur).set(day, s)
      })
    },
  }
  const source: UnreadSource = { ready: true, failed: false, missing: false, today: TODAY, checks, duty: fac, roster, dayKeys }
  const summary = buildUnreadSummary({ today: TODAY, staff, duty: fac, checks, rosterKeys: roster, dayKeys, nowMin: NOW_MIN })
  // 未読の日を続けて読む窓（2026-11-20）: 〔未読者〕の日付から開いた人と日を覚え、その日に ✔ が付いたら確認欄の下に出す
  const [trail, setTrail] = useState<(UnreadWho & { day: string }) | null>(null)
  const pick = (d: string, who?: UnreadWho) => {
    setTrail(who ? { ...who, day: d } : null)
    document.querySelector(`[data-day="${d}"]`)?.scrollIntoView({ block: 'start' })
  }
  return (
    <div className="mx-auto max-w-5xl space-y-6 bg-surface p-4 text-ink">
      <p className="text-sm text-ink2">記録する職員（見本）: 架空職員{String(actorId ?? 0).padStart(2, '0')}・今日は {TODAY} の 10:00 とみなす</p>
      {days.map((day) => {
        const panel = buildCheckPanel({ day, today: TODAY, staff, duty: fac, checkedIds: checks.get(day) ?? new Set(), rosterKeys: roster, dayKeys })
        return (
          <section key={day} className="border-2 border-border-strong" data-day={day}>
            <div className="bg-surface2 px-2 py-1 font-bold">{day} の日報（見本）</div>
            <div className="dsheet-body">
              <div className="px-2 py-6 text-ink3">（申し送りの表）</div>
              <div className="dsheet-island-night border-2 border-border px-2 py-4 text-ink3">（夜勤申し送り）</div>
              <ReadCheckPanel
                day={day}
                panel={panel}
                state={state}
                actorId={actorId}
                unreadIds={summary.byDay.get(day) ?? new Set()}
                summary={summary}
                unreadSource={source}
                onPickDay={pick}
                showUnread={day === TODAY}
              />
              {trail !== null && trail.day === day && (
                <UnreadTrailBar
                  trail={trail}
                  summary={summary}
                  checks={checks}
                  onPick={(d) => pick(d, trail)}
                  onToday={() => pick(TODAY)}
                  onClose={() => setTrail(null)}
                />
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

const modeParam = new URLSearchParams(location.search).get('mode')
if (modeParam === 'dark' || modeParam === 'light') document.documentElement.dataset.mode = modeParam
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
)
