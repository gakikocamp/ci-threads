// X API v2 のレスポンスをD1の行に変換する純粋関数群。D1/fetchに依存しないのでユニットテストしやすい

// tweetオブジェクト → x_metrics 1行分
// impressions/profile_clicks/link_clicks は non_public_metrics を優先し、organic_metrics→public_metrics の順にフォールバック
// （アクセスレベルによって non_public_metrics が返らない場合があるための保険。likes/replies/quotes/repostsは常にpublic_metrics）
// 返信かどうか。referenced_tweets に replied_to があるか、in_reply_to_user_id があれば返信。
// 自分のスレッド（自分への返信）は「返信」ではなく本人の連投なので original 扱いにする。
export function classifyKind(tweet, selfUserId = null) {
  const refs = Array.isArray(tweet.referenced_tweets) ? tweet.referenced_tweets : [];
  const isReplyRef = refs.some((r) => r.type === 'replied_to');
  const target = tweet.in_reply_to_user_id || null;
  if (!isReplyRef && !target) return 'original';
  if (selfUserId && target && String(target) === String(selfUserId)) return 'original'; // 自分へのスレッド
  return 'reply';
}

export function extractMetricRow(tweet, snapDate, fetchedAt = Date.now(), selfUserId = null) {
  const pm = tweet.public_metrics || {};
  const npm = tweet.non_public_metrics || {};
  const om = tweet.organic_metrics || {};
  return {
    kind: classifyKind(tweet, selfUserId),
    conversation_id: tweet.conversation_id ?? null,
    tweet_id: tweet.id,
    snap_date: snapDate,
    text: tweet.text ?? null,
    created_ts: tweet.created_at ? Date.parse(tweet.created_at) : null,
    impressions: npm.impression_count ?? om.impression_count ?? pm.impression_count ?? null,
    likes: pm.like_count ?? null,
    replies: pm.reply_count ?? null,
    reposts: pm.retweet_count ?? null,
    quotes: pm.quote_count ?? null,
    bookmarks: pm.bookmark_count ?? null,
    profile_clicks: npm.user_profile_clicks ?? om.user_profile_clicks ?? null,
    link_clicks: npm.url_link_clicks ?? om.url_link_clicks ?? null,
    fetched_at: fetchedAt,
  };
}

// tweetオブジェクト(監視アカウント投稿) → x_radar_posts 1行分
export function extractRadarPostRow(tweet, handle, fetchedAt = Date.now()) {
  const pm = tweet.public_metrics || {};
  const hasMedia = Array.isArray(tweet.attachments?.media_keys) && tweet.attachments.media_keys.length > 0;
  return {
    tweet_id: tweet.id,
    handle,
    text: tweet.text ?? null,
    created_ts: tweet.created_at ? Date.parse(tweet.created_at) : null,
    likes: pm.like_count ?? null,
    replies: pm.reply_count ?? null,
    reposts: pm.retweet_count ?? null,
    quotes: pm.quote_count ?? null,
    impressions: pm.impression_count ?? null,
    has_media: hasMedia ? 1 : 0,
    fetched_at: fetchedAt,
  };
}

// x_queue の未突合行に対し、本文先頭30文字が一致するtweetを探す（Phase Aの手動投稿の自動突合）
export function matchQueueToTweet(queueBody, tweets, prefixLen = 30) {
  const prefix = (queueBody || '').slice(0, prefixLen);
  if (!prefix) return null;
  return tweets.find((t) => (t.text || '').slice(0, prefixLen) === prefix) || null;
}

// 型ごとの最新スナップショット行から n/平均値を集計する
export function aggregatePatternStats(rows) {
  const groups = {};
  for (const row of rows) {
    if (!row.pattern) continue;
    (groups[row.pattern] ||= []).push(row);
  }
  const avg = (list, key) => list.reduce((s, r) => s + (Number(r[key]) || 0), 0) / list.length;
  const out = {};
  for (const [pattern, list] of Object.entries(groups)) {
    out[pattern] = {
      n: list.length,
      avg_impressions: avg(list, 'impressions'),
      avg_replies: avg(list, 'replies'),
      avg_quotes: avg(list, 'quotes'),
      avg_profile_clicks: avg(list, 'profile_clicks'),
    };
  }
  return out;
}

// 転換率 = 直近14日のフォロワー純増合計 ÷ 同期間のプロフクリック合計。分母0なら既定値0.3
export function computeConversionRate(netFollowerGrowth, totalProfileClicks, fallback = 0.3) {
  if (!totalProfileClicks) return fallback;
  return netFollowerGrowth / totalProfileClicks;
}

// x_radar: 当日と7日前(なければ7日以内で最古)のフォロワー数からdelta7/growth7を算出
export function computeGrowth(todayFollowers, pastFollowers) {
  if (todayFollowers == null || pastFollowers == null) return { delta7: null, growth7: null };
  const delta7 = todayFollowers - pastFollowers;
  const growth7 = pastFollowers > 0 ? delta7 / pastFollowers : null;
  return { delta7, growth7 };
}

// growth7降順でrank(1始まり)を付与。growth7がnullのものは最後尾に回す
export function rankByGrowth(rows) {
  const sorted = [...rows].sort((a, b) => {
    const ag = a.growth7 ?? -Infinity;
    const bg = b.growth7 ?? -Infinity;
    return bg - ag;
  });
  return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
}
