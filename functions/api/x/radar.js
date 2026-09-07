// 成長レーダー
// GET  /api/x/radar            : 最新スナップショットのランキング（監視リスト結合）＋上位の投稿
// POST /api/x/radar (x-admin-token) : 監視リストの追加/更新 {handle, label?, cluster?, active?, notes?}
import { isAdmin, forbidden, logGuard, str } from './_auth.js';

export async function onRequestGet({ env }) {
  const latest = await env.DB.prepare('SELECT MAX(snap_date) AS d FROM x_radar').first();
  const snap = latest?.d || null;
  const ranking = snap
    ? (await env.DB.prepare(
        `SELECT r.handle, w.label, w.cluster, r.followers, r.tweet_count, r.delta7, r.growth7, r.rank, r.snap_date
           FROM x_radar r LEFT JOIN x_watchlist w ON w.handle = r.handle
          WHERE r.snap_date = ?1 ORDER BY (r.rank IS NULL), r.rank ASC, r.followers DESC`
      ).bind(snap).all()).results
    : [];
  const watchlist = (await env.DB.prepare('SELECT handle, label, cluster, active, notes, added_at FROM x_watchlist ORDER BY added_at DESC').all()).results;
  const posts = (await env.DB.prepare(
    'SELECT tweet_id, handle, text, created_ts, likes, replies, reposts, quotes, impressions, has_media, pattern_tags FROM x_radar_posts ORDER BY created_ts DESC LIMIT 60'
  ).all()).results;
  return Response.json({ ok: true, snap_date: snap, ranking, watchlist, posts });
}

export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return forbidden();
  let p;
  try { p = await request.json(); } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }); }
  const handle = String(p.handle || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) return Response.json({ ok: false, error: 'invalid handle' }, { status: 400 });
  const active = p.active === 0 || p.active === false ? 0 : 1;
  await env.DB.prepare(
    `INSERT INTO x_watchlist (handle, label, cluster, active, notes, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(handle) DO UPDATE SET label = COALESCE(excluded.label, x_watchlist.label), cluster = COALESCE(excluded.cluster, x_watchlist.cluster),
       active = excluded.active, notes = COALESCE(excluded.notes, x_watchlist.notes)`
  ).bind(handle, str(p.label, 100), str(p.cluster, 40), active, str(p.notes, 500), Date.now()).run();
  await logGuard(env, { actor: 'human', action: 'radar', target: handle, result: 'ok', detail: { active, cluster: str(p.cluster, 40) } });
  return Response.json({ ok: true, handle, active });
}
