// 発熱者・他症状者の測定1件の取り消し（supabase/migrations/0020_delete_vital.sql）の契約。
//
// ・fakeDeleteVital … 0020 の判定規則を JS で写した偽物（npm test・画面検証の偽サーバーが使う）
// ・VITAL_DELETE_CASES … 同じ入力に対して 0020 と偽物が同じ答えを返すことを押さえる表。
//     npm test は偽物で（tests/vitaldelete.test.mjs）、素の Postgres（0001〜0011・0017・0019・0020 適用済み）では
//     tests/vital-delete-pg.mjs で同じ表を流し、どちらも expect と一致することを確かめる。
// ・checkVitalDelete … 結果と後の状態を expect と突き合わせ、食い違いの一覧を返す（空なら一致）
//
// 個人情報は置かない（利用者・職員は数値IDのみ。症状は記号だけ）。

import { PgError, canonCell } from './cell-contract.mjs'

export { PgError }

export const VITAL_DELETE_FIELDS = ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2', 'measured_at', 'note', 'symptom']

/** 契約の表の行の既定（発熱者の測定1件） */
export const VITAL_BASE_ROW = {
  resident_id: 1,
  measured_on: '2026-11-02',
  kind: 'observation',
  measured_at: '10:00:00',
  temp: 37.8,
  sys_bp: 128,
  dia_bp: 76,
  pulse: 88,
  spo2: 96,
  note: null,
  symptom: null,
  recorded_by: 1,
}

/** 行の8欄をそのまま「見た値」にしたもの */
export function seenOf(row) {
  const out = {}
  for (const f of VITAL_DELETE_FIELDS) out[f] = row[f] ?? null
  return out
}

