// デイ せせらぎ 今日の画面の改善 2回目: 昼食・おやつの一括入力（/record/daycare/meals）の回帰テスト（2026-10-24・代表承認・決定 6／親の回答 1〜2）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycarePerson.ts）: 並べる方（在席・帰宅だけ・一覧の並びのまま）・画面のルート・帯の端の保存の印
// 2. 静的検査: 書き込みは既存の saveMealEdits・discardPendingRow だけ・決まりは1人の画面と同じ（送り先の固定・送信待ちの重ね方・
//    拒食から戻す・〔元に戻す〕はオンラインで書けた時だけ・旗と未来の日）・切り替えとルートと画面名・care-log の食事一括は変えない・
//    端末に業務データを残さない・「自動」の文字を出さない・押せる範囲 44px と角
// 3. 2026-10-28 昼食だけの1行1人の表にした（代表者の依頼・親の回答 A1〜A9）: 選択肢の並びと送る値・未入力の数え方・水分の検査と
//    送信待ちの消し込み（純ロジック）、表の作り（列・見出しの行を上に残す・dc-table-fit・useTableFit・isolate）・水分の form・
//    insertFluid の送る値・〔元に戻す〕の softDeleteFluid・おやつを画面に出さない（静的検査）
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
  DP = await import('../src/lib/daycarePerson.ts?daycare-meals')
} catch (e) {
  loadError = e
  DP = null
}

