// デイ（せせらぎ）段階2a: 1人の1日記録の回帰テスト（2026-10-22・代表者承認・段階2の計画 v1）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycarePerson.ts）: 昼食・おやつの表示・取り込みの印・水分の合計と量の検査・排泄ケアアプリの入口・
//    前の方／次の方・業務日の URL
// 2. db.ts を偽の Supabase で動かす（通信しない）: fetchDaycareIntake が昼食・おやつの取り込みの印（import_key・edited_by）と水分を読む
// 3. 静的検査: 既存の保存関数だけで書く（新しい書き込みの経路を作らない）・排泄ケアアプリへ書かない・既存の食事の読み込み（MEAL_COLS）は
//    変えない・ルート・types.ts と移行に触れない・端末に業務データを残さない
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

const lsStore = new Map()
let DP = null
let DB = null
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
  globalThis.localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => {
      lsStore.set(k, String(v))
    },
    removeItem: (k) => {
      lsStore.delete(k)
    },
  }
  DP = await import('../src/lib/daycarePerson.ts')
  DB = await import('../src/lib/db.ts?daycare-person')
} catch (e) {
  loadError = e
  DP = null
}

if (DP === null) {
  registerLoadFailure('デイ 段階2a（1人の1日記録）の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('昼食・おやつの表示', () => {
    it('昼食: 拒食・外出・入院・割合・片方だけ・記録なし', () => {
      assert.equal(DP.lunchLabel(null), '記録なし')
      assert.equal(DP.lunchLabel({ main_amount: 7, side_amount: 5, status: 'eaten' }), '主食 7割・副食 5割')
      assert.equal(DP.lunchLabel({ main_amount: 7, side_amount: null, status: null }), '主食 7割・副食 —')
      assert.equal(DP.lunchLabel({ main_amount: null, side_amount: null, status: null }), '記録なし')
      assert.equal(DP.lunchLabel({ main_amount: 3, side_amount: 3, status: 'refused' }), '拒食')
      assert.equal(DP.lunchLabel({ main_amount: null, side_amount: null, status: 'out' }), '外出')
      assert.equal(DP.lunchLabel({ main_amount: null, side_amount: null, status: 'hospital' }), '入院')
    })
    it('おやつ: 3択の名前（10／5／0）・それ以外は割合・拒食は食べない', () => {
      assert.deepEqual(DP.DAYCARE_SNACK_CHOICES.map((c) => [c.label, c.value]), [['全部', 10], ['半分', 5], ['食べない', 0]])
      assert.equal(DP.snackLabel({ main_amount: 10, status: null }), '全部')
      assert.equal(DP.snackLabel({ main_amount: 5, status: 'eaten' }), '半分')
      assert.equal(DP.snackLabel({ main_amount: 0, status: null }), '食べない')
      assert.equal(DP.snackLabel({ main_amount: 7, status: null }), '7割')
      assert.equal(DP.snackLabel({ main_amount: 7, status: 'refused' }), '食べない')
      assert.equal(DP.snackLabel(null), '記録なし')
    })
    it('昼食の割合は既存の食事一括と同じ 0〜10 の11段階', () => {
      assert.deepEqual(DP.DAYCARE_MEAL_AMOUNTS, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      assert.match(code('../src/pages/MealsGridPage.tsx'), /const AMOUNTS = \[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10\] as const/)
    })
    it('取り込みの印: 取り込んだまま／取り込んだ後に画面で直した／画面で入力／行なし', () => {
      assert.equal(DP.mealSourceLabel({ imported: true, editedInApp: false }), 'スプレッドシートから取り込み')
      assert.equal(DP.mealSourceLabel({ imported: true, editedInApp: true }), '取り込み後に画面で直した')
      assert.equal(DP.mealSourceLabel({ imported: false, editedInApp: true }), '画面で入力')
      assert.equal(DP.mealSourceLabel(null), null)
    })
  })

  describe('水分', () => {
    it('その方・その日の合計だけ（ほかの方・ほかの日は数えない）', () => {
      const f = [
        { resident_id: 1, taken_on: '2026-10-22', amount_ml: 150 },
        { resident_id: 1, taken_on: '2026-10-22', amount_ml: 200 },
        { resident_id: 2, taken_on: '2026-10-22', amount_ml: 100 },
        { resident_id: 1, taken_on: '2026-10-21', amount_ml: 300 },
      ]
      assert.equal(DP.fluidTotalOf(f, 1, '2026-10-22'), 350)
      assert.equal(DP.fluidTotalOf(f, 3, '2026-10-22'), 0)
    })
    it('ほかの量: 全角・空白は受け付け、範囲外・小数・空・文字は理由', () => {
      assert.equal(DP.fluidAmountError('１５０'), null)
      assert.equal(DP.fluidAmountError(' 80 '), null)
      assert.equal(DP.fluidAmountError('2000'), null)
      assert.match(DP.fluidAmountError('2001'), /1〜2000/)
      assert.match(DP.fluidAmountError('0'), /1〜2000/)
      assert.match(DP.fluidAmountError('1.5'), /整数/)
      assert.match(DP.fluidAmountError('abc'), /整数/)
      assert.match(DP.fluidAmountError(''), /入れて/)
      assert.deepEqual(DP.DAYCARE_FLUID_STEPS, [100, 150, 200])
    })
  })

  describe('送信待ちの水分の消し込み（2a の反証 中4）', () => {
    it('載ったと観測できた分だけ減らし、残りが無ければ消す（既存の食事・水分の一括入力と同じ）', () => {
      assert.deepEqual(DP.settleQueuedFluid({ base: 150, ml: 200 }, 150), { base: 150, ml: 200 }, 'まだ載っていない')
      assert.deepEqual(DP.settleQueuedFluid({ base: 150, ml: 350 }, 350), { base: 350, ml: 150 }, '一部（200）だけ載った')
      assert.equal(DP.settleQueuedFluid({ base: 150, ml: 200 }, 350), null, '全部載った')
      assert.equal(DP.settleQueuedFluid({ base: 150, ml: 200 }, 500), null, '別の端末の分も増えた')
      // 合計が減った時（取り消し）は送信待ちの量を増やさず、基準だけ下げる（2a の確認の反証 中1）
      assert.deepEqual(DP.settleQueuedFluid({ base: 150, ml: 200 }, 0), { base: 0, ml: 200 }, '先に 150 の行が取り消された')
      assert.equal(DP.settleQueuedFluid({ base: 0, ml: 200 }, 200), null, 'その後に 200 が載った')
      // 確認の反証の例A: 外した行を除いた合計で数えると、取り消し（−150）と追加（＋100）が両方届いた後に残らない
      assert.equal(DP.settleQueuedFluid({ base: 200, ml: 100 }, 300), null, '外した行を除いた基準 200 → 300')
    })
  })

  describe('排泄ケアアプリの入口・前の方／次の方・業務日', () => {
    it('入口は care-tools の排泄ケアアプリ（相対パス）＋?masterId=source_id。受け付けない形は最初の画面', () => {
      assert.equal(DP.haibenAppHref('M001'), '../care-tools/haiben-record.html?masterId=M001')
      assert.equal(DP.haibenAppHref(' wm_12-a '), '../care-tools/haiben-record.html?masterId=wm_12-a')
      assert.equal(DP.haibenAppHref('見本 一郎'), '../care-tools/haiben-record.html', '氏名など受け付けない形は付けない')
      assert.equal(DP.haibenAppHref(''), '../care-tools/haiben-record.html')
      assert.equal(DP.haibenAppHref(null), '../care-tools/haiben-record.html')
      assert.equal(DP.haibenAppHref('x'.repeat(33)), '../care-tools/haiben-record.html')
    })
    it('前の方／次の方は在席・帰宅の方だけを一覧の並びで回る（欠席・未到着は飛ばす）', () => {
      const rows = [
        { residentId: 1, state: 'present' },
        { residentId: 2, state: 'absent' },
        { residentId: 3, state: 'planned' },
        { residentId: 4, state: 'left' },
        { residentId: 5, state: 'present' },
      ]
      assert.deepEqual(DP.personNav(rows, 1), { prev: null, next: 4 })
      assert.deepEqual(DP.personNav(rows, 4), { prev: 1, next: 5 })
      assert.deepEqual(DP.personNav(rows, 5), { prev: 4, next: null })
      assert.deepEqual(DP.personNav(rows, 3), { prev: 5, next: 1 }, '在席でない方を開いている時は端へ')
      assert.deepEqual(DP.personNav([], 3), { prev: null, next: null })
    })
    it('業務日の URL: 今日は付けない・過去の日は ?day=・壊れた値と未来の日は今日', () => {
      assert.equal(DP.personPath(7, '2026-10-22', '2026-10-22'), '/record/daycare/person/7')
      assert.equal(DP.personPath(7, '2026-10-21', '2026-10-22'), '/record/daycare/person/7?day=2026-10-21')
      assert.equal(DP.readPersonDay('2026-10-21', '2026-10-22'), '2026-10-21')
      assert.equal(DP.readPersonDay('2026-10-23', '2026-10-22'), '2026-10-22')
      assert.equal(DP.readPersonDay('2026-02-30', '2026-10-22'), '2026-10-22')
      assert.equal(DP.readPersonDay('x', '2026-10-22'), '2026-10-22')
      assert.equal(DP.readPersonDay(null, '2026-10-22'), '2026-10-22')
    })
  })

  describe('fetchDaycareIntake（偽の Supabase）', () => {
    it('昼食・おやつだけを取り込みの印つきで読み、水分も読む（書き込みはしない）', async () => {
      const calls = []
      const rows = {
        meals: [
          { id: 1, resident_id: 1, meal_on: '2026-10-22', meal_slot: 'lunch', main_amount: 7, side_amount: 5, status: 'eaten', note: null, recorded_by: null, rev: 1, import_key: 'imp-1', edited_by: null },
          { id: 2, resident_id: 2, meal_on: '2026-10-22', meal_slot: 'lunch', main_amount: 3, side_amount: 3, status: 'eaten', note: null, recorded_by: 4, rev: 2, import_key: 'imp-2', edited_by: 4 },
          { id: 3, resident_id: 3, meal_on: '2026-10-22', meal_slot: 'snack', main_amount: 10, side_amount: null, status: null, note: null, recorded_by: 4, rev: 1, import_key: null, edited_by: 4 },
        ],
        fluid_intake: [{ id: 9, resident_id: 1, taken_on: '2026-10-22', taken_at: '10:30:00', amount_ml: 150, kind: null, recorded_by: 4, rev: 1, created_at: 'x' }],
      }
      const builder = (table) => {
        const q = { table, filters: [], cols: null }
        const b = {
          select(c) {
            q.cols = c
            return b
          },
          eq(k, v) {
            q.filters.push(['eq', k, v])
            return b
          },
          in(k, v) {
            q.filters.push(['in', k, v])
            return b
          },
          is() {
            return b
          },
          order() {
            return b
          },
          limit() {
            return b
          },
          then(ok, ng) {
            calls.push(q)
            return Promise.resolve({ data: rows[table] ?? [], error: null, status: 200 }).then(ok, ng)
          },
        }
        return b
      }
      const client = {
        from: builder,
        rpc: () => {
          throw new Error('rpc を呼ばない')
        },
        channel: () => {
          const ch = { on: () => ch, subscribe: () => ch }
          return ch
        },
        removeChannel: () => Promise.resolve(),
        auth: {
          onAuthStateChange() {
            return { data: { subscription: { unsubscribe() {} } } }
          },
          getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1' } } }, error: null }),
        },
      }
      DB.__testHooks.setClient(client)
      const r = await DB.fetchDaycareIntake('2026-10-22')
      assert.deepEqual(
        r.meals.map((m) => [m.meal.id, m.imported, m.editedInApp]),
        [
          [1, true, false],
          [2, true, true],
          [3, false, true],
        ],
      )
      assert.equal(r.fluids.length, 1)
      const mq = calls.find((c) => c.table === 'meals')
      assert.match(mq.cols, /,import_key,edited_by$/)
      assert.ok(mq.filters.some(([op, k, v]) => op === 'in' && k === 'meal_slot' && JSON.stringify(v) === JSON.stringify(['lunch', 'snack'])))
      assert.ok(calls.every((c) => c.table === 'meals' || c.table === 'fluid_intake'), '読むのは食事と水分だけ')
      DB.__testHooks.setClient(null)
    })
  })

  describe('静的検査（段階2a の規律）', () => {
    const page = code('../src/pages/DaycarePersonPage.tsx')
    it('書き込みは既存の saveMealEdits・insertFluid・softDeleteFluid・discardPendingRow だけ（新しい書き込みの経路を作らない）', () => {
      const writes = page.match(/\b(save\w+|insert\w+|update\w+|delete\w+|softDelete\w+|upsert\w+|discard\w+)\(/g) ?? []
      const names = [...new Set(writes.map((w) => w.slice(0, -1)))].sort()
      assert.deepEqual(names, ['discardPendingRow', 'insertFluid', 'saveMeal', 'saveMealEdits', 'softDeleteFluid'])
      assert.doesNotMatch(page, /supabase|\.from\(|\.rpc\(/)
    })
    it('排泄ケアアプリへは書かない（読むのは fetchExcretion だけ・入口はリンクだけ）・excretionClient は変えていない', () => {
      assert.match(page, /fetchExcretion\(/)
      assert.match(page, /href=\{haibenAppHref\(resident\?\.source_id\)\}/)
      assert.doesNotMatch(page, /hbcr_|haiben-api|script\.google\.com/)
      const ex = code('../src/lib/excretionClient.ts')
      assert.match(ex, /action: 'getAll'/)
    })
    it('昼食は取り込みの値を初めの値に見せ、保存は edited_by つき（取り込みは画面で直した行を上書きしない）', () => {
      assert.match(page, /editedBy: actorId,/)
      assert.match(page, /mealSourceLabel\(lunchRow\)/)
    })
    it('2a の反証の直し（重大1・中2〜5）', () => {
      // 重大1: 重ねて出すのは送信待ち（pending）だけ。止まった・拒まれた値は欄の下で知らせ、読み込みの後に出し直す
      assert.match(page, /if \(p === null \|\| p\.state !== 'pending'\) return cur/)
      assert.match(page, /if \(p !== null && p\.state !== 'pending'\) \{\s*if \(p\.state === 'rejected'\) st = /)
      // 確認の反証 中2: 出し直しは読み込みの後だけでなく、送信待ちが動いた時（背景の再送で止まった・拒まれた・届いた）にも走る
      assert.match(page, /\}, \[data, residentId, queueTick\]\)/)
      assert.match(page, /\(cur\.kind === 'queued' && p === null\)\)\) \{[\s\S]{0,120}?st = undefined/)
      // 確認の反証 軽3（この直しで入った退行）: 人・日の切り替えと〔最新に更新〕で、その場限りの知らせを外す
      assert.match(page, /if \(v\.kind !== 'saved' && v\.kind !== 'error'\) next\[k\] = v/)
      assert.match(page, /setFluidMsg\(\(m\) => \(m !== null && m\.queued !== undefined \? m : null\)\)/)
      assert.doesNotMatch(page, /〔最新に更新〕で読み直してください/)
      // 中2: 〔元に戻す〕はオンラインで実際に書けた時だけ・送信待ちでは出さない
      assert.match(page, /if \(r === 'queued'\) \{[\s\S]{0,300}?setMealFor\(t, \{ kind: 'queued', persisted: isQueuePersisted\(\) \}\)\s*return\s*\}/)
      assert.match(page, /if \(opts\.undoable !== false && r\.applied\.length > 0 && here\(\)\) \{/)
      // 中3: 状態は人・日・枠ごと。送り先は押した時の target、解く操作は状態が持つ target
      assert.match(page, /const mealKeyOf = \(t: MealTarget\) => `\$\{t\.residentId\}:\$\{t\.day\}:\$\{t\.slot\}`/)
      assert.match(page, /onTake=\{\(t, fields\) => void resolveTake\(t, fields\)\}/)
      assert.match(page, /onMine=\{\(t, cs\) => void resolveMine\(t, cs\)\}/)
      assert.match(page, /fluidMsg !== null && fluidMsg\.key === personKey/)
      // 中4: 送信待ちの水分を合計と一覧に重ね、取り直しで消し込む。取り消しの送信待ちは行を先に外す
      assert.match(page, /const fluidTotal = fluidTotalOf\(fluidsOf, residentId, data\.day\) \+ \(queuedNow\?\.ml \?\? 0\)/)
      // 確認の反証 中1: 消し込みの合計は、取り消しを送信待ちにして外した行を除く（退避の時の基準も同じ）。未送信0件なら残さない
      assert.match(page, /const visible = data\.fluids\.filter\(\(f\) => !hiddenFluidIds\.has\(f\.id\)\)/)
      assert.match(page, /settleQueuedFluid\(held, fluidTotalOf\(visible, Number\(ridText\), d\)\)/)
      assert.match(page, /data\.fluids\.filter\(\(x\) => !hiddenFluidIds\.has\(x\.id\)\)/)
      assert.match(page, /const nothingQueued = queuePending\(\) === 0/)
      // 確認の反証 軽4: 外した行は、その行の日の読み込みで消えた時だけ戻す
      assert.match(page, /setHiddenFluidIds\(\(prev\) => new Map\(\[\.\.\.prev, \[f\.id, f\.taken_on\]\]\)\)/)
      assert.match(page, /\(\[id, d\]\) => d === data\.day && !data\.fluids\.some\(\(f\) => f\.id === id\)/)
      // 確認の反証 軽7: 〔拒食〕の文言は #15 の形（拒食の時は〔拒食を取り消す〕）に戻す
      assert.match(page, /\{lunch\?\.status === 'refused' \? '拒食を取り消す' : '拒食'\}/)
      // 中5: 拒食・外出・入院の行は、割合・おやつのボタンで「食べた」に戻して送る
      assert.match(page, /status === null \|\| status === undefined \|\| status === 'eaten' \? patch : \{ \.\.\.patch, status: 'eaten' \}/)
      assert.match(page, /onClick=\{\(\) => void saveMeal\(targetOf\('lunch'\), withEaten\(lunch\?\.status, \{ \[f\]: n \}\)\)\}/)
      assert.match(page, /onClick=\{\(\) => void saveMeal\(targetOf\('snack'\), withEaten\(snack\?\.status, \{ main_amount: c\.value \}\)\)\}/)
      // 画面での確認で見つけた2点: 送信待ちの一言は届いたら外す・拒まれた直後から〔取り下げる〕を出す
      assert.match(page, /if \('add' in m\.queued\) return queuedFluids\[m\.key\] === undefined \? null : m/)
      assert.match(page, /\}, \[queuedFluids, data\]\)/)
      assert.match(page, /p !== null && p\.state === 'rejected' \? \{ kind: 'rejected', target: t, reason: text \} : \{ kind: 'error', text \}/)
    })
    it('過去の日の水分にいまの時刻を入れない', () => {
      assert.match(page, /taken_at: d === todayIso\(\) \? nowHm\(\) : null/)
    })
    it('既存の食事の読み込み（MEAL_COLS）は変えず、取り込みの印は新しい関数でだけ読む', () => {
      const db = code('../src/lib/db.ts')
      assert.match(db, /const MEAL_COLS = 'id,resident_id,meal_on,meal_slot,main_amount,side_amount,status,note,recorded_by,rev'/)
      assert.match(db, /\.select\(`\$\{MEAL_COLS\},import_key,edited_by`\)/)
      assert.equal((db.match(/import_key,edited_by/g) ?? []).length, 1)
    })
    it('ルート・見出し・デイの一覧からの入口', () => {
      const app = code('../src/App.tsx')
      assert.match(app, /<Route path="\/record\/daycare\/person\/:residentId" element=\{<DaycarePersonPage actorId=\{actorId\} staff=\{staff\} \/>\} \/>/)
      assert.match(app, /if \(pathname\.startsWith\('\/record\/daycare\/person\/'\)\) return 'デイ 1人の記録'/)
      const day = code('../src/pages/DaycarePage.tsx')
      assert.match(day, /to=\{personPath\(row\.residentId, day, today\)\}/)
    })
    it('端末に業務データを残さない（localStorage を使わない）・types.ts と移行に触れない', () => {
      assert.doesNotMatch(page, /localStorage/)
      assert.doesNotMatch(code('../src/lib/daycarePerson.ts'), /localStorage/)
      const migs = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort()
      assert.equal(migs.at(-1), '0043_daycare_past_guard_more.sql', '段階2a は移行を足さない')
    })
  })
}
