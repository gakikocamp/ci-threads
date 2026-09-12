#!/bin/zsh
# =============================================================
# クリスタルインセンス デイリーバズ・エンジン
# launchd (com.crystalinsence.dailybuzz) から毎朝6:54に起動される
# 本体: iCloud/開発用/SecondGaki/クリスタルインセンス/threads-app/daily-engine/
# ログ: 同ディレクトリ logs/run-YYYY-MM-DD.log
# =============================================================
set -u

ENGINE_DIR="${0:A:h}"
LOG_DIR="$ENGINE_DIR/logs"
mkdir -p "$LOG_DIR"

TODAY=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/run-$TODAY.log"

# launchd経由でもclaude/homebrewツールが見えるようPATHを保証
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

echo "===== daily buzz engine start: $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$LOG_FILE"
echo "claude: $(command -v claude || echo 'NOT FOUND')" >> "$LOG_FILE"

BASE_PROMPT=$(cat <<'PROMPT_EOF'
(1) 接続中Chromeを選択し、@crystal_insenceと@gakikocampの直近投稿を収集する。いいね・返信・リポスト・投稿時刻・画像有無に加え、可能なら投稿インサイトの閲覧数、いいね率、返信率、再投稿率、引用率、シェア率を取得する。
(2) 投稿から24時間以上たった自社投稿をbuzz/ok/miss判定する。閾値は@crystal_insence buzz>=3000/ok800-2999/miss<800、@gakikocamp buzz>=300/ok80-299/miss<80。24時間未満はpendingで結果登録しない。pattern分類してPOST https://ci-threads.pages.dev/api/results（x-sync-key:ci-threads-sync-v1、id=org-ci-<postid>、theme先頭[@acct ❤N view:V]）。
(3) #国産を守ろう/#国産タグ上位の新規バズを1〜2件だけPOST https://ci-threads.pages.dev/api/buzz。排外・政治色・誹謗は除外する。
(4) 今日の推奨を5本生成する。本文は4〜6行・55〜90字を基本とし、1行目は読者が止まる短い断言・問い・告白にする。各本文に、他人へ伝えたくなる確認済みの拡散材料を最低1つ入れる（知られていない事実・具体的な数字・失われる危機・意外な対比）。価値観と「そっといいね」だけで終わらせない。説明・期限・料金・URLは追いリプへ移す。事実表にない数字や産地は作らない。椨は福岡県産まで、八女は杉のみ、白檀を国産と書かない。値引き・排外・スピ全振り・健康効果断定を禁止。一人称は香司。
(5) 確度0〜100は確率ではなく候補間の相対スコア。いいね率を共感、再投稿・引用・シェア率を配信拡大として別々に評価する。確認済みの拡散材料がない案は79以下、同型で高い再投稿率を再現していない案は90以上にしない。高い順に5本並べる。
(6) 今日の推奨をPOST https://ci-threads.pages.dev/api/daily（x-sync-key:ci-threads-sync-v1、date/mode/pattern/theme/body/reply/tag/confidence/rationale/insight_summary、candidates:[5本]）。insight_summaryには勝ち型・負け型・いいね率・再投稿率・取りこぼしを書く。
(7) 投稿は絶対にしない。大規模災害進行中ならmode='safety'で無事報告トーンにする。
PROMPT_EOF
)

# 2026-09-04限定の熊本地震セーフティ指示（当日のみ付与。以降は上記(6)の一般ルールで判断）
SAFETY_NOTE=""
if [[ "$TODAY" == "2026-09-04" ]]; then
  SAFETY_NOTE="※今日2026-09-04は熊本地震の翌日なので必ずmode='safety'で無事報告・お見舞いトーンにすること。"
fi

PROMPT="${BASE_PROMPT}${SAFETY_NOTE}"

claude -p --dangerously-skip-permissions "$PROMPT" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "===== daily buzz engine end (exit=$EXIT_CODE): $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$LOG_FILE"
exit $EXIT_CODE
