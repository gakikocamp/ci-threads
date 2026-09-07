# 灯守（ひもり）— X運用機関 M1 運用手順

設計書: https://claude.ai/code/artifact/11826217-fc51-4285-9b76-279a7ca25712
対象アカウント: @crystalinsence ／ 目標: フォロワー3万人（評価軸=1投稿あたりのフォロワー獲得数）

## 構成（M1 で入ったもの）
| 場所 | 役割 |
|---|---|
| `guardrails/` | 憲法ファイル（事実表・NG語・禁止主題・文体・勝ち型）。**ルールを変えるのはここだけ** |
| `x/linter.js` | 機械検査リンター。`node x/build-guardrails.mjs` で憲法を束ねてから `node --test x/linter.test.mjs` |
| `schema-x.sql` | D1（ci_zukou）に追加するテーブル。既存テーブルには触れない |
| `functions/api/x/*` | アプリ用API（candidates / mark / radar / stats）。権限は `x-writer-key`（Claude）と `x-admin-token`（人間）に分離 |
| `index.html` 🏮Xタブ | 今日の候補・投稿済み記録・成長レーダー・成績 |
| `ci-x-cron/` | 読み取り専用Worker（毎日03:00 JST: 自投稿メトリクス・監視リストのフォロワー数・型別成績）。書き込みAPIは実装しない |

## 毎日の運用（Phase A・手動投稿）
1. 朝: アプリの🏮Xタブを開く → 今日の候補から選び「📋本文コピー」→ Xアプリで投稿（追いリプ・スレッド版も同様）
2. 投稿したら「✅ 投稿した」をタップ（投稿URLを貼ると即紐付け。空でも翌日の計測で自動突合）
3. リプが来たら香司の声で返信。クラスターの仲間の投稿にも1日5分、手で返信
4. 監視したいアカウントは「👁 監視に追加」（政治色・排外は入れない）

初回だけ: 🔑ボタンで管理トークンを入力（下記の X_ADMIN_TOKEN と同じ値）。

## 本番に載せる手順（すべてCEO承認のうえで実行）
```bash
# 1) D1 にテーブル追加（既存に影響なし）
cd threads-app && npx wrangler d1 execute ci_zukou --remote --file=schema-x.sql
npx wrangler d1 execute ci_zukou --remote --file=ci-x-cron/seed-watchlist.sql

# 2) Pages の環境変数（Cloudflare ダッシュボード → ci-threads → Settings → Variables and Secrets）
#    X_WRITER_KEY  = 長いランダム文字列（Mac Studio の生成エンジンが使う）
#    X_ADMIN_TOKEN = 別の長いランダム文字列（アプリの🔑に入れる）
#    例: openssl rand -hex 24

# 3) Worker の秘密（本人が値を貼る。チャットに貼らない）
cd ci-x-cron
npx wrangler secret put X_API_KEY
npx wrangler secret put X_API_SECRET
npx wrangler secret put X_ACCESS_TOKEN
npx wrangler secret put X_ACCESS_SECRET
npx wrangler secret put X_CRON_TOKEN

# 4) Worker を配置（初回は DRY_RUN=1 のまま1日回してログを見る → wrangler.toml の DRY_RUN を "0" に）
#    ci-x-cron/README.md の手順どおり。配置コマンドは承認後にのみ実行

# 5) アプリ本体: git commit → push（main への push で Pages が自動配置される）
```

## 動作確認（ローカル）
```bash
cd threads-app
npx wrangler d1 execute ci_zukou --local --file=schema-x.sql
# .dev.vars に X_WRITER_KEY / X_ADMIN_TOKEN を書く（gitignore済み）
npx wrangler pages dev --port 8817
# 候補投入: POST /api/x/candidates（x-writer-key）／ 投稿済み: POST /api/x/mark（x-admin-token）
```

## 次のマイルストーン
- M2: Mac Studio の朝エンジン `daily-engine/run-daily-x.sh`（成績＋レーダーを読んで候補3本→ POST /api/x/candidates）。Threadsエンジンのパス・認証切れも同時修復
- M3: 承認箱・配信Worker（ドライラン48h→実投稿）・災害自動停止・緊急停止・API異常停止 → Phase B
