// 与薬チェック（服薬介助）の回帰テスト。2026-09-26 追加。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/med.ts）: 締め判定・「未」の数え方・マスを押した時の動き（状態の遷移）・月次集計・頓服の入力検証
// 2. db.ts: 種類ごとの封鎖（input_enabled_med）・保存・修正・取り消し・送信待ち（cl_sendQueue）に載ること・hasPendingMed・
//    自然キーの競合・取得の範囲（偽の Supabase。通信しない）
// 3. 配線の静的検査（0013 の SQL・App のルート・記録ハブ・その他）
// 個人情報は置かない（利用者・職員は数値IDと記号だけ。氏名・記録本文・実在の薬の名前を書かない）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const TS_UNSUPPORTED =
  'この Node では TypeScript を直接読み込めないため、与薬チェックの検証をスキップしました（Node 22.18 以降で実行してください）。'
const DB_UNSUPPORTED =
  'この Node では解決フック（module.registerHooks）が使えないため、与薬チェックの db.ts の検証をスキップしました（Node 22.15 以降で実行してください）。'

let M = null
try {
  M = await import('../src/lib/med.ts')
} catch {
  M = null
}

// db.ts は拡張子の無い相対 import を使うので、'.ts' を補う解決フックを入れてから読む（tests/logic.test.mjs と同じ）
const lsStore = new Map()
let DB = null
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
} catch {
  DB = null
}

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

/** MedAdmin の最小形 */
function rec(id, residentId, day, slot, status = 'taken', over = {}) {
  return {
    id,
    resident_id: residentId,
    admin_on: day,
    slot,
    status,
    given_at: null,
    prn_drug: null,
    prn_reason: null,
    prn_effect: null,
    note: null,
    recorded_by: null,
    rev: 1,
    created_at: `${day}T00:00:00Z`,
    ...over,
  }
}

/** 入力の最小形（検証用） */
function input(over = {}) {
  return {
    admin_on: '2026-09-01',
    slot: 'morning',
    status: 'taken',
    given_at: null,
    prn_drug: null,
    prn_reason: null,
    prn_effect: null,
    note: null,
    ...over,
  }
}

const H = (h, m = 0) => h * 60 + m

// ══════════════════════════════════════════════════════════════
// 1. 純ロジック
// ══════════════════════════════════════════════════════════════

