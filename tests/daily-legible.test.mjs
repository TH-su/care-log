// 日報の見やすさの改善（2026-10-31 本人裁定・案C）の回帰テスト。すべて画面だけで、印刷 A3 は1pxも変えない。
//   1. 日報の枠（.dsheet-legible）の中だけ、文字 16px・行 26px・列幅を差し替える（バイタル・食事は変えない）
//   2. 印刷の規則（sheet.css の @media print）に手を入れていない
//   3. 倍率の保存値は一度だけ 100% に戻す（印が付いた端末では二度と戻さない）
//   4. 0件の付帯ブロックを画面で1行にまとめる条件（空行は作ったまま隠す＝紙は全ブロック）
//   5. 発熱者・他症状者の器（横にずらす）は画面だけ
//   6. 上部を1段に（表題行へ portal・倍率は日報だけ選択欄1つ・紙には従来の日付バー）
//   7. 日と日の間は画面だけ 16px（印刷は 32px・同日内 12px より広い）
// ソースを読んで正規表現・宣言の抜き出しで確かめる（画面の部品は描かない）。倍率のリセットだけは lib/zoom.ts を読み込んで動かす。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）。個人情報は置かない。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const SRC = new URL('../src/', import.meta.url).href
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')
const css = read('styles/sheet.css')
const daily = read('pages/DailySheetPage.tsx')

/** コメントを外す（コメントの中の「@media print」等の語に引っかからないように） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** 指定した @media の塊（波括弧の対応で切り出す）を全部返す */
function mediaBlocks(src, query) {
  const s = stripComments(src)
  const out = []
  let i = 0
  for (;;) {
    const at = s.indexOf(`@media ${query}`, i)
    if (at < 0) break
    const open = s.indexOf('{', at)
    let depth = 0
    let j = open
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++
      else if (s[j] === '}' && --depth === 0) break
    }
    out.push(s.slice(at, j + 1))
    i = j + 1
  }
  return out
}

