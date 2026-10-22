// 段階2d-1: 個人のバイタルの閾値（移行 0045）の回帰テスト（2026-10-22・代表者承認・段階2の計画 v1 の 3.2・5章・8章 V1〜V5）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/vitalLimits.ts）: その日に効く行（limitFor）・基準の合成（thresholdsFor）と段階の順の確かめ・
//    入力の検査・取り消せる日・要約
//    V1  境界（以上／未満の向きは施設の基準と同じ *LevelBy）／V1b 合成した後の順の崩れ・壊れた値は施設の基準へ／
//    V3  過去の判定（10/1 から 37.2・10/15 から 37.8 の人の 10/10 と 10/20）
// 2. db.ts を偽の Supabase で動かす（通信しない）: 表が無い DB は missing・止めた理由の文の頭を check の 23514 より先に見る
// 3. 静的検査: 移行 0045 の形（追加のみ・冪等・do ブロックなし・0034 の関数は呼ぶだけ・delete の権限なし・Realtime なし）・
//    types.ts に触れない・2d-1 ではどの画面の判定も変えない（個人の基準を使うのはカルテのカードだけ）
// DB の層（RLS・追記のみのトリガ・check）は tests/vital-limits-contract.mjs（pg-run-all で流す）。
// 個人情報は置かない（利用者は数値IDだけ・値は試験用の架空の数）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const sqlCode = (p) => read(p).replace(/--.*$/gm, '')

const lsStore = new Map()
let L = null
let T = null
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
  L = await import('../src/lib/vitalLimits.ts')
  T = await import('../src/lib/vitalThresholds.ts')
  DB = await import('../src/lib/db.ts?vital-limits')
} catch (e) {
  loadError = e
  L = null
}

/** 試験用の行（値は架空） */
const row = (over = {}) => ({
  id: 1,
  resident_id: 7,
  valid_from: '2026-10-01',
  temp_warn_high: null,
  temp_danger_high: null,
  temp_danger_low: null,
  sys_bp_danger_high: null,
  sys_bp_warn_low: null,
  dia_bp_danger_high: null,
  dia_bp_warn_low: null,
  pulse_danger_high: null,
  pulse_warn_low: null,
  basis: '主治医の指示（試験）',
  set_by: 1,
  rev: 1,
  created_at: '2026-10-01T01:00:00Z',
  ...over,
})

