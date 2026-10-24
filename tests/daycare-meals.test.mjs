// デイ せせらぎ 今日の画面の改善 2回目: 昼食・おやつの一括入力（/record/daycare/meals）の回帰テスト（2026-10-24・代表承認・決定 6／親の回答 1〜2）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycarePerson.ts）: 並べる方（在席・帰宅だけ・一覧の並びのまま）・画面のルート・帯の端の保存の印
// 2. 静的検査: 書き込みは既存の saveMealEdits・discardPendingRow だけ・決まりは1人の画面と同じ（送り先の固定・送信待ちの重ね方・
//    拒食から戻す・〔元に戻す〕はオンラインで書けた時だけ・旗と未来の日）・切り替えとルートと画面名・care-log の食事一括は変えない・
//    端末に業務データを残さない・「自動」の文字を出さない・押せる範囲 44px と角
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
    it('書き込みは既存の saveMealEdits・discardPendingRow だけ（新しい書き込みの経路を作らない）・supabase を直に呼ばない', () => {
      const writes = page.match(/\b(save\w+|insert\w+|update\w+|delete\w+|softDelete\w+|upsert\w+|discard\w+)\(/g) ?? []
      const names = [...new Set(writes.map((w) => w.slice(0, -1)))].sort()
      assert.deepEqual(names, ['discardPendingRow', 'saveMeal', 'saveMealEdits'])
      assert.doesNotMatch(page, /supabase|\.from\(|\.rpc\(|console\./)
    })
    it('並べる方は mealBulkRows（その日の一覧から）・読み込みは fetchDaycareIntake（昼食・おやつ）', () => {
      assert.match(page, /mealBulkRows\(board\.rows\)/)
      assert.match(page, /fetchDaycareIntake\(target\)/)
    })
    it('決まりは1人の画面と同じ: 送り先は押した時の人・日・枠／記入者は新しい行だけ／edited_by／rebase', () => {
      assert.match(page, /const targetOf = \(residentId: number, slot: MealSlot2\): MealTarget => \(\{ residentId, day, slot \}\)/)
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
    it('割合・おやつのボタンは拒食なら「食べた」に戻して送る・状態は「食べた／拒食」だけ（外出・入院のボタンは出さない）', () => {
      assert.match(page, /onClick=\{\(\) => void saveMeal\(lt, withEaten\(lunch\?\.status, \{ \[f\]: n \}\)\)\}/)
      assert.match(page, /onClick=\{\(\) => void saveMeal\(stg, withEaten\(snack\?\.status, \{ main_amount: c\.value \}\)\)\}/)
      assert.match(page, /onClick=\{\(\) => void saveMeal\(lt, \{ status: lunch\?\.status === 'refused' \? 'eaten' : 'refused' \}\)\}/)
      assert.doesNotMatch(page, /status: 'out'|status: 'hospital'/)
      assert.match(page, /DAYCARE_MEAL_AMOUNTS\.map/)
      assert.match(page, /DAYCARE_SNACK_CHOICES\.map/)
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
    it('押せる範囲 44px（min-h-tap・min-w-tap）・角は rounded（6px）・rounded-full を使わない・並びは em の CSS（.dc-meal-row）', () => {
      assert.match(page, /'min-h-tap min-w-tap rounded border-2 border-primary/)
      assert.match(page, /'min-h-tap min-w-tap rounded border border-border-strong/)
      assert.doesNotMatch(page, /rounded-full/)
      assert.match(page, /className="dc-meal-row p-3"/)
      const css = read('../src/index.css')
      assert.match(css, /@media \(min-width: 60em\) \{\s*\.dc-meal-row \{\s*grid-template-columns: 11rem minmax\(0, 1fr\);/)
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
      assert.match(page, /<LoadingBlock label="その日の昼食・おやつを読み込んでいます…" \/>/)
      assert.match(page, /<ErrorBlock message=\{error\} onRetry=\{\(\) => setReloadKey\(\(n\) => n \+ 1\)\} \/>/)
      assert.match(page, /この日の予定の方がいません（休み・入院中の方は出しません）。予定外で来た方は、今日の画面の〔予定にない方を追加〕から到着を記録すると、ここに出ます。/)
      assert.doesNotMatch(page, /来た方（在席・帰宅）/)
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
      assert.match(code('../src/pages/DaycareMealsPage.tsx'), /<DaycareNav current="meals" \/>/)
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
