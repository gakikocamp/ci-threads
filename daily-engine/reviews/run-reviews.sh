#!/bin/zsh
# =============================================================
# BASEレビュー返信の下書きエンジン（Mac Studio 常駐）
# launchd (com.crystalinsence.reviews) から毎日 7:40 に起動（1日1回）
#   1) review_sync.py   : BASEの公開ページから全レビューを読み、/api/reviews に同期（ログイン不要）
#   2) draft_replies.py : 返信が無い本文ありレビューに下書きを作る（claude -p・道具なし）
# 投稿はしない。BASEに載るのは柴垣さんがアプリ（ci-threads の「BASE返信」タブ）で承認したあと
# ログ: ~/ci-daily-engine/reviews/logs/reviews-YYYY-MM-DD.log
# =============================================================
set -u

DIR="${0:A:h}"
LOG_DIR="$DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/reviews-$(date +%Y-%m-%d).log"
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG_FILE" }

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# 二重起動を防ぐ（手動実行と定時実行が重なったとき）
LOCK="/tmp/ci-reviews.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  log "別の実行中のため終了"
  exit 0
fi
trap 'rmdir "$LOCK"' EXIT

# 秘密は ~/.config/himori/tokens.env（灯守と共用の X_WRITER_KEY）
TOKENS="$HOME/.config/himori/tokens.env"
[[ -f "$TOKENS" ]] && { set -a; source "$TOKENS"; set +a; }
if [[ -z "${X_WRITER_KEY:-}" ]]; then
  log "FATAL: X_WRITER_KEY が未設定（$TOKENS）"
  exit 78
fi

# ログイン済みの Claude CLI を選ぶ（未ログインの古い版を掴まない）
for c in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
  [[ -x "$c" ]] || continue
  if "$c" auth status 2>/dev/null | grep -Eq '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
    export CLAUDE_BIN="$c"
    break
  fi
done

log "===== 開始 (claude: ${CLAUDE_BIN:-未ログイン}) ====="
cd "$DIR" || exit 1

python3 review_sync.py --post >> "$LOG_FILE" 2>&1
SYNC=$?
log "--- sync exit=$SYNC ---"
if (( SYNC != 0 )); then
  log "===== 終了: 同期に失敗したため下書きは作らない ====="
  exit 1
fi

if [[ -z "${CLAUDE_BIN:-}" ]]; then
  log "===== 終了: ログイン済みの Claude CLI が無いため下書きは作らない（同期は完了） ====="
  exit 78
fi

python3 draft_replies.py >> "$LOG_FILE" 2>&1
DRAFT=$?
log "===== 終了 (sync=$SYNC draft=$DRAFT) ====="
exit $DRAFT
