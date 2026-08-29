#!/usr/bin/env node
// =====================================================================
// care-log 過去データ取込（importer）
//   移行計画: ~/Claude/Work/経営アーキテクチャ再設計/care-log_過去データ移行計画.md
//   移行元: 集約GAS（moushiokuri-viewer）の読み取りAPI
//     ・apiEvents(from,to)   … 申し送り（events）。1回最大150日
//     ・apiMeasures(from,to) … バイタル・食事量。1回最大150日
//     ・apiAfter16(from,to)  … 日勤「⇩16時以降の記録」の区切り行番号。1回最大31日
//
// 使い方（ターミナル。通常は ~/bin/care-log-import.sh 経由で実行する）:
//   CARELOG_GAS_URL='https://script.google.com/macros/s/…/exec' \
//   CARELOG_GAS_TOKEN='…' \
//   SUPABASE_DB_URL='postgresql://…' \
//     node tools/import.mjs [--execute] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//
//   ・既定は**ドライラン**（DBに1行も書かず、何が起きるかの計数だけ出す）
//   ・--execute      … 実際に書き込む
//   ・--from / --to  … 取込期間。省略時は to=今日(JST)から後方へ、
//                      「取込済みの日が1日も無い150日窓」が2回続くまで遡る
//   ・--max-windows N… 遡る窓数の上限（既定 40 ＝ 約16年ぶん。暴走の歯止め）
//   ・--allow-synthetic … residents に合成マスタ（SYN-）が居ても書き込みを許す（検証環境専用）
//
// 冪等性: 全行が import_key（ev:/vt:/ml: 接頭辞＋移行元のkey）を持ち、
//   2回目の実行は inserted=0 になる。何度でも安全に再実行できる。
//
// 計数の恒等式（移行計画 §3-1。1日1系列ごとに検査し、破れたら**その窓ごと rollback**）:
//   取込対象行数 = inserted + updated + skipped + native_skip + unmatched
//     skipped     = 変更なし ＋ こちら側で削除済み（墓標）＋ 形式不正
//     native_skip = 同じ枠にアプリ入力（import_key無し）の行が既にある → 触らない
//     unmatched   = 利用者を特定できない → 取り込まない（名寄せ表で後から再実行できる）
//   ※「取込対象行数」= 空行（全値null・flags無し）を除いた行数。食事は1食=1行に展開後。
//     import_days.src_rows にはこの値を記録する。
//
// アプリ入力の保護（移行計画 §3-2）:
//   update は import_key の一致でしか行わない。アプリ入力の行は import_key が null
//   なので構造的に触れない。vitals/meals は同じ枠（利用者×日×食）にアプリ入力行が
//   あれば native_skip として飛ばす。
//
// 移行元側の削除への追従（source 正本の原則）:
//   移行元は行を消さず墓標（deletedAt）を立て、APIは墓標行を**返さない**。
//   そのため「取込済みの日」について、こちらの取込行のうち今回のAPI応答に無い key の行へ
//   soft delete（deleted_at）を付ける。恒等式の外側で数え、報告に明記する。
//   ★アプリ入力（import_key null）の行はこの対象にならない。
//
// after16（日勤の16時区切り）:
//   1日につき区切りの行番号1つを apiAfter16 から取り、events の row との大小で判定する。
//   区切りが取れなかった日（元ファイル消失等）は after16=false のまま取り込み、
//   **その日の after16 は比較・更新の対象から外す**（後で取れた時の再実行で直る。
//   逆向きに false へ戻してしまう事故を防ぐ）。報告に日の一覧を出す。
//
// 個人情報:
//   コードに実在の氏名・施設名を書かない。報告ファイル（氏名を含みうる）は
//   リポジトリ外（~/Library/Application Support/care-log-import/reports/）に書く。
//   console には件数と日付だけを出す（氏名は出さない）。
//
// TLS: 接続文字列の sslmode だけで決める（seed-synthetic.mjs と同じ方針）。
// =====================================================================

import pg from 'pg'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const { Client } = pg
// date/time/numeric は文字列のまま受ける（JS Date のタイムゾーン解釈で日付がずれるのを防ぐ）
pg.types.setTypeParser(1082, (v) => v) // date
pg.types.setTypeParser(1083, (v) => v) // time

// ---------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------

/** 必要なサーバー版（これ未満は after16 が無い） */
const REQUIRED_VER = '2026-08-28a'
/** apiEvents / apiMeasures の1窓（APIの上限150日より1日短くして丸めを踏まない） */
const WINDOW_DAYS = 149
/** apiAfter16 の1窓（API側上限31日） */
const AFTER16_WINDOW = 31
/** 「取込済みの日が無い窓」が何回続いたら遡りを打ち切るか */
const EMPTY_WINDOWS_TO_STOP = 2
/** import_key の接頭辞（seed の 'syn:' と衝突しない値） */
const KEY_EV = 'ev:'
const KEY_VT = 'vt:'
const KEY_ML = 'ml:'
/** DBへ一度に渡す行数 */
const BATCH = 400
/** GAS 呼び出しのリトライ回数と待ち */
const FETCH_RETRY = 3
const FETCH_WAIT_MS = 4000
/** 1回の応答待ちの上限。GAS が黙り込んだ時に永遠に待たない（fetch は既定で無期限） */
const FETCH_TIMEOUT_MS = 180000
/** 応答サイズの上限（これを超えたら異常とみなす） */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024

const REPORT_DIR_DEFAULT = join(
  homedir(),
  'Library',
  'Application Support',
  'care-log-import',
  'reports',
)
const NAMEMAP_PATH = new URL('./import-namemap.json', import.meta.url)

// ---------------------------------------------------------------------
// 引数・環境
// ---------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    execute: false,
    from: null,
    to: null,
    maxWindows: 40,
    allowSynthetic: false,
    reportDir: REPORT_DIR_DEFAULT,
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--execute') a.execute = true
    else if (v === '--dry-run') a.execute = false
    else if (v === '--allow-synthetic') a.allowSynthetic = true
    else if (v === '--from') a.from = argv[++i]
    else if (v === '--to') a.to = argv[++i]
    else if (v === '--max-windows') a.maxWindows = Number(argv[++i])
    else if (v === '--report-dir') a.reportDir = argv[++i]
    else if (v === '--help') {
      console.log('使い方: node tools/import.mjs [--execute] [--from YYYY-MM-DD] [--to YYYY-MM-DD]')
      process.exit(0)
    } else {
      console.error(`不明な引数: ${v}（--help で使い方）`)
      process.exit(2)
    }
  }
  for (const k of ['from', 'to']) {
    if (a[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(a[k])) {
      console.error(`--${k} は YYYY-MM-DD 形式で指定してください: ${a[k]}`)
      process.exit(2)
    }
  }
  if (!Number.isInteger(a.maxWindows) || a.maxWindows < 1 || a.maxWindows > 200) {
    console.error('--max-windows は 1〜200 の整数で指定してください')
    process.exit(2)
  }
  return a
}

// ---------------------------------------------------------------------
// 日付ユーティリティ（JST固定。Macのタイムゾーン設定に依存しない）
// ---------------------------------------------------------------------

function todayJst() {
  const s = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date())
  return s // 'YYYY-MM-DD'
}

