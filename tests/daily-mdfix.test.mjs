// 日報・申し送りフォームの回帰テスト（2026-10-10 多端末運用の監査 画面担当: F15・F18・F34・F35・F63・F64・F65・F66・
// F10・F21・F30・F42・F47・F48 と、中核からの依頼 F14・F16・F26・F61）。直す前の版では赤、直した後で緑になる形。
// 純関数は画面のソースから宣言を抜き出し、型を剥がして評価する（画面の部品は描かない）。配線は正規表現で確かめる。
// 実行: node --experimental-strip-types --test tests/daily-mdfix.test.mjs（直す前の版は CL_DAILY_MDFIX_SRC に src の場所を渡す）
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'

const SRC = process.env.CL_DAILY_MDFIX_SRC
  ? pathToFileURL(`${process.env.CL_DAILY_MDFIX_SRC.replace(/\/$/, '')}/`).href
  : new URL('../src/', import.meta.url).href
const read = (p) => readFileSync(new URL(p, SRC), 'utf8')
const DOCS = new URL('../docs/design/', import.meta.url).href
const readDoc = (p) => readFileSync(new URL(p, DOCS), 'utf8')

const daily = read('pages/DailySheetPage.tsx')
const form = read('pages/NoteFormPage.tsx')

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

/** 宣言を抜き出して型を剥がし、名前の付いたもの（function・const・let）を返す。deps は外から渡す名前 */
function evalDecls(src, heads, deps = {}) {
  const code = heads.map((h) => declSrc(src, h)).join('\n')
  const js = stripTypeScriptTypes(code)
  const names = heads
    .map((h) => /^(?:function|const|let)\s+([A-Za-z0-9_]+)/.exec(h)?.[1])
    .filter((n) => n !== undefined)
  return new Function(...Object.keys(deps), `${js}\nreturn { ${names.join(', ')} }`)(...Object.values(deps))
}

/** 関数の本体（宣言の始まりから、次のトップレベルの宣言まで） */
const fnBody = (src, name) => declSrc(src, `function ${name}(`)

