// 夜勤明けに前日の欄へ書き足した記録の時刻と「翌」の回帰テスト（F34・2026-10-10 本人裁定）。
// 裁定: 帰属日は暦の日付のまま。夜勤明け（0:00〜9時前）に前日の欄（日報の前日の夜勤欄・バイタル／食事の一覧と一括の
// 前日の列）へ書き足した記録は、書いた時刻を入れ、画面では「翌2:00」と出し、その日の夜の記録の後ろに並べる。
// 申し送り・バイタル・水分の3つを同じ規則にそろえる。
//
// 3種 ×「前日の欄に 02:00 に書く→時刻 02:00・表示 翌2:00・夜の後ろ」「当日の 02:00 に当日の欄に書く→翌なし」
// 「当日の昼に前日の欄に書く→時刻なし（従来どおり）」を、画面が実際に使う関数（一括2画面の measuredAtFor・takenAtFor・
// タイムラインの申し送りの並び・カルテのバイタルの並び）と共通の規則（src/lib/nextMorning.ts）で確かめる。
// 「翌」の判定に使う作成時刻（created_at）が db.ts の読み取りで控えられることも、偽の Supabase で確かめる。
// 直す前の版（git の HEAD 6f089a2）では赤（一括2画面は前日の列で時刻が空・共通の規則のファイルが無い）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
// 個人情報は置かない（利用者・職員は数値IDだけ。本文は合成の短い文）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { registerLoadFailure } from './ts-load.mjs'

const SKIP_REASON =
  'この Node では解決・読み込みフック（module.registerHooks）か esbuild が使えないため、夜勤明けの「翌」の検証をスキップしました（Node 22.15 以降で npm install 済みの環境で実行してください）。'

let hooksOk = false
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
      if (url.endsWith('.tsx')) {
        const src = readFileSync(fileURLToPath(url), 'utf8')
        const out = esbuild.transformSync(src, { loader: 'tsx', format: 'esm', jsx: 'automatic', sourcefile: url })
        return { format: 'module', source: out.code, shortCircuit: true }
      }
      if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }
      return next(url, context)
    },
  })
  if (globalThis.localStorage === undefined) {
    const ls = new Map()
    globalThis.localStorage = {
      getItem: (k) => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => ls.set(k, String(v)),
      removeItem: (k) => ls.delete(k),
    }
  }
  hooksOk = true
} catch (e) {
  if (process.env.CL_TEST_DEBUG) console.error(e)
}

/** 読み込み（失敗しても他の対象の試験は続ける。直す前の版で、どの試験が赤になるかを個別に見るため） */
async function load(rel) {
  try {
    return { mod: await import(rel), err: null }
  } catch (e) {
    return { mod: null, err: e }
  }
}

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')
/** 行末の // 注記を外したソース（注記の文言に当たらないように） */
const code = (p) => read(p).replace(/\/\/.*$/gm, '')

/** トップレベルの宣言1つ分（行頭の head から、次の行頭の宣言・コメントの手前まで） */
function declSrc(src, head) {
  const at = src.indexOf(`\n${head}`)
  assert.ok(at >= 0, `${head} が見つからない`)
  const from = at + 1
  const re = /\n(?=(?:async function |function |const |let |interface |type |export |\/\*\*|\/\/))/g
  re.lastIndex = from
  const m = re.exec(src)
  return src.slice(from, m ? m.index : undefined)
}
function evalDecls(src, heads, deps = {}) {
  const js = stripTypeScriptTypes(heads.map((h) => declSrc(src, h)).join('\n'))
  const names = heads.map((h) => /^(?:function|const|let)\s+([A-Za-z0-9_]+)/.exec(h)?.[1]).filter(Boolean)
  return new Function(...Object.keys(deps), `${js}\nreturn { ${names.join(', ')} }`)(...Object.values(deps))
}

// ── 端末の時計を差し替える（引数なしの new Date() と Date.now() だけを固定する） ─────────────────
const RealDate = Date
function withClock(fixed, fn) {
  const t = fixed.getTime()
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(t)
      else super(...args)
    }
    static now() {
      return t
    }
  }
  globalThis.Date = FakeDate
  try {
    return fn()
  } finally {
    globalThis.Date = RealDate
  }
}

