// 読み込んだデータの控え（メモリだけ）と、裏での先読みの順番待ち（2026-10-17 本人依頼「待ち時間なしで画面を開く」）。
//
// ここは db.ts・supabase に依存しない純粋な部品（node の試験でそのまま読める）。db の取得関数を包むのは cachedReads.ts。
//
// 控え（createDataCache）:
//   ・キーごとに「値・取得した時刻・世代・古い印」を持つ。localStorage・IndexedDB には置かない（個人情報・原則11）
//   ・同じキーの同時取得は1本にまとめる（走っている取得に相乗りする）。ただし走り出した後に「古い」の印が付いた取得
//     （世代が変わった取得）には相乗りしない＝変更の前の内容を読んだかもしれない応答を新しい取得として使わない
//   ・応答が返った時、取りに行った時と世代・全体の世代（clearAll）が違えば控えに入れない（古い応答を捨てる）
//   ・取り直した値が控えと同じ中身なら、控えの値（同じ参照）を返す＝画面の effect が「名簿が変わった」と取り違えて
//     読み直しを重ねない
//   ・空の結果は、取得関数がログインの控えの無い0件を例外にする（F58）時だけ控える（storeEmpty）。それ以外は控えない
//   ・peek は「古い」の印が無い控えだけを返す（画面が即座に描いてよいのは、変更通知で古くなっていない控えだけ）
//   ・markStale は表と日付で当たるキーに印を付ける（行が分からない時はその表のキー全部）。印の付いた控えは
//     表示には使わず（peek が返さない）、先読みの番が来た時・画面を開いた時に取り直す
//   ・clearAll（ログアウト・記録者の変更・ログインのし直し）で全部捨て、走っている取得の応答も入れない
//
// 先読みの順番待ち（createPrefetchQueue）:
//   ・同時に走らせるのは concurrency 本まで（既定2）。画面の取得はこの順番待ちを通らない（待たせない）
//   ・canRun() が false の間（画面が隠れている・オフライン・データ節約・送信待ちを送っている・ログインしていない）は始めない。
//     kick() で見直す（画面に戻った・電波が戻った時に呼ぶ）
//   ・失敗した仕事は黙って次へ進む（画面の取得の失敗として残さない）

/** 控えの当たり判定に使う情報（どの表のどの日の範囲を読んだか） */
export interface CacheMeta {
  /** この控えを作った表（変更通知の表の名前と同じ） */
  tables: readonly string[]
  /** 読んだ日の範囲（'YYYY-MM-DD'）。無ければ日付に関係なく、その表の変更で古くなる */
  from?: string
  to?: string
  /**
   * 範囲の終わり（to）以前の申し送りの変更でも古くなる（タイムラインの「継続」の申し送り pinned は、範囲より前の日の
   * 申し送りも載る）
   */
  notesUpTo?: boolean
}

export interface CacheEntry<T> {
  value: T
  /** 取得した時刻（ms） */
  at: number
  /** 変更通知・自分の書込で古くなった（表示には使わない＝取り直す） */
  stale: boolean
  meta: CacheMeta
  /** 先読み（ensure）で入れた控えか（REUSE_MS の間、画面の取り直しで使い回すのはこれだけ） */
  prefetched: boolean
}

export interface CacheFetchOpts<T> {
  meta: CacheMeta
  /** 取得してからこの時間（ms）以内の古くなっていない控えは通信せずに使う（既定 REUSE_MS。0＝必ず取りに行く） */
  reuseMs?: number
  /**
   * 空の結果も控えるか（既定 false）。取得関数がログインの控えの無い0件を例外にしている（F58）時だけ true にする。
   * false の時、isEmpty が true の結果は控えない（返すだけ）
   */
  storeEmpty?: boolean
  /** 空の結果か（既定: 配列の長さ0・Map の大きさ0） */
  isEmpty?: (v: T) => boolean
}

