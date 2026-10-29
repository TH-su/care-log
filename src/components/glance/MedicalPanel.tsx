// ひと目ボードの医療の欄（病歴・内服薬・かかりつけ）。props だけで描く（DB を読まない・端末に何も書かない）。
// ・中身は res_glance_get の写し（db.ts の fetchResGlance が畳んだ結果を、glance.ts の normalizeMedicalRow で整えた MedicalView）
// ・状態ごとの文言は glance.ts の MEDICAL_STATE_MESSAGE（ROOT どおり）。写しが古ければ「◯月◯日時点の写し」（medicalStaleText）
// ・現場（field）・事務所（office）・管理者（admin）のどの役割にも同じ中身を出す（ui-design.md §10.1）。役割は画面の確かめのために
//   data 属性へ写すだけで、出し分けはしない
// ・受け取った値はメモリだけ（保存しない）。空の項目は「—」
// ・幅 1024 以上（lg）は項目を2段組みに流し、項目名と中身を1行に続けて書く（中身は「・」でつなぐ）。1366×768 で区画の中身を縦に動かさずに見せるため

import type { ReactNode } from 'react'
import type { MedicalState, MedicalView } from '../../lib/glance'
import { MEDICAL_STATE_MESSAGE } from '../../lib/glance'

export type MedicalRole = 'admin' | 'office' | 'field'

export interface MedicalPanelProps {
  /** 'loading'＝読み込み中 */
  state: MedicalState | 'loading'
  view: MedicalView | null
  /** 写しが古い時の注記（新しければ null） */
  staleText: string | null
  role: MedicalRole | null
  onRetry?: () => void
  id: string
}

function Lines({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return <span className="text-ink3">—</span>
  return (
    <ul className="list-none lg:inline">
      {lines.map((l, i) => (
        <li key={i} className="break-words lg:inline">
          {i > 0 ? (
            <span aria-hidden="true" className="hidden lg:inline">
              ・
            </span>
          ) : null}
          {l}
        </li>
      ))}
    </ul>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-4 gap-2 border-b border-border py-1 lg:block lg:break-inside-avoid lg:py-0">
      <dt className="col-span-1 text-sm font-bold text-ink2 lg:mr-1 lg:inline lg:text-2xs">{label}</dt>
      <dd className="col-span-3 min-w-0 text-sm text-ink lg:inline lg:text-xs">{children}</dd>
    </div>
  )
}

export function MedicalPanel({ state, view, staleText, role, onRetry, id }: MedicalPanelProps) {
  let body: ReactNode
  if (state === 'loading') {
    body = (
      <p role="status" className="text-sm text-ink2">
        病歴・内服薬を読み込み中です…
      </p>
    )
  } else if (state !== 'ok' || view === null) {
    const msg = state === 'ok' ? MEDICAL_STATE_MESSAGE.error : MEDICAL_STATE_MESSAGE[state]
    body = (
      <div>
        <p className="text-sm text-ink2" data-medical-message="">
          <span aria-hidden="true">{state === 'error' ? '▲ ' : 'ⓘ '}</span>
          {msg}
        </p>
        {state === 'error' && onRetry ? (
          <button type="button" onClick={onRetry} className="mt-2 inline-flex min-h-tap items-center rounded border border-border-strong bg-surface px-4 text-base text-ink">
            もう一度読む
          </button>
        ) : null}
      </div>
    )
  } else {
    body = (
      <>
        {staleText ? (
          <p className="mb-1 text-sm text-warn">
            <span aria-hidden="true">▲ </span>
            {staleText}
          </p>
        ) : null}
        <dl className="lg:columns-2 lg:gap-x-3">
          <Row label="病名">
            <Lines lines={[...view.diseases, ...view.currentDiseases.filter((l) => !view.diseases.includes(l))]} />
          </Row>
          <Row label="既往歴">
            <Lines lines={view.pastHistory} />
          </Row>
          <Row label={`定期薬（${view.medsRegularCount}剤）`}>
            <Lines lines={view.medsRegular} />
          </Row>
          <Row label="頓用薬">
            <Lines lines={view.medsPrn} />
          </Row>
          <Row label="注意する薬">
            <Lines lines={view.highRiskMeds} />
          </Row>
          <Row label="副作用歴">
            <Lines lines={view.sideEffects} />
          </Row>
          <Row label="アレルギー">
            <Lines lines={[...view.allergy, ...view.allergenTags]} />
          </Row>
          <Row label="禁食">
            <Lines lines={view.forbiddenTags} />
          </Row>
          <Row label="嚥下・食形態">
            <Lines lines={[...view.swallow, ...view.mealForm, ...view.thickener]} />
          </Row>
          <Row label="医療処置・感染症">
            <Lines lines={[...view.medicalCare, ...view.infections]} />
          </Row>
          <Row label="服薬の管理">
            <Lines lines={view.medMgmt} />
          </Row>
          <Row label="かかりつけ">
            <Lines lines={[...view.hospital, ...view.doctor, ...view.visitDay]} />
          </Row>
        </dl>
      </>
    )
  }
  return (
    <section id={id} tabIndex={-1} aria-labelledby={`${id}-h`} data-medical-state={state} data-role={role ?? ''} className="relative min-w-0 rounded-lg border border-border bg-surface p-2 lg:min-h-0 lg:flex-auto lg:overflow-y-auto lg:p-1.5">
      <h2 id={`${id}-h`} className="px-1 text-base font-bold text-ink lg:text-sm">
        病歴・内服薬<span className="ml-2 text-sm font-normal text-ink2 lg:text-2xs">入居者マスタの写し（読むだけ）</span>
      </h2>
      <div className="px-1">{body}</div>
    </section>
  )
}

export default MedicalPanel
