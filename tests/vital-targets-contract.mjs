// 個別の目標の表（resident_targets）と平熱の RPC（vital_usual_temps）＝supabase/migrations/0034_resident_targets_usual_temp.sql の契約。
// 素の Postgres では tests/vital-targets-pg.mjs がこの表を流す（tests/pg-run-all.mjs が拾う）。npm test では DB を使わない
// （移行の文面の静的検査と、画面側の判定は tests/vital-alerts.test.mjs）。
//
// ・TARGETS_CASES … 1件ずつ「準備（postgres の権限）→ 操作（authenticated／anon・役割 field／office／admin／null・member の有無）→
//     観測」を行い、expect と突き合わせる。各件は1つのトランザクションの中で動き、最後に必ず rollback する（表に何も残さない）。
//     書く: 現場（field）は書けない・事務（office）と管理者（admin）は書ける・役割の分からないログイン（null）も書けない・
//       has_role の無い DB では誰も書けない・取込（表の所有者の接続）は書ける・anon は読めもしない・物理削除と truncate は不可。
//     値: 水分 100〜5000・SpO2 の下限は2つ組で 50〜100・危険 ≤ 注意・生きている行は1人1件。rev と変更の記録。
//     平熱: 5回で値・4回で null・偶数個は真ん中2つの平均を小数1桁・定時以外／取り消し済み／体温なしは数えない・
//       p_day−29 は入り p_day−30 と翌日は入らない・p_day を省くと日本時間の今日・security invoker・anon は実行できない。
// ・checkTargetsCase … 観測と expect の食い違いの一覧（空なら一致）
//
// 個人情報は置かない（利用者・職員は合成の 利用者01・職員01 と数値IDだけ）。

/** 準備: 職員2人・利用者3人（合成）。ID は固定（overriding system value） */
export const TARGETS_SEED_SQL = [
  `insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02') on conflict (id) do nothing`,
  `insert into residents (id, source_id, name, active) overriding system value
     values (1, 'TR1', '利用者01', true), (2, 'TR2', '利用者02', true), (3, 'TR3', '利用者03', true) on conflict (id) do nothing`,
]

/** 平熱の試験の基準日 */
export const USUAL_DAY = '2026-11-30'

/** 基準日から n 日前の 'YYYY-MM-DD' */
export function dayBefore(day, n) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** 定時の体温を入れる SQL（resident・日付・体温・種類・取り消し）。id は自動 */
function vitalSql(residentId, day, temp, kind = 'routine', deleted = false) {
  const t = temp === null ? 'null' : String(temp)
  return `insert into vitals (resident_id, measured_on, kind, temp, deleted_at) values (${residentId}, '${day}', '${kind}', ${t}, ${deleted ? 'now()' : 'null'})`
}

/** 利用者 r に、基準日から1日ずつさかのぼって temps の定時の体温を入れる */
async function seedTemps(h, r, temps, day = USUAL_DAY) {
  for (const [i, t] of temps.entries()) await h.pg(vitalSql(r, dayBefore(day, i), t))
}

/** 平熱を role で読む（行の配列を [利用者ID, 平熱(文字), 回数] にそろえる） */
async function usual(h, opts, day = USUAL_DAY) {
  const r = await h.as(opts, (q) =>
    q(`select resident_id::int as r, usual_temp::text as u, samples from public.vital_usual_temps($1::date) order by 1`, [day]),
  )
  return Array.isArray(r) ? r.map((x) => [x.r, x.u, x.samples]) : r
}

const INSERT_T = `insert into public.resident_targets (resident_id, fluid_target_ml, spo2_warn_below, spo2_danger_below, client_key)`

/**
 * h.pg(text, params?) … postgres（表の所有者・超ユーザー）で流す。行の配列を返す
 * h.as(opts, fn)      … opts.role（既定 authenticated／'anon'）・opts.appRole（private.my_role() が返す役割。null＝役割なし）・
 *                       opts.member（既定 true）に切り替えて fn(q) を流す。q(text, params?) は行の配列を返す。
 *                       例外は { error: SQLSTATE, constraint } で返す（中で巻き戻す）
 */
