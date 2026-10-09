// 日報：外出者・外泊者・発熱者・他症状者の行を、申し送りと同じ「✕」（氏名欄の右端）で消せるようにする（2026-10-09 指示）の回帰テスト。
// 実行: node --experimental-strip-types --test tests/rowdelete.test.mjs（修正前の版は CL_ROWDEL_SRC に src の場所を渡す）
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SRC = process.env.CL_ROWDEL_SRC
  ? pathToFileURL(`${process.env.CL_ROWDEL_SRC.replace(/\/$/, '')}/`).href
  : new URL('../src/', import.meta.url).href
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')
const MIG = new URL('../supabase/migrations/', import.meta.url).href

/** 関数1つ分のソース（次のトップレベルの function の手前まで） */
function fnSrc(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} が見つからない`)
  const end = src.indexOf('\nfunction ', start + 1)
  return src.slice(start, end < 0 ? undefined : end)
}

/** ブロックの中の、保存済みの行（rows.map）と書きかけの行（drafts.map）を分けて返す */
function parts(block) {
  const r = block.indexOf('{rows.map(')
  const d = block.indexOf('{drafts.map(')
  assert.ok(r >= 0 && d > r, '保存済みの行と書きかけの行の描画が見つからない')
  return { saved: block.slice(r, d), drafts: block.slice(d) }
}

describe('外出者・外泊者・発熱者・他症状者の行の「✕」', () => {
  it('読み上げ名は「この行を削除」／氏名があれば「◯◯さんのこの行を削除」', () => {
    const src = read('pages/DailySheetPage.tsx')
    const m = src.match(/function rowDeleteLabel\(name: string\): string \{([\s\S]*?)\n\}/)
    assert.ok(m, 'rowDeleteLabel が無い')
    const label = new Function('name', m[1])
    assert.equal(label(''), 'この行を削除')
    assert.equal(label('利用者A'), '利用者Aさんのこの行を削除')
  })

  it('外出者・外泊者: 書きかけの行（空の行を含む）の氏名欄に「✕」を渡す・紙には出さない', () => {
    const { drafts } = parts(fnSrc(read('pages/DailySheetPage.tsx'), 'OutingBlock'))
    assert.match(
      drafts,
      /<PickerCell[\s\S]*?onDelete=\{\(\) => onDeleteRow\(d\.key\)\}\s*deleteLabel=\{rowDeleteLabel\(name\)\}\s*deleteScreenOnly\s*\/>/,
      '書きかけの行の PickerCell に onDelete が無い',
    )
    // 既存の「この行を取り消す」は残す（壊さない）
    assert.match(drafts, /この行を取り消す/)
  })

  it('外出者・外泊者: 保存済みの行の氏名欄にも「✕」（封鎖中は出さない）', () => {
    const { saved } = parts(fnSrc(read('pages/DailySheetPage.tsx'), 'OutingBlock'))
    assert.match(
      saved,
      /\{ctx\.disabled \? null : \(\s*<RowDeleteButton label=\{rowDeleteLabel\(name\)\} onClick=\{\(\) => onDeleteRow\(key\)\} \/>/,
      '保存済みの行に「✕」が無い',
    )
  })

  it('発熱者・他症状者: 書きかけの行（空の行を含む）の氏名欄に「✕」を渡す・紙には出さない', () => {
    const src = read('pages/DailySheetPage.tsx')
    for (const name of ['FeverBlock', 'SymptomBlock']) {
      const { drafts } = parts(fnSrc(src, name))
      assert.match(
        drafts,
        /<PickerCell[\s\S]*?onDelete=\{\(\) => onRemoveDraft\(d\.key\)\}\s*deleteLabel=\{rowDeleteLabel\(name\)\}\s*deleteScreenOnly\s*\/>/,
        `${name} の書きかけの行の PickerCell に onDelete が無い`,
      )
      assert.match(drafts, /この行を取り消す/, `${name} の「この行を取り消す」が消えている`)
    }
  })

  it('発熱者・他症状者: 保存済みの行には「✕」を出さない（サーバーが deleted_at を受け付けるまで）', () => {
    const src = read('pages/DailySheetPage.tsx')
    for (const name of ['FeverBlock', 'SymptomBlock']) {
      const { saved } = parts(fnSrc(src, name))
      assert.doesNotMatch(saved, /onDelete|RowDeleteButton/, `${name} の保存済みの行に削除が出ている`)
    }
    // 0011 の許可リストに deleted_at が無い＝保存済みのバイタルは送信待ち＋CAS の経路で消せない。
    // ここが変わったら（migration を足したら）保存済みの行の「✕」を実装し、このテストを直す
    const mig = readFileSync(new URL('0011_apply_cell_edits.sql', MIG), 'utf8')
    const f = mig.match(/c_vital_fields\s+constant text\[\] := array\[([^\]]*)\]/)
    assert.ok(f, '0011 の c_vital_fields が読めない')
    assert.doesNotMatch(f[1], /deleted_at/)
  })

  it('外出・外泊の削除: 書きかけは取り消し・保存済みは確認ダイアログ → rev 照合の soft delete（競合なら消さない）', () => {
    const src = read('pages/DailySheetPage.tsx')
    const m = src.match(/const deleteOutingRow = useCallback\(([\s\S]*?)\n {2}\)\n/)
    assert.ok(m, 'deleteOutingRow が無い')
    const body = m[1]
    assert.match(body, /outingDrafts\.some\(\(d\) => d\.key === key\)\) \{\s*removeOutingDraft\(key\)\s*return/, '書きかけは removeOutingDraft へ渡していない')
    assert.match(body, /if \(!guard\(key\)\) return\s*askConfirm\(/, '保存済みの行で確認ダイアログを挟んでいない')
    assert.match(body, /await softDeleteOuting\(o\.id, o\.rev\)/, 'rev 照合の soft delete で消していない')
    assert.match(body, /if \(res === 'conflict'\) \{[\s\S]*?ERR_CONFLICT[\s\S]*?return\s*\}/, '競合の時に消さずに知らせていない')
    assert.match(src, /onDeleteRow=\{deleteOutingRow\}[\s\S]*onDeleteRow=\{deleteOutingRow\}/, '外出者・外泊者の両方へ渡していない')
  })

  it('db.ts: softDeleteOuting は水分・入浴と同じ経路（送信待ちに乗る表・rev 照合）', () => {
    const db = read('lib/db.ts')
    assert.match(
      db,
      /export async function softDeleteOuting\(id: number, rev: number, opts\?: WriteOpts\): Promise<true \| Conflict \| Queued> \{\s*return softDelete\('outings', id, rev, opts\)\s*\}/,
    )
    assert.match(db, /type LegacyTable = [^\n]*'outings'/, 'outings が送信待ちの表に無い')
  })

  it('「✕」の当たり判定は既存の作法（CELL_HIT・行の高さ）・新しく足した分は紙に出さない・申し送りの「✕」は従来どおり', () => {
    const src = read('pages/DailySheetPage.tsx')
    const pc = fnSrc(src, 'PickerCell')
    assert.match(pc, /className=\{`\$\{CELL_HIT\} shrink-0 rounded-sm px-1 text-ink2\$\{deleteScreenOnly \? ' print:hidden' : ''\}`\}/)
    const rb = fnSrc(src, 'RowDeleteButton')
    assert.match(rb, /style=\{ROW_BTN_STYLE\}/)
    assert.match(rb, /className=\{`\$\{CELL_HIT\} shrink-0 rounded-sm px-1 text-ink2 print:hidden`\}/)
    // 申し送りの対象欄は onDelete のまま（deleteScreenOnly を付けない＝印刷の見た目を変えない）
    const nr = fnSrc(src, 'NoteRow')
    assert.match(nr, /onDelete=\{\(\) => onDelete\(rowKey\)\}/)
    assert.doesNotMatch(nr, /deleteScreenOnly/)
  })
})
