// カルテの排泄欄・今日の要注意の「排便なし◯日」（排便記録アプリの記録を読むだけ）の試験。2026-10-16 追加。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 接続設定（偽の localStorage）: 主キー・予備のキー・無い時・GAS 以外の宛先・書き込み0
// 2. 応答の正規化: 壊れた値は捨てる・pads 列の有無・メモ／記入者を持たない・職員の控えを除く・TZ 付きの日時・16日より前を捨てる
// 3. 照合（氏名＋居室）: 照合できる・空白の違い・同じ氏名（どちら側でも）・居室違い・見つからない・退居・非表示
// 4. 判定と一覧: 直近14日に排便1回分が無い時は下限「◯日以上」・一覧14日・排尿の回数・下剤
// 5. 取得（偽の fetch）: POST 本文だけに合言葉・since・失敗の種類（合言葉違い＝403）・タイムアウト・メモリの控え・取り直し
// 6. 今日の要注意へ足す理由（並び・注意／危険・照合できない人数）
// 7. 静的な見張り: 書き込みの action を呼ばない・localStorage に書かない・console を使わない・画面は hbcr_ を直書きしない
// 個人情報は置かない（入居者は 利用者01 などの記号・接続先と合言葉はダミー）。

import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

// 排便記録アプリも care-log も日本時間の端末で動く（記録の日時は端末の時刻として読む）。CI（UTC）でも同じ答えにするため、
// この試験のプロセスだけ日本時間にする（node --test は試験のファイルごとに別のプロセス）
process.env.TZ = 'Asia/Tokyo'

const TS_UNSUPPORTED =
  'この Node では TypeScript を直接読み込めないため、排泄の検証をスキップしました（Node 22.18 以降で実行してください）。'

let X = null
let loadErr = null
try {
  X = await import('../src/lib/excretionClient.ts')
} catch (e) {
  X = null
  loadErr = e
}
if (X === null) registerLoadFailure('排泄（排便記録の読み取り）の検証', loadErr, TS_UNSUPPORTED)

let AM = null
let amErr = null
try {
  AM = await import('../src/pages/alertsModel.ts')
} catch (e) {
  AM = null
  amErr = e
}
if (AM === null) registerLoadFailure('今日の要注意の部品（排便）', amErr, TS_UNSUPPORTED)

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

// ── 偽の localStorage（書き込みを数える） ──
const store = new Map()
let writes = 0
const realLS = globalThis.localStorage
const realFetch = globalThis.fetch
function installLS(entries = {}) {
  store.clear()
  writes = 0
  for (const [k, v] of Object.entries(entries)) store.set(k, v)
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: () => {
      writes++
    },
    removeItem: () => {
      writes++
    },
    clear: () => {
      writes++
    },
    key: () => null,
    get length() {
      return store.size
    },
  }
}

const DUMMY_URL = 'https://script.google.com/macros/s/DUMMY-HAIBEN/exec'
const DUMMY_TOKEN = 'dummy-haiben-token'
const H1 = 3600 * 1000
const pad = (n) => String(n).padStart(2, '0')
const dtOf = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** care-log の利用者（合成） */
const CL = [
  { id: 1, name: '利用者01', room: '101', active: true },
  { id: 2, name: '利用者 02', room: '102', active: true },
  { id: 3, name: '利用者03', room: '103', active: true },
  { id: 4, name: '利用者04', room: '104', active: true },
  { id: 5, name: '利用者05', room: '105', active: true },
  { id: 6, name: '利用者05', room: '106', active: true }, // care-log 側で同じ氏名
  { id: 7, name: '利用者07', room: '107', active: true },
  { id: 8, name: '利用者08', room: '108', active: false }, // 退居
]
/** 排便記録の入居者（サーバーの形） */
const HB_RES = [
  { id: 11, name: '利用者01', yomi: '', room: '101', active: true, hidden: false, cfg: '' },
  { id: '12', name: '利用者　02', room: '１０２', active: 'TRUE', cfg: '{"stoolWarnD":1,"stoolDangerD":2}' }, // 全角空白・全角数字
  { id: 13, name: '利用者03', room: '203', active: true }, // 居室違い
  { id: 14, name: '利用者04', room: '104', active: true },
  { id: 15, name: '利用者04', room: '204', active: true }, // 排便記録側で同じ氏名
  { id: 16, name: '利用者05', room: '105', active: true },
  { id: 17, name: '利用者08', room: '108', active: true },
  { id: 18, name: '利用者07', room: '107', active: false }, // 排便記録で退居
  { id: 19, name: '職員01', room: 'STAFF', active: true }, // 職員の控えの行
]

