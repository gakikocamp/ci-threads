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
(1)接続中Chromeを選択し@crystal_insenceと@gakikocampの直近投稿を収集(いいね/リプ/リポスト＋可能ならインサイトのview/リーチ)。(2)前日〜数日でsettleした自社投稿をbuzz/ok/miss判定(閾値:@crystal_insence buzz>=3000/ok800-2999/miss<800、@gakikocamp buzz>=300/ok80-299/miss<80、24h未満はpending)しpattern分類してPOST https://ci-threads.pages.dev/api/results (x-sync-key:ci-threads-sync-v1、id=org-ci-<postid>、theme先頭[@acct ❤N view:V])。(3)#国産を守ろう/#国産タグ上位の新規バズ1-2件をPOST https://ci-threads.pages.dev/api/buzz (排外/政治色除外)。(4)実測パターン率＋勝ちフックから今日の推奨1本(本文+追いリプ)生成。勝ち式=あと◯数字×固有名詞(福岡/椨/水車/杉/菊水/39歳)×危機→誇り×控えめCTA(そっといいね/力を貸して)。NG回避(説明分析/同型連打/事実なしのお願い/お礼連投)、値引き/排外/スピ全振り禁止、一人称=香司。(5)今日の推奨をPOST https://ci-threads.pages.dev/api/daily (x-sync-key:ci-threads-sync-v1、id=今日の日付YYYY-MM-DD、date/mode/pattern/theme/body/reply/tag/confidence/rationale/insight_summary)。(6)投稿はしない。大規模災害進行中ならmode='safety'で無事報告トーンに。
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
