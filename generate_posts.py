#!/usr/bin/env python3
"""
クリスタルインセンス 週次投稿自動生成スクリプト v2（自己学習型）
毎週月曜5:00 JST に GitHub Actions から実行される

v2の変更点:
- 過去の投稿結果（バズった/普通/不発）を /api/results から取得し、
  勝ちパターン・負けパターンを毎週の生成プロンプトに注入する（閉ループ学習）
- 40件中5件は自社導線（ショップ/LINE/メルマガ/企画）へつなぐ cta 投稿
- モデルを claude-opus-4-8 に更新（コピー品質優先。コスト重視なら claude-sonnet-5 に変更可）
- 構造化出力（JSON Schema）でパース事故をゼロに
"""
import anthropic
import json
import re
import os
import sys
import tempfile
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))

MODEL = "claude-opus-4-8"  # コスト重視なら "claude-sonnet-5"
POST_COUNT = 40
CTA_COUNT = 5
RESULTS_URL = os.environ.get("RESULTS_URL", "https://ci-threads.pages.dev/api/results")

# 自社導線の現在のメニュー（変わったらここを更新する）
OWNED_FUNNEL_NOTE = """- オンラインショップ（プロフィールのリンクから。お試しセット・定期便あり）
- メルマガ登録（初回10%OFFクーポン特典）
- 進行中の企画（例: 塗香の特別調合、限定ドロップ、入荷通知）"""

