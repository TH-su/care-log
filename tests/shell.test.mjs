// 殻（App・設定・認証・未送信・競合・版）の回帰テスト（2026-10-10 多端末運用の監査 殻の担当:
// F01・F02・F05・F08・F12・F27・F28・F37・F38・F41・F46・F47・F49・F50・F51・F59・F60・F64・F68 と、
// 中核からの依頼 F36・F43・F48・F61・F71）。直す前の版では赤、直した後で緑になる形。
// 実行: npm test（node --experimental-strip-types --test "tests/**/*.test.mjs"）
//
// - 画面（.tsx）は JSX を含み node から読み込めないので、配線は本文の照合で確かめる（既存の試験と同じやり方）
// - 純関数（src/lib/appVersion.ts・src/lib/stoppedOps.ts・vite.config.ts の版の印）は読み込んで動かす
// - App.tsx の記録ハブの下の画面の控え（F68）は、その部分だけを esbuild で型を外して動かす
// - 個人情報は置かない（利用者・職員は合成の「利用者01」「職員01」と数値IDだけ）

import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
// コメント（行末の // と、ブロックのコメント）を外した本文（コメントの文言に引っかからないように）
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const UNSUPPORTED = 'この Node では TypeScript・解決フックを使えないため、純関数の検証をスキップしました（Node 22.18 以降で実行してください）。'

