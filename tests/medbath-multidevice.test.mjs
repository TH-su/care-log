// 与薬・入浴の画面の多端末運用の回帰テスト（2026-10-10 多端末運用の監査 与薬・入浴担当:
// F14・F18・F20・F32・F33・F37・F47・F54・F55）。直す前の版では赤、直した後で緑になる形。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 画面（src/pages/*.tsx）が export する判定の純関数を、esbuild（vite が持つ）で tsx を変換する読み込みフックを入れてから
// 読んで確かめる。React の描画が要る配線（effect の依存・小窓の初期化など）は静的検査で固定する。
// db.ts は画面と同じ URL で読み込む（同じ送信待ちを見る）。偽の Supabase で動かし、通信しない。
// 個人情報は置かない（利用者・職員は数値IDと記号だけ。実在の薬の名前を書かない）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const SKIP =
  'この Node では解決・読み込みフック（module.registerHooks）か esbuild が使えないため、与薬・入浴の画面の検証をスキップしました（Node 22.15 以降で npm install 済みの環境で実行してください）。'

const lsStore = new Map()
let PAGES = null
let DB = null
let loadError = null
try {
  const { registerHooks } = await import('node:module')
  if (typeof registerHooks !== 'function') throw new Error('no registerHooks')
  const esbuild = createRequire(new URL('../package.json', import.meta.url))('esbuild')
  registerHooks({
    resolve(specifier, context, next) {
      if (/^\.{1,2}\//.test(specifier) && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
        for (const ext of ['.ts', '.tsx']) {
          try {
            return next(`${specifier}${ext}`, context)
          } catch {
            // 次の拡張子を試す
          }
        }
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      // 画面の tsx は esbuild で変換する（JSX を含むので型を外すだけでは読めない）。CSS は空にする（印刷の見た目は試験しない）
      if (url.endsWith('.tsx')) {
        const src = readFileSync(fileURLToPath(url), 'utf8')
        const out = esbuild.transformSync(src, { loader: 'tsx', format: 'esm', jsx: 'automatic', sourcefile: url })
        return { format: 'module', source: out.code, shortCircuit: true }
      }
      if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }
      return next(url, context)
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
  PAGES = {
    med: await import('../src/pages/MedRecordPage.tsx'),
    bath: await import('../src/pages/BathRecordPage.tsx'),
    slots: await import('../src/pages/MedSlotsPage.tsx'),
  }
} catch (e) {
  loadError = e
  PAGES = null
}

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
/** 行末の // 注記を外したソース（注記の文言に当たらないように） */
const code = (p) => read(p).replace(/\/\/.*$/gm, '')

// ── 偽の Supabase（与薬・入浴・時間帯の表と app_settings だけ） ─────────────────────

function fakeServer(opts = {}) {
  const db = {
    med_admin: [],
    med_slots: [],
    bath_records: [],
    nextId: 100,
    settings: { native_input_enabled: 'true', input_enabled_bath: 'true', input_enabled_med: 'true' },
  }
  const match = (q, r) =>
    q.filters.every(([op, k, v]) => {
      if (op === 'eq' || op === 'is') return r[k] === v
      if (op === 'in') return v.includes(r[k])
      if (op === 'gte') return r[k] >= v
      if (op === 'lte') return r[k] <= v
      return true
    })
  const natural = (table, p) =>
    table === 'med_slots'
      ? db.med_slots.some((r) => r.deleted_at === null && r.resident_id === p.resident_id)
      : table === 'bath_records'
        ? db.bath_records.some((r) => r.deleted_at === null && r.resident_id === p.resident_id && r.bath_on === p.bath_on)
        : p.slot !== 'prn' &&
          db.med_admin.some((r) => r.deleted_at === null && r.resident_id === p.resident_id && r.admin_on === p.admin_on && r.slot === p.slot)
  const handle = (q) => {
    if (opts.offline?.()) return { data: null, error: { message: 'offline' }, status: 0 }
    if (q.table === 'app_settings') {
      const key = q.filters.find(([op, k]) => op === 'eq' && k === 'key')?.[2]
      return { data: key in db.settings ? { value: db.settings[key] } : null, error: null, status: 200 }
    }
    const rows = db[q.table]
    if (!Array.isArray(rows)) return q.action === 'select' ? { data: [], error: null, status: 200 } : { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
    if (q.action === 'insert') {
      const p = q.payload
      if ((p.client_key && rows.some((r) => r.client_key === p.client_key)) || natural(q.table, p)) {
        return { data: null, error: { code: '23505', message: 'duplicate key' }, status: 409 }
      }
      const row = { id: db.nextId++, rev: 1, deleted_at: null, edited_by: null, created_at: '2026-10-10T00:00:00Z', ...p }
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
    if (q.limit === 1) return { data: hits[0] ? { ...hits[0] } : null, error: null, status: 200 }
    return { data: hits.map((x) => ({ ...x })), error: null, status: 200 }
  }
  const builder = (q) => {
    const run = () => Promise.resolve(handle(q))
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
      or() {
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
      single: run,
      then: (ok, ng) => run().then(ok, ng),
    }
    return b
  }
  const channel = () => {
    const ch = { on: () => ch, subscribe: () => ch }
    return ch
  }
  const client = {
    from: (table) => builder({ table, action: 'select', payload: undefined, filters: [] }),
    rpc: () => builder({ table: null, action: 'rpc', payload: undefined, filters: [] }),
    channel,
    removeChannel: () => Promise.resolve(),
    auth: {
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } }
      },
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1' } } }, error: null }),
    },
  }
  return { client, db }
}

async function drain() {
  await new Promise((r) => setTimeout(r, 10))
  lsStore.clear()
  await DB.__testHooks.restartQueue()
  DB.__testHooks.setClient(null)
}

if (PAGES === null || DB === null) {
  it('与薬・入浴の画面の多端末運用の検証', { skip: `${SKIP}（${loadError}）` }, () => {})
} else {
  const M = PAGES.med
  const B = PAGES.bath
  const S = PAGES.slots

  // ════════════════════════════════════════════════════════════
  // F18 開いたまま日付が変わった画面が前日のまま
  // ════════════════════════════════════════════════════════════
  describe('★F18 開いたまま日付が変わったら、今日を見ていて入力中・未送信が無ければ今日へ切り替える（与薬・入浴）', () => {
    for (const [name, mod] of [['与薬チェック', M], ['入浴', B]]) {
      it(`${name}: 切り替え・帯・何もしない、の判定`, () => {
        assert.equal(typeof mod.dayRolloverAction, 'function', '日付が変わった時の判定が無い')
        const f = mod.dayRolloverAction
        assert.equal(f({ day: '2026-08-27', prevToday: '2026-08-27', today: '2026-08-27', holding: false }), 'none', '日付が変わっていない')
        assert.equal(f({ day: '2026-08-27', prevToday: '2026-08-27', today: '2026-08-28', holding: false }), 'switch', '今日を見ていて入力中でない')
        assert.equal(f({ day: '2026-08-27', prevToday: '2026-08-27', today: '2026-08-28', holding: true }), 'notice', '入力中・未送信がある時は帯だけ')
        assert.equal(f({ day: '2026-08-20', prevToday: '2026-08-27', today: '2026-08-28', holding: false }), 'none', '手で過去の日を選んでいる時は追従しない')
        assert.equal(f({ day: '2026-08-26', prevToday: '2026-08-26', today: '2026-08-28', holding: false }), 'switch', '何日も隠れていた後でも今日へ')
      })
    }

    it('配線: 画面に戻った時にも時計を取り直し、今日が変わった時だけ判定する。入力中・未送信・止まった記録を holding に数える', () => {
      const med = code('../src/pages/MedRecordPage.tsx')
      assert.match(med, /document\.addEventListener\('visibilitychange', onVisible\)/, '与薬: 画面に戻った時に時計を取り直さない')
      assert.match(med, /const act = dayRolloverAction\(\{ day, prevToday: prev, today, holding \}\)/)
      assert.match(med, /\}, \[today\]\)/)
      for (const k of ['prnOpen', 'statusFor !== null', 'newFor !== null', 'busy.size > 0', 'pendingMarks.size > 0', 'pendingPrnOps(day).length > 0', 'stoppedHere.length > 0']) {
        assert.ok(med.includes(k), `与薬の holding に ${k} が無い`)
      }
      assert.match(med, /今日を開く/)
      const bath = code('../src/pages/BathRecordPage.tsx')
      assert.match(bath, /window\.setInterval\(tick, 60_000\)/, '入浴: 時計を取り直さない（日付が変わっても前日のまま）')
      assert.match(bath, /document\.addEventListener\('visibilitychange', onVisible\)/)
      assert.match(bath, /const act = dayRolloverAction\(\{ day, prevToday: prev, today, holding \}\)/)
      for (const k of ['extras.length > 0', 'busy.size > 0', 'pending.size > 0', 'stoppedByResident.size > 0', 'rows.some((row) => rowPending(row))']) {
        assert.ok(bath.includes(k), `入浴の holding に ${k} が無い`)
      }
      assert.match(bath, /今日を開く/)
    })
  })

  // ════════════════════════════════════════════════════════════
  // F20 読み直しに世代の照合が無い
  // ════════════════════════════════════════════════════════════
  describe('★F20 与薬・入浴の読み直しは、最新の世代 かつ 今の日付の応答だけを表へ入れる', () => {
    for (const [name, mod] of [['与薬チェック', M], ['入浴', B]]) {
      it(`${name}: 日付を変えた後に返った前の日の読み直し・古い世代の応答は捨てる`, () => {
        assert.equal(typeof mod.acceptDayLoad, 'function', '応答を入れてよいかの判定が無い')
        // 10/12 の読み直し（世代1）→ 10/11 へ移る（世代2）→ 10/11 の取得が先に返る → 10/12 の応答が後から返る
        let latest = 0
        const reload = { gen: ++latest, day: '2026-10-12' }
        const dayLoad = { gen: ++latest, day: '2026-10-11' }
        const shown = '2026-10-11'
        assert.equal(mod.acceptDayLoad({ ...dayLoad, latestGen: latest, shownDay: shown, alive: true }), true)
        assert.equal(mod.acceptDayLoad({ ...reload, latestGen: latest, shownDay: shown, alive: true }), false, '前の日の応答で上書きした')
        // 同じ日に読み直しが2回重なり、古い方が後から返る
        const r1 = { gen: ++latest, day: shown }
        const r2 = { gen: ++latest, day: shown }
        assert.equal(mod.acceptDayLoad({ ...r2, latestGen: latest, shownDay: shown, alive: true }), true)
        assert.equal(mod.acceptDayLoad({ ...r1, latestGen: latest, shownDay: shown, alive: true }), false, '古い読み直しで新しい記録を消した')
        assert.equal(mod.acceptDayLoad({ ...r2, latestGen: latest, shownDay: shown, alive: false }), false, '閉じた画面へ入れた')
      })
    }

    it('配線: 日付の読み込みと読み直しの両方で世代を進め、表示・書き込みの入口でも日付を確かめる', () => {
      const med = code('../src/pages/MedRecordPage.tsx')
      assert.equal((med.match(/const gen = \+\+genRef\.current/g) ?? []).length, 2, '与薬: 世代を進める所が日付の読み込みと読み直しの2か所でない')
      assert.equal((med.match(/acceptDayLoad\(\{ gen, latestGen: genRef\.current/g) ?? []).length, 2)
      assert.match(med, /\.filter\(\(r\) => r\.slot === 'prn' && r\.admin_on === day\)/, '与薬: 頓服の一覧を表示中の日で絞っていない')
      assert.equal((med.match(/if \(rejectOtherDay\(rec\)\) return/g) ?? []).length, 3, '与薬: 状態・取り消し・効果の入口で日付を確かめていない')
      assert.match(med, /supersedeInFlight\(\)/, '与薬: 保存の後に、保存前の読み直しを捨てていない')
      // 日付を変える前の描画から呼ばれた読み直しは世代を進めない（新しい日の読み込みを捨てて「読み込み中」に固まらない）
      assert.match(med, /const d = day\s+(\/\/.*\s+)*if \(d !== dayRef\.current\) return Promise\.resolve\(false\)\s+const gen = \+\+genRef\.current/)
      const bath = code('../src/pages/BathRecordPage.tsx')
      assert.equal((bath.match(/const gen = \+\+genRef\.current/g) ?? []).length, 2, '入浴: 世代を進める所が2か所でない')
      assert.equal((bath.match(/acceptDayLoad\(\{ gen, latestGen: genRef\.current/g) ?? []).length, 2)
      assert.match(bath, /\(records \?\? \[\]\)\.filter\(\(r\) => r\.bath_on === day\)/, '入浴: 表を表示中の日の記録で絞っていない')
      assert.match(bath, /if \(row\.record !== null && rejectOtherDay\(row\.record\)\) return/, '入浴: 保存の入口で日付を確かめていない')
      assert.match(bath, /if \(rejectOtherDay\(rec\)\) return/, '入浴: 取り消しの入口で日付を確かめていない')
      assert.match(bath, /supersedeInFlight\(\)/)
      assert.match(bath, /const d = day\s+(\/\/.*\s+)*if \(d !== dayRef\.current\) return\s+const gen = \+\+genRef\.current/)
    })
  })

  // ════════════════════════════════════════════════════════════
  // F32 頓服の小窓を開いたまま0時を越えると入力が消える
  // ════════════════════════════════════════════════════════════
  describe('★F32 頓服の小窓は開いた時だけ初期化する（開いたまま0時を越えても入力を消さない）', () => {
    it('初期化の effect は open だけに依存し、開いた瞬間（false→true）だけ初期化する', () => {
      const med = code('../src/pages/MedRecordPage.tsx')
      const dlg = med.slice(med.indexOf('function PrnDialog('), med.indexOf('function PrnSameDayList('))
      assert.ok(dlg.length > 0, '頓服の小窓が見つからない')
      assert.equal(/\}, \[open, isToday\]\)/.test(dlg), false, 'isToday が変わるだけで入力を消す')
      assert.match(dlg, /const opening = open && !wasOpenRef\.current/)
      assert.match(dlg, /wasOpenRef\.current = open\s+if \(!opening\) return\s+setResidentId\(null\)/)
      assert.match(dlg, /\}, \[open\]\)/)
      // 開いたまま0時を越えたことは小窓の中で知らせる（入力は消さない）
      assert.match(dlg, /const crossedMidnight = openedToday && !isToday/)
      assert.match(dlg, /入力はそのまま残っています/)
    })
  })

  // ════════════════════════════════════════════════════════════
  // F33 開いたまま0時を越えた画面の頓服が24時間前の日時になる
  // ════════════════════════════════════════════════════════════
  describe('★F33 表示中の日が今日でなく、使用時刻が12時間以上前になる頓服は確かめる（今日の記録にもできる）', () => {
    it('8/27 を開いたまま 8/28 2:00 に「2:00」と入れた → 24時間前になるので確かめる。前日 23:30 の正当な記録は止めない', () => {
      assert.equal(typeof M.prnCheck, 'function', '頓服の記録前の確かめが無い')
      const now = Date.parse('2026-08-27T17:00:00.000Z') // 日本時間 8/28 2:00
      const stale = M.prnCheck({ adminOn: '2026-08-27', today: '2026-08-28', givenAt: '2026-08-26T17:00:00.000Z', nowMs: now, drug: '合成薬A', sameDay: [] })
      assert.equal(stale.staleDay, true)
      assert.equal(stale.hoursBefore, 24)
      const lateEntry = M.prnCheck({ adminOn: '2026-08-27', today: '2026-08-28', givenAt: '2026-08-27T14:30:00.000Z', nowMs: now, drug: '合成薬A', sameDay: [] })
      assert.equal(lateEntry.staleDay, false, '前日 23:30 の記録まで確かめを出した（夜勤の正当な記録を止める）')
      const todayEntry = M.prnCheck({ adminOn: '2026-08-28', today: '2026-08-28', givenAt: '2026-08-27T17:00:00.000Z', nowMs: now, drug: '合成薬A', sameDay: [] })
      assert.equal(todayEntry.staleDay, false)
      assert.equal(M.prnCheck({ adminOn: '2026-08-27', today: '2026-08-28', givenAt: null, nowMs: now, drug: '', sameDay: null }).staleDay, false, '時刻が無い時は検証に任せる')
      assert.equal(M.PRN_STALE_HOURS, 12)
    })

    it('配線: 頓服は小窓が決めた日（adminOn）で送る・確かめの中に「今日の記録にする」がある・検証の関数は厳しくしない', () => {
      const med = code('../src/pages/MedRecordPage.tsx')
      assert.match(med, /const givenAt = localDateTimeIso\(p\.adminOn, p\.hm\)/)
      assert.match(med, /admin_on: p\.adminOn,/)
      assert.match(med, /onClick=\{\(\) => void submit\(today, false\)\}/)
      assert.match(med, /の記録にする/)
      assert.match(med, /onClick=\{\(\) => void submit\(confirm\.adminOn, true\)\}/)
      // 前日の頓服の記入漏れを翌日に書く操作は正当（validateMedAdminInput に「12時間以上前は不可」を足さない）
      assert.equal(/PRN_STALE_HOURS|staleDay/.test(read('../src/lib/med.ts')), false)
    })
  })

  // ════════════════════════════════════════════════════════════
  // F55 頓服の重複に気づけない
  // ════════════════════════════════════════════════════════════
  describe('★F55 頓服の小窓に同じ方のその日の頓服を出し、同じ薬が既にあれば確かめる（保存は止めない）', () => {
    const rec = (id, rid, day, over = {}) => ({
      id,
      resident_id: rid,
      admin_on: day,
      slot: 'prn',
      status: 'taken',
      given_at: '2026-10-10T05:00:00.000Z',
      prn_drug: '合成薬A',
      prn_reason: '合成理由',
      prn_effect: null,
      note: null,
      recorded_by: 11,
      rev: 1,
      created_at: '2026-10-10T05:00:00Z',
      ...over,
    })
    it('その方・その日の頓服だけを、サーバーの記録とこの端末の未送信をまとめて時刻順に並べる', () => {
      assert.equal(typeof M.prnSameDayItems, 'function', '同じ方のその日の頓服を組み立てる部品が無い')
      const items = M.prnSameDayItems(
        [
          rec(1, 4, '2026-10-10', { given_at: '2026-10-10T06:00:00.000Z' }),
          rec(2, 4, '2026-10-10', { given_at: '2026-10-10T01:00:00.000Z', recorded_by: 12 }),
          rec(3, 5, '2026-10-10'), // 別の方
          rec(4, 4, '2026-10-09'), // 別の日
          rec(5, 4, '2026-10-10', { slot: 'morning', given_at: null }), // 時間帯の記録
        ],
        [{ qid: 'q1', residentId: 4, givenAt: '2026-10-10T03:00:00.000Z', drug: '合成薬B', reason: null, note: null, state: 'waiting' }],
        4,
        '2026-10-10',
        (id) => (id === 11 ? '職員01' : id === 12 ? '職員02' : null),
      )
      assert.deepEqual(
        items.map((x) => [x.key, x.recorder, x.unsent]),
        [
          ['r2', '職員02', false],
          ['q1', null, true],
          ['r1', '職員01', false],
        ],
      )
    })
    it('同じ薬（全角・半角・空白・大文字小文字の違いは同じとみなす）が既にあれば確かめる。違う薬・読めなかった時は確かめない', () => {
      const now = Date.parse('2026-10-10T06:00:00.000Z')
      const same = [{ key: 'r1', givenAt: '2026-10-10T05:00:00.000Z', drug: '合成薬Ａ 200', recorder: '職員01', unsent: false }]
      const hit = M.prnCheck({ adminOn: '2026-10-10', today: '2026-10-10', givenAt: '2026-10-10T05:05:00.000Z', nowMs: now, drug: '合成薬a200', sameDay: same })
      assert.equal(hit.sameDrug.length, 1, '同じ薬の頓服を見落とした（二重の与薬に気づけない）')
      assert.equal(hit.staleDay, false)
      assert.equal(M.prnCheck({ adminOn: '2026-10-10', today: '2026-10-10', givenAt: null, nowMs: now, drug: '合成薬B', sameDay: same }).sameDrug.length, 0)
      assert.equal(M.prnCheck({ adminOn: '2026-10-10', today: '2026-10-10', givenAt: null, nowMs: now, drug: '合成薬A200', sameDay: null }).sameDrug.length, 0, '読めなかった時に止めた')
      assert.equal(M.prnDrugKey('　合成薬Ａ　２００ '), M.prnDrugKey('合成薬a200'))
    })
    it('配線: 入居者を選んだ時と記録する時にサーバーから取り直す・この端末の未送信も含める・自分の記録の後も読み直す', () => {
      const med = code('../src/pages/MedRecordPage.tsx')
      assert.match(med, /void loadSameDay\(residentId, day\)\.then/, '入居者を選んだ時に取り直さない')
      assert.match(med, /const items = await loadSameDay\(residentId, adminOn\)/, '記録する時に取り直さない')
      assert.match(med, /return prnSameDayItems\(rows, pendingPrnOps\(d\), residentId, d,/)
      assert.match(med, /if \(res\.admin_on === dayRef\.current\) void reloadDay\(\)/)
      assert.match(med, /<PrnSameDayList day=\{day\}/)
      // 小窓を開いている間に他の端末の頓服の通知で画面を読み直したら、小窓の一覧も取り直す
      assert.match(med, /refreshKey=\{records\}/)
      assert.match(med, /\}, \[open, residentId, day, loadSameDay, refreshKey\]\)/)
    })
  })

  // ════════════════════════════════════════════════════════════
  // F37 止まった op が画面に出ない
  // ════════════════════════════════════════════════════════════
  describe('★F37 送れずに止まった与薬・入浴・時間帯の記録を、その日の画面に中身つきで出す', () => {
    afterEach(drain)

    it('与薬: 圏外で「拒否」→ 他の端末が「服用済み」→ 送ると止まる。表示中の日の止まった記録として「拒否」と理由を出す', async () => {
      let off = true
      const srv = fakeServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      const input = { resident_id: 1, admin_on: '2026-10-10', slot: 'morning', status: 'refused', given_at: null, prn_drug: null, prn_reason: null, prn_effect: null, note: '本人拒否（合成）', recorded_by: 11 }
      assert.equal(await DB.insertMedAdmin(input), 'queued')
      srv.db.med_admin.push({ id: 60, ...input, status: 'taken', note: null, recorded_by: 12, rev: 1, deleted_at: null, client_key: 'other-device' })
      off = false
      await DB.flushQueue(true)
      const ops = DB.listStoppedOps()
      assert.equal(ops.length, 1, '止まった op が一覧に無い')
      const here = M.stoppedMedFor(ops, '2026-10-10', srv.db.med_admin)
      assert.equal(here.length, 1, '表示中の日の止まった記録として当たらない')
      assert.deepEqual(M.stoppedMedFor(ops, '2026-10-09', []), [], '別の日に出した')
      const text = M.stoppedMedText(here[0], null, '利用者01')
      assert.match(text, /^利用者01　朝「拒否[^」]*」（備考: 本人拒否（合成））の記録/)
      assert.match(text, /他の端末が先にこのマスを記録しました/)
    })

    it('与薬: 記録の取り消しが止まった（他の端末が先に直した）→ その記録の取り消しとして出す。頓服の追加は頓服の区画に任せる', async () => {
      const rec = { id: 61, resident_id: 2, admin_on: '2026-10-10', slot: 'noon', status: 'taken', given_at: null, prn_drug: null, prn_reason: null, prn_effect: null, note: null, recorded_by: 11, rev: 1, created_at: null }
      const del = { qid: 'q1', table: 'med_admin', kind: 'update', state: 'conflict', rowId: 61, rev: 1, payload: { deleted_at: '2026-10-10T03:00:00Z', edited_by: 11 }, errCode: null, at: 0 }
      const prn = { qid: 'q2', table: 'med_admin', kind: 'insert', state: 'rejected', rowId: null, rev: null, payload: { resident_id: 2, admin_on: '2026-10-10', slot: 'prn' }, errCode: '42501', at: 0 }
      assert.deepEqual(M.stoppedMedFor([del, prn], '2026-10-10', [rec]).map((o) => o.qid), ['q1'])
      assert.match(M.stoppedMedText(del, rec, '利用者02'), /利用者02　昼の記録の取り消し — 他の端末が先にこの記録を変更しました/)
      assert.match(M.stoppedMedText({ ...prn, payload: { resident_id: 2, admin_on: '2026-10-10', slot: 'morning', status: 'taken' } }, null, ''), /サーバーに受け付けられませんでした/)
    })

    it('入浴: 圏外の取り消し → 他の端末が備考を直す → 送ると止まる。その方の行に「記録の取り消し」として出す', async () => {
      let off = false
      const srv = fakeServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      const saved = await DB.insertBath({ resident_id: 3, bath_on: '2026-10-10', result: 'full', cancel_reason: null, note: null, recorded_by: 11 })
      assert.equal(typeof saved, 'object')
      off = true
      assert.equal(await DB.softDeleteBath(saved.id, saved.rev, { editedBy: 11 }), 'queued')
      const row = srv.db.bath_records.find((r) => r.id === saved.id)
      row.note = '他の端末の備考（合成）'
      row.rev += 1
      off = false
      await DB.flushQueue(true)
      const ops = DB.listStoppedOps()
      assert.equal(ops.length, 1, '止まった取り消しが一覧に無い')
      const by = B.stoppedBathByResident(ops, '2026-10-10', srv.db.bath_records)
      assert.deepEqual([...by.keys()], [3], 'その方の行に当たらない')
      assert.match(B.stoppedBathText(by.get(3)[0]), /送れずに止まっている記録の取り消しがあります（他の端末が先にこの記録を変更しました）/)
      assert.equal(B.stoppedBathByResident(ops, '2026-10-09', srv.db.bath_records).size, 0, '別の日の行に出した')
      assert.match(B.stoppedBathText({ qid: 'x', table: 'bath_records', kind: 'insert', state: 'conflict', rowId: null, rev: null, payload: { resident_id: 3, bath_on: '2026-10-10', result: 'cancel' }, errCode: null, at: 0 }), /「入浴していない」の記録があります（他の端末が先にこの方の記録を保存しました）/)
    })

    it('服薬の時間帯: その方の止まった追加・修正を当てる', () => {
      const ops = [
        { qid: 'a', table: 'med_slots', kind: 'insert', state: 'conflict', rowId: null, rev: null, payload: { resident_id: 7 }, errCode: null, at: 0 },
        { qid: 'b', table: 'med_slots', kind: 'update', state: 'conflict', rowId: 70, rev: 1, payload: {}, errCode: null, at: 0 },
        { qid: 'c', table: 'med_admin', kind: 'insert', state: 'conflict', rowId: null, rev: null, payload: { resident_id: 7 }, errCode: null, at: 0 },
      ]
      assert.deepEqual(S.stoppedSlotsOpsFor(ops, 7, 70).map((o) => o.qid), ['a', 'b'])
      assert.deepEqual(S.stoppedSlotsOpsFor(ops, 8, null).map((o) => o.qid), [])
    })

    it('配線: 送信待ちの通知のたびに引き直す・設定タブへ案内する・頓服の「管理者に連絡」を新しい導線にする', () => {
      const med = code('../src/pages/MedRecordPage.tsx')
      assert.match(med, /listStoppedOps\(\)\.filter\(\(op\) => op\.table === 'med_admin'\), \[queueTick, records\]/)
      assert.match(med, /送れずに止まっている記録があります/)
      assert.match(med, /<Link to="\/settings"/)
      assert.equal(/管理者に連絡してください（同じ頓服を記録し直さないでください）/.test(med), false)
      const bath = code('../src/pages/BathRecordPage.tsx')
      assert.match(bath, /listStoppedOps\(\)\.filter\(\(op\) => op\.table === 'bath_records'\), \[queueTick, records\]/)
      assert.match(bath, /stopped=\{stoppedByResident\.get\(row\.residentId\) \?\? \[\]\}/)
      const slots = code('../src/pages/MedSlotsPage.tsx')
      assert.match(slots, /const stoppedOps = useMemo\(\(\) => listStoppedOps\(\), \[queueTick\]\)/)
      assert.match(slots, /MSG_ROW_STOPPED/)
      // 送信待ちが止まっていても、行・マスのロック（hasPending*）の意味は変えない（blocked は数えない）
      assert.match(read('../src/lib/db.ts'), /if \(q\.table !== 'med_admin' \|\| q\.blocked !== undefined\) continue/)
    })
  })

  // ════════════════════════════════════════════════════════════
  // F47 App の職員名簿の配り直しで画面が「準備中」に戻る
  // ════════════════════════════════════════════════════════════
  describe('★F47 App が配り直した職員名簿は名簿だけを差し替える（入力解禁・利用者・設定を取り直して画面を作り直さない）', () => {
    it('与薬・入浴・服薬の時間帯: 取得の effect の依存に staffProp が無く、名簿は別の effect で差し替える', () => {
      for (const [p, dep] of [
        ['../src/pages/MedRecordPage.tsx', '[baseTick]'],
        ['../src/pages/BathRecordPage.tsx', '[baseTick]'],
        ['../src/pages/MedSlotsPage.tsx', '[tick]'],
      ]) {
        const src = code(p)
        assert.equal(/\}, \[(baseTick|tick), staffProp\]\)/.test(src), false, `${p}: 名簿が変わるたびに取得をやり直す（gate が null に戻り画面が準備中になる）`)
        assert.match(src, /useEffect\(\(\) => \{\s+if \(staffProp !== undefined\) setStaff\(staffProp\)\s+\}, \[staffProp\]\)/, `${p}: 配り直した名簿を受け取らない`)
        assert.ok(src.includes(`  }, ${dep})`), `${p}: 取得の effect の依存が ${dep} でない`)
        assert.match(src, /setStaff\(staffPropRef\.current \?\? st\)/)
      }
    })
    it('与薬: 頓服の記入者の名前は退職者も含む名簿でも引く（名簿を取り直した後に「—」にしない）', () => {
      const med = code('../src/pages/MedRecordPage.tsx')
      assert.match(med, /fetchAllStaff\(\)/)
      assert.match(med, /\?\? \(allStaff \?\? \[\]\)\.find\(\(s\) => s\.id === id\)\?\.name \?\? null/)
    })
  })

  // ════════════════════════════════════════════════════════════
  // F54 服薬の時間帯の下書きで他の端末の変更を黙って消す
  // ════════════════════════════════════════════════════════════
  describe('★F54 服薬の時間帯: 下書きは編集を始めた時の版で送り、読み直したら最新の上に当て直す', () => {
    afterEach(drain)
    const setting = (rev, slots, note = null) => ({ id: 70, resident_id: 7, slots, note, rev })

    it('A が昼を足している間に B が眠前を足した（経路 a・b）: 読み直すと［朝・昼・夕・眠前］に当て直し、基準を最新の版へ置き直す', () => {
      assert.equal(typeof S.rebaseSlotDrafts, 'function', '下書きを当て直す部品が無い')
      const d = S.draftFromSetting(setting(1, ['morning', 'evening']), { slots: ['morning', 'noon', 'evening'], note: '' })
      assert.equal(d.baseRev, 1)
      const out = S.rebaseSlotDrafts(new Map([[7, d]]), [setting(2, ['morning', 'evening', 'bedtime'])])
      assert.ok(out !== null)
      const nd = out.get(7)
      assert.deepEqual(nd.slots, ['morning', 'noon', 'evening', 'bedtime'], '他の端末が足した眠前を消した')
      assert.equal(nd.baseRev, 2)
      assert.deepEqual(nd.merged.theirsAdded, ['bedtime'])
      assert.equal(S.mergeSummary(nd.merged), '眠前を追加')
      assert.deepEqual(S.baseSettingOf(7, nd), setting(2, ['morning', 'evening', 'bedtime']))
    })

    it('版が変わっていない下書きは触らない（null）。自分の送信待ちが届いた（当て直すと最新と同じ）時は下書きを消す', () => {
      const d = S.draftFromSetting(setting(1, ['morning']), { slots: ['morning', 'noon'], note: '' })
      assert.equal(S.rebaseSlotDrafts(new Map([[7, d]]), [setting(1, ['morning'])]), null)
      const out = S.rebaseSlotDrafts(new Map([[7, d]]), [setting(2, ['morning', 'noon'])])
      assert.equal(out.has(7), false, '自分の変更を「他の端末の変更」として残した')
    })

    it('備考を両方が別の値に変えた時は最新の値を残し、自分の備考を控える（選ぶまで保存できない）', () => {
      const d = S.draftFromSetting(setting(1, ['morning'], 'もと'), { slots: ['morning'], note: '自分' })
      const nd = S.rebaseSlotDrafts(new Map([[7, d]]), [setting(2, ['morning'], '相手')]).get(7)
      assert.equal(nd.note, '相手')
      assert.equal(nd.merged.myNote, '自分')
      assert.equal(S.mergeSummary(nd.merged), '備考を変更')
    })

    it('経路 b: 通知で読み直した後でも、編集を始めた時の版で送るので競合になり、他の端末の眠前は消えない', async () => {
      const srv = fakeServer()
      DB.__testHooks.setClient(srv.client)
      srv.db.med_slots.push({ id: 70, resident_id: 7, slots: ['morning', 'evening', 'bedtime'], note: null, rev: 2, deleted_at: null })
      const d = S.draftFromSetting(setting(1, ['morning', 'evening']), { slots: ['morning', 'noon', 'evening'], note: '' })
      // 直す前は保存した時点の設定（cur＝rev2）で送っていたので、競合にならず眠前が消えた
      const res = await DB.setMedSlots(7, d.slots, d.note, S.baseSettingOf(7, d), { editedBy: 11 })
      assert.equal(res, 'conflict', '他の端末の変更の上に黙って上書きした')
      assert.deepEqual(srv.db.med_slots[0].slots, ['morning', 'evening', 'bedtime'])
      assert.equal(S.baseSettingOf(7, S.draftFromSetting(null, { slots: ['noon'], note: '' })), null, '設定が無かった下書きは追加で送る')
    })

    it('配線: 保存は下書きの基準の版で送り、設定を読み直すたびに当て直す。食い違いの間は保存できない', () => {
      const src = code('../src/pages/MedSlotsPage.tsx')
      assert.match(src, /setMedSlots\(id, d\.slots, d\.note, baseSettingOf\(id, d\), \{ editedBy: recorderId \}\)/)
      assert.equal(/setMedSlots\(id, d\.slots, d\.note, cur,/.test(src), false, '保存した時点の版で送っている')
      assert.match(src, /setDrafts\(\(prev\) => rebaseSlotDrafts\(prev, settings\) \?\? prev\)/)
      assert.match(src, /disabled=\{!dirty \|\| clash\}/)
      assert.match(src, /他の端末の変更を取り込みました/)
      // 書きかけは画面の中だけ（端末に保存しない）・4列とタップ領域は崩さない
      assert.equal(/localStorage/.test(src), false)
      assert.match(src, /className="mt-2 grid grid-cols-4 gap-gap"/)
    })
  })

  // ════════════════════════════════════════════════════════════
  // F14 復帰・再接続の取り直し（画面の側）
  // ════════════════════════════════════════════════════════════
  describe('★F14 つながり直し・画面に戻った時の取り直し（RESYNC）を、画面は表を出したまま受ける', () => {
    it('月次表（与薬・入浴）: 通知での取り直しが失敗しても、表示中の表をエラーに置き換えない', () => {
      for (const p of ['../src/pages/MedMonthPage.tsx', '../src/pages/BathMonthPage.tsx']) {
        const src = code(p)
        assert.match(src, /refreshKindRef\.current = 'quiet'\s+setTick\(\(n\) => n \+ 1\)/, `${p}: 通知の取り直しを区別していない`)
        assert.match(src, /setRefreshFailed\(true\)/, `${p}: 取り直しの失敗で表を消す`)
        assert.match(src, /onRetry=\{retry\}/)
        assert.match(src, /他の端末の変更を読み込めませんでした（表示は前に読んだ内容です）/)
        // 取り直しの間も表示中の表を残す（読み込み中に戻さない＝スクロール位置を失わない）
        assert.match(src, /setData\(\(d\) => \(d !== null && d\.month === month/)
      }
      // 表の追加の文言は画面だけ（印刷に出さない）
      assert.match(read('../src/pages/MedMonthPage.tsx'), /className="text-sm text-warn print:hidden"/)
      assert.match(read('../src/pages/BathMonthPage.tsx'), /className="text-sm text-warn print:hidden"/)
    })
    it('与薬・入浴・時間帯の画面は行の無い通知（RESYNC）で読み直す（時間帯は med_slots の表の合図だけを受ける）', () => {
      const med = code('../src/pages/MedRecordPage.tsx')
      assert.match(med, /if \(row !== null && isSelfWrite\(table, row\)\) return\s+if \(table === 'med_admin' && row !== null &&/)
      const bath = code('../src/pages/BathRecordPage.tsx')
      assert.match(bath, /if \(row !== null && typeof row\.bath_on === 'string' && row\.bath_on !== day\) return/)
      const slots = code('../src/pages/MedSlotsPage.tsx')
      assert.match(slots, /if \(table !== 'med_slots'\) return\s+const row = info\?\.row \?\? null/)
    })
  })
}
