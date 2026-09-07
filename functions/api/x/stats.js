// 成績と監査: GET /api/x/stats
//   account : 自アカウントの日次（直近30日）
//   patterns: 型別成績
//   log     : 監査ログ直近40件
//   recent  : 直近14日の自投稿の最新スナップショット（投稿別成績）
export async function onRequestGet({ env }) {
  const [account, patterns, log, recent] = await Promise.all([
    env.DB.prepare('SELECT date, followers, following, tweet_count FROM x_account_daily ORDER BY date DESC LIMIT 30').all(),
    env.DB.prepare('SELECT pattern, n, avg_impressions, avg_replies, avg_quotes, avg_profile_clicks, est_follows, updated_at FROM x_pattern_stats ORDER BY est_follows DESC').all(),
    env.DB.prepare('SELECT ts, actor, action, target, result, detail FROM guard_log ORDER BY ts DESC LIMIT 40').all(),
    env.DB.prepare(
      `SELECT m.tweet_id, m.text, m.created_ts, m.impressions, m.likes, m.replies, m.reposts, m.quotes, m.bookmarks, m.profile_clicks, q.pattern, q.id AS queue_id
         FROM x_metrics m
         JOIN (SELECT tweet_id, MAX(snap_date) AS d FROM x_metrics GROUP BY tweet_id) lat ON lat.tweet_id = m.tweet_id AND lat.d = m.snap_date
         LEFT JOIN x_queue q ON q.tweet_id = m.tweet_id
        ORDER BY m.created_ts DESC LIMIT 40`
    ).all(),
  ]);
  return Response.json({ ok: true, account: account.results, patterns: patterns.results, log: log.results, recent: recent.results });
}
