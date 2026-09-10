// 灯守 学習ジョブ（毎日 JST 03:10〜03:30）
// 帰属 → 転換率の校正 → 腕の更新 → 明日のレシピ → 台帳 → 不変条件の検証
// 計算はすべて src/learn-core.js（純粋関数・テスト済み）。ここはD1との受け渡しだけ。
// 冪等: 同じ日に何度実行しても同じ結果になる（乱数は日付シード・書き込みは全てupsert）
import {
  DIMENSIONS, welfordAdd, welfordRemove, computeConv, attributeDirect, computeObservation,
  buildRecipes, buildLedger, checkInvariants, daysBetween,
} from '../learn-core.js';
import { priorFor } from '../priors.js';
import { jstDateString, addDaysStr, logGuard, getSetting, setSetting } from '../util.js';

const PROVISIONAL_MS = 48 * 3600 * 1000;
const FINAL_MS = 7 * 86400 * 1000;

export async function runLearn(env) {
  const today = jstDateString();
  const tomorrow = addDaysStr(today, 1);
  const now = Date.now();
  const factStrengths = await loadFactStrengths(env);

  const conv = await calibrateConv(env, today);
  const observations = await attributeAll(env, today, conv, now);
  const kinds = await compareKinds(env, today, conv, now);
  const armChanges = await updateArms(env, observations, factStrengths, now);
  const recipes = await planTomorrow(env, tomorrow, today, factStrengths, now);
  const ledger = await writeLedger(env, today, { armChanges, conv, recipes, kinds });
  const health = await verify(env, today, tomorrow, recipes, armChanges, ledger, now, observations.length);

  await logGuard(env, 'worker', 'learn', health.allOk ? 'ok' : 'error',
    `obs=${observations.length} arms=${armChanges.length} recipes=${recipes.length} ledger=${ledger.length} health=${health.allOk ? 'OK' : health.failed.join(',')}`);
  return { conv, observations: observations.length, armChanges: armChanges.length, recipes: recipes.length, health };
}

