#!/usr/bin/env python3
"""
Claude Codeが生成した投稿バッチ(JSON)を index.html に注入するスクリプト。
外部APIは一切呼ばない（従量課金ゼロ運用）。

使い方:
  python3 insert_batch.py batch.json          # 今週のweek_idで注入
  python3 insert_batch.py batch.json --extra  # 週2回目バッチとして注入

batch.json の形式: [{"pattern": "...", "theme": "...", "body": "...",
                     "reply": "...", "tag": "#...", "cta": false, "confidence": 85}, ...]
idは自動採番される（{week_id}-001〜）。
"""
import json
import re
import os
import sys
import tempfile
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))


def get_week_id(extra=False):
    now = datetime.now(JST)
    year, week, _ = now.isocalendar()
    base = f"{year}-W{week:02d}"
    return f"{base}-extra" if extra else base


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    extra = '--extra' in sys.argv
    if not args:
        print("使い方: python3 insert_batch.py batch.json [--extra]")
        sys.exit(1)

    with open(args[0], encoding='utf-8') as f:
        posts = json.load(f)
    if not isinstance(posts, list) or not posts:
        raise ValueError("batch.json は投稿の配列である必要があります")

    week_id = get_week_id(extra)
    date_str = datetime.now(JST).strftime('%Y-%m-%d')

    required = {"pattern", "theme", "body", "reply", "tag", "cta", "confidence"}
    for i, p in enumerate(posts):
        missing = required - set(p.keys())
        if missing:
            raise ValueError(f"{i+1}件目にフィールド不足: {missing}")
        p_id = f"{week_id}-{i+1:03d}"
        posts[i] = {"id": p_id, **{k: p[k] for k in ["pattern", "theme", "body", "reply", "tag", "cta", "confidence"]}}

    cta_count = sum(1 for p in posts if p.get('cta'))
    print(f"{len(posts)}件（うち導線投稿 {cta_count}件）を {week_id} として注入します")

    html_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html')
    with open(html_path, 'r', encoding='utf-8') as f:
        content = f.read()

    if week_id in re.findall(r'"batchId":\s*"([^"]+)"', content):
        print(f"バッチ {week_id} は既に存在します。中止します。")
        sys.exit(1)

    new_batch = {
        "batchId": week_id,
        "generatedAt": date_str,
        "note": f"Claude Code生成 {date_str}",
        "posts": posts,
    }
    batch_json = json.dumps(new_batch, ensure_ascii=False, indent=2).replace('</', '<\\/')
    indented = '\n'.join('  ' + line for line in batch_json.split('\n'))

    marker = 'const WEEKLY_BATCHES = ['
    if marker not in content:
        raise ValueError("index.html に WEEKLY_BATCHES が見つかりません")
    new_content = content.replace(marker, f'{marker}\n{indented},', 1)

    dir_name = os.path.dirname(html_path)
    with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=dir_name, delete=False, suffix='.tmp') as tmp:
        tmp.write(new_content)
        tmp_path = tmp.name
    os.replace(tmp_path, html_path)
    print(f"index.html を更新しました（{week_id}）。git commit & push でアプリに配信されます。")


if __name__ == '__main__':
    main()
