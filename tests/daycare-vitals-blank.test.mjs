// デイ 計画B2（2026-11-09・代表者の指示）: バイタル一括の列の並び（血圧（上 / 下）｜P｜SpO2｜KT）・記入していない枠を目立たせる・
// 全部の枠が埋まるまでの知らせ（▲ 未入力 n名（m欄）／✓ 全員入力済み）の試験。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（daycare.ts）: 一括の欄の順（DC_BULK_VITAL_ORDER）・次の欄（nextBulkVitalField）・再測定の始まりの欄（firstAbnormalField の order）
// 2. 純ロジック（daycareProgress.ts）: 1人の空の欄の数（バイタル5欄・昼食2欄・活動・訓練1欄）・合計（n名・m欄）・到着を問わない・
//    送信待ちは入力済み・拒食・再測定は数えない・今日の画面の切り替えの数と一括の画面の n が同じ
// 3. 静的検査: バイタル一括の列・「血圧」の見出し（colSpan 2）・「上」「下」の見出しが無い・「/」・欄の間（下と P の間が広い）・欄送り・
//    空の枠の見た目（4画面）・「前回」「未」の字・行の印・上の数の部品・今日の画面の切り替えの数
// 4. コントラスト（tokens.css の ops 明・暗）: 空の枠の中の文字・行の印・上の数が 4.5 以上
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

let DC = null
let P = null
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
  DC = await import('../src/lib/daycare.ts?daycare-vitals-blank')
  P = await import('../src/lib/daycareProgress.ts?daycare-vitals-blank')
} catch (e) {
  loadError = e
  DC = null
  P = null
}

const D = '2026-11-09'
/** 一覧の1行（試験用。名簿の氏名は持たない） */
const row = (residentId, over = {}) => ({ residentId, state: 'planned', planned: true, hospitalized: false, ...over })
const FULL = { temp: 36.5, sys_bp: 120, dia_bp: 70, pulse: 70, spo2: 97 }

