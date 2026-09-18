// フォロワー数の日次記録。成功判定の主指標（❤ではなくフォロワー増で勝ち型を決める）
// GET  /api/followers?brand=ci&handle=crystal_insence&days=30
// POST /api/followers  { counts: [{ brand, handle, date, followers, note }] }  … deltaは前回記録から自動計算
const SYNC_KEY = 'ci-threads-sync-v1';

function str(v, max = 200) { return typeof v === 'string' ? v.slice(0, max) : null; }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null; }

export async function onRequestGet({ request, env }) {
  if (request.headers.get('x-sync-key') !== SYNC_KEY) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  const url = new URL(request.url);
  const brand = url.searchParams.get('brand');
  const handle = url.searchParams.get('handle');
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 365);
  const where = [];
  const binds = [];
  if (brand) { binds.push(brand); where.push(`brand = ?${binds.length}`); }
  if (handle) { binds.push(handle); where.push(`handle = ?${binds.length}`); }
  binds.push(days);
  const sql = `SELECT id, brand, handle, date, followers, delta, note, updated_at
               FROM follower_counts
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY date DESC LIMIT ?${binds.length}`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return Response.json({ ok: true, count: results.length, counts: results });
}

export async function onRequestPost({ request, env }) {
  if (request.headers.get('x-sync-key') !== SYNC_KEY) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  let payload;
  try { payload = await request.json(); } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }); }
  const counts = Array.isArray(payload.counts) ? payload.counts.slice(0, 50) : [];
  if (counts.length === 0) return Response.json({ ok: true, saved: 0 });

  const now = Date.now();
  const saved = [];
  for (const c of counts) {
    const handle = str(c.handle, 80);
    const date = str(c.date, 10);
    const followers = num(c.followers);
    if (!handle || !date || followers === null) continue;
    // 直前の記録（同じhandleでdateがそれより前の最新）からdeltaを出す
    const prev = await env.DB.prepare(
      `SELECT followers FROM follower_counts WHERE handle = ?1 AND date < ?2 ORDER BY date DESC LIMIT 1`
    ).bind(handle, date).first();
    const delta = prev ? followers - prev.followers : null;
    await env.DB.prepare(
      `INSERT INTO follower_counts (id, brand, handle, date, followers, delta, note, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(id) DO UPDATE SET
         followers = excluded.followers,
         delta = excluded.delta,
         note = COALESCE(excluded.note, follower_counts.note),
         updated_at = excluded.updated_at`
    ).bind(`${handle}:${date}`, str(c.brand, 40) || 'ci', handle, date, followers, delta, str(c.note, 300), now).run();
    saved.push({ handle, date, followers, delta });
  }
  return Response.json({ ok: true, saved: saved.length, counts: saved });
}
