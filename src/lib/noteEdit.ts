// 申し送りの変更を画面で扱うための純関数（2026-09-29・申し送りを消さない作り替え）。
// DB・DOM・localStorage に触れない。個人情報を持たない（受け取った値を組み替えるだけ）。

import type { Note, NoteCategory, NoteColor } from './types'

/** 日報の書きかけ行のうち、登録の後にも直せる欄（本文・対象・記入者・色・分類） */
export interface DraftFields {
  body: string
  residentId: number | null
  targetPicked: boolean
  reporterId: number | null
  color: NoteColor | null
  /** 分類（0032・2026-10-15）。省略＝分類を選んでいない（[] と同じ扱い） */
  categories?: NoteCategory[]
}

/** 分類の比べ方（並びは NOTE_CATEGORIES にそろえて持つので、文字にして比べる。省略は []） */
function catKey(v: readonly NoteCategory[] | undefined): string {
  return JSON.stringify(v ?? [])
}

/** 1欄の編集（value＝あなたの値・base＝編集を始めた時にサーバーから来ていた生の値） */
export type FieldEdit = { value: unknown; base: unknown }

/**
 * 登録の応答待ちの間に直した欄を、登録できた行への変更に直す（M1）。
 * sent＝登録で送った中身、now＝応答が来た時の書きかけ、inserted＝登録できた行（サーバーの生の値＝基準）。
 * 本文を空にした・対象を選び直していない欄は送らない（空の本文で上書きしない）
 */
export function followUpEdits(
  sent: DraftFields,
  now: DraftFields,
  inserted: Pick<Note, 'body' | 'resident_id' | 'reporter_id' | 'color' | 'categories'>,
): Record<string, FieldEdit> {
  const out: Record<string, FieldEdit> = {}
  const body = now.body.trim()
  if (body !== '' && body !== sent.body.trim() && body !== inserted.body) out.body = { value: body, base: inserted.body }
  if (now.targetPicked && now.residentId !== sent.residentId && now.residentId !== inserted.resident_id) {
    out.resident_id = { value: now.residentId, base: inserted.resident_id }
  }
  if (now.reporterId !== sent.reporterId && now.reporterId !== inserted.reporter_id) {
    out.reporter_id = { value: now.reporterId, base: inserted.reporter_id }
  }
  if (now.color !== sent.color && now.color !== inserted.color) out.color = { value: now.color, base: inserted.color }
  // 分類（2026-10-15）: 応答待ちの間に選び直した分類。登録できた行の分類（無ければ []）を基準にする
  if (catKey(now.categories) !== catKey(sent.categories) && catKey(now.categories) !== catKey(inserted.categories)) {
    out.categories = { value: [...(now.categories ?? [])], base: [...(inserted.categories ?? [])] }
  }
  return out
}

/** 送信待ちの値を行に重ねる（取り消し deleted_at は重ねない）。送信待ちが無ければ元の行のまま */
export function overlayNote(note: Note, values: Record<string, unknown> | null | undefined): Note {
  if (!values) return note
  const out: Record<string, unknown> = { ...note }
  let changed = false
  for (const [k, v] of Object.entries(values)) {
    // 分類（0032）は行に無くても重ねる（列を返さない経路で読んだ行にも、送信待ちの分類を出す）
    if (k === 'deleted_at' || (!(k in note) && k !== 'categories')) continue
    out[k] = v
    changed = true
  }
  return changed ? (out as unknown as Note) : note
}

/**
 * 送信待ちの状態の一言（色だけで伝えない＝記号と文字）。serverWaiting＝サーバー側の更新（0017）待ちで送れない
 * （入力は端末に残し、更新されると自動で送る）
 */
export function pendingNoteText(
  state: 'pending' | 'conflict' | 'rejected',
  deleting: boolean,
  serverWaiting = false,
): string {
  if (state === 'conflict') return '▲ 他の端末で先に変更されたため止まっています。入力は端末に残っています'
  if (state === 'rejected') return '▲ サーバーに受け付けられませんでした。入力は端末に残っています'
  if (serverWaiting) {
    return deleting
      ? '⚠ 送信待ち（削除）。サーバー側の更新待ちです。更新されると自動で送信します'
      : '⚠ 送信待ち。サーバー側の更新待ちです。更新されると自動で送信します'
  }
  return deleting ? '⚠ 送信待ち（削除）。電波が戻ると自動で送信します' : '⚠ 送信待ち。電波が戻ると自動で送信します'
}

/**
 * 保存済みの行の本文を確定した時に送るか（修正依頼5）。比べる相手は画面に出している本文＝送信待ちの本文があれば
 * それ（無ければサーバーの本文）。送信待ちの本文 P が出ている時に元の本文 S へ打ち直したら、送る（P を S で置き換える）
 */
export function shouldSendBody(
  value: string,
  serverBody: string,
  pendingValues: Record<string, unknown> | null | undefined,
): boolean {
  const shown = pendingValues && typeof pendingValues.body === 'string' ? pendingValues.body : serverBody
  return value.trim() !== '' && value.trim() !== shown
}

/** 送信待ちの一覧の指紋（行 id・状態・版）。変わっていない時は画面を描き直さない */
export function pendingSig(m: ReadonlyMap<number, { state: string; vers: Record<string, string> }>): string {
  return [...m.entries()]
    .map(([id, p]) => `${id}:${p.state}:${Object.entries(p.vers).map(([f, v]) => `${f}=${v}`).join(',')}`)
    .sort()
    .join('|')
}
