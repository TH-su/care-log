// 事故・ヒヤリハットの回帰テスト。2026-09-26 追加。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// 1. 純ロジック（src/lib/incident.ts）: 入力の検証（第1報の必須項目・「その他」の文字）・市への報告の案内・
//    月次集計（時間帯の境界・氏名が出ないこと）・受け渡しの照合・選択肢の網羅（types.ts と 0014 の check が一致）
// 2. db.ts: 封鎖（input_enabled_incident）・保存・追記・取り消し・送信待ち（cl_sendQueue）・hasPendingIncident・
//    pendingIncidentOps・取得の範囲・カルテ・事業所の情報（偽の Supabase。通信しない）
// 3. 配線の静的検査（0014 の SQL・App のルート・記録ハブ・その他・与薬からの受け渡し）
// 個人情報は置かない（利用者・職員は数値IDと記号だけ。氏名は「利用者A」等の架空の記号、事業所の情報は架空の値）。

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const TS_UNSUPPORTED =
  'この Node では TypeScript を直接読み込めないため、事故・ヒヤリハットの検証をスキップしました（Node 22.18 以降で実行してください）。'
const DB_UNSUPPORTED =
  'この Node では解決フック（module.registerHooks）が使えないため、事故・ヒヤリハットの db.ts の検証をスキップしました（Node 22.15 以降で実行してください）。'

let I = null
let T = null
let MED = null
try {
  I = await import('../src/lib/incident.ts')
  T = await import('../src/lib/types.ts')
  MED = await import('../src/lib/med.ts')
} catch {
  I = null
}

