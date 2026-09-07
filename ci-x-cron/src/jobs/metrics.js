// 直近14日の自投稿を x_metrics にスナップショットし、x_queue の未突合行をtweet_idで自動突合する
import { getUserTweets } from '../xapi.js';
import { extractMetricRow, matchQueueToTweet } from '../extract.js';
import { jstDateString, logGuard, addReads, getSetting } from '../util.js';

export async function runMetrics(env) {
  if (env.DRY_RUN === '1') {
    await logGuard(env, 'worker', 'metrics', 'ok', 'DRY_RUN: GET /2/users/:id/tweets(直近14日) を呼ぶ予定だった');
    return { skipped: true, reads: 0 };
  }

  const selfId = await getSetting(env, 'self_user_id');
  if (!selfId) {
    await logGuard(env, 'worker', 'metrics', 'error', 'self_user_id 未設定。先に self ジョブが必要');
    return { skipped: true, reads: 0, error: 'no self_user_id' };
  }

  const { data: tweets, readCount } = await getUserTweets(env, selfId, { maxResults: 100, sinceDays: 14 });
  await addReads(env, readCount);

  const snapDate = jstDateString();
  const fetchedAt = Date.now();
  if (tweets.length) {
    const stmt = env.DB.prepare(
      `INSERT INTO x_metrics
         (tweet_id, snap_date, text, created_ts, impressions, likes, replies, reposts, quotes, bookmarks, profile_clicks, link_clicks, fetched_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
       ON CONFLICT(tweet_id, snap_date) DO UPDATE SET
         text = excluded.text,
         created_ts = excluded.created_ts,
         impressions = excluded.impressions,
         likes = excluded.likes,
         replies = excluded.replies,
         reposts = excluded.reposts,
         quotes = excluded.quotes,
         bookmarks = excluded.bookmarks,
         profile_clicks = excluded.profile_clicks,
         link_clicks = excluded.link_clicks,
         fetched_at = excluded.fetched_at`
    );
    const batch = tweets.map((t) => {
      const r = extractMetricRow(t, snapDate, fetchedAt);
      return stmt.bind(
        r.tweet_id,
        r.snap_date,
        r.text,
        r.created_ts,
        r.impressions,
        r.likes,
        r.replies,
        r.reposts,
        r.quotes,
        r.bookmarks,
        r.profile_clicks,
        r.link_clicks,
        r.fetched_at
      );
    });
    await env.DB.batch(batch);
  }

  const reconciled = await reconcileQueue(env, tweets);

  await logGuard(env, 'worker', 'metrics', 'ok', `tweets=${tweets.length} reconciled=${reconciled}`);
  return { skipped: false, reads: readCount, tweets: tweets.length, reconciled };
}

async function reconcileQueue(env, tweets) {
  if (!tweets.length) return 0;
  const { results: pending } = await env.DB.prepare(
    `SELECT id, body FROM x_queue WHERE (tweet_id IS NULL OR tweet_id = '') AND status != 'killed'`
  ).all();
  if (!pending.length) return 0;

  let matched = 0;
  const now = Date.now();
  for (const row of pending) {
    const hit = matchQueueToTweet(row.body, tweets);
    if (!hit) continue;
    await env.DB.prepare(
      `UPDATE x_queue SET tweet_id = ?1, status = 'posted', posted_at = ?2, updated_at = ?2 WHERE id = ?3`
    )
      .bind(hit.id, now, row.id)
      .run();
    matched++;
  }
  return matched;
}