/** jsonb の ->> の写し */
function jsonText(v) {
  if (v === null || v === undefined) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

const rowOut = (r) => ({
  id: r.id,
  resident_id: r.resident_id,
  measured_on: r.measured_on,
  kind: r.kind,
  measured_at: r.measured_at,
  temp: r.temp,
  sys_bp: r.sys_bp,
  dia_bp: r.dia_bp,
  pulse: r.pulse,
  spo2: r.spo2,
  note: r.note,
  symptom: r.symptom,
  recorded_by: r.recorded_by,
  rev: r.rev,
})

/**
 * 0020 の写し。db = { vitals: 行の配列, history: 変更の記録, member: 許可リストの有効な人か（既定 true） }
 * 例外は PgError（code は Postgres の SQLSTATE と同じ）
 */
export function fakeDeleteVital(db, { p_id, p_seen, p_editor = null }) {
  if (p_id === null || p_id === undefined) return { version: 1, status: 'probe' }
  const seen = p_seen ?? {}
  if (typeof seen !== 'object' || Array.isArray(seen) || seen === null) {
    throw new PgError('22023', '取り消す記録の内容を読み取れませんでした')
  }
  const missingKey = VITAL_DELETE_FIELDS.find((f) => !Object.prototype.hasOwnProperty.call(seen, f))
  if (missingKey !== undefined) throw new PgError('22023', `取り消す記録の内容が足りません（${missingKey}）`)
  // RLS（0019 の member_only）: 許可リストに無い人には行が見えない
  const row = db.member === false ? undefined : db.vitals.find((r) => r.id === Number(p_id))
  if (row === undefined) return { version: 1, status: 'conflict', reason: 'missing', row: null }
  if (row.kind !== 'observation' && row.kind !== 'symptom') throw new PgError('22023', 'この種類の記録はここでは取り消せません')
  if (row.deleted_at !== null && row.deleted_at !== undefined) return { version: 1, status: 'settled', reason: null, row: null }
  for (const f of VITAL_DELETE_FIELDS) {
    const a = canonCell(f, jsonText(seen[f]))
    const b = canonCell(f, jsonText(row[f]))
    if (a !== b) return { version: 1, status: 'conflict', reason: 'changed', row: rowOut(row) }
  }
  const before = { ...row }
  row.deleted_at = new Date().toISOString()
  row.edited_by = p_editor
  row.rev += 1
  db.history.push({ table_name: 'vitals', row_id: row.id, op: 'delete', old_row: before, new_row: { ...row }, changed_by_staff: p_editor })
  return { version: 1, status: 'applied', reason: null, row: null }
}

/**
 * 契約の表。row＝前の行（null＝行が無い）・deleted＝取り消し済みの行・member＝許可リストの有効な人か・
 * seen＝見た値（省略＝行の8欄そのまま）・expect＝{status, reason, rowTemp?, error?, after:{deleted, revDelta, history, editedBy}}
 */
export const VITAL_DELETE_CASES = [
  {
    name: '確かめ（p_id=null）は何も書かずに probe',
    row: null,
    id: null,
    expect: { status: 'probe', after: { history: 0 } },
  },
  {
    name: '見た値のまま → 取り消す（rev +1・edited_by・履歴 delete 1行）',
    row: {},
    editor: 2,
    expect: { status: 'applied', reason: null, row: null, after: { deleted: true, revDelta: 1, history: 1, historyOp: 'delete', editedBy: 2 } },
  },
  {
    name: '体温が他の端末で変わっていた → 取り消さない（いまの行を返す）',
    row: {},
    seen: { temp: 38.4 },
    editor: 2,
    expect: { status: 'conflict', reason: 'changed', rowTemp: 37.8, after: { deleted: false, revDelta: 0, history: 0 } },
  },
  {
    name: '血圧の下だけ食い違う → 取り消さない',
    row: {},
    seen: { dia_bp: 80 },
    expect: { status: 'conflict', reason: 'changed', after: { deleted: false, revDelta: 0, history: 0 } },
  },
  {
    name: '時刻は秒の有無をそろえて比べる（10:00 と 10:00:00 は同じ）',
    row: {},
    seen: { measured_at: '10:00' },
    expect: { status: 'applied', after: { deleted: true, revDelta: 1, history: 1 } },
  },
  {
    name: '体温は numeric(3,1) にそろえて比べる（"37.80" と 37.8 は同じ）',
    row: {},
    seen: { temp: '37.80' },
    expect: { status: 'applied', after: { deleted: true, revDelta: 1, history: 1 } },
  },
  {
    name: '文字の欄は空文字と null を同じとみなす',
    row: {},
    seen: { note: '' },
    expect: { status: 'applied', after: { deleted: true, revDelta: 1, history: 1 } },
  },
  {
    name: '他症状者の1件（症状が見たまま）→ 取り消す',
    row: { kind: 'symptom', temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null, symptom: '＊＊' },
    expect: { status: 'applied', after: { deleted: true, revDelta: 1, history: 1 } },
  },
  {
    name: '他症状者の症状が変わっていた → 取り消さない',
    row: { kind: 'symptom', temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null, symptom: '＊＊' },
    seen: { symptom: '＊' },
    expect: { status: 'conflict', reason: 'changed', after: { deleted: false, revDelta: 0, history: 0 } },
  },
  {
    name: '既に取り消されていた → settled（何も書かない）',
    row: {},
    deleted: true,
    expect: { status: 'settled', reason: null, row: null, after: { deleted: true, revDelta: 0, history: 0 } },
  },
  {
    name: '行が無い → 競合（missing）',
    row: null,
    expect: { status: 'conflict', reason: 'missing', row: null, after: { history: 0 } },
  },
  {
    name: '許可リストに無い人には行が見えない → missing（何も書かない）',
    row: {},
    member: false,
    expect: { status: 'conflict', reason: 'missing', row: null, after: { deleted: false, revDelta: 0, history: 0 } },
  },
  {
    name: '定時（routine）の行は取り消せない（拒否）',
    row: { kind: 'routine' },
    expect: { error: '22023', after: { deleted: false, revDelta: 0, history: 0 } },
  },
  {
    name: '見た値の欄が欠けている → 拒否（見ていない欄がある取り消しを受けない）',
    row: {},
    seenDrop: 'spo2',
    expect: { error: '22023', after: { deleted: false, revDelta: 0, history: 0 } },
  },
  {
    name: '見た値が配列 → 拒否',
    row: {},
    seenRaw: [],
    expect: { error: '22023', after: { deleted: false, revDelta: 0, history: 0 } },
  },
]

/** その場合に送る p_seen */
export function seenForCase(c) {
  if (c.seenRaw !== undefined) return c.seenRaw
  const s = { ...seenOf({ ...VITAL_BASE_ROW, ...(c.row ?? {}) }), ...(c.seen ?? {}) }
  if (c.seenDrop !== undefined) delete s[c.seenDrop]
  return s
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b) || (a != null && b != null && Number(a) === Number(b))

export function checkVitalDelete(c, result, after) {
  const out = []
  const e = c.expect
  if (e.error !== undefined) {
    if (result.error !== e.error) out.push(`error: ${JSON.stringify(result.error ?? result.ok)} != ${e.error}`)
  } else if (result.error !== undefined) {
    out.push(`unexpected error ${result.error}`)
  } else {
    const r = result.ok
    if (r.version !== 1) out.push(`version ${r.version}`)
    if (r.status !== e.status) out.push(`status ${r.status} != ${e.status}`)
    if (e.reason !== undefined && (r.reason ?? null) !== e.reason) out.push(`reason ${r.reason} != ${e.reason}`)
    if (e.row === null && r.row !== null && r.row !== undefined) out.push(`row should be null: ${JSON.stringify(r.row)}`)
    if (e.rowTemp !== undefined && !same(r.row?.temp, e.rowTemp)) out.push(`row.temp ${JSON.stringify(r.row?.temp)} != ${e.rowTemp}`)
  }
  for (const [k, v] of Object.entries(e.after ?? {})) {
    if (!same(after[k], v)) out.push(`after.${k} ${JSON.stringify(after[k])} != ${JSON.stringify(v)}`)
  }
  return out
}

/** 偽物で1件流す（npm test・画面検証と同じ入口） */
export function runFakeCase(c) {
  const db = { vitals: [], history: [], member: c.member !== false }
  let rev0 = null
  if (c.row !== null) {
    db.vitals.push({ id: 101, rev: 1, edited_by: null, deleted_at: c.deleted ? '2026-11-01T00:00:00Z' : null, ...VITAL_BASE_ROW, ...c.row })
    rev0 = 1
  }
  let result
  try {
    result = { ok: fakeDeleteVital(db, { p_id: c.id === undefined ? 101 : c.id, p_seen: seenForCase(c), p_editor: c.editor ?? null }) }
  } catch (err) {
    if (!(err instanceof PgError)) throw err
    result = { error: err.code }
  }
  const r = db.vitals[0]
  const after =
    c.row === null
      ? { history: db.history.length }
      : {
          deleted: r.deleted_at !== null,
          revDelta: r.rev - rev0,
          history: db.history.length,
          historyOp: db.history[0]?.op,
          editedBy: r.edited_by,
        }
  return { result, after }
}
