// バイタル・食事・水分の見やすさ（A1・A2・A3・A4・A6・A9。2026-10-16 本人回答）の一覧・一括・日報の画面の試験。
// 直す前の版（印・濃淡・横棒・細い線の無い版）では宣言・トークン・クラスが見つからずに失敗し、直した後に成功する形。
//   1. A6 の色のトークン（tokens.css）: 5段階の地と文字・斜線の線を ライト／ダーク（data-mode と OS 追従の2か所）／印刷 で定義し、
//      地と文字（トークンの文字・食事一覧の朝＝赤・昼＝緑・夕・低摂取の warn）のコントラストを実値から計算して 4.5:1 以上
//   2. 部品のクラス（sheet.css）: 斜線は印刷にも出す（print-color-adjust）・横棒・細い線・平熱の印は画面だけ・▼は紙にも出す
//   3. 食事一覧（MealsSheetPage）: A6 の濃淡と斜線・A2 の ▼ と前の日の読み込み・A3 の横棒（画面だけ）・判定は useMemo
//   4. 食事一括（MealsGridPage）: A6・A2・A3（「800／1,200ml（67%）」と横棒）
//   5. バイタル一括（VitalsGridPage）: A1 の「平熱+1.2↑」と注記・A9 の個別の下限・読み上げの語
//   6. バイタル一覧（VitalsSheetPage）: A9・A1 の読み上げ・A4 の細い線（7日・全員同じ縦軸・画面だけ・前の日の読み込み）
//   7. 日報（DailySheetPage）: 発熱者・他症状者の欄の A1・A9（文脈で渡す＝1日ぶんの枠を描き直さない）
// 純関数は画面のソースから宣言を抜き出して型を剥がして評価する（画面の部品は描かない）。配線は正規表現で確かめる。
// 直す前の版で確かめる時は CL_TEST_SRC に直す前の src の写し（pages・styles）のフォルダを渡す（lib は本物を読む）。
// 実行: npm test。個人情報は置かない（合成の id と数値だけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { performance } from 'node:perf_hooks'
import { registerLoadFailure } from './ts-load.mjs'

const SRC = process.env.CL_TEST_SRC
  ? pathToFileURL(process.env.CL_TEST_SRC.replace(/\/?$/, '/')).href
  : new URL('../src/', import.meta.url).href
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')
const tokens = read('styles/tokens.css')
const css = read('styles/sheet.css')
const mealsSheet = read('pages/MealsSheetPage.tsx')
const mealsGrid = read('pages/MealsGridPage.tsx')
const vitalsGrid = read('pages/VitalsGridPage.tsx')
const vitalsSheet = read('pages/VitalsSheetPage.tsx')
const daily = read('pages/DailySheetPage.tsx')

let VA = null
let loadError = null
try {
  VA = await import('../src/lib/vitalAlerts.ts')
} catch (e) {
  loadError = e
}
const loaded = VA !== null
if (!loaded) {
  registerLoadFailure('判定の純関数（vitalAlerts.ts）', loadError, 'この Node では TypeScript を直接読み込めないため、判定を使う画面の試験をスキップしました（Node 22.18 以降で実行してください）')
}

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

// ── コントラスト（WCAG 2.x の相対輝度） ──
const lin = (c) => {
  const x = c / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}
