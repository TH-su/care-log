// デイ（せせらぎ）段階3a: 個別機能訓練の実施記録とその日の配置の回帰テスト（2026-10-23・代表者承認・段階3の計画 v1）。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/daycareTraining.ts）: 入力の検査（必須5項目・中止の決まり）・送る形（中止は時間なし・理由は中止だけ）・
//    〔完了〕の既定（前回の内容・20分・開始時刻＝押した時刻−時間）・対象者・配置（指導員・兼務の知らせ・時間帯の表示）
// 2. 静的検査: 移行 0046 の形（追加のみ・冪等・do ブロックなし・物理削除なし・過去の日の守り・写しは事務所だけ）・db.ts の配線
//    （送信待ちの表・機能訓練だけの旗・自然キー・合流しない・別のチャンネル）・画面（書き込みは決まった関数だけ・端末に残さない・
//    記録がある方に〔完了〕を出さない・過去の日は現場で書かない）
// DB の層（RLS・check・トリガ・写しの関数）は tests/daycare-training-contract.mjs（pg-run-all で流す）。
// 個人情報は置かない（利用者・職員は数値IDだけ・内容は試験用の架空の文）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const sqlCode = (p) => read(p).replace(/--.*$/gm, '')

let T = null
let loadError = null
try {
  T = await import('../src/lib/daycareTraining.ts')
} catch (e) {
  loadError = e
}

const session = (over = {}) => ({
  id: 1,
  resident_id: 7,
  day: '2026-10-20',
  started_at: '10:00',
  duration_min: 20,
  program: '立ち上がり',
  result: 'done',
  cancel_reason: null,
  cancel_note: null,
  instructor_id: 3,
  assisted_by: null,
  note: null,
  recorded_by: 1,
  rev: 1,
  ...over,
})
const input = (over = {}) => ({
  result: 'done',
  started_at: '10:00',
  minutes: '20',
  program: '立ち上がり',
  instructor_id: 3,
  assisted_by: null,
  cancel_reason: null,
  cancel_note: '',
  note: '',
  ...over,
})
const staffing = (over = {}) => ({ id: 1, day: '2026-10-23', staff_id: 3, role: 'trainer', from_time: null, to_time: null, note: null, rev: 1, ...over })

