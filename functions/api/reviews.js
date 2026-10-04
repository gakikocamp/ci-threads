// BASEレビューの返信づくりAPI — D1 (ci_zukou / base_reviews・base_review_runs)
// GET  /api/reviews             : アプリ用。返信待ち・承認済み・過去分・最近の完了・最終確認
// GET  /api/reviews?status=a,b  : エンジン用。指定した状態の行だけ
// GET  /api/reviews?guide=1     : エンジン用。返信の書き方＋過去の返信の実例
// POST /api/reviews {action}
//   sync / draft / posted              … Mac Studio（x-writer-key）
//   approve / redo / skip / reopen / queue … 人間（アプリ・x-admin-token）
import { isWriter, isAdmin, forbidden } from './x/_auth.js';
import { REVIEW_GUIDE, lintReply } from './_review-guide.js';

const COLS = `key, item_id, item_name, score, review_date, comment, shop_reply, status, draft, draft_note, lint,
  redo_memo, final_text, first_seen_at, drafted_at, approved_at, posted_at, updated_at`;
const OPEN = ['new', 'draft', 'redo', 'approved'];   // まだ終わっていない状態
const DONE = ['posted', 'replied_direct', 'skipped'];

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const db = env.DB;

  if (url.searchParams.get('guide')) {
    // 過去に柴垣さんが書いた返信（語り口の参考。長さと定型句は真似しない）
    const { results } = await db.prepare(
      `SELECT item_name, score, comment, shop_reply FROM base_reviews
       WHERE shop_reply <> '' AND comment <> '' ORDER BY review_date DESC LIMIT 6`
    ).all();
    return Response.json({ ok: true, guide: REVIEW_GUIDE, past_replies: results });
  }

  const status = url.searchParams.get('status');
  if (status) {
    const list = status.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
    const marks = list.map((_, i) => `?${i + 1}`).join(',');
    const { results } = await db.prepare(
      `SELECT ${COLS} FROM base_reviews WHERE status IN (${marks}) ORDER BY review_date DESC LIMIT 200`
    ).bind(...list).all();
    return Response.json({ ok: true, reviews: results.map(parseLint) });
  }

  const [open, backlog, done, counts, run] = await db.batch([
    db.prepare(`SELECT ${COLS} FROM base_reviews WHERE status IN ('new','draft','redo','approved') ORDER BY review_date DESC LIMIT 200`),
    db.prepare(`SELECT key, item_name, score, review_date, comment FROM base_reviews WHERE status = 'backlog' ORDER BY review_date DESC LIMIT 200`),
    db.prepare(`SELECT ${COLS} FROM base_reviews WHERE status IN ('posted','replied_direct','skipped') ORDER BY updated_at DESC LIMIT 15`),
    db.prepare(`SELECT status, COUNT(*) AS n FROM base_reviews GROUP BY status`),
    db.prepare(`SELECT ts, items_counted, reviews_total, new_reviews, newly_replied, note FROM base_review_runs ORDER BY id DESC LIMIT 1`),
  ]);
  const c = {};
  for (const r of counts.results) c[r.status] = r.n;
  return Response.json({
    ok: true,
    autopost: REVIEW_GUIDE.autopost,
    base_admin_url: REVIEW_GUIDE.base_admin_url,
    counts: c,
    last_run: run.results[0] || null,
    open: open.results.map(parseLint),
    backlog: backlog.results,
    done: done.results.map(parseLint),
  });
}

export async function onRequestPost({ request, env }) {
  let p;
  try { p = await request.json(); } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }); }
  const action = p && p.action;
  const writer = isWriter(request, env);
  const admin = isAdmin(request, env);

  if (['sync', 'draft', 'posted'].includes(action)) {
    if (!writer) return forbidden();
    if (action === 'sync') return sync(env.DB, p);
    if (action === 'draft') return saveDrafts(env.DB, p);
    return markPosted(env.DB, p);
  }
  if (['approve', 'redo', 'skip', 'reopen', 'queue'].includes(action)) {
    if (!admin) return forbidden();
    return human(env.DB, action, p);
  }
  return Response.json({ ok: false, error: 'unknown action' }, { status: 400 });
}

