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
    it('予定の誤り（dup・同じ日に2件）はどの状態でも出す（反証 中3）: まだ来ていない方は状態の段（頭に ▲）・ほかは状態の段の下に1行', () => {
      const DUP = '予定 要確認（週間計画にこの方の記録が2件あります）'
      const TWO = '予定 要確認（週間計画にこの方の予定が同じ日に2件あります）'
      const twoPlans = [{ start: '09:30', end: '12:00', bathing: false }, { start: '13:00', end: '15:30', bathing: false }]
      const w = (r) => {
        const x = P.daycareStateTone(r)
        return [x.kind, x.mark, x.word, x.planWarn]
      }
      assert.deepEqual(w(row({ dup: true })), ['planError', '▲', DUP, null])
      assert.deepEqual(w(row({ plans: twoPlans })), ['planError', '▲', TWO, null])
      assert.deepEqual(w(row({ dup: true, state: 'present', attendance: att({ arrived_at: '10:05' }) })), ['present', '●', '在席 10:05〜', DUP])
      assert.deepEqual(w(row({ plans: twoPlans, state: 'left', attendance: att({ arrived_at: '10:05', left_at: '15:10' }) })), ['left', '✓', '帰宅 15:10', TWO])
      assert.deepEqual(w(row({ dup: true, state: 'absent', attendance: att({ absent: true, absent_reason: 'wish' }) })), ['absent', '✕', '休み（本人の希望）', DUP])
      assert.deepEqual(w(row({ dup: true, hospitalized: true })), ['hospitalized', '－', '入院中', DUP])
      // 誤りが無い方は1行足さない
      for (const r of [row(), row({ state: 'present', attendance: att({ arrived_at: '09:00' }) }), row({ state: 'absent', attendance: att({ absent: true }) })]) {
        assert.equal(P.daycareStateTone(r).planWarn, null)
      }
      assert.equal(P.daycarePlanWarning({ dup: false, plans: [] }), null)
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
      lunchRead: true,
      activity: false,
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
    it('札の形（色だけに頼らない）: 実線＝済・点線＝未・枠なし＝対象外・太枠＝要確認・細い点線＝読めない', () => {
      // 2026-11-09 反証 軽3（固定し直し・意図は同じ）: 済の地は bg-surface（在席のカードの地 bg-ok-bg と同じ色にしない）
      assert.deepEqual(P.PROGRESS_MARK_CLS, {
        done: 'border border-ok bg-surface font-bold text-ok',
        todo: 'border border-dashed border-ink2 text-ink',
        na: 'border border-transparent text-ink3',
        check: 'border-2 border-warn bg-warn-bg font-bold text-ink',
        unread: 'border border-dotted border-ink2 text-ink2',
      })
      // 親の決定 2026-11-09: 「?」はやめた（札の文字はどの状態も同じ）。読めない項目は一覧の上の1行の知らせで名前を出す
      assert.equal(P.progressMarkText, undefined)
    })
    it('読めなかった項目の知らせ（unreadProgressLabels・unreadProgressNotice）: 名前だけを印の順に並べる・無ければ出さない', () => {
      const ok = { vitalsOk: true, intakeOk: true, activitiesOk: true, trainingOk: true, bathsOk: true }
      assert.deepEqual(P.unreadProgressLabels(ok), [])
      assert.equal(P.unreadProgressNotice([]), null)
      assert.deepEqual(P.unreadProgressLabels({ ...ok, activitiesOk: false, trainingOk: false }), ['活動', '機能訓練'])
      assert.equal(
        P.unreadProgressNotice(P.unreadProgressLabels({ ...ok, activitiesOk: false, trainingOk: false })),
        '活動・機能訓練の記録を読み込めませんでした（印は細い点線）。通信状態を確認して、〔最新に更新〕を押してください。',
      )
      assert.deepEqual(
        P.unreadProgressLabels({ vitalsOk: false, intakeOk: false, activitiesOk: false, trainingOk: false, bathsOk: false }),
        ['バイタル', '昼食', '活動', '機能訓練', '入浴'],
      )
    })
    it('バイタル: 異常 → 要確認・測った → 済（来ていない方でも値があれば＝反証 中4）・値が無い → 来た方は未・ほかは対象外・読めない → 読めない', () => {
      assert.equal(st({}).vitals, 'todo')
      assert.equal(st({ state: 'left' }).vitals, 'todo')
      assert.equal(st({ vitals: { done: true, abnormal: false } }).vitals, 'done')
      assert.equal(st({ vitals: { done: true, abnormal: true } }).vitals, 'check')
      // 2026-11-09 反証 中4（固定し直し・意図は同じ）: 来ていない方も、値がある時は 異常→要確認・測った→済（値が無い時だけ対象外）
      for (const s of ['planned', 'absent']) {
        assert.equal(st({ state: s, vitals: { done: true, abnormal: true } }).vitals, 'check', s)
        assert.equal(st({ state: s, vitals: { done: true, abnormal: false } }).vitals, 'done', s)
        assert.equal(st({ state: s, vitals: { done: false, abnormal: false } }).vitals, 'na', s)
      }
      // 反証 中6: 読めない時は「未」に見せない
      assert.equal(st({ vitals: null }).vitals, 'unread')
      assert.equal(st({ state: 'planned', vitals: null }).vitals, 'unread')
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
      // 反証 中6: 昼食を読めない（intakeOk=false）時は「読めない」
      assert.equal(st({ lunchRead: false, lunch: null }).lunch, 'unread')
      assert.equal(st({ lunchRead: false, state: 'planned' }).lunch, 'unread')
    })
    it('活動・訓練: 読めない → 読めない（来た・来ていないとも）・来た → 記録があれば済・ほか未／来ていない → 記録があれば済・ほか対象外', () => {
      // 2026-11-09 反証 中1（固定し直し・意図は同じ）: 活動は数でなく「記録がある」（送信待ちを重ねた値＝activityShownCells）で渡す
      assert.equal(st({ activity: null }).activity, 'unread')
      assert.equal(st({ state: 'planned', activity: null }).activity, 'unread')
      assert.equal(st({ activity: false }).activity, 'todo')
      assert.equal(st({ activity: true }).activity, 'done')
      assert.equal(st({ state: 'planned', activity: false }).activity, 'na')
      assert.equal(st({ state: 'absent', activity: true }).activity, 'done')
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
      // 反証 中6: 入浴を読めない時は「読めない」（休みの方も）
      assert.equal(st({ bath: null }).bath, 'unread')
      assert.equal(st({ state: 'absent', bath: null }).bath, 'unread')
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
      // 2026-11-09 計画B2（固定し直し・仕様の変更で数え方を変えた）: 一括の画面の「未入力 n名」の n と同じ数え方（到着を問わず、
      // 1人ずつの空の欄の数＝vitalBlankFields・lunchBlankFields・recordBlankFields から、空の欄がある方の数）。読めない項目（null）は数を出さない・0 は入れない
      const blanks = {
        // 在席で未測定（5欄）・帰宅で全部（0欄）・来所前で体温だけ（4欄）＝3名中2名
        vitals: [P.vitalBlankFields(null), P.vitalBlankFields({ temp: 36.5, sys_bp: 120, dia_bp: 70, pulse: 70, spo2: 97 }), P.vitalBlankFields({ temp: 36.5 })],
        meals: [P.lunchBlankFields(null), P.lunchBlankFields(null), P.lunchBlankFields({ main_amount: null, side_amount: null, status: 'refused' })],
        activity: [P.recordBlankFields(false), P.recordBlankFields(true), P.recordBlankFields(false)],
        training: [0, 0, 0],
      }
      assert.deepEqual(P.daycareNavPending(blanks), { vitals: 2, meals: 2, activity: 2 })
      // 反証 中6: 読めない項目（バイタル・昼食・活動・訓練）は数を出さない
      assert.deepEqual(P.daycareNavPending({ vitals: null, meals: null, activity: null, training: null }), {})
      assert.deepEqual(P.daycareNavPending({ vitals: [], meals: [], activity: [], training: [] }), {})
      assert.equal(P.navPendingOf(undefined, 'vitals'), null)
      assert.equal(P.navPendingOf({ vitals: 0 }, 'vitals'), null)
      assert.equal(P.navPendingOf({ vitals: 1.5 }, 'vitals'), null)
      assert.equal(P.navPendingOf({ vitals: 5 }, 'vitals'), 5)
      assert.equal(P.navPendingOf({ vitals: 5 }, 'today'), null)
    })
  })

  describe('送信待ちの重ね（今日の画面と一括の画面で同じ純関数・反証 中1）', () => {
    it('昼食（lunchShownWith＝食事一括の mealShownFor）: 送っている途中の値だけ重ねる・止まった値（食い違い）・拒まれた値は重ねない・順番待ちが先', () => {
      const cur = { main_amount: null, side_amount: null, status: 'eaten' }
      assert.equal(P.lunchShownWith(cur, null), cur)
      assert.equal(P.lunchShownWith(null, null), null)
      assert.deepEqual(P.lunchShownWith(cur, { state: 'pending', values: { main_amount: 8 } }), { main_amount: 8, side_amount: null, status: 'eaten' })
      assert.deepEqual(P.lunchShownWith(null, { state: 'pending', values: { status: 'refused' } }), { main_amount: null, side_amount: null, status: 'refused' })
      for (const state of ['conflict', 'rejected']) assert.equal(P.lunchShownWith(cur, { state, values: { main_amount: 8, side_amount: 8 } }), cur, state)
      // 順番待ち（後に押した方）→ 送信待ち → サーバー
      assert.deepEqual(
        P.lunchShownWith(cur, { state: 'pending', values: { main_amount: 8, side_amount: 6 } }, [{ values: { main_amount: 3 } }, { values: { main_amount: 5 } }]),
        { main_amount: 5, side_amount: 6, status: 'eaten' },
      )
      // 今日の画面でも同じ決まりで入力済みになる（送信待ちの主食・副食がそろえば済）
      assert.equal(P.lunchFilled(P.lunchShownWith(null, { state: 'pending', values: { main_amount: 8, side_amount: 7 } })), true)
      assert.equal(P.lunchFilled(P.lunchShownWith(null, { state: 'conflict', values: { main_amount: 8, side_amount: 7 } })), false)
    })
    it('バイタル（daycareVitalSlotsWithPending・vitalShownValue＝バイタル一括の slotsOf・valueOf）: 送信待ちにだけある回も出す・送信待ちの値はどの状態でも重ねる', () => {
      const D = '2026-11-09'
      const live = [{ id: 11, resident_id: 7, client_key: `dc:${D}:7:1`, temp: 36.5, sys_bp: null, dia_bp: null, pulse: null, spo2: null }]
      const keys = live.map((v) => v.client_key)
      const pend = new Set([`dc:${D}:7:2`])
      const slots = P.daycareVitalSlotsWithPending(live, keys, 7, D, [], (k) => pend.has(k))
      assert.deepEqual(slots.map((x) => [x.seq, x.vital?.id ?? null]), [[1, 11], [2, null]])
      // 送信待ちが無い方は1回分の空の回（バイタル一括と同じ）
      assert.deepEqual(P.daycareVitalSlotsWithPending([], [], 8, D, [], () => false).map((x) => x.seq), [1])
      assert.deepEqual(P.vitalShownValue(null, live[0], 'temp'), { v: 36.5, local: false })
      assert.deepEqual(P.vitalShownValue({ values: { temp: 37.9 } }, live[0], 'temp'), { v: 37.9, local: true })
      assert.deepEqual(P.vitalShownValue({ values: { temp: null } }, live[0], 'temp'), { v: null, local: true }, '送信待ちで消した値は空')
      assert.deepEqual(P.vitalShownValue({ values: { temp: 'x' } }, null, 'temp'), { v: null, local: true }, '数でない値は信じない')
      assert.deepEqual(P.vitalShownValues({ values: { dia_bp: 70 } }, null), { temp: null, sys_bp: null, dia_bp: 70, pulse: null, spo2: null })
      // 血圧の下だけでも測った（反証 軽4）
      assert.equal(P.vitalSlotsFilled([Object.values(P.vitalShownValues({ values: { dia_bp: 70 } }, null))]), true)
    })
    it('活動（activityShownCells＝活動一括の cellOf と同じ重ね方）: 止まっていない変更・取り消しを重ねる・止まった変更は重ねない・追加は止まっていても出す', () => {
      const D = '2026-11-09'
      const rows = [
        { id: 1, resident_id: 5, day: D, label: '体操', participation: 'full' },
        { id: 2, resident_id: 5, day: D, label: '歌', participation: 'partial' },
        { id: 3, resident_id: 6, day: D, label: '体操', participation: 'full' },
      ]
      const shown = (pending, rid = 5) => Object.fromEntries(P.activityShownCells(rows, pending, rid, D).map((c) => [c.label, [c.shown, c.deleting]]))
      assert.deepEqual(shown([]), { 体操: ['full', false], 歌: ['partial', false] })
      // 止まっていない度合いの変更は重ねる・止まった変更は重ねない（サーバーの値）
      assert.deepEqual(shown([{ kind: 'update', rowId: 1, participation: 'observed', deleted: false, stopped: false }]).体操, ['observed', false])
      assert.deepEqual(shown([{ kind: 'update', rowId: 1, participation: 'observed', deleted: false, stopped: true }]).体操, ['full', false])
      // 止まっていない取り消しは「取り消しの送信待ち」（入力済みに数えない）・止まった取り消しは重ねない
      assert.deepEqual(shown([{ kind: 'update', rowId: 1, participation: null, deleted: true, stopped: false }]).体操, ['full', true])
      assert.deepEqual(shown([{ kind: 'update', rowId: 1, participation: null, deleted: true, stopped: true }]).体操, ['full', false])
      // 取り消しの後に入れ直した送信待ちの追加は、その度合い
      assert.deepEqual(
        shown([
          { kind: 'update', rowId: 1, participation: null, deleted: true, stopped: false },
          { kind: 'add', residentId: 5, day: D, label: '体操', participation: 'partial', stopped: false },
        ]).体操,
        ['partial', false],
      )
      // サーバーに無い項目の追加は、止まっていない方 → 止まった方。別の方・別の日の追加は入れない
      assert.deepEqual(shown([{ kind: 'add', residentId: 5, day: D, label: '散歩', participation: 'full', stopped: true }]).散歩, ['full', false])
      assert.deepEqual(P.activityShownCells([], [{ kind: 'add', residentId: 9, day: D, label: '散歩', participation: 'full', stopped: false }], 5, D), [])
      assert.deepEqual(P.activityShownCells([], [{ kind: 'add', residentId: 5, day: '2026-11-08', label: '散歩', participation: 'full', stopped: false }], 5, D), [])
      // 入力済み: 全部の枠が取り消しの送信待ちなら未
      assert.equal(P.activityCellsFilled(P.activityShownCells(rows, [], 6, D)), true)
      assert.equal(P.activityCellsFilled(P.activityShownCells(rows, [{ kind: 'update', rowId: 3, participation: null, deleted: true, stopped: false }], 6, D)), false)
      assert.equal(P.activityCellsFilled(P.activityShownCells(rows, [{ kind: 'add', residentId: 7, day: D, label: '歌', participation: 'full', stopped: false }], 7, D)), true)
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
    // 予定の誤りは、来た方・休みの方・入院中の方でも状態の段の下に1行（反証 中3）。印の段より上
    assert.ok(iState < list.indexOf('{tone.planWarn}') && list.indexOf('{tone.planWarn}') < iMarks)
  })
  it('進み具合の印は押せない表示（button・a・Link・onClick でない）。読み上げの言葉（sr-only）と title を持つ', () => {
    const marks = list.slice(list.indexOf('{marks.map((mk) => ('), list.indexOf('{pending ? ('))
    assert.ok(marks.length > 100)
    assert.doesNotMatch(marks, /<button|<a\b|<Link|onClick|role="button"|tabIndex/)
    assert.match(marks, /title=\{`\$\{mk\.label\}: \$\{PROGRESS_STATE_WORD\[mk\.state\]\}`\}/)
    // 札の文字はどの状態も同じ（VS・食・活・訓・浴。読めない札は細い点線だけ＝親の決定 2026-11-09）
    assert.match(marks, /<span aria-hidden="true">\{mk\.short\}<\/span>\s*<span className="sr-only">\s*\{mk\.label\} \{PROGRESS_STATE_WORD\[mk\.state\]\}\s*<\/span>/)
    assert.doesNotMatch(today, /progressMarkText/)
    assert.match(list, /<p className="flex flex-wrap gap-1">\s*\{marks\.map\(\(mk\) => \(/)
    // カードのボタンは今までどおり2つ（〔休み〕〔取消〕）だけ
    assert.equal((list.match(/<button/g) ?? []).length, 2)
  })
  it('印の説明は一覧の下（〔＋ 予定にない方を追加〕の横）に1行。上の段には足さない', () => {
    // 2026-11-09 反証 軽2・軽3（固定し直し・意図は同じ）: 済は「実線」（地を塗らない）・「細い点線＝読めない」を足した
    const legend = '印: VS バイタル・食 昼食・活 活動・訓 訓練・浴 入浴（実線＝済・点線＝未・枠なし＝対象外・太枠＝要確認・細い点線＝読めない）'
    assert.equal(today.split(legend).length, 2, '1か所だけ')
    assert.ok(today.indexOf(legend) > today.indexOf('＋ 予定にない方を追加'))
    assert.match(today, new RegExp(`<p className="text-sm text-ink2">${legend.replace(/[()（）?]/g, '.')}</p>`))
    const header = today.slice(today.indexOf('const header = (counts'), today.indexOf('if (loading && data === null)'))
    assert.doesNotMatch(header, /VS バイタル/)
  })
  it('今日の画面は機能訓練の記録を1日の読み込みで読み（読めない時は null）、送信待ちの追加も印に入れる', () => {
    assert.match(today, /fetchTrainingSessions\(target\)\.catch\(\(\): DaycareTrainingSession\[\] \| null => null\)/)
    assert.match(today, /training: trainingRead === null \? null : trainingFilled\(trainingRead, trainingPending, id, data\.day\)/)
    assert.match(today, /const trainingPending = trainingRead === null \? \[\] : pendingTrainingOps\(\)/)
    // 購読は増やさない（機能訓練の変更は購読しない＝親の決定）
    assert.doesNotMatch(today, /subscribeDaycareTrainingChanges/)
  })
  it('今日の画面の印と切り替えの数は送信待ちを一括の画面と同じ純関数で重ねる（反証 中1）・読めない項目は「読めない」（中6）', () => {
    // 昼食: 食事一括の mealShownFor と同じ lunchShownWith（送っている途中の値だけ）
    assert.match(today, /lunch: lunchShownWith\(lunchOf\(id\), pendingRow\('meals', \{ residentId: id, day: data\.day, slot: 'lunch' \}\)\)/)
    assert.match(BULK.meals, /lunchShownWith\(mealRowFor\(t\)\?\.meal \?\? null, pendingRow\('meals', t\), waiting\[mealKeyOf\(t\)\] \?\? \[\]\)/)
    // バイタル: バイタル一括の slotsOf・valueOf と同じ daycareVitalSlotsWithPending・vitalShownValue(s)
    assert.match(today, /daycareVitalSlotsWithPending\(vitalsOf\(id\), vitalKeys, id, data\.day, \[\], \(key\) => pendingRow\('vitals', vitalTarget\(id, key\)\) !== null\)/)
    assert.match(today, /vals: vitalShownValues\(pendingRow\('vitals', vitalTarget\(id, slot\.key\)\), slot\.vital\)/)
    assert.match(BULK.vitals, /return daycareVitalSlotsWithPending\(\s*data\.live,\s*data\.keys,\s*residentId,\s*data\.day,\s*extraSeqs\.get\(residentId\) \?\? \[\],/)
    assert.match(BULK.vitals, /return vitalShownValue\(pendingRow\('vitals', targetOf\(slot\)\), slot\.vital, f\)/)
    // 血圧の下も「測った」に入れる（反証 軽4）＝5つの欄（DAYCARE_VITAL_FIELDS）のどれか
    assert.match(today, /const vitalsDone = \(id: number\) => vitalSlotsFilled\(\(vitalShown\.get\(id\) \?\? \[\]\)\.map\(\(s\) => DAYCARE_VITAL_FIELDS\.map\(\(f\) => s\.vals\[f\]\)\)\)/)
    assert.doesNotMatch(today, /v\.temp !== null \|\| v\.sys_bp !== null/)
    // 活動: 活動一括の数と同じ activityShownCells（枠の cellOf と同じ重ね方）
    assert.match(today, /activity: activityRead === null \? null : activityCellsFilled\(activityShownCells\(activityRead, activityPending, id, data\.day\)\)/)
    assert.match(today, /const activityPending = activityRead === null \? \[\] : pendingActivityOps\(\)/)
    // 2026-11-09 計画B2（固定し直し・意図は同じ）: 活動一括は1人ずつの入力済みを Map にしてから数える（行の空の枠の見た目にも使う）
    assert.match(BULK.activity, /\[rid, activityCellsFilled\(activityShownCells\(data\.activities \?\? \[\], pending, rid, day\)\)\]/)
    // 読めない: バイタル・入浴（daycareDayLoad の vitalsOk・bathsOk）・昼食（intakeOk）
    assert.match(today, /vitals: data\.vitalsOk \? \{ done: vDone, abnormal: vDone && vitalsAbnormal\(id\) \} : null/)
    assert.match(today, /lunchRead: data\.intakeOk/)
    assert.match(today, /bath: data\.bathsOk \? daycareBathStatus\(bathOf\(id\), r\.bathingPlanned\) : null/)
    assert.match(today, /bathsOk,\s*vitalsOk,\s*meals: intake\?\.meals \?\? \[\]/)
  })
  it('読めなかった項目があれば、一覧の上（PlanBanners の次）に1行の知らせ（role="status"・ほかの帯と同じ見た目）。カードがある時だけ', () => {
    const iPlan = today.indexOf('<PlanBanners data={data}')
    const iNote = today.indexOf('{unreadNotice !== null && board.rows.length > 0 ? (')
    const iCards = today.indexOf('<ul className="dc-cards"')
    assert.ok(iPlan > 0 && iPlan < iNote && iNote < iCards)
    assert.match(today, /\{unreadNotice !== null && board\.rows\.length > 0 \? \(\s*<p role="status" className="rounded-lg border border-warn bg-warn-bg p-3 text-base text-ink">\s*<span aria-hidden="true">▲ <\/span>\s*\{unreadNotice\}\s*<\/p>/)
    assert.match(today, /unreadProgressLabels\(\{\s*vitalsOk: data\.vitalsOk,\s*intakeOk: data\.intakeOk,\s*activitiesOk: data\.activities !== null,\s*trainingOk: data\.training !== null,\s*bathsOk: data\.bathsOk,\s*\}\)/)
  })
  it('件数の帯: バイタル・入浴を読めない日は「バイタル未」「入浴 未確認」を「—」にし、▲ の注意の形にしない（確認の反証 軽2）', () => {
    assert.match(today, /const tiles: \{ label: string; value: number \| null; tone\?: 'warn' \}\[\] = \[/)
    assert.match(today, /data\.vitalsOk\s*\? \{ label: 'バイタル未', value: vitalsWaiting, tone: vitalsWaiting > 0 \? 'warn' : undefined \}\s*: \{ label: 'バイタル未', value: null \}/)
    assert.match(today, /data\.bathsOk\s*\? \{ label: '入浴 未確認', value: bathUnchecked, tone: bathUnchecked > 0 \? 'warn' : undefined \}\s*: \{ label: '入浴 未確認', value: null \}/)
    assert.match(today, /\{t\.value === null \? \(\s*<>\s*<span aria-hidden="true">—<\/span>\s*<span className="sr-only">読み込めません<\/span>\s*<\/>\s*\) : \(\s*t\.value\s*\)\}/)
  })
  it('切り替えの数は今日を見ている時だけ渡す（リンクの先は今日を開く＝反証 中2）', () => {
    // 2026-11-09 計画B2（固定し直し・意図は同じ）: 数える相手は一括の画面に出る方（daycareBulkRows）・1人ずつの空の欄の数から数える
    assert.match(today, /const navPending =\s*data\.day === today\s*\? daycareNavPending\(\{[\s\S]*?\}\)\s*: undefined/)
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
    // 2026-11-09 計画B2（固定し直し・意図は同じ）: 「未到着 n名」を出さなくなったので、1024px 未満で隠す指定（hideNotArrivedNarrow）は外した
    assert.ok(v.indexOf('aria-label="表示する方"') < v.indexOf('<DaycareUnfilledCount counts={unfilled} />'))
    // 2026-11-09 反証 軽1（固定し直し・意図は同じ）: 1024px 以上は残りの幅が 16rem 以上あれば同じ段に置く（段の間は 12px）
    assert.match(v, /<\/div>\s*(\{\}\s*)?\{countRows\.length > 0 \? \(\s*<div className="min-w-0 grow lg:basis-64">\s*<DaycareUnfilledCount counts=\{unfilled\} \/>\s*<\/div>\s*\) : null\}\s*<\/div>\s*\{releasing \? \(/)
    assert.match(v, /<div className="flex flex-wrap items-center gap-x-3 gap-y-2">\s*<div className="flex flex-wrap items-center gap-gap" role="group" aria-label="日付">/)
    assert.match(v, /const countRows = board === null \|\| data === null \|\| data\.day !== day \? \[\] : daycareBulkRows\(board\.rows\)/)
    // 2026-11-09 計画B2（固定し直し・仕様の変更で数え方を変えた）: 1人5欄＝最初の回の5欄の空き（vitalBlankFields）を到着を問わず数える
    assert.match(v, /const first = slotsOf\(r\.residentId\)\[0\]/)
    assert.match(v, /return \[r\.residentId, vitalBlankFields\(first === undefined \? null : vals\)\]/)
    assert.match(v, /const unfilled = bulkBlankSummary\(\[\.\.\.blankOf\.values\(\)\]\)/)
    // 活動一括: 見出しの段（読めない時は出さない）
    const a = BULK.activity
    assert.match(a, /<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">\s*<h2 id="h-bulk" className="text-lg font-bold leading-tight text-ink">\s*活動一括\s*<\/h2>\s*\{readable && targets\.length > 0 \? <DaycareUnfilledCount counts=\{unfilled\} \/> : null\}\s*<\/div>/)
    // 2026-11-09 反証 中1（固定し直し・意図は同じ）: 重ね方は枠（cellOf）と同じ決まりの純関数 activityShownCells（今日の画面と同じ関数）
    assert.match(a, /\[rid, activityCellsFilled\(activityShownCells\(data\.activities \?\? \[\], pending, rid, day\)\)\]/)
    assert.match(a, /const unfilled = bulkBlankSummary\(targets\.map\(\(rid\) => recordBlankFields\(filledOf\.get\(rid\) \?\? false\)\)\)/)
    // 機能訓練: 見出し「今日の対象者」の段（読めない時は出さない）
    const t = BULK.training
    assert.match(t, /<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">\s*<h2 id="h-targets" className="text-lg font-bold leading-tight text-ink">\s*\{day === today \? '今日' : 'この日'\}の対象者\s*<\/h2>\s*\{data\.sessions !== null && targets\.length > 0 \? <DaycareUnfilledCount counts=\{unfilled\} \/> : null\}\s*<\/div>/)
    assert.match(t, /const unfilled = bulkBlankSummary\(targets\.map\(\(rid\) => recordBlankFields\(trainingFilled\(sessions, pending, rid, day\)\)\)\)/)
    // 食事一括: 見出し「昼食」の段
    const m = BULK.meals
    const top = m.slice(m.indexOf('<section aria-labelledby="h-meals"'), m.indexOf('<table'))
    assert.ok(top.indexOf('id="h-meals"') < top.indexOf('<DaycareUnfilledCount counts={counts} />'))
    for (const [k, p] of Object.entries(BULK)) {
      assert.match(p, /import \{ [A-Za-z, ]*\bDaycareUnfilledCount \} from '\.\.\/components\/DaycareUnfilledCount'/, k)
      assert.equal((p.match(/<DaycareUnfilledCount /g) ?? []).length, 1, `${k}: 1か所だけ`)
      assert.doesNotMatch(p, /hideNotArrivedNarrow/, k)
      // 2026-11-09 計画B2（固定し直し・仕様の変更で数え方を変えた）: 4画面とも到着を問わず空の欄を数える（bulkBlankSummary）。
      // 在席・帰宅の方だけ数える attendedUnfilledCount は一括の画面では使わない
      assert.match(p, /bulkBlankSummary\(/, k)
      assert.doesNotMatch(p, /attendedUnfilledCount|lunchUnfilledCount/, k)
    }
    const unfCmp = code('../src/components/DaycareUnfilledCount.tsx')
    // 「未到着 n名（数えていません）」は出さない（到着を問わず数えるため）。未入力の数は隠さない
    assert.doesNotMatch(unfCmp, /未到着|hideNotArrivedNarrow/)
    assert.doesNotMatch(unfCmp, /(?<![-\w])hidden(?![-\w=])/)
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
  it('機能訓練: 配置を読み込めない時の知らせを、今日の対象者の区画の先頭にも同じ文で出す（反証 中5・読み上げの知らせは配置の区画の1か所）', () => {
    const t = BULK.training
    assert.match(t, /const MSG_STAFFING_UNREAD = '配置を読み込めませんでした。通信状態を確認して、〔最新に更新〕を押してください。'/)
    const sec = t.slice(t.indexOf('aria-labelledby="h-targets"'), t.indexOf('aria-labelledby="h-staffing"'))
    const top = sec.slice(0, sec.indexOf('<table'))
    assert.match(top, /\{data\.staffing === null && !missing \? \(\s*<p className="rounded border border-danger bg-danger-bg p-2 text-base text-ink">\s*<span aria-hidden="true">▲ <\/span>\s*\{MSG_STAFFING_UNREAD\}/)
    // 見出しの段の次（説明文より上）
    assert.ok(top.indexOf('</h2>') < top.indexOf('{MSG_STAFFING_UNREAD}') && top.indexOf('{MSG_STAFFING_UNREAD}') < top.indexOf('予定の方（休み・入院中を除く）'))
    const staffing = t.slice(t.indexOf('aria-labelledby="h-staffing"'), t.indexOf('<DaycareReviewDueSection'))
    assert.match(staffing, /\{data\.staffing === null && !missing \? \(\s*<p role="alert" className="rounded border border-danger bg-danger-bg p-2 text-base text-ink">\s*<span aria-hidden="true">▲ <\/span>\s*\{MSG_STAFFING_UNREAD\}/)
    assert.equal((t.match(/\{MSG_STAFFING_UNREAD\}/g) ?? []).length, 2)
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
