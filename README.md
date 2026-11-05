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
| `npm run seed` | 合成テストデータ投入（実在氏名ゼロ・検証用）。環境変数 `SUPABASE_DB_URL` と `CARELOG_TENANT`（投入する施設の番号＝`public.tenants` の id）が必須（施設の印の段階2・0052） |
| `node tools/import.mjs` | 過去データの取込（通常は `~/bin/care-log-import.sh` 経由）。環境変数 `CARELOG_GAS_URL`・`CARELOG_GAS_TOKEN`・`SUPABASE_DB_URL` と `CARELOG_TENANT`（取り込む施設の番号）は施設が2つ以上ある時に必須。施設がちょうど1つの時は省いてよい（その施設で取り込む）。施設が決まらない・形が違う・データベースに無い時は何もせずに止まる（終了コード 2・0052） |
| `CARELOG_PG_ADMIN_URL=postgres://postgres@127.0.0.1:<port>/postgres node tests/pg-run-all.mjs` | サーバーの契約の試験（使い捨ての Postgres に Supabase の真似と移行 0001〜最新を当て、`tests/*-pg.mjs` をすべて流す。本番には向けない＝127.0.0.1／localhost 以外は断る）。GitHub Actions の `pg-contract` が push のたびに同じものを流す |

## 変更の出し方（2026-10-22〜）

施設の印（0051〜0055）: ケアログの表は施設の印（tenant_id）で分ける（4段階）。段階③（0053・施設ごとの一意・印の必須・同じ施設の行だけを指す外部キー）で、施設をまたいで一意がぶつかることは無くなり、段階④（0054・27表に「自分の施設の行だけ」の守り tenant_only・「1人1日1件」などの一意の頭に施設の印）で、ログインした人は自分の施設の行だけを読める・書けるようになり、よその施設の記録の有る無しも誤りの種類から分からなくなる（0055 で端末・自動の記録の冪等キーの一意も施設ごと）。0055 が入るまでは、2つ目の施設の職員を許可リストに入れない・2つ目の施設の取込を走らせない・SQL Editor でも2つ目の施設の行を作らない（守りがまだ全部の施設の行を読ませるので、画面が旗や名簿でよその施設の行を読むことがある）。0053 を当てる前に、取込の道具（tools/import.mjs）を 0053 と同じ版にする（古い版は 0053 の後に取込の日を書けずに止まる。新しい版は前後どちらでも動く）。0054 は画面・取込の道具の版を問わない。戻す時は supabase/rollback/0055_back.sql → 0054_back.sql の順（0053 を戻す前に流す）。

応急処置（2026-11-05・本番にだけ当ててある）: 取込を動かしている機械の取込の道具が 0053 より前の版のままで、0053 の後の毎時の取込が取込の日を書く所で止まったため、本番の取込の日に一時の一意 (source, day)（import_days_source_day_bridge）を足した（supabase/hotfix/2026-11-05_import_days_bridge.sql・移行の並びには入れない）。これがある間は2つ目の施設の取込は書けない。取込を動かしている機械の care-log を最新にした（git pull）後、2つ目の施設を入れる前に supabase/hotfix/2026-11-05_import_days_bridge_back.sql で外す。

main はルールセットで守られている: 変更は PR だけ・「試験とビルド」と「pg-contract」の合格が必須・削除と強制の上書きは禁止。
main への取り込みがそのまま公開になるため、ブランチを切って push し、PR を作って自動の取り込み（`gh pr merge --auto --merge`）を入れる。試験に合格した時点で取り込まれ、公開が走る。