let V = null // src/lib/appVersion.ts
let S = null // src/lib/stoppedOps.ts
let VC = null // vite.config.ts
/** 読み込めなかった理由（解決フックはあるのに読めない＝直す前の版・壊れた時は、試験を飛ばさずに赤にする） */
const loadErrors = {}
let hooksOk = false
try {
  const { registerHooks } = await import('node:module')
  if (typeof registerHooks === 'function') {
    registerHooks({
      resolve(specifier, context, next) {
        if (/^\.{1,2}\//.test(specifier) && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
          try {
            return next(`${specifier}.ts`, context)
          } catch {
            // .ts が無いものは元の指定へ戻す
          }
        }
        return next(specifier, context)
      },
    })
    hooksOk = true
  }
} catch (e) {
  if (process.env.CL_TEST_DEBUG) console.error(e)
}
const load = async (name, url) => {
  try {
    return await import(url)
  } catch (e) {
    loadErrors[name] = e instanceof Error ? e.message : String(e)
    return null
  }
}
if (hooksOk) {
  V = await load('appVersion', '../src/lib/appVersion.ts')
  S = await load('stoppedOps', '../src/lib/stoppedOps.ts')
  VC = await load('vite.config', '../vite.config.ts')
}
// 解決フックが無い古い Node だけ飛ばす（読めないのは失敗として出す）
const skip = hooksOk ? false : UNSUPPORTED
/** 読み込めていることを先に確かめる（読めなければ理由つきで赤にする） */
function need(mod, name) {
  assert.ok(mod !== null, `${name} を読み込めません: ${loadErrors[name] ?? '不明'}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// F28: 新しい版の公開を知らせる（版の印・version.json・帯・部品の取得失敗の見分け）
// ─────────────────────────────────────────────────────────────────────────────

describe('★F28 版の印と新しい版の知らせ', { skip }, () => {
  afterEach(() => V?.resetPreloadErrorForTest())
  beforeEach(() => {
    need(V, 'appVersion')
    need(VC, 'vite.config')
  })

  it('ビルドの印: GitHub Actions のコミットと通し番号から作る。手元のビルドは dev（比べない）', () => {
    const at = new Date('2026-10-10T11:40:00Z')
    assert.deepEqual(VC.buildStamp({ CL_BUILD_ID: 'a1b2c3d4e5f6a7b8c9d0', CL_BUILD_SEQ: '128' }, at), {
      id: 'a1b2c3d4e5f6',
      seq: 128,
      at: '2026-10-10T11:40:00.000Z',
    })
    // GITHUB_SHA・GITHUB_RUN_NUMBER でも作れる（Actions の既定の変数）
    assert.equal(VC.buildStamp({ GITHUB_SHA: 'ffffeeee0000', GITHUB_RUN_NUMBER: '7' }, at).seq, 7)
    assert.equal(VC.buildStamp({}, at).id, 'dev')
    assert.equal(VC.buildStamp({ CL_BUILD_ID: 'bad id;', CL_BUILD_SEQ: '-1' }, at).id, 'dev')
    assert.equal(VC.buildStamp({ CL_BUILD_SEQ: '1.5' }, at).seq, null)
  })

  it('公開物に version.json を出す（ビルドの時だけ）・画面へ同じ印を焼き込む（define）', () => {
    const stamp = { id: 'abc1234', seq: 3, at: '2026-10-10T00:00:00.000Z' }
    const plugin = VC.versionJsonPlugin(stamp)
    assert.equal(plugin.apply, 'build')
    const emitted = []
    plugin.generateBundle.call({ emitFile: (f) => emitted.push(f) })
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].fileName, 'version.json')
    assert.deepEqual(JSON.parse(emitted[0].source), stamp)
    const cfg = read('vite.config.ts')
    assert.match(cfg, /define:\s*\{\s*__CL_BUILD__: JSON\.stringify\(STAMP\)/)
    assert.match(cfg, /plugins: \[react\(\), versionJsonPlugin\(STAMP\)\]/)
    const deploy = read('.github/workflows/deploy.yml')
    assert.match(deploy, /CL_BUILD_ID: \$\{\{ github\.sha \}\}/)
    assert.match(deploy, /CL_BUILD_SEQ: \$\{\{ github\.run_number \}\}/)
  })

  it('印の読み取りは形の整ったものだけ・違う版が公開されたかは id で比べる（dev は比べない）', () => {
    assert.deepEqual(V.parseBuildStamp({ id: 'abc', seq: 2, at: '2026-10-10T00:00:00Z' }), { id: 'abc', seq: 2, at: '2026-10-10T00:00:00Z' })
    assert.equal(V.parseBuildStamp({ id: '' }), null)
    assert.equal(V.parseBuildStamp({ id: '<script>' }), null)
    assert.equal(V.parseBuildStamp('abc'), null)
    assert.equal(V.parseBuildStamp({ id: 'abc', seq: 'x', at: 'not a date' }).seq, null)
    const local = { id: 'aaa', seq: 1, at: null }
    assert.equal(V.isOtherBuildPublished(local, { id: 'bbb', seq: 2, at: null }), true)
    assert.equal(V.isOtherBuildPublished(local, { id: 'aaa', seq: 1, at: null }), false)
    assert.equal(V.isOtherBuildPublished(local, null), false, '取れなかった時に「新しい版」と言った')
    assert.equal(V.isOtherBuildPublished({ id: 'dev', seq: null, at: null }, { id: 'bbb', seq: 2, at: null }), false)
    // node の試験ではビルドされていない＝この端末の版は dev
    assert.equal(V.CLIENT_BUILD.id, 'dev')
    assert.equal(V.buildLabel({ id: 'dev', seq: null, at: null }), '開発版')
    assert.match(V.buildLabel({ id: 'a1b2c3d4e5f6', seq: 128, at: null }), /^a1b2c3d・#128$/)
  })

  it('version.json はキャッシュを使わず・毎回違う印を付けて取り直す。取れなければ null（比べない）', async () => {
    const calls = []
    const ok = async (url, init) => {
      calls.push({ url, init })
      return { ok: true, json: async () => ({ id: 'xyz', seq: 9, at: null }) }
    }
    assert.deepEqual(await V.fetchPublishedBuild(ok, 1234), { id: 'xyz', seq: 9, at: null })
    assert.equal(calls[0].url, './version.json?t=1234')
    assert.equal(calls[0].init.cache, 'no-store')
    assert.equal(await V.fetchPublishedBuild(async () => ({ ok: false, json: async () => ({}) })), null)
    assert.equal(
      await V.fetchPublishedBuild(async () => {
        throw new TypeError('Failed to fetch')
      }),
      null,
    )
  })

  it('部品（チャンク）の取得失敗をブラウザごとの文言と先読みの失敗で見分ける（描画の例外とは分ける）', () => {
    assert.equal(V.isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/MorePage-5sOwB5gi.js')), true)
    assert.equal(V.isChunkLoadError(new TypeError('Importing a module script failed.')), true)
    assert.equal(V.isChunkLoadError(new TypeError('error loading dynamically imported module')), true)
    assert.equal(V.isChunkLoadError(new Error('Unable to preload CSS for /assets/PrintArea-x.css')), true)
    assert.equal(V.isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'name')")), false)
    // 先読みの失敗（vite:preloadError）の直後の例外は部品の取得失敗。時間がたてば描画の例外として扱う
    V.notePreloadError(1_000)
    assert.equal(V.isChunkLoadError(new Error('x'), 5_000), true)
    assert.equal(V.isChunkLoadError(new Error('x'), 20_000), false)
  })

  it('古い版の入力止め（min_client_build）: 開発中の版と未設定は止めない（比べ方は tests/server-mdfix.test.mjs）', () => {
    assert.equal(typeof V.clientBuildAllowed, 'function')
    assert.equal(V.clientBuildAllowed('200'), true)
    assert.equal(V.clientBuildAllowed(null, { id: 'abc', seq: 1, at: null }), true)
  })

  it('App: 開いたままの端末で version.json を取り直し、違えば帯。〔更新〕は未保存・未送信が無い時だけ・自動では再読み込みしない', () => {
    const app = code('src/App.tsx')
    assert.match(app, /fetchPublishedBuild\(\)/)
    assert.match(app, /isOtherBuildPublished\(CLIENT_BUILD, remote\)\) setNewBuild\(true\)/)
    assert.match(app, /document\.addEventListener\('visibilitychange', onVis\)/)
    assert.match(app, /新しい版が公開されました。/)
    assert.match(app, /const canReloadForBuild = pending === 0 && !unpersisted && !hasUnsavedInput\(\)/)
    assert.match(app, /\{canReloadForBuild && \(/)
    // 押した時にもう一度確かめてから再読み込みする
    const reload = app.slice(app.indexOf('const reloadForBuild = () =>'), app.indexOf('const reloadForBuild = () =>') + 400)
    assert.match(reload, /db\.queuePending\(\) > 0 \|\| db\.hasUnpersistedQueue\(\) \|\| hasUnsavedInput\(\)/)
    // 版を確かめる処理の中で再読み込みしない（自動の再読み込みはしない＝本人回答）
    const check = app.slice(app.indexOf('const check = async () =>'), app.indexOf('const check = async () =>') + 300)
    assert.doesNotMatch(check, /location\.reload/)
    // 帯は印刷に出さない
    const band = app.slice(app.indexOf('{newBuild && ('), app.indexOf('{newBuild && (') + 300)
    assert.match(band, /print:hidden/)
  })

  it('App: 部品の取得失敗は「通信が途切れた」ではなく、公開中の版が違えば「新しい版が公開されました」と出す（外側・画面ごとの両方）', () => {
    const app = code('src/App.tsx')
    assert.match(app, /window\.addEventListener\('vite:preloadError', \(\) => notePreloadError\(\)\)/)
    assert.match(app, /return \{ failed: isChunkLoadError\(e\) \? 'chunk' : 'render' \}/)
    assert.match(app, /<KindBoundary fallback=\{\(kind\) => <StartupError kind=\{kind\} \/>\}>/)
    assert.match(app, /differs === true \?/)
    assert.match(app, /<h1 className="text-xl font-heavy text-ink">新しい版が公開されました<\/h1>/)
    // 版を比べられない時の通信の案内（従来の文言）は残す
    assert.match(app, /通信が途切れた可能性があります。電波状態を確認してから、再読み込みしてください。/)
  })

  it('設定画面に、この端末の版を出す（配信前に全端末の版を確かめる）', () => {
    const s = code('src/pages/SettingsPage.tsx')
    assert.match(s, /この端末の版: <span className="tabular font-bold">\{buildLabel\(CLIENT_BUILD\)\}<\/span>/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F60: 画面ごとの例外の受け皿（ヘッダ・タブを残す）
// ─────────────────────────────────────────────────────────────────────────────

describe('★F60 画面ごとの例外の受け皿', () => {
  it('<main> の中で Suspense・Routes を包み、ヘッダ・タブ・未送信の件数は外に残す。画面を移ると元に戻る', () => {
    const app = code('src/App.tsx')
    const main = app.slice(app.indexOf('<main className='), app.indexOf('</main>'))
    const open = main.indexOf('<KindBoundary')
    const susp = main.indexOf('<Suspense\n')
    const close = main.indexOf('</KindBoundary>')
    assert.ok(open >= 0 && susp > open && close > main.indexOf('</Suspense>'), '画面の受け皿が Suspense・Routes を包んでいない')
    assert.match(main, /resetKey=\{location\.pathname\}/)
    assert.match(main, /<PageFailure\n\s*kind=\{kind\}\n\s*pathname=\{location\.pathname\}\n\s*unpersisted=\{unpersisted\}\n\s*isUnpersisted=\{\(\) => db\.hasUnpersistedQueue\(\)\}/)
    // ヘッダの未送信の件数は受け皿の外（<main> より前）
    assert.ok(app.indexOf('未送信 ${pending}件') < app.indexOf('<main className='), 'ヘッダが受け皿の中に入った')
    // 包み要素を作らない（印刷レイアウトを変えない）: render は children をそのまま返す
    assert.match(app, /return this\.state\.failed !== null \? this\.props\.fallback\(this\.state\.failed\) : this\.props\.children/)
    assert.match(app, /if \(this\.state\.failed !== null && prev\.resetKey !== this\.props\.resetKey\) this\.setState\(\{ failed: null \}\)/)
  })

  it('描画の例外は「通信」と言わず、送信待ちが消えていないことと逃げ道（タブ・日報へ/その他へ）を出す。現在地の控えは既定へ戻す', () => {
    const app = code('src/App.tsx')
    assert.match(app, /この画面で問題が起きました/)
    assert.match(app, /送信待ちの記録は消えていません。/)
    assert.match(app, /to=\{pathname === '\/' \? '\/more' : '\/'\}/)
    assert.match(app, /if \(kind === 'render'\) writeView\(DEFAULT_VIEW\)/)
    // 端末に残せていない送信待ちがある時は再読み込みのボタンを出さない（消えるため）
    const pf = app.slice(app.indexOf('function PageFailure('), app.indexOf('function OfflineGate('))
    assert.match(pf, /\{unpersisted \|\| blocked \? \(/)
    // 押した時にも確かめ直す（描いた後に残せなくなっていれば再読み込みしない）
    assert.match(pf, /if \(isUnpersisted\(\)\) \{\n\s*setBlocked\(true\)\n\s*return\n\s*\}\n\s*window\.location\.reload\(\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F01・F27③・F36: ヘッダと帯
// ─────────────────────────────────────────────────────────────────────────────

describe('★F01 端末に残せていない送信待ち（App 全体）', () => {
  it('離れる前の確認に App で1回だけ「消える入力」として数える・ヘッダの件数に「端末に残せていません」を添える', () => {
    const app = code('src/App.tsx')
    assert.match(app, /useEffect\(\(\) => registerUnsaved\(\(\) => db\.hasUnpersistedQueue\(\), 'input'\), \[db\]\)/)
    assert.match(app, /setUnpersisted\(db\.hasUnpersistedQueue\(\)\)/)
    assert.match(app, /`▲ 未送信 \$\{pending\}件・端末に残せていません`/)
    // 従来の件数の表示は残す
    assert.match(app, /`⚠ 未送信 \$\{pending\}件`/)
    // 設定画面にも出す
    assert.match(code('src/pages/SettingsPage.tsx'), /端末の保存領域が一杯のため、送信待ちを端末に残せていません。/)
  })
})

describe('★F27 この版で読めない未送信（別の版の画面のタブ）', () => {
  it('App: queueUnreadableCount が 0 でなければ、すべて閉じて開き直すよう帯で知らせる（印刷に出さない）', () => {
    const app = code('src/App.tsx')
    assert.match(app, /setUnreadable\(db\.queueUnreadableCount\(\)\)/)
    const band = app.slice(app.indexOf('{unreadable > 0 && ('), app.indexOf('{unreadable > 0 && (') + 400)
    assert.match(band, /print:hidden/)
    assert.match(band, /この端末に別の版の画面のタブが開いています。すべて閉じてから開き直してください/)
  })
  it('設定画面: 「読み取れませんでした…管理者に連絡」だけで終えず、タブを閉じて開き直す導線を出す', () => {
    const s = code('src/pages/SettingsPage.tsx')
    assert.match(s, /queueBroken \|\| unreadable > 0 \?/)
    assert.match(s, /この端末で開いているケアログのタブ（画面）をすべて閉じてから、開き直してください。/)
  })
})

describe('F36 端末の時刻帯の帯（中核2の依頼）', () => {
  it('起動時と画面に戻った時に確かめ、日本時間でなければ常時の帯（入力は止めない・閉じない・印刷に出さない）', () => {
    const app = code('src/App.tsx')
    assert.match(app, /useState<string \| null>\(\(\) => deviceTimeZoneWarning\(\)\)/)
    assert.match(app, /if \(document\.visibilityState === 'visible'\) setTzWarning\(deviceTimeZoneWarning\(\)\)/)
    const band = app.slice(app.indexOf('{tzWarning !== null && ('), app.indexOf('{tzWarning !== null && (') + 300)
    assert.match(band, /print:hidden/)
    assert.doesNotMatch(band, /onClick/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F46・F38・F47・F50: 記録者と名簿
// ─────────────────────────────────────────────────────────────────────────────

describe('★F46・F38 記録者の切り替えがその場で App に届く', () => {
  it('App は subscribeActor を受けて、名簿と照合した記録者を取り直す（名簿を読めるまでは何もしない）', () => {
    const app = code('src/App.tsx')
    assert.match(
      app,
      /if \(staff === null\) return undefined\n\s*return actor\.subscribeActor\(\(\) => setActorId\(actor\.resolveActor\(staff\)\?\.id \?\? null\)\)\n\s*\}, \[actor, staff\]\)/,
    )
    // db.setEditor は actorId に追従する（edited_by にも届く）
    assert.match(app, /db\.setEditor\(actorId\)/)
  })
  it('設定画面の「いまの記録者」も、他の所（バイタル・食事の記録者・別のタブ）での切り替えに合わせる', () => {
    const s = code('src/pages/SettingsPage.tsx')
    assert.match(s, /useEffect\(\(\) => subscribeActor\(\(id\) => setActorIdState\(id\)\), \[\]\)/)
    // 切り替えは actor.setActorId（知らせる側）を通す
    assert.match(s, /import \{ getActorId, setActorId as persistActorId, subscribeActor, touchActivity \} from '\.\.\/lib\/actor'/)
  })
})

describe('★F47 職員名簿を新しく保つ', () => {
  it('App は名簿を読めた後に watchStaffRoster を張る（失敗した時の全画面エラーの経路は通さない）', () => {
    const app = code('src/App.tsx')
    assert.match(app, /useEffect\(\(\) => \(staff === null \? undefined : db\.watchStaffRoster\(staff, setStaff\)\), \[db, staff\]\)/)
    // 記録者の既定が名簿から外れても黙って外さず、選び直しを促す
    assert.match(app, /const actorOffRoster = actorId !== null && staff\.length > 0 && !staff\.some\(\(s\) => s\.id === actorId\)/)
    assert.match(app, /記録者の既定（いまの記録者）が職員名簿にありません/)
  })
  it('設定画面の職員の一覧も、名簿が変わった合図で取り直す', () => {
    const s = code('src/pages/SettingsPage.tsx')
    assert.match(s, /subscribeMastersChanged\(\(\) => \{\n\s*setResidentsReload\(\(n\) => n \+ 1\)\n\s*setStaffReload\(\(n\) => n \+ 1\)/)
    assert.match(s, /fetchStaff\(\)\n\s*\.then\(\(rows\) => \{[\s\S]{0,300}?\}, \[staffReload\]\)/)
  })
})

describe('★F50 名簿の自動同期と最終同期', () => {
  it('App に MasterAutoSync を1つ（職員が空の案内の後・画面の前）、設定画面に MasterSyncStatus を置く', () => {
    const app = code('src/App.tsx')
    assert.match(app, /const MasterAutoSync = lazy\(\(\) => import\('\.\/components\/MasterSync'\)/)
    assert.equal(app.split('<MasterAutoSync />').length - 1, 1)
    assert.ok(app.indexOf('<MasterAutoSync />') > app.indexOf('職員の一覧がまだありません'))
    assert.ok(app.indexOf('<MasterAutoSync />') < app.lastIndexOf('<Routes>'))
    assert.match(code('src/pages/SettingsPage.tsx'), /<MasterSyncStatus \/>/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F49・F51・F43・F71: 設定画面のマスタ同期・要確認・表示名
// ─────────────────────────────────────────────────────────────────────────────

describe('★F49・F51 要確認の利用者（退去済みも出す・名簿の氏名を採用する）', () => {
  it('要確認の一覧は退去された方も含む全員から作り、退去済みに印を付ける', () => {
    const s = code('src/pages/SettingsPage.tsx')
    assert.doesNotMatch(s, /\bfetchResidents\(/, '在籍だけの一覧から要確認を作っている')
    assert.match(s, /fetchAllResidents\(\)\n\s*\.then\(\(rs\) => \{\n\s*if \(alive\) setResidents\(rs\)/)
    assert.match(s, /\{!r\.active \? <Chip tone="plain">退去済み<\/Chip> : null\}/)
  })
  it('直前の同期の reviews（画面の state だけ）があれば、確認の後に adoptRosterName。stale なら知らせて読み直す', () => {
    const s = code('src/pages/SettingsPage.tsx')
    assert.match(s, /setReviews\(Array\.isArray\(res\.reviews\) \? res\.reviews : \[\]\)/)
    assert.match(s, /onClick=\{\(\) => setAdoptAsk\(rv\)\}/)
    assert.match(s, /const r = await adoptRosterName\(rv\.id, rv\.current, rv\.roster\)/)
    assert.match(s, /他の端末が先に直しました。もう一度「マスタを同期する」を押してください。/)
    assert.match(s, /「マスタを同期する」を押すと、名簿の氏名がここに出ます/)
    // 氏名を端末に保存しない・console に出さない
    assert.doesNotMatch(s, /localStorage\.setItem\([^)]*review/i)
    assert.doesNotMatch(s, /console\./)
    // 「この画面から保留を解除することはできません」は新しい操作と食い違うので外した
    assert.doesNotMatch(s, /この画面から保留を解除することはできません/)
  })
})

describe('F43 名簿から一度に外れる人数で止まった時（中核3の依頼）', () => {
  it('MasterDropError を受けたら人数の確認を出し、確かめた後に confirmedDrop を渡して続ける（再試行は確認へ）', () => {
    const s = code('src/pages/SettingsPage.tsx')
    assert.match(s, /e\.name === 'MasterDropError'/)
    assert.match(s, /setConfirmKind\('massDrop'\)/)
    assert.match(s, /syncMasters\(confirmedDrop === undefined \? undefined : \{ confirmedDrop \}\)/)
    assert.match(s, /else if \(kind === 'massDrop' && massDrop !== null\) void handleSync\(massDrop\)/)
    assert.match(s, /massDrop !== null\n\s*\? [^\n]*\n\s*\(\) => setConfirmKind\('massDrop'\)/)
  })
})

describe('F71 表示名の送り直しの基準（中核1の依頼）', () => {
  it('setResidentNoteAlias の3つ目にサーバーから読んだ表示名を渡す（送信待ちで置き換えた画面の値は渡さない）', () => {
    const s = code('src/pages/SettingsPage.tsx')
    // 2026-10-10（サーバー移行の担当・F71 の続き）: 保存の直前に読み直せた時は、いまのサーバーの値を基準にする
    assert.match(s, /const saved = await setResidentNoteAlias\(r\.id, check\.value, baseForSave\)/)
    assert.match(s, /let baseForSave = Object\.prototype\.hasOwnProperty\.call\(aliasServer, r\.id\) \? aliasServer\[r\.id\] : undefined/)
    assert.match(s, /if \(now !== undefined\) baseForSave = now\.note_alias \?\? null/)
    // aliasServer を書くのは、読み直した時とサーバーが保存した値を返した時だけ（queued の分岐では書かない）
    const qStart = s.indexOf("if (saved === 'queued') {")
    const queued = s.slice(qStart, s.indexOf('return\n        }', qStart))
    assert.doesNotMatch(queued, /setAliasServer/)
    assert.match(s, /setAliasServer\(\(m\) => \(\{ \.\.\.m, \[saved\.id\]: saved\.note_alias \?\? null \}\)\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F02・F37: 止まっている記録（送れていない記録）
// ─────────────────────────────────────────────────────────────────────────────

describe('★F02・F37 止まっている記録の中身を出す言葉（stoppedOps.ts）', { skip }, () => {
  beforeEach(() => need(S, 'stoppedOps'))
  const name = (id) => `利用者0${id}`
  it('見出し・理由: 表と種類（追加・修正・取り消し・表示名）・競合と拒否', () => {
    assert.equal(S.stoppedOpTitle({ table: 'med_admin', kind: 'insert', payload: {} }), '与薬の追加')
    assert.equal(S.stoppedOpTitle({ table: 'bath_records', kind: 'update', payload: { note: 'x' } }), '入浴（デイ）の修正')
    assert.equal(S.stoppedOpTitle({ table: 'fluid_intake', kind: 'update', payload: { deleted_at: '2026-10-10T00:00:00Z' } }), '水分の取り消し')
    assert.equal(S.stoppedOpTitle({ table: 'residents', kind: 'alias', payload: {} }), '申し送りでの表示名の変更')
    assert.match(S.stoppedOpReason({ state: 'conflict', errCode: null }), /他の端末で先に/)
    assert.match(S.stoppedOpReason({ state: 'rejected', errCode: '23514' }), /受け付けられず.*23514/)
  })
  it('中身: 対象・日付・値を言葉で出す（拒否と服用済みを取り違えない）。内部の列名は出さない', () => {
    const op = { table: 'med_admin', kind: 'insert', payload: { resident_id: 1, admin_on: '2026-10-10', slot: 'morning', status: 'refused', note: '本人拒否（合成）', client_key: 'k', recorded_by: 11, auto: false } }
    const lines = S.stoppedOpLines(op, name)
    assert.deepEqual(lines, [
      { label: '対象', value: '利用者01' },
      { label: '日付', value: '10/10' },
      { label: '時間帯', value: '朝' },
      { label: '状態', value: '拒否（再度の声かけ後も）' },
      { label: '備考', value: '本人拒否（合成）' },
    ])
    // いまの行（相手の記録）を同じ欄・同じ言葉で並べる
    const theirs = S.stoppedOpLines(op, name, { id: 50, rev: 1, resident_id: 1, admin_on: '2026-10-10', slot: 'morning', status: 'taken', note: null })
    assert.deepEqual(theirs.find((l) => l.label === '状態'), { label: '状態', value: '服用済み' })
    assert.deepEqual(theirs.find((l) => l.label === '備考'), { label: '備考', value: '未入力' })
    for (const l of [...lines, ...theirs]) assert.doesNotMatch(`${l.label}${l.value}`, /client_key|recorded_by|resident_id|auto/)
    // 知らない列は数だけ出す
    const inc = S.stoppedOpLines({ table: 'incidents', kind: 'update', payload: { detail: { visit_methods: [] }, office: 'facility' } }, name)
    assert.deepEqual(inc.at(-1), { label: 'ほか', value: '2項目' })
  })
  it('取り消し: この端末の中身は「取り消す」、いまの行が取り消し済みなら「取り消されています」', () => {
    const op = { table: 'outings', kind: 'update', payload: { deleted_at: '2026-10-10T00:00:00Z', resident_id: 2, start_on: '2026-10-09' } }
    assert.equal(S.isStoppedDelete(op), true)
    assert.ok(S.stoppedOpLines(op, name).some((l) => l.value === 'この記録を取り消す'))
    assert.ok(S.stoppedOpLines(op, name, { deleted_at: '2026-10-10T01:00:00+00:00' }).some((l) => l.value === '取り消されています'))
  })
  it('くらべてから送る種類: 競合した修正・取り消し・表示名・自然キーで止まった追加（入浴・与薬・服薬の時間帯）。拒否は送り直すだけ', () => {
    assert.equal(S.stoppedOpNeedsCompare({ table: 'bath_records', kind: 'update', state: 'conflict' }), true)
    assert.equal(S.stoppedOpNeedsCompare({ table: 'residents', kind: 'alias', state: 'conflict' }), true)
    assert.equal(S.stoppedOpNeedsCompare({ table: 'med_admin', kind: 'insert', state: 'conflict' }), true)
    assert.equal(S.stoppedOpNeedsCompare({ table: 'fluid_intake', kind: 'insert', state: 'conflict' }), false)
    assert.equal(S.stoppedOpNeedsCompare({ table: 'med_admin', kind: 'insert', state: 'rejected' }), false)
  })
})

describe('★F02・F37 設定画面の「送れていない記録」', () => {
  it('listStoppedOps の一覧を出し、くらべた版を渡して送り直す・確認の後に取り下げる。通知のたびに引き直す', () => {
    const s = code('src/pages/SettingsPage.tsx')
    assert.match(s, /<StoppedOpsList\n\s*ops=\{stoppedOps\}/)
    assert.match(s, /setStoppedOps\(listStoppedOps\(\)\)/)
    assert.match(s, /queueSubscribe\(\(n\) => \{\n\s*setPending\([^\n]*\n\s*refreshQueueView\(\)/)
    assert.match(s, /const row = await fetchQueuedOpTarget\(op\.qid\)/)
    // くらべた行の版（rev）・表示名・相手の行 id を渡す（渡さないと送らない契約）
    assert.match(s, /if \(op\.kind === 'alias'\) arg = \{ alias: typeof seen\.note_alias === 'string' \? seen\.note_alias : null \}/)
    assert.match(s, /else if \(op\.kind === 'insert'\) arg = \{ id: Number\(seen\.id\), rev: Number\(seen\.rev\) \}/)
    assert.match(s, /else arg = \{ rev: Number\(seen\.rev\) \}/)
    assert.match(s, /const r = await resendQueuedOp\(op\.qid, arg\)/)
    // 修正・表示名で行が見つからない時は〔もう一度送る〕を出さない（版を渡せず毎回止まるだけ）。送り直せるのは自然キーの追加だけ
    assert.match(s, /\{!needsCompare \|\| \(op\.kind === 'insert' && hasTarget && \(target === null \|\| target === undefined\)\) \? \(/)
    // 〔この端末の内容で直す〕はくらべた後にだけ出す
    assert.match(s, /\{needsCompare && hasTarget && target !== null && target !== undefined && !alreadyDeleted \? \(/)
    // 取り下げは確認の後（見せた中身を確認文にも出す）
    assert.match(s, /onClick=\{\(\) => setAskDrop\(op\)\}/)
    assert.match(s, /const r = await discardQueuedOp\(op\.qid\)/)
    assert.match(s, /title="この記録を取り下げますか"/)
  })
  it('件数を「止まっている（人の判断が要る）」と「送信待ち（自動で送る）」に分け、止まった件に「自動で送信します」と言わない', () => {
    const s = code('src/pages/SettingsPage.tsx')
    assert.match(s, /`うち止まっている（人の判断が要る）記録 \$\{stoppedTotal\}件`/)
    assert.match(s, /`・送信待ち \$\{pending - stoppedTotal\}件（電波が戻ると自動で送信します）`/)
    // 以前の「管理者に連絡してください」だけの案内と、積み残しのコメントは外した
    const raw = read('src/pages/SettingsPage.tsx')
    assert.doesNotMatch(raw, /件数の内訳表示は db\.ts の契約追加が要るため積み残し/)
    assert.doesNotMatch(raw, /ほかの端末で同じ記録が先に更新された可能性があります。記録は消えていません。管理者に連絡してください。/)
  })
  it('ログイン画面: 止まった件があれば「ログインすると自動で送信されます」と言い切らない', () => {
    const g = code('src/pages/AuthGates.tsx')
    assert.match(g, /const s = m\.listStoppedOps\(\)\.length \+ notes/)
    assert.match(g, /\{stopped > 0 \? \(/)
    assert.match(g, /ログインした後に設定画面の「送れていない記録」から選んでください。/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F05・F41: 送れていない申し送り
// ─────────────────────────────────────────────────────────────────────────────

describe('★F05 申し送りの登録の取り下げ（ほかのタブにも効く・既に登録されていた時は知らせる）', () => {
  it('取り下げは discardQueuedOp（墓標）で、戻り値 sent なら「既に登録されていました」を一覧の上に残す', () => {
    const u = code('src/components/UnsentNotes.tsx')
    assert.match(u, /const r = await discardQueuedOp\(u\.op\.qid\)/)
    // 登録後の変更（ck）は、取り下げられた時だけ外す（既に登録されていた時は、登録された行への修正として残す）
    assert.match(u, /if \(r === 'dropped' && Object\.keys\(vers\)\.length > 0\) await discardPendingNote\(\{ clientKey: u\.op\.qid \}, undefined, vers\)/)
    assert.match(u, /if \(r === 'sent'\) \{\n\s*[^\n]*\n?\s*setNotice\(/)
    assert.match(u, /既に登録されていました（取り下げられませんでした）/)
    // 「この端末からも消えます」（挙動と食い違う文言）をやめた
    assert.doesNotMatch(read('src/components/UnsentNotes.tsx'), /取り下げると、この端末からも消えます。/)
    assert.match(u, /この端末（同じ端末のほかのタブを含む）の送信待ちから外れます/)
  })
})

describe('★F41 送れていない申し送りの記入者', () => {
  it('各件に記入者を出し、確認文は記入者がいまの記録者と違えば名前で出す', () => {
    const u = code('src/components/UnsentNotes.tsx')
    assert.match(u, /\{u\.kind === 'insert' \? '記入者' : '申し送りの記入者'\}：/)
    assert.match(u, /<span className="font-bold text-ink">\{reporterText\(u\)\}<\/span>/)
    // 手直し: 「あなたの」は本文を入力した職員（送信待ちの欄ごとの入力者）がいまの記録者の時だけ。記入者だけで分けない
    assert.match(u, /whose = t === actorId \? 'あなたの' : `「\$\{staffName\(t\)\}」が入力した`/)
    assert.match(u, /const bys = u\.kind === 'insert' \? u\.op\.changes\?\.bys : u\.row\.bys/)
    assert.match(u, /この変更を入力した職員：/)
    // 入力した職員が分からない時に「あなたの」と言わない
    assert.match(u, /'この端末に残っている（入力した職員を確かめられない）'/)
    assert.doesNotMatch(u, /typeof r === 'number' && r !== actorId \? `記入者「\$\{staffName\(r\)\}」の` : 'あなたの'/)
    // 元の申し送りの記入者は一覧を開いた時に読み直す（画面のメモリだけ）
    assert.match(u, /fetchNoteRows\(ids\)/)
  })
  it('〔新しい行として登録〕でも記入者は元の人のまま（押した人＝この端末の操作者の名義にしない）', () => {
    const u = code('src/components/UnsentNotes.tsx')
    assert.doesNotMatch(u, /reporterId: actorId/)
    assert.match(u, /const res = await insertNoteAsNew\(\{ key: newKey, meta, body, reporterId: reporterId \?\? null \}\)/)
    // 元の記入者を確かめられない時は登録しない（別人の名義を作らない）
    assert.match(u, /元の申し送りの記入者を確かめられないため、新しい行にできません/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F08・F12・F48: くらべて選ぶ
// ─────────────────────────────────────────────────────────────────────────────

describe('★F08 継続の終了の〔くらべて選ぶ〕', () => {
  it('基準は分かる欄だけに付ける（分からない ended_by を null として送らない）・分からない値を「未入力」と言わない', () => {
    const c = code('src/components/ConflictResolver.tsx')
    assert.doesNotMatch(c, /edits\[f as NoteEditField\] = \{ value: mine\.values\[f\], base: row\[f\] \?\? null \}\n/)
    assert.match(c, /const known = Object\.prototype\.hasOwnProperty\.call\(row, f\) && row\[f\] !== undefined/)
    assert.match(c, /edits\[f as NoteEditField\] = known \? \{ value: mine\.values\[f\], base: row\[f\] \?\? null \} : \{ value: mine\.values\[f\] \}/)
    assert.match(c, /latestRow !== undefined && latestRow\[f\] === undefined \? '（確かめられません）'/)
  })
  it('本文の無い競合（継続の終了など）で「先の本文を残す」と出さない', () => {
    const c = code('src/components/ConflictResolver.tsx')
    assert.match(c, /\{missing \|\| deleting \? '取り下げる' : mineBody !== null \? '先の本文を残す' : '先の内容を残す'\}/)
  })
})

describe('★F12 血圧の相方を見せてから組で書く（くらべて選ぶの表示）', () => {
  it('あなたの入力に無い相方の欄は「あなたの画面で見ていた値」と出し、〔自分の値で直す〕の説明に書き戻す値を出す', () => {
    const c = code('src/components/ConflictResolver.tsx')
    assert.match(c, /\{Object\.prototype\.hasOwnProperty\.call\(mine, c\.field\) \? 'あなたの入力' : 'あなたの画面で見ていた値'\}：/)
    assert.match(c, /const pairBack = useMemo\(\n\s*\(\) => columns\.filter\(\(c\) => !Object\.prototype\.hasOwnProperty\.call\(mine, c\.field\)\),/)
    assert.match(c, /血圧は上下を組で書くため、/)
    // 送る中身は従来どおり（見ていた値で補う・logic.test の #3）
    assert.match(c, /withBpPair\(patchForMine\(fields, mine, latestCells\), mine, base\)/)
  })
})

describe('F48 くらべて選ぶの名前は退職者も含む全員から引く（中核2の依頼）', () => {
  it('バイタル・食事と申し送りの両方で fetchAllStaff を使う（読めなければ渡された名簿）', () => {
    const c = code('src/components/ConflictResolver.tsx')
    assert.equal(c.split('fetchAllStaff().catch(').length - 1, 2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F59: 圏外の起動
// ─────────────────────────────────────────────────────────────────────────────

describe('★F59 圏外で起動した時はログイン画面へ移さない', () => {
  it('useAuth: getSession の通信エラー（AuthRetryableFetchError）を offline として持ち、null の通知では解かない', () => {
    const a = code('src/hooks/useAuth.ts')
    assert.match(a, /import \{ isAuthRetryableFetchError \} from '@supabase\/supabase-js'/)
    assert.match(a, /\} else if \(error && isAuthRetryableFetchError\(error\)\) \{\n\s*offlineNow = true\n\s*setOffline\(true\)/)
    assert.match(a, /if \(offlineNow\) return\n\s*setSession\(null\)/)
    assert.match(a, /if \(event === 'SIGNED_OUT'\) \{\n\s*offlineNow = false/)
    assert.match(a, /return \{ session, ready, offline, user:/)
  })
  it('App: offline の時はログイン画面（別の部品）も /login への移動も出さず、電波が戻ると自動で開く案内を出す', () => {
    const app = code('src/App.tsx')
    assert.match(app, /const \{ ready, session, offline \} = deps\.useAuth\(\)/)
    const shell = app.slice(app.indexOf('function Shell('), app.indexOf('function hookAuthExpired('))
    assert.ok(shell.indexOf('if (!session && offline) return <OfflineGate />') < shell.indexOf('<Route path="/login" element={<LoginPage />} />'))
    assert.match(app, /ログインし直す必要はありません。電波が戻ってから1分ほどで自動で開きます。/)
  })
  it('401 の時の更新が通信エラーなら、端末の session（更新トークン）を捨てない', () => {
    const app = code('src/App.tsx')
    const h = app.slice(app.indexOf('const handleAuthExpired = useCallback('), app.indexOf('const handleAuthExpired = useCallback(') + 900)
    assert.match(h, /if \(error && error\.name === 'AuthRetryableFetchError'\) return/)
    assert.ok(h.indexOf("error.name === 'AuthRetryableFetchError'") < h.indexOf("signOut({ scope: 'local' })"))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F61: 許可リスト外のアカウント（中核2の依頼・記録ハブ／その他）
// ─────────────────────────────────────────────────────────────────────────────

describe('F61 許可リスト外の案内（記録ハブ・その他）', () => {
  it('入力解禁の forbidden を受けたら、封鎖の文・通信エラーではなく FORBIDDEN_REASON を出す（再試行は出さない）', () => {
    const hub = code('src/pages/RecordHubPage.tsx')
    assert.match(hub, /if \(gate\.forbidden === true\) \{\n\s*[^\n]*\n?[^\n]*\n?\s*setForbidden\(true\)/)
    assert.match(hub, /\{forbidden \? \(/)
    assert.match(hub, /return g\.forbidden === true \? FORBIDDEN_REASON : unknown/)
    // 既存の封鎖の判定は変えない
    assert.match(hub, /key === 'incident' \? incidentLocked : key === 'bath' \? bathLocked : key === 'med' \? medLocked : locked/)
    const more = code('src/pages/MorePage.tsx')
    assert.match(more, /setLoadError\(FORBIDDEN_REASON\)/)
    assert.match(more, /onRetry=\{loadError === FORBIDDEN_REASON \? undefined : /)
    assert.match(more, /const recordLocked = locked && !bathEnabled && !medEnabled/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F64: 通知の出し入れで画面全体を描き直さない部品
// ─────────────────────────────────────────────────────────────────────────────

describe('F64 useToastHost（通知の state を小さな部品に持つ）', () => {
  it('useToast と同じ呼び方。toast と show は作り直さず、show は ref 経由で部品へ渡す。既存の useToast は残す', () => {
    const ui = code('src/components/ui.tsx')
    assert.match(ui, /export function useToast\(\): \{ toast: ReactNode; show:/)
    assert.match(ui, /export function useToastHost\(\): \{ toast: ReactNode; show: \(msg: string, undo\?: \(\) => void\) => void \}/)
    const host = ui.slice(ui.indexOf('export function useToastHost('), ui.indexOf('export function useToastHost(') + 700)
    assert.match(host, /const show = useCallback\(\(msg: string, undo\?: \(\) => void\) => \{[\s\S]*?\}, \[\]\)/)
    assert.match(host, /const toast = useMemo\(\(\) => <ToastHost handleRef=\{handleRef\} pendingRef=\{pendingRef\} \/>, \[\]\)/)
    // 部品が描かれる前に頼まれた通知も取りこぼさない
    assert.match(ui, /const waiting = pendingRef\.current\n\s*if \(waiting !== null\) \{/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F68: 記録ハブの下の画面へ戻す
// ─────────────────────────────────────────────────────────────────────────────

describe('★F68 ホーム画面から開いた時に記録ハブの下の画面へ戻す（cl_recordTab）', () => {
  it('許可リスト（設計の vitals/meals/note/outing）の画面だけを控え、記録ハブ・それ以外の /record/* では控えを消す', async () => {
    const src = read('src/App.tsx')
    const part = src.slice(src.indexOf('const RECORD_TABS = '), src.indexOf('// HashRouter が hash を書き換える前に'))
    assert.ok(part.length > 0, '記録ハブの下の画面の控えが無い')
    const { transformSync } = await import('esbuild')
    const js = `${transformSync(part, { loader: 'ts' }).code}\nreturn { RECORD_TABS, recordTabOf, readRecordTab, writeRecordTab }`
    const store = new Map()
    const fakeWindow = {
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
    }
    const m = new Function('window', 'LS', js)(fakeWindow, { recordTab: 'cl_recordTab' })
    assert.deepEqual([...m.RECORD_TABS], ['vitals', 'meals', 'note', 'outing'])
    assert.equal(m.recordTabOf('/record/vitals'), 'vitals')
    assert.equal(m.recordTabOf('/record/meals'), 'meals')
    assert.equal(m.recordTabOf('/record'), null)
    assert.equal(m.recordTabOf('/record/bath'), null)
    assert.equal(m.recordTabOf('/karte'), undefined)
    m.writeRecordTab('meals')
    assert.equal(m.readRecordTab(), 'meals')
    store.set('cl_recordTab', '../settings')
    assert.equal(m.readRecordTab(), null, '許可リスト外の値を読んだ')
    m.writeRecordTab(null)
    assert.equal(store.has('cl_recordTab'), false)
  })
  it('起動時に読み切り、cl_view が record の時だけ /record/<画面> へ戻す。画面を移るたびに控える', () => {
    const app = code('src/App.tsx')
    assert.match(app, /const STORED_RECORD_TAB = typeof window === 'undefined' \? null : readRecordTab\(\)/)
    assert.match(app, /if \(STORED_VIEW === 'record' && STORED_RECORD_TAB !== null\) \{\n\s*navigate\(`\/record\/\$\{STORED_RECORD_TAB\}`, \{ replace: true \}\)/)
    assert.match(app, /const rt = recordTabOf\(location\.pathname\)\n\s*if \(rt !== undefined\) writeRecordTab\(rt\)/)
  })
})

describe('F37 事故の追記の中身を、取り下げる前に見せる（stoppedOps.ts）', () => {
  it('detail の文の欄（原因・再発防止策など）を値で出し、氏名の写しは出さない', () => {
    need(S, 'stoppedOps')
    const op = {
      table: 'incidents',
      kind: 'update',
      payload: { detail: { cause: '段差（合成）', prevention: '手すり（合成）', subject_name: '利用者01', visit_methods: [] } },
    }
    const lines = S.stoppedOpLines(op, (id) => `利用者0${id}`)
    assert.deepEqual(lines.find((l) => l.label === '原因'), { label: '原因', value: '段差（合成）' })
    assert.deepEqual(lines.find((l) => l.label === '再発防止策'), { label: '再発防止策', value: '手すり（合成）' })
    assert.ok(!lines.some((l) => l.value.includes('利用者01')), '対象者の氏名の写しを出した')
    assert.deepEqual(lines.at(-1), { label: 'ほか', value: '1項目' })
    // いまの記録は同じ欄の値で出す
    const theirs = S.stoppedOpLines(op, (id) => `利用者0${id}`, { detail: { cause: null, prevention: '見守り（合成）' } })
    assert.deepEqual(theirs.find((l) => l.label === '原因'), { label: '原因', value: '未入力' })
    assert.deepEqual(theirs.find((l) => l.label === '再発防止策'), { label: '再発防止策', value: '見守り（合成）' })
  })
})
