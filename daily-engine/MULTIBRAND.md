# マルチブランド・デイリーエンジン（Mac Studio 追加手順・2026-09-10）

CI（@crystal_insence / @gakikocamp）の既存フローはそのまま。**スタートアップ九州（@startupkyushu）・橋本華恋（@konnichiwa.karen）・VAN TRIP JAPAN（@vantripjapan）を、毎朝同じループで回す**ための追加手順。

- ブランド別の目標・閾値・事実表・NG・生成の型は **`GET https://ci-threads.pages.dev/api/brands`**（`x-sync-key: ci-threads-sync-v1`）に集約
- 中身は `threads-app/functions/api/brands.js`。**MacBook側で直して push すれば、翌朝からエンジンの判定と生成が変わる**（Mac Studio の再改修は不要）
- 学習の記録先は既存と同じ D1（`/api/results` `/api/buzz` `/api/daily`、すべて `brand` 付き）。ウェブアプリのヘッダーでブランドを切り替えて確認する

## 毎朝の流れ（6:54）
1. 既存: CI の収集 → 判定 → 5候補生成（変更なし）
2. 追加: `/api/brands` を読み、`engine: "multibrand"` のブランドごとに
   収集（自社投稿20件・フォロワー数・研究タグ上位）→ 判定（24h以上経過分）→ 研究ライブラリ追加 → 月曜は閾値の再校正 → 5候補生成 → `/api/daily?brand=`
3. 投稿はしない（本人がアプリからコピーして投稿）

---

## Mac Studio の Claude に貼るプロンプト

```
~/ci-daily-engine のデイリーエンジンを「マルチブランド対応」に拡張してください。CIの既存処理（@crystal_insence/@gakikocamp/#国産）の挙動は一切変えないこと。

0. バックアップ: run-daily.sh と collector.js を *.bak-20260910 としてコピー。

1. 設定の確認: curl -s https://ci-threads.pages.dev/api/brands -H 'x-sync-key: ci-threads-sync-v1' で brands が取れることを確認。engine==="multibrand" のブランドだけを新ループの対象にする（ci は legacy なので対象外）。

2. collector.js の拡張（既存のCI収集の後に追加）:
   - 上記APIを読み、multibrand ブランドの accounts[].handle について https://www.threads.com/@<handle> を既存と同じ仮想リスト対策で開き、直近20件を収集 {postId, url, text, likes, replies, reposts, postedAt(ISO), hasImage}。postIdで重複除去。
   - プロフィールの「フォロワーN人」を数値で取得（followers）。
   - research_tags の各語で検索し、反応の多い投稿を10件ずつ {url, author, text, likes, replies, reposts}。
   - 出力: collected-<brandId>-YYYY-MM-DD.json（CIの collected-YYYY-MM-DD.json とは別）。1ブランド失敗しても他は続行。

3. run-daily.sh の拡張（既存のCIの claude -p の後に追加）:
   multibrand ブランドごとに claude -p --dangerously-skip-permissions を1回ずつ実行（ブランド単位で失敗を分離。ログは同じファイルに [brandId] 見出し付き）。
   環境変数 BRAND_ONLY=<id> ならそのブランドだけ、DRY_DAILY=1 なら /api/daily へのPOSTをせず候補をログに出すだけ、にする。
   各ブランドへのプロンプト:
   ---
   ブランド <id> のThreadsデイリー処理。投稿は絶対にしない。全APIのヘッダーは x-sync-key: ci-threads-sync-v1。
   (a) 設定: GET https://ci-threads.pages.dev/api/brands?id=<id> の equation / common_ng / recalibrate / brands[0] を読む。
   (b) データ: collected-<id>-今日.json、GET /api/results?brand=<id>、GET /api/daily?brand=<id>（前日の insight_summary）を読む。
   (c) 判定: 投稿から24時間以上たった自社投稿を thresholds（insight_summary に新しい閾値があればそちら）で buzz/ok/miss に判定。24時間未満は送らない。pattern は「1行目の型（読者向けか自分向けか）×長さ×依頼の有無」で分類。POST /api/results に {posts:[{id:"org-<id>-<postId>", brand:"<id>", batchId:"organic-<handle>", pattern, theme:"[@<handle> ❤N view:na] 要約", tag, body, cta, postedAt(ms), postedHour, hasImage, result, replies, reposts}]}。
   (d) 研究: 研究タグの上位から、このブランドに応用できる投稿を1〜2件 POST /api/buzz（brand:"<id>"）。政治・排外・誹謗は除外。
   (e) 校正: 今日が月曜なら recalibrate に従って閾値を再計算し、insight_summary に書く。
   (f) 生成: 今日の日付で phases（until）から mode を決め、goal/kpi/audience/persona/themes を踏まえて equation を厳守した候補を5本。本文は原則4〜6行・55〜90字（改行を除く）、1行目は読者が頷ける価値観の断言、依頼は「いいねだけ」程度。signature が空なら署名は付けない。さらに本文内に、他人へ伝えたくなる確認済みの燃料（知られていない事実・具体的数字・失われる危機・意外な対比）を最低1つ入れる。価値観といいね依頼だけで終わらせない。ブランドに equation_override がある場合は字数・言語・署名をそちらで上書きする。日時・料金・URLは reply へ。facts にない数字・実績・体験談は書かない。common_ng と ng を1本ずつ全チェック。確度(0-100)は実測パターン率に加え、いいね率＝共感、再投稿・引用・シェア率＝配信拡大として別々に評価する。燃料がない候補は79以下、同型で高い再投稿率を再現していない候補は90以上にしない。これは確率ではなく候補間の相対スコア。直近7日の /api/daily の候補と同じ1行目の型は避ける。
   (g) 反映: POST /api/daily に {brand:"<id>", date:今日(YYYY-MM-DD), mode, pattern/theme/body/reply/tag/confidence/rationale は候補#1, candidates:[5本], insight_summary:"勝ち型・負け型・いいね率・再投稿率・フォロワー数と前日差・現在の閾値"}。
   ---

4. テスト: BRAND_ONLY=karen DRY_DAILY=1 で一度だけ実行し、次を報告して:
   - collected-karen-今日.json の件数と followers
   - curl -s 'https://ci-threads.pages.dev/api/results?brand=karen' -H 'x-sync-key: ci-threads-sync-v1' の count（3件より増えていればOK）
   - ログに出た5候補
   - CIの今日の推奨（/api/daily）が上書きされていないこと
   問題なければ、明朝6:54の本番から全ブランドが回る状態にして終了。
```

