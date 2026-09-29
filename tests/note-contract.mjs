// 申し送りの欄ごとの compare-and-set（supabase/migrations/0017_apply_note_edits.sql）の契約。
//
// ・fakeApplyNoteEdits … 0017 の判定規則を JS で写した偽物（tests/logic.test.mjs の偽クライアントが使う）
// ・NOTE_CONTRACT_CASES … 同じ入力に対して 0017 と偽物が同じ答えを返すことを押さえる表。
//     npm test は偽物で、素の Postgres（0001〜0011・0017 適用済み）では tests/note-contract-pg.mjs で
//     同じ表を流し、どちらも expect と一致することを確かめる（規則の食い違いをここで捕まえる）。
// ・checkNoteContract … 結果と後の状態を expect と突き合わせ、食い違いの一覧を返す（空なら一致）
//
// 個人情報は置かない（利用者・職員は数値IDのみ。本文は記号だけ）。

import { PgError } from './cell-contract.mjs'

export { PgError }

export const NOTE_FIELDS = [
  'body',
  'resident_id',
  'importance',
  'color',
  'after16',
  'occurred_at',
  'reporter_id',
  'role_tags',
  'shift',
  'ongoing',
  'ended_at',
  'ended_by',
  'deleted_at',
]
const ID_FIELDS = new Set(['resident_id', 'reporter_id', 'ended_by'])
const BOOL_FIELDS = new Set(['after16', 'ongoing'])
const NOTE_ROW = [
  'id',
  'note_on',
  'shift',
  'facility',
  'category',
  'resident_id',
  'role_tags',
  'importance',
  'body',
  'occurred_at',
  'ongoing',
  'ended_at',
  'reporter_id',
  'color',
  'after16',
  'rev',
]
/** 0001・0003 の check 制約 */
const CHECKS = {
  importance: ['normal', 'important', 'critical'],
  shift: ['day', 'daycare', 'night'],
  color: [null, 'pink', 'yellow', 'blue', 'green', 'orange'],
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

/** jsonb の ->> の写し（null は null、文字列はそのまま、それ以外は JSON 表記） */
function jsonText(v) {
  if (v === null || v === undefined) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/** jsonb の ::text の写し（配列は要素の間に「, 」） */
function jsonbText(v) {
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`
  return JSON.stringify(v)
}

/** (nullif(x, '')::列の型)::text の写し */
export function canonNote(field, v) {
  if (field === 'role_tags') return v === null || v === undefined ? null : jsonbText(v)
  const text = jsonText(v)
  if (text === null || text === '') return null
  if (ID_FIELDS.has(field)) {
    if (!/^\s*[+-]?\d+\s*$/.test(text)) throw new PgError('22P02', `invalid input syntax for type bigint: "${text}"`)
    return String(Number(text))
  }
  if (BOOL_FIELDS.has(field)) {
    const t = text.trim().toLowerCase()
    if (['t', 'true', 'y', 'yes', 'on', '1'].includes(t)) return 'true'
    if (['f', 'false', 'n', 'no', 'off', '0'].includes(t)) return 'false'
    throw new PgError('22P02', `invalid input syntax for type boolean: "${text}"`)
  }
  if (field === 'occurred_at') {
    const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*$/.exec(text)
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || (m[3] !== undefined && Number(m[3]) > 59)) {
      throw new PgError('22007', `invalid input syntax for type time: "${text}"`)
    }
    return `${m[1].padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}`
  }
  if (field === 'ended_at' || field === 'deleted_at') {
    const t = Date.parse(text)
    if (Number.isNaN(t)) throw new PgError('22007', `invalid input syntax for type timestamp with time zone: "${text}"`)
    return new Date(t).toISOString()
  }
  return text
}

/** 比較用の文字列 → 行に入れる値 */
function typed(field, v) {
  if (field === 'role_tags') return [...v]
  const c = canonNote(field, v)
  if (c === null) return null
  if (ID_FIELDS.has(field)) return Number(c)
  if (BOOL_FIELDS.has(field)) return c === 'true'
  return c
}

const bad = (msg) => new PgError('22023', msg)

/** 偽のデータベース（申し送りと変更の記録・職員の id） */
export function createNoteDb() {
  return { notes: [], history: [], staff: new Set([1, 2]), residents: new Set([1, 2]) }
}

function rowJson(row) {
  const out = {}
  for (const k of NOTE_ROW) out[k] = row[k] ?? null
  if (!Array.isArray(out.role_tags)) out.role_tags = []
  return out
}

function checkRow(db, row) {
  for (const [k, allowed] of Object.entries(CHECKS)) {
    if (!allowed.includes(row[k])) throw new PgError('23514', `new row for relation "notes" violates check constraint "notes_${k}_check"`)
  }
  if (row.body === null || row.body === '') throw new PgError('23514', 'new row for relation "notes" violates check constraint "notes_body_check"')
  for (const k of ['edited_by', 'reporter_id', 'ended_by']) {
    const v = row[k]
    if (v !== null && v !== undefined && !db.staff.has(v)) {
      throw new PgError('23503', `insert or update on table "notes" violates foreign key constraint "notes_${k}_fkey"`)
    }
  }
  if (row.resident_id !== null && row.resident_id !== undefined && !db.residents.has(row.resident_id)) {
    throw new PgError('23503', 'insert or update on table "notes" violates foreign key constraint "notes_resident_id_fkey"')
  }
}

/** 0017 apply_note_edits の写し。例外は PgError（code は Postgres の SQLSTATE） */
export function fakeApplyNoteEdits(db, args) {
  const id = args.p_id ?? null
  const edits = args.p_edits ?? {}
  const editor = args.p_editor ?? null
  if (id === null) return { version: 1, status: 'probe' }
  if (!isObj(edits)) throw bad('保存する内容を読み取れませんでした')
  for (const k of Object.keys(edits)) if (!NOTE_FIELDS.includes(k)) throw bad(`保存できない欄です（${k}）`)
  for (const f of NOTE_FIELDS) {
    if (!has(edits, f)) continue
    const e = edits[f]
    if (!isObj(e) || !has(e, 'value')) throw bad(`欄の値を読み取れませんでした（${f}）`)
    if (f === 'role_tags' && (!Array.isArray(e.value) || e.value.some((t) => typeof t !== 'string'))) {
      throw bad('職種タグを読み取れませんでした')
    }
  }
  if (has(edits, 'body') && (jsonText(edits.body.value) ?? '') === '') throw new PgError('23514', '本文が空です')
  if (has(edits, 'deleted_at') && (jsonText(edits.deleted_at.value) ?? '') === '') throw bad('取り消しの指定を読み取れませんでした')

  const row = db.notes.find((r) => r.id === id) ?? null
  const found = row !== null
  const live = found && row.deleted_at === null
  const write = []
  const settled = []
  const conf = []
  const reason = {}
  for (const f of NOTE_FIELDS) {
    if (!has(edits, f)) continue
    const e = edits[f]
    if (f === 'deleted_at') {
      if (!found) {
        conf.push(f)
        reason[f] = 'missing'
      } else if (!live) settled.push(f)
      else if (has(e, 'base') && (jsonText(e.base) ?? '') !== '' && row.body === jsonText(e.base)) write.push(f)
      else {
        conf.push(f)
        reason[f] = 'changed'
      }
      continue
    }
    const mine = canonNote(f, e.value)
    const base = !has(e, 'base') || e.base === null ? null : canonNote(f, e.base)
    const srv = found ? canonNote(f, row[f] ?? null) : null
    if (!found) {
      conf.push(f)
      reason[f] = 'missing'
    } else if (!live) {
      if (srv === mine) settled.push(f)
      else {
        conf.push(f)
        reason[f] = 'missing'
      }
    } else if (srv === mine) settled.push(f)
    else if ((has(e, 'base') && srv === base) || (!has(e, 'base') && srv === null)) write.push(f)
    else {
      conf.push(f)
      reason[f] = 'changed'
    }
  }
  const before = found ? { ...row, role_tags: [...(row.role_tags ?? [])] } : null
  if (live && write.length > 0) {
    const next = { ...row }
    for (const f of write) next[f] = typed(f, edits[f].value)
    next.edited_by = editor
    checkRow(db, next)
    next.rev = row.rev + 1
    Object.assign(row, next)
    // 0010 のトリガ（内容が変わった時だけ記録）
    db.history.push({ row_id: id, op: before.deleted_at === null && row.deleted_at !== null ? 'delete' : 'update', old_row: before, new_row: { ...row } })
  }
  const conflicts = conf.map((f) => ({
    field: f,
    server: !found ? null : f === 'deleted_at' ? before.body : (before[f] ?? null),
    base: has(edits[f], 'base') ? edits[f].base : null,
    mine: edits[f].value ?? null,
    reason: reason[f],
  }))
  const status = write.length > 0 && conf.length > 0 ? 'partial' : write.length > 0 ? 'applied' : conf.length > 0 ? 'conflict' : 'noop'
  return {
    version: 1,
    status,
    row: found && row.deleted_at === null ? rowJson(row) : null,
    applied: write,
    settled,
    conflicts,
  }
}

// ── 契約の表（0017 と偽物の両方がこの答えを返すこと） ─────────────────────────
//
// row: 先にある行の上書き（null＝行が無い）。deleted=true は取り消し済みの行
// expect.row: 返り値の row の一部（null＝row が null）
// expect.after: 後の状態 { revDelta, history, deleted, editedBy, body }

const BASE_ROW = {
  note_on: '2026-11-01',
  shift: 'day',
  resident_id: 1,
  body: '本文O',
  importance: 'normal',
  color: null,
  after16: false,
  occurred_at: null,
  reporter_id: 1,
  role_tags: [],
  ongoing: false,
  ended_at: null,
  ended_by: null,
}
export { BASE_ROW as NOTE_BASE_ROW }

export const NOTE_CONTRACT_CASES = [
  {
    name: '基準のまま → 書く（applied）・edited_by と rev・記録',
    row: {},
    edits: { body: { value: '本文A', base: '本文O' } },
    editor: 2,
    expect: {
      status: 'applied',
      applied: ['body'],
      settled: [],
      conflicts: [],
      row: { body: '本文A' },
      after: { revDelta: 1, history: 1, deleted: false, editedBy: 2, body: '本文A' },
    },
  },
  {
    name: 'いまの値＝あなたの値 → settled（rev を進めない）',
    row: { body: '本文A' },
    edits: { body: { value: '本文A', base: '本文O' } },
    editor: 2,
    expect: { status: 'noop', applied: [], settled: ['body'], conflicts: [], row: { body: '本文A' }, after: { revDelta: 0, history: 0 } },
  },
  {
    name: '他の端末が先に本文を変えた → conflict（changed）・本文は先のまま',
    row: { body: '本文X' },
    edits: { body: { value: '本文B', base: '本文O' } },
    editor: 2,
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [{ field: 'body', reason: 'changed', server: '本文X' }],
      row: { body: '本文X' },
      after: { revDelta: 0, history: 0, body: '本文X' },
    },
  },
  {
    name: '色だけの変更は、本文を他の端末が変えていても通る',
    row: { body: '本文X' },
    edits: { color: { value: 'pink', base: null } },
    editor: 1,
    expect: { status: 'applied', applied: ['color'], settled: [], conflicts: [], row: { color: 'pink', body: '本文X' }, after: { revDelta: 1, history: 1 } },
  },
  {
    name: '1欄は書けて1欄は競合 → partial',
    row: { body: '本文X' },
    edits: { body: { value: '本文B', base: '本文O' }, importance: { value: 'important', base: 'normal' } },
    editor: 1,
    expect: {
      status: 'partial',
      applied: ['importance'],
      settled: [],
      conflicts: [{ field: 'body', reason: 'changed', server: '本文X' }],
      row: { importance: 'important', body: '本文X' },
      after: { revDelta: 1, history: 1 },
    },
  },
  {
    name: '取り消し: 見た本文のまま → 取り消す（row は null）',
    row: {},
    edits: { deleted_at: { value: '2026-11-01T01:00:00Z', base: '本文O' } },
    editor: 1,
    expect: { status: 'applied', applied: ['deleted_at'], settled: [], conflicts: [], row: null, after: { revDelta: 1, history: 1, deleted: true } },
  },
  {
    name: '取り消し: 見ていない本文 → 競合（server はいまの本文）・消さない',
    row: { body: '本文X' },
    edits: { deleted_at: { value: '2026-11-01T01:00:00Z', base: '本文O' } },
    editor: 1,
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [{ field: 'deleted_at', reason: 'changed', server: '本文X' }],
      row: { body: '本文X' },
      after: { revDelta: 0, history: 0, deleted: false },
    },
  },
  {
    name: '取り消し: 基準（見た本文）が無い → 競合',
    row: {},
    edits: { deleted_at: { value: '2026-11-01T01:00:00Z' } },
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [{ field: 'deleted_at', reason: 'changed', server: '本文O' }],
      row: { body: '本文O' },
      after: { revDelta: 0, deleted: false },
    },
  },
  {
    name: '取り消し: もう取り消されている → settled',
    row: {},
    deleted: true,
    edits: { deleted_at: { value: '2026-11-01T01:00:00Z', base: '本文O' } },
    expect: { status: 'noop', applied: [], settled: ['deleted_at'], conflicts: [], row: null, after: { revDelta: 0, history: 0 } },
  },
  {
    name: '取り消された行への別の本文 → missing（書かない・復活させない）',
    row: {},
    deleted: true,
    edits: { body: { value: '本文B', base: '本文O' } },
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [{ field: 'body', reason: 'missing', server: '本文O' }],
      row: null,
      after: { revDelta: 0, history: 0, deleted: true },
    },
  },
  {
    name: '取り消された行へ、届いていた同じ本文 → settled',
    row: { body: '本文A' },
    deleted: true,
    edits: { body: { value: '本文A', base: '本文O' } },
    expect: { status: 'noop', applied: [], settled: ['body'], conflicts: [], row: null, after: { revDelta: 0 } },
  },
  {
    name: '行が無い → missing',
    row: null,
    edits: { body: { value: '本文B', base: '本文O' }, color: { value: 'blue', base: null } },
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [
        { field: 'body', reason: 'missing', server: null },
        { field: 'color', reason: 'missing', server: null },
      ],
      row: null,
      after: {},
    },
  },
  {
    name: '基準が分からない欄: 空の欄は書く・本文（空でない）は競合',
    row: {},
    edits: { color: { value: 'blue' }, body: { value: '本文B' } },
    editor: 1,
    expect: {
      status: 'partial',
      applied: ['color'],
      settled: [],
      conflicts: [{ field: 'body', reason: 'changed', server: '本文O' }],
      row: { color: 'blue', body: '本文O' },
      after: { revDelta: 1 },
    },
  },
  {
    name: '対象・記入者・時刻・区切り・職種タグ・継続（型をそろえて比べる）',
    row: { occurred_at: '09:00:00' },
    edits: {
      resident_id: { value: 2, base: 1 },
      reporter_id: { value: 2, base: 1 },
      occurred_at: { value: '9:00', base: null },
      after16: { value: true, base: false },
      role_tags: { value: ['看護', '介護'], base: [] },
      ongoing: { value: true, base: false },
    },
    editor: 2,
    expect: {
      status: 'applied',
      applied: ['resident_id', 'after16', 'reporter_id', 'role_tags', 'ongoing'],
      settled: ['occurred_at'],
      conflicts: [],
      row: { resident_id: 2, reporter_id: 2, after16: true, ongoing: true, role_tags: ['看護', '介護'] },
      after: { revDelta: 1, history: 1 },
    },
  },
  {
    name: '継続の終了（ended_at・ended_by）',
    row: { ongoing: true },
    edits: { ended_at: { value: '2026-11-02T03:00:00Z', base: null }, ended_by: { value: 1, base: null } },
    editor: 1,
    expect: { status: 'applied', applied: ['ended_at', 'ended_by'], settled: [], conflicts: [], row: { ongoing: true }, after: { revDelta: 1, history: 1 } },
  },
  {
    name: '全体連絡（resident_id null）も同じ',
    row: { resident_id: null },
    edits: { body: { value: '本文A', base: '本文O' } },
    expect: { status: 'applied', applied: ['body'], settled: [], conflicts: [], row: { resident_id: null, body: '本文A' }, after: { revDelta: 1 } },
  },
  {
    name: '本文を空にする → 拒否（23514）・何も書かない',
    row: {},
    edits: { body: { value: '', base: '本文O' } },
    expect: { error: '23514', after: { revDelta: 0, history: 0 } },
  },
  {
    name: '未知の欄 → 拒否（22023）',
    row: {},
    edits: { rev: { value: 9 } },
    expect: { error: '22023', after: { revDelta: 0 } },
  },
  {
    name: '範囲外の色 → 拒否（23514）',
    row: {},
    edits: { color: { value: 'purple', base: null } },
    expect: { error: '23514', after: { revDelta: 0 } },
  },
  {
    name: '配列でない職種タグ → 拒否（22023）',
    row: {},
    edits: { role_tags: { value: '看護', base: [] } },
    expect: { error: '22023', after: { revDelta: 0 } },
  },
  {
    name: '何も書かない呼び出し（p_edits={}）→ noop で行を返す（読み直しに使う）',
    row: { body: '本文Z' },
    edits: {},
    expect: { status: 'noop', applied: [], settled: [], conflicts: [], row: { body: '本文Z' }, after: { revDelta: 0 } },
  },
]

/** 値の突き合わせ（数値と数字の文字列は同じ・時刻の表記ゆれは吸収・それ以外は JSON 表記で比べる） */
function sameJsonValue(a, b) {
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

export function checkNoteContract(c, result, after) {
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
    if (JSON.stringify(r.applied) !== JSON.stringify(e.applied)) out.push(`applied ${JSON.stringify(r.applied)} != ${JSON.stringify(e.applied)}`)
    if (JSON.stringify(r.settled) !== JSON.stringify(e.settled)) out.push(`settled ${JSON.stringify(r.settled)} != ${JSON.stringify(e.settled)}`)
    const got = (r.conflicts ?? []).map((x) => [x.field, x.reason, x.server])
    const want = e.conflicts.map((x) => [x.field, x.reason, x.server])
    if (got.length !== want.length || got.some((g, i) => g[0] !== want[i][0] || g[1] !== want[i][1] || !sameJsonValue(g[2], want[i][2]))) {
      out.push(`conflicts ${JSON.stringify(got)} != ${JSON.stringify(want)}`)
    }
    if (e.row === null) {
      if (r.row !== null) out.push(`row should be null: ${JSON.stringify(r.row)}`)
    } else if (e.row !== undefined) {
      if (r.row === null) out.push('row is null')
      else for (const [k, v] of Object.entries(e.row)) if (!sameJsonValue(r.row[k], v)) out.push(`row.${k} ${JSON.stringify(r.row[k])} != ${JSON.stringify(v)}`)
    }
  }
  for (const [k, v] of Object.entries(e.after ?? {})) {
    if (after[k] === undefined && v === undefined) continue
    if (!sameJsonValue(after[k], v)) out.push(`after.${k} ${JSON.stringify(after[k])} != ${JSON.stringify(v)}`)
  }
  return out
}

/** 契約の1件を偽物で流す（npm test 用） */
export function runNoteContractCaseOnFake(c) {
  const db = createNoteDb()
  let prev = null
  if (c.row !== null) {
    const row = { ...BASE_ROW, ...c.row, id: 101, rev: 1, edited_by: null, deleted_at: c.deleted ? '2026-11-01T00:00:00.000Z' : null }
    if (row.occurred_at !== null) row.occurred_at = canonNote('occurred_at', row.occurred_at)
    db.notes.push(row)
    prev = row
  }
  const revBefore = prev?.rev ?? null
  let result
  try {
    result = { ok: fakeApplyNoteEdits(db, { p_id: 101, p_edits: c.edits, p_editor: c.editor ?? null }) }
  } catch (err) {
    if (!(err instanceof PgError)) throw err
    result = { error: err.code }
  }
  const after = {
    revDelta: prev === null ? undefined : prev.rev - revBefore,
    history: db.history.length,
    deleted: prev === null ? undefined : prev.deleted_at !== null,
    editedBy: prev === null ? undefined : prev.edited_by,
    body: prev === null ? undefined : prev.body,
  }
  return { result, after, mismatches: checkNoteContract(c, result, after) }
}
