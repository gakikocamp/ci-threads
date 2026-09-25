// フォロワー数の保存処理（/api/followers と /api/daily の両方から使う）

// 1アカウントのブランドだけ、報告文から「フォロワーN人」を拾ってよい（CIは2アカウントあるので拾わない）
export const MAIN_HANDLE = {
  'startup-kyushu': 'startupkyushu',
  karen: 'konnichiwa.karen',
  vantrip: 'vantripjapan'
};

// 例: 「フォロワー1,594人（前日…」「フォロワー @startupkyushu 122（前日…」「@vantripjapan フォロワー0人」
export function parseFollowers(text) {
  if (typeof text !== 'string' || /フォロワー\s*未取得/.test(text)) return null;
  const m = text.match(/フォロワー[:：]?\s*(?:@[A-Za-z0-9._]+\s*)?([\d,]+)\s*人?/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) && n >= 0 && n < 10000000 ? n : null;
}

// 前回の記録から delta を計算して upsert する
export async function upsertFollower(env, { brand, handle, date, followers, note }) {
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
  ).bind(`${handle}:${date}`, brand, handle, date, followers, delta, note || null, Date.now()).run();
  return { handle, date, followers, delta };
}