describe('接続設定（読むだけ）', { skip: X === null ? TS_UNSUPPORTED : false }, () => {
  afterEach(() => {
    globalThis.localStorage = realLS
  })
  it('主キーの URL と合言葉を読む・書かない', () => {
    installLS({ hbcr_api_url: DUMMY_URL, hbcr_api_token: DUMMY_TOKEN })
    assert.deepEqual(X.readExcretionConfig(), { url: DUMMY_URL, token: DUMMY_TOKEN })
    assert.equal(writes, 0)
  })
  it('主キーが空なら排便記録アプリの予備のキー（_bak・_bak2）を読む', () => {
    installLS({ hbcr_api_url_bak2: DUMMY_URL, hbcr_api_token_bak: DUMMY_TOKEN })
    assert.deepEqual(X.readExcretionConfig(), { url: DUMMY_URL, token: DUMMY_TOKEN })
    assert.equal(writes, 0)
  })
  it('URL か合言葉が無い端末は未設定（null）', () => {
    installLS({})
    assert.equal(X.readExcretionConfig(), null)
    installLS({ hbcr_api_url: DUMMY_URL })
    assert.equal(X.readExcretionConfig(), null)
    installLS({ hbcr_api_token: DUMMY_TOKEN })
    assert.equal(X.readExcretionConfig(), null)
    assert.match(X.MSG_EXCRETION_UNCONFIGURED, /この端末には排便記録の接続設定がありません（排便記録のアプリで設定した端末で見られます）/)
  })
  it('GAS 以外の宛先は invalid（合言葉を送らない）', () => {
    installLS({ hbcr_api_url: 'https://example.com/exec', hbcr_api_token: DUMMY_TOKEN })
    assert.equal(X.readExcretionConfig(), 'invalid')
  })
  it('localStorage が使えない環境でも例外を出さず null', () => {
    globalThis.localStorage = {
      getItem() {
        throw new Error('denied')
      },
    }
    assert.equal(X.readExcretionConfig(), null)
  })
})

