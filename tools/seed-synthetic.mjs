#!/usr/bin/env node
// =====================================================================
// care-log 合成テストデータ生成・投入
//   docs/design/qa-verification.md §1「合成データ生成（10年相当・実在氏名ゼロ）」の実装。
//
// 何をするか:
//   検証用 Supabase プロジェクトへ、10年相当（既定3650日）の合成記録を投入する。
//   実在の氏名・居室・記録本文は一切使わない（利用者01〜33／職員01〜14／本文は合成日本語）。
//
// 使い方（ターミナル。接続先は必ず「検証用」のプロジェクトにすること）:
//   SUPABASE_DB_URL='postgresql://ユーザー:パスワード@ホスト:5432/postgres?sslmode=require' \
//     npm run seed -- --days 3650
//   ・--days N … 生成する日数（既定 3650 ＝ 10年相当。1〜7300）
//   ・--help   … この使い方を表示
//   接続文字列は process.env からのみ読む（.env は読み込まない・コードにも書かない）。
//
// 安全策（dev-principles 原則4「データを消さない」）:
//   1. DELETE / TRUNCATE / UPDATE を一切実行しない。INSERT のみ。
//   2. 実データらしき行（SYN- 以外の利用者・職員01〜以外の職員）が1件でもあれば、
//      何も書かずに中止する（本番プロジェクトへの誤投入の防止）。
//   3. 30日ずつのトランザクションで投入し、投入済みの日は import_days（source='synthetic'）
//      で記録する。再実行すると投入済みの日を飛ばすので、途中で失敗しても続きから再開できる。
//   4. 合成の業務行は全て import_key に 'syn:' 接頭辞を持つ（unique 制約が二重投入を弾く）。
//
// 決定性:
//   固定シード（SEED）と「日付ごとの独立した乱数列」で生成するため、--days を変えても
//   同じ日付には同じデータが出る（再実行・部分再開でも内容が揃う）。
//
// import_days について:
//   投入した日は全日 import_days に行を作る（＝画面上は「取込済み」）。
//   「未取込」バッジの確認は、投入範囲より古い日付を表示すれば再現できる（行が無い日になる）。
//
// TLS について:
//   接続の TLS 設定は接続文字列（sslmode=…）だけで決める。このコードでは検証を緩めない。
//   pg 8.23 は sslmode=require を verify-full と同じ扱いにするため、証明書を検証できない
//   環境では接続に失敗する。その場合は sslmode=no-verify を使う（起動時に出る pg の
//   「SECURITY WARNING: The SSL modes … 」という注意書きは、この仕様変更予告であり投入結果には影響しない）。
//
// 未検証:
//   ・Supabase pooler の TLS 証明書がシステムCAで検証できるか（実接続で確認すること）
//   ・実測の投入所要時間（約240万行。回線とプランに依存する）
//
// しきい値（体温・血圧・脈・SpO2）の正本は src/lib/types.ts。
// .mjs から TypeScript を import できないため、本ファイルは同じ境界値を写しで持つ。
// types.ts を変更したときは、このファイルの THRESHOLD も合わせて直すこと。
// =====================================================================

import pg from 'pg'
import { pathToFileURL } from 'node:url'

const { Client } = pg

// ---------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------

const SEED = 20260827 // 固定シード（変えると全データが変わる）
const IMPORT_SOURCE = 'synthetic' // import_days.source（実importer の 'events' 等と混ざらない値）
const KEY_PREFIX = 'syn:' // 合成行の import_key 接頭辞
const TX_DAYS = 30 // 1トランザクションで投入する日数
const BATCH_ROWS = 5000 // 1 INSERT 文あたりの行数

// 規模（qa-verification.md §1 の目標行数を --days 3650 で再現する値）
//   notes 13万 / vitals 15万 / meals 37万 / fluid_intake 55万 / note_reads 130万 / outings 1万
//   ※ vitals の再検・経過観察は現行スプシ実測（0〜3件/日）より多い。
//     性能検証は重い側で測るため、目標行数（15万）に合わせて意図的に増やしている。
const SCALE = {
  residents: 33,
  staff: 14,
  routinePresent: 0.97, // 定時バイタルが記録される割合（残りは「空欄＝未測定」）
  // しきい値超過の混入率。qa-verification.md §1 の要求は「バイタル全体の約5%」なので、
  // 定時・再検・経過観察の3系列を合算して5%前後になる値にしてある（実測値は投入後に表示する）。
  alertRate: 0.045, // 定時バイタルに異常値を混ぜる割合
  recheckAlertRate: 0.25, // 再検で異常値が残る割合（多くは改善している）
  observationAlertRate: 0.03, // 経過観察で異常値が出る割合
  observationsPerDay: [4, 6], // 経過観察バイタルの件数/日
  fluidsPerDay: [135, 165], // 水分の記録件数/日
  notesPerShift: { day: [20, 26], daycare: [2, 4], night: [6, 10] },
  readersPerNote: [6, 14], // 既読を付ける職員数
  ongoingPerDay: [1, 3], // 継続（ピン留め）申し送りの件数/日
  snackPerDay: [1, 3], // 間食の記録件数/日
  mealPresent: 0.995, // 食事行が記録される割合
}

// しきい値（src/lib/types.ts の写し。判定の正本は types.ts 側）
const THRESHOLD = {
  temp: { dangerHigh: 38.1, warnHigh: 37.5, dangerLow: 35.5 },
  sysBp: { dangerHigh: 151, warnLow: 90 },
  diaBp: { dangerHigh: 91, warnLow: 50 },
  pulse: { dangerHigh: 101, warnLow: 40 },
  spo2: { dangerLow: 90, warnLow: 93 },
}

// 検索性能の検証で使う語（本文へ既知の分布で埋め込み、投入後に件数を報告する）
const SEARCH_TERMS = [
  '発熱', '受診', '転倒', '服薬', '便秘', '不穏', '入浴', '食事', '家族', '排泄',
  '点滴', '面会', '睡眠', '水分', '皮膚', '体重', '血圧', '誤嚥',
  'リハビリ', '経過観察', '訪問看護', '家族連絡', '服薬介助',
]

