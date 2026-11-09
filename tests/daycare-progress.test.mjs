// デイ 計画B（2026-11-09）: 今日のカードの状態の4色・進み具合の印・切り替えの未入力の数・一括の4画面の「未入力 n名」・機能訓練の表を上に、の試験。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycareProgress.ts）: 状態の4色と言葉（daycareStateTone）・一括の来た・まだ（daycareCameMark）・
//    進み具合の印（daycareProgressMarks の5種×済・未・対象外・要確認・読めない、来ていない方の扱い）・attendedUnfilledCount・
//    各画面の「入力済み」（vitalSlotsFilled・activityCellsFilled・trainingFilled）・切り替えの数（daycareNavPending・navPendingOf）
// 2. 静的検査: カードの段の作り（4段・ふりがなは〔休み〕の横に無い・「入浴 {bathText}」の段が無い・印は押せない）・DaycareNav の
//    未入力の数（今日の画面だけ渡す・0 は出さない・44px のまま）・4画面の未入力の数の場所・機能訓練の区画の並び・トークンだけの色
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
  P = await import('../src/lib/daycareProgress.ts')
} catch (e) {
  loadError = e
  P = null
}

/** 一覧の1行（試験用。名簿の氏名は持たない） */
const row = (over = {}) => ({
  residentId: 1,
  state: 'planned',
  attendance: null,
  planned: true,
  dup: false,
  plans: [{ start: '09:30', end: '15:30', bathing: false }],
  hospitalized: false,
  ...over,
})
const att = (over = {}) => ({ id: 1, resident_id: 1, day: '2026-11-09', arrived_at: null, left_at: null, absent: false, absent_reason: null, ...over })

