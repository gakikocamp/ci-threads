#!/bin/zsh
# Mac StudioへX候補生成ジョブを登録する。現在のユーザー名と、このスクリプトの実在パスからplistを生成する。
set -euo pipefail

LABEL="com.crystalinsence.himori"
ENGINE_DIR="${0:A:h}"
RUNNER="$ENGINE_DIR/run-x.sh"
TOKEN_FILE="$HOME/.config/himori/tokens.env"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$ENGINE_DIR/logs"

[[ -x "$RUNNER" ]] || chmod +x "$RUNNER"
[[ -f "$TOKEN_FILE" ]] || { echo "❌ $TOKEN_FILE がありません"; exit 78; }
grep -Eq '^X_WRITER_KEY=[A-Za-z0-9_-]{24,}$' "$TOKEN_FILE" || {
  echo "❌ $TOKEN_FILE のX_WRITER_KEY形式が正しくありません"
  echo "   X_WRITER_KEY=... の1行にしてください（名前にバックスラッシュを入れない）"
  exit 78
}
mkdir -p "$PLIST_DIR" "$LOG_DIR"

cat > "$PLIST" <<PLIST_XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$RUNNER</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>6</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/himori.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/himori.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST_XML

plutil -lint "$PLIST" >/dev/null

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