if (DC === null || P === null) {
  registerLoadFailure('デイ 計画B2 の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('純ロジック: バイタル一括の欄の順（daycare.ts）', () => {
    it('一括の列と欄送りの順は 血圧の上 → 下 → P → SpO2 → KT。共通の DAYCARE_VITAL_FIELDS（1人の画面など）の順は変えない', () => {
      assert.deepEqual([...DC.DC_BULK_VITAL_ORDER], ['sys_bp', 'dia_bp', 'pulse', 'spo2', 'temp'])
      assert.deepEqual([...DC.DAYCARE_VITAL_FIELDS], ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2'])
      assert.deepEqual(DC.DC_BULK_VITAL_ORDER.map((f) => DC.DAYCARE_VITAL_HEAD[f]), ['上', '下', 'P', 'SpO2', 'KT'])
    })
    it('次の欄（nextBulkVitalField）: 上 → 下 → P → SpO2 → KT、KT の次は null（次の方の血圧の上へ）', () => {
      const chain = []
      for (let f = DC.DC_BULK_VITAL_ORDER[0]; f !== null; f = DC.nextBulkVitalField(f)) chain.push(f)
      assert.deepEqual(chain, ['sys_bp', 'dia_bp', 'pulse', 'spo2', 'temp'])
      assert.equal(DC.nextBulkVitalField('temp'), null)
      assert.equal(DC.nextBulkVitalField('spo2'), 'temp')
      assert.equal(DC.nextBulkVitalField('nope'), null, '知らない欄は null')
    })
    it('再測定の始まりの欄（firstAbnormalField）: order を渡すとその並びで探し、無ければ並びの先頭。省くと今までどおり（体温から）', () => {
      // 体温と SpO2 が基準を外れた: 今までの並びは体温、一括の並びは SpO2 が先
      assert.equal(DC.firstAbnormalField({ temp: 37.9, spo2: 89 }), 'temp')
      assert.equal(DC.firstAbnormalField({ temp: 37.9, spo2: 89 }, null, undefined, DC.DC_BULK_VITAL_ORDER), 'spo2')
      // 外れた欄が無い: 今までは体温・一括は血圧の上
      assert.equal(DC.firstAbnormalField(FULL), 'temp')
      assert.equal(DC.firstAbnormalField(FULL, null, undefined, DC.DC_BULK_VITAL_ORDER), 'sys_bp')
      // 今までの試験と同じ値（省いた時は変わらない）
      assert.equal(DC.firstAbnormalField({ temp: 36.5, sys_bp: 160, spo2: 89 }), 'sys_bp')
    })
  })

  describe('純ロジック: 空の欄の数え方（daycareProgress.ts）', () => {
    it('バイタル（vitalBlankFields）: 1人5欄＝最初の回の 上・下・P・SpO2・KT の値の無い欄。0 も値・数でない値は空', () => {
      assert.equal(P.vitalBlankFields(null), 5)
      assert.equal(P.vitalBlankFields(undefined), 5)
      assert.equal(P.vitalBlankFields({}), 5)
      assert.equal(P.vitalBlankFields({ temp: 36.5 }), 4)
      assert.equal(P.vitalBlankFields(FULL), 0)
      assert.equal(P.vitalBlankFields({ ...FULL, pulse: 0 }), 0, '0 も値')
      assert.equal(P.vitalBlankFields({ ...FULL, spo2: null }), 1)
      assert.equal(P.vitalBlankFields({ ...FULL, spo2: 'x' }), 1, '数でない値は空')
    })
    it('昼食（lunchBlankFields）: 1人2欄（主食・副食）・拒食はどちらも入力済み・lunchFilled と同じ考え（0 の時だけ入力済み）', () => {
      const cases = [
        [null, 2],
        [undefined, 2],
        [{ main_amount: null, side_amount: null, status: null }, 2],
        [{ main_amount: 5, side_amount: null, status: 'eaten' }, 1],
        [{ main_amount: null, side_amount: 0, status: 'eaten' }, 1],
        [{ main_amount: 0, side_amount: 0, status: 'eaten' }, 0],
        [{ main_amount: null, side_amount: null, status: 'refused' }, 0],
        [{ main_amount: null, side_amount: null, status: 'out' }, 2],
      ]
      for (const [meal, n] of cases) {
        assert.equal(P.lunchBlankFields(meal), n, JSON.stringify(meal))
        assert.equal(P.lunchFilled(meal), n === 0, `lunchFilled と同じ: ${JSON.stringify(meal)}`)
      }
    })
    it('活動・訓練（recordBlankFields）: 1人1欄（記録があれば 0・無ければ 1）', () => {
      assert.equal(P.recordBlankFields(true), 0)
      assert.equal(P.recordBlankFields(false), 1)
    })
    it('合計（bulkBlankSummary）: n＝空の欄がある方の数・m＝空の欄の合計。全部埋まった時だけ 0', () => {
      assert.deepEqual(P.bulkBlankSummary([5, 0, 4]), { people: 2, fields: 9 })
      assert.deepEqual(P.bulkBlankSummary([0, 0]), { people: 0, fields: 0 })
      assert.deepEqual(P.bulkBlankSummary([]), { people: 0, fields: 0 })
      assert.deepEqual(P.bulkBlankSummary([1, -1, 1.5, Number.NaN]), { people: 1, fields: 1 }, '壊れた値は数えない')
    })
    it('到着を問わず数える: 画面に出る方（daycareBulkRows＝休み・入院中を除く・予定外で来た方を含む）は来所前でも数える。全員が来所前でも 0 にしない', () => {
      const rows = [
        row(1), // 来所前・未測定
        row(2, { state: 'present' }), // 在席・全部
        row(3, { state: 'absent' }), // 休み（画面に出ない）
        row(4, { hospitalized: true }), // 入院中（画面に出ない）
        row(5, { state: 'present', planned: false }), // 予定外で来た方・体温だけ
      ]
      const vals = new Map([
        [1, null],
        [2, FULL],
        [3, null],
        [4, null],
        [5, { temp: 36.5 }],
      ])
      const shown = DC.daycareBulkRows(rows)
      assert.deepEqual(shown.map((r) => r.residentId), [1, 2, 5])
      assert.deepEqual(P.bulkBlankSummary(shown.map((r) => P.vitalBlankFields(vals.get(r.residentId)))), { people: 2, fields: 9 })
      // 全員が来所前（だれも来ていない）でも「全員入力済み」にしない
      const before = [row(1), row(2)]
      assert.deepEqual(P.bulkBlankSummary(DC.daycareBulkRows(before).map(() => P.vitalBlankFields(null))), { people: 2, fields: 10 })
      // 予定の方が1人も居ない日だけ 0（画面は数を出さない）
      assert.deepEqual(P.bulkBlankSummary(DC.daycareBulkRows([row(3, { state: 'absent' })]).map(() => 5)), { people: 0, fields: 0 })
    })
    it('送信待ち・端末の値は入力済み（画面に出している値で数える）', () => {
      // バイタル: 送信待ちの上と下（vitalShownValues＝一括の valueOf と同じ）
      assert.equal(P.vitalBlankFields(P.vitalShownValues({ values: { sys_bp: 120, dia_bp: 70 } }, null)), 3)
      assert.equal(P.vitalBlankFields(P.vitalShownValues({ values: { temp: null } }, { temp: 36.5 })), 5, '送信待ちで消した値は空')
      // 昼食: 送っている途中の値（lunchShownWith＝食事一括の mealShownFor と同じ）
      assert.equal(P.lunchBlankFields(P.lunchShownWith(null, { state: 'pending', values: { main_amount: 8, side_amount: 7 } })), 0)
      assert.equal(P.lunchBlankFields(P.lunchShownWith(null, { state: 'pending', values: { status: 'refused' } })), 0, '拒食の送信待ち')
      // 活動: 送信待ちの追加（止まっていても出す）
      assert.equal(
        P.recordBlankFields(P.activityCellsFilled(P.activityShownCells([], [{ kind: 'add', residentId: 4, day: D, label: '体操', participation: 'full', stopped: true }], 4, D))),
        0,
      )
      // 訓練: 送信待ちの追加（止まっている分も）
      assert.equal(P.recordBlankFields(P.trainingFilled([], [{ kind: 'add', table: 'daycare_training_sessions', residentId: 4, day: D, stopped: true }], 4, D)), 0)
    })
    it('再測定の回は数えない（最初の回だけ）: 1回目が全部入っていれば、空の再測定の回があっても 0', () => {
      const live = [{ id: 11, resident_id: 7, client_key: `dc:${D}:7:1`, ...FULL }]
      const slots = P.daycareVitalSlotsWithPending(live, live.map((v) => v.client_key), 7, D, [2], () => false)
      assert.deepEqual(slots.map((s) => s.seq), [1, 2])
      assert.equal(P.vitalBlankFields(P.vitalShownValues(null, slots[0].vital)), 0)
      assert.equal(P.vitalBlankFields(P.vitalShownValues(null, slots[1].vital)), 5, '（数えない）再測定の回は空')
    })
    it('今日の画面の切り替えの数（daycareNavPending）は、同じ入力の一括の画面の n（bulkBlankSummary の people）と同じ', () => {
      // 2026-11-09 計画B3（固定し直し・意図は同じ）: バイタル・食事（1人7欄＝vitalsMealsBlankFields）・活動・訓練の3つ
      const vit = [5, 0, 0]
      const meals = [P.lunchBlankFields(null), P.lunchBlankFields({ main_amount: null, side_amount: null, status: 'refused' }), P.lunchBlankFields({ main_amount: 5, side_amount: null, status: 'eaten' })]
      const blanks = {
        vitalsMeals: vit.map((v, i) => P.vitalsMealsBlankFields(v, meals[i])),
        activity: [1, 1, 0],
        training: [0, 0, 0],
      }
      const nav = P.daycareNavPending(blanks)
      for (const k of ['vitalsMeals', 'activity']) assert.equal(nav[k], P.bulkBlankSummary(blanks[k]).people, k)
      assert.equal(nav.vitalsMeals, 2, '7欄のどれかが空の方（バイタルだけ空・昼食だけ空も数える）')
      assert.equal(nav.training, undefined, '0 は入れない（全員入力済み）')
      assert.deepEqual(P.daycareNavPending({ ...blanks, vitalsMeals: null, activity: null }), {}, '読めない項目は数を出さない')
    })
  })
}

