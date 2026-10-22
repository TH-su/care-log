// 入居者・職員の写しと取込・同期の台帳の書き込みの役割＝supabase/migrations/0040_master_write_office_only.sql の契約
// （代表者の決定 2026-10-22）。素の Postgres では tests/master-write-pg.mjs がこの表を流す（tests/pg-run-all.mjs が拾う）。
// npm test では DB を使わない（移行の文面の静的検査と、画面側の「現場では同期しない」は tests/master-write.test.mjs）。
//
// ・MASTER_WRITE_CASES … 1件ずつ「準備（postgres の権限）→ 操作（authenticated／anon・役割 field／office／admin／null）→ 観測」を
//     行い、expect と突き合わせる。各件は1つのトランザクションの中で動き、最後に必ず rollback する（表に何も残さない）。
//     residents: 現場は足せない（42501）・表示名（note_alias）だけの更新はできる・ほかの列が変わる更新は 42501（値はそのまま）。
//     staff・import_days・master_sync_log: 現場は足せない・変えられない（42501）。事務・管理者は書ける。
//     med_slots: 現場も書ける（守る表から外した）。取込（表の所有者の接続・役割なし）は4表とも書ける。読むのは全員。
// ・checkMasterWriteCase … 観測と expect の食い違いの一覧（空なら一致）
//
// 個人情報は置かない（利用者・職員は合成の 利用者01・職員01 と数値IDだけ）。

/** 準備: 職員2人・利用者2人・台帳1行ずつ（合成）。ID は固定（overriding system value） */
export const MASTER_WRITE_SEED_SQL = [
  `insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02') on conflict (id) do nothing`,
  `insert into residents (id, source_id, name, room, active) overriding system value
     values (1, 'MW1', '利用者01', '101', true), (2, 'MW2', '利用者02', '102', true) on conflict (id) do nothing`,
  `insert into import_days (source, day, src_rows) values ('events', '2026-11-01', 3) on conflict do nothing`,
  `insert into master_sync_log (id, source, before_count, after_count) overriding system value values (1, 'residents', 2, 2) on conflict (id) do nothing`,
  // 固定の ID で入れたので、自動の採番を先へ送る（試験の中で足す行が 1・2 とぶつからないように）
  `select setval(pg_get_serial_sequence('residents', 'id'), 100), setval(pg_get_serial_sequence('staff', 'id'), 100),
          setval(pg_get_serial_sequence('master_sync_log', 'id'), 100)`,
]

const INS_RES = `insert into residents (source_id, name) values`
const INS_STAFF = `insert into staff (name) values`
const INS_IMPORT = `insert into import_days (source, day, src_rows) values`
const INS_LOG = `insert into master_sync_log (source, before_count, after_count) values`
const INS_SLOTS = `insert into public.med_slots (resident_id, slots, client_key) values`

/** 利用者1の [氏名, 部屋, 在籍, 表示名] */
async function res1(h) {
  const r = (await h.pg(`select name, room, active, note_alias from residents where id = 1`))[0]
  return [r.name, r.room, r.active, r.note_alias]
}

/** q の結果を「行数」か「エラーの SQLSTATE」にそろえる */
const rowsOr = (r) => (Array.isArray(r) ? r.length : (r?.error ?? null))

/**
 * h.pg(text, params?) … postgres（表の所有者・超ユーザー）で流す。行の配列を返す
 * h.as(opts, fn)      … opts.role（既定 authenticated／'anon'）・opts.appRole（private.my_role() が返す役割。null＝役割なし）・
 *                       opts.member（既定 true）に切り替えて fn(q) を流す。q(text, params?) は行の配列を返す。
 *                       例外は { error: SQLSTATE, constraint, message } で返す（中で巻き戻す）
 */
