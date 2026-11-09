// デイ 計画B3（2026-11-09・代表者の指示）: バイタル一括と食事一括を1つの画面「バイタル・食事」に・1人ずつ行の地を変える・
// 分類ごとの淡い色（バイタル＝ティール・食事＝イエロー・活動＝コーラル・機能訓練＝ローズ）の試験。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック: 古い2つの道の送り先（?day= の引き継ぎ）・1人7欄の空の欄の数・切り替えの数・行の地（交互）・状態の列の印のまとめ・分類の色のクラス
// 2. 静的検査: 統合した画面の列と見出しの帯・欄送り（KT の後は同じ方の主食）・横に送らずに入る作り（iPad 横 1180px の幅の勘定）・
//    古い道の送り先（App.tsx）・切り替えの1つにまとめた形・行の地（3画面・氏名の列も同じ地・再測定と知らせの行も同じ地）
// 3. 色（tokens.css・tailwind.config.js）: 足した変数をライト・ダーク（設定と OS 追従）・印刷の4か所で定義・帯の上の文字と行の地の上の文字の
//    コントラスト 4.5 以上（帯は 7 以上）・行の地は空の枠の注意の地（warn-bg）と色味で分ける・分類の色は状態の色の代わりに使わない
// 〔未測定〕を入力済みにする（仕様の 4.）は、書く列が無いため入れていない（報告に理由と移行の案）。
// 個人情報は置かない（利用者は数値IDだけ）。

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

let R = null
let P = null
let DP = null
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
  R = await import('../src/lib/daycareRoutes.ts?daycare-vitals-meals')
  P = await import('../src/lib/daycareProgress.ts?daycare-vitals-meals')
  DP = await import('../src/lib/daycarePerson.ts?daycare-vitals-meals')
} catch (e) {
  loadError = e
  R = null
  P = null
  DP = null
}

const screen = code('../src/pages/DaycareVitalsMealsPage.tsx')
const lunch = code('../src/pages/DaycareLunchColumns.tsx')
const today = code('../src/pages/DaycarePage.tsx')
const app = code('../src/App.tsx')

if (R === null || P === null || DP === null) {
  registerLoadFailure('デイ 計画B3 の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('純ロジック（計画B3）', () => {
    it('古い2つの道の送り先: バイタル・食事の画面へ、業務日（?day=）だけを引き継ぐ', () => {
      assert.equal(R.DAYCARE_VITALS_MEALS_PATH, '/record/daycare/vitals-meals')
      assert.deepEqual(R.DAYCARE_OLD_BULK_PATHS, ['/record/daycare/vitals', '/record/daycare/meals'])
      assert.equal(R.vitalsMealsRedirect(''), '/record/daycare/vitals-meals')
      assert.equal(R.vitalsMealsRedirect('?day=2026-11-01'), '/record/daycare/vitals-meals?day=2026-11-01')
      assert.equal(R.vitalsMealsRedirect('day=2026-11-01'), '/record/daycare/vitals-meals?day=2026-11-01')
      // ほかの値は引き継がない・空の day は付けない（形の検査は送り先の readPersonDay）
      assert.equal(R.vitalsMealsRedirect('?x=1&day=2026-10-31&y=2'), '/record/daycare/vitals-meals?day=2026-10-31')
      assert.equal(R.vitalsMealsRedirect('?day='), '/record/daycare/vitals-meals')
      assert.equal(R.vitalsMealsRedirect('?x=1'), '/record/daycare/vitals-meals')
      // 壊れた値はそのまま渡す（送り先の画面が今日にする）。URL の中で壊れない形にする
      assert.equal(R.vitalsMealsRedirect('?day=a%26b'), '/record/daycare/vitals-meals?day=a%26b')
      // 画面の道（今日は ?day= を付けない）
      assert.equal(R.vitalsMealsPath('2026-11-09', '2026-11-09'), '/record/daycare/vitals-meals')
      assert.equal(R.vitalsMealsPath('2026-11-08', '2026-11-09'), '/record/daycare/vitals-meals?day=2026-11-08')
    })
    it('未入力の数は1人7欄（バイタルの最初の回の5欄＋昼食の主食・副食。拒食は入力済み・水分は数えない）で「n名（m欄）」', () => {
      const FULL = { temp: 36.5, sys_bp: 120, dia_bp: 70, pulse: 70, spo2: 97 }
      const people = [
        // 何も入っていない＝7欄
        [P.vitalBlankFields(null), P.lunchBlankFields(null)],
        // バイタルは全部・主食だけ＝1欄
        [P.vitalBlankFields(FULL), P.lunchBlankFields({ main_amount: 8, side_amount: null, status: 'eaten' })],
        // バイタルは体温だけ・拒食＝4欄
        [P.vitalBlankFields({ temp: 36.4 }), P.lunchBlankFields({ main_amount: null, side_amount: null, status: 'refused' })],
        // 全部＝0欄
        [P.vitalBlankFields(FULL), P.lunchBlankFields({ main_amount: 10, side_amount: 10, status: 'eaten' })],
      ]
      const blanks = people.map(([v, m]) => P.vitalsMealsBlankFields(v, m))
      assert.deepEqual(blanks, [7, 1, 4, 0])
      assert.deepEqual(P.bulkBlankSummary(blanks), { people: 3, fields: 12 })
      // 切り替えの数は同じ数え方（空の欄がある方の数）
      assert.deepEqual(P.daycareNavPending({ vitalsMeals: blanks, activity: null, training: null }), { vitalsMeals: 3 })
      // どちらかを読めない時は数えない（画面の n と食い違わないように、切り替えには出さない）
      assert.equal(P.vitalsMealsBlankFields(null, 0), null)
      assert.equal(P.vitalsMealsBlankFields(0, null), null)
    })
    it('行の地は1人ずつ交互（0 始まりの何人目か）。壊れた値はページの地', () => {
      assert.deepEqual([0, 1, 2, 3, 4].map((i) => P.daycareRowTone(i)), ['bg-bg', 'bg-row-alt', 'bg-bg', 'bg-row-alt', 'bg-bg'])
      assert.equal(P.daycareRowTone(1.5), 'bg-bg')
      assert.equal(P.daycareRowTone(Number.NaN), 'bg-bg')
      assert.equal(P.daycareRowTone(-1), 'bg-bg')
    })
    it('状態の列の印: バイタルの回と昼食の印のうち手当ての要る方（要確認 → 送信中 → 未送信 → 保存済み）。同じなら先の方', () => {
      const m = (mark, text, tone) => ({ mark, text, tone })
      const ok = m('✓', '保存済み', 'ok')
      const queued = m('⚠', '未送信', 'warn')
      const saving = m('↻', '送信中', 'info')
      const check = m('▲', '要確認', 'warn')
      assert.equal(P.mergeSaveMarks(null, null), null)
      assert.equal(P.mergeSaveMarks(ok, null), ok)
      assert.equal(P.mergeSaveMarks(null, queued), queued)
      assert.equal(P.mergeSaveMarks(ok, queued), queued)
      assert.equal(P.mergeSaveMarks(queued, saving), saving)
      assert.equal(P.mergeSaveMarks(saving, check), check)
      assert.equal(P.mergeSaveMarks(check, ok), check)
      const ok2 = m('✓', '保存済み', 'ok')
      assert.equal(P.mergeSaveMarks(ok, ok2), ok, '同じ急ぎなら先の方（バイタル）')
    })
    it('分類の色のクラス: 帯（淡い色面＋下の線）・線・印。進み具合の札の線（入浴は無し）', () => {
      assert.deepEqual(Object.keys(P.DAYCARE_CATEGORY_CLS), ['vitals', 'meals', 'activity', 'training'])
      for (const [k, c] of Object.entries(P.DAYCARE_CATEGORY_CLS)) {
        assert.equal(c.band, `bg-cat-${k}-bg dc-cat-line-${k}`)
        assert.equal(c.line, `dc-cat-line-${k}`)
        assert.equal(c.dot, `bg-cat-${k}`)
      }
      assert.deepEqual(
        ['vitals', 'lunch', 'activity', 'training', 'bath'].map((k) => P.progressCategoryLine(k)),
        ['dc-cat-line-vitals', 'dc-cat-line-meals', 'dc-cat-line-activity', 'dc-cat-line-training', ''],
      )
    })
  })
}

