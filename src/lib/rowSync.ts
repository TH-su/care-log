// 行の入力と保存の共通の仕組み（5画面共通・2026-09-23 構造規約 R-E〜R-G）。
//
// これまで5画面それぞれに「保存・再送・読み直し」の状態機械があり、競合の扱いを後付けしていたため、
// 直すたびに形を変えて漏れた（読み直しで入力欄と基準がずれる・保存中の入力が落ちる・送信待ちが解けない）。
// 画面は「サーバーの値（saved）」と「利用者の編集（edits）」の2つだけを持ち、次の規約で扱う。
//
// R-E 欄ごとの基準（base-at-edit）
//   各欄の比較の基準は「利用者がその欄の編集を始めた時に画面に出ていた値」。確定した時、その欄の
//   いまのサーバー値が基準と違えば送らない（競合）。背景の読み込みは edits を書き換えない
//   （＝編集中・止まっている欄の基準は動かない）。止まっていない通常の行でも同じ。
// R-F 行ごとの直列化と欄単位の消し込み
//   同じ行への保存はすべて行ごとの1本の順番待ち（createRowQueue）を通し、後の保存は前の保存が
//   終わった後の最新の状態から計算し直す（planEdits）。保存に成功した時は、送って成功した欄のうち
//   送った後に書き換えられていない欄だけを消す（settleSent・版 ver で見分ける）。
// R-G 離れる時の確認は、edits が1欄でも残る行をすべて数える（hasEdits）
//
// 拡張子付きで import する（tests/logic.test.mjs から直接読めるようにするため）

import { pairOf, sameField } from './conflict.ts'
import type { ConflictColumn } from './conflict.ts'

/** 1欄の編集。base＝編集を始めた時に画面に出ていた値（R-E）。ver＝編集ごとに変わる版（R-F） */
export interface FieldEdit {
  value: unknown
  base: unknown
  ver: number
}

export type Edits<F extends string> = Partial<Record<F, FieldEdit>>

let verSeq = 0

function normEmpty(v: unknown): unknown {
  return v === undefined || v === '' ? null : v
}

/**
 * 1欄の確定を edits に記録する（R-E・R-B）。
 * ・まだ編集の無い欄は、基準（baseAtEdit）から実際に変わった時だけ記録する（開いて閉じただけ・同じ値は入れない）
 * ・既に編集のある欄（止まっている欄）は、基準を変えずに値だけ差し替える（背景の読み込みで基準を動かさない）
 * value=null は「空にする」意思。
 *
 * 血圧の上と下（組の欄・F4）: pair（相方の欄に画面が出していたサーバーの生の値）を渡すと、片側を記録した時に
 * 相方にまだ編集が無ければ、相方も「値＝基準」の編集として強制的に記録する。サーバー（0011）は組の片側が
 * 他の端末に変えられていたら組ごと書かないが、送らなかった相方は比べようがないため、相方の「いまの値のまま」を
 * 一緒に送って組で確かめさせる（誰も測っていない上下の組み合わせを作らない）。
 * pair を省くと相方は記録しない（従来どおり）。相方に既に編集があれば、その値と基準を保つ
 */
export function recordFieldEdit<F extends string>(
  edits: Edits<F>,
  field: F,
  value: unknown,
  baseAtEdit: unknown,
  pair?: { base: unknown },
): Edits<F> {
  const next = recordOne(edits, field, value, baseAtEdit)
  if (pair === undefined || next === edits) return next
  const other = pairOf(field) as F | null
  if (other === null || next[other]) return next
  const b = normEmpty(pair.base)
  verSeq += 1
  return { ...next, [other]: { value: b, base: b, ver: verSeq } }
}

