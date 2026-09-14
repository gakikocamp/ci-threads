#!/bin/zsh
# Mac StudioへX候補生成ジョブを登録する。現在のユーザー名と、このスクリプトの実在パスからplistを生成する。
set -euo pipefail

LABEL="com.crystalinsence.himori"
ENGINE_DIR="${0:A:h}"
RUNNER="$ENGINE_DIR/run-x.sh"
TOKEN_FILE="$HOME/.config/himori/tokens.env"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$ENGINE_DIR/logs"

[[ -x "$RUNNER" ]] || chmod +x "$RUNNER"
[[ -f "$TOKEN_FILE" ]] || { echo "❌ $TOKEN_FILE がありません"; exit 78; }
mkdir -p "${PLIST:h}" "$LOG_DIR"

export HIMORI_LABEL="$LABEL" HIMORI_RUNNER="$RUNNER" HIMORI_PLIST="$PLIST" HIMORI_LOG_DIR="$LOG_DIR"
/usr/bin/python3 <<'PY'
import os, plistlib
home = os.path.expanduser('~')
data = {
    'Label': os.environ['HIMORI_LABEL'],
    'ProgramArguments': ['/bin/zsh', os.environ['HIMORI_RUNNER']],
    'StartCalendarInterval': {'Hour': 6, 'Minute': 30},
    'RunAtLoad': False,
    'StandardOutPath': os.path.join(os.environ['HIMORI_LOG_DIR'], 'himori.out.log'),
    'StandardErrorPath': os.path.join(os.environ['HIMORI_LOG_DIR'], 'himori.err.log'),
    'EnvironmentVariables': {
        'PATH': f'/opt/homebrew/bin:{home}/.local/bin:/usr/local/bin:/usr/bin:/bin'
    },
}
with open(os.environ['HIMORI_PLIST'], 'wb') as f:
    plistlib.dump(data, f, sort_keys=False)
PY

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"

echo "✅ $LABEL を毎朝06:30に登録しました"
echo "runner: $RUNNER"
echo "log:    $LOG_DIR/x-YYYY-MM-DD.log"

if [[ "${1:-}" == "--run-now" ]]; then
  launchctl kickstart -k "$DOMAIN/$LABEL"
  echo "▶︎ 1回実行を開始しました。数分後に今日のログとPOST GROOVEのXタブを確認してください"
fi
