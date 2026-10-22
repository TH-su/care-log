// 移行 0044（デイ 段階2b: 活動・レク daycare_activity_log・旗 input_enabled_daycare_activity）の契約。
// 素の Postgres で tests/daycare-activity-pg.mjs が流す（tests/pg-run-all.mjs から）。
// 段階2の計画 v1（【AI取締役】の 20261022_段階2_計画_v1.md）の 3.1 と 8章 V8 の DB の層を確かめる。
//
// ・ACTIVITY_CASES … 1件ずつ「準備（postgres の権限）→ 操作（authenticated／anon・member の有無を切り替える）→ 観測」を行い、
//     expect と突き合わせる。各件は1つのトランザクションの中で動き、最後に必ず rollback する（表に何も残さない）。
// ・npm test では DB を使わない。移行の文面の静的検査と端末側の試験は tests/daycare-activity.test.mjs。
//
// 個人情報は置かない（利用者は架空の「見本」姓・職員は 職員01 と数値IDだけ）。

export { checkDaycareCase as checkActivityCase } from './daycare-contract.mjs'

/** 準備: 職員2人・利用者2人（架空）。ID は固定（overriding system value） */
export const ACTIVITY_SEED_SQL = [
  `insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02') on conflict (id) do nothing`,
  `insert into residents (id, source_id, name, active) overriding system value values
     (1, 'M001', '見本 一郎', true),
     (2, 'M002', '見本 花子', true)
   on conflict (id) do nothing`,
]

/** authenticated で1行足す（id を返す）。失敗は { error: SQLSTATE } */
const add = (h, v, opts = {}) =>
  h.as(opts, (q) =>
    q(
      `insert into public.daycare_activity_log (resident_id, day, label, participation, note, recorded_by, client_key)
       values ($1, $2::date, $3, coalesce($4, 'full'), $5, 1, $6) returning id, rev, participation`,
      [v.resident ?? 1, v.day ?? '2026-10-21', v.label, v.participation ?? null, v.note ?? null, v.ck ?? null],
    ),
  )