interface InFlight {
  p: Promise<unknown>
  gen: number
  epoch: number
}

/** 控えの数の上限（古い順に捨てる。カルテなどを開き続けても端末のメモリを食わない） */
export const MAX_ENTRIES = 160

/**
 * 先読みで取得してからこの時間（ms）以内で古くなっていない控えは、画面を開いた時の取り直しでも通信せずにそのまま使う
 * （行に触れた時の先読みの直後に開いた時に、同じ要求を2回送らない）。画面が自分で取った控えは使い回さない
 * （〔最新を読み込む〕などは必ず取りに行く）
 */
export const REUSE_MS = 2_000

/** 変更通知の行から、その行の日付（当たり判定に使う列）を取り出す。読めなければ null（＝その表の控え全部） */
const DAY_COLUMN: Readonly<Record<string, string>> = {
  notes: 'note_on',
  vitals: 'measured_on',
  meals: 'meal_on',
  fluid_intake: 'taken_on',
  attendance: 'day',
  med_admin: 'admin_on',
  bath_records: 'bath_on',
  incidents: 'occurred_on',
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 変更通知の行の日付（当たり判定に使う）。外出・既読・時間帯など日で絞れない表と、行が無い時は null */
export function changedRowDay(table: string, row: Record<string, unknown> | null | undefined): string | null {
  if (row === null || row === undefined) return null
  const col = DAY_COLUMN[table]
  if (col === undefined) return null
  const v = row[col]
  return typeof v === 'string' && DAY_RE.test(v.slice(0, 10)) ? v.slice(0, 10) : null
}

/** その控えが、表 table の日 day（null＝分からない）の変更で古くなるか */
export function metaHit(meta: CacheMeta, table: string, day: string | null): boolean {
  if (!meta.tables.includes(table)) return false
  if (day === null) return true
  if (meta.from === undefined || meta.to === undefined) return true
  if (day > meta.to) return false
  if (day >= meta.from) return true
  // 範囲より前の日: 継続の申し送り（pinned）を載せる控えだけが当たる
  return table === 'notes' && meta.notesUpTo === true
}

/** 2つの値が同じ中身か（Map・Set も中身で比べる。比べられない値は違うとみなす） */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return stableJson(a) === stableJson(b)
  } catch {
    return false
  }
}

function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (x instanceof Map) return { __map: [...x.entries()] }
    if (x instanceof Set) return { __set: [...x.values()] }
    return x
  })
}

function defaultIsEmpty(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0
  if (v instanceof Map || v instanceof Set) return v.size === 0
  return v === null || v === undefined
}

export interface DataCache {
  /** 古くなっていない控えの値（無い・古い時は undefined） */
  peek<T>(key: string): T | undefined
  /** 控えの中身（古い印も含めて。試験・先読みの判断用） */
  entry<T>(key: string): CacheEntry<T> | undefined
  /**
   * 取得して控える（画面を開いた時の取り直し）。同じキーの同じ世代の取得が走っていれば相乗りする。
   * 先読みで取得して REUSE_MS 以内の古くなっていない控えは通信せずに返す。
   * 応答が返るまでに古くなった・全部捨てられた時は控えに入れずに返すだけ
   */
  fetch<T>(key: string, fn: () => Promise<T>, opts: CacheFetchOpts<T>): Promise<T>
  /**
   * 控えが無い・古い時だけ取得する（先読み）。古くなっていない控えがあれば通信しない。
   * 戻り値: 取りに行ったか（試験・計測用）
   */
  ensure<T>(key: string, fn: () => Promise<T>, opts: CacheFetchOpts<T>): Promise<boolean>
  /**
   * 1回の取得で複数のキーを埋める（日報の10日まとめ取り）。group は同じ取得の重なりをまとめる名前。
   * 応答の各キーは、取りに行った時と世代が同じ時だけ控えに入れる。返す Map の値は控えに入れた値（同じ中身なら控えの参照）
   */
  fetchGroup<T>(
    group: string,
    keys: readonly string[],
    fn: () => Promise<Map<string, T>>,
    optsFor: (key: string) => CacheFetchOpts<T>,
  ): Promise<Map<string, T>>
  /**
   * 表 table の日 day（null＝分からない）の変更で古くなる控えに印を付ける。exclude が真のキーは除く
   * （その変更が中身に関わらないと分かっている控え）。戻り値: 印を付けた数
   */
  markStale(table: string, day: string | null, exclude?: (key: string) => boolean): number
  /** キーで選んで古いの印を付ける（画面が自分の書込で捨てた日など） */
  markStaleWhere(pred: (key: string) => boolean): number
  /** 全部に古いの印を付ける（取り直しの合図＝つながり直した・画面に戻った・電波が戻った） */
  markAllStale(): number
  /** 全部捨てる（ログアウト・記録者の変更・ログインのし直し）。走っている取得の応答も入れない */
  clearAll(): void
  /** 控えのキー（試験・計測用） */
  keys(): string[]
  /** 古いの印が付いたキー（先読みの取り直しの対象） */
  staleKeys(): string[]
  /** 印が付いた・捨てた時に呼ぶ（先読みの取り直しを起こす）。戻り値で外す */
  onStale(fn: () => void): () => void
}

