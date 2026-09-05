// 申し送りフォーム（docs/design/ui-design.md §6「入力UX・申し送りフォーム」／§6.5「下書きの保持規則」）。
// 勤務帯（現在時刻から自動初期値）・対象（利用者 or スタッフ全体）・職種タグ・重要度・継続フラグ（期限日付き）・
// 本文・記入者（操作者を初期値）を1画面で受け、登録後は8秒のUndo（softDeleteNote）で取り消せるようにする。
//
// この画面の規律:
//   - supabase へは触れず db.ts の関数だけを呼ぶ（contracts.md §共通規律）
//   - 入力封鎖中（native_input_enabled=false）は導線を隠さずディセーブル＋理由文。
//     送信直前にもフラグを取り直す（ui-design.md §0.5 の二重ガード。最終強制は RLS/DB 側）
//   - 下書き cl_draftNote は「データ保護レイヤー」。1件のみ・24時間期限・送信成功／明示破棄で即削除（§6.5）。
//     送信できずキューへ退避した場合は「端末に残せたことを観測できた時」だけ消す（保全ゲートの後ろ）
//   - 個人情報を console・UI状態キー（cl_view 等）に出さない。コード・placeholder に実名を書かない
//   - 破壊的操作（下書きの破棄・登録の取り消し）は確認ダイアログ or Undo を挟む

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  ConfirmDialog,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  ResidentPickerModal,
  SectionCard,
  SegmentPicker,
  StaffPickerModal,
  useToast,
} from '../components/ui'
import { resolveActor, touchActivity } from '../lib/actor'
import {
  DbError,
  fetchResidents,
  fetchStaff,
  getNativeInputGate,
  fetchNotesForTargetDay,
  insertNote,
  isQueuePersisted,
  softDeleteNote,
} from '../lib/db'
import { addDays, fmtDayLabel, fmtTimeHM, todayIso } from '../lib/format'
import { IMPORTANCE_LABEL, LS, noteDisplayName, ROLE_TAGS, SHIFT_LABEL } from '../lib/types'
import type { Importance, Note, Resident, Shift, Staff } from '../lib/types'

// ── 定数 ──────────────────────────────────────────────

/** 入力封鎖中（切替日D前）の理由文。ui-design.md §0.5 の定型文をそのまま使う */
const BLOCKED_REASON = '現在はスプレッドシートで記録する期間です（アプリ入力の開始日は施設で決定します）'

/** 下書きの期限。超過分は開いた時点で自動削除する（§6.5） */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000

/** 送信待ちにしたのに端末へ残せなかった時の案内（下書き・入力欄はどちらも消さない） */
const NOT_PERSISTED_REASON =
  '送信できませんでした。この端末にも保存できていません（保存領域の空きが不足している可能性があります）。入力はこの画面に残していますので、電波が戻るまでこの画面を閉じないでください。長引く場合は本文を控えてから管理者に連絡してください。'

/** 取り消しを送信待ちに退避した時の案内（入力内容はフォームへ戻したうえで出す） */
const MSG_UNDO_QUEUED =
  '通信できないため、取り消しを送信待ちにしました。電波が戻ると自動で取り消します（それまではタイムラインに残ります）。入力内容はフォームに戻しました。'

/** 継続フラグを入れたときの既定の期限日（記録日から何日後か）。変更・空欄化できる */
const ONGOING_DEFAULT_DAYS = 7

const SHIFTS: Shift[] = ['day', 'daycare', 'night']
const IMPORTANCES: Importance[] = ['normal', 'important', 'critical']
const SHIFT_OPTIONS = SHIFTS.map((v) => ({ value: v, label: SHIFT_LABEL[v] }))
const IMPORTANCE_OPTIONS = IMPORTANCES.map((v) => ({ value: v, label: IMPORTANCE_LABEL[v] }))

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ── 入力状態 ──────────────────────────────────────────

interface FormState {
  noteOn: string
  shift: Shift
  /** 対象を選んだか。residentId=null は「スタッフへ（全体）」＝有効な選択のため、未選択と区別する */
  targetPicked: boolean
  residentId: number | null
  roleTags: string[]
  importance: Importance
  ongoing: boolean
  /** 継続の期限日（YYYY-MM-DD）。'' は期限を決めない＝終了操作まで継続 */
  endedOn: string
  body: string
  reporterId: number | null
}

type ErrorKey = 'noteOn' | 'residentId' | 'body' | 'endedOn' | 'reporterId'
type Errors = Partial<Record<ErrorKey, string>>

