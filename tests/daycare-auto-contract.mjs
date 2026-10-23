// 移行 0047（デイ 今日の画面の改善 1回目: 自動の到着・帰宅・休みの理由「後で」）の契約。素の Postgres で tests/daycare-auto-pg.mjs が流す。
// 決定文書（【AI取締役】の 20261023_今日の画面の改善_決定_v1.md）の 3「1回目」と 4「守ること」を、DB の層で確かめる。
//
// ・定時の処理は時刻を引数で受ける本体（private.daycare_auto_attendance_at）を、時刻をずらして呼ぶ（cron は動かさない）。
//   日付は未来の固定日（D・2030 年）にする。行の書き換えの時刻（updated_at＝実際の今）が予定の終了の時刻より前になるので、
//   「予定の終了の後に人が書き換えた行には帰宅を入れない」の決まりを、updated_at を明示して確かめられる
// ・過去の日の守り（0042・0043）の確かめだけは、実際の過去の日（PAST）を使う
// ・各件は1つのトランザクションの中で動き、最後に必ず rollback する（表に何も残さない）
//
// 個人情報は置かない（利用者は架空の「見本」姓・職員は 職員01 と数値IDだけ）。

import { dowOf, schedRes } from './daycare-contract.mjs'

const TENANT = '00000000-0000-0000-0000-0000000000aa'
/** 自動の試験の日（未来の固定日・休業日 12-31〜01-03 に当たらない） */
export const D = '2030-03-06'
/** 過去の日の守りの試験の日（実際の過去） */
export const PAST = '2026-10-01'

/** 準備: 職員2人・利用者12人（架空）。9 は在籍でない。12 は予定の無い方 */
export const AUTO_SEED_SQL = [
  `insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02') on conflict (id) do nothing`,
  `insert into residents (id, source_id, name, active) overriding system value values
     (1, 'M001', '見本 一郎', true),
     (2, 'M002', '見本 花子', true),
     (3, 'M003', '見本 次郎', true),
     (4, 'M004', '見本 和子', true),
     (5, 'M005', '見本 三郎', true),
     (6, 'M006', '見本 春子', true),
     (7, 'M007', '見本 夏子', true),
     (8, 'M008', '見本 秋子', true),
     (9, 'M009', '見本 退所', false),
     (10, 'M010', '見本 冬子', true),
     (11, 'M011', '見本 四郎', true),
     (12, 'M012', '見本 五郎', true)
   on conflict (id) do nothing`,
]

/** その日の曜日の週間計画（1人1記録。events の dow は D の曜日） */
function scheduleFor(day) {
  const w = dowOf(day)
  return [
    schedRes('s1', { masterId: 'M001', name: '見本 一郎' }, [{ dow: w, start: '9:30', end: '15:30', bathing: true }]),
    schedRes('s2', { masterId: 'M002', name: '見本 花子' }, [{ dow: w, start: '9:00', end: '12:00' }]),
    // 利用者No の無い記録を氏名で1人に絞れる（match=name）
    schedRes('s3', { masterId: null, name: '見本　次郎' }, [{ dow: w, start: '10:00', end: '16:00' }]),
    // 同じ方に予定が2件（午前・午後）＝データの誤りとして自動にしない（代表者の回答 A2）
    schedRes('s4', { masterId: 'M004', name: '見本 和子' }, [
      { dow: w, start: '9:30', end: '12:00' },
      { dow: w, start: '13:30', end: '15:30' },
    ]),
    // 開始の時刻を読めない
    schedRes('s5', { masterId: 'M005', name: '見本 三郎' }, [{ dow: w, start: 'あとで', end: '15:30' }]),
    // 週間計画の写しで入院中
    schedRes('s6', { masterId: 'M006', name: '見本 春子', hospitalized: true }, [{ dow: w, start: '9:30', end: '15:30' }]),
    // 入居者マスタの写しで入院中（下の master_residents）
    schedRes('s7', { masterId: 'M007', name: '見本 夏子' }, [{ dow: w, start: '9:30', end: '15:30' }]),
    // 外泊の期間中（下の outings）
    schedRes('s8', { masterId: 'M008', name: '見本 秋子' }, [{ dow: w, start: '9:30', end: '15:30' }]),
    // 在籍でない（名簿の在籍者に居ない＝absent_roster）
    schedRes('s9', { masterId: 'M009', name: '見本 退所' }, [{ dow: w, start: '9:30', end: '15:30' }]),
    // 外部利用者
    schedRes('s10', { masterId: null, name: '見本 外部', external: true }, [{ dow: w, start: '9:30', end: '15:30' }]),
    // 利用者No は合うが氏名が違う（mismatch）
    schedRes('s11', { masterId: 'M010', name: '見本 違う' }, [{ dow: w, start: '9:30', end: '15:30' }]),
    // 同じ利用者No の記録が2つ（dup）
    schedRes('s12a', { masterId: 'M011', name: '見本 四郎' }, [{ dow: w, start: '9:30', end: '15:30' }]),
    schedRes('s12b', { masterId: 'M011', name: '見本 四郎' }, [{ dow: w, start: '9:30', end: '15:30' }]),
  ]
}

