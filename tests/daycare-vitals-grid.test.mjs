// デイ せせらぎ 今日の画面の改善 2回目: バイタル一括の見た目を定時バイタルの形（1行1人の表＋下のテンキー）にそろえた回帰テスト
// （2026-10-24・代表承認・決定 8／親の回答 3〜5）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycare.ts）: 表の列の見出し・状態の列の短い印
// 2. 静的検査: 表の形（氏名の列は左に残す・列の並び・再測定は行の下・基準の札は氏名の下・前回の値は空の欄だけ）・
//    テンキーはどの幅でも下（数字3列＋右にボタン・文言は今のまま）・動き（press・保存・冪等キー）は変えていない
// 個人情報は置かない。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
/** 行コメントと複数行コメントを除いた本文 */
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

let DC = null
let loadError = null
try {
  const { registerHooks } = await import('node:module')
  if (typeof registerHooks !== 'function') throw new Error('no registerHooks')
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
  DC = await import('../src/lib/daycare.ts?daycare-vitals-grid')
} catch (e) {
  loadError = e
  DC = null
}

if (DC === null) {
  registerLoadFailure('デイ バイタル一括の表の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('純ロジック', () => {
    it('列の見出しは定時バイタルと同じ短い呼び名（KT・上・下・P・SpO2）', () => {
      assert.deepEqual(DC.DAYCARE_VITAL_FIELDS.map((f) => DC.DAYCARE_VITAL_HEAD[f]), ['KT', '上', '下', 'P', 'SpO2'])
    })
    it('状態の列の印: 手当てが要る方（食い違い・止まり・拒否・失敗）が先・送信中・未送信・保存済み・無し', () => {
      for (const [k, p] of [['conflict', null], ['error', null], ['held', null], [undefined, 'conflict'], ['saved', 'rejected']])
        assert.deepEqual(DC.dcVitalSlotMark(k, p), { mark: '▲', text: '要確認', tone: 'warn' }, `${k}/${p}`)
      assert.deepEqual(DC.dcVitalSlotMark('saving', 'pending'), { mark: '↻', text: '送信中', tone: 'info' })
      assert.deepEqual(DC.dcVitalSlotMark('queued', null), { mark: '⚠', text: '未送信', tone: 'warn' })
      assert.deepEqual(DC.dcVitalSlotMark(undefined, 'pending'), { mark: '⚠', text: '未送信', tone: 'warn' })
      assert.deepEqual(DC.dcVitalSlotMark('saved', null), { mark: '✓', text: '保存済み', tone: 'ok' })
      assert.equal(DC.dcVitalSlotMark(undefined, null), null)
    })
  })

  describe('静的検査（表の形）', () => {
    const page = code('../src/pages/DaycareVitalsPage.tsx')
    it('1行1人の表（横スクロールは枠の中だけ・氏名の列は左に残す・列は 氏名｜KT｜上｜下｜P｜SpO2｜再測定｜状態）', () => {
      assert.match(page, /<table className="w-full min-w-max border-collapse text-base">/)
      // 2026-10-28 見出しの行を上に残す（固定し直し・意図は同じ）: 枠に高さの上限（.dc-table-fit・useTableFit）を付けて枠の中で縦にも送る。
      // 見出しの行は sticky top-0（角の氏名は z-30・ほかの見出しは z-20）、氏名の列は z-10。枠は isolate でアプリの見出しの上に重ならない
      assert.match(page, /tabIndex=\{tableScrolls \|\| tableScrollsY \? 0 : undefined\}\s+className="dc-table-fit relative isolate overflow-auto"/)
      // テンキーが開いている間は、その高さも下に貼り付く部品として引く
      assert.match(page, /useTableFit\(tableBox, active !== null \? kpHeight : 0\)/)
      assert.match(page, /<th key=\{f\} scope="col" className="sticky top-0 z-20 w-24 bg-surface2 px-2 py-2 text-sm font-bold text-ink2">/)
      assert.equal((page.match(/<th scope="col" className="sticky top-0 z-20 w-28 bg-surface2 px-2 py-2 text-sm font-bold text-ink2">/g) ?? []).length, 2, '再測定・状態の見出しも上に残す')
      // 入れている欄は枠の中に見せる（テンキーで枠が縮んでも隠れない）
      assert.match(page, /data-dc-active=\{isActive \? '' : undefined\}/)
      assert.match(page, /if \(active === null \|\| tableBox === null \|\| kpHeight === 0\) return\s+const cell = tableBox\.querySelector<HTMLElement>\('\[data-dc-active\]'\)/)
      // 枠の後ろがすぐページの終わりなら、後ろの余白も引く（一番下まで送っても見出しの行がアプリの見出しの下に入らない＝反証 重1）
      const fit = code('../src/lib/useTableFit.ts')
      assert.match(fit, /const want = Math\.max\(fixed, flowAfter\(el\) \+ FIT_GAP\)/)
      assert.match(fit, /write\('--dc-fit-below', extraBelow > 0 \|\| window\.innerHeight - top - want >= minFrame \? want : fixed\)/)
      assert.match(page, /const over = tableBox\.getBoundingClientRect\(\)\.bottom - \(kpBox !== null \? kpBox\.getBoundingClientRect\(\)\.top : window\.innerHeight\)\s+if \(over > 0\) window\.scrollBy\(0, over\)\s+cell\.scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/)
      assert.match(page, /<th scope="col" className="sticky left-0 top-0 z-30 bg-surface2 px-2 py-2 text-sm font-bold text-ink2">\s*<span className="dc-vital-name block">氏名<\/span>\s*<\/th>/)
      // 氏名の列の幅は札の長さで広げない（7rem と画面幅の35% の小さい方・中で折り返す＝#45 の確認の反証 重）
      assert.match(page, /<div className="dc-vital-name">/)
      assert.match(read('../src/index.css'), /\.dc-vital-name \{\s*width: min\(7rem, 35vw\);\s*(\/\*[\s\S]*?\*\/\s*)?min-width: 100%;\s*overflow-wrap: anywhere;/)
      assert.match(page, /<th scope="row" className="sticky left-0 z-10 bg-bg px-2 py-1 text-left font-normal">/)
      assert.match(page, /\{DAYCARE_VITAL_FIELDS\.map\(\(f\) => \(\s*<th key=\{f\} scope="col"/)
      const head = page.slice(page.indexOf('<thead>'), page.indexOf('</thead>'))
      assert.ok(head.indexOf('氏名') < head.indexOf('DAYCARE_VITAL_FIELDS') && head.indexOf('DAYCARE_VITAL_FIELDS') < head.indexOf('再測定') && head.indexOf('再測定') < head.indexOf('状態'))
      // 表が枠より広い時だけ手がかりを出す（定時バイタルと同じ）
      assert.match(page, /const check = \(\) => \{\s*setTableScrolls\(el\.scrollWidth > el\.clientWidth \+ 1\)\s*setTableScrollsY\(el\.scrollHeight > el\.clientHeight \+ 1\)\s*setTableBoxWidth\(el\.clientWidth\)/)
      assert.match(page, /表は横にスクロールできます（氏名の列は左に残ります）/)
      // カードの一覧（1人1枚・5欄の格子）は無い
      assert.doesNotMatch(page, /grid grid-cols-5|aria-label="バイタルの一覧"/)
    })
    it('再測定はその方の行のすぐ下に「↳ 再測定 n」の行・基準の札は氏名の下・〔＋再測定〕は再測定の列', () => {
      assert.match(page, /return slots\.map\(\(slot, si\) => \{/)
      assert.match(page, /<span aria-hidden="true">↳ <\/span>\s*再測定 \{si\}/)
      assert.match(page, /<span className="block text-base font-bold text-ink">\{nameOf\(row\.residentId\)\}<\/span>\s*<span className="block text-sm text-ink2">\{basis\}<\/span>/)
      assert.match(page, /\{abnormal && isLast \? \(\s*<button[\s\S]{0,200}onClick=\{\(\) => addRecheck\(row, slot\)\}/)
      assert.match(page, /＋再測定/)
    })
    it('前回の値は空の欄にだけ薄く出す（値が入った欄は値＋印と判定語）', () => {
      assert.match(page, /\{v === null \? \(\s*<span className="font-num text-sm text-ink3" aria-hidden="true">\s*\{pv \? `前回\$\{fmtVal\(f, pv\.value\)\}` : '—'\}/)
      assert.match(page, /\{lv !== null \? <span aria-hidden="true">\{LEVEL_MARK\[lv\]\}<\/span> : null\}/)
      assert.match(page, /\{lv !== null \? <span className="text-sm font-bold leading-tight text-ink">\{word\.split\('・'\)\[0\]\}<\/span> : null\}/)
      // 読み上げは前と同じ（前回の値・未送信も読む）
      assert.match(page, /\$\{pv \? `、前回 \$\{fmtVal\(f, pv\.value\)\}` : ''\}\$\{local \? '、未送信' : ''\}/)
    })
    it('行の下の詳しい文は表の幅を広げない（幅0＋最小100% の箱・枠の幅で折り返して左に残す＝定時バイタルの F01 と同じ・#45 の反証 重1）', () => {
      assert.match(
        page,
        /<td colSpan=\{DAYCARE_VITAL_FIELDS\.length \+ 3\} className="p-0">\s*<div className="w-0 min-w-full">\s*<div className="sticky left-0 px-2 pb-2" style=\{\{ maxWidth: tableBoxWidth > 0 \? tableBoxWidth : undefined \}\}>\s*<SlotStatus /,
      )
    })
    it('送信中・保存済みも読み上げる（role="status"）・保存済みでも送信待ちが動けば詳しい文を出す（#45 の反証 軽3・軽4）', () => {
      assert.match(page, /<span role="status" className=\{`text-sm font-bold \$\{mark\.tone/)
      assert.match(page, /const detail = shown\?\.kind === 'saving' \? false : \(shown !== undefined && shown\.kind !== 'saved'\) \|\| pend !== null/)
    })
    it('状態の列は短い印（dcVitalSlotMark）・詳しい文と解き方は行の下（SlotStatus のまま）', () => {
      assert.match(page, /const mark = dcVitalSlotMark\(shown\?\.kind, pend\?\.state \?\? null\)/)
      assert.match(page, /<SlotStatus st=\{shown\} pend=\{pend\?\.state \?\? null\} onTake=\{\(c\) => void resolveTake\(slot, c\)\} onMine=\{\(c\) => void resolveMine\(slot, c\)\} \/>/)
      assert.match(page, /conflicts: withCurrentMine\(slot, pend\.conflicts\)/)
      assert.match(page, /conflicts: withCurrentMine\(slot, st\.conflicts\)/)
    })
  })

  describe('静的検査（テンキーと、変えていない動き）', () => {
    const page = code('../src/pages/DaycareVitalsPage.tsx')
    it('テンキーはどの幅でも画面の下（右に常に出す置き方は無い）・数字3列（1 2 3 が上）＋右にボタン', () => {
      assert.match(page, /<section ref=\{setKpBox\} aria-label="テンキー" className="dc-keypad fixed inset-x-0 bottom-14 z-40 border-t border-border-strong bg-surface p-3 lg:bottom-0">/)
      // 文字を大きくしても画面の上へはみ出さない（収まらない分はテンキーの中でスクロール）
      assert.match(read('../src/index.css'), /\.dc-keypad \{\s*max-height: calc\(100dvh - 3\.5rem\);\s*overflow-y: auto;/)
      assert.doesNotMatch(page, /lg:sticky|lg:w-80/)
      assert.match(page, /<div className="grid grid-cols-3 gap-gap">\s*\{DC_KEYPAD_KEYS\.map/)
      const keys = page.slice(page.indexOf('const DC_KEYPAD_KEYS'), page.indexOf(']\n', page.indexOf('const DC_KEYPAD_KEYS')) + 1)
      assert.deepEqual([...keys.matchAll(/\['([^']+)', '([^']+)'\]/g)].map((m) => m[1]), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'])
      // テンキーを出している間は、テンキーと同じ高さの余白をとる（最後の行もテンキーに隠れない）
      assert.match(page, /\{active !== null \? <div aria-hidden="true" style=\{\{ height: kpHeight \}\} \/> : null\}/)
      assert.match(page, /const check = \(\) => setKpHeight\(Math\.ceil\(el\.getBoundingClientRect\(\)\.height\)\)/)
    })
    it('右のボタンの文言と動きは今のまま（次へ・未測定・閉じる＝press の next・skip・close）', () => {
      assert.match(page, /onClick=\{\(\) => press\('next'\)\}[\s\S]{0,200}>\s*次へ\s*<\/button>/)
      assert.match(page, /onClick=\{\(\) => press\('skip'\)\}\s*aria-label="未測定（空欄のまま次の欄へ）"[\s\S]{0,200}>\s*未測定\s*<\/button>/)
      assert.match(page, /onClick=\{\(\) => press\('close'\)\}[\s\S]{0,200}>\s*閉じる\s*<\/button>/)
      assert.match(page, /disabled=\{k === '\.' && active\.field !== 'temp'\}/)
      assert.doesNotMatch(page, /確定して次へ|未測定のまま次へ|閉じて保存する/)
    })
    it('押した時の動き（桁がそろうと次へ）・保存（冪等キー dc:・saveVitalEdits）は変えていない', () => {
      assert.match(page, /if \(nb !== buf && keypadComplete\(active\.field, nb\)\) commit\(active, nb, false\)/)
      assert.match(page, /if \(key === 'next'\) return commit\(active, buf, false\)/)
      assert.match(page, /if \(key === 'skip'\) return commit\(active, '', true\)/)
      assert.match(page, /if \(key === 'close'\) return closeKeypad\(\)/)
      assert.match(page, /saveVitalEdits\(/)
      // 「自動」の印は出さない（送信待ちの決まり文句「電波が戻ると自動で送信します」は全画面共通なので除く）
      assert.doesNotMatch(page.replace("'電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'", ''), /自動/)
    })
  })
}