function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d) + n * 86400000
  const x = new Date(t)
  const p = (v) => String(v).padStart(2, '0')
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())}`
}

/** 氏名の照合キー（空白除去のみ。異体字・字種は変えない＝原則6） */
function normName(s) {
  return String(s ?? '').replace(/[\s　]/g, '')
}

/** 編集距離（異体字1文字違い・打ち間違いを拾うため） */
function editDistance(a, b) {
  const m = a.length
  const n = b.length
  if (m === 0 || n === 0) return Math.max(m, n)
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/**
 * 照合できなかった氏名ごとに、マスタの中から対応候補を挙げる。
 * ★機械が決めるのは候補までで、採用は人が決める（取り違えは記録の意味を壊すため）。
 * 種別: same_surname=姓だけの記載で1名に確定 / variant=1〜2文字違い（異体字の可能性）
 *       ambiguous=候補が複数 / none=候補なし
 */
function suggestNamemap(unmatchedNames, residents) {
  const list = residents.map((r) => ({ id: r.source_id, name: r.name, key: normName(r.name) }))
  const out = []
  for (const [raw, count] of unmatchedNames) {
    const k = normName(raw)
    if (!k) continue
    const prefix = list.filter((r) => r.key.startsWith(k))
    const near = list
      .map((r) => ({ ...r, d: editDistance(k, r.key) }))
      .filter((r) => r.d > 0 && r.d <= 2)
      .sort((a, b) => a.d - b.d)
    let kind = 'none'
    let candidates = []
    if (prefix.length === 1 && k.length < prefix[0].key.length) {
      kind = 'same_surname'
      candidates = prefix
    } else if (prefix.length > 1) {
      kind = 'ambiguous'
      candidates = prefix
    } else if (near.length === 1 || (near.length > 1 && near[0].d < near[1].d)) {
      kind = 'variant'
      candidates = [near[0]]
    } else if (near.length > 1) {
      kind = 'ambiguous'
      candidates = near.slice(0, 4)
    }
    out.push({ raw, count, kind, candidates: candidates.map((c) => ({ id: c.id, name: c.name })) })
  }
  // 件数の多い順＝直す効果の大きい順に並べる
  return out.sort((a, b) => b.count - a.count)
}

/**
 * 記入者（職員）の対応候補。移行元の記入者欄は姓だけ・1〜2文字のことが多い。
 * 名寄せ表の staff 側は「記録側の表記 → 正しい職員氏名」で持つ（利用者IDのような番号は無い）。
 * ★在籍・退職を問わず全員から探す（過去の記録は退職者が書いていることがある）。
 */
function suggestStaffNamemap(unmatchedReporters, staffRows) {
  const list = staffRows.map((s) => ({ name: s.name, key: normName(s.name), active: s.active !== false }))
  const out = []
  for (const [raw, count] of unmatchedReporters) {
    const k = normName(raw)
    if (!k) continue
    const prefix = list.filter((s) => s.key.startsWith(k))
    const near = list
      .map((s) => ({ ...s, d: editDistance(k, s.key) }))
      .filter((s) => s.d > 0 && s.d <= 1)
      .sort((a, b) => a.d - b.d)
    let kind = 'none'
    let candidates = []
    if (prefix.length === 1) {
      kind = 'same_surname'
      candidates = prefix
    } else if (prefix.length > 1) {
      kind = 'ambiguous'
      candidates = prefix
    } else if (near.length === 1) {
      kind = 'variant'
      candidates = near
    } else if (near.length > 1) {
      kind = 'ambiguous'
      candidates = near.slice(0, 4)
    }
    out.push({
      raw,
      count,
      kind,
      candidates: candidates.map((c) => ({ name: c.name, active: c.active })),
    })
  }
  return out.sort((a, b) => b.count - a.count)
}

/**
 * 'HH:MM' として妥当なら 'HH:MM:00' を返す。それ以外は null。
 * ★秒まで揃えるのは差分比較のため: DB の time 型は '16:30:00' で返るので、
 *   '16:30' のままだと毎回「値が変わった」と誤判定して無意味な update を打ち続ける
 *   （＝冪等でなくなる。2026-08-29 結合テストで検出）。
 */
function validTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return `${String(h).padStart(2, '0')}:${m[2]}:00`
}

// ---------------------------------------------------------------------
// GAS 呼び出し
// ---------------------------------------------------------------------

async function gasGet(baseUrl, token, action, params) {
  const u = new URL(baseUrl)
  u.searchParams.set('action', action)
  u.searchParams.set('token', token)
  for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, v)
  let lastErr = null
  for (let i = 1; i <= FETCH_RETRY; i++) {
    try {
      const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      const text = await res.text()
      if (text.length > MAX_RESPONSE_BYTES) throw new Error(`応答が大きすぎます（${text.length}バイト）`)
      let json
      try {
        json = JSON.parse(text)
      } catch {
        // GAS はスクリプトエラー時に HTML を返す。先頭だけ添えて分かるようにする
        throw new Error(`JSONではない応答（HTTP ${res.status}）: ${text.slice(0, 120)}`)
      }
      if (json && json.ok === false) throw new Error(`APIエラー: ${json.error ?? '不明'}`)
      return json
    } catch (e) {
      lastErr = e
      if (i < FETCH_RETRY) await new Promise((r) => setTimeout(r, FETCH_WAIT_MS * i))
    }
  }
  throw new Error(`GAS ${action} の取得に失敗: ${lastErr?.message ?? lastErr}`)
}

// ---------------------------------------------------------------------
// マスタ読み込みと名寄せ
// ---------------------------------------------------------------------

async function loadMasters(db) {
  // active=false（退居済み）も含めて全員を対象にする＝過去の記録の帰属先が消えないように
  const rs = await db.query('select id, source_id, name from residents')
  const st = await db.query('select id, name, active from staff')

  let namemap = { residents: {}, staff: {} }
  if (existsSync(NAMEMAP_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(NAMEMAP_PATH, 'utf8'))
      namemap = { residents: raw.residents ?? {}, staff: raw.staff ?? {} }
    } catch (e) {
      throw new Error(`import-namemap.json を読めません（JSONの形式を確認）: ${e.message}`)
    }
  }

  // 照合表: 正規化名 → id。同名2人は「曖昧」として照合不能にする（取り違え防止）
  const resByName = new Map()
  const ambiguous = new Set()
  for (const r of rs.rows) {
    const k = normName(r.name)
    if (resByName.has(k)) ambiguous.add(k)
    else resByName.set(k, r.id)
  }
  const resBySourceId = new Map(rs.rows.map((r) => [String(r.source_id), r.id]))
  const staffByName = new Map()
  const staffAmb = new Set()
  for (const s of st.rows) {
    const k = normName(s.name)
    if (staffByName.has(k)) staffAmb.add(k)
    else staffByName.set(k, s.id)
  }

  /**
   * 名寄せ表のキーが**実在の入居者の氏名そのもの**とぶつかっていないか。
   * 例: 異体字の誤記を救うため {"吉田花子": "R07"} を入れた後に、本物の「吉田花子」さんが
   * 入居すると、その方の記録が全部 R07 のカルテに入る（取り違え）。
   * 名寄せ表は「マスタに居ない表記」を救うためのものなので、実在名との衝突は
   * 照合を止めて人に判断させる（2026-08-29 レビューで検出）。
   */
  const namemapConflicts = []
  for (const key of Object.keys(namemap.residents)) {
    const k = normName(key)
    if (resByName.has(k) || ambiguous.has(k)) namemapConflicts.push(key)
  }

  function matchResident(rawName) {
    const k = normName(rawName)
    if (!k) return { id: null, reason: 'empty' }
    // 衝突しているキーは名寄せ表を使わない。マスタ直接照合も曖昧なので取り込まない
    if (namemapConflicts.some((c) => normName(c) === k)) {
      return { id: null, reason: 'namemap_conflicts_real_resident' }
    }
    const mapped = namemap.residents[k] ?? namemap.residents[rawName]
    if (mapped != null) {
      // 名寄せ表の値は source_id か正確な氏名のどちらでもよい
      const viaSource = resBySourceId.get(String(mapped))
      if (viaSource != null) return { id: viaSource, reason: 'namemap' }
      const viaName = resByName.get(normName(mapped))
      if (viaName != null && !ambiguous.has(normName(mapped))) return { id: viaName, reason: 'namemap' }
      return { id: null, reason: 'namemap_broken' }
    }
    if (ambiguous.has(k)) return { id: null, reason: 'ambiguous' }
    const id = resByName.get(k)
    return id != null ? { id, reason: 'name' } : { id: null, reason: 'not_found' }
  }

  function matchStaff(rawName) {
    const k = normName(rawName)
    if (!k) return null
    const mapped = namemap.staff[k] ?? namemap.staff[rawName]
    if (mapped != null) {
      const id = staffByName.get(normName(mapped))
      return id ?? null
    }
    if (staffAmb.has(k)) return null
    return staffByName.get(k) ?? null
  }

  return {
    residentCount: rs.rows.length,
    staffCount: st.rows.length,
    matchResident,
    matchStaff,
    residents: rs.rows,
    staff: st.rows,
    namemapConflicts,
  }
}

// ---------------------------------------------------------------------
// 取込候補の組み立て
// ---------------------------------------------------------------------

/** events の1行 → notes の取込候補（区切り行番号 divider は日ごと。null=不明） */
function buildNoteCandidate(ev, divider, masters, out) {
  const key = KEY_EV + ev.key
  const body = String(ev.body ?? '').trim()
  if (body === '') return { key, outcome: 'invalid', reason: 'empty_body' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) return { key, outcome: 'invalid', reason: 'bad_date' }
  if (!['day', 'daycare', 'night'].includes(ev.shift)) return { key, outcome: 'invalid', reason: 'bad_shift' }

  let residentId = null
  if (ev.kind === 'resident') {
    const m = masters.matchResident(ev.name)
    if (m.id == null) {
      out.unmatchedNames.set(ev.name, (out.unmatchedNames.get(ev.name) ?? 0) + 1)
      return { key, outcome: 'unmatched', reason: m.reason }
    }
    residentId = m.id
  }

  let reporterId = null
  let reporterKnown = false
  if (ev.shift !== 'night' && String(ev.reporter ?? '').trim() !== '') {
    reporterId = masters.matchStaff(ev.reporter)
    reporterKnown = reporterId != null
    if (!reporterKnown) out.unmatchedReporters.set(ev.reporter, (out.unmatchedReporters.get(ev.reporter) ?? 0) + 1)
  }

  const after16Known = divider != null && ev.shift === 'day'
  const after16 = after16Known ? divider > 0 && Number(ev.row) > divider : false

  return {
    key,
    outcome: 'candidate',
    row: {
      import_key: key,
      note_on: ev.date,
      shift: ev.shift,
      facility: String(ev.facility ?? '') || null,
      category: String(ev.kind ?? '') || null,
      resident_id: residentId,
      body,
      occurred_at: validTime(ev.time),
      after16,
      after16_known: after16Known || ev.shift !== 'day', // 日勤以外は常に false 確定
      reporter_id: reporterId,
      reporter_known: reporterKnown,
    },
  }
}

/** measures.vitals の1行 → vitals の取込候補。全値空は候補にしない */
function buildVitalCandidate(v, masters, out) {
  const key = KEY_VT + `${v.date}|${normName(v.name)}`
  const vals = [v.temp, v.sysBP, v.diaBP, v.pulse, v.spo2]
  const flags = String(v.flags ?? '').trim()
  if (vals.every((x) => x == null) && flags === '') return { key, outcome: 'empty' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return { key, outcome: 'invalid', reason: 'bad_date' }
  const m = masters.matchResident(v.name)
  if (m.id == null) {
    out.unmatchedNames.set(v.name, (out.unmatchedNames.get(v.name) ?? 0) + 1)
    return { key, outcome: 'unmatched', reason: m.reason }
  }
  // ★DBの列の型に合わせて**こちら側で丸めてから**入れる。
  //   temp は numeric(3,1)・他は smallint なので、36.55 を渡すとDBが 36.6 に丸め、
  //   次回の比較で「36.6 ≠ 36.55」となって毎回 update が走り続ける
  //   （恒等式は updated を含むので破れず、報告は正常に見えるまま。2026-08-29 実測で検出）。
  const dec1 = (x, lo, hi) =>
    x == null || !(x >= lo && x <= hi) ? null : Math.round(x * 10) / 10
  const int = (x, lo, hi) => (x == null || !(x >= lo && x <= hi) ? null : Math.round(x))
  return {
    key,
    outcome: 'candidate',
    row: {
      import_key: key,
      resident_id: m.id,
      measured_on: v.date,
      kind: 'routine',
      temp: dec1(v.temp, 30, 45),
      sys_bp: int(v.sysBP, 40, 300),
      dia_bp: int(v.diaBP, 20, 200),
      pulse: int(v.pulse, 20, 250),
      spo2: int(v.spo2, 50, 100),
      raw_flags: flags !== '' ? { flags } : null,
    },
  }
}

/** measures.meals の1行 → meals の取込候補（食ごとに最大3件へ展開） */
function buildMealCandidates(mrow, masters, out) {
  const results = []
  const flags = String(mrow.flags ?? '').trim()
  const slots = [
    ['breakfast', mrow.bMain, mrow.bSide],
    ['lunch', mrow.lMain, mrow.lSide],
    ['dinner', mrow.dMain, mrow.dSide],
  ]
  const baseKey = KEY_ML + `${mrow.date}|${normName(mrow.name)}`
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mrow.date)) {
    // 日付が壊れた行は食に展開しない（1件の invalid として数える）
    return [{ key: baseKey, outcome: 'invalid', reason: 'bad_date' }]
  }
  const m = masters.matchResident(mrow.name)
  for (const [slot, main, side] of slots) {
    const key = `${baseKey}#${slot}`
    // 空の食は候補にしない（記録が無いだけで「食べていない」ではない）。
    // flags は行単位の情報なので、全食が空でも flags があれば朝の枠に写して1件残す
    if (main == null && side == null) {
      if (!(slot === 'breakfast' && flags !== '' && mrow.bMain == null && mrow.bSide == null
            && mrow.lMain == null && mrow.lSide == null && mrow.dMain == null && mrow.dSide == null)) {
        // ★key を付けて 'empty' で返す（continue で捨てない）。捨てると生存集合 mLive に
        //   この食の key が入らず、reconcileTombstones が「移行元から消えた行」と誤認して
        //   既存の記録に soft delete を付けてしまう。移行元では行は生きていて値が空に
        //   なっただけなので、これは安全装置4（空上書き禁止）違反にあたる。
        //   vitals の全空行が 'empty' で key を残しているのと同じ扱いに揃える
        //   （2026-08-29 レビューで検出。既存の値は据え置き＝空で上書きもしない）。
        results.push({ key, outcome: 'empty' })
        continue
      }
    }
    if (m.id == null) {
      out.unmatchedNames.set(mrow.name, (out.unmatchedNames.get(mrow.name) ?? 0) + 1)
      results.push({ key, outcome: 'unmatched', reason: m.reason })
      continue
    }
    // main_amount / side_amount は smallint。丸めてから入れる（vitals と同じ理由）
    const clamp = (x) => (x == null || !(x >= 0 && x <= 10) ? null : Math.round(x))
    results.push({
      key,
      outcome: 'candidate',
      row: {
        import_key: key,
        resident_id: m.id,
        meal_on: mrow.date,
        meal_slot: slot,
        main_amount: clamp(main),
        side_amount: clamp(side),
        raw_flags: flags !== '' ? { flags } : null,
      },
    })
  }
  return results
}

