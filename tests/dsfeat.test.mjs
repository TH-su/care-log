// 日報の4機能（2026-10-15 本人回答）のサーバーとデータ処理の層の試験。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 時間によるロックの判定（src/lib/noteLock.ts）… サーバーの表（tests/note-lock-contract.mjs の LOCK_JUDGE_CASES）と
//    同じ答えか（画面は猶予なし・サーバーは +30分）。境目 ±1分・前日・未来の日・日本時間
// 2. 同じ方の記録をまとめる（src/lib/noteGroup.ts）・記入者の姓（surnameOf）
// 3. 検索語の正規化と照合（src/lib/noteSearch.ts）と、約340件での絞り込みの速さ
// 4. 分類の純関数（src/lib/noteCategory.ts）
// 5. db.ts: 分類の読み書き（読む列・正規化・登録・欄の保存）／サーバーのロック（P0001 note_locked）の受け方／
//    ログインの役割（fetchMyRole）
// 直す前（この4つの lib・db.ts の追加が無い版）では読み込みか判定で失敗し、直した後に成功する。
// 個人情報は置かない（利用者・職員は合成の 利用者01・職員01 と数値IDだけ。本文は記号だけ）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { registerLoadFailure } from './ts-load.mjs'
import { LOCK_JUDGE_CASES, LOCK_SECTIONS, LOCK_DAY, addMin } from './note-lock-contract.mjs'
import * as NC from './note-contract.mjs'

const UNSUPPORTED = 'この Node では TypeScript・解決フックを使えないため、日報の4機能の検証をスキップしました（Node 22.18 以降で実行してください）。'

let LOCK = null
let GROUP = null
let SEARCH = null
let CAT = null
let TYPES = null
let pureError = null
try {
  LOCK = await import('../src/lib/noteLock.ts')
  GROUP = await import('../src/lib/noteGroup.ts')
  SEARCH = await import('../src/lib/noteSearch.ts')
  CAT = await import('../src/lib/noteCategory.ts')
  TYPES = await import('../src/lib/types.ts')
} catch (e) {
  pureError = e
}

const lsStore = new Map()
let DB = null
let dbError = null
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
  DB = await import('../src/lib/db.ts')
} catch (e) {
  dbError = e
}

// ── 合成の申し送り ─────────────────────────────────────────────────────────

function note(over) {
  return {
    id: 1,
    note_on: LOCK_DAY,
    shift: 'day',
    facility: null,
    category: null,
    resident_id: 1,
    role_tags: [],
    categories: [],
    importance: 'normal',
    body: '本文',
    occurred_at: null,
    ongoing: false,
    ended_at: null,
    reporter_id: 1,
    color: null,
    after16: false,
    rev: 1,
    ...over,
  }
}

