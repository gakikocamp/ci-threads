// JST日付・監査ログ・API読み取り予算カウンタなど、ジョブ間で共有する小さなヘルパー群

// JST(UTC+9)の 'YYYY-MM-DD' を返す。cronは UTC18:00=JST03:00 に走るのでUTCのまま date() すると日付がずれる
export function jstDateString(d = new Date()) {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' に日数を加減算した 'YYYY-MM-DD' を返す（UTC基準の暦計算で十分。日付文字列の比較用途のみ）
export function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function logGuard(env, actor, action, result, detail, target = null) {
  await env.DB.prepare(
    `INSERT INTO guard_log (ts, actor, action, target, result, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(Date.now(), actor, action, target, result, detail ?? null)
    .run();
}

// x_settings.api_reads_today は 'YYYY-MM-DD:count' 形式の1行に集約する（日付が変われば自動リセット）
export async function getReadsToday(env) {
  const date = jstDateString();
  const row = await env.DB.prepare(`SELECT value FROM x_settings WHERE key = 'api_reads_today'`).first();
  if (!row || !row.value) return { date, count: 0 };
  const [d, c] = String(row.value).split(':');
  if (d !== date) return { date, count: 0 };
  return { date, count: parseInt(c, 10) || 0 };
}

export async function addReads(env, n) {
  if (!n) return (await getReadsToday(env)).count;
  const { date, count } = await getReadsToday(env);
  const newCount = count + n;
  await env.DB.prepare(
    `INSERT INTO x_settings (key, value, updated_at) VALUES ('api_reads_today', ?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(`${date}:${newCount}`, Date.now())
    .run();
  return newCount;
}

export async function budgetRemaining(env) {
  const { count } = await getReadsToday(env);
  const max = parseInt(env.MAX_READS_PER_DAY || '400', 10);
  return Math.max(0, max - count);
}

export async function getSetting(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM x_settings WHERE key = ?1`).bind(key).first();
  return row ? row.value : null;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO x_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value, Date.now())
    .run();
}
