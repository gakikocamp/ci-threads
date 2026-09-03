# デイリーバズ・エンジン（Mac Studio 常駐版）

クリスタルインセンスのThreads運用を、**Mac Studioが起きている限り毎朝自動**で回す。
このPCが閉じていても、Mac Studio側で走る。

## 何が自動で起きるか（毎朝 6:54）
1. @crystal_insence / @gakikocamp の直近投稿を収集（いいね/リプ/リポスト＋インサイトの view/リーチ）
2. 前日〜数日で確定した自社投稿を `buzz/ok/miss` 判定 → `/api/results` に記録（学習ループ校正）
3. #国産を守ろう / #国産 の新規バズを1〜2件 → `/api/buzz` に追加
4. 実測パターン別バズ率＋勝ちフック型から**今日の推奨投稿を1本生成**
5. `/api/daily` に反映 → ci-threadsアプリの「☀️今日の推奨投稿」に表示
6. **投稿はしない**（本人がアプリからコピペして投稿）。災害等の日は `mode='safety'` で無事報告トーンに自動切替

生成は **Claude Code内（サブスク枠）** で行うので、日次のAPI従量課金は発生しない。

---

## 前提（Mac Studio 側に一度だけ用意）
- [ ] **Claude Code** がインストール済みでログイン済み（ターミナルで `claude --version` が通る）
- [ ] **Chrome + Claudeブラウザ拡張** がサインイン済み（このClaude Codeとペアリングできる状態）
- [ ] Chromeで **Threadsに @crystal_insence でログイン済み**（ログイン状態を維持）
- [ ] このリポジトリ（iCloud Drive経由で同じパスに同期されている想定）が Mac Studio からも見える

> ⚠️ このエンジンは **ログイン済みブラウザを使う**ため、Mac Studioは「スリープさせない（画面ロックは可）」設定が必要。
> システム設定 → ロック画面/バッテリー →「ディスプレイがオフのときにMacを自動でスリープさせない」をON。

---

## 導入手順（Mac Studio のターミナルで実行）

### STEP 0: まず対話で1回テスト（拡張ペアリング＆権限の確認・重要）
launchdの無人実行に任せる前に、対話で一度動かして「Chrome拡張がつながる／ツールが動く」ことを確認する。
```bash
# Mac Studio で Chrome を開き、Claude拡張にサインイン＆Threadsに@crystal_insenceでログインしておく
cd "/Users/gakipro/Library/Mobile Documents/com~apple~CloudDocs/開発用/SecondGaki/クリスタルインセンス/threads-app"
claude            # 対話起動 → 「list_connected_browsers で Chrome が見えるか確認して」と打つ
# 見えれば OK。見えなければ Chrome/拡張のサインインを確認。
```
これが通れば、以下の無人化に進む。

```bash
# 1) スクリプトに実行権限
chmod +x "/Users/gakipro/Library/Mobile Documents/com~apple~CloudDocs/開発用/SecondGaki/クリスタルインセンス/threads-app/daily-engine/run-daily.sh"

# 2) launchd に登録（plistを LaunchAgents にリンク）
ln -sf "/Users/gakipro/Library/Mobile Documents/com~apple~CloudDocs/開発用/SecondGaki/クリスタルインセンス/threads-app/daily-engine/com.crystalinsence.dailybuzz.plist" ~/Library/LaunchAgents/com.crystalinsence.dailybuzz.plist
launchctl load ~/Library/LaunchAgents/com.crystalinsence.dailybuzz.plist

# 3) 今すぐ1回テスト実行（朝を待たずに動作確認）
launchctl start com.crystalinsence.dailybuzz
# → ログを確認
tail -f "/Users/gakipro/Library/Mobile Documents/com~apple~CloudDocs/開発用/SecondGaki/クリスタルインセンス/threads-app/daily-engine/logs/$(date +%Y-%m-%d).log"
```

うまく動けば、ci-threadsアプリの「☀️今日の推奨投稿」に本文が表示される。

## 停止・確認
```bash
launchctl list | grep dailybuzz              # 登録確認
launchctl stop com.crystalinsence.dailybuzz  # 実行中を止める
launchctl unload ~/Library/LaunchAgents/com.crystalinsence.dailybuzz.plist  # 登録解除
```

---

## トラブル時
- **`claude` が見つからない**: `which claude` のパスを plist の `EnvironmentVariables > PATH` に足す。
- **ブラウザ操作で止まる/権限で止まる**: headlessのClaude Codeがブラウザ拡張とペアリングできていない可能性。
  まず Mac Studio で `claude` を対話起動し、拡張がつながる（`list_connected_browsers`が見える）ことを確認してから launchd に任せる。
- **インサイトが取れない**: Threadsの仮想リスト/ログイン切れ。ログイン状態と、`run-daily.sh` 内プロンプトの収集手順を確認。
- **完全headlessでブラウザ制御が不安定な場合**: Threads公式API（own-accountのview/like等を安定取得）に切替える選択肢あり。必要になったら手順を用意する。

## この仕組みの限界（正直な注記）
- Mac Studioが**スリープ/電源オフ**だと走らない（クラウドではないため）。
- launchd の `StartCalendarInterval` は、Mac起動中でなければその時刻分をスキップ（次回に持ち越さない）。
- 競合スクレイピングはThreadsのUI変更に影響され得る（Claudeが適応的に読むが、稀に取りこぼす）。