describe('静的検査: バイタル一括の列と欄送り（計画B2）', () => {
  const page = code('../src/pages/DaycareVitalsMealsPage.tsx')
  const head = page.slice(page.indexOf('<thead>'), page.indexOf('</thead>'))
  const body = page.slice(page.indexOf('<tbody>'), page.indexOf('</tbody>'))
  it('見出し: 氏名｜血圧（2列にまたがる・sticky のまま）｜P｜SpO2｜KT｜再測定｜状態。「上」「下」の見出しは出さない', () => {
    // 2026-11-09 計画B3（固定し直し・意図は同じ）: バイタルの見出しの地は分類の色の帯（ティール・DAYCARE_CATEGORY_CLS.vitals.band・帯の上の文字は text-ink）。
    // 再測定と状態は1つの列（状態・読み上げは「状態・再測定」）に詰め、右に昼食の3列
    assert.match(head, /<th scope="col" colSpan=\{2\} className=\{`sticky top-0 z-20 \$\{DAYCARE_CATEGORY_CLS\.vitals\.band\} px-2 py-2 text-sm font-bold text-ink`\}>\s*血圧\s*<\/th>/)
    assert.match(head, /\{DC_BULK_VITAL_ORDER\.filter\(\(f\) => f !== 'sys_bp' && f !== 'dia_bp'\)\.map\(\(f\) => \(\s*<th key=\{f\} scope="col" className=\{`sticky top-0 z-20 w-24 \$\{DAYCARE_CATEGORY_CLS\.vitals\.band\} px-2 py-2 text-sm font-bold text-ink`\}>/)
    assert.ok(head.indexOf('氏名') < head.indexOf('血圧') && head.indexOf('血圧') < head.indexOf('DC_BULK_VITAL_ORDER') && head.indexOf('DC_BULK_VITAL_ORDER') < head.indexOf('再測定'))
    assert.doesNotMatch(head, />\s*[上下]\s*</, '「上」「下」の見出しの文字は無い')
    assert.doesNotMatch(head, /DAYCARE_VITAL_FIELDS/)
    // 読み上げは各欄の「血圧の上」「血圧の下」（DAYCARE_VITAL_LABEL）
    assert.match(body, /aria-label=\{`\$\{nameOf\(row\.residentId\)\} \$\{DAYCARE_VITAL_LABEL\[f\]\} /)
    // 列の数は今と同じ（氏名＋5欄＋再測定＋状態）＝行の下の詳しい文の colSpan はそのまま
    // 2026-11-09 計画B3（固定し直し・意図は同じ）: 列は 氏名＋5欄＋状態（再測定を含む）＋昼食の3列＝10
    assert.match(body, /<td colSpan=\{DAYCARE_VITAL_FIELDS\.length \+ 5\} className="p-0">/)
  })
  it('欄の並びは DC_BULK_VITAL_ORDER（上 → 下 → P → SpO2 → KT）・欄の高さは 44px のまま', () => {
    assert.match(body, /\{DC_BULK_VITAL_ORDER\.map\(\(f\) => \{\s*const \{ v, local \} = valueOf\(slot, f\)/)
    assert.doesNotMatch(body, /\{DAYCARE_VITAL_FIELDS\.map\(\(f\) => \{/)
    assert.match(body, /className=\{`flex min-h-tap w-full flex-col items-center justify-center rounded px-1 text-center \$\{/)
  })
  it('欄の幅はどれも 88px・ほかの欄の間は 8px・上と下の間に「/」・下と P の間はほかより広い（20px）', () => {
    const m = /const tdCls = f === 'sys_bp' \? '([^']+)' : f === 'dia_bp' \? '([^']+)' : '([^']+)'/.exec(body)
    assert.ok(m, 'tdCls')
    const [sysCls, diaCls, otherCls] = [m[1], m[2], m[3]]
    // Tailwind の既定の 4px 刻み（px-1＝4・pl-2＝8・pr-4＝16・w-24＝96・w-28＝112）
    const unit = (cls, re) => {
      const x = re.exec(cls)
      return x === null ? null : Number(x[1]) * 4
    }
    const pad = (cls) => {
      const px = unit(cls, /\bpx-(\d+(?:\.\d+)?)\b/)
      return { l: unit(cls, /\bpl-(\d+(?:\.\d+)?)\b/) ?? px ?? 0, r: unit(cls, /\bpr-(\d+(?:\.\d+)?)\b/) ?? px ?? 0 }
    }
    const width = (cls) => unit(cls, /\bw-(\d+)\b/)
    const sys = pad(sysCls)
    const dia = pad(diaCls)
    const other = pad(otherCls)
    // P・SpO2・KT の列の幅は見出しの w-24（96px）
    // 2026-11-09 計画B3（固定し直し・意図は同じ）: 見出しの地は分類の色の帯
    assert.match(head, /w-24 \$\{DAYCARE_CATEGORY_CLS\.vitals\.band\}/)
    assert.equal(width(sysCls) - sys.l - sys.r, 88, '血圧の上の欄 88px')
    assert.equal(width(diaCls) - dia.l - dia.r, 88, '血圧の下の欄 88px')
    assert.equal(96 - other.l - other.r, 88, 'P・SpO2・KT の欄 88px')
    const gapSysDia = sys.r + dia.l
    const gapDiaP = dia.r + other.l
    const gapOther = other.r + other.l
    assert.equal(gapOther, 8, 'ほかの欄の間 8px')
    // 確認の反証 軽2（固定し直し・意図は同じ）: 上と下の間は 12px から 14px に（押している欄の外側の線 2px が「/」に触れたため）。
    // 下の列の左の余白を広げると 88px を保つ列の幅（114px）が Tailwind の目盛りに無いので、上の列の右の余白を 6px にした
    assert.equal(gapSysDia, 14, '上と下の間 14px（「/」を置く）')
    assert.equal(gapDiaP, 20, '下と P の間 20px')
    assert.ok(gapDiaP > gapSysDia && gapDiaP >= gapOther * 2, '下と P の間がほかより目に見えて広い')
    // 「/」: 下の列の左の端から 1px（上と下の間 14px のまん中）に、読み上げない・押すのを妨げない形で置く
    assert.match(diaCls, /\brelative\b/)
    assert.match(
      body,
      /\{f === 'dia_bp' \? \(\s*<span aria-hidden="true" className="pointer-events-none absolute left-px top-1\/2 -translate-x-1\/2 -translate-y-1\/2 text-lg font-bold text-ink2">\s*\/\s*<\/span>\s*\) : null\}/,
    )
    assert.equal((dia.l - sys.r) / 2, 1, '「/」は間のまん中（下の列の左の端から left-px＝1px）')
    // 押している欄の外側の線（2px）と「/」の箱（text-lg の太字で幅 約9.4px・Chrome で実測）が触れない: 間の半分 − 線 ≧ 箱の半分
    assert.ok(gapSysDia / 2 - 2 >= 9.4 / 2, '外側の線が「/」に触れない')
  })
  it('テンキーの欄送り: 次の欄は nextBulkVitalField・KT の次はテンキーを閉じて同じ方の主食へ（計画B3）・再測定は一括の並びで探す', () => {
    const adv = page.slice(page.indexOf('const advance = (cur: Active) => {'), page.indexOf('const commit = '))
    assert.match(adv, /const nf = nextBulkVitalField\(cur\.field\)\s+if \(nf !== null\) \{\s*setActive\(\{ \.\.\.cur, field: nf \}\)/)
    // 2026-11-09 計画B3（仕様の変更で固定し直し）: KT の次は、テンキーを閉じて同じ方の主食の選択肢へ（上の血圧の上へは送らない）。
    // 持っている血圧の上は送ってから閉じる（flushHeldSys）。試験は tests/daycare-vitals-meals.test.mjs でも確かめる
    assert.match(adv, /\} else \{\s*flushHeldSys\(cur, null\)\s*setActive\(null\)\s*focusLunchMain\(cur\.residentId\)\s*\}/)
    assert.doesNotMatch(adv, /DC_BULK_VITAL_ORDER\[0\]/)
    assert.doesNotMatch(adv, /field: 'temp'|DAYCARE_VITAL_FIELDS/)
    assert.match(page, /firstAbnormalField\(vals, targets\.get\(row\.residentId\), limits\.lookup\(row\.residentId, data\.day\), DC_BULK_VITAL_ORDER\)/)
    // 桁数での自動送り・範囲の検査・保存は今のまま
    assert.match(page, /if \(nb !== buf && keypadComplete\(active\.field, nb\)\) commit\(active, nb, false\)/)
    assert.match(page, /const rangeErr = vitalRangeError\(cur\.field, v\)/)
    assert.match(page, /if \(cur\.field === 'dia_bp'\) flushHeldSys\(cur, null\)/)
  })
})

describe('静的検査: 空の枠の見た目（一括の4画面・計画B2）', () => {
  const prog = code('../src/lib/daycareProgress.ts')
  const cmp = code('../src/components/DaycareUnfilledCount.tsx')
  const V = code('../src/pages/DaycareVitalsMealsPage.tsx')
  const M = code('../src/pages/DaycareLunchColumns.tsx')
  const A = code('../src/pages/DaycareActivityBulkPage.tsx')
  const T = code('../src/pages/DaycareTrainingPage.tsx')
  it('共通の見た目は1か所（DAYCARE_BLANK_CELL_CLS＝注意の地＋太い点線）と「未」の字（DaycareBlankTag・15px）', () => {
    assert.match(prog, /export const DAYCARE_BLANK_CELL_CLS = 'border-2 border-dashed border-warn bg-warn-bg'/)
    assert.match(cmp, /export function DaycareBlankTag\(\) \{\s*return \(\s*<span aria-hidden="true" className="text-sm font-bold leading-tight text-warn">\s*未\s*<\/span>/)
    for (const [k, p] of Object.entries({ V, M, A, T })) {
      assert.match(p, /DAYCARE_BLANK_CELL_CLS/, k)
      // 枠の見た目を各画面で書き直さない（共通の定数だけ）
      assert.doesNotMatch(p, /border-dashed border-warn/, k)
    }
  })
  it('バイタル一括: 数える方の最初の回の空の欄だけ（入れている欄の色が先）・「未」と小さく薄い「前回…」', () => {
    // 2026-11-10 未測定の反証（固定し直し・意図は同じ）（軽2）: 数える回（countSeqOfRow＝daycareCountSeq・今日の画面と同じ決まり）。ふつうは最初の回
    assert.match(V, /const countedSlot = slot\.seq === countSeqOfRow\.get\(row\.residentId\) && blankCount !== undefined/)
    // 反証 重1: 入れている（押している）欄は空の枠にしない（「未」を出さない）
    assert.match(V, /const blank = countedSlot && v === null && !isActive/)
    assert.match(V, /isActive \? ACTIVE_CELL_CLS : blank \? DAYCARE_BLANK_CELL_CLS : levelTone\(lv\)/)
    assert.match(V, /\{blank \? <DaycareBlankTag \/> : null\}/)
    assert.match(V, /<span className="font-num text-xs leading-tight text-ink3" aria-hidden="true">\s*\{pv \? `前回\$\{fmtVal\(f, pv\.value\)\}` : '—'\}/)
    // 反証 軽2: 「未」と「前回…」は横に並べる（間 4px）。左右の余白（px-1）の分だけ中身を広げ（-mx-1）、体温の「未 前回36.4」も 88px の枠に1行で収める
    // 2026-11-10 未測定（固定し直し・意図は同じ）: 〔未測定〕の印のある欄は先に「未測定」の字を出す（その後の値の無い欄の中身は同じ）
    assert.match(
      V,
      /\) : v === null \? \(\s*(\{\}\s*)?<span className="-mx-1 flex items-center gap-1 whitespace-nowrap">\s*\{blank \? <DaycareBlankTag \/> : null\}\s*\{pv \|\| !blank \? \(\s*<span className="font-num text-xs leading-tight text-ink3"/,
    )
    assert.doesNotMatch(V, /flex-col[^`'"]*-mx-1|-mx-1[^`'"]*flex-col/, '中身は縦に積まない')
    // 「前回」の字を必ず付ける（値だけを出さない）
    assert.doesNotMatch(V, /\{pv \? fmtVal\(f, pv\.value\)/)
    // 読み上げは前と同じ（未入力・前回の値）。2026-11-10 未測定（固定し直し・意図は同じ）: 〔未測定〕の印のある欄は「未測定」
    assert.match(V, /\$\{v === null \? \(um \? '未測定' : '未入力'\) : fmtVal\(f, v\)\}/)
  })
  it('押している欄（反証 重1）: 白い地＋primary の太い実線＋外側の線。空の枠と地・線の形・線の色が全部ちがう（フォーカスの輪は消さない）', () => {
    const m = /const ACTIVE_CELL_CLS = '([^']+)'/.exec(V)
    assert.ok(m, 'ACTIVE_CELL_CLS')
    const active = m[1].split(' ')
    const blank = /export const DAYCARE_BLANK_CELL_CLS = '([^']+)'/.exec(prog)[1].split(' ')
    assert.deepEqual(active, ['border-2', 'border-primary', 'bg-surface', 'outline', 'outline-2', 'outline-primary'])
    assert.ok(!active.includes('border-dashed') && blank.includes('border-dashed'), '線の形: 実線 と 点線')
    assert.ok(active.includes('bg-surface') && blank.includes('bg-warn-bg'), '地: 白 と 注意の地')
    assert.ok(active.includes('border-primary') && blank.includes('border-warn'), '線の色: primary と warn')
    // 外側の線は outline（ring＝box-shadow にすると、キーボードのフォーカスの輪＝box-shadow を上書きして消すため）
    assert.ok(!active.some((c) => c.startsWith('ring')), 'ring を使わない')
    assert.match(read('../src/index.css'), /:focus-visible \{\s*outline: none;\s*box-shadow:/)
    // 前は accent-bg（空の枠の warn-bg とほぼ同じ色）だった
    assert.doesNotMatch(V, /'border-2 border-primary bg-accent-bg'/)
  })
  it('凡例（反証 軽3）: 「— 未測定」はそのまま、「未＝未入力」を足した（確認の反証 軽1: 1180px で1行に収めるため「（点線の枠）」は付けない）', () => {
    // 2026-11-10 未測定（固定し直し・意図は同じ）・2026-11-10 未測定の反証（固定し直し・意図は同じ）（軽6）: 記号の4語は元のまま、「—＝記録なし（数えない回）」「未測定＝測らなかった記録」
    // 「未＝未入力」を足した。凡例だけで 1296px になり、1180px（枠 1052px）で2段に収めるため、食事の説明を短くして同じ段落の続きに置いた
    assert.match(V, /記号: ↑↑ 危険（高い）・↑ 注意（高い）・↓ 注意（低い）・↓↓ 危険（低い）・—＝記録なし（数えない回）・未測定＝測らなかった記録・未＝未入力。範囲外と血圧の上下逆は保存しません。\{' '\}\s*<span>主食・副食は/)
    assert.doesNotMatch(V, /（点線の枠）/)
  })
  it('横に送った後も押している欄の外側の線を氏名の列の下に隠さない（確認の反証 軽3）: 枠の scroll-padding-left は氏名の列の幅＋4px', () => {
    // #56（見出しの行を上に残す作り）の .dc-table-fit はそのまま。左の逃げに外側の線 2px の分（＋余り）を足しただけ
    assert.match(read('../src/index.css'), /\.dc-table-fit \{\s*--dc-fit-top: 4rem;\s*--dc-fit-below: 4\.5rem;\s*max-height: [^;]+;\s*scroll-padding-top: 3\.5rem;\s*scroll-padding-left: calc\(min\(7rem, 35vw\) \+ 1rem \+ 4px\);\s*\}/)
    // 欄へ送るのは今のまま（scrollIntoView の nearest）
    assert.match(V, /cell\.scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/)
  })
  it('物理キーボードで欄を送った時は、フォーカスも移った先の欄へ（確認の反証 軽4）。フォーカスが表の中の欄にある時だけ・指で押した時は変えない', () => {
    const eff = V.slice(V.indexOf("const cell = tableBox.querySelector<HTMLElement>('[data-dc-active]')"), V.indexOf('}, [active, tableBox, kpBox, kpHeight])'))
    assert.ok(eff.length > 100)
    assert.match(
      eff,
      /cell\.scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)\s*const focused = document\.activeElement\s*if \(focused instanceof HTMLElement && focused !== cell && focused\.hasAttribute\('data-dc-cell'\) && tableBox\.contains\(focused\)\) cell\.focus\(\{ preventScroll: true \}\)/,
    )
    // 欄の印（data-dc-cell）は欄のボタンだけ（〔＋再測定〕・テンキーのボタンには付けない）
    assert.equal((V.match(/data-dc-cell=""/g) ?? []).length, 1)
    assert.match(V, /data-dc-cell=""\s*data-dc-active=\{isActive \? '' : undefined\}/)
    // 押した時の動き（openCell）はフォーカスに触れない
    const open = V.slice(V.indexOf('const openCell = '), V.indexOf('const flushHeldSys = '))
    assert.doesNotMatch(open, /focus\(/)
  })
  it('食事一括: 選択肢が「—（未入力）」の時だけ空の見た目（枠と地は排他・selectCls は今のまま）。拒食は入力済み', () => {
    // 2026-11-09 計画B3 の手直し（固定し直し・意図は同じ）: 左右の余白は 4px（1180px に収める）。枠と地の排他・押せる範囲・文字の大きさは同じ
    assert.match(M, /const selectCls = 'min-h-tap min-w-tap rounded border border-border-strong bg-surface px-1 text-lg text-ink disabled:text-ink3'/)
    assert.match(M, /const selectBlankCls = `min-h-tap min-w-tap rounded \$\{DAYCARE_BLANK_CELL_CLS\} px-1 text-lg text-ink disabled:text-ink3`/)
    assert.match(M, /className=\{v === '' \? selectBlankCls : selectCls\}/)
    // 「未入力」の字は選択肢の文字（—（未入力））で出る
    // 2026-11-09 計画B3 の手直し（固定し直し・意図は同じ）: 選択肢の文字は「未」（バイタルの空の枠と同じ字・凡例の「未＝未入力」）
    assert.match(read('../src/lib/daycarePerson.ts'), /\{ value: '', label: '未' \}/)
  })
  it('活動一括: 記録が1つも無い方（読めている時だけ）の定型の7つの枠を空の見た目＋「未」。その他の列は変えない', () => {
    assert.match(A, /const rowBlank = readable && filledOf\.get\(rid\) === false/)
    assert.match(A, /const cellButton = \(rid: number, name: string, label: string, small: boolean, blank = false\) => \{/)
    assert.match(A, /const blankWord = blank && c\.shown === null/)
    assert.match(A, /const word = !readable \? '？' : blankWord \? '未' : c\.shown === null \? '—' : ACTIVITY_PARTICIPATION_LABEL\[c\.shown\]/)
    // 止まった枠の印が先・次に空の行・次に記録のある枠
    assert.match(A, /stopped\s*\? 'border-2 border-warn bg-warn-bg'\s*: blank && readable\s*\? DAYCARE_BLANK_CELL_CLS\s*: c\.shown !== null && readable/)
    assert.match(A, /\{DAYCARE_ACTIVITY_CHIPS\.map\(\(c\) => \(\s*<td key=\{c\} className="px-1 py-1">\s*\{cellButton\(rid, name, c, false, rowBlank\)\}/)
    assert.match(A, /\{others\.map\(\(l\) => cellButton\(rid, name, l, true\)\)\}/)
    // 枠の読み上げは今のまま（記録なし）
    assert.match(A, /c\.shown === null \? '記録なし'/)
  })
  it('機能訓練: その日の記録が無い方（読めている時だけ・送信待ちの追加は入力済み）の結果の欄を空の見た目＋「未」', () => {
    assert.match(T, /const blank = data\.sessions !== null && !trainingFilled\(sessions, pending, rid, day\)/)
    assert.match(T, /<td className=\{blank \? `\$\{DAYCARE_BLANK_CELL_CLS\} px-2 py-1` : 'px-2 py-1'\}>\s*<div className="flex flex-wrap items-center gap-x-3 gap-y-1">\s*\{blank \? <DaycareBlankTag \/> : null\}/)
  })
})

describe('静的検査: 全部の枠が埋まるまでの知らせ（計画B2）', () => {
  const cmp = code('../src/components/DaycareUnfilledCount.tsx')
  // 2026-11-09 計画B3（固定し直し・意図は同じ）: バイタル一括と食事一括を1つの画面（バイタル・食事）にした。一括の画面は3つ（食事の欄はフック DaycareLunchColumns.tsx）
  const BULK = {
    vitals: code('../src/pages/DaycareVitalsMealsPage.tsx'),
    activity: code('../src/pages/DaycareActivityBulkPage.tsx'),
    training: code('../src/pages/DaycareTrainingPage.tsx'),
  }
  const LUNCH = code('../src/pages/DaycareLunchColumns.tsx')
  it('上の数: 空の欄が1つでもあれば「▲ 未入力 n名（m欄）」（赤字）・全部埋まった時だけ「✓ 全員入力済み」（緑）・未到着は出さない', () => {
    assert.match(cmp, /export function DaycareUnfilledCount\(\{ counts \}: \{ counts: \{ people: number; fields: number \} \}\)/)
    assert.match(cmp, /\{counts\.fields > 0 \? \(\s*<span className="font-bold text-danger">\s*<span aria-hidden="true">▲ <\/span>未入力 <span className="font-num">\{counts\.people\}<\/span>名（<span className="font-num">\{counts\.fields\}<\/span>欄）\s*<\/span>\s*\) : \(\s*<span className="font-bold text-ok">\s*<span aria-hidden="true">✓ <\/span>全員入力済み\s*<\/span>/)
    assert.doesNotMatch(cmp, /未到着|数えていません|未入力なし/)
  })
  it('行の印: 空の欄がある行の氏名の横に「▲未」（15px・赤字）・読み上げ「未入力あり」。aria-label の付いたリンク（活動・訓練）は読み上げの文をリンクの外に', () => {
    // 反証 中1: lead＝行の頭に置く（右に間）。置いた行を高くしない（leading-tight）
    assert.match(
      cmp,
      /export function DaycareRowBlankMark\(\{ sr = true, lead = false \}: \{ sr\?: boolean; lead\?: boolean \}\) \{\s*return \(\s*<span className=\{`\$\{lead \? 'mr-1' : 'ml-1'\} whitespace-nowrap text-sm font-bold leading-tight text-danger`\}>\s*<span aria-hidden="true">▲未<\/span>\s*\{sr \? <span className="sr-only">（未入力あり）<\/span> : null\}/,
    )
    assert.match(cmp, /export function DaycareRowBlankSr\(\) \{\s*return <span className="sr-only">未入力あり<\/span>/)
    assert.doesNotMatch(cmp, /\btext-(2xs|xs)\b/)
    // バイタル一括（氏名は文字）・食事一括（リンクに aria-label が無い）は印の中で読む。
    // 反証 中1: バイタル一括は札の行の頭（「▲未 施設の基準」）。氏名の横は iPad 縦（氏名の列 112px）で折り返して行が伸びたため
    // 2026-11-09 計画B3 の手直し（固定し直し・意図は同じ）: 札の行は氏名のリンクの2段目（活動一括と同じ形）。印は札の行の頭のまま
    assert.match(BULK.vitals, /<span className="text-sm leading-tight text-ink2">\s*\{\(blankCount \?\? 0\) > 0 \? <DaycareRowBlankMark lead \/> : null\}\s*\{basis\}\s*<\/span>\s*<\/Link>/)
    // 2026-11-09 計画B3（固定し直し・意図は同じ）: 氏名は1人の画面へのリンク（それまでの食事一括と同じ）。行の印は札の行の頭の1つだけ（7欄のどれかが空なら出す）。
    // 食事一括の氏名の横の印は、この1つにまとめた（フックは印を出さない）
    assert.match(BULK.vitals, /<span className="text-base font-bold leading-tight text-link">\s*\{nameOf\(row\.residentId\)\}\s*<span className="sr-only">さんの1日の記録を開く<\/span>/)
    assert.equal((BULK.vitals.match(/<DaycareRowBlankMark /g) ?? []).length, 1)
    assert.doesNotMatch(LUNCH, /DaycareRowBlankMark/)
    for (const k of ['activity', 'training']) assert.doesNotMatch(BULK[k], /<DaycareRowBlankMark lead/, `${k}: 氏名の横のまま`)
    // 活動一括・機能訓練: 見える印はリンクの中の氏名の横、読み上げはリンクの外（リンクの aria-label は今のまま）
    assert.match(BULK.activity, /<span aria-hidden="true"> ›<\/span>\s*(\{\}\s*)?\{rowBlank \? <DaycareRowBlankMark sr=\{false\} \/> : null\}/)
    assert.match(BULK.activity, /<\/Link>\s*\{rowBlank \? <DaycareRowBlankSr \/> : null\}\s*<\/div>/)
    assert.match(BULK.training, /<span aria-hidden="true"> ›<\/span>\s*(\{\}\s*)?\{blank \? <DaycareRowBlankMark sr=\{false\} \/> : null\}/)
    assert.match(BULK.training, /<\/Link>\s*\{blank \? <DaycareRowBlankSr \/> : null\}/)
  })
  it('4画面とも同じ数え方（bulkBlankSummary）・同じ部品・読めない時（活動・訓練）は数を出さない', () => {
    assert.match(BULK.vitals, /vitalBlankFields\(/)
    // 2026-11-09 計画B3（固定し直し・意図は同じ）: 昼食の空の欄はフックの blankOf（同じ lunchBlankFields）で、バイタル・食事の画面がバイタルの5欄と合わせて数える
    assert.match(LUNCH, /lunchBlankFields\(mealShownFor\(targetOf\(rid\)\)\)/)
    // 2026-11-09 計画B3 の反証の直し（固定し直し・意図は同じ）（軽3）: 昼食を読めない時はバイタルの5欄だけ
    // 2026-11-10 未測定（固定し直し・意図は同じ）: 最初の回の〔未測定〕の印のある欄は入力済み（同じ純関数の2つ目の引数）
    // 2026-11-10 未測定の反証（固定し直し・意図は同じ）（軽2）: 印は数える回（daycareCountSeq の cs）のもの
    assert.match(BULK.vitals, /const vitalBlank = vitalBlankFields\(first === undefined \? null : vals, unmeasuredFieldsOf\(data\?\.unmeasured, r\.residentId, day, cs \?\? first\?\.seq \?\? 1\)\)/)
    assert.match(BULK.vitals, /lunchReady \? \(vitalsMealsBlankFields\(vitalBlank, lunch\.blankOf\(r\.residentId\)\) \?\? 0\) : vitalBlank/)
    assert.match(BULK.activity, /recordBlankFields\(filledOf\.get\(rid\) \?\? false\)/)
    assert.match(BULK.training, /recordBlankFields\(trainingFilled\(sessions, pending, rid, day\)\)/)
    for (const [k, p] of Object.entries(BULK)) assert.match(p, /bulkBlankSummary\(/, k)
    assert.match(BULK.activity, /\{readable && targets\.length > 0 \? <DaycareUnfilledCount counts=\{unfilled\} \/> : null\}/)
    assert.match(BULK.training, /\{data\.sessions !== null && targets\.length > 0 \? <DaycareUnfilledCount counts=\{unfilled\} \/> : null\}/)
  })
  it('今日の画面の切り替えの数: 一括の画面に出る方（daycareBulkRows）を、一括の画面と同じ純関数で数える。カードの印の決め方は変えない', () => {
    const today = code('../src/pages/DaycarePage.tsx')
    const nav = today.slice(today.indexOf('const bulk = daycareBulkRows(board.rows)'), today.indexOf(': undefined', today.indexOf('const navPending =')))
    assert.ok(nav.length > 100)
    // 2026-11-09 計画B3（固定し直し・意図は同じ）: バイタル・食事の1つの数（1人7欄＝vitalsMealsBlankFields・画面と同じ純関数）。どちらかを読めない日は数を出さない
    // 2026-11-10 未測定（固定し直し・意図は同じ）: 最初の回の〔未測定〕の印のある欄は入力済み（一括の画面と同じ純関数の2つ目の引数）
    // 2026-11-10 未測定の反証（固定し直し・意図は同じ）（軽2）: バイタルの空の欄は countBlankOf（数える回＝daycareCountSeq・一括の画面と同じ純関数）
    assert.match(nav, /vitalsMeals:\s*data\.vitalsOk && data\.intakeOk\s*\? bulk\.map\(\s*\(r\) =>\s*vitalsMealsBlankFields\(\s*countBlankOf\(r\.residentId\),\s*lunchBlankFields\(lunchShownWith\(lunchOf\(r\.residentId\), pendingRow\('meals', \{ residentId: r\.residentId, day: data\.day, slot: 'lunch' \}\)\)\),\s*\) \?\? 0,\s*\)\s*: null/)
    assert.match(nav, /activityRead === null\s*\? null\s*: bulk\.map\(\(r\) => recordBlankFields\(activityCellsFilled\(activityShownCells\(activityRead, activityPending, r\.residentId, data\.day\)\)\)\)/)
    assert.match(nav, /trainingRead === null \? null : bulk\.map\(\(r\) => recordBlankFields\(trainingFilled\(trainingRead, trainingPending, r\.residentId, data\.day\)\)\)/)
    // バイタル一括の slotsOf の最初の回と同じ（daycareVitalSlotsWithPending の並び＝回の小さい順）
    assert.match(today, /const slots = daycareVitalSlotsWithPending\(vitalsOf\(id\), vitalKeys, id, data\.day, \[\], /)
    // カードの印（済・未・対象外）は今のまま daycareProgressMarks
    assert.match(today, /daycareProgressMarks\(\{\s*state: r\.state,/)
  })
  it('色はトークンだけ・氏名と記録を localStorage・console に出さない', () => {
    for (const f of ['../src/lib/daycareProgress.ts', '../src/components/DaycareUnfilledCount.tsx']) {
      const c = code(f)
      assert.doesNotMatch(c, /\b(text|bg|border|w|h|min-w|min-h|p[xy]?|m[xy]?|gap|left|top)-\[/, f)
      assert.doesNotMatch(c, /localStorage|sessionStorage|console\./, f)
    }
    for (const [k, p] of Object.entries(BULK)) assert.doesNotMatch(p, /\b(text|bg|border|left|top|w)-\[/, k)
    // 2026-11-09 計画B3（固定し直し・意図は同じ）: 昼食と水分の欄（フック）も同じ
    assert.doesNotMatch(LUNCH, /\b(text|bg|border|left|top|w)-\[/, 'meals')
    assert.doesNotMatch(LUNCH, /localStorage|sessionStorage|console\./, 'meals')
  })
})

describe('コントラスト（tokens.css の ops・明と暗）', () => {
  const css = read('../src/styles/tokens.css')
  const block = (sel) => {
    const at = css.indexOf(`${sel} {`)
    assert.ok(at >= 0, sel)
    return css.slice(at, css.indexOf('}', at))
  }
  const varOf = (b, name) => {
    const m = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(b)
    assert.ok(m, name)
    return m[1]
  }
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
  const modes = {
    明: block('[data-ds="ops"], [data-ds="ops"][data-mode="light"]'),
    暗: block('[data-ds="ops"][data-mode="dark"]'),
  }
  it('空の枠の中の文字（未・前回・選択肢・活動の文字）・行の印・上の数・前回の値（白い枠・入れている欄）が 4.5 以上', () => {
    const pairs = [
      ['--c-warn', '--c-warn-bg', '「未」の字'],
      ['--c-ink3', '--c-warn-bg', '空の枠の「前回…」（14px）'],
      ['--c-ink', '--c-warn-bg', '空の選択肢・活動の枠の文字'],
      ['--c-ink2', '--c-warn-bg', '空の行の活動の枠の文字（ほか）'],
      ['--c-ink3', '--c-surface', '再測定の回などの「前回…」（14px）'],
      ['--c-ink3', '--c-surface', '入れている欄の「前回…」（14px・反証 重1 で白い地に）'],
      ['--c-danger', '--c-bg', '行の印・未入力の数（ページの地）'],
      ['--c-danger', '--c-surface', '未入力の数（活動一括・機能訓練の区画の地）'],
      ['--c-ok', '--c-bg', '全員入力済み（ページの地）'],
      ['--c-ok', '--c-surface', '全員入力済み（区画の地）'],
    ]
    for (const [mode, b] of Object.entries(modes)) {
      for (const [fg, bg, what] of pairs) {
        const c = contrast(varOf(b, fg), varOf(b, bg))
        assert.ok(c >= 4.5, `${mode} ${what}（${fg} × ${bg}）: ${c.toFixed(2)} < 4.5`)
      }
      // 点線の枠と「/」は文字でない部品（3 以上）
      assert.ok(contrast(varOf(b, '--c-warn'), varOf(b, '--c-bg')) >= 3, `${mode} 点線の枠 × ページの地`)
      assert.ok(contrast(varOf(b, '--c-warn'), varOf(b, '--c-warn-bg')) >= 3, `${mode} 点線の枠 × 空の枠の地`)
      assert.ok(contrast(varOf(b, '--c-ink2'), varOf(b, '--c-bg')) >= 3, `${mode} 「/」 × ページの地`)
      // 押している欄の線（primary）は白い地・ページの地のどちらとも 3 以上（反証 重1）
      assert.ok(contrast(varOf(b, '--c-primary'), varOf(b, '--c-surface')) >= 3, `${mode} 押している欄の線 × 欄の地`)
      assert.ok(contrast(varOf(b, '--c-primary'), varOf(b, '--c-bg')) >= 3, `${mode} 押している欄の外側の線 × ページの地`)
    }
  })
})