if (T === null) {
  registerLoadFailure('段階3a（個別機能訓練）の試験', loadError, 'この Node では TypeScript を直接読み込めません（Node 22.18 以降で実行してください）')
} else {
  describe('純ロジック（daycareTraining.ts）', () => {
    it('結果・中止の理由・役割の値は DB の check と同じ。知らない値は null（受信値を信じない）', () => {
      assert.deepEqual([...T.TRAINING_RESULTS], ['done', 'partial', 'cancelled'])
      assert.deepEqual([...T.TRAINING_CANCEL_REASONS], ['condition', 'refused', 'time', 'other'])
      assert.deepEqual([...T.STAFFING_ROLES], ['trainer', 'nurse'])
      assert.equal(T.trainingResultOf('skipped'), null)
      assert.equal(T.cancelReasonOf('absent'), null, '欠席は理由に無い（欠席の方は対象者に出ない）')
      assert.equal(T.staffingRoleOf('manager'), null)
      assert.equal(T.TRAINING_CANCEL_REASON_LABEL.condition, '体調不良')
      assert.equal(T.STAFFING_ROLE_LABEL.trainer, '機能訓練指導員')
    })
    it('必須5項目: 開始時刻・内容・時間・指導員が欠けると欄ごとに理由。結果は選択式', () => {
      assert.deepEqual(T.trainingInputErrors(input()), {})
      assert.ok(T.trainingInputErrors(input({ started_at: '' })).started_at)
      assert.ok(T.trainingInputErrors(input({ program: '  ' })).program)
      assert.ok(T.trainingInputErrors(input({ minutes: '' })).minutes)
      assert.ok(T.trainingInputErrors(input({ minutes: '0' })).minutes)
      assert.ok(T.trainingInputErrors(input({ minutes: '241' })).minutes)
      assert.ok(T.trainingInputErrors(input({ minutes: '2.5' })).minutes)
      assert.deepEqual(T.trainingInputErrors(input({ minutes: '２０' })), {}, '全角の数字も受ける')
      assert.ok(T.trainingInputErrors(input({ instructor_id: null })).instructor_id)
      assert.ok(T.trainingInputErrors(input({ program: 'あ'.repeat(101) })).program)
    })
    it('中止: 時間は見ない・理由が必須・その他は一言が要る（空白だけは不可）', () => {
      assert.deepEqual(T.trainingInputErrors(input({ result: 'cancelled', minutes: '', cancel_reason: 'condition' })), {})
      assert.ok(T.trainingInputErrors(input({ result: 'cancelled', cancel_reason: null })).cancel_reason)
      assert.ok(T.trainingInputErrors(input({ result: 'cancelled', cancel_reason: 'other', cancel_note: '   ' })).cancel_note)
      assert.deepEqual(T.trainingInputErrors(input({ result: 'cancelled', cancel_reason: 'other', cancel_note: '受診のため' })), {})
    })
    it('送る形: 中止は時間を送らず、中止でなければ理由を送らない（DB の両向きの check）。内容は NFKC・前後の空白なし', () => {
      assert.deepEqual(T.trainingPayload(input({ program: ' 歩行　の練習 ' })), {
        result: 'done',
        started_at: '10:00',
        duration_min: 20,
        program: '歩行 の練習',
        instructor_id: 3,
        assisted_by: null,
        cancel_reason: null,
        cancel_note: null,
        note: null,
      })
      const c = T.trainingPayload(input({ result: 'cancelled', minutes: '30', cancel_reason: 'other', cancel_note: ' 受診 ' }))
      assert.equal(c.duration_min, null)
      assert.equal(c.cancel_reason, 'other')
      assert.equal(c.cancel_note, '受診')
      const d = T.trainingPayload(input({ result: 'partial', minutes: '10', cancel_reason: 'condition', cancel_note: 'x' }))
      assert.equal(d.cancel_reason, null, '中止でない時に理由を送らない')
      assert.equal(d.cancel_note, null)
      assert.equal(d.duration_min, 10)
    })
    it('〔完了〕の開始時刻の既定は、押した時刻から時間を引いた時刻（0 時より前にしない）', () => {
      assert.equal(T.defaultStartTime(10 * 60 + 30), '10:10')
      assert.equal(T.defaultStartTime(10 * 60 + 30, 45), '09:45')
      assert.equal(T.defaultStartTime(5, 20), '00:00')
      assert.equal(T.TRAINING_DEFAULT_MIN, 20, 'DESIGN v1 と同じ20分')
    })
    it('前回の内容: その日より前の、中止でない、いちばん新しい日の内容。その日・他の方・中止は見ない', () => {
      const list = [
        session({ id: 1, day: '2026-10-15', program: '歩行' }),
        session({ id: 2, day: '2026-10-18', program: '筋力' }),
        session({ id: 3, day: '2026-10-19', program: 'バランス', result: 'cancelled', duration_min: null, cancel_reason: 'condition' }),
        session({ id: 4, day: '2026-10-20', program: '今日の分' }),
        session({ id: 5, day: '2026-10-19', program: '他の方', resident_id: 8 }),
      ]
      assert.equal(T.previousProgram(list, 7, '2026-10-20'), '筋力')
      assert.equal(T.previousProgram(list, 9, '2026-10-20'), null)
    })
    it('今日の対象者はその日に来た方（在席・帰宅）だけ。欠席・予定だけの方は出さない', () => {
      const rows = [
        { residentId: 1, state: 'present' },
        { residentId: 2, state: 'left' },
        { residentId: 3, state: 'absent' },
        { residentId: 4, state: 'planned' },
      ]
      assert.deepEqual(T.trainingTargets(rows), [1, 2])
    })
    it('配置: その日の機能訓練指導員（重なりなし）・時間帯を分けずに両方の役割に入っている方を知らせる', () => {
      const list = [
        staffing({ id: 1, staff_id: 3, role: 'trainer', from_time: '09:00', to_time: '10:00' }),
        staffing({ id: 2, staff_id: 3, role: 'trainer', from_time: '15:00', to_time: '16:00' }),
        staffing({ id: 3, staff_id: 4, role: 'nurse' }),
        staffing({ id: 4, staff_id: 5, role: 'trainer' }),
        staffing({ id: 5, staff_id: 5, role: 'nurse', from_time: '13:00', to_time: '14:00' }),
        staffing({ id: 6, staff_id: 6, role: 'trainer', from_time: '09:00', to_time: '12:00' }),
        staffing({ id: 7, staff_id: 6, role: 'nurse', from_time: '13:00', to_time: '15:00' }),
        staffing({ id: 8, staff_id: 9, role: 'trainer', day: '2026-10-22' }),
      ]
      assert.deepEqual(T.trainersOf(list, '2026-10-23'), [3, 5, 6])
      assert.deepEqual(T.dualRoleWithoutTime(list, '2026-10-23'), [5], '時間帯を分けた兼務（6）は知らせない')
      assert.equal(T.staffingTimeText({ from_time: '09:00', to_time: '10:30' }), '9:00〜10:30')
      assert.equal(T.staffingTimeText({ from_time: null, to_time: null }), '')
    })
    it('時刻の読み方と要約: 秒を落とす・中止は理由を出す', () => {
      assert.equal(T.hhmm('10:05:00'), '10:05')
      assert.equal(T.hhmm('25:00'), null)
      assert.equal(T.sessionText(session()), '完了 10:00〜 20分 立ち上がり')
      assert.equal(
        T.sessionText(session({ result: 'cancelled', duration_min: null, cancel_reason: 'other', cancel_note: '受診', started_at: '09:30' })),
        '中止（その他・受診）9:30',
      )
    })
  })
}

