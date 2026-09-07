#!/usr/bin/env node
// ローカルD1に「30投稿ぶんの合成データ」を投入して学習エンジンを検証するための道具。
// 本番では絶対に実行しない（--remote を受け付けない）。
//   node scripts/seed-synthetic.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
if (process.argv.includes('--remote')) { console.error('本番には投入しない'); process.exit(1); }

const PATTERNS = ['数字絶滅型', '問いかけ二択', '真実暴露型', '誤解訂正型', '保存版の知恵', '舞台裏日常'];
const HOOKS = ['衝撃数字', '問いかけ', '秘密予告', '現場の一文'];
const SLOTS = ['morning', 'evening'];
const FORMATS = ['single', 'reply'];
const FACTS = ['tabu-craftsmen-2', 'waterwheel', 'six-free', 'fire-method', 'crystal-yamaguchi', 'yame-sugi', 'tabu-role', 'five-years'];

// Workerは jstDateString() で日付を作るので、合成データもJSTに揃える（UTCで作ると I1/I2 が落ちる）
const day = (n) => new Date(Date.now() - n * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
const ts = (n, hour) => Date.parse(`${day(n)}T${String(hour).padStart(2, '0')}:00:00+09:00`);

const sql = [];
sql.push(`DELETE FROM x_queue WHERE id LIKE 'syn-%';`);
sql.push(`DELETE FROM x_metrics WHERE tweet_id LIKE '9%';`);
sql.push(`DELETE FROM x_account_daily;`, `DELETE FROM x_observations;`, `DELETE FROM x_arm_stats;`,
  `DELETE FROM x_recipes;`, `DELETE FROM x_ledger;`, `DELETE FROM x_fact_usage;`, `DELETE FROM x_health;`);

// フォロワー推移（20日で 8 → 250。1日あたり +2〜+25 のばらつき）
let followers = 8;
for (let d = 20; d >= 0; d--) {
  followers += 2 + ((d * 7) % 24);
  sql.push(`INSERT INTO x_account_daily (date, followers, following, tweet_count, fetched_at) VALUES ('${day(d)}', ${followers}, 30, ${30 - d}, ${Date.now()}) ON CONFLICT(date) DO UPDATE SET followers=excluded.followers;`);
}

// 30投稿（20日前〜1日前）。型ごとに実力差を作る: 数字絶滅型と問いかけ二択が強い
const strength = { 数字絶滅型: 3.0, 問いかけ二択: 2.2, 真実暴露型: 1.4, 誤解訂正型: 1.0, 保存版の知恵: 0.9, 舞台裏日常: 0.5 };
for (let i = 0; i < 30; i++) {
  const d = 20 - Math.floor(i * 0.66);
  const pattern = PATTERNS[i % PATTERNS.length];
  const hook = HOOKS[i % HOOKS.length];
  const slot = SLOTS[i % SLOTS.length];
  const format = FORMATS[i % FORMATS.length];
  const fact = FACTS[i % FACTS.length];
  const hour = slot === 'morning' ? 8 : 20;
  const tweetId = `9${String(100000000 + i)}`;
  const qid = `syn-${i}`;
  const base = strength[pattern] * (slot === 'evening' ? 1.3 : 1.0);
  const clicks = Math.round(base * 12 + (i % 5) * 3);
  const imps = Math.round(base * 900 + (i % 7) * 120);

  sql.push(`INSERT INTO x_queue (id, date, status, pattern, theme, body, lint_ok, posted_at, tweet_id, recipe_id, hook, fact_ids, slot, format, is_exploration, created_at, updated_at)
    VALUES ('${qid}', '${day(d)}', 'posted', '${pattern}', '合成', '合成データ${i}', 1, ${ts(d, hour)}, '${tweetId}', '${day(d)}-1', '${hook}', '["${fact}"]', '${slot}', '${format}', ${i % 7 === 0 ? 1 : 0}, ${Date.now()}, ${Date.now()})
    ON CONFLICT(id) DO UPDATE SET status='posted', tweet_id=excluded.tweet_id;`);
  sql.push(`INSERT INTO x_fact_usage (fact_id, queue_id, used_date) VALUES ('${fact}', '${qid}', '${day(d)}') ON CONFLICT DO NOTHING;`);

  // 3日分のスナップショット（累積で増える）
  for (let k = 0; k < 3 && d - k >= 0; k++) {
    const g = 1 + k * 0.35;
    sql.push(`INSERT INTO x_metrics (tweet_id, snap_date, text, created_ts, impressions, likes, replies, reposts, quotes, bookmarks, profile_clicks, link_clicks, fetched_at)
      VALUES ('${tweetId}', '${day(d - k)}', '合成${i}', ${ts(d, hour)}, ${Math.round(imps * g)}, ${Math.round(base * 20 * g)}, ${Math.round(base * 3 * g)}, ${Math.round(base * 2 * g)}, ${Math.round(base * 1 * g)}, ${Math.round(base * 2 * g)}, ${Math.round(clicks * g)}, 0, ${Date.now()})
      ON CONFLICT(tweet_id, snap_date) DO UPDATE SET impressions=excluded.impressions, profile_clicks=excluded.profile_clicks;`);
  }
}
// 今日の分のスナップショットも作る（I1を満たすため）
for (let i = 0; i < 30; i++) {
  const tweetId = `9${String(100000000 + i)}`;
  // 既に今日のスナップショットがある投稿（直近投稿）は重複するので IGNORE
  sql.push(`INSERT OR IGNORE INTO x_metrics (tweet_id, snap_date, text, created_ts, impressions, likes, replies, reposts, quotes, bookmarks, profile_clicks, link_clicks, fetched_at)
    SELECT '${tweetId}', '${day(0)}', text, created_ts, impressions, likes, replies, reposts, quotes, bookmarks, profile_clicks, link_clicks, ${Date.now()}
    FROM x_metrics WHERE tweet_id='${tweetId}' ORDER BY snap_date DESC LIMIT 1;`);
}

// 大量のSQLは --command だと取りこぼすので必ずファイル経由で流す
const tmp = join(appRoot, '.synthetic-seed.sql');
writeFileSync(tmp, sql.join('\n'), 'utf8');
try {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'ci_zukou', '--local', '--file', tmp],
    { cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(out.split('\n').filter((l) => /executed|error/i.test(l)).join('\n'));
} finally {
  unlinkSync(tmp);
}
console.log('合成データ: 30投稿・21日分のフォロワー推移を投入');
