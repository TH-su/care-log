// 0052（施設の印の段階2）を、素の Postgres（0001〜最新を適用済み）で確かめる実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/tenant-stage2-pg.mjs
//
// 施設 A（試験の土台の施設 aa）と施設 B（この試験で足す bb）に、それぞれの利用者・服薬の時間帯・週間計画・旗を置いて確かめる:
//   1. 定時の処理の入口（与薬・入浴・デイの到着と帰宅）が、両方の施設に、その施設の印で、その施設の利用者の記録だけを書く
//      （一意を施設ごとにした段階③の形を、トランザクションの中だけで真似る）
//   2. 今の一意（旗の key・その日の写しの day）のままでは、施設 B は「何もしない」側に倒れ、施設 A は今までどおり書く
//   3. 1つの施設で失敗しても、もう1つの施設は書く。全部の施設で失敗した時だけ誤りが上がる。回した後は carelog.tenant が戻る
//   4. 変更の記録（record_history）は、変えた行の施設の印を持つ（施設が2つでサーバーの接続の時も）
//   5. デイの開所（daycare_open_day）は、施設 A の人なら施設 A の写しだけを読み書きし、施設 B の写しには触れない。
//      その日の予定（daycare_plan）も施設 A の名簿だけで照合する
//   6. 施設が1つの時は、入口の結果が本体を直接呼んだ時と同じ（今の動きのまま）
//   7. 施設が2つで、施設が決まらない直接の呼び出しは何も書かずに止まる。印を入れるトリガはサーバーが決めた施設の印を入れる
// 1件ずつトランザクションを張り、最後に必ず rollback する（表に何も残さない）。個人情報は置かない（利用者01・職員01 と数値IDだけ）。

import pg from 'pg'

const url = process.env.CARELOG_PG_URL
if (!url || !/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('CARELOG_PG_URL に使い捨てのローカル DB（127.0.0.1）を指定してください。')
  process.exit(2)
}

const A = '00000000-0000-0000-0000-0000000000aa'
const B = '00000000-0000-0000-0000-0000000000bb'
const UID = '00000000-0000-0000-0000-000000000001'
/** 施設ごとの利用者（id・利用者No）。利用者No は今の一意（全体）に合わせて施設ごとに別にする */
const RES = {
  [A]: [{ id: 101, sid: 'A01', name: '利用者01' }, { id: 102, sid: 'A02', name: '利用者02' }, { id: 103, sid: 'A03', name: '利用者03' }],
  [B]: [{ id: 201, sid: 'B01', name: '利用者11' }, { id: 202, sid: 'B02', name: '利用者12' }],
}
const FLAGS = ['input_enabled_med', 'input_enabled_bath', 'input_enabled_daycare', 'auto_enabled_daycare_attendance']

