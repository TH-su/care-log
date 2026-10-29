// 今日の要注意の7日を、タイムラインの10日（記録者つき）の結果から切り出す（src/pages/alertsModel.ts の sliceTimelineChunk・
// 2026-10-29 本人指示）と、本物の timeline_chunk を7日・記録者なしで呼んだ結果が一字一句同じになることを、素の Postgres で確かめる実行器。
// npm test には含めない（DB が要る）。使い捨てのクラスタでだけ動かす（本番に向けない）。
//
//   CARELOG_PG_URL=postgres://postgres@127.0.0.1:<port>/<db> node tests/timeline-slice-pg.mjs
//
// 前提（vital-limits-pg.mjs と同じ）: tests/pg-run-all.mjs が用意する DB（Supabase の真似と移行 0001〜最新を当てたもの）。
// 境界の行を置く: 7日の外で10日の中の日・終わった日（日本時間）が7日の始まりの前後の継続・60日の遡りの境目の継続と外出・
//   帰着未定の外出・記録者の既読（10日は my_read が true・7日は false）。
// 1回のトランザクションの中で動き、最後に必ず rollback する（表に何も残さない）。
// 個人情報は置かない（利用者は架空の「見本」姓・職員は合成の名前と数値IDのみ）。

import pg from 'pg'
import { sliceTimelineChunk } from '../src/pages/alertsModel.ts'

const url = process.env.CARELOG_PG_URL
if (!url || !/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('CARELOG_PG_URL に使い捨てのローカル DB（127.0.0.1）を指定してください。')
  process.exit(2)
}

const client = new pg.Client({ connectionString: url })
await client.connect()

const UID = '00000000-0000-0000-0000-000000000001'
const DAY = '2026-10-29' // 今日（要注意の7日は 10-23〜10-29・タイムラインの10日は 10-20〜10-29）
const FROM7 = '2026-10-23'
const FROM10 = '2026-10-20'

const SEED = [
  `insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02') on conflict (id) do nothing`,
  `insert into residents (id, source_id, name, active) overriding system value values
     (1, 'M001', '見本 一郎', true), (2, 'M002', '見本 花子', true) on conflict (id) do nothing`,
  // 申し送り（その日の分）: 10日の外・10日だけ・7日の始まり・今日・先の日
  `insert into notes (id, note_on, shift, resident_id, body, importance) overriding system value values
     (9001, '2026-10-19', 'day', 1, '本文A', 'critical'),
     (9002, '2026-10-20', 'day', 1, '本文B', 'critical'),
     (9003, '2026-10-22', 'night', 2, '本文C', 'normal'),
     (9004, '2026-10-23', 'day', 1, '本文D', 'critical'),
     (9005, '2026-10-29', 'day', 2, '本文E', 'important'),
     (9006, '2026-10-29', 'night', 1, '本文F', 'critical'),
     (9007, '2026-10-30', 'day', 1, '本文G', 'critical')`,
  // 継続: 終わっていない（遠い過去から）・10日の中で終わった・日本時間の 10-23 0:30 に終わった（UTC では 10-22）・
  //   日本時間の 10-22 23:30 に終わった・遡りの境目（7日の始まり−60日＝08-24 と、その前日）・先の日
  `insert into notes (id, note_on, shift, resident_id, body, importance, ongoing, ended_at) overriding system value values
     (9101, '2026-08-01', 'day', 1, '継続A', 'critical', true, null),
     (9102, '2026-10-01', 'day', 1, '継続B', 'critical', true, '2026-10-21T03:00:00Z'),
     (9103, '2026-10-01', 'day', 2, '継続C', 'important', true, '2026-10-22T15:30:00Z'),
     (9104, '2026-10-01', 'day', 2, '継続D', 'normal', true, '2026-10-22T14:30:00Z'),
     (9105, '2026-08-24', 'day', 1, '継続E', 'critical', true, '2026-10-25T03:00:00Z'),
     (9106, '2026-08-23', 'day', 1, '継続F', 'critical', true, '2026-10-25T03:00:00Z'),
     (9107, '2026-10-30', 'day', 1, '継続G', 'critical', true, null)`,
  // 既読（記録者1が読んだもの・ほかの職員が読んだもの）
  `insert into note_reads (note_id, staff_id) values (9004, 1), (9005, 1), (9005, 2), (9101, 1), (9003, 2)`,
  `insert into vitals (resident_id, measured_on, kind, measured_at, temp) values
     (1, '2026-10-21', 'routine', '09:00', 36.5), (1, '2026-10-23', 'routine', '09:00', 37.8), (2, '2026-10-29', 'observation', '14:00', 38.1)`,
  `insert into meals (resident_id, meal_on, meal_slot, main_amount, side_amount) values
     (1, '2026-10-21', 'breakfast', 3, 3), (1, '2026-10-22', 'lunch', 2, 2), (1, '2026-10-23', 'breakfast', 4, 4), (2, '2026-10-29', 'dinner', 10, 10)`,
  `insert into fluid_intake (resident_id, taken_on, taken_at, amount_ml) values
     (1, '2026-10-22', '10:00', 200), (1, '2026-10-23', '10:00', 150), (2, '2026-10-29', '15:00', 300)`,
  // 外出: 10日だけ（帰着が7日の前）・帰着未定・遡りの境目（08-24 は7日に入る・08-22 は10日だけ）・7日の中
  `insert into outings (resident_id, kind, start_on, end_on) values
     (1, 'outing', '2026-10-21', '2026-10-22'), (1, 'overnight', '2026-10-21', null), (2, 'overnight', '2026-08-24', '2026-10-23'),
     (2, 'overnight', '2026-08-22', null), (1, 'outing', '2026-10-25', '2026-10-26')`,
  `insert into import_days (source, day) values ('events', '2026-10-21'), ('events', '2026-10-23'), ('measures', '2026-10-29')`,
]

