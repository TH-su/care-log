// 申し送りの時間によるロック（supabase/migrations/0033_note_lock.sql）と分類の列（0032）の契約。
// 素の Postgres では tests/note-lock-pg.mjs がこの表を流す（tests/pg-run-all.mjs が拾う）。
// npm test では DB を使わず、LOCK_JUDGE_CASES を画面の判定 src/lib/noteLock.ts（猶予なし）と突き合わせる
// （tests/note-lock.test.mjs）＝サーバーと画面の規則の食い違いをここで捕まえる。
//
// ・LOCK_JUDGE_CASES … 判定の計算（private.note_lock_blocked(日, 区分, 16時以降, いま, 猶予)）の表。
//     4区分（日勤・16時以降・デイ・夜勤）＋区分外の 16時以降の印（デイ・夜勤に after16=true）× 境目 ±1分 × 猶予 0／30分、
//     前日・翌日・日本時間の日付またぎ。
// ・LOCK_TRIGGER_CASES … トリガ（notes_lock_guard）の結線の表。役割（field／office／admin／null＝取込などのサーバー接続）×
//     4区分 × 境目（ロックの時刻 −1分・ちょうど・＋29分・＋30分・＋31分）× 追加と変更、ほかに継続の終了の例外・
//     取り消し・分類・区分の付け替え・my_role の無い DB・取込（所有者の接続）・旧クライアントの登録。
//     いまの時刻は private.note_lock_now() をトランザクションの中でだけ差し替えて動かす（h.setNow）。
// ・checkLockCase … 観測と expect の食い違いの一覧（空なら一致）
//
// 個人情報は置かない（利用者・職員は合成の 利用者01・職員01 と数値IDだけ。本文は記号だけ）。

/** 準備: 職員2人・利用者2人（合成）。ID は固定（overriding system value） */
export const LOCK_SEED_SQL = [
  `insert into staff (id, name) overriding system value values (1, '職員01'), (2, '職員02') on conflict (id) do nothing`,
  `insert into residents (id, source_id, name, active) overriding system value
     values (1, 'CR1', '利用者01', true), (2, 'CR2', '利用者02', true) on conflict (id) do nothing`,
]

/** 記録日（試験の基準日） */
export const LOCK_DAY = '2026-11-01'

/** 4区分とロックの時刻（日本時間。LOCK_DAY に対して） */
export const LOCK_SECTIONS = [
  { key: 'day', label: '日勤', shift: 'day', after16: false, lockAt: '2026-11-01T17:00:00+09:00' },
  { key: 'late', label: '16時以降', shift: 'day', after16: true, lockAt: '2026-11-02T00:00:00+09:00' },
  { key: 'daycare', label: 'デイ', shift: 'daycare', after16: false, lockAt: '2026-11-01T17:00:00+09:00' },
  { key: 'night', label: '夜勤', shift: 'night', after16: false, lockAt: '2026-11-02T08:00:00+09:00' },
]

/** ISO の時刻に分を足した ISO（UTC の Z 表記） */
export function addMin(iso, min) {
  return new Date(Date.parse(iso) + min * 60_000).toISOString()
}

// ── 判定の計算の表 ─────────────────────────────────────────────────────────

