// 純ロジック回帰テスト。
// 実行: node --test tests/logic.test.mjs
//   npm test（= "node --test tests/"）は Node 24 だとディレクトリ引数をテストファイルとして
//   直接実行しようとして MODULE_NOT_FOUND になる（実測: Node v24.16.0）。package.json は
//   凍結対象のため直せないので、スクリプトの修正は積み残しとして裁定待ち。
//
// 対象は src/lib/types.ts・src/lib/format.ts の純関数だけ。DB・DOM・env・Supabase には一切触れない
// （env 未設定でも走ること自体がこのファイルの前提）。しきい値と日付計算はスプシ運用の実測値に
// 由来する凍結仕様なので、値がずれたら必ずここで落ちるようにする。
//
// 個人情報は置かない（利用者・職員は数値IDのみ。氏名・記録本文・実データ由来の文字列を書かない）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 検証対象は凍結ファイル（src/lib/types.ts・src/lib/format.ts）そのもの。しきい値の写しは持たない
// （写しを持つと本体がずれてもテストが落ちなくなり、回帰テストの意味が無くなる）。
//
// TypeScript を実行時に直接読み込めるのは Node 22.18 以降（それ以前は型の除去に非対応）。
// npm test のコマンド（package.json）は凍結仕様のため実行フラグを足せないので、読み込めない
// Node では検証を登録せずスキップし、理由を実行結果に残す（黙って「成功」にしない）。
const TS_UNSUPPORTED =
  'この Node では TypeScript を直接読み込めないため、純ロジックの検証をスキップしました（Node 22.18 以降で実行してください）。'

let T = null
let F = null
try {
  T = await import('../src/lib/types.ts')
  F = await import('../src/lib/format.ts')
} catch {
  T = null
  F = null
}
const TS_READY = T !== null && F !== null

const { tempLevel, sysBpLevel, diaBpLevel, pulseLevel, spo2Level, LEVEL_MARK, vitalHasAlert, isLowIntake } =
  T ?? {}
const { nameKey, noteDisplayName, hasNoteAlias, validateNoteAlias, NOTE_ALIAS_MAX } = T ?? {}
const { isoDate, addDays, fmtDayLabel, normalizeVitalInput, toHalfWidth } = F ?? {}

// ── テスト用ダミー（個人情報なし・IDは数値のみ） ──

/** Vital の最小形。上書きしたい項目だけ渡す */
function vital(over = {}) {
  return {
    id: 1,
    resident_id: 1,
    measured_on: '2026-08-27',
    kind: 'routine',
    measured_at: null,
    temp: null,
    sys_bp: null,
    dia_bp: null,
    pulse: null,
    spo2: null,
    note: null,
    recorded_by: null,
    rev: 1,
    ...over,
  }
}

/** Meal の最小形。上書きしたい項目だけ渡す */
function meal(over = {}) {
  return {
    id: 1,
    resident_id: 1,
    meal_on: '2026-08-27',
    meal_slot: 'lunch',
    main_amount: null,
    side_amount: null,
    status: null,
    note: null,
    recorded_by: null,
    rev: 1,
    ...over,
  }
}

// ── タイムゾーン検証用の観測（子プロセスで TZ を差し替えて同じ関数を実行する） ──

// 日付3関数はローカル時刻基準で組まれている（toISOString の UTC ずれを避けるため）。
// 「どの TZ でも同じ答えになる」ことは1プロセス内では確かめられないので、TZ を変えた子プロセスで実測する。
const TZ_LIST = [
  'Asia/Tokyo', // 実運用（JST・DSTなし）
  'UTC',
  'America/Los_Angeles', // 夏時間あり・UTC西側
  'Pacific/Kiritimati', // UTC+14（ローカル00:00がUTC前日になる極値）
  'Etc/GMT+12', // UTC-12（ローカル23:59がUTC翌日になる極値）
  'America/Santiago', // 夏時間の開始が現地24:00＝翌日00:00が存在しない日を含む
  'Asia/Kathmandu', // UTC+5:45（30分刻みでないオフセット）
]

const PROBE_ENV = 'CL_LOGIC_TEST_TZ_PROBE'

function tzObservations() {
  return {
    isoDates: [
      isoDate(new Date(2026, 7, 27)), // 通常日
      isoDate(new Date(2026, 7, 27, 0, 0, 0)), // ローカル00:00（UTCへ寄せると前日になり得る）
      isoDate(new Date(2026, 7, 27, 23, 59, 59)), // ローカル23:59（UTCへ寄せると翌日になり得る）
      isoDate(new Date(2026, 0, 1)), // 年初
      isoDate(new Date(2026, 11, 31, 23, 59, 59)), // 年末の深夜
      isoDate(new Date(2024, 1, 29)), // 閏日
    ],
    addDays: [
      addDays('2026-08-31', 1), // 月跨ぎ（+）
      addDays('2026-09-01', -1), // 月跨ぎ（-）
      addDays('2026-12-31', 1), // 年跨ぎ（+）
      addDays('2026-01-01', -1), // 年跨ぎ（-）
      addDays('2024-02-28', 1), // 閏年
      addDays('2026-02-28', 1), // 平年
      addDays('2026-03-08', 1), // 米国夏時間の開始日
      addDays('2026-11-01', 1), // 米国夏時間の終了日
      addDays('2026-09-05', 1), // チリ夏時間の開始日（翌日00:00が存在しない）
      addDays('2026-08-27', -9), // タイムライン10日分の遡り
    ],
    labels: [
      fmtDayLabel('2026-08-27'),
      fmtDayLabel('2026-08-31'),
      fmtDayLabel('2026-09-01'),
      fmtDayLabel('2026-01-05'),
      fmtDayLabel('2024-02-29'),
    ],
    // UTC ずれの実在確認用（isoDate と比較して差が出ることを確かめる）
    utcSliceAtMidnight: new Date(2026, 7, 27, 0, 0, 0).toISOString().slice(0, 10),
    utcSliceAtEndOfDay: new Date(2026, 7, 27, 23, 59, 59).toISOString().slice(0, 10),
  }
}