describe('応答の正規化', { skip: X === null ? TS_UNSUPPORTED : false }, () => {
  it('壊れた値を捨て、判定と一覧に要る項目だけを持つ（メモ・記入者・pads は持たない）', () => {
    const snap = X.parseExcretionPayload({
      residents: [...HB_RES, null, 'x', { id: '', name: 'A' }, { id: 30, name: 123 }],
      records: [
        { id: 'a1', residentId: 11, type: 'stool', date: '2026-10-15', time: '09:30', datetime: '2026-10-15T09:30', stoolAmt: '中等量', consistency: '普通', notes: 'メモ', staff: '職員01', pads: '{"パッド":1}' },
        { id: 'a2', residentId: '11', type: 'urine', date: '2026-10-15', time: '10:00', datetime: '2026-10-15T10:00', notes: 'メモ', staff: '職員01' },
        { id: 'a3', residentId: 11, type: 'laxative', date: '2026-10-15', time: '21:00', datetime: '2026-10-15T21:00', medicine: '下剤A', tablets: 2 },
        { id: 'a4', residentId: 11, type: 'water', date: '2026-10-15', time: '10:00' }, // 対象外の種類
        { id: 'sys_staffs_snapshot_v1', residentId: 11, type: 'laxative', date: '2026-10-15', medicine: '_SYS_STAFFS_SNAPSHOT_' },
        { id: 'a5', residentId: 11, type: 'stool', date: '', datetime: '' }, // 日付なし
        { id: 'a6', residentId: null, type: 'stool', date: '2026-10-15' },
        { residentId: 11, type: 'stool', date: '2026-10-15' }, // id なし
        null,
        42,
      ],
      cfg: { stoolWarnD: 'x', stoolDangerD: 4, urineWarnH: 6 },
    })
    assert.deepEqual(snap.residents.map((r) => r.id), ['11', '12', '13', '14', '15', '16', '17', '18'])
    // 表示用の氏名（name）は持たない。照合のための空白を除いたキーだけ
    assert.equal(snap.residents.every((r) => !('name' in r) && !('yomi' in r)), true)
    assert.equal(snap.residents[0].key, '利用者01')
    assert.equal(snap.residents[1].key, '利用者02')
    assert.deepEqual(snap.residents[1].cfg, { stoolWarnD: 1, stoolDangerD: 2 })
    assert.deepEqual(snap.residents[0].cfg, {})
    assert.deepEqual(snap.cfg, { stoolWarnD: 2, stoolDangerD: 4 }) // 数でない値は既定のまま
    const recs = snap.recs.get('11')
    assert.deepEqual(recs.map((r) => r.id), ['a1', 'a2', 'a3'])
    const all = JSON.stringify([...snap.recs.values()])
    assert.equal(all.includes('メモ'), false)
    assert.equal(all.includes('職員01'), false)
    assert.equal(all.includes('パッド'), false)
    assert.equal(recs[0].cons, '普通')
    assert.equal(recs[2].medicine, '下剤A')
    assert.equal(recs[2].tablets, '2')
    assert.equal(typeof recs[0].tsUTC, 'number')
  })

  it('pads 列があっても無くても同じ結果', () => {
    const base = { id: 'p1', residentId: 11, type: 'stool', date: '2026-10-15', time: '09:00', datetime: '2026-10-15T09:00', stoolAmt: '多量' }
    const a = X.parseExcretionPayload({ residents: HB_RES, records: [base] })
    const b = X.parseExcretionPayload({ residents: HB_RES, records: [{ ...base, pads: '{"尿取りパッド":2}' }] })
    assert.deepEqual([...a.recs], [...b.recs])
  })

  it('TZ 付きの日時は端末の時刻へ・日時が無ければ日付＋時刻から・時刻だけ数で届いた記録も壊れない', () => {
    const z = new Date(Date.UTC(2026, 9, 15, 0, 30))
    const snap = X.parseExcretionPayload({
      residents: HB_RES,
      records: [
        { id: 'z1', residentId: 11, type: 'stool', date: '2026-10-15', datetime: z.toISOString(), stoolAmt: '多量' },
        { id: 'z2', residentId: 11, type: 'stool', date: '2026-10-15', time: '07:05:00', stoolAmt: '多量' },
        { id: 'z3', residentId: 11, type: 'stool', date: '2026-10-15', time: 0.5, datetime: 12345, stoolAmt: '多量' },
      ],
    })
    const recs = snap.recs.get('11')
    const byId = Object.fromEntries(recs.map((r) => [r.id, r]))
    assert.equal(byId.z1.datetime, dtOf(z.getTime()))
    assert.equal(byId.z2.datetime, '2026-10-15T07:05')
    assert.equal(byId.z3.datetime, '')
    assert.equal(byId.z3.time, '')
  })

  it('keepFrom より前の日付の記録は捨てる（数える範囲を一定にする）', () => {
    const snap = X.parseExcretionPayload(
      {
        residents: HB_RES,
        records: [
          { id: 'o1', residentId: 11, type: 'stool', date: '2026-09-01', datetime: '2026-09-01T09:00', stoolAmt: '多量' },
          { id: 'o2', residentId: 11, type: 'stool', date: '2026-10-01', datetime: '2026-10-01T09:00', stoolAmt: '多量' },
        ],
      },
      '2026-09-30',
    )
    assert.deepEqual(snap.recs.get('11').map((r) => r.id), ['o2'])
  })

  it('同じ id の行が2つ届いたら後の行の1件にする', () => {
    const snap = X.parseExcretionPayload({
      residents: HB_RES,
      records: [
        { id: 'd1', residentId: 11, type: 'stool', date: '2026-10-15', datetime: '2026-10-15T09:00', stoolAmt: '少量' },
        { id: 'd1', residentId: 11, type: 'stool', date: '2026-10-15', datetime: '2026-10-15T09:00', stoolAmt: '多量' },
      ],
    })
    assert.deepEqual(snap.recs.get('11').map((r) => r.stoolAmt), ['多量'])
  })
})