// ---------------------------------------------------------------------
// DB 書き込み（表ごとの差分適用）
// ---------------------------------------------------------------------

/** 既存行（import_key 一致）をまとめて引く */
async function selectExisting(db, table, cols, keys) {
  const found = new Map()
  for (let i = 0; i < keys.length; i += BATCH) {
    const chunk = keys.slice(i, i + BATCH)
    const r = await db.query(
      `select import_key, id, deleted_at, ${cols.join(', ')} from ${table} where import_key = any($1)`,
      [chunk],
    )
    for (const row of r.rows) found.set(row.import_key, row)
  }
  return found
}

/**
 * 数値として比べる列。numeric/bigint は node-postgres が文字列で返すため。
 * ★ここに載らない列は必ず文字列として比べる。以前は「数値に見えたら数値で比べる」と
 *   していたので、本文が数字だけの申し送り（電話番号メモ等）で '09012345678' と
 *   '9012345678'、'0' と '00' が同値と判定され、移行元の訂正が永久に反映されなかった
 *   （2026-08-29 レビューで検出）。
 */
const NUMERIC_COLS = new Set([
  'resident_id', 'reporter_id',
  'temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2',
  'main_amount', 'side_amount',
])

/** 値の比較。col を渡すと列ごとの型に沿って比べる（jsonb はJSONで比べる） */
function sameValue(a, b, col) {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b)
  if (col != null && NUMERIC_COLS.has(col)) {
    const na = Number(a)
    const nb = Number(b)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb
  }
  return String(a) === String(b)
}

