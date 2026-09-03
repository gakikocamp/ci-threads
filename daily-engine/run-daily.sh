#!/bin/zsh
# =====================================================================
# クリスタルインセンス デイリーバズ・エンジン（Mac Studio 常駐版）
# ---------------------------------------------------------------------
# launchd から毎朝起動され、Claude Code(headless / --print)に
# 「当日ルーチン」を実行させる。
#  収集 → 前日成績＋インサイト記録 → 学習 → 今日の推奨投稿を生成
#  → /api/daily に反映（アプリの「☀️今日の推奨投稿」に表示）
#
# 生成は Claude Code 内（サブスク枠）で行うため、日次のAPI従量課金は発生しない。
# 前提: このMacで `claude` が使え、Chrome + Claudeブラウザ拡張がサインイン済みで
#       Threadsに @crystal_insence でログイン済みであること（README参照）。
# =====================================================================
set -u

REPO="/Users/gakipro/Library/Mobile Documents/com~apple~CloudDocs/開発用/SecondGaki/クリスタルインセンス/threads-app"
LOG_DIR="$REPO/daily-engine/logs"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y-%m-%d)"
LOG="$LOG_DIR/$STAMP.log"

cd "$REPO" || { echo "repo not found" >> "$LOG"; exit 1; }

echo "===== デイリーバズ・エンジン起動 $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$LOG"

# --- 当日ルーチンのプロンプト（Claude Code headless に渡す） ---
read -r -d '' PROMPT <<'EOF'
[デイリーバズ・エンジン / Mac Studio常駐] 今朝のクリスタルインセンス運用ルーチンを実行して。

前提メモリ: 運用ルール・CIの1000+分析・勝ち式・収集の技術メモは「クリスタルインセンス threads-app 運用手順」を必ず参照すること。

手順:
(1) Chromeブラウザを選択し、Threadsの @crystal_insence と @gakikocamp の直近投稿を収集する
    （いいね/リプ/リポスト、可能なら各投稿の「インサイト」タブを開いて view/リーチも取得）。
    仮想リストのストールに注意（setInterval(__grab,350)方式・右端スクロール・段階スクロール）。
(2) 前日〜数日で新たに settle した自社投稿を判定し、いいね数から result を付ける
    （閾値: @crystal_insence buzz>=3000 / ok 800-2999 / miss<800、
      @gakikocamp buzz>=300 / ok 80-299 / miss<80、投稿24h未満は pending=記録しない）。
    pattern分類して POST https://ci-threads.pages.dev/api/results
    （x-sync-key: ci-threads-sync-v1、id=org-ci-<postid>、theme先頭に [@acct ❤N view:V]、重複はupsert）。
(3) #国産を守ろう / #国産 のタグ上位で新規バズを1〜2件だけ拾い、分類して
    POST https://ci-threads.pages.dev/api/buzz（排外・陰謀論・政治色は除外）。
(4) /api/results のパターン別バズ率と /api/buzz の勝ちフック型を踏まえ、
    その日の推奨投稿を1本（本文＋追いリプ）生成する。
    CI勝ち式=【あと◯の絶滅数字 × 固有名詞(福岡/椨/水車/杉/菊水/39歳) × 危機→誇り × 控えめCTA(そっといいね/力を貸して)】。
    NG回避（説明分析から入らない/同型連打しない/事実なしのお願い/お礼連投）。値引き訴求・排外・スピ全振り禁止。一人称=香司。
(5) 生成した今日の推奨投稿を POST https://ci-threads.pages.dev/api/daily で反映する
    （x-sync-key: ci-threads-sync-v1、id=今日の日付 YYYY-MM-DD、フィールド: date, mode('buzz'), pattern, theme,
      body, reply, tag, confidence, rationale(なぜ今日これか), insight_summary(前日成績の要約) ）。
    → これで ci-threads アプリの「☀️今日の推奨投稿」に表示される。
(6) 重要: 投稿は行わない（本人がアプリからコピペして投稿する）。
    大規模災害・センシティブ事象が進行中なら、その日はバズ投稿を作らず、
    mode='safety' として無事報告・お見舞いトーンの案を /api/daily に入れる。
(7) 傾向の変化・新しい学びがあればメモリ「クリスタルインセンス threads-app 運用手順」に追記する。
最後に、今日やったこと（記録した成績・生成した投稿の1行目・確度）を簡潔に出力して終了。
EOF

# Claude Code headless 実行（非対話・出力はログへ）
# 注: MCPブラウザ(claude-in-chrome)を使うため、このMacのClaude Codeに拡張が
#     ペアリング済みであること。権限で止まる場合は README の許可設定を参照。
claude -p "$PROMPT" >> "$LOG" 2>&1
CODE=$?

echo "===== 終了 code=$CODE $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$LOG"
exit $CODE
