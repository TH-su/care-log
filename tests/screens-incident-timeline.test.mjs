// 事故・外出・タイムライン・カルテ・検索の画面の回帰試験（多端末運用の改修・2026-10-10）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. useTimeline の純ロジック（F67・F14）: 通知から取り直す範囲を決める・10日の区切り・取り直した日の差し替え
// 2. 画面の配線の静的検査（F01・F08・F16・F19・F48・F53・F56・F61・F62・F37・F14）
// 3. db.ts の送信待ちの流れ（F53）: 止まった事故の追記を画面が見つけて、見せた版の上に送り直す・取り下げる。
//    画面は「この記録の送信待ちが無くなった」ことを queueSubscribe の通知で知るので、止まった時にも通知が来ることを確かめる
// 個人情報は置かない（利用者・職員は数値IDと記号だけ）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
// 行コメントとブロックコメントを外す（静的検査がコメントの文に当たらないように）
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
/** start の位置から end の位置まで（見つからなければ失敗） */
function between(src, start, end) {
  const i = src.indexOf(start)
  assert.notEqual(i, -1, `見つからない: ${start}`)
  const j = src.indexOf(end, i + start.length)
  assert.notEqual(j, -1, `見つからない: ${end}`)
  return src.slice(i, j)
}

// db.ts・useTimeline.ts は拡張子の無い相対 import を使うので、'.ts' を補う解決フックを入れてから読む（incident.test.mjs と同じ）
const lsStore = new Map()
let DB = null
let TL = null
let INC = null
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
  if (globalThis.localStorage === undefined) {
    globalThis.localStorage = {
      getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
      setItem: (k, v) => {
        lsStore.set(k, String(v))
      },
      removeItem: (k) => {
        lsStore.delete(k)
      },
    }
  }
  DB = await import('../src/lib/db.ts')
  TL = await import('../src/hooks/useTimeline.ts')
  INC = await import('../src/lib/incident.ts')
} catch {
  DB = null
  TL = null
  INC = null
}
const UNSUPPORTED = 'この Node では TypeScript か解決フックが使えないため、この検証をスキップしました（Node 22.18 以降で実行してください）。'

// ══════════════════════════════════════════════════════════════
// 1. useTimeline（F67・F14）
// ══════════════════════════════════════════════════════════════

function day(d, over = {}) {
  return { day: d, notes: [], vitals: [], meals: [], fluids: [], outings: [], importDay: null, pinned: [], ...over }
}
const WIN = { from: '2026-09-11', to: '2026-10-10' }

