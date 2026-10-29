// タイムラインの「60日より前に始まった継続」の帯（代表者の決定 2026-10-29 案A）の試験（通信しない）。
// 実行: npm test
//
// 1. 境目の日（日本時間の今日−60日）と帯の文言（0件・読めない時は出さない）
// 2. 件数と一覧の読み込み（src/lib/staleOngoing.ts の createStaleOngoing）: 件数だけ先に読む・一覧は押した時だけ読む・
//    読めない時は帯なし・取り直しの合図で件数（開いていれば一覧も）を取り直す・遅れて届いた応答は捨てる
// 3. db.ts の件数の問い合わせ（偽の Supabase）: notes を継続・終わっていない・消していない・境目より前で、head の件数だけ読む
// 4. 画面の配線の静的検査: 帯は印刷しない・押せる大きさ・読み上げの名前・窓全体の取り直しに乗る（新しい購読を作らない）
// 個人情報は置かない（利用者・職員は数値IDと記号だけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerLoadFailure } from './ts-load.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const lsStore = new Map()
let DB = null
let ST = null
let loadError = null
try {
  const { registerHooks } = await import('node:module')
  if (typeof registerHooks !== 'function') throw new Error('no registerHooks')
  registerHooks({
    resolve(specifier, context, next) {
      if (/^\.{1,2}\//.test(specifier) && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
        try {
          return next(`${specifier}.ts`, context)
        } catch {
          // .ts が無いものは元の指定へ戻す
        }
      }
      return next(specifier, context)
    },
  })
  if (globalThis.localStorage === undefined) {
    globalThis.localStorage = {
      getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
      setItem: (k, v) => {
        lsStore.set(k, String(v))
      },
      removeItem: (k) => {
        lsStore.delete(k)
      },
    }
  }
  DB = await import('../src/lib/db.ts')
  ST = await import('../src/lib/staleOngoing.ts')
} catch (e) {
  loadError = e
}

