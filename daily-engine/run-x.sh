#!/bin/zsh
# =============================================================
# 灯守（X運用機関）朝の生成エンジン — Mac Studio 常駐
# launchd (com.crystalinsence.himori) から毎朝 06:30 に起動される
# 本体: threads-app/daily-engine/run-x.sh
# ログ: 同ディレクトリ logs/x-YYYY-MM-DD.log
#
# 役割: 今日のレシピを読んで文章を書き、候補として登録する（投稿はしない）
# 失敗しても系は壊れない（アプリは昨日の未使用候補と常備ストックを表示する）
# =============================================================
set -u

ENGINE_DIR="${0:A:h}"
APP_DIR="${ENGINE_DIR:h}"
LOG_DIR="$ENGINE_DIR/logs"
mkdir -p "$LOG_DIR"

TODAY=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/x-$TODAY.log"

# launchd 経由でも claude / node が見えるように PATH を保証
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# 秘密は ~/.config/himori/tokens.env（本人が作成。リポジトリには置かない）
TOKENS="$HOME/.config/himori/tokens.env"
if [[ -f "$TOKENS" ]]; then
  set -a; source "$TOKENS"; set +a
fi

BASE="${HIMORI_BASE:-https://ci-threads.pages.dev}"

log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG_FILE" }

log "===== 灯守 朝エンジン開始 ====="
log "claude: $(command -v claude || echo 'NOT FOUND')"

# ── 事前チェック1: トークン ──
if [[ -z "${X_WRITER_KEY:-}" ]]; then
  log "FATAL: X_WRITER_KEY が未設定（$TOKENS を確認）"
  exit 78
fi

# ── 事前チェック2: Claude Code の認証（切れていると無言で失敗するので先に見る）──
if ! command -v claude >/dev/null 2>&1; then
  log "FATAL: claude コマンドが見つからない"
  exit 78
fi

# ── 事前チェック3: 今日のレシピが存在するか ──
RECIPES=$(curl -sS -m 20 -H "x-writer-key: $X_WRITER_KEY" "$BASE/api/x/recipes" 2>>"$LOG_FILE")
RECIPE_COUNT=$(printf '%s' "$RECIPES" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len([r for r in d.get("recipes",[]) if r.get("constraint_ok")]))' 2>/dev/null || echo 0)
log "使えるレシピ: ${RECIPE_COUNT}本"
if [[ "$RECIPE_COUNT" == "0" ]]; then
  log "レシピが無いので生成をスキップ（学習ジョブ側の問題。アプリは昨日の候補とストックを表示する）"
  exit 0
fi

# ── 生成（プロンプト本体はリポジトリの x/routine-prompt.md が真実源）──
PROMPT="$(cat <<EOF
$APP_DIR/x/routine-prompt.md の手順を実行してください。
実行に必要な値:
- \$BASE = $BASE
- \$X_WRITER_KEY = $X_WRITER_KEY
- 今日 = $TODAY
憲法は $APP_DIR/guardrails/ 配下、プロンプト全文は $APP_DIR/x/routine-prompt.md にあります。まず両方を読んでから作業してください。
ファイルの編集・git操作・デプロイはしないでください。HTTPのGET/POSTと、文章を書くことだけが仕事です。
EOF
)"

claude -p --dangerously-skip-permissions "$PROMPT" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

# ── 事後チェック: 候補が入ったか ──
GOT=$(curl -sS -m 20 "$BASE/api/x/candidates" 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len([c for c in d.get("candidates",[]) if c.get("lint_ok")]))' 2>/dev/null || echo 0)
log "登録された候補: ${GOT}本 (claude exit=$EXIT_CODE)"

if [[ "$GOT" == "0" ]]; then
  log "WARN: 候補が0本。認証切れ（OAuth session expired）の可能性 → ログ末尾を確認し、Mac Studio で 'claude' を対話起動して再ログインすること"
  tail -20 "$LOG_FILE" | grep -i "auth\|expired\|login" >> "$LOG_FILE" 2>/dev/null || true
fi

log "===== 終了 (exit=$EXIT_CODE) ====="
exit $EXIT_CODE
