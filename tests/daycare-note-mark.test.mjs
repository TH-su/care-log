// デイ（せせらぎ）段階2c: 申し送りの印の回帰テスト（2026-10-22・代表者承認・段階2の計画 v1 の 2.2／8章 V10）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycareNoteMark.ts）: 鍵の作りと読み方・世代（取り消した分も数える・送信待ちも数える）・分類・
//    本文（ひと言）・元の記録が変わったかの判定・記録ごとの文
// 2. db.ts を偽の Supabase で動かす（通信しない）: fetchDaycareNoteMarks の絞り込み（日・利用者・区分・鍵の頭）と、
//    取り消した申し送りも読むこと（世代を数えるため）
// 3. 静的検査: 申し送りへの書き込みは印の部品の中だけで、既存の insertNote・deleteNote・saveNoteEdits だけを使う・
//    1人の記録の画面と活動の欄は申し送りへ書かない・移行を足さない・types.ts と notes の表に触れない
// 4. 2026-11-10 1人の画面の印の守り（src/lib/daycareNoteMarkPerson.ts を部品と同じ手順で動かす）: 古い読み込みを捨てる・送っている最中に
//    人・日を替えても前の方の読み直しを表示中の方の印に入れない・送れた行を読み直しの失敗で消さない・取り消した行を戻さない
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
let M = null
let DB = null
/** 1人の画面の印の読み込みの判断の純関数（daycareNoteMarkPerson.ts・2026-11-10 1人の画面の印の守り） */
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
  globalThis.localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => {
      lsStore.set(k, String(v))
    },
    removeItem: (k) => {
      lsStore.delete(k)
    },
  }
  M = await import('../src/lib/daycareNoteMark.ts')
  P = await import('../src/lib/daycareNoteMarkPerson.ts')
  DB = await import('../src/lib/db.ts?daycare-note-mark')
} catch (e) {
  loadError = e
  M = null
}

