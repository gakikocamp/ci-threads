// 「今日の推奨投稿」同期API — D1 (ci_zukou / daily_recommendation テーブル)
// GET  /api/daily : 最新1件を返す（?date=YYYY-MM-DD 指定時はその日の1件）。アプリのレビュー画面最上部に表示する
// POST /api/daily : 生成された推奨投稿を1件アップサート保存する（id=date）
//   candidates : 「今日の候補（バズ確度順・最大5本）」用のJSON配列（任意・後方互換のため無くても動く）
const SYNC_KEY = 'ci-threads-sync-v1'; // 簡易ボット避け（クライアントに埋め込むため秘密ではない）

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const date = url.searchParams.get('date');

  const base = `SELECT id, date, mode, pattern, theme, body, reply, tag, confidence, rationale, insight_summary, candidates, created_at, updated_at
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

  // candidates: 配列 or JSON文字列のどちらでも受理。妥当なものだけ最大5件・サニタイズしてJSON文字列で保存
  let rawCandidates = payload.candidates;
  if (typeof rawCandidates === 'string') {
    try { rawCandidates = JSON.parse(rawCandidates); } catch { rawCandidates = null; }
  }
  const candidates = sanitizeCandidates(rawCandidates);
  const candidatesJson = candidates ? JSON.stringify(candidates) : null;

  await env.DB.prepare(
    `INSERT INTO daily_recommendation (id, date, mode, pattern, theme, body, reply, tag, confidence, rationale, insight_summary, candidates, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
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
       candidates = excluded.candidates,
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
    candidatesJson,
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

// 「今日の候補」配列のサニタイズ：不正な入力ならnullを返し、安全モード（単一カード）にフォールバックさせる
function sanitizeCandidates(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const out = arr.slice(0, 5).map(c => {
    if (!c || typeof c !== 'object') return null;
    const body = str(c.body, 2000);
    if (!body) return null; // 本文が無い候補はカードとして描画できないため除外
    return {
      body,
      reply: str(c.reply, 1000),
      pattern: str(c.pattern, 300),
      theme: str(c.theme, 300),
      tag: str(c.tag, 300),
      confidence: confVal(c.confidence),
      rationale: str(c.rationale, 500)
    };
  }).filter(Boolean);
  return out.length > 0 ? out : null;
}
