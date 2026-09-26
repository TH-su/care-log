// 事故報告書（事業者→熊本市）の紙の中身（A4 縦）。2026-09-26 追加。
//
// 入力・編集の画面（IncidentFormPage）が PrintArea の中に置く。画面には出ない（印刷の時だけ紙に出る）。
// 欄と選択肢は様式の並び・文言どおり（正本は types.ts の INCIDENT_* と incident.ts の注記の文言）。
//   ・選択肢は □／■（選んだものが ■）。白黒でも読める文字で持つ（色を使わない）
//   ・記録が無い欄は空欄（手書きできる余白を残す）。事業所の情報（app_settings）が空の欄も空欄
//   ・表は1つにまとめ、見出し（thead）は2枚目以降にも繰り返して刷られる（はみ出した時）
// 規律: console に何も出さない。値はこの部品の外（呼ぶ画面）が渡す。

import type { ReactNode } from 'react'
import type { OfficeProfile } from '../lib/db'
import type { IncidentInput } from '../lib/incident'
import { checkMark, FORM_NOTE_CHOICES, FORM_NOTE_FIRST } from '../lib/incident'
import {
  INCIDENT_ADDRESS_KIND_LABEL,
  INCIDENT_ADDRESS_KINDS,
  INCIDENT_CARE_LEVEL_LABEL,
  INCIDENT_CARE_LEVELS,
  INCIDENT_DEMENTIA_LEVEL_LABEL,
  INCIDENT_DEMENTIA_LEVELS,
  INCIDENT_DIAGNOSIS_KIND_LABEL,
  INCIDENT_FAMILY_RELATION_LABEL,
  INCIDENT_FAMILY_RELATIONS,
  INCIDENT_GENDER_LABEL,
  INCIDENT_GENDERS,
  INCIDENT_OFFICE_LABEL,
  INCIDENT_OFFICES,
  INCIDENT_PLACE_LABEL,
  INCIDENT_PLACES,
  INCIDENT_REPORT_STAGES,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABEL,
  INCIDENT_TYPE_LABEL,
  INCIDENT_TYPES,
  INCIDENT_VISIT_METHOD_LABEL,
  INCIDENT_VISIT_METHODS,
} from '../lib/types'

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
/** 手書き用の空き（全角の空白） */
const GAP = '　　　'

/** 'YYYY-MM-DD' → '西暦 2026 年 9 月 20 日'。空なら手書き用の空き */
function seireki(day: string | null): string {
  const m = day === null ? null : DAY_RE.exec(day)
  if (m === null) return `西暦${GAP}　年${GAP}月${GAP}日`
  return `西暦 ${Number(m[1])} 年 ${Number(m[2])} 月 ${Number(m[3])} 日`
}

/** 発生日時（24時間表記）。時刻が読めなければ時・分は空き */
function occurredText(day: string, iso: string): string {
  const d = new Date(iso)
  const time = Number.isNaN(d.getTime()) ? `${GAP}時${GAP}分` : `${d.getHours()} 時 ${String(d.getMinutes()).padStart(2, '0')} 分`
  return `${seireki(DAY_RE.test(day) ? day : null)}　${time}頃（24時間表記）`
}

/** 「その他（内容）」の括弧。空なら手書き用の空き */
function paren(text: string | null | undefined): string {
  return `（${text !== null && text !== undefined && text.trim() !== '' ? text : GAP}）`
}

/** 選択肢の並び（■ 選んだもの／□ 選んでいないもの） */
function Checks<T extends string>({
  options,
  labels,
  selected,
  extra,
}: {
  options: readonly T[]
  labels: Record<T, string>
  selected: (o: T) => boolean
  /** 選択肢の後ろに付ける文字（「その他（…）」の内容など） */
  extra?: Partial<Record<T, string>>
}) {
  return (
    <>
      {options.map((o) => (
        <span key={o} className="cl-print-check">
          {checkMark(selected(o))}
          {labels[o]}
          {extra?.[o] ?? ''}
        </span>
      ))}
    </>
  )
}

/** 長い文の欄。空なら手書き用の余白を空けておく */
function Text({ value }: { value: string | null }) {
  if (value === null || value.trim() === '') return <div className="cl-print-blank" />
  return <div className="cl-print-text">{value}</div>
}

function Row({ item, children }: { item: ReactNode; children: ReactNode }) {
  return (
    <tr>
      <th scope="row" className="cl-print-item">
        {item}
      </th>
      <td>{children}</td>
    </tr>
  )
}

/** 節の見出しの行（表の幅いっぱい） */
function SectionRow({ children }: { children: ReactNode }) {
  return (
    <tr>
      <th scope="colgroup" colSpan={2} className="cl-print-sec">
        {children}
      </th>
    </tr>
  )
}

