// 日報の確認欄・未読者欄の開発用の見本（read-check-preview.html から開く。npx vite で開いて見るだけ・公開物に入らない）。
// ・架空データだけ（職員は「架空職員」を名乗る）。db.ts・supabase を import しない（✔ の付け外しはこの画面のメモリだけ）
// ・本物の画面と同じ部品（ReadCheckBanner・ReadCheckPanel）と同じ判定（readCheck.ts・shiftDuty.ts）に、架空の勤務表を流す
// ・?mode=dark で暗い配色を見る

import { StrictMode, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'
import '../index.css'
import '../styles/sheet.css'
import { ReadCheckBanner, ReadCheckPanel } from '../components/DailyReadCheck'
import { buildReadCheckView } from '../lib/readCheck'
import { buildDutyTable } from '../lib/shiftDuty'
import type { ReadChecksState } from '../hooks/useReadChecks'

const staff = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `架空職員${String(i + 1).padStart(2, '0')}`, hire_order: i + 1, active: true }))
const days = ['2026-11-17', '2026-11-18', '2026-11-19']
const cells: Record<string, Record<string, string>> = {}
staff.forEach((s, i) => {
  cells[`s${s.id}`] = { 17: i % 3 === 0 ? '休' : '早', 18: i % 4 === 1 ? '希' : '日1', 19: i === 2 ? '(21' : i === 5 ? '有' : '遅' }
})
const src = {
  staff: staff.map((s) => ({ id: `s${s.id}`, name: s.name, mainDivision: '施設' })),
  symbols: [],
  months: { '2026-11': { plan: { cells }, actual: null } },
}

function Preview() {
  const duty = useMemo(() => buildDutyTable(src, days), [])
  const keys = useMemo(() => new Set(staff.map((s) => s.name)), [])
  const [checks, setChecks] = useState(() => new Map(days.map((d, i) => [d, new Set(i === 0 ? [2, 3, 5, 6, 8] : i === 1 ? [1, 3, 4, 5, 6, 7, 8] : [1])])))
  const [actorId, setActor] = useState<number | null>(1)
  const state: ReadChecksState = {
    checks,
    missing: new URLSearchParams(location.search).get('missing') === '1',
    loadFailed: false,
    loaded: true,
    duty,
    dailyKeys: keys,
    busy: new Set(),
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
  return (
    <div className="mx-auto max-w-5xl space-y-6 bg-surface p-4 text-ink">
      <p className="text-sm text-ink2">記録する職員（見本）: 架空職員{String(actorId ?? 0).padStart(2, '0')}</p>
      {days.map((day) => {
        const view = buildReadCheckView({
          day,
          today: '2026-11-19',
          staff,
          duty,
          dailyKeys: keys,
          checkedIds: checks.get(day) ?? new Set(),
          attendanceIds: new Set(),
        })
        return (
          <section key={day} className="border-2 border-border-strong" data-day={day}>
            <div className="bg-surface2 px-2 py-1 font-bold">{day} の日報（見本）</div>
            <ReadCheckBanner day={day} view={view} state={state} />
            <div className="px-2 py-6 text-ink3">（申し送りの表）</div>
            <ReadCheckPanel day={day} view={view} state={state} actorId={actorId} />
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
