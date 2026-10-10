// バイタル・食事の4画面（バイタル一覧・食事一覧・バイタル一括・食事一括）の多端末運用の回帰テスト
// （2026-10-10 多端末運用の監査 バイタル・食事担当: F01・F14・F17・F18・F38・F68。F22・F34・F46 は持ち場の変更が要らない
// ことの見張り）。直す前の版では赤、直した後で緑になる形。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 画面（src/pages/*.tsx）が export する判定の純関数を、esbuild（vite が持つ）で tsx を変換する読み込みフックを入れてから
// 読んで確かめる（与薬・入浴の試験 medbath-multidevice と同じ作り）。React の描画が要る配線（effect・保存の分岐）は
// 静的検査で固定する。db.ts は画面と同じ URL で読み込む（同じ送信待ちを見る）。偽の Supabase で動かし、通信しない。
// 個人情報は置かない（利用者・職員は数値IDだけ）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const SKIP =
  'この Node では解決・読み込みフック（module.registerHooks）か esbuild が使えないため、バイタル・食事の画面の検証をスキップしました（Node 22.15 以降で npm install 済みの環境で実行してください）。'

const lsStore = new Map()
let VG = null
let VS = null
let MG = null
let MS = null
let DB = null
let RS = null
let FMT = null
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
      // 端末の保存領域が一杯の状態（同じオリジンの他のアプリと共有・F01）
      if (globalThis.__lsFull) {
        const e = new Error('The quota has been exceeded.')
        e.name = 'QuotaExceededError'
        throw e
      }
      lsStore.set(k, String(v))
    },
    removeItem: (k) => {
      lsStore.delete(k)
    },
  }
  DB = await import('../src/lib/db.ts')
  RS = await import('../src/lib/rowSync.ts')
  FMT = await import('../src/lib/format.ts')
  VG = await import('../src/pages/VitalsGridPage.tsx')
  VS = await import('../src/pages/VitalsSheetPage.tsx')
  MG = await import('../src/pages/MealsGridPage.tsx')
  MS = await import('../src/pages/MealsSheetPage.tsx')
} catch (e) {
  if (process.env.CL_TEST_DEBUG) console.error(e)
  VG = null
}

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')
/** 行末の // 注記を外したソース（注記の文言に当たらないように） */
const code = (p) => read(p).replace(/\/\/.*$/gm, '')
const PAGES = ['VitalsGridPage.tsx', 'VitalsSheetPage.tsx', 'MealsGridPage.tsx', 'MealsSheetPage.tsx']

/**
 * 文字列 open で始まる分岐の本文（分岐を抜ける1行だけの `return` まで）を取り出す。見つかった全部を返す
 * （中の関数の `return { … }` では止めない）
 */
function branches(src, open) {
  const out = []
  let at = src.indexOf(open)
  while (at >= 0) {
    const start = at + open.length
    const m = /\n\s*return\n/.exec(src.slice(start))
    out.push(src.slice(start, m ? start + m.index : undefined))
    at = src.indexOf(open, start)
  }
  return out
}

// ── 偽の Supabase（通信できない端末。送信待ちに積むためだけに使う） ─────────────────

function offlineClient() {
  const fail = () => Promise.resolve({ data: null, error: { message: 'offline' }, status: 0 })
  const builder = () => {
    const b = {
      select: () => b,
      insert: () => b,
      update: () => b,
      eq: () => b,
      is: () => b,
      in: () => b,
      gte: () => b,
      lte: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => fail(),
      single: () => fail(),
      then: (ok, ng) => fail().then(ok, ng),
    }
    return b
  }
  const channel = () => {
    const ch = { on: () => ch, subscribe: () => ch, track: () => Promise.resolve('ok'), untrack: () => Promise.resolve('ok'), presenceState: () => ({}) }
    return ch
  }
  return {
    from: builder,
    rpc: builder,
    channel,
    getChannels: () => [],
    removeChannel: () => Promise.resolve('ok'),
    auth: { onAuthStateChange() {} },
  }
}

const noTimer = { set: () => 1, clear: () => undefined }
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms))

async function reset() {
  await settle()
  lsStore.clear()
  globalThis.__lsFull = false
  DB.__testHooks.setClient(null)
  await DB.__testHooks.restartQueue()
  DB.__testHooks.setTimer(noTimer)
}

const DAY = '2026-10-09'
const NONE = { temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null }
const EMPTY_BUF = { temp: '', sys_bp: '', dia_bp: '', pulse: '', spo2: '' }

