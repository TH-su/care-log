// 「排便なし◯日」の数え方が排便記録アプリと同じになることの試験（2026-10-16 追加）。
// 実行: npm test
//
// 写し元（haiben-record.html の elH〜lastR）を一字一句そのまま tests/fixtures/haiben-stool-judge.src.txt に置き、
// node:vm で評価して、src/lib/excretionClient.ts の写しと同じ入力に当てて比べる:
//   最後の排便1回分（lastR）・経過時間（elH）・注意／危険（badgeCls）・「便◯日」（Math.floor(時間/24)）
// 写し元の排便記録アプリが手元にある時は、写し元の同じ範囲が fixture と一致するかも確かめる
// （排便記録アプリ側で数え方が変わったのに写しが古いままになるのを止める）。CI には写し元が無いので fixture だけで比べる。
// 個人情報は置かない（入居者は記号の 利用者01・居室は数字だけ）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import { registerLoadFailure } from './ts-load.mjs'

// 排便記録アプリも care-log も日本時間の端末で動く（記録の日時は端末の時刻として読む）。CI（UTC）でも同じ答えにするため、
// この試験のプロセスだけ日本時間にする（node --test は試験のファイルごとに別のプロセス）
process.env.TZ = 'Asia/Tokyo'

const TS_UNSUPPORTED =
  'この Node では TypeScript を直接読み込めないため、排便の判定の一致の検証をスキップしました（Node 22.18 以降で実行してください）。'

let X = null
let loadErr = null
try {
  X = await import('../src/lib/excretionClient.ts')
} catch (e) {
  X = null
  loadErr = e
}
if (X === null) registerLoadFailure('排便の判定の一致', loadErr, TS_UNSUPPORTED)

const FIXTURE = new URL('./fixtures/haiben-stool-judge.src.txt', import.meta.url)
const HAIBEN_HTML = '/Users/Takeshi/Claude/Repos/haiben-record/haiben-record.html'

function fixtureParts() {
  const raw = readFileSync(FIXTURE, 'utf8')
  const i = raw.indexOf('//@----\n')
  return { head: raw.slice(0, i), code: raw.slice(i + '//@----\n'.length) }
}

