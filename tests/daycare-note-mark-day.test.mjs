// デイ（せせらぎ）計画D: 一括の画面の「⚐ 申し送り」（ワンタップ・バイタル・食事はテンキーの見出し）と今日の画面のカードの「⚑n」の回帰テスト（2026-11-10）。
// 正本: 改善計画 v1 §3 の D・DESIGN §4(9)。実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycareNoteMark.ts）: 足した記録の種類（活動一括の行＝acday・機能訓練＝tr<id>）の鍵・読み方・分類・文
// 2. db.ts を偽の Supabase で動かす（通信しない）: fetchDaycareDayNotes の絞り込み（日・区分デイ・鍵で絞らない）・取り消した行も読む・
//    受信した行を信じない（日・区分の違う行を捨てる）・読むだけ
// 3. 静的検査: 一括の印の部品（DaycareNoteMarkDay.tsx）の書き込みは既存の insertNote・deleteNote だけ・送る直前に読み直す・送れた時だけ
//    〔元に戻す〕・印の読み込みは1本・購読を足さない。一括の画面と今日の画面は申し送りへ書かない・1人の画面の部品は変えない
// 個人情報は置かない（利用者は数値IDだけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
/** 行コメントと複数行コメントを除いた本文 */
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const writesOf = (src) => [...new Set((src.match(/\b(save\w+|insert\w+|update\w+|delete\w+|softDelete\w+|upsert\w+|discard\w+|stage\w+)\(/g) ?? []).map((w) => w.slice(0, -1)))].sort()

const lsStore = new Map()
let M = null
let DB = null
/** 一括の印の判断の純関数（daycareNoteMarkDay.ts） */
let J = null
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
  J = await import('../src/lib/daycareNoteMarkDay.ts')
  DB = await import('../src/lib/db.ts?daycare-note-mark-day')
} catch (e) {
  loadError = e
  M = null
}

