// 日報の4機能（2026-10-15 本人回答）の画面側の試験。直す前の版（詳細列・詳細の窓のまま・検索とロックの無い版）では
// 宣言が見つからず・正規表現が合わずに失敗し、直した後に成功する形。
//   1. 検索（表題行の右端の検索欄・端末内の絞り込み・useDeferredValue・語を保存しない）
//   2. 時間によるロック（4欄の印・書きかけの扱い・〔ロック解除〕は事務所・管理者だけ・サーバーのロックの一言）
//   3. 分類の列と分類の窓（列の並び・詳細列を外した・窓の中身・札の色のトークン・印刷）
//   4. 同じ方の記録の統合（まとめた行の本文ごとの編集・削除・記入者の姓）
//   5. 送れる値の配管（書きかけの分類・登録後の変更・くらべて選ぶの欄名）
// 純関数は画面のソースから宣言を抜き出して型を剥がして評価する（画面の部品は描かない）。配線は正規表現で確かめる。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）。個人情報は置かない（合成の id と記号だけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { performance } from 'node:perf_hooks'
import { registerLoadFailure } from './ts-load.mjs'

const SRC = new URL('../src/', import.meta.url).href
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')
const daily = read('pages/DailySheetPage.tsx')
const parts = read('components/noteCategory.tsx')
const css = read('styles/sheet.css')
const resolver = read('components/ConflictResolver.tsx')

/** トップレベルの宣言1つ分（行頭の head から、次の行頭の宣言・コメントの手前まで） */
function declSrc(src, head) {
  const at = src.indexOf(`\n${head}`)
  assert.ok(at >= 0, `${head} が見つからない`)
  const from = at + 1
  const re = /\n(?=(?:async function |function |const |let |interface |type |export |\/\*\*|\/\/))/g
  re.lastIndex = from
  const m = re.exec(src)
  return src.slice(from, m ? m.index : undefined)
}

/** 宣言を抜き出して型を剥がし、名前の付いたもの（function・const）を返す。deps は外から渡す名前 */
function evalDecls(src, heads, deps = {}) {
  const code = heads.map((h) => declSrc(src, h)).join('\n')
  const js = stripTypeScriptTypes(code)
  const names = heads.map((h) => /^(?:function|const|let)\s+([A-Za-z0-9_]+)/.exec(h)?.[1]).filter((n) => n !== undefined)
  return new Function(...Object.keys(deps), `${js}\nreturn { ${names.join(', ')} }`)(...Object.values(deps))
}

