// 人間の操作（x-admin-token）: 候補のステータス遷移。一方向のみ
//   draft → posted   (Phase A: 本人がXアプリからコピペ投稿した後に記録。tweet_id は任意)
//   draft → approved (Phase B: 承認箱。配信Workerが拾う)
//   draft/approved → killed（却下）
//   posted/killed からは動かせない
// POST /api/x/mark {id, status, tweet_id?, note?}
import { isAdmin, forbidden, logGuard, str, jstDate } from './_auth.js';

const ALLOWED = { draft: ['posted', 'approved', 'killed'], approved: ['posted', 'killed'], stock: ['posted'] };

export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return forbidden();
  let p;
  try { p = await request.json(); } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }); }
  const id = str(p.id, 40), next = str(p.status, 20);
  if (!id || !next) return Response.json({ ok: false, error: 'id/status required' }, { status: 400 });
  const row = await env.DB.prepare('SELECT status, lint_ok, fact_ids FROM x_queue WHERE id = ?1').bind(id).first();
  if (!row) return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  if (!(ALLOWED[row.status] || []).includes(next)) {
    return Response.json({ ok: false, error: `transition ${row.status} → ${next} not allowed` }, { status: 409 });
  }
  if ((next === 'posted' || next === 'approved') && row.lint_ok !== 1) {
    return Response.json({ ok: false, error: 'lint blocked' }, { status: 409 });
  }
  const now = Date.now();
  const tweetId = str(p.tweet_id, 40);
  await env.DB.prepare(
    `UPDATE x_queue SET status = ?2,
       posted_at = CASE WHEN ?2 = 'posted' THEN ?3 ELSE posted_at END,
       tweet_id = CASE WHEN ?4 IS NOT NULL THEN ?4 ELSE tweet_id END,
       approved_by = CASE WHEN ?2 IN ('approved','posted') THEN 'human' ELSE approved_by END,
       approved_at = CASE WHEN ?2 = 'approved' THEN ?3 ELSE approved_at END,
       updated_at = ?3
     WHERE id = ?1`
  ).bind(id, next, now, tweetId).run();
  // 投稿された時点で燃料の使用を記録する（14日休ませる制約の根拠になる）
  if (next === 'posted') {
    let fids = [];
    try { fids = JSON.parse(row.fact_ids || '[]'); } catch { fids = []; }
    const usedDate = jstDate(now);
    for (const fid of fids.slice(0, 3)) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO x_fact_usage (fact_id, queue_id, used_date) VALUES (?1, ?2, ?3)'
      ).bind(String(fid), id, usedDate).run();
    }
  }
  await logGuard(env, { actor: 'human', action: next === 'killed' ? 'kill' : next === 'posted' ? 'post' : 'approve', target: id, result: 'ok', detail: { from: row.status, tweet_id: tweetId, note: str(p.note, 300) } });
  return Response.json({ ok: true, id, status: next });
}
