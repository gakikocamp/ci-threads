// 「今日の推奨投稿」同期API — D1 (ci_zukou / daily_recommendation テーブル)
// GET  /api/daily : 最新1件を返す（?date=YYYY-MM-DD 指定時はその日の1件）。アプリのレビュー画面最上部に表示する
// POST /api/daily : 生成された推奨投稿を1件アップサート保存する（id=date）
const SYNC_KEY = 'ci-threads-sync-v1'; // 簡易ボット避け（クライアントに埋め込むため秘密ではない）

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const date = url.searchParams.get('date');

  const base = `SELECT id, date, mode, pattern, theme, body, reply, tag, confidence, rationale, insight_summary, created_at, updated_at
     FROM daily_recommendation`;

  const stmt = date
    ? env.DB.prepare(`${base} WHERE date = ?1 LIMIT 1`).bind(date)
    : env.DB.prepare(`${base} ORDER BY date DESC LIMIT 1`);

  const { results } = await stmt.all();
  return Response.json({ ok: true, rec: results[0] || null });
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
  const date = str(payload.date, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ ok: false, error: 'invalid date' }, { status: 400 });
  }
  const id = date; // idは日付そのもの
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO daily_recommendation (id, date, mode, pattern, theme, body, reply, tag, confidence, rationale, insight_summary, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT(id) DO UPDATE SET
       date = excluded.date,
       mode = excluded.mode,
       pattern = excluded.pattern,
       theme = excluded.theme,
       body = excluded.body,
       reply = excluded.reply,
       tag = excluded.tag,
       confidence = excluded.confidence,
       rationale = excluded.rationale,
       insight_summary = excluded.insight_summary,
       updated_at = excluded.updated_at`
  ).bind(
    id,
    date,
    str(payload.mode),
    str(payload.pattern),
    str(payload.theme),
    str(payload.body, 2000),
    str(payload.reply, 1000),
    str(payload.tag),
    confVal(payload.confidence),
    str(payload.rationale, 1000),
    str(payload.insight_summary, 1000),
    now,
    now
  ).run();
  // ↑ created_atはON CONFLICTのSET対象外なので、初回INSERT時の値が以後も保持される

  return Response.json({ ok: true, id });
}

function str(v, max = 300) { return typeof v === 'string' ? v.slice(0, max) : null; }
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function confVal(v) {
  const n = num(v);
  return (n !== null && Number.isInteger(n) && n >= 0 && n <= 100) ? n : null;
}