if (pureError !== null) {
  registerLoadFailure('日報の4機能（純関数）の検証', pureError, UNSUPPORTED)
} else {
  // ════════════════════════════════════════════════════════════════════
  describe('1. 時間によるロックの判定（noteLock.ts）', () => {
    const { lockState, noteLockAt, msUntilNextLock, NOTE_LOCK_SERVER_GRACE_MIN } = LOCK

    it('サーバーの猶予は 30分（0033 の c_grace と同じ）', () => {
      assert.equal(NOTE_LOCK_SERVER_GRACE_MIN, 30)
    })

    describe('サーバーの判定の表（LOCK_JUDGE_CASES）と同じ答え（猶予はサーバーと同じく lockAt に足して比べる）', () => {
      for (const c of LOCK_JUDGE_CASES) {
        it(c.name, () => {
          const at = noteLockAt(c.day, c.shift, c.after16)
          assert.notEqual(at, null)
          const now = Date.parse(c.now)
          const blocked = now >= at + c.grace * 60_000
          assert.equal(blocked, c.expect)
          // 画面（猶予なし）は lockState がそのまま答える
          if (c.grace === 0) assert.equal(lockState(c.day, c.shift, c.after16, now).locked, c.expect)
        })
      }
    })

    it('4区分のロックの時刻と書き方（17:00・24:00・翌8:00）', () => {
      for (const s of LOCK_SECTIONS) {
        const st = lockState(LOCK_DAY, s.shift, s.after16, Date.parse(s.lockAt) - 60_000)
        assert.equal(st.lockAt, Date.parse(s.lockAt), s.label)
        assert.equal(st.locked, false, s.label)
        assert.equal(st.label, { day: '17:00', late: '24:00', daycare: '17:00', night: '翌8:00' }[s.key], s.label)
      }
    })

    it('境目: ロックの時刻 −1分は書ける・ちょうどはロック・+1分はロック（4区分すべて・画面は猶予なし）', () => {
      for (const s of LOCK_SECTIONS) {
        assert.equal(lockState(LOCK_DAY, s.shift, s.after16, Date.parse(addMin(s.lockAt, -1))).locked, false, s.label)
        assert.equal(lockState(LOCK_DAY, s.shift, s.after16, new Date(s.lockAt)).locked, true, s.label)
        assert.equal(lockState(LOCK_DAY, s.shift, s.after16, Date.parse(addMin(s.lockAt, 1))).locked, true, s.label)
        // 画面はサーバーの猶予（+29分）を見ない＝もうロック
        assert.equal(lockState(LOCK_DAY, s.shift, s.after16, Date.parse(addMin(s.lockAt, 29))).locked, true, s.label)
      }
    })

    it('端末の時刻帯に左右されない（UTC の値で与えても日本時間で判定）', () => {
      // 日本時間 2026-11-01 16:59 = UTC 07:59
      assert.equal(lockState(LOCK_DAY, 'day', false, Date.UTC(2026, 10, 1, 7, 59)).locked, false)
      assert.equal(lockState(LOCK_DAY, 'day', false, Date.UTC(2026, 10, 1, 8, 0)).locked, true)
    })

    it('読めない日付はロックしない（lockAt=null・label 空＝サーバーの判定に任せる）', () => {
      for (const d of ['', '2026-1-01', '2026-02-30', 'x']) {
        assert.deepEqual(lockState(d, 'day', false, Date.UTC(2030, 0, 1)), { locked: false, lockAt: null, label: '' }, d)
      }
    })

    it('既定の now は今（引数を省いても例外にならない）', () => {
      assert.equal(typeof lockState(LOCK_DAY, 'day', false).locked, 'boolean')
    })

    it('msUntilNextLock: まだロックしていない欄のうち一番早いロックまでの時間・無ければ null', () => {
      const now = Date.parse('2026-11-01T16:30:00+09:00')
      const secs = LOCK_SECTIONS.map((s) => ({ day: LOCK_DAY, shift: s.shift, after16: s.after16 }))
      assert.equal(msUntilNextLock(secs, now), 30 * 60_000)
      assert.equal(msUntilNextLock(secs, Date.parse('2026-11-02T09:00:00+09:00')), null)
      assert.equal(msUntilNextLock([], now), null)
    })
  })

  // ════════════════════════════════════════════════════════════════════
  describe('2. 同じ方の記録をまとめる（noteGroup.ts）', () => {
    const { groupNotesByResident, noteSectionOf, surnameOf, noteGroupLines, sheetNoteOrder } = GROUP

    it('区分: 日勤／16時以降／デイ／夜勤（デイ・夜勤は after16 を見ない）', () => {
      assert.equal(noteSectionOf({ shift: 'day', after16: false }), 'day')
      assert.equal(noteSectionOf({ shift: 'day', after16: true }), 'late')
      assert.equal(noteSectionOf({ shift: 'daycare', after16: true }), 'daycare')
      assert.equal(noteSectionOf({ shift: 'night', after16: true }), 'night')
    })

    it('同じ日・同じ区分・同じ対象の2件以上を1行に・最初の記録の位置に出す・中の並びも時刻→id', () => {
      const ns = [
        note({ id: 5, resident_id: 1, occurred_at: '10:00:00', body: 'B' }),
        note({ id: 3, resident_id: 2, occurred_at: '09:00:00', body: 'X' }),
        note({ id: 4, resident_id: 1, occurred_at: '08:00:00', body: 'A' }),
        note({ id: 9, resident_id: 1, occurred_at: '08:00:00', body: 'A2' }),
      ]
      const rows = groupNotesByResident(ns)
      assert.deepEqual(rows.map((r) => r.notes.map((n) => n.id)), [[4, 9, 5], [3]])
      assert.equal(rows[0].key, `g:${LOCK_DAY}|day|1`)
      assert.equal(rows[0].resident_id, 1)
    })

    it('区分が違えば・日が違えば・対象が違えばまとめない／対象なし（null）は1件ずつ', () => {
      const ns = [
        note({ id: 1, resident_id: 1, shift: 'day', after16: false }),
        note({ id: 2, resident_id: 1, shift: 'day', after16: true }),
        note({ id: 3, resident_id: 1, shift: 'daycare' }),
        note({ id: 4, resident_id: 1, shift: 'night' }),
        note({ id: 5, resident_id: 1, note_on: '2026-11-02' }),
        note({ id: 6, resident_id: null }),
        note({ id: 7, resident_id: null }),
      ]
      const rows = groupNotesByResident(ns)
      assert.equal(rows.length, 7)
      assert.ok(rows.every((r) => r.notes.length === 1))
      assert.deepEqual(rows.filter((r) => r.resident_id === null).map((r) => r.key), ['n:6', 'n:7'])
    })

    it('分類の欄はまとめた記録の和集合（6値の並び）。分類が分からない記録（undefined）は空として足す', () => {
      const rows = groupNotesByResident([
        note({ id: 1, categories: ['家族'] }),
        note({ id: 2, categories: ['体調', '家族'] }),
        note({ id: 3, categories: undefined }),
      ])
      assert.deepEqual(rows[0].categories, ['体調', '家族'])
    })

    it('並べ替えは入力を書き換えない・order=null は入力の並びのまま', () => {
      const ns = [note({ id: 2, occurred_at: '10:00:00' }), note({ id: 1, occurred_at: '09:00:00' })]
      const before = ns.map((n) => n.id)
      groupNotesByResident(ns)
      assert.deepEqual(ns.map((n) => n.id), before)
      assert.deepEqual(groupNotesByResident(ns, null)[0].notes.map((n) => n.id), [2, 1])
      assert.ok(sheetNoteOrder(ns[1], ns[0]) < 0)
    })

    it('内容欄: 最初の本文・2件目以降は末尾に（記入者の姓）・記入者なし／名前が引けない時は付けない', () => {
      const names = { 1: '職員 01', 2: '職員　02', 3: '職員03' }
      const row = groupNotesByResident([
        note({ id: 1, body: '一', reporter_id: 1 }),
        note({ id: 2, body: '二', reporter_id: 2 }),
        note({ id: 3, body: '三', reporter_id: null }),
        note({ id: 4, body: '四', reporter_id: 3 }),
        note({ id: 5, body: '五', reporter_id: 99 }),
      ])[0]
      const lines = noteGroupLines(row, (id) => names[id] ?? null)
      assert.deepEqual(lines.map((l) => [l.note.id, l.body, l.suffix]), [
        [1, '一', ''],
        [2, '二', '（職員）'],
        [3, '三', ''],
        [4, '四', '（職員03）'],
        [5, '五', ''],
      ])
    })

    it('surnameOf: 最初の半角・全角空白より前／空白が無ければ全部／前後の空白は無視／空・null は空', () => {
      assert.equal(surnameOf('職員 01'), '職員')
      assert.equal(surnameOf('職員　01'), '職員')
      assert.equal(surnameOf('職員01'), '職員01')
      assert.equal(surnameOf('  職員 01 太郎'), '職員')
      assert.equal(surnameOf('　職員01　'), '職員01')
      assert.equal(surnameOf(''), '')
      assert.equal(surnameOf('   '), '')
      assert.equal(surnameOf(null), '')
      assert.equal(surnameOf(undefined), '')
    })
  })

  // ════════════════════════════════════════════════════════════════════
  describe('3. 検索語の正規化と照合（noteSearch.ts）', () => {
    const { normalizeSearchText, parseSearchQuery, noteSearchText, matchSearch, noteMatchesQuery } = SEARCH

    it('大文字小文字・全角半角・カタカナとひらがなの違いを吸収し、空白を除く', () => {
      assert.equal(normalizeSearchText('ＡＢＣ abc'), 'abcabc')
      assert.equal(normalizeSearchText('ﾘﾖｳｼｬ'), normalizeSearchText('りようしゃ'))
      assert.equal(normalizeSearchText('リヨウシャ'), 'りようしゃ')
      assert.equal(normalizeSearchText('ヴ'), 'ゔ')
      assert.equal(normalizeSearchText('１２：３０'), '12:30')
      assert.equal(normalizeSearchText('利用者　01'), '利用者01')
    })

    it('検索語: 半角・全角の空白で区切り・空の語は捨て・同じ語は1つに', () => {
      assert.deepEqual(parseSearchQuery('  体温　ﾀｲｵﾝ  体温 '), ['体温', 'たいおん'])
      assert.deepEqual(parseSearchQuery(''), [])
      assert.deepEqual(parseSearchQuery('　 '), [])
    })

    it('AND: すべての語が本文・対象者名・記入者名のどこかに含まれる時だけ合う', () => {
      const hay = noteSearchText(['朝食は半分', '利用者01', 'りようしゃぜろいち', '職員 01'])
      assert.equal(matchSearch(hay, parseSearchQuery('朝食 利用者01')), true)
      assert.equal(matchSearch(hay, parseSearchQuery('朝食 職員01')), true) // 記入者名の空白の違いは吸収
      assert.equal(matchSearch(hay, parseSearchQuery('リヨウシャ')), true) // カナとかな
      assert.equal(matchSearch(hay, parseSearchQuery('朝食 夕食')), false)
      assert.equal(matchSearch(hay, []), true) // 語なし＝絞り込まない
    })

    it('本文の終わりと名前の始まりをまたいでは合わない', () => {
      const hay = noteSearchText(['ABC', 'DEF'])
      assert.equal(matchSearch(hay, parseSearchQuery('CD')), false)
      assert.equal(matchSearch(hay, parseSearchQuery('BC')), true)
    })

    it('noteMatchesQuery（簡便形）: null の名前は飛ばす・検索語は文字でも語の配列でもよい', () => {
      assert.equal(noteMatchesQuery('体調', { body: '体調よし', residentNames: [null, undefined], reporterName: null }), true)
      assert.equal(noteMatchesQuery(['ぜろに'], { body: 'x', residentNames: ['ゼロニ'] }), true)
      assert.equal(noteMatchesQuery('', { body: 'x' }), true)
      assert.equal(noteMatchesQuery('y', { body: 'x' }), false)
    })

    it('軽さ: 10日・約340件（本文は約80字）の絞り込み1回が 16ms 未満（比べる文字は控えておく前提）', () => {
      const hays = []
      for (let i = 0; i < 340; i++) {
        const body = `申し送り${i}：${'朝食は主食半分、副食全量。午後から微熱あり様子観察。'.repeat(3)}`
        hays.push(noteSearchText([body, `利用者${String(i % 33).padStart(2, '0')}`, `りようしゃ${i % 33}`, `職員 ${String(i % 12).padStart(2, '0')}`]))
      }
      const terms = parseSearchQuery('微熱 利用者05 職員05')
      // 1回目は JIT の暖機。2回目以降の最大を見る
      hays.filter((h) => matchSearch(h, terms))
      // 試験は並行して走るので、GC や他の試験の割り込みで1回だけ遅くなることがある。判定は中央値で行う（最大は文言に添える）
      const times = []
      let hits = 0
      for (let k = 0; k < 20; k++) {
        const t0 = performance.now()
        hits = hays.filter((h) => matchSearch(h, parseSearchQuery('微熱 利用者05 職員05'))).length
        times.push(performance.now() - t0)
      }
      times.sort((a, b) => a - b)
      const median = times[Math.floor(times.length / 2)]
      assert.ok(hits > 0)
      assert.ok(median < 16, `絞り込み1回の中央値 ${median.toFixed(2)}ms（最大 ${times.at(-1).toFixed(2)}ms）`)
      // 比べる文字を作る側（読み込み時に1回）も 340件で 50ms 未満
      const t1 = performance.now()
      for (let i = 0; i < 340; i++) noteSearchText([`本文${i}`.repeat(20), '利用者01', 'りようしゃ', '職員 01'])
      assert.ok(performance.now() - t1 < 50)
    })
  })

  // ════════════════════════════════════════════════════════════════════
  describe('4. 分類の純関数（noteCategory.ts）', () => {
    const { normalizeCategories, toggleCategory, toggleAllCategories, hasAllCategories, unionCategories, sameCategories, isNoteCategory } = CAT
    const ALL = ['体調', '食事', '薬', '支援調整', '消耗品', '家族']

    it('6値はサーバーの check（0032）・JS の写し（note-contract）と同じ並び', () => {
      assert.deepEqual([...TYPES.NOTE_CATEGORIES], ALL)
      assert.deepEqual(NC.NOTE_CATEGORY_VALUES, ALL)
    })

    it('normalizeCategories: 6値の並び・重複なしにそろえる／配列でない・6値以外が混ざれば null', () => {
      assert.deepEqual(normalizeCategories(['家族', '体調', '家族']), ['体調', '家族'])
      assert.deepEqual(normalizeCategories([]), [])
      assert.equal(normalizeCategories(['体調', '睡眠']), null)
      assert.equal(normalizeCategories('体調'), null)
      assert.equal(normalizeCategories(null), null)
      assert.equal(isNoteCategory('薬'), true)
      assert.equal(isNoteCategory('くすり'), false)
    })

    it('toggleCategory・〔全て〕（全部に印→もう一度で全部外す。一部だけの時は全部に付ける）', () => {
      assert.deepEqual(toggleCategory(['家族'], '体調'), ['体調', '家族'])
      assert.deepEqual(toggleCategory(['体調', '家族'], '体調'), ['家族'])
      assert.deepEqual(toggleAllCategories([]), ALL)
      assert.deepEqual(toggleAllCategories(['薬']), ALL)
      assert.deepEqual(toggleAllCategories(ALL), [])
      assert.equal(hasAllCategories(ALL), true)
      assert.equal(hasAllCategories(['体調']), false)
    })

    it('unionCategories・sameCategories', () => {
      assert.deepEqual(unionCategories([['家族'], undefined, ['薬', '家族']]), ['薬', '家族'])
      assert.equal(sameCategories(['薬', '家族'], ['家族', '薬']), true)
      assert.equal(sameCategories(['薬'], ['家族']), false)
      assert.equal(sameCategories(undefined, []), true)
    })
  })
}