describe('照合（氏名＋居室・決定 2026-10-16）', { skip: X === null ? TS_UNSUPPORTED : false }, () => {
  const snap = X ? X.parseExcretionPayload({ residents: HB_RES, records: [] }) : null
  const m = (id) => X.matchExcretionResident(CL.find((r) => r.id === id), CL, snap.residents)

  it('氏名と居室が両方一致した方だけ結ぶ', () => {
    const r = m(1)
    assert.equal(r.ok, true)
    assert.equal(r.hb.id, '11')
  })
  it('氏名の空白（半角・全角）の違いと、居室の全角数字は吸収する', () => {
    const r = m(2)
    assert.equal(r.ok, true)
    assert.equal(r.hb.id, '12')
  })
  it('居室が食い違えば結ばない（排便記録の居室を理由に出す）', () => {
    const r = m(3)
    assert.deepEqual([r.ok, r.reason], [false, 'roomMismatch'])
    assert.match(X.excretionMatchMessage(r), /^排便記録と照合できません（居室が食い違っています。排便記録の居室は「203」です）$/)
  })
  it('排便記録に同じ氏名が2人以上なら結ばない（居室が一致する方がいても）', () => {
    const r = m(4)
    assert.deepEqual([r.ok, r.reason], [false, 'dupHaiben'])
    assert.match(X.excretionMatchMessage(r), /排便記録に同じお名前の方が2人以上います/)
  })
  it('care-log に同じ氏名が2人以上なら結ばない', () => {
    assert.deepEqual([m(5).ok, m(5).reason], [false, 'dupCareLog'])
    assert.deepEqual([m(6).ok, m(6).reason], [false, 'dupCareLog'])
  })
  it('排便記録で退居の方・職員の控えの行は候補にしない＝見つからない', () => {
    const r = m(7)
    assert.deepEqual([r.ok, r.reason], [false, 'notFound'])
    assert.match(X.excretionMatchMessage(r), /排便記録に同じお名前の方が見つかりません/)
  })
  it('care-log で退居の方は照合しない', () => {
    const r = m(8)
    assert.deepEqual([r.ok, r.reason], [false, 'inactive'])
  })
  it('care-log の退居の方は同じ氏名の数に入れない', () => {
    const list = [
      { id: 1, name: '利用者01', room: '101', active: true },
      { id: 9, name: '利用者01', room: '109', active: false },
    ]
    assert.equal(X.matchExcretionResident(list[0], list, snap.residents).ok, true)
  })
  it('排便記録で非表示（hidden）の方は候補にしない', () => {
    const s2 = X.parseExcretionPayload({ residents: [{ id: 11, name: '利用者01', room: '101', hidden: true }] })
    assert.equal(X.matchExcretionResident(CL[0], CL, s2.residents).reason, 'notFound')
  })
  it('居室が未登録（どちらか）なら結ばない', () => {
    const r = X.matchExcretionResident({ id: 1, name: '利用者01', room: null, active: true }, [{ id: 1, name: '利用者01', room: null, active: true }], snap.residents)
    assert.equal(r.reason, 'roomMismatch')
  })
  it('居室の比べ方: NFKC・空白・末尾の「号室」', () => {
    assert.equal(X.normRoom('１０２号室'), '102')
    assert.equal(X.normRoom(' 102 '), '102')
    assert.equal(X.normRoom(102), '102')
    assert.equal(X.normRoom(null), '')
  })
})

