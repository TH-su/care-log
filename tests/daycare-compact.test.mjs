// デイの今日のカードと一括の4画面を詰めた（2026-11-09 代表者の指示「ボタン自体を小さくし、より多くの利用者を１画面で見ることが
// できるよう調整せよ。タイトル帯やその他表示が小さくなってもよい」・親の依頼の1と2）の静的な検査。
// 詰めても守ること: 押せる所は 44px 以上（min-h-tap・min-w-tap）・表の行は欄の上下 4px ずつ（隣の行の欄と 8px あく）・
// 文字は 15px 以上（ふりがなだけ入居者マスタの決まりの 14px）・見出しの行を上に残す作り（#56）はそのまま
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
/** 行コメントと複数行コメントを除いた本文 */
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const today = code('../src/pages/DaycarePage.tsx')
const css = read('../src/index.css')
// 2026-11-09 計画B3（固定し直し・意図は同じ）: バイタル一括と食事一括を1つの画面（バイタル・食事＝DaycareVitalsMealsPage）にした。一括の画面は3つ。
// 食事一括の昼食と水分の欄はフック（DaycareLunchColumns.tsx の cells）で、画面の表の右の3列になる
const BULK = {
  vitals: code('../src/pages/DaycareVitalsMealsPage.tsx'),
  activity: code('../src/pages/DaycareActivityBulkPage.tsx'),
  training: code('../src/pages/DaycareTrainingPage.tsx'),
}
const LUNCH = code('../src/pages/DaycareLunchColumns.tsx')
const LUNCH_CELLS = LUNCH.slice(LUNCH.indexOf('const cells = (rid: number)'), LUNCH.indexOf('const notes = (rid: number)'))

