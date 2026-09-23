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

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

/** cl_sendQueue の中身を差し替える（null なら cl_sendQueue と cl_sendQueue2 の両方のキーを消す） */
function setQueueRaw(raw) {
  if (raw === null) {
    lsStore.delete('cl_sendQueue')
    lsStore.delete('cl_sendQueue2')
  } else lsStore.set('cl_sendQueue', raw)
}

/** cl_sendQueue2（バイタル・食事の送信待ち）の中身を差し替える */
function setQueue2Raw(raw) {
  if (raw === null) lsStore.delete('cl_sendQueue2')
  else lsStore.set('cl_sendQueue2', raw)
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

/**
 * 偽の Supabase クライアント（通信しない）。db.ts が使う連鎖（from → insert/update/select →
 * eq/is/limit/order → maybeSingle と、rpc）だけを受け、発行された要求を calls に記録する。
 * 応答は handler(要求) が返す { data, error, status }。
 * 行は数値IDと数値だけ（個人情報なし）。
 */
function fakeSupabase(handler) {
  const calls = []
  const builder = (q) => {
    const run = () => {
      calls.push(q)
      return Promise.resolve(handler(q))
    }
    const b = {
      select(cols) {
        // 最初の select（読取の列）だけ控える。insert/update 後の select（返す列）は控えない
        if (q.action === 'select' && q.cols === undefined) q.cols = cols
        return b
      },
      insert(p) {
        q.action = 'insert'
        q.payload = p
        return b
      },
      update(p) {
        q.action = 'update'
        q.payload = p
        return b
      },
      eq(k, v) {
        q.filters.push(['eq', k, v])
        return b
      },
      is(k, v) {
        q.filters.push(['is', k, v])
        return b
      },
      in(k, v) {
        q.filters.push(['in', k, v])
        return b
      },
      gte(k, v) {
        q.filters.push(['gte', k, v])
        return b
      },
      lte(k, v) {
        q.filters.push(['lte', k, v])
        return b
      },
      limit(n) {
        q.limit = n
        return b
      },
      order() {
        return b
      },
      maybeSingle: run,
      then: (ok, ng) => run().then(ok, ng),
    }
    return b
  }
  const from = (table) => builder({ table, action: 'select', payload: undefined, filters: [] })
  // RPC（apply_cell_edits・timeline_chunk 等）。要求は { action: 'rpc', fn, args } で handler に渡る
  const rpc = (fn, args) => builder({ table: null, action: 'rpc', fn, args, payload: undefined, filters: [] })
  return { client: { from, rpc, auth: { onAuthStateChange() {} } }, calls }
}

/** 要求の eq 条件を { 列: 値 } で取り出す */
function eqOf(q) {
  const out = {}
  for (const [op, k, v] of q.filters) if (op === 'eq') out[k] = v
  return out
}

/**
 * 1表1行だけを持つ偽のサーバー。insert は常に 23505（他端末が先に同じ自然キーの行を作った状態）、
 * select は既存行を返し、update は rev が合う時だけ適用して rev を進める（0001 の rev トリガと同じ）。
 * opts.missingEditedBy=true は「0010 未適用＝edited_by 列が無い」サーバー（PGRST204 を返す）。
 */
function oneRowServer(row, opts = {}) {
  const state = { row: { ...row } }
  const fake = fakeSupabase((q) => {
    if (q.action === 'insert') {
      return { data: null, error: { code: '23505', message: 'duplicate key' }, status: 409 }
    }
    if (q.action === 'select') return { data: { ...state.row }, error: null, status: 200 }
    if (q.action === 'update') {
      if (opts.missingEditedBy && 'edited_by' in q.payload) {
        return {
          data: null,
          error: { code: 'PGRST204', message: "Could not find the 'edited_by' column in the schema cache" },
          status: 400,
        }
      }
      const eq = eqOf(q)
      if (eq.id !== state.row.id || eq.rev !== state.row.rev) return { data: null, error: null, status: 200 }
      state.row = { ...state.row, ...q.payload, rev: state.row.rev + 1 }
      return { data: { ...state.row }, error: null, status: 200 }
    }
    return { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
  })
  return { ...fake, state }
}

/** 端末Aが先に作った定時バイタルの行（端末B から見た「既存行」） */
function serverVital(over = {}) {
  return {
    id: 10,
    resident_id: 1,
    measured_on: '2026-09-01',
    kind: 'routine',
    measured_at: '09:00',
    temp: null,
    sys_bp: null,
    dia_bp: null,
    pulse: null,
    spo2: null,
    note: null,
    symptom: null,
    recorded_by: 1,
    rev: 1,
    ...over,
  }
}

/** 端末Bが送る定時バイタルの insert（未入力は null） */
function vitalInput(over = {}) {
  return {
    resident_id: 1,
    measured_on: '2026-09-01',
    kind: 'routine',
    measured_at: '09:03',
    temp: null,
    sys_bp: null,
    dia_bp: null,
    pulse: null,
    spo2: null,
    note: null,
    symptom: null,
    recorded_by: 2,
    ...over,
  }
}

/** 端末Aが先に作った食事の行 */
function serverMeal(over = {}) {
  return {
    id: 20,
    resident_id: 1,
    meal_on: '2026-09-01',
    meal_slot: 'lunch',
    main_amount: null,
    side_amount: null,
    status: null,
    note: null,
    recorded_by: 1,
    rev: 1,
    ...over,
  }
}

/** 端末Bが送る食事の insert（未入力は null） */
function mealInput(over = {}) {
  return {
    resident_id: 1,
    meal_on: '2026-09-01',
    meal_slot: 'lunch',
    main_amount: null,
    side_amount: null,
    status: null,
    note: null,
    recorded_by: 2,
    ...over,
  }
}

// 食い違いの判定・変更の記録の表示（src/lib/conflict.ts・historyView.ts。拡張子付き import なので
// 解決フック無しで読める）
let CF = null
let HV = null
let LG = null
let RS = null
// 0011 apply_cell_edits の JS の写しと契約の表（素の Postgres でも同じ表を流して一致を実測する）
let CC = null
if (process.env[PROBE_ENV] !== '1') {
  try {
    CF = await import('../src/lib/conflict.ts')
    HV = await import('../src/lib/historyView.ts')
    LG = await import('../src/lib/leaveGuard.ts')
    RS = await import('../src/lib/rowSync.ts')
    CC = await import('./cell-contract.mjs')
  } catch {
    CF = null
    HV = null
    LG = null
    RS = null
    CC = null
  }
}

// ── 子プロセスモード: テストを登録せず観測値だけを出力する ──

if (process.env[PROBE_ENV] === '1') {
  process.stdout.write(JSON.stringify(tzObservations()))
} else if (TS_READY) {
  registerTests()
  if (CF) registerConflictTests()
  else it('食い違いの判定の検証', { skip: TS_UNSUPPORTED }, () => {})
  if (RS) registerRowSyncTests()
  else it('行の入力と保存の共通の仕組みの検証', { skip: TS_UNSUPPORTED }, () => {})
  if (CC) registerCellContractTests()
  else it('欄ごとの compare-and-set の契約の検証', { skip: TS_UNSUPPORTED }, () => {})
  if (DB && CC && RS) registerDbTests()
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
      assert.deepEqual(gate, { value: false, observed: false, cells: 'unknown' })
    })

    it('getNativeInputEnabled は gate.value と同じ値を返す（互換）', async () => {
      const gate = await DB.getNativeInputGate()
      assert.equal(await DB.getNativeInputEnabled(), gate.value)
    })
  })

  // ══════════════════════════════════════════════════════════════
  // 同時入力で「どちらの記録も残る」（2026-09-23 凍結仕様 フェーズ1 A）
  //
  // 定時バイタル・食事は自然キー（部分unique索引）を持つので、2台がほぼ同時に新規保存すると
  // 後の端末の insert は 23505 になる。この時に後の端末が**先の端末の値を無言で上書きしない**こと
  // （空いている列だけ埋める／既に値がある列で食い違えば書かずに 'conflict'）を守る。
  // 判定の核（fillGapsOnly）は送信キューの再送経路と同じ関数を使う。
  // ══════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════
  // 変更の記録（2026-09-23 凍結仕様 フェーズ1 B）
  //
  // - 更新系は操作者が分かる時だけ edited_by を送る（分からない時は null で上書きしない）
  // - 0010 未適用の DB（列が無い）では edited_by を外して1回だけ送り直し、以後付けない
  //   ＝ migration の適用順に関係なく保存を失敗させない
  // ══════════════════════════════════════════════════════════════

  describe('edited_by（最後にこの行を書き換えた職員・水分・申し送り・外出の旧経路）', () => {
    afterEach(async () => {
      DB.__testHooks.setClient(null)
      setQueueRaw(null)
      await DB.__testHooks.restartQueue()
    })

    /** 他の端末が先に書いた申し送りの行（本文は記号だけ） */
    const noteRow = (over = {}) => ({ id: 30, note_on: '2026-09-01', shift: 'day', body: '本文', resident_id: null, deleted_at: null, rev: 1, ...over })

    it('操作者が分かる時は更新に edited_by を添える', async () => {
      const srv = oneRowServer(noteRow())
      DB.__testHooks.setClient(srv.client)
      DB.setEditor(3)
      const res = await DB.updateNote(30, 1, { body: '本文B' })
      assert.equal(res.body, '本文B')
      const updates = srv.calls.filter((q) => q.action === 'update')
      assert.deepEqual(updates[0].payload, { body: '本文B', edited_by: 3 })
    })

    it('★操作者が分からない更新でも edited_by:null を送る（前の人を「変えた職員」に残さない・再審 指摘4）', async () => {
      const srv = oneRowServer(noteRow({ edited_by: 3 }))
      DB.__testHooks.setClient(srv.client)
      DB.setEditor(null)
      await DB.updateNote(30, 1, { body: '本文B' })
      const updates = srv.calls.filter((q) => q.action === 'update')
      assert.equal('edited_by' in updates[0].payload, true)
      assert.equal(updates[0].payload.edited_by, null)
      assert.equal(srv.state.row.edited_by, null, '前に触った職員（3）が残っている')
    })

    it('不正な操作者ID（0・負数・小数）は「分からない」として null を送る', async () => {
      for (const bad of [0, -1, 1.5]) {
        const srv = oneRowServer(noteRow())
        DB.__testHooks.setClient(srv.client)
        DB.setEditor(bad)
        await DB.updateNote(30, 1, { body: '本文B' })
        const updates = srv.calls.filter((q) => q.action === 'update')
        assert.equal(updates[0].payload.edited_by, null, `setEditor(${bad})`)
      }
    })

    it('操作者が分からない soft delete でも edited_by:null を送る', async () => {
      const del = oneRowServer({ id: 30, resident_id: 1, taken_on: '2026-09-01', amount_ml: 100, rev: 1, edited_by: 3 })
      DB.__testHooks.setClient(del.client)
      await DB.softDeleteFluid(30, 1)
      assert.equal(del.calls.find((q) => q.action === 'update').payload.edited_by, null)
    })

    it('列が無い DB と分かった後は、null も含めて edited_by を付けない（後方互換は従来どおり）', async () => {
      const srv = oneRowServer(noteRow(), { missingEditedBy: true })
      DB.__testHooks.setClient(srv.client)
      DB.setEditor(null)
      const res = await DB.updateNote(30, 1, { body: '本文B' })
      assert.equal(res.body, '本文B')
      const updates = srv.calls.filter((q) => q.action === 'update')
      assert.equal(updates.length, 2)
      assert.equal(updates[0].payload.edited_by, null)
      assert.deepEqual(updates[1].payload, { body: '本文B' })
    })

    it('削除（soft delete）にも edited_by を添える', async () => {
      const srv = oneRowServer({ id: 30, resident_id: 1, taken_on: '2026-09-01', amount_ml: 100, rev: 1 })
      DB.__testHooks.setClient(srv.client)
      DB.setEditor(3)
      const res = await DB.softDeleteFluid(30, 1)
      assert.equal(res, true)
      const updates = srv.calls.filter((q) => q.action === 'update')
      assert.equal(updates[0].payload.edited_by, 3)
      assert.equal(typeof updates[0].payload.deleted_at, 'string')
    })

    it('★列が無い DB（PGRST204）では edited_by を外して1回だけ送り直し、保存を成功させる', async () => {
      const srv = oneRowServer(noteRow(), { missingEditedBy: true })
      DB.__testHooks.setClient(srv.client)
      DB.setEditor(3)
      const res = await DB.updateNote(30, 1, { body: '本文B' })
      assert.equal(res.body, '本文B')
      const updates = srv.calls.filter((q) => q.action === 'update')
      assert.equal(updates.length, 2)
      assert.equal(updates[0].payload.edited_by, 3)
      assert.deepEqual(updates[1].payload, { body: '本文B' })
    })

    it('★列が無いと分かった後は、同じ起動中は edited_by を付けない（毎回失敗→再送にしない）', async () => {
      const srv = oneRowServer(noteRow(), { missingEditedBy: true })
      DB.__testHooks.setClient(srv.client)
      DB.setEditor(3)
      await DB.updateNote(30, 1, { body: '本文B' })
      const before = srv.calls.filter((q) => q.action === 'update').length
      const res = await DB.updateNote(30, 2, { importance: 'important' })
      assert.equal(res.importance, 'important')
      const after = srv.calls.filter((q) => q.action === 'update').slice(before)
      assert.equal(after.length, 1)
      assert.deepEqual(after[0].payload, { importance: 'important' })
    })

    it('Postgres の undefined_column（42703）でも同じく送り直す', async () => {
      const fake = fakeSupabase((q) => {
        if (q.action === 'update' && 'edited_by' in q.payload) {
          return { data: null, error: { code: '42703', message: 'column "edited_by" does not exist' }, status: 400 }
        }
        if (q.action === 'update') return { data: noteRow({ body: '本文B', rev: 2 }), error: null, status: 200 }
        return { data: null, error: null, status: 200 }
      })
      DB.__testHooks.setClient(fake.client)
      DB.setEditor(3)
      const res = await DB.updateNote(30, 1, { body: '本文B' })
      assert.equal(res.body, '本文B')
      assert.equal(fake.calls.filter((q) => q.action === 'update').length, 2)
    })

    it('列が無い以外のエラーでは送り直さない（従来どおりの失敗）', async () => {
      const fake = fakeSupabase((q) => {
        if (q.action === 'update') return { data: null, error: { code: '23514', message: 'check' }, status: 400 }
        return { data: null, error: null, status: 200 }
      })
      DB.__testHooks.setClient(fake.client)
      DB.setEditor(3)
      await assert.rejects(() => DB.updateNote(30, 1, { body: '本文B' }))
      assert.equal(fake.calls.filter((q) => q.action === 'update').length, 1)
    })

    it('退避した更新は退避時の操作者を持ち、列が無い DB へは外して送る（送信キュー経路）', async () => {
      setQueueRaw(null)
      let online = false
      const state = { row: noteRow() }
      const fake = fakeSupabase((q) => {
        if (!online) return { data: null, error: { message: 'offline' }, status: 0 }
        if (q.action === 'update' && 'edited_by' in q.payload) {
          return { data: null, error: { code: 'PGRST204', message: "Could not find the 'edited_by' column" }, status: 400 }
        }
        if (q.action === 'update') {
          state.row = { ...state.row, ...q.payload, rev: state.row.rev + 1 }
          return { data: { ...state.row }, error: null, status: 200 }
        }
        return { data: null, error: null, status: 200 }
      })
      DB.__testHooks.setClient(fake.client)
      DB.setEditor(3)
      const res = await DB.updateNote(30, 1, { body: '本文B' })
      assert.equal(res, 'queued')
      const saved = storedQueue()
      assert.equal(saved.ops.length, 1)
      assert.equal(saved.ops[0].payload.edited_by, 3, '退避に操作者が残っていない')

      online = true
      DB.setEditor(4) // 送る時点で操作者が替わっていても、退避時の操作者のまま送る
      const sentBefore = fake.calls.length
      await DB.flushQueue(true)
      const resent = fake.calls.slice(sentBefore).filter((q) => q.action === 'update')
      assert.equal(resent.length, 2)
      assert.equal(resent[0].payload.edited_by, 3)
      assert.deepEqual(resent[1].payload, { body: '本文B' })
      assert.equal(state.row.body, '本文B')
      assert.equal(DB.queuePending(), 0, '送れたのにキューに残っている')
    })
  })

  describe('diffHistoryRow（変更の記録の差分）', () => {
    it('変わった列だけを {column, before, after} で返す', () => {
      const d = DB.diffHistoryRow(
        { id: 10, temp: 36.5, sys_bp: 120, pulse: 70 },
        { id: 10, temp: 36.5, sys_bp: 130, pulse: 72 },
      )
      assert.deepEqual(d, [
        { column: 'sys_bp', before: 120, after: 130 },
        { column: 'pulse', before: 70, after: 72 },
      ])
    })

    it('rev・updated_at・edited_by・raw_flags は差分に出さない', () => {
      const d = DB.diffHistoryRow(
        { id: 10, rev: 1, updated_at: '2026-09-01T00:00:00Z', edited_by: 1, raw_flags: { a: 1 }, temp: 36.5 },
        { id: 10, rev: 2, updated_at: '2026-09-01T01:00:00Z', edited_by: 2, raw_flags: { a: 2 }, temp: 36.5 },
      )
      assert.deepEqual(d, [])
    })

    it('空になった・空から入った列も出す（null と値の違い）', () => {
      const d = DB.diffHistoryRow({ temp: 36.5, spo2: null }, { temp: null, spo2: 97 })
      assert.deepEqual(d, [
        { column: 'temp', before: 36.5, after: null },
        { column: 'spo2', before: null, after: 97 },
      ])
    })

    it('削除（deleted_at が入った）も差分として出す', () => {
      const d = DB.diffHistoryRow({ deleted_at: null }, { deleted_at: '2026-09-01T02:00:00Z' })
      assert.deepEqual(d, [{ column: 'deleted_at', before: null, after: '2026-09-01T02:00:00Z' }])
    })

    it('配列は中身で比べる（同じ中身なら変化なし）', () => {
      assert.deepEqual(DB.diffHistoryRow({ role_tags: ['a', 'b'] }, { role_tags: ['a', 'b'] }), [])
      assert.deepEqual(DB.diffHistoryRow({ role_tags: ['a'] }, { role_tags: ['a', 'b'] }), [
        { column: 'role_tags', before: ['a'], after: ['a', 'b'] },
      ])
    })

    it('片方にしか無い列は null として比べる（両方とも空なら変化なし）', () => {
      assert.deepEqual(DB.diffHistoryRow({ a: 1 }, { a: 1, edited_by: 2, b: null }), [])
      assert.deepEqual(DB.diffHistoryRow({ a: 1 }, { a: 1, b: 5 }), [{ column: 'b', before: null, after: 5 }])
    })

    it('壊れた入力でも例外にせず空配列（画面を落とさない）', () => {
      assert.deepEqual(DB.diffHistoryRow(null, undefined), [])
      assert.deepEqual(DB.diffHistoryRow('こわれた値', [1, 2]), [])
    })
  })

  describe('fetchRecordHistory（変更の記録の取得）', () => {
    afterEach(() => {
      DB.__testHooks.setClient(null)
    })

    it('表が無い（42P01 / PGRST205）時は { available: false }', async () => {
      for (const code of ['42P01', 'PGRST205']) {
        const fake = fakeSupabase(() => ({ data: null, error: { code, message: 'missing' }, status: 404 }))
        DB.__testHooks.setClient(fake.client)
        const res = await DB.fetchRecordHistory({ residentId: 1, fromIso: '2026-09-01', toIso: '2026-09-07' })
        assert.deepEqual(res, { available: false }, `${code} で available:false にならない`)
      }
    })

    it('日付レンジ・利用者・件数上限を付けて引き、壊れた行は落とす', async () => {
      const good = {
        id: 1,
        table_name: 'vitals',
        row_id: 10,
        resident_id: 1,
        record_day: '2026-09-01',
        op: 'update',
        rev_before: 1,
        rev_after: 2,
        old_row: { sys_bp: 120 },
        new_row: { sys_bp: 130 },
        changed_at: '2026-09-01T01:00:00Z',
        changed_by_staff: 3,
      }
      const fake = fakeSupabase(() => ({ data: [good, { id: 'x' }], error: null, status: 200 }))
      DB.__testHooks.setClient(fake.client)
      const res = await DB.fetchRecordHistory({ residentId: 1, fromIso: '2026-09-01', toIso: '2026-09-07', limit: 50 })
      assert.equal(res.available, true)
      assert.equal(res.entries.length, 1)
      assert.equal(res.entries[0].changed_by_staff, 3)
      const q = fake.calls[0]
      assert.equal(q.table, 'record_history')
      assert.equal(q.limit, 50)
      assert.deepEqual(
        q.filters.filter(([op]) => op !== 'is'),
        [
          ['gte', 'record_day', '2026-09-01'],
          ['lte', 'record_day', '2026-09-07'],
          ['eq', 'resident_id', 1],
        ],
      )
    })

    it('residentId=null は全体連絡（resident_id is null）で絞る', async () => {
      const fake = fakeSupabase(() => ({ data: [], error: null, status: 200 }))
      DB.__testHooks.setClient(fake.client)
      await DB.fetchRecordHistory({ residentId: null, fromIso: '2026-09-01', toIso: '2026-09-07' })
      assert.deepEqual(
        fake.calls[0].filters.find(([op]) => op === 'is'),
        ['is', 'resident_id', null],
      )
    })

    it('件数上限は 2000 を超えない（全件ロードしない）', async () => {
      const fake = fakeSupabase(() => ({ data: [], error: null, status: 200 }))
      DB.__testHooks.setClient(fake.client)
      await DB.fetchRecordHistory({ fromIso: '2026-09-01', toIso: '2026-09-07', limit: 999_999 })
      assert.equal(fake.calls[0].limit, 2000)
    })

    it('日付の形が不正なら問い合わせずに例外', async () => {
      const fake = fakeSupabase(() => ({ data: [], error: null, status: 200 }))
      DB.__testHooks.setClient(fake.client)
      await assert.rejects(() => DB.fetchRecordHistory({ fromIso: '2026/09/01', toIso: '2026-09-07' }))
      assert.equal(fake.calls.length, 0)
    })

    it('表が無い以外のエラーは例外（黙って空にしない）', async () => {
      const fake = fakeSupabase(() => ({ data: null, error: { code: 'XX000', message: 'x' }, status: 500 }))
      DB.__testHooks.setClient(fake.client)
      await assert.rejects(() => DB.fetchRecordHistory({ fromIso: '2026-09-01', toIso: '2026-09-07' }))
    })
  })

  // ══════════════════════════════════════════════════════════════
  // 2026-09-23 レビュー指摘の修正（フェーズ2と同時）
  // ══════════════════════════════════════════════════════════════

  describe('edited_by の上書き（記録ごとに選んだ記入者）', () => {
    afterEach(() => {
      DB.__testHooks.setClient(null)
    })

    it('editedBy を渡すと、端末の既定の操作者ではなくその職員を送る', async () => {
      const srv = oneRowServer({ id: 30, note_on: '2026-09-01', shift: 'day', body: '本文', deleted_at: null, rev: 1 })
      DB.__testHooks.setClient(srv.client)
      DB.setEditor(3)
      await DB.updateNote(30, 1, { body: '本文B' }, { editedBy: 7 })
      assert.equal(srv.calls.find((q) => q.action === 'update').payload.edited_by, 7)
    })

    it('editedBy が null・不正値なら端末の既定の操作者に戻る', async () => {
      for (const bad of [null, 0, -1]) {
        const srv = oneRowServer({ id: 30, note_on: '2026-09-01', shift: 'day', body: '本文', deleted_at: null, rev: 1 })
        DB.__testHooks.setClient(srv.client)
        DB.setEditor(3)
        await DB.updateNote(30, 1, { body: '本文B' }, { editedBy: bad })
        assert.equal(srv.calls.find((q) => q.action === 'update').payload.edited_by, 3, `editedBy=${bad}`)
      }
    })

    it('既存の呼び出し（第4引数なし）はそのまま動く', async () => {
      const srv = oneRowServer({ id: 30, note_on: '2026-09-01', shift: 'day', body: '本文', deleted_at: null, rev: 1 })
      DB.__testHooks.setClient(srv.client)
      DB.setEditor(3)
      const res = await DB.updateNote(30, 1, { body: '本文B' })
      assert.equal(res.body, '本文B')
      assert.equal(srv.calls.find((q) => q.action === 'update').payload.edited_by, 3)
    })

    it('申し送りの取り消し（softDeleteNote）にも記入者を渡せる', async () => {
      const srv = oneRowServer({ id: 40, note_on: '2026-09-01', shift: 'day', body: 'x', rev: 1 })
      DB.__testHooks.setClient(srv.client)
      DB.setEditor(3)
      const res = await DB.softDeleteNote(40, 1, { editedBy: 9 })
      assert.equal(res, true)
      assert.equal(srv.calls.find((q) => q.action === 'update').payload.edited_by, 9)
    })
  })

  describe('fetchLatestVital / fetchLatestMeal（くらべて選ぶ画面の取り直し）', () => {
    afterEach(() => {
      DB.__testHooks.setClient(null)
    })

    it('定時は（利用者, 日付, routine）で1行だけ引き、記入者と更新時刻を返す', async () => {
      const fake = fakeSupabase(() => ({
        data: { ...serverVital({ sys_bp: 120 }), edited_by: 4, updated_at: '2026-09-01T01:05:00Z' },
        error: null,
        status: 200,
      }))
      DB.__testHooks.setClient(fake.client)
      const got = await DB.fetchLatestVital({ routine: true, residentId: 1, day: '2026-09-01' })
      assert.equal(got.row.sys_bp, 120)
      assert.equal(got.editedBy, 4)
      assert.equal(got.updatedAt, '2026-09-01T01:05:00Z')
      const q = fake.calls[0]
      assert.deepEqual(eqOf(q), { resident_id: 1, measured_on: '2026-09-01', kind: 'routine' })
      assert.equal(q.limit, 1)
      assert.ok(q.filters.some(([op, k, v]) => op === 'is' && k === 'deleted_at' && v === null))
    })

    it('定時以外は行の id で引く', async () => {
      const fake = fakeSupabase(() => ({ data: serverVital({ id: 55, kind: 'observation' }), error: null, status: 200 }))
      DB.__testHooks.setClient(fake.client)
      await DB.fetchLatestVital({ routine: false, id: 55 })
      assert.deepEqual(eqOf(fake.calls[0]), { id: 55 })
    })

    it('★edited_by 列が無い DB（0010 未適用）では列を外して取り直す（取得は失敗させない）', async () => {
      const fake = fakeSupabase((q) =>
        String(q.cols).includes('edited_by')
          ? { data: null, error: { code: '42703', message: 'column edited_by does not exist' }, status: 400 }
          : { data: { ...serverMeal({ main_amount: 8 }), updated_at: '2026-09-01T02:00:00Z' }, error: null, status: 200 },
      )
      DB.__testHooks.setClient(fake.client)
      const got = await DB.fetchLatestMeal(1, '2026-09-01', 'lunch')
      assert.equal(got.row.main_amount, 8)
      assert.equal(got.editedBy, null)
      assert.equal(fake.calls.length, 2)
      assert.deepEqual(eqOf(fake.calls[1]), { resident_id: 1, meal_on: '2026-09-01', meal_slot: 'lunch' })
    })

    it('行が無ければ null（先の記録が見つからない）', async () => {
      const fake = fakeSupabase(() => ({ data: null, error: null, status: 200 }))
      DB.__testHooks.setClient(fake.client)
      assert.equal(await DB.fetchLatestMeal(1, '2026-09-01', 'lunch'), null)
    })

    it('読めなければ例外（画面は理由と〔もう一度〕を出す）', async () => {
      const fake = fakeSupabase(() => ({ data: null, error: { message: 'offline' }, status: 0 }))
      DB.__testHooks.setClient(fake.client)
      await assert.rejects(() => DB.fetchLatestVital({ routine: true, residentId: 1, day: '2026-09-01' }))
    })
  })

  // ── 送信キュー（第1段: バイタル・食事は送信待ち → RPC apply_cell_edits／それ以外は HEAD の退避 op）──
  //
  // どのテストも最後にキューを空にする（localStorage を消してから「次の起動」を再現して読み直す）。
  // メモリ上のキューはテストをまたいで残るため、片付けを忘れると次のテストの判定を狂わせる

  /** キューと送信待ちを空にし、偽のクライアント・タイマー・端末のオンライン表示を元に戻す */
  async function drainRows() {
    await new Promise((r) => setTimeout(r, 10)) // 自分で始めた送信が終わるのを待つ
    setQueueRaw(null)
    await DB.__testHooks.restartQueue()
    DB.__testHooks.setClient(null)
    DB.__testHooks.setTimer(null)
    setOnline(null)
  }

  /** navigator.onLine を差し替える（null で元に戻す＝Node の既定は onLine を持たない） */
  function setOnline(v) {
    if (v === null) delete globalThis.navigator.onLine
    else Object.defineProperty(globalThis.navigator, 'onLine', { value: v, configurable: true, writable: true })
  }

  /**
   * 保存されている送信キュー。ops＝退避 op（cl_sendQueue の ops）、rows＝バイタル・食事の送信待ち（cl_sendQueue2 の rows）、
   * done＝送信済み・取り下げた版の記録（cl_sendQueue2 の done）
   */
  function storedQueue() {
    const box1 = lsStore.has('cl_sendQueue') ? JSON.parse(lsStore.get('cl_sendQueue')) : {}
    const box2 = lsStore.has('cl_sendQueue2') ? JSON.parse(lsStore.get('cl_sendQueue2')) : null
    const ops = box1.ops ?? box1.legacyOps ?? []
    const rows = box2 !== null ? (box2.rows ?? {}) : box1.ver === 2 ? (box1.rows ?? {}) : {}
    return { ...box1, ops, rows, done: box2?.done ?? [] }
  }

  /**
   * HEAD（c592dad）の送信キューの読み書きを写したもの（旧ビルドへ戻した端末の再現）。
   * HEAD は cl_sendQueue の box.ops（または配列）だけを読み、{ ops, brokenRaw } で書き戻す。
   * 受けるのは vitals・meals・水分・申し送り・外出の insert/update と、既読・出勤者・表示名の op。
   * 受けない行は brokenRaw へ畳む。cl_sendQueue 以外のキーには触れない。extraOps＝旧ビルドで新しく積んだ op
   */
  function headRoundTrip(extraOps = []) {
    const accepts = (r) => {
      if (r === null || typeof r !== 'object' || r.payload === null || typeof r.payload !== 'object') return false
      if (r.kind === 'insert' || r.kind === 'update') {
        if (!['vitals', 'meals', 'fluid_intake', 'notes', 'outings'].includes(r.table)) return false
        return r.kind === 'insert' || (typeof r.rowId === 'number' && typeof r.rev === 'number')
      }
      return (
        (r.kind === 'read' && r.table === 'note_reads') ||
        (r.kind === 'attendance' && r.table === 'attendance') ||
        (r.kind === 'alias' && r.table === 'residents')
      )
    }
    const raw = lsStore.get('cl_sendQueue')
    let ops = []
    let brokenRaw = null
    const keep = (x) => {
      brokenRaw = brokenRaw === null ? x : `${brokenRaw}\n${x}`
    }
    if (raw !== undefined && raw !== '') {
      try {
        const parsed = JSON.parse(raw)
        const box = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
        const rawOps = box === null ? parsed : box.ops
        if (Array.isArray(rawOps)) for (const r of rawOps) (accepts(r) ? ops.push(r) : keep(JSON.stringify(r)))
        if (box !== null && typeof box.brokenRaw === 'string') keep(box.brokenRaw)
      } catch {
        keep(raw)
      }
    }
    ops = ops.concat(extraOps)
    const out = { ops }
    if (brokenRaw !== null) out.brokenRaw = brokenRaw
    lsStore.set('cl_sendQueue', JSON.stringify(out))
  }

  const offline = () => fakeSupabase(() => ({ data: null, error: { message: 'offline' }, status: 0 }))
  /** db.ts が自分で始めた送信が終わるのを待つ */
  const settle = () => new Promise((r) => setTimeout(r, 10))

  /**
   * 0011 を JS で写した偽のサーバー（tests/cell-contract.mjs の fakeApplyCellEdits）。
   * rpc('apply_cell_edits') に答え、from('meals'/'vitals') の1行読み（行 id → 自然キー）にも答える。
   * opts.offline() が true の間は通信できない（status 0）。opts.missingRpc は関数の無い DB（PGRST202）。
   * opts.hold(q) が Promise を返すと、その rpc の応答をその Promise が解けるまで待たせる（送信中の再現）
   */
  function cellServer(opts = {}) {
    const db = CC.createCellDb()
    const fake = fakeSupabase(async (q) => {
      if (opts.offline?.()) return { data: null, error: { message: 'offline' }, status: 0 }
      if (q.action === 'rpc' && q.fn === 'apply_cell_edits') {
        if (opts.missingRpc?.()) {
          return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 }
        }
        if (opts.hold) await opts.hold(q)
        // opts.reject(q) が true の送信は、サーバーが拒否する（型・範囲の拒否と同じ 400）
        if (opts.reject?.(q)) return { data: null, error: { code: '22023', message: 'rejected' }, status: 400 }
        try {
          return { data: CC.fakeApplyCellEdits(db, q.args), error: null, status: 200 }
        } catch (e) {
          if (!(e instanceof CC.PgError)) throw e
          return { data: null, error: { code: e.code, message: e.message }, status: e.code === '40001' ? 500 : 400 }
        }
      }
      if (q.action === 'select' && (q.table === 'meals' || q.table === 'vitals')) {
        const eq = eqOf(q)
        const r = db[q.table].find((x) => x.deleted_at === null && Object.entries(eq).every(([k, v]) => x[k] === v))
        return { data: r ? { ...r } : null, error: null, status: 200 }
      }
      return { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
    })
    const sends = () => fake.calls.filter((q) => q.action === 'rpc' && q.args?.p_table !== 'probe')
    return { ...fake, db, sends }
  }

  /** 偽のサーバーへ先に行を置く（他の端末が先に書いた状態）。置いた行を返す */
  function seedVital(db, over = {}) {
    const row = {
      id: db.nextId++,
      resident_id: 1,
      measured_on: '2026-09-01',
      kind: 'routine',
      client_key: null,
      measured_at: null,
      temp: null,
      sys_bp: null,
      dia_bp: null,
      pulse: null,
      spo2: null,
      note: null,
      symptom: null,
      recorded_by: null,
      edited_by: null,
      rev: 1,
      deleted_at: null,
      ...over,
    }
    db.vitals.push(row)
    return row
  }

  function seedMeal(db, over = {}) {
    const row = {
      id: db.nextId++,
      resident_id: 1,
      meal_on: '2026-09-01',
      meal_slot: 'lunch',
      main_amount: null,
      side_amount: null,
      status: null,
      note: null,
      recorded_by: null,
      edited_by: null,
      rev: 1,
      deleted_at: null,
      ...over,
    }
    db.meals.push(row)
    return row
  }

  const ROUTINE = { routine: true, residentId: 1, day: '2026-09-01' }
  const LUNCH = { residentId: 1, day: '2026-09-01', slot: 'lunch' }

  describe('★I1 範囲の限定: 申し送り・外出・水分は Q1〜Q3 の外（HEAD と同じ送り方・再送・競合）', () => {
    afterEach(async () => {
      await drainRows()
    })

    it('★H2: 申し送りに止まった op があっても、後の更新は直接送られて届く（止まった op に吸い込まない）', async () => {
      DB.__testHooks.setClient(offline().client)
      assert.equal(await DB.updateNote(30, 1, { body: '本文A' }), 'queued')
      // 他の端末が先に書いた（rev 2）→ 申し送りは欄ごとの判定をしない（HEAD と同じ）ので止まる
      const srv = oneRowServer({ id: 30, note_on: '2026-09-01', shift: 'day', body: '本文X', deleted_at: null, rev: 2 })
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(storedQueue().ops.filter((o) => o.blocked === 'conflict').length, 1, '（前提）止まった op')
      const res = await DB.updateNote(30, 2, { body: '本文B' })
      assert.equal(typeof res, 'object', `直接送られていない: ${String(res)}`)
      assert.equal(srv.state.row.body, '本文B')
    })

    it('申し送りの退避の後の更新・取り消しも、HEAD と同じく直接送る（後ろへ積まない）', async () => {
      DB.__testHooks.setClient(offline().client)
      assert.equal(await DB.updateNote(30, 1, { body: '本文A' }), 'queued')
      const srv = oneRowServer({ id: 30, body: '本文X', deleted_at: null, rev: 1 })
      DB.__testHooks.setClient(srv.client)
      const res = await DB.softDeleteNote(30, 1)
      assert.equal(res, true, '取り消しを退避の後ろへ積んだ')
      assert.equal(srv.calls.filter((q) => q.action === 'update').length, 1)
    })

    it('申し送りの止まった op の後ろにある op は、HEAD と同じくまとめずに送る', async () => {
      const blocked = { qid: 'nB', table: 'notes', kind: 'update', rowId: 30, rev: 1, payload: { body: '本文A' }, blocked: 'conflict', at: 1, tries: 1, nextAt: 0 }
      const later = { qid: 'nP', table: 'notes', kind: 'update', rowId: 30, rev: 2, payload: { importance: 'high' }, at: 2, tries: 0, nextAt: 0 }
      setQueueRaw(JSON.stringify({ ops: [blocked, later] }))
      await DB.__testHooks.restartQueue()
      const srv = oneRowServer({ id: 30, note_on: '2026-09-01', shift: 'day', body: '本文X', deleted_at: null, rev: 2 })
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(srv.state.row.importance, 'high', '申し送りの op を止まった op へまとめた')
      assert.deepEqual(storedQueue().ops.map((o) => o.qid), ['nB'])
    })

    it('外出の帰着記入（updateNow）も、退避があっても直接送る', async () => {
      DB.__testHooks.setClient(offline().client)
      assert.equal(await DB.setOutingEnd(40, 1, '2026-09-01', '10:00'), 'queued')
      const srv = oneRowServer({ id: 40, resident_id: 1, kind: 'outing', start_on: '2026-09-01', end_on: null, end_at: null, deleted_at: null, rev: 1 })
      DB.__testHooks.setClient(srv.client)
      const res = await DB.setOutingEnd(40, 1, '2026-09-01', '11:00')
      assert.equal(typeof res, 'object', `直接送られていない: ${String(res)}`)
    })

    it('申し送りの退避は、基準を持っていても rev 不一致なら HEAD と同じく競合で止める（欄ごとの判定をしない）', async () => {
      DB.__testHooks.setClient(offline().client)
      assert.equal(await DB.updateNote(30, 1, { body: '本文A' }, { bases: { body: '本文' } }), 'queued')
      const srv = oneRowServer({ id: 30, body: '本文', importance: 'high', deleted_at: null, rev: 2 })
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(srv.state.row.body, '本文', '申し送りを欄ごとに判定して送った')
      assert.equal(srv.calls.filter((q) => q.action === 'select').length, 0, '申し送りで読み直した')
      assert.equal(storedQueue().ops[0].blocked, 'conflict')
    })
  })

  // ══════════════════════════════════════════════════════════════
  // バイタル・食事の保存（フェーズ2' 第1段: 送信待ち → RPC apply_cell_edits）
  //
  // 判定はサーバー（0011）が行ロックの下で行う。ここで確かめるのは db.ts 側の約束:
  //   ・結果の形（applied／settled／conflict／partial／missing／組）を画面へそのまま渡す
  //   ・送信待ちの規則（値は後勝ち・基準は先勝ち・版で消し込む・別タブの和集合）
  //   ・旧形式のキューを起動時に読み替える（消さない）
  //   ・関数の無い DB では旧経路へ落とさず「サーバー側の更新待ち」で止める
  // 偽のサーバーは tests/cell-contract.mjs の写し（素の Postgres と同じ答えを返すことを契約の表で押さえてある）
  // ══════════════════════════════════════════════════════════════

  describe('saveVitalEdits / saveMealEdits（結果の形）', () => {
    afterEach(async () => {
      await drainRows()
    })

    it('行が無い → insert して applied。送信待ちは空になり、RPC へは自然キー・fill・操作者を送る', async () => {
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client)
      DB.setEditor(2)
      const res = await DB.saveVitalEdits(ROUTINE, { temp: { value: 36.5, base: null } }, { fill: { measured_at: '9:00', recorded_by: 2 } })
      assert.equal(res.status, 'applied')
      assert.deepEqual(res.applied, ['temp'])
      assert.equal(res.row.temp, 36.5)
      assert.equal(res.row.measured_at, '09:00:00')
      const [q] = srv.sends()
      assert.deepEqual(q.args.p_key, { resident_id: 1, measured_on: '2026-09-01' })
      assert.deepEqual(q.args.p_edits, { temp: { value: 36.5, base: null } })
      assert.deepEqual(q.args.p_fill, { measured_at: '09:00', recorded_by: 2 })
      assert.equal(q.args.p_editor, 2)
      assert.equal(DB.pendingRow('vitals', ROUTINE), null)
      assert.equal(DB.queuePending(), 0)
    })

    it('いまの値＝あなたの値 → noop（settled）。rev は進まない', async () => {
      const srv = cellServer()
      const row = seedVital(srv.db, { temp: 36.5 })
      DB.__testHooks.setClient(srv.client)
      const res = await DB.saveVitalEdits(ROUTINE, { temp: { value: 36.5, base: null } })
      assert.equal(res.status, 'noop')
      assert.deepEqual(res.settled, ['temp'])
      assert.equal(row.rev, 1)
      assert.equal(DB.pendingRow('vitals', ROUTINE), null)
    })

    it('★他の端末が先に書いていた → conflict。書かず、送信待ちに「競合」として残す（画面は〔くらべて選ぶ〕へ）', async () => {
      const srv = cellServer()
      seedVital(srv.db, { temp: 36.8 })
      DB.__testHooks.setClient(srv.client)
      const res = await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.2, base: null } })
      assert.equal(res.status, 'conflict')
      assert.deepEqual(res.conflicts.map((c) => [c.field, c.reason, c.server, c.mine]), [['temp', 'changed', 36.8, 37.2]])
      assert.equal(srv.db.vitals[0].temp, 36.8, '先の値を上書きした')
      const p = DB.pendingRow('vitals', ROUTINE)
      assert.equal(p.state, 'conflict')
      assert.deepEqual(p.values, { temp: 37.2 })
      assert.deepEqual(p.bases, { temp: null })
      assert.equal(DB.queuePending(), 1, '止まった行は未送信として数え続ける')
    })

    it('★1欄は書けて1欄は競合 → partial。書けた欄だけ送信待ちから消える', async () => {
      const srv = cellServer()
      seedVital(srv.db, { temp: 36.5 })
      DB.__testHooks.setClient(srv.client)
      const res = await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.0, base: null }, pulse: { value: 72, base: null } })
      assert.equal(res.status, 'partial')
      assert.deepEqual(res.applied, ['pulse'])
      assert.deepEqual(res.conflicts.map((c) => c.field), ['temp'])
      assert.equal(srv.db.vitals[0].pulse, 72)
      assert.deepEqual(DB.pendingRow('vitals', ROUTINE).values, { temp: 37.0 })
    })

    it('★取り消された行へ基準つきで送る → missing（作り直さない）', async () => {
      const srv = cellServer()
      seedVital(srv.db, { temp: 36.6, deleted_at: '2026-09-01T00:00:00Z' })
      DB.__testHooks.setClient(srv.client)
      const res = await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.0, base: 36.6 } })
      assert.equal(res.status, 'conflict')
      assert.equal(res.row, null)
      assert.deepEqual(res.conflicts.map((c) => [c.field, c.reason]), [['temp', 'missing']])
      assert.equal(srv.db.vitals.filter((r) => r.deleted_at === null).length, 0, '取り消した行を作り直した')
    })

    it('★血圧（F4）: 上だけ直しても相方を「値＝基準」で送る → 相方を他の端末が変えていたら組ごと書かない', async () => {
      const srv = cellServer()
      seedVital(srv.db, { sys_bp: 120, dia_bp: 85 }) // 画面は 120/80 を見ていた。下は他の端末が 85 にした
      DB.__testHooks.setClient(srv.client)
      const edits = RS.recordFieldEdit({}, 'sys_bp', 130, 120, { base: 80 })
      const res = await DB.saveVitalEdits(ROUTINE, edits)
      assert.equal(res.status, 'conflict')
      assert.deepEqual(res.conflicts.map((c) => c.field), ['sys_bp', 'dia_bp'])
      assert.equal(srv.db.vitals[0].sys_bp, 120, '誰も測っていない 130/85 ができた')
    })

    it('競合で止まっている行へ続けて保存しても送らない（held）。rebase で選び直すと送る', async () => {
      const srv = cellServer()
      seedVital(srv.db, { temp: 36.8 })
      DB.__testHooks.setClient(srv.client)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.2, base: null } })
      const before = srv.sends().length
      const held = await DB.saveVitalEdits(ROUTINE, { pulse: { value: 70, base: null } })
      assert.equal(held.held, true)
      assert.equal(srv.sends().length, before, '止まっている行を送った')
      // 〔自分の値で直す〕: いまの値（36.8）を基準にして選び直す
      const res = await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.2, base: 36.8 } }, { rebase: true })
      assert.equal(res.status, 'applied')
      assert.equal(srv.db.vitals[0].temp, 37.2)
      assert.equal(srv.db.vitals[0].pulse, 70, '止まっている間に重ねた欄も一緒に送る')
      assert.equal(DB.pendingRow('vitals', ROUTINE), null)
    })

    it('通信できない → queued（送信待ちに残る）。電波が戻れば送って消える', async () => {
      let off = true
      const srv = cellServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.saveMealEdits(LUNCH, { main_amount: { value: 8, base: null } }, { fill: { recorded_by: 1 } }), 'queued')
      const p = DB.pendingRow('meals', LUNCH)
      assert.equal(p.state, 'pending')
      assert.deepEqual(p.values, { main_amount: 8 })
      assert.equal(DB.queuePending(), 1)
      off = false
      await DB.flushQueue(true)
      assert.equal(srv.db.meals[0].main_amount, 8)
      assert.equal(DB.pendingRow('meals', LUNCH), null)
      assert.equal(DB.queuePending(), 0)
    })

    it('サーバーに拒否された（範囲外）→ DbError。送信待ちには rejected として残り、自動では送らない', async () => {
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client)
      await assert.rejects(() => DB.saveVitalEdits(ROUTINE, { sys_bp: { value: 999, base: null } }), (e) => e instanceof DB.DbError)
      assert.equal(DB.pendingRow('vitals', ROUTINE).state, 'rejected')
      const n = srv.sends().length
      await DB.flushQueue(true)
      assert.equal(srv.sends().length, n, '拒否された行を自動で送り直した')
      assert.equal(DB.queuePending(), 1, '拒否された行は未送信として数える')
    })

    it('送る値は列の精度にそろえる（体温は小数1桁・時刻は時:分）', async () => {
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 36.55, base: null }, measured_at: { value: '9:05', base: null } })
      assert.deepEqual(srv.sends()[0].args.p_edits, {
        temp: { value: 36.6, base: null },
        measured_at: { value: '09:05', base: null },
      })
    })

    it('操作者は setEditor の値、記録ごとに選んだ職員（editedBy）があればそちら', async () => {
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client)
      DB.setEditor(1)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 36.5, base: null } })
      await DB.saveVitalEdits(ROUTINE, { pulse: { value: 70, base: null } }, { editedBy: 2 })
      assert.deepEqual(srv.sends().map((q) => q.args.p_editor), [1, 2])
      assert.equal(srv.db.vitals[0].edited_by, 2)
    })

    it('読めない値・送れない欄は送信待ちへ入れない（例外。入力は画面に残る）', async () => {
      DB.__testHooks.setClient(cellServer().client)
      await assert.rejects(() => DB.saveVitalEdits(ROUTINE, { pulse: { value: 'abc', base: null } }))
      await assert.rejects(() => DB.saveVitalEdits(ROUTINE, { rev: { value: 3 } }))
      assert.equal(DB.pendingRow('vitals', ROUTINE), null)
    })
  })

  describe('送信待ち（pending store）の規則', () => {
    afterEach(async () => {
      await drainRows()
    })

    it('★同じ欄を続けて直すと、値は後勝ち・基準は先勝ち（送信待ちの自分の値を基準にしない）', async () => {
      DB.__testHooks.setClient(offline().client)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.0, base: 36.5 } })
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.3, base: 37.0 } })
      const p = DB.pendingRow('vitals', ROUTINE)
      assert.deepEqual(p.values, { temp: 37.3 })
      assert.deepEqual(p.bases, { temp: 36.5 })
    })

    it('★同じミリ秒に続けて10回以上直しても、最後の値が残り基準は最初のまま（版は連番で比べる）', async () => {
      DB.__testHooks.setClient(offline().client)
      const realNow = Date.now
      const fixed = realNow()
      Date.now = () => fixed
      try {
        for (let i = 0; i < 12; i++) await DB.saveVitalEdits(ROUTINE, { pulse: { value: 60 + i, base: 50 + i } })
      } finally {
        Date.now = realNow
      }
      const p = DB.pendingRow('vitals', ROUTINE)
      assert.deepEqual(p.values, { pulse: 71 }, '古い値が残った（版を文字列で比べると .10 が .9 に負ける）')
      assert.deepEqual(p.bases, { pulse: 50 })
    })

    it('基準が分からない欄（base 無し・rowSync の UNKNOWN_BASE）は基準を持たずに送る', async () => {
      const srv = cellServer()
      seedVital(srv.db, { temp: null })
      DB.__testHooks.setClient(srv.client)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.0 }, pulse: { value: 70, base: RS.UNKNOWN_BASE } })
      assert.deepEqual(srv.sends()[0].args.p_edits, { temp: { value: 37 }, pulse: { value: 70 } })
    })

    it('★送信中に同じ欄を打ち直した: 先の応答ではその欄を消さず、基準を「載った値」へ持ち直して続けて送る（偽の競合にしない）', async () => {
      let release
      const gate = new Promise((r) => {
        release = r
      })
      let first = true
      const srv = cellServer({
        hold: async () => {
          if (!first) return
          first = false
          await gate
        },
      })
      DB.__testHooks.setClient(srv.client)
      const a = DB.saveVitalEdits(ROUTINE, { temp: { value: 37.0, base: null } })
      await settle() // 先の送信が応答待ちになった
      assert.equal(srv.sends().length, 1)
      const b = DB.saveVitalEdits(ROUTINE, { temp: { value: 37.4, base: 37.0 } })
      await settle()
      release()
      const [ra, rb] = await Promise.all([a, b])
      assert.equal(ra.status, 'applied')
      assert.equal(rb.status, 'applied', `後の入力が競合になった: ${JSON.stringify(rb)}`)
      assert.equal(srv.db.vitals[0].temp, 37.4)
      assert.deepEqual(srv.sends()[1].args.p_edits, { temp: { value: 37.4, base: 37 } })
      assert.equal(DB.pendingRow('vitals', ROUTINE), null)
    })

    it('★別タブの和集合: 他のタブが積んだ行は消さずに書き戻し、このタブも送れる', async () => {
      // 同じ端末の他のタブが積んだ食事の行（版の印が別のタブ）
      const other = {
        table: 'meals',
        key: { resident_id: 1, meal_on: '2026-09-01', meal_slot: 'lunch' },
        edits: { side_amount: { value: 6, base: null, at: 1, ver: 'tOTHER.1' } },
        fill: {},
        editor: null,
        state: 'pending',
        tries: 0,
        nextAt: 0,
        tab: 'tOTHER',
        at: 1,
      }
      setQueue2Raw(JSON.stringify({ ver: 2, rows: { 'meals@1|2026-09-01|lunch': other }, done: [] }))
      DB.__testHooks.setClient(offline().client)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.0, base: null } })
      const rows = storedQueue().rows
      assert.deepEqual(Object.keys(rows).sort(), ['meals@1|2026-09-01|lunch', 'vitals@1|2026-09-01|routine'])
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(srv.db.meals[0]?.side_amount, 6, '他のタブの行を送れていない')
      assert.equal(srv.db.vitals[0]?.temp, 37)
      assert.deepEqual(storedQueue().rows, {})
    })

    it('★別タブが送り終えて消した版は、このタブのメモリから復活させない（二重に送り続けない）', async () => {
      DB.__testHooks.setClient(offline().client)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.0, base: null } })
      assert.equal(Object.keys(storedQueue().rows).length, 1)
      // 他のタブが送り終えて、保存先から消した（第3段 #5: 消した側は送信済みの記録 done を残す）
      const ed = storedQueue().rows['vitals@1|2026-09-01|routine'].edits.temp
      setQueue2Raw(JSON.stringify({ ver: 2, rows: {}, done: [{ k: 'vitals@1|2026-09-01|routine', f: 'temp', v: ed.ver, at: ed.at, t: Date.now() }] }))
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(srv.sends().length, 0, '他のタブで済んだ行を送り直した')
      assert.equal(DB.queuePending(), 0)
    })

    it('書き戻しに失敗した入力はメモリに残し、書けるようになったら和集合で書き戻す（消さない）', async () => {
      const realSet = globalThis.localStorage.setItem
      globalThis.localStorage.setItem = () => {
        throw new Error('quota')
      }
      try {
        DB.__testHooks.setClient(offline().client)
        assert.equal(await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.0, base: null } }), 'queued')
        assert.equal(DB.isQueuePersisted(), false)
      } finally {
        globalThis.localStorage.setItem = realSet
      }
      // 他のタブが別の行を書いていた
      const other = {
        table: 'meals',
        key: { resident_id: 2, meal_on: '2026-09-01', meal_slot: 'dinner' },
        edits: { main_amount: { value: 5, base: null, at: 1, ver: 'tOTHER.9' } },
        fill: {},
        editor: null,
        state: 'pending',
        tries: 0,
        nextAt: 0,
        tab: 'tOTHER',
        at: 1,
      }
      setQueue2Raw(JSON.stringify({ ver: 2, rows: { 'meals@2|2026-09-01|dinner': other }, done: [] }))
      await DB.saveMealEdits(LUNCH, { main_amount: { value: 7, base: null } })
      assert.equal(DB.isQueuePersisted(), true)
      assert.deepEqual(Object.keys(storedQueue().rows).sort(), [
        'meals@1|2026-09-01|lunch',
        'meals@2|2026-09-01|dinner',
        'vitals@1|2026-09-01|routine',
      ])
    })

    it('書き戻しと送信は Web Locks で包む（cl_sendQueue_write／cl_sendQueue_flush）', async () => {
      const locks = globalThis.navigator.locks
      if (!locks) return // Web Locks の無い Node では確かめられない（包まずに動く）
      const names = []
      const orig = locks.request
      locks.request = function (name, ...rest) {
        names.push(name)
        return orig.call(this, name, ...rest)
      }
      try {
        DB.__testHooks.setClient(cellServer().client)
        await DB.saveVitalEdits(ROUTINE, { temp: { value: 36.5, base: null } })
      } finally {
        delete locks.request
      }
      assert.ok(names.includes('cl_sendQueue_write'), names.join(','))
      assert.ok(names.includes('cl_sendQueue_flush'), names.join(','))
    })

    it('〔先の値を残す〕で取り下げた行は、次の起動でも復活しない', async () => {
      const srv = cellServer()
      seedVital(srv.db, { temp: 36.8 })
      DB.__testHooks.setClient(srv.client)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.2, base: null } })
      assert.equal(DB.pendingRow('vitals', ROUTINE).state, 'conflict')
      await DB.discardPendingRow('vitals', ROUTINE)
      await DB.__testHooks.restartQueue()
      assert.equal(DB.pendingRow('vitals', ROUTINE), null)
      assert.equal(DB.queuePending(), 0)
    })
  })

  describe('旧形式の送信キュー（op の配列）を起動時に読み替える（裁定8）', () => {
    afterEach(async () => {
      await drainRows()
    })

    const vIns = (qid, payload, over = {}) => ({ qid, table: 'vitals', kind: 'insert', payload, at: 1, tries: 0, nextAt: 0, ...over })
    const vUpd = (qid, rowId, payload, over = {}) => ({ qid, table: 'vitals', kind: 'update', rowId, rev: 1, payload, at: 2, tries: 0, nextAt: 0, ...over })

    it('★insert → 基準は空（null）。未入力の null は欄にしない。定時の測定時刻・記入者は「空いていれば埋める」', async () => {
      setQueueRaw(JSON.stringify({ ops: [vIns('q1', { ...vitalInput({ temp: 37.1 }), measured_at: '09:03', recorded_by: 2 })] }))
      await DB.__testHooks.restartQueue()
      const saved = storedQueue()
      // 第3段 #1: バイタル・食事は cl_sendQueue2 へ移し、cl_sendQueue は HEAD の形（{ ops }）のまま
      assert.equal(JSON.parse(lsStore.get('cl_sendQueue2')).ver, 2, '新しい形で書き戻していない')
      assert.deepEqual(saved.ops, [], 'cl_sendQueue から移していない')
      const row = saved.rows['vitals@1|2026-09-01|routine']
      assert.deepEqual(Object.keys(row.edits), ['temp'])
      assert.deepEqual({ value: row.edits.temp.value, base: row.edits.temp.base }, { value: 37.1, base: null })
      assert.deepEqual(row.fill, { recorded_by: 2, measured_at: '09:03' })
      assert.equal(row.state, 'pending')
    })

    it('★基準つきの update はその基準のまま・基準の無い update は「基準不明」（base キー無し）', async () => {
      setQueueRaw(
        JSON.stringify({
          ops: [
            vUpd('q2', 55, { pulse: 70, edited_by: 3 }, { bases: { pulse: 60 } }),
            vUpd('q3', 56, { spo2: 97 }),
          ],
        }),
      )
      await DB.__testHooks.restartQueue()
      const rows = storedQueue().rows
      assert.deepEqual(rows['vitals#55'].key, { id: 55 })
      assert.equal(rows['vitals#55'].edits.pulse.base, 60)
      assert.equal(rows['vitals#55'].editor, 3)
      assert.equal('base' in rows['vitals#56'].edits.spo2, false)
    })

    it('送信中に届いた書込（late）は畳む。late だけの欄は late の基準', async () => {
      setQueueRaw(
        JSON.stringify({
          ops: [vUpd('q4', 57, { temp: 37.0 }, { bases: { temp: 36.0 }, late: { pulse: 80, temp: 37.5 }, lateBases: { pulse: 70, temp: 37.0 } })],
        }),
      )
      await DB.__testHooks.restartQueue()
      const e = storedQueue().rows['vitals#57'].edits
      assert.deepEqual([e.temp.value, e.temp.base], [37.5, 36.0])
      assert.deepEqual([e.pulse.value, e.pulse.base], [80, 70])
    })

    it('競合で止まった op → conflict・拒否で止まった op → rejected（どちらも自動では送らない）', async () => {
      setQueueRaw(
        JSON.stringify({
          ops: [
            vUpd('q5', 58, { pulse: 70 }, { blocked: 'conflict' }),
            { ...vUpd('q6', 59, { note: 'x' }), table: 'meals', blocked: 'rejected' },
          ],
        }),
      )
      await DB.__testHooks.restartQueue()
      const rows = storedQueue().rows
      assert.equal(rows['vitals#58'].state, 'conflict')
      assert.equal(rows['meals#59'].state, 'rejected')
      assert.equal(DB.pendingRow('vitals', { routine: false, id: 58 }).state, 'conflict')
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(srv.sends().length, 0)
      assert.equal(DB.queuePending(), 2)
    })

    it('★読めない op・送れない欄を持つ op は捨てずに brokenRaw へ。他の op（申し送り・既読）は legacyOps に残す', async () => {
      const note = op('n1', { payload: { note_on: '2026-09-01', shift: 'day', body: '本文', client_key: 'n1' } })
      const read = { qid: 'r1', table: 'note_reads', kind: 'read', payload: { note_id: 1, staff_id: 2 }, at: 1, tries: 0, nextAt: 0 }
      const odd = vUpd('q7', 60, { raw_flags: { x: 1 } })
      setQueueRaw(JSON.stringify({ ops: [note, read, odd, { broken: true }] }))
      await DB.__testHooks.restartQueue()
      const saved = storedQueue()
      assert.deepEqual(saved.ops.map((o) => o.qid), ['n1', 'r1'])
      assert.deepEqual(saved.rows, {})
      assert.match(saved.brokenRaw, /raw_flags/)
      assert.match(saved.brokenRaw, /"broken":true/)
      assert.equal(DB.isQueueBroken(), true)
    })

    it('JSON として読めない原文は消さずに brokenRaw に残す', async () => {
      setQueueRaw('{not json')
      await DB.__testHooks.restartQueue()
      assert.equal(DB.isQueueBroken(), true)
      assert.equal(lsStore.get('cl_sendQueue'), '{not json', '読めない原文を書き換えた')
    })

    it('★読み替えた行は RPC で送る（食事の update は行 id から自然キーへ付け替えて送る）', async () => {
      setQueueRaw(
        JSON.stringify({
          ops: [
            vIns('q8', { ...vitalInput({ temp: 37.1 }), recorded_by: 2 }),
            { qid: 'q9', table: 'meals', kind: 'update', rowId: 20, rev: 1, payload: { main_amount: 5 }, bases: { main_amount: 8 }, at: 3, tries: 0, nextAt: 0 },
          ],
        }),
      )
      await DB.__testHooks.restartQueue()
      const srv = cellServer()
      srv.db.nextId = 20
      seedMeal(srv.db, { main_amount: 8 })
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      const sends = srv.sends()
      assert.deepEqual(sends.map((q) => q.args.p_key), [
        { resident_id: 1, measured_on: '2026-09-01' },
        { resident_id: 1, meal_on: '2026-09-01', meal_slot: 'lunch' },
      ])
      assert.equal(srv.db.vitals[0].temp, 37.1)
      assert.equal(srv.db.meals[0].main_amount, 5)
      assert.equal(DB.queuePending(), 0)
    })

    it('旧形式の送り終えた印（done）の op は読み込まない。同じ旧形式を2回読み替えても1行のまま', async () => {
      setQueueRaw(JSON.stringify({ ops: [vIns('q10', vitalInput({ temp: 37.0 })), vIns('q11', { ...vitalInput({ pulse: 70 }), resident_id: 2 })], done: [{ q: 'q10', at: 1 }] }))
      await DB.__testHooks.restartQueue()
      assert.deepEqual(Object.keys(storedQueue().rows), ['vitals@2|2026-09-01|routine'])
      const again = storedQueue()
      setQueueRaw(JSON.stringify({ ops: [vIns('q11', { ...vitalInput({ pulse: 70 }), resident_id: 2 })] }))
      await DB.__testHooks.restartQueue()
      assert.deepEqual(storedQueue().rows['vitals@2|2026-09-01|routine'].edits.pulse.ver, again.rows['vitals@2|2026-09-01|routine'].edits.pulse.ver)
    })
  })

  describe('入力解禁と同時に 0011 の有無を確かめる（裁定5）', () => {
    afterEach(async () => {
      await drainRows()
    })

    it('★関数が無い DB（PGRST202）→ cells:missing。バイタル・食事は「サーバー側の更新待ち」で止め、旧経路へ落とさない', async () => {
      const srv = cellServer({ missingRpc: () => true })
      DB.__testHooks.setClient(srv.client, { cellRpc: null })
      const gate = await DB.getNativeInputGate()
      assert.equal(gate.cells, 'missing')
      await assert.rejects(
        () => DB.saveVitalEdits(ROUTINE, { temp: { value: 36.5, base: null } }),
        (e) => e instanceof DB.DbError && e.kind === 'blocked' && /サーバー側の更新待ち/.test(e.message),
      )
      await assert.rejects(
        () => DB.saveMealEdits({ residentId: 1, day: '2026-09-01', slot: 'lunch' }, { main_amount: { value: 5, base: null } }),
        (e) => e.kind === 'blocked',
      )
      assert.equal(srv.calls.filter((q) => q.action === 'insert' || q.action === 'update').length, 0, '旧経路で書いた')
      assert.equal(DB.queuePending(), 0)
    })

    it('関数がある → cells:ready（問い合わせは生存確認 probe だけ）', async () => {
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client, { cellRpc: null })
      const gate = await DB.getNativeInputGate()
      assert.equal(gate.cells, 'ready')
      const probes = srv.calls.filter((q) => q.action === 'rpc' && q.args.p_table === 'probe')
      assert.equal(probes.length, 1)
    })

    it('申し送り・水分・外出は 0011 が無くても止めない（旧経路のまま）', async () => {
      const fake = fakeSupabase((q) => {
        if (q.action === 'rpc') return { data: null, error: { code: 'PGRST202', message: 'none' }, status: 404 }
        if (q.action === 'insert') return { data: { id: 1, note_on: '2026-09-01', shift: 'day', body: '本文', rev: 1 }, error: null, status: 201 }
        if (q.table === 'app_settings') return { data: { value: 'true' }, error: null, status: 200 } // 入力解禁中
        return { data: null, error: null, status: 200 }
      })
      DB.__testHooks.setClient(fake.client, { cellRpc: null })
      const gate = await DB.getNativeInputGate()
      assert.equal(gate.value, true)
      const res = await DB.insertNote({ note_on: '2026-09-01', shift: 'day', body: '本文', resident_id: null, role_tags: [], importance: 'normal', occurred_at: null, ongoing: false, ended_at: null, reporter_id: null, facility: null, category: null, color: null, after16: false })
      assert.equal(res.id, 1)
    })

    it('送る時に関数が無かった（DB が戻された）行は、拒否にせず送信待ちのまま待つ', async () => {
      let missing = false
      let off = true
      const srv = cellServer({ offline: () => off, missingRpc: () => missing })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.saveVitalEdits(ROUTINE, { temp: { value: 36.5, base: null } }), 'queued')
      off = false
      missing = true
      await DB.flushQueue(true)
      const p = DB.pendingRow('vitals', ROUTINE)
      assert.equal(p.state, 'pending', '関数が無いのに拒否として止めた')
      assert.equal(DB.queuePending(), 1)
    })
  })

  describe('新しい行の冪等キー（client_key。〔両方残す〕・日報の発熱者・他症状者）', () => {
    afterEach(async () => {
      await drainRows()
    })

    it('同じキーで2回送っても1行に収まる・キーが違えば別の行', async () => {
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client)
      const target = (clientKey) => ({ routine: false, clientKey, residentId: 1, day: '2026-09-01', kind: 'recheck' })
      const key = DB.newClientKey()
      const a = await DB.saveVitalEdits(target(key), { sys_bp: { value: 130, base: null } })
      const b = await DB.saveVitalEdits(target(key), { sys_bp: { value: 130, base: null } })
      assert.equal(a.row.id, b.row.id)
      assert.equal(srv.db.vitals.length, 1)
      assert.deepEqual(srv.sends().map((q) => q.args.p_key.client_key), [key, key])
      await DB.saveVitalEdits(target(DB.newClientKey()), { sys_bp: { value: 130, base: null } })
      await DB.saveVitalEdits(target(DB.newClientKey()), { sys_bp: { value: 130, base: null } })
      assert.equal(srv.db.vitals.length, 3)
    })
  })

  describe('★第3段（検収の条件付き指摘 #1〜#9）', () => {
    afterEach(async () => {
      await drainRows()
    })

    const mealOp = (qid, main) => ({
      qid,
      table: 'meals',
      kind: 'insert',
      payload: { resident_id: 1, meal_on: '2026-09-01', meal_slot: 'lunch', main_amount: main, recorded_by: 1 },
      at: 5,
      tries: 0,
      nextAt: 0,
    })

    it('★#1 旧ビルド（HEAD）へ戻して読み書きされても、バイタル・食事の送信待ちと退避 op が消えない', async () => {
      DB.__testHooks.setClient(offline().client)
      assert.equal(await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.2, base: null } }), 'queued')
      assert.equal(await DB.updateNote(30, 1, { body: '本文A' }), 'queued')
      // 旧ビルドで起動 → 読んで書き戻す（その間に食事を1件積んだ）
      headRoundTrip()
      headRoundTrip([mealOp('h1', 5)])
      // 新しいビルドへ戻す
      await DB.__testHooks.restartQueue()
      assert.equal(DB.pendingRow('vitals', ROUTINE)?.values.temp, 37.2, 'バイタルの送信待ちが消えた')
      assert.equal(DB.pendingRow('meals', LUNCH)?.values.main_amount, 5, '旧ビルドで積んだ食事が移っていない')
      assert.ok(storedQueue().ops.some((o) => o.table === 'notes'), '申し送りの退避 op が消えた')
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(srv.db.vitals[0]?.temp, 37.2)
      assert.equal(srv.db.meals[0]?.main_amount, 5)
    })

    it('★#1 cl_sendQueue は HEAD の形（{ ops }）のまま。バイタル・食事は LS.sendQueue2（cl_sendQueue2）に置く', async () => {
      DB.__testHooks.setClient(offline().client)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.2, base: null } })
      await DB.updateNote(30, 1, { body: '本文A' })
      assert.equal(T.LS.sendQueue2, 'cl_sendQueue2')
      const box1 = JSON.parse(lsStore.get('cl_sendQueue'))
      assert.deepEqual(Object.keys(box1).filter((k) => k !== 'brokenRaw'), ['ops'], `HEAD の形ではない: ${Object.keys(box1)}`)
      assert.deepEqual(box1.ops.map((o) => o.table), ['notes'])
      const box2 = JSON.parse(lsStore.get('cl_sendQueue2') ?? 'null')
      assert.ok(box2 && box2.rows['vitals@1|2026-09-01|routine'], 'バイタルが cl_sendQueue2 に無い')
    })

    it('★#1 旧ビルドが積んだ op は、cl_sendQueue2 に書けたことを読み直して確かめてから外す（書けなければ外さない）', async () => {
      setQueueRaw(JSON.stringify({ ops: [mealOp('h2', 5)] }))
      const realSet = globalThis.localStorage.setItem
      globalThis.localStorage.setItem = (k, v) => {
        if (k === 'cl_sendQueue2') throw new Error('quota')
        realSet(k, v)
      }
      try {
        await DB.__testHooks.restartQueue()
      } finally {
        globalThis.localStorage.setItem = realSet
      }
      const kept = JSON.parse(lsStore.get('cl_sendQueue'))
      assert.equal(kept.ops?.length, 1, `移せていないのに cl_sendQueue から外した: ${lsStore.get('cl_sendQueue')}`)
      await DB.__testHooks.restartQueue()
      assert.deepEqual(JSON.parse(lsStore.get('cl_sendQueue')).ops, [])
      assert.equal(storedQueue().rows['meals@1|2026-09-01|lunch']?.edits.main_amount.value, 5)
    })

    it('★#2 旧形式の定時バイタルの update（行 id）は、送る直前に1行読んで自然キーへ付け替える（一覧から見える）', async () => {
      const srv = cellServer()
      srv.db.nextId = 57
      seedVital(srv.db, { temp: 36.5, pulse: 65 }) // 他の端末が先に脈拍 65
      const op = { qid: 'u1', table: 'vitals', kind: 'update', rowId: 57, rev: 1, payload: { pulse: 70 }, bases: { pulse: null }, at: 1, tries: 0, nextAt: 0 }
      setQueueRaw(JSON.stringify({ ops: [op] }))
      await DB.__testHooks.restartQueue()
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.deepEqual(srv.sends()[0]?.args.p_key, { resident_id: 1, measured_on: '2026-09-01' })
      const p = DB.pendingRow('vitals', ROUTINE)
      assert.equal(p?.state, 'conflict', '定時の止まった行が一覧（自然キー）から見えない')
      assert.equal(p?.values.pulse, 70)
    })

    it('#2 定時以外（発熱者・他症状者・再検）は行 id のまま。日報・一覧の行 id 指定から見える', async () => {
      const op = { qid: 'u2', table: 'vitals', kind: 'update', rowId: 58, rev: 1, payload: { temp: 37.9 }, bases: { temp: 37.6 }, at: 1, tries: 0, nextAt: 0 }
      setQueueRaw(JSON.stringify({ ops: [op] }))
      await DB.__testHooks.restartQueue()
      assert.equal(DB.pendingRow('vitals', { routine: false, id: 58 })?.values.temp, 37.9)
    })

    it('★#3 組の片方だけを取り下げない（上だけを外すと下も外れる）', async () => {
      DB.__testHooks.setClient(offline().client)
      await DB.saveVitalEdits(ROUTINE, { sys_bp: { value: 130, base: 120 }, dia_bp: { value: 80, base: 80 } })
      await DB.discardPendingRow('vitals', ROUTINE, ['sys_bp'])
      assert.equal(DB.pendingRow('vitals', ROUTINE), null, '血圧の片方だけが残った')
    })

    it('★#3 組の片方が settled で返っても（旧いサーバー）、相方が競合なら端末は片方だけを消さない', async () => {
      const fake = fakeSupabase((q) => {
        if (q.action === 'rpc' && q.args?.p_table === 'probe') return { data: null, error: null, status: 200 }
        if (q.action === 'rpc') {
          return {
            data: {
              version: 1,
              status: 'conflict',
              row: { id: 9, resident_id: 1, measured_on: '2026-09-01', kind: 'routine', sys_bp: 125, dia_bp: 90, rev: 3 },
              applied: [],
              settled: ['dia_bp'],
              conflicts: [{ field: 'sys_bp', server: 125, base: 120, mine: 130, reason: 'changed' }],
            },
            error: null,
            status: 200,
          }
        }
        return { data: null, error: { message: 'x' }, status: 500 }
      })
      DB.__testHooks.setClient(fake.client)
      await DB.saveVitalEdits(ROUTINE, { sys_bp: { value: 130, base: 120 }, dia_bp: { value: 90, base: 80 } })
      const p = DB.pendingRow('vitals', ROUTINE)
      assert.deepEqual(Object.keys(p?.values ?? {}).sort(), ['dia_bp', 'sys_bp'], '組の片方だけが消えた')
    })

    it('★#3 〔自分の値で直す〕は血圧を組で送る（あなたの組＝mine・基準＝取り直した最新の組）', () => {
      assert.equal(typeof CF.withBpPair, 'function', 'withBpPair が無い')
      const patch = CF.withBpPair({ sys_bp: 130 }, { sys_bp: 130 }, { sys_bp: 120, dia_bp: 80 })
      assert.deepEqual(patch, { sys_bp: 130, dia_bp: 80 })
      const src = readFileSync(new URL('../src/components/ConflictResolver.tsx', import.meta.url), 'utf8')
      assert.match(src, /withBpPair\(patchForMine\(/)
    })

    it('★#4 食事の読み直しは、送信待ちにある全ての欄（メモを含む）で突き合わせる（MEAL_FIELDS に固定しない）', () => {
      for (const p of ['MealsSheetPage.tsx', 'MealsGridPage.tsx']) {
        const src = readFileSync(new URL(`../src/pages/${p}`, import.meta.url), 'utf8')
        assert.doesNotMatch(src, /reconcileOnLoad\(MEAL_FIELDS,/, `${p} が MEAL_FIELDS に固定して突き合わせている`)
        assert.match(src, /judgeFields\(MEAL_FIELDS, /, p)
      }
      assert.equal(typeof RS.judgeFields, 'function')
      assert.deepEqual(RS.judgeFields(['main_amount', 'side_amount', 'status'], { values: { note: 'x', main_amount: 5 } }), [
        'main_amount',
        'side_amount',
        'status',
        'note',
      ])
      // 相手と食い違うメモは競合として残る（捨てない）
      const edits = RS.recordFieldEdit({}, 'note', '先のメモ\n（職員A）主食 5割', '先のメモ')
      const r = RS.reconcileOnLoad(['main_amount', 'side_amount', 'status', 'note'], edits, { note: '別の端末のメモ' })
      assert.equal(r.status, 'conflict')
    })

    it('★#5 退避 op（申し送りなど）の書き戻しも書込ロック（cl_sendQueue_write）の中で行う', async () => {
      const locks = globalThis.navigator.locks
      const names = []
      const orig = locks.request
      locks.request = function (name, ...rest) {
        names.push(name)
        return orig.call(this, name, ...rest)
      }
      try {
        DB.__testHooks.setClient(offline().client)
        assert.equal(await DB.updateNote(30, 1, { body: '本文A' }), 'queued')
      } finally {
        delete locks.request
      }
      assert.ok(names.includes('cl_sendQueue_write'), `ロックの外で書き戻した: ${names.join(',')}`)
    })

    it('★#5 保存先から消えていても、送信済みの記録（版）が無ければ捨てない（読み違いで捨てない）', async () => {
      DB.__testHooks.setClient(offline().client)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.2, base: null } })
      // 保存先が「送信済みの記録なし」で空になった（読み違い・他の版が書き戻した等）
      setQueueRaw(JSON.stringify({ ver: 2, rows: {}, legacyOps: [] }))
      setQueue2Raw(JSON.stringify({ ver: 2, rows: {}, done: [] }))
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(srv.db.vitals[0]?.temp, 37.2, '保存先から消えただけで、送っていない入力を捨てた')
    })

    it('#5 送信済みの記録（done）がある版は、このタブのメモリから復活させない', async () => {
      DB.__testHooks.setClient(offline().client)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.2, base: null } })
      const ed = storedQueue().rows['vitals@1|2026-09-01|routine'].edits.temp
      setQueue2Raw(JSON.stringify({ ver: 2, rows: {}, done: [{ k: 'vitals@1|2026-09-01|routine', f: 'temp', v: ed.ver, at: ed.at, t: Date.now() }] }))
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(srv.sends().length, 0, '他のタブで済んだ版を送り直した')
      assert.equal(DB.queuePending(), 0)
    })

    it('★#6 冪等キーの行が競合した後、行 id で見ても取り下げても、ck 側の控えと食い違わない', async () => {
      const srv = cellServer()
      seedVital(srv.db, { kind: 'recheck', client_key: 'ck1', sys_bp: 130 }) // 応答だけ失われて載っていた
      DB.__testHooks.setClient(srv.client)
      const T1 = { routine: false, clientKey: 'ck1', residentId: 1, day: '2026-09-01', kind: 'recheck' }
      const res = await DB.saveVitalEdits(T1, { pulse: { value: 70, base: 60 } })
      assert.equal(res.conflicts.length, 1, '（前提）競合')
      const id = res.row.id
      assert.equal(DB.pendingRow('vitals', { routine: false, id })?.state, 'conflict', '行 id から ck 側の控えが見えない')
      await DB.discardPendingRow('vitals', { routine: false, id })
      assert.equal(DB.pendingRow('vitals', T1), null, 'ck 側の控えが残った')
      assert.equal(DB.queuePending(), 0)
    })

    it('★#8 食事の〔両方残す〕: メモの保存が拒否されたら、取り下げた入力を元に戻す（成功した時だけ外す）', async () => {
      let rejectNote = true
      const srv = cellServer({ reject: (q) => rejectNote && q.args?.p_edits?.note !== undefined })
      seedMeal(srv.db, { main_amount: 8, note: null })
      DB.__testHooks.setClient(srv.client)
      const res = await DB.saveMealEdits(LUNCH, { main_amount: { value: 5, base: 3 } })
      assert.equal(res.conflicts.length, 1, '（前提）主食が競合')
      const seen = DB.pendingRow('meals', LUNCH)
      assert.ok(seen?.vers?.main_amount, 'pendingRow が版を返さない')
      // メモの保存がサーバーに拒否される
      await assert.rejects(() =>
        DB.saveMealEdits(LUNCH, { note: { value: '（職員A）主食 5割', base: null } }, { rebase: true, dropVers: seen.vers }),
      )
      const back = DB.pendingRow('meals', LUNCH)
      assert.equal(back?.values.main_amount, 5, '拒否されたのに、取り下げた入力が戻っていない')
      assert.equal(back?.state, 'conflict', '元の競合の状態に戻っていない')
      assert.equal(back?.values.note, undefined, '拒否されたメモが送信待ちに残った')
      // 画面は戻った入力の版を見直してから、もう一度〔両方残す〕を押す（くらべて選ぶ画面は失敗の後に版を取り直す）
      rejectNote = false
      const ok = await DB.saveMealEdits(LUNCH, { note: { value: '（職員A）主食 5割', base: null } }, { rebase: true, dropVers: back.vers })
      assert.equal(ok.applied.includes('note'), true)
      assert.equal(srv.db.meals[0].main_amount, 8, 'メモと一緒に主食を送った')
      assert.equal(DB.pendingRow('meals', LUNCH), null)
    })

    it('#8 食事の〔両方残す〕（成功の経路）: 空欄に入れた主食 8 が他の端末の 5 と競合 → メモの追記へ置き換えて1回で書ける', async () => {
      const srv = cellServer()
      seedMeal(srv.db, { main_amount: 5, note: null })
      DB.__testHooks.setClient(srv.client)
      const res = await DB.saveMealEdits(LUNCH, { main_amount: { value: 8, base: null } }, { fill: { recorded_by: 1 } })
      assert.equal(res.conflicts.length, 1, '（前提）主食が競合')
      const seen = RS.seenVers(DB.pendingRow('meals', LUNCH), { main_amount: 8 })
      assert.deepEqual(Object.keys(seen), ['main_amount'])
      const ok = await DB.saveMealEdits(LUNCH, { note: { value: '（職員A）主食 8割', base: null } }, { rebase: true, dropVers: seen })
      assert.deepEqual(ok.conflicts, [], `メモと一緒に主食を送った: ${JSON.stringify(ok.conflicts)}`)
      assert.equal(srv.db.meals[0].main_amount, 5)
      assert.equal(srv.db.meals[0].note, '（職員A）主食 8割')
      assert.equal(DB.pendingRow('meals', LUNCH), null)
    })

    it('★#8 〔両方残す〕（バイタル）は、新しい行の保存の後で元の入力を外す', () => {
      const src = readFileSync(new URL('../src/components/ConflictResolver.tsx', import.meta.url), 'utf8')
      const body = src.slice(src.indexOf('const chooseBoth'), src.indexOf('const busy ='))
      const save = body.indexOf('await saveVitalEdits(')
      const discard = body.indexOf('await discardMine(')
      assert.ok(save > 0 && discard > save, '新しい行を保存する前に元の入力を外している')
    })

    it('★#9 取り下げは画面が見た版だけ外す（見た後に打ち直した値は残す）', async () => {
      DB.__testHooks.setClient(offline().client)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.2, base: null } })
      const seen = DB.pendingRow('vitals', ROUTINE)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.5, base: null } }) // 見た後に打ち直した
      await DB.discardPendingRow('vitals', ROUTINE, ['temp'], seen.vers)
      assert.equal(DB.pendingRow('vitals', ROUTINE)?.values.temp, 37.5, '見ていない版まで取り下げた')
    })

    it('★#3 止まった行を画面へ取り込む時、血圧は組で取り込む（相方が「値＝基準」でも落とさない）', () => {
      const p = { values: { sys_bp: 130, dia_bp: 80, pulse: 70 }, bases: { sys_bp: 120, dia_bp: 80, pulse: 70 } }
      const e = RS.adoptPendingEdits(['temp', 'sys_bp', 'dia_bp', 'pulse'], {}, p)
      assert.deepEqual(Object.keys(e).sort(), ['dia_bp', 'sys_bp'], '血圧の相方が落ちた（組が割れる）')
      assert.deepEqual([e.dia_bp.value, e.dia_bp.base], [80, 80])
      // 画面に既にある欄は画面の値を残す
      const mine = RS.recordFieldEdit({}, 'sys_bp', 135, 120)
      assert.equal(RS.adoptPendingEdits(['sys_bp', 'dia_bp'], mine, p).sys_bp.value, 135)
    })

    it('★#9 画面が見た版は、見せている値と同じ欄の版だけ（見た後に打ち直した値の版は含めない）', () => {
      const p = { values: { temp: 37.5, pulse: 70 }, vers: { temp: 't.2', pulse: 't.1' } }
      assert.deepEqual(RS.seenVers(p, { temp: 37.2, pulse: 70 }), { pulse: 't.1' })
      assert.deepEqual(RS.seenVers(null, { temp: 37.2 }), {})
    })

    it('#1 途中の版が cl_sendQueue に書いた形（{ ver: 2, rows, legacyOps }）も、cl_sendQueue2 へ移して HEAD の形に戻す', async () => {
      const row = {
        table: 'vitals',
        key: { resident_id: 1, measured_on: '2026-09-01' },
        edits: { temp: { value: 37.1, base: null, at: 1, ver: 'tMID.1' } },
        fill: {},
        editor: null,
        state: 'pending',
        tries: 0,
        nextAt: 0,
        tab: 'tMID',
        at: 1,
      }
      const note = { qid: 'n9', table: 'notes', kind: 'update', rowId: 30, rev: 1, payload: { body: '本文' }, at: 1, tries: 0, nextAt: 0 }
      setQueueRaw(JSON.stringify({ ver: 2, rows: { 'vitals@1|2026-09-01|routine': row }, legacyOps: [note] }))
      await DB.__testHooks.restartQueue()
      const box1 = JSON.parse(lsStore.get('cl_sendQueue'))
      assert.deepEqual(Object.keys(box1), ['ops'])
      assert.deepEqual(box1.ops.map((o) => o.qid), ['n9'])
      assert.equal(storedQueue().rows['vitals@1|2026-09-01|routine']?.edits.temp.value, 37.1)
    })

    it('#1 cl_sendQueue2 が読めない原文でも消さず、cl_sendQueue2 の brokenRaw に残す', async () => {
      setQueue2Raw('{broken')
      DB.__testHooks.setClient(offline().client)
      await DB.__testHooks.restartQueue()
      await DB.saveVitalEdits(ROUTINE, { temp: { value: 37.0, base: null } })
      const box2 = JSON.parse(lsStore.get('cl_sendQueue2'))
      assert.equal(box2.brokenRaw, '{broken')
      assert.ok(box2.rows['vitals@1|2026-09-01|routine'])
      assert.equal(DB.isQueueBroken(), true)
    })

    it('★R6 バイタル一括は、未送信件数の通知を受けたら pendingRow を引き直して「⚠ 未送信」を消す', () => {
      const src = readFileSync(new URL('../src/pages/VitalsGridPage.tsx', import.meta.url), 'utf8')
      const sub = src.slice(src.indexOf('unsub = queueSubscribe('), src.indexOf('unsub = queueSubscribe(') + 400)
      assert.match(sub, /settleQueuedRows\(/, '通知を受けても送信待ちの印を見直していない')
      assert.match(src, /const settleQueuedRows = useCallback\([\s\S]*?stillPending\(/)
    })
  })

  describe('★第4段（最終 critic の条件付き指摘 F1・F2・F4・F5）', () => {
    afterEach(async () => {
      await drainRows()
    })

    const mealIns = (qid, main) => ({
      qid,
      table: 'meals',
      kind: 'insert',
      payload: { resident_id: 1, meal_on: '2026-09-01', meal_slot: 'lunch', main_amount: main, recorded_by: 1 },
      at: 5,
      tries: 0,
      nextAt: 0,
    })

    it('★F1 旧ビルドで止まった（競合・拒否）食事・定時バイタルの op は、読み取りだけで自然キーへ付け替えて画面から見える', async () => {
      const srv = cellServer()
      srv.db.nextId = 70
      seedMeal(srv.db, { main_amount: 7 }) // id 70
      seedVital(srv.db, { pulse: 65 }) // id 71（定時）
      const mop = { qid: 'b1', table: 'meals', kind: 'update', rowId: 70, rev: 1, payload: { main_amount: 5 }, bases: { main_amount: 3 }, blocked: 'conflict', at: 1, tries: 1, nextAt: 0 }
      const vop = { qid: 'b2', table: 'vitals', kind: 'update', rowId: 71, rev: 1, payload: { pulse: 70 }, bases: { pulse: 60 }, blocked: 'rejected', at: 1, tries: 1, nextAt: 0 }
      setQueueRaw(JSON.stringify({ ops: [mop, vop] }))
      await DB.__testHooks.restartQueue()
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(srv.sends().length, 0, '止まった行を送った（書込をした）')
      const pm = DB.pendingRow('meals', LUNCH)
      assert.equal(pm?.state, 'conflict', '止まった食事が画面（自然キー）から見えない')
      assert.equal(pm?.values.main_amount, 5)
      const pv = DB.pendingRow('vitals', ROUTINE)
      assert.equal(pv?.state, 'rejected', '止まった定時バイタルが画面（自然キー）から見えない')
      assert.equal(pv?.values.pulse, 70)
      // 〔くらべて選ぶ〕の〔自分の値で直す〕で解決できる（基準＝取り直した最新）
      const res = await DB.saveMealEdits(LUNCH, { main_amount: { value: 5, base: 7 } }, { rebase: true })
      assert.deepEqual(res.applied, ['main_amount'])
      assert.equal(DB.pendingRow('meals', LUNCH), null)
    })

    it('F1 行が取り消されている時は #id のまま残し、未送信に数え続ける（消さない・読み直しは一度だけ）', async () => {
      const srv = cellServer()
      srv.db.nextId = 80
      seedMeal(srv.db, { main_amount: 7, deleted_at: '2026-09-01T00:00:00Z' }) // id 80（取り消し済み）
      const mop = { qid: 'b3', table: 'meals', kind: 'update', rowId: 80, rev: 1, payload: { main_amount: 5 }, bases: { main_amount: 3 }, blocked: 'conflict', at: 1, tries: 1, nextAt: 0 }
      setQueueRaw(JSON.stringify({ ops: [mop] }))
      await DB.__testHooks.restartQueue()
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      await DB.flushQueue(true)
      assert.ok(storedQueue().rows['meals#80'], '取り消された行への控えを消した')
      assert.equal(DB.queuePending(), 1)
      const reads = srv.calls.filter((q) => q.action === 'select' && q.table === 'meals').length
      assert.equal(reads, 1, `読み直しが一度で済んでいない: ${reads}`)
      assert.equal(srv.sends().length, 0)
    })

    it('★F2 新旧のタブ混在: 旧タブが同じ op に重ねた値（主食 8）は「送信済み」と判定せず、送信待ちに残して送る', async () => {
      const op5 = mealIns('q7', 5)
      setQueueRaw(JSON.stringify({ ops: [op5] }))
      await DB.__testHooks.restartQueue() // 新タブ: 読み替えて cl_sendQueue2 へ移す
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(srv.db.meals[0]?.main_amount, 5, '（前提）主食 5 を送った')
      // 旧タブ（メモリに op q7 を持ったまま）が同じ op に主食 8 を重ねて書き戻す
      headRoundTrip([{ ...op5, payload: { ...op5.payload, main_amount: 8 } }])
      await DB.flushQueue(true)
      const sent8 = srv.sends().some((q) => q.args.p_edits?.main_amount?.value === 8)
      assert.ok(sent8, '旧タブが重ねた 8 を送っていない（送信済みと判定して捨てた）')
      const p = DB.pendingRow('meals', LUNCH)
      assert.ok(srv.db.meals[0].main_amount === 8 || p?.values.main_amount === 8, '8 が黙って消えた')
    })

    it('F2 まだ送っていない前の値に旧タブが重ねた値は、後の入力として扱う（主食 8 → 5）', async () => {
      const op8 = mealIns('q8', 8)
      setQueueRaw(JSON.stringify({ ops: [op8] }))
      DB.__testHooks.setClient(offline().client)
      await DB.__testHooks.restartQueue() // 新タブ: 読み替えて cl_sendQueue2 へ（通信できないので送らない）
      assert.equal(DB.pendingRow('meals', LUNCH)?.values.main_amount, 8, '（前提）主食 8 が送信待ち')
      headRoundTrip([{ ...op8, payload: { ...op8.payload, main_amount: 5 } }]) // 旧タブが同じ op に 5 を重ねる
      await DB.flushQueue(true) // 書き戻し（読み直し → 和集合）
      assert.equal(DB.pendingRow('meals', LUNCH)?.values.main_amount, 5, '旧タブが後から重ねた値が、前の値に負けた')
      const srv = cellServer()
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.equal(srv.db.meals[0]?.main_amount, 5)
    })

    it('★F4 〔新しい行として保存〕は、その行の送信待ちの全ての欄を基準 null に置き換える（空にした欄は外す・メモは送る）', async () => {
      const srv = cellServer()
      const row = seedMeal(srv.db, { main_amount: 5, side_amount: 3, note: 'メモ' })
      DB.__testHooks.setClient(offline().client)
      await DB.saveMealEdits(LUNCH, {
        main_amount: { value: 7, base: 5 },
        side_amount: { value: null, base: 3 },
        note: { value: 'メモ2', base: 'メモ' },
      })
      row.deleted_at = '2026-09-01T00:00:00Z' // 他の端末が取り消した
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.ok(DB.pendingRow('meals', LUNCH)?.conflicts.every((c) => c.reason === 'missing'), '（前提）行が無い')
      // 画面は主食だけを出している
      const res = await DB.saveMealEdits(LUNCH, { main_amount: { value: 7, base: null } }, { rebase: true, asNew: true, fill: { recorded_by: 1 } })
      assert.deepEqual(res.conflicts, [], `missing で戻された: ${JSON.stringify(res.conflicts)}`)
      const live = srv.db.meals.filter((m) => m.deleted_at === null)
      assert.equal(live.length, 1)
      assert.deepEqual([live[0].main_amount, live[0].side_amount, live[0].note], [7, null, 'メモ2'])
      assert.equal(DB.pendingRow('meals', LUNCH), null)
    })

    it('★F4 〔新しい行として保存〕が通信できずに送信待ちになっても、同じ規則で保存される', async () => {
      const srv = cellServer()
      const row = seedVital(srv.db, { temp: 36.5, pulse: 60 })
      DB.__testHooks.setClient(offline().client)
      await DB.saveVitalEdits(ROUTINE, { temp: { value: null, base: 36.5 }, pulse: { value: 72, base: 60 } })
      row.deleted_at = '2026-09-01T00:00:00Z'
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      assert.ok(DB.pendingRow('vitals', ROUTINE)?.conflicts.every((c) => c.reason === 'missing'), '（前提）行が無い')
      DB.__testHooks.setClient(offline().client)
      assert.equal(await DB.saveVitalEdits(ROUTINE, { pulse: { value: 72, base: null } }, { rebase: true, asNew: true }), 'queued')
      DB.__testHooks.setClient(srv.client)
      await DB.flushQueue(true)
      const live = srv.db.vitals.filter((v) => v.deleted_at === null)
      assert.equal(live.length, 1, `新しい行ができていない: ${JSON.stringify(DB.pendingRow('vitals', ROUTINE))}`)
      assert.deepEqual([live[0].pulse, live[0].temp], [72, null])
      assert.equal(DB.pendingRow('vitals', ROUTINE), null)
    })

    it('★F4 画面の〔新しい行として保存〕は、同じ行を指す時 asNew で送る（食事2画面・定時バイタル2画面）', () => {
      for (const [p, fn] of [
        ['MealsGridPage.tsx', 'const onSaveNew'],
        ['MealsSheetPage.tsx', 'const saveMissingAsNew'],
        ['VitalsSheetPage.tsx', 'const saveAsNew'],
        ['VitalsGridPage.tsx', 'const saveAsNew'],
      ]) {
        const src = readFileSync(new URL(`../src/pages/${p}`, import.meta.url), 'utf8')
        const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 3500)
        assert.match(body, /asNew: true/, `${p} の〔新しい行として保存〕が asNew で送っていない`)
      }
    })

    it('★F5 定時以外の〔新しい行として保存〕は、新しい行の保存の後で元の送信待ちを外す（日報・バイタル2画面）', () => {
      for (const [p, fn] of [
        ['DailySheetPage.tsx', 'const saveOrphanAsNew'],
        ['VitalsSheetPage.tsx', 'const saveAsNew'],
        ['VitalsGridPage.tsx', 'const saveAsNew'],
      ]) {
        const src = readFileSync(new URL(`../src/pages/${p}`, import.meta.url), 'utf8')
        const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 3500)
        const save = body.indexOf('await saveVitalEdits(')
        const discard = body.indexOf('await discardPendingRow(')
        assert.ok(save > 0 && discard > save, `${p}: 新しい行を保存する前に元の送信待ちを外している`)
      }
    })
  })

  describe('★I7 再送のきっかけ（V1・V3）', () => {
    afterEach(async () => {
      await drainRows()
    })

    it('★V1: 通信断が続く間に続けて入力 → online で待ち時間を無視して送り、両方が1回で載る', async () => {
      setOnline(false)
      let off = true
      const srv = cellServer({ offline: () => off })
      seedVital(srv.db, { temp: 37.6, pulse: null })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.saveVitalEdits({ routine: false, id: 1 }, { temp: { value: 38.2, base: 37.6 } }), 'queued')
      assert.equal(await DB.saveVitalEdits({ routine: false, id: 1 }, { pulse: { value: 88, base: null } }), 'queued')
      setOnline(null)
      await DB.flushQueue(true) // 通信断の間の再送（画面復帰など）が失敗して、待ち時間（約30秒）が付いた
      const row = Object.values(storedQueue().rows)[0]
      assert.ok(row.nextAt > Date.now() + 20_000, '（前提）待ち時間が付いていない')
      off = false
      DB.onNetworkBack() // online イベント（待ち時間が残っていても送る）
      await settle()
      assert.equal(srv.db.vitals[0].temp, 38.2, 'online で送られなかった（待ち時間を守って止まった）')
      assert.equal(srv.db.vitals[0].pulse, 88)
      const sent = srv.sends()
      assert.equal(sent.at(-1).args.p_edits.temp.value, 38.2, '体温と脈拍が1回で送られていない')
      assert.equal(sent.at(-1).args.p_edits.pulse.value, 88)
      assert.equal(DB.queuePending(), 0)
    })

    it('online イベントは onNetworkBack（待ち時間を無視して送る）につないである', () => {
      const src = readFileSync(new URL('../src/lib/db.ts', import.meta.url), 'utf8')
      assert.match(src, /window\.addEventListener\('online', onNetworkBack\)/)
      assert.match(src, /export function onNetworkBack\(\): void \{\s*void flushQueue\(true\)/)
    })

    it('★navigator.onLine=false の間は、保存しても送信を試みない（待ち時間を増やさない）', async () => {
      setOnline(false)
      const off = offline()
      DB.__testHooks.setClient(off.client)
      assert.equal(await DB.saveVitalEdits(ROUTINE, { temp: { value: 38.2, base: null } }), 'queued')
      assert.equal(await DB.saveVitalEdits(ROUTINE, { pulse: { value: 88, base: null } }), 'queued')
      await settle()
      assert.equal(off.calls.filter((q) => q.action === 'rpc').length, 0, 'つながっていないのに送信を試みた')
      const row = Object.values(storedQueue().rows)[0]
      assert.equal(row.tries, 0, '待ち時間が延びた')
      assert.equal(row.nextAt, 0)
    })

    it('★待ち時間が明けたら、タイマーが自動で送り直す（重複して張らない）', async () => {
      const timers = []
      DB.__testHooks.setTimer({
        set: (fn, ms) => {
          const t = { fn, ms, cleared: false }
          timers.push(t)
          return t
        },
        clear: (t) => {
          t.cleared = true
        },
      })
      let off = true
      const srv = cellServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.saveVitalEdits(ROUTINE, { temp: { value: 38.2, base: null } }), 'queued') // 失敗 → 待ち時間
      await DB.flushQueue() // 待ち時間中（送らない）→ 同じ時刻のタイマーを張り直さない
      const live = timers.filter((t) => !t.cleared)
      assert.equal(live.length, 1, `タイマーが重複した: ${live.length}`)
      assert.ok(live[0].ms >= 29_000, `待ち時間より早い: ${live[0].ms}`)
      off = false
      // 待ち時間が明けた（タイマーが鳴った）。待ち時間の判定を通すため、行の nextAt を過去へ戻してから鳴らす
      const box = storedQueue()
      for (const r of Object.values(box.rows)) r.nextAt = 0
      setQueue2Raw(JSON.stringify({ ver: 2, rows: box.rows, done: box.done }))
      await DB.__testHooks.restartQueue()
      live[0].fn()
      await settle()
      assert.equal(srv.db.vitals[0]?.temp, 38.2, 'タイマーで送り直していない')
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

// ══════════════════════════════════════════════════════════════
// 食い違いの判定（src/lib/conflict.ts・2026-09-23 凍結仕様 フェーズ2 C）
//
// - 食い違いの列の抽出（conflictColumns）
// - 競合の行を通常の確定で保存しない規約（holdsNormalSave）。読み直した後の裁きは rowSync（reconcileOnLoad）側で検証する
// - 食事の「両方残す」のメモの追記文（appendAltMealNote）
// ══════════════════════════════════════════════════════════════

function registerConflictTests() {
  const F = ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2']
  const empty = { temp: null, sys_bp: null, dia_bp: null, pulse: null, spo2: null }

  describe('conflictColumns（食い違っている列の抽出）', () => {
    it('新規（base が空）で先に別の値が入っていた列は食い違い', () => {
      const cols = CF.conflictColumns(F, empty, { sys_bp: 130 }, { ...empty, sys_bp: 120 })
      assert.deepEqual(cols, [{ field: 'sys_bp', theirs: 120, mine: 130 }])
    })

    it('他端末が別の列だけを変えた時は食い違いなし（他の列が原因）', () => {
      const base = { ...empty, temp: 36.5, sys_bp: 120 }
      const latest = { ...empty, temp: 37.0, sys_bp: 120 }
      assert.deepEqual(CF.conflictColumns(F, base, { sys_bp: 130 }, latest), [])
    })

    it('既に同じ値が入っていれば食い違いなし', () => {
      assert.deepEqual(CF.conflictColumns(F, empty, { sys_bp: 130 }, { ...empty, sys_bp: 130 }), [])
    })

    it('先の値が空（サーバーが空いている）列は食い違いではない', () => {
      assert.deepEqual(CF.conflictColumns(F, empty, { pulse: 70 }, { ...empty, sys_bp: 120 }), [])
    })

    it('他端末が空にした列に自分が値を入れていたら食い違い', () => {
      const cols = CF.conflictColumns(F, { ...empty, sys_bp: 120 }, { sys_bp: 130 }, empty)
      assert.deepEqual(cols, [{ field: 'sys_bp', theirs: null, mine: 130 }])
    })

    it('自分が空にしようとした列を他端末が書き換えていたら食い違い（mine は null）', () => {
      const cols = CF.conflictColumns(F, { ...empty, temp: 36.5 }, { temp: null }, { ...empty, temp: 37.2 })
      assert.deepEqual(cols, [{ field: 'temp', theirs: 37.2, mine: null }])
    })

    it('数値と数字の文字列は同じ値として比べる', () => {
      assert.deepEqual(CF.conflictColumns(F, empty, { temp: 36.5 }, { ...empty, temp: '36.5' }), [])
    })

    it('並びは fields の順・食事の状態（文字列）も比べる', () => {
      const M = ['main_amount', 'side_amount', 'status']
      const base = { main_amount: null, side_amount: null, status: null }
      const cols = CF.conflictColumns(
        M,
        base,
        { status: 'refused', main_amount: 5 },
        { main_amount: 8, side_amount: null, status: 'eaten' },
      )
      assert.deepEqual(
        cols.map((c) => c.field),
        ['main_amount', 'status'],
      )
    })
  })

  describe('holdsNormalSave / patchForMine（競合の行を通常の確定で保存しない規約）', () => {
    it('★競合の行は通常の確定で保存しない', () => {
      assert.equal(CF.holdsNormalSave('conflict'), true)
    })

    it('競合以外の状態は通常どおり保存する', () => {
      for (const st of ['idle', 'saved', 'queued', 'error', 'invalid', 'saving', undefined, null]) {
        assert.equal(CF.holdsNormalSave(st), false, String(st))
      }
    })

    it('patchForMine は自分の列のうち、いまの値と違う列だけを送る', () => {
      const got = CF.patchForMine(F, { sys_bp: 130, pulse: 70 }, { ...empty, sys_bp: 120, pulse: 70 })
      assert.deepEqual(got, { sys_bp: 130 })
    })
  })

  describe('止まった食事の一言（先の値／あなたの入力）', () => {
    it('止まった食事の行でもサーバーの最新値を「先の値」として出す（再審 指摘2）', () => {
      assert.equal(
        CF.mealHeldText({ main_amount: 5 }, { main_amount: 8, side_amount: 6, status: 'eaten' }),
        '主食（先の値 8割／あなたの入力 5割）',
      )
      assert.equal(CF.mealHeldText({ main_amount: 8 }, { main_amount: 8 }), '')
    })
  })

  describe('利用者が編集した時刻（measured_at）も比べる・指摘 M2', () => {
    const FT = [...F, 'measured_at']
    it('時刻は時・分で比べる（DB の 09:05:00 と入力の 9:05 は同じ）', () => {
      assert.equal(CF.sameValue('09:05:00', '9:05'), true)
      assert.equal(CF.sameValue('09:05', '09:06'), false)
      assert.equal(CF.sameValue('120', 120), true) // 数値の比べ方は変わらない
    })
    it('編集した時刻を相手も変えていれば食い違い', () => {
      const cols = CF.conflictColumns(FT, { measured_at: '09:00:00' }, { measured_at: '09:30' }, { measured_at: '09:10:00' })
      assert.deepEqual(cols, [{ field: 'measured_at', theirs: '09:10:00', mine: '09:30' }])
    })
    it('時刻の表示は時:分', () => {
      assert.equal(CF.fmtTimeValue('09:30:00'), '9:30')
    })
  })

  describe('食い違いの併記（指摘 U1）', () => {
    it('先の値とあなたの入力を単位つきで並べる', () => {
      assert.equal(
        CF.vitalConflictDetail([{ field: 'sys_bp', theirs: 120, mine: 130 }]),
        '血圧（上）（先の値 120mmHg／あなたの入力 130mmHg）',
      )
    })
  })

  if (LG) {
    describe('leaveGuard（止まっている入力がある時の画面移動の確認・指摘 M1）', () => {
      it('登録した画面のどれかに止まっている入力があれば true、解除すれば数えない', () => {
        let held = false
        const off1 = LG.registerUnsaved(() => false)
        const off2 = LG.registerUnsaved(() => held)
        assert.equal(LG.hasUnsavedInput(), false)
        held = true
        assert.equal(LG.hasUnsavedInput(), true)
        off2()
        assert.equal(LG.hasUnsavedInput(), false)
        off1()
      })
      it('ブラウザの戻る・アドレスの書き換えで移ろうとした先を、画面の道筋に直す', () => {
        assert.equal(LG.hashToPath('#/record/vitals'), '/record/vitals')
        assert.equal(LG.hashToPath('#/'), '/')
        assert.equal(LG.hashToPath(''), '/')
      })
      it('判定で例外が出たら「ある」に倒す（黙って捨てない側）', () => {
        const off = LG.registerUnsaved(() => {
          throw new Error('x')
        })
        assert.equal(LG.hasUnsavedInput(), true)
        off()
      })
    })
  }

  describe('appendAltMealNote（食事の「両方残す」のメモ）', () => {
    it('メモが空なら1行だけ（主食・副食は「割」、状態はラベル、記入者名を括弧で）', () => {
      assert.equal(
        CF.appendAltMealNote(null, { main_amount: 5, side_amount: 6, status: 'eaten' }, '職員B'),
        '別の記入: 主食 5割・副食 6割・喫食（職員B）',
      )
    })

    it('★既存のメモは消さずに改行して書き足す', () => {
      assert.equal(
        CF.appendAltMealNote('むせ込みあり', { main_amount: 3 }, '職員B'),
        'むせ込みあり\n別の記入: 主食 3割（職員B）',
      )
    })

    it('既存のメモの空白・改行もそのまま残す', () => {
      assert.equal(CF.appendAltMealNote('  ', { side_amount: 0 }, '職員B'), '  \n別の記入: 副食 0割（職員B）')
    })

    it('値が無い項目は書かない（0割は値として書く）', () => {
      assert.equal(
        CF.appendAltMealNote('', { main_amount: 0, side_amount: null, status: null }, '職員B'),
        '別の記入: 主食 0割（職員B）',
      )
    })

    it('記入者が分からなければ「記入者不明」', () => {
      assert.equal(CF.appendAltMealNote(null, { status: 'refused' }, null), '別の記入: 拒食（記入者不明）')
      assert.equal(CF.appendAltMealNote(null, { status: 'refused' }, '  '), '別の記入: 拒食（記入者不明）')
    })

    it('書き足す値が1つも無ければ null（書き足さない）', () => {
      assert.equal(CF.appendAltMealNote('既存', { main_amount: null, side_amount: null, status: null }, '職員B'), null)
    })
  })

  describe('表示用の文字（記入者・値）', () => {
    const staff = [
      { id: 1, name: '職員A', active: true },
      { id: 2, name: '職員B', active: true },
    ]
    it('記入者は edited_by → recorded_by の順に名簿から引く', () => {
      assert.equal(CF.recorderName(2, 1, staff), '職員B')
      assert.equal(CF.recorderName(null, 1, staff), '職員A')
      assert.equal(CF.recorderName(99, 1, staff), '職員A')
    })
    it('どちらも引けなければ「記入者不明」', () => {
      assert.equal(CF.recorderName(null, null, staff), '記入者不明')
      assert.equal(CF.recorderName(99, 98, staff), '記入者不明')
      assert.equal(CF.recorderName(1, null, null), '記入者不明')
    })
    it('値は単位・割・状態ラベルつき。空は「未入力」', () => {
      assert.equal(CF.fmtVitalValue('temp', 36.5), '36.5℃')
      assert.equal(CF.fmtVitalValue('sys_bp', '130'), '130mmHg')
      assert.equal(CF.fmtVitalValue('spo2', null), '未入力')
      assert.equal(CF.fmtMealValue('main_amount', 5), '5割')
      assert.equal(CF.fmtMealValue('status', 'hospital'), '入院')
      assert.equal(CF.fmtMealValue('side_amount', null), '未入力')
    })
  })

  if (HV) {
    describe('変更の記録の表示（historyView）', () => {
      it('申し送りの本文は3行まで（それを超えると truncated）', () => {
        const r = HV.clampLines('1\n2\n3\n4')
        assert.equal(r.truncated, true)
        assert.equal(r.head, '1\n2\n3…')
        assert.deepEqual(HV.clampLines('1\n2\n3'), { head: '1\n2\n3', truncated: false })
      })
      it('1行が長すぎる時も切る', () => {
        const r = HV.clampLines('あ'.repeat(300))
        assert.equal(r.truncated, true)
        assert.equal(r.head.length, 241)
      })
      it('列名は日本語。内部の鍵は出さない', () => {
        assert.equal(HV.historyColumnLabel('vitals', 'sys_bp'), '血圧（上）')
        assert.equal(HV.historyColumnLabel('meals', 'main_amount'), '主食')
        assert.equal(HV.historyColumnLabel('notes', 'body'), '本文')
        assert.equal(HV.historyColumnLabel('vitals', 'client_key'), null)
        assert.equal(HV.historyColumnLabel('vitals', 'id'), null)
      })
      it('値は既存の書き方（割・単位・ラベル・職員名）', () => {
        const name = (id) => (id === 1 ? '職員A' : null)
        assert.equal(HV.fmtHistoryValue('meals', 'main_amount', 5, name), '5割')
        assert.equal(HV.fmtHistoryValue('vitals', 'temp', 37.2, name), '37.2℃')
        assert.equal(HV.fmtHistoryValue('vitals', 'recorded_by', 1, name), '職員A')
        assert.equal(HV.fmtHistoryValue('vitals', 'recorded_by', 5, name), '職員番号 5')
        assert.equal(HV.fmtHistoryValue('notes', 'shift', 'night', name), '夜勤')
        assert.equal(HV.fmtHistoryValue('notes', 'body', null, name), '（空）')
        assert.equal(HV.fmtHistoryValue('outings', 'end_on', '2026-09-01', name), '9/1（火）')
      })
    })
  }
}

// ══════════════════════════════════════════════════════════════
// 行の入力と保存の共通の仕組み（src/lib/rowSync.ts・構造規約 R-E〜R-G・2026-09-23 修正4巡目）
//
// critic の再現（scratchpad/r4）をそのままテストにする:
//   D … 編集中に背景の読み込みが走ると、最新の rev で相手の値を黙って上書きする（open_cell_refresh）
//   A … 食事: 保存中に押した別の欄が落ちる（meals_chain）
//   B … 日報: 保存中に確定した後の値が消え、「入力は消えていません」と嘘の表示になる（daily_held_race）
//   E … バイタル一括: 空き欄を埋めて保存した後、相手の体温が空欄に見え、次の保存で「消す」と判定する（grid_merge_buf）
//   T6 … 消す確認をキャンセルしても控えに消去が残る（確認を出してから控えに入れる）
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// 欄ごとの compare-and-set の契約（supabase/migrations/0011_apply_cell_edits.sql）
//
// tests/cell-contract.mjs の表を、JS の写し（偽のサーバー）で流す。同じ表は素の Postgres
// （0001〜0011 適用済み）でも流して expect と一致することを実測してある（第1段の検収）。
// 規則を変えたら、表・0011・写しの3つを一緒に直すこと（どれか1つだけ直すとここか実測で落ちる）。
// ══════════════════════════════════════════════════════════════

function registerCellContractTests() {
  describe('契約: apply_cell_edits（applied／settled／conflict／partial／missing／組）', () => {
    for (const c of CC.CELL_CONTRACT_CASES) {
      it(c.name, () => {
        const r = CC.runContractCaseOnFake(c)
        assert.deepEqual(r.mismatches, [], JSON.stringify(r.result))
      })
    }

    it('probe は何も書かずに {version:1, status:probe} を返す', () => {
      const db = CC.createCellDb()
      assert.deepEqual(CC.fakeApplyCellEdits(db, { p_table: 'probe', p_key: {}, p_edits: {} }), { version: 1, status: 'probe' })
    })
  })
}

function registerRowSyncTests() {
  const F = ['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2']
  const M = ['main_amount', 'side_amount', 'status']
  const tick = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 1行だけを持つ偽のサーバー（rev 照合つき・応答まで少し待つ）。行ごとの順番待ちの検証に使う */
  function slowServer(row) {
    const st = { row: { ...row }, sent: [] }
    st.update = async (rev, patch) => {
      await tick(20)
      st.sent.push({ rev, patch })
      if (rev !== st.row.rev) return 'conflict'
      st.row = { ...st.row, ...patch, rev: st.row.rev + 1 }
      return { ...st.row }
    }
    return st
  }

  /** 画面の保存の仕事を、共通の仕組みだけで組み立てたもの（5画面の saveOne / runSave と同じ手順） */
  function makeScreen(fields, server) {
    const scr = { edits: {}, saved: { ...server.row }, state: 'idle' }
    const queue = RS.createRowQueue()
    const job = async () => {
      const plan = RS.planEdits(fields, scr.edits, scr.saved)
      scr.edits = RS.withoutFields(scr.edits, plan.settled)
      if (plan.conflicts.length > 0) {
        scr.state = 'conflict'
        return
      }
      if (Object.keys(plan.send).length === 0) return
      const res = await server.update(scr.saved.rev, plan.send)
      if (res === 'conflict') {
        scr.state = 'conflict' // 編集は残す
        return
      }
      scr.saved = res
      scr.edits = RS.settleSent(scr.edits, plan.sendEdits, res)
      scr.state = RS.hasEdits(scr.edits) ? 'idle' : 'saved'
    }
    scr.commit = (field, value, base) => {
      scr.edits = RS.recordFieldEdit(scr.edits, field, value, base)
      return queue('row', job)
    }
    scr.load = (fresh) => {
      scr.saved = { ...fresh }
      const r = RS.reconcileOnLoad(fields, scr.edits, fresh)
      scr.edits = r.edits
      return r
    }
    return scr
  }

  describe('止まった行の入力の扱い（旧 R-A〜R-C を rowSync で確かめる）', () => {
    it('R-A 未保存の行で他端末が脈拍を 72 にしても、送るのは編集した血圧だけ（72 を 70 に巻き戻さない）', () => {
      const edits = RS.recordFieldEdit({}, 'sys_bp', 130, 120)
      const plan = RS.planEdits(F, edits, { temp: null, sys_bp: 120, dia_bp: null, pulse: 72, spo2: null })
      assert.deepEqual(plan.send, { sys_bp: 130 })
      assert.equal(plan.conflicts.length, 0)
    })

    it('R-B 値が実際に変わった編集だけを入れる（同じ値・書き方の違い・空欄を開いて閉じただけは入れない）', () => {
      assert.deepEqual(RS.recordFieldEdit({}, 'sys_bp', 120, 120), {})
      assert.deepEqual(RS.recordFieldEdit({}, 'temp', 36.5, '36.5'), {})
      assert.deepEqual(RS.recordFieldEdit({}, 'pulse', null, null), {})
      assert.deepEqual(RS.recordFieldEdit({}, 'pulse', '', null), {})
      assert.equal(RS.recordFieldEdit({}, 'sys_bp', 130, 120).sys_bp.value, 130)
      assert.equal(RS.recordFieldEdit({}, 'sys_bp', null, 120).sys_bp.value, null) // 空にした
    })

    it('R-B 日報の血圧: 上下を一緒に確定しても、変わった側だけを編集に入れる', () => {
      const shown = { sys_bp: 120, dia_bp: 80 }
      let edits = {}
      for (const [f, v] of Object.entries({ sys_bp: 130, dia_bp: 80 })) edits = RS.recordFieldEdit(edits, f, v, shown[f])
      assert.deepEqual(Object.keys(edits), ['sys_bp'])
    })

    it('★I8 L5: 血圧の上だけ食い違っても、下も送らずに組ごと競合（誰も測っていない組み合わせを作らない）', () => {
      let edits = RS.recordFieldEdit({}, 'sys_bp', 130, 120)
      edits = RS.recordFieldEdit(edits, 'dia_bp', 85, 80)
      const plan = RS.planEdits(F, edits, { sys_bp: 125, dia_bp: 80 })
      assert.deepEqual(plan.send, {}, '下だけ送ろうとした')
      assert.deepEqual(plan.conflicts.map((c) => c.field), ['sys_bp', 'dia_bp'])
      // くらべて選ぶの一覧も組で並べる
      const cols = CF.conflictColumns(F, { sys_bp: 120, dia_bp: 80 }, { sys_bp: 130, dia_bp: 85 }, { sys_bp: 125, dia_bp: 80 })
      assert.deepEqual(cols.map((c) => c.field), ['sys_bp', 'dia_bp'])
    })

    it('★I8 L4: 文字の欄は文字列として比べる（数値に変換しない）', () => {
      assert.equal(CF.sameField('symptom', '07', '7'), false)
      assert.equal(CF.sameField('note', '1.0', '1'), false)
      assert.equal(CF.sameField('symptom', '9:05', '09:05'), false, '文字の欄を時刻として比べた')
      assert.equal(CF.sameField('note', 7, '7.0'), false, '文字の欄を数値として比べた')
      assert.equal(CF.sameField('temp', '36.50', 36.5), true) // 数値の欄は従来どおり
      const e = RS.recordFieldEdit({}, 'symptom', '07', '7')
      assert.equal(e.symptom?.value, '07', '文字の欄の書き換えを「同じ値」として捨てた')
    })

    it('利用者が編集した時刻は、相手が他の欄だけを変えた時に未保存として残る（黙って捨てない）', () => {
      const FT = [...F, 'measured_at']
      const edits = RS.recordFieldEdit({}, 'measured_at', '09:30', '09:00:00')
      const r = RS.reconcileOnLoad(FT, edits, { temp: 37.0, measured_at: '09:00:00' })
      assert.equal(r.status, 'unsaved')
      assert.deepEqual(r.unsaved, ['measured_at'])
    })
  })

  describe('★F4: 血圧の片側を直したら、相方も「値＝基準」の編集として記録する（recordFieldEdit の pair）', () => {
    it('上だけ直す → 下も「いまの値のまま」として記録する（サーバーが組で確かめられる）', () => {
      const e = RS.recordFieldEdit({}, 'sys_bp', 130, 120, { base: 80 })
      assert.deepEqual([e.sys_bp.value, e.sys_bp.base], [130, 120])
      assert.deepEqual([e.dia_bp.value, e.dia_bp.base], [80, 80])
    })

    it('下だけ直しても上を記録する（組のどちら側でも）', () => {
      const e = RS.recordFieldEdit({}, 'dia_bp', 85, 80, { base: 120 })
      assert.deepEqual([e.sys_bp.value, e.sys_bp.base], [120, 120])
    })

    it('相方に既に編集があれば、その値と基準を保つ', () => {
      let e = RS.recordFieldEdit({}, 'dia_bp', 85, 80, { base: 120 })
      e = RS.recordFieldEdit(e, 'sys_bp', 130, 120, { base: 80 })
      assert.deepEqual([e.dia_bp.value, e.dia_bp.base], [85, 80])
      assert.deepEqual([e.sys_bp.value, e.sys_bp.base], [130, 120])
    })

    it('相方の値が空（未測定）でも「空のまま」として記録する', () => {
      const e = RS.recordFieldEdit({}, 'sys_bp', 130, null, { base: null })
      assert.deepEqual([e.dia_bp.value, e.dia_bp.base], [null, null])
    })

    it('値が変わらない確定（開いて閉じただけ）では、相方も記録しない', () => {
      assert.deepEqual(RS.recordFieldEdit({}, 'sys_bp', 120, 120, { base: 80 }), {})
    })

    it('pair を渡さない呼び出し（第1段の画面）は従来どおり相方を記録しない', () => {
      assert.deepEqual(Object.keys(RS.recordFieldEdit({}, 'sys_bp', 130, 120)), ['sys_bp'])
    })

    it('組でない欄に pair を渡しても何も足さない', () => {
      assert.deepEqual(Object.keys(RS.recordFieldEdit({}, 'pulse', 72, 70, { base: 80 })), ['pulse'])
    })
  })

  describe('★指摘 M1（食事）: 送信待ちにした値を表示に重ね、次の入力の基準にする', () => {
    // 画面の重ね方（サーバーの値に送信待ちの値を上から重ねる。MealsSheetPage・MealsGridPage の shown と同じ）
    const withQueued = (server, queued) => ({ ...server, ...(queued ?? {}) })

    it('★主食 5→7 を送信待ちにした後も 7 が見え、続けて 8 を押しても自分の値と競合しない', () => {
      const saved = { main_amount: 5, side_amount: null, status: null }
      let queued = null
      // 7 を押す（画面の値 5 が基準）→ 送信待ちになった
      let edits = RS.recordFieldEdit({}, 'main_amount', 7, 5)
      let plan = RS.planEdits(M, edits, withQueued(saved, queued))
      assert.deepEqual(plan.send, { main_amount: 7 })
      queued = { ...(queued ?? {}), ...plan.send }
      edits = RS.settleSent(edits, plan.sendEdits, withQueued(saved, queued))
      // 表示（サーバーの値＋送信待ち＋編集）に 7 が残る
      const shown = { ...withQueued(saved, queued), ...RS.editValues(edits) }
      assert.equal(shown.main_amount, 7, '送信待ちの値が表示から消えた')
      // 続けて 8 を押す（画面の値 7 が基準）→ 送信待ちの値と比べるので競合にしない
      edits = RS.recordFieldEdit(edits, 'main_amount', 8, shown.main_amount)
      plan = RS.planEdits(M, edits, withQueued(saved, queued))
      assert.equal(plan.conflicts.length, 0, '自分の送信待ちの値と食い違う扱いになった')
      assert.deepEqual(plan.send, { main_amount: 8 })
    })

  })

  describe('★指摘 M2（食事）: 〔元に戻す〕の基準は「自分が保存した後の値」', () => {
    it('★5→8 に上書きして保存。その間に他の端末が 6 にした → 元に戻す（5）は競合（6 を黙って上書きしない）', () => {
      const afterSave = { main_amount: 8, side_amount: null, status: null } // 自分が保存した後の値
      const before = { main_amount: 5 }
      let edits = {}
      for (const f of Object.keys(before)) edits = RS.recordFieldEdit(edits, f, before[f], afterSave[f])
      const plan = RS.planEdits(M, edits, { main_amount: 6, side_amount: null, status: null })
      assert.equal(plan.conflicts.length, 1)
      assert.deepEqual(plan.send, {})
    })

    it('他の端末が触っていなければ（8 のまま）そのまま戻せる', () => {
      const edits = RS.recordFieldEdit({}, 'main_amount', 5, 8)
      assert.deepEqual(RS.planEdits(M, edits, { main_amount: 8 }).send, { main_amount: 5 })
    })
  })

  describe('★指摘 L2: 読み込みの結果で、画面が持っている行より古い行（rev が小さい）に置き換えない', () => {
    it('★同じ行で rev が小さい応答は古い', () => {
      assert.equal(RS.isOlderRow({ id: 5, rev: 4 }, { id: 5, rev: 3 }), true)
    })
    it('同じ rev・新しい rev・別の行・未保存の行は置き換えてよい', () => {
      assert.equal(RS.isOlderRow({ id: 5, rev: 4 }, { id: 5, rev: 4 }), false)
      assert.equal(RS.isOlderRow({ id: 5, rev: 4 }, { id: 5, rev: 5 }), false)
      assert.equal(RS.isOlderRow({ id: 5, rev: 4 }, { id: 6, rev: 1 }), false)
      assert.equal(RS.isOlderRow({ id: null, rev: 0 }, { id: 5, rev: 1 }), false)
      assert.equal(RS.isOlderRow(null, { id: 5, rev: 1 }), false)
    })
  })

  describe('画面の配線（静的検査・第5巡の修正が5画面から外れていないこと）', () => {
    const src = (name) => readFileSync(new URL(`../src/pages/${name}`, import.meta.url), 'utf8')
    const PAGES = ['VitalsSheetPage.tsx', 'VitalsGridPage.tsx', 'MealsSheetPage.tsx', 'MealsGridPage.tsx', 'DailySheetPage.tsx']
    // フェーズ2' 第2段: 送信待ち → RPC の経路へ差し替えた画面（5画面とも差し替え済み）
    const MIGRATED = PAGES
    const VITAL_PAGES = ['VitalsSheetPage.tsx', 'VitalsGridPage.tsx', 'DailySheetPage.tsx']

    it('★第2段: 差し替えた画面の保存は saveVitalEdits／saveMealEdits だけ（旧 API・rev 照合・qids・blocked・resolves の分岐が無い）', () => {
      const OLD = /\b(insertVital|updateVital|insertVitalKind|insertMeal|updateMeal|blockedRowWrites|pendingRowWrites|resolveBlockedWrites|hasPendingWrite|adoptBlocked|sendBases|withQueued)\b|\bqids\b|resolves|=== 'blocked'/
      for (const p of MIGRATED) {
        const s = src(p)
        assert.match(s, /save(Vital|Meal)Edits\(/, p)
        const hit = s.split('\n').find((line) => OLD.test(line))
        assert.equal(hit, undefined, `${p} に旧い経路が残っている: ${hit}`)
      }
    })

    it('★第2段: 差し替えた画面は送信待ち・止まっている行を pendingRow から読む', () => {
      for (const p of MIGRATED) assert.match(src(p), /pendingRow\('(vitals|meals)'/, p)
    })

    it('★第2段: 差し替えた画面は 0011 が無い時（cells:missing）に入力を止めて「サーバー側の更新待ち」を出す', () => {
      for (const p of MIGRATED) {
        const s = src(p)
        assert.match(s, /gate\.cells === 'missing'/, p)
        assert.match(s, /CELLS_PENDING_REASON/, p)
      }
    })

    it('★第2段: 差し替えた画面は、行が取り消されていた控え（missing）に〔新しい行として保存〕〔取り下げる〕を出す', () => {
      for (const p of MIGRATED) {
        const s = src(p)
        assert.match(s, /新しい行として保存/, p)
        assert.match(s, /取り下げる/, p)
      }
    })

    it('★F4: 差し替えたバイタルの画面は、血圧のセルで recordFieldEdit に相方（pair）を渡す', () => {
      for (const p of MIGRATED.filter((x) => VITAL_PAGES.includes(x))) {
        assert.match(src(p), /pairOf\(/, p)
        assert.match(src(p), /recordFieldEdit\([^\n]*\{ base: /, p)
      }
    })

    it('★L2: くらべて選ぶの送信は5画面とも runResolverJob を通す（順番待ち・自分の書込の印・キューの止まった分）', () => {
      for (const p of PAGES) assert.match(src(p), /serialize=\{[^}]*runResolverJob\(/, p)
    })

    it('★L2: 読み込みで古い rev の行に置き換えない防御が5画面にある', () => {
      for (const p of PAGES) assert.match(src(p), /isOlderRow\(/, p)
    })

    it('★L2: 背景の取り直しが走る2画面は、くらべて選ぶの送信にも自分の書込の印を付ける', () => {
      const vs = src('VitalsSheetPage.tsx')
      assert.match(vs, /const runRowJob = useCallback\([\s\S]*?savingRef\.current\.add\(key\)[\s\S]*?selfWriteRef\.current = Date\.now\(\)/)
      assert.match(vs, /const runResolverJob = useCallback\([\s\S]*?runRowJob\(key/)
      const ms = src('MealsSheetPage.tsx')
      assert.match(ms, /const runResolverJob = useCallback\([\s\S]*?resolverBusyRef\.current \+= 1[\s\S]*?selfWriteRef\.current = Date\.now\(\)/)
      assert.match(ms, /resolverBusyRef\.current > 0\) \{\s*schedule\(\)/)
    })

    it('★M1: 食事2画面は送信待ちにした値を表示に重ねて持ち続ける（差し替えた画面は送信待ちの値＋pendingRow から重ねる）', () => {
      for (const p of ['MealsSheetPage.tsx', 'MealsGridPage.tsx']) {
        const s = src(p)
        assert.match(s, /\.\.\.\(phase === 'queued' \? \(queuedRef\.current\[key\] \?\? \{\}\) : \{\}\)/, p)
        assert.match(s, /pendingRow\('meals', /, p)
        assert.match(s, /queuedRef\.current\[key\] = \{ \.\.\.\(queuedRef\.current\[key\] \?\? \{\}\), \.\.\.send \}/, p)
      }
    })

    it('★M2: 食事2画面の〔元に戻す〕は保存後の値を基準に渡す', () => {
      assert.match(src('MealsSheetPage.tsx'), /saveMealRef\.current\(t, before, true, afterSave\)/)
      assert.match(src('MealsGridPage.tsx'), /saveMealRef\.current\(residentId, before, slotAt, true, afterSave\)/)
    })

  })

  describe('★構造規約 R-E（欄ごとの基準）', () => {
    it('再現 D: 脈拍 70 を開いている間に相手が 72 にした（背景の読み込みで saved/rev は最新）→ 75 を確定しても送らず競合', async () => {
      const server = slowServer({ id: 9, rev: 4, temp: 36.5, sys_bp: 120, dia_bp: 80, pulse: 70, spo2: 97 })
      const scr = makeScreen(F, server)
      const baseAtOpen = 70 // セルを開いた時に出ていた値
      server.row = { ...server.row, pulse: 72, rev: 5 } // 相手が保存
      scr.load(server.row) // 背景の読み込み（基準は動かない）
      await scr.commit('pulse', 75, baseAtOpen)
      assert.equal(scr.state, 'conflict')
      assert.deepEqual(server.sent, [], '相手の 72 を知らないまま 75 を送った')
      assert.equal(server.row.pulse, 72)
      assert.equal(scr.edits.pulse.value, 75, '入力が消えた')
    })

    it('再現 D の裏: 開いて何も打たずに閉じたら、背景で値が変わっていても古い値を確定しない', () => {
      const edits = RS.recordFieldEdit({}, 'pulse', 70, 70) // 開いた時 70・閉じた時も 70
      assert.deepEqual(edits, {})
    })

    it('止まっている欄の基準は、背景の読み込みでも利用者の再編集でも書き換えない', () => {
      let e = RS.recordFieldEdit({}, 'sys_bp', 130, 120)
      e = RS.recordFieldEdit(e, 'sys_bp', 135, 999) // 再編集（その時の表示は自分の値）
      assert.equal(e.sys_bp.base, 120)
      assert.equal(e.sys_bp.value, 135)
      const r = RS.reconcileOnLoad(F, e, { sys_bp: 120, pulse: 72 }) // 読み込み
      assert.equal(r.edits.sys_bp.base, 120)
      assert.equal(r.status, 'unsaved')
    })

    it('送る時はサーバーの値が基準のままの欄だけを送る（相手が変えた欄を巻き戻さない）', () => {
      const e = RS.recordFieldEdit({}, 'sys_bp', 130, 120)
      const plan = RS.planEdits(F, e, { sys_bp: 120, pulse: 72 })
      assert.deepEqual(plan.send, { sys_bp: 130 })
      assert.deepEqual(plan.conflicts, [])
    })

    it('もう同じ値が載っている欄は送らずに消す（settled）', () => {
      const e = RS.recordFieldEdit({}, 'sys_bp', 130, 120)
      const plan = RS.planEdits(F, e, { sys_bp: 130 })
      assert.deepEqual(plan.settled, ['sys_bp'])
      assert.deepEqual(plan.send, {})
    })
  })

  describe('★構造規約 R-F（行ごとの直列化と欄単位の消し込み）', () => {
    it('再現 A（食事）: 主食 5 を保存中に副食 6 を押しても落ちない（後の仕事が最新の rev で副食だけ送る）', async () => {
      const server = slowServer({ id: 1, rev: 3, main_amount: 7, side_amount: null, status: null })
      const scr = makeScreen(M, server)
      const p1 = scr.commit('main_amount', 5, 7)
      await tick(5)
      const p2 = scr.commit('side_amount', 6, null) // 保存中に押した
      await Promise.all([p1, p2])
      assert.deepEqual(server.sent, [
        { rev: 3, patch: { main_amount: 5 } },
        { rev: 4, patch: { side_amount: 6 } },
      ])
      assert.equal(server.row.main_amount, 5)
      assert.equal(server.row.side_amount, 6)
      assert.equal(RS.hasEdits(scr.edits), false)
      assert.equal(scr.state, 'saved')
    })

    it('再現 B（日報）: 保存中に確定した脈拍が消えず、同じ rev で送って競合にもならない', async () => {
      const server = slowServer({ id: 5, rev: 7, temp: 37.8, sys_bp: 120, dia_bp: 80, pulse: 70, spo2: 96 })
      const scr = makeScreen(F, server)
      scr.edits = RS.recordFieldEdit({}, 'temp', 38.2, 37.8) // 未保存の控え
      const p1 = scr.commit('spo2', 95, 96)
      await tick(5)
      const p2 = scr.commit('pulse', 88, 70) // 保存中に確定
      await Promise.all([p1, p2])
      assert.ok(server.sent.every((x) => x !== 'conflict'))
      assert.equal(server.sent.length, 2)
      assert.equal(server.sent[1].rev, 8, '古い rev で送った（競合になる）')
      assert.deepEqual({ temp: server.row.temp, spo2: server.row.spo2, pulse: server.row.pulse }, { temp: 38.2, spo2: 95, pulse: 88 })
      assert.equal(scr.state, 'saved')
    })

    it('送った後に同じ欄を書き換えたら、その欄は消さずに基準を「保存できた値」へ持ち直す', () => {
      let e = RS.recordFieldEdit({}, 'pulse', 75, 70)
      const plan = RS.planEdits(F, e, { pulse: 70 })
      e = RS.recordFieldEdit(e, 'pulse', 80, 999) // 応答待ちの間に書き換え
      const after = RS.settleSent(e, plan.sendEdits, { pulse: 75 })
      assert.equal(after.pulse.value, 80)
      assert.equal(after.pulse.base, 75, '自分の保存を他端末の変更と取り違える')
    })

    it('再審 low-1: 保存中に打った「消す」（空欄）も落とさない', () => {
      let e = RS.recordFieldEdit({}, 'pulse', 75, 70)
      const plan = RS.planEdits(F, e, { pulse: 70 })
      e = RS.recordFieldEdit(e, 'pulse', null, 999) // 保存中に空にした
      const after = RS.settleSent(e, plan.sendEdits, { pulse: 75 })
      assert.ok(after.pulse, '空にする入力が落ちた')
      assert.equal(after.pulse.value, null)
      // 送っていない欄の「消す」も残る
      let e2 = RS.recordFieldEdit({}, 'temp', 36.5, null)
      const plan2 = RS.planEdits(F, e2, { temp: null, spo2: 97 })
      e2 = RS.recordFieldEdit(e2, 'spo2', null, 97)
      const after2 = RS.settleSent(e2, plan2.sendEdits, { temp: 36.5, spo2: 97 })
      assert.equal(after2.spo2.value, null)
      assert.equal('temp' in after2, false)
    })

    it('行ごとの順番待ちは、同じ行の仕事を順に1つずつ動かす（前が失敗しても次は動く）', async () => {
      const q = RS.createRowQueue()
      const log = []
      const a = q('r1', async () => {
        await tick(15)
        log.push('a')
        throw new Error('x')
      })
      const b = q('r1', async () => {
        log.push('b')
      })
      const c = q('r2', async () => {
        log.push('c')
      })
      await Promise.all([a, b, c])
      assert.deepEqual(log, ['c', 'a', 'b'])
    })
  })

  describe('★再現 E（バイタル一括）: 空き欄を埋めて保存した後', () => {
    it('触っていない体温はサーバーの値で描き直し、次の保存で「消す」と判定しない', () => {
      // 自分: 血圧だけを入れた新しい行（まだ id が無い＝基準は空）。相手が先に体温 36.8 の行を作っていた
      let e = RS.recordFieldEdit({}, 'sys_bp', 130, null)
      e = RS.recordFieldEdit(e, 'dia_bp', 80, null)
      const plan = RS.planEdits(F, e, {})
      // 送信は 23505 → 空き欄だけ埋める載せ直し。応答は相手の体温を含む行
      const res = { temp: 36.8, sys_bp: 130, dia_bp: 80, pulse: null, spo2: null }
      const remain = RS.settleSent(e, plan.sendEdits, res)
      assert.equal(RS.hasEdits(remain), false)
      // 次の保存（別の欄に触れた後）: 送るのは edits の欄だけ＝体温を消す差分は出ない
      const next = RS.planEdits(F, RS.recordFieldEdit(remain, 'pulse', 72, null), res)
      assert.deepEqual(next.send, { pulse: 72 })
      assert.equal('temp' in next.send, false)
    })
  })

  describe('★T6（日報）: 消す確認は控えに入れる前に出す', () => {
    it('消す欄は「どの欄の何の値を消すか」を確認文に出せる（表示中の値つき）', () => {
      const shown = { temp: 37.2, sys_bp: 120, dia_bp: 80 }
      const e = RS.recordFieldEdit({}, 'temp', null, shown.temp)
      assert.equal(e.temp.value, null)
      assert.equal(CF.fmtVitalValue('temp', shown.temp), '37.2℃')
    })
    it('確認が要る欄（表示中の値を今回新しく空にした欄）だけを挙げる', () => {
      const shown = { temp: 37.2, sys_bp: 120, dia_bp: 80, spo2: null }
      const prev = RS.recordFieldEdit({}, 'pulse', 88, 70) // 前からある控え（確認済み）
      let next = RS.recordFieldEdit(prev, 'temp', null, shown.temp)
      next = RS.recordFieldEdit(next, 'spo2', null, shown.spo2) // 空欄を空のまま（そもそも入らない）
      next = RS.recordFieldEdit(next, 'sys_bp', 130, shown.sys_bp)
      assert.deepEqual(RS.newlyClearedFields(prev, next, shown), ['temp'])
    })
    it('キャンセルした時は控えに入れない＝〔保存し直す〕で同じ確認が繰り返されない', () => {
      // 画面は newlyClearedFields が空でなければ確認を出し、「消す」を押した時だけ next を控えに書く。
      // キャンセルは prev のまま（消去は控えに残らない）
      const shown = { temp: 37.2 }
      const prev = {}
      const next = RS.recordFieldEdit(prev, 'temp', null, shown.temp)
      assert.deepEqual(RS.newlyClearedFields(prev, next, shown), ['temp'])
      const afterCancel = prev
      assert.equal(RS.hasEdits(afterCancel), false)
      assert.deepEqual(RS.newlyClearedFields(afterCancel, afterCancel, shown), [])
    })
  })

  describe('読み直しの共通の裁き（reconcileOnLoad）と R-G', () => {
    it('食い違い→conflict／送る欄→unsaved／全部載っている→clean', () => {
      const e = RS.recordFieldEdit({}, 'sys_bp', 130, 120)
      assert.equal(RS.reconcileOnLoad(F, e, { sys_bp: 125 }).status, 'conflict')
      assert.equal(RS.reconcileOnLoad(F, e, { sys_bp: 120 }).status, 'unsaved')
      assert.equal(RS.reconcileOnLoad(F, e, { sys_bp: 130 }).status, 'clean')
    })
    it('行が見当たらない（fresh=null）時は基準を空にして未保存（新しい行として保存し直せる）', () => {
      const e = RS.recordFieldEdit({}, 'sys_bp', 130, 120)
      const r = RS.reconcileOnLoad(F, e, null)
      assert.equal(r.status, 'unsaved')
      assert.equal(r.edits.sys_bp.base, null)
    })
    it('R-G: 1欄でも編集が残っていれば数える（保存中・送信待ちの後に打った値を含む）', () => {
      assert.equal(RS.hasEdits({}), false)
      assert.equal(RS.hasEdits(undefined), false)
      assert.equal(RS.hasEdits(RS.recordFieldEdit({}, 'pulse', 88, 70)), true)
    })
    it('くらべて選ぶ画面の「見ていた値」は欄ごとの基準（編集の無い欄はサーバーの値）', () => {
      const e = RS.recordFieldEdit({}, 'sys_bp', 130, 120)
      assert.deepEqual(RS.editBases(e, { sys_bp: 125, pulse: 72 }), { sys_bp: 120, pulse: 72 })
      assert.deepEqual(RS.editValues(e), { sys_bp: 130 })
    })
  })

  if (LG) {
    describe('戻る・進むを止めた時の履歴の位置（再審 low-3）', () => {
      it('react-router が history.state に持たせる位置（idx）を読む', () => {
        assert.equal(LG.historyIndex({ idx: 3, key: 'x' }), 3)
        assert.equal(LG.historyIndex(null), null)
        assert.equal(LG.historyIndex({ usr: null }), null)
      })
    })
  }
}