if (M === null) {
  it('与薬チェックの純ロジック', { skip: TS_UNSUPPORTED }, () => {})
} else {
  describe('締め判定（isPastDeadline・MED_DEADLINES）', () => {
    it('締め時刻は 朝10:00・昼14:00・夕20:00・眠前23:00（定数で持つ）', () => {
      assert.deepEqual({ ...M.MED_DEADLINES }, { morning: '10:00', noon: '14:00', evening: '20:00', bedtime: '23:00' })
      assert.equal(M.MED_RECHECK_MS, 60_000)
    })
    it('今日は締め時刻ちょうどから「過ぎた」（1分前はまだ）', () => {
      const t = '2026-09-26'
      assert.equal(M.isPastDeadline('morning', t, t, H(9, 59)), false)
      assert.equal(M.isPastDeadline('morning', t, t, H(10, 0)), true)
      assert.equal(M.isPastDeadline('noon', t, t, H(13, 59)), false)
      assert.equal(M.isPastDeadline('noon', t, t, H(14, 0)), true)
      assert.equal(M.isPastDeadline('evening', t, t, H(19, 59)), false)
      assert.equal(M.isPastDeadline('evening', t, t, H(20, 0)), true)
      assert.equal(M.isPastDeadline('bedtime', t, t, H(22, 59)), false)
      assert.equal(M.isPastDeadline('bedtime', t, t, H(23, 0)), true)
    })
    it('過去の日は時刻に関係なく過ぎている・未来の日は過ぎていない', () => {
      assert.equal(M.isPastDeadline('bedtime', '2026-09-25', '2026-09-26', H(0, 0)), true)
      assert.equal(M.isPastDeadline('morning', '2026-09-27', '2026-09-26', H(23, 59)), false)
    })
    it('締め時刻は差し替えられる（将来の設定化）', () => {
      const d = { morning: '09:00', noon: '13:00', evening: '19:00', bedtime: '21:30' }
      assert.equal(M.isPastDeadline('morning', '2026-09-26', '2026-09-26', H(9, 30), d), true)
      assert.equal(M.deadlineMinutes('bedtime', d), H(21, 30))
    })
    it('hmToMinutes は形の違う時刻を null にする', () => {
      assert.equal(M.hmToMinutes('7:05'), H(7, 5))
      for (const bad of ['', '24:00', '10:60', '10', 'x:y']) assert.equal(M.hmToMinutes(bad), null, bad)
    })
  })

  describe('服薬の時間帯の正規化（normalizeMedSlots・sameMedSlots）', () => {
    it('知らない値・重複・文字列以外は落とし、朝→昼→夕→眠前の順にそろえる', () => {
      assert.deepEqual(M.normalizeMedSlots(['bedtime', 'morning', 'lunch', 'morning', 3, null]), ['morning', 'bedtime'])
      assert.deepEqual(M.normalizeMedSlots('morning'), [])
      assert.deepEqual(M.normalizeMedSlots(undefined), [])
    })
    it('sameMedSlots は順を問わない', () => {
      assert.equal(M.sameMedSlots(['evening', 'morning'], ['morning', 'evening']), true)
      assert.equal(M.sameMedSlots(['morning'], ['morning', 'noon']), false)
    })
  })

  describe('1日の表（buildMedDayRows）と「未」の数え方（countMedDay）', () => {
    const day = '2026-09-26'
    const slotsBy = new Map([
      [1, ['morning', 'evening']],
      [2, ['morning', 'noon', 'evening', 'bedtime']],
      [3, []],
    ])
    it('設定の無い列は none（—）、締め前の未記録は open（空欄）、締め後の未記録は missing（未）、記録は record', () => {
      const rows = M.buildMedDayRows({
        order: [1, 2, 3],
        slotsByResident: slotsBy,
        records: [rec(10, 2, day, 'morning')],
        day,
        today: day,
        nowMin: H(12, 0),
      })
      assert.deepEqual(rows.map((r) => r.residentId), [1, 2, 3])
      const k = (r) => Object.fromEntries(Object.entries(r.cells).map(([s, c]) => [s, c.kind]))
      assert.deepEqual(k(rows[0]), { morning: 'missing', noon: 'none', evening: 'open', bedtime: 'none' })
      assert.deepEqual(k(rows[1]), { morning: 'record', noon: 'open', evening: 'open', bedtime: 'open' })
      assert.deepEqual(k(rows[2]), { morning: 'none', noon: 'none', evening: 'none', bedtime: 'none' })
      assert.deepEqual(M.countMedDay(rows), { missing: 1, incident: 0, recorded: 1 })
    })
    it('60秒ごとの再判定: 同じ表でも時刻が締めを越えると open → missing になる', () => {
      const at = (nowMin) =>
        M.buildMedDayRows({ order: [1], slotsByResident: slotsBy, records: [], day, today: day, nowMin })[0].cells.evening.kind
      assert.equal(at(H(19, 59)), 'open')
      assert.equal(at(H(20, 0)), 'missing')
    })
    it('過去の日は締めを過ぎたものとして扱う（設定のある未記録はすべて「未」）', () => {
      const rows = M.buildMedDayRows({ order: [2], slotsByResident: slotsBy, records: [], day: '2026-09-20', today: day, nowMin: H(6, 0) })
      assert.equal(M.countMedDay(rows).missing, 4)
    })
    it('落薬・誤薬を数える。頓服は表に入れない。設定の無い列の記録も記録として出す', () => {
      const rows = M.buildMedDayRows({
        order: [1, 3],
        slotsByResident: slotsBy,
        records: [
          rec(1, 1, day, 'morning', 'dropped'),
          rec(2, 1, day, 'evening', 'wrong'),
          rec(3, 1, day, 'prn', 'taken'),
          rec(4, 3, day, 'noon', 'taken'),
        ],
        day,
        today: day,
        nowMin: H(21, 0),
      })
      assert.deepEqual(M.countMedDay(rows), { missing: 0, incident: 2, recorded: 3 })
      assert.equal(rows[1].cells.noon.kind, 'record')
    })
    it('名簿に居ない人（退居など）の記録は後ろに足す（無言で隠さない）・同じマスに2件なら新しい id', () => {
      const rows = M.buildMedDayRows({
        order: [1],
        slotsByResident: slotsBy,
        records: [rec(5, 9, day, 'noon', 'taken'), rec(6, 1, day, 'morning', 'refused'), rec(7, 1, day, 'morning', 'partial')],
        day,
        today: day,
        nowMin: H(8, 0),
      })
      assert.deepEqual(rows.map((r) => r.residentId), [1, 9])
      assert.equal(rows[0].cells.morning.record.status, 'partial')
    })
    it('「未」は解禁済み かつ 記録を始めた日以降だけ（medMissingAllowed）。それ以外は締め後も空欄（open）で件数に数えない', () => {
      assert.equal(M.medMissingAllowed(true, '2026-09-10', '2026-09-26'), true)
      assert.equal(M.medMissingAllowed(true, '2026-09-26', '2026-09-26'), true, '始めた日そのもの')
      assert.equal(M.medMissingAllowed(true, '2026-09-27', '2026-09-26'), false, '始めた日より前')
      assert.equal(M.medMissingAllowed(true, null, '2026-09-26'), false, 'まだ1件も記録が無い')
      assert.equal(M.medMissingAllowed(false, '2026-09-10', '2026-09-26'), false, '封鎖中')
      const build = (missingAllowed) =>
        M.buildMedDayRows({ order: [2], slotsByResident: slotsBy, records: [rec(1, 2, day, 'noon', 'dropped')], day, today: day, nowMin: H(23, 30), missingAllowed })
      const off = build(false)
      assert.deepEqual(Object.values(off[0].cells).map((c) => c.kind), ['open', 'record', 'open', 'open'])
      assert.deepEqual(M.countMedDay(off), { missing: 0, incident: 1, recorded: 1 })
      assert.equal(M.countMedDay(build(true)).missing, 3)
      assert.equal(M.tapActionOf(off[0].cells.morning, false), 'insert', '空欄のままでも押せば記録できる')
    })

    it('別の日の記録は混ぜない', () => {
      const rows = M.buildMedDayRows({ order: [1], slotsByResident: slotsBy, records: [rec(1, 1, '2026-09-25', 'morning')], day, today: day, nowMin: H(8, 0) })
      assert.equal(rows[0].cells.morning.kind, 'open')
    })
  })

  describe('マスを押した時の動き・状態の遷移（tapActionOf・statusChoicesFor・isIncidentStatus）', () => {
    it('空欄と「未」は1回押すと記録（insert）・記録済みは小窓（dialog）・「—」は押せない', () => {
      assert.equal(M.tapActionOf({ kind: 'open' }, false), 'insert')
      assert.equal(M.tapActionOf({ kind: 'missing' }, false), 'insert')
      assert.equal(M.tapActionOf({ kind: 'record', record: rec(1, 1, '2026-09-01', 'morning') }, false), 'dialog')
      assert.equal(M.tapActionOf({ kind: 'none' }, false), 'none')
    })
    it('封鎖中・未送信・保存中（blocked）はどのマスも押せない', () => {
      for (const c of [{ kind: 'open' }, { kind: 'missing' }, { kind: 'record', record: rec(1, 1, '2026-09-01', 'noon') }]) {
        assert.equal(M.tapActionOf(c, true), 'none')
      }
    })
    it('時間帯の記録は7つの状態のどれにも直せる・頓服は服用済みだけ', () => {
      assert.deepEqual([...M.statusChoicesFor('morning')], ['taken', 'partial', 'refused', 'absent', 'stopped', 'dropped', 'wrong'])
      assert.deepEqual([...M.statusChoicesFor('prn')], ['taken'])
    })
    it('事故報告の案内が要るのは落薬・誤薬だけ', () => {
      const need = ['taken', 'partial', 'refused', 'absent', 'stopped', 'dropped', 'wrong'].filter((s) => M.isIncidentStatus(s))
      assert.deepEqual(need, ['dropped', 'wrong'])
    })
  })

  describe('入力の検証（validateMedAdminInput）: 時間帯の記録と頓服', () => {
    const today = '2026-09-26'
    const now = new Date(2026, 8, 26, 12, 0, 0)
    it('時間帯の記録は日付・時間帯・状態だけで通る。未来の日・知らない時間帯・知らない状態は止める', () => {
      assert.equal(M.validateMedAdminInput(input(), today, now).ok, true)
      assert.equal(M.validateMedAdminInput(input({ admin_on: '2026-09-27' }), today, now).ok, false)
      assert.equal(M.validateMedAdminInput(input({ admin_on: '2026/09/01' }), today, now).ok, false)
      assert.equal(M.validateMedAdminInput(input({ slot: 'lunch' }), today, now).ok, false)
      assert.equal(M.validateMedAdminInput(input({ status: 'done' }), today, now).ok, false)
    })
    it('時間帯の記録に頓服の項目（時刻・薬・理由・効果）は付けられない', () => {
      for (const over of [{ given_at: new Date(2026, 8, 1, 8).toISOString() }, { prn_drug: 'x' }, { prn_reason: 'x' }, { prn_effect: 'x' }]) {
        assert.equal(M.validateMedAdminInput(input(over), today, now).ok, false, JSON.stringify(over))
      }
    })
    const prn = (over = {}) =>
      input({
        slot: 'prn',
        admin_on: today,
        given_at: M.localDateTimeIso(today, '11:30'),
        prn_drug: '頓服薬A',
        prn_reason: '理由A',
        ...over,
      })
    it('頓服は 服用済み・使用時刻・薬・理由 がそろえば通る（効果・備考は任意）', () => {
      assert.equal(M.validateMedAdminInput(prn(), today, now).ok, true)
      assert.equal(M.validateMedAdminInput(prn({ prn_effect: '効果A', note: 'メモ' }), today, now).ok, true)
    })
    it('頓服は 服用済み以外・時刻なし・薬なし（空白だけ含む）・理由なし を止め、理由文を返す', () => {
      const cases = [
        [{ status: 'refused' }, /服用済み/],
        [{ given_at: null }, /時刻/],
        [{ given_at: 'x' }, /時刻/],
        [{ prn_drug: null }, /薬/],
        [{ prn_drug: '   ' }, /薬/],
        [{ prn_reason: '' }, /理由/],
      ]
      for (const [over, re] of cases) {
        const r = M.validateMedAdminInput(prn(over), today, now)
        assert.equal(r.ok, false, JSON.stringify(over))
        assert.match(r.message, re)
      }
    })
    it('頓服の時刻は選んでいる日の時刻・今より先（5分を超える）は止める', () => {
      assert.equal(M.validateMedAdminInput(prn({ given_at: M.localDateTimeIso('2026-09-25', '11:30') }), today, now).ok, false)
      assert.equal(M.validateMedAdminInput(prn({ given_at: M.localDateTimeIso(today, '12:04') }), today, now).ok, true)
      assert.equal(M.validateMedAdminInput(prn({ given_at: M.localDateTimeIso(today, '12:30') }), today, now).ok, false)
    })
    it('時刻の変換（localDateTimeIso・fmtClock・clockInputValue・localDayOf）は端末の時刻で往復する', () => {
      const iso = M.localDateTimeIso('2026-09-26', '07:05')
      assert.equal(M.fmtClock(iso), '7:05')
      assert.equal(M.clockInputValue(iso), '07:05')
      assert.equal(M.localDayOf(iso), '2026-09-26')
      assert.equal(M.localDateTimeIso('2026-02-30', '07:05'), null)
      assert.equal(M.localDateTimeIso('2026-09-26', '25:00'), null)
      assert.equal(M.fmtClock(null), '')
    })
  })

  describe('月次集計（aggregateMedMonth）', () => {
    const base = {
      monthKey: '2026-09',
      residentId: 1,
      slots: ['morning', 'evening'],
      startDay: '2026-09-10',
      today: '2026-09-26',
      nowMin: H(15, 0),
    }
    it('行は1日〜月末。記録は状態、設定のある列の締め後の未記録は「未」、頓服は回数', () => {
      const t = M.aggregateMedMonth({
        ...base,
        records: [
          rec(1, 1, '2026-09-10', 'morning', 'taken'),
          rec(2, 1, '2026-09-10', 'evening', 'refused'),
          rec(3, 1, '2026-09-11', 'prn'),
          rec(4, 1, '2026-09-11', 'prn'),
          rec(5, 1, '2026-09-12', 'noon', 'dropped'),
          rec(6, 2, '2026-09-12', 'morning', 'taken'), // 別の人は数えない
          rec(7, 1, '2026-10-01', 'morning', 'taken'), // 別の月は数えない
        ],
      })
      assert.equal(t.days.length, 30)
      const d = (n) => t.days[n - 1]
      assert.deepEqual(d(10).cells, { morning: 'taken', noon: null, evening: 'refused', bedtime: null })
      assert.equal(d(11).prn, 2)
      assert.deepEqual(d(11).cells, { morning: 'missing', noon: null, evening: 'missing', bedtime: null })
      assert.equal(d(12).cells.noon, 'dropped', '設定の無い列の記録もそのまま出す')
      assert.equal(t.totals.prn, 2)
      assert.equal(t.totals.byStatus.taken, 1)
      assert.equal(t.totals.byStatus.refused, 1)
      assert.equal(t.totals.byStatus.dropped, 1)
    })
    it('「未」は記録を始めた日より前・今日の締め前・未来の日には付けない', () => {
      const t = M.aggregateMedMonth({ ...base, records: [] })
      const d = (n) => t.days[n - 1].cells
      assert.deepEqual(d(9), { morning: null, noon: null, evening: null, bedtime: null }, '始めた日より前')
      assert.deepEqual(d(25), { morning: 'missing', noon: null, evening: 'missing', bedtime: null }, '昨日')
      assert.deepEqual(d(26), { morning: 'missing', noon: null, evening: null, bedtime: null }, '今日 15:00＝朝は過ぎ・夕はまだ')
      assert.deepEqual(d(27), { morning: null, noon: null, evening: null, bedtime: null }, '未来')
      // 10日〜25日の16日×2列＋今日の朝
      assert.equal(t.totals.missing, 16 * 2 + 1)
      assert.equal(t.totals.bySlot.morning.missing, 17)
      assert.equal(t.totals.bySlot.evening.missing, 16)
    })
    it('記録が1件も無い施設（startDay=null）・退居された方には「未」を付けない', () => {
      assert.equal(M.aggregateMedMonth({ ...base, startDay: null, records: [] }).totals.missing, 0)
      assert.equal(M.aggregateMedMonth({ ...base, retired: true, records: [] }).totals.missing, 0)
    })
    it('設定が無い方（slots 空）は記録だけを出し「未」を付けない', () => {
      const t = M.aggregateMedMonth({ ...base, slots: [], records: [rec(1, 1, '2026-09-15', 'noon', 'absent')] })
      assert.equal(t.totals.missing, 0)
      assert.equal(t.days[14].cells.noon, 'absent')
      assert.equal(t.totals.bySlot.noon.recorded, 1)
    })
    it('同じマスに2件あれば新しい id を採る（DB の1人1日1時間帯1件の保険）', () => {
      const t = M.aggregateMedMonth({
        ...base,
        records: [rec(9, 1, '2026-09-15', 'morning', 'refused'), rec(3, 1, '2026-09-15', 'morning', 'taken')],
      })
      assert.equal(t.days[14].cells.morning, 'refused')
      assert.equal(t.totals.bySlot.morning.recorded, 1)
    })
  })
}