// db.ts は拡張子の無い相対 import を使うので、'.ts' を補う解決フックを入れてから読む（tests/med.test.mjs と同じ）
const lsStore = new Map()
let DB = null
try {
  const { registerHooks } = await import('node:module')
  if (typeof registerHooks !== 'function') throw new Error('no registerHooks')
  registerHooks({
    resolve(specifier, context, next) {
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

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

/** 端末の時刻での ISO（テストを動かす端末の時刻帯に依らない） */
const at = (day, hm) => MED.localDateTimeIso(day, hm)

/** 第1報の最小の入力（事故・対象者あり） */
function firstReport(over = {}, detailOver = {}) {
  return {
    kind: 'accident',
    resident_id: 1,
    occurred_on: '2026-09-20',
    occurred_at: at('2026-09-20', '10:30'),
    office: null,
    place: 'room_private',
    place_other: null,
    types: ['fall'],
    severity: null,
    status: 'open',
    report_stage: null,
    report_no: null,
    submitted_on: null,
    city_report_needed: false,
    city_reported_on: null,
    reporter_id: 3,
    confirmer_id: null,
    confirmed_at: null,
    ...over,
    detail: { ...I.emptyIncidentDetail(), situation: '状況A', response: '対応A', ...detailOver },
  }
}

const TODAY = '2026-09-26'
const NOW = new Date(2026, 8, 26, 12, 0, 0)

// ══════════════════════════════════════════════════════════════
// 1. 純ロジック
// ══════════════════════════════════════════════════════════════

if (I === null) {
  it('事故・ヒヤリハットの純ロジック', { skip: TS_UNSUPPORTED }, () => {})
} else {
  describe('入力の検証（validateIncidentInput）: 第1報の必須項目', () => {
    const ok = (v) => I.validateIncidentInput(v, TODAY, NOW)
    it('区分・発生日時・場所・種別・対象者・発生時状況・発生時の対応・記録者だけで通る（残りの欄は空でよい）', () => {
      assert.deepEqual(ok(firstReport()), { ok: true })
    })
    it('ヒヤリハットは対象者なしで通る・事故は対象者が必須', () => {
      assert.deepEqual(ok(firstReport({ kind: 'nearmiss', resident_id: null })), { ok: true })
      const r = ok(firstReport({ resident_id: null }))
      assert.equal(r.ok, false)
      assert.match(r.message, /対象者/)
    })
    const cases = [
      ['区分が未選択', { kind: '' }, {}, /区分/],
      ['発生日が空', { occurred_on: '' }, {}, /発生日/],
      ['発生時刻が空', { occurred_at: '' }, {}, /発生時刻/],
      ['場所が未選択', { place: null }, {}, /発生場所/],
      ['種別が空', { types: [] }, {}, /種別/],
      ['発生時状況が空白だけ', {}, { situation: '   ' }, /発生時状況/],
      ['発生時の対応が空', {}, { response: null }, /発生時の対応/],
      ['記録者が未選択', { reporter_id: null }, {}, /記録者/],
    ]
    for (const [name, over, dOver, re] of cases) {
      it(`${name}なら止める`, () => {
        const r = ok(firstReport(over, dOver))
        assert.equal(r.ok, false, name)
        assert.match(r.message, re)
      })
    }
    it('未来の日付・今より先の時刻・発生日と違う日の時刻は止める', () => {
      assert.match(ok(firstReport({ occurred_on: '2026-09-27', occurred_at: at('2026-09-27', '09:00') })).message, /未来/)
      assert.match(ok(firstReport({ occurred_on: TODAY, occurred_at: at(TODAY, '13:00') })).message, /今より先/)
      assert.equal(ok(firstReport({ occurred_on: TODAY, occurred_at: at(TODAY, '12:03') })).ok, true, '端末の時計のずれ（5分）は許す')
      assert.match(ok(firstReport({ occurred_at: at('2026-09-21', '10:30') })).message, /発生日の時刻/)
    })
    it('知らない種別・重複した種別は止める（黙って落とさない）', () => {
      assert.equal(ok(firstReport({ types: ['fall', 'slip'] })).ok, false)
      assert.equal(ok(firstReport({ types: ['fall', 'fall'] })).ok, false)
    })
  })

  describe('入力の検証: 「その他」を選んだ欄は内容の文字が必須', () => {
    const ok = (v) => I.validateIncidentInput(v, TODAY, NOW)
    const cases = [
      ['発生場所', { place: 'other' }, {}, { place: 'other', place_other: '場所X' }, {}],
      ['種別', { types: ['fall', 'other'] }, {}, { types: ['fall', 'other'] }, { type_other: '内容X' }],
      ['程度', { severity: 'other' }, {}, { severity: 'other' }, { severity_other: '内容X' }],
      ['住所', {}, { address_kind: 'other' }, {}, { address_kind: 'other', address_other: '住所X' }],
      ['受診方法', {}, { visit_methods: ['other'] }, {}, { visit_methods: ['other'], visit_method_other: '内容X' }],
      ['診断内容', {}, { diagnosis_kinds: ['cut', 'other'] }, {}, { diagnosis_kinds: ['cut', 'other'], diagnosis_other: '内容X' }],
      ['家族等の続柄', {}, { family_relations: ['other'] }, {}, { family_relations: ['other'], family_relation_other: '続柄X' }],
      ['関係機関', {}, { agency_other: true }, {}, { agency_other: true, agency_other_name: '名称X' }],
    ]
    for (const [name, badCols, badDetail, goodCols, goodDetail] of cases) {
      it(`${name}が「その他」: 内容が空なら止め、書けば通る`, () => {
        const bad = ok(firstReport(badCols, badDetail))
        assert.equal(bad.ok, false, name)
        assert.match(bad.message, /その他/)
        assert.equal(ok(firstReport(goodCols, { ...badDetail, ...goodDetail })).ok, true, name)
      })
    }
    it('「その他」の内容が空白だけでも止める', () => {
      assert.equal(ok(firstReport({ place: 'other', place_other: '  ' })).ok, false)
    })
    it('第＿報は 2 以上の数が要る・年齢は 0〜130・日付の形を確かめる', () => {
      assert.equal(ok(firstReport({ report_stage: 'nth', report_no: null })).ok, false)
      assert.equal(ok(firstReport({ report_stage: 'nth', report_no: 1 })).ok, false)
      assert.equal(ok(firstReport({ report_stage: 'nth', report_no: 2 })).ok, true)
      assert.equal(ok(firstReport({}, { subject_age: 131 })).ok, false)
      assert.equal(ok(firstReport({}, { subject_age: 88 })).ok, true)
      assert.equal(ok(firstReport({ submitted_on: '2026-02-30' })).ok, false)
      assert.equal(ok(firstReport({}, { death_on: '2026-9-1' })).ok, false)
    })
    it('完了の前の確認: 原因分析・再発防止策が空なら名前を返す', () => {
      assert.deepEqual(I.missingForClose(I.emptyIncidentDetail()), ['7 事故の原因分析', '8 再発防止策'])
      assert.deepEqual(I.missingForClose({ ...I.emptyIncidentDetail(), cause: 'x', prevention: 'y' }), [])
    })
  })

  describe('市への報告が必要な可能性の案内（cityReportHint）', () => {
    it('事故で、程度が受診・入院・死亡のいずれか', () => {
      for (const s of ['treated', 'hospitalized', 'death']) assert.equal(I.cityReportHint('accident', s, ['fall']), true, s)
      assert.equal(I.cityReportHint('accident', 'other', ['fall']), false)
      assert.equal(I.cityReportHint('accident', null, ['fall', 'pica']), false)
    })
    it('事故で、種別に誤嚥・窒息／誤薬、与薬もれ等を含む（程度が空でも）', () => {
      assert.equal(I.cityReportHint('accident', null, ['aspiration']), true)
      assert.equal(I.cityReportHint('accident', null, ['fall', 'med_error']), true)
    })
    it('ヒヤリハット・区分が未選択なら出さない（判断は人）', () => {
      assert.equal(I.cityReportHint('nearmiss', 'hospitalized', ['med_error']), false)
      assert.equal(I.cityReportHint(null, 'death', ['aspiration']), false)
    })
    it('一覧の「市への報告」と上部の件数', () => {
      assert.equal(I.cityReportState({ city_report_needed: true, city_reported_on: null }), 'pending')
      assert.equal(I.cityReportState({ city_report_needed: true, city_reported_on: '2026-09-21' }), 'reported')
      assert.equal(I.cityReportState({ city_report_needed: false, city_reported_on: null }), 'none')
      assert.deepEqual(
        I.incidentCounts([
          { status: 'open', city_report_needed: true, city_reported_on: null },
          { status: 'open', city_report_needed: false, city_reported_on: null },
          { status: 'closed', city_report_needed: true, city_reported_on: '2026-09-02' },
        ]),
        { open: 2, cityPending: 1 },
      )
      assert.match(I.CITY_REPORT_DEADLINE_NOTE, /第1報は発生から5日以内が目安（国の通知）/)
    })
  })

  describe('委員会用の月次集計（aggregateIncidentMonth）', () => {
    const rec = (id, day, hm, over = {}) => ({
      ...firstReport({ occurred_on: day, occurred_at: at(day, hm), ...over }, { subject_name: '利用者A' }),
      id,
      rev: 1,
    })
    it('時間帯の境界（始まりを含み終わりを含まない）: 5:59→0-6、6:00→6-9、8:59→6-9、9:00→9-12、20:59→18-21、21:00→21-24、23:59→21-24、0:00→0-6', () => {
      const cases = [
        ['05:59', 0],
        ['06:00', 1],
        ['08:59', 1],
        ['09:00', 2],
        ['11:59', 2],
        ['12:00', 3],
        ['15:00', 4],
        ['18:00', 5],
        ['20:59', 5],
        ['21:00', 6],
        ['23:59', 6],
        ['00:00', 0],
      ]
      for (const [hm, band] of cases) assert.equal(I.timeBandOf(at('2026-09-10', hm)), band, hm)
      assert.deepEqual(
        I.INCIDENT_TIME_BANDS.map((_, i) => I.timeBandLabel(i)),
        ['0-6時', '6-9時', '9-12時', '12-15時', '15-18時', '18-21時', '21-24時'],
      )
      assert.equal(I.timeBandOf('bogus'), null)
    })
    it('事故・ヒヤリ別の件数・種別（複数は各々に数える）・場所・時間帯・程度（空は未入力）・その月だけ', () => {
      const list = [
        rec(1, '2026-09-01', '05:59', { types: ['fall', 'med_error'], severity: 'treated' }),
        rec(2, '2026-09-15', '06:00', { kind: 'nearmiss', resident_id: null, place: 'toilet', types: ['fall'] }),
        rec(3, '2026-09-30', '21:00', { place: 'other', place_other: '場所X', types: ['aspiration'], status: 'closed' }),
        rec(4, '2026-10-01', '10:00'), // 翌月は数えない
        rec(5, '2026-08-31', '10:00'), // 前月は数えない
      ]
      const s = I.aggregateIncidentMonth(list, '2026-09')
      assert.deepEqual(s.total, { accident: 2, nearmiss: 1, total: 3 })
      const pick = (rows) => Object.fromEntries(rows.filter((r) => r.total > 0).map((r) => [r.key, [r.accident, r.nearmiss, r.total]]))
      assert.deepEqual(pick(s.byType), { fall: [1, 1, 2], aspiration: [1, 0, 1], med_error: [1, 0, 1] })
      assert.deepEqual(pick(s.byPlace), { room_private: [1, 0, 1], toilet: [0, 1, 1], other: [1, 0, 1] })
      assert.deepEqual(pick(s.byBand), { 0: [1, 0, 1], 1: [0, 1, 1], 6: [1, 0, 1] })
      assert.deepEqual(pick(s.bySeverity), { treated: [1, 0, 1], unset: [1, 1, 2] })
      assert.deepEqual(s.byType.map((r) => r.key), [...T.INCIDENT_TYPES])
      assert.equal(s.byPlace.at(-1).label, '未入力')
      // 未完了の一覧は完了を除き、発生日の古い順
      assert.deepEqual(s.open.map((o) => [o.id, o.occurred_on, o.kind, o.status]), [
        [1, '2026-09-01', 'accident', 'open'],
        [2, '2026-09-15', 'nearmiss', 'open'],
      ])
    })
    it('★集計の結果に氏名・対象者・本文が出ない（未完了の一覧も日付・区分・種別・状態だけ）', () => {
      const s = I.aggregateIncidentMonth([rec(1, '2026-09-02', '10:00')], '2026-09')
      const json = JSON.stringify(s)
      assert.equal(json.includes('利用者A'), false, '氏名が集計に出た')
      assert.equal(json.includes('状況A'), false, '本文が集計に出た')
      assert.equal(/resident_id|subject_name|detail/.test(json), false, '対象者の項目が集計に出た')
      assert.deepEqual(Object.keys(s.open[0]).sort(), ['id', 'kind', 'occurred_on', 'status', 'types'])
    })
    it('★未完了の一覧は月末までに発生して未完了のもの（前月以前の持ち越しを含む・月末より後・完了は除く・重複しない）', () => {
      const month = [rec(1, '2026-09-02', '10:00'), rec(2, '2026-09-20', '10:00', { status: 'closed' })]
      const openCandidates = [
        rec(7, '2026-07-15', '10:00'), // 前々月からの持ち越し
        rec(8, '2025-12-31', '10:00'), // 前年からの持ち越し
        rec(1, '2026-09-02', '10:00'), // その月の記録（重複しても1回）
        rec(9, '2026-10-01', '10:00'), // 月末より後に発生 → 除く
        rec(10, '2026-08-31', '10:00', { status: 'closed' }), // 完了 → 除く
      ]
      const s = I.aggregateIncidentMonth(month, '2026-09', openCandidates)
      assert.deepEqual(s.open.map((o) => o.id), [8, 7, 1])
      assert.deepEqual(s.total, { accident: 2, nearmiss: 0, total: 2 }, '件数はその月の発生だけ')
      assert.equal(JSON.stringify(s).includes('利用者A'), false)
    })
    it('月の形が不正なら何も数えない', () => {
      assert.equal(I.aggregateIncidentMonth([rec(1, '2026-09-02', '10:00')], '2026-13').total.total, 0)
    })
  })

  describe('選択肢の網羅（様式の並び・文言）', () => {
    it('区分・場所・種別・程度・状態・報告区分・受診方法・診断内容・続柄・性別・住所・要介護度・自立度が様式どおり', () => {
      const labels = (keys, map) => keys.map((k) => map[k])
      assert.deepEqual(labels(T.INCIDENT_KINDS, T.INCIDENT_KIND_LABEL), ['事故', 'ヒヤリハット'])
      assert.deepEqual(labels(T.INCIDENT_OFFICES, T.INCIDENT_OFFICE_LABEL), ['入所', '訪問', '通所'])
      assert.deepEqual(labels(T.INCIDENT_PLACES, T.INCIDENT_PLACE_LABEL), [
        '居室（個室）',
        '居室（多床室）',
        'トイレ',
        '廊下',
        '食堂等共用部',
        '浴室・脱衣室',
        '機能訓練室',
        '施設敷地内の建物外',
        '敷地外',
        'その他',
      ])
      assert.deepEqual(labels(T.INCIDENT_TYPES, T.INCIDENT_TYPE_LABEL), [
        '転倒',
        '転落',
        '誤嚥・窒息',
        '異食',
        '誤薬、与薬もれ等',
        '医療処置関連（チューブ抜去等）',
        '不明',
        'その他',
      ])
      assert.deepEqual(labels(T.INCIDENT_SEVERITIES, T.INCIDENT_SEVERITY_LABEL), ['受診(外来･往診)、自施設で応急処置', '入院', '死亡', 'その他'])
      assert.deepEqual(labels(T.INCIDENT_STATUSES, T.INCIDENT_STATUS_LABEL), ['対応中', '完了'])
      assert.deepEqual(labels(T.INCIDENT_REPORT_STAGES, T.INCIDENT_REPORT_STAGE_LABEL), ['第1報', '第＿報', '最終報告'])
      assert.deepEqual(labels(T.INCIDENT_VISIT_METHODS, T.INCIDENT_VISIT_METHOD_LABEL), [
        '施設内の医師(配置医含む)が対応',
        '受診(外来･往診)',
        '救急搬送',
        'その他',
      ])
      assert.deepEqual(labels(T.INCIDENT_DIAGNOSIS_KINDS, T.INCIDENT_DIAGNOSIS_KIND_LABEL), ['切傷・擦過傷', '打撲・捻挫・脱臼', '骨折', 'その他'])
      assert.deepEqual(labels(T.INCIDENT_FAMILY_RELATIONS, T.INCIDENT_FAMILY_RELATION_LABEL), ['配偶者', '子、子の配偶者', 'その他'])
      assert.deepEqual(labels(T.INCIDENT_GENDERS, T.INCIDENT_GENDER_LABEL), ['男性', '女性'])
      assert.deepEqual(labels(T.INCIDENT_ADDRESS_KINDS, T.INCIDENT_ADDRESS_KIND_LABEL), ['事業所所在地', 'その他'])
      assert.deepEqual(labels(T.INCIDENT_CARE_LEVELS, T.INCIDENT_CARE_LEVEL_LABEL), [
        '要支援1',
        '要支援2',
        '要介護1',
        '要介護2',
        '要介護3',
        '要介護4',
        '要介護5',
        '自立',
      ])
      assert.deepEqual(labels(T.INCIDENT_DEMENTIA_LEVELS, T.INCIDENT_DEMENTIA_LEVEL_LABEL), ['Ⅰ', 'Ⅱa', 'Ⅱb', 'Ⅲa', 'Ⅲb', 'Ⅳ', 'M'])
    })
    it('どの選択肢もラベルの表と同じ数（抜け・余りが無い）', () => {
      for (const [keys, map] of [
        [T.INCIDENT_KINDS, T.INCIDENT_KIND_LABEL],
        [T.INCIDENT_PLACES, T.INCIDENT_PLACE_LABEL],
        [T.INCIDENT_TYPES, T.INCIDENT_TYPE_LABEL],
        [T.INCIDENT_SEVERITIES, T.INCIDENT_SEVERITY_LABEL],
        [T.INCIDENT_VISIT_METHODS, T.INCIDENT_VISIT_METHOD_LABEL],
        [T.INCIDENT_DIAGNOSIS_KINDS, T.INCIDENT_DIAGNOSIS_KIND_LABEL],
        [T.INCIDENT_FAMILY_RELATIONS, T.INCIDENT_FAMILY_RELATION_LABEL],
        [T.INCIDENT_CARE_LEVELS, T.INCIDENT_CARE_LEVEL_LABEL],
        [T.INCIDENT_DEMENTIA_LEVELS, T.INCIDENT_DEMENTIA_LEVEL_LABEL],
      ]) {
        assert.deepEqual([...keys].sort(), Object.keys(map).sort())
      }
    })
    it('0014 の check 制約のキーは types.ts の選択肢と同じ（区分・場所・種別・程度・状態・報告区分・サービス種別）', () => {
      const sql = read('../supabase/migrations/0014_incidents.sql')
      const listOf = (constraint) => {
        const m = new RegExp(`add constraint ${constraint}\\s+check \\(([\\s\\S]*?)\\);`).exec(sql)
        assert.ok(m, constraint)
        return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
      }
      assert.deepEqual(listOf('incidents_kind_check'), [...T.INCIDENT_KINDS])
      assert.deepEqual(listOf('incidents_place_check'), [...T.INCIDENT_PLACES])
      assert.deepEqual(listOf('incidents_types_check'), [...T.INCIDENT_TYPES])
      assert.deepEqual(listOf('incidents_severity_check'), [...T.INCIDENT_SEVERITIES])
      assert.deepEqual(listOf('incidents_status_check'), [...T.INCIDENT_STATUSES])
      assert.deepEqual(listOf('incidents_report_stage_check'), [...T.INCIDENT_REPORT_STAGES])
      assert.deepEqual(listOf('incidents_office_check'), [...T.INCIDENT_OFFICES])
    })
  })

  describe('detail の照合・名簿からの初期値・与薬からの受け渡し', () => {
    it('normalizeIncidentDetail: 知らないキー・選択肢は捨て、空白だけの文字は null、配列は様式の並び', () => {
      const d = I.normalizeIncidentDetail({
        situation: '  ',
        response: '対応A',
        unknown_key: 'x',
        visit_methods: ['other', 'bogus', 'in_house', 'in_house'],
        care_level: 'care9',
        subject_age: '88',
        agency_police: 'true',
        death_on: '2026-9-1',
      })
      assert.equal(d.situation, null)
      assert.equal(d.response, '対応A')
      assert.equal('unknown_key' in d, false)
      assert.deepEqual(d.visit_methods, ['in_house', 'other'])
      assert.equal(d.care_level, null)
      assert.equal(d.subject_age, 88)
      assert.equal(d.agency_police, false, '真偽は true だけを受ける')
      assert.equal(d.death_on, null)
      assert.deepEqual(I.normalizeIncidentDetail([1, 2]), I.emptyIncidentDetail())
    })
    it('detailChanges は変わった欄だけ', () => {
      const base = I.emptyIncidentDetail()
      assert.deepEqual(I.detailChanges(base, { ...base, cause: 'x', visit_methods: ['ambulance'] }), { cause: 'x', visit_methods: ['ambulance'] })
      assert.deepEqual(I.detailChanges(base, { ...base }), {})
    })
    it('要介護度・性別を名簿の文字から読む（全角数字も・読めなければ null）', () => {
      assert.equal(I.careLevelKeyOf('要介護3'), 'care3')
      assert.equal(I.careLevelKeyOf('要介護３'), 'care3')
      assert.equal(I.careLevelKeyOf('要支援 1'), 'support1')
      assert.equal(I.careLevelKeyOf('要支援3'), null)
      assert.equal(I.careLevelKeyOf('自立'), 'independent')
      assert.equal(I.careLevelKeyOf(null), null)
      assert.equal(I.genderKeyOf('男'), 'male')
      assert.equal(I.genderKeyOf('女性'), 'female')
      assert.equal(I.genderKeyOf('不明'), null)
    })
    it('受け渡し（/incident/new?resident=&date=&type=）は在籍の id・今日以前の日付・種別のキーだけを受ける', () => {
      const active = new Set([1, 2])
      assert.deepEqual(I.parseIncidentPrefill('?resident=1&date=2026-09-20&type=med_error', active, TODAY), {
        residentId: 1,
        day: '2026-09-20',
        type: 'med_error',
      })
      assert.deepEqual(I.parseIncidentPrefill('?resident=9&date=2026-09-27&type=bogus', active, TODAY), {
        residentId: null,
        day: null,
        type: null,
      })
      assert.deepEqual(I.parseIncidentPrefill('?resident=1abc&date=2026-02-30', active, TODAY), { residentId: null, day: null, type: null })
      assert.deepEqual(I.parseIncidentPrefill('', active, TODAY), { residentId: null, day: null, type: null })
    })
    it('一覧の既定の期間は直近3か月', () => {
      assert.deepEqual(I.defaultIncidentRange('2026-09-26'), { from: '2026-06-26', to: '2026-09-26' })
      assert.deepEqual(I.defaultIncidentRange('2026-01-15'), { from: '2025-10-15', to: '2026-01-15' })
    })
    it('印刷の印は ■（選んだ）と □（選んでいない）', () => {
      assert.equal(I.checkMark(true), '■')
      assert.equal(I.checkMark(false), '□')
    })
  })
}

// ══════════════════════════════════════════════════════════════
// 2. db.ts（偽の Supabase）
// ══════════════════════════════════════════════════════════════

/**
 * 偽の Supabase クライアント。db.ts が使う連鎖だけを受け、発行された要求を calls に記録する（tests/med.test.mjs と同じ形）
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
        if (q.cols === undefined) q.cols = cols
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
      or(expr) {
        q.filters.push(['or', expr])
        return b
      },
      limit(n) {
        q.limit = n
        return b
      },
      order(col, opts) {
        q.orders = [...(q.orders ?? []), [col, opts?.ascending !== false]]
        return b
      },
      maybeSingle: run,
      then: (ok, ng) => run().then(ok, ng),
    }
    return b
  }
  const from = (table) => builder({ table, action: 'select', payload: undefined, filters: [] })
  const rpc = (fn, args) => builder({ table: null, action: 'rpc', fn, args, payload: undefined, filters: [] })
  const channel = () => {
    const ch = { on: () => ch, subscribe: () => ch }
    return ch
  }
  return { client: { from, rpc, channel, removeChannel: () => Promise.resolve(), auth: { onAuthStateChange() {} } }, calls }
}

const eqOf = (q) => Object.fromEntries(q.filters.filter(([op]) => op === 'eq').map(([, k, v]) => [k, v]))

/**
 * 事故・ヒヤリハットの偽のサーバー。client_key の全体 unique、rev の自動加算、氏名の写しのトリガ（0014 と同じ動き）、
 * app_settings・residents に答える。opts.offline() が true の間は通信できない。opts.missingTable は 0014 未適用（42P01）
 */
function incidentServer(opts = {}) {
  const db = {
    rows: [],
    nextId: 1,
    settings: {
      native_input_enabled: 'false',
      input_enabled_bath: 'false',
      input_enabled_med: 'false',
      input_enabled_incident: 'true',
      corp_name: '法人X',
      office_name_facility: '事業所X',
      office_no_facility: '',
    },
    residents: [
      { id: 1, source_id: 'S1', name: '利用者A', kana: null, room: '101', gender: '男', care_level: '要介護2', active: true, needs_review: false, note_alias: null },
      { id: 2, source_id: 'S2', name: '利用者B', kana: null, room: '201', gender: '女', care_level: '要支援1', active: true, needs_review: false, note_alias: null },
    ],
  }
  const match = (q, r) =>
    q.filters.every(([op, k, v]) => {
      if (op === 'eq' || op === 'is') return r[k] === v
      if (op === 'in') return v.includes(r[k])
      if (op === 'gte') return r[k] >= v
      if (op === 'lte') return r[k] <= v
      return true
    })
  const nameOf = (id) => db.residents.find((r) => r.id === id)?.name ?? null
  /** 0014 の incidents_subject_snapshot と同じ動き */
  const snapshot = (next, old) => {
    if (next.resident_id === null || next.resident_id === undefined) return
    const d = next.detail
    if (typeof d?.subject_name === 'string' && d.subject_name.trim() !== '') return
    if (old && old.resident_id === next.resident_id && typeof old.detail?.subject_name === 'string' && old.detail.subject_name !== '') {
      next.detail = { ...d, subject_name: old.detail.subject_name }
    } else {
      next.detail = { ...d, subject_name: nameOf(next.resident_id) }
    }
  }
  const pick = (row, cols) => {
    if (typeof cols !== 'string') return { ...row }
    const out = {}
    for (const c of cols.split(',')) if (c in row) out[c] = row[c]
    return out
  }
  const fake = fakeSupabase((q) => {
    if (opts.offline?.()) return { data: null, error: { message: 'offline' }, status: 0 }
    if (q.table === 'app_settings') {
      const inF = q.filters.find(([op]) => op === 'in')
      if (inF) return { data: inF[2].filter((k) => k in db.settings).map((k) => ({ key: k, value: db.settings[k] })), error: null, status: 200 }
      const key = eqOf(q).key
      return { data: key in db.settings ? { value: db.settings[key] } : null, error: null, status: 200 }
    }
    if (q.table === 'residents') return { data: db.residents.filter((r) => match(q, r)), error: null, status: 200 }
    if (q.table === 'incidents') {
      if (opts.missingTable) return { data: null, error: { code: '42P01', message: 'undefined table' }, status: 404 }
      if (q.action === 'insert') {
        const p = { ...q.payload, detail: { ...(q.payload.detail ?? {}) } }
        if (p.client_key && db.rows.some((r) => r.client_key === p.client_key)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' }, status: 409 }
        }
        snapshot(p, null)
        const row = { id: db.nextId++, rev: 1, status: 'open', deleted_at: null, edited_by: null, city_report_needed: false, ...p }
        db.rows.push(row)
        return { data: pick(row, q.cols), error: null, status: 201 }
      }
      if (q.action === 'update') {
        const r = db.rows.find((x) => match(q, x))
        if (!r) return { data: null, error: null, status: 200 }
        const next = { ...r, ...q.payload }
        snapshot(next, r)
        Object.assign(r, next, { rev: r.rev + 1 })
        return { data: pick(r, q.cols), error: null, status: 200 }
      }
      const hits = db.rows.filter((x) => match(q, x))
      for (const [col, asc] of [...(q.orders ?? [])].reverse()) {
        hits.sort((a, b) => (a[col] === b[col] ? 0 : (a[col] < b[col]) === asc ? -1 : 1))
      }
      if (q.limit === 1) return { data: hits[0] ? pick(hits[0], q.cols) : null, error: null, status: 200 }
      return { data: hits.slice(0, q.limit ?? hits.length).map((x) => pick(x, q.cols)), error: null, status: 200 }
    }
    if (q.action === 'select') return { data: [], error: null, status: 200 }
    return { data: null, error: { code: 'X', message: 'unexpected' }, status: 500 }
  })
  return { ...fake, db }
}

function storedOps() {
  const raw = lsStore.get('cl_sendQueue')
  return raw === undefined ? [] : (JSON.parse(raw).ops ?? [])
}

async function drain() {
  await new Promise((r) => setTimeout(r, 10))
  lsStore.delete('cl_sendQueue')
  lsStore.delete('cl_sendQueue2')
  await DB.__testHooks.restartQueue()
  DB.__testHooks.setClient(null)
}

if (DB === null || I === null) {
  it('事故・ヒヤリハットの db.ts の検証', { skip: DB_UNSUPPORTED }, () => {})
} else {
  describe('事故・ヒヤリハット（db.ts）: 種類ごとの入力解禁 input_enabled_incident', () => {
    afterEach(drain)

    it('input_enabled_incident が false なら、native・入浴・与薬が解禁でも書かずに事故の理由文で止める（追加・追記・取り消し）', async () => {
      const srv = incidentServer()
      Object.assign(srv.db.settings, { native_input_enabled: 'true', input_enabled_bath: 'true', input_enabled_med: 'true', input_enabled_incident: 'false' })
      DB.__testHooks.setClient(srv.client, { kinds: { bath: null, med: null, incident: null } })
      await assert.rejects(() => DB.insertIncident(firstReport()), (e) => e.kind === 'blocked' && e.message === DB.kindBlockedMessage('incident'))
      const cur = { id: 5, ...firstReport(), rev: 1 }
      await assert.rejects(() => DB.updateIncident(cur, { detail: { cause: 'x' } }), (e) => e.kind === 'blocked')
      await assert.rejects(() => DB.softDeleteIncident(5, 1), (e) => e.kind === 'blocked')
      assert.equal(srv.calls.filter((q) => q.table === 'incidents').length, 0, '封鎖中に書き込んだ')
      assert.deepEqual(await DB.getKindInputGate('incident'), { value: false, observed: true })
    })

    it('input_enabled_incident が true なら native・入浴・与薬が封鎖でも書ける（旗は独立）・他の種類は止まったまま', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client, { native: false, kinds: { bath: false, med: false, incident: null } })
      const row = await DB.insertIncident(firstReport())
      assert.equal(row.kind, 'accident')
      await assert.rejects(
        () => DB.insertMedAdmin({ resident_id: 1, admin_on: '2026-09-01', slot: 'morning', status: 'taken', given_at: null, prn_drug: null, prn_reason: null, prn_effect: null, note: null, recorded_by: 1 }),
        (e) => e.kind === 'blocked',
      )
    })

    it('旗を取得できない（未観測）時は gate-unknown で書かない', async () => {
      const off = fakeSupabase(() => ({ data: null, error: { message: 'offline' }, status: 0 }))
      DB.__testHooks.setClient(off.client, { kinds: { incident: null } })
      assert.deepEqual(await DB.getKindInputGate('incident'), { value: false, observed: false })
      await assert.rejects(() => DB.insertIncident(firstReport()), (e) => e.kind === 'gate-unknown')
    })
  })

  describe('事故・ヒヤリハット（db.ts）: 第1報・追記・確認・完了・取り消し', () => {
    afterEach(drain)

    it('insertIncident は client_key を付けて1行追加し、氏名は送らない（サーバーが名簿から写す）', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      const row = await DB.insertIncident(firstReport({}, { subject_name: null }))
      const ins = srv.calls.find((q) => q.table === 'incidents' && q.action === 'insert')
      assert.equal(typeof ins.payload.client_key, 'string')
      assert.equal('subject_name' in ins.payload.detail, false, '氏名を送った')
      assert.equal(JSON.stringify(ins.payload).includes('利用者A'), false)
      assert.equal(row.detail.subject_name, '利用者A', 'サーバーの写し')
      assert.equal(row.status, 'open')
      assert.equal(row.reporter_id, 3)
    })

    it('★氏名を渡しても送らない（名簿の値だけを使う・2026-09-26 チーフ裁定）: 追加・追記とも payload に氏名が無い', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      const row = await DB.insertIncident(firstReport({}, { subject_name: '利用者A（別の名前）' }))
      assert.equal(row.detail.subject_name, '利用者A', '名簿の値ではない')
      const ins = srv.calls.find((q) => q.action === 'insert')
      assert.equal('subject_name' in ins.payload.detail, false)
      const cur = await DB.fetchIncident(row.id)
      // 氏名だけの変更は送る物が無い（空の変更で止まる）・他の欄と一緒でも氏名は外す
      await assert.rejects(() => DB.updateIncident(cur, { detail: { subject_name: '別の名前' } }))
      const next = await DB.updateIncident(cur, { detail: { subject_name: '別の名前', cause: '原因A' } })
      const up = srv.calls.filter((q) => q.action === 'update').at(-1)
      assert.equal('subject_name' in up.payload.detail, false)
      assert.equal(JSON.stringify(up.payload).includes('名前'), false)
      assert.equal(next.detail.subject_name, '利用者A')
    })

    it('第1報の必須項目・「その他」の文字が無いと送る前に止める（書き込まない）', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      await assert.rejects(() => DB.insertIncident(firstReport({}, { situation: null })), /発生時状況/)
      await assert.rejects(() => DB.insertIncident(firstReport({ types: ['other'] })), /その他/)
      await assert.rejects(() => DB.insertIncident(firstReport({ resident_id: null })), /対象者/)
      assert.equal(srv.calls.filter((q) => q.table === 'incidents').length, 0)
    })

    it('updateIncident は変えた列と edited_by、detail は重ねた全体（氏名は送らない）を rev 照合で送る・古い rev は conflict', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      const first = await DB.insertIncident(firstReport())
      const cur = await DB.fetchIncident(first.id)
      const next = await DB.updateIncident(cur, { severity: 'treated', detail: { cause: '原因A' } }, { editedBy: 5 })
      assert.equal(next.rev, 2)
      assert.equal(next.severity, 'treated')
      assert.equal(next.detail.cause, '原因A')
      assert.equal(next.detail.situation, '状況A', '追記で他の欄が消えた')
      assert.equal(next.detail.subject_name, '利用者A', '氏名の写しが消えた')
      const up = srv.calls.filter((q) => q.table === 'incidents' && q.action === 'update').at(-1)
      assert.deepEqual(Object.keys(up.payload).sort(), ['detail', 'edited_by', 'severity'])
      assert.equal(up.payload.edited_by, 5)
      assert.equal('subject_name' in up.payload.detail, false, '追記で氏名を送った')
      assert.deepEqual(eqOf(up), { id: first.id, rev: 1 })
      assert.equal(await DB.updateIncident(cur, { detail: { cause: '原因B' } }), 'conflict')
    })

    it('対象者を変えた時は detail も送り、サーバーが新しい対象者の氏名を写す', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      const first = await DB.insertIncident(firstReport())
      const cur = await DB.fetchIncident(first.id)
      const next = await DB.updateIncident(cur, { resident_id: 2 }, { editedBy: 5 })
      const up = srv.calls.filter((q) => q.action === 'update').at(-1)
      assert.ok('detail' in up.payload)
      assert.equal(JSON.stringify(up.payload).includes('利用者'), false, '氏名を送った')
      assert.equal(next.detail.subject_name, '利用者B')
    })

    it('一覧の列だけの行（detail が空）を渡しても detail を空で上書きしない（検証で止まる）', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      await DB.insertIncident(firstReport())
      const [listed] = await DB.fetchIncidents({ fromIso: '2026-09-01', toIso: '2026-09-30' })
      assert.equal(listed.detail.situation, null, '一覧に detail を持ち出した')
      await assert.rejects(() => DB.updateIncident(listed, { detail: { cause: 'x' } }), /発生時状況/)
      assert.equal(srv.calls.filter((q) => q.action === 'update').length, 0)
      assert.equal(srv.db.rows[0].detail.situation, '状況A')
    })

    it('確認（確認者・日時）・完了・報告区分と提出日・市への報告を保存できる', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      const first = await DB.insertIncident(firstReport())
      let cur = await DB.fetchIncident(first.id)
      cur = await DB.updateIncident(cur, { confirmer_id: 7, confirmed_at: '2026-09-21T01:00:00.000Z' }, { editedBy: 7 })
      assert.deepEqual([cur.confirmer_id, cur.confirmed_at], [7, '2026-09-21T01:00:00.000Z'])
      cur = await DB.updateIncident(cur, { status: 'closed', report_stage: 'nth', report_no: 2, submitted_on: '2026-09-22', city_report_needed: true, city_reported_on: '2026-09-22' })
      assert.deepEqual([cur.status, cur.report_stage, cur.report_no, cur.submitted_on, cur.city_report_needed], ['closed', 'nth', 2, '2026-09-22', true])
      await assert.rejects(() => DB.updateIncident(cur, { report_stage: 'nth', report_no: 1 }), /2 以上/)
    })

    it('softDeleteIncident は deleted_at と edited_by の update（物理削除しない）・取り消した記録は読めない', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      const row = await DB.insertIncident(firstReport())
      assert.equal(await DB.softDeleteIncident(row.id, row.rev, { editedBy: 4 }), true)
      const up = srv.calls.filter((q) => q.action === 'update').at(-1)
      assert.deepEqual(Object.keys(up.payload).sort(), ['deleted_at', 'edited_by'])
      assert.equal(up.payload.edited_by, 4)
      assert.equal(await DB.softDeleteIncident(row.id, row.rev), 'conflict', '取り消し済みを二重に取り消した')
      assert.equal(await DB.fetchIncident(row.id), null)
      assert.equal(srv.db.rows.length, 1, '行が消えた')
    })
  })

  describe('事故・ヒヤリハット（db.ts）: 送信待ち（cl_sendQueue）・hasPendingIncident・pendingIncidentOps', () => {
    afterEach(drain)

    it('通信できない第1報は incidents の op として残り（氏名は入れない）、次の起動でも読めて、電波が戻ると同じキーで1行だけ載る', async () => {
      let off = true
      const srv = incidentServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.insertIncident(firstReport({}, { subject_name: null })), 'queued')
      const ops = storedOps()
      assert.equal(ops.length, 1)
      assert.deepEqual([ops[0].table, ops[0].kind], ['incidents', 'insert'])
      assert.equal(ops[0].qid, ops[0].payload.client_key)
      assert.equal(lsStore.get('cl_sendQueue').includes('利用者A'), false, '送信待ちに氏名を置いた')
      await DB.__testHooks.restartQueue() // 次の起動（LEGACY_TABLES に incidents があるので捨てずに読める）
      assert.equal(DB.queuePending(), 1)
      assert.equal(DB.isQueueBroken(), false)
      off = false
      await DB.flushQueue(true)
      assert.equal(srv.db.rows.length, 1)
      assert.equal(srv.db.rows[0].detail.subject_name, '利用者A')
      assert.equal(DB.queuePending(), 0)
      await DB.flushQueue(true)
      assert.equal(srv.db.rows.length, 1)
    })

    it('★送信待ち（cl_sendQueue）の payload に氏名が入らない: 氏名を渡した追加・追記・対象者の変更（圏外）', async () => {
      let off = false
      const srv = incidentServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      const first = await DB.insertIncident(firstReport())
      const cur = await DB.fetchIncident(first.id)
      off = true
      assert.equal(await DB.insertIncident(firstReport({}, { subject_name: '利用者A' })), 'queued')
      assert.equal(await DB.updateIncident(cur, { resident_id: 2, detail: { subject_name: '利用者B', cause: 'x' } }), 'queued')
      const raw = lsStore.get('cl_sendQueue')
      assert.equal(storedOps().length, 2)
      assert.equal(/利用者/.test(raw), false, '送信待ちに氏名が入った')
      for (const op of storedOps()) assert.equal('subject_name' in (op.payload.detail ?? {}), false)
      off = false
      await DB.flushQueue(true)
      assert.equal(srv.db.rows.find((r) => r.id === first.id).detail.subject_name, '利用者B', '対象者を変えたらサーバーが写し直す')
      assert.equal(srv.db.rows.length, 2)
    })

    it('pendingIncidentOps: 送信待ちの追加を読むだけ（未送信・止まっているを含む・送信待ちは変わらない）・送れたら消える', async () => {
      let off = true
      const srv = incidentServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      assert.deepEqual(DB.pendingIncidentOps(), [])
      assert.equal(await DB.insertIncident(firstReport({ kind: 'nearmiss', resident_id: null, types: ['fall', 'med_error'] })), 'queued')
      const before = lsStore.get('cl_sendQueue')
      const list = DB.pendingIncidentOps()
      assert.equal(list.length, 1)
      assert.deepEqual(
        { ...list[0], qid: typeof list[0].qid },
        { qid: 'string', kind: 'nearmiss', residentId: null, occurredOn: '2026-09-20', occurredAt: list[0].occurredAt, types: ['fall', 'med_error'], state: 'waiting' },
      )
      assert.equal(lsStore.get('cl_sendQueue'), before, '読んだだけで送信待ちが変わった')
      const raw = JSON.parse(before)
      raw.ops[0].blocked = 'rejected'
      lsStore.set('cl_sendQueue', JSON.stringify(raw))
      await DB.__testHooks.restartQueue()
      assert.equal(DB.pendingIncidentOps()[0].state, 'blocked')
      raw.ops[0].blocked = undefined
      lsStore.set('cl_sendQueue', JSON.stringify(raw))
      await DB.__testHooks.restartQueue()
      off = false
      await DB.flushQueue(true)
      assert.deepEqual(DB.pendingIncidentOps(), [])
      assert.equal(srv.db.rows.length, 1)
    })

    it('hasPendingIncident: 追記・取り消しの送信待ちはその記録で true、送れたら false（blocked は含めない）', async () => {
      let off = false
      const srv = incidentServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      const first = await DB.insertIncident(firstReport())
      const cur = await DB.fetchIncident(first.id)
      off = true
      assert.equal(DB.hasPendingIncident(first.id), false)
      assert.equal(await DB.updateIncident(cur, { detail: { cause: '原因A' } }, { editedBy: 6 }), 'queued')
      assert.equal(DB.hasPendingIncident(first.id), true)
      assert.equal(DB.hasPendingIncident(first.id + 1), false)
      const op = storedOps()[0]
      assert.deepEqual([op.table, op.kind, op.rowId, op.rev], ['incidents', 'update', first.id, 1])
      assert.equal(JSON.stringify(op.payload).includes('利用者A'), false, '送信待ちに氏名を置いた')
      off = false
      await DB.flushQueue(true)
      assert.equal(DB.hasPendingIncident(first.id), false)
      assert.equal(srv.db.rows[0].detail.cause, '原因A')
      assert.equal(srv.db.rows[0].detail.subject_name, '利用者A')
    })

    it('★送信待ちの間に他の端末が同じ記録を変えた → 止めて残す（blocked=conflict・未送信として数え続け、hasPendingIncident は false）', async () => {
      let off = false
      const srv = incidentServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      const first = await DB.insertIncident(firstReport())
      const cur = await DB.fetchIncident(first.id)
      off = true
      assert.equal(await DB.updateIncident(cur, { detail: { cause: '原因A' } }), 'queued')
      srv.db.rows[0].rev = 5 // 他の端末が先に変えた
      off = false
      await DB.flushQueue(true)
      const ops = storedOps()
      assert.equal(ops.length, 1)
      assert.equal(ops[0].blocked, 'conflict')
      assert.equal(DB.queuePending(), 1)
      assert.equal(DB.hasPendingIncident(first.id), false)
      assert.equal(srv.db.rows[0].detail.cause, null)
    })

    it('★送信待ちの op は事故・ヒヤリハットの操作の前後で（送れた分が消える以外に）変わらない', async () => {
      let off = true
      const srv = incidentServer({ offline: () => off })
      DB.__testHooks.setClient(srv.client)
      assert.equal(await DB.insertIncident(firstReport()), 'queued')
      assert.equal(await DB.insertIncident(firstReport({ kind: 'nearmiss', resident_id: null })), 'queued')
      assert.equal(await DB.softDeleteIncident(9, 1), 'queued')
      const snap = (ops) => ops.map((o) => JSON.stringify([o.qid, o.table, o.kind, o.rowId ?? null, o.rev ?? null, o.payload]))
      const before = snap(storedOps())
      assert.equal(before.length, 3)
      DB.hasPendingIncident(9)
      DB.pendingIncidentOps()
      await DB.__testHooks.restartQueue()
      assert.deepEqual(snap(storedOps()), before, '読むだけの関数・再起動で送信待ちが変わった')
      srv.db.rows.push({ id: 9, ...firstReport(), detail: { situation: 'x', response: 'y' }, rev: 1, deleted_at: null, client_key: 'x9' })
      off = false
      await DB.flushQueue(true)
      assert.deepEqual(storedOps(), [], '送れた op が残った')
      assert.equal(srv.db.rows.filter((r) => r.id !== 9).length, 2)
      assert.notEqual(srv.db.rows.find((r) => r.id === 9).deleted_at, null)
    })
  })

  describe('事故・ヒヤリハット（db.ts）: 取得の範囲・カルテ・事業所の情報・表が無い DB', () => {
    afterEach(drain)

    it('fetchIncidents は発生日の期間・区分・状態で絞り、新しい順・削除済みを除き、detail を持ち出さない', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      const a = await DB.insertIncident(firstReport({ occurred_on: '2026-09-01', occurred_at: at('2026-09-01', '09:00') }))
      const b = await DB.insertIncident(firstReport({ kind: 'nearmiss', resident_id: null, occurred_on: '2026-09-10', occurred_at: at('2026-09-10', '09:00') }))
      await DB.insertIncident(firstReport({ occurred_on: '2026-08-31', occurred_at: at('2026-08-31', '09:00') }))
      const c = await DB.insertIncident(firstReport({ occurred_on: '2026-09-11', occurred_at: at('2026-09-11', '09:00') }))
      await DB.softDeleteIncident(c.id, c.rev)
      const all = await DB.fetchIncidents({ fromIso: '2026-09-01', toIso: '2026-09-30' })
      assert.deepEqual(all.map((r) => r.id), [b.id, a.id])
      const q = srv.calls.filter((x) => x.table === 'incidents' && x.action === 'select').at(-1)
      assert.equal(q.cols.split(',').includes('detail'), false, '一覧で detail を持ち出した')
      assert.ok(q.filters.some(([op, k, v]) => op === 'is' && k === 'deleted_at' && v === null))
      assert.deepEqual(q.orders.map(([c2]) => c2), ['occurred_on', 'occurred_at', 'id'])
      assert.deepEqual((await DB.fetchIncidents({ fromIso: '2026-09-01', toIso: '2026-09-30', kind: 'accident' })).map((r) => r.id), [a.id])
      assert.deepEqual((await DB.fetchIncidents({ fromIso: '2026-09-01', toIso: '2026-09-30', status: 'closed' })).map((r) => r.id), [])
      await assert.rejects(() => DB.fetchIncidents({ fromIso: '2026-09-30', toIso: '2026-09-01' }))
      await assert.rejects(() => DB.fetchIncidents({ fromIso: 'x', toIso: '2026-09-01' }))
    })

    it('fetchOpenIncidentsUntil: その日までに発生して対応中の記録（前月以前も・完了と削除済みと後の日は除く・古い順・detail なし）', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      const mk = (day, over = {}) => DB.insertIncident(firstReport({ occurred_on: day, occurred_at: at(day, '09:00'), ...over }))
      const a = await mk('2026-07-01')
      const b = await mk('2026-09-20')
      await mk('2026-09-21') // 指定の日より後に発生 → 除く
      const c = await mk('2026-08-01')
      await DB.updateIncident(await DB.fetchIncident(c.id), { status: 'closed' })
      const d = await mk('2026-08-02')
      await DB.softDeleteIncident(d.id, d.rev)
      const rows = await DB.fetchOpenIncidentsUntil('2026-09-20')
      assert.deepEqual(rows.map((r) => r.id), [a.id, b.id])
      const q = srv.calls.filter((x) => x.table === 'incidents' && x.action === 'select').at(-1)
      assert.deepEqual(eqOf(q), { status: 'open' })
      assert.equal(q.cols.split(',').includes('detail'), false)
      await assert.rejects(() => DB.fetchOpenIncidentsUntil('bogus'))
    })

    it('受信値を信じない: 知らない区分の行は落とし、知らない場所・種別・程度は空にする', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      srv.db.rows.push(
        { id: 1, ...firstReport(), kind: 'bogus', rev: 1, deleted_at: null },
        { id: 2, ...firstReport(), place: 'garden', types: ['fall', 'slip'], severity: 'minor', rev: 1, deleted_at: null },
      )
      const rows = await DB.fetchIncidents({ fromIso: '2026-09-01', toIso: '2026-09-30' })
      assert.deepEqual(rows.map((r) => [r.id, r.place, r.types, r.severity]), [[2, null, ['fall'], null]])
    })

    it('fetchKarte は本人・期間の事故・ヒヤリを返し（detail なし）、表が無い（0014 未適用）時は空・一覧は「サーバー側の設定待ち」', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      const a = await DB.insertIncident(firstReport({ occurred_on: '2026-09-05', occurred_at: at('2026-09-05', '09:00') }))
      const k = await DB.fetchKarte(1, '2026-09-01', '2026-09-30')
      assert.deepEqual(k.incidents.map((i) => [i.id, i.kind]), [[a.id, 'accident']])
      const q = srv.calls.filter((x) => x.table === 'incidents' && x.action === 'select').at(-1)
      assert.equal(q.cols.split(',').includes('detail'), false)
      assert.deepEqual(eqOf(q), { resident_id: 1 })
      const missing = incidentServer({ missingTable: true })
      DB.__testHooks.setClient(missing.client)
      const k2 = await DB.fetchKarte(1, '2026-09-01', '2026-09-30')
      assert.deepEqual(k2.incidents, [])
      await assert.rejects(() => DB.fetchIncidents({ fromIso: '2026-09-01', toIso: '2026-09-30' }), /サーバー側の設定待ち/)
    })

    it('fetchOfficeProfile: 事業所の情報を1回で読み、無い・空の値は空文字（印刷は空欄）', async () => {
      const srv = incidentServer()
      DB.__testHooks.setClient(srv.client)
      const p = await DB.fetchOfficeProfile()
      assert.deepEqual(p, {
        corpName: '法人X',
        address: '',
        officeName: { facility: '事業所X', visit: '', daycare: '' },
        officeNo: { facility: '', visit: '', daycare: '' },
      })
      const q = srv.calls.filter((x) => x.table === 'app_settings').at(-1)
      assert.deepEqual(q.filters.find(([op]) => op === 'in')[2].sort(), [
        'corp_name',
        'office_address',
        'office_name_daycare',
        'office_name_facility',
        'office_name_visit',
        'office_no_daycare',
        'office_no_facility',
        'office_no_visit',
      ])
    })
  })
}