const TZ_EXPECTED = {
  isoDates: ['2026-08-27', '2026-08-27', '2026-08-27', '2026-01-01', '2026-12-31', '2024-02-29'],
  addDays: [
    '2026-09-01',
    '2026-08-31',
    '2027-01-01',
    '2025-12-31',
    '2024-02-29',
    '2026-03-01',
    '2026-03-09',
    '2026-11-02',
    '2026-09-06',
    '2026-08-18',
  ],
  labels: ['8/27（木）', '8/31（月）', '9/1（火）', '1/5（月）', '2/29（木）'],
}

/** 子プロセスを TZ 指定で起動し、観測値を受け取る */
function observeInTz(tz) {
  const self = fileURLToPath(import.meta.url)
  let out
  try {
    out = execFileSync(process.execPath, ['--no-warnings', self], {
      env: { ...process.env, TZ: tz, [PROBE_ENV]: '1' },
      encoding: 'utf8',
    })
  } catch (e) {
    assert.fail(
      `TZ=${tz} の子プロセス実行に失敗しました（日付関数のタイムゾーン非依存性を検証できません）。` +
        `OSのタイムゾーンデータが入っているかを確認してください。詳細: ${e.message}`,
    )
  }
  try {
    return JSON.parse(out)
  } catch {
    assert.fail(`TZ=${tz} の子プロセス出力を JSON として読めませんでした。出力の先頭に警告等が混ざっていないか確認してください。`)
  }
}

// ── src/lib/db.ts（未送信件数・入力解禁ゲート）の読み込み ──
//
// db.ts は相対 import に拡張子を書かない（バンドラが解決する前提）ので、Node からそのままは
// 読めない。テスト側で解決フックを1つ足して '.ts' を補う（本体のコードは変えない）。
// フックが使えない Node ではこの節を登録せず、理由を実行結果に残す。
//
// 併せて localStorage の代役を先に置く（db.ts は typeof で存在を確かめてから使う）。
// window は定義しない＝起動時の自動読み込み・自動再送は動かないので、通信は一切発生しない。
const DB_UNSUPPORTED =
  'この Node では解決フック（module.registerHooks）が使えないため、送信キュー・入力解禁ゲートの検証をスキップしました（Node 22.15 以降で実行してください）。'

/** localStorage の代役。中身はテストごとに差し替える（個人情報は入れない） */
const lsStore = new Map()

