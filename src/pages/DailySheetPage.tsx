// 日報シート（現行スプレッドシート「申し送り」タブの再現・既定画面）。
// レイアウトの正本: docs/design/sheet-contracts.md §5 を上から順に実装する。
//   日付バー → ［1日ぶんの枠］ヘッダ（施設名・日勤/夜勤日報・出勤者1行・日付）→ 外出者 → 外泊者 →
//   発熱者 → 他症状者 → 日勤申し送り → 黒帯「↓16時以降の記録」→ デイサービス → 夜勤申し送り
//
// 2026-08-28 の追加指示（実物と見比べた管理者の指示。sheet-contracts.md §5 も更新済み）:
//   1) 日付はセルを押すと OS のカレンダーが開く（1〜31 の横並びボタンは撤去）
//   2) 既定は10日ごと表示（1〜10 / 11〜20 / 21〜月末）。1日ごとに太線で囲む
//   3) 別の日を選ぶと、10日表示のままその日へスクロールする（区切りをまたぐ日はその区切りを出す）
//   4) 「1日」表示を選んだ時だけ1日ぶんの表示になる（表示単位は端末ごとに記憶する）
//   5) 文字と余白を詰めてスプシの密度に寄せる（シートの中は --sheet-font で統一）
//   6) 施設長の右に出勤者が横1行（1行に15枠）
//   8) 申し送りのタイトル帯を実物の配色にする（sheet.css の --dsheet-c-*）
//   9) 付帯ブロックは常時表示（折りたたまない）
//  10) 「保存しました」は出さない。保存失敗・競合・未送信は残す
//
// 2026-08-28 の追加指示（第2次・管理者が実物と見比べて出したもの。CSS は sheet.css に用意済み）:
//  11) 付帯ブロック（外出者・外泊者・発熱者・他症状者）の空行は既定1行だけ。以降は「＋行」で足す
//  12) 日付セルは土曜＝濃い水色・日曜＝赤（.sheet-sat / .sheet-sun）。曜日は日付の文字
//      「(土)」「(日)」にも出るので、色は補助（色だけで意味を伝えない）
//  13) 日付ごとの枠の間に余白（sheet.css の .dsheet-day + .dsheet-day。この画面の追加作業は無し）
//  14) 日付セルはクリック・Enter・Space でカレンダーが開く（showPicker()。使えない環境では
//      従来どおりネイティブの日付入力として動く＝押せば入力・キーボードで日付を打てる）
//  15) 夜勤申し送りの記載内容は赤字の太字（.dsheet-night-body）
//  16) 1行おきに薄いグレーの縞（.sheet-alt）。しきい値の色・行の色（NoteColor）・土日の色を
//      持つセルはセル側が上に来る＝縞に負けない（縞は行の器、意味色はセル）
//
// 10日表示の取得（管理者指示「全件ロードしない」）:
//   fetchDailyReport は1日単位なので、日ごとに取りに行く。
//   ・同時に走らせるのは MAX_PARALLEL_LOADS 件まで（回線の細い現場で一斉に叩かない）
//   ・取得済みの日はこの画面が持つキャッシュから返す（区切りを行き来しても取り直さない）
//   ・自分が書き込んだ日はキャッシュを捨てる（編集前の内容を後から見せない）
//   ・失敗した日はその日の枠だけがエラー表示＋再試行になる（他の日は読めたまま＝部分表示）
//
// この画面の規律（contracts.md §共通規律 / sheet-contracts.md §8）:
//   - supabase へは触れず db.ts の関数だけを呼ぶ。個人情報を console・localStorage に出さない
//   - Tailwind は トークン由来クラスのみ。シートの寸法は sheet.css の CSS 変数を style で参照する
//   - 入力封鎖中（native_input_enabled=false）は編集不可＋理由文。閲覧・既読は可能
//   - 破壊的操作（行の削除・値の消去）は確認、出勤者の取り消しは Undo
//   - 3状態（ローディング／エラー／空）を持つ。読み取り経路から書き込まない（既読は明示操作のみ）
//   - 「＋行」は空行を足すだけ。本文（申し送り）や値（発熱者・他症状者）が入るまで保存しない
//
// 部品の前提（src/components/sheet.tsx・sheet-contracts.md §4 の署名どおりに呼ぶ）:
//   SheetFrame({children, className?}) / ZoomBar() /
//   SheetCell({value, onCommit?, align?, width?, level?, tone?, placeholder?, multiline?, ariaLabel}) /
//   ColorPicker({value, onChange, ariaLabel})
//   ※ CollapsibleBlock（0件で畳む）は 2026-08-28 の指示9で使わなくなった（付帯ブロックは常時表示）。
//     部品は他画面のために sheet.tsx に残してある（削除しない）。
//   ※ SheetCell が描画する要素の種類（td/div）に依存しないよう、表は div の行で組み、
//     各セルは幅を持つ入れ物で包んでから SheetCell を置く。

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  ConfirmDialog,
  ErrorBlock,
  LoadingBlock,
  ModalShell,
  ResidentPickerModal,
  SegmentPicker,
  StaffPickerModal,
  useToast,
} from '../components/ui'
// 行の色 → 背景色の対応は sheet.tsx の NOTE_COLOR_CLASS を唯一の正本として使う
// （見本＝ColorPicker の swatch と行の背景が食い違わないようにするため）
import {
  ColorPicker,
  NOTE_COLOR_CLASS,
  readSheetPref,
  SheetCell,
  SheetFrame,
  writeSheetPref,
  ZoomBar,
} from '../components/sheet'
import {
  DbError,
  fetchDailyReport,
  fetchResidents,
  fetchStaff,
  getNativeInputGate,
  insertNote,
  insertOuting,
  insertVitalKind,
  isQueuePersisted,
  markRead,
  saveAttendance,
  setOutingEnd,
  softDeleteNote,
  subscribeChanges,
  updateNoteFields,
  updateVital,
} from '../lib/db'
import type { DailyReport } from '../lib/db'
import { getActorId, touchActivity } from '../lib/actor'
import { addDays, fmtTimeHM, normalizeVitalInput, todayIso, toHalfWidth } from '../lib/format'
import {
  IMPORTANCE_LABEL,
  LS,
  NOTE_COLOR_LABEL,
  ROLE_TAGS,
  VITAL_RANGE,
  diaBpLevel,
  hasNoteAlias,
  noteDisplayName,
  pulseLevel,
  spo2Level,
  sysBpLevel,
  tempLevel,
} from '../lib/types'
import type {
  Attendance,
  Importance,
  Level,
  Note,
  NoteColor,
  Outing,
  OutingKind,
  Resident,
  Shift,
  Staff,
  Vital,
} from '../lib/types'

// ══════════════════════════════════════════════════════════════
// 定数・文言
// ══════════════════════════════════════════════════════════════

/** 入力封鎖中（切替日D前）の理由文。ui-design.md §0.5 の定型文をそのまま使う */
const BLOCKED_REASON = '現在はスプレッドシートで記録する期間です（アプリ入力の開始日は施設で決定します）'
/**
 * 入力できるかどうかを**観測できなかった**時（getNativeInputGate が observed:false）の理由文。
 * db.ts が MSG.gateUnknown と DbError('gate-unknown') でこの状態を封鎖中と区別しているので、
 * 画面側も分ける。混同すると、実際には解禁済みかもしれない期間に
 * 「スプレッドシートで記録する期間です」という誤った運用事実を職員に伝えることになる。
 * 画面上部のバナーと行の一言はこの1か所から配る（同じ画面で2つの理由が食い違わないように）。
 */
const GATE_UNKNOWN_REASON =
  '入力できるかどうかを確認できませんでした（通信エラー）。安全のため入力は止めています。電波状態を確認してから「最新に更新」を押してください。'

/**
 * 「他の端末で記録が更新されました」を出す対象の表（この画面が描画するものだけ）。
 * db.ts の REALTIME_TABLES には日報が描画しない meals / fluid_intake も含まれるため、
 * 表名で絞らないと他端末の食事・水分の記録（1日に数百件入る）のたびに案内が出て、
 * 申し送り・出勤者が本当に変わった時の合図として機能しなくなる。
 * 同型の実装は useTimeline.ts の WATCHED_TABLES。
 */
const WATCHED_TABLES = new Set(['notes', 'outings', 'vitals', 'attendance', 'note_reads'])

const ERR_LOAD =
  '日報を読み込めませんでした（通信エラー）。電波状態を確認してから、再試行してください。記録は消えていません'
const ERR_SAVE =
  '保存できませんでした（通信エラー）。電波状態を確認して、もう一度お試しください。入力は消えていません'
/**
 * 出勤者の保存に失敗した時の定型文。
 * この操作だけは失敗すると画面を保存前へ戻す（チップの並びを推測で残さない）ので、
 * 「入力は消えていません」とは書かず、選び直す行動まで書く。
 */
const ERR_SAVE_ATTENDANCE =
  '出勤者を保存できませんでした（通信エラー）。画面は保存前の状態に戻しました。電波状態を確認してから、もう一度選び直してください'
const ERR_CONFLICT =
  '他の端末で先に更新されました。入力は消えていません。「最新に更新」を押して内容を確認してから、もう一度お試しください'
const ERR_EMPTY_BODY = '本文は空にできません。行ごと消す場合は「詳細」から削除してください'
const ERR_NO_ACTOR = '記録する職員が選ばれていません。設定タブの「記録する職員」から選んでください'
const MSG_QUEUED = '⚠ 未送信（電波が戻ると自動で送信します）'
const MSG_NOT_PERSISTED =
  '▲ 送信待ちにしましたが端末に控えを残せませんでした。この画面を閉じずに電波の回復をお待ちください'
/**
 * 保存が成功した行の一言（旧 MSG_SAVED「✓ 保存しました」）は**出さない**（2026-08-28 指示10）。
 * 1行ごとに出すと行間が空いて実物の密度にならないため。
 * 代わりに、成功した時点でその行に残っている失敗・競合の一言を消す（saveOk）。
 * **失敗・競合・未送信は今までどおり出す**（記録が消えたと誤解させないため）。
 */
/** 応答を待つ間に日付を送った時。保存はできているが、今開いている日の記録ではない */
const MSG_SAVED_OTHER_DAY = '保存しました（表示中の日付が変わったため、この画面には出していません）'
/**
 * 応答待ちの行に、重ねて確定が来た時の案内。
 * 同じ行から2回 insert すると同じ内容の行が2本できるため受け付けないが、
 * 黙って捨てると「入力したのに消えた」になるので、必ず理由と次の行動を出す。
 */
const MSG_BUSY = '▲ 前の保存の応答を待っています。数秒後にもう一度お試しください（入力は消えていません）'
const MSG_BUSY_VITAL =
  '▲ 前の保存の応答を待っています。数秒待ってから、この欄をもう一度入力してください（先に確定した値は保存中です）'
/** 値が1つも無い行は作らない（空の観察・症状の行を記録に残さない） */
const MSG_EMPTY_VITAL =
  '▲ 値が入っていないため保存していません。時刻・体温・SpO2・血圧・脈・症状のいずれかを入力してください'
/**
 * 送信待ちに退避済み（locked）の行は取り消せない。
 * 画面から消しても退避した登録は残っていて、電波が戻ると同じ内容が登録される＝
 * 「取り消したのに後から出てくる」を作らないため（消去は保全ゲートの後ろ）。
 */
const MSG_LOCKED_DELETE = '送信待ちのため取り消せません。送信が終わってから、行の削除をしてください'
/**
 * ピッカーで選んだのに、その行が画面から無くなっていた時の案内。
 * 黙って捨てると「対象を選んだのに空欄のまま」になるため、理由と次の行動を必ず出す。
 */
const MSG_PICK_LOST =
  '▲ 保存が完了したため選択を反映できませんでした。行の対象／記入者をもう一度選んでください'

/** 3セット並べる発熱者ブロックの1行あたりの枠数（現行スプシの実測） */
const FEVER_SETS = 3

/**
 * 血圧セルの幅。この画面は上下を1つのセルに「151/91」とまとめて出すため、
 * バイタル一覧の血圧2列分（--w-sys ＋ --w-dia）を確保する。
 * 1列分（60px）ではしきい値の記号（↑↑ ↓↓）まで入らず truncate に食われる＝
 * 色だけで意味を伝えることになるため（sheet-contracts.md §8-8）。
 */
const W_BP = 'calc(var(--w-sys) + var(--w-dia))'

/** 発熱者の1セット（時 KT SpO2 BP P）の幅。時と脈は同じ --w-pulse を使う */
const W_FEVER_SET = `calc(var(--w-pulse) * 2 + var(--w-temp) + var(--w-spo2) + ${W_BP})`
/**
 * シート（器）の最小幅。いちばん列の多い発熱者ブロック（ブロック名＋氏名＋3セット）の固定列の合計に、
 * 1日ぶんの太線枠（--sheet-rule-bold × 2）を足した値。
 * **器の幅をこの確定値と画面幅だけで決める**ことで、幅の計算に中身の文字の長さが入らなくなる＝
 * 申し送りの長文でシート全体が横に伸びず、伸びるのは行の高さだけになる
 * （sheet-contracts.md §5「長文は行が伸びる（clamp しない）」）。
 */
const SHEET_MIN_W = `calc(var(--w-block) + var(--w-name) + ${W_FEVER_SET} * ${FEVER_SETS} + var(--sheet-rule-bold) * 2)`

/**
 * ブロックごとに最初から出しておく空の入力行の数。
 * 2026-08-28 の追加指示11で **すべて1行**にした（旧: 外出4・外泊2・発熱4・他症状4）。
 * 足りない時はブロック見出しの「＋行」で増やす。
 * 保存済みの行と「＋行」で足した行を合わせてこの数に満たなければ、空行で埋める
 * ＝保存済みの行がある日は空行を出さず、「＋行」を押した時だけ入力欄が増える。
 * 空行は値が入るまで保存しない（空データを作らない）ので、記録は増えない。
 */
const MIN_ROWS = { outing: 1, overnight: 1, fever: 1, symptom: 1, note: 1 } as const

/** 10日表示の区切り（1〜10 / 11〜20 / 21〜月末。月末が31日なら 21〜31） */
const BLOCK_STARTS = [1, 11, 21] as const

/** 同時に走らせる日報取得の上限（回線の細い現場で10日ぶんを一斉に叩かない） */
const MAX_PARALLEL_LOADS = 3
/** 画面が保持する取得済みの日の上限（1か月ぶん。超えたら古い順に捨てる） */
const MAX_CACHE_DAYS = 31

/** 表示単位（10日ごと / 1日ごと）。既定は10日（2026-08-28 指示2・4） */
type SheetUnit = '10' | '1'
const UNIT_VALUES: readonly SheetUnit[] = ['10', '1']
const DEFAULT_UNIT: SheetUnit = '10'

const VITAL_FIELD_LABEL: Record<'temp' | 'sys_bp' | 'dia_bp' | 'pulse' | 'spo2', string> = {
  temp: '体温',
  sys_bp: '血圧（上）',
  dia_bp: '血圧（下）',
  pulse: '脈拍',
  spo2: 'SpO2',
}

/**
 * セル内ボタン（対象・記入者・詳細・登録）の当たり判定。
 * 拡張量の判断は sheet.css の .sheet-hit（--sheet-hit-pad）に預ける＝共通部品 SheetCell と同じ。
 * この画面の行は .sheet-dense の中にあるので**拡張量は常に 0px**になる：申し送りの行は縦に連続していて、
 * 上下へ広げると隣の行とヒットが重なり「1つ下の行の編集・詳細が開く」＝記録の取り違えになるため
 * （sheet.css 冒頭の裁定3）。押しやすさは ZoomBar（125/150%）と aria-label で担保する。
 */
const CELL_HIT = 'sheet-hit'

/**
 * 行の中に置くボタンの高さ。
 * tokens.css の `:where(button,…){min-height:44px}` をそのままにすると、
 * 23px の申し送り行がボタン1つで 45px に広がり、スプシの密度が再現できない
 * （当たり判定は行の見た目を変えずに ::before で下方向へ広げる。詰まった行で 44px に届かない分は
 *  表示倍率 200% を選べば行高 44px になる＝ZOOM_STEPS の注記のとおり）。
 */
const ROW_BTN_STYLE: CSSProperties = { minHeight: 'var(--sheet-row-h-note)' }

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 参照の同一性を保つための空配列 */
const NO_RESIDENTS: Resident[] = []
const NO_STAFF: Staff[] = []

