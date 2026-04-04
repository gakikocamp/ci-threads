#!/usr/bin/env python3
"""
クリスタルインセンス 週次投稿自動生成スクリプト
毎週月曜5:00 JST に GitHub Actions から実行される
"""
import anthropic
import json
import re
import os
import sys
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))

def get_week_id(extra=False):
    now = datetime.now(JST)
    year, week, _ = now.isocalendar()
    base = f"{year}-W{week:02d}"
    return f"{base}-extra" if extra else base

def get_date_str():
    return datetime.now(JST).strftime('%Y-%m-%d')

def get_existing_batch_ids(content):
    return re.findall(r'"batchId":\s*"([^"]+)"', content)

def build_prompt(week_id, date_str):
    return f"""あなたはクリスタルインセンス（Crystal Incense）のThreads投稿専門家です。
今週（{week_id} / {date_str}）の新しい投稿案を40個生成してください。

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

【投稿パターン12種（バランスよく使うこと）】
①Dear Algo型 ②構造的絶滅型 ③余白型 ④水車静寂型 ⑤未完ストーリー型
⑥専門家裏側型 ⑦デジタルデトックス型 ⑧素材の叫び型 ⑨リプ完結型
⑩二択型 ⑪失敗学び型 ⑫暦型

以下のJSON配列のみを返してください（説明文・前置き不要）：
[
  {{
    "id": "{week_id}-001",
    "pattern": "パターン名（例：③余白型）",
    "theme": "テーマ（例：スマホを置く15分）",
    "body": "投稿本文（\\nで改行）",
    "reply": "追いリプ本文（投稿直後に自分でリプするテキスト）",
    "tag": "#タグ名（1つのみ）",
    "confidence": 85
  }},
  ...（40件、idは{week_id}-001〜{week_id}-040）
]"""

def generate_posts(week_id, date_str):
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY environment variable not set")

    client = anthropic.Anthropic(api_key=api_key)
    print("Claude APIに接続中...")

    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=16000,
        messages=[{"role": "user", "content": build_prompt(week_id, date_str)}]
    )

    text_block = next((b for b in message.content if hasattr(b, 'text')), None)
    if not text_block:
        raise ValueError("APIレスポンスにテキストコンテンツがありません")
    text = text_block.text
    match = re.search(r'\[[\s\S]*\]', text)
    if not match:
        raise ValueError(f"JSONが見つかりません。レスポンス: {text[:200]}")

    posts = json.loads(match.group())
    print(f"{len(posts)}件の投稿を生成しました")
    if len(posts) < 40:
        print(f"⚠️ 警告: 期待件数(40)より少ない {len(posts)} 件しか生成されませんでした")
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

    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(new_content)

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
