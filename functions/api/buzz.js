// 国産バズ・ライブラリの同期API — D1 (ci_zukou / buzz_library テーブル)
// GET  /api/buzz : ライブラリ全件を返す（?tag=xxx でタグ絞り込み）。週次生成スクリプトも学習データとして読む
// POST /api/buzz : アプリ(localStorage)から収集した投稿をアップサート同期する
const SYNC_KEY = 'ci-threads-sync-v1'; // 簡易ボット避け（クライアントに埋め込むため秘密ではない）

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const tag = url.searchParams.get('tag');

  const base = `SELECT id, url, author, tag, body, likes, replies, reposts, hook_type, pattern, why_buzz, source, collected_at, updated_at
     FROM buzz_library`;

  const stmt = tag
    ? env.DB.prepare(`${base} WHERE tag = ?1 ORDER BY likes DESC LIMIT 500`).bind(tag)
    : env.DB.prepare(`${base} ORDER BY likes DESC LIMIT 500`);

  const { results } = await stmt.all();
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
    `INSERT INTO buzz_library (id, url, author, tag, body, likes, replies, reposts, hook_type, pattern, why_buzz, source, collected_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
     ON CONFLICT(id) DO UPDATE SET
       likes = excluded.likes,
       replies = excluded.replies,
       reposts = excluded.reposts,
       hook_type = excluded.hook_type,
       pattern = excluded.pattern,
       why_buzz = excluded.why_buzz,
       tag = excluded.tag,
       updated_at = excluded.updated_at`
  );
  const batch = posts
    .filter(p => p && typeof p.id === 'string' && p.id.length > 0 && p.id.length <= 128)
    .map(p => stmt.bind(
      p.id,
      str(p.url),
      str(p.author),
      str(p.tag),
      str(p.body, 2000),
      num(p.likes),
      num(p.replies),
      num(p.reposts),
      str(p.hookType),
      str(p.pattern),
      str(p.whyBuzz, 500),
      str(p.source),
      num(p.collectedAt) ?? now,
      now
    ));
  if (batch.length > 0) await env.DB.batch(batch);
  return Response.json({ ok: true, saved: batch.length });
}

function str(v, max = 300) { return typeof v === 'string' ? v.slice(0, max) : null; }
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
