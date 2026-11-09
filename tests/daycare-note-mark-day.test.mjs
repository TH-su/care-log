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
    it('一括の印の部品: 申し送りへの書き込みは既存の insertNote・deleteNote だけ（直すのは1人の画面＝saveNoteEdits を使わない）・supabase・端末の保存・console を使わない', () => {
      assert.deepEqual(writesOf(day), ['deleteNote', 'insertNote'])
      assert.doesNotMatch(day, /supabase|\.from\(|\.rpc\(|localStorage|console\./)
      // 1人の画面と同じ申し送りの形（区分デイ・「16時以降」は付けない・分類は記録の種類から・記録日が今日の時だけ今の時刻・ひと言なし）
      assert.match(day, /shift: 'daycare' as const,/)
      assert.match(day, /after16: false,/)
      assert.match(day, /markCategories\(rec\.kind\)\.length > 0 \? \{ categories: markCategories\(rec\.kind\) \} : \{\}/)
      assert.match(day, /occurred_at: noteTimeFor\(d, 'daycare', new Date\(\)\),/)
      assert.match(day, /const body = markBody\(text, ''\)/)
      assert.match(day, /const clientKey = markKey\(d, rid, rec, gen, token\)\s+const res = await insertNote\(payload, \{ clientKey \}\)/)
      assert.match(day, /const token = Math\.random\(\)\.toString\(36\)\.slice\(2, 10\) \|\| '0'/)
      // 〔外す〕・〔元に戻す〕は見た行（F09）
      assert.match(day, /deleteNote\(\{ id: row\.note\.id \}, row\.note, \{ meta: noteMetaOf\(row\.note\), editedBy: actorRef\.current \}\)/)
      // 1人の画面の部品と同じ申し送りの形（片方だけ変えない）
      for (const re of [/shift: 'daycare' as const,/, /after16: false,/, /occurred_at: noteTimeFor\(d, 'daycare', new Date\(\)\),/]) assert.match(person, re)
    })
    it('送る直前に読み直して世代を決める・生きている印があれば2件目を作らない・読めていなければ付けない・続けて2回押しても1件', () => {
      const add = day.slice(day.indexOf('const sendAdd'), day.indexOf('const offCls'))
      assert.match(add, /const fresh = await load\(d\)/)
      assert.match(add, /if \(known === null\) \{\s+say\(k, \{ tone: 'warn', text: MSG_NOT_READ \}\)/)
      assert.match(add, /if \(known\.some\(\(r\) => !r\.deleted && r\.clientKey\.startsWith\(prefix\)\)\) \{/)
      assert.match(add, /const gen = nextGen\(prefix, keys\)/)
      assert.match(add, /pendingDaycareNoteMarks\(markDayPrefix\(d, rid\)\)/)
      assert.match(add, /if \(busyRef\.current\.has\(k\)\) return\s+setBusyKey\(k, true\)/)
      // 送り先は押した時の人・日（表示中の日を後から読まない）
      assert.match(day, /void sendAdd\(rid, day, rec, text, name\)/)
      assert.doesNotMatch(add, /const rid = |const d = /)
    })
    it('送れた時だけ〔元に戻す〕（8秒・画面の知らせ）。送信待ちの間は出さない。〔元に戻す〕は〔外す〕と同じ取り消し', () => {
      const add = day.slice(day.indexOf('const sendAdd'), day.indexOf('const offCls'))
      const iQueued = add.indexOf("if (res === 'queued') {")
      const iShow = add.indexOf('show(')
      assert.ok(iQueued > 0 && iShow > iQueued, '送信待ちの分岐で返してから知らせる')
      assert.doesNotMatch(add.slice(iQueued, add.indexOf('return', iQueued)), /show\(/)
      assert.match(add, /show\(`\$\{name\}さんの\$\{MARK_KIND_LABEL\[rec\.kind\]\}を申し送りにしました`, \(\) => void sendRemove\(rid, d, rec, landed, name\)\)/)
      // 「⚑ 申し送り」をもう一度押すと〔外す〕の確認（1人の画面と同じ題・ボタン）
      assert.match(day, /onClick=\{\(\) => setDelRow\(\{ rid, d: day, rec, row: live, name \}\)\}/)
      assert.match(day, /<ConfirmDialog\s+open=\{delRow !== null\}\s+title="申し送りの印を外しますか"/)
      assert.match(person, /title="申し送りの印を外しますか"/)
    })
    it('17時のロック・記録者・旗は1人の画面と同じ（現場のログインは記録日の 17:00 から付け外しできない）', () => {
      assert.match(day, /const lockedForMe = lockState\(day, 'daycare', false, now\)\.locked && !canUnlockNotes\(role\)/)
      assert.match(day, /if \(lockedForMe\) return MSG_LOCKED_FIELD/)
      assert.match(day, /if \(actorRef\.current === null\) return MSG_NO_RECORDER/)
      assert.match(day, /if \(!canWrite\) return blockedReason \?\? '入力できない状態です。'/)
      assert.match(day, /isNoteLockedError\(e\) \? NOTE_LOCKED_MESSAGE/)
    })
    it('見た目: 押す所 44px・文字 15px・旗の記号と文字（⚐ 申し送り → ⚑ 申し送り＝注意の淡地＋太字）。押せない時は理由を title と読み上げで', () => {
      assert.match(day, /const offCls =\s+'inline-flex min-h-tap items-center whitespace-nowrap rounded border border-border-strong bg-surface px-2 text-sm text-ink disabled:text-ink3'/)
      assert.match(day, /const onCls = 'inline-flex min-h-tap items-center whitespace-nowrap rounded border-2 border-warn bg-warn-bg px-2 text-sm font-bold text-ink'/)
      assert.match(day, /<span aria-hidden="true">⚐ <\/span>申し送り/)
      assert.match(day, /<span aria-hidden="true">⚑ <\/span>\s*\{onLabel\}/)
      assert.match(day, /onLabel = '申し送り' \}: DayMarkInput/)
      assert.match(day, /disabled=\{off !== null \|\| isBusy\}[\s\S]{0,200}title=\{label\}/)
      assert.match(day, /const label = off !== null \? `\$\{name\}さんの\$\{what\}を申し送りにできません。\$\{off\}`/)
    })
    it('印の読み込みはその日の全員分を1本（fetchDaycareDayNotes）・Realtime の購読は足さない・端末に残さない', () => {
      assert.equal((day.match(/fetchDaycareDayNotes\(/g) ?? []).length, 1)
      // 行き違った古い読み込み・日を替えた後に届いた前の日の読み直しで、表示中の日の印を消さない
      assert.match(day, /if \(d === dayRef\.current && gen > appliedRef\.current\) \{\s+appliedRef\.current = gen\s+setMarks\(\{ day: d, rows \}\)/)
      assert.doesNotMatch(day, /fetchDaycareNoteMarks\(|subscribeChanges|subscribeDaycare/)
      // 1人の画面の部品は今のまま（1人・1日の読み込み）
      assert.match(person, /const rows = await fetchDaycareNoteMarks\(d, rid\)/)
      assert.doesNotMatch(person, /fetchDaycareDayNotes/)
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
        const head = p.slice(p.indexOf('<thead>'), p.indexOf('</thead>'))
        assert.match(head, /<th scope="col" className="sticky top-0 z-20 bg-surface2 px-1 py-2 text-sm font-bold text-ink2">\s*申し送り\s*<\/th>\s*<\/tr>/, `${path}: 申し送りの列は右の端`)
        assert.match(p, /\{markNote\}/, path)
        assert.match(p, /\|\| markNote !== null/, path)
      }
      const act = code('../src/pages/DaycareActivityBulkPage.tsx')
      // その日の活動（サーバーの行・表の並び＝activitiesOf）をまとめた文。読めない時は押せない
      assert.match(act, /const dayText = readable \? activityDayMarkText\(activitiesOf\(data\.activities \?\? \[\], rid, day\)\.map\(\(a\) => activityText\(a\)\)\) : null/)
      assert.match(act, /blockedReason: canWrite \? null : precheck\(\)/)
      const tr = code('../src/pages/DaycareTrainingPage.tsx')
      assert.match(tr, /const markRec: MarkRecord \| null = s !== null \? \{ kind: 'training', id: s\.id \} : marks\.liveRecord\(rid, 'training'\)/)
      assert.match(tr, /const markText = s !== null \? trainingMarkText\(sessionText\(s\)\) : null/)
      assert.match(tr, /const markWritable = gateOk && !missing/)
    })
    it('今日の画面: カードの状態の段の右に「⚑n」（その方の取り消していないデイの申し送りの数・0件は出さない・押せない表示）。帯には足さない。読み込みは1本・今の購読の notes で数だけ読み直す', () => {
      const today = code('../src/pages/DaycarePage.tsx')
      assert.doesNotMatch(today, /\b(insertNote|deleteNote|saveNoteEdits)\(/)
      assert.equal((today.match(/fetchDaycareDayNotes\(/g) ?? []).length, 1)
      // 方ごとの数（取り消した行・利用者の無い行は数えない）
      assert.match(today, /if \(r\.deleted \|\| rid === null\) continue\s+byResident\.set\(rid, \(byResident\.get\(rid\) \?\? 0\) \+ 1\)/)
      // カード: 状態の段の右・枠なし・記号と数は読み上げず「申し送り n件」と読む・title も同じ・押せない（ボタン・リンクにしない）
      const list = today.slice(today.indexOf('<ul className="dc-cards"'), today.indexOf('</ul>', today.indexOf('<ul className="dc-cards"')))
      assert.match(list, /\{tone\.word\}\s*(\{\}\s*)?\{noteN > 0 \? \(\s*<span title=\{`申し送り \$\{noteN\}件`\} className="ml-1 whitespace-nowrap">\s*<span aria-hidden="true">⚑\{noteN\}<\/span>\s*<span className="sr-only">・申し送り \{noteN\}件<\/span>\s*<\/span>\s*\) : null\}\s*<\/p>/)
      assert.equal((list.match(/<button/g) ?? []).length, 2, 'カードのボタンは〔休み〕〔取消〕のまま')
      assert.match(today, /・⚑ 申し送り（数）<\/p>/)
      // 件数の帯には足さない（見出しの段が折り返して iPad 横の30名が見えなくなるため・親の決定 2026-11-10）
      const tiles = today.slice(today.indexOf('const tiles: '), today.indexOf('const noteCountOf'))
      assert.doesNotMatch(tiles, /申し送り/)
      assert.match(today, /else if \(table === 'notes'\) scheduleNoteCount\(\)/)
      // 購読の数は今のまま（Realtime を足さない）
      assert.equal((today.match(/\bsubscribe(Changes|DaycareChanges|BathChanges|DaycareActivityChanges)\(/g) ?? []).length, 4)
      // 1日の読み込み（load）の中には入れない（申し送りの変更で1日の全部を読み直さない）
      const load = today.slice(today.indexOf('const load = useCallback'), today.indexOf('const loadNoteCount'))
      assert.doesNotMatch(load, /fetchDaycareDayNotes/)
    })
    it('バイタル・食事の画面: 行には旗のボタンを置かず、テンキーの見出しの段に〔⚐ 申し送り〕（数える回のバイタル・鍵は vital）。氏名の段の右に「⚑」・氏名は1段で省略記号', () => {
      const vm = code('../src/pages/DaycareVitalsMealsPage.tsx')
      assert.doesNotMatch(vm, /\b(insertNote|deleteNote|saveNoteEdits)\(/)
      assert.match(vm, /const marks = useDaycareNoteMarksDay\(\{/)
      // 〔元に戻す〕は昼食と同じ知らせの部品（テンキーを開いている間の知らせの位置の決まりのまま）
      assert.match(vm, /refreshKey: reloadKey,\s+show: lunch\.show,\s+\}\)/)
      assert.match(vm, /\{marks\.dialogs\}/)
      // テンキーの見出しの段（入れている方の名前・欄の段）に置く。付いている時は「申し送り済み」
      const kp = vm.slice(vm.indexOf('const keypad ='), vm.indexOf('<div className="flex gap-gap">', vm.indexOf('const keypad =')))
      assert.match(kp, /<span className="font-bold">\{nameOf\(active\.residentId\)\}<\/span>/, '全文の氏名はテンキーの見出し')
      assert.match(kp, /\{marks\.button\(\{\s+residentId: active\.residentId,\s+name: nameOf\(active\.residentId\),\s+rec: \{ kind: 'vital' \},\s+text: markOfActive\.text,\s+why: markOfActive\.why,\s+onLabel: '申し送り済み',\s+\}\)\}/)
      // 文は数える回（空の枠を光らせる回と同じ countSeqOfRow）のサーバーの値。送っていない値・送信待ちの値がある間は押せない
      const mk = vm.slice(vm.indexOf('const markOfActive'), vm.indexOf('const keypad ='))
      assert.match(mk, /const cs = countSeqOfRow\.get\(active\.residentId\) \?\? null/)
      assert.match(mk, /const v = slot\?\.vital \?\? null/)
      assert.match(mk, /vitalMarkText\(\{ temp: v\.temp, sys_bp: v\.sys_bp, dia_bp: v\.dia_bp, pulse: v\.pulse, spo2: v\.spo2 \}\)/)
      assert.match(mk, /Object\.keys\(drafts\.get\(slot\.key\) \?\? \{\}\)\.length > 0 \|\| pendingRow\('vitals', targetOf\(slot\)\) !== null/)
      // 行には旗のボタンを置かない（表の中の marks.button は無い）。氏名の段の右の「⚑」は読み上げず、別に「申し送り済み」と読む
      const body = vm.slice(vm.indexOf('<tbody>'), vm.indexOf('</tbody>'))
      assert.doesNotMatch(body, /marks\.button\(/)
      assert.match(body, /<span className="min-w-0 truncate">\{nameOf\(row\.residentId\)\}<\/span>\s*\{markMk !== null \? \(\s*<span aria-hidden="true" className="ml-0\.5 shrink-0 font-normal text-ink">\s*⚑\s*<\/span>\s*\) : null\}/)
      assert.match(body, /markMk === 'live' \? '（申し送り済み）'/)
      assert.match(body, /const markMk = marks\.markState\(row\.residentId, \{ kind: 'vital' \}\)/)
      // 印の知らせは1回目の行の下の知らせの行
      assert.match(body, /const markNote = si === 0 \? marks\.note\(row\.residentId, \{ kind: 'vital' \}, nameOf\(row\.residentId\)\) : null/)
      assert.match(body, /\{lunchNotes\}\s*\{markNote\}/)
      // 〔外す〕の確認の小窓の中で押したキー（Enter・Esc）は、テンキーが横取りしない
      assert.match(vm, /if \(t !== null && t\.closest\('\[role="dialog"\]'\) !== null\) return/)
    })
  })
}