const lum = (hex) => {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const contrast = (a, b) => {
  const x = lum(a)
  const y = lum(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** CSS のある規則（selector の文字列そのもの）の中身。@media の中なら media の文字列も渡す */
function ruleBody(src, selector, media = null) {
  let scope = src
  if (media !== null) {
    const at = src.indexOf(media)
    assert.ok(at >= 0, `${media} が見つからない`)
    scope = src.slice(at)
  }
  const at = scope.indexOf(`${selector} {`)
  assert.ok(at >= 0, `${selector} の規則が見つからない`)
  const open = scope.indexOf('{', at)
  const close = scope.indexOf('}', open)
  return scope.slice(open + 1, close)
}
/** selector の規則のうち、name の変数を持つものの中身（同じ selector の規則が複数ある時に使う） */
function blockWith(src, selector, name) {
  let from = 0
  for (;;) {
    const at = src.indexOf(`${selector} {`, from)
    assert.ok(at >= 0, `${name} を持つ ${selector} の規則が見つからない`)
    const open = src.indexOf('{', at)
    const close = src.indexOf('}', open)
    const body = src.slice(open + 1, close)
    if (body.includes(`${name}:`)) return body
    from = close
  }
}
/** 規則の中の変数の値（#rrggbb・transparent） */
function varOf(body, name) {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(body)
  assert.ok(m, `${name} が定義されていない`)
  return m[1].trim()
}

const SHADE_TOKEN_START = tokens.indexOf('/* ── 摂取量の濃淡（A6')

// ══════════════════════════════════════════════════════════════════════
describe('1. A6 の色のトークン（tokens.css）', () => {
  it('5段階の地と文字・斜線の線を、ライト・ダーク（data-mode）・ダーク（OS 追従）・印刷の4か所で定義する（名前はカルテと共通）', () => {
    assert.ok(SHADE_TOKEN_START >= 0, 'A6 の節が無い')
    const part = tokens.slice(SHADE_TOKEN_START)
    const blocks = [
      ruleBody(part, ':root'),
      ruleBody(part, ":root[data-mode='dark']"),
      ruleBody(part, ":root:not([data-mode='light'])", '@media (prefers-color-scheme: dark)'),
      ruleBody(part, ":root:not([data-mode='light'])", '@media print'),
    ]
    for (const b of blocks) {
      for (let i = 0; i <= 4; i++) {
        varOf(b, `--cl-shade-${i}-bg`)
        varOf(b, `--cl-shade-${i}-ink`)
      }
      varOf(b, '--cl-shade-hatch-line')
      // 全量（段階4）は地を塗らない＝いつもの表（縞・白地）のまま
      assert.equal(varOf(b, '--cl-shade-4-bg'), 'transparent')
    }
    // 印刷の規則はダークの規則より後ろ（同じ詳細度なので後ろが勝つ＝ダーク表示のまま刷っても紙は明るい）
    assert.ok(part.indexOf('@media print') > part.indexOf('@media (prefers-color-scheme: dark)'))
    assert.match(part, /@media print \{\s*:root,\s*:root\[data-mode\],\s*:root:not\(\[data-mode='light'\]\) \{/)
    // 2つのダークの定義は同じ値（設定で選んだ時と OS 追従の時で色が変わらない）
    for (let i = 0; i <= 3; i++) {
      assert.equal(varOf(blocks[1], `--cl-shade-${i}-bg`), varOf(blocks[2], `--cl-shade-${i}-bg`))
      assert.equal(varOf(blocks[1], `--cl-shade-${i}-ink`), varOf(blocks[2], `--cl-shade-${i}-ink`))
    }
  })

  it('地と文字のコントラストを実値から計算して 4.5:1 以上（トークンの文字・朝＝赤・昼＝緑・夕・低摂取の warn。ライト／ダーク／印刷）', () => {
    assert.ok(SHADE_TOKEN_START >= 0, 'A6 の節が無い')
    const part = tokens.slice(SHADE_TOKEN_START)
    const light = ruleBody(part, ':root')
    const dark = ruleBody(part, ":root[data-mode='dark']")
    const print = ruleBody(part, ":root:not([data-mode='light'])", '@media print')
    // 食事一覧の文字色（sheet.css の --msheet-c-*）と warn・ink（tokens.css の ops）の実値
    const sheetLight = blockWith(css, ':root', '--msheet-c-breakfast')
    const sheetDark = blockWith(css, ":root[data-mode='dark']", '--msheet-c-breakfast')
    const opsLight = ruleBody(tokens, '[data-ds="ops"], [data-ds="ops"][data-mode="light"]')
    const opsDark = ruleBody(tokens, '[data-ds="ops"][data-mode="dark"]')
    const fgLight = {
      朝: varOf(sheetLight, '--msheet-c-breakfast'),
      昼: varOf(sheetLight, '--msheet-c-lunch'),
      夕: varOf(opsLight, '--c-ink'),
      warn: varOf(opsLight, '--c-warn'),
      ink2: varOf(opsLight, '--c-ink2'),
    }
    const fgDark = {
      朝: varOf(sheetDark, '--msheet-c-breakfast'),
      昼: varOf(sheetDark, '--msheet-c-lunch'),
      夕: varOf(opsDark, '--c-ink'),
      warn: varOf(opsDark, '--c-warn'),
      ink2: varOf(opsDark, '--c-ink2'),
    }
    // 紙は白地に黒＋色の文字（朝＝赤・昼＝緑はライトの値で刷られる）
    const fgPrint = { 朝: fgLight.朝, 昼: fgLight.昼, warn: fgLight.warn }
    const rows = []
    for (const [mode, body, fg] of [
      ['ライト', light, fgLight],
      ['ダーク', dark, fgDark],
      ['印刷', print, fgPrint],
    ]) {
      for (let i = 0; i <= 3; i++) {
        const bg = varOf(body, `--cl-shade-${i}-bg`)
        const pairs = { [`ink${i}`]: varOf(body, `--cl-shade-${i}-ink`), ...fg }
        for (const [name, color] of Object.entries(pairs)) {
          const c = contrast(bg, color)
          rows.push({ mode, stage: i, name, c })
          assert.ok(c >= 4.5, `${mode} 段階${i} × ${name}: ${c.toFixed(2)} < 4.5`)
        }
      }
      // 段階は少ない方ほど濃い（ライト・印刷は輝度が下がる・ダークは上がる）＝濃淡の向きが揃っている
      const L = [0, 1, 2, 3].map((i) => lum(varOf(body, `--cl-shade-${i}-bg`)))
      for (let i = 0; i < 3; i++) {
        if (mode === 'ダーク') assert.ok(L[i] > L[i + 1], `${mode} 段階${i} が段階${i + 1} より濃くない`)
        else assert.ok(L[i] < L[i + 1], `${mode} 段階${i} が段階${i + 1} より濃くない`)
      }
    }
    // tokens.css の注記の最小値と計算値が食い違っていない
    const minOf = (mode) => Math.min(...rows.filter((r) => r.mode === mode).map((r) => r.c))
    const note = (label) => Number(new RegExp(`${label}[^\\n]*最小 ([0-9.]+)`).exec(part)?.[1])
    assert.equal(note('ライト').toFixed(2), minOf('ライト').toFixed(2))
    assert.equal(note('ダーク').toFixed(2), minOf('ダーク').toFixed(2))
    assert.equal(note('印刷').toFixed(2), minOf('印刷').toFixed(2))
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('2. 部品のクラス（sheet.css）', () => {
  it('斜線は repeating-linear-gradient の線・濃淡と斜線のマスは印刷でも刷る（print-color-adjust: exact）', () => {
    const hatch = ruleBody(css, '.cl-shade-hatch')
    assert.match(hatch, /repeating-linear-gradient\(\s*135deg,\s*var\(--cl-shade-hatch-line\)/)
    for (let i = 0; i <= 4; i++) assert.match(css, new RegExp(`\\.cl-shade-bg-${i} \\{ background-color: var\\(--cl-shade-${i}-bg\\); \\}`))
    assert.match(css, /\.cl-shade-bg-3,\s*\.cl-shade-hatch \{\s*-webkit-print-color-adjust: exact;\s*print-color-adjust: exact;/)
  })

  it('横棒・細い線・平熱の印は印刷で隠す（紙は今のまま）。A2 の ▼ は紙に黒で出す', () => {
    for (const cls of ['.cl-fluid-bar', '.vspark', '.vmark-usual']) {
      assert.match(css, new RegExp(`@media print \\{\\s*\\${cls} \\{\\s*display: none;`), `${cls} が印刷で隠れない`)
    }
    assert.match(css, /@media print \{\s*\.msheet-lowday \{\s*color: #000;/)
    assert.doesNotMatch(css, /\.msheet-lowday \{\s*display: none/)
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('3. 食事一覧（MealsSheetPage）', () => {
  it('A6: 食事のマスの地を mealShade の段階で塗り、半分以下は斜線。低摂取の ▲ と文字色は残す（地だけ置き換える）', () => {
    assert.match(mealsSheet, /const shade = mealShade\(eff\)/)
    assert.match(mealsSheet, /`cl-shade-bg-\$\{shade\.stage\}\$\{shade\.hatched \? ' cl-shade-hatch' : ''\}`/)
    assert.match(mealsSheet, /className=\{`\$\{CELL_BASE\} \$\{shadeClass\} \$\{busy \? `relative \$\{BUSY_RING\}` : ''\}`\}/)
    // ▲（lowMark）と低摂取の文字色はそのまま
    assert.match(mealsSheet, /const toneClass = low \? 'text-warn font-bold' : SLOT_TEXT\[slot\]/)
    assert.match(mealsSheet, /lowMark=\{low\}/)
    // 色だけに頼らない: 読み上げに「半分以下」
    assert.match(mealsSheet, /const halfWord = shade\?\.hatched \? '。主食と副食の合計が半分以下' : ''/)
  })

  it('A2: 日ごとの「▼」は水分の欄、続いている日数は氏名の右（紙にも出す）。前の7日を表とは別に読み、判定は useMemo で控える', () => {
    assert.match(mealsSheet, /const LOW_LOOKBACK_DAYS = 7/)
    assert.match(mealsSheet, /fetchMealsSheet\(priorFrom, priorTo\)/)
    assert.match(mealsSheet, /const priorFrom = addDays\(fromIso, -LOW_LOOKBACK_DAYS\)/)
    assert.match(mealsSheet, /const lowStreaks = useMemo\(\(\) => \{[\s\S]*?return mealLowStreaks\(\[\.\.\.priorMeals, \.\.\.shown\]\)[\s\S]*?\}, \[meals, pending, priorMeals, fromIso, toIso, thresholdsVer\]\)/)
    // 水分の欄は「▼」だけ（数字を並べると水分の合計と続いて読めた）
    assert.match(mealsSheet, /<span className="sheet-mark msheet-lowday" aria-hidden="true">\s*▼\s*<\/span>/)
    // 氏名の右に、いちばん新しい日の続いている日数「▼14」（それより前から続いていれば「+」）
    assert.match(mealsSheet, /const nameLow = lowStreaks\.get\(r\.id\)\?\.get\(toIso\)\?\.streak \?\? 0/)
    assert.match(mealsSheet, /▼\{nameLow > 1 \? nameLow : ''\}\s*\{capped \? '\+' : ''\}/)
    // 表の控えのキー（mealKey＝「利用者ID|日|枠」）と同じ区切りで分ける
    assert.match(mealsSheet, /return `\$\{residentId\}\|\$\{day\}\|\$\{slot\}`/)
    assert.match(mealsSheet, /const \[ridRaw, day, slot\] = k\.split\('\|'\)/)
    // 全文は読み上げ・吹き出しに
    assert.match(mealsSheet, /\$\{lowStreak > 0 \? `。\$\{lowStreakText\(lowStreak, d, lowReadFrom \|\| fromIso\)\}` : ''\}。内訳と追加を開く/)
    assert.match(mealsSheet, /<p className="mt-1 text-sm font-bold text-warn">\{lowStreakText\(lowStreak, d, lowReadFrom \|\| fromIso\)\}<\/p>/)
  })

  it('A2 の全文: 読んだ範囲の初日まで続いていれば「N日目以上」（表示の日数で同じ日に違う日数を言い切らない）', { skip: !loaded }, () => {
    const { dayCount, lowStreakText } = evalDecls(mealsSheet, ['function dayCount(', 'function lowStreakText('], { mealLowLabel: VA.mealLowLabel })
    assert.equal(dayCount('2026-10-06', '2026-10-16'), 11)
    assert.equal(dayCount('2026-10-16', '2026-10-16'), 1)
    assert.equal(lowStreakText(0, '2026-10-16', '2026-10-06'), '')
    assert.equal(lowStreakText(1, '2026-10-16', '2026-10-06'), '▼摂取低下')
    assert.equal(lowStreakText(2, '2026-10-16', '2026-10-06'), '▼摂取低下（2日目）')
    // 10/6 から読んで 10/16 で11日目＝読んだ初日から続いている（それより前から続いているかもしれない）
    assert.equal(lowStreakText(11, '2026-10-16', '2026-10-06'), '▼摂取低下（11日目以上）')
    assert.equal(lowStreakText(10, '2026-10-16', '2026-10-06'), '▼摂取低下（10日目）')
  })

  it('A3: 水分の欄の下端に細い横棒（画面だけ）・吹き出しに「800／1,200ml（67%）」・先の日は出さない', () => {
    assert.match(mealsSheet, /const fluidProg = d <= today \? fluidProgress\(totalMl, targets\.get\(r\.id\)\) : null/)
    assert.match(mealsSheet, /<span className="cl-fluid-bar cl-fluid-bar-cell" aria-hidden="true">/)
    assert.match(mealsSheet, /\{`目標 \$\{fluidProg\.label\}`\}/)
    // 目標と基準値は開いた時に1回（表の読み込みを待たせない・失敗しても表は出す）
    assert.match(mealsSheet, /void loadVitalThresholds\(\)\.then/)
    assert.match(mealsSheet, /fetchResidentTargets\(\)\s*\.then/)
  })

  it('凡例: 濃淡・斜線・▼ は紙にも出す説明、横棒の説明は画面だけ', () => {
    assert.match(mealsSheet, /食事のマスは地の色が濃いほど食べた量が少なく、斜線は主食と副食の合計が半分以下です。/)
    assert.match(mealsSheet, /<span className="print:hidden">水分の欄の下の細い棒は、1日の目標に対する割合です/)
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('4. 食事一括（MealsGridPage）', () => {
  it('A6・A2・A3 を1名の行に出す（濃淡の札・▼摂取低下（N日目）・目標の割合と横棒）。行（memo）には数と目標の参照だけ渡す', () => {
    assert.match(mealsGrid, /const shade = shadeSlot \? mealShade\(\{ main_amount: main, side_amount: side, status \} as Meal\) : null/)
    assert.match(mealsGrid, /const fluidProg = fluidProgress\(fluidMl \+ queuedMl, target\)/)
    assert.match(mealsGrid, /\{lowCapped \? `▼摂取低下（\$\{lowStreak\}日目以上）` : mealLowLabel\(lowStreak\)\}/)
    assert.match(mealsGrid, /lowCapped=\{\(lowStreakByResident\.get\(r\.id\) \?\? 0\) >= lowReadDays\}/)
    assert.match(mealsGrid, /目標 \{fluidProg\.label\}/)
    assert.match(mealsGrid, /shadeSlot=\{MEAL_CHART_SLOTS\.includes\(slot\)\}\s*lowStreak=\{lowStreakByResident\.get\(r\.id\) \?\? 0\}\s*lowCapped=[^\n]*\n\s*target=\{targets\.get\(r\.id\)\}/)
    assert.match(mealsGrid, /const lowStreakByResident = useMemo\(/)
    // 控えのキー（mealKey＝「利用者ID:枠」）と同じ区切りで分ける（違う区切りだと1件も数えず、低下が出なかった＝実測）
    assert.match(mealsGrid, /return `\$\{residentId\}:\$\{slot\}`/)
    assert.match(mealsGrid, /const \[ridRaw, slot\] = k\.split\(':'\)/)
    assert.match(mealsGrid, /fetchMealsSheet\(addDays\(day, -LOW_LOOKBACK_DAYS\), addDays\(day, -1\)\)/)
  })
})

// ══════════════════════════════════════════════════════════════════════

describe('5. バイタル一括（VitalsGridPage）', () => {
  it('A1: 体温は judgeTemp で判定し、印が無くて平熱+1.0↑なら「平熱+1.2↑」、両方なら注記を値の下に（画面だけの .vmark-usual）', () => {
    assert.match(vitalsGrid, /function VitalValue\(/)
    assert.match(vitalsGrid, /const j = judgeTemp\(value, usualTemp\)\s*const usualText = j\.level \? j\.note : j\.overUsual \? j\.mark : null/)
    assert.match(vitalsGrid, /<span className="vmark-usual" aria-hidden="true">/)
    assert.match(vitalsGrid, /<LevelCell value=\{value\} level=\{spo2LevelFor\(value, target\)\} digits=\{FIELD_DIGITS\.spo2\} \/>/)
    assert.match(vitalsGrid, /void fetchUsualTemps\(day\)\.then/)
  })

  it('読み上げの語（newMarkWord）: 平熱との差・個別の下限を足す。当たらなければ空', { skip: !loaded }, () => {
    const { newMarkWord } = evalDecls(vitalsGrid, ['function newMarkWord('], VA)
    const t = { id: 1, resident_id: 1, fluid_target_ml: null, spo2_warn_below: 95, spo2_danger_below: 90, rev: 1 }
    assert.equal(newMarkWord('temp', 37.3, 36.2), '（平熱+1.1・平熱より高い）')
    assert.equal(newMarkWord('temp', 37.8, 36.5), '（平熱+1.3・平熱より高い）') // 37.5↑ と両方＝注記
    assert.equal(newMarkWord('temp', 37.4, 36.5), '') // +0.9 は出さない
    assert.equal(newMarkWord('temp', 37.3, null), '') // 平熱なし（5回未満）
    assert.equal(newMarkWord('spo2', 94, null, t), '（個別の下限 95% を下回る）')
    assert.equal(newMarkWord('spo2', 94, null, undefined), '')
    assert.equal(newMarkWord('spo2', 96, null, t), '') // 個別の下限より上 // 施設の基準（93% 未満）では当たらない
    assert.equal(newMarkWord('pulse', 120, null, t), '')
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('6. バイタル一覧（VitalsSheetPage）', () => {
  it('A9: SpO2 の印はその方の下限（spo2LevelFor）。A1 は読み上げに足す（欄の見た目の印は SheetCell の対応待ち）', () => {
    assert.match(vitalsSheet, /const level = !ok \? null : f === 'spo2' \? spo2LevelFor\(parsed, spo2Target\) : LEVEL_FN\[f\]\(parsed\)/)
    assert.match(vitalsSheet, /\} \$\{FIELD_LABEL\[f\]\}\$\{newMark\}`\}/)
    assert.match(vitalsSheet, /void fetchUsualTemps\(anchor\)\.then/)
  })

  it('A4: 居室の右（氏名の左隣）に細い線。定時の行だけ・画面だけ（紙は居室を中央のまま）・判定は useMemo', () => {
    assert.match(vitalsSheet, /const SPARK_DAYS = 7/)
    assert.match(vitalsSheet, /const SPARK_TEMP: readonly \[number, number\] = \[35\.5, 38\.5\]/)
    assert.match(vitalsSheet, /const SPARK_SPO2: readonly \[number, number\] = \[88, 100\]/)
    assert.match(vitalsSheet, /<span className="flex items-center justify-between gap-0\.5 print:justify-center">/)
    assert.match(vitalsSheet, /spark=\{isRoutine \? \(sparkByResident\.get\(row\.residentId\) \?\? null\) : null\}/)
    assert.match(vitalsSheet, /const sparkByResident = useMemo\(\(\) => \{[\s\S]*?\}, \[anchor, fromIso, recs, sparkPrior, visibleResidents\]\)/)
    // 表示の日数が7日より短い時だけ、足りない前の日を読む（表の recs には入れない）
    assert.match(vitalsSheet, /if \(sparkFrom >= fromIso\) \{\s*setSparkPrior\(\[\]\)/)
    assert.match(vitalsSheet, /fetchVitalsSheet\(sparkFrom, addDays\(fromIso, -1\)\)/)
    assert.match(vitalsSheet, /<svg className="vspark"[^>]*role="img" aria-label=\{sparkLabel\(spark\)\}>/)
  })

  it('線の座標: 全員同じ縦軸・範囲外は端・値の無い日で線を切る・1点だけの日は点。読み上げは範囲の要約', () => {
    const SPARK_DAYS = 7
    const { sparkPath, sparkDots, sparkLabel } = evalDecls(vitalsSheet, ['function sparkPath(', 'function sparkDots(', 'function sparkLabel('], { SPARK_DAYS })
    const axis = [35, 39]
    // 35→y=9（下端）、39→y=1（上端）、37→y=5
    assert.equal(sparkPath([35, 37, 39], axis, 1, 9, 28), 'M0 9L14 5L28 1')
    // 範囲外は端にそろえる（全員同じ縦軸＝その方だけ伸び縮みしない）
    assert.equal(sparkPath([34, 40], axis, 1, 9, 28), 'M0 9L28 1')
    // 値の無い日で線を切る
    assert.equal(sparkPath([36, null, 37, 38, null, null, 36], axis, 1, 9, 24), 'M0 7M8 5L12 3M24 7')
    assert.deepEqual(sparkDots([36, null, 37, 38, null, null, 36], axis, 1, 9, 24), [{ x: 0, y: 7 }, { x: 24, y: 7 }])
    assert.equal(sparkLabel({ temp: [36.2, null, 37.8, 36.5, null, null, null], spo2: [97, 93, null, 95, null, null, null] }), '直近7日 体温 36.2〜37.8℃・SpO2 93〜97%')
    assert.equal(sparkLabel({ temp: Array(7).fill(null), spo2: Array(7).fill(null) }), '直近7日の定時の記録なし')
    assert.equal(sparkLabel({ temp: [36.5, ...Array(6).fill(null)], spo2: Array(7).fill(null) }), '直近7日 体温 36.5℃・SpO2 記録なし')
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('7. 日報（DailySheetPage）の発熱者・他症状者の欄', () => {
  it('A1・A9: 平熱と目標は文脈（VitalMarksContext）で欄へ渡す。1日ぶんの枠（DaySheetMemo）には新しい値を渡さない＝描き直さない', () => {
    assert.match(daily, /const VitalMarksContext = createContext<VitalMarks>\(NO_VITAL_MARKS\)/)
    assert.match(daily, /<VitalMarksContext\.Provider value=\{vitalMarks\}>/)
    assert.match(daily, /const marks = useContext\(VitalMarksContext\)/)
    assert.match(daily, /const tj = vital \? judgeTemp\(vital\.temp, marks\.usual\.get\(vital\.resident_id\)\) : null/)
    assert.match(daily, /spo2LevelFor\(vital\.spo2, marks\.targets\.get\(vital\.resident_id\)\)/)
    assert.match(daily, /<span className="vmark-usual px-1 text-right" aria-hidden="true">/)
    assert.doesNotMatch(daily, /<DaySheetMemo[^>]*vitalMarks/)
    assert.match(daily, /void fetchUsualTemps\(day\)\.then/)
  })
})

// ══════════════════════════════════════════════════════════════════════
describe('8. 判定の重さ（38名×18日×3食・一覧の1回の作り直し）', { skip: !loaded }, () => {
  it('mealLowStreaks と mealShade（全マス）を合わせても 1回 20ms 未満（一覧の描き直しを重くしない）', () => {
    const meals = []
    let id = 1
    for (let r = 1; r <= 38; r++) {
      for (let d = 0; d < 18; d++) {
        const day = `2026-10-${String(d + 1).padStart(2, '0')}`
        for (const slot of ['breakfast', 'lunch', 'dinner']) {
          meals.push({ id: id++, resident_id: r, meal_on: day, meal_slot: slot, main_amount: (r + d) % 11, side_amount: (r * 3 + d) % 11, status: 'eaten', note: null, recorded_by: null, rev: 1 })
        }
      }
    }
    VA.mealLowStreaks(meals) // 1回目（JIT）は数えない
    const runs = []
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now()
      VA.mealLowStreaks(meals)
      for (const m of meals) VA.mealShade(m)
      runs.push(performance.now() - t0)
    }
    runs.sort((a, b) => a - b)
    assert.ok(runs[2] < 20, `中央値 ${runs[2].toFixed(2)}ms`)
  })
})
