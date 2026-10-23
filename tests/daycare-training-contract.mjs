// 移行 0046（デイ 段階3: 個別機能訓練の実施記録・居宅訪問・計画書の期限の写し・その日の配置・旗 input_enabled_daycare_training）の契約。
// 素の Postgres で tests/daycare-training-pg.mjs が流す（tests/pg-run-all.mjs から）。
// 段階3の計画 v1（【AI取締役】の 20261023_段階3_計画_v1.md）の 3章と 10章の DB の層を確かめる。
//
// ・TRAINING_CASES … 1件ずつ「準備（postgres の権限）→ 操作（authenticated／anon・member の有無・役割を切り替える）→ 観測」を行い、
//     expect と突き合わせる。各件は1つのトランザクションの中で動き、最後に必ず rollback する（表に何も残さない）。
// ・npm test では DB を使わない。移行の文面の静的検査と端末側の試験は tests/daycare-training.test.mjs。
//
// 個人情報は置かない（利用者は架空の「見本」姓・職員は 職員01 と数値IDだけ）。

export { checkDaycareCase as checkTrainingCase } from './daycare-contract.mjs'

/** 準備: 職員2人・利用者3人（架空）。ID は固定（overriding system value） */
export const TRAINING_SEED_SQL = [
  `insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02') on conflict (id) do nothing`,
  `insert into residents (id, source_id, name, active) overriding system value values
     (1, 'M001', '見本 一郎', true),
     (2, 'M002', '見本 花子', true),
     (3, 'M003', '見本 次郎', true)
   on conflict (id) do nothing`,
]

/** 日本時間の今日からの差の日付（'YYYY-MM-DD'） */
const dayOf = async (h, delta) =>
  (await h.pg(`select ((now() at time zone 'Asia/Tokyo')::date + $1::int)::text as d`, [delta]))[0].d

/** authenticated で実施記録を1行足す（id を返す）。失敗は { error: SQLSTATE } */
const addSession = (h, v, opts = {}) =>
  h.as(opts, (q) =>
    q(
      `insert into public.daycare_training_sessions
         (resident_id, day, started_at, duration_min, program, result, cancel_reason, cancel_note, instructor_id, recorded_by, client_key)
       values ($1, $2::date, $3::time, $4, $5, $6, $7, $8, $9, 1, $10) returning id, rev`,
      [
        v.resident ?? 1,
        v.day,
        'started' in v ? v.started : '10:00',
        'duration' in v ? v.duration : 20,
        'program' in v ? v.program : '立ち上がりの練習',
        v.result ?? 'done',
        v.reason ?? null,
        v.note ?? null,
        'instructor' in v ? v.instructor : 1,
        v.ck ?? null,
      ],
    ),
  )

const addVisit = (h, v, opts = {}) =>
  h.as(opts, (q) =>
    q(
      `insert into public.daycare_home_visits
         (resident_id, visited_on, visitor_id, purpose, life_status, explained_to, explained_on, explanation, recorded_by, client_key)
       values ($1, $2::date, 1, $3, $4, $5, $6::date, $7, 1, $8) returning id`,
      [v.resident ?? 1, v.on, v.purpose ?? 'periodic', 'life' in v ? v.life : '居室での立ち座りは手すりで自立', v.to ?? null, v.explainedOn ?? null, v.explanation ?? null, v.ck ?? null],
    ),
  )

const addStaffing = (h, v, opts = {}) =>
  h.as(opts, (q) =>
    q(
      `insert into public.daycare_staffing (day, staff_id, role, from_time, to_time, recorded_by, client_key)
       values ($1::date, $2, $3, $4::time, $5::time, 1, $6) returning id`,
      [v.day, v.staff ?? 1, v.role ?? 'trainer', v.from ?? null, v.to ?? null, v.ck ?? null],
    ),
  )

const sync = (h, rows, settings, opts = {}) =>
  h.as(opts, (q) => q(`select public.daycare_training_due_sync($1::jsonb, $2::jsonb, 1) as r`, [JSON.stringify(rows), JSON.stringify(settings ?? {})]))

const res = (r) => (Array.isArray(r) ? 'ok' : r.error)