/** バイタル一括の行（GridRow と同じ形） */
function gridRow(over = {}) {
  return {
    rowId: 'r1',
    residentId: 1,
    kind: 'routine',
    vitalId: null,
    rev: 0,
    saved: { ...NONE },
    buf: { ...EMPTY_BUF },
    prev: { ...NONE },
    state: 'idle',
    message: '',
    ...over,
  }
}

/** バイタル一覧の1名×1日（Rec と同じ形） */
function sheetRec(over = {}) {
  return {
    residentId: 1,
    day: DAY,
    kind: 'routine',
    slot: 0,
    vitalId: null,
    rev: 0,
    saved: { ...NONE },
    buf: { ...EMPTY_BUF },
    state: 'idle',
    message: '',
    ...over,
  }
}

if (VG === null) {
  it('バイタル・食事の画面の検証', { skip: SKIP }, () => {})
} else {
  // ══════════════════════════════════════════════════════════════
  // F01: 保存領域が一杯で送信待ちを端末に残せない時、4画面は「送信待ち」と案内せず入力を残す
  // ══════════════════════════════════════════════════════════════
  describe('★F01 端末に控えを残せない送信待ちを「電波が戻ると自動で送信します」と案内しない（4画面）', () => {
    afterEach(reset)

    it('静的: 4画面とも queued を受けたら isQueuePersisted を確かめ、残せない時は送ったものとして扱わない', () => {
      // 保存の経路ごとの数（一括: 保存・新しい行として保存（・食事一括は水分）／一覧: 同じ）
      const want = { 'VitalsGridPage.tsx': 2, 'VitalsSheetPage.tsx': 2, 'MealsGridPage.tsx': 3, 'MealsSheetPage.tsx': 3 }
      for (const p of PAGES) {
        const s = code(`pages/${p}`)
        assert.match(s, /\bisQueuePersisted,/, `${p} が isQueuePersisted を読み込んでいない`)
        const bodies = branches(s, "if (res === 'queued' && !isQueuePersisted()) {")
        assert.equal(bodies.length, want[p], `${p} の queued の分岐で端末に残せたかを確かめていない`)
        for (const b of bodies) {
          assert.doesNotMatch(b, /settleSent\(|queuedRef\.current\[|setQueuedFluids\(|\bsent[,:]|MSG_QUEUED/, `${p}: 残せない時に送ったものとして扱っている`)
          assert.match(b, /MSG_NOT_PERSISTED/, `${p}: 残せない時の文言を出していない`)
        }
        // くらべて選ぶで送信待ちにした時も同じ（文言を差し替える）
        assert.match(s, /r\.queued && \(r\.choice === 'mine' \|\| r\.choice === 'both'\) && !isQueuePersisted\(\)/, `${p} の〔自分の値で直す〕〔両方残す〕が確かめていない`)
        // 文言は「自動で送信します」と言わない
        const msg = /const MSG_NOT_PERSISTED =\s*'([^']+)'/.exec(read(`pages/${p}`))
        assert.ok(msg, `${p} に MSG_NOT_PERSISTED が無い`)
        assert.match(msg[1], /控えを残せませんでした/)
        assert.match(msg[1], /入力は消えていません/)
        assert.doesNotMatch(msg[1], /自動で送信します/)
      }
    })

    it('バイタル一括: 残せなかった印のある行は、編集が無くても離れる時の確認に数え、送れた後の読み込みで印が外れて片付く', () => {
      assert.equal(typeof VG.holdsInput, 'function', 'holdsInput を確かめられない')
      assert.equal(VG.holdsInput(gridRow()), false)
      assert.equal(VG.holdsInput(gridRow({ state: 'error', unpersisted: true })), true, '〔両方残す〕などで編集が無い時も数える')
      assert.equal(VG.isHeldRow(gridRow({ state: 'error', unpersisted: true })), true)
      // 送った値（38.2）がサーバーに載った＝読み込みで片付く（自分の値どうしの競合にしない）
      const edits = RS.recordFieldEdit({}, 'temp', 38.2, null)
      const cur = gridRow({ state: 'error', message: '…', edits, buf: { ...EMPTY_BUF, temp: '38.2' }, unpersisted: true })
      const fresh = gridRow({ vitalId: 10, rev: 1, saved: { ...NONE, temp: 38.2 }, buf: { ...EMPTY_BUF, temp: '38.2' } })
      const merged = VG.mergeOnLoad(cur, fresh)
      assert.equal(merged.unpersisted, undefined, '送れた後も「端末に残せていない」の印が残る')
      assert.equal(merged.state, 'idle')
      assert.equal(RS.hasEdits(merged.edits), false)
    })

    it('バイタル一覧: 同じ規則（離れる時の確認に数え、送れた後の読み込みで片付く）', () => {
      assert.equal(typeof VS.holdsInput, 'function', 'holdsInput を確かめられない')
      assert.equal(VS.holdsInput(sheetRec()), false)
      assert.equal(VS.holdsInput(sheetRec({ state: 'error', unpersisted: true })), true)
      const edits = RS.recordFieldEdit({}, 'pulse', 72, null)
      const cur = sheetRec({ state: 'error', edits, buf: { ...EMPTY_BUF, pulse: '72' }, unpersisted: true })
      const fresh = sheetRec({ vitalId: 11, rev: 1, saved: { ...NONE, pulse: 72 }, buf: { ...EMPTY_BUF, pulse: '72' } })
      const merged = VS.mergeOnLoad(cur, fresh)
      assert.equal(merged.unpersisted, undefined)
      assert.equal(merged.state, 'idle')
    })

    it('バイタル一括: 残せなかった行は、送信待ちの重ね表示（⚠ 未送信）にしない。残せた行は今までどおり送信待ちにする', async () => {
      DB.__testHooks.setClient(offlineClient())
      DB.__testHooks.setTimer(noTimer)
      globalThis.__lsFull = true
      try {
        const target = { routine: true, residentId: 1, day: DAY }
        assert.equal(await DB.saveVitalEdits(target, { temp: { value: 38.2, base: null } }), 'queued')
        assert.equal(DB.isQueuePersisted(), false)
        const edits = RS.recordFieldEdit({}, 'temp', 38.2, null)
        const lost = [gridRow({ state: 'error', message: 'x', edits, buf: { ...EMPTY_BUF, temp: '38.2' }, unpersisted: true })]
        VG.adoptStoreRows(lost, DAY)
        assert.equal(lost[0].state, 'error', '残せなかった行を「送信待ち」に戻している')
        assert.equal(lost[0].sent, undefined)
        // 対照: 印の無い行は送信待ちの重ね表示になる（従来の動き）
        const quiet = [gridRow()]
        VG.adoptStoreRows(quiet, DAY)
        assert.equal(quiet[0].state, 'queued')
      } finally {
        globalThis.__lsFull = false
      }
    })

    it('食事一覧: 表の上の「残せていない」警告は、残せていない送信待ちがメモリにある間は下ろさない（水分の分も）', async () => {
      assert.equal(typeof MS.settledSaveError, 'function', 'settledSaveError を確かめられない')
      const lostText = `水分 ＋200ml：${MS.MSG_NOT_PERSISTED}`
      assert.equal(MS.isNotPersistedText(lostText), true)
      assert.equal(MS.isNotPersistedText('通信できないため送信待ちにしました。'), false)
      // 送信待ちが空＝残すものが無い → 下ろす
      assert.equal(MS.settledSaveError(lostText), null)
      DB.__testHooks.setClient(offlineClient())
      globalThis.__lsFull = true
      try {
        assert.equal(await DB.insertFluid({ resident_id: 1, taken_on: DAY, taken_at: '10:00', amount_ml: 200, kind: null, recorded_by: null }), 'queued')
        assert.equal(DB.hasUnpersistedQueue(), true)
        assert.equal(MS.settledSaveError(lostText), lostText, '残せていない水分が残っているのに警告を下ろした')
        assert.equal(MS.settledSaveError('別の警告'), null)
      } finally {
        globalThis.__lsFull = false
      }
    })

    it('静的: 食事の2画面は、残せなかった印を離れる時の確認に数え、水分を送信待ちの概算（queuedFluids）に積まない', () => {
      for (const p of ['MealsGridPage.tsx', 'MealsSheetPage.tsx']) {
        const s = code(`pages/${p}`)
        assert.match(s, /registerUnsaved\([\s\S]*?Object\.keys\(unpersistedRef\.current\)\.length > 0/, `${p} が離れる時の確認に数えていない`)
      }
      const mg = code('pages/MealsGridPage.tsx')
      // 一括: 残せなかった水分は行に危険の色で残す（トーストだけで終わらせない）
      assert.match(mg, /setLostFluids\(\(prev\) =>/)
      assert.match(mg, /lostMl > 0 \? \(\s*<p role="alert" className="mt-1 text-sm text-danger">/)
      assert.match(mg, /fluidsHeldRef\.current\.lost > 0/)
      // 一覧: 表の上の警告は、残せない時だけ危険の色（枠は今までどおり）
      const ms = code('pages/MealsSheetPage.tsx')
      assert.match(ms, /isNotPersistedText\(saveError\)\s*\?\s*'rounded-lg border border-danger bg-danger-bg p-4'\s*:\s*'rounded-lg border border-warn bg-warn-bg p-4'/)
    })

    it('静的: 送信待ちが減ったら背景で取り直す（自分の送信の通知は捨てられるので、残せなかった入力・⚠ 未送信を片付ける経路）', () => {
      for (const p of ['MealsGridPage.tsx', 'MealsSheetPage.tsx']) {
        assert.match(code(`pages/${p}`), /queueSubscribe\(\(n\) => \{[\s\S]*?if \(last >= 0 && count < last\) (schedule|retryRef\.current\?\.)\(\)/, p)
      }
      assert.match(code('pages/VitalsGridPage.tsx'), /r\.unpersisted === true && !stillPending\(r, dayRef\.current\)\)\) retryRef\.current\?\.\(\)/)
      assert.match(code('pages/VitalsSheetPage.tsx'), /r\.unpersisted === true && !stillPending\(r\)\)\) retryRef\.current\?\.\(\)/)
    })
  })

  // ══════════════════════════════════════════════════════════════
  // F14: 取り直しの合図（RESYNC）。一覧2画面は二重に読まず、つながり直しだけを受ける。一括2画面は全部を受ける
  // ══════════════════════════════════════════════════════════════
  describe('★F14 購読のつながり直し・画面の復帰・電波の復帰で取り直す', () => {
    it('一覧2画面: 画面に戻った・電波が戻った RESYNC は自前の30秒の処理に任せて捨て、つながり直しは受ける', () => {
      for (const M of [VS, MS]) {
        assert.equal(typeof M.isResumeOrOnline, 'function', 'isResumeOrOnline を確かめられない')
        assert.equal(M.isResumeOrOnline({ event: 'RESYNC', row: null, resync: 'resume' }), true)
        assert.equal(M.isResumeOrOnline({ event: 'RESYNC', row: null, resync: 'online' }), true)
        assert.equal(M.isResumeOrOnline({ event: 'RESYNC', row: null, resync: 'reconnect' }), false, 'つながり直しを捨てている')
        assert.equal(M.isResumeOrOnline({ event: 'UPDATE', row: { measured_on: DAY } }), false)
        assert.equal(M.isResumeOrOnline(undefined), false)
      }
      for (const p of ['VitalsSheetPage.tsx', 'MealsSheetPage.tsx']) {
        const s = code(`pages/${p}`)
        assert.match(s, /unsub = subscribeChanges\([\s\S]{0,400}if \(isResumeOrOnline\(info\)\) return/, `${p} の購読で捨てていない`)
        // 自前の復帰処理（しきい値つき）は残す（本人の裁定のしきい値を変えない）
        assert.match(s, /document\.addEventListener\('visibilitychange', onVisible\)/, p)
        assert.match(s, /if \(away >= AWAY_REFETCH_MS\) schedule\(\)/, p)
      }
    })

    it('一括2画面: 行の無い RESYNC は「分からない＝取り直す」に倒れる（日付で捨てない）', () => {
      assert.equal(VG.changedDay({ event: 'RESYNC', row: null, resync: 'reconnect' }), null)
      assert.equal(VG.changedDay({ event: 'UPDATE', row: { measured_on: DAY } }), DAY)
      assert.equal(MG.touchesDay('meals', { event: 'RESYNC', row: null, resync: 'resume' }, DAY), true)
      assert.equal(MG.touchesDay('fluid_intake', { event: 'RESYNC', row: null, resync: 'online' }, DAY), true)
      for (const p of ['VitalsGridPage.tsx', 'MealsGridPage.tsx']) assert.doesNotMatch(code(`pages/${p}`), /'RESYNC'/, `${p} が RESYNC を捨てている`)
    })
  })

  // ══════════════════════════════════════════════════════════════
  // F17: 一括2画面も他の端末の記録を自動で取り込む（入力中の欄・未送信の値は残す）
  // ══════════════════════════════════════════════════════════════
  describe('★F17 一括入力の2画面に購読と背景の取り直し', () => {
    it('バイタル一括: vitals の表示中の期間の変更だけを合図にし、背景ではキーパッドを閉じず、自分の保存が割り込んだ取得は捨てる', () => {
      const s = code('pages/VitalsGridPage.tsx')
      assert.match(s, /const WATCHED_TABLE = 'vitals'/)
      assert.match(s, /unsub = subscribeChanges\(\(table, info\?: ChangeInfo\) => \{[\s\S]*?if \(table !== WATCHED_TABLE\) return[\s\S]*?if \(isSelfWrite\(table, info\?\.row\)\) return[\s\S]*?schedule\(\)/)
      assert.match(s, /const load = useCallback\(async \(opts\?: \{ background\?: boolean \}\) =>/)
      assert.match(s, /if \(background && selfWriteRef\.current >= startedAt\) \{\s*retryRef\.current\?\.\(\)/)
      assert.match(s, /if \(!background\) \{\s*setSel\(null\)\s*setEdit\(''\)\s*\}/, '背景の取り直しでキーパッドを閉じる')
      // 保存の応答待ち・順番待ちの間は取り直さない
      assert.match(s, /const busy = jobsRef\.current > 0 \|\| rowsRef\.current\.some\(\(r\) => r\.state === 'saving'\)/)
      // 開いているキーパッドの行を取り上げる取り直しは見送り、欄を移った・閉じた後にやり直す
      assert.match(s, /if \(background && open !== null && !next\.some\(\(r\) => r\.rowId === open\.rowId\)\) \{\s*deferredRef\.current = true/)
      // 期間は前回値の遡り〜当日（前日分の訂正で前回値の薄い表示も変わる）
      assert.match(s, /windowRef\.current = \{ from: addDays\(day, -PREV_LOOKBACK_DAYS\), to: day \}/)
    })

    it('バイタル一括: 変更通知の日付で絞る（期間の外は取り直さない）', () => {
      assert.equal(VG.changedDay({ event: 'INSERT', row: { measured_on: '2026-10-01' } }), '2026-10-01')
      assert.equal(VG.changedDay({ event: 'INSERT', row: {} }), null)
      assert.equal(VG.changedDay(undefined), null)
    })

    it('食事一括: 当日の食事・水分と外出の変更を合図にする（他の日・他の表は取り直さない）', () => {
      assert.equal(typeof MG.touchesDay, 'function', 'touchesDay を確かめられない')
      assert.equal(MG.touchesDay('meals', { event: 'UPDATE', row: { meal_on: DAY } }, DAY), true)
      assert.equal(MG.touchesDay('meals', { event: 'UPDATE', row: { meal_on: '2026-10-08' } }, DAY), false)
      assert.equal(MG.touchesDay('fluid_intake', { event: 'INSERT', row: { taken_on: DAY } }, DAY), true)
      assert.equal(MG.touchesDay('fluid_intake', { event: 'INSERT', row: { taken_on: '2026-10-08' } }, DAY), false)
      assert.equal(MG.touchesDay('outings', { event: 'UPDATE', row: { start_on: '2026-10-01' } }, DAY), true, '外出は期間で当たるので日付で捨てない')
      assert.equal(MG.touchesDay('vitals', { event: 'UPDATE', row: { measured_on: DAY } }, DAY), false)
      assert.equal(MG.touchesDay('notes', { event: 'UPDATE', row: null }, DAY), false)
    })

    it('食事一括: 背景の取り直しは〔元に戻す〕を消さず（行が残る分だけ持ち越す）、自分の保存が割り込んだ取得は捨てる', () => {
      const s = code('pages/MealsGridPage.tsx')
      assert.match(s, /const load = useCallback\(async \(opts\?: \{ background\?: boolean \}\) =>/)
      assert.match(s, /if \(background && selfWriteRef\.current >= startedAt\) \{\s*retryRef\.current\?\.\(\)/)
      assert.match(s, /if \(background\) \{\s*const aliveRev = new Map\(nextFluids\.map\(\(f\) => \[f\.id, f\.rev\]\)\)/)
      assert.match(s, /unsub = subscribeChanges\(\(table, info\?: ChangeInfo\) => \{[\s\S]*?if \(isSelfWrite\(table, info\?\.row\)\) return[\s\S]*?if \(!touchesDay\(table, info, dayRef\.current\)\) return\s*schedule\(\)/)
      assert.match(s, /if \(jobsRef\.current > 0 \|\| Object\.values\(phasesRef\.current\)\.some\(\(p\) => p === 'saving'\)\) \{\s*schedule\(\)/)
      // 保存・水分・くらべて選ぶの前後に自分の書込の印を付ける
      assert.ok((s.match(/selfWriteRef\.current = Date\.now\(\)/g) ?? []).length >= 8)
    })
  })

  // ══════════════════════════════════════════════════════════════
  // F18: 日付をまたいで開いたままの一括2画面
  // ══════════════════════════════════════════════════════════════
  describe('★F18 開いたまま日付をまたいだ一括入力', () => {
    it('入力中・未送信が無ければ今日へ切り替え、残っていれば帯で知らせる（2画面とも同じ規則）', () => {
      for (const M of [VG, MG]) {
        assert.equal(typeof M.dayRollover, 'function', 'dayRollover を確かめられない')
        assert.equal(M.dayRollover('2026-10-09', '2026-10-09', true), 'none')
        assert.equal(M.dayRollover('2026-10-09', '2026-10-09', false), 'none')
        assert.equal(M.dayRollover('2026-10-08', '2026-10-09', true), 'switch')
        assert.equal(M.dayRollover('2026-10-08', '2026-10-09', false), 'notice')
      }
    })

    it('新しい行の測定時刻・水分の時刻は、今日は今の時刻・前日は夜勤明け（9時）より前だけ今の時刻（前日の行に昼の時刻を入れない・F34）', () => {
      // 2026-10-10 本人裁定（F34）: 夜勤明けに前日の列へ書き足した記録は書いた時刻を入れ、画面では「翌」を付ける。
      // 9時以降に前日の列へ書いた記録は従来どおり時刻なし。端末の時計を差し替えて確かめる（実行する時刻に依らない）
      const RealDate = Date
      const clockAt = (h) => {
        const t = new RealDate(2026, 9, 9, h, 0).getTime()
        return class extends RealDate {
          constructor(...a) {
            if (a.length === 0) super(t)
            else super(...a)
          }
          static now() {
            return t
          }
        }
      }
      try {
        globalThis.Date = clockAt(12)
        assert.equal(VG.measuredAtFor('2026-10-09'), '12:00')
        assert.equal(VG.measuredAtFor('2026-10-08'), null)
        assert.equal(MG.takenAtFor('2026-10-09'), '12:00')
        assert.equal(MG.takenAtFor('2026-10-08'), null)
        globalThis.Date = clockAt(2)
        assert.equal(VG.measuredAtFor('2026-10-08'), '02:00')
        assert.equal(MG.takenAtFor('2026-10-08'), '02:00')
        assert.equal(VG.measuredAtFor('2026-10-07'), null)
      } finally {
        globalThis.Date = RealDate
      }
      const vg = code('pages/VitalsGridPage.tsx')
      assert.doesNotMatch(vg, /measured_at: nowHM\(\)/, '無条件に今の時刻を入れている')
      assert.equal((vg.match(/measured_at: measuredAtFor\(day\)/g) ?? []).length, 2)
      const mg = code('pages/MealsGridPage.tsx')
      assert.doesNotMatch(mg, /taken_at: nowTimeHM\(new Date\(\)\)/)
      assert.match(mg, /taken_at: takenAtFor\(dayRef\.current\)/)
    })

    it('静的: 表示中の日を切り替えられ、1分ごと・画面の復帰・電波の復帰で見直し、帯と〔今日にする〕を出す', () => {
      for (const p of ['VitalsGridPage.tsx', 'MealsGridPage.tsx']) {
        const s = code(`pages/${p}`)
        assert.match(s, /const \[day, setDay\] = useState\(\(\) => todayIso\(\)\)/, p)
        assert.match(s, /const timer = setInterval\(check, DAY_CHECK_MS\)/, p)
        assert.match(s, /document\.addEventListener\('visibilitychange', onVisible\)/, p)
        assert.match(s, /window\.addEventListener\('online', check\)/, p)
        assert.match(s, /if \(dayRollover\(dayRef\.current, t, quiet\) === 'switch'\) switchDay\(t\)/, p)
        assert.match(s, /\{day !== nowDay \? \(/, p)
        assert.match(read(`pages/${p}`), /日付が変わりました（表示中: \{fmtDayLabel\(day\)\}）/, p)
        assert.match(s, /今日（\{fmtDayLabel\(nowDay\)\}）にする/, p)
        // 切り替えは前の日の控えを片付けてから。まだ保存していない入力が消える時は確認を出す
        assert.match(s, /const switchDay = useCallback\(\s*\(t: string\) => \{\s*dayRef\.current = t/, p)
        assert.match(s, /open=\{dayAsk\}/, p)
        assert.match(s, /if \(isBusy\(\)\) \{\s*switchTimerRef\.current = setTimeout\(step, 300\)/, p)
      }
      const vg = code('pages/VitalsGridPage.tsx')
      // 切り替える前の日の保存・取り直しが、同じ行 id（r{利用者id}）の新しい日の行へ当たらない
      assert.ok((vg.match(/day !== dayRef\.current/g) ?? []).length >= 8)
      assert.match(vg, /!offline && selRef\.current === null && !isBusy\(\) && !rowsRef\.current\.some\(\(r\) => isHeldRow\(r\) \|\| r\.unpersisted === true\)/)
      const mg = code('pages/MealsGridPage.tsx')
      // 食事の枠も今の時刻で選び直す。新しい日を読み終えるまで押させない
      assert.match(mg, /const nextSlot = slotForHour\(new Date\(\)\.getHours\(\)\)/)
      assert.match(mg, /const canInput = inputEnabled && flagChecked && !cellsMissing && !daySwitching/)
      assert.match(mg, /fluidsHeldRef\.current\.queued === 0/)
      // 電波が無い間は黙って切り替えない（新しい日を読めず入力できない画面にしない。電波が戻った時に見直す）
      for (const s of [vg, mg]) assert.match(s, /const offline = typeof navigator !== 'undefined' && navigator\.onLine === false/)
    })
  })

  // ══════════════════════════════════════════════════════════════
  // F38: バイタル・食事の画面に今の記録者を常に出し、すぐ切り替えられる
  // ══════════════════════════════════════════════════════════════
  describe('★F38 4画面の操作バーに「記録者: 名前〔変更〕」', () => {
    it('4画面とも RecorderBar を置き、記録に付く actorId を渡す（一覧は畳んでも隠さない場所）', () => {
      for (const p of PAGES) {
        const s = code(`pages/${p}`)
        assert.match(s, /import \{ RecorderBar \} from '\.\.\/components\/RecorderBar'/, p)
        assert.match(s, /<RecorderBar actorId=\{actorId \?\? null\}/, p)
      }
      // 一覧: 畳んだ形でも残る persistent に入れる（バイタル一覧は保存状況と並べる）
      const vs = code('pages/VitalsSheetPage.tsx')
      assert.match(vs, /const statusLine = \(\s*<>[\s\S]*?<RecorderBar actorId=\{actorId \?\? null\} \/>\s*<\/>\s*\)/)
      assert.match(vs, /persistent=\{statusLine\}/)
      const ms = code('pages/MealsSheetPage.tsx')
      assert.match(ms, /persistent=\{<RecorderBar actorId=\{actorId \?\? null\} \/>\}/)
      assert.match(ms, /full=\{\(extra\) => \(/)
      assert.match(ms, /最新\s*<\/button>\s*\{extra\}/)
    })
  })

  // ══════════════════════════════════════════════════════════════
  // F68: 食事一括の階を再読み込みで保つ
  // ══════════════════════════════════════════════════════════════
  describe('★F68 食事一括の階を UI 状態として保存し、既知の値だけ復元する', () => {
    afterEach(() => lsStore.clear())

    it('書いた階を読み戻せる。壊れた値・形の違う値は既定へ倒す（一覧と別のキー）', () => {
      assert.equal(typeof MG.readMealsFloor, 'function', 'readMealsFloor を確かめられない')
      assert.equal(MG.MEALS_FLOOR_KEY, 'cl_mealsGridFloor')
      assert.notEqual(MG.MEALS_FLOOR_KEY, 'cl_sheetFloor', '食事一覧の階（「全」がある）と混ぜない')
      assert.notEqual(MG.MEALS_FLOOR_KEY, 'cl_vitalsFloor')
      assert.equal(MG.readMealsFloor(), null)
      MG.writeMealsFloor('2')
      assert.equal(lsStore.get('cl_mealsGridFloor'), '2')
      assert.equal(MG.readMealsFloor(), '2')
      MG.writeMealsFloor('other')
      assert.equal(MG.readMealsFloor(), 'other')
      for (const bad of ['', '２', '1階', '<x>', 'toolongvalue', '{"a":1}']) {
        lsStore.set('cl_mealsGridFloor', bad)
        assert.equal(MG.readMealsFloor(), null, bad)
      }
    })

    it('静的: 開く時に読み、選んだ時に書き、一覧に無い階は先頭へ倒す（氏名・記録は保存しない）', () => {
      const s = code('pages/MealsGridPage.tsx')
      assert.match(s, /const \[floor, setFloor\] = useState<string>\(\(\) => readMealsFloor\(\) \?\? '1'\)/)
      assert.match(s, /onChange=\{\(v\) => \{\s*setFloor\(v\)\s*writeMealsFloor\(v\)/)
      assert.match(s, /if \(floorOptions\.some\(\(o\) => o\.value === floor\)\) return\s*setFloor\(floorOptions\[0\]\.value\)/)
      assert.equal((s.match(/localStorage\.setItem\(/g) ?? []).length, 1, '階のほかに localStorage へ書いている')
    })
  })

  // ══════════════════════════════════════════════════════════════
  // 持ち場の変更が要らない指摘の見張り（F22・F34・F46）
  // ══════════════════════════════════════════════════════════════
  describe('見張り: F22・F34・F46（4画面に変更は要らない。前提が崩れたら気づけるように）', () => {
    it('F22: 4画面は「入力中」を共通のフック経由でだけ配る（操作が無い・隠した時の取り消しはフックと db.ts が受け持つ）', () => {
      for (const p of PAGES) {
        const s = code(`pages/${p}`)
        assert.match(s, /useCellPresence\(\{ actorId/, p)
        assert.doesNotMatch(s, /\bjoinPresence\(|\bjoinNotePresence\(/, `${p} が Presence に直接参加している`)
      }
    })

    it('F34: 4画面の新しい記録の時刻は共通の規則（前日の列は夜勤明けより前だけ今の時刻＝「翌」・2026-10-10 本人裁定）', () => {
      // 以前は「前日の列は空のまま」を見張っていた。裁定で、夜勤明けに前日の列へ書き足した記録は書いた時刻を入れ、
      // 画面では「翌」を付けて夜の記録の後ろに並べることになった（振る舞いの試験は tests/next-morning-f34.test.mjs）
      const vs = code('pages/VitalsSheetPage.tsx')
      assert.equal((vs.match(/measured_at: recordTimeFor\(rec\.day\)/g) ?? []).length, 2)
      assert.match(code('pages/MealsSheetPage.tsx'), /taken_at: recordTimeFor\(day\),/)
      assert.match(code('pages/VitalsGridPage.tsx'), /return recordTimeFor\(day\)/)
      assert.match(code('pages/MealsGridPage.tsx'), /return recordTimeFor\(day\)/)
    })

    it('F46: 4画面は記録者（actorId）を描くたびに App から受け取り直す（設定タブ・記録者の部品の切替が App から届けばそのまま効く）', () => {
      assert.match(code('pages/VitalsGridPage.tsx'), /const actorId = propActorId !== undefined \? propActorId : getActorId\(\)/)
      assert.match(code('pages/VitalsSheetPage.tsx'), /const actorId = propActorId !== undefined \? propActorId : getActorId\(\)/)
      for (const p of ['MealsGridPage.tsx', 'MealsSheetPage.tsx']) {
        const s = code(`pages/${p}`)
        assert.match(s, /const actorId = actorIdProp !== undefined \? actorIdProp : getActorId\(\)/, p)
        assert.match(s, /useEffect\(\(\) => \{[^}]*actorRef\.current = actorId/, `${p} が記録者を ref へ写し直していない`)
      }
    })
  })
}

// ══════════════════════════════════════════════════════════════
// F01 手直し（2026-10-10 確認役の指摘）: バイタル一括の行の一言（端末に控えを残せなかった時の長い案内など）が表の幅を
// 広げない。表は自動の幅（min-w-max）なので、一言の1行ぶんの幅がまたいでいる氏名の列へ配られ、表が 824→1866px に
// 広がって体温より右の欄が sticky の氏名の欄の下に隠れて押せなかった（390px・1280px で実測）
// ══════════════════════════════════════════════════════════════
describe('★F01 手直し: バイタル一括の一言の行は表の幅の計算に入らない', () => {
  it('静的: 一言の <p> は幅0・最小100% の箱の中にあり、画面の幅で折り返して横スクロールでも左に残る', () => {
    const s = read('pages/VitalsGridPage.tsx')
    const at = s.indexOf('{row.message ? (')
    assert.ok(at > 0)
    const row = s.slice(at, s.indexOf(') : null}', s.indexOf('</tr>', at)))
    assert.match(row, /<td colSpan=\{FIELDS\.length \+ 4\} className="p-0">\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<div className="w-0 min-w-full">\s*<p\s+role="alert"/)
    assert.match(row, /className=\{`sticky left-0 max-w-\[calc\(100vw-2rem\)\] px-2 py-2 \$\{/)
    assert.match(row, /<\/p>\s*<\/div>\s*<\/td>/)
  })
})