function recordOne<F extends string>(edits: Edits<F>, field: F, value: unknown, baseAtEdit: unknown): Edits<F> {
  const v = normEmpty(value)
  const cur = edits[field]
  if (!cur) {
    if (sameField(field, v, baseAtEdit)) return edits
    verSeq += 1
    return { ...edits, [field]: { value: v, base: normEmpty(baseAtEdit), ver: verSeq } }
  }
  if (sameField(field, v, cur.value) && (v === null) === (cur.value === null)) return edits
  verSeq += 1
  return { ...edits, [field]: { value: v, base: cur.base, ver: verSeq } }
}

/**
 * 読み直しで突き合わせる欄（第3段 #4）。画面の欄（base）に、送信待ちにある欄（メモなど画面に出していない欄も）を足す。
 * 画面の欄に固定すると、送信待ちにしかない欄（食事の〔両方残す〕のメモ）が「食い違い無し」とみなされて捨てられる
 */
export function judgeFields<F extends string>(base: readonly F[], p: { values: Record<string, unknown> } | null): F[] {
  const out: F[] = [...base]
  if (p !== null) for (const f of Object.keys(p.values) as F[]) if (!out.includes(f)) out.push(f)
  return out
}

/**
 * 送信待ちで止まっている行（競合・拒否）の値を、その行の「あなたの入力」として edits に取り込む（控えに既にある欄は
 * 控えの値を残す・基準は送信待ちの基準）。conv は値の読み替え（数値の欄など）。
 * 血圧は組で取り込む（第3段 #3）: 相方を「値＝基準」で送っている（F4）と、ふつうの記録では相方が落ちる
 * （基準から変わっていない欄は記録しない）。片方を取り込んだら、送信待ちにある相方も値＝基準のまま取り込む
 */
export function adoptPendingEdits<F extends string>(
  fields: readonly F[],
  edits: Edits<F>,
  p: { values: Record<string, unknown>; bases: Record<string, unknown> },
  conv: (f: F, v: unknown) => unknown = (_f, v) => v,
): Edits<F> {
  let out = edits
  const baseOf = (f: F): unknown => (Object.prototype.hasOwnProperty.call(p.bases, f) ? conv(f, p.bases[f]) : null)
  for (const f of fields) {
    if (!(f in p.values) || out[f] !== undefined) continue
    out = recordOne(out, f, conv(f, p.values[f]), baseOf(f))
  }
  for (const f of fields) {
    const o = pairOf(f) as F | null
    if (o === null || !(f in p.values) || out[f] !== undefined || out[o] === undefined) continue
    const v = normEmpty(conv(f, p.values[f]))
    const b = Object.prototype.hasOwnProperty.call(p.bases, f) ? normEmpty(baseOf(f)) : v
    verSeq += 1
    out = { ...out, [f]: { value: v, base: b, ver: verSeq } }
  }
  return out
}

/**
 * 送信待ちの版のうち、画面が見せている値（shown）と同じ欄の版（第3段 #9）。取り下げる時に discardPendingRow へ渡すと、
 * 画面が見せていた版だけが外れる（見た後に打ち直した・他のタブが入れた新しい値は外さない）
 */
export function seenVers(
  p: { values: Record<string, unknown>; vers: Record<string, string> } | null,
  shown: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (p === null) return out
  for (const [f, v] of Object.entries(p.values)) {
    if (Object.prototype.hasOwnProperty.call(shown, f) && sameField(f, v, shown[f]) && p.vers[f] !== undefined) out[f] = p.vers[f]
  }
  return out
}

/** 欄を edits から外す（利用者が取り下げた欄・保存できた欄） */
export function withoutFields<F extends string>(edits: Edits<F>, fields: readonly F[]): Edits<F> {
  const out: Edits<F> = { ...edits }
  for (const f of fields) delete out[f]
  return out
}

export interface EditPlan<F extends string> {
  /** 基準からサーバーの値が動いていて、しかもあなたの値とも違う欄（送らない） */
  conflicts: ConflictColumn<F>[]
  /** 送る欄と値（基準とサーバーの値が同じ＝あなたの編集をそのまま載せてよい欄） */
  send: Partial<Record<F, unknown>>
  /** 送る欄の編集（成功した時に欄単位で消すための控え） */
  sendEdits: Edits<F>
  /** もうサーバーに同じ値が載っている欄（送らずに消してよい） */
  settled: F[]
}