if (TL === null) {
  it('useTimeline の取り直しの範囲', { skip: UNSUPPORTED }, () => {})
} else {
  describe('タイムラインの取り直しの範囲（F67・F14）', () => {
    const days = [
      day('2026-10-10', {
        notes: [{ id: 11, note_on: '2026-10-10', ongoing: false }],
        vitals: [{ id: 21, measured_on: '2026-10-10' }],
        meals: [{ id: 31, meal_on: '2026-10-10' }],
      }),
      day('2026-10-05', {
        notes: [{ id: 12, note_on: '2026-10-05', ongoing: true }],
        pinned: [{ id: 12, note_on: '2026-10-05' }, { id: 13, note_on: '2026-08-01' }],
      }),
      day('2026-09-11', { outings: [{ id: 41, start_on: '2026-09-01', end_on: null }] }),
    ]
    const idx = TL.buildTimelineIndex(days)

    it('行の分からない通知（取り直しの合図 RESYNC・物理削除）は窓全体（F14: 切れていた間の変更を取り直す）', () => {
      assert.equal(TL.timelineReloadScope('notes', null, WIN, idx), 'all')
      assert.equal(TL.timelineReloadScope('meals', null, WIN, idx), 'all')
    })

    it('見ていない表・窓の外の日の変更は取り直さない（他の端末の1件ごとに60日を取り直さない）', () => {
      assert.equal(TL.timelineReloadScope('bath_records', { id: 1 }, WIN, idx), 'none')
      assert.equal(TL.timelineReloadScope('meals', { id: 99, meal_on: '2026-08-01' }, WIN, idx), 'none')
      assert.equal(TL.timelineReloadScope('fluid_intake', { id: 98, taken_on: '2026-10-11' }, WIN, idx), 'none')
    })

    it('日が分かる変更は、その日だけを返す（その日を含むチャンクだけを取り直す）', () => {
      assert.deepEqual(TL.timelineReloadScope('meals', { id: 99, meal_on: '2026-10-09' }, WIN, idx), ['2026-10-09'])
      assert.deepEqual(TL.timelineReloadScope('fluid_intake', { id: 98, taken_on: '2026-09-20' }, WIN, idx), ['2026-09-20'])
      assert.deepEqual(TL.timelineReloadScope('notes', { id: 50, note_on: '2026-09-30', ongoing: false }, WIN, idx), ['2026-09-30'])
    })

    it('出している行の日付を窓の外へ直した変更も、出していた日を取り直す（F16 と同じ取りこぼしを作らない）', () => {
      assert.deepEqual(TL.timelineReloadScope('vitals', { id: 21, measured_on: '2026-08-01' }, WIN, idx), ['2026-10-10'])
      assert.deepEqual(TL.timelineReloadScope('meals', { id: 31, meal_on: '2026-10-01' }, WIN, idx), ['2026-10-01', '2026-10-10'])
    })

    it('既読は、出している申し送りの日だけ。出していない申し送りの既読は取り直さない', () => {
      assert.deepEqual(TL.timelineReloadScope('note_reads', { note_id: 11, staff_id: 3 }, WIN, idx), ['2026-10-10'])
      assert.equal(TL.timelineReloadScope('note_reads', { note_id: 999, staff_id: 3 }, WIN, idx), 'none')
    })

    it('継続・ピン留めの申し送り（各日に複製される）とその既読は窓全体', () => {
      assert.equal(TL.timelineReloadScope('notes', { id: 12, note_on: '2026-10-05', ongoing: true }, WIN, idx), 'all')
      assert.equal(TL.timelineReloadScope('notes', { id: 13, note_on: '2026-08-01', ongoing: true }, WIN, idx), 'all')
      assert.equal(TL.timelineReloadScope('note_reads', { note_id: 13, staff_id: 3 }, WIN, idx), 'all')
      assert.equal(TL.timelineReloadScope('notes', { id: 60, note_on: '2026-07-01', ongoing: true, ended_at: null }, WIN, idx), 'all')
      // 窓が始まる前に終わった継続は、どの日にも載らない
      assert.equal(
        TL.timelineReloadScope('notes', { id: 61, note_on: '2026-07-01', ongoing: true, ended_at: '2026-08-01T03:00:00Z' }, WIN, idx),
        'none',
      )
    })

    it('外出は期間が窓に重なるか、出している外出なら窓全体（チャンクをまたいで置き直すため）', () => {
      assert.equal(TL.timelineReloadScope('outings', { id: 70, start_on: '2026-09-01', end_on: null }, WIN, idx), 'all')
      assert.equal(TL.timelineReloadScope('outings', { id: 71, start_on: '2026-08-01', end_on: '2026-08-02' }, WIN, idx), 'none')
      // 出している外出の帰着を窓より前の日で記入した（更新後の行は窓の外）
      assert.equal(TL.timelineReloadScope('outings', { id: 41, start_on: '2026-09-01', end_on: '2026-09-05' }, WIN, idx), 'all')
    })

    it('チャンクの区切りは loadWindow と同じ（最新側から10日ずつ）・重複しない・窓の外は無視', () => {
      assert.deepEqual(TL.chunkRangesFor(WIN.from, WIN.to, ['2026-10-10', '2026-10-01', '2026-10-03']), [['2026-10-01', '2026-10-10']])
      assert.deepEqual(TL.chunkRangesFor(WIN.from, WIN.to, ['2026-09-30', '2026-09-11', '2026-08-01']), [
        ['2026-09-21', '2026-09-30'],
        ['2026-09-11', '2026-09-20'],
      ])
      assert.deepEqual(TL.chunkRangesFor('2026-10-05', '2026-10-10', ['2026-10-05']), [['2026-10-05', '2026-10-10']])
    })

    it('取り直した日だけを差し替え、他の日はオブジェクトをそのまま使う・外出は取り直した方を正に1か所へ置き直す', () => {
      const o = { id: 41, start_on: '2026-09-25', start_at: null, end_on: null }
      const before = [day('2026-10-10'), day('2026-09-30'), day('2026-09-25', { outings: [o] }), day('2026-09-20')]
      const oFresh = { ...o, end_on: '2026-10-01' }
      const fresh = new Map([
        ['2026-10-10', day('2026-10-10', { meals: [{ id: 1 }] })],
        ['2026-09-30', day('2026-09-30', { outings: [oFresh] })], // チャンクの端に寄せて返る
      ])
      const after = TL.mergeChunkDays(before, fresh)
      assert.equal(after.length, 4)
      assert.equal(after[3], before[3], '取り直していない日のオブジェクトが変わった（memo が効かない）')
      assert.deepEqual(after[0].meals, [{ id: 1 }])
      const placed = after.flatMap((d) => d.outings.map((x) => [d.day, x]))
      assert.equal(placed.length, 1, '外出が二重に置かれた')
      assert.equal(placed[0][0], '2026-09-25', '外出が開始日に置き直されていない')
      assert.equal(placed[0][1].end_on, '2026-10-01', '取り直した外出が使われていない')
    })
  })
}

