// 手入力の結果記録（X APIを契約しない運用の要）。
// Xの投稿を開くと本人には無料でアナリティクスが見える。その数字をここに入れれば、
// 学習エンジンはAPI経由の計測とまったく同じように動く（読み取り元がWorkerか人かの違いだけ）。
// POST /api/x/results (x-admin-token)
//   { queue_id?, tweet_id?, impressions, likes, replies, reposts, quotes?, bookmarks?, profile_clicks, followers? }
import { isAdmin, forbidden, jstDate, logGuard, str } from './_auth.js';

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return forbidden();
  let p;
  try { p = await request.json(); } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }); }

  const today = jstDate();
  const now = Date.now();
  const out = {};

  // ① フォロワー数（毎日1回でよい。転換率の校正と帰属に使う）
  const followers = num(p.followers);
  if (followers !== null) {
    await env.DB.prepare(
      `INSERT INTO x_account_daily (date, followers, following, tweet_count, fetched_at)
       VALUES (?1, ?2, NULL, NULL, ?3)
       ON CONFLICT(date) DO UPDATE SET followers = excluded.followers, fetched_at = excluded.fetched_at`
    ).bind(today, followers, now).run();
    out.followers = followers;
  }

  // ② 投稿1本の成績
  const queueId = str(p.queue_id, 40);
  let tweetId = str(p.tweet_id, 40);
  if (queueId) {
    const row = await env.DB.prepare('SELECT tweet_id, body, posted_at FROM x_queue WHERE id = ?1').bind(queueId).first();
    if (!row) return Response.json({ ok: false, error: 'queue not found' }, { status: 404 });
    // 投稿IDが未登録なら、ここで入力された分を紐付ける（後の突合が要らなくなる）
    if (!tweetId) tweetId = row.tweet_id || `manual-${queueId}`;
    if (row.tweet_id !== tweetId) {
      await env.DB.prepare('UPDATE x_queue SET tweet_id = ?2, updated_at = ?3 WHERE id = ?1').bind(queueId, tweetId, now).run();
    }
    out.queue_id = queueId;
  }

  if (tweetId) {
    const impressions = num(p.impressions);
    if (impressions === null) return Response.json({ ok: false, error: 'impressions required' }, { status: 400 });
    const q = queueId
      ? await env.DB.prepare('SELECT body, posted_at FROM x_queue WHERE id = ?1').bind(queueId).first()
      : null;
    await env.DB.prepare(
      `INSERT INTO x_metrics
         (tweet_id, snap_date, text, created_ts, impressions, likes, replies, reposts, quotes, bookmarks, profile_clicks, link_clicks, fetched_at, kind, conversation_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL,?12,?13,NULL)
       ON CONFLICT(tweet_id, snap_date) DO UPDATE SET
         impressions = excluded.impressions, likes = excluded.likes, replies = excluded.replies,
         reposts = excluded.reposts, quotes = excluded.quotes, bookmarks = excluded.bookmarks,
         profile_clicks = excluded.profile_clicks, fetched_at = excluded.fetched_at, kind = excluded.kind`
    ).bind(
      tweetId, today, q?.body ? String(q.body).slice(0, 300) : null, q?.posted_at ?? null,
      impressions, num(p.likes) ?? 0, num(p.replies) ?? 0, num(p.reposts) ?? 0,
      num(p.quotes) ?? 0, num(p.bookmarks) ?? 0, num(p.profile_clicks) ?? 0,
      now, p.kind === 'reply' ? 'reply' : 'original'
    ).run();
    out.tweet_id = tweetId;
    out.impressions = impressions;
  }

  if (!out.followers && !out.tweet_id) {
    return Response.json({ ok: false, error: 'nothing to record' }, { status: 400 });
  }
  await logGuard(env, { actor: 'human', action: 'result', target: out.tweet_id || today, result: 'ok', detail: out });
  return Response.json({ ok: true, date: today, ...out });
}

// GET /api/x/results?date= : その日に記録済みの投稿ID一覧（UIの「記録済み」表示用）
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date') || jstDate();
  const { results } = await env.DB.prepare(
    'SELECT tweet_id, impressions, profile_clicks, kind FROM x_metrics WHERE snap_date = ?1'
  ).bind(date).all();
  const acct = await env.DB.prepare('SELECT followers FROM x_account_daily WHERE date = ?1').bind(date).first();
  return Response.json({ ok: true, date, recorded: results, followers: acct?.followers ?? null });
}