if (M === null) {
  registerLoadFailure('デイ 計画D（申し送りのワンタップ）の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('純ロジック: 足した記録の種類（2026-11-10 計画D）', () => {
    it('鍵: 活動一括の行は acday（その日の活動をまとめて1件）・機能訓練は tr<記録の id>。1人の画面の ac<id> とは別の鍵', () => {
      assert.equal(M.markKey('2026-11-10', 7, { kind: 'activityDay' }, 1, 'k3x9'), 'dcn:2026-11-10:7:acday:1-k3x9')
      assert.equal(M.markKey('2026-11-10', 7, { kind: 'training', id: 42 }, 2, 'a1'), 'dcn:2026-11-10:7:tr42:2-a1')
      assert.deepEqual(M.parseMarkKey('dcn:2026-11-10:7:acday:1-k3x9'), { day: '2026-11-10', residentId: 7, what: 'acday', gen: 1 })
      assert.deepEqual(M.parseMarkKey('dcn:2026-11-10:7:tr42:2-a1'), { day: '2026-11-10', residentId: 7, what: 'tr42', gen: 2 })
      assert.equal(M.parseMarkKey('dcn:2026-11-10:7:tr:1'), null, '機能訓練は記録の id が要る')
      assert.equal(M.parseMarkKey('dcn:2026-11-10:7:acd:1'), null)
      // 頭が重ならない（活動1つずつの印と、その日の活動の印は別に数える）
      const day = M.markPrefix('2026-11-10', 7, { kind: 'activityDay' })
      const one = M.markPrefix('2026-11-10', 7, { kind: 'activity', id: 5 })
      assert.ok(!day.startsWith(one) && !one.startsWith(day))
      assert.equal(M.nextGen(day, ['dcn:2026-11-10:7:ac5:3-aa', 'dcn:2026-11-10:7:acday:1-bb']), 2)
      assert.equal(M.markDayAllPrefix('2026-11-10'), 'dcn:2026-11-10:')
      assert.ok(M.markDayPrefix('2026-11-10', 7).startsWith(M.markDayAllPrefix('2026-11-10')))
    })
    it('鍵の記録の部分から記録を戻す（markWhat の逆・元の記録が無くなった印を外すため）', () => {
      for (const r of [{ kind: 'vital' }, { kind: 'lunch' }, { kind: 'snack' }, { kind: 'ex' }, { kind: 'activityDay' }, { kind: 'fluid', id: 3 }, { kind: 'activity', id: 4 }, { kind: 'training', id: 5 }]) {
        assert.deepEqual(M.markRecordOf(M.markWhat(r)), r)
      }
      assert.equal(M.markRecordOf('tr0'), null)
      assert.equal(M.markRecordOf('dinner'), null)
      assert.equal(M.markRecordOf('activityDay'), null, '種類の名前そのものは鍵の形ではない')
    })
    it('分類: その日の活動・機能訓練は付けない（活動と同じ）。文は記録の言葉をそのまま（氏名は入れない）', () => {
      assert.deepEqual(M.markCategories('activityDay'), [])
      assert.deepEqual(M.markCategories('training'), [])
      assert.equal(M.activityDayMarkText(['体操', '歌（見学）']), '活動 体操・歌（見学）')
      assert.equal(M.activityDayMarkText([]), null, '活動が1つも無ければ押せない')
      assert.equal(M.trainingMarkText('完了 10:00〜 20分 立ち上がり'), '機能訓練 完了 10:00〜 20分 立ち上がり')
      assert.equal(M.markBody(M.trainingMarkText('中止（体調不良）10:00'), ''), '機能訓練 中止（体調不良）10:00', 'ワンタップはひと言なし')
      assert.equal(M.MARK_KIND_LABEL.activityDay, '活動')
      assert.equal(M.MARK_KIND_LABEL.training, '機能訓練')
    })
  })

  describe('純ロジック: 反証の直し（2026-11-10 計画D の反証）', () => {
    it('中1: バイタルの文は全部の回から項目ごとに最新の値（latestVitalValues）。1人の画面の前の latestOf と同じ結果（並べ替え: 測った時刻 → id）', () => {
      // 1人の画面の前の作り（DaycarePersonPage.tsx の myVitals＋latestOf をそのまま写したもの）
      const oldLatest = (rows) => {
        const my = [...rows].sort((a, b) => (a.measured_at ?? '').localeCompare(b.measured_at ?? '') || a.id - b.id)
        const of = (f) => {
          for (let i = my.length - 1; i >= 0; i -= 1) if (typeof my[i][f] === 'number') return my[i][f]
          return null
        }
        return { temp: of('temp'), sys_bp: of('sys_bp'), dia_bp: of('dia_bp'), pulse: of('pulse'), spo2: of('spo2') }
      }
      let seed = 7
      const rnd = (n) => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return seed % n
      }
      const val = (base) => (rnd(3) === 0 ? null : base + rnd(20))
      for (let t = 0; t < 300; t += 1) {
        const rows = Array.from({ length: rnd(5) }, (_, i) => ({
          id: rnd(50) + 1 + i * 100,
          measured_at: rnd(4) === 0 ? null : `${String(9 + rnd(6)).padStart(2, '0')}:${rnd(2) === 0 ? '00' : '30'}:00`,
          temp: rnd(3) === 0 ? null : 36 + rnd(20) / 10,
          sys_bp: val(110),
          dia_bp: val(60),
          pulse: val(60),
          spo2: val(85),
        }))
        assert.deepEqual(M.latestVitalValues(rows), oldLatest(rows))
        assert.equal(M.vitalMarkText(M.latestVitalValues(rows)), M.vitalMarkText(oldLatest(rows)), '1人の画面の申し送りの文は変わらない')
      }
      // 再測定の後は、項目ごとにいちばん新しい値（1回目の体温・再測定の血圧）
      const rows = [
        { id: 1, measured_at: '09:30:00', temp: 37.8, sys_bp: 168, dia_bp: 92, pulse: 80, spo2: 96 },
        { id: 2, measured_at: '09:50:00', temp: null, sys_bp: 142, dia_bp: 84, pulse: null, spo2: null },
      ]
      assert.equal(M.vitalMarkText(M.latestVitalValues(rows)), 'バイタル 体温 37.8℃・血圧 142/84・脈 80・SpO2 96%')
    })
    it('中3: 機能訓練の印は1人1日1件（markFamilyPrefix＝tr＊）。ほかの記録は markPrefix のまま', () => {
      const fam = M.markFamilyPrefix('2026-11-10', 7, { kind: 'training', id: 42 })
      assert.equal(fam, 'dcn:2026-11-10:7:tr')
      assert.ok('dcn:2026-11-10:7:tr43:1-aa'.startsWith(fam), '入れ直して id が替わった記録の印も同じ組')
      assert.ok(!'dcn:2026-11-10:8:tr42:1-aa'.startsWith(fam), 'ほかの方の印は別')
      assert.equal(M.markFamilyPrefix('2026-11-10', 7, { kind: 'activityDay' }), M.markPrefix('2026-11-10', 7, { kind: 'activityDay' }))
      assert.equal(M.markFamilyPrefix('2026-11-10', 7, { kind: 'vital' }), 'dcn:2026-11-10:7:vital:')
      // tr で始まる記録の部分はほかに無い（組が別の記録を巻き込まない）
      for (const w of ['vital', 'lunch', 'snack', 'ex', 'acday', 'fl3', 'ac4']) assert.ok(!w.startsWith('tr'))
    })
  })

  describe('一括の印の判断（daycareNoteMarkDay.ts・動きで確かめる・2026-11-10 計画D の反証の確認）', () => {
    const D = '2026-11-10'
    const row = (id, key, body = 'x', deleted = false) => ({ note: { id, body }, clientKey: key, deleted })
    it('1人1日1件: 生きている tr43 がある時に tr42 で作らない。取り消した tr43・ほかの方・ほかの日・その日の活動は混ざらない。送信待ちの印も数える', () => {
      const tr42 = { kind: 'training', id: 42 }
      assert.equal(J.markTaken([row(1, `dcn:${D}:7:tr43:1-aa`)], [], D, 7, tr42), true, '入れ直した記録の印があれば作らない')
      assert.equal(J.markTaken([row(1, `dcn:${D}:7:tr43:1-aa`, 'x', true)], [], D, 7, tr42), false, '取り消した印は数えない')
      assert.equal(J.markTaken([], [`dcn:${D}:7:tr43:1-bb`], D, 7, tr42), true, 'この端末の送信待ちの印も数える')
      assert.equal(J.markTaken([row(1, `dcn:${D}:8:tr43:1-aa`)], [], D, 7, tr42), false, 'ほかの方')
      assert.equal(J.markTaken([row(1, `dcn:2026-11-09:7:tr43:1-aa`)], [], D, 7, tr42), false, 'ほかの日')
      assert.equal(J.markTaken([row(1, `dcn:${D}:7:acday:1-aa`)], [], D, 7, tr42), false, 'その日の活動の印は機能訓練の組ではない')
      assert.equal(J.markTaken([row(1, `dcn:${D}:7:tr43:1-aa`)], [], D, 7, { kind: 'activityDay' }), false, '機能訓練の印はその日の活動の組ではない')
      assert.equal(J.markTaken([row(1, `dcn:${D}:7:acday:2-aa`)], [], D, 7, { kind: 'activityDay' }), true)
      assert.equal(J.markTaken([row(1, `dcn:${D}:7:vital:1-aa`)], [], D, 7, { kind: 'lunch' }), false, '記録ごと（バイタルと昼食は別）')
      assert.equal(J.markTaken([row(1, `dcn:${D}:7:ac5:1-aa`)], [], D, 7, { kind: 'activityDay' }), false, '1人の画面の活動1つずつの印とは別')
    })
    it('食い違いの判断: その日の活動・機能訓練は完全一致（「。」を含む文で短くした・入れ替えた時も食い違い）。バイタルは isStale のまま', () => {
      // 機能訓練: 内容に「。」がある記録を短くした（isStale は「。」の後ろをひと言とみなして同じと言ってしまう）
      const trOld = '機能訓練 完了 10:00〜 20分 歩行。公園まで'
      const trNew = '機能訓練 完了 10:00〜 20分 歩行'
      assert.equal(M.isStale(trOld, trNew), false, '前の比べ方では食い違いに出なかった')
      assert.equal(J.markDiffers('training', trOld, trNew), true)
      assert.equal(J.markDiffers('training', trNew, trNew), false)
      assert.equal(J.markDiffers('training', trNew, null), true, '記録が無くなった')
      // その日の活動: 自由入力の項目に「。」・並びの入れ替え
      assert.equal(J.markDiffers('activityDay', '活動 体操・散歩。公園まで', '活動 体操・散歩'), true)
      assert.equal(J.markDiffers('activityDay', '活動 歌・体操', '活動 体操・歌'), true)
      assert.equal(J.markDiffers('activityDay', '活動 体操・歌', '活動 体操・歌'), false)
      // バイタル: 1人の画面でひと言を付けられる（「。」の後ろはひと言）＝今の isStale のまま
      assert.equal(J.markDiffers('vital', 'バイタル 体温 36.5℃。むせ込みあり', 'バイタル 体温 36.5℃'), false)
      assert.equal(J.markDiffers('vital', 'バイタル 体温 36.5℃', 'バイタル 体温 37.0℃'), true)
      assert.equal(J.markDiffers('vital', 'バイタル 体温 36.5℃', null), true)
    })
    it('直す案: その日の活動・機能訓練はいまの文そのもの（前の記録の「。」の後ろを付けない）。バイタルは fixProposal で「。」の後ろ（ひと言）を引き継ぐ', () => {
      const trOld = '機能訓練 完了 10:00〜 20分 歩行。公園まで'
      const trNow = '機能訓練 中止（体調不良）10:00'
      assert.equal(M.fixProposal(trOld, trNow), `${trNow}。公園まで`, '前の作りでは前の記録の切れ端が付いた')
      assert.equal(J.markFixProposal('training', trOld, trNow), trNow)
      assert.equal(J.markFixProposal('activityDay', '活動 散歩。公園まで', '活動 体操'), '活動 体操')
      assert.equal(J.markFixProposal('vital', 'バイタル 体温 36.5℃。むせ込みあり', 'バイタル 体温 37.0℃'), 'バイタル 体温 37.0℃。むせ込みあり')
      assert.equal(J.markFixProposal('vital', 'バイタル 体温 36.5℃', 'バイタル 体温 37.0℃'), 'バイタル 体温 37.0℃')
    })
    it('markState: 付いている（live）・送信待ち（pending）・止まった（stopped＝登録が止まった・付いている印への直す・外すが止まった）・無い（null）', () => {
      assert.equal(J.markStateOf({ live: true, liveChange: null, pend: null }), 'live')
      assert.equal(J.markStateOf({ live: true, liveChange: 'pending', pend: null }), 'live', '外す・直すの送信待ちは付いたまま（⚑ の ↻ で示す）')
      assert.equal(J.markStateOf({ live: true, liveChange: 'conflict', pend: null }), 'stopped')
      assert.equal(J.markStateOf({ live: true, liveChange: 'rejected', pend: null }), 'stopped')
      assert.equal(J.markStateOf({ live: false, liveChange: null, pend: 'pending' }), 'pending')
      assert.equal(J.markStateOf({ live: false, liveChange: null, pend: 'conflict' }), 'stopped')
      assert.equal(J.markStateOf({ live: false, liveChange: null, pend: 'rejected' }), 'stopped')
      assert.equal(J.markStateOf({ live: false, liveChange: null, pend: null }), null)
    })
    it('keepRow（mergeKeptRows）: 控えより前に始めた読み込みでは、送れた行を消さない・取り消した行を戻さない。後に始めた読み込みはサーバーを正として控えを外す', () => {
      const landed = row(9, `dcn:${D}:7:vital:2-zz`, 'バイタル 体温 36.5℃')
      const keptAdd = new Map([[9, { row: landed, gen: 4 }]])
      // 送る前に始めた読み込み（gen 3・4）が後から届いた: 送れた行は残す・控えも残す
      for (const g of [3, 4]) {
        const m = J.mergeKeptRows([row(1, `dcn:${D}:7:lunch:1-aa`)], keptAdd, g)
        assert.deepEqual(m.rows.map((r) => r.note.id).sort(), [1, 9])
        assert.equal(m.kept.size, 1)
      }
      // 送った後に始めた読み込み（gen 5）: サーバーが正（載っていればその行・控えは外す）
      const after = J.mergeKeptRows([row(9, landed.clientKey, 'サーバーの本文')], keptAdd, 5)
      assert.deepEqual(after.rows.map((r) => r.note.body), ['サーバーの本文'])
      assert.equal(after.kept.size, 0)
      // 取り消した行: 前に始めた読み込みが生きている行を返しても戻さない
      const removed = row(2, `dcn:${D}:7:acday:1-aa`, '活動 体操', true)
      const keptDel = new Map([[2, { row: removed, gen: 4 }]])
      const old = J.mergeKeptRows([row(2, removed.clientKey, '活動 体操', false)], keptDel, 4)
      assert.deepEqual(old.rows.map((r) => [r.note.id, r.deleted]), [[2, true]])
      const fresh = J.mergeKeptRows([row(2, removed.clientKey, '活動 体操', true)], keptDel, 5)
      assert.deepEqual(fresh.rows.map((r) => [r.note.id, r.deleted]), [[2, true]])
      assert.equal(fresh.kept.size, 0)
    })
    it('〔申し送りを直す〕を送る前の確かめ（fixTargetUnchanged）: 生きていて本文が見た時のままの時だけ送る', () => {
      const rows = [row(3, `dcn:${D}:7:tr42:1-aa`, '機能訓練 完了 10:00〜 20分 歩行')]
      assert.equal(J.fixTargetUnchanged(rows, 3, '機能訓練 完了 10:00〜 20分 歩行'), true)
      assert.equal(J.fixTargetUnchanged(rows, 3, '機能訓練 完了 10:00〜 20分 歩行。'), false, 'ほかの端末で本文が変わった')
      assert.equal(J.fixTargetUnchanged([{ ...rows[0], deleted: true }], 3, rows[0].note.body), false, '取り消された')
      assert.equal(J.fixTargetUnchanged(rows, 4, 'x'), false, '見当たらない')
    })
    it('テンキーの1行の選び方: 押せなかった理由（場の鍵が同じ間）→ その方の印の操作で出た結果（欄を移るまで）→ 案内（null）。前の知らせ・結果でない知らせは出さない', () => {
      const base = { key: 'dc:2026-11-10:7:1', field: 'sys_bp', buf: '', mark: 'live:5:20:0' }
      const noteKey = J.keypadNoteKey(base)
      const opKey = J.keypadOpKey(base)
      const msgs = [
        { seq: 3, text: '前に出た失敗', result: true },
        { seq: 6, text: '別の端末が先に申し送りにしていました（申し送りは1件のままです）。' },
        { seq: 7, text: '申し送り：電波が届かないため…', result: true, queued: true },
        { seq: 8, text: '外せませんでした。', result: true },
      ]
      const line = (p) => J.keypadMarkLine({ note: null, op: null, noteKey, opKey, msgs, stillQueued: true, stopped: null, ...p })
      // 押せなかった理由がいちばん先
      assert.equal(line({ note: { text: '打ちかけの値を確定してから押してください。', at: noteKey }, op: { since: 5, at: opKey } }), '打ちかけの値を確定してから押してください。')
      // 押せなかった理由は、欄・打ちかけの値・印の状態のどれかが変わると出さない（鍵が変わる）
      for (const changed of [{ buf: '1' }, { field: 'dia_bp' }, { key: 'dc:2026-11-10:8:1' }, { mark: 'null:0:0:0' }]) {
        const k2 = J.keypadNoteKey({ ...base, ...changed })
        assert.notEqual(k2, noteKey)
        assert.equal(J.keypadMarkLine({ note: { text: '理由', at: noteKey }, op: null, noteKey: k2, opKey, msgs, stillQueued: true, stopped: null }), null)
      }
      // 操作の結果: テンキーを開いている間にその方の印の操作で出たもの（since より後・result）の新しい方
      assert.equal(line({ op: { since: 5, at: opKey } }), '外せませんでした。')
      assert.equal(line({ op: { since: 5, at: opKey }, msgs: msgs.slice(0, 3) }), '申し送り：電波が届かないため…')
      // 送信待ちにした旨は、送信待ちが残る間だけ
      assert.equal(line({ op: { since: 5, at: opKey }, msgs: msgs.slice(0, 3), stillQueued: false }), null)
      // 止まった印は操作の後に出す
      assert.equal(line({ op: { since: 5, at: opKey }, msgs: [], stopped: '申し送りが止まっています。' }), '申し送りが止まっています。')
      // 操作していない（前に出た知らせ・別の端末が先に…）は出さない＝案内の行
      assert.equal(line({}), null)
      assert.equal(line({ op: { since: 8, at: opKey } }), null, 'since より前の知らせは出さない')
      // 欄を移ったら操作の結果は出さない（打ちかけの値が変わっても欄の間は出す）
      assert.equal(J.keypadOpKey({ ...base, buf: '12' }), opKey)
      assert.equal(line({ op: { since: 5, at: J.keypadOpKey({ ...base, field: 'pulse' }) } }), null)
    })
    it('テンキーの物理キー（keypadKeyAction）: 確認の小窓・入れる欄・選択肢の中のキーは受け取らない（Enter・Esc を小窓に渡す）。ほかは今と同じ', () => {
      for (const k of ['Enter', 'Escape', '1', 'Backspace']) assert.equal(J.keypadKeyAction(k, { tag: 'BUTTON', inDialog: true }), null, `小窓の中の ${k}`)
      for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(J.keypadKeyAction('1', { tag, inDialog: false }), null, tag)
      const ctx = { tag: 'BODY', inDialog: false }
      assert.equal(J.keypadKeyAction('1', ctx), '1')
      assert.equal(J.keypadKeyAction('１', ctx), '1', '全角の数字')
      assert.equal(J.keypadKeyAction('.', ctx), '.')
      assert.equal(J.keypadKeyAction('。', ctx), '.')
      assert.equal(J.keypadKeyAction('Backspace', ctx), 'back')
      assert.equal(J.keypadKeyAction('Enter', ctx), 'next')
      assert.equal(J.keypadKeyAction('Escape', ctx), 'close')
      assert.equal(J.keypadKeyAction('a', ctx), null)
      assert.equal(J.keypadKeyAction('Tab', ctx), null)
      // 画面: 判断はキーの処理（press）の前の1か所だけ（ほかにキーを見る所が無い）
      const vm = code('../src/pages/DaycareVitalsMealsPage.tsx')
      const onKey = vm.slice(vm.indexOf('const onKey = (e: KeyboardEvent) => {'), vm.indexOf("window.addEventListener('keydown', onKey)"))
      assert.match(onKey, /^const onKey = \(e: KeyboardEvent\) => \{\s+const t = e\.target as HTMLElement \| null\s+(\s*)const act = keypadKeyAction\(e\.key, \{ tag: t\?\.tagName \?\? null, inDialog: t instanceof Element && t\.closest\('\[role="dialog"\]'\) !== null \}\)\s+if \(act === null\) return\s+e\.preventDefault\(\)\s+press\(act\)\s+\}\s*$/)
      assert.doesNotMatch(onKey, /e\.key ===|toHalfWidth/)
    })
  })

  describe('fetchDaycareDayNotes（偽の Supabase・通信しない）', () => {
    it('日・区分「デイ」で絞り、鍵では絞らない（手で書いたデイの申し送りも読む）。取り消した行も読む・日と区分の違う行は捨てる・書き込みはしない', async () => {
      const calls = []
      const base = { facility: null, category: null, role_tags: [], importance: 'normal', occurred_at: null, ongoing: false, ended_at: null, ended_by: null, reporter_id: 1, color: null, after16: false, categories: [], rev: 1, created_at: 'x' }
      const rows = [
        { ...base, id: 1, note_on: '2026-11-10', shift: 'daycare', resident_id: 7, body: '活動 体操', client_key: 'dcn:2026-11-10:7:acday:1-aa', deleted_at: '2026-11-10T03:00:00Z' },
        { ...base, id: 2, note_on: '2026-11-10', shift: 'daycare', resident_id: 7, body: '活動 体操・歌', client_key: 'dcn:2026-11-10:7:acday:2-bb', deleted_at: null },
        { ...base, id: 3, note_on: '2026-11-10', shift: 'daycare', resident_id: null, body: '送迎の車の点検', client_key: null, deleted_at: null },
        // 受信した行を信じない（ロールバックされたサーバー・読み違い）: 別の日・別の区分の行は捨てる
        { ...base, id: 4, note_on: '2026-11-09', shift: 'daycare', resident_id: 7, body: 'x', client_key: 'dcn:2026-11-09:7:lunch:1', deleted_at: null },
        { ...base, id: 5, note_on: '2026-11-10', shift: 'day', resident_id: 7, body: 'y', client_key: null, deleted_at: null },
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
          limit(n) {
            q.limit = n
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
      const r = await DB.fetchDaycareDayNotes('2026-11-10')
      assert.deepEqual(
        r.map((x) => [x.note.id, x.clientKey, x.deleted]),
        [
          [1, 'dcn:2026-11-10:7:acday:1-aa', true],
          [2, 'dcn:2026-11-10:7:acday:2-bb', false],
          [3, null, false],
        ],
      )
      const notes = calls.filter((c) => c.table === 'notes')
      assert.equal(notes.length, 1, '読み込みは1本')
      const q = notes[0]
      assert.match(q.cols, /,client_key,deleted_at$/)
      const has = (op, k, v) => q.filters.some(([o, kk, vv]) => o === op && kk === k && vv === v)
      assert.ok(has('eq', 'note_on', '2026-11-10'))
      assert.ok(has('eq', 'shift', 'daycare'))
      assert.ok(!q.filters.some(([o, k]) => o === 'like' || (o === 'eq' && k === 'resident_id')), 'その日の全員・鍵で絞らない')
      assert.ok(!q.filters.some(([o, k]) => o === 'is' && k === 'deleted_at'), '取り消した申し送りも読む（印の世代を数える）')
      assert.ok(Number.isInteger(q.limit) && q.limit >= 500, '1日分の上限')
      assert.ok(calls.every((c) => c.action === 'select'), '読むだけ')
      await assert.rejects(() => DB.fetchDaycareDayNotes('2026/11/10'), '日の形が違えば読まない')
      DB.__testHooks.setClient(null)
    })
  })

  describe('静的検査（計画D の規律）', () => {
    const day = code('../src/components/DaycareNoteMarkDay.tsx')
    const person = code('../src/components/DaycareNoteMark.tsx')
    const pure = code('../src/lib/daycareNoteMarkDay.ts')
    it('一括の印の部品: 申し送りへの書き込みは既存の insertNote・deleteNote・saveNoteEdits だけ（1人の画面と同じ3つ）・supabase・端末の保存・console を使わない。判断の純関数は何も書かない', () => {
      assert.deepEqual(writesOf(day), ['deleteNote', 'insertNote', 'saveNoteEdits'])
      assert.deepEqual(writesOf(day), writesOf(person))
      assert.doesNotMatch(day, /supabase|\.from\(|\.rpc\(|localStorage|console\./)
      assert.doesNotMatch(pure, /supabase|localStorage|console\.|from '\.\/db/)
      assert.deepEqual(writesOf(pure), [])
      // 1人の画面と同じ申し送りの形（区分デイ・「16時以降」は付けない・分類は記録の種類から・記録日が今日の時だけ今の時刻・ひと言なし）
      assert.match(day, /shift: 'daycare' as const,/)
      assert.match(day, /after16: false,/)
      assert.match(day, /markCategories\(rec\.kind\)\.length > 0 \? \{ categories: markCategories\(rec\.kind\) \} : \{\}/)
      assert.match(day, /occurred_at: noteTimeFor\(d, 'daycare', new Date\(\)\),/)
      assert.match(day, /const body = markBody\(text, ''\)/)
      assert.match(day, /const clientKey = markKey\(d, rid, rec, gen, token\)\s+const res = await insertNote\(payload, \{ clientKey \}\)/)
      assert.match(day, /const token = Math\.random\(\)\.toString\(36\)\.slice\(2, 10\) \|\| '0'/)
      assert.match(day, /deleteNote\(\{ id: row\.note\.id \}, row\.note, \{ meta: noteMetaOf\(row\.note\), editedBy: actorRef\.current \}\)/)
      assert.match(day, /\{ body: \{ value: full\.trim\(\), base: row\.note\.body \} \}/)
      for (const re of [/shift: 'daycare' as const,/, /after16: false,/, /occurred_at: noteTimeFor\(d, 'daycare', new Date\(\)\),/, /\{ body: \{ value: full\.trim\(\), base: row\.note\.body \} \}/]) assert.match(person, re)
    })
    it('送る直前に読み直して世代を決める・1人1日1件の判断（markTaken）で2件目を作らない・読めていなければ付けない・続けて2回押しても1件', () => {
      const add = day.slice(day.indexOf('const sendAdd'), day.indexOf('const offCls'))
      assert.match(add, /const fresh = await load\(d\)/)
      assert.match(add, /if \(known === null\) \{\s+say\(k, \{ tone: 'warn', text: MSG_NOT_READ, result: true \}\)/)
      // 2026-11-10 計画D の反証の確認（固定し直し・意図は同じ）: 判断は純関数 markTaken（動きは上の試験）
      assert.match(add, /if \(markTaken\(known, pendingDaycareNoteMarks\(markDayPrefix\(d, rid\)\)\.map\(\(p\) => p\.clientKey\), d, rid, rec\)\) \{/)
      assert.match(add, /const gen = nextGen\(prefix, keys\)/)
      assert.match(add, /if \(busyRef\.current\.has\(k\)\) return\s+setBusyKey\(k, true\)/)
      assert.match(day, /const prefix = markFamilyPrefix\(day, rid, rec\)\s+return rows\.filter/)
      assert.match(day, /const pendOf = \(rid: number, rec: MarkRecord\) => pendAll\.find\(\(p\) => p\.clientKey\.startsWith\(markFamilyPrefix\(day, rid, rec\)\)\) \?\? null/)
      assert.match(day, /void sendAdd\(rid, day, rec, text, name\)/)
      assert.doesNotMatch(add, /const rid = |const d = /)
    })
    it('送れた時だけ〔元に戻す〕（8秒）。送信待ちの間は出さない。〔元に戻す〕は〔外す〕と同じ取り消し。送れた・外した・直した行は控えて、読み直しの失敗・古い読み込みで消さない', () => {
      const add = day.slice(day.indexOf('const sendAdd'), day.indexOf('const offCls'))
      const iQueued = add.indexOf("if (res === 'queued') {")
      const iShow = add.indexOf('show(')
      assert.ok(iQueued > 0 && iShow > iQueued, '送信待ちの分岐で返してから知らせる')
      assert.doesNotMatch(add.slice(iQueued, add.indexOf('return', iQueued)), /show\(/)
      assert.match(add, /show\(`\$\{name\}さんの\$\{MARK_KIND_LABEL\[rec\.kind\]\}を申し送りにしました`, \(\) => void sendRemove\(rid, d, rec, landed, name\)\)/)
      assert.match(add, /keepRow\(d, landed\)\s+await load\(d\)/)
      // 2026-11-10 計画D の反証の確認（固定し直し・意図は同じ）: 控え（keptRef）を読み込みに重ねる（mergeKeptRows・動きは上の試験）
      assert.match(day, /const k: KeptRow<DaycareNoteMarkRow> = \{ row, gen: genRef\.current \}\s+keptRef\.current\.set\(row\.note\.id, k\)/)
      assert.match(day, /const merged = mergeKeptRows\(read, keptRef\.current, gen\)\s+keptRef\.current = merged\.kept/)
      assert.match(day, /keepRow\(d, \{ \.\.\.row, deleted: true \}\)\s+await load\(d\)/)
      assert.match(day, /keepRow\(d, \{ \.\.\.row, note: res\.row \?\? \{ \.\.\.row\.note, body: full\.trim\(\) \} \}\)/)
      assert.match(day, /<ConfirmDialog\s+open=\{delRow !== null\}\s+title="申し送りの印を外しますか"/)
      assert.match(person, /title="申し送りの印を外しますか"/)
    })
    it('外す・直す操作を送信待ちにした時の知らせは queued（届いたら消える）・操作の結果（result）として出す', () => {
      assert.match(day, /text: `印を外す：\$\{queuedText\(\)\}`, result: true, queued: true \}/)
      assert.match(day, /text: `申し送りを直す：\$\{queuedText\(\)\}`, result: true, queued: true \}/)
      assert.match(day, /text: `申し送り：\$\{queuedText\(\)\}`, result: true, queued: true \}/)
      assert.match(day, /const stillQueued = \(pend !== null && pend\.state === 'pending'\) \|\| \(pendDel !== null && pendDel\.state === 'pending'\)/)
      assert.match(day, /if \(m\.queued === true && !stillQueued\) continue/)
      // 「別の端末が先に…」は結果ではない（テンキーの1行に出さない）
      assert.match(day, /say\(k, \{ tone: 'info', text: '別の端末が先に申し送りにしていました（申し送りは1件のままです）。' \}\)/)
    })
    it('17時のロック・記録者・旗は1人の画面と同じ。付いた印〔⚑〕も〔申し送りを直す〕も、直す・外すの送信待ち・止まり・付け外しできない時は押せない（反証の確認 軽4・軽5）', () => {
      assert.match(day, /const lockedForMe = lockState\(day, 'daycare', false, now\)\.locked && !canUnlockNotes\(role\)/)
      assert.match(day, /if \(lockedForMe\) return MSG_LOCKED_FIELD/)
      assert.match(day, /if \(actorRef\.current === null\) return MSG_NO_RECORDER/)
      assert.match(day, /if \(!canWrite\) return blockedReason \?\? '入力できない状態です。'/)
      assert.match(day, /isNoteLockedError\(e\) \? NOTE_LOCKED_MESSAGE/)
      const on = day.slice(day.indexOf('if (rec !== null && live !== null) {'), day.indexOf('if (rec !== null && pend !== null) {'))
      assert.match(on, /const hold = changeHold\(live\)/)
      assert.match(on, /const reason = hold\.reason \?\? \(isBusy \? '送信中です。' : precheck\(\)\)/)
      assert.match(day, /const fixWhy = changeHold\(live\)\.reason \?\? \(busy\.has\(k\) \? '送信中です。' : precheck\(\)\)/)
      assert.match(day, /\{\.\.\.blockProps\(fixWhy, k, undefined, \(\) => setFixRow\(/)
      // 送信待ちでも止まりでも（外すだけでなく直すも）
      assert.match(day, /return \{ reason: stopped \? MSG_CHANGE_STOPPED : MSG_CHANGE_PENDING, removing: hasOwn\(p\.values, 'deleted_at'\), stopped \}/)
    })
    it('押せない時の出し方は1つ（blockProps）: disabled にせず aria-disabled、押すと理由（テンキーは onBlocked＝テンキーの1行・一括の画面は行の下）。見た目は ⚐ も ⚑ も ink3', () => {
      assert.match(day, /reason === null\s+\? \{ onClick: onPress \}\s+: \{ 'aria-disabled': true as const, onClick: \(\) => \(onBlocked !== undefined \? onBlocked\(reason\) : say\(k, \{ tone: 'warn', text: reason \}\)\) \}/)
      assert.doesNotMatch(day, /(?<!-)\bdisabled[=:]/, 'disabled は使わない（aria-disabled だけ）')
      assert.match(day, /const offCls =\s+'inline-flex min-h-tap items-center whitespace-nowrap rounded border border-border-strong bg-surface px-2 text-sm text-ink aria-disabled:text-ink3'/)
      assert.match(day, /const onCls = 'inline-flex min-h-tap items-center whitespace-nowrap rounded border-2 border-warn bg-warn-bg px-2 text-sm font-bold text-ink aria-disabled:text-ink3'/)
      assert.equal((day.match(/\{\.\.\.blockProps\(/g) ?? []).length, 4, '⚑・送信待ちの⚑・⚐・〔申し送りを直す〕')
      assert.match(day, /<span aria-hidden="true">⚐ <\/span>申し送り/)
      assert.match(day, /<span aria-hidden="true">⚑ <\/span>\s*\{onLabel\}/)
      assert.match(day, /const label = off !== null \? `\$\{name\}さんの\$\{what\}を申し送りにできません。\$\{off\}`/)
    })
    it('記録と違う: 比べ方と直す案は純関数（markDiffers・markFixProposal）。「⚑ 申し送り ⓘ」と行の下に〔申し送りを直す〕（確認のあと、送る直前に読み直して本文が見た時のままなら saveNoteEdits）', () => {
      assert.match(day, /const stale = known && markDiffers\(rec\.kind, live\.note\.body, text\)/)
      assert.match(day, /\{stale \? <span aria-hidden="true"> ⓘ<\/span> : null\}/)
      assert.match(day, /if \(live !== null && rec !== null && known && markDiffers\(rec\.kind, live\.note\.body, text\)\) items\.push/)
      assert.match(day, /full: markFixProposal\(rec\.kind, live\.note\.body, text\)/)
      assert.doesNotMatch(day, /\bisStale\(|\bfixProposal\(/, '比べ方・案は純関数を通す')
      assert.match(read('../src/components/DaycareNoteMark.tsx'), /申し送りの文が、いまの記録と違います（申し送りは前の内容のまま。元の記録か申し送りが直されました）。/)
      assert.match(day, /const MSG_STALE = '申し送りの文が、いまの記録と違います（申し送りは前の内容のまま。元の記録か申し送りが直されました）。'/)
      // 反証の確認 軽6: 送る直前に読み直し、本文が変わっていたら送らずに知らせる（画面の印は読み直しで新しくなる）
      const fix = day.slice(day.indexOf('const sendFix'), day.indexOf('const sendAdd'))
      assert.match(fix, /const fresh = await load\(d\)[\s\S]*?if \(known !== null && !fixTargetUnchanged\(known, row\.note\.id, row\.note\.body\)\) \{\s+say\(k, \{ tone: 'warn', text: MSG_FIX_CHANGED, result: true \}\)\s+return/)
      assert.ok(fix.indexOf('fixTargetUnchanged') < fix.indexOf('saveNoteEdits('), '確かめてから送る')
      assert.match(day, /const MSG_FIX_CHANGED = 'ほかの端末で申し送りが変わりました。もう一度確かめてください。'/)
      assert.match(code('../src/pages/DaycareActivityBulkPage.tsx'), /marks\.note\(rid, \{ kind: 'activityDay' \}, name, dayText, readable\)/)
      assert.match(code('../src/pages/DaycareTrainingPage.tsx'), /marks\.note\(rid, markRec, name, markText, data\.sessions !== null\)/)
      assert.match(code('../src/pages/DaycareVitalsMealsPage.tsx'), /marks\.note\(row\.residentId, \{ kind: 'vital' \}, nameOf\(row\.residentId\), vitalTextOf\(row\.residentId\)\)/)
    })
    it('印の読み込みはその日の全員分を1本（fetchDaycareDayNotes）・Realtime の購読は足さない・端末に残さない', () => {
      assert.equal((day.match(/fetchDaycareDayNotes\(/g) ?? []).length, 1)
      assert.match(day, /if \(d !== dayRef\.current\) return read/)
      assert.match(day, /if \(gen > appliedRef\.current\) \{\s+appliedRef\.current = gen\s+setMarks\(\{ day: d, rows: merged\.rows \}\)/)
      assert.doesNotMatch(day, /fetchDaycareNoteMarks\(|subscribeChanges|subscribeDaycare/)
      assert.match(person, /const rows = await fetchDaycareNoteMarks\(d, rid\)/)
      assert.doesNotMatch(person, /fetchDaycareDayNotes/)
    })
    it('markState は止まった印を分ける（stopped）。バイタル・食事の行の印は「⚑」「⚑↻」「⚑▲」（読み上げは別に）', () => {
      assert.match(day, /return markStateOf\(\{ live: live !== null, liveChange: change === null \? null : change\.state, pend: pend === null \? null : pend\.state \}\)/)
      const vm = code('../src/pages/DaycareVitalsMealsPage.tsx')
      assert.match(vm, /\{markMk === 'pending' \? '⚑↻' : markMk === 'stopped' \? '⚑▲' : '⚑'\}/)
      assert.match(vm, /markMk === 'stopped' \? '（申し送りは止まっています）'/)
    })
    it('活動一括・機能訓練の画面: 申し送りへは書かない（印の部品を置くだけ）・行の右に申し送りの列・知らせの行に印の知らせ', () => {
      for (const [path, rec] of [
        ['../src/pages/DaycareActivityBulkPage.tsx', /rec: \{ kind: 'activityDay' \},/],
        ['../src/pages/DaycareTrainingPage.tsx', /rec: markRec,/],
      ]) {
        const p = code(path)
        assert.doesNotMatch(p, /\b(insertNote|deleteNote|saveNoteEdits)\(/, path)
        assert.match(p, /const marks = useDaycareNoteMarksDay\(\{/, path)
        assert.match(p, /\{marks\.dialogs\}/, path)
        assert.match(p, rec, path)
        // 押せない時は行の下に理由（onBlocked を渡さない）
        assert.doesNotMatch(p.slice(p.indexOf('marks.button({'), p.indexOf('})}', p.indexOf('marks.button({'))), /onBlocked/, path)
        const head = p.slice(p.indexOf('<thead>'), p.indexOf('</thead>'))
        assert.match(head, /<th scope="col" className="sticky top-0 z-20 bg-surface2 px-1 py-2 text-sm font-bold text-ink2">\s*申し送り\s*<\/th>\s*<\/tr>/, `${path}: 申し送りの列は右の端`)
        assert.match(p, /\{markNote\}/, path)
        assert.match(p, /\|\| markNote !== null/, path)
      }
      const act = code('../src/pages/DaycareActivityBulkPage.tsx')
      assert.match(act, /const dayText = readable \? activityDayMarkText\(activitiesOf\(data\.activities \?\? \[\], rid, day\)\.map\(\(a\) => activityText\(a\)\)\) : null/)
      assert.match(act, /blockedReason: canWrite \? null : precheck\(\)/)
      const tr = code('../src/pages/DaycareTrainingPage.tsx')
      assert.match(tr, /const markRec: MarkRecord \| null = marks\.liveRecord\(rid, 'training'\) \?\? \(s !== null \? \{ kind: 'training', id: s\.id \} : null\)/)
      assert.match(tr, /const markText = s !== null \? trainingMarkText\(sessionText\(s\)\) : null/)
      assert.match(tr, /const markWritable = gateOk && !missing/)
    })
    it('反証 軽4: 活動一括・機能訓練も、その方のその日の記録に保存中・送信待ち・止まった変更がある間は⚐を押せない（理由は title・読み上げ・押すと行の下）', () => {
      const act = code('../src/pages/DaycareActivityBulkPage.tsx')
      assert.match(act, /return c\.waiting \|\| c\.deleting \|\| c\.stopped\.length > 0 \|\| busy\.has\(`\$\{day\}:\$\{rid\}:\$\{l\}`\)/)
      assert.match(act, /: running\s+\? 'まとめて入れている間は、申し送りにできません。'\s+: actUnsent\s+\? '活動に保存中・送信待ち・止まった変更があるため、申し送りにできません（届いてから押してください）。'/)
      assert.doesNotMatch(act, /送信待ちの活動は文に入れない/)
      const tr = code('../src/pages/DaycareTrainingPage.tsx')
      assert.match(tr, /: p !== undefined\s+\? '機能訓練の記録の変更が送信待ち・止まっているため、申し送りにできません（届いてから押してください）。'\s+: busy\s+\? '保存している間は、申し送りにできません。'/)
    })
    it('今日の画面: カードの状態の段の右に「⚑n」（0件は出さない・押せない表示）。帯には足さない。読み込みは1本・今の購読の notes で数だけ読み直す（その日のデイの行の時だけ）', () => {
      const today = code('../src/pages/DaycarePage.tsx')
      assert.doesNotMatch(today, /\b(insertNote|deleteNote|saveNoteEdits)\(/)
      assert.equal((today.match(/fetchDaycareDayNotes\(/g) ?? []).length, 1)
      assert.match(today, /if \(r\.deleted \|\| rid === null\) continue\s+byResident\.set\(rid, \(byResident\.get\(rid\) \?\? 0\) \+ 1\)/)
      const list = today.slice(today.indexOf('<ul className="dc-cards"'), today.indexOf('</ul>', today.indexOf('<ul className="dc-cards"')))
      assert.match(list, /\{tone\.word\}\s*(\{\}\s*)?\{noteN > 0 \? \(\s*<span title=\{`申し送り \$\{noteN\}件`\} className="ml-1 whitespace-nowrap">\s*<span aria-hidden="true">⚑\{noteN\}<\/span>\s*<span className="sr-only">・申し送り \{noteN\}件<\/span>\s*<\/span>\s*\) : null\}\s*<\/p>/)
      assert.equal((list.match(/<button/g) ?? []).length, 2, 'カードのボタンは〔休み〕〔取消〕のまま')
      assert.match(today, /・⚑ 申し送り（数）<\/p>/)
      const tiles = today.slice(today.indexOf('const tiles: '), today.indexOf('const noteCountOf'))
      assert.doesNotMatch(tiles, /申し送り/)
      assert.match(today, /else if \(table === 'notes' && \(!info\?\.row \|\| \(info\.row\.shift === 'daycare' && info\.row\.note_on === dayRef\.current\)\)\) scheduleNoteCount\(\)/)
      assert.equal((today.match(/\bsubscribe(Changes|DaycareChanges|BathChanges|DaycareActivityChanges)\(/g) ?? []).length, 4)
      const load = today.slice(today.indexOf('const load = useCallback'), today.indexOf('const loadNoteCount'))
      assert.doesNotMatch(load, /fetchDaycareDayNotes/)
    })
    it('バイタル・食事の画面: テンキーの見出しの段に〔⚐ 申し送り〕（全部の回から項目ごとに最新の値＝1人の画面と同じ文・鍵は vital）。1行の選び方は keypadMarkLine', () => {
      const vm = code('../src/pages/DaycareVitalsMealsPage.tsx')
      assert.doesNotMatch(vm, /\b(insertNote|deleteNote|saveNoteEdits)\(/)
      assert.match(vm, /const marks = useDaycareNoteMarksDay\(\{/)
      assert.match(vm, /refreshKey: reloadKey,\s+show: lunch\.show,\s+\}\)/)
      assert.match(vm, /\{marks\.dialogs\}/)
      assert.match(vm, /const vitalTextOf = \(rid: number\): string \| null => vitalMarkText\(latestVitalValues\(data\.live\.filter\(\(v\) => v\.resident_id === rid\)\)\)/)
      const pp = code('../src/pages/DaycarePersonPage.tsx')
      assert.match(pp, /const latestVals = latestVitalValues\(data\.vitals\.filter\(\(v\) => v\.resident_id === residentId\)\)\s+const latestOf = \(f: DaycareVitalField\): number \| null => latestVals\[f\]/)
      const kp = vm.slice(vm.indexOf('const keypad ='), vm.indexOf('<div className="flex gap-gap">', vm.indexOf('const keypad =')))
      assert.match(kp, /<span className="font-bold">\{nameOf\(active\.residentId\)\}<\/span>/, '全文の氏名はテンキーの見出し')
      assert.match(kp, /\{marks\.button\(\{\s+residentId: active\.residentId,\s+name: nameOf\(active\.residentId\),\s+rec: \{ kind: 'vital' \},\s+text: markOfActive\.text,\s+why: markOfActive\.why,\s+onLabel: '申し送り済み',\s+onBlocked: \(r\) => setKpNote\(\{ text: r, at: kpNoteKey \}\),\s+onAction: \(since\) => setKpOp\(\{ since, at: kpOpKey \}\),\s+widthCls: 'w-40 shrink-0 justify-center',\s+\}\)\}/)
      assert.match(kp, /<div className="flex items-center justify-between gap-gap">\s*<p className="min-w-0 flex-1 text-base text-ink">/)
      assert.match(kp, /<p className="min-w-28 shrink-0 text-right font-num text-2xl font-bold text-ink">/)
      assert.match(kp, /kpMarkLine !== null && !umBusy\.has\(umKey\(activeSlot, active\.field\)\) \? \(\s*<p className="truncate text-sm text-ink" title=\{kpMarkLine\}>/)
      // 反証の確認 軽2: 1行の選び方は純関数（押せなかった理由 → その方の印の操作の結果 → 案内）。場の鍵は欄・打ちかけの値・印の状態
      assert.match(vm, /const kpNoteKey = keypadNoteKey\(\{ key: active\?\.key \?\? null, field: active\?\.field \?\? null, buf, mark: kpInfo\?\.sig \?\? '' \}\)/)
      assert.match(vm, /const kpOpKey = keypadOpKey\(\{ key: active\?\.key \?\? null, field: active\?\.field \?\? null \}\)/)
      assert.match(vm, /keypadMarkLine\(\{ note: kpNote, op: kpOp, noteKey: kpNoteKey, opKey: kpOpKey, msgs: kpInfo\.msgs, stillQueued: kpInfo\.stillQueued, stopped: kpInfo\.stopped \}\)/)
      assert.doesNotMatch(vm, /setKpNote\(null\)|messageOf/)
      const mk = vm.slice(vm.indexOf('const markOfActive'), vm.indexOf('const kpInfo'))
      assert.match(mk, /buf !== ''\s+\? '打ちかけの値を確定してから押してください。'/)
      assert.match(mk, /slotsOf\(active\.residentId\)\.some\(\(s\) => Object\.keys\(drafts\.get\(s\.key\) \?\? \{\}\)\.length > 0 \|\| pendingRow\('vitals', targetOf\(s\)\) !== null\)/)
      const body = vm.slice(vm.indexOf('<tbody>'), vm.indexOf('</tbody>'))
      assert.doesNotMatch(body, /marks\.button\(/)
      assert.match(body, /<span className="min-w-0 truncate">\{nameOf\(row\.residentId\)\}<\/span>/)
      assert.match(body, /const markMk = marks\.markState\(row\.residentId, \{ kind: 'vital' \}\)/)
      assert.match(body, /\{lunchNotes\}\s*\{markNote\}/)
    })
  })
}