export interface IncidentReportSheetProps {
  /** 刷る値（保存した記録。報告区分・提出日は印刷の前に選んだもの） */
  v: IncidentInput
  /** 対象者の氏名（記録時点の写し。無ければ空欄） */
  subjectName: string | null
  /** 事業所の情報（読めなかった時は null＝空欄で刷る） */
  profile: OfficeProfile | null
}

export function IncidentReportSheet({ v, subjectName, profile }: IncidentReportSheetProps) {
  const d = v.detail
  const officeName = v.office !== null && profile !== null ? profile.officeName[v.office] : ''
  const officeNo = v.office !== null && profile !== null ? profile.officeNo[v.office] : ''
  const stageNo = v.report_stage === 'nth' && v.report_no !== null ? String(v.report_no) : '＿'
  return (
    <table className="cl-print-form">
      <thead>
        <tr>
          <th colSpan={2} className="cl-print-head">
            <span className="cl-print-title">事故報告書　（事業者→熊本市）</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td colSpan={2} className="cl-print-notes">
            <div>{FORM_NOTE_FIRST}</div>
            <div>{FORM_NOTE_CHOICES}</div>
          </td>
        </tr>
        <Row item="報告区分">
          {INCIDENT_REPORT_STAGES.map((s) => (
            <span key={s} className="cl-print-check">
              {checkMark(v.report_stage === s)}
              {s === 'first' ? '第1報' : s === 'nth' ? `第${stageNo}報` : '最終報告'}
            </span>
          ))}
          <span className="cl-print-check">提出日：{seireki(v.submitted_on)}</span>
        </Row>

        <SectionRow>1 事故状況</SectionRow>
        <Row item="事故状況の程度">
          <Checks
            options={INCIDENT_SEVERITIES}
            labels={INCIDENT_SEVERITY_LABEL}
            selected={(s) => v.severity === s}
            extra={{ other: paren(v.severity === 'other' ? d.severity_other : null) }}
          />
        </Row>
        <Row item="死亡に至った場合 死亡年月日">{seireki(d.death_on)}</Row>

        <SectionRow>2 事業所の概要</SectionRow>
        <Row item="法人名">{profile?.corpName ?? ''}</Row>
        <Row item="事業所（施設）名">
          <span className="cl-print-check">{officeName}</span>
          <span className="cl-print-check">事業所番号：{officeNo}</span>
        </Row>
        <Row item="サービス種別">
          <Checks options={INCIDENT_OFFICES} labels={INCIDENT_OFFICE_LABEL} selected={(o) => v.office === o} />
        </Row>
        <Row item="所在地">{profile?.address ?? ''}</Row>

        <SectionRow>3 対象者</SectionRow>
        <Row item="氏名・年齢・性別">
          <span className="cl-print-check">氏名：{subjectName ?? GAP}</span>
          <span className="cl-print-check">年齢：{d.subject_age === null ? GAP : d.subject_age} 歳</span>
          <span className="cl-print-check">
            性別：
            <Checks options={INCIDENT_GENDERS} labels={INCIDENT_GENDER_LABEL} selected={(g) => d.subject_gender === g} />
          </span>
        </Row>
        <Row item="サービス提供開始日">
          <span className="cl-print-check">{seireki(d.service_start_on)}</span>
          <span className="cl-print-check">保険者：{d.insurer ?? ''}</span>
        </Row>
        <Row item="住所">
          <Checks
            options={INCIDENT_ADDRESS_KINDS}
            labels={INCIDENT_ADDRESS_KIND_LABEL}
            selected={(a) => d.address_kind === a}
            extra={{ other: paren(d.address_kind === 'other' ? d.address_other : null) }}
          />
        </Row>
        <Row item="身体状況">
          <div>
            要介護度：
            <Checks options={INCIDENT_CARE_LEVELS} labels={INCIDENT_CARE_LEVEL_LABEL} selected={(c) => d.care_level === c} />
          </div>
          <div>
            認知症高齢者日常生活自立度：
            <Checks
              options={INCIDENT_DEMENTIA_LEVELS}
              labels={INCIDENT_DEMENTIA_LEVEL_LABEL}
              selected={(c) => d.dementia_level === c}
            />
          </div>
        </Row>

        <SectionRow>4 事故の概要</SectionRow>
        <Row item="発生日時">{occurredText(v.occurred_on, v.occurred_at)}</Row>
        <Row item="発生場所">
          <Checks
            options={INCIDENT_PLACES}
            labels={INCIDENT_PLACE_LABEL}
            selected={(p) => v.place === p}
            extra={{ other: paren(v.place === 'other' ? v.place_other : null) }}
          />
        </Row>
        <Row item="事故の種別">
          <Checks
            options={INCIDENT_TYPES}
            labels={INCIDENT_TYPE_LABEL}
            selected={(t) => v.types.includes(t)}
            extra={{ other: paren(v.types.includes('other') ? d.type_other : null) }}
          />
        </Row>
        <Row item="発生時状況、事故内容の詳細">
          <Text value={d.situation} />
        </Row>
        <Row item="その他特記すべき事項">
          <Text value={d.special_notes} />
        </Row>

        <SectionRow>5 事故発生時の対応</SectionRow>
        <Row item="発生時の対応">
          <Text value={d.response} />
        </Row>
        <Row item="受診方法">
          <Checks
            options={INCIDENT_VISIT_METHODS}
            labels={INCIDENT_VISIT_METHOD_LABEL}
            selected={(m) => d.visit_methods.includes(m)}
            extra={{ other: paren(d.visit_methods.includes('other') ? d.visit_method_other : null) }}
          />
        </Row>
        <Row item="受診先">
          <span className="cl-print-check">医療機関名：{d.hospital_name ?? GAP}</span>
          <span className="cl-print-check">連絡先（電話番号）：{d.hospital_phone ?? GAP}</span>
        </Row>
        <Row item="診断名">{d.diagnosis_name ?? ''}</Row>
        <Row item="診断内容">
          <span className="cl-print-check">
            {checkMark(d.diagnosis_kinds.includes('cut'))}
            {INCIDENT_DIAGNOSIS_KIND_LABEL.cut}
          </span>
          <span className="cl-print-check">
            {checkMark(d.diagnosis_kinds.includes('bruise'))}
            {INCIDENT_DIAGNOSIS_KIND_LABEL.bruise}
          </span>
          <span className="cl-print-check">
            {checkMark(d.diagnosis_kinds.includes('fracture'))}
            {INCIDENT_DIAGNOSIS_KIND_LABEL.fracture}（部位：{d.diagnosis_kinds.includes('fracture') && d.fracture_site !== null ? d.fracture_site : GAP}）
          </span>
          <span className="cl-print-check">
            {checkMark(d.diagnosis_kinds.includes('other'))}
            {INCIDENT_DIAGNOSIS_KIND_LABEL.other}
            {paren(d.diagnosis_kinds.includes('other') ? d.diagnosis_other : null)}
          </span>
        </Row>
        <Row item="検査、処置等の概要">
          <Text value={d.treatment} />
        </Row>

        <SectionRow>6 事故発生後の状況</SectionRow>
        <Row item="利用者の状況">
          <Text value={d.after_status} />
        </Row>
        <Row item="家族等への報告">
          <div>
            報告した家族等の続柄：
            <Checks
              options={INCIDENT_FAMILY_RELATIONS}
              labels={INCIDENT_FAMILY_RELATION_LABEL}
              selected={(r) => d.family_relations.includes(r)}
              extra={{ other: paren(d.family_relations.includes('other') ? d.family_relation_other : null) }}
            />
          </div>
          <div>報告年月日：{seireki(d.family_reported_on)}</div>
        </Row>
        <Row item="連絡した関係機関（連絡した場合のみ）">
          <span className="cl-print-check">
            {checkMark(d.agency_municipality)}他の自治体（自治体名：{d.agency_municipality ? (d.agency_municipality_name ?? GAP) : GAP}）
          </span>
          <span className="cl-print-check">
            {checkMark(d.agency_police)}警察（警察署名：{d.agency_police ? (d.agency_police_name ?? GAP) : GAP}）
          </span>
          <span className="cl-print-check">
            {checkMark(d.agency_other)}その他（名称：{d.agency_other ? (d.agency_other_name ?? GAP) : GAP}）
          </span>
        </Row>
        <Row item="本人、家族、関係先等への追加対応予定">
          <Text value={d.followup} />
        </Row>

        <SectionRow>7 事故の原因分析（本人要因、職員要因、環境要因の分析）</SectionRow>
        <tr>
          <td colSpan={2}>
            <Text value={d.cause} />
          </td>
        </tr>
        <SectionRow>8 再発防止策（手順変更、環境変更、その他の対応、再発防止策の評価時期および結果等）</SectionRow>
        <tr>
          <td colSpan={2}>
            <Text value={d.prevention} />
          </td>
        </tr>
        <SectionRow>9 その他特記すべき事項</SectionRow>
        <tr>
          <td colSpan={2}>
            <Text value={d.other_notes} />
          </td>
        </tr>
      </tbody>
    </table>
  )
}