/**
 * 送る前の判定（R-E・R-A）。server は送る直前に分かっている最新のサーバーの値。
 * 行の保存は、conflicts が1つでもあれば何も送らない（競合として止める）のが5画面共通の扱い。
 * 文字の欄は文字列として比べる。血圧の上と下は1つの組で、片方が食い違えば相方も送らずに競合へ入れる
 * （誰も測っていない上下の組み合わせを作らない＝送信キューの規約 I8）
 */
export function planEdits<F extends string>(
  fields: readonly F[],
  edits: Edits<F>,
  server: Partial<Record<F, unknown>>,
): EditPlan<F> {
  const conflicts: ConflictColumn<F>[] = []
  const send: Partial<Record<F, unknown>> = {}
  const sendEdits: Edits<F> = {}
  const settled: F[] = []
  for (const f of fields) {
    const e = edits[f]
    if (!e) continue
    const s = server[f] ?? null
    if (sameField(f, s, e.value)) {
      settled.push(f)
      continue
    }
    if (!sameField(f, s, e.base)) {
      conflicts.push({ field: f, theirs: s, mine: e.value })
      continue
    }
    send[f] = e.value
    sendEdits[f] = e
  }
  for (const f of Object.keys(send) as F[]) {
    const other = pairOf(f)
    if (other === null || !conflicts.some((c) => c.field === other)) continue
    conflicts.push({ field: f, theirs: server[f] ?? null, mine: send[f] })
    delete send[f]
    delete sendEdits[f]
  }
  conflicts.sort((a, b) => fields.indexOf(a.field) - fields.indexOf(b.field))
  return { conflicts, send, sendEdits, settled }
}

/**
 * 読み込んだ最新のサーバー値に、残っている編集を突き合わせる（R-E。5画面の読み直しの共通の裁き）。
 * ・edits の基準は書き換えない（fresh=null＝行が見当たらない時だけ、先の値が無いものとして基準を空にする）
 * ・もう同じ値が載っている欄は消す
 * status: conflict＝食い違う欄がある（保存しない）／unsaved＝送る欄がある（未保存）／clean＝何も残らない
 */
export function reconcileOnLoad<F extends string>(
  fields: readonly F[],
  edits: Edits<F>,
  fresh: Partial<Record<F, unknown>> | null,
): { edits: Edits<F>; status: 'conflict' | 'unsaved' | 'clean'; conflicts: ConflictColumn<F>[]; unsaved: F[] } {
  let cur = edits
  if (fresh === null) {
    const rebased: Edits<F> = {}
    for (const f of Object.keys(edits) as F[]) {
      const e = edits[f]
      if (e) rebased[f] = { ...e, base: null }
    }
    cur = rebased
  }
  const plan = planEdits(fields, cur, fresh ?? {})
  const next = withoutFields(cur, plan.settled)
  const unsaved = Object.keys(plan.send) as F[]
  const status = plan.conflicts.length > 0 ? 'conflict' : unsaved.length > 0 ? 'unsaved' : 'clean'
  return { edits: next, status, conflicts: plan.conflicts, unsaved }
}

/**
 * 保存に成功した後の欄単位の消し込み（R-F）。
 * 送った編集（sent）のうち、送った後に書き換えられていない欄（版が同じ）だけを消す。
 * 送った後に書き換えられた欄は残し、基準を「保存できた値」に持ち直す（自分の書込を他端末の変更と取り違えない）。
 * 行の edits を丸ごと消さない。
 */