export const TARGETS_CASES = [
  // ── 書く: 役割 ──
  {
    group: 'rls',
    name: '現場（field）は個別の目標を足せない（42501）',
    async run(h) {
      const r = await h.as({ appRole: 'field' }, (q) => q(`${INSERT_T} values (1, 1000, null, null, 'k-field')`))
      const n = (await h.pg(`select count(*)::int n from public.resident_targets`))[0].n
      return { error: r.error ?? null, rows: n }
    },
    expect: { error: '42501', rows: 0 },
  },
  {
    group: 'rls',
    name: '現場（field）は事務所が足した目標を変えられない・取り消せない（42501・値はそのまま）',
    async run(h) {
      await h.pg(`${INSERT_T} values (1, 1000, 92, 88, 'k-own')`)
      const upd = await h.as({ appRole: 'field' }, (q) => q(`update public.resident_targets set fluid_target_ml = 1500 where resident_id = 1`))
      const del = await h.as({ appRole: 'field' }, (q) => q(`update public.resident_targets set deleted_at = now() where resident_id = 1`))
      const row = (await h.pg(`select fluid_target_ml, deleted_at is null as live, rev from public.resident_targets where resident_id = 1`))[0]
      return { upd: upd.error ?? null, del: del.error ?? null, row: [row.fluid_target_ml, row.live, row.rev] }
    },
    expect: { upd: '42501', del: '42501', row: [1000, true, 1] },
  },
  {
    group: 'rls',
    name: '現場（field）も読める（見るだけ）',
    async run(h) {
      await h.pg(`${INSERT_T} values (1, 1000, 92, 88, 'k-read')`)
      const r = await h.as({ appRole: 'field' }, (q) =>
        q(`select resident_id::int r, fluid_target_ml f, spo2_warn_below w, spo2_danger_below d from public.resident_targets`),
      )
      return { rows: Array.isArray(r) ? r.map((x) => [x.r, x.f, x.w, x.d]) : r }
    },
    expect: { rows: [[1, 1000, 92, 88]] },
  },
  {
    group: 'rls',
    name: '事務（office）は足せる・変えられる（rev が 1→2・変更の記録に旧値と新値・操作した職員）',
    async run(h) {
      const ins = await h.as({ appRole: 'office' }, (q) => q(`${INSERT_T} values (1, 1000, null, null, 'k-office') returning rev`))
      const upd = await h.as({ appRole: 'office' }, (q) =>
        q(`update public.resident_targets set fluid_target_ml = 800, edited_by = 2 where resident_id = 1 and rev = 1 returning rev, fluid_target_ml`),
      )
      const hist = await h.pg(
        `select op, old_row ->> 'fluid_target_ml' as o, new_row ->> 'fluid_target_ml' as n, changed_by_staff::int as s, changed_by_uid is not null as uid
           from public.record_history where table_name = 'resident_targets' order by id`,
      )
      return {
        ins: Array.isArray(ins) ? ins.map((x) => x.rev) : ins,
        upd: Array.isArray(upd) ? upd.map((x) => [x.rev, x.fluid_target_ml]) : upd,
        hist: hist.map((x) => [x.op, x.o, x.n, x.s, x.uid]),
      }
    },
    expect: { ins: [1], upd: [[2, 800]], hist: [['update', '1000', '800', 2, true]] },
  },
  {
    group: 'rls',
    name: '管理者（admin）は足せる・取り消せる（論理削除は変更の記録に delete で残る）',
    async run(h) {
      const ins = await h.as({ appRole: 'admin' }, (q) => q(`${INSERT_T} values (2, null, 95, 90, 'k-admin') returning id`))
      const del = await h.as({ appRole: 'admin' }, (q) =>
        q(`update public.resident_targets set deleted_at = now(), deleted_by = 1, edited_by = 1 where resident_id = 2 returning rev`),
      )
      const hist = await h.pg(`select op from public.record_history where table_name = 'resident_targets' order by id`)
      return { ins: Array.isArray(ins) ? ins.length : ins, del: Array.isArray(del) ? del.map((x) => x.rev) : del, hist: hist.map((x) => x.op) }
    },
    expect: { ins: 1, del: [2], hist: ['delete'] },
  },
  {
    group: 'rls',
    name: '役割の分からないログイン（my_role が null）は書けない（書けない側に倒す）',
    async run(h) {
      const r = await h.as({ appRole: null }, (q) => q(`${INSERT_T} values (1, 1000, null, null, 'k-null')`))
      return { error: r.error ?? null }
    },
    expect: { error: '42501' },
  },
  {
    group: 'rls',
    name: 'private.has_role の無い DB では事務（office）でも書けない（書けない側に倒す）',
    async run(h) {
      await h.pg(`alter function private.has_role(text[]) rename to has_role_hidden`)
      const r = await h.as({ appRole: 'office' }, (q) => q(`${INSERT_T} values (1, 1000, null, null, 'k-nofn')`))
      const w = await h.as({ appRole: 'office' }, (q) => q(`select private.resident_targets_writable() as w`))
      return { error: r.error ?? null, writable: Array.isArray(w) ? w[0].w : w }
    },
    expect: { error: '42501', writable: false },
  },
  {
    group: 'rls',
    name: '許可リストに無いログイン（member でない）は役割が office でも読めない・書けない',
    async run(h) {
      await h.pg(`${INSERT_T} values (1, 1000, null, null, 'k-nm')`)
      const sel = await h.as({ appRole: 'office', member: false }, (q) => q(`select count(*)::int n from public.resident_targets`))
      const ins = await h.as({ appRole: 'office', member: false }, (q) => q(`${INSERT_T} values (2, 1000, null, null, 'k-nm2')`))
      return { seen: Array.isArray(sel) ? sel[0].n : sel, ins: ins.error ?? null }
    },
    expect: { seen: 0, ins: '42501' },
  },
  {
    group: 'rls',
    name: 'anon（ログインしていない）は読めない（権限なし 42501）',
    async run(h) {
      await h.pg(`${INSERT_T} values (1, 1000, null, null, 'k-anon')`)
      const r = await h.as({ role: 'anon' }, (q) => q(`select count(*) from public.resident_targets`))
      return { error: r.error ?? null }
    },
    expect: { error: '42501' },
  },
  {
    group: 'rls',
    name: '事務・管理者でも物理削除と truncate はできない（42501・行は残る）',
    async run(h) {
      await h.pg(`${INSERT_T} values (1, 1000, null, null, 'k-del')`)
      const del = await h.as({ appRole: 'admin' }, (q) => q(`delete from public.resident_targets where resident_id = 1`))
      const tr = await h.as({ appRole: 'admin' }, (q) => q(`truncate public.resident_targets`))
      const n = (await h.pg(`select count(*)::int n from public.resident_targets`))[0].n
      return { del: del.error ?? null, truncate: tr.error ?? null, rows: n }
    },
    expect: { del: '42501', truncate: '42501', rows: 1 },
  },
  {
    group: 'rls',
    name: '取込（表の所有者の接続・役割なし）は RLS を通らず書ける',
    async run(h) {
      await h.pg(`${INSERT_T} values (3, 1500, null, null, 'k-import')`)
      await h.pg(`update public.resident_targets set fluid_target_ml = 1600 where resident_id = 3`)
      const r = (await h.pg(`select fluid_target_ml f, rev from public.resident_targets where resident_id = 3`))[0]
      return { row: [r.f, r.rev] }
    },
    expect: { row: [1600, 2] },
  },

  // ── 値の範囲・1人1件 ──
  {
    group: 'check',
    name: '水分の目標は 100〜5000（両端は入る・99 と 5001 は 23514）',
    async run(h) {
      const one = async (v, k) => {
        const r = await h.as({ appRole: 'office' }, (q) => q(`${INSERT_T} values (${k}, ${v}, null, null, 'k-f${v}') returning id`))
        await h.pg(`delete from public.resident_targets`)
        return r.error ?? 'ok'
      }
      return { lo: await one(100, 1), hi: await one(5000, 1), under: await one(99, 1), over: await one(5001, 1) }
    },
    expect: { lo: 'ok', hi: 'ok', under: '23514', over: '23514' },
  },
  {
    group: 'check',
    name: 'SpO2 の下限は2つ組・50〜100・危険 ≤ 注意（同じ値は入る）',
    async run(h) {
      const one = async (w, d, tag) => {
        const r = await h.as({ appRole: 'office' }, (q) => q(`${INSERT_T} values (1, null, ${w}, ${d}, 'k-s${tag}') returning id`))
        await h.pg(`delete from public.resident_targets`)
        return r.error ?? 'ok'
      }
      return {
        pair: await one(92, 88, 1),
        same: await one(90, 90, 2),
        warnOnly: await one(92, 'null', 3),
        dangerOnly: await one('null', 88, 4),
        reversed: await one(88, 92, 5),
        low: await one(92, 49, 6),
        high: await one(101, 90, 7),
        edge: await one(100, 50, 8),
      }
    },
    expect: { pair: 'ok', same: 'ok', warnOnly: '23514', dangerOnly: '23514', reversed: '23514', low: '23514', high: '23514', edge: 'ok' },
  },
  {
    group: 'check',
    name: '生きている行は1人1件（2件目は 23505）・取り消した後は新しく足せる・client_key は全体で一意',
    async run(h) {
      await h.as({ appRole: 'office' }, (q) => q(`${INSERT_T} values (1, 1000, null, null, 'k-u1')`))
      const dup = await h.as({ appRole: 'office' }, (q) => q(`${INSERT_T} values (1, 1100, null, null, 'k-u2')`))
      await h.as({ appRole: 'office' }, (q) => q(`update public.resident_targets set deleted_at = now() where client_key = 'k-u1'`))
      const again = await h.as({ appRole: 'office' }, (q) => q(`${INSERT_T} values (1, 1200, null, null, 'k-u3') returning id`))
      const sameKey = await h.as({ appRole: 'office' }, (q) => q(`${INSERT_T} values (2, 1200, null, null, 'k-u1')`))
      return { dup: dup.error ?? 'ok', again: again.error ?? 'ok', sameKey: sameKey.error ?? 'ok' }
    },
    expect: { dup: '23505', again: 'ok', sameKey: '23505' },
  },

  // ── 平熱（A1） ──
  {
    group: 'usual',
    name: '5回で中央値（奇数個は真ん中）・4回は null（回数は返す）',
    async run(h) {
      await seedTemps(h, 1, [36.2, 36.8, 36.4, 37.9, 36.5])
      await seedTemps(h, 2, [36.6, 36.7, 36.8, 36.9])
      return { rows: await usual(h, { appRole: 'field' }) }
    },
    expect: { rows: [[1, '36.5', 5], [2, null, 4]] },
  },
  {
    group: 'usual',
    name: '偶数個は真ん中2つの平均を小数1桁に四捨五入（36.5 と 36.6 → 36.55 → 36.6・浮動小数で 36.5 に化けない）',
    async run(h) {
      await seedTemps(h, 1, [36.1, 36.5, 36.6, 37.0, 36.3, 36.9])
      await seedTemps(h, 2, [36.4, 36.4, 36.5, 36.5, 36.5, 36.4])
      return { rows: await usual(h, { appRole: 'office' }) }
    },
    expect: { rows: [[1, '36.6', 6], [2, '36.5', 6]] },
  },
  {
    group: 'usual',
    name: '定時（routine）だけを数える（再検・発熱者・他症状者・取り消し済み・体温なしは数えない）',
    async run(h) {
      await seedTemps(h, 1, [36.5, 36.5, 36.5, 36.5])
      await h.pg(vitalSql(1, dayBefore(USUAL_DAY, 5), 38.5, 'recheck'))
      await h.pg(vitalSql(1, dayBefore(USUAL_DAY, 6), 38.5, 'observation'))
      await h.pg(vitalSql(1, dayBefore(USUAL_DAY, 7), 38.5, 'symptom'))
      await h.pg(vitalSql(1, dayBefore(USUAL_DAY, 8), 38.5, 'routine', true))
      await h.pg(vitalSql(1, dayBefore(USUAL_DAY, 9), null, 'routine'))
      return { rows: await usual(h, { appRole: 'field' }) }
    },
    expect: { rows: [[1, null, 4]] },
  },
  {
    group: 'usual',
    name: '期間は p_day−29 〜 p_day（30日目は入る・31日目と翌日は入らない）',
    async run(h) {
      await seedTemps(h, 1, [36.0, 36.0, 36.0, 36.0])
      await h.pg(vitalSql(1, dayBefore(USUAL_DAY, 29), 36.0)) // 30日目＝入る（5回目）
      await h.pg(vitalSql(2, dayBefore(USUAL_DAY, 0), 36.0))
      await h.pg(vitalSql(2, dayBefore(USUAL_DAY, 1), 36.0))
      await h.pg(vitalSql(2, dayBefore(USUAL_DAY, 2), 36.0))
      await h.pg(vitalSql(2, dayBefore(USUAL_DAY, 3), 36.0))
      await h.pg(vitalSql(2, dayBefore(USUAL_DAY, 30), 36.0)) // 31日目＝入らない
      await h.pg(vitalSql(2, dayBefore(USUAL_DAY, -1), 36.0)) // 翌日＝入らない
      return { rows: await usual(h, { appRole: 'field' }) }
    },
    expect: { rows: [[1, '36.0', 5], [2, null, 4]] },
  },
  {
    group: 'usual',
    name: 'p_day を省くとサーバーのいまの日本時間の日付で数える',
    async run(h) {
      const today = (await h.pg(`select ((now() at time zone 'Asia/Tokyo')::date)::text as d`))[0].d
      await seedTemps(h, 1, [36.7, 36.7, 36.7, 36.7, 36.7], today)
      const r = await h.as({ appRole: 'field' }, (q) => q(`select resident_id::int r, usual_temp::text u, samples from public.vital_usual_temps()`))
      return { rows: Array.isArray(r) ? r.map((x) => [x.r, x.u, x.samples]) : r }
    },
    expect: { rows: [[1, '36.7', 5]] },
  },
  {
    group: 'usual',
    name: '許可リストに無いログインには0行（security invoker＝vitals の member_only が中でも掛かる）',
    async run(h) {
      await seedTemps(h, 1, [36.5, 36.5, 36.5, 36.5, 36.5])
      return { rows: await usual(h, { appRole: 'office', member: false }) }
    },
    expect: { rows: [] },
  },
  {
    group: 'usual',
    name: 'anon は平熱の関数を実行できない（42501）',
    async run(h) {
      const r = await h.as({ role: 'anon' }, (q) => q(`select * from public.vital_usual_temps('${USUAL_DAY}'::date)`))
      return { error: r.error ?? null }
    },
    expect: { error: '42501' },
  },

  // ── 形 ──
  {
    group: 'shape',
    name: '関数は security invoker・search_path は public, pg_temp・anon は実行できない（平熱・書ける役割の判定とも）',
    async run(h) {
      const rows = await h.pg(
        `select p.proname, p.prosecdef, p.proconfig,
                has_function_privilege('anon', p.oid, 'execute') as anon_exec,
                has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where (n.nspname, p.proname) in (('public', 'vital_usual_temps'), ('private', 'resident_targets_writable'))
          order by p.proname`,
      )
      return { rows: rows.map((r) => [r.proname, r.prosecdef, r.proconfig, r.anon_exec, r.auth_exec]) }
    },
    expect: {
      rows: [
        ['resident_targets_writable', false, ['search_path=public, pg_temp'], false, true],
        ['vital_usual_temps', false, ['search_path=public, pg_temp'], false, true],
      ],
    },
  },
  {
    group: 'shape',
    name: 'ポリシーは read_auth・insert_office・update_office・member_only の4本（DELETE は無い）・anon の表の権限なし',
    async run(h) {
      const pol = await h.pg(
        `select policyname, cmd, permissive from pg_policies where schemaname = 'public' and tablename = 'resident_targets' order by policyname`,
      )
      const priv = (
        await h.pg(
          `select has_table_privilege('anon', 'public.resident_targets', 'select') as anon_sel,
                  has_table_privilege('authenticated', 'public.resident_targets', 'delete') as auth_del,
                  has_table_privilege('authenticated', 'public.resident_targets', 'truncate') as auth_trunc,
                  has_table_privilege('authenticated', 'public.resident_targets', 'update') as auth_upd`,
        )
      )[0]
      return { pol: pol.map((p) => [p.policyname, p.cmd, p.permissive]), priv: [priv.anon_sel, priv.auth_del, priv.auth_trunc, priv.auth_upd] }
    },
    expect: {
      pol: [
        ['insert_office', 'INSERT', 'PERMISSIVE'],
        ['member_only', 'ALL', 'RESTRICTIVE'],
        ['read_auth', 'SELECT', 'PERMISSIVE'],
        ['update_office', 'UPDATE', 'PERMISSIVE'],
      ],
      priv: [false, false, false, true],
    },
  },
]

/** 観測と expect の食い違い（空なら一致） */
export function checkTargetsCase(c, observed) {
  const out = []
  for (const [k, v] of Object.entries(c.expect)) {
    if (JSON.stringify(observed?.[k] ?? null) !== JSON.stringify(v ?? null)) {
      out.push(`${k}: ${JSON.stringify(observed?.[k] ?? null)} != ${JSON.stringify(v)}`)
    }
  }
  return out
}