/**
 * 1系列（notes/vitals/meals）の候補を DB へ差分適用する。
 * 戻り値は計数。execute=false なら SELECT だけ行い、書かずに同じ計数を出す。
 */
async function applyCandidates(db, opts) {
  const { table, candidates: rawCandidates, compareCols, insertCols, execute, nativeCheck, frameOf } = opts
  const counts = { inserted: 0, updated: 0, unchanged: 0, tomb_skip: 0, native_skip: 0, dup_skip: 0 }
  const keys = rawCandidates.map((c) => c.row.import_key)
  const existing = await selectExisting(db, table, compareCols, keys)

  /**
   * 同じ枠（利用者×日、食事は＋食）に候補が2件以上来たら1件に絞る。
   *
   * ★これが無いと窓ごと恒久的に取り込めなくなる（2026-08-29 レビューで検出）:
   *   移行元のキーは vitals=日付|氏名|タブ名、meals=日付|氏名|band で、
   *   居室移動日などに同一人が2タブ・2バンドへ載る（移行元の実データで発生実績あり）。
   *   こちらのキーはタブ/band を持たないため2候補が同じ枠を指し、
   *   素の INSERT が uq_vitals_routine_day / uq_meals_slot に当たって 23505 →
   *   窓ごと rollback。移行元は変わらないので再実行しても毎回同じ所で落ちる。
   *   氏名表記の訂正（旧キーの行が生きたまま新キーが増える）でも同じ形になる。
   *
   * 残す1件の選び方は「既に取り込んである行と同じキー」を最優先＝実行ごとに結果が
   * 揺れない（先勝ちだけだと移行元の行順で入れ替わり、毎回 update が走る）。
   */
  const candidates = []
  if (frameOf) {
    const byFrame = new Map()
    for (const c of rawCandidates) {
      const f = frameOf(c.row)
      if (!byFrame.has(f)) byFrame.set(f, [])
      byFrame.get(f).push(c)
    }
    for (const group of byFrame.values()) {
      if (group.length === 1) {
        candidates.push(group[0])
        continue
      }
      const live = group.find((c) => {
        const ex = existing.get(c.row.import_key)
        return ex != null && ex.deleted_at == null
      })
      const keep = live ?? group[0]
      candidates.push(keep)
      counts.dup_skip += group.length - 1
      for (const c of group) {
        if (c !== keep) opts.onDuplicate?.(keep.row.import_key, c.row.import_key)
      }
    }
  } else {
    candidates.push(...rawCandidates)
  }

  // アプリ入力（import_key null）が同じ枠を先に持っていないか（vitals/meals のみ）
  const nativeTaken = new Set()
  if (nativeCheck && candidates.length > 0) {
    const nat = await nativeCheck(db, candidates)
    for (const k of nat) nativeTaken.add(k)
  }

  const toInsert = []
  const toUpdate = []
  for (const c of candidates) {
    const ex = existing.get(c.row.import_key)
    if (!ex) {
      if (nativeTaken.has(c.row.import_key)) {
        counts.native_skip++
        continue
      }
      toInsert.push(c.row)
      counts.inserted++
      continue
    }
    if (ex.deleted_at != null) {
      counts.tomb_skip++ // こちらで消した行は復活させない（原則4の裏返し＝消した判断を尊重）
      continue
    }
    // 差分検出。after16 が不明な日（after16_known=false）は after16 を比較から外す
    const colsToCompare = compareCols.filter((col) => {
      if (col === 'after16' && c.row.after16_known === false) return false
      if (col === 'reporter_id' && c.row.reporter_known === false) return false
      return true
    })
    const diff = colsToCompare.filter((col) => !sameValue(ex[col], c.row[col], col))
    if (diff.length === 0) {
      counts.unchanged++
      continue
    }
    toUpdate.push({ id: ex.id, row: c.row, diff })
    counts.updated++
  }

  if (execute) {
    // INSERT（複数VALUES）。衝突は起きない前提（起きたら例外→窓ごと rollback）
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const chunk = toInsert.slice(i, i + BATCH)
      const params = []
      const rowsSql = chunk.map((row, ri) => {
        const ph = insertCols.map((col, ci) => {
          params.push(col === 'raw_flags' ? (row[col] == null ? null : JSON.stringify(row[col])) : row[col])
          return `$${ri * insertCols.length + ci + 1}`
        })
        return `(${ph.join(',')})`
      })
      await db.query(
        `insert into ${table} (${insertCols.join(',')}) values ${rowsSql.join(',')}`,
        params,
      )
    }
    // UPDATE（変わった列だけ。rev はトリガが上げる）
    for (const u of toUpdate) {
      const sets = []
      const params = []
      let n = 1
      for (const col of u.diff) {
        sets.push(`${col} = $${n++}`)
        params.push(col === 'raw_flags' ? (u.row[col] == null ? null : JSON.stringify(u.row[col])) : u.row[col])
      }
      params.push(u.id)
      await db.query(`update ${table} set ${sets.join(', ')} where id = $${n} and deleted_at is null`, params)
    }
  }
  return counts
}