/** 端末の形（db.fetchTimelineChunk の欄の名前）にそろえる。行の中身は正規化せずにそのまま比べる（並び・値の差も見える） */
const asChunk = (raw, from, to) => ({
  from,
  to,
  notes: raw.notes,
  vitals: raw.vitals,
  meals: raw.meals,
  fluids: raw.fluids,
  outings: raw.outings,
  importDays: raw.import_days,
  pinned: raw.pinned,
})

const call = async (from, to, staff) => {
  await client.query('savepoint as_user')
  await client.query(`set local role authenticated`)
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
  await client.query(`select set_config('test.member', 'true', true)`)
  await client.query(`select set_config('test.role', 'field', true)`)
  const r = await client.query(`select public.timeline_chunk($1::date, $2::date, $3::bigint) as t`, [from, to, staff])
  await client.query('reset role')
  await client.query('release savepoint as_user')
  return r.rows[0].t
}

let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`ok ${name}`)
  else {
    failed += 1
    console.log(`NG ${name}${detail ? `\n   ${detail}` : ''}`)
  }
}

await client.query('begin')
try {
  for (const s of SEED) await client.query(s)
  const ten = asChunk(await call(FROM10, DAY, 1), FROM10, DAY)
  const seven = asChunk(await call(FROM7, DAY, null), FROM7, DAY)
  const cut = sliceTimelineChunk(ten, FROM7, DAY)
  // 試験が境界を踏んでいる（10日と7日で中身が違う）ことを先に確かめる
  check('10日の方が多い（7日の外の申し送り・継続・外出が入っている）', ten.notes.length > seven.notes.length && ten.pinned.length > seven.pinned.length && ten.outings.length > seven.outings.length)
  check('10日は記録者の既読が true の申し送りがある（7日は無い）', ten.notes.some((n) => n.my_read === true) && !seven.notes.some((n) => n.my_read === true))
  for (const k of ['notes', 'vitals', 'meals', 'fluids', 'outings', 'importDays', 'pinned']) {
    const a = JSON.stringify(cut?.[k])
    const b = JSON.stringify(seven[k])
    check(`切り出した ${k} が7日・記録者なしで取った結果と同じ（${seven[k].length}件・並びも）`, a === b, `切り出し ${a}\n   7日     ${b}`)
  }
  check('期間の外（10日に収まらない）を頼むと null', sliceTimelineChunk(ten, '2026-10-19', DAY) === null && sliceTimelineChunk(ten, FROM7, '2026-10-30') === null)
} catch (e) {
  failed += 1
  console.log(`NG 例外 ${e?.code ?? ''} ${e?.message ?? e}`)
} finally {
  await client.query('rollback')
}
await client.end()
console.log(failed === 0 ? '\n要注意の7日の切り出しは timeline_chunk の7日と一致' : `\n${failed} 件が一致しない`)
process.exit(failed === 0 ? 0 : 1)
