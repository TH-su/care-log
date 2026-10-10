// アプリの版（ビルド）の印と、新しい版の公開・画面の部品の取得失敗の見分け（F28・F60・2026-10-10）。
//
// 新しい版を公開しても、開いたままの端末は古い版のまま何日でも動き続け、どの端末がどの版かも分からなかった。
// しかも公開のたびに画面の部品（チャンク）の名前が変わるので、まだ開いていない画面へ移ると部品の取得が 404 になり、
// アプリ全体が「通信が途切れた可能性があります」に置き換わった（電波を疑って時間を失う）。
//
// ・版の印はビルドの時に焼き込む（vite.config.ts の define: __CL_BUILD__）。同じ中身を公開物の version.json にも出す
// ・端末は version.json を毎回取り直して（キャッシュを使わない）、焼き込んだ印と比べる。違えば「新しい版」
// ・自動では再読み込みしない（本人回答 2026-10-10）。画面は帯で知らせ、未保存・未送信が無い時だけ〔更新〕を出す
// ・古い版の入力止め（app_settings の min_client_build・0023）: clientBuildAllowed で通し番号を比べる。
//   止める場所は db.ts の入力解禁の判定（getNativeInputGate・getKindInputGate・書込の入口・送信待ちの送信）と、
//   App の「新しい版に更新してください」の受け皿（OutdatedGate）
// 規律: 業務データ・氏名を持たない（版の印だけ）。console に出さない。supabase に依存しない（接続未設定でも読める）

/** ビルドの印（version.json と同じ形） */
export interface BuildStamp {
  /** コミットの短いハッシュ（GitHub Actions の GITHUB_SHA の先頭12文字）。手元のビルド・開発中は 'dev' */
  id: string
  /** 公開の通し番号（GitHub Actions の GITHUB_RUN_NUMBER）。順序を比べる時に使う。手元のビルドは null */
  seq: number | null
  /** ビルドした時刻（ISO 8601）。分からなければ null */
  at: string | null
}

/** 手元のビルド・開発中の印（比べない） */
export const DEV_BUILD_ID = 'dev'

// vite.config.ts の define が置き換える（ビルドされていない環境＝node の試験では定義されない）
declare const __CL_BUILD__: unknown

/** 形の整った印だけを受け付ける（壊れた値・未知の形は null） */
export function parseBuildStamp(raw: unknown): BuildStamp | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (id === '' || id.length > 64 || !/^[0-9A-Za-z._-]+$/.test(id)) return null
  const seq = typeof r.seq === 'number' && Number.isSafeInteger(r.seq) && r.seq > 0 ? r.seq : null
  const at = typeof r.at === 'string' && r.at !== '' && !Number.isNaN(Date.parse(r.at)) ? r.at : null
  return { id, seq, at }
}

function readClientBuild(): BuildStamp {
  try {
    const raw = typeof __CL_BUILD__ === 'undefined' ? null : __CL_BUILD__
    return parseBuildStamp(raw) ?? { id: DEV_BUILD_ID, seq: null, at: null }
  } catch {
    return { id: DEV_BUILD_ID, seq: null, at: null }
  }
}

/** この端末で動いている版 */
export const CLIENT_BUILD: BuildStamp = readClientBuild()

/** 手元のビルド・開発中か（版を比べない） */
export function isDevBuild(b: BuildStamp): boolean {
  return b.id === DEV_BUILD_ID
}

/**
 * 公開中の版がこの端末の版と違うか（＝新しい版が公開された）。どちらかが開発中の印なら比べない（false）。
 * 前の版へ戻した公開（ロールバック）も「違う版」として知らせる（端末を公開中の版にそろえるため）
 */
export function isOtherBuildPublished(local: BuildStamp, remote: BuildStamp | null): boolean {
  if (remote === null) return false
  if (isDevBuild(local) || isDevBuild(remote)) return false
  return local.id !== remote.id
}

/** 画面に出す版の短い表記（例: 「a1b2c3d・#128・10/10 20:40」）。設定画面で、配信前に全端末の版を確かめるのに使う */
export function buildLabel(b: BuildStamp): string {
  if (isDevBuild(b)) return '開発版'
  const parts = [b.id.slice(0, 7)]
  if (b.seq !== null) parts.push(`#${b.seq}`)
  if (b.at !== null) {
    const d = new Date(b.at)
    if (!Number.isNaN(d.getTime())) {
      parts.push(`${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`)
    }
  }
  return parts.join('・')
}

/**
 * 公開中の版（version.json）を取り直す。Pages は10分キャッシュするので、毎回キャッシュを使わず・印を付けて取る。
 * 取れない（圏外・開発中で無い・形が違う）時は null（＝比べない）
 */
export async function fetchPublishedBuild(fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<BuildStamp | null> {
  try {
    const res = await fetchImpl(`./version.json?t=${now}`, { cache: 'no-store' })
    if (!res.ok) return null
    return parseBuildStamp(await res.json())
  } catch {
    return null
  }
}

// ── 画面の部品（チャンク）の取得失敗の見分け（F28②・F60） ────────────────────────────
// 動的 import の失敗の文言はブラウザごとに違う。Vite の先読み（modulepreload・CSS）の失敗は window に
// 'vite:preloadError' が出る（その後に同じ失敗が例外として上がる）。

const CHUNK_ERROR_RE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (?:CSS )?chunk [\w-]+ failed/i

/** 直前に先読みの失敗が出た時刻（その後に上がる例外を部品の取得失敗として扱うため） */
let lastPreloadErrorAt = 0
/** 先読みの失敗を部品の取得失敗とみなす時間 */
const PRELOAD_ERROR_WINDOW_MS = 10_000

/** 'vite:preloadError' を受けた（App が window の出来事から呼ぶ） */
export function notePreloadError(now: number = Date.now()): void {
  lastPreloadErrorAt = now
}

/** 例外が画面の部品の取得失敗か（それ以外＝画面の描画の例外） */
export function isChunkLoadError(e: unknown, now: number = Date.now()): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : typeof e === 'string' ? e : ''
  if (CHUNK_ERROR_RE.test(msg)) return true
  return lastPreloadErrorAt > 0 && now - lastPreloadErrorAt <= PRELOAD_ERROR_WINDOW_MS
}

/** 試験用: 先読みの失敗の控えを消す */
export function resetPreloadErrorForTest(): void {
  lastPreloadErrorAt = 0
}

// ── 古い版の入力止め（min_client_build・0023） ─────────────────────────────────────

/**
 * この版で入力してよいか（app_settings の min_client_build と比べる・2026-10-10 F28③）。
 * minBuild は「入力を許す最も古い公開の通し番号」（GitHub Actions の run_number）。この端末の版の通し番号（seq）が
 * それより小さければ false（＝古い版。入力と送信を止め、新しい版への更新を促す）。
 * 止めない（true）のは次の時:
 *   ・値が無い（null）・空・数字でない（設定の打ち間違いで全端末を止めない＝安全側）
 *   ・この端末が開発中の版（'dev'）か、通し番号の無い版（手元のビルド。現場の端末では使わない）
 * build は省略時この端末の版
 */
export function clientBuildAllowed(minBuild: string | null, build: BuildStamp = CLIENT_BUILD): boolean {
  if (minBuild === null) return true
  const t = minBuild.trim()
  if (!/^\d{1,9}$/.test(t)) return true
  const min = Number(t)
  if (min <= 0) return true
  if (isDevBuild(build) || build.seq === null) return true
  return build.seq >= min
}