if (L === null) {
  registerLoadFailure('段階2d-1（個人の閾値）の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  const BASE = T.DEFAULT_VITAL_THRESHOLDS
  describe('純ロジック（vitalLimits.ts）', () => {
    it('9項目は施設の基準の一式と1対1・範囲は DB の check と同じ', () => {
      assert.deepEqual([...L.VITAL_LIMIT_FIELDS], [
        'temp_warn_high', 'temp_danger_high', 'temp_danger_low', 'sys_bp_danger_high', 'sys_bp_warn_low',
        'dia_bp_danger_high', 'dia_bp_warn_low', 'pulse_danger_high', 'pulse_warn_low',
      ])
      const mig = sqlCode('../supabase/migrations/0045_resident_vital_limits.sql')
      for (const [f, r] of Object.entries(L.VITAL_LIMIT_RANGES)) {
        const lo = r.decimal ? r.min.toFixed(1) : String(r.min)
        const hi = r.decimal ? r.max.toFixed(1) : String(r.max)
        assert.match(mig, new RegExp(`\\(${f}\\s+is null or ${f}\\s+between ${lo.replace('.', '\\.')} and ${hi.replace('.', '\\.')}\\)`), f)
      }
    })
    it('V3 その日に効く行: 記録の日以前で一番新しい開始日。先の日の行は使わない。全部 null の行（施設の基準に戻す）も選ぶ', () => {
      const rows = [
        row({ id: 1, valid_from: '2026-10-01', temp_warn_high: 37.2 }),
        row({ id: 2, valid_from: '2026-10-15', temp_warn_high: 37.8 }),
        row({ id: 3, valid_from: '2026-10-25' }), // 全部 null＝この日から施設の基準
        row({ id: 4, resident_id: 8, valid_from: '2026-09-01', temp_warn_high: 36.9 }),
      ]
      assert.equal(L.limitFor(rows, 7, '2026-09-30'), null)
      assert.equal(L.limitFor(rows, 7, '2026-10-10').id, 1)
      assert.equal(L.limitFor(rows, 7, '2026-10-15').id, 2, '開始日の当日から効く')
      assert.equal(L.limitFor(rows, 7, '2026-10-20').id, 2)
      assert.equal(L.limitFor(rows, 7, '2026-10-26').id, 3)
      // 10/10 の 37.5 は ↑（個人の注意の高 37.2）、10/20 の 37.5 は判定なし（37.8）。10/26 は施設の基準（37.5 で ↑）
      const lv = (day) => T.tempLevelBy(37.5, L.thresholdsFor(L.limitFor(rows, 7, day), BASE).t)
      assert.equal(lv('2026-10-10'), 'warn-high')
      assert.equal(lv('2026-10-20'), null)
      assert.equal(lv('2026-10-26'), 'warn-high')
      assert.deepEqual([...L.thresholdsFor(L.limitFor(rows, 7, '2026-10-26'), BASE).individual], [], '全部 null の行は個人の基準なし')
    })
    it('V1 境界: 以上／未満の向きは施設の基準と同じ（個人の値で *LevelBy を呼ぶ）。項目ごとに 個人 > 施設', () => {
      const r = row({ temp_warn_high: 37.2, sys_bp_warn_low: 100, pulse_danger_high: 90 })
      const { t, individual } = L.thresholdsFor(r, BASE)
      assert.equal(T.tempLevelBy(37.1, t), null)
      assert.equal(T.tempLevelBy(37.2, t), 'warn-high', '以上')
      assert.equal(T.tempLevelBy(37.3, t), 'warn-high')
      assert.equal(T.tempLevelBy(38.1, t), 'danger-high', '危険の高は施設の基準のまま')
      assert.equal(T.sysBpLevelBy(99, t), 'warn-low')
      assert.equal(T.sysBpLevelBy(100, t), null, '未満')
      assert.equal(T.sysBpLevelBy(151, t), 'danger-high', '危険の高は施設の基準のまま')
      assert.equal(T.pulseLevelBy(89, t), null)
      assert.equal(T.pulseLevelBy(90, t), 'danger-high')
      assert.equal(T.diaBpLevelBy(49, t), 'warn-low', '個人の値の無い項目は施設の基準')
      assert.deepEqual([...individual].sort(), ['pulse', 'sysBp', 'temp'])
      // 個人の行が無い方は、施設の基準そのもの（同じ値で同じ印）
      assert.equal(L.thresholdsFor(null, BASE).t, BASE)
      assert.equal(L.thresholdsFor(row(), BASE).t, BASE, '全部 null の行も施設の基準そのもの')
    })
    it('V1b 合成した後の順の崩れ・壊れた値: その項目は両方とも施設の基準へ戻し、知らせる', () => {
      const r1 = row({ temp_warn_high: 38.5 }) // 施設の危険の高 38.1 を超える
      const a = L.thresholdsFor(r1, BASE)
      assert.deepEqual(a.t.temp, BASE.temp)
      assert.deepEqual([...a.fallback], ['temp'])
      assert.equal(L.fallbackNotice(a.fallback), '体温は、個人の基準が施設の基準と合わないため、施設の基準で判定しています。')
      const r2 = row({ sys_bp_warn_low: 140, pulse_warn_low: 'x', dia_bp_danger_high: 999 })
      const b = L.thresholdsFor(r2, { ...BASE, sysBp: { dangerHigh: 130, warnLow: 90 } })
      assert.deepEqual([...b.fallback].sort(), ['diaBp', 'pulse', 'sysBp'])
      assert.equal(b.individual.size, 0)
      assert.equal(L.fallbackNotice(new Set()), null)
    })
    it('2d-1 の反証 中2: 足す前に、施設の基準と合わせて段階の順が崩れる項目を見つける（先の日の行も効く日まで気づけないため）', () => {
      const v = (over = {}) => {
        const o = {}
        for (const f of L.VITAL_LIMIT_FIELDS) o[f] = null
        return { ...o, ...over }
      }
      assert.deepEqual([...L.inputFallback(v({ temp_warn_high: 38.5 }), BASE)], ['temp'], '施設の危険の高 38.1 を超える注意の高')
      assert.deepEqual([...L.inputFallback(v({ temp_warn_high: 38.5, temp_danger_high: 39.0 }), BASE)], [], '危険の高もそろえて入れれば効く')
      assert.deepEqual([...L.inputFallback(v({ sys_bp_warn_low: 140 }), { ...BASE, sysBp: { dangerHigh: 130, warnLow: 90 } })], ['sysBp'])
      assert.deepEqual([...L.inputFallback(v(), BASE)], [])
      assert.equal(L.baseGroupText('temp', BASE), '体温（注意 37.5・危険 38.1・危険の低 35.5）')
      assert.equal(L.baseGroupText('pulse', BASE), '脈（危険の高 101・注意の低 40）')
    })
    it('入力の検査: 空欄は施設の基準・範囲・小数・入れた値どうしの順・根拠は必須・開始日は今日以降', () => {
      const base = (over = {}) => {
        const v = { valid_from: '2026-10-22', basis: '主治医の指示 10/20' }
        for (const f of L.VITAL_LIMIT_FIELDS) v[f] = ''
        return { ...v, ...over }
      }
      const ok = L.parseVitalLimitInput(base({ temp_warn_high: '３７．２', pulse_warn_low: ' 45 ' }), '2026-10-22')
      assert.equal(ok.ok, true)
      assert.equal(ok.value.temp_warn_high, 37.2)
      assert.equal(ok.value.pulse_warn_low, 45)
      assert.equal(ok.value.sys_bp_danger_high, null)
      assert.equal(L.parseVitalLimitInput(base(), '2026-10-22').ok, true, '全部空欄＝施設の基準に戻す行')
      assert.match(L.parseVitalLimitInput(base({ temp_warn_high: '37.25' }), '2026-10-22').message, /小数1桁/)
      assert.match(L.parseVitalLimitInput(base({ pulse_warn_low: '45.5' }), '2026-10-22').message, /整数/)
      assert.match(L.parseVitalLimitInput(base({ temp_warn_high: '41.5' }), '2026-10-22').message, /35〜41/)
      assert.match(L.parseVitalLimitInput(base({ temp_warn_high: '38.5', temp_danger_high: '38.1' }), '2026-10-22').message, /危険の低 ＜ 注意の高 ＜ 危険の高/)
      assert.match(L.parseVitalLimitInput(base({ sys_bp_warn_low: '140', sys_bp_danger_high: '130' }), '2026-10-22').message, /血圧の上/)
      assert.match(L.parseVitalLimitInput(base({ basis: '  ' }), '2026-10-22').message, /根拠/)
      assert.match(L.parseVitalLimitInput(base({ basis: 'あ'.repeat(201) }), '2026-10-22').message, /200 字/)
      assert.match(L.parseVitalLimitInput(base({ valid_from: '2026-10-21' }), '2026-10-22').message, /今日以降/)
      assert.equal(L.parseVitalLimitInput(base({ valid_from: '2026-11-01' }), '2026-10-22').ok, true)
    })
    it('取り消せるのは足した日（日本時間）の当日だけ・要約', () => {
      assert.equal(L.cancelableToday({ created_at: '2026-10-21T16:00:00Z' }, '2026-10-22'), true, '日本時間 10/22 01:00')
      assert.equal(L.cancelableToday({ created_at: '2026-10-21T14:59:00Z' }, '2026-10-22'), false, '日本時間 10/21 23:59')
      assert.equal(L.cancelableToday({ created_at: null }, '2026-10-22'), false)
      assert.equal(L.limitSummary(row()), '施設の基準に戻す')
      assert.equal(L.limitSummary(row({ temp_warn_high: 37.2, pulse_warn_low: 45 })), '体温 注意の高（℃以上） 37.2・脈 注意の低（未満） 45')
    })
  })

  describe('db.ts（偽の Supabase・通信しない）', () => {
    const client = (handler) => ({
      from: (table) => {
        const q = { table, action: 'select', payload: null }
        const b = {
          select: () => b,
          eq: () => b,
          is: () => b,
          order: () => b,
          limit: () => b,
          insert: (p) => {
            q.action = 'insert'
            q.payload = p
            return b
          },
          update: (p) => {
            q.action = 'update'
            q.payload = p
            return b
          },
          maybeSingle: () => Promise.resolve(handler(q)),
          then: (ok, ng) => Promise.resolve(handler(q)).then(ok, ng),
        }
        return b
      },
      rpc: (fn) => Promise.resolve(fn === 'my_account' ? { data: { role: 'office' }, error: null, status: 200 } : { data: null, error: { code: 'PGRST202', message: 'no' }, status: 404 }),
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
    it('表が無い DB（0045 未適用）は missing（全員が施設の基準）・行は読んだまま返す', async () => {
      DB.__testHooks.setClient(client(() => ({ data: null, error: { code: 'PGRST205', message: 'missing' }, status: 404 })))
      assert.deepEqual(await DB.fetchResidentVitalLimits(), { rows: [], missing: true })
      DB.__testHooks.setClient(client(() => ({ data: [row({ temp_warn_high: '37.2' })], error: null, status: 200 })))
      const r = await DB.fetchResidentVitalLimits()
      assert.equal(r.missing, false)
      assert.equal(r.rows[0].temp_warn_high, 37.2, '数の文字も数として読む')
      DB.__testHooks.setClient(null)
    })
    it('止めた理由: トリガの文の頭（遡り・書き換え・後日の取り消し）を、check の 23514 より先に見て出し分ける。23505 は conflict', async () => {
      const tryAdd = async (error) => {
        DB.__testHooks.setClient(client((q) => (q.table === 'resident_vital_limits' ? { data: null, error, status: 400 } : { data: null, error: null, status: 200 })))
        try {
          const r = await DB.addResidentVitalLimit(7, { valid_from: '2999-01-01', basis: '試験', temp_warn_high: 37.2 })
          return r
        } catch (e) {
          return e.message
        } finally {
          DB.__testHooks.setClient(null)
        }
      }
      assert.match(await tryAdd({ code: 'P0001', message: 'vital_limits_backdated: …' }), /開始日は今日以降/)
      assert.match(await tryAdd({ code: 'P0001', message: 'vital_limits_immutable: …' }), /書き換えられません/)
      assert.match(await tryAdd({ code: 'P0001', message: 'vital_limits_cancel_late: …' }), /当日だけ/)
      assert.match(await tryAdd({ code: '23514', message: 'new row violates check constraint' }), /範囲・順に合いませんでした/)
      assert.equal(await tryAdd({ code: '23505', message: 'duplicate' }), 'conflict')
    })
  })

  describe('静的検査（段階2d-1 の規律）', () => {
    const mig = read('../supabase/migrations/0045_resident_vital_limits.sql')
    const migCode = sqlCode('../supabase/migrations/0045_resident_vital_limits.sql')
    it('移行 0045: 追加のみ・冪等・旧クライアント×新サーバーを書く・do ブロックなし・0034 の関数は呼ぶだけ', () => {
      assert.match(mig, /旧クライアント×新サーバー/)
      assert.match(mig, /冪等/)
      assert.doesNotMatch(migCode, /do \$\$/i)
      assert.doesNotMatch(migCode, /create or replace function private\.resident_targets_writable/)
      assert.match(migCode, /with check \(private\.resident_targets_writable\(\)\)/)
      assert.doesNotMatch(migCode, /\bdrop table\b|\bdelete from\b|alter table public\.(resident_targets|vitals|residents)\b/i)
      assert.match(migCode, /revoke delete, truncate on public\.resident_vital_limits from authenticated;/)
      assert.match(migCode, /revoke all on public\.resident_vital_limits from anon;/)
      assert.doesNotMatch(migCode, /for delete|supabase_realtime add|cl_realtime_add/)
      assert.match(migCode, /record_history_capture\('valid_from'\)/)
      // 追記のみ: 遡り・書き換え・後日の取り消しを P0001 と文の頭で止める。役割なしの接続だけ止めない
      assert.match(migCode, /'vital_limits_backdated:[^']*'\s+using errcode = 'P0001'/)
      assert.match(migCode, /'vital_limits_immutable:[^']*'\s+using errcode = 'P0001'/)
      assert.match(migCode, /'vital_limits_cancel_late:[^']*'\s+using errcode = 'P0001'/)
      assert.match(migCode, /if v_role is null then\s+return new;\s+end if;/)
      assert.match(migCode, /create unique index if not exists uq_resident_vital_limits\s+on public\.resident_vital_limits \(resident_id, valid_from\)\s+where deleted_at is null;/)
    })
    it('types.ts に触れない（個人の閾値の型は vitalLimits.ts）。判定の入口（types.ts の tempLevel など）は施設の基準のまま', () => {
      const t = read('../src/lib/types.ts')
      assert.doesNotMatch(t, /vital_limits|VitalLimit/)
    })
    it('2d-1 ではどの画面の判定も変えない: 個人の基準（thresholdsFor）を使うのはカルテのカードだけ', () => {
      const pages = readdirSync(new URL('../src/pages/', import.meta.url)).filter((f) => f.endsWith('.tsx'))
      for (const f of pages) assert.doesNotMatch(code(`../src/pages/${f}`), /thresholdsFor|limitFor\(|fetchResidentVitalLimits/, f)
      const libs = ['vitalAlerts.ts', 'daycare.ts', 'chart.ts']
      for (const f of libs) assert.doesNotMatch(code(`../src/lib/${f}`), /vitalLimits|thresholdsFor/, f)
      const karte = code('../src/pages/KartePage.tsx')
      assert.match(karte, /<VitalLimitsCard residentId=\{residentId\} role=\{role\} \/>/)
    })
    it('カード: 書き込みは addResidentVitalLimit・cancelResidentVitalLimit だけ・取り消しは確認つき・端末に業務データを残さない', () => {
      const c = code('../src/components/VitalLimitsCard.tsx')
      const writes = c.match(/\b(save\w+|insert\w+|update\w+|delete\w+|softDelete\w+|upsert\w+|add[A-Z]\w+|cancel[A-Z]\w+)\(/g) ?? []
      assert.deepEqual([...new Set(writes.map((w) => w.slice(0, -1)))].sort(), ['addResidentVitalLimit', 'cancelResidentVitalLimit'])
      assert.doesNotMatch(c, /supabase|\.from\(|\.rpc\(|localStorage/)
      assert.match(c, /<ConfirmDialog\s+open=\{delRow !== null\}/)
      assert.match(c, /canEdit && cancelableToday\(r, today\)/)
    })
    it('2d-1 の反証の直し（カード）: 足す前に施設の基準と合わない項目を止める・初めの値は開始日の直前に効く行から・先の日の行の知らせ', () => {
      const c = code('../src/components/VitalLimitsCard.tsx')
      // 中2: 足す前に止める（addResidentVitalLimit より前）・これから効く行にも知らせ
      const stop = c.indexOf('const fb = inputFallback(p.value, base)')
      const send = c.indexOf('await addResidentVitalLimit(rid, p.value)')
      assert.ok(stop > 0 && send > stop)
      assert.match(c, /fallbackNotice\(thresholdsFor\(r, vitalThresholds\(\)\)\.fallback\)/)
      // 中3: 開始日の直前に効く行（その日ちょうどの行は除く）から入れる。直していなければ日を変えた時に入れ直し、直していれば知らせる
      assert.match(c, /rows\.filter\(\(r\) => !\(r\.resident_id === residentId && r\.valid_from === from\)\)/)
      assert.match(c, /setInput\(dirty \? \{ \.\.\.input, valid_from: from \} : fillFrom\(input, from\)\)/)
      assert.match(c, /setInput\(fillFrom\(emptyInput\(todayIso\(\)\), todayIso\(\)\)\)/)
      assert.match(c, /const fromChanged = open && \(fromRow\?\.id \?\? null\) !== prefillFrom/)
    })
    it('2d-1 の反証 中1・軽4（移行）: 足した時刻はサーバーの今・取り消した行と、取り消し以外の取り消しの列の書き換えは止める', () => {
      assert.match(migCode, /new\.created_at := now\(\);\s+new\.deleted_at := null;\s+new\.deleted_by := null;/)
      assert.match(migCode, /or \(old\.deleted_at is not null\s+and \(new\.deleted_at is distinct from old\.deleted_at/)
      assert.match(migCode, /or \(old\.deleted_at is null and new\.deleted_at is null\s+and \(new\.deleted_by is distinct from old\.deleted_by or new\.edited_by is distinct from old\.edited_by\)\)/)
    })
  })
}