export const MASTER_WRITE_CASES = [
  // ── residents ──
  {
    group: 'residents',
    name: '現場（field）は入居者を足せない（42501）',
    async run(h) {
      const r = await h.as({ appRole: 'field' }, (q) => q(`${INS_RES} ('MW9', '利用者09')`))
      const n = (await h.pg(`select count(*)::int n from residents`))[0].n
      return { error: r.error ?? null, rows: n }
    },
    expect: { error: '42501', rows: 2 },
  },
  {
    group: 'residents',
    name: '現場（field）は申し送りでの表示名だけを変えられる（付ける・外す。変更の記録も残る）',
    async run(h) {
      const set = await h.as({ appRole: 'field' }, (q) => q(`update residents set note_alias = '表示名A' where id = 1 returning id`))
      const after = await res1(h)
      const clear = await h.as({ appRole: 'field' }, (q) => q(`update residents set note_alias = null where id = 1 returning id`))
      const hist = await h.pg(
        `select new_row ->> 'note_alias' as n from record_history where table_name = 'residents' and row_id = 1 order by id`,
      )
      return { set: rowsOr(set), after, clear: rowsOr(clear), hist: hist.map((x) => x.n) }
    },
    expect: { set: 1, after: ['利用者01', '101', true, '表示名A'], clear: 1, hist: ['表示名A', null] },
  },
  {
    group: 'residents',
    name: '現場（field）は氏名・部屋・在籍・保留の印を変えられない（42501・値はそのまま・分かる文）',
    async run(h) {
      const name = await h.as({ appRole: 'field' }, (q) => q(`update residents set name = '利用者01改' where id = 1`))
      const room = await h.as({ appRole: 'field' }, (q) => q(`update residents set room = '201' where id = 1`))
      const off = await h.as({ appRole: 'field' }, (q) => q(`update residents set active = false where id = 1`))
      const rv = await h.as({ appRole: 'field' }, (q) => q(`update residents set needs_review = true where id = 1`))
      const sync = await h.as({ appRole: 'field' }, (q) => q(`update residents set synced_at = '2000-01-01T00:00:00Z' where id = 1`))
      return {
        errors: [name.error, room.error, off.error, rv.error, sync.error],
        msg: /^resident_master_office_only: /.test(name.message ?? ''),
        row: await res1(h),
      }
    },
    expect: { errors: ['42501', '42501', '42501', '42501', '42501'], msg: true, row: ['利用者01', '101', true, null] },
  },
  {
    group: 'residents',
    name: '現場（field）が表示名とほかの列を一緒に変えても止まる（表示名も変わらない）',
    async run(h) {
      const r = await h.as({ appRole: 'field' }, (q) => q(`update residents set note_alias = '表示名B', room = '201' where id = 1`))
      return { error: r.error ?? null, row: await res1(h) }
    },
    expect: { error: '42501', row: ['利用者01', '101', true, null] },
  },
  {
    group: 'residents',
    name: '事務（office）と管理者（admin）は入居者を足せる・氏名と部屋と在籍を変えられる',
    async run(h) {
      const ins = await h.as({ appRole: 'office' }, (q) => q(`${INS_RES} ('MW3', '利用者03') returning id`))
      const upd = await h.as({ appRole: 'office' }, (q) => q(`update residents set name = '利用者01改', room = '201' where id = 1 returning id`))
      const ins2 = await h.as({ appRole: 'admin' }, (q) => q(`${INS_RES} ('MW4', '利用者04') returning id`))
      const off = await h.as({ appRole: 'admin' }, (q) => q(`update residents set active = false, needs_review = true where id = 2 returning id`))
      const r2 = (await h.pg(`select active, needs_review from residents where id = 2`))[0]
      return { ins: rowsOr(ins), upd: rowsOr(upd), ins2: rowsOr(ins2), off: rowsOr(off), row1: await res1(h), row2: [r2.active, r2.needs_review] }
    },
    expect: { ins: 1, upd: 1, ins2: 1, off: 1, row1: ['利用者01改', '201', true, null], row2: [false, true] },
  },

  // ── staff・import_days・master_sync_log ──
  {
    group: 'staff',
    name: '現場（field）は職員を足せない・変えられない（42501・値はそのまま）',
    async run(h) {
      const ins = await h.as({ appRole: 'field' }, (q) => q(`${INS_STAFF} ('職員09')`))
      const upd = await h.as({ appRole: 'field' }, (q) => q(`update staff set hire_date = '2020-04-01', hire_date_manual = true where id = 1`))
      const off = await h.as({ appRole: 'field' }, (q) => q(`update staff set active = false where id = 1`))
      const r = (await h.pg(`select count(*)::int n, bool_and(active) a, count(hire_date)::int d from staff`))[0]
      return { errors: [ins.error, upd.error, off.error], table: [r.n, r.a, r.d] }
    },
    expect: { errors: ['42501', '42501', '42501'], table: [2, true, 0] },
  },
  {
    group: 'staff',
    name: '事務（office）と管理者（admin）は職員を足せる・入職日と在籍を変えられる',
    async run(h) {
      const ins = await h.as({ appRole: 'office' }, (q) => q(`${INS_STAFF} ('職員03') returning id`))
      const upd = await h.as({ appRole: 'office' }, (q) => q(`update staff set hire_date = '2020-04-01', hire_date_manual = true where id = 1 returning id`))
      const off = await h.as({ appRole: 'admin' }, (q) => q(`update staff set active = false where id = 2 returning id`))
      const r = (await h.pg(`select count(*)::int n, count(hire_date)::int d, count(*) filter (where not active)::int x from staff`))[0]
      return { ins: rowsOr(ins), upd: rowsOr(upd), off: rowsOr(off), table: [r.n, r.d, r.x] }
    },
    expect: { ins: 1, upd: 1, off: 1, table: [3, 1, 1] },
  },
  {
    group: 'ledger',
    name: '現場（field）は取込の台帳（import_days）と同期の台帳（master_sync_log）を書けない（42501）',
    async run(h) {
      const i1 = await h.as({ appRole: 'field' }, (q) => q(`${INS_IMPORT} ('events', '2026-11-02', 1)`))
      const u1 = await h.as({ appRole: 'field' }, (q) => q(`update import_days set src_rows = 9 where source = 'events'`))
      const i2 = await h.as({ appRole: 'field' }, (q) => q(`${INS_LOG} ('staff', 2, 2)`))
      const u2 = await h.as({ appRole: 'field' }, (q) => q(`update master_sync_log set after_count = 9 where id = 1`))
      const a = (await h.pg(`select count(*)::int n, max(src_rows)::int m from import_days`))[0]
      const b = (await h.pg(`select count(*)::int n, max(after_count)::int m from master_sync_log`))[0]
      return { errors: [i1.error, u1.error, i2.error, u2.error], tables: [a.n, a.m, b.n, b.m] }
    },
    expect: { errors: ['42501', '42501', '42501', '42501'], tables: [1, 3, 1, 2] },
  },
  {
    group: 'ledger',
    name: '事務（office）と管理者（admin）は2つの台帳を書ける',
    async run(h) {
      const i1 = await h.as({ appRole: 'office' }, (q) => q(`${INS_IMPORT} ('events', '2026-11-02', 1) returning day`))
      const u1 = await h.as({ appRole: 'admin' }, (q) => q(`update import_days set src_rows = 4 where day = '2026-11-01' returning day`))
      const i2 = await h.as({ appRole: 'office' }, (q) => q(`${INS_LOG} ('staff', 2, 3) returning id`))
      const u2 = await h.as({ appRole: 'admin' }, (q) => q(`update master_sync_log set added = 1 where id = 1 returning id`))
      return { rows: [rowsOr(i1), rowsOr(u1), rowsOr(i2), rowsOr(u2)] }
    },
    expect: { rows: [1, 1, 1, 1] },
  },

  // ── 守る表から外したもの・役割の外の経路・読む ──
  {
    group: 'med_slots',
    name: '服薬の時間帯（med_slots）は現場（field）も足せる・変えられる（守る表から外した）',
    async run(h) {
      const ins = await h.as({ appRole: 'field' }, (q) => q(`${INS_SLOTS} (1, array['morning'], 'mw-k1') returning id`))
      const upd = await h.as({ appRole: 'field' }, (q) =>
        q(`update public.med_slots set slots = array['morning', 'bedtime'], edited_by = 1 where resident_id = 1 returning rev`),
      )
      return { ins: rowsOr(ins), upd: Array.isArray(upd) ? upd.map((x) => x.rev) : upd }
    },
    expect: { ins: 1, upd: [2] },
  },
  {
    group: 'bypass',
    name: '取込（表の所有者の接続・役割なし）は4表とも書ける',
    async run(h) {
      await h.pg(`${INS_RES} ('MW5', '利用者05')`)
      await h.pg(`update residents set name = '利用者01改', room = '201', active = false where id = 1`)
      await h.pg(`${INS_STAFF} ('職員05')`)
      await h.pg(`update staff set active = false where id = 1`)
      await h.pg(`${INS_IMPORT} ('events', '2026-11-03', 2)`)
      await h.pg(`update import_days set src_rows = 5 where day = '2026-11-01'`)
      await h.pg(`${INS_LOG} ('residents', 2, 3)`)
      const n = (await h.pg(
        `select (select count(*) from residents)::int r, (select count(*) from staff)::int s,
                (select count(*) from import_days)::int i, (select count(*) from master_sync_log)::int l`,
      ))[0]
      return { counts: [n.r, n.s, n.i, n.l], row1: await res1(h) }
    },
    expect: { counts: [3, 3, 2, 2], row1: ['利用者01改', '201', false, null] },
  },
  {
    group: 'bypass',
    name: 'private.my_role の無い DB では入居者の更新を止めない（0033 と同じ・役割が分からない）',
    async run(h) {
      await h.pg(`alter function private.my_role() rename to my_role_hidden`)
      await h.pg(`update residents set room = '301' where id = 1`)
      return { row: await res1(h) }
    },
    expect: { row: ['利用者01', '301', true, null] },
  },
  {
    group: 'bypass',
    name: 'private.has_role の無い DB では事務（office）でも職員と台帳に書けない（書けない側に倒す・0034 と同じ）',
    async run(h) {
      await h.pg(`alter function private.has_role(text[]) rename to has_role_hidden`)
      const r = await h.as({ appRole: 'office' }, (q) => q(`${INS_STAFF} ('職員06')`))
      const w = await h.as({ appRole: 'office' }, (q) => q(`select private.office_writable() as w`))
      return { error: r.error ?? null, writable: Array.isArray(w) ? w[0].w : w }
    },
    expect: { error: '42501', writable: false },
  },
  {
    group: 'read',
    name: '読むのは全員（現場・事務・管理者が5表を読める）',
    async run(h) {
      await h.pg(`${INS_SLOTS} (1, array['noon'], 'mw-k2')`)
      const sql = `select (select count(*) from residents)::int r, (select count(*) from staff)::int s,
                          (select count(*) from import_days)::int i, (select count(*) from master_sync_log)::int l,
                          (select count(*) from public.med_slots)::int m`
      const one = async (appRole) => {
        const x = await h.as({ appRole }, (q) => q(sql))
        return Array.isArray(x) ? [x[0].r, x[0].s, x[0].i, x[0].l, x[0].m] : x
      }
      return { field: await one('field'), office: await one('office'), admin: await one('admin') }
    },
    expect: { field: [2, 2, 1, 1, 1], office: [2, 2, 1, 1, 1], admin: [2, 2, 1, 1, 1] },
  },
  {
    group: 'read',
    name: '許可リストに無いログイン（member でない）は役割が office でも読めない・書けない',
    async run(h) {
      const sel = await h.as({ appRole: 'office', member: false }, (q) => q(`select count(*)::int n from residents`))
      const ins = await h.as({ appRole: 'office', member: false }, (q) => q(`${INS_STAFF} ('職員07')`))
      return { seen: Array.isArray(sel) ? sel[0].n : sel, ins: ins.error ?? null }
    },
    expect: { seen: 0, ins: '42501' },
  },

  // ── 形 ──
  {
    group: 'shape',
    name: 'ポリシー: 4表とも insert_auth が無く insert_office がある・update は residents だけ update_auth のまま',
    async run(h) {
      const r = await h.pg(
        `select tablename t, string_agg(policyname, ',' order by policyname) p from pg_policies
          where schemaname = 'public' and tablename in ('residents', 'staff', 'import_days', 'master_sync_log', 'med_slots')
          group by tablename order by tablename`,
      )
      return { policies: r.map((x) => [x.t, x.p]) }
    },
    expect: {
      policies: [
        ['import_days', 'insert_office,member_only,read_auth,update_office'],
        ['master_sync_log', 'insert_office,member_only,read_auth,update_office'],
        ['med_slots', 'insert_auth,member_only,read_auth,update_auth'],
        ['residents', 'insert_office,member_only,read_auth,update_auth'],
        ['staff', 'insert_office,member_only,read_auth,update_office'],
      ],
    },
  },
  {
    group: 'shape',
    name: 'トリガの本体は security definer・search_path 固定・API から呼べない。書く許可の関数は invoker',
    async run(h) {
      const g = (await h.pg(`select prosecdef d, proconfig c from pg_proc where proname = 'residents_master_guard'`))[0]
      const w = (await h.pg(`select prosecdef d from pg_proc where proname = 'office_writable'`))[0]
      const ex = (await h.pg(`select has_function_privilege('authenticated', 'public.residents_master_guard()', 'execute') e`))[0]
      return { guard: [g.d, g.c], writableDefiner: w.d, authExec: ex.e }
    },
    expect: { guard: [true, ['search_path=public, pg_temp']], writableDefiner: false, authExec: false },
  },
]

export function checkMasterWriteCase(c, observed) {
  const out = []
  for (const [k, v] of Object.entries(c.expect)) {
    if (JSON.stringify(observed?.[k] ?? null) !== JSON.stringify(v ?? null)) {
      out.push(`${k}: ${JSON.stringify(observed?.[k] ?? null)} != ${JSON.stringify(v)}`)
    }
  }
  return out
}