function judgeCases() {
  const out = []
  for (const s of LOCK_SECTIONS) {
    for (const [off, want] of [[-1, false], [0, true], [1, true]]) {
      out.push({ name: `${s.label}: ロックの時刻 ${off >= 0 ? '+' : ''}${off}分・猶予なし`, day: LOCK_DAY, shift: s.shift, after16: s.after16, now: addMin(s.lockAt, off), grace: 0, expect: want })
    }
    for (const [off, want] of [[29, false], [30, true], [31, true], [-1, false]]) {
      out.push({ name: `${s.label}: ロックの時刻 ${off >= 0 ? '+' : ''}${off}分・猶予30分（サーバー）`, day: LOCK_DAY, shift: s.shift, after16: s.after16, now: addMin(s.lockAt, off), grace: 30, expect: want })
    }
  }
  // 16時以降の印はデイ・夜勤には効かない（デイは 17:00・夜勤は翌8:00 のまま）
  out.push({ name: 'デイに after16=true: 17:00 でロック（16時以降の 24:00 にならない）', day: LOCK_DAY, shift: 'daycare', after16: true, now: '2026-11-01T17:00:00+09:00', grace: 0, expect: true })
  out.push({ name: 'デイに after16=true: 16:59 はまだ書ける', day: LOCK_DAY, shift: 'daycare', after16: true, now: '2026-11-01T16:59:00+09:00', grace: 0, expect: false })
  out.push({ name: '夜勤に after16=true: 翌7:59 はまだ書ける', day: LOCK_DAY, shift: 'night', after16: true, now: '2026-11-02T07:59:00+09:00', grace: 0, expect: false })
  out.push({ name: '夜勤に after16=true: 翌8:00 でロック', day: LOCK_DAY, shift: 'night', after16: true, now: '2026-11-02T08:00:00+09:00', grace: 0, expect: true })
  // 前日・未来の日・日本時間の日付またぎ
  out.push({ name: '前日の日勤: 当日の朝 7:00 はロック中', day: '2026-10-31', shift: 'day', after16: false, now: '2026-11-01T07:00:00+09:00', grace: 0, expect: true })
  out.push({ name: '前日の16時以降: 当日の 0:00 ちょうどでロック', day: '2026-10-31', shift: 'day', after16: true, now: '2026-11-01T00:00:00+09:00', grace: 0, expect: true })
  out.push({ name: '前日の16時以降: 前日の 23:59 はまだ書ける', day: '2026-10-31', shift: 'day', after16: true, now: '2026-10-31T23:59:00+09:00', grace: 0, expect: false })
  out.push({ name: '前日の夜勤: 当日の 7:59 はまだ書ける（夜勤明け）', day: '2026-10-31', shift: 'night', after16: false, now: '2026-11-01T07:59:00+09:00', grace: 0, expect: false })
  out.push({ name: '前日の夜勤: 当日の 8:00 でロック', day: '2026-10-31', shift: 'night', after16: false, now: '2026-11-01T08:00:00+09:00', grace: 0, expect: true })
  out.push({ name: '前々日の夜勤: ロック中', day: '2026-10-30', shift: 'night', after16: false, now: '2026-11-01T07:00:00+09:00', grace: 0, expect: true })
  out.push({ name: '未来の日（翌日の日勤）: ロックしない', day: '2026-11-02', shift: 'day', after16: false, now: '2026-11-01T23:00:00+09:00', grace: 0, expect: false })
  out.push({ name: '未来の日（1週間後の夜勤）: ロックしない', day: '2026-11-08', shift: 'night', after16: false, now: '2026-11-01T23:00:00+09:00', grace: 30, expect: false })
  // UTC では前日でも日本時間では当日（UTC 15:00 = 日本時間 0:00）
  out.push({ name: '日本時間で判定: UTC 2026-11-01T07:59Z（日本時間 16:59）の日勤はまだ書ける', day: LOCK_DAY, shift: 'day', after16: false, now: '2026-11-01T07:59:00Z', grace: 0, expect: false })
  out.push({ name: '日本時間で判定: UTC 2026-11-01T08:00Z（日本時間 17:00）の日勤はロック', day: LOCK_DAY, shift: 'day', after16: false, now: '2026-11-01T08:00:00Z', grace: 0, expect: true })
  // 月末・年末をまたぐ
  out.push({ name: '月末の夜勤（10/31）: 11/1 の 8:00 でロック', day: '2026-10-31', shift: 'night', after16: false, now: '2026-11-01T08:00:00+09:00', grace: 0, expect: true })
  out.push({ name: '大晦日の16時以降: 元日の 0:00 でロック', day: '2026-12-31', shift: 'day', after16: true, now: '2027-01-01T00:00:00+09:00', grace: 0, expect: true })
  out.push({ name: '大晦日の夜勤: 元日の 7:59 はまだ書ける', day: '2026-12-31', shift: 'night', after16: false, now: '2027-01-01T07:59:00+09:00', grace: 0, expect: false })
  return out
}

export const LOCK_JUDGE_CASES = judgeCases()