/** vitals: 同じ（利用者×日×定時）をアプリ入力が先に持っていれば native_skip */
async function nativeCheckVitals(db, candidates) {
  const taken = new Set()
  for (let i = 0; i < candidates.length; i += BATCH) {
    const chunk = candidates.slice(i, i + BATCH)
    const r = await db.query(
      `select v.resident_id, v.measured_on
         from vitals v
         join unnest($1::bigint[], $2::date[]) as t(rid, mon)
           on v.resident_id = t.rid and v.measured_on = t.mon
        where v.kind = 'routine' and v.deleted_at is null and v.import_key is null`,
      [chunk.map((c) => c.row.resident_id), chunk.map((c) => c.row.measured_on)],
    )
    const hit = new Set(r.rows.map((x) => `${x.resident_id}|${x.measured_on}`))
    for (const c of chunk) {
      if (hit.has(`${c.row.resident_id}|${c.row.measured_on}`)) taken.add(c.row.import_key)
    }
  }
  return taken
}

/** meals: 同じ（利用者×日×食）をアプリ入力が先に持っていれば native_skip */
async function nativeCheckMeals(db, candidates) {
  const taken = new Set()
  for (let i = 0; i < candidates.length; i += BATCH) {
    const chunk = candidates.slice(i, i + BATCH)
    const r = await db.query(
      `select m.resident_id, m.meal_on, m.meal_slot
         from meals m
         join unnest($1::bigint[], $2::date[], $3::text[]) as t(rid, mon, slot)
           on m.resident_id = t.rid and m.meal_on = t.mon and m.meal_slot = t.slot
        where m.deleted_at is null and m.import_key is null`,
      [
        chunk.map((c) => c.row.resident_id),
        chunk.map((c) => c.row.meal_on),
        chunk.map((c) => c.row.meal_slot),
      ],
    )
    const hit = new Set(r.rows.map((x) => `${x.resident_id}|${x.meal_on}|${x.meal_slot}`))
    for (const c of chunk) {
      if (hit.has(`${c.row.resident_id}|${c.row.meal_on}|${c.row.meal_slot}`)) taken.add(c.row.import_key)
    }
  }
  return taken
}

/**
 * 移行元の削除への追従: 取込済みの日の取込行のうち、今回の応答に key が無いものへ
 * soft delete を付ける。恒等式の外。返り値は消した件数。
 */
async function reconcileTombstones(db, table, dateCol, prefix, day, liveKeys, execute, extraWhere = '') {
  const r = await db.query(
    `select id, import_key from ${table}
      where ${dateCol} = $1 and deleted_at is null and import_key like $2 ${extraWhere}`,
    [day, `${prefix}%`],
  )
  const gone = r.rows.filter((row) => !liveKeys.has(row.import_key))
  if (execute && gone.length > 0) {
    await db.query(`update ${table} set deleted_at = now() where id = any($1) and deleted_at is null`, [
      gone.map((g) => g.id),
    ])
  }
  return gone.length
}

