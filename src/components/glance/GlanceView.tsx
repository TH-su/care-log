// ひと目ボード（/glance/:id）の画面の組み立て。props だけで描く（DB を読まない・端末に何も書かない）。
// 容器（GlancePage）と開発用の見本（src/dev/glancePreview.tsx）が同じ部品で同じ見た目を出すための束ね役。
// 区画の id は glance.ts の GLANCE_ANCHORS（兆しを押した時の移り先）。強調は2秒ほど枠を太くするだけ（色だけに頼らず枠の太さも変える）。

import type { ReactNode } from 'react'
import type { GlanceAnchor, GlanceModel, GlanceRange, MedicalState, MedicalView } from '../../lib/glance'
import { GLANCE_ANCHORS } from '../../lib/glance'
import type { Resident } from '../../lib/types'
import { GlanceHeaderBand } from './GlanceHeaderBand'
import { GlanceLayout } from './GlanceLayout'
import { GlanceSigns } from './GlanceSigns'
import { IntakeCards } from './IntakeCards'
import { MedicalPanel } from './MedicalPanel'
import type { MedicalRole } from './MedicalPanel'
import { RecentChanges } from './RecentChanges'
import { TempBoard } from './TempBoard'
import { VitalCards } from './VitalCards'
import type { GlanceSourceState } from './VitalCards'

export interface GlanceViewProps {
  model: GlanceModel
  resident: Pick<Resident, 'id' | 'name' | 'room' | 'care_level'>
  age: number | null
  asOf: string
  range: GlanceRange
  onRange: (v: GlanceRange) => void
  recentDays: number
  usualTemp: number | null
  weightSource: GlanceSourceState
  excretionSource: GlanceSourceState
  medicalState: MedicalState | 'loading'
  medicalView: MedicalView | null
  staleText: string | null
  role: MedicalRole | null
  onMedicalRetry?: () => void
  highlight: GlanceAnchor | null
  onJump: (anchor: GlanceAnchor) => void
  notes?: ReactNode
  toolbar?: ReactNode
}

export function GlanceView(p: GlanceViewProps) {
  const m = p.model
  return (
    <GlanceLayout
      header={
        <>
          {p.toolbar}
          <GlanceHeaderBand
            name={p.resident.name}
            room={p.resident.room}
            careLevel={p.resident.care_level}
            age={p.age}
            away={m.away}
            asOf={p.asOf}
            range={p.range}
            onRange={p.onRange}
          />
        </>
      }
      notes={p.notes}
      signs={<GlanceSigns signs={m.signs} total={m.signTotal} away={m.away} onJump={p.onJump} />}
      left={
        <>
          <VitalCards
            id={GLANCE_ANCHORS.vitals}
            vitals={m.vitals}
            usualTemp={p.usualTemp}
            recentDays={p.recentDays}
            weight={m.weight}
            weightSource={p.weightSource}
            highlight={p.highlight === GLANCE_ANCHORS.vitals}
          />
          <IntakeCards
            id={GLANCE_ANCHORS.intake}
            intake={m.intake}
            recentDays={p.recentDays}
            excretionSource={p.excretionSource}
            highlight={p.highlight === GLANCE_ANCHORS.intake}
          />
        </>
      }
      center={<TempBoard id={GLANCE_ANCHORS.board} board={m.board} today={m.today} highlight={p.highlight === GLANCE_ANCHORS.board} />}
      right={
        <>
          <MedicalPanel id="glance-medical" state={p.medicalState} view={p.medicalView} staleText={p.staleText} role={p.role} onRetry={p.onMedicalRetry} />
          <RecentChanges id={GLANCE_ANCHORS.changes} changes={m.recentChanges} highlight={p.highlight === GLANCE_ANCHORS.changes} />
        </>
      }
    />
  )
}

export default GlanceView