// ── トリガの結線の表 ───────────────────────────────────────────────────────
//
// h.pg(text, params?)    … postgres（所有者・取込と同じ接続）で流す。行の配列を返す
// h.setNow(iso)          … private.note_lock_now() をこのトランザクションの中だけ iso を返す関数に差し替える
// h.as(appRole, fn)      … authenticated に切り替え、private.my_role() が appRole（null＝役割なし）を返す状態で fn(q) を流す。
//                          q(text, params?) は行の配列を返す。例外は { error: SQLSTATE, message } で返す（中で巻き戻す）
// 観測の形: { error: SQLSTATE か null, locked: message が 'note_locked:' で始まるか, ... }

/** 行を1つ作る（所有者の接続＝トリガは止めない）。id は固定 */
async function seedNote(h, id, s, over = {}) {
  const r = { note_on: LOCK_DAY, shift: s.shift, after16: s.after16, body: '本文O', ongoing: false, ...over }
  await h.pg(
    `insert into notes (id, note_on, shift, after16, resident_id, body, reporter_id, ongoing) overriding system value
     values ($1, $2, $3, $4, 1, $5, 1, $6)`,
    [id, r.note_on, r.shift, r.after16, r.body, r.ongoing],
  )
}

function lockedOf(r) {
  return { error: r?.error ?? null, locked: typeof r?.message === 'string' && r.message.startsWith('note_locked:') }
}

const ROLES = [
  ['field', '現場'],
  ['office', '事務所'],
  [null, '役割なし（取込などのサーバー接続）'],
]
const OFFSETS = [-1, 0, 29, 30, 31]