describe('デイの今日のカードを小さく（2026-11-09）', () => {
  const list = today.slice(today.indexOf('<ul className="dc-cards"'), today.indexOf('</ul>', today.indexOf('<ul className="dc-cards"')))
  it('カードの最小幅は 10rem（iPad 横で6列・縦で4列・スマホで2列）。rem なので文字を大きくすると列が減る', () => {
    assert.match(css, /\.dc-cards \{\s*display: grid;\s*grid-template-columns: repeat\(auto-fill, minmax\(min\(10rem, 100%\), 1fr\)\);\s*gap: var\(--tap-gap\);/)
  })
  it('一覧は画面の幅いっぱい（max-w-5xl と外側の p-4 を外した）・上の段は2段（件数は日付の右）', () => {
    assert.doesNotMatch(today, /max-w-5xl|space-y-4 p-4/)
    // 2026-11-09 計画B（固定し直し・意図は同じ）: 切り替えに添える未入力の数（navPending）も、件数と同じく読み込めた後だけ渡す
    assert.match(today, /const header = \(counts: ReactNode = null, navPending\?: DaycareNavPending\) => \(/)
    // 件数は日付の段の中（日付の group の後）
    const h = today.slice(today.indexOf('const header = (counts'), today.indexOf('if (loading && data === null)'))
    assert.ok(h.indexOf('aria-label="日付"') < h.indexOf('{counts}'), '件数は日付の右')
    assert.match(today, /\{header\(\s*<ul className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface px-3 py-1" aria-label="件数">/)
  })
  it('〔休み〕〔取消〕は押せる下限の 44px（高さ・幅とも）で、どのカードも同じ幅・カードの間は 8px（gap-gap と同じ --tap-gap）', () => {
    assert.match(today, /const REST_BTN =\s*'inline-flex min-h-tap min-w-tap /)
    assert.match(today, /const DANGER_CELL_BTN =\s*'inline-flex min-h-tap min-w-tap /)
    assert.doesNotMatch(list, /min-w-\[5rem\]/)
  })
  it('カードの中: 氏名は〔休み〕の横・行の間を詰める・文字は 15px 以上（ふりがなだけ 14px）・切らずに折り返す', () => {
    // 2026-11-09 計画B（固定し直し・意図は同じ）: ふりがなは〔休み〕の横から、氏名と〔休み〕の段の下（カードの幅いっぱい）へ戻した
    // （2026-10-24 の決まり）。予定・到着と帰宅の2段は状態の段1つに、入浴・昼食・バイタルの文字の段は進み具合の印にした（daycare-progress.test.mjs）
    assert.match(list, /<div className="min-w-\[5em\] flex-1">\s*<Link to=\{personPath\(row\.residentId, day, today\)\} className="dc-card-link block rounded">/)
    assert.match(list, /<span className="block break-words text-base font-bold leading-tight text-ink">/)
    assert.match(list, /<p className="break-words text-xs leading-tight text-ink2">\{kana\}<\/p>/)
    // 14px（text-xs）はふりがなの1か所だけ。13px（text-2xs）は使わない
    assert.equal((list.match(/\btext-xs\b/g) ?? []).length, 1)
    assert.doesNotMatch(today, /\btext-2xs\b/)
    assert.doesNotMatch(list, /\btruncate\b/)
    // 状態の段と進み具合の印は 15px（text-sm）の詰めた段
    assert.match(list, /<p className="break-words text-sm font-bold leading-tight text-ink">\s*<span aria-hidden="true">\{tone\.mark\} <\/span>\s*\{tone\.word\}\s*<\/p>/)
    // 2026-11-09 計画B3（固定し直し・意図は同じ）: 札の下に分類の色の細い線（progressCategoryLine・枠の形の区別はそのまま）
    assert.match(list, /className=\{`rounded px-1 text-sm leading-tight \$\{PROGRESS_MARK_CLS\[mk\.state\]\} \$\{progressCategoryLine\(mk\.key\)\}`\}/)
    // 入浴の予定は印の「浴」で分かるので、状態の段に「・入浴」を足さない
    assert.doesNotMatch(list, /'・入浴'/)
    assert.doesNotMatch(list, /入浴 \{bathText\}/)
  })
  it('切り替え: 押せる高さ 44px のまま文字と左右の余白を詰める・1280px 未満では括弧の補足（到着・休み）を出さない', () => {
    const nav = today.slice(today.indexOf('export function DaycareNav'), today.indexOf('function PlanBanners'))
    assert.match(nav, /const navCls = 'flex min-h-tap items-center rounded border border-border-strong bg-surface px-3 text-sm text-ink'/)
    // 2026-11-09 計画B（固定し直し・意図は同じ）: 補足を出す幅を 640px（sm）から 1280px（xl）に上げた（今日の画面で未入力の数を添えても、
    // iPad 横 1180px で切り替えと記録者が1段に収まるように＝親の決定・デイの5画面で共通）
    assert.match(nav, /<span className="hidden xl:inline">\{it\.label\.slice\(it\.label\.indexOf\('（'\)\)\}<\/span>/)
    assert.doesNotMatch(nav, /hidden sm:inline/)
    // 項目の名前（読み上げの元）は今までどおり
    assert.match(nav, /label: '今日（到着・休み）'/)
  })
})

describe('一括の4画面で行を増やす（2026-11-09）', () => {
  it('外側の余白（p-4）と段の間（space-y-4）を詰めた・幅はどの画面も max-w-6xl（切り替えの位置がそろう）', () => {
    for (const [k, p] of Object.entries(BULK)) {
      assert.doesNotMatch(p, /space-y-4 p-4/, k)
      assert.ok((p.match(/<div className="mx-auto w-full max-w-6xl space-y-2">/g) ?? []).length >= 3, `${k}: 読み込み中・失敗・本体の3つ`)
    }
  })
  it('見出しの行を上に残す作り（#56）はそのまま（dc-table-fit・isolate・useTableFit・見出しは sticky top-0）', () => {
    for (const [k, p] of Object.entries(BULK)) {
      assert.match(p, /className="dc-table-fit relative isolate overflow-auto"/, k)
      assert.match(p, /useTableFit\(tableBox/, k)
      assert.match(p, /<th scope="col" className="sticky left-0 top-0 z-30 bg-surface2/, k)
      // 2026-11-09 計画B3（固定し直し・意図は同じ）: 氏名の列（sticky）の地は行と同じ1人ずつ交互の地（daycareRowTone）。下を流れる欄を透かさないのは同じ
      assert.match(p, /<th scope="row" className=\{`sticky left-0 z-10 \$\{rowBg\} px-2 py-1 text-left font-normal`\}>/, k)
      assert.match(p, /const rowBg = daycareRowTone\(pi\)/, k)
    }
  })
  it('行の高さは押せる下限の近く: 欄は 44px（バイタルは 56px から）・行の上下は 4px ずつ（py-1）より詰めない', () => {
    assert.match(BULK.vitals, /className=\{`flex min-h-tap w-full flex-col items-center justify-center rounded px-1 text-center \$\{/)
    assert.doesNotMatch(BULK.vitals, /min-h-14/)
    for (const [k, p] of Object.entries(BULK)) {
      const body = p.slice(p.indexOf('<tbody>'), p.indexOf('</tbody>'))
      assert.doesNotMatch(body, /\bpy-0(\.5)?\b/, `${k}: 欄の上下の余白は 4px より詰めない（隣の行の欄と 8px あける）`)
    }
    // 2026-11-09 計画B3（固定し直し・意図は同じ）: 昼食と水分の欄（フックの cells）も同じ
    assert.doesNotMatch(LUNCH_CELLS, /\bpy-0(\.5)?\b/, 'meals')
    assert.match(LUNCH_CELLS, /<td key=\{f\} className="px-1 py-1">/)
  })
  it('氏名の列: 1人の記録への入口は氏名のリンク（押せる高さ 44px の中に氏名と札の2段）。活動一括・機能訓練の〔記録 ›〕〔1日の記録 ›〕はまとめた', () => {
    // 2026-11-09 計画B（固定し直し・意図は同じ）: 名前の後の「（未到着）」は、見えている来た・まだの言葉（daycareCameMark）に
    assert.match(BULK.activity, /aria-label=\{`\$\{name\}さん（\$\{cm\.word\}）の1日の記録を開く（活動の度合い・前回と同じ）`\}\s+className="flex min-h-tap flex-col justify-center rounded/)
    assert.match(BULK.training, /aria-label=\{`\$\{name\}さんの1日の記録を開く`\}\s+className="flex min-h-tap items-center rounded/)
    // 2026-11-09 計画B3（固定し直し・意図は同じ）: 食事一括の氏名のリンクは、バイタル・食事の画面の氏名の列（1回目の行）
    assert.match(BULK.vitals, /<Link to=\{personPath\(row\.residentId, day, today\)\} className="flex min-h-tap flex-col justify-center/)
    for (const k of ['activity', 'training']) {
      assert.doesNotMatch(BULK[k], /記録<span aria-hidden="true"> ›<\/span>\s*<\/Link>/, `${k}: 枠つきの〔記録 ›〕は無い`)
      assert.match(BULK[k], /<span className="text-base font-bold leading-tight text-link">\s*\{name\}\s*<span aria-hidden="true"> ›<\/span>/, `${k}: 氏名に › を付けて押せることを示す`)
    }
  })
  it('文字は 15px 以上（4画面とも text-xs・text-2xs を使わない）', () => {
    // 2026-11-09 計画B2（固定し直し・意図は同じ）: バイタル一括の空の欄の「前回…」だけ 14px（text-xs）にした（入れた値と見分けるため・仕様の例外）。
    // 14px はその1か所だけで、中身は「前回」の付いた値か「—」。13px（text-2xs）は4画面とも使わない
    for (const [k, p] of Object.entries(BULK)) {
      assert.doesNotMatch(p, /\btext-2xs\b/, k)
      if (k !== 'vitals') assert.doesNotMatch(p, /\btext-xs\b/, k)
    }
    // 2026-11-09 計画B3（固定し直し・意図は同じ）: 昼食と水分の欄（フック）も 14px・13px を使わない
    assert.doesNotMatch(LUNCH, /\btext-(2?xs)\b/, 'meals')
    assert.equal((BULK.vitals.match(/\btext-xs\b/g) ?? []).length, 1, 'バイタル一括の 14px は1か所だけ')
    assert.match(BULK.vitals, /<span className="font-num text-xs leading-tight text-ink3" aria-hidden="true">\s*\{pv \? `前回\$\{fmtVal\(f, pv\.value\)\}` : '—'\}\s*<\/span>/)
  })
  it('バイタル一括: 日付と「表示する方」を1段に。食事一括: 見出し・未入力の数・予定の人数を1段に、合計と水分の欄を横に', () => {
    // 2026-11-09 計画B（固定し直し・意図は同じ）: 未入力の数を同じ段に入れるため、段の間を 16px から 12px に詰めた（押す所どうしは 8px 以上）
    assert.match(BULK.vitals, /<div className="flex flex-wrap items-center gap-x-3 gap-y-2">\s*<div className="flex flex-wrap items-center gap-gap" role="group" aria-label="日付">[\s\S]*?<div className="flex flex-wrap gap-gap" role="group" aria-label="表示する方">/)
    // 2026-11-09 計画B（固定し直し・意図は同じ）: 未入力の数は4画面で同じ部品（DaycareUnfilledCount）にした
    // 2026-11-09 計画B3（固定し直し・意図は同じ）: 食事一括の「未入力の数 → 予定の人数」は、バイタル・食事の画面の日付と「表示する方」の段の右に並べる（新しい段を足さない）
    const v = BULK.vitals
    const top = v.slice(v.indexOf('role="group" aria-label="表示する方"'), v.indexOf('{releasing ?'))
    assert.ok(top.indexOf('<DaycareUnfilledCount') > 0 && top.indexOf('<DaycareUnfilledCount') < top.indexOf('予定の方'), '未入力の数 → 予定の人数')
    // 2026-11-09 計画B3 の手直し（固定し直し・意図は同じ）: 合計と水分の欄は横に並べる（#104 と同じ・行の高さを欄の 44px に保つ）。合計の幅は 64px 以上でそろえる。単位は見出し
    assert.match(LUNCH_CELLS, /<div className="flex items-center gap-x-1\.5">\s*<p className="min-w-16 whitespace-nowrap text-sm text-ink">\s*計 /)
    assert.match(LUNCH_CELLS, /className="flex items-center gap-2"\s*>\s*<input/)
  })
  it('食事一括の氏名の列を広げるのは 1024px 以上だけ（iPad 縦で表が横にはみ出さない・反証 中3）。欄へ送る時の逃げも同じ幅', () => {
    assert.match(css, /@media \(min-width: 1024px\) \{\s*\.dc-meal-name \{\s*width: min\(14rem, 22vw\);\s*\}\s*\.dc-table-fit:has\(\.dc-meal-name\) \{\s*scroll-padding-left: calc\(min\(14rem, 22vw\) \+ 1rem\);/)
    // 1024px 未満で効く .dc-meal-name の幅の指定は無い（.dc-vital-name のまま）
    const outside = css.replace(/@media \(min-width: 1024px\) \{[\s\S]*?\n\}/g, '')
    assert.doesNotMatch(outside, /\.dc-meal-name \{/)
  })
})