describe('判定と一覧', { skip: X === null ? TS_UNSUPPORTED : false }, () => {
  const NOW = new Date(2026, 9, 16, 15, 0).getTime()
  const rec = (id, hAgo, type, extra = {}) => {
    const dt = dtOf(NOW - hAgo * H1)
    return { id, residentId: 11, type, date: dt.slice(0, 10), time: dt.slice(11, 16), datetime: dt, ...extra }
  }

  it('最後の排便から◯日（注意・危険）と文', () => {
    const snap = X.parseExcretionPayload({ residents: HB_RES, records: [rec('s1', 80, 'stool', { stoolAmt: '多量' })] })
    const st = X.stoolStatusOf(snap.recs.get('11'), snap.residents[0], snap.cfg, NOW)
    assert.equal(st.level, 'danger')
    assert.equal(st.days, 3)
    assert.equal(st.atLeast, false)
    assert.equal(X.stoolStatusText(st), '最後の排便から3日（危険）')
    assert.equal(X.stoolAlertLabel(st), '排便なし3日')
  })

  it('直近14日に排便1回分が無い時は、範囲の始まりからの下限で「◯日以上」（少量だけの方も）', () => {
    const snap = X.parseExcretionPayload({
      residents: HB_RES,
      records: [rec('s1', 10, 'stool', { stoolAmt: '少量' }), rec('u1', 2, 'urine')],
    })
    const st = X.stoolStatusOf(snap.recs.get('11'), snap.residents[0], snap.cfg, NOW)
    assert.equal(st.atLeast, true)
    assert.equal(st.days, 14)
    assert.equal(st.level, 'danger')
    assert.equal(X.stoolStatusText(st), '直近14日に排便の記録がありません（14日以上）（危険）')
    assert.equal(X.stoolAlertLabel(st), '排便なし14日以上')
    // 記録が1件も無い方も同じ
    const st2 = X.stoolStatusOf([], snap.residents[0], snap.cfg, NOW)
    assert.deepEqual([st2.atLeast, st2.days, st2.level], [true, 14, 'danger'])
  })

  it('一覧: 今日を含む14日（新しい日が上）・排尿は回数だけ・排便は時刻と量と性状・下剤は薬と錠数', () => {
    const snap = X.parseExcretionPayload({
      residents: HB_RES,
      records: [
        rec('s1', 2, 'stool', { stoolAmt: '中等量', consistency: '普通' }),
        rec('b1', 3, 'both', { stoolAmt: '少量' }),
        rec('u1', 4, 'urine'),
        rec('u2', 5, 'urine'),
        rec('l1', 6, 'laxative', { medicine: '下剤A', tablets: '2' }),
        rec('old', 15 * 24, 'stool', { stoolAmt: '多量' }), // 一覧の外（数えには使う）
      ],
    })
    const days = X.excretionDays(snap.recs.get('11'), NOW)
    assert.equal(days.length, 14)
    assert.equal(days[0].day, '2026-10-16')
    assert.equal(days[13].day, '2026-10-03')
    assert.equal(days[0].urine, 3) // urine 2件＋both 1件
    assert.deepEqual(days[0].stools.map((s) => [s.amount, s.cons]), [['少量', ''], ['中等量', '普通']])
    assert.deepEqual(days[0].laxatives, [{ time: '09:00', medicine: '下剤A', tablets: '2' }])
    assert.equal(days.slice(1).every((d) => d.urine === 0 && d.stools.length === 0), true)
  })

  it('excretionViewFor: 照合できない方は理由・照合できた方は判定と一覧', () => {
    const snap = X.parseExcretionPayload({ residents: HB_RES, records: [rec('s1', 30, 'stool', { stoolAmt: '多量' })] })
    const ok = X.excretionViewFor(snap, CL[0], CL, NOW)
    assert.equal(ok.linked, true)
    assert.equal(ok.status.level, 'ok')
    assert.equal(ok.days.length, 14)
    const ng = X.excretionViewFor(snap, CL[2], CL, NOW)
    assert.equal(ng.linked, false)
    assert.match(ng.message, /^排便記録と照合できません（/)
  })

  it('今日の要注意へ足す理由（注意・危険だけ・照合できない人数）と、要注意の並び（appendReasons）', { skip: AM === null }, () => {
    const snap = X.parseExcretionPayload({
      residents: HB_RES,
      records: [
        { ...rec('s1', 80, 'stool', { stoolAmt: '多量' }), residentId: 11 }, // 利用者01: 3日＝危険
        { ...rec('s2', 30, 'stool', { stoolAmt: '多量' }), residentId: 12 }, // 利用者02: 個別 1/2 → 1日＝注意
      ],
    })
    const shown = CL.filter((r) => r.active)
    const { reasons, unlinked } = X.stoolAlertReasons(snap, shown, shown, NOW)
    assert.deepEqual([...reasons.keys()], [1, 2])
    assert.deepEqual(reasons.get(1)[0], { kind: 'stoolNone', section: 'excretion', severity: 'danger', label: '排便なし3日', time: null, recordId: null })
    assert.equal(reasons.get(2)[0].severity, 'warn')
    assert.equal(reasons.get(2)[0].label, '排便なし1日')
    // 数えるのは同じ氏名・居室の食い違いだけ（03 居室違い・04 排便記録で同名・05/06 care-log で同名）。07 見つからないは数えない（2026-10-17）
    assert.equal(unlinked, 4)
    const base = [{ residentId: 2, reasons: [{ kind: 'vital', section: 'vitals', severity: 'warn', label: '体温 37.6↑', time: '09:00', recordId: 5 }] }]
    const merged = AM.appendReasons(base, [1, 2, 3], reasons)
    assert.deepEqual(merged.map((a) => a.residentId), [1, 2])
    assert.deepEqual(merged[1].reasons.map((r) => r.kind), ['vital', 'stoolNone'])
    assert.equal(base[0].reasons.length, 1) // 元は書き換えない
    assert.equal(AM.alertHref(1, 'excretion'), '/karte/1?sec=karte-excretion')
    // residentIds に居ない方の理由は足さない
    assert.deepEqual(AM.appendReasons([], [2], reasons).map((a) => a.residentId), [2])
  })
})

