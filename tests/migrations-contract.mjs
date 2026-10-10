// 2026-10-10 の移行 0021〜0030（多端末運用の監査の直し）の契約。素の Postgres で tests/migrations-pg.mjs が流す。
//
// ・MIGRATION_PG_CASES … 1件ずつ「準備（postgres の権限）→ 操作（authenticated／anon・member の有無を切り替える）→ 観測」を
//     行い、expect と突き合わせる。各件は1つのトランザクションの中で動き、最後に必ず rollback する（表に何も残さない）。
//     直す前（0001〜0020 だけの DB）では赤、0021〜0030 を当てた DB では緑になる形。
// ・npm test では DB を使わない。移行の文面の静的検査は tests/migrations-mdfix.test.mjs。
//
// 個人情報は置かない（利用者・職員は合成の 利用者01・職員01 と数値IDだけ。本文は記号だけ）。

/** 準備: 職員3人・利用者2人（合成）。ID は固定（overriding system value） */
export const SEED_SQL = [
  `insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02'), (3, '職員03') on conflict (id) do nothing`,
  `insert into residents (id, source_id, name, active) overriding system value
     values (1, 'CR1', '利用者01', true), (2, 'CR2', '利用者02', true) on conflict (id) do nothing`,
]

const DAY = '2026-11-01'

/**
 * h.pg(text, params?)        … postgres（超ユーザー）で流す。行の配列を返す
 * h.as(opts, fn)             … opts.role（既定 authenticated）・opts.member（既定 true）に切り替えて fn(q) を流す。
 *                              q(text, params?) は行の配列を返す。例外は { error: SQLSTATE, constraint } で返す（中で巻き戻す）
 */