// ══════════════════════════════════════════════════════════════════════
// 5. db.ts（偽の Supabase・通信しない）

function fakeSupabase(handler) {
  const calls = []
  const builder = (q) => {
    const run = async () => {
      calls.push(q)
      return handler(q)
    }
    const b = {
      select(cols) {
        if (q.cols === undefined) q.cols = cols
        return b
      },
      insert(p) {
        q.action = 'insert'
        q.payload = p
        return b
      },
      update(p) {
        q.action = 'update'
        q.payload = p
        return b
      },
      eq(k, v) {
        q.filters.push(['eq', k, v])
        return b
      },
      is(k, v) {
        q.filters.push(['is', k, v])
        return b
      },
      in(k, v) {
        q.filters.push(['in', k, v])
        return b
      },
      limit(n) {
        q.limit = n
        return b
      },
      order() {
        return b
      },
      maybeSingle: run,
      then: (ok, ng) => run().then(ok, ng),
    }
    return b
  }
  const from = (table) => builder({ table, action: 'select', filters: [] })
  const rpc = (fn, args) => builder({ table: null, action: 'rpc', fn, args, filters: [] })
  return { client: { from, rpc, auth: { onAuthStateChange() {} } }, calls }
}

const LOCKED_ERR = { code: 'P0001', message: 'note_locked: 2026-11-01 の日勤の欄はロック中のため書き込めません（事務所で解除できます）' }

