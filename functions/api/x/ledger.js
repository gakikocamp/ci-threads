// 学習台帳 — 毎日1行以上の「学び」。増え続けることが賢くなった証拠。
// GET /api/x/ledger?days=7&kind=learn
import { jstDate } from './_auth.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10)));
  const kind = url.searchParams.get('kind');
  const since = new Date(Date.parse(`${jstDate()}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);

  const base = 'SELECT date, kind, text, evidence, created_at FROM x_ledger WHERE date >= ?1';
  const stmt = kind
    ? env.DB.prepare(`${base} AND kind = ?2 ORDER BY date DESC, id DESC LIMIT 200`).bind(since, kind)
    : env.DB.prepare(`${base} ORDER BY date DESC, id DESC LIMIT 200`).bind(since);
  const { results } = await stmt.all();

  // 健康状態（不変条件）も一緒に返す。連続成立日数が「稼働」の指標
  const { results: health } = await env.DB.prepare(
    'SELECT date, all_ok, improved, detail FROM x_health WHERE date >= ?1 ORDER BY date DESC'
  ).bind(since).all();
  let streak = 0;
  for (const h of health) { if (h.all_ok) streak++; else break; }

  return Response.json({ ok: true, since, ledger: results, health, healthy_streak: streak });
}
