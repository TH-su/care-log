// 日報の起動の早取り（2026-10-29 本人指示「起動の待ち時間を減らす」）の試験。直す前の版（マスタがそろってから各日の枠が
// 日報を取りに行く版）では部品（src/lib/bootBlock.ts）が無く・配線が見つからずに失敗し、直した後に成功する形。
//   1. 順番の部品（bootBlock）を実際に動かす: 参加（SUBSCRIBED）の前に早取りしない・参加した時に1回だけ・参加より先に
//      マスタがそろった／待ち時間が過ぎた時はしない（今までの流れ）・始めてからマスタがそろうまでに帯が出たら捨てる
//   2. 画面の配線: 変更通知の参加の知らせで joined・マスタがそろった時に帯を消す前に masterReady・早取りは loadBlock を通す
//      （各日の枠の loadDay → loadBlock が同じ区切りの取得に相乗りする＝要求は増えない。画面の部品を描かずに相乗りを
//      動かす手段がないため、ここは配線の見張りと、架空データの測定〔要求の本数が前後同一〕で確かめる）
//   3. 日報の取得はマスタの値を使わない（表示する日と記録者だけ）
// db.ts の参加の知らせ（subscribeChanges の onJoined）は tests/sync-core2.test.mjs で偽のチャンネルを動かして確かめる。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）。個人情報は置かない。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

let B = null
let loadError = null
try {
  B = await import('../src/lib/bootBlock.ts')
} catch (e) {
  loadError = e
}
if (B === null) registerLoadFailure('日報の起動の早取りの部品', loadError, 'この Node では TypeScript を読めないため、起動の早取りの検証をスキップしました（Node 22.18 以降で実行してください）。')

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
// コメント（行末の // と、ブロックのコメント）を外した本文
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

/** 手で進める時計 */
function fakeTimer() {
  const jobs = new Map()
  let seq = 0
  return {
    set: (fn, ms) => {
      seq += 1
      jobs.set(seq, { fn, ms })
      return seq
    },
    clear: (id) => jobs.delete(id),
    fire() {
      for (const [id, j] of [...jobs]) {
        jobs.delete(id)
        j.fn()
      }
    },
    pending: () => jobs.size,
    jobs,
  }
}

/** 部品と、呼ばれた回数の控え */
function make(over = {}) {
  const t = fakeTimer()
  const calls = { start: 0, drop: 0 }
  let mark = 0
  const boot = B.createBootBlock({
    start: () => {
      calls.start += 1
      return over.start ? over.start() : true
    },
    staleMark: () => mark,
    drop: () => {
      calls.drop += 1
    },
    timer: t,
  })
  return { boot, t, calls, stale: () => (mark += 1) }
}

if (B !== null) {
  describe('日報の起動の早取り: 順番の部品（参加の後に1回だけ・帯が出たら捨てる）', () => {
    it('参加（SUBSCRIBED）の前には早取りしない。参加した時に1回だけ始める', () => {
      const { boot, t, calls } = make()
      assert.equal(boot.state(), 'waiting')
      assert.equal(calls.start, 0, '参加の前に取りに行った')
      assert.equal(t.jobs.values().next().value.ms, B.BOOT_JOIN_WAIT_MS)
      boot.joined()
      assert.equal(calls.start, 1)
      assert.equal(boot.state(), 'started')
      assert.equal(t.pending(), 0, '待ち時間の時計を止めていない')
      boot.joined()
      assert.equal(calls.start, 1, '2回目の参加でもう一度取りに行った')
    })

    it('参加より先に待ち時間が過ぎた時は、その後に参加しても早取りしない（今までどおり各日の枠が取る）', () => {
      const { boot, t, calls } = make()
      t.fire()
      assert.equal(boot.state(), 'done')
      boot.joined()
      assert.equal(calls.start, 0)
      assert.equal(boot.masterReady(), false)
      assert.equal(calls.drop, 0)
    })

    it('参加より先にマスタがそろった時は、その後に参加しても早取りしない（今までの流れ）', () => {
      const { boot, t, calls } = make()
      assert.equal(boot.masterReady(), false)
      assert.equal(t.pending(), 0)
      boot.joined()
      assert.equal(calls.start, 0)
    })

    it('始めてからマスタがそろうまでに帯が出たら、そろった時に1回だけ捨てる（マスタの失敗と再試行をまたいでも数える）', () => {
      const { boot, calls, stale } = make()
      stale() // 参加の前の帯（早取りの前なので、今までどおりマスタの読み込みが消すだけ）
      boot.joined()
      assert.equal(boot.masterReady(), false, '早取りの前の帯で捨てた')
      assert.equal(calls.drop, 0)

      const b = make()
      b.boot.joined()
      b.stale() // 早取りの後の帯（表示中の日への変更通知など）
      assert.equal(b.boot.masterReady(), true)
      assert.equal(b.calls.drop, 1)
      assert.equal(b.boot.masterReady(), false, '再試行の成功でもう一度捨てた')
      assert.equal(b.calls.drop, 1)
    })

    it('帯が出なければ捨てない。控えに全部あって始めなかった時・始める処理が例外を出した時も捨てない', () => {
      const a = make()
      a.boot.joined()
      assert.equal(a.boot.masterReady(), false)
      assert.equal(a.calls.drop, 0)

      const b = make({ start: () => false })
      b.boot.joined()
      assert.equal(b.boot.state(), 'done')
      b.stale()
      assert.equal(b.boot.masterReady(), false)
      assert.equal(b.calls.drop, 0)

      const c = make({
        start: () => {
          throw new Error('x')
        },
      })
      assert.doesNotThrow(() => c.boot.joined())
      assert.equal(c.boot.state(), 'done')
    })

    it('画面を閉じたら、その後の参加・待ち時間では何もしない', () => {
      const { boot, t, calls } = make()
      boot.stop()
      assert.equal(t.pending(), 0)
      boot.joined()
      t.fire()
      assert.equal(calls.start, 0)
    })
  })
}

