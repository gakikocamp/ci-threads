// x_metricsの最新スナップショット×x_queue.patternを結合し、型ごとの平均成績を x_pattern_stats に反映する
import { aggregatePatternStats, computeConversionRate } from '../extract.js';
import { jstDateString, addDaysStr, logGuard, getSetting } from '../util.js';

export async function runPatterns(env) {
  // X API未契約のあいだは呼ばない（成績はアプリから手入力される）
  if ((await getSetting(env, 'x_api_enabled')) !== '1' && env.X_API_ENABLED !== '1') {
    await logGuard(env, 'worker', 'patterns', 'ok', 'X API未契約のため手入力モード（アプリの「結果を記録」から入る）');
    return { skipped: true, manual: true };
  }
  if (env.DRY_RUN === '1') {
    await logGuard(env, 'worker', 'patterns', 'ok', 'DRY_RUN: x_metrics/x_queue の集計のみ（API呼び出しなし）');
    return { skipped: true };
  }

  const { results: latestRows } = await env.DB.prepare(
    `SELECT m.impressions, m.replies, m.quotes, m.profile_clicks, q.pattern
     FROM x_metrics m
     JOIN (SELECT tweet_id, MAX(snap_date) AS max_date FROM x_metrics GROUP BY tweet_id) latest
       ON m.tweet_id = latest.tweet_id AND m.snap_date = latest.max_date
     JOIN x_queue q ON q.tweet_id = m.tweet_id
     WHERE q.pattern IS NOT NULL AND q.pattern != ''`
  ).all();

  const stats = aggregatePatternStats(latestRows);
  const conversionRate = await computeConversionRateFromDb(env);

  const now = Date.now();
  const entries = Object.entries(stats);
  if (entries.length) {
    const stmt = env.DB.prepare(
      `INSERT INTO x_pattern_stats
         (pattern, n, avg_impressions, avg_replies, avg_quotes, avg_profile_clicks, est_follows, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
       ON CONFLICT(pattern) DO UPDATE SET
         n = excluded.n,
         avg_impressions = excluded.avg_impressions,
         avg_replies = excluded.avg_replies,
         avg_quotes = excluded.avg_quotes,
         avg_profile_clicks = excluded.avg_profile_clicks,
         est_follows = excluded.est_follows,
         updated_at = excluded.updated_at`
    );
    const batch = entries.map(([pattern, s]) =>
      stmt.bind(
        pattern,
        s.n,
        s.avg_impressions,
        s.avg_replies,
        s.avg_quotes,
        s.avg_profile_clicks,
        s.avg_profile_clicks * conversionRate,
        now
      )
    );
    await env.DB.batch(batch);
  }

  await logGuard(env, 'worker', 'patterns', 'ok', `patterns=${entries.length} conv=${conversionRate.toFixed(4)}`);
  return { skipped: false, patterns: entries.length, conversionRate };
}

async function computeConversionRateFromDb(env) {
  const today = jstDateString();
  const since = addDaysStr(today, -14);

  const { results: dailyRows } = await env.DB.prepare(
    `SELECT date, followers FROM x_account_daily WHERE date >= ?1 AND followers IS NOT NULL ORDER BY date ASC`
  )
    .bind(since)
    .all();
  const netGrowth =
    dailyRows.length >= 2 ? dailyRows[dailyRows.length - 1].followers - dailyRows[0].followers : 0;

  const clicksRow = await env.DB.prepare(
    `SELECT SUM(profile_clicks) AS total FROM x_metrics WHERE snap_date >= ?1`
  )
    .bind(since)
    .first();
  const totalClicks = clicksRow?.total || 0;

  return computeConversionRate(netGrowth, totalClicks);
}