if (DP === null) {
  registerLoadFailure('デイ 食事一括の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('純ロジック', () => {
    it('並べる方: 一括の画面と同じ（予定の方のうち休み・入院中を除く全員＋予定外で来た方・2026-10-24 §9.4 の4）・一覧の並びのまま', () => {
      // 到着の前（予定）の方も出す＝食事は到着の前でも入れられる（意図した変更。それまでは在席・帰宅だけ）
      const rows = [
        { residentId: 4, state: 'present', planned: true, hospitalized: false },
        { residentId: 2, state: 'absent', planned: true, hospitalized: false },
        { residentId: 9, state: 'left', planned: false, hospitalized: false },
        { residentId: 1, state: 'planned', planned: true, hospitalized: false },
        { residentId: 5, state: 'planned', planned: true, hospitalized: true },
        { residentId: 6, state: 'planned', planned: false, hospitalized: false },
        { residentId: 7, state: 'present', planned: true, hospitalized: true },
      ]
      assert.deepEqual(DP.mealBulkRows(rows).map((r) => r.residentId), [4, 9, 1, 7])
      assert.deepEqual(DP.mealBulkRows([]), [])
    })
    it('画面のルート: 今日は ?day= を付けない・それ以外は付ける', () => {
      assert.equal(DP.mealBulkPath('2026-10-24', '2026-10-24'), '/record/daycare/meals')
      assert.equal(DP.mealBulkPath('2026-10-20', '2026-10-24'), '/record/daycare/meals?day=2026-10-20')
    })
    it('帯の端の印: 手当てが要る方（食い違い・止まり・拒否・失敗）が先・送信中・未送信・保存済み・無し', () => {
      for (const k of ['conflict', 'held', 'rejected', 'error']) assert.deepEqual(DP.mealBandMark(['saved', k]), { mark: '▲', text: '要確認', tone: 'warn' })
      assert.deepEqual(DP.mealBandMark(['queued', 'saving']), { mark: '↻', text: '送信中', tone: 'info' })
      assert.deepEqual(DP.mealBandMark([undefined, 'queued']), { mark: '⚠', text: '未送信', tone: 'warn' })
      assert.deepEqual(DP.mealBandMark(['saved', undefined]), { mark: '✓', text: '保存済み', tone: 'ok' })
      assert.equal(DP.mealBandMark([undefined, undefined]), null)
    })
  })

  describe('静的検査（食事一括の決まり）', () => {
    const page = code('../src/pages/DaycareMealsPage.tsx')
    it('書き込みは既存の saveMealEdits・discardPendingRow・insertFluid・softDeleteFluid だけ（新しい書き込みの経路を作らない）・supabase を直に呼ばない', () => {
      const writes = page.match(/\b(save\w+|insert\w+|update\w+|delete\w+|softDelete\w+|upsert\w+|discard\w+)\(/g) ?? []
      const names = [...new Set(writes.map((w) => w.slice(0, -1)))].sort()
      // 2026-10-28 昼食だけの表にした（固定し直し・意図は同じ）: 水分を足す欄を足したので、1人の画面の水分と同じ insertFluid・softDeleteFluid が加わる
      assert.deepEqual(names, ['discardPendingRow', 'insertFluid', 'saveMeal', 'saveMealEdits', 'softDeleteFluid'])
      assert.doesNotMatch(page, /supabase|\.from\(|\.rpc\(|console\./)
    })
    it('並べる方は mealBulkRows（その日の一覧から）・読み込みは fetchDaycareIntake（昼食・おやつ）', () => {
      assert.match(page, /mealBulkRows\(board\.rows\)/)
      assert.match(page, /fetchDaycareIntake\(target\)/)
    })
    it('決まりは1人の画面と同じ: 送り先は押した時の人・日・枠／記入者は新しい行だけ／edited_by／rebase', () => {
      // 2026-10-28 昼食だけの表にした（固定し直し・意図は同じ）: 枠は昼食だけ（押した時の人・日で固定）
      assert.match(page, /const targetOf = \(residentId: number\): MealTarget => \(\{ residentId, day, slot: 'lunch' \}\)/)
      assert.match(page, /const mealKeyOf = \(t: MealTarget\) => `\$\{t\.residentId\}:\$\{t\.day\}:\$\{t\.slot\}`/)
      assert.match(page, /\.\.\.\(cur === null \? \{ fill: \{ recorded_by: actorId \} \} : \{\}\),\s*editedBy: actorId,\s*rebase: opts\.rebase !== undefined,/)
    })
    it('送信待ちの値・順番待ちの値だけ重ねて出す（止まった値・拒まれた値は重ねない）', () => {
      assert.match(page, /if \(\(p === null \|\| p\.state !== 'pending'\) && wait\.length === 0\) return cur/)
      assert.match(page, /if \(p !== null && p\.state === 'pending' && f in p\.values\) return p\.values\[f\]/)
    })
    it('同じ人・日・枠は順番待ち（前の応答を待ってから次を送る）・基準は送る時のいちばん新しい値（#45 の確認の反証 中）', () => {
      assert.match(page, /const tail = \(chainRef\.current\.get\(k\) \?\? Promise\.resolve\(\)\)\s*\.then\(\(\) => sendMeal\(t, patch, opts\)\)/)
      assert.match(page, /chainRef\.current\.set\(k, tail\)/)
      // 送る時の基準は、描画を待たずに入れ替わる控え（dataRef）から取る
      assert.match(page, /const mealRowFor = \(t: MealTarget\): DaycareMealRow \| null => \{\s*const d = dataRef\.current/)
      assert.match(page, /const commitData = useCallback\(\(next: MealsData\) => \{\s*dataRef\.current = next\s*setData\(next\)/)
      // 順番待ちが残る枠は「送信中」
      assert.match(page, /\(waiting\[mealKeyOf\(t\)\]\?\.length \?\? 0\) > 0 \? 'saving'/)
      // 読み込みを始めた後に受け取った自分の保存の応答は、版の大きい方を残す
      assert.match(page, /\(savedAtRef\.current\.get\(m\.meal\.id\) \?\? 0\) > startedAt && mine\.meal\.rev > m\.meal\.rev \? mine : m/)
    })
    it('〔元に戻す〕はオンラインで実際に書けた時だけ・同じ日の間だけ（送信待ちの時は出さない）', () => {
      assert.match(page, /if \(r === 'queued'\) \{\s*setMealFor\(t, \{ kind: 'queued', persisted: isQueuePersisted\(\) \}\)\s*return\s*\}/)
      assert.match(page, /if \(opts\.undoable !== false && r\.applied\.length > 0 && here\(\)\) \{/)
      assert.match(page, /const here = \(\) => dayRef\.current === t\.day/)
    })
    it('主食・副食の選択肢は拒食なら「食べた」に戻して送る・状態は「食べた／拒食」だけ（外出・入院の選択肢は出さない）・おやつは画面に出さない', () => {
      // 2026-10-28 昼食だけの表にした（固定し直し・意図は同じ）: 0〜10 のボタン・〔拒食〕のボタンは端末の選択肢（—・0〜10・拒食）に。
      // 送る値は lunchSelectPatch（数字・「—」は拒食なら「食べた」に戻す＝withEaten と同じ・「拒食」は { status: 'refused' }。下の純ロジックで確かめる）
      assert.match(page, /const patch = lunchSelectPatch\(f, e\.target\.value, lunch\?\.status\)\s*if \(patch !== null\) void saveMeal\(lt, patch\)/)
      assert.match(page, /\{LUNCH_SELECT_OPTIONS\.map\(\(o\) => \(\s*<option key=\{o\.value\} value=\{o\.value\}>/)
      assert.doesNotMatch(page, /status: 'out'|status: 'hospital'/)
      // おやつ（meals の snack）の欄・ボタン・知らせは画面に出さない（記録・1人の画面・care-log のおやつはそのまま）
      assert.doesNotMatch(page, /DAYCARE_SNACK_CHOICES|snackLabel|'snack'|おやつ/)
      assert.doesNotMatch(page, /DAYCARE_MEAL_AMOUNTS\.map|chipCls|aria-pressed/)
    })
    it('入力解禁は input_enabled_daycare・サーバーの設定待ちと未来の日は書かない・記録者が無ければ書かない', () => {
      assert.match(page, /getKindInputGate\('daycare'\)/)
      assert.match(page, /const canWrite = gate !== null && gate\.observed && gate\.value === true && !missing && day <= today/)
      assert.match(page, /if \(actorId === null\) return MSG_NO_RECORDER/)
      assert.match(page, /disabled=\{!canWrite\}/)
    })
    it('業務日は URL の ?day=（再読み込みで同じ日に戻る）・端末に業務データを残さない・「自動」の文字を出さない', () => {
      assert.match(page, /const day = readPersonDay\(search\.get\('day'\), today\)/)
      assert.match(page, /navigate\(mealBulkPath\(d, today\), \{ replace: true \}\)/)
      assert.doesNotMatch(page, /localStorage|sessionStorage/)
      // 「自動」の印（自動の到着・入浴など）は出さない。送信待ちの決まり文句（電波が戻ると自動で送信します）は全画面共通なので除く
      assert.doesNotMatch(page.replace("'電波が届かないため、この端末に保存しました（電波が戻ると自動で送信します）。'", ''), /自動/)
    })
    it('押せる範囲 44px（min-h-tap・min-w-tap）・角は rounded（6px）・rounded-full を使わない・文字は text-lg（選択肢・水分の欄）', () => {
      // 2026-10-28 昼食だけの表にした（固定し直し・意図は同じ）: ボタン列の帯（.dc-meal-row）は表になったので CSS ごと外した
      assert.match(page, /const selectCls = 'min-h-tap min-w-tap rounded border border-border-strong bg-surface px-2 text-lg text-ink disabled:text-ink3'/)
      assert.match(page, /className="block min-h-tap w-20 rounded border border-border-strong bg-surface px-2 text-lg text-ink disabled:text-ink3"/)
      assert.match(page, /className="min-h-tap min-w-tap rounded border border-primary bg-surface px-2 text-lg font-bold text-primary disabled:border-border disabled:text-ink3"/)
      assert.doesNotMatch(page, /rounded-full/)
      assert.doesNotMatch(page, /dc-meal-row/)
      assert.doesNotMatch(read('../src/index.css'), /dc-meal-row/)
      // 文字は 15px 以上（text-xs・text-2xs を使わない）
      assert.doesNotMatch(page, /text-(2?xs)\b/)
    })
    it('日を移った後の応答は前の日の表に入れない・画面の入力の印は実際に書けた時だけ（#45 の反証 軽5）', () => {
      assert.match(page, /if \(prev !== null && prev\.day === saved\.meal_on\) \{/)
      assert.match(page, /editedInApp: \(old\?\.editedInApp \?\? false\) \|\| wrote/)
    })
    it('知らせの出し直し: 止まった・拒まれた値・まだ届いていない値（開き直した時も「未送信」）・届いたら外す（#45 の反証 中2・軽5）', () => {
      assert.match(page, /\}, \[data, cameKey, queueTick\]\)/)
      assert.match(page, /if \(p\.state === 'rejected'\) st = cur !== undefined && cur\.kind === 'rejected' \? cur : \{ kind: 'rejected', target: t \}/)
      assert.match(page, /\} else if \(p !== null && p\.state === 'pending' && \(cur === undefined \|\| cur\.kind === 'saved'\)\) \{\s*(\/\/[^\n]*\s*)*st = \{ kind: 'queued', persisted: isQueuePersisted\(\) \}/)
      assert.match(page, /\(cur\.kind === 'queued' && p === null\)\)\) \{\s*(\/\/[^\n]*\s*)*st = undefined/)
    })
    it('解き方: 〔いまの値にする〕〔取り下げる〕は送信待ちから外す・〔あなたの値で直す〕は基準をサーバーの値にして送り直す（#45 の反証 軽5）', () => {
      assert.match(page, /await discardPendingRow\('meals', t, fields \?\? \(p === null \? \[\] : Object\.keys\(p\.values\)\), p\?\.vers\)/)
      assert.match(page, /base\[c\.field\] = c\.server/)
      assert.match(page, /await saveMeal\(t, patch, \{ rebase: base, undoable: false \}\)/)
      assert.match(page, /onClick=\{\(\) => onTake\(st\.target, st\.conflicts\.map\(\(c\) => c\.field\)\)\}/)
      assert.match(page, /onClick=\{\(\) => onMine\(st\.target, st\.conflicts\)\}/)
    })
    it('3状態: 読み込み中・読めない時の再試行・予定の方がいない時の案内', () => {
      // 2026-10-28 昼食だけの表にした（固定し直し・意図は同じ）
      assert.match(page, /<LoadingBlock label="その日の昼食を読み込んでいます…" \/>/)
      assert.match(page, /<ErrorBlock message=\{error\} onRetry=\{\(\) => setReloadKey\(\(n\) => n \+ 1\)\} \/>/)
      assert.match(page, /この日の予定の方がいません（休み・入院中の方は出しません）。予定外で来た方は、今日の画面の〔予定にない方を追加〕で足したカードを押し、〔予定外で到着〕を押すと、ここに出ます。/)
      assert.doesNotMatch(page, /来た方（在席・帰宅）/)
    })
  })

  // ── 2026-10-28 食事一括を「昼食だけの1行1人の表」にした（代表者の依頼・親の回答 A1〜A9） ──
  describe('純ロジック（昼食だけの表・2026-10-28）', () => {
    it("主食・副食の選択肢の並びと value: 「—（未入力）」→ 0〜10 → 「拒食」（value は ''・'0'〜'10'・'refused'）", () => {
      assert.deepEqual(
        DP.LUNCH_SELECT_OPTIONS.map((o) => o.value),
        ['', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'refused'],
      )
      assert.deepEqual(
        DP.LUNCH_SELECT_OPTIONS.map((o) => o.label),
        ['—（未入力）', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '拒食'],
      )
    })
    it('いまの値: 拒食なら主食・副食の両方が「拒食」・そうでなければその欄の値（null は「—」）・記録なしは「—」', () => {
      assert.equal(DP.lunchSelectValue({ main_amount: 7, side_amount: null, status: 'eaten' }, 'main_amount'), '7')
      assert.equal(DP.lunchSelectValue({ main_amount: 7, side_amount: null, status: 'eaten' }, 'side_amount'), '')
      assert.equal(DP.lunchSelectValue({ main_amount: 0, side_amount: 10, status: null }, 'main_amount'), '0')
      assert.equal(DP.lunchSelectValue({ main_amount: 5, side_amount: 5, status: 'refused' }, 'main_amount'), 'refused')
      assert.equal(DP.lunchSelectValue({ main_amount: 5, side_amount: 5, status: 'refused' }, 'side_amount'), 'refused')
      assert.equal(DP.lunchSelectValue(null, 'main_amount'), '')
      assert.equal(DP.lunchSelectValue(undefined, 'side_amount'), '')
    })
    it('選んだ時の送る値: 数字＝その欄（拒食なら「食べた」に戻す）・「拒食」＝状態だけ（主食・副食は変えない）・「—」＝その欄を未入力に（拒食なら「食べた」に戻す）', () => {
      // 数字
      assert.deepEqual(DP.lunchSelectPatch('main_amount', '7', 'eaten'), { main_amount: 7 })
      assert.deepEqual(DP.lunchSelectPatch('side_amount', '0', null), { side_amount: 0 })
      assert.deepEqual(DP.lunchSelectPatch('main_amount', '10', undefined), { main_amount: 10 })
      assert.deepEqual(DP.lunchSelectPatch('main_amount', '3', 'refused'), { main_amount: 3, status: 'eaten' })
      assert.deepEqual(DP.lunchSelectPatch('side_amount', '6', 'out'), { side_amount: 6, status: 'eaten' })
      // 拒食
      assert.deepEqual(DP.lunchSelectPatch('main_amount', 'refused', 'eaten'), { status: 'refused' })
      assert.deepEqual(DP.lunchSelectPatch('side_amount', 'refused', null), { status: 'refused' })
      // 「—」
      assert.deepEqual(DP.lunchSelectPatch('main_amount', '', 'eaten'), { main_amount: null })
      assert.deepEqual(DP.lunchSelectPatch('side_amount', '', 'refused'), { side_amount: null, status: 'eaten' })
      // 選択肢に無い値は送らない
      for (const v of ['11', '-1', '1.5', 'eaten', 'out', ' 7']) assert.equal(DP.lunchSelectPatch('main_amount', v, 'eaten'), null, v)
    })
    it('未入力の数: 在席・帰宅の方だけ・拒食は入力済み・主食か副食の片方でも null なら未入力・未到着は別に数える', () => {
      const r = (state, lunch) => ({ state, lunch })
      assert.deepEqual(
        DP.lunchUnfilledCount([
          r('present', { main_amount: 7, side_amount: 5, status: 'eaten' }), // 入力済み
          r('present', { main_amount: 7, side_amount: null, status: 'eaten' }), // 副食が未入力
          r('left', { main_amount: null, side_amount: 3, status: null }), // 主食が未入力
          r('left', null), // 記録なし
          r('present', { main_amount: null, side_amount: null, status: 'refused' }), // 拒食＝入力済み
          r('left', { main_amount: 0, side_amount: 0, status: 'eaten' }), // 0 は入力済み
          r('planned', null), // 未到着（数えない）
          r('planned', { main_amount: 5, side_amount: 5, status: 'eaten' }), // 未到着（入っていても未到着に数える）
        ]),
        { unfilled: 3, notArrived: 2 },
      )
      assert.deepEqual(DP.lunchUnfilledCount([]), { unfilled: 0, notArrived: 0 })
      assert.deepEqual(DP.lunchUnfilledCount([r('present', { main_amount: 1, side_amount: 1, status: null })]), { unfilled: 0, notArrived: 0 })
    })
    it('水分の量の検査は fluidAmountError（1〜2000）。この画面の文は cc で出す（1人の画面の ml の文は変えない）', () => {
      assert.equal(DP.fluidAmountError('300', 'cc'), null)
      assert.equal(DP.fluidAmountError('２００', 'cc'), null)
      assert.equal(DP.fluidAmountError('2000', 'cc'), null)
      assert.equal(DP.fluidAmountError('2001', 'cc'), '量は 1〜2000 cc で入れてください。')
      assert.equal(DP.fluidAmountError('0', 'cc'), '量は 1〜2000 cc で入れてください。')
      assert.equal(DP.fluidAmountError('1.5', 'cc'), '量は整数の cc で入れてください。')
      assert.equal(DP.fluidAmountError('', 'cc'), '量を入れてください。')
      // 単位を渡さない時（1人の画面）は ml のまま
      assert.equal(DP.fluidAmountError('2001'), '量は 1〜2000 ml で入れてください。')
      assert.equal(DP.fluidAmountError('abc'), '量は整数の ml で入れてください。')
    })
    it('水分の送信待ち → 届く: 合計が二重にならない（画面と同じ順に fluidTotalOf・settleQueuedFluid を回す）', () => {
      const day = '2026-10-28'
      const rows = [{ resident_id: 1, taken_on: day, amount_ml: 300 }]
      const shown = (fluids, held) => ({ total: DP.fluidTotalOf(fluids, 1, day), queued: held?.ml ?? 0 })
      // 圏外で ＋200: 基準は退避した時のサーバーの合計 300
      let held = { base: DP.fluidTotalOf(rows, 1, day), ml: 200 }
      assert.deepEqual(shown(rows, held), { total: 300, queued: 200 })
      // まだ載っていない読み直し: 送信待ちはそのまま
      held = DP.settleQueuedFluid(held, DP.fluidTotalOf(rows, 1, day))
      assert.deepEqual(shown(rows, held), { total: 300, queued: 200 })
      // 届いた後の読み直し: 合計 500・送信待ちは消える（500 ＋ 200 ＝ 700 と二重に出さない）
      const landed = [...rows, { resident_id: 1, taken_on: day, amount_ml: 200 }]
      held = DP.settleQueuedFluid(held, DP.fluidTotalOf(landed, 1, day))
      assert.equal(held, null)
      assert.deepEqual(shown(landed, held), { total: 500, queued: 0 })
      // 送信待ちの間にオンラインで ＋100 を足した時は、画面が基準も ＋100 上げる（いま足した分を「送信待ちが載った」と見て減らさない）
      let h2 = { base: 300, ml: 200 }
      const online = [...rows, { resident_id: 1, taken_on: day, amount_ml: 100 }]
      h2 = { ...h2, base: h2.base + 100 }
      h2 = DP.settleQueuedFluid(h2, DP.fluidTotalOf(online, 1, day))
      assert.deepEqual(h2, { base: 400, ml: 200 })
      // ほかの方・ほかの日の水分は合計に入れない
      assert.equal(DP.fluidTotalOf([...online, { resident_id: 2, taken_on: day, amount_ml: 900 }, { resident_id: 1, taken_on: '2026-10-27', amount_ml: 900 }], 1, day), 400)
    })
  })

  describe('静的検査（昼食だけの1行1人の表・2026-10-28）', () => {
    const page = code('../src/pages/DaycareMealsPage.tsx')
    const table = page.slice(page.indexOf('<table'), page.indexOf('</table>'))
    const head = table.slice(table.indexOf('<thead>'), table.indexOf('</thead>'))
    const body = table.slice(table.indexOf('<tbody>'), table.indexOf('</tbody>'))
    it('見出しは「昼食」・説明の1行は新しい操作に合わせる', () => {
      assert.match(page, /<h2 id="h-meals" className="text-xl font-bold text-ink">\s*昼食\s*<\/h2>/)
      assert.match(page, /選ぶとすぐ保存します。昼食は care-log の食事の昼食と同じ記録です。水分は数を入れて改行キー（または〔＋〕）で足します（1人の画面の水分と同じ記録）。/)
    })
    it('表の枠はバイタル一括・活動一括と同じ（dc-table-fit・isolate・縦横に送る・useTableFit・キーボードで選べる）', () => {
      assert.match(page, /ref=\{setTableBox\}\s+role="region"\s+aria-label=\{`\$\{fmtDayLabel\(day\)\}の昼食の表\$\{tableScrolls \? '（横にスクロールできます）' : ''\}`\}\s+tabIndex=\{tableScrolls \|\| tableScrollsY \? 0 : undefined\}\s+className="dc-table-fit relative isolate overflow-auto"/)
      assert.match(page, /useTableFit\(tableBox\)/)
      assert.match(page, /const check = \(\) => \{\s*setTableScrolls\(el\.scrollWidth > el\.clientWidth \+ 1\)\s*setTableScrollsY\(el\.scrollHeight > el\.clientHeight \+ 1\)\s*setTableBoxWidth\(el\.clientWidth\)/)
      assert.match(page, /const ro = new ResizeObserver\(check\)\s*ro\.observe\(el\)\s*if \(el\.firstElementChild\) ro\.observe\(el\.firstElementChild\)/)
      assert.match(page, /<table className="w-full min-w-max border-collapse text-base">\s*<caption className="sr-only">/)
    })
    it('列は 氏名｜主食｜副食｜水分（cc）。見出しの行は上に残す（角の氏名は z-30・ほかは z-20）・氏名の列は左に残す（z-10）', () => {
      const cols = [...head.matchAll(/<th scope="col" className="([^"]+)">\s*(?:<span className="dc-vital-name block">)?([^<\s]+)/g)].map((m) => [m[2], m[1]])
      assert.deepEqual(cols.map((c) => c[0]), ['氏名', '主食', '副食', '水分（cc）'])
      assert.equal(cols[0][1], 'sticky left-0 top-0 z-30 bg-surface2 px-2 py-2 text-sm font-bold text-ink2')
      for (const c of cols.slice(1)) assert.equal(c[1], 'sticky top-0 z-20 bg-surface2 px-2 py-2 text-sm font-bold text-ink2', c[0])
      assert.match(body, /<th scope="row" className="sticky left-0 z-10 bg-bg px-2 py-1 text-left font-normal">\s*(\{\}\s*)?<div className="dc-vital-name">/)
      // 行の列は見出しと同じ並び（氏名 → 主食・副食の選択肢 → 水分）
      const iName = body.indexOf('<th scope="row"')
      const iSel = body.indexOf('<select')
      const iForm = body.indexOf('<form')
      assert.ok(iName > 0 && iName < iSel && iSel < iForm)
      assert.match(body, /\{\(\['main_amount', 'side_amount'\] as const\)\.map\(\(f\) => \{/)
    })
    it('行の下の知らせは、表の幅を広げず左に残す行で出す（colSpan・w-0 min-w-full・sticky left-0・枠の幅で折り返す）', () => {
      assert.match(body, /<td colSpan=\{4\} className="p-0">\s*<div className="w-0 min-w-full">\s*<div className="sticky left-0 space-y-1 px-2 pb-2" style=\{\{ maxWidth: tableBoxWidth > 0 \? tableBoxWidth : undefined \}\}>/)
      // 昼食の知らせ（食い違い・止まり・拒否・送信待ち・失敗）と水分の知らせ（送信待ち・失敗・数の誤り）
      assert.match(body, /<MealNote\s+word="昼食"/)
      assert.match(body, /\{held\.lost \? MSG_NOT_PERSISTED : MSG_QUEUED\}/)
      assert.match(body, /const detail = lunchNote \|\| held !== undefined \|\| fn !== undefined/)
    })
    it('氏名の列: 1人の画面へのリンク（44px）・在席／帰宅／未到着・保存の印（昼食だけ）・取り込みの印', () => {
      assert.match(body, /<Link\s+to=\{personPath\(rid, day, today\)\}\s+className="inline-flex min-h-tap items-center/)
      assert.match(body, /\{cameText\(row\)\}/)
      assert.match(body, /const mark = mealBandMark\(\[kindOf\(lt, stL\)\]\)/)
      assert.match(body, /\{source !== null && source !== '画面で入力' \?/)
    })
    it('主食・副食は端末の選択肢（44px・text-lg）。読み上げは見えている列の名前で始まる・押せない時（旗・未来の日）は disabled', () => {
      assert.match(body, /<select\s+value=\{v\}\s+disabled=\{!canWrite\}\s+aria-label=\{`\$\{AMOUNT_WORD\[f\]\}：\$\{name\}さん（いま: \$\{now\}）`\}/)
      assert.match(page, /const AMOUNT_WORD: Record<LunchAmountField, string> = \{ main_amount: '主食', side_amount: '副食' \}/)
      assert.match(body, /const v = lunchSelectValue\(lunch, f\)/)
      // いまの値は画面に出している値（送信待ち・順番待ちを重ねた mealShownFor）
      assert.match(body, /const lunch = mealShownFor\(lt\)/)
    })
    it('未入力の数は表の上に（画面に出している値で数える）。1名以上は「▲ 未入力 n名」（赤字）・0名は「✓ 未入力なし」・未到着は灰色で別に', () => {
      assert.match(page, /const counts = lunchUnfilledCount\(came\.map\(\(row\) => \(\{ state: row\.state, lunch: mealShownFor\(targetOf\(row\.residentId\)\) \}\)\)\)/)
      assert.match(page, /<span className="font-bold text-danger">\s*<span aria-hidden="true">▲ <\/span>未入力 <span className="font-num">\{counts\.unfilled\}<\/span>名/)
      assert.match(page, /<span className="font-bold text-ok">\s*<span aria-hidden="true">✓ <\/span>未入力なし/)
      assert.match(page, /\{counts\.notArrived > 0 \? \(\s*<span className="text-ink2">\s*未到着 <span className="font-num">\{counts\.notArrived\}<\/span>名（数えていません）/)
      assert.ok(page.indexOf('const counts = lunchUnfilledCount') < page.indexOf('<table'), '表の上')
      assert.ok(page.indexOf('未入力なし') < page.indexOf('<table'), '表の上')
    })
    it('水分: form の submit（改行キー）でも〔＋〕でも足す・欄は inputMode numeric（44px・text-lg）・〔＋〕は 44px と「水分を足す」', () => {
      assert.match(body, /<form\s+onSubmit=\{\(e\) => \{\s*e\.preventDefault\(\)\s*submitFluid\(rid\)\s*\}\}/)
      assert.match(body, /<input\s+type="text"\s+inputMode="numeric"/)
      assert.match(body, /aria-label=\{`水分（cc）：\$\{name\}さんに足す量`\}/)
      assert.match(body, /<button\s+type="submit"\s+disabled=\{!canWrite \|\| busy\}\s+aria-label=\{`水分を足す（\$\{name\}さん）`\}/)
      // 〔＋〕は form の中の submit（押しても改行キーでも同じ submitFluid を通る）
      const form = body.slice(body.indexOf('<form'), body.indexOf('</form>'))
      assert.match(form, /type="submit"/)
      assert.doesNotMatch(form, /onClick=/)
    })
    it('水分: 検査は fluidAmountError（cc の文）・誤りは行の下に（何が違うか＋どうすればよいか）・足せたら欄を空にする', () => {
      // 2026-10-29 親の検収（固定し直し・意図は同じ）: 検査と取り出しは控え（createFluidInputs の take＝cc の文）で行い、送る前に欄を空にする。
      // 送れなかった時は入れた数を欄に戻す（日を移った後・入れ直した時は戻さない）。振る舞いは下の「水分の欄の控え」の試験で確かめる
      const f = page.slice(page.indexOf('const submitFluid = '), page.indexOf('const goDay = '))
      assert.match(page, /const \[fluidInputs\] = useState\(\(\) => createFluidInputs\('cc'\)\)/)
      assert.match(f, /const t = fluidInputs\.take\(rid\)\s+if \(t\.kind === 'ignored'\) return\s+if \(t\.kind === 'error'\) \{\s*noteFluid\(key, \{ tone: 'danger', text: t\.message, input: true \}\)\s*return\s*\}\s*setFluidText\(fluidInputs\.all\(\)\)\s*void addFluid\(rid, t\.ml\)/)
      assert.match(f, /if \(!ok && dayRef\.current === d && fluidInputs\.restore\(rid, t\.text\)\) setFluidText\(fluidInputs\.all\(\)\)/)
      assert.doesNotMatch(page, /setFluidText\(\(prev\)/, '欄の値は控えを通して書く（描画の前の古い値で送らない）')
      // 数を直したら誤りの知らせを外す
      assert.match(body, /if \(fn\?\.input === true\) noteFluid\(fkey, null\)/)
    })
    it('水分の欄の控え（2026-10-29 親の検収）: 同じ値で続けて2回押しても1回しか送らない・送れなかったら欄に戻す・入れ直した値は上書きしない', () => {
      assert.ok(DP !== null, String(loadError))
      const f = DP.createFluidInputs('cc')
      f.set(1, '150')
      // 改行キーが続けて2回届いた（1回目の書き込みの後、欄が空になる描き直しの前）: 送るのは1回だけ・2回目は誤りの文も出さない
      const sends = [f.take(1), f.take(1)].filter((t) => t.kind === 'send')
      assert.equal(sends.length, 1)
      assert.deepEqual(sends[0], { kind: 'send', ml: 150, text: '150' })
      assert.deepEqual(f.take(1), { kind: 'ignored' })
      assert.equal(f.all()[1], '', '送る前に欄を空にする')
      // 送れなかった: 欄が空のままなら戻す → もう一度押すと送れる
      assert.equal(f.restore(1, '150'), true)
      assert.equal(f.all()[1], '150')
      assert.equal(f.take(1).kind, 'send')
      // 送っている間に欄へ入れ直していたら、戻さない（入れ直した値を消さない）
      f.set(1, '80')
      assert.equal(f.restore(1, '150'), false)
      assert.equal(f.all()[1], '80')
      // 入れ直した後の空の改行キーは、ふつうの誤り（量を入れてください）
      f.set(1, '')
      assert.deepEqual(f.take(1), { kind: 'error', message: '量を入れてください。' })
      // 誤り・全角・人ごと・日の切り替え
      f.set(2, '2500')
      assert.deepEqual(f.take(2), { kind: 'error', message: '「2500」は足せません。量は 1〜2000 cc で入れてください。' })
      assert.equal(f.all()[2], '2500', '誤りの時は欄を残す')
      f.set(3, '８０')
      assert.deepEqual(f.take(3), { kind: 'send', ml: 80, text: '８０' })
      f.set(4, '50')
      f.clearAll()
      assert.deepEqual(f.all(), {})
      assert.deepEqual(f.take(4), { kind: 'error', message: '量を入れてください。' })
    })
    it('水分: insertFluid の送る値は1人の画面と同じ（taken_at は今日だけいまの時刻・過去の日は null・kind null・記録者）・送り先は押した時に固定', () => {
      const a = page.slice(page.indexOf('const addFluid = '), page.indexOf('const undoFluid = '))
      assert.match(a, /const d = day\s*const key = personKeyOf\(rid, d\)/)
      assert.match(a, /await insertFluid\(\{\s*resident_id: rid,\s*taken_on: d,\s*(\/\/[^\n]*\s*)*taken_at: d === todayIso\(\) \? nowHm\(\) : null,\s*amount_ml: ml,\s*kind: null,\s*recorded_by: actorId,\s*\}\)/)
      // 記録者・旗・未来の日は precheck（昼食と同じ）
      assert.match(a, /const why = precheck\(\)\s*if \(why !== null\) \{\s*noteFluid\(key, \{ tone: 'warn', text: why \}\)/)
      // 書けた行は日を移った後は入れない・〔元に戻す〕のトーストは日を移った後は出さない
      assert.match(a, /if \(prev !== null && prev\.day === saved\.taken_on\) \{/)
      assert.match(a, /if \(dayRef\.current === d\) \{\s*show\(`\$\{nameOf\(rid\)\}さんの水分 ＋\$\{fmtCc\(ml\)\} を記録しました`, \(\) => void undoFluid\(saved\)\)/)
      // 失敗の文
      assert.match(a, /e instanceof DbError \? e\.message : '保存できませんでした。通信状態を確認して、もう一度押してください。'/)
    })
    it('水分: 書き込み中はその方の欄（readOnly）と〔＋〕（disabled）を押せない・描画を待たずに二重に足さない', () => {
      assert.match(page, /if \(fluidBusyRef\.current\.has\(key\)\) return false\s*setBusyFor\(key, true\)/)
      assert.match(page, /\} finally \{\s*setBusyFor\(key, false\)\s*\}/)
      assert.match(page, /const submitFluid = \(rid: number\) => \{\s*const d = day\s*const key = personKeyOf\(rid, d\)\s*if \(fluidBusyRef\.current\.has\(key\)\) return/)
      assert.match(body, /readOnly=\{busy\}\s+disabled=\{!canWrite\}/)
    })
    it('水分: 送信待ちは合計に「（＋n cc 送信待ち）」を重ね、取り直した合計で載った分だけ減らす（1人の画面の queuedFluids と同じ）', () => {
      assert.match(page, /const r = nothingQueued \? null : settleQueuedFluid\(held, fluidTotalOf\(visibleFluids, Number\(ridText\), d\)\)/)
      assert.match(body, /計 <span className="font-num font-bold">\{fluidSum > 0 \? fmtCc\(fluidSum\) : '—'\}<\/span>/)
      assert.match(body, /\{held !== undefined \? <span className="text-sm text-ink2">（＋\{fmtCc\(held\.ml\)\} 送信待ち）<\/span> : null\}/)
      assert.match(body, /const fluidSum = fluidTotalOf\(visibleFluids, rid, data\.day\)/)
      // 送信待ちの間にオンラインで足した分は、基準も上げる（「送信待ちが載った」と見て減らさない）
      assert.match(page, /return held === undefined \? q : \{ \.\.\.q, \[key\]: \{ \.\.\.held, base: held\.base \+ saved\.amount_ml \} \}/)
      // 合計は fetchDaycareIntake の fluids（その方・その日の全部）
      assert.match(page, /const fluids = intake\.fluids\.filter\(/)
      assert.match(page, /if \(table === 'meals' \|\| table === 'fluid_intake'\) onChange\(table, info\)/)
    })
    it('水分の〔元に戻す〕は softDeleteFluid（1人の画面の removeFluid(fromUndo) と同じ扱い）・送信待ちの取り消しは合計から外す', () => {
      const u = page.slice(page.indexOf('const undoFluid = '), page.indexOf('const submitFluid = '))
      assert.match(u, /const r = await softDeleteFluid\(f\.id, f\.rev, \{ editedBy: actorId \}\)/)
      assert.match(u, /setHiddenFluidIds\(\(prev\) => new Map\(\[\.\.\.prev, \[f\.id, f\.taken_on\]\]\)\)/)
      assert.match(u, /if \(prev !== null\) commitData\(\{ \.\.\.prev, fluids: prev\.fluids\.filter\(\(x\) => x\.id !== f\.id\) \}\)/)
      // 取り消せた時のトーストは出さない（〔元に戻す〕から呼ぶだけ）
      assert.doesNotMatch(u, /show\(/)
    })
    it('氏名・記録を端末に残さない・console に出さない（localStorage・sessionStorage を使わない）', () => {
      assert.doesNotMatch(page, /localStorage|sessionStorage|console\./)
    })
  })

  describe('配線（切り替え・ルート・画面名）と、care-log の食事一括を変えていないこと', () => {
    it('デイの切り替えは「今日／バイタル一括／食事一括／活動一括／機能訓練」の順（2026-10-24「活動をまとめて」→「活動一括」・ルートと key は変えない）', () => {
      const p = code('../src/pages/DaycarePage.tsx')
      const nav = p.slice(p.indexOf('export function DaycareNav'), p.indexOf('return (', p.indexOf('export function DaycareNav')))
      assert.deepEqual(
        [...nav.matchAll(/\{ key: '(\w+)', to: '([^']+)', label: '([^']+)' \}/g)].map((m) => [m[1], m[2], m[3]]),
        [
          ['today', '/record/daycare', '今日（到着・休み）'],
          ['vitals', '/record/daycare/vitals', 'バイタル一括'],
          ['meals', '/record/daycare/meals', '食事一括'],
          ['activity', '/record/daycare/bulk', '活動一括'],
          ['training', '/record/daycare/training', '機能訓練'],
        ],
      )
      // 2026-10-25（§9.7）: 食事一括の次に〔排泄〕（別のアプリ＝a・同じタブ・押した直前に受け渡しのキーを書く）
      const full = p.slice(p.indexOf('export function DaycareNav'), p.indexOf('/** 予定の帯'))
      assert.match(full, /\.\.\.\(it\.key === 'meals' \? \[excretion\] : \[\]\)/)
      assert.match(full, /<a\s+key="excretion"\s+href=\{HAIBEN_DAYCARE_HREF\}\s+onClick=\{\(\) => handoff\?\.\(\)\}/)
      assert.match(full, /排泄<span className="ml-1 text-sm">（別アプリ）<\/span>/)
      assert.doesNotMatch(full, /target="_blank"/, '同じタブで開く')
      assert.match(code('../src/pages/DaycareMealsPage.tsx'), /<DaycareNav current="meals" handoff=\{\(\) => writeDaycareHandoffFor\(\{ rows: board\?\.rows \?\? null, residents, boardDay: data\?\.day \?\? null, today \}\)\} \/>/)
    })
    it('App.tsx: ルート・画面名・遅れて読む', () => {
      const a = code('../src/App.tsx')
      assert.match(a, /<Route path="\/record\/daycare\/meals" element=\{<DaycareMealsPage actorId=\{actorId\} staff=\{staff\} \/>\} \/>/)
      assert.match(a, /if \(pathname === '\/record\/daycare\/meals'\) return 'デイ 食事一括'/)
      assert.match(a, /const loadDaycareMealsPage = \(\) => import\('\.\/pages\/DaycareMealsPage'\)/)
    })
    it('care-log の食事一括（MealsGridPage）は読み込まず・変えない（デイの画面から import しない）', () => {
      const page = code('../src/pages/DaycareMealsPage.tsx')
      assert.doesNotMatch(page, /MealsGridPage/)
    })
  })
}