// ══════════════════════════════════════════════════════════════
// 小さなヘルパ（純関数）
// ══════════════════════════════════════════════════════════════

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 端末ローカルの現在時刻 HH:MM（既存の記録画面と同じ扱い） */
function nowHM(): string {
  const d = new Date()
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 利用者の表示名。マスタ未取得時も氏名を作らず ID 表記に落とす */
function residentName(r: Resident | undefined, id: number | null): string {
  if (r) return r.name
  return id == null ? '' : `利用者ID ${id}`
}

/**
 * 申し送りの対象の表示名（2026-09-01 指示）。
 * 「申し送りでの表示名」が設定されていればそれ、無ければマスタの氏名。
 * ★同じ画面でも申し送り以外（外出者・外泊者・発熱者・他症状者）は residentName のまま
 *   ＝マスタの氏名を出す。効かせる範囲を広げない。
 */
function noteTargetName(r: Resident | undefined, id: number | null): string {
  if (r) return noteDisplayName(r)
  return id == null ? '' : `利用者ID ${id}`
}

function staffName(s: Staff | undefined, id: number | null): string {
  if (s) return s.name
  return id == null ? '' : `職員ID ${id}`
}

/** 居室の数値順（数字が無い部屋は末尾）。VitalsGridPage と同じ並び方 */
function cmpResident(a: Resident, b: Resident): number {
  const na = Number((a.room ?? '').replace(/[^0-9]/g, ''))
  const nb = Number((b.room ?? '').replace(/[^0-9]/g, ''))
  const va = Number.isFinite(na) && (a.room ?? '') !== '' ? na : Number.MAX_SAFE_INTEGER
  const vb = Number.isFinite(nb) && (b.room ?? '') !== '' ? nb : Number.MAX_SAFE_INTEGER
  if (va !== vb) return va - vb
  return a.id - b.id
}

function outOfRange(field: keyof typeof VITAL_RANGE, v: number): boolean {
  const [lo, hi] = VITAL_RANGE[field]
  return v < lo || v > hi
}

/**
 * 書式・範囲のエラー文。**保存済みの行では打った文字が残らない**（セルはサーバーの値へ戻る）ので、
 * 「入力は消えていません」とは書かず、入れ直す行動まで書く（下書き行では入力は残る）。
 */
function rangeMsg(field: keyof typeof VITAL_RANGE): string {
  const [lo, hi] = VITAL_RANGE[field]
  return `▲ ${VITAL_FIELD_LABEL[field]}は ${lo}〜${hi} の範囲で入力してください（保存していません。もう一度入力してください）`
}

type NumResult = { ok: true; value: number | null } | { ok: false; message: string }

/** 数値セルの入力を正規化する。空文字は「消す」意思として null を返す */
function parseNum(raw: string, field: keyof typeof VITAL_RANGE): NumResult {
  const s = toHalfWidth(raw)
  if (s === '') return { ok: true, value: null }
  const v = normalizeVitalInput(s, field)
  if (v === null) {
    return {
      ok: false,
      message: `▲ ${VITAL_FIELD_LABEL[field]}は数字で入力してください（保存していません。もう一度入力してください）`,
    }
  }
  if (outOfRange(field, v)) return { ok: false, message: rangeMsg(field) }
  return { ok: true, value: v }
}

type BpResult = { ok: true; sys: number | null; dia: number | null } | { ok: false; message: string }

/** 「120/80」形式の血圧セル。片方だけの入力も受ける */
function parseBp(raw: string): BpResult {
  const s = toHalfWidth(raw).replace(/／/g, '/')
  if (s === '') return { ok: true, sys: null, dia: null }
  const parts = s.split('/')
  const sysRes = parseNum(parts[0] ?? '', 'sys_bp')
  if (!sysRes.ok) return { ok: false, message: sysRes.message }
  const diaRes = parseNum(parts[1] ?? '', 'dia_bp')
  if (!diaRes.ok) return { ok: false, message: diaRes.message }
  if (sysRes.value === null && diaRes.value === null) {
    return {
      ok: false,
      message: '▲ 血圧は「120/80」のように入力してください（保存していません。もう一度入力してください）',
    }
  }
  return { ok: true, sys: sysRes.value, dia: diaRes.value }
}

function fmtBp(sys: number | null, dia: number | null): string {
  if (sys == null && dia == null) return ''
  return `${sys ?? ''}/${dia ?? ''}`.replace(/\/$/, '')
}

type TimeResult = { ok: true; value: string | null } | { ok: false; message: string }

/** 「9:30」「0930」「9」→ 'HH:MM'。空文字は null（未記入） */
function parseHM(raw: string): TimeResult {
  const s = toHalfWidth(raw).replace(/[:：]/g, ':')
  if (s === '') return { ok: true, value: null }
  const m = /^(\d{1,2}):?(\d{2})?$/.exec(s)
  if (!m) {
    return {
      ok: false,
      message: '▲ 時刻は「9:30」のように入力してください（保存していません。もう一度入力してください）',
    }
  }
  const h = Number(m[1])
  const mi = m[2] === undefined ? 0 : Number(m[2])
  if (h > 23 || mi > 59) {
    return {
      ok: false,
      message: '▲ 時刻は 0:00〜23:59 で入力してください（保存していません。もう一度入力してください）',
    }
  }
  return { ok: true, value: `${pad2(h)}:${pad2(mi)}` }
}

type DayTimeResult = { ok: true; on: string | null; at: string | null } | { ok: false; message: string }

/** 「8/30 10:30」「10:30」→ 日付＋時刻。日付が無ければ基準日を使う */
function parseDayTime(raw: string, baseIso: string): DayTimeResult {
  const s = toHalfWidth(raw).replace(/[:：]/g, ':').replace(/\s+/g, ' ').trim()
  if (s === '') return { ok: true, on: null, at: null }
  const parts = s.split(' ')
  const first = parts[0] ?? ''
  if (first.includes('/')) {
    const md = /^(\d{1,2})\/(\d{1,2})$/.exec(first)
    if (!md) return { ok: false, message: '▲ 日時は「8/30 10:30」のように入力してください' }
    const year = Number(baseIso.slice(0, 4))
    const mm = Number(md[1])
    const dd = Number(md[2])
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
      return { ok: false, message: '▲ 日付が正しくありません。「8/30 10:30」のように入力してください' }
    }
    const time = parseHM(parts[1] ?? '')
    if (!time.ok) return { ok: false, message: time.message }
    return { ok: true, on: `${year}-${pad2(mm)}-${pad2(dd)}`, at: time.value }
  }
  const time = parseHM(first)
  if (!time.ok) return { ok: false, message: time.message }
  return { ok: true, on: baseIso, at: time.value }
}

/** 到着（日付＋時刻）の表示。基準日と同じ日なら時刻だけにする（スプシと同じ見せ方） */
function fmtDayTime(on: string | null, at: string | null, baseIso: string): string {
  if (on == null && at == null) return ''
  const time = fmtTimeHM(at)
  if (on == null || on === baseIso) return time
  const [, m, d] = on.split('-')
  return `${Number(m)}/${Number(d)} ${time}`.trim()
}

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'] as const

/**
 * シート内の日付表記（実物と同じ「26年8月28日(金)」）。
 * format.ts の fmtDayLabel は「8/28（金）」で、実物の帳票とは書式が違うためここで組み立てる
 * （format.ts は変更禁止ファイル）。壊れた値はそのまま返す（画面を落とさない）。
 */
function fmtSheetDay(iso: string): string {
  if (!ISO_DATE_RE.test(iso)) return iso
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7))
  const d = Number(iso.slice(8, 10))
  const dt = new Date(y, m - 1, d)
  return `${pad2(y % 100)}年${m}月${d}日(${WEEKDAY[dt.getDay()]})`
}

/**
 * 記載欄のタイトル帯だけで使う短い日付（「8/28(金)」）。
 * 帯は1行の高さしか無く、「26年8月28日(金)」だと日付だけで折り返して
 * 欄の名前（夜勤申し送り 等）が2行目に落ちていた（2026-08-28 指示で簡略化）。
 * どの日かはヘッダの日付欄と枠（.dsheet-day）が示すので、帯は月日と曜日で足りる。
 * 壊れた値はそのまま返す（画面を落とさない）。
 */
function fmtSheetDayShort(iso: string): string {
  if (!ISO_DATE_RE.test(iso)) return iso
  const m = Number(iso.slice(5, 7))
  const d = Number(iso.slice(8, 10))
  const dt = new Date(Number(iso.slice(0, 4)), m - 1, d)
  return `${m}/${d}(${WEEKDAY[dt.getDay()]})`
}

/**
 * 土日の日付セルに付ける色（指示12・sheet.css の .sheet-sat / .sheet-sun）。
 * 平日は色を付けない。壊れた値でも落とさず「色なし」を返す。
 * 曜日は日付の文字（土）（日）にも出るので、この色はあくまで補助
 * （色だけで意味を伝えない＝介護現場要件4）。
 */
function weekendClass(iso: string): string {
  if (!ISO_DATE_RE.test(iso)) return ''
  const dt = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
  const d = dt.getDay()
  return d === 6 ? 'sheet-sat' : d === 0 ? 'sheet-sun' : ''
}

/**
 * 1行おきの縞（指示16・sheet.css の .sheet-alt）。
 * index は「保存済みの行 → 追加した行」を通した 0 始まりの並び順で、
 * 偶数行（画面の2行目・4行目…＝index が奇数）に縞を敷く。
 * **縞は行（器）が持ち、意味のある色はセルが持つ**ので、しきい値の色・行の色・土日の色は
 * セル側が上に描かれて縞に負けない。
 */
function altClass(index: number): string {
  return index % 2 === 1 ? 'sheet-alt' : ''
}

/**
 * その日が属する10日区切りの日を並べる（1〜10 / 11〜20 / 21〜月末）。
 * 月末が31日なら3つ目の区切りは 21〜31（11日ぶん）になる＝取得の上限もこの長さ。
 * 壊れた値では「その日1日だけ」を返す（区切りが作れなくても画面は開ける）。
 */
function blockDays(iso: string): string[] {
  if (!ISO_DATE_RE.test(iso)) return [iso]
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7))
  const d = Number(iso.slice(8, 10))
  const last = new Date(y, m, 0).getDate()
  if (!Number.isFinite(last) || last < 28) return [iso]
  const start = d <= 10 ? BLOCK_STARTS[0] : d <= 20 ? BLOCK_STARTS[1] : BLOCK_STARTS[2]
  const end = start === BLOCK_STARTS[2] ? last : start + 9
  const out: string[] = []
  for (let i = start; i <= end; i++) out.push(`${y}-${pad2(m)}-${pad2(i)}`)
  return out
}

/** 保存済みの表示単位を既知値照合で読む（未知値・参照不能は既定の10日へ） */
function readUnit(): SheetUnit {
  const raw = readSheetPref(LS.sheetDays, 'daily')
  return UNIT_VALUES.includes(raw as SheetUnit) ? (raw as SheetUnit) : DEFAULT_UNIT
}

/**
 * 同時に走らせる非同期処理の数を絞る（10日ぶんの取得を一斉に投げない）。
 * 上限に達している間は待ち行列に並べ、1つ終わるごとに次を通す。
 */
function makeLimiter(max: number): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T,>(job: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
    try {
      return await job()
    } finally {
      active -= 1
      const next = waiting.shift()
      if (next) next()
    }
  }
}

function errText(err: unknown): string {
  if (err instanceof DbError) return err.message
  return ERR_SAVE
}

/** 血圧セルに出す記号は、上下のうち重い方を採る（記号は LEVEL_MARK 側で付く） */
function bpLevel(sys: number | null, dia: number | null): Level {
  const a = sysBpLevel(sys)
  const b = diaBpLevel(dia)
  const weight = (l: Level): number =>
    l === 'danger-high' || l === 'danger-low' ? 2 : l === 'warn-high' || l === 'warn-low' ? 1 : 0
  return weight(a) >= weight(b) ? a : b
}

// ══════════════════════════════════════════════════════════════
// 行モデル
// ══════════════════════════════════════════════════════════════

/** 行に添える一言（保存結果・入力エラー）。色だけでなく記号を必ず含める */
interface RowStatus {
  tone: 'ok' | 'warn' | 'danger'
  text: string
}

interface NoteDraft {
  key: string
  shift: Shift
  after16: boolean
  residentId: number | null
  /** 対象を一度でも選んだか（未選択と「全体」を区別する） */
  targetPicked: boolean
  body: string
  reporterId: number | null
  color: NoteColor | null
  /** 送信待ちに退避した行。同じ内容を二重に登録しないため編集を止める */
  locked: boolean
}

interface VitalSetInput {
  at: string
  temp: string
  spo2: string
  bp: string
  pulse: string
}

function emptySet(): VitalSetInput {
  return { at: '', temp: '', spo2: '', bp: '', pulse: '' }
}

/**
 * 下書きの1枠に入っている値を、そのまま保存できる形へ。
 * 読めない値・範囲外の値は落とす（その値を確定したときに行へエラーを出しているため、
 * ここで二重に知らせない。保存されるのは読めた値だけ）。
 */
function setToPatch(s: VitalSetInput): Partial<Omit<Vital, 'id' | 'rev'>> {
  const patch: Partial<Omit<Vital, 'id' | 'rev'>> = {}
  const at = parseHM(s.at)
  if (at.ok && at.value !== null) patch.measured_at = at.value
  const temp = parseNum(s.temp, 'temp')
  if (temp.ok && temp.value !== null) patch.temp = temp.value
  const spo2 = parseNum(s.spo2, 'spo2')
  if (spo2.ok && spo2.value !== null) patch.spo2 = spo2.value
  const pulse = parseNum(s.pulse, 'pulse')
  if (pulse.ok && pulse.value !== null) patch.pulse = pulse.value
  const bp = parseBp(s.bp)
  if (bp.ok) {
    if (bp.sys !== null) patch.sys_bp = bp.sys
    if (bp.dia !== null) patch.dia_bp = bp.dia
  }
  return patch
}

/**
 * 保存に足る値が1つでもあるか（空行を作らないための判定・sheet-contracts.md §5
 * 「空行は送信しない＝空データを作らない」）。
 * 空欄を確定した時の patch は「消す意思」の null だけになるので、
 * 件数（Object.keys）では空行かどうかを判定できない。
 */
function hasVitalValue(fields: Partial<Vital>): boolean {
  const keys = ['measured_at', 'temp', 'sys_bp', 'dia_bp', 'pulse', 'spo2', 'symptom'] as const
  return keys.some((k) => fields[k] != null)
}

interface VitalDraft {
  key: string
  kind: 'observation' | 'symptom'
  residentId: number | null
  sets: VitalSetInput[]
  symptom: string
  locked: boolean
}

interface OutingDraft {
  key: string
  kind: OutingKind
  residentId: number | null
  place: string
  startAt: string
  endText: string
  companion: string
  locked: boolean
}

// ── 空の入力行を作る（「＋行」と、固定行数の補充から呼ぶ）──────

function emptyOutingDraft(key: string, kind: OutingKind): OutingDraft {
  return {
    key,
    kind,
    residentId: null,
    place: '',
    startAt: '',
    endText: '',
    companion: '',
    locked: false,
  }
}

function emptyVitalDraft(key: string, kind: 'observation' | 'symptom'): VitalDraft {
  return {
    key,
    kind,
    residentId: null,
    // 発熱者は1行に3枠（時 KT SpO2 BP P）。他症状者は1枠
    sets: kind === 'observation' ? [emptySet(), emptySet(), emptySet()] : [emptySet()],
    symptom: '',
    locked: false,
  }
}

function emptyNoteDraft(
  key: string,
  shift: Shift,
  after16: boolean,
  reporterId: number | null,
): NoteDraft {
  return {
    key,
    shift,
    after16,
    residentId: null,
    targetPicked: false,
    body: '',
    reporterId,
    color: null,
    locked: false,
  }
}

/** 発熱者ブロックの1行（同じ利用者の観察を最大3枠ずつまとめる） */
interface FeverRow {
  key: string
  residentId: number
  slots: (Vital | null)[]
}

function buildFeverRows(list: Vital[], order: Map<number, number>): FeverRow[] {
  const byResident = new Map<number, Vital[]>()
  for (const v of list) {
    const arr = byResident.get(v.resident_id)
    if (arr) arr.push(v)
    else byResident.set(v.resident_id, [v])
  }
  const rows: FeverRow[] = []
  const ids = Array.from(byResident.keys()).sort(
    (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
  )
  for (const id of ids) {
    const arr = (byResident.get(id) ?? []).slice().sort((a, b) => a.id - b.id)
    for (let i = 0; i < arr.length; i += FEVER_SETS) {
      const slots: (Vital | null)[] = []
      for (let j = 0; j < FEVER_SETS; j++) slots.push(arr[i + j] ?? null)
      rows.push({ key: `f${id}-${i / FEVER_SETS}`, residentId: id, slots })
    }
  }
  return rows
}

/**
 * 追加した観察（発熱者）が入る行のキー。buildFeverRows と同じ規則で
 * 「同じ利用者の N 件目は N / FEVER_SETS 行目」に入る。
 * list は**この1件を足す前**の一覧（並びは id 昇順で、追加した行が最後に来る前提）。
 */
function feverRowKey(v: Vital, list: Vital[]): string {
  const before = list.filter((x) => x.resident_id === v.resident_id && x.id !== v.id).length
  return `f${v.resident_id}-${Math.floor(before / FEVER_SETS)}`
}

// ══════════════════════════════════════════════════════════════
// 共通の見た目（div で組む表。SheetCell の描画要素に依存しない）
// ══════════════════════════════════════════════════════════════

function Row({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex items-stretch border-b border-border ${className}`}
      style={{ minHeight: 'var(--sheet-row-h-note)' }}
    >
      {children}
    </div>
  )
}

function HeadRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex items-stretch border-b border-border-strong bg-surface2 font-bold text-ink2 ${className}`}
      style={{ minHeight: 'var(--sheet-head-h)' }}
    >
      {children}
    </div>
  )
}

/**
 * 幅を持つセルの入れ物。width は sheet.css の CSS 変数（または 'auto'）で渡す。
 * pad=false は「中身が自分で左右余白を持つ」時に使う（SheetCell・PickerCell・行内ボタンを入れる枠）。
 * **左右余白は入れ物か中身のどちらか一方だけが持つ**（どちらも 4px）。
 * 二重に取ると、その列だけ中身が 8px 右へずれて列見出し（HeadCell＝4px）と左端が食い違い、
 * 狭い列（血圧 60px・脈 50px）では末尾のしきい値記号（↑↑ ↓↓）が truncate に食われて
 * 色だけの表示になる＝色だけで意味を伝えることになるため。
 */
function Cell({
  width,
  grow = false,
  pad = true,
  children,
  className = '',
}: {
  width?: string
  grow?: boolean
  pad?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`min-w-0 border-r border-border ${pad ? 'px-1' : ''} ${grow ? 'flex-1' : 'shrink-0'} ${className}`}
      style={grow ? undefined : { width }}
    >
      {children}
    </div>
  )
}

function HeadCell({ width, grow = false, children }: { width?: string; grow?: boolean; children: ReactNode }) {
  return (
    <Cell width={width} grow={grow} className="flex items-center">
      <span className="truncate">{children}</span>
    </Cell>
  )
}

/**
 * 行に添える一言（保存結果・入力エラー・封鎖の理由）。
 * - ライブリージョンは常設し、中身だけ差し替える（ui.tsx の Toast と同じ作法。
 *   role="status" は要素ごと現れた時の読み上げが保証されないため）
 * - 折り返す（truncate しない）。競合・保存失敗の文は「次にどうすればよいか」まで
 *   書いてあり、1行に切り詰めると対処手順が画面から消える
 */
function StatusText({ status }: { status?: RowStatus }) {
  const cls = !status
    ? ''
    : status.tone === 'danger'
      ? 'text-danger'
      : status.tone === 'warn'
        ? 'text-warn'
        : 'text-ok'
  return (
    <span role="status" aria-live="polite" className={`block whitespace-normal break-words ${cls}`}>
      {status ? status.text : ''}
    </span>
  )
}

/** ピッカーを開くセル（対象・記入者・氏名）。読み上げのため aria-label を必ず付ける */
function PickerCell({
  width,
  grow = false,
  text,
  label,
  disabled,
  onClick,
}: {
  width?: string
  grow?: boolean
  text: string
  label: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    // 余白はこの中のボタン（px-1）だけが持つ。入れ物にも取ると中身が 8px ずれて
    // 列見出しと左端が合わなくなる（sheet-contracts.md §1「セルは 0 マージンで詰める」）
    <Cell width={width} grow={grow} pad={false} className="flex items-center">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        style={ROW_BTN_STYLE}
        className={`${CELL_HIT} w-full rounded-sm px-1 text-left ${
          disabled ? 'text-ink2' : 'text-link'
        }`}
      >
        {/* truncate（overflow:hidden）はボタン自身に付けない。付けると当たり判定を広げる
            ::before が切り取られて拡張が死ぬため、内側の span に持たせる */}
        <span className="block truncate">
          {text === '' ? <span aria-hidden="true">—</span> : text}
        </span>
      </button>
    </Cell>
  )
}

/**
 * 行を1つ足すボタン（実物のスプシは固定行数だが、足りない時は増やせる＝現状の実装を維持）。
 * 見出しの中に置くので行の高さに収める（sheet-dense-btn）。読み上げ名にはブロック名を入れる
 * （同じ「＋行」が画面に何個も並ぶため、どのブロックを足すのか分かるようにする）。
 */
function AddRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`${CELL_HIT} sheet-dense-btn shrink-0 rounded-sm border border-primary px-1 font-bold text-primary`}
    >
      ＋行
    </button>
  )
}

/**
 * 行の左端の件数セル（実物と同じ「0名」の位置）。件数はブロックの1行目だけに出す
 * ＝スプシの結合セルの見え方に合わせる。2行目以降は空欄。
 */
function LeadCell({ text }: { text: string }) {
  return (
    <Cell width="var(--w-block)" className="flex items-center">
      <span className="tabular truncate text-ink2">{text}</span>
    </Cell>
  )
}

/**
 * 付帯ブロックの枠（外出者・外泊者・発熱者・他症状者）。
 * 2026-08-28 の指示9で「常時表示・折りたたみなし」になったため CollapsibleBlock は使わない
 * （0件でも枠と空行を出す＝実物のスプシと同じ）。
 * 見出し行は［ブロック名＋＋行］＋列見出しで、下罫線を太線にする（指示「見出しは黒枠・太線」）。
 */
