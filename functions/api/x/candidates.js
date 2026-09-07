// 今日の候補（X）— D1 x_queue
// GET  /api/x/candidates?date=YYYY-MM-DD  : その日の候補（既定=今日JST）＋運用設定。BLOCKされた候補は返さない
// POST /api/x/candidates (x-writer-key) : 候補を最大5件upsert。全件サーバー側でリンター検査し、BLOCKは killed として保存（監査のため）
import { lint } from '../../../x/linter.js';
import { isWriter, forbidden, jstDate, logGuard, getSetting, str } from './_auth.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date') || jstDate();
  const { results } = await env.DB.prepare(
    `SELECT id, date, status, pattern, theme, body, reply, thread_json, tag, confidence, rationale, radar_ref, mode, lint_ok, lint_json, posted_at, tweet_id,
            recipe_id, hook, fact_ids, slot, format, is_exploration
       FROM x_queue WHERE date = ?1 AND status IN ('draft','approved','posted') ORDER BY confidence DESC, id ASC`
  ).bind(date).all();
  // 生成が飛んだ日でも投稿を切らさないための常備ストック
  const { results: stock } = await env.DB.prepare(
    `SELECT id, pattern, body, reply, thread_json, tag, hook, fact_ids, slot, format
       FROM x_queue WHERE status = 'stock' ORDER BY id ASC LIMIT 5`
  ).all();
  const [phase, paused, cadence] = await Promise.all([
    getSetting(env, 'phase', 'A'), getSetting(env, 'paused', '0'), getSetting(env, 'cadence_per_day', '2'),
  ]);
  return Response.json({ ok: true, date, phase, paused: paused === '1', cadence_per_day: parseInt(cadence, 10), candidates: results, stock });
}

export async function onRequestPost({ request, env }) {
  if (!isWriter(request, env)) return forbidden();
  let payload;
  try { payload = await request.json(); } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }); }
  const date = str(payload.date, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ ok: false, error: 'invalid date' }, { status: 400 });
  const list = Array.isArray(payload.candidates) ? payload.candidates.slice(0, 5) : [];
  if (!list.length) return Response.json({ ok: false, error: 'no candidates' }, { status: 400 });

  // 類似度検査の対象: 過去60日の自投稿候補（posted/approved）＋レーダーで集めた競合文面
  const since = jstDate(Date.now() - 60 * 86400 * 1000);
  const [own, radar] = await Promise.all([
    env.DB.prepare(`SELECT body FROM x_queue WHERE date >= ?1 AND status IN ('posted','approved')`).bind(since).all(),
    env.DB.prepare(`SELECT text FROM x_radar_posts ORDER BY fetched_at DESC LIMIT 200`).all(),
  ]);
  const history = [...own.results.map((r) => r.body), ...radar.results.map((r) => r.text)].filter(Boolean);
  const mode = str(payload.mode) === 'safety' ? 'safety' : 'buzz';
  const now = Date.now();
  const out = [];

  for (let i = 0; i < list.length; i++) {
    const c = list[i] || {};
    const body = str(c.body, 2000);
    if (!body) continue;
    const id = `${date}-${i + 1}`;
    const res = lint(body, { history });
    const replyRes = c.reply ? lint(String(c.reply).slice(0, 1000), { isReply: true }) : { ok: true, blocks: [], warns: [] };
    const ok = res.ok && replyRes.ok;
    const lintJson = JSON.stringify({ body: res, reply: c.reply ? replyRes : null });
    const status = ok ? 'draft' : 'killed';
    const factIds = Array.isArray(c.fact_ids) ? c.fact_ids.slice(0, 3).map((f) => String(f).slice(0, 60)) : [];
    await env.DB.prepare(
      `INSERT INTO x_queue (id, date, status, pattern, theme, body, reply, thread_json, tag, confidence, rationale, radar_ref, mode, lint_ok, lint_json,
                            recipe_id, hook, fact_ids, slot, format, is_exploration, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?22)
       ON CONFLICT(id) DO UPDATE SET
         status = CASE WHEN x_queue.status IN ('posted','approved') THEN x_queue.status ELSE excluded.status END,
         pattern = excluded.pattern, theme = excluded.theme, body = excluded.body, reply = excluded.reply, thread_json = excluded.thread_json,
         tag = excluded.tag, confidence = excluded.confidence, rationale = excluded.rationale, radar_ref = excluded.radar_ref, mode = excluded.mode,
         lint_ok = excluded.lint_ok, lint_json = excluded.lint_json,
         recipe_id = excluded.recipe_id, hook = excluded.hook, fact_ids = excluded.fact_ids, slot = excluded.slot,
         format = excluded.format, is_exploration = excluded.is_exploration, updated_at = excluded.updated_at`
    ).bind(
      id, date, status, str(c.pattern), str(c.theme), body, str(c.reply, 1000),
      Array.isArray(c.thread) ? JSON.stringify(c.thread.slice(0, 6).map((t) => String(t).slice(0, 600))) : null,
      str(c.tag), Number.isInteger(c.confidence) ? Math.max(0, Math.min(100, c.confidence)) : null,
      str(c.rationale, 1000), str(c.radar_ref, 300), mode, ok ? 1 : 0, lintJson,
      str(c.recipe_id, 40), str(c.hook, 60), JSON.stringify(factIds), str(c.slot, 20), str(c.format, 20),
      c.is_exploration ? 1 : 0, now
    ).run();
    // レシピと候補を紐付ける（どのレシピが実際に文章になったか）
    if (c.recipe_id) {
      await env.DB.prepare('UPDATE x_recipes SET used_queue_id = ?2 WHERE id = ?1').bind(str(c.recipe_id, 40), id).run();
    }
    // 投稿済み・承認済みの行を上書きしても status は保持される（一方向ステート）
    await logGuard(env, { actor: 'linter', action: 'lint', target: id, result: ok ? (res.warns.length ? 'warn' : 'ok') : 'block', detail: { blocks: res.blocks, warns: res.warns, replyBlocks: replyRes.blocks } });
    out.push({ id, status, ok, blocks: res.blocks, warns: res.warns, replyBlocks: replyRes.blocks, units: res.units });
  }
  await logGuard(env, { actor: 'claude', action: 'draft', target: date, result: 'ok', detail: { received: list.length, accepted: out.filter((o) => o.ok).length, mode } });
  return Response.json({ ok: true, date, results: out });
}
