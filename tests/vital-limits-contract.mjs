// 移行 0045（個人のバイタルの閾値 resident_vital_limits・有効開始日つき・追記のみ）の契約。
// 素の Postgres で tests/vital-limits-pg.mjs が流す（tests/pg-run-all.mjs から）。
// 段階2の計画 v1（【AI取締役】の 20261022_段階2_計画_v1.md）の 3.2 と 8章 V3（遡り・書き換え・取り消し）・V4（役割・壊れた組・delete）を、
// DB の層で確かめる。
//
// ・LIMIT_CASES … 1件ずつ「準備（postgres の権限）→ 操作（authenticated／anon・役割・member の有無を切り替える）→ 観測」を行い、
//     expect と突き合わせる。各件は1つのトランザクションの中で動き、最後に必ず rollback する（表に何も残さない）。
// ・止めた時の文の頭（vital_limits_backdated: など）も確かめる（端末はこの頭で案内を出し分ける）。
// ・npm test では DB を使わない。移行の文面の静的検査と端末側の試験は tests/vital-limits.test.mjs。
//
// 個人情報は置かない（利用者は架空の「見本」姓・職員は 職員01 と数値IDだけ）。値は試験用の架空の数。

export { checkDaycareCase as checkLimitCase } from './daycare-contract.mjs'

export const LIMIT_SEED_SQL = [
  `insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02') on conflict (id) do nothing`,
  `insert into residents (id, source_id, name, active) overriding system value values
     (1, 'M001', '見本 一郎', true),
     (2, 'M002', '見本 花子', true)
   on conflict (id) do nothing`,
]

const TODAY = `(now() at time zone 'Asia/Tokyo')::date`

/** 1行足す（authenticated・opts の役割で）。成功は [{id, rev}]、失敗は { error, msg } */
const add = (h, v, opts = { appRole: 'office' }) =>
  h.as(opts, (q) =>
    q(
      `insert into public.resident_vital_limits
         (resident_id, valid_from, temp_warn_high, temp_danger_high, temp_danger_low, sys_bp_danger_high, sys_bp_warn_low,
          dia_bp_danger_high, dia_bp_warn_low, pulse_danger_high, pulse_warn_low, basis, set_by, client_key)
       values ($1, ${TODAY} + $2::int, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13) returning id, rev`,
      [
        v.resident ?? 1,
        v.offset ?? 0,
        v.temp_warn_high ?? null,
        v.temp_danger_high ?? null,
        v.temp_danger_low ?? null,
        v.sys_bp_danger_high ?? null,
        v.sys_bp_warn_low ?? null,
        v.dia_bp_danger_high ?? null,
        v.dia_bp_warn_low ?? null,
        v.pulse_danger_high ?? null,
        v.pulse_warn_low ?? null,
        v.basis ?? '主治医の指示（試験）',
        v.ck ?? null,
      ],
    ),
  )
const out = (r) => (Array.isArray(r) ? 'ok' : `${r.error}${r.msg ? `|${r.msg}` : ''}`)

