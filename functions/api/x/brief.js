// ブリーフ（朝3行／週次5行／月次）。生成ルーティンが書き、アプリが読む。
// GET  /api/x/brief?kind=daily|weekly|monthly&date=
// POST /api/x/brief (x-writer-key) {kind, date, text}
import { isWriter, forbidden, jstDate, str } from './_auth.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') || 'daily';
  const date = url.searchParams.get('date');
  const stmt = date
    ? env.DB.prepare('SELECT * FROM x_brief WHERE kind = ?1 AND date = ?2 LIMIT 1').bind(kind, date)
    : env.DB.prepare('SELECT * FROM x_brief WHERE kind = ?1 ORDER BY date DESC LIMIT 1').bind(kind);
  const brief = await stmt.first();
  return Response.json({ ok: true, kind, brief: brief || null });
}

export async function onRequestPost({ request, env }) {
  if (!isWriter(request, env)) return forbidden();
  let p;
  try { p = await request.json(); } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }); }
  const kind = ['daily', 'weekly', 'monthly'].includes(p.kind) ? p.kind : 'daily';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : jstDate();
  const text = str(p.text, 4000);
  if (!text) return Response.json({ ok: false, error: 'text required' }, { status: 400 });
  const id = `${kind}-${kind === 'monthly' ? date.slice(0, 7) : date}`;
  await env.DB.prepare(
    `INSERT INTO x_brief (id, kind, date, text, created_at) VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(id) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`
  ).bind(id, kind, date, text, Date.now()).run();
  return Response.json({ ok: true, id });
}