// ══════════════════════════════════════════════════════════════
// 2. db.ts（偽の Supabase・通信しない）
// ══════════════════════════════════════════════════════════════

/**
 * 偽の Supabase クライアント。db.ts が使う連鎖（from → insert/update/select → eq/is/in/gte/lte/order/limit →
 * maybeSingle と rpc・channel）だけを受け、発行された要求を calls に記録する。応答は handler(要求) が返す
 */
function fakeSupabase(handler) {
  const calls = []
  const builder = (q) => {
    const run = () => {
      calls.push(q)
      return Promise.resolve(handler(q))
    }
    const b = {
      select(cols) {
        if (q.action === 'select' && q.cols === undefined) q.cols = cols
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
      gte(k, v) {
        q.filters.push(['gte', k, v])
        return b
      },
      lte(k, v) {
        q.filters.push(['lte', k, v])
        return b
      },
      or(expr) {
        q.filters.push(['or', expr])
        return b
      },
      limit(n) {
        q.limit = n
        return b
      },
      order(col, opts) {
        q.orders = [...(q.orders ?? []), [col, opts?.ascending !== false]]
        return b
      },
      maybeSingle: run,
      then: (ok, ng) => run().then(ok, ng),
    }
    return b
  }
  const from = (table) => builder({ table, action: 'select', payload: undefined, filters: [] })
  const rpc = (fn, args) => builder({ table: null, action: 'rpc', fn, args, payload: undefined, filters: [] })
  const channel = () => {
    const ch = { on: () => ch, subscribe: () => ch }
    return ch
  }
  return { client: { from, rpc, channel, removeChannel: () => Promise.resolve(), auth: { onAuthStateChange() {} } }, calls }
}

const eqOf = (q) => Object.fromEntries(q.filters.filter(([op]) => op === 'eq').map(([, k, v]) => [k, v]))

/**
 * 与薬の偽のサーバー。med_slots（1人1件）・med_admin（1人1日1時間帯1件・頓服は何件でも）の部分 unique と
 * client_key の全体 unique、rev の自動加算、app_settings・residents に答える。
 * opts.offline() が true の間は通信できない。opts.missingTable は 0013 未適用（42P01）
 */
function medServer(opts = {}) {
  const db = {
    slots: [],
    admin: [],
    nextId: 1,
    settings: { native_input_enabled: 'false', input_enabled_bath: 'false', input_enabled_med: 'true' },
    residents: [
      { id: 1, source_id: 'S1', name: '利用者A', kana: null, room: '101', gender: null, care_level: null, active: true, needs_review: false, note_alias: null },
      { id: 2, source_id: 'S2', name: '利用者B', kana: null, room: '201', gender: null, care_level: null, active: true, needs_review: false, note_alias: null },
      { id: 3, source_id: 'S3', name: '利用者C', kana: null, room: '202', gender: null, care_level: null, active: false, needs_review: false, note_alias: null },
    ],
  }
  const match = (q, r) =>
    q.filters.every(([op, k, v]) => {
      if (op === 'eq' || op === 'is') return r[k] === v
      if (op === 'in') return v.includes(r[k])
      if (op === 'gte') return r[k] >= v
      if (op === 'lte') return r[k] <= v
      return true
    })
  const tableOf = (name) => (name === 'med_slots' ? db.slots : db.admin)
  const dupNatural = (name, p) =>
    name === 'med_slots'
      ? db.slots.some((r) => r.deleted_at === null && r.resident_id === p.resident_id)
      : p.slot !== 'prn' &&
        db.admin.some((r) => r.deleted_at === null && r.resident_id === p.resident_id && r.admin_on === p.admin_on && r.slot === p.slot)
  const fake = fakeSupabase((q) => {
    if (opts.offline?.()) return { data: null, error: { message: 'offline' }, status: 0 }
    if (q.table === 'app_settings') {
      const key = eqOf(q).key
      return { data: key in db.settings ? { value: db.settings[key] } : null, error: null, status: 200 }
    }
    if (q.table === 'residents') return { data: db.residents.filter((r) => match(q, r)), error: null, status: 200 }
    if (q.table === 'med_slots' || q.table === 'med_admin') {
      if (opts.missingTable) return { data: null, error: { code: '42P01', message: 'undefined table' }, status: 404 }
      const rows = tableOf(q.table)
      if (q.action === 'insert') {
        const p = q.payload
        const dupKey = p.client_key && rows.some((r) => r.client_key === p.client_key)
        if (dupKey || dupNatural(q.table, p)) return { data: null, error: { code: '23505', message: 'duplicate key' }, status: 409 }
        const row = { id: db.nextId++, rev: 1, deleted_at: null, edited_by: null, created_at: '2026-09-01T00:00:00Z', ...p }
        rows.push(row)
        return { data: { ...row }, error: null, status: 201 }
      }
      if (q.action === 'update') {
        const r = rows.find((x) => match(q, x))
        if (!r) return { data: null, error: null, status: 200 }
        Object.assign(r, q.payload, { rev: r.rev + 1 })
        return { data: { ...r }, error: null, status: 200 }
      }
      const hits = rows.filter((x) => match(q, x))
      for (const [col, asc] of [...(q.orders ?? [])].reverse()) {
        hits.sort((a, b) => (a[col] === b[col] ? 0 : (a[col] < b[col]) === asc ? -1 : 1))
      }
      if (q.limit === 1) return { data: hits[0] ? { ...hits[0] } : null, error: null, status: 200 }
      return { data: hits.slice(0, q.limit ?? hits.length).map((x) => ({ ...x })), error: null, status: 200 }
    }
    if (q.action === 'select') return { data: [], error: null, status: 200 }
    return { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
  })
  return { ...fake, db }
}

/** 与薬の記録の入力（時間帯の記録） */
const medInput = (over = {}) => ({
  resident_id: 1,
  admin_on: '2026-09-01',
  slot: 'morning',
  status: 'taken',
  given_at: null,
  prn_drug: null,
  prn_reason: null,
  prn_effect: null,
  note: null,
  recorded_by: 3,
  ...over,
})

function storedOps() {
  const raw = lsStore.get('cl_sendQueue')
  return raw === undefined ? [] : (JSON.parse(raw).ops ?? [])
}

async function drain() {
  await new Promise((r) => setTimeout(r, 10))
  lsStore.delete('cl_sendQueue')
  lsStore.delete('cl_sendQueue2')
  await DB.__testHooks.restartQueue()
  DB.__testHooks.setClient(null)
}

if (DB === null || M === null) {
  it('与薬チェックの db.ts の検証', { skip: DB_UNSUPPORTED }, () => {})
} else {
  describe('与薬（db.ts）: 種類ごとの入力解禁 input_enabled_med', () => {
    afterEach(drain)

    it('input_enabled_med が false なら、native・入浴が解禁でも与薬の記録は書かずに与薬の理由文で止める', async () => {
      const srv = medServer()
      Object.assign(srv.db.settings, { native_input_enabled: 'true', input_enabled_bath: 'true', input_enabled_med: 'false' })
      DB.__testHooks.setClient(srv.client, { kinds: { bath: null, med: null } })
      await assert.rejects(() => DB.insertMedAdmin(medInput()), (e) => e.kind === 'blocked' && e.message === DB.kindBlockedMessage('med'))
      const cur = { id: 5, ...medInput(), rev: 1, created_at: null }
      await assert.rejects(() => DB.updateMedAdmin(cur, { status: 'refused' }), (e) => e.kind === 'blocked')
      await assert.rejects(() => DB.softDeleteMedAdmin(5, 1), (e) => e.kind === 'blocked')
      assert.equal(srv.calls.filter((q) => q.table === 'med_admin').length, 0, '封鎖中に与薬の記録を書き込んだ')
      assert.deepEqual(await DB.getKindInputGate('med'), { value: false, observed: true })
    })

    it('★服薬の時間帯は封鎖の対象外: input_enabled_med・native・入浴がすべて封鎖でも保存できる（2026-09-26 チーフ裁定）', async () => {
      const srv = medServer()
      Object.assign(srv.db.settings, { native_input_enabled: 'false', input_enabled_bath: 'false', input_enabled_med: 'false' })
      DB.__testHooks.setClient(srv.client, { native: false, cellRpc: 'missing', kinds: { bath: false, med: false } })
      const created = await DB.setMedSlots(1, ['morning', 'evening'], null, null)
      assert.deepEqual(created.slots, ['morning', 'evening'])
      const updated = await DB.setMedSlots(1, ['noon'], null, created, { editedBy: 2 })
      assert.deepEqual(updated.slots, ['noon'])
      // 旗が未観測（取得できない）でも止めない＝旗を問い合わせない
      const srv2 = medServer()
      srv2.db.settings.input_enabled_med = 'false'
      DB.__testHooks.setClient(srv2.client, { native: null, kinds: { bath: null, med: null } })
      assert.deepEqual((await DB.setMedSlots(2, ['bedtime'], null, null)).slots, ['bedtime'])
      assert.equal(srv2.calls.filter((q) => q.table === 'app_settings').length, 0, '服薬の時間帯の保存で旗を問い合わせた')
      // 与薬の記録は同じ端末・同じ状態（旗は false）で止まる
      await assert.rejects(() => DB.insertMedAdmin(medInput()), (e) => e.kind === 'blocked')
      assert.equal(srv2.db.admin.length, 0)
    })

    it('input_enabled_med が true なら native・入浴が封鎖でも書ける（旗は独立）', async () => {
      const srv = medServer()
      DB.__testHooks.setClient(srv.client, { native: false, kinds: { bath: false, med: null } })
      const row = await DB.insertMedAdmin(medInput())
      assert.equal(row.status, 'taken')
      await assert.rejects(() => DB.insertBath({ resident_id: 1, bath_on: '2026-09-01', result: 'full', cancel_reason: null, note: null, recorded_by: 1 }), (e) => e.kind === 'blocked')
    })

    it('旗を取得できない（未観測）時は与薬の記録を gate-unknown で書かない', async () => {
      const off = fakeSupabase(() => ({ data: null, error: { message: 'offline' }, status: 0 }))
      DB.__testHooks.setClient(off.client, { kinds: { med: null } })
      assert.deepEqual(await DB.getKindInputGate('med'), { value: false, observed: false })
      await assert.rejects(() => DB.insertMedAdmin(medInput()), (e) => e.kind === 'gate-unknown')
    })
  })

  describe('与薬（db.ts）: 記録・修正・取り消し', () => {
    afterEach(drain)

    it('insertMedAdmin は client_key を付けて1行追加し、時間帯の記録では頓服の項目を null で送る', async () => {
      const srv = medServer()
      DB.__testHooks.setClient(srv.client)
      const row = await DB.insertMedAdmin(medInput({ note: '  ' }))
      assert.equal(row.slot, 'morning')
      const ins = srv.calls.find((q) => q.table === 'med_admin' && q.action === 'insert')
      assert.equal(typeof ins.payload.client_key, 'string')
      assert.deepEqual(
        [ins.payload.given_at, ins.payload.prn_drug, ins.payload.prn_reason, ins.payload.prn_effect, ins.payload.note],
        [null, null, null, null, null],
      )
      assert.equal(ins.payload.recorded_by, 3)
    })

    it('他の端末が同じ人・同じ日・同じ時間帯を先に記録していたら conflict（行を増やさない）', async () => {
      const srv = medServer()
      srv.db.admin.push({ id: 50, ...medInput(), rev: 1, deleted_at: null, client_key: 'other-device' })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.insertMedAdmin(medInput({ status: 'refused' })), 'conflict')
      assert.equal(srv.db.admin.length, 1)
      assert.equal(srv.db.admin[0].status, 'taken', '他の端末の記録を書き換えた')
    })

    it('頓服は同じ日に何件でも記録でき、使用時刻・薬・理由が無いと送る前に止める', async () => {
      const srv = medServer()
      DB.__testHooks.setClient(srv.client)
      const p = medInput({ slot: 'prn', given_at: M.localDateTimeIso('2026-09-01', '09:00'), prn_drug: '頓服薬A', prn_reason: '理由A' })
      assert.equal((await DB.insertMedAdmin(p)).slot, 'prn')
      assert.equal((await DB.insertMedAdmin(p)).slot, 'prn')
      assert.equal(srv.db.admin.length, 2)
      await assert.rejects(() => DB.insertMedAdmin({ ...p, prn_drug: ' ' }), /薬/)
      await assert.rejects(() => DB.insertMedAdmin({ ...p, status: 'refused' }), /服用済み/)
      await assert.rejects(() => DB.insertMedAdmin(medInput({ admin_on: '2999-01-01' })), /未来/)
      assert.equal(srv.db.admin.length, 2)
    })

    it('updateMedAdmin は変えた項目と edited_by だけを rev 照合で送る。古い rev は conflict', async () => {
      const srv = medServer()
      DB.__testHooks.setClient(srv.client)
      const first = await DB.insertMedAdmin(medInput())
      const next = await DB.updateMedAdmin(first, { status: 'dropped' }, { editedBy: 5 })
      assert.equal(next.status, 'dropped')
      assert.equal(next.rev, 2)
      const up = srv.calls.filter((q) => q.table === 'med_admin' && q.action === 'update').at(-1)
      assert.deepEqual(up.payload, { status: 'dropped', edited_by: 5 })
      assert.deepEqual(eqOf(up), { id: first.id, rev: 1 })
      assert.equal(await DB.updateMedAdmin(first, { status: 'taken' }), 'conflict')
    })

    it('時間帯の記録に頓服の効果は付けられない・頓服の効果は後から追記できる', async () => {
      const srv = medServer()
      DB.__testHooks.setClient(srv.client)
      const slotRow = await DB.insertMedAdmin(medInput())
      await assert.rejects(() => DB.updateMedAdmin(slotRow, { prn_effect: '効果' }))
      const prn = await DB.insertMedAdmin(
        medInput({ slot: 'prn', given_at: M.localDateTimeIso('2026-09-01', '09:00'), prn_drug: '頓服薬A', prn_reason: '理由A' }),
      )
      const withEffect = await DB.updateMedAdmin(prn, { prn_effect: '効果A' }, { editedBy: 2 })
      assert.equal(withEffect.prn_effect, '効果A')
      assert.equal(withEffect.prn_drug, '頓服薬A')
    })

    it('softDeleteMedAdmin は deleted_at と edited_by の update（物理削除しない）・取り消し後は同じマスに記録し直せる', async () => {
      const srv = medServer()
      DB.__testHooks.setClient(srv.client)
      const row = await DB.insertMedAdmin(medInput())
      assert.equal(await DB.softDeleteMedAdmin(row.id, row.rev, { editedBy: 4 }), true)
      const up = srv.calls.filter((q) => q.table === 'med_admin' && q.action === 'update').at(-1)
      assert.deepEqual(Object.keys(up.payload).sort(), ['deleted_at', 'edited_by'])
      assert.equal(await DB.softDeleteMedAdmin(row.id, row.rev), 'conflict', '取り消し済みを二重に取り消した')
      assert.equal((await DB.insertMedAdmin(medInput({ status: 'partial' }))).status, 'partial')
    })
  })

  describe('与薬（db.ts）: 送信待ち（cl_sendQueue）と hasPendingMed', () => {
    afterEach(drain)

    it('通信できない記録は med_admin の op として cl_sendQueue に残り、次の起動でも読めて、電波が戻ると同じキーで1行だけ載る', async () => {
      let off = true
      const srv = medServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.insertMedAdmin(medInput()), 'queued')
      const ops = storedOps()
      assert.equal(ops.length, 1)
      assert.deepEqual([ops[0].table, ops[0].kind], ['med_admin', 'insert'])
      assert.equal(ops[0].qid, ops[0].payload.client_key)
      await DB.__testHooks.restartQueue() // 次の起動（LEGACY_TABLES に med_admin があるので捨てずに読める）
      assert.equal(DB.queuePending(), 1)
      assert.equal(DB.isQueueBroken(), false)
      off = false
      await DB.flushQueue(true)
      assert.equal(srv.db.admin.length, 1)
      assert.equal(DB.queuePending(), 0)
      await DB.flushQueue(true)
      assert.equal(srv.db.admin.length, 1)
    })

    it('hasPendingMed: 未送信の追加はその人・その日・その時間帯だけ true、送れたら false（送信待ちの中身は変えない）', async () => {
      let off = true
      const srv = medServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      assert.equal(DB.hasPendingMed(1, '2026-09-01', 'morning'), false)
      assert.equal(await DB.insertMedAdmin(medInput()), 'queued')
      const before = JSON.stringify(storedOps().map((o) => [o.qid, o.payload]))
      assert.equal(DB.hasPendingMed(1, '2026-09-01', 'morning'), true)
      assert.equal(DB.hasPendingMed(1, '2026-09-01', 'noon'), false, '別の時間帯')
      assert.equal(DB.hasPendingMed(2, '2026-09-01', 'morning'), false, '別の人')
      assert.equal(DB.hasPendingMed(1, '2026-09-02', 'morning'), false, '別の日')
      assert.equal(JSON.stringify(storedOps().map((o) => [o.qid, o.payload])), before, '判定で送信待ちを書き換えた')
      off = false
      await DB.flushQueue(true)
      assert.equal(DB.hasPendingMed(1, '2026-09-01', 'morning'), false)
    })

    it('hasPendingMed: 修正・取り消しの送信待ちはその記録（recordId）で true。頓服の追加は既存の頓服の記録を止めない', async () => {
      const off = fakeSupabase(() => ({ data: null, error: { message: 'offline' }, status: 0 }))
      DB.__testHooks.setClient(off.client)
      const cur = { id: 5, ...medInput(), rev: 3, created_at: null }
      assert.equal(await DB.updateMedAdmin(cur, { status: 'refused' }, { editedBy: 6 }), 'queued')
      assert.equal(DB.hasPendingMed(1, '2026-09-01', 'morning', 5), true)
      assert.equal(DB.hasPendingMed(1, '2026-09-01', 'morning', 6), false)
      const op = storedOps()[0]
      assert.deepEqual([op.table, op.kind, op.rowId, op.rev], ['med_admin', 'update', 5, 3])
      assert.deepEqual(op.payload, { status: 'refused', edited_by: 6 })
      const p = medInput({ slot: 'prn', given_at: M.localDateTimeIso('2026-09-01', '09:00'), prn_drug: '頓服薬A', prn_reason: '理由A' })
      assert.equal(await DB.insertMedAdmin(p), 'queued')
      assert.equal(DB.hasPendingMed(1, '2026-09-01', 'prn'), true, '頓服の追加そのもの')
      assert.equal(DB.hasPendingMed(1, '2026-09-01', 'prn', 99), false, '既にある別の頓服の記録は止めない')
    })

    it('★頓服の未送信は送信待ちから読める: 圏外で頓服→画面を作り直す（次の起動）→ pendingPrnOps に未送信として残る・送れたら消える', async () => {
      let off = true
      const srv = medServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      const prn = medInput({ slot: 'prn', given_at: M.localDateTimeIso('2026-09-01', '09:00'), prn_drug: '頓服薬A', prn_reason: '理由A', note: 'メモ' })
      assert.equal(await DB.insertMedAdmin(prn), 'queued')
      assert.equal(await DB.insertMedAdmin(medInput()), 'queued') // 時間帯の記録は頓服の一覧に出さない
      await DB.__testHooks.restartQueue() // 再読み込み相当（メモリを捨てて localStorage から読み直す）
      const list = DB.pendingPrnOps('2026-09-01')
      assert.equal(list.length, 1)
      assert.deepEqual(
        { ...list[0], qid: typeof list[0].qid },
        { qid: 'string', residentId: 1, givenAt: prn.given_at, drug: '頓服薬A', reason: '理由A', note: 'メモ', state: 'waiting' },
      )
      assert.deepEqual(DB.pendingPrnOps('2026-09-02'), [], '別の日（日付を切り替えた先）には出さない')
      // 止まっている op も出す（state=blocked）。読むだけで送信待ちは変えない
      const raw = JSON.parse(lsStore.get('cl_sendQueue'))
      raw.ops.find((o) => o.payload.slot === 'prn').blocked = 'rejected'
      lsStore.set('cl_sendQueue', JSON.stringify(raw))
      await DB.__testHooks.restartQueue()
      const beforeRaw = lsStore.get('cl_sendQueue')
      assert.equal(DB.pendingPrnOps('2026-09-01')[0].state, 'blocked')
      assert.equal(lsStore.get('cl_sendQueue'), beforeRaw, '読んだだけで送信待ちが変わった')
      // 止めていない状態に戻して送る → 一覧から消え、サーバーに1件だけ載る
      raw.ops.find((o) => o.payload.slot === 'prn').blocked = undefined
      lsStore.set('cl_sendQueue', JSON.stringify(raw))
      await DB.__testHooks.restartQueue()
      off = false
      await DB.flushQueue(true)
      assert.deepEqual(DB.pendingPrnOps('2026-09-01'), [])
      assert.equal(srv.db.admin.filter((r) => r.slot === 'prn').length, 1)
    })

    it('★送信待ちの間に他の端末が同じマスを記録した → 止めて残す（blocked=conflict・未送信として数え続け、hasPendingMed は false）', async () => {
      let off = true
      const srv = medServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.insertMedAdmin(medInput({ status: 'refused' })), 'queued')
      srv.db.admin.push({ id: 60, ...medInput(), rev: 1, deleted_at: null, client_key: 'other-device' })
      off = false
      await DB.flushQueue(true)
      const ops = storedOps()
      assert.equal(ops.length, 1)
      assert.equal(ops[0].blocked, 'conflict')
      assert.equal(DB.queuePending(), 1)
      assert.equal(srv.db.admin.length, 1)
      assert.equal(srv.db.admin[0].status, 'taken', '他の端末の記録を書き換えた')
      assert.equal(DB.hasPendingMed(1, '2026-09-01', 'morning'), false)
    })

    it('★送信待ちの op は与薬の操作の前後で（送れた分が消える以外に）変わらない（差し替え・破棄・中身の書き換えをしない）', async () => {
      let off = true
      const srv = medServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      const prn = medInput({ slot: 'prn', given_at: M.localDateTimeIso('2026-09-01', '09:00'), prn_drug: '頓服薬A', prn_reason: '理由A' })
      // 圏外で、同じマスの追加・頓服・時間帯の設定・別の記録の修正と取り消しを積む
      assert.equal(await DB.insertMedAdmin(medInput()), 'queued')
      assert.equal(await DB.insertMedAdmin(prn), 'queued')
      assert.equal(await DB.setMedSlots(2, ['noon'], null, null), 'queued')
      assert.equal(await DB.updateMedAdmin({ id: 7, ...medInput({ resident_id: 2 }), rev: 2, created_at: null }, { status: 'refused' }), 'queued')
      const snap = (ops) => ops.map((o) => JSON.stringify([o.qid, o.table, o.kind, o.rowId ?? null, o.rev ?? null, o.payload]))
      const before = snap(storedOps())
      assert.equal(before.length, 4)
      // 読むだけの関数・同じマスをもう一度押す（新しい op が後ろに足されるだけ）・別の記録の取り消し
      DB.hasPendingMed(1, '2026-09-01', 'morning')
      DB.hasPendingMedSlots(2, null)
      DB.pendingPrnOps('2026-09-01')
      assert.equal(await DB.insertMedAdmin(medInput({ status: 'partial' })), 'queued')
      assert.equal(await DB.softDeleteMedAdmin(8, 1), 'queued')
      await DB.__testHooks.restartQueue()
      const mid = snap(storedOps())
      assert.deepEqual(mid.slice(0, 4), before, '積んであった op の中身が変わった・消えた')
      assert.equal(mid.length, 6)
      // 電波が戻る: 他の端末が同じマスを先に記録していた → その op は止まって残る（中身は同じ）。送れた op だけが消える
      srv.db.admin.push({ id: 60, ...medInput(), rev: 1, deleted_at: null, client_key: 'other-device' })
      srv.db.admin.push({ id: 7, ...medInput({ resident_id: 2 }), rev: 2, deleted_at: null, client_key: 'x7' })
      srv.db.admin.push({ id: 8, ...medInput({ resident_id: 2, slot: 'noon' }), rev: 1, deleted_at: null, client_key: 'x8' })
      off = false
      await DB.flushQueue(true)
      const after = storedOps()
      const sentKeys = new Set([...srv.db.admin, ...srv.db.slots].map((r) => r.client_key).filter(Boolean))
      for (const s of mid) {
        const [qid] = JSON.parse(s)
        const still = after.find((o) => o.qid === qid)
        if (still === undefined) {
          // 消えてよいのは「サーバーに載った」ことが確かめられた op だけ（追加は client_key、更新は行の rev が進んだ）
          const op = JSON.parse(s)
          const landed = op[2] === 'insert' ? sentKeys.has(op[0]) : [...srv.db.admin].some((r) => r.id === op[3] && r.rev > op[4])
          assert.ok(landed, `載っていない op が消えた: ${op[1]} ${op[2]}`)
        } else {
          assert.equal(snap([still])[0], s, '残った op の中身が変わった')
        }
      }
      const blocked = after.filter((o) => o.blocked === 'conflict')
      assert.equal(blocked.length, 2, '同じマスの2つの追加は他の端末の記録と重なって止まる')
      assert.ok(blocked.every((o) => o.table === 'med_admin' && o.payload.slot === 'morning'))
    })
  })

  describe('与薬（db.ts）: 服薬の時間帯 setMedSlots・hasPendingMedSlots', () => {
    afterEach(drain)

    it('設定が無ければ insert（朝→眠前の順にそろえる）、あれば rev 照合の update', async () => {
      const srv = medServer()
      DB.__testHooks.setClient(srv.client)
      const created = await DB.setMedSlots(1, ['evening', 'morning'], '  ', null)
      assert.deepEqual(created.slots, ['morning', 'evening'])
      assert.equal(created.note, null)
      const ins = srv.calls.find((q) => q.table === 'med_slots' && q.action === 'insert')
      assert.equal(typeof ins.payload.client_key, 'string')
      const updated = await DB.setMedSlots(1, ['morning', 'noon', 'evening', 'bedtime'], 'メモ', created, { editedBy: 2 })
      assert.equal(updated.rev, 2)
      const up = srv.calls.filter((q) => q.table === 'med_slots' && q.action === 'update').at(-1)
      assert.deepEqual(up.payload, { slots: ['morning', 'noon', 'evening', 'bedtime'], note: 'メモ', edited_by: 2 })
      assert.equal(await DB.setMedSlots(1, ['noon'], null, created), 'conflict', '古い rev で上書きした')
    })

    it('他の端末が先に設定していれば conflict・知らない時間帯・別の人の設定は送る前に止める', async () => {
      const srv = medServer()
      srv.db.slots.push({ id: 90, resident_id: 1, slots: ['noon'], note: null, rev: 1, deleted_at: null, client_key: 'other' })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.setMedSlots(1, ['morning'], null, null), 'conflict')
      await assert.rejects(() => DB.setMedSlots(2, ['lunch'], null, null), /時間帯/)
      await assert.rejects(() => DB.setMedSlots(2, ['morning'], null, { id: 90, resident_id: 1, slots: [], note: null, rev: 1 }))
      assert.equal(srv.db.slots.length, 1)
    })

    it('通信できない時は送信待ち（med_slots の op）・hasPendingMedSlots はその人・その設定で true', async () => {
      const off = fakeSupabase(() => ({ data: null, error: { message: 'offline' }, status: 0 }))
      DB.__testHooks.setClient(off.client)
      assert.equal(await DB.setMedSlots(1, ['morning'], null, null), 'queued')
      assert.equal(DB.hasPendingMedSlots(1, null), true)
      assert.equal(DB.hasPendingMedSlots(2, null), false)
      assert.equal(await DB.setMedSlots(2, ['noon'], null, { id: 7, resident_id: 2, slots: [], note: null, rev: 1 }), 'queued')
      assert.equal(DB.hasPendingMedSlots(2, 7), true)
      assert.deepEqual(storedOps().map((o) => [o.table, o.kind]), [
        ['med_slots', 'insert'],
        ['med_slots', 'update'],
      ])
    })
  })

  describe('与薬（db.ts）: 取得の範囲・カルテ・表が無い DB', () => {
    afterEach(drain)

    it('fetchMedSlots は在籍の方の ID だけで引く（退居・削除済みは含めない）', async () => {
      const srv = medServer()
      srv.db.slots.push(
        { id: 1, resident_id: 1, slots: ['morning', 'bogus'], note: null, rev: 1, deleted_at: null },
        { id: 2, resident_id: 3, slots: ['noon'], note: null, rev: 1, deleted_at: null },
        { id: 3, resident_id: 2, slots: ['noon'], note: null, rev: 2, deleted_at: '2026-09-01T00:00:00Z' },
      )
      DB.__testHooks.setClient(srv.client)
      const list = await DB.fetchMedSlots()
      assert.deepEqual(list.map((s) => [s.resident_id, s.slots]), [[1, ['morning']]])
      const q = srv.calls.filter((c) => c.table === 'med_slots').at(-1)
      assert.deepEqual(q.filters.find(([op]) => op === 'in'), ['in', 'resident_id', [1, 2]])
    })

    it('fetchMedDay は日付で、fetchMedMonth は1人なら1回・全員なら7日ずつ分けて月の範囲だけを引く（削除済みを除く）', async () => {
      const srv = medServer()
      srv.db.admin.push(
        { id: 1, ...medInput({ admin_on: '2026-09-01' }), rev: 1, deleted_at: null },
        { id: 2, ...medInput({ admin_on: '2026-09-30', resident_id: 2 }), rev: 1, deleted_at: null },
        { id: 3, ...medInput({ admin_on: '2026-09-15', slot: 'noon' }), rev: 1, deleted_at: '2026-09-15T00:00:00Z' },
        { id: 4, ...medInput({ admin_on: '2026-10-01' }), rev: 1, deleted_at: null },
      )
      DB.__testHooks.setClient(srv.client)
      assert.deepEqual((await DB.fetchMedDay('2026-09-01')).map((r) => r.id), [1])
      const before = srv.calls.length
      assert.deepEqual((await DB.fetchMedMonth('2026-09', 1)).map((r) => r.id), [1])
      assert.equal(srv.calls.length - before, 1)
      const one = srv.calls.at(-1)
      assert.deepEqual(one.filters.filter(([op]) => op !== 'is'), [
        ['eq', 'resident_id', 1],
        ['gte', 'admin_on', '2026-09-01'],
        ['lte', 'admin_on', '2026-09-30'],
      ])
      const start = srv.calls.length
      assert.deepEqual((await DB.fetchMedMonth('2026-09')).map((r) => r.id).sort(), [1, 2])
      const spans = srv.calls.slice(start).map((c) => [c.filters.find(([op]) => op === 'gte')[2], c.filters.find(([op]) => op === 'lte')[2]])
      assert.deepEqual(spans, [
        ['2026-09-01', '2026-09-07'],
        ['2026-09-08', '2026-09-14'],
        ['2026-09-15', '2026-09-21'],
        ['2026-09-22', '2026-09-28'],
        ['2026-09-29', '2026-09-30'],
      ])
      for (const c of srv.calls.slice(start)) assert.ok(c.filters.some(([op, k, v]) => op === 'is' && k === 'deleted_at' && v === null))
      await assert.rejects(() => DB.fetchMedMonth('2026-13'))
    })

    it('fetchMedFirstDay: 生きている記録の最初の日を1行だけ昇順で引く（無ければ null）', async () => {
      const srv = medServer()
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.fetchMedFirstDay(), null)
      srv.db.admin.push(
        { id: 1, ...medInput({ admin_on: '2026-08-20' }), rev: 1, deleted_at: null },
        { id: 2, ...medInput({ admin_on: '2026-08-03', resident_id: 2 }), rev: 1, deleted_at: null },
        { id: 3, ...medInput({ admin_on: '2026-07-01', resident_id: 2 }), rev: 1, deleted_at: '2026-07-02T00:00:00Z' },
      )
      assert.equal(await DB.fetchMedFirstDay(), '2026-08-03')
      const q = srv.calls.filter((c) => c.table === 'med_admin').at(-1)
      assert.equal(q.limit, 1)
      assert.deepEqual(q.orders, [['admin_on', true]])
    })

    it('fetchKarte は本人・期間の与薬を返し、表が無い（0013 未適用）時は与薬だけ空・取得は「サーバー側の設定待ち」', async () => {
      const srv = medServer()
      srv.db.admin.push({ id: 9, ...medInput({ admin_on: '2026-09-05', status: 'absent' }), rev: 1, deleted_at: null })
      DB.__testHooks.setClient(srv.client)
      const k = await DB.fetchKarte(1, '2026-09-01', '2026-09-30')
      assert.deepEqual(k.meds.map((m) => [m.id, m.status]), [[9, 'absent']])
      assert.equal(srv.calls.filter((q) => q.table === 'med_admin').at(-1).limit, 2000, 'カルテの与薬の上限は食事と同じ MAX_ROWS')
      const missing = medServer({ missingTable: true })
      DB.__testHooks.setClient(missing.client)
      const k2 = await DB.fetchKarte(1, '2026-09-01', '2026-09-30')
      assert.deepEqual(k2.meds, [])
      await assert.rejects(() => DB.fetchMedDay('2026-09-01'), /サーバー側の設定待ち/)
    })

    it('受信値を信じない: 知らない状態・時間帯の行は落とし、時間帯の記録の頓服の項目は null にする', async () => {
      const srv = medServer()
      srv.db.admin.push(
        { id: 1, ...medInput(), status: 'bogus', rev: 1, deleted_at: null },
        { id: 2, ...medInput({ slot: 'lunch' }), rev: 1, deleted_at: null },
        { id: 3, ...medInput({ slot: 'noon', prn_drug: 'x' }), rev: 1, deleted_at: null },
      )
      DB.__testHooks.setClient(srv.client)
      const rows = await DB.fetchMedDay('2026-09-01')
      assert.deepEqual(rows.map((r) => [r.id, r.prn_drug]), [[3, null]])
    })
  })
}

