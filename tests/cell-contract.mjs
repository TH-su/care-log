// 欄ごとの compare-and-set（supabase/migrations/0011_apply_cell_edits.sql）の契約。
//
// ・fakeApplyCellEdits … 0011 の判定規則を JS で写した偽物（tests/logic.test.mjs の偽クライアントが使う）
// ・CELL_CONTRACT_CASES … 同じ入力に対して 0011 と偽物が同じ答えを返すことを押さえる表。
//     npm test は偽物で、素の Postgres（0001〜0011 適用済み）では別の実行器で同じ表を流し、
//     どちらも expect と一致することを確かめる（規則の食い違いをここで捕まえる）。
// ・checkContract … 結果と後の状態を expect と突き合わせ、食い違いの一覧を返す（空なら一致）
//
// 個人情報は置かない（利用者・職員は数値IDのみ。本文は記号だけ）。

export class PgError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const VITAL_FIELDS = ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2', 'measured_at', 'note', 'symptom']
const MEAL_FIELDS = ['main_amount', 'side_amount', 'status', 'note']
const TEXT_FIELDS = new Set(['note', 'symptom', 'status'])
const KEYLESS_KINDS = ['recheck', 'observation', 'symptom']
const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack']
const MEAL_STATUSES = ['eaten', 'out', 'hospital', 'refused']
/** 0001 の check 制約 */
const CHECKS = {
  temp: [30, 45],
  sys_bp: [40, 300],
  dia_bp: [20, 200],
  pulse: [20, 250],
  spo2: [50, 100],
  main_amount: [0, 10],
  side_amount: [0, 10],
}
const VITAL_ROW = ['id', 'resident_id', 'measured_on', 'kind', 'measured_at', 'temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2', 'note', 'symptom', 'recorded_by', 'rev']
const MEAL_ROW = ['id', 'resident_id', 'meal_on', 'meal_slot', 'main_amount', 'side_amount', 'status', 'note', 'recorded_by', 'rev']

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

/** jsonb の ->> の写し（null は null、文字列はそのまま、それ以外は JSON 表記） */
function jsonText(v) {
  if (v === null || v === undefined) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

function roundHalfAway(n, d) {
  const s = Number(`${Math.abs(n)}e${d}`)
  return Math.sign(n) * Number(`${Math.round(s)}e-${d}`)
}

/** (nullif(x, '')::列の型)::text の写し（列の型にそろえた比較用の文字列） */
export function canonCell(field, text) {
  if (text === null || text === '') return null
  if (TEXT_FIELDS.has(field)) return text
  if (field === 'measured_at') {
    const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*$/.exec(text)
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || (m[3] !== undefined && Number(m[3]) > 59)) {
      throw new PgError('22007', `invalid input syntax for type time: "${text}"`)
    }
    return `${m[1].padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}`
  }
  if (field === 'temp') {
    if (!/^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(text)) {
      throw new PgError('22P02', `invalid input syntax for type numeric: "${text}"`)
    }
    const r = roundHalfAway(Number(text), 1)
    if (Math.abs(r) >= 100) throw new PgError('22003', 'numeric field overflow')
    return r.toFixed(1)
  }
  if (!/^\s*[+-]?\d+\s*$/.test(text)) throw new PgError('22P02', `invalid input syntax for type smallint: "${text}"`)
  const n = Number(text)
  if (n < -32768 || n > 32767) throw new PgError('22003', 'value out of range for type smallint')
  return String(n)
}

/** 比較用の文字列 → 行に入れる値（数値の列は数値、時刻・文字はそのまま） */
function typed(field, canon) {
  if (canon === null) return null
  return TEXT_FIELDS.has(field) || field === 'measured_at' ? canon : Number(canon)
}

function checkValue(table, field, v) {
  const c = CHECKS[field]
  if (c !== undefined && v !== null && (v < c[0] || v > c[1])) {
    throw new PgError('23514', `new row for relation "${table}" violates check constraint "${table}_${field}_check"`)
  }
  if (field === 'status' && v !== null && !MEAL_STATUSES.includes(v)) {
    throw new PgError('23514', `new row for relation "${table}" violates check constraint "meals_status_check"`)
  }
}

function bigintOf(v, what) {
  const t = jsonText(v)
  if (t === null) return null
  if (!/^\s*[+-]?\d+\s*$/.test(t)) throw new PgError('22P02', `invalid input syntax for type bigint: "${t}"`)
  return Number(t)
}

function dateOf(v) {
  const t = jsonText(v)
  if (t === null) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new PgError('22007', `invalid input syntax for type date: "${t}"`)
  return t
}

const bad = (msg) => new PgError('22023', msg)