// 端末の現地時刻（端末＝日本時間の運用。試験の時差に依らないよう、書く側は現地時刻・作成時刻は日本時間の ISO で作る）
const AT_NIGHT = new RealDate(2026, 7, 28, 2, 0) // 2026-08-28 02:00（夜勤明け）
const AT_NOON = new RealDate(2026, 7, 28, 12, 0) // 2026-08-28 12:00（日勤）
const PREV = '2026-08-27' // 前日の欄
const TODAY = '2026-08-28' // 当日の欄
/** 2026-08-28 02:00:30 JST（＝サーバーの created_at。夜勤明けに書いた行） */
const CREATED_NIGHT = '2026-08-27T17:00:30+00:00'
/** 2026-08-27 18:30 JST・22:00 JST（その日の夜に書いた行） */
const CREATED_EVE = '2026-08-27T09:30:10+00:00'
const CREATED_LATE = '2026-08-27T13:00:10+00:00'

const NM = hooksOk ? await load('../src/lib/nextMorning.ts') : { mod: null, err: new Error('hooks') }
const VG = hooksOk ? await load('../src/pages/VitalsGridPage.tsx') : { mod: null, err: new Error('hooks') }
const MG = hooksOk ? await load('../src/pages/MealsGridPage.tsx') : { mod: null, err: new Error('hooks') }
const DB = hooksOk ? await load('../src/lib/db.ts') : { mod: null, err: new Error('hooks') }