/** DailySheetPage の useCallback で定義した関数の本体（`const name = useCallback(` から次の `  const ` まで） */
function cbSrc(src, name) {
  const at = src.indexOf(`const ${name} = useCallback(`)
  assert.ok(at >= 0, `${name} が見つからない`)
  const end = src.indexOf('\n  const ', at + 10)
  return src.slice(at, end < 0 ? undefined : end)
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 合成の外出・外泊の行（利用者01 相当の id だけ・氏名は持たない） */
const outing = (id, start, end, rev = 1) => ({
  id,
  resident_id: 1,
  kind: 'overnight',
  start_on: start,
  start_at: null,
  end_on: end,
  end_at: null,
  companion: null,
  note: null,
  recorded_by: null,
  rev,
})

/** 試験用の localStorage（キーの並びも本物と同じく key(i) で引ける） */
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return {
    get length() {
      return m.size
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    has: (k) => m.has(k),
    raw: (k) => m.get(k),
  }
}

// ══════════════════════════════════════════════════════════════
describe('★F15 日報の取り置き: 表示していない日の変更でも捨て、〔最新に更新〕へたどり着けるようにする', () => {
  const { cachedDaysHit } = evalDecls(daily, ['const DAY_COLUMNS', 'function cachedDaysHit('])
  const days = ['2026-10-10', '2026-10-11', '2026-10-12']

  it('申し送り・バイタル・出勤者の通知は、その日付の取り置きだけを当てる', () => {
    assert.deepEqual(cachedDaysHit('notes', { note_on: '2026-10-12' }, days), ['2026-10-12'])
    assert.deepEqual(cachedDaysHit('vitals', { measured_on: '2026-10-11' }, days), ['2026-10-11'])
    assert.deepEqual(cachedDaysHit('attendance', { day: '2026-09-30' }, days), [])
  })
  it('外出・外泊は始まった日以降の取り置きを全部当てる（帰着を早めた時の、前の帰着日までの写しも捨てる）', () => {
    assert.deepEqual(cachedDaysHit('outings', { start_on: '2026-10-11', end_on: '2026-10-11' }, days), [
      '2026-10-11',
      '2026-10-12',
    ])
  })
  it('行が無い（DELETE・RESYNC）・日付列が読めない時は null＝表示外の取り置きを全部捨てる側', () => {
    assert.equal(cachedDaysHit('notes', null, days), null)
    assert.equal(cachedDaysHit('notes', { id: 1 }, days), null)
    assert.equal(cachedDaysHit('outings', { id: 1 }, days), null)
  })
  it('購読: 自分の書込を除いた後、表示外の当たった日の取り置きを捨てる（案内は表示中の日だけ）', () => {
    const sub = daily.slice(daily.indexOf('unsub = subscribeChanges('), daily.indexOf('let hiddenAt = 0'))
    const self = sub.indexOf('if (isSelfWrite(table, info?.row)) return')
    const drop = sub.indexOf('dropHiddenCached(cachedDaysHit(table, info?.row, knownDays()))')
    const visible = sub.indexOf('touchesVisibleDay(table, info, visibleDaysRef.current)')
    assert.ok(self > 0 && drop > self && visible > drop, '取り置きを捨てる処理が無い・順番が違う')
    // 画面復帰・電波復帰でも表示外の取り置きを捨てる（離れていた間の通知は落ちている）
    assert.equal((daily.match(/dropHiddenCached\(null\)/g) ?? []).length, 2)
  })
  it('★手直し: 取りに行っている最中の日（まだ取り置きに無い日）に当たった通知でも世代を進める（遅い古い応答を入れない）', () => {
    // 点検の場面D: D-2 の応答待ちの間に D-3 へ移り、他の端末が D-2 へ書いた通知が来ても、D-2 は取り置きに無いので
    // 世代が進まず、通知より前の内容を読んだ応答がそのまま取り置きに入った（戻ると案内なしで古い内容）
    const known = cbSrc(daily, 'knownDays')
    assert.match(known, /cacheRef\.current\.keys\(\)/)
    assert.match(known, /loadingDaysRef\.current\.keys\(\)/)
    const lb = cbSrc(daily, 'loadBlock')
    const begin = lb.indexOf('const endLoading = beginLoading(want)')
    assert.ok(begin > 0 && begin < lb.indexOf('fetchDailyReports(want'), 'まとめ取りが取得中の日を数えていない')
    assert.match(lb, /finally \{\s+endLoading\(\)/)
    const ld = cbSrc(daily, 'loadDay')
    const b1 = ld.indexOf('const endLoading = beginLoading([dayIso])')
    assert.ok(b1 > 0 && b1 < ld.indexOf('fetchDailyReport(dayIso'), '1日の取り直しが取得中の日を数えていない')
    assert.match(ld, /finally \{\s+endLoading\(\)/)
    // 判定できない時（画面復帰・電波復帰・つながり直し）も、取得中の日まで含める
    assert.match(cbSrc(daily, 'dropHiddenCached'), /const days = hit \?\? knownDays\(\)/)
  })
  it('取り置きの世代: 取りに行った後に捨てられた日の応答は入れない・古い取得が新しい取得の登録を消さない', () => {
    const lb = cbSrc(daily, 'loadBlock')
    assert.match(lb, /const gens = new Map\(want\.map\(\(d\) => \[d, cacheGen\(d\)\]\)\)/)
    assert.match(lb, /if \(report && cacheGen\(d\) === gens\.get\(d\)\) cache\.set\(d, report\)/)
    assert.match(lb, /if \(inFlightRef\.current\.get\(key\) === p\) inFlightRef\.current\.delete\(key\)/)
    assert.match(cbSrc(daily, 'loadDay'), /if \(cacheGen\(dayIso\) === gen\) cacheRef\.current\.set\(dayIso, report\)/)
    // 〔最新に更新〕は走っているまとめ取りも使い回さない
    assert.match(cbSrc(daily, 'dropAllCached'), /inFlightRef\.current\.clear\(\)\s*\n\s*cacheGenAllRef\.current \+= 1/)
  })
  it('〔最新に更新〕〔再試行〕は取り置きを全部捨ててから取り直す（同じ処理を通す）', () => {
    assert.match(cbSrc(daily, 'refreshAll'), /dropAllCached\(\)\s*\n\s*setStale\(false\)\s*\n\s*setReload/)
    // stale の帯・入力可否が分からない時の帯・失敗の帯の3か所
    assert.equal((daily.match(/onClick=\{refreshAll\}/g) ?? []).length, 3)
    assert.doesNotMatch(daily, /cacheRef\.current\.clear\(\)\s*\n\s*setStale\(false\)/, '取り置きだけを消す古い処理が残っている')
  })
  it('入力できるかどうかを確かめられない時の帯にも〔最新に更新〕を置く（文言が案内するボタンを画面に出す）', () => {
    const band = daily.slice(daily.indexOf('{gateUnknown && !forbidden && ('), daily.indexOf('{!enabled && !gateUnknown && !forbidden && ('))
    assert.match(band, /\{GATE_UNKNOWN_REASON\}/)
    assert.match(band, /onClick=\{refreshAll\}[\s\S]*最新に更新/)
  })
  it('競合（ERR_CONFLICT）を出す4か所すべてで、親の「最新に更新」の帯を出す（onStale）', () => {
    // 一言を出す所（行の一言 text: ／トースト show(）だけを数える
    const shown = /(?:text: |show\()`▲ \$\{ERR_CONFLICT\}`/g
    for (const m of daily.matchAll(shown)) {
      const near = daily.slice(m.index, m.index + 400)
      assert.match(near, /onStale\(\)/, `ERR_CONFLICT の後に onStale が無い: ${near.slice(0, 80)}`)
    }
    assert.equal((daily.match(shown) ?? []).length, 4)
    // 読み直した後は「最新に更新を押して」の一言を外す（押した後も同じ案内を出し続けない）
    assert.match(daily, /if \(st\?\.text === `▲ \$\{ERR_CONFLICT\}`\) delete next\[k\]/)
    assert.match(daily, /onStale=\{handleStale\}/)
  })
})

// ══════════════════════════════════════════════════════════════
describe('★F10 外出の帰着・削除が他の端末と競り負けた時、〔最新に更新〕の帯を出す', () => {
  it('commitOutingEnd・deleteOutingRow の conflict の分岐で onStale を呼ぶ', () => {
    for (const name of ['commitOutingEnd', 'deleteOutingRow']) {
      const body = cbSrc(daily, name)
      assert.match(body, /if \(res === 'conflict'\) \{[\s\S]{0,300}?onStale\(\)[\s\S]{0,40}?return/, name)
    }
  })
})

// ══════════════════════════════════════════════════════════════
describe('★F63 区切りを移った時もまとめ取りが効く（1日ずつ10回取りに行かない）', () => {
  it('表示中の日（visibleDaysRef）は useLayoutEffect で書く＝子の読み込みより先に新しい区切りになる', () => {
    assert.match(daily, /useLayoutEffect\(\(\) => \{\s*\n\s*visibleDaysRef\.current = visibleDays\s*\n\s*\}, \[visibleDays\]\)/)
    assert.doesNotMatch(daily, /useEffect\(\(\) => \{\s*\n\s*visibleDaysRef\.current = visibleDays/)
  })
  it('まとめ取りが失敗しても、区切り全部を「読み込めません」にせず1日ずつ取り直す', () => {
    assert.match(cbSrc(daily, 'loadDay'), /try \{\s*\n\s*await loadBlock\([\s\S]*?\} catch \{/)
  })
})

// ══════════════════════════════════════════════════════════════
describe('★F65 複数日にまたがる外泊の登録・帰着・削除を、同じ画面の他の日へ配る', () => {
  const { outingOnDay, applyOutingChange, outingChangeFrom, createOutingBus } = evalDecls(daily, [
    'function outingOnDay(',
    'interface OutingChange',
    'function applyOutingChange(',
    'function outingChangeFrom(',
    'interface OutingBus',
    'function createOutingBus(',
  ])

  it('outingOnDay は日報の取得と同じ条件（start ≦ 日 かつ 帰着未定か 帰着 ≧ 日）', () => {
    assert.equal(outingOnDay('2026-10-05', '2026-10-07', '2026-10-06'), true)
    assert.equal(outingOnDay('2026-10-05', '2026-10-07', '2026-10-08'), false)
    assert.equal(outingOnDay('2026-10-05', null, '2026-10-30'), true)
    assert.equal(outingOnDay('2026-10-05', null, '2026-10-04'), false)
  })
  it('登録: 期間に入る日の一覧へ足し、入らない日は同じ配列のまま（描き直さない）', () => {
    const row = outing(10, '2026-10-05', '2026-10-07')
    assert.deepEqual(applyOutingChange([], { before: null, after: row }, '2026-10-06').map((o) => o.id), [10])
    const other = [outing(11, '2026-10-08', '2026-10-08')]
    assert.equal(applyOutingChange(other, { before: null, after: row }, '2026-10-08'), other)
  })
  it('帰着を早めた: 新しい帰着より後の日から外す／延ばした: 足す／同じ日では新しい版へ差し替える（並び順は保つ）', () => {
    const before = outing(20, '2026-10-05', '2026-10-08', 1)
    const shorter = outing(20, '2026-10-05', '2026-10-06', 2)
    const list = [outing(1, '2026-10-01', null), before, outing(3, '2026-10-02', null)]
    assert.deepEqual(applyOutingChange(list, { before, after: shorter }, '2026-10-07').map((o) => o.id), [1, 3])
    const kept = applyOutingChange(list, { before, after: shorter }, '2026-10-06')
    assert.deepEqual(kept.map((o) => [o.id, o.rev]), [[1, 1], [20, 2], [3, 1]])
    const longer = outing(20, '2026-10-05', '2026-10-10', 3)
    assert.deepEqual(applyOutingChange([], { before: shorter, after: longer }, '2026-10-09').map((o) => o.rev), [3])
  })
  it('削除: 一覧から外す。取り置きは変更前と変更後の始まった日の早い方から捨てる', () => {
    const row = outing(30, '2026-10-05', null)
    assert.deepEqual(applyOutingChange([row], { before: row, after: null }, '2026-10-09'), [])
    assert.equal(outingChangeFrom({ before: row, after: null }), '2026-10-05')
    assert.equal(outingChangeFrom({ before: outing(1, '2026-10-04', null), after: outing(1, '2026-10-06', null) }), '2026-10-04')
  })
  it('配る口: 受け取った日の枠すべてへ配り、外した枠には配らない', () => {
    const bus = createOutingBus()
    const got = []
    const offA = bus.subscribe((c) => got.push(['A', c.after?.id]))
    bus.subscribe((c) => got.push(['B', c.after?.id]))
    bus.emit({ before: null, after: outing(5, '2026-10-01', null) })
    offA()
    bus.emit({ before: null, after: outing(6, '2026-10-01', null) })
    assert.deepEqual(got, [['A', 5], ['B', 5], ['B', 6]])
  })
  it('配線: 登録・帰着（送信待ちの楽観値を含む）・削除で親へ伝え、各日の枠が受け取って当てる', () => {
    assert.match(cbSrc(daily, 'saveOutingDraft'), /onOutingChanged\(\{ before: null, after: res \}\)/)
    const end = cbSrc(daily, 'commitOutingEnd')
    assert.match(end, /onOutingChanged\(\{ before: o, after: shown \}\)/)
    assert.match(end, /onOutingChanged\(\{ before: o, after: res \}\)/)
    assert.match(cbSrc(daily, 'deleteOutingRow'), /onOutingChanged\(\{ before: o, after: null \}\)/)
    assert.match(daily, /outingBus\.subscribe\(\(change\) => setOutings\(\(cur\) => applyOutingChange\(cur, change, day\)\)\)/)
    const parent = cbSrc(daily, 'handleOutingChanged')
    assert.match(parent, /if \(d >= from\) dropCachedDay\(d\)/)
    assert.match(parent, /outingBusRef\.current\.emit\(change\)/)
  })
})

// ══════════════════════════════════════════════════════════════
describe('依頼 F16・F14 他の端末の外出の変更・取り直しの合図', () => {
  it('F16: 表示中の枠に出ている外出・外泊の行が直されたら、日付に関係なく案内する', () => {
    assert.match(daily, /onOutingIds=\{handleOutingIds\}/)
    assert.match(daily, /\[\.\.\.outingIdsRef\.current\.values\(\)\]\.some\(\(ids\) => ids\.includes\(rowId\)\)/)
  })
  it('F14: 画面に戻った・電波が戻った取り直しの合図は自前の処理に任せ、つながり直し（reconnect）だけ受ける', () => {
    assert.match(daily, /if \(info\?\.event === 'RESYNC' && info\.resync !== undefined && info\.resync !== 'reconnect'\) return/)
  })
})

// ══════════════════════════════════════════════════════════════
describe('★F18 日付をまたいで開いたままの画面', () => {
  it('日報: 1分ごとと画面に戻った時に今日を見直し、今日の枠が表示に無ければ帯と〔今日を開く〕を出す（自動で切り替えない）', () => {
    assert.match(daily, /window\.setInterval\(check, 60_000\)/)
    assert.match(daily, /const dayRolled = today !== ackToday && !visibleDays\.includes\(today\)/)
    const band = daily.slice(daily.indexOf('{dayRolled && ('), daily.indexOf('{forbidden && ('))
    assert.match(band, /print:hidden/, '帯が紙に出る')
    assert.match(band, /onClick=\{\(\) => goDay\(today\)\}/)
    assert.match(band, /今日を開く/)
    // 日付・表示を選び直したら帯を閉じる（過去の日を見に行った時に出し続けない）
    assert.equal((daily.match(/setAckToday\(todayIso\(\)\)/g) ?? []).length, 2)
    // 日付は自動で動かさない（setDay は goDay の中だけ）
    assert.equal((daily.match(/setDay\(/g) ?? []).length, 1)
  })
  it('申し送りフォーム: 入力中でなければ記録日を今日へ切り替え、入力中なら帯で知らせる', () => {
    assert.match(form, /if \(!f\.targetPicked && f\.body\.trim\(\) === ''\) \{\s*\n\s*setForm\(\(cur\) => \(cur\.noteOn === was \? \{ \.\.\.cur, noteOn: today, shift: autoShift\(new Date\(\)\) \} : cur\)\)/)
    assert.match(form, /setDayRolled\(true\)/)
    assert.match(form, /window\.setInterval\(check, 60_000\)/)
    assert.match(form, /\{dayRolled && form\.noteOn !== todayIso\(\) && \(/)
    assert.match(form, /記録日を今日にする/)
  })
})

// ══════════════════════════════════════════════════════════════
describe('★F34 前日の夜勤の欄に夜勤明けより前に書いた時も時刻を残す（帰属は暦の日付のまま・画面では「翌」）', () => {
  // 2026-10-10 本人裁定で、日報とフォームの規則は src/lib/nextMorning.ts の noteTimeFor 1か所にまとめた
  // （バイタル・水分と同じ規則。「翌」の表示・並びの試験は tests/next-morning-f34.test.mjs）
  const at = (h, m = 0) => new Date(2026, 7, 28, h, m) // 端末の現地時刻 2026-08-28
  it('日報・フォーム共通: 今日は今の時刻・前日の夜勤は 0:00〜8:59 だけ今の時刻・それ以外の過去日は空', async () => {
    const { noteTimeFor: fn } = await import(new URL('lib/nextMorning.ts', SRC).href)
    assert.equal(fn('2026-08-28', 'night', at(2)), '02:00')
    assert.equal(fn('2026-08-28', 'day', at(23, 59)), '23:59')
    assert.equal(fn('2026-08-27', 'night', at(0, 0)), '00:00')
    assert.equal(fn('2026-08-27', 'night', at(8, 59)), '08:59')
    assert.equal(fn('2026-08-27', 'night', at(9, 0)), null)
    assert.equal(fn('2026-08-27', 'day', at(2)), null)
    assert.equal(fn('2026-08-27', 'daycare', at(2)), null)
    assert.equal(fn('2026-08-26', 'night', at(2)), null)
    // 月をまたぐ日
    assert.equal(fn('2026-08-31', 'night', new Date(2026, 8, 1, 1, 30)), '01:30')
  })
  it('配線: 日報の登録・フォームの登録が同じ関数で時刻を決める（記録日が今日の時だけの式・規則の写しは残っていない）', () => {
    assert.match(daily, /occurred_at: noteTimeFor\(day, draft\.shift, new Date\(\)\)/)
    assert.doesNotMatch(daily, /occurred_at: day === todayIso\(\) \? nowHM\(\) : null/)
    assert.match(form, /const occurredAt = noteTimeFor\(form\.noteOn, form\.shift, now\)/)
    assert.match(form, /occurred_at: occurredAt,/)
    for (const s of [daily, form]) assert.doesNotMatch(s, /function noteOccurredAt\(/)
  })
  it('並び: 日報の申し送りは「翌」をその日の夜の記録の後ろに置く（時刻なしは従来どおり先頭）', () => {
    const at0 = daily.indexOf('const safeNotes = Array.isArray(report?.notes)')
    assert.ok(at0 > 0)
    const sortSrc = daily.slice(at0, daily.indexOf('pendingNotesRef.current = pendingNoteRows()', at0))
    assert.match(sortSrc, /\(timeSortKey\(a\.occurred_at, noteIsNextMorning\(a\)\) \?\? ''\)\.localeCompare\(/)
    assert.match(sortSrc, /timeSortKey\(b\.occurred_at, noteIsNextMorning\(b\)\) \?\? ''/)
  })
})

// ══════════════════════════════════════════════════════════════
describe('★F35 申し送りフォームの 16時以降の日勤の申し送りは、日報の「↓16時以降」の欄に載せる', () => {
  const { noteAfter16 } = evalDecls(form, ['const AFTER16_FROM', 'function noteAfter16('])
  it('日勤で 16:00 以降なら 16時以降の欄・15:59 までと夜勤・デイ・時刻なし（過去日）は今までどおり', () => {
    assert.equal(noteAfter16('day', '16:00'), true)
    assert.equal(noteAfter16('day', '16:30'), true)
    assert.equal(noteAfter16('day', '15:59'), false)
    assert.equal(noteAfter16('night', '17:00'), false)
    assert.equal(noteAfter16('daycare', '16:30'), false)
    assert.equal(noteAfter16('day', null), false)
  })
  it('配線: フォームの登録が after16 を固定の false で送らない', () => {
    assert.match(form, /after16: noteAfter16\(form\.shift, occurredAt\),/)
    assert.doesNotMatch(form, /after16: false,/)
  })
})

// ══════════════════════════════════════════════════════════════
describe('★F64 他の端末の欄の移動・トーストのたびに10日ぶん全部を描き直さない', () => {
  it('1日ぶんの枠は memo で包み、親はその日の中身が変わった時だけ Presence と「書いている他の端末」を作り直す', () => {
    assert.match(daily, /const DaySheetMemo = memo\(DaySheet\)/)
    assert.match(daily, /<DaySheetMemo\b/)
    assert.doesNotMatch(daily, /<DaySheet\b/)
    assert.match(daily, /presence=\{presenceForDay\(d\)\}/)
    assert.match(daily, /othersHere=\{othersForDay\(d\)\}/)
    // 毎回 filter した新しい配列を渡していた形が残っていない
    assert.doesNotMatch(daily, /othersHere=\{othersHere\.filter\(/)
    // その日のバイタルの欄の要素（時刻 at を除く）で比べる
    const pf = daily.slice(daily.indexOf('const presenceForDay = '), daily.indexOf('const dayOthersRef'))
    assert.match(pf, /p\.day === d && p\.cell !== undefined && p\.cell\.table === 'vitals'/)
    assert.match(pf, /\.map\(\(\{ at: _at, \.\.\.rest \}\) => rest\)/)
    assert.match(pf, /hit\.names === nameStaff && hit\.actor === actorId/)
  })
  it('枠へ渡す関数はすべて固定（useCallback・ref）＝描き直しのたびに新しい関数を渡さない', () => {
    const jsx = daily.slice(daily.indexOf('<DaySheetMemo'), daily.indexOf('/>', daily.indexOf('<DaySheetMemo')))
    for (const [prop, val] of [
      ['loadDay', 'loadDay'],
      ['onWrite', 'handleWrite'],
      ['onDirty', 'handleDirty'],
      ['onComposing', 'handleComposing'],
      ['onStale', 'handleStale'],
      ['onOutingChanged', 'handleOutingChanged'],
      ['onOutingIds', 'handleOutingIds'],
      ['onLoaded', 'handleLoaded'],
    ]) {
      assert.match(jsx, new RegExp(`${prop}=\\{${val}\\}`), prop)
      assert.match(daily, new RegExp(`const ${val} = useCallback\\(`), `${val} が useCallback でない`)
    }
    assert.match(jsx, /outingBus=\{outingBusRef\.current\}/)
    assert.doesNotMatch(jsx, /=\{\(\) =>/, '枠へ毎回作る関数を渡している')
  })
})

// ══════════════════════════════════════════════════════════════
describe('★F66 既読の人数を確かめられない申し送りに「既読 0人」と出さない', () => {
  it('人数は数として読めた時だけ出す（行の読み上げ名と詳細の窓の両方）', () => {
    assert.doesNotMatch(daily, /read_count \?\? 0/)
    assert.equal((daily.match(/typeof note\?\.read_count === 'number' \? note\.read_count : null/g) ?? []).length, 2)
    assert.match(daily, /既読の人数は確認できません/)
  })
  it('自分が読んだか分からない時（記録者は選んでいる）は〔既読にする〕を出さない・押した後も分からない人数を作らない', () => {
    assert.match(daily, /note\.my_read === undefined && actorId != null \? \(/)
    assert.match(
      cbSrc(daily, 'markNoteRead'),
      /typeof note\.read_count === 'number' \? \{ my_read: true, read_count: note\.read_count \+ 1 \} : \{ my_read: true \}/,
    )
  })
  it('行の列（✓N／…）の形は変えない（紙にも出る列）', () => {
    assert.match(daily, /\{note && readCount !== null && readCount > 0 \? <span className="tabular"> ✓\{readCount\}<\/span> : null\}/)
  })
})

// ══════════════════════════════════════════════════════════════
describe('★F21 「書いています」は、この起動中に手を入れた書きかけの間だけ配る', () => {
  it('日報: 手を入れた時刻をメモリに持ち（控えには書かない）、liveComposing で決める。最後に手を入れた日を配る', () => {
    assert.match(daily, /const liveNote = useMemo\(\s*\n\s*\(\) => liveComposing\(noteDrafts, touchedRef\.current, Date\.now\(\)\)/)
    assert.match(daily, /return latestComposing\(composingRef\.current\)/)
    // 対象・記入者・色・本文の確定（patchNoteDraft）と本文の打鍵（行の onInput）で印を付ける
    assert.match(cbSrc(daily, 'patchNoteDraft'), /touchNoteRow\(key\)/)
    assert.match(daily, /onInput=\{draft !== null && !draft\.locked && onTouch !== undefined \? \(\) => onTouch\(rowKey\) : undefined\}/)
    assert.equal((daily.match(/onTouch=\{touchNoteRow\}/g) ?? []).length, 4)
    // 3分の経過で見直す
    assert.match(daily, /latest \+ PRESENCE_IDLE_MS - Date\.now\(\)/)
    // 控えから戻す（restoreDrafts）・送信待ちの登録の行（syncRegistrationRows）は印を付けない
    assert.doesNotMatch(cbSrc(daily, 'restoreDrafts'), /touchNoteRow/)
    // 書いていない時は null を親へ
    assert.match(daily, /onComposing\(day, liveAt === null \? null : \{ residentId: liveResidentId, at: liveAt \}\)/)
  })
  it('申し送りフォーム: 戻した書きかけだけでは配らない（本文を打った・定型句を入れた・対象を選んだ後だけ）', () => {
    assert.match(form, /const composing = touched && \(form\.targetPicked \|\| form\.body\.trim\(\) !== ''\)/)
    assert.equal((form.match(/setTouched\(true\)/g) ?? []).length, 3)
  })
})

// ══════════════════════════════════════════════════════════════
describe('依頼 F26 同じ職員の別の端末は「あなたの別の端末」と出す', () => {
  it('日報の「書いています」と申し送りフォームの両方で、受け手の職員を渡す', () => {
    assert.match(daily, /presenceWhoNames\(othersHere, \(id\) => staffName\(ctx\.staffById\.get\(id\), id\), undefined, actorId\)/)
    assert.match(form, /presenceWhoNames\(list, \(id\) => staffById\.get\(id\)\?\.name \?\? null, null, form\.reporterId\)/)
  })
})

// ══════════════════════════════════════════════════════════════
describe('★F30 書きかけの控え: 別の版の控えを消さず、上書きもしない', async () => {
  const ND = await import(new URL('../src/lib/noteDrafts.ts', import.meta.url).href)
  const LS = { dailyDraft: 'cl_dailyDraft', draftNote: 'cl_draftNote' }

  it('日報: 画面を開いた時の掃除は、壊れた控えだけを消す（別の版 v:2 は残す）', () => {
    const store = fakeStorage({
      'cl_dailyDraft:2026-10-06': JSON.stringify({ v: 2, tabs: {}, future: true }),
      'cl_dailyDraft:2026-10-05': '{壊れた',
      'cl_dailyDraft:2026-10-04': JSON.stringify({ v: 1, savedAt: 1, notes: [] }),
      'cl_dailyDraft:2026-10-03': JSON.stringify({ notes: [] }),
      cl_other: 'x',
    })
    const { sweepDailyDrafts } = evalDecls(
      daily,
      ['const DAILY_DRAFT_VERSION', 'function asRecord(', 'function draftFileKind(', 'function sweepDailyDrafts('],
      { LS, window: { localStorage: store } },
    )
    sweepDailyDrafts()
    assert.equal(store.has('cl_dailyDraft:2026-10-06'), true, '別の版の控えを消した')
    assert.equal(store.has('cl_dailyDraft:2026-10-04'), true)
    assert.equal(store.has('cl_dailyDraft:2026-10-05'), false)
    assert.equal(store.has('cl_dailyDraft:2026-10-03'), false)
    assert.equal(store.has('cl_other'), true)
  })

  it('日報: 別の版の控えは読み飛ばし（消さない）、その日の控えへは書かない（入力は画面に残る）', () => {
    const raw = JSON.stringify({ v: 2, tabs: { t1: { at: 1, rows: [{ did: 'x', kind: 'note', data: { body: '新しい版の書きかけ' } }] } } })
    const store = fakeStorage({ 'cl_dailyDraft:2026-10-06': raw })
    const fns = evalDecls(
      daily,
      [
        'const DAILY_DRAFT_VERSION',
        'function dailyDraftKey(',
        'function removeDailyDraft(',
        'function asRecord(',
        'const foreignDailyDays',
        'function draftFileKind(',
        'function readDailyFile(',
        'function writeDailyFile(',
      ],
      {
        LS,
        window: { localStorage: store },
        parseDraftFile: ND.parseDraftFile,
        unionDraftRows: ND.unionDraftRows,
        readDailyData: () => null,
        legacyDailyRows: () => [],
      },
    )
    assert.equal(fns.readDailyFile('2026-10-06'), null)
    assert.equal(store.raw('cl_dailyDraft:2026-10-06'), raw, '読んだだけで消えた')
    const mine = { tabs: { me: { at: 2, rows: [{ did: 'm', at: 2, kind: 'note', data: { body: 'この版の入力' } }] } }, gone: {} }
    assert.equal(fns.writeDailyFile('2026-10-06', mine, 3), false)
    assert.equal(store.raw('cl_dailyDraft:2026-10-06'), raw, '別の版の控えを上書きした')
    // 別の版の控えが無くなった日は、また書ける
    store.removeItem('cl_dailyDraft:2026-10-06')
    assert.equal(fns.readDailyFile('2026-10-06'), null)
    assert.equal(fns.writeDailyFile('2026-10-06', mine, 3), true)
  })

  it('申し送りフォーム: 別の版の控えは消さず、書き込み（保存・破棄）もしない', () => {
    const raw = JSON.stringify({ v: 2, tabs: {}, gone: {} })
    const store = fakeStorage({ cl_draftNote: raw })
    const fns = evalDecls(
      form,
      ['const DRAFT_VERSION', 'let draftForeign', 'function readDraftFile(', 'function writeDraftFile('],
      {
        LS,
        window: { localStorage: store },
        parseDraftFile: ND.parseDraftFile,
        writeTabRows: ND.writeTabRows,
        unionDraftRows: ND.unionDraftRows,
        markDraftsGone: ND.markDraftsGone,
        goneMarksFor: ND.goneMarksFor,
        DRAFT_TAB_ID: ND.DRAFT_TAB_ID,
        readForm: () => null,
        legacyForm: () => [],
      },
    )
    assert.equal(fns.readDraftFile(), null)
    assert.equal(store.raw('cl_draftNote'), raw, '読んだだけで消えた')
    fns.writeDraftFile([{ did: 'a', at: 1, kind: 'form', data: { body: 'この版の入力' } }])
    assert.equal(store.raw('cl_draftNote'), raw, '別の版の控えを上書きした')
    fns.writeDraftFile([])
    assert.equal(store.raw('cl_draftNote'), raw, '別の版の控えを消した')
    // 壊れた JSON は従来どおり消す
    store.setItem('cl_draftNote', '{壊れた')
    assert.equal(fns.readDraftFile(), null)
    assert.equal(store.has('cl_draftNote'), false)
  })
})

// ══════════════════════════════════════════════════════════════
describe('★F48 退職者・退居者の名前は在籍を問わない名簿で引く（選ぶ候補は在籍者のまま）', () => {
  const { mergeById } = evalDecls(daily, ['function mergeById<'])
  it('全員の一覧に在籍者の一覧を重ねる（全員を読めない間は在籍者だけ）', () => {
    const all = [{ id: 1, name: '職員01（旧）' }, { id: 5, name: '職員05' }]
    const active = [{ id: 1, name: '職員01' }, { id: 2, name: '職員02' }]
    const merged = mergeById(all, active)
    assert.deepEqual(merged.map((s) => [s.id, s.name]).sort(), [[1, '職員01'], [2, '職員02'], [5, '職員05']])
    assert.equal(mergeById(null, active), active)
  })
  it('日報: 名前を引く表（staffById・residentById）は全員から、行の並び・ピッカーは在籍者から作る', () => {
    assert.match(daily, /for \(const s of nameStaff\) m\.set\(s\.id, s\)/)
    assert.match(daily, /for \(const r of nameResidents\) m\.set\(r\.id, r\)/)
    assert.match(daily, /fetchAllStaff\(\)/)
    assert.match(daily, /fetchAllResidents\(\)/)
    assert.match(daily, /useCellPresence\(\{ actorId, idle: presenceIdle, staff: nameStaff \}\)/)
    // 出勤者・記入者を選ぶ候補は在籍者のまま
    assert.match(daily, /staff\.some\(\(s\) => s\.id === managerStaffId\)\s*\n\s*\? staff\.filter\(\(s\) => s\.id === managerStaffId\)\s*\n\s*: staff/)
    assert.match(daily, /<ResidentPickerModal\s*\n\s*open=\{residentPick !== null\}\s*\n\s*residents=\{residents\}/)
  })
  it('申し送りフォーム: 「この方の記録」の記入者名は全員から引き、記入者の候補は在籍者のまま', () => {
    assert.match(form, /for \(const s of allStaff \?\? \[\]\) m\.set\(s\.id, s\)/)
    assert.match(form, /<StaffPickerModal\s*\n\s*open=\{staffPicker\}\s*\n\s*staff=\{staff\}/)
  })
})

// ══════════════════════════════════════════════════════════════
describe('★F47 名簿を取り直す（「最新に更新」・マスタ同期の合図）', () => {
  it('日報の〔最新に更新〕で App の名簿も取り直す合図を出す', () => {
    assert.match(cbSrc(daily, 'refreshAll'), /notifyMastersChanged\(\)/)
  })
  it('App が名簿を渡し直しても、マスタの読み込み（帯を消す処理）を走らせ直さない', () => {
    assert.match(daily, /\}, \[reload, propResidents, hasPropStaff\]\)/)
    assert.doesNotMatch(daily, /\}, \[reload, propResidents, propStaff\]\)/)
    assert.match(daily, /if \(!Array\.isArray\(propStaff\)\) return\s*\n\s*setStaff\(propStaff\.filter\(\(s\) => s != null\)\)/)
  })
  it('名簿が変わった合図で、名前の表（と申し送りフォームの候補）を取り直す', () => {
    assert.match(daily, /subscribeMastersChanged\(\(\) => \{\s*\n\s*loadNameLists\(\)/)
    assert.match(form, /const off = subscribeMastersChanged\(\(\) => \{\s*\n\s*loadAll\(\)/)
  })
})

// ══════════════════════════════════════════════════════════════
describe('依頼 F61 許可リストに無いアカウントは、封鎖・通信エラーではなくその旨を出す', () => {
  it('日報: 入力の止め理由と帯を FORBIDDEN_REASON にする', () => {
    assert.match(daily, /const blockedReason = forbidden \? FORBIDDEN_REASON : gateUnknown \? GATE_UNKNOWN_REASON : BLOCKED_REASON/)
    assert.match(daily, /setForbidden\(gate\.forbidden === true\)/)
  })
  it('申し送りフォーム: 帯と、登録の直前の確かめ直しで FORBIDDEN_REASON を出す', () => {
    assert.match(form, /\{forbidden && \(\s*\n\s*<p id=\{ids\.blocked\}/)
    assert.match(form, /setFormError\(FORBIDDEN_REASON\)/)
  })
})

// ══════════════════════════════════════════════════════════════
describe('★F42 書きかけの保持規則（期限なし・9/29 承認）に設計文書をそろえる', () => {
  it('db-design §5・ui-design §6.5 に「24時間期限」が規則として残っていない', () => {
    const db = readDoc('db-design.md')
    const line = db.split('\n').find((l) => l.startsWith('- **下書き — 監査#8受諾**'))
    assert.ok(line)
    assert.match(line, /期限は設けない/)
    assert.doesNotMatch(line, /24時間期限」付き保持を推奨案/)
    const ui = readDoc('ui-design.md')
    const row = ui.split('\n').find((l) => l.startsWith('| **入力途中下書き**'))
    assert.ok(row)
    assert.match(row, /期限は設けない/)
    assert.match(row, /cl_dailyDraft/)
    assert.match(row, /タブごとに分けて持つ/)
    assert.doesNotMatch(row, /期限超過は起動時に自動削除/)
  })
})
