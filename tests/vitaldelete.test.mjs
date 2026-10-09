// 日報：保存済みの発熱者・他症状者を1回分ずつ消す（2026-10-09 本人裁定・0020 delete_vital）の回帰テスト。
// 1. 契約: 0020 の JS の写し（tests/vital-delete-contract.mjs）が契約の表どおりに答えること
//    （同じ表を素の Postgres で流すのは tests/vital-delete-pg.mjs）
// 2. 画面・db.ts の作り（ソースの形）。修正前の版は CL_VDEL_SRC に src の場所を渡す
// 実行: node --experimental-strip-types --test tests/vitaldelete.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { VITAL_DELETE_CASES, checkVitalDelete, runFakeCase } from './vital-delete-contract.mjs'

const SRC = process.env.CL_VDEL_SRC
  ? pathToFileURL(`${process.env.CL_VDEL_SRC.replace(/\/$/, '')}/`).href
  : new URL('../src/', import.meta.url).href
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')
const MIG = new URL('../supabase/migrations/0020_delete_vital.sql', import.meta.url)

function fnSrc(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} が見つからない`)
  const end = src.indexOf('\nfunction ', start + 1)
  return src.slice(start, end < 0 ? undefined : end)
}
function parts(block) {
  const r = block.indexOf('{rows.map(')
  const d = block.indexOf('{drafts.map(')
  assert.ok(r >= 0 && d > r, '保存済みの行と書きかけの行の描画が見つからない')
  return { head: block.slice(0, r), saved: block.slice(r, d), drafts: block.slice(d) }
}

describe('0020 delete_vital の契約（JS の写し）', () => {
  for (const c of VITAL_DELETE_CASES) {
    it(c.name, () => {
      const { result, after } = runFakeCase(c)
      assert.deepEqual(checkVitalDelete(c, result, after), [])
    })
  }
})

describe('0020 の migration', () => {
  it('関数を1つ足すだけ（create or replace・drop しない・表に触れない）・security invoker・anon 不可', () => {
    assert.ok(existsSync(MIG), '0020_delete_vital.sql が無い')
    const sql = readFileSync(MIG, 'utf8')
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    assert.match(code, /create or replace function public\.delete_vital\(/)
    assert.match(code, /security invoker/)
    assert.match(code, /set search_path = public, pg_temp/)
    assert.doesNotMatch(code, /\bdrop\b|\balter table\b|\bcreate table\b|\bdo \$\$/i, '破壊的・構造の変更・do ブロックがある')
    assert.match(code, /revoke execute on function public\.delete_vital\(bigint, jsonb, bigint\) from anon;/)
    assert.match(code, /grant {2}execute on function public\.delete_vital\(bigint, jsonb, bigint\) to {3}authenticated;/)
    // 書くのは deleted_at と edited_by だけ
    const upd = code.match(/update vitals set([\s\S]*?)where id = v_row\.id;/)
    assert.ok(upd, 'update が無い')
    assert.deepEqual([...upd[1].matchAll(/(\w+)\s*=/g)].map((m) => m[1]), ['deleted_at', 'edited_by'])
  })
})

describe('db.ts の deleteVitalEntry', () => {
  it('RPC delete_vital を呼ぶ・送信待ちに積まない・関数が無い／通信できない時は消さずに事実の一言', () => {
    const db = read('lib/db.ts')
    const m = db.match(/export async function deleteVitalEntry\(([\s\S]*?)\n\}\n/)
    assert.ok(m, 'deleteVitalEntry が無い')
    const body = m[1]
    assert.match(body, /sb\.rpc\('delete_vital', \{ p_id: id, p_seen, p_editor: /)
    assert.doesNotMatch(body, /enqueue\(|saveCellEditsInternal/, '送信待ちに積んでいる')
    assert.match(body, /if \(isMissingRpc\(res\)\) throw new DbError\('server', MSG_VITAL_DELETE_PENDING\)/)
    assert.match(body, /if \(isTransient\(res\)\) throw new DbError\('network', MSG_VITAL_DELETE_OFFLINE\)/)
    assert.match(db, /MSG_VITAL_DELETE_PENDING =\s*\n\s*'サーバー側の更新待ちのため、保存済みの測定はまだ削除できません。記録は消していません。/)
    // 8欄すべてを「見た値」として送る
    assert.match(body, /for \(const f of VITAL_CELL_FIELDS\) p_seen\[f\] = seen\[f\] \?\? null/)
  })
})

describe('日報の発熱者・他症状者の「✕」（1回分ずつ）', () => {
  it('発熱者: 見出し・保存済み・書きかけの各回の後ろに「✕」の列（保存済みの埋まった回だけボタン）', () => {
    const { head, saved, drafts } = parts(fnSrc(read('pages/DailySheetPage.tsx'), 'FeverBlock'))
    assert.match(head, /<HeadCell width="var\(--w-pulse\)">脈<\/HeadCell>\s*<DelColCell \/>/)
    assert.match(saved, /<DelColCell>\s*\{v && !ctx\.disabled \? \(\s*<RowDeleteButton\s*label=\{`\$\{feverWhat\(name, row\.key, i, v\)\}の測定を削除`\}\s*onClick=\{\(\) => onDeleteSaved\(v, row\.key, feverWhat\(name, row\.key, i, v\)\)\}/)
    assert.match(drafts, /<DelColCell \/>\s*<\/SetBox>/)
  })

  it('他症状者: 見出し・保存済み・書きかけの値の後ろに「✕」の列', () => {
    const { head, saved, drafts } = parts(fnSrc(read('pages/DailySheetPage.tsx'), 'SymptomBlock'))
    assert.match(head, /<DelColCell \/>\s*<\/SetBox>\s*<HeadCell grow>症状<\/HeadCell>/)
    assert.match(saved, /<RowDeleteButton\s*label=\{`\$\{symptomWhat\(name, v\)\}の測定を削除`\}\s*onClick=\{\(\) => onDeleteSaved\(v, key, symptomWhat\(name, v\)\)\}/)
    assert.match(drafts, /<DelColCell \/>\s*<\/SetBox>\s*<Cell grow pad=\{false\}>/)
  })

  it('「✕」の列は 24px×倍率（2026-10-09 本人指示で狭めた）・中のボタンは共通の最小幅を外す・印刷に出さない', () => {
    const src = read('pages/DailySheetPage.tsx')
    assert.match(src, /const DEL_COL_W = 'calc\(1\.5rem \* var\(--sheet-zoom, 1\)\)'/)
    const d = fnSrc(src, 'DelColCell')
    assert.match(d, /<Cell width=\{DEL_COL_W\} pad=\{false\} className="dsheet-delcol flex items-center justify-center print:hidden">/)
    const css = read('styles/sheet.css')
    assert.match(css, /\.dsheet-delcol button \{\s*min-width:\s*0;/)
  })

  it('器の最小幅に「✕」の列3本ぶんを画面だけ足す（足さないと発熱者の行が器からはみ出して切れる）・印刷は 0', () => {
    const src = read('pages/DailySheetPage.tsx')
    assert.match(src, /const SHEET_MIN_W = `calc\([^`]*\+ var\(--dsheet-del-cols, 0px\)\)`/)
    assert.match(src, /const SHEET_DEL_COLS_CLASS = '\[--dsheet-del-cols:calc\(1\.5rem\*var\(--sheet-zoom,1\)\*3\)\] print:\[--dsheet-del-cols:0px\]'/)
    assert.match(src, /<div className=\{`sheet-dense \$\{SHEET_DEL_COLS_CLASS\} \$\{SHEET_BP_W_CLASS\}`\} ref=\{measureSheetView\} style=\{\{ minWidth: SHEET_MIN_W \}\}>/)
  })

  it('血圧の列は日報の画面だけ 84px（倍率に追従）・印刷は従来の幅・バイタル一覧と共有の変数は変えない（2026-10-09 本人裁定）', () => {
    const src = read('pages/DailySheetPage.tsx')
    assert.match(src, /const W_BP = 'var\(--dsheet-w-bp, calc\(var\(--w-sys\) \+ var\(--w-dia\)\)\)'/)
    assert.match(src, /const SHEET_BP_W_CLASS = '\[--dsheet-w-bp:calc\(5\.25rem\*var\(--sheet-zoom,1\)\)\] print:\[--dsheet-w-bp:calc\(var\(--w-sys\)\+var\(--w-dia\)\)\]'/)
    // 発熱者の1セットの幅（器の最小幅の式）も同じ W_BP を使う＝画面だけ最小幅が縮む
    assert.match(src, /const W_FEVER_SET = `calc\(var\(--w-pulse\) \* 2 \+ var\(--w-temp\) \+ var\(--w-spo2\) \+ \$\{W_BP\}\)`/)
    const css = readFileSync(new URL('../src/styles/sheet.css', import.meta.url), 'utf8')
    assert.match(css, /--w-sys-base: 3\.125rem;/, 'バイタル一覧と共有の変数を変えている')
    assert.match(css, /--w-dia-base: 3\.125rem;/, 'バイタル一覧と共有の変数を変えている')
  })

  it('発熱者の各回・他症状者の1組を太線で囲む（見出し・保存済み・書きかけ。画面だけ・幅を変えない重ね描き）', () => {
    const src = read('pages/DailySheetPage.tsx')
    const box = fnSrc(src, 'SetBox')
    assert.match(box, /after:pointer-events-none after:absolute after:inset-0 after:border-ink2 after:content-\[''\] print:after:hidden/)
    assert.match(box, /after:border-l-2\$\{last \? ' after:border-r-2' : ''\}\$\{top \? ' after:border-t-2' : ''\}\$\{bottom \? ' after:border-b-2' : ''\}/)
    const fever = parts(fnSrc(src, 'FeverBlock'))
    assert.match(fever.head, /<SetBox key=\{i\} top last=\{i === FEVER_SETS - 1\}>/)
    assert.match(fever.saved, /<SetBox key=\{i\} last=\{i === FEVER_SETS - 1\} bottom=\{lastRow\}>/)
    assert.match(fever.drafts, /<SetBox key=\{i\} last=\{i === FEVER_SETS - 1\} bottom=\{di === drafts\.length - 1\}>/)
    const sym = parts(fnSrc(src, 'SymptomBlock'))
    assert.match(sym.head, /<SetBox top last>/)
    assert.match(sym.saved, /<SetBox last bottom=\{lastRow\}>/)
    assert.match(sym.drafts, /<SetBox last bottom=\{di === drafts\.length - 1\}>/)
  })

  it('呼び名は「◯◯さんの◯回目（時刻）」／「◯◯さんの他症状者（時刻）」・時刻が無ければ（時刻未記入）', () => {
    const src = read('pages/DailySheetPage.tsx')
    const fmtTimeHM = (t) => (t ? `${Number(t.split(':')[0])}:${t.split(':')[1]}` : '')
    const fw = src.match(/function feverWhat\(name: string, rowKey: string, slot: number, v: Vital\): string \{([\s\S]*?)\n\}/)
    const sw = src.match(/function symptomWhat\(name: string, v: Vital\): string \{([\s\S]*?)\n\}/)
    assert.ok(fw && sw, 'feverWhat / symptomWhat が無い')
    const fever = new Function('name', 'rowKey', 'slot', 'v', 'FEVER_SETS', 'fmtTimeHM', fw[1])
    const symptom = new Function('name', 'v', 'fmtTimeHM', sw[1])
    assert.equal(fever('利用者A', 'f4-0', 1, { measured_at: '12:00:00' }, 3, fmtTimeHM), '利用者Aさんの2回目（12:00）')
    assert.equal(fever('利用者A', 'f4-1', 0, { measured_at: '09:05:00' }, 3, fmtTimeHM), '利用者Aさんの4回目（9:05）')
    assert.equal(fever('利用者A', 'f4-0', 2, { measured_at: null }, 3, fmtTimeHM), '利用者Aさんの3回目（時刻未記入）')
    assert.equal(symptom('利用者B', { measured_at: '10:00:00' }, fmtTimeHM), '利用者Bさんの他症状者（10:00）')
  })

  it('削除の手順: 封鎖・未送信・電波なしで止める → 確認ダイアログ → 行ごとの順番待ち → 競合なら消さずに描き直す', () => {
    const src = read('pages/DailySheetPage.tsx')
    const m = src.match(/const deleteSavedVital = useCallback\(([\s\S]*?)\n {2}\)\n/)
    assert.ok(m, 'deleteSavedVital が無い')
    const b = m[1]
    assert.match(b, /if \(!guardVital\(rowKey\)\) return/)
    assert.match(b, /if \(busy\(\)\) \{\s*setRowStatus\(rowKey, \{ tone: 'warn', text: `▲ \$\{MSG_VITAL_DELETE_BUSY\}` \}\)\s*return/)
    // 発熱者は同じ方の発熱者の控え・送信待ちがある間も止める（束ねた行の詰め直しで控えと行が合わなくなるため）
    assert.match(b, /h\.base\.kind === 'observation' && h\.base\.resident_id === v\.resident_id/)
    assert.match(b, /navigator\.onLine === false/)
    assert.match(b, /askConfirm\(\{\s*title: 'この測定を削除しますか',\s*body: `\$\{what\}の測定を削除します。/)
    assert.match(b, /void vitalQueue\(String\(v\.id\), async \(\) => \{/)
    assert.match(b, /const res = await deleteVitalEntry\(v\)/)
    assert.match(b, /if \(res\.status === 'conflict' && res\.reason === 'changed'\) \{[\s\S]*?replaceVital\(res\.row\)[\s\S]*?MSG_VITAL_DELETE_CHANGED[\s\S]*?return\s*\}/)
    assert.match(src, /onDeleteSaved=\{deleteSavedVital\}[\s\S]*onDeleteSaved=\{deleteSavedVital\}/, '発熱者・他症状者の両方へ渡していない')
  })
})