function SheetBlock({
  title,
  head,
  onAdd,
  children,
}: {
  title: string
  /** 列見出し（HeadCell を並べる）。左端のブロック名セルはこの部品が描く */
  head: ReactNode
  /** 省略＝行を足せない（入力封鎖中） */
  onAdd?: () => void
  children: ReactNode
}) {
  return (
    <section aria-label={title}>
      <HeadRow className="dsheet-head">
        <Cell width="var(--w-block)" className="flex items-center gap-1">
          <span className="truncate">{title}</span>
          {onAdd ? <AddRowButton label={`${title}に1行追加`} onClick={onAdd} /> : null}
        </Cell>
        {head}
      </HeadRow>
      {children}
    </section>
  )
}

/**
 * 申し送りのタイトル帯（実物の配色。指示8）。
 * 色の意味は必ず文字（日勤申し送り／デイサービス／夜勤申し送り）が持ち、
 * 色は「実物と同じ場所を探せる」ための補助に留める（色だけで意味を伝えない）。
 */
type NoteTone = 'note' | 'care' | 'night'

const NOTE_TONE_CLASS: Record<NoteTone, string> = {
  note: 'dsheet-title-note',
  care: 'dsheet-title-care',
  night: 'dsheet-title-night',
}

function NoteTitleBand({
  day,
  title,
  tone,
  count,
  onAdd,
}: {
  day: string
  title: string
  tone: NoteTone
  count: number
  onAdd?: () => void
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-1 px-1 font-bold ${NOTE_TONE_CLASS[tone]}`}
      style={{ minHeight: 'var(--sheet-row-h-note)' }}
    >
      <span className="tabular">{fmtSheetDayShort(day)}</span>
      <span>{title}</span>
      <span className="tabular">{count}件</span>
      {onAdd ? <AddRowButton label={`${title}に1行追加`} onClick={onAdd} /> : null}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// ページ本体
// ══════════════════════════════════════════════════════════════

export interface DailySheetPageProps {
  /** App.tsx が保持していれば渡す（省略時はこの画面で取得する） */
  residents?: Resident[]
  staff?: Staff[]
  /** 操作者（記入者）の staff_id。省略時は cl_staffId から読む */
  actorId?: number | null
  /** 入力解禁フラグ。省略時はこの画面の表示ごとに取得する（前提情報は毎回取り直す） */
  inputEnabled?: boolean
}

type Phase = 'loading' | 'ready' | 'error'

type PickTarget =
  | { for: 'noteTarget'; key: string }
  | { for: 'noteReporter'; key: string }
  | { for: 'vitalTarget'; key: string }
  | { for: 'outingTarget'; key: string }
  | { for: 'attendance'; role: 'manager' | 'staff' }

interface ConfirmState {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
}

/** 1日ぶんの枠（DaySheet）へ渡すもの。マスタ・取得口・通知は親が1つだけ持つ */
interface DaySheetProps {
  day: string
  residents: Resident[]
  staff: Staff[]
  actorId: number | null
  /** 入力解禁（false＝閲覧のみ。理由文は blockedReason） */
  enabled: boolean
  blockedReason: string
  /** 「最新に更新」で増える。増えるとこの日を取り直す（下書きは消さない） */
  reloadToken: number
  /** 1日ぶんの日報を取る（取得済みならキャッシュから返る） */
  loadDay: (day: string) => Promise<DailyReport>
  /** 自分がこの日へ書き込んだ（変更通知の抑制＋取り置きの破棄） */
  onWrite: (day: string) => void
  /** 未保存の下書きの有無を親へ伝える（日を移る前の確認に使う） */
  onDirty: (day: string, dirty: boolean) => void
  /** 取得が終わった（親が選択日の位置合わせをやり直す） */
  onLoaded: (day: string) => void
  /** 日付セルのカレンダーで別の日が選ばれた */
  onPickDay: (iso: string) => void
  show: (msg: string, undo?: () => void) => void
}

/**
 * 日報ページ（外枠）。
 * 受け持つのは「どの日を出すか」と、全ての日で共通のもの
 * （利用者・職員・施設名・入力解禁フラグ・変更通知・トースト・取得のキャッシュ）。
 * 1日ぶんの中身と保存は DaySheet が持つ＝10日表示でも1日表示でも同じ部品を並べるだけになる。
 */
export function DailySheetPage({
  residents: propResidents,
  staff: propStaff,
  actorId: propActorId,
  inputEnabled: propInputEnabled,
}: DailySheetPageProps = {}) {
  const [day, setDay] = useState(() => todayIso())
  /** 表示単位。既定は10日（指示2・4）。端末ごとに記憶する（日付は記憶しない） */
  const [unit, setUnit] = useState<SheetUnit>(readUnit)
  const [phase, setPhase] = useState<Phase>('loading')
  const [reload, setReload] = useState(0)
  const [residents, setResidents] = useState<Resident[]>(propResidents ?? NO_RESIDENTS)
  const [staff, setStaff] = useState<Staff[]>(propStaff ?? NO_STAFF)
  const [enabled, setEnabled] = useState<boolean>(propInputEnabled ?? false)
  /** 入力できるかどうかを観測できなかった（通信エラー）。封鎖の理由文とは分けて案内する */
  const [gateUnknown, setGateUnknown] = useState(false)
  const [stale, setStale] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  /**
   * 一度でもマスタを読めたか。読めた後は、取り直しに失敗しても画面を差し替えない
   * （枠ごと消すと、その中で書きかけの行まで失われるため。失敗は帯で知らせて再試行させる）。
   */
  const [everReady, setEverReady] = useState(false)

  const { toast, show } = useToast()

  const actorId = propActorId !== undefined ? propActorId : getActorId()

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // ── 共有マスタ（利用者・職員・施設名・入力解禁）────────────
  useEffect(() => {
    let alive = true
    setPhase('loading')
    void (async () => {
      try {
        const [rs, st, gate] = await Promise.all([
          propResidents ? Promise.resolve(propResidents) : fetchResidents(),
          propStaff ? Promise.resolve(propStaff) : fetchStaff(),
          // 入力解禁フラグは「観測できた値」と「観測できなかった」を区別するため、
          // 親から既知値をもらっていても必ず自分で取り直す（前提情報は毎回取り直す規範）。
          // 親（App.tsx）は取得失敗時も false を渡してくるので、prop を観測済みとして扱うと
          // 通信障害を「スプレッドシートで記録する期間です」と誤って案内してしまう
          getNativeInputGate(),
        ])
        if (!alive || !aliveRef.current) return
        const list = (Array.isArray(rs) ? rs : []).filter((r) => r != null && r.active !== false)
        setResidents(list.slice().sort(cmpResident))
        setStaff((Array.isArray(st) ? st : []).filter((s) => s != null))
        setEnabled(gate.value === true)
        setGateUnknown(!gate.observed)
        setStale(false)
        setPhase('ready')
        setEverReady(true)
      } catch {
        if (!alive || !aliveRef.current) return
        setPhase('error')
      }
    })()
    return () => {
      alive = false
    }
    // propInputEnabled は依存に入れない（初期 state 専用）。
    // 親（App.tsx）の入力解禁フラグは起動直後に false→true へ切り替わるので、依存に入れると
    // その一瞬で再取得が走り、読み込み済みの画面が「読み込んでいます…」へ戻ってしまう
  }, [reload, propResidents, propStaff])

  // ── 日ごとの取得（キャッシュ＋同時実行の上限）──────────────
  const cacheRef = useRef(new Map<string, DailyReport>())
  const limiterRef = useRef(makeLimiter(MAX_PARALLEL_LOADS))

  // 記録者が変わると既読の見え方（my_read）が変わるので、取り置きは捨てる
  useEffect(() => {
    cacheRef.current.clear()
  }, [actorId])

  const loadDay = useCallback(
    async (dayIso: string): Promise<DailyReport> => {
      const cache = cacheRef.current
      const hit = cache.get(dayIso)
      if (hit) return hit
      const report = await limiterRef.current(() => fetchDailyReport(dayIso, actorId))
      cache.set(dayIso, report)
      // 古い順に捨てる（Map は挿入順。持ち過ぎて端末のメモリを食わない）
      while (cache.size > MAX_CACHE_DAYS) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
      return report
    },
    [actorId],
  )

  /** 自分の書き込みで出た変更通知に反応しないための抑制窓 */
  const selfWriteRef = useRef(0)
  const handleWrite = useCallback((dayIso: string) => {
    selfWriteRef.current = Date.now()
    touchActivity()
    // 書き換えた日は取り置きを捨てる（区切りを行き来した時に編集前の内容を見せない）
    cacheRef.current.delete(dayIso)
  }, [])

  // 変更通知は自動で取り込まず「最新に更新」の案内だけ出す（編集中の入力を勝手に差し替えない）
  useEffect(() => {
    let unsub: (() => void) | null = null
    try {
      unsub = subscribeChanges((table) => {
        if (!aliveRef.current) return
        // この画面が描画する表の変更だけを合図にする（食事・水分の記録では出さない）
        if (typeof table !== 'string' || !WATCHED_TABLES.has(table)) return
        if (Date.now() - selfWriteRef.current < 3000) return
        setStale(true)
      })
    } catch {
      unsub = null
    }
    return () => {
      if (unsub) {
        try {
          unsub()
        } catch {
          // 解除できなくても表示に影響しない
        }
      }
    }
  }, [])

  const visibleDays = useMemo(() => (unit === '1' ? [day] : blockDays(day)), [day, unit])

  // ── 未保存の下書きを持つ日（画面から外れる前に確認する）──────
  const dirtyRef = useRef(new Map<string, boolean>())
  const handleDirty = useCallback((dayIso: string, dirty: boolean) => {
    dirtyRef.current.set(dayIso, dirty)
  }, [])

  // ── 選んだ日へスクロール（指示3）────────────────────────
  const dayElsRef = useRef(new Map<string, HTMLElement>())
  /**
   * 位置合わせの目的地と期限。日ごとの取得が終わるたびに高さが変わるので、
   * 期限内は取得完了のたびに位置を取り直す。利用者が自分でスクロールしたら打ち切る
   * （操作を奪わない）。なめらかスクロールにはしない＝何度も走るため。
   */
  const pendingScrollRef = useRef<{ day: string; until: number } | null>(null)

  const scrollToDay = useCallback((iso: string) => {
    const el = dayElsRef.current.get(iso)
    if (!el) return
    try {
      el.scrollIntoView({ block: 'start', inline: 'nearest' })
    } catch {
      // 位置合わせに失敗しても内容は表示されている（画面を落とさない）
    }
  }, [])

  // 位置合わせの目的地を決め直す（日・表示単位を変えた時と、シートが最初に出た時）
  useEffect(() => {
    pendingScrollRef.current = { day, until: Date.now() + 5000 }
    const raf = window.requestAnimationFrame(() => {
      if (pendingScrollRef.current?.day === day) scrollToDay(day)
    })
    return () => window.cancelAnimationFrame(raf)
  }, [day, unit, everReady, scrollToDay])

  useEffect(() => {
    const cancel = () => {
      pendingScrollRef.current = null
    }
    window.addEventListener('wheel', cancel, { passive: true })
    window.addEventListener('touchmove', cancel, { passive: true })
    return () => {
      window.removeEventListener('wheel', cancel)
      window.removeEventListener('touchmove', cancel)
    }
  }, [])

  const handleLoaded = useCallback(
    (iso: string) => {
      const pending = pendingScrollRef.current
      if (pending === null) return
      if (Date.now() > pending.until) {
        pendingScrollRef.current = null
        return
      }
      // 目的の日より上にある日が読み込まれると位置がずれるので取り直す
      if (iso === pending.day || iso < pending.day) {
        window.requestAnimationFrame(() => {
          if (pendingScrollRef.current?.day === pending.day) scrollToDay(pending.day)
        })
      }
    },
    [scrollToDay],
  )

  // ── 日付・表示単位の移動（未保存の下書きがあれば確認する）────
  const askLeave = useCallback((leaving: string[], apply: () => void) => {
    if (!leaving.some((d) => dirtyRef.current.get(d) === true)) {
      apply()
      return
    }
    setConfirm({
      title: '未保存の入力があります',
      body: '保存していない行があります。表示を切り替えると、その入力は破棄されます。切り替えてよろしいですか。',
      confirmLabel: '切り替える',
      onConfirm: () => {
        setConfirm(null)
        apply()
      },
    })
  }, [])

  const goDay = useCallback(
    (next: string) => {
      if (!ISO_DATE_RE.test(next) || next === day) return
      const nextDays = unit === '1' ? [next] : blockDays(next)
      const leaving = visibleDays.filter((d) => !nextDays.includes(d))
      askLeave(leaving, () => setDay(next))
    },
    [askLeave, day, unit, visibleDays],
  )

  const goUnit = useCallback(
    (next: SheetUnit) => {
      if (next === unit) return
      const nextDays = next === '1' ? [day] : blockDays(day)
      const leaving = visibleDays.filter((d) => !nextDays.includes(d))
      askLeave(leaving, () => {
        setUnit(next)
        writeSheetPref(LS.sheetDays, 'daily', next)
      })
    },
    [askLeave, day, unit, visibleDays],
  )

  const blockedReason = gateUnknown ? GATE_UNKNOWN_REASON : BLOCKED_REASON

  // 3状態（初回だけ画面ごと差し替える。2回目以降は下の帯で知らせる＝書きかけを消さない）
  if (phase === 'loading' && !everReady) {
    return <LoadingBlock label="日報を読み込んでいます…" />
  }

  if (phase === 'error' && !everReady) {
    return <ErrorBlock message={ERR_LOAD} onRetry={() => setReload((n) => n + 1)} />
  }

  return (
    <div className="space-y-4">
      {/* 日付バー（前後日・カレンダー・表示単位・表示倍率） */}
      <DateBar day={day} unit={unit} onGo={goDay} onUnit={goUnit} />

      {phase === 'error' && everReady && (
        <div className="flex flex-wrap items-center gap-gap rounded-md border border-danger bg-danger-bg p-3">
          <p className="flex-1 text-base text-ink">
            <span aria-hidden="true">▲ </span>
            {ERR_LOAD}
          </p>
          <button
            type="button"
            onClick={() => setReload((n) => n + 1)}
            className="min-h-tap rounded-md border border-primary bg-surface px-4 text-base font-bold text-primary"
          >
            再試行
          </button>
        </div>
      )}

      {gateUnknown && (
        <p className="rounded-md border border-info bg-info-bg p-3 text-base text-ink">
          <span aria-hidden="true">ⓘ </span>
          {/* 行に出す一言（blockedReason）と同じ文言を1か所から出す＝画面内で理由が食い違わない */}
          {GATE_UNKNOWN_REASON}
        </p>
      )}
      {!enabled && !gateUnknown && (
        <p className="rounded-md border border-warn bg-warn-bg p-3 text-base text-ink">
          <span aria-hidden="true">▲ </span>
          {BLOCKED_REASON}
        </p>
      )}
      {stale && (
        <div className="flex flex-wrap items-center gap-gap rounded-md border border-info bg-info-bg p-3">
          <p className="flex-1 text-base text-ink">
            <span aria-hidden="true">ⓘ </span>
            他の端末で記録が更新されました。最新の内容に切り替えられます（入力中の行は保存してから押してください）。
          </p>
          <button
            type="button"
            onClick={() => {
              cacheRef.current.clear()
              setStale(false)
              setReload((n) => n + 1)
            }}
            className="min-h-tap rounded-md border border-primary bg-surface px-4 text-base font-bold text-primary"
          >
            最新に更新
          </button>
        </div>
      )}

      <SheetFrame>
        {/* 器の幅は「画面幅」か「固定列の合計（SHEET_MIN_W）」の広い方で決める。
            w-max（＝width: max-content）にすると器の幅が中身の最大コンテンツ幅になり、
            申し送りの長文1件でシート全体が横に伸びて本文が1行のまま折り返さなくなる
            （sheet-contracts.md §5「長文は行が伸びる（clamp しない）」が成立しない）。
            狭い画面では固定列の合計まで SheetFrame 側が横スクロールする。
            sheet-dense＝「行が縦に連続する場所」の印。sheet.css がこの中の
            当たり判定の拡張量（--sheet-hit-pad）を 0 にする＝隣接行の誤タップを防ぐ */}
        <div className="sheet-dense" style={{ minWidth: SHEET_MIN_W }}>
          {visibleDays.map((d) => (
            <section
              key={d}
              ref={(el) => {
                if (el) dayElsRef.current.set(d, el)
                else dayElsRef.current.delete(d)
              }}
              aria-label={`${fmtSheetDay(d)} の日報`}
              aria-current={d === day ? 'date' : undefined}
              className="dsheet-day"
            >
              <DaySheet
                day={d}
                residents={residents}
                staff={staff}
                actorId={actorId}
                enabled={enabled}
                blockedReason={blockedReason}
                reloadToken={reload}
                loadDay={loadDay}
                onWrite={handleWrite}
                onDirty={handleDirty}
                onLoaded={handleLoaded}
                onPickDay={goDay}
                show={show}
              />
            </section>
          ))}
        </div>
      </SheetFrame>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        body={confirm?.body}
        confirmLabel={confirm?.confirmLabel}
        danger
        onConfirm={() => confirm?.onConfirm()}
        onCancel={() => setConfirm(null)}
      />
      {toast}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 1日ぶんの日報（太線で囲まれる単位）
// ══════════════════════════════════════════════════════════════

function DaySheet({
  day,
  residents,
  staff,
  actorId,
  enabled,
  blockedReason,
  reloadToken,
  loadDay,
  onWrite,
  onDirty,
  onLoaded,
  onPickDay,
  show,
}: DaySheetProps) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [reload, setReload] = useState(0)

  const [notes, setNotes] = useState<Note[]>([])
  const [observations, setObservations] = useState<Vital[]>([])
  const [symptoms, setSymptoms] = useState<Vital[]>([])
  const [outings, setOutings] = useState<Outing[]>([])
  const [attendance, setAttendance] = useState<Attendance[]>([])

  const [noteDrafts, setNoteDrafts] = useState<NoteDraft[]>([])
  const [vitalDrafts, setVitalDrafts] = useState<VitalDraft[]>([])
  const [outingDrafts, setOutingDrafts] = useState<OutingDraft[]>([])

  const [status, setStatus] = useState<Record<string, RowStatus>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [residentPick, setResidentPick] = useState<PickTarget | null>(null)
  const [staffPick, setStaffPick] = useState<PickTarget | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  const aliveRef = useRef(true)
  const seqRef = useRef(0)
  /**
   * この枠が受け持つ日。登録の応答が返るまでに枠が別の日へ差し替わっていないかを確かめる
   * （応答を無条件に今の state へ足すと、別の日の記録がこの枠に現れる）。
   */
  const dayRef = useRef(day)
  /** 登録の応答待ちの行。二重に登録しないための鍵（同じ行から2回 insert しない） */
  const savingRef = useRef(new Set<string>())
  /**
   * 出勤者の最新の一覧。保存は応答が返ってから画面へ反映するので、
   * 連続操作（✕を続けて押す等）の2件目は state ではなくこの ref を基準に組み直す
   * （render 時の値を prev にすると、1件目の結果を知らないまま送って取り消しが巻き戻る）。
   */
  const attendanceRef = useRef<Attendance[]>([])
  /** 出勤者の保存を日付ごとに直列化する（MealsSheetPage の chainRef と同型） */
  const attendanceChainRef = useRef(new Map<string, Promise<void>>())
  /**
   * 発熱者の最新の一覧。保存直後に「保存済み行が使うキー」を組み立てるため、
   * setObservations の反映を待たずに「同じ人の何件目か」を数える。
   */
  const observationsRef = useRef<Vital[]>([])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    dayRef.current = day
  }, [day])

  // 保存処理から読む最新値（setState の反映を待たずに使う）
  useEffect(() => {
    observationsRef.current = observations
  }, [observations])

  /**
   * 出勤者の一覧を差し替える。**ref と state を必ず同時に**書く
   * （直列化した次の保存は再描画を待たずに走るので、ref を後追いで同期すると古い値を基準にしてしまう）。
   */
  const applyAttendance = useCallback((rows: Attendance[]) => {
    attendanceRef.current = rows
    setAttendance(rows)
  }, [])

  /** 登録の応答を今の画面へ足してよいか（日付を送っていたら足さない＝取り違えを作らない） */
  const stillOnDay = useCallback((dayAtStart: string): boolean => dayRef.current === dayAtStart, [])

  const nextKey = useCallback((prefix: string) => {
    seqRef.current += 1
    return `${prefix}${seqRef.current}`
  }, [])

  const setRowStatus = useCallback((key: string, s: RowStatus | null) => {
    setStatus((prev) => {
      if (s === null) {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      }
      return { ...prev, [key]: s }
    })
  }, [])

  // ── 読み込み ───────────────────────────────────────────────

  useEffect(() => {
    let alive = true
    setPhase('loading')
    void (async () => {
      try {
        // 1日ぶんだけを取りに行く（10日表示でも全件ロードしない）。
        // 取得済みの日は親のキャッシュから即返る＝区切りを行き来しても取り直さない
        const report = await loadDay(day)
        if (!alive || !aliveRef.current) return

        const safeNotes = Array.isArray(report?.notes) ? report.notes.filter((n) => n != null) : []
        setNotes(
          safeNotes
            .slice()
            .sort((a, b) => (a.occurred_at ?? '').localeCompare(b.occurred_at ?? '') || a.id - b.id),
        )
        setObservations(
          Array.isArray(report?.observations) ? report.observations.filter((v) => v != null) : [],
        )
        setSymptoms(Array.isArray(report?.symptoms) ? report.symptoms.filter((v) => v != null) : [])
        setOutings(Array.isArray(report?.outings) ? report.outings.filter((o) => o != null) : [])
        applyAttendance(
          Array.isArray(report?.attendance) ? report.attendance.filter((a) => a != null) : [],
        )
        setPhase('ready')
      } catch {
        if (!alive || !aliveRef.current) return
        // 失敗しても入力中の下書きは消さない（安全側フォールバック）。
        // **この日の枠だけ**がエラー表示になり、他の日は読めたまま残る（部分表示）
        setPhase('error')
      } finally {
        // 成否にかかわらず高さが確定したことを親へ伝える（選択日の位置合わせのため）
        if (alive && aliveRef.current) onLoaded(day)
      }
    })()
    return () => {
      alive = false
    }
  }, [day, reload, reloadToken, loadDay, applyAttendance, onLoaded])

  const residentById = useMemo(() => {
    const m = new Map<number, Resident>()
    for (const r of residents) m.set(r.id, r)
    return m
  }, [residents])

  const staffById = useMemo(() => {
    const m = new Map<number, Staff>()
    for (const s of staff) m.set(s.id, s)
    return m
  }, [staff])

  const residentOrder = useMemo(() => {
    const m = new Map<number, number>()
    residents.forEach((r, i) => m.set(r.id, i))
    return m
  }, [residents])

  // ── 書き込みの共通処理 ─────────────────────────────────────

  /**
   * 自分の書き込みの印。親へ渡して
   *   ・変更通知（他の端末で更新）の抑制窓を開く
   *   ・この日の取り置き（キャッシュ）を捨てる＝区切りを戻った時に編集前の内容を見せない
   * の2つをまとめて行う。
   */
  const markSelfWrite = useCallback(() => {
    onWrite(day)
  }, [day, onWrite])

  /** 保存が通った時に、その行に残っている失敗・競合の一言を消す（成功の一言は出さない＝指示10） */
  const saveOk = useCallback(
    (key: string) => {
      setRowStatus(key, null)
    },
    [setRowStatus],
  )

  /** 編集の可否。封鎖中・読み込み中は書かせない（理由は行に出す） */
  const guard = useCallback(
    (key: string): boolean => {
      if (!enabled) {
        setRowStatus(key, { tone: 'warn', text: `▲ ${blockedReason}` })
        return false
      }
      return true
    },
    [blockedReason, enabled, setRowStatus],
  )

  const askConfirm = useCallback((s: ConfirmState) => setConfirm(s), [])

  // ── 未保存の下書き（親が日付・表示単位の切替前に確認する）─────

  const hasDraftContent = useMemo(() => {
    const noteDirty = noteDrafts.some((d) => d.body.trim() !== '' || d.targetPicked)
    const vitalDirty = vitalDrafts.some(
      (d) =>
        d.residentId !== null ||
        d.symptom.trim() !== '' ||
        d.sets.some((s) => s.at || s.temp || s.spo2 || s.bp || s.pulse),
    )
    const outingDirty = outingDrafts.some(
      (d) =>
        d.residentId !== null ||
        d.place.trim() !== '' ||
        d.startAt !== '' ||
        d.endText !== '' ||
        d.companion.trim() !== '',
    )
    return noteDirty || vitalDirty || outingDirty
  }, [noteDrafts, vitalDrafts, outingDrafts])

  // 書きかけの有無を親へ伝える。枠から外れる時（別の区切りへ移る・1日表示へ切り替える）は
  // 親が確認ダイアログを出す。外れた時に「書きかけ無し」へ戻す（後片付け）
  useEffect(() => {
    onDirty(day, hasDraftContent)
  }, [day, hasDraftContent, onDirty])

  useEffect(
    () => () => {
      onDirty(day, false)
    },
    [day, onDirty],
  )

  // ── 出勤者 ─────────────────────────────────────────────────

  /**
   * 保存する一覧を「実行する時点の一覧（prev）」から組み立てる関数。
   * null を返すと何も送らない（すでに同じ状態＝送る必要が無い時）。
   */
  type AttendancePlan = { rows: Attendance[]; undoLabel: string | null } | null

  /** 直列化した保存の呼び出し口（Undo から呼ぶために ref で持つ。定義の循環を避ける） */
  const enqueueAttendanceRef = useRef<(dayIso: string, build: (prev: Attendance[]) => AttendancePlan) => void>(
    () => undefined,
  )

  const persistAttendance = useCallback(
    async (dayIso: string, rows: Attendance[], prev: Attendance[], undoLabel: string | null) => {
      setRowStatus('attendance', null)
      const next = rows.map((a, i) => ({ ...a, sort: i }))
      try {
        // 抑制の印は「送る前」に付ける（saveAttendance は内部で読み直し→追加→更新→非表示を
        // 順に実行するので、応答を待ってから付けると自分の書き込み由来の変更通知に反応して
        // 「他の端末で記録が更新されました」と誤って案内してしまう）
        markSelfWrite()
        await saveAttendance(
          dayIso,
          next.map((a) => ({ staff_id: a.staff_id, role: a.role, sort: a.sort })),
          // 取り消してよいのは「この端末が画面に持っていた人」だけ。
          // 読み込み後に他端末が足した出勤者は、この端末からは見えていないので触らせない
          { baseline: prev.map((a) => a.staff_id) },
        )
        // 応答を待つ間に日付を送られていたら、別の日の一覧を今の画面へ入れない
        if (!aliveRef.current || dayRef.current !== dayIso) return
        applyAttendance(next)
        if (undoLabel !== null) {
          show(undoLabel, () => {
            // 戻す操作も同じ列に並べる（戻した内容が、後から届いた保存で上書きされないように）。
            // baseline は戻す時点の一覧から組み直す＝直列化後の実際の前状態になる
            enqueueAttendanceRef.current(dayIso, () => ({ rows: prev, undoLabel: null }))
          })
        }
      } catch (err) {
        // 一部だけサーバーへ載った失敗は巻き戻さない（載った分を「保存されていない」と見せない）。
        // 巻き戻す時は「入力は消えていません」と書かない＝画面の実挙動と文言をそろえる
        const partial = err instanceof DbError && err.partial
        if (!aliveRef.current || dayRef.current !== dayIso) return
        if (!partial) applyAttendance(prev)
        const text = err instanceof DbError ? err.message : ERR_SAVE_ATTENDANCE
        setRowStatus('attendance', { tone: 'danger', text: `▲ ${text}` })
      }
    },
    [applyAttendance, markSelfWrite, setRowStatus, show],
  )

  /**
   * 出勤者の保存を日付ごとに直列化する（MealsSheetPage の enqueue と同型）。
   * 応答を待つ間に積まれた操作は、**前の応答の結果（attendanceRef）を基準に組み直す**。
   * 直列化しないと、例えば [A,B,C] から A の✕→（応答前に）B の✕ と押した時、
   * 2件目が古い一覧を送って A の取り消しが巻き戻る（sort が復活する）。
   */
  const enqueueAttendance = useCallback(
    (dayIso: string, build: (prev: Attendance[]) => AttendancePlan) => {
      const chain = attendanceChainRef.current
      const job = async () => {
        if (!aliveRef.current) return
        // 日付を送った後に前の操作が流れてきても、別の日の一覧を書き換えない
        if (dayRef.current !== dayIso) return
        const prev = attendanceRef.current
        const plan = build(prev)
        if (plan === null) return
        await persistAttendance(dayIso, plan.rows, prev, plan.undoLabel)
      }
      const prevChain = chain.get(dayIso) ?? Promise.resolve()
      const nextChain = prevChain
        .catch(() => undefined)
        .then(job)
        .catch(() => undefined)
      chain.set(dayIso, nextChain)
    },
    [persistAttendance],
  )

  useEffect(() => {
    enqueueAttendanceRef.current = enqueueAttendance
  }, [enqueueAttendance])

  const addAttendance = useCallback(
    (staffId: number, role: 'manager' | 'staff') => {
      enqueueAttendance(day, (prev) => {
        const replacing =
          role === 'manager' && prev.some((a) => a.role === 'manager' && a.staff_id !== staffId)
        const cleaned = prev.filter(
          (a) => a.staff_id !== staffId && !(role === 'manager' && a.role === 'manager'),
        )
        return {
          rows: [...cleaned, { day, staff_id: staffId, role, sort: cleaned.length }],
          // 施設長の入れ替えは既存の行を取り消す＝破壊的操作なので、
          // 「出勤者から外す」と同じ Undo の導線に乗せる（1タップで戻せないようにしない）
          undoLabel: replacing ? '施設長を入れ替えました' : null,
        }
      })
    },
    [day, enqueueAttendance],
  )

  const removeAttendance = useCallback(
    (staffId: number) => {
      enqueueAttendance(day, (prev) => {
        // すでに外れている（応答待ちの間に2回押した）時は送らない
        if (!prev.some((a) => a.staff_id === staffId)) return null
        return { rows: prev.filter((a) => a.staff_id !== staffId), undoLabel: '出勤者から外しました' }
      })
    },
    [day, enqueueAttendance],
  )

  // ── 申し送り ───────────────────────────────────────────────

  const addNoteDraft = useCallback(
    (shift: Shift, after16: boolean) => {
      // 封鎖中は書けない行を増やさない。理由だけを知らせる
      // （封鎖中と「確認できていない」を取り違えた案内をしない＝blockedReason が出し分ける）
      if (!enabled) {
        show(blockedReason)
        return
      }
      const key = nextKey('nd')
      setNoteDrafts((prev) => [
        ...prev,
        emptyNoteDraft(key, shift, after16, shift === 'night' ? null : actorId),
      ])
    },
    [actorId, blockedReason, enabled, nextKey, show],
  )

  const patchNoteDraft = useCallback((key: string, patch: Partial<NoteDraft>) => {
    setNoteDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  }, [])

  const patchNote = useCallback((id: number, patch: Partial<Note>) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)))
  }, [])

  /**
   * 下書き行が保存されて id が付いた時、開いたままのピッカーの行き先を新しいキーへ移す。
   * 張り替えないと、選んだ対象・記入者が消えた下書きのキー宛のまま届いて無言で捨てられる
   * （対象・記入者が未設定のまま記録が残ってしまう）。
   */
  const rebindPick = useCallback((fromKey: string, toKey: string) => {
    setResidentPick((cur) =>
      cur !== null && cur.for === 'noteTarget' && cur.key === fromKey ? { ...cur, key: toKey } : cur,
    )
    setStaffPick((cur) =>
      cur !== null && cur.for === 'noteReporter' && cur.key === fromKey
        ? { ...cur, key: toKey }
        : cur,
    )
  }, [])

  /** 保存済みの申し送りの部分更新（送った項目だけ書き、他は温存する） */
  const updateNoteCell = useCallback(
    async (note: Note, patch: Parameters<typeof updateNoteFields>[2], optimistic: Partial<Note>) => {
      const key = `n${note.id}`
      if (!guard(key)) return
      setRowStatus(key, null)
      try {
        // 抑制の印は送る前に付ける（応答後だと、自分の書き込み由来の変更通知に反応して
        // 「他の端末で記録が更新されました」と誤って案内してしまう）
        markSelfWrite()
        const res = await updateNoteFields(note.id, note.rev, patch)
        if (res === 'conflict') {
          setRowStatus(key, { tone: 'danger', text: `▲ ${ERR_CONFLICT}` })
          return
        }
        if (res === 'queued') {
          // 入力どおりに表示したまま送信待ちにする（値を巻き戻さない）
          patchNote(note.id, optimistic)
          setRowStatus(key, { tone: 'warn', text: MSG_QUEUED })
          return
        }
        patchNote(note.id, res)
        saveOk(key)
      } catch (err) {
        setRowStatus(key, { tone: 'danger', text: `▲ ${errText(err)}` })
      }
    },
    [guard, markSelfWrite, patchNote, saveOk, setRowStatus],
  )

  /** 下書き行の保存（本文が入った時点で1回だけ insert する） */
  const saveNoteDraft = useCallback(
    async (draft: NoteDraft, body: string) => {
      const key = draft.key
      if (!guard(key)) return
      // 応答待ちの間に同じ行から2回目を送らない（同じ内容の行が2本できるのを防ぐ）。
      // 受け付けない時は理由を出す（入力は下書きに残っている）
      if (savingRef.current.has(key)) {
        patchNoteDraft(key, { body })
        setRowStatus(key, { tone: 'warn', text: MSG_BUSY })
        return
      }
      savingRef.current.add(key)
      setRowStatus(key, null)
      try {
        markSelfWrite() // 送る前に印を付ける（自分の書き込みで「他の端末で更新」を出さない）
        const res = await insertNote({
          note_on: day,
          shift: draft.shift,
          facility: null,
          category: null,
          resident_id: draft.residentId,
          role_tags: [],
          importance: 'normal',
          body: body.trim(),
          // 記録日が今日のときだけ現在時刻を入れる（過去日に誤った時刻を残さない）
          occurred_at: day === todayIso() ? nowHM() : null,
          ongoing: false,
          ended_at: null,
          reporter_id: draft.reporterId,
          color: draft.color,
          after16: draft.after16,
        })
        if (res === 'queued') {
          patchNoteDraft(key, { body: body.trim(), locked: true })
          setRowStatus(key, {
            tone: 'warn',
            text: isQueuePersisted() ? MSG_QUEUED : MSG_NOT_PERSISTED,
          })
          return
        }
        setNoteDrafts((prev) => prev.filter((d) => d.key !== key))
        if (!stillOnDay(day)) {
          // 応答を待つ間に日付を送られた。保存はできているので、今の画面には足さずに伝える
          show(MSG_SAVED_OTHER_DAY)
          return
        }
        // 同じ id が既に入っていれば入れ替える（再読込と行き違っても行が2つにならない）
        setNotes((prev) => [...prev.filter((n) => n.id !== res.id), res])
        // 保存中に開いたままのピッカーを、保存済みの行のキーへ移す（選択を取りこぼさない）
        rebindPick(key, `n${res.id}`)
        saveOk(`n${res.id}`)
      } catch (err) {
        patchNoteDraft(key, { body })
        setRowStatus(key, { tone: 'danger', text: `▲ ${errText(err)}` })
      } finally {
        savingRef.current.delete(key)
      }
    },
    [day, guard, markSelfWrite, patchNoteDraft, rebindPick, saveOk, setRowStatus, show, stillOnDay],
  )

  const commitNoteBody = useCallback(
    (key: string, value: string) => {
      const draft = noteDrafts.find((d) => d.key === key)
      if (draft) {
        if (draft.locked) return
        if (value.trim() === '') {
          patchNoteDraft(key, { body: value })
          return
        }
        void saveNoteDraft(draft, value)
        return
      }
      const note = notes.find((n) => `n${n.id}` === key)
      if (!note) return
      if (value.trim() === '') {
        setRowStatus(key, { tone: 'danger', text: `▲ ${ERR_EMPTY_BODY}` })
        return
      }
      if (value.trim() === note.body) return
      void updateNoteCell(note, { body: value.trim() }, { body: value.trim() })
    },
    [noteDrafts, notes, patchNoteDraft, saveNoteDraft, setRowStatus, updateNoteCell],
  )

  const deleteNoteRow = useCallback(
    (key: string) => {
      const draft = noteDrafts.find((d) => d.key === key)
      if (draft) {
        // 送信待ちに退避済みの行は消さない（消しても後から登録されて復活するため）
        if (draft.locked) {
          setRowStatus(key, { tone: 'warn', text: `▲ ${MSG_LOCKED_DELETE}` })
          return
        }
        setNoteDrafts((prev) => prev.filter((d) => d.key !== key))
        setRowStatus(key, null)
        // 書きかけを取り消した時は戻せるようにする（1タップで入力を失わせない）
        if (draft.body.trim() !== '') {
          show('入力中の行を取り消しました', () => setNoteDrafts((prev) => [...prev, draft]))
        }
        return
      }
      const note = notes.find((n) => `n${n.id}` === key)
      if (!note) return
      if (!guard(key)) return
      askConfirm({
        title: 'この行を削除しますか',
        body: '削除すると一覧から消えます（記録は復元できません）。よろしければ「削除する」を押してください。',
        confirmLabel: '削除する',
        onConfirm: () => {
          setConfirm(null)
          void (async () => {
            try {
              markSelfWrite() // 送る前に印を付ける（自分の書き込みで「他の端末で更新」を出さない）
              const res = await softDeleteNote(note.id, note.rev)
              if (res === 'conflict') {
                setRowStatus(key, { tone: 'danger', text: `▲ ${ERR_CONFLICT}` })
                return
              }
              setNotes((prev) => prev.filter((n) => n.id !== note.id))
              setExpanded(null)
              show('削除しました')
            } catch (err) {
              setRowStatus(key, { tone: 'danger', text: `▲ ${errText(err)}` })
            }
          })()
        },
      })
    },
    [askConfirm, guard, markSelfWrite, noteDrafts, notes, setRowStatus, show],
  )

  const markNoteRead = useCallback(
    (note: Note) => {
      const key = `n${note.id}`
      if (actorId == null) {
        setRowStatus(key, { tone: 'warn', text: `▲ ${ERR_NO_ACTOR}` })
        return
      }
      void (async () => {
        try {
          await markRead(note.id, actorId)
          touchActivity()
          patchNote(note.id, { my_read: true, read_count: (note.read_count ?? 0) + 1 })
          // 行には出さない（指示10・成功の一言は行を空けるため出さない）。
          // 詳細の表示が「✓ 自分は既読」へ変わるうえ、押した直後は短いトーストで知らせる
          saveOk(key)
          show('既読にしました')
        } catch (err) {
          setRowStatus(key, { tone: 'danger', text: `▲ ${errText(err)}` })
        }
      })()
    },
    [actorId, patchNote, saveOk, setRowStatus, show],
  )

  // ── 発熱者・他症状者 ───────────────────────────────────────

  const addVitalDraft = useCallback(
    (kind: 'observation' | 'symptom') => {
      // 封鎖中と「確認できていない」で理由文を出し分ける（blockedReason）
      if (!enabled) {
        show(blockedReason)
        return
      }
      const key = nextKey('vd')
      setVitalDrafts((prev) => [...prev, emptyVitalDraft(key, kind)])
    },
    [blockedReason, enabled, nextKey, show],
  )

  const patchVitalDraft = useCallback((key: string, patch: Partial<VitalDraft>) => {
    setVitalDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  }, [])

  /** 追加した空行の取り消し。書きかけがある行は Undo を出す */
  const removeVitalDraft = useCallback(
    (key: string) => {
      const draft = vitalDrafts.find((d) => d.key === key)
      // 送信待ちに退避済みの行は消さない（消しても後から登録されて復活するため）
      if (draft?.locked) {
        setRowStatus(key, { tone: 'warn', text: `▲ ${MSG_LOCKED_DELETE}` })
        return
      }
      setVitalDrafts((prev) => prev.filter((d) => d.key !== key))
      setRowStatus(key, null)
      if (!draft) return
      const dirty =
        draft.symptom.trim() !== '' ||
        draft.sets.some((s) => s.at || s.temp || s.spo2 || s.bp || s.pulse)
      if (dirty) show('入力中の行を取り消しました', () => setVitalDrafts((prev) => [...prev, draft]))
    },
    [setRowStatus, show, vitalDrafts],
  )

  const replaceVital = useCallback((v: Vital) => {
    const put = (prev: Vital[]) => {
      const i = prev.findIndex((x) => x.id === v.id)
      if (i < 0) return [...prev, v]
      const next = prev.slice()
      next[i] = v
      return next
    }
    if (v.kind === 'symptom') setSymptoms(put)
    else setObservations(put)
  }, [])

  /** 保存済みバイタルの1セル更新。空文字での消去は確認を挟む */
  const updateVitalCell = useCallback(
    (v: Vital, patch: Partial<Omit<Vital, 'id' | 'rev'>>, rowKey: string, clearing: boolean, label: string) => {
      if (!guard(rowKey)) return
      const run = () => {
        setRowStatus(rowKey, null)
        void (async () => {
          try {
            markSelfWrite() // 送る前に印を付ける（自分の書き込みで「他の端末で更新」を出さない）
            const res = await updateVital(v.id, v.rev, patch)
            if (res === 'conflict') {
              setRowStatus(rowKey, { tone: 'danger', text: `▲ ${ERR_CONFLICT}` })
              return
            }
            if (res === 'queued') {
              replaceVital({ ...v, ...patch })
              setRowStatus(rowKey, { tone: 'warn', text: MSG_QUEUED })
              return
            }
            replaceVital(res)
            saveOk(rowKey)
          } catch (err) {
            setRowStatus(rowKey, { tone: 'danger', text: `▲ ${errText(err)}` })
          }
        })()
      }
      if (clearing) {
        askConfirm({
          title: `${label}を消しますか`,
          body: '保存済みの値を空にします。よろしければ「消す」を押してください。',
          confirmLabel: '消す',
          onConfirm: () => {
            setConfirm(null)
            run()
          },
        })
        return
      }
      run()
    },
    [askConfirm, guard, markSelfWrite, replaceVital, saveOk, setRowStatus],
  )

  /** 新しいバイタル行（発熱者・他症状者）を1件登録する */
  const insertVitalRow = useCallback(
    async (
      rowKey: string,
      residentId: number,
      kind: 'observation' | 'symptom',
      fields: Partial<Omit<Vital, 'id' | 'rev' | 'resident_id' | 'measured_on' | 'kind'>>,
      draftKey: string | null,
    ) => {
      if (!guard(rowKey)) return
      // 値が1つも無い行は作らない（空欄の確定＝null だけの patch で空行ができるのを防ぐ）
      if (!hasVitalValue(fields)) {
        setRowStatus(rowKey, { tone: 'warn', text: MSG_EMPTY_VITAL })
        return
      }
      // 応答待ちの行に重ねて確定が来た場合。保存済みの枠は入力欄に値が残らないので、
      // 黙って捨てずに「もう一度入力してほしい」ことを伝える
      if (savingRef.current.has(rowKey)) {
        setRowStatus(rowKey, { tone: 'warn', text: MSG_BUSY_VITAL })
        return
      }
      savingRef.current.add(rowKey)
      setRowStatus(rowKey, null)
      try {
        markSelfWrite() // 送る前に印を付ける（自分の書き込みで「他の端末で更新」を出さない）
        const res = await insertVitalKind({
          resident_id: residentId,
          measured_on: day,
          kind,
          measured_at: fields.measured_at ?? null,
          temp: fields.temp ?? null,
          sys_bp: fields.sys_bp ?? null,
          dia_bp: fields.dia_bp ?? null,
          pulse: fields.pulse ?? null,
          spo2: fields.spo2 ?? null,
          note: null,
          symptom: fields.symptom ?? null,
          recorded_by: actorId,
        })
        if (res === 'queued') {
          if (draftKey !== null) patchVitalDraft(draftKey, { locked: true })
          setRowStatus(rowKey, { tone: 'warn', text: isQueuePersisted() ? MSG_QUEUED : MSG_NOT_PERSISTED })
          return
        }
        if (draftKey !== null) setVitalDrafts((prev) => prev.filter((d) => d.key !== draftKey))
        if (!stillOnDay(day)) {
          // 応答を待つ間に日付を送られた。保存はできているので、今の画面には足さずに伝える
          show(MSG_SAVED_OTHER_DAY)
          return
        }
        // 下書き行はいま消したので、保存済み行が使うキーへ付け替える。
        // rowKey（＝下書きのキー）のままだと「✓ 保存しました」を描画する行がもう無く、
        // 新規の発熱者・他症状者だけ保存の結果が一切出ない（申し送り・外出は付け替え済み）。
        // 数え直す一覧は replaceVital の反映前＝この1件を足す前のものを使う
        const savedKey =
          draftKey === null
            ? rowKey
            : kind === 'symptom'
              ? `s${res.id}`
              : feverRowKey(res, observationsRef.current)
        replaceVital(res)
        saveOk(savedKey)
      } catch (err) {
        setRowStatus(rowKey, { tone: 'danger', text: `▲ ${errText(err)}` })
      } finally {
        savingRef.current.delete(rowKey)
      }
    },
    [
      actorId,
      day,
      guard,
      markSelfWrite,
      patchVitalDraft,
      replaceVital,
      saveOk,
      setRowStatus,
      show,
      stillOnDay,
    ],
  )

  // ── 外出・外泊 ─────────────────────────────────────────────

  const addOutingDraft = useCallback(
    (kind: OutingKind) => {
      // 封鎖中と「確認できていない」で理由文を出し分ける（blockedReason）
      if (!enabled) {
        show(blockedReason)
        return
      }
      const key = nextKey('od')
      setOutingDrafts((prev) => [...prev, emptyOutingDraft(key, kind)])
    },
    [blockedReason, enabled, nextKey, show],
  )

  const patchOutingDraft = useCallback((key: string, patch: Partial<OutingDraft>) => {
    setOutingDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  }, [])

  /** 追加した空行の取り消し。書きかけがある行は Undo を出す */
  const removeOutingDraft = useCallback(
    (key: string) => {
      const draft = outingDrafts.find((d) => d.key === key)
      // 送信待ちに退避済みの行は消さない（消しても後から登録されて復活するため）
      if (draft?.locked) {
        setRowStatus(key, { tone: 'warn', text: `▲ ${MSG_LOCKED_DELETE}` })
        return
      }
      setOutingDrafts((prev) => prev.filter((d) => d.key !== key))
      setRowStatus(key, null)
      if (!draft) return
      const dirty =
        draft.place.trim() !== '' ||
        draft.startAt !== '' ||
        draft.endText !== '' ||
        draft.companion.trim() !== ''
      if (dirty) show('入力中の行を取り消しました', () => setOutingDrafts((prev) => [...prev, draft]))
    },
    [outingDrafts, setRowStatus, show],
  )

  /** 下書きの外出・外泊を登録する（対象＋いずれかの記入がそろった時点） */
  const saveOutingDraft = useCallback(
    async (draft: OutingDraft) => {
      const key = draft.key
      if (draft.residentId == null) return
      if (!guard(key)) return
      // 応答待ちの間に「登録」を押し直された場合（入力は下書きに残っている）
      if (savingRef.current.has(key)) {
        setRowStatus(key, { tone: 'warn', text: MSG_BUSY })
        return
      }
      const start = parseHM(draft.startAt)
      if (!start.ok) {
        setRowStatus(key, { tone: 'danger', text: start.message })
        return
      }
      const end = parseDayTime(draft.endText, day)
      if (!end.ok) {
        setRowStatus(key, { tone: 'danger', text: end.message })
        return
      }
      savingRef.current.add(key)
      setRowStatus(key, null)
      try {
        markSelfWrite() // 送る前に印を付ける（自分の書き込みで「他の端末で更新」を出さない）
        const res = await insertOuting({
          resident_id: draft.residentId,
          kind: draft.kind,
          start_on: day,
          start_at: start.value,
          end_on: end.on,
          end_at: end.at,
          companion: draft.companion.trim() === '' ? null : draft.companion.trim(),
          // 外出先・宿泊先は行き先の自由記述として note 列へ入れる
          note: draft.place.trim() === '' ? null : draft.place.trim(),
          recorded_by: actorId,
        })
        if (res === 'queued') {
          patchOutingDraft(key, { locked: true })
          setRowStatus(key, { tone: 'warn', text: isQueuePersisted() ? MSG_QUEUED : MSG_NOT_PERSISTED })
          return
        }
        setOutingDrafts((prev) => prev.filter((d) => d.key !== key))
        if (!stillOnDay(day)) {
          // 応答を待つ間に日付を送られた。保存はできているので、今の画面には足さずに伝える
          show(MSG_SAVED_OTHER_DAY)
          return
        }
        // 同じ id が既に入っていれば入れ替える（再読込と行き違っても行が2つにならない）
        setOutings((prev) => [...prev.filter((o) => o.id !== res.id), res])
        saveOk(`o${res.id}`)
      } catch (err) {
        setRowStatus(key, { tone: 'danger', text: `▲ ${errText(err)}` })
      } finally {
        savingRef.current.delete(key)
      }
    },
    [actorId, day, guard, markSelfWrite, patchOutingDraft, saveOk, setRowStatus, show, stillOnDay],
  )

  /** 帰着（到着日時）の後追い記入。end_on / end_at だけを送る */
  const commitOutingEnd = useCallback(
    (o: Outing, raw: string) => {
      const key = `o${o.id}`
      if (!guard(key)) return
      const parsed = parseDayTime(raw, day)
      if (!parsed.ok) {
        setRowStatus(key, { tone: 'danger', text: parsed.message })
        return
      }
      if (parsed.on === null) {
        setRowStatus(key, {
          tone: 'danger',
          text: '▲ 到着は空にできません。「10:30」または「8/30 10:30」のように入力してください',
        })
        return
      }
      const endOn = parsed.on
      const endAt = parsed.at
      setRowStatus(key, null)
      void (async () => {
        try {
          markSelfWrite() // 送る前に印を付ける（自分の書き込みで「他の端末で更新」を出さない）
          const res = await setOutingEnd(o.id, o.rev, endOn, endAt)
          if (res === 'conflict') {
            setRowStatus(key, { tone: 'danger', text: `▲ ${ERR_CONFLICT}` })
            return
          }
          setOutings((prev) => prev.map((x) => (x.id === o.id ? res : x)))
          saveOk(key)
        } catch (err) {
          setRowStatus(key, { tone: 'danger', text: `▲ ${errText(err)}` })
        }
      })()
    },
    [day, guard, markSelfWrite, saveOk, setRowStatus],
  )

  // ── ピッカーの結果を配る ───────────────────────────────────

  const onPickResident = useCallback(
    (id: number | null) => {
      const target = residentPick
      setResidentPick(null)
      if (!target) return
      if (target.for === 'noteTarget') {
        const draft = noteDrafts.find((d) => d.key === target.key)
        if (draft) {
          patchNoteDraft(target.key, { residentId: id, targetPicked: true })
          return
        }
        const note = notes.find((n) => `n${n.id}` === target.key)
        if (note) void updateNoteCell(note, { resident_id: id }, { resident_id: id })
        // 行き先が見つからない（開いている間に行が保存・削除された）。黙って捨てない
        else show(MSG_PICK_LOST)
        return
      }
      if (id == null) return // 以下のブロックは「全体」を持たない
      if (target.for === 'vitalTarget') {
        patchVitalDraft(target.key, { residentId: id })
        return
      }
      if (target.for === 'outingTarget') {
        // 登録は行末の「登録」を押した時だけ（途中の記入を取りこぼさない）
        patchOutingDraft(target.key, { residentId: id })
      }
    },
    [
      noteDrafts,
      notes,
      patchNoteDraft,
      patchOutingDraft,
      patchVitalDraft,
      residentPick,
      show,
      updateNoteCell,
    ],
  )

  const onPickStaff = useCallback(
    (id: number) => {
      const target = staffPick
      setStaffPick(null)
      if (!target) return
      if (target.for === 'attendance') {
        addAttendance(id, target.role)
        return
      }
      if (target.for === 'noteReporter') {
        const draft = noteDrafts.find((d) => d.key === target.key)
        if (draft) {
          patchNoteDraft(target.key, { reporterId: id })
          return
        }
        const note = notes.find((n) => `n${n.id}` === target.key)
        if (note) void updateNoteCell(note, { reporter_id: id }, { reporter_id: id })
        // 行き先が見つからない（開いている間に行が保存・削除された）。黙って捨てない
        else show(MSG_PICK_LOST)
      }
    },
    [addAttendance, noteDrafts, notes, patchNoteDraft, show, staffPick, updateNoteCell],
  )

  // ── 表示用の仕分け ─────────────────────────────────────────

  const dayNotes = useMemo(() => notes.filter((n) => n.shift === 'day' && !n.after16), [notes])
  const lateNotes = useMemo(() => notes.filter((n) => n.shift === 'day' && n.after16), [notes])
  const careNotes = useMemo(() => notes.filter((n) => n.shift === 'daycare'), [notes])
  const nightNotes = useMemo(() => notes.filter((n) => n.shift === 'night'), [notes])

  const feverRows = useMemo(
    () => buildFeverRows(observations, residentOrder),
    [observations, residentOrder],
  )
  const symptomRows = useMemo(
    () =>
      symptoms
        .slice()
        .sort(
          (a, b) =>
            (residentOrder.get(a.resident_id) ?? Number.MAX_SAFE_INTEGER) -
              (residentOrder.get(b.resident_id) ?? Number.MAX_SAFE_INTEGER) || a.id - b.id,
        ),
    [symptoms, residentOrder],
  )
  const outRows = useMemo(() => outings.filter((o) => o.kind === 'outing'), [outings])
  const stayRows = useMemo(() => outings.filter((o) => o.kind === 'overnight'), [outings])

  const manager = attendance.find((a) => a.role === 'manager') ?? null
  const workers = attendance.filter((a) => a.role !== 'manager')

  /** この日に保存されている記録の数（0 のときは空状態の一言を出す） */
  const savedRows =
    notes.length + observations.length + symptoms.length + outings.length + attendance.length

  // ── 空行の補充（実物のスプシは固定行数）───────────────────
  // 保存済み＋「＋行」で足した行が MIN_ROWS に満たない間だけ、空の入力行を足す。
  // 空行は値が入るまで保存しない（空データを作らない）ので、記録は増えない。
  useEffect(() => {
    if (phase !== 'ready') return
    const needOuting =
      MIN_ROWS.outing - outRows.length - outingDrafts.filter((d) => d.kind === 'outing').length
    const needStay =
      MIN_ROWS.overnight -
      stayRows.length -
      outingDrafts.filter((d) => d.kind === 'overnight').length
    if (needOuting <= 0 && needStay <= 0) return
    const add: OutingDraft[] = []
    for (let i = 0; i < needOuting; i++) add.push(emptyOutingDraft(nextKey('od'), 'outing'))
    for (let i = 0; i < needStay; i++) add.push(emptyOutingDraft(nextKey('od'), 'overnight'))
    setOutingDrafts((prev) => [...prev, ...add])
  }, [phase, outRows.length, stayRows.length, outingDrafts, nextKey])

  useEffect(() => {
    if (phase !== 'ready') return
    const needFever =
      MIN_ROWS.fever - feverRows.length - vitalDrafts.filter((d) => d.kind === 'observation').length
    const needSymptom =
      MIN_ROWS.symptom - symptomRows.length - vitalDrafts.filter((d) => d.kind === 'symptom').length
    if (needFever <= 0 && needSymptom <= 0) return
    const add: VitalDraft[] = []
    for (let i = 0; i < needFever; i++) add.push(emptyVitalDraft(nextKey('vd'), 'observation'))
    for (let i = 0; i < needSymptom; i++) add.push(emptyVitalDraft(nextKey('vd'), 'symptom'))
    setVitalDrafts((prev) => [...prev, ...add])
  }, [phase, feverRows.length, symptomRows.length, vitalDrafts, nextKey])

  // 申し送りは「保存済みの行の下に、いつでも空行が1本ある」形にする
  // （セルに直接書き込む運用なので、記入のたびに「＋行」を押させない）。
  // 付帯ブロックと違って**保存済みの件数は数に入れない**＝末尾の空行が消えない
  useEffect(() => {
    if (phase !== 'ready') return
    const add: NoteDraft[] = []
    const fill = (shift: Shift, after16: boolean) => {
      const have = noteDrafts.filter((d) => d.shift === shift && d.after16 === after16).length
      for (let i = have; i < MIN_ROWS.note; i++) {
        // 記入者の既定は操作者（夜勤は現行運用どおり空のまま）
        add.push(emptyNoteDraft(nextKey('nd'), shift, after16, shift === 'night' ? null : actorId))
      }
    }
    fill('day', false)
    fill('day', true)
    fill('daycare', false)
    fill('night', false)
    if (add.length === 0) return
    setNoteDrafts((prev) => [...prev, ...add])
  }, [phase, actorId, noteDrafts, nextKey])

  const ctx: SheetCtx = {
    day,
    residentById,
    staffById,
    disabled: !enabled,
    status,
    setStatus: setRowStatus,
    openResident: setResidentPick,
    openStaff: setStaffPick,
  }

  return (
    <>
      {/* ヘッダ（施設名・日勤/夜勤日報・出勤者1行・日付）。
          読み込み中・失敗中も出す＝どの日の枠かが常に分かるようにする */}
      <DayHeader
        ctx={ctx}
        day={day}
        manager={manager}
        workers={workers}
        empty={phase === 'ready' && savedRows === 0}
        onPickDay={onPickDay}
        onAddAttendance={(role) => {
          if (!enabled) {
            setRowStatus('attendance', { tone: 'warn', text: `▲ ${blockedReason}` })
            return
          }
          setStaffPick({ for: 'attendance', role })
        }}
        onRemoveAttendance={(staffId) => {
          if (!enabled) {
            setRowStatus('attendance', { tone: 'warn', text: `▲ ${blockedReason}` })
            return
          }
          removeAttendance(staffId)
        }}
      />

      {/* 3状態。失敗したのは**この日だけ**で、他の日は読めたまま残る（部分表示） */}
      {phase === 'loading' && <LoadingBlock label={`${fmtSheetDay(day)}の日報を読み込んでいます…`} />}
      {phase === 'error' && (
        <ErrorBlock message={ERR_LOAD} onRetry={() => setReload((n) => n + 1)} />
      )}

      {phase === 'ready' && (
        <>
          <OutingBlock
            ctx={ctx}
            kind="outing"
            rows={outRows}
            drafts={outingDrafts.filter((d) => d.kind === 'outing')}
            onAdd={() => addOutingDraft('outing')}
            onPatchDraft={patchOutingDraft}
            onRemoveDraft={removeOutingDraft}
            onSaveDraft={saveOutingDraft}
            onCommitEnd={commitOutingEnd}
          />

          <OutingBlock
            ctx={ctx}
            kind="overnight"
            rows={stayRows}
            drafts={outingDrafts.filter((d) => d.kind === 'overnight')}
            onAdd={() => addOutingDraft('overnight')}
            onPatchDraft={patchOutingDraft}
            onRemoveDraft={removeOutingDraft}
            onSaveDraft={saveOutingDraft}
            onCommitEnd={commitOutingEnd}
          />

          <FeverBlock
            ctx={ctx}
            rows={feverRows}
            drafts={vitalDrafts.filter((d) => d.kind === 'observation')}
            onAdd={() => addVitalDraft('observation')}
            onPatchDraft={patchVitalDraft}
            onRemoveDraft={removeVitalDraft}
            onInsert={insertVitalRow}
            onUpdate={updateVitalCell}
          />

          <SymptomBlock
            ctx={ctx}
            rows={symptomRows}
            drafts={vitalDrafts.filter((d) => d.kind === 'symptom')}
            onAdd={() => addVitalDraft('symptom')}
            onPatchDraft={patchVitalDraft}
            onRemoveDraft={removeVitalDraft}
            onInsert={insertVitalRow}
            onUpdate={updateVitalCell}
          />

          <NoteBlock
            ctx={ctx}
            title="日勤申し送り"
            tone="note"
            rows={dayNotes}
            drafts={noteDrafts.filter((d) => d.shift === 'day' && !d.after16)}
            showReporter
            actorId={actorId}
            expanded={expanded}
            onToggleExpand={(k) => setExpanded((cur) => (cur === k ? null : k))}
            onAdd={() => addNoteDraft('day', false)}
            onCommitBody={commitNoteBody}
            onPatchDraft={patchNoteDraft}
            onUpdateNote={updateNoteCell}
            onDelete={deleteNoteRow}
            onMarkRead={markNoteRead}
          />

          {/* 現行スプシの黒帯。ここから下は after16=true の記録 */}
          <div
            className="flex items-center bg-ink px-1 font-bold text-bg"
            style={{ minHeight: 'var(--sheet-row-h-note)' }}
          >
            ↓16時以降の記録
          </div>

          <NoteBlock
            ctx={ctx}
            title="日勤申し送り（16時以降）"
            tone="note"
            rows={lateNotes}
            drafts={noteDrafts.filter((d) => d.shift === 'day' && d.after16)}
            showReporter
            actorId={actorId}
            expanded={expanded}
            onToggleExpand={(k) => setExpanded((cur) => (cur === k ? null : k))}
            onAdd={() => addNoteDraft('day', true)}
            onCommitBody={commitNoteBody}
            onPatchDraft={patchNoteDraft}
            onUpdateNote={updateNoteCell}
            onDelete={deleteNoteRow}
            onMarkRead={markNoteRead}
          />

          {/* デイサービスは日勤・夜勤の申し送りと運営主体が違うので、上下に余白を入れて
              前後の欄から離す（2026-08-28 指示）。余白は日が変わる切れ目より狭い12px */}
          <NoteBlock
            ctx={ctx}
            className="dsheet-gap-block"
            title="デイサービス"
            tone="care"
            rows={careNotes}
            drafts={noteDrafts.filter((d) => d.shift === 'daycare')}
            showReporter
            actorId={actorId}
            expanded={expanded}
            onToggleExpand={(k) => setExpanded((cur) => (cur === k ? null : k))}
            onAdd={() => addNoteDraft('daycare', false)}
            onCommitBody={commitNoteBody}
            onPatchDraft={patchNoteDraft}
            onUpdateNote={updateNoteCell}
            onDelete={deleteNoteRow}
            onMarkRead={markNoteRead}
          />

          <NoteBlock
            ctx={ctx}
            title="夜勤申し送り"
            tone="night"
            rows={nightNotes}
            drafts={noteDrafts.filter((d) => d.shift === 'night')}
            showReporter={false}
            actorId={actorId}
            expanded={expanded}
            onToggleExpand={(k) => setExpanded((cur) => (cur === k ? null : k))}
            onAdd={() => addNoteDraft('night', false)}
            onCommitBody={commitNoteBody}
            onPatchDraft={patchNoteDraft}
            onUpdateNote={updateNoteCell}
            onDelete={deleteNoteRow}
            onMarkRead={markNoteRead}
          />
        </>
      )}

      <ResidentPickerModal
        open={residentPick !== null}
        residents={residents}
        onPick={onPickResident}
        onClose={() => setResidentPick(null)}
        allowAll={residentPick?.for === 'noteTarget'}
        // 申し送りの対象を選ぶ時だけ「申し送りでの表示名」を主に出す。
        // 発熱者・他症状者・外出外泊の対象選びはマスタの氏名のまま（2026-09-01 指示の範囲）
        useNoteAlias={residentPick?.for === 'noteTarget'}
      />
      <StaffPickerModal
        open={staffPick !== null}
        staff={staff}
        onPick={onPickStaff}
        onClose={() => setStaffPick(null)}
        title={staffPick?.for === 'attendance' ? '出勤者を選ぶ' : '記入者を選ぶ'}
      />
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        body={confirm?.body}
        confirmLabel={confirm?.confirmLabel}
        danger
        onConfirm={() => confirm?.onConfirm()}
        onCancel={() => setConfirm(null)}
      />
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// ブロック共通の受け渡し
// ══════════════════════════════════════════════════════════════

interface SheetCtx {
  day: string
  residentById: Map<number, Resident>
  staffById: Map<number, Staff>
  /** 入力封鎖中・観測できていない間は true（セルを読み取り専用にする） */
  disabled: boolean
  status: Record<string, RowStatus>
  setStatus: (key: string, s: RowStatus | null) => void
  openResident: (t: PickTarget) => void
  openStaff: (t: PickTarget) => void
}

// ══════════════════════════════════════════════════════════════
// 日付バー
// ══════════════════════════════════════════════════════════════

/**
 * 日付バー（シートの外・44px の操作領域）。
 * 1〜31 の横並びボタンは撤去した（指示1）。日にちはカレンダー（input[type=date]）で選ぶ。
 * ここに置く日付欄は「スクロールしなくても日を移せる」ための入口で、
 * シートの中の日付セル（DayPicker）と同じ働きをする。
 */
function DateBar({
  day,
  unit,
  onGo,
  onUnit,
}: {
  day: string
  unit: SheetUnit
  onGo: (iso: string) => void
  onUnit: (unit: SheetUnit) => void
}) {
  const today = todayIso()
  return (
    <div className="flex flex-wrap items-center gap-gap">
      <button
        type="button"
        onClick={() => onGo(addDays(day, -1))}
        aria-label="前の日を見る"
        className="min-h-tap min-w-tap rounded-md border border-border-strong px-3 text-base text-ink"
      >
        <span aria-hidden="true">‹</span>
      </button>
      <label className="flex min-h-tap items-center gap-gap text-base text-ink">
        <span className="text-ink2">日付</span>
        <input
          type="date"
          value={day}
          onChange={(e) => onGo(e.target.value)}
          aria-label={`日報の日付 ${fmtSheetDay(day)}。カレンダーから選べます`}
          className="min-h-tap rounded-md border border-border-strong bg-surface px-2 text-base text-ink"
        />
      </label>
      <button
        type="button"
        onClick={() => onGo(addDays(day, 1))}
        aria-label="次の日を見る"
        className="min-h-tap min-w-tap rounded-md border border-border-strong px-3 text-base text-ink"
      >
        <span aria-hidden="true">›</span>
      </button>
      {day !== today && (
        <button
          type="button"
          onClick={() => onGo(today)}
          className="min-h-tap rounded-md border border-primary px-3 text-base font-bold text-primary"
        >
          今日へ
        </button>
      )}

      {/* 表示単位（既定は10日）。選択中は 枠色＋太字＋「✓」で示す（色だけに頼らない） */}
      <div role="group" aria-label="表示単位" className="flex items-center gap-gap">
        <span aria-hidden="true" className="text-sm text-ink2">
          表示
        </span>
        {(
          [
            { value: '10' as SheetUnit, label: '10日', hint: '10日ごとに表示' },
            { value: '1' as SheetUnit, label: '1日', hint: '1日だけ表示' },
          ] as const
        ).map((o) => {
          const selected = o.value === unit
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={selected}
              aria-label={o.hint}
              onClick={() => onUnit(o.value)}
              className={
                selected
                  ? 'min-h-tap min-w-tap rounded border border-primary bg-primary px-2 text-sm font-bold text-primary-ink'
                  : 'min-h-tap min-w-tap rounded border border-border bg-surface px-2 text-sm text-ink'
              }
            >
              <span aria-hidden="true" className={selected ? '' : 'invisible'}>
                ✓
              </span>
              {o.label}
            </button>
          )
        })}
      </div>

      <div className="ml-auto">
        <ZoomBar />
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 1日ぶんのヘッダ（施設名・日報タイトル・出勤者1行・日付）
// ══════════════════════════════════════════════════════════════

/**
 * 日付セル（指示1・4・12）。見えている文字は実物と同じ「26年8月28日(金)」で、
 * 実際に押されるのは重ねた input[type=date]。
 *
 * 指示4「各日付をクリックするとカレンダーが開く」:
 *   input を重ねただけでは、多くのブラウザで**カレンダーのアイコンを押した時しか**
 *   カレンダーが開かない（アイコンは opacity:0 で見えていない＝実質開けない）。
 *   そこで押した時・Enter / Space を押した時に showPicker() を呼んで確実に開く。
 *   showPicker() が無い環境（未対応・利用者操作から外れた呼び出しで例外）では
 *   既定動作を止めないので、**従来どおりのネイティブの日付入力**として使える。
 *
 * 指示12「土曜＝濃い水色・日曜＝赤」:
 *   sheet.css の .sheet-sat / .sheet-sun を日付セルに付ける。
 *   ※ 枠（.dsheet-date）は sheet.css で .sheet-sat / .sheet-sun より後に
 *     background: var(--c-surface) を宣言しているため、**枠の地色は上書きできない**。
 *     いま色が乗るのは日付の文字（下の span）まで。枠ごと色を敷くには sheet.css 側に
 *     .dsheet-date.sheet-sat / .dsheet-date.sheet-sun の指定が要る（チーフへ申し送り済み）。
 */
function DayPicker({
  day,
  onPick,
  head = false,
}: {
  day: string
  onPick: (iso: string) => void
  /** 1日ぶんの枠の左上（旧・施設名セル）に置く形。セルいっぱいに広げ、平日は橙を敷く */
  head?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const tone = weekendClass(day)

  /** カレンダーを開く。開けない環境では何もしない＝既定の日付入力のまま使える */
  const openPicker = (): boolean => {
    const el = inputRef.current
    if (el === null) return false
    // showPicker() は比較的新しい API。型・実体の両方が無い環境を想定して都度確かめる
    const withPicker = el as HTMLInputElement & { showPicker?: () => void }
    if (typeof withPicker.showPicker !== 'function') return false
    try {
      withPicker.showPicker()
      return true
    } catch {
      // 利用者の操作から外れた呼び出し等で開けなかった。入力欄としては今までどおり使える
      return false
    }
  }

  return (
    <label className={`dsheet-date ${head ? 'dsheet-date-head' : ''} ${tone}`}>
      {/* 平日は今までどおり text-ink。土日は .sheet-sat / .sheet-sun が文字色も持つので重ねない */}
      <span aria-hidden="true" className={`text-lg font-bold tabular ${tone === '' ? 'text-ink' : tone}`}>
        {fmtSheetDay(day)}
      </span>
      <input
        ref={inputRef}
        type="date"
        className="dsheet-date-input"
        value={day}
        onChange={(e) => onPick(e.target.value)}
        // 入力欄が枠いっぱいに重なっているので、日付の文字を押してもここへ届く
        onClick={() => openPicker()}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          // 開ける時だけ既定動作を止める（開けない環境ではキーボード入力を妨げない）
          if (openPicker()) e.preventDefault()
        }}
        aria-label={`日報の日付 ${fmtSheetDay(day)}。押すとカレンダーから日にちを選べます`}
      />
    </label>
  )
}

/** 出勤者の1枠（実物のスプシと同じ固定幅のセル） */
function AttendCell({
  label,
  name,
  disabled,
  onClick,
}: {
  /** 読み上げ用の説明（「施設長 ○○ を取り消す」「出勤者を追加する」） */
  label: string
  /** 空欄なら「＋」を出す */
  name: string | null
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Cell width="var(--w-attend)" pad={false} className="flex items-center">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={`${CELL_HIT} sheet-dense-btn w-full rounded-sm px-1 text-left ${
          disabled ? 'text-ink2' : 'text-link'
        }`}
      >
        <span className="block truncate">
          {name === null ? <span aria-hidden="true">＋</span> : name}
          {name !== null && !disabled ? (
            <span aria-hidden="true" className="sheet-mark">
              {' '}
              ✕
            </span>
          ) : null}
        </span>
      </button>
    </Cell>
  )
}

function DayHeader({
  ctx,
  day,
  manager,
  workers,
  empty,
  onPickDay,
  onAddAttendance,
  onRemoveAttendance,
}: {
  ctx: SheetCtx
  day: string
  manager: Attendance | null
  workers: Attendance[]
  /** この日にまだ記録が1件も無い（空状態の一言を出す） */
  empty: boolean
  onPickDay: (iso: string) => void
  onAddAttendance: (role: 'manager' | 'staff') => void
  onRemoveAttendance: (staffId: number) => void
}) {
  const managerName =
    manager === null ? null : staffName(ctx.staffById.get(manager.staff_id), manager.staff_id)
  return (
    <div className="border-b border-border-strong">
      {/* 1段目: 左＝日付（2026-08-31 指示。旧・施設名セルの位置。平日は橙・土日は水色/赤）、
          右＝施設長のとなりに出勤者が横1行（指示6）。
          施設名と「日勤・夜勤日報」はここから外し、施設名は画面最上部の「日報」の右へ移した
          （各日ごとに繰り返す情報ではなく、日付を置くほうがこの位置の役に立つ） */}
      <div className="flex flex-wrap items-stretch">
        <div
          className="shrink-0 border-r border-border"
          // 幅は左上セル専用の --w-facility のまま（出勤者の15枠は残りの幅で足りる。sheet.css の計算参照）
          style={{ width: 'var(--w-facility)', minHeight: 'var(--sheet-row-h-note)' }}
        >
          <DayPicker day={day} onPick={onPickDay} head />
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-stretch">
          <Cell width="var(--w-attend-label)" className="flex items-center bg-surface2 font-bold text-ink2">
            <span className="truncate">施設長</span>
          </Cell>
          <AttendCell
            label={
              managerName === null
                ? '施設長を選ぶ'
                : `施設長 ${managerName} を取り消す`
            }
            name={managerName}
            disabled={ctx.disabled}
            onClick={() =>
              manager === null ? onAddAttendance('manager') : onRemoveAttendance(manager.staff_id)
            }
          />
          <Cell width="var(--w-attend-label)" className="flex items-center bg-surface2 font-bold text-ink2">
            <span className="truncate">出勤者</span>
          </Cell>
          {workers.map((a) => (
            <AttendCell
              key={a.staff_id}
              label={`出勤者 ${staffName(ctx.staffById.get(a.staff_id), a.staff_id)} を取り消す`}
              name={staffName(ctx.staffById.get(a.staff_id), a.staff_id)}
              disabled={ctx.disabled}
              onClick={() => onRemoveAttendance(a.staff_id)}
            />
          ))}
          <AttendCell
            label="出勤者を追加する"
            name={null}
            disabled={ctx.disabled}
            onClick={() => onAddAttendance('staff')}
          />
        </div>
      </div>
      <StatusText status={ctx.status.attendance} />

      {/* 2段目: 記録が1件も無い日の一言だけ。日付は1段目へ移したので、
          記録のある日はこの行ごと出さない（行数を減らす・2026-08-31 指示） */}
      {empty && (
        <p className="px-1 py-1 text-ink2">
          <span aria-hidden="true">— </span>
          この日の記録はまだありません（空いている行にそのまま記入できます）
        </p>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 外出者・外泊者
// ══════════════════════════════════════════════════════════════

function OutingBlock({
  ctx,
  kind,
  rows,
  drafts,
  onAdd,
  onPatchDraft,
  onRemoveDraft,
  onSaveDraft,
  onCommitEnd,
}: {
  ctx: SheetCtx
  kind: OutingKind
  rows: Outing[]
  drafts: OutingDraft[]
  onAdd: () => void
  onPatchDraft: (key: string, patch: Partial<OutingDraft>) => void
  /** 追加した行の取り消し（未保存の行のみ） */
  onRemoveDraft: (key: string) => void
  onSaveDraft: (draft: OutingDraft) => Promise<void>
  onCommitEnd: (o: Outing, raw: string) => void
}) {
  const isStay = kind === 'overnight'
  const title = isStay ? '外泊者' : '外出者'
  const placeLabel = isStay ? '宿泊先' : '外出先'
  const startLabel = isStay ? '出発日時' : '出発時刻'
  const endLabel = isStay ? '到着日時' : '到着時刻'
  const count = rows.length

  return (
    <SheetBlock
      title={title}
      onAdd={onAdd}
      head={
        <>
          <HeadCell width="var(--w-name)">氏名</HeadCell>
          <HeadCell grow>{placeLabel}</HeadCell>
          <HeadCell width="var(--w-datelink)">{startLabel}</HeadCell>
          {/* 実物の「〜」（出発と到着の間の細い列） */}
          <HeadCell width="var(--w-tilde)">
            <span aria-hidden="true">〜</span>
          </HeadCell>
          <HeadCell width="var(--w-datelink)">{endLabel}</HeadCell>
          <HeadCell width="var(--w-target)">付添</HeadCell>
          <HeadCell width="var(--w-reporter)">登録</HeadCell>
        </>
      }
    >
      {rows.map((o, i) => {
        const key = `o${o.id}`
        const name = residentName(ctx.residentById.get(o.resident_id), o.resident_id)
        return (
          <div key={key}>
            {/* 1行おきの縞（指示16）。保存済みの行 → 追加した行 の並び順で数える */}
            <Row className={altClass(i)}>
              <LeadCell text={i === 0 ? `${count}名` : ''} />
              <Cell width="var(--w-name)" className="flex items-center">
                <span className="truncate font-bold">{name}</span>
              </Cell>
              <Cell grow className="flex items-center">
                <span className="truncate">{o.note ?? ''}</span>
              </Cell>
              <Cell width="var(--w-datelink)" className="flex items-center">
                <span className="tabular">
                  {o.start_on !== ctx.day
                    ? fmtDayTime(o.start_on, o.start_at, ctx.day)
                    : fmtTimeHM(o.start_at)}
                </span>
              </Cell>
              <Cell width="var(--w-tilde)" className="flex items-center">
                <span aria-hidden="true" className="text-ink3">
                  〜
                </span>
              </Cell>
              {/* 余白は SheetCell 側だけが持つ（入れ物にも取ると列見出しと左端がずれる） */}
              <Cell width="var(--w-datelink)" pad={false}>
                <SheetCell
                  value={fmtDayTime(o.end_on, o.end_at, ctx.day)}
                  onCommit={ctx.disabled ? undefined : (v) => onCommitEnd(o, v)}
                  width="100%"
                  align="left"
                  placeholder={isStay ? '例 8/30 10:30' : '例 10:30'}
                  ariaLabel={`${name} の${endLabel}`}
                  as="div"
                  // 行の地色（縞・書きかけの行）を透かす。既定の plain は不透明な白を敷くので
                  // このセルだけ縞が白く抜ける（指示16「縞は行の器」）
                  tone="row"
                />
              </Cell>
              <Cell width="var(--w-target)" className="flex items-center">
                <span className="truncate">{o.companion ?? ''}</span>
              </Cell>
              <Cell width="var(--w-reporter)" className="flex items-center">
                <span className="text-ok">
                  <span aria-hidden="true">✓ </span>登録済
                </span>
              </Cell>
            </Row>
            {o.end_on == null && (
              <p className="px-1 text-warn">
                <span aria-hidden="true">▲ </span>帰着未定（{endLabel}を記入すると確定します）
              </p>
            )}
            <StatusText status={ctx.status[key]} />
          </div>
        )
      })}

      {drafts.map((d, di) => {
        const name = d.residentId == null ? '' : residentName(ctx.residentById.get(d.residentId), d.residentId)
        const disabled = ctx.disabled || d.locked
        // 記入は下書きに貯め、行末の「登録」で1件として保存する
        // （外出・外泊は保存後の項目更新APIが無いため、途中保存にすると直せなくなる）
        const trySave = (patch: Partial<OutingDraft>) => onPatchDraft(d.key, patch)
        const dirty =
          d.residentId != null ||
          d.place.trim() !== '' ||
          d.startAt !== '' ||
          d.endText !== '' ||
          d.companion.trim() !== ''
        const ready =
          d.residentId != null &&
          (d.place.trim() !== '' || d.startAt !== '' || d.endText !== '' || d.companion.trim() !== '')
        return (
          <div key={d.key}>
            {/* 空の行は実物のスプシと同じ「固定の空欄」。書き始めた行だけ背景を変える。
                書きかけでない行は1行おきの縞（指示16）。書きかけの背景は縞より優先する
                ＝どの行を書いているかの合図を縞で消さない */}
            <Row className={dirty ? 'bg-surface2' : altClass(rows.length + di)}>
              <LeadCell text={rows.length === 0 && di === 0 ? `${count}名` : ''} />
              <PickerCell
                width="var(--w-name)"
                text={name}
                label={name === '' ? '対象の利用者を選ぶ' : `対象 ${name}。押すと選び直します`}
                disabled={disabled}
                onClick={() => ctx.openResident({ for: 'outingTarget', key: d.key })}
              />
              <Cell grow pad={false}>
                <SheetCell
                  value={d.place}
                  onCommit={disabled ? undefined : (v) => trySave({ place: v })}
                  width="100%"
                  align="left"
                  placeholder={placeLabel}
                  ariaLabel={placeLabel}
                  as="div"
                  tone="row"
                />
              </Cell>
              <Cell width="var(--w-datelink)" pad={false}>
                <SheetCell
                  value={d.startAt}
                  onCommit={disabled ? undefined : (v) => trySave({ startAt: v })}
                  width="100%"
                  align="left"
                  placeholder="例 10:30"
                  ariaLabel={startLabel}
                  as="div"
                  tone="row"
                />
              </Cell>
              <Cell width="var(--w-tilde)" className="flex items-center">
                <span aria-hidden="true" className="text-ink3">
                  〜
                </span>
              </Cell>
              <Cell width="var(--w-datelink)" pad={false}>
                <SheetCell
                  value={d.endText}
                  onCommit={disabled ? undefined : (v) => trySave({ endText: v })}
                  width="100%"
                  align="left"
                  placeholder={isStay ? '例 8/30 10:30' : '例 10:30'}
                  ariaLabel={endLabel}
                  as="div"
                  tone="row"
                />
              </Cell>
              <Cell width="var(--w-target)" pad={false}>
                <SheetCell
                  value={d.companion}
                  onCommit={disabled ? undefined : (v) => trySave({ companion: v })}
                  width="100%"
                  align="left"
                  placeholder="付添"
                  ariaLabel="付添"
                  as="div"
                  tone="row"
                />
              </Cell>
              {/* 余白はボタン（px-1）だけが持つ */}
              <Cell width="var(--w-reporter)" pad={false} className="flex items-center">
                <button
                  type="button"
                  onClick={() => void onSaveDraft(d)}
                  disabled={disabled || !ready}
                  aria-label={`この${title}の行を登録する`}
                  style={ROW_BTN_STYLE}
                  className={`${CELL_HIT} w-full rounded-sm px-1 font-bold ${
                    disabled || !ready ? 'text-ink3' : 'text-link'
                  }`}
                >
                  登録
                </button>
              </Cell>
            </Row>
            {/* 空欄のままの行には案内も取り消しも出さない（実物と同じ「ただの空行」にする）。
                書き始めた行・送信待ちの行にだけ、次にどうすればよいかを1行で添える */}
            {dirty && (
              <p className="flex flex-wrap items-center gap-gap px-1 text-ink2">
                {d.locked ? (
                  <span className="flex-1 text-warn">
                    <span aria-hidden="true">▲ </span>
                    {MSG_LOCKED_DELETE}
                  </span>
                ) : !ready ? (
                  <span className="flex-1">
                    <span aria-hidden="true">ⓘ </span>
                    氏名と、行き先・時刻・付添のいずれかを記入すると「登録」を押せます（押すまで保存しません）
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => onRemoveDraft(d.key)}
                  disabled={d.locked}
                  className="sheet-dense-btn rounded-sm border border-border-strong px-1 text-link disabled:border-border disabled:text-ink3"
                >
                  この行を取り消す
                </button>
              </p>
            )}
            <StatusText status={ctx.status[d.key]} />
          </div>
        )
      })}
    </SheetBlock>
  )
}

// ══════════════════════════════════════════════════════════════
// 発熱者（時 KT SpO2 BP P × 3セット）
// ══════════════════════════════════════════════════════════════

type InsertVitalFn = (
  rowKey: string,
  residentId: number,
  kind: 'observation' | 'symptom',
  fields: Partial<Omit<Vital, 'id' | 'rev' | 'resident_id' | 'measured_on' | 'kind'>>,
  draftKey: string | null,
) => Promise<void>

type UpdateVitalFn = (
  v: Vital,
  patch: Partial<Omit<Vital, 'id' | 'rev'>>,
  rowKey: string,
  clearing: boolean,
  label: string,
) => void

/** 1枠（時 KT SpO2 BP P）の描画。保存済みなら update、空き枠なら insert を呼ぶ */
function VitalSetCells({
  name,
  vital,
  input,
  disabled,
  onInput,
  onCommit,
  onError,
}: {
  name: string
  vital: Vital | null
  input: VitalSetInput | null
  disabled: boolean
  onInput?: (patch: Partial<VitalSetInput>) => void
  onCommit: (patch: Partial<Omit<Vital, 'id' | 'rev'>>, clearing: boolean, label: string) => void
  /** 入力の書式・範囲エラー（保存はしない） */
  onError: (message: string) => void
}) {
  const val = (f: keyof VitalSetInput): string => {
    if (input) return input[f]
    if (!vital) return ''
    if (f === 'at') return fmtTimeHM(vital.measured_at)
    if (f === 'temp') return vital.temp == null ? '' : vital.temp.toFixed(1)
    if (f === 'spo2') return vital.spo2 == null ? '' : String(vital.spo2)
    if (f === 'pulse') return vital.pulse == null ? '' : String(vital.pulse)
    return fmtBp(vital.sys_bp, vital.dia_bp)
  }

  const commit = (f: keyof VitalSetInput, raw: string) => {
    if (onInput) onInput({ [f]: raw } as Partial<VitalSetInput>)
    if (f === 'at') {
      const t = parseHM(raw)
      if (!t.ok) return onError(t.message)
      return onCommit({ measured_at: t.value }, t.value === null, '時刻')
    }
    if (f === 'bp') {
      const bp = parseBp(raw)
      if (!bp.ok) return onError(bp.message)
      // 「125」のように片側だけ入れると、もう片側は null＝消去になる。
      // 保存済みの値を消す側があれば確認を出す（空上書き保護。両方空の時だけでは足りない）
      const cleared: string[] = []
      if (bp.sys === null && vital?.sys_bp != null) cleared.push(VITAL_FIELD_LABEL.sys_bp)
      if (bp.dia === null && vital?.dia_bp != null) cleared.push(VITAL_FIELD_LABEL.dia_bp)
      return onCommit(
        { sys_bp: bp.sys, dia_bp: bp.dia },
        cleared.length > 0,
        cleared.length > 0 ? cleared.join('・') : VITAL_FIELD_LABEL.sys_bp,
      )
    }
    const field = f === 'temp' ? 'temp' : f === 'spo2' ? 'spo2' : 'pulse'
    const res = parseNum(raw, field)
    if (!res.ok) return onError(res.message)
    return onCommit({ [field]: res.value } as Partial<Vital>, res.value === null, VITAL_FIELD_LABEL[field])
  }

  const cell = (
    f: keyof VitalSetInput,
    width: string,
    label: string,
    level: Level,
  ) => (
    // 左右余白は SheetCell の中のボタンが持つ（ここで重ねると記号が入る幅が無くなる）
    <Cell width={width} pad={false}>
      <SheetCell
        value={val(f)}
        onCommit={disabled ? undefined : (v) => commit(f, v)}
        width="100%"
        align="right"
        level={level}
        ariaLabel={`${name} ${label}`}
        as="div"
        // 行の地色（縞・書きかけの行）を透かす。しきい値がある時は SheetCell 側で
        // level の色が優先されるので、意味のある色は縞に負けない（指示16）
        tone="row"
      />
    </Cell>
  )

  return (
    <>
      {cell('at', 'var(--w-pulse)', '時刻', null)}
      {cell('temp', 'var(--w-temp)', VITAL_FIELD_LABEL.temp, vital ? tempLevel(vital.temp) : null)}
      {cell('spo2', 'var(--w-spo2)', VITAL_FIELD_LABEL.spo2, vital ? spo2Level(vital.spo2) : null)}
      {cell('bp', W_BP, '血圧', vital ? bpLevel(vital.sys_bp, vital.dia_bp) : null)}
      {cell('pulse', 'var(--w-pulse)', VITAL_FIELD_LABEL.pulse, vital ? pulseLevel(vital.pulse) : null)}
    </>
  )
}

function FeverBlock({
  ctx,
  rows,
  drafts,
  onAdd,
  onPatchDraft,
  onRemoveDraft,
  onInsert,
  onUpdate,
}: {
  ctx: SheetCtx
  rows: FeverRow[]
  drafts: VitalDraft[]
  onAdd: () => void
  onPatchDraft: (key: string, patch: Partial<VitalDraft>) => void
  /** 追加した行の取り消し（未保存の行のみ） */
  onRemoveDraft: (key: string) => void
  onInsert: InsertVitalFn
  onUpdate: UpdateVitalFn
}) {
  const count = rows.length
  return (
    <SheetBlock
      title="発熱者"
      onAdd={onAdd}
      head={
        <>
          <HeadCell width="var(--w-name)">氏名</HeadCell>
          {Array.from({ length: FEVER_SETS }, (_, i) => (
            <Fragment key={i}>
              <HeadCell width="var(--w-pulse)">{`${i + 1}回目 時`}</HeadCell>
              <HeadCell width="var(--w-temp)">体温</HeadCell>
              <HeadCell width="var(--w-spo2)">SpO2</HeadCell>
              <HeadCell width={W_BP}>血圧</HeadCell>
              <HeadCell width="var(--w-pulse)">脈</HeadCell>
            </Fragment>
          ))}
        </>
      }
    >
      {rows.map((row, i) => {
        const name = residentName(ctx.residentById.get(row.residentId), row.residentId)
        return (
          <div key={row.key}>
            {/* 1行おきの縞（指示16） */}
            <Row className={altClass(i)}>
              <LeadCell text={i === 0 ? `${count}名` : ''} />
              <Cell width="var(--w-name)" className="flex items-center">
                <span className="truncate font-bold">{name}</span>
              </Cell>
              {row.slots.map((v, i) => (
                <VitalSetCells
                  key={i}
                  name={`${name} ${i + 1}回目`}
                  vital={v}
                  input={null}
                  disabled={ctx.disabled}
                  onError={(m) => ctx.setStatus(row.key, { tone: 'danger', text: m })}
                  onCommit={(patch, clearing, label) => {
                    if (v) onUpdate(v, patch, row.key, clearing, label)
                    // 空き枠は「値が入った時」だけ行を作る（空欄の確定で空行を作らない）
                    else if (hasVitalValue(patch))
                      void onInsert(row.key, row.residentId, 'observation', patch, null)
                  }}
                />
              ))}
            </Row>
            <StatusText status={ctx.status[row.key]} />
          </div>
        )
      })}

      {drafts.map((d, di) => {
        const name = d.residentId == null ? '' : residentName(ctx.residentById.get(d.residentId), d.residentId)
        const disabled = ctx.disabled || d.locked
        const dirty =
          d.residentId != null || d.sets.some((s) => s.at || s.temp || s.spo2 || s.bp || s.pulse)
        return (
          <div key={d.key}>
            {/* 空の行は実物と同じ「固定の空欄」。書き始めた行だけ背景を変える。
                書きかけでない行は1行おきの縞（指示16。書きかけの背景を縞で消さない） */}
            <Row className={dirty ? 'bg-surface2' : altClass(rows.length + di)}>
              <LeadCell text={rows.length === 0 && di === 0 ? `${count}名` : ''} />
              <PickerCell
                width="var(--w-name)"
                text={name}
                label={name === '' ? '対象の利用者を選ぶ' : `対象 ${name}。押すと選び直します`}
                disabled={disabled}
                onClick={() => ctx.openResident({ for: 'vitalTarget', key: d.key })}
              />
              {d.sets.map((s, i) => (
                <VitalSetCells
                  key={i}
                  name={`${name === '' ? '未選択' : name} ${i + 1}回目`}
                  vital={null}
                  input={s}
                  // 2回目以降は1回目を保存してから記入する（保存前に消えてしまう入力を作らない）
                  disabled={disabled || i > 0}
                  onError={(m) => ctx.setStatus(d.key, { tone: 'danger', text: m })}
                  onInput={(patch) =>
                    onPatchDraft(d.key, {
                      sets: d.sets.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                    })
                  }
                  onCommit={(patch) => {
                    if (d.residentId == null) return
                    // 同じ枠に先に入れてある値も一緒に送る（1セルずつ消えないように）
                    const merged = { ...setToPatch(s), ...patch }
                    // 値が1つも無ければ保存しない（空欄の確定で空行を作らない）
                    if (!hasVitalValue(merged)) return
                    void onInsert(d.key, d.residentId, 'observation', merged, d.key)
                  }}
                />
              ))}
            </Row>
            {/* 空欄のままの行には案内も取り消しも出さない（実物と同じ「ただの空行」にする） */}
            {dirty && (
              <p className="flex flex-wrap items-center gap-gap px-1 text-ink2">
                {d.locked ? (
                  <span className="flex-1 text-warn">
                    <span aria-hidden="true">▲ </span>
                    {MSG_LOCKED_DELETE}
                  </span>
                ) : (
                  <span className="flex-1">
                    <span aria-hidden="true">ⓘ </span>
                    {d.residentId == null
                      ? '氏名を選び、1回目の値を入れると保存します'
                      : '1回目の値を入れると保存します（2回目以降は保存後に記入できます）'}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveDraft(d.key)}
                  disabled={d.locked}
                  className="sheet-dense-btn rounded-sm border border-border-strong px-1 text-link disabled:border-border disabled:text-ink3"
                >
                  この行を取り消す
                </button>
              </p>
            )}
            <StatusText status={ctx.status[d.key]} />
          </div>
        )
      })}
    </SheetBlock>
  )
}

// ══════════════════════════════════════════════════════════════
// 他症状者（時 KT SpO2 BP P ＋ 症状）
// ══════════════════════════════════════════════════════════════

function SymptomBlock({
  ctx,
  rows,
  drafts,
  onAdd,
  onPatchDraft,
  onRemoveDraft,
  onInsert,
  onUpdate,
}: {
  ctx: SheetCtx
  rows: Vital[]
  drafts: VitalDraft[]
  onAdd: () => void
  onPatchDraft: (key: string, patch: Partial<VitalDraft>) => void
  /** 追加した行の取り消し（未保存の行のみ） */
  onRemoveDraft: (key: string) => void
  onInsert: InsertVitalFn
  onUpdate: UpdateVitalFn
}) {
  const count = rows.length
  return (
    <SheetBlock
      title="他症状者"
      onAdd={onAdd}
      head={
        <>
          <HeadCell width="var(--w-name)">氏名</HeadCell>
          <HeadCell width="var(--w-pulse)">時</HeadCell>
          <HeadCell width="var(--w-temp)">体温</HeadCell>
          <HeadCell width="var(--w-spo2)">SpO2</HeadCell>
          <HeadCell width={W_BP}>血圧</HeadCell>
          <HeadCell width="var(--w-pulse)">脈</HeadCell>
          <HeadCell grow>症状</HeadCell>
        </>
      }
    >
      {rows.map((v, i) => {
        const key = `s${v.id}`
        const name = residentName(ctx.residentById.get(v.resident_id), v.resident_id)
        return (
          <div key={key}>
            {/* 1行おきの縞（指示16） */}
            <Row className={altClass(i)}>
              <LeadCell text={i === 0 ? `${count}名` : ''} />
              <Cell width="var(--w-name)" className="flex items-center">
                <span className="truncate font-bold">{name}</span>
              </Cell>
              <VitalSetCells
                name={name}
                vital={v}
                input={null}
                disabled={ctx.disabled}
                onError={(m) => ctx.setStatus(key, { tone: 'danger', text: m })}
                onCommit={(patch, clearing, label) => onUpdate(v, patch, key, clearing, label)}
              />
              <Cell grow pad={false}>
                <SheetCell
                  value={v.symptom ?? ''}
                  onCommit={
                    ctx.disabled
                      ? undefined
                      : (raw) =>
                          onUpdate(
                            v,
                            { symptom: raw.trim() === '' ? null : raw.trim() },
                            key,
                            raw.trim() === '' && (v.symptom ?? '') !== '',
                            '症状',
                          )
                  }
                  width="100%"
                  align="left"
                  multiline
                  placeholder="症状"
                  ariaLabel={`${name} の症状`}
                  as="div"
                  tone="row"
                />
              </Cell>
            </Row>
            <StatusText status={ctx.status[key]} />
          </div>
        )
      })}

      {drafts.map((d, di) => {
        const name = d.residentId == null ? '' : residentName(ctx.residentById.get(d.residentId), d.residentId)
        const disabled = ctx.disabled || d.locked
        const set = d.sets[0] ?? emptySet()
        const dirty =
          d.residentId != null ||
          d.symptom.trim() !== '' ||
          Boolean(set.at || set.temp || set.spo2 || set.bp || set.pulse)
        return (
          <div key={d.key}>
            {/* 空の行は実物と同じ「固定の空欄」。書き始めた行だけ背景を変える。
                書きかけでない行は1行おきの縞（指示16。書きかけの背景を縞で消さない） */}
            <Row className={dirty ? 'bg-surface2' : altClass(rows.length + di)}>
              <LeadCell text={rows.length === 0 && di === 0 ? `${count}名` : ''} />
              <PickerCell
                width="var(--w-name)"
                text={name}
                label={name === '' ? '対象の利用者を選ぶ' : `対象 ${name}。押すと選び直します`}
                disabled={disabled}
                onClick={() => ctx.openResident({ for: 'vitalTarget', key: d.key })}
              />
              <VitalSetCells
                name={name === '' ? '未選択' : name}
                vital={null}
                input={set}
                disabled={disabled}
                onError={(m) => ctx.setStatus(d.key, { tone: 'danger', text: m })}
                onInput={(patch) => onPatchDraft(d.key, { sets: [{ ...set, ...patch }] })}
                onCommit={(patch) => {
                  if (d.residentId == null) return
                  const merged = {
                    ...setToPatch(set),
                    ...patch,
                    symptom: d.symptom.trim() === '' ? null : d.symptom.trim(),
                  }
                  // 値も症状も無ければ保存しない（空欄の確定で空行を作らない）
                  if (!hasVitalValue(merged)) return
                  void onInsert(d.key, d.residentId, 'symptom', merged, d.key)
                }}
              />
              <Cell grow pad={false}>
                <SheetCell
                  value={d.symptom}
                  onCommit={
                    disabled
                      ? undefined
                      : (raw) => {
                          onPatchDraft(d.key, { symptom: raw })
                          if (d.residentId == null || raw.trim() === '') return
                          // 同じ行に入れてある測定値も一緒に送る
                          const merged = { ...setToPatch(set), symptom: raw.trim() }
                          void onInsert(d.key, d.residentId, 'symptom', merged, d.key)
                        }
                  }
                  width="100%"
                  align="left"
                  multiline
                  placeholder="症状"
                  ariaLabel="症状"
                  as="div"
                  tone="row"
                />
              </Cell>
            </Row>
            {/* 空欄のままの行には案内も取り消しも出さない（実物と同じ「ただの空行」にする） */}
            {dirty && (
              <p className="flex flex-wrap items-center gap-gap px-1 text-ink2">
                {d.locked ? (
                  <span className="flex-1 text-warn">
                    <span aria-hidden="true">▲ </span>
                    {MSG_LOCKED_DELETE}
                  </span>
                ) : d.residentId == null ? (
                  <span className="flex-1">
                    <span aria-hidden="true">ⓘ </span>氏名を選び、症状か値を入れると保存します
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => onRemoveDraft(d.key)}
                  disabled={d.locked}
                  className="sheet-dense-btn rounded-sm border border-border-strong px-1 text-link disabled:border-border disabled:text-ink3"
                >
                  この行を取り消す
                </button>
              </p>
            )}
            <StatusText status={ctx.status[d.key]} />
          </div>
        )
      })}
    </SheetBlock>
  )
}

// ══════════════════════════════════════════════════════════════
// 申し送り（対象 | 本文 | 記入者）
// ══════════════════════════════════════════════════════════════

interface NoteBlockProps {
  ctx: SheetCtx
  title: string
  /** タイトル帯の配色（指示8・note=ピンク / care=水色 / night=ネイビー） */
  tone: NoteTone
  rows: Note[]
  drafts: NoteDraft[]
  showReporter: boolean
  actorId: number | null
  expanded: string | null
  onToggleExpand: (key: string) => void
  onAdd: () => void
  onCommitBody: (key: string, value: string) => void
  onPatchDraft: (key: string, patch: Partial<NoteDraft>) => void
  onUpdateNote: (
    note: Note,
    patch: Parameters<typeof updateNoteFields>[2],
    optimistic: Partial<Note>,
  ) => Promise<void>
  onDelete: (key: string) => void
  onMarkRead: (note: Note) => void
  /** 枠の外側の余白を足したい時だけ渡す（デイサービス欄の .dsheet-gap-block） */
  className?: string
}

function NoteBlock({
  ctx,
  title,
  tone,
  rows,
  drafts,
  showReporter,
  actorId,
  expanded,
  onToggleExpand,
  onAdd,
  onCommitBody,
  onPatchDraft,
  onUpdateNote,
  onDelete,
  onMarkRead,
  className = '',
}: NoteBlockProps) {
  const count = rows.length
  return (
    <section aria-label={title} className={className}>
      {/* 実物のタイトル帯（日付＋ブロック名。配色は指示8） */}
      <NoteTitleBand day={ctx.day} title={title} tone={tone} count={count} onAdd={onAdd} />
      {/* 2026-08-31 指示: 件数の列は出さない（件数はタイトル帯にある）。
          対象を最左端に置き、色は記入者の右・詳細の左へ移す */}
      <HeadRow className="dsheet-head">
        <HeadCell width="var(--w-target)">対象</HeadCell>
        <HeadCell grow>内容</HeadCell>
        {showReporter && <HeadCell width="var(--w-reporter)">記入者</HeadCell>}
        <HeadCell width="var(--w-reporter)">色</HeadCell>
        <HeadCell width="var(--w-reporter)">詳細</HeadCell>
      </HeadRow>

      {rows.map((note, i) => (
        <NoteRow
          key={`n${note.id}`}
          ctx={ctx}
          rowKey={`n${note.id}`}
          note={note}
          draft={null}
          // 夜勤ブロックの記載内容は赤字の太字（指示15）
          night={tone === 'night'}
          // 1行おきの縞（指示16）。保存済みの行 → 追加した行 の並び順で数える
          alt={altClass(i) !== ''}
          showReporter={showReporter}
          actorId={actorId}
          expanded={expanded === `n${note.id}`}
          onToggleExpand={onToggleExpand}
          onCommitBody={onCommitBody}
          onPatchDraft={onPatchDraft}
          onUpdateNote={onUpdateNote}
          onDelete={onDelete}
          onMarkRead={onMarkRead}
        />
      ))}

      {drafts.map((d, i) => (
        <NoteRow
          key={d.key}
          ctx={ctx}
          rowKey={d.key}
          note={null}
          draft={d}
          night={tone === 'night'}
          alt={altClass(rows.length + i) !== ''}
          showReporter={showReporter}
          actorId={actorId}
          expanded={expanded === d.key}
          onToggleExpand={onToggleExpand}
          onCommitBody={onCommitBody}
          onPatchDraft={onPatchDraft}
          onUpdateNote={onUpdateNote}
          onDelete={onDelete}
          onMarkRead={onMarkRead}
        />
      ))}
    </section>
  )
}

interface NoteRowProps
  extends Omit<NoteBlockProps, 'title' | 'tone' | 'rows' | 'drafts' | 'onAdd' | 'expanded'> {
  rowKey: string
  note: Note | null
  draft: NoteDraft | null
  /** 夜勤申し送りの行（記載内容を赤字の太字にする・指示15） */
  night: boolean
  /** 1行おきの縞を敷く行か（指示16。行の色が付いている行では色を優先する） */
  alt: boolean
  /** この行の詳細を開いているか（申し送りブロック内で1行だけ開く） */
  expanded: boolean
}

function NoteRow({
  ctx,
  rowKey,
  note,
  draft,
  night,
  alt,
  showReporter,
  actorId,
  expanded,
  onToggleExpand,
  onCommitBody,
  onPatchDraft,
  onUpdateNote,
  onDelete,
  onMarkRead,
}: NoteRowProps) {
  const disabled = ctx.disabled || (draft?.locked ?? false)
  const color = note ? note.color : (draft?.color ?? null)
  const residentId = note ? note.resident_id : (draft?.residentId ?? null)
  const targetPicked = note !== null || (draft?.targetPicked ?? false)
  const reporterId = note ? note.reporter_id : (draft?.reporterId ?? null)
  const body = note ? note.body : (draft?.body ?? '')

  const target = residentId === null ? undefined : ctx.residentById.get(residentId)
  const targetText = !targetPicked
    ? ''
    : residentId === null
      ? 'スタッフへ（全体）'
      : noteTargetName(target, residentId)
  /** 表示名を使っている行だけ、詳細の窓にマスタの氏名を添える（本名で確かめられるように） */
  const targetRealName = target && hasNoteAlias(target) ? target.name : null
  const reporterText = reporterId === null ? '' : staffName(ctx.staffById.get(reporterId), reporterId)

  const setColor = (c: NoteColor | null) => {
    if (note) void onUpdateNote(note, { color: c }, { color: c })
    else if (draft) onPatchDraft(draft.key, { color: c })
  }

  const readCount = note?.read_count ?? 0
  const detailLabel = note
    ? `詳細を開く（${IMPORTANCE_LABEL[note.importance]}・既読 ${readCount}人）`
    : '詳細を開く'

  return (
    // 行の色（NoteColor）を選んである行は、その色をそのまま敷く（指示8の機能を維持）。
    // 色の無い行だけ1行おきの縞を敷く＝意味のある色が縞に負けない（指示16）
    <div className={color ? NOTE_COLOR_CLASS[color] : alt ? 'sheet-alt' : undefined}>
      <Row>
        <PickerCell
          width="var(--w-target)"
          text={targetText}
          label={targetText === '' ? '対象を選ぶ' : `対象 ${targetText}。押すと選び直します`}
          disabled={disabled}
          onClick={() => ctx.openResident({ for: 'noteTarget', key: rowKey })}
        />
        {/* 余白は SheetCell 側だけが持つ（対象・記入者と本文の左端をそろえる）。
            夜勤の記載内容は赤字の太字（指示15・sheet.css の .dsheet-night-body）。
            ※ いまの .dsheet-night-body は自分自身にだけ色を当てる書き方なので、
              本文を描く SheetCell が自前で持つ文字色（tone='row' → text-ink）が勝ち、
              **本文の文字までは赤くならない**。子孫にも当たる書き方が要る（チーフへ申し送り済み） */}
        <Cell grow pad={false} className={night ? 'dsheet-night-body' : ''}>
          <SheetCell
            value={body}
            onCommit={disabled ? undefined : (v) => onCommitBody(rowKey, v)}
            width="100%"
            align="left"
            multiline
            placeholder="内容"
            ariaLabel="申し送りの内容"
            as="div"
            // 行の色は外側の div が敷く。既定の tone（不透明な bg-surface）だと
            // いちばん幅の広い本文セルだけ白く抜けて、行の色が伝わらなくなる
            tone="row"
          />
        </Cell>
        {showReporter && (
          <PickerCell
            width="var(--w-reporter)"
            text={reporterText}
            label={reporterText === '' ? '記入者を選ぶ' : `記入者 ${reporterText}。押すと選び直します`}
            disabled={disabled}
            onClick={() => ctx.openStaff({ for: 'noteReporter', key: rowKey })}
          />
        )}
        {/* 色は記入者の右・詳細の左（2026-08-31 指示）。
            封鎖中・送信待ちの行は色も変えられない（同じ行の他のセルと可否をそろえる） */}
        <Cell width="var(--w-reporter)" className="flex items-center">
          <ColorPicker value={color} onChange={setColor} ariaLabel="この行の色" disabled={disabled} />
        </Cell>
        {/* 余白はボタン（px-1）だけが持つ */}
        <Cell width="var(--w-reporter)" pad={false} className="flex items-center">
          <button
            type="button"
            onClick={() => onToggleExpand(rowKey)}
            // 行の下に開く（aria-expanded）のではなく、窓を開くボタンになった
            aria-haspopup="dialog"
            aria-label={detailLabel}
            style={ROW_BTN_STYLE}
            className={`${CELL_HIT} w-full rounded-sm px-1 text-left text-link`}
          >
            {/* 記号と数字で状態が分かるようにする（色だけに頼らない） */}
            {note && note.importance !== 'normal' ? <span>{IMPORTANCE_LABEL[note.importance]}</span> : null}
            {note && readCount > 0 ? <span className="tabular"> ✓{readCount}</span> : null}
            {!note || (note.importance === 'normal' && readCount === 0) ? <span>…</span> : null}
          </button>
        </Cell>
      </Row>

      <StatusText status={ctx.status[rowKey]} />

      {/* 詳細は行の下に開かず、浮いた窓（フロートウィンドウ）で出す（2026-08-31 指示）。
          行の下に敷いていた時は下の行と地続きに見え、開いたことが分からなかった */}
      {expanded && (
        <NoteDetailModal
          onClose={() => onToggleExpand(rowKey)}
          ctx={ctx}
          rowKey={rowKey}
          note={note}
          draft={draft}
          targetText={targetText}
          targetRealName={targetRealName}
          actorId={actorId}
          onUpdateNote={onUpdateNote}
          onDelete={onDelete}
          onMarkRead={onMarkRead}
        />
      )}
    </div>
  )
}

/**
 * 申し送りの詳細（フロートウィンドウ・2026-08-31 指示）。
 *
 * なぜ窓にしたか:
 *   行の下に敷いていた頃は、地色が薄いだけで下の行と同じ見た目に見え、
 *   「開いたのかどうか」が分からなかった。背面を覆う窓にして、開閉をはっきりさせる。
 *   共通の器（ui.tsx の ModalShell）を使うので、Esc で閉じる・Tab が窓の中で循環する・
 *   閉じたら元の「詳細」ボタンへフォーカスが戻る、はこの部品で書かなくても効く。
 *
 * 「ボタンを小さく・行数を少なく・幅は狭め」の当て方:
 *   ・幅は narrow（max-w-sm）
 *   ・見出しと中身を横に並べて 6ブロック → 3行に畳む
 *   ・ボタンは**横の余白と文字だけ**を詰める（px-3 text-base → px-2 text-sm）。
 *     ★高さ（min-h-tap＝44px）は縮めない。現場はタブレットの指操作で、
 *       ここを削ると押し損ねが増える＝記録の取り違えにつながるため。
 */
const DETAIL_BTN = 'min-h-tap shrink-0 rounded-md border px-2 text-sm'

function NoteDetailModal({
  onClose,
  ctx,
  rowKey,
  note,
  draft,
  targetText,
  targetRealName,
  actorId,
  onUpdateNote,
  onDelete,
  onMarkRead,
}: {
  onClose: () => void
  ctx: SheetCtx
  rowKey: string
  note: Note | null
  draft: NoteDraft | null
  /** どの行の詳細かを窓の見出しに出す（窓が行を覆うので、取り違えを防ぐ） */
  targetText: string
  /**
   * 「申し送りでの表示名」で出している行の、マスタの氏名（設定が無い行は null）。
   * 窓の中で本名を確かめられるようにする（2026-09-01 指示の取り違え防止）。
   */
  targetRealName: string | null
  actorId: number | null
  onUpdateNote: NoteRowProps['onUpdateNote']
  onDelete: (key: string) => void
  onMarkRead: (n: Note) => void
}) {
  const readCount = note?.read_count ?? 0
  const who = targetText === '' ? '対象は未選択' : targetText

  // 保存済みの行の削除は確認ダイアログを開く。窓を先に閉じてから渡す
  // ＝同じ画面に窓が2枚重ならない（重ねると Tab の行き先が2か所に割れる）
  const requestDelete = () => {
    onClose()
    onDelete(rowKey)
  }

  return (
    <ModalShell open onClose={onClose} label={`申し送りの詳細（${who}）`} narrow>
      <div className="flex items-center justify-between gap-gap border-b border-border px-3 py-2">
        <h2 className="min-w-0 flex-1 text-base font-bold text-ink">
          <span className="block truncate">
            申し送りの詳細
            <span className="ml-2 text-sm font-normal text-ink2">{who}</span>
          </span>
          {/* 表示名で出している行は、マスタの氏名も添える（本名で確かめられるように） */}
          {targetRealName !== null && (
            <span className="block truncate text-sm font-normal text-ink2">
              利用者名 {targetRealName}
            </span>
          )}
        </h2>
        <button
          type="button"
          aria-label="閉じる"
          onClick={onClose}
          className="min-h-tap min-w-tap shrink-0 rounded text-base text-ink2"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {note ? (
          <div className="space-y-2">
            {/* 1行目: 重要度 */}
            <div className="flex flex-wrap items-center gap-gap">
              <span className="shrink-0 text-sm text-ink2">重要度</span>
              <div className="min-w-0 flex-1">
                <SegmentPicker
                  ariaLabel="重要度"
                  value={note.importance}
                  options={(['normal', 'important', 'critical'] as Importance[]).map((v) => ({
                    value: v,
                    label: IMPORTANCE_LABEL[v],
                  }))}
                  onChange={(v) => {
                    const imp = v as Importance
                    void onUpdateNote(note, { importance: imp }, { importance: imp })
                  }}
                />
              </div>
            </div>

            {/* 2行目: 職種タグ */}
            <div className="flex flex-wrap items-center gap-gap">
              <span className="shrink-0 text-sm text-ink2">職種タグ</span>
              {ROLE_TAGS.map((tag) => {
                const on = note.role_tags.includes(tag)
                return (
                  <button
                    key={tag}
                    type="button"
                    aria-pressed={on}
                    disabled={ctx.disabled}
                    onClick={() => {
                      const next = on
                        ? note.role_tags.filter((t) => t !== tag)
                        : [...note.role_tags, tag]
                      void onUpdateNote(note, { role_tags: next }, { role_tags: next })
                    }}
                    className={`min-h-tap shrink-0 rounded-full border px-2 text-sm ${
                      on ? 'border-primary bg-primary font-bold text-primary-ink' : 'border-border text-ink'
                    }`}
                  >
                    <span aria-hidden="true">{on ? '✓ ' : ''}</span>
                    {tag}
                  </button>
                )
              })}
            </div>

            {/* 3行目: 既読・削除・この行の色 */}
            <div className="flex flex-wrap items-center gap-gap border-t border-border pt-2">
              <span className="tabular text-sm text-ink2">既読 {readCount}人</span>
              {note.my_read ? (
                <span className="text-sm text-ok">
                  <span aria-hidden="true">✓ </span>自分は既読
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onMarkRead(note)}
                  disabled={actorId == null}
                  className={`${DETAIL_BTN} border-primary font-bold text-primary disabled:border-border disabled:text-ink3`}
                >
                  既読にする
                </button>
              )}
              <button
                type="button"
                onClick={requestDelete}
                disabled={ctx.disabled}
                className={`${DETAIL_BTN} border-danger font-bold text-danger disabled:border-border disabled:text-ink3`}
              >
                <span aria-hidden="true">▲ </span>この行を削除
              </button>
              {note.color && <span className="text-sm text-ink2">色: {NOTE_COLOR_LABEL[note.color]}</span>}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-ink2">
              <span aria-hidden="true">ⓘ </span>
              この行はまだ保存されていません。重要度・職種タグ・既読は保存後に設定できます。
            </p>
            {draft?.locked ? (
              <p className="text-sm text-warn">
                <span aria-hidden="true">▲ </span>
                {MSG_LOCKED_DELETE}
              </p>
            ) : null}
            <button
              type="button"
              onClick={requestDelete}
              disabled={draft?.locked ?? false}
              className={`${DETAIL_BTN} border-border-strong text-ink disabled:border-border disabled:text-ink3`}
            >
              この行を取り消す
            </button>
          </div>
        )}
      </div>
    </ModalShell>
  )
}