const ROLE_TAGS = ['介護', '看護', 'デイ', '厨房', 'ケアマネ', '事務']
const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner']
const FLUID_KINDS = ['茶', '水', '汁物', '牛乳', 'ジュース', '経口補水液', 'コーヒー']
const NOTE_CATEGORIES = ['申し送り', '連絡', '医療', 'ケア']
const FACILITY = '施設A' // 合成値（実在の施設名は書かない）
const COMPANIONS = ['家族', '職員同行', 'ボランティア', '単独']

// 利用者のかな（頭文字を散らして「かな絞込」を検証できるようにした合成値）
const KANA_HEADS = [
  'あ', 'い', 'う', 'え', 'お', 'か', 'き', 'く', 'け', 'こ', 'さ',
  'し', 'す', 'せ', 'そ', 'た', 'ち', 'つ', 'て', 'と', 'な', 'に',
  'ぬ', 'ね', 'の', 'は', 'ひ', 'ふ', 'へ', 'ほ', 'ま', 'み', 'む',
]
const CARE_LEVELS = ['要支援1', '要支援2', '要介護1', '要介護2', '要介護3', '要介護4', '要介護5']

// ---------------------------------------------------------------------
// 乱数（決定性のため日付・用途ごとに独立した列を作る）
// ---------------------------------------------------------------------

function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 用途と日付から乱数器を作る（同じ引数なら常に同じ列になる）
function rngFor(...parts) {
  return wrap(mulberry32((fnv1a(parts.join('|')) ^ SEED) >>> 0))
}

function wrap(next) {
  const api = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    dec1: (min, max) => Math.round((min + next() * (max - min)) * 10) / 10,
    // entries: [[値, 重み], ...]
    weighted: (entries) => {
      const total = entries.reduce((s, e) => s + e[1], 0)
      let x = next() * total
      for (const [value, weight] of entries) {
        x -= weight
        if (x < 0) return value
      }
      return entries[entries.length - 1][0]
    },
    // 重複なしで n 個取り出す
    sample: (arr, n) => {
      const pool = arr.slice()
      const out = []
      const take = Math.min(n, pool.length)
      for (let i = 0; i < take; i++) out.push(pool.splice(Math.floor(next() * pool.length), 1)[0])
      return out
    },
  }
  return api
}

// ---------------------------------------------------------------------
// 日付ユーティリティ（業務日付は JST。文字列 'YYYY-MM-DD' で扱う）
// ---------------------------------------------------------------------

function todayJst() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function dayOfWeek(ymd) {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay() // 0=日
}

