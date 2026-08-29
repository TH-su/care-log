// =====================================================================
// importer 検証用の偽GASサーバ（集約GAS moushiokuri-viewer の読み取りAPIの模造）
//   tools/import-test.mjs から使う。実データ・実在の氏名・施設名は一切含まない。
//
// 実物と合わせている点:
//   ・?action=ping / events / measures / after16、token 必須
//   ・events / measures は要求どおりの from / to を応答に写す（importerが照合する）
//   ・after16 は 31 日で頭打ちにし、実際に返した to を返す
//   ・墓標の行は**応答に含めない**（実物 apiEvents と同じ＝importer は不在で検知する）
//
// 状態: v1（初回取込用）と v2（編集・削除・追加後）を ?action=___state&v=2 で切り替える。
// =====================================================================

import { createServer } from 'node:http'

const TOKEN = 'fixture-token'
const VER = '2026-08-28a'

// 日付は3日ぶん。氏名・施設名はすべて合成
const D1 = '2026-06-01'
const D2 = '2026-06-02'
const D3 = '2026-06-03'

function eventsV1() {
  return [
    { key: 'k1', date: D1, facility: '施設A', shift: 'day', row: 31, name: '利用者01', kind: 'resident', time: '09:30', body: '朝の様子は落ち着いています', reporter: '職員01' },
    { key: 'k7', date: D1, facility: '施設A', shift: 'day', row: 33, name: '未知利用者99', kind: 'resident', time: '', body: '照合できない行', reporter: '職員01' },
    { key: 'k2', date: D1, facility: '施設A', shift: 'day', row: 42, name: '利用者02', kind: 'resident', time: '16:30', body: '16時半に微熱', reporter: '職員02' },
    { key: 'k3', date: D1, facility: '施設A', shift: 'day', row: 45, name: '', kind: 'notice', time: '', body: '排泄表の様式が変わります', reporter: '職員01' },
    { key: 'k4', date: D1, facility: 'デイB', shift: 'daycare', row: 65, name: '利用者03', kind: 'resident', time: '', body: 'デイで入浴済み', reporter: '職員03' },
    { key: 'k5', date: D1, facility: '施設A', shift: 'night', row: 70, name: '利用者01', kind: 'resident', time: '', body: '巡視時入眠', reporter: '' },
    { key: 'k6', date: D1, facility: '施設A', shift: 'night', row: 72, name: '', kind: 'facility', time: '', body: '夜間の来訪なし', reporter: '' },
    // D2: 区切り行の位置が v1 では取れない（after16 が ok:false）。row 45 は区切り(40)より後
    { key: 'k8', date: D2, facility: '施設A', shift: 'day', row: 45, name: '利用者01', kind: 'resident', time: '17:00', body: '夕方に売店へ', reporter: '職員01' },
  ]
}

function eventsV2() {
  const base = eventsV1()
  const out = []
  for (const e of base) {
    if (e.key === 'k5') continue // 移行元で削除（墓標）→ 応答から消える
    if (e.key === 'k1') out.push({ ...e, body: '朝の様子は落ち着いています。追記あり' })
    else out.push(e)
  }
  out.push({ key: 'k9', date: D2, facility: '施設A', shift: 'day', row: 32, name: '利用者02', kind: 'resident', time: '10:00', body: '追加の記録', reporter: '職員02' })
  return out
}

function vitalsRows(state) {
  const base = [
    // 居室移動日に同一人が2タブへ載るケース（移行元キーは タブ名 で別行・こちらは同じ枠）。
    // 修正前はここで import_key が重複して 23505 → 窓ごと恒久取込不能になっていた
    { date: D3, name: '利用者03', room: '103', tab: 'バイタル1階', temp: 36.6, sysBP: 110, diaBP: 65, pulse: 68, spo2: 98, flags: '' },
    { date: D3, name: '利用者03', room: '203', tab: 'バイタル2階', temp: 36.7, sysBP: null, diaBP: null, pulse: null, spo2: null, flags: '' },
    // DBの numeric(3,1) で丸められる小数（修正前は毎回 update が走り続けた）
    { date: D3, name: '利用者01', room: '101', tab: 'バイタル1階', temp: 36.55, sysBP: 120.4, diaBP: null, pulse: null, spo2: null, flags: '' },
  ]
  return [
    { date: D1, name: '利用者01', room: '101', tab: 'バイタル1階', temp: 36.5, sysBP: 120, diaBP: 70, pulse: 72, spo2: 97, flags: '' },
    { date: D1, name: '利用者02', room: '102', tab: 'バイタル1階', temp: 38.2, sysBP: null, diaBP: null, pulse: 88, spo2: 95, flags: '' },
    { date: D1, name: '利用者04', room: '104', tab: 'バイタル1階', temp: null, sysBP: null, diaBP: null, pulse: null, spo2: null, flags: '' }, // 空行→取込対象外
    { date: D1, name: '利用者05', room: '105', tab: 'バイタル1階', temp: null, sysBP: null, diaBP: null, pulse: null, spo2: null, flags: '数値読めず' },
    { date: D1, name: '未知利用者99', room: '999', tab: 'バイタル1階', temp: 36.0, sysBP: null, diaBP: null, pulse: null, spo2: null, flags: '' },
    { date: D2, name: '利用者01', room: '101', tab: 'バイタル1階', temp: 36.4, sysBP: 118, diaBP: 68, pulse: 70, spo2: 98, flags: '' },
    { date: D2, name: '利用者02', room: '102', tab: 'バイタル1階', temp: 37.0, sysBP: null, diaBP: null, pulse: null, spo2: null, flags: '' }, // アプリ入力と衝突→native_skip
    ...base,
  ]
}