// --- Mac Studio: 公開ページから読んだ全レビューを突き合わせる -----------------
async function sync(db, p) {
  const incoming = Array.isArray(p.reviews) ? p.reviews.filter(r => r && typeof r.key === 'string' && r.key.length < 64) : [];
  if (incoming.length === 0) return Response.json({ ok: false, error: 'no reviews' }, { status: 400 });

  const now = Date.now();
  const cutoff = new Date(now + 9 * 3600e3 - REVIEW_GUIDE.draft_window_days * 86400e3).toISOString().slice(0, 10);
  const { results: existing } = await db.prepare('SELECT key, status, shop_reply FROM base_reviews').all();
  const known = new Map(existing.map(r => [r.key, r]));

  const ins = db.prepare(
    `INSERT INTO base_reviews (key, item_id, item_name, score, review_date, comment, shop_reply, status, first_seen_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`
  );
  const upd = db.prepare(
    `UPDATE base_reviews SET item_name = ?2, shop_reply = ?3, status = ?4,
       posted_at = CASE WHEN ?4 = 'posted' AND posted_at IS NULL THEN ?5 ELSE posted_at END, updated_at = ?5
     WHERE key = ?1`
  );
  const stmts = [];
  let newReviews = 0, newlyReplied = 0;
  for (const r of incoming) {
    const comment = str(r.comment, 4000) || '';
    const reply = str(r.shop_reply, 4000) || '';
    const old = known.get(r.key);
    if (!old) {
      // 初めて見るレビュー。本文が無ければ返信しない（これまでの運用どおり）
      let status = 'new';
      if (!comment) status = 'no_comment';
      else if (reply) status = 'replied_before';
      else if ((r.review_date || '') < cutoff) status = 'backlog';
      if (status === 'new') newReviews++;
      stmts.push(ins.bind(r.key, str(r.item_id, 20), str(r.item_name, 300), score(r.score), str(r.review_date, 10), comment, reply, status, now));
      continue;
    }
    let status = old.status;
    if (reply && !old.shop_reply) {
      // BASEに返信が載った。アプリで承認したものは完了、それ以外はBASEで直接返信したもの
      status = old.status === 'approved' ? 'posted' : (['replied_before', 'no_comment'].includes(old.status) ? old.status : 'replied_direct');
      newlyReplied++;
    }
    if (status !== old.status || reply !== (old.shop_reply || '')) {
      stmts.push(upd.bind(r.key, str(r.item_name, 300), reply, status, now));
    }
  }
  stmts.push(db.prepare(
    'INSERT INTO base_review_runs (ts, items_counted, reviews_total, new_reviews, newly_replied, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
  ).bind(now, num(p.items_counted), incoming.length, newReviews, newlyReplied, str(p.note, 300)));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));

  const { results } = await db.prepare(`SELECT COUNT(*) AS n FROM base_reviews WHERE status IN ('new','redo')`).all();
  return Response.json({ ok: true, total: incoming.length, new_reviews: newReviews, newly_replied: newlyReplied, need_draft: results[0].n });
}

