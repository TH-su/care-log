// デイ 計画C（2026-11-09・段階4）: 連絡帳（全員共通の一文・個別のひと言・看護職のひと言・A5 印刷）の試験。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycareContact.ts）: 記録なし（項目ごと）・入浴の予定なし・再測定・基準外の判定と看護職の欄の出る条件・
//    印刷前の確かめの対象・来ていない方の紙・読めない項目・ひと言の長さ・印刷する方の既定。
//    2026-11-09 反証と親の決定: ひと言の欄は空なら見出しごと出さない・欄ごとに値のある一番後の回を合わせる（重1）・
//    送信待ちを重ねる（中2）・読めない項目と自動の入浴を確かめに並べる（中3・軽5）・入れかけの文と保存値の関係（中1）
// 2. 静的検査: ルート・入口のボタン・@page の A5 と余白・改ページ・印刷で隠す部品・写真の欄が無い・旗の確かめ・localStorage を使わない・
//    書き込みは足した関数だけ・変えた欄だけを書く・押す所 44px・判定の記号を紙に載せない
// 3. 移行 0061 の静的検査: 新しい2つの表・RLS・施設の印の既定と外部キー・一意の索引・既存の表の名前を変えていない／drop していない
// 個人情報は置かない（利用者は数値IDと「利用者01」だけ）。

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
/** SQL の行コメントを除いた本文 */
const sqlCode = (p) => read(p).replace(/--.*$/gm, '')

let C = null
let TH = null
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
  C = await import('../src/lib/daycareContact.ts')
  TH = await import('../src/lib/vitalThresholds.ts')
} catch (e) {
  loadError = e
  C = null
}

const DAY = '2026-11-09'
/** デイの測定の行（client_key は 'dc:<日>:<利用者id>:<回>'） */
const vital = (over = {}) => ({
  id: 1,
  resident_id: 1,
  measured_on: DAY,
  kind: 'observation',
  measured_at: null,
  temp: null,
  sys_bp: null,
  dia_bp: null,
  pulse: null,
  spo2: null,
  note: null,
  symptom: null,
  recorded_by: null,
  rev: 1,
  client_key: `dc:${DAY}:1:1`,
  ...over,
})
/** 1人の紙面の材料（来た方・記録なし） */
const input = (over = {}) => ({
  residentId: 1,
  day: DAY,
  name: '利用者01',
  officeName: '事業所01',
  state: 'present',
  hospitalized: false,
  bathingPlanned: true,
  vitals: [],
  vitalsOk: true,
  target: null,
  thresholds: TH.DEFAULT_VITAL_THRESHOLDS,
  bath: null,
  bathsOk: true,
  lunch: null,
  fluids: [],
  intakeOk: true,
  activities: [],
  training: [],
  dayNote: null,
  note: null,
  ...over,
})
const bath = (over = {}) => ({ id: 1, resident_id: 1, bath_on: DAY, result: 'full', cancel_reason: null, note: null, recorded_by: null, rev: 1, auto: false, ...over })
const session = (over = {}) => ({
  id: 1,
  resident_id: 1,
  day: DAY,
  started_at: '10:00',
  duration_min: 20,
  program: '立ち上がり',
  result: 'done',
  cancel_reason: null,
  cancel_note: null,
  instructor_id: 1,
  assisted_by: null,
  note: null,
  recorded_by: null,
  rev: 1,
  ...over,
})
const itemOf = (sheet, label) => sheet.items.find((i) => i.label === label)?.value