POSTS_SCHEMA = {
    "type": "object",
    "properties": {
        "posts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "pattern": {"type": "string"},
                    "theme": {"type": "string"},
                    "body": {"type": "string"},
                    "reply": {"type": "string"},
                    "tag": {"type": "string"},
                    "cta": {"type": "boolean"},
                    "confidence": {"type": "integer"},
                },
                "required": ["id", "pattern", "theme", "body", "reply", "tag", "cta", "confidence"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["posts"],
    "additionalProperties": False,
}


def get_week_id(extra=False):
    now = datetime.now(JST)
    year, week, _ = now.isocalendar()
    base = f"{year}-W{week:02d}"
    return f"{base}-extra" if extra else base


def get_date_str():
    return datetime.now(JST).strftime('%Y-%m-%d')


def get_existing_batch_ids(content):
    return re.findall(r'"batchId":\s*"([^"]+)"', content)


def fetch_results():
    """過去の投稿結果をD1同期APIから取得する。失敗しても週次生成は止めない。"""
    try:
        with urllib.request.urlopen(RESULTS_URL, timeout=20) as res:
            data = json.loads(res.read().decode("utf-8"))
        posts = data.get("posts", [])
        print(f"学習データ: {len(posts)}件の投稿記録を取得")
        return posts
    except Exception as e:
        print(f"⚠️ 結果データの取得に失敗（学習なしで続行）: {e}")
        return []


def build_learning_block(results):
    """記録済みの結果から「勝ちパターン・負けパターン」ブロックを作る。"""
    labeled = [p for p in results if p.get("result") in ("buzz", "ok", "miss")]
    if len(labeled) < 3:
        return ""

    # パターン別成績
    stats = defaultdict(lambda: {"buzz": 0, "ok": 0, "miss": 0})
    for p in labeled:
        pattern = (p.get("pattern") or "不明").strip()
        stats[pattern][p["result"]] += 1

    lines = []
    for pattern, s in sorted(stats.items(), key=lambda kv: -(kv[1]["buzz"] / max(sum(kv[1].values()), 1))):
        n = sum(s.values())
        if n < 2:
            continue
        rate = round(s["buzz"] / n * 100)
        lines.append(f"- {pattern}: バズ率{rate}%（🔥{s['buzz']} / 👍{s['ok']} / 💤{s['miss']}）")
    stats_block = "\n".join(lines) if lines else "（パターン別の十分なデータはまだなし）"

    def newest(result, limit, chars):
        items = [p for p in labeled if p["result"] == result]
        items.sort(key=lambda p: p.get("posted_at") or 0, reverse=True)
        out = []
        for p in items[:limit]:
            body = (p.get("body") or "").replace("\n", " ")[:chars]
            out.append(f"- [{p.get('pattern') or '?'}] {body}")
        return "\n".join(out) if out else "（なし）"

    return f"""
【実績からの学習（実際のThreads投稿結果。最重視すること）】
▼ パターン別成績（2件以上記録があるもの・バズ率順）
{stats_block}

▼ 直近バズった投稿の実例（この方向性・温度感を今週の主軸にする）
{newest("buzz", 5, 160)}

▼ 直近不発だった投稿の実例（この方向性は避けるか、切り口を大きく変える）
{newest("miss", 5, 100)}

- バズ率の高いパターンに件数を多めに配分し、不発が続くパターンは思い切って減らすこと
- ただし全滅回避のため、新しい切り口の実験枠も2〜3割残すこと
"""


def build_prompt(week_id, date_str, learning_block):
    return f"""あなたはクリスタルインセンス（Crystal Incense）のThreads投稿専門家です。
今週（{week_id} / {date_str}）の新しい投稿案を{POST_COUNT}個生成してください。

【ブランド情報】
- 香司 柴垣。国産・無添加のお香。
- 「お香」ではなく「お香のある暮らし（時間・空気・静けさ）」を売る
- 素材：椨粉（福岡県産・自然栽培）・水車製法（電気不使用）・屋久杉・八女杉・3代続く工場から直接調達
- キーワード：灯、余韻、静けさ、澄む、受け継ぐ、手仕事、暮らし、呼吸、選択、整える

【文体ルール】
- 1行目は必ず「止まる」強いキャッチ
- 口語・余韻・生活の断片（「気づき」で書く、「説明」しない）
- 問いかけで終わるか、返信したくなる余白を作る
- 恐怖訴求は「選択できる」着地に
- NG：スピリチュアル全振り・健康効果断定・AIっぽい羅列・お香連打・無添加を攻撃的に使う

【2026年Threadsアルゴリズム重視ポイント】
- 返信ラリーが最高評価（いいねより返信の深度）
- 初動90分の会話速度が命
- 二択・低ハードルの問いかけが返信を生みやすい
- 保存を促す読み物は長期リーチが続く
- 人間味・体温・自然な口語が高評価
- エンゲージメントベイト（いいね乞い）はペナルティ
{learning_block}
【投稿パターン12種（実績を踏まえて配分すること）】
①Dear Algo型 ②構造的絶滅型 ③余白型 ④水車静寂型 ⑤未完ストーリー型
⑥専門家裏側型 ⑦デジタルデトックス型 ⑧素材の叫び型 ⑨リプ完結型
⑩二択型 ⑪失敗学び型 ⑫暦型

【自社導線ミッション（アルゴリズム非依存の顧客資産づくり・重要）】
- {POST_COUNT}件中ちょうど{CTA_COUNT}件は "cta": true とし、本文または追いリプの最後に、
  プロフィールのリンク先へ自然につなぐ一文を入れること
- 現在の導線メニュー:
{OWNED_FUNNEL_NOTE}
- 宣伝臭は厳禁。「気になる人のために置いておきます」程度の温度で、
  バズを狙う本文の質は他の{POST_COUNT - CTA_COUNT}件と同じ基準を守ること
- 残り{POST_COUNT - CTA_COUNT}件は "cta": false

【出力仕様】
- posts配列にちょうど{POST_COUNT}件
- idは {week_id}-001 〜 {week_id}-{POST_COUNT:03d}
- patternはパターン名（例: ③余白型）、themeは短いテーマ、bodyは投稿本文（\\nで改行）
- replyは投稿直後に自分でつける追いリプ本文、tagはハッシュタグ1つ（例: #お香のある暮らし）
- confidenceはバズ確度0〜100の整数"""


def generate_posts(week_id, date_str):
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY environment variable not set")

    learning_block = build_learning_block(fetch_results())
    if learning_block:
        print("実績学習ブロックをプロンプトに注入しました")
    else:
        print("学習データ不足のため基本プロンプトで生成します（結果を記録すると次週から賢くなります）")

    client = anthropic.Anthropic(api_key=api_key)
    print(f"Claude API ({MODEL}) に接続中...")

    with client.messages.stream(
        model=MODEL,
        max_tokens=60000,
        thinking={"type": "adaptive"},
        output_config={"format": {"type": "json_schema", "schema": POSTS_SCHEMA}},
        messages=[{"role": "user", "content": build_prompt(week_id, date_str, learning_block)}],
    ) as stream:
        message = stream.get_final_message()

    if message.stop_reason == "refusal":
        raise ValueError("APIが生成を拒否しました。プロンプトを確認してください")

    text = next((b.text for b in message.content if b.type == "text"), None)
    if not text:
        raise ValueError("APIレスポンスにテキストコンテンツがありません")

    posts = json.loads(text).get("posts", [])
    if not posts:
        raise ValueError("生成された投稿が0件です。APIレスポンスを確認してください")
    print(f"{len(posts)}件の投稿を生成しました（うち導線投稿 {sum(1 for p in posts if p.get('cta'))}件）")
    if len(posts) < POST_COUNT:
        print(f"⚠️ 警告: 期待件数({POST_COUNT})より少ない {len(posts)} 件しか生成されませんでした")
    return posts


def update_html(posts, week_id, date_str):
    html_path = 'index.html'
    with open(html_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 既存バッチIDをチェック（重複スキップ）
    existing = get_existing_batch_ids(content)
    if week_id in existing:
        print(f"バッチ {week_id} は既に存在します。スキップします。")
        return False

    new_batch = {
        "batchId": week_id,
        "generatedAt": date_str,
        "note": f"自動生成 {date_str}",
        "posts": posts
    }

    batch_json = json.dumps(new_batch, ensure_ascii=False, indent=2)
    # <script>ブロック内の</script>タグを安全にエスケープ
    batch_json = batch_json.replace('</', '<\\/')
    # インデント調整
    lines = batch_json.split('\n')
    indented = '\n'.join('  ' + line for line in lines)

    marker = 'const WEEKLY_BATCHES = ['
    if marker not in content:
        raise ValueError("index.html に WEEKLY_BATCHES が見つかりません")

    new_content = content.replace(
        marker,
        f'{marker}\n{indented},',
        1
    )

    # アトミック書き込み（書き込み中の失敗でファイルが壊れないように）
    dir_name = os.path.dirname(os.path.abspath(html_path))
    with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=dir_name, delete=False, suffix='.tmp') as tmp:
        tmp.write(new_content)
        tmp_path = tmp.name
    os.replace(tmp_path, html_path)

    print(f"index.html を更新しました（{week_id}、{len(posts)}件）")
    return True


def main():
    extra = '--extra' in sys.argv
    week_id = get_week_id(extra)
    date_str = get_date_str()
    print(f"=== 週次投稿更新 {week_id} ({date_str}) ===")

    posts = generate_posts(week_id, date_str)
    updated = update_html(posts, week_id, date_str)

    if updated:
        print("完了！GitHub にプッシュ後、Cloudflare に自動デプロイされます。")
    else:
        print("更新なし。終了します。")


if __name__ == '__main__':
    main()