function triggerCases() {
  const out = []
  for (const [role, roleLabel] of ROLES) {
    for (const s of LOCK_SECTIONS) {
      for (const off of OFFSETS) {
        const blocked = role === 'field' && off >= 30
        const at = `ロックの時刻 ${off >= 0 ? '+' : ''}${off}分`
        out.push({
          group: 'matrix',
          name: `${roleLabel}・${s.label}・${at}: 追加${blocked ? 'は止める' : 'できる'}`,
          async run(h) {
            await h.setNow(addMin(s.lockAt, off))
            const r = await h.as(role, (q) =>
              q(`insert into notes (note_on, shift, after16, resident_id, body) values ($1, $2, $3, 1, '本文N') returning id`, [LOCK_DAY, s.shift, s.after16]),
            )
            const n = (await h.pg(`select count(*)::int n from notes where body = '本文N'`))[0].n
            return { ...lockedOf(r), rows: n }
          },
          expect: blocked ? { error: 'P0001', locked: true, rows: 0 } : { error: null, locked: false, rows: 1 },
        })
        out.push({
          group: 'matrix',
          name: `${roleLabel}・${s.label}・${at}: 本文の変更${blocked ? 'は止める' : 'できる'}`,
          async run(h) {
            await seedNote(h, 701, s)
            await h.setNow(addMin(s.lockAt, off))
            const r = await h.as(role, (q) => q(`update notes set body = '本文A' where id = 701`))
            const body = (await h.pg(`select body from notes where id = 701`))[0].body
            return { ...lockedOf(r), body }
          },
          expect: blocked ? { error: 'P0001', locked: true, body: '本文O' } : { error: null, locked: false, body: '本文A' },
        })
      }
    }
  }

  const day = LOCK_SECTIONS[0]
  const night = LOCK_SECTIONS[3]
  const lockedNow = addMin(day.lockAt, 31)

  // 管理者（admin）も止めない
  out.push({
    group: 'role',
    name: '管理者・日勤・ロック後: 変更できる',
    async run(h) {
      await seedNote(h, 702, day)
      await h.setNow(lockedNow)
      const r = await h.as('admin', (q) => q(`update notes set body = '本文A' where id = 702`))
      return { ...lockedOf(r), body: (await h.pg(`select body from notes where id = 702`))[0].body }
    },
    expect: { error: null, locked: false, body: '本文A' },
  })

  // 継続の終了の例外（直接の更新・RPC の両方）
  out.push({
    group: 'ongoing',
    name: '現場・ロック後: 継続の終了（ended_at・ended_by だけ）は止めない（直接の更新）',
    async run(h) {
      await seedNote(h, 703, night, { ongoing: true })
      await h.setNow(addMin(night.lockAt, 24 * 60))
      const r = await h.as('field', (q) => q(`update notes set ended_at = '2026-11-03T01:00:00Z', ended_by = 2 where id = 703`))
      const row = (await h.pg(`select ended_by, rev from notes where id = 703`))[0]
      return { ...lockedOf(r), endedBy: Number(row.ended_by), rev: row.rev }
    },
    expect: { error: null, locked: false, endedBy: 2, rev: 2 },
  })
  out.push({
    group: 'ongoing',
    name: '現場・ロック後: 継続の終了を apply_note_edits で送っても止めない（edited_by が変わっても）',
    async run(h) {
      await seedNote(h, 704, day, { ongoing: true })
      await h.setNow(addMin(day.lockAt, 3 * 24 * 60))
      const r = await h.as('field', (q) =>
        q(`select public.apply_note_edits(704, $1::jsonb, 2) as r`, [
          JSON.stringify({ ended_at: { value: '2026-11-04T01:00:00Z', base: null }, ended_by: { value: 2, base: null } }),
        ]),
      )
      const row = (await h.pg(`select ended_by, edited_by from notes where id = 704`))[0]
      return { ...lockedOf(r), status: r?.[0]?.r?.status ?? null, endedBy: Number(row.ended_by), editedBy: Number(row.edited_by) }
    },
    expect: { error: null, locked: false, status: 'applied', endedBy: 2, editedBy: 2 },
  })
  out.push({
    group: 'ongoing',
    name: '現場・ロック後: 継続の終了を取り消す（ended_at を空に戻す）のも止めない',
    async run(h) {
      await seedNote(h, 705, day, { ongoing: true })
      await h.pg(`update notes set ended_at = '2026-11-02T01:00:00Z', ended_by = 1 where id = 705`)
      await h.setNow(lockedNow)
      const r = await h.as('field', (q) => q(`update notes set ended_at = null, ended_by = null where id = 705`))
      return { ...lockedOf(r), endedAt: (await h.pg(`select ended_at from notes where id = 705`))[0].ended_at }
    },
    expect: { error: null, locked: false, endedAt: null },
  })
  out.push({
    group: 'ongoing',
    name: '現場・ロック後: 継続の終了と本文を一緒に直す → 止める（本文が変わる）',
    async run(h) {
      await seedNote(h, 706, day, { ongoing: true })
      await h.setNow(lockedNow)
      const r = await h.as('field', (q) => q(`update notes set ended_at = '2026-11-02T01:00:00Z', ended_by = 2, body = '本文A' where id = 706`))
      const row = (await h.pg(`select body, ended_at from notes where id = 706`))[0]
      return { ...lockedOf(r), body: row.body, endedAt: row.ended_at }
    },
    expect: { error: 'P0001', locked: true, body: '本文O', endedAt: null },
  })
  out.push({
    group: 'ongoing',
    name: '現場・ロック後: 継続の印（ongoing）を付ける → 止める（終了ではない）',
    async run(h) {
      await seedNote(h, 707, day)
      await h.setNow(lockedNow)
      const r = await h.as('field', (q) => q(`update notes set ongoing = true where id = 707`))
      return lockedOf(r)
    },
    expect: { error: 'P0001', locked: true },
  })

  // RPC（apply_note_edits）経由の変更・取り消し・分類
  out.push({
    group: 'rpc',
    name: '現場・ロック後: apply_note_edits の本文の変更 → P0001・note_locked（何も書かない）',
    async run(h) {
      await seedNote(h, 708, day)
      await h.setNow(lockedNow)
      const r = await h.as('field', (q) => q(`select public.apply_note_edits(708, $1::jsonb, 1) as r`, [JSON.stringify({ body: { value: '本文A', base: '本文O' } })]))
      const row = (await h.pg(`select body, rev from notes where id = 708`))[0]
      return { ...lockedOf(r), body: row.body, rev: row.rev }
    },
    expect: { error: 'P0001', locked: true, body: '本文O', rev: 1 },
  })
  out.push({
    group: 'rpc',
    name: '現場・ロック後: apply_note_edits の取り消し（deleted_at）→ 止める',
    async run(h) {
      await seedNote(h, 709, day)
      await h.setNow(lockedNow)
      const r = await h.as('field', (q) =>
        q(`select public.apply_note_edits(709, $1::jsonb, 1) as r`, [JSON.stringify({ deleted_at: { value: '2026-11-02T01:00:00Z', base: '本文O' } })]),
      )
      return { ...lockedOf(r), deleted: (await h.pg(`select deleted_at is not null d from notes where id = 709`))[0].d }
    },
    expect: { error: 'P0001', locked: true, deleted: false },
  })
  out.push({
    group: 'rpc',
    name: '現場・ロック後: apply_note_edits の分類（categories）→ 止める',
    async run(h) {
      await seedNote(h, 710, day)
      await h.setNow(lockedNow)
      const r = await h.as('field', (q) =>
        q(`select public.apply_note_edits(710, $1::jsonb, 1) as r`, [JSON.stringify({ categories: { value: ['体調'], base: [] } })]),
      )
      return { ...lockedOf(r), categories: (await h.pg(`select categories from notes where id = 710`))[0].categories }
    },
    expect: { error: 'P0001', locked: true, categories: [] },
  })
  out.push({
    group: 'rpc',
    name: '現場・ロック前（16:59）: apply_note_edits の分類 → 書ける（6値の並び）',
    async run(h) {
      await seedNote(h, 711, day)
      await h.setNow(addMin(day.lockAt, -1))
      const r = await h.as('field', (q) =>
        q(`select public.apply_note_edits(711, $1::jsonb, 1) as r`, [JSON.stringify({ categories: { value: ['家族', '薬'], base: [] } })]),
      )
      return { ...lockedOf(r), status: r?.[0]?.r?.status ?? null, categories: (await h.pg(`select categories from notes where id = 711`))[0].categories }
    },
    expect: { error: null, locked: false, status: 'applied', categories: ['薬', '家族'] },
  })
  out.push({
    group: 'rpc',
    name: '事務所・ロック後: apply_note_edits の取り消し → できる',
    async run(h) {
      await seedNote(h, 712, day)
      await h.setNow(lockedNow)
      const r = await h.as('office', (q) =>
        q(`select public.apply_note_edits(712, $1::jsonb, 1) as r`, [JSON.stringify({ deleted_at: { value: '2026-11-02T01:00:00Z', base: '本文O' } })]),
      )
      return { ...lockedOf(r), status: r?.[0]?.r?.status ?? null }
    },
    expect: { error: null, locked: false, status: 'applied' },
  })

  // 区分・日の付け替え（OLD と NEW の両方の位置で判定）
  out.push({
    group: 'move',
    name: '現場: 開いている欄（翌日）からロック中の欄（当日の日勤・ロック後）へ付け替え → 止める',
    async run(h) {
      await seedNote(h, 713, day, { note_on: '2026-11-02' })
      await h.setNow(lockedNow)
      const r = await h.as('field', (q) => q(`update notes set note_on = $1 where id = 713`, [LOCK_DAY]))
      return lockedOf(r)
    },
    expect: { error: 'P0001', locked: true },
  })
  out.push({
    group: 'move',
    name: '現場: ロック中の欄（日勤・ロック後）から開いている欄（同じ日の夜勤）へ付け替え → 止める',
    async run(h) {
      await seedNote(h, 714, day)
      await h.setNow(lockedNow)
      const r = await h.as('field', (q) => q(`update notes set shift = 'night' where id = 714`))
      return { ...lockedOf(r), shift: (await h.pg(`select shift from notes where id = 714`))[0].shift }
    },
    expect: { error: 'P0001', locked: true, shift: 'day' },
  })
  out.push({
    group: 'move',
    name: '現場: 開いている欄どうし（日勤 16:00 → 夜勤）の付け替え → できる',
    async run(h) {
      await seedNote(h, 715, day)
      await h.setNow('2026-11-01T16:00:00+09:00')
      const r = await h.as('field', (q) => q(`update notes set shift = 'night' where id = 715`))
      return lockedOf(r)
    },
    expect: { error: null, locked: false },
  })

  // 未来の日・前日の夜勤（夜勤明け）
  out.push({
    group: 'day',
    name: '現場: 未来の日（1週間後の日勤）への追加 → できる',
    async run(h) {
      await h.setNow(lockedNow)
      const r = await h.as('field', (q) => q(`insert into notes (note_on, shift, body) values ('2026-11-08', 'day', '本文N')`))
      return lockedOf(r)
    },
    expect: { error: null, locked: false },
  })
  out.push({
    group: 'day',
    name: '現場: 前日の夜勤の欄へ当日 8:29 に追加（猶予内）→ できる・8:30 → 止める',
    async run(h) {
      await h.setNow('2026-11-02T08:29:00+09:00')
      const a = await h.as('field', (q) => q(`insert into notes (note_on, shift, body) values ($1, 'night', '本文N')`, [LOCK_DAY]))
      await h.setNow('2026-11-02T08:30:00+09:00')
      const b = await h.as('field', (q) => q(`insert into notes (note_on, shift, body) values ($1, 'night', '本文M')`, [LOCK_DAY]))
      return { first: lockedOf(a).error, second: lockedOf(b).error }
    },
    expect: { first: null, second: 'P0001' },
  })

  // 取込（tools/import.mjs は所有者の接続・JWT なし＝my_role() が null）
  out.push({
    group: 'import',
    name: '取込（所有者の接続）: 何日も前の行の追加・更新・取り消しの印 → 止めない',
    async run(h) {
      await h.setNow('2026-11-20T12:00:00+09:00')
      await h.pg(`insert into notes (id, note_on, shift, body, import_key) overriding system value values (716, $1, 'day', '本文I', 'imp:1')`, [LOCK_DAY])
      await h.pg(`update notes set body = '本文J', category = 'k' where id = 716`)
      await h.pg(`update notes set import_tombstoned_at = now() where id = 716`)
      const row = (await h.pg(`select body, categories, import_tombstoned_at is not null t from notes where id = 716`))[0]
      return { body: row.body, categories: row.categories, tomb: row.t }
    },
    expect: { body: '本文J', categories: [], tomb: true },
  })
  out.push({
    group: 'import',
    name: '取込: 所有者の接続（JWT・役割の設定なし）では private.my_role() が null（＝トリガは止めない）',
    async run(h) {
      return { role: (await h.pg(`select private.my_role() r`))[0].r }
    },
    expect: { role: null },
  })

  // my_role の無い DB（care-backend の土台が無い）
  out.push({
    group: 'norole',
    name: 'private.my_role() が無い DB: 現場の設定でも止めない（役割が分からない＝今までどおり書ける）',
    async run(h) {
      await seedNote(h, 717, day)
      await h.setNow(lockedNow)
      await h.pg(`alter function private.my_role() rename to my_role_hidden`)
      const r = await h.as('field', (q) => q(`update notes set body = '本文A' where id = 717`))
      return lockedOf(r)
    },
    expect: { error: null, locked: false },
  })

  // 時刻帯（セッションの timezone に左右されない）
  out.push({
    group: 'tz',
    name: 'セッションの timezone が Asia/Tokyo でも UTC でも同じ判定（日勤 17:00 ちょうど＋30分で止める）',
    async run(h) {
      await seedNote(h, 718, day)
      await h.setNow(addMin(day.lockAt, 30))
      await h.pg(`set local timezone to 'Asia/Tokyo'`)
      const a = await h.as('field', (q) => q(`update notes set body = '本文A' where id = 718`))
      await h.pg(`set local timezone to 'UTC'`)
      const b = await h.as('field', (q) => q(`update notes set body = '本文B' where id = 718`))
      await h.pg(`set local timezone to 'America/Los_Angeles'`)
      const c = await h.as('field', (q) => q(`update notes set body = '本文C' where id = 718`))
      return { tokyo: lockedOf(a).error, utc: lockedOf(b).error, la: lockedOf(c).error }
    },
    expect: { tokyo: 'P0001', utc: 'P0001', la: 'P0001' },
  })

  // 旧クライアント×新サーバー: 分類を送らない登録はロック外なら今までどおり・分類は空
  out.push({
    group: 'compat',
    name: '旧クライアント（分類を送らない）・現場・ロック前: 登録できて分類は空（{}）',
    async run(h) {
      await h.setNow(addMin(day.lockAt, -60))
      const r = await h.as('field', (q) =>
        q(`insert into notes (note_on, shift, after16, resident_id, body, client_key) values ($1, 'day', false, 1, '本文N', 'ck-old-1') returning categories`, [LOCK_DAY]),
      )
      return { ...lockedOf(r), categories: Array.isArray(r) ? r[0].categories : null }
    },
    expect: { error: null, locked: false, categories: [] },
  })
  out.push({
    group: 'compat',
    name: '分類の列: 6値以外は check で拒否（23514）・null の要素も拒否',
    async run(h) {
      const a = await h.as(null, (q) => q(`insert into notes (note_on, shift, body, categories) values ('2026-11-08', 'day', '本文N', '{体調,睡眠}')`))
      const b = await h.as(null, (q) => q(`insert into notes (note_on, shift, body, categories) values ('2026-11-08', 'day', '本文N', array[null]::text[])`))
      const c = await h.as(null, (q) => q(`insert into notes (note_on, shift, body, categories) values ('2026-11-08', 'day', '本文N', null)`))
      return { bad: a.error ?? null, nullElem: b.error ?? null, nullCol: c.error ?? null }
    },
    expect: { bad: '23514', nullElem: '23514', nullCol: '23502' },
  })

  // 関数の作り（search_path の固定・definer の有無・API から呼べないこと）
  out.push({
    group: 'shape',
    name: 'notes_lock_guard は security definer・search_path=public, pg_temp。判定の関数は authenticated から呼べない',
    async run(h) {
      const g = (await h.pg(`select prosecdef, proconfig from pg_proc where oid = 'public.notes_lock_guard()'::regprocedure`))[0]
      const fns = await h.pg(
        `select p.proname, p.prosecdef, p.proconfig, has_function_privilege('authenticated', p.oid, 'execute') x
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'private' and p.proname in ('note_lock_at', 'note_lock_blocked', 'note_lock_now') order by p.proname`,
      )
      const trg = (await h.pg(`select tgname, tgenabled from pg_trigger where tgrelid = 'public.notes'::regclass and tgname = 'trg_notes_lock'`))[0]
      return {
        definer: g.prosecdef,
        config: g.proconfig,
        helpers: fns.map((f) => [f.proname, f.prosecdef, f.proconfig?.[0] ?? null, f.x]),
        trigger: trg?.tgname ?? null,
      }
    },
    expect: {
      definer: true,
      config: ['search_path=public, pg_temp'],
      helpers: [
        ['note_lock_at', false, 'search_path=public, pg_temp', false],
        ['note_lock_blocked', false, 'search_path=public, pg_temp', false],
        ['note_lock_now', false, 'search_path=public, pg_temp', false],
      ],
      trigger: 'trg_notes_lock',
    },
  })
  out.push({
    group: 'shape',
    name: '止めた時の文言は note_locked: で始まり、記録日と区分だけを含む（本文・氏名を含まない）',
    async run(h) {
      await seedNote(h, 719, LOCK_SECTIONS[1])
      await h.setNow(addMin(LOCK_SECTIONS[1].lockAt, 45))
      const r = await h.as('field', (q) => q(`update notes set body = '本文A' where id = 719`))
      return { message: r?.message ?? null }
    },
    expect: { message: 'note_locked: 2026-11-01 の16時以降の欄はロック中のため書き込めません（事務所で解除できます）' },
  })
  return out
}

export const LOCK_TRIGGER_CASES = triggerCases()

/** 観測と expect の食い違い（空なら一致） */
export function checkLockCase(c, observed) {
  const out = []
  for (const [k, v] of Object.entries(c.expect)) {
    if (JSON.stringify(observed?.[k] ?? null) !== JSON.stringify(v)) out.push(`${k}: ${JSON.stringify(observed?.[k] ?? null)} != ${JSON.stringify(v)}`)
  }
  return out
}
