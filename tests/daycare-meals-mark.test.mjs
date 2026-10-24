// デイ せせらぎ 今日の画面の改善 3回目: care-log の食事の画面の「デイ」の印と、ボタンの角（2026-10-24・代表承認・決定 5・7／親の回答 1〜3）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycare.ts）: 到着の数え方（到着の時刻があり休みでない・形の崩れた行は数えない）
// 2. 静的検査: 到着は表示中の日の範囲を1回で読む（0047 の列は読まない）・読めない時は印を出さないだけ・
//    食事の表は昼食の欄の枠と主食の前の「デ」と読み上げ「デイに来所」・凡例・印刷には出さない・
//    食事一括は「昼」の時だけカードの枠と「デイ」の札・ボタンの角は 6px（押せない札と水分の横棒は丸いまま）
// 個人情報は置かない（利用者は数値IDだけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
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
  DC = await import('../src/lib/daycare.ts?daycare-meals-mark')
} catch (e) {
  loadError = e
  DC = null
}

if (DC === null) {
  registerLoadFailure('デイ 食事の画面の印の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('純ロジック: 到着の数え方', () => {
    it('到着の時刻があり休みでない記録だけ（休み・時刻なし・形の崩れた行は数えない）・鍵は 利用者:日', () => {
      const keys = DC.daycareArrivalKeys([
        { resident_id: 3, day: '2026-10-23', arrived_at: '09:00:00', absent: false },
        { resident_id: 4, day: '2026-10-23', arrived_at: null, absent: true },
        { resident_id: 5, day: '2026-10-23', arrived_at: '09:30:00', absent: true },
        { resident_id: 6, day: '2026-10-23', arrived_at: null, absent: false },
        { resident_id: 7, day: '2026-10-22', arrived_at: '09:05:00', absent: false },
        { resident_id: 'x', day: '2026-10-23', arrived_at: '09:00:00', absent: false },
        { resident_id: 8, day: '10/23', arrived_at: '09:00:00', absent: false },
        { resident_id: '9', day: '2026-10-23', arrived_at: '09:10:00', absent: false },
      ])
      assert.deepEqual([...keys].sort(), ['3:2026-10-23', '7:2026-10-22', '9:2026-10-23'])
      assert.equal(DC.daycareArrivalKey(3, '2026-10-23'), '3:2026-10-23')
    })
  })

  describe('静的検査: 到着の読み取り（db.ts）', () => {
    const d = code('../src/lib/db.ts')
    const f = d.slice(d.indexOf('export async function fetchDaycareArrivals'), d.indexOf('function assertAttendanceInput'))
    it('日の範囲を1回の読み取りで（gte・lte）・休みでない・到着の時刻あり・消していない・0047 の列は読まない', () => {
      assert.match(f, /\.select\('resident_id,day,arrived_at,absent'\)\s*\.gte\('day', fromIso\)\s*\.lte\('day', toIso\)\s*\.eq\('absent', false\)\s*\.not\('arrived_at', 'is', null\)\s*\.is\('deleted_at', null\)/)
      assert.doesNotMatch(f, /arrived_auto|left_auto|DAYCARE_ATTENDANCE_AUTO_COLS/)
      assert.equal((f.match(/\.from\(/g) ?? []).length, 1)
      assert.match(f, /return daycareArrivalKeys\(rows\)/)
    })
  })

  describe('静的検査: 到着の読み直し（src/hooks/useDaycareArrivals.ts・#46 の反証 重1）', () => {
    const h = code('../src/hooks/useDaycareArrivals.ts')
    it('到着・休みの変更の知らせ（Realtime）・画面に戻った時・電波が戻った時・5分ごとに読み直す（続けて来ても1秒まとめる）', () => {
      assert.match(h, /const off = subscribeDaycareChanges\(\(\) => later\(\)\)/)
      assert.match(h, /window\.addEventListener\('online', later\)/)
      assert.match(h, /document\.addEventListener\('visibilitychange', onVisible\)/)
      assert.match(h, /const REFRESH_MS = 5 \* 60_000/)
      assert.match(h, /const iv = window\.setInterval\(later, REFRESH_MS\)/)
      assert.match(h, /const DEBOUNCE_MS = 1000/)
      // 片付け（知らせの購読・合図・時計）
      assert.match(h, /off\(\)\s*window\.removeEventListener\('online', later\)\s*document\.removeEventListener\('visibilitychange', onVisible\)\s*window\.clearInterval\(iv\)/)
    })
    it('読めない時: 範囲が変わった後なら空（印を出さない）・同じ範囲の読み直しの失敗なら前の印を残す', () => {
      assert.match(h, /fetchDaycareArrivals\(fromIso, toIso\)/)
      assert.match(h, /\.catch\(\(\) => \{\s*if \(!alive\) return\s*if \(okRangeRef\.current !== range\) setArrivals\(new Set\(\)\)\s*\}\)/)
      assert.match(h, /\}, \[fromIso, toIso, tick\]\)/)
    })
  })

  describe('静的検査: 食事の表（MealsSheetPage）', () => {
    const p = code('../src/pages/MealsSheetPage.tsx')
    it('表示中の日の範囲を1回で読み、変わったら読み直す（useDaycareArrivals）・〔最新〕でも読み直す', () => {
      assert.match(p, /const \{ arrivals: dcArrivals, refresh: refreshDcArrivals \} = useDaycareArrivals\(fromIso, toIso\)/)
      assert.match(p, /void load\(\)\s*refreshDcArrivals\(\)/)
    })
    it('他の端末が入力中の欄には、デイの枠を出さない（入力中の点線と取り違えない・#46 の反証 中2）', () => {
      assert.match(p, /\$\{dc && !busy \? ' cl-dc-frame' : ''\}/)
    })
    it('「デ10」でも枠の線にかからない（デイの欄だけ数字の字の間を詰める・紙は詰めない・#46 の反証 軽3）', () => {
      assert.match(p, /\$\{dcMark \? ' cl-dc-amount' : ''\}/)
      const css = read('../src/styles/sheet.css')
      assert.match(css, /\.cl-dc-mark \{[^}]*font-size: 0\.7em;\s*letter-spacing: 0;\s*\}/)
      assert.match(css, /\.cl-dc-amount \{\s*letter-spacing: -0\.1em;\s*\}/)
      assert.match(css, /@media print \{[^@]*\.cl-dc-amount \{\s*letter-spacing: inherit;\s*\}/)
    })
    it('昼食の欄だけ: 枠（cl-dc-frame）・主食の数字の前の「デ」（副食には付けない）・読み上げ「デイに来所」', () => {
      assert.match(p, /const dc = slot === 'lunch' && dcArrivals\.has\(daycareArrivalKey\(r\.id, d\)\)/)
      assert.match(p, /const dcWord = dc \? '。デイに来所' : ''/)
      assert.match(p, /\$\{dc && !busy \? ' cl-dc-frame' : ''\}/)
      assert.equal((p.match(/dcMark=\{dc\}/g) ?? []).length, 1)
      assert.match(p, /dcMark=\{dc\}\s*ariaLabel=\{`\$\{r\.name\} \$\{dayLabel\} \$\{slotLabel\} 主食 /)
      assert.ok(p.includes("副食 ${eff.side_amount ?? '未入力'}${low ? '。低摂取' : ''}${mark ? `。${mark.label}` : ''}${dcWord}`}"))
      assert.match(p, /\{dcMark \? \(\s*<span className="sheet-mark cl-dc-mark" aria-hidden="true">\s*デ\s*<\/span>/)
      // 欠食（拒食など）の時も「デ」と読み上げ
      assert.match(p, /\$\{MEAL_STATUS_LABEL\[absentStatus\]\}\$\{halfWord\}\$\{dcWord\}。食事の状態を変える/)
      // 塗りは使わない（濃淡・低摂取の地はそのまま）
      assert.doesNotMatch(p, /cl-dc-frame[^`'"]*bg-/)
    })
    it('凡例は画面だけ（印刷に出さない）・表に出ている行に印がある時だけ（#46 の反証 軽6）', () => {
      assert.match(p, /\{visible\.some\(\(r\) => dayList\.some\(\(d\) => dcArrivals\.has\(daycareArrivalKey\(r\.id, d\)\)\)\) \? \(\s*<span className="print:hidden">デ・枠＝その日にデイへ来た方（昼食）。<\/span>\s*\) : null\}/)
    })
    it('印刷には出さない（CSS: 枠と「デ」を print で消す）・枠は info の線を内側に 2px（行の高さを変えない）', () => {
      const css = read('../src/styles/sheet.css')
      assert.match(css, /\.cl-dc-frame \{\s*outline: 2px solid var\(--c-info\);\s*outline-offset: -2px;\s*\}/)
      assert.match(css, /@media print \{\s*\.cl-dc-frame \{\s*outline: none;\s*\}\s*\.cl-dc-mark \{\s*display: none;\s*\}/)
    })
  })

  describe('静的検査: 食事一括（MealsGridPage）', () => {
    const p = code('../src/pages/MealsGridPage.tsx')
    it('開いた日の分を1回で読み、変わったら読み直す（useDaycareArrivals）・〔最新を読み込む〕でも読み直す', () => {
      assert.match(p, /const \{ arrivals: dcArrivals, refresh: refreshDcArrivals \} = useDaycareArrivals\(day, day\)/)
      assert.match(p, /void load\(\)\s*refreshDcArrivals\(\)/)
    })
    it('「昼」を選んでいる時だけ: カードの枠と氏名の横の「デイ」の札（読み上げは「デイに来所」）', () => {
      assert.match(p, /dcArrived=\{slot === 'lunch' && dcArrivals\.has\(daycareArrivalKey\(r\.id, day\)\)\}/)
      assert.match(p, /<li className=\{`rounded-md border border-border bg-surface p-3\$\{dcArrived \? ' cl-dc-frame' : ''\}`\}>/)
      // 押せない札なので丸い札・印刷には出さない（#46 の反証 軽4・軽5）
      assert.match(p, /\{dcArrived \? \(\s*<span className="shrink-0 rounded-full border border-info px-2 text-sm font-bold text-info print:hidden">\s*デイ<span className="sr-only">に来所<\/span>/)
    })
  })

  describe('静的検査: ボタンの角（決定5・6px）', () => {
    it('残る rounded-full は、押せない札と水分の横棒だけ（ボタンには無い）', () => {
      const files = []
      const walk = (dir) => {
        for (const e of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
          if (e.isDirectory()) walk(`${dir}${e.name}/`)
          else if (/\.tsx?$/.test(e.name)) files.push(`${dir}${e.name}`)
        }
      }
      walk('../src/')
      const hits = []
      for (const f of files) {
        const lines = code(f).split('\n')
        lines.forEach((l, i) => {
          if (l.includes('rounded-full')) hits.push(`${f.replace('../src/', '')}: ${l.trim().slice(0, 60)}`)
        })
      }
      // どれも <span>（押せない札・横棒）。<button> には付いていない
      for (const h of hits) assert.match(h, /<span |\$\{base\} rounded-full/, h)
      // 押せない札7か所（食事一括の「デイ」の札＝今回を含む）＋カルテの水分の横棒1か所＝8
      // （食事の表の水分の横棒 .cl-fluid-bar は sheet.css の border-radius: 9999px で、ここには数えない）
      assert.equal(hits.length, 8, hits.join('\n'))
    })
    it('ボタンは rounded（6px）: 申し送りの分類・申し送りの入力・カルテの欄へ移動・押せるチップ', () => {
      assert.match(code('../src/components/noteCategory.tsx'), /className=\{`dsheet-cat-btn min-h-tap shrink-0 rounded px-3 text-base/)
      const nf = code('../src/pages/NoteFormPage.tsx')
      assert.equal((nf.match(/'min-h-tap rounded border/g) ?? []).length, 2)
      assert.equal((nf.match(/'min-h-tap max-w-full rounded border/g) ?? []).length, 2)
      assert.match(code('../src/pages/KartePage.tsx'), /className="inline-flex min-h-tap items-center whitespace-nowrap rounded border border-border-strong bg-surface px-3 text-sm text-link"/)
      const ui = code('../src/components/ui.tsx')
      assert.match(ui, /return <span className=\{`\$\{base\} rounded-full \$\{className\}`\}>\{children\}<\/span>/)
      assert.match(ui, /className=\{`\$\{base\} rounded relative before:absolute/)
      // 選んでいる分類のボタン（CSS）も 6px。印刷に出る分類の札（.dsheet-cat）は 4px のまま
      const css = read('../src/styles/sheet.css')
      assert.match(css, /\.dsheet-cat-btn\.dsheet-cat-on \{\s*border-width: 2px;\s*(\/\*[\s\S]*?\*\/\s*)?border-radius: var\(--r-md\);/)
      assert.match(css, /\.dsheet-cat \{\s*display: inline-block;\s*padding: 0 0\.25em;\s*border: 1px solid transparent;\s*border-radius: var\(--r-sm\);/)
    })
  })
}
