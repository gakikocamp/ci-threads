# ci-x-cron

X（旧Twitter）公式API v2 で、自アカウントの投稿メトリクスと監視アカウント（成長レーダー）のフォロワー数を
毎日D1（`ci_zukou`、`threads-app` と相乗り）に記録するだけの Cloudflare Worker（読み取り専用）。

**投稿・いいね・フォロー等の書き込みAPIは一切実装しない。** `src/xapi.js` にも意図的に書き込み関数を置いていない。

## 構成

```
src/oauth1.js     OAuth 1.0a (HMAC-SHA1) 署名。WebCrypto (crypto.subtle) 実装
src/xapi.js       X API v2 読み取りクライアント（users/me, users/:id/tweets, users/by, users）
src/extract.js    APIレスポンス→D1行変換・集計ロジックの純粋関数群（テスト容易性のため分離）
src/util.js       JST日付・guard_logへの記録・api_reads_today予算カウンタ
src/jobs/self.js      自アカウントのフォロワー数等 → x_account_daily
src/jobs/metrics.js   自投稿14日分 → x_metrics、x_queueとの自動突合
src/jobs/patterns.js  型別成績集計 → x_pattern_stats
src/jobs/radar.js     監視アカウントのフォロワー数・成長率・上位投稿 → x_radar / x_radar_posts
src/index.js      scheduled/fetch ハンドラ（self→metrics→patterns→radarの順、各ジョブ独立try/catch）
```

## ローカルテスト

```bash
cd ci-x-cron
npm test
```

`node --test test/` を実行する。内訳:

- `test/oauth1.test.mjs` — X(Twitter)公式ドキュメントの署名テストベクタで `hCtSmYh+iHYCEqBWrE7C7hYmtUk=` と一致することを検証
- `test/extract.test.mjs` — メトリクス抽出・型別集計・転換率・成長率ランキングなどの純粋関数
- `test/util.test.mjs` — JST日付変換の境界値

いずれもD1やネットワークに依存しないため `npm install` 不要（依存パッケージなし）。

### wrangler dev でのcron実地確認（DRY_RUN推奨）

```bash
cd ci-x-cron
npx wrangler dev --test-scheduled
# 別ターミナルで
curl "http://localhost:8787/__scheduled?cron=0+18+*+*+*"
```

`wrangler dev` はローカルD1（`.wrangler/state`）を使うため、先にローカルへスキーマを適用しておく:

```bash
npx wrangler d1 execute ci_zukou --local --file=../schema-x.sql
npx wrangler d1 execute ci_zukou --local --file=seed-watchlist.sql
```

### 手動実行エンドポイント

```bash
curl -X POST "http://localhost:8787/run?job=self" -H "x-cron-token: <X_CRON_TOKENの値>"
curl -X POST "http://localhost:8787/run?job=all"   -H "x-cron-token: <X_CRON_TOKENの値>"
curl "http://localhost:8787/health"
```

`job` は `self|metrics|patterns|radar|all`。`x-cron-token` が `X_CRON_TOKEN` と一致しないと403。

## DRY_RUN

`wrangler.toml` の `[vars] DRY_RUN` を `"1"` にすると、各ジョブは X API を一切呼ばず
「何を呼ぶ予定だったか」を `guard_log`（actor='worker'）に記録して終了する。
本番Secretsが未投入の段階や、動作確認だけしたいときに使う。

## DRY_RUN無しでの実地確認手順

1. `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` をローカル `.dev.vars` に入れて `wrangler dev` する
   （`.dev.vars` は `wrangler.toml` と同階層。**gitignore必須・コミットしない**）
2. `DRY_RUN=0` にして `/run?job=self` を叩き、`x_account_daily` にフォロワー数が入るか確認
3. 続けて `metrics` → `patterns` → `radar` の順に確認（`self` が `x_settings.self_user_id` を埋めないと `metrics` は動かない）

## 本番手順（すべてユーザー本人が実行・承認後）

Secretsの投入:

```bash
npx wrangler secret put X_API_KEY
npx wrangler secret put X_API_SECRET
npx wrangler secret put X_ACCESS_TOKEN
npx wrangler secret put X_ACCESS_SECRET
npx wrangler secret put X_CRON_TOKEN
```