## 変更の戻し方
`cp run-daily.sh.bak-20260910 run-daily.sh && cp collector.js.bak-20260910 collector.js`

---

## 収集が全件0になったときの直し方（2026-09-18 追記）

9/18の実行で、4ブランドすべて「likes/replies/reposts が全件0」で返った。未ログインのせいではない（公開プロフィールでも数値は表示される。同日に実機確認済み）。**collector.js の取得部分が壊れている**とみて直す。

Mac Studio の Claude に貼るプロンプト:

```
~/ci-daily-engine/collector.js が、Threadsの投稿の いいね・返信・再投稿 を全件0で返すようになっています。原因を特定して直してください。

1. 事実確認: 未ログインの公開プロフィール（https://www.threads.com/@konnichiwa.karen など）でも数値は表示される。2026-09-18に @crystal_insence / @gakikocamp / @konnichiwa.karen / @startupkyushu で確認済み（例: 固定投稿が 307 / 22 / 16）。「未ログインだから0」という結論は誤り。
2. 調査: collector.js が数値を拾っているセレクタを確認し、実際のDOMと突き合わせる（描画待ちが足りない可能性も見る）。
3. 代替手段の実装: 投稿カードの innerText を行に分割し、「行全体が数字だけ」の行を上から likes / replies / reposts として拾うフォールバックを入れる。セレクタが壊れてもこれで拾える。
4. 安全弁: 収集した自社投稿の likes が全件0なら「収集失敗」と判定し、その日は /api/results に1件も送らない。insight_summary の先頭に「収集失敗」と原因を書く。ただし followers が0のアカウント（vantripjapan）は表示にも数字が無ければ本当に0なので記録してよい。詳細は GET /api/brands の collection フィールドにある。
5. 検証: node collector.js を単体で実行し、@konnichiwa.karen の固定投稿が 307 / 22 / 16 で取れることを確認してから報告してください。
```

## フォロワー数の記録（2026-09-18 追加・成功判定の主指標）

❤ではなく**フォロワー増**で勝ち型を決める（2026-09-18 柴垣さん指摘。@gakikocamp の❤1,886はフォロワー増も売上もゼロだった）。

毎朝の各ブランドの処理に、次を追加する。

```
収集したプロフィールのフォロワー数を、毎日 POST https://ci-threads.pages.dev/api/followers に記録する。
本文: {"counts":[{"brand":"<id>","handle":"<handle>","date":"YYYY-MM-DD","followers":1588}]}（deltaはサーバー側で自動計算）
ヘッダー: x-sync-key: ci-threads-sync-v1
判定では GET /api/followers?handle=<handle>&days=30 を読み、投稿後24時間のフォロワー増を主指標にする。
❤が buzz 閾値を超えても、その間のフォロワー増が0なら buzz にせず ok 止まりにし、theme に「(フォロワー+0)」と書く。
本業と関係ないテーマは、❤が伸びても勝ち型として学習しない（insight_summary に「学習対象外（テーマ不一致）」と理由を書く）。
未ログインの公開プロフィールは1万人以上が丸められるため、@crystal_insence は必ずログイン状態のインサイトから正確な数を取る。取れない日は followers を送らない。
```

CIの既存フロー（run-daily.sh の legacy 部分）にも、この記録と判定を同じように入れること。

## Mac Studio のログイン方針（2026-09-18）

- Chrome は **@crystal_insence だけログイン**しておく。@gakikocamp（8,623）・@konnichiwa.karen（1,588）・@startupkyushu（115）・@vantripjapan（0）は公開ページで正確なフォロワー数が取れるのでログイン不要
- ログインで取れるようになるもの: CIの**正確なフォロワー数と前日差**、投稿ごとの**閲覧数・リーチ**（現在はすべて view:na）
- **読むだけ**。ログイン状態でも、いいね・フォロー・投稿・返信・DM・プロフィール編集は絶対に行わない
- 2026-09-18の「全件0」はログインが原因ではない（未ログインでも公開ページに数値は出る）。パーサーの不具合として別途直す
- ログインが切れていたら、CIの閲覧数とフォロワーは送らず insight_summary の先頭に「CI未ログイン」と書く。他ブランドの収集は続ける
