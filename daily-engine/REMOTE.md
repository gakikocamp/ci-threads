# Mac Studio を世界中どこからでも操作する

2026-09-27 作成・更新。3つの道具を重ねて、画面操作・コマンド操作・Claudeへの依頼を、海外からでもできるようにする。

| 層 | 道具 | できること | 誰が使う |
|---|---|---|---|
| 1. 通り道 | **Tailscale**（個人利用は無料のVPN） | Mac Studio・MacBook・iPhone を、どこにいても同じ社内LANにいるようにつなぐ。ポートを公開しない | 全部の土台 |
| 2. 画面 | **macOS の画面共有** | Mac Studio の画面をそのまま見て操作（Chromeのログイン、アプリの操作など） | 柴垣さん（MacBook・iPhone） |
| 3. コマンド | **SSH（macOS のリモートログイン）** | ターミナルでファイル編集・ログ確認・プログラム実行 | MacBook の Claude（私）と柴垣さん |
| 4. 会話 | **Claude の Remote Control** | スマホの Claude アプリから Mac Studio の Claude に頼む | 柴垣さん（と私からの指示） |

層1〜3 がそろうと、私（MacBook の Claude）は SSH で Mac Studio のエンジンを直接直せるようになる（例: collector.js の修理、ログの確認、テスト実行）。層4 は層1〜3 が無くても単独で使える。

## 海外運用で一番こわいこと（先に対策する）
- **停電や自動アップデートで Mac Studio が再起動すると、FileVault（ディスク暗号化）がオンの場合、起動画面でパスワード入力を待ったまま止まり、ネットにつながらない**。こうなると層1〜4 がすべて使えなくなり、現地に戻るまで復旧できない
  - 停電対策: `sudo pmset -a autorestart 1`（停電から復帰したら自動で起動）と、小型の UPS（無停電電源装置）
  - アップデート対策: システム設定 → 一般 → ソフトウェアアップデート → 自動アップデートで「macOS アップデートをインストール」をオフ（ダウンロードだけにする）。更新は帰国後か、`sudo fdesetup authrestart`（再起動を1回だけ暗号化解除つきで行う）で行う
  - FileVault 自体をオフにするかどうかは、盗難時のリスクとの天秤なので柴垣さんが決める（私からは変更しない）
- Tailscale のアカウントには2段階認証を必ず付ける

---

# 層1〜3: Tailscale・画面共有・SSH（Mac Studio の前で1回・約20分）

### A. Tailscale を入れる（Mac Studio・MacBook・iPhone の3台）
1. https://tailscale.com/download から入れる（Mac は公式サイトの Standalone 版が推奨。iPhone は App Store）
2. 3台とも同じアカウントでログインし、2段階認証をオンにする
3. Mac Studio の Tailscale の設定で「ログイン時に起動」をオンにする
4. 管理画面（https://login.tailscale.com/admin/machines）で Mac Studio の「Disable key expiry（鍵の期限切れを無効化）」を設定する（放置すると一定期間で再ログインが必要になり、海外から戻せない）
5. 管理画面に出る Mac Studio の名前（例: `gakinomac-studio`）を控える

### B. 画面共有をオンにする（Mac Studio）
- システム設定 → 一般 → 共有 → **画面共有** をオン。「アクセスを許可」は自分のユーザー（gaki）だけにする
- MacBook から: Finder で `⌘K` → `vnc://gakinomac-studio`（Tailscale の名前）→ Mac Studio のユーザー名とパスワード
- iPhone から: VNC に対応したアプリ（例: RealVNC Viewer、Screens）で同じ名前に接続

### C. SSH（リモートログイン）をオンにして、MacBook の Claude が使えるようにする（Mac Studio）
- システム設定 → 一般 → 共有 → **リモートログイン** をオン。「アクセスを許可」は gaki だけにする
- MacBook の Claude 用の鍵を登録する（パスワードではなく鍵だけで入れるようにする）:
  1. MacBook で `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_macstudio -C "claude@macbook"` を実行（柴垣さん本人が実行）
  2. 表示された公開鍵（`~/.ssh/id_ed25519_macstudio.pub` の中身）を Mac Studio の `~/.ssh/authorized_keys` に1行追加
  3. MacBook の `~/.ssh/config` に次を追加:
     ```
     Host macstudio
       HostName gakinomac-studio
       User gaki
       IdentityFile ~/.ssh/id_ed25519_macstudio
     ```
  4. MacBook で `ssh macstudio 'hostname; ls ~/ci-daily-engine'` が通れば完了
- パスワードでのログインは使わない（鍵のみ）。Tailscale の外（インターネット）からは届かない

### D. 停電・再起動への備え（Mac Studio）
```bash
sudo pmset -a autorestart 1
pmset -g | grep -E "sleep|autorestart"
```
- 自動アップデートの「macOS アップデートをインストール」をオフ（上の「海外運用で一番こわいこと」参照）

---

# 層4: Claude の Remote Control

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