// ══════════════════════════════════════════════════════════════
// 3. 配線（静的検査）
// ══════════════════════════════════════════════════════════════

describe('与薬チェックの配線（静的検査）', () => {
  /** 注記（-- の後ろ）を除いた、実際に流れる SQL */
  const sql = () =>
    read('../supabase/migrations/0013_med_admin.sql')
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n')

  it('0013: 2表に restrictive の member_only・delete ポリシーなし・do $$ なし・Realtime は add table（set table ではない）', () => {
    const s = sql()
    for (const t of ['med_slots', 'med_admin']) {
      assert.match(
        s,
        new RegExp(
          `create policy member_only on public\\.${t} as restrictive for all to authenticated\\s+using \\(private\\.is_member\\(\\)\\) with check \\(private\\.is_member\\(\\)\\);`,
        ),
        t,
      )
      assert.match(s, new RegExp(`alter publication supabase_realtime add table public\\.${t};`), t)
    }
    assert.equal(/for delete/i.test(s), false)
    assert.equal(/do\s+\$\$/i.test(s), false)
    assert.equal(/alter publication supabase_realtime\s+set table/i.test(s), false)
    assert.match(s, /notify pgrst, 'reload schema';/)
  })

  it('0013: 部分 unique（1人1件・1人1日1時間帯1件で頓服は除く）・check 制約・変更の記録のトリガ', () => {
    const s = sql()
    assert.match(s, /create unique index if not exists uq_med_slots_resident\s+on public\.med_slots \(resident_id\)\s+where deleted_at is null;/)
    assert.match(
      s,
      /create unique index if not exists uq_med_admin_slot\s+on public\.med_admin \(resident_id, admin_on, slot\)\s+where deleted_at is null and slot <> 'prn';/,
    )
    assert.match(s, /check \(slot in \('morning', 'noon', 'evening', 'bedtime', 'prn'\)\)/)
    assert.match(s, /check \(status in \('taken', 'partial', 'refused', 'absent', 'stopped', 'dropped', 'wrong'\)\)/)
    assert.match(s, /slots <@ array\['morning', 'noon', 'evening', 'bedtime'\]::text\[\]/)
    assert.match(s, /record_history_capture\('admin_on'\)/)
    assert.match(s, /record_history_capture\('updated_at'\)/)
    assert.match(read('../supabase/migrations/0013_med_admin.sql'), /初回に1回だけ流す/)
  })

  it('App.tsx に /record/med・/med/slots・/med/month のルートと画面名・現在地の既知値がある', () => {
    const app = read('../src/App.tsx')
    for (const p of ['/record/med', '/med/slots', '/med/month']) assert.match(app, new RegExp(`path="${p.replace(/\//g, '\\/')}"`), p)
    for (const t of ["'与薬チェック'", "'服薬の時間帯'", "'与薬 月次表'", "'medSlots'", "'medMonth'"]) assert.ok(app.includes(t), t)
  })

  it('記録ハブは与薬だけ input_enabled_med で封鎖を判定し、その他に「服薬の時間帯」「与薬 月次表」がある', () => {
    const hub = read('../src/pages/RecordHubPage.tsx')
    assert.match(hub, /getKindInputGate\('med'\)/)
    assert.match(hub, /key === 'med' \? medLocked/)
    assert.match(hub, /to: '\/record\/med'/)
    const more = read('../src/pages/MorePage.tsx')
    assert.match(more, /to: '\/med\/slots'/)
    assert.match(more, /to: '\/med\/month'/)
  })

  it('服薬の時間帯の画面は封鎖の旗を読まない・封鎖の表示を持たない（チーフ裁定）', () => {
    const src = read('../src/pages/MedSlotsPage.tsx').replace(/\/\/.*$/gm, '')
    assert.equal(/getKindInputGate|kindBlockedMessage/.test(src), false)
    assert.match(read('../src/lib/db.ts'), /if \(table === 'med_admin'\) return assertKindWritable\('med'\)/)
  })

  it('月次表は月・入居者を保存しない。与薬チェックが保存する UI 状態は階（cl_medFloor）だけ', () => {
    const strip = (src) => src.replace(/\/\/.*$/gm, '')
    assert.equal(/localStorage/.test(strip(read('../src/pages/MedMonthPage.tsx'))), false)
    assert.equal(/localStorage/.test(strip(read('../src/pages/MedSlotsPage.tsx'))), false)
    const rec = strip(read('../src/pages/MedRecordPage.tsx'))
    const keys = [...rec.matchAll(/localStorage\.(?:get|set)Item\(([^,)]+)/g)].map((m) => m[1].trim())
    assert.deepEqual([...new Set(keys)], ['LS.medFloor'])
    assert.match(read('../src/lib/types.ts'), /medFloor: 'cl_medFloor'/)
  })

  it('与薬の画面・ロジックは console に何も出さない', () => {
    for (const p of ['../src/pages/MedRecordPage.tsx', '../src/pages/MedSlotsPage.tsx', '../src/pages/MedMonthPage.tsx', '../src/lib/med.ts']) {
      assert.equal(/console\./.test(read(p)), false, p)
    }
  })
})