function mealsRows(state) {
  return [
    // v1 は朝も昼も値あり。v2 は**昼だけ値を消した**（行は生きている）。
    // 修正前はここで昼の行が「移行元から消えた」と誤認され soft delete されていた
    state === 2
      ? { date: D1, name: '利用者01', room: '101', bMain: 10, bSide: 10, lMain: null, lSide: null, dMain: null, dSide: null, flags: '' }
      : { date: D1, name: '利用者01', room: '101', bMain: 10, bSide: 10, lMain: 8, lSide: 7, dMain: null, dSide: null, flags: '' },
    { date: D1, name: '利用者02', room: '102', bMain: null, bSide: null, lMain: null, lSide: null, dMain: null, dSide: null, flags: '外泊' },
    { date: D1, name: '利用者03', room: '103', bMain: 5, bSide: 5, lMain: null, lSide: null, dMain: null, dSide: null, flags: '' },
    { date: D2, name: '利用者01', room: '101', bMain: null, bSide: null, lMain: 9, lSide: 9, dMain: null, dSide: null, flags: '' },
  ]
}

function after16Days(state, from, to) {
  const all = {
    [D1]: { date: D1, ok: true, dividerRow: 40, dayFrom: 30, dayTo: 60 },
    [D2]:
      state === 1
        ? { date: D2, ok: false, reason: 'source_not_found' } // v1では元ファイルが見つからない想定
        : { date: D2, ok: true, dividerRow: 40, dayFrom: 30, dayTo: 60 },
    [D3]: { date: D3, ok: true, dividerRow: 0, dayFrom: 30, dayTo: 60 },
  }
  const days = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    days.push(all[d] ?? { date: d, ok: false, reason: 'source_not_found' })
  }
  return days
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number)
  const x = new Date(Date.UTC(y, m - 1, d) + n * 86400000)
  const p = (v) => String(v).padStart(2, '0')
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())}`
}

function inRange(rows, from, to) {
  return rows.filter((r) => r.date >= from && r.date <= to)
}

/** テストから起動する。戻り値: { url, close, requests } */
export function startFixture(port = 0) {
  let state = 1
  const requests = []
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost')
    const action = u.searchParams.get('action')
    requests.push(action)
    const json = (obj) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(obj))
    }
    if (action === '___state') {
      state = Number(u.searchParams.get('v')) === 2 ? 2 : 1
      return json({ ok: true, state })
    }
    if (u.searchParams.get('token') !== TOKEN) return json({ ok: false, error: '認証エラー' })
    const from = u.searchParams.get('from')
    const to = u.searchParams.get('to')

    if (action === 'ping') {
      return json({ ok: true, role: 'viewer', ver: VER, lastTick: '2026-06-03 12:00', ingestedDays: '3' })
    }
    if (action === 'events') {
      const evs = inRange(state === 1 ? eventsV1() : eventsV2(), from, to)
      const ingested = [D1, D2, D3].filter((d) => d >= from && d <= to)
      return json({ ok: true, from, to, events: evs, ledger: [], ingestedDates: ingested, lastTick: '', lastFails: '' })
    }
    if (action === 'measures') {
      const vs = inRange(vitalsRows(state), from, to)
      const ms = inRange(mealsRows(state), from, to)
      const vDates = [...new Set(vs.map((v) => v.date))].sort()
      const mDates = [...new Set(ms.map((m) => m.date))].sort()
      return json({ ok: true, from, to, vitals: vs, meals: ms, vitalDates: vDates, mealDates: mDates, thresholdNotes: '', lastTick: '', lastFails: '' })
    }
    if (action === 'after16') {
      // 実物と同じく31日で頭打ちにし、実際に返した to を知らせる
      const capTo = addDays(from, 30) < to ? addDays(from, 30) : to
      return json({ ok: true, from, to: capTo, requestedTo: to, maxDays: 31, days: after16Days(state, from, capTo) })
    }
    return json({ ok: false, error: '不明なaction' })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port
      resolve({
        url: `http://127.0.0.1:${p}/exec`,
        token: TOKEN,
        close: () => new Promise((r) => server.close(r)),
        requests,
      })
    })
  })
}
