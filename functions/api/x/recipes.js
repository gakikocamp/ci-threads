// 今日の実験レシピ（Workerが前夜に決めたもの）。生成ルーティンがこれを読んで文章だけ書く。
// GET /api/x/recipes?date=YYYY-MM-DD （既定=今日JST）
import { jstDate } from './_auth.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date') || jstDate();
  const { results } = await env.DB.prepare(
    `SELECT id, date, rank, pattern, hook, fact_ids, slot, format, is_exploration, rationale, constraint_ok, used_queue_id
       FROM x_recipes WHERE date = ?1 ORDER BY rank ASC`
  ).bind(date).all();
  const recipes = results.map((r) => ({ ...r, fact_ids: safeParse(r.fact_ids) }));
  const [cadence, slots, mode] = await Promise.all([
    setting(env, 'cadence_per_day', '2'), setting(env, 'slots', '{}'), setting(env, 'mode', 'buzz'),
  ]);
  return Response.json({ ok: true, date, cadence_per_day: parseInt(cadence, 10), slots: safeParse(slots, {}), mode, recipes });
}
const safeParse = (s, fb = []) => { try { return JSON.parse(s || ''); } catch { return fb; } };
async function setting(env, k, fb) {
  const r = await env.DB.prepare('SELECT value FROM x_settings WHERE key = ?1').bind(k).first();
  return r?.value ?? fb;
}