async function putSchedule(h, residents, rev = 7) {
  await h.pg(
    `insert into public.kv_entries (tenant_id, key, data, rev, updated_at) values ($1, 'care_schedule_v2', $2::jsonb, $3, '2030-03-01T00:00:00Z')
     on conflict (tenant_id, key) do update set data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at`,
    [TENANT, JSON.stringify({ residents }), rev],
  )
}

/** 試験の前提をそろえる: 週間計画・入院（マスタの写し）・外泊・旗 */
async function prepare(h, day = D, opts = {}) {
  await putSchedule(h, scheduleFor(day))
  await h.pg(`insert into public.master_residents (tenant_id, source_id, hospitalized) values ($1, 'M007', true) on conflict do nothing`, [TENANT])
  await h.pg(
    `insert into public.outings (resident_id, kind, start_on, end_on) values (8, 'overnight', ($1::date - 1), ($1::date + 1))`,
    [day],
  )
  await flags(h, opts.auto ?? 'true', opts.daycare ?? 'true')
}

async function flags(h, auto, daycare) {
  await h.pg(
    `insert into public.app_settings (key, value) values ('auto_enabled_daycare_attendance', $1), ('input_enabled_daycare', $2)
     on conflict (key) do update set value = excluded.value`,
    [auto, daycare],
  )
}

/** 定時の処理を、その日のその時刻（日本時間 'HH:MM'）で呼ぶ */
async function tick(h, hm, day = D) {
  return (await h.pg(`select private.daycare_auto_attendance_at(($1 || ' ' || $2 || ':00+09')::timestamptz) as r`, [day, hm]))[0].r
}

/** その日の到着・帰宅（生きている行・利用者の順）を [利用者, 到着, 帰宅, 到着は自動, 帰宅は自動, 休み] にする */
async function att(h, day = D) {
  const rows = await h.pg(
    `select resident_id::int as r, to_char(arrived_at, 'HH24:MI') as a, to_char(left_at, 'HH24:MI') as l,
            arrived_auto as aa, left_auto as la, absent as ab, absent_reason as why
       from public.daycare_attendance where day = $1::date and deleted_at is null order by resident_id`,
    [day],
  )
  return rows.map((x) => [x.r, x.a, x.l, x.aa, x.la, x.ab, x.why])
}

/** updated_at を明示した書き換え（トリガを通さない＝人がその時刻に書き換えた形を作る） */
async function rawUpdate(h, sql, params) {
  await h.pg(`set local session_replication_role = replica`)
  try {
    await h.pg(sql, params)
  } finally {
    await h.pg(`set local session_replication_role = origin`)
  }
}

const code = (r) => (Array.isArray(r) ? 'ok' : r.error)

/**
 * h.pg(text, params?)        … postgres（超ユーザー）で流す。行の配列を返す
 * h.as(opts, fn)             … opts.role（既定 authenticated）・opts.member（既定 true）・opts.appRole（private.my_role()）に
 *                              切り替えて fn(q) を流す。q(text, params?) は行の配列を返す。例外は { error: SQLSTATE } で返す
 */
