// 燃料（一次情報）の在庫。14日以内に使ったものは available=false で返す。
// 生成は available な燃料だけを使う。在庫外の事実・数字・固有名詞は書けない（リンターが止める）。
// GET /api/x/facts
import inventory from '../../../guardrails/fact-inventory.json';
import { jstDate } from './_auth.js';

export async function onRequestGet({ env }) {
  const today = jstDate();
  const { results: used } = await env.DB.prepare(
    'SELECT fact_id, MAX(used_date) AS last FROM x_fact_usage GROUP BY fact_id'
  ).all();
  const lastUsed = Object.fromEntries(used.map((u) => [u.fact_id, u.last]));
  const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

  const facts = inventory.facts.map((f) => {
    const last = lastUsed[f.id] || null;
    const rest = last ? days(last, today) : null;
    return { ...f, last_used: last, available: !last || rest >= 14, days_since_use: rest };
  });
  return Response.json({ ok: true, version: inventory.version, rules: inventory.rules, facts });
}