// ── 燃料の強さ（guardrails/fact-inventory.json は Worker にバンドルできないので x_settings に載せる）──
// M1′の整地スクリプトで `fact_strengths` に JSON を投入する。無ければ全て1.0扱い。
async function loadFactStrengths(env) {
  try {
    const raw = await getSetting(env, 'fact_strengths');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// ── 転換率（プロフィールクリック→フォロー）を直近14日で校正 ──
async function calibrateConv(env, today) {
  const since = addDaysStr(today, -14);
  const { results: daily } = await env.DB.prepare(
    `SELECT date, followers FROM x_account_daily WHERE date >= ?1 AND followers IS NOT NULL ORDER BY date ASC`
  ).bind(since).all();
  const net = daily.length >= 2 ? daily[daily.length - 1].followers - daily[0].followers : 0;
  const row = await env.DB.prepare(
    `SELECT SUM(profile_clicks) AS total FROM x_metrics WHERE snap_date >= ?1`
  ).bind(since).first();
  const conv = computeConv(net, row?.total || 0);
  await setSetting(env, 'conv', String(conv));
  await setSetting(env, 'conv_updated', today);
  return conv;
}

// ── オリジナル投稿 vs 返信の効率比較（1日15件の返信が本当に効いているかを実測する）──
// 返信は候補から出たものではないので腕の学習には入れず、種類別の集計としてだけ持つ。
async function compareKinds(env, today, conv, now) {
  const since = addDaysStr(today, -14);
  const { results } = await env.DB.prepare(
    `SELECT m.kind, COUNT(*) AS n, SUM(m.impressions) AS imp, SUM(m.profile_clicks) AS clicks
       FROM x_metrics m
       JOIN (SELECT tweet_id, MAX(snap_date) AS d FROM x_metrics WHERE snap_date >= ?1 GROUP BY tweet_id) lat
         ON lat.tweet_id = m.tweet_id AND lat.d = m.snap_date
      GROUP BY m.kind`
  ).bind(since).all();
  if (!results.length) return [];

  const stmt = env.DB.prepare(
    `INSERT INTO x_kind_stats (kind, window_days, n, impressions, profile_clicks, est_follows, per_item, updated_at)
     VALUES (?1,14,?2,?3,?4,?5,?6,?7)
     ON CONFLICT(kind) DO UPDATE SET n=excluded.n, impressions=excluded.impressions,
       profile_clicks=excluded.profile_clicks, est_follows=excluded.est_follows,
       per_item=excluded.per_item, updated_at=excluded.updated_at`
  );
  const out = results.map((r) => {
    const est = (r.clicks || 0) * conv;
    return { kind: r.kind || 'original', n: r.n, impressions: r.imp || 0, clicks: r.clicks || 0, est_follows: est, per_item: r.n ? est / r.n : 0 };
  });
  await env.DB.batch(out.map((k) => stmt.bind(k.kind, k.n, k.impressions, k.clicks, k.est_follows, k.per_item, now)));
  return out;
}

// ── 帰属: 投稿ごとの推定フォロワー獲得数 ──
async function attributeAll(env, today, conv, now) {
  const since = addDaysStr(today, -21);

  // 日次フォロワー増分
  const { results: daily } = await env.DB.prepare(
    `SELECT date, followers FROM x_account_daily WHERE date >= ?1 AND followers IS NOT NULL ORDER BY date ASC`
  ).bind(since).all();
  const dailyDeltas = {};
  for (let i = 1; i < daily.length; i++) dailyDeltas[daily[i].date] = daily[i].followers - daily[i - 1].followers;

  // 投稿（レシピ付き・投稿済み）
  const { results: posts } = await env.DB.prepare(
    `SELECT id AS queue_id, tweet_id, posted_at, pattern, hook, fact_ids, slot, format
       FROM x_queue WHERE status = 'posted' AND tweet_id IS NOT NULL AND posted_at >= ?1`
  ).bind(Date.now() - 21 * 86400 * 1000).all();
  if (!posts.length) return [];
  const byTweet = new Map(posts.map((p) => [String(p.tweet_id), p]));

  // 日ごとのインプレッション増分（累積スナップショットの差分）。投稿から48h以内の日だけ按分対象にする
  const { results: snaps } = await env.DB.prepare(
    `SELECT tweet_id, snap_date, impressions, profile_clicks, replies, quotes, reposts, likes, bookmarks
       FROM x_metrics WHERE snap_date >= ?1 ORDER BY tweet_id, snap_date ASC`
  ).bind(since).all();

  const dailyImpressions = {};
  const latest = new Map();
  const prevImp = new Map();
  for (const s of snaps) {
    const tid = String(s.tweet_id);
    const p = byTweet.get(tid);
    latest.set(tid, s);
    if (!p) continue;
    const prev = prevImp.get(tid) ?? 0;
    const gained = Math.max(0, (s.impressions || 0) - prev);
    prevImp.set(tid, s.impressions || 0);
    const withinWindow = p.posted_at && Date.parse(`${s.snap_date}T00:00:00Z`) - p.posted_at <= PROVISIONAL_MS + 86400000;
    if (!withinWindow) continue;
    (dailyImpressions[s.snap_date] ||= {})[p.queue_id] = gained;
  }
  const direct = attributeDirect({ dailyDeltas, dailyImpressions });

  // 観測値の確定
  const out = [];
  const stmt = env.DB.prepare(
    `INSERT INTO x_observations
       (queue_id, tweet_id, posted_at, status, impressions, profile_clicks, replies, quotes, reposts, likes, bookmarks,
        est_follows_clicks, est_follows_direct, est_follows, engagement_score, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
     ON CONFLICT(queue_id) DO UPDATE SET
       status = excluded.status, impressions = excluded.impressions, profile_clicks = excluded.profile_clicks,
       replies = excluded.replies, quotes = excluded.quotes, reposts = excluded.reposts, likes = excluded.likes,
       bookmarks = excluded.bookmarks, est_follows_clicks = excluded.est_follows_clicks,
       est_follows_direct = excluded.est_follows_direct, est_follows = excluded.est_follows,
       engagement_score = excluded.engagement_score, updated_at = excluded.updated_at`
  );
  const batch = [];
  for (const p of posts) {
    const m = latest.get(String(p.tweet_id));
    if (!m) continue;
    const age = now - (p.posted_at || now);
    if (age < PROVISIONAL_MS) continue;                       // 48h未満はまだ測らない
    const status = age >= FINAL_MS ? 'final' : 'provisional';
    const o = computeObservation({
      profileClicks: m.profile_clicks || 0, conv, direct: direct[p.queue_id] || 0,
      replies: m.replies || 0, quotes: m.quotes || 0, reposts: m.reposts || 0,
      likes: m.likes || 0, bookmarks: m.bookmarks || 0,
    });
    batch.push(stmt.bind(p.queue_id, String(p.tweet_id), p.posted_at, status, m.impressions || 0,
      m.profile_clicks || 0, m.replies || 0, m.quotes || 0, m.reposts || 0, m.likes || 0, m.bookmarks || 0,
      o.est_follows_clicks, o.est_follows_direct, o.est_follows, o.engagement_score, now));
    out.push({ ...p, ...o, status });
  }
  if (batch.length) await env.DB.batch(batch);
  return out;
}

// ── 腕の更新（provisional は後で打ち消して final を入れ直す）──
async function updateArms(env, observations, factStrengths, now) {
  if (!observations.length) return [];
  const { results: applied } = await env.DB.prepare(
    `SELECT queue_id, applied_provisional, applied_final, applied_value FROM x_observations`
  ).all();
  const state = new Map(applied.map((a) => [a.queue_id, a]));

  const { results: armRows } = await env.DB.prepare(
    `SELECT dimension, arm, n, mean, m2, prior_mean, prior_n, last_tried FROM x_arm_stats`
  ).all();
  const arms = new Map(armRows.map((a) => [`${a.dimension}|${a.arm}`, { ...a }]));
  const before = new Map([...arms].map(([k, v]) => [k, { mean: v.mean, n: v.n }]));
  const touched = new Set();
  const changes = [];

  const armsOf = (o) => {
    const list = [['pattern', o.pattern], ['hook', o.hook], ['slot', o.slot], ['format', o.format]];
    let fids = [];
    try { fids = JSON.parse(o.fact_ids || '[]'); } catch { fids = []; }
    for (const f of fids) list.push(['fact', f]);
    return list.filter(([, v]) => v);
  };

  for (const o of observations) {
    const st = state.get(o.queue_id) || { applied_provisional: 0, applied_final: 0, applied_value: null };
    const isFinal = o.status === 'final';
    if (isFinal && st.applied_final) continue;
    if (!isFinal && st.applied_provisional) continue;

    for (const [dim, arm] of armsOf(o)) {
      const key = `${dim}|${arm}`;
      let a = arms.get(key);
      if (!a) {
        a = { dimension: dim, arm, n: 0, mean: 0, m2: 0, prior_mean: priorFor(dim, arm, factStrengths), prior_n: 2, last_tried: null };
        arms.set(key, a);
      }
      if (isFinal && st.applied_provisional && st.applied_value != null) {
        const r = welfordRemove(a, st.applied_value);
        a.n = r.n; a.mean = r.mean; a.m2 = r.m2;
      }
      const w = welfordAdd(a, o.est_follows);
      a.n = w.n; a.mean = w.mean; a.m2 = w.m2;
      a.last_tried = jstDateString(new Date(o.posted_at || Date.now()));
      touched.add(key);
    }
    await env.DB.prepare(
      `UPDATE x_observations SET applied_provisional = 1, applied_final = ?2, applied_value = ?3 WHERE queue_id = ?1`
    ).bind(o.queue_id, isFinal ? 1 : 0, o.est_follows).run();
  }

  if (touched.size) {
    const stmt = env.DB.prepare(
      `INSERT INTO x_arm_stats (dimension, arm, n, mean, m2, prior_mean, prior_n, last_tried, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
       ON CONFLICT(dimension, arm) DO UPDATE SET
         n = excluded.n, mean = excluded.mean, m2 = excluded.m2, prior_mean = excluded.prior_mean,
         last_tried = excluded.last_tried, updated_at = excluded.updated_at`
    );
    await env.DB.batch([...touched].map((k) => {
      const a = arms.get(k);
      return stmt.bind(a.dimension, a.arm, a.n, a.mean, a.m2, a.prior_mean ?? 1, a.prior_n ?? 2, a.last_tried, now);
    }));
    for (const k of touched) {
      const a = arms.get(k), b = before.get(k) || { mean: a.prior_mean ?? 1, n: 0 };
      changes.push({ dimension: a.dimension, arm: a.arm, before: b.mean ?? 0, after: a.mean, n: a.n });
    }
    // 全観測の平均を global_mean に（事前分布のスケール）
    const g = await env.DB.prepare(`SELECT AVG(est_follows) AS m FROM x_observations WHERE status = 'final'`).first();
    if (g?.m != null && g.m > 0) await setSetting(env, 'global_mean', String(g.m));
  }
  return changes;
}

// ── 明日のレシピ3本 ──
async function planTomorrow(env, tomorrow, today, factStrengths, now) {
  const globalMean = parseFloat((await getSetting(env, 'global_mean')) || '1') || 1;
  const { results: armRows } = await env.DB.prepare(
    `SELECT dimension, arm, n, mean, m2, prior_mean, prior_n, last_tried FROM x_arm_stats`
  ).all();

  // 既知の腕に、まだ試していない腕（priors と燃料在庫）を合流させる
  const armsByDim = Object.fromEntries(DIMENSIONS.map((d) => [d, []]));
  const seen = new Set();
  for (const a of armRows) {
    if (!armsByDim[a.dimension]) continue;
    armsByDim[a.dimension].push(a);
    seen.add(`${a.dimension}|${a.arm}`);
  }
  const { PRIORS } = await import('../priors.js');
  for (const dim of ['pattern', 'hook', 'slot', 'format']) {
    for (const arm of Object.keys(PRIORS[dim] || {})) {
      if (dim === 'pattern' && arm === '安否と事実') continue; // 平時は候補にしない
      if (!seen.has(`${dim}|${arm}`)) armsByDim[dim].push({ dimension: dim, arm, n: 0, mean: 0, m2: 0, prior_mean: PRIORS[dim][arm], prior_n: 2, last_tried: null });
    }
  }
  const available = await availableFacts(env, today, factStrengths);
  for (const f of available) if (!seen.has(`fact|${f.id}`)) armsByDim.fact.push({ dimension: 'fact', arm: f.id, n: 0, mean: 0, m2: 0, prior_mean: f.strength, prior_n: 2, last_tried: null });
  armsByDim.fact = armsByDim.fact.filter((a) => available.some((f) => f.id === a.arm));

  const ctx = await buildContext(env, tomorrow, today);
  const deficit = await explorationDeficit(env, today);
  const recipes = buildRecipes({ date: tomorrow, armsByDim, ctx, globalMean, explorationDeficit: deficit });

  const stmt = env.DB.prepare(
    `INSERT INTO x_recipes (id, date, rank, pattern, hook, fact_ids, slot, format, is_exploration, rationale, constraint_ok, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
     ON CONFLICT(id) DO UPDATE SET
       pattern = excluded.pattern, hook = excluded.hook, fact_ids = excluded.fact_ids, slot = excluded.slot,
       format = excluded.format, is_exploration = excluded.is_exploration, rationale = excluded.rationale,
       constraint_ok = excluded.constraint_ok`
  );
  await env.DB.batch(recipes.map((r) => stmt.bind(
    `${tomorrow}-${r.rank}`, tomorrow, r.rank, r.pattern || '', r.hook || '', JSON.stringify(r.fact_ids || []),
    r.slot || '', r.format || '', r.is_exploration ? 1 : 0, r.rationale || '', r.constraint_ok ? 1 : 0, now)));
  return recipes;
}

async function availableFacts(env, today, factStrengths) {
  const { results: used } = await env.DB.prepare(
    `SELECT fact_id, MAX(used_date) AS last FROM x_fact_usage GROUP BY fact_id`
  ).all();
  const lastUsed = Object.fromEntries(used.map((u) => [u.fact_id, u.last]));
  return Object.entries(factStrengths)
    .filter(([id]) => !lastUsed[id] || daysBetween(lastUsed[id], today) >= 14)
    .map(([id, strength]) => ({ id, strength }));
}

async function buildContext(env, tomorrow, today) {
  const weekAgo = addDaysStr(today, -6), monthAgo = addDaysStr(today, -29);
  const { results: recent } = await env.DB.prepare(
    `SELECT pattern, date, format FROM x_queue WHERE status = 'posted' AND date >= ?1`
  ).bind(monthAgo).all();
  const countsThisWeek = {}, countsThisMonth = {};
  for (const r of recent) {
    if (!r.pattern) continue;
    countsThisMonth[r.pattern] = (countsThisMonth[r.pattern] || 0) + 1;
    if (r.date >= weekAgo) {
      countsThisWeek[r.pattern] = (countsThisWeek[r.pattern] || 0) + 1;
      if (r.format === 'cta') countsThisWeek['__cta'] = (countsThisWeek['__cta'] || 0) + 1;
    }
  }
  const y = await env.DB.prepare(
    `SELECT pattern FROM x_queue WHERE status = 'posted' AND date = ?1 ORDER BY posted_at DESC LIMIT 1`
  ).bind(today).first();
  const { results: used } = await env.DB.prepare(
    `SELECT fact_id, MAX(used_date) AS last FROM x_fact_usage GROUP BY fact_id`
  ).all();
  const paused = await getSetting(env, 'paused');
  const mode = (await getSetting(env, 'mode')) === 'safety' ? 'safety' : 'buzz';
  return {
    today: tomorrow, // 制約は「明日の投稿」に対して判定する
    factLastUsed: Object.fromEntries(used.map((u) => [u.fact_id, u.last])),
    countsThisWeek, countsThisMonth,
    yesterdayPattern: y?.pattern || null,
    mode, paused: paused === '1',
  };
}

async function explorationDeficit(env, today) {
  const min = parseInt((await getSetting(env, 'exploration_min_per_week')) || '2', 10);
  const weekAgo = addDaysStr(today, -6);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM x_queue WHERE status = 'posted' AND date >= ?1 AND is_exploration = 1`
  ).bind(weekAgo).first();
  return Math.max(0, min - (row?.n || 0));
}

// ── 台帳 ──
async function writeLedger(env, today, { armChanges, conv, recipes, kinds = [] }) {
  const yesterday = addDaysStr(today, -1);
  const postsRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM x_queue WHERE status = 'posted' AND date = ?1`
  ).bind(yesterday).first();
  const { results: acct } = await env.DB.prepare(
    `SELECT date, followers FROM x_account_daily ORDER BY date DESC LIMIT 2`
  ).all();
  const convBefore = parseFloat((await getSetting(env, 'conv_prev')) || String(conv));

  const lines = buildLedger({
    date: today,
    armChanges: armChanges.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before)),
    conv, convBefore,
    postsYesterday: postsRow?.n || 0,
    followers: acct[0]?.followers ?? null,
    followersDelta: acct.length >= 2 ? acct[0].followers - acct[1].followers : null,
    recipes,
    kinds,
    stagnant: armChanges.length === 0,
  });
  await setSetting(env, 'conv_prev', String(conv));

  // 同じ日に同じ文面を重複記録しない（再実行の冪等性）
  const { results: existing } = await env.DB.prepare(`SELECT text FROM x_ledger WHERE date = ?1`).bind(today).all();
  const have = new Set(existing.map((e) => e.text));
  const fresh = lines.filter((l) => !have.has(l.text));
  if (fresh.length) {
    const stmt = env.DB.prepare(`INSERT INTO x_ledger (date, kind, text, evidence, created_at) VALUES (?1,?2,?3,?4,?5)`);
    await env.DB.batch(fresh.map((l) => stmt.bind(l.date, l.kind, l.text, l.evidence ?? null, Date.now())));
  }
  return [...have, ...fresh.map((f) => f.text)];
}

