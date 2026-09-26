// 申し送りフォームの定型句（src/lib/notePhrases.ts）の純ロジック回帰テスト。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 対象は本文への差し込み（appendPhrase）と、定型句一覧の健全性だけ。DB・DOM・env には触れない。
// 個人情報は置かない（本文の例は汎用の短い文だけ。実名・病名・記録本文由来の文字列を書かない）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// TypeScript を直接読み込めない Node では検証を登録せずスキップし、理由を実行結果に残す
// （tests/logic.test.mjs と同じ扱い。黙って「成功」にしない）
let NP = null
try {
  NP = await import('../src/lib/notePhrases.ts')
} catch {
  NP = null
}

const BLANK = '＿' // 全角の低線「＿」

if (NP === null) {
  it('notePhrases の検証（スキップ）', { skip: 'この Node では TypeScript を直接読み込めないため、定型句の検証をスキップしました（Node 22.18 以降で実行してください）。' }, () => {})
} else {
  const { appendPhrase, NOTE_PHRASE_CATEGORIES } = NP

  describe('appendPhrase（本文の末尾に定型句を差し込む）', () => {
    it('本文が空: 「。」を補わずにそのまま入り、カーソルは末尾', () => {
      const r = appendPhrase('', '夜間良眠')
      assert.deepEqual(r, { body: '夜間良眠', selStart: 4, selEnd: 4 })
    })
    it('末尾が「。」: 「。」を重ねずにつなぐ', () => {
      const r = appendPhrase('経過を見た。', '確認済み')
      assert.equal(r.body, '経過を見た。確認済み')
      assert.equal(r.selStart, r.body.length)
      assert.equal(r.selEnd, r.body.length)
    })
    it('末尾が改行: 「。」を補わずにつなぐ', () => {
      const r = appendPhrase('経過を見た\n', '確認済み')
      assert.equal(r.body, '経過を見た\n確認済み')
      assert.equal(r.selStart, r.body.length)
    })
    it('末尾が文字: 「。」を補ってからつなぐ', () => {
      const r = appendPhrase('経過を見た', '確認済み')
      assert.equal(r.body, '経過を見た。確認済み')
      assert.equal(r.selStart, r.body.length)
      assert.equal(r.selEnd, r.body.length)
    })
    it('「＿」あり: 差し込んだ文の「＿」1文字を選択範囲にする', () => {
      const r = appendPhrase('経過を見た', '体温＿℃、クーリング実施')
      assert.equal(r.body, '経過を見た。体温＿℃、クーリング実施')
      assert.equal(r.selEnd - r.selStart, 1)
      assert.equal(r.body.slice(r.selStart, r.selEnd), BLANK)
      assert.equal(r.selStart, '経過を見た。体温'.length)
    })
    it('「＿」なし: カーソルを新しい本文の末尾に置く', () => {
      const r = appendPhrase('確認済み', '夜間良眠')
      assert.equal(r.selStart, r.body.length)
      assert.equal(r.selEnd, r.body.length)
    })
    it('「＿」が複数ある文: 最初の「＿」を選ぶ', () => {
      const r = appendPhrase('', '血圧高め（＿/＿）、再検予定')
      assert.equal(r.selStart, '血圧高め（'.length)
      assert.equal(r.selEnd, r.selStart + 1)
      assert.equal(r.body.slice(r.selStart, r.selEnd), BLANK)
    })
    it('本文の側に書き残した「＿」があっても、差し込んだ文の「＿」を選ぶ', () => {
      const r = appendPhrase(`体温${BLANK}℃`, '夜間トイレ＿回')
      assert.equal(r.body, `体温${BLANK}℃。夜間トイレ＿回`)
      assert.equal(r.selStart, `体温${BLANK}℃。夜間トイレ`.length)
    })
    it('本文が空白だけ（半角・全角・タブ）: 空として扱い、「。」も空白も残さない', () => {
      for (const ws of [' ', '   ', '　', '\t', ' 　\t ']) {
        const r = appendPhrase(ws, '夜間良眠')
        assert.deepEqual(r, { body: '夜間良眠', selStart: 4, selEnd: 4 }, JSON.stringify(ws))
      }
    })
    it('本文が空白だけで「＿」のある文: 選択位置は空白を除いた本文で数える', () => {
      const r = appendPhrase(' 　', '体温＿℃、クーリング実施')
      assert.equal(r.body, '体温＿℃、クーリング実施')
      assert.deepEqual([r.selStart, r.selEnd], [2, 3])
    })
    it('末尾が文字＋空白: 空白を取り除いてから「。」を補う', () => {
      for (const tail of [' ', '  ', '　', '\t', ' 　\t']) {
        const r = appendPhrase(`経過を見た${tail}`, '確認済み')
        assert.equal(r.body, '経過を見た。確認済み', JSON.stringify(tail))
        assert.equal(r.selStart, r.body.length)
      }
    })
    it('末尾が「。」＋空白: 空白を取り除き、「。」は重ねない', () => {
      const r = appendPhrase('経過を見た。　 ', '確認済み')
      assert.equal(r.body, '経過を見た。確認済み')
    })
    it('末尾が改行＋空白: 空白だけ取り除き、改行は残して「。」は補わない', () => {
      const r = appendPhrase('経過を見た\n\t ', '確認済み')
      assert.equal(r.body, '経過を見た\n確認済み')
    })
    it('文の途中の空白は取り除かない（末尾だけ）', () => {
      const r = appendPhrase('朝 経過を見た ', '確認済み')
      assert.equal(r.body, '朝 経過を見た。確認済み')
    })
    it('末尾空白を除いた後の「＿」の選択位置', () => {
      const r = appendPhrase('経過を見た  ', '夜間トイレ＿回')
      assert.equal(r.body, '経過を見た。夜間トイレ＿回')
      assert.equal(r.body.slice(r.selStart, r.selEnd), BLANK)
      assert.equal(r.selStart, '経過を見た。夜間トイレ'.length)
    })
    it('入力（本文・文）を書き換えない（純関数）', () => {
      const body = '経過を見た'
      appendPhrase(body, '確認済み')
      assert.equal(body, '経過を見た')
    })
  })

  describe('NOTE_PHRASE_CATEGORIES（定型句一覧の健全性）', () => {
    it('場面は10', () => {
      assert.equal(NOTE_PHRASE_CATEGORIES.length, 10)
    })
    it('場面の id は重複しない・空でない', () => {
      const ids = NOTE_PHRASE_CATEGORIES.map((c) => c.id)
      assert.equal(new Set(ids).size, ids.length)
      for (const id of ids) assert.ok(typeof id === 'string' && id !== '', `id: ${id}`)
    })
    it('場面名・文言は空でない（空白だけも不可）', () => {
      for (const c of NOTE_PHRASE_CATEGORIES) {
        assert.ok(typeof c.label === 'string' && c.label.trim() !== '', `label: ${c.id}`)
        assert.ok(Array.isArray(c.phrases) && c.phrases.length > 0, `phrases: ${c.id}`)
        for (const p of c.phrases) assert.ok(typeof p === 'string' && p.trim() !== '', `phrase: ${c.id}`)
      }
    })
    it('場面の中で文言が重複しない', () => {
      for (const c of NOTE_PHRASE_CATEGORIES) {
        assert.equal(new Set(c.phrases).size, c.phrases.length, c.id)
      }
    })
    it('敬称「様」「さん」を含まない（「様子」は敬称ではないので除く）', () => {
      for (const c of NOTE_PHRASE_CATEGORIES) {
        for (const p of [c.label, ...c.phrases]) {
          assert.doesNotMatch(p.replaceAll('様子', ''), /様/, p)
          assert.doesNotMatch(p, /さん/, p)
        }
      }
    })
  })
}