/** 写し元の関数を、偽の D・recsByRes・時計の上で評価する */
function loadHaiben({ residents, records, cfg, now }) {
  const { code } = fixtureParts()
  const RealDate = Date
  class FixedDate extends RealDate {
    constructor(...a) {
      if (a.length === 0) super(now)
      else super(...a)
    }
    static now() {
      return now
    }
  }
  const ctx = {
    D: { residents, records, cfg },
    Date: FixedDate,
    isNaN,
    Math,
    Array,
    // 写し元の recsByRes と同じ: isUserRec を通った記録を datetime の昇順（localeCompare・安定）
    recsByRes: (rid) =>
      records
        .filter((r) => r.residentId === rid)
        .slice()
        .sort((a, b) => (a.datetime || '').localeCompare(b.datetime || '')),
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return ctx
}

const pad = (n) => String(n).padStart(2, '0')
/** 端末の時刻（この試験は TZ を固定しないので、両側とも同じ端末の時刻で読む） */
function dtOf(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 同じ入力を両方に当てる。records はサーバーの形（tsUTC なし）。写し元側には cleanData と同じく tsUTC を足す */
function compare({ records, resCfg = null, globalCfg = {}, now, hospitalizations = null }) {
  const serverRes = { id: 1, name: '利用者01', room: '101', active: true, ...(resCfg ? { cfg: resCfg } : {}) }
  if (hospitalizations) serverRes.hospitalizations = hospitalizations
  // 写し元の端末の形（cleanData 後）
  const hbRecs = records.map((r) => {
    const o = { ...r }
    if (typeof o.tsUTC !== 'number' || Number.isNaN(o.tsUTC)) {
      const t = new Date(o.datetime).getTime()
      if (!Number.isNaN(t)) o.tsUTC = t
    }
    return o
  })
  const hbCfg = Object.assign({ urineWarnH: 6, urineDangerH: 8, stoolWarnD: 2, stoolDangerD: 3 }, globalCfg)
  const H = loadHaiben({ residents: [{ ...serverRes }], records: hbRecs, cfg: hbCfg, now })
  const ls = H.lastR(1, 's')
  const h = H.elH(ls || null, 1)
  const want = {
    lastId: ls ? ls.id : null,
    h,
    cls: H.badgeCls(h, 's', 1),
    days: h === null ? null : Math.floor(h / 24),
  }
  // 写し（care-log）
  const snap = X.parseExcretionPayload({ residents: [serverRes], records, cfg: globalCfg })
  const pool = snap.recs.get('1') ?? []
  const res = snap.residents[0]
  const last = X.lastStoolReset(pool)
  const gh = X.elapsedH(last, now, res.hospitalizations)
  const got = {
    lastId: last ? last.id : null,
    h: gh,
    cls: { ok: 'eb-ok', warn: 'eb-w', danger: 'eb-ng' }[X.stoolLevel(gh, X.stoolCfgOf(res, snap.cfg))],
    days: gh === null ? null : Math.floor(gh / 24),
  }
  return { want, got }
}

const NOW = new Date(2026, 9, 16, 15, 0).getTime() // 2026-10-16 15:00（端末の時刻）
const H1 = 3600 * 1000
let seq = 0
const stool = (hAgo, amt, type = 'stool') => {
  const ms = NOW - hAgo * H1
  const dt = dtOf(ms)
  return { id: `r${++seq}`, residentId: 1, type, date: dt.slice(0, 10), time: dt.slice(11, 16), datetime: dt, stoolAmt: amt }
}
const urine = (hAgo) => {
  const dt = dtOf(NOW - hAgo * H1)
  return { id: `u${++seq}`, residentId: 1, type: 'urine', date: dt.slice(0, 10), time: dt.slice(11, 16), datetime: dt, urineAmt: 100 }
}

describe('排便の判定の写し（排便記録アプリと同じ入力で同じ答え）', { skip: X === null ? TS_UNSUPPORTED : false }, () => {
  it('fixture の見出しに写し元のコミットと行がある', () => {
    const { head, code } = fixtureParts()
    assert.match(head, /コミット: [0-9a-f]{40}/)
    assert.match(head, /行: \d+〜\d+/)
    assert.match(code, /^function elH\(dt,rid\)\{/)
    assert.match(code, /function stoolResetSeries\(arr\)\{/)
    assert.match(code, /function lastR\(rid,t\)\{/)
    // excretionClient.ts の冒頭の写し元の記載と同じコミット
    const commit = /コミット: ([0-9a-f]{40})/.exec(head)[1]
    const src = readFileSync(new URL('../src/lib/excretionClient.ts', import.meta.url), 'utf8')
    assert.ok(src.includes(`コミット ${commit}`), '写しの冒頭のコミットと fixture のコミットが違います')
  })

  it('写し元が手元にある時は、写し元の elH〜lastR が fixture と一字一句同じ（違えば写しを見直す）', (t) => {
    if (!existsSync(HAIBEN_HTML)) {
      // CI はスキップが1件でもあると公開を止めるので、スキップにせず記録だけ残す（fixture どうしの比べは下の試験が行う）
      t.diagnostic('写し元の排便記録アプリがこの端末に無い（CI など）。fixture だけで比べる')
      return
    }
    const html = readFileSync(HAIBEN_HTML, 'utf8')
    const a = html.indexOf('function elH(dt,rid){')
    const b = html.indexOf('/* 記録が途切れた期間とみなす')
    assert.ok(a > 0 && b > a, '写し元に elH〜lastR の範囲が見つかりません')
    assert.equal(html.slice(a, b), fixtureParts().code, '排便記録アプリの数え方の範囲が写しの後に変わっています。excretionClient.ts と fixture を見直してください')
  })

  const cases = [
    ['記録なし', { records: [] }],
    ['中等量1回（30時間前）', { records: [stool(30, '中等量')] }],
    ['多量1回（80時間前）＝危険', { records: [stool(80, '多量')] }],
    ['量の空欄は1回（50時間前）＝注意', { records: [stool(50, '')] }],
    ['量が null も1回', { records: [stool(50, null)] }],
    ['少量1回だけ＝1回と数えない', { records: [stool(70, '多量'), stool(10, '少量')] }],
    ['少量2回だけ＝数えない', { records: [stool(70, '多量'), stool(20, '少量'), stool(10, '少量')] }],
    ['少量3回（48時間以内）の3回目で1回', { records: [stool(100, '多量'), stool(40, '少量'), stool(20, '少量'), stool(5, '少量')] }],
    ['少量3回が48時間を超える＝鎖を作り直す', { records: [stool(120, '中等量'), stool(60, '少量'), stool(30, '少量'), stool(5, '少量')] }],
    ['少量の間が最初から48時間ちょうどなら同じ鎖（3回目で1回）', { records: [stool(100, '多量'), stool(60, '少量'), stool(30, '少量'), stool(12, '少量')] }],
    ['少量の間が最初から48時間30分なら鎖を作り直す', { records: [stool(100, '多量'), stool(60.5, '少量'), stool(30, '少量'), stool(12, '少量')] }],
    ['少量2回→中等量で1回（鎖は切れる）', { records: [stool(60, '少量'), stool(50, '少量'), stool(40, '中等量'), stool(20, '少量')] }],
    ['both（排尿＋排便）も排便に数える', { records: [urine(3), stool(30, '中等量', 'both'), urine(1)] }],
    ['届いた順がばらばらでも datetime の順に並べて数える', { records: [stool(5, '少量'), stool(40, '少量'), stool(100, '多量'), stool(20, '少量')] }],
    ['入居者の cfg が優先（注意5・危険7）', { records: [stool(100, '多量')], resCfg: { stoolWarnD: 5, stoolDangerD: 7 } }],
    ['入居者の cfg が無ければ全体の cfg（注意1・危険2）', { records: [stool(30, '多量')], globalCfg: { stoolWarnD: 1, stoolDangerD: 2 } }],
    ['入居者の cfg が片方だけ', { records: [stool(60, '多量')], resCfg: { stoolDangerD: 2 }, globalCfg: { stoolWarnD: 1, stoolDangerD: 9 } }],
    ['しきい値ちょうど（48時間）は注意', { records: [stool(48, '多量')] }],
    ['tsUTC が数で届いた記録はそれを優先', { records: [{ ...stool(30, '多量'), tsUTC: NOW - 70 * H1 }] }],
    ['入院中は入院日時で止まる（入院の履歴が届いた時だけ）', {
      records: [stool(100, '多量')],
      hospitalizations: [{ id: 'h1', admissionAt: dtOf(NOW - 60 * H1), dischargeAt: null }],
    }],
    ['退院済みの入院は止めない', {
      records: [stool(100, '多量')],
      hospitalizations: [{ id: 'h1', admissionAt: dtOf(NOW - 90 * H1), dischargeAt: dtOf(NOW - 70 * H1) }],
    }],
  ]
  for (const [name, input] of cases) {
    it(name, () => {
      const { want, got } = compare({ now: NOW, ...input })
      assert.deepEqual(got, want)
    })
  }

  it('乱数で作った 600 通りの記録でも、最後の排便・時間・注意／危険・日数が全部同じ', () => {
    let s = 20261016
    const rnd = () => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648
    }
    const amts = ['少量', '少量', '少量', '中等量', '多量', '', null]
    let differ = 0
    let warnOrDanger = 0
    for (let n = 0; n < 600; n++) {
      const records = []
      const k = Math.floor(rnd() * 12)
      for (let i = 0; i < k; i++) {
        // 分の単位まで散らす（48時間の境目の前後も当たるように）
        const hAgo = Math.floor(rnd() * 16 * 24 * 60) / 60
        const type = rnd() < 0.2 ? 'both' : rnd() < 0.3 ? 'urine' : 'stool'
        records.push(type === 'urine' ? urine(hAgo) : stool(hAgo, amts[Math.floor(rnd() * amts.length)], type))
      }
      const resCfg = rnd() < 0.3 ? { stoolWarnD: 1 + Math.floor(rnd() * 3), stoolDangerD: 3 + Math.floor(rnd() * 3) } : null
      const { want, got } = compare({ now: NOW, records, resCfg })
      if (JSON.stringify(want) !== JSON.stringify(got)) differ++
      if (want.cls !== 'eb-ok') warnOrDanger++
    }
    assert.equal(differ, 0)
    // 注意・危険の側も十分に試せている（全部「なし」で一致しただけ、にしない）
    assert.ok(warnOrDanger > 100, String(warnOrDanger))
  })
})