/** 偽のデータベース（2表と変更の記録・職員の id）。行は数値IDと数値・記号だけ */
export function createCellDb() {
  return { vitals: [], meals: [], history: [], nextId: 1, staff: new Set([1, 2]) }
}

/** edited_by・recorded_by の外部キー（staff(id)）。書く時だけ確かめる（0001・0010 の references） */
function checkStaff(db, table, row) {
  for (const k of ['edited_by', 'recorded_by']) {
    const v = row[k]
    if (v !== null && v !== undefined && !db.staff.has(v)) {
      throw new PgError('23503', `insert or update on table "${table}" violates foreign key constraint "${table}_${k}_fkey"`)
    }
  }
}

/** 行を jsonb にした時の写し（返り値の row） */
function rowJson(table, row) {
  const out = {}
  for (const k of table === 'vitals' ? VITAL_ROW : MEAL_ROW) out[k] = row[k] ?? null
  return out
}

/** 0011 apply_cell_edits の写し。例外は PgError（code は Postgres の SQLSTATE） */
export function fakeApplyCellEdits(db, args) {
  const { p_table, p_key } = args
  const edits = args.p_edits ?? {}
  const fill = args.p_fill ?? {}
  const editor = args.p_editor ?? null
  const clientKeyArg = args.p_client_key ?? null
  if (p_table === 'probe') return { version: 1, status: 'probe' }
  let fields
  let fillOk
  if (p_table === 'vitals') {
    fields = VITAL_FIELDS
    fillOk = ['measured_at', 'recorded_by']
  } else if (p_table === 'meals') {
    fields = MEAL_FIELDS
    fillOk = ['recorded_by']
  } else throw bad(`保存先を読み取れませんでした（${p_table}）`)
  if (!isObj(p_key) || !isObj(edits) || !isObj(fill)) throw bad('保存する内容を読み取れませんでした')
  for (const k of Object.keys(edits)) if (!fields.includes(k)) throw bad(`保存できない欄です（${k}）`)
  for (const k of Object.keys(fill)) if (!fillOk.includes(k)) throw bad(`保存できない付随の欄です（${k}）`)
  let anyValue = false
  let anyBase = false
  for (const f of fields) {
    if (!has(edits, f)) continue
    const e = edits[f]
    if (!isObj(e) || !has(e, 'value')) throw bad(`欄の値を読み取れませんでした（${f}）`)
    const vt = jsonText(e.value)
    const bt = has(e, 'base') ? jsonText(e.base) : null
    if (vt !== null && vt !== '') anyValue = true
    if (bt !== null && bt !== '') anyBase = true
  }
  if (has(p_key, 'client_key') && clientKeyArg !== null && jsonText(p_key.client_key) !== clientKeyArg) {
    throw bad('冪等キーが食い違っています')
  }
  const rows = db[p_table]
  const fillTime = has(fill, 'measured_at') ? typed('measured_at', canonCell('measured_at', jsonText(fill.measured_at))) : null
  const fillBy = has(fill, 'recorded_by') ? bigintOf(fill.recorded_by) : null
  const editVal = (f) => (has(edits, f) ? typed(f, canonCell(f, jsonText(edits[f].value))) : null)
  let row = null
  let found = false
  let gone = false
  let inserted = false
  let byId = false
  const insert = (keyCols) => {
    const r = { id: db.nextId++, ...keyCols, rev: 1, deleted_at: null, edited_by: editor, recorded_by: fillBy }
    if (p_table === 'vitals') {
      for (const f of ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2', 'note', 'symptom']) r[f] = editVal(f)
      r.measured_at = has(edits, 'measured_at') ? editVal('measured_at') : fillTime
    } else {
      for (const f of MEAL_FIELDS) r[f] = editVal(f)
    }
    for (const f of fields) checkValue(p_table, f, r[f])
    checkStaff(db, p_table, r)
    rows.push(r)
    return r
  }
  if (p_table === 'vitals') {
    const ckRaw = has(p_key, 'client_key') ? jsonText(p_key.client_key) : clientKeyArg
    const ck = ckRaw === null || ckRaw === '' ? null : ckRaw
    if (has(p_key, 'id')) {
      byId = true
      const id = bigintOf(p_key.id)
      row = rows.find((r) => r.id === id && r.deleted_at === null) ?? null
      found = row !== null
    } else if (ck !== null) {
      const resident = bigintOf(p_key.resident_id)
      const day = dateOf(p_key.measured_on)
      const kind = jsonText(p_key.kind)
      if (resident === null || day === null || kind === null || !KEYLESS_KINDS.includes(kind)) {
        throw bad('記録の行を特定できませんでした')
      }
      row = rows.find((r) => r.client_key === ck) ?? null
      if (row !== null) {
        if (row.resident_id !== resident || row.measured_on !== day || row.kind !== kind) {
          throw bad('冪等キーが別の記録を指しています')
        }
        found = row.deleted_at === null
        gone = !found
      } else if (!anyBase && anyValue) {
        row = insert({ client_key: ck, resident_id: resident, measured_on: day, kind })
        inserted = found = true
      }
    } else {
      const resident = bigintOf(p_key.resident_id)
      const day = dateOf(p_key.measured_on)
      if (resident === null || day === null) throw bad('記録の行を特定できませんでした')
      row =
        rows.find((r) => r.resident_id === resident && r.measured_on === day && r.kind === 'routine' && r.deleted_at === null) ??
        null
      if (row !== null) found = true
      else if (!anyBase && anyValue) {
        row = insert({ resident_id: resident, measured_on: day, kind: 'routine', client_key: null })
        inserted = found = true
      }
    }
  } else {
    if (has(p_key, 'id') || has(p_key, 'client_key')) throw bad('食事の行は利用者・日付・食事枠で指定してください')
    const resident = bigintOf(p_key.resident_id)
    const day = dateOf(p_key.meal_on)
    const slot = jsonText(p_key.meal_slot)
    if (resident === null || day === null || slot === null || !MEAL_SLOTS.includes(slot)) {
      throw bad('記録の行を特定できませんでした')
    }
    row = rows.find((r) => r.resident_id === resident && r.meal_on === day && r.meal_slot === slot && r.deleted_at === null) ?? null
    if (row !== null) found = true
    else if (!anyBase && anyValue) {
      row = insert({ resident_id: resident, meal_on: day, meal_slot: slot })
      inserted = found = true
    }
  }
  if (!found && !gone && !byId && !anyBase && anyValue) throw new PgError('40001', '他の端末と同時に保存したため、もう一度送ります')
  const missing = !found && !gone && (anyBase || byId)
  const cur = found || gone ? { ...row } : null

  let write = []
  let settled = []
  let conf = []
  const reason = {}
  for (const f of fields) {
    if (!has(edits, f)) continue
    const e = edits[f]
    const cMine = canonCell(f, jsonText(e.value))
    const cBase = has(e, 'base') ? canonCell(f, jsonText(e.base)) : null
    const cSrv = cur === null ? null : canonCell(f, jsonText(cur[f] ?? null))
    if (inserted) {
      if (cMine === null) settled.push(f)
      else write.push(f)
    } else if (missing) {
      conf.push(f)
      reason[f] = 'missing'
    } else if (gone) {
      if (!anyBase && cSrv === cMine) settled.push(f)
      else {
        conf.push(f)
        reason[f] = 'missing'
      }
    } else if (!found) {
      settled.push(f)
    } else if (cSrv === cMine) {
      settled.push(f)
    } else if ((has(e, 'base') && cSrv === cBase) || (!has(e, 'base') && cSrv === null)) {
      write.push(f)
    } else {
      conf.push(f)
      reason[f] = 'changed'
    }
  }
  // 血圧の上と下は1つの組: 片方が競合なら、送られてきた相方も書かず・「載っている」ともせずに競合へ（第3段 #3。
  // 相方が settled で外れると、後の〔自分の値で直す〕が片方だけを送り、誰も測っていない組ができる）
  for (const [f, o] of [['sys_bp', 'dia_bp'], ['dia_bp', 'sys_bp']]) {
    if (!conf.includes(f) || conf.includes(o) || !has(edits, o)) continue
    write = write.filter((x) => x !== o)
    settled = settled.filter((x) => x !== o)
    conf.push(o)
    reason[o] = reason[f]
  }
  if (!inserted && found && write.length > 0) {
    // 例外（check・外部キー）なら何も変えない（Postgres はトランザクションごと戻す）
    const before = { ...row }
    const next = { ...row }
    for (const f of write) next[f] = editVal(f)
    if (p_table === 'vitals' && !write.includes('measured_at') && !has(edits, 'measured_at')) {
      next.measured_at = next.measured_at ?? fillTime
    }
    next.recorded_by = next.recorded_by ?? fillBy
    next.edited_by = editor
    for (const f of fields) checkValue(p_table, f, next[f])
    checkStaff(db, p_table, next)
    Object.assign(row, next)
    row.rev = before.rev + 1
    const strip = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !['rev', 'updated_at', 'edited_by'].includes(k)).sort()))
    if (strip(before) !== strip(row)) {
      db.history.push({
        table_name: p_table,
        row_id: row.id,
        op: before.deleted_at === null && row.deleted_at !== null ? 'delete' : 'update',
        rev_before: before.rev,
        rev_after: row.rev,
        changed_by_staff: editor,
      })
    }
  }
  conf = fields.filter((f) => conf.includes(f))
  const conflicts = conf.map((f) => ({
    field: f,
    server: found && cur !== null ? (cur[f] ?? null) : null,
    base: has(edits[f], 'base') ? edits[f].base : null,
    mine: edits[f].value,
    reason: reason[f],
  }))
  const status = write.length > 0 && conf.length > 0 ? 'partial' : write.length > 0 ? 'applied' : conf.length > 0 ? 'conflict' : 'noop'
  return {
    version: 1,
    status,
    row: found ? rowJson(p_table, row) : null,
    applied: fields.filter((f) => write.includes(f)),
    settled: fields.filter((f) => settled.includes(f)),
    conflicts,
  }
}

