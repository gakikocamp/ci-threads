#!/bin/zsh
# =============================================================
# BASEレビュー返信の自動投稿（Mac Studio 常駐）
# launchd (com.crystalinsence.reviews-poster) から10分おきに起動
# アプリで承認された返信が無ければ、何もせず終わる（BASEにもアクセスしない）
# あれば収集用Chrome（CDP 9222・BASEにログイン済み）で post_replies.js が投稿する
# ログ: ~/ci-daily-engine/reviews/logs/poster-YYYY-MM-DD.log
# =============================================================
set -u
DIR="${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
TOKENS="$HOME/.config/himori/tokens.env"
[[ -f "$TOKENS" ]] && { set -a; source "$TOKENS"; set +a; }
[[ -z "${X_WRITER_KEY:-}" ]] && exit 78

# 承認済みが無ければ終わる（ログも残さない）
N=$(curl -s -m 30 "https://ci-threads.pages.dev/api/reviews?status=approved" \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('reviews') or []))" 2>/dev/null)
[[ "${N:-0}" == "0" ]] && exit 0

LOCK="/tmp/ci-reviews-poster.lock"
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK"' EXIT

mkdir -p "$DIR/logs"
LOG_FILE="$DIR/logs/poster-$(date +%Y-%m-%d).log"
echo "[$(date '+%H:%M:%S')] 承認済み ${N}件 → 投稿" >> "$LOG_FILE"
"$HOME/ci-daily-engine/ensure-chrome-cdp.sh" >> "$LOG_FILE" 2>&1
cd "$DIR" && node post_replies.js >> "$LOG_FILE" 2>&1
echo "[$(date '+%H:%M:%S')] 終了 (exit=$?)" >> "$LOG_FILE"