function hhmm(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function tsJst(ymd, h, m) {
  return `${ymd}T${hhmm(h, m)}:00+09:00`
}

function comma(n) {
  return n.toLocaleString('en-US')
}

// ---------------------------------------------------------------------
// マスタ（実在氏名ゼロ）
// ---------------------------------------------------------------------

function buildResidents() {
  const out = []
  for (let i = 1; i <= SCALE.residents; i++) {
    const nn = String(i).padStart(2, '0')
    // 1階11名（101〜111）・2階22名（201〜222）＝現行スプシの人数構成に合わせた合成値
    const room = i <= 11 ? String(100 + i) : String(200 + (i - 11))
    out.push({
      source_id: `SYN-R${nn}`,
      name: `利用者${nn}`,
      kana: `${KANA_HEADS[i - 1]}${nn}`,
      room,
      gender: i % 3 === 0 ? '男' : '女',
      care_level: CARE_LEVELS[i % CARE_LEVELS.length],
      active: true,
      needs_review: false,
    })
  }
  return out
}

function buildStaff() {
  const out = []
  for (let i = 1; i <= SCALE.staff; i++) {
    out.push({ name: `職員${String(i).padStart(2, '0')}`, active: true })
  }
  return out
}

// ---------------------------------------------------------------------
// 申し送り本文（合成日本語 12〜480字・検索語を既知分布で埋め込む）
// ---------------------------------------------------------------------

// [重み, 文テンプレート群]。テンプレート内の {r} は「利用者NN様」に置換する
const TOPICS = [
  [12, ['{r}の食事量は主食8割・副食7割。', '食事中のむせ込みなく経過。食事形態の変更なし。', '{r}の食事介助を実施。全量摂取された。']],
  [8, ['{r}に発熱あり。クーリングと水分補給で対応。', '発熱は夕方には解熱。経過観察を継続する。', '発熱時の対応について看護と情報共有した。']],
  [8, ['水分摂取量が少ないため、こまめな声かけを継続。', '{r}の水分は日中で700ml。夜間の補給を促す。', '水分ゼリーを追加で提供した。']],
  [7, ['{r}の服薬確認済み。飲み残しなし。', '服薬介助時に嚥下状態を確認。問題なし。', '眠前の服薬を拒否されたため時間をずらして対応。']],
  [6, ['{r}の受診に同行。次回の受診は来月。', '受診結果は家族連絡済み。処方の変更なし。', '受診の予約を取り直した。']],
  [10, ['{r}の入浴を実施。皮膚状態に変化なし。', '入浴を拒否されたため清拭で対応。', '入浴前の血圧が低めのため、時間をずらして実施した。']],
  [6, ['排泄はトイレ誘導で対応。失禁なし。', '{r}の排泄パターンに変化なし。', '排泄介助時に軽度の発赤を確認。看護へ報告済み。']],
  [5, ['便秘傾向のため下剤の相談を看護へ。', '{r}は便秘が続いており、水分と運動を促している。', '便秘の解消を確認した。']],
  [4, ['夕方から不穏となり、居室で傾聴して落ち着かれた。', '{r}に不穏な様子。環境を調整して対応。', '不穏時の対応方法をチームで確認した。']],
  [6, ['夜間の睡眠は良好。中途覚醒なし。', '{r}は睡眠が浅く、朝方に離床された。', '睡眠状況を記録して経過観察とする。']],
  [5, ['家族連絡を実施。状況を説明し了承を得た。', '{r}のご家族から差し入れあり。', '家族へ受診結果を連絡した。']],
  [4, ['面会あり。居室で30分ほど過ごされた。', '{r}への面会は玄関ホールで対応。', '面会の予約について申し送る。']],
  [5, ['リハビリを実施。歩行状態に大きな変化なし。', '{r}はリハビリを意欲的に取り組まれた。', 'リハビリ中に軽度のふらつきあり。見守りを強化する。']],
  [3, ['{r}が居室内で転倒。外傷なくバイタル安定。', '転倒予防のため居室の動線を整理した。', '転倒時の状況を記録し、家族へ連絡済み。']],
  [3, ['皮膚の乾燥が強いため保湿を継続。', '{r}の皮膚に発赤あり。除圧を実施。', '皮膚状態を看護と共有した。']],
  [4, ['血圧が高めのため再検を実施。', '{r}の血圧は安定して推移している。', '血圧測定時に体調不良の訴えなし。']],
  [2, ['体重測定を実施。前月比で大きな変動なし。', '{r}の体重が減少傾向。食事内容を見直す。']],
  [2, ['点滴を実施。刺入部に異常なし。', '{r}の点滴中は付き添いで観察した。']],
  [3, ['訪問看護と情報共有を行った。', '訪問看護から処置内容の指示あり。記録に反映済み。']],
  [2, ['{r}に誤嚥のリスクあり。食事姿勢を調整した。', '誤嚥予防のため一口量を少なくして介助。']],
  [4, ['デイサービス利用中の様子は落ち着いていた。', '{r}はデイでの活動に参加された。']],
  [3, ['経過観察を継続。夜勤帯へ申し送る。', '{r}は経過観察中。変化があれば都度報告のこと。']],
]

// 本文の水増しに使う中立な文（検索語の分布を大きく崩さない内容にしている）
const FILLERS = [
  'バイタルは安定しており、特変は見られない。',
  '本人からの訴えは特になし。',
  '日中は臥床がちだが、声かけには反応良好。',
  '次のシフトでも同様の対応をお願いします。',
  '居室内での様子に大きな変化はない。',
  '状態が変われば都度記録に残すこと。',
  '本日の予定は変更なし。',
  '他職種と連携して対応を継続する。',
  '記録の内容はチームで共有済み。',
  '午後も引き続き見守りを行う。',
]

const OPENINGS = ['朝食後、', '日中、', '夕食時に、', '巡回時、', '起床時、', '午後の巡回で、', '就寝前に、', '']

function buildBody(rng, residentLabel) {
  const target = rng.weighted([
    [[12, 40], 18],
    [[40, 90], 34],
    [[90, 160], 28],
    [[160, 300], 15],
    [[300, 480], 5],
  ])
  const minLen = rng.int(target[0], target[1])

  const topic = rng.weighted(TOPICS.map((t) => [t[1], t[0]]))
  const replace = (s) => s.replaceAll('{r}', residentLabel ? `${residentLabel}様` : 'ご本人')

  let body = rng.pick(OPENINGS) + replace(rng.pick(topic))
  let guard = 0
  while (body.length < minLen && guard < 30) {
    guard++
    // 長い本文ほど話題が増えるように、追加分は話題と中立文を混ぜる
    if (rng.chance(0.45)) {
      const extra = rng.weighted(TOPICS.map((t) => [t[1], t[0]]))
      body += replace(rng.pick(extra))
    } else {
      body += rng.pick(FILLERS)
    }
  }
  if (body.length > 480) body = body.slice(0, 480)
  return body
}

// ---------------------------------------------------------------------
// 1日分の生成
// ---------------------------------------------------------------------

// 外出・外泊は「翌日の食事が欠食になるか」を判定するために前日分も参照する。
// そのため他の生成と独立した乱数列にして、日付だけから何度でも再現できるようにしている。
function generateOutings(day, residents, lastDay) {
  const rng = rngFor('outing', day)
  const count = rng.weighted([[0, 6], [1, 16], [2, 24], [3, 24], [4, 18], [5, 12]])
  const picked = rng.sample(residents, count)
  const isRecent = addDays(day, 3) > lastDay // 直近の日だけ「帰着未定」を作る
  return picked.map((r) => {
    const kind = rng.chance(0.15) ? 'overnight' : 'outing'
    const startAt = hhmm(rng.int(9, 13), rng.pick([0, 15, 30, 45]))
    let endOn = null
    let endAt = null
    if (kind === 'outing') {
      if (!(isRecent && rng.chance(0.25))) {
        endOn = day
        endAt = hhmm(rng.int(15, 18), rng.pick([0, 15, 30, 45]))
      }
    } else if (!(isRecent && rng.chance(0.35))) {
      endOn = addDays(day, rng.chance(0.75) ? 1 : 2)
      endAt = hhmm(rng.int(14, 17), rng.pick([0, 30]))
    }
    return {
      resident_id: r.id,
      kind,
      start_on: day,
      start_at: startAt,
      end_on: endOn,
      end_at: endAt,
      companion: rng.pick(COMPANIONS),
      note: rng.chance(0.15) ? '帰着時に体調確認を行うこと。' : null,
      recorded_by: null, // 呼び出し側で職員を割り当てる
      _kind: kind,
    }
  })
}

// その日「食事を提供しない」利用者×コマの集合を作る（表示の整合のためで、
// アプリ側で outings と meals を自動連動させる訳ではない＝db-design.md §7）
function awayKeys(day, residents, lastDay) {
  const away = new Set()
  for (const o of generateOutings(day, residents, lastDay)) {
    if (o._kind === 'outing') {
      away.add(`${o.resident_id}:lunch`)
    } else {
      away.add(`${o.resident_id}:lunch`)
      away.add(`${o.resident_id}:dinner`)
    }
  }
  const prev = addDays(day, -1)
  for (const o of generateOutings(prev, residents, lastDay)) {
    if (o._kind !== 'overnight') continue
    if (o.end_on === null || o.end_on >= day) {
      away.add(`${o.resident_id}:breakfast`)
      away.add(`${o.resident_id}:lunch`)
      if (o.end_on === null || o.end_on > day) away.add(`${o.resident_id}:dinner`)
    }
  }
  return away
}

function normalVital(rng) {
  return {
    temp: rng.dec1(36.0, 37.1),
    sys_bp: rng.int(102, 142),
    dia_bp: rng.int(58, 86),
    pulse: rng.int(56, 92),
    spo2: rng.int(95, 99),
  }
}

// しきい値超過を1〜2項目に混ぜる（値は DB の check 制約の範囲内に収める）
function applyAlert(rng, v) {
  const metrics = rng.sample(['temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2'], rng.chance(0.75) ? 1 : 2)
  for (const m of metrics) {
    if (m === 'temp') {
      v.temp = rng.chance(0.8)
        ? rng.dec1(THRESHOLD.temp.warnHigh, 39.6) // 注意〜危険の高値
        : rng.dec1(34.8, THRESHOLD.temp.dangerLow) // 低体温
    } else if (m === 'sys_bp') {
      v.sys_bp = rng.chance(0.7) ? rng.int(THRESHOLD.sysBp.dangerHigh, 194) : rng.int(76, THRESHOLD.sysBp.warnLow - 1)
    } else if (m === 'dia_bp') {
      v.dia_bp = rng.chance(0.7) ? rng.int(THRESHOLD.diaBp.dangerHigh, 118) : rng.int(38, THRESHOLD.diaBp.warnLow - 1)
    } else if (m === 'pulse') {
      v.pulse = rng.chance(0.75) ? rng.int(THRESHOLD.pulse.dangerHigh, 138) : rng.int(32, THRESHOLD.pulse.warnLow - 1)
    } else {
      v.spo2 = rng.chance(0.6) ? rng.int(THRESHOLD.spo2.dangerLow, THRESHOLD.spo2.warnLow - 1) : rng.int(84, THRESHOLD.spo2.dangerLow - 1)
    }
  }
  return v
}

function hasAlert(v) {
  if (v.temp != null && (v.temp >= THRESHOLD.temp.warnHigh || v.temp <= THRESHOLD.temp.dangerLow)) return true
  if (v.sys_bp != null && (v.sys_bp >= THRESHOLD.sysBp.dangerHigh || v.sys_bp < THRESHOLD.sysBp.warnLow)) return true
  if (v.dia_bp != null && (v.dia_bp >= THRESHOLD.diaBp.dangerHigh || v.dia_bp < THRESHOLD.diaBp.warnLow)) return true
  if (v.pulse != null && (v.pulse >= THRESHOLD.pulse.dangerHigh || v.pulse < THRESHOLD.pulse.warnLow)) return true
  if (v.spo2 != null && v.spo2 < THRESHOLD.spo2.warnLow) return true
  return false
}

function generateVitals(day, residents, staffIds) {
  const rng = rngFor('vitals', day)
  const rows = []
  const alerted = []

  for (const r of residents) {
    if (!rng.chance(SCALE.routinePresent)) continue // 空欄＝未測定
    const v = normalVital(rng)
    const isAlert = rng.chance(SCALE.alertRate)
    if (isAlert) applyAlert(rng, v)
    // 一部の項目は測定していない（null と 0 を混同しないための材料）
    if (!rng.chance(0.95)) v.pulse = null
    if (!rng.chance(0.9)) v.spo2 = null
    if (!rng.chance(0.92)) {
      v.sys_bp = null
      v.dia_bp = null
    }
    rows.push({
      resident_id: r.id,
      measured_on: day,
      kind: 'routine',
      measured_at: hhmm(rng.int(6, 7), rng.pick([0, 10, 20, 30, 40, 50])),
      ...v,
      note: null,
      import_key: `${KEY_PREFIX}v:${day}:${r.source_id}:routine`,
      recorded_by: rng.pick(staffIds),
    })
    if (isAlert && hasAlert(v)) alerted.push(r)
  }

  // 異常値の出た利用者は再検を実施（値は改善方向へ寄せる）
  let seq = 0
  for (const r of alerted) {
    const times = rng.chance(0.7) ? 1 : 2
    for (let i = 0; i < times; i++) {
      seq++
      const v = normalVital(rng)
      if (rng.chance(SCALE.recheckAlertRate)) applyAlert(rng, v)
      rows.push({
        resident_id: r.id,
        measured_on: day,
        kind: 'recheck',
        measured_at: hhmm(rng.int(10, 16), rng.pick([0, 15, 30, 45])),
        ...v,
        note: rng.chance(0.4) ? '再検を実施。看護へ報告済み。' : null,
        import_key: `${KEY_PREFIX}v:${day}:${r.source_id}:recheck${seq}`,
        recorded_by: rng.pick(staffIds),
      })
    }
  }

  // 経過観察（性能検証の行数を qa-verification §1 の目標に合わせるための枠）
  const obsCount = rng.int(SCALE.observationsPerDay[0], SCALE.observationsPerDay[1])
  const obsResidents = rng.sample(residents, obsCount)
  obsResidents.forEach((r, i) => {
    const v = normalVital(rng)
    if (rng.chance(SCALE.observationAlertRate)) applyAlert(rng, v)
    rows.push({
      resident_id: r.id,
      measured_on: day,
      kind: 'observation',
      measured_at: hhmm(rng.int(13, 20), rng.pick([0, 30])),
      ...v,
      note: null,
      import_key: `${KEY_PREFIX}v:${day}:${r.source_id}:obs${i + 1}`,
      recorded_by: rng.pick(staffIds),
    })
  })

  return rows
}

function generateMeals(day, residents, staffIds, away) {
  const rng = rngFor('meals', day)
  const rows = []

  for (const r of residents) {
    for (const slot of MEAL_SLOTS) {
      if (!rng.chance(SCALE.mealPresent)) continue // 記録漏れ（空欄）
      const isAway = away.has(`${r.id}:${slot}`)
      let status = 'eaten'
      let main = null
      let side = null
      if (isAway) {
        status = 'out'
      } else if (rng.chance(0.012)) {
        status = 'refused'
      } else if (rng.chance(0.008)) {
        status = 'hospital'
      } else {
        // 主食・副食は 0〜10。8〜10 が多く、1割弱が低摂取（主+副 ≦6）になるよう寄せる
        const low = rng.chance(0.09)
        main = low ? rng.int(0, 4) : rng.weighted([[10, 34], [9, 22], [8, 20], [7, 12], [6, 7], [5, 5]])
        side = low ? rng.int(0, 4) : rng.weighted([[10, 30], [9, 22], [8, 21], [7, 13], [6, 8], [5, 6]])
      }
      rows.push({
        resident_id: r.id,
        meal_on: day,
        meal_slot: slot,
        main_amount: main,
        side_amount: side,
        status,
        note: rng.chance(0.03) ? '刻み対応。むせ込みなし。' : null,
        import_key: `${KEY_PREFIX}m:${day}:${r.source_id}:${slot}`,
        recorded_by: rng.pick(staffIds),
      })
    }
  }

  // 間食（同一利用者につき1日1件まで＝部分unique の条件を満たす）
  const snackCount = rng.int(SCALE.snackPerDay[0], SCALE.snackPerDay[1])
  for (const r of rng.sample(residents, snackCount)) {
    rows.push({
      resident_id: r.id,
      meal_on: day,
      meal_slot: 'snack',
      main_amount: rng.int(5, 10),
      side_amount: null,
      status: 'eaten',
      note: null,
      import_key: `${KEY_PREFIX}m:${day}:${r.source_id}:snack`,
      recorded_by: rng.pick(staffIds),
    })
  }
  return rows
}

function generateFluids(day, residents, staffIds) {
  const rng = rngFor('fluids', day)
  const total = rng.int(SCALE.fluidsPerDay[0], SCALE.fluidsPerDay[1])
  const rows = []
  for (let i = 0; i < total; i++) {
    const r = rng.pick(residents)
    rows.push({
      resident_id: r.id,
      taken_on: day,
      taken_at: hhmm(rng.int(7, 20), rng.pick([0, 15, 30, 45])),
      amount_ml: rng.weighted([[100, 30], [150, 26], [200, 24], [250, 12], [300, 8]]),
      kind: rng.pick(FLUID_KINDS),
      recorded_by: rng.pick(staffIds),
    })
  }
  return rows
}

function generateNotes(day, residents, staffIds, lastDay) {
  const rng = rngFor('notes', day)
  const rows = []
  const isSunday = dayOfWeek(day) === 0
  const counts = {
    day: rng.int(SCALE.notesPerShift.day[0], SCALE.notesPerShift.day[1]),
    daycare: isSunday ? 0 : rng.int(SCALE.notesPerShift.daycare[0], SCALE.notesPerShift.daycare[1]),
    night: rng.int(SCALE.notesPerShift.night[0], SCALE.notesPerShift.night[1]),
  }
  const hours = { day: [8, 17], daycare: [9, 15], night: [17, 23] }

  let seq = 0
  for (const shift of ['day', 'daycare', 'night']) {
    for (let i = 0; i < counts[shift]; i++) {
      seq++
      const resident = rng.chance(0.8) ? rng.pick(residents) : null // 2割は全体連絡
      const label = resident && rng.chance(0.5) ? resident.name : null
      const body = buildBody(rng, label)
      const tagCount = rng.weighted([[0, 55], [1, 32], [2, 13]])
      rows.push({
        note_on: day,
        shift,
        facility: FACILITY,
        category: rng.pick(NOTE_CATEGORIES),
        resident_id: resident ? resident.id : null,
        role_tags: rng.sample(ROLE_TAGS, tagCount),
        importance: rng.weighted([['normal', 85], ['important', 12], ['critical', 3]]),
        body,
        occurred_at: hhmm(rng.int(hours[shift][0], hours[shift][1]), rng.pick([0, 5, 10, 20, 30, 40, 50])),
        ongoing: false,
        ended_at: null,
        // 夜勤には記入者欄が無い（移行元スプシの実態。null 許容の経路をここで再現する）
        reporter_id: shift === 'night' ? null : rng.pick(staffIds),
        import_key: `${KEY_PREFIX}n:${day}:${String(seq).padStart(3, '0')}`,
        _readers: rng.sample(staffIds, rng.int(SCALE.readersPerNote[0], SCALE.readersPerNote[1])),
        _readDay: rng.chance(0.7) ? day : addDays(day, 1),
        _readAt: [rng.int(8, 22), rng.pick([0, 15, 30, 45])],
      })
    }
  }

  // 継続（ピン留め）申し送り＝現行スプシの「※前シートからの再掲」手作業の置換
  const ongoingCount = rng.int(SCALE.ongoingPerDay[0], SCALE.ongoingPerDay[1])
  for (const n of rng.sample(rows, ongoingCount)) {
    n.ongoing = true
    const span = rng.int(2, 15)
    const endDay = addDays(day, span)
    // 直近の日はまだ継続中（ended_at = null）のものを残し、ピン留め表示を検証できるようにする
    const stillOpen = endDay > lastDay && rng.chance(0.5)
    n.ended_at = stillOpen ? null : tsJst(endDay > lastDay ? lastDay : endDay, 18, 0)
  }

  return rows
}

// ---------------------------------------------------------------------
// SQL（INSERT のみ。unnest でまとめて投入する＝パラメータ数を列数に抑える）
// ---------------------------------------------------------------------

const COLS = {
  residents: [
    { name: 'source_id', type: 'text' }, { name: 'name', type: 'text' }, { name: 'kana', type: 'text' },
    { name: 'room', type: 'text' }, { name: 'gender', type: 'text' }, { name: 'care_level', type: 'text' },
    { name: 'active', type: 'boolean' }, { name: 'needs_review', type: 'boolean' },
  ],
  staff: [{ name: 'name', type: 'text' }, { name: 'active', type: 'boolean' }],
  vitals: [
    { name: 'resident_id', type: 'bigint' }, { name: 'measured_on', type: 'date' }, { name: 'kind', type: 'text' },
    { name: 'measured_at', type: 'time' }, { name: 'temp', type: 'numeric' }, { name: 'sys_bp', type: 'int' },
    { name: 'dia_bp', type: 'int' }, { name: 'pulse', type: 'int' }, { name: 'spo2', type: 'int' },
    { name: 'note', type: 'text' }, { name: 'import_key', type: 'text' }, { name: 'recorded_by', type: 'bigint' },
  ],
  meals: [
    { name: 'resident_id', type: 'bigint' }, { name: 'meal_on', type: 'date' }, { name: 'meal_slot', type: 'text' },
    { name: 'main_amount', type: 'int' }, { name: 'side_amount', type: 'int' }, { name: 'status', type: 'text' },
    { name: 'note', type: 'text' }, { name: 'import_key', type: 'text' }, { name: 'recorded_by', type: 'bigint' },
  ],
  fluid_intake: [
    { name: 'resident_id', type: 'bigint' }, { name: 'taken_on', type: 'date' }, { name: 'taken_at', type: 'time' },
    { name: 'amount_ml', type: 'int' }, { name: 'kind', type: 'text' }, { name: 'recorded_by', type: 'bigint' },
  ],
  notes: [
    { name: 'note_on', type: 'date' }, { name: 'shift', type: 'text' }, { name: 'facility', type: 'text' },
    { name: 'category', type: 'text' }, { name: 'resident_id', type: 'bigint' },
    // text[] 列は「配列リテラル1個をtextとして渡し、行ごとに ::text[] へ戻す」形にする
    { name: 'role_tags', type: 'text', expr: 't."role_tags"::text[]' },
    { name: 'importance', type: 'text' }, { name: 'body', type: 'text' }, { name: 'occurred_at', type: 'time' },
    { name: 'ongoing', type: 'boolean' }, { name: 'ended_at', type: 'timestamptz' },
    { name: 'import_key', type: 'text' }, { name: 'reporter_id', type: 'bigint' },
  ],
  note_reads: [
    { name: 'note_id', type: 'bigint' }, { name: 'staff_id', type: 'bigint' }, { name: 'read_at', type: 'timestamptz' },
  ],
  outings: [
    { name: 'resident_id', type: 'bigint' }, { name: 'kind', type: 'text' }, { name: 'start_on', type: 'date' },
    { name: 'start_at', type: 'time' }, { name: 'end_on', type: 'date' }, { name: 'end_at', type: 'time' },
    { name: 'companion', type: 'text' }, { name: 'note', type: 'text' }, { name: 'recorded_by', type: 'bigint' },
  ],
  import_days: [
    { name: 'source', type: 'text' }, { name: 'day', type: 'date' }, { name: 'src_rows', type: 'int' },
    { name: 'inserted', type: 'int' }, { name: 'updated', type: 'int' }, { name: 'skipped', type: 'int' },
    { name: 'native_skip', type: 'int' }, { name: 'unmatched', type: 'int' },
  ],
}

// PostgreSQL の配列リテラルを組み立てる（role_tags 用）
function pgTextArray(items) {
  if (!items || items.length === 0) return '{}'
  const escaped = items.map((s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
  return `{${escaped.join(',')}}`
}

function buildInsertSql(table, cols, returning) {
  const names = cols.map((c) => `"${c.name}"`).join(', ')
  const params = cols.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ')
  const selects = cols.map((c) => c.expr || `t."${c.name}"`).join(', ')
  return `insert into "${table}" (${names}) select ${selects} from unnest(${params}) as t(${names})${
    returning ? ` returning ${returning}` : ''
  }`
}

async function insertRows(client, table, rows, returning) {
  if (rows.length === 0) return []
  const cols = COLS[table]
  const sql = buildInsertSql(table, cols, returning)
  const out = []
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const slice = rows.slice(i, i + BATCH_ROWS)
    const params = cols.map((c) => slice.map((row) => (row[c.name] === undefined ? null : row[c.name])))
    const res = await client.query(sql, params)
    if (returning) out.push(...res.rows)
  }
  return out
}

// ---------------------------------------------------------------------
// 事前チェック・マスタ準備
// ---------------------------------------------------------------------

async function assertSchema(client) {
  const res = await client.query(
    `select count(*)::int as n from information_schema.tables
      where table_schema = 'public'
        and table_name in ('residents','staff','vitals','meals','fluid_intake','notes','note_reads','outings','app_settings','import_days','master_sync_log')`
  )
  if (res.rows[0].n < 11) {
    throw new Error(
      'care-log のテーブルが揃っていません（見つかった表: ' + res.rows[0].n + '/11）。\n' +
        '  次にどうするか: 接続先が care-log の検証用プロジェクトか確認し、\n' +
        '  supabase/migrations/0001_init.sql → 0002_timeline_rpc.sql を SQL Editor で実行してから再実行してください。'
    )
  }
}

// 実データらしき行が1件でもあれば、何も書かずに中止する（本番への誤投入防止）
async function assertSyntheticOnly(client) {
  const res = await client.query(
    `select (select count(*)::int from residents where source_id not like 'SYN-%') as real_residents,
            (select count(*)::int from staff     where name      not like '職員%')  as real_staff`
  )
  const { real_residents: rr, real_staff: rs } = res.rows[0]
  if (rr > 0 || rs > 0) {
    throw new Error(
      `合成データ以外の利用者・職員が登録されています（利用者 ${rr}件 / 職員 ${rs}件）。\n` +
        '  このスクリプトは本番データのあるプロジェクトでは実行できません（何も書き込まずに終了しました）。\n' +
        '  次にどうするか: SUPABASE_DB_URL が検証用プロジェクトを指しているか確認してください。'
    )
  }
}

async function ensureMasters(client) {
  const wantResidents = buildResidents()
  const wantStaff = buildStaff()

  await client.query('begin')
  try {
    const existingR = await client.query('select id, source_id from residents where source_id like $1', ['SYN-%'])
    const haveR = new Map(existingR.rows.map((r) => [r.source_id, Number(r.id)]))
    const missingR = wantResidents.filter((r) => !haveR.has(r.source_id))
    const insertedR = await insertRows(client, 'residents', missingR, 'id, source_id')
    for (const row of insertedR) haveR.set(row.source_id, Number(row.id))

    const existingS = await client.query('select id, name from staff where name like $1', ['職員%'])
    const haveS = new Map(existingS.rows.map((r) => [r.name, Number(r.id)]))
    const missingS = wantStaff.filter((s) => !haveS.has(s.name))
    const insertedS = await insertRows(client, 'staff', missingS, 'id, name')
    for (const row of insertedS) haveS.set(row.name, Number(row.id))

    await client.query('commit')

    const residents = wantResidents.map((r) => ({ ...r, id: haveR.get(r.source_id) }))
    const staffIds = wantStaff.map((s) => haveS.get(s.name))
    return { residents, staffIds, addedResidents: missingR.length, addedStaff: missingS.length }
  } catch (e) {
    await client.query('rollback')
    throw e
  }
}

// ---------------------------------------------------------------------
// 投入本体
// ---------------------------------------------------------------------

async function seedChunk(client, days, residents, staffIds, lastDay, stats) {
  await client.query('begin')
  try {
    const all = { vitals: [], meals: [], fluid_intake: [], outings: [], notes: [], import_days: [] }

    for (const day of days) {
      const rngMisc = rngFor('misc', day)
      const away = awayKeys(day, residents, lastDay)
      const vitals = generateVitals(day, residents, staffIds)
      const meals = generateMeals(day, residents, staffIds, away)
      const fluids = generateFluids(day, residents, staffIds)
      const notes = generateNotes(day, residents, staffIds, lastDay)
      const outings = generateOutings(day, residents, lastDay).map((o) => ({
        ...o,
        recorded_by: rngMisc.pick(staffIds),
      }))

      const total = vitals.length + meals.length + fluids.length + notes.length + outings.length
      all.vitals.push(...vitals)
      all.meals.push(...meals)
      all.fluid_intake.push(...fluids)
      all.outings.push(...outings)
      all.notes.push(...notes)
      // 計数式: src_rows = inserted + updated + skipped + native_skip + unmatched
      all.import_days.push({
        source: IMPORT_SOURCE,
        day,
        src_rows: total,
        inserted: total,
        updated: 0,
        skipped: 0,
        native_skip: 0,
        unmatched: 0,
      })

      for (const v of vitals) if (hasAlert(v)) stats.alertVitals++
      for (const n of notes) {
        for (const term of SEARCH_TERMS) {
          if (n.body.includes(term)) stats.terms.set(term, (stats.terms.get(term) || 0) + 1)
        }
        stats.bodyChars += n.body.length
      }
    }

    await insertRows(client, 'vitals', all.vitals)
    await insertRows(client, 'meals', all.meals)
    await insertRows(client, 'fluid_intake', all.fluid_intake)
    await insertRows(client, 'outings', all.outings)

    // 申し送りは id を受け取ってから既読を作る（import_key で確実に突き合わせる）
    const noteRows = all.notes.map((n) => ({ ...n, role_tags: pgTextArray(n.role_tags) }))
    const returned = await insertRows(client, 'notes', noteRows, 'id, import_key')
    const idByKey = new Map(returned.map((r) => [r.import_key, Number(r.id)]))

    const reads = []
    for (const n of all.notes) {
      const noteId = idByKey.get(n.import_key)
      if (!noteId) continue // 取り違えを起こすくらいなら既読を作らない（安全側）
      for (const staffId of n._readers) {
        reads.push({ note_id: noteId, staff_id: staffId, read_at: tsJst(n._readDay, n._readAt[0], n._readAt[1]) })
      }
    }
    await insertRows(client, 'note_reads', reads)
    await insertRows(client, 'import_days', all.import_days)

    await client.query('commit')

    stats.vitals += all.vitals.length
    stats.meals += all.meals.length
    stats.fluids += all.fluid_intake.length
    stats.outings += all.outings.length
    stats.notes += all.notes.length
    stats.reads += reads.length
    stats.days += days.length
    return {
      vitals: all.vitals.length,
      meals: all.meals.length,
      fluids: all.fluid_intake.length,
      notes: all.notes.length,
      reads: reads.length,
      outings: all.outings.length,
    }
  } catch (e) {
    await client.query('rollback')
    throw e
  }
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

const USAGE = `care-log 合成テストデータ投入（実在氏名ゼロ・検証用）

  使い方（ターミナルに貼り付けて実行）:
    SUPABASE_DB_URL='postgresql://ユーザー:パスワード@ホスト:5432/postgres?sslmode=require' npm run seed -- --days 3650

  オプション:
    --days N   生成する日数（既定 3650 ＝ 10年相当。1〜7300）
    --help     この使い方を表示

  前提:
    ・接続先は「検証用」の Supabase プロジェクト。本番データがある接続先では中止する
    ・supabase/migrations/0001_init.sql と 0002_timeline_rpc.sql を先に適用しておく
    ・接続文字列は環境変数 SUPABASE_DB_URL からのみ読む（.env は読み込まない）
    ・投入するのは合成データのみ（利用者01〜33／職員01〜14／本文は合成日本語）
    ・既存行の削除・更新は行わない。投入済みの日は飛ばして再開できる`

function parseArgs(argv) {
  const opts = { days: 3650, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      opts.help = true
    } else if (a === '--days') {
      opts.days = Number(argv[++i])
    } else if (a.startsWith('--days=')) {
      opts.days = Number(a.slice('--days='.length))
    } else {
      throw new Error(`知らないオプションです: ${a}\n  次にどうするか: --help で使い方を確認してください。`)
    }
  }
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 7300) {
    throw new Error('--days は 1〜7300 の整数で指定してください（既定 3650）。')
  }
  return opts
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    console.error('')
    console.error(USAGE)
    process.exitCode = 1
    return
  }
  if (opts.help) {
    console.log(USAGE)
    return
  }

  const url = process.env.SUPABASE_DB_URL
  if (!url) {
    console.error('環境変数 SUPABASE_DB_URL が設定されていません（接続先が分からないため何もしていません）。')
    console.error('')
    console.error(USAGE)
    process.exitCode = 1
    return
  }

  const lastDay = todayJst()
  const firstDay = addDays(lastDay, -(opts.days - 1))
  const client = new Client({ connectionString: url, application_name: 'care-log-seed' })

  try {
    await client.connect()
  } catch (e) {
    console.error(`Supabase へ接続できませんでした: ${e.message}`)
    console.error('  次にどうするか: SUPABASE_DB_URL のホスト・パスワードを確認してください。')
    console.error('  TLS で失敗する場合は接続文字列の末尾を ?sslmode=require（それでも駄目なら ?sslmode=no-verify）にして試してください。')
    process.exitCode = 1
    return
  }

  const started = Date.now()
  const stats = {
    vitals: 0, meals: 0, fluids: 0, notes: 0, reads: 0, outings: 0,
    days: 0, alertVitals: 0, bodyChars: 0, terms: new Map(),
  }

  try {
    await assertSchema(client)
    await assertSyntheticOnly(client)

    const { residents, staffIds, addedResidents, addedStaff } = await ensureMasters(client)
    console.log(`マスタ: 利用者 ${residents.length}名（新規 ${addedResidents}）／職員 ${staffIds.length}名（新規 ${addedStaff}）`)

    // 投入済みの日（＝再実行時に飛ばす日）
    const done = await client.query(
      `select to_char(day, 'YYYY-MM-DD') as day from import_days
        where source = $1 and day between $2 and $3`,
      [IMPORT_SOURCE, firstDay, lastDay]
    )
    const skip = new Set(done.rows.map((r) => r.day))

    const targets = []
    for (let i = 0; i < opts.days; i++) {
      const day = addDays(firstDay, i)
      if (!skip.has(day)) targets.push(day)
    }

    console.log(`期間: ${firstDay} 〜 ${lastDay}（${comma(opts.days)}日）`)
    console.log(`投入対象: ${comma(targets.length)}日（投入済みで飛ばす日: ${comma(skip.size)}日）`)
    if (targets.length === 0) {
      console.log('この期間は投入済みです。何も書き込みませんでした。')
      return
    }

    const chunks = []
    for (let i = 0; i < targets.length; i += TX_DAYS) chunks.push(targets.slice(i, i + TX_DAYS))

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const r = await seedChunk(client, chunk, residents, staffIds, lastDay, stats)
      const pct = Math.round(((i + 1) / chunks.length) * 100)
      console.log(
        `[${String(i + 1).padStart(String(chunks.length).length)}/${chunks.length}] ${pct
          .toString()
          .padStart(3)}%  ${chunk[0]}〜${chunk[chunk.length - 1]}  ` +
          `申送 ${comma(r.notes)} / 既読 ${comma(r.reads)} / バイタル ${comma(r.vitals)} / ` +
          `食事 ${comma(r.meals)} / 水分 ${comma(r.fluids)} / 外出 ${comma(r.outings)}`
      )
    }

    const elapsed = Math.round((Date.now() - started) / 1000)
    const total = stats.notes + stats.reads + stats.vitals + stats.meals + stats.fluids + stats.outings + stats.days
    console.log('')
    console.log('── 投入結果 ───────────────────────────────')
    console.log(`  期間            ${firstDay} 〜 ${lastDay}（今回投入 ${comma(stats.days)}日・シード ${SEED}）`)
    console.log(`  利用者 / 職員   ${residents.length} / ${staffIds.length}（すべて合成値）`)
    console.log(`  notes           ${comma(stats.notes)}`)
    console.log(`  note_reads      ${comma(stats.reads)}`)
    console.log(`  vitals          ${comma(stats.vitals)}（うちしきい値超過 ${comma(stats.alertVitals)} = ${
      stats.vitals ? ((stats.alertVitals / stats.vitals) * 100).toFixed(1) : '0.0'
    }%）`)
    console.log(`  meals           ${comma(stats.meals)}`)
    console.log(`  fluid_intake    ${comma(stats.fluids)}`)
    console.log(`  outings         ${comma(stats.outings)}`)
    console.log(`  import_days     ${comma(stats.days)}`)
    console.log(`  合計            ${comma(total)} 行 / ${elapsed}秒`)
    console.log(`  申し送り本文    平均 ${stats.notes ? Math.round(stats.bodyChars / stats.notes) : 0}字`)
    console.log('')
    console.log('── 検索語の分布（この語を含む申し送りの件数）───')
    for (const term of SEARCH_TERMS) {
      const n = stats.terms.get(term) || 0
      const pct = stats.notes ? ((n / stats.notes) * 100).toFixed(1) : '0.0'
      console.log(`  ${term.padEnd(6, '　')} ${comma(n).padStart(9)} 件（${pct}%）`)
    }
    console.log('')
    console.log('※ 投入した日は import_days に行があるため画面では「取込済み」になる。')
    console.log('   「未取込」バッジは、この期間より前の日付を表示すると確認できる。')
  } catch (e) {
    console.error('')
    console.error(`投入を中止しました: ${e.message}`)
    // 途中まで投入できていた時だけ、再開できる旨を案内する（1件も書いていない時に出すと誤解を招く）
    if (stats.days > 0) {
      console.error(`  ${comma(stats.days)}日分はコミット済みでそのまま残っている（削除していない）。`)
      console.error('  同じコマンドを再実行すると、投入済みの日を飛ばして続きから再開する。')
    }
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

// 直接実行された時だけ投入を始める（import しただけでは DB に触らない＝生成ロジックを単体で確かめられる）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

// 検算用の公開（import しただけでは何も実行しない。DB を触る関数は client を引数で受け取る）
export {
  SCALE, SEED, SEARCH_TERMS, THRESHOLD, COLS,
  buildResidents, buildStaff, buildBody, buildInsertSql, pgTextArray, rngFor,
  generateVitals, generateMeals, generateFluids, generateNotes, generateOutings, awayKeys,
  hasAlert, addDays, todayJst, parseArgs,
  assertSchema, assertSyntheticOnly, ensureMasters, seedChunk,
}