// ---------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const GAS_URL = process.env.CARELOG_GAS_URL
  const GAS_TOKEN = process.env.CARELOG_GAS_TOKEN
  const DB_URL = process.env.SUPABASE_DB_URL
  for (const [k, v] of [['CARELOG_GAS_URL', GAS_URL], ['CARELOG_GAS_TOKEN', GAS_TOKEN], ['SUPABASE_DB_URL', DB_URL]]) {
    if (!v) {
      console.error(`環境変数 ${k} がありません。~/bin/care-log-import.sh 経由で実行してください。`)
      process.exit(2)
    }
  }
  const MODE = args.execute ? '書き込み（--execute）' : 'ドライラン（書き込みなし）'
  console.log(`care-log importer  モード: ${MODE}`)

  // --- サーバー版の確認（after16 が無い版に対しては動かさない） ---
  const ping = await gasGet(GAS_URL, GAS_TOKEN, 'ping', {})
  if (String(ping.ver ?? '') < REQUIRED_VER) {
    console.error(`集約GASの版が古すぎます（${ping.ver ?? '不明'} < ${REQUIRED_VER}）。デプロイを確認してください。`)
    process.exit(1)
  }
  console.log(`集約GAS: ver ${ping.ver} / 取込済み ${ping.ingestedDays} 日 / lastTick ${ping.lastTick || '不明'}`)

  const db = new Client({ connectionString: DB_URL, application_name: 'care-log-import' })
  try {
    await db.connect()
  } catch (e) {
    console.error(`DBに接続できません: ${e.message}`)
    console.error('  TLS で失敗する場合は接続文字列の末尾に ?sslmode=no-verify を付けて試してください。')
    process.exit(1)
  }

  const report = {
    startedAt: new Date().toISOString(),
    mode: args.execute ? 'execute' : 'dry-run',
    gasVer: ping.ver,
    windows: [],
    days: {}, // day -> { events: counts, measures: counts }
    unmatchedNames: new Map(),
    unmatchedReporters: new Map(),
    after16Unknown: [],
    reconciled: { notes: 0, vitals: 0, meals: 0 },
    emptyVitalsRows: 0,
    /** 同じ枠に移行元の行が2つ以上あって1件に絞った記録（移行元の掃除が要る合図） */
    duplicateFrames: [],
    /** 名寄せ表のキーが実在の入居者名とぶつかっている（取り違えの危険） */
    namemapConflicts: [],
    errors: [],
  }

  try {
    // --- マスタ ---
    const masters = await loadMasters(db)
    report.suggestResidents = masters.residents
    report.suggestStaff = masters.staff
    console.log(`マスタ: 利用者 ${masters.residentCount} 名 / 職員 ${masters.staffCount} 名`)
    report.namemapConflicts = masters.namemapConflicts
    if (masters.namemapConflicts.length > 0) {
      // 氏名は console に出さない（件数だけ。内訳は報告ファイル）
      console.error(
        `▲ 名寄せ表のキーが実在の入居者名と ${masters.namemapConflicts.length} 件ぶつかっています。` +
          '該当する氏名の記録は取り込みません（取り違えを避けるため）。報告ファイルを確認してください。',
      )
    }
    if (masters.residentCount === 0) {
      console.error('residents が空です。先にアプリの設定タブでマスタ同期を実行してください。')
      process.exit(1)
    }
    const synthetic = masters.residents.filter((r) => String(r.source_id).startsWith('SYN-')).length
    if (synthetic > 0 && args.execute && !args.allowSynthetic) {
      console.error(
        `residents に合成マスタ（SYN-）が ${synthetic} 名います。本番マスタと入れ替えてから実行してください` +
          '（検証環境で動かす場合のみ --allow-synthetic を付ける）。',
      )
      process.exit(1)
    }

    // --- 窓を新しい方から遡る ---
    const to0 = args.to ?? todayJst()
    let emptyStreak = 0
    let to = to0
    for (let w = 0; w < args.maxWindows; w++) {
      let from = addDaysYmd(to, -(WINDOW_DAYS - 1))
      if (args.from != null && from < args.from) from = args.from
      if (from > to) break

      console.log(`── 窓 ${w + 1}: ${from} 〜 ${to} ──`)
      const ev = await gasGet(GAS_URL, GAS_TOKEN, 'events', { from, to })
      const ms = await gasGet(GAS_URL, GAS_TOKEN, 'measures', { from, to })
      // API側の丸めで期間がずれていないか（ずれたら黙って進まず知らせて止める）
      for (const [name, r] of [['events', ev], ['measures', ms]]) {
        if (r.from !== from || r.to !== to) {
          throw new Error(`${name} の応答期間が要求とずれています（要求 ${from}〜${to} / 応答 ${r.from}〜${r.to}）`)
        }
      }

      const ingested = new Set(ev.ingestedDates ?? [])
      const vitalDates = new Set(ms.vitalDates ?? [])
      const mealDates = new Set(ms.mealDates ?? [])
      const windowInfo = {
        from,
        to,
        ingestedDays: ingested.size,
        events: (ev.events ?? []).length,
        vitals: (ms.vitals ?? []).length,
        meals: (ms.meals ?? []).length,
      }
      report.windows.push(windowInfo)
      console.log(
        `  取込済み ${ingested.size} 日 / events ${windowInfo.events} 件 / vitals ${windowInfo.vitals} 行 / meals ${windowInfo.meals} 行`,
      )

      if (ingested.size === 0 && vitalDates.size === 0 && mealDates.size === 0) {
        emptyStreak++
        if (args.from == null && emptyStreak >= EMPTY_WINDOWS_TO_STOP) {
          console.log(`  空の窓が ${emptyStreak} 回続いたため、ここで遡りを打ち切ります`)
          break
        }
      } else {
        emptyStreak = 0
      }

      // --- after16（この窓の中で day勤の申し送りがある日だけ） ---
      const dayShiftDays = [...new Set((ev.events ?? []).filter((e) => e.shift === 'day').map((e) => e.date))].sort()
      const dividers = new Map() // date -> 行番号（0=区切りなし） / 無いキー=不明
      if (dayShiftDays.length > 0) {
        let aFrom = dayShiftDays[0]
        const aTo = dayShiftDays[dayShiftDays.length - 1]
        while (aFrom <= aTo) {
          const chunkTo = addDaysYmd(aFrom, AFTER16_WINDOW - 1) < aTo ? addDaysYmd(aFrom, AFTER16_WINDOW - 1) : aTo
          const a16 = await gasGet(GAS_URL, GAS_TOKEN, 'after16', { from: aFrom, to: chunkTo })
          for (const d of a16.days ?? []) {
            if (d.ok) dividers.set(d.date, Number(d.dividerRow) || 0)
          }
          aFrom = addDaysYmd(String(a16.to ?? chunkTo), 1)
        }
      }
      for (const d of dayShiftDays) {
        if (!dividers.has(d)) report.after16Unknown.push(d)
      }

      // --- 日ごとに分類して1窓＝1トランザクションで適用 ---
      const evByDay = new Map()
      for (const e of ev.events ?? []) {
        if (!evByDay.has(e.date)) evByDay.set(e.date, [])
        evByDay.get(e.date).push(e)
      }
      const vtByDay = new Map()
      for (const v of ms.vitals ?? []) {
        if (!vtByDay.has(v.date)) vtByDay.set(v.date, [])
        vtByDay.get(v.date).push(v)
      }
      const mlByDay = new Map()
      for (const m of ms.meals ?? []) {
        if (!mlByDay.has(m.date)) mlByDay.set(m.date, [])
        mlByDay.get(m.date).push(m)
      }

      // ★窓が rollback した時に報告だけ進むのを防ぐための控え。
      //   窓の前半の日を処理して report に計上したあと後半で例外が出ると、DBは
      //   rollback で元に戻るのに report の「追加/更新/追従」は残り、報告書が
      //   実際のDBより多い数字を出す（取り込めていない日を取り込んだと読ませる）。
      //   2026-08-29 レビューで検出。
      const snapshot = {
        days: JSON.parse(JSON.stringify(report.days)),
        reconciled: { ...report.reconciled },
        duplicateFrames: report.duplicateFrames.length,
        unmatchedNames: new Map(report.unmatchedNames),
        unmatchedReporters: new Map(report.unmatchedReporters),
        emptyVitalsRows: report.emptyVitalsRows,
      }
      await db.query('begin')
      try {
        // === events → notes ===
        for (const day of [...ingested].sort()) {
          const evs = evByDay.get(day) ?? []
          const out = { unmatchedNames: report.unmatchedNames, unmatchedReporters: report.unmatchedReporters }
          const built = evs.map((e) => buildNoteCandidate(e, dividers.get(day) ?? null, masters, out))
          const candidates = built.filter((b) => b.outcome === 'candidate')
          const unmatched = built.filter((b) => b.outcome === 'unmatched').length
          const invalid = built.filter((b) => b.outcome === 'invalid').length
          // ★追従（墓標付け）を先に走らせる。あとにすると、移行元で行が入れ替わった時
          //   （キーが変わって新しい行として届く時）に、まだ生きている旧行が
          //   部分unique索引の枠を押さえたまま INSERT が走って 23505 になり、
          //   窓ごと落ちる（2026-08-29 レビューで検出）。
          //   生存集合はこの日の全 key（unmatched/invalid/empty も含む＝照合が壊れた時に消さない）
          const liveKeys = new Set(built.map((b) => b.key))
          report.reconciled.notes += await reconcileTombstones(db, 'notes', 'note_on', KEY_EV, day, liveKeys, args.execute)

          const c = await applyCandidates(db, {
            table: 'notes',
            candidates,
            compareCols: ['note_on', 'shift', 'facility', 'category', 'resident_id', 'body', 'occurred_at', 'after16', 'reporter_id'],
            insertCols: ['import_key', 'note_on', 'shift', 'facility', 'category', 'resident_id', 'body', 'occurred_at', 'after16', 'reporter_id'],
            execute: args.execute,
            nativeCheck: null,
          })

          const srcRows = built.length
          const skipped = c.unchanged + c.tomb_skip + invalid + c.dup_skip
          const idOk = srcRows === c.inserted + c.updated + skipped + c.native_skip + unmatched
          if (!idOk) throw new Error(`恒等式が破れました（events ${day}: src=${srcRows} ins=${c.inserted} upd=${c.updated} skip=${skipped} native=${c.native_skip} unm=${unmatched}）`)
          report.days[day] = report.days[day] ?? {}
          report.days[day].events = { srcRows, ...c, invalid, unmatched, skipped }
          if (args.execute) {
            await db.query(
              `insert into import_days (source, day, src_rows, inserted, updated, skipped, native_skip, unmatched)
               values ('events', $1, $2, $3, $4, $5, $6, $7)
               on conflict (source, day) do update set imported_at = now(),
                 src_rows = excluded.src_rows, inserted = excluded.inserted, updated = excluded.updated,
                 skipped = excluded.skipped, native_skip = excluded.native_skip, unmatched = excluded.unmatched`,
              [day, srcRows, c.inserted, c.updated, skipped, c.native_skip, unmatched],
            )
          }
        }

        // === measures → vitals + meals ===
        const measureDays = new Set([...vitalDates, ...mealDates])
        for (const day of [...measureDays].sort()) {
          const out = { unmatchedNames: report.unmatchedNames, unmatchedReporters: report.unmatchedReporters }
          const vBuilt = (vtByDay.get(day) ?? []).map((v) => buildVitalCandidate(v, masters, out))
          const mBuilt = (mlByDay.get(day) ?? []).flatMap((m) => buildMealCandidates(m, masters, out))
          report.emptyVitalsRows += vBuilt.filter((b) => b.outcome === 'empty').length

          const vCand = vBuilt.filter((b) => b.outcome === 'candidate')
          const mCand = mBuilt.filter((b) => b.outcome === 'candidate')
          const unmatched =
            vBuilt.filter((b) => b.outcome === 'unmatched').length +
            mBuilt.filter((b) => b.outcome === 'unmatched').length
          const invalid =
            vBuilt.filter((b) => b.outcome === 'invalid').length +
            mBuilt.filter((b) => b.outcome === 'invalid').length

          // 生存集合（unmatched/invalid/empty も key を持つ＝照合が壊れた時に消さない）。
          // 追従（墓標付け）は取込より**先**に走らせる（notes と同じ理由＝枠の解放）
          const vLive = new Set(vBuilt.map((b) => b.key))
          const mLive = new Set(mBuilt.map((b) => b.key))
          if (vitalDates.has(day)) {
            report.reconciled.vitals += await reconcileTombstones(db, 'vitals', 'measured_on', KEY_VT, day, vLive, args.execute, "and kind = 'routine'")
          }
          if (mealDates.has(day)) {
            report.reconciled.meals += await reconcileTombstones(db, 'meals', 'meal_on', KEY_ML, day, mLive, args.execute)
          }

          const onDup = (kept, dropped) =>
            report.duplicateFrames.push({ day, kept, dropped })
          const cv = await applyCandidates(db, {
            table: 'vitals',
            candidates: vCand,
            compareCols: ['resident_id', 'measured_on', 'kind', 'temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2', 'raw_flags'],
            insertCols: ['import_key', 'resident_id', 'measured_on', 'kind', 'temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2', 'raw_flags'],
            execute: args.execute,
            nativeCheck: nativeCheckVitals,
            // 部分unique索引 uq_vitals_routine_day が押さえている枠
            frameOf: (r) => `${r.resident_id}|${r.measured_on}`,
            onDuplicate: onDup,
          })
          const cm = await applyCandidates(db, {
            table: 'meals',
            candidates: mCand,
            compareCols: ['resident_id', 'meal_on', 'meal_slot', 'main_amount', 'side_amount', 'raw_flags'],
            insertCols: ['import_key', 'resident_id', 'meal_on', 'meal_slot', 'main_amount', 'side_amount', 'raw_flags'],
            execute: args.execute,
            nativeCheck: nativeCheckMeals,
            // 部分unique索引 uq_meals_slot が押さえている枠
            frameOf: (r) => `${r.resident_id}|${r.meal_on}|${r.meal_slot}`,
            onDuplicate: onDup,
          })

          const srcRows = vCand.length + mCand.length + unmatched + invalid
          const inserted = cv.inserted + cm.inserted
          const updated = cv.updated + cm.updated
          const skipped =
            cv.unchanged + cm.unchanged + cv.tomb_skip + cm.tomb_skip + invalid + cv.dup_skip + cm.dup_skip
          const nativeSkip = cv.native_skip + cm.native_skip
          const idOk = srcRows === inserted + updated + skipped + nativeSkip + unmatched
          if (!idOk) throw new Error(`恒等式が破れました（measures ${day}: src=${srcRows} ins=${inserted} upd=${updated} skip=${skipped} native=${nativeSkip} unm=${unmatched}）`)
          report.days[day] = report.days[day] ?? {}
          report.days[day].measures = { srcRows, inserted, updated, skipped, native_skip: nativeSkip, unmatched, vitals: cv, meals: cm }
          if (args.execute) {
            await db.query(
              `insert into import_days (source, day, src_rows, inserted, updated, skipped, native_skip, unmatched)
               values ('measures', $1, $2, $3, $4, $5, $6, $7)
               on conflict (source, day) do update set imported_at = now(),
                 src_rows = excluded.src_rows, inserted = excluded.inserted, updated = excluded.updated,
                 skipped = excluded.skipped, native_skip = excluded.native_skip, unmatched = excluded.unmatched`,
              [day, srcRows, inserted, updated, skipped, nativeSkip, unmatched],
            )
          }
        }

        if (args.execute) await db.query('commit')
        else await db.query('rollback') // ドライランは読みしかしていないが作法として明示
      } catch (e) {
        await db.query('rollback')
        // DBを巻き戻したので報告の計上も巻き戻す（報告とDBを食い違わせない）
        report.days = snapshot.days
        report.reconciled = snapshot.reconciled
        report.duplicateFrames.length = snapshot.duplicateFrames
        report.unmatchedNames = snapshot.unmatchedNames
        report.unmatchedReporters = snapshot.unmatchedReporters
        report.emptyVitalsRows = snapshot.emptyVitalsRows
        report.errors.push({ window: `${from}〜${to}`, error: String(e.message ?? e) })
        console.error(`  ▲ この窓は取り込みませんでした（rollback）: ${e.message}`)
      }

      // 次の窓へ（古い方向）
      if (args.from != null && from === args.from) break
      to = addDaysYmd(from, -1)
    }
  } finally {
    await db.end()
  }

  // --- 報告 ---
  const totals = { events: zero(), measures: zero() }
  function zero() {
    return { srcRows: 0, inserted: 0, updated: 0, skipped: 0, native_skip: 0, unmatched: 0 }
  }
  for (const d of Object.values(report.days)) {
    for (const src of ['events', 'measures']) {
      if (!d[src]) continue
      for (const k of Object.keys(totals[src])) totals[src][k] += d[src][k] ?? 0
    }
  }
  report.totals = totals
  report.finishedAt = new Date().toISOString()

  mkdirSync(args.reportDir, { recursive: true })
  const stamp = report.startedAt.replace(/[:.]/g, '-')
  const jsonPath = join(args.reportDir, `import-${stamp}.json`)
  const mdPath = join(args.reportDir, `import-${stamp}.md`)

  // ── 名寄せ表の下書き（照合できなかった氏名がある時だけ）──
  // ★氏名を含むのでリポジトリ外（報告フォルダ）にだけ書く。
  //   採用は人が決める＝そのままでは使わせず、確認用の一覧も一緒に出す。
  let namemapPath = null
  if (report.unmatchedNames.size > 0 && report.suggestResidents) {
    const sug = suggestNamemap(report.unmatchedNames, report.suggestResidents)
    report.namemapSuggestions = sug
    const draft = {}
    for (const s of sug) {
      if (s.kind === 'same_surname' || s.kind === 'variant') draft[s.raw] = s.candidates[0].id
    }
    if (report.suggestStaff && report.unmatchedReporters.size > 0) {
      report.staffSuggestions = suggestStaffNamemap(report.unmatchedReporters, report.suggestStaff)
    }
    namemapPath = join(args.reportDir, `namemap-draft-${stamp}.json`)
    writeFileSync(
      namemapPath,
      JSON.stringify(
        {
          _使い方:
            'この内容を確認し、正しいものだけ残して care-log の tools/import-namemap.json へ ' +
            '{"residents": { …ここの中身… }} の形で保存してください。値は利用者IDです。',
          _注意: '候補が複数あった氏名（ambiguous）と候補なし（none）はここに入れていません。報告の一覧を見て手で判断してください。',
          residents: draft,
          // 記入者（職員）は「記録側の表記 → 正しい職員氏名」で持つ。
          // 姓だけで職員1名に確定できたものだけを入れる（複数該当は人が判断する）
          staff: Object.fromEntries(
            (report.staffSuggestions ?? [])
              .filter((s) => s.kind === 'same_surname' || s.kind === 'variant')
              .map((s) => [s.raw, s.candidates[0].name]),
          ),
        },
        null,
        2,
      ),
    )
  }
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        ...report,
        unmatchedNames: Object.fromEntries(report.unmatchedNames),
        unmatchedReporters: Object.fromEntries(report.unmatchedReporters),
      },
      null,
      2,
    ),
  )
  writeFileSync(mdPath, renderMd(report, totals))
  console.log('')
  console.log(`── 合計（${report.mode}）──`)
  for (const src of ['events', 'measures']) {
    const t = totals[src]
    console.log(
      `  ${src}: 対象 ${t.srcRows} / 追加 ${t.inserted} / 更新 ${t.updated} / 変更なし等 ${t.skipped} / アプリ入力保護 ${t.native_skip} / 照合不能 ${t.unmatched}`,
    )
  }
  console.log(`  照合できなかった氏名: ${report.unmatchedNames.size} 種類（内訳は報告ファイル）`)
  if (report.duplicateFrames.length > 0) {
    console.log(`  同じ枠に移行元の行が重複: ${report.duplicateFrames.length} 件（1件に絞って取込済み）`)
  }
  if (report.namemapConflicts.length > 0) {
    console.log(`  ▲ 名寄せ表と実在氏名の衝突: ${report.namemapConflicts.length} 件（該当の記録は取り込んでいません）`)
  }
  console.log(`  16時区切りが取れなかった日: ${report.after16Unknown.length} 日`)
  console.log(`  移行元で消えた行への追従: notes ${report.reconciled.notes} / vitals ${report.reconciled.vitals} / meals ${report.reconciled.meals}`)
  if (report.errors.length > 0) {
    console.log(`  ▲ 取り込めなかった窓: ${report.errors.length} 件（報告ファイル参照）`)
  }
  console.log('')
  console.log(`報告: ${mdPath}`)
  if (namemapPath) console.log(`名寄せ表の下書き: ${namemapPath}`)
  process.exit(report.errors.length > 0 ? 1 : 0)
}