if (C === null) {
  registerLoadFailure('デイ 計画C（連絡帳）の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('連絡帳の紙面（純ロジック・src/lib/daycareContact.ts）', () => {
    it('記録が無い項目は、項目ごとに必ず「記録なし」（空・「—」・「異常なし」にしない）', () => {
      const s = C.buildContactSheet(input())
      assert.equal(s.attended, true)
      assert.equal(s.vitals.kind, 'ok')
      assert.deepEqual(s.vitals.cells.map((c) => c.value), ['記録なし', '記録なし', '記録なし', '記録なし'])
      assert.deepEqual(s.vitals.cells.map((c) => c.label), ['体温', '血圧', '脈拍', 'SpO2'])
      assert.deepEqual(s.items.map((i) => i.label), ['入浴', 'お食事', '水分', '活動', '機能訓練'])
      for (const it of s.items) assert.equal(it.value, '記録なし', it.label)
      for (const v of [...s.vitals.cells.map((c) => c.value), ...s.items.map((i) => i.value)]) {
        assert.doesNotMatch(v, /^$|—|異常なし/)
      }
      // 職員より（共通の一文も個別のひと言も無い）は紙面で「記録なし」（描く側）
      assert.deepEqual(s.staff, { common: null, personal: null })
    })
    it('値が片方だけの欄は、その側を「記録なし」（血圧の上下・昼食の主食と副食）', () => {
      const s = C.buildContactSheet(
        input({ vitals: [vital({ temp: 36.5, sys_bp: 128 })], lunch: { main_amount: 8, side_amount: null, status: 'eaten' } }),
      )
      assert.equal(s.vitals.cells[0].value, '36.5℃')
      assert.equal(s.vitals.cells[1].value, '上 128／下 記録なし')
      assert.equal(s.vitals.cells[2].value, '記録なし')
      assert.equal(itemOf(s, 'お食事'), '昼食 主食 8割・副食 記録なし')
    })
    it('記録がある項目は数値・言葉で出す（入浴の区分・昼食・水分の合計・活動の名前・機能訓練の実施と内容）', () => {
      const s = C.buildContactSheet(
        input({
          vitals: [vital({ temp: 36.4, sys_bp: 128, dia_bp: 76, pulse: 72, spo2: 97 })],
          bath: bath({ result: 'shower' }),
          lunch: { main_amount: 10, side_amount: 7, status: 'eaten' },
          fluids: [
            { resident_id: 1, taken_on: DAY, amount_ml: 150 },
            { resident_id: 1, taken_on: DAY, amount_ml: 200 },
            { resident_id: 2, taken_on: DAY, amount_ml: 900 },
          ],
          activities: [
            { id: 2, resident_id: 1, day: DAY, label: '歌', participation: 'observed', note: null, recorded_by: null, rev: 1 },
            { id: 1, resident_id: 1, day: DAY, label: '体操', participation: 'full', note: null, recorded_by: null, rev: 1 },
            { id: 3, resident_id: 2, day: DAY, label: '散歩', participation: 'full', note: null, recorded_by: null, rev: 1 },
          ],
          training: [session()],
        }),
      )
      assert.deepEqual(s.vitals.cells.map((c) => c.value), ['36.4℃', '128/76 mmHg', '72 回/分', '97%'])
      assert.equal(itemOf(s, '入浴'), '入浴しました（シャワー浴）')
      assert.equal(itemOf(s, 'お食事'), '昼食 主食 10割・副食 7割')
      assert.equal(itemOf(s, '水分'), '350 ml')
      assert.equal(itemOf(s, '活動'), '体操・歌（見学）')
      assert.equal(itemOf(s, '機能訓練'), '実施（立ち上がり・20分）')
      assert.equal(C.sheetTrainingText([session({ result: 'partial', duration_min: 10 })], 1, DAY), '一部実施（立ち上がり・10分）')
      assert.equal(C.sheetTrainingText([session({ result: 'cancelled', duration_min: null, cancel_reason: 'condition' })], 1, DAY), '中止（体調不良）')
      assert.equal(C.sheetLunchText({ main_amount: null, side_amount: null, status: 'refused' }, true), '昼食は召し上がりませんでした')
      assert.equal(C.sheetBathText(bath({ result: 'cancel', cancel_reason: 'condition' }), true, true), '入浴しませんでした（体調不良）')
      // 自動の記録（予定から入った全身浴）も、今日の画面と同じく入ったものとして出す
      assert.equal(C.sheetBathText(bath({ auto: true }), true, true), '入浴しました（全身浴）')
    })
    it('入浴の予定が無い日は「今日は入浴の予定はありませんでした」・予定があって記録が無ければ「記録なし」', () => {
      assert.equal(itemOf(C.buildContactSheet(input({ bathingPlanned: false })), '入浴'), '今日は入浴の予定はありませんでした')
      assert.equal(itemOf(C.buildContactSheet(input({ bathingPlanned: true })), '入浴'), '記録なし')
      // 予定が無くても記録があれば記録を出す
      assert.equal(itemOf(C.buildContactSheet(input({ bathingPlanned: false, bath: bath() })), '入浴'), '入浴しました（全身浴）')
    })
    it('再測定がある時は最後の回の値と「※ 再測定した値を載せています」。1回だけなら注記なし', () => {
      const two = C.buildContactSheet(
        input({
          vitals: [
            vital({ id: 11, temp: 37.9, client_key: `dc:${DAY}:1:1` }),
            vital({ id: 12, temp: 37.0, client_key: `dc:${DAY}:1:2` }),
          ],
        }),
      )
      assert.equal(two.vitals.cells[0].value, '37.0℃')
      assert.equal(two.vitals.recheck, true)
      const one = C.buildContactSheet(input({ vitals: [vital({ temp: 36.5 })] }))
      assert.equal(one.vitals.recheck, false)
      // 値の無い回は数えない（空の回だけ足しても再測定にしない）。ほかの方・ほかの日の行は使わない
      const other = C.buildContactSheet(
        input({
          vitals: [
            vital({ id: 21, temp: 36.6, client_key: `dc:${DAY}:1:1` }),
            vital({ id: 22, client_key: `dc:${DAY}:1:2` }),
            vital({ id: 23, resident_id: 2, temp: 39.0, client_key: `dc:${DAY}:2:1` }),
          ],
        }),
      )
      assert.equal(other.vitals.cells[0].value, '36.6℃')
      assert.equal(other.vitals.recheck, false)
      assert.equal(C.RECHECK_NOTE, '※ 再測定した値を載せています')
    })
    it('基準外の判定は最後の回の値で、その方の基準（lookup）が優先。看護職の欄は基準外の時だけ', () => {
      const hot = C.buildContactSheet(input({ vitals: [vital({ temp: 37.8 })], note: { body: null, nurse_note: '受診をおすすめします' } }))
      assert.equal(hot.abnormal, true)
      assert.equal(hot.nurse, '受診をおすすめします')
      // 値は数値のまま（判定の記号を付けない）
      assert.equal(hot.vitals.cells[0].value, '37.8℃')
      assert.doesNotMatch(JSON.stringify(hot), /[↑↓▲]/)
      // その方の基準で 38.0 から注意なら、37.8 は基準内＝看護職の欄は出さない（書いてあっても載せない）
      const own = { ...TH.DEFAULT_VITAL_THRESHOLDS, temp: { dangerHigh: 38.5, warnHigh: 38.0, dangerLow: 35.5 } }
      const ok = C.buildContactSheet(input({ vitals: [vital({ temp: 37.8 })], thresholds: own, note: { body: null, nurse_note: '受診をおすすめします' } }))
      assert.equal(ok.abnormal, false)
      assert.equal(ok.nurse, null)
      // 1回目が基準外でも、再測定（最後の回）が基準内なら基準外にしない
      const rechecked = C.buildContactSheet(
        input({ vitals: [vital({ id: 31, temp: 37.9, client_key: `dc:${DAY}:1:1` }), vital({ id: 32, temp: 36.8, client_key: `dc:${DAY}:1:2` })] }),
      )
      assert.equal(rechecked.abnormal, false)
      // SpO2 は個別の下限（目標）で判定する
      const spo2 = C.buildContactSheet(input({ vitals: [vital({ spo2: 92 })] }))
      assert.equal(spo2.abnormal, true)
      const spo2Own = C.buildContactSheet(input({ vitals: [vital({ spo2: 92 })], target: { id: 1, resident_id: 1, fluid_target_ml: null, spo2_warn_below: 90, spo2_danger_below: 88, rev: 1 } }))
      assert.equal(spo2Own.abnormal, false)
      // バイタルを読めなかった日は基準外にしない（読めないを「異常なし」とも出さない）
      const unread = C.buildContactSheet(input({ vitalsOk: false, vitals: [vital({ temp: 39.0 })] }))
      assert.equal(unread.abnormal, false)
      assert.deepEqual(unread.vitals, { kind: 'unread' })
    })
    it('印刷前の確かめの対象: 選んだ方のうち「基準外なのに看護職のひと言が空」の方だけ（渡した順）', () => {
      const sheets = [
        C.buildContactSheet(input({ residentId: 1, vitals: [vital({ temp: 38.2 })] })),
        C.buildContactSheet(input({ residentId: 2, vitals: [vital({ resident_id: 2, temp: 38.2, client_key: `dc:${DAY}:2:1` })], note: { body: null, nurse_note: '様子を見ています' } })),
        C.buildContactSheet(input({ residentId: 3, vitals: [vital({ resident_id: 3, temp: 36.5, client_key: `dc:${DAY}:3:1` })] })),
        C.buildContactSheet(input({ residentId: 4, vitals: [vital({ resident_id: 4, temp: 38.2, client_key: `dc:${DAY}:4:1` })], note: { body: null, nurse_note: '   ' } })),
        C.buildContactSheet(input({ residentId: 5, vitals: [vital({ resident_id: 5, temp: 38.2, client_key: `dc:${DAY}:5:1` })] })),
      ]
      assert.deepEqual(C.nurseNoteMissing(sheets, new Set([1, 2, 3, 4])), [1, 4])
      assert.deepEqual(C.nurseNoteMissing(sheets, new Set()), [])
      // ひと言を読めなかった方も入れる（空かどうかを確かめられない）
      const unread = C.buildContactSheet(input({ vitals: [vital({ temp: 38.2 })], notesOk: false, note: { body: null, nurse_note: '書いてある' } }))
      assert.equal(unread.notesUnread, true)
      assert.deepEqual(C.nurseNoteMissing([unread], new Set([1])), [1])
    })
    it('来ていない方の紙は作れるが、本文は1文で記録の欄を出さない（休み・入院中・まだ来ていない）', () => {
      const absent = C.buildContactSheet(input({ state: 'absent', vitals: [vital({ temp: 39.0 })], bath: bath(), dayNote: 'みんなで歌いました' }))
      assert.equal(absent.attended, false)
      assert.equal(absent.absentText, '本日はお休みでした。')
      assert.equal(absent.vitals, null)
      assert.deepEqual(absent.items, [])
      assert.equal(absent.abnormal, false)
      // 共通の一文はその日のご様子なので載せない。個別のひと言は書いてあれば載せる
      assert.deepEqual(absent.staff, { common: null, personal: null })
      const withNote = C.buildContactSheet(input({ state: 'absent', note: { body: 'お大事になさってください', nurse_note: null } }))
      assert.equal(withNote.staff.personal, 'お大事になさってください')
      assert.equal(C.buildContactSheet(input({ state: 'planned', hospitalized: true })).absentText, '入院中のため、本日はお休みでした。')
      assert.equal(C.buildContactSheet(input({ state: 'planned' })).absentText, '本日のご利用の記録はありません。')
      // 帰宅した方は来た方
      assert.equal(C.buildContactSheet(input({ state: 'left' })).attended, true)
    })
    it('職員より: 共通の一文と個別のひと言（前後の空白を落とし、空は無いものとして扱う）', () => {
      const s = C.buildContactSheet(input({ dayNote: '  今日は秋の歌を歌いました。 ', note: { body: '笑顔で過ごされました。', nurse_note: null } }))
      assert.deepEqual(s.staff, { common: '今日は秋の歌を歌いました。', personal: '笑顔で過ごされました。' })
      assert.deepEqual(C.buildContactSheet(input({ dayNote: '   ', note: { body: '', nurse_note: null } })).staff, { common: null, personal: null })
    })
    it('読めなかった項目は「読み込めませんでした」（記録が無いことと取り違えない）', () => {
      const s = C.buildContactSheet(input({ bathsOk: false, intakeOk: false, activities: null, training: null }))
      assert.equal(itemOf(s, '入浴'), '読み込めませんでした')
      assert.equal(itemOf(s, 'お食事'), '読み込めませんでした')
      assert.equal(itemOf(s, '水分'), '読み込めませんでした')
      assert.equal(itemOf(s, '活動'), '読み込めませんでした')
      assert.equal(itemOf(s, '機能訓練'), '読み込めませんでした')
    })
    it('見出しの日付・事業所名（空なら出さない）', () => {
      assert.equal(C.sheetDateLabel('2026-11-09'), '2026年11月9日（月）')
      const s = C.buildContactSheet(input({ officeName: '  ' }))
      assert.equal(s.officeName, '')
      assert.equal(s.dateLabel, '2026年11月9日（月）')
    })
    it('ひと言の長さ: 共通 200字・個別 200字・看護職 150字（サロゲートの文字も1字）・送る形（前後の空白・空は null）', () => {
      assert.equal(C.DAY_NOTE_MAX, 200)
      assert.equal(C.CONTACT_BODY_MAX, 200)
      assert.equal(C.CONTACT_NURSE_MAX, 150)
      assert.equal(C.contactFieldMax('body'), 200)
      assert.equal(C.contactFieldMax('nurse_note'), 150)
      assert.equal(C.noteLength('𠮷野'), 2)
      assert.equal(C.noteLengthError('あ'.repeat(200), 200), null)
      assert.match(C.noteLengthError('あ'.repeat(201), 200), /200字までにしてください（いま 201字）/)
      assert.equal(C.noteLengthError(`  ${'あ'.repeat(150)}  `, 150), null)
      assert.equal(C.normalizeNoteText('  '), null)
      assert.equal(C.normalizeNoteText(' 文 '), '文')
      assert.equal(C.normalizeNoteText(null), null)
    })
    it('印刷する方の既定は「来た方」（在席・帰宅）・画面のルートは ?day=（今日は付けない）', () => {
      const rows = [
        { residentId: 1, state: 'present' },
        { residentId: 2, state: 'left' },
        { residentId: 3, state: 'absent' },
        { residentId: 4, state: 'planned' },
      ]
      assert.deepEqual([...C.defaultPicked(rows)].sort(), [1, 2])
      assert.equal(C.contactPath(DAY, DAY), '/record/daycare/contact')
      assert.equal(C.contactPath('2026-11-08', DAY), '/record/daycare/contact?day=2026-11-08')
      assert.equal(C.contactNoteOf([{ id: 1, resident_id: 2, day: DAY, body: 'x', nurse_note: null, printed_at: null, rev: 1 }], 2, DAY)?.id, 1)
      assert.equal(C.contactNoteOf([], 2, DAY), null)
    })
  })
}

