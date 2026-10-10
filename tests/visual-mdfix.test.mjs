// 多端末の改修（2026-10-10）で足した画面の部品の見え方を見張る静的な試験。
// ヘッドレス Chrome での確認（文字200%・印刷）で見つかった2点が戻らないようにする。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('記録者の表示は文字200%でも名前を切らない（truncate で「記…」にしない・折り返す）', () => {
  const src = read('src/components/RecorderBar.tsx')
  assert.doesNotMatch(src, /<p className="[^"]*\btruncate\b[^"]*">\s*<span className="text-ink2">記録者: /)
  assert.match(src, /flex min-w-0 flex-wrap items-center gap-2 print:hidden/)
})

test('与薬の「日付が変わりました」の帯は印刷に出さない（日報の同じ帯とそろえる）', () => {
  const src = read('src/pages/MedRecordPage.tsx')
  const i = src.indexOf('日付が変わりました（表示中:')
  assert.ok(i > 0)
  const open = src.lastIndexOf('<div role="status"', i)
  assert.ok(open > 0 && i - open < 400)
  assert.match(src.slice(open, src.indexOf('>', open)), /print:hidden/)
})

test('日報の出勤者・外出の帰着と削除・申し送りの削除などの「送信待ち」の一言は、端末に控えを残せたかで出し分ける（F01 の残り）', () => {
  const src = read('src/pages/DailySheetPage.tsx')
  assert.match(src, /const queuedMsg = \(\): string => \(isQueuePersisted\(\) \? MSG_QUEUED : MSG_NOT_PERSISTED\)/)
  // 送信待ちにした直後に MSG_QUEUED を直接出す所が残っていない（控えから描き直す所と queuedMsg の定義は除く）
  const direct = src.split('\n').filter((l) => /text: MSG_QUEUED \}|show\(MSG_QUEUED\)|\? MSG_QUEUED : '削除しました'/.test(l))
  const allowed = direct.filter((l) => /next\[k\] = \{ tone: 'warn', text: MSG_QUEUED \}|return \{ tone: 'warn', text: MSG_QUEUED \}/.test(l))
  assert.deepEqual(direct.length - allowed.length, 0, direct.join('\n'))
})

test('外出・外泊の登録に失敗した時も「入力した内容はそのまま残っています。」を添える（理由の出し分けは残す）', () => {
  const src = read('src/pages/OutingFormPage.tsx')
  assert.match(src, /e instanceof DbError \? `\$\{e\.message\}　入力した内容はそのまま残っています。` : SUBMIT_ERROR_UNKNOWN/)
})