describe('入院中の扱いと「照合できない方」の数え方（本人回答 2026-10-17）', { skip: X === null ? TS_UNSUPPORTED : false }, () => {
  const NOW = new Date(2026, 9, 16, 15, 0).getTime()
  const DAY = '2026-10-16'
  const meal = (rid, day, slot, status) => ({ resident_id: rid, meal_on: day, meal_slot: slot, status })
  const meals = [
    meal(1, DAY, 'breakfast', 'hospital'), // 朝だけ入院（昼・夕は記録なし）＝入院
    meal(2, DAY, 'breakfast', 'eaten'),
    meal(2, DAY, 'lunch', 'eaten'), // 入院でない日
    meal(3, '2026-10-15', 'breakfast', 'hospital'), // 前の日だけ入院＝今日は入院でない
    meal(3, DAY, 'breakfast', 'eaten'),
    meal(5, DAY, 'breakfast', 'out'),
    meal(5, DAY, 'lunch', 'hospital'), // 外出と入院が混ざる＝どれか1つでも入院なら入院
  ]

  it('isHospitalDay: その日の食事の記録のどれか1つでも入院なら入院・記録の無い日は入院とみなさない', () => {
    assert.equal(X.isHospitalDay(meals, 1, DAY), true)
    assert.equal(X.isHospitalDay(meals, 2, DAY), false)
    assert.equal(X.isHospitalDay(meals, 3, DAY), false)
    assert.equal(X.isHospitalDay(meals, 3, '2026-10-15'), true)
    assert.equal(X.isHospitalDay(meals, 4, DAY), false) // 食事の記録なし
    assert.equal(X.isHospitalDay(meals, 5, DAY), true)
    assert.equal(X.isHospitalDay([], 1, DAY), false)
    assert.equal(X.isHospitalDay(null, 1, DAY), false)
    assert.equal(X.isHospitalDay([null, meal(1, DAY, 'lunch', null)], 1, DAY), false)
    assert.deepEqual([...X.hospitalIdsOn(meals, DAY)].sort(), [1, 5])
    assert.deepEqual([...X.hospitalIdsOn(undefined, DAY)], [])
  })

  it('今日の要注意: 今日の食事が入院の方は「排便なし」を出さない（入院でない方は出す）', () => {
    const snap = X.parseExcretionPayload({
      residents: HB_RES,
      records: [
        { id: 's1', residentId: 11, type: 'stool', datetime: dtOf(NOW - 80 * H1), date: dtOf(NOW - 80 * H1).slice(0, 10), stoolAmt: '多量' },
        { id: 's2', residentId: 12, type: 'stool', datetime: dtOf(NOW - 80 * H1), date: dtOf(NOW - 80 * H1).slice(0, 10), stoolAmt: '多量' },
      ],
    })
    const shown = CL.filter((r) => r.active)
    const none = X.stoolAlertReasons(snap, shown, shown, NOW)
    assert.equal(none.reasons.has(1), true)
    const withHosp = X.stoolAlertReasons(snap, shown, shown, NOW, X.hospitalIdsOn(meals, DAY))
    assert.equal(withHosp.reasons.has(1), false) // 利用者01 は朝だけ入院＝出さない
    assert.equal(withHosp.reasons.has(2), true) // 利用者02 は入院でない
    assert.equal(withHosp.unlinked, none.unlinked) // 入院は照合できない人数に関係しない
  })

  it('カルテ: 入院の日は view.hospital（日数の代わりの文）・14日の一覧はそのまま', () => {
    const snap = X.parseExcretionPayload({
      residents: HB_RES,
      records: [{ id: 's1', residentId: 11, type: 'stool', datetime: dtOf(NOW - 80 * H1), date: dtOf(NOW - 80 * H1).slice(0, 10), stoolAmt: '多量' }],
    })
    const v = X.excretionViewFor(snap, CL[0], CL, NOW, X.isHospitalDay(meals, 1, DAY))
    assert.equal(v.linked, true)
    assert.equal(v.hospital, true)
    assert.equal(v.days.length, 14)
    assert.equal(v.days.some((d) => d.stools.length > 0), true)
    assert.equal(X.MSG_STOOL_HOSPITAL, '入院中のため判定しません（食事の記録が入院）')
    const v2 = X.excretionViewFor(snap, CL[0], CL, NOW)
    assert.equal(v2.hospital, false)
  })

  it('照合できない方に数えるのは同じ氏名（どちら側でも）と居室の食い違いだけ', () => {
    assert.equal(X.isCountedUnlinked('dupCareLog'), true)
    assert.equal(X.isCountedUnlinked('dupHaiben'), true)
    assert.equal(X.isCountedUnlinked('roomMismatch'), true)
    assert.equal(X.isCountedUnlinked('notFound'), false)
    assert.equal(X.isCountedUnlinked('inactive'), false)
    // 見つからない方だけなら 0 名
    const snap = X.parseExcretionPayload({ residents: [{ id: 11, name: '利用者01', room: '101' }] })
    const shown = [CL[0], CL[1], CL[6]] // 01 照合できる・02/07 見つからない
    assert.equal(X.stoolAlertReasons(snap, shown, shown, Date.now()).unlinked, 0)
    // カルテの方ごとの「見つかりません」の表示は残す
    const v = X.excretionViewFor(snap, CL[1], shown, Date.now())
    assert.match(v.message, /排便記録に同じお名前の方が見つかりません/)
  })

  it('配線: 要注意は今日の食事から入院の方を渡し、一行は 0 名なら出さない。カルテは表示の日（toIso）の食事で判定', () => {
    const page = read('../src/pages/AlertsPage.tsx')
    assert.match(page, /stoolAlertReasons\(stool\.snap, shown, data\.residents, Date\.now\(\), hospitalIdsOn\(data\.meals, data\.day\)\)/)
    assert.match(page, /if \(unlinked > 0\) \{/)
    const karte = read('../src/pages/KartePage.tsx')
    assert.match(karte, /isHospitalDay\(data\.meals, residentId, toIso\)/)
    assert.match(karte, /\{view\.hospital \? \(/)
    assert.match(karte, /\{MSG_STOOL_HOSPITAL\}/)
  })
})

describe('取得（偽の GAS・通信しない）', { skip: X === null ? TS_UNSUPPORTED : false }, () => {
  let calls = []
  beforeEach(() => {
    calls = []
    X.clearExcretionCache()
    installLS({ hbcr_api_url: DUMMY_URL, hbcr_api_token: DUMMY_TOKEN })
  })
  afterEach(() => {
    globalThis.localStorage = realLS
    globalThis.fetch = realFetch
    mock.timers.reset()
  })
  function fakeFetch(respond) {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return respond(url, init)
    }
  }
  const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  const okBody = () => ({ ok: true, residents: HB_RES, records: [], cfg: {}, delta: true, syncCursor: 1, recentDays: 14, heal: true, deleted: [] })

  it('接続設定が無い端末は null（通信しない）', async () => {
    installLS({})
    fakeFetch(() => jsonRes(okBody()))
    assert.equal(await X.fetchExcretion(), null)
    assert.equal(calls.length, 0)
  })

  it('getAll を POST 本文（text/plain）で送る。合言葉は本文だけ・since は今から16日前・heal は付けない。書き込み0', async () => {
    fakeFetch(() => jsonRes(okBody()))
    const t0 = Date.now()
    const r = await X.fetchExcretion()
    assert.equal(r.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, DUMMY_URL)
    assert.equal(calls[0].url.includes(DUMMY_TOKEN), false)
    assert.equal(calls[0].init.method, 'POST')
    assert.match(calls[0].init.headers['Content-Type'], /^text\/plain/)
    const body = JSON.parse(calls[0].init.body)
    assert.deepEqual(Object.keys(body).sort(), ['action', 'since', 'token'])
    assert.equal(body.action, 'getAll')
    assert.equal(body.token, DUMMY_TOKEN)
    assert.ok(Math.abs(t0 - 16 * 86400000 - body.since) < 5000, String(t0 - body.since))
    assert.ok(calls[0].init.signal)
    assert.equal(writes, 0)
  })

  it('合言葉違い（ok:false・code:403）は auth＝「排便記録の合言葉が違います」', async () => {
    fakeFetch(() => jsonRes({ ok: false, error: '認証エラー', code: 403 }))
    const r = await X.fetchExcretion()
    assert.deepEqual(r, { ok: false, reason: 'auth' })
    assert.match(X.excretionFailMessage('auth'), /^排便記録の合言葉が違います/)
  })

  it('失敗の種類: HTTP 異常・ok でない・JSON 破損・residents の無い応答・通信エラー・中断', async () => {
    fakeFetch(() => jsonRes({}, 500))
    assert.deepEqual(await X.fetchExcretion(), { ok: false, reason: 'http' })
    fakeFetch(() => jsonRes({ ok: false, error: 'flush_fail' }))
    assert.deepEqual(await X.fetchExcretion(), { ok: false, reason: 'refused' })
    fakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad') } }))
    assert.deepEqual(await X.fetchExcretion(), { ok: false, reason: 'format' })
    fakeFetch(() => jsonRes({ ok: true, records: [] }))
    assert.deepEqual(await X.fetchExcretion(), { ok: false, reason: 'format' })
    fakeFetch(() => jsonRes('text'))
    assert.deepEqual(await X.fetchExcretion(), { ok: false, reason: 'format' })
    fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    assert.deepEqual(await X.fetchExcretion(), { ok: false, reason: 'network' })
    installLS({ hbcr_api_url: 'https://example.com/exec', hbcr_api_token: DUMMY_TOKEN })
    assert.deepEqual(await X.fetchExcretion(), { ok: false, reason: 'url' })
    for (const reason of ['url', 'timeout', 'network', 'http', 'auth', 'refused', 'format']) {
      const msg = X.excretionFailMessage(reason)
      assert.equal(typeof msg, 'string')
      assert.equal(msg.includes(DUMMY_TOKEN), false)
    }
  })

  it('応答が30秒来なければ中断して timeout', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    globalThis.fetch = (url, init) =>
      new Promise((_, rej) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          rej(e)
        })
      })
    const p = X.fetchExcretion()
    await Promise.resolve()
    mock.timers.tick(X.EXCRETION_TIMEOUT_MS - 1)
    await Promise.resolve()
    let settled = false
    p.then(() => {
      settled = true
    })
    await Promise.resolve()
    assert.equal(settled, false)
    mock.timers.tick(1)
    assert.deepEqual(await p, { ok: false, reason: 'timeout' })
    assert.equal(X.EXCRETION_TIMEOUT_MS, 30000)
  })

  it('5分はメモリの控えを使い（通信しない）、force で取り直す。同時の取得は1本にまとめる', async () => {
    fakeFetch(() => jsonRes(okBody()))
    const [a, b] = await Promise.all([X.fetchExcretion(), X.fetchExcretion()])
    assert.equal(calls.length, 1)
    assert.equal(a.ok && b.ok, true)
    await X.fetchExcretion()
    assert.equal(calls.length, 1)
    await X.fetchExcretion({ force: true })
    assert.equal(calls.length, 2)
    assert.equal(X.EXCRETION_CACHE_MS, 5 * 60 * 1000)
    assert.equal(writes, 0)
  })

  it('失敗はメモリに控えない（次は取り直す）', async () => {
    fakeFetch(() => jsonRes({}, 500))
    await X.fetchExcretion()
    fakeFetch(() => jsonRes(okBody()))
    const r = await X.fetchExcretion()
    assert.equal(r.ok, true)
    assert.equal(calls.length, 2)
  })
})

