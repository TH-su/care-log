# ケアログ（care-log）— 申し送り・バイタル記録アプリ

介護施設の「申し送り・バイタル・食事摂取・水分量」のスプレッドシート運用
（10日ごとにファイルを作り直す方式）を置き換える記録アプリ。
何年分蓄積しても重くならないことを設計要件とする（範囲フェッチのみ・全件ロード禁止）。

## 技術スタック

- フロント: Vite + React 18 + TypeScript + Tailwind CSS（テーマは `src/styles/tokens.css` のデザイントークンで置換）
- バックエンド: Supabase（PostgreSQL / Auth / RLS / Realtime）— kitchen-app とは**別プロジェクト**
- ホスティング: GitHub Pages（`base: './'`・HashRouter）

## 設計文書（正本）

| 文書 | 内容 |
|---|---|
| `docs/PLAN.md` | 承認済み計画書（L0） |
| `docs/design/db-design.md` | DB・検索・バックエンド設計 |
| `docs/design/ui-design.md` | 画面・HIG・タイムライン設計 |
| `docs/design/qa-verification.md` | QA監査と検証計画（L4合格ライン） |

## セキュリティ・個人情報の前提

- このリポジトリは**公開**。コード・コメント・placeholder に実名・実データを書かない
- 入居者・職員のデータは Supabase にのみ置き、RLS で **読み取りも authenticated 限定**（anon 全拒否）
- `VITE_*` 環境変数は公開バンドルへ焼き込まれる — 施設名・氏名・秘密を置かない
- 利用者・職員マスタは既存GASから**読み取り専用**で取得（書込アクションのコードパスを作らない）
- 物理削除なし（delete ポリシー不作成・soft delete のみ）

## セットアップ

1. Supabase プロジェクト作成 → SQL Editor で `supabase/migrations/*.sql` を番号順に実行
2. `cp .env.example .env` して URL / anon key を設定
3. `npm install` → `npm run dev`

## スクリプト

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバ |
| `npm run build` | 型チェック＋本番ビルド |
| `npm test` | ロジックの回帰テスト |
| `npm run seed` | 合成テストデータ投入（実在氏名ゼロ・検証用） |
