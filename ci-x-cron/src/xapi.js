// X API v2 読み取り専用クライアント。書き込み系エンドポイント（投稿・いいね・フォロー等）は実装しない。
// OAuth 1.0a ユーザーコンテキストで署名する（non_public_metrics / organic_metrics の取得に必須）
import { buildAuthHeader } from './oauth1.js';

const BASE = 'https://api.x.com/2';

export class XApiError extends Error {
  constructor(status, body, url) {
    super(`X API error ${status} (${url}): ${body}`);
    this.name = 'XApiError';
    this.status = status;
    this.body = body;
  }
}

async function authedGet(env, url) {
  const authHeader = await buildAuthHeader({
    method: 'GET',
    url,
    consumerKey: env.X_API_KEY,
    consumerSecret: env.X_API_SECRET,
    token: env.X_ACCESS_TOKEN,
    tokenSecret: env.X_ACCESS_SECRET,
  });
  const res = await fetch(url, { headers: { Authorization: authHeader } });
  const bodyText = await res.text();
  // 401/403/429 はリトライしない: 凍結予兆やレート制限下でAPIを叩き続けるのを避け、次回cronに委ねる
  if (!res.ok) {
    throw new XApiError(res.status, bodyText.slice(0, 500), url);
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new XApiError(res.status, `invalid json: ${bodyText.slice(0, 200)}`, url);
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// GET /2/users/me — 自アカウント情報（フォロワー数含む）
export async function getMe(env) {
  const url = `${BASE}/users/me?user.fields=public_metrics,username`;
  const json = await authedGet(env, url);
  const data = json.data || null;
  return { data, readCount: data ? 1 : 0 };
}

// GET /2/users/:id/tweets — 自分/監視対象の直近投稿。exclude=retweets でRT除外
// excludeReplies=true にすると返信も除外する。返信を1日15件出すと100件枠が6日分で埋まり、
// 学習が成績を確定する7日目より前にオリジナル投稿が計測の窓から押し出されるため、
// オリジナルは必ず別枠で取り切る（metrics.js が2回に分けて呼ぶ）。
export async function getUserTweets(env, userId, { maxResults = 100, sinceDays = 14, excludeReplies = false } = {}) {
  const startTime = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  // referenced_tweets / in_reply_to_user_id は「返信かどうか」の判定に使う（返信の効果を分けて測るため）
  const fields =
    'tweet.fields=created_at,public_metrics,non_public_metrics,organic_metrics,attachments,referenced_tweets,in_reply_to_user_id,conversation_id';
  // X API v2 の max_results は 5〜100 の範囲制約があるため下限をクランプする（RADAR_POSTS_PERを5未満にすると本来はAPI側で400になる）
  const pageSize = Math.min(100, Math.max(5, maxResults));
  const exclude = excludeReplies ? 'retweets,replies' : 'retweets';
  let url =
    `${BASE}/users/${userId}/tweets?${fields}&exclude=${exclude}` +
    `&start_time=${encodeURIComponent(startTime)}&max_results=${pageSize}`;

  const collected = [];
  let nextToken = null;
  do {
    const pageUrl = nextToken ? `${url}&pagination_token=${encodeURIComponent(nextToken)}` : url;
    const json = await authedGet(env, pageUrl);
    const page = json.data || [];
    collected.push(...page);
    nextToken = json.meta?.next_token || null;
  } while (nextToken && collected.length < maxResults);

  const data = collected.slice(0, maxResults);
  return { data, readCount: data.length };
}

// GET /2/users/by?usernames=... — ハンドル→ユーザーID解決（初回のみ）。100件/回まで
export async function getUsersByUsernames(env, handles) {
  const clean = [...new Set(handles.map((h) => String(h).replace(/^@/, '').trim()).filter(Boolean))];
  const data = [];
  for (const group of chunk(clean, 100)) {
    const url = `${BASE}/users/by?usernames=${group.map(encodeURIComponent).join(',')}&user.fields=public_metrics`;
    const json = await authedGet(env, url);
    data.push(...(json.data || []));
  }
  return { data, readCount: data.length };
}

// GET /2/users?ids=... — フォロワー数取得。100件/回まで
export async function getUsersByIds(env, ids) {
  const clean = [...new Set(ids.filter(Boolean))];
  const data = [];
  for (const group of chunk(clean, 100)) {
    const url = `${BASE}/users?ids=${group.map(encodeURIComponent).join(',')}&user.fields=public_metrics`;
    const json = await authedGet(env, url);
    data.push(...(json.data || []));
  }
  return { data, readCount: data.length };
}