export const TRAINING_CASES = [
  {
    id: 'T1',
    name: '旗 input_enabled_daycare_training が false で入る・職員は書けない（0022）・デイと活動の旗は別の行のまま',
    async run(h) {
      const v = (await h.pg(`select value from public.app_settings where key = 'input_enabled_daycare_training'`))[0]?.value ?? null
      const day = (await h.pg(`select count(*)::int as n from public.app_settings where key in ('input_enabled_daycare', 'input_enabled_daycare_activity')`))[0].n
      const r = await h.as({ appRole: 'office' }, (q) => q(`update public.app_settings set value = 'true' where key = 'input_enabled_daycare_training'`))
      return { value: v, otherFlags: day, officeWrite: r.error ?? 'wrote' }
    },
    expect: { value: 'false', otherFlags: 2, officeWrite: '42501' },
  },
  {
    id: 'T2',
    name: '実施記録: 許可リストの職員は足せる・読める（rev 1）。許可リスト外と anon は読めず書けない。物理削除はできない',
    async run(h) {
      const today = await dayOf(h, 0)
      const ok = await addSession(h, { day: today, ck: 't2-1' })
      const outsider = await addSession(h, { day: today, resident: 2, ck: 't2-2' }, { member: false })
      const anon = await addSession(h, { day: today, resident: 2, ck: 't2-3' }, { role: 'anon' })
      const anonRead = await h.as({ role: 'anon' }, (q) => q(`select id from public.daycare_training_sessions`))
      const del = await h.as({}, (q) => q(`delete from public.daycare_training_sessions`))
      return { ok: Array.isArray(ok) ? ok[0].rev : ok.error, outsider: res(outsider), anon: res(anon), anonRead: res(anonRead), del: res(del) }
    },
    expect: { ok: 1, outsider: '42501', anon: '42501', anonRead: '42501', del: '42501' },
  },
  {
    id: 'T3',
    name: '必須5項目（実施した記録）: 開始時刻・内容・時間・指導員・結果を1つずつ欠かすと入らない（23502 か 23514）',
    async run(h) {
      const today = await dayOf(h, 0)
      return {
        noStart: res(await addSession(h, { day: today, started: null, ck: 't3-1' })),
        noProgram: res(await addSession(h, { day: today, program: '', ck: 't3-2' })),
        blankProgram: res(await addSession(h, { day: today, program: ' 体操', ck: 't3-2b' })),
        noDuration: res(await addSession(h, { day: today, duration: null, ck: 't3-3' })),
        noInstructor: res(await addSession(h, { day: today, instructor: null, ck: 't3-4' })),
        badResult: res(await addSession(h, { day: today, result: 'skipped', ck: 't3-5' })),
        tooLong: res(await addSession(h, { day: today, duration: 241, ck: 't3-6' })),
        zero: res(await addSession(h, { day: today, duration: 0, ck: 't3-7' })),
        partial: res(await addSession(h, { day: today, result: 'partial', duration: 10, ck: 't3-8' })),
      }
    },
    expect: { noStart: '23502', noProgram: '23514', blankProgram: '23514', noDuration: '23514', noInstructor: '23502', badResult: '23514', tooLong: '23514', zero: '23514', partial: 'ok' },
  },
  {
    id: 'T4',
    name: '中止の決まり: 時間は持たない・理由が必須・中止でないのに理由は不可・その他は一言が要る（空白だけは不可）',
    async run(h) {
      const today = await dayOf(h, 0)
      return {
        withDuration: res(await addSession(h, { day: today, result: 'cancelled', reason: 'condition', duration: 20, ck: 't4-1' })),
        noReason: res(await addSession(h, { day: today, result: 'cancelled', duration: null, ck: 't4-2' })),
        reasonOnDone: res(await addSession(h, { day: today, reason: 'condition', ck: 't4-3' })),
        otherBlank: res(await addSession(h, { day: today, result: 'cancelled', duration: null, reason: 'other', note: '   ', ck: 't4-4' })),
        badReason: res(await addSession(h, { day: today, result: 'cancelled', duration: null, reason: 'absent', ck: 't4-5' })),
        ok: res(await addSession(h, { day: today, result: 'cancelled', duration: null, reason: 'other', note: '受診のため', ck: 't4-6' })),
      }
    },
    expect: { withDuration: '23514', noReason: '23514', reasonOnDone: '23514', otherBlank: '23514', badReason: '23514', ok: 'ok' },
  },
  {
    id: 'T5',
    name: '1人1日1件（部分 unique）: 同じ方・同じ日の2件目は 23505。別の日・別の方は入る。取り消した後は入れ直せる',
    async run(h) {
      const today = await dayOf(h, 0)
      const yday = await dayOf(h, -1)
      const first = await addSession(h, { day: today, ck: 't5-1' })
      const dup = await addSession(h, { day: today, result: 'partial', duration: 5, ck: 't5-2' })
      const otherDay = await addSession(h, { day: yday, ck: 't5-3' })
      const otherRes = await addSession(h, { day: today, resident: 2, ck: 't5-4' })
      await h.as({}, (q) => q(`update public.daycare_training_sessions set deleted_at = now(), deleted_by = 1 where id = $1`, [first[0].id]))
      const again = await addSession(h, { day: today, ck: 't5-5' })
      return { dup: res(dup), otherDay: res(otherDay), otherRes: res(otherRes), again: res(again) }
    },
    expect: { dup: '23505', otherDay: 'ok', otherRes: 'ok', again: 'ok' },
  },
  {
    id: 'T6',
    name: '過去の日の守り（実施記録・配置）: 現場は昨日を足せず直せない（42501・daycare_training_past_office_only）。事務所は通る。未来の日の実施記録は誰も書けない（22023）',
    async run(h) {
      const today = await dayOf(h, 0)
      const yday = await dayOf(h, -1)
      const tmr = await dayOf(h, 1)
      const fieldToday = await addSession(h, { day: today, ck: 't6-1' }, { appRole: 'field' })
      const fieldYday = await addSession(h, { day: yday, resident: 2, ck: 't6-2' }, { appRole: 'field' })
      const officeYday = await addSession(h, { day: yday, resident: 2, ck: 't6-3' }, { appRole: 'office' })
      const fieldEdit = await h.as({ appRole: 'field' }, (q) =>
        q(`update public.daycare_training_sessions set program = '歩行の練習' where id = $1 returning id`, [officeYday[0].id]),
      )
      const officeEdit = await h.as({ appRole: 'office' }, (q) =>
        q(`update public.daycare_training_sessions set program = '歩行の練習' where id = $1 returning id`, [officeYday[0].id]),
      )
      const officeFuture = await addSession(h, { day: tmr, resident: 3, ck: 't6-4' }, { appRole: 'office' })
      const staffYday = await addStaffing(h, { day: yday, ck: 't6-5' }, { appRole: 'field' })
      const staffYdayOffice = await addStaffing(h, { day: yday, ck: 't6-6' }, { appRole: 'office' })
      return {
        fieldToday: res(fieldToday),
        fieldYday: res(fieldYday),
        officeYday: res(officeYday),
        fieldEdit: res(fieldEdit),
        officeEdit: res(officeEdit),
        officeFuture: res(officeFuture),
        staffYday: res(staffYday),
        staffYdayOffice: res(staffYdayOffice),
      }
    },
    expect: {
      fieldToday: 'ok',
      fieldYday: '42501',
      officeYday: 'ok',
      fieldEdit: '42501',
      officeEdit: 'ok',
      officeFuture: '22023',
      staffYday: '42501',
      staffYdayOffice: 'ok',
    },
  },
  {
    id: 'T7',
    name: '居宅訪問: 現場も後日に記録し、後日に説明を足せる。未来の訪問日・説明の日は止まる（22023）。生活の状況は必須。同じ日・同じ目的は1件（初回と定期は別）',
    async run(h) {
      const yday = await dayOf(h, -1)
      const tmr = await dayOf(h, 1)
      const past = await addVisit(h, { on: yday, ck: 't7-1' }, { appRole: 'field' })
      const explain = await h.as({ appRole: 'field' }, (q) =>
        q(`update public.daycare_home_visits set explained_to = 'family', explanation = '進み具合を電話で説明' where id = $1 returning id`, [past[0].id]),
      )
      const explainOn = await h.as({ appRole: 'field' }, (q) =>
        q(`update public.daycare_home_visits set explained_on = (now() at time zone 'Asia/Tokyo')::date where id = $1 returning id`, [past[0].id]),
      )
      const future = await addVisit(h, { on: tmr, ck: 't7-2' })
      const futureExplain = await h.as({}, (q) => q(`update public.daycare_home_visits set explained_on = $2::date where id = $1 returning id`, [past[0].id, tmr]))
      const blank = await addVisit(h, { on: yday, resident: 2, life: '   ', ck: 't7-3' })
      const dup = await addVisit(h, { on: yday, ck: 't7-4' })
      const initialSameDay = await addVisit(h, { on: yday, purpose: 'initial', ck: 't7-5' })
      const badPurpose = await addVisit(h, { on: yday, resident: 3, purpose: 'other', ck: 't7-6' })
      return {
        past: res(past),
        explain: res(explain),
        explainOn: res(explainOn),
        future: res(future),
        futureExplain: res(futureExplain),
        blank: res(blank),
        dup: res(dup),
        initialSameDay: res(initialSameDay),
        badPurpose: res(badPurpose),
      }
    },
    expect: {
      past: 'ok',
      explain: 'ok',
      explainOn: 'ok',
      future: '22023',
      futureExplain: '22023',
      blank: '23514',
      dup: '23505',
      initialSameDay: 'ok',
      badPurpose: '23514',
    },
  },
  {
    id: 'T8',
    name: '配置: 同じ方の同じ役割を2つの時間帯に書ける。時間帯なしの2件目は 23505。役割は2つだけ。時間帯は前後が逆なら不可',
    async run(h) {
      const today = await dayOf(h, 0)
      return {
        am: res(await addStaffing(h, { day: today, from: '09:00', to: '10:00', ck: 't8-1' })),
        pm: res(await addStaffing(h, { day: today, from: '15:00', to: '16:00', ck: 't8-2' })),
        noTime: res(await addStaffing(h, { day: today, ck: 't8-3' })),
        noTime2: res(await addStaffing(h, { day: today, ck: 't8-4' })),
        nurse: res(await addStaffing(h, { day: today, role: 'nurse', ck: 't8-5' })),
        badRole: res(await addStaffing(h, { day: today, staff: 2, role: 'manager', ck: 't8-6' })),
        reversed: res(await addStaffing(h, { day: today, staff: 2, from: '11:00', to: '10:00', ck: 't8-7' })),
      }
    },
    expect: { am: 'ok', pm: 'ok', noTime: 'ok', noTime2: '23505', nurse: 'ok', badRole: '23514', reversed: '23514' },
  },
  {
    id: 'T9',
    name: '写し: 事務所は写せる（規則と日数も書ける＝通る側）。現場は関数も表も 42501 で、何も書かない',
    async run(h) {
      const rows = [
        { master_id: 'M001', latest_plan_date: '2026-08-31', next_due: '2026-11-30', plan_status: 'signed' },
        { master_id: 'M002', latest_plan_date: '2026-09-15', next_due: '2026-12-15', stop_reason: 'stopped', stop_from: '2026-10-01', plan_status: 'printed' },
      ]
      const field = await sync(h, rows, { due_rule: 'min', warn_days: 14 }, { appRole: 'field' })
      const fieldInsert = await h.as({ appRole: 'field' }, (q) =>
        q(`insert into public.daycare_training_due (resident_id, synced_at) values (1, now()) returning id`),
      )
      const fieldSettings = await h.as({ appRole: 'field' }, (q) => q(`insert into public.daycare_training_due_settings (id) values (1) returning id`))
      const office = await sync(h, rows, { due_rule: 'min', warn_days: 14 }, { appRole: 'office' })
      const due = await h.pg(`select resident_id, latest_plan_date::text, next_due::text, stop_reason, stop_from::text, plan_status
                                from public.daycare_training_due where deleted_at is null order by resident_id`)
      const st = (await h.pg(`select due_rule, warn_days from public.daycare_training_due_settings`))[0] ?? null
      const r = Array.isArray(office) ? office[0].r : office
      return {
        field: res(field),
        fieldInsert: res(fieldInsert),
        fieldSettings: res(fieldSettings),
        office: { ok: r.ok, written: r.written, unmatched: r.unmatched, cancelled: r.cancelled },
        due,
        settings: st,
      }
    },
    expect: {
      field: '42501',
      fieldInsert: '42501',
      fieldSettings: '42501',
      office: { ok: true, written: 2, unmatched: 0, cancelled: 0 },
      due: [
        { resident_id: '1', latest_plan_date: '2026-08-31', next_due: '2026-11-30', stop_reason: null, stop_from: null, plan_status: 'signed' },
        { resident_id: '2', latest_plan_date: '2026-09-15', next_due: '2026-12-15', stop_reason: 'stopped', stop_from: '2026-10-01', plan_status: 'printed' },
      ],
      settings: { due_rule: 'min', warn_days: 14 },
    },
  },
  {
    id: 'T10',
    name: '写しの空上書きの保護: 0件・結べる番号が0件・半数を超える取り消しは何も書かずに止め、理由を返す。半数までの取り消しは通る',
    async run(h) {
      const all = ['M001', 'M002', 'M003'].map((m) => ({ master_id: m, latest_plan_date: '2026-09-01', next_due: '2026-12-01' }))
      await sync(h, all, {}, { appRole: 'office' })
      const count = async () => (await h.pg(`select count(*)::int as n from public.daycare_training_due where deleted_at is null`))[0].n
      const pick = (x) => (Array.isArray(x) ? { ok: x[0].r.ok, reason: x[0].r.reason ?? null } : x)
      const empty = pick(await sync(h, [], {}, { appRole: 'office' }))
      const afterEmpty = await count()
      const nomatch = pick(await sync(h, [{ master_id: 'X999', next_due: '2026-12-01' }], {}, { appRole: 'office' }))
      const afterNomatch = await count()
      const tooMany = pick(await sync(h, [all[0]], {}, { appRole: 'office' }))
      const afterTooMany = await count()
      const two = await sync(h, [all[0], all[1]], {}, { appRole: 'office' })
      const afterTwo = await count()
      return {
        empty,
        afterEmpty,
        nomatch,
        afterNomatch,
        tooMany,
        afterTooMany,
        two: Array.isArray(two) ? { ok: two[0].r.ok, cancelled: two[0].r.cancelled } : two,
        afterTwo,
      }
    },
    expect: {
      empty: { ok: false, reason: 'empty' },
      afterEmpty: 3,
      nomatch: { ok: false, reason: 'nomatch' },
      afterNomatch: 3,
      tooMany: { ok: false, reason: 'too_many' },
      afterTooMany: 3,
      two: { ok: true, cancelled: 1 },
      afterTwo: 2,
    },
  },
  {
    id: 'T11',
    name: '写しの値をそろえる: 知らない状態・理由は null、空の日付は null、知らない規則は暦の月、範囲の外の日数は 28。1行も落とさない',
    async run(h) {
      const r = await sync(
        h,
        [
          { master_id: 'M001', latest_plan_date: '', next_due: '', plan_status: 'archived', stop_reason: 'moved' },
          { master_id: 'M002', latest_plan_date: '2026-09-01', next_due: '2026-12-01', plan_status: 'reviewed' },
        ],
        { due_rule: 'weekly', warn_days: '999' },
        { appRole: 'admin' },
      )
      const due = await h.pg(`select resident_id, latest_plan_date::text, next_due::text, plan_status, stop_reason
                                from public.daycare_training_due where deleted_at is null order by resident_id`)
      const st = (await h.pg(`select due_rule, warn_days from public.daycare_training_due_settings`))[0] ?? null
      return { ok: Array.isArray(r) ? r[0].r.ok : r, due, settings: st }
    },
    expect: {
      ok: true,
      due: [
        { resident_id: '1', latest_plan_date: null, next_due: null, plan_status: null, stop_reason: null },
        { resident_id: '2', latest_plan_date: '2026-09-01', next_due: '2026-12-01', plan_status: 'reviewed', stop_reason: null },
      ],
      settings: { due_rule: 'calendar', warn_days: 28 },
    },
  },
  {
    id: 'T12',
    name: '変更の記録: 実施記録・居宅訪問・配置を直すと record_history に残る（業務日の列つき）',
    async run(h) {
      const today = await dayOf(h, 0)
      const s = await addSession(h, { day: today, ck: 't12-1' })
      await h.as({}, (q) => q(`update public.daycare_training_sessions set program = '歩行の練習', edited_by = 2 where id = $1`, [s[0].id]))
      const v = await addVisit(h, { on: today, ck: 't12-2' })
      await h.as({}, (q) => q(`update public.daycare_home_visits set explanation = '説明した', edited_by = 2 where id = $1`, [v[0].id]))
      const st = await addStaffing(h, { day: today, ck: 't12-3' })
      await h.as({}, (q) => q(`update public.daycare_staffing set note = '午前のみ', edited_by = 2 where id = $1`, [st[0].id]))
      const rows = await h.pg(
        `select table_name, count(*)::int as n from public.record_history
          where table_name in ('daycare_training_sessions', 'daycare_home_visits', 'daycare_staffing') group by table_name order by table_name`,
      )
      return { rows }
    },
    expect: {
      rows: [
        { table_name: 'daycare_home_visits', n: 1 },
        { table_name: 'daycare_staffing', n: 1 },
        { table_name: 'daycare_training_sessions', n: 1 },
      ],
    },
  },
]
