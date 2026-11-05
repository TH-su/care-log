// 0053（施設の印の段階3）の先の確かめが、DB の並べ方（照合順序）に左右されないことの見張り（2026-11-05 本番で判明）。
// 本番の DB は en_US の並べ方で、表の名前（name 型）は C の並べ方のため、「決まった76本」と「今ある76本」を
// それぞれの並べ方で並べた配列は、同じ76本でも並び順が違い、確かめが「違う」と誤って止まった。
// 試験の DB は C の並べ方なので、pg の実行器ではこの違いが出ない。そこで文の形を確かめる。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SQL = readFileSync(new URL('../supabase/migrations/0053_tenant_stage3.sql', import.meta.url), 'utf8')

describe('0053 の先の確かめの並べ方', () => {
  it('決まった76本と今ある76本は、どちらも C の並べ方で並べてから比べる', () => {
    const aggs = SQL.match(/pg_catalog\.array_agg\([^;]*?into v_(want|have)/gs) ?? []
    assert.equal(aggs.length, 2, '決まった76本（v_want）と今ある76本（v_have）の2つの集め方がある')
    for (const a of aggs) {
      assert.match(a, /order by \([^)]*\)::text collate "C"/, `並べ方を C にそろえていない: ${a.slice(0, 80)}`)
    }
  })
})
