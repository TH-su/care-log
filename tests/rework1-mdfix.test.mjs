// 手直し1回目の回帰テスト（2026-10-10 多端末運用の監査 確認役の再指摘: F61・F41 の画面側）。
// 直す前の版では赤、直した後で緑になる形。画面の部品は読み込まず、ソースの形を照らす（静的）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
// 個人情報は置かない（職員・利用者は合成の名前だけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')

// ─────────────────────────────────────────────────────────────────────────────
// F61: 許可リストに無い・無効なアカウントで入力の主画面6つを開いた時、「通信エラー・再試行」ではなく
// 「ログインし直す・管理者へ連絡」（FORBIDDEN_REASON）を出す。直す前は6画面とも gate.forbidden を読まず、
// !gate.observed だけで通信エラーの帯に落ち、何度再試行しても直らなかった
// ─────────────────────────────────────────────────────────────────────────────

describe('★F61 手直し: 入力の主画面6つは、許可リスト外のアカウントに FORBIDDEN_REASON を出す（再試行のボタンを出さない）', () => {
  const pages = ['VitalsSheetPage', 'VitalsGridPage', 'MealsSheetPage', 'MealsGridPage', 'BathRecordPage', 'MedRecordPage']
  for (const p of pages) {
    it(`${p}: 入力解禁の forbidden を読み、FORBIDDEN_REASON を出す`, () => {
      const s = read(`pages/${p}.tsx`)
      assert.match(s, /import \{\s+FORBIDDEN_REASON,[\s\S]*?\} from '\.\.\/lib\/db'/, `${p} が FORBIDDEN_REASON を読み込んでいない`)
      assert.match(s, /(gate|gateNow)(\?)?\.forbidden === true/, `${p} が入力解禁の forbidden を読んでいない`)
      assert.ok((s.match(/FORBIDDEN_REASON/g) ?? []).length >= 2, `${p} が FORBIDDEN_REASON を画面に出していない`)
    })
  }

  it('バイタル2画面: 許可リスト外の帯は通信エラーの帯（もう一度確認する）より先に判定し、再試行のボタンを持たない', () => {
    for (const p of ['VitalsSheetPage', 'VitalsGridPage']) {
      const s = read(`pages/${p}.tsx`)
      const at = s.indexOf('{forbidden ? (')
      const unknown = s.indexOf(') : gateUnknown ? (')
      assert.ok(at > 0 && unknown > at, `${p}: 許可リスト外の分岐が無い・通信エラーより後`)
      assert.doesNotMatch(s.slice(at, unknown), /<button/, `${p}: 許可リスト外の帯に再試行のボタンがある`)
      assert.match(s.slice(at, unknown), /\{FORBIDDEN_REASON\}/)
    }
  })

  it('食事2画面: 許可リスト外の時は flagError に FORBIDDEN_REASON を入れ、ErrorBlock の再試行を外す', () => {
    for (const p of ['MealsSheetPage', 'MealsGridPage']) {
      const s = read(`pages/${p}.tsx`)
      assert.match(s, /if \(gate\.forbidden === true\) \{\s+setFlagError\(FORBIDDEN_REASON\)\s+return\s+\}/, `${p}`)
      assert.match(s, /<ErrorBlock message=\{flagError\} onRetry=\{forbidden \? undefined : \(\) => void loadFlag\(\)\} \/>/, `${p}`)
    }
  })

  it('入浴・与薬: 許可リスト外は再試行なしの ErrorBlock を、通信エラーの ErrorBlock より先に出す', () => {
    for (const p of ['BathRecordPage', 'MedRecordPage']) {
      const s = read(`pages/${p}.tsx`)
      assert.match(s, /const forbidden = gate\?\.forbidden === true/, `${p}`)
      assert.match(s, /\{forbidden \? \(\s+<ErrorBlock message=\{FORBIDDEN_REASON\} \/>\s+\) : gateUnknown \? \(/, `${p}`)
    }
  })
})