// ── 小さなヘルパ（純関数・この画面専用）────────────────────

/**
 * 勤務帯の自動初期値。
 * ※仮定: 9:00〜16:59 を日勤、それ以外を夜勤とする。「デイ」は時間帯ではなく事業所区分のため自動選択しない
 *   （現行スプシに時刻→勤務帯の定義が無いための仮置き。運用値は本人確認事項）。
 */
function autoShift(d: Date): Shift {
  const h = d.getHours()
  return h >= 9 && h < 17 ? 'day' : 'night'
}

/** 'HH:MM'（notes.occurred_at は time 列） */
function nowHM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 継続の期限日（YYYY-MM-DD）→ notes.ended_at（timestamptz）。
 * その日いっぱい有効にしたいので端末ローカル（＝JST運用）の 23:59:59 に置く。
 * 壊れた値は null（＝期限なし）にフォールバックし、画面は壊さない。
 */
function endOfDayStamp(iso: string): string | null {
  if (!ISO_DATE_RE.test(iso)) return null
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d, 23, 59, 59)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toISOString()
}

function isShift(v: unknown): v is Shift {
  return typeof v === 'string' && (SHIFTS as string[]).includes(v)
}

function isImportance(v: unknown): v is Importance {
  return typeof v === 'string' && (IMPORTANCES as string[]).includes(v)
}

/** 正の安全整数だけを受け入れる（不正値は null。壊れた値で起動不能にしない） */
function posInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null
}

function isoDateOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && ISO_DATE_RE.test(v) ? v : fallback
}

function defaultForm(reporterId: number | null, now: Date): FormState {
  return {
    noteOn: todayIso(),
    shift: autoShift(now),
    targetPicked: false,
    residentId: null,
    roleTags: [],
    importance: 'normal',
    ongoing: false,
    endedOn: '',
    body: '',
    reporterId,
  }
}

/** db.ts が投げるエラーは画面にそのまま出せる日本語。それ以外は定型文に落とす（技術的な文言を出さない） */
function errText(err: unknown): string {
  if (err instanceof DbError) return err.message
  return '登録できませんでした（原因不明のエラー）。画面を再読み込みして、もう一度お試しください。入力内容は消えていません。'
}

// ── 下書き（cl_draftNote・データ保護レイヤー）──────────────
// 本文・対象は業務データのため UI状態キー（cl_view 等）とは別レイヤーで扱う（ui-design.md §6.5）。
// 保存・読取・削除はすべて try/catch で囲み、localStorage が使えない環境でも入力を続けられるようにする。

function clearDraft(): void {
  try {
    window.localStorage.removeItem(LS.draftNote)
  } catch {
    // 消せなくても次回読取の期限判定・ホワイトリスト照合で弾かれる
  }
}

function saveDraft(f: FormState): void {
  try {
    window.localStorage.setItem(LS.draftNote, JSON.stringify({ v: 1, savedAt: Date.now(), ...f }))
  } catch {
    // 保存できなくても入力は続けられる（下書きが無いだけ）
  }
}

/** 期限内かつ既知の値だけを復元する。期限切れ・壊れた値はその場で削除して null */
function loadDraft(): FormState | null {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(LS.draftNote)
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const o: unknown = JSON.parse(raw)
    if (o === null || typeof o !== 'object') {
      clearDraft()
      return null
    }
    const rec = o as Record<string, unknown>
    const savedAt = typeof rec.savedAt === 'number' && Number.isFinite(rec.savedAt) ? rec.savedAt : 0
    // 端末時計が進んでいる場合（savedAt が未来）は期限切れ扱いにしない＝書きかけを消さない側へ倒す
    if (Date.now() - savedAt >= DRAFT_TTL_MS) {
      clearDraft()
      return null
    }
    const body = typeof rec.body === 'string' ? rec.body : ''
    if (body.trim() === '') {
      clearDraft() // 本文の無い下書きは復元しない（意味のない復元ダイアログを出さない）
      return null
    }
    const noteOn = isoDateOr(rec.noteOn, todayIso())
    const tags = Array.isArray(rec.roleTags)
      ? rec.roleTags.filter(
          (t): t is string => typeof t === 'string' && (ROLE_TAGS as readonly string[]).includes(t),
        )
      : []
    return {
      noteOn,
      shift: isShift(rec.shift) ? rec.shift : autoShift(new Date()),
      targetPicked: rec.targetPicked === true,
      residentId: posInt(rec.residentId),
      roleTags: Array.from(new Set(tags)),
      importance: isImportance(rec.importance) ? rec.importance : 'normal',
      ongoing: rec.ongoing === true,
      endedOn: isoDateOr(rec.endedOn, ''),
      body,
      reporterId: posInt(rec.reporterId),
    }
  } catch {
    clearDraft()
    return null
  }
}