export const AUTO_CASES = [
  // ── 旗・値・ジョブ ──
  {
    id: 'AU0',
    name: '旗 auto_enabled_daycare_attendance は false で入る・ジョブは5分ごとに1件・本体と入口はアプリから呼べない',
    async run(h) {
      const flag = (await h.pg(`select value from public.app_settings where key = 'auto_enabled_daycare_attendance'`))[0]?.value ?? null
      const job = await h.pg(`select schedule, command from cron.job where jobname = 'care_auto_daycare_attendance'`)
      const calls = {}
      for (const [k, sql] of [
        ['entry', `select private.daycare_auto_attendance()`],
        ['body', `select private.daycare_auto_attendance_at(now())`],
        ['plan', `select * from private.daycare_auto_plan('${D}'::date, '${TENANT}'::uuid)`],
        ['hm', `select private.daycare_auto_hm('9:30')`],
      ]) {
        calls[k] = code(await h.as({}, (q) => q(sql)))
      }
      return { flag, job, calls }
    },
    expect: {
      flag: 'false',
      job: [{ schedule: '*/5 * * * *', command: 'select private.daycare_auto_attendance()' }],
      calls: { entry: '42501', body: '42501', plan: '42501', hm: '42501' },
    },
  },
  {
    id: 'AU1',
    name: '旗が false の間・デイの入力が封鎖の間は何も書かない（写しも作らない）',
    async run(h) {
      await prepare(h, D, { auto: 'false' })
      const off = await tick(h, '10:00')
      await flags(h, 'true', 'false')
      const blocked = await tick(h, '10:00')
      const rows = (await att(h)).length
      const snaps = (await h.pg(`select count(*)::int as n from public.daycare_days where day = $1::date`, [D]))[0].n
      return { off: off.skipped, blocked: blocked.skipped, rows, snaps }
    },
    expect: { off: 'flag', blocked: 'flag', rows: 0, snaps: 0 },
  },
  {
    id: 'AU2',
    name: '時刻をずらして流す: 開始の時刻で到着・終了の時刻で帰宅。予定が2件の方・照合できない予定・入院・外泊・在籍でない方は入れない。もう一度流しても増えない',
    async run(h) {
      await prepare(h)
      const out = {}
      out.early = await tick(h, '08:59')
      out.snapEarly = (await h.pg(`select count(*)::int as n from public.daycare_days where day = $1::date`, [D]))[0].n
      out.t0900 = await tick(h, '09:00')
      out.t0931 = await tick(h, '09:31')
      out.t1005 = await tick(h, '10:05')
      out.t1201 = await tick(h, '12:01')
      out.t1531 = await tick(h, '15:31')
      out.t1601 = await tick(h, '16:01')
      out.again = await tick(h, '16:01')
      out.rows = await att(h)
      const snap = (await h.pg(`select plan_source, opened_by, jsonb_array_length(plan_rows) as n from public.daycare_days where day = $1::date`, [D]))[0]
      out.snap = snap
      out.auto = (await h.pg(`select count(*)::int as n from public.daycare_attendance where day = $1::date and recorded_by is null and client_key like 'auto:dcatt:%'`, [D]))[0].n
      out.twoEvents = (await h.pg(`select count(*)::int as n from public.daycare_attendance where day = $1::date and resident_id = 4`, [D]))[0].n
      return out
    },
    expect: {
      early: { day: D, arrived: 0, left: 0, snapshot: false, skipped: 'early' },
      snapEarly: 0,
      t0900: { day: D, arrived: 1, left: 0, snapshot: true, skipped: null },
      t0931: { day: D, arrived: 1, left: 0, snapshot: false, skipped: null },
      t1005: { day: D, arrived: 1, left: 0, snapshot: false, skipped: null },
      t1201: { day: D, arrived: 0, left: 1, snapshot: false, skipped: null },
      t1531: { day: D, arrived: 0, left: 1, snapshot: false, skipped: null },
      t1601: { day: D, arrived: 0, left: 1, snapshot: false, skipped: null },
      again: { day: D, arrived: 0, left: 0, snapshot: false, skipped: null },
      rows: [
        [1, '09:30', '15:30', true, true, false, null],
        [2, '09:00', '12:00', true, true, false, null],
        [3, '10:00', '16:00', true, true, false, null],
      ],
      snap: { plan_source: 'kv', opened_by: null, n: 14 },
      auto: 3,
      twoEvents: 0,
    },
  },
  {
    id: 'AU3',
    name: 'その日の生きている行がもうある方には到着を入れない（休み・手で押した到着）。取り消し済みの行は数えない（〔元に戻す〕で行が無い形に戻した方には入れる）。手で押した到着にも帰宅は入る',
    async run(h) {
      await prepare(h)
      const ins = (sql, p) => h.as({}, (q) => q(sql, p))
      const r = {}
      r.absent = code(await ins(`insert into public.daycare_attendance (resident_id, day, absent, absent_reason, recorded_by, client_key) values (1, $1::date, true, 'later', 1, 'c-au3-1') returning id`, [D]))
      r.manual = code(await ins(`insert into public.daycare_attendance (resident_id, day, arrived_at, recorded_by, client_key) values (2, $1::date, '08:50', 1, 'c-au3-2') returning id`, [D]))
      r.deleted = code(await ins(`insert into public.daycare_attendance (resident_id, day, arrived_at, recorded_by, client_key) values (3, $1::date, '09:10', 1, 'c-au3-3') returning id`, [D]))
      await h.pg(`update public.daycare_attendance set deleted_at = now(), deleted_by = 1 where client_key = 'c-au3-3'`)
      r.t0931 = await tick(h, '09:31')
      r.t1201 = await tick(h, '12:01')
      r.rows = await att(h)
      r.del3 = (await h.pg(`select count(*)::int as n from public.daycare_attendance where day = $1::date and resident_id = 3`, [D]))[0].n
      return r
    },
    expect: {
      absent: 'ok',
      manual: 'ok',
      deleted: 'ok',
      t0931: { day: D, arrived: 0, left: 0, snapshot: true, skipped: null },
      t1201: { day: D, arrived: 1, left: 1, snapshot: false, skipped: null },
      rows: [
        [1, null, null, false, false, true, 'later'],
        [2, '08:50', '12:00', false, true, false, null],
        [3, '10:00', null, true, false, false, null],
      ],
      del3: 2,
    },
  },
  {
    id: 'AU4',
    name: '予定の終了の後に人が書き換えた行には帰宅を入れない（帰宅の取り消しの後に作り直さない）。終了の前の書き換えなら入れる',
    async run(h) {
      await prepare(h)
      await tick(h, '10:05')
      // 1: 帰宅が入った後、15:40 に人が帰宅を取り消した
      await tick(h, '15:31')
      await rawUpdate(h, `update public.daycare_attendance set left_at = null, left_auto = false, updated_at = $2::timestamptz, edited_by = 1 where day = $1::date and resident_id = 1`, [D, `${D} 15:40:00+09`])
      // 3: 終了（16:00）の前の 15:00 に人が備考を書いた
      await rawUpdate(h, `update public.daycare_attendance set note = '見本の備考', updated_at = $2::timestamptz, edited_by = 1 where day = $1::date and resident_id = 3`, [D, `${D} 15:00:00+09`])
      const later = await tick(h, '16:05')
      return { later, rows: (await att(h)).filter((x) => x[0] === 1 || x[0] === 3) }
    },
    expect: {
      later: { day: D, arrived: 0, left: 1, snapshot: false, skipped: null },
      rows: [
        [1, '09:30', null, true, false, false, null],
        [3, '10:00', '16:00', true, true, false, null],
      ],
    },
  },
  {
    id: 'AU5',
    name: '止まっていた後の取り戻し: 終了の後に初めて流れた時は、到着と帰宅を一緒に入れる（両方とも自動の印）',
    async run(h) {
      await prepare(h)
      const r = await tick(h, '16:30')
      return { r, rows: await att(h) }
    },
    expect: {
      r: { day: D, arrived: 3, left: 0, snapshot: true, skipped: null },
      rows: [
        [1, '09:30', '15:30', true, true, false, null],
        [2, '09:00', '12:00', true, true, false, null],
        [3, '10:00', '16:00', true, true, false, null],
      ],
    },
  },
  {
    id: 'AU6',
    name: '写しがある日は写しだけを見る（職員の開所の後に変わった週間計画は見ない）。予定なしの写しは何もしない。読めなかった写しは1回置き換える',
    async run(h) {
      await prepare(h)
      // 職員の開所で 1 の方だけの写しができた（その後に週間計画が変わった形）
      const only1 = await h.pg(`select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) as j from private.daycare_auto_plan($1::date, $2::uuid) p where p.resident_id = 1`, [D, TENANT])
      await h.pg(`insert into public.daycare_days (day, plan_source, plan_rows, opened_by) values ($1::date, 'kv', $2::jsonb, 1)`, [D, JSON.stringify(only1[0].j)])
      const kv = await tick(h, '10:05')
      const kvRows = (await att(h)).map((x) => x[0])
      // 予定なしの写し（別の日）
      const D2 = '2030-03-13'
      await h.pg(`insert into public.daycare_days (day, plan_source, plan_rows, opened_by) values ($1::date, 'none', '[]'::jsonb, 1)`, [D2])
      const none = await tick(h, '10:05', D2)
      // 読めなかった写し（別の日）→ いまの週間計画で置き換えて記録する（外泊は D の前後だけなので、8 の方も入る。予定が2件の 4 は入れない）
      const D3 = '2030-03-20'
      await h.pg(`insert into public.daycare_days (day, plan_source, plan_rows, opened_by) values ($1::date, 'unknown', '[]'::jsonb, 1)`, [D3])
      const unk = await tick(h, '10:05', D3)
      const unkSnap = (await h.pg(`select plan_source, opened_by from public.daycare_days where day = $1::date`, [D3]))[0]
      return { kv: kv.arrived, kvRows, none: none.skipped, unk: unk.arrived, unkSnap }
    },
    expect: { kv: 1, kvRows: [1], none: 'noplan', unk: 4, unkSnap: { plan_source: 'kv', opened_by: '1' } },
  },
  {
    id: 'AU7',
    name: 'デイの休業日（daycare_closed_dates）は何もしない。週間計画が読めない日・予定の無い日は写しを作らない',
    async run(h) {
      await prepare(h)
      await h.pg(`update public.app_settings set value = $1 where key = 'daycare_closed_dates'`, [`12-31,01-01,${D}`])
      const closed = await tick(h, '10:05')
      await h.pg(`update public.app_settings set value = '12-31,01-01,01-02,01-03' where key = 'daycare_closed_dates'`)
      // 予定の無い曜日（翌日）
      const D1 = '2030-03-07'
      const noplan = await tick(h, '10:05', D1)
      // 週間計画が読めない（写しを消す）
      await h.pg(`delete from public.kv_entries where key = 'care_schedule_v2'`)
      const unread = await tick(h, '10:05')
      const snaps = (await h.pg(`select count(*)::int as n from public.daycare_days`))[0].n
      return { closed: closed.skipped, noplan: noplan.skipped, unread: unread.skipped, snaps, rows: (await att(h)).length }
    },
    expect: { closed: 'closed', noplan: 'noplan', unread: 'unread', snaps: 0, rows: 0 },
  },
  {
    id: 'AU8',
    name: '印を外すトリガ: 時刻を直す・休みにすると外れる。取り消しだけでは外さない。帰宅だけ直すと帰宅の印だけ外れる。〔元に戻す〕は時刻と一緒に印を戻せる',
    async run(h) {
      await prepare(h)
      // この件だけ 4 の方の予定を1件にする（取り消しで印を外さないことを、自動の行で確かめるため）
      await putSchedule(h, scheduleFor(D).map((r) => (r.id === 's4' ? schedRes('s4', { masterId: 'M004', name: '見本 和子' }, [{ dow: dowOf(D), start: '9:30', end: '15:30' }]) : r)))
      await tick(h, '16:30')
      const up = (sql) => h.as({}, (q) => q(sql, [D]))
      const r = {}
      r.fixArrive = code(await up(`update public.daycare_attendance set arrived_at = '09:45', edited_by = 1 where day = $1::date and resident_id = 1 returning id`))
      r.fixLeave = code(await up(`update public.daycare_attendance set left_at = '14:50', edited_by = 1 where day = $1::date and resident_id = 2 returning id`))
      r.absent = code(await up(`update public.daycare_attendance set absent = true, absent_reason = 'later', arrived_at = null, left_at = null, edited_by = 1 where day = $1::date and resident_id = 3 returning id`))
      r.undo = code(await up(`update public.daycare_attendance set absent = false, absent_reason = null, arrived_at = '10:00', left_at = '16:00', arrived_auto = true, left_auto = true, edited_by = 1 where day = $1::date and resident_id = 3 returning id`))
      r.del = code(await up(`update public.daycare_attendance set deleted_at = now(), deleted_by = 1 where day = $1::date and resident_id = 4 returning id`))
      r.noTimeMark = code(await h.as({}, (q) => q(`insert into public.daycare_attendance (resident_id, day, arrived_auto, left_auto, client_key) values (12, $1::date, true, true, 'c-au8-12') returning id`, [D])))
      r.rows = await att(h)
      r.del4 = (await h.pg(`select arrived_auto, left_auto from public.daycare_attendance where day = $1::date and resident_id = 4`, [D]))[0]
      return r
    },
    expect: {
      fixArrive: 'ok',
      fixLeave: 'ok',
      absent: 'ok',
      undo: 'ok',
      del: 'ok',
      noTimeMark: 'ok',
      rows: [
        [1, '09:45', '15:30', false, true, false, null],
        [2, '09:00', '14:50', true, false, false, null],
        [3, '10:00', '16:00', true, true, false, null],
        [12, null, null, false, false, false, null],
      ],
      del4: { arrived_auto: true, left_auto: true },
    },
  },
  {
    id: 'AU9',
    name: '休みの理由に later（後で）が入る・既存の5つも入る・ほかの値は 23514・後での休みも時刻を持たない',
    async run(h) {
      const out = {}
      let i = 0
      for (const v of ['condition', 'hospital', 'wish', 'family', 'other', 'later', 'xyz']) {
        i += 1
        const r = await h.as({}, (q) =>
          q(`insert into public.daycare_attendance (resident_id, day, absent, absent_reason, client_key) values (1, $1::date, true, $2, $3) returning id`, [
            `2030-04-${String(i).padStart(2, '0')}`,
            v,
            `c-au9-${i}`,
          ]),
        )
        out[v] = code(r)
      }
      out.laterWithTime = code(
        await h.as({}, (q) => q(`insert into public.daycare_attendance (resident_id, day, absent, absent_reason, arrived_at, client_key) values (2, $1::date, true, 'later', '09:30', 'c-au9-t') returning id`, [D])),
      )
      return out
    },
    expect: { condition: 'ok', hospital: 'ok', wish: 'ok', family: 'ok', other: 'ok', later: 'ok', xyz: '23514', laterWithTime: '23514' },
  },
  {
    id: 'AU10',
    name: '休みとの順番: 自動の到着が先に入った方に端末が休みを追加すると 23505（1人1日1件）。行を休みに直すと時刻と印が消える。休みが先なら自動は入れない',
    async run(h) {
      await prepare(h)
      await tick(h, '09:31')
      const dup = code(await h.as({}, (q) => q(`insert into public.daycare_attendance (resident_id, day, absent, absent_reason, recorded_by, client_key) values (1, $1::date, true, 'later', 1, 'c-au10-1') returning id`, [D])))
      const fix = code(await h.as({}, (q) => q(`update public.daycare_attendance set absent = true, absent_reason = 'later', arrived_at = null, left_at = null, edited_by = 1 where day = $1::date and resident_id = 1 returning id`, [D])))
      // 3 の方は 10:00 の開始の前に休み
      const first = code(await h.as({}, (q) => q(`insert into public.daycare_attendance (resident_id, day, absent, absent_reason, recorded_by, client_key) values (3, $1::date, true, 'later', 1, 'c-au10-3') returning id`, [D])))
      const t = await tick(h, '16:30')
      return { dup, fix, first, t, rows: (await att(h)).filter((x) => x[0] === 1 || x[0] === 3) }
    },
    expect: {
      dup: '23505',
      fix: 'ok',
      first: 'ok',
      t: { day: D, arrived: 0, left: 1, snapshot: false, skipped: null },
      rows: [
        [1, null, null, false, false, true, 'later'],
        [3, null, null, false, false, true, 'later'],
      ],
    },
  },
  {
    id: 'AU11',
    name: '過去の日の守り（0042・0043）: 定時の処理（役割なし）は書ける。自動の到着の時刻を現場が過去の日に直すと 42501、事務所は直せて印が外れる',
    async run(h) {
      await prepare(h, PAST)
      const t = await tick(h, '10:05', PAST)
      const field = code(await h.as({ appRole: 'field' }, (q) => q(`update public.daycare_attendance set arrived_at = '09:40', edited_by = 1 where day = $1::date and resident_id = 1 returning id`, [PAST])))
      const fieldAbsent = code(
        await h.as({ appRole: 'field' }, (q) =>
          q(`update public.daycare_attendance set absent = true, absent_reason = 'later', arrived_at = null, left_at = null, edited_by = 1 where day = $1::date and resident_id = 2 returning id`, [PAST]),
        ),
      )
      const office = code(await h.as({ appRole: 'office' }, (q) => q(`update public.daycare_attendance set arrived_at = '09:40', edited_by = 1 where day = $1::date and resident_id = 1 returning id`, [PAST])))
      const rows = (await att(h, PAST)).filter((x) => x[0] === 1 || x[0] === 2)
      return { arrived: t.arrived, field, fieldAbsent, office, rows }
    },
    expect: {
      arrived: 3,
      field: '42501',
      fieldAbsent: '42501',
      office: 'ok',
      rows: [
        [1, '09:40', null, false, false, false, null],
        [2, '09:00', null, true, false, false, null],
      ],
    },
  },
  {
    id: 'AU12',
    name: '予定の写し（private.daycare_auto_plan）は daycare_plan と同じ行を返す（予定あり・予定なしの日・読めない時）',
    async run(h) {
      await prepare(h)
      const pub = async (day) => h.as({}, (q) => q(`select * from public.daycare_plan($1::date)`, [day]))
      const pri = async (day) => h.pg(`select * from private.daycare_auto_plan($1::date, $2::uuid)`, [day, TENANT])
      const same = async (day) => JSON.stringify(await pub(day)) === JSON.stringify(await pri(day))
      const kv = await same(D)
      const kvRows = (await pri(D)).length
      const none = await same('2030-03-07')
      await h.pg(`delete from public.kv_entries where key = 'care_schedule_v2'`)
      const unread = await same(D)
      const unreadRows = (await pri(D)).length
      return { kv, kvRows, none, unread, unreadRows }
    },
    expect: { kv: true, kvRows: 14, none: true, unread: true, unreadRows: 0 },
  },
  {
    id: 'AU13',
    name: '予定の時刻の読み方（画面の planHm と同じ）',
    async run(h) {
      const out = {}
      for (const v of ['9:30', '09:30', ' 9:30〜', '23:59', '24:00', '9:60', 'x', '', null]) {
        out[String(v)] = (await h.pg(`select to_char(private.daycare_auto_hm($1), 'HH24:MI') as t`, [v]))[0].t
      }
      return out
    },
    expect: { '9:30': '09:30', '09:30': '09:30', ' 9:30〜': '09:30', '23:59': '23:59', '24:00': null, '9:60': null, x: null, '': null, null: null },
  },
]

/** 期待と観測の食い違い（daycare-contract の checkDaycareCase と同じ規則） */
export function checkAutoCase(c, observed) {
  const out = []
  for (const [k, v] of Object.entries(c.expect)) {
    const o = observed?.[k]
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && o !== null && typeof o === 'object' && !Array.isArray(o)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (JSON.stringify(o[k2] ?? null) !== JSON.stringify(v2 ?? null)) out.push(`${k}.${k2}: ${JSON.stringify(o[k2])} != ${JSON.stringify(v2)}`)
      }
      for (const k2 of Object.keys(o)) if (!(k2 in v)) out.push(`${k}.${k2}: 期待に無い ${JSON.stringify(o[k2])}`)
      continue
    }
    if (JSON.stringify(o ?? null) !== JSON.stringify(v ?? null)) out.push(`${k}: ${JSON.stringify(o)} != ${JSON.stringify(v)}`)
  }
  return out
}
