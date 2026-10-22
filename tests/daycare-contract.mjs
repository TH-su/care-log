// 移行 0041（デイ 段階1: 予定の写し daycare_days・到着と欠席 daycare_attendance・RPC daycare_plan／daycare_open_day・
// 入浴の中止の理由「欠席」・旗 input_enabled_daycare）の契約。素の Postgres で tests/daycare-pg.mjs が流す。
// 検証計画 v2（【AI取締役】の 20261022_検証計画_v2.md）の 11.1 A1(a)(b)・A2・A3・A6 と 3.5・2.5（中10）を、DB の層で確かめる。
//
// ・DAYCARE_CASES … 1件ずつ「準備（postgres の権限）→ 操作（authenticated／anon・member の有無を切り替える）→ 観測」を行い、
//     expect と突き合わせる。各件は1つのトランザクションの中で動き、最後に必ず rollback する（表に何も残さない）。
// ・npm test では DB を使わない。移行の文面の静的検査と端末側の試験は tests/daycare.test.mjs。
//
// 個人情報は置かない（利用者は架空の「見本」姓・職員は 職員01 と数値IDだけ）。

/** 準備: 職員3人・利用者6人（架空）。ID は固定（overriding system value）。氏名の空白の違い（半角・全角）も混ぜる */
export const DAYCARE_SEED_SQL = [
  `insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02'), (3, '職員03') on conflict (id) do nothing`,
  `insert into residents (id, source_id, name, active) overriding system value values
     (1, 'M001', '見本 一郎', true),
     (2, 'M002', '見本　花子', true),
     (3, 'M003', '見本 次郎', true),
     (4, 'M004', '見本 和子', true),
     (5, 'M005', '見本 三郎', true),
     (6, 'M006', '見本 退所', false)
   on conflict (id) do nothing`,
]

/** 日本時間の今日（daycare_open_day は今日だけを受け付ける）。試験の中で DB から読む */
const TODAY_SQL = `select (now() at time zone 'Asia/Tokyo')::date::text as d`

/** 日付（YYYY-MM-DD）の曜日を週間計画の dayOfWeek（0=月 … 6=日）にする */
export function dowOf(day) {
  const [y, m, d] = day.split('-').map(Number)
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=日
  return (js + 6) % 7
}

/** 週間計画の写し（care_schedule_v2）の1人分。events は [{dow, start, end, bathing, type?}] */
export function schedRes(id, over = {}, events = []) {
  return {
    id,
    name: over.name ?? '',
    masterId: over.masterId ?? null,
    external: over.external ?? false,
    hospitalized: over.hospitalized ?? false,
    movedOut: over.movedOut ?? false,
    ...(over.preAdmitted ? { preAdmitted: true } : {}),
    events: events.map((e, i) => ({
      id: `${id}-e${i + 1}`,
      dayOfWeek: e.dow,
      serviceType: e.type ?? 'daycare',
      startTime: e.start ?? '9:30',
      endTime: e.end ?? '15:30',
      bathing: e.bathing ?? false,
    })),
  }
}

const TENANT = '00000000-0000-0000-0000-0000000000aa'

/** 週間計画の写しを置く（postgres の権限・rev つき） */
async function putSchedule(h, residents, rev = 7) {
  await h.pg(
    `insert into public.kv_entries (tenant_id, key, data, rev, updated_at) values ($1, 'care_schedule_v2', $2::jsonb, $3, '2026-10-20T00:00:00Z')
     on conflict (tenant_id, key) do update set data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at`,
    [TENANT, JSON.stringify({ residents }), rev],
  )
}

async function today(h) {
  return (await h.pg(TODAY_SQL))[0].d
}

/** daycare_plan(day) を職員として呼び、行の配列を返す */
async function plan(h, day, opts = {}) {
  return h.as(opts, (q) => q(`select * from public.daycare_plan($1::date)`, [day]))
}

/**
 * h.pg(text, params?)        … postgres（超ユーザー）で流す。行の配列を返す
 * h.as(opts, fn)             … opts.role（既定 authenticated）・opts.member（既定 true）・opts.appRole（private.my_role()）に
 *                              切り替えて fn(q) を流す。q(text, params?) は行の配列を返す。例外は { error: SQLSTATE } で返す
 */