if (P === null) {
  registerLoadFailure('デイ 計画B の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('状態の4色と言葉（daycareStateTone・カード）', () => {
    it('来所前・予定外は点線の枠／在席は緑／帰宅は青／休み・入院中は灰（今の休みと同じ）', () => {
      assert.equal(P.DAYCARE_CARD_CLS.before, 'border-dashed border-border-strong bg-surface')
      assert.equal(P.DAYCARE_CARD_CLS.present, 'border-ok bg-ok-bg')
      assert.equal(P.DAYCARE_CARD_CLS.left, 'border-info bg-info-bg')
      assert.equal(P.DAYCARE_CARD_CLS.muted, 'border-border bg-surface2')
    })
    it('記号＋言葉＋時刻（時刻は1つ）: ○ 来所前 9:30〜／○ 予定外の来所／● 在席 9:32〜／✓ 帰宅 15:28／✕ 休み（理由）／－ 入院中', () => {
      const t = (r) => {
        const x = P.daycareStateTone(r)
        return [x.kind, x.mark, x.word, x.cardCls]
      }
      const { before, present, left, muted } = P.DAYCARE_CARD_CLS
      // 親の決定 2026-11-09: 6列のカードの幅で1行に収めるため、来所前は予定の始まりだけ・帰宅は帰宅の時刻だけ（一括の画面と同じ形）
      assert.deepEqual(t(row()), ['before', '○', '来所前 9:30〜', before])
      assert.deepEqual(t(row({ plans: [{ start: null, end: '15:30', bathing: false }] })), ['before', '○', '来所前', before], '始まりが読めない時は言葉だけ')
      assert.deepEqual(t(row({ planned: false, plans: [] })), ['unplanned', '○', '予定外の来所', before])
      assert.deepEqual(t(row({ state: 'present', attendance: att({ arrived_at: '09:32' }) })), ['present', '●', '在席 9:32〜', present])
      assert.deepEqual(t(row({ state: 'left', attendance: att({ arrived_at: '09:32', left_at: '15:28' }) })), ['left', '✓', '帰宅 15:28', left])
      assert.deepEqual(t(row({ state: 'absent', attendance: att({ absent: true, absent_reason: 'condition' }) })), ['absent', '✕', '休み（体調不良）', muted])
      assert.deepEqual(t(row({ state: 'absent', attendance: att({ absent: true }) })), ['absent', '✕', '休み（理由なし）', muted])
      assert.deepEqual(t(row({ hospitalized: true })), ['hospitalized', '－', '入院中', muted])
    })
    it('予定の誤り（dup・同じ日に2件）は今の文言のまま頭に ▲（まだ来ていない方）。来た方・休みの方は状態を出す', () => {
      assert.deepEqual(
        [P.daycareStateTone(row({ dup: true })).mark, P.daycareStateTone(row({ dup: true })).word],
        ['▲', '予定 要確認（週間計画にこの方の記録が2件あります）'],
      )
      const two = row({ plans: [{ start: '09:30', end: '12:00', bathing: false }, { start: '13:00', end: '15:30', bathing: false }] })
      assert.equal(P.daycareStateTone(two).word, '予定 要確認（週間計画にこの方の予定が同じ日に2件あります）')
      assert.equal(P.daycareStateTone(two).mark, '▲')
      assert.equal(P.daycareStateTone(row({ dup: true, state: 'present', attendance: att({ arrived_at: '10:05' }) })).word, '在席 10:05〜')
    })
  })

  describe('一括の画面の来た・まだ（daycareCameMark）', () => {
    it('○ 来所前／● 在席 9:32／✓ 帰宅 15:28。色は文字だけ（在席 text-ok・帰宅 text-info・来所前 text-ink2）', () => {
      assert.deepEqual(P.daycareCameMark(row()), { mark: '○', word: '来所前', textCls: 'text-ink2' })
      assert.deepEqual(P.daycareCameMark(row({ state: 'present', attendance: att({ arrived_at: '09:32' }) })), { mark: '●', word: '在席 9:32', textCls: 'text-ok' })
      assert.deepEqual(P.daycareCameMark(row({ state: 'left', attendance: att({ arrived_at: '09:32', left_at: '15:28' }) })), { mark: '✓', word: '帰宅 15:28', textCls: 'text-info' })
      assert.deepEqual(P.daycareCameMark(undefined), { mark: '○', word: '来所前', textCls: 'text-ink2' })
    })
    it('食事一括（withPlan）は来所前に予定の時刻を添える（予定が1件の時だけ。それまでの「未到着（予定 …）」の時刻を残す）', () => {
      assert.equal(P.daycareCameMark(row(), true).word, '来所前 9:30〜15:30')
      assert.equal(P.daycareCameMark(row({ dup: true }), true).word, '来所前')
      assert.equal(P.daycareCameMark(row({ planned: false, plans: [] }), true).word, '来所前')
      assert.equal(P.daycareCameMark(row({ state: 'present', attendance: att({ arrived_at: '09:32' }) }), true).word, '在席 9:32')
    })
  })

  describe('進み具合の印（daycareProgressMarks）', () => {
    const base = {
      state: 'present',
      hospitalized: false,
      vitals: { done: false, abnormal: false },
      lunch: null,
      activityCount: 0,
      training: false,
      bath: { kind: 'noPlan' },
    }
    const st = (over) => Object.fromEntries(P.daycareProgressMarks({ ...base, ...over }).map((m) => [m.key, m.state]))
    const rec = { id: 1 }
    it('5つの並びと札の文字（VS／食／活／訓／浴）・読み上げの名前', () => {
      const ms = P.daycareProgressMarks(base)
      assert.deepEqual(ms.map((m) => m.key), ['vitals', 'lunch', 'activity', 'training', 'bath'])
      assert.deepEqual(ms.map((m) => m.short), ['VS', '食', '活', '訓', '浴'])
      assert.deepEqual(ms.map((m) => m.label), ['バイタル', '昼食', '活動', '訓練', '入浴'])
      assert.deepEqual(P.PROGRESS_STATE_WORD, { done: '済', todo: '未', na: '対象外', check: '要確認', unread: '読み込めません' })
    })
    it('札の形（色だけに頼らない）: 塗り＝済・点線＝未・枠なし＝対象外・太枠＝要確認・細かい点線＝読めない', () => {
      assert.deepEqual(P.PROGRESS_MARK_CLS, {
        done: 'border border-ok bg-ok-bg font-bold text-ok',
        todo: 'border border-dashed border-ink2 text-ink',
        na: 'border border-transparent text-ink3',
        check: 'border-2 border-warn bg-warn-bg font-bold text-ink',
        unread: 'border border-dotted border-ink2 text-ink2',
      })
    })
    it('バイタル: 来ていない → 対象外・異常 → 要確認・測った → 済・ほか → 未', () => {
      assert.equal(st({}).vitals, 'todo')
      assert.equal(st({ state: 'left' }).vitals, 'todo')
      assert.equal(st({ vitals: { done: true, abnormal: false } }).vitals, 'done')
      assert.equal(st({ vitals: { done: true, abnormal: true } }).vitals, 'check')
      for (const s of ['planned', 'absent']) assert.equal(st({ state: s, vitals: { done: true, abnormal: true } }).vitals, 'na', s)
    })
    it('昼食: 来た → 拒食か主食・副食の両方 → 済・ほか → 未／来ていない → 入力済みなら済・ほか → 対象外', () => {
      const full = { main_amount: 5, side_amount: 8, status: 'eaten' }
      const half = { main_amount: 5, side_amount: null, status: 'eaten' }
      const refused = { main_amount: null, side_amount: null, status: 'refused' }
      assert.equal(st({ lunch: null }).lunch, 'todo')
      assert.equal(st({ lunch: half }).lunch, 'todo')
      assert.equal(st({ lunch: full }).lunch, 'done')
      assert.equal(st({ lunch: refused }).lunch, 'done')
      assert.equal(st({ state: 'planned', lunch: null }).lunch, 'na')
      assert.equal(st({ state: 'planned', lunch: half }).lunch, 'na')
      assert.equal(st({ state: 'planned', lunch: full }).lunch, 'done')
      assert.equal(st({ state: 'absent', lunch: refused }).lunch, 'done')
    })
    it('活動・訓練: 読めない → 読めない（来た・来ていないとも）・来た → 記録があれば済・ほか未／来ていない → 記録があれば済・ほか対象外', () => {
      assert.equal(st({ activityCount: null }).activity, 'unread')
      assert.equal(st({ state: 'planned', activityCount: null }).activity, 'unread')
      assert.equal(st({ activityCount: 0 }).activity, 'todo')
      assert.equal(st({ activityCount: 2 }).activity, 'done')
      assert.equal(st({ state: 'planned', activityCount: 0 }).activity, 'na')
      assert.equal(st({ state: 'absent', activityCount: 1 }).activity, 'done')
      assert.equal(st({ training: null }).training, 'unread')
      assert.equal(st({ state: 'absent', training: null }).training, 'unread')
      assert.equal(st({ training: false }).training, 'todo')
      assert.equal(st({ training: true }).training, 'done')
      assert.equal(st({ state: 'planned', training: false }).training, 'na')
      assert.equal(st({ state: 'planned', training: true }).training, 'done')
    })
    it('入浴: 休みに記録が残る → 要確認・予定なし → 対象外・記録あり（自動・中止も）→ 済・予定あり未記録 → 休み・入院中は対象外／ほか未', () => {
      assert.equal(st({ state: 'absent', bath: { kind: 'auto', record: rec } }).bath, 'check')
      assert.equal(st({ state: 'absent', bath: { kind: 'done', record: rec } }).bath, 'check')
      assert.equal(st({ state: 'absent', bath: { kind: 'notBathed', record: rec } }).bath, 'done', '休みの「中止（欠席）」は記録として済')
      assert.equal(st({ bath: { kind: 'noPlan' } }).bath, 'na')
      assert.equal(st({ state: 'planned', bath: { kind: 'noPlan' } }).bath, 'na')
      for (const k of ['auto', 'done', 'notBathed']) assert.equal(st({ bath: { kind: k, record: rec } }).bath, 'done', k)
      assert.equal(st({ bath: { kind: 'todo' } }).bath, 'todo')
      assert.equal(st({ state: 'planned', bath: { kind: 'todo' } }).bath, 'todo', 'まだ来ていない方も予定があれば未')
      assert.equal(st({ state: 'absent', bath: { kind: 'todo' } }).bath, 'na')
      assert.equal(st({ state: 'planned', hospitalized: true, bath: { kind: 'todo' } }).bath, 'na')
      assert.equal(st({ state: 'present', hospitalized: true, bath: { kind: 'todo' } }).bath, 'todo', '入院中の印は予定のままの方だけ')
    })
  })

  describe('未入力の数（attendedUnfilledCount・切り替えの数）', () => {
    it('在席・帰宅の方だけ数える・まだ来ていない方（予定・休み）は別に数える', () => {
      assert.deepEqual(
        P.attendedUnfilledCount([
          { state: 'present', filled: false },
          { state: 'left', filled: false },
          { state: 'present', filled: true },
          { state: 'planned', filled: false },
          { state: 'planned', filled: true },
        ]),
        { unfilled: 2, notArrived: 2 },
      )
      assert.deepEqual(P.attendedUnfilledCount([]), { unfilled: 0, notArrived: 0 })
    })
    it('昼食の入力済み（lunchFilled）は lunchUnfilledCount と同じ考え（拒食は入力済み・片方でも null は未入力）', () => {
      assert.equal(P.lunchFilled(null), false)
      assert.equal(P.lunchFilled({ main_amount: 0, side_amount: 0, status: 'eaten' }), true)
      assert.equal(P.lunchFilled({ main_amount: 5, side_amount: null, status: null }), false)
      assert.equal(P.lunchFilled({ main_amount: null, side_amount: null, status: 'refused' }), true)
    })
    it('各画面の入力済み: バイタル＝どれかの回のどれかの欄に値／活動＝どれかの枠に記録（取り消しの送信待ちは除く）／訓練＝記録か送信待ちの追加', () => {
      assert.equal(P.vitalSlotsFilled([]), false)
      assert.equal(P.vitalSlotsFilled([[null, null, null, null, null]]), false)
      assert.equal(P.vitalSlotsFilled([[null, null], [null, 36.5]]), true)
      assert.equal(P.vitalSlotsFilled([[0, null]]), true, '0 も値')
      assert.equal(P.activityCellsFilled([{ shown: null, deleting: false }]), false)
      assert.equal(P.activityCellsFilled([{ shown: null, deleting: false }, { shown: 'full', deleting: false }]), true)
      assert.equal(P.activityCellsFilled([{ shown: 'full', deleting: true }]), false)
      const s = [{ resident_id: 3, day: '2026-11-09' }]
      assert.equal(P.trainingFilled(s, [], 3, '2026-11-09'), true)
      assert.equal(P.trainingFilled(s, [], 3, '2026-11-08'), false)
      assert.equal(P.trainingFilled([], [{ kind: 'add', table: 'daycare_training_sessions', residentId: 4, day: '2026-11-09', stopped: true }], 4, '2026-11-09'), true)
      assert.equal(P.trainingFilled([], [{ kind: 'add', table: 'daycare_staffing', day: '2026-11-09', staffId: 4, stopped: false }], 4, '2026-11-09'), false)
      assert.equal(P.trainingFilled([], [{ kind: 'update', table: 'daycare_training_sessions', rowId: 4, deleted: false, stopped: false }], 4, '2026-11-09'), false)
    })
    it('切り替えの数（daycareNavPending）: 来た方で印が「未」の数だけ・読めない印は数えない・0 は入れない', () => {
      const base = { hospitalized: false, vitals: { done: false, abnormal: false }, lunch: null, activityCount: 0, training: null, bath: { kind: 'todo' } }
      const rows = [
        { state: 'present', marks: P.daycareProgressMarks({ ...base, state: 'present' }) },
        { state: 'left', marks: P.daycareProgressMarks({ ...base, state: 'left', vitals: { done: true, abnormal: false }, activityCount: 1 }) },
        { state: 'planned', marks: P.daycareProgressMarks({ ...base, state: 'planned' }) },
      ]
      assert.deepEqual(P.daycareNavPending(rows), { vitals: 1, meals: 2, activity: 1 })
      assert.deepEqual(P.daycareNavPending([]), {})
      assert.equal(P.navPendingOf(undefined, 'vitals'), null)
      assert.equal(P.navPendingOf({ vitals: 0 }, 'vitals'), null)
      assert.equal(P.navPendingOf({ vitals: 1.5 }, 'vitals'), null)
      assert.equal(P.navPendingOf({ vitals: 5 }, 'vitals'), 5)
      assert.equal(P.navPendingOf({ vitals: 5 }, 'today'), null)
    })
  })
}

