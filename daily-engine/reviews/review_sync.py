#!/usr/bin/env python3
"""BASE（camjyo.theshop.jp）のレビューを全商品ぶん読み、ci-threads の /api/reviews に同期する。

読むのは公開ページだけ（ログイン不要）。商品ページのレビュー欄が読み込む断片
  https://camjyo.theshop.jp/items/<id>/reviews?format=item&score=&page=<n>
に、評価（良い・普通・悪い）・日付・本文・ショップの返信が入っている。
BASEは連続アクセスで429を返すので、1件ずつ間を空ける。

レビューには公開IDが無いため、商品ID・日付・評価・本文から key を作る。
同じ内容が同じ商品に複数ある（本文なしの評価が同じ日に並ぶ等）ときは、古い順に -2, -3 を付ける。

使い方:
  python3 review_sync.py --dry               # 集めて件数だけ表示（送らない）
  python3 review_sync.py --dry --out x.json  # 集めた全件をJSONに保存
  python3 review_sync.py --post              # /api/reviews に送る（環境変数 X_WRITER_KEY が必要）
"""
import hashlib, html, json, os, re, subprocess, sys, time
from datetime import datetime, timezone, timedelta

SHOP = "https://camjyo.theshop.jp"
API = os.environ.get("CI_THREADS_API", "https://ci-threads.pages.dev")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
JST = timezone(timedelta(hours=9))
WAIT = 2  # 秒。BASEの429避け


def get(url, tries=3):
    code = ""
    for i in range(tries):
        r = subprocess.run(["curl", "-s", "-m", "30", "-A", UA, "-H", "Accept-Language: ja", "-w", "\n%{http_code}", url],
                           capture_output=True, text=True)
        body, _, code = r.stdout.rpartition("\n")
        if code == "200":
            return body
        time.sleep(5 * (i + 1))
    raise RuntimeError(f"取得できません: {url}（HTTP {code}）")


def text_of(fragment):
    """<p>の中身をプレーンテキストに。BASEは改行をそのまま入れている"""
    t = re.sub(r"<br\s*/?>", "\n", fragment)
    t = re.sub(r"<[^>]+>", "", t)
    return html.unescape(t).strip()


def parse_page(item_id, s):
    out = []
    for li in re.findall(r'<li class="review01__listChild">(.*?)</li>', s, re.S):
        date = re.search(r'datetime="([^"]+)"', li)
        score = re.search(r"ico--(good|normal|bad)", li)
        name = re.search(r'review01__itemName">(.*?)</p>', li, re.S)
        comment = re.search(r'review01__comment">(.*?)</p>', li, re.S)
        reply = re.search(r'review01__reply">(.*?)</p>', li, re.S)
        out.append({
            "item_id": item_id,
            "item_name": text_of(name.group(1)) if name else "",
            "review_date": date.group(1) if date else "",
            "score": score.group(1) if score else "",
            "comment": text_of(comment.group(1)) if comment else "",
            "shop_reply": text_of(reply.group(1)) if reply else "",
        })
    return out


def item_ids():
    top = get(SHOP + "/")
    return sorted(set(re.findall(r'href="https://camjyo\.theshop\.jp/items/(\d+)"', top)), key=int)


def crawl(log=print):
    reviews, items = [], item_ids()
    for item_id in items:
        page, got = 1, []
        while page <= 50:
            time.sleep(WAIT)
            s = get(f"{SHOP}/items/{item_id}/reviews?format=item&score=&page={page}")
            rows = parse_page(item_id, s)
            if not rows:
                break
            got += rows
            page += 1
        # key は古い順に数える（新しいレビューが増えても既存の key が動かないように）
        seen = {}
        for r in reversed(got):
            base = hashlib.sha1("|".join([r["item_id"], r["review_date"], r["score"], r["comment"]]).encode()).hexdigest()[:16]
            seen[base] = seen.get(base, 0) + 1
            r["key"] = base if seen[base] == 1 else f"{base}-{seen[base]}"
        reviews += got
        log(f"  商品 {item_id}: {len(got)}件")
    return items, reviews


def post_sync(items, reviews):
    key = os.environ.get("X_WRITER_KEY", "")
    if not key:
        raise SystemExit("X_WRITER_KEY が未設定です（~/.config/himori/tokens.env）")
    payload = {"action": "sync", "items_counted": len(items),
               "counted_at": datetime.now(JST).strftime("%Y-%m-%dT%H:%M:%S+09:00"), "reviews": reviews}
    tmp = f"/tmp/ci-review-sync-{os.getpid()}.json"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    try:
        r = subprocess.run(["curl", "-s", "-m", "60", "-X", "POST", f"{API}/api/reviews",
                            "-H", "content-type: application/json", "-H", f"x-writer-key: {key}",
                            "--data-binary", f"@{tmp}", "-w", "\n%{http_code}"], capture_output=True, text=True)
    finally:
        os.remove(tmp)
    body, _, code = r.stdout.rpartition("\n")
    if code != "200":
        raise SystemExit(f"同期に失敗: HTTP {code} {body[:300]}")
    return json.loads(body)


def main():
    items, reviews = crawl(log=lambda m: print(m, file=sys.stderr))
    with_comment = [r for r in reviews if r["comment"]]
    unreplied = [r for r in with_comment if not r["shop_reply"]]
    print(f"商品 {len(items)} 件 / レビュー {len(reviews)} 件（本文あり {len(with_comment)}・うち返信なし {len(unreplied)}）")
    if "--out" in sys.argv:
        path = sys.argv[sys.argv.index("--out") + 1]
        with open(path, "w", encoding="utf-8") as f:
            json.dump(reviews, f, ensure_ascii=False, indent=1)
        print("保存:", path)
    if "--post" in sys.argv:
        res = post_sync(items, reviews)
        print("同期:", json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
