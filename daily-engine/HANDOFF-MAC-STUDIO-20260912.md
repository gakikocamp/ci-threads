# Mac Studio Claude 引き継ぎプロンプト（2026-09-12）

以下をMac StudioのClaude Codeに、そのまま貼り付ける。

```text
ci-threadsのデイリーエンジンを、現在の実装を壊さずに引き継ぎ・修復してください。投稿は絶対にしません。収集、評価、ウェブアプリへの候補反映だけ行います。

目的:
- 毎朝6:54に4ブランドを処理する
- CI: @crystal_insence と @gakikocamp
- スタートアップ九州: @startupkyushu
- 橋本華恋: @konnichiwa.karen
- VAN TRIP JAPAN: @vantripjapan
- 各ブランドの候補は5本、確度順。毎日同じ日付の行を上書きする
- SNSへの自動投稿は禁止

本番の正本:
- GET https://ci-threads.pages.dev/api/brands（x-sync-key: ci-threads-sync-v1）
- engine=multibrand のブランドを毎朝動的に処理する
- 投稿成績: /api/results?brand=<id>
- 研究投稿: /api/buzz?brand=<id>
- 今日の候補: /api/daily?brand=<id>

まず調査:
1. launchctl print gui/$(id -u)/com.crystalinsence.dailybuzz で、実際に登録されているProgramArguments、最終終了コード、次回実行設定を確認。
2. 実際のrun-daily.sh、collector.js、9/11と9/12のログの場所を特定。推測したパスで上書きしない。
3. 9/12にCI以外が更新されなかった原因をログから特定する。現在の本番dailyはCI=9/12、karen=9/11、startup-kyushu=9/11、vantrip=9/11。
4. Chrome CDP 127.0.0.1:9222がLISTENし、Threadsをログイン状態で取得できるか確認。

修復:
5. CIの既存処理は残し、/api/brandsを毎回読み、engine=multibrand の全ブランドをループする。現在はstartup-kyushu、karen、vantripが対象。
6. 1ブランドが失敗しても残りを続行し、ブランド別に収集件数・生成件数・API応答・エラーをログへ書く。
7. 自社投稿は本文、いいね、返信、再投稿、投稿時刻、画像有無を収集。自分が管理するアカウントで取得可能なら、投稿インサイトの閲覧数、いいね率、返信率、再投稿率、引用率、シェア率も取る。24時間未満は結果確定しない。
8. 生成時は/api/brandsのequation、equation_override、facts、ngを毎回読む。いいね率=共感、再投稿・引用・シェア率=配信拡大として別々に評価する。確認済みの拡散材料（未知の事実、具体数字、失われる危機、意外な対比）が本文にない案は79以下。同型で高い再投稿率を再現していない案は90以上にしない。confidenceは確率ではなく相対スコア。
9. VTJは英語・仏語・独語候補。ブランド署名は付けない。国名・言語・旅の日数・2行目の角度ごとに成績を分ける。

テスト:
10. 先にDRY_DAILY=1でstartup-kyushu、karen、vantripを実行し、収集件数と5候補を確認。
11. 問題がなければCI以外の3ブランドだけDRY_DAILY=0で今日の日付へ反映。SNS投稿はしない。
12. curlで3ブランドの/api/dailyが今日の日付、candidates=5件になったことを確認。
13. launchdが明朝6:54に同じ処理を行う状態を確認して終了。

最後に、①9/12停止原因、②4ブランドそれぞれの収集件数、③反映した候補数、④明朝の実行可否、⑤ブラウザの取りこぼしを報告してください。
```