// ── 不変条件 I1〜I7 ──
async function verify(env, today, tomorrow, recipes, armChanges, ledger, now, eligibleObservations = 0) {
  const since = addDaysStr(today, -14);
  const posts14 = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM x_queue WHERE status = 'posted' AND date >= ?1 AND tweet_id IS NOT NULL`
  ).bind(since).first();
  const metricsToday = await env.DB.prepare(
    `SELECT COUNT(DISTINCT tweet_id) AS n FROM x_metrics WHERE snap_date = ?1`
  ).bind(today).first();
  const acctToday = await env.DB.prepare(`SELECT date FROM x_account_daily WHERE date = ?1`).bind(today).first();
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM x_observations WHERE status = 'final' AND applied_final = 0`
  ).first();
  const armsToday = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM x_arm_stats WHERE updated_at >= ?1`
  ).bind(now - 6 * 3600 * 1000).first();
  const ledgerToday = await env.DB.prepare(`SELECT COUNT(*) AS n FROM x_ledger WHERE date = ?1`).bind(today).first();

  const state = {
    metricsToday: metricsToday?.n || 0,
    postsLast14d: posts14?.n || 0,
    accountRowToday: !!acctToday,
    pendingFinalizations: pending?.n || 0,
    armsUpdatedToday: armsToday?.n || 0,
    recipesTomorrow: recipes.length,
    recipesConstraintOk: recipes.filter((r) => r.constraint_ok).length,
    ledgerRowsToday: ledgerToday?.n || 0,
    convRecomputedToday: (await getSetting(env, 'conv_updated')) === today,
    eligibleObservations,   // 48時間たって測れる投稿の数。0なら腕が動かなくても正常
  };
  const inv = checkInvariants(state);

  // 「改善した日」= 腕が動いた or 明日のレシピが今日と違う
  const prevRecipes = await env.DB.prepare(
    `SELECT pattern, hook, slot FROM x_recipes WHERE date = ?1 ORDER BY rank`
  ).bind(today).all();
  const sig = (rs) => rs.map((r) => `${r.pattern}/${r.hook}/${r.slot}`).join('|');
  const improved = armChanges.length > 0 || sig(prevRecipes.results) !== sig(recipes);

  await env.DB.prepare(
    `INSERT INTO x_health (date, i1,i2,i3,i4,i5,i6,i7, all_ok, improved, detail, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
     ON CONFLICT(date) DO UPDATE SET i1=excluded.i1,i2=excluded.i2,i3=excluded.i3,i4=excluded.i4,
       i5=excluded.i5,i6=excluded.i6,i7=excluded.i7, all_ok=excluded.all_ok, improved=excluded.improved, detail=excluded.detail`
  ).bind(today, +inv.i1, +inv.i2, +inv.i3, +inv.i4, +inv.i5, +inv.i6, +inv.i7, +inv.allOk, +improved,
    JSON.stringify({ state, failed: inv.failed }), now).run();

  if (!inv.allOk) {
    await env.DB.prepare(`INSERT INTO x_ledger (date, kind, text, evidence, created_at) VALUES (?1,'alert',?2,?3,?4)`)
      .bind(today, `不変条件 ${inv.failed.join('・')} が崩れています`, JSON.stringify(state), now).run();
  }
  return { ...inv, improved };
}