/**
 * 申し送りの偽のサーバー。apply_note_edits は JS の写し（0032 の分類を含む）。opts.lock() が true の間は書き込み
 * （insert・apply_note_edits の書く呼び出し）を 0033 のトリガと同じく P0001 note_locked で止める。opts.offline() は通信不能。
 * opts.myAccount は rpc('my_account') の応答（関数で与える）
 */
function server(opts = {}) {
  const db = NC.createNoteDb()
  let nextId = 500
  const fake = fakeSupabase(async (q) => {
    if (opts.offline?.()) return { data: null, error: { message: 'offline' }, status: 0 }
    if (q.action === 'rpc' && q.fn === 'my_account') return opts.myAccount ? opts.myAccount() : { data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 }
    if (q.action === 'rpc' && q.fn === 'apply_note_edits') {
      const writes = q.args?.p_id !== null && Object.keys(q.args?.p_edits ?? {}).length > 0
      if (writes && opts.lock?.()) return { data: null, error: LOCKED_ERR, status: 400 }
      if (writes && opts.otherP0001?.()) return { data: null, error: { code: 'P0001', message: 'something else' }, status: 400 }
      try {
        return { data: NC.fakeApplyNoteEdits(db, q.args), error: null, status: 200 }
      } catch (e) {
        if (!(e instanceof NC.PgError)) throw e
        return { data: null, error: { code: e.code, message: e.message }, status: 400 }
      }
    }
    if (q.action === 'rpc') return { data: { version: 1, status: 'probe' }, error: null, status: 200 }
    if (q.table === 'notes' && q.action === 'insert') {
      if (opts.lock?.()) return { data: null, error: LOCKED_ERR, status: 400 }
      const row = { ...NC.NOTE_BASE_ROW, ...q.payload, id: nextId++, rev: 1, deleted_at: null, edited_by: null }
      if (!Array.isArray(row.categories)) row.categories = []
      db.notes.push(row)
      return { data: { ...row }, error: null, status: 201 }
    }
    if (q.table === 'notes' && q.action === 'select') {
      const ins = q.filters.find((f) => f[0] === 'in')
      const rows = db.notes.filter((r) => r.deleted_at === null && (!ins || ins[2].includes(r.id)))
      const shaped = rows.map((r) => {
        const o = { ...r }
        if (opts.dropCategories) delete o.categories
        if (opts.rawCategories) o.categories = opts.rawCategories
        return o
      })
      return { data: shaped, error: null, status: 200 }
    }
    return { data: null, error: { code: 'X', message: `unexpected ${q.table} ${q.action}` }, status: 500 }
  })
  const seed = (over = {}) => {
    const row = { ...NC.NOTE_BASE_ROW, id: nextId++, rev: 1, edited_by: null, deleted_at: null, client_key: null, ...over }
    db.notes.push(row)
    return row
  }
  const count = (pred) => fake.calls.filter(pred).length
  return { ...fake, db, seed, count }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

if (dbError !== null) {
  registerLoadFailure('日報の4機能（db.ts）の検証', dbError, UNSUPPORTED, { hooks: true })
} else {
  const reset = async () => {
    await settle()
    lsStore.delete('cl_sendQueue')
    lsStore.delete('cl_sendQueue2')
    await DB.__testHooks.restartQueue()
    DB.__testHooks.setClient(null)
  }

  describe('5-1. 分類（categories）の読み書き', () => {
    afterEach(reset)

    it('申し送りを読む列に categories がある・6値の並びにそろえ、6値以外は捨てる', async () => {
      const srv = server({ rawCategories: ['家族', '睡眠', '体調', '家族'] })
      const row = srv.seed({})
      DB.__testHooks.setClient(srv.client)
      const [n] = await DB.fetchNoteRows([row.id])
      const sel = srv.calls.find((q) => q.table === 'notes' && q.action === 'select')
      assert.ok(String(sel.cols).split(',').includes('categories'), sel.cols)
      assert.deepEqual(n.categories, ['体調', '家族'])
    })

    it('列を返さない経路の行は categories を付けない（undefined＝分からない。[] と区別する）', async () => {
      const srv = server({ dropCategories: true })
      const row = srv.seed({})
      DB.__testHooks.setClient(srv.client)
      const [n] = await DB.fetchNoteRows([row.id])
      assert.equal(Object.prototype.hasOwnProperty.call(n, 'categories'), false)
    })

    it('登録: 分類を渡すと6値の並び・重複なしで送る／省くと送らない（サーバーの既定値 {}）', async () => {
      const srv = server()
      DB.__testHooks.setClient(srv.client)
      const base = { note_on: LOCK_DAY, shift: 'day', facility: null, category: null, resident_id: 1, role_tags: [], importance: 'normal', body: '本文N', occurred_at: null, ongoing: false, ended_at: null, reporter_id: 1, color: null, after16: false }
      const a = await DB.insertNote({ ...base, categories: ['家族', '体調', '家族'] })
      const b = await DB.insertNote({ ...base, body: '本文M' })
      const ins = srv.calls.filter((q) => q.table === 'notes' && q.action === 'insert')
      assert.deepEqual(ins[0].payload.categories, ['体調', '家族'])
      assert.equal(Object.prototype.hasOwnProperty.call(ins[1].payload, 'categories'), false)
      assert.deepEqual(a.categories, ['体調', '家族'])
      assert.deepEqual(b.categories, [])
    })

    it('欄の保存: categories を apply_note_edits で送り、応答の行に分類が載る（並びをそろえて送る）', async () => {
      const srv = server()
      const row = srv.seed({ categories: [] })
      DB.__testHooks.setClient(srv.client)
      const r = await DB.saveNoteEdits({ id: row.id }, { categories: { value: ['家族', '薬'], base: [] } })
      assert.equal(r.status, 'applied')
      assert.deepEqual(r.row.categories, ['薬', '家族'])
      const call = srv.calls.find((q) => q.fn === 'apply_note_edits' && q.args?.p_id === row.id)
      assert.deepEqual(call.args.p_edits.categories.value, ['薬', '家族'])
    })

    it('欄の保存: 6値以外の分類は送らない（読めない値として受け付けない）', async () => {
      const srv = server()
      const row = srv.seed({ categories: [] })
      DB.__testHooks.setClient(srv.client)
      await assert.rejects(() => DB.saveNoteEdits({ id: row.id }, { categories: { value: ['睡眠'], base: [] } }))
      assert.equal(srv.count((q) => q.fn === 'apply_note_edits' && q.args?.p_id === row.id), 0)
    })
  })

  describe('5-2. サーバーのロック（0033 の P0001 note_locked）の受け方', () => {
    afterEach(reset)

    it('欄の保存がロックで止められた: DbError（kind=locked・決まった文言）・送信待ちは rejected で残り、自動で送り直さない', async () => {
      let locked = true
      const srv = server({ lock: () => locked })
      const row = srv.seed({})
      DB.__testHooks.setClient(srv.client)
      await assert.rejects(
        () => DB.saveNoteEdits({ id: row.id }, { body: { value: '本文A', base: '本文O' } }),
        (e) => e instanceof DB.DbError && e.kind === 'locked' && e.message === 'ロック中のため保存できませんでした（事務所で解除できます）' && DB.isNoteLockedError(e),
      )
      assert.equal(DB.NOTE_LOCKED_MESSAGE, 'ロック中のため保存できませんでした（事務所で解除できます）')
      const p = DB.pendingNoteRow(row.id)
      assert.equal(p?.state, 'rejected')
      assert.equal(p?.values.body, '本文A') // 入力は消さない
      const sent = srv.count((q) => q.fn === 'apply_note_edits' && q.args?.p_id === row.id)
      locked = false
      await DB.flushQueue(true)
      await settle()
      assert.equal(srv.count((q) => q.fn === 'apply_note_edits' && q.args?.p_id === row.id), sent, '止まった記録を自動で送り直した')
      assert.equal(DB.pendingNoteRow(row.id)?.state, 'rejected')
    })

    it('P0001 でも note_locked でない拒否はロックとして扱わない（従来どおりサーバーエラー）', async () => {
      const srv = server({ otherP0001: () => true })
      const row = srv.seed({})
      DB.__testHooks.setClient(srv.client)
      await assert.rejects(
        () => DB.saveNoteEdits({ id: row.id }, { body: { value: '本文A', base: '本文O' } }),
        (e) => e instanceof DB.DbError && e.kind === 'server' && /P0001/.test(e.message),
      )
    })

    it('登録（つながっている時）がロックで止められた: DbError locked を投げ、送信待ちに積まない（書きかけは画面に残る）', async () => {
      const srv = server({ lock: () => true })
      DB.__testHooks.setClient(srv.client)
      const n = { note_on: LOCK_DAY, shift: 'day', facility: null, category: null, resident_id: 1, role_tags: [], importance: 'normal', body: '本文N', occurred_at: null, ongoing: false, ended_at: null, reporter_id: 1, color: null, after16: false }
      await assert.rejects(() => DB.insertNote(n), (e) => DB.isNoteLockedError(e))
      assert.equal(DB.listUnsentNotes().filter((u) => u.kind === 'insert').length, 0)
    })

    it('圏外で積んだ登録が、届いた時にロックで止められた: その場で止まった記録（rejected・locked）にし、再送で回さない・消さない', async () => {
      let offline = true
      let lockOn = false
      const srv = server({ offline: () => offline, lock: () => lockOn })
      DB.__testHooks.setClient(srv.client)
      const n = { note_on: LOCK_DAY, shift: 'day', facility: null, category: null, resident_id: 1, role_tags: [], importance: 'normal', body: '本文Q', occurred_at: null, ongoing: false, ended_at: null, reporter_id: 1, color: null, after16: false }
      const r = await DB.insertNote(n)
      assert.equal(r, 'queued')
      offline = false
      lockOn = true
      await DB.flushQueue(true)
      await settle()
      const inserts = () => srv.count((q) => q.table === 'notes' && q.action === 'insert' && q.payload?.body === '本文Q')
      const first = inserts()
      assert.ok(first >= 1)
      const u = DB.listUnsentNotes().find((x) => x.kind === 'insert')
      assert.equal(u?.op.state, 'rejected')
      assert.equal(u?.op.locked, true)
      assert.equal(u?.op.body, '本文Q')
      await DB.flushQueue(true)
      await DB.flushQueue(true)
      await settle()
      assert.equal(inserts(), first, 'ロックで止まった登録を自動で送り直した')
      assert.equal(DB.queuePending() >= 1, true, '止まった登録が数えられていない（消えた）')
    })
  })

  describe('5-3. ログインの役割（fetchMyRole）', () => {
    afterEach(reset)
    const myAccountCalls = (srv) => srv.count((q) => q.fn === 'my_account')

    it('my_account の role を返し、起動中は控える（2回目は問い合わせない）', async () => {
      const srv = server({ myAccount: () => ({ data: { email: 'x@example.invalid', role: 'office', mfa: false }, error: null, status: 200 }) })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.fetchMyRole(), 'office')
      assert.equal(await DB.fetchMyRole(), 'office')
      assert.equal(myAccountCalls(srv), 1)
      assert.equal(DB.cachedMyRole(), 'office')
      assert.equal(DB.canUnlockNotes('office'), true)
      assert.equal(DB.canUnlockNotes('admin'), true)
      assert.equal(DB.canUnlockNotes('field'), false)
      assert.equal(DB.canUnlockNotes(null), false)
      assert.equal(DB.canUnlockNotes(undefined), false)
    })

    it('同時に呼ばれても問い合わせは1回', async () => {
      const srv = server({ myAccount: () => ({ data: { role: 'field' }, error: null, status: 200 }) })
      DB.__testHooks.setClient(srv.client)
      const [a, b] = await Promise.all([DB.fetchMyRole(), DB.fetchMyRole()])
      assert.equal(a, 'field')
      assert.equal(b, 'field')
      assert.equal(myAccountCalls(srv), 1)
    })

    it('ログインし直す（SIGNED_IN）と控えを捨てて取り直す・購読者に知らせる', async () => {
      let role = 'field'
      const srv = server({ myAccount: () => ({ data: { role }, error: null, status: 200 }) })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.fetchMyRole(), 'field')
      let told = 0
      const off = DB.subscribeMyRole(() => {
        told += 1
      })
      role = 'admin'
      await DB.__testHooks.authEvent('SIGNED_IN')
      assert.equal(told, 1)
      assert.equal(DB.cachedMyRole(), undefined)
      assert.equal(await DB.fetchMyRole(), 'admin')
      assert.equal(myAccountCalls(srv), 2)
      // トークンの更新では捨てない
      await DB.__testHooks.authEvent('TOKEN_REFRESHED')
      assert.equal(await DB.fetchMyRole(), 'admin')
      assert.equal(myAccountCalls(srv), 2)
      off()
      DB.forgetMyRole()
      assert.equal(told, 1)
    })

    it('関数が無い（care-backend の土台が無い）: null（役割不明）を控える', async () => {
      const srv = server()
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.fetchMyRole(), null)
      assert.equal(await DB.fetchMyRole(), null)
      assert.equal(myAccountCalls(srv), 1)
    })

    it('通信できない時は null を返すが控えない（次はもう一度問い合わせる）', async () => {
      let offline = true
      const srv = server({ offline: () => offline, myAccount: () => ({ data: { role: 'office' }, error: null, status: 200 }) })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.fetchMyRole(), null)
      assert.equal(DB.cachedMyRole(), undefined)
      offline = false
      assert.equal(await DB.fetchMyRole(), 'office')
    })

    it('許可リスト外（null）・知らない役割の文字は null', async () => {
      let data = null
      const srv = server({ myAccount: () => ({ data, error: null, status: 200 }) })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.fetchMyRole(), null)
      DB.forgetMyRole()
      data = { role: 'superuser' }
      assert.equal(await DB.fetchMyRole(), null)
      DB.forgetMyRole()
      data = { role: 'admin', mfa: true }
      assert.equal(await DB.fetchMyRole(), 'admin')
    })

    it('役割の控えは localStorage に書かない', async () => {
      const srv = server({ myAccount: () => ({ data: { role: 'office' }, error: null, status: 200 }) })
      DB.__testHooks.setClient(srv.client)
      const before = [...lsStore.keys()].sort()
      await DB.fetchMyRole()
      assert.deepEqual([...lsStore.keys()].sort(), before)
      for (const v of lsStore.values()) assert.ok(!String(v).includes('office'))
    })
  })

  // 2026-10-15 画面担当: 取り消しの「見た行」に分類を足した（db.ts NOTE_SEEN_SENT）。他の端末が分類だけを変えた後の
  // 古い表示から消さない。直す前は seen に categories が無く、分類だけが変わった行も消えた
  describe('5-5. 取り消しの「見た行」で分類も照らす（NOTE_SEEN_SENT）', () => {
    afterEach(reset)
    const sentSeen = (srv) => {
      const q = srv.calls.filter((c) => c.action === 'rpc' && c.fn === 'apply_note_edits').at(-1)
      return q?.args?.p_edits?.deleted_at?.seen
    }

    it('他の端末が分類だけを変えた後の古い表示（分類なし）からは消さない（競合として残る）', async () => {
      const srv = server()
      const row = srv.seed({ body: '本文S', categories: ['体調'] })
      DB.__testHooks.setClient(srv.client)
      const shown = { ...note({ id: row.id, body: '本文S' }), categories: [] }
      const res = await DB.deleteNote({ id: row.id }, shown, { meta: { note_on: LOCK_DAY, shift: 'day', resident_id: 1, after16: false } })
      assert.notEqual(res, 'queued')
      assert.equal(DB.noteDeleted(res), false)
      assert.deepEqual(sentSeen(srv).categories, [])
      assert.equal(srv.db.notes.find((r) => r.id === row.id).deleted_at, null)
    })

    it('見た分類のままなら消える（並びの違いは同じとみなす）', async () => {
      const srv = server()
      const row = srv.seed({ body: '本文T', categories: ['体調', '家族'] })
      DB.__testHooks.setClient(srv.client)
      const shown = { ...note({ id: row.id, body: '本文T' }), categories: ['家族', '体調'] }
      const res = await DB.deleteNote({ id: row.id }, shown, { meta: { note_on: LOCK_DAY, shift: 'day', resident_id: 1, after16: false } })
      assert.equal(DB.noteDeleted(res), true)
      assert.ok(Array.isArray(sentSeen(srv).categories))
    })

    it('列を返さない経路の行（categories が undefined）は分類を照らさない（タイムラインからの削除を止めない）', async () => {
      const srv = server()
      const row = srv.seed({ body: '本文U', categories: ['薬'] })
      DB.__testHooks.setClient(srv.client)
      const shown = note({ id: row.id, body: '本文U' })
      delete shown.categories
      const res = await DB.deleteNote({ id: row.id }, shown, { meta: { note_on: LOCK_DAY, shift: 'day', resident_id: 1, after16: false } })
      assert.equal(DB.noteDeleted(res), true)
      assert.equal(Object.prototype.hasOwnProperty.call(sentSeen(srv), 'categories'), false)
    })
  })
}