describe('静的検査（段階3a の規律）', () => {
  const mig = read('../supabase/migrations/0046_daycare_training.sql')
  const migCode = sqlCode('../supabase/migrations/0046_daycare_training.sql')
  it('移行 0046: 追加のみ・冪等・do ブロックなし・旗は false・既存の表を変えない・物理削除なし', () => {
    assert.doesNotMatch(migCode, /do \$\$/)
    assert.doesNotMatch(migCode, /\bdrop table\b|\bdelete from\b|alter table public\.(residents|staff|vitals|daycare_attendance|daycare_activity_log|resident_vital_limits|app_settings)\b/i)
    assert.match(migCode, /values \('input_enabled_daycare_training', 'false'\)\s+on conflict \(key\) do nothing;/)
    for (const t of ['daycare_training_sessions', 'daycare_home_visits', 'daycare_training_due', 'daycare_training_due_settings', 'daycare_staffing']) {
      assert.match(migCode, new RegExp(`create table if not exists public\\.${t} \\(`), t)
      assert.match(migCode, new RegExp(`revoke delete, truncate on public\\.${t} from authenticated;`), t)
      assert.match(migCode, new RegExp(`revoke all on public\\.${t} from anon;`), t)
    }
    assert.doesNotMatch(migCode, /for delete/)
    assert.match(migCode, /notify pgrst, 'reload schema';/)
    assert.match(mig, /個人情報: このファイルに実在の氏名・記録本文を書かない/)
  })
  it('移行 0046: 実施記録の決まり（必須・中止は時間なし・理由は中止だけ・1人1日1件）・期限の状態の列は持たない', () => {
    assert.match(migCode, /check \(\(result = 'cancelled'\) = \(duration_min is null\)\)/)
    assert.match(migCode, /check \(\(result = 'cancelled'\) = \(cancel_reason is not null\)\)/)
    assert.match(migCode, /on public\.daycare_training_sessions \(resident_id, day\)\s+where deleted_at is null;/)
    assert.match(migCode, /started_at\s+time not null/)
    assert.match(migCode, /instructor_id\s+bigint not null references public\.staff\(id\)/)
    const due = migCode.slice(migCode.indexOf('create table if not exists public.daycare_training_due ('), migCode.indexOf('create table if not exists public.daycare_training_due_settings'))
    assert.doesNotMatch(due, /\bstate\b/, '期限の状態は表示の時に出す（保存しない）')
    assert.doesNotMatch(due, /name|diagnosis|disease/i, '氏名・疾患を持たない')
  })
  it('移行 0046: 過去の日の守り（実施記録と配置は現場は当日だけ・居宅訪問は対象外で未来の日だけ止める）', () => {
    assert.match(migCode, /create or replace trigger trg_daycare_training_sessions_day_guard\s+before insert or update on public\.daycare_training_sessions/)
    assert.match(migCode, /create or replace trigger trg_daycare_staffing_day_guard\s+before insert or update on public\.daycare_staffing/)
    assert.match(migCode, /'daycare_training_past_office_only: [^']*'\s+using errcode = '42501'/)
    assert.match(migCode, /if v_role is distinct from 'field' then\s+return new;/)
    assert.match(migCode, /create or replace trigger trg_daycare_home_visits_guard\s+before insert or update on public\.daycare_home_visits/)
    assert.match(migCode, /'daycare_home_visit_future: [^']*'\s+using errcode = '22023'/)
    const visitGuard = migCode.slice(migCode.indexOf('function public.daycare_home_visit_guard()'), migCode.indexOf('trg_daycare_home_visits_guard'))
    assert.doesNotMatch(visitGuard, /my_role/, '居宅訪問は役割で止めない（後日の記録・後日の説明）')
  })
  it('移行 0046: 写しは事務所・管理者だけ（0040 の関数を呼ぶだけ）・app_settings に書かない・空上書きの保護', () => {
    assert.match(migCode, /create policy "insert_office" on public\.daycare_training_due for insert to authenticated\s+with check \(private\.office_writable\(\)\);/)
    assert.match(migCode, /create policy "insert_office" on public\.daycare_training_due_settings for insert to authenticated\s+with check \(private\.office_writable\(\)\);/)
    assert.doesNotMatch(migCode, /create or replace function private\.office_writable/, '0040 の関数は変えない')
    const fn = migCode.slice(migCode.indexOf('create or replace function public.daycare_training_due_sync'), migCode.indexOf('comment on function public.daycare_training_due_sync'))
    assert.match(fn, /security invoker/)
    assert.doesNotMatch(fn, /app_settings/)
    assert.doesNotMatch(fn, /temp table/, '一時表を作らない（ログインの権限で作れないことがある）')
    for (const why of ['empty', 'nomatch', 'too_many']) assert.match(fn, new RegExp(`'reason', '${why}'`), why)
    assert.match(fn, /join public\.residents r on r\.source_id = e->>'master_id'/, '利用者番号だけで結ぶ（氏名で結ばない）')
  })
  it('types.ts は InputKind に1行足すだけ（INPUT_KINDS は元のまま・機能訓練の型は daycareTraining.ts）', () => {
    const t = read('../src/lib/types.ts')
    assert.match(t, /\n {2}\| 'daycare_training' \/\/[^\n]*\nexport const INPUT_KINDS: readonly InputKind\[\] = \['bath', 'med', 'incident'\]/)
    assert.doesNotMatch(t, /DaycareTraining|daycare_training_sessions/)
  })
  it('db.ts の配線: 送信待ちの表・機能訓練だけの旗・自然キー（利用者・日）・合流しない・別のチャンネル・読み取りは絞って上限つき', () => {
    const db = code('../src/lib/db.ts')
    assert.match(db, /type LegacyTable = [^\n]*'daycare_training_sessions' \| 'daycare_staffing'/)
    assert.match(db, /if \(table === 'daycare_training_sessions' \|\| table === 'daycare_staffing'\) return assertKindWritable\('daycare_training'\)/)
    assert.match(db, /daycare_training: 'デイの機能訓練の記録はまだ使い始めていません（開始日に解禁します）'/)
    assert.match(db, /if \(table === 'daycare_training_sessions'\) \{\s*const day = dateStr\(payload\.day\)\s*return day === null \? null : \{ resident_id: residentId, day \}/)
    assert.match(db, /if \(table === 'daycare_staffing'\) return staffingKeyTaken\(sb, payload\)/)
    // 合流しない: 23505 で他の端末の行を見つけたら taken（同じ結果でも合流しない）
    const ins = db.slice(db.indexOf('export async function insertTrainingSession'), db.indexOf('export async function updateTrainingSession'))
    assert.match(ins, /return \{ kind: 'taken', row: other === null \? null : normalizeTrainingSession\(other\.row\) \}/)
    assert.doesNotMatch(ins, /merged/)
    assert.match(ins, /if \(a\.day > localToday\(\)\) throw new DbError\('server', DAYCARE_MSG\.future\)/)
    // 段階1・2のチャンネルに混ぜない
    assert.match(db, /const REALTIME_DAYCARE_TRAINING_TABLES = \['daycare_training_sessions', 'daycare_staffing'\] as const/)
    assert.match(db, /sb\.channel\(`cl_dctrn_/)
    const reads = db.slice(db.indexOf('export async function fetchTrainingSessions'), db.indexOf('export type TrainingSessionAdd'))
    assert.equal((reads.match(/\.is\('deleted_at', null\)/g) ?? []).length, 3)
    assert.equal((reads.match(/\.limit\(/g) ?? []).length, 3)
    // 中止 ↔ 実施を切り替える修正は、時間と理由を一緒に送る（両向きの check に当たらない）
    assert.match(db, /if \('result' in sent\) \{\s*sent\.duration_min = next\.duration_min\s*sent\.cancel_reason = next\.cancel_reason/)
  })
  it('止まった送信待ち・変更の記録の呼び名', () => {
    const so = code('../src/lib/stoppedOps.ts')
    assert.match(so, /daycare_training_sessions: 'デイの機能訓練'/)
    assert.match(so, /daycare_staffing: 'デイの配置'/)
    assert.match(code('../src/lib/historyView.ts'), /daycare_training_sessions: 'デイの機能訓練'/)
  })
  it('機能訓練の画面: 書き込みは決まった関数だけ・機能訓練だけの旗・端末に残さない・記録がある方に〔完了〕を出さない・過去の日は現場で書かない', () => {
    const p = code('../src/pages/DaycareTrainingPage.tsx')
    const writes = p.match(/\b(save\w+|insert\w+|update\w+|delete\w+|softDelete\w+|upsert\w+)\(/g) ?? []
    assert.deepEqual(
      [...new Set(writes.map((w) => w.slice(0, -1)))].filter((w) => !['saveNew', 'saveEditor'].includes(w)).sort(),
      ['insertStaffing', 'insertTrainingSession', 'softDeleteStaffing', 'softDeleteTrainingSession', 'updateTrainingSession'],
    )
    assert.match(p, /getKindInputGate\('daycare_training'\)/)
    assert.doesNotMatch(p, /localStorage|sessionStorage|indexedDB/)
    assert.match(p, /const pastLocked = day < today && !canEditPastDaycareTimes\(role\)/)
    assert.match(p, /\{s !== null \? \(\s*<button[^>]*onClick=\{\(\) => openRow\(s\)\}/)
    // 小窓の入力は直前の値から足す（続けて押した時に前の変更を古い値で上書きしない＝試験用 Supabase の E3 で見つけた）
    assert.match(p, /const setInput = \(patch: Partial<TrainingInput>\) => setEditor\(\(cur\) => \(cur === null \? cur : \{ \.\.\.cur, input: \{ \.\.\.cur\.input, \.\.\.patch \} \}\)\)/)
    // 足りない項目は押した時に出す（開いた直後から赤い文字を出さない）
    assert.match(p, /setEditor\(\{ \.\.\.ed, showErr: true \}\)/)
    // 取り消しは確認つき
    assert.match(p, /<ConfirmDialog\s+open=\{delSession !== null\}/)
    assert.match(p, /<ConfirmDialog\s+open=\{delStaff !== null\}/)
  })
  it('入口: ルート・画面名・切り替え・1人の画面のカード（読むだけ）', () => {
    const app = code('../src/App.tsx')
    assert.match(app, /<Route path="\/record\/daycare\/training" element=\{<DaycareTrainingPage actorId=\{actorId\} staff=\{staff\} \/>\} \/>/)
    assert.match(app, /if \(pathname === '\/record\/daycare\/training'\) return 'デイ 機能訓練'/)
    assert.match(code('../src/pages/DaycarePage.tsx'), /\{ key: 'training', to: '\/record\/daycare\/training', label: '機能訓練' \}/)
    const card = code('../src/components/DaycareTrainingCard.tsx')
    assert.doesNotMatch(card, /\b(insert\w+|update\w+|softDelete\w+)\(/, 'カードからは書かない')
    assert.match(code('../src/pages/DaycarePersonPage.tsx'), /<DaycareTrainingCard\s/)
  })
  it('純ロジックは端末に何も残さない（localStorage・supabase を使わない）', () => {
    assert.doesNotMatch(code('../src/lib/daycareTraining.ts'), /localStorage|supabase/)
  })
})