describe('静的検査: 統合した画面（計画B3）', () => {
  const head = screen.slice(screen.indexOf('<thead>'), screen.indexOf('</thead>'))
  const body = screen.slice(screen.indexOf('<tbody>'), screen.indexOf('</tbody>'))
  it('列は 氏名｜血圧（上 / 下）｜P｜SpO2｜KT｜状態（再測定）‖ 主食｜副食｜水分（cc）。境目は見出しの帯の色（バイタル＝ティール・食事＝イエロー）', () => {
    const order = ['>氏名<', '血圧', 'DC_BULK_VITAL_ORDER.filter', '状態<span className="sr-only">・再測定</span>', '主食', '副食', '水分（cc）'].map((w) => head.indexOf(w))
    assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `列の並び ${order}`)
    // バイタルの4つの見出し（血圧は2列）は vitals の帯・食事の3つは meals の帯。氏名と状態は今の灰（帯の切れ目が境目）
    assert.equal((head.match(/\$\{DAYCARE_CATEGORY_CLS\.vitals\.band\}/g) ?? []).length, 2, '血圧＋P・SpO2・KT の map')
    assert.equal((head.match(/\$\{DAYCARE_CATEGORY_CLS\.meals\.band\}/g) ?? []).length, 3, '主食・副食・水分')
    assert.match(head, /<th scope="col" className="sticky top-0 z-20 bg-surface2 px-1 py-2 text-sm font-bold text-ink2">\s*状態/)
    // 帯の上の文字は text-ink（灰の文字を色の付いた面に載せない）
    for (const m of head.matchAll(/className=\{`sticky top-0 z-20 [^`]*DAYCARE_CATEGORY_CLS[^`]*`\}/g)) assert.match(m[0], /\btext-ink`/, m[0])
    // 見出しの行は上に残す（sticky top-0・z-20／角の氏名は z-30）
    assert.match(head, /<th scope="col" className="sticky left-0 top-0 z-30 bg-surface2 px-2 py-2 text-sm font-bold text-ink2">/)
    // 行の列も同じ並び（氏名 → バイタル → 状態 → 昼食の3列）
    const iVit = body.indexOf('{DC_BULK_VITAL_ORDER.map((f) => {')
    const iState = body.indexOf('onClick={() => addRecheck(row, slot)}')
    const iLunch = body.indexOf('lunch.cells(row.residentId)')
    assert.ok(body.indexOf('<th scope="row"') < iVit && iVit < iState && iState < iLunch)
    // 昼食の3列は、フックの cells（主食・副食の選択肢と水分の欄＝それまでの食事一括の欄のまま）
    const cells = lunch.slice(lunch.indexOf('const cells = (rid: number)'), lunch.indexOf('const notes = (rid: number)'))
    assert.match(cells, /\{\(\['main_amount', 'side_amount'\] as const\)\.map\(\(f\) => \{/)
    assert.ok(cells.indexOf('<select') > 0 && cells.indexOf('<select') < cells.indexOf('<form'))
    // 再測定の行と、昼食の欄を出さない方（「全員」で出した休み・入院中の方）は空の欄で列の数をそろえる
    // 2026-11-09 計画B3 の反証の直し（固定し直し・意図は同じ）（軽3）: 昼食を読めない時は、昼食の3列に「読み込めません」（押せない）
    assert.match(body, /\{lunchRow \? \(\s*lunch\.cells\(row\.residentId\)\s*\) : si === 0 && inBulk && lunchFailed \? \(\s*<td colSpan=\{3\} className="px-2 py-1 text-sm text-ink2">\s*<span aria-hidden="true">— <\/span>\s*読み込めません\s*<\/td>\s*\) : \(/)
    assert.match(body, /const lunchRow = si === 0 && lunchHere/)
    assert.match(body, /const inBulk = blankCount !== undefined\s*const lunchHere = inBulk && lunchReady/)
    assert.match(body, /<span className="sr-only">昼食は対象外（休み・入院中）<\/span>/)
    // 行の下の知らせ（バイタル・昼食・水分）は10列にまたがる1行
    assert.match(body, /<td colSpan=\{DAYCARE_VITAL_FIELDS\.length \+ 5\} className="p-0">/)
  })
  it('欄送り: KT の次はテンキーを閉じ（持っている血圧の上は送る）、同じ方の主食の選択肢へフォーカスを移す。主食の欄の目印は主食だけ', () => {
    const adv = screen.slice(screen.indexOf('const advance = (cur: Active) => {'), screen.indexOf('const commit = '))
    assert.match(adv, /if \(nf !== null\) \{\s*setActive\(\{ \.\.\.cur, field: nf \}\)\s*\} else \{\s*flushHeldSys\(cur, null\)\s*setActive\(null\)\s*focusLunchMain\(cur\.residentId\)\s*\}/)
    assert.match(adv, /const focusLunchMain = \(residentId: number\) => \{\s*window\.requestAnimationFrame\(\(\) => \{\s*const el = tableBox\?\.querySelector<HTMLElement>\(`\[data-dc-lunch-main="\$\{residentId\}"\]`\) \?\? null\s*if \(el === null\) return\s*el\.focus\(\{ preventScroll: true \}\)\s*el\.scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/)
    // 目印はフックの主食の選択肢だけ（副食・水分には付けない）
    assert.match(lunch, /data-dc-lunch-main=\{f === 'main_amount' \? rid : undefined\}/)
    assert.equal((lunch.match(/data-dc-lunch-main/g) ?? []).length, 1)
    // 「未測定」（skip）で KT を飛ばした時も同じ advance を通る
    assert.match(screen, /if \(skip \|\| text === ''\) \{[\s\S]{0,200}advance\(cur\)/)
    // 物理キーボードの数字は、選択肢（SELECT）・水分の欄（INPUT）で押した時は横取りしない
    assert.match(screen, /if \(t !== null && \(t\.tagName === 'INPUT' \|\| t\.tagName === 'TEXTAREA' \|\| t\.tagName === 'SELECT'\)\) return/)
  })
  it('iPad 横 1180×820 で横に送らずに全部の列が入る作り（幅の勘定。2026-11-09 にヘッドレス Chrome で自然な表の幅 1041px・枠 1052px を実測）', () => {
    // 画面の幅: 左のメニュー（lg:pl-24＝96px）・本文の左右の余白（px-4＝16px×2）
    assert.match(app, /<div className="min-h-screen bg-bg text-ink lg:pl-24">/)
    assert.match(app, /<main className="px-4 pb-24 pt-4 lg:pb-8">/)
    const box = 1180 - 96 - 32
    // 列の幅（Tailwind の 4px 刻み）: 氏名（dc-vital-name 7rem＋左右 8px）・血圧の上 w-24・下 w-28・P/SpO2/KT w-24・
    // 状態（〔＋再測定〕16px×4＋左右 4px＋枠 4px・「✓ 保存済み」15px×5＋間 4px のうち広い方＋欄の左右 8px＝88px。折り返さない）
    assert.match(read('../src/index.css'), /\.dc-vital-name \{\s*width: min\(7rem, 35vw\);/)
    assert.match(body, /const tdCls = f === 'sys_bp' \? 'w-24 [^']*' : f === 'dia_bp' \? 'relative w-28 [^']*' : 'px-1 py-1'/)
    assert.match(body, /className="min-h-tap w-full whitespace-nowrap rounded border-2 border-warn bg-warn-bg px-1 text-base font-bold text-ink disabled:opacity-60"/)
    assert.match(body, /<span role="status" className=\{`whitespace-nowrap text-sm font-bold leading-tight /)
    const state = Math.max(16 * 4 + 8 + 4, 15 * 5 + 4) + 8
    const fixed = 112 + 16 + 96 + 112 + 96 * 3 + state
    // 昼食の3列（2026-11-09 計画B3 の手直し（固定し直し・意図は同じ））: 選択肢は空の時「未」・いちばん広い「拒食」（2文字・18px）＋左右 4px＋端末の矢印（約 24px）＋欄の左右 4px。
    // 水分は合計（64px 以上・15px の「計 1,200」）＋6px＋56px の欄＋8px＋〔＋〕44px＋左右 4px（合計と欄は横に並べる＝行の高さ 53px）
    const options = read('../src/lib/daycarePerson.ts')
    assert.match(options, /\{ value: '', label: '未' \}/)
    assert.match(lunch, /const selectCls = 'min-h-tap min-w-tap rounded border border-border-strong bg-surface px-1 text-lg/)
    const longest = Math.max(...['未', '10', '拒食'].map((t) => t.length * 18))
    const select = longest + 8 + 24 + 8
    assert.match(lunch, /className="block min-h-tap w-14 rounded border/)
    assert.match(lunch, /<div className="flex items-center gap-x-1\.5">\s*<p className="min-w-16 whitespace-nowrap text-sm text-ink">\s*計 /)
    const fluid = Math.max(64, 15 + 4 + 5 * 9) + 6 + 56 + 8 + 44 + 8
    const total = fixed + select * 2 + fluid
    assert.ok(total <= box, `表の幅 ${total}px が枠 ${box}px に入る`)
    // 入らない時（文字を大きくした時・iPad 縦）は今までどおり枠の中で横に送り、手がかりを出す
    assert.match(screen, /表は横にスクロールできます（氏名の列は左に残ります）/)
    // 氏名の列を広げる dc-meal-name（1024px 以上で 14rem）は使わない
    assert.doesNotMatch(screen, /dc-meal-name/)
  })
  it('統合した画面は業務日を URL の ?day= で持つ（再読み込みで同じ日・端末に業務データを残さない）・日付の切り替えは片づけてから', () => {
    assert.match(screen, /const day = readPersonDay\(search\.get\('day'\), today\)/)
    assert.match(screen, /const goDay = \(d: string\) => navigate\(vitalsMealsPath\(d, today\), \{ replace: true \}\)/)
    assert.doesNotMatch(screen, /useState\(todayIso\(\)\)\s*\n\s*const \[day/)
    for (const re of [/afterRelease\(\(\) => goDay\(addDays\(day, -1\)\)\)/, /afterRelease\(\(\) => goDay\(addDays\(day, 1\) > today \? day : addDays\(day, 1\)\)\)/, /afterRelease\(\(\) => goDay\(today\)\)/]) assert.match(screen, re)
    // 端末に書くのは絞り込みの既知値だけ（氏名・記録は書かない）
    const sets = screen.match(/localStorage\.setItem\([^)]*\)/g) ?? []
    assert.deepEqual(sets, ['localStorage.setItem(LS.dcVitalsFilter, v)'])
    assert.doesNotMatch(screen + lunch, /console\./)
  })
  it('昼食と水分は、それまでの食事一括の処理のまま（フックに移しただけ・入力解禁・名簿・〔最新に更新〕は画面から渡す）', () => {
    // 2026-11-09 計画B3 の反証の直し（固定し直し・意図は同じ）（軽4）: その日の材料（写し・予定・出欠）と送信待ちの増減は画面から渡す
    assert.match(screen, /const lunch = useDaycareLunchColumns\(\{ day, today, actorId, residents, gate, reloadKey, materials: data, queueTick \}\)/)
    assert.match(lunch, /export function useDaycareLunchColumns\(\{\s*day,\s*today,\s*actorId,\s*residents,\s*gate,\s*reloadKey,\s*materials,\s*queueTick,\s*\}: DaycareLunchColumnsInput\): DaycareLunchColumns \{/)
    // 保存・送信待ち・水分の二重登録の防止（#56 の createFluidInputs）・〔元に戻す〕はそのまま
    assert.match(lunch, /const \[fluidInputs\] = useState\(\(\) => createFluidInputs\('cc'\)\)/)
    assert.match(lunch, /await saveMealEdits\(t, send as CellEditInput<MealCellField>, \{/)
    assert.match(lunch, /const r = await softDeleteFluid\(f\.id, f\.rev, \{ editedBy: actorId \}\)/)
    // 〔元に戻す〕の知らせは画面の最後に置く
    assert.match(screen, /\{lunch\.toast\}/)
    // 昼食の知らせは1回目の行の下（バイタルの知らせと同じ行）
    assert.match(body, /\{detail \? \(\s*<SlotStatus [\s\S]{0,200}\) : null\}\s*\{lunchNotes\}/)
  })
})

describe('静的検査: 行の高さ（計画B3 の手直し・ふつうの行は 53px＝欄 44px＋上下 4px）', () => {
  const body = screen.slice(screen.indexOf('<tbody>'), screen.indexOf('</tbody>'))
  it('氏名の列は活動一括と同じ形: 氏名のリンク（44px・2段）の2段目に基準の札・「1回目（時刻）」は再測定の回がある方だけ・ほかは積まない', () => {
    const name = body.slice(body.indexOf('{si === 0 ? ('), body.indexOf('↳ '))
    assert.match(name, /<Link to=\{personPath\(row\.residentId, day, today\)\} className="flex min-h-tap flex-col justify-center underline-offset-2 hover:underline">\s*<span className="text-base font-bold leading-tight text-link">[\s\S]*?<\/span>\s*<span className="text-sm leading-tight text-ink2">\s*\{\(blankCount \?\? 0\) > 0 \? <DaycareRowBlankMark lead \/> : null\}\s*\{basis\}\s*<\/span>\s*<\/Link>/)
    assert.match(name, /\{slots\.length > 1 \? \(/)
    assert.doesNotMatch(name, /time !== null \? \(|nameNotes|cm\.word|mark\.text/)
    // 昼食の保存の印は状態の列（mergeSaveMarks）・取り込みの印と外出／入院の記録は行の下の知らせ（フックの notes）
    assert.doesNotMatch(lunch, /nameNotes/)
    const notes = lunch.slice(lunch.indexOf('const notes = (rid: number)'), lunch.indexOf('return { data, loading'))
    assert.match(notes, /\{otherStatus !== null \|\| showSource \? \(\s*<p className="text-sm text-ink2">/)
  })
  it('状態の列は2段まで（1段目＝来た・まだの短い形か〔＋再測定〕・2段目＝保存の印）。水分の合計は欄の横（上に積まない）', () => {
    // 2026-11-09 計画B3 の反証の直し（固定し直し・意図は同じ）（中3）: 1段目＝保存の印か来た・まだ、2段目＝測った時刻（再測定の回が無い方）
    // 2026-11-09 計画B3 の確認の反証の直し（固定し直し・意図は同じ）（中1）
    assert.match(body, /\) : si === 0 && inBulk \? \(\s*<span className=\{`whitespace-nowrap text-sm leading-tight \$\{cm\.textCls\}`\}>/)
    assert.match(body, /const cm = daycareCameShort\(row\)/)
    const cells = lunch.slice(lunch.indexOf('const cells = (rid: number)'), lunch.indexOf('const notes = (rid: number)'))
    assert.doesNotMatch(cells, /flex-col/)
    assert.match(cells, /<div className="flex items-center gap-x-1\.5">/)
    // 欄の高さは 44px・行の上下は 4px ずつ（py-1）のまま
    for (const m of (body + cells).matchAll(/<td [^>]*className="([^"]+)"/g)) assert.match(m[1], /\bpy-1\b|\bp-0\b/, m[1])
  })
  it('来た・まだの短い形（daycareCameShort）: 記号と色は daycareCameMark と同じ・時刻は出さない・到着の記録が無い方は「在席」と出さない', () => {
    if (P === null) return
    assert.deepEqual(P.daycareCameShort({ state: 'present' }), { mark: '●', word: '在席', textCls: 'text-ok' })
    assert.deepEqual(P.daycareCameShort({ state: 'left' }), { mark: '✓', word: '帰宅', textCls: 'text-info' })
    assert.deepEqual(P.daycareCameShort({ state: 'planned' }), { mark: '○', word: '来所前', textCls: 'text-ink2' })
    assert.deepEqual(P.daycareCameShort(undefined), { mark: '○', word: '来所前', textCls: 'text-ink2' })
  })
})

describe('静的検査: 古い道・切り替え（計画B3）', () => {
  it('古い2つの道はバイタル・食事の画面へ送る（置き換えの移動・?day= を引き継ぐ）。古い画面のファイルは名前を変えて使う', () => {
    assert.match(app, /<Route path="\/record\/daycare\/vitals-meals" element=\{<DaycareVitalsMealsPage actorId=\{actorId\} staff=\{staff\} \/>\} \/>/)
    assert.match(app, /<Route path="\/record\/daycare\/vitals" element=\{<DaycareVitalsMealsRedirect \/>\} \/>/)
    assert.match(app, /<Route path="\/record\/daycare\/meals" element=\{<DaycareVitalsMealsRedirect \/>\} \/>/)
    assert.match(app, /function DaycareVitalsMealsRedirect\(\) \{\s*const location = useLocation\(\)\s*return <Navigate to=\{vitalsMealsRedirect\(location\.search\)\} replace \/>/)
    assert.match(app, /import \{ vitalsMealsRedirect \} from '\.\/lib\/daycareRoutes'/)
    assert.doesNotMatch(app, /DaycareVitalsPage|DaycareMealsPage/)
    // 送り先の部品は依存の無い小さな部品（App の最初の読み込みを重くしない）
    assert.doesNotMatch(read('../src/lib/daycareRoutes.ts'), /^import /m)
    // 1人の画面の入口も新しい画面の名前と道に合わせる（古い名前「バイタル一括」を画面に残さない）
    const person = code('../src/pages/DaycarePersonPage.tsx')
    assert.match(person, /<Link to=\{DAYCARE_VITALS_MEALS_PATH\} [^>]*>\s*バイタル・食事で入力する/)
    assert.doesNotMatch(person + screen + lunch, /バイタル一括で|食事一括で|バイタル一括の/)
  })
  it('今日の画面の切り替え: 〔バイタル一括〕〔食事一括〕は〔バイタル・食事〕1つ（未入力の数も1つ）。排泄は食事の次。分類の色の印（読み上げない）', () => {
    const nav = today.slice(today.indexOf('export function DaycareNav'), today.indexOf('/** 予定の帯'))
    assert.match(nav, /current: 'today' \| 'vitalsMeals' \| 'activity' \| 'training'/)
    assert.match(nav, /\{ key: 'vitalsMeals', to: DAYCARE_VITALS_MEALS_PATH, label: 'バイタル・食事', cats: \['vitals', 'meals'\] \}/)
    assert.doesNotMatch(nav, /'バイタル一括'|'食事一括'|key: 'vitals'|key: 'meals'/)
    assert.match(nav, /\.\.\.\(it\.key === 'vitalsMeals' \? \[excretion\] : \[\]\)/)
    // 2026-11-09 計画B3 の反証の直し（固定し直し・意図は同じ）（軽6）: 今いる画面（primary の塗り）の上では、印に地の色（surface）の細い縁を付ける
    assert.match(nav, /<span aria-hidden="true" className=\{`mr-1\.5 inline-flex \$\{current === it\.key \? 'gap-1' : 'gap-0\.5'\}`\}>\s*\{it\.cats\.map\(\(c\) => \(\s*<span key=\{c\} className=\{`inline-block h-4 w-1 rounded-sm \$\{DAYCARE_CATEGORY_CLS\[c\]\.dot\}\$\{current === it\.key \? ' ring-1 ring-surface' : ''\}`\} \/>/)
    // 未入力の数（今日の画面だけ）は1人7欄・バイタルか昼食を読めない日は出さない
    const np = today.slice(today.indexOf('const navPending ='), today.indexOf(': undefined', today.indexOf('const navPending =')))
    assert.match(np, /vitalsMeals:\s*data\.vitalsOk && data\.intakeOk\s*\?/)
    assert.doesNotMatch(np, /^\s*(vitals|meals):/m)
    // 統合した画面の切り替えは current="vitalsMeals"（数は渡さない＝今のまま）
    assert.match(screen, /<DaycareNav current="vitalsMeals" handoff=\{/)
  })
})

describe('静的検査: 行の地（1人ずつ交互・計画B3）', () => {
  const pages = {
    vitalsMeals: screen,
    activity: code('../src/pages/DaycareActivityBulkPage.tsx'),
    training: code('../src/pages/DaycareTrainingPage.tsx'),
  }
  it('3画面とも、行（tr）と左に残る氏名の列（sticky の th）を同じ地にする。知らせの行も同じ地', () => {
    for (const [k, p] of Object.entries(pages)) {
      const body = p.slice(p.indexOf('<tbody>'), p.indexOf('</tbody>'))
      assert.match(body, /const rowBg = daycareRowTone\(pi\)/, k)
      assert.match(body, /<tr className=\{`align-middle \$\{rowBg\} /, k)
      assert.match(body, /<th scope="row" className=\{`sticky left-0 z-10 \$\{rowBg\} px-2 py-1 text-left font-normal`\}>/, k)
      assert.match(body, /<tr className=\{`\$\{rowBg\} /, `${k}: 知らせの行`)
      assert.doesNotMatch(body, /className="sticky left-0 z-10 bg-bg/, `${k}: 氏名の列の地を固定の bg-bg にしない`)
    }
    // バイタル・食事: 何人目か（pi）は方ごと（再測定の行は同じ方の地＝外側の map で決める）
    const b = screen.slice(screen.indexOf('<tbody>'), screen.indexOf('</tbody>'))
    assert.ok(b.indexOf('shownRows.map((row, pi) => {') < b.indexOf('const rowBg = daycareRowTone(pi)') && b.indexOf('const rowBg = daycareRowTone(pi)') < b.indexOf('return slots.map((slot, si) => {'))
    assert.match(pages.activity, /\{targets\.map\(\(rid, pi\) => \{/)
    assert.match(pages.training, /\{targets\.map\(\(rid, pi\) => \{/)
  })
  it('空の枠の見た目（注意の地＋太い点線）は計画B2 のまま・行の地とは別のクラス', () => {
    const prog = code('../src/lib/daycareProgress.ts')
    assert.match(prog, /export const DAYCARE_BLANK_CELL_CLS = 'border-2 border-dashed border-warn bg-warn-bg'/)
    assert.match(prog, /return Number\.isInteger\(index\) && index % 2 === 1 \? 'bg-row-alt' : 'bg-bg'/)
  })
})

describe('色（tokens.css・tailwind.config.js・計画B3）', () => {
  const tokens = read('../src/styles/tokens.css')
  const part = tokens.slice(tokens.indexOf('/* ── デイの分類の色と一括の表の行の地（2026-11-09 計画B3）'))
  const ruleBody = (src, selector, media = null) => {
    let scope = src
    if (media !== null) {
      const at = src.indexOf(media)
      assert.ok(at >= 0, media)
      scope = src.slice(at)
    }
    const at = scope.indexOf(`${selector} {`)
    assert.ok(at >= 0, selector)
    const open = scope.indexOf('{', at)
    return scope.slice(open + 1, scope.indexOf('}', open))
  }
  const varOf = (body, name) => {
    const m = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6});`).exec(body)
    assert.ok(m, name)
    return m[1].toLowerCase()
  }
  const lin = (c) => {
    const x = c / 255
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16))
  const lum = (hex) => {
    const [r, g, b] = rgb(hex)
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }
  const contrast = (a, b) => {
    const x = lum(a)
    const y = lum(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  const hue = (hex) => {
    const [r, g, b] = rgb(hex).map((v) => v / 255)
    const mx = Math.max(r, g, b)
    const d = mx - Math.min(r, g, b)
    if (d === 0) return 0
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    return (h * 60 + 360) % 360
  }
  const hueGap = (a, b) => {
    const d = Math.abs(hue(a) - hue(b)) % 360
    return Math.min(d, 360 - d)
  }
  const NAMES = ['--c-row-alt', ...['vitals', 'meals', 'activity', 'training'].flatMap((c) => [`--c-cat-${c}-bg`, `--c-cat-${c}`])]
  const blocks = {
    ライト: ruleBody(part, ':root'),
    ダーク: ruleBody(part, ":root[data-mode='dark']"),
    'ダーク（OS 追従）': ruleBody(part, ":root:not([data-mode='light'])", '@media (prefers-color-scheme: dark)'),
    印刷: ruleBody(part, ":root:not([data-mode='light'])", '@media print'),
  }
  const ops = {
    ライト: ruleBody(tokens, '[data-ds="ops"], [data-ds="ops"][data-mode="light"]'),
    ダーク: ruleBody(tokens, '[data-ds="ops"][data-mode="dark"]'),
  }
  it('足した変数（行の地・分類の帯と線）をライト・ダーク（設定・OS 追従）・印刷の4か所で定義。ダークの2か所は同じ値・印刷はライトの値', () => {
    assert.ok(part.length > 0, '計画B3 の節が無い')
    for (const b of Object.values(blocks)) for (const n of NAMES) varOf(b, n)
    for (const n of NAMES) {
      assert.equal(varOf(blocks.ダーク, n), varOf(blocks['ダーク（OS 追従）'], n), n)
      assert.equal(varOf(blocks.印刷, n), varOf(blocks.ライト, n), n)
    }
    // 印刷の規則はダークの規則より後ろ（同じ詳細度なので後ろが勝つ）
    assert.ok(part.indexOf('@media print') > part.indexOf('@media (prefers-color-scheme: dark)'))
    // tailwind の色の名前は変数だけを指す（色の直書きをしない）
    const tw = read('../tailwind.config.js')
    assert.match(tw, /'row-alt': 'var\(--c-row-alt\)'/)
    for (const c of ['vitals', 'meals', 'activity', 'training']) {
      assert.match(tw, new RegExp(`'cat-${c}': 'var\\(--c-cat-${c}\\)'`))
      assert.match(tw, new RegExp(`'cat-${c}-bg': 'var\\(--c-cat-${c}-bg\\)'`))
    }
    // 細い線のクラス（index.css）も変数だけ。グラデーションは使わない
    const css = read('../src/index.css')
    for (const c of ['vitals', 'meals', 'activity', 'training']) assert.match(css, new RegExp(`\\.dc-cat-line-${c} \\{\\s*box-shadow: inset 0 -3px 0 var\\(--c-cat-${c}\\);\\s*\\}`))
    assert.doesNotMatch(part + css, /gradient/)
  })
  it('コントラスト: 見出しの帯の上の文字（ink）は 7 以上・行の地の上の文字（ink・ink2・ink3・link・ok・info・danger・warn）は 4.5 以上（ライト・ダーク）', () => {
    const rows = []
    for (const mode of ['ライト', 'ダーク']) {
      const b = blocks[mode]
      const o = ops[mode]
      for (const c of ['vitals', 'meals', 'activity', 'training']) {
        const r = contrast(varOf(b, `--c-cat-${c}-bg`), varOf(o, '--c-ink'))
        rows.push([mode, c, r])
        assert.ok(r >= 7, `${mode} ${c} の帯 × ink: ${r.toFixed(2)}`)
      }
      for (const t of ['--c-ink', '--c-ink2', '--c-ink3', '--c-link', '--c-ok', '--c-info', '--c-danger', '--c-warn']) {
        const r = contrast(varOf(b, '--c-row-alt'), varOf(o, t))
        assert.ok(r >= 4.5, `${mode} 行の地 × ${t}: ${r.toFixed(2)}`)
      }
      // 行の地は、ページの地と見分けがつく（うっすら）が強すぎない
      const alt = contrast(varOf(b, '--c-row-alt'), varOf(o, '--c-bg'))
      assert.ok(alt > 1.04 && alt < 1.3, `${mode} 行の地 × ページの地: ${alt.toFixed(3)}`)
    }
    assert.equal(rows.length, 8)
  })
  it('行の地は空の枠の注意の地（warn-bg）と色味で分ける・分類の色は状態の色（カードの地と枠・進み具合の札の形）の代わりに使わない', () => {
    for (const mode of ['ライト', 'ダーク']) {
      const gap = hueGap(varOf(blocks[mode], '--c-row-alt'), varOf(ops[mode], '--c-warn-bg'))
      assert.ok(gap >= 90, `${mode} 行の地と warn-bg の色相の差 ${gap.toFixed(0)}°`)
      const [r, , b] = rgb(varOf(blocks[mode], '--c-row-alt'))
      assert.ok(b > r, `${mode} 行の地は寒色`)
    }
    const prog = code('../src/lib/daycareProgress.ts')
    const card = prog.slice(prog.indexOf('export const DAYCARE_CARD_CLS'), prog.indexOf('export function daycareStateTone'))
    const marks = prog.slice(prog.indexOf('export const PROGRESS_MARK_CLS'), prog.indexOf('export function unreadProgressLabels'))
    for (const x of [card, marks]) assert.doesNotMatch(x, /cat-|row-alt/)
    // 分類の色を使うのは、見出しの帯・切り替えの印・札の下の線だけ（今日のカードの地・知らせの地には使わない）
    assert.doesNotMatch(today.slice(today.indexOf('<li key={row.residentId} className='), today.indexOf('<li key={row.residentId} className=') + 120), /cat-/)
    for (const f of ['../src/pages/DaycareVitalsMealsPage.tsx', '../src/pages/DaycareActivityBulkPage.tsx', '../src/pages/DaycareTrainingPage.tsx', '../src/pages/DaycareLunchColumns.tsx']) {
      const c = code(f)
      const body = c.slice(c.indexOf('<tbody>'), c.indexOf('</tbody>'))
      assert.doesNotMatch(body, /cat-[a-z]+-bg|DAYCARE_CATEGORY_CLS/, `${f}: 表の行（欄・知らせ）に分類の色を塗らない`)
      assert.doesNotMatch(c, /#[0-9A-Fa-f]{3,6}\b/, `${f}: 色を直書きしない`)
    }
  })
})

// ── 2026-11-09 計画B3 の反証の直し（中1・中2・中3・軽3・軽4・軽6・軽7） ──
describe('反証の直し（計画B3）', () => {
  const body = screen.slice(screen.indexOf('<tbody>'), screen.indexOf('</tbody>'))
  const db = read('../src/lib/db.ts')
  it('中1: 主食・副食の選択肢は数字キー（半角・全角・テンキーの数字）を止める。矢印・Enter・Space・Tab などは止めない', () => {
    if (DP !== null) {
      for (const k of ['0', '1', '5', '9', '０', '９']) assert.equal(DP.lunchSelectKeyBlocked(k), true, k)
      for (const k of ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Tab', 'Escape', 'Backspace', 'a', '.', '10', '']) assert.equal(DP.lunchSelectKeyBlocked(k), false, k)
    }
    const cells = lunch.slice(lunch.indexOf('const cells = (rid: number)'), lunch.indexOf('const notes = (rid: number)'))
    assert.match(cells, /<select[\s\S]*?onKeyDown=\{\(e\) => \{\s*if \(lunchSelectKeyBlocked\(e\.key\)\) e\.preventDefault\(\)\s*\}\}[\s\S]*?onChange=/)
    // 主食・副食の両方（同じ map の中の1つの select）
    assert.equal((cells.match(/<select/g) ?? []).length, 1)
  })
  it('中2: テンキーを出している間は〔元に戻す〕の知らせをテンキーの上に出す（--toast-bottom）。ほかの画面の知らせの位置は今のまま', () => {
    const ui = code('../src/components/ui.tsx')
    // 2026-11-09 計画B3 の確認の反証の直し（固定し直し・意図は同じ）（軽1）: テンキーを開いている間は、アプリの見出しの下（上に貼り付く header の下端）に出す。閉じたら元の位置（下）
    assert.match(ui, /<div\s+className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center p-4"\s+style=\{\{ top: 'var\(--toast-top, auto\)', bottom: 'var\(--toast-bottom, 5rem\)' \}\}\s*>/)
    assert.match(screen, /<div className="contents" style=\{kpOpen \? \(\{ '--toast-top': `\$\{toastTop\}px`, '--toast-bottom': 'auto' \} as CSSProperties\) : undefined\}>\s*\{lunch\.toast\}\s*<\/div>/)
    assert.match(screen, /const kpOpen = active !== null/)
    assert.match(screen, /if \(cs\.display === 'none' \|\| \(cs\.position !== 'sticky' && cs\.position !== 'fixed'\)\) continue\s*h = Math\.max\(h, el\.getBoundingClientRect\(\)\.bottom\)/)
    assert.doesNotMatch(screen, /kpBottom/)
    // --toast-bottom を付けるのはこの画面だけ
    const files = ['App.tsx', 'pages/DaycarePage.tsx', 'pages/DaycarePersonPage.tsx', 'pages/DaycareActivityBulkPage.tsx', 'pages/DaycareTrainingPage.tsx', 'pages/MealsGridPage.tsx', 'pages/VitalsGridPage.tsx']
    for (const f of files) assert.doesNotMatch(code(`../src/${f}`), /--toast-bottom/, f)
  })
  it('中3: 再測定の回が無い方の測った時刻は、状態の列の2段目に「測定 10:05」（行の高さ 53px のまま・幅は「✓ 保存済み」以下）', () => {
    // 2026-11-09 計画B3 の確認の反証の直し（固定し直し・意図は同じ）（中1・軽2）: 1段目はいつも来た・まだ（〔＋再測定〕の行はボタン）。2段目は急ぐ印 → 測った時刻 → 保存済み の順に1つ
    // （〔＋再測定〕の行にも時刻を出す）。どの行も2つまで＝ふつうの行 53px・〔＋再測定〕の行 76px
    assert.match(body, /const urgent = mark !== null && mark\.tone !== 'ok' \? mark : null\s*const showTime = si === 0 && slots\.length === 1 && time !== null\s*const line2 = urgent \?\? \(showTime \? null : mark\)/)
    assert.match(body, /\{abnormal && isLast \? \(\s*<button[\s\S]*?<\/button>\s*\) : si === 0 && inBulk \? \(\s*<span className=\{`whitespace-nowrap text-sm leading-tight \$\{cm\.textCls\}`\}>[\s\S]*?<\/span>\s*\) : null\}\s*\{line2 !== null \? \(\s*<span role="status"[\s\S]*?\) : showTime \? \(\s*<span className="whitespace-nowrap text-sm leading-tight text-ink2">\s*測定 <span className="font-num">\{time\}<\/span>/)
    // 保存済みは見た目では時刻に譲り、読み上げでは知らせる
    assert.match(body, /\{mark !== null \? \(\s*<span role="status" className="sr-only">\s*・\{mark\.text\}\s*<\/span>\s*\) : null\}/)
    // 状態の列の中は2つまで（1段目の式と2段目の式の2つの JSX 式だけ）
    const cell = body.slice(body.indexOf('<div className="flex flex-col items-stretch gap-1">'), body.indexOf('{lunchRow ? ('))
    assert.equal((cell.match(/^\s{32}\{/gm) ?? []).length, 2)
    // 幅: 「測定 10:05」（15px×2＋間 4px＋数字 9px×5）は「✓ 保存済み」（15px×5＋間 4px）以下
    assert.ok(15 * 2 + 4 + 9 * 5 <= 15 * 5 + 4)
  })
  it('軽3: 昼食と水分だけ読めない時は表を止めない（昼食の列は「読み込めません」・理由と〔最新に更新〕は表の上）。バイタルを読めない時は今までどおり止める', () => {
    assert.match(screen, /const MSG_LUNCH_UNREAD = '昼食と水分を読み込めませんでした。通信状態を確認して、〔最新に更新〕を押してください（バイタルはこのまま入れられます）。'/)
    assert.match(screen, /if \(error !== null && \(data === null \|\| data\.day !== day\)\) \{\s*return \(\s*<div className="mx-auto w-full max-w-6xl space-y-2">\s*\{header\}\s*<ErrorBlock message=\{error\}/)
    assert.doesNotMatch(screen, /ErrorBlock message=\{lunch\.error\}/)
    // 読み込み中の待ちは、昼食が読めなかった時は外れる（lunch.error があれば待たない）
    assert.match(screen, /const lunchLoading = \(lunch\.loading && lunch\.data === null\) \|\| \(lunch\.data !== null && lunch\.data\.day !== day && lunch\.error === null\)/)
    assert.match(screen, /onClick=\{\(\) => afterRelease\(\(\) => setReloadKey\(\(n\) => n \+ 1\)\)\}\s*disabled=\{releasing\}\s*className="min-h-tap rounded border border-border-strong bg-surface px-3 text-sm text-ink"\s*>\s*最新に更新/)
  })
  it('軽4: 1回の読み込みの問い合わせの数と購読の数（その日の写し・予定・出欠と購読は画面の1組だけ。昼食のフックは食事と水分だけ読む）', () => {
    /** db.ts の関数1つが出す問い合わせの数（.from( と .rpc( の数。出欠の古い DB 向けの読み直しは数えない＝同じ read の2回目） */
    const queries = (name) => {
      const at = db.indexOf(`export async function ${name}(`)
      assert.ok(at >= 0, name)
      // 関数の終わり＝行頭の } （次の関数を数えない）
      const end = db.indexOf('\n}\n', at)
      const fn = db.slice(at, end)
      return (fn.match(/\.from\('|\.rpc\('/g) ?? []).length
    }
    const loadOf = (src) => {
      const at = src.indexOf('const load = useCallback(async (target')
      assert.ok(at >= 0)
      const fn = src.slice(at, src.indexOf('}, [', at))
      return [...new Set([...fn.matchAll(/\b(fetch[A-Za-z]+)\(/g)].map((m) => m[1]))]
    }
    const pageReads = loadOf(screen)
    const hookReads = loadOf(lunch)
    assert.deepEqual(hookReads, ['fetchDaycareIntake'], '昼食のフックは食事と水分だけ読む')
    for (const f of ['fetchDaycareDay', 'fetchDaycarePlan', 'fetchDaycareAttendance']) assert.ok(pageReads.includes(f) && !hookReads.includes(f), f)
    // それまでの2画面（バイタル一括＝今の画面の読み込み・食事一括＝写し・予定・出欠・食事と水分）
    const oldVitals = pageReads
    const oldMeals = ['fetchDaycareDay', 'fetchDaycarePlan', 'fetchDaycareAttendance', 'fetchDaycareIntake']
    const sum = (names) => names.reduce((n, f) => n + queries(f), 0)
    const combined = sum([...pageReads, ...hookReads])
    const vit = sum(oldVitals)
    const meals = sum(oldMeals)
    // 写しが使える日（予定の rpc を呼ばない日）の数: バイタル一括 5・食事一括 4・統合 7（直す前の統合 9）
    const noPlan = (n, names) => n - (names.includes('fetchDaycarePlan') ? queries('fetchDaycarePlan') : 0)
    assert.equal(noPlan(vit, oldVitals), 5)
    assert.equal(noPlan(meals, oldMeals), 4)
    assert.equal(noPlan(combined, [...pageReads, ...hookReads]), 7)
    // 統合の数＝バイタル一括＋食事一括だけにある分（食事と水分の2本）。共通の材料（写し・予定・出欠）は1回ずつ
    assert.equal(combined, vit + queries('fetchDaycareIntake'))
    assert.ok(combined < vit + meals)
    // 購読（Realtime の channel）: 画面の subscribeChanges・subscribeDaycareChanges の2つだけ＝それまでの2画面のどちらとも同じ数
    const subs = (src) => (src.match(/\b(subscribeChanges|subscribeDaycareChanges)\(/g) ?? []).length
    assert.equal(subs(screen), 2)
    assert.equal(subs(lunch), 0)
    assert.equal((screen.match(/\bqueueSubscribe\(/g) ?? []).length, 1)
    assert.doesNotMatch(lunch, /queueSubscribe\(/)
    // 食事・水分の変更と、送信待ちが送れて減った時は、画面の購読から昼食の列を読み直す
    assert.match(screen, /lunchReloadRef\.current = lunch\.reload/)
    assert.match(screen, /if \(n < last\) \{\s*scheduleReload\(\)\s*lunchReloadRef\.current\(\)\s*\}/)
    // 昼食のフックの材料は画面の読み込みの結果（同じ日の時だけ使う）
    assert.match(lunch, /const mat = materials !== null && materials\.day === day \? materials : null/)
    assert.match(lunch, /const missing = mat\?\.missing \?\? false/)
  })
  it('軽6: 今いる画面の切り替えの上では、分類の色の印に地の色の細い縁（縁×primary・印×縁が明暗とも 3 以上）', () => {
    const tokens = read('../src/styles/tokens.css')
    const ruleBody = (sel) => {
      const at = tokens.indexOf(`${sel} {`)
      return tokens.slice(tokens.indexOf('{', at) + 1, tokens.indexOf('}', at))
    }
    const hex = (b, n) => new RegExp(`${n}:\\s*(#[0-9A-Fa-f]{6})`, 'i').exec(b)[1]
    const lin = (c) => {
      const x = c / 255
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
    }
    const lum = (h) => {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16))
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }
    const cr = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    const part = tokens.slice(tokens.indexOf('/* ── デイの分類の色と一括の表の行の地'))
    const partRule = (sel) => {
      const at = part.indexOf(`${sel} {`)
      return part.slice(part.indexOf('{', at) + 1, part.indexOf('}', at))
    }
    for (const [ops, cat] of [
      [ruleBody('[data-ds="ops"], [data-ds="ops"][data-mode="light"]'), partRule(':root')],
      [ruleBody('[data-ds="ops"][data-mode="dark"]'), partRule(":root[data-mode='dark']")],
    ]) {
      const surface = hex(ops, '--c-surface')
      const primary = hex(ops, '--c-primary')
      assert.ok(cr(surface, primary) >= 3, '縁 × primary')
      for (const c of ['vitals', 'meals', 'activity', 'training']) assert.ok(cr(hex(cat, `--c-cat-${c}`), surface) >= 3, `${c} の印 × 縁`)
    }
  })
  it('軽7: 予定の方がいない時の案内は、それまでの食事一括の文（今日の画面の〔予定にない方を追加〕…ここに出ます）', () => {
    assert.match(screen, /予定外で来た方は、今日の画面の〔予定にない方を追加〕で足したカードを押し、〔予定外で到着〕を押すと、ここに出ます。/)
  })
  it('軽5: 古い試験の名前・欄送りの古いコメントを残さない', () => {
    assert.doesNotMatch(read('../src/styles/tokens.css'), /daycare-colors\.test/)
    assert.doesNotMatch(read('../src/pages/DaycareVitalsMealsPage.tsx'), /KT の次は次の方の血圧の上＝/)
  })
})

describe('状態の列の2段目の決め方（計画B3 の確認の反証 中1・軽2）', () => {
  it('急ぐ印（要確認・未送信・送信中）→ 測った時刻（再測定の回が無い方の1回目）→ ✓ 保存済み の順に1つ。来た・まだは1段目に残る', () => {
    // 画面の式をそのまま抜き出して評価する（型の無い式）
    const body = screen.slice(screen.indexOf('<tbody>'), screen.indexOf('</tbody>'))
    const expr = /const urgent = (mark !== null && mark\.tone !== 'ok' \? mark : null)\s*const showTime = (si === 0 && slots\.length === 1 && time !== null)\s*const line2 = (urgent \?\? \(showTime \? null : mark\))/.exec(body)
    assert.ok(expr, '式が見つからない')
    const decide = new Function('mark', 'si', 'slots', 'time', `const urgent = ${expr[1]}; const showTime = ${expr[2]}; const line2 = ${expr[3]}; return line2 !== null ? line2.text : showTime ? '測定 ' + time : null`)
    const m = (text, tone) => ({ mark: '', text, tone })
    const one = [{}]
    const two = [{}, {}]
    // 保存済みは時刻に譲る
    assert.equal(decide(m('保存済み', 'ok'), 0, one, '10:05'), '測定 10:05')
    // 急ぐ印は時刻より先
    assert.equal(decide(m('要確認', 'warn'), 0, one, '10:05'), '要確認')
    assert.equal(decide(m('未送信', 'warn'), 0, one, '10:05'), '未送信')
    assert.equal(decide(m('送信中', 'info'), 0, one, '10:05'), '送信中')
    // 時刻が無い（まだ測っていない）時は保存済み・印も無ければ空
    assert.equal(decide(m('保存済み', 'ok'), 0, one, null), '保存済み')
    assert.equal(decide(null, 0, one, null), null)
    assert.equal(decide(null, 0, one, '9:40'), '測定 9:40')
    // 再測定の回がある方の1回目・再測定の行は時刻を出さない（氏名の列の「1回目（時刻）」「↳ 再測定 n（時刻）」で見る）
    assert.equal(decide(m('保存済み', 'ok'), 0, two, '10:05'), '保存済み')
    assert.equal(decide(null, 1, two, '10:20'), null)
  })
})