function renderMd(report, totals) {
  const L = []
  L.push(`# care-log 取込報告（${report.mode}）`)
  L.push('')
  L.push(`- 実行: ${report.startedAt} 〜 ${report.finishedAt}`)
  L.push(`- 集約GAS: ver ${report.gasVer}`)
  L.push('')
  L.push('## 合計')
  L.push('')
  L.push('| 系列 | 対象 | 追加 | 更新 | 変更なし等 | アプリ入力保護 | 照合不能 |')
  L.push('|---|---|---|---|---|---|---|')
  for (const src of ['events', 'measures']) {
    const t = totals[src]
    L.push(`| ${src} | ${t.srcRows} | ${t.inserted} | ${t.updated} | ${t.skipped} | ${t.native_skip} | ${t.unmatched} |`)
  }
  L.push('')
  if (report.unmatchedNames.size > 0) {
    L.push('## 照合できなかった氏名（対応候補つき）')
    L.push('')
    L.push('tools/import-namemap.json に {"residents": {"この氏名": "利用者ID"}} を書いて再実行すると取り込まれます。')
    L.push('同じフォルダの namemap-draft-*.json が下書きです（確定できたものだけ入っています）。')
    L.push('')
    L.push('| 記録側の氏名 | 件数 | 判定 | 対応候補（マスタ側） |')
    L.push('|---|---|---|---|')
    const KIND = {
      same_surname: '姓のみ→1名に確定',
      variant: '1〜2文字違い（異体字の可能性）',
      ambiguous: '候補が複数（要判断）',
      none: '候補なし（別人・人名でない可能性）',
    }
    const sug = report.namemapSuggestions ?? []
    if (sug.length > 0) {
      for (const s of sug) {
        const cands = s.candidates.map((c) => `${c.name}（${c.id}）`).join(' / ') || '—'
        L.push(`| ${s.raw} | ${s.count} | ${KIND[s.kind]} | ${cands} |`)
      }
    } else {
      for (const [name, n] of [...report.unmatchedNames].sort((a, b) => b[1] - a[1])) {
        L.push(`| ${name} | ${n} | — | — |`)
      }
    }
    L.push('')
  }
  if (report.unmatchedReporters.size > 0) {
    L.push('## 照合できなかった記入者（記録は取り込み済み・記入者欄だけ空）')
    L.push('')
    L.push('移行元の記入者欄は姓だけのことが多く、職員マスタのフルネームと一致しません。')
    L.push('tools/import-namemap.json の "staff" に {"記録側の表記": "正しい職員氏名"} を書いて再実行すると埋まります。')
    L.push('')
    const KINDS = {
      same_surname: '姓のみ→1名に確定',
      variant: '1文字違い',
      ambiguous: '候補が複数（要判断）',
      none: '候補なし',
    }
    const ss = report.staffSuggestions ?? []
    if (ss.length > 0) {
      L.push('| 記録側の表記 | 件数 | 判定 | 対応候補（職員マスタ） |')
      L.push('|---|---|---|---|')
      for (const s of ss) {
        const c = s.candidates.map((x) => `${x.name}${x.active ? '' : '（退職）'}`).join(' / ') || '—'
        L.push(`| ${s.raw} | ${s.count} | ${KINDS[s.kind]} | ${c} |`)
      }
    } else {
      for (const [name, n] of [...report.unmatchedReporters].sort((a, b) => b[1] - a[1])) {
        L.push(`- ${name} … ${n} 件`)
      }
    }
    L.push('')
  }
  if (report.namemapConflicts.length > 0) {
    L.push('## ▲ 名寄せ表が実在の入居者名とぶつかっています（要対応）')
    L.push('')
    L.push('この氏名の記録は**取り込んでいません**（別人のカルテに入る危険があるため）。')
    L.push('tools/import-namemap.json から該当キーを消し、移行元の表記そのものを直してください。')
    L.push('')
    for (const n of report.namemapConflicts) L.push(`- ${n}`)
    L.push('')
  }
  if (report.duplicateFrames.length > 0) {
    L.push('## 同じ枠に移行元の行が2つ以上あった（1件に絞って取り込み済み）')
    L.push('')
    L.push('居室移動でバイタルの別タブに二重に載った・氏名の表記を直して旧行が残った、等が原因です。')
    L.push('記録は失われていませんが、移行元（集約シート）の重複行を消しておくと次回から出なくなります。')
    L.push('')
    L.push('| 日 | 残した行 | 見送った行 |')
    L.push('|---|---|---|')
    for (const d of report.duplicateFrames.slice(0, 200)) {
      L.push(`| ${d.day} | ${d.kept} | ${d.dropped} |`)
    }
    if (report.duplicateFrames.length > 200) L.push(`| … | 他 ${report.duplicateFrames.length - 200} 件 | |`)
    L.push('')
  }
  if (report.after16Unknown.length > 0) {
    L.push('## 16時区切りが取れなかった日（日勤は全て「16時より前」扱いのまま）')
    L.push('')
    L.push(report.after16Unknown.join(', '))
    L.push('')
  }
  const rec = report.reconciled
  if (rec.notes + rec.vitals + rec.meals > 0) {
    L.push('## 移行元で消えた行への追従（soft delete を付けた件数）')
    L.push('')
    L.push(`notes ${rec.notes} / vitals ${rec.vitals} / meals ${rec.meals}`)
    L.push('')
  }
  if (report.errors.length > 0) {
    L.push('## 取り込めなかった窓（rollback 済み・再実行で取り直せる）')
    L.push('')
    for (const e of report.errors) L.push(`- ${e.window}: ${e.error}`)
    L.push('')
  }
  L.push('## 窓ごとの取得量')
  L.push('')
  L.push('| 期間 | 取込済み日数 | events | vitals | meals |')
  L.push('|---|---|---|---|---|')
  for (const w of report.windows) {
    L.push(`| ${w.from}〜${w.to} | ${w.ingestedDays} | ${w.events} | ${w.vitals} | ${w.meals} |`)
  }
  L.push('')
  return L.join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`失敗: ${e.message ?? e}`)
    process.exit(1)
  })
}

export { buildNoteCandidate, buildVitalCandidate, buildMealCandidates, normName, validTime, addDaysYmd }