// ── 契約の表（0011 と偽物の両方がこの答えを返すこと） ─────────────────────────
//
// key: routine（利用者・日付）／client（冪等キー）／id（行 id）／meal（利用者・日付・食事枠）
// row: 先にある行（null＝行が無い）。deleted=true は取り消し済みの行
// expect.row: 返り値の row の一部（null＝row が null）
// expect.after: 後の状態 { revDelta（先の行の rev の増分）, history（増えた変更の記録）, liveRows（生きている行の数）, editedBy }

export const CELL_CONTRACT_CASES = [
  {
    name: '行が無い・基準が空 → insert（値の無い欄は書かない＝settled）',
    table: 'vitals',
    key: 'routine',
    row: null,
    edits: { temp: { value: 36.5, base: null }, pulse: { value: null, base: null } },
    fill: { measured_at: '09:00', recorded_by: 1 },
    editor: 1,
    expect: {
      status: 'applied',
      applied: ['temp'],
      settled: ['pulse'],
      conflicts: [],
      row: { temp: 36.5, pulse: null, measured_at: '09:00:00', recorded_by: 1, rev: 1 },
      after: { history: 0, liveRows: 1, editedBy: 1 },
    },
  },
  {
    name: '空いている欄（基準＝空のまま）は書く・fill は空いている時だけ埋める',
    table: 'vitals',
    key: 'routine',
    row: { temp: 36.5, pulse: null, measured_at: null, recorded_by: null },
    edits: { pulse: { value: 72, base: null } },
    fill: { measured_at: '08:30', recorded_by: 2 },
    editor: 2,
    expect: {
      status: 'applied',
      applied: ['pulse'],
      settled: [],
      conflicts: [],
      row: { temp: 36.5, pulse: 72, measured_at: '08:30:00', recorded_by: 2 },
      after: { revDelta: 1, history: 1, liveRows: 1, editedBy: 2 },
    },
  },
  {
    name: 'いまの値＝あなたの値 → settled（書かない・rev も進まない・fill も当てない）',
    table: 'vitals',
    key: 'routine',
    row: { temp: 36.5, measured_at: null, recorded_by: null },
    edits: { temp: { value: 36.5, base: null } },
    fill: { measured_at: '07:07', recorded_by: 2 },
    editor: 2,
    expect: {
      status: 'noop',
      applied: [],
      settled: ['temp'],
      conflicts: [],
      row: { temp: 36.5, measured_at: null, recorded_by: null },
      after: { revDelta: 0, history: 0, liveRows: 1, editedBy: null },
    },
  },
  {
    name: '他の端末が先に書いた（基準と食い違う）→ conflict（changed）',
    table: 'vitals',
    key: 'routine',
    row: { temp: 36.8 },
    edits: { temp: { value: 37.2, base: null } },
    editor: 2,
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [{ field: 'temp', reason: 'changed', server: 36.8 }],
      row: { temp: 36.8 },
      after: { revDelta: 0, history: 0, liveRows: 1 },
    },
  },
  {
    name: '1欄は書けて1欄は競合 → partial',
    table: 'vitals',
    key: 'routine',
    row: { temp: 36.5, pulse: null },
    edits: { temp: { value: 37.0, base: null }, pulse: { value: 72, base: null } },
    editor: 2,
    expect: {
      status: 'partial',
      applied: ['pulse'],
      settled: [],
      conflicts: [{ field: 'temp', reason: 'changed', server: 36.5 }],
      row: { temp: 36.5, pulse: 72 },
      after: { revDelta: 1, history: 1, liveRows: 1, editedBy: 2 },
    },
  },
  {
    name: '基準のまま（他の端末が触っていない）→ 書く',
    table: 'vitals',
    key: 'routine',
    row: { pulse: 70 },
    edits: { pulse: { value: 75, base: 70 } },
    editor: 1,
    expect: {
      status: 'applied',
      applied: ['pulse'],
      settled: [],
      conflicts: [],
      row: { pulse: 75 },
      after: { revDelta: 1, history: 1, liveRows: 1, editedBy: 1 },
    },
  },
  {
    name: '基準が分からない欄（base キー無し）は、いまが空の時だけ書く',
    table: 'vitals',
    key: 'routine',
    row: { temp: 36.5, spo2: null },
    edits: { spo2: { value: 95 }, temp: { value: 38.0 } },
    editor: 2,
    expect: {
      status: 'partial',
      applied: ['spo2'],
      settled: [],
      conflicts: [{ field: 'temp', reason: 'changed', server: 36.5 }],
      row: { temp: 36.5, spo2: 95 },
      after: { revDelta: 1, history: 1, liveRows: 1 },
    },
  },
  {
    name: '取り消された行へ基準つきで送る → 全欄 missing（作り直さない）',
    table: 'vitals',
    key: 'routine',
    row: { temp: 36.6 },
    deleted: true,
    edits: { temp: { value: 37.0, base: 36.6 }, pulse: { value: 80, base: null } },
    editor: 2,
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [
        { field: 'temp', reason: 'missing', server: null },
        { field: 'pulse', reason: 'missing', server: null },
      ],
      row: null,
      after: { revDelta: 0, history: 0, liveRows: 0 },
    },
  },
  {
    name: '行が無いのに基準がある → missing（insert しない）',
    table: 'vitals',
    key: 'routine',
    row: null,
    edits: { temp: { value: 36.9, base: 36.1 } },
    editor: 2,
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [{ field: 'temp', reason: 'missing', server: null }],
      row: null,
      after: { history: 0, liveRows: 0 },
    },
  },
  {
    name: '血圧の組: 上だけ他の端末が変えた → 下も書かずに組ごと競合',
    table: 'vitals',
    key: 'routine',
    row: { sys_bp: 125, dia_bp: 80 },
    edits: { sys_bp: { value: 130, base: 120 }, dia_bp: { value: 85, base: 80 } },
    editor: 2,
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [
        { field: 'sys_bp', reason: 'changed', server: 125 },
        { field: 'dia_bp', reason: 'changed', server: 80 },
      ],
      row: { sys_bp: 125, dia_bp: 80 },
      after: { revDelta: 0, history: 0, liveRows: 1 },
    },
  },
  {
    name: '血圧の組（F4）: 相方を「値＝基準」で送り、相方が動いていなければ上だけ書く',
    table: 'vitals',
    key: 'routine',
    row: { sys_bp: 120, dia_bp: 80 },
    edits: { sys_bp: { value: 130, base: 120 }, dia_bp: { value: 80, base: 80 } },
    editor: 2,
    expect: {
      status: 'applied',
      applied: ['sys_bp'],
      settled: ['dia_bp'],
      conflicts: [],
      row: { sys_bp: 130, dia_bp: 80 },
      after: { revDelta: 1, history: 1, liveRows: 1 },
    },
  },
  {
    name: '血圧の組（F4）: 相方を他の端末が変えていた → 上も書かない（組ごと競合）',
    table: 'vitals',
    key: 'routine',
    row: { sys_bp: 120, dia_bp: 85 },
    edits: { sys_bp: { value: 130, base: 120 }, dia_bp: { value: 80, base: 80 } },
    editor: 2,
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [
        { field: 'sys_bp', reason: 'changed', server: 120 },
        { field: 'dia_bp', reason: 'changed', server: 85 },
      ],
      row: { sys_bp: 120, dia_bp: 85 },
      after: { revDelta: 0, history: 0, liveRows: 1 },
    },
  },
  {
    name: '血圧の組（第3段 #3）: 上が食い違い・下はもう同じ値 → 下も「載っている」にせず組ごと競合',
    table: 'vitals',
    key: 'routine',
    row: { sys_bp: 125, dia_bp: 90 },
    edits: { sys_bp: { value: 130, base: 120 }, dia_bp: { value: 90, base: 80 } },
    editor: 2,
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [
        { field: 'sys_bp', reason: 'changed', server: 125 },
        { field: 'dia_bp', reason: 'changed', server: 90 },
      ],
      row: { sys_bp: 125, dia_bp: 90 },
      after: { revDelta: 0, history: 0, liveRows: 1 },
    },
  },
  {
    name: '血圧の組（第3段 #3）: 下が食い違い・上はもう同じ値 → 上も「載っている」にせず組ごと競合',
    table: 'vitals',
    key: 'routine',
    row: { sys_bp: 130, dia_bp: 85 },
    edits: { sys_bp: { value: 130, base: 120 }, dia_bp: { value: 90, base: 80 } },
    editor: 2,
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [
        { field: 'sys_bp', reason: 'changed', server: 130 },
        { field: 'dia_bp', reason: 'changed', server: 85 },
      ],
      row: { sys_bp: 130, dia_bp: 85 },
      after: { revDelta: 0, history: 0, liveRows: 1 },
    },
  },
  {
    name: '血圧の組（第3段 #3）: 上下とももう同じ値 → どちらも「載っている」（行に触れない）',
    table: 'vitals',
    key: 'routine',
    row: { sys_bp: 130, dia_bp: 90 },
    edits: { sys_bp: { value: 130, base: 120 }, dia_bp: { value: 90, base: 80 } },
    editor: 2,
    expect: {
      status: 'noop',
      applied: [],
      settled: ['sys_bp', 'dia_bp'],
      conflicts: [],
      row: { sys_bp: 130, dia_bp: 90 },
      after: { revDelta: 0, history: 0, liveRows: 1 },
    },
  },
  {
    name: '血圧の組（第3段 #3）: 相方を送らない編集（上だけ）→ 競合は上だけ（送っていない相方は加えない）',
    table: 'vitals',
    key: 'routine',
    row: { sys_bp: 125, dia_bp: 80 },
    edits: { sys_bp: { value: 130, base: 120 } },
    editor: 2,
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [{ field: 'sys_bp', reason: 'changed', server: 125 }],
      row: { sys_bp: 125, dia_bp: 80 },
      after: { revDelta: 0, history: 0, liveRows: 1 },
    },
  },
  {
    name: '血圧の組（第3段 #3）: 上が食い違い・下と体温は書ける → 体温だけ書く（部分）・血圧は組ごと競合',
    table: 'vitals',
    key: 'routine',
    row: { temp: 36.5, sys_bp: 125, dia_bp: 80 },
    edits: { temp: { value: 37.0, base: 36.5 }, sys_bp: { value: 130, base: 120 }, dia_bp: { value: 85, base: 80 } },
    editor: 2,
    expect: {
      status: 'partial',
      applied: ['temp'],
      settled: [],
      conflicts: [
        { field: 'sys_bp', reason: 'changed', server: 125 },
        { field: 'dia_bp', reason: 'changed', server: 80 },
      ],
      row: { temp: 37.0, sys_bp: 125, dia_bp: 80 },
      after: { revDelta: 1, history: 1, liveRows: 1 },
    },
  },
  {
    name: '文字の欄は文字列として比べる（"07" と "7" は別の記録）',
    table: 'meals',
    key: 'meal',
    row: { note: '7' },
    edits: { note: { value: '07', base: null } },
    editor: 2,
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [{ field: 'note', reason: 'changed', server: '7' }],
      row: { note: '7' },
      after: { revDelta: 0, history: 0, liveRows: 1 },
    },
  },
  {
    name: '時刻は時刻として比べる（9:05 と 09:05:00 は同じ）',
    table: 'vitals',
    key: 'routine',
    row: { measured_at: '09:05' },
    edits: { measured_at: { value: '9:05', base: null } },
    editor: 2,
    expect: {
      status: 'noop',
      applied: [],
      settled: ['measured_at'],
      conflicts: [],
      row: { measured_at: '09:05:00' },
      after: { revDelta: 0, history: 0, liveRows: 1 },
    },
  },
  {
    name: '体温は numeric(3,1) にそろえて比べる（36.55 は 36.6 と同じ）',
    table: 'vitals',
    key: 'routine',
    row: { temp: 36.6 },
    edits: { temp: { value: 36.55, base: null } },
    editor: 2,
    expect: {
      status: 'noop',
      applied: [],
      settled: ['temp'],
      conflicts: [],
      row: { temp: 36.6 },
      after: { revDelta: 0, history: 0, liveRows: 1 },
    },
  },
  {
    name: '冪等キーの新しい行（再検）→ insert（測定時刻は欄として書く）',
    table: 'vitals',
    key: 'client',
    kind: 'recheck',
    row: null,
    edits: { temp: { value: 37.9, base: null }, measured_at: { value: '10:00', base: null } },
    fill: { recorded_by: 1 },
    editor: 1,
    expect: {
      status: 'applied',
      applied: ['temp', 'measured_at'],
      settled: [],
      conflicts: [],
      row: { temp: 37.9, measured_at: '10:00:00', kind: 'recheck', recorded_by: 1, rev: 1 },
      after: { history: 0, liveRows: 1, editedBy: 1 },
    },
  },
  {
    name: '冪等キーの二重送信（もう届いている）→ settled・1行のまま',
    table: 'vitals',
    key: 'client',
    kind: 'recheck',
    row: { temp: 37.9 },
    edits: { temp: { value: 37.9, base: null } },
    editor: 1,
    expect: {
      status: 'noop',
      applied: [],
      settled: ['temp'],
      conflicts: [],
      row: { temp: 37.9, kind: 'recheck' },
      after: { revDelta: 0, history: 0, liveRows: 1 },
    },
  },
  {
    name: '冪等キーの行が届いた後に取り消されていた・同じ値 → settled（作り直さない）',
    table: 'vitals',
    key: 'client',
    kind: 'recheck',
    row: { temp: 37.9 },
    deleted: true,
    edits: { temp: { value: 37.9, base: null } },
    editor: 1,
    expect: {
      status: 'noop',
      applied: [],
      settled: ['temp'],
      conflicts: [],
      row: null,
      after: { revDelta: 0, history: 0, liveRows: 0 },
    },
  },
  {
    name: '冪等キーの行が取り消されていた・違う値 → missing',
    table: 'vitals',
    key: 'client',
    kind: 'recheck',
    row: { temp: 37.9 },
    deleted: true,
    edits: { temp: { value: 38.4, base: null } },
    editor: 1,
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [{ field: 'temp', reason: 'missing', server: null }],
      row: null,
      after: { revDelta: 0, history: 0, liveRows: 0 },
    },
  },
  {
    name: '行 id で指した行が取り消されていた → missing（作らない）',
    table: 'vitals',
    key: 'id',
    kind: 'observation',
    row: { pulse: 70 },
    deleted: true,
    edits: { pulse: { value: 88 } },
    editor: 2,
    expect: {
      status: 'conflict',
      applied: [],
      settled: [],
      conflicts: [{ field: 'pulse', reason: 'missing', server: null }],
      row: null,
      after: { revDelta: 0, history: 0, liveRows: 0 },
    },
  },
  {
    name: '食事の insert（状態は文字・空文字の note は書かない）',
    table: 'meals',
    key: 'meal',
    row: null,
    edits: {
      main_amount: { value: 8, base: null },
      status: { value: 'eaten', base: null },
      note: { value: '', base: null },
    },
    fill: { recorded_by: 1 },
    editor: 1,
    expect: {
      status: 'applied',
      applied: ['main_amount', 'status'],
      settled: ['note'],
      conflicts: [],
      row: { main_amount: 8, status: 'eaten', note: null, recorded_by: 1, rev: 1 },
      after: { history: 0, liveRows: 1, editedBy: 1 },
    },
  },
  {
    name: '食事: 主食は他の端末が先に入れていた・副食は空き → partial',
    table: 'meals',
    key: 'meal',
    row: { main_amount: 8, side_amount: null },
    edits: { main_amount: { value: 5, base: null }, side_amount: { value: 6, base: null } },
    editor: 2,
    expect: {
      status: 'partial',
      applied: ['side_amount'],
      settled: [],
      conflicts: [{ field: 'main_amount', reason: 'changed', server: 8 }],
      row: { main_amount: 8, side_amount: 6 },
      after: { revDelta: 1, history: 1, liveRows: 1, editedBy: 2 },
    },
  },
  {
    name: '値の無い編集だけで行も無い → noop（空の行を作らない）',
    table: 'vitals',
    key: 'routine',
    row: null,
    edits: { temp: { value: null, base: null } },
    fill: { measured_at: '09:00' },
    editor: 2,
    expect: { status: 'noop', applied: [], settled: ['temp'], conflicts: [], row: null, after: { history: 0, liveRows: 0 } },
  },
  {
    name: '基準つきで空にする（値 null）→ 書く（空にする）',
    table: 'vitals',
    key: 'routine',
    row: { pulse: 70 },
    edits: { pulse: { value: null, base: 70 } },
    editor: 2,
    expect: {
      status: 'applied',
      applied: ['pulse'],
      settled: [],
      conflicts: [],
      row: { pulse: null },
      after: { revDelta: 1, history: 1, liveRows: 1 },
    },
  },
  {
    name: '測定時刻を欄として送って競合した時は、fill で埋めない',
    table: 'vitals',
    key: 'routine',
    row: { measured_at: '08:00', temp: null },
    edits: { measured_at: { value: '09:00', base: '07:00' }, temp: { value: 36.5, base: null } },
    fill: { measured_at: '10:00' },
    editor: 2,
    expect: {
      status: 'partial',
      applied: ['temp'],
      settled: [],
      conflicts: [{ field: 'measured_at', reason: 'changed', server: '08:00:00' }],
      row: { measured_at: '08:00:00', temp: 36.5 },
      after: { revDelta: 1, history: 1, liveRows: 1 },
    },
  },
  {
    name: '送れない欄は拒否（22023）',
    table: 'vitals',
    key: 'routine',
    row: { temp: 36.5 },
    edits: { rev: { value: 9 } },
    expect: { error: '22023', after: { revDelta: 0, history: 0, liveRows: 1 } },
  },
  {
    name: '型にできない値は拒否（22P02）',
    table: 'vitals',
    key: 'routine',
    row: { temp: 36.5 },
    edits: { pulse: { value: 'abc', base: null } },
    expect: { error: '22P02', after: { revDelta: 0, history: 0, liveRows: 1 } },
  },
  {
    name: '名簿に無い職員を edited_by にすると拒否（外部キー 23503）',
    table: 'vitals',
    key: 'routine',
    row: { temp: 36.5, pulse: null },
    edits: { pulse: { value: 72, base: null } },
    editor: 999999,
    expect: { error: '23503', after: { revDelta: 0, history: 0, liveRows: 1 } },
  },
  {
    name: '書く欄が無ければ、名簿に無い職員でも拒否しない（edited_by を書かない）',
    table: 'vitals',
    key: 'routine',
    row: { temp: 36.5 },
    edits: { temp: { value: 36.5, base: null } },
    editor: 999999,
    expect: { status: 'noop', applied: [], settled: ['temp'], conflicts: [], row: { temp: 36.5 }, after: { revDelta: 0, history: 0, liveRows: 1 } },
  },
  {
    name: '範囲外の値は拒否（check 制約 23514）',
    table: 'vitals',
    key: 'routine',
    row: { temp: 36.5 },
    edits: { sys_bp: { value: 999, base: null } },
    expect: { error: '23514', after: { revDelta: 0, history: 0, liveRows: 1 } },
  },
]

