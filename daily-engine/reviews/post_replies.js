// アプリで承認されたBASEレビューの返信を、BASEに投稿する（Mac Studio・収集用Chrome＝CDP 9222 のログインを使う）
//
// 1. GET /api/reviews?status=approved（承認済みで、まだBASEに載っていないもの）
// 2. BASE管理画面のレビュー一覧（/apps/64/data）を読み、日付と本文が一致するレビューを1件だけ探す
// 3. 管理画面と同じ送り方（POST /review/review_ajax/save_reply・id と reply）で投稿する
// 4. 成功したら POST /api/reviews {action:"posted"}。結果は {action:"poster"} で記録し、アプリに出す
//
// 承認されたものだけを送る。一致が1件でない・すでに返信がある・500文字を超える、のどれかなら送らない。
// 使い方: node post_replies.js [--dry | --dry-drafts]   （--dry は照合だけ・--dry-drafts は承認待ちの下書きで照合を試す。どちらも投稿しない）
// 環境変数: X_WRITER_KEY（必須）、CI_THREADS_API
const puppeteer = require("puppeteer-core");

const API = process.env.CI_THREADS_API || "https://ci-threads.pages.dev";
const KEY = process.env.X_WRITER_KEY || "";
const DRAFTS = process.argv.includes("--dry-drafts"); // 試験用: 承認待ちの下書きで照合だけ試す
const DRY = DRAFTS || process.argv.includes("--dry");
const ADMIN = "https://admin.thebase.com/apps/64/data";
const MAX_LEN = 500; // BASEの返信欄の上限

const norm = s => String(s || "").replace(/\s+/g, "");
const normDate = s => { const m = String(s || "").match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : ""; };

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method, headers: { "content-type": "application/json", "x-writer-key": KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
  return res.json();
}
const report = (ok, note) => DRY ? Promise.resolve() : api("POST", "/api/reviews", { action: "poster", ok, note: String(note).slice(0, 300) }).catch(() => {});

// 管理画面のレビュー一覧を全ページ読む（内部ID・日付・本文・今の返信）
async function readAdmin(page) {
  const all = [];
  let url = ADMIN;
  for (let i = 0; i < 30 && url; i++) {
    // 管理画面は裏でメッセージを取りに行き続けるので networkidle は来ない。一覧の要素を待つ
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (/\/users\/login/.test(page.url())) throw new Error("BASEのログインが切れています（Mac Studioの収集用Chromeでログインしてください）");
    await page.waitForSelector(".reviewList__wrap", { timeout: 30000 });
    const { rows, next } = await page.evaluate(() => ({
      rows: [...document.querySelectorAll(".reviewList__wrap")].map(w => ({
        id: w.querySelector(".reviewList__id")?.value || "",
        date: w.querySelector(".reviewList__date")?.textContent.trim() || "",
        item: w.querySelector(".reviewList__itemName")?.textContent.trim() || "",
        comment: w.querySelector(".reviewList__comment")?.textContent || "",
        reply: w.querySelector(".reviewList__reply")?.value || "",
      })),
      next: [...document.querySelectorAll("a")].find(a => /^次/.test((a.textContent || "").trim()))?.href || null,
    }));
    all.push(...rows);
    url = next && next !== url ? next : null;
  }
  return all;
}

(async () => {
  if (!KEY) throw new Error("X_WRITER_KEY が未設定です");
  const approved = DRAFTS
    ? ((await api("GET", "/api/reviews?status=draft")).reviews || []).map(r => ({ ...r, final_text: r.draft }))
    : (await api("GET", "/api/reviews?status=approved")).reviews || [];
  if (!approved.length) { console.log("承認済みで未投稿の返信はありません"); return; }
  console.log(`承認済み: ${approved.length}件${DRY ? "（--dry: 投稿しない）" : ""}`);

  const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
  const page = await browser.newPage();
  let posted = 0, skipped = 0;
  try {
    const admin = await readAdmin(page);
    console.log(`管理画面のレビュー: ${admin.length}件`);
    for (const r of approved) {
      const text = String(r.final_text || "").trim();
      let hits = admin.filter(a => normDate(a.date) === r.review_date && norm(a.comment) === norm(r.comment));
      // 同じ日に同じ文面のレビューが別の商品にもある（例: 8/8 ホワイトセージと朝のお香）ときは商品名でも絞る
      if (hits.length > 1) hits = hits.filter(a => norm(a.item) === norm(r.item_name));
      const why =
        !text ? "返信文が空" :
        text.length > MAX_LEN ? `${text.length}文字（BASEは500文字まで）` :
        hits.length !== 1 ? `管理画面で一致するレビューが${hits.length}件` :
        hits[0].reply ? "BASEにすでに返信がある" : "";
      if (why) { skipped++; console.log(`  見送り ${r.key}: ${why}`); continue; }
      if (DRY) { console.log(`  投稿できる ${r.key} → 管理画面ID ${hits[0].id}（${hits[0].item.slice(0, 20)}）`); continue; }

      const res = await page.evaluate(async (id, reply) => {
        const fd = new FormData();
        fd.append("id", id);
        fd.append("reply", reply);
        const r = await fetch("/review/review_ajax/save_reply", { method: "POST", body: fd, credentials: "same-origin" });
        let j = null; try { j = await r.json(); } catch (e) {}
        return { status: r.status, result: !!(j && j.result) };
      }, hits[0].id, text);
      if (!res.result) { skipped++; console.log(`  失敗 ${r.key}: HTTP ${res.status}`); continue; }
      await api("POST", "/api/reviews", { action: "posted", key: r.key });
      posted++;
      console.log(`  投稿 ${r.key} → 管理画面ID ${hits[0].id}`);
    }
    if (!DRY) await report(skipped === 0, `投稿${posted}件・見送り${skipped}件`);
  } catch (e) {
    console.error("ERROR", e.message);
    await report(false, e.message);
    process.exitCode = 1;
  } finally {
    await page.close();
    browser.disconnect();
  }
})().catch(async e => { console.error("ERROR", e.message); await report(false, e.message); process.exit(1); });