/** 約束を1つずつ手で解く（届く順を試験が決める） */
function deferred() {
  let resolve
  let reject
  const p = new Promise((a, b) => {
    resolve = a
    reject = b
  })
  return { p, resolve, reject }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

// 日本時間 2026-10-29 9:00（UTC 10-29 0:00）
const NOW = Date.parse('2026-10-29T00:00:00Z')

function harness() {
  const calls = { count: [], list: [] }
  const pend = { count: [], list: [] }
  const states = []
  const ctl = ST.createStaleOngoing(
    {
      count(before) {
        calls.count.push(before)
        const d = deferred()
        pend.count.push(d)
        return d.p
      },
      list(before) {
        calls.list.push(before)
        const d = deferred()
        pend.list.push(d)
        return d.p
      },
      now: () => NOW,
    },
    (s) => states.push(s),
  )
  const last = () => states.at(-1) ?? ST.STALE_ONGOING_INITIAL
  return { ctl, calls, pend, last }
}

const note = (id, note_on) => ({ id, note_on, shift: 'day', resident_id: 1, importance: 'normal', body: '記号の本文', ongoing: true, ended_at: null })

if (DB === null || ST === null) {
  registerLoadFailure('60日より前に始まった継続の帯の試験', loadError, 'この Node は型の除去か解決フックを持たない（古い Node）', { hooks: true })
} else {
  describe('境目の日と帯の文言', () => {
    it('境目は日本時間の今日−60日（UTC では前の日でも日本時間の日付で数える）', () => {
      assert.equal(ST.STALE_ONGOING_DAYS, 60)
      assert.equal(ST.staleOngoingBefore(NOW), '2026-08-30')
      // UTC 10-28 15:30 は日本時間 10-29 0:30
      assert.equal(ST.staleOngoingBefore(Date.parse('2026-10-28T15:30:00Z')), '2026-08-30')
      // UTC 10-28 14:59 は日本時間 10-28 23:59
      assert.equal(ST.staleOngoingBefore(Date.parse('2026-10-28T14:59:00Z')), '2026-08-29')
    })
    it('文言は指示どおり・0件と読めない値は null（帯を出さない）', () => {
      assert.equal(ST.staleOngoingBannerText(3), '60日より前に始まった継続が 3件あります（終了してください）')
      for (const v of [0, null, undefined, Number.NaN, -1]) assert.equal(ST.staleOngoingBannerText(v), null)
    })
  })

  describe('件数と一覧の読み込み（createStaleOngoing）', () => {
    it('取り直しの合図で件数だけを読む（一覧は読まない）・件数0なら帯なし', async () => {
      const h = harness()
      h.ctl.reload()
      assert.deepEqual(h.calls.count, ['2026-08-30'])
      assert.equal(h.calls.list.length, 0)
      h.pend.count[0].resolve(0)
      await flush()
      assert.equal(h.last().count, 0)
      assert.equal(ST.staleOngoingBannerText(h.last().count), null)
      assert.equal(h.calls.list.length, 0)
    })
    it('件数ありで帯が出る・押した時だけ一覧を読む（古い順の行がそのまま入る）', async () => {
      const h = harness()
      h.ctl.reload()
      h.pend.count[0].resolve(2)
      await flush()
      assert.equal(h.last().count, 2)
      assert.equal(h.last().open, false)
      assert.equal(h.calls.list.length, 0, '開く前は一覧を読まない')
      h.ctl.open()
      assert.equal(h.last().open, true)
      assert.equal(h.calls.list.length, 1)
      assert.equal(h.calls.list[0], '2026-08-30')
      const rows = [note(11, '2026-07-01'), note(12, '2026-08-01')]
      h.pend.list[0].resolve(rows)
      await flush()
      assert.deepEqual(h.last().rows.map((n) => n.id), [11, 12])
      // 2回押しても読み直さない
      h.ctl.open()
      assert.equal(h.calls.list.length, 1)
    })
    it('件数を読めない時は帯を出さない（例外を外へ出さない）', async () => {
      const h = harness()
      h.ctl.reload()
      h.pend.count[0].reject(new Error('通信'))
      await flush()
      assert.equal(h.last().count, null)
      assert.equal(ST.staleOngoingBannerText(h.last().count), null)
      // 同期に投げる取得でも止めない
      const states = []
      const ctl2 = ST.createStaleOngoing(
        {
          count() {
            throw new Error('同期の失敗')
          },
          list: () => Promise.resolve([]),
          now: () => NOW,
        },
        (s) => states.push(s),
      )
      assert.doesNotThrow(() => ctl2.reload())
      await flush()
      assert.equal(states.at(-1).count, null)
    })
    it('開いている間の取り直しの合図（終了の後など）で、件数と一覧の両方を取り直す・0件になったら閉じる', async () => {
      const h = harness()
      h.ctl.reload()
      h.pend.count[0].resolve(1)
      await flush()
      h.ctl.open()
      h.pend.list[0].resolve([note(11, '2026-07-01')])
      await flush()
      h.ctl.reload()
      assert.equal(h.calls.count.length, 2)
      assert.equal(h.calls.list.length, 2)
      h.pend.list[1].resolve([])
      h.pend.count[1].resolve(0)
      await flush()
      assert.equal(h.last().count, 0)
      assert.equal(h.last().open, false)
      assert.equal(h.last().rows, null)
    })
    it('閉じている間の取り直しは件数だけ', async () => {
      const h = harness()
      h.ctl.reload()
      h.pend.count[0].resolve(4)
      await flush()
      h.ctl.reload()
      assert.equal(h.calls.count.length, 2)
      assert.equal(h.calls.list.length, 0)
    })
    it('遅れて届いた古い件数・閉じた後に届いた一覧は捨てる', async () => {
      const h = harness()
      h.ctl.reload()
      h.ctl.reload()
      h.pend.count[1].resolve(5)
      await flush()
      h.pend.count[0].resolve(9)
      await flush()
      assert.equal(h.last().count, 5)
      h.ctl.open()
      h.ctl.close()
      h.pend.list[0].resolve([note(11, '2026-07-01')])
      await flush()
      assert.equal(h.last().open, false)
      assert.equal(h.last().rows, null)
    })
    it('一覧を読めない時は帯を残して読めなかった旨を出し、再試行で読み直す', async () => {
      const h = harness()
      h.ctl.reload()
      h.pend.count[0].resolve(1)
      await flush()
      h.ctl.open()
      h.pend.list[0].reject(new Error('通信'))
      await flush()
      assert.equal(h.last().count, 1)
      assert.equal(h.last().listError, true)
      h.ctl.retryList()
      assert.equal(h.calls.list.length, 2)
      h.pend.list[1].resolve([note(11, '2026-07-01')])
      await flush()
      assert.equal(h.last().listError, false)
      assert.equal(h.last().rows.length, 1)
    })
    it('捨てた後（画面を離れた後）に届いた応答で状態を変えない', async () => {
      const h = harness()
      h.ctl.reload()
      h.ctl.dispose()
      h.pend.count[0].resolve(3)
      await flush()
      assert.equal(h.last().count, null)
    })
  })

  describe('db.ts の件数の問い合わせ（偽の Supabase）', () => {
    /** 呼び出しの形を記録する偽のクライアント。res を返す */
    function fake(res) {
      const log = []
      const b = (table) => {
        const q = { table, select: null, opts: null, filters: [], order: [], limit: null }
        log.push(q)
        const self = {
          select(cols, opts) {
            q.select = cols
            q.opts = opts ?? null
            return self
          },
          eq(k, v) {
            q.filters.push(['eq', k, v])
            return self
          },
          is(k, v) {
            q.filters.push(['is', k, v])
            return self
          },
          neq(k, v) {
            q.filters.push(['neq', k, v])
            return self
          },
          lt(k, v) {
            q.filters.push(['lt', k, v])
            return self
          },
          order(k, o) {
            q.order.push([k, o?.ascending])
            return self
          },
          limit(n) {
            q.limit = n
            return self
          },
          then(ok, ng) {
            return Promise.resolve(typeof res === 'function' ? res(q) : res).then(ok, ng)
          },
        }
        return self
      }
      return { client: { from: b }, log }
    }
    const WANT_FILTERS = [
      ['eq', 'ongoing', true],
      ['is', 'ended_at', null],
      ['is', 'deleted_at', null],
      // 最重要は数えない（0050 でピン留めに出し続ける＝隠れていない）
      ['neq', 'importance', 'critical'],
      ['lt', 'note_on', '2026-08-30'],
    ]

    it('件数は notes の head の件数だけ（行を読まない）・最重要は数えない', async () => {
      const f = fake({ data: null, error: null, status: 200, count: 7 })
      DB.__testHooks.setClient(f.client)
      try {
        assert.equal(await DB.countStaleOngoingNotes('2026-08-30'), 7)
      } finally {
        DB.__testHooks.setClient(null)
      }
      assert.equal(f.log.length, 1)
      assert.equal(f.log[0].table, 'notes')
      assert.deepEqual(f.log[0].opts, { count: 'exact', head: true })
      assert.deepEqual(f.log[0].filters, WANT_FILTERS)
    })
    it('読めない時・件数が無い応答は投げる（帯を出さない側）', async () => {
      for (const res of [
        { data: null, error: { message: 'x', code: 'XX000' }, status: 500 },
        { data: null, error: null, status: 200, count: null },
      ]) {
        DB.__testHooks.setClient(fake(res).client)
        try {
          await assert.rejects(DB.countStaleOngoingNotes('2026-08-30'))
        } finally {
          DB.__testHooks.setClient(null)
        }
      }
    })
    it('一覧は同じ条件で古い順（始まりの日・id）に読む', async () => {
      const f = fake({ data: [note(11, '2026-07-01'), note(12, '2026-08-01')], error: null, status: 200 })
      DB.__testHooks.setClient(f.client)
      let rows
      try {
        rows = await DB.fetchStaleOngoingNotes('2026-08-30')
      } finally {
        DB.__testHooks.setClient(null)
      }
      assert.deepEqual(rows.map((n) => n.id), [11, 12])
      assert.deepEqual(f.log[0].filters, WANT_FILTERS)
      assert.deepEqual(f.log[0].order, [
        ['note_on', true],
        ['id', true],
      ])
      assert.equal(typeof f.log[0].limit, 'number')
    })
    it('日付でない境目は問い合わせずに投げる', async () => {
      const f = fake({ data: null, error: null, status: 200, count: 1 })
      DB.__testHooks.setClient(f.client)
      try {
        await assert.rejects(DB.countStaleOngoingNotes('2026/08/30'))
      } finally {
        DB.__testHooks.setClient(null)
      }
      assert.equal(f.log.length, 0)
    })
  })
}

describe('画面の配線（静的検査）', () => {
  const page = strip(read('../src/pages/TimelinePage.tsx'))
  const hook = strip(read('../src/hooks/useStaleOngoing.ts'))
  const tl = strip(read('../src/hooks/useTimeline.ts'))
  const i = page.indexOf('function StaleOngoingBanner(')
  const banner = page.slice(i, page.indexOf('\nfunction ', i + 10))

  it('帯は印刷しない・押せる大きさ・開閉の状態と読み上げの名前を持つ・色だけで伝えない（▲と文言）', () => {
    assert.notEqual(i, -1)
    assert.match(banner, /print:hidden/)
    assert.match(banner, /min-h-tap/)
    assert.match(banner, /aria-expanded=\{stale\.open\}/)
    assert.match(banner, /aria-label=/)
    assert.match(banner, /▲ /)
    assert.match(banner, /staleOngoingBannerText\(stale\.count\)/)
    assert.match(banner, /if \(text === null\) return null/)
    // 一覧が上限で切れた時は黙って切らない（件数より少ない時だけ一言を出す）
    assert.match(banner, /stale\.rows\.length < stale\.count/)
  })
  it('一覧の行は既存の終了の操作（EndOngoingButton・inputEnabled で止まる）を使う', () => {
    assert.match(banner, /<EndOngoingButton[\s\S]*inputEnabled=\{inputEnabled\}[\s\S]*onEndOngoing=\{onEndOngoing\}/)
    assert.match(page, /onEndOngoing=\{handleEndOngoing\}\s*\/>\s*\)\}\s*\{days\.map/)
  })
  it('件数の取り直しは窓全体の取り直し（windowRev）に乗る・新しい購読を作らない', () => {
    assert.match(page, /useStaleOngoing\(windowRev\)/)
    assert.doesNotMatch(hook, /subscribeChanges/)
    assert.match(hook, /if \(tick <= 0\) return/)
    // windowRev を増やすのは窓全体の取り直し（loadWindow）の確定の1か所だけ
    assert.equal((tl.match(/setWindowRev\(/g) ?? []).length, 1)
    const lw = tl.slice(tl.indexOf('const loadWindow = useCallback('), tl.indexOf('const loadDays = useCallback('))
    assert.match(lw, /commitDays\(placeOutings\(built\)\)\s*setWindowRev\(\(n\) => n \+ 1\)/)
  })
})