export const DAYCARE_CASES = [
  // ── 旗・値の追加 ──
  {
    id: 'A6',
    name: '旗 input_enabled_daycare が false で入る・職員は読めるが書けない（0022）',
    async run(h) {
      const v = (await h.pg(`select value from public.app_settings where key = 'input_enabled_daycare'`))[0]?.value ?? null
      const r = await h.as({}, (q) => q(`update public.app_settings set value = 'true' where key = 'input_enabled_daycare'`))
      const read = await h.as({}, (q) => q(`select value from public.app_settings where key = 'input_enabled_daycare'`))
      return { value: v, writeError: r.error ?? null, readRows: Array.isArray(read) ? read.length : read }
    },
    expect: { value: 'false', writeError: '42501', readRows: 1 },
  },
  {
    id: 'A1b',
    name: '入浴の中止の理由に absent が入る・既存の4つと null も入る・ほかの値は 23514',
    async run(h) {
      const out = {}
      const vals = ['condition', 'refusal', 'facility', 'other', 'absent', null, 'xyz']
      let i = 0
      for (const v of vals) {
        i += 1
        const r = await h.as({}, (q) =>
          q(`insert into public.bath_records (resident_id, bath_on, result, cancel_reason, client_key) values (1, $1::date, 'cancel', $2, $3) returning id`, [
            `2026-09-${String(i).padStart(2, '0')}`,
            v,
            `t-a1b-${i}`,
          ]),
        )
        out[String(v)] = Array.isArray(r) ? 'ok' : r.error
      }
      return out
    },
    expect: { condition: 'ok', refusal: 'ok', facility: 'ok', other: 'ok', absent: 'ok', null: 'ok', xyz: '23514' },
  },

  // ── 到着・欠席の表の制約（3.5） ──
  {
    id: '3.5',
    name: '到着・帰宅・欠席の check（理由・時刻・順）と 1人1日1件',
    async run(h) {
      const ins = (cols, vals, params) =>
        h.as({}, (q) => q(`insert into public.daycare_attendance (${cols}) values (${vals}) returning id`, params))
      const code = (r) => (Array.isArray(r) ? 'ok' : r.error)
      const D = '2026-10-21'
      return {
        absentNoReason: code(await ins('resident_id, day, absent', `1, '${D}', true`)),
        reasonNoAbsent: code(await ins('resident_id, day, absent_reason', `1, '${D}', 'condition'`)),
        badReason: code(await ins('resident_id, day, absent, absent_reason', `1, '${D}', true, 'facility'`)),
        absentWithTime: code(await ins('resident_id, day, absent, absent_reason, arrived_at', `1, '${D}', true, 'wish', '09:30'`)),
        leftNoArrive: code(await ins('resident_id, day, left_at', `1, '${D}', '15:00'`)),
        leftBefore: code(await ins('resident_id, day, arrived_at, left_at', `1, '${D}', '10:00', '09:00'`)),
        ok1: code(await ins('resident_id, day, arrived_at, client_key', `1, '${D}', '09:30', 'ck-35-1'`)),
        dupDay: code(await ins('resident_id, day, arrived_at, client_key', `1, '${D}', '09:40', 'ck-35-2'`)),
        dupKey: code(await ins('resident_id, day, arrived_at, client_key', `2, '${D}', '09:40', 'ck-35-1'`)),
        absentOk: code(await ins('resident_id, day, absent, absent_reason, client_key', `3, '${D}', true, 'hospital', 'ck-35-3'`)),
      }
    },
    expect: {
      absentNoReason: '23514',
      reasonNoAbsent: '23514',
      badReason: '23514',
      absentWithTime: '23514',
      leftNoArrive: '23514',
      leftBefore: '23514',
      ok1: 'ok',
      dupDay: '23505',
      dupKey: '23505',
      absentOk: 'ok',
    },
  },
  {
    id: '3.5',
    name: '取り消した行（soft delete）の後は同じ人・同じ日に新しい行を作れる・取り消した行のキーは押さえたまま',
    async run(h) {
      await h.pg(`insert into public.daycare_attendance (id, resident_id, day, arrived_at, client_key) overriding system value values (501, 1, '2026-10-21', '09:30', 'ck-del-1')`)
      await h.as({}, (q) => q(`update public.daycare_attendance set deleted_at = now(), deleted_by = 1, edited_by = 1 where id = 501`))
      const again = await h.as({}, (q) => q(`insert into public.daycare_attendance (resident_id, day, arrived_at, client_key) values (1, '2026-10-21', '09:45', 'ck-del-2') returning id`))
      const sameKey = await h.as({}, (q) => q(`insert into public.daycare_attendance (resident_id, day, arrived_at, client_key) values (2, '2026-10-21', '09:45', 'ck-del-1') returning id`))
      return { again: Array.isArray(again) ? 'ok' : again.error, sameKey: Array.isArray(sameKey) ? 'ok' : sameKey.error }
    },
    expect: { again: 'ok', sameKey: '23505' },
  },
  {
    id: '2.2(2)',
    // anon の読みは「0行」（Supabase の既定の付与で表の権限はあるが、anon のポリシーが無い＝0行。既存の表と同じ）
    name: 'RLS: anon は0行・書けない／許可リスト外は0行・書けない／削除のポリシーが無い（行が残る）',
    async run(h) {
      await h.pg(`insert into public.daycare_attendance (id, resident_id, day, arrived_at) overriding system value values (601, 1, '2026-10-21', '09:30')`)
      const anonRead = await h.as({ role: 'anon' }, (q) => q(`select id from public.daycare_attendance`))
      const anonIns = await h.as({ role: 'anon' }, (q) => q(`insert into public.daycare_attendance (resident_id, day) values (2, '2026-10-21')`))
      const outRead = await h.as({ member: false }, (q) => q(`select id from public.daycare_attendance`))
      const outIns = await h.as({ member: false }, (q) => q(`insert into public.daycare_attendance (resident_id, day) values (2, '2026-10-21')`))
      const del = await h.as({}, (q) => q(`delete from public.daycare_attendance where id = 601`))
      const left = (await h.pg(`select count(*)::int n from public.daycare_attendance where id = 601`))[0].n
      const policies = await h.pg(
        `select tablename, count(*) filter (where cmd = 'DELETE')::int del,
                count(*) filter (where policyname = 'member_only' and permissive = 'RESTRICTIVE')::int mo
           from pg_policies where schemaname = 'public' and tablename in ('daycare_attendance', 'daycare_days')
          group by tablename order by tablename`,
      )
      return {
        anonRead: Array.isArray(anonRead) ? anonRead.length : anonRead.error,
        anonIns: Array.isArray(anonIns) ? 'ok' : anonIns.error,
        outRead: Array.isArray(outRead) ? outRead.length : outRead.error,
        outIns: Array.isArray(outIns) ? 'ok' : outIns.error,
        delRows: Array.isArray(del) ? del.length : del.error,
        left,
        policies,
      }
    },
    expect: {
      anonRead: 0,
      anonIns: '42501',
      outRead: 0,
      outIns: '42501',
      delRows: 0,
      left: 1,
      policies: [
        { tablename: 'daycare_attendance', del: 0, mo: 1 },
        { tablename: 'daycare_days', del: 0, mo: 1 },
      ],
    },
  },
  {
    id: '2.2(4)',
    name: '到着の行の更新は変更の記録に残る（record_history・業務日の列 day）',
    async run(h) {
      await h.pg(`insert into public.daycare_attendance (id, resident_id, day, arrived_at) overriding system value values (701, 1, '2026-10-21', '09:30')`)
      await h.as({}, (q) => q(`update public.daycare_attendance set left_at = '15:10', edited_by = 2 where id = 701`))
      const r = (await h.pg(`select record_day::text d, changed_by_staff s, op, rev_before, rev_after from public.record_history where table_name = 'daycare_attendance' and row_id = 701`))
      return { rows: r }
    },
    expect: { rows: [{ d: '2026-10-21', s: '2', op: 'update', rev_before: 1, rev_after: 2 }] },
  },

  // ── 予定（daycare_plan）の3値と照合（A3） ──
  {
    id: 'A3',
    name: 'unknown: 写しが無い・residents が空・配列でない → 0行',
    async run(h) {
      const d = await today(h)
      const none1 = await plan(h, d)
      await putSchedule(h, [])
      const empty = await plan(h, d)
      await h.pg(`update public.kv_entries set data = '{"residents": {"x": 1}}'::jsonb where key = 'care_schedule_v2'`)
      const notArray = await plan(h, d)
      return { noCopy: none1.length, empty: empty.length, notArray: notArray.length }
    },
    expect: { noCopy: 0, empty: 0, notArray: 0 },
  },
  {
    id: 'A3',
    name: 'none: 写しはあるがその日のデイの予定が無い → sched_id が空の1行（版と更新時刻つき）',
    async run(h) {
      const d = await today(h)
      const other = (dowOf(d) + 1) % 7
      await putSchedule(h, [
        schedRes('r1', { masterId: 'M001', name: '見本 一郎' }, [{ dow: other }]),
        schedRes('r2', { masterId: 'M002', name: '見本 花子' }, [{ dow: dowOf(d), type: 'visit' }]),
      ], 11)
      const rows = await plan(h, d)
      return { n: rows.length, sched: rows[0] ? rows[0].sched_id : 'x', rev: rows[0]?.plan_rev ?? null, hasTime: rows[0]?.updated_at != null }
    },
    expect: { n: 1, sched: null, rev: 11, hasTime: true },
  },
  {
    id: 'A3',
    name: 'ok: 予定1件ごとに1行・同じ人の2件は2行・照合は利用者No＋氏名（空白の違いは同じ）・氏名は返さない',
    async run(h) {
      const d = await today(h)
      const w = dowOf(d)
      await putSchedule(h, [
        schedRes('r1', { masterId: 'M001', name: '見本　一郎' }, [{ dow: w, start: '9:30', end: '12:00', bathing: true }, { dow: w, start: '13:00', end: '15:30' }]),
        schedRes('r2', { masterId: 'M002', name: '見本 花子' }, [{ dow: w, start: '09:00', end: '15:30' }]),
      ])
      const rows = await plan(h, d)
      const cols = Object.keys(rows[0] ?? {}).sort()
      return {
        rows: rows.map((r) => [r.sched_id, r.resident_id, r.match, r.dup, r.start_time, r.bathing]),
        hasName: cols.includes('name'),
      }
    },
    expect: {
      rows: [
        ['r2', '2', 'mid', false, '09:00', false],
        ['r1', '1', 'mid', false, '9:30', true],
        ['r1', '1', 'mid', false, '13:00', false],
      ],
      hasName: false,
    },
  },
  {
    id: 'A3',
    name: '照合: 重複（dup）・氏名の食い違い・利用者No なしで氏名1人・絞れない・束縛済み・外部・名簿に無い・退去と入居前は返さない・入院中',
    async run(h) {
      const d = await today(h)
      const w = dowOf(d)
      await putSchedule(h, [
        schedRes('d1', { masterId: 'M001', name: '見本 一郎' }, [{ dow: w }]),
        schedRes('d2', { masterId: 'M001', name: '見本 一郎' }, [{ dow: w }]), // 同じ利用者No が2つ → 両方 dup
        schedRes('mm', { masterId: 'M002', name: '見本 別名' }, [{ dow: w }]), // 氏名が違う
        schedRes('nm', { name: '見本 次郎' }, [{ dow: w }]), // 利用者No なし・名簿に1人
        schedRes('bd', { name: '見本 和子' }, [{ dow: w }]), // 利用者No なし・その人は M004 で別の記録に束縛済み
        schedRes('bd2', { masterId: 'M004', name: '見本 和子' }, [{ dow: (w + 1) % 7 }]), // 束縛（今日の予定なし）
        schedRes('ex', { external: true, name: '見本 外部' }, [{ dow: w }]),
        schedRes('ab', { masterId: 'M999', name: '見本 不明' }, [{ dow: w }]),
        schedRes('inact', { masterId: 'M006', name: '見本 退所' }, [{ dow: w }]), // 名簿で在籍でない
        schedRes('mo', { masterId: 'M003', name: '見本 次郎', movedOut: true }, [{ dow: w }]),
        schedRes('pa', { masterId: 'M005', name: '見本 三郎', preAdmitted: true }, [{ dow: w }]),
        schedRes('ho', { masterId: 'M005', name: '見本 三郎', hospitalized: true }, [{ dow: w }]),
      ])
      const rows = await plan(h, d)
      const by = Object.fromEntries(rows.map((r) => [r.sched_id, [r.resident_id, r.match, r.dup, r.external, r.hospitalized]]))
      return { by, n: rows.length }
    },
    expect: {
      n: 9,
      by: {
        d1: ['1', 'mid', true, false, false],
        d2: ['1', 'mid', true, false, false],
        mm: [null, 'mismatch', false, false, false],
        nm: ['3', 'name', false, false, false],
        bd: [null, 'ambiguous', false, false, false],
        ex: [null, 'external', false, true, false],
        ab: [null, 'absent_roster', false, false, false],
        inact: [null, 'absent_roster', false, false, false],
        ho: ['5', 'mid', false, false, true],
        // bd2 は今日の予定が無いので返さない・mo（退去）と pa（入居前）は返さない
      },
    },
  },
  {
    id: 'A3',
    name: '許可リスト外のログインは予定を読めない（kv_entries・residents の RLS がそのまま効く＝member_only の residents は0行）',
    async run(h) {
      const d = await today(h)
      await putSchedule(h, [schedRes('r1', { masterId: 'M001', name: '見本 一郎' }, [{ dow: dowOf(d) }])])
      const anon = await h.as({ role: 'anon' }, (q) => q(`select * from public.daycare_plan($1::date)`, [d]))
      return { anon: Array.isArray(anon) ? anon.length : anon.error }
    },
    expect: { anon: '42501' },
  },

  // ── 予定の写し（daycare_open_day・A3） ──
  {
    id: 'A3',
    name: '開所: 今日だけ写しを作る（昨日・明日は 22023）・2回目は同じ写し・週間計画が変わっても写しは動かない',
    async run(h) {
      const d = await today(h)
      const w = dowOf(d)
      await putSchedule(h, [schedRes('r1', { masterId: 'M001', name: '見本 一郎' }, [{ dow: w, bathing: true }])], 21)
      const kvMd5 = async () => (await h.pg(`select md5(data::text) || ':' || rev || ':' || updated_at::text m from public.kv_entries where key = 'care_schedule_v2'`))[0].m
      const md5Before = await kvMd5()
      const yest = await h.as({}, (q) => q(`select public.daycare_open_day(($1::date - 1), 1) as r`, [d]))
      const tmr = await h.as({}, (q) => q(`select public.daycare_open_day(($1::date + 1), 1) as r`, [d]))
      const first = await h.as({ appRole: 'field' }, (q) => q(`select public.daycare_open_day($1::date, 2) as r`, [d]))
      const md5AfterOpen = await kvMd5()
      await putSchedule(h, [schedRes('r9', { masterId: 'M002', name: '見本 花子' }, [{ dow: w }])], 22)
      const second = await h.as({}, (q) => q(`select public.daycare_open_day($1::date, 3) as r`, [d]))
      const f = first[0].r
      const s = second[0].r
      const rows = (await h.pg(`select count(*)::int n from public.daycare_days where day = $1::date`, [d]))[0].n
      return {
        yest: yest.error ?? 'ok',
        tmr: tmr.error ?? 'ok',
        source: f.plan_source,
        rev: f.plan_rev,
        planRows: f.plan_rows.map((r) => [r.sched_id, r.resident_id, r.match, r.bathing]),
        openedBy: f.opened_by,
        secondSame: s.id === f.id && JSON.stringify(s.plan_rows) === JSON.stringify(f.plan_rows) && s.opened_by === 2,
        rows,
        // 開所は週間計画を読むだけ（書かない）＝中身・版・更新時刻が開所の前後で同じ（D5・D18 の DB の側）
        kvUnchangedByOpen: md5Before === md5AfterOpen,
      }
    },
    expect: {
      yest: '22023',
      tmr: '22023',
      source: 'kv',
      rev: 21,
      planRows: [['r1', 1, 'mid', true]],
      openedBy: 2,
      secondSame: true,
      rows: 1,
      kvUnchangedByOpen: true,
    },
  },
  {
    id: 'A3',
    name: '開所: 予定なしは none（行は空）・読めない日は unknown で、後で読めた時に1回だけ写し直す（その後は動かない）',
    async run(h) {
      const d = await today(h)
      const w = dowOf(d)
      const unk = await h.as({}, (q) => q(`select public.daycare_open_day($1::date, 1) as r`, [d]))
      await putSchedule(h, [schedRes('r1', { masterId: 'M001', name: '見本 一郎' }, [{ dow: w }])], 30)
      const fixed = await h.as({}, (q) => q(`select public.daycare_open_day($1::date, 2) as r`, [d]))
      await putSchedule(h, [schedRes('r1', { masterId: 'M001', name: '見本 一郎' }, [{ dow: (w + 1) % 7 }])], 31)
      const after = await h.as({}, (q) => q(`select public.daycare_open_day($1::date, 3) as r`, [d]))
      // none の日（別の日付を直接作って確かめる＝今日の行は上で kv になった）
      await h.pg(`delete from public.daycare_days where day = $1::date`, [d])
      const none = await h.as({}, (q) => q(`select public.daycare_open_day($1::date, 1) as r`, [d]))
      // 職員が写しを直接書き換えようとしても通らない（書けるのは daycare_open_day だけ。update のポリシーが無い＝0行）
      const tamper = await h.as({}, (q) => q(`update public.daycare_days set plan_rows = '[]'::jsonb where day = $1::date returning id`, [d]))
      return {
        unk: [unk[0].r.plan_source, unk[0].r.plan_rows.length],
        fixed: [fixed[0].r.plan_source, fixed[0].r.plan_rows.length, fixed[0].r.plan_rev],
        after: [after[0].r.plan_source, after[0].r.plan_rev],
        none: [none[0].r.plan_source, none[0].r.plan_rows.length, none[0].r.plan_rev],
        tamper: Array.isArray(tamper) ? tamper.length : tamper.error,
      }
    },
    expect: {
      unk: ['unknown', 0],
      fixed: ['kv', 1, 30],
      after: ['kv', 30],
      none: ['none', 0, 31],
      tamper: 0,
    },
  },
  {
    id: 'A3',
    name: '反証レビュー中5: 写しを職員が直接作る・unknown の写しを書き換える経路が無い（過去の日の偽の写し・日付の付け替え）・非会員は開所できない',
    async run(h) {
      const d = await today(h)
      const ins = await h.as({}, (q) =>
        q(`insert into public.daycare_days (day, plan_source, plan_rows) values ('2026-10-01', 'kv', '[{"sched_id":"x"}]'::jsonb) returning id`),
      )
      await h.pg(`insert into public.daycare_days (id, day, plan_source) overriding system value values (991, '2026-10-02', 'unknown')`)
      const upd = await h.as({}, (q) =>
        q(`update public.daycare_days set day = '2026-01-05', plan_source = 'kv', plan_rows = '[{"sched_id":"y"}]'::jsonb where id = 991 returning id`),
      )
      const row = (await h.pg(`select day::text d, plan_source s from public.daycare_days where id = 991`))[0]
      const out = await h.as({ member: false }, (q) => q(`select public.daycare_open_day($1::date, 1) as r`, [d]))
      const outRows = (await h.pg(`select count(*)::int n from public.daycare_days where day = $1::date`, [d]))[0].n
      return { ins: Array.isArray(ins) ? 'ok' : ins.error, upd: Array.isArray(upd) ? upd.length : upd.error, row, out: out.error ?? 'ok', outRows }
    },
    expect: { ins: '42501', upd: 0, row: { d: '2026-10-02', s: 'unknown' }, out: '42501', outRows: 0 },
  },
  {
    id: 'A2/重大1',
    name: '反証レビュー重大1: bath_resident_id（予定から 12:30 の自動の入浴が行を作る相手）が、cron（care_auto_bath_on）が実際に作った相手と一致する（氏名の食い違い・氏名だけの照合・外部・入院・入浴なしを混ぜて）',
    async run(h) {
      const d = '2026-10-19'
      const w = dowOf(d)
      await h.pg(`insert into public.app_settings (key, value) values ('input_enabled_bath', 'true') on conflict (key) do update set value = 'true'`)
      await putSchedule(h, [
        schedRes('a', { masterId: 'M001', name: '見本 一郎' }, [{ dow: w, bathing: true }]),
        schedRes('b', { masterId: 'M002', name: '見本 別名' }, [{ dow: w, bathing: true }]), // 氏名が食い違う（mismatch）でも cron は作る
        schedRes('c', { name: '見本 次郎' }, [{ dow: w, bathing: true }]), // 利用者No なし（氏名だけで照合）＝cron は作らない
        schedRes('e', { external: true, name: '見本 外部' }, [{ dow: w, bathing: true }]),
        schedRes('f', { masterId: 'M004', name: '見本 和子', hospitalized: true }, [{ dow: w, bathing: true }]),
        schedRes('g', { masterId: 'M005', name: '見本 三郎' }, [{ dow: w, bathing: false }]),
        schedRes('i', { masterId: 'M006', name: '見本 退所' }, [{ dow: w, bathing: true }]), // 名簿で在籍でない
      ])
      const rows = await plan(h, d)
      const planned = [...new Set(rows.map((r) => r.bath_resident_id).filter((x) => x !== null).map(String))].sort()
      const mm = rows.find((r) => r.sched_id === 'b')
      await h.pg(`select private.care_auto_bath_on($1::date)`, [d])
      const made = (await h.pg(`select resident_id::text r from public.bath_records where bath_on = $1::date and auto order by 1`, [d])).map((x) => x.r)
      return { planned, made, mismatch: [mm?.match, mm?.resident_id ?? null, String(mm?.bath_resident_id)] }
    },
    expect: { planned: ['1', '2'], made: ['1', '2'], mismatch: ['mismatch', null, '2'] },
  },
  {
    id: 'A3',
    name: '開所の写しに氏名が入らない（plan_rows のキーに name が無い）',
    async run(h) {
      const d = await today(h)
      await putSchedule(h, [schedRes('r1', { masterId: 'M001', name: '見本 一郎' }, [{ dow: dowOf(d) }])])
      const r = await h.as({}, (q) => q(`select public.daycare_open_day($1::date, 1) as r`, [d]))
      const keys = Object.keys(r[0].r.plan_rows[0] ?? {}).sort()
      return { keys, hasName: JSON.stringify(r[0].r).includes('見本') }
    },
    expect: {
      keys: ['bath_resident_id', 'bathing', 'dup', 'end_time', 'event_id', 'external', 'hospitalized', 'match', 'plan_rev', 'resident_id', 'sched_id', 'start_time', 'updated_at'],
      hasName: false,
    },
  },

  // ── デイの測定（observation＋冪等キー dc:）が 0011 をそのまま通る（A1(a)・中10） ──
  {
    id: 'A1a',
    name: 'デイの測定: kind=observation・client_key=dc:… で 0011 を通る・定時と別の行',
    async run(h) {
      const ck = 'dc:2026-10-21:1:1'
      const routine = await h.as({}, (q) =>
        q(`select public.apply_cell_edits('vitals', '{"resident_id":1,"measured_on":"2026-10-21"}', '{"temp":{"value":36.4,"base":null}}', '{}', 1) r`),
      )
      const dc = await h.as({}, (q) =>
        q(`select public.apply_cell_edits('vitals', $1::jsonb, '{"temp":{"value":36.8,"base":null},"pulse":{"value":72,"base":null}}', '{"measured_at":"10:05","recorded_by":2}', 2, $2) r`, [
          JSON.stringify({ client_key: ck, resident_id: 1, measured_on: '2026-10-21', kind: 'observation' }),
          ck,
        ]),
      )
      const rows = await h.pg(`select kind, client_key, temp::text t, pulse, measured_at::text m, recorded_by from public.vitals where resident_id = 1 and measured_on = '2026-10-21' order by id`)
      return { routine: routine[0].r.status, dc: dc[0].r.status, rows }
    },
    expect: {
      routine: 'applied',
      dc: 'applied',
      rows: [
        { kind: 'routine', client_key: null, t: '36.4', pulse: null, m: null, recorded_by: null },
        { kind: 'observation', client_key: 'dc:2026-10-21:1:1', t: '36.8', pulse: 72, m: '10:05:00', recorded_by: '2' },
      ],
    },
  },
  {
    id: 'A1a',
    name: '中10: 2台が同じ人の1回目を同じキーで送る → 1行のまま・後着の違う値は競合（同じ値は載っている）',
    async run(h) {
      const ck = 'dc:2026-10-21:2:1'
      const key = JSON.stringify({ client_key: ck, resident_id: 2, measured_on: '2026-10-21', kind: 'observation' })
      const a = await h.as({}, (q) =>
        q(`select public.apply_cell_edits('vitals', $1::jsonb, '{"temp":{"value":36.6,"base":null},"spo2":{"value":97,"base":null}}', '{}', 1, $2) r`, [key, ck]),
      )
      const b = await h.as({}, (q) =>
        q(`select public.apply_cell_edits('vitals', $1::jsonb, '{"temp":{"value":36.9,"base":null},"spo2":{"value":97,"base":null}}', '{}', 2, $2) r`, [key, ck]),
      )
      const n = (await h.pg(`select count(*)::int n from public.vitals where client_key = $1`, [ck]))[0].n
      const t = (await h.pg(`select temp::text t from public.vitals where client_key = $1`, [ck]))[0].t
      const br = b[0].r
      return { a: a[0].r.status, b: br.status, conflictFields: br.conflicts.map((c) => c.field), settled: br.settled, n, t }
    },
    expect: { a: 'applied', b: 'conflict', conflictFields: ['temp'], settled: ['spo2'], n: 1, t: '36.6' },
  },
  {
    id: 'A1a',
    name: '取り消したデイの測定のキーには書けない（作り直さない＝missing）・次の回のキーは新しい行',
    async run(h) {
      const ck1 = 'dc:2026-10-21:3:1'
      const key1 = JSON.stringify({ client_key: ck1, resident_id: 3, measured_on: '2026-10-21', kind: 'observation' })
      await h.as({}, (q) => q(`select public.apply_cell_edits('vitals', $1::jsonb, '{"temp":{"value":36.5,"base":null}}', '{}', 1, $2)`, [key1, ck1]))
      await h.pg(`update public.vitals set deleted_at = now() where client_key = $1`, [ck1])
      const again = await h.as({}, (q) => q(`select public.apply_cell_edits('vitals', $1::jsonb, '{"temp":{"value":36.7,"base":null}}', '{}', 1, $2) r`, [key1, ck1]))
      const ck2 = 'dc:2026-10-21:3:2'
      const key2 = JSON.stringify({ client_key: ck2, resident_id: 3, measured_on: '2026-10-21', kind: 'observation' })
      const next = await h.as({}, (q) => q(`select public.apply_cell_edits('vitals', $1::jsonb, '{"temp":{"value":36.7,"base":null}}', '{}', 1, $2) r`, [key2, ck2]))
      const live = (await h.pg(`select count(*)::int n from public.vitals where resident_id = 3 and deleted_at is null`))[0].n
      return { again: [again[0].r.status, again[0].r.conflicts[0]?.reason], next: next[0].r.status, live }
    },
    expect: { again: ['conflict', 'missing'], next: 'applied', live: 1 },
  },
  {
    id: 'A1a',
    name: 'デイの測定は timeline_chunk に「経過観察」の行として出る（既存の画面に見える）',
    async run(h) {
      const ck = 'dc:2026-10-21:4:1'
      await h.as({}, (q) =>
        q(`select public.apply_cell_edits('vitals', $1::jsonb, '{"temp":{"value":38.1,"base":null}}', '{}', 1, $2)`, [
          JSON.stringify({ client_key: ck, resident_id: 4, measured_on: '2026-10-21', kind: 'observation' }),
          ck,
        ]),
      )
      const r = await h.as({}, (q) => q(`select public.timeline_chunk('2026-10-21', '2026-10-21', null) as t`))
      const v = (r[0].t.vitals ?? []).filter((x) => x.resident_id === 4)
      return { n: v.length, kind: v[0]?.kind ?? null, temp: Number(v[0]?.temp ?? 0) }
    },
    expect: { n: 1, kind: 'observation', temp: 38.1 },
  },

  // ── 欠席と 12:30 の入浴の自動の行（A2 の DB の側） ──
  {
    id: 'A2',
    name: '先に欠席（cancel・absent の行がある）→ 自動の処理は作らない',
    async run(h) {
      const d = '2026-10-19' // 月曜
      await h.pg(`insert into public.app_settings (key, value) values ('input_enabled_bath', 'true') on conflict (key) do update set value = 'true'`)
      await putSchedule(h, [schedRes('r1', { masterId: 'M001', name: '見本 一郎' }, [{ dow: dowOf(d), bathing: true }])])
      await h.as({}, (q) => q(`insert into public.bath_records (resident_id, bath_on, result, cancel_reason, recorded_by, client_key) values (1, $1::date, 'cancel', 'absent', 2, 'ck-a2-1')`, [d]))
      const made = (await h.pg(`select private.care_auto_bath_on($1::date) n`, [d]))[0].n
      const rows = await h.pg(`select result, cancel_reason, auto from public.bath_records where resident_id = 1 and bath_on = $1::date`, [d])
      return { made, rows }
    },
    expect: { made: 0, rows: [{ result: 'cancel', cancel_reason: 'absent', auto: false }] },
  },
  {
    id: 'A2',
    name: '後で欠席: 自動の行（auto=true）を rev 照合で cancel・absent・auto=false に直せる・変更の記録が残る',
    async run(h) {
      const d = '2026-10-19'
      await h.pg(`insert into public.app_settings (key, value) values ('input_enabled_bath', 'true') on conflict (key) do update set value = 'true'`)
      await putSchedule(h, [schedRes('r1', { masterId: 'M001', name: '見本 一郎' }, [{ dow: dowOf(d), bathing: true }])])
      const made = (await h.pg(`select private.care_auto_bath_on($1::date) n`, [d]))[0].n
      const cur = (await h.pg(`select id, rev, result, auto from public.bath_records where resident_id = 1 and bath_on = $1::date`, [d]))[0]
      const upd = await h.as({}, (q) =>
        q(`update public.bath_records set result = 'cancel', cancel_reason = 'absent', auto = false, recorded_by = 2, edited_by = 2 where id = $1 and rev = $2 returning rev`, [cur.id, cur.rev]),
      )
      const after = (await h.pg(`select result, cancel_reason, auto from public.bath_records where id = $1`, [cur.id]))[0]
      const hist = (await h.pg(`select count(*)::int n from public.record_history where table_name = 'bath_records' and row_id = $1`, [cur.id]))[0].n
      const again = (await h.pg(`select private.care_auto_bath_on($1::date) n`, [d]))[0].n
      return { made, before: [cur.result, cur.auto], rev: upd[0]?.rev ?? null, after, hist, again }
    },
    expect: { made: 1, before: ['full', true], rev: 2, after: { result: 'cancel', cancel_reason: 'absent', auto: false }, hist: 1, again: 0 },
  },
  {
    id: 'A2',
    name: '入浴の旗が false の日は自動の行を作らない（欠席の入浴の行も書かない前提）',
    async run(h) {
      const d = '2026-10-19'
      await h.pg(`insert into public.app_settings (key, value) values ('input_enabled_bath', 'false') on conflict (key) do update set value = 'false'`)
      await putSchedule(h, [schedRes('r1', { masterId: 'M001', name: '見本 一郎' }, [{ dow: dowOf(d), bathing: true }])])
      const made = (await h.pg(`select private.care_auto_bath_on($1::date) n`, [d]))[0].n
      return { made }
    },
    expect: { made: 0 },
  },
  {
    id: 'A2/軽18',
    name: '実測: 外泊中（outings の overnight）でも入浴の予定があれば自動の「全身浴」が入る（既存の挙動・直さない）',
    async run(h) {
      const d = '2026-10-19'
      await h.pg(`insert into public.app_settings (key, value) values ('input_enabled_bath', 'true') on conflict (key) do update set value = 'true'`)
      await putSchedule(h, [schedRes('r1', { masterId: 'M001', name: '見本 一郎' }, [{ dow: dowOf(d), bathing: true }])])
      await h.pg(`insert into public.outings (resident_id, kind, start_on, end_on) values (1, 'overnight', '2026-10-18', '2026-10-20')`)
      const made = (await h.pg(`select private.care_auto_bath_on($1::date) n`, [d]))[0].n
      const row = (await h.pg(`select result, auto from public.bath_records where resident_id = 1 and bath_on = $1::date`, [d]))[0] ?? null
      return { made, row }
    },
    expect: { made: 1, row: { result: 'full', auto: true } },
  },

  // ── Realtime・関数の権限 ──
  {
    id: 'D14',
    name: '到着・欠席の表は Realtime に載る・関数は authenticated だけが実行できる（anon・public は不可）・開所は security definer（写しはこの関数だけが書く）',
    async run(h) {
      const pub = (await h.pg(`select count(*)::int n from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'daycare_attendance'`))[0].n
      const days = (await h.pg(`select count(*)::int n from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'daycare_days'`))[0].n
      const perm = await h.pg(
        `select p.proname, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, p.prosecdef definer
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in ('daycare_plan', 'daycare_open_day') order by p.proname`,
      )
      return { pub, days, perm }
    },
    expect: {
      pub: 1,
      days: 0,
      perm: [
        { proname: 'daycare_open_day', anon: false, auth: true, definer: true },
        { proname: 'daycare_plan', anon: false, auth: true, definer: false },
      ],
    },
  },
  // ── 0042: 過去の日の到着・帰宅の時刻は事務所だけ（代表者の決定 2026-10-22） ──
  {
    id: '0042-1',
    name: '現場: 過去の日に時刻つきの追加は 42501（daycare_past_times_office_only）・時刻なし（欠席）の追加と今日の到着は通る',
    async run(h) {
      const T = `(now() at time zone 'Asia/Tokyo')::date`
      const ins = (vals) =>
        h.as({ appRole: 'field' }, (q) => q(`insert into public.daycare_attendance (resident_id, day, arrived_at, left_at, absent, absent_reason, client_key) values (${vals}) returning id`))
      const code = (r) => (Array.isArray(r) ? 'ok' : r.error)
      const pastTimes = await ins(`1, ${T} - 1, '09:30', null, false, null, 'g1-a'`)
      const msg = await h.as({ appRole: 'field' }, async (q) => {
        try {
          await q(`savepoint m`)
          await q(`insert into public.daycare_attendance (resident_id, day, arrived_at, client_key) values (1, ${T} - 1, '09:30', 'g1-m')`)
          return 'no-error'
        } catch (e) {
          await q(`rollback to savepoint m`)
          return String(e.message).split(':')[0]
        }
      })
      return {
        pastTimes: code(pastTimes),
        msg,
        pastAbsent: code(await ins(`2, ${T} - 1, null, null, true, 'condition', 'g1-b'`)),
        todayTimes: code(await ins(`3, ${T}, '09:30', null, false, null, 'g1-c'`)),
      }
    },
    expect: { pastTimes: '42501', msg: 'daycare_past_times_office_only', pastAbsent: 'ok', todayTimes: 'ok' },
  },
  {
    id: '0042-2',
    name: '現場: 過去の日の時刻の修正・時刻の入った方の欠席・帰宅の取り消し・時刻の入った行の取り消し（soft delete）・日付の移し替えは 42501／備考・時刻の無い方の欠席・欠席の取り消しは通る',
    async run(h) {
      const T = `(now() at time zone 'Asia/Tokyo')::date`
      // 所有者の接続（役割なし＝止めない）で過去の日の行を用意する
      await h.pg(`insert into public.daycare_attendance (id, resident_id, day, arrived_at, left_at, client_key) overriding system value values
        (701, 1, ${T} - 1, '09:30', '15:30', 'g2-1'),
        (702, 2, ${T} - 1, null, null, 'g2-2'),
        (703, 3, ${T} - 2, '09:00', null, 'g2-3'),
        (705, 5, ${T}, '09:00', null, 'g2-5')`)
      await h.pg(`insert into public.daycare_attendance (id, resident_id, day, absent, absent_reason, client_key) overriding system value values (704, 4, ${T} - 1, true, 'wish', 'g2-4')`)
      const up = (sql) => h.as({ appRole: 'field' }, (q) => q(sql))
      const code = (r) => (Array.isArray(r) ? 'ok' : r.error)
      return {
        changeLeft: code(await up(`update public.daycare_attendance set left_at = '16:00', edited_by = 1 where id = 701 returning id`)),
        absentWithTimes: code(await up(`update public.daycare_attendance set absent = true, absent_reason = 'condition', arrived_at = null, left_at = null where id = 701 returning id`)),
        cancelLeave: code(await up(`update public.daycare_attendance set left_at = null where id = 701 returning id`)),
        softDelete: code(await up(`update public.daycare_attendance set deleted_at = now(), deleted_by = 1 where id = 703 returning id`)),
        moveDay: code(await up(`update public.daycare_attendance set day = ${T} - 1 where id = 705 returning id`)),
        noteOnly: code(await up(`update public.daycare_attendance set note = '見本の備考' where id = 701 returning id`)),
        absentNoTimes: code(await up(`update public.daycare_attendance set absent = true, absent_reason = 'family' where id = 702 returning id`)),
        cancelAbsent: code(await up(`update public.daycare_attendance set absent = false, absent_reason = null where id = 704 returning id`)),
        todayLeave: code(await up(`update public.daycare_attendance set left_at = '15:00' where id = 705 returning id`)),
        kept: (await h.pg(`select left_at::text l from public.daycare_attendance where id = 701`))[0].l,
      }
    },
    expect: {
      changeLeft: '42501',
      absentWithTimes: '42501',
      cancelLeave: '42501',
      softDelete: '42501',
      moveDay: '42501',
      noteOnly: 'ok',
      absentNoTimes: 'ok',
      cancelAbsent: 'ok',
      todayLeave: 'ok',
      kept: '15:30:00',
    },
  },
  {
    id: '0042-2b',
    name: '現場: 過去の日の時刻の入った行を別の方へ付け替える・取り消した時刻の入った行を戻すのは 42501／時刻の無い行の付け替えは通る（反証レビュー4巡目 F6）',
    async run(h) {
      const T = `(now() at time zone 'Asia/Tokyo')::date`
      await h.pg(`insert into public.daycare_attendance (id, resident_id, day, arrived_at, left_at, client_key) overriding system value values
        (711, 1, ${T} - 1, '09:30', null, 'g2b-1'),
        (712, 2, ${T} - 1, null, null, 'g2b-2')`)
      await h.pg(`insert into public.daycare_attendance (id, resident_id, day, arrived_at, client_key, deleted_at, deleted_by) overriding system value values (713, 3, ${T} - 1, '09:00', 'g2b-3', now(), 1)`)
      const up = (sql) => h.as({ appRole: 'field' }, (q) => q(sql))
      const code = (r) => (Array.isArray(r) ? 'ok' : r.error)
      return {
        moveTimed: code(await up(`update public.daycare_attendance set resident_id = 4 where id = 711 returning id`)),
        restoreTimed: code(await up(`update public.daycare_attendance set deleted_at = null, deleted_by = null where id = 713 returning id`)),
        moveBlank: code(await up(`update public.daycare_attendance set resident_id = 5 where id = 712 returning id`)),
        officeRestore: code(await h.as({ appRole: 'office' }, (q) => q(`update public.daycare_attendance set deleted_at = null, deleted_by = null where id = 713 returning id`))),
      }
    },
    expect: { moveTimed: '42501', restoreTimed: '42501', moveBlank: 'ok', officeRestore: 'ok' },
  },
  {
    id: '0042-3',
    name: '事務所（office）と役割なしの接続は、過去の日の時刻を入力・修正・取り消しできる',
    async run(h) {
      const T = `(now() at time zone 'Asia/Tokyo')::date`
      const code = (r) => (Array.isArray(r) ? 'ok' : r.error)
      const off = (sql) => h.as({ appRole: 'office' }, (q) => q(sql))
      const none = (sql) => h.as({}, (q) => q(sql))
      return {
        officeInsert: code(await off(`insert into public.daycare_attendance (id, resident_id, day, arrived_at, client_key) overriding system value values (801, 1, ${T} - 3, '09:10', 'g3-1') returning id`)),
        officeLeave: code(await off(`update public.daycare_attendance set left_at = '15:20' where id = 801 returning id`)),
        officeFix: code(await off(`update public.daycare_attendance set arrived_at = '09:05' where id = 801 returning id`)),
        officeCancel: code(await off(`update public.daycare_attendance set left_at = null where id = 801 returning id`)),
        noRoleInsert: code(await none(`insert into public.daycare_attendance (resident_id, day, arrived_at, client_key) values (2, ${T} - 3, '09:30', 'g3-2') returning id`)),
        row: (await h.pg(`select arrived_at::text a, left_at::text l from public.daycare_attendance where id = 801`))[0],
      }
    },
    expect: {
      officeInsert: 'ok',
      officeLeave: 'ok',
      officeFix: 'ok',
      officeCancel: 'ok',
      noRoleInsert: 'ok',
      row: { a: '09:05:00', l: null },
    },
  },
  {
    id: '0042-4',
    name: 'トリガは insert と update の2つ・関数は誰にも実行の許可を出さない（トリガからだけ）・ポリシーは 0041 のまま',
    async run(h) {
      const trg = await h.pg(
        `select event_manipulation ev, action_timing t from information_schema.triggers
          where event_object_table = 'daycare_attendance' and trigger_name = 'trg_daycare_attendance_past_guard' order by 1`,
      )
      const fn = (await h.pg(
        `select has_function_privilege('authenticated', 'public.daycare_attendance_past_guard()', 'execute') auth,
                has_function_privilege('anon', 'public.daycare_attendance_past_guard()', 'execute') anon,
                (select prosecdef from pg_proc where oid = 'public.daycare_attendance_past_guard()'::regprocedure) definer`,
      ))[0]
      const pol = (await h.pg(`select string_agg(policyname, ',' order by policyname) p from pg_policies where schemaname = 'public' and tablename = 'daycare_attendance'`))[0].p
      return { trg, fn, pol }
    },
    expect: {
      trg: [
        { ev: 'INSERT', t: 'BEFORE' },
        { ev: 'UPDATE', t: 'BEFORE' },
      ],
      fn: { auth: false, anon: false, definer: true },
      pol: 'insert_auth,member_only,read_auth,update_auth',
    },
  },
]

/** 観測と期待の突き合わせ（JSON 表記で比べる）。食い違いの一覧を返す（空なら一致）。expect の値が undefined のキーは見ない */
export function checkDaycareCase(c, observed) {
  const out = []
  for (const [k, v] of Object.entries(c.expect)) {
    const o = observed?.[k]
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && o !== null && typeof o === 'object' && !Array.isArray(o)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 === undefined) continue
        if (JSON.stringify(o[k2] ?? null) !== JSON.stringify(v2 ?? null)) out.push(`${k}.${k2}: ${JSON.stringify(o[k2])} != ${JSON.stringify(v2)}`)
      }
      for (const k2 of Object.keys(o)) if (!(k2 in v)) out.push(`${k}.${k2}: 期待に無い ${JSON.stringify(o[k2])}`)
      continue
    }
    if (JSON.stringify(o ?? null) !== JSON.stringify(v ?? null)) out.push(`${k}: ${JSON.stringify(o)} != ${JSON.stringify(v)}`)
  }
  return out
}