/** 関数の本体（宣言の始まりから、次のトップレベルの function まで） */
function fnSrc(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} が見つからない`)
  const end = src.indexOf('\nfunction ', start + 1)
  return src.slice(start, end < 0 ? undefined : end)
}

/** DaySheet の useCallback で定義した関数の本体（`const name = useCallback(` から次の `  const ` まで） */
function cbSrc(src, name) {
  const at = src.indexOf(`const ${name} = useCallback(`)
  assert.ok(at >= 0, `${name} が見つからない`)
  const end = src.indexOf('\n  const ', at + 10)
  return src.slice(at, end < 0 ? undefined : end)
}

let LOCK = null
let SEARCH = null
let EDIT = null
let loadError = null
try {
  LOCK = await import('../src/lib/noteLock.ts')
  SEARCH = await import('../src/lib/noteSearch.ts')
  EDIT = await import('../src/lib/noteEdit.ts')
} catch (e) {
  loadError = e
}

const DAY = '2026-10-15'
/** 日本時間の時刻（'HH:MM'・翌日は day を渡す）→ epoch ms */
const jst = (hm, day = DAY) => Date.parse(`${day}T${hm}:00+09:00`)

// ══════════════════════════════════════════════════════════════════════
describe('1. 検索（表題行の右端の検索欄・端末内の絞り込み）', () => {
  it('検索欄と〔分類で抽出〕は表題行（App のヘッダ）の右端・置けない時は日付バーの右端（畳んでも隠さない）・画面だけ', () => {
    const app = read('App.tsx')
    // 2026-10-31（日報の見やすさ・案C）: 置き場は 640px 以上で見出しの右に置き、日付バーも同じ行へ（幅は日付バーの1行ぶん＋余り）
    assert.match(app, /\{location\.pathname === '\/' && \(\s*<div id="cl-daily-header-slot" className="min-w-0 flex-1 basis-full sm:basis-auto print:hidden" \/>\s*\)\}/)
    assert.match(daily, /setHeaderSlot\(document\.getElementById\('cl-daily-header-slot'\)\)/)
    assert.match(daily, /\{headerSlot !== null\s*\? createPortal\(<DailyHeaderBar day=\{day\} unit=\{unit\} onGo=\{goDay\} onUnit=\{goUnit\} search=\{searchBar\} \/>, headerSlot\)\s*: null\}/)
    assert.match(fnSrc(daily, 'DailyHeaderBar'), /persistent=\{search\}/)
    assert.match(daily, /search=\{headerSlot === null \? searchBar : null\}/)
    assert.match(daily, /persistent=\{search \?\? undefined\}/)
    assert.match(daily, /<NoteSearchBar\s+value=\{searchText\}/)
    assert.match(fnSrc(daily, 'DateBar'), /<ZoomBar \/>\s*<\/div>\s*\{extra\}/)
    assert.match(fnSrc(parts, 'NoteSearchBar'), /print:hidden/)
    assert.match(fnSrc(parts, 'NoteSearchBar'), /aria-label="検索の語を消す"/)
    assert.match(fnSrc(parts, 'NoteSearchBar'), /type="search"/)
  })

  it('打鍵ごとに10日分を描き直さない: 各日の枠へは useDeferredValue から作った語を渡す・比べる文字は useMemo で控える', () => {
    assert.match(daily, /const deferredSearch = useDeferredValue\(searchText\)/)
    assert.match(daily, /const searchTerms = useMemo\(\(\) => parseSearchQuery\(deferredSearch\), \[deferredSearch\]\)/)
    assert.match(daily, /searchTerms=\{searchTerms\}/)
    assert.match(daily, /const searchHaystacks = useMemo\(\(\) => \{[\s\S]*?noteSearchText\(\[n\.body, target, r\?\.name, reporter\]\)[\s\S]*?\}, \[shownNotes, residentById, staffById\]\)/)
    assert.match(daily, /searchMatchedIds\(shownNotes, searchHaystacks, searchTerms\)/)
  })

  it('検索語は localStorage に書かない（原則11の対象外＝業務データに近い）', () => {
    const page = daily.slice(daily.indexOf('// ── 検索（2026-10-15 仕様 §1）と分類で抽出'), daily.indexOf('const [extractOpen, setExtractOpen]'))
    assert.ok(page.length > 100, '検索の節が見つからない')
    assert.doesNotMatch(page, /localStorage\.|setItem\(|writeSheetPref\(/)
    assert.doesNotMatch(parts, /localStorage\.|setItem\(/)
  })

  it('合わない行は画面に出さない（紙には出す）・件数は「n件中m件」・まとめた行の合わない本文は薄くする', () => {
    assert.match(daily, /\{count\}件\{shown === null \? null : <span className="print:hidden">中\{shown\}件<\/span>\}/)
    // 検索中は空の書きかけ行と〔＋行〕を出さない
    assert.match(fnSrc(daily, 'NoteBlock'), /visibleNoteDrafts\(drafts, locked \|\| searching\)/)
    assert.match(fnSrc(daily, 'NoteBlock'), /onAdd=\{locked \|\| searching \? undefined : onAdd\}/)
    assert.match(daily, /hidden \? ' dsheet-search-hide' : ''/)
    assert.match(daily, /dim \? ' dsheet-search-dim' : ''/)
    assert.match(css, /@media screen \{\n\s+\.dsheet-search-hide \{\n\s+display: none;/)
  })

  if (loadError !== null) {
    registerLoadFailure('検索の純関数', loadError, 'この Node では TypeScript を読めないため検索の純関数の試験をスキップしました')
    return
  }
  const { searchMatchedIds, countMatched } = evalDecls(daily, ['function searchMatchedIds(', 'function countMatched('], {
    matchSearch: SEARCH.matchSearch,
  })

  it('searchMatchedIds: 語が無ければ null（絞らない）・空白区切りは AND・全角半角・カナかなを吸収', () => {
    const notes = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const hay = new Map([
      [1, SEARCH.noteSearchText(['ﾄｲﾚ 介助しました', '利用者01', '職員01'])],
      [2, SEARCH.noteSearchText(['食事を全量', '利用者02', '職員02'])],
      [3, SEARCH.noteSearchText(['といれ誘導', '利用者01', null])],
    ])
    assert.equal(searchMatchedIds(notes, hay, []), null)
    assert.deepEqual([...searchMatchedIds(notes, hay, SEARCH.parseSearchQuery('トイレ'))].sort(), [1, 3])
    assert.deepEqual([...searchMatchedIds(notes, hay, SEARCH.parseSearchQuery('トイレ　職員01'))], [1])
    assert.deepEqual([...searchMatchedIds(notes, hay, SEARCH.parseSearchQuery('利用者０２'))], [2])
    assert.equal(countMatched(notes, new Set([1, 3])), 2)
  })

  it('約340件・語を変えた時の照合（比べる文字は控え済み）は 16ms 未満', () => {
    const notes = []
    const hay = new Map()
    for (let i = 0; i < 340; i++) {
      notes.push({ id: i + 1 })
      hay.set(i + 1, SEARCH.noteSearchText([`本文${i} 体温 ${i % 7} トイレ介助 食事 全量 夜間 良眠`.repeat(3), `利用者${i % 30}`, `職員${i % 12}`]))
    }
    const terms = SEARCH.parseSearchQuery('トイレ 利用者1')
    const t0 = performance.now()
    for (let k = 0; k < 20; k++) searchMatchedIds(notes, hay, terms)
    const per = (performance.now() - t0) / 20
    assert.ok(per < 16, `1回 ${per.toFixed(2)}ms`)
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('2. 時間によるロック', () => {
  if (loadError !== null) return
  const { lockSigOf, NOTE_SECTION_ORDER } = evalDecls(daily, ['const NOTE_SECTION_ORDER', 'function lockSigOf('], {
    lockState: LOCK.lockState,
  })
  const { visibleNoteDrafts } = evalDecls(daily, ['function visibleNoteDrafts('], {
    noteHasInput: (d) => d.body.trim() !== '' || d.targetPicked || (d.categories?.length ?? 0) > 0,
  })

  it('4欄の印（日勤・16時以降・デイ・夜勤）: 16:59→17:00・23:59→0:00・翌7:59→8:00 で変わる', () => {
    assert.deepEqual(
      NOTE_SECTION_ORDER.map((x) => x.sec),
      ['day', 'late', 'daycare', 'night'],
    )
    assert.equal(lockSigOf(DAY, jst('16:59')), '0000')
    assert.equal(lockSigOf(DAY, jst('17:00')), '1010')
    assert.equal(lockSigOf(DAY, jst('23:59')), '1010')
    assert.equal(lockSigOf(DAY, jst('00:00', '2026-10-16')), '1110')
    assert.equal(lockSigOf(DAY, jst('07:59', '2026-10-16')), '1110')
    assert.equal(lockSigOf(DAY, jst('08:00', '2026-10-16')), '1111')
    // 未来の日はロックしない
    assert.equal(lockSigOf('2026-10-16', jst('23:00')), '0000')
  })

  it('ロック中は空の書きかけ行を出さない（入力のある行・送信待ちの登録の行は残す）・ロック外は全部', () => {
    const empty = { key: 'a', body: '', targetPicked: false, locked: false }
    const typed = { key: 'b', body: 'x', targetPicked: false, locked: false }
    const picked = { key: 'c', body: '', targetPicked: true, locked: false }
    const queued = { key: 'd', body: 'q', targetPicked: true, locked: true }
    const cats = { key: 'e', body: '', targetPicked: false, locked: false, categories: ['薬'] }
    const all = [empty, typed, picked, queued, cats]
    assert.deepEqual(visibleNoteDrafts(all, false).map((d) => d.key), ['a', 'b', 'c', 'd', 'e'])
    assert.deepEqual(visibleNoteDrafts(all, true).map((d) => d.key), ['b', 'c', 'd', 'e'])
  })

  it('親は1分ごと・画面に戻った時・次のロックの時刻に見直し、各日の枠へは印（文字）だけを渡す', () => {
    assert.match(daily, /lockSig=\{lockSigOf\(d, lockNow\)\}/)
    assert.match(daily, /msUntilNextLock\(/)
    assert.match(daily, /window\.setInterval\(\(\) => \{\s*tick\(\)\s*schedule\(\)\s*\}, 60_000\)/)
    assert.match(daily, /document\.addEventListener\('visibilitychange', onVis\)/)
  })

  it('〔ロック解除〕は事務所・管理者のログインの時だけ描く（現場・役割不明は onToggleUnlock を渡さない＝DOM に出ない）', () => {
    assert.match(daily, /const canUnlock = canUnlockNotes\(myRole\)/)
    assert.match(daily, /canUnlock \? \(\) => toggleUnlock\(NOTE_SECTION_ORDER\[i\]\.sec\) : undefined/)
    const band = fnSrc(daily, 'NoteTitleBand')
    assert.match(band, /\{lock && lock\.locked && onToggleUnlock \? \(/)
    // 役割は起動時に問い合わせ、ログインし直しで取り直す
    assert.match(daily, /void fetchMyRole\(\)\.then\(/)
    assert.match(daily, /const unsub = subscribeMyRole\(\(\) => \{/)
    // 解除は画面の state だけ（保存しない＝再読み込みで戻る）
    assert.match(daily, /const \[unlocked, setUnlocked\] = useState<ReadonlySet<NoteSection>>\(\(\) => new Set\(\)\)/)
    assert.doesNotMatch(daily.slice(daily.indexOf('const [unlocked, setUnlocked]'), daily.indexOf('const [residentPick, setResidentPick]')), /localStorage\.|setItem\(|writeSheetPref\(/)
  })

  it('表題帯に「🔒 ロック中（17:00）」・ロック中は〔＋行〕を出さず保存済みの行は読み取り専用', () => {
    const band = fnSrc(daily, 'NoteTitleBand')
    assert.match(band, /🔒 ロック中（\$\{lock\.label\}）/)
    const block = fnSrc(daily, 'NoteBlock')
    assert.match(block, /onAdd=\{locked \|\| searching \? undefined : onAdd\}/)
    assert.match(block, /const savedCtx: SheetCtx = locked && !ctx\.disabled \? \{ \.\.\.ctx, disabled: true \} : ctx/)
    assert.match(block, /ctx=\{d\.locked \? savedCtx : ctx\}/)
  })

  it('書きかけ行がロックで保存できない時は入力を消さず、NOTE_LOCKED_MESSAGE を行に出す（登録の前に止める）', () => {
    const save = cbSrc(daily, 'saveNoteDraft')
    const gate = save.indexOf('if (isLockedNow(draft.shift, draft.after16)) {')
    assert.ok(gate > 0, 'ロックの確かめが無い')
    assert.ok(gate < save.indexOf('await insertNote('), '登録の後で確かめている')
    assert.match(save.slice(gate, gate + 300), /patchNoteDraft\(key, \{ body \}\)\s*setRowStatus\(key, \{ tone: 'danger', text: `▲ \$\{NOTE_LOCKED_MESSAGE\}` \}\)\s*return/)
    // サーバーに止められた時（0033）も同じ文言
    assert.match(save, /isNoteLockedError\(err\) \? NOTE_LOCKED_MESSAGE : errText\(err\)/)
    // 保存済みの行の変更・削除・送信待ちの登録への変更も止める（打った本文は一言に残す）
    assert.match(cbSrc(daily, 'updateNoteCell'), /if \(isLockedNow\(rawNote\.shift, rawNote\.after16\)\) \{[\s\S]*?入力した内容/)
    assert.match(cbSrc(daily, 'deleteNoteRow'), /if \(isLockedNow\(note\.shift, note\.after16\)\) \{/)
    assert.match(cbSrc(daily, 'editRegistrationRow'), /if \(isLockedNow\(draft\.shift, draft\.after16\)\) \{/)
  })

  it('ロックで止められた送信待ちの登録は「ロック中のため…」と出す（regLocked）', () => {
    const { registrationMark } = evalDecls(daily, ['function registrationMark('], {
      NOTE_LOCKED_MESSAGE: 'ロック中のため保存できませんでした（事務所で解除できます）',
      MSG_REG_STOPPED: '止まった',
      MSG_QUEUED: '送信待ち',
    })
    assert.equal(
      registrationMark({ locked: true, ck: 'k', regState: 'rejected', regLocked: true }).text,
      '▲ ロック中のため保存できませんでした（事務所で解除できます）',
    )
    assert.equal(registrationMark({ locked: true, ck: 'k', regState: 'rejected' }).text, '止まった')
    assert.match(daily, /regLocked: op\.locked/)
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('3. 分類の列と分類の窓', () => {
  it('列は「対象｜分類｜内容｜記入者｜色」（詳細の列は無い）', () => {
    const block = fnSrc(daily, 'NoteBlock')
    const heads = [...block.matchAll(/<HeadCell[^>]*>([^<]+)<\/HeadCell>/g)].map((m) => m[1])
    assert.deepEqual(heads, ['対象', '分類', '内容', '記入者', '色'])
    assert.doesNotMatch(block, />詳細</)
    assert.match(css, /--w-category-base: 5\.5rem;/)
    assert.match(css, /--w-category: calc\(var\(--w-category-base\) \* var\(--sheet-zoom, 1\)\);/)
  })

  it('詳細の窓は無い・分類の窓は 分類6つ＋〔全て〕・重要度・〔変更の記録〕だけ（既読・職種タグ・削除は入れない）', () => {
    assert.doesNotMatch(daily, /function NoteDetailModal\(/)
    const modal = fnSrc(daily, 'NoteCategoryModal')
    assert.match(modal, /<CategoryToggles/)
    assert.match(modal, /<ImportanceToggles/)
    assert.match(modal, /変更の記録/)
    assert.doesNotMatch(modal, /既読|職種タグ|ROLE_TAGS|この行を削除|onDelete/)
    // 窓は行の中に描く（.dsheet-body の描画の省略が窓の間は外れる＝content-visibility の仕組みを壊さない）
    assert.match(fnSrc(daily, 'NoteRow'), /\{expanded && \(\s*<NoteCategoryModal/)
    assert.match(css, /\.dsheet-body:has\(\[role='dialog'\]\),\n\.dsheet-body:has\(\[aria-expanded='true'\]\) \{\n\s+content-visibility: visible;/)
  })

  it('〔全て〕は別の見た目で、6つ全部に印・もう一度で全部外す（toggleAllCategories）', () => {
    const t = fnSrc(parts, 'CategoryToggles')
    assert.match(t, /onClick=\{\(\) => onChange\(toggleAllCategories\(value\)\)\}/)
    assert.match(t, /rounded-md border-2/)
    assert.match(t, /aria-pressed=\{on\}/)
  })

  it('札は分類ごとの色のトークン（ライト・ダーク〔設定〕・ダーク〔OS 追従〕の3か所）・必ず文字・印刷は枠と黒い文字', () => {
    for (let i = 1; i <= 6; i++) {
      assert.equal((css.match(new RegExp(`--dsheet-cat-${i}-bg: #[0-9a-f]{6};`, 'g')) ?? []).length, 3, `分類${i}の地`)
      assert.equal((css.match(new RegExp(`--dsheet-cat-${i}-ink: #[0-9a-f]{6};`, 'g')) ?? []).length, 3, `分類${i}の文字`)
    }
    assert.match(css, /@media print \{\n\s+\.dsheet-cat \{\n\s+background: transparent;\n\s+color: #000;/)
    assert.match(fnSrc(parts, 'CategoryChips'), /\{c\}/)
  })

  it('札の地と文字のコントラストは 4.5:1 以上（トークンの値から計算・ライトとダーク）', () => {
    const lum = (h) => {
      const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    }
    const ratio = (a, b) => {
      const x = lum(a)
      const y = lum(b)
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
    }
    for (let i = 1; i <= 6; i++) {
      const bgs = [...css.matchAll(new RegExp(`--dsheet-cat-${i}-bg: (#[0-9a-f]{6});`, 'g'))].map((m) => m[1])
      const inks = [...css.matchAll(new RegExp(`--dsheet-cat-${i}-ink: (#[0-9a-f]{6});`, 'g'))].map((m) => m[1])
      for (let k = 0; k < 3; k++) assert.ok(ratio(bgs[k], inks[k]) >= 4.5, `分類${i}（${k}）: ${ratio(bgs[k], inks[k]).toFixed(2)}`)
    }
  })

  it('〔分類で抽出〕: 分類を選ぶと表示中の範囲の申し送りを一覧し、行を押すと窓を閉じてその行へ移る', () => {
    const d = fnSrc(parts, 'CategoryExtractDialog')
    assert.match(d, /items\.filter\(\(it\) => it\.categories\.some\(\(c\) => picked\.includes\(c\)\)\)/)
    assert.match(d, /onClick=\{\(\) => onJump\(it\)\}/)
    const jump = cbSrc(daily, 'jumpToNote')
    assert.match(jump, /setExtractOpen\(false\)/)
    assert.match(jump, /el\.scrollIntoView\(\{ block: 'center', inline: 'nearest' \}\)/)
  })

  it('くらべて選ぶの欄名に「分類」・値は「・」でつなぐ（無ければ「なし」）', () => {
    assert.match(resolver, /categories: '分類',/)
    assert.match(resolver, /case 'role_tags':\n\s+case 'categories':\n\s+return Array\.isArray\(v\) && v\.length > 0 \? v\.join\('・'\) : 'なし'/)
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('4. 同じ方の記録を1つの行にまとめる', () => {
  it('行は groupNotesByResident（読み込みの並びのまま）でまとめ、まとめた行の本文は記録ごとに直せる・消せる', () => {
    const block = fnSrc(daily, 'NoteBlock')
    assert.match(block, /const groups = useMemo\(\(\) => groupNotesByResident\(rows, null\), \[rows\]\)/)
    const row = fnSrc(daily, 'NoteRow')
    assert.match(row, /const lines = group \? noteGroupLines\(group, nameOf\) : \[\]/)
    // 本文は記録ごとの行キー n<id> で確定・打ちかけを渡す
    assert.match(row, /onCommit=\{disabled \? undefined : \(v, m\) => onCommitBody\(k, v, m\.base\)\}/)
    assert.match(row, /onAbandon=\{\(v, m\) => onAbandonBody\(k, v, m\.base\)\}/)
    // 記録ごとの「✕」（画面だけ）と、2件目以降の「（姓）」（押すとその記録の記入者を選び直す）
    assert.match(row, /onClick=\{\(\) => onDelete\(k\)\}/)
    assert.match(row, /ctx\.openStaff\(\{ for: 'noteReporter', key: k \}\)/)
    assert.match(row, /\{line\.suffix === '' \? <span aria-hidden="true">（—）<\/span> : line\.suffix\}/)
    // 本文ごとにくらべて選んだ後の戻り先・抽出の行き先（id）
    assert.match(row, /id=\{`cl-note-row-\$\{ctx\.day\}-\$\{n\.id\}`\}/)
  })

  it('まとめた行の対象欄は、まとめた全部の対象を選び直す（gids:）', () => {
    assert.match(fnSrc(daily, 'NoteRow'), /key: multi \? `gids:\$\{notes\.map\(\(n\) => n\.id\)\.join\(','\)\}` : rowKey/)
    assert.match(cbSrc(daily, 'onPickResident'), /if \(target\.key\.startsWith\('gids:'\)\) \{/)
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('5. 分類の配管（書きかけ・登録・登録後の変更）', () => {
  it('書きかけの分類は登録の時に送り、選んでいなければ送らない（サーバーの既定値）', () => {
    const save = cbSrc(daily, 'saveNoteDraft')
    assert.match(save, /\.\.\.\(draft\.categories !== undefined && draft\.categories\.length > 0 \? \{ categories: draft\.categories \} : \{\}\)/)
    assert.match(save, /categories: draft\.categories \?\? \[\],/)
  })

  it('送信待ちの登録の行の分類は登録後の変更として積む・控えから読む分類は6値だけ', () => {
    assert.match(cbSrc(daily, 'patchDraftOrRegistration'), /np\.categories = patch\.categories/)
    const rd = fnSrc(daily, 'readNoteDraft')
    assert.match(rd, /const cats = normalizeCategories\(o\.categories\)/)
  })

  if (loadError !== null) return
  it('followUpEdits: 応答待ちの間に選び直した分類を、登録できた行への変更にする（同じなら送らない）', () => {
    const sent = { body: 'b', residentId: 1, targetPicked: true, reporterId: null, color: null, categories: [] }
    const inserted = { body: 'b', resident_id: 1, reporter_id: null, color: null, categories: [] }
    assert.deepEqual(EDIT.followUpEdits(sent, { ...sent, categories: ['体調', '薬'] }, inserted).categories, {
      value: ['体調', '薬'],
      base: [],
    })
    assert.equal(EDIT.followUpEdits(sent, { ...sent }, inserted).categories, undefined)
    assert.equal(EDIT.followUpEdits(sent, { ...sent, categories: undefined }, inserted).categories, undefined)
  })
})