/** 値の突き合わせ（数値と数字の文字列は同じ・それ以外は JSON 表記で比べる） */
function sameJsonValue(a, b) {
  if (typeof a === 'number' || typeof b === 'number') {
    const na = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a) : NaN
    const nb = typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' ? Number(b) : NaN
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * 結果と後の状態を expect と突き合わせる。食い違いの説明の配列を返す（空なら一致）。
 * result: { ok: 返り値 } または { error: SQLSTATE }
 * after: { revDelta, history, liveRows, editedBy }（expect にある項目だけ比べる）
 */
export function checkContract(c, result, after) {
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

/** 契約の1件を偽物で流す（npm test 用）。返すのは checkContract の食い違い一覧 */
export function runContractCaseOnFake(c) {
  const db = createCellDb()
  const day = '2026-11-01'
  let prev = null
  if (c.row !== null) {
    const base =
      c.table === 'meals'
        ? { resident_id: 1, meal_on: day, meal_slot: 'lunch', main_amount: null, side_amount: null, status: null, note: null }
        : {
            resident_id: 1,
            measured_on: day,
            kind: c.key === 'routine' ? 'routine' : (c.kind ?? 'recheck'),
            client_key: c.key === 'client' ? 'cc-key' : null,
            measured_at: null,
            temp: null,
            sys_bp: null,
            dia_bp: null,
            pulse: null,
            spo2: null,
            note: null,
            symptom: null,
          }
    const row = { ...base, recorded_by: null, edited_by: null, rev: 1, deleted_at: null, id: db.nextId++ }
    for (const [k, v] of Object.entries(c.row)) row[k] = k === 'measured_at' && v !== null ? canonCell('measured_at', v) : v
    if (c.deleted) row.deleted_at = '2026-11-01T00:00:00Z'
    db[c.table].push(row)
    prev = row
  }
  const key =
    c.key === 'routine'
      ? { resident_id: 1, measured_on: day }
      : c.key === 'client'
        ? { client_key: 'cc-key', resident_id: 1, measured_on: day, kind: c.kind ?? 'recheck' }
        : c.key === 'id'
          ? { id: prev?.id ?? 999 }
          : { resident_id: 1, meal_on: day, meal_slot: 'lunch' }
  const revBefore = prev?.rev ?? null
  let result
  try {
    result = {
      ok: fakeApplyCellEdits(db, {
        p_table: c.table,
        p_key: key,
        p_edits: c.edits,
        p_fill: c.fill ?? {},
        p_editor: c.editor ?? null,
        p_client_key: c.key === 'client' ? 'cc-key' : null,
      }),
    }
  } catch (err) {
    if (!(err instanceof PgError)) throw err
    result = { error: err.code }
  }
  const live = db[c.table].filter((r) => r.deleted_at === null)
  const latest = live[live.length - 1] ?? null
  const after = {
    revDelta: prev === null ? undefined : prev.rev - revBefore,
    history: db.history.length,
    liveRows: live.length,
    editedBy: latest === null ? undefined : latest.edited_by,
  }
  return { result, after, mismatches: checkContract(c, result, after) }
}