export const MIGRATION_PG_CASES = [
  // ── F39: record_history_capture の search_path（0021） ──
  {
    finding: 'F39',
    name: '一時表 record_history を作ってから更新しても、変更の記録は本物の表に残る',
    async run(h) {
      await h.pg(`insert into vitals (id, resident_id, measured_on, kind, temp) overriding system value values (901, 1, '${DAY}', 'routine', 36.5)`)
      const before = (await h.pg(`select count(*)::int n from public.record_history where table_name = 'vitals' and row_id = 901`))[0].n
      await h.pg(`create temp table record_history (like public.record_history) on commit drop`)
      await h.pg(`update vitals set temp = 36.7 where id = 901`)
      const after = (await h.pg(`select count(*)::int n from public.record_history where table_name = 'vitals' and row_id = 901`))[0].n
      const temp = (await h.pg(`select count(*)::int n from pg_temp.record_history`))[0].n
      return { publicDelta: after - before, tempRows: temp }
    },
    expect: { publicDelta: 1, tempRows: 0 },
  },
  {
    finding: 'F39',
    name: 'record_history_capture は security definer のまま・search_path は public, pg_temp',
    async run(h) {
      const r = (await h.pg(`select prosecdef, proconfig from pg_proc where proname = 'record_history_capture'`))[0]
      return { definer: r.prosecdef, config: r.proconfig }
    },
    expect: { definer: true, config: ['search_path=public, pg_temp'] },
  },

  // ── F40①: app_settings は authenticated から書けない（0022）・F28③: min_client_build の行（0023） ──
  {
    finding: 'F40',
    name: '許可リストの職員でも app_settings を書き換えられない（update）',
    async run(h) {
      const r = await h.as({}, (q) => q(`update public.app_settings set value = 'true' where key = 'native_input_enabled'`))
      const v = (await h.pg(`select value from public.app_settings where key = 'native_input_enabled'`))[0].value
      return { error: r.error ?? null, value: v }
    },
    expect: { error: '42501', value: 'false' },
  },
  {
    finding: 'F40',
    name: '許可リストの職員でも app_settings に行を足せない（insert）',
    async run(h) {
      const r = await h.as({}, (q) => q(`insert into public.app_settings (key, value) values ('f40_new_key', 'x')`))
      const n = (await h.pg(`select count(*)::int n from public.app_settings where key = 'f40_new_key'`))[0].n
      return { error: r.error ?? null, rows: n }
    },
    expect: { error: '42501', rows: 0 },
  },
  {
    finding: 'F40',
    name: '読むことは今までどおりできる（入力解禁の旗）',
    async run(h) {
      const r = await h.as({}, (q) => q(`select value from public.app_settings where key = 'native_input_enabled'`))
      return { rows: Array.isArray(r) ? r.length : r }
    },
    expect: { rows: 1 },
  },
  {
    finding: 'F28',
    name: 'min_client_build の行がある（値は空＝制限なし）・職員の端末から読める',
    async run(h) {
      const r = await h.as({}, (q) => q(`select value from public.app_settings where key = 'min_client_build'`))
      return { rows: Array.isArray(r) ? r.map((x) => x.value) : r }
    },
    expect: { rows: [''] },
  },

  // ── F40②: 出勤者と表示名の変更の記録（0024・0025） ──
  {
    finding: 'F40',
    name: '出勤者を外す・戻す・役割を変えると記録に残る（同じ値の書き直しは残さない）',
    async run(h) {
      await h.pg(`insert into attendance (day, staff_id, role, sort) values ('${DAY}', 3, 'staff', 1)`)
      await h.as({}, async (q) => {
        await q(`update attendance set sort = -1 where day = '${DAY}' and staff_id = 3`)
        await q(`update attendance set sort = 2 where day = '${DAY}' and staff_id = 3`)
        await q(`update attendance set sort = 2 where day = '${DAY}' and staff_id = 3`)
      })
      const rows = await h.pg(
        `select op, row_id, resident_id, record_day::text as day, old_row ->> 'sort' as old_sort, new_row ->> 'sort' as new_sort,
                changed_by_uid is not null as has_uid
           from public.record_history where table_name = 'attendance' order by id`,
      )
      return { rows: rows.map((r) => [r.op, Number(r.row_id), r.resident_id, r.day, r.old_sort, r.new_sort, r.has_uid]) }
    },
    expect: {
      rows: [
        ['delete', 3, null, DAY, '1', '-1', true],
        ['update', 3, null, DAY, '-1', '2', true],
      ],
    },
  },
  {
    finding: 'F40',
    name: '表示名の変更は記録に残る（氏名などは写さない）・マスタ同期の更新（氏名・部屋）は残さない',
    async run(h) {
      await h.as({}, async (q) => {
        await q(`update residents set note_alias = '表示名A' where id = 1`)
        await q(`update residents set name = '利用者01改', room = '101' where id = 1`)
        await q(`update residents set note_alias = '表示名A' where id = 1`)
        await q(`update residents set note_alias = null where id = 1`)
      })
      const rows = await h.pg(
        `select op, row_id, resident_id, record_day, old_row, new_row from public.record_history where table_name = 'residents' order by id`,
      )
      return {
        rows: rows.map((r) => [r.op, Number(r.row_id), Number(r.resident_id), r.record_day, r.old_row, r.new_row]),
      }
    },
    expect: {
      rows: [
        ['update', 1, 1, null, { id: 1, note_alias: null }, { id: 1, note_alias: '表示名A' }],
        ['update', 1, 1, null, { id: 1, note_alias: '表示名A' }, { id: 1, note_alias: null }],
      ],
    },
  },

  // ── F70: 施設長は1日1人（0026） ──
  {
    finding: 'F70',
    name: '同じ日に2人目の施設長を入れると 23505（uq_attendance_manager_day）で止まる',
    async run(h) {
      await h.pg(`insert into attendance (day, staff_id, role, sort) values ('${DAY}', 1, 'manager', 0)`)
      const r = await h.as({}, (q) => q(`insert into attendance (day, staff_id, role, sort) values ('${DAY}', 2, 'manager', 1)`))
      const n = (await h.pg(`select count(*)::int n from attendance where day = '${DAY}' and role = 'manager' and sort >= 0`))[0].n
      return { error: r.error ?? null, constraint: r.constraint ?? null, managers: n }
    },
    expect: { error: '23505', constraint: 'uq_attendance_manager_day', managers: 1 },
  },
  {
    finding: 'F70',
    name: '役割の変更で2人目の施設長にしても止まる（update）',
    async run(h) {
      await h.pg(`insert into attendance (day, staff_id, role, sort) values ('${DAY}', 1, 'manager', 0), ('${DAY}', 2, 'staff', 1)`)
      const r = await h.as({}, (q) => q(`update attendance set role = 'manager' where day = '${DAY}' and staff_id = 2`))
      return { error: r.error ?? null, constraint: r.constraint ?? null }
    },
    expect: { error: '23505', constraint: 'uq_attendance_manager_day' },
  },
  {
    finding: 'F70',
    name: '入れ替えは「前の施設長を外す→新しい施設長を入れる」の順なら通る（外した行は数えない）',
    async run(h) {
      await h.pg(`insert into attendance (day, staff_id, role, sort) values ('${DAY}', 1, 'manager', 0)`)
      const r = await h.as({}, async (q) => {
        await q(`update attendance set sort = -1 where day = '${DAY}' and staff_id = 1`)
        await q(`insert into attendance (day, staff_id, role, sort) values ('${DAY}', 2, 'manager', 0)`)
        return 'ok'
      })
      const rows = await h.pg(`select staff_id, role, sort from attendance where day = '${DAY}' order by staff_id`)
      return { result: r, rows: rows.map((x) => [Number(x.staff_id), x.role, x.sort]) }
    },
    expect: { result: 'ok', rows: [[1, 'manager', -1], [2, 'manager', 0]] },
  },
  {
    finding: 'F70',
    name: '別の日の施設長には関係しない',
    async run(h) {
      await h.pg(`insert into attendance (day, staff_id, role, sort) values ('${DAY}', 1, 'manager', 0)`)
      const r = await h.as({}, (q) => q(`insert into attendance (day, staff_id, role, sort) values ('2026-11-02', 2, 'manager', 0)`))
      return { error: r.error ?? null }
    },
    expect: { error: null },
  },

  // ── F29: 事故の detail はサーバーで重ねる（0028） ──
  {
    finding: 'F29',
    name: '古い版が知らないキーを捨てて丸ごと送っても、新しい版が入れた欄はサーバーに残る',
    async run(h) {
      await h.pg(
        `insert into public.incidents (id, kind, resident_id, occurred_on, occurred_at, types, detail) overriding system value
           values (701, 'accident', 1, '${DAY}', '${DAY}T05:00:00Z', array['fall'], '{"situation":"状況A","response":"対応A","review_on":"2026-11-20"}')`,
      )
      await h.as({}, (q) => q(`update public.incidents set detail = '{"situation":"状況A","response":"対応A＋追記"}' where id = 701`))
      const d = (await h.pg(`select detail from public.incidents where id = 701`))[0].detail
      return { review_on: d.review_on ?? null, response: d.response, subject_name: d.subject_name ?? null }
    },
    expect: { review_on: '2026-11-20', response: '対応A＋追記', subject_name: '利用者01' },
  },
  {
    finding: 'F29',
    name: '変えたキーだけを送れば他の欄は前の値のまま・null を明示すればその欄だけ空になる',
    async run(h) {
      await h.pg(
        `insert into public.incidents (id, kind, resident_id, occurred_on, occurred_at, types, detail) overriding system value
           values (702, 'accident', 1, '${DAY}', '${DAY}T05:00:00Z', array['fall'], '{"situation":"状況A","response":"対応A","fracture_site":"左手"}')`,
      )
      await h.as({}, async (q) => {
        await q(`update public.incidents set detail = '{"response":"対応B"}' where id = 702`)
        await q(`update public.incidents set detail = '{"fracture_site":null}' where id = 702`)
      })
      const d = (await h.pg(`select detail from public.incidents where id = 702`))[0].detail
      return { situation: d.situation, response: d.response, fracture_site: d.fracture_site, hasKey: 'fracture_site' in d }
    },
    expect: { situation: '状況A', response: '対応B', fracture_site: null, hasKey: true },
  },
  {
    finding: 'F29',
    name: '対象者を変えたら、新しい対象者の氏名で写し直す（前の氏名を引き継がない）',
    async run(h) {
      await h.pg(
        `insert into public.incidents (id, kind, resident_id, occurred_on, occurred_at, types, detail) overriding system value
           values (703, 'accident', 1, '${DAY}', '${DAY}T05:00:00Z', array['fall'], '{"situation":"状況A","response":"対応A"}')`,
      )
      await h.as({}, (q) => q(`update public.incidents set resident_id = 2, detail = '{}' where id = 703`))
      const d = (await h.pg(`select detail from public.incidents where id = 703`))[0].detail
      return { subject_name: d.subject_name, situation: d.situation }
    },
    expect: { subject_name: '利用者02', situation: '状況A' },
  },
  {
    finding: 'F29',
    name: '「名簿の氏名に合わせる」の印は重ねた後も効き、行には残らない',
    async run(h) {
      await h.pg(
        `insert into public.incidents (id, kind, resident_id, occurred_on, occurred_at, types, detail) overriding system value
           values (704, 'accident', 1, '${DAY}', '${DAY}T05:00:00Z', array['fall'], '{"situation":"状況A","response":"対応A"}')`,
      )
      await h.pg(`update residents set name = '利用者01新' where id = 1`)
      await h.as({}, (q) => q(`update public.incidents set detail = '{"_resync_subject_name":true}' where id = 704`))
      const d = (await h.pg(`select detail from public.incidents where id = 704`))[0].detail
      return { subject_name: d.subject_name, marker: '_resync_subject_name' in d, response: d.response }
    },
    expect: { subject_name: '利用者01新', marker: false, response: '対応A' },
  },
  {
    finding: 'F29',
    name: '端末の確かめ（incidents_detail_merge_ready）は職員だけが呼べる',
    async run(h) {
      const r = await h.as({}, (q) => q(`select public.incidents_detail_merge_ready() as ok`))
      const a = await h.as({ role: 'anon' }, (q) => q(`select public.incidents_detail_merge_ready() as ok`))
      return { auth: Array.isArray(r) ? r[0].ok : r, anon: a.error ?? 'allowed' }
    },
    expect: { auth: true, anon: '42501' },
  },

  // ── F09・F08: apply_note_edits の改訂（0027）は tests/note-contract.mjs の表を note-contract-pg.mjs で流す ──

  // ── F25: Presence の private チャンネル（0029） ──
  {
    finding: 'F25',
    name: '許可リストの職員は cl_note_presence の居場所を配れて受け取れる',
    async run(h) {
      const r = await h.as({}, async (q) => {
        await q(`select set_config('realtime.topic', 'cl_note_presence', true)`)
        await q(`insert into realtime.messages (topic, extension, payload, private) values ('cl_note_presence', 'presence', '{}', true)`)
        return (await q(`select count(*)::int n from realtime.messages where extension = 'presence'`))[0].n
      })
      return { seen: r }
    },
    expect: { seen: 1 },
  },
  {
    finding: 'F25',
    name: '許可リストに無い（無効な）アカウントは配れない・受け取れない',
    async run(h) {
      await h.pg(`insert into realtime.messages (topic, extension, payload, private) values ('cl_note_presence', 'presence', '{}', true)`)
      const w = await h.as({ member: false }, async (q) => {
        await q(`select set_config('realtime.topic', 'cl_note_presence', true)`)
        return q(`insert into realtime.messages (topic, extension, payload, private) values ('cl_note_presence', 'presence', '{}', true)`)
      })
      const s = await h.as({ member: false }, async (q) => {
        await q(`select set_config('realtime.topic', 'cl_note_presence', true)`)
        return (await q(`select count(*)::int n from realtime.messages`))[0].n
      })
      return { write: w.error ?? 'allowed', seen: s }
    },
    expect: { write: '42501', seen: 0 },
  },
  {
    finding: 'F25',
    name: 'ログインしていない者（anon）は参加できない',
    async run(h) {
      await h.pg(`insert into realtime.messages (topic, extension, payload, private) values ('cl_note_presence', 'presence', '{}', true)`)
      const w = await h.as({ role: 'anon' }, async (q) => {
        await q(`select set_config('realtime.topic', 'cl_note_presence', true)`)
        return q(`insert into realtime.messages (topic, extension, payload, private) values ('cl_note_presence', 'presence', '{}', true)`)
      })
      const s = await h.as({ role: 'anon' }, async (q) => {
        await q(`select set_config('realtime.topic', 'cl_note_presence', true)`)
        return (await q(`select count(*)::int n from realtime.messages`))[0].n
      })
      return { write: w.error ?? 'allowed', seen: s }
    },
    expect: { write: '42501', seen: 0 },
  },
  {
    finding: 'F25',
    name: '別のトピック・broadcast には何も許さない',
    async run(h) {
      const other = await h.as({}, async (q) => {
        await q(`select set_config('realtime.topic', 'other_topic', true)`)
        return q(`insert into realtime.messages (topic, extension, payload, private) values ('other_topic', 'presence', '{}', true)`)
      })
      const bc = await h.as({}, async (q) => {
        await q(`select set_config('realtime.topic', 'cl_note_presence', true)`)
        return q(`insert into realtime.messages (topic, extension, payload, private) values ('cl_note_presence', 'broadcast', '{}', true)`)
      })
      return { other: other.error ?? 'allowed', broadcast: bc.error ?? 'allowed' }
    },
    expect: { other: '42501', broadcast: '42501' },
  },

  // ── F08（依頼）: タイムラインの RPC の申し送りに ended_by（0030） ──
  {
    finding: 'F08',
    name: 'timeline_chunk の notes・pinned に ended_by が入る',
    async run(h) {
      await h.pg(
        `insert into notes (id, note_on, shift, resident_id, body, importance, ongoing, ended_at, ended_by) overriding system value
           values (801, '${DAY}', 'day', 1, '本文O', 'normal', true, '${DAY}T03:00:00Z', 2)`,
      )
      const r = await h.as({}, (q) => q(`select public.timeline_chunk('${DAY}', '${DAY}', null) as t`))
      const t = Array.isArray(r) ? r[0].t : null
      const n = t?.notes?.find((x) => x.id === 801)
      const p = t?.pinned?.find((x) => x.id === 801)
      return { notes: n?.ended_by ?? 'missing', pinned: p?.ended_by ?? 'missing' }
    },
    expect: { notes: 2, pinned: 2 },
  },

  // ── F09 手直し: タイムラインの RPC の申し送りに color（0030）。削除の「見た行」の色を正しく送れる ──
  {
    finding: 'F09',
    name: 'timeline_chunk の notes・pinned に color が入る',
    async run(h) {
      await h.pg(
        `insert into notes (id, note_on, shift, resident_id, body, importance, ongoing, color) overriding system value
           values (802, '${DAY}', 'day', 1, '本文P', 'normal', true, 'pink')`,
      )
      const r = await h.as({}, (q) => q(`select public.timeline_chunk('${DAY}', '${DAY}', null) as t`))
      const t = Array.isArray(r) ? r[0].t : null
      const n = t?.notes?.find((x) => x.id === 802)
      const p = t?.pinned?.find((x) => x.id === 802)
      return { notes: n?.color ?? 'missing', pinned: p?.color ?? 'missing' }
    },
    expect: { notes: 'pink', pinned: 'pink' },
  },
]

/** 観測と期待の突き合わせ（JSON 表記で比べる）。食い違いの一覧を返す（空なら一致） */
export function checkMigrationCase(c, observed) {
  const out = []
  for (const [k, v] of Object.entries(c.expect)) {
    if (JSON.stringify(observed?.[k] ?? null) !== JSON.stringify(v ?? null)) {
      out.push(`${k}: ${JSON.stringify(observed?.[k])} != ${JSON.stringify(v)}`)
    }
  }
  return out
}
