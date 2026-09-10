// 自アカウント(/2/users/me)のフォロワー数等を x_account_daily に記録し、user idを設定にキャッシュする
import { getMe } from '../xapi.js';
import { jstDateString, logGuard, addReads, setSetting, getSetting } from '../util.js';

export async function runSelf(env) {
  // X API未契約のあいだは呼ばない（成績はアプリから手入力される）
  if ((await getSetting(env, 'x_api_enabled')) !== '1' && env.X_API_ENABLED !== '1') {
    await logGuard(env, 'worker', 'self', 'ok', 'X API未契約のため手入力モード（アプリの「結果を記録」から入る）');
    return { skipped: true, manual: true };
  }
  if (env.DRY_RUN === '1') {
    await logGuard(env, 'worker', 'self', 'ok', 'DRY_RUN: GET /2/users/me を呼ぶ予定だった');
    return { skipped: true, reads: 0 };
  }

  const { data, readCount } = await getMe(env);
  await addReads(env, readCount);
  if (!data) {
    await logGuard(env, 'worker', 'self', 'error', 'GET /2/users/me が空応答');
    return { skipped: false, reads: readCount, followers: null };
  }

  await setSetting(env, 'self_user_id', data.id);

  const pm = data.public_metrics || {};
  const date = jstDateString();
  await env.DB.prepare(
    `INSERT INTO x_account_daily (date, followers, following, tweet_count, fetched_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(date) DO UPDATE SET
       followers = excluded.followers,
       following = excluded.following,
       tweet_count = excluded.tweet_count,
       fetched_at = excluded.fetched_at`
  )
    .bind(date, pm.followers_count ?? null, pm.following_count ?? null, pm.tweet_count ?? null, Date.now())
    .run();

  await logGuard(env, 'worker', 'self', 'ok', `followers=${pm.followers_count ?? '?'}`);
  return { skipped: false, reads: readCount, followers: pm.followers_count ?? null };
}