export const LIMIT_CASES = [
  {
    id: 'L1',
    name: '書けるのは事務所・管理者だけ（現場・役割なし・許可リスト外・anon は 42501）。読むのは許可リストの職員',
    async run(h) {
      const office = await add(h, { temp_warn_high: 37.2, ck: 'l1-1' })
      const admin = await add(h, { resident: 2, temp_warn_high: 37.3, ck: 'l1-2' }, { appRole: 'admin' })
      const field = await add(h, { offset: 1, ck: 'l1-3' }, { appRole: 'field' })
      const none = await add(h, { offset: 2, ck: 'l1-4' }, {})
      const outsider = await add(h, { offset: 3, ck: 'l1-5' }, { appRole: 'office', member: false })
      const anon = await add(h, { offset: 4, ck: 'l1-6' }, { role: 'anon' })
      const fieldRead = await h.as({ appRole: 'field' }, (q) => q(`select count(*)::int n from public.resident_vital_limits`))
      return {
        office: out(office),
        admin: out(admin),
        field: out(field),
        none: out(none),
        outsider: out(outsider),
        anon: out(anon),
        fieldRead: Array.isArray(fieldRead) ? fieldRead[0].n : out(fieldRead),
      }
    },
    expect: { office: 'ok', admin: 'ok', field: '42501', none: '42501', outsider: '42501', anon: '42501', fieldRead: 2 },
  },
  {
    id: 'L2',
    name: '遡れない: 足した日より前の valid_from は止まる（事務所でも）。今日・先の日は入る',
    async run(h) {
      const back = await add(h, { offset: -1, temp_warn_high: 37.2, ck: 'l2-1' })
      const today = await add(h, { offset: 0, temp_warn_high: 37.2, ck: 'l2-2' })
      const future = await add(h, { offset: 7, temp_warn_high: 37.8, ck: 'l2-3' })
      return { back: out(back), today: out(today), future: out(future) }
    },
    expect: { back: 'P0001|vital_limits_backdated', today: 'ok', future: 'ok' },
  },
  {
    id: 'L3',
    name: '値・開始日・根拠・利用者は書き換えられない（事務所でも P0001・vital_limits_immutable）',
    async run(h) {
      await add(h, { temp_warn_high: 37.2, ck: 'l3-1' })
      const upd = (sql) => h.as({ appRole: 'office' }, (q) => q(`update public.resident_vital_limits set ${sql} where client_key = 'l3-1' returning id`))
      return {
        value: out(await upd('temp_warn_high = 37.4')),
        nullOut: out(await upd('temp_warn_high = null')),
        validFrom: out(await upd(`valid_from = valid_from + 1`)),
        basis: out(await upd(`basis = '別の根拠'`)),
        resident: out(await upd('resident_id = 2')),
      }
    },
    expect: {
      value: 'P0001|vital_limits_immutable',
      nullOut: 'P0001|vital_limits_immutable',
      validFrom: 'P0001|vital_limits_immutable',
      basis: 'P0001|vital_limits_immutable',
      resident: 'P0001|vital_limits_immutable',
    },
  },
  {
    id: 'L4',
    name: '取り消しは足した日の当日だけ（事務所）。戻す（復活）ことはできない。現場は取り消せない（42501）',
    async run(h) {
      await add(h, { temp_warn_high: 37.2, ck: 'l4-1' })
      const field = await h.as({ appRole: 'field' }, (q) =>
        q(`update public.resident_vital_limits set deleted_at = now(), deleted_by = 2, edited_by = 2 where client_key = 'l4-1' returning id`),
      )
      const cancel = await h.as({ appRole: 'office' }, (q) =>
        q(`update public.resident_vital_limits set deleted_at = now(), deleted_by = 1, edited_by = 1 where client_key = 'l4-1' returning rev`),
      )
      const revive = await h.as({ appRole: 'office' }, (q) =>
        q(`update public.resident_vital_limits set deleted_at = null, edited_by = 1 where client_key = 'l4-1' returning id`),
      )
      // 2日前に足した行（postgres の権限で用意＝トリガは役割なしで止めない）を、今日取り消そうとする。
      // 役割（test.role）はトランザクションの中に残るので、用意の前に空（役割なし）へ戻す
      await h.pg(`select set_config('test.role', '', true)`)
      await h.pg(
        `insert into public.resident_vital_limits (resident_id, valid_from, temp_warn_high, basis, client_key, created_at)
         values (2, ${TODAY} - 2, 37.6, '試験', 'l4-2', now() - interval '2 days')`,
      )
      const late = await h.as({ appRole: 'office' }, (q) =>
        q(`update public.resident_vital_limits set deleted_at = now(), deleted_by = 1, edited_by = 1 where client_key = 'l4-2' returning id`),
      )
      return {
        field: Array.isArray(field) ? `rows:${field.length}` : out(field),
        cancelRev: Array.isArray(cancel) ? cancel[0].rev : out(cancel),
        revive: out(revive),
        late: out(late),
      }
    },
    expect: { field: '42501', cancelRev: 2, revive: 'P0001|vital_limits_immutable', late: 'P0001|vital_limits_cancel_late' },
  },
  {
    id: 'L5',
    name: '壊れた組・範囲外・根拠なしは 23514（check）。全部 null の行（施設の基準に戻す）は根拠があれば入る',
    async run(h) {
      const r = {}
      const tries = {
        orderTemp: { temp_warn_high: 38.5, temp_danger_high: 38.1 },
        orderTempLow: { temp_danger_low: 37.0, temp_warn_high: 36.9 },
        orderSys: { sys_bp_warn_low: 140, sys_bp_danger_high: 130 },
        orderPulse: { pulse_warn_low: 70, pulse_danger_high: 65 },
        rangeTemp: { temp_warn_high: 41.5 },
        rangeDia: { dia_bp_warn_low: 95 },
        basisBlank: { temp_warn_high: 37.2, basis: '   ' },
        basisLong: { temp_warn_high: 37.2, basis: 'あ'.repeat(201) },
        allNull: {},
        single: { pulse_warn_low: 45 },
      }
      let i = 0
      for (const [k, v] of Object.entries(tries)) {
        i += 1
        r[k] = out(await add(h, { ...v, offset: i, ck: `l5-${i}` }))
      }
      return r
    },
    expect: {
      orderTemp: '23514',
      orderTempLow: '23514',
      orderSys: '23514',
      orderPulse: '23514',
      rangeTemp: '23514',
      rangeDia: '23514',
      basisBlank: '23514',
      basisLong: '23514',
      allNull: 'ok',
      single: 'ok',
    },
  },
  {
    id: 'L6',
    name: '1人・1開始日に1件（生きている行だけ）: 2件目は 23505。取り消した後は同じ日に足せる',
    async run(h) {
      await add(h, { temp_warn_high: 37.2, ck: 'l6-1' })
      const dup = await add(h, { temp_warn_high: 37.4, ck: 'l6-2' })
      await h.as({ appRole: 'office' }, (q) => q(`update public.resident_vital_limits set deleted_at = now(), edited_by = 1 where client_key = 'l6-1'`))
      const again = await add(h, { temp_warn_high: 37.4, ck: 'l6-3' })
      return { dup: out(dup), again: out(again) }
    },
    expect: { dup: '23505', again: 'ok' },
  },
  {
    id: 'L7',
    name: '取り消しは変更の記録に残る（record_history・業務日の列 valid_from・変えた職員）',
    async run(h) {
      await h.pg(`insert into public.resident_vital_limits (id, resident_id, valid_from, temp_warn_high, basis, client_key) overriding system value values (901, 1, ${TODAY}, 37.2, '試験', 'l7-1')`)
      await h.as({ appRole: 'office' }, (q) => q(`update public.resident_vital_limits set deleted_at = now(), deleted_by = 2, edited_by = 2 where id = 901`))
      const hist = await h.pg(
        `select (record_day = ${TODAY}) as day_ok, changed_by_staff::text s, rev_before, rev_after from public.record_history where table_name = 'resident_vital_limits' and row_id = 901`,
      )
      return { hist }
    },
    expect: { hist: [{ day_ok: true, s: '2', rev_before: 1, rev_after: 2 }] },
  },
  {
    id: 'L8',
    name: '物理削除はできない（delete のポリシーなし・delete と truncate の権限なし）。ポリシーは4つ・Realtime に載せない・0034 の表は変わらない',
    async run(h) {
      await add(h, { temp_warn_high: 37.2, ck: 'l8-1' })
      const del = await h.as({ appRole: 'office' }, (q) => q(`delete from public.resident_vital_limits where client_key = 'l8-1'`))
      const trunc = await h.as({ appRole: 'admin' }, (q) => q(`truncate public.resident_vital_limits`))
      const left = (await h.pg(`select count(*)::int n from public.resident_vital_limits where client_key = 'l8-1'`))[0].n
      const pol = await h.pg(
        `select policyname, cmd, permissive from pg_policies where schemaname = 'public' and tablename = 'resident_vital_limits' order by policyname`,
      )
      const rt = (await h.pg(`select count(*)::int n from pg_publication_tables where tablename = 'resident_vital_limits'`))[0].n
      const targetsPol = (await h.pg(`select count(*)::int n from pg_policies where schemaname = 'public' and tablename = 'resident_targets'`))[0].n
      return { del: out(del), trunc: out(trunc), left, pol, rt, targetsPol }
    },
    expect: {
      del: '42501',
      trunc: '42501',
      left: 1,
      pol: [
        { policyname: 'insert_office', cmd: 'INSERT', permissive: 'PERMISSIVE' },
        { policyname: 'member_only', cmd: 'ALL', permissive: 'RESTRICTIVE' },
        { policyname: 'read_auth', cmd: 'SELECT', permissive: 'PERMISSIVE' },
        { policyname: 'update_office', cmd: 'UPDATE', permissive: 'PERMISSIVE' },
      ],
      rt: 0,
      targetsPol: 4,
    },
  },
]
