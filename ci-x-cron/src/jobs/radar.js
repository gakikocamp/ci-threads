// 監視アカウント(x_watchlist)のフォロワー数を日次記録し、7日成長率で順位付け。上位アカウントの投稿も収集する
import { getUsersByUsernames, getUsersByIds, getUserTweets } from '../xapi.js';
import { extractRadarPostRow, computeGrowth, rankByGrowth } from '../extract.js';
import { jstDateString, addDaysStr, logGuard, addReads, budgetRemaining, getSetting } from '../util.js';

export async function runRadar(env) {
  // v3（2026-09-08）: 他アカウントの監視は廃止。既定で無効。CEOが明示的に有効化しない限り走らない
  const enabled = await getSetting(env, 'radar_enabled');
  if (enabled !== '1') {
    await logGuard(env, 'worker', 'radar', 'ok', 'v3方針により無効（自社データのみで学習する）');
    return { disabled: true };
  }

  const { results: watchlist } = await env.DB.prepare(`SELECT * FROM x_watchlist WHERE active = 1`).all();
  if (!watchlist.length) {
    await logGuard(env, 'worker', 'radar', 'ok', 'watchlist空のためスキップ');
    return { watched: 0 };
  }

  if (env.DRY_RUN === '1') {
    await logGuard(
      env,
      'worker',
      'radar',
      'ok',
      `DRY_RUN: watchlist ${watchlist.length}件のフォロワー数取得＋上位投稿取得を呼ぶ予定だった`
    );
    return { skipped: true, watched: watchlist.length };
  }

  // user_id未解決のハンドルをusername lookupで埋める
  const missing = watchlist.filter((w) => !w.user_id);
  if (missing.length) {
    const { data: users, readCount } = await getUsersByUsernames(env, missing.map((w) => w.handle));
    await addReads(env, readCount);
    for (const u of users) {
      const w = missing.find((m) => m.handle.toLowerCase() === u.username.toLowerCase());
      if (w) {
        await env.DB.prepare(`UPDATE x_watchlist SET user_id = ?1 WHERE handle = ?2`).bind(u.id, w.handle).run();
        w.user_id = u.id;
      }
    }
  }

  const resolved = watchlist.filter((w) => w.user_id);
  if (!resolved.length) {
    await logGuard(env, 'worker', 'radar', 'warn', 'user_id未解決のためフォロワー取得スキップ');
    return { watched: watchlist.length, resolved: 0 };
  }

  // フォロワー数スナップショット
  const { data: users, readCount: userReads } = await getUsersByIds(env, resolved.map((w) => w.user_id));
  await addReads(env, userReads);

  const date = jstDateString();
  const now = Date.now();
  const snapStmt = env.DB.prepare(
    `INSERT INTO x_radar (handle, snap_date, followers, tweet_count, fetched_at)
     VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(handle, snap_date) DO UPDATE SET
       followers = excluded.followers, tweet_count = excluded.tweet_count, fetched_at = excluded.fetched_at`
  );
  const snapBatch = [];
  for (const u of users) {
    const w = resolved.find((x) => x.user_id === u.id);
    if (!w) continue;
    const pm = u.public_metrics || {};
    snapBatch.push(snapStmt.bind(w.handle, date, pm.followers_count ?? null, pm.tweet_count ?? null, now));
  }
  if (snapBatch.length) await env.DB.batch(snapBatch);

  // 7日成長率の算出とrank付け
  const growthInput = [];
  for (const w of resolved) {
    const today = await env.DB.prepare(`SELECT followers FROM x_radar WHERE handle = ?1 AND snap_date = ?2`)
      .bind(w.handle, date)
      .first();
    if (!today || today.followers == null) continue;
    const past = await findPastSnapshot(env, w.handle, date);
    const { delta7, growth7 } = computeGrowth(today.followers, past?.followers ?? null);
    growthInput.push({ handle: w.handle, user_id: w.user_id, delta7, growth7 });
  }
  const ranked = rankByGrowth(growthInput);

  if (ranked.length) {
    const updStmt = env.DB.prepare(
      `UPDATE x_radar SET delta7 = ?1, growth7 = ?2, rank = ?3 WHERE handle = ?4 AND snap_date = ?5`
    );
    await env.DB.batch(
      ranked.map((r) => updStmt.bind(r.delta7, r.growth7, r.rank, r.handle, date))
    );
  }

  // 上位RADAR_TOP_N件の直近投稿を取得（予算ガード付き）
  const topN = parseInt(env.RADAR_TOP_N || '10', 10);
  const postsPer = parseInt(env.RADAR_POSTS_PER || '5', 10);
  const top = ranked.slice(0, topN);

  let postsFetched = 0;
  let postReads = 0;
  for (const r of top) {
    const remaining = await budgetRemaining(env);
    if (remaining < postsPer) {
      await logGuard(
        env,
        'worker',
        'radar',
        'warn',
        `MAX_READS_PER_DAY残り${remaining}のため ${r.handle} 以降の投稿取得をスキップ`
      );
      break;
    }
    const { data: posts, readCount } = await getUserTweets(env, r.user_id, {
      maxResults: postsPer,
      sinceDays: 30,
    });
    await addReads(env, readCount);
    postReads += readCount;
    postsFetched += posts.length;

    if (posts.length) {
      const postStmt = env.DB.prepare(
        `INSERT INTO x_radar_posts
           (tweet_id, handle, text, created_ts, likes, replies, reposts, quotes, impressions, has_media, fetched_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(tweet_id) DO UPDATE SET
           text = excluded.text, created_ts = excluded.created_ts, likes = excluded.likes,
           replies = excluded.replies, reposts = excluded.reposts, quotes = excluded.quotes,
           impressions = excluded.impressions, has_media = excluded.has_media, fetched_at = excluded.fetched_at`
      );
      const batch = posts.map((p) => {
        const row = extractRadarPostRow(p, r.handle);
        return postStmt.bind(
          row.tweet_id,
          row.handle,
          row.text,
          row.created_ts,
          row.likes,
          row.replies,
          row.reposts,
          row.quotes,
          row.impressions,
          row.has_media,
          row.fetched_at
        );
      });
      await env.DB.batch(batch);
    }
  }

  await logGuard(
    env,
    'worker',
    'radar',
    'ok',
    `watched=${watchlist.length} resolved=${resolved.length} posts=${postsFetched}`
  );
  return {
    watched: watchlist.length,
    resolved: resolved.length,
    reads: userReads + postReads,
    postsFetched,
  };
}

// 7日前ちょうどのスナップショットを優先し、無ければ7日以内で最古のものを使う
async function findPastSnapshot(env, handle, todayDate) {
  const targetDate = addDaysStr(todayDate, -7);
  const exact = await env.DB.prepare(
    `SELECT followers FROM x_radar WHERE handle = ?1 AND snap_date = ?2 AND followers IS NOT NULL`
  )
    .bind(handle, targetDate)
    .first();
  if (exact) return exact;

  return env.DB.prepare(
    `SELECT followers FROM x_radar
     WHERE handle = ?1 AND snap_date > ?2 AND snap_date < ?3 AND followers IS NOT NULL
     ORDER BY snap_date ASC LIMIT 1`
  )
    .bind(handle, targetDate, todayDate)
    .first();
}