describe('タイムラインの購読の配線（F67・F14）', () => {
  const src = strip(read('../src/hooks/useTimeline.ts'))
  const sub = between(src, 'unsub = subscribeChanges(', 'catch {')
  it('自分の書き込みは取り直さない（isSelfWrite）・範囲は timelineReloadScope で決める', () => {
    assert.match(sub, /isSelfWrite\(table, row\)/)
    assert.match(sub, /timelineReloadScope\(table, row,/)
  })
  it('日が分かる変更はチャンクだけ（loadDays）・分からなければ窓全体（loadWindow）', () => {
    assert.match(src, /else if \(dirty\.length > 0\) void loadDays\(dirty\)/)
    assert.match(src, /if \(all\) void loadWindow\(w\.from, windowTo\(w\), true\)/)
  })
  it('チャンクだけの取り直しも世代（genRef）と取得中（busyRef）の約束を守る・日付が変わったら窓全体', () => {
    const body = between(src, 'const loadDays = useCallback(', 'const loadMore = useCallback(')
    assert.match(body, /const gen = \+\+genRef\.current/)
    assert.match(body, /busyRef\.current = true/)
    assert.match(body, /if \(to !== w\.to\) \{\s*void loadWindow\(w\.from, to, true\)/)
    assert.match(body, /mergeChunkDays\(daysRef\.current, fresh\)/)
  })
})

// ══════════════════════════════════════════════════════════════
// 2. 画面の配線（静的検査）
// ══════════════════════════════════════════════════════════════

describe('タイムライン（TimelinePage）', () => {
  const src = strip(read('../src/pages/TimelinePage.tsx'))

  it('F01: 申し送りの変更・取り消し・継続の終了・帰着の記入は、端末に残せていない送信待ちを「送った」扱いにしない', () => {
    for (const [start, end] of [
      ['const handleEndOngoing = useCallback(', 'const handleDeleteNote'],
      ['const handleDeleteNote = useCallback(', 'const handleUpdateNoteBody'],
      ['const handleUpdateNoteBody = useCallback(', 'const handleSaveOutingEnd'],
    ]) {
      const body = between(src, start, end)
      // queued の分岐で、まず端末に残せたかを確かめ、残せていなければ ok:false（入力欄を閉じない）で返す
      assert.match(body, /if \(!isQueuePersisted\(\)\) return \{ ok: false, message: MSG_NOT_PERSISTED \}/, start)
      assert.ok(body.indexOf('isQueuePersisted()') < body.indexOf('queuedText()'), `${start}: 残せたかを確かめる前に送信待ちと案内している`)
    }
    const outing = between(src, 'const handleSaveOutingEnd = useCallback(', 'const [pendingNotes, setPendingNotes]')
    assert.match(outing, /if \(res === 'queued' && !isQueuePersisted\(\)\) return 'notPersisted'/)
    const row = between(src, 'function OutingRow(', 'return (')
    assert.match(row, /res === 'notPersisted'\s*\?\s*MSG_NOT_PERSISTED/)
    assert.match(row, /if \(res === 'ok' \|\| res === 'queued'\) \{/, 'notPersisted で帰着の入力欄を閉じている')
  })

  it('F08: 終了済みの継続は送らずに「既に終了済み」・ended_by の基準は値が分かる時だけ・済み（noop）を「終了しました」と言わない', () => {
    const body = between(src, 'const handleEndOngoing = useCallback(', 'const handleDeleteNote')
    assert.match(body, /if \(isEndedAt\(note\.ended_at, now\)\) \{\s*showRef\.current\(MSG_ALREADY_ENDED\)/)
    assert.ok(body.indexOf('isEndedAt(note.ended_at, now)') < body.indexOf('saveNoteEdits('), '終了済みの判定より前に送っている')
    assert.match(body, /note\.ended_by !== undefined \? \{ value: actorId, base: note\.ended_by \} : \{ value: actorId \}/)
    assert.match(body, /res\.status === 'noop' && res\.settled\.includes\('ended_at'\)/)
    // ピン留め: 終了済みの継続には〔継続を終了〕を出さない（ピン留めに残す規則は変えない）
    assert.match(src, /ongoing && isEndedAt\(n\.ended_at, Date\.now\(\)\) \?/)
    assert.match(src, /ongoing && !isEndedAt\(n\.ended_at, Date\.now\(\)\) && \(\s*<EndOngoingButton/)
  })

  it('F48: 名前は退職者・退居者も含む全員から引く（行の一覧＝全員表は在籍者のまま）', () => {
    assert.match(src, /fetchAllStaff\(\)/)
    assert.doesNotMatch(src, /\bfetchStaff\(/, '在籍者だけの名簿で記入者名を引いている')
    assert.match(src, /fetchAllResidents\(\)/)
    assert.match(src, /fetchResidents\(\)/, '全員表の行（在籍者）の取得が無くなった')
    const map = between(src, 'const residentById = useMemo(', '}, [residents, allResidents])')
    assert.match(map, /for \(const r of allResidents \?\? NO_RESIDENTS\) m\.set/)
    const staffMap = between(src, 'const staffById = useMemo(', '}, [staffProp, loadedStaff])')
    assert.match(staffMap, /for \(const s of loadedStaff \?\? NO_STAFF\)/)
    // App から名簿（在籍者）が渡っていても全員を読む（渡っている時に取得を飛ばしていた）
    assert.doesNotMatch(between(src, 'const [loadedStaff, setLoadedStaff]', 'const staffById'), /if \(staffProp !== undefined\) return/)
  })
})

describe('カルテ・検索（F48）', () => {
  it('カルテの記入者名は退職者も含む全員から引く（App の名簿が渡っていても）', () => {
    const src = strip(read('../src/pages/KartePage.tsx'))
    assert.match(src, /fetchAllStaff\(\)/)
    assert.doesNotMatch(src, /\bfetchStaff\(/)
    const map = between(src, 'const staffById = useMemo(', '}, [staffList, allStaff])')
    assert.match(map, /for \(const s of allStaff\) m\.set/)
  })
  it('検索の記入者名も全員から引く（記入者での検索は db.ts の searchNotes が全員の名簿で照合する）', () => {
    const src = strip(read('../src/pages/SearchPage.tsx'))
    assert.match(src, /fetchAllStaff\(\)/)
    assert.doesNotMatch(src, /\bfetchStaff\(/)
  })
  it('事故の入力の記録者・確認者の名前も全員から引く（選ぶ候補は在籍者のまま）', () => {
    const src = strip(read('../src/pages/IncidentFormPage.tsx'))
    assert.match(src, /allStaff\.find\(\(s\) => s\.id === id\)\?\.name/)
    assert.match(src, /staff=\{staff\.filter\(\(s\) => s\.active\)\}/)
  })
})

describe('事故・ヒヤリハットの入力（IncidentFormPage）', () => {
  const src = strip(read('../src/pages/IncidentFormPage.tsx'))

  it('F19: 読み直しの応答の時点で入力中なら、入力も基準（server）も置き換えない（版が変わった時だけ知らせる）', () => {
    const body = between(src, 'const reload = useCallback(', '}, [loadRecord])')
    const guard = body.indexOf('if (dirtyRef.current) {')
    assert.notEqual(guard, -1, '応答の時点で入力中かを見ていない')
    assert.ok(guard < body.indexOf('setServer(row)'), '入力中かを見る前に基準を置き換えている')
    assert.ok(guard < body.indexOf('setForm(formOf(row))'), '入力中かを見る前に入力を置き換えている')
    assert.match(body, /if \(row\.rev !== serverRef\.current\?\.rev\) setRemoteChanged\(true\)\s*return/)
  })

  it('F14: 取り直しの合図（RESYNC）だけの時は、入力中でも「他の端末が変更」と決めつけず版を確かめる', () => {
    const body = between(src, 'const unsub = subscribeIncidentChanges((table, info) => {', '}, [isNew, recordId, reload])')
    assert.match(body, /if \(info\?\.event !== 'RESYNC'\) sawChange = true/)
    assert.match(body, /if \(dirtyRef\.current && changed\) setRemoteChanged\(true\)\s*else reload\(\)/)
  })

  it('F53: この記録の送信待ちが無くなった（送れた・止まった）ことで読み直す（件数が減らなくても）', () => {
    const body = between(src, 'let lastPending =', '}, [isNew, recordId, reload, show])')
    assert.match(body, /const nowPending = hasPendingIncident\(recordId\)/)
    assert.match(body, /const settled = lastPending && !nowPending/)
    assert.match(body, /if \(settled \|\| \(prev >= 0 && n < prev/)
    // 「自動で送信します」を出し続けない
    assert.match(body, /cur\.text === MSG_QUEUED \? null : cur/)
  })

  it('F53: 止まっている変更を最新とくらべて出し、見せた版の上に送り直す・確認つきで取り下げる・止まっている間は刷らない', () => {
    assert.match(src, /listStoppedOps\(\)\.find\(\(o\) => o\.table === 'incidents' && o\.kind === 'update' && o\.rowId === server\.id\)/)
    const resend = between(src, 'async function resendStopped()', 'async function discardStopped()')
    assert.match(resend, /fetchQueuedOpTarget\(stoppedOp\.qid\)/)
    assert.match(resend, /if \(Number\(target\.rev\) !== server\.rev\) \{\s*reload\(\)/, '見せていない版の上に送り直している')
    assert.match(resend, /resendQueuedOp\(stoppedOp\.qid, \{ rev: server\.rev \}\)/)
    assert.match(between(src, 'async function discardStopped()', 'async function printWith('), /discardQueuedOp\(stoppedOp\.qid\)/)
    assert.match(src, /open=\{discardAsk\}[\s\S]{0,400}onConfirm=\{\(\) => void discardStopped\(\)\}/)
    const print = between(src, 'async function printWith(', 'if (baseError !== null)')
    assert.ok(print.indexOf('if (stoppedOp !== null)') < print.indexOf('await save(extra)'), '止まっている変更があるのに保存・印刷へ進む')
    // 送れていない内容の欄は画面だけ（印刷・PrintArea の中に置かない）・氏名の写しは比べない／出さない
    const panel = between(src, 'function StoppedPanel(', 'function MessageLine(')
    assert.match(panel, /print:hidden/)
    const printArea = between(src, '<PrintArea ref={printRef}', '</PrintArea>')
    assert.doesNotMatch(printArea, /StoppedPanel|showSameDay/)
    const diff = between(src, 'function stoppedDiff(', 'function blankForm(')
    assert.match(diff, /if \(k === 'subject_name' \|\| k === RESYNC_SUBJECT_KEY\) continue/)
    // 様式の欄も、送れていない値といまの値を並べる（他の端末が後から書いた欄が「（空）」で上書きされることを見せる）
    assert.match(diff, /now: fmtHistoryValue\('incidents', k, nowDetail\[k\], staffName\)/)
    assert.match(panel, /送れていない値「\{c\.mine\}」（いまの記録「\{c\.now\}」）/)
    // 止まっていても記録は直せる（hasPendingIncident は止まった op を含めない＝閉じ込めない）
    assert.match(src, /const editable = !locked && !pendingNow && !queuedInsert && !busy && !notFound/)
  })

  it('F56: 新しい記録で、同じ日・同じ方の既存（この端末の未送信を含む）を参考に出す（保存は止めない・画面だけ）', () => {
    assert.match(src, /fetchIncidents\(\{ fromIso: sameDayOn, toIso: sameDayOn, residentId: sameDayResident \}\)/)
    assert.match(src, /pendingIncidentOps\(\)\.filter\(\(p\) => p\.residentId === sameDayResident && p\.occurredOn === sameDayOn\)/)
    assert.match(src, /const sameDayResident = isNew && form !== null \? form\.resident_id : null/)
    // 新しい記録でも他の端末の保存を受けて読み直す
    assert.match(src, /if \(sameDayResident === null \|\| sameDayOn === null\) return\s*let timer[\s\S]{0,200}subscribeIncidentChanges/)
    assert.match(src, /\{showSameDay \? \(\s*<div role="status" className="[^"]*print:hidden/)
    // 保存（save）は参考表示を見ない＝止めない
    assert.doesNotMatch(between(src, 'async function save(', 'async function remove()'), /sameDay/)
    assert.doesNotMatch(src, /localStorage/)
  })

  it('F61: 許可リスト外（forbidden）は封鎖・通信エラーと別の理由を出す', () => {
    assert.match(src, /gate\.forbidden === true \? \(\s*<ErrorBlock message=\{FORBIDDEN_REASON\}/)
    assert.match(src, /e\.kind === 'server' \|\| e\.kind === 'forbidden'/)
  })
})

describe('事故・ヒヤリハットの一覧・月次集計（F16・F14・F61・F37）', () => {
  const list = strip(read('../src/pages/IncidentListPage.tsx'))
  const summary = strip(read('../src/pages/IncidentSummaryPage.tsx'))

  it('F16: 一覧に出している記録の変更は、発生日が期間の外になっても取り込む（購読は張り直さない）', () => {
    assert.match(list, /shownIdsRef\.current = new Set\(\(list \?\? \[\]\)\.map\(\(i\) => i\.id\)\)/)
    assert.match(list, /\(row\.occurred_on < from \|\| row\.occurred_on > to\) &&\s*!shownIdsRef\.current\.has\(Number\(row\.id\)\)/)
    assert.match(list, /\}, \[from, to\]\)/, '購読の依存に一覧を入れた（張り直しの間の通知を取りこぼす）')
    assert.match(list, /window\.setTimeout\(\(\) => setTick\(\(n\) => n \+ 1\), 400\)/)
  })

  it('F16: 月次集計も、集計に入れている記録（件数・未完了）の変更は月末より後へ動いても取り込む', () => {
    assert.match(summary, /\[\.\.\.data\.list, \.\.\.data\.open\]\.map\(\(i\) => i\.id\)/)
    assert.match(summary, /row\.occurred_on > range\.to &&\s*!shownIdsRef\.current\.has\(Number\(row\.id\)\)/)
  })

  it('F14: 取り直し（tick）では一覧を空にしない（絞り込みが変わった時だけ）・失敗しても前の一覧と集計を残す', () => {
    assert.match(list, /if \(shownQueryRef\.current !== queryKey\) setList\(null\)/)
    assert.doesNotMatch(list, /setListError\(null\)\s*setList\(null\)/)
    assert.match(list, /\{listError !== null \? <ErrorBlock message=\{listError\} onRetry=\{\(\) => setTick\(\(n\) => n \+ 1\)\} \/> : null\}\s*\{list === null \?/)
    assert.match(summary, /\{error !== null \? <ErrorBlock message=\{error\} onRetry=\{\(\) => setTick\(\(n\) => n \+ 1\)\} \/> : null\}\s*\{summary === null \?/)
  })

  it('F61: 読み取りの forbidden は理由をそのまま出す・一覧の入力解禁の forbidden は FORBIDDEN_REASON', () => {
    assert.match(list, /e\.kind === 'server' \|\| e\.kind === 'forbidden'/)
    assert.match(summary, /e\.kind === 'server' \|\| e\.kind === 'forbidden'/)
    assert.match(list, /gate\.forbidden === true \? \(\s*<ErrorBlock message=\{FORBIDDEN_REASON\}/)
  })

  it('F37: この端末で止まっている修正・取り消しがある行に印を出す（送信待ちの通知のたびに引き直す）', () => {
    assert.match(list, /for \(const o of listStoppedOps\(\)\)[\s\S]{0,120}o\.table === 'incidents' && o\.kind === 'update'/)
    assert.match(list, /\{stoppedIds\.has\(i\.id\) \?/)
  })
})

describe('外出・外泊の入力（OutingFormPage・F62・F56・F61）', () => {
  const src = strip(read('../src/pages/OutingFormPage.tsx'))
  const raw = read('../src/pages/OutingFormPage.tsx')

  it('F62: 記録者が未選択の時の案内は、実在する入口（設定の「記録する職員」・ヘッダの「記録者の既定を設定」）を指す', () => {
    assert.doesNotMatch(raw, /画面上部の職員名をタップ/)
    assert.match(src, /<Link to="\/settings"[^>]*>\s*設定の「記録する職員」\s*<\/Link>/)
    assert.match(src, /記録者の既定を設定/)
  })

  it('F62: 登録の失敗は DbError の理由をそのまま出し、それ以外も「通信状態を確認」と決めつけない（入力は残す）', () => {
    const body = between(src, 'async function handleSubmit(', 'if (loadError)')
    assert.match(body, /catch \(e\) \{\s*setSubmitError\(e instanceof DbError \? e\.message : SUBMIT_ERROR_UNKNOWN\)/)
    assert.doesNotMatch(raw, /登録できませんでした。通信状態を確認して/)
    // 端末に残せなかった分岐は catch より前のまま
    assert.ok(body.indexOf('NOT_PERSISTED_REASON') < body.indexOf('catch (e)'))
  })

  it('F56: 利用者と開始日が決まったら、その日にその方に在る外出・外泊を参考に出す（保存は止めない・画面だけ）', () => {
    assert.match(src, /fetchOutingsOn\(residentId, startOn\)/)
    assert.match(src, /sameDay !== null && sameDay\.key === sameDayKey && sameDay\.list\.length > 0 \? \(\s*<div role="status" className="[^"]*print:hidden/)
    assert.doesNotMatch(between(src, 'async function handleSubmit(', 'if (loadError)'), /sameDay\.list/)
    assert.doesNotMatch(src, /localStorage/)
  })

  it('F61: 許可リスト外は封鎖の文でも通信エラーでもなく FORBIDDEN_REASON', () => {
    assert.match(src, /if \(gate\.forbidden === true\) \{\s*setLoadError\(FORBIDDEN_REASON\)/)
    assert.match(raw, /const LOCKED_REASON =\s*'現在はスプレッドシートで記録する期間です（アプリ入力の開始日は施設で決定します）'/, '定型文を変えた')
  })
})

// ══════════════════════════════════════════════════════════════
// 3. db.ts の送信待ちの流れ（F53・F56）
// ══════════════════════════════════════════════════════════════

function fakeSupabase(handler) {
  const calls = []
  const builder = (q) => {
    const run = () => {
      calls.push(q)
      return Promise.resolve(handler(q))
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

/** 事故・ヒヤリハットの偽のサーバー（rev の自動加算・app_settings。opts.offline() が true の間は通信できない） */
function incidentServer(opts = {}) {
  const db = {
    rows: [],
    nextId: 1,
    settings: { native_input_enabled: 'false', input_enabled_bath: 'false', input_enabled_med: 'false', input_enabled_incident: 'true' },
  }
  const match = (q, r) =>
    q.filters.every(([op, k, v]) => {
      if (op === 'eq' || op === 'is') return r[k] === v
      if (op === 'in') return v.includes(r[k])
      if (op === 'gte') return r[k] >= v
      if (op === 'lte') return r[k] <= v
      return true
    })
  const pick = (row, cols) => {
    if (typeof cols !== 'string') return { ...row }
    const out = {}
    for (const c of cols.split(',')) if (c in row) out[c] = row[c]
    return out
  }
  const fake = fakeSupabase((q) => {
    if (opts.offline?.()) return { data: null, error: { message: 'offline' }, status: 0 }
    if (q.table === 'app_settings') {
      const inF = q.filters.find(([op]) => op === 'in')
      if (inF) return { data: inF[2].filter((k) => k in db.settings).map((k) => ({ key: k, value: db.settings[k] })), error: null, status: 200 }
      const key = eqOf(q).key
      return { data: key in db.settings ? { value: db.settings[key] } : null, error: null, status: 200 }
    }
    if (q.table === 'incidents') {
      if (q.action === 'insert') {
        const p = { ...q.payload, detail: { ...(q.payload.detail ?? {}) } }
        const row = { id: db.nextId++, rev: 1, status: 'open', deleted_at: null, edited_by: null, city_report_needed: false, ...p }
        db.rows.push(row)
        return { data: pick(row, q.cols), error: null, status: 201 }
      }
      if (q.action === 'update') {
        const r = db.rows.find((x) => match(q, x))
        if (!r) return { data: null, error: null, status: 200 }
        Object.assign(r, { ...r, ...q.payload }, { rev: r.rev + 1 })
        return { data: pick(r, q.cols), error: null, status: 200 }
      }
      const hits = db.rows.filter((x) => match(q, x))
      if (q.limit === 1) return { data: hits[0] ? pick(hits[0], q.cols) : null, error: null, status: 200 }
      return { data: hits.slice(0, q.limit ?? hits.length).map((x) => pick(x, q.cols)), error: null, status: 200 }
    }
    if (q.action === 'select') return { data: [], error: null, status: 200 }
    return { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
  })
  return { ...fake, db }
}

/** 第1報の最小の入力（事故・対象者あり。氏名は送らない） */
function firstReport(over = {}) {
  const detail = { ...INC.emptyIncidentDetail(), situation: '状況', response: '対応' }
  return {
    kind: 'accident',
    resident_id: 1,
    occurred_on: '2026-10-01',
    occurred_at: new Date(2026, 9, 1, 10, 0).toISOString(),
    office: null,
    place: 'room_private',
    place_other: null,
    types: ['fall'],
    severity: null,
    status: 'open',
    report_stage: null,
    report_no: null,
    submitted_on: null,
    city_report_needed: false,
    city_reported_on: null,
    reporter_id: 3,
    confirmer_id: null,
    confirmed_at: null,
    closed_at: null,
    ...over,
    detail: { ...detail, ...(over.detail ?? {}) },
  }
}

async function drain() {
  await new Promise((r) => setTimeout(r, 10))
  lsStore.delete('cl_sendQueue')
  lsStore.delete('cl_sendQueue2')
  await DB.__testHooks.restartQueue()
  DB.__testHooks.setClient(null)
}

if (DB === null) {
  it('事故の送信待ちの流れ（db.ts）', { skip: UNSUPPORTED }, () => {})
} else {
  describe('止まった事故の追記を画面が見つけて選ぶ流れ（F53・db.ts）', () => {
    afterEach(drain)

    /** 圏外で原因を追記して送信待ちにし、その間に他の端末が確認者を入れ、電波が戻って送ると止まる（監査の場面2） */
    async function stoppedScene() {
      let off = false
      const srv = incidentServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      const first = await DB.insertIncident(firstReport())
      const cur = await DB.fetchIncident(first.id)
      // 画面と同じく、この記録の送信待ちの有無を通知のたびに見る
      const seen = []
      const unsub = DB.queueSubscribe(() => seen.push(DB.hasPendingIncident(first.id)))
      off = true
      assert.equal(await DB.updateIncident(cur, { detail: { cause: '原因A', prevention: '防止策A' } }, { editedBy: 3 }), 'queued')
      const row = srv.db.rows[0]
      Object.assign(row, { confirmer_id: 7, rev: row.rev + 1 }) // 他の端末が確認者を入れた
      off = false
      await DB.flushQueue(true)
      unsub()
      return { srv, first, seen }
    }

    it('止まった時にも通知が来て、この記録の送信待ちが「有る→無い」に変わる（画面はこれで読み直す・件数は減らない）', async () => {
      const { first, seen } = await stoppedScene()
      assert.ok(seen.includes(true), '送信待ちになったことが通知されていない')
      assert.equal(seen[seen.length - 1], false, '止まった後も送信待ちのまま（画面が読み直さない）')
      assert.equal(DB.hasPendingIncident(first.id), false)
      assert.equal(DB.queuePending(), 1, '止まった追記が未送信として数えられていない')
    })

    it('止まった追記は listStoppedOps に出て、送れていない原因・防止策を持っている（サーバーには無い）', async () => {
      const { srv, first } = await stoppedScene()
      const ops = DB.listStoppedOps().filter((o) => o.table === 'incidents' && o.kind === 'update' && o.rowId === first.id)
      assert.equal(ops.length, 1)
      assert.equal(ops[0].state, 'conflict')
      assert.equal(ops[0].payload.detail.cause, '原因A')
      assert.equal(ops[0].payload.detail.prevention, '防止策A')
      assert.equal(srv.db.rows[0].detail.cause ?? null, null)
      // 送信待ちの detail は様式の全欄を持つ（A が空のままの欄も空として持つ）。画面の「いまの記録との違い」は
      // この全欄で比べるので、他の端末が後から書いた欄も「送れていない値＝（空）」として必ず並ぶ（黙って空に戻さない）
      assert.ok(Object.prototype.hasOwnProperty.call(ops[0].payload.detail, 'followup'))
      assert.equal(ops[0].payload.detail.followup, null)
      assert.equal(Object.prototype.hasOwnProperty.call(ops[0].payload.detail, 'subject_name'), false, '送信待ちに氏名の写しを置いた')
    })

    it('〔この内容で保存し直す〕: 送り先のいまの版を見せた上で送り直すと、他の端末の確認者を残したまま追記が載る', async () => {
      const { srv, first } = await stoppedScene()
      const op = DB.listStoppedOps().find((o) => o.rowId === first.id)
      const target = await DB.fetchQueuedOpTarget(op.qid)
      assert.equal(target.rev, srv.db.rows[0].rev)
      // 版を渡さなければ送らない（見せていない変更を黙って上書きしない）
      assert.equal(await DB.resendQueuedOp(op.qid), 'conflict')
      assert.equal(await DB.resendQueuedOp(op.qid, { rev: target.rev }), 'sent')
      assert.equal(srv.db.rows[0].detail.cause, '原因A')
      assert.equal(srv.db.rows[0].confirmer_id, 7, '他の端末の確認者を消した')
      assert.equal(DB.listStoppedOps().length, 0)
      assert.equal(DB.queuePending(), 0)
    })

    it('〔取り下げる〕: 送信待ちから外し、記録には書かない', async () => {
      const { srv, first } = await stoppedScene()
      const op = DB.listStoppedOps().find((o) => o.rowId === first.id)
      assert.equal(await DB.discardQueuedOp(op.qid), 'dropped')
      assert.equal(DB.listStoppedOps().length, 0)
      assert.equal(DB.queuePending(), 0)
      assert.equal(srv.db.rows[0].detail.cause ?? null, null)
    })
  })

  describe('事故の同じ日・同じ方の参考表示（F56・db.ts）', () => {
    afterEach(drain)
    it('fetchIncidents の residentId で、その方の記録だけを引く（画面は発生日1日だけで呼ぶ）', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      await DB.insertIncident(firstReport())
      await DB.insertIncident(firstReport({ resident_id: 2 }))
      await DB.insertIncident(firstReport({ occurred_on: '2026-10-02', occurred_at: new Date(2026, 9, 2, 9, 0).toISOString() }))
      const rows = await DB.fetchIncidents({ fromIso: '2026-10-01', toIso: '2026-10-01', residentId: 1 })
      assert.deepEqual(rows.map((r) => [r.resident_id, r.occurred_on]), [[1, '2026-10-01']])
    })
  })
}