if (M === null) {
  registerLoadFailure('デイ 段階2c（申し送りの印）の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('純ロジック（daycareNoteMark.ts）', () => {
    it('鍵: dcn:<日>:<利用者id>:<記録>:<世代>-<送るたびの印>。水分・活動は行の id（別の回の水分は別の鍵＝別の申し送り）', () => {
      assert.equal(M.markKey('2026-10-22', 7, { kind: 'lunch' }, 1, 'k3x9'), 'dcn:2026-10-22:7:lunch:1-k3x9')
      assert.equal(M.markKey('2026-10-22', 7, { kind: 'fluid', id: 31 }, 2, 'a1'), 'dcn:2026-10-22:7:fl31:2-a1')
      assert.equal(M.markKey('2026-10-22', 7, { kind: 'activity', id: 5 }, 1, 'zz'), 'dcn:2026-10-22:7:ac5:1-zz')
      assert.throws(() => M.markKey('2026-10-22', 7, { kind: 'lunch' }, 1, 'A-B'), /token/)
      // 2c の反証 重大2・中3・中4: 同じ世代でも送るたびの印が違えば別の鍵（別の端末・取り消した申し送りに当たらない）
      assert.notEqual(M.markKey('2026-10-22', 7, { kind: 'snack' }, 1, 'aaaa'), M.markKey('2026-10-22', 7, { kind: 'snack' }, 1, 'bbbb'))
      assert.deepEqual(M.parseMarkKey('dcn:2026-10-22:7:lunch:3-k3x9'), { day: '2026-10-22', residentId: 7, what: 'lunch', gen: 3 })
      assert.notEqual(M.markPrefix('2026-10-22', 7, { kind: 'fluid', id: 31 }), M.markPrefix('2026-10-22', 7, { kind: 'fluid', id: 32 }))
      assert.equal(M.markDayPrefix('2026-10-22', 7), 'dcn:2026-10-22:7:')
      assert.deepEqual(M.parseMarkKey('dcn:2026-10-22:7:fl31:2'), { day: '2026-10-22', residentId: 7, what: 'fl31', gen: 2 })
      assert.equal(M.parseMarkKey('dc:2026-10-22:7:1'), null, 'デイのバイタルの鍵（dc:）は印ではない')
      assert.equal(M.parseMarkKey('dcn:2026-10-22:7:lunch:0'), null)
      assert.equal(M.parseMarkKey('dcn:2026-10-22:7:dinner:1'), null)
      assert.equal(M.parseMarkKey(null), null)
    })
    it('世代: 取り消した申し送りも送信待ちの登録も数えて最大＋1（外した後に付け直せる）。ほかの記録の鍵は数えない', () => {
      const p = M.markPrefix('2026-10-22', 7, { kind: 'lunch' })
      assert.equal(M.nextGen(p, []), 1)
      assert.equal(M.nextGen(p, ['dcn:2026-10-22:7:lunch:1']), 2, '1 を取り消した後は 2')
      assert.equal(M.nextGen(p, ['dcn:2026-10-22:7:lunch:1', 'dcn:2026-10-22:7:lunch:3', 'dcn:2026-10-22:7:snack:9', 'dcn:2026-10-22:8:lunch:5']), 4)
      assert.equal(M.nextGen(p, ['dcn:2026-10-22:7:lunch:2-k3x9', 'dcn:2026-10-22:7:lunch:1']), 3, 'token つきの鍵も #21 の版の鍵も数える')
    })
    it('分類: 食事・おやつ・水分→食事／バイタル・排泄→体調／活動→付けない', () => {
      assert.deepEqual(M.markCategories('lunch'), ['食事'])
      assert.deepEqual(M.markCategories('snack'), ['食事'])
      assert.deepEqual(M.markCategories('fluid'), ['食事'])
      assert.deepEqual(M.markCategories('vital'), ['体調'])
      assert.deepEqual(M.markCategories('ex'), ['体調'])
      assert.deepEqual(M.markCategories('activity'), [])
    })
    it('本文はひと言を「。」でつなぐ（ひと言は入れたまま・書き換えない）。いまの記録と違うかは、本文がいまの文で始まるかで見る', () => {
      assert.equal(M.markBody('昼食 主食 7割・副食 5割', ''), '昼食 主食 7割・副食 5割')
      assert.equal(M.markBody('昼食 主食 7割・副食 5割', '  完食に近い　'), '昼食 主食 7割・副食 5割。完食に近い')
      // 2c の反証 軽10（原則6）: 全角・半角・記号を書き換えない
      assert.equal(M.markBody('おやつ 半分', 'ｶﾅ ＡＢＣ ㈱  2つ'), 'おやつ 半分。ｶﾅ ＡＢＣ ㈱  2つ')
      assert.equal(M.isStale('昼食 主食 7割・副食 5割。完食に近い', '昼食 主食 7割・副食 5割'), false)
      assert.equal(M.isStale('昼食 主食 7割・副食 5割', '昼食 主食 7割・副食 5割'), false)
      assert.equal(M.isStale('昼食 主食 7割・副食 5割', '昼食 主食 9割・副食 5割'), true)
      assert.equal(M.isStale('昼食 主食 7割', null), true, '記録が無くなった')
      // 2c の反証 中5: 日報で空白に続けて足しただけの申し送りは「違う」にしない。数字の続き（150 と 1500）は違う
      assert.equal(M.isStale('昼食 主食 7割・副食 5割 声かけで完食', '昼食 主食 7割・副食 5割'), false)
      assert.equal(M.isStale('水分 10:30 1500 ml', '水分 10:30 150 ml'), true)
      assert.equal(M.isStale('昼食 主食 10割・副食 5割', '昼食 主食 1割・副食 5割'), true)
      // 〔申し送りを直す〕の全文の案: 確かな時だけ「。」の後ろ（ひと言・足した文）を引き継ぐ。前の記録の切れ端は入れない
      assert.equal(M.fixProposal('昼食 主食 7割・副食 5割。むせ込みあり', '昼食 主食 5割・副食 5割'), '昼食 主食 5割・副食 5割。むせ込みあり')
      assert.equal(M.fixProposal('昼食 主食 7割・副食 5割', '昼食 主食 5割・副食 5割'), '昼食 主食 5割・副食 5割')
      // 2c の直しの確認の反証 中1: 記録の文が短くなった時に、前の値の切れ端（（一部）・脈 70・下剤 1回）を入れない
      assert.equal(M.fixProposal('活動 体操（一部）', '活動 体操'), '活動 体操')
      assert.equal(M.fixProposal('バイタル 体温 36.5℃・血圧 120/80・脈 70', 'バイタル 体温 36.5℃・血圧 120/80'), 'バイタル 体温 36.5℃・血圧 120/80')
      assert.equal(M.fixProposal('排泄 排尿 3回・排便 1回・下剤 1回', '排泄 排尿 3回・排便 1回'), '排泄 排尿 3回・排便 1回')
      // 自由入力の活動の項目に「。」がある時は引き継がない（どこまでが項目か分からない。小窓に前の申し送りを出して直させる）
      assert.equal(M.fixProposal('活動 散歩。公園まで。ふらつき', '活動 散歩。公園まで（一部）'), '活動 散歩。公園まで（一部）')
      assert.equal(M.fixProposal('昼食 主食 7割・副食 5割。', '昼食 主食 5割・副食 5割'), '昼食 主食 5割・副食 5割')
      assert.equal(M.markCommentError('あ'.repeat(100)), null)
      assert.match(M.markCommentError('あ'.repeat(101)), /100 字まで/)
    })
    it('記録ごとの文（氏名は入れない）', () => {
      assert.equal(M.vitalMarkText({ temp: 37.6, sys_bp: 116, dia_bp: 68, pulse: 80, spo2: 91 }), 'バイタル 体温 37.6℃・血圧 116/68・脈 80・SpO2 91%')
      assert.equal(M.vitalMarkText({ temp: 36, sys_bp: null, dia_bp: null, pulse: null, spo2: null }), 'バイタル 体温 36.0℃')
      assert.equal(M.vitalMarkText({ temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null }), null)
      assert.equal(M.mealMarkText('lunch', '拒食'), '昼食 拒食')
      assert.equal(M.mealMarkText('snack', '半分'), 'おやつ 半分')
      assert.equal(M.mealMarkText('lunch', '記録なし'), null)
      assert.equal(M.fluidMarkText({ taken_at: '10:30:00', amount_ml: 150 }), '水分 10:30 150 ml')
      assert.equal(M.fluidMarkText({ taken_at: null, amount_ml: 200 }), '水分 200 ml')
      assert.equal(M.activityMarkText('歌（見学）'), '活動 歌（見学）')
      assert.equal(M.excretionMarkText({ urine: 3, stools: [{}], laxatives: [] }), '排泄 排尿 3回・排便 1回')
      assert.equal(M.excretionMarkText({ urine: 0, stools: [], laxatives: [{}, {}] }), '排泄 排尿 0回・排便 0回・下剤 2回')
      assert.equal(M.excretionMarkText(null), null)
    })
  })

  describe('fetchDaycareNoteMarks（偽の Supabase・通信しない）', () => {
    it('日・利用者・区分「デイ」・鍵の頭で絞り、取り消した申し送りも読む（世代を数えるため）。書き込みはしない', async () => {
      const calls = []
      const base = { note_on: '2026-10-22', shift: 'daycare', facility: null, category: null, resident_id: 7, role_tags: [], importance: 'normal', occurred_at: null, ongoing: false, ended_at: null, ended_by: null, reporter_id: 1, color: null, after16: false, categories: ['食事'], rev: 1, created_at: 'x' }
      const rows = [
        { ...base, id: 1, body: '昼食 主食 7割・副食 5割', client_key: 'dcn:2026-10-22:7:lunch:1', deleted_at: '2026-10-22T03:00:00Z' },
        { ...base, id: 2, body: '昼食 主食 9割・副食 5割', client_key: 'dcn:2026-10-22:7:lunch:2', deleted_at: null },
      ]
      const builder = (table) => {
        const q = { table, filters: [], cols: null, action: 'select' }
        const b = {
          select(c) {
            q.cols = c
            return b
          },
          eq(k, v) {
            q.filters.push(['eq', k, v])
            return b
          },
          like(k, v) {
            q.filters.push(['like', k, v])
            return b
          },
          is(k, v) {
            q.filters.push(['is', k, v])
            return b
          },
          order() {
            return b
          },
          limit() {
            return b
          },
          insert() {
            q.action = 'insert'
            return b
          },
          update() {
            q.action = 'update'
            return b
          },
          then(ok, ng) {
            calls.push(q)
            return Promise.resolve({ data: q.table === 'notes' ? rows : [], error: null, status: 200 }).then(ok, ng)
          },
        }
        return b
      }
      DB.__testHooks.setClient({
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
      })
      const r = await DB.fetchDaycareNoteMarks('2026-10-22', 7)
      assert.deepEqual(
        r.map((x) => [x.note.id, x.clientKey, x.deleted]),
        [
          [1, 'dcn:2026-10-22:7:lunch:1', true],
          [2, 'dcn:2026-10-22:7:lunch:2', false],
        ],
      )
      const q = calls.find((c) => c.table === 'notes')
      assert.match(q.cols, /,client_key,deleted_at$/)
      const has = (op, k, v) => q.filters.some(([o, kk, vv]) => o === op && kk === k && vv === v)
      assert.ok(has('eq', 'note_on', '2026-10-22'))
      assert.ok(has('eq', 'resident_id', 7))
      assert.ok(has('eq', 'shift', 'daycare'))
      assert.ok(has('like', 'client_key', 'dcn:2026-10-22:7:%'))
      assert.ok(!q.filters.some(([o, k]) => o === 'is' && k === 'deleted_at'), '取り消した申し送りも読む（世代を数える）')
      assert.ok(calls.every((c) => c.action === 'select'), '読むだけ')
      assert.deepEqual(DB.pendingDaycareNoteMarks('dcn:2026-10-22:7:'), [], '送信待ちが無ければ空')
      DB.__testHooks.setClient(null)
    })
  })

  describe('1人の画面の印の読み込みの守り（daycareNoteMarkPerson.ts・動きで確かめる・2026-11-10 1人の画面の印の守り）', () => {
    const D = '2026-11-10'
    const D2 = '2026-11-11'
    const row = (id, key, body = 'x', deleted = false) => ({ note: { id, body }, clientKey: key, deleted })
    const ids = (rows) => (rows === null ? null : rows.map((r) => [r.note.id, r.deleted]).sort((a, b) => a[0] - b[0]))
    /**
     * 部品（useDaycareNoteMarks）の load・keepRow・人を替えた時（visitKey）・〔申し送りにする〕の門・sendAdd の判断と同じ手順を、純関数だけで
     * 動かす模型（React も DB も使わない）。start＝読み込みを始める（番号を付ける）・done／fail＝その読み込みが届いた・失敗した・keep＝書けた行を
     * 控える・view＝表示する人・日を替える・pressAdd＝〔申し送りにする〕を押す・send＝〔送る〕の判断（insertNote を呼ぶ所まで来たら inserts を数える）
     */
    const sim = (rid, d) => {
      const s = { shown: P.markPersonKey(rid, d), visit: P.markPersonKey(rid, d), gen: 0, store: P.emptyPersonStore(), marks: null, failedFor: null, inserts: 0 }
      const m = {
        start: (r, dd) => ({ gen: ++s.gen, from: P.markPersonKey(r, dd) }),
        done: (ld, rows) => {
          const out = P.personLoaded(s.store, { rows, gen: ld.gen, from: ld.from, shown: s.shown })
          s.store = out.store
          if (out.show !== null) {
            s.marks = out.show
            s.failedFor = null
          }
          return out.rows
        },
        fail: (ld) => {
          if (P.personLoadFailShown(s.store, { gen: ld.gen, from: ld.from, shown: s.shown })) s.failedFor = ld.from
          return null
        },
        keep: (r, dd, kr) => {
          const from = P.markPersonKey(r, dd)
          s.store = P.personKeep(s.store, { from, row: kr, gen: s.gen })
          s.marks = P.marksWithRow(s.marks, from, kr, s.gen)
        },
        view: (r, dd) => {
          s.shown = P.markPersonKey(r, dd)
          // 部品の visitKey: 替わったら、描画の前に印と「読めていない」を空にする
          if (s.visit !== s.shown) {
            s.visit = s.shown
            s.marks = null
            s.failedFor = null
          }
        },
        /** 表示中の方の印（部品の rows＝marksFor(marks, personKey)。null＝読めていない） */
        shownRows: () => P.marksFor(s.marks, s.shown),
        /** 表示中の方が「読めていない」か（部品の loadFailed＝failedFor === personKey） */
        shownFailed: () => s.failedFor === s.shown,
        /** 〔申し送りにする〕を押した（部品の button: 生きている印があれば出ない＝live・読めていなければ MSG_NOT_READ＝not-read・小窓が開く＝open） */
        pressAdd: (prefix) => {
          const rows = m.shownRows()
          if (rows === null) return 'not-read'
          if (rows.some((r) => !r.deleted && r.clientKey.startsWith(prefix))) return 'live'
          return 'open'
        },
        /** 〔送る〕の判断（部品の sendAdd: fresh＝送る直前の読み直し。読めなければ personKnown。生きている印があれば作らない） */
        send: (r, dd, fresh, prefix) => {
          const known = fresh ?? P.personKnown(s.store, P.markPersonKey(r, dd))
          if (known === null) return 'not-read'
          if (known.some((x) => !x.deleted && x.clientKey.startsWith(prefix))) return 'taken'
          s.inserts++
          return 'insert'
        },
        keptSize: (r, dd) => s.store.kept.get(P.markPersonKey(r, dd))?.size ?? 0,
        s,
      }
      return m
    }
    const LUNCH7 = M.markPrefix(D, 7, { kind: 'lunch' })

    it('古い読み込みを捨てる: 同じ人・日で、後に始めた読み込みが先に届いたら、前に始めた読み込みは入れない（遅れた失敗も「読めていない」にしない）', () => {
      const m = sim(7, D)
      const l1 = m.start(7, D)
      const l2 = m.start(7, D)
      m.done(l2, [row(1, `dcn:${D}:7:lunch:1-aa`)])
      m.done(l1, [])
      assert.deepEqual(ids(m.shownRows()), [[1, false]], '前に始めた読み込み（印の無い頃の読み）で新しい印を消さない')
      m.fail(l1)
      assert.equal(m.shownFailed(), false)
      // 前に始めた読み込みが先に届けば、順に入る（後に始めた読み込みが正）
      const l3 = m.start(7, D)
      const l4 = m.start(7, D)
      m.done(l3, [])
      assert.deepEqual(ids(m.shownRows()), [])
      m.done(l4, [row(2, `dcn:${D}:7:vital:1-aa`)])
      assert.deepEqual(ids(m.shownRows()), [[2, false]])
    })

    it('送っている最中に人を替えた: 前の方の送った後の読み直しを表示中の方の印に入れない・表示中の方の印を上書きして「読めていない」に見せない', () => {
      const bRows = [row(20, `dcn:${D}:8:vital:1-bb`)]
      const aAfter = [row(10, `dcn:${D}:7:lunch:1-aa`)]
      for (const order of ['表示中の方が先に届く', '前の方の読み直しが先に届く', '前の方の読み直しが失敗']) {
        const m = sim(7, D)
        m.done(m.start(7, D), [])
        // 7番の方で〔送る〕: 送る直前の読み直しは届いて世代を数え、insertNote の応答を待つ間に 8番の方へ替えた
        const pre = m.start(7, D)
        assert.deepEqual(ids(m.done(pre, [])), [], '送る直前の読み直しは呼んだ所へ返す')
        m.view(8, D)
        assert.equal(m.shownRows(), null, '替えた直後は 8番の方の印をまだ読めていない（7番の方の印を出さない）')
        assert.equal(m.shownFailed(), false)
        const lb = m.start(8, D)
        // 2026-11-10 1人の画面の印の守り 反証（固定し直し）: 送れた行は 7番の方の控えに入る（表示中の 8番の方の印には入れない）
        m.keep(7, D, aAfter[0])
        assert.equal(m.shownRows(), null)
        assert.equal(m.keptSize(7, D), 1)
        const la = m.start(7, D)
        if (order === '表示中の方が先に届く') {
          m.done(lb, bRows)
          assert.deepEqual(ids(m.done(la, aAfter)), [[10, false]], '前の方の読み直しの行は呼んだ所へ返す')
        } else if (order === '前の方の読み直しが先に届く') {
          // 以前は「最後に始めた読み込みだけを入れる」だったので、ここで 8番の方の読み込みが捨てられ「読めていない」のままだった
          m.done(la, aAfter)
          assert.equal(m.shownRows(), null, '前の方の読み直しは表示中の方の印に入れない')
          m.done(lb, bRows)
        } else {
          m.done(lb, bRows)
          m.fail(la)
        }
        assert.deepEqual(ids(m.shownRows()), [[20, false]], `${order}: 表示中の方の印は表示中の方の読み込みのまま`)
        assert.equal(m.shownFailed(), false, `${order}: 前の方の読み直しの失敗で「読めていない」にしない`)
        assert.equal(m.s.marks.key, P.markPersonKey(8, D))
      }
    })

    it('人を替えた時に前の方の「読めていない」を残さない・前に読めたその方の行を見せない。別の日の結果を入れない（同じ方で日を替えた）', () => {
      const m = sim(7, D)
      m.fail(m.start(7, D))
      assert.equal(m.shownFailed(), true)
      m.view(8, D)
      assert.equal(m.shownFailed(), false, '8番の方は、8番の方の読み込みが失敗するまで「読めていない」にしない')
      // 前に読めたその方の行: 7番の方を読めた→8番の方（読めない）→7番の方へ戻ると、7番の方の分が読めるまで印は空
      const r = sim(7, D)
      r.done(r.start(7, D), [row(1, `dcn:${D}:7:lunch:1-aa`)])
      r.view(8, D)
      r.fail(r.start(8, D))
      r.view(7, D)
      assert.equal(r.shownRows(), null, '前に読めた 7番の方の行を出さない（戻った時の読み込みを待つ）')
      assert.equal(r.pressAdd(LUNCH7), 'not-read')
      r.done(r.start(7, D), [row(1, `dcn:${D}:7:lunch:1-aa`)])
      assert.deepEqual(ids(r.shownRows()), [[1, false]])
      // 7番の方の前の日の読み込みが、日を替えた後に届いた
      const m2 = sim(7, D)
      const ld = m2.start(7, D)
      m2.view(7, D2)
      m2.done(ld, [row(1, `dcn:${D}:7:lunch:1-aa`)])
      assert.equal(m2.shownRows(), null, '前の日の印を表示中の日の印に入れない')
      m2.fail(m2.start(7, D))
      assert.equal(m2.shownFailed(), false, '前の日の読み込みの失敗で表示中の日を「読めていない」にしない')
      // 読めた印・送る直前の読み直しの代わりも、同じ人・日の分だけ
      assert.equal(P.marksFor({ key: P.markPersonKey(7, D), rows: [] }, P.markPersonKey(8, D)), null)
      assert.equal(P.marksFor({ key: P.markPersonKey(7, D), rows: [] }, P.markPersonKey(7, D2)), null)
      assert.deepEqual(P.marksFor({ key: P.markPersonKey(7, D), rows: [] }, P.markPersonKey(7, D)), [])
      assert.equal(P.personKnown(m2.s.store, P.markPersonKey(7, D2)), null, '表示中の日の読み込みが1回も入っていなければ代わりは無い')
      assert.deepEqual(ids(P.personKnown(m2.s.store, P.markPersonKey(7, D))), [[1, false]])
      assert.notEqual(P.markPersonKey(7, D), P.markPersonKey(8, D))
      assert.notEqual(P.markPersonKey(7, D), P.markPersonKey(7, D2))
    })

    it('送れた行を読み直しの失敗で消さない（送る前に始めた読み込みが後から届いても消さない）。後に始めた読み込みはサーバーを正として控えを外す', () => {
      const m = sim(7, D)
      m.done(m.start(7, D), [])
      // 送る前に始めた読み込み（他の端末の変更で始めた等）が飛んでいる間に送れた
      const before = m.start(7, D)
      const landed = row(9, `dcn:${D}:7:lunch:1-zz`, '昼食 主食 全量')
      m.keep(7, D, landed)
      assert.deepEqual(ids(m.shownRows()), [[9, false]], '送れたらすぐ印に入る')
      // 送った後の読み直しが失敗: 印は残る（〔申し送りにする〕に戻して2件目を作れる状態にしない）
      m.fail(m.start(7, D))
      assert.deepEqual(ids(m.shownRows()), [[9, false]])
      // 送る前に始めた読み込みが後から届いた（送れた行を知らない）: 消さない
      m.done(before, [])
      assert.deepEqual(ids(m.shownRows()), [[9, false]])
      assert.equal(m.keptSize(7, D), 1)
      // 送った後に始めた読み込み: サーバーが正（載っていればその行・控えは外す）
      m.done(m.start(7, D), [row(9, landed.clientKey, 'サーバーの本文')])
      assert.deepEqual(m.shownRows().map((r) => r.note.body), ['サーバーの本文'])
      assert.equal(m.keptSize(7, D), 0)
    })

    it('取り消した行を戻さない（外す前に始めた読み込みが生きた行を返しても）。直した本文も古い読み込みで戻さない', () => {
      const m = sim(7, D)
      const live = row(5, `dcn:${D}:7:vital:1-aa`, 'バイタル 体温 36.5℃')
      m.done(m.start(7, D), [live])
      const before = m.start(7, D)
      m.keep(7, D, { ...live, deleted: true })
      assert.deepEqual(ids(m.shownRows()), [[5, true]])
      m.done(before, [live])
      assert.deepEqual(ids(m.shownRows()), [[5, true]], '外す前に始めた読み込みで取り消した印を戻さない')
      m.fail(m.start(7, D))
      assert.deepEqual(ids(m.shownRows()), [[5, true]], '外した後の読み直しが失敗しても戻さない')
      m.done(m.start(7, D), [{ ...live, deleted: true }])
      assert.deepEqual(ids(m.shownRows()), [[5, true]])
      assert.equal(m.keptSize(7, D), 0)
      // 直した本文
      const m2 = sim(7, D)
      m2.done(m2.start(7, D), [live])
      const old = m2.start(7, D)
      m2.keep(7, D, { ...live, note: { ...live.note, body: 'バイタル 体温 37.0℃' } })
      m2.done(old, [live])
      assert.deepEqual(m2.shownRows().map((r) => r.note.body), ['バイタル 体温 37.0℃'])
    })

    it('控えは人・日ごと（前の方の控えを次の方の印に混ぜない）。表示中でない方の書き込みも、その人・日の控えに入れる', () => {
      // 2026-11-10 1人の画面の印の守り 反証（固定し直し）: 前は「表示中でない方の書き込みは控えない」だった。反証 中1 で、表示中でない方の
      // 書き込みもその人・日の鍵で控える決まりに変えた（ほかの人・日の読み込みには重ねない・ほかの人・日の控えは触らない、は同じ）
      const m = sim(7, D)
      m.done(m.start(7, D), [])
      const before8 = m.start(8, D)
      m.keep(7, D, row(9, `dcn:${D}:7:lunch:1-zz`))
      m.view(8, D)
      m.done(before8, [row(20, `dcn:${D}:8:vital:1-bb`)])
      assert.deepEqual(ids(m.shownRows()), [[20, false]], '7番の方の控えを 8番の方の印に入れない')
      assert.equal(m.keptSize(7, D), 1, '7番の方の控えはそのまま')
      // 8番の方の表示中に、8番の方と 7番の方の書き込みが届いた: どちらもその人・日の控えへ。表示中の 8番の方の印にだけすぐ重ねる
      m.keep(8, D, row(21, `dcn:${D}:8:lunch:1-cc`))
      m.keep(7, D, row(11, `dcn:${D}:7:snack:1-dd`))
      assert.deepEqual([...m.s.store.kept.get(P.markPersonKey(8, D)).keys()], [21])
      assert.deepEqual([...m.s.store.kept.get(P.markPersonKey(7, D)).keys()].sort((a, b) => a - b), [9, 11])
      assert.deepEqual(ids(m.shownRows()), [[20, false], [21, false]])
      const marks = { key: P.markPersonKey(8, D), rows: [] }
      assert.equal(P.marksWithRow(marks, P.markPersonKey(7, D), row(1, 'x'), 1), marks, '違う人・日の印には重ねない')
      assert.equal(P.marksWithRow(null, P.markPersonKey(8, D), row(1, 'x'), 1), null, 'まだ読めていない時は変えない')
    })

    it('反証 中1: 替える→送れる（別の方の表示中に届く）→戻る→読み込みがすべて失敗。〔申し送りにする〕に戻して見せない・2件目を作らない（insertNote は1回）', () => {
      const landed = row(9, `dcn:${D}:7:lunch:1-zz`, '昼食 主食 全量')
      for (const v of ['8番の方は読めた', '8番の方も読めなかった']) {
        const m = sim(7, D)
        m.done(m.start(7, D), [])
        assert.equal(m.pressAdd(LUNCH7), 'open')
        const fresh = m.done(m.start(7, D), [])
        assert.equal(m.send(7, D, fresh, LUNCH7), 'insert', '1件目（insertNote の応答待ち）')
        m.view(8, D)
        const l8 = m.start(8, D)
        if (v === '8番の方は読めた') m.done(l8, [row(20, `dcn:${D}:8:vital:1-bb`)])
        else m.fail(l8)
        // 8番の方の表示中に 7番の方の insertNote が届いた→送った後の読み直しも失敗
        m.keep(7, D, landed)
        m.fail(m.start(7, D))
        m.view(7, D)
        assert.equal(m.shownRows(), null, `${v}: 前に読めた送る前の行（印なし）を出さない`)
        // 戻った時の読み込みも失敗
        m.fail(m.start(7, D))
        assert.equal(m.shownRows(), null)
        assert.equal(m.shownFailed(), true, `${v}: 読めなかった（〔申し送りにする〕は押せない）`)
        assert.equal(m.pressAdd(LUNCH7), 'not-read')
        // 送る直前の読み直しも失敗した時の代わり（このマウント中の最後の読み込み＋控え）には送れた行がある
        assert.deepEqual(ids(P.personKnown(m.s.store, P.markPersonKey(7, D))), [[9, false]])
        assert.equal(m.send(7, D, m.fail(m.start(7, D)), LUNCH7), 'taken')
        assert.equal(m.s.inserts, 1, `${v}: 2件目を作らない（insertNote は1回だけ）`)
      }
    })

    it('反証 中1: 同じ流れで、戻った時の読み込みが成功（送れた後に始めた・送れる前に始めた）。送れた行を印に出し〔申し送りにする〕は出さない', () => {
      const landed = row(9, `dcn:${D}:7:lunch:1-zz`, '昼食 主食 全量')
      for (const v of ['送れた後に戻った', '送れる前に戻った']) {
        const m = sim(7, D)
        m.done(m.start(7, D), [])
        assert.equal(m.send(7, D, m.done(m.start(7, D), []), LUNCH7), 'insert')
        m.view(8, D)
        m.fail(m.start(8, D))
        let back
        if (v === '送れた後に戻った') {
          m.keep(7, D, landed)
          m.view(7, D)
          back = m.start(7, D)
          m.done(back, [landed])
        } else {
          // 戻った時の読み込みは送れた行を知らない（insertNote の応答より前に始めた）
          m.view(7, D)
          back = m.start(7, D)
          m.keep(7, D, landed)
          assert.equal(m.shownRows(), null, '読めるまでは空のまま')
          m.done(back, [])
        }
        assert.deepEqual(ids(m.shownRows()), [[9, false]], `${v}: 送れた行が印に出る`)
        assert.equal(m.pressAdd(LUNCH7), 'live', `${v}: 〔申し送りにする〕に戻らない`)
        assert.equal(m.send(7, D, m.fail(m.start(7, D)), LUNCH7), 'taken')
        assert.equal(m.s.inserts, 1, `${v}: 2件目を作らない（insertNote は1回だけ）`)
      }
    })

    it('反証 軽2: 外す・直すも同じ。別の方の表示中に届いた取り消し・直しを控え、戻った画面に取り消した印・直す前の本文を出さない', () => {
      const live = row(5, `dcn:${D}:7:vital:1-aa`, 'バイタル 体温 36.5℃')
      for (const op of ['外す', '直す']) {
        const after = op === '外す' ? { ...live, deleted: true } : { ...live, note: { ...live.note, body: 'バイタル 体温 37.0℃' } }
        const shown = (rows) => rows.map((r) => [r.note.id, r.deleted, r.note.body])
        for (const v of ['戻った読み込みが失敗', '外す・直す前に始めた読み込みが戻った後に届く', '戻った読み込みが送れる前に始まった']) {
          const m = sim(7, D)
          m.done(m.start(7, D), [live])
          const stale = m.start(7, D)
          m.view(8, D)
          m.done(m.start(8, D), [])
          let back = null
          if (v === '戻った読み込みが送れる前に始まった') {
            m.view(7, D)
            back = m.start(7, D)
          }
          m.keep(7, D, after)
          m.fail(m.start(7, D))
          if (back === null) m.view(7, D)
          if (v === '戻った読み込みが失敗') {
            m.fail(m.start(7, D))
            assert.equal(m.shownRows(), null, `${op}・${v}: 前に読めた${op === '外す' ? '生きた印' : '直す前の本文'}を出さない`)
            assert.deepEqual(shown(P.personKnown(m.s.store, P.markPersonKey(7, D))), shown([after]), '代わりには控えが重なる')
          } else if (v === '外す・直す前に始めた読み込みが戻った後に届く') {
            m.done(stale, [live])
            assert.deepEqual(shown(m.shownRows()), shown([after]), `${op}・${v}`)
            m.fail(m.start(7, D))
            assert.deepEqual(shown(m.shownRows()), shown([after]), `${op}・${v}: 読み直しが失敗しても戻さない`)
          } else {
            m.done(back, [live])
            assert.deepEqual(shown(m.shownRows()), shown([after]), `${op}・${v}`)
          }
        }
      }
    })

    it('反証 軽3: 番号は人・日ごと。7番の方の読み込み1が遅れて届き、8番の方の番号2が先に入っていても、7番の方へ戻った後なら入れる', () => {
      const m = sim(7, D)
      const l1 = m.start(7, D)
      m.view(8, D)
      m.done(m.start(8, D), [row(20, `dcn:${D}:8:vital:1-bb`)])
      m.view(7, D)
      const l3 = m.start(7, D)
      m.done(l1, [row(1, `dcn:${D}:7:lunch:1-aa`)])
      assert.deepEqual(ids(m.shownRows()), [[1, false]], '8番の方の番号2で 7番の方の読み込み1を捨てない')
      m.done(l3, [row(1, `dcn:${D}:7:lunch:1-aa`), row(2, `dcn:${D}:7:vital:1-aa`)])
      assert.deepEqual(ids(m.shownRows()), [[1, false], [2, false]])
      // 同じ人・日で後に始めた読み込みが入った後なら、前に始めた読み込みは捨てる（人・日ごとの番号）
      const m2 = sim(7, D)
      const a1 = m2.start(7, D)
      const a2 = m2.start(7, D)
      m2.done(a2, [row(2, `dcn:${D}:7:vital:1-aa`)])
      m2.done(a1, [])
      assert.deepEqual(ids(m2.shownRows()), [[2, false]])
      // 8番の方の表示中に届いた 7番の方の読み込みは、7番の方の番号だけを進める（8番の方の失敗の扱いは変えない）
      const m3 = sim(8, D)
      const b1 = m3.start(8, D)
      m3.done(m3.start(7, D), [])
      m3.fail(b1)
      assert.equal(m3.shownFailed(), true, '7番の方の番号で 8番の方の失敗を隠さない')
      m3.fail(m3.start(7, D))
      assert.equal(m3.shownFailed(), true, '表示中でない 7番の方の読み込みの失敗で、8番の方の「読めなかった」を消さない')
    })
  })

  describe('静的検査（段階2c の規律）', () => {
    const comp = code('../src/components/DaycareNoteMark.tsx')
    it('申し送りへの書き込みは印の部品の中だけで、既存の insertNote・deleteNote・saveNoteEdits だけ', () => {
      const writes = comp.match(/\b(save\w+|insert\w+|update\w+|delete\w+|softDelete\w+|upsert\w+|discard\w+|stage\w+)\(/g) ?? []
      assert.deepEqual([...new Set(writes.map((w) => w.slice(0, -1)))].sort(), ['deleteNote', 'insertNote', 'saveNoteEdits'])
      assert.doesNotMatch(comp, /supabase|\.from\(|\.rpc\(|localStorage/)
      // 冪等キーは世代つきの鍵・区分はデイ・「16時以降」は付けない・分類は記録の種類から
      // 2026-11-10 1人の画面の印の守り（固定し直し・意図は同じ）: 送れた行を控えるため、鍵を clientKey に出してから insertNote へ渡す
      assert.match(comp, /const clientKey = markKey\(d, rid, rec, gen, token\)\s+const res = await insertNote\(payload, \{ clientKey \}\)/)
      assert.match(comp, /const token = Math\.random\(\)\.toString\(36\)\.slice\(2, 10\) \|\| '0'/)
      assert.match(comp, /shift: 'daycare' as const,/)
      assert.match(comp, /after16: false,/)
      assert.match(comp, /markCategories\(rec\.kind\)\.length > 0 \? \{ categories: markCategories\(rec\.kind\) \} : \{\}/)
      // 〔外す〕は見た行（F09）・確認つき。〔申し送りを直す〕は見た本文を基準に
      assert.match(comp, /deleteNote\(\{ id: row\.note\.id \}, row\.note, \{ meta: noteMetaOf\(row\.note\), editedBy: actorId \}\)/)
      assert.match(comp, /<ConfirmDialog\s+open=\{delRow !== null\}/)
    })
    it('送る直前に読み直して世代を決める・生きている印があれば2件目を作らない・読めていなければ付けない', () => {
      assert.match(comp, /const fresh = await load\(d, rid\)/)
      assert.match(comp, /if \(known === null\) \{\s+say\(k, \{ tone: 'warn', text: MSG_NOT_READ \}\)/)
      assert.match(comp, /if \(known\.some\(\(r\) => !r\.deleted && r\.clientKey\.startsWith\(prefix\)\)\) \{/)
      assert.match(comp, /const gen = nextGen\(prefix, keys\)/)
      assert.match(comp, /pendingDaycareNoteMarks\(markDayPrefix\(d, rid\)\)/)
      // 送るたびの印で別の鍵に当たらないので、取り消した行が返った時の送り直しは要らない（消した）
      assert.doesNotMatch(comp, /deletedIds/)
    })
    it('2c の反証 重大1: 小窓・確認は開いた時の人・日へ送る。人・日が替わったら閉じる', () => {
      assert.match(comp, /const sendAdd = async \(rid: number, d: string, rec: MarkRecord, text: string, comment: string\) => \{/)
      assert.doesNotMatch(comp.slice(comp.indexOf('const sendAdd'), comp.indexOf('const sendRemove')), /const rid = residentId/)
      assert.match(comp, /void sendAdd\(cur\.rid, cur\.d, cur\.rec, cur\.text, cur\.comment\)/)
      assert.match(comp, /void sendFix\(cur\.rid, cur\.d, cur\.rec, cur\.row, cur\.comment\)/)
      assert.match(comp, /void sendRemove\(delRow\.rid, delRow\.d, delRow\.rec, delRow\.row\)/)
      assert.match(comp, /useEffect\(\(\) => \{\s+setDlg\(null\)\s+setDelRow\(null\)\s+\}, \[day, residentId\]\)/)
      // 中5（と確認の反証 中1）: 〔申し送りを直す〕は全文の案を見せて直させる（ひと言を推測で切り出さない）
      assert.match(comp, /comment: fixProposal\(live\.note\.body, text\)/)
      assert.match(comp, /\{ body: \{ value: full\.trim\(\), base: row\.note\.body \} \}/)
      assert.match(comp, /直した後の申し送り（全文を確かめて、必要なら直してください）/)
      assert.match(comp, /<textarea/)
      assert.doesNotMatch(comp, /markTail/)
    })
    it('2026-11-10 1人の画面の印の守り: 読み込み・控え・読めなかった印の判断は純関数（動きは上の試験）を、部品と同じ手順で通す', () => {
      const load = comp.slice(comp.indexOf('const load = useCallback'), comp.indexOf('const keepRow'))
      // 2026-11-10 1人の画面の印の守り 反証（固定し直し）: 読み込みと控えは人・日ごとの store（番号の比べも人・日ごと）・表示中でない方の
      // 書き込みも控える・人・日を替えたら印を空にする・送る直前の読み直しの代わりは personKnown（動きは上の試験）
      assert.match(load, /const r = personLoaded\(storeRef\.current, \{ rows, gen, from, shown: hereKey\(\) \}\)\s+storeRef\.current = r\.store/)
      assert.match(load, /if \(r\.show !== null\) \{\s+setMarks\(r\.show\)\s+setFailedFor\(null\)/)
      assert.match(load, /if \(personLoadFailShown\(storeRef\.current, \{ gen, from, shown: hereKey\(\) \}\)\) setFailedFor\(from\)/)
      assert.doesNotMatch(comp, /gen === genRef\.current|setLoadFailed|appliedRef|keptRef|marksRef/, '前の作り（最後に始めた読み込みだけ・番号1つ・控え1人分）は残さない')
      assert.match(comp, /const storeRef = useRef<PersonStore<DaycareNoteMarkRow>>\(emptyPersonStore\(\)\)/)
      assert.match(comp, /const hereKey = \(\) => markPersonKey\(here\.current\.residentId, here\.current\.day\)/)
      const keep = comp.slice(comp.indexOf('const keepRow'), comp.indexOf('useEffect(', comp.indexOf('const keepRow')))
      assert.match(keep, /storeRef\.current = personKeep\(storeRef\.current, \{ from, row, gen \}\)\s+setMarks\(\(prev\) => marksWithRow\(prev, from, row, gen\)\)/)
      assert.doesNotMatch(keep, /return|hereKey/, '表示中でない方の書き込みも控える')
      assert.match(comp, /const \[visitKey, setVisitKey\] = useState\(personKey\)\s+if \(visitKey !== personKey\) \{\s+setVisitKey\(personKey\)\s+setMarks\(null\)\s+setFailedFor\(null\)\s+\}/)
      assert.match(comp, /const rows = marksFor\(marks, personKey\)/)
      assert.match(comp, /const loadFailed = failedFor === personKey/)
      assert.match(comp, /const known = fresh \?\? personKnown\(storeRef\.current, markPersonKey\(rid, d\)\)/)
      // 読めない間の門（今のまま）: 〔申し送りにする〕は rows が null なら MSG_NOT_READ・読めなかった時は押せない
      assert.match(comp, /disabled=\{isBusy \|\| \(rows === null && loadFailed\)\}/)
      assert.match(comp, /const why = precheck\(\) \?\? \(rows === null \? MSG_NOT_READ : null\)/)
      // 送れた・外した・直した行は、送った後の読み直しの前に控える
      assert.match(comp, /keepRow\(rid, d, \{ note: res, clientKey, deleted: false \}\)\s+await load\(d, rid\)/)
      assert.match(comp, /keepRow\(rid, d, \{ \.\.\.row, deleted: true \}\)\s+await load\(d, rid\)/)
      assert.match(comp, /keepRow\(rid, d, \{ \.\.\.row, note: res\.row \?\? \{ \.\.\.row\.note, body: full\.trim\(\) \} \}\)\s+await load\(d, rid\)/)
      // 知らせ・送信中の鍵は人・日つき（前の方の知らせ・送信中を表示中の方に出さない）。人・日を替えたら知らせを消す
      assert.match(comp, /const msgKey = \(rec: MarkRecord\) => `\$\{personKey\}:\$\{markPrefix\(day, residentId, rec\)\}`/)
      assert.equal((comp.match(/const k = `\$\{rid\}:\$\{d\}:\$\{markPrefix\(d, rid, rec\)\}`/g) ?? []).length, 3)
      assert.match(comp, /const personKey = markPersonKey\(residentId, day\)/)
      assert.match(comp, /useEffect\(\(\) => \{\s+setMsgs\(\{\}\)\s+void load\(day, residentId\)\s+\}, \[day, residentId, refreshKey, load\]\)/)
    })
    it('17時のロック: 現場のログインは記録日の 17:00 から付け外し・直しをしない（事務所はできる・サーバーが正）', () => {
      assert.match(comp, /const lockedForMe = lockState\(day, 'daycare', false, now\)\.locked && !canUnlockNotes\(role\)/)
      assert.match(comp, /if \(lockedForMe\) return MSG_LOCKED_FIELD/)
      assert.match(comp, /isNoteLockedError\(e\) \? NOTE_LOCKED_MESSAGE/)
    })
    it('1人の記録の画面と活動の欄は申し送りへ書かない（印の部品を置くだけ）。申し送りの文はサーバーの値から', () => {
      const page = code('../src/pages/DaycarePersonPage.tsx')
      assert.doesNotMatch(page, /\b(insertNote|deleteNote|saveNoteEdits)\(/)
      assert.match(page, /const marks = useDaycareNoteMarks\(\{/)
      assert.match(page, /\{marks\.button\(\{ kind: 'lunch' \}, mealMarkText\('lunch', lunchLabel\(lunchRow\?\.meal \?\? null\)\)\)\}/)
      assert.match(page, /\{marks\.button\(\{ kind: 'fluid', id: f\.id \}, fluidMarkText\(f\)\)\}/)
      assert.match(page, /\{marks\.button\(\{ kind: 'ex' \}, excretionMarkText\(exDay\), ex\.status === 'ok' && ex\.view\.linked && exDay !== null\)\}/)
      assert.match(page, /\{marks\.dialogs\}/)
      const act = code('../src/components/DaycareActivitySection.tsx')
      assert.doesNotMatch(act, /\b(insertNote|deleteNote|saveNoteEdits)\(/)
      assert.match(act, /\{markSlot\?\.\(a\)\}/)
    })
    it('DB 変更なし（移行を足さない・types.ts と notes の表に触れない）', () => {
      const migs = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort()
      // 0044（段階2b）の後に入るのは、段階2d の個人の閾値 0045 だけ（2c の分は無い）
      const after = migs.filter((f) => f > '0044_daycare_activity.sql')
      // 段階3の 0046 も 2c の分ではない（固定し直し・意図は同じ＝段階2c は移行を足さない）。今日の画面の改善 1回目の 0047 も同じ。タイムラインの継続の遡りの 0050 も同じ。施設の印の段階1の 0051・段階2の 0052・段階3の 0053・段階4の 0054・0055 も同じ（段階2c の分ではない）
      // 2026-11-09 計画C（固定し直し・意図は同じ）: 連絡帳の 0061 も段階2c の分ではない
      // 2026-11-10 未測定（固定し直し・意図は同じ）: 〔未測定〕の印の 0062 も段階2c の分ではない
      assert.deepEqual(after.filter((f) => !['0045_resident_vital_limits.sql', '0046_daycare_training.sql', '0047_daycare_auto_attendance.sql', '0048_daycare_auto_attendance_fix.sql', '0049_daycare_auto_leave_editor.sql', '0050_pinned_open_lookback.sql', '0051_tenant_stage1.sql', '0052_tenant_stage2.sql', '0053_tenant_stage3.sql', '0054_tenant_stage4.sql', '0055_tenant_client_key.sql', '0056_presence_tenant.sql', '0057_import_tool_ver.sql', '0058_note_reporter_name.sql', '0059_trigger_fn_hardening.sql', '0060_trigger_fn_revoke_rest.sql', '0061_daycare_contact.sql', '0062_daycare_vital_unmeasured.sql'].includes(f)), [], '段階2c は移行を足さない')
      assert.doesNotMatch(read('../src/lib/types.ts'), /dcn:|NoteMark/)
      // 取り消した申し送りも読む読み取りは、印の鍵の頭で絞った1か所だけ
      const db = code('../src/lib/db.ts')
      const f = db.slice(db.indexOf('export async function fetchDaycareNoteMarks'), db.indexOf('export interface PendingNoteMark'))
      assert.match(f, /\.like\('client_key', `dcn:\$\{dayIso\}:\$\{residentId\}:%`\)/)
      assert.match(f, /\.limit\(DAYCARE_NOTE_MARK_ROWS\)/)
    })
    it('純ロジックは端末に何も残さない（localStorage を使わない）', () => {
      assert.doesNotMatch(code('../src/lib/daycareNoteMark.ts'), /localStorage|supabase/)
      // 2026-11-10 1人の画面の印の守り: 読み込みの判断の純関数も、端末に残さない・書かない・db を読まない・console に出さない
      const person = code('../src/lib/daycareNoteMarkPerson.ts')
      assert.doesNotMatch(person, /localStorage|supabase|console\.|from '\.\/db/)
      assert.deepEqual(person.match(/\b(save\w+|insert\w+|update\w+|delete\w+|softDelete\w+|upsert\w+|discard\w+|stage\w+)\(/g) ?? [], [])
    })
  })
}