describe('連絡帳の画面・紙（静的検査）', () => {
  const app = code('../src/App.tsx')
  const page = code('../src/pages/DaycareContactPage.tsx')
  const sheet = code('../src/components/print/DaycareContactSheet.tsx')
  const css = read('../src/components/print/daycareContact.css')
  const pure = code('../src/lib/daycareContact.ts')
  const today = code('../src/pages/DaycarePage.tsx')

  it('ルート /record/daycare/contact と画面名「デイ 連絡帳」を足した（既存のデイのルートはそのまま）', () => {
    assert.match(app, /<Route path="\/record\/daycare\/contact" element=\{<DaycareContactPage actorId=\{actorId\} staff=\{staff\} \/>\} \/>/)
    assert.match(app, /if \(pathname === '\/record\/daycare\/contact'\) return 'デイ 連絡帳'/)
    assert.match(app, /const loadDaycareContactPage = \(\) => import\('\.\/pages\/DaycareContactPage'\)/)
    for (const p of ['/record/daycare', '/record/daycare/vitals', '/record/daycare/meals', '/record/daycare/person/:residentId', '/record/daycare/bulk', '/record/daycare/training']) {
      assert.ok(app.includes(`<Route path="${p}"`), p)
    }
  })
  it('入口は今日の画面の一番下の〔＋ 予定にない方を追加〕の横の〔連絡帳〕（44px・その日を開く）。上の切り替えには足さない', () => {
    const add = today.indexOf('＋ 予定にない方を追加')
    const link = today.indexOf('to={contactPath(day, today)}')
    assert.ok(add > 0 && link > add, '〔連絡帳〕が〔＋ 予定にない方を追加〕の後に無い')
    const tail = today.slice(link, today.indexOf('</Link>', link))
    assert.match(tail, /min-h-tap/)
    assert.match(tail, />\s*連絡帳\s*$/)
    const nav = today.slice(today.indexOf('export function DaycareNav'), today.indexOf('function PlanBanners'))
    assert.ok(nav.length > 100, 'DaycareNav が見つからない')
    assert.doesNotMatch(nav, /contact|連絡帳/)
  })
  it('用紙は A5 縦・余白 8mm（印刷の直前だけ差し込み、終わったら外す）・1人1枚の改ページ・印刷で画面の部品を隠す', () => {
    assert.match(sheet, /export const CONTACT_PAGE_CSS = '@page \{ size: A5; margin: 8mm; \}'/)
    assert.match(sheet, /function injectPageStyle\(\)[^]*?style\.textContent = CONTACT_PAGE_CSS/)
    assert.match(sheet, /function cleanupPrint\(\)[^]*?removeAttribute\(PRINT_ATTR\)[^]*?getElementById\(PAGE_STYLE_ID\)\?\.remove\(\)/)
    assert.match(sheet, /window\.addEventListener\('afterprint', after\)/)
    assert.match(sheet, /window\.addEventListener\('beforeprint', before\)/)
    // CSS ファイルに @page を書かない（ほかの画面の印刷の用紙を変えない）
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /@page/)
    assert.match(css, /html\[data-dcc-print\] body > \*:not\(\.dcc-print-area\) \{\s*display: none !important;/)
    assert.match(css, /\.dcc-print-area \.dcc-sheet \{\s*break-after: page;\s*page-break-after: always;/)
    assert.match(css, /\.dcc-sheet:last-child \{\s*break-after: auto;/)
    // 印刷する中身は body の直下の置き場（画面の部品と別の木）。画面では隠す
    assert.match(sheet, /el\.className = 'dcc-print-area'[^]*?document\.body\.appendChild\(el\)/)
    assert.match(css, /\.dcc-print-area \{\s*display: none;/)
    // 印刷するのは選んだ方の紙面だけ
    // 2026-11-09 反証 軽4（固定し直し・意図は同じ）: 氏名を引ける方だけを刷る
    assert.match(page, /<DaycareContactPrint ref=\{printRef\} sheets=\{printable\} \/>/)
  })
  it('白い紙・黒い文字・色なし（新しい色を足さない）。1枚に収める調整は文字の大きさで（zoom・transform で縮めない）。本文は約11pt', () => {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/)
    assert.doesNotMatch(body, /\bzoom\b|transform/)
    assert.doesNotMatch(sheet, /\.zoom\b|transform/)
    assert.match(body, /color: var\(--cl-print-ink\);\s*background: var\(--cl-print-paper\);/)
    assert.match(sheet, /export const CONTACT_FONT_MAX_PX = 15/)
    assert.match(body, /font-size: var\(--dcc-font, 0\.9375rem\)/)
    assert.match(sheet, /el\.style\.setProperty\('--dcc-font', `\$\{size\}px`\)/)
    // ご家族の手書きの罫線は4本
    assert.equal((sheet.match(/<span className="dcc-rule" aria-hidden="true" \/>/g) ?? []).length, 4)
  })
  it('写真の欄が無い（紙面・画面・純ロジック・移行）', () => {
    // 説明のコメント（「写真の欄は持たない」）は除いて見る
    for (const s of [page, sheet, pure, css.replace(/\/\*[\s\S]*?\*\//g, '')]) {
      assert.doesNotMatch(s, /写真|photo|画像|<img/i)
    }
    // 移行は写真の列を作らない（表の説明の文「写真・送信の列は持たない」は除く）
    assert.doesNotMatch(sqlCode('../supabase/migrations/0061_daycare_contact.sql').replace(/'[^']*'/g, "''"), /photo|写真|image/i)
  })
  it('紙面には判定の記号（↑↓）を載せない・値は数値で（判定は vitalNeedsRecheck とその方の基準）', () => {
    assert.doesNotMatch(sheet, /[↑↓]|LEVEL_MARK|levelMark/)
    assert.doesNotMatch(pure, /[↑↓]|LEVEL_MARK/)
    // 2026-11-09 反証 重1（固定し直し・意図は同じ）: 欄ごとに合わせた値（v.values）で判定する
    assert.match(pure, /vitalNeedsRecheck\(v\.values, p\.target \?\? null, p\.thresholds\)/)
    assert.match(page, /thresholds: limits\.lookup\(id, data\.day\)/)
  })
  it('入力解禁は input_enabled_daycare（getKindInputGate(\'daycare\')）。封鎖中は隠さずに押せなくして理由文（見本と印刷は使える）', () => {
    assert.match(page, /getKindInputGate\('daycare'\)/)
    assert.doesNotMatch(page, /getKindInputGate\('(bath|daycare_activity|daycare_training)'\)/)
    assert.match(page, /const notesWritable = gateOpen && !missing && data !== null && data\.notesOk && day <= today/)
    assert.match(page, /disabled=\{!notesWritable \|\| busy\}/)
    assert.match(page, /disabled=\{!notesWritable \|\| busy \|\| !dirty\}/)
    assert.match(page, /kindBlockedMessage\('daycare'\)\}。見本の確認と印刷はできます。/)
    // 〔印刷する（n名）〕は旗で止めない（選んだ方がいない時だけ押せない）
    assert.match(page, /<button type="button" onClick=\{onPrint\} disabled=\{n === 0 \|\| printBlocked !== null\}/)
  })
  it('端末に業務データを残さない（localStorage・sessionStorage を使わない）・console に出さない', () => {
    for (const s of [page, sheet, pure]) {
      assert.doesNotMatch(s, /localStorage|sessionStorage/)
      assert.doesNotMatch(s, /console\./)
    }
  })
  it('書き込みは足した関数だけ（saveDaycareDayNote・saveDaycareContactField・markDaycareContactPrinted）', () => {
    const writes = [...new Set(page.match(/(?<![.\w])(save[A-Z]\w*|insert\w*|update[A-Z]\w*|delete\w*|softDelete\w*|upsert\w*|record[A-Z]\w*|open[A-Z]\w*|mark[A-Z]\w*|enqueue\w*)\(/g) ?? [])].sort()
    assert.deepEqual(writes, ['markDaycareContactPrinted(', 'saveDaycareContactField(', 'saveDaycareDayNote('])
    assert.doesNotMatch(page, /supabase|\.from\(/)
  })
  it('db.ts: 書くのは変えた欄だけ（行の丸ごとの上書きをしない）・rev 照合・食い違いは上書きせず知らせる・送信待ちに積まない', () => {
    const db = code('../src/lib/db.ts')
    const sec = db.slice(db.indexOf('const CONTACT_MSG = {'), db.indexOf('const MED_MSG = {'))
    assert.ok(db.indexOf('const CONTACT_MSG = {') < db.indexOf('const MED_MSG = {'))
    assert.ok(sec.length > 1000, '連絡帳の節が見つからない')
    // 更新はその欄だけ（共通の一文・個別のひと言・看護職のひと言は { [o.field]: o.want }、印刷した時刻は { printed_at: at }）
    assert.match(sec, /const sent = withEditor\(\{ \[o\.field\]: o\.want \}, o\.editedBy\)/)
    assert.match(sec, /const sent = withEditor\(\{ printed_at: at \}, p\.editedBy\)/)
    assert.equal((sec.match(/\.update\(/g) ?? []).length, 2)
    // 足す時もその欄と自然キーと記録者だけ
    assert.match(sec, /const payload = \{ \.\.\.o\.insertKey, \[o\.field\]: o\.want, recorded_by: idNum\(o\.recordedBy\) \}/)
    assert.match(sec, /\.insert\(\{ resident_id: residentId, day: p\.day, printed_at: at, recorded_by: idNum\(p\.recordedBy\) \}\)/)
    // rev 照合（ひと言の欄）・食い違いは conflict
    assert.match(sec, /\.update\(p\)\.eq\('id', cur\.id\)\.eq\('rev', cur\.rev\)\.is\('deleted_at', null\)/)
    assert.match(sec, /return \{ kind: 'conflict', row: live \}/)
    // 送信待ちに積まない・upsert しない・旗は input_enabled_daycare
    assert.doesNotMatch(sec, /enqueue\(|\.upsert\(/)
    assert.equal((sec.match(/await assertKindWritable\('daycare'\)/g) ?? []).length, 3)
    assert.match(sec, /offline: '保存できませんでした。通信状態を確認して、もう一度押してください。'/)
    // 印刷した時刻は失敗しても例外にしない
    const mark = sec.slice(sec.indexOf('export async function markDaycareContactPrinted'))
    assert.match(mark, /\} catch \{\s*return \[\]\s*\}\s*\}\s*$/)
  })
  it('押す所は 44px 以上（ボタン・〔印刷する〕の切り替え・入口）・画面の文字は 15px 以上（text-xs・text-2xs を使わない）', () => {
    assert.match(page, /const BTN = 'inline-flex min-h-tap/)
    assert.match(page, /const BTN_PRIMARY =\s*'inline-flex min-h-tap/)
    assert.match(page, /htmlFor=\{checkId\}\s*className=\{`inline-flex min-h-tap min-w-tap/)
    assert.doesNotMatch(page, /\btext-(xs|2xs)\b/)
    for (const m of page.match(/<button[^>]*className="[^"]*"/g) ?? []) assert.match(m, /min-h-tap/, m)
  })
  it('印刷の前の確かめの小窓は〔戻って書く〕〔このまま印刷する〕・対象は nurseNoteMissing・印刷したら printed_at を書く', () => {
    // 2026-11-09 反証 中3・軽5（固定し直し・意図は同じ）: 確かめの対象は印刷に送る方（printable）
    assert.match(page, /nurse: nurseNoteMissing\(printable, set\)/)
    assert.match(page, />\s*戻って書く\s*</)
    assert.match(page, />\s*このまま印刷する\s*</)
    assert.match(page, /printRef\.current\?\.print\(\)[^]*?markDaycareContactPrinted\(/)
    // 通信できない時は入れた文を欄に残す（失敗で drafts を消さない）。コメントを残した本文で探す（code() はコメントを消す）
    const rawPage = read('../src/pages/DaycareContactPage.tsx')
    const at = rawPage.indexOf('// 通信できない・封鎖・長すぎる・過去の日の守り など')
    assert.ok(at > 0, 'catch の節が見つからない')
    const catchBlock = rawPage.slice(at, rawPage.indexOf('} finally {', at))
    assert.ok(catchBlock.length > 20)
    assert.doesNotMatch(catchBlock, /setDrafts|dropDraft/)
  })
  it('原則11: 日は URL の ?day= で持つ（再読み込みでも同じ日）。選んだ方・入れかけた文は保存しない', () => {
    assert.match(page, /const day = readPersonDay\(search\.get\('day'\), today\)/)
    assert.match(page, /navigate\(contactPath\(d, today\), \{ replace: true \}\)/)
  })
})

describe('移行 0061_daycare_contact.sql（静的検査）', () => {
  const page2 = code('../src/pages/DaycareContactPage.tsx')
  const raw = read('../supabase/migrations/0061_daycare_contact.sql')
  const m = sqlCode('../supabase/migrations/0061_daycare_contact.sql')
  const T = ['daycare_day_notes', 'daycare_contact_notes']

  it('頭のコメントに「足すだけ・既存を変えない・本番は親が流す」と戻し方（drop の SQL）', () => {
    assert.match(raw, /足すだけ・既存を変えない・本番は親が流す/)
    assert.match(raw, /--\s+drop table if exists public\.daycare_contact_notes;/)
    assert.match(raw, /--\s+drop table if exists public\.daycare_day_notes;/)
  })
  it('新しい2つの表（共通の列・本文の上限・写しや写真・送信の列は無い）', () => {
    assert.match(m, /create table if not exists public\.daycare_day_notes \(/)
    assert.match(m, /create table if not exists public\.daycare_contact_notes \(/)
    for (const col of ['id            bigint generated always as identity primary key', 'rev           integer not null default 1', 'deleted_at    timestamptz', 'deleted_by    bigint', 'edited_by     bigint', 'recorded_by   bigint', 'updated_at    timestamptz not null default now()']) {
      assert.equal((m.match(new RegExp(col.replace(/[()]/g, '\\$&'), 'g')) ?? []).length, 2, col)
    }
    assert.match(m, /nurse_note    text,/)
    assert.match(m, /printed_at    timestamptz,/)
    assert.match(m, /check \(body is null or pg_catalog\.char_length\(body\) <= 200\)/)
    assert.match(m, /check \(nurse_note is null or pg_catalog\.char_length\(nurse_note\) <= 150\)/)
    assert.equal((m.match(/char_length\(body\) <= 200/g) ?? []).length, 2)
    assert.doesNotMatch(m, /photo|sent_at|sent_via|client_key/)
  })
  it('施設の印: 必須・既定は印を入れるトリガ（carelog_fill_tenant）・外部キーは（施設の印, 番号）の組', () => {
    assert.equal((m.match(/tenant_id     uuid not null references public\.tenants\(id\)/g) ?? []).length, 2)
    for (const t of T) {
      assert.match(m, new RegExp(`create trigger carelog_fill_tenant before insert on public\\.${t}\\s+for each row execute function private\\.carelog_fill_tenant\\(\\);`))
      for (const c of ['recorded_by', 'deleted_by', 'edited_by']) {
        assert.match(m, new RegExp(`constraint ${t}_${c}_fkey\\s+foreign key \\(tenant_id, ${c}\\)\\s+references public\\.staff \\(tenant_id, id\\)`))
      }
    }
    assert.match(m, /constraint daycare_contact_notes_resident_id_fkey foreign key \(tenant_id, resident_id\) references public\.residents \(tenant_id, id\)/)
    // 単独の番号を指す外部キー（施設を見ない形）は作らない
    assert.doesNotMatch(m, /references public\.(residents|staff)\(id\)/)
  })
  it('一意の索引は施設の印が先頭・生きている行だけ（1日1行・1人1日1行）', () => {
    assert.match(m, /create unique index if not exists uq_daycare_day_notes\s+on public\.daycare_day_notes \(tenant_id, day\)\s+where deleted_at is null;/)
    assert.match(m, /create unique index if not exists uq_daycare_contact_notes\s+on public\.daycare_contact_notes \(tenant_id, resident_id, day\)\s+where deleted_at is null;/)
  })
  it('rev・updated_at・変更の記録のトリガ（足すトリガ関数は過去の日の守りの1つだけ）', () => {
    for (const t of T) {
      assert.match(m, new RegExp(`create or replace trigger trg_updated_${t}\\s+before update on public\\.${t}\\s+for each row execute function public\\.set_updated_at_rev\\(\\);`))
      assert.match(m, new RegExp(`create or replace trigger trg_history_${t}\\s+after update on public\\.${t}\\s+for each row execute function public\\.record_history_capture\\('day'\\);`))
    }
    // 2026-11-09 反証 軽3（固定し直し・意図は同じ）: 作る関数は過去の日の守りのトリガ関数だけ
    assert.deepEqual(m.match(/create (or replace )?function [\w.]+/g), ['create or replace function public.daycare_contact_day_guard'])
  })
  it('過去の日の守り（0042・0043・0046 と同じ作法）: 現場はその日だけ・過去の日は事務所・未来の日は誰も・実行の権限は誰にも渡さない', () => {
    const fn = m.slice(m.indexOf('create or replace function public.daycare_contact_day_guard()'), m.indexOf('$fn$;') + 5)
    assert.match(fn, /returns trigger\s+language plpgsql\s+security definer\s+set search_path = ''/)
    assert.match(fn, /v_today date := \(pg_catalog\.now\(\) at time zone 'Asia\/Tokyo'\)::date;/)
    assert.match(fn, /if new\.day > v_today and \(tg_op = 'INSERT' or new\.day is distinct from old\.day\) then\s+raise exception 'daycare_contact_future: [^']+'\s+using errcode = '22023';/)
    assert.match(fn, /if pg_catalog\.to_regprocedure\('private\.my_role\(\)'\) is null then\s+return new;/)
    assert.match(fn, /if v_role is distinct from 'field' then\s+return new;/)
    assert.match(fn, /raise exception 'daycare_contact_past_office_only: [^']+'\s+using errcode = '42501'/)
    assert.match(m, /revoke all on function public\.daycare_contact_day_guard\(\) from public, anon, authenticated;/)
    for (const t of T) {
      assert.match(m, new RegExp(`create or replace trigger trg_${t}_day_guard\\s+before insert or update on public\\.${t}\\s+for each row execute function public\\.daycare_contact_day_guard\\(\\);`))
    }
    // 戻し方に関数の drop も書いてある・最後の確かめに守りが入っている
    assert.match(raw, /--\s+drop function if exists public\.daycare_contact_day_guard\(\);/)
    assert.match(m, /not pg_catalog\.has_function_privilege\('authenticated', 'public\.daycare_contact_day_guard\(\)', 'execute'\)/)
    // 画面も同じ条件で欄を押せなくする（理由の文つき）・db.ts は守りの誤りを別の案内にする
    assert.match(page2, /const dayWritable = day === today \|\| \(day < today && canEditPastDaycareTimes\(role\)\)/)
    assert.match(page2, /const notesWritable = gateOpen && !missing && data !== null && data\.notesOk && day <= today && dayWritable/)
    assert.match(page2, /\{day < today && !dayWritable \? \(/)
    assert.match(read('../src/pages/DaycareContactPage.tsx'), /const MSG_PAST_OFFICE = '過去の日の連絡帳のひと言は、事務所のログインでだけ書けます（現場の端末は当日だけ）。/)
    const db = code('../src/lib/db.ts')
    assert.match(db, /e\.code === '42501' && typeof e\.message === 'string' && e\.message\.startsWith\('daycare_contact_past_office_only:'\)/)
    assert.match(db, /if \(isContactPastOfficeOnly\(res\)\) return new DbError\('server', CONTACT_MSG\.pastOffice\)/)
  })
  it('RLS: 0044 と同じ4本＋0054 と同じ tenant_only・delete のポリシーなし・anon は何も無し・delete と truncate の権限を外す', () => {
    for (const t of T) {
      assert.match(m, new RegExp(`alter table public\\.${t} enable row level security;`))
      assert.match(m, new RegExp(`create policy "read_auth"   on public\\.${t} for select to authenticated using \\(true\\);`))
      assert.match(m, new RegExp(`create policy "insert_auth" on public\\.${t} for insert to authenticated with check \\(true\\);`))
      assert.match(m, new RegExp(`create policy "update_auth" on public\\.${t} for update to authenticated using \\(true\\) with check \\(true\\);`))
      assert.match(m, new RegExp(`create policy member_only on public\\.${t} as restrictive for all to authenticated\\s+using \\(private\\.is_member\\(\\)\\) with check \\(private\\.is_member\\(\\)\\);`))
      assert.match(m, new RegExp(`create policy tenant_only on public\\.${t} as restrictive for all to authenticated\\s+using \\(tenant_id = \\(select private\\.my_tenant\\(\\)\\)\\) with check \\(tenant_id = \\(select private\\.my_tenant\\(\\)\\)\\);`))
      assert.match(m, new RegExp(`revoke all on public\\.${t} from anon;`))
      assert.match(m, new RegExp(`revoke delete, truncate on public\\.${t} from authenticated;`))
    }
    assert.doesNotMatch(m, /for delete/)
    // 0054 の守りの文言と同じ形（施設の印 = ログインした人の施設を1回だけ調べる）
    assert.ok(read('../supabase/migrations/0054_tenant_stage4.sql').includes("'using (tenant_id = (select private.my_tenant())) '"))
  })
  it('既存の表・関数・守りを変えない（名前を変えない・drop しない・足すだけ）・do $$ を使わない・begin … commit', () => {
    // 手を入れる表は新しい2つだけ
    const touched = new Set([...m.matchAll(/\b(?:alter table|on|create table if not exists|revoke all on|revoke delete, truncate on)\s+public\.(\w+)/g)].map((x) => x[1]))
    assert.deepEqual([...touched].sort(), [...T].sort())
    assert.doesNotMatch(m, /drop table|drop column|drop index|drop function|rename|truncate table|delete from|update public\./i)
    // drop するのは新しい表のトリガ・守り・check（付け直しのため）だけ
    for (const d of m.match(/drop (trigger|policy|constraint) if exists [^;]+;/g) ?? []) {
      assert.ok(T.some((t) => d.includes(`public.${t}`) || d.includes(`${t}_`)), d)
    }
    assert.doesNotMatch(m, /^\s*do\s+\$\$/im)
    assert.match(m, /^begin;$/m)
    assert.match(m, /^commit;$/m)
    // app_settings に何も足さない（旗は既存の input_enabled_daycare）
    assert.doesNotMatch(m, /app_settings|on conflict/)
    // Realtime には載せない（画面は〔最新に更新〕で読み直す）
    assert.doesNotMatch(m, /supabase_realtime/)
  })
  it('素の Postgres の契約（pg-run-all）: 0053 の流し直しの除外は理由つき・0061 の2表は施設の印の試験の一覧に入っている', () => {
    const all = read('./pg-run-all.mjs')
    assert.match(all, /\['0053_tenant_stage3\.sql', '利用者・職員・申し送りを指す外部キーが決まった76本かの確かめ（0061 が組の外部キーを足した）'\]/)
    assert.match(read('./tenant-stage1-pg.mjs'), /export const LATER_TENANT_TABLES = \['daycare_day_notes', 'daycare_contact_notes'\]/)
    assert.match(read('./tenant-stage3-pg.mjs'), /const LATER_TABLES = \['daycare_day_notes', 'daycare_contact_notes'\]/)
    assert.match(read('./tenant-stage4-pg.mjs'), /const LATER_TABLES = \['daycare_day_notes', 'daycare_contact_notes'\]/)
    assert.match(read('./daycare-contact-pg.mjs'), /daycare_contact_notes/)
  })
})

// ══════════════════════════════════════════════════════════════
// 2026-11-09 反証と親の決定（連絡帳 b499acf の直し）
// ══════════════════════════════════════════════════════════════

if (C !== null) {
  describe('親の決定: 「記録なし」は記録の項目だけ・ひと言の欄は空なら見出しごと出さない', () => {
    it('職員より: 共通の一文も個別のひと言も空なら出さない（共通の一文が空の日も、個別のひと言だけなら出す）', () => {
      const empty = C.buildContactSheet(input())
      assert.equal(C.staffSectionShown(empty), false)
      const onlyPersonal = C.buildContactSheet(input({ note: { body: '笑顔で過ごされました。', nurse_note: null } }))
      assert.equal(C.staffSectionShown(onlyPersonal), true)
      assert.deepEqual(onlyPersonal.staff, { common: null, personal: '笑顔で過ごされました。' })
      const onlyCommon = C.buildContactSheet(input({ dayNote: '秋の歌を歌いました。' }))
      assert.equal(C.staffSectionShown(onlyCommon), true)
      // 来ていない方は共通の一文を載せない＝個別のひと言が無ければ出さない
      assert.equal(C.staffSectionShown(C.buildContactSheet(input({ state: 'absent', dayNote: '秋の歌を歌いました。' }))), false)
      // ひと言を読めなかった時は「読み込めませんでした」で出す（空とは違う）
      assert.equal(C.staffSectionShown(C.buildContactSheet(input({ notesOk: false }))), true)
    })
    it('看護職より: 基準外で、看護職のひと言がある時だけ（空なら出さない＝印刷の前の注意の対象のまま）', () => {
      const hotEmpty = C.buildContactSheet(input({ vitals: [vital({ temp: 38.2 })] }))
      assert.equal(hotEmpty.abnormal, true)
      assert.equal(C.nurseSectionShown(hotEmpty), false)
      assert.deepEqual(C.nurseNoteMissing([hotEmpty], new Set([1])), [1])
      const hotWritten = C.buildContactSheet(input({ vitals: [vital({ temp: 38.2 })], note: { body: null, nurse_note: '受診をおすすめします' } }))
      assert.equal(C.nurseSectionShown(hotWritten), true)
      const normal = C.buildContactSheet(input({ vitals: [vital({ temp: 36.5 })], note: { body: null, nurse_note: '書いてあっても基準内なら出さない' } }))
      assert.equal(C.nurseSectionShown(normal), false)
    })
    it('紙面の部品は、ひと言の欄に「記録なし」を使わない（記録の項目だけ）', () => {
      const view = code('../src/components/print/DaycareContactSheet.tsx')
      assert.doesNotMatch(view, /NO_RECORD|記録なし/)
      assert.match(view, /\{staffSectionShown\(sheet\) \? \(/)
      assert.match(view, /\{nurseSectionShown\(sheet\) \? \(/)
    })
  })

  describe('反証 重1: 再測定で一部の欄だけを入れた方は、欄ごとに値のある一番後の回を合わせ、その値で基準外を判定する', () => {
    it('1回目は全部・再測定は血圧だけ → 体温・脈拍・SpO2 は1回目、血圧は再測定。注記はそのまま', () => {
      const s = C.buildContactSheet(
        input({
          vitals: [
            vital({ id: 41, temp: 36.6, sys_bp: 172, dia_bp: 96, pulse: 78, spo2: 97, client_key: `dc:${DAY}:1:1` }),
            vital({ id: 42, sys_bp: 138, dia_bp: 82, client_key: `dc:${DAY}:1:2` }),
          ],
        }),
      )
      assert.deepEqual(s.vitals.cells.map((c) => c.value), ['36.6℃', '138/82 mmHg', '78 回/分', '97%'])
      assert.equal(s.vitals.recheck, true)
      // 合わせた値は基準内（1回目の血圧 172/96 では判定しない）
      assert.equal(s.abnormal, false)
    })
    it('1回目 37.8 と 182/95・再測定は体温だけ（36.8）→ 体温は再測定、血圧は1回目のまま＝血圧で基準外', () => {
      const s = C.buildContactSheet(
        input({
          vitals: [
            vital({ id: 51, temp: 37.8, sys_bp: 182, dia_bp: 95, client_key: `dc:${DAY}:1:1` }),
            vital({ id: 52, temp: 36.8, client_key: `dc:${DAY}:1:2` }),
          ],
        }),
      )
      assert.equal(s.vitals.cells[0].value, '36.8℃')
      assert.equal(s.vitals.cells[1].value, '182/95 mmHg')
      assert.equal(s.vitals.recheck, true)
      assert.equal(s.abnormal, true)
    })
    it('血圧は上と下を組で同じ回から取る（再測定で上だけなら、下は前の回と混ぜずに「記録なし」）', () => {
      const m = C.mergeVitalSlots([
        { seq: 1, vals: { temp: 36.5, sys_bp: 160, dia_bp: 92, pulse: 70, spo2: 96 } },
        { seq: 2, vals: { temp: null, sys_bp: 140, dia_bp: null, pulse: null, spo2: null } },
      ])
      assert.deepEqual(m.values, { temp: 36.5, sys_bp: 140, dia_bp: null, pulse: 70, spo2: 96 })
      assert.equal(C.sheetVitalCells(m.values)[1].value, '上 140／下 記録なし')
      // 回の並びは回の番号の順（渡す順に左右されない）・値の無い回は数えない
      const r = C.mergeVitalSlots([
        { seq: 3, vals: { temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null } },
        { seq: 2, vals: { temp: 37.0, sys_bp: null, dia_bp: null, pulse: null, spo2: null } },
        { seq: 1, vals: { temp: 38.0, sys_bp: null, dia_bp: null, pulse: 88, spo2: null } },
      ])
      assert.deepEqual(r, { values: { temp: 37.0, sys_bp: null, dia_bp: null, pulse: 88, spo2: null }, recheck: true })
      assert.deepEqual(C.mergeVitalSlots([]), { values: null, recheck: false })
    })
  })

  describe('反証 中2: 送信待ちの記録を紙面に重ねる（今日の画面と同じ決まり）・重ねた方は見本に「送信待ちを含む」', () => {
    it('バイタル: 送信待ちにだけある回・サーバーの回に重ねた値（キーごとの pendingRow）', () => {
      const pend = { [`dc:${DAY}:1:2`]: { values: { temp: 37.9 } } }
      const s = C.buildContactSheet(
        input({ vitals: [vital({ id: 61, temp: 36.5, pulse: 70, client_key: `dc:${DAY}:1:1` })], vitalPending: (k) => pend[k] ?? null }),
      )
      assert.equal(s.vitals.cells[0].value, '37.9℃')
      assert.equal(s.vitals.cells[2].value, '70 回/分')
      assert.equal(s.vitals.recheck, true)
      assert.equal(s.abnormal, true)
      assert.deepEqual(s.pendingLabels, ['バイタル'])
      // サーバーの回の値を送信待ちで直した時も、その値
      const over = C.buildContactSheet(input({ vitals: [vital({ temp: 36.5 })], vitalPending: (k) => (k === `dc:${DAY}:1:1` ? { values: { temp: 36.9 } } : null) }))
      assert.equal(over.vitals.cells[0].value, '36.9℃')
      assert.deepEqual(over.pendingLabels, ['バイタル'])
      // 送信待ちが無ければ印も無い
      assert.deepEqual(C.buildContactSheet(input({ vitals: [vital({ temp: 36.5 })] })).pendingLabels, [])
    })
    it('昼食: 送っている途中（pending）の値だけ重ねる。止まった値（食い違い・拒まれた）は重ねない', () => {
      const p = C.buildContactSheet(input({ lunch: null, lunchPending: { state: 'pending', values: { main_amount: 8, side_amount: 6 } } }))
      assert.equal(itemOf(p, 'お食事'), '昼食 主食 8割・副食 6割')
      assert.deepEqual(p.pendingLabels, ['お食事'])
      const stopped = C.buildContactSheet(input({ lunch: null, lunchPending: { state: 'conflict', values: { main_amount: 8 } } }))
      assert.equal(itemOf(stopped, 'お食事'), '記録なし')
      assert.deepEqual(stopped.pendingLabels, [])
    })
    it('活動: 送信待ちの追加は出す・止まっていない取り消しは出さない（activityShownCells と同じ）', () => {
      const rows = [{ id: 7, resident_id: 1, day: DAY, label: '体操', participation: 'full', note: null, recorded_by: null, rev: 1 }]
      const add = C.buildContactSheet(input({ activities: rows, activityPending: [{ kind: 'add', residentId: 1, day: DAY, label: '歌', participation: 'partial', stopped: false }] }))
      assert.equal(itemOf(add, '活動'), '体操・歌（一部）')
      assert.deepEqual(add.pendingLabels, ['活動'])
      const del = C.buildContactSheet(input({ activities: rows, activityPending: [{ kind: 'update', rowId: 7, participation: null, deleted: true, stopped: false }] }))
      assert.equal(itemOf(del, '活動'), '記録なし')
      // ほかの方の送信待ちは重ねない
      const other = C.buildContactSheet(input({ activities: rows, activityPending: [{ kind: 'add', residentId: 2, day: DAY, label: '歌', participation: 'full', stopped: false }] }))
      assert.equal(itemOf(other, '活動'), '体操')
      assert.deepEqual(other.pendingLabels, [])
    })
    it('機能訓練: サーバーに無く送信待ちの追加だけある時、紙は「記録なし」のまま・見本の「送信待ちを含む」と印刷前の確かめに出す（2026-11-09 親の決定）', () => {
      const s = C.buildContactSheet(input({ training: [], trainingPending: [{ kind: 'add', table: 'daycare_training_sessions', residentId: 1, day: DAY, stopped: false }] }))
      assert.equal(itemOf(s, '機能訓練'), '記録なし')
      assert.doesNotMatch(JSON.stringify(s.items), /送信待ち/)
      assert.deepEqual(s.pendingLabels, ['機能訓練'])
      assert.equal(s.trainingQueued, true)
      assert.deepEqual(C.trainingQueuedPicked([s], new Set([1])), [1])
      assert.deepEqual(C.trainingQueuedPicked([s], new Set()), [])
      assert.equal(C.TRAINING_PENDING_TEXT, undefined)
      // サーバーに記録があれば送信待ちの追加は数えない（記録を出す）
      const landed = C.buildContactSheet(input({ training: [session()], trainingPending: [{ kind: 'add', table: 'daycare_training_sessions', residentId: 1, day: DAY, stopped: false }] }))
      assert.equal(itemOf(landed, '機能訓練'), '実施（立ち上がり・20分）')
      assert.equal(landed.trainingQueued, false)
      // 配置の送信待ち・ほかの方の送信待ちは数えない
      const staffing = C.buildContactSheet(input({ training: [], trainingPending: [{ kind: 'add', table: 'daycare_staffing', day: DAY, stopped: false }] }))
      assert.equal(itemOf(staffing, '機能訓練'), '記録なし')
      assert.equal(staffing.trainingQueued, false)
      const other = C.buildContactSheet(input({ training: [], trainingPending: [{ kind: 'add', table: 'daycare_training_sessions', residentId: 2, day: DAY, stopped: false }] }))
      assert.equal(other.trainingQueued, false)
      assert.deepEqual(other.pendingLabels, [])
      // 来ていない方は記録の欄を出さないので数えない
      assert.equal(C.buildContactSheet(input({ state: 'absent', training: [], trainingPending: [{ kind: 'add', table: 'daycare_training_sessions', residentId: 1, day: DAY, stopped: false }] })).trainingQueued, false)
    })
    it('画面: 印刷前の確かめの小窓に「送信待ちの機能訓練がある方（送信が済んでから刷ると紙に載ります）」を並べる', () => {
      const page = read('../src/pages/DaycareContactPage.tsx')
      assert.match(page, /trainingQueued: trainingQueuedPicked\(printable, set\)/)
      assert.match(page, /check\.trainingQueued\.length > 0 \|\|/)
      assert.match(page, /送信待ちの機能訓練がある方（送信が済んでから刷ると紙に載ります。/)
      assert.match(page, /\{confirm\.trainingQueued\.map\(\(rid\) => \(/)
    })
    it('画面: 今日の画面と同じ関数で送信待ちを渡し、見本の下に「送信待ちを含む」を出す（紙には出さない）', () => {
      const page = code('../src/pages/DaycareContactPage.tsx')
      assert.match(page, /vitalPending: \(key\) => pendingRow\('vitals', \{ routine: false, clientKey: key, residentId: id, day: data\.day, kind: 'observation' \}\)/)
      assert.match(page, /lunchPending: pendingRow\('meals', \{ residentId: id, day: data\.day, slot: 'lunch' \}\)/)
      assert.match(page, /const activityPending = data\.activities === null \? \[\] : pendingActivityOps\(\)/)
      assert.match(page, /const trainingPending = data\.training === null \? \[\] : pendingTrainingOps\(\)/)
      assert.match(page, /送信待ちを含む（\{sheet\.pendingLabels\.join\('・'\)\}）/)
      // 送信待ちの数が変われば描き直し、減ったら静かに読み直す
      assert.match(page, /const off = queueSubscribe\(\(n\) => \{\s*setQueueTick\(\(x\) => x \+ 1\)\s*if \(n < last\)/)
      const pure = code('../src/lib/daycareContact.ts')
      assert.match(pure, /import \{ activityShownCells, daycareVitalSlotsWithPending, lunchShownWith, vitalShownValues \} from '\.\/daycareProgress\.ts'/)
      assert.doesNotMatch(code('../src/components/print/DaycareContactSheet.tsx'), /pendingLabels|送信待ち/)
    })
  })

  describe('反証 中3・軽5: 読めない項目・自動の入浴を印刷の前に確かめる', () => {
    it('読めなかった項目の名前（来た方）・ひと言だけ（来ていない方）・確かめの対象', () => {
      const s = C.buildContactSheet(input({ vitalsOk: false, bathsOk: false, intakeOk: false, activities: null, training: null, notesOk: false }))
      assert.deepEqual(s.unreadLabels, ['バイタル', '入浴', 'お食事・水分', '活動', '機能訓練', 'ひと言'])
      assert.deepEqual(C.buildContactSheet(input({ state: 'absent', vitalsOk: false, notesOk: false })).unreadLabels, ['ひと言'])
      assert.deepEqual(C.buildContactSheet(input()).unreadLabels, [])
      const ok = C.buildContactSheet(input({ residentId: 2 }))
      assert.deepEqual(C.unreadPicked([s, ok], new Set([1, 2])), [{ residentId: 1, labels: s.unreadLabels }])
      assert.deepEqual(C.unreadPicked([s, ok], new Set([2])), [])
      // バイタルが読めない方は、看護職のひと言が要るか分からない旨を出す
      assert.deepEqual(C.vitalsUnreadPicked([s, ok], new Set([1, 2])), [1])
    })
    it('入浴が自動の記録のまま（12:30 の自動の行）の方を並べる。紙の文言は今のまま・中止の行は除く', () => {
      const auto = C.buildContactSheet(input({ bath: bath({ auto: true }) }))
      assert.equal(auto.autoBath, true)
      assert.equal(itemOf(auto, '入浴'), '入浴しました（全身浴）')
      assert.deepEqual(C.autoBathPicked([auto], new Set([1])), [1])
      assert.equal(C.buildContactSheet(input({ bath: bath({ auto: false }) })).autoBath, false)
      assert.equal(C.bathIsAuto(bath({ auto: true, result: 'cancel', cancel_reason: 'absent' })), false)
      assert.equal(C.sheetBathText(bath({ auto: true, result: 'cancel', cancel_reason: 'absent' }), true, true), '入浴しませんでした（欠席）')
    })
    it('画面: 読めない項目がある日は上に帯・確かめの小窓に並べて〔最新に更新〕をすすめる・自動の入浴も並べる', () => {
      const page = read('../src/pages/DaycareContactPage.tsx')
      assert.match(page, /\{unreadDay\.length > 0 && board\.rows\.length > 0 \? \(/)
      assert.match(page, /の記録を読み込めませんでした（紙には「読み込めませんでした」と載ります）。通信状態を確認して、〔最新に更新〕を押してから印刷してください。/)
      assert.match(page, /vitalsUnread: vitalsUnreadPicked\(printable, set\)/)
      assert.match(page, /unread: unreadPicked\(printable, set\)/)
      assert.match(page, /autoBath: autoBathPicked\(printable, set\)/)
      assert.match(page, /バイタルを読み込めないため、基準を外れたかを確かめられない方（看護職のひと言が要るか分かりません）/)
      assert.match(page, /入浴が自動の記録のままの方/)
      assert.match(page, /setReloadKey\(\(k\) => k \+ 1\)[^]*?最新に更新/)
    })
  })

  describe('反証 中1: 入れかけの文が他の端末の保存を黙って上書きしない', () => {
    it('入れかけの文・入れ始めた時の保存値・いまの保存値の関係', () => {
      // 保存値が変わっていない
      assert.equal(C.draftAgainstSaved('入れかけ', 'もと', 'もと'), 'keep')
      assert.equal(C.draftAgainstSaved('入れかけ', null, ''), 'keep')
      // 保存値が変わったが、入れかけは入れ始めた時のまま・または新しい保存値と同じ → 入れかけを外す
      assert.equal(C.draftAgainstSaved('もと', 'もと', '別の端末の文'), 'drop')
      assert.equal(C.draftAgainstSaved(' 別の端末の文 ', 'もと', '別の端末の文'), 'drop')
      // 違う文を入れていて、保存値も変わった → 知らせる（上書きしない）
      assert.equal(C.draftAgainstSaved('私の文', 'もと', '別の端末の文'), 'changed')
      assert.equal(C.draftAgainstSaved('私の文', null, '別の端末の文'), 'changed')
    })
    it('画面: 入れ始めた時の保存の行を欄ごとに控え、それを保存の基準にする（いまの行で上書きしない）', () => {
      const page = code('../src/pages/DaycareContactPage.tsx')
      assert.match(page, /const onInput = \(key: FieldKey, v: string\) => \{\s*if \(!\(key in draftBase\)\) \{/)
      assert.match(page, /const base = key in draftBase \? draftBase\[key\]\.row : rowOf\(key\)/)
      assert.match(page, /saveDaycareDayNote\(\{ day: target, text, base: base as DaycareDayNote \| null/)
      assert.match(page, /saveDaycareContactField\(\{[^}]*base: base as DaycareContactNote \| null/)
      // 読み直し・保存・印刷の後に行を差し替えるたびに見て、変わっていたら欄の下に知らせる
      assert.match(page, /const rel = draftAgainstSaved\(drafts\[key\], base\.value, saved\)/)
      assert.match(page, /setMsg\(key, \{ tone: 'warn', text: changedText\(saved\) \}\)/)
      assert.match(page, /\}, \[data\]\)/)
      // 日を切り替えたら基準も外す
      assert.match(page, /setDrafts\(\{\}\)\s*setDraftBase\(\{\}\)/)
    })
  })

  describe('反証 軽4: 名簿が読めない時は印刷を止めて理由を出す（「利用者ID 12 様」と刷らない）', () => {
    it('印刷に送るのは氏名を引ける方だけ・読めない／読み込み中・氏名が無い方がいる時は〔印刷する〕を押せなくして理由', () => {
      const page = code('../src/pages/DaycareContactPage.tsx')
      assert.match(page, /const printable = useMemo\(\(\) => \(roster === 'ok' \? pickedSheets\.filter\(\(s\) => nameKnown\(s\.residentId\)\) : \[\]\)/)
      assert.match(page, /disabled=\{n === 0 \|\| printBlocked !== null\}/)
      assert.match(page, /roster === 'loading'\s*\? MSG_ROSTER_LOADING\s*: roster === 'failed'\s*\? MSG_ROSTER_FAILED/)
      assert.match(page, /名簿に氏名が無い方がいるため、印刷できません/)
      assert.match(read('../src/pages/DaycareContactPage.tsx'), /const MSG_ROSTER_FAILED = '利用者の名簿を読み込めないため、印刷できません（氏名を刷れません）。/)
      assert.match(page, /if \(printable\.length === 0\) return/)
    })
  })

  describe('反証 軽1・軽2: printed_at の意味・変更の記録の呼び名', () => {
    it('printed_at は「〔印刷する〕で印刷に送った時刻」（Ctrl+P・⌘P では書かない）とコメントに書いてある', () => {
      assert.match(read('../supabase/migrations/0061_daycare_contact.sql'), /〔印刷する〕で印刷に送った最後の時刻/)
      assert.match(read('../src/lib/db.ts'), /printed_at は「〔印刷する〕で印刷に送った\n \* 最後の時刻」/)
      assert.match(read('../src/lib/daycareContact.ts'), /〔印刷する〕で印刷に送った最後の時刻（ISO）/)
    })
    it('変更の記録の表と列の呼び名（日本語）', async () => {
      const HV = await import('../src/lib/historyView.ts')
      assert.equal(HV.HISTORY_TABLE_LABEL.daycare_day_notes, 'デイの連絡帳（共通の一文）')
      assert.equal(HV.HISTORY_TABLE_LABEL.daycare_contact_notes, 'デイの連絡帳のひと言')
      assert.equal(HV.historyColumnLabel('daycare_day_notes', 'body'), '全員共通の一文')
      assert.equal(HV.historyColumnLabel('daycare_contact_notes', 'body'), '個別のひと言')
      assert.equal(HV.historyColumnLabel('daycare_contact_notes', 'nurse_note'), '看護職のひと言')
      assert.equal(HV.historyColumnLabel('daycare_contact_notes', 'printed_at'), '印刷した時刻')
      assert.equal(HV.historyColumnLabel('daycare_contact_notes', 'day'), '日付')
      // 申し送りの本文の呼び名は変えない
      assert.equal(HV.historyColumnLabel('notes', 'body'), '本文')
    })
  })
}