export const ACTIVITY_CASES = [
  {
    id: 'B1',
    name: '旗 input_enabled_daycare_activity が false で入る・職員は読めるが書けない（0022）・デイの旗は別の行のまま',
    async run(h) {
      const v = (await h.pg(`select value from public.app_settings where key = 'input_enabled_daycare_activity'`))[0]?.value ?? null
      const day = (await h.pg(`select value from public.app_settings where key = 'input_enabled_daycare'`))[0]?.value ?? null
      const r = await h.as({}, (q) => q(`update public.app_settings set value = 'true' where key = 'input_enabled_daycare_activity'`))
      const read = await h.as({}, (q) => q(`select value from public.app_settings where key = 'input_enabled_daycare_activity'`))
      return { value: v, daycareFlag: day, writeError: r.error ?? null, readRows: Array.isArray(read) ? read.length : read }
    },
    expect: { value: 'false', daycareFlag: 'false', writeError: '42501', readRows: 1 },
  },
  {
    id: 'B2',
    name: '許可リストの職員は足せる・読める（既定は参加・rev 1）。許可リスト外と anon は読めず書けない',
    async run(h) {
      const ok = await add(h, { label: '体操', ck: 'b2-1' })
      const read = await h.as({}, (q) => q(`select label, participation from public.daycare_activity_log`))
      const outsider = await add(h, { label: '歌', ck: 'b2-2' }, { member: false })
      const outsiderRead = await h.as({ member: false }, (q) => q(`select id from public.daycare_activity_log`))
      const anon = await add(h, { label: '歌', ck: 'b2-3' }, { role: 'anon' })
      const anonRead = await h.as({ role: 'anon' }, (q) => q(`select id from public.daycare_activity_log`))
      return {
        ok: Array.isArray(ok) ? { rev: ok[0].rev, participation: ok[0].participation } : ok,
        read,
        outsider: outsider.error ?? 'wrote',
        outsiderRows: Array.isArray(outsiderRead) ? outsiderRead.length : outsiderRead.error,
        anon: anon.error ?? 'wrote',
        anonRead: Array.isArray(anonRead) ? anonRead.length : anonRead.error,
      }
    },
    expect: {
      ok: { rev: 1, participation: 'full' },
      read: [{ label: '体操', participation: 'full' }],
      outsider: '42501',
      outsiderRows: 0,
      anon: '42501',
      anonRead: '42501',
    },
  },
  {
    id: 'B3',
    name: '1人1日1項目1行（部分 unique）: 同じ方・同じ日・同じ項目の2行目は 23505。別の日・別の方・別の項目は入る。取り消した後は入れ直せる',
    async run(h) {
      await add(h, { label: '体操', ck: 'b3-1' })
      const dup = await add(h, { label: '体操', ck: 'b3-2', participation: 'observed' })
      const otherDay = await add(h, { label: '体操', day: '2026-10-20', ck: 'b3-3' })
      const otherRes = await add(h, { label: '体操', resident: 2, ck: 'b3-4' })
      const otherLabel = await add(h, { label: '脳トレ', ck: 'b3-5' })
      const del = await h.as({}, (q) =>
        q(`update public.daycare_activity_log set deleted_at = now(), deleted_by = 1, edited_by = 1 where client_key = 'b3-1' returning rev`),
      )
      const again = await add(h, { label: '体操', ck: 'b3-6', participation: 'partial' })
      return {
        dup: dup.error ?? 'wrote',
        otherDay: Array.isArray(otherDay) ? 'ok' : otherDay.error,
        otherRes: Array.isArray(otherRes) ? 'ok' : otherRes.error,
        otherLabel: Array.isArray(otherLabel) ? 'ok' : otherLabel.error,
        delRev: Array.isArray(del) ? del[0].rev : del.error,
        again: Array.isArray(again) ? again[0].participation : again.error,
      }
    },
    expect: { dup: '23505', otherDay: 'ok', otherRes: 'ok', otherLabel: 'ok', delRev: 2, again: 'partial' },
  },
  {
    id: 'B4',
    name: '冪等キー client_key は全体で一意（取り消した行も押さえたまま）',
    async run(h) {
      await add(h, { label: '体操', ck: 'b4-1' })
      await h.as({}, (q) => q(`update public.daycare_activity_log set deleted_at = now(), edited_by = 1 where client_key = 'b4-1'`))
      const reuse = await add(h, { label: '歌', ck: 'b4-1' })
      return { reuse: reuse.error ?? 'wrote' }
    },
    expect: { reuse: '23505' },
  },
  {
    id: 'B5',
    name: '項目の決まり: 前後の空白・空・41字は 23514／40字ちょうど・中の空白は入る。度合いは4つだけ。備考は200字まで',
    async run(h) {
      const out = {}
      const tries = {
        leading: { label: ' 体操' },
        trailing: { label: '体操 ' },
        empty: { label: '' },
        long41: { label: 'あ'.repeat(41) },
        just40: { label: 'い'.repeat(40) },
        inner: { label: '手先の 体操' },
        badPart: { label: '園芸', participation: 'yes' },
        observed: { label: '散歩', participation: 'observed' },
        declined: { label: '休息', participation: 'declined' },
        note201: { label: '創作', note: 'x'.repeat(201) },
        note200: { label: '歌', note: 'x'.repeat(200) },
      }
      let i = 0
      for (const [k, v] of Object.entries(tries)) {
        i += 1
        const r = await add(h, { ...v, ck: `b5-${i}` })
        out[k] = Array.isArray(r) ? 'ok' : r.error
      }
      return out
    },
    expect: {
      leading: '23514',
      trailing: '23514',
      empty: '23514',
      long41: '23514',
      just40: 'ok',
      inner: 'ok',
      badPart: '23514',
      observed: 'ok',
      declined: 'ok',
      note201: '23514',
      note200: 'ok',
    },
  },
  {
    id: 'B6',
    name: '物理削除はできない（delete のポリシーなし・delete と truncate の権限なし）。行は残る',
    async run(h) {
      await add(h, { label: '体操', ck: 'b6-1' })
      const del = await h.as({}, (q) => q(`delete from public.daycare_activity_log where client_key = 'b6-1'`))
      const trunc = await h.as({}, (q) => q(`truncate public.daycare_activity_log`))
      const left = (await h.pg(`select count(*)::int n from public.daycare_activity_log where client_key = 'b6-1'`))[0].n
      return { del: del.error ?? 'deleted', trunc: trunc.error ?? 'truncated', left }
    },
    expect: { del: '42501', trunc: '42501', left: 1 },
  },
  {
    id: 'B7',
    name: '更新は rev と updated_at を進め、変更の記録に残る（record_history・業務日の列 day・変えた職員）',
    async run(h) {
      await h.pg(
        `insert into public.daycare_activity_log (id, resident_id, day, label, client_key) overriding system value values (801, 1, '2026-10-21', '体操', 'b7-1')`,
      )
      const before = (await h.pg(`select updated_at from public.daycare_activity_log where id = 801`))[0].updated_at
      await h.pg(`select pg_sleep(0.01)`)
      const upd = await h.as({}, (q) =>
        q(`update public.daycare_activity_log set participation = 'observed', edited_by = 2 where id = 801 and rev = 1 returning rev, updated_at > $1 as moved`, [before]),
      )
      const stale = await h.as({}, (q) => q(`update public.daycare_activity_log set participation = 'partial', edited_by = 1 where id = 801 and rev = 1 returning id`))
      const hist = await h.pg(
        `select record_day::text d, changed_by_staff::text s, op, rev_before, rev_after from public.record_history where table_name = 'daycare_activity_log' and row_id = 801`,
      )
      return { upd: Array.isArray(upd) ? upd[0] : upd, staleRows: Array.isArray(stale) ? stale.length : stale.error, hist }
    },
    expect: {
      upd: { rev: 2, moved: true },
      staleRows: 0,
      hist: [{ d: '2026-10-21', s: '2', op: 'update', rev_before: 1, rev_after: 2 }],
    },
  },
  {
    id: 'B8',
    name: 'RLS とポリシーの形（read・insert・update・restrictive member_only の4つ・delete なし）・Realtime に載る',
    async run(h) {
      const pol = await h.pg(
        `select policyname, cmd, permissive from pg_policies where schemaname = 'public' and tablename = 'daycare_activity_log' order by policyname`,
      )
      const rt = (await h.pg(
        `select count(*)::int n from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'daycare_activity_log'`,
      ))[0].n
      const pubs = (await h.pg(`select count(*)::int n from pg_publication where pubname = 'supabase_realtime'`))[0].n
      return { pol, realtime: pubs === 0 ? 'no-publication' : rt }
    },
    expect: {
      pol: [
        { policyname: 'insert_auth', cmd: 'INSERT', permissive: 'PERMISSIVE' },
        { policyname: 'member_only', cmd: 'ALL', permissive: 'RESTRICTIVE' },
        { policyname: 'read_auth', cmd: 'SELECT', permissive: 'PERMISSIVE' },
        { policyname: 'update_auth', cmd: 'UPDATE', permissive: 'PERMISSIVE' },
      ],
      realtime: 1,
    },
  },
  {
    id: 'B9',
    name: '段階1の表と守りは変わらない（daycare_attendance のポリシー4つ・0042／0043 のトリガ1つ）',
    async run(h) {
      const pol = (await h.pg(`select count(*)::int n from pg_policies where schemaname = 'public' and tablename = 'daycare_attendance'`))[0].n
      const trg = (await h.pg(
        `select count(*)::int n from pg_trigger where tgname = 'trg_daycare_attendance_past_guard' and not tgisinternal`,
      ))[0].n
      return { pol, trg }
    },
    expect: { pol: 4, trg: 1 },
  },
]