if (!hooksOk) {
  it('夜勤明けの「翌」の検証', { skip: SKIP_REASON }, () => {})
} else {
  // ══════════════════════════════════════════════════════════════
  // 書く時の時刻（3種）
  // ══════════════════════════════════════════════════════════════
  describe('★F34 書く時の時刻: 前日の欄は夜勤明けより前だけ今の時刻・当日は今の時刻・前日の昼は空（3種）', () => {
    if (VG.mod === null) registerLoadFailure('バイタル一括（measuredAtFor）', VG.err, SKIP_REASON, { hooks: true })
    else {
      it('バイタル（一括の measuredAtFor）: 前日の列に 02:00 → 02:00／当日の 02:00 → 02:00／当日の昼に前日の列 → 空', () => {
        assert.equal(withClock(AT_NIGHT, () => VG.mod.measuredAtFor(PREV)), '02:00')
        assert.equal(withClock(AT_NIGHT, () => VG.mod.measuredAtFor(TODAY)), '02:00')
        assert.equal(withClock(AT_NOON, () => VG.mod.measuredAtFor(PREV)), null)
        // 境目: 8:59 は入る・9:00 は入らない・前々日は入らない
        assert.equal(withClock(new RealDate(2026, 7, 28, 8, 59), () => VG.mod.measuredAtFor(PREV)), '08:59')
        assert.equal(withClock(new RealDate(2026, 7, 28, 9, 0), () => VG.mod.measuredAtFor(PREV)), null)
        assert.equal(withClock(AT_NIGHT, () => VG.mod.measuredAtFor('2026-08-26')), null)
      })
    }
    if (MG.mod === null) registerLoadFailure('食事一括（takenAtFor）', MG.err, SKIP_REASON, { hooks: true })
    else {
      it('水分（一括の takenAtFor）: 前日の列に 02:00 → 02:00／当日の 02:00 → 02:00／当日の昼に前日の列 → 空', () => {
        assert.equal(withClock(AT_NIGHT, () => MG.mod.takenAtFor(PREV)), '02:00')
        assert.equal(withClock(AT_NIGHT, () => MG.mod.takenAtFor(TODAY)), '02:00')
        assert.equal(withClock(AT_NOON, () => MG.mod.takenAtFor(PREV)), null)
        // 月をまたぐ日（9/1 の 1:30 に 8/31 の列）
        assert.equal(withClock(new RealDate(2026, 8, 1, 1, 30), () => MG.mod.takenAtFor('2026-08-31')), '01:30')
      })
    }
    if (NM.mod === null) registerLoadFailure('共通の規則（nextMorning.ts）', NM.err, SKIP_REASON, { hooks: true })
    else {
      it('申し送り（noteTimeFor）: 前日の夜勤の欄に 02:00 → 02:00／当日の 02:00 → 02:00／当日の昼に前日の欄 → 空／前日の日勤・デイの欄 → 空', () => {
        const { noteTimeFor, recordTimeFor } = NM.mod
        assert.equal(noteTimeFor(PREV, 'night', AT_NIGHT), '02:00')
        assert.equal(noteTimeFor(TODAY, 'night', AT_NIGHT), '02:00')
        assert.equal(noteTimeFor(TODAY, 'day', AT_NIGHT), '02:00')
        assert.equal(noteTimeFor(PREV, 'night', AT_NOON), null)
        assert.equal(noteTimeFor(PREV, 'day', AT_NIGHT), null)
        assert.equal(noteTimeFor(PREV, 'daycare', AT_NIGHT), null)
        // バイタル・水分の規則は勤務帯を持たない
        assert.equal(recordTimeFor(PREV, AT_NIGHT), '02:00')
        assert.equal(recordTimeFor(PREV, AT_NOON), null)
      })
    }

    it('配線: 書く所はすべて共通の規則を使い、「今日の時だけ今の時刻」の式が残っていない', () => {
      const daily = code('pages/DailySheetPage.tsx')
      const form = code('pages/NoteFormPage.tsx')
      assert.match(daily, /occurred_at: noteTimeFor\(day, draft\.shift, new Date\(\)\)/)
      assert.match(form, /const occurredAt = noteTimeFor\(form\.noteOn, form\.shift, now\)/)
      // 日報とフォームに同じ規則の写しを持たない（1か所にまとめた）
      for (const s of [daily, form]) {
        assert.doesNotMatch(s, /function noteOccurredAt\(/)
        assert.doesNotMatch(s, /const NIGHT_END_HOUR/)
      }
      const vs = code('pages/VitalsSheetPage.tsx')
      assert.equal((vs.match(/measured_at: recordTimeFor\(rec\.day\)/g) ?? []).length, 2)
      assert.doesNotMatch(vs, /rec\.day === today \? nowHM\(\) : null/)
      assert.match(code('pages/VitalsGridPage.tsx'), /export function measuredAtFor\(day: string\): string \| null \{\s*return recordTimeFor\(day\)/)
      assert.match(code('pages/MealsGridPage.tsx'), /export function takenAtFor\(day: string\): string \| null \{\s*return recordTimeFor\(day\)/)
      const ms = code('pages/MealsSheetPage.tsx')
      assert.match(ms, /taken_at: recordTimeFor\(day\),/)
      assert.doesNotMatch(ms, /taken_at: day === todayIso\(\)/)
      const cr = code('components/ConflictResolver.tsx')
      assert.match(cr, /measured_at: typeof vals\.measured_at === 'string' \? null : recordTimeFor\(target\.day\),/)
      assert.doesNotMatch(cr, /target\.day === todayIso\(\) \? nowHM\(\)/)
      assert.match(daily, /const at = typeof vals\.measured_at === 'string' \? vals\.measured_at : recordTimeFor\(c\.base\.measured_on\)/)
    })
  })

  if (NM.mod === null) {
    registerLoadFailure('「翌」の判定・表示・並び（nextMorning.ts）', NM.err, SKIP_REASON, { hooks: true })
  } else {
    const L = NM.mod
    // ══════════════════════════════════════════════════════════════
    // 「翌」の判定・表示・並び（3種）
    // ══════════════════════════════════════════════════════════════
    describe('★F34 「翌」の判定・表示・並び（3種）', () => {
      it('判定: 前日の記録で、作成時刻が翌日の 0:00〜9:00（＋猶予10分）・時刻が 9 時より前の時だけ「翌」', () => {
        // 前日の欄に夜勤明けに書いた
        assert.equal(L.isNextMorningAt(PREV, '02:00:00', CREATED_NIGHT), true)
        // 当日の早朝に当日の欄に書いた（作成時刻が記録日の当日）
        assert.equal(L.isNextMorningAt(TODAY, '02:00:00', CREATED_NIGHT), false)
        // 時刻が無い（従来の前日の欄・当日の昼に前日の欄）
        assert.equal(L.isNextMorningAt(PREV, null, '2026-08-28T03:00:00+00:00'), false)
        // 翌日の昼に前日の行を作り、時刻を手で入れた（前日の朝の後入れ）は「翌」にしない
        assert.equal(L.isNextMorningAt(PREV, '06:30:00', '2026-08-28T03:00:00+00:00'), false)
        // 9 時以降の時刻は「翌」にしない
        assert.equal(L.isNextMorningAt(PREV, '09:00:00', CREATED_NIGHT), false)
        // 8:59 に書いて 9:05 に届いた（猶予の内）・9:30 に届いた（猶予の外＝従来の表示へ倒す）
        assert.equal(L.isNextMorningAt(PREV, '08:59:00', '2026-08-28T00:05:00+00:00'), true)
        assert.equal(L.isNextMorningAt(PREV, '08:59:00', '2026-08-28T00:30:00+00:00'), false)
        // 2日後に届いた・作成時刻が分からない・壊れた値
        assert.equal(L.isNextMorningAt(PREV, '02:00:00', '2026-08-28T17:00:00+00:00'), false)
        assert.equal(L.isNextMorningAt(PREV, '02:00:00', null), false)
        assert.equal(L.isNextMorningAt(PREV, '02:00:00', 'x'), false)
        // 月・年をまたぐ日
        assert.equal(L.isNextMorningAt('2026-08-31', '01:30:00', '2026-08-31T16:30:00Z'), true)
        assert.equal(L.isNextMorningAt('2026-12-31', '03:00:00', '2026-12-31T18:00:00Z'), true)
      })

      it('表示: 翌は「翌2:00」・当日の早朝は「2:00」・時刻なしは空', () => {
        assert.equal(L.fmtRecordTime('02:00:00', true), '翌2:00')
        assert.equal(L.fmtRecordTime('02:00', false), '2:00')
        assert.equal(L.fmtRecordTime(null, true), '')
      })

      const kinds = [
        {
          name: '申し送り（夜勤）',
          table: 'notes',
          row: (id, time) => ({ id, note_on: PREV, shift: 'night', occurred_at: time }),
          isNext: L.noteIsNextMorning,
          timeOf: (r) => r.occurred_at,
          write: (now) => L.noteTimeFor(PREV, 'night', now),
          writeToday: (now) => L.noteTimeFor(TODAY, 'night', now),
          rowToday: (id, time) => ({ id, note_on: TODAY, shift: 'night', occurred_at: time }),
        },
        {
          name: 'バイタル',
          table: 'vitals',
          row: (id, time) => ({ id, measured_on: PREV, measured_at: time }),
          isNext: L.vitalIsNextMorning,
          timeOf: (r) => r.measured_at,
          write: (now) => L.recordTimeFor(PREV, now),
          writeToday: (now) => L.recordTimeFor(TODAY, now),
          rowToday: (id, time) => ({ id, measured_on: TODAY, measured_at: time }),
        },
        {
          name: '水分',
          table: 'fluid_intake',
          row: (id, time) => ({ id, taken_on: PREV, taken_at: time }),
          isNext: L.fluidIsNextMorning,
          timeOf: (r) => r.taken_at,
          write: (now) => L.recordTimeFor(PREV, now),
          writeToday: (now) => L.recordTimeFor(TODAY, now),
          rowToday: (id, time) => ({ id, taken_on: TODAY, taken_at: time }),
        },
      ]
      let nextId = 9000
      for (const k of kinds) {
        it(`${k.name}: 前日の欄に 02:00 に書く → 時刻 02:00・表示「翌2:00」・その日の夜の記録の後ろ`, () => {
          const t = k.write(AT_NIGHT)
          assert.equal(t, '02:00')
          const base = nextId
          nextId += 10
          const eve = k.row(base + 1, '18:30:00')
          const late = k.row(base + 2, '22:00:00')
          const night = k.row(base + 3, `${t}:00`)
          L.rememberCreatedAt(k.table, eve.id, CREATED_EVE)
          L.rememberCreatedAt(k.table, late.id, CREATED_LATE)
          L.rememberCreatedAt(k.table, night.id, CREATED_NIGHT)
          assert.equal(k.isNext(night), true)
          assert.equal(k.isNext(eve), false)
          assert.equal(L.fmtRecordTime(k.timeOf(night), k.isNext(night)), '翌2:00')
          const sorted = [night, late, eve].sort((a, b) =>
            (L.timeSortKey(k.timeOf(a), k.isNext(a)) ?? '').localeCompare(L.timeSortKey(k.timeOf(b), k.isNext(b)) ?? ''),
          )
          assert.deepEqual(sorted.map((r) => r.id), [eve.id, late.id, night.id])
        })
        it(`${k.name}: 当日の 02:00 に当日の欄に書く → 時刻 02:00・「翌」なし（夜の記録より前）`, () => {
          const t = k.writeToday(AT_NIGHT)
          assert.equal(t, '02:00')
          const id = nextId
          nextId += 10
          const early = k.rowToday(id, `${t}:00`)
          const eve = k.rowToday(id + 1, '18:30:00')
          L.rememberCreatedAt(k.table, early.id, CREATED_NIGHT) // 2026-08-28 02:00 JST＝記録日の当日
          L.rememberCreatedAt(k.table, eve.id, '2026-08-28T09:30:00Z')
          assert.equal(k.isNext(early), false)
          assert.equal(L.fmtRecordTime(k.timeOf(early), k.isNext(early)), '2:00')
          const sorted = [eve, early].sort((a, b) =>
            (L.timeSortKey(k.timeOf(a), k.isNext(a)) ?? '').localeCompare(L.timeSortKey(k.timeOf(b), k.isNext(b)) ?? ''),
          )
          assert.deepEqual(sorted.map((r) => r.id), [early.id, eve.id])
        })
        it(`${k.name}: 当日の昼に前日の欄に書く → 時刻なし（従来どおり）・「翌」なし`, () => {
          assert.equal(k.write(AT_NOON), null)
          const id = nextId
          nextId += 10
          const r = k.row(id, null)
          L.rememberCreatedAt(k.table, r.id, '2026-08-28T03:00:00Z')
          assert.equal(k.isNext(r), false)
          assert.equal(L.fmtRecordTime(k.timeOf(r), k.isNext(r)), '')
        })
      }

      it('旧データ: 前日の欄に時刻なしで入った記録は、作成時刻が夜勤明けでも「翌」にならない（表示・並びは従来どおり）', () => {
        const r = { id: 8801, note_on: PREV, shift: 'night', occurred_at: null }
        L.rememberCreatedAt('notes', r.id, CREATED_NIGHT)
        assert.equal(L.noteIsNextMorning(r), false)
        assert.equal(L.timeSortKey(null, false), null)
      })

      it('申し送りは夜勤だけ: 前日の日勤の申し送りに夜勤明けの作成時刻と早朝の時刻があっても「翌」にしない', () => {
        const r = { id: 8802, note_on: PREV, shift: 'day', occurred_at: '02:00:00' }
        L.rememberCreatedAt('notes', r.id, CREATED_NIGHT)
        assert.equal(L.noteIsNextMorning(r), false)
      })

      it('画面の並び: タイムラインの申し送り（noteTimeCmp）・カルテのバイタル（cmpVitalAsc）が「翌」を夜の後ろに置く', () => {
        const tl = evalDecls(read('pages/TimelinePage.tsx'), ['function noteTimeCmp('], {
          timeSortKey: L.timeSortKey,
          noteIsNextMorning: L.noteIsNextMorning,
        })
        const notes = [
          { id: 8901, note_on: PREV, shift: 'night', occurred_at: '02:00:00' },
          { id: 8902, note_on: PREV, shift: 'night', occurred_at: '22:00:00' },
          { id: 8903, note_on: PREV, shift: 'night', occurred_at: '18:30:00' },
        ]
        L.rememberCreatedAt('notes', 8901, CREATED_NIGHT)
        L.rememberCreatedAt('notes', 8902, CREATED_LATE)
        L.rememberCreatedAt('notes', 8903, CREATED_EVE)
        assert.deepEqual(notes.slice().sort((a, b) => tl.noteTimeCmp(a, b) || a.id - b.id).map((n) => n.id), [8903, 8902, 8901])

        const karte = read('pages/KartePage.tsx')
        const kv = evalDecls(karte, ['const KIND_ORDER', 'function cmpTime(', 'function cmpVitalAsc('], {
          timeSortKey: L.timeSortKey,
          vitalIsNextMorning: L.vitalIsNextMorning,
        })
        const vit = [
          { id: 8911, measured_on: PREV, kind: 'recheck', measured_at: '02:00:00' },
          { id: 8912, measured_on: PREV, kind: 'recheck', measured_at: '20:00:00' },
        ]
        L.rememberCreatedAt('vitals', 8911, CREATED_NIGHT)
        L.rememberCreatedAt('vitals', 8912, CREATED_LATE)
        assert.deepEqual(vit.slice().sort(kv.cmpVitalAsc).map((v) => v.id), [8912, 8911])
      })

      it('配線: 時刻を出す所・並べる所が「翌」を使う（日報・タイムライン・カルテ・検索・申し送りフォームの同じ日の記録・食事一覧の水分）', () => {
        const daily = code('pages/DailySheetPage.tsx')
        assert.match(daily, /timeSortKey\(a\.occurred_at, noteIsNextMorning\(a\)\)/)
        const tl = code('pages/TimelinePage.tsx')
        assert.match(tl, /fmtRecordTime\(note\.occurred_at, noteIsNextMorning\(note\)\)/)
        assert.equal((tl.match(/noteTimeCmp\(a, b\)/g) ?? []).length, 2)
        const ut = code('hooks/useTimeline.ts')
        assert.match(ut, /timeSortKey\(a\.occurred_at, noteIsNextMorning\(a\)\)/)
        assert.match(ut, /timeSortKey\(a\.measured_at, vitalIsNextMorning\(a\)\)/)
        assert.match(ut, /timeSortKey\(a\.taken_at, fluidIsNextMorning\(a\)\)/)
        const karte = code('pages/KartePage.tsx')
        assert.match(karte, /fmtRecordTime\(note\.occurred_at, noteIsNextMorning\(note\)\)/)
        assert.match(karte, /const at = timeSortKey\(a\.occurred_at, noteIsNextMorning\(a\)\)/)
        assert.match(code('pages/SearchPage.tsx'), /fmtRecordTime\(note\.occurred_at, noteIsNextMorning\(note\)\)/)
        assert.match(code('pages/NoteFormPage.tsx'), /fmtRecordTime\(n\.occurred_at, noteIsNextMorning\(n\)\)/)
        const ms = code('pages/MealsSheetPage.tsx')
        assert.match(ms, /fmtRecordTime\(f\.taken_at, fluidIsNextMorning\(f\)\)/)
        assert.match(ms, /timeSortKey\(a\.taken_at, fluidIsNextMorning\(a\)\)/)
      })
    })
  }

  // ══════════════════════════════════════════════════════════════
  // 作成時刻の読み取り（db.ts が created_at を読み、id で控える）
  // ══════════════════════════════════════════════════════════════
  describe('★F34 作成時刻の読み取り: カルテの取得で申し送り・バイタル・水分の created_at を読み、「翌」が決まる', () => {
    if (DB.mod === null || NM.mod === null) {
      registerLoadFailure('db.ts の読み取り', DB.err ?? NM.err, SKIP_REASON, { hooks: true })
      return
    }
    it('偽の Supabase: 3表の select に created_at が入り、読んだ行の「翌」が決まる', async () => {
      const asked = {}
      const rows = {
        notes: [
          { id: 7001, note_on: PREV, shift: 'night', body: '合成の申し送り', occurred_at: '02:00:00', rev: 1, created_at: CREATED_NIGHT },
          { id: 7002, note_on: PREV, shift: 'night', body: '合成の申し送り', occurred_at: '22:00:00', rev: 1, created_at: CREATED_LATE },
        ],
        vitals: [{ id: 7101, resident_id: 1, measured_on: PREV, kind: 'routine', measured_at: '02:00:00', temp: 36.5, rev: 1, created_at: CREATED_NIGHT }],
        fluid_intake: [{ id: 7201, resident_id: 1, taken_on: PREV, taken_at: '02:00:00', amount_ml: 100, rev: 1, created_at: CREATED_NIGHT }],
      }
      const builder = (table) => {
        const done = () => Promise.resolve({ data: rows[table] ?? [], error: null, status: 200 })
        const b = {
          select: (cols) => {
            asked[table] = cols
            return b
          },
          eq: () => b,
          is: () => b,
          in: () => b,
          gte: () => b,
          lte: () => b,
          or: () => b,
          order: () => b,
          limit: () => b,
          then: (ok, ng) => done().then(ok, ng),
        }
        return b
      }
      const client = {
        from: builder,
        rpc: () => Promise.resolve({ data: null, error: null }),
        channel: () => {
          const ch = { on: () => ch, subscribe: () => ch }
          return ch
        },
        getChannels: () => [],
        removeChannel: () => Promise.resolve('ok'),
        auth: { onAuthStateChange() {}, getSession: () => Promise.resolve({ data: { session: { user: { id: 'u' } } }, error: null }) },
      }
      DB.mod.__testHooks.setClient(client)
      try {
        const k = await DB.mod.fetchKarte(1, '2026-08-20', TODAY)
        for (const t of ['notes', 'vitals', 'fluid_intake']) assert.match(asked[t] ?? '', /(^|,)created_at(,|$)/, `${t} の select に created_at が無い`)
        const n1 = k.notes.find((n) => n.id === 7001)
        const n2 = k.notes.find((n) => n.id === 7002)
        assert.equal(NM.mod.noteIsNextMorning(n1), true)
        assert.equal(NM.mod.noteIsNextMorning(n2), false)
        assert.equal(NM.mod.vitalIsNextMorning(k.vitals[0]), true)
        assert.equal(NM.mod.fluidIsNextMorning(k.fluids[0]), true)
        // 行そのものには載せない（types.ts は凍結契約。作成時刻は id で控える）
        assert.equal('created_at' in n1, false)
      } finally {
        DB.mod.__testHooks.setClient(null)
      }
    })
  })
}