/** トップレベルの関数1つ分（function name( から次の行頭の function まで） */
function fnSrc(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} が見つからない`)
  const end = src.indexOf('\nfunction ', start + 1)
  return src.slice(start, end < 0 ? undefined : end)
}

// ══════════════════════════════════════════════════════════════════════
describe('1. 日報の枠の中だけ、画面の文字と列幅を差し替える', () => {
  it('基準値（:root）は 13px のまま・日報の枠（.dsheet-legible）だけ画面で 16px・行 26px・見出し 26px', () => {
    const root = stripComments(css).match(/:root \{([^}]*)\}/)
    assert.ok(root, ':root の素の値が無い')
    assert.match(root[1], /--sheet-font-base: 0\.8125rem;/, ':root の文字が 13px でない（バイタル・食事・紙が変わる）')
    assert.match(root[1], /--sheet-row-h-note-base: 1\.4375rem;/)
    assert.match(root[1], /--sheet-head-h-base: 1\.5rem;/)
    const legible = mediaBlocks(css, 'screen').find((b) => /\.dsheet-legible \{/.test(b))
    assert.ok(legible, '.dsheet-legible の差し替えが @media screen の中に無い')
    assert.match(legible, /--sheet-font-base: 1rem;/)
    assert.match(legible, /--sheet-row-h-note-base: 1\.625rem;/)
    assert.match(legible, /--sheet-head-h-base: 1\.625rem;/)
    // 列幅（日報の画面だけ・本人裁定の目安）
    for (const [name, rem] of [
      // 目安どおり: 分類 92・記入者 64・出勤者枠 68
      ['category', '5.75'], ['reporter', '4'], ['attend', '4.25'],
      // 16px の見出し・取り違え防止の情報が切れたので実測で広げた: ブロック名 96→122・日付セル 170→176・出勤者見出し 56→58・
      // 対象 150→198（「スタッフへ（全体）」＋✕）・氏名 118→156（全角6字＋空白＋✕）・〜 20→25
      ['block', '7.625'], ['facility', '11'], ['attend-label', '3.625'], ['target', '9'], ['name', '9.75'], ['tilde', '1.5625'],
    ]) {
      assert.match(legible, new RegExp(`--w-${name}-base: ${rem.replace('.', '\\.')}rem;`), `--w-${name} が決めた幅でない`)
    }
    // 数値の列は「38.4↑↑」「151↑↑」が 16px の太字で切れない幅（実測 54.3px・50.0px ＋余白8＋罫線1）
    assert.match(legible, /--w-temp-base: 4rem;/)
    assert.match(legible, /--w-spo2-base: 3\.75rem;/)
    assert.match(legible, /--w-pulse-base: 3\.75rem;/)
    assert.match(legible, /\.dsheet-legible \.sheet-dense \{\s*--dsheet-w-bp: calc\(6\.375rem \* var\(--sheet-zoom, 1\)\);/)
    // 時刻の列（「1回目 時」）と外出者の「登録」（「✓ 登録済」）は日報の画面だけの変数。印刷は従来の幅に落ちる
    assert.match(legible, /--dsheet-w-time: calc\(4\.75rem \* var\(--sheet-zoom, 1\)\);/)
    assert.match(legible, /--dsheet-w-reg: calc\(5rem \* var\(--sheet-zoom, 1\)\);/)
    assert.match(daily, /const W_REG = 'var\(--dsheet-w-reg, var\(--w-reporter\)\)'/)
    assert.equal((daily.match(/width=\{W_REG\}/g) ?? []).length, 3, '外出者の登録の列（見出し・保存済み・書きかけ）に W_REG が無い')
  })

  it('契約名（倍率適用済み）を日報の枠でも算出し直す（:root で計算済みの 13px 基準を継がない）', () => {
    assert.match(stripComments(css), /:root,\s*\.sheet-frame,\s*\.dsheet-legible,\s*\.vsheet-legible \{\s*--sheet-font: calc\(var\(--sheet-font-base\) \* var\(--sheet-zoom, 1\)\);/)
  })

  it('class を付けるのは日報の枠だけ（バイタル一覧・食事一覧には付けない）', () => {
    assert.match(daily, /<SheetFrame className="dsheet-frame dsheet-legible sheet-frame-fit print:!max-h-none">/)
    for (const p of ['pages/VitalsSheetPage.tsx', 'pages/MealsSheetPage.tsx']) {
      assert.doesNotMatch(read(p), /dsheet-legible/, `${p} に日報の差し替えが効いている`)
    }
  })

  it('表の最小幅は画面では外出者の行の固定列（日報の枠の変数）・印刷では従来の SHEET_MIN_W に落ちる', () => {
    assert.match(daily, /const SHEET_VIEW_MIN_W = `var\(--dsheet-sheet-min-w, \$\{SHEET_MIN_W\}\)`/)
    assert.match(daily, /style=\{\{ minWidth: SHEET_VIEW_MIN_W \}\}/)
    const legible = mediaBlocks(css, 'screen').find((b) => /--dsheet-sheet-min-w:/.test(b))
    assert.ok(legible, '--dsheet-sheet-min-w が @media screen の中に無い（印刷の幅が変わる）')
    assert.doesNotMatch(stripComments(css).replace(legible, ''), /--dsheet-sheet-min-w:/, '画面の外でも最小幅を差し替えている')
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('2. 印刷の規則に手を入れていない', () => {
  it('sheet.css の @media print の塊は 2026-10-31 の前（48fe221）と同じ', () => {
    const blocks = mediaBlocks(css, 'print')
    assert.equal(blocks.length, 9, `@media print の塊の数が変わった（${blocks.length}）`)
    const hash = createHash('sha256').update(blocks.join('\n')).digest('hex')
    assert.equal(hash, PRINT_HASH, '印刷の規則が変わった')
    for (const b of blocks) {
      assert.doesNotMatch(b, /dsheet-legible|dsheet-fold|dsheet-hscroll|dsheet-sheet-min-w/, '印刷の規則に今回の class が入っている')
    }
  })

  it('今回足した規則は全部 @media screen の中（.dsheet-legible の契約名の算出だけは媒体を問わない＝印刷でも :root と同じ値）', () => {
    const plain = stripComments(css)
    const screen = mediaBlocks(css, 'screen').join('\n')
    for (const sel of ['.dsheet-fold {', '.dsheet-hscroll {', '.dsheet-hscroll-in {', '.dsheet-legible .sheet-dense {', '--sheet-font-base: 1rem;', '--dsheet-sheet-min-w:', '--dsheet-w-time:', '--dsheet-w-reg:', 'main:has(.dsheet-frame) {\n    padding-top', '.dsheet-printbar + .dsheet-stack', '#cl-daily-header-slot .dsheet-search-input', '.dsheet-hscroll :focus-visible']) {
      const all = plain.split(sel).length - 1
      const inScreen = screen.split(sel).length - 1
      assert.ok(all > 0, `${sel} が無い`)
      assert.equal(inScreen, all, `${sel} が @media screen の外にある`)
    }
    // .dsheet-legible が @media screen の外に出るのは、契約名を算出し直す1か所（:root, .sheet-frame, .dsheet-legible, .vsheet-legible）だけ
    // （2026-11-01 にバイタル一覧の .vsheet-legible を同じ並びへ足したので、単独の「.dsheet-legible {」は画面の外に0か所）
    const outside = plain.split(/\.dsheet-legible \{/).length - 1 - (screen.split(/\.dsheet-legible \{/).length - 1)
    assert.equal(outside, 0, '.dsheet-legible の規則が @media screen の外に増えている')
    assert.equal(plain.split(/\.dsheet-legible,/).length - 1, 1, '契約名の算出以外で .dsheet-legible を並べている')
    assert.match(plain, /:root,\s*\.sheet-frame,\s*\.dsheet-legible,\s*\.vsheet-legible \{/)
  })

  it('紙に出す日付バーは従来のまま（倍率の4ボタン）・表題行の1段とまとめた1行は紙に出さない', () => {
    assert.match(daily, /<div className=\{headerSlot === null \? undefined : 'dsheet-printbar hidden print:block'\}>\s*<DailyTopBar/)
    assert.match(fnSrc(daily, 'DateBar'), /<ZoomBar \/>/)
    assert.match(fnSrc(daily, 'SideFoldSummary'), /print:hidden/)
    assert.match(read('App.tsx'), /<div id="cl-daily-header-slot" className="[^"]*print:hidden" \/>/)
  })
})

// 印刷の規則の指紋（48fe221 の sheet.css の @media print の塊・コメントを外したもの・9個から作った値。印刷を直す時は、紙の見比べをしてからここを更新する）
const PRINT_HASH = '5f7fb443e3ebabf3929fe51c4ef17f263db5aa9ca6730168c32412d7587faa87'

// ══════════════════════════════════════════════════════════════════════
describe('3. 倍率の保存値は一度だけ 100% に戻す', () => {
  const store = new Map()
  let failSet = null
  let Z = null
  let loadError = null
  const setup = async () => {
    if (Z !== null || loadError !== null) return
    try {
      const { registerHooks } = await import('node:module')
      registerHooks({
        resolve(specifier, context, next) {
          if (/^\.{1,2}\//.test(specifier) && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
            try {
              return next(`${specifier}.ts`, context)
            } catch {
              // .ts が無いものは元の指定へ戻す
            }
          }
          return next(specifier, context)
        },
      })
      globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => {
          if (failSet !== null && failSet(k)) throw new Error('quota')
          store.set(k, String(v))
        },
        removeItem: (k) => store.delete(k),
      }
      globalThis.window = globalThis
      globalThis.document = { documentElement: { style: { setProperty: () => undefined } } }
      Z = await import(new URL('lib/zoom.ts', SRC).href)
    } catch (e) {
      loadError = e
    }
  }
  afterEach(() => {
    store.clear()
    failSet = null
  })

  it('印のキーは types.ts の LS に置く（cl_zoom_reset_20261031）', () => {
    assert.match(read('lib/types.ts'), /zoomReset: 'cl_zoom_reset_20261031'/)
  })

  it('印が無い端末は 100 に戻して印を付け、印が付いた後は保存した倍率をそのまま読む（二度と戻さない）', async () => {
    await setup()
    assert.equal(loadError, null, `読み込めない: ${loadError}`)
    store.set('cl_zoom', '150')
    assert.equal(Z.readZoom(), 100, '印が無いのに戻していない')
    assert.equal(store.get('cl_zoom'), '100')
    assert.equal(store.get('cl_zoom_reset_20261031'), '1')
    store.set('cl_zoom', '150')
    assert.equal(Z.readZoom(), 150, '印が付いた後にまた戻した')
    assert.equal(Z.readZoom(), 150)
  })

  it('印が書けない端末では倍率を書き換えない（毎回戻すことにならない）', async () => {
    await setup()
    assert.equal(loadError, null)
    failSet = (k) => k === 'cl_zoom_reset_20261031'
    store.set('cl_zoom', '125')
    assert.equal(Z.readZoom(), 125)
    assert.equal(store.get('cl_zoom'), '125')
    assert.equal(store.has('cl_zoom_reset_20261031'), false)
  })

  it('印を先に書く（印 → 倍率の順）・例外は握って表示を止めない', () => {
    const src = read('lib/zoom.ts')
    const fn = src.slice(src.indexOf('function resetZoomOnce('), src.indexOf('export function readZoom('))
    assert.ok(fn.indexOf('setItem(LS.zoomReset') < fn.indexOf('setItem(LS.zoom,'), '倍率を先に書いている（印が書けない端末で毎回戻る）')
    assert.match(fn, /try \{[\s\S]*\} catch \{/)
    assert.match(src, /export function readZoom\(\): number \{\s*resetZoomOnce\(\)/)
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('4. 0件の付帯ブロックを画面で1行にまとめる', () => {
  // 畳む条件は純関数 foldedSides。宣言を抜き出して型を剥がし、実際に動かして確かめる（種類の取り違えは結果が変わって落ちる）
  const decl = (() => {
    const at = daily.indexOf('\nfunction foldedSides(')
    assert.ok(at >= 0, 'foldedSides が無い')
    const end = daily.indexOf('\n}\n', at)
    return daily.slice(at + 1, end + 2)
  })()
  const foldedSides = new Function(`${stripTypeScriptTypes(decl)}\nreturn foldedSides`)()
  const ZERO = { outing: 0, overnight: 0, fever: 0, symptom: 0 }
  const od = (kind, over = {}) => ({ key: `od-${kind}`, kind, residentId: null, place: '', startAt: '', endText: '', companion: '', locked: false, ...over })
  const set0 = { at: '', temp: '', spo2: '', bp: '', pulse: '' }
  const vd = (kind, over = {}) => ({ key: `vd-${kind}`, kind, residentId: null, symptom: '', sets: [set0, set0, set0], locked: false, ...over })
  const base = (over = {}) => ({
    shown: new Set(),
    counts: ZERO,
    outingDrafts: [od('outing'), od('overnight')],
    vitalDrafts: [vd('observation'), vd('symptom')],
    heldKinds: [],
    status: {},
    ...over,
  })
  const ALL = { outing: true, overnight: true, fever: true, symptom: true }

  it('空行だけの0件の日は4つとも畳む', () => {
    assert.deepEqual(foldedSides(base()), ALL)
  })

  it('保存済みの件数はその種類だけを開く', () => {
    for (const k of Object.keys(ZERO)) {
      assert.deepEqual(foldedSides(base({ counts: { ...ZERO, [k]: 1 } })), { ...ALL, [k]: false }, k)
    }
  })

  it('書きかけ（値・locked・行の一言）は、その種類の行だけを見る（外出と外泊・発熱と他症状を取り違えない）', () => {
    const cases = [
      ['outing', { outingDrafts: [od('outing', { place: '病院' }), od('overnight')] }],
      ['overnight', { outingDrafts: [od('outing'), od('overnight', { companion: '長女様' })] }],
      ['outing', { outingDrafts: [od('outing', { locked: true }), od('overnight')] }],
      ['overnight', { outingDrafts: [od('outing'), od('overnight', { residentId: 3 })] }],
      ['overnight', { status: { 'od-overnight': { tone: 'danger', text: 'x' } } }],
      ['fever', { vitalDrafts: [vd('observation', { sets: [{ ...set0, temp: '37.5' }, set0, set0] }), vd('symptom')] }],
      ['symptom', { vitalDrafts: [vd('observation'), vd('symptom', { symptom: '咳' })] }],
      ['fever', { vitalDrafts: [vd('observation', { locked: true }), vd('symptom')] }],
      ['symptom', { status: { 'vd-symptom': { tone: 'warn', text: 'x' } } }],
    ]
    for (const [k, over] of cases) {
      assert.deepEqual(foldedSides(base(over)), { ...ALL, [k]: false }, `${k} ${JSON.stringify(over)}`)
    }
  })

  it('止まっている入力は種類別（observation＝発熱者・symptom＝他症状者）', () => {
    assert.deepEqual(foldedSides(base({ heldKinds: ['observation'] })), { ...ALL, fever: false })
    assert.deepEqual(foldedSides(base({ heldKinds: ['symptom'] })), { ...ALL, symptom: false })
  })

  it('一度画面に出たブロックは0件に戻っても畳まない（入力中のセルごと隠れる経路を作らない）', () => {
    for (const k of Object.keys(ZERO)) {
      assert.deepEqual(foldedSides(base({ shown: new Set([k]) })), { ...ALL, [k]: false }, k)
    }
    // 画面に出たブロックを控える配線: 畳まずに出した種類を shownSides へ足す・〔＋行〕で開いた種類も足す。控えを減らす所は無い
    assert.match(daily, /const add = SIDE_FOLD_ORDER\.map\(\(x\) => x\.kind\)\.filter\(\(k\) => !folded\[k\] && !shownSides\.has\(k\)\)/)
    assert.match(daily, /for \(const k of add\) next\.add\(k\)/)
    assert.match(daily, /setShownSides\(\(cur\) => new Set\(cur\)\.add\(kind\)\)/)
    assert.equal((daily.match(/setShownSides\(/g) ?? []).length, 2, '控えを書き換える所が増えた（減らす経路を作らない）')
    assert.doesNotMatch(daily, /\.delete\((?:k|kind)\)[^\n]*shown|shownSides\.delete|setShownSides\(\(\) => new Set\(\)\)/)
    assert.match(daily, /shown: shownSides,/)
  })

  it('空行（MIN_ROWS）は作ったまま CSS で隠すだけ（データを作らない・書きかけに数えない・紙は全ブロック＋空行）', () => {
    assert.match(daily, /const MIN_ROWS = \{ outing: 1, overnight: 1, fever: 1, symptom: 1, note: 1 \} as const/)
    assert.match(fnSrc(daily, 'SheetBlock'), /className=\{folded \? 'dsheet-fold' : undefined\}/)
    assert.match(css, /@media screen \{\s*\.dsheet-fold \{\s*display: none;/)
    for (const [fn, k] of [['OutingBlock', 'kind'], ['FeverBlock', "'fever'"], ['SymptomBlock', "'symptom'"]]) {
      const src = fnSrc(daily, fn)
      assert.match(src, /folded=\{folded\}/, `${fn} が畳む印を渡していない`)
      assert.match(src, new RegExp(`sectionId=\\{foldSectionId\\(ctx\\.day, ${k}\\)\\}`))
    }
    for (const [k, prop] of [['outing', 'outing'], ['overnight', 'overnight'], ['fever', 'fever'], ['symptom', 'symptom']]) {
      assert.match(daily, new RegExp(`folded=\\{folded\\.${prop}\\}`), `${k} に畳む印が渡っていない`)
    }
  })

  it('まとめた1行: 「外泊者 0名〔＋行〕」の形・入力封鎖中は〔＋行〕を出さない・〔＋行〕は開くだけ（行を足さない）', () => {
    const sum = fnSrc(daily, 'SideFoldSummary')
    assert.match(sum, /\{x\.title\} <span className="tabular text-ink">0名<\/span>/)
    assert.match(sum, /\{x\.onOpen \? <AddRowButton label=\{`\$\{x\.title\}に1行追加`\} onClick=\{x\.onOpen\} \/> : null\}/)
    assert.match(sum, /if \(items\.length === 0\) return null/)
    assert.match(daily, /\(x\.kind === 'fever' \|\| x\.kind === 'symptom' \? vitalCtx : ctx\)\.disabled \? undefined : \(\) => unfold\(x\.kind\)/)
    const at = daily.indexOf('const unfold = useCallback(')
    const unfold = daily.slice(at, daily.indexOf('\n  )\n', at))
    assert.doesNotMatch(unfold, /addOutingDraft|addVitalDraft/, '〔＋行〕で行を足している（空行が2本になる）')
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('5. 発熱者・他症状者の器は画面だけ', () => {
  it('2つの表を器（.dsheet-hscroll）と箱（.dsheet-hscroll-in・発熱者の固定列の最小幅）で包む', () => {
    assert.match(daily, /const FEVER_MIN_W = `calc\(var\(--w-block\) \+ var\(--w-name\) \+ \$\{W_FEVER_SET\} \* \$\{FEVER_SETS\} \+ var\(--dsheet-del-cols, 0px\)\)`/)
    assert.match(daily, /<div className="dsheet-hscroll">[\s\S]*?<div\s+className="dsheet-hscroll-in"\s+style=\{[^\n]*FEVER_MIN_W[^\n]*\}\s*>\s*<FeverBlock[\s\S]*?<SymptomBlock[\s\S]*?<\/div>\s*<\/div>/)
  })

  it('器の横スクロール・箱の最小幅は @media screen の中だけ（印刷ではただの入れ物）', () => {
    const block = mediaBlocks(css, 'screen').find((b) => /\.dsheet-hscroll \{/.test(b))
    assert.ok(block, '器の規則が @media screen の中に無い')
    assert.match(block, /\.dsheet-hscroll \{\s*overflow-x: auto;/)
    assert.match(block, /\.dsheet-hscroll-in \{\s*min-width: var\(--dsheet-fever-min-w, 0px\);/)
    // 外側の枠を横にずらしても器は枠の左に留まる（中の一言が器ごと画面外へ流れない）・端のセルのフォーカスの枠は内側に描く
    assert.match(block, /position: sticky;\s*left: 0;\s*max-width: var\(--dsheet-view-w, 100%\);/)
    assert.match(block, /\.dsheet-hscroll :focus-visible \{\s*outline: 2px solid var\(--c-focus\);\s*outline-offset: -2px;/)
    assert.doesNotMatch(daily, /className="dsheet-hscroll[^"]*print:/, '器に印刷の指定を足している')
    // 2つとも畳んでいる日は箱に幅を持たせない（中身が無いのに横のスクロールバーが出ない）
    assert.match(daily, /style=\{folded\.fever && folded\.symptom \? undefined : \(\{ '--dsheet-fever-min-w': FEVER_MIN_W \} as CSSProperties\)\}/)
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('6. 上部を1段に（表題行へ）', () => {
  it('表題行に置ける時は DailyHeaderBar を portal・開閉の保存キーは今までと同じ（LS.dailyBarOpen）', () => {
    const bar = fnSrc(daily, 'DailyHeaderBar')
    assert.match(bar, /storageKey=\{LS\.dailyBarOpen\}/)
    assert.match(bar, /collapsed=\{\(compact\) => <CollapsedDateBar/)
    assert.match(daily, /createPortal\(<DailyHeaderBar /)
  })

  it('倍率は日報の表題行とバイタル一覧（2026-11-01 本人裁定）が画面で選択欄1つ（ZoomSelect）・食事一覧は4ボタン（ZoomBar）のまま', () => {
    assert.match(fnSrc(daily, 'HeaderDateBar'), /<ZoomSelect \/>/)
    assert.doesNotMatch(fnSrc(daily, 'HeaderDateBar'), /<ZoomBar/)
    const meals = read('pages/MealsSheetPage.tsx')
    assert.doesNotMatch(meals, /ZoomSelect/, '食事一覧が選択欄になっている')
    assert.match(meals, /<ZoomBar/, '食事一覧の4ボタンが無い')
    // バイタル一覧: 画面は選択欄・紙は今までどおり4ボタン
    const vitals = read('pages/VitalsSheetPage.tsx')
    assert.match(vitals, /<div className="print:hidden">\s*<ZoomSelect \/>\s*<\/div>\s*<div className="hidden print:block">\s*<ZoomBar compact \/>\s*<\/div>/)
  })

  it('選択欄は ZoomBar と同じ store（ピンチに追従）・値は ZOOM_STEPS・今の倍率がボタンの値でない時も選択肢に出す・44px', () => {
    const sheet = read('components/sheet.tsx')
    const sel = fnSrc(sheet, 'ZoomSelect')
    assert.match(sel, /useSyncExternalStore\(subscribeZoom, getZoom/)
    assert.match(sel, /const steps: number\[\] = \[\.\.\.ZOOM_STEPS\]/)
    assert.match(sel, /if \(!steps\.includes\(zoom\)\) steps\.push\(zoom\)/)
    assert.match(sel, /onChange=\{\(e\) => setZoom\(Number\(e\.target\.value\)\)\}/)
    assert.match(sel, /aria-label="文字の大きさ（表示倍率）"/)
    assert.match(sel, /min-h-tap min-w-tap/)
    assert.match(sel, /\{`文字 \$\{z\}%`\}/)
  })

  it('表題行（日報の時だけ）: 640px 以上は折り返さず、見出しが日付バーより先に縮む（施設名が「…」）・画面だけ（紙の表題行は以前と同じ指定）', () => {
    const app = read('App.tsx')
    assert.match(app, /\$\{location\.pathname === '\/' \? ' cl-daily-header-row' : ''\}/)
    assert.match(app, /location\.pathname === '\/'\s*\? 'cl-daily-title flex items-baseline gap-2'\s*: location\.pathname === '\/sheet\/vitals'[\s\S]*?'flex min-w-0 flex-auto flex-wrap items-baseline gap-2'\s*: 'flex min-w-0 flex-1 flex-wrap items-baseline gap-2'/)
    assert.match(app, /<div id="cl-daily-header-slot" className="min-w-0 flex-1 basis-full sm:basis-auto print:hidden" \/>/)
    const plain = stripComments(css)
    // 640px 未満と紙: 以前の flex-1・折り返し・min-w-0 と同じ
    assert.match(plain, /\.cl-daily-title \{\s*flex: 1 1 0%;\s*flex-wrap: wrap;\s*min-width: 0;\s*\}/)
    const scr = mediaBlocks(css, 'screen and (min-width: 640px)')
    assert.equal(scr.length, 1, '640px 以上の表題行の指定が画面だけになっていない')
    assert.match(scr[0], /header \.cl-daily-header-row \{\s*flex-wrap: nowrap;/)
    assert.match(scr[0], /\.cl-daily-title \{\s*flex: 0 1000000 auto;\s*flex-wrap: nowrap;\s*min-width: max\(var\(--tap-min\), 2\.5rem\);/)
    assert.match(scr[0], /\.cl-daily-title > h1 \{\s*flex-shrink: 0;/)
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('7. 日と日の間', () => {
  it('印刷（既定）は 32px のまま・画面だけ 16px・同日内のブロック間（12px）より広い', () => {
    assert.match(css, /\.dsheet-day \+ \.dsheet-day \{[^}]*margin-top: var\(--sp-6\);/)
    const block = mediaBlocks(css, 'screen').find((b) => /\.dsheet-day \+ \.dsheet-day \{/.test(b))
    assert.ok(block, '画面だけの日の間の指定が無い')
    assert.match(block, /margin-top: var\(--sp-4\);/)
    assert.match(css, /\.dsheet-gap-block \{\s*margin-top: var\(--sp-3\);/)
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('8. 表題行と1日目の枠の間（画面だけ詰める）', () => {
  it('main の上の余白を 8px・紙用の日付バーのすぐ後の間隔を 0（間に帯がある時は空ける）・検索欄は表題行で 11rem', () => {
    const block = mediaBlocks(css, 'screen').find((b) => /main:has\(\.dsheet-frame\) \{\s*padding-top/.test(b))
    assert.ok(block, '画面だけの上の余白の指定が無い')
    assert.match(block, /main:has\(\.dsheet-frame\) \{\s*padding-top: var\(--sp-2\);/)
    assert.match(block, /\.space-y-4 > \.dsheet-printbar \+ \.dsheet-stack \{\s*margin-top: 0 !important;/)
    assert.match(block, /#cl-daily-header-slot \.dsheet-search-input \{\s*width: 11rem;/)
    assert.match(daily, /<div className="dsheet-stack !mt-2 space-y-1">/)
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('9. 表題行の未送信の札', () => {
  it('日報の表題行では未送信の札を縮めず1行のまま（画面・640px 以上だけ）', () => {
    assert.match(read('App.tsx'), /<span role="status" className=\{location\.pathname === '\/' \? 'cl-daily-status' : undefined\}>/)
    const scr = mediaBlocks(css, 'screen and (min-width: 640px)')
    assert.equal(scr.length, 1)
    assert.match(scr[0], /header \.cl-daily-status \{\s*flex-shrink: 0;\s*white-space: nowrap;/)
  })
})

describe('10. 対象の欄は氏名の長さ程度に詰め、入らない名前は画面だけ折り返す（2026-11-01）', () => {
  it('申し送りの対象の PickerCell だけが wrap を渡し、折り返しの規則は @media screen の中だけ', () => {
    assert.match(daily, /deleteLabel=\{targetText === '' \? 'この行を削除' : `\$\{targetText\}のこの申し送りを削除`\}\s*wrap\s*\/>/)
    assert.equal((daily.match(/^\s+wrap\s*$/gm) ?? []).length, 1)
    assert.match(daily, /className=\{wrap \? 'dsheet-pick-wrap block truncate' : 'block truncate'\}/)
    const scr = mediaBlocks(css, 'screen').join('\n')
    assert.match(scr, /\.dsheet-legible \.dsheet-pick-wrap \{\s*white-space: normal;\s*overflow: visible;\s*text-overflow: clip;\s*overflow-wrap: anywhere;/)
    const outside = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
    assert.doesNotMatch(outside, /dsheet-pick-wrap/)
  })
})
