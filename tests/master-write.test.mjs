// 入居者・職員の写しと取込・同期の台帳の書き込みの役割（移行 0040・代表者の決定 2026-10-22）の静的検査。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// ・移行 0040 の文面: 書く許可の関数（has_role が無ければ false・invoker）・4表のポリシー・residents のトリガ（definer・
//   表示名だけは現場も通す・42501）・med_slots と記録の表には触れない・do $$ を使わない
// ・画面: 設定の画面は「マスタを同期する」と「名簿の氏名を採用する」を事務・管理者のログインにだけ出す。
//   表示名の画面・服薬の時間帯の画面は今のまま（役割で出し分けない）
// ・DB を使う中身の確認は tests/master-write-pg.mjs（pg-run-all）。現場で同期を呼ばない動きは tests/roster-presence.test.mjs
// 個人情報は扱わない。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
/** SQL のコメント（-- 以降）を外した本文 */
const code = (s) =>
  s
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')

describe('移行 0040: 入居者・職員の写しと台帳の書き込みを事務所・管理者だけに', () => {
  const s = read('../supabase/migrations/0040_master_write_office_only.sql')
  const c = code(s)

  it('書く許可の関数は has_role が無い DB では false・security invoker・anon は呼べない', () => {
    assert.match(c, /create or replace function private\.office_writable\(\)/)
    assert.match(c, /to_regprocedure\('private\.has_role\(text\[\]\)'\) is null then\s+return false;/)
    assert.match(c, /has_role\(variadic array\[''office'', ''admin''\]\)/)
    assert.match(c, /function private\.office_writable\(\)[\s\S]*?security invoker[\s\S]*?\$fn\$;/)
    assert.match(c, /revoke all on function private\.office_writable\(\) from public, anon;/)
  })

  it('staff・import_days・master_sync_log: insert_auth・update_auth を外し、office だけの insert／update（using true）', () => {
    for (const t of ['staff', 'import_days', 'master_sync_log']) {
      assert.match(c, new RegExp(`drop policy if exists "insert_auth"\\s+on public\\.${t};`), t)
      assert.match(c, new RegExp(`drop policy if exists "update_auth"\\s+on public\\.${t};`), t)
      assert.match(c, new RegExp(`create policy "insert_office" on public\\.${t} for insert to authenticated\\s+with check \\(private\\.office_writable\\(\\)\\);`), t)
      assert.match(
        c,
        new RegExp(`create policy "update_office" on public\\.${t} for update to authenticated\\s+using \\(true\\) with check \\(private\\.office_writable\\(\\)\\);`),
        t,
      )
    }
  })

  it('residents: insert は office だけ・update のポリシーは残し、トリガで表示名だけの更新を現場にも通す', () => {
    assert.match(c, /create policy "insert_office" on public\.residents for insert to authenticated\s+with check \(private\.office_writable\(\)\);/)
    assert.doesNotMatch(c, /drop policy if exists "update_auth"\s+on public\.residents/)
    assert.match(c, /c_skip constant text\[\] := array\['note_alias', 'updated_at', 'rev'\];/)
    assert.match(c, /if v_role is distinct from 'field' then\s+return new;/)
    assert.match(c, /to_regprocedure\('private\.my_role\(\)'\) is null then\s+return new;/)
    assert.match(c, /using errcode = '42501'/)
    assert.match(c, /raise exception 'resident_master_office_only: /)
    assert.match(c, /function public\.residents_master_guard\(\)[\s\S]*?security definer\s+set search_path = public, pg_temp/)
    assert.match(c, /revoke all on function public\.residents_master_guard\(\) from public, anon, authenticated;/)
    assert.match(c, /create or replace trigger trg_residents_master_guard\s+before update on public\.residents/)
  })

  it('med_slots と記録の表・member_only には触れない。do $$ を使わない', () => {
    for (const t of ['med_slots', 'vitals', 'meals', 'fluid_intake', 'notes', 'note_reads', 'outings', 'attendance', 'bath_records', 'med_admin', 'incidents']) {
      assert.doesNotMatch(c, new RegExp(`\\b${t}\\b`), t)
    }
    assert.doesNotMatch(c, /member_only/)
    assert.doesNotMatch(c, /do \$\$/)
    assert.doesNotMatch(c, /delete from|truncate|drop table|drop column/i)
  })
})

describe('画面: 名簿の同期と名簿の氏名の採用は事務・管理者のログインにだけ出す（0040）', () => {
  const settings = read('../src/pages/SettingsPage.tsx')

  it('設定の画面: 役割は my_account の控え（fetchMyRole・subscribeMyRole）で、canWriteMasters の時だけボタンを出す', () => {
    assert.match(settings, /const canSync = canWriteMasters\(role\)/)
    assert.match(settings, /fetchMyRole\(\)\.then/)
    assert.match(settings, /subscribeMyRole\(load\)/)
    assert.match(settings, /\{canSync \? \(\s*<div className="mt-3 flex justify-end">\s*<button[\s\S]*?マスタを同期する/)
    assert.match(settings, /\{rv !== null && canSync \? \(/)
    assert.match(settings, /名簿の同期は、事務・管理者のログインでだけ行います（現場のログインでは同期しません）。/)
    // 役割を localStorage に置かない（端末のメモリだけ）
    assert.doesNotMatch(settings, /localStorage\.setItem\([^)]*role/i)
  })

  it('表示名の保存と服薬の時間帯の画面は役割で出し分けない（現場も書けるまま）', () => {
    assert.match(settings, /await setResidentNoteAlias\(r\.id, check\.value, baseForSave\)/)
    const slots = read('../src/pages/MedSlotsPage.tsx')
    assert.doesNotMatch(slots, /fetchMyRole|canWriteMasters|canEditTargets/)
  })

  it('db.ts: canWriteMasters は事務所・管理者だけ（分からない＝false）', () => {
    const db = read('../src/lib/db.ts')
    assert.match(db, /export function canWriteMasters\(role: MyRole \| null \| undefined\): boolean \{\s+return canUnlockNotes\(role\)\s+\}/)
    assert.match(db, /export function canUnlockNotes\(role: MyRole \| null \| undefined\): boolean \{\s+return role === 'office' \|\| role === 'admin'\s+\}/)
  })

  it('gasClient: 自動の同期は接続設定の次に役割を見る・手動の同期と氏名の採用は書く前に止める', () => {
    const g = read('../src/lib/gasClient.ts')
    assert.match(g, /if \(!hasMasterConnection\(\)\) return 'unconfigured'\s+if \(!canWriteMasters\(await fetchMyRole\(\)\)\) return 'officeOnly'/)
    assert.match(g, /if \(cfg === 'unconfigured'\) return 'unconfigured'\s+\/\/[^\n]*\n\s+await assertMasterWriter\(\)/)
    assert.match(g, /const name = typeof rosterName === 'string' \? rosterName\.trim\(\) : ''\s+await assertMasterWriter\(\)/)
  })
})
