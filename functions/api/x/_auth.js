// 灯守 APIの権限分離
//   writer  = Claude（Mac Studio の生成）: 下書き作成・読み取りのみ。X_WRITER_KEY
//   admin   = 人間（アプリ）: 投稿済み記録・却下・監視リスト編集・停止。X_ADMIN_TOKEN
// どちらも Pages の環境変数（Secret）。未設定なら該当操作は全て拒否＝安全側。
export function isWriter(request, env) {
  const k = request.headers.get('x-writer-key');
  return Boolean(env.X_WRITER_KEY) && k === env.X_WRITER_KEY;
}
export function isAdmin(request, env) {
  const k = request.headers.get('x-admin-token');
  return Boolean(env.X_ADMIN_TOKEN) && k === env.X_ADMIN_TOKEN;
}
export function forbidden(msg = 'forbidden') {
  return Response.json({ ok: false, error: msg }, { status: 403 });
}
export function jstDate(ts = Date.now()) {
  return new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
export async function logGuard(env, { actor, action, target, result, detail }) {
  try {
    await env.DB.prepare(
      'INSERT INTO guard_log (ts, actor, action, target, result, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    ).bind(Date.now(), actor, action, target ?? null, result, typeof detail === 'string' ? detail.slice(0, 2000) : JSON.stringify(detail ?? null).slice(0, 2000)).run();
  } catch {
    // 監査ログの失敗で本処理を止めない
  }
}
export async function getSetting(env, key, fallback = null) {
  const row = await env.DB.prepare('SELECT value FROM x_settings WHERE key = ?1').bind(key).first();
  return row ? row.value : fallback;
}
export const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : null);
