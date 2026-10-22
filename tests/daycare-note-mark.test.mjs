// デイ（せせらぎ）段階2c: 申し送りの印の回帰テスト（2026-10-22・代表者承認・段階2の計画 v1 の 2.2／8章 V10）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycareNoteMark.ts）: 鍵の作りと読み方・世代（取り消した分も数える・送信待ちも数える）・分類・
//    本文（ひと言）・元の記録が変わったかの判定・記録ごとの文
// 2. db.ts を偽の Supabase で動かす（通信しない）: fetchDaycareNoteMarks の絞り込み（日・利用者・区分・鍵の頭）と、
//    取り消した申し送りも読むこと（世代を数えるため）
// 3. 静的検査: 申し送りへの書き込みは印の部品の中だけで、既存の insertNote・deleteNote・saveNoteEdits だけを使う・
//    1人の記録の画面と活動の欄は申し送りへ書かない・移行を足さない・types.ts と notes の表に触れない
// 個人情報は置かない（利用者は数値IDだけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
/** 行コメントと複数行コメントを除いた本文 */
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

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
  DB = await import('../src/lib/db.ts?daycare-note-mark')
} catch (e) {
  loadError = e
  M = null
}

if (M === null) {
  registerLoadFailure('デイ 段階2c（申し送りの印）の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('純ロジック（daycareNoteMark.ts）', () => {
    it('鍵: dcn:<日>:<利用者id>:<記録>:<世代>-<送るたびの印>。水分・活動は行の id（別の回の水分は別の鍵＝別の申し送り）', () => {
      assert.equal(M.markKey('2026-10-22', 7, { kind: 'lunch' }, 1, 'k3x9'), 'dcn:2026-10-22:7:lunch:1-k3x9')
      assert.equal(M.markKey('2026-10-22', 7, { kind: 'fluid', id: 31 }, 2, 'a1'), 'dcn:2026-10-22:7:fl31:2-a1')
      assert.equal(M.markKey('2026-10-22', 7, { kind: 'activity', id: 5 }, 1, 'zz'), 'dcn:2026-10-22:7:ac5:1-zz')
      assert.throws(() => M.markKey('2026-10-22', 7, { kind: 'lunch' }, 1, 'A-B'), /token/)
      // 2c の反証 重大2・中3・中4: 同じ世代でも送るたびの印が違えば別の鍵（別の端末・取り消した申し送りに当たらない）
      assert.notEqual(M.markKey('2026-10-22', 7, { kind: 'snack' }, 1, 'aaaa'), M.markKey('2026-10-22', 7, { kind: 'snack' }, 1, 'bbbb'))
      assert.deepEqual(M.parseMarkKey('dcn:2026-10-22:7:lunch:3-k3x9'), { day: '2026-10-22', residentId: 7, what: 'lunch', gen: 3 })
      assert.notEqual(M.markPrefix('2026-10-22', 7, { kind: 'fluid', id: 31 }), M.markPrefix('2026-10-22', 7, { kind: 'fluid', id: 32 }))
      assert.equal(M.markDayPrefix('2026-10-22', 7), 'dcn:2026-10-22:7:')
      assert.deepEqual(M.parseMarkKey('dcn:2026-10-22:7:fl31:2'), { day: '2026-10-22', residentId: 7, what: 'fl31', gen: 2 })
      assert.equal(M.parseMarkKey('dc:2026-10-22:7:1'), null, 'デイのバイタルの鍵（dc:）は印ではない')
      assert.equal(M.parseMarkKey('dcn:2026-10-22:7:lunch:0'), null)
      assert.equal(M.parseMarkKey('dcn:2026-10-22:7:dinner:1'), null)
      assert.equal(M.parseMarkKey(null), null)
    })
    it('世代: 取り消した申し送りも送信待ちの登録も数えて最大＋1（外した後に付け直せる）。ほかの記録の鍵は数えない', () => {
      const p = M.markPrefix('2026-10-22', 7, { kind: 'lunch' })
      assert.equal(M.nextGen(p, []), 1)
      assert.equal(M.nextGen(p, ['dcn:2026-10-22:7:lunch:1']), 2, '1 を取り消した後は 2')
      assert.equal(M.nextGen(p, ['dcn:2026-10-22:7:lunch:1', 'dcn:2026-10-22:7:lunch:3', 'dcn:2026-10-22:7:snack:9', 'dcn:2026-10-22:8:lunch:5']), 4)
      assert.equal(M.nextGen(p, ['dcn:2026-10-22:7:lunch:2-k3x9', 'dcn:2026-10-22:7:lunch:1']), 3, 'token つきの鍵も #21 の版の鍵も数える')
    })
    it('分類: 食事・おやつ・水分→食事／バイタル・排泄→体調／活動→付けない', () => {
      assert.deepEqual(M.markCategories('lunch'), ['食事'])
      assert.deepEqual(M.markCategories('snack'), ['食事'])
      assert.deepEqual(M.markCategories('fluid'), ['食事'])
      assert.deepEqual(M.markCategories('vital'), ['体調'])
      assert.deepEqual(M.markCategories('ex'), ['体調'])
      assert.deepEqual(M.markCategories('activity'), [])
    })
    it('本文はひと言を「。」でつなぐ（ひと言は入れたまま・書き換えない）。いまの記録と違うかは、本文がいまの文で始まるかで見る', () => {
      assert.equal(M.markBody('昼食 主食 7割・副食 5割', ''), '昼食 主食 7割・副食 5割')
      assert.equal(M.markBody('昼食 主食 7割・副食 5割', '  完食に近い　'), '昼食 主食 7割・副食 5割。完食に近い')
      // 2c の反証 軽10（原則6）: 全角・半角・記号を書き換えない
      assert.equal(M.markBody('おやつ 半分', 'ｶﾅ ＡＢＣ ㈱  2つ'), 'おやつ 半分。ｶﾅ ＡＢＣ ㈱  2つ')
      assert.equal(M.isStale('昼食 主食 7割・副食 5割。完食に近い', '昼食 主食 7割・副食 5割'), false)
      assert.equal(M.isStale('昼食 主食 7割・副食 5割', '昼食 主食 7割・副食 5割'), false)
      assert.equal(M.isStale('昼食 主食 7割・副食 5割', '昼食 主食 9割・副食 5割'), true)
      assert.equal(M.isStale('昼食 主食 7割', null), true, '記録が無くなった')
      // 2c の反証 中5: 日報で空白に続けて足しただけの申し送りは「違う」にしない。数字の続き（150 と 1500）は違う
      assert.equal(M.isStale('昼食 主食 7割・副食 5割 声かけで完食', '昼食 主食 7割・副食 5割'), false)
      assert.equal(M.isStale('水分 10:30 1500 ml', '水分 10:30 150 ml'), true)
      assert.equal(M.isStale('昼食 主食 10割・副食 5割', '昼食 主食 1割・副食 5割'), true)
      // 〔申し送りを直す〕で引き継ぐ部分（ひと言・日報で足した文）
      assert.equal(M.markTail('昼食 主食 7割・副食 5割。むせ込みあり', '昼食 主食 5割・副食 5割'), 'むせ込みあり')
      assert.equal(M.markTail('昼食 主食 7割・副食 5割 声かけで完食', '昼食 主食 7割・副食 5割'), '声かけで完食')
      assert.equal(M.markTail('昼食 主食 7割・副食 5割', '昼食 主食 5割・副食 5割'), '')
      assert.equal(M.markCommentError('あ'.repeat(100)), null)
      assert.match(M.markCommentError('あ'.repeat(101)), /100 字まで/)
    })
    it('記録ごとの文（氏名は入れない）', () => {
      assert.equal(M.vitalMarkText({ temp: 37.6, sys_bp: 116, dia_bp: 68, pulse: 80, spo2: 91 }), 'バイタル 体温 37.6℃・血圧 116/68・脈 80・SpO2 91%')
      assert.equal(M.vitalMarkText({ temp: 36, sys_bp: null, dia_bp: null, pulse: null, spo2: null }), 'バイタル 体温 36.0℃')
      assert.equal(M.vitalMarkText({ temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null }), null)
      assert.equal(M.mealMarkText('lunch', '拒食'), '昼食 拒食')
      assert.equal(M.mealMarkText('snack', '半分'), 'おやつ 半分')
      assert.equal(M.mealMarkText('lunch', '記録なし'), null)
      assert.equal(M.fluidMarkText({ taken_at: '10:30:00', amount_ml: 150 }), '水分 10:30 150 ml')
      assert.equal(M.fluidMarkText({ taken_at: null, amount_ml: 200 }), '水分 200 ml')
      assert.equal(M.activityMarkText('歌（見学）'), '活動 歌（見学）')
      assert.equal(M.excretionMarkText({ urine: 3, stools: [{}], laxatives: [] }), '排泄 排尿 3回・排便 1回')
      assert.equal(M.excretionMarkText({ urine: 0, stools: [], laxatives: [{}, {}] }), '排泄 排尿 0回・排便 0回・下剤 2回')
      assert.equal(M.excretionMarkText(null), null)
    })
  })

  describe('fetchDaycareNoteMarks（偽の Supabase・通信しない）', () => {
    it('日・利用者・区分「デイ」・鍵の頭で絞り、取り消した申し送りも読む（世代を数えるため）。書き込みはしない', async () => {
      const calls = []
      const base = { note_on: '2026-10-22', shift: 'daycare', facility: null, category: null, resident_id: 7, role_tags: [], importance: 'normal', occurred_at: null, ongoing: false, ended_at: null, ended_by: null, reporter_id: 1, color: null, after16: false, categories: ['食事'], rev: 1, created_at: 'x' }
      const rows = [
        { ...base, id: 1, body: '昼食 主食 7割・副食 5割', client_key: 'dcn:2026-10-22:7:lunch:1', deleted_at: '2026-10-22T03:00:00Z' },
        { ...base, id: 2, body: '昼食 主食 9割・副食 5割', client_key: 'dcn:2026-10-22:7:lunch:2', deleted_at: null },
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
          limit() {
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
      const r = await DB.fetchDaycareNoteMarks('2026-10-22', 7)
      assert.deepEqual(
        r.map((x) => [x.note.id, x.clientKey, x.deleted]),
        [
          [1, 'dcn:2026-10-22:7:lunch:1', true],
          [2, 'dcn:2026-10-22:7:lunch:2', false],
        ],
      )
      const q = calls.find((c) => c.table === 'notes')
      assert.match(q.cols, /,client_key,deleted_at$/)
      const has = (op, k, v) => q.filters.some(([o, kk, vv]) => o === op && kk === k && vv === v)
      assert.ok(has('eq', 'note_on', '2026-10-22'))
      assert.ok(has('eq', 'resident_id', 7))
      assert.ok(has('eq', 'shift', 'daycare'))
      assert.ok(has('like', 'client_key', 'dcn:2026-10-22:7:%'))
      assert.ok(!q.filters.some(([o, k]) => o === 'is' && k === 'deleted_at'), '取り消した申し送りも読む（世代を数える）')
      assert.ok(calls.every((c) => c.action === 'select'), '読むだけ')
      assert.deepEqual(DB.pendingDaycareNoteMarks('dcn:2026-10-22:7:'), [], '送信待ちが無ければ空')
      DB.__testHooks.setClient(null)
    })
  })

  describe('静的検査（段階2c の規律）', () => {
    const comp = code('../src/components/DaycareNoteMark.tsx')
    it('申し送りへの書き込みは印の部品の中だけで、既存の insertNote・deleteNote・saveNoteEdits だけ', () => {
      const writes = comp.match(/\b(save\w+|insert\w+|update\w+|delete\w+|softDelete\w+|upsert\w+|discard\w+|stage\w+)\(/g) ?? []
      assert.deepEqual([...new Set(writes.map((w) => w.slice(0, -1)))].sort(), ['deleteNote', 'insertNote', 'saveNoteEdits'])
      assert.doesNotMatch(comp, /supabase|\.from\(|\.rpc\(|localStorage/)
      // 冪等キーは世代つきの鍵・区分はデイ・「16時以降」は付けない・分類は記録の種類から
      assert.match(comp, /insertNote\(payload, \{ clientKey: markKey\(d, rid, rec, gen, token\) \}\)/)
      assert.match(comp, /const token = Math\.random\(\)\.toString\(36\)\.slice\(2, 10\) \|\| '0'/)
      assert.match(comp, /shift: 'daycare' as const,/)
      assert.match(comp, /after16: false,/)
      assert.match(comp, /markCategories\(rec\.kind\)\.length > 0 \? \{ categories: markCategories\(rec\.kind\) \} : \{\}/)
      // 〔外す〕は見た行（F09）・確認つき。〔申し送りを直す〕は見た本文を基準に
      assert.match(comp, /deleteNote\(\{ id: row\.note\.id \}, row\.note, \{ meta: noteMetaOf\(row\.note\), editedBy: actorId \}\)/)
      assert.match(comp, /\{ body: \{ value: markBody\(text, comment\), base: row\.note\.body \} \}/)
      assert.match(comp, /<ConfirmDialog\s+open=\{delRow !== null\}/)
    })
    it('送る直前に読み直して世代を決める・生きている印があれば2件目を作らない・読めていなければ付けない', () => {
      assert.match(comp, /const fresh = await load\(d, rid\)/)
      assert.match(comp, /if \(known === null\) \{\s+say\(k, \{ tone: 'warn', text: MSG_NOT_READ \}\)/)
      assert.match(comp, /if \(known\.some\(\(r\) => !r\.deleted && r\.clientKey\.startsWith\(prefix\)\)\) \{/)
      assert.match(comp, /const gen = nextGen\(prefix, keys\)/)
      assert.match(comp, /pendingDaycareNoteMarks\(markDayPrefix\(d, rid\)\)/)
      // 送るたびの印で別の鍵に当たらないので、取り消した行が返った時の送り直しは要らない（消した）
      assert.doesNotMatch(comp, /deletedIds/)
    })
    it('2c の反証 重大1: 小窓・確認は開いた時の人・日へ送る。人・日が替わったら閉じる', () => {
      assert.match(comp, /const sendAdd = async \(rid: number, d: string, rec: MarkRecord, text: string, comment: string\) => \{/)
      assert.doesNotMatch(comp.slice(comp.indexOf('const sendAdd'), comp.indexOf('const sendRemove')), /const rid = residentId/)
      assert.match(comp, /void sendAdd\(cur\.rid, cur\.d, cur\.rec, cur\.text, cur\.comment\)/)
      assert.match(comp, /void sendFix\(cur\.rid, cur\.d, cur\.rec, cur\.row, cur\.text, cur\.comment\)/)
      assert.match(comp, /void sendRemove\(delRow\.rid, delRow\.d, delRow\.rec, delRow\.row\)/)
      assert.match(comp, /useEffect\(\(\) => \{\s+setDlg\(null\)\s+setDelRow\(null\)\s+\}, \[day, residentId\]\)/)
      // 中5: 〔申し送りを直す〕は足された部分を引き継ぐ
      assert.match(comp, /comment: markTail\(live\.note\.body, text\)/)
    })
    it('17時のロック: 現場のログインは記録日の 17:00 から付け外し・直しをしない（事務所はできる・サーバーが正）', () => {
      assert.match(comp, /const lockedForMe = lockState\(day, 'daycare', false, now\)\.locked && !canUnlockNotes\(role\)/)
      assert.match(comp, /if \(lockedForMe\) return MSG_LOCKED_FIELD/)
      assert.match(comp, /isNoteLockedError\(e\) \? NOTE_LOCKED_MESSAGE/)
    })
    it('1人の記録の画面と活動の欄は申し送りへ書かない（印の部品を置くだけ）。申し送りの文はサーバーの値から', () => {
      const page = code('../src/pages/DaycarePersonPage.tsx')
      assert.doesNotMatch(page, /\b(insertNote|deleteNote|saveNoteEdits)\(/)
      assert.match(page, /const marks = useDaycareNoteMarks\(\{/)
      assert.match(page, /\{marks\.button\(\{ kind: 'lunch' \}, mealMarkText\('lunch', lunchLabel\(lunchRow\?\.meal \?\? null\)\)\)\}/)
      assert.match(page, /\{marks\.button\(\{ kind: 'fluid', id: f\.id \}, fluidMarkText\(f\)\)\}/)
      assert.match(page, /\{marks\.button\(\{ kind: 'ex' \}, excretionMarkText\(exDay\), ex\.status === 'ok' && ex\.view\.linked && exDay !== null\)\}/)
      assert.match(page, /\{marks\.dialogs\}/)
      const act = code('../src/components/DaycareActivitySection.tsx')
      assert.doesNotMatch(act, /\b(insertNote|deleteNote|saveNoteEdits)\(/)
      assert.match(act, /\{markSlot\?\.\(a\)\}/)
    })
    it('DB 変更なし（移行を足さない・types.ts と notes の表に触れない）', () => {
      const migs = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort()
      // 0044（段階2b）の後に入るのは、段階2d の個人の閾値 0045 だけ（2c の分は無い）
      const after = migs.filter((f) => f > '0044_daycare_activity.sql')
      assert.deepEqual(after.filter((f) => f !== '0045_resident_vital_limits.sql'), [], '段階2c は移行を足さない')
      assert.doesNotMatch(read('../src/lib/types.ts'), /dcn:|NoteMark/)
      // 取り消した申し送りも読む読み取りは、印の鍵の頭で絞った1か所だけ
      const db = code('../src/lib/db.ts')
      const f = db.slice(db.indexOf('export async function fetchDaycareNoteMarks'), db.indexOf('export interface PendingNoteMark'))
      assert.match(f, /\.like\('client_key', `dcn:\$\{dayIso\}:\$\{residentId\}:%`\)/)
      assert.match(f, /\.limit\(DAYCARE_NOTE_MARK_ROWS\)/)
    })
    it('純ロジックは端末に何も残さない（localStorage を使わない）', () => {
      assert.doesNotMatch(code('../src/lib/daycareNoteMark.ts'), /localStorage|supabase/)
    })
  })
}