let DB = null
if (process.env[PROBE_ENV] !== '1') {
  try {
    const { registerHooks } = await import('node:module')
    if (typeof registerHooks !== 'function') throw new Error('no registerHooks')
    registerHooks({
      resolve(specifier, context, next) {
        // 拡張子の無い相対 import だけ '.ts' を補う（node: や依存パッケージには触らない）
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
    DB = await import('../src/lib/db.ts')
  } catch {
    DB = null
  }
}

/** cl_sendQueue の中身を差し替える（未指定ならキーごと消す） */
function setQueueRaw(raw) {
  if (raw === null) lsStore.delete('cl_sendQueue')
  else lsStore.set('cl_sendQueue', raw)
}

/**
 * Resident の最小形。**氏名は実在しない記号（利用者A 等）にする**
 * ＝このファイルに実在の氏名を置かない規律を守るため。
 */
function resident(id, name, over = {}) {
  return {
    id,
    source_id: `S${id}`,
    name,
    kana: null,
    room: null,
    gender: null,
    care_level: null,
    active: true,
    needs_review: false,
    note_alias: null,
    ...over,
  }
}

/** 退避 op の最小形（業務データは持たせない。table/kind/payload だけ整っていればよい） */
function op(qid, over = {}) {
  return { qid, table: 'notes', kind: 'insert', payload: { note_on: '2026-08-27' }, ...over }
}

// ── 子プロセスモード: テストを登録せず観測値だけを出力する ──

if (process.env[PROBE_ENV] === '1') {
  process.stdout.write(JSON.stringify(tzObservations()))
} else if (TS_READY) {
  registerTests()
  if (DB) registerDbTests()
  else it('送信キュー・入力解禁ゲートの検証', { skip: DB_UNSUPPORTED }, () => {})
} else {
  // 対象を読み込めない Node。テスト本体は登録せず、スキップの理由だけを結果に残す
  it('純ロジックの回帰テスト', { skip: TS_UNSUPPORTED }, () => {})
}

// ══════════════════════════════════════════════════════════════
// 未送信件数（queuePending / queueSubscribe）と入力解禁ゲート（getNativeInputGate）
//
// - 未送信件数は「メモリのキュー ∪ localStorage の qid 付き op」。同じ端末の別タブが
//   退避した分も数える（数えないと2つ目のタブで「0件」と出たまま送られていない記録が残る）。
// - 入力解禁ゲートは「false を観測した（＝スプシ期間）」と「観測できなかった（＝通信エラー）」を
//   区別して返す。接続先未設定のこの環境では常に後者（observed:false）になる。
// ══════════════════════════════════════════════════════════════

function registerDbTests() {
  describe('queuePending（未送信件数）', () => {
    it('localStorage が空なら0件', () => {
      setQueueRaw(null)
      assert.equal(DB.queuePending(), 0)
    })

    it('別タブが退避した qid 付き op を数える（メモリのキューが空でも件数に出る）', () => {
      setQueueRaw(JSON.stringify({ ops: [op('a'), op('b'), op('c')] }))
      assert.equal(DB.queuePending(), 3)
    })

    it('同じ qid は1件として数える（和集合＝重複計上しない）', () => {
      setQueueRaw(JSON.stringify({ ops: [op('a'), op('a')] }))
      assert.equal(DB.queuePending(), 1)
    })

    it('qid の無い行は数えない（同一性を判定できないため）', () => {
      const noQid = op('x')
      delete noQid.qid
      setQueueRaw(JSON.stringify({ ops: [op('a'), noQid] }))
      assert.equal(DB.queuePending(), 1)
    })

    it('table/kind が壊れた行は数えない（未送信の記録として扱わない）', () => {
      setQueueRaw(JSON.stringify({ ops: [op('a'), op('b', { table: 'unknown_table' })] }))
      assert.equal(DB.queuePending(), 1)
    })

    it('自動再送を止めた op（blocked）も未送信として数える', () => {
      setQueueRaw(JSON.stringify({ ops: [op('a', { blocked: 'conflict' })] }))
      assert.equal(DB.queuePending(), 1)
    })

    it('旧形式（op の配列そのもの）も数える', () => {
      setQueueRaw(JSON.stringify([op('a'), op('b')]))
      assert.equal(DB.queuePending(), 2)
    })

    it('JSON として読めない値でも例外を投げず0件（画面を落とさない）', () => {
      setQueueRaw('{壊れた値')
      assert.equal(DB.queuePending(), 0)
    })

    it('件数を数えても localStorage の中身は書き換えない（読むだけ）', () => {
      const raw = JSON.stringify({ ops: [op('a')] })
      setQueueRaw(raw)
      DB.queuePending()
      assert.equal(lsStore.get('cl_sendQueue'), raw)
    })
  })

  describe('queueSubscribe（未送信件数の通知）', () => {
    it('登録直後に現在値を1回通知する（別タブ由来の件数を含む）', () => {
      setQueueRaw(JSON.stringify({ ops: [op('a'), op('b')] }))
      const seen = []
      const unsub = DB.queueSubscribe((n) => seen.push(n))
      unsub()
      assert.deepEqual(seen, [2])
    })

    it('解除後は通知されない', () => {
      setQueueRaw(JSON.stringify({ ops: [op('a')] }))
      const seen = []
      DB.queueSubscribe((n) => seen.push(n))()
      assert.equal(seen.length, 1)
    })
  })

  describe('isSelfWrite（自分の書込と他端末の変更の見分け）', () => {
    // ★2026-09-05 の修正の回帰テスト。
    //   以前は「自分の保存から3秒間の通知を捨てる」時刻だけの判定で、同じ3秒に届いた
    //   他端末の変更まで落としていた（捨てた通知は再生されないので無期限に古いまま）。
    //   いまは「どの行の、どの版まで自分が書いたか」で見分ける。
    it('覚えのない行は自分の書込ではない（＝他端末の変更として拾う）', () => {
      assert.equal(DB.isSelfWrite('notes', { id: 999_001, rev: 1 }), false)
    })
    it('行を特定できない通知（row なし）は自分の書込ではない', () => {
      assert.equal(DB.isSelfWrite('notes', null), false)
      assert.equal(DB.isSelfWrite('notes', undefined), false)
      assert.equal(DB.isSelfWrite('notes', 'こわれた値'), false)
    })
    it('版が読めない通知は自分の書込ではない（安全側）', () => {
      assert.equal(DB.isSelfWrite('notes', { id: 999_002 }), false)
    })
    it('表が違えば別の行として扱う', () => {
      assert.equal(DB.isSelfWrite('vitals', { id: 999_001, rev: 1 }), false)
    })

    // 判定の核（版の比較）。ここが「同じ行を他端末が直後に書き換えた通知」を守っている
    it('自分が書いた版の通知は反映済み（＝取り直さない）', () => {
      assert.equal(DB.isSeenRev(5, { rev: 5 }), true)
    })
    it('★自分が書いた版より新しい通知は他端末の変更（＝必ず拾う）', () => {
      assert.equal(DB.isSeenRev(5, { rev: 6 }), false)
      assert.equal(DB.isSeenRev(1, { rev: 2 }), false)
    })
    it('自分が書いた版より古い通知は反映済み（行き違いで遅れて届いた分）', () => {
      assert.equal(DB.isSeenRev(5, { rev: 4 }), true)
    })
    it('版が読めない通知は他端末の変更として扱う（安全側）', () => {
      assert.equal(DB.isSeenRev(5, {}), false)
      assert.equal(DB.isSeenRev(5, null), false)
      assert.equal(DB.isSeenRev(5, { rev: 'こわれた値' }), false)
    })
    it('版を持たない表（出勤者・既読）は猶予の間だけ自分のものとみなす', () => {
      assert.equal(DB.isSeenRev(null, { day: '2026-09-05', staff_id: 1 }), true)
    })
  })

  describe('getNativeInputGate（入力解禁フラグ）', () => {
    it('サーバー値を観測できない時は observed:false・value:false（封鎖と区別できる）', async () => {
      const gate = await DB.getNativeInputGate()
      assert.deepEqual(gate, { value: false, observed: false })
    })

    it('getNativeInputEnabled は gate.value と同じ値を返す（互換）', async () => {
      const gate = await DB.getNativeInputGate()
      assert.equal(await DB.getNativeInputEnabled(), gate.value)
    })
  })
}

function registerTests() {
  // ══════════════════════════════════════════════════════════════
  // 申し送りでの表示名（2026-09-01 指示）
  //
  // 目的は「同姓の入居者の取り違えを防ぐ」こと。したがって
  //   ・設定が無ければマスタの氏名に落ちること
  //   ・**別人と同じ表示名を作らせないこと**（退居された方の氏名も突き合わせ相手）
  // の2つが崩れたら必ずここで落ちるようにする。
  // ══════════════════════════════════════════════════════════════

  describe('noteDisplayName / hasNoteAlias（申し送りでの表示名）', () => {
    it('設定が無ければマスタの氏名を返す', () => {
      const r = resident(1, '利用者A')
      assert.equal(noteDisplayName(r), '利用者A')
      assert.equal(hasNoteAlias(r), false)
    })

    it('設定があればその名前を返す', () => {
      const r = resident(1, '利用者A', { note_alias: '【甲】利用者A' })
      assert.equal(noteDisplayName(r), '【甲】利用者A')
      assert.equal(hasNoteAlias(r), true)
    })

    it('空白だけの設定はマスタの氏名に落ちる（空欄と同じ扱い）', () => {
      const r = resident(1, '利用者A', { note_alias: '  　 ' })
      assert.equal(noteDisplayName(r), '利用者A')
      assert.equal(hasNoteAlias(r), false)
    })

    it('前後の空白は落として表示する', () => {
      const r = resident(1, '利用者A', { note_alias: '  【甲】利用者A  ' })
      assert.equal(noteDisplayName(r), '【甲】利用者A')
    })
  })

  describe('nameKey（氏名の突き合わせキー）', () => {
    it('半角・全角の空白を除いて比べられる', () => {
      assert.equal(nameKey('利用者　A'), nameKey('利用者 A'))
      assert.equal(nameKey('利用者A'), nameKey('利用者　A'))
    })
  })

  describe('validateNoteAlias（保存前の検証）', () => {
    const others = [
      resident(1, '利用者A'),
      resident(2, '利用者B'),
      resident(3, '利用者C', { note_alias: '【丙】利用者C' }),
      // 退居された方。過去の記録に氏名が残るので突き合わせ相手に含める
      resident(4, '利用者D', { active: false }),
    ]

    it('空欄は null（＝マスタの氏名に戻す）', () => {
      const r = validateNoteAlias('', 1, others)
      assert.equal(r.ok, true)
      assert.equal(r.value, null)
    })

    it('空白だけも null（空文字は保存しない）', () => {
      const r = validateNoteAlias('　 ', 1, others)
      assert.equal(r.ok, true)
      assert.equal(r.value, null)
    })

    it('前後の空白を落として保存する', () => {
      const r = validateNoteAlias('  【甲】利用者A ', 1, others)
      assert.equal(r.ok, true)
      assert.equal(r.value, '【甲】利用者A')
    })

    it('別の利用者の氏名と同じ表示名は弾く', () => {
      const r = validateNoteAlias('利用者B', 1, others)
      assert.equal(r.ok, false)
    })

    it('**退居された方**の氏名と同じ表示名も弾く（過去の記録に残るため）', () => {
      const r = validateNoteAlias('利用者D', 1, others)
      assert.equal(r.ok, false)
    })

    it('別の利用者の表示名と同じ表示名も弾く', () => {
      const r = validateNoteAlias('【丙】利用者C', 1, others)
      assert.equal(r.ok, false)
    })

    it('空白を入れてすり抜けようとしても弾く（空白を除いて比べる）', () => {
      const r = validateNoteAlias('利用者　B', 1, others)
      assert.equal(r.ok, false)
    })

    it('自分自身の氏名はそのまま表示名にできる（重複判定から自分を外す）', () => {
      const r = validateNoteAlias('利用者A', 1, others)
      assert.equal(r.ok, true)
      assert.equal(r.value, '利用者A')
    })

    it('自分の既存の表示名を保存し直せる（自分と衝突しない）', () => {
      const r = validateNoteAlias('【丙】利用者C', 3, others)
      assert.equal(r.ok, true)
    })

    it('上限を超える長さは弾く（境界の外）', () => {
      const r = validateNoteAlias('あ'.repeat(NOTE_ALIAS_MAX + 1), 1, others)
      assert.equal(r.ok, false)
    })

    it('上限ちょうどは通す（境界）', () => {
      const r = validateNoteAlias('あ'.repeat(NOTE_ALIAS_MAX), 1, others)
      assert.equal(r.ok, true)
    })
  })

  // ══════════════════════════════════════════════════════════════
  // しきい値5関数（現行スプシの条件付き書式の凡例＝凍結仕様）
  // 凡例: 体温 ≤35.5 青 / 37.5-38.0 黄 / ≥38.1 赤
  //       BP上 ≥151 赤 / <90 黄   BP下 ≥91 赤 / <50 黄
  //       脈 ≥101 赤 / <40 黄     SpO2 <90 赤 / <93 黄
  // 各表は「境界の手前」「境界そのもの」を必ず対で持つ。
  // ══════════════════════════════════════════════════════════════

  describe('tempLevel（体温）', () => {
    const cases = [
      [null, null, '未測定'],
      [30, 'danger-low', '許容下限'],
      [35.4, 'danger-low', '境界の内側'],
      [35.5, 'danger-low', '境界そのもの（≤35.5）'],
      [35.6, null, '境界の外側'],
      [36.5, null, '平熱'],
      [37.4, null, '境界の手前'],
      [37.5, 'warn-high', '境界そのもの（≥37.5）'],
      [37.9, 'warn-high', '黄帯の内側'],
      [38.0, 'warn-high', '黄帯の上端'],
      [38.1, 'danger-high', '境界そのもの（≥38.1）'],
      [38.2, 'danger-high', '赤帯の内側'],
      [45, 'danger-high', '許容上限'],
    ]
    for (const [v, expected, memo] of cases) {
      it(`${v} → ${expected}（${memo}）`, () => {
        assert.equal(tempLevel(v), expected)
      })
    }
  })

  describe('sysBpLevel（収縮期血圧）', () => {
    const cases = [
      [null, null, '未測定'],
      [40, 'warn-low', '許容下限'],
      [89, 'warn-low', '境界の内側'],
      [90, null, '境界そのもの（<90 が黄なので90は無色）'],
      [120, null, '基準内'],
      [150, null, '境界の手前'],
      [151, 'danger-high', '境界そのもの（≥151）'],
      [152, 'danger-high', '赤帯の内側'],
      [300, 'danger-high', '許容上限'],
    ]
    for (const [v, expected, memo] of cases) {
      it(`${v} → ${expected}（${memo}）`, () => {
        assert.equal(sysBpLevel(v), expected)
      })
    }
  })

  describe('diaBpLevel（拡張期血圧）', () => {
    const cases = [
      [null, null, '未測定'],
      [20, 'warn-low', '許容下限'],
      [49, 'warn-low', '境界の内側'],
      [50, null, '境界そのもの（<50 が黄なので50は無色）'],
      [80, null, '基準内'],
      [90, null, '境界の手前'],
      [91, 'danger-high', '境界そのもの（≥91）'],
      [92, 'danger-high', '赤帯の内側'],
      [200, 'danger-high', '許容上限'],
    ]
    for (const [v, expected, memo] of cases) {
      it(`${v} → ${expected}（${memo}）`, () => {
        assert.equal(diaBpLevel(v), expected)
      })
    }
  })

  describe('pulseLevel（脈拍）', () => {
    const cases = [
      [null, null, '未測定'],
      [20, 'warn-low', '許容下限'],
      [39, 'warn-low', '境界の内側'],
      [40, null, '境界そのもの（<40 が黄なので40は無色）'],
      [70, null, '基準内'],
      [100, null, '境界の手前'],
      [101, 'danger-high', '境界そのもの（≥101）'],
      [102, 'danger-high', '赤帯の内側'],
      [250, 'danger-high', '許容上限'],
    ]
    for (const [v, expected, memo] of cases) {
      it(`${v} → ${expected}（${memo}）`, () => {
        assert.equal(pulseLevel(v), expected)
      })
    }
  })

  describe('spo2Level（SpO2）', () => {
    const cases = [
      [null, null, '未測定'],
      [50, 'danger-low', '許容下限'],
      [89, 'danger-low', '境界の内側（<90 は赤が優先）'],
      [90, 'warn-low', '境界そのもの（90は赤でなく黄）'],
      [91, 'warn-low', '黄帯の内側'],
      [92, 'warn-low', '境界の内側'],
      [93, null, '境界そのもの（<93 が黄なので93は無色）'],
      [98, null, '基準内'],
      [100, null, '許容上限'],
    ]
    for (const [v, expected, memo] of cases) {
      it(`${v} → ${expected}（${memo}）`, () => {
        assert.equal(spo2Level(v), expected)
      })
    }
  })

  describe('しきい値5関数の共通の防御', () => {
    const fns = [
      ['tempLevel', tempLevel],
      ['sysBpLevel', sysBpLevel],
      ['diaBpLevel', diaBpLevel],
      ['pulseLevel', pulseLevel],
      ['spo2Level', spo2Level],
    ]
    for (const [name, fn] of fns) {
      it(`${name}(null) は null（未測定を異常扱いしない）`, () => {
        assert.equal(fn(null), null)
      })
      it(`${name}(NaN) は例外を投げず null（壊れた値で画面を落とさない）`, () => {
        assert.equal(fn(NaN), null)
      })
    }
  })

  // ══════════════════════════════════════════════════════════════
  // LEVEL_MARK（色だけに意味を持たせないための記号）
  // ══════════════════════════════════════════════════════════════

  describe('LEVEL_MARK', () => {
    it('4段階の記号が凍結値どおり', () => {
      assert.deepEqual(LEVEL_MARK, {
        'danger-high': '↑↑',
        'warn-high': '↑',
        'warn-low': '↓',
        'danger-low': '↓↓',
      })
    })

    it('キーは4つだけ（null 用のキーを持たない）', () => {
      assert.deepEqual(Object.keys(LEVEL_MARK).sort(), [
        'danger-high',
        'danger-low',
        'warn-high',
        'warn-low',
      ])
    })

    it('5関数が返し得る非nullレベルには必ず記号がある（色だけに頼らない担保）', () => {
      const probes = [
        [tempLevel, [30, 35.5, 36.5, 37.5, 38.0, 38.1, 45]],
        [sysBpLevel, [40, 89, 90, 120, 151, 300]],
        [diaBpLevel, [20, 49, 50, 80, 91, 200]],
        [pulseLevel, [20, 39, 40, 70, 101, 250]],
        [spo2Level, [50, 89, 90, 92, 93, 100]],
      ]
      const seen = new Set()
      for (const [fn, values] of probes) {
        for (const v of values) {
          const level = fn(v)
          if (level == null) continue
          seen.add(level)
          assert.equal(typeof LEVEL_MARK[level], 'string', `${level} に記号がない`)
          assert.ok(LEVEL_MARK[level].length > 0, `${level} の記号が空`)
        }
      }
      // 4段階すべてが実際に到達可能であること（到達しないレベルは凡例と実装の乖離）
      assert.deepEqual([...seen].sort(), ['danger-high', 'danger-low', 'warn-high', 'warn-low'])
    })
  })

  describe('vitalHasAlert（1件でも異常があれば true）', () => {
    it('全項目が未測定なら false', () => {
      assert.equal(vitalHasAlert(vital()), false)
    })
    it('全項目が基準内なら false', () => {
      assert.equal(
        vitalHasAlert(vital({ temp: 36.5, sys_bp: 120, dia_bp: 80, pulse: 70, spo2: 98 })),
        false,
      )
    })
    it('体温だけが黄でも true', () => {
      assert.equal(vitalHasAlert(vital({ temp: 37.5, sys_bp: 120, spo2: 98 })), true)
    })
    it('SpO2だけが赤でも true', () => {
      assert.equal(vitalHasAlert(vital({ temp: 36.5, spo2: 89 })), true)
    })
    it('境界の手前だけを並べたら false（誤検知しない）', () => {
      assert.equal(
        vitalHasAlert(vital({ temp: 37.4, sys_bp: 150, dia_bp: 90, pulse: 100, spo2: 93 })),
        false,
      )
    })
  })

  // ══════════════════════════════════════════════════════════════
  // isLowIntake（食事の低摂取判定・主+副 ≤6）
  // ══════════════════════════════════════════════════════════════

  describe('isLowIntake', () => {
    it('主0+副0＝0 は低摂取', () => {
      assert.equal(isLowIntake(meal({ main_amount: 0, side_amount: 0 })), true)
    })
    it('主3+副3＝6 は低摂取（境界そのもの）', () => {
      assert.equal(isLowIntake(meal({ main_amount: 3, side_amount: 3 })), true)
    })
    it('主4+副3＝7 は低摂取でない（境界の外側）', () => {
      assert.equal(isLowIntake(meal({ main_amount: 4, side_amount: 3 })), false)
    })
    it('主10+副10 は低摂取でない', () => {
      assert.equal(isLowIntake(meal({ main_amount: 10, side_amount: 10 })), false)
    })
    it('主のみ6・副未入力 は低摂取（未入力は0として合計する）', () => {
      assert.equal(isLowIntake(meal({ main_amount: 6, side_amount: null })), true)
    })
    it('副のみ6・主未入力 は低摂取', () => {
      assert.equal(isLowIntake(meal({ main_amount: null, side_amount: 6 })), true)
    })
    it('副のみ7・主未入力 は低摂取でない', () => {
      assert.equal(isLowIntake(meal({ main_amount: null, side_amount: 7 })), false)
    })
    it('主0・副未入力 は低摂取（0 と未入力を取り違えない）', () => {
      assert.equal(isLowIntake(meal({ main_amount: 0, side_amount: null })), true)
    })
    it('主も副も未入力 は低摂取でない（未記録を低摂取に数えない）', () => {
      assert.equal(isLowIntake(meal({ main_amount: null, side_amount: null })), false)
    })
    it('status=eaten で主も副も未入力 は低摂取でない', () => {
      assert.equal(
        isLowIntake(meal({ status: 'eaten', main_amount: null, side_amount: null })),
        false,
      )
    })
    it('status=eaten で主2+副2 は低摂取', () => {
      assert.equal(isLowIntake(meal({ status: 'eaten', main_amount: 2, side_amount: 2 })), true)
    })
    for (const status of ['out', 'hospital', 'refused']) {
      it(`status=${status} は量が0でも低摂取でない（欠食は別扱い）`, () => {
        assert.equal(isLowIntake(meal({ status, main_amount: 0, side_amount: 0 })), false)
      })
    }
  })

  // ══════════════════════════════════════════════════════════════
  // normalizeVitalInput（現場の入力ゆれの吸収）
  // ══════════════════════════════════════════════════════════════

  describe('normalizeVitalInput（体温）', () => {
    it("'365' はドット無し3桁として 36.5 に展開する", () => {
      assert.equal(normalizeVitalInput('365', 'temp'), 36.5)
    })
    it("'３６.7'（全角数字混在）は 36.7", () => {
      assert.equal(normalizeVitalInput('３６.7', 'temp'), 36.7)
    })
    it("'３６．７'（全角数字＋全角ドット）は 36.7", () => {
      assert.equal(normalizeVitalInput('３６．７', 'temp'), 36.7)
    })
    it("'36、6'（読点の誤入力）は 36.6", () => {
      assert.equal(normalizeVitalInput('36、6', 'temp'), 36.6)
    })
    it("'36。6'（句点の誤入力）は 36.6", () => {
      assert.equal(normalizeVitalInput('36。6', 'temp'), 36.6)
    })
    it("'36，6'（全角カンマの誤入力）は 36.6", () => {
      assert.equal(normalizeVitalInput('36，6', 'temp'), 36.6)
    })
    it("'36.7.'（末尾ドット）は 36.7", () => {
      assert.equal(normalizeVitalInput('36.7.', 'temp'), 36.7)
    })
    it("'36.7..'（末尾ドット複数）は 36.7", () => {
      assert.equal(normalizeVitalInput('36.7..', 'temp'), 36.7)
    })
    it("'' は null（未入力）", () => {
      assert.equal(normalizeVitalInput('', 'temp'), null)
    })
    it("'   '（空白のみ）は null", () => {
      assert.equal(normalizeVitalInput('   ', 'temp'), null)
    })
    it("'.'（ドットのみ）は null", () => {
      assert.equal(normalizeVitalInput('.', 'temp'), null)
    })
    it("'abc'（数値化できない）は null", () => {
      assert.equal(normalizeVitalInput('abc', 'temp'), null)
    })
    it("'..36'（先頭ドット）は null", () => {
      assert.equal(normalizeVitalInput('..36', 'temp'), null)
    })
    it("'  36.7  '（前後空白）は 36.7", () => {
      assert.equal(normalizeVitalInput('  36.7  ', 'temp'), 36.7)
    })
    it("'36.5' はそのまま 36.5", () => {
      assert.equal(normalizeVitalInput('36.5', 'temp'), 36.5)
    })
    it('小数第2位は小数第1位に丸める（36.55 → 36.6）', () => {
      assert.equal(normalizeVitalInput('36.55', 'temp'), 36.6)
    })
    it('3桁展開は3桁のときだけ（2桁 99 はそのまま 99）', () => {
      assert.equal(normalizeVitalInput('99', 'temp'), 99)
    })
    it('3桁展開は3桁のときだけ（4桁 1000 はそのまま 1000）', () => {
      assert.equal(normalizeVitalInput('1000', 'temp'), 1000)
    })
    it("'−5'（全角マイナス）は -5（範囲判定は呼び出し側の責務）", () => {
      assert.equal(normalizeVitalInput('−5', 'temp'), -5)
    })
  })

  describe('normalizeVitalInput（体温以外）', () => {
    it("temp 以外は3桁展開しない（pulse の '365' は 365）", () => {
      assert.equal(normalizeVitalInput('365', 'pulse'), 365)
    })
    it("'１００'（全角）は spo2 で 100", () => {
      assert.equal(normalizeVitalInput('１００', 'spo2'), 100)
    })
    it('小数は整数に丸める（spo2 98.6 → 99）', () => {
      assert.equal(normalizeVitalInput('98.6', 'spo2'), 99)
    })
    it('小数は整数に丸める（spo2 98.4 → 98）', () => {
      assert.equal(normalizeVitalInput('98.4', 'spo2'), 98)
    })
    it("'' は null（sys_bp）", () => {
      assert.equal(normalizeVitalInput('', 'sys_bp'), null)
    })
    it("'12ー3'（長音の誤入力でマイナス2つ）は null", () => {
      assert.equal(normalizeVitalInput('12ー3', 'pulse'), null)
    })
    it("'Infinity' は null（無限大を値として通さない）", () => {
      assert.equal(normalizeVitalInput('Infinity', 'pulse'), null)
    })
    it('返り値は null か有限数のみ（NaN を返さない）', () => {
      const inputs = ['', ' ', '.', '..', 'abc', '１２３', '365', '-', '−', 'e', '+']
      for (const s of inputs) {
        for (const f of ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2']) {
          const r = normalizeVitalInput(s, f)
          assert.ok(r === null || Number.isFinite(r), `normalizeVitalInput(${JSON.stringify(s)}, '${f}') = ${r}`)
        }
      }
    })
  })

  describe('normalizeVitalInput（現行挙動の記録・仕様未定義）', () => {
    // 下記は「こう決めた」ではなく「今こう動く」の固定。変えるときは本人確認が要る。
    it("'1e2' は指数表記として 100 になる", () => {
      assert.equal(normalizeVitalInput('1e2', 'pulse'), 100)
    })
    it("'0x10' は16進として 16 になる", () => {
      assert.equal(normalizeVitalInput('0x10', 'pulse'), 16)
    })
  })

  describe('toHalfWidth', () => {
    it('全角数字を半角にする', () => {
      assert.equal(toHalfWidth('３６７'), '367')
    })
    it('全角ドット・読点・句点・全角カンマをドットにする', () => {
      assert.equal(toHalfWidth('１．２'), '1.2')
      assert.equal(toHalfWidth('１、２'), '1.2')
      assert.equal(toHalfWidth('１。２'), '1.2')
      assert.equal(toHalfWidth('１，２'), '1.2')
    })
    it('全角マイナス・長音をハイフンにする', () => {
      assert.equal(toHalfWidth('−1'), '-1')
      assert.equal(toHalfWidth('ー1'), '-1')
      assert.equal(toHalfWidth('－1'), '-1')
    })
    it('前後の空白を落とす', () => {
      assert.equal(toHalfWidth('  36.7  '), '36.7')
    })
    it('半角のまま渡したものは変えない', () => {
      assert.equal(toHalfWidth('36.7'), '36.7')
    })
  })

  // ══════════════════════════════════════════════════════════════
  // 日付ヘルパ（月跨ぎ・年跨ぎ・閏年・タイムゾーン）
  // ══════════════════════════════════════════════════════════════

  describe('isoDate', () => {
    it('通常日を YYYY-MM-DD にする', () => {
      assert.equal(isoDate(new Date(2026, 7, 27)), '2026-08-27')
    })
    it('月・日を2桁ゼロ埋めする', () => {
      assert.equal(isoDate(new Date(2026, 0, 5)), '2026-01-05')
    })
    it('ローカル00:00でもその日のまま（UTCへ寄せない）', () => {
      assert.equal(isoDate(new Date(2026, 7, 27, 0, 0, 0)), '2026-08-27')
    })
    it('ローカル23:59でもその日のまま（翌日に繰り上がらない）', () => {
      assert.equal(isoDate(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31')
    })
    it('閏日を扱える', () => {
      assert.equal(isoDate(new Date(2024, 1, 29)), '2024-02-29')
    })
  })

  describe('addDays', () => {
    const cases = [
      ['2026-08-27', 0, '2026-08-27', '0日'],
      ['2026-08-31', 1, '2026-09-01', '月跨ぎ（31日→翌月1日）'],
      ['2026-09-01', -1, '2026-08-31', '月跨ぎ（逆方向）'],
      ['2026-03-01', -1, '2026-02-28', '平年の2月末へ戻る'],
      ['2026-02-28', 1, '2026-03-01', '平年は2/28の翌日が3/1'],
      ['2024-02-28', 1, '2024-02-29', '閏年は2/28の翌日が2/29'],
      ['2024-02-29', 1, '2024-03-01', '閏日の翌日'],
      ['2024-03-01', -1, '2024-02-29', '閏日へ戻る'],
      ['2026-12-31', 1, '2027-01-01', '年跨ぎ（+）'],
      ['2026-01-01', -1, '2025-12-31', '年跨ぎ（-）'],
      ['2026-08-27', -9, '2026-08-18', 'タイムライン初期10日分の遡り'],
      ['2026-08-27', -29, '2026-07-29', 'カルテ30日分の遡り（月跨ぎ）'],
      ['2026-01-15', -30, '2025-12-16', '30日遡りで年跨ぎ'],
      ['2026-01-31', 1, '2026-02-01', '31日ある月から28日の月へ'],
      ['2026-05-31', 1, '2026-06-01', '31日ある月から30日の月へ'],
      ['2026-08-27', 365, '2027-08-27', '1年分の加算'],
    ]
    for (const [iso, n, expected, memo] of cases) {
      it(`${iso} ${n >= 0 ? '+' : ''}${n} → ${expected}（${memo}）`, () => {
        assert.equal(addDays(iso, n), expected)
      })
    }

    it('+1 と -1 は往復する（10日分）', () => {
      let cur = '2026-08-27'
      const forward = []
      for (let i = 0; i < 10; i++) {
        cur = addDays(cur, 1)
        forward.push(cur)
      }
      for (let i = 0; i < 10; i++) cur = addDays(cur, -1)
      assert.equal(cur, '2026-08-27')
      assert.equal(forward[0], '2026-08-28')
      assert.equal(forward[9], '2026-09-06')
    })
  })

  describe('fmtDayLabel', () => {
    const cases = [
      ['2026-08-27', '8/27（木）'],
      ['2026-08-31', '8/31（月）'],
      ['2026-09-01', '9/1（火）'],
      ['2026-01-01', '1/1（木）'],
      ['2026-01-05', '1/5（月）'],
      ['2026-12-31', '12/31（木）'],
      ['2027-01-01', '1/1（金）'],
      ['2024-02-29', '2/29（木）'],
      ['2026-02-28', '2/28（土）'],
      ['2026-03-01', '3/1（日）'],
    ]
    for (const [iso, expected] of cases) {
      it(`${iso} → ${expected}`, () => {
        assert.equal(fmtDayLabel(iso), expected)
      })
    }

    it('月日はゼロ埋めしない（1/5 であって 01/05 ではない）', () => {
      assert.ok(!fmtDayLabel('2026-01-05').startsWith('0'))
    })

    it('曜日は日〜土の7種のみを返す', () => {
      const seen = new Set()
      let cur = '2026-08-24'
      for (let i = 0; i < 7; i++) {
        const m = fmtDayLabel(cur).match(/（(.)）$/)
        assert.ok(m, `曜日を取り出せない: ${cur}`)
        seen.add(m[1])
        cur = addDays(cur, 1)
      }
      assert.deepEqual([...seen].sort(), ['土', '日', '月', '木', '水', '火', '金'].sort())
    })
  })

  describe('日付ヘルパのタイムゾーン非依存性（子プロセスで TZ を差し替えて実測）', () => {
    const observed = new Map()

    for (const tz of TZ_LIST) {
      it(`TZ=${tz} でも isoDate / addDays / fmtDayLabel の結果が変わらない`, () => {
        const o = observeInTz(tz)
        observed.set(tz, o)
        assert.deepEqual(o.isoDates, TZ_EXPECTED.isoDates, `TZ=${tz} で isoDate の結果がずれた`)
        assert.deepEqual(o.addDays, TZ_EXPECTED.addDays, `TZ=${tz} で addDays の結果がずれた`)
        assert.deepEqual(o.labels, TZ_EXPECTED.labels, `TZ=${tz} で fmtDayLabel の結果がずれた`)
      })
    }

    it('UTC+側では toISOString が前日にずれる（isoDate がそれを避けていることの確認）', () => {
      const o = observed.get('Asia/Tokyo') ?? observeInTz('Asia/Tokyo')
      assert.equal(o.utcSliceAtMidnight, '2026-08-26', 'JSTのローカル00:00はUTCでは前日のはず')
      assert.notEqual(
        o.isoDates[1],
        o.utcSliceAtMidnight,
        'isoDate が toISOString と同じ値になっている（UTCずれの罠を踏んでいる）',
      )
    })

    it('UTC-側では toISOString が翌日にずれる（isoDate がそれを避けていることの確認）', () => {
      const o = observed.get('Etc/GMT+12') ?? observeInTz('Etc/GMT+12')
      assert.equal(o.utcSliceAtEndOfDay, '2026-08-28', 'UTC-12のローカル23:59はUTCでは翌日のはず')
      assert.notEqual(
        o.isoDates[2],
        o.utcSliceAtEndOfDay,
        'isoDate が toISOString と同じ値になっている（UTCずれの罠を踏んでいる）',
      )
    })
  })
}
