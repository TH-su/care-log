// 五十音の行分け（カルテの利用者一覧の「五十音順」・2026-11-07 本人指示）の回帰テスト。架空の読みだけ。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const K = await import(new URL('../src/lib/kanaRow.ts', import.meta.url).href)

describe('五十音の行', () => {
  it('ひらがな・カタカナ・濁点・半濁点・小さい字を行に分ける', () => {
    assert.equal(K.kanaRowOf('あおき'), 'あ')
    assert.equal(K.kanaRowOf('ガトウ'), 'か')
    assert.equal(K.kanaRowOf('ぱんだ'), 'は')
    assert.equal(K.kanaRowOf('ヴぇると'), 'あ')
    assert.equal(K.kanaRowOf('ﾔﾏﾓﾄ'), 'や') // 半角カナも NFKC で揃える
    assert.equal(K.kanaRowOf('わたり'), 'わ')
  })
  it('読みが無い・かな以外で始まる方は「その他」', () => {
    assert.equal(K.kanaRowOf(null), 'その他')
    assert.equal(K.kanaRowOf(''), 'その他')
    assert.equal(K.kanaRowOf('Ａさん'), 'その他')
  })
  it('五十音順に並べ、人のいない行は出さず、読みの無い方は最後の「その他」', () => {
    const people = [
      { id: 1, name: '架空一', kana: 'たなか　いち' },
      { id: 2, name: '架空二', kana: 'アオキ' },
      { id: 3, name: '架空三', kana: null },
      { id: 4, name: '架空四', kana: 'あいだ' },
      { id: 5, name: '架空五', kana: 'がもう' },
    ]
    const g = K.groupByKanaRow(people)
    assert.deepEqual(g.map((x) => x.row), ['あ', 'か', 'た', 'その他'])
    assert.deepEqual(g[0].people.map((p) => p.id), [4, 2])
    assert.equal(K.kanaRowLabel('あ'), 'あ行')
    assert.equal(K.kanaRowLabel('その他'), 'その他')
  })
})

describe('カルテの利用者一覧の並び', () => {
  it('居室順／五十音順の切り替えを出し、端末に覚えるのは並びの種類だけ（既知の値以外は居室順）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/pages/KartePage.tsx', import.meta.url), 'utf8')
    assert.match(src, /<SegmentPicker options=\{LIST_ORDER_OPTIONS\} value=\{order\} onChange=\{onOrderChange\} ariaLabel="利用者一覧の並び" \/>/)
    assert.match(src, /if \(v === 'room' \|\| v === 'kana'\) return v/)
    assert.match(src, /localStorage\.setItem\(LS\.karteListOrder, v\)/)
    assert.match(src, /order === 'kana' \? groupByKanaRow\(list\) : \[\]/)
  })
})
