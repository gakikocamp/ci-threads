# Mac Studio を外出先から操作する（Remote Control）

2026-09-27 作成。Claude Code 公式の **Remote Control** を使い、Mac Studio で Claude を常駐させる。

- 柴垣さん: スマホの Claude アプリ（Code）や claude.ai/code から、Mac Studio の Claude に話しかけて操作できる
- MacBook の Claude: 「別のマシンのセッションにメッセージを送る」機能で、Mac Studio の Claude に指示を送り、返事を受け取れる（MacBook 側のセッションも Remote Control につないでいる時）
- Mac Studio は外向きの HTTPS 通信だけで待ち受ける。ポートは開けない。会話の記録は Anthropic のサーバーに残る
- Mac Studio の Claude が何かを実行するときの許可確認は、Mac Studio 側のルールのまま効く（MacBook からのメッセージで許可を出すことはできない）

## 必要なもの
- Claude の Pro / Max プラン（APIキーでは使えない）
- Mac Studio の Claude Code が v2.1.225 以上（`claude --version`）
- Mac Studio はスリープしない設定（`sudo pmset -a sleep 0` は設定済み）

## 設定手順（Mac Studio の前で1回だけ・約10分）

### 1. ログインと信頼の確認
```bash
cd ~/ci-daily-engine && claude
```
- 「このフォルダを信頼しますか」と出たら信頼する
- `/login` で claude.ai のアカウントにログイン（済んでいれば不要）
- `/exit` で閉じる

### 2. Remote Control を一度手で起動して承認する
```bash
cd ~/ci-daily-engine && claude remote-control --name "Mac Studio"
```
- `Enable Remote Control? (y/n)` に `y`
- スマホの Claude アプリ → Code に「Mac Studio」が出ることを確認
- 確認できたら `Ctrl+C` で止める

### 3. 常駐させる（再起動や回線断のあとも自動で復帰）
下をまるごとターミナルに貼る。
```bash
mkdir -p ~/ci-daily-engine/logs ~/ci-daily-engine/.claude
cat > ~/Library/LaunchAgents/com.crystalinsence.remotecontrol.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.crystalinsence.remotecontrol</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd ~/ci-daily-engine &amp;&amp; exec claude remote-control --name "Mac Studio" --remote-control-session-name-prefix mac-studio</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>/Users/gaki/ci-daily-engine/logs/remote-control.out.log</string>
  <key>StandardErrorPath</key><string>/Users/gaki/ci-daily-engine/logs/remote-control.err.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/gaki/.local/bin</string></dict>
</dict>
</plist>
PLIST
launchctl unload ~/Library/LaunchAgents/com.crystalinsence.remotecontrol.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.crystalinsence.remotecontrol.plist
sleep 15; tail -5 ~/ci-daily-engine/logs/remote-control.out.log ~/ci-daily-engine/logs/remote-control.err.log
```
- スマホの Claude アプリ → Code に「Mac Studio」が出ていれば完了
- ログに端末（TTY）が無いというエラーが出て動かない場合は、代わりにターミナルの窓を1つ開いたままにして `cd ~/ci-daily-engine && claude remote-control --name "Mac Studio"` を動かしておく（Mac Studio はスリープしないので、窓を閉じなければ動き続ける）

### 4. MacBook の Claude からの指示を受け取れるようにする
MacBook の Claude は許可確認を省略するモードで動いていることが多く、そのままだと Mac Studio 側で「受け取ってよいか」の承認待ちになり、5分で消える。受け取り方を選ぶ:
- **毎回スマホで承認する（安全寄り・おすすめの初期設定）**: 何もしない。承認の画面が出たらスマホで承認する
- **自分のセッションからの指示は自動で受け取る**: `~/ci-daily-engine/.claude/settings.local.json` に次を書く
  ```json
  { "crossSessionInbound": "accept" }
  ```

### 5. MacBook 側をつなぐ
MacBook の Claude デスクトップアプリ（Code タブ）で `/remote-control` と打つ。これで MacBook の Claude から Mac Studio のセッションが見え、返事も受け取れる。

## 使い方
- 柴垣さん: スマホの Claude アプリ → Code → 「Mac Studio」を開いて話しかける
- MacBook の Claude に「Mac Studio にこれをやらせて」と頼むと、Mac Studio のセッションに指示を送る

## 止め方
```bash
launchctl unload ~/Library/LaunchAgents/com.crystalinsence.remotecontrol.plist
```

## 画面ごと操作したい場合（任意）
Chrome のログインなど画面操作が要るときは、Remote Control ではできない。Tailscale（無料の個人向け VPN）を Mac Studio とスマホに入れ、Mac Studio の「画面共有」をオンにすると、外出先から画面を見て操作できる。どちらもポートを公開しない。設定は柴垣さん本人が行う（システム設定の変更とアカウント作成を伴うため）。