export function createDataCache(now: () => number = Date.now): DataCache {
  const entries = new Map<string, CacheEntry<unknown>>()
  /** キーごとの世代（印を付けるたびに進む。控えを捨てても残す＝捨てる前に走り出した応答を入れない） */
  const gens = new Map<string, number>()
  const inflight = new Map<string, InFlight>()
  const staleHooks = new Set<() => void>()
  let epoch = 0

  /** 走っている取得の当たり判定に使う情報（控えがまだ無いキー。キー → 走っている数と情報） */
  const inflightMeta = new Map<string, CacheMeta>()
  const inflightGroups = new Map<string, { p: Promise<Map<string, unknown>>; sig: string; epoch: number }>()

  const genOf = (key: string): number => gens.get(key) ?? 0
  const bump = (key: string): void => {
    gens.set(key, genOf(key) + 1)
  }
  const fireStale = (): void => {
    for (const fn of [...staleHooks]) {
      try {
        fn()
      } catch {
        // 受け口の例外で控えの処理を止めない
      }
    }
  }

  const put = <T>(key: string, value: T, opts: CacheFetchOpts<T>, prefetched = false): T => {
    const empty = (opts.isEmpty ?? defaultIsEmpty)(value)
    if (empty && opts.storeEmpty !== true) return value
    const prev = entries.get(key) as CacheEntry<T> | undefined
    // 中身が同じなら控えの値（同じ参照）を使う
    const v = prev !== undefined && sameValue(prev.value, value) ? prev.value : value
    entries.delete(key) // 挿入順＝古い順に並べ直す
    entries.set(key, { value: v, at: now(), stale: false, meta: opts.meta, prefetched })
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
    return v
  }

  const run = <T>(key: string, fn: () => Promise<T>, opts: CacheFetchOpts<T>, prefetched = false): Promise<T> => {
    const gen = genOf(key)
    const ep = epoch
    const running = inflight.get(key)
    if (running !== undefined && running.gen === gen && running.epoch === ep) return running.p as Promise<T>
    let p: Promise<T>
    try {
      p = Promise.resolve(fn())
    } catch (e) {
      p = Promise.reject(e)
    }
    const mine: InFlight = { p, gen, epoch: ep }
    const out = p.then(
      (v) => {
        if (inflight.get(key) === mine) inflight.delete(key)
        // 取りに行っている間に古くなった・全部捨てられた＝この応答は控えに入れない（返すだけ）
        if (ep !== epoch || gen !== genOf(key)) return v
        return put(key, v, opts, prefetched)
      },
      (e: unknown) => {
        if (inflight.get(key) === mine) inflight.delete(key)
        throw e
      },
    )
    mine.p = out
    inflight.set(key, mine)
    return out
  }

  const mark = (pred: (key: string, e: CacheEntry<unknown> | undefined) => boolean): number => {
    let n = 0
    const keys = new Set<string>([...entries.keys(), ...inflight.keys(), ...inflightMeta.keys()])
    for (const key of keys) {
      const e = entries.get(key)
      if (!pred(key, e)) continue
      bump(key)
      if (e !== undefined && !e.stale) {
        e.stale = true
        n += 1
      } else if (e === undefined) {
        n += 1
      }
    }
    if (n > 0) fireStale()
    return n
  }

  return {
    peek<T>(key: string): T | undefined {
      const e = entries.get(key)
      if (e === undefined || e.stale) return undefined
      return e.value as T
    },
    entry<T>(key: string): CacheEntry<T> | undefined {
      return entries.get(key) as CacheEntry<T> | undefined
    },
    fetch<T>(key: string, fn: () => Promise<T>, opts: CacheFetchOpts<T>): Promise<T> {
      const e = entries.get(key)
      const reuse = opts.reuseMs ?? REUSE_MS
      if (e !== undefined && !e.stale && e.prefetched && reuse > 0) {
        const age = now() - e.at
        if (age >= 0 && age < reuse) return Promise.resolve(e.value as T)
      }
      inflightMeta.set(key, opts.meta)
      const p = run(key, fn, opts)
      void p.then(
        () => inflightMeta.delete(key),
        () => inflightMeta.delete(key),
      )
      return p
    },
    async ensure<T>(key: string, fn: () => Promise<T>, opts: CacheFetchOpts<T>): Promise<boolean> {
      const e = entries.get(key)
      if (e !== undefined && !e.stale) return false
      const running = inflight.get(key)
      if (running !== undefined && running.gen === genOf(key) && running.epoch === epoch) {
        await running.p.catch(() => undefined)
        return false
      }
      inflightMeta.set(key, opts.meta)
      try {
        await run(key, fn, opts, true)
      } finally {
        inflightMeta.delete(key)
      }
      return true
    },
    fetchGroup<T>(
      group: string,
      keys: readonly string[],
      fn: () => Promise<Map<string, T>>,
      optsFor: (key: string) => CacheFetchOpts<T>,
    ): Promise<Map<string, T>> {
      const ep = epoch
      const sig = keys.map((k) => `${k}#${genOf(k)}`).join(',')
      const running = inflightGroups.get(group)
      if (running !== undefined && running.sig === sig && running.epoch === ep) return running.p as Promise<Map<string, T>>
      const startGens = new Map(keys.map((k) => [k, genOf(k)]))
      for (const k of keys) if (!inflightMeta.has(k)) inflightMeta.set(k, optsFor(k).meta)
      let p0: Promise<Map<string, T>>
      try {
        p0 = Promise.resolve(fn())
      } catch (e) {
        p0 = Promise.reject(e)
      }
      const release = (): void => {
        if (inflightGroups.get(group)?.p === out) inflightGroups.delete(group)
        for (const k of keys) if (!inflight.has(k)) inflightMeta.delete(k)
      }
      const out: Promise<Map<string, T>> = p0.then(
        (m) => {
          release()
          const res = new Map<string, T>()
          for (const [k, v] of m) {
            const g = startGens.get(k)
            res.set(k, ep === epoch && g !== undefined && g === genOf(k) ? put(k, v, optsFor(k)) : v)
          }
          return res
        },
        (e: unknown) => {
          release()
          throw e
        },
      )
      inflightGroups.set(group, { p: out as Promise<Map<string, unknown>>, sig, epoch: ep })
      return out
    },
    markStale(table: string, day: string | null, exclude?: (key: string) => boolean): number {
      return mark((key, e) => {
        if (exclude?.(key) === true) return false
        const meta = e?.meta ?? inflightMeta.get(key)
        return meta !== undefined && metaHit(meta, table, day)
      })
    },
    markStaleWhere(pred: (key: string) => boolean): number {
      return mark((key) => pred(key))
    },
    markAllStale(): number {
      return mark(() => true)
    },
    clearAll(): void {
      epoch += 1
      entries.clear()
      inflight.clear()
      inflightMeta.clear()
      inflightGroups.clear()
      fireStale()
    },
    keys(): string[] {
      return [...entries.keys()]
    },
    staleKeys(): string[] {
      return [...entries.entries()].filter(([, e]) => e.stale).map(([k]) => k)
    },
    onStale(fn: () => void): () => void {
      staleHooks.add(fn)
      return () => {
        staleHooks.delete(fn)
      }
    },
  }
}