export function settleSent<F extends string>(
  edits: Edits<F>,
  sent: Edits<F>,
  saved: Partial<Record<F, unknown>>,
): Edits<F> {
  const out: Edits<F> = { ...edits }
  for (const f of Object.keys(sent) as F[]) {
    const cur = out[f]
    const was = sent[f]
    if (!cur || !was) continue
    if (cur.ver === was.ver) delete out[f]
    else out[f] = { ...cur, base: saved[f] ?? null }
  }
  return out
}

/** edits の値（くらべて選ぶ画面の「あなたの入力」） */
export function editValues<F extends string>(edits: Edits<F>): Partial<Record<F, unknown>> {
  const out: Partial<Record<F, unknown>> = {}
  for (const f of Object.keys(edits) as F[]) {
    const e = edits[f]
    if (e) out[f] = e.value
  }
  return out
}

/** edits の基準（くらべて選ぶ画面の「見ていた値」）。編集の無い欄は fallback の値 */
export function editBases<F extends string>(
  edits: Edits<F>,
  fallback: Partial<Record<F, unknown>>,
): Partial<Record<F, unknown>> {
  const out: Partial<Record<F, unknown>> = { ...fallback }
  for (const f of Object.keys(edits) as F[]) {
    const e = edits[f]
    if (e) out[f] = e.base
  }
  return out
}

/**
 * 今回の確定で新しく「空にする」ことになった欄（表示中の値があるのに空にした欄）。
 * 画面はこの欄があれば、控えに入れる**前に**確認を出す（キャンセルしたら控えに入れない＝再審 T6）
 */
export function newlyClearedFields<F extends string>(
  prev: Edits<F>,
  next: Edits<F>,
  shown: Partial<Record<F, unknown>>,
): F[] {
  const out: F[] = []
  for (const f of Object.keys(next) as F[]) {
    const e = next[f]
    if (!e || e === prev[f] || e.value !== null) continue
    const s = shown[f]
    if (s !== null && s !== undefined && s !== '') out.push(f)
  }
  return out
}

/**
 * 欄の基準が分からない印（旧版が退避した op など）。どのサーバーの値とも「同じ」にならないので、
 * その欄は他の端末の値と食い違えば必ず競合として見せる（黙って送らない）
 */
export const UNKNOWN_BASE: unique symbol = Symbol('unknown-base')

/**
 * 読み込んだ行が、画面が既に持っている同じ行より古いか（rev が小さい）。古ければ画面の行を置き換えない
 * （くらべて選ぶ・保存の直後に、それより前に出た読み込みの応答で描き直さない＝指摘 L2・全画面共通の防御）。
 * 別の行（id が違う）・どちらかが未保存の行は比べない
 */
export function isOlderRow(
  shown: { id: number | null | undefined; rev: number | null | undefined } | null | undefined,
  fresh: { id: number | null | undefined; rev: number | null | undefined } | null | undefined,
): boolean {
  if (!shown || !fresh) return false
  if (shown.id == null || fresh.id == null || shown.id !== fresh.id) return false
  if (typeof shown.rev !== 'number' || typeof fresh.rev !== 'number') return false
  return fresh.rev < shown.rev
}

/** R-G: 1欄でも編集が残っているか */
export function hasEdits<F extends string>(edits: Edits<F> | undefined | null): boolean {
  return edits != null && Object.keys(edits).some((f) => edits[f as F] !== undefined)
}

/**
 * R-F: 行ごとの直列化。同じ key の仕事は前の仕事が終わってから順に動く（失敗しても次は動く）。
 * 仕事は動き出した時点の最新の状態（ref）を読んで計算すること（呼んだ時点の値を持ち越さない）。
 */
export function createRowQueue(): (key: string, job: () => Promise<void>) => Promise<void> {
  const chains = new Map<string, Promise<void>>()
  return (key, job) => {
    const prev = chains.get(key) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined)
      .then(job)
      .catch(() => undefined)
    chains.set(key, next)
    void next.then(() => {
      if (chains.get(key) === next) chains.delete(key)
    })
    return next
  }
}