const client = new pg.Client({ connectionString: url })
await client.connect()
pg.types.setTypeParser(1082, (v) => v)
const q = async (text, params) => (await client.query(text, params)).rows
let failed = 0
const ok = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`)
  else { failed++; console.log(`  ✗ ${label}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`) }
}

async function inTx(title, fn) {
  console.log(`── ${title}`)
  await client.query('begin')
  // 本番の自動の記録・取込と同じ「ログインの無いサーバーの接続」（my_tenant() が null）で始める。ログインした人は asUser で真似る
  await client.query(`select set_config('test.tenant', 'none', true)`)
  try {
    await fn()
  } catch (e) {
    failed++
    console.log(`  ✗ 例外: ${e?.code ?? ''} ${e?.message ?? e}`)
  } finally {
    await client.query('rollback')
  }
}

/** 日本時間の今日・曜日（0=月）・今の時刻の5分前（00:00 より前にはしない）を DB の時計で */
async function clock() {
  const r = (await q(`select to_char((now() at time zone 'Asia/Tokyo')::date, 'YYYY-MM-DD') as day,
                             (extract(isodow from (now() at time zone 'Asia/Tokyo')::date)::int - 1) as dow,
                             to_char(greatest((now() at time zone 'Asia/Tokyo')::time - interval '5 minutes', time '00:00'), 'HH24:MI') as st`))[0]
  return r
}

/** 段階③の一意（施設と旗の名前・施設と日付）をトランザクションの中だけで真似る */
async function stage3Keys() {
  await q(`alter table public.app_settings drop constraint app_settings_pkey`)
  await q(`alter table public.app_settings add constraint app_settings_pkey primary key (tenant_id, key)`)
  await q(`drop index public.uq_daycare_days_day`)
  await q(`create unique index uq_daycare_days_day on public.daycare_days (tenant_id, day)`)
}

/** 施設の旗を全部オンにする（施設 A は今ある行を書き換える・施設 B は行を足す＝段階③の一意が要る） */
async function flagsOn(t) {
  for (const k of FLAGS) {
    const n = (await client.query(`update public.app_settings set value = 'true' where key = $1 and tenant_id = $2`, [k, t])).rowCount
    if (n === 0) await q(`insert into public.app_settings (key, value, tenant_id) values ($1, 'true', $2)`, [k, t])
  }
  const n = (await client.query(`update public.app_settings set value = '' where key = 'daycare_closed_dates' and tenant_id = $1`, [t])).rowCount
  if (n === 0) await q(`insert into public.app_settings (key, value, tenant_id) values ('daycare_closed_dates', '', $1)`, [t])
}

/** 施設の利用者・服薬の時間帯（朝）・週間計画（今日の曜日にデイ・入浴あり・開始は今の5分前）を置く */
async function seedTenant(t, c) {
  for (const r of RES[t]) {
    await q(`insert into public.residents (id, source_id, name, active, tenant_id) overriding system value values ($1, $2, $3, true, $4)`,
      [r.id, r.sid, r.name, t])
    await q(`insert into public.med_slots (resident_id, slots, tenant_id) values ($1, array['morning','noon','evening','bedtime'], $2)`, [r.id, t])
  }
  const residents = RES[t].map((r, i) => ({
    id: `s${r.id}`, masterId: r.sid, name: r.name,
    events: [{ id: `e${i}`, serviceType: 'daycare', dayOfWeek: c.dow, startTime: c.st, endTime: '23:59', bathing: true }],
  }))
  await q(`insert into public.kv_entries (tenant_id, key, data, rev) values ($1, 'care_schedule_v2', $2::jsonb, 3)
           on conflict (tenant_id, key) do update set data = excluded.data`, [t, JSON.stringify({ residents })])
}

/** 施設 B と両方の施設のデータを置く。stage3=true なら段階③の一意を真似て、施設 B の旗も入れる */
async function seedTwo({ stage3 = true } = {}) {
  await q(`insert into public.tenants (id, name) values ($1, '見本の施設B') on conflict (id) do nothing`, [B])
  const c = await clock()
  if (stage3) await stage3Keys()
  await seedTenant(A, c)
  await seedTenant(B, c)
  await flagsOn(A)
  if (stage3) await flagsOn(B)
  return c
}

/** 表の行を [施設, 利用者] にして、施設ごとに利用者が自分の施設の利用者だけかを見る */
async function rowsBy(table, dayCol, day) {
  return q(`select x.tenant_id::text as t, x.resident_id::int as rid, r.tenant_id::text as rt
              from public.${table} x join public.residents r on r.id = x.resident_id
             where x.${dayCol} = $1::date order by x.resident_id`, [day])
}
const ridsOf = (rows, t) => rows.filter((r) => r.t === t).map((r) => r.rid)
const noCross = (rows) => rows.every((r) => r.t === r.rt && (r.t === A ? r.rid < 200 : r.rid >= 200))

/** ログインした人（authenticated）として fn を流す。例外は SQLSTATE で返す */
async function asUser(tenant, fn) {
  await client.query('savepoint as_user')
  await client.query(`set local role authenticated`)
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
  await client.query(`select set_config('test.member', 'true', true)`)
  await client.query(`select set_config('test.role', 'field', true)`)
  await client.query(`select set_config('test.tenant', $1, true)`, [tenant])
  try {
    const r = await fn()
    await client.query('reset role')
    await client.query('release savepoint as_user')
    return r
  } catch (e) {
    await client.query('rollback to savepoint as_user')
    await client.query('reset role')
    if (typeof e?.code !== 'string') throw e
    return { error: e.code }
  }
}

// 1. 入口が両方の施設に、その施設の印で書く（段階③の一意を真似る）
await inTx('定時の処理の入口は施設ごとに回り、施設を越えない', async () => {
  const c = await seedTwo()
  const med = (await q(`select private.care_auto_med('morning') as n`))[0].n
  const medRows = await rowsBy('med_admin', 'admin_on', c.day)
  ok('与薬: 両方の施設の利用者に入る（A 3人・B 2人＝5件）', med === 5 && ridsOf(medRows, A).length === 3 && ridsOf(medRows, B).length === 2, { med, medRows })
  ok('与薬: どの行も利用者と同じ施設の印・施設を越えない', noCross(medRows), medRows)

  const bath = (await q(`select private.care_auto_bath() as n`))[0].n
  const bathRows = await rowsBy('bath_records', 'bath_on', c.day)
  ok('入浴: 両方の施設の予定者に入る（5件）', bath === 5 && ridsOf(bathRows, A).length === 3 && ridsOf(bathRows, B).length === 2, { bath, bathRows })
  ok('入浴: どの行も利用者と同じ施設の印', noCross(bathRows), bathRows)

  const dc = (await q(`select private.daycare_auto_attendance() as r`))[0].r
  const attRows = await rowsBy('daycare_attendance', 'day', c.day)
  ok('デイの到着: 両方の施設に入る（5件・返り値の形は今と同じ）',
    dc.arrived === 5 && ridsOf(attRows, A).length === 3 && ridsOf(attRows, B).length === 2
      && JSON.stringify(Object.keys(dc).sort()) === JSON.stringify(['arrived', 'day', 'left', 'skipped', 'snapshot']) && dc.skipped === null && dc.snapshot === true,
    { dc, attRows })
  ok('デイの到着: どの行も利用者と同じ施設の印', noCross(attRows), attRows)
  const days = await q(`select tenant_id::text as t, (select array_agg((e ->> 'resident_id')::int order by 1) from jsonb_array_elements(plan_rows) e) as rids
                          from public.daycare_days where day = $1::date order by tenant_id`, [c.day])
  ok('デイの写し: 施設ごとに1行・写しの利用者はその施設の利用者だけ',
    days.length === 2 && days[0].t === A && days[0].rids.every((x) => x < 200) && days[1].t === B && days[1].rids.every((x) => x >= 200), days)
  ok('回した後は carelog.tenant が呼ぶ前（空）に戻る', ((await q(`select coalesce(current_setting('carelog.tenant', true), '') as v`))[0].v) === '')
})

// 2. 今の一意のまま（段階③の前）: 施設 B は何もしない・施設 A は今までどおり
await inTx('今の一意のまま（段階③の前）は、施設 B は何もしない側に倒れ、施設 A は今までどおり書く', async () => {
  const c = await seedTwo({ stage3: false })
  const med = (await q(`select private.care_auto_med('morning') as n`))[0].n
  const medRows = await rowsBy('med_admin', 'admin_on', c.day)
  ok('与薬: 施設 A だけに入る（B は旗の行が無い＝オンでない）', med === 3 && ridsOf(medRows, A).length === 3 && ridsOf(medRows, B).length === 0 && noCross(medRows), medRows)
  const bath = (await q(`select private.care_auto_bath() as n`))[0].n
  ok('入浴: 施設 A だけに入る', bath === 3, bath)
  const dc = (await q(`select private.daycare_auto_attendance() as r`))[0].r
  const attRows = await rowsBy('daycare_attendance', 'day', c.day)
  ok('デイの到着: 施設 A だけに入る（施設 B は旗が無い）', dc.arrived === 3 && ridsOf(attRows, B).length === 0 && noCross(attRows), { dc, attRows })
})

await inTx('今の一意のまま、よその施設がその日の写しを持つ時は、自分の施設の写しを作れず何もしない（よその写しを使わない）', async () => {
  const c = await seedTwo({ stage3: false })
  await q(`insert into public.daycare_days (day, plan_source, plan_rows, tenant_id) values ($1::date, 'kv', $2::jsonb, $3)`,
    [c.day, JSON.stringify([{ resident_id: 201, match: 'mid', dup: false, external: false, hospitalized: false, start_time: c.st, end_time: '23:59' }]), B])
  const dc = (await q(`select private.daycare_auto_attendance() as r`))[0].r
  const att = await q(`select resident_id::int as rid from public.daycare_attendance where day = $1::date`, [c.day])
  ok('施設 A は写しを作れない＝到着0件・施設 B の写しの利用者にも入れない', dc.arrived === 0 && att.length === 0 && dc.skipped === 'noplan', { dc, att })
})

// 3. 1つの施設で失敗しても他の施設は続ける
await inTx('1つの施設で失敗しても、もう1つの施設は書く・全部で失敗した時だけ誤りが上がる', async () => {
  const c = await seedTwo()
  await q(`create function pg_temp.fail_b() returns trigger language plpgsql as $$
           begin if new.tenant_id = '${B}'::uuid then raise exception 'test_fail_b'; end if; return new; end $$`)
  for (const t of ['med_admin', 'bath_records', 'daycare_attendance']) {
    await q(`create trigger zz_fail_b before insert on public.${t} for each row execute function pg_temp.fail_b()`)
  }
  // 呼ぶ前に carelog.tenant を施設 A にしておく（回した後にこの値へ戻るか）
  await q(`select set_config('carelog.tenant', $1, true)`, [A])
  const med = (await q(`select private.care_auto_med('morning') as n`))[0].n
  const medRows = await rowsBy('med_admin', 'admin_on', c.day)
  ok('与薬: 施設 B で失敗しても施設 A の3件は入る（B は0件）', med === 3 && ridsOf(medRows, A).length === 3 && ridsOf(medRows, B).length === 0, { med, medRows })
  const bath = (await q(`select private.care_auto_bath() as n`))[0].n
  ok('入浴: 施設 B で失敗しても施設 A の3件は入る', bath === 3, bath)
  const dc = (await q(`select private.daycare_auto_attendance() as r`))[0].r
  const att = await rowsBy('daycare_attendance', 'day', c.day)
  ok('デイ: 施設 B で失敗しても施設 A の3件は入る', dc.arrived === 3 && ridsOf(att, B).length === 0, { dc, att })
  ok('回した後は carelog.tenant が呼ぶ前の値に戻る', ((await q(`select current_setting('carelog.tenant', true) as v`))[0].v) === A)

  await q(`select set_config('carelog.tenant', '', true)`)
  await q(`create or replace function pg_temp.fail_b() returns trigger language plpgsql as $$ begin raise exception 'test_fail_all'; end $$`)
  await q(`savepoint all_fail`)
  let code = null
  let msg = null
  try { await q(`select private.care_auto_med('noon')`) } catch (e) { code = e.code; msg = e.message }
  await q(`rollback to savepoint all_fail`)
  ok('全部の施設で失敗した時は、最後の誤りがそのまま上がる（施設が1つの今と同じく cron の記録に失敗が残る）', code === 'P0001' && msg === 'test_fail_all', { code, msg })
  try { await q(`select private.care_auto_med('prn')`) } catch (e) { code = e.code; msg = e.message }
  ok('自動にできない時間帯は今と同じ誤り', /自動にできない時間帯です（prn）/.test(msg ?? ''), msg)
})

// 4. 変更の記録は変えた行の施設の印を持つ
await inTx('変更の記録（record_history）は、変えた行の施設の印を持つ', async () => {
  const c = await seedTwo()
  await q(`select private.care_auto_med('morning')`)
  // サーバーの接続（ログインなし・施設を決めていない・施設が2つ）で書き換える＝0051 のトリガだけでは印が決まらない形
  await q(`select set_config('test.tenant', 'none', true)`)
  await q(`update public.med_admin set status = 'refused' where admin_on = $1::date and resident_id in (101, 201)`, [c.day])
  const h = await q(`select (new_row ->> 'resident_id')::int as rid, tenant_id::text as t from public.record_history
                      where table_name = 'med_admin' and record_day = $1::date order by 1`, [c.day])
  ok('与薬の変更の記録: 施設 A の行は A・施設 B の行は B', h.length === 2 && h[0].rid === 101 && h[0].t === A && h[1].rid === 201 && h[1].t === B, h)

  await q(`insert into public.staff (id, name, tenant_id) overriding system value values (9101, '職員01', $1), (9201, '職員11', $2)`, [A, B])
  await q(`insert into public.attendance (day, staff_id, role, sort, tenant_id) values ($1::date, 9101, 'staff', 0, $2), ($1::date, 9201, 'staff', 0, $3)`, [c.day, A, B])
  await q(`update public.attendance set sort = -1 where day = $1::date`, [c.day])
  const ha = await q(`select row_id::int as sid, tenant_id::text as t from public.record_history where table_name = 'attendance' and record_day = $1::date order by 1`, [c.day])
  ok('出勤者の変更の記録: 施設ごとの印', ha.length === 2 && ha[0].t === A && ha[1].t === B, ha)

  await q(`update public.residents set note_alias = '表示名' where id in (102, 202)`)
  const hn = await q(`select row_id::int as rid, tenant_id::text as t from public.record_history
                       where table_name = 'residents' and row_id in (102, 202) order by 1`)
  ok('表示名の変更の記録: 施設ごとの印', hn.length === 2 && hn[0].t === A && hn[1].t === B, hn)
})

// 5. デイの開所は自分の施設の写しだけ
await inTx('デイの開所（daycare_open_day）は自分の施設の写しだけを読み書きする（段階③の一意を真似る）', async () => {
  const c = await seedTwo()
  await q(`insert into public.daycare_days (day, plan_source, plan_rows, tenant_id) values ($1::date, 'none', '[]'::jsonb, $2)`, [c.day, B])
  const before = (await q(`select md5(d::text) as m from public.daycare_days d where tenant_id = $1`, [B]))[0].m
  const plan = await asUser(A, async () => q(`select resident_id::int as rid, match from public.daycare_plan($1::date)`, [c.day]))
  ok('施設 A の人の予定は施設 A の名簿だけで照合（3件とも mid・施設 A の利用者）',
    Array.isArray(plan) && plan.length === 3 && plan.every((p) => p.match === 'mid' && p.rid < 200), plan)
  const r = await asUser(A, async () => (await q(`select public.daycare_open_day($1::date, null) as r`, [c.day]))[0].r)
  ok('施設 A の人の開所は施設 A の写しを作る（予定あり・施設 A の利用者だけ）',
    r?.plan_source === 'kv' && r.plan_rows.length === 3 && r.plan_rows.every((p) => p.resident_id < 200), r)
  const after = (await q(`select md5(d::text) as m from public.daycare_days d where tenant_id = $1`, [B]))[0].m
  ok('施設 B の写しには触れない', before === after)
  const mine = await q(`select tenant_id::text as t from public.daycare_days where day = $1::date and id = $2`, [c.day, r.id])
  ok('作った写しは施設 A の印', mine[0]?.t === A, mine)
  const rb = await asUser(B, async () => (await q(`select public.daycare_open_day($1::date, null) as r`, [c.day]))[0].r)
  ok('施設 B の人の開所は施設 B の写し（先にあった none の行）を返す', rb?.plan_source === 'none' && rb.id !== r.id, rb)
})

await inTx('今の一意のまま、よその施設がその日の写しを持つ時、開所はよその写しを返さない（作れませんでした 40001）', async () => {
  const c = await seedTwo({ stage3: false })
  await q(`insert into public.daycare_days (day, plan_source, plan_rows, tenant_id) values ($1::date, 'none', '[]'::jsonb, $2)`, [c.day, B])
  const r = await asUser(A, async () => (await q(`select public.daycare_open_day($1::date, null) as r`, [c.day]))[0].r)
  ok('施設 A の人には 40001（施設 B の写しを返さない・書き換えない）', r?.error === '40001', r)
  const n = await asUser('none', async () => (await q(`select public.daycare_open_day($1::date, null) as r`, [c.day]))[0].r)
  ok('施設の分からないログインは 42501', n?.error === '42501', n)
})

// 6. 施設が1つの時は今と同じ
await inTx('施設が1つの時は、入口の結果が本体を直接呼んだ時と同じ', async () => {
  const c = await clock()
  await seedTenant(A, c)
  await flagsOn(A)
  const snap = async () => ({
    med: await q(`select resident_id::int, slot, status, auto, client_key, tenant_id::text from public.med_admin where admin_on = $1::date order by 1`, [c.day]),
    bath: await q(`select resident_id::int, result, auto, client_key, tenant_id::text from public.bath_records where bath_on = $1::date order by 1`, [c.day]),
    att: await q(`select resident_id::int, arrived_at::text, left_at, arrived_auto, client_key, tenant_id::text from public.daycare_attendance where day = $1::date order by 1`, [c.day]),
  })
  await q('savepoint direct')
  const d1 = (await q(`select private.care_auto_med_on('morning', $1::date) as n`, [c.day]))[0].n
  const d2 = (await q(`select private.care_auto_bath_on($1::date) as n`, [c.day]))[0].n
  const d3 = (await q(`select private.daycare_auto_attendance_at(now()) as r`))[0].r
  const sd = await snap()
  await q('rollback to savepoint direct')
  const e1 = (await q(`select private.care_auto_med('morning') as n`))[0].n
  const e2 = (await q(`select private.care_auto_bath() as n`))[0].n
  const e3 = (await q(`select private.daycare_auto_attendance() as r`))[0].r
  const se = await snap()
  ok('与薬・入浴の件数が同じ（3件ずつ）', d1 === 3 && d2 === 3 && e1 === d1 && e2 === d2, { d1, d2, e1, e2 })
  ok('デイの返り値が同じ', JSON.stringify(d3) === JSON.stringify(e3), { d3, e3 })
  ok('書いた行が同じ（施設の印は施設 A）', JSON.stringify(sd) === JSON.stringify(se) && se.med.every((r) => r.tenant_id === A), { sd, se })
  ok('施設が1つの時、施設を決めない直接の呼び出しでもその施設で動く（今と同じ）', d1 === 3)
})

// 7. 施設が決まらない直接の呼び出し・印を入れるトリガ
await inTx('施設が2つで施設を決めない直接の呼び出しは止まる・トリガはサーバーが決めた施設の印を入れる', async () => {
  const c = await seedTwo()
  await q(`select set_config('test.tenant', 'none', true)`)
  let msg = null
  await q('savepoint d')
  try { await q(`select private.care_auto_med_on('morning', $1::date)`, [c.day]) } catch (e) { msg = e.message }
  await q('rollback to savepoint d')
  ok('与薬の本体を施設を決めずに呼ぶと何も書かずに止まる', /施設が1つに定まりません/.test(msg ?? ''), msg)
  ok('印の無い行は作らない（0件）', (await q(`select count(*)::int n from public.med_admin where admin_on = $1::date`, [c.day]))[0].n === 0)
  await q(`select set_config('carelog.tenant', $1, true)`, [B])
  ok('施設を決めると care_auto_tenant はその施設', (await q(`select private.care_auto_tenant()::text as t`))[0].t === B)
  ok('施設 B に決めて本体を呼ぶと施設 B の2件だけ', (await q(`select private.care_auto_med_on('morning', $1::date) as n`, [c.day]))[0].n === 2)
  await q(`insert into public.staff (id, name) overriding system value values (9301, '職員21')`)
  ok('サーバーが決めた施設（carelog.tenant）の印が入る', (await q(`select tenant_id::text t from public.staff where id = 9301`))[0].t === B)
  await q(`select set_config('carelog.tenant', '', true)`)
  await q(`insert into public.staff (id, name) overriding system value values (9302, '職員22')`)
  ok('決めていなければ 0051 と同じ（施設が2つ・ログインなし＝null）', (await q(`select tenant_id t from public.staff where id = 9302`))[0].t === null)
})

await client.end()
console.log(failed ? `\n失敗 ${failed} 件` : '\nすべて成功')
process.exit(failed === 0 ? 0 : 1)