describe('日報の起動の早取り: 画面の配線', () => {
  const src = code('src/pages/DailySheetPage.tsx')
  const bootEffect = (() => {
    const a = src.indexOf('const bootRef = useRef<BootBlock | null>(null)')
    assert.ok(a >= 0, '起動の早取りの宣言が無い')
    const b = src.indexOf('const outingIdsRef', a)
    assert.ok(b > a)
    return src.slice(a, b)
  })()
  const masterEffect = (() => {
    const a = src.indexOf('const [rs, st, gate, mgr] = await Promise.all([')
    assert.ok(a >= 0)
    const b = src.indexOf('}, [reload, propResidents, hasPropStaff])', a)
    assert.ok(b > a)
    return src.slice(src.lastIndexOf('useEffect(() => {', a), b)
  })()

  it('早取りは表示する区切りを loadBlock で取り（各日の枠と同じ取得に相乗り）、控えに全部ある時は始めない', () => {
    assert.match(bootEffect, /const boot = createBootBlock\(\{/)
    assert.match(bootEffect, /const days = visibleDaysRef\.current/)
    assert.match(
      bootEffect,
      /if \(days\.every\(\(d\) => cacheRef\.current\.has\(d\) \|\| peekDailyReport\(who, d\) !== undefined\)\) return false/,
    )
    assert.match(bootEffect, /void loadBlockRef\.current\(days\)\.catch\(\(\) => undefined\)\s+return true/)
    assert.match(bootEffect, /staleMark: \(\) => staleMarkRef\.current/)
    assert.match(bootEffect, /drop: \(\) => dropAllCachedRef\.current\(\)/)
    assert.match(bootEffect, /if \(changesJoinedRef\.current\) boot\.joined\(\)/)
    assert.match(bootEffect, /boot\.stop\(\)/)
    // loadBlock・loadDay の中身は変えない（早取りを知らない＝各日の枠の流れのまま）
    const lb = src.slice(src.indexOf('const loadBlock = useCallback('), src.indexOf('const visibleDays = useMemo('))
    assert.doesNotMatch(lb, /bootRef|createBootBlock/)
    // 表示する日を決める ref の後
    assert.ok(src.indexOf('const bootRef') > src.indexOf('visibleDaysRef.current = visibleDays'))
  })

  it('参加の知らせは、この画面の変更通知の購読から渡す（参加の前に取りに行かない）', () => {
    assert.match(
      src,
      /onJoined: \(\) => \{\s+if \(!aliveRef\.current\) return\s+changesJoinedRef\.current = true\s+bootRef\.current\?\.joined\(\)\s+\}/,
    )
    assert.match(src, /changesJoinedRef\.current = false\s+unsub = subscribeChanges\(/)
    // 参加を待たずに早取りする呼び出しが無い（早取りの入口は部品の start だけ）
    assert.equal(src.match(/loadBlockRef\.current\(/g)?.length, 1)
  })

  it('マスタがそろった時は、帯を消す前に masterReady を呼ぶ。帯の set は1か所で数える', () => {
    assert.match(masterEffect, /bootRef\.current\?\.masterReady\(\)\s+setStale\(false\)\s+setPhase\('ready'\)/)
    assert.match(src, /const \[stale, setStaleState\] = useState\(false\)/)
    assert.match(src, /const setStale = useCallback\(\(v: boolean\) => \{\s+if \(v\) staleMarkRef\.current \+= 1\s+setStaleState\(v\)\s+\}, \[\]\)/)
    assert.equal(src.match(/setStaleState\(/g)?.length, 1)
    // 捨て方は〔最新に更新〕と同じ（走っているまとめ取りも使い回さない・世代を進める）
    const drop = src.slice(src.indexOf('const dropAllCached = useCallback('), src.indexOf('const actorSeenRef'))
    assert.match(drop, /inFlightRef\.current\.clear\(\)/)
    assert.match(drop, /cacheGenAllRef\.current \+= 1/)
  })

  it('日報の取得はマスタの値を使わない（表示する日と記録者だけ）・マスタの読み込みの中身は変えない', () => {
    const lb = src.slice(src.indexOf('const loadBlock = useCallback('), src.indexOf('const loadDay = useCallback('))
    for (const v of ['residents', 'staff', 'enabled', 'gateUnknown', 'managerStaffId', 'forbidden', 'cellsMissing', 'notesMissing']) {
      assert.doesNotMatch(lb, new RegExp(`\\b${v}\\b`), `まとめ取りが ${v} を使っている`)
    }
    assert.match(lb, /fetchDailyReports\(want, actorId\)/)
    assert.match(masterEffect, /propResidents \? Promise\.resolve\(propResidents\) : fetchResidentsFromAll\(\)/)
    assert.match(masterEffect, /getNativeInputGate\(\)/)
    assert.match(masterEffect, /catch \{\s+if \(!alive \|\| !aliveRef\.current\) return\s+setPhase\('error'\)\s+\}/)
  })
})