describe('静的な見張り（読むだけ・個人情報を残さない）', () => {
  const WRITE_ACTIONS = ['addRecord', 'saveRecord', 'delRecord', 'saveRes', 'saveSched', 'delRes', 'saveCfg', 'setMasterState']

  it('excretionClient は書き込みの action を持たず、送る action は getAll だけ', () => {
    const src = strip(read('../src/lib/excretionClient.ts'))
    for (const a of WRITE_ACTIONS) assert.equal(src.includes(a), false, a)
    const actions = [...src.matchAll(/action:\s*'([^']+)'/g)].map((m) => m[1])
    assert.deepEqual(actions, ['getAll'])
  })

  it('excretionClient は localStorage に書かず、sessionStorage・Cookie・IndexedDB・console を使わない', () => {
    const src = strip(read('../src/lib/excretionClient.ts'))
    assert.equal(/localStorage\.(setItem|removeItem|clear)/.test(src), false)
    assert.equal(/sessionStorage|document\.cookie|indexedDB|console\./.test(src), false)
  })

  it('画面（カルテ・今日の要注意）は排便記録のキーを直書きせず、書き込みの action も持たない', () => {
    for (const f of ['../src/pages/KartePage.tsx', '../src/pages/AlertsPage.tsx']) {
      const src = strip(read(f))
      assert.equal(/hbcr_/.test(src), false, f)
      for (const a of WRITE_ACTIONS) assert.equal(src.includes(`'${a}'`), false, `${f} ${a}`)
      assert.equal(/console\./.test(src), false, f)
    }
  })

  it('src 全体で排便記録の書き込みの action を呼ぶ所が無い（GAS の URL に送るのは excretionClient だけ）', async () => {
    const { readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = new URL('../src/', import.meta.url).pathname
    const files = []
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(n)) files.push(p)
      }
    }
    walk(root)
    const users = files.filter((p) => /from '\.\.?\/(lib\/)?excretionClient'/.test(readFileSync(p, 'utf8'))).map((p) => p.slice(root.length))
    assert.deepEqual(users.sort(), ['pages/AlertsPage.tsx', 'pages/KartePage.tsx'])
  })

  it('カルテ: 排泄の欄（karte-excretion）を食事・水分の次に置き、移動ボタンと ?sec= の許可リストにも入る', () => {
    const src = read('../src/pages/KartePage.tsx')
    const listSrc = src.slice(src.indexOf('export const KARTE_JUMPS'), src.indexOf('function findShellHeader'))
    const ids = [...listSrc.matchAll(/id: '([^']+)'/g)].map((m) => m[1])
    assert.equal(ids[ids.indexOf('karte-meals') + 1], 'karte-excretion')
    assert.match(src, /<SectionCard title="排泄" className="mt-4" id="karte-excretion">/)
    // 読み直しは excretionTick の時だけ force
    assert.match(src, /const force = excretionTick !== forcedExcretionTickRef\.current/)
  })

  it('今日の要注意: 排泄の欄へ移る行き先・排便の読み込みは画面を止めない（core の Promise.all に入れない）', () => {
    const model = read('../src/pages/alertsModel.ts')
    assert.match(model, /excretion: 'karte-excretion'/)
    const page = read('../src/pages/AlertsPage.tsx')
    assert.match(page, /excretion: '排泄'/)
    const core = page.slice(page.indexOf('const coreP = Promise.all('), page.indexOf('const loadMed'))
    assert.equal(/fetchExcretion/.test(core), false)
    assert.match(page, /appendReasons\(baseAlerts/)
  })

  it('温度板の印刷は変えない（排泄を参照しない）', () => {
    for (const f of ['../src/components/print/TempSheet.tsx', '../src/components/print/tempSheetModel.ts']) {
      assert.equal(/excretion|排泄|排便/.test(read(f)), false, f)
    }
  })
})
