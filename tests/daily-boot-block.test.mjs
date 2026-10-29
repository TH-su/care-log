// 日報の起動の早取り（2026-10-29 本人指示「起動の待ち時間を減らす」）の配線の見張り。直す前の版（マスタがそろってから各日の枠が
// 日報を取りに行く版）では宣言が見つからずに失敗し、直した後に成功する形。
//   1. 開いた時だけ、表示する区切りの日報をマスタ（利用者・職員・入力解禁・施設長）の読み込みと並べて loadBlock で取りに行く
//      （各日の枠は今までどおり loadDay → loadBlock で相乗りする＝要求は増えない）
//   2. 日報の取得はマスタの値を使わない（表示する日と記録者だけ）
//   3. 読み込みの控えに全部の日がある時は始めない（控えで先に出す流れ・裏の取り直しは各日の枠のまま）
//   4. 始めてからマスタがそろうまでに帯（他の端末で記録が更新されました）が出たら、先に読んだ分を捨てて取り直させる
//      （マスタの読み込みが帯を消すため。以前は日報をその後に取りに行っていたので、新しい内容が出ていた）
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）。個人情報は置かない。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
// コメント（行末の // と、ブロックのコメント）を外した本文
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const src = code('src/pages/DailySheetPage.tsx')
/** 起動の早取りの effect（bootBlockRef の宣言から、次の宣言の手前まで） */
const bootEffect = (() => {
  const a = src.indexOf("const bootBlockRef = useRef<'idle' | 'started' | 'done'>('idle')")
  assert.ok(a >= 0, '起動の早取りの宣言が無い')
  const b = src.indexOf('const outingIdsRef', a)
  assert.ok(b > a)
  return src.slice(a, b)
})()
/** マスタの読み込みの effect（setPhase('loading') から依存の並びまで） */
const masterEffect = (() => {
  const a = src.indexOf('const [rs, st, gate, mgr] = await Promise.all([')
  assert.ok(a >= 0)
  const b = src.indexOf('}, [reload, propResidents, hasPropStaff])', a)
  assert.ok(b > a)
  return src.slice(src.lastIndexOf('useEffect(() => {', a), b)
})()

describe('日報: 起動の早取り（マスタと日報を並べて取る）', () => {
  it('開いた時に1回だけ、表示する区切りを loadBlock で取りに行く（失敗は外へ出さない）', () => {
    assert.match(bootEffect, /if \(bootBlockRef\.current !== 'idle'\) return\s+bootBlockRef\.current = 'done'/)
    assert.match(bootEffect, /const days = visibleDaysRef\.current/)
    assert.match(bootEffect, /void loadBlock\(days\)\.catch\(\(\) => undefined\)/)
    assert.match(bootEffect, /\}, \[actorId, loadBlock\]\)/)
    // 早取りは loadBlock の外に置く（loadBlock・loadDay の中身は変えない＝各日の枠の流れのまま）
    const lb = src.slice(src.indexOf('const loadBlock = useCallback('), src.indexOf('const visibleDays = useMemo('))
    assert.doesNotMatch(lb, /bootBlockRef|bootStaleMarkRef/)
    // 起動の早取りは、表示する日を決める ref の後（各日の枠と同じ区切りを取る）
    assert.ok(src.indexOf('const bootBlockRef') > src.indexOf('visibleDaysRef.current = visibleDays'))
  })

  it('日報の取得はマスタの値を使わない（表示する日と記録者だけ）', () => {
    const lb = src.slice(src.indexOf('const loadBlock = useCallback('), src.indexOf('const loadDay = useCallback('))
    for (const v of ['residents', 'staff', 'enabled', 'gateUnknown', 'managerStaffId', 'forbidden', 'cellsMissing', 'notesMissing']) {
      assert.doesNotMatch(lb, new RegExp(`\\b${v}\\b`), `まとめ取りが ${v} を使っている`)
    }
    assert.match(lb, /fetchDailyReports\(want, actorId\)/)
    assert.match(lb, /\[actorId, beginLoading, cacheGen\]/)
    assert.doesNotMatch(bootEffect, /\b(residents|staff|enabled|gate|managerStaffId)\b/)
  })

  it('読み込みの控えに全部の日がある時は始めない（控えで先に出す流れと裏の取り直しは各日の枠が始める）', () => {
    assert.match(
      bootEffect,
      /if \(days\.every\(\(d\) => cacheRef\.current\.has\(d\) \|\| peekDailyReport\(actorId, d\) !== undefined\)\) return\s+bootBlockRef\.current = 'started'/,
    )
  })

  it('始めてからマスタがそろうまでに帯が出たら、先に読んだ分を捨てる（マスタの読み込みが帯を消す前）', () => {
    // 帯を出すたびにその場で数える（描画の後に写す ref では取りこぼす）
    assert.match(src, /const \[stale, setStaleState\] = useState\(false\)/)
    assert.match(src, /const setStale = useCallback\(\(v: boolean\) => \{\s+if \(v\) staleMarkRef\.current \+= 1\s+setStaleState\(v\)\s+\}, \[\]\)/)
    // setStaleState を直接呼ぶのは包みの中だけ（帯を出す所は全部数える）
    assert.equal(src.match(/setStaleState\(/g)?.length, 1)
    assert.match(bootEffect, /bootBlockRef\.current = 'started'\s+bootStaleMarkRef\.current = staleMarkRef\.current/)
    const guard = masterEffect.indexOf("if (bootBlockRef.current === 'started') {")
    const clear = masterEffect.indexOf('setStale(false)')
    assert.ok(guard > 0 && clear > guard, '帯を消す前に確かめていない')
    assert.match(
      masterEffect,
      /if \(bootBlockRef\.current === 'started'\) \{\s+if \(staleMarkRef\.current !== bootStaleMarkRef\.current\) dropAllCachedRef\.current\(\)\s+bootBlockRef\.current = 'done'\s+\}\s+setStale\(false\)\s+setPhase\('ready'\)/,
    )
    // 捨て方は〔最新に更新〕と同じ（走っているまとめ取りも使い回さない・世代を進める）
    assert.match(src, /dropAllCachedRef\.current = dropAllCached/)
    const drop = src.slice(src.indexOf('const dropAllCached = useCallback('), src.indexOf('const actorSeenRef'))
    assert.match(drop, /inFlightRef\.current\.clear\(\)/)
    assert.match(drop, /cacheGenAllRef\.current \+= 1/)
  })

  it('マスタの読み込みの中身・失敗の表示は変えない', () => {
    assert.match(masterEffect, /propResidents \? Promise\.resolve\(propResidents\) : fetchResidentsFromAll\(\)/)
    assert.match(masterEffect, /given \? Promise\.resolve\(given\) : fetchStaff\(\)/)
    assert.match(masterEffect, /getNativeInputGate\(\)/)
    assert.match(masterEffect, /getAppSetting\('manager_staff_id'\)\.catch\(\(\) => null\)/)
    assert.match(masterEffect, /catch \{\s+if \(!alive \|\| !aliveRef\.current\) return\s+setPhase\('error'\)\s+\}/)
  })
})