// ── 先読みの順番待ち ────────────────────────────────────────────────────────

export interface PrefetchTask {
  /** 同じ名前の仕事は順番待ちに1つだけ置く（重ねて積まない） */
  name: string
  run: () => Promise<unknown>
}

export interface PrefetchQueue {
  /** 仕事を積む（同じ名前が待っていれば積まない）。積んだら始められるだけ始める */
  push(tasks: readonly PrefetchTask[]): void
  /** 止める条件を見直して、始められるだけ始める（画面に戻った・電波が戻った・送信待ちが空いた時に呼ぶ） */
  kick(): void
  /** 待っている仕事を捨てる（走っている仕事は止めない＝応答は控えの世代で捨てられる） */
  clear(): void
  /** 待っている数と走っている数（試験・計測用） */
  size(): { waiting: number; running: number }
  /** 終わった仕事の数・失敗した数（試験・計測用） */
  stats(): { done: number; failed: number }
}

export function createPrefetchQueue(opts: { concurrency?: number; canRun: () => boolean }): PrefetchQueue {
  const concurrency = Math.max(1, opts.concurrency ?? 2)
  const waiting: PrefetchTask[] = []
  let running = 0
  let done = 0
  let failed = 0

  const pump = (): void => {
    while (running < concurrency && waiting.length > 0) {
      let ok = false
      try {
        ok = opts.canRun()
      } catch {
        ok = false
      }
      if (!ok) return
      const task = waiting.shift()
      if (task === undefined) return
      running += 1
      let p: Promise<unknown>
      try {
        p = Promise.resolve(task.run())
      } catch (e) {
        p = Promise.reject(e)
      }
      void p
        .then(
          () => {
            done += 1
          },
          () => {
            // 先読みの失敗は黙って次へ（画面を開いた時に、画面が自分で取りに行く）
            failed += 1
          },
        )
        .finally(() => {
          running -= 1
          pump()
        })
    }
  }

  return {
    push(tasks: readonly PrefetchTask[]): void {
      for (const t of tasks) if (!waiting.some((w) => w.name === t.name)) waiting.push(t)
      pump()
    },
    kick(): void {
      pump()
    },
    clear(): void {
      waiting.length = 0
    },
    size() {
      return { waiting: waiting.length, running }
    },
    stats() {
      return { done, failed }
    },
  }
}

/**
 * 先読みしてよい端末の状態か（純関数。呼び手が今の値を集めて渡す）。
 * 画面が隠れている・オフライン・データ節約の設定・送信待ちを送っている（再送を邪魔しない）・ログインしていない間は false。
 * 止まっている送信待ち（競合・拒否で人の判断を待つもの）は数えない（残っている間ずっと先読みが止まらないように）
 */
export function prefetchAllowed(s: {
  visible: boolean
  online: boolean
  saveData: boolean
  sending: boolean
  signedIn: boolean
}): boolean {
  return s.visible && s.online && !s.saveData && !s.sending && s.signedIn
}

/** 全体で使う控え（画面と先読みが共有する） */
export const dataCache: DataCache = createDataCache()
