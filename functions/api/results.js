// 投稿結果の同期API — D1 (ci_zukou / threads_results テーブル)
// GET  /api/results : 全結果を返す（週次生成スクリプトが学習データとして読む）
// POST /api/results : アプリ(localStorage)から結果をアップサート同期する
const SYNC_KEY = 'ci-threads-sync-v1'; // 簡易ボット避け（クライアントに埋め込むため秘密ではない）

export async function onRequestGet(context) {
  const { results } = await context.env.DB.prepare(
    `SELECT id, batch_id, pattern, theme, tag, body, cta, posted_at, result, updated_at,
            replies, reposts, posted_hour, has_image
     FROM threads_results ORDER BY posted_at DESC LIMIT 1000`
  ).all();
  return Response.json({ ok: true, count: results.length, posts: results });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (request.headers.get('x-sync-key') !== SYNC_KEY) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'bad json' }, { status: 400 });
  }
  const posts = Array.isArray(payload.posts) ? payload.posts.slice(0, 500) : [];
  if (posts.length === 0) return Response.json({ ok: true, saved: 0 });

  const now = Date.now();
  const stmt = env.DB.prepare(
    `INSERT INTO threads_results (id, batch_id, pattern, theme, tag, body, cta, posted_at, result, updated_at,
                                  replies, reposts, posted_hour, has_image)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
     ON CONFLICT(id) DO UPDATE SET
       result = excluded.result,
       posted_at = excluded.posted_at,
       updated_at = excluded.updated_at,
       replies = COALESCE(excluded.replies, threads_results.replies),
       reposts = COALESCE(excluded.reposts, threads_results.reposts),
       posted_hour = COALESCE(excluded.posted_hour, threads_results.posted_hour),
       has_image = COALESCE(excluded.has_image, threads_results.has_image)`
  );
  const batch = posts
    .filter(p => p && typeof p.id === 'string' && p.id.length > 0 && p.id.length < 64)
    .map(p => stmt.bind(
      p.id,
      str(p.batchId), str(p.pattern), str(p.theme), str(p.tag),
      str(p.body, 2000),
      p.cta ? 1 : 0,
      num(p.postedAt),
      resultVal(p.result),
      now,
      num(p.replies),
      num(p.reposts),
      num(p.postedHour),
      p.hasImage === true ? 1 : (p.hasImage === false ? 0 : null)
    ));
  if (batch.length > 0) await env.DB.batch(batch);
  return Response.json({ ok: true, saved: batch.length });
}

function str(v, max = 300) { return typeof v === 'string' ? v.slice(0, max) : null; }
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function resultVal(v) { return ['buzz', 'ok', 'miss'].includes(v) ? v : null; }