// ══════════════════════════════════════════════════════════════
// 3. 配線（静的検査）
// ══════════════════════════════════════════════════════════════

describe('事故・ヒヤリハットの配線（静的検査）', () => {
  /** 注記（-- の後ろ）を除いた、実際に流れる SQL */
  const sql = () =>
    read('../supabase/migrations/0014_incidents.sql')
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n')

  it('0014: restrictive の member_only・delete ポリシーなし・do $$ なし・Realtime は add table・初回のみの注記', () => {
    const s = sql()
    assert.match(
      s,
      /create policy member_only on public\.incidents as restrictive for all to authenticated\s+using \(private\.is_member\(\)\) with check \(private\.is_member\(\)\);/,
    )
    assert.match(s, /alter publication supabase_realtime add table public\.incidents;/)
    assert.equal(/for delete/i.test(s), false)
    assert.equal(/do\s+\$\$/i.test(s), false)
    assert.equal(/alter publication supabase_realtime\s+set table/i.test(s), false)
    assert.match(s, /notify pgrst, 'reload schema';/)
    assert.match(read('../supabase/migrations/0014_incidents.sql'), /初回に1回だけ流す/)
  })

  it('0014: 変更の記録のトリガ（occurred_on）・rev・索引・client_key・事業所のキーは値 空で既存を触らない', () => {
    const s = sql()
    assert.match(s, /record_history_capture\('occurred_on'\)/)
    assert.match(s, /execute function public\.set_updated_at_rev\(\)/)
    assert.match(s, /create index if not exists idx_incidents_timeline\s+on public\.incidents \(occurred_on desc, id desc\)/)
    assert.match(s, /create index if not exists idx_incidents_resident\s+on public\.incidents \(resident_id, occurred_on desc\)/)
    assert.match(s, /client_key\s+text unique/)
    for (const k of ['corp_name', 'office_name_facility', 'office_name_visit', 'office_name_daycare', 'office_no_facility', 'office_no_visit', 'office_no_daycare', 'office_address']) {
      assert.match(s, new RegExp(`\\('${k}', ''\\)`), k)
    }
    assert.match(s, /\('office_address', ''\)\s+on conflict \(key\) do nothing;/)
  })

  it('App.tsx に /incident・/incident/new・/incident/:id・/incident/summary のルートと画面名・現在地の既知値がある', () => {
    const app = read('../src/App.tsx')
    for (const p of ['/incident', '/incident/new', '/incident/:id', '/incident/summary']) {
      assert.match(app, new RegExp(`path="${p.replace(/\//g, '\\/')}"`), p)
    }
    for (const t of ["'事故・ヒヤリハット'", "'事故・ヒヤリ 月次集計'", "'incident'", "'incidentSummary'"]) assert.ok(app.includes(t), t)
  })

  it('記録ハブは事故だけ input_enabled_incident で封鎖を判定し（入浴・与薬・その他の判定は変えない）、その他に一覧と月次集計がある', () => {
    const hub = read('../src/pages/RecordHubPage.tsx')
    assert.match(hub, /getKindInputGate\('incident'\)/)
    assert.match(hub, /key === 'incident' \? incidentLocked : key === 'bath' \? bathLocked : key === 'med' \? medLocked : locked/)
    assert.match(hub, /to: '\/incident'/)
    const more = read('../src/pages/MorePage.tsx')
    assert.match(more, /to: '\/incident'/)
    assert.match(more, /to: '\/incident\/summary'/)
    // 「記録」の入口の封鎖の判定は変えない
    assert.match(more, /const recordLocked = locked && !bathEnabled && !medEnabled/)
  })

  it('与薬チェックの落薬・誤薬は /incident/new へ利用者 id・日付・種別だけを渡す（氏名を URL に載せない）', () => {
    const med = read('../src/pages/MedRecordPage.tsx')
    assert.match(med, /事故・ヒヤリハットを記録する/)
    assert.match(med, /new URLSearchParams\(\{ resident: String\(target\.residentId\), date: target\.day, type: 'med_error' \}\)/)
    assert.match(med, /navigate\(`\/incident\/new\?\$\{q\.toString\(\)\}`\)/)
    assert.equal(/今は紙の事故報告書へ/.test(med), false)
  })

  it('月次集計は名簿を読まない（氏名を出さない）・事故の画面は日付・入力を localStorage に保存しない・console に出さない', () => {
    const strip = (src) => src.replace(/\/\/.*$/gm, '')
    const summary = strip(read('../src/pages/IncidentSummaryPage.tsx'))
    assert.equal(/fetchAllResidents|fetchResidents|\.name\b|subject_name/.test(summary), false)
    for (const p of ['../src/pages/IncidentListPage.tsx', '../src/pages/IncidentFormPage.tsx', '../src/pages/IncidentSummaryPage.tsx', '../src/pages/IncidentReportSheet.tsx']) {
      const src = strip(read(p))
      assert.equal(/localStorage/.test(src), false, p)
      assert.equal(/console\./.test(read(p)), false, p)
    }
    assert.equal(/console\./.test(read('../src/lib/incident.ts')), false)
  })

  it('★氏名は画面で直せない（入力欄を持たない）・対応中に戻す（確認つき）・カルテの行から記録を開く', () => {
    const form = read('../src/pages/IncidentFormPage.tsx')
    assert.equal(/setDetail\(\{ subject_name/.test(form), false, '氏名を入力できる')
    assert.match(form, /ここでは直せません/)
    assert.match(form, /title="対応中に戻しますか"/)
    assert.match(form, /void save\(\{ status: 'open' \}\)/)
    assert.match(read('../src/pages/KartePage.tsx'), /to=\{`\/incident\/\$\{i\.id\}`\}/)
    assert.match(read('../src/pages/IncidentSummaryPage.tsx'), /fetchOpenIncidentsUntil\(range\.to\)/)
  })

  it('印刷: 事故報告書は A4 縦（PrintArea orientation="portrait"）・様式の見出しと注記・□／■', () => {
    const form = read('../src/pages/IncidentFormPage.tsx')
    assert.match(form, /<PrintArea ref=\{printRef\} orientation="portrait"/)
    const sheet = read('../src/pages/IncidentReportSheet.tsx')
    assert.match(sheet, /事故報告書　（事業者→熊本市）/)
    assert.match(sheet, /<thead>/, '見出しを2枚目にも繰り返すため thead に置く')
    const inc = read('../src/lib/incident.ts')
    assert.match(inc, /※第１報（電話での第一報を除く）は、少なくとも1から6までについては可能な限り記載し、事故発生後速やかに、遅くとも５日以内を目安に提出すること/)
    assert.match(inc, /※選択肢については該当する項目をチェックし、該当する項目が複数ある場合は全て選択すること/)
    assert.match(read('../src/pages/IncidentSummaryPage.tsx'), /<PrintArea ref=\{printRef\} orientation="portrait">/)
  })
})