D1スキーマ適用（本番）:

```bash
npx wrangler d1 execute ci_zukou --remote --file=../schema-x.sql
npx wrangler d1 execute ci_zukou --remote --file=seed-watchlist.sql
```

デプロイ（CEO/ユーザー承認後）:

```bash
npx wrangler deploy
```

## 監視アカウント（x_watchlist）の初期データ

`seed-watchlist.sql` には確認済みの2件のみ収録: `shakunone`（笏本縫製・岡山）、`houseiya_moto`（縫製工場ズーム）。
菊水産業・saito_ham・nikko_yakuhin 等は X のハンドルが未確認のため**推測で入れていない**。
追加は ci-threads アプリの「研究タブ」からハンドルを確認したうえで行うこと（`x_watchlist` へのINSERT）。

## 予算ガード

`x_settings.api_reads_today` に `'YYYY-MM-DD:count'` で当日の読み取り件数を積算する（日付が変わると自動リセット）。
`MAX_READS_PER_DAY`（既定400）を超えると `radar` ジョブの上位アカウント投稿取得を打ち切り、`guard_log` に warn を記録する。
自投稿・フォロワー数取得（self/metrics/watchlistのフォロワー数）は打ち切らない — 成長曲線の欠測を避けるため。

## 費用の目安（1日あたり・監視10件/上位5件投稿取得の既定値の場合）

X API v2 Basic/Pro プランの従量課金は「Owned Reads（自分の投稿の読み取り）」と
「Post/User Reads（他アカウントの読み取り）」で区別される。単価は本文の指示に基づく試算:

| ジョブ | 呼び出し内容 | 件数/日 | 単価 | 概算 |
|---|---|---|---|---|
| self | `/users/me` | 1 users read | Owned（実質無料〜極小） | ほぼ0 |
| metrics | `/users/:id/tweets`（自分・14日分） | 最大100 tweets read | Owned Reads | ほぼ0（Owned Readsは自分のツイートのため無課金/低単価が一般的） |
| radar（フォロワー数） | `/users?ids=` | watchlist件数分（初期2件） | user read $0.01/件 | 2件 → $0.02 |
| radar（上位投稿） | `/users/:id/tweets`（他アカウント） | RADAR_TOP_N×RADAR_POSTS_PER（既定10×5=50だが実際はwatchlist件数が上限） | post read $0.005/件 | 初期watchlist2件×5件 = 10件 → $0.05 |
| radar（username lookup） | `/users/by`（初回のみ） | watchlist件数分 | user read $0.01/件 | 初回のみ 2件 → $0.02（以降0） |

**現状のwatchlist（2件）ベースでは 1日あたり概算 $0.07〜0.09（初回のみ+$0.02）**、月換算で概算 $2〜3。
watchlistを研究タブ経由で増やすと `radar` のuser read・post readが線形に増える点に注意
（`MAX_READS_PER_DAY`＝既定400件/日で歯止めをかけている）。

※ Owned Reads（自分の投稿の読み取り）は多くのプランで無課金扱いのことが多いが、契約プランによって条件が異なるため、
実際の請求はX Developer Portalの利用状況ダッシュボードで確認すること。

## 既知の制約・注意

- `non_public_metrics` / `organic_metrics`（impressions, profile_clicks, link_clicks）は
  X API v2 のアクセスレベルとツイートの所有者が自分であることが前提。取得できない場合は
  `public_metrics.impression_count` 等へ自動フォールバックする（`src/extract.js` の `extractMetricRow`）。
- `x_queue` とのつき合わせ（tweet_id自動セット）は本文先頭30文字の完全一致でのみ行う。
  絵文字や改行の有無で本文が微妙に変わっている場合は一致しない＝手動で `tweet_id` を入れる必要がある。
- 401/403/429 はリトライしない（`src/xapi.js`）。凍結予兆やレート制限下で叩き続けないための意図的な設計。
  次回cron（翌日JST03:00）まで待つか、`/run` で手動再実行する。
- X API v2 の `/users/:id/tweets` は `max_results` に5〜100の範囲制約がある。`RADAR_POSTS_PER` を5未満に設定すると
  本来はAPI側で400エラーになるため、`src/xapi.js` の `getUserTweets` で下限5にクランプしている。