// --- Mac Studio: 下書きを保存（new / redo の行だけ）。dry:true なら機械チェックの結果だけ返す ---
async function saveDrafts(db, p) {
  const list = Array.isArray(p.drafts) ? p.drafts : [p];
  if (p.dry) {
    return Response.json({ ok: true, lint: list.slice(0, 50).map(d => ({ key: d && d.key, lint: lintReply(d && d.draft) })) });
  }
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE base_reviews SET draft = ?2, draft_note = ?3, lint = ?4, status = 'draft', drafted_at = ?5, updated_at = ?5
     WHERE key = ?1 AND status IN ('new','redo')`
  );
  const saved = [];
  for (const d of list.slice(0, 50)) {
    const draft = str(d && d.draft, 3000);
    if (!d || typeof d.key !== 'string' || !draft) continue;
    const lint = lintReply(draft);
    if (d.caution) lint.unshift({ level: 'caution', msg: '柴垣さんの確認が必要' });
    const res = await stmt.bind(d.key, draft, str(d.note, 1000), JSON.stringify(lint), now).run();
    saved.push({ key: d.key, saved: res.meta.changes === 1, lint });
  }
  return Response.json({ ok: true, saved });
}

// --- Mac Studio: BASEへ自動返信したあと（autopost 用） --------------------------
async function markPosted(db, p) {
  const now = Date.now();
  const res = await db.prepare(
    `UPDATE base_reviews SET status = 'posted', posted_at = ?2, updated_at = ?2 WHERE key = ?1 AND status = 'approved'`
  ).bind(str(p.key, 64), now).run();
  return Response.json({ ok: true, changed: res.meta.changes });
}

// --- 人間（アプリ）: 承認・書き直し依頼・見送り・戻す・過去分を下書きへ -------------
async function human(db, action, p) {
  const now = Date.now();
  const keys = (Array.isArray(p.keys) ? p.keys : [p.key]).filter(k => typeof k === 'string' && k.length < 64).slice(0, 100);
  if (keys.length === 0) return Response.json({ ok: false, error: 'no key' }, { status: 400 });

  if (action === 'approve') {
    const text = str(p.text, 3000);
    if (!text || !text.trim()) return Response.json({ ok: false, error: '返信文が空です' }, { status: 400 });
    const lint = lintReply(text);
    // 直したほうがよい点が残っていれば、一度だけ確認を求める（アプリで「このまま承認」を選ぶと force）
    if (!p.force && lint.some(x => x.level === 'ng')) {
      return Response.json({ ok: false, needs_confirm: true, lint });
    }
    const res = await db.prepare(
      `UPDATE base_reviews SET final_text = ?2, lint = ?3, status = 'approved', approved_at = ?4, updated_at = ?4
       WHERE key = ?1 AND status IN ('draft','redo','new')`
    ).bind(keys[0], text.trim(), JSON.stringify(lint), now).run();
    return Response.json({ ok: res.meta.changes === 1, lint, error: res.meta.changes ? undefined : 'この返信はもう承認済みか、状態が変わっています' });
  }
  const sql = {
    redo: `UPDATE base_reviews SET status = 'redo', redo_memo = ?2, updated_at = ?3 WHERE key = ?1 AND status IN ('draft','new','approved')`,
    skip: `UPDATE base_reviews SET status = 'skipped', updated_at = ?3 WHERE key = ?1 AND status IN ('new','draft','redo','approved','backlog')`,
    reopen: `UPDATE base_reviews SET status = CASE WHEN draft IS NOT NULL AND draft <> '' THEN 'draft' ELSE 'new' END, updated_at = ?3
             WHERE key = ?1 AND status IN ('approved','skipped')`,
    queue: `UPDATE base_reviews SET status = 'new', updated_at = ?3 WHERE key = ?1 AND status = 'backlog'`,
  }[action];
  const stmts = keys.map(k => db.prepare(sql).bind(k, str(p.memo, 500), now));
  const res = await db.batch(stmts);
  return Response.json({ ok: true, changed: res.reduce((a, r) => a + (r.meta.changes || 0), 0) });
}

function parseLint(r) {
  if (r && typeof r.lint === 'string') { try { r.lint = JSON.parse(r.lint); } catch { r.lint = []; } }
  return r;
}
function str(v, max = 300) { return typeof v === 'string' ? v.slice(0, max) : null; }
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function score(v) { return ['good', 'normal', 'bad'].includes(v) ? v : null; }
