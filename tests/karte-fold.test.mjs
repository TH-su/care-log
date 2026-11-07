// カルテの下の欄の折りたたみと、タイムラインの文字の大きさ・未読の印（2026-11-07 本人指示）の回帰テスト。
// 実行: npm test。静的検査だけ（個人情報は置かない）。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const karte = read('../src/pages/KartePage.tsx')
const kcss = read('../src/styles/karte.css')
const timeline = read('../src/pages/TimelinePage.tsx')
const icss = read('../src/index.css')

describe('カルテ: 下の欄は見出しだけにたたむ', () => {
  it('排泄・申し送り・入浴・与薬・事故・変更の記録は折りたたみの入れ物（FoldCard）', () => {
    for (const id of ['karte-excretion', 'karte-notes', 'karte-bath', 'karte-med', 'karte-incident', 'karte-history']) {
      assert.match(karte, new RegExp(`<FoldCard title="[^"]+" className="mt-4" id="${id}">`), id)
    }
  })
  it('水分量のグラフと日ごとの記録もたたむ（主食＋副食のグラフ・バイタル・体重はたたまない）', () => {
    assert.match(karte, /fold=\{p\.key === 'fluid'\}/)
    assert.match(karte, /<FoldBlock title="日ごとの記録"/)
    for (const id of ['karte-vitals', 'karte-weight', 'karte-meals']) {
      assert.match(karte, new RegExp(`<SectionCard title="[^"]+" className="mt-4" id="${id}">`), id)
    }
  })
  it('既定は閉じている・開いた時だけ中身を描く・見出しのボタンは開閉を aria-expanded で伝える', () => {
    const fold = karte.slice(karte.indexOf('function FoldCard('), karte.indexOf('interface VitalPanelProps {'))
    assert.match(fold, /const \[open, setOpen\] = useState\(false\)/)
    assert.match(fold, /\{open \? \(\s*<div id=\{bodyId\} className="cl-karte-fold-body/)
    assert.match(fold, /aria-expanded=\{open\}/)
    assert.match(fold, /min-h-tap/)
  })
  it('印刷中は今までどおり全部開いた形（SectionCard・元の見出しと表）で描く', () => {
    const fold = karte.slice(karte.indexOf('function FoldCard('), karte.indexOf('interface VitalPanelProps {'))
    assert.match(fold, /if \(printing\) \{\s*return \(\s*<SectionCard title=\{title\} className=\{className\} id=\{id\}>/)
    assert.match(fold, /if \(printing\) return <>\{printForm\}<\/>/)
    assert.match(karte, /printForm=\{mealsTable\(true\)\}/)
    assert.match(karte, /<KartePrintingCtx\.Provider value=\{printing\}>/)
  })
  it('移動ボタン・今日の要注意から移る時は、その欄を開いてから移る', () => {
    const jump = karte.slice(karte.indexOf('function jumpToSection('))
    assert.match(jump.slice(0, 600), /window\.dispatchEvent\(new CustomEvent\(KARTE_OPEN_EVENT, \{ detail: id \}\)\)/)
  })
  it('開いた時の詰め方は画面だけ（karte.css の @media screen・カルテ専用の class）', () => {
    assert.match(kcss, /@media screen \{\s*\.cl-karte-fold-body \.space-y-4/)
    assert.match(kcss, /\.cl-karte-fold-body \.p-3 \{\s*padding: 0\.375rem 0\.625rem;/)
  })
})

describe('タイムライン: 文字を日報程度に・未読の印を出さない', () => {
  it('本文・氏名は 16px（--fs-base）。22px（--fs-xl）・18px（--fs-lg）に上げない', () => {
    const block = icss.slice(icss.indexOf('div.tl-legible {'), icss.indexOf('@media screen and (min-width: 768px)'))
    assert.match(block, /\.tl-legible \.tl-card \.tl-card-text \{\s*font-size: var\(--fs-base\);/)
    assert.match(block, /\.tl-legible \.tl-card \.tl-name \{\s*font-size: var\(--fs-base\);/)
    assert.doesNotMatch(block, /--fs-xl|--fs-lg/)
  })
  it('未読の札・未読の数・既読の人数・〔既読にする〕を出さない（本文を開いた時に既読を付ける仕組みは残す）', () => {
    assert.doesNotMatch(timeline, /<Chip tone="accent">未読<\/Chip>/)
    assert.doesNotMatch(timeline, /（未読\$\{summary\.unread\}）/)
    assert.doesNotMatch(timeline, />\s*既読にする\s*</)
    assert.doesNotMatch(timeline, /border-l-4 border-accent/)
    assert.match(timeline, /if \(opening\) onMarkRead\(note\)/)
  })
})

describe('タイムライン: 申し送りの1件ずつのカードを出さない（2026-11-07 本人指示・日報で読む）', () => {
  it('カードの欄と見出しの「申し送り n件」を SHOW_NOTE_CARDS（false）で止める・ピン留め・外出・バイタル・食事は出す', () => {
    const t = readFileSync(new URL('../src/pages/TimelinePage.tsx', import.meta.url), 'utf8')
    assert.match(t, /const SHOW_NOTE_CARDS: boolean = false/)
    assert.match(t, /\{SHOW_NOTE_CARDS && \(\s*<div id=\{anchorId\(iso, 'notes'\)\}/)
    assert.match(t, /\{SHOW_NOTE_CARDS && \(\s*<Chip tone="plain" onClick=\{\(\) => scrollToBlock\(anchorId\(iso, 'notes'\)\)\}>/)
    assert.match(t, /\{pinnedRows\.length > 0 && \(/)
    assert.match(t, /id=\{anchorId\(iso, 'vitals'\)\}/)
  })
})

describe('タイムライン: 縦に詰める（2026-11-07 本人指示・画面だけ）', () => {
  it('日と日の間・見出しの上下・欄の間・枠の余白・表の行の上下を詰める（押す所と文字の大きさは変えない）', () => {
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    const i = css.indexOf('.tl-legible .day-section {')
    assert.ok(i > 0)
    const block = css.slice(css.lastIndexOf('@media screen {', i), css.indexOf('/* 幅 768px 以上', i))
    assert.match(block, /\.tl-legible \.day-section \{\s*margin-top: 0\.75rem;/)
    assert.match(block, /\.tl-legible \.day-section td\.py-3,\s*\.tl-legible \.day-section th\.py-2,\s*\.tl-legible \.day-section li\.py-2 \{\s*padding-top: 0\.25rem;/)
    assert.doesNotMatch(block, /font-size|min-height/)
  })
})