// ── 本体 ──────────────────────────────────────────────

type Phase = 'loading' | 'error' | 'ready'

export function NoteFormPage() {
  const uid = useId()
  const { toast, show } = useToast()

  const [phase, setPhase] = useState<Phase>('loading')
  const [residents, setResidents] = useState<Resident[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  /** 入力解禁フラグ。観測できるまでは false（安全側＝封鎖）に倒す */
  const [enabled, setEnabled] = useState(false)
  /** フラグを観測できなかった（通信エラー等）。理由文ではなく再確認を促す */
  const [gateUnknown, setGateUnknown] = useState(false)
  const [reload, setReload] = useState(0)

  const [form, setForm] = useState<FormState>(() => defaultForm(null, new Date()))
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)
  /**
   * 選んだ対象の「その日の記録」。null＝まだ引いていない／引けなかった。
   * 二重に書くのを防ぐための参考表示なので、引けなくてもフォームは使える（安全側）。
   */
  const [sameDayNotes, setSameDayNotes] = useState<Note[] | null>(null)
  const [sameDayLoading, setSameDayLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const [residentPicker, setResidentPicker] = useState(false)
  const [staffPicker, setStaffPicker] = useState(false)
  const [restorePrompt, setRestorePrompt] = useState(false)

  // 初期化（既定値・下書き復元）は最初の読込成功時に1回だけ行い、再試行で入力を巻き戻さない
  const initedRef = useRef(false)
  const targetBtnRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const endedRef = useRef<HTMLInputElement>(null)
  const reporterBtnRef = useRef<HTMLButtonElement>(null)
  const dateRef = useRef<HTMLInputElement>(null)

  const ids = useMemo(
    () => ({
      date: `${uid}-date`,
      shift: `${uid}-shift`,
      target: `${uid}-target`,
      tags: `${uid}-tags`,
      importance: `${uid}-importance`,
      body: `${uid}-body`,
      bodyHint: `${uid}-body-hint`,
      ongoing: `${uid}-ongoing`,
      ended: `${uid}-ended`,
      endedHint: `${uid}-ended-hint`,
      reporter: `${uid}-reporter`,
      blocked: `${uid}-blocked`,
      err: (k: ErrorKey) => `${uid}-err-${k}`,
    }),
    [uid],
  )

  // ── 読み込み（利用者・職員・入力解禁フラグ）────────────
  // 入力解禁フラグは §0.5 のとおり画面を開くたびに取り直す（前提情報は毎回実測する）
  useEffect(() => {
    let alive = true
    setPhase('loading')
    void (async () => {
      try {
        const [rs, st] = await Promise.all([fetchResidents(), fetchStaff()])
        if (!alive) return
        const safeR = Array.isArray(rs) ? rs.filter((r) => r != null && typeof r.id === 'number') : []
        const safeS = Array.isArray(st) ? st.filter((s) => s != null && typeof s.id === 'number') : []
        setResidents(safeR)
        setStaff(safeS)

        let gate = false
        let unknown = false
        try {
          // 「false を観測した（＝スプシ期間）」と「観測できなかった（＝通信エラー）」を区別する。
          // 後者は封鎖の理由文ではなく、再確認できる案内を出す（observed で分ける）
          const g = await getNativeInputGate()
          gate = g.value === true
          unknown = !g.observed
        } catch {
          unknown = true // 取得できない間は封鎖のまま（安全側）
        }
        if (!alive) return
        setEnabled(gate)
        setGateUnknown(unknown)

        if (!initedRef.current) {
          initedRef.current = true
          const actor = resolveActor(safeS)
          const base = defaultForm(actor?.id ?? null, new Date())
          const draft = loadDraft()
          if (draft) {
            // 下書きの参照先が今のマスタに無い場合は選び直させる（誤帰属の記録を作らない）
            const residentOk =
              draft.residentId === null || safeR.some((r) => r.id === draft.residentId)
            const reporterOk =
              draft.reporterId !== null && safeS.some((s) => s.id === draft.reporterId && s.active)
            setForm({
              ...draft,
              targetPicked: draft.targetPicked && residentOk,
              residentId: residentOk ? draft.residentId : null,
              reporterId: reporterOk ? draft.reporterId : base.reporterId,
            })
            setRestorePrompt(true)
          } else {
            setForm(base)
          }
        }
        setPhase('ready')
      } catch {
        if (alive) setPhase('error')
      }
    })()
    return () => {
      alive = false
    }
  }, [reload])

  // ── 下書きの保存（本文が空になったら削除）────────────────
  useEffect(() => {
    if (phase !== 'ready' || !initedRef.current) return
    if (form.body.trim() === '') clearDraft()
    else saveDraft(form)
  }, [form, phase])

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

  /** 入力の更新。同時に該当フィールドのエラー表示と送信エラーを消す（インライン検証） */
  const update = useCallback((patch: Partial<FormState>, clear?: ErrorKey) => {
    setForm((f) => ({ ...f, ...patch }))
    setFormError(null)
    if (!clear) return
    setErrors((e) => {
      if (e[clear] === undefined) return e
      const next = { ...e }
      delete next[clear]
      return next
    })
  }, [])

  const toggleTag = useCallback((tag: string) => {
    setFormError(null)
    setForm((f) => ({
      ...f,
      roleTags: f.roleTags.includes(tag)
        ? f.roleTags.filter((t) => t !== tag)
        : [...f.roleTags, tag],
    }))
  }, [])

  const toggleOngoing = useCallback(() => {
    setFormError(null)
    setForm((f) =>
      f.ongoing
        ? { ...f, ongoing: false }
        : {
            ...f,
            ongoing: true,
            // 期限は未入力のままにせず既定を置く（空欄にすれば「期限なし」にできる）
            endedOn: f.endedOn === '' ? addDays(f.noteOn, ONGOING_DEFAULT_DAYS) : f.endedOn,
          },
    )
  }, [])

  /** 書きかけを破棄する（確認1回のあとに実行・§6.5） */
  const discardDraft = useCallback(() => {
    setRestorePrompt(false)
    clearDraft()
    setErrors({})
    setFormError(null)
    setForm(defaultForm(resolveActor(staff)?.id ?? null, new Date()))
    show('書きかけを破棄しました')
  }, [staff, show])

  /** 入力解禁フラグだけを取り直す（フラグを観測できなかった時の再確認） */
  const refreshGate = useCallback(async () => {
    try {
      const g = await getNativeInputGate()
      setEnabled(g.value === true)
      setGateUnknown(!g.observed) // まだ観測できない＝案内を出したまま再確認できるようにする
    } catch {
      setEnabled(false)
      setGateUnknown(true)
    }
  }, [])

  // ── 検証 ────────────────────────────────────────────
  const validate = useCallback((f: FormState): Errors => {
    const e: Errors = {}
    const today = todayIso()
    if (!ISO_DATE_RE.test(f.noteOn)) {
      e.noteOn = '記録日が入っていません。日付を選んでください。'
    } else if (f.noteOn > today) {
      e.noteOn = '記録日が未来の日付です。今日以前の日付を選んでください。'
    }
    if (!f.targetPicked) {
      e.residentId = '対象が選ばれていません。利用者を選ぶか「スタッフへ（全体）」を選んでください。'
    }
    if (f.body.trim() === '') {
      e.body = '本文が空です。申し送りの内容を入力してください。'
    }
    if (f.ongoing && f.endedOn !== '' && f.endedOn < f.noteOn) {
      e.endedOn = '期限日が記録日より前になっています。記録日以降の日付を選んでください。'
    }
    if (f.reporterId === null) {
      e.reporterId = '記入者が選ばれていません。記入者を選んでください。'
    }
    return e
  }, [])

  /** 登録の取り消し（8秒Undo）。論理削除のうえ、入力内容をフォームへ戻す */
  const undoInsert = useCallback(
    async (note: Note, snapshot: FormState) => {
      try {
        const res = await softDeleteNote(note.id, note.rev)
        if (res === 'conflict') {
          setFormError(
            '取り消せませんでした（ほかの端末が同じ記録を更新しています）。タイムラインで内容を確認してから削除してください。',
          )
          return
        }
        setForm(snapshot)
        setErrors({})
        if (res === 'queued') {
          // 取り消しはキューへ退避済み。サーバー上の記録はまだ残っているので「取り消しました」とは言わない
          show(MSG_UNDO_QUEUED)
          return
        }
        show('登録を取り消しました。入力内容をフォームに戻しました。')
      } catch (err) {
        setFormError(errText(err))
      }
    },
    [show],
  )

  const handleSubmit = useCallback(
    async (ev: FormEvent<HTMLFormElement>) => {
      ev.preventDefault()
      if (saving) return
      const found = validate(form)
      const keys = Object.keys(found) as ErrorKey[]
      if (keys.length > 0) {
        setErrors(found)
        setFormError('入力に不足があります。赤い印の項目を確認してください。')
        const focusMap: Record<ErrorKey, HTMLElement | null> = {
          noteOn: dateRef.current,
          residentId: targetBtnRef.current,
          body: bodyRef.current,
          endedOn: endedRef.current,
          reporterId: reporterBtnRef.current,
        }
        focusMap[keys[0]]?.focus()
        return
      }

      setSaving(true)
      setErrors({})
      setFormError(null)
      try {
        // 二重ガード: 送信直前にフラグを取り直す。取り直せない時は直前に観測した値のまま進める
        // （観測済みの解禁をオフラインで取り消さない。最終強制は RLS/DB 側）
        let gate = enabled
        try {
          const g = await getNativeInputGate()
          if (g.observed) {
            gate = g.value === true
            setGateUnknown(false)
          }
          // 観測できなかった時は、直前に観測した値のまま進める（案内は出し直さない）
        } catch {
          // 取り直せなかっただけなので、観測済みの値のまま進める（案内は出し直さない）
        }
        setEnabled(gate)
        if (!gate) {
          setFormError(BLOCKED_REASON)
          return
        }

        const now = new Date()
        const payload: Omit<Note, 'id' | 'rev' | 'read_count' | 'my_read'> = {
          note_on: form.noteOn,
          shift: form.shift,
          facility: null,
          category: null,
          resident_id: form.residentId,
          role_tags: [...form.roleTags],
          importance: form.importance,
          body: form.body.trim(),
          // 記録日が今日のときだけ現在時刻を入れる（過去日に誤った時刻を残さない）
          occurred_at: form.noteOn === todayIso() ? nowHM(now) : null,
          ongoing: form.ongoing,
          ended_at: form.ongoing && form.endedOn !== '' ? endOfDayStamp(form.endedOn) : null,
          reporter_id: form.reporterId,
          // 色・16時区切りはシート画面で扱う項目。この入力画面では既定のまま送る
          color: null,
          after16: false,
        }

        const snapshot = form
        const res = await insertNote(payload)
        touchActivity()
        if (res === 'queued' && !isQueuePersisted()) {
          // 送信待ちにはなったが、端末に残せたことを観測できていない（保存領域の不足など）。
          // 下書きも入力欄もそのまま残す（消去は保全ゲートの後ろ・multi-device-sync 原則8）
          setFormError(NOT_PERSISTED_REASON)
          return
        }
        clearDraft() // 送信済み（端末に残せた退避を含む）＝下書きの役目は終わり（§6.5）
        // 続けて書けるように、日付・勤務帯・記入者は残し、対象と内容だけ初期化する
        setForm({
          ...defaultForm(form.reporterId, now),
          noteOn: form.noteOn,
          shift: form.shift,
        })
        if (res === 'queued') {
          show(
            '送信できませんでしたが、端末に保存しました。電波が戻ると自動で送信します（ヘッダの「未送信」で確認できます）。',
          )
          return
        }
        show('登録しました', () => {
          void undoInsert(res, snapshot)
        })
      } catch (err) {
        setFormError(errText(err))
      } finally {
        setSaving(false)
      }
    },
    [enabled, form, saving, show, undoInsert, validate],
  )

  // ── 3状態 ───────────────────────────────────────────

  /**
   * 対象と記録日が決まったら、その日その方の記録を引いて出す。
   * 同じ出来事を別の職員が二重に書くのを、書く前に気づけるようにするため。
   * 引けなくてもフォームは使える（参考表示なので、失敗しても入力を止めない）。
   */
  useEffect(() => {
    if (!form.targetPicked || !ISO_DATE_RE.test(form.noteOn)) {
      setSameDayNotes(null)
      return
    }
    let alive = true
    setSameDayLoading(true)
    void (async () => {
      try {
        const rows = await fetchNotesForTargetDay(form.residentId, form.noteOn)
        if (alive) setSameDayNotes(rows)
      } catch {
        if (alive) setSameDayNotes(null) // 参考表示なので、失敗しても何も出さないだけ
      } finally {
        if (alive) setSameDayLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [form.targetPicked, form.residentId, form.noteOn])

  // ★ここから下は早期 return がある。Hook はすべてこの上に置くこと（規則違反で画面が落ちる）
  if (phase === 'loading') {
    return <LoadingBlock label="申し送りフォームを準備しています…" />
  }

  if (phase === 'error') {
    return (
      <ErrorBlock
        message="申し送りフォームを開けませんでした（通信エラー）。電波状態を確認して、再試行してください。入力内容は消えていません。"
        onRetry={() => setReload((n) => n + 1)}
      />
    )
  }

  if (residents.length === 0 && staff.length === 0) {
    return (
      <EmptyBlock
        message="利用者・職員の一覧がまだありません。設定タブでマスタ同期を実行してから記入してください。"
        actionLabel="もう一度読み込む"
        onAction={() => setReload((n) => n + 1)}
      />
    )
  }

  // 対象は「申し送りでの表示名」で出す（2026-09-01 指示。設定が無い方はマスタの氏名）
  const targetResident = form.residentId === null ? undefined : residentById.get(form.residentId)
  const targetText = !form.targetPicked
    ? '未選択'
    : form.residentId === null
      ? 'スタッフへ（全体）'
      : targetResident
        ? noteDisplayName(targetResident)
        : `利用者ID ${form.residentId}`
  const reporterText =
    form.reporterId === null
      ? '未選択'
      : (staffById.get(form.reporterId)?.name ?? `職員ID ${form.reporterId}`)
  const dayLabel = ISO_DATE_RE.test(form.noteOn) ? fmtDayLabel(form.noteOn) : ''
  const inputsDisabled = !enabled || saving

  const fieldError = (key: ErrorKey) =>
    errors[key] ? (
      <p id={ids.err(key)} role="alert" className="mt-1 text-sm text-danger">
        <span aria-hidden="true">▲ </span>
        {errors[key]}
      </p>
    ) : null

  // 封鎖中・送信中は fieldset で無効化される。無効であることを色でも示す（disabled: はトークン色のみ）
  const labelClass = 'block text-sm font-bold text-ink2'
  const boxClass =
    'min-h-tap w-full rounded-md border border-border bg-surface px-3 text-base text-ink disabled:bg-surface2 disabled:text-ink3'
  const pickerBtnClass =
    'flex min-h-tap w-full items-center justify-between gap-gap rounded-md border border-border-strong bg-surface px-3 text-left text-base text-ink disabled:border-border disabled:bg-surface2 disabled:text-ink3'

  return (
    <div className="mx-auto w-full max-w-2xl">
      {/* 入力封鎖（§0.5）: 隠さずディセーブル＋理由文。シェル側の案内と二重で示す */}
      {!enabled && !gateUnknown && (
        <p
          id={ids.blocked}
          className="mb-4 rounded-md border border-border bg-info-bg p-3 text-base text-ink"
        >
          <span aria-hidden="true" className="mr-2 font-heavy">
            i
          </span>
          {BLOCKED_REASON}
        </p>
      )}
      {gateUnknown && (
        <div className="mb-4 rounded-md border border-warn bg-warn-bg p-3">
          <p id={ids.blocked} className="text-base text-ink">
            <span aria-hidden="true" className="mr-2">
              ▲
            </span>
            入力できるかどうかを確認できませんでした（通信エラー）。電波状態を確認して、もう一度確認してください。入力内容は消えていません。
          </p>
          <button
            type="button"
            onClick={() => void refreshGate()}
            className="mt-3 min-h-tap rounded-md border border-primary bg-surface px-4 text-base font-bold text-primary"
          >
            もう一度確認する
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <fieldset disabled={inputsDisabled} className="space-y-4">
          {/* ── いつ・どの勤務帯・だれに ── */}
          <SectionCard title="いつ・だれに">
            <div className="space-y-4">
              <div>
                <label htmlFor={ids.date} className={labelClass}>
                  記録日
                </label>
                <div className="mt-1 flex items-center gap-gap">
                  <input
                    id={ids.date}
                    ref={dateRef}
                    type="date"
                    value={form.noteOn}
                    max={todayIso()}
                    onChange={(e) => update({ noteOn: e.target.value }, 'noteOn')}
                    aria-invalid={errors.noteOn ? true : undefined}
                    aria-describedby={errors.noteOn ? ids.err('noteOn') : undefined}
                    className={`tabular ${boxClass}`}
                  />
                  <span className="shrink-0 text-base text-ink2">{dayLabel}</span>
                </div>
                {fieldError('noteOn')}
              </div>

              <div>
                <p id={ids.shift} className={labelClass}>
                  勤務帯
                </p>
                <div className="mt-1">
                  <SegmentPicker
                    options={SHIFT_OPTIONS}
                    value={form.shift}
                    onChange={(v) => isShift(v) && update({ shift: v })}
                    ariaLabel="勤務帯"
                  />
                </div>
              </div>

              <div>
                <p id={ids.target} className={labelClass}>
                  対象
                </p>
                <button
                  type="button"
                  ref={targetBtnRef}
                  onClick={() => setResidentPicker(true)}
                  aria-label={`対象: ${targetText}。押すと選び直せます`}
                  aria-invalid={errors.residentId ? true : undefined}
                  aria-describedby={errors.residentId ? ids.err('residentId') : undefined}
                  className={`mt-1 ${pickerBtnClass}`}
                >
                  <span className={form.targetPicked ? 'font-bold' : 'text-ink3'}>
                    {form.targetPicked && form.residentId === null && (
                      <span aria-hidden="true" className="mr-1">
                        ⓘ
                      </span>
                    )}
                    {targetText}
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-link">
                    選ぶ
                  </span>
                </button>
                {fieldError('residentId')}

                {/* 本日この方の記録（二重記入を書く前に気づくための参考表示・2026-09-05 追加）。
                    読むだけで、ここから編集・削除はできない（このフォームの役目は新規登録） */}
                {form.targetPicked && (
                  <div
                    aria-live="polite"
                    className="mt-2 rounded-md border border-border bg-surface2 p-3"
                  >
                    <p className="text-sm font-bold text-ink2">
                      {dayLabel}の{targetText}の記録
                      {sameDayNotes !== null ? `（${sameDayNotes.length}件）` : ''}
                    </p>
                    {sameDayLoading && sameDayNotes === null ? (
                      <p className="mt-1 text-sm text-ink3">読み込んでいます…</p>
                    ) : sameDayNotes === null ? (
                      <p className="mt-1 text-sm text-ink3">
                        既存の記録を読み込めませんでした（通信エラー）。このまま登録できます。
                      </p>
                    ) : sameDayNotes.length === 0 ? (
                      <p className="mt-1 text-sm text-ink3">まだ記録はありません。</p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {sameDayNotes.map((n) => (
                          <li key={n.id} className="text-sm text-ink">
                            <span className="text-ink2">
                              {SHIFT_LABEL[n.shift] ?? ''}
                              {fmtTimeHM(n.occurred_at) ? ` ${fmtTimeHM(n.occurred_at)}` : ''}
                            </span>
                            <span className="ml-2">{n.body}</span>
                            {n.reporter_id !== null && (
                              <span className="ml-2 text-ink2">
                                {staffById.get(n.reporter_id)?.name ?? ''}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          </SectionCard>

          {/* ── 内容 ── */}
          <SectionCard title="内容">
            <div className="space-y-4">
              <div>
                <p id={ids.tags} className={labelClass}>
                  職種タグ（複数選べます）
                </p>
                <div role="group" aria-labelledby={ids.tags} className="mt-1 flex flex-wrap gap-gap">
                  {ROLE_TAGS.map((tag) => {
                    const on = form.roleTags.includes(tag)
                    return (
                      <button
                        key={tag}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleTag(tag)}
                        className={
                          on
                            ? 'min-h-tap rounded-full border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border disabled:bg-surface2 disabled:text-ink3'
                            : 'min-h-tap rounded-full border border-border bg-surface px-4 text-base text-ink disabled:bg-surface2 disabled:text-ink3'
                        }
                      >
                        <span aria-hidden="true" className={on ? 'mr-1' : 'mr-1 invisible'}>
                          ✓
                        </span>
                        {tag}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <p id={ids.importance} className={labelClass}>
                  重要度
                </p>
                <div className="mt-1">
                  <SegmentPicker
                    options={IMPORTANCE_OPTIONS}
                    value={form.importance}
                    onChange={(v) => isImportance(v) && update({ importance: v })}
                    ariaLabel="重要度"
                  />
                </div>
              </div>

              <div>
                <label htmlFor={ids.body} className={labelClass}>
                  本文
                </label>
                <textarea
                  id={ids.body}
                  ref={bodyRef}
                  value={form.body}
                  onChange={(e) => update({ body: e.target.value }, 'body')}
                  rows={6}
                  aria-invalid={errors.body ? true : undefined}
                  aria-describedby={
                    errors.body ? `${ids.bodyHint} ${ids.err('body')}` : ids.bodyHint
                  }
                  className="mt-1 w-full rounded-md border border-border bg-surface p-3 text-lg text-ink disabled:bg-surface2 disabled:text-ink3"
                />
                <p id={ids.bodyHint} className="mt-1 text-sm text-ink2">
                  引き継ぎたい事実と、次に必要な対応を書きます。
                </p>
                {fieldError('body')}
              </div>
            </div>
          </SectionCard>

          {/* ── 継続・記入者 ── */}
          <SectionCard title="継続・記入者">
            <div className="space-y-4">
              <div>
                <p id={ids.ongoing} className={labelClass}>
                  継続（期限日まで毎日ピン留めして再掲します）
                </p>
                <button
                  type="button"
                  aria-pressed={form.ongoing}
                  aria-labelledby={ids.ongoing}
                  onClick={toggleOngoing}
                  className={
                    form.ongoing
                      ? 'mt-1 min-h-tap rounded-md border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border disabled:bg-surface2 disabled:text-ink3'
                      : 'mt-1 min-h-tap rounded-md border border-border bg-surface px-4 text-base text-ink disabled:bg-surface2 disabled:text-ink3'
                  }
                >
                  <span aria-hidden="true" className={form.ongoing ? 'mr-1' : 'mr-1 invisible'}>
                    ✓
                  </span>
                  継続にする
                </button>
              </div>

              {form.ongoing && (
                <div>
                  <label htmlFor={ids.ended} className={labelClass}>
                    継続の期限日
                  </label>
                  <input
                    id={ids.ended}
                    ref={endedRef}
                    type="date"
                    value={form.endedOn}
                    min={ISO_DATE_RE.test(form.noteOn) ? form.noteOn : undefined}
                    onChange={(e) => update({ endedOn: e.target.value }, 'endedOn')}
                    aria-invalid={errors.endedOn ? true : undefined}
                    aria-describedby={
                      errors.endedOn ? `${ids.endedHint} ${ids.err('endedOn')}` : ids.endedHint
                    }
                    className={`tabular mt-1 ${boxClass}`}
                  />
                  <p id={ids.endedHint} className="mt-1 text-sm text-ink2">
                    空にすると、タイムラインのピン留めで「継続を終了」を押すまで継続して表示されます。
                  </p>
                  {fieldError('endedOn')}
                </div>
              )}

              <div>
                <p id={ids.reporter} className={labelClass}>
                  記入者
                </p>
                <button
                  type="button"
                  ref={reporterBtnRef}
                  onClick={() => setStaffPicker(true)}
                  aria-label={`記入者: ${reporterText}。押すと選び直せます`}
                  aria-invalid={errors.reporterId ? true : undefined}
                  aria-describedby={errors.reporterId ? ids.err('reporterId') : undefined}
                  className={`mt-1 ${pickerBtnClass}`}
                >
                  <span className={form.reporterId === null ? 'text-ink3' : 'font-bold'}>
                    {reporterText}
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-link">
                    選ぶ
                  </span>
                </button>
                {fieldError('reporterId')}
              </div>
            </div>
          </SectionCard>

          {formError && (
            <p role="alert" className="rounded-md border border-danger bg-danger-bg p-3 text-base text-ink">
              <span aria-hidden="true">▲ </span>
              {formError}
            </p>
          )}

          <button
            type="submit"
            aria-describedby={enabled ? undefined : ids.blocked}
            className="min-h-tap w-full rounded-md border border-primary bg-primary px-4 text-base font-bold text-primary-ink disabled:border-border disabled:bg-surface2 disabled:text-ink3"
          >
            {saving ? '登録しています…' : '登録する'}
          </button>
          <p className="text-sm text-ink2">
            登録のあと8秒間は「元に戻す」で取り消せます。
          </p>
        </fieldset>
      </form>

      <ResidentPickerModal
        open={residentPicker}
        residents={residents}
        allowAll
        useNoteAlias
        onPick={(id) => {
          update({ targetPicked: true, residentId: id }, 'residentId')
          setResidentPicker(false)
        }}
        onClose={() => setResidentPicker(false)}
      />

      <StaffPickerModal
        open={staffPicker}
        staff={staff}
        title="記入者を選ぶ"
        onPick={(id) => {
          update({ reporterId: id }, 'reporterId')
          setStaffPicker(false)
        }}
        onClose={() => setStaffPicker(false)}
      />

      {/* 書きかけの復元（§6.5）。破棄は取り消せないので確認を1回はさむ＝このダイアログ */}
      <ConfirmDialog
        open={restorePrompt}
        title="書きかけを復元しました"
        body="前回の入力が残っていたので画面に戻しました。このまま続けるときは「キャンセル」、消してよいときは「破棄する」を押してください。破棄した書きかけは元に戻せません。"
        confirmLabel="破棄する"
        danger
        onConfirm={discardDraft}
        onCancel={() => setRestorePrompt(false)}
      />

      {toast}
    </div>
  )
}