describe('静的検査（計画B）', () => {
  const today = code('../src/pages/DaycarePage.tsx')
  const list = today.slice(today.indexOf('<ul className="dc-cards"'), today.indexOf('</ul>', today.indexOf('<ul className="dc-cards"')))
  const nav = today.slice(today.indexOf('export function DaycareNav'), today.indexOf('function PlanBanners'))
  const BULK = {
    vitals: code('../src/pages/DaycareVitalsPage.tsx'),
    activity: code('../src/pages/DaycareActivityBulkPage.tsx'),
    training: code('../src/pages/DaycareTrainingPage.tsx'),
    meals: code('../src/pages/DaycareMealsPage.tsx'),
  }

  it('カードは4段（氏名と〔休み〕→ ふりがな → 状態の段 → 進み具合の印）・ふりがなは〔休み〕の横に無い・文字の段（入浴 {bathText}）は無い', () => {
    const iName = list.indexOf('<Link to={personPath(row.residentId, day, today)}')
    const iRest = list.indexOf('ops.onRest(row)')
    const iKana = list.indexOf('{kana}</p>')
    const iState = list.indexOf('{tone.word}')
    const iMarks = list.indexOf('{marks.map((mk) => (')
    const iPending = list.indexOf('未送信の記録があります')
    assert.ok(iName > 0 && iName < iRest && iRest < iKana && iKana < iState && iState < iMarks && iMarks < iPending, '段の順')
    // 氏名の箱（min-w-[5em] flex-1）の中にふりがなを置かない
    const nameBox = list.slice(list.indexOf('<div className="min-w-[5em] flex-1">'), list.indexOf('</div>', list.indexOf('<div className="min-w-[5em] flex-1">')))
    assert.doesNotMatch(nameBox, /kana/)
    assert.doesNotMatch(list, /入浴 \{bathText\}|planText|到着 <span|bathText|lunchShortLabel/)
    // 段の間はあけない（カードの li に gap・space-y を付けない）・上下の余白 py-1.5・枠 1px は今のまま
    assert.match(list, /<li key=\{row\.residentId\} className=\{`dc-card relative flex min-w-0 flex-col rounded-lg border px-1\.5 py-1\.5 \$\{tone\.cardCls\}`\}>/)
    // 状態の段は text-sm 太字 leading-tight・記号は読み上げない
    assert.match(list, /<p className="break-words text-sm font-bold leading-tight text-ink">\s*<span aria-hidden="true">\{tone\.mark\} <\/span>\s*\{tone\.word\}\s*<\/p>/)
    // 氏名は text-ink（休みの方も）
    assert.match(list, /<span className="block break-words text-base font-bold leading-tight text-ink">/)
  })
  it('進み具合の印は押せない表示（button・a・Link・onClick でない）。読み上げの言葉（sr-only）と title を持つ', () => {
    const marks = list.slice(list.indexOf('{marks.map((mk) => ('), list.indexOf('{pending ? ('))
    assert.ok(marks.length > 100)
    assert.doesNotMatch(marks, /<button|<a\b|<Link|onClick|role="button"|tabIndex/)
    assert.match(marks, /title=\{`\$\{mk\.label\}: \$\{PROGRESS_STATE_WORD\[mk\.state\]\}`\}/)
    assert.match(marks, /<span aria-hidden="true">\{mk\.short\}<\/span>\s*<span className="sr-only">\s*\{mk\.label\} \{PROGRESS_STATE_WORD\[mk\.state\]\}\s*<\/span>/)
    assert.match(list, /<p className="flex flex-wrap gap-1">\s*\{marks\.map\(\(mk\) => \(/)
    // カードのボタンは今までどおり2つ（〔休み〕〔取消〕）だけ
    assert.equal((list.match(/<button/g) ?? []).length, 2)
  })
  it('印の説明は一覧の下（〔＋ 予定にない方を追加〕の横）に1行。上の段には足さない', () => {
    const legend = '印: VS バイタル・食 昼食・活 活動・訓 訓練・浴 入浴（塗り＝済・点線＝未・枠なし＝対象外・太枠＝要確認）'
    assert.equal(today.split(legend).length, 2, '1か所だけ')
    assert.ok(today.indexOf(legend) > today.indexOf('＋ 予定にない方を追加'))
    assert.match(today, new RegExp(`<p className="text-sm text-ink2">${legend.replace(/[()（）]/g, '.')}</p>`))
    const header = today.slice(today.indexOf('const header = (counts'), today.indexOf('if (loading && data === null)'))
    assert.doesNotMatch(header, /VS バイタル/)
  })
  it('今日の画面は機能訓練の記録を1日の読み込みで読み（読めない時は null）、送信待ちの追加も印に入れる', () => {
    assert.match(today, /fetchTrainingSessions\(target\)\.catch\(\(\): DaycareTrainingSession\[\] \| null => null\)/)
    assert.match(today, /training: trainingRead === null \? null : trainingFilled\(trainingRead, trainingPending, id, data\.day\)/)
    assert.match(today, /const trainingPending = trainingRead === null \? \[\] : pendingTrainingOps\(\)/)
    assert.match(today, /activityCount: data\.activities === null \? null : data\.activities\.filter\(\(x\) => x\.resident_id === id && x\.day === data\.day\)\.length/)
    assert.match(today, /const navPending = daycareNavPending\(board\.rows\.map/)
  })
  it('DaycareNav: 省略できる pending（今日の画面だけ渡す）・0 は出さない（navPendingOf）・「未5」＋読み上げ「（未入力 5名）」・44px のまま', () => {
    assert.match(nav, /pending\?: DaycareNavPending/)
    assert.match(nav, /\{navPendingOf\(pending, it\.key\) !== null \? \(/)
    assert.match(nav, /<span aria-hidden="true" className="ml-1 rounded bg-danger-bg px-1 font-bold text-danger">\s*未\{navPendingOf\(pending, it\.key\)\}\s*<\/span>\s*<span className="sr-only">（未入力 \{navPendingOf\(pending, it\.key\)\}名）<\/span>/)
    // 押せる高さ 44px（今いる画面・ほかの画面とも）。aria-label で名前を上書きしない（見えている名前から読む）
    assert.match(nav, /'flex min-h-tap items-center rounded border border-primary bg-primary px-3 text-sm font-bold text-primary-ink'/)
    assert.match(nav, /const navCls = 'flex min-h-tap items-center /)
    assert.doesNotMatch(nav.slice(nav.indexOf('<Link'), nav.indexOf('</Link>')), /aria-label/)
    // 今日の画面だけ渡す（ほかの画面は今のまま）
    assert.match(today, /<DaycareNav current="today" handoff=\{[^\n]*\} pending=\{navPending\} \/>/)
    for (const [k, p] of Object.entries(BULK)) assert.doesNotMatch(p, /<DaycareNav[^\n]*pending=/, k)
  })
  it('一括の4画面: 未入力の数は同じ部品（DaycareUnfilledCount）・新しい段を足さない場所に置く', () => {
    // バイタル一括: 日付と「表示する方」の段の右
    const v = BULK.vitals
    assert.ok(v.indexOf('aria-label="表示する方"') < v.indexOf('<DaycareUnfilledCount counts={unfilled} />'))
    assert.match(v, /<\/div>\s*(\{\}\s*)?\{countRows\.length > 0 \? <DaycareUnfilledCount counts=\{unfilled\} \/> : null\}\s*<\/div>\s*\{releasing \? \(/)
    assert.match(v, /const countRows = board === null \|\| data === null \|\| data\.day !== day \? \[\] : daycareBulkRows\(board\.rows\)/)
    assert.match(v, /filled: vitalSlotsFilled\(slotsOf\(r\.residentId\)\.map\(\(slot\) => DAYCARE_VITAL_FIELDS\.map\(\(f\) => valueOf\(slot, f\)\.v\)\)\)/)
    // 活動一括: 見出しの段（読めない時は出さない）
    const a = BULK.activity
    assert.match(a, /<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">\s*<h2 id="h-bulk" className="text-lg font-bold leading-tight text-ink">\s*活動一括\s*<\/h2>\s*\{readable && targets\.length > 0 \? <DaycareUnfilledCount counts=\{unfilled\} \/> : null\}\s*<\/div>/)
    assert.match(a, /filled: activityCellsFilled\(\[\.\.\.DAYCARE_ACTIVITY_CHIPS, \.\.\.otherLabelsOf\(rid\)\]\.map\(\(l\) => cellOf\(rid, l\)\)\)/)
    // 機能訓練: 見出し「今日の対象者」の段（読めない時は出さない）
    const t = BULK.training
    assert.match(t, /<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">\s*<h2 id="h-targets" className="text-lg font-bold leading-tight text-ink">\s*\{day === today \? '今日' : 'この日'\}の対象者\s*<\/h2>\s*\{data\.sessions !== null && targets\.length > 0 \? <DaycareUnfilledCount counts=\{unfilled\} \/> : null\}\s*<\/div>/)
    assert.match(t, /filled: trainingFilled\(sessions, pending, rid, day\)/)
    // 食事一括: 今のまま（見出し「昼食」の段）・数え方も今のまま
    const m = BULK.meals
    const top = m.slice(m.indexOf('<section aria-labelledby="h-meals"'), m.indexOf('<table'))
    assert.ok(top.indexOf('id="h-meals"') < top.indexOf('<DaycareUnfilledCount counts={counts} />'))
    for (const [k, p] of Object.entries(BULK)) {
      assert.match(p, /import \{ DaycareUnfilledCount \} from '\.\.\/components\/DaycareUnfilledCount'/, k)
      assert.equal((p.match(/<DaycareUnfilledCount /g) ?? []).length, 1, `${k}: 1か所だけ`)
    }
    // 4画面とも数えるのは在席・帰宅の方だけ（attendedUnfilledCount。食事一括は lunchUnfilledCount がこれを使う）
    for (const k of ['vitals', 'activity', 'training']) assert.match(BULK[k], /attendedUnfilledCount\(/, k)
    assert.match(read('../src/lib/daycarePerson.ts'), /return attendedUnfilledCount\(rows\.map\(\(r\) => \(\{ state: r\.state, filled: lunchFilled\(r\.lunch\) \}\)\)\)/)
  })
  it('状態をそろえる: 食事一括・活動一括の来た・まだは daycareCameMark（記号は読み上げない・色は文字だけ）', () => {
    assert.match(BULK.meals, /const cm = daycareCameMark\(row, true\)/)
    assert.match(BULK.activity, /const cm = daycareCameMark\(rowOf\(rid\)\)/)
    for (const k of ['meals', 'activity']) {
      assert.match(BULK[k], /<span className=\{`text-sm leading-tight \$\{cm\.textCls\}`\}>\s*<span aria-hidden="true">\{cm\.mark\} <\/span>\s*\{cm\.word\}\s*<\/span>/, k)
      assert.doesNotMatch(BULK[k], /（未到着）|cameText/, k)
    }
  })
  it('機能訓練の区画の並び: 上の段 → 今日の対象者の表 → 対象者でない方の記録 → その日の配置 → 計画の見直しの期限 → 居宅訪問の期限', () => {
    const t = BULK.training
    const body = t.slice(t.indexOf('<div className="mx-auto w-full max-w-6xl space-y-2">\n      {header}\n\n'))
    const order = [
      '{header}',
      'aria-labelledby="h-targets"',
      '<table className="w-full min-w-max border-collapse text-base">',
      '{outside.length > 0 ? (',
      'aria-labelledby="h-staffing"',
      '<DaycareReviewDueSection',
      '<DaycareHomeVisitSection',
      '<ModalShell open={ed !== null}',
    ].map((x) => body.indexOf(x))
    assert.ok(order.every((x) => x >= 0), JSON.stringify(order))
    for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] < order[i], `並び ${i}`)
    // 配置の注意を対象者の上に足さない
    const above = body.slice(0, body.indexOf('aria-labelledby="h-targets"'))
    assert.doesNotMatch(above, /機能訓練指導員の配置が記録されていません/)
  })
  it('色はトークンだけ（任意値を足さない）・氏名と記録を localStorage・console に出さない', () => {
    const files = ['../src/lib/daycareProgress.ts', '../src/components/DaycareUnfilledCount.tsx']
    for (const f of files) {
      const c = code(f)
      assert.doesNotMatch(c, /\b(text|bg|border|w|h|min-w|min-h|p[xy]?|m[xy]?|gap)-\[/, f)
      assert.doesNotMatch(c, /localStorage|sessionStorage|console\./, f)
    }
    assert.doesNotMatch(list, /\b(text|bg|border)-\[/)
    assert.doesNotMatch(code('../src/lib/daycareProgress.ts'), /from '\.\/db/, '純ロジックは db.ts を読まない')
  })
})
